# BUG (P2): serial-tier attempt 2 — three of four assertions measure the wrong thing

- **Date**: 2026-08-17
- **Priority**: P2 — the only red tier at `v2.1.0-beta.10`
- **Branch**: `release/v2.1-beta`
- **Supersedes**: attempt 1 in `BUG-2026-08-17-serial-integration-tier-four-inherited-failures.md` (ran to
  completion, AC-3 unmet)
- **Prior art**: attempt 1 shipped 5 real fixes (`73a34239`, `c32408b1`, `18a77e44`, `99d95392`,
  `54784d41`). Keep them. They fixed fixture extension-root resolution and scrubbed
  `GIT_CONFIG_*`/`PICKLE_TICKET_ID` from fixture spawns. They were necessary and insufficient.

## Established by a three-agent source audit + operator measurement — DO NOT RE-DERIVE

### F1 — one of the four is load-dependent, three are not
Operator ran `tests/integration/timeout-e2e.test.js` ALONE on a quiet box (0 workers, 0 runners):
`tests 2 / pass 1 / fail 1`. **`timeout-e2e: manager sleeps 95% of budget, writes artifact` PASSES in
isolation and fails in the tier.** `timeout-e2e: session deactivated by subprocess` fails both ways
(49409 ms, then 51549 ms on a re-run).

### F2 — PC-4's assertion has never measured the sibling kill
`process-cleanup.test.js:282` starts the clock BEFORE the child is forked; `:308` stops it AFTER full
exit; `:312` asserts `< 30_000`. So the number charges node bootstrap, the ESM import graph of a
2145-line bin plus `pickle-utils`/`state-manager`/`backend-spawn`/`microverse-state`, arg+settings
resolution, two `runAcPhaseGate` calls, a stale-anchor git scan, manifest build, symbol audit, readiness
gate, and interpreter teardown.
**Proof it was measuring unrelated work:** the 47212 → 38200 ms improvement from `18a77e44` came
*entirely* from `runReadinessGate` (`spawn-refinement-team.js:213-234`) no longer finding the real
`check-readiness.js` — a **9012 ms** delta with nothing to do with sibling kill.
**The budget is reachable, so do not widen it.** Intended path has **0 ms** of mandatory waits. The
degenerate ladder is 20000 (worker timeout `:690`) + 2000 (SIGKILL `:689`) + 5000 (flush `:727`) =
**27000 ms**, still under 30 s. The 50000 ms hang guard (`:709`) would exceed 38.2 s, so it is not firing.
**Correct-scoping precedent lives in the same file:** `process-cleanup.test.js:396-411` starts its clock
AFTER the child is up (500 ms settle) and stops on child `exit`, asserting `< 15_000`.

### F3 — the timeout trio share one root cause: the un-deactivating `[FATAL]`
`mux-runner.ts:12635-12640` — top-level `main().catch()` prints `[FATAL] <msg>` and `process.exit(1)`
with **no `safeDeactivate`**. That is the only exit that satisfies all three observations at once
(fixture never ran, `exit 1 / signal null`, `state.json` untouched so `active` stays `true`). Throw sites
reachable before the manager spawn: `applyTicketTierBudget` (`:10811-10813`), `updateMuxLifecycleState`
(`:10810`), `readRunnerState` (`:10762`), `reconcileTicketStateDesync` (`:1354`, `:1370`),
`evaluateCloserTerminalState` (`:10816`), `applyAllTicketsDoneCompletion` (`:10914`). Each can raise
`LockError`, which `withRetryLock` throws after a ~26.3 s / 10-attempt budget
(`pickle-utils.ts:1436`, `:1469-1492`) — one stall ≈ 26 s, two ≈ 52 s, matching the observed
49441/52960/51549/89047 ms.
**Ruled out:** empty-roster `recovery_exhausted` (`:10930-10939`, unreachable with zero tickets),
`applyAllTicketsDoneCompletion` short-circuit (`:2490-2492`), readiness/ticket-audit gates (inert when
their bins are absent), the startup orphan reaper (requires `ppid 1` + age > 600 s + the fixture's own
tmp path), and spawnSync's SIGTERM as the *direct* cause (the handler at `:7628-7647` deactivates and
exits 0, which would give `exit 0` + `active:false`).

### F4 — test #2's own instrumentation cannot see a kill at the cap
`timeout-e2e.test.js:167-170` asserts `result.signal !== 'SIGKILL'`. `spawnSync`'s `timeout` sends
**SIGTERM**, not SIGKILL, so a child killed at the 30 s cap passes that assertion silently. Runtime
51549 ms against `timeout: 30_000` (`:164`) with `active` still `true` fits a cap kill whose SIGTERM
handler did not complete. The failure MESSAGE is also wrong: `exit: 1, signal: null` is mux-runner's own
fatal exit code, not evidence that "the subprocess was killed before completing".

### F5 — the premise these three claim to pin is already unpinnable
The 950 ms / 1200 ms sleeps are **compile-time literals in the fixture heredocs**
(`timeout-e2e.test.js:62`, `timeout-happy-path.test.js:71`). They derive from no env var, settings key or
CLI arg. On the manager path no product timer is derived from `worker_timeout_seconds` any more — the
guards are `hangGuardMs` = 14400 s and `outputStallGuardMs` = 1800 s (`mux-runner.ts:3956-3959`);
`worker_timeout_seconds` is consumed only by the spawn-morty worker path, which these ticket-less
fixtures never reach. FR-B10 sleeps 1200 ms — **120 %** of its 1 s budget — while its title claims 95 %
(`timeout-happy-path.test.js:32` vs `:71`).

### F6 — the serial tier is genuinely serial; the load comes from elsewhere
Sub-tiers are `&&`-sequenced; `--test-concurrency=1` is passed and `clampTestConcurrency`
(`bin/test-runner.js:11-29`) only ever lowers it; node:test runs one file at a time and in-file tests
sequentially. All four are in `.serial-tests.json` and correctly `@tier: integration` (including
`tests/timeout-happy-path.test.js`, which is outside `tests/integration/` by design — membership is
decided by the `// @tier:` header, `test-runner.js:140-143`).
**Real leak sources that cross test boundaries:** `process-cleanup.test.js:277` (PC-4) and `:368` (PC-5)
write fake `claude` binaries whose body is `setTimeout(() => {}, 60_000)`; when the parent is killed
their grandchildren are not reaped and idle up to 60 s. PC-5's `spawn` at `:374` has **no timeout**
(grandfathered in the missing-timeout baseline). `:407` has a 15 s reject timer never cleared or
unref'd. **Nothing reaps between the parallel and serial sub-tiers**, so parallel-tier leaks are resident
when the serial timing tests start.

### F7 — latent env hazards, NOT implicated in the operator's runs
`scrubGateEnv` (`pickle-utils.ts:182-206`) does not scrub `PICKLE_DATA_ROOT`, `PICKLE_DATA_DIR` or
`TMUX`. The first two outrank `EXTENSION_DIR` in `getDataRoot` (`pickle-utils.ts:473-482`) and would make
the fixture share the REAL data root, turning `current_sessions.json` into a process-shared lock — the
direct route to F3's `LockError`. `TMUX` unset makes `ensureMonitorWindow` skip; set, fixtures issue real
tmux spawns, so control flow forks on whether the operator is inside tmux.
**Operator-verified: all three are UNSET in the measuring shell, and the fixtures set `EXTENSION_DIR` to
their tmp base (≠ `~/.claude/pickle-rick`), so `getDataRoot` returned the isolated tmp path.** These did
not cause the observed failures. They remain a real latent hazard for anyone whose shell exports them.

## Acceptance criteria

- **AC-1 — name the `[FATAL]`.** Capture the child's stderr for `timeout-e2e: session deactivated` and
  quote the actual `[FATAL] <msg>` line and the throw site. F3 lists the candidates; pick the real one
  with evidence. No fix to that test until its cause is named.
- **AC-2 — assertions measure what they claim.** PC-4 asserts on the sibling-kill window only (scope it
  like `process-cleanup.test.js:396-411`, or emit a timestamped `siblings_killed` marker and assert the
  interval). Test #2's kill check covers **SIGTERM as well as SIGKILL** so a cap kill cannot pass silently.
  This is scoping, NOT budget widening.
- **AC-3 — no budget widened without measured justification.** F2 proves PC-4's 30 s is reachable. If any
  number must change, justify it against a measurement recorded in the ticket. Skipping, quarantining or
  `.only`-narrowing any of the four fails this AC.
- **AC-4 — fix the load-dependence at its source.** PC-4's and PC-5's fake-`claude` grandchildren
  (`process-cleanup.test.js:277`, `:368`) are reaped by their own test, and PC-5's `spawn` at `:374`
  carries a timeout. `:407`'s reject timer is cleared or unref'd. Removing these removes the load that
  makes `timeout-e2e` #1 pass alone and fail in the tier (F1).
- **AC-5 — reconcile or retire the unpinnable premise.** F5 shows the three timeout tests pin behaviour
  that no longer exists: no manager-path timer derives from `worker_timeout_seconds`, and FR-B10's sleep
  is 120 % of its stated 95 %. Either re-point them at a real current guard, or state in the ticket that
  they are being re-scoped to what they can actually observe. Do not leave a test whose title contradicts
  its own arithmetic.
- **AC-6 — scrub the latent env vars.** `PICKLE_DATA_ROOT`, `PICKLE_DATA_DIR` and `TMUX` are scrubbed
  from these fixture spawns (extend the `scrubGateEnv` call sites, do not fork a second scrub list).
  F7 says they did not cause today's failures; they are a live hazard for other machines.
- **AC-7 — both sub-tiers green.** `npm run test:integration` emits summary blocks for BOTH sub-tiers,
  each `fail 0` / `cancelled 0`, measured on a quiet box (0 `spawn-morty`, 0 `test-runner`) — a tier
  measured while a worker is live is not evidence.
- **AC-8 — fast tier holds.** `npm run test:fast` `fail 0` / `cancelled 0`, count not below 7723, read
  from the runner's own summary block.
- **AC-9 — no new terminal condition, no new operator surface.** No new `exit_reason`, no new abort site,
  no new setting key, no new flag. Note F3's `[FATAL]` path lacks `safeDeactivate`; if that is the fix,
  it must not become a new halt.

## Out of scope

Pinning the introducing commit by bisect. The expensive tier and its soak. Extending
`audit-subprocess-heavy-tests.sh` to see `spawnSync(process.execPath, …)` — real (it is why none of these
files was ever flagged) but its own ticket. The R-ORCG orphan-reaper coverage gap, which likely shares a
producer with F6's fake-`claude` grandchildren.

## Simplification Review

1. **What can be subtracted instead of added?** Scope, not budget: three assertions currently measure
   more than they claim, and AC-2 narrows them. AC-4 deletes leaked processes rather than tolerating them.
   AC-5 may delete a premise that no longer exists. Net: fewer moving parts.
2. **Does this add a new abort condition?** No — AC-9 forbids it.
3. **Does this add a new configuration surface?** No. AC-6 reuses the existing `scrubGateEnv` list rather
   than forking a second one.
4. **Is a fix at this seam load-bearing for anything else?** Yes. This is the last red tier at
   `v2.1.0-beta.10`, and F6's leak producer is shared with the operator-filed R-ORCG report.

# B-MEGADRAIN — the whole open backlog, composed BY ROOT

**Priority:** P1 (reliability)
**Type:** bundle (bug + hardening) — operator-directed 2026-08-28: *"we need to batch these in large
batches"* / *"in the past we have done very large prds with dozens of tickets."*
**Branch:** `release/v2.1-beta`
**build_mode:** unattended, EXCEPT the ROOT E tickets (completion-evidence / Done-flip / salvage seam),
which are R-PSRB self-modifying-recovery and run ATTENDED per root `CLAUDE.md`.

## Why one bundle and not five

Measured phase economics (`pipeline-runner.log` timestamps, 9 sessions): **PICKLE is linear at
22–25 min/ticket; ANATOMY-PARK + SZECHUAN are a near-fixed ~300-minute toll** reviewing the accumulated
diff by SUBSYSTEM. Draining ~33 tickets as five bundles pays that toll five times (~37h). One bundle
pays it once (~18h).

**There is no ticket-count ceiling.** The 6–7 cap in `MASTER_PLAN.md` was RETRACTED 2026-08-26: it was
founded on `B-CGSHIP`'s log line `hit iteration cap`, and session state showed `max_iterations: 500`,
`iteration: 6`, mux-runner **exit code 0**. Nothing capped anything — the line was the
`null`-`priorExitReason`-renders-as-a-specific-cause bug. The one mechanism that genuinely stranded work
in a large bundle (mux-runner exiting 0 with a ticket `In Progress`) shipped as **AC-D2′** in beta.20
(`06c9e64b`, *"render absent exit_reason honestly, park not exit on refused finalize"*).

**The real risk predictor is ITERATION COUNT, not roster size.** Watch `iteration`, not the roster.

## 🚨 ROOT A — MEASUREMENT DESTROYS ITS OWN EVIDENCE (this codebase's dominant defect class)

Every item here is a gate or audit that **reports a verdict it did not measure**. Order this root FIRST:
until the fast tier is green on Node 22, every other root's CI verdict is unreadable.

**⚠ A1 MUST BE `order: 1`.** It is the live AC-R8 blocker, the fix is ~5 lines, and until it lands this
bundle's own AC-M10 baseline is RED on Node 22 — so every later ticket's gate would be measured against
a broken tier. Refinement must not reorder it.

**⚠ MEASURE THE FAST TIER ON NODE 22, not only Node 24.** Standing precondition corrected 2026-08-28:
pinning Node 24 locally is what let A1 through a "green" gate. Same tree, same commit —
Node 24: `8598 pass / fail 0`. Node 22: `fail 5, cancelled 5`. Node 24 HIDES this class. The prior claim
that "the Node 22 line cancels ~38 fast-tier tests" is **false at this HEAD**: the only Node-22 failures
are A1's own 6.

**A1 — `describe.each` shim cancels its own subtests. BUNDLE-CAUSED, blocks AC-R8, and is live NOW.**
`aa4f847f` (anatomy-park, in beta.21) added 6 tests to `ensure-monitor-window.test.js` via a local shim
that groups with `test()` instead of `describe()`:
```js
test(format(name, ...values), () => fn(...values));   // inner test() calls become subtests
```
The inner `test()` calls become subtests of a **synchronous parent that returns before they settle**.
Measured on Node 22.23.2: `fail 5, cancelled 5`, `failureType: 'cancelledByParent'`,
`error: 'test did not finish before its parent and was cancelled'` — byte-identical to the beta.21 CI
failure (`FAIL_BUDGET_EXCEEDED failures=3 budget=2 runs_completed=3`, same 6 names in all 3 runs).
Node 24 drains both subtests and reads green, which is why the local gate shipped it.

**It is a CLASS, not an instance.** Six shims exist; **2 group with `test()`, 4 with `describe()`**:

| file | groups with | status |
|---|---|---|
| `tests/ensure-monitor-window.test.js` | `test()` | **FAILING** (5 fail / 5 cancelled on Node 22) |
| `tests/monitor-mode-resilience.test.js` | `test()` | **LATENT** — passes only because each block holds ONE test |
| `tests/send-to-morty-no-premature-promise.test.js` | `describe()` | correct |
| `tests/gitattr-inference-deleted.test.js` | `describe()` | correct |
| `tests/integration/mega-bundle-rollup.test.js` | `describe()` | correct |
| `tests/integration/worker-timeout-tier-budget.test.js` | `describe()` | correct |

Fix by SUBTRACTION: **one shared shim** (the 4 correct ones are the oracle), not two patches. Adding a
second `test()` to any `monitor-mode-resilience` block is the next silent cancellation.
Full Node-22 fast tier at HEAD: **8604 tests, 8588 pass, fail 5, cancelled 5** — these 6 are the ONLY
failures. Nothing else on that tier is red.

**A2 — `check-flake-budget` throws away the child's output on the ONE path that needed it (R-FBTN-2).**
`src/bin/check-flake-budget.ts:278`: when `isBudgetableTestFailure()` is false it throws with only
`summarizeHarnessFailure()`'s **first non-empty line**, while the budgetable path writes full
stdout/stderr to `logPath` first. **R-FBTN already shipped** (`495d5e50`) and fixed the budgetable half;
this is its surviving sibling — the enumerated-set shape one branch over. Cost, measured: a 187-byte
gate log naming `▶ AC-6: Operator/terminal surface guard`, a suite that passes 16/16 — the reporter names
whichever file printed FIRST (`ac6-…` sorts first), so it accuses an innocent test by construction.
Fix subtractively: write the log BEFORE classifying the failure; one seam, not two.

**A3 — `rg` is not provisioned, the audit check silently no-ops, and the audit reports OK.**
beta.21 CI log: `scripts/audit-trap-door-enforcement.sh: line 576: rg: command not found`, and the audit
still exits 0 / prints `OK`. This is B-CIGREEN's ROOT A **still live** — the bundle did not fix it. Either
provision `rg` in both workflows or make the check use a provisioned tool; either way an unrunnable check
must FAIL, not pass (reuse the `isUnrunnableCheckResult` fail-closed discipline from R-SZGB-D).

**A4 — R-GBANNER** — the between/cross-ticket gate parser reports an npm lifecycle banner
(`> pkg@ver pretest:fast`, EMPTY `file`) as a failing TEST NAME, and the cross-ticket variant attributes
it to an already-green ticket. Two independent sessions. Fix: empty `file` + `^> \S+@\S+ \S+$` ⇒ attribute
to the SCRIPT, never seed a cross-ticket attribution.

**A5 — R-SJLAGMT** — `sjlag-state-heartbeat.test.js:60` compares float `mtimeMs`; same-millisecond stat
pairs lose ordering (`before=…970.9998 after=…970.999`). Use `{bigint:true}` `mtimeNs`. Do NOT relax to
`>` or delete — the heartbeat is real.

**A6 — R-NOPOSTTIER (P1)** — no phase measures the tier AFTER the bundle's final commit, so a run can
pass every per-ticket gate and hand back a red tree. Report-only per the no-stop rule: withhold the
success verdict, never block the epic.

**A7 — R-GENVL** — the gate inherits the manager env and `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` is read at
TEST time; 7 of 8 measured failures were pure contamination. Reuse the existing gate-env scrub seam
(`scrubGateEnv`/`PICKLE_GATE_SCRUBBED_ENV_KEYS` already exist — extend, do not add a second scrubber).

**A8 — R-ISSC / R-APGG** — `test:integration` short-circuits so the serial half is never measured when
parallel fails; the release gate must measure both halves independently.

## 🔁 ROOT B — MACHINERY PERSISTS A CONCLUSION AND NEVER RE-MEASURES IT

Four instances found in a single day, one shape: a durable artifact records a conclusion about the world
and nothing re-checks whether it still holds.

**B1 — `pipeline-cancel` is never cleared at startup. VERIFIED IN SOURCE, and it cost two phases.**
`bin/pipeline-runner.ts`: written on signal at `:3710` (`installShutdownHandlers`), unlinked ONLY at
`:4541` inside `finalizePhaseSuccess`. `main()` computes it at `:5324` and installs handlers at `:5325`
**without ever clearing a pre-existing marker**, while `cancelledOutcome` (`:5162`) cancels on its mere
existence. Measured: a fresh pipeline-runner inherited a 3-hour-old SIGTERM marker and stopped after
citadel — anatomy-park and szechuan never ran. Fix: a fresh run cannot be cancelled by a prior run's
signal; clear at startup.

**B2 — `handleRateLimit` waits on an IN-MEMORY deadline and never re-probes the API.**
`waitEnd = Date.now() + actualWaitMs`, polling only `state.active`. Deleting `rate_limit_wait.json` does
nothing — it is a STATUS artifact, not the control. Measured: over-waited 360 min on a limit that
cleared in ~45.

**B3 — `rate_limit_wait.json` re-arms itself on resume from the stale persisted `resets_at`**, and
mux-runner AC-A5 reads its PRESENCE to classify a spawn failure as rate-limited — so a stale file
misclassifies an unrelated failure. Source seams: `bin/mux-runner.ts:8229`, `:8490`, `:8494`, and the
presence-predicates at `:4684` / `:4769`.

**B4 — `pickle_incomplete.json` is never cleared when a later pickle phase completes the remaining
tickets.** Log-noise only — the runner DOES override it with real ticket evidence. Lowest priority in
this root; included because it is the same shape, not because it bites.

## ⛔ ROOT C — TWO TERMINATION CHANNELS, ONE SUBTRACTION (halt → park)

**C1 — B-ONEABORT residual — ❌ CLOSED BY MEASUREMENT 2026-08-28. DO NOT DISPATCH A TICKET.**
The pre-launch stale-premise check killed this one. At HEAD `0a5d4146` **and** in the deployed mirror:
```
export const MICROVERSE_FATAL_REASONS = [ 'session_state_corrupted' ];   // exactly ONE
```
The residual the handoff described (`judge_cli_missing` + `baseline_unmeasurable_unrecoverable` still
fatal, "3 → 1") is **stale**. Both reasons survive only in `MICROVERSE_FAILURE_REASONS`
(`types/index.ts:1467`), which drives `isMicroverseFailureExit` — a REPORTING classification that
withholds the success verdict. That is precisely what [[B-NOSTOP-GATES]] mandates: *honesty is a
REPORTING property, halting is a DISPOSITION, and they are not the same wire.* Keeping them there is
correct, not a residual. **B-ONEABORT's target of exactly one abort condition is MET.**
*Method note: this is the third time in this file's history that a ticket was nearly built on a premise
the code had already satisfied. Grep HEAD and the deployed tree before writing the ticket, not after.*

**C2 — R-JUNS** — an unparseable judge answer is treated as "unrecoverable" and aborts the pipeline. A
parse failure is a measurement failure.
**C3** — a deployed crash-floor halt verdict is discarded at the phase boundary; the amnesiac breaker
zeroes its own bound ($13.21 burned).
**C4 — R-MVPARK** — microverse rate-limit park has no cumulative ceiling; route through the EXISTING
`state.rate_limit_park` accumulator (`microverse-runner.ts`), do not grow a second ledger.
**C5 — R-EROS** — an In-Progress ticket is reported "all-Failed" and stamped `recovery_exhausted`.

## 🧟 ROOT D — PROCESS LIFECYCLE: ORPHANS, WEDGES, AND THE LINUX-ONLY SUBPROCESS REDS

**D1 — R-ORCG (supersedes R-WGTORPH's scope).** The orphan reaper's own test suite is the box's biggest
orphan producer and the shipped reaper cannot match most of what it produces. Operator census: 42 procs,
all `ppid 1`, ~1.7 GB. Two proven sub-defects: teardown lives in a per-test `finally` (unreachable on
timeout/OOM/cancel) and the fixture installs a no-op SIGTERM handler so it survives by design; and
`resolveTmpPrefixFixturePath` (`services/orphan-reaper.ts:148-162`) matches only an argv token resolving
under `os.tmpdir()` whose first segment starts `pickle-`, so a bare
`node <repo>/extension/tests/fixtures/sigterm-ignoring-sleeper.js` matches **zero** classes
(`grep -rc cxhang extension/src/` = 0).
**Census caveat, binding:** the population is currently **0** (hand-SIGKILLed). An empty census is NOT
evidence of a fix. Any AC must be demonstrated against a REAL re-accumulated population, never planted
fixtures — the R-WGTORPH fix passed precisely because its test planted the one class it could match.
Escalate to SIGKILL and VERIFY by pid; a SIGTERM that returns success changes nothing (measured).

**D2 — B-CIINT: the Linux-only serial-tier reds.** 7 fail / 3 cancelled on Linux, **633/633 green on
macOS/Node 24** (re-measured this session). Six are subprocess-lifecycle (kill/timeout/orphan) and one
is a path-containment pair. **CORRECTED 2026-08-30 (ticket `c1d1eeb3`): the constraint carried forward from
the B-CIGREEN PRD — "`docker` has no VM, so there is no local Linux repro" — is false as stated.**
Docker runs here (server 29.0.1) and `extension/scripts/ci-repro.sh` reproduces CI's Linux
environment with a measured **provisioning-noise baseline of 0** at `fe7860bb` (1-3 genuine failures
of 8902 tests across three runs, against 130 for the naive container shape). **What survives the correction is the rule, unchanged: a
ticket may not close on "passes locally" — it closes on a mechanically-checkable property, a green CI
run, or a `ci-repro.sh` run naming the sha it tested, and must say which.**

**D3 — R-TIERWEDGE** — a plain `npm run test:fast` can wedge at ZERO CPU: log frozen 8+ min, runner and
children with unchanged CPU time across samples, no summary emitted. Cannot fake a green (no summary) but
never returns. **Operational rule to encode: any wait on a tier run needs a STALL detector (no log growth
for N minutes), not a timeout.**
**D4 — R-GRLS** — fd cleanup only via `process.on('exit')`, which SIGKILL never runs.
**D5 — R-DSPW** — manager re-spawns a worker whose worker is still alive; the `rtk` filter empties
`ps|grep` so a live worker reads as dead. Fix subtractively: remove the heuristic that declared it dead.
**D6** — TMPDIR fixture-directory leak (~15k `pickle-*` dirs/run; TMPDIR is Spotlight-indexed).

## 📌 ROOT E — REMOVED FROM THIS BUNDLE (operator decision 2026-08-28, option 1)

R-ORSR-2 / R-ACNP / B-LOGEV edit the salvage / completion-evidence / Done-flip path, which is R-PSRB:
the deployed PRE-FIX runtime applies the same buggy logic to the worker building the fix, so they MUST
run **ATTENDED**. This bundle's `build_mode` is unattended, so carrying them here would quietly violate
that requirement.

**Split to `prds/p1-b-evidence-completion-evidence-and-done-flip-attended.md` ([[B-EVIDENCE]]), to be
launched attended as its own bundle.** 3 of 30 tickets — the phase economics barely move, and the
constraint is honored rather than hoped past.

## 📦 ROOT F — DEPLOY, INSTALL, AND PATH RESOLUTION

**F1 — the installer never prunes removed files.** Measured this session:
`~/.claude/pickle-rick/extension/bin/tmux-runner.js` is a **complete stale copy of mux-runner.js**
(identical line numbers at `:6795`, `:9438`, `:10376`). Inert — nothing invokes it — but a stale runtime
twin is a live misdirection hazard for anyone grepping the deployed tree. Verify deploys BY CONTENT.
**F2 — R-MPVU** — the manager prompt ships `${EXTENSION_ROOT}` unbound (8 literal occurrences delivered;
`grep EXTENSION_ROOT mux-runner.ts` = 0 hits). Blocks `--backend codex` entirely; claude infers and
proceeds. The fix is written and unwired: `getExtensionRoot()` (`services/pickle-utils.ts:301`).
**Build on claude — this bundle cannot build itself on codex.**
**F3 — R-RNTA** — release workflow reorder (build+attach the tarball independent of the gate).

## 🧩 ROOT G — SINGLETONS

**G1 — B-OFFREPO (P1)** the worker quality gate does not exist on any repo that is not pickle-rick.
**G2 — R-JPCM** the judge prompt demands a bare number, the parser demands JSON — ONE contract, not a
second parser. Also correct the stale `extension/CLAUDE.md` trap door that misroutes triage to a
dead-code hypothesis.
**G3 — `writeWithWatchdog: rejects with backpressure error when sink never drains`** flaked 1-in-5 this
session (200 ms). Same sole-settle-path timer family as B-DRAIN13 ROOT 1, which already fixed this exact
function once. Re-measure before assuming a second defect.
**G4 — R-BCFR** delete the `isBraceFreeIf` arm; verify-then-delete the `isNever` arm.
**G5 — R-HNCG / R-TCVC** unscoped bug reports — reground or close.

## Held back DELIBERATELY

`BUG-2026-08-10-install-sh-destroys-its-own-source-tree` — installer-surfaced but large (33 references)
and **destructive**. It does not belong in a bundle carrying 30 other tickets. Its own bundle.

## 🛡 PRIME DIRECTIVE COMPLIANCE — stated explicitly because this bundle is large

- **No new halt path.** ROOT C removes two abort conditions; ROOT B removes four persisted-conclusion
  states. ROOT A's fail-closed changes (A3) refuse a LOCAL verdict — an unrunnable check may not read as
  a pass — and never break the phase loop.
- **Subtraction is the preferred fix.** A1 collapses 6 shims to 1. A2 collapses 2 reporting paths to 1.
  B1 removes a state distinction. D5 removes a heuristic rather than guarding it.
- **Enumerated sets are the target, not the tool.** A1, A2 and D1 are all "the list was one member short."
  Prefer the formulation that needs no list.

## Acceptance criteria

- **AC-M1** Node-22 fast tier is `fail 0, cancelled 0`. Measure with Node 22 explicitly —
  **Node 24 hides this class** (proven: same tree, 8598 pass / 0 fail on 24, 5 fail / 5 cancelled on 22).
- **AC-M2** One shared `describe.each` shim; both defective files use it; a mutation adding a second
  `test()` to a `monitor-mode-resilience` each-block is demonstrated GREEN (the latent arm is closed, not
  just the failing one).
- **AC-M3** A non-budgetable flake-budget child failure writes the child's FULL stdout/stderr to a log
  path named in the error. Mutation-verify: the message must not be able to name a passing test.
- **AC-M4** An unrunnable audit check (missing `rg` or any absent tool) FAILS; it may not print OK.
- **AC-M5** A fresh `pipeline-runner` with a stale `pipeline-cancel` present runs all phases.
- **AC-M6** The rate-limit wait re-probes the API; `rate_limit_wait.json` presence alone cannot classify
  a spawn failure.
- **AC-M7 — WITHDRAWN, already satisfied at launch.** `MICROVERSE_FATAL_REASONS` is already exactly
  `['session_state_corrupted']` at HEAD and deployed (see ROOT C / C1). Retained as a REGRESSION pin
  only: no ticket in this bundle may add a member to it.
- **AC-M8** D1 is demonstrated against a RE-ACCUMULATED real orphan population, not planted fixtures.
- **AC-M9** Every D2 ticket states in its closing artifact WHICH it closed on: a mechanically-checkable
  property, or a green CI run. "Passes locally" is not a close.
- **AC-M10 (report-only, non-gating)** Tiers do not regress. Baseline recorded at launch:
  fast **8604/8598 pass, fail 0, cancelled 0** (Node 24) and **fail 5, cancelled 5** (Node 22, = A1);
  integration parallel **662/662**, serial **633/633**; expensive **8/8** serial + 13/14 parallel
  (1 benign empty-catalog skip), soak genuinely 1803673 ms.
  **There are NO inherited failures — beta.17 retired both — so ANY new failure is attributable to this
  bundle.**
- **AC-M11** A green release-workflow run on the resulting tag (**AC-R8**, unmet for 15 consecutive
  releases, beta.7→beta.21). This is the bundle's headline and the only close that counts for ROOT A/D2.

## Non-goals

- **Do NOT move CI off Node 22.** Node 24 HIDES the unsettled-promise/cancelled-subtest class rather than
  fixing it — proven twice by controlled experiment, and again by A1 this session. Bumping would be
  fake-green by definition.
- **Do NOT raise the iteration cap.** 500 global with no per-ticket budget never bound anything.
- Do NOT blanket-`ref` every timer; a heartbeat holding the loop open forever is a NEW hang.
- Do NOT rewrite published tags. beta.16/.17 pointing at `origin/main` stays an operator residual.

## Simplification Review

1. **Necessary?** ~43 open items; ROOT A's first ticket is what currently blocks the release workflow.
2. **Reuse?** A7 extends `scrubGateEnv`; A3 reuses R-SZGB-D's `isUnrunnableCheckResult` fail-closed
   discipline; C4 reuses `state.rate_limit_park`; F2's `getExtensionRoot()` is already written.
3. **Guards brittle complexity?** No — it removes the distinctions the guards compensated for.
4. **Subtracts?** 6 shims → 1, 2 reporting paths → 1, 3 abort reasons → 1, 4 persisted-conclusion
   states → 0, ~30 PRD rows closed.

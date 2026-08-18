# BUG: R-WGTORPH — worker-gate shim orphans re-accumulate, survive SIGTERM, and contend with every tier run

- **Date**: 2026-08-16
- **Priority**: P1 (reliability — permanent CPU oversubscription on the box that measures everything)
- **Branch**: `release/v2.1-beta`
- **Measured at**: `a001b4ee` (fast tier green: 7707 tests, 507 suites, fail 0, cancelled 0)
- **Class**: process leak. Every `test:fast` run of one test file strands children that nothing reaps.

## Problem

Test-harness subprocesses under `os.tmpdir()` fixture roots are stranded with `ppid == 1` and never
reaped. The generic shape: a test spawns `spawnSync(process.execPath, [...], { timeout })`; Node's
`timeout` signals only the DIRECT child, so that child's own descendants re-parent to pid 1 and
outlive the run. 115 test files in `extension/tests/` use this spawn shape; 36 pass `SPAWN_MORTY_BIN`.

**Correction (2026-08-16, regrounded before decomposition — supersedes the original draft.)**
The original draft named `extension/tests/spawn-morty-worker-gate.test.js:15-16` as the source and
claimed it "spawns a REAL `npm run test:fast`". Both claims are false and are struck:

1. **No real npm runs.** That test writes executable `npm`/`npx` PATH shims itself
   (`writeCommandShim` `:44-69`, `writeNpmTimeoutTreeShim` `:205-243`, prepended via the `PATH:`
   env at the `spawnSync` callsites `:596-612`, `:681-698`). Neither real npm nor the real fast
   tier ever executes under it.
2. **That test's own timeout path is already fixed and already pinned.** It SIGTERMs the process
   TREE and escalates to SIGKILL; `:831` already asserts `isPidAlive(childPid) === false` for the
   grandchild, with the message oracle at `:822-826`.
3. **The named prefix reaps nothing.** Per-prefix census, this box, 2026-08-16 (taken with
   `rtk proxy "ps -axo pid=,ppid=,etime=,command="` — a bare `ps | grep` pipe under rtk returns
   EMPTY and reads as a clean box):

| tmp prefix (`ppid == 1`, node-shaped) | count | source |
|---|---|---|
| `pickle-broker-*` (8 distinct fixture names) | **20** | `monitored-process-broker-shutdown.test.js` — **absent from this branch**; present in sibling clone checkouts under `loanlight/pickle-rick/` |
| `pickle-omtd-*` | 1 | `tests/pipeline-runner-orphan-mux-teardown.test.js:27` |
| this session's own procs | 1 | n/a |
| **`pickle-spawn-morty-worker-gate-*`** | **0** | — |

Totals: 668 `ppid == 1` processes on the box, 22 node/npm-shaped. A reaper pinned to the
`pickle-spawn-morty-worker-gate-` string would reap **zero** of today's population. The fix must
therefore match the **tmp-prefix family** (`pickle-*` fixture roots under `os.tmpdir()`), not one
string. The original 13→14 re-accumulation counts are retained as evidence that the class refills,
but they are **unattributed to a prefix** and must not be cited as gate-shim counts.

**Operator counter-correction (2026-08-16, from the pre-reap census the regrounding could not see).**
The `pickle-spawn-morty-worker-gate-*` prefix is NOT empty — it was emptied ~2 minutes before that census
was taken. All 14 processes reaped at 04:1x were exactly this prefix; three sample lines from the
operator census file, `ppid == 1`:

```
16434  1  17:15:28  node /…/T/pickle-spawn-morty-worker-gate-8uYtWz/bin/npm run test:fast
20410  1  13:53:26  node /…/T/pickle-spawn-morty-worker-gate-it4bUH/bin/npm run test:fast
20992  1  12:22:07  node /…/T/pickle-spawn-morty-worker-gate-K5hoFk/bin/npm run test:fast
```

Ages to 22:46:11. So the 13→14 counts ARE attributable to this prefix, and "a reaper pinned to that
string would reap zero" holds only for a box that was just cleaned. **This does not change the fix** —
the tmp-prefix FAMILY match is still the right target and already subsumes this prefix. It changes the
record: do not conclude the prefix is inert.

**What the regrounding got right, and my draft got wrong — both struck claims confirmed against source:**
the command line is `node <fixture>/bin/npm run test:fast`, i.e. the test's OWN shim, so no real npm and
no real fast tier ever ran (my "spawns a REAL npm run test:fast" was false); and
`extension/tests/spawn-morty-worker-gate.test.js:831` already asserts
`isPidAlive(childPid) === false` after a SIGTERM-tree → SIGKILL escalation, so that timeout path is
already fixed and pinned (my AC-5 premise was false). The leak survives despite that assertion, which is
itself the interesting residue: the pinned path covers the direct child's descendant, not every
descendant the shim can strand.

**They ignore SIGTERM.** A plain `kill` on all 13 (each `ppid==1`-verified) returned success and changed
nothing — a re-census 25 s later showed the same pids with ages advanced. `kill -9` took all 13
immediately, and again all 14 the next day. Any reaper that sends SIGTERM and trusts the return value
will silently leave the leak in place.

**Why it matters beyond tidiness.** Every orphan is a resident process competing with the fast tier —
the measurement this whole branch depends on. It is a standing suspect for `R-TIERWEDGE` (0-CPU tier
wedge, twice-reproduced at 6126 lines) and it pushes the timeout-shaped suites (`runGate`, hang-guard,
between-ticket-gate) toward flake. This is not proof of causation and the ticket must not claim it.

## Why the existing reaper does not cover it

`extension/src/services/orphan-reaper.ts` already owns the shape: `parseWorkerProcsFromPs` (`:144`),
positive-ownership matching, a `minAgeSeconds` floor (`:243`/`:271`, default at `:318`),
`killProcessGroup` (`:55`), and the entry point `reapOrphanedWorkerProcs` (`:340`). It matches worker
*procs* by `--add-dir` session ownership.

The drop happens **one layer earlier than originally stated**: `parseWorkerProcsFromPs` rejects every
line failing `isWorkerShapedCommand` (predicate `:106-116`, applied `:157`) — argv[0] basename must be
`codex` or `claude` with matching bypass flags. A fixture orphan is `node /var/folders/.../T/pickle-*/…`,
so it never becomes a `WorkerProcCandidate` and never reaches the `owningSessionDir === null` reject at
`:270`. The extension therefore touches **three** seams: the parser shape filter, the ownership
predicate (`:264-273`), and the telemetry emitter (`:288-304`).

Two further constraints found in the code, not in the original draft:
- `runReapPass` breaks out of the candidate loop once `Date.now() > deadline`
  (`DEFAULT_WALL_BUDGET_MS = 15_000`, `:44`/`:323`/`:327`) and each reap already burns up to
  `graceMs = 2000` (`:42`, `:276-286`). Added per-candidate verification can silently truncate the pass.
- `reapCandidateGroup` already reports success unconditionally (`:284-285` → `emitReapedTelemetry`,
  `reaped` incremented at `:331` regardless). The "trusts the kill's return value" defect is in the
  EXISTING path, for the codex/claude class too — not only in the new matching.

## Solution

Extend the existing reaper; do NOT write a second one.

- **WS-1 — family match, anchored to a path.** Add positive-ownership matching for `pickle-*` fixture
  roots under `os.tmpdir()`, gated by the SAME `minAgeSeconds` floor (`DEFAULT_MIN_AGE_SECONDS = 600`,
  `:42`, applied `:318`). Positive ownership stays the invariant: the match must be anchored to an argv
  token that RESOLVES to a path under `os.tmpdir()` — never `command.includes(prefix)`. (Observed
  hazard, not hypothetical: four LIVE `claude` processes on this box carried
  `pickle-spawn-morty-worker-gate-` in argv because the PRD text was in their prompt.)
- **WS-2 — verified death.** SIGTERM → bounded grace → SIGKILL → **verify by pid**, bounded. Never treat
  a kill's return value as proof — measured above, it lies for these processes. Applies to the existing
  codex/claude class as well as the new one.
- **WS-3 — close it at the source.** The orphan-producing shape is the HARNESS spawn
  (`spawnSync(process.execPath, [...], { timeout })`), not the gate test's own timeout path (already
  fixed, `:822-831`). Scope: make the harness spawn detached + group-killed on timeout for the callsites
  in the ticket's scope. Do NOT introduce a repo-wide shared spawn helper (see Out of scope).

## Acceptance criteria

- **AC-1 — the family is reaped, end to end.** A stubbed `ps` line for a `node` process whose argv
  contains a path under `os.tmpdir()` rooted at a `pickle-*` fixture prefix, `ppid 1`, older than
  `DEFAULT_MIN_AGE_SECONDS` (600), is (a) admitted by `parseWorkerProcsFromPs` — which today rejects it
  at `isWorkerShapedCommand` (`:106-116`, applied `:157`) before ownership is consulted; (b) accepted by
  `isReapableOrphan` (`:264-273`) despite `owningSessionDir === null`; and (c) emitted as a
  schema-conformant `worker_orphan_reaped`. Removing any ONE of the three seams makes the test RED.
  Fixture must include the real observed population shape:
  `node /var/folders/.../T/pickle-broker-bounded-process-snapshot-XXXXXX/descendant.js`.
- **AC-1b — telemetry payload is pinned, not guessed.** `worker_orphan_reaped` is schema-required to
  carry `owning_session` (`extension/src/types/activity-events.schema.json`), derived at `:289` from
  `path.basename(cand.owningSessionDir ?? '')`. For the tmp-prefix class it is the **empty string** `""`.
  Assert that value explicitly. No new event type (AC-7).
- **AC-2 — min-age and ownership still hold.** Three negative fixtures, all asserting ZERO kills:
  (a) a same-family process YOUNGER than the floor; (b) a process that merely MENTIONS a `pickle-*`
  prefix in a non-path argv position (e.g. `claude … -p '<prompt containing the prefix>'` — four such
  processes were LIVE on this box during analysis); (c) a `pickle-*`-prefixed path that does NOT resolve
  under `os.tmpdir()`. Positive ownership is not relaxed to a substring match on the command line.
- **AC-2b — the floor cannot kill a live measurement.** The single highest-severity hazard: a
  legitimately-running fixture is indistinguishable from an orphan by prefix alone, and the only defense
  is the age floor. Assert that a same-family process younger than the LONGEST legitimate run
  (`PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` default 600000 ms = 600 s, equal to the floor) is not reaped, and
  state in the ticket why the chosen floor is ≥ that runtime. If the floor is not raised, say so and
  justify it — a floor below a real gate's runtime reaps the fast tier mid-measurement, on the box every
  verdict in this branch depends on.
- **AC-3 — death is verified, not assumed.** The reap path escalates SIGTERM → bounded grace → SIGKILL
  and confirms by pid. A test simulates a SIGTERM-immune process and asserts the reaper escalates and
  reports the pid as reaped only after it is actually gone. The ticket must NAME the verification
  mechanism (`process.kill(pid, 0)` vs `ps` re-census) and its known failure mode (pid reuse;
  `kill(pid,0)` succeeds for a process the caller cannot signal).
- **AC-3b — verification never silently truncates the pass, and never hangs setup.** Escalation is
  BOUNDED (one SIGTERM, ≤N s grace, one SIGKILL, ≤N s verify, then log-and-continue — a D-state process
  must not spin; cf. R-CXHANG). With a 20-candidate population the `wallBudgetMs` deadline (`:323`,
  `DEFAULT_WALL_BUDGET_MS = 15_000`) must not cause an unreported `break` (`:327`): either bound
  verification per candidate or raise the compiled constant. No new setting key (AC-7); changing a
  compiled constant is in bounds. Assert a total wall-clock ceiling for the pass.
- **AC-4 — a live worker is never touched.** A running worker proc owned by a LIVE session is not reaped
  under any of the new matching. This is the invariant the R-CXHANG reaper already holds and this ticket
  must not weaken it.
- **AC-5 — the leak is closed at the source, or the drop is falsified in writing.** Driving the harness
  spawn's timeout path leaves no `ppid 1` descendant behind. WS-3 is droppable ONLY with pasted evidence
  that the descendant is already re-parented before the handler can run — a bare declaration of
  infeasibility does not satisfy this AC.
- **AC-6 — tier green.** `npm run test:fast` reports `fail 0` AND `cancelled 0`, measured with
  `PICKLE_TEST_RUNNER_TIMEOUT_MS=7200000` and a clean environment. `cancelled > 0` is inconclusive:
  re-run, never report as pass. Test count must not shrink below 7707 — read the floor from the runner's
  own summary block, never from prose.
- **AC-7 — no new terminal condition, no new operator surface.** No new `exit_reason`, no new abort site,
  no new setting key, no new flag. `PICKLE_ORPHAN_REAP=off` remains the existing kill-switch and must
  disable the new matching too — with its OWN assertion, not a clause. (It is satisfied by construction
  today: `env[ORPHAN_REAP_ENV_VAR] === 'off'` returns at `:342`, ahead of `runReapPass`, so new matching
  inside `runReapPass` inherits it for free. Do not add a redundant second check — pin it with a test.)
- **AC-8 — the reap actually drains a real population.** A test plants N synthetic long-lived
  tmp-prefix processes (real pids, `ppid 1`-shaped or stubbed `ps`), runs `reapOrphanedWorkerProcs`, and
  asserts a post-run census shows ZERO surviving. Without this the bundle can land AC-1..AC-4 green and
  change nothing measurable — the failure mode the census correction above exposes.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| False-positive SIGKILL of an unrelated live developer process on the operator's box (not recoverable by re-running) | **High** | Path-anchored match under `os.tmpdir()` + `pickle-*` root + `ppid == 1` + age floor. AC-2(b)/(c) are the regression fixtures. |
| Reaping a **concurrently running** legitimate fixture — i.e. killing the fast tier mid-measurement | **High** | Age floor ≥ longest legitimate run. AC-2b. AC-4's live-session protection does NOT reach this class (it has no session ownership), so the floor is the only defense and must be justified numerically. |
| Escalation loop blocks setup bootstrap (D-state / uninterruptible process) — a hang, which AC-7's "no new terminal condition" does not cover | Medium | Bounded escalation + total wall ceiling. AC-3b. |
| `ps` output-shape drift (all measurement here is macOS BSD `etime`, e.g. `02-03:56:21` = `DD-HH:MM:SS`); repo has a chronic macOS-vs-Linux CI gap | Medium | AC-1 stubs `ps` output rather than shelling out, so the parser test is portable. State Linux-CI expectation in the ticket. |
| `TMPDIR` differs between the creating process and the reaping process, so the match silently reaps nothing while reporting success — a fake-green shape | Medium | Either assert a fixture created under a non-default `TMPDIR` still matches, or record out-of-default-`TMPDIR` orphans as knowingly out of scope. |
| Pid reuse between SIGKILL and the by-pid confirmation | Low | AC-3 names the mechanism and its failure mode. |

## Out of scope

`R-TIERWEDGE` itself — this bundle may reduce contention but must not claim to fix the wedge, and must
not add a wedge-detection mechanism. `R-SJLAGMT` and `R-GBANNER` likewise.

**Deliberate deferral (named so it is not silent):** the harness-wide shape — 115 test files spawn
`process.execPath` via `spawnSync`, 36 of them `spawn-morty.js` under a `timeout` cap — is the general
form of this leak. This bundle does NOT introduce a shared detached-spawn test helper.

**Not this repo's to fix:** 20 of the 22 orphans measured today come from
`monitored-process-broker-shutdown.test.js`, which is absent from this branch and lives in sibling clone
checkouts. This bundle reaps that population (the reaper is prefix-family-based and runs on this box);
it does not fix the producing test, which is not on this branch.

## Simplification Review

1. **What can be subtracted instead of added?** WS-3 is the subtractive option: group-killing the
   harness spawn on its own timeout path means the orphan never exists, so nothing needs reaping. Prefer
   it where possible; the reaper extension (WS-1/WS-2) is the safety net for orphans already stranded —
   including the 20 produced by a checkout this branch does not control. Note WS-3 was originally aimed
   at the gate test's own timeout path; that path is already fixed and already pinned (`:822-831`), so
   aiming there would have been a no-op. Retargeted at the harness spawn.
2. **Does this add a new abort condition?** No — AC-7 forbids it. A reaper kills a dead session's leftover
   process; it never stops the run.
3. **Does this add a new configuration surface?** No — AC-7 forbids it and pins the existing kill-switch.
4. **Is a fix at this seam load-bearing for anything else?** Yes — the fast tier is the instrument every
   verdict in this branch depends on, and these orphans are permanent background load on the box running
   it.

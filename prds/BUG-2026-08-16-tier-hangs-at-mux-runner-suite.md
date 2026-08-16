# BUG (P0): `test:fast` hangs at zero CPU entering the `mux-runner` suite — four occurrences, contention falsified

- **Date**: 2026-08-16
- **Priority**: P0 — the fast tier is the instrument every verdict on this branch depends on; it hangs
  roughly half the time
- **Branch**: `release/v2.1-beta`
- **Class**: intermittent hang, reproducible boundary, cause unknown

## Evidence

Six operator-run clean-env tiers, all `PICKLE_TEST_RUNNER_TIMEOUT_MS=7200000`, all with an 8-minute
no-log-growth stall detector:

| tree | outcome | hang line |
|---|---|---|
| `5dba30c5` | completed — 7647 tests, fail 0 | — |
| `a5edb12f` | completed — 7647 tests, fail 1 | — |
| `a5edb12f` | **HUNG** | 6138 |
| `e57bac7a` | **HUNG** | 6126 |
| `e57bac7a` | **HUNG** | 6126 |
| `3216370c` | completed — 7707 tests, fail 0 | — |
| `4cdd0133` (quiet box, post-deploy) | **HUNG** | 6141 |

**Every hang ends on the identical tail** — the last four lines are always the `WS-2d` /
`AC-R-WMNP-4` block ending `attemptRecoveryBeforeTerminal seam runs and returns a RecoveryOutcome on
no-evidence ticket`. A suite-coverage diff of a hung run against a completed one showed **2886 tests
logged vs 5899**, with the **3011 missing tests beginning exactly at the `mux-runner:` suite**
(`mux-runner: exits with code 1 and prints Usage when no args provided`, …). That suite spawns the real
mux-runner binary.

**Everything is parked, not working.** Process census at a hang: runner `bin/test-runner.js` at
`0:00.10` CPU unchanged across a 20 s sample; its child `0:02.36` unchanged across 25 s; grandchild
`0:00.47` over 10:47. No summary block is ever emitted, so a hung run cannot produce a false green —
but it never returns either, and the 2 h runner timeout means a naive waiter blocks for 2 h.

**Two hypotheses are already FALSIFIED — do not re-propose them.**

1. **Nested tier run.** Claimed the completion seam inside `extension/tests/mux-runner.test.js` starts a
   real `npm run test:fast`. False: both `runBetweenTicketFastGate`
   (`extension/src/bin/mux-runner.ts:708`) and `runPostFinalMeasurement` (`:941`) return early unless
   `<working_dir>/extension` exists, that guard predates the hang (present at `41575226`), and every
   working dir in that test file is a bare `mkdtempSync` with no `extension/` child.
2. **Orphan contention.** The `4cdd0133` hang happened on a box where all 32 `ppid == 1` tmp-prefix
   orphans had been reaped minutes earlier and the R-WGTORPH reaper fixes were deployed. A quiet box
   still hangs.

## What the ticket must do

Find the actual blocking call. Suggested starting points, none of them conclusions:

- The `mux-runner:` suite spawns the real binary; enumerate its spawn callsites and check every one for a
  missing or unbounded `timeout`, and for a read on a pipe that no one closes.
- Node's `spawnSync` `timeout` signals only the DIRECT child — a grandchild holding the inherited stdio
  pipe open keeps the parent's read blocked even after the child is signalled. That shape matches a
  0-CPU park exactly and is worth testing first.
- Determine why it is ~50% rather than deterministic: ordering under `--test-concurrency=8` is the
  obvious candidate, so record whether the hang correlates with which suites are co-scheduled.

## Acceptance criteria

- **AC-1 — the cause is named with evidence.** The ticket identifies the specific blocking callsite and
  demonstrates it — a repro, a stack, an strace/sample, or a targeted test that hangs without the fix.
  "Added a timeout and it stopped happening" is NOT an identification and does not satisfy this AC.
- **AC-2 — the tier completes repeatedly.** `npm run test:fast` runs to a summary block with `fail 0` and
  `cancelled 0` on **five consecutive** clean-env runs. One clean run cannot distinguish *fixed* from
  *did not recur* — this class has already produced two false "it stopped" readings.
- **AC-3 — a regression pin.** A test fails if the specific unbounded wait is reintroduced. If the cause
  turns out to be un-pinnable in-suite, say so explicitly and explain why rather than dropping the AC.
- **AC-4 — no masking.** The fix must not be "raise the runner timeout", "retry the suite", or "skip the
  test". Reducing observability of the hang is a failure of this ticket.
- **AC-5 — count floor.** Test count must not shrink below 7707, read from the runner's own summary
  block, never from prose.
- **AC-6 — no new terminal condition, no new operator surface.** No new `exit_reason`, no new abort site,
  no new setting key, no new flag.

## Out of scope

`R-GBANNER` (npm banner parsed as a failing test name) and `R-SJLAGMT` (float `mtimeMs` flake). Both are
filed separately and must not be folded in.

## Simplification Review

1. **What can be subtracted instead of added?** An unbounded wait is the thing to remove; bounding it is
   subtraction of an infinite case, not a new feature. Prefer closing the pipe / killing the group over
   adding a watchdog layer.
2. **Does this add a new abort condition?** No — AC-6 forbids it. A bounded wait that fails a test is not
   a pipeline abort.
3. **Does this add a new configuration surface?** No — AC-6 forbids it, and AC-4 explicitly rules out
   tuning the existing timeout as the fix.
4. **Is a fix at this seam load-bearing for anything else?** Yes, maximally: while the tier hangs ~50% of
   the time, every verdict on this branch costs an unpredictable number of retries, and the operator
   cannot distinguish a hang from a slow suite without a stall detector.

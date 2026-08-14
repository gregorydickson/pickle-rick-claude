# BUG: salvage reports `reset Todo`, leaves the ticket `In Progress`, then terminates on `empty_roster_all_failed_no_runnable`

- **Date**: 2026-08-14
- **Priority**: P1 (reliability)
- **Session of record**: `2026-08-14-d9f472a4` (PRD `BUG-2026-08-14-advisory-residual-sink-consumers-stale.md`, ticket `4f831a16`)
- **Branch**: `release/v2.1-beta`
- **Class**: terminal-disposition defect. A run with one runnable ticket and a correct, complete diff on
  disk terminated as `recovery_exhausted` and produced no commit.

## What happened

The worker completed the ticket correctly. Its diff — four files, all under `extension/tests/`, satisfying
every acceptance criterion including the shared-helper and no-runtime-source constraints — was left on
disk. Its gate reported `__timeout__` after 1800000 ms, the known concurrent-worker symptom, not a test
failure. An operator-run measurement of the same tree afterwards was clean: 7616 tests, 504 suites,
fail 0, cancelled 0, 736520 ms. The work was correct; only the gate's measurement was not.

`mux-runner.log`, iteration 2 into 3:

```
[exit-commit] ticket 4f831a16: gate not green — leaving uncommitted work for the failure/skip path
[salvage] 4f831a16: failing -> archived diff + reset Todo
--- Iteration 3 (state.iteration=3) ---
empty roster (all-Failed, no runnable ticket) — honest terminal recovery_exhausted before runIteration.
```

Two facts contradict that log line. First, the ticket's frontmatter after the run still reads
`status: "In Progress"` — the announced `reset Todo` never reached disk. Second, `In Progress` is a
runnable status, so a roster containing it is not "all-Failed, no runnable ticket". The run declared an
empty roster while holding one runnable ticket and one complete diff.

`state.json` end state: `active: false`, `exit_reason: "recovery_exhausted"`, `step: "implement"`,
`iteration: 3`, `current_ticket: "4f831a16"`, `boundary_commit_resolved` with
`outcome: "honest_failure"` and `post_iter_sha` equal to the pre-iteration sha. HEAD did not move.

## Why this is a reliability defect, not a gate-honesty question

Withholding the Done flip on a red gate is correct and must not change. Terminating the phase loop is
not. The governing rule is that a gate may refuse a LOCAL action, stamp an `exit_reason`, and log a
residual — and the run then parks the item, flags it, and CONTINUES. Here the local refusal escalated
into a terminal disposition through a roster mis-read, which is exactly the failure mode that takes
reliability and quality to zero together.

The disposition also depended on a status write that silently did not happen. A salvage step that
reports a state transition it did not perform makes every downstream roster decision unsound.

## Root causes (two, independently fixable)

1. **The salvage reset is not verified.** The `failing -> archived diff + reset Todo` path logs its
   intent before, or instead of, confirming the frontmatter write. Nothing re-reads the ticket to
   confirm the status landed.
2. **The roster emptiness predicate mis-classifies `In Progress`.** A single `In Progress` ticket with
   remaining per-ticket iteration budget (`current_ticket_max_iterations: 30`, spent 2) was counted as
   neither runnable nor recoverable, producing `empty_roster_all_failed_no_runnable`.

## Acceptance criteria

- **AC-1 — the salvage reset is confirmed, not announced.** After the failing-ticket salvage path runs,
  the ticket's on-disk frontmatter `status` equals the status the log line claims. A test drives the
  salvage path against a ticket whose frontmatter write is made to fail and asserts the run records the
  write failure rather than logging a completed transition.
- **AC-2 — an `In Progress` ticket with remaining budget is runnable.** The roster-emptiness predicate
  classifies a sole `In Progress` ticket with unspent per-ticket iterations as runnable. A test asserts
  `empty_roster_all_failed_no_runnable` is NOT reached for that roster shape.
- **AC-3 — no new terminal condition.** `git diff` adds no new `exit_reason` string and no new abort
  site. The change may only make an existing terminal condition harder to reach, never easier. A test
  pins the set of terminal `exit_reason` values against the pre-change set.
- **AC-4 — a gate timeout parks and continues.** A worker whose gate returns `__timeout__` while its
  ticket has remaining budget results in another iteration for that ticket, not a terminal state. Assert
  on the iteration count advancing with the ticket still selected.
- **AC-5 — tier green.** `npm run test:fast` reports `fail 0` AND `cancelled 0`, measured with
  `PICKLE_TEST_RUNNER_TIMEOUT_MS=7200000` and a clean environment. `cancelled > 0` is inconclusive:
  re-run, never report as pass. Test count must not shrink below 7616.
- **AC-6 — no capability work.** No new operator flag, no new setting key, no new command.

## Out of scope

The gate timeout itself. That is the concurrent-worker root, already specified in
`prds/BUG-2026-08-14-concurrent-workers-per-session.md` (`9a7cbdaf`), and this bundle must not attempt a
second fix for it. This bundle only ensures that a timed-out gate cannot destroy a completed ticket's
run.

## Simplification Review

1. **What can be subtracted instead of added?** The roster-emptiness predicate is the subtraction
   target: it currently enumerates conditions under which a run may terminate. Removing `In Progress`
   from the set of statuses that can contribute to an "all-Failed" verdict is a deletion, not a guard.
2. **Does this add a new abort condition?** No — AC-3 forbids it. The change is strictly
   terminal-reducing.
3. **Does this add a new configuration surface?** No — AC-6 forbids it.
4. **Is a fix at this seam load-bearing for anything else?** Yes, favourably: every future bundle whose
   worker gate times out under contention inherits the parked-and-continued disposition, so the fix
   composes with the worker-lock bundle rather than duplicating it.

## Recovery performed at the time

The worker's diff was verified against every acceptance criterion of ticket `4f831a16`, measured clean on
the fast tier, and committed as `390049c8`. No code was hand-authored during the recovery.

# B-STALE-SENTINEL — a stale pickle_incomplete sentinel reports a completed build as failed (#76, `main`)

A run stopped twice by SIGHUP, then restarted, finished all 24 tickets with every phase exiting 0, yet
`pipeline-status.json` read `failed` (#76). Measured on `main@f388dc75`, 2026-10-05.

## Mechanism

`maybeStampPickleIncompleteRobust` (`extension/src/bin/pipeline-runner.ts`, ~:6979) runs whenever `pickle_incomplete.json`
exists. In order, it:
1. logs `Phase pickle did NOT complete — advancing with phase reported incomplete (… sentinel present)` before
   checking anything;
2. calls `reportPhaseIncomplete`, which consults the ticket roster and, for an all-Done roster, declines to stamp
   `pipeline_phase_incomplete`;
3. deletes the stale sentinel in that case (B4);
4. still returns `{ action: 'continue', phaseIncomplete: true }` unconditionally, which forces exit code 3 and a `failed`
   status.

So the log carries two contradictory lines one after the other, and the verdict is decided by an earlier run's teardown
rather than this run's ground truth. Tests `rrh-pickle-incomplete.test.js` "pickle_incomplete.json sentinel forces exit
3 but an honestly all-Done roster still advances to citadel" (~:199) and "B4: an honestly all-Done roster clears the
stale … sentinel" (~:246) pin exit code `PhaseIncomplete` for the all-Done case: the "intentional split" between exit
code and exit_reason.

## Decision (applying the operator's principles, 2026-10-05)

Honesty is a REPORTING property (root CLAUDE.md): a run whose roster is all-Done and whose phases exited 0 is a
completed run, and reporting it `failed` is a false report. The earlier interruption is DISCLOSED as a line, not
used as the verdict. This reverses the AC2b/B4 "intentional split"; the sentinel stays the authoritative marker for a
genuinely incomplete roster (unchanged).

## Fix

Check the roster first. If `reportPhaseIncomplete` says the roster is genuinely incomplete: unchanged (log the
did-NOT-complete line, return `phaseIncomplete: true`). Otherwise: delete the sentinel, log one disclosure line
`Phase pickle: an earlier signal teardown left <sentinel>; all tickets are now accounted for — completed`, and return
`null`, deferring to the normal gate. No new state field, gate, or exit code.

## Acceptance criteria (measured at `f388dc75`)

1. In `extension/tests/rrh-pickle-incomplete.test.js`, the AC2b and B4 tests (sentinel present, all-Done roster) expect
   a COMPLETED exit (`main()` exit code 0) and `pipeline-status.json` `status: "completed"`; the log has the disclosure
   line and NO `did NOT complete` line (today: exit 3, the `did NOT complete` line present; the existing tests pin 3).
2. Control (unchanged, must stay green): a genuinely incomplete roster with the sentinel still exits 3 and keeps the
   sentinel ("B4 control").
3. `cd extension && ./node_modules/.bin/tsc && node --test tests/rrh-pickle-incomplete.test.js tests/nostop-gates-phase-loop.test.js` → 0 failures.
4. `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/eslint src/ --max-warnings=0` exit 0; `bash scripts/audit-trap-door-enforcement.sh` exit 0.

## Simplification Review

It removes a contradiction: one decision point instead of a hardcoded `true` beside a ground-truth check. No new
mechanism.

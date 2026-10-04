# B-MREL-FIX2 — the success-verdict census predates MREL-A2 and MREL-A12 (`main`)

Gate `20261003T233050Z-98472` at `main@b3e50edc`: 21/22, soak 1803.7s. Red: `test_fast_budget`, 3/3 runs, the same two
tests in `extension/tests/success-verdict-withheld.test.js`. Both were already red at `10bcb7d6`; the B-MREL-FIX
triage read only the first lines of each run's failure list (`grep -A3`) and missed them. Measured 2026-10-04.

## Mechanism (both are deliberate, operator-approved behaviour changes the tests predate)

1. `:498` "exactly five raise sites survive": MREL-A2 (`287baba0`) replaced the `closer_handoff_terminal` break with
   `withholdForCloserHandoff`, which withholds success via `nonConvergent` (plan item A2: "withholds success through
   `nonConvergent`"). The AST census finds a sixth raise site, `withholdForCloserHandoff: 1`.
2. `:292` "non-pickle phases are unaffected by the red-test check": it calls `finalizePhaseSuccess(..., 'citadel', 1, …)`
   and asserts `nonConvergent === 0`. MREL-A12 (`2b7c22ef`) made a non-zero non-pickle exit non-convergent, so the
   exit code 1 now raises the counter. The test's purpose is that citadel never runs the red-TEST ticket scan; exit 1
   conflates it with A12.

## Fix (test-only, one file)

1. Add `withholdForCloserHandoff: 1` to the exact census map with a comment naming MREL-A2; retitle "exactly five" to
   the measured count. Re-measure with `collectRaiseSites()` before editing (the test's own rule).
2. In `:292`, call citadel with exit code `0` so the test isolates the ticket-scan behaviour; keep
   `nonConvergent === 0` and `action === 'continue'`. A12's non-zero rule is pinned by its own tests
   (`pipeline-runner-done-without-commit-evidence-fatal.test.js`), not here.

## Acceptance criteria (measured at `b3e50edc`)

1. `cd extension && ./node_modules/.bin/tsc && node --test tests/success-verdict-withheld.test.js` → 0 failures (today: 2).
2. `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/eslint src/ --max-warnings=0` exit 0.

## Simplification Review

Test-only re-pin to approved behaviour; no product change, no new gate or list member beyond the census entry that
the code now has.

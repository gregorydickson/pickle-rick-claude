# B-MREL-FIX — two test-side omissions left the B-MERGE-REL-1 gate red (`main`)

Gate `20261003T213058Z-81054` at `main@10bcb7d6`: 19/22 legs green, soak 1803.8s. Red: `audit-subprocess-heavy-tests`,
`test_fast_budget` (3/3 runs) and `test_integration` (its pre-test audit). Two causes, both test-side; no product
defect. Measured 2026-10-03.

## Mechanism

1. **A missing-timeout spawn.** MREL-A1B (`3950554c`) added a test in `extension/tests/pipeline-runner.test.js` that runs
   `spawn(process.execPath, ['-e', 'setTimeout(()=>{},200)'], { stdio: 'ignore' })` with no `timeout:`. The
   missing-timeout census (`tests/pipeline-runner.test.js::spawn::6e64d8fca4`) reds the subprocess audit, the
   integration pre-test audit, and `tests/audit-subprocess-heavy-tests-missing-timeout.test.js` (AP-EXT-ITER42-01) in
   the fast tier.
2. **A stale abort-site census.** MREL-A2 (`287baba0`) deliberately removed the `closer_handoff_terminal` break from
   `runPhaseIteration` (operator-approved plan item A2). `extension/tests/nostop-gates-invariant.test.js` still pins
   `runPhaseIteration: 1` in the exact-map census and a total of 6, so the census reads 5 and both tests red.

## Fix

1. Add an explicit `timeout:` (≥ 30 000 ms, the audit's hang-guard floor) to that `spawn` call. Do not baseline it.
2. Re-pin the census to the measured map after A2: drop `runPhaseIteration` from the exact map, set the total to 5
   (still downward from the pre-ticket 8), and replace the "`runPhaseIteration` re-grew a second break" assertion with
   one that `runPhaseIteration` holds no break (`census.runPhaseIteration ?? 0` is 0). Update the docblock to name A2 as
   the removal. Re-measure with the census function before editing any number (the test's own instruction).

## Acceptance criteria (measured at `10bcb7d6`)

1. `cd extension && ./node_modules/.bin/tsc && node --test tests/audit-subprocess-heavy-tests-missing-timeout.test.js`
   → 0 failures (today: 1 of 34).
2. `cd extension && node --test --test-name-pattern="abort census|total moved DOWN" tests/nostop-gates-invariant.test.js`
   → 2 pass, 0 fail (today: 0 pass, 2 fail).
3. `cd extension && bash scripts/audit-subprocess-heavy-tests.sh` exits 0 (today: 1).
4. `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/eslint src/ --max-warnings=0` exit 0.

## Simplification Review

Two test corrections; no product change; no new gate, baseline entry or list member. The census shrinking is the
point of A2 — the pin follows the measurement.

## Non-goals

Any product source; any other test.

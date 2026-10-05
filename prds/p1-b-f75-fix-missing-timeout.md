# B-F75-FIX — two missing-timeout spawns from B-FIELD-75 left the gate red (`main`)

Gate `20261004T233053Z-80348` at `main@356ad44d`: 19/22, soak 1803.8s. Red: `audit-subprocess-heavy-tests`,
`test_fast_budget` (3/3 runs, one test: `tests/audit-subprocess-heavy-tests-missing-timeout.test.js:625`) and
`test_integration` (its pre-test audit). One cause: ticket f7500003 (`ba517afa`) added
`spawnSync('git', ['add', '.'], { cwd: workingDir })` and `spawnSync('git', ['commit', …], { cwd: workingDir })` to
`extension/tests/spawn-refinement-team-checker.test.js` with no `timeout:` (census id
`tests/spawn-refinement-team-checker.test.js::spawnSync::0be2a71c0b`). Test-only; same class as B-MREL-FIX. Measured
2026-10-05.

## Fix
Add `timeout: 30_000` to both calls. Do not baseline.

## Acceptance criteria (measured at `356ad44d`)
1. `cd extension && ./node_modules/.bin/tsc && node --test tests/audit-subprocess-heavy-tests-missing-timeout.test.js` → 0 failures (today: 1).
2. `cd extension && bash scripts/audit-subprocess-heavy-tests.sh` exits 0 (today: 1).
3. `cd extension && node --test tests/spawn-refinement-team-checker.test.js` → 0 failures.

## Simplification Review
Two option fields in a test; no product change.

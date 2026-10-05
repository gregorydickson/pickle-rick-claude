# B-F75-FIX2 — two load-sensitive git spawns from f7500002 left the gate red (`main`)

Gate `20261005T013050Z-62278` at `main@f479ff2c`: 20/22, soak 1803.8s, fast tier green. Red:
`audit-subprocess-heavy-tests` and `test_integration` (its pre-test audit), one finding:
`tests/pipeline-runner.test.js: load-sensitive subprocess spawn (… { timeout: 10000 })) missing from tests/.serial-tests.json`.
Cause: f7500002 (`ad5c592a`) added `execFileSync('git', ['add', '.'], { cwd: repo, timeout: 10_000 })` and
`execFileSync('git', ['commit', …], { cwd: repo, timeout: 10_000 })` to `extension/tests/pipeline-runner.test.js`. A
10 s timeout is in the audit's load-sensitive band, and moving the 323-test file to the serial manifest would slow the
whole fast tier. Measured 2026-10-05.

## Fix
Raise both timeouts to `30_000` (the hang-guard used elsewhere; above the load-sensitive band). Do not add the file to
the serial manifest. Test-only.

## Acceptance criteria (measured at `f479ff2c`)
1. `cd extension && bash scripts/audit-subprocess-heavy-tests.sh` exits 0 (today: 1).
2. `cd extension && ./node_modules/.bin/tsc && node --test --test-name-pattern="F75-RLWARN|F75-RLFAR" tests/pipeline-runner.test.js` → 0 failures, ≥ 1 named test.
3. `grep -c 'pipeline-runner.test.js' extension/tests/.serial-tests.json` returns 0 (today: 0; regression control — the fix must not serialize the file).

## Simplification Review
Two option values; no product change; no manifest growth.

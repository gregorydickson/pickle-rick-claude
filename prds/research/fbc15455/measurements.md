# Uncensored fast-tier test measurements — fbc15455 (WS-A0)

Method: temporarily raised each test's `spawnSync` bounding `timeout` (and the
shared `WORKER_TIMEOUT_MS` constant in `spawn-morty-worker-gate.test.js`) to
`600000`ms, ran each named test individually via
`node --test --test-name-pattern "<name>" <file>` (with `NODE_TEST_CONTEXT`,
`PICKLE_TICKET_ID`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`,
`GIT_CONFIG_COUNT` unset from the environment — `NODE_TEST_CONTEXT=child-v8`
leaking from this worker's own harness environment made `node:test` treat the
run as a recursive child and skip execution entirely; the trailer-hook vars
are stripped per the ticket's environment trap), from `extension/` as cwd.
Duration = wall-clock around the `node --test` invocation. Load average taken
via `uptime` immediately before each run. Scaffolding reverted after
measurement (`git diff HEAD` on both test files is empty).

Host: 24 logical cores (`sysctl -n hw.ncpu`). Ambient 1-min load average on
this host idles at ~13-20 even with no deliberately added load (other
processes on the shared host), so both conditions read above the nominal
"rest" baseline one might expect on a quiet single-user machine; the "loaded"
condition below was produced by launching 24 concurrent `yes > /dev/null`
processes to push the 1-min load average well past the ambient floor, giving
genuine rest-vs-loaded contrast (~15-20 vs ~32-40).

| Test | File | Condition | Load avg (1m) | Duration (ms) | result.status |
|---|---|---|---|---|---|
| spawn-morty: recovers orphan tmp backend state before routing worker CLI | tests/spawn-morty.test.js | rest | 20.63 | 38941 | pass (0) |
| spawn-morty: recovers orphan tmp backend state before routing worker CLI | tests/spawn-morty.test.js | loaded | 31.91 | 40350 | pass (0) |
| spawn-morty: recovers orphan tmp session timeout before printing worker budget | tests/spawn-morty.test.js | rest | 20.02 | 39788 | pass (0) |
| spawn-morty: recovers orphan tmp session timeout before printing worker budget | tests/spawn-morty.test.js | loaded | 35.35 | 41753 | pass (0) |
| spawn-morty.hermes: spawns hermes chat with toolsets and completes | tests/spawn-morty.test.js | rest | 19.91 | 26257 | pass (0) |
| spawn-morty.hermes: spawns hermes chat with toolsets and completes | tests/spawn-morty.test.js | loaded | 38.99 | 28326 | pass (0) |
| spawn-morty: test:fast failure with work evidence suppresses the Failed flip and preserves the commit | tests/spawn-morty-worker-gate.test.js | rest | 16.94 | 49104 | pass (0) |
| spawn-morty: test:fast failure with work evidence suppresses the Failed flip and preserves the commit | tests/spawn-morty-worker-gate.test.js | loaded | 39.23 | 51509 | pass (0) |
| spawn-morty: evidence-absent test:fast failure still marks ticket Failed and resets HEAD | tests/spawn-morty-worker-gate.test.js | rest | 15.07 | 42558 | pass (0) |
| spawn-morty: evidence-absent test:fast failure still marks ticket Failed and resets HEAD | tests/spawn-morty-worker-gate.test.js | loaded | 39.64 | 47120 | pass (0) |

## Notes

- All 10 rows are completions (`result.status` = 0 / pass), never a kill —
  every run finished well inside the 600000ms scaffolding cap; none was a
  censored/killed observation.
- Every one of the five tests actually completes, uncensored, in
  26-52 seconds even under host load averages of 32-40 — well under both the
  original per-test 45000ms `spawnSync` cap (for the three
  `spawn-morty.test.js` tests) and the shared 90000ms `WORKER_TIMEOUT_MS` (for
  the two `spawn-morty-worker-gate.test.js` tests). This is evidence the
  original kill was not a "true unloaded need exceeds the cap" case in these
  specific reruns — WS-A's cap derivation should treat these completion
  numbers as the load-bearing input per the ticket's stated invariant
  ("every recorded duration is a completion time, never a kill time"), and
  should widen the sample (more repeated runs, host contention conditions) if
  it wants to explain the originally observed `spawnSync`-killed
  `actual: null` results.

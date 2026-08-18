# BUG: the worker gate inherits the worker's pickle env, so the gate measures a tree that does not exist

- **Date**: 2026-08-15
- **Priority**: P1 (gate integrity)
- **Branch**: `release/v2.1-beta`
- **Measured at**: `c56e1cfb` (fast tier green: 7635 tests, 504 suites, fail 0, cancelled 0, 734742 ms)
- **Class**: false-red. The gate reports failures that do not exist in a clean checkout, and the manager
  then hands the worker a fabricated fix list.

## Problem

`runCommand` at `extension/src/bin/spawn-morty.ts:1322` spawns the gate with
`{ cwd, detached, stdio }` and **no `env` option**, so the gate child inherits the full pickle
environment of the worker that launched it. Two distinct variable families then leak into tests that
assert against compiled defaults or a clean git config.

**Family 1 — the gate-timeout variable.** `extension/src/services/pickle-utils.ts:167` defines
`WORKER_TEST_GATE_TIMEOUT_ENV_VAR = 'PICKLE_WORKER_TEST_FAST_TIMEOUT_MS'`, and
`resolveWorkerTestGateTimeoutMs` reads it at CALL time. Under the mux manager that variable is exported
(observed value `1800000`), so every test exercising the resolver asserts against the leaked value rather
than `DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS`. Measured in session `2026-08-14-0807d986` iteration 10 on one
unchanged tree: **8 failures with the variable present, 1 failure after `env -u`** — 7 of 8 were pure
contamination (`settings-loader` x2, `runWorkerGate`, `showStatus`, `mux-runner-between-ticket-gate` x2,
the `MANAGED_KEYS` force / `AC-SSAT-4` pin).

**Family 2 — the trailer-hook variables.** `PICKLE_TICKET_ID` and the `GIT_CONFIG_*` set (`GIT_CONFIG_GLOBAL`,
`GIT_CONFIG_SYSTEM`, `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0`, `GIT_CONFIG_VALUE_0`) are composed for the
worker's own commits by `backendEnvOverrides` (`extension/src/services/backend-spawn.ts:832`), which
deliberately composes `n+1` off an inherited `GIT_CONFIG_COUNT` (`extension/src/services/backend-spawn.ts:823`).
Four test files read `GIT_CONFIG_*` directly — `extension/tests/standup.test.js`,
`extension/tests/integration/gitattr-hook-forwarding.test.js`,
`extension/tests/integration/gitattr-trailer-producer.test.js`,
`extension/tests/services/backend-spawn-trailer-env.test.js` — and see the worker's live stamp instead of
the fixture they set up.

The two families are ONE defect at ONE seam: a spawn that inherits an environment it should not. Fixing
either alone leaves the manager still reading a false red.

## Why this is a reliability defect

A false red at the gate is worse than a missing gate. The manager treats the failure list as real, and the
next worker is dispatched to fix tests that were never broken — spending its budget on the environment
rather than on the ticket. Every downstream verdict inherits the error.

The operator workaround in use today is to prefix every manager-run measurement with
`env -u PICKLE_WORKER_TEST_FAST_TIMEOUT_MS -u PICKLE_TICKET_ID -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_SYSTEM
-u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0`. That is a human remembering a list, which
is exactly the kind of unwritten invariant this codebase has been burned by before.

## Solution

Scrub the pickle environment at the gate spawn, in `runCommand`. Pass an explicit `env` derived from
`process.env` with the pickle-owned keys removed. The removal list must be a single exported constant
next to `WORKER_TEST_GATE_TIMEOUT_ENV_VAR` in `extension/src/services/pickle-utils.ts`, so the set has ONE
definition and any future pickle variable is added in one place.

Reuse, do not duplicate: `backendEnvOverrides` already owns the knowledge of which variables pickle
composes for a spawn. The scrub list and the compose list must be derived from the same constant, so a
variable can never be composed by one and forgotten by the other.

Do NOT change what the worker itself inherits — the worker's commits legitimately need the trailer stamp.
Only the GATE child is scrubbed.

## Acceptance criteria

- **AC-1 — the gate child does not inherit pickle variables.** A test spawns the gate through
  `runCommand` with `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS`, `PICKLE_TICKET_ID`, and the `GIT_CONFIG_*` set
  present in the parent, and asserts none of them are visible to the child.
- **AC-2 — the resolver sees the compiled default under the gate.** With
  `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS=1800000` exported in the parent, a gate-spawned
  `resolveWorkerTestGateTimeoutMs` returns `DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS`, not 1800000.
- **AC-3 — the worker keeps its trailer stamp.** A test asserts the WORKER spawn still receives the
  `backendEnvOverrides` composition including `GIT_CONFIG_COUNT` at `n+1`. This AC fails if the scrub is
  applied too broadly.
- **AC-4 — one definition of the scrubbed set.** `grep` finds exactly one array/set literal enumerating
  the pickle env keys. A test asserts the scrub list and the compose list are derived from the same
  constant, so adding a variable to one necessarily adds it to the other.
- **AC-5 — the 7 contaminated tests pass under a contaminated parent.** The named failures
  (`settings-loader` x2, `runWorkerGate`, `showStatus`, `mux-runner-between-ticket-gate` x2, the
  `MANAGED_KEYS` force / `AC-SSAT-4` pin) pass with the variables exported in the parent environment.
  This is the regression oracle: it must go RED if the scrub is removed.
- **AC-6 — tier green.** `npm run test:fast` reports `fail 0` AND `cancelled 0`, measured with
  `PICKLE_TEST_RUNNER_TIMEOUT_MS=7200000` and a clean environment. `cancelled > 0` is inconclusive:
  re-run, never report as pass. Test count must not shrink below 7635.
- **AC-7 — no new terminal condition and no new operator surface.** No new `exit_reason`, no new abort
  site, no new setting key, no new flag. `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` remains a working operator
  override for the gate's own timeout — the scrub removes it from the CHILD's view, not from the
  resolver's contract in the parent.

## Out of scope

The orphaned gate shims (`R-WGTORPH`) and the concurrent-worker lock (shipped, `e4df9cce`). Both touch the
same test file; neither is this bug.

## Simplification Review

1. **What can be subtracted instead of added?** The implicit inheritance is the thing being subtracted.
   The gate currently passes NO `env`, which reads as "no configuration" but is actually "inherit
   everything" — the most permissive option, chosen by omission. Naming the environment explicitly is a
   reduction in what crosses the boundary.
2. **Does this add a new abort condition?** No — AC-7 forbids it. A scrubbed variable changes a value, it
   never halts a run.
3. **Does this add a new configuration surface?** No — AC-7 forbids it. The scrub list is a compiled
   constant, not a setting.
4. **Is a fix at this seam load-bearing for anything else?** Yes. Every gate verdict, every
   `cross_ticket_regression_detected` attribution, and every manager-authored fix list depends on the gate
   measuring the tree rather than the environment. This is upstream of the whole verdict chain.

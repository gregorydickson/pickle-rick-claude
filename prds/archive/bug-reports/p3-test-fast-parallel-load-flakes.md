---
title: P3 — `npm run test:fast` parallel-load flakes — 4 specific tests pass in isolation but fail under `--test-concurrency=8` against the full 4500-test suite (R-TFP)
status: Superseded by prds/archive/bundles/p2-test-fast-stability-gate-widening-2026-05-19.md
filed: 2026-05-13
priority: P3 (no production code regression — symptom is intermittent CI noise; release gate currently passes serially but flakes under operator-driven concurrent runs)
type: bug
r_codes:
  - R-TFP-1
  - R-TFP-2
  - R-TFP-3
  - R-TFP-4
  - R-TFP-5
related:
  - prds/archive/bundles/p1-bug-fix-bundle-2026-05-11-remediation-53-failures.md   # bundle-14 — broader remediation queue. R-TFP could fold in if it stays open at bundle time; or ship standalone if smaller.
---

# P3 — `test:fast` parallel-load flakes on 4 specific tests

## Problem (one paragraph)

Four tests in the `extension/tests/` suite pass reliably in isolation (`node --test <file>`) but flake intermittently when run under heavy parallel load — specifically `node --test --test-concurrency=8` against the full ~4500-test suite (the `npm run test:fast` configuration after the fork-bomb cap from `cbce383a`). The four offenders are an auto-resume integration test that uses a real 5-retry sleep loop, three `ensure-monitor-window` tests that race fake-tmux `spawnSync` timeouts, a `mux-runner-relaunch` test that races `observed-state.log` creation, and a `council-publish` test whose 15-second timeout assertion races slow Node ESM cold-start under load. All four are real test-isolation gaps, not production bugs — the symptom is CI flakiness and operator confusion when the gate flickers between green and red across re-runs.

## Observed incidents (the four flaky tests)

### Flake 1 — `tests/auto-resume-stop-conditions.test.js`

**Failing case**: `prints [warn] banner past retry 3` (subtest of `auto-resume integration`).

**Failure mode**: the test invokes the real `auto-resume.sh` script which contains a 5-retry sleep loop (`sleep 6` between retries; total ≥ 30s wall-clock). Under heavy parallel load, the surrounding Node test harness's per-subtest deadline (currently default 10s for the `extension/tests/` config) gets blown. In isolation the deadline is generous enough; under 8-wide parallelism the test runner's clock pressure compounds.

**Why it passes in isolation**: no contention; the 30s wall-clock completes well within the per-file deadline.

**Why it flakes under load**: `node --test` allocates wall-clock budget per test, and other parallel tests slow down `sh` invocations through the kernel scheduler. The sleep loop becomes the limiting factor.

### Flake 2 — `tests/ensure-monitor-window.test.js` (3 subtests)

**Failing cases**:

1. `kills and recreates when existing window has different @mode`
2. `phase re-entry performs a fresh recovery sweep with mode-specific pane 2`
3. `explicit mode overrides state-inferred mode`

**Failure mode**: all three subtests stub `spawnSync` with a fake tmux that synthesizes responses. The fake-tmux has a 5-second internal timeout for synthetic operations. Under parallel load, the synthetic dispatcher takes longer to schedule and 5s is no longer enough — the synthetic call returns ETIMEDOUT and the test's mode-detection assertion fails.

**Why it passes in isolation**: synthetic dispatch completes in < 100ms; 5s is comfortably enough.

**Why it flakes under load**: macOS scheduler under 8 concurrent node processes can stall a synchronous IPC call for ~1-3s; one synthetic chain of 4 fake-tmux operations runs the 5s budget down to zero.

### Flake 3 — `tests/mux-runner-relaunch.test.js`

**Failing case**: `mux-runner relaunch claims ownership before monitor recovery sees session state`.

**Failure mode**: the test launches a mock mux-runner subprocess and then asserts that `observed-state.log` exists at a specific path within a few hundred milliseconds. Under load, the subprocess's filesystem flush is delayed and the test reads the path before `observed-state.log` is created — `ENOENT`.

**Why it passes in isolation**: the subprocess writes within 50-100ms of spawn; the test's read happens at 500ms; comfortable margin.

**Why it flakes under load**: subprocess spawn under 8-way parallelism can take 500-1500ms to first-write; the test's 500ms-after-spawn read misses the file.

### Flake 4 — `tests/council-publish.test.js`

**Failing case**: `publishCouncilStack: hung gh pr comment is aborted by timeout`.

**Failure mode**: the test asserts that a hung `gh pr comment` invocation is killed by a 15-second internal timeout in `publishCouncilStack`. Agent `a6724db7` already POSIX-shell-mocked the `gh` binary to deterministically hang. Under parallel load, the test's wall-clock measurement of "did the abort fire within 15s ± slack?" races slow Node ESM cold-start — the timer's "started" tick lags behind the wall-clock the test uses as reference.

**Why it passes in isolation**: ESM cold-start is fast (~150ms); 15s + slack is comfortable.

**Why it flakes under load**: ESM module-resolution under contention can take 2-4s for cold imports; the timer "starts" 2-4s after the wall-clock the test believed; the 15s timeout fires at wall-clock 17-19s, missing the assertion's `<=15.5s` window.

## Why this matters

- Release gate flickers between green and red across re-runs; operator confidence in `npm run test:fast` erodes.
- Bundle close pipelines that include a release-gate phase intermittently fail-loud on these 4 tests even when production code is fine. Operators learn to "just re-run" — bad culture, hides real flakes.
- Two of the four (Flakes 2 + 4) interact with fake-binary mocks: if the mock pattern is wrong here, the same pattern wrong elsewhere is masking other issues.

## Source surface

**Files to touch**:

- `extension/tests/auto-resume-stop-conditions.test.js` + `extension/bin/auto-resume.sh` — make sleep interval test-overridable.
- `extension/tests/ensure-monitor-window.test.js` — bump fake-tmux synthetic timeout from 5s → 15s, OR move tests into a serial execution group.
- `extension/tests/mux-runner-relaunch.test.js` — replace fixed `setTimeout(500)` with poll-until-exists pattern bounded by 5s.
- `extension/tests/council-publish.test.js` — measure elapsed via `process.hrtime.bigint()` deltas captured *inside* the SUT, not against `Date.now()` from the test's harness clock.
- `extension/scripts/audit-test-isolation.sh` — add a sub-check that flags any test that uses fixed-wall-clock assertions ≤ 15s without a comment justifying the budget.

## Atomic tickets — R-TFP family ("test:fast parallel-load")

### R-TFP-1 — Forensic write-up of root causes (3-5 sentences each per flake)

- Capture for each of the four tests: name, file path, failure signature, why it passes in isolation, why it flakes under load, recommended fix shape.
- Output: a markdown section in `prds/archive/bug-reports/p3-test-fast-parallel-load-flakes.md` (this PRD) under "## Forensic notes" — to be filled in during ticket execution; will replace the speculative analysis above with exact log evidence.
- File: this PRD's "Forensic notes" section (append).
- Worker reproduces each flake by running `npm run test:fast` 5 times in succession and capturing the first failure trace per flaky test.

### R-TFP-2 — Harden auto-resume integration test

- Choice of three mechanisms (worker picks lowest-risk):
  - **Option A**: Add `PICKLE_AUTO_RESUME_TEST_INTERVAL_MS` env var read by `auto-resume.sh`. Default 6000. Test overrides to 10. ~5 LOC in shell + 2 LOC in test.
  - **Option B**: Use `node:test`'s fake timers via `t.mock.timers.enable(['setTimeout'])` then advance manually. Only works if the sleep loop is in JS, not shell — verify before committing to this path.
  - **Option C**: Quarantine the test to `npm run test:integration` (slower, less parallelism), out of the `test:fast` gate.
- Prefer Option A — smallest change, preserves the actual code path under test.
- File: `extension/bin/auto-resume.sh` + `extension/tests/auto-resume-stop-conditions.test.js`. ~30 LOC.

### R-TFP-3 — Harden `ensure-monitor-window` tests

- Bump fake-tmux's internal `spawnSync` synthetic timeout from 5s → 15s. The fake's value is a test-only constant — bumping it gives parallel-load slack without changing production behavior.
- OR: mark the 3 subtests as serial via `test.describe.serial` (Node 22+) so they don't compete with siblings.
- File: `extension/tests/ensure-monitor-window.test.js` + the shared fake-tmux helper. ~15 LOC.

### R-TFP-4 — Fix `mux-runner-relaunch` ENOENT race

- Replace any fixed `setTimeout(500)` in the test with a poll-until-exists pattern:
  - `await waitForFile(observedStateLogPath, { maxWaitMs: 5000, pollIntervalMs: 50 });`
  - Helper goes in `extension/tests/helpers/wait-for-file.js` (or use existing helper if one exists — verify).
- Also: investigate whether the SUT (mux-runner) should `fsync` observed-state.log on first write to make the file visible to readers earlier. If yes, file as R-TFP-4b sub-ticket.
- File: `extension/tests/mux-runner-relaunch.test.js` + helper. ~30 LOC.

### R-TFP-5 — Trap-door pin for parallel-load test-isolation

- INVARIANT: any test in `extension/tests/` that uses a wall-clock deadline ≤ 15s for assertion correctness MUST either (a) use `process.hrtime.bigint()` to measure elapsed time *inside the SUT* rather than against the test harness clock, OR (b) carry a comment justifying the budget vs `--test-concurrency=8` parallel load, OR (c) be marked serial via `test.describe.serial`. Fixed wall-clock budgets ≤ 15s without one of those guards are forbidden.
- INVARIANT: any test that spawns a subprocess and then asserts on a file the subprocess writes MUST use a poll-until-exists helper bounded by ≥ 5s, NOT a fixed `setTimeout`.
- ENFORCE: `extension/scripts/audit-test-isolation.sh` grows two greps:
  1. `grep -rE "setTimeout\([0-9]{3,4}[^0-9]" extension/tests/` flags fixed timeouts in tests.
  2. `grep -rE "\\* 1000.*Date\\.now\\(\\)" extension/tests/` flags wall-clock arithmetic that ignores the SUT's clock.
- File: `extension/scripts/audit-test-isolation.sh` + `extension/src/services/CLAUDE.md` (or `extension/tests/CLAUDE.md` — create if missing).

## Estimated scope

- R-TFP-1..5 total: ~200 LOC across four test files + one shell script + one audit script + one trap-door pin.
- Half-day to full-day single PR.
- Net: `npm run test:fast` becomes deterministic under `--test-concurrency=8` against the full 4500-test suite. Release gate stops flickering.

## Reproduction (deterministic)

1. `cd extension && npm run test:fast` — observe occasional failures in the four named tests.
2. `cd extension && node --test tests/auto-resume-stop-conditions.test.js` — passes 100% in isolation.
3. `cd extension && for i in 1 2 3 4 5; do npm run test:fast 2>&1 | grep -E "(FAIL|fail).*\.test\.js" | sort -u; done` — flakes appear in roughly 1-3 of the 5 runs across the named four.

## Forensic notes (filled in during R-TFP-1 execution)

*To be populated when R-TFP-1 runs — capture exact failure traces, timing data, parallel-load scheduling evidence.*

## Cross-references

- **`cbce383a`** — capped `--test-concurrency=8`. Without this cap the suite forks-bombs at 8+ cores. R-TFP confronts what's left after the cap.
- **bundle-14 R-REM** (`prds/archive/bundles/p1-bug-fix-bundle-2026-05-11-remediation-53-failures.md`) — broader remediation queue. R-TFP could fold into it if scheduling aligns, or ship standalone.
- **Agent `a6724db7`** — POSIX-shell-mocked the `gh` binary in `council-publish.test.js`. The mock is correct; the test's wall-clock assertion still races slow ESM cold-start. R-TFP-4 doesn't touch the mock; it touches the timing assertion.

## Notes

- These four tests are the **known** flakes. R-TFP-1's forensic pass may surface more — if so, extend the family with R-TFP-6+ rather than stuffing additional fixes into the existing tickets.
- The `audit-test-isolation.sh` grep in R-TFP-5 is conservative — false positives are acceptable (worker adds a justifying comment to silence them); false negatives are not.
- Long-term: consider migrating high-flake tests to a separate `test:isolation` tier that runs serially. Status quo of `test:fast` doing 4500 tests at concurrency-8 is fast but fragile.

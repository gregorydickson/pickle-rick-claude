---
title: P1 — R-MMTR-6 E2E ticket too large; decompose into 4-5 sub-tickets
status: Draft
filed: 2026-05-13
priority: P1
type: refactor
r_code_prefix: R-MMTR6S
backend_constraint: any
related:
  - prds/archive/bug-reports/p1-mux-runner-no-claude-manager-relaunch-on-max-turns.md
  - prds/archive/bug-reports/p2-worker-manager-wedge-oversized-ticket-no-artifact-progress.md  # R-WMW — generalized bug class; this PRD is the concrete fd1fff6c decomposition for the R-MMTR-6 instance
  - prds/archive/bug-reports/p2-pickle-refine-section-umbrella-granularity-bug.md  # R-RSU — root-cause companion (refinement-time sizing fix)
---

# P1 — R-MMTR-6 must be split before re-attempt

## Incident

Session `2026-05-13-c122b0f7` ticket `fd1fff6c` (R-MMTR-6: "E2E regression — 20-ticket session auto-recovers via max-turns relaunch") burned 8 worker subprocesses across 14 iterations (~80 minutes), generated ~4MB of output, landed 0 commits, hit the false-EPIC counter twice, and was operator-force-skipped at 21:35Z to save the remaining 52 tickets of the bundle from the R-ICP-3 watcher halt.

Root cause: refinement team produced a single E2E ticket whose implementation requires (a) building a 20-ticket synthetic session fixture, (b) building a test harness that exercises mux-runner end-to-end with max-turns relaunch, (c) wiring assertions over multi-iteration manager state, (d) wiring CI. That is ~500 LOC across multiple files, exceeding single-worker iteration budget (40min / ~150K tokens).

The worker can do research and plan within budget (both artifacts landed), but cannot finish implementation in one iteration; resumed iterations cannot re-load the partial context fast enough; each false-EPIC strike on the resumed worker contributes to watcher halt.

## Solution

Decompose into the following sub-tickets, each independently testable within single-worker budget:

- **R-MMTR-6A** (~80 LOC): Build the 20-ticket synthetic session fixture under `extension/tests/fixtures/mmtr6-synthetic-session/` with deterministic ticket hashes, frontmatter, and a `session_state.json` template. No mux-runner invocation; just data.
- **R-MMTR-6B** (~120 LOC): Build the test harness `extension/tests/integration/mmtr6-harness.ts` exporting `runMaxTurnsRelaunchE2E({ sessionFixture, expectedRelaunchCount, expectedDoneCount })`. Stubs `claude` CLI via fixture replay. No assertions yet, just orchestration.
- **R-MMTR-6C** (~150 LOC): Wire the E2E test cases in `extension/tests/integration/max-turns-relaunch-e2e.test.js` calling the harness with 3 scenarios: (a) clean max-turns relaunch, (b) consecutive relaunches up to cap, (c) cap-exceeded halt. Each scenario asserts on `state.json` activity events and final ticket distribution.
- **R-MMTR-6D** (~50 LOC): Wire CI gate — register the new integration test in `audit-test-tiers.sh`, the test-registration-hygiene allowlist, and `npm run test:integration` discovery.

Dependencies: 6A → 6B → 6C; 6D depends on 6C. Each sub-ticket size fits a single worker iteration with budget headroom.

## Acceptance Criteria

- **AC-1:** Refinement team's `spawn-refinement-team.ts` produces R-MMTR-6A through R-MMTR-6D as separate tickets when invoked on `prds/archive/bug-reports/p1-mux-runner-no-claude-manager-relaunch-on-max-turns.md`; original R-MMTR-6 hash `fd1fff6c` is retired.
- **AC-2:** Each sub-ticket's `## Implementation Details` cites a single primary file with ~50-150 LOC estimate.
- **AC-3:** Each sub-ticket's worker_session log on completion is < 800K (vs the observed 1.5M for the merged R-MMTR-6).
- **AC-4:** A test bundle with just R-MMTR-6A through R-MMTR-6D completes within 40 minutes of wall-clock under codex backend.

## Out of Scope

- Modifying the refinement-team's ticket-sizing heuristic itself (separate PRD: R-TSH for "refinement team ticket sizing heuristic").
- Other E2E tickets in the parent PRD (none observed; R-MMTR-1 through R-MMTR-5 sized correctly).

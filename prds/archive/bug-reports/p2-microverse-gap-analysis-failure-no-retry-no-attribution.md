---
title: P2 — microverse gap-analysis entry path swallows subprocess error with no attribution, no retry — single failure kills the entire anatomy-park / szechuan-sauce iteration loop
status: Draft
filed: 2026-05-13
priority: P2
type: bug
finding: 30
r_codes:
  - R-MGAR-1
  - R-MGAR-2
  - R-MGAR-3
  - R-MGAR-4
  - R-MGAR-5
related:
  - prds/p1-anatomy-park-worker-mode-subprocess-error-kills-loop.md   # R-APMW — sibling, worker subprocess errors at iteration body
  - prds/archive/bug-reports/p1-mux-runner-no-claude-manager-relaunch-on-max-turns.md     # R-MMTR — provides evaluateManagerRelaunch this PRD wires
  - prds/archive/bug-reports/p1-microverse-baseline-llm-exhaustion-collapses-transient-into-fatal.md  # R-MBLE — same misclassification family, baseline stage
  - prds/archive/bug-reports/p1-microverse-judge-probe-misclassifies-timeout-as-cli-missing.md         # R-MJCP — same family, probe stage (shipped)
  - prds/archive/bug-reports/p1-pipeline-runner-aborts-on-judge-timeout-no-finalize-gate.md             # R-PRJT — same file, orchestrator-side
---

# PRD — microverse gap-analysis swallows subprocess error with no recovery (R-MGAR)

**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Discovered**: 2026-05-13 during LOA-775 Phase-2 compound-conditions pipeline (loanlight-api session `2026-05-12-6c4a18d8`, backend codex, started 2026-05-12T20:11Z, paused by power outage, resumed 2026-05-13).

## Problem (one paragraph)

`extension/src/bin/microverse-runner.ts:2143-2157` (gap-analysis entry path) throws on `outcome.completion === 'error'` with no error attribution (logs only the bare completion string, discards `outcome.error / exitCode / signal / timedOut`), no retry, no manager-relaunch escape hatch. A single subprocess error at the gap-analysis stage kills the entire anatomy-park / szechuan-sauce iteration loop. Sister to #16 R-PRJT (same file, orchestrator side), #19 R-MMTR (manager-relaunch missing for claude), #23 R-APMW (worker subprocess error at iteration body), #26 R-MBLE (aggregator collapse at baseline stage), #13 R-MJCP (probe-stage misclassification, shipped). Same anti-pattern at a 6th surface in `microverse-runner.ts`.

## Observed incident

**Session**: `~/.local/share/pickle-rick/sessions/2026-05-12-6c4a18d8/` (loanlight-api LOA-775 Phase 2, backend codex). Pickle phase shipped all 19 tickets cleanly (20 commits, 219m43s) → exit code 0. Anatomy-park entered gap-analysis at iter 1, bailed at 7m59s. Szechuan-sauce entered gap-analysis at iter 1, bailed at 16m4s. Both produced a 6585-byte `gap_analysis.md` + 1 DRY commit (`5c513bd77`) before bailing.

**Compounding effect via R-PHC continue-on-fail**: `pipeline-status.json` shows `"completed", completed_phases: 4` so the operator sees "Pipeline finished: 4/4" while 2/4 phases produced **zero** iteration-loop work. The failure is invisible at the orchestrator level — R-PHC correctly continues despite the abort (per its spec), but the abort itself was unnecessary.

## Solution (R-MGAR-1..5)

- **R-MGAR-1**: Structured error capture at gap-analysis entry. Log `outcome.error`, `exitCode`, `signal`, `timedOut`, `stallReason` (NOT just `completion`). Emit `microverse_gap_analysis_subprocess_error` activity event with full attribution payload.
- **R-MGAR-2**: 3-attempt backoff retry (10s / 30s / 60s) for transient errors (ETIMEDOUT, ECONNRESET, ENOTFOUND). Permanent errors (ENOENT, EACCES, schema-invalid) skip retry and propagate immediately.
- **R-MGAR-3**: Wire `evaluateManagerRelaunch` (from R-MMTR-2) into the gap-analysis subprocess path. Claude manager hitting `--max-turns` at gap-analysis must relaunch the same way it does at the iteration body — bounded by `Defaults.MANAGER_RELAUNCH_CAP`.
- **R-MGAR-4**: Regression test in `extension/tests/integration/microverse-gap-analysis-recovery.test.js` — 3 fixtures: (a) 3×ETIMEDOUT at gap-analysis → 3 retries → success on attempt 3; (b) ENOENT at gap-analysis → immediate fail with `cli_missing`; (c) max-turns at gap-analysis → relaunch via `evaluateManagerRelaunch`.
- **R-MGAR-5**: Trap-door pin in `extension/src/bin/CLAUDE.md` — gap-analysis subprocess errors must go through `handleGapAnalysisSubprocessError` (the new R-MGAR-1..3 entrypoint), not the bare `throw new Error(\`gap-analysis failed: ${completion}\`)` pattern.

## Atomic decomposition

| # | R-code | Scope | LOC est. |
|---|---|---|---|
| 1 | R-MGAR-1 | Structured error capture + activity event | ~50 |
| 2 | R-MGAR-2 | 3-attempt retry with transient/permanent classifier | ~80 |
| 3 | R-MGAR-3 | Wire evaluateManagerRelaunch at gap-analysis | ~40 |
| 4 | R-MGAR-4 | Regression test (3 fixtures) | ~120 |
| 5 | R-MGAR-5 | Trap-door pin | ~20 |

**Total**: ~310 LOC, atomic single-file source surface (`microverse-runner.ts`) + one new test.

## Bundle relationship

Ships cleanly with **R-MBLE** + **R-PRJT** — same file, same misclassification family, single closing-loop ship. Bundle order: R-MGAR-3 depends on R-MMTR-2 (`evaluateManagerRelaunch`) being available, so the HCC-COORD-1 bundle (R-ICDM + R-MMTR) must land first or in the same bundle ahead of R-MGAR.

## Acceptance criteria

- AC-R-MGAR-01: `microverse-runner.ts` gap-analysis entry logs structured error payload (NOT bare completion string) on every subprocess error.
- AC-R-MGAR-02: ETIMEDOUT at gap-analysis triggers exactly 3 retries with 10s/30s/60s backoff before failure propagation.
- AC-R-MGAR-03: ENOENT at gap-analysis fails immediately (no retry); error reason set to `cli_missing`.
- AC-R-MGAR-04: claude manager `--max-turns` exhaustion at gap-analysis invokes `evaluateManagerRelaunch` and relaunches up to `MANAGER_RELAUNCH_CAP`.
- AC-R-MGAR-05: `microverse_gap_analysis_subprocess_error` activity event registered in `VALID_ACTIVITY_EVENTS` with full schema entry; `--gate-payload` CLI parity per the iter-9 trap-door pattern.
- AC-R-MGAR-06: Regression test asserts all three retry/relaunch paths cleanly.
- AC-R-MGAR-07: Trap-door entry at `extension/src/bin/CLAUDE.md` pinning the new error-handling invariant; `audit-trap-door-enforcement.sh` finds the ENFORCE ref.

## Entry conditions

- HCC-COORD-1 bundle (R-ICDM-1 helper repair + R-MMTR-2 `evaluateManagerRelaunch`) MUST be implemented before or alongside R-MGAR-3.
- R-MBLE-1 and R-PRJT-1 are sister fixes at adjacent layers of the same file — order them in the same closing-loop ship.

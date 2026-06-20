---
title: Mega bundle 2026-05-13 — claude-backend hardening + microverse exit-reason family + R-APMW completion + concurrent-session forensics Phase 1 + observability quality
status: Draft
filed: 2026-05-13
priority: P1
type: bundle
backend_constraint: claude (post-codex-quota-exhaustion default)
scope: |
  Claude-backend pipeline reliability + microverse subprocess-error handling
  family + anatomy-park worker-mode completion + concurrent-session
  destructive-command forensics + monitor observability hardening + citadel
  conformance core wiring. Closes all P1/P2/P3 open findings (#13 partial,
  #14, #15, #16, #19, #23 partial, #25 Phase 1, #26, #28, #29 ×2 — see
  prds/MASTER_PLAN.md Open Findings list).

composes:
  # ===== Tier A — claude-backend reliability =====
  # R-ICDM (Finding #28, P1) SHIPPED 2026-05-13 in commit c23ab353 — closes the
  # iteration-classifier site; HCC-COORD-1 signature freeze precondition met.
  # `prds/archive/bug-reports/p1-claude-iteration-classifier-detectmaxturns-misuse.md` retained for history.
  - prds/archive/bug-reports/p1-mux-runner-no-claude-manager-relaunch-on-max-turns.md      # R-MMTR-1..7 (Finding #19, P1) — wires R-ICDM-1 helper at manager-relaunch site
  # ===== Tier B — microverse exit-reason family (same-file bundle) =====
  - prds/archive/bug-reports/p1-microverse-baseline-llm-exhaustion-collapses-transient-into-fatal.md   # R-MBLE-1..7 (Finding #26, P1)
  - prds/archive/bug-reports/p1-pipeline-runner-aborts-on-judge-timeout-no-finalize-gate.md             # R-PRJT-1..7 (Finding #16, P1)
  - prds/archive/bug-reports/p2-microverse-gap-analysis-failure-no-retry-no-attribution.md              # R-MGAR-1..5 (Finding #30, P2)
  # ===== Tier C — R-APMW completion (carry-over from prior mega) =====
  - prds/p1-anatomy-park-worker-mode-subprocess-error-kills-loop.md    # R-APMW-5..9 (Finding #23, P1) — 4/9 already in HEAD
  # ===== Tier D — concurrent-session forensics =====
  - prds/archive/bug-reports/p1-concurrent-claude-session-interference-with-running-pipelines.md  # R-CSI-1..6 Phase 1 only (Finding #25, P1)
  # ===== Tier E — citadel + observability quality =====
  - prds/p2-citadel-conformance-core-not-wired-or-silently-skipped.md  # R-CCNW-1..8 (Finding #14, P2)
  - prds/archive/bug-reports/p3-monitor-watcher-collapsed-layout-repair-gap.md             # R-MWCL-1..7 (Finding #29, P3 amplifier)
  - prds/p3-monitor-dashboard-stale-after-pickle-to-anatomy-park-transition.md  # R-MDS-1..8 (Finding #15, P3)
---

# Mega bundle 2026-05-13 — claude-backend hardening + microverse exit-reason family + anatomy-park completion + concurrent-session forensics + observability

## Why this bundle, why now

Three concrete incidents in the last 48 hours each surfaced an open finding that is blocking real work:

1. **Session `2026-05-13-e58dcc1d`** (loanlight-api anatomy-park R7, claude backend after codex weekly-quota exhaustion) — died at iteration 1 because of R-ICDM. **Every claude-backend microverse phase is currently broken.**
2. **Session `2026-05-12-6c4a18d8`** (loanlight-api LOA-775 Phase 2, codex backend) — pickle phase shipped 19/19 cleanly, but anatomy-park + szechuan-sauce both bailed at gap-analysis (R-MGAR) producing 0 iteration-loop work despite a 6585-byte `gap_analysis.md` per phase.
3. **Session `2026-05-13-db129229`** (loanlight-api szechuan R2) — monitor 4-pane window collapsed to 2 within 30 seconds (R-MWCL) — operator has no live visibility into the running pipeline.

The cluster of bugs is not random. **The microverse-runner.ts subprocess-error handling pattern is broken at five separate sites** (probe, baseline, iteration body, gap-analysis, manager-relaunch) — the bundle treats them as a coherent surface.

## Bundle order (mandatory)

**R-ICDM-1 (helper repair) shipped 2026-05-13 in commit c23ab353** — the HCC-COORD-1 signature freeze precondition is now met. `detectManagerMaxTurnsExit(outcome, logFile, maxTurns)` now correctly returns `num_turns >= maxTurns`, not the bare success-shape signature.

Remaining order:
- **R-MMTR-3** can now wire the (fixed) helper at the manager-relaunch site safely.
- **R-MGAR-3** (gap-analysis manager-relaunch) inherits the fixed predicate via R-MMTR-2's `evaluateManagerRelaunch` wrapper.
- R-MBLE-1, R-PRJT-1, R-MGAR-1..2 can ship in parallel (same file, independent code paths).

R-APMW completion is independent of the HCC-COORD-1 family — can ship anywhere in the bundle.

R-CSI Phase 1 (forensics-only — destructive-command catalog + audit-log shim + retro-attribution) is **read-only** (no runtime changes); ships safely in parallel with everything else.

R-MWCL + R-MDS bundle together (shared `pickle-utils.ts` surface) — R-MWCL-1 (mode inference fix) is a precondition for R-MDS-3 (hot-swap) to fire on fresh-mismatch sessions.

R-CCNW (citadel conformance wiring) is independent.

## Acceptance criteria (bundle-level, on top of per-PRD ACs)

- **AC-BUNDLE-01** (HCC-COORD-1 freeze): SHIPPED in c23ab353 — `detectManagerMaxTurnsExit` returns `true` ONLY when `num_turns >= maxTurns`. Regression test at `extension/tests/integration/mux-runner-claude-iteration-classifier.test.js` (9/9 green) asserts: (a) over-budget → true, (b) num_turns null → false (conservative), (c) maxTurns null → false, (d) timedOut → false, (e) non-zero exit → false, plus codex prompt-echo discrimination preserved.
- **AC-BUNDLE-02** (claude-backend microverse runs end-to-end): a smoke session `microverse-runner --backend claude` on a fixture project completes iter 1 without `error` reclassification, completes the metric measurement, and continues to iter 2.
- **AC-BUNDLE-03** (gap-analysis recovers ETIMEDOUT): 3×ETIMEDOUT at gap-analysis stage triggers 3 retries before propagating failure (R-MGAR-2).
- **AC-BUNDLE-04** (R-APMW closure): all 9 R-APMW tickets present in HEAD with their trap doors enforced by `audit-trap-door-enforcement.sh`.
- **AC-BUNDLE-05** (R-CSI Phase 1 forensics): `extension/docs/destructive-commands-catalog.md` exists; `extension/bin/pr-audit-cmd.sh` PATH-shim exists and writes to `~/.claude/audit/destructive-commands.log` when `PR_AUDIT_DESTRUCTIVE_CMDS=1`. Retro-attribution covers three known prior incidents (R-CSI-3).
- **AC-BUNDLE-06** (monitor stays alive on fresh non-pickle session): a `microverse-runner --backend claude --template szechuan-sauce.md` launch leaves the 4-pane monitor alive past iter 1 (R-MWCL-1..5).
- **AC-BUNDLE-07** (citadel conformance core wired): `citadel-runner` against this bundle's PRD surfaces non-empty findings for T3 AC-coverage / T4 allowlist-dead / T6 trap-door-coverage / T8 state-machine sections (R-CCNW-2).
- **AC-BUNDLE-08** (no regression): full `npm run test:fast` passes (≤1 flake tolerance for `auto-resume-stop-conditions` parallel-load timeout); `npx tsc --noEmit` clean; `npx eslint src/ --max-warnings=-1` clean.
- **AC-BUNDLE-09** (deploy verified): `bash install.sh` exits 0; md5-parity gate passes for the 5 most-trafficked compiled files.

## Disposition table (for refinement-time exemptions)

This bundle does NOT introduce new disposition exemptions. The forward-create paths in the composed PRDs use the canonical R-RTRC-7 annotations and the readiness allowlist; the spawn-refinement-team gates from R-SAOV (shipped) handle them.

## Out of scope / explicit non-goals

- **R-CSI Phase 2** (`session.lock` + destructive-guard prevention) — Phase 1 forensics validates the attribution model; Phase 2 ships separately after a week of audit-log data.
- **R-CMR Council** rework — Draft design doc, not a bug; explicitly deferred.
- **R-CPPM** — Citadel state.prd_path fix — PRD file was deleted in the 2026-05-13 reshuffle; needs to be re-filed before inclusion. Add to next bundle.
- **Bundle closer / install / release gate / version bump** — handled by the bundle template's closer tickets, not in scope of these source PRDs.

## Pre-flight checklist

- [x] Working tree clean (verified at 2026-05-13 post `d928b76b`)
- [x] All composed PRDs present on disk (R-MGAR re-filed in this commit)
- [x] Test gate baseline ≤ 1 flake (from 80 baseline failures, drained by the 7-agent test-fix team)
- [ ] Concurrent session `2026-05-13-1722e22c` (loanlight-api LOA-775) should be cancelled OR moved to a separate worktree before bundle launch — it has been silently `git stash`ing this repo's working tree (already documented in MASTER_PLAN line 3 as a known interference). Bundle workers will repeatedly lose their commits otherwise.
- [ ] HCC-COORD-1 dependency graph respected at refinement time — R-ICDM-1 ticket ordered before R-MMTR-3 and R-MGAR-3.
- [ ] R-CSI Phase 1 ordered early so its audit log catches any further interference incidents during this bundle's own runtime.

## Risk

- **Bundle size**: ~50-80 atomic tickets across 10 source PRDs. Comparable to the 2026-05-12 mega bundle (which hit a power outage mid-run). Mitigate via the now-shipped R-PHC (continue-on-phase-fail) and R-PTG (per-ticket worker test gate) — both live in v1.74.0 deployed code.
- **`microverse-runner.ts` is hot**: Tier B and R-APMW touch the same file. Refinement should order them to minimize merge conflict surface.
- **Concurrent session interference**: `1722e22c` will keep stashing if not cancelled first.

## Success definition

Bundle ships when all 10 composed PRDs are Done OR Skipped (with reason). Closer commits `v1.75.0` source bump, runs full release gate, `bash install.sh --closer-context`. MASTER_PLAN line 3 updates with `2026-05-13-mega bundle SHIPPED`.

---
title: P1 — Bug-fix bundle 2026-05-12 mega (composes 12 source PRDs across pipeline reliability, LLM-judge fragility, refinement, citadel, monitor, council)
status: Draft
filed: 2026-05-11
priority: P1
type: bug-bundle
composes:
  - prds/archive/bug-reports/p3-pipeline-runner-sigint-no-origin-attribution.md
  - prds/archive/bug-reports/p1-per-ticket-worker-no-test-gate-cross-ticket-regressions.md
  - prds/archive/bug-reports/p1-pipeline-runner-halts-on-pickle-fail-blocks-remediation-phases.md
  - prds/p1-anatomy-park-worker-mode-subprocess-error-kills-loop.md
  - prds/archive/bug-reports/p1-microverse-baseline-llm-exhaustion-collapses-transient-into-fatal.md
  - prds/archive/bug-reports/p1-pipeline-runner-aborts-on-judge-timeout-no-finalize-gate.md
  - prds/archive/bug-reports/codex-classifier-prompt-leak.md
  - prds/archive/bug-reports/szechuan-sauce-codex-judge-model-mismatch.md
  - prds/archive/bug-reports/p1-microverse-judge-probe-misclassifies-timeout-as-cli-missing.md
  - prds/archive/bug-reports/p1-concurrent-claude-session-interference-with-running-pipelines.md
  - prds/archive/bug-reports/p2-spawn-refinement-team-audit-strict-vs-head-blocks-new-event-prds.md
  - prds/p2-citadel-conformance-core-not-wired-or-silently-skipped.md
  - prds/p3-monitor-dashboard-stale-after-pickle-to-anatomy-park-transition.md
  - prds/archive/features/council-of-ricks-catalog-mode-and-publish-fixes.md
related:
  - prds/archive/bundles/p1-bug-fix-bundle-2026-05-11-pipeline-reliability-quintet.md
  - prds/archive/bundles/p1-bug-fix-bundle-2026-05-11-remediation-53-failures.md
  - prds/MASTER_PLAN.md
backend_constraint: codex
refine: true
unattended: true
remediation_phases_required: ["citadel", "anatomy-park", "szechuan-sauce"]
---

# PRD — Bug-Fix Bundle 2026-05-12 Mega

**Author**: Pickle Rick
**Project**: `pickle-rick-claude`
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`, local-only

## Why this bundle

Two prior shipping cycles set up the scope for this one. Bundle 2026-05-10 terminated at session 2026-05-11T08:51:39Z with `Phase pickle exited with code 1 — stopping pipeline` after 60 commits and 0/4 phases recorded. Bundle 2026-05-11 pipeline-reliability quintet (session 2026-05-11-b7aad50b) ran ~3h13m through pickle (5 R-MMTR tickets shipped) + citadel + anatomy-park (4 HIGH trap-door fixes shipped, converged in 9 iterations) before szechuan-sauce phase 4/4 died at iter 1 with `baseline_unmeasurable (spawnSync claude ETIMEDOUT)` after 26 minutes and 4 backoff attempts. The quintet shipped 1 of 5 source PRDs (R-MMTR-1..5); R-SOA, R-PTG, R-PHC, R-APMW did not ship.

Three follow-on findings were filed during and after the quintet's flight: Finding #24 (R-SAOV, spawn-refinement-team audit overreach — caused 3 hours of refinement gate pain assembling the quintet), Finding #25 (R-CSI, concurrent Claude-session destructive-command interference — three incidents in 36 hours), and Finding #26 (R-MBLE, the szechuan baseline aggregator collapse that killed the quintet's tail phase).

This bundle ships:

1. **Tier A — quintet retry plus szechuan recovery.** The four unshipped quintet PRDs plus the szechuan killer plus its sister allowlist fix. These four-plus-two are prerequisites for any wider bundle; without R-PHC (halt-vs-continue policy), any non-zero phase exit aborts the bundle's own pipeline. Without R-PTG (per-ticket test gate), cross-ticket regressions accumulate silently. Without R-APMW (worker-mode subprocess error fallback), anatomy-park dies on the first slow-streaming codex iteration. Without R-MBLE + R-PRJT, szechuan-sauce baseline measurement aborts the entire pipeline on the first ETIMEDOUT.
2. **Tier B — older queue P1s the quintet didn't include.** Three pipeline-killer P1s that have been sitting in queue slots 1, 2, and 6: false EPIC_COMPLETED hallucination (R-CCPL), silent fake convergence on codex judge model mismatch (R-SCJM), and the 50ms probe-stage timeout misclassification (R-MJCP) that is the upstream cousin of R-MBLE.
3. **Tier C — new findings filed today.** R-CSI Phase 1 (concurrent-session forensics, read-only audit log + destructive-command catalog) and R-SAOV (refinement audit overreach fix).
4. **Tier D — quality and observability.** Citadel conformance core wiring (R-CCNW, P2), monitor dashboard mode swap (R-MDS, P3), and the Council of Ricks catalog-mode reframing plus publish fixes (R-CMR, P1/P2 separate surface).

Each source PRD is its own ship target; this wrapper exists to declare ordering, share preflight, and define a single closer.

## Bundle thesis

> "The pipeline runs end-to-end through transient subprocess errors, gate failures, manager cap-exits, signal-driven shutdowns, judge timeouts, baseline ETIMEDOUTs, refinement audit overreach, concurrent-session interference, and codex judge model mismatches. The monitor reflects the active phase. The citadel report surfaces the analyzer modules it was built to surface. Council of Ricks terminates deterministically and publishes on every exit path."

If a section's fix isn't structurally aligned with that thesis, drop it.

## Composes table

| Section | Source PRD | Severity | Tier |
|---|---|---|---|
| **B** | prds/archive/bug-reports/p3-pipeline-runner-sigint-no-origin-attribution.md | P3 (observability) | A — quintet retry |
| **C** | prds/archive/bug-reports/p1-per-ticket-worker-no-test-gate-cross-ticket-regressions.md | P1 (architectural) | A — quintet retry |
| **D** | prds/archive/bug-reports/p1-pipeline-runner-halts-on-pickle-fail-blocks-remediation-phases.md | P1 (architectural) | A — quintet retry |
| **E** | prds/p1-anatomy-park-worker-mode-subprocess-error-kills-loop.md | P1 (worker-convergence killer) | A — quintet retry |
| **F** | prds/archive/bug-reports/p1-microverse-baseline-llm-exhaustion-collapses-transient-into-fatal.md | P1 (szechuan killer, new) | A — szechuan recovery |
| **G** | prds/archive/bug-reports/p1-pipeline-runner-aborts-on-judge-timeout-no-finalize-gate.md | P1 (sister of F) | A — szechuan recovery |
| **H** | prds/archive/bug-reports/codex-classifier-prompt-leak.md | P1 (false epic completion) | B — older queue P1 |
| **I** | prds/archive/bug-reports/szechuan-sauce-codex-judge-model-mismatch.md | P1 (silent fake convergence) | B — older queue P1 |
| **J** | prds/archive/bug-reports/p1-microverse-judge-probe-misclassifies-timeout-as-cli-missing.md | P1 (anatomy-park killer) | B — older queue P1 |
| **K** | prds/archive/bug-reports/p1-concurrent-claude-session-interference-with-running-pipelines.md | P1 (Phase 1 forensics only) | C — new today |
| **L** | prds/archive/bug-reports/p2-spawn-refinement-team-audit-strict-vs-head-blocks-new-event-prds.md | P2 (refinement gate overreach) | C — new today |
| **M** | prds/p2-citadel-conformance-core-not-wired-or-silently-skipped.md | P2 (observability) | D — quality |
| **N** | prds/p3-monitor-dashboard-stale-after-pickle-to-anatomy-park-transition.md | P3 (pane content) | D — quality |
| **O** | prds/archive/features/council-of-ricks-catalog-mode-and-publish-fixes.md | P1/P2 (separate surface) | D — quality |

Section A is the bundle bootstrap (scope.json, pipeline.json, preflight, residual baseline capture). Section P is the bundle closer (version bump, release gate, install.sh, MASTER_PLAN bookkeeping for all closed Findings).

Note R-MMTR (Finding #19) is intentionally absent from this bundle: it shipped via the quintet (R-MMTR-1..5 in HEAD at commits 6578c139, c271a1f7, e914ffcd, e4284656, 8e6f33c0). Section closer reflects this when closing Finding #19.

## Bundle-level acceptance criteria

These are wrapper-level checks. Per-section acceptance criteria live in each source PRD and are not duplicated here.

- [ ] **AC-BUNDLE-01** — Every section in the composes list is shipped to its own per-PRD acceptance bar. Refinement decomposes each source PRD into atomic tickets; the bundle is Done only when each composed PRD's checklist is 100% green.
- [ ] **AC-BUNDLE-02** — Every new instrumentation hook introduced by this bundle is registered in all canonical registries enumerated in the receiving source PRD. Verification is each source PRD's own regression test; the bundle does not re-specify the registry list. Cardinality is asserted via set-equality against `Object.keys` in each source PRD's test, never hardcoded numbers (per Class A lesson from bundle 2026-05-10).
- [ ] **AC-BUNDLE-03** — Every trap-door entry introduced by this bundle is pinned in `extension/CLAUDE.md` and verified by `bash extension/scripts/audit-trap-door-enforcement.sh` exiting 0.
- [ ] **AC-BUNDLE-04** — MASTER_PLAN bookkeeping closes Open Findings #13, #14, #15, #16, #20, #21, #22, #23, #24, #25, #26 at closer (Section P). Finding #19 R-MMTR is closed by the quintet's prior partial-ship and is bookkeeping-only here. Finding #18 R-FGNC is explicitly OUT-OF-SCOPE and not closed.
- [ ] **AC-BUNDLE-05** — Working Rule 2 in MASTER_PLAN is updated to reflect Section C's gate scope expansion (gate now includes test:fast in addition to lint + tsc). Working Rule 3 (added 2026-05-11) is preserved.
- [ ] **AC-BUNDLE-06** — For every closer-time gate outcome in the source PRD for Section P (passed / inherited-residual / new-regression / infrastructure-fail), the closer ticket body documents the outcome-to-action mapping. R-CLOSER-3 (install + tag) executes only on the first two outcomes.
- [ ] **AC-BUNDLE-07** — Residual baseline from bundle 2026-05-10 (47 failing test:fast cases at HEAD before bundle 2026-05-12 launches) is captured at preflight (Section A) and used by R-CLOSER-2 to distinguish inherited vs newly-introduced regressions. This bundle is NOT responsible for driving residual_count to zero; that is the remediation bundle's job (see related frontmatter).
- [ ] **AC-BUNDLE-08** — Section L (R-SAOV) ships ahead of any section that would benefit from the audit overreach fix. Refinement orders L's tickets first within the audit-overreach surface so the rest of the bundle gets the relief. Wrapper PRD is authored audit-clean (no backticked forward-create symbols) to clear refinement gate without depending on L's fix to land first.
- [ ] **AC-BUNDLE-09** — Section O (R-CMR Council of Ricks) is the most separable surface in the bundle. If a partial-ship outcome forces a scope cut, Section O is the first to defer. The remainder of the bundle ships with O moved to a follow-on PRD.

## Pre-flight checklist (R-BUNDLE-PREFLIGHT-2026-05-12)

Before the pipeline launches:

1. Working tree clean. Untracked PRDs tolerated; no in-flight worker edits.
2. HEAD on main (no feature-branch operation).
3. Residual test:fast baseline measured at preflight and pinned to ${SESSION_ROOT}/preflight_failing_tests.json.
4. No prior pipeline session attached: `tmux ls | grep -E '^(pipeline|monitor-aux|refine)-' | head -1` returns empty.
5. codex CLI available in PATH (per backend_constraint: codex).
6. PLUMBUS_GENERATIVE_AUDIT not set to off (generative audits enabled).
7. Quintet outcome reflected in MASTER_PLAN before launch: header line updated to show quintet partial-ship, R-MMTR-1..5 closed, R-SOA / R-PTG / R-PHC / R-APMW carried forward to this bundle. Bookkeeping-only; no code change.

## Backend constraint

backend_constraint: codex. Operator preference (per session 2026-05-12 launch directive). Codex backend has longer-tail latency in worker-convergence mode, which Section E and Section F harden against. Running this bundle on codex stress-tests both fixes in flight.

## Refinement: ENABLED

refine: true. The 14 source PRDs together declare ~80-90 R-codes (each source PRD enumerates its own). Expected output after refinement: ~120-150 atomic tickets including bootstrap and closer. Refinement is the canonical step for atomizing; the wrapper intentionally does NOT re-declare R-codes here to stay audit-clean and avoid drift between wrapper and sources.

Wrapper-level discipline against the Finding #24 R-SAOV audit-overreach class: the prose above avoids backticking any forward-create snake-case symbol on lines containing the trigger phrases for the spawn-refinement-team symbol audit. Section L's fix removes this discipline tax for future bundle authors; this bundle pays the tax one last time.

## Risk Register

- **R1**: Multiple sections touch the same files (extension/src/bin/pipeline-runner.ts, extension/src/bin/mux-runner.ts, extension/src/bin/spawn-morty.ts, extension/src/bin/microverse-runner.ts, extension/src/types/index.ts). Mitigation: refinement orders tickets per-file; each worker rebases on HEAD before commit. Section F and Section G both touch microverse-runner + types/index.ts and bundle as a pair per F's sister-recommendation; refinement orders G's allowlist edit before F's split so each test's set-equality assertion matches its post-edit state.
- **R2**: Section C's test:fast addition to the per-ticket gate extends per-ticket runtime by ~30-120 seconds. With ~120-150 tickets, that's ~60-300 extra minutes. Total pipeline runtime estimate: 8-14 hours including refinement, anatomy-park, szechuan-sauce.
- **R3**: Section D's continue-on-fail lands mid-bundle. This bundle's own pickle phase runs on the pre-Section-D pipeline-runner and will halt on any non-zero exit. Only post-Section-D bundles benefit. Acknowledged.
- **R4**: Section E and Section F change the codex worker-convergence error paths that this bundle's own anatomy-park / szechuan-sauce phases run on. Monitor for cap-exhaustion during the run; the relevant cap is post-Section-E so an in-flight bug in E could compound. Mitigation: Section E's regression test runs in pickle phase before anatomy-park enters.
- **R5**: Section P's closer release gate inherits 47 residual test:fast failures from bundle 2026-05-10. Per AC-BUNDLE-07, closer distinguishes inherited from newly-introduced using the preflight baseline. The bundle ships if it introduces zero new regressions, even with residuals still present.
- **R6**: Finding #25 R-CSI Phase 1 (Section K) is forensics-only (read-only audit log + destructive-command catalog). It does NOT prevent the destructive-command class. If a sibling Claude session emits a destructive signal against this pipeline's session during the bundle's flight, the bundle dies and the audit log retro-attributes the cause. Mitigation: operator runs no concurrent recovery commands during the bundle's flight; the briefing doc for any concurrent Claude session points at READ-ONLY status checks only.
- **R7**: Section O (R-CMR Council of Ricks) is a different surface from the rest of the bundle (council mux-runner, council-publish, command prompt). If Section O's refinement reveals scope creep, AC-BUNDLE-09 lets the bundle defer Section O without losing the rest.

## Closer behavior (Section P)

- Version bump: source extension/package.json from 1.73.1 to 1.74.0 (minor — 11+ new behavioral guarantees across 14 source PRDs).
- Run canonical release gate: `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`.
- `bash install.sh --closer-context`; verify md5-parity between source and deploy of every compiled JS file the bundle touched.
- MASTER_PLAN bookkeeping: close Findings #13, #14, #15, #16, #20, #21, #22, #23, #24, #25, #26 (move entries to archive); update Working Rule 2 per Section C; reflect Finding #19's prior close from the quintet partial-ship; renumber active queue.
- Closer commit body lists each Open Finding closed with the shipping commit hash.
- gh release create v1.74.0 with release notes drawn from the 14 source PRD titles plus the quintet partial-ship attribution.

## What this bundle does NOT do

- It does NOT remediate the 47 residual test:fast failures from bundle 2026-05-10. That work is `prds/archive/bundles/p1-bug-fix-bundle-2026-05-11-remediation-53-failures.md`, gated on Section C and Section D landing first via this bundle.
- It does NOT address Open Finding #18 R-FGNC (finalize-gate npmrc WARN classifier). Filed for a follow-on P2 bundle.
- It does NOT address Open Finding #5 (subsystem CLAUDE.md drift audit). That is an ad-hoc audit task, not a bundle item.
- It does NOT address Open Finding #11 R-APWS (anatomy-park worker edits bypass scope.json allowlist). P2 surface; deferred.
- It does NOT address R-CSI Phase 2 (session.lock + destructive-guard prevention layer). Phase 2 ships after Phase 1's audit log confirms the attribution model.
- It does NOT add new features or refactors beyond what the 14 source PRDs specify. Bundle thesis is reliability + quality; scope creep is caught by `bash extension/scripts/audit-bundle-thesis.sh`.

## Triggering session

Will be assigned at launch via `/pickle-pipeline --backend codex prds/archive/bundles/p1-bug-fix-bundle-2026-05-12-mega.md`. Session ID format: 2026-05-12-<8-char-hash>. Expected duration 8-14 hours.

## Bundle-relative dependencies on the prior quintet

- R-MMTR-1..5 already in HEAD (commits 6578c139, c271a1f7, e914ffcd, e4284656, 8e6f33c0); Section P closes Finding #19 as a bookkeeping step.
- Anatomy-park trap-door fixes from the quintet's anatomy-park phase already in HEAD (commits 3bfd88e1, 72bd6ec3, 6f7d4717, 8645f5ab); preserved as remediation work the prior quintet's anatomy-park phase shipped before szechuan-sauce died.
- Szechuan-sauce KISS commit ebb2caf5 already in HEAD; preserved.
- Microverse auto-commit 9fbe4d7d in HEAD; preserved (auto-resume hardening from the prior session).

Net: this bundle starts at HEAD post-quintet, takes credit for nothing already shipped, and adds the missing reliability fixes plus the wider Tier B/C/D cleanup.

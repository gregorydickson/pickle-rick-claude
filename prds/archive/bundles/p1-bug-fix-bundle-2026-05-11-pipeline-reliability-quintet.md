---
title: P1 — Bug-fix bundle 2026-05-11 — pipeline-reliability quintet (composes 5 source PRDs)
status: Draft
filed: 2026-05-11
priority: P1
type: bug-bundle
composes:
  - prds/archive/bug-reports/p1-mux-runner-no-claude-manager-relaunch-on-max-turns.md
  - prds/archive/bug-reports/p3-pipeline-runner-sigint-no-origin-attribution.md
  - prds/archive/bug-reports/p1-per-ticket-worker-no-test-gate-cross-ticket-regressions.md
  - prds/archive/bug-reports/p1-pipeline-runner-halts-on-pickle-fail-blocks-remediation-phases.md
  - prds/p1-anatomy-park-worker-mode-subprocess-error-kills-loop.md
related:
  - prds/p1-bug-fix-bundle-2026-05-10.md
  - prds/archive/bundles/p1-bug-fix-bundle-2026-05-11-remediation-53-failures.md
  - prds/MASTER_PLAN.md
backend_constraint: codex
refine: true
unattended: true
remediation_phases_required: ["citadel", "anatomy-park", "szechuan-sauce"]
---

# PRD — Bug-Fix Bundle 2026-05-11 — Pipeline Reliability Quintet

**Author**: Pickle Rick
**Project**: `pickle-rick-claude`
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`, local-only

## Why this bundle

Bundle 2026-05-10 (session `2026-05-10-84ad0873`) shipped 60 commits across pickle phase but terminated at `2026-05-11T08:51:39Z` after 445 minutes without ever running citadel, anatomy-park, or szechuan-sauce. The 0/4-phases outcome surfaced five distinct pipeline-reliability gaps in one session — each independently a P1, all five together a complete loss of "automation runs end-to-end without operator intervention."

This bundle closes all five gaps in one shipping cycle. Each gap is filed as a standalone source PRD (see `composes:` frontmatter); this wrapper exists to declare ordering, share preflight, and define a single closer.

| Section | Source PRD | Severity |
|---|---|---|
| **B** | prds/archive/bug-reports/p1-mux-runner-no-claude-manager-relaunch-on-max-turns.md | P1 (pipeline-killer) |
| **C** | prds/archive/bug-reports/p3-pipeline-runner-sigint-no-origin-attribution.md | P3 (observability) |
| **D** | prds/archive/bug-reports/p1-per-ticket-worker-no-test-gate-cross-ticket-regressions.md | P1 (architectural) |
| **E** | prds/archive/bug-reports/p1-pipeline-runner-halts-on-pickle-fail-blocks-remediation-phases.md | P1 (architectural) |
| **F** | prds/p1-anatomy-park-worker-mode-subprocess-error-kills-loop.md | P1 (worker-convergence-killer) |

Section A is the bundle bootstrap (scope.json, pipeline.json, preflight). Section G is the bundle closer (version bump, release gate, install.sh, MASTER_PLAN bookkeeping).

## Bundle thesis

> "The pipeline must keep working through transient subprocess errors, gate failures, manager cap-exits, and signal-driven shutdowns. Today every one of those causes a full halt; after this bundle, only true state-corruption causes a halt."

If a section's fix isn't structurally aligned with that thesis, drop it.

## Backend constraint

`backend_constraint: codex`. Operator preference for this bundle (post-incident from claude-backend manager-max-turns firing). Codex backend has longer-tail latency in worker-convergence mode, which is exactly what Section F hardens against. Running THIS bundle on codex provides an in-flight stress test for the new consecutive-error fallback logic introduced in Section F.

## Refinement: ENABLED

`refine: true`. The 5 source PRDs together declare 47 R-codes (see each source PRD for the full enumeration). Expected output after refinement: ~50-55 atomic tickets including bootstrap and closer. Refinement is the canonical step for atomizing — the bundle wrapper intentionally does NOT re-declare R-codes here to keep the wrapper PRD audit-clean and avoid drift between wrapper and sources.

## Bundle-level acceptance criteria

These are wrapper-level checks. Per-section acceptance criteria live in each source PRD and are not duplicated here.

- [ ] **AC-BUNDLE-01** — Every section in the composes list is shipped to its own per-PRD acceptance bar. Refinement decomposes each source PRD into atomic tickets; this bundle is Done only when each composed PRD's checklist is 100% green.
- [ ] **AC-BUNDLE-02** — Every new instrumentation hook introduced by this bundle (one per composed source PRD that adds telemetry) is registered in all canonical registries enumerated in the receiving source PRD. Verification is the source PRD's own regression test; the bundle does not re-specify the registry list. Cardinality is asserted via set-equality against `Object.keys` in each source PRD's test, never hardcoded numbers (per Class A lesson from bundle 2026-05-10).
- [ ] **AC-BUNDLE-03** — Every trap-door entry introduced by this bundle (one per composed source PRD) is pinned in `extension/CLAUDE.md` and verified by `bash extension/scripts/audit-trap-door-enforcement.sh` exiting 0.
- [ ] **AC-BUNDLE-04** — MASTER_PLAN bookkeeping closes Open Findings #19, #20, #21, #22, #23 at closer (Section G).
- [ ] **AC-BUNDLE-05** — Working Rule #2 in MASTER_PLAN is updated to reflect Section D's gate scope expansion (gate now includes test:fast in addition to lint + tsc). Working Rule #3 (added 2026-05-11) is preserved.
- [ ] **AC-BUNDLE-06** — For every closer-time gate outcome in the source PRD for Section G (passed / inherited-residual / new-regression / infrastructure-fail), the closer ticket body documents the outcome-to-action mapping. R-CLOSER-3 (install + tag) executes only on the first two outcomes.
- [ ] **AC-BUNDLE-07** — Residual baseline from bundle 2026-05-10 (47 failing test:fast cases at HEAD `ade8544a`) is captured at preflight (Section A) and used by R-CLOSER-2 to distinguish inherited vs newly-introduced regressions. This bundle is NOT responsible for driving residual_count to zero; that is the remediation bundle's job (see `related:` frontmatter).

## Pre-flight checklist (R-BUNDLE-PREFLIGHT-2026-05-11)

Before the pipeline launches:

1. Working tree clean. Only untracked PRDs are tolerated; no in-flight worker edits.
2. HEAD on `main` (no feature-branch operation).
3. Residual test:fast baseline measured at preflight and pinned to `${SESSION_ROOT}/preflight_failing_tests.json`. The current baseline at HEAD `ade8544a` is 47 unique failing tests.
4. No prior pipeline session attached: `tmux ls | grep -E '^(pipeline|monitor-aux|refine)-' | head -1` returns empty.
5. `codex` CLI available in PATH (per the operator's `--backend codex` directive).
6. `PLUMBUS_GENERATIVE_AUDIT` not set to `"off"` (generative audits enabled).

## Risk Register

- **R1**: Multiple sections touch the same files (`extension/src/bin/pipeline-runner.ts`, `extension/src/bin/mux-runner.ts`, `extension/src/bin/spawn-morty.ts`). Mitigation: refinement orders tickets per-file; each worker rebases on HEAD before commit.
- **R2**: Section D's test:fast addition to the per-ticket gate extends per-ticket runtime by ~30-120s. With 50+ tickets, that's ~30-100 extra minutes. Total pipeline runtime estimate: 5-8 hours including refinement.
- **R3**: Section E's continue-on-fail lands mid-bundle; THIS bundle's own pickle phase runs on the pre-Section-E pipeline-runner and will halt on any non-zero exit. Only post-bundle work benefits from Section E. Acknowledged.
- **R4**: Section F changes the codex worker-convergence error paths that this bundle's own anatomy-park / szechuan-sauce phases will run on. Monitor for cap-exhaustion during the run.
- **R5**: Section G's closer release gate inherits 47 residual test:fast failures from bundle 2026-05-10. Per AC-BUNDLE-07, the closer distinguishes "inherited" from "newly introduced" using the preflight baseline. The bundle ships if this bundle introduces zero new regressions, even with the 47 residuals still present.

## Closer behavior (Section G)

- Version bump: source `extension/package.json` from `1.73.1` to `1.74.0` (minor — five new behavioral guarantees).
- Run canonical release gate: `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`.
- `bash install.sh --closer-context`; verify md5-parity 5/5 between source and deploy of compiled JS files.
- MASTER_PLAN bookkeeping: close Findings #19, #20, #21, #22, #23 (move entries to archive); update Working Rule #2 per Section D; renumber active queue.
- Closer commit body lists each Open Finding closed.

## What this bundle does NOT do

- It does NOT remediate the 47 residual test:fast failures from bundle 2026-05-10. That work is `prds/archive/bundles/p1-bug-fix-bundle-2026-05-11-remediation-53-failures.md`, gated on THIS bundle landing first.
- It does NOT address Open Finding #18 (finalize-gate `.npmrc` WARN classifier). That ships in a follow-on P2 bundle.
- It does NOT add new features or refactors beyond what the five source PRDs specify. Bundle thesis is reliability; scope creep is caught by `bash extension/scripts/audit-bundle-thesis.sh`.

## Triggering session

Will be assigned at launch via `/pickle-pipeline --backend codex prds/archive/bundles/p1-bug-fix-bundle-2026-05-11-pipeline-reliability-quintet.md`. Session ID format: `2026-05-11-<8-char-hash>`. Expected duration 5-8 hours.

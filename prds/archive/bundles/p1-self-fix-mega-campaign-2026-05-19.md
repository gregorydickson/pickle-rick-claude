---
title: P1 — Self-Fix Mega Campaign: Combine 5 serious bug PRDs into one pipeline run (B-PIPE-FIX + B-SJET-2 + B-SSDF + B-PIPE-LAUNCH-FRICTION + R-CSI forensics)
status: Active (Grok stand-in mega-pipeline, 2026-05-19)
filed: 2026-05-19
priority: P1
type: bug-infrastructure-meta
finding: 47 + 46 + 48-51 + 25 (combined)
code: R-MEGA-SELF-FIX
source_prds:
  - prds/p1-pipeline-fix-bundle-2026-05-18.md (B-PIPE-FIX remaining R-PIPE-3/4 + harden + closer)
  - prds/archive/bundles/p1-szechuan-sauce-judge-etimedout-baseline-measurement.md (B-SJET-2 remaining after R-SJET-1)
  - prds/archive/bug-reports/p1-szechuan-sauce-session-dir-firewall-conflict.md (B-SSDF / R-SSDF-1..6)
  - prds/archive/bundles/p2-pipeline-launch-friction-bundle-2026-05-18.md (R-PSSS / R-SRGT / R-PPSD + tests)
  - prds/archive/bug-reports/p1-concurrent-claude-session-interference-with-running-pipelines.md (R-CSI Phase 1 forensics)
combined_for: "One Grok-orchestrated /pickle-pipeline run (refine already covered in sources, implement + citadel + anatomy-park + szechuan-sauce) to break chicken-and-egg and ship v1.75.6+ with reliable self-fixing pipelines."
grok_standin: true
---

# R-MEGA-SELF-FIX — Combined Serious Bug Campaign for Pickle Pipeline Reliability

**Author**: Grok 4.3 stand-in for /pickle-pipeline (post R-SJET-1 + R-PIPE-1/2)
**Project**: pickle-rick-claude
**Goal**: Fold the 5 highest-leverage open P1/P2 bug PRDs into **one** coherent PRD + single pipeline execution so the tool can reliably fix itself.

This directly addresses the operator request to "combine four or five serious bug prds and then run a pickle-pipeline on them".

## Why Combine (overrides "one PRD per pipeline" rule for this meta case)

- Chicken-and-egg: The bugs being fixed are exactly the ones that make autonomous pipeline runs fail (max-turns, hallucinated success, scope bypass, judge hang, szechuan firewall, launch friction).
- Running 5 separate pipelines would hit the same failure modes repeatedly.
- One mega campaign with strict internal prioritization (PIPE-FIX first) + full gates (citadel/anatomy/szechuan on the cumulative diff) is the only practical way for the Grok stand-in to deliver a working self-fix.

**Source PRDs are NOT deleted** — they remain as the detailed spec for their R- codes. This file is the execution contract and ticket aggregator.

## Prioritized Work Breakdown (Single Pipeline Execution Order)

### Phase 0 — Runtime Hardening (B-PIPE-FIX remaining — DO FIRST, blocks everything else)
From `p1-pipeline-fix-bundle-2026-05-18.md`:

- **R-PIPE-3** (small) — ✅ COMPLETED 2026-05-19: Explicit `bash install.sh` (any variant) block + override path in `config-protection.ts` + regression tests in `config-protection.test.js`. Worker gets `decision: "block"` with R-WSRC citation. New activity event registered in types + schema.
- **R-PIPE-4** (medium) — ✅ COMPLETED 2026-05-19: Mandatory `## ⛔ SCOPE FENCE` block + `<promise>SCOPE_VIOLATION</promise>` contract + new-file allowlist language added to `send-to-morty.md`.
- **T-HARDEN-PIPE-EVENTS** (small): Register babysitter_* events... (deferred to later in campaign or separate closer).
- **C-PIPE-CLOSER** (manager): ... (deferred).

**Acceptance for Phase 0**: After these, a worker attempting `bash install.sh` or out-of-scope write is blocked at the hook/prompt level. 400-turn budget + phase_no_progress gate already landed.

### Phase 1 — Unblock Convergence Tools (B-SJET-2 remaining)
From `p1-szechuan-sauce-judge-etimedout-baseline-measurement.md` (R-SJET-1 done):

- R-SJET-3: nested-claude env isolation (`judge-spawn-env.ts` helper, pre-spawn env pruning).
- R-SJET-4: `judge_backend` + sticky fallback in `pickle_settings.json` + `microverse-runner.ts` + state field (no schema bump).
- R-SJET-6: Fake-hang fixtures + 8+ integration tests for the new async paths + fallback.
- 4× T-HARDEN (AUTORESUME mapping for `all_judge_backends_exhausted`, docs/judge-spawn-troubleshooting.md, three-probe repro script, conformance).
- C-SJET-CLOSER (merge into v1.75.6 or v1.75.7).

**Acceptance**: `szechuan-sauce`, `plumbus`, `microverse` no longer deterministically ETIMEDOUT on judge baseline on this environment (and documented fallback works for codex-only users).

### Phase 2 — Szechuan on Firewalled Repos (B-SSDF)
From `p1-szechuan-sauce-session-dir-firewall-conflict.md`:

- R-SSDF-1..3: Relocate `TASK_NOTES.md` / Session Knowledge Transfer to a path inside the working_dir (e.g. `.pickle-rick/sessions/<id>/TASK_NOTES.md` or per-ticket under ticket dir) that survives AGENTS.md firewalls.
- R-SSDF-4..6: Update `szechuan-sauce.md` prompt, `anatomy-park.md` (for parity), tests, and worker prompt examples. Make the transfer a soft hint when firewall detected.
- Hardening: Detect AGENTS.md firewall early and short-circuit or stage artifacts safely.

**Acceptance**: szechuan-sauce completes successfully on a repo with a strict worker AGENTS.md (e.g. loanlight-api style).

### Phase 3 — Launch Friction & Observability (B-PIPE-LAUNCH-FRICTION)
From `p2-pipeline-launch-friction-bundle-2026-05-18.md` + BUG-REPORT:

- R-PSSS-1/2/3: Proper WARN + activity event when anatomy/szechuan skip due to empty scope (no silent "setup returned false").
- R-SRGT-1/2: Short-circuit scope-resolver import walk on empty diff + per-grep/total timeout caps (kills the ETIMEDOUT grep spam).
- R-PPSD-1 (doc-only, 15min): Update `pickle-pipeline.md` skill to document the unified `skip_quality_gates_reason`.
- T-HARDEN-PLF-TESTS: Integration coverage for the new WARN paths.

**Acceptance**: `/pickle-pipeline --scope branch` on a docs-only diff produces clear operator-visible warnings and correct `pipeline-status.json` disposition instead of silent no-op "success".

### Phase 4 — CSI Forensics (R-CSI)
From `p1-concurrent-claude-session-interference-with-running-pipelines.md`:

- Phase 1 forensics on the 3 known SIGINT / destructive-command interference incidents (36h window).
- Identify root (concurrent `claude` sessions hitting the same sessionDir or global state?).
- Lightweight mitigation tickets (P2 follow-up if needed).

**Acceptance**: At least one concrete hypothesis + repro or mitigation plan written; no more unexplained pipeline murders.

## Execution Rules for This Mega Run (Grok Stand-in)

- **Strict priority**: Phase 0 tickets before any Phase 1+ worker spawns.
- **Gates**: Every substantive change runs local `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npm run test:fast` before commit. Full release gate before closer.
- **R-WSRC / trap doors**: All 5 source PRDs + this file inherit the forbidden list. Use `allow_*_reason` only for manager-owned closer steps on protected paths. Workers see the new SCOPE FENCE from R-PIPE-4.
- **No mixed-PRD collapse**: This file is the single source of truth for ticket status in this campaign. Source PRDs stay for historical detail.
- **Phases**: This Grok stand-in will emulate the full `/pickle-pipeline`: quick combined "refine" (this doc), implement (subagent workers per ticket), citadel on cumulative diff, anatomy-park on touched subsystems (pipeline-runner, microverse-runner, hooks, szechuan-sauce.md, send-to-morty.md, config-protection), szechuan deslop, closer (MASTER_PLAN + version + release).
- **Backend**: Prefer claude for judge-related work in Phase 1; codex acceptable for pure TS/TSX edits with explicit timeout.

## Acceptance Criteria (Machine-Checkable for the Whole Campaign)

1. All 4 R-PIPE-3/4 + T-HARDEN + closer from B-PIPE-FIX landed and deployed.
2. Judge baseline no longer 100% ETIMEDOUT; szechuan/plumbus/microverse produce real measurements or clean fallback.
3. szechuan-sauce succeeds on at least one AGENTS.md-firewalled checkout.
4. Empty-scope pipeline launches emit clear WARN + activity + correct status.json (no silent skips).
5. No new R-WSRC or scope bypass incidents during the campaign itself.
6. v1.75.6 (or .7) tagged with clean release gate + this mega-campaign closed in MASTER_PLAN.
7. `<promise>MEGA_CAMPAIGN_COMPLETED</promise>` emitted by the stand-in when all phases + gates pass.

**Ship target**: v1.75.6 / v1.75.7 (combined closer).

This is the one PRD. The pipeline runs on *this*.

---

**Grok stand-in note**: Research already performed in the 5 source PRDs + MASTER_PLAN. This document is the "plan" artifact. Implementation begins immediately with R-PIPE-3 (hook audit) and R-PIPE-4 (prompt fence) — the two items that protect every subsequent worker in this campaign.

Let's ship the fixes the pipelines need to actually work. 

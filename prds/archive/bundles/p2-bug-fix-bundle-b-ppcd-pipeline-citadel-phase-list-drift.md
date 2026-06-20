---
title: P2 bug-fix bundle — B-PPCD — pipeline citadel phase-list doc drift
status: Draft
filed: 2026-05-31
priority: P2
type: bug-bundle
code: B-PPCD
composes:
  - "#85 R-PPCD — /pickle-pipeline skill prompt + persona.md routing omit citadel and assert a false 3-phase list"
backend_constraint: any
schema_neutral: true   # doc-only; no code, no state.json field, no LATEST_SCHEMA_VERSION change
source:
  - prds/MASTER_PLAN.md   # Open Finding #85 R-PPCD
---

# B-PPCD — pipeline citadel phase-list doc drift

> **Doc-only, schema-neutral.** No source/compiled code changes. Two doc files (`.claude/commands/pickle-pipeline.md`, `persona.md`) + `bash install.sh` (closer) to deploy. PATCH bump.

## Trigger

MASTER_PLAN drain-queue row 6 (`#85 R-PPCD`). The `/pickle-pipeline` skill prompt and the `persona.md` routing section both assert a **false 3-phase pipeline** ("the runtime orchestrator `pipeline-runner.js` only runs build → anatomy-park → szechuan-sauce"), omitting the **citadel** phase.

## Root cause

The real pipeline is **4-phase** and auto-splices citadel: `extension/src/bin/pipeline-runner.ts:63` declares `type PipelinePhase = 'pickle' | 'citadel' | 'anatomy-park' | 'szechuan-sauce'`, and the file header (line ~8) documents `2. citadel → in-process audit (pipeline risk gate)`. The docs drifted from this:

- `.claude/commands/pickle-pipeline.md` — line 1 header ("pickle-tmux build, anatomy-park, szechuan-sauce"), line 5 ("Three phases"), line 13 (the false `pipeline-runner.js` "only runs build → anatomy-park → szechuan-sauce" claim), line 51 ("Pipeline phases (pickle, anatomy-park, szechuan-sauce)"), and the Step 4 default phase array / template + Step 8 report wording all omit citadel.
- `persona.md` — line ~19 routing parenthetical repeats the same false "`pipeline-runner.js` only runs build → anatomy-park → szechuan-sauce" claim.

Doc-only drift, but it misleads planning/routing (readers believe citadel never runs). Fix = correct both docs to the real 4-phase order, then `bash install.sh` to deploy (`persona.md` deployed copy is config-protected — handled by the closer per [[feedback_persona_source_of_truth]]).

## In scope

- Correct every citadel-omitting phase-list claim in `.claude/commands/pickle-pipeline.md` to the real 4-phase `pickle → citadel → anatomy-park → szechuan-sauce`.
- Correct the `persona.md` routing parenthetical to the same.
- Closer: gate, PATCH bump, `install.sh` deploy, push, release, MASTER_PLAN repoint closing #85.

## Not in scope

- Any change to `pipeline-runner.ts` or the actual phase machinery (it is already correct — this is doc-only).
- The `pipeline-runner.js` runtime note in `extension/CLAUDE.md` (already accurate / separately governed).
- Re-architecting the skill prompt beyond the phase-list correction.

## Atomic tickets

### R-PPCD-1 (small) — Correct pickle-pipeline.md phase-list drift
- **Scope:** edit only `.claude/commands/pickle-pipeline.md`. Replace every citadel-omitting 3-phase claim with the real 4-phase order `pickle → citadel → anatomy-park → szechuan-sauce` (header line 1, "Three phases" line 5, the `pipeline-runner.js` claim line 13, the "Pipeline phases (…)" line 51, and the Step 4 default phase array/template + Step 8 report wording). Keep the existing refinement-is-skill-level clarification accurate (refinement is NOT a pipeline-runner phase — that part stays).
- **AC-PPCD-1-1:** `grep -c "build → anatomy-park → szechuan-sauce" .claude/commands/pickle-pipeline.md` returns `0` (no citadel-omitting 3-phase ordering string remains).
- **AC-PPCD-1-2:** `grep -qiE "pickle.*citadel.*anatomy-park.*szechuan" .claude/commands/pickle-pipeline.md` exits 0 (the real 4-phase order is stated at least once).
- **AC-PPCD-1-3:** `grep -ciE "three phases" .claude/commands/pickle-pipeline.md` returns `0` (the "Three phases" claim is corrected, e.g. to "Four phases").
- **AC-PPCD-1-4:** `grep -c "citadel" .claude/commands/pickle-pipeline.md` ≥ 1 (citadel is now named).

### R-PPCD-2 (small) — Correct persona.md routing parenthetical
- **Scope:** edit only `persona.md` (the repo source — NOT the deployed `~/.claude/CLAUDE.md`/`~/.claude/pickle-rick/persona.md` copy, which the closer's `install.sh` redeploys). Correct the routing-line parenthetical that asserts `pipeline-runner.js` "only runs build → anatomy-park → szechuan-sauce" to the real 4-phase order including citadel (preserve the "refinement is skill-level" point).
- **AC-PPCD-2-1:** `grep -c "build → anatomy-park → szechuan-sauce" persona.md` returns `0`.
- **AC-PPCD-2-2:** `grep -c "citadel" persona.md` ≥ 1.

### C-PPCD-CLOSER [manager] — Ship B-PPCD
- **Scope:** run the FULL release gate from `extension/`, **PATCH** bump (`1.89.2 → 1.89.3`; doc-only, schema-neutral — no new command/flag/event/state field), `bash install.sh` to deploy the corrected `pickle-pipeline.md` (commands) + `persona.md`, push, `gh release create`, repoint MASTER_PLAN (close #85).
- **AC-CLOSER-1:** Full release gate GREEN from `extension/`: `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-subprocess-heavy-tests.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive` all exit 0. READ the gate result and confirm green before bump/commit/tag.
- **AC-CLOSER-2:** `extension/package.json:version` = `1.89.3`; commit subject `chore(C-PPCD-CLOSER): ship B-PPCD — bump 1.89.3 + close #85`.
- **AC-CLOSER-3:** `bash install.sh` exits 0; deployed `~/.claude/commands/pickle-pipeline.md` and deployed persona reflect the 4-phase correction (`grep -c "build → anatomy-park → szechuan-sauce" ~/.claude/commands/pickle-pipeline.md` returns 0); `git status` clean at tag time.
- **AC-CLOSER-4:** `git push` succeeds; `gh release create v1.89.3` succeeds (verify with `gh release list`).
- **AC-CLOSER-5:** `prds/MASTER_PLAN.md` marks B-PPCD SHIPPED and closes #85. Verify: `grep -c "B-PPCD.*SHIPPED" prds/MASTER_PLAN.md` ≥ 1.

## Acceptance (bundle-level)

- Both docs state the real 4-phase pipeline (`pickle → citadel → anatomy-park → szechuan-sauce`); no citadel-omitting 3-phase claim remains in either file.
- Release gate green, clean tree, PATCH bump, shipped via `gh release create`, MASTER_PLAN repointed, #85 closed.

— Pickle Rick out. *belch*

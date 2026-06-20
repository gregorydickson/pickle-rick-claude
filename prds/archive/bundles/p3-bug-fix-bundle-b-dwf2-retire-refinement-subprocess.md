---
title: P3 feature bundle — B-DWF-2 — soak + retire legacy refinement subprocess
status: Shelved
shelved_reason: "R-DWF-3-SOAK cannot cleanly complete. Attempt 1 found a real workflow bug (ManifestSchema format:date-time rejected by Workflow-runtime AJV) — FIXED in e1c322f2 (landed on main, a standalone improvement to the opt-in workflow path). Attempt 2 (post-fix) got further — all 3 analysts succeeded — but the synthesis step ran with UNDEFINED input paths (Original PRD/Session dir/Refinement dir all 'undefined' in the soak invocation), so no manifest landed at a verifiable path and the soak stalled ~34min. Root cause = soak-harness input wiring, not necessarily workflow code. SHELVED: retiring the safe-default legacy refinement path is low-value and not justified on a soak that can't cleanly validate. Legacy path retained (zero regression; workflow path stays opt-in default-off). Re-attempt needs: a reliable soak harness that passes the PRD/session/refinement paths to the workflow + confirmation the workflow produces a valid manifest end-to-end."
retry_reason: "Re-activated 2026-06-01 — blocking ManifestSchema date-time→minLength fix landed in commit e1c322f2. Re-soak stalled on undefined synthesis input paths; re-shelved per AC-SOAK-3."
prior_shelved_reason: "R-DWF-3-SOAK FAIL — ManifestSchema format:date-time rejected by workflow runtime AJV; fix required before retry. See prds/archive/research/dwf-soak-findings.md."
shelved_date: 2026-06-01
filed: 2026-06-01
priority: P3
type: bug-bundle
code: B-DWF-2
composes:
  - "R-DWF-3 — retire spawn-refinement-team.ts + refinement-watcher.ts + skill tmux block + PICKLE_REFINE_WORKFLOW kill-switch (after a green soak)"
  - "R-DWF-6 — README/docs for the workflow-backed refine path"
backend_constraint: any
schema_neutral: true   # removes internal scripts + a transitional kill-switch; no state.json field, no LATEST_SCHEMA_VERSION change
source:
  - prds/archive/features/p2-dynamic-workflow-conversion-refine-prd-council.md   # R-DWF-3 / R-DWF-6 (deferred follow-up of B-DWF impl, shipped v1.91.0)
---

# B-DWF-2 — soak + retire legacy refinement subprocess

> Follow-up to **B-DWF impl (v1.91.0)** which shipped the dynamic-workflow refine path (`.claude/workflows/refine-analyze.js`) behind the **opt-in** `PICKLE_REFINE_WORKFLOW` kill-switch (default = legacy subprocess path). This bundle retires the legacy path **only after** a green soak proves the workflow path end-to-end on a real PRD.

## Trigger

B-DWF row 13 (B-DWF-2 follow-up). The PRD's R-DWF-3 is gated: *"R-DWF-3 removes the legacy path + `refinement-watcher.ts` + the skill tmux block only after the workflow path runs green end-to-end on a real PRD."* That soak has not run. R-DWF-6 (docs) depends on R-DWF-3.

## Root cause / context

The legacy refinement subprocess (`spawn-refinement-team.ts` + `refinement-watcher.ts` + the `pickle-refine-prd.md` tmux block) is the **default** refinement engine; the v1.91.0 workflow path is opt-in. Retiring the legacy path is a **one-way removal of the fallback** — so it MUST be gated on a green soak (a real, real-agent run of the workflow path), and the full release gate is the final backstop. If the soak fails, R-DWF-3/R-DWF-6 do NOT run and the bundle's sole deliverable is the soak findings (the workflow needs a fix first — file a new finding).

## In scope

- A **hard-gate soak** (R-DWF-3-SOAK): run the workflow refine path live on a real PRD and record a machine-checkable verdict.
- On soak PASS: retire the legacy subprocess path + watcher + skill tmux block + the `PICKLE_REFINE_WORKFLOW` kill-switch (R-DWF-3); document the workflow-backed path (R-DWF-6).
- Closer: gate, MINOR bump, `install.sh`, push, release, MASTER_PLAN repoint.

## Not in scope

- The `/council-of-ricks` round-driver retirement (R-DWF council WS-B retirement is separate; this bundle is WS-A refinement only).
- Any state-schema change.

## Atomic tickets

> **R-DWF-3-SOAK is a hard gate (do first).** R-DWF-3 + R-DWF-6 do NOT start until the soak verdict is PASS. A FAIL flips this PRD's frontmatter to `status: Shelved` and the soak findings file is the sole deliverable.

### R-DWF-3-SOAK (medium) — Live soak of the workflow refine path *(BLOCKER — do first)*
- **Scope:** with `PICKLE_REFINE_WORKFLOW=on`, run the analyst-fan-out workflow (`.claude/workflows/refine-analyze.js`) **live with real agents** on a real input PRD (use a small existing PRD, e.g. `prds/archive/bundles/p2-bug-fix-bundle-b-ppcd-pipeline-citadel-phase-list-drift.md`, or a purpose-built fixture PRD under a tmp session dir). Capture the emitted analyses + refined manifest. Write `prds/archive/research/dwf-soak-findings.md` (forward-created) with a `## Soak results` table and a `verdict:` frontmatter field.
- **AC-SOAK-1:** `prds/archive/research/dwf-soak-findings.md` exists with frontmatter `verdict: PASS` or `verdict: FAIL` and a `## Soak results` table; `grep -cE "\| *(PASS|FAIL) *\|" prds/archive/research/dwf-soak-findings.md` ≥ 3 (rows for: analyses-count = 3×cycles, manifest-validates, no-agent-errors).
- **AC-SOAK-2:** on PASS, the captured refined manifest validates against `extension/src/types/refinement-manifest.schema.json` (ajv exit 0) AND contains ≥1 ticket; the findings table records the observed ticket count.
- **AC-SOAK-3:** a `verdict: FAIL` (any soak row FAIL) MUST set this PRD's frontmatter `status: Shelved` and the ticket completes with the findings file as sole deliverable — R-DWF-3 and R-DWF-6 are NOT started.

### R-DWF-3 (medium) — Retire the legacy subprocess + watcher + kill-switch *(depends R-DWF-3-SOAK PASS)*
- **Scope:** remove `extension/src/bin/spawn-refinement-team.ts`, `extension/src/bin/refinement-watcher.ts` (+ their compiled `.js`), the `pickle-refine-prd.md` legacy tmux block, and the `PICKLE_REFINE_WORKFLOW` kill-switch (the workflow path becomes the only path). Update `spawn-refinement-team.ts` consumers/imports. Remove now-orphaned tests or migrate them to the workflow path.
- **AC-DWF-3-1:** `git ls-files extension/src/bin/spawn-refinement-team.ts extension/src/bin/refinement-watcher.ts` is empty.
- **AC-DWF-3-2:** `grep -rn "claude -p\|PICKLE_REFINEMENT_LOCK\|PICKLE_REFINE_WORKFLOW" .claude/workflows/refine-*.js extension/src/bin` returns no refinement-subprocess references; `bash extension/scripts/audit-runtime-imports.sh` reports no orphaned imports (if that script exists; else `npx tsc --noEmit` clean is the proxy).
- **AC-DWF-3-3:** the full lint+test gate (CLAUDE.md release command) exits 0.

### R-DWF-6 (small) — Docs for the workflow-backed refine path *(depends R-DWF-3)*
- **Scope:** `README.md` documents the workflow-backed refine path (now the only path); remove stale references to `spawn-refinement-team` / `refinement-watcher`.
- **AC-DWF-6-1:** `grep -rn "spawn-refinement-team\|refinement-watcher" README.md docs/` returns nothing stale.
- **AC-DWF-6-2:** `bash extension/scripts/audit-subsystem-claude-md.sh` passes (if present).

### C-DWF2-CLOSER [manager] — Ship B-DWF-2
- **Scope:** run the FULL release gate from `extension/`, **MINOR** bump (`1.92.0 → 1.93.0`; removes internal scripts + a transitional kill-switch, schema-neutral — no documented CLI arg/hook contract removed), `bash install.sh`, push, `gh release create`, repoint MASTER_PLAN (mark B-DWF-2 SHIPPED, close R-DWF-3/R-DWF-6).
- **AC-CLOSER-1:** Full release gate GREEN from `extension/` (tsc --noEmit, eslint --max-warnings=-1, tsc, all audit-*.sh, test:fast, test:integration, RUN_EXPENSIVE_TESTS=1 test:expensive) — READ + confirm before bump/commit/tag.
- **AC-CLOSER-2:** `extension/package.json:version` = `1.93.0`; commit subject `chore(C-DWF2-CLOSER): ship B-DWF-2 — bump 1.93.0 + retire legacy refinement subprocess`.
- **AC-CLOSER-3:** `bash install.sh` exits 0; `git status` clean at tag time; compiled JS matches TS.
- **AC-CLOSER-4:** `git push` succeeds; `gh release create v1.93.0` succeeds (verify with `gh release list`).
- **AC-CLOSER-5:** `prds/MASTER_PLAN.md` marks B-DWF-2 SHIPPED. Verify: `grep -c "B-DWF-2.*SHIPPED" prds/MASTER_PLAN.md` ≥ 1.

## Acceptance (bundle-level)

- Soak verdict PASS recorded; legacy refinement subprocess + watcher + kill-switch removed; workflow path is the sole refine engine; docs updated; release gate green; shipped via `gh release create`; MASTER_PLAN repointed.
- OR: soak verdict FAIL → PRD `status: Shelved`, findings file is the deliverable, legacy path retained (no regression), a new finding filed for the workflow gap.

— Pickle Rick out. *belch*

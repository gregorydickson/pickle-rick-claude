# BUG REPORT — anatomy-park trap-door catalog target (subsystem CLAUDE.md) is fenced out of strict branch-diff scope

**Filed:** 2026-06-19 (capture-only, babysitter)
**Code:** R-TDCS (Trap-Door Catalog Scope-fence)
**Priority:** P3
**Status:** 🟢 FIX COMMITTED `6b895307` (2026-06-19) — beta.20 release pending. Applied recommended fix **#1 alone**: `check-scope-diff.ts` `isTrapDoorCatalogPath(p)` (basename `CLAUDE.md`) is exempted from the `outside` scope-violation set. #1 subsumes Layer-2 staleness (a just-written `CLAUDE.md` no longer depends on a frozen `allowed_paths`), so #2/#3 were unnecessary. Fence on source files intact (an out-of-scope `*.ts` staged alongside a `CLAUDE.md` is still flagged). Tests: `check-scope-diff-preflight.test.js` R-TDCS cases; trap-door doc added (`extension/CLAUDE.md` R-TDCS, PATTERN_SHAPE `!isTrapDoorCatalogPath(p)`). REMAINING: confirm fast-c4 + integration, bump beta.20, tag.
**Source incident:** session `2026-06-19-2b1e2707` (LOA-1387 bank-statement extraction resilience, `/pickle-pipeline --backend codex`), anatomy-park phase, subsystem `packages`.
**Siblings:** #105 R-RGED dimension-4 (diff-vs-declared-trap-doors *scanning* — this is the *writing* counterpart); B-SJWT #95 (szechuan whole-tree-vs-`allowed_paths` scope mismatch, opposite direction).

## Summary

anatomy-park's third pillar is **catalog trap doors** → persist each structural invariant to the subsystem `CLAUDE.md` (with a `PATTERN_SHAPE` regex) so future anatomy/citadel runs can replay it deterministically. Under `/pickle-pipeline` anatomy-park runs in **strict branch-diff scope** (`scope.json.mode="branch"`, `strategy="strict"`): `allowed_paths` is exactly the set of files the feature branch changed.

A trap door is **by definition a pre-existing structural invariant**, so its catalog file (`<subsystem>/CLAUDE.md`) is generally **not part of the feature diff** → not in `allowed_paths`. The commit gate `check-scope-diff.js` has **no `CLAUDE.md` carve-out** (verified by grep — nothing). Therefore the gate rejects a commit that stages the very file anatomy-park exists to write. The trap doors land only in session-ephemeral `<session>/anatomy-park.json` (`trap_doors_added`) and **evaporate when the session dir is cleaned**. anatomy-park's catalog deliverable is structurally unreachable in pipeline mode.

## Live evidence (session 2b1e2707)

`anatomy-park.json` for the run:
- `trap_doors_added`: **3**, all targeting `src/modules/bank-statement/CLAUDE.md`
- `trap_doors_committed`: **1**

The 2 stranded trap doors are the high-value ones — both describe the **reprocess-findings HIGH bug** (findings-row duplication + fraud-flag remap onto reused statement rows; statement refresh + child-transaction replacement on period match). That structural knowledge is being deferred into a JSON file nothing reads after cleanup.

Worker's own words in `tmux_iteration_3.log`:
> "Trap-door cataloging is still deferred because `scope.json` excludes `src/modules/bank-statement/CLAUDE.md`."

## Root cause (two layers)

**Layer 1 — structural fence.** Strict branch-diff scope is meant to fence *code edits* to the diff under review. But anatomy-park's own *documentation output* (the trap-door catalog) targets a pre-existing subsystem `CLAUDE.md` that is, almost by definition, outside the feature diff. The scope gate treats the tool's deliverable as scope creep and blocks it.

**Layer 2 — aggravating staleness (why #1 slipped but #2/#3 can't).** `scope.json` is resolved **once**, frozen at anatomy-park's start head (`scope-refresh: phase=anatomy-park head=09c43be allowed=10`). Trap door #1 rode in atomically with an in-scope *fix* commit — `2c1ff7d8c anatomy-park: packages — HIGH fix statement list ordering, trap door`. That commit advanced HEAD and put `CLAUDE.md` into the branch diff vs `origin/main`, **but `allowed_paths` was never refreshed**, so the gate now rejects the very file it implicitly accepted one commit earlier. On a *clean pass* (no in-scope fix to piggyback on), #2/#3 cannot be committed at all.

Confirming git state (`loanlight-api`):
- `git diff --name-only origin/main...HEAD -- .../bank-statement/CLAUDE.md` → **present** (file IS in the branch diff now)
- `scope.json.allowed_paths` → does **not** list `CLAUDE.md` (frozen at the older head)

## Impact

- anatomy-park's catalog pillar is effectively a no-op under `/pickle-pipeline` strict scope unless a trap door happens to ride along with an in-scope fix commit *before* the next clean pass.
- The convergence-flush step (skill `anatomy-park.md` Phase 3 step 5: "flush pending trap doors … write them all now, commit") will hit the same gate rejection at convergence and silently leave `trap_doors_added \ trap_doors_committed` stranded.
- Lost durable knowledge defeats the deterministic-replay design (`PATTERN_SHAPE` regexes never reach the repo, so future anatomy/citadel can't replay them).
- Severity is P3 (no incorrect product output; the *fix code* still commits correctly — only the documentation artifact is lost), but it quietly nullifies a headline anatomy-park feature.

## Proposed fix directions (capture-only — owner decides)

1. **Carve the trap-door catalog target out of the scope gate** as a recognized tool-output artifact: allow `<subsystem>/CLAUDE.md` (or, more narrowly, only its `## Trap Doors` section) through `check-scope-diff.js` when the staged change is an anatomy-park catalog commit. It is the tool's own deliverable, not scope creep.
2. **Refresh `allowed_paths` after each anatomy-park commit** so a just-written `CLAUDE.md` (now part of the branch diff) stays writable on subsequent iterations — fixes Layer 2 even without a carve-out, but Layer 1 (first-ever write on a pure clean pass) still needs #1.
3. **Convergence-flush escape:** at the flush step, if the only outside-scope staged path is the subsystem `CLAUDE.md`, permit the catalog commit (bounded, documentation-only) rather than deferring.

Recommended: **#1 + #2 together** — #1 removes the structural fence on the deliverable; #2 removes the self-inflicted staleness. Both are behavior-preserving for code edits (the fence on `*.ts`/source stays intact).

## Reproduction

1. Run `/pickle-pipeline` (or `/anatomy-park --scope branch`) on a feature branch whose diff does **not** include the target subsystem's `CLAUDE.md`.
2. Let anatomy-park identify ≥1 trap door on a clean pass (no in-scope fix in the same iteration).
3. Observe `anatomy-park.json` accumulates `trap_doors_added` while `trap_doors_committed` stays behind, with the worker logging deferral because `scope.json` excludes the `CLAUDE.md`.

## NOT in scope of this report

- The reprocess-findings product bug itself (already documented as a Linear comment on LOA-1387; the trap doors merely *describe* it).
- Loosening the scope fence for source files — that fence is correct; only the catalog deliverable should be exempt.

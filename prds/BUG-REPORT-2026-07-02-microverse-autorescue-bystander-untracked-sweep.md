# BUG REPORT — microverse worker-timeout auto-rescue stages ALL untracked files (no docs/prds exclude), sweeping a *foreign* session's untracked doc onto the feature branch

**Filed:** 2026-07-02 (surfaced babysitting the LOA-1570 First Colony Phase 2/3 pipeline; two clean pipeline runs, this fired on run 1)
**Code:** R-MACB (Microverse Auto-Commit Bystander-sweep)
**Priority:** P2 (branch/PR data-hygiene — commits *another* session's un-attributable work under the pipeline's auto-commit; recoverable via soft-reset, operator-visible at the ship gate, no silent data loss — but it pollutes the feature branch/PR with foreign WIP and can leak an unrelated session's files into review)
**Component:** `extension/src/bin/microverse-runner.ts` — `autoRescueDirtyTree` (~:3628) → `stageAutoCommitPaths(ctx.workingDir)` called with **empty** `excludePrefixes`

## Symptom (observed)

During the szechuan-sauce phase of the LOA-1570 pipeline (session `2026-06-30-456d1d79`), a microverse worker timed out with a dirty tree and no commit. The rescue fired:

```
[2026-07-01T02:27:00.785Z] No commits but dirty tree detected — auto-committing worker changes
[2026-07-01T02:27:01.191Z] Auto-committed: 6272304fc08d44401250abb58528cc06f38415d6
```

`6272304fc` staged **two** files:

```
docs/prd-statement-analyzer-asset-type-classification-v2.md | 129 +++++++++   ← FOREIGN (another session's untracked WIP)
prds/LOA-1570-first-colony-sharp-advantage-phase-2-3-PRD.md | 305 +++++++++++  ← this session's PRD
2 files changed, 434 insertions(+)
```

The `docs/prd-statement-analyzer-*.md` file belonged to a **different, concurrent effort** (LOA-1365 Statement Analyzer). It was sitting untracked in the shared checkout *before* this pipeline started and had nothing to do with LOA-1570. The rescue committed it onto the First Colony feature branch anyway. Caught only by manual `git log` inspection at the ship gate; removed via `git reset --soft HEAD~1` + `git restore --staged <foreign>`.

## Root cause (verified against source, not guessed)

`stageAutoCommitPaths(workingDir, excludePrefixes = [])` (`microverse-runner.ts:1197`) has **two** call sites with **asymmetric** exclude arguments:

| Call site | Line | `excludePrefixes` passed |
|---|---|---|
| Pre-flight auto-commit (`preflightAutoCommit`, before microverse start) | ~2947 | `PREFLIGHT_DIRT_EXCLUDES` ✓ (excludes docs/prds) |
| **Worker-timeout rescue** (`autoRescueDirtyTree`) | **~3628** | **`[]` (none)** ✗ |

With empty excludes, `stageAutoCommitPaths` runs `git add -u` (all tracked-modified) **then** scans `git status --porcelain -z`, collects every `?? ` (untracked) entry, and `git add`s each one — no prefix filter, no attribution/ownership check. So the worker-timeout rescue stages **every** dirty path in the working tree, including untracked files that pre-existed the session and belong to other work.

This also **violates the module's own documented invariant** (`extension/CLAUDE.md`, `microverse-runner.ts (auto-commit staging)` trap door):

> INVARIANT: auto-commit rescue stages tracked and untracked files via the shared staging helper **while honoring `docs/`/`prds/` exclusions**.

The `autoRescueDirtyTree` call site does **not** honor docs/prds exclusions — it passes none. The enforcing test (`extension/tests/microverse.test.js`) exercises the helper *with* excludes but does not pin the `:3628` rescue call site to pass them, so the divergence shipped.

## Relation to existing findings (this is a known class, fixed elsewhere)

This is the **microverse-side twin of B-PCOMP `#b736337f`** ("bystander stash-not-commit on exit"), already fixed on the **mux-runner** exit path. That trap door (`mux-runner.ts` + `extension/CLAUDE.md`) states:

> `commitGatePassingDeliverableOnExitPath` MUST NEVER whole-tree `git add -A` when the exit-path dirty set has un-attributable (foreign) paths … it calls `stashUnattributableRemainder` then stages ONLY positively-owned paths … BREAKS: the whole-tree-add fallback commits a sibling's work under THIS ticket's completion commit — a false Done worse than losing it.

The exact same failure mode (staging un-attributable bystander paths) exists in `autoRescueDirtyTree`, but the B-PCOMP `stashUnattributableRemainder` / owned-paths-only treatment was **never ported** to the microverse rescue path. Also adjacent: R-APWS/R-APXG (scoped microverse lets package-wide edits dirty out-of-scope files) — same "microverse touches paths it shouldn't own" family.

## Repro

1. Working tree has a pre-existing untracked file in an exempt segment (e.g. `docs/foo.md` or `prds/bar.md`) from unrelated work.
2. Launch `/pickle-pipeline` (clean-tree guard *exempts* docs/prds, so launch succeeds with the foreign file present).
3. Drive any microverse phase (anatomy-park / szechuan-sauce) worker to time out with a dirty tree and no commit (or synthesize by leaving worker output uncommitted at the ceiling).
4. `autoRescueDirtyTree` fires → `microverse: auto-commit (worker timed out before committing)` commit includes the foreign `docs/`/`prds/` file.

## Fix direction (capture-only — not built)

Port the B-PCOMP bystander pattern to `autoRescueDirtyTree`, one of:

1. **Minimum:** pass `PREFLIGHT_DIRT_EXCLUDES` (or the docs/prds excludes) to the `:3628` `stageAutoCommitPaths` call so the rescue matches the pre-flight call and the documented invariant. (Narrow; still sweeps foreign *non*-docs/prds untracked files.)
2. **Correct:** snapshot the dirty/untracked set at session start (bystander baseline) and stage only paths **added or modified during the session** (positively-owned), stashing the un-attributable remainder via the existing `stashUnattributableRemainder` helper — the same treatment `commitGatePassingDeliverableOnExitPath` already applies on the mux-runner exit path. Reuse, don't reimplement.

**ENFORCE (proposed):** extend `extension/tests/microverse.test.js` (or a new `microverse-autorescue-bystander.test.js`) to pin the `autoRescueDirtyTree` → `stageAutoCommitPaths` call site to exclude a pre-existing foreign untracked `docs/`/`prds/` file, and assert the auto-commit contains only session-owned paths. PATTERN_SHAPE: `stageAutoCommitPaths(ctx.workingDir` at the `:3628` rescue site MUST pass a non-empty exclude/owned-paths argument.

## Operator mitigation (until fixed)

Pre-clean the **whole** working tree before launch — stash *all* untracked files not part of the epic, not just the non-exempt ones the dirty-tree FATAL complains about (the guard blocks on non-exempt dirt but the rescue silently commits exempt-segment dirt). After any run, inspect `git log origin/main..HEAD` for a `microverse: auto-commit` commit and `git reset --soft HEAD~1` + restage if it swept foreign paths. (This is exactly how the LOA-1570 run was recovered.)

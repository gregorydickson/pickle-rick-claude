# BUG REPORT — scope-resolver trusts a stale/racing `refs/remotes/origin/main` → false `SCOPE_EMPTY_DIFF` → review phases run with NO scope.json

**Filed:** 2026-06-30 (surfaced babysitting a `/pickle-pipeline` run, session `2026-06-29-b6bab0c8`, LOA-1614 Textract POC)
**Code:** R-SSBR (Stale Shared Base Ref)
**Priority:** P2 (benign in THIS run, but directly enables the unresolved off-scope-commit class [[R-SSOC]] in shared multi-worktree repos — LoanLight's normal mode, ~30 live worktrees)
**Component:** `extension/services/scope-resolver.js` (`resolveDefaultBase` + `resolveAllowedFromDiffMode`); `extension/bin/pipeline-runner.js` scope-setup WARN demotion (CUJ-6a, ~:1442)

## Symptom (observed)

At `--scope branch` pipeline launch the runner logged, twice (both launch attempts):

```
scope-setup WARN: SCOPE_EMPTY_DIFF — No files changed between origin/main and HEAD for mode=branch (continuing; build phase may produce diff)
```

…even though the branch genuinely had a real diff vs `main` (5 commits / 12 files / ~1999 insertions at launch). Because the empty-diff branch throws **before** `writeScopeJson`, **no `scope.json` was ever written**, and **no per-phase `archive/scope.<phase>.json` was produced** for citadel / anatomy-park / szechuan-sauce — i.e. the three review phases ran with no scope file despite the operator explicitly choosing "lock to branch."

## Root cause (verified, not guessed)

`resolveDefaultBase()` (`scope-resolver.js:480`) is *correct*: it skips the branch's own upstream (the `upstream !== origin/${currentBranch}` guard) and falls back to `symbolic-ref refs/remotes/origin/HEAD` → `origin/main`. So `baseRef = origin/main` was right.

The defect is in **how the diff is then taken** (`resolveAllowedFromDiffMode`, `scope-resolver.js:137-163`):

```js
baseSha = getMergeBase(baseRef, 'HEAD', repoRoot);          // merge-base(origin/main, HEAD)
paths   = computeAllowedFromDiff(baseSha, headSha, repoRoot); // git diff --numstat base...HEAD  (three-dot)
if (allowed.length === 0) throw ScopeError('SCOPE_EMPTY_DIFF', ...);
```

It consumes **whatever the local `refs/remotes/origin/main` ref happens to point at, with no `git fetch` and no sanity check.** In a heavily-shared multi-worktree checkout (this repo has ~30 worktrees + concurrent sessions + graphite pushes — see [[reference_loanlight_api_shared_checkout_branch_race]]), that remote-tracking ref can be transiently **at or ahead of the feature branch's HEAD** at the instant scope resolves. When `merge-base(origin/main, HEAD) == HEAD`, the three-dot diff `HEAD...HEAD` is empty → false `SCOPE_EMPTY_DIFF`.

**Proof it is a stale-ref artifact, not a real empty diff** — the *identical* computation re-run later (origin/main has since advanced to its true tip `4556b75c7`, which does NOT contain the branch's work):

```
launch HEAD = 9b5b72757   origin/main now = 4556b75c7
git merge-base --is-ancestor 9b5b72757 origin/main      → exit 1   (HEAD NOT in origin/main)
git merge-base origin/main 9b5b72757                     → 777e0e0ce
git diff --numstat 777e0e0ce...9b5b72757 | wc -l         → 12       (NON-empty)
git merge-base --is-ancestor cf4ce649e origin/main       → exit 1   (porter commit NOT in main)
```

Same code, same commits — opposite result. The only variable is the local `origin/main` ref state at resolve time. So at launch, `refs/remotes/origin/main` must have been pointing at / ahead of `9b5b72757` (likely a concurrent fetch/push or graphite ref update mid-run).

## Impact

- **The `--scope branch` choice silently became a no-op for the whole run.** No `scope.json` ⇒ citadel / anatomy-park / **szechuan-sauce** had no allow-list. The review phases are then free to roam the entire monorepo, and **szechuan-sauce auto-commits cleanups** — exactly the off-scope-commit hazard [[R-SSOC]] the scope lock exists to prevent.
- **Benign in THIS run, by luck only.** Audited all 29 branch commits incl. szechuan's `0a5037078`: every touched file is inside the LOA-1614 feature surface — zero off-scope escapes. But that held *only because the worktree contained nothing but the feature work*, so szechuan had nothing unrelated to wander into. A worktree carrying any unrelated change would have let the review phases roam and commit off-scope, undetected.
- **The CUJ-6a WARN demotion is correct design and is NOT the bug** — an empty branch diff is legitimately possible pre-build, so warn-and-continue is right. The bug is the *false* empty that feeds it: a racy ref produces a phantom "no review surface," and the design's benign-continue then masks that the scope lock was lost.

Not reproduced deterministically (depends on concurrent ref timing); the post-hoc git repro above is the deterministic evidence.

## Fix direction (reuse-first; no new machinery)

1. **Ancestry sanity-check before trusting the base** (smallest, highest-value): in `resolveAllowedFromDiffMode`, after `getMergeBase(baseRef,'HEAD')`, if `baseSha === headSha` (i.e. `HEAD` is an ancestor of `baseRef`), the base ref is suspect for a feature branch — do NOT emit `SCOPE_EMPTY_DIFF`. Instead fall back to a non-racy base: local `main`/`master`, or the branch's fork-point (`git merge-base --fork-point`), or refuse with a distinct `SCOPE_BASE_AHEAD_OF_HEAD` error so the operator/runner can react rather than silently proceed unscoped.
2. **Optionally refresh the base ref first** — a single `git fetch origin <defaultBranch>` (or read the fork-point) before resolving, so a stale local remote-tracking ref can't drive the diff. Guard with a short timeout; on fetch failure keep going with the local ref (no regression vs today).
3. **Fail safic, not open, when the lock is requested** — if `--scope branch` was explicitly chosen and resolution yields empty, the runner should NOT proceed *unscoped*; either retry resolution after the build's first commit, or hold the review phases until a non-empty scope exists, or downgrade-with-loud-banner rather than silent WARN. Today `SCOPE_EMPTY_DIFF` → WARN → no scope.json → unscoped review is a fail-OPEN on a safety boundary.

Add a `scope-resolver` unit test: base ref at/ahead of HEAD must NOT yield `SCOPE_EMPTY_DIFF` for a branch with a real fork-point diff.

**Cross-links:** amplifies [[R-SSOC]] (szechuan soft-scope-escape — the off-scope-commit class this would unleash); shares the shared-worktree-ref-race root with [[reference_loanlight_api_shared_checkout_branch_race]]. The B-ARBR idea (tune szechuan to drive off-scope-commit rate → 0) assumes the scope lock actually holds — R-SSBR is a way it silently does not.

# BUG REPORT 2026-07-27 — R-GADEL: B-GITATTR's WS-3 deletion left NO attribution fallback

**Priority:** P1 — **release blocker for beta.8**
**Found:** by the full release gate at `c457e943`, 2026-07-27. `GATE_RESULT=RED`, `FAILED_STAGE=test-integration`, **10 failures**.
**Status:** open, unfixed. Nothing reverted; main tree clean.

---

## Bisected to the exact bundle

| Commit | Meaning | `boundary-commit-at-iteration.test.js` |
|---|---|---|
| `00765390` | pre-B-GITATTR | **5/5 pass** ✓ |
| `a7d6d9ec` | B-GITATTR HEAD | **3 fail** ✗ |
| `c457e943` | post R-GTDT-LAND | fail ✗ |

Run in a detached worktree at each commit with a fresh `npm ci`. **B-GITATTR introduced it.
R-GTDT-LAND did not** — that bundle's own work is clean (fast tier 5/5 runs at 0 failures, all 9 audits
green, its release blocker closed and field-proven).

## The 10 failures

```
tests/characterization/completion-commit-cluster/path-2-worker-autofill-belt-and-suspenders.test.js:52
tests/characterization/completion-commit-cluster/path-3-manager-drift-auto-completion-validation.test.js:76
tests/characterization/completion-commit-cluster/path-7-phantom-done-watcher-backfill.test.js:74
tests/boundary-commit-at-iteration.test.js:69, :102, :176
tests/doneflip-gate-all-callsites.test.js:118
tests/wuwc-reproducer.test.js:305
tests/mux-exit-path-commit.test.js:79
tests/exit-path-bystander-stash.test.js:67
```

The completion-commit-cluster suite is described in `extension/CLAUDE.md` as **"the primary regression
guard for the 8 Done-stamping paths"** carrying an explicit release-gate invariant: *"These tests MUST
pass on every release."*

## Root cause

B-GITATTR WS-3 deleted the message-inference surface — `scanGitLogByRefToken`, `scanGitLogByFileTouch`,
`extractRCodeTokens`, `touchesDeclared`, `commitTouchedFiles`, `enumerateSiblingDeclaredFiles` — on the
thesis that the `Pickle-Ticket` trailer replaces it.

**Message inference was the FALLBACK.** With it gone, a commit that carries no parsed trailer has **no
attribution path left** through the git-log scan. The explicit `completion_commit` field and the zero-diff
arm survive, but the scan fallback does not.

## Why this was structurally invisible

1. **Tier mismatch.** Every failing file is `@tier: integration`. The worker gate runs `test:fast`. **No
   worker could ever have seen this**, no matter how careful.
2. **No full gate ran.** B-GITATTR's pipeline was pickle → citadel → anatomy-park → szechuan. The last
   full release gate was beta.7, *before* the bundle. The regression had no opportunity to surface until
   today.

This is the "worker gate masks fast-tier debt" pattern with the tier boundary as the mask. The release
gate did its job — it is the only instrument positioned to catch this class.

## Do NOT reflexively update the tests

Two failure messages indicate substance rather than staleness:

- **`guard must ATTRIBUTE-to-Done an untagged worker commit`** — an untagged commit is exactly the case
  the deleted fallback existed to handle. Today's evidence shows untagged commits are real and common:
  `b4dbd528` landed with an EMPTY parsed trailer, and 7 consecutive commits did the same in the prior
  session.
- **`expected committed, got honest_failure/commit-failed`** — a commit *failing*, not merely going
  unattributed. That is not explained by "the test asserts an old contract."

**Rewriting the guard suite to match current behaviour is how a genuine Done-stamping regression gets
masked** — precisely the move that created R-GTDT, where a test encoded the bug as the contract. This
bundle should not repeat it.

## The question to answer BEFORE choosing a fix

> **Does the trailer channel actually cover every case message inference covered?**

Enumerate the cases the deleted passes handled, and for each, state whether the trailer covers it and by
what mechanism. Only then decide:

- **(a)** the trailer genuinely covers all of them → the tests assert a dead contract and are updated,
  with the reasoning recorded per test; or
- **(b)** it does not → a fallback must be restored for the uncovered cases, which is a partial revert of
  WS-3 and should be stated as such.

Answering that is the deliverable. Choosing (a) without the enumeration would be a fake green.

**Known gap feeding this:** the trailer producer only just shipped, and the hook that stamps most commits
was **deployed for the first time today** (ticket 20 of R-GTDT-LAND). Any commit made before that deploy,
by any path that bypasses the hook, or when the hook fails, is untagged — and now unattributable by scan.

## Not doing now, and why

The gate is red, so **beta.8 is not taggable** and nothing is being shipped over it. R-GTDT-LAND's own
work is verified and committed. No test was rewritten, no fallback restored, nothing reverted — this is
a design decision that deserves the enumeration above rather than an end-of-day patch.

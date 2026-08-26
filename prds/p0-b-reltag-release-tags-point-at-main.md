# B-RELTAG — every release since April has built the WRONG TREE: tags point at `main`, not the release branch

**Priority:** P0 (release integrity — the version number currently means nothing)
**Type:** bundle (bug)
**Branch:** `release/v2.1-beta`
**build_mode:** unattended.

## Measured root cause (2026-08-26, decisive)

```
v2.1.0-beta.16  ->  e0c91e17
v2.1.0-beta.17  ->  e0c91e17     <- IDENTICAL
origin/main     ->  e0c91e17     <- both tags point HERE
origin/release/v2.1-beta -> c48212d1   <- where the work actually is
```

`gh release create <tag>` **without `--target` tags the repository's DEFAULT BRANCH.** `main` sits at
**`2.0.0-beta.47`** — a stale 2.0 line. `release.yml` triggers on `push: tags: v*` and checks out the
tag, so it faithfully builds `main` and fails on it, while the actual work lives on
`release/v2.1-beta` and is never built by CI at all.

**Confirmed in the beta.17 release log**, which reports a version nobody shipped:

```
> pickle-rick-scripts@2.0.0-beta.47 test:fast:budget
FAIL_BUDGET_EXCEEDED failures=3 budget=2 runs_completed=3 runs_requested=5
```

That `FAIL_BUDGET_EXCEEDED` is **not** a second defect: `main` predates the bun-probe fix, so CI is
hitting the OLD inherited failure on the OLD tree. One cause, not two.

**Blast radius:** Release 15/15 red, CI 11/11 red, **zero successes in 20 workflow runs**; last
release-workflow success **2026-04-22**. Every green gate reported since then was measured on a
developer machine against a tree CI never saw.

## The detection failure is the real lesson

`git ls-remote --tags origin <tag>` was run after BOTH beta.16 and beta.17 as the "verify the tag
pushed" step. It printed `e0c91e17` both times. **A verification that confirms existence without
comparing to an expected value is not a verification** — the same defect class as `isBaselineSha`
comparing spelling instead of commit identity (closed in beta.17), applied to the release procedure.

## Acceptance criteria

- **AC-R1 — the workflow REFUSES a mismatched tree.** `release.yml` fails loudly, as its FIRST
  substantive step, when the checked-out `extension/package.json` version does not match the tag that
  triggered it (`v2.1.0-beta.17` ⇒ `2.1.0-beta.17`). Today it silently builds whatever it received.
  The error names both values.
- **AC-R2 — the release procedure targets an explicit commit.** `CLAUDE.md`'s Versioning section and
  any release runbook state that the tag MUST be created at the release branch head — `--target
  $(git rev-parse HEAD)`, or push the tag from the branch before creating the release. A doc-only fix
  is acceptable here; AC-R1 is the enforcement.
- **AC-R3 — a test pins the tag↔version contract.** A test asserts the workflow contains the guard
  from AC-R1 and that the guard compares the tag to the package version. Pin it the way
  `release-gate-parity.test.js` pins the gate command string.
- **AC-R4 — existing mis-pointed tags are reconciled.** `v2.1.0-beta.16` and `v2.1.0-beta.17` both
  point at `main`. Either retag at the correct commits or annotate both releases stating which tree they
  actually describe. Do NOT silently delete published tags.
- **AC-R5 — verification compares, never merely confirms.** Any release-verification step that reads a
  sha must compare it to an expected value and fail on mismatch. Existence checks are banned as
  verification.
- **AC-R6 (report-only, non-gating)** No new halt path (PRIME DIRECTIVE). AC-R1 refuses a LOCAL
  action — this build — and does not add an abort condition to the pipeline runtime.

## Non-goals

- Merging `release/v2.1-beta` into `main`, or changing the branching model. That is a separate decision
  and this bundle must not make it implicitly.
- Fixing whatever CI failures remain once it builds the RIGHT tree. Those are unknown until AC-R1 lands
  and cannot be scoped honestly before then.

## Simplification Review

1. **Necessary?** Without it the version number is decorative and CI measures a tree nobody ships.
2. **Reuse?** AC-R3 follows the existing `release-gate-parity.test.js` pinning pattern.
3. **Guards brittle complexity?** AC-R1 is one comparison at one seam — the smallest thing that makes a
   wrong-tree build impossible rather than merely unlikely.
4. **Subtracts?** A class of silent wrong-tree builds, and a verification ritual that verified nothing.

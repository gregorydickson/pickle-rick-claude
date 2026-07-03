# P3 Bug-Fix Bundle — B-SCOPESEED: pickle-phase branch-scope seeding (R-SSPB) + standup author resolution (R-PSAM)

**Priority:** P3 (two operator-facing correctness defects; no data loss, no runtime-recovery surface)
**Codes:** R-SSPB (scope), R-PSAM (reporting)
**Backend:** codex (doubles as a GA-soak rep on the beta.37 single-seam runtime)
**Build-safety note:** Pipeline-safe — NO salvage / completion-evidence / Done-flip path is touched, so the
R-PSRB hand-build protocol does NOT apply. WS-1 edits the setup-time scope seam in
`extension/src/bin/pipeline-runner.ts`; the running pipeline executes deployed JS, not this diff.
**Complexity tiers:** WS-1 `complexity_tier: medium` (runtime + tests). WS-2 `complexity_tier: small`
(prompt-only command-file edit).

---

## Context

Two open capture-only findings from the 2026-07-01 babysitter window (sources:
`BUG-REPORT-2026-07-01-standup-git-author-me-drops-local-branch-tickets.md` and the B-SIGFH codex
GA field-soak findings in `MASTER_PLAN.md`).

**R-SSPB.** Launching `/pickle-pipeline --scope branch` from `main` resolves the build (pickle) phase
scope at SETUP time, before the build's own commits exist. `setupScope`
(`extension/src/bin/pipeline-runner.ts:1730`) calls `resolveScope` and either (a) persists a
`scope.json` whose `allowed_paths` reflect only the PRE-BUILD diff — fencing workers out of the very
files their tickets target — or (b) hits the demoted `SCOPE_EMPTY_DIFF` WARN path and returns `null`
(unscoped). The review-phase scope REFRESH is correct (it runs after the build commits exist); only
the build-phase seeding is wrong. Live incident: B-SIGFH soak, patched by hand-broadening
`scope.json` mid-run.

**R-PSAM.** `/pickle-standup` Step 2.5's commit scan runs
`git log --all --author="@me"` — but `@me` is a `gh` CLI idiom that git never resolves; the regex
matches nothing, so every un-PR'd local-branch ticket is silently dropped from Y:. Deterministic
proof in the bug report: same repo/window, `@me` → 0 commits, resolved email → 28. The adjacent
`gh pr list --author "@me"` lines are CORRECT and must not change.

---

## WS-1 — R-SSPB: seed the pickle-phase branch scope from the ticket file-impact set

### Problem
At build-phase setup on `main`, the branch-diff scope is empty or pre-build-stale; the tickets
themselves already declare what the build will touch, but that knowledge never reaches `scope.json`.

### Fix
In `setupScope` (`extension/src/bin/pipeline-runner.ts`), for the BUILD-phase resolution only: when
the resolved branch/diff scope is empty (the `SCOPE_EMPTY_DIFF` warn path) or its `allowed_paths` is
empty, seed/union the session tickets' declared file-impact paths into `allowed_paths` before
persisting `scope.json`. Research phase must identify the canonical per-ticket file-impact source
(refinement manifest ticket entries and/or ticket-file sections such as "Files to modify"/"Files to
create"); if no structured field exists, derive the set from ticket bodies. Emit a LOG LINE
(`scope-setup: seeded pickle-phase scope from ticket file-impact (<n> paths)`) — do NOT add a new
activity event (event registration is a recurring closer-bug class; a log line is sufficient
observability here).

Constraints:
- `extension/src/services/scope-resolver.ts` fail-closed invariants (R-SSBR `SCOPE_BASE_AHEAD_OF_HEAD`,
  clamps, one-hop caps) are UNTOUCHED — the fix lives at the pipeline-runner seeding call-site.
- Review-phase `refreshScope` behavior unchanged.
- No new state field, no new flag, no new skip surface.

### Acceptance criteria (machine-checkable)
- **AC-SSPB-01:** New test `extension/tests/pipeline-scope-ticket-seed.test.js` proves: a branch-scope
  session on a fixture repo whose HEAD equals the scope base (pre-build, empty diff), with tickets
  declaring file impacts, produces a persisted `scope.json` whose `allowed_paths` includes the ticket
  file-impact paths (build phase no longer unscoped/mis-scoped).
- **AC-SSPB-02:** The same test proves a NON-empty resolved diff is NOT overwritten — seeding only
  unions when the resolved branch scope is empty/pre-build; an explicit `paths:`-mode scope is never
  touched.
- **AC-SSPB-03:** `checkScopeDiff` over a staged file inside the seeded file-impact set returns
  in-scope (workers are not fenced out) — asserted in the new test.
- **AC-SSPB-04:** No new activity event: `git diff` for WS-1 contains no edit to
  `VALID_ACTIVITY_EVENTS` / `activity-events.schema.json`.
- **AC-SSPB-05:** Existing scope suites stay green: `extension/tests/scope-pipeline.test.js`,
  `extension/tests/scope-refresh.test.js`, `extension/tests/scope-resolver-base-ahead.test.js`.

## WS-2 — R-PSAM: resolve `@me` to the real git identity in the standup commit scan

### Problem
`.claude/commands/pickle-standup.md` Step 2.5 copies the `gh` `@me` idiom into `git log --author`,
which git treats as a literal regex — the scan matches nothing and silently under-reports local-branch
work.

### Fix
Prompt-only edit to `.claude/commands/pickle-standup.md` Step 2.5: resolve
`ME_EMAIL="$(git -C "$repo" config user.email)"` per-`$repo` and pass it to `--author="$ME_EMAIL"`;
add a one-line guard instructing that an empty resolved identity warns and skips the scan for that
repo (an empty `--author=` matches ALL commits — the opposite failure). Leave every
`gh pr list --author "@me"` line unchanged. No README change (internal scan mechanics; command
surface unchanged).

### Acceptance criteria (machine-checkable)
- **AC-PSAM-01:** No `git log` invocation in `.claude/commands/pickle-standup.md` carries the literal
  `@me`: `grep -n 'git .*log' .claude/commands/pickle-standup.md | grep -c '@me'` → `0`.
- **AC-PSAM-02:** Step 2.5 resolves the identity via `git config user.email` (grep finds
  `config user.email` in the Step 2.5 block) and interpolates it into `--author`.
- **AC-PSAM-03:** The `gh pr list --author "@me"` lines are unchanged:
  `grep -c 'gh pr list --author "@me"' .claude/commands/pickle-standup.md` is unchanged vs HEAD.
- **AC-PSAM-04:** The Step 2.5 block contains an explicit empty-identity guard (warn + skip when the
  resolved email is empty).

---

## Simplification Review (subtract-before-add)

1. **Necessary at all?** WS-1 adds one seeding branch at the EXISTING `setupScope` seam — no new
   module, flag, gate, state field, or activity event. WS-2 adds nothing: it is a pure correction of
   a wrong token in a prompt file.
2. **Reuse instead of add?** WS-1 reuses `resolveScope`, the existing `scope.json` persistence, and
   data the session already owns (ticket file-impact declarations); it does NOT build a parallel
   scope mechanism. WS-2 reuses `git config user.email` — git's own identity source.
3. **Guarding brittle complexity that should be subtracted?** No. The scope fence itself is sound and
   stays; R-SSPB is a wrong-INPUT bug (pre-build diff fed to a correct fence), so the honest fix is
   to fix the input — explicitly NOT a new skip flag or escape hatch around the fence.
4. **What does this subtract?** WS-1 retires the operator hand-patch-`scope.json`-mid-run recovery
   recipe (a manual babysitter intervention class). WS-2 deletes a dead filter — the `@me` author
   regex that has never matched a commit.

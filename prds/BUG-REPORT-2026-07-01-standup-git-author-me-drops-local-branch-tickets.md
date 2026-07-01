# BUG REPORT — `/pickle-standup` commit scan uses `git log --author="@me"`, which git never resolves → every local-branch (un-PR'd) ticket is silently dropped from Y:

**Filed:** 2026-07-01 (surfaced running `/pickle-standup` for Gregory; LOA-1570 First Colony Phase 2/3 had real in-window commits on a checked-out branch but never appeared until the operator named it)
**Code:** R-PSAM (Pickle Standup Author-`@me`)
**Priority:** P3 (accuracy defect in a reporting skill; no runtime/data impact — but it silently under-reports shipped work, the one thing the skill exists to prevent)
**Component:** `.claude/commands/pickle-standup.md` — Step 2.5 "Commit-level LOA-### scan", line ~36

## Symptom (observed)

Step 2.5's commit scan is specified as:

```bash
git -C "$repo" log --all --author="@me" --since="$START" --pretty="%H %ci %s%n%b" \
  | grep -oE '\bLOA-[0-9]+\b' | sort -u
```

Run across all auto-discovered repos it returned **zero** `LOA-###` matches — "Bash completed with no output" — despite the operator having 3 in-window commits on the checked-out branch `gregory/loa-1570-...` (First Colony health/safety appraisal rules + credit bundle overrides, committed 2026-06-30/07-01). LOA-1570 therefore never entered the Step-4 join and was absent from Y: until the operator manually said "1570 in flight."

The whole point of Step 2.5 (R-PSU-3 / AC-PSU-03) is to catch tickets whose only in-window signal is a **new commit** — un-PR'd local-branch work is exactly its target case. The scan covers *nothing* instead.

## Root cause (verified, not guessed)

`--author="@me"` is a **`gh` CLI idiom**, not a git one. `git log --author=<pattern>` treats `<pattern>` as a regex matched against the commit author name/email. Git does **not** expand `@me` to the current user — so unless an author literally contains the string "@me", the filter matches nothing and the scan returns empty on every repo.

The skill copied the `@me` token from the adjacent `gh pr list --author "@me"` lines (Step 3), where it *is* valid (gh resolves it to the authenticated user). It does not carry over to `git log`.

**Deterministic proof** (`loanlight-api`, same window, same repo):

```
git config user.email                                              → gregory.d.dickson@gmail.com
git log -1 --pretty="%an <%ae>" dd5f73d9d  (LOA-1570 commit)       → Gregory Dickson <gregory.d.dickson@gmail.com>

git log --all --author="@me"                        --since=2026-06-30 --oneline | wc -l   → 0
git log --all --author="gregory.d.dickson@gmail.com" --since=2026-06-30 --oneline | wc -l   → 28
```

Same command, same window — `@me` yields 0, the real email yields 28. The only variable is the author token.

## Impact

- **Under-reports the operator's own shipped work.** Any ticket whose sole in-window evidence is a commit on a not-yet-PR'd local branch is dropped. Merged-PR and open-PR tickets still surface (Step 3 uses `gh`, where `@me` works), so the failure is silent and partial — the standup *looks* complete. Local-branch / pre-push work is precisely the fast-factory case the commit scan was added for.
- **Masks drift.** LOA-1570 was `Todo` in Linear with committed code — exactly the Rule-7 drift the skill is supposed to flag. Because the ticket never entered the join, the drift-signal footer never fired either.
- No runtime, data, or scope impact — this is a reporting-accuracy defect in a read-only skill.

## Fix (proposed — trivial, prompt-only)

Resolve `@me` to the real git identity before the commit scan. Git has no built-in "me," so derive it once:

```bash
ME_EMAIL="$(git -C "$repo" config user.email)"     # or a repo-independent `git config user.email`
git -C "$repo" log --all --author="$ME_EMAIL" --since="$START" --pretty="%H %ci %s%n%b" \
  | grep -oE '\bLOA-[0-9]+\b' | sort -u
```

Notes for the fix:
- Only the **`git log`** line (Step 2.5) is wrong. The `gh pr list --author "@me"` lines (Step 3) are correct — `gh` resolves `@me`; leave them.
- `git config user.email` can differ per repo; resolving it per-`$repo` (as above) is safest across the auto-discovered set. A single global `git config user.email` is an acceptable simpler variant if per-repo identities are not in use.
- Consider a one-line guard: if `ME_EMAIL` is empty, `log()` a warning rather than silently scanning with an empty author (which matches *all* commits — the opposite failure).

## Acceptance criteria

- [ ] Step 2.5's `git log` uses a resolved author identity (e.g. `git config user.email`), not the literal `@me`.
- [ ] Running the scan over a repo with an in-window, un-PR'd local-branch commit authored by the operator surfaces that ticket's `LOA-###`.
- [ ] The `gh pr list --author "@me"` lines are left unchanged.
- [ ] A missing/empty resolved identity warns instead of silently matching all authors.

## Repro

1. On any repo, commit an `LOA-####`-referencing commit to a local feature branch, do **not** open a PR.
2. Run `/pickle-standup` inside the window covering that commit.
3. Observe the ticket is absent from Y: (Step 2.5 scan returns nothing). With the fix, it appears in Y: with `commit_in_window` ship-basis.

Show a Linear-keyed standup from Pickle Rick activity + Linear MCP cross-reference.

Persona active via CLAUDE.md. **SPEAK BEFORE ACTING**.

## Instructions

### Step 1: Run the activity helper

```bash
node ~/.claude/pickle-rick/extension/bin/standup.js $ARGUMENTS
```

If no arguments provided, defaults to `--days 1` (since yesterday 00:00 — INCLUDES today's commits to current time). Save the output mentally — the user does NOT see it; you must surface findings yourself.

### Step 2: Pull Linear ground truth (parallel with Step 3)

The Linear team is `Loanlight-eng` (prefix `LOA-`). Use the Linear MCP — do NOT regex commits as your primary source.

```
mcp__plugin_linear_linear__list_issues
  assignee: "me"
  updatedAt: "-P{N+1}D"   // N = the --days value, +1 day of slack
  orderBy: "updatedAt"
  limit: 50
```

For each returned issue, capture: `identifier` (`LOA-NNN`), `title`, `state.name`, `completedAt`, `gitBranchName`, `updatedAt`.

### Step 2.5: Commit-level LOA-### scan (highest-leverage; parallel with Steps 2 + 3)

R-PSU-3 / AC-PSU-03. The Linear-first algorithm misses old tickets that received NEW commits in-window — `list_issues` filters by `updatedAt`, but a 3-week-old `LOA-661` ticket with a new commit yesterday won't surface unless its Linear status was touched. Cover the gap with a commit-message scan.

For each auto-discovered repo (Step 3), run:

```bash
ME_EMAIL="$(git -C "$repo" config user.email)"
[ -n "$ME_EMAIL" ] || { echo "warn: missing git user.email for $repo, skip commit scan" >&2; continue; }
git -C "$repo" log --all --author="$ME_EMAIL" --since="$START" --pretty="%H %ci %s%n%b" \
  | grep -oE '\bLOA-[0-9]+\b' \
  | sort -u
```

Dedupe across repos. For each unique `LOA-###`, call `mcp__plugin_linear_linear__get_issue` to fetch its current Linear state, completedAt, gitBranchName. Merge into Step 4's join algorithm. **A ticket discovered ONLY via this scan (not in the Step 2 list_issues recent set) should still surface in Y:**, with the existing Rule 7 drift annotation if its Linear `state` lags shipped code.

### Step 3: Pull PRs — merged AND open (parallel with Steps 2 + 2.5)

Run BOTH queries. Open PRs are not optional — a major work stream often lives on an open PR for days, and a merged-only query misses it entirely.

R-PSU-2 / AC-PSU-02. The open-PR query MUST drop `--search "updated:>=..."` because GitHub's `updated` predicate misses PRs whose only recent activity was new commits (no comment/label/title change). Replace it with a JS-side filter on `commits[].committedDate`:

```bash
# Merged in window — search-side filter is fine here (mergedAt is the canonical signal)
gh pr list --author "@me" --state merged --search "merged:>=$(date -v-{N}d +%Y-%m-%d)" \
  --json number,title,headRefName,mergedAt --limit 30

# Open — pull all recent open PRs and filter by commits[].committedDate locally.
# This catches in-flight epics whose `updatedAt` is OUT-of-window but whose latest
# commit is IN-window (common: long-running PR with daily pushes, no comment churn).
gh pr list --author "@me" --state open --json number,title,headRefName,commits --limit 30 \
  | jq --arg start "$START" '.[] | select((.commits[-1].committedDate // "") >= $start)'
```

R-PSU-4 / AC-PSU-04. **Auto-discover repos instead of hardcoding them.** Skill ran into a hardcoded `loanlight-app/` that doesn't exist locally — the failed `gh` cancels parallel siblings. Use:

```bash
for d in /Users/gregorydickson/loanlight/*/; do
  [ -d "$d/.git" ] && [ "$(basename "$d")" != "pickle-rick-claude" ] && echo "$d"
done
```

Each `gh pr list` invocation MUST be wrapped in `|| true` so a missing repo / auth failure on one repo doesn't kill the standup.

### Step 4: Join — Linear-first algorithm

For each Linear issue from Step 2, find its activity in priority order:
1. **Branch match**: any commit/session in the helper output with `branch === issue.gitBranchName` (strongest)
2. **Merged PR title/headRef match**: any merged PR (Step 3, merged set) whose title or `headRefName` contains `issue.identifier`
3. **Open PR title/headRef match**: any open in-window PR (Step 3, open set) whose title or `headRefName` contains `issue.identifier` → **Y:** match with `(in flight, PR #NNN)` suffix
4. **Commit-subject match**: any commit subject containing `issue.identifier`

A ticket with at least one match → goes in **Y:**. A ticket with no match but with `state in (Todo, In Progress)` → goes in **T:**.

Tickets matched via merged PRs keep current behavior (no parenthetical needed unless drift). Tickets matched only via an open PR get the `(in flight, PR #NNN)` suffix so the team knows the work is shipped-to-PR but not yet merged.

**R-SSWM-1 / R-SSWM-2 — Ship-basis classification (merge ≠ deploy).** Y: membership requires an **in-window merge or commit event** — match (1) branch, (2) merged-PR-in-window, (3) open-PR-in-window, or (4) commit-subject above. A Linear `completedAt` / `In Prod` / `Deployed-to-Int` status **alone** is NOT sufficient for Y:: a prod deploy flips `completedAt` when it carries *already-merged* code to production, often days after the PR merged. Classify each candidate's strongest in-window evidence as a `ship_basis`:

| `ship_basis` | Evidence | Y: disposition |
|:--|:--|:--|
| `merged_in_window` | merged PR in the `merged:>=START` set | Y: (canonical) |
| `commit_in_window` | commit in the `--since=START` scan | Y: |
| `open_pr` | in-window open PR | Y: with `(in flight, PR #NNN)` |
| `deploy_only` | in-window `completedAt` **and** no merge/commit match | **dropped from Y: by default** |

A `deploy_only` ticket (its only in-window signal is a status flip) is **dropped from Y: by default**. If the operator explicitly wants it, list it under a distinct **`Reached production this window (built earlier)`** heading — never interleaved with merged-this-window lines. (Worked example: a single 2026-06-12 deploy stamped LOA-701/731/992/993 with same-day `completedAt` but none had an in-window merge — all four are `deploy_only`, absent from Y:.)

Anything in helper output that doesn't map to a Linear ticket → drop, unless the user asked for raw output.

### Step 5: Format

Match the user's preferred style exactly. Plain text, no markdown headers, no project tags, no timestamp line:

```
Y:
 LOA-### — One terse sentence describing the user-visible outcome.
 LOA-### — One terse sentence.

T:
 LOA-### — Brief scope note in plain prose.
 LOA-### — Brief scope note (parenthetical only when useful, e.g. "infra").
```

**Rules:**
1. Lead each line with the Linear ticket ID. Em-dash separator preferred (` — `), but hyphen or no separator are both acceptable.
2. One short sentence per ticket. User-impact language (what changed for a user / admin / operator), not internal component names.
3. NO `**[project-tag]**` prefix. NO bold. NO timestamp header (`Gregory Dickson [8:14 AM]`). NO date range header.
4. Skip internal Pickle Rick churn — these don't belong in the team standup. They surface only if the user explicitly asks for `--raw` or "full output". Explicit drop list (events/sessions to filter from helper output before mental processing):
   - `gate_out_of_scope_failures_present`
   - `gate_skipped`
   - `pickle-process-outcome-*` sessions (any duration, including 0m)
   - anatomy-park trap-door logs and szechuan decomposition entries
   - microverse iteration/rollback events
   - meeseeks pass summaries
   - any session with 0m duration whose name starts with `pickle-`, `gate-`, `anatomy-`, `szechuan-`, `meeseeks-`, or `microverse-`
5. **Y:** = tickets with an **in-window merge or commit event** (commits/PRs/sessions matched per Step 4). Use the Linear `state` to disambiguate done vs. in-flight — but a Linear `completedAt` status flip **alone** is NOT sufficient for Y: (see Step 4 ship-basis: a `deploy_only` ticket is dropped). Status disambiguates; it never *qualifies* a ticket for Y:.
6. **T:** = concrete next tickets (Todo / In Progress, assigned to user, recently updated). 3-6 items max — pick the ones most likely to be worked next.
7. Drift signal: if a ticket's code clearly shipped but the Linear status is still Todo/In Progress, mention it in the Y: line ("LOA-656 — UI Unit Details + Income Approach cards shipped (Linear still Todo)") so the user can update Linear.
8. **Translate jargon before writing.** If a PR title is jargon (matches `/szechuan|anatomy-park|trap door|microverse|plumbus|meeseeks|pickle|morty|council of ricks/i`, is shorter than 25 chars, or is a bare kebab-slug), run `gh pr view <N> --json title,body` and rewrite in user-impact language.
9. Teammate PRs (`## Teammate PRs merged` from the helper) are informational only. Never attribute to the user. Default: omit. If notable, append one footer line after **T:**: `Team shipped: <one-liner each, with author>`.
10. If the user asks for raw / full output, print the helper output verbatim instead of this format.
11. **Product-voice self-check (final lint pass).** After drafting each Y/T line, re-read it as if you were a non-engineer stakeholder. Reject and rewrite any line that contains:
    - file/component names (`*.tsx`, `*.spec.ts`, `FooBar.module.css`)
    - tooling/process jargon: `prettier`, `lint`, `eslint`, `IDOR`, `throttle`, `decorator`, `--fix`, `--no-verify`, `tsc`
    - PR-merge phrasing: `via #NNN merge`, `landed on PR`, `merged in`, `cherry-picked`
    - any technical noun without a paired user-/admin-/operator-impact verb
    Each line must describe the change a human consumer of the product notices. Examples:
    - ❌ "Combination rules fix landed via #1219 merge"
    - ✅ "Compound (AND/OR) custom rules now save and evaluate correctly — wizard no longer silently fails to advance"
    - ❌ "Fixed IDOR in throttle decorator (audit.controller.spec.ts)"
    - ✅ "Closed an auth bypass on audit endpoints — users can no longer trigger another lender's audits"
12. **Epic grouping.** When 3+ tickets share the same Linear project AND all matched via the same PR (merged or open), collapse them under one parent line: `LOA-X / LOA-Y / LOA-Z — <project user-impact summary> (PR #NNN in flight)` (or `(shipped via PR #NNN)` for merged). Default stays per-ticket; group only when 3+ tickets would otherwise produce repetitive lines. Order ticket IDs by ascending number.
13. **Open-PR drift footer.** After **T:**, if any user-authored open in-window PR carries tickets still in `Todo` or `In Progress` (i.e. not yet `In Review` / `Done`) in Linear, append a single footer line:
    ```
    Drift signal: LOA-### / LOA-### — In Progress in Linear but shipped on PR #NNN; flip when ready.
    ```
    One footer line per open PR with drift. This is distinct from Rule 7 (which handles merged-but-not-closed drift inline on the Y: line). Skip the footer entirely when no open PR has Linear drift.
14. **R-SSWM-3 — read the ticket description before describing.** Before composing a Y:/T: product-voice line, **read the ticket description** (not the title alone) via `mcp__plugin_linear_linear__get_issue` and write the line from the ticket *body*. Titles routinely mislead: they are short, jargon-laden, or describe the trigger rather than the work. Counter-example (observed 2026-06-12): **LOA-731** is titled "Test YAML from database in production" but its description is a *production shadow-audit equivalence harness* — writing the Y: line from the title alone produced the wrong "rules load from the DB" description. If the description and title disagree, the description wins.

### Example

```
Y:
 LOA-618 — Appraisal Comparison hardened and rebased, PR reviewed/fixed/merged.
 LOA-697 — Fixed appraisal images.
 LOA-652 / LOA-656 / LOA-661 — 1025 Appraisal Extraction Support: extractor pulls subject + comp data into the audit screen for reviewers (PR #1217 in flight).

T:
 LOA-692 — Migrate CLAUDE.md → AGENTS.md, point Claude at the agents files (infra)
 LOA-701 — Reducto bounding boxes to show field locations in doc viewer
 LOA-708 — Max Rules 100 on new client onboarding issue.
 LOA-721 — Compound (AND/OR) custom rules wizard fix.
 LOA-722 — Onboarding rule-count cap regression.

Drift signal: LOA-721 / LOA-722 — In Progress in Linear but shipped on PR #1219; flip when ready.
```

### Common usage
- `/pickle-standup` (default) — yesterday 00:00 through now, INCLUDING today's commits
- `/pickle-standup --days 0` — today's activity (today 00:00 through now)
- `/pickle-standup --days 3` — last 3 days
- `/pickle-standup --since 2026-02-25` — everything since Feb 25
- `/pickle-standup --raw` — bypass Linear cross-reference, print helper output verbatim

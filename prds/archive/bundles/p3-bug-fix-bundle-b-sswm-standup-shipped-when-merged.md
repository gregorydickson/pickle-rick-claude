# B-SSWM — Standup "Shipped" means Merged-in-Window, not Deployed

One sentence: the `/pickle-standup` Y: section must anchor "shipped" to an **in-window merged PR (or in-window commit)** — not a Linear `completedAt` / `In Prod` status flip, which fires when a deploy carries already-merged code to prod days later.

**Filed:** 2026-06-12 · **Pri:** P3 (reporting-accuracy bug in a human-reviewed skill; non-blocking) · **Source:** live operator session 2026-06-12 (loanlight-eng standup).

---

## Problem

**Current process:** `/pickle-standup` builds Y: ("yesterday / shipped this window") by joining Linear issues to activity. In practice the skill (and operators following it) lean on the Linear ticket *state* — `completedAt` in-window or status `In Prod` — as the "shipped" signal, because running the full per-ticket branch/PR/commit join is heavier than reading a status field.

**Users:** the operator running standup, and every teammate reading the posted standup as ground truth for what shipped.

**Pain points (observed 2026-06-12):**
- **Deploy ≠ merge.** Linear flips a ticket to `In Prod` / sets `completedAt` when a **prod deploy** carries *already-merged* code to production — often days after the PR merged. A single early-morning deploy stamped **LOA-701, LOA-731, LOA-992, LOA-993** with a same-day `completedAt`; none had an in-window merged PR. Reporting them as "shipped yesterday" overclaimed work that merged days earlier.
- **Title-only mischaracterization.** The product-voice Y: line for **LOA-731** was written from its title ("Test YAML from database in production") and described as "rules load from the DB," when the ticket is actually a *production shadow-audit equivalence harness*. The description was never read.
- The operator caught both errors manually, twice — exactly the failure the skill should prevent.

**Importance:** a standup is a trust artifact. Overcounting Y: (or mis-describing a ticket) erodes the one thing the report is for. Low urgency, high credibility cost.

---

## Scope

**Objective:** make the Y: classification mechanical and correct — a ticket lands in Y: **iff** it has a merge/commit *event* inside the window; status flips are surfaced separately or dropped.

**Done looks like:** running `/pickle-standup` on the 2026-06-12 data set puts only the five in-window merges in Y: and never lists LOA-701/731/992/993 as in-window shipped work, without operator correction.

### In-scope
- `.claude/commands/pickle-standup.md` — Step 4 (join) + Rule 5/7 clarifications; new deploy-only handling rule; new "read the ticket before describing" rule.
- `extension/src/bin/standup.ts` — optional `ship_basis` classifier so the skill's decision is data-driven, not judgment.
- Tests: `extension/tests/standup-skill-doc-clarity.test.js`, `extension/tests/standup.test.js`.

### Not-in-scope
- Changing the Linear MCP queries themselves (the merged-PR query is already window-correct).
- T: logic, epic grouping, noise filtering, jargon translation (Rules 8/11/12 unchanged).
- Any auto-posting / Slack integration.

---

## User Journey

Operator runs `/pickle-standup` → helper + Linear + PR queries run → for each candidate ticket the skill determines `ship_basis` → tickets with `merged_in_window` / `commit_in_window` / `open_pr` populate Y: (open-PR with the in-flight suffix); tickets whose **only** in-window event is a status flip are dropped (default) or listed under an explicit "Reached production this window (built earlier)" sub-section → before writing each Y: line the operator reads the ticket description, not just the title → posts.

---

## Functional Requirements

| ID | Pri | Requirement | Verification |
|:--|:--|:--|:--|
| R-SSWM-1 | P0 | Y: membership requires an **in-window merge or commit** event: a merged PR in the `merged:>=START` set, OR a commit in the `--since=START` scan, OR an in-window open PR (→ in-flight suffix). A Linear `completedAt`/`In Prod`/`Deployed-to-Int` status **alone** is NOT sufficient for Y:. | `standup-skill-doc-clarity.test.js` asserts `pickle-standup.md` Step 4 + Rule 5 contain the "merge/commit event, not status" rule and the word `completedAt` in the negative sense. |
| R-SSWM-2 | P0 | A ticket whose only in-window signal is a status flip (in-window `completedAt` but **no** in-window merged PR / commit match) is classified `deploy_only` → **dropped from Y: by default**; if the operator wants it, it goes under a distinct "Reached production this window (built earlier)" heading, never interleaved with merged-this-window lines. | `standup-skill-doc-clarity.test.js` asserts the skill documents the `deploy_only` bucket + default-drop + separate heading. |
| R-SSWM-3 | P1 | Before composing a Y:/T: product-voice line, the skill instructs reading the ticket **description** (not the title alone); the line must reflect the ticket body. Add a worked counter-example (LOA-731: shadow-audit harness, not "rules load from DB"). | `standup-skill-doc-clarity.test.js` asserts a "read the description before describing" instruction + the LOA-731-class counter-example exist. |
| R-SSWM-4 | P2 | `standup.ts` annotates each candidate with `ship_basis ∈ {merged_in_window, commit_in_window, open_pr, deploy_only}` derived from the PR/commit/state data, so the skill classifies mechanically. `deploy_only` = has in-window `completedAt` AND no merge/commit match. | `standup.test.js` unit test: fixture with an in-window `completedAt` + no in-window PR/commit → `ship_basis === "deploy_only"`; fixture with an in-window merged PR → `merged_in_window`. |

---

## Interface Contract

If R-SSWM-4 lands, the helper's per-candidate record gains one field (additive, back-compatible):

| Field | Type | Meaning |
|:--|:--|:--|
| `ship_basis` | `"merged_in_window" \| "commit_in_window" \| "open_pr" \| "deploy_only"` | The strongest in-window evidence class. `deploy_only` ⇒ excluded from Y: by default. |

No existing field changes shape. Skill-only delivery (R-SSWM-1..3 without R-SSWM-4) is acceptable — the helper change is an enhancement, not a prerequisite.

---

## Verification Strategy

- **Type:** `tsc --noEmit` clean (if `standup.ts` touched).
- **Test:** `standup-skill-doc-clarity.test.js` (doc-rule assertions) + `standup.test.js` (`ship_basis` classifier) green.
- **LLM/behavioral:** replay the 2026-06-12 fixture — Y: contains only the five in-window merges (#1848/#1842/#1838/#1825/#1787); LOA-701/731/992/993 absent from Y:.
- **Docs:** `README.md` updated if the command's documented behavior changes (per repo Documentation Rule).

---

## Test Expectations

| Requirement | Test File | Assertion |
|:--|:--|:--|
| R-SSWM-1 | `standup-skill-doc-clarity.test.js` | skill text ties Y: to merge/commit event; names `completedAt` as insufficient |
| R-SSWM-2 | `standup-skill-doc-clarity.test.js` | `deploy_only` default-drop + separate "built earlier" heading documented |
| R-SSWM-3 | `standup-skill-doc-clarity.test.js` | "read description before describing" + LOA-731-class counter-example present |
| R-SSWM-4 | `standup.test.js` | `deploy_only` vs `merged_in_window` classification on fixtures |

---

## Notes

Schema-neutral (additive helper field only; no state schema / event / flag change) → **PATCH** if helper-only, **MINOR** if it adds a documented command behavior. Distinct from the existing standup rules R-PSU-2/3/4 (open-PR commit filter, commit-level scan, repo auto-discovery) — this bundle is specifically about the **merge-vs-deploy** ship signal and **description-grounded** descriptions.

# B-VERDICT ROOT V4 — acceptance-criteria-unmet classification (ticket 891f67b6)

Forensic record for `prds/p1-b-verdict-restore-the-runs-ability-to-report-a-verdict.md` ROOT V4
(AC-V4-1..4). An external review corpus (outside this repo; see root `CLAUDE.md` confidentiality rule —
counts and methodology only, no finding text or identifiers) measured **acceptance-criteria unmet** at
45 of 342 blocking findings (13%) — the largest identifiable category, three times the next.

This ticket classifies a reconstructed sample of that category into three branches:
- **(a) never checked** — no test or validation exercised the described scenario; a coverage gap.
- **(b) checked and passed wrongly** — a specific check ran and should have failed, or a previously
  satisfied guarantee was silently regressed.
- **(c) criterion absent or unfalsifiable** — explicitly out of scope for the diff under review, a
  post-merge-only check, or a disclosed/deliberate deviation awaiting spec re-approval rather than a
  defect.

**Only (a) is a coverage gap.**

## Reconstruction note

The corpus's original keyword taxonomy that produced the "45" count was not preserved anywhere
retrievable — only the raw blocking-findings text and the README's summary count survive. This record
reconstructs a representative sample via a keyword pattern matching `AC<n>`/`criterion`/`criteria` over
bolded-lead findings, yielding **40** candidate lines (same order of magnitude and dominant keyword
shape as the reported 45). Each of the 40 was read in full against the external corpus and classified
below; rows are numbered 1-40 only — no PR number, ticket ID, file path, or quoted finding text from the
external repo appears anywhere in this record.

## Split: 31 (a) / 3 (b) / 6 (c) — of 40 sampled

| # | Classification | Basis (generic, no client content) |
|---|---|---|
| 1 | (b) | A stated fail-closed guard is bypassed by a specific input — the guard exists and ran, and passed the wrong case. |
| 2 | (a) | Bolded lead states a specific token-expiry scenario has no test coverage at all. |
| 3 | (a) | Bolded lead states a code path is not exercised against the target datastore. |
| 4 | (a) | A real-world validation pass against genuine external data has not yet occurred. |
| 5 | (c) | Explicitly disclosed as owned by a different ticket and not scored against this diff. |
| 6 | (a) | A behavioral edge case found by reasoning about the code; no test drives it. |
| 7 | (a) | A defined processing budget is silently exhausted at scale; no test exercises that scale. |
| 8 | (a) | Terse "criterion unmet" with no evidence any check exists for it. |
| 9 | (a) | Same shape as #8, different criterion. |
| 10 | (b) | An existing test asserts only a narrow subset of the cases the criterion actually requires. |
| 11 | (c) | Deviation is stated as deliberate and disclosed; ticket-owner re-approval is the open item, not a defect. |
| 12 | (c) | Criterion is explicitly a post-deployment-only validation, not a pre-merge code check. |
| 13 | (a) | Terse "criterion not met" with no evidence of a prior check. |
| 14 | (a) | A deployed configuration value is read directly and found to conflict with the criterion; no prior drift check existed. |
| 15 | (a) | Same PR/theme as #14, a second conflicting configuration value. |
| 16 | (a) | An edge-case input path found by code reading; not covered by any test. |
| 17 | (a) | Bolded lead states the required end-to-end validation is explicitly outstanding. |
| 18 | (c) | A cohort/eligibility carve-out is a deliberate, documented scope decision rather than a missed case. |
| 19 | (a) | Duplicate theme of #17 — outstanding real-world validation. |
| 20 | (c) | Same carve-out shape as #18, different cohort definition. |
| 21 | (c) | Same carve-out shape as #18/#20, different cohort definition. |
| 22 | (a) | Duplicate theme of #17/#19 under a different heading. |
| 23 | (a) | An edge-case data-discard behavior found by code reading; no test. |
| 24 | (a) | Duplicate of #23 (near-identical line appears twice in the source corpus). |
| 25 | (a) | A specific line reference proves a stated wiring requirement was never actually connected. |
| 26 | (a) | A stated persistence/adapter requirement is absent from the implementation entirely. |
| 27 | (a) | A state-loss edge case found by reasoning about a relationship-changing operation; no test. |
| 28 | (a) | A grouping/matching edge case that can conflate distinct entities; no test. |
| 29 | (a) | Same matching-correctness theme as #28, phrased as a violation. |
| 30 | (a) | A generalized filter is found to over-match; no test isolates the excluded case. |
| 31 | (a) | A deduplication boundary condition can discard legitimate data; no test. |
| 32 | (a) | A period-boundary edge case can vanish without being flagged; no test. |
| 33 | (a) | Terse "partially met" with no evidence of a prior check. |
| 34 | (a) | Same shape as #33, different criterion. |
| 35 | (a) | Terse "explicitly not met" with no evidence of a prior check. |
| 36 | (a) | Explicitly states no audit or measured floor exists for the described change. |
| 37 | (a) | Terse "remains unmet" with no evidence of a prior check. |
| 38 | (a) | A targeting/safety edge case found by reasoning; no test. |
| 39 | (a) | A counting/deduplication bug where distinct entities collapse into one; no evidence a prior test targeted this exact collision. |
| 40 | (b) | A previously satisfied guarantee is described as retracted by the diff under review — a regression an existing check should have caught. |

## Root disposition — CUT (Honesty Control)

(c) does **not** dominate this sample (6/40, 15%) — AC-V4's "if (c) dominates, the defect is in PRD
authoring" branch does not fire here.

(a) dominates instead (31/40, 78%). Read narrowly, "31 never-checked" looks like a coverage gap this
codebase's own citadel `ac_coverage` audit (`extension/src/services/citadel/ac-coverage-scorecard.ts`)
or the `audit-acceptance-assertion-coverage.sh` gate leg should close. It does not, for a structural
reason, not an oversight: every one of the 31 is a **domain-specific behavioral-correctness edge case**
(cohort/eligibility logic, dedup/counting semantics, datastore-specific reprocessing, token-expiry
handling) that required domain expertise in the reviewed repo's own business area to even recognize as
wrong. Citadel's `ac_coverage` scorecard and the bash gate leg both answer a categorically different,
deliberately domain-neutral question — whether a ticket's AC prose carries matchable
implementation/test evidence (`ac_coverage`) or an executable verify command (the bash gate leg) — never
whether the implemented behavior is domain-correct. This codebase has no analogous domain
business-logic surface to audit against: its own PRDs describe pipeline mechanics, not the kind of
cohort/dedup/counting rules the external corpus's findings turn on.

The already-existing generalizable analog of what caught these 31 findings is the worker lifecycle's own
`llm-conformance` Spec Conformance step (`.claude/commands/send-to-morty.md` Step 6: "read impl, quote
code, PASS/FAIL + justification") — a human-equivalent semantic read, not a structural/textual scan.
That mechanism already exists here and is unchanged by this ticket.

**Conclusion**: the root is CUT. The 45/342 external category names a real, dominant defect class in the
*reviewed* codebase, but it is a bespoke domain-correctness testing gap with no code-level analogue in
this repo, not a defect in this repo's own AC-coverage instrument. No prompt, gate leg, or coverage floor
change is proposed or made by this ticket.

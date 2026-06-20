---
title: "R-ATBG — audit-ticket-bundle gate is brittle: path:line false-positives, naming-drift noise flood, title-must-name-AC over-strictness"
priority: P2
finding: ATBG
status: open
type: bug-bundle
schema_neutral: true
source_assessment: "2026-06-16 — blocked the B-GA bundle launch; required ~10 manual ticket edits to clear false-positive fatals/warnings"
---

# R-ATBG — Ticket-audit gate over-blocks on weak heuristics (D1 validation overreach)

## TL;DR

`audit-ticket-bundle.ts` (the R-TAQ-3 ticket-audit gate the mux-runner runs at iteration 0) blocked
the B-GA bundle launch on **false positives**, not real defects. Three over-reach classes surfaced;
each cost manual ticket-rewriting that the gate should not have demanded. This is a D1
(validation-overreach) instance per the design-simplification corpus — see
[[feedback_pickle_rick_autonomy_north_star]].

## The three brittleness classes (all HEAD-verified 2026-06-16)

### C1 — `checkPathDrift` treats `path:line`, directories, and globs as phantom paths (FATAL)
`extractBacktickedPaths` (`audit-ticket-bundle.ts:215`) captures the WHOLE backticked token and
`checkPathDrift` (`:381`) checks it verbatim against `git ls-files` (`:402`). So a backticked
`` `extension/src/bin/mux-runner.ts:4754` `` (a real file + line ref — the EXACT format the refine
template prescribes in Research Seeds: "Files: [paths:line]") is reported `fatal path-drift` because
`git ls-files` has no `:4754` suffix. Same for `.md:line` PRD citations, bare directories
(`` `extension/src/` ``, `` `prds/` ``), and globs (`` `extension/scripts/*.sh` ``). **check-readiness
already solved this class** (R-RTRC-4 suffix-match fallback, `check-readiness.ts`) — but
`audit-ticket-bundle`'s `checkPathDrift` was never brought to parity. The gate-parity invariant
(R-FRA-6) covers forward-ref annotations but NOT line/range/dir/glob normalization.

### C2 — `cross-doc-naming-drift` floods the output with info noise + display hides real warnings
`detectCrossDocNamingDrift` (`:240`, emitted `:574` severity `info`) compares each ticket's path
against EVERY doc mention of the same basename, at any path depth — so one file referenced as
`mux-runner.ts` / `src/bin/mux-runner.ts` / `extension/src/bin/mux-runner.ts` across the many CLAUDE.md
/ docs files generates a finding per (ticket, doc) pair. On B-GA: **1020 info findings**. The CLI
truncates display to ~50 and prints "(995 more findings; see manifest)" — but **no manifest file is
written** (the text is a misnomer), so the handful of blocking `warning`s are invisible behind 1000
lines of noise. Operators (and the babysitter) cannot see what actually blocks without calling
`auditSession` directly.

### C4 — `parseMappedRequirements` mis-parses a YAML block-list `mapped_requirements` (NEW, 2026-06-16)
`parseMappedRequirements` (`audit-ticket-bundle.ts:104`) reads only the text on the SAME line as
`mapped_requirements:`. When a ticket author writes the field as a YAML block-list —
`mapped_requirements:\n  - AC-PPXR-2` (valid YAML, what a careful author naturally produces) — the
same-line value is empty and the parser either captures nothing OR (with a different read path)
captures the list-item line `"- AC-PPXR-2"` WITH the `- ` prefix. Either way the C3 title check then
compares against a malformed token (`"- AC-PPXR-2"` vs the title's `"[AC-PPXR-2]"`) and emits a
spurious `warning cross-doc-naming` on a correctly-authored ticket. Hit live on the R-PPXR build
(2026-06-16, session f97c8720): all 3 tickets false-flagged until `mapped_requirements` was hand-
normalized to the inline scalar form. **Fix:** `parseMappedRequirements` MUST accept BOTH the inline
scalar (`mapped_requirements: AC-X` / `[AC-X, AC-Y]`) AND the YAML block-list (`\n  - AC-X`) forms,
stripping the `- ` list-item prefix. — Type: test. (Compounds C3 — even after C3 is demoted to advisory,
the parser should still read both forms correctly so downstream consumers get the real requirement set.)

### C3 — `cross-doc-naming` (WARNING) requires the ticket TITLE to contain the literal AC id
`checkCrossDocNaming` (`:494-505`) emits `warning cross-doc-naming` when a ticket's `title` does not
`.includes()` one of its `mapped_requirements` ids. A descriptive title ("Recover the clean-tree
converged case via plan re-execution") blocks the gate purely for omitting the literal string
`AC-GA-REC-1`. This is a traceability nicety promoted to a launch-blocking warning. It also fires
INCONSISTENTLY (the `parseMappedRequirements` `:104` comma-split populated the field for some tickets
and not others), so the same defect blocks one ticket and silently passes its sibling.

## Recommended fixes (ACs)

- **AC-ATBG-1 — path normalization parity with check-readiness.** `checkPathDrift` MUST strip a
  trailing `:<line>[,<line>...][-<line>]` suffix from a backticked token before `git ls-files`, and
  MUST NOT flag bare directory tokens (trailing `/`) or glob tokens (containing `*`) as `path-drift`.
  Reuse / mirror the R-RTRC-4 suffix-match fallback so the two gates stay parity-aligned. Regression
  fixture: a ticket citing `` `x.ts:10` ``, `` `dir/` ``, `` `a/*.sh` `` for real paths exits 0. — Type: test
- **AC-ATBG-2 — demote / cap the naming-drift noise + write a real manifest (or drop the "see
  manifest" text).** Either collapse `cross-doc-naming-drift` to one finding per ticket-path (not per
  doc-pair), or gate it behind a `--verbose` flag, so info noise cannot exceed blocking findings by
  20×. If the "(N more; see manifest)" line is kept, the CLI MUST actually persist the manifest JSON to
  a known path; otherwise remove the misleading text and print all blocking (fatal+warning) findings
  un-truncated. — Type: test
- **AC-ATBG-3 — title-AC-id check is advisory (info), not blocking.** Demote `cross-doc-naming`
  title-mentions-requirement from `warning` to `info` (or remove it). Traceability is desirable but is
  not a launch-blocking correctness property; the `mapped_requirements` frontmatter field already
  carries the linkage machine-readably. Subtract the guard rather than add an escape hatch (W5b
  subtract-before-add). — Type: test
- **AC-ATBG-5 — `parseMappedRequirements` accepts YAML block-list form.** Parse both inline scalar and `\n  - AC-X` block-list (strip `- ` prefix); a block-list `mapped_requirements` yields the same requirement set as the inline form. Regression fixture: a ticket with block-list mapped_requirements + AC-id-in-title exits 0. — Type: test
- **AC-ATBG-4 — typecheck + lint + compiled-mirror parity.** Source change recompiled to
  `extension/bin/audit-ticket-bundle.js` in the same commit. — Type: typecheck

## Out of scope
- The forward-ref annotation grammar (R-FRA-6 / R-RTRC-7) — already correct; this is line/dir/glob
  normalization, a different axis.
- check-readiness (already has the suffix fallback).

## Notes
Filed 2026-06-16 after R-ATBG blocked the B-GA reliability-GA bundle: 15 fatal `path-drift` (all real
files cited with `:line`/dir/glob) + 11 `warning cross-doc-naming` (descriptive titles) on a bundle
whose only GENUINE defects were 5 wrong-path typos (correctly caught — keep that). The gate's teeth
for real phantoms/typos are valuable; the false-positive classes above are not. Per operator
direction, drained as its own pipeline (not folded into B-GA).

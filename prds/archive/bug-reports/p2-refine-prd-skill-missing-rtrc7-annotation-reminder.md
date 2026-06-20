---
title: P2 — /pickle-refine-prd Step 7c ticket template doesn't remind authors to add R-RTRC-7 forward-ref annotations
status: Draft
filed: 2026-05-10
priority: P2
type: bug-process
---

# PRD — Refinement skill Step 7c missing R-RTRC-7 annotation discipline

**Author**: Pickle Rick
**Project**: `pickle-rick-claude`
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`, local-only

## Symptom

Bundle 2026-05-10 session `2026-05-10-84ad0873` failed at iter 1 with `READINESS HALT: check-readiness exited 2`. The `readiness_2026-05-10.md` report contained ~50 `file_path` and `contract` findings, all pointing at files/symbols the bundle's tickets *would create* but did not yet exist at HEAD.

Examples:
- `extension/src/lib/monitor-respawn.ts` — created by ticket 82a7ce6a (R-MDS-1)
- `extension/src/bin/subsystem-watcher.ts` — created by ticket c3b9a04f (R-MDS-5)
- `extension/src/services/citadel/trap-door-coverage-audit.ts` — created by 7a276c38 (R-CCNW-3)
- `extension/tests/microverse-llm-judge-non-determinism-recovery.test.js` — created by edb6d3b4 (R-SLLJ-8)
- `ParsedPrd.composedRcodes` — created by 1c3e2426 (R-CCNW-4)
- `microverse.json.violation_ledger` — created by 526da55e (R-SLLJ-3)

## Root cause

The R-RTRC-7 trap-door at `src/bin/check-readiness.ts` (annotation schema) defines the canonical forward-ref annotation:

```
`<token>` (created|introduced) by ticket <hash>
```

with EXACTLY one ASCII space and a hash matching `/^[A-Za-z0-9]{6,12}$/`. The `extractForwardRefAnnotations` helper recognizes the pattern and suppresses `file_path`/`contract` findings.

**The R-RTRC-7 trap-door also covers `src/bin/spawn-refinement-team.ts`** — the refinement worker's `PATH_VERIFICATION_PROMPT_SECTION` instructs analysts to add the annotation when they cite forward-created artifacts. That works for ANALYSIS files (`analysis_*.md`).

**Gap**: Step 7c of `/pickle-refine-prd` (the Linear ticket template) does **NOT** instruct the ticket author to add R-RTRC-7 annotations to backticked paths/symbols that don't exist at HEAD. Bundle 2026-05-10 was authored by Claude as the refiner; ~25 tickets cited forward-created paths/symbols without annotations; readiness gate flagged ~50 findings; pipeline halted at iter 1.

The trap-door ENFORCE for R-RTRC-1 (`src/bin/spawn-refinement-team.ts:PATH_VERIFICATION_PROMPT_SECTION`) covers the **analyst-side** path. The ticket-author-side path (Step 7c) is untrapped.

## Fix Requirements

- **R-RTRC8-1** (R-MUST): `/pickle-refine-prd` Step 7c ticket template MUST include an explicit reminder, immediately above the `## Implementation Details` block, that any backticked path or symbol cited in **Files to modify/create** or **Dependencies** that doesn't exist at HEAD MUST carry the R-RTRC-7 annotation `(created by ticket <hash>)` (or `(introduced by ticket <hash>)`). Format: bullet point starting with "🚦 Forward-reference hygiene:" matching the existing R-RTRC-1 wording in `spawn-refinement-team.ts`.

- **R-RTRC8-2** (R-MUST): The same reminder MUST appear at the top of Step 7c **before** the example template, not buried inside it. Authors scanning the template top-to-bottom should hit the reminder before they start writing.

- **R-RTRC8-3** (R-SHOULD): Add an audit script `extension/scripts/audit-ticket-forward-refs.sh` that scans `${SESSION_ROOT}/*/linear_ticket_*.md` for backticked paths/symbols and cross-references with `git ls-files`; emits a JSON report listing unresolved citations and whether they carry R-RTRC-7 annotation. Used as a pre-flight gate option (`--strict` flag).

- **R-RTRC8-4** (R-MUST): Regression test `extension/tests/spawn-refinement-team-step7c-annotation-reminder.test.js` asserts the Step 7c template prompt section contains the literal string `Forward-reference hygiene` (matching R-RTRC-1's grep-able anchor). Trap-door entry pinned at `.claude/commands/pickle-refine-prd.md` Step 7c.

## Severity

P2 — process bug; bundle author can mitigate by remembering R-RTRC-7 manually OR by running `--skip-readiness` with reason. Climbs to P1 if combined with a non-forward-ref finding hidden in the noise (operator skips readiness, ships a real bug).

## Sister findings

- R-RTRC-1..7 (extension/src/bin/check-readiness.ts) — analyst-side forward-ref handling, already shipped.
- This PRD is the ticket-author-side companion gap.

## Triggering session

`2026-05-10-84ad0873` — bundle 2026-05-10 (Findings #14/#15/#17). Refiner authored 37 tickets; ~25 had forward-ref drift; readiness halt at iter 1, 1m 4s into the pipeline.

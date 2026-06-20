---
title: P1 — Ticket-authoring process produces systemically defective tickets (54% broken, 92% defect rate)
status: Draft
date: 2026-05-04
priority: P1
type: bug
peer_prds:
  related:
    - prds/archive/bug-reports/p2-worker-silent-exit-and-ticket-path-drift.md   # subset — RC-2 (path drift) is one of N defect classes captured in this PRD
    - prds/archive/bug-reports/p2-refined-tickets-trip-readiness-contract-resolver.md   # adjacent — refinement output drift in backticks; this PRD targets prose-level drift
    - prds/archive/bug-reports/p1-iteration-cap-and-phantom-done-handshake.md   # downstream — bad tickets exhaust caps, trigger phantom-Done flips
    - prds/p1-reliability-and-test-coverage-bundle-2026-05-03.md   # surfaced empirically here
---

# PRD — Ticket-authoring process produces systemically defective tickets

## Empirical evidence

The reliability-bundle session `2026-05-03-7d9ee8cc` had 38 atomic tickets produced by:

1. `spawn-refinement-team.ts` running 3 cycles × 3 analysts (Requirements / Codebase / Risk) → `analysis_*.md` artifacts
2. Synthesis of `prd_refined.md` from those analyses
3. Decomposition into 33 implementation + 1 wiring + 4 hardening tickets via sub-agent

The first 25 tickets shipped (with manual phantom-Done backfills), then the pipeline halted at iteration cap. A read-only review of the **13 remaining tickets** by 2 parallel agents found:

| Verdict | Count | % | Tickets |
|---|---|---|---|
| **PASS** | 1 | 8% | `dfeaf263` |
| **WEAK** | 5 | 38% | `d1424039`, `b40cdf1d`, `01c13ccf`, `78710188`, `dddee00b` |
| **BROKEN** | 7 | 54% | `ab62807f`, `6f63fd21`, `e331fab7`, `40c60ef2`, `6555b40c`, `f00c6ea5`, `0a08cf9d` |

**54% broken. 92% have at least one defect.** This is a process-quality bug, not 12 isolated authoring mistakes.

## Why "systemic"

If 1-2 tickets had path drift, that's authoring noise. Six failure modes recurring across 12 of 13 tickets is a process gap. The same shape of defect appears regardless of section (A, B, C, D, E-infra, wiring, hardening). The root cause is upstream of any single analyst.

## Six recurring defect classes (empirically observed)

### Class 1 — File-path drift (`Files to modify` cites a file that doesn't exist)

**Frequency**: 4+ tickets (`ab62807f`, `b40cdf1d`, `f00c6ea5`, `0a08cf9d`, `dddee00b`)

The most common defect. Examples:
- `extension/src/services/resolve-state.ts` cited; actual file is `extension/src/hooks/resolve-state.ts` (different file with same basename) AND/OR the work belongs in `extension/src/services/state-manager.ts:recoverStaleActiveFlag`.
- `extension/src/hooks/stop-hook.ts` cited; actual is `extension/src/hooks/handlers/stop-hook.ts` (deeper nesting).

The analyst inferred the file name from prose ("resolve-state demotes paused orphan") without verifying the path resolves at HEAD. Worker discovers the discrepancy in research; lifecycle stalls or completes against the wrong target.

### Class 2 — Self-referential / circular acceptance criteria

**Frequency**: 1 ticket (`40c60ef2`)

The closer ticket's AC requires `bash audit-trap-door-enforcement.sh exit 0` as a precondition, but the same ticket is the only place that creates the script. AC unverifiable by definition: "The script the ticket creates must already exist before the ticket runs."

### Class 3 — Missing dependency / Entry Conditions

**Frequency**: 4 tickets (`6f63fd21`, `e331fab7`, `40c60ef2`, `6555b40c`)

Tickets reference forward-created infrastructure (e.g., `extension/tests/contract/cli-contract.test.js` from sibling `01c13ccf`) without an explicit `## Entry Conditions` declaring the dependency. mux-runner picks tickets in `order` ascending, but ticket-author intent often relies on order-N-1 having shipped specific files; without the explicit dependency, race conditions and false-fail validations result.

### Class 4 — Wrong assumptions about HEAD state

**Frequency**: 1 ticket (`6555b40c` — the wiring ticket)

Description claims `pickle-rick-claude/CLAUDE.md` and `release.yml` were "already updated by ticket f28d7f23". At HEAD they're NOT updated; the wiring ticket carries the actual edit. The framing is wrong. If the worker reads "already updated" and skips the edit, the gate breaks.

### Class 5 — Cross-document naming drift

**Frequency**: 1 ticket pair (`01c13ccf` ↔ `prds/bundle-thesis-matrix.md`)

`bundle-thesis-matrix.md` row D references `extension/tests/contract/gh-cli-contract.test.js`. Ticket `01c13ccf` creates `extension/tests/contract/cli-contract.test.js` (parametrized over gh+codex+claude). The cross-reference audit (`dddee00b`) WILL flag this as CRITICAL — but the actual fix is upstream: pick one filename, sync the matrix doc, audit-script regex, and ticket-author description.

### Class 6 — Unverifiable / hallucinated premises

**Frequency**: 1 ticket (`e331fab7`)

The ticket claims a test "asserts a `rg/fail` warning is emitted." Zero matches for the literal string `rg/fail` in the entire repo (production AND tests). The test it references uses `hasWarning(output.warnings, 'rg', 'fail')` — kind/category structure, not a literal string. The analyst hallucinated the assertion text from the test name shape.

### Class 7 — Literal value drift

**Frequency**: 1 ticket (`0a08cf9d`)

Ticket asserts `engines.codex = "^0.128.0"`. Actual `extension/package.json` pins exact `"0.128.0"` (no caret). The data-flow audit AC will false-fail on this drift.

## Root cause analysis

### RC-1 — Refinement-team analysts don't verify their output against HEAD

The `spawn-refinement-team.ts` analyst prompts (`buildAnalystPrompt`) instruct workers to produce `analysis_codebase_*.md` reports with "file_path:line" references. The prompts **do not require** the analyst to:

- Run `git ls-files <claimed-path>` and verify the path resolves
- Run `grep` for cited symbols and confirm they exist
- Cross-check Verify-command shell snippets are runnable
- Validate package.json field values match what the ticket asserts

Workers are LLMs writing prose; they default to sensible-sounding but unverified claims. The framework needs a verification gate.

### RC-2 — Synthesis step (analyses → prd_refined.md → tickets) loses ground-truth fidelity

Even when analysts produce correct file paths in their reports, the synthesis step (which has happened twice on this project — once via a sub-agent for the ticket decomposition) can introduce drift. There's no mechanism that enforces: "every path in `prd_refined.md` was either (a) cited verbatim from an analyst report OR (b) verified independently against HEAD."

### RC-3 — No automated post-decomposition validator

Once tickets exist on disk (`linear_ticket_<hash>.md`), nothing audits them as a set. `check-readiness.js` covers symbol/path resolution at gate time but with the false-positive issues documented in `p2-refined-tickets-trip-readiness-contract-resolver.md`. No tool catches:

- Self-referential ACs
- Missing Entry Conditions
- Cross-document naming drift between tickets and supporting docs
- Literal value drift (e.g., engines.codex)
- Unverifiable premises (zero-match strings)

### RC-4 — Manual decomposition lacks defect-class checklist

The Step 7a/7c decomposition (in `pickle-refine-prd.md`) describes ticket structure and field shapes but doesn't enumerate the failure modes to avoid. Ticket-authoring agents (whether the main agent or a delegated sub-agent) get no checklist of "verify these N things before each ticket is finalized."

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| R-TAQ-1 | `spawn-refinement-team.ts` analyst prompts add a hard verification block: "Every file path you cite in `## Files` or `## Locations` MUST be verified via `git ls-files <path>` first. Cite the verification command's output. If the path doesn't exist, mark it explicitly as `(forward-created)` with a sibling-ticket reference." | P0 |
| R-TAQ-2 | New post-decomposition validator `extension/bin/audit-ticket-bundle.js`: walks `${SESSION_ROOT}/<hash>/linear_ticket_<hash>.md`, runs all 6 defect-class checks (path drift, self-ref, missing-deps, wrong-HEAD-assumptions, cross-doc-naming, hallucinated-premise, literal-value-drift). Exits non-zero with a per-ticket findings report. Manifest: `${SESSION_ROOT}/audit-ticket-bundle.json`. | P0 |
| R-TAQ-3 | mux-runner runs `audit-ticket-bundle.js` BEFORE the first iteration. Exit non-zero halts the pipeline before any worker spawns; operator sees the findings list and fixes the tickets. Bypass via `state.flags.skip_ticket_audit_reason = "<reason>"` (mirrors the readiness skip pattern). | P0 |
| R-TAQ-4 | `pickle-refine-prd.md` Step 7a (Decompose) gets a "Failure-mode checklist" subsection enumerating the 7 defect classes with examples. Decomposition agents (main agent OR sub-agent) MUST write a 1-line audit comment in each ticket body confirming each class was checked. | P1 |
| R-TAQ-5 | Cross-document validator (subset of R-TAQ-2): for every ticket that creates a file, scan `prds/*.md` for references to that filename pattern. If any reference uses a different name, flag as cross-doc-naming-drift. | P1 |
| R-TAQ-6 | Backfill audit: `audit-ticket-bundle.js` run against existing reliability-bundle session `2026-05-03-7d9ee8cc` produces a findings report matching the 12 defects this PRD documents (sanity check that the audit catches what was found by hand). | P1 |
| R-TAQ-7 | Refinement-manifest schema gains `ticket_quality_warnings: <array>` field, populated by the analyst-side verification (R-TAQ-1) and the post-decomp audit (R-TAQ-2). Operator sees a single-pane summary before launch. | P2 |

## Acceptance Criteria

| AC | Verification |
|---|---|
| AC-TAQ-01 | Analyst prompts contain the verification block — Verify: `grep -c "git ls-files" extension/src/bin/spawn-refinement-team.ts` ≥ 1 — Type: lint |
| AC-TAQ-02 | `audit-ticket-bundle.js` exists, runs against a fixture session, exits 0 on clean tickets and non-zero on a deliberately-defective ticket — Verify: `cd extension && npm test -- --grep audit-ticket-bundle` — Type: test |
| AC-TAQ-03 | mux-runner halts on audit-bundle exit non-zero — Verify: `cd extension && npm test -- --grep mux-runner.audit-bundle-halt` — Type: test |
| AC-TAQ-04 | Failure-mode checklist in pickle-refine-prd.md — Verify: `grep -c "Failure-mode checklist" .claude/commands/pickle-refine-prd.md` ≥ 1 — Type: lint |
| AC-TAQ-05 | Cross-doc validator catches matrix-vs-ticket drift — Verify: regression fixture with mismatched filenames; audit reports `cross-doc-naming-drift` — Type: test |
| AC-TAQ-06 | Backfill audit on session `2026-05-03-7d9ee8cc` produces ≥12 findings matching the documented 12 defects — Verify: `node extension/bin/audit-ticket-bundle.js /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-03-7d9ee8cc | jq '.findings | length' >= 12` — Type: integration |
| AC-TAQ-07 | refinement_manifest.json contains `ticket_quality_warnings` field — Verify: regression fixture; field present and schema-valid — Type: test |

## Workaround until R-TAQ-1..7 land

For this session: parallel agent dispatch (in flight as of this PRD's writing) is fixing all 12 defects manually. Then pipeline restarts with corrected tickets.

For the next bundle: operator runs a manual `git ls-files` audit against every `Files to modify` and `Files to create` path before launching the pipeline. Slow but catches Class 1 (the most common). Other classes require the automated audit.

## Risk

- **Audit too strict → halts on legitimate forward-refs**: Section A's `audit-ticket-bundle.js` MUST treat `## Files to create` as forward-create-OK (don't fail). Only `## Files to modify` paths must resolve at HEAD.
- **Audit too lenient → misses the 7 defect classes**: regression fixtures (R-TAQ-2's test suite) cover each class with deliberate violations.
- **Adoption friction**: ticket authors (LLMs and humans) must comply with the verification block. Mitigation: the audit itself is the enforcement mechanism — non-compliance halts the pipeline.

## Cross-references

- Empirical session: `~/.local/share/pickle-rick/sessions/2026-05-03-7d9ee8cc/`
- Reviews: 2 parallel agent reports filed in this conversation 2026-05-04 AM (logs at `tasks/a029f14e9e23d0425.output` and `tasks/aef92a39eb467b1ec.output`)
- Refinement entry point: `extension/src/bin/spawn-refinement-team.ts:367-525` (analyst prompt construction)
- Decomposition skill: `.claude/commands/pickle-refine-prd.md` Step 7a (Decompose)
- Existing audit: `extension/src/bin/check-readiness.js` (gate-time, different scope)
- Sibling bug PRDs: `p2-refined-tickets-trip-readiness-contract-resolver.md` (gate-time backtick drift), `p2-worker-silent-exit-and-ticket-path-drift.md` (RC-1 worker silent-exit + RC-2 single-ticket path drift)

— Pickle Rick out. *belch*

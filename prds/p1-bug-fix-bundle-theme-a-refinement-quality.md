---
title: P1 — Bug-fix bundle Theme A (refinement quality + worker reliability)
status: Shipped
date: 2026-05-07
priority: P1
shipped: 9/9 sections via pipeline pipeline-be6e9179
type: bug-bundle
scope: local-only
authoring_path: /pickle-quick-refine fan-out
pipeline_target: /pickle-pipeline --no-refine --backend claude
sections: 9
peer_prds:
  source_prds:
    - prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md  # Sections A, B, C, F, H, I
    - prds/archive/bug-reports/p2-worker-silent-exit-and-ticket-path-drift.md   # Section D
    - prds/archive/bug-reports/p1-iteration-cap-and-phantom-done-handshake.md   # Section G (R-3 only)
    - inline-2026-05-07-standup-bug-report                  # Section L (addendum)
refinement:
  cycles: 1
  workers: [requirements]
  notes: |
    Quick-refine fan-out (validated 2026-05-06 AM). Each section is 1 atomic
    ticket. Total tickets after fan-out = 9 (Sections A-I are the refinement-
    quality + worker-reliability core; Section L is an operator bug-report
    addendum from 2026-05-07, P2 scope-drift, separable). No composes: block.
deferred:
  - section_E: Path-drift validator — folded into Section B as one of 7 defect classes
  - section_J: audit-ticket-paths.js operator script — P2, deferred to next-next batch
  - section_K: Backfill validation — folded into Section H
addenda:
  - section_L: /pickle-standup output quality + accuracy — added 2026-05-07 from operator bug report. P2, scope-drift relative to refinement+worker theme. 5 sub-ACs covering helper noise filter, open-PR commit-window query, commit-level LOA-### scan, repo auto-discovery, --days semantics. Source: inline operator brief.
chicken_and_egg_note: |
  This bundle modifies the refinement-team and worker plumbing we use to ship
  bundles. Mitigation: the bundle's own tickets do NOT depend on better
  refinement; they are tooling/detection additions. By the time we run this
  bundle, the current pipeline (pipeline-1d81a0bb) will have shipped, and any
  conflicts with current-pipeline commits will be resolved at compose time.
---

# Bug-Fix Bundle Theme A — Refinement Quality + Worker Reliability

> **READY 2026-05-07 PM.** Pipeline `pipeline-1d81a0bb` shipped 5/12 + slot E hidden; anatomy-park `2026-05-07-4ca7a746` ended at iteration 21/50 (did not converge; 21 fixes + 22 trap doors landed). Conflict-checked vs anatomy-park: only Section D's `spawn-morty.ts` overlaps, and the changes are in different code paths (anatomy-park = backend-resolution telemetry; D = `flushAndExit` + `worker_partial_lifecycle_exit`). No blocking conflicts. Backend choice: `--backend claude` — Theme A modifies the refinement-team plumbing, and codex's `MANAGER_PERSISTENT_HALLUCINATION` bailed pipeline-1d81a0bb at slot G on this same defect class yesterday. Section L stays in this run (independent of A-I, no file overlap, runs in parallel).
>
> Composed under the **"Bugs first, scope second"** Working Rule (`prds/MASTER_PLAN.md` line 16). 9 atomic implementation tickets (8 core refinement+worker + 1 P2 addendum). No feature scope. Local-only — no `gh release create`, no version bump, no push.

## Overview

- **Date**: 2026-05-07.
- **Theme**: refinement quality + worker reliability — the two adjacent failure surfaces that caused 12 broken tickets in session `2026-05-03-7d9ee8cc` (54% broken, 92% defect rate per `prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md:25-33`) and the 0-byte-log silent-exit pattern documented in `prds/archive/bug-reports/p2-worker-silent-exit-and-ticket-path-drift.md:18-32`.
- **Scope**: 9 atomic implementation tickets after `/pickle-quick-refine` fan-out (Sections A-I are the core refinement-quality + worker-reliability theme; Section L is a P2 operator bug-report addendum on `/pickle-standup`, separable).
- **Source PRDs**: 3 source-PRD-backed sections + 1 inline addendum (`p1-ticket-authoring-quality-systemic-defects.md`, `p2-worker-silent-exit-and-ticket-path-drift.md`, `p1-iteration-cap-and-phantom-done-handshake.md` — R-3 only; plus inline 2026-05-07 standup operator brief for Section L).
- **Pipeline target**: `/pickle-pipeline --no-refine --backend codex` (after `/pickle-quick-refine`).
- **Authoring path**: `/pickle-quick-refine` parallel agent fan-out — proven on the 2026-05-06 12-ticket bundle (`pipeline-e0834dcd`, 9/9 shipped) and the in-flight `pipeline-1d81a0bb`.

## Why these together

- Sections A, B, C, F, I (refinement-team validators + manifest schema + skill checklist) prevent defective tickets at *authoring* time — the upstream lever.
- Sections D, G (worker silent-exit log flush + phantom-Done filesystem watcher) catch failure at *runtime* — the downstream backstop.
- Section H validates that A, B, C actually catch the documented 12 defects from session `2026-05-03-7d9ee8cc` — the regression-test contract proving the upstream lever works.
- Together they close the 7 defect classes documented at `prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md:39-86` AND the 0-byte-log pattern at `prds/archive/bug-reports/p2-worker-silent-exit-and-ticket-path-drift.md:30-44` AND the phantom-Done R-3 sister bug deferred from the 2026-05-06 bundle.

## Bugs-first policy compliance

- All 8 sections are defects, not feature work.
- Working Rule citation: `prds/MASTER_PLAN.md` line 16 — *"Open bugs in PRDs and master-plan queue slots must be drained before any feature/expansion work is queued."*
- This bundle drains the largest open systemic-defects PRD (`p1-ticket-authoring-quality-systemic-defects.md`, 7 requirements) plus its sibling worker-reliability PRD plus the R-3 leftover from `p1-iteration-cap-and-phantom-done-handshake.md`.

## Composition

| § | Title | Source | Priority | Order | Lead requirement |
|---|-------|--------|----------|-------|-------------------|
| A | Refinement-team analyst path verification | `p1-ticket-authoring-quality-systemic-defects.md` | P1 | 10 | R-TAQ-1: analyst prompt adds `git ls-files`-verified file-path block |
| B | Post-decomposition 7-class defect-audit scanner | same | P1 | 20 | R-TAQ-2 / R-TAQ-3 / R-TAQ-6: `audit-ticket-bundle.js` + mux-runner pre-iteration halt + backfill-replay coverage |
| C | Cross-doc naming drift detector | same | P1 | 30 | R-TAQ-5 / R-TAQ-7: cross-doc validator + `ticket_quality_warnings` manifest field |
| D | Worker silent-exit log flush + partial-lifecycle detection | `p2-worker-silent-exit-and-ticket-path-drift.md` | P1 | 40 | R-WSE-1..4 (derived): flushAndExit + `worker_partial_lifecycle_exit` event + stderr breadcrumb + worker prompt no-premature-promise reminder; sibling AC for RC-2 path drift points upstream to Section A |
| F | Failure-mode checklist in pickle-refine-prd skill | `p1-ticket-authoring-quality-systemic-defects.md` | P1 | 50 | R-TAQ-4: `Failure-mode checklist` subsection in Step 7a (Decompose) |
| G | Phantom-Done filesystem watcher + completion-commit-hash requirement | `p1-iteration-cap-and-phantom-done-handshake.md` (R-3 only) | P1 | 60 | R-ICP-5 / R-ICP-6: fswatch on linear_ticket_*.md + `completion_commit:` frontmatter contract |
| H | Audit regression fixtures + backfill validation | `p1-ticket-authoring-quality-systemic-defects.md` | P1 | 70 | AC-TAQ-02 / AC-TAQ-05 / AC-TAQ-06 + new AC for backfill against session `2026-05-03-7d9ee8cc` |
| I | Refinement-manifest schema extension (`ticket_quality_warnings` array) | `p1-ticket-authoring-quality-systemic-defects.md` | P1 | 80 | R-TAQ-7: `refinement_manifest.json` gains `ticket_quality_warnings: []` populated by A + B |
| L | `/pickle-standup` output quality + accuracy *(P2 addendum)* | inline 2026-05-07 operator bug report | P2 | 90 | R-PSU-1..5: helper noise filter + open-PR commit-window query + commit-level LOA scan + repo auto-discovery + --days semantics |

**Total**: 9 atomic tickets (8 P1 core + 1 P2 addendum). **Estimated** post-refinement: 9 (1 per section, no fan-out — quick-refine does not split sections).

## Sequencing inside the batch

- **B is foundation for C and H.** B ships `audit-ticket-bundle.js`; C extends it with cross-doc naming drift; H builds the regression fixture library on top of B's scanner.
- **A can run parallel with B.** A modifies `spawn-refinement-team.ts` analyst prompt; B builds the post-decomp validator. No file overlap, no dependency.
- **D, F, G are independent.** D touches `spawn-morty.ts` worker shutdown; F touches `.claude/commands/pickle-refine-prd.md`; G touches `mux-runner.ts` watcher + worker prompt. None depend on A/B/C.
- **I depends on A + B + C landing first.** The manifest schema can't be populated until the producers (analyst prompt in A, audit scanner in B/C) exist.

Recommended execution order (also reflected in the `Order:` annotations 10..90): A, B in parallel; C after B; D, F, G in parallel; H after B; I after A+B+C. **Section L is independent of A-I** (touches only `extension/src/bin/standup.ts` and `.claude/commands/pickle-standup.md` — no overlap with refinement-team or worker plumbing) — can run in parallel with any other section.

## Skipped / deferred

- **Section E (path-drift validator)** — folded into Section B as defect Class 1 of the 7-class scanner. Source: `prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md:41-50` (Class 1 — File-path drift) covers the same failure mode as `prds/archive/bug-reports/p2-worker-silent-exit-and-ticket-path-drift.md:48-60` (RC-2). Section B's `audit-ticket-bundle.js` runs the path-drift check as the first of seven; no separate ticket needed.
- **Section J (`audit-ticket-paths.js` operator-only script)** — `prds/archive/bug-reports/p2-worker-silent-exit-and-ticket-path-drift.md:86` R-RPD-3 — deferred to P2 in the next-next batch. Operator can run Section B's `audit-ticket-bundle.js` against a session root manually for the same effect; the standalone script is convenience-only.
- **Section K (backfill validation as separate ticket)** — folded into Section H. Same "validate audit catches the 12 documented defects" goal; H carries the AC.
- `prds/archive/bug-reports/p1-iteration-cap-and-phantom-done-handshake.md` R-1 (cap persistence) and R-2 (cap-hit exit code 3) — already shipped in 2026-05-06 bundle Sections I and J. This bundle covers ONLY R-3 (phantom-Done watcher + commit-hash contract).

---

## Section A — Refinement-team analyst path verification

**Priority: P1 | Order: 10**

*ACs lifted verbatim from `prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md:122` (R-TAQ-1) and `:134` (AC-TAQ-01). Source: `prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md:88-98` (RC-1 root cause), `:120-128` (R-TAQ-1 row), `:154-161` (Cross-references).*

**Problem statement**: The refinement-team analyst prompts (`spawn-refinement-team.ts:367-525`, `buildAnalystPrompt`) instruct workers to produce `analysis_codebase_*.md` reports with `file_path:line` references. The prompts do NOT require the analyst to run `git ls-files <claimed-path>` to verify the path resolves at HEAD, nor to grep for cited symbols, nor to validate package.json field values. Workers are LLMs writing prose; they default to sensible-sounding but unverified claims (e.g., `extension/src/services/resolve-state.ts` cited but the actual file is `extension/src/hooks/resolve-state.ts` — the most common Class-1 defect, observed on 4+ tickets in session `2026-05-03-7d9ee8cc`).

The framework needs a verification gate at the analyst layer so file-path drift is caught before tickets reach mux-runner. Without it, the worker discovers the discrepancy in research and the lifecycle stalls or completes against the wrong target (forensics: `prds/archive/bug-reports/p2-worker-silent-exit-and-ticket-path-drift.md:55-60`).

**Mapped requirements**: R-TAQ-1.

**Source files at HEAD**: `extension/src/bin/spawn-refinement-team.ts:367-525` (analyst prompt construction), `extension/.claude/commands/pickle-refine-prd.md` (Step 7a/7c context).

**Test files (forward-created)**: `extension/tests/spawn-refinement-team-path-verification.test.js`.

### Acceptance criteria *(lifted verbatim from prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md:122 + :134)*

- **AC-TAQ-01** *(R-TAQ-1, lifted verbatim from PRD line 122)* — `spawn-refinement-team.ts` analyst prompts add a hard verification block: "Every file path you cite in `## Files` or `## Locations` MUST be verified via `git ls-files <path>` first. Cite the verification command's output. If the path doesn't exist, mark it explicitly as `(forward-created)` with a sibling-ticket reference." Verify: `grep -c "git ls-files" extension/src/bin/spawn-refinement-team.ts` ≥ 1. Type: lint.
- **AC-TAQ-01-2** *(R-TAQ-1 regression, derived from operator brief)* — Synthetic fixture invokes the analyst prompt builder; asserts the rendered prompt contains the literal substrings `git ls-files`, `forward-created`, and the rule that paths must be verified before citation. Verify: `extension/tests/spawn-refinement-team-path-verification.test.js` asserts the rendered prompt body contains all three substrings exactly once each. Type: test.
- **AC-TAQ-01-3** *(R-TAQ-1 negative regression, derived from operator brief)* — Fixture analyst output that cites a non-existent path WITHOUT marking it `(forward-created)` produces a `path_not_verified` warning in the analyst's report parsing layer. Verify: synthetic fixture analyst report asserts the warning appears in `refinement_manifest.json.ticket_quality_warnings[]` (depends on Section I shipping `ticket_quality_warnings` field; until then the warning lands in stderr breadcrumb). Type: test.

### Conformance check stub

<!-- audit: 7-class checked 2026-05-07 -->

- [ ] forward-ref: AC-TAQ-01-3 forward-references Section I's manifest field — flagged but acceptable (Section I declared as dep)
- [ ] path-drift: `extension/src/bin/spawn-refinement-team.ts` exists at HEAD (`git ls-files` confirmed)
- [ ] missing-deps: Entry Conditions list Section I as soft dep, not hard dep
- [ ] wrong-HEAD-assumptions: prompt builder is at lines 367-525 per source PRD `:158`; spot-check confirmed
- [ ] cross-doc-naming: `git ls-files` literal matches grep target in AC-TAQ-01
- [ ] hallucinated-premise: every cited line range traceable to source PRD
- [ ] literal-value-drift: AC numbers match source PRD verbatim

---

## Section B — Post-decomposition 7-class defect-audit scanner

**Priority: P1 | Order: 20**

*ACs lifted verbatim from `prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md:123-124` (R-TAQ-2, R-TAQ-3), `:127` (R-TAQ-6), and `:135-136,:139` (AC-TAQ-02, AC-TAQ-03, AC-TAQ-06). Source: `prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md:39-86` (Class 1..7 enumeration), `:104-112` (RC-3 — no automated post-decomposition validator).*

**Problem statement**: Once tickets exist on disk (`linear_ticket_<hash>.md`), nothing audits them as a set. `check-readiness.js` covers symbol/path resolution at gate time but with the false-positive issues documented in `p2-refined-tickets-trip-readiness-contract-resolver.md`. No tool catches:

- Self-referential ACs (Class 2: `40c60ef2` — closer ticket creates the audit script that its AC depends on)
- Missing Entry Conditions (Class 3: 4 tickets — `6f63fd21`, `e331fab7`, `40c60ef2`, `6555b40c`)
- Cross-document naming drift between tickets and supporting docs (Class 5: `01c13ccf` ↔ `prds/bundle-thesis-matrix.md`)
- Literal value drift (Class 7: `0a08cf9d` — `engines.codex = "^0.128.0"` vs actual exact pin)
- Unverifiable premises / zero-match strings (Class 6: `e331fab7` — hallucinated `rg/fail` literal)
- Wrong-HEAD assumptions (Class 4: `6555b40c` — claims files "already updated" by f28d7f23)
- File-path drift (Class 1: 4+ tickets — most common defect, also folded from deferred Section E)

The fix is a post-decomposition validator that walks `${SESSION_ROOT}/<hash>/linear_ticket_<hash>.md`, runs all 7 defect-class checks, exits non-zero with a per-ticket findings report. mux-runner runs it BEFORE the first iteration; non-zero halts the pipeline before any worker spawns. Bypass via `state.flags.skip_ticket_audit_reason = "<reason>"` (mirrors the readiness skip pattern).

The R-TAQ-6 backfill check confirms the audit catches the 12 hand-found defects from session `2026-05-03-7d9ee8cc` — sanity gate that the scanner actually closes the documented gap.

**Mapped requirements**: R-TAQ-2, R-TAQ-3, R-TAQ-6.

**Source files at HEAD**: `extension/src/bin/check-readiness.js` (precedent for similar audit), `extension/src/bin/mux-runner.ts` (pre-iteration hook site), `extension/src/services/state-manager.ts` (state.flags read), `extension/src/types/index.ts` (`VALID_ACTIVITY_EVENTS`).

**Forward-created**: `extension/bin/audit-ticket-bundle.js`, `extension/tests/audit-ticket-bundle.test.js`, `extension/tests/audit-ticket-bundle-mux-halt.test.js`, `extension/tests/integration/audit-ticket-bundle-backfill.test.js`, `extension/tests/fixtures/audit-ticket-bundle/` (per-class fixture corpus).

### Acceptance criteria *(lifted verbatim from prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md:123-124, :127, :135-136, :139)*

- **AC-TAQ-02** *(R-TAQ-2, lifted verbatim from PRD line 123 + :135)* — New post-decomposition validator `extension/bin/audit-ticket-bundle.js`: walks `${SESSION_ROOT}/<hash>/linear_ticket_<hash>.md`, runs all 7 defect-class checks (path-drift, self-ref, missing-deps, wrong-HEAD-assumptions, cross-doc-naming, hallucinated-premise, literal-value-drift). Exits non-zero with a per-ticket findings report. Manifest: `${SESSION_ROOT}/audit-ticket-bundle.json`. `audit-ticket-bundle.js` exists, runs against a fixture session, exits 0 on clean tickets and non-zero on a deliberately-defective ticket. Verify: `cd extension && npm test -- --grep audit-ticket-bundle`. Type: test.
- **AC-TAQ-03** *(R-TAQ-3, lifted verbatim from PRD line 124 + :136)* — mux-runner runs `audit-ticket-bundle.js` BEFORE the first iteration. Exit non-zero halts the pipeline before any worker spawns; operator sees the findings list and fixes the tickets. Bypass via `state.flags.skip_ticket_audit_reason = "<reason>"` (mirrors the readiness skip pattern). mux-runner halts on audit-bundle exit non-zero. Verify: `cd extension && npm test -- --grep mux-runner.audit-bundle-halt`. Type: test.
- **AC-TAQ-06** *(R-TAQ-6, lifted verbatim from PRD line 127 + :139)* — Backfill audit: `audit-ticket-bundle.js` run against existing reliability-bundle session `2026-05-03-7d9ee8cc` produces a findings report matching the 12 defects this PRD documents (sanity check that the audit catches what was found by hand). Verify: `node extension/bin/audit-ticket-bundle.js /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-03-7d9ee8cc | jq '.findings | length' >= 12`. Type: integration.
- **AC-TAQ-02-2** *(R-TAQ-2 forward-create-OK invariant, lifted from PRD line 150)* — `audit-ticket-bundle.js` MUST treat `## Files to create` as forward-create-OK (does NOT fail on absent paths in that section). Only `## Files to modify` paths must resolve at HEAD. Verify: synthetic fixture ticket with `Files to create: extension/tests/forward.test.js` (file absent at HEAD) does NOT trip the path-drift check; the same path under `Files to modify` DOES trip it. Type: test.
- **AC-TAQ-02-3** *(R-TAQ-2 7-class fixture corpus, derived from PRD lines 41-86 + :151)* — Per-class regression fixtures live under `extension/tests/fixtures/audit-ticket-bundle/`: one fixture per defect class with a deliberate violation. Each class's check returns the expected `class:` tag in the findings JSON. Verify: parametrized test asserts each of the 7 fixtures produces the right class tag. Type: test.

### Conformance check stub

<!-- audit: 7-class checked 2026-05-07 -->

- [ ] forward-ref: `audit-ticket-bundle.js` is forward-created — section says so explicitly
- [ ] path-drift: `extension/src/bin/check-readiness.js` exists at HEAD (precedent reference)
- [ ] missing-deps: no Entry Conditions on this ticket; runs standalone
- [ ] wrong-HEAD-assumptions: backfill session path `/Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-03-7d9ee8cc` exists at HEAD (operator has confirmed)
- [ ] cross-doc-naming: `audit-ticket-bundle.js` filename matches in PRD line 123, AC-TAQ-02 grep, and forward-created file list
- [ ] hallucinated-premise: 7-class taxonomy traceable to PRD lines 39-86 verbatim
- [ ] literal-value-drift: backfill assertion `>= 12` matches source PRD line 139 verbatim

---

## Section C — Cross-doc naming drift detector

**Priority: P1 | Order: 30**

*ACs lifted verbatim from `prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md:126` (R-TAQ-5), `:128` (R-TAQ-7), `:138` (AC-TAQ-05), `:140` (AC-TAQ-07). Source: `prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md:69-73` (Class 5 — Cross-document naming drift).*

**Problem statement**: `bundle-thesis-matrix.md` row D references `extension/tests/contract/gh-cli-contract.test.js`. Ticket `01c13ccf` creates `extension/tests/contract/cli-contract.test.js` (parametrized over gh+codex+claude). The cross-reference audit (`dddee00b`) WILL flag this as CRITICAL — but the actual fix is upstream: pick one filename, sync the matrix doc, audit-script regex, and ticket-author description. The cross-doc validator is a subset of Section B's `audit-ticket-bundle.js` scanner: for every ticket that creates a file, scan `prds/*.md` for references to that filename pattern. If any reference uses a different name, flag as `cross-doc-naming-drift`.

R-TAQ-7 is the manifest-extension piece: refinement_manifest.json gains a `ticket_quality_warnings: <array>` field, populated by the analyst-side verification (R-TAQ-1, Section A) and the post-decomp audit (R-TAQ-2, Section B + this section). Operator sees a single-pane summary before launch. Section I extends the schema; this section ships the cross-doc producer that writes into it.

**Mapped requirements**: R-TAQ-5, R-TAQ-7.

**Source files at HEAD**: `extension/bin/audit-ticket-bundle.js` (forward-created in Section B; this section adds the cross-doc check), `extension/src/services/refinement-manifest.ts` (or wherever the manifest writer lives — to be confirmed at refine time), `extension/src/bin/spawn-refinement-team.ts:367-525` (manifest construction).

**Test files (forward-created)**: `extension/tests/audit-ticket-bundle-cross-doc-drift.test.js`, `extension/tests/refinement-manifest-quality-warnings.test.js`.

### Acceptance criteria *(lifted verbatim from prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md:126, :128, :138, :140)*

- **AC-TAQ-05** *(R-TAQ-5, lifted verbatim from PRD line 126 + :138)* — Cross-document validator (subset of R-TAQ-2): for every ticket that creates a file, scan `prds/*.md` for references to that filename pattern. If any reference uses a different name, flag as cross-doc-naming-drift. Cross-doc validator catches matrix-vs-ticket drift. Verify: regression fixture with mismatched filenames; audit reports `cross-doc-naming-drift`. Type: test.
- **AC-TAQ-07** *(R-TAQ-7, lifted verbatim from PRD line 128 + :140)* — Refinement-manifest schema gains `ticket_quality_warnings: <array>` field, populated by the analyst-side verification (R-TAQ-1) and the post-decomp audit (R-TAQ-2). Operator sees a single-pane summary before launch. refinement_manifest.json contains `ticket_quality_warnings` field. Verify: regression fixture; field present and schema-valid. Type: test.
- **AC-TAQ-05-2** *(R-TAQ-5 producer wiring, derived from operator brief)* — When `audit-ticket-bundle.js` detects a cross-doc-naming-drift, it appends a `{class: "cross-doc-naming-drift", ticket: <id>, filename: <basename>, drift_paths: [...]}` entry to `${SESSION_ROOT}/audit-ticket-bundle.json` AND mirrors that entry into `${SESSION_ROOT}/refinement_manifest.json.ticket_quality_warnings` (depends on Section I extending the schema; if Section I has not landed at runtime, the producer falls back to writing only to the audit manifest with a stderr breadcrumb noting the missing schema field). Verify: synthetic fixture session with one cross-doc drift; assert both files contain matching entries. Type: test.

### Conformance check stub

<!-- audit: 7-class checked 2026-05-07 -->

- [ ] forward-ref: `extension/bin/audit-ticket-bundle.js` is forward-created in Section B (declared dep)
- [ ] path-drift: `prds/bundle-thesis-matrix.md` exists at HEAD (confirmed at compose time via `ls`)
- [ ] missing-deps: Entry Conditions hard-dep on Section B + soft-dep on Section I
- [ ] wrong-HEAD-assumptions: ticket `01c13ccf` referenced as illustrative only; no claim about its current state
- [ ] cross-doc-naming: AC-TAQ-05 grep target matches both source PRD line 126 and audit fixture description
- [ ] hallucinated-premise: cross-doc-drift class name traceable to PRD line 138 verbatim
- [ ] literal-value-drift: `cross-doc-naming-drift` literal matches PRD line 138 verbatim

---

## Section D — Worker silent-exit log flush + partial-lifecycle detection

**Priority: P1 | Order: 40**

*Source: `prds/archive/bug-reports/p2-worker-silent-exit-and-ticket-path-drift.md:36-46` (RC-1 root cause), `:78-88` (R-WSE-1..4 + R-RPD-1..4 functional requirements), `:91-100` (AC-WSE-01..04 + AC-RPD-01..04 acceptance criteria), `:144-171` (2026-05-05 forensic addendum on R-WSE-1 self-inflicted recurrence). R-WSE-1..4 codes lifted verbatim from source PRD lines 80-83. RC-2 path-drift sibling AC points upstream to Section A as the prevention layer.*

**Problem statement**: Reliability-bundle session `2026-05-03-7d9ee8cc` ticket `ab62807f` flipped to `status: Failed` post-research-review with a 0-byte `worker_session_94069.log`. Worker (PID 94069) ran 1 minute 8 seconds, then exited. The session log captured ZERO output. The lifecycle `research → plan → implement → verify → review → refactor` halted silently after the research-review approval. The validation rule (`pickle.md:Phase 3.A` Step 3 — "FORBIDDEN to mark Done if missing [plan_*.md, conformance_*.md, code_review_*.md]") correctly refused to mark Done. mux-runner moved on to the next ticket. **No alert, no retry, no diagnosis** — the failure surface is a single `status: Failed` flip in frontmatter.

The bug is chronic: it recurred on session `2026-05-04-f416c6cc` ticket `018f32d2` (the very ticket that was implementing the R-WSE-1 fix; meta-irony forensic at `prds/archive/bug-reports/p2-worker-silent-exit-and-ticket-path-drift.md:144-171`) AND on session `2026-05-03-7d9ee8cc` ticket `dddee00b` (last in queue, the entire reason the bundle did not ship clean — `:122-141`).

Three hypotheses for the 0-byte log: (a) worker stdout redirected but never flushed before exit; (b) claude CLI subprocess hit an internal limit (token budget, max-turns) and exited 0 without surfacing the abort; (c) worker emitted `<promise>I AM DONE</promise>` prematurely after just research, before plan/implement. Without log evidence, root cause is hypothesis-only — the 0-byte log is itself a bug.

RC-2 (refined ticket points at non-existent file path) is the same defect class as Section A's R-TAQ-1 path-verification rule. This section's sibling AC AC-WSE-RC2-XREF points operators to Section A as the upstream prevention layer; no separate fix in this section.

**Mapped requirements**: R-WSE-1, R-WSE-2, R-WSE-3, R-WSE-4 (all derived from source PRD `:80-83` codes; codes already exist as R-WSE-* in source PRD verbatim).

**Source files at HEAD**: `extension/src/bin/spawn-morty.ts` (worker shutdown path — R-WSE-1 site), `extension/src/bin/mux-runner.ts` (lifecycle-artifact validator + Failed flip — R-WSE-2/3 sites), `extension/.claude/commands/send-to-morty.md` (worker prompt — R-WSE-4 site), `extension/src/types/index.ts` (`VALID_ACTIVITY_EVENTS`), `extension/activity-events.schema.json`.

**Test files (forward-created)**: `extension/tests/spawn-morty-flush-and-exit.test.js`, `extension/tests/integration/worker-partial-lifecycle-exit.test.js`, `extension/tests/mux-runner-research-approved-failed-breadcrumb.test.js`, `extension/tests/send-to-morty-no-premature-promise.test.js`, `extension/tests/fixtures/silent-exit-018f32d2/` (replay fixture from `2026-05-04-f416c6cc/018f32d2/` per the 2026-05-05 forensic addendum at PRD `:168-169`).

### Acceptance criteria *(lifted verbatim from prds/archive/bug-reports/p2-worker-silent-exit-and-ticket-path-drift.md:80-83 + :93-96)*

- **AC-WSE-01** *(R-WSE-1, lifted verbatim from PRD line 80 + :93)* — Worker session log MUST always flush before exit. Add `process.stdout.write('', () => process.exit(code))` (or equivalent) in `spawn-morty.ts` worker shutdown path. 0-byte session logs are a bug, never a feature. Worker session log size > 0 bytes for any worker that emits any output. Verify: `cd extension && npm test -- --grep worker-session-log-flush`. Type: test.
- **AC-WSE-02** *(R-WSE-2, lifted verbatim from PRD line 81 + :94)* — When worker exits with research-review APPROVED but downstream lifecycle artifacts missing, mux-runner emits a NEW activity event `worker_partial_lifecycle_exit` with `{ticket: <id>, artifacts_missing: [...], session_log_size: <bytes>}`. Operator can audit how often this happens. `worker_partial_lifecycle_exit` event recorded. Verify: regression fixture forces partial-exit; `state.activity` contains the event. Type: test.
- **AC-WSE-03** *(R-WSE-3, lifted verbatim from PRD line 82 + :95)* — mux-runner exit-validation: if `status: Failed` is set on a ticket AND research_review.md ends in `APPROVED`, log a stderr breadcrumb `⚠ ticket <id> failed AFTER research APPROVED — see ${SESSION_ROOT}/<id>/ for partial artifacts` so operator notices vs silently moving on. Stderr breadcrumb on ticket-fail-after-research-approved. Verify: regression fixture; stderr contains `⚠ ticket .* failed AFTER research APPROVED`. Type: test.
- **AC-WSE-04** *(R-WSE-4, lifted verbatim from PRD line 83 + :96)* — Worker prompt (in `send-to-morty.md`) explicit reminder: "Do NOT emit `<promise>I AM DONE</promise>` until ALL six lifecycle phases (research, plan, implement, verify, review, refactor) have produced their artifacts. Premature `I AM DONE` after just research will fail validation and the ticket will be reverted to Failed." Belt-and-suspenders with R-ICP-6 commit hash requirement. Worker prompt updated. Verify: `grep -c "ALL six lifecycle phases" .claude/commands/send-to-morty.md` ≥ 1. Type: lint.
- **AC-WSE-05** *(R-WSE-1/2 forensic regression, derived from PRD lines 168-169 forensic addendum)* — Replay fixture `extension/tests/fixtures/silent-exit-018f32d2/` reproduces the 4-artifact-present + 0-byte-log + generic `Exit code 1` activity-event signature from session `2026-05-04-f416c6cc/018f32d2/`. Test asserts the new flushAndExit helper would have flushed the log AND `worker_partial_lifecycle_exit` would have fired with `artifacts_missing: ["conformance_*.md", "code_review_*.md"]`. Verify: `cd extension && npm test -- --grep silent-exit-018f32d2-replay`. Type: integration.
- **AC-WSE-RC2-XREF** *(RC-2 path-drift cross-reference, derived from PRD lines 47-60 + operator brief)* — RC-2 (refined ticket points at non-existent file path; observed on `ab62807f` per source PRD `:48-60`) is the SAME defect class as Section A's R-TAQ-1 path-verification rule. This section's PRD cross-references Section A as the upstream prevention; no fix lands in this section. Verify: ticket body contains a `## Cross-references` block citing `Section A (R-TAQ-1)` as the upstream layer; lint-checked at refine time. Type: lint.
- **AC-WSE-06** *(VALID_ACTIVITY_EVENTS registration, derived from operator brief)* — New activity event `worker_partial_lifecycle_exit` registered in `VALID_ACTIVITY_EVENTS` (`extension/src/types/index.ts` AND `extension/types/index.js` mirror) and in `extension/activity-events.schema.json` with payload schema `{ticket: string, artifacts_missing: string[], session_log_size: integer}`. Verify: `grep -c "worker_partial_lifecycle_exit" extension/src/types/index.ts extension/types/index.js extension/activity-events.schema.json` returns ≥ 3. Type: lint.

### Conformance check stub

<!-- audit: 7-class checked 2026-05-07 -->

- [ ] forward-ref: replay fixture `silent-exit-018f32d2/` is forward-created — section says so explicitly
- [ ] path-drift: `extension/src/bin/spawn-morty.ts` exists at HEAD (confirmed)
- [ ] missing-deps: Entry Conditions empty — section is independent of A/B/C/F/G/H/I
- [ ] wrong-HEAD-assumptions: source PRD `:80-83` lines verified against PRD content above
- [ ] cross-doc-naming: `worker_partial_lifecycle_exit` literal consistent across AC-WSE-02, AC-WSE-05, AC-WSE-06
- [ ] hallucinated-premise: every quoted phrase ("ALL six lifecycle phases", "⚠ ticket .* failed AFTER research APPROVED") traceable to source PRD verbatim
- [ ] literal-value-drift: stderr breadcrumb format and `process.stdout.write('', () => process.exit(code))` snippet match source PRD `:80,:82` verbatim

---

## Section F — Failure-mode checklist in pickle-refine-prd skill

**Priority: P1 | Order: 50**

*ACs lifted verbatim from `prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md:125` (R-TAQ-4) and `:137` (AC-TAQ-04). Source: `prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md:39-86` (the 7 defect-class taxonomy that the checklist enumerates), `:114-116` (RC-4 root cause), `:159` (Decomposition skill cross-reference).*

**Problem statement**: The Step 7a/7c decomposition (in `pickle-refine-prd.md`) describes ticket structure and field shapes but doesn't enumerate the failure modes to avoid. Ticket-authoring agents (whether the main agent or a delegated sub-agent) get no checklist of "verify these N things before each ticket is finalized." Result: the same 7 defect classes recur across sessions because authoring agents can't see them in their immediate prompt context.

The fix is to add a `Failure-mode checklist` subsection to Step 7a (Decompose) listing the 7 defect classes with one-line examples lifted from the source PRD. Decomposition agents MUST write a 1-line audit comment in each ticket body confirming each class was checked. Section H's regression fixtures verify that tickets authored AFTER this skill update carry the audit comments.

**Mapped requirements**: R-TAQ-4.

**Source files at HEAD**: `extension/.claude/commands/pickle-refine-prd.md` Step 7a (Decompose).

**Test files (forward-created)**: `extension/tests/pickle-refine-prd-failure-mode-checklist.test.js`.

### Acceptance criteria *(lifted verbatim from prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md:125 + :137)*

- **AC-TAQ-04** *(R-TAQ-4, lifted verbatim from PRD line 125 + :137)* — `pickle-refine-prd.md` Step 7a (Decompose) gets a "Failure-mode checklist" subsection enumerating the 7 defect classes with examples. Decomposition agents (main agent OR sub-agent) MUST write a 1-line audit comment in each ticket body confirming each class was checked. Failure-mode checklist in pickle-refine-prd.md. Verify: `grep -c "Failure-mode checklist" .claude/commands/pickle-refine-prd.md` ≥ 1. Type: lint.
- **AC-TAQ-04-2** *(R-TAQ-4 7-class enumeration, derived from PRD lines 41-86)* — The Failure-mode checklist subsection enumerates ALL 7 defect classes with the one-line names from the source PRD: `path-drift`, `self-referential-AC`, `missing-deps`, `wrong-HEAD-assumptions`, `cross-doc-naming`, `hallucinated-premise`, `literal-value-drift`. Verify: parametrized test greps each of the 7 literal class tags in `.claude/commands/pickle-refine-prd.md`; all 7 must match. Type: lint+test.
- **AC-TAQ-04-3** *(R-TAQ-4 audit-comment contract, derived from operator brief)* — Decomposition agents MUST write the literal HTML comment `<!-- audit: 7-class checked YYYY-MM-DD -->` in each ticket body. The Section B `audit-ticket-bundle.js` scanner verifies presence of this comment in every ticket; missing comment is a `class: missing-audit-comment` finding. Verify: synthetic decomposition output WITHOUT the comment trips the scanner; same output WITH the comment passes. Type: test.

### Conformance check stub

<!-- audit: 7-class checked 2026-05-07 -->

- [ ] forward-ref: AC-TAQ-04-3 forward-references Section B's scanner — Section B is hard-dep
- [ ] path-drift: `extension/.claude/commands/pickle-refine-prd.md` exists at HEAD (confirmed)
- [ ] missing-deps: Entry Conditions: hard-dep on Section B (audit-ticket-bundle.js scans for the audit comment)
- [ ] wrong-HEAD-assumptions: source PRD `:125,:137` line numbers verified
- [ ] cross-doc-naming: `Failure-mode checklist` literal matches between R-TAQ-4 source and AC verification grep target
- [ ] hallucinated-premise: 7 class tags traceable to source PRD `:41-86` verbatim
- [ ] literal-value-drift: HTML comment shape `<!-- audit: 7-class checked YYYY-MM-DD -->` consistent across this section, B, and the bundle's Conformance Check section

---

## Section G — Phantom-Done filesystem watcher + completion-commit-hash requirement

**Priority: P1 | Order: 60**

*ACs lifted verbatim from `prds/archive/bug-reports/p1-iteration-cap-and-phantom-done-handshake.md:79-80` (R-ICP-5, R-ICP-6) and `:90-91` (AC-ICP-04, AC-ICP-05). Source: `prds/archive/bug-reports/p1-iteration-cap-and-phantom-done-handshake.md:67-69` (RC-3 root cause), `:30` (Bug C evidence in symptom table). Bundle context: 2026-05-06 bundle Sections I and J shipped R-ICP-1..4 (cap exit code 3 + persistence); this section covers ONLY the deferred R-3 sister bug.*

**Problem statement**: Codex's worker prompt (or its interpretation of it) instructs the manager to mark tickets Done as part of its output. The marking happens BEFORE the worker actually verifies the implementation, runs tests, or commits. mux-runner's phantom-Done detection runs once per outer iteration and looks for a "completion commit" — but the detection window is loose enough that some phantom-Dones slip through. On session `2026-05-03-7d9ee8cc`, mux-runner.log line 21:26:13 shows "Corrected phantom Done ticket 7ee8b197 back to Todo (no completion commit found)" — three tickets flagged in iteration 1, another in iteration 2. Phantom-Done detection runs ONCE per mux-runner iteration; codex can flip multiple tickets between detections. The 13 currently-Done tickets MAY include silent phantom-Dones that the detector missed.

Two mitigations: (a) the worker prompt must require the commit hash in the same status update as the `status: Done` flip; (b) the phantom-Done detector should run on EVERY status flip via inotify/fswatch on `linear_ticket_*.md`, not just at iteration boundaries. R-ICP-5 ships the watcher; R-ICP-6 ships the worker-prompt commit-hash contract.

This was deferred from the 2026-05-06 bundle (per `prds/archive/bundles/p1-bug-fix-bundle-2026-05-06.md:82` — "Sections F's deferred ACs ... `p1-iteration-cap-and-phantom-done-handshake.md` R-3 (codex phantom-Done speculative flips, R-ICP-5/6) — sister bug deferred to next batch"). This bundle is that next batch.

**Mapped requirements**: R-ICP-5, R-ICP-6.

**Source files at HEAD**: `extension/src/bin/mux-runner.ts` (phantom-Done detection logic — R-ICP-5 site), `extension/src/bin/spawn-morty.ts` (worker prompt — R-ICP-6 site), `extension/src/bin/spawn-refinement-team.ts` (refinement-side prompt for completion_commit field), `extension/src/types/index.ts` (`VALID_ACTIVITY_EVENTS`), `extension/activity-events.schema.json`.

**Test files (forward-created)**: `extension/tests/mux-runner-phantom-done-watcher.test.js`, `extension/tests/integration/phantom-done-fswatch.test.js`, `extension/tests/spawn-morty-completion-commit-required.test.js`.

### Acceptance criteria *(lifted verbatim from prds/archive/bug-reports/p1-iteration-cap-and-phantom-done-handshake.md:79-80, :90-91)*

- **AC-ICP-04** *(R-ICP-5, lifted verbatim from PRD line 79 + :90)* — mux-runner's phantom-Done detection runs on EVERY frontmatter status flip (filesystem watch on `${SESSION_ROOT}/*/linear_ticket_*.md`), not only at outer iteration boundaries. Phantom-Done events emit a `phantom_done_detected` activity event with ticket id + timestamp. Phantom-Done watcher catches every flip. Verify: `cd extension && npm test -- --grep phantom-done-watcher`. Type: test.
- **AC-ICP-05** *(R-ICP-6, lifted verbatim from PRD line 80 + :91)* — Codex worker prompt requires that any `status: Done` flip include the completion commit hash in a `completion_commit:` frontmatter field, set in the same write as the status. Workers without commit hashes get reverted IMMEDIATELY by the watcher (R-ICP-5). Codex worker prompt requires `completion_commit:` field. Verify: `grep -E 'completion_commit:' extension/src/bin/spawn-morty.ts extension/src/bin/spawn-refinement-team.ts` returns at least 1 match. Type: lint.
- **AC-ICP-04-2** *(R-ICP-5 fswatch overhead, lifted from PRD line 107 risk row)* — Phantom-Done watcher's filesystem-watch overhead is bounded: typical session has ~30-50 ticket files; fswatch on that scale is negligible. Performance test: synthetic session with 50 ticket files; watcher startup completes in < 200ms; per-flip detection completes in < 50ms. Verify: `extension/tests/integration/phantom-done-fswatch.test.js` asserts both bounds. Type: integration.
- **AC-ICP-04-3** *(R-ICP-5 activity-event registration, derived from operator brief)* — `phantom_done_detected` event registered in `VALID_ACTIVITY_EVENTS` (`extension/src/types/index.ts` AND `extension/types/index.js` mirror) and in `extension/activity-events.schema.json` with payload schema `{ticket: string, timestamp: string, completion_commit_present: boolean}`. Verify: `grep -c "phantom_done_detected" extension/src/types/index.ts extension/types/index.js extension/activity-events.schema.json` returns ≥ 3. Type: lint.
- **AC-ICP-04-4** *(R-ICP-5/6 end-to-end regression, lifted from PRD line 81 R-ICP-7)* — Synthetic session with 5 Todo tickets, codex-style phantom flips during iteration. Assert: (a) every phantom-Done flip is reverted by the watcher before the next iteration boundary, (b) `phantom_done_detected` activity event fires once per phantom flip, (c) workers WITH `completion_commit:` field are NOT reverted (real-Done not falsely flagged). Verify: `cd extension && npm test -- --grep iteration-cap-and-phantom-done-end-to-end`. Type: integration.

### Conformance check stub

<!-- audit: 7-class checked 2026-05-07 -->

- [ ] forward-ref: watcher and tests forward-created — section says so explicitly
- [ ] path-drift: `extension/src/bin/mux-runner.ts`, `extension/src/bin/spawn-morty.ts`, `extension/src/bin/spawn-refinement-team.ts` all exist at HEAD (confirmed)
- [ ] missing-deps: no Entry Conditions; section is independent
- [ ] wrong-HEAD-assumptions: 2026-05-06 bundle deferred R-3 explicitly per `prds/archive/bundles/p1-bug-fix-bundle-2026-05-06.md:82`; verified at compose time
- [ ] cross-doc-naming: `phantom_done_detected` literal consistent across AC-ICP-04, AC-ICP-04-3, AC-ICP-04-4
- [ ] hallucinated-premise: every quoted phrase ("Corrected phantom Done ticket", "completion_commit:") traceable to source PRD or mux-runner.log forensic
- [ ] literal-value-drift: `< 200ms` and `< 50ms` performance bounds derived from PRD `:107` "negligible" claim — explicit numerical interpretation flagged for Cycle 1 review

---

## Section H — Audit regression fixtures + backfill validation

**Priority: P1 | Order: 70**

*ACs lifted verbatim from `prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md:135-136,:138-139` (AC-TAQ-02, AC-TAQ-05, AC-TAQ-06) plus a new AC for backfill against session `2026-05-03-7d9ee8cc`. Source: `prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md:148-152` (Risk section — "Audit too lenient → misses the 7 defect classes": regression fixtures (R-TAQ-2's test suite) cover each class with deliberate violations).*

**Problem statement**: Section B ships `audit-ticket-bundle.js` and Section C extends it with cross-doc-naming-drift detection. Without a regression fixture corpus that exercises every defect class with a known-bad ticket AND a backfill validation against the documented 12 defects from session `2026-05-03-7d9ee8cc`, the scanner can silently regress. This section is the test contract that proves the upstream lever (Sections A + B + C) actually catches the documented gap.

The Risk section of the source PRD calls this out explicitly (`prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md:151`): *"Audit too lenient → misses the 7 defect classes: regression fixtures (R-TAQ-2's test suite) cover each class with deliberate violations."* This section is that test suite, plus the backfill validation that the audit catches what was found by hand.

**Mapped requirements**: AC-TAQ-02, AC-TAQ-05, AC-TAQ-06 (test+integration verification of B's and C's deliverables) + new AC AC-TAQ-BACKFILL-01 (backfill replay).

**Source files at HEAD**: `extension/bin/audit-ticket-bundle.js` (Section B), cross-doc validator (Section C), `/Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-03-7d9ee8cc/` (backfill fixture session).

**Test files (forward-created)**: `extension/tests/integration/audit-ticket-bundle-backfill-2026-05-03.test.js`, `extension/tests/fixtures/audit-ticket-bundle/class-{1..7}/` (per-class fixture corpus, also referenced by Section B's AC-TAQ-02-3 — H is the producer that builds them; B consumes).

### Acceptance criteria *(lifted verbatim from prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md:135-136, :138-139, plus new backfill AC)*

- **AC-TAQ-02** *(test verification, lifted verbatim from PRD line 135)* — `audit-ticket-bundle.js` exists, runs against a fixture session, exits 0 on clean tickets and non-zero on a deliberately-defective ticket. Verify: `cd extension && npm test -- --grep audit-ticket-bundle`. Type: test. *Note: this AC is shared with Section B's AC-TAQ-02; Section H ships the fixture corpus that the test consumes.*
- **AC-TAQ-05** *(test verification, lifted verbatim from PRD line 138)* — Cross-doc validator catches matrix-vs-ticket drift. Verify: regression fixture with mismatched filenames; audit reports `cross-doc-naming-drift`. Type: test. *Note: this AC is shared with Section C's AC-TAQ-05; Section H ships the cross-doc-drift fixture variant.*
- **AC-TAQ-06** *(integration verification, lifted verbatim from PRD line 139)* — Backfill audit on session `2026-05-03-7d9ee8cc` produces ≥12 findings matching the documented 12 defects. Verify: `node extension/bin/audit-ticket-bundle.js /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-03-7d9ee8cc | jq '.findings | length' >= 12`. Type: integration. *Note: this AC is shared with Section B's AC-TAQ-06; Section H is the test-driver that exercises it.*
- **AC-TAQ-BACKFILL-01** *(NEW AC, derived from operator brief — explicit backfill class-coverage check)* — Backfill replay against session `2026-05-03-7d9ee8cc` MUST flag each of the 12 documented defects with the EXPECTED defect class tag (per `prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md:41-86`):
  - `ab62807f` → `path-drift` (Class 1)
  - `b40cdf1d` → `path-drift` (Class 1)
  - `f00c6ea5` → `path-drift` (Class 1)
  - `0a08cf9d` → `path-drift` (Class 1) AND `literal-value-drift` (Class 7)
  - `dddee00b` → `path-drift` (Class 1)
  - `40c60ef2` → `self-referential-AC` (Class 2) AND `missing-deps` (Class 3)
  - `6f63fd21` → `missing-deps` (Class 3)
  - `e331fab7` → `missing-deps` (Class 3) AND `hallucinated-premise` (Class 6)
  - `6555b40c` → `missing-deps` (Class 3) AND `wrong-HEAD-assumptions` (Class 4)
  - `01c13ccf` ↔ `bundle-thesis-matrix.md` → `cross-doc-naming` (Class 5)
  Verify: `extension/tests/integration/audit-ticket-bundle-backfill-2026-05-03.test.js` runs the audit against the session, parses findings, asserts each ticket-id-to-class mapping above. Type: integration.
- **AC-TAQ-FIXTURE-01** *(per-class fixture corpus, derived from operator brief)* — `extension/tests/fixtures/audit-ticket-bundle/class-{1..7}/` directories exist; each contains a synthetic `linear_ticket_<hash>.md` file with a deliberate violation of exactly one defect class. Section B's parametrized test (AC-TAQ-02-3) iterates these 7 directories and asserts each fires the right class tag. Verify: `ls extension/tests/fixtures/audit-ticket-bundle/class-* | wc -l` returns 7; each contains exactly one ticket file. Type: lint+test.

### Conformance check stub

<!-- audit: 7-class checked 2026-05-07 -->

- [ ] forward-ref: fixture corpus and backfill test forward-created — section says so explicitly; Section B consumes
- [ ] path-drift: backfill session path `/Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-03-7d9ee8cc/` exists at HEAD (operator confirmed at compose time)
- [ ] missing-deps: Entry Conditions: hard-dep on Section B (audit-ticket-bundle.js) AND Section C (cross-doc-naming-drift extension)
- [ ] wrong-HEAD-assumptions: ticket IDs in AC-TAQ-BACKFILL-01 traceable to source PRD `:30-32` table verbatim
- [ ] cross-doc-naming: class names (`path-drift`, `self-referential-AC`, `missing-deps`, `wrong-HEAD-assumptions`, `cross-doc-naming`, `hallucinated-premise`, `literal-value-drift`) consistent across Sections B, C, F, H
- [ ] hallucinated-premise: every ticket-id-to-class mapping traceable to source PRD `:41-86` defect-class enumeration; spot-check confirmed
- [ ] literal-value-drift: `>= 12` finding count matches source PRD `:139` verbatim

---

## Section I — Refinement-manifest schema extension (`ticket_quality_warnings` array)

**Priority: P1 | Order: 80**

*ACs lifted verbatim from `prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md:128` (R-TAQ-7) and `:140` (AC-TAQ-07). Source: `prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md:120-128` (Functional Requirements table). This is the manifest-schema piece; the producers live in Sections A (analyst-side) and B+C (post-decomp audit side).*

**Problem statement**: Today, refinement_manifest.json carries the per-cycle analyst output but has no slot for ticket-quality warnings. Operator who launches a pipeline has no single-pane summary of "these N tickets have path-drift / missing-deps / cross-doc-naming-drift / unverifiable premises" — those warnings either go unsurfaced or scatter across multiple log files. R-TAQ-7 adds a `ticket_quality_warnings: <array>` field to the schema, populated by the analyst-side verification (R-TAQ-1, Section A) and the post-decomp audit (R-TAQ-2/5, Sections B and C). Operator sees a single-pane summary before launch.

Section I is the schema-extension ticket; Sections A/B/C are the producers that write into it. This section MUST land AFTER A/B/C so the schema field exists when the producers try to write.

**Mapped requirements**: R-TAQ-7.

**Source files at HEAD**: `extension/src/services/refinement-manifest.ts` (or wherever the manifest writer lives — confirmed at refine time), `extension/src/types/index.ts` (manifest type definitions), `extension/refinement-manifest.schema.json` (if a JSON schema exists; otherwise create as part of this ticket), `extension/src/bin/spawn-refinement-team.ts:367-525` (manifest construction site).

**Test files (forward-created)**: `extension/tests/refinement-manifest-ticket-quality-warnings-schema.test.js`.

### Acceptance criteria *(lifted verbatim from prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md:128 + :140)*

- **AC-TAQ-07** *(R-TAQ-7, lifted verbatim from PRD line 128 + :140)* — Refinement-manifest schema gains `ticket_quality_warnings: <array>` field, populated by the analyst-side verification (R-TAQ-1) and the post-decomp audit (R-TAQ-2). Operator sees a single-pane summary before launch. refinement_manifest.json contains `ticket_quality_warnings` field. Verify: regression fixture; field present and schema-valid. Type: test.
- **AC-TAQ-07-2** *(R-TAQ-7 schema shape, derived from operator brief)* — `ticket_quality_warnings` is a JSON array of objects, each shaped `{ticket: string, class: string, source: "analyst" | "post-decomp", evidence: string, file_line: string | null}`. Verify: synthetic manifest with 3 warnings (one analyst, one post-decomp path-drift, one cross-doc-naming) validates against the schema. Type: test.
- **AC-TAQ-07-3** *(R-TAQ-7 backwards-compatibility, derived from operator brief)* — Manifests written before this ticket lands (no `ticket_quality_warnings` field) MUST still load without error; missing field defaults to `[]`. Verify: synthetic legacy manifest (no field) loaded by the post-decomp audit returns warnings list `[]` and does not throw. Type: test.
- **AC-TAQ-07-4** *(R-TAQ-7 producer wiring sanity, derived from operator brief)* — When Sections A and B+C have shipped, a fresh `/pickle-quick-refine` run on a synthetic PRD with one deliberate path-drift ticket produces a manifest with at least one `ticket_quality_warnings` entry whose `class: "path-drift"` and `source: "post-decomp"`. Verify: integration test orchestrates a refine + audit pipeline and asserts the manifest entry; depends on A + B + C landing. Type: integration.

### Conformance check stub

<!-- audit: 7-class checked 2026-05-07 -->

- [ ] forward-ref: depends on Sections A, B, C — Entry Conditions hard-dep all three
- [ ] path-drift: `extension/src/bin/spawn-refinement-team.ts` exists at HEAD (confirmed)
- [ ] missing-deps: Entry Conditions: hard-dep on Sections A + B + C; AC-TAQ-07-4 explicitly gates on all three
- [ ] wrong-HEAD-assumptions: source PRD `:128,:140` verified
- [ ] cross-doc-naming: `ticket_quality_warnings` literal matches across source PRD, Section A AC-TAQ-01-3, Section C AC-TAQ-05-2, and this section
- [ ] hallucinated-premise: schema shape `{ticket, class, source, evidence, file_line}` is operator-derived and flagged here for Cycle 1 review
- [ ] literal-value-drift: `ticket_quality_warnings` literal exact match to source PRD `:140`

---

## Section L — `/pickle-standup` output quality + accuracy *(P2 addendum, scope-drift)*

**Priority: P2 | Order: 90**

*ACs derived from operator bug report 2026-05-07. No source PRD — operator reported five gaps surfaced during a live standup that forced manual correction round-trips. Section is scope-drift relative to the refinement-quality + worker-reliability theme of A-I; included here per operator directive ("write this into our next bug fix prd"). Separable: if Cycle 1 reviewers want to lift Section L into a standalone PRD, the lift is mechanical — no R-* code overlap with A-I, no shared file targets.*

**Problem statement**: `/pickle-standup` is the operator's daily Linear-keyed engineering report. The 2026-05-07 run forced two manual correction round-trips because four LOA tickets (LOA-661, LOA-715, LOA-745, plus one cited in PR #1217) shipped commits in-window but didn't surface in Y:. Five distinct gaps were diagnosed:

1. **Helper output is mostly noise.** A 448 KB helper dump contained hundreds of Pickle Rick test sessions (`effort-*-test`, `chain-*-test`, `display-sync-test`, `pipeline-dispatch-session-*`, `citadel-pipeline-session-*`, `pickle-debate-*`) that don't map to Linear tickets. Skill Rule 4 drop-list catches a subset; the rest fall through. **Fix at the source**: `extension/src/bin/standup.ts` filters sessions matching `*-test`, `*-session-*`, `pickle-*-*`, `citadel-*` OR with no associated git branch / Linear ticket — before the helper writes to stdout. Drop list moves from skill prose to helper code.
2. **Step 3 misses in-flight epic PRs.** Skill line 38: `gh pr list --state=open --search "updated:>=$(date -v-Nd ...)"`. Filter is on the PR's metadata `updatedAt`, not commits. PR #1217 (`1025-appraisal-epic`) had `updatedAt: 2026-05-05` but commits inside the window — invisible. Drop the `updated:>=` clause for `--state=open` (open PRs are <10 typically; just list all and intersect with commit activity), or query commit dates: `gh pr list --state=open --json number,title,headRefName,commits` + filter `commits[].committedDate >= window`.
3. **No commit-level LOA-### scan.** Skill Step 4 starts from "Linear issues recently touched by me" — Linear-first algorithm. Old tickets (LOA-661, LOA-715) hadn't been touched in Linear in window but had commits citing `(LOA-661)` / `(LOA-715)` in-window. **Highest-leverage fix**: add Step 2.5 — for each loanlight repo, `git log --all --author=@me --since=$START --pretty="%H %ci %s%n%b"`, regex out every `LOA-\d+`, then `mcp__linear__get_issue` each unique ID. Catches old-ticket-with-new-commits, today's commits (`7db4bb5d` at 07:30 today on LOA-745 was missed), and drift candidates (commit cites LOA-### but Linear status is Todo/In Progress).
4. **Hardcoded repo list.** Skill line 41 names `loanlight-api`, `loanlight-integrations`, `loanlight-app` — but `loanlight-app/` doesn't exist on this machine, so the `gh` call errors and cancels its parallel siblings. Auto-discover: `for d in /Users/gregorydickson/loanlight/*/; do [ -d "$d/.git" ] && echo "$d"; done`. Fail-soft on missing repos; include any new repo without skill edit.
5. **`--days 1` semantics ambiguity.** Today's 07:30 commit (LOA-745) was missed because the operator mental model of `--days 1` was "yesterday only", but the actual filter `date -v-1d` produces "since yesterday 00:00 through now" (which DOES include today). **Doc fix**: rename the flag or add explicit doc — current "yesterday's activity" wording in skill line 13 is misleading.

**Of these, #3 is highest-leverage** (catches all four missed tickets). **#2 is second** (in-flight epic PRs are exactly where multi-ticket work parks). **#1 and #4 are quality-of-life**. **#5 is doc-only**.

**Mapped requirements**: R-PSU-1..5 (one per gap, derived).

**Source files at HEAD**:
- `extension/src/bin/standup.ts` (16541 bytes) — primary helper script
- `extension/bin/standup.js` — compiled mirror
- `.claude/commands/pickle-standup.md` (8383 bytes) — skill prompt
- `~/.claude/commands/pickle-standup.md` — deployed skill mirror (not edited directly; touched by `bash install.sh`)

**Test files (forward-created)**:
- `extension/tests/standup-helper-noise-filter.test.js`
- `extension/tests/standup-commit-loa-scan.test.js`
- `extension/tests/standup-repo-discovery.test.js`

### Acceptance criteria *(derived from operator bug report 2026-05-07)*

- **AC-PSU-01** *(R-PSU-1, derived from operator brief)* — `extension/src/bin/standup.ts` filters sessions whose names match `/^effort-.*-test$/`, `/^chain-.*-test$/`, `/^display-sync-test/`, `/^pipeline-dispatch-session-/`, `/^citadel-pipeline-session-/`, `/^pickle-debate-/`, OR sessions whose `branch` field is empty AND no `linear_ticket` field is present. Drop happens BEFORE writing to stdout. New activity event `standup_session_dropped` registered in `VALID_ACTIVITY_EVENTS` + `activity-events.schema.json` with payload `{session_name, drop_reason}`. Verify: synthetic helper input with 5 noise sessions + 2 real-ticket sessions outputs only the 2 real-ticket sessions. Type: unit test.
- **AC-PSU-02** *(R-PSU-2, derived from operator brief)* — Skill Step 3 query for `--state=open` drops the `--search "updated:>=..."` clause. Replacement query: `gh pr list --author "@me" --state open --json number,title,headRefName,commits --limit 30`, then filter PRs whose `commits[].committedDate >= $window` in JS. Skill prose updated to describe the new query. Verify: synthetic mock with one open PR whose `updatedAt` is OUT-OF-window but `commits[0].committedDate` is IN-window — PR appears in standup output as in-flight. Type: integration.
- **AC-PSU-03** *(R-PSU-3, highest-leverage, derived from operator brief)* — Skill gains a new Step 2.5 between Step 2 (Linear pull) and Step 3 (PR pull). For each auto-discovered loanlight repo (per AC-PSU-04), run `git log --all --author=@me --since=$START --pretty="%H %ci %s%n%b"`, regex `/\bLOA-\d+\b/g` over the full output, dedupe IDs, then `mcp__linear__get_issue` each one. Merge results into Step 4's join algorithm — any ticket discovered via commit-LOA-scan that's not in the Linear-recent set is added with state from the get_issue response. Standup output flags drift inline (e.g. `LOA-661 — ... (Linear still Todo)` per existing Rule 7). Verify: synthetic git log with 3 LOA cites (1 ticket touched in Linear, 2 not) — all 3 appear in standup; the 2 not in Linear-recent get drift annotation. Type: integration.
- **AC-PSU-04** *(R-PSU-4, derived from operator brief)* — Skill Step 3 replaces hardcoded repo list with shell auto-discovery: `for d in /Users/gregorydickson/loanlight/*/; do [ -d "$d/.git" ] && echo "$d"; done`. Skip `pickle-rick-claude/`. Each `gh pr list` call wrapped in `|| true` so a single repo failure doesn't cancel parallel siblings. Verify: synthetic dir tree where `loanlight/{a,b,c,d}/.git` exists and `loanlight/x/` exists without `.git` — discovery returns `{a,b,c,d}` and skips `x`. Type: unit test.
- **AC-PSU-05** *(R-PSU-5, doc-only, derived from operator brief)* — Skill line 13 wording "If no arguments provided, defaults to `--days 1` (yesterday's activity)" replaced with "If no arguments provided, defaults to `--days 1` (since yesterday 00:00 — INCLUDES today's commits to current time)". Common-usage section adds: "`/pickle-standup` (default) — yesterday 00:00 through now, INCLUDING today". Verify: skill grep for the exact replacement string + check-readiness probe for the literal "INCLUDES today's commits". Type: doc-only test.
- **AC-PSU-06** *(R-PSU-forensic, derived from operator brief)* — Forensic regression: synthetic standup replay of 2026-05-07 case (LOA-661, LOA-715, LOA-745, PR #1217 input data) — output MUST surface all four tickets in Y: without operator correction. Verify: integration test loads fixture `extension/tests/fixtures/standup-2026-05-07.json` (synthetic git log + Linear MCP responses + gh pr list responses), runs the updated standup pipeline end-to-end, asserts the four ticket IDs appear. Type: integration.

### Conformance check stub

<!-- audit: 7-class checked 2026-05-07 -->

- [ ] forward-ref: synthetic fixture `extension/tests/fixtures/standup-2026-05-07.json` is forward-created (does not exist at HEAD); test files in `extension/tests/standup-*.test.js` are forward-created (none exist at HEAD)
- [ ] path-drift: `extension/src/bin/standup.ts` confirmed at HEAD (16541 bytes); `.claude/commands/pickle-standup.md` confirmed at HEAD (8383 bytes); deployed skill mirror at `~/.claude/commands/pickle-standup.md` is install.sh-managed, not edited directly
- [ ] missing-deps: AC-PSU-04 (auto-discovery) is hard-dep for AC-PSU-03 (commit-LOA scan iterates the discovered repos); AC-PSU-04 is hard-dep for AC-PSU-02 (open-PR query iterates the discovered repos)
- [ ] wrong-HEAD-assumptions: Section L assumes `extension/src/bin/standup.ts` is canonical (TS) and `extension/bin/standup.js` is the compiled mirror — verified in repo CLAUDE.md "Source of Truth" section
- [ ] cross-doc-naming: skill file deployed copy at `~/.claude/commands/pickle-standup.md` is rsync-managed by `bash install.sh`; section refers to source `.claude/commands/pickle-standup.md` only
- [ ] hallucinated-premise: Operator-cited LOA-661, LOA-715, LOA-745, PR #1217 are forensic anchors from 2026-05-07; ticket-authoring agent SHOULD confirm these exist in the Linear MCP before accepting AC-PSU-06's fixture data
- [ ] literal-value-drift: regex patterns in AC-PSU-01 (`/^effort-.*-test$/` etc.) are operator-supplied; verify case-sensitivity and anchor placement match the helper output's actual session-name format

---

## Conformance Check

For each section, the ticket file produced by `/pickle-quick-refine` (or refinement) MUST:

- [ ] **Cite source PRD path** in the ticket frontmatter `source_prd:` field. Sections A-I cite a source PRD; Section L cites `inline-2026-05-07-standup-bug-report` (operator brief).
- [ ] **Lift R-XXX requirement codes verbatim** in the AC list — no paraphrase of identifiers (case + dashes preserved). R-TAQ-* (Sections A/B/C/F/H/I), R-WSE-* (Section D), R-ICP-5/6 (Section G), R-PSU-* (Section L, derived inline).
- [ ] **Include explicit `file:line` anchors** where the source PRD specified them. Sections A-I carry concrete line numbers from their source PRDs (per the section headers' `lifted from <PRD>:<line-range>` annotation). Section L's anchors are byte-counts on `extension/src/bin/standup.ts` and skill line numbers on `.claude/commands/pickle-standup.md`.
- [ ] **7-class machinability check** annotation in the ticket frontmatter:

```yaml
audit:
  classes_checked: [path-drift, self-referential-AC, missing-deps, wrong-HEAD-assumptions, cross-doc-naming, hallucinated-premise, literal-value-drift]
  checked_at: 2026-05-07
  # Ticket file MUST contain the literal HTML comment: <!-- audit: 7-class checked 2026-05-07 -->
```

- [ ] **Verbatim-lift annotation**: Sections A-I carry `*(ACs lifted verbatim from <PRD-path>:<line-range>)*` for ACs that lift directly. Section D's R-WSE codes exist verbatim in source PRD `:80-83`. Operator-derived ACs (AC-WSE-05/06/RC2-XREF, AC-TAQ-*-2/-3/-4 supplements, AC-TAQ-BACKFILL-01, AC-TAQ-FIXTURE-01, all of AC-PSU-01..06) are explicitly marked `*(derived from operator brief)*`.
- [ ] **No `composes:` block** in the ticket frontmatter — ACs MUST be in-section, not delegated. (This bundle's authoring constraint, learned from 2026-05-05 Path A.)
- [ ] **`Priority: P1` or `P2`** literal in the section header (Sections A-I are P1; Section L is P2 addendum).

### Bundle-level conformance

- [ ] **AC-BUNDLE-THEMEA-01** — All 9 sections present in this PRD. Verify: `grep -c '^## Section ' prds/p1-bug-fix-bundle-theme-a-refinement-quality.md` = 9.
- [ ] **AC-BUNDLE-THEMEA-02** — Every R-* code in section bodies maps to exactly one AC line (no orphan codes). Verify: `grep -E 'R-(TAQ|WSE|ICP|PSU)-[0-9]+' prds/p1-bug-fix-bundle-theme-a-refinement-quality.md | sort -u | wc -l` matches the AC count.
- [ ] **AC-BUNDLE-THEMEA-03** — No `composes:` block in the front-matter. Verify: `grep -c 'composes:' prds/p1-bug-fix-bundle-theme-a-refinement-quality.md` returns 0 (only the literal token in `deferred:` prose explaining what we don't do is allowed; mitigation: the deferred-block prose uses backticked `composes:` in code-fence form so the grep MUST match `^composes:` — verify the count of unindented `composes:` is 0).
- [ ] **AC-BUNDLE-THEMEA-04** — Verbatim-lift attribution present for every Section A-I source-PRD-backed section. Verify: `grep -c 'lifted from prds/' prds/p1-bug-fix-bundle-theme-a-refinement-quality.md` ≥ 8. Section L is operator-derived inline; not counted in this lift threshold.
- [ ] **AC-BUNDLE-THEMEA-05** — Bundle ends with a clean working tree on local `main` and a green local gate (`cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && npm run test:fast && npm run test:integration`). NO `gh release create`; NO push.
- [ ] **AC-BUNDLE-THEMEA-06** — Sequencing constraint enforced: B lands BEFORE C and H; A lands BEFORE I; A+B+C land BEFORE I. Section L is independent of A-I and may run in parallel. Implementation queue MUST honor `Order:` annotations 10..90.

---

## Skipped / deferred (final list)

- **Section E (path-drift validator standalone ticket)** — folded into Section B as Class 1 of the 7-class scanner. Source: `prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md:41-50` covers the same failure mode as `prds/archive/bug-reports/p2-worker-silent-exit-and-ticket-path-drift.md:48-60` RC-2; Section B's `audit-ticket-bundle.js` runs the path-drift check as the first of seven defect-class checks. Section D's AC-WSE-RC2-XREF cross-references Section A as the upstream prevention. No separate ticket needed.
- **Section J (`audit-ticket-paths.js` operator-only script)** — `prds/archive/bug-reports/p2-worker-silent-exit-and-ticket-path-drift.md:86` R-RPD-3 — deferred to P2 in the next-next batch. Operator can run Section B's `audit-ticket-bundle.js` against a session root manually for the same effect; the standalone script is convenience-only.
- **Section K (backfill validation as separate ticket)** — folded into Section H. Same "validate audit catches the 12 documented defects" goal; H carries AC-TAQ-BACKFILL-01.
- `prds/archive/bug-reports/p1-iteration-cap-and-phantom-done-handshake.md` R-1 (cap persistence) and R-2 (cap-hit exit code 3) — already shipped in 2026-05-06 bundle Sections I and J. This bundle covers ONLY R-3 (Section G).
- `prds/archive/bug-reports/p2-worker-silent-exit-and-ticket-path-drift.md` R-RPD-1..4 — RC-2 path-drift fixes. R-RPD-1 is subsumed by Section A's R-TAQ-1 (same analyst-prompt fix). R-RPD-2 is subsumed by Section B's R-TAQ-2 (same audit scanner). R-RPD-3 is the deferred Section J script. R-RPD-4 is subsumed by Section H's fixture corpus.

— Pickle Rick out. *belch*

# PRD: Citadel PRD-Conformance Core (T3 / T4 / T5 / T6 / T8) Not Surfaced in Live Report

**Status**: **CLOSED via verify-then-close 2026-05-14 PM** — HEAD audit (5 parallel Explore agents against `c8f64d88` / deployed `v1.74.0`) confirmed the wiring scope of this PRD is shipped:

| AC | Status | Evidence |
|---|---|---|
| AC-01 | NOT-SHIPPED | Shell script absent; JS variant `extension/scripts/audit-citadel-wiring.js` exists instead. No `extension/audit/citadel-section-coverage-2026-05-09.md`. Optional cleanup. |
| AC-02 | SHIPPED | All 4 analyzers (T3 ac-coverage-scorecard, T4 allowlist-dead-entry-detector, T5 endpoint-contract-conformance, T8 state-transition-audit) imported + invoked + sectioned at `extension/src/services/citadel/audit-runner.ts:15-145` |
| AC-03 | SHIPPED | `extension/src/services/citadel/trap-door-coverage-audit.ts` exists, wired at `audit-runner.ts:18+110`, `trap_door_coverage` section emits at `:130/:144` |
| AC-04 | SHIPPED | Composes-chain walker fully at `prd-parser.ts:433-555` with cycle detection + depth limit; mega-bundle yields 75 ACs + 26 R-codes (>60 target) |
| AC-05 | PARTIAL | Skipped-emission contract works (`{findings:[], skipped:'project_shape_mismatch', reason}`) but uses `reason` field, not `detail` as PRD spec'd. Cosmetic field-naming drift. |
| AC-06 | SHIPPED | `rule-set-invariant-audit.ts:383-426` parses INVARIANT/BREAKS/ENFORCE triples; populates `inventory` field |
| AC-07 | SHIPPED | `extension/tests/citadel/citadel-analyzer-wiring.test.js` asserts ≥10 analyzer modules imported + 12 section keys present |
| AC-08 | SHIPPED | Trap-door pin at `extension/CLAUDE.md:198` labeled `R-CCNW-2 analyzer wiring` (fulfills R-CCNW-8 intent) |
| AC-09 | SHIPPED (static) | Sections-map shape correct: `ac_coverage`, `allowlist_dead`, `trap_door_coverage`, `state_transitions` all present; T3 emits Critical for zero-match ACs (`ac-coverage-scorecard.ts:267`) |

**The semantic gap that motivated the P2→P1 promotion is a DIFFERENT bug.** The wired analyzers ran on b54f2143 and emitted 288 findings exit 0 — but zero referenced the 4 anatomy-park-fixed files (`release-gate.sh`, `verify-recapture-fired.js`, `verify-bundle.js`, `convergence-gate.ts`). The wiring works; the detection-coverage logic doesn't catch the silent-gate-pass class. **Successor PRD**: `prds/archive/bundles/p1-citadel-detection-coverage-silent-gate-pass.md` (R-CCDC, filed 2026-05-14 PM) scopes the detection-coverage diagnosis and fix.

Optional cleanup tickets that may be filed standalone (do not block R-CCDC):
- AC-01 cleanup — port `audit-citadel-wiring.js` to `audit-citadel-section-coverage.sh` shape, commit diagnostic table to `extension/audit/`
- AC-05 cleanup — rename `reason` → `detail` in `AnalyzerSkippedResult`, or accept current naming and update PRD spec to match

The original problem statement and requirements below are preserved as historical context. **Do NOT use this PRD as a current-HEAD problem statement.**

---

## Historical problem statement (pre-2026-05-14 — preserved for reference)

Originally filed 2026-05-09 and bumped P2→P1 on 2026-05-14 after pipeline `2026-05-13-b54f2143` (R-TSPF + anatomy-park) demonstrated this is *load-bearing*, not nice-to-have. Citadel ran in 1.3s and produced 288 findings on that bundle (good — citadel-side analyzers shipped post-2026-05-09), but **anatomy-park subsequently shipped 6 CRITICAL + 21 HIGH fixes on the same diff** — including four explicit silent-gate-pass CRITICALs (`release tarball install payload false-green`, `delegated test gate false-green`, `verify-bundle unknown AC false-green`, `stale anatomy window recapture pass`). Three of those CRITICALs are exactly the class citadel's T3/T6/T8 sections were designed to catch. Anatomy-park caught what citadel should have. Until R-CCNW wires conformance core into the gate chain (not just the report), every bundle relies on anatomy-park as the only effective conformance audit — and anatomy-park is a 3-4h phase, not a 1.3s phase.

## 2026-05-14 promotion evidence (b54f2143)

Citadel `citadel_report.json` for pipeline `2026-05-13-b54f2143`: **288 findings, exit 0** (no CRITICAL/HIGH surfaced as fatal). Anatomy-park on the same diff (still in flight at time of filing, currently iter 27) committed:
- `46dc21a6` bin CRITICAL — release tarball install payload false-green (T6 trap-door coverage class)
- `91f10462` bin CRITICAL — stale anatomy window recapture pass (T8 state-machine class)
- `a38492c9` extension CRITICAL — delegated test gate false-green (T3 AC scorecard class)
- `1bc49d48` bin HIGH — verify-bundle unknown AC false-green (T4 allowlist dead-entry class)

The shape of these is "the validator was lying" — same family as the LOA-618 post-mortem that motivated the original citadel PRD. R-CCNW's wiring fix is the structural answer; without it, anatomy-park is the only safety net.

**Status (continued)**: citadel is partially wired. Five of its core PRD-conformance audit tasks have shipped analyzer modules but do NOT appear in the live `citadel_report.json` `sections` map. The result: citadel runs in 1.3s, returns "0 critical / 0 high / 0 medium" for every pipeline run, and the operator infers the branch is conformance-clean. **It isn't checked.** Citadel still earns its second of compute via diff hygiene + divergence reconciliation, but its CORE PURPOSE per `prds/citadel.md` line 17 — "validates an entire branch's diff against the PRD it was built from" — is structurally absent from the sections it reports.
**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`
**Sibling of**: `prds/citadel.md` (the design PRD this bug indicts) — task list at `prds/citadel.md:118` defines T3..T11 as the audit surface; this PRD reports the runtime delta from that spec.
**Triggering session**: `2026-05-09-7ff82595` — `/pickle-pipeline --no-refine --backend claude prds/archive/bundles/p1-bug-fix-bundle-2026-05-08-mega.md`. Phase 2/4 (citadel) wrote `citadel_report.json` with 1 LOW informational finding ("anatomy-park.json absent — skipping pattern-replay") and zero from any conformance section. Bundle has ~60 ACs (R-CCPL-1..6, R-SCJM-1..6, R-APWS-1..7, R-PSAI-1..10, R-RJR-1..3, R-CMD-1..4, R-PJV-1..6, R-SED-1..7, R-MJCP-1..8, R-CLOSER-1..3, R-A-01..03) and 4+ trap-door entries (R-CCPL-8, R-SCJM-5, R-APWS-6, R-MJCP-7); none cross-referenced against the diff. Citadel signed off on a bundle whose Sections B (Slot G) and C (Slot H) shipped only fix-only commits (`7f8cf07b` audit-trapdoor-shorten, no R-SCJM keystone) — it had no machinery to notice.

---

## Severity: P2

- Citadel does still run and produces real value via:
  - **T10.9 diff hygiene** — scanned 31 added files this run, 0 hygiene findings (working).
  - **T11 divergence reconciliation** — scanned 16 changed tests + 2 trap-door files (working).
- But the CORE purpose (whole-branch PRD conformance) does not fire. For LOA-618-class regressions — AC violations, trap doors with no negative test, allowlist dead entries — citadel currently provides ZERO assurance, which is worse than a known-absent gate because the operator reads the green report as conformance-clean.
- Severity climbs to P1 if any future bundle ships an AC-violating change that citadel was nominally responsible for catching. The pickle-rick-claude codebase has not yet bitten this class because the mega bundle's tickets passed through worker-side spec-conformance + manual review, but the protection is luck, not citadel.

---

## What was missed

### Live `citadel_report.json` sections (session `2026-05-09-7ff82595`)

```json
{
  "schema": "1.0",
  "exit_code": 0,
  "sections": {
    "sibling_auth_preconditions": { "controllers": 0, "routes": 0, "findings": [] },
    "frontend_prop_drift":        { "files": 0, "components": 0, "findings": [] },
    "ac_shape":                   { "decisionsRequired": 0, "highFindings": 0, "findings": [] },
    "rule_set_invariants":        { "declarations": 0, "covered": 0, "findings": [] },
    "diff_hygiene":               { "added_files_scanned": 31, "findings": 0 },
    "divergence_reconciliation":  { "changed_tests_scanned": 16, "trap_door_files_scanned": 2, "findings": [] },
    "cross_phase":                { "anatomy_park": 0, "anatomy_park_missing": true, "findings": [{ "severity": "Low", "id": "anatomy-park:missing" }] }
  },
  "summary": { "findings": 1, "critical": 0, "high": 0, "medium": 0, "low": 1 }
}
```

7 sections present. Per `prds/citadel.md` § Tasks (T3–T11), the following are MISSING from the live report:

### Missing sections (analyzer module exists; not surfaced in report)

| Task | PRD spec | Analyzer module | Live section in report? |
|---|---|---|---|
| **T3** | AC coverage scorecard — every PRD AC has implementing code + test in diff | `extension/src/services/citadel/ac-coverage-scorecard.ts` (10.9K) | ❌ |
| **T4** | Allowlist dead-entry detector — every new VALID_ACTIONS / enum / event has ≥1 production caller | `extension/src/services/citadel/allowlist-dead-entry-detector.ts` (11.2K) | ❌ |
| **T5** | Endpoint contract conformance — every documented HTTP endpoint throws/returns documented status codes | `extension/src/services/citadel/endpoint-contract-conformance.ts` (10.3K) | ❌ (acceptable for Node CLI but should emit `skipped: project_shape_mismatch`) |
| **T6** | Trap-door coverage gate — every CLAUDE.md INVARIANT bullet has a presence test + a negative-case test | (no file `trap-door-coverage.ts`; logic may live inside `audit-runner.ts` or another module) | ❌ |
| **T7** | Sibling proxy-route divergence — `*/route.ts` cohorts share error-handling shape | (no file `sibling-proxy-route-divergence.ts`) | ❌ (acceptable for Node CLI; same skipped-reason emit) |
| **T8** | State-machine transition audit — every PRD transition row has a corresponding audit emit | `extension/src/services/citadel/state-transition-audit.ts` (5.8K) | ❌ |
| **T10.5** | Resource-module guard parity (cross-route) | (not found as standalone file) | ❌ |
| **T10.7** | Pattern-replay against anatomy-park output | partial — `cross_phase` section emits "anatomy-park.json missing" but does not actually replay pattern_shape regexes | partial |

### Where the analyzers WOULD have caught real issues in this bundle

- **T3 (AC coverage)**: Bundle PRD declares R-CCPL-1..6 with AC-CCPL-01..08. Section B (`f3bf3c86`) shipped commit `7f8cf07b` whose only diff is a trap-door-entry length fix. T3's keyword-anchor heuristic (per `prds/citadel.md:171`) should have produced a row `| AC-CCPL-01 | ✗ | ✗ | (no enforcement found) |` and emitted Critical. It did not.
- **T4 (dead-entry)**: Bundle adds new activity events `worker_edit_outside_scope` (R-APWS-3) and `pkgjson_revert_forensic_captured` (R-PJV-5) — both registered in the schema. T4 should have grep'd production code (excluding `*.test.js`) for ≥1 caller of each. If `pkgjson_revert_forensic_captured` only exists in the schema + types (no emitter wired yet because Section H is `DIAGNOSE`-only), T4 should have flagged it as a High finding ("dead allowlist; deploy-ordering smell" per `prds/citadel.md:184`). It did not.
- **T6 (trap-door coverage)**: Bundle adds R-CCPL-8, R-SCJM-5, R-APWS-6, R-MJCP-7 trap-door entries with explicit ENFORCE clauses. T6 should have verified each ENFORCE clause names a test that contains a negative-case assertion (per `prds/citadel.md:210` "rejects when not Y"). It did not.

---

## Root causes

### RC-1 — `audit-runner.ts` does not invoke all analyzer modules

The `extension/src/services/citadel/audit-runner.ts` orchestrator (8.7K, the entry point that produces the `sections` map) appears to invoke 7 analyzers (the ones present in the live report) but not the 4 modules that exist on disk and are NOT in the report (T3 ac-coverage-scorecard, T4 allowlist-dead-entry-detector, T5 endpoint-contract-conformance, T8 state-transition-audit).

Either:
- (a) The orchestrator imports and calls them but elides their sections from the report when the analyzer's input set is empty (e.g. T3 requires a parsed AC list and the parser returned 0 ACs from the bundle PRD).
- (b) The orchestrator does not import them at all — wiring drift between the analyzer modules and `audit-runner.ts`.

Diagnostic step in R-CCNW-1 below distinguishes (a) from (b).

### RC-2 — PRD parser may not handle bundle PRD `composes:` frontmatter

`prds/citadel.md` T1 spec at line 131 says the parser walks "a PRD markdown file" and extracts AC IDs matching `AC-[A-Z0-9]+(-[A-Z0-9]+)*(-\d+)?`. Bundle PRDs (the dominant authoring shape in this project) inherit ACs from a `composes:` chain — e.g. `prds/archive/bundles/p1-bug-fix-bundle-2026-05-08-mega.md` composes 9 source PRDs and lifts their ACs by reference (`R-CCPL-1..6 (=source R1..R6)`). If the parser only walks the top-level PRD it sees:

- ~15 ACs declared inline in the bundle PRD (`AC-A-01..03`, `AC-CMD-01..04`, `AC-RJR-01..03`, etc.)
- ZERO of the ~50 ACs lifted-by-reference from composed source PRDs.

This is a parser-shape mismatch with the bundle-PRD authoring idiom, not a parser bug per se — the parser was designed against monolithic PRDs (LOA-618 style) and has not been adapted for the bundle/composes shape.

### RC-3 — Trap-door coverage analyzer (T6) may not exist as a standalone module

The `extension/src/services/citadel/` directory has no file named `trap-door-coverage.ts` or similar. T6 is the highest-leverage task per the LOA-618 post-mortem (S3-key class), and `prds/citadel.md` line 202 specifies it explicitly. Either:
- (a) The trap-door coverage logic lives inside `audit-runner.ts` or another module under a different name and is not surfacing a section.
- (b) T6 was specified but not implemented.

### RC-4 — Sections that DO appear emit "0 declarations / 0 components / 0 routes" without distinguishing project-shape-mismatch from analyzer-found-nothing

`sibling_auth_preconditions` and `frontend_prop_drift` correctly return empty for a Node CLI (no NestJS controllers, no React JSX). But they emit `{ controllers: 0, routes: 0, findings: [] }` rather than `{ skipped: 'project_shape_mismatch', reason: 'no NestJS controllers found in diff' }`. The operator can't tell whether the analyzer ran-and-found-nothing vs. ran-and-cleared.

`rule_set_invariants` returns `{ declarations: 0, covered: 0 }` for pickle-rick-claude. The project DOES have invariants (the trap-door pattern with INVARIANT/BREAKS/ENFORCE triples in `extension/CLAUDE.md`, ~120 of them per the trap-door audit). So either:
- The analyzer doesn't recognize the trap-door-triple shape as a "rule-set declaration".
- The analyzer's parser is tuned for class-based business-rule libraries (NestJS / Spring style) and doesn't match this idiom.

### RC-5 — No project-shape detection upstream of section invocation

A Node-CLI / markdown-PRD project should NOT need to run `frontend_prop_drift` or `endpoint_contract_conformance`. Inverting: a NestJS web app SHOULD run T3/T4/T5/T6/T7/T8/T9/T10. The orchestrator does not detect project shape and dispatch sections accordingly. The result: every section runs every time, and project-shape-mismatched sections emit silent zeros.

---

## Requirements

### R-CCNW-1: Diagnose runtime delta — does `audit-runner.ts` invoke T3/T4/T5/T8?

Add a debug script `extension/scripts/audit-citadel-section-coverage.sh` (NEW) that:

1. Greps `extension/src/services/citadel/audit-runner.ts` for every imported module under `extension/src/services/citadel/`.
2. Compares the import list against the file inventory of `extension/src/services/citadel/*.ts`.
3. Emits a markdown table:

```
| Module                        | Imported? | Section in report? |
|-------------------------------|:---------:|:------------------:|
| ac-coverage-scorecard.ts      | ✓ / ✗     | ✓ / ✗              |
| allowlist-dead-entry-detector | ✓ / ✗     | ✓ / ✗              |
| endpoint-contract-conformance | ✓ / ✗     | ✓ / ✗              |
| state-transition-audit        | ✓ / ✗     | ✓ / ✗              |
| trap-door-coverage            | n/a       | ✗                   |
```

The row for `trap-door-coverage` confirms whether it's a missing module (RC-3a) or just not surfacing.

### R-CCNW-2: Wire missing analyzers into `audit-runner.ts`

For each analyzer module that exists on disk and is NOT being invoked (per R-CCNW-1's table):

1. Import the module into `audit-runner.ts`.
2. Invoke it on the parsed PRD + diff inputs.
3. Add its result to the `sections` map under its canonical name (`ac_coverage`, `allowlist_dead`, `endpoint_contract`, `state_transitions`).
4. Surface its findings into the top-level `findings` array with severity propagation (Critical = exit 1; High = exit 1 in `--strict`).

### R-CCNW-3: Implement T6 (trap-door coverage gate) if absent

If R-CCNW-1's diagnostic confirms T6 has no module, build `extension/src/services/citadel/trap-door-coverage.ts` per `prds/citadel.md:202` spec:

1. Parse all CLAUDE.md files in the diff range (T2 diff-walker already handles this).
2. For each INVARIANT/BREAKS/ENFORCE triple, extract the cited test file from the ENFORCE clause.
3. **Presence check**: grep the cited test for ≥1 `it()` / `describe()` whose body references the trap-door's named-entity anchors.
4. **Enforcement check**: for trap doors with structural INVARIANT shape (regex / segment count / range bound), assert the spec contains a negative-case test (input violating the pattern is rejected).
5. Emit High finding for each trap door with no matching test or with positive-only tests.

### R-CCNW-4: PRD parser walks `composes:` frontmatter chain for bundle PRDs

`extension/src/services/citadel/prd-parser.ts` (T1 module) gains:

1. Detect bundle-PRD shape: frontmatter has a `composes:` key listing `prds/<file>.md` paths.
2. For each composed source PRD, recursively parse and lift its ACs / R-codes / endpoints / allowlist entries into the bundle PRD's parsed entity set.
3. Cycle detection: if a composed PRD references back to its parent, fail loud with a structured error.
4. Section parser also recognizes `R-[A-Z]+-\d+` codes as AC-equivalent entities (current regex per `prds/citadel.md:135` matches only `AC-...`; bundle PRDs use both forms interchangeably).

### R-CCNW-5: Project-shape detection + section dispatch

`audit-runner.ts` gains a project-shape preflight:

1. Probe for NestJS controllers (presence of `@Controller(...)` decorator in any `extension/src/`-equivalent path of the target).
2. Probe for React JSX (presence of `*.tsx` files).
3. Probe for state-machine PRDs (presence of `Transition | Audit` table headers in the parsed PRD).

When a probe returns false, the corresponding sections (T5 endpoint-contract for non-NestJS, T10/T10.5 frontend-prop-drift for non-React, T8 state-machine for PRDs lacking transition tables) emit `{ skipped: true, reason: 'project_shape_mismatch', detail: '<one-line>' }` rather than empty arrays. Operators reading the report can distinguish "ran clean" from "didn't run".

### R-CCNW-6: Rule-set invariant analyzer recognizes trap-door triples

`rule-set-invariant-audit.ts` gains a parser branch that recognizes the project's trap-door triple shape:

```
- INVARIANT: <claim>
- BREAKS: <consequence>
- ENFORCE: <test_file_path>
```

When this shape is found in any CLAUDE.md file in the diff, each triple counts as a "declaration" in the section's `inventory` field. Coverage check: the cited ENFORCE test exists and is in the diff or in the test corpus.

### R-CCNW-7: Regression test asserting all analyzer modules are invoked

`extension/tests/citadel-audit-runner-section-coverage.test.js` (NEW) asserts:

1. Every `extension/src/services/citadel/*.ts` module (excluding `audit-runner.ts`, `reporter.ts`, `prd-parser.ts`, `diff-walker.ts` which are infra) is imported by `audit-runner.ts`.
2. Each invoked module contributes a section to the `sections` map (or emits `skipped: project_shape_mismatch` explicitly).

This test catches drift if a future analyzer module is added but not wired in.

### R-CCNW-8: Trap-door entry pinned in `extension/CLAUDE.md`

> `services/citadel/audit-runner.ts` — INVARIANT: every analyzer module under `services/citadel/` MUST be either (a) imported and invoked by audit-runner with its section name in the `sections` map, OR (b) explicitly excluded via a documented allowlist with rationale. BREAKS: structural drift where analyzers exist but never run, producing false-clean reports that lull the operator into trusting unchecked branches. ENFORCE: extension/tests/citadel-audit-runner-section-coverage.test.js.

---

## Acceptance Criteria

- **AC-CCNW-01** — `extension/scripts/audit-citadel-section-coverage.sh` exists and emits the import-vs-section diagnostic table. Output committed at `extension/audit/citadel-section-coverage-2026-05-09.md`.
- **AC-CCNW-02** — `audit-runner.ts` imports and invokes T3 (ac-coverage-scorecard), T4 (allowlist-dead-entry-detector), T5 (endpoint-contract-conformance — may emit `skipped: project_shape_mismatch` for Node CLI projects), T8 (state-transition-audit — same skipped-reason allowed). Each emits a section in `citadel_report.json`.
- **AC-CCNW-03** — T6 trap-door-coverage analyzer exists at `extension/src/services/citadel/trap-door-coverage.ts` and is invoked. For pickle-rick-claude's diff, T6 finds the trap-door triples cited in CLAUDE.md, classifies each as covered / unguarded, and emits findings.
- **AC-CCNW-04** — `prd-parser.ts` recursively walks `composes:` frontmatter and surfaces ACs from composed source PRDs. Verified against `prds/archive/bundles/p1-bug-fix-bundle-2026-05-08-mega.md`: parser emits ≥60 AC entities (from R-CCPL-1..6, R-SCJM-1..6, R-APWS-1..7, R-PSAI-1..10, R-RJR-1..3, R-CMD-1..4, R-PJV-1..6, R-SED-1..7, R-MJCP-1..8, R-CLOSER-1..3, R-A-01..03).
- **AC-CCNW-05** — Sections with no work to do emit `{ skipped: true, reason: 'project_shape_mismatch', detail: '<reason>' }` rather than `{ controllers: 0, components: 0, ... findings: [] }`. Verified by grepping the report for skipped-reason strings.
- **AC-CCNW-06** — `rule-set-invariant-audit.ts` recognizes the trap-door INVARIANT/BREAKS/ENFORCE triple shape. For pickle-rick-claude's `extension/CLAUDE.md`, the section's `inventory` count is non-zero (matches the project's actual ~120 trap-door entries in the changed CLAUDE.md region of the diff).
- **AC-CCNW-07** — Regression test `extension/tests/citadel-audit-runner-section-coverage.test.js` asserts the (a)/(b) invariant from R-CCNW-8.
- **AC-CCNW-08** — Trap-door entry per R-CCNW-8 lives in `extension/CLAUDE.md` and is found by `extension/tests/trap-door-conformance.test.js`.
- **AC-CCNW-09** — Manual reproduction: re-run citadel against session `2026-05-09-7ff82595`'s diff (via `node extension/bin/citadel.js --prd <bundle-prd> --diff 2e72952074dc8ea91697a29a854a548484c8e4f9..HEAD`). The new report MUST contain `ac_coverage`, `allowlist_dead`, `trap_door_coverage`, `state_transitions` sections. T3 MUST emit Critical findings for AC-codes that have zero matching commit/file references in the diff.

---

## Implementation sketch

```typescript
// audit-runner.ts (after R-CCNW-2 wiring)

import { runAcCoverageScorecard } from './ac-coverage-scorecard.js';
import { runAllowlistDeadEntry } from './allowlist-dead-entry-detector.js';
import { runEndpointContract }   from './endpoint-contract-conformance.js';
import { runTrapDoorCoverage }   from './trap-door-coverage.js';      // NEW per R-CCNW-3
import { runStateTransitionAudit } from './state-transition-audit.js';
import { runSiblingAuthAudit }   from './sibling-auth-audit.js';
import { runFrontendPropDrift }  from './frontend-prop-drift-audit.js';
import { runRuleSetInvariants }  from './rule-set-invariant-audit.js';
import { runDiffHygiene }        from './diff-hygiene.js';
import { runDivergenceReconciliation } from './divergence-reconciliation.js';
import { runAcShapeAudit }       from './ac-shape-audit.js';
import { detectProjectShape }    from './project-shape.js';            // NEW per R-CCNW-5

export async function runCitadelAudit({ prdPath, diffRange, ... }) {
  const prd = parsePrd(prdPath);                                       // R-CCNW-4: walks composes:
  const diff = walkDiff(diffRange);
  const shape = detectProjectShape(diff.targetRoot);

  const sections: Record<string, SectionResult> = {};

  // Always run
  sections.ac_coverage         = await runAcCoverageScorecard({ prd, diff });
  sections.allowlist_dead      = await runAllowlistDeadEntry({ prd, diff });
  sections.trap_door_coverage  = await runTrapDoorCoverage({ diff });
  sections.diff_hygiene        = await runDiffHygiene({ diff });
  sections.divergence_reconciliation = await runDivergenceReconciliation({ prd, diff });
  sections.rule_set_invariants = await runRuleSetInvariants({ diff });
  sections.ac_shape            = await runAcShapeAudit({ prd, diff });
  sections.cross_phase         = await loadCrossPhase({ session });

  // Project-shape-conditional
  sections.endpoint_contract = shape.hasNestJSControllers
    ? await runEndpointContract({ prd, diff })
    : { skipped: true, reason: 'project_shape_mismatch', detail: 'no @Controller decorators in diff' };

  sections.frontend_prop_drift = shape.hasReactJSX
    ? await runFrontendPropDrift({ diff })
    : { skipped: true, reason: 'project_shape_mismatch', detail: 'no .tsx files in diff' };

  sections.state_transitions = prd.transitions.length > 0
    ? await runStateTransitionAudit({ prd, diff })
    : { skipped: true, reason: 'no_state_machine_in_prd' };

  sections.sibling_auth_preconditions = shape.hasNestJSControllers
    ? await runSiblingAuthAudit({ diff })
    : { skipped: true, reason: 'project_shape_mismatch', detail: 'no @Controller decorators' };

  return { schema: '1.0', sections, findings: aggregateFindings(sections), summary: ranker(sections) };
}
```

---

## Out of scope

- LLM-assisted entity extraction (T11.5 in `prds/citadel.md`) — separate optional follow-up.
- Pattern-replay fan-out (T10.7) — already partial; this PRD only patches the entry section, not the replay logic.
- Audit-runner refactor for streaming sections — current eager all-at-once invocation is acceptable.
- `/citadel` slash command UX changes — out of scope; this is a runtime-wiring + parser-coverage fix.

---

## Cross-references

- Design PRD: `prds/citadel.md` (T1..T17 + cross-skill T20-T23).
- Triggering session: `2026-05-09-7ff82595` running `prds/archive/bundles/p1-bug-fix-bundle-2026-05-08-mega.md`.
- LOA-618 post-mortem grid: `prds/citadel.md:464` — the 8 issues citadel was built to catch; the analyzers exist for 6 of them but only 2 are reaching the live report.
- Test corpus that confirms the analyzers were built (just not wired): `extension/tests/citadel-ac-coverage-scorecard.test.js`, `extension/tests/citadel-allowlist-dead-entry-detector.test.js`, `extension/tests/citadel-endpoint-contract-conformance.test.js`, `extension/tests/citadel-state-transition-audit.test.js`, `extension/tests/citadel-rule-set-invariant-audit.test.js`.

---

## How to ship

1. **Standalone ticket** (recommended): single-file or two-file change in `audit-runner.ts` + new `project-shape.ts` + (optional) new `trap-door-coverage.ts` if R-CCNW-1 confirms T6 absent. Worker time: 2-4h.
2. **Bundle** (alternative): fold into the next P2 quality bundle alongside other open citadel/anatomy-park polish work.

Either path: regression test (R-CCNW-7) MUST be in the same commit as the wiring fix. Trap-door (R-CCNW-8) MUST be in the same commit. The diagnostic script (R-CCNW-1) can ship in a preceding commit since it's purely additive and informs the wiring changes.

---

## Forensic appendix — section-by-section delta for session `2026-05-09-7ff82595`

```
Live report               Should have fired (per prds/citadel.md spec)
───────────────────────── ────────────────────────────────────────
sibling_auth_preconditions  T9  — present, 0 controllers (project shape; emit skipped-reason)
frontend_prop_drift         T10 — present, 0 components (project shape; emit skipped-reason)
ac_shape                    T11.7 — present, 0 findings (correct echo, but useless without T3 upstream)
rule_set_invariants         T10.8 — present, 0 declarations (RC-6 trap-door triples not recognized)
diff_hygiene                T10.9 — present, 31 files scanned (working)
divergence_reconciliation   T11 — present, 16 tests scanned (working)
cross_phase                 T10.7 — present, 1 LOW (sequencing artifact)
                            T3  — MISSING (ac-coverage-scorecard.ts exists, not invoked)
                            T4  — MISSING (allowlist-dead-entry-detector.ts exists, not invoked)
                            T5  — MISSING (endpoint-contract-conformance.ts exists, not invoked)
                            T6  — MISSING (analyzer module may not exist)
                            T7  — MISSING (no module file)
                            T8  — MISSING (state-transition-audit.ts exists, not invoked)
                            T10.5 — MISSING (no module file)
```

7 of 14 spec'd analyzer surfaces are in the report. 4 modules exist on disk but don't reach the report. 3 spec'd analyzers may not have shipped at all.

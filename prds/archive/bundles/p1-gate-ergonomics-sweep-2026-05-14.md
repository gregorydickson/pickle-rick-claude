---
title: P1 — Gate-Ergonomics Sweep (R-FRA + R-QGSK + R-PPPG) for codex pipelines
status: Open
filed: 2026-05-14
revised: 2026-05-14 PM — incorporated 3-analyst refinement findings (see refinement_summary.md in session 2026-05-14-447493b0)
priority: P1
type: bug-bundle
composes:
  - prds/archive/bug-reports/p2-forward-ref-annotation-readiness-vs-audit-bundle-drift.md   # R-FRA — annotation parity (downgraded P2; ships ONLY if R-FRA-0 diagnoses real drift)
  - prds/archive/bundles/p3-collapse-quality-gate-skip-flags.md                          # R-QGSK — skip-flag consolidation + 6-surface schema/test coordination (P3 → effective P2)
  - prds/archive/bundles/pickle-pipeline-preflight-gates-ergonomics.md                   # R-PPPG — scope-resolver base-ref + source_prd absolute-path + cross-doc-naming-drift severity (P1)
---

# PRD: Gate-Ergonomics Sweep (R-FRA + R-QGSK + R-PPPG)

**Status**: Open, P1, filed 2026-05-14 PM. Phase 1b of the post-b54f2143 master plan. **Operator-override deviation from operator rule #1** (`prds/MASTER_PLAN.md:178` "One PRD per bundle — UNTIL R-MBSR ships"): shared file surface across the three child PRDs makes sequential ship a three-way rebase merge dance, and the children's fixes co-occur in the same gate-chain plumbing.

## Operator-override deviation (required acknowledgement)

This bundle composes 3 child PRDs into one refinement pass. Per master plan operator rule #1, this requires:

1. **Explicit operator sign-off** in this PRD's `## Stakeholders` block before launch.
2. **Hard ceiling of 8 refined tickets** per operator rule #2. If refinement produces 9+ tickets, the bundle MUST be split before pickle phase enters.
3. **Per-ticket independence**: each refined ticket MUST ship a self-contained commit and self-contained regression test so the bundle can partial-ship on collapse.

## Why these three together

Every codex pipeline launch currently pays a stack of pre-flight gate failures that force operators to set BOTH `state.flags.skip_readiness_reason` AND `state.flags.skip_ticket_audit_reason` before pickle phase will enter. The three child PRDs share gate-chain plumbing — but the bundle's *real* surface is wider than the original PRD claimed (R-QGSK alone touches 6 schema/test/code surfaces per the R-PDD-oneOf trap door).

| Surface | R-FRA-0 (diag) | R-FRA-1 (cond. fix) | R-QGSK | R-PPPG |
|---|---|---|---|---|
| `extension/src/bin/check-readiness.ts` | ✓ (audit only) | ✓ (predicate import) | ✓ (skip-flag reader) | — |
| `extension/src/bin/audit-ticket-bundle.ts` | ✓ (audit only) | ✓ (predicate import) | ✓ (skip-flag reader) | ✓ (severity demotion line 540) |
| `extension/src/services/scope-resolver.ts` | — | — | — | ✓ (base-ref `:578-582`) |
| `extension/src/services/state-manager.ts` | — | — | ✓ (migration + bootstrap-exemption schema) | — |
| `extension/src/bin/spawn-refinement-team.ts` | — | — | ✓ (ACTIVITY_EVENT_SCHEMA_SECTION) | ✓ (source_prd repo-root normalize `:1301-1322`) |
| `extension/src/types/activity-events.schema.json` | — | — | ✓ (definitions[] + oneOf[]) | — |
| `extension/src/bin/mux-runner.ts` | — | — | ✓ (bootstrap-mode emitter `:3475-3498`) | — |

## Compositional contract

This master PRD lifts ACs from the three child PRDs via citadel's `composes:` walker (`extension/src/services/citadel/prd-parser.ts:507-555`, verified shipped per R-CCNW closure audit). Expected lifted entity count: ≥3 R-codes plus all child ACs.

**Bundle ticket cap**: ≤8 refined tickets total. Tight collapse expected (each AC-GES-* maps to one ticket where possible).

## Acceptance Criteria — bundle-level

### AC-GES-00 (R-FRA-0 diagnose-first — MUST precede AC-GES-01)

HEAD audit at 2026-05-14 PM produces `extension/tests/fixtures/forward-ref-drift-evidence/prd.md` containing the exact annotation text + verbatim JSON output from both `check-readiness.js` and `audit-ticket-bundle.js` on each of the canonical forward-ref shapes:

- Path token with `(forward-created)`
- Path token with `(created|introduced) by ticket <8-char-hash>`
- Path token with `(created by R-<CODE>-N)` (symbol-only form — MUST be REJECTED for path tokens per R-RTRC-7 trap-door enforcement)
- Symbol token with each of the three forms

**Decision gate**:
- If R-FRA-0 reproduces NO drift between `check-readiness.ts:99` (`FORWARD_REF_ANNOTATION_RE` filtered to 2 path forms per `extractContractReferences`) and `audit-ticket-bundle.ts:325-331` (`hasForwardRefPathAnnotation`, 2 forms) and `spawn-refinement-team.ts:414-415` (`PATH_FORWARD_REF_ANNOTATION_RE`, 2 forms) → R-FRA-1 **drops from bundle** (no-op extract); R-FRA closes via verify-then-close in this same bundle's PRD revision.
- If R-FRA-0 DOES reproduce drift → R-FRA-1 ships with a path-vs-symbol-aware predicate signature (see AC-GES-01).

**Verify**: `node --test extension/tests/forward-ref-drift-evidence.test.js`.

### AC-GES-01 (path-vs-symbol-aware predicate — conditional on AC-GES-00)

IF AC-GES-00 confirms drift, then `isForwardReferenceAnnotation(text: string, token: string, opts: { kind: 'path' | 'symbol' }): boolean` is extracted into `extension/src/services/forward-ref-annotation.ts`. The `kind` parameter is mandatory:

- `kind: 'path'` → accepts `(forward-created)` + `(created|introduced) by ticket <hash>` (R-RTRC-7 path-acceptance set)
- `kind: 'symbol'` → accepts the path set PLUS `(created by R-<CODE>-N)` (R-SAOV-7 affordance)

Both `check-readiness.ts` and `audit-ticket-bundle.ts` import the predicate. Regex constants stay co-located at their original sites to preserve R-RTRC-7 grep-ability. Scope is `check-readiness.ts` + `audit-ticket-bundle.ts` ONLY; `spawn-refinement-team.ts` predicates stay independent (R-RTRC-7 + R-SAOV-7 trap doors enforce this).

**Verify**: `extension/tests/audit-ticket-bundle.test.js`, `extension/tests/check-readiness-forward-ref-annotation.test.js`, and `extension/tests/spawn-refinement-team-symbol-audit-annotations.test.js` all pass post-ship.

### AC-GES-02 (scope-resolver `@{upstream}` self-fallthrough)

`resolveDefaultBase` at `extension/src/services/scope-resolver.ts:578-582` detects the case where `git rev-parse --abbrev-ref @{upstream}` returns `"origin/" + <HEAD-branch-name>` (same-name remote of current branch) and falls through to:

1. `git symbolic-ref --short refs/remotes/origin/HEAD` (preferred)
2. `'origin/main'` (fallback — NEVER bare `'main'`)

Otherwise honors `@{upstream}` as today. Covers both `scope=branch` and `scope=diff` (no explicit base) via shared `resolveAllowedFromDiffMode` at `scope-resolver.ts:194-196`. Non-test callers in scope: `extension/src/bin/pipeline-runner.ts:813,:1772`, `extension/src/bin/lock-scope.ts:134`.

**Verify**: `node --test extension/tests/scope-resolver-branch-base.test.js` — 2 fixtures: (a) fresh clone with no local main, feature branch 110 commits ahead of origin/main; (b) stacked-branch with `@{upstream}` as sibling feature branch.

### AC-GES-03 (cross-doc-naming-drift severity demotion)

`cross-doc-naming-drift` defect severity demoted from `warning` to `info` at `extension/src/bin/audit-ticket-bundle.ts:540`. Severity-threshold exit-1 logic at `audit-ticket-bundle.ts:653` UNCHANGED — `self-reference` (line 384), `wrong-HEAD-assumptions` (line 438), and `cross-doc-naming` warning-variant (line 466) continue to exit non-zero.

**Verify**: `extension/tests/audit-ticket-bundle-severity-threshold.test.js` — fixture exercises one ticket per warning-class finding plus one `cross-doc-naming-drift`; asserts exit 0 with `cross-doc-naming-drift` at `info` AND exit 1 with each warning-class finding.

### AC-GES-04 (source_prd repo-root-relative normalization)

`enrichManifestTicketsFromSourcePrds` at `extension/src/bin/spawn-refinement-team.ts:1301-1322` normalizes each resolved peer PRD path to repo-root-relative BEFORE writing to `ticket.source_prd` at line 1317. The `process.cwd()` fallback at line 1271 is REMOVED (resolution against `path.dirname(parentPrdPath)` is sufficient and cwd-independent).

Normalization rules:
- Absolute paths under repo root → relativize against `repoRoot`
- Paths that cannot be resolved under `repoRoot` → emit stderr warning, write basename only

**Verify**: `extension/tests/refinement-source-prd-relative.test.js` — runs `enrichManifestTicketsFromSourcePrds` from 3 cwds (`repoRoot`, `extension/`, `/tmp`) against a fixture parent PRD whose `composes:` mixes `/absolute/path.md`, `./relative.md`, and `prds/foo.md`; asserts every resulting `source_prd` is byte-identical across all three cwd runs AND repo-root-relative.

### AC-GES-05 (R-QGSK 6-surface migration — atomic)

R-QGSK's `state.flags` consolidation updates the following surfaces in ONE ticket (atomically):

a. `state-manager.ts::migrateState` — additive consolidated field `skip_quality_gates_reason`; legacy `skip_readiness_reason` and `skip_ticket_audit_reason` fields stay READABLE for one minor-version release (deprecation window).
b. `mux-runner.ts:3475-3498` bootstrap-mode emitter — emit consolidated field OR dual-write to legacy fields during deprecation window.
c. `extension/src/types/activity-events.schema.json:141-152` — `bundle_bootstrap_exemption_applied` payload schema updated to reflect consolidated field name OR retain dual-write.
d. Any NEW event introduced by R-QGSK is added to BOTH `activity-events.schema.json:definitions[]` AND `:oneOf[]` per R-PDD-oneOf trap door.
e. Registered in `extension/src/types/index.ts:VALID_ACTIVITY_EVENTS`.
f. Per-event conformance test at `extension/tests/<event>-schema-conformance.test.js`, EVENT_CASES row in `extension/tests/activity-event-payload.test.js`, and entry in `extension/src/bin/spawn-refinement-team.ts:ACTIVITY_EVENT_SCHEMA_SECTION`.

Legacy-field REMOVAL is a SEPARATE follow-up PRD gated on telemetry showing zero legacy reads in 30 days. Not in this bundle's scope.

**Verify**: `extension/tests/state-manager-skip-flag-migration.test.js` (5 fixtures: legacy-readiness-only, legacy-ticket-audit-only, both-legacy, consolidated-only, both-legacy-AND-consolidated) + `extension/tests/bundle-bootstrap-exemption-schema-conformance.test.js` + existing `extension/tests/activity-event-payload.test.js`.

### AC-GES-06 (four-value discriminator activity events)

Activity-event log in `state.json` records each gate-skip with payload `{ event: "<readiness_skipped|ticket_audit_bypassed>", source_flag: "<legacy_readiness|legacy_ticket_audit|consolidated|bootstrap_exemption>", reason: "<string>" }`. On clean-pass (AC-GES-07 below), emit `gate_chain_clean_pass` with payload `{ gates: ["readiness","ticket_audit"], flags: {} }`.

**Verify**: `extension/tests/integration/gate-skip-activity-events.test.js` — fires fixtures for each of the four `source_flag` values plus the clean-pass case.

### AC-GES-07 (in-CI keystone test — fixture-driven, not "next bundle")

A composing-bundle fixture under `extension/tests/fixtures/gate-ergonomics-keystone/` exercises both gates against a properly-annotated 3-child-PRD bundle. Test asserts: readiness exits 0, ticket-audit exits 0, NO `state.flags.skip_*` set, `gate_chain_clean_pass` emitted, AND combined wall time under `pickle_settings.readiness_max_wall_ms` (default 60_000ms).

This REPLACES the original "operational — next bundle after this ships" verification (which was circular).

**Verify**: `extension/tests/integration/gate-ergonomics-keystone.test.js`.

### AC-GES-08 (wall-budget escape hatch)

If post-fix readiness contract resolution against the AC-GES-02 fixture (110-commit branch) exceeds 30 seconds wall time, one of:

a. `DEFAULT_MAX_WALL_MS` at `extension/src/bin/check-readiness.ts:85` raised from `60_000` to `120_000`, OR
b. Existing `--max-wall-ms` CLI arg sourced from `pickle_settings.readiness_max_wall_ms` in `mux-runner.runMuxReadinessGate` so operators can tune persistently.

**Verify**: timing assertion in the AC-GES-02 fixture test.

## Disposition Table

| Child requirement | Disposition | Mapped to | Reason |
|---|---|---|---|
| R-FRA AC-1 (shared predicate) | CONDITIONAL | AC-GES-00 + AC-GES-01 | Drops if R-FRA-0 finds no drift |
| R-FRA AC-3 (lint-grade SoT) | KEEP | (folded into AC-GES-01) | Same-surface, same ticket |
| R-FRA AC-4 (`prds/CLAUDE.md` doc) | REMAP | `extension/CLAUDE.md` R-RTRC-7 section | Documentation lands where the trap-door already lives |
| R-QGSK AC-1..4 | KEEP | AC-GES-05 | Three-surface → six-surface expansion per R-PDD-oneOf |
| R-PPPG AC-1..2 (source_prd) | KEEP | AC-GES-04 | Narrowed to `:1301-1322` site |
| R-PPPG AC-3.a (scope-resolver) | KEEP | AC-GES-02 | Narrowed to `:578-582` `@{upstream}` fallthrough |
| R-PPPG AC-3.c (wall-budget) | KEEP | AC-GES-08 | Escape hatch only |
| R-PPPG AC-4.a (severity demotion) | KEEP | AC-GES-03 | Option (b), not option (a) |
| R-PPPG AC-5 (skill prompts) | DEFER | follow-up PRD | Skill-prompt territory, separate from gate-chain |
| R-PPPG AC-6 (activity-event CI test) | KEEP | AC-GES-06 + AC-GES-07 | Combined under keystone fixture |
| Bundle scope-deviation from operator rule #1 | OPERATOR_OVERRIDE | Stakeholder sign-off (see below) | Documented explicitly |

## Critical User Journey

**Actor**: codex-pipeline operator
**Pre-conditions**: clean working tree on feature branch, properly-annotated bundle PRD in `prds/`, no prior `state.json` for this session.

1. Operator runs `pickle --backend codex prds/my-bundle.md`.
2. Setup writes initial `state.json`; no skip flags set; activity log empty.
3. `check-readiness` runs: parses bundle's `composes:` chain (depth ≤8, cycle-detected); validates path tokens against 2-form set; validates symbol tokens against 3-form set; exits 0.
4. `audit-ticket-bundle` runs: delegates path-annotation parsing to shared `isForwardReferenceAnnotation(text, token, { kind: 'path' })`; resolves `source_prd:` as repo-root-relative; `cross-doc-naming-drift` findings at `info` (skipped by exit-1 gate); exits 0.
5. `scope-resolver (scope=branch)` runs: `@{upstream}` resolves to `origin/my-feature-branch`; self-fallthrough triggers; falls through to `origin/HEAD` (preferred) or `origin/main`.
6. `mux-runner` emits `gate_chain_clean_pass` activity event.
7. Pickle phase enters; refinement team proceeds.
8. Operator never touches `state.flags.*`.

## Verification — bundle summary

| AC | Test |
|---|---|
| AC-GES-00 | `extension/tests/forward-ref-drift-evidence.test.js` |
| AC-GES-01 | `extension/tests/audit-ticket-bundle.test.js` + `extension/tests/check-readiness-forward-ref-annotation.test.js` + `extension/tests/spawn-refinement-team-symbol-audit-annotations.test.js` |
| AC-GES-02 | `extension/tests/scope-resolver-branch-base.test.js` |
| AC-GES-03 | `extension/tests/audit-ticket-bundle-severity-threshold.test.js` |
| AC-GES-04 | `extension/tests/refinement-source-prd-relative.test.js` |
| AC-GES-05 | `extension/tests/state-manager-skip-flag-migration.test.js` + `extension/tests/bundle-bootstrap-exemption-schema-conformance.test.js` + `extension/tests/activity-event-payload.test.js` |
| AC-GES-06 | `extension/tests/integration/gate-skip-activity-events.test.js` |
| AC-GES-07 | `extension/tests/integration/gate-ergonomics-keystone.test.js` |
| AC-GES-08 | (timing assertion folded into AC-GES-02 fixture) |

## Backend

`--backend codex` per operator token budget. Expected codex strike tax: 2-3 strikes × ~80 min operator heal (mux-runner guardrail prevents data loss; R-CCPL diagnosis runs in parallel as Phase 1a).

## Coupling with other queue items

- **R-CCPL** (DIAGNOSIS-ONLY): orthogonal. Runs in parallel as no-pipeline forensic.
- **R-CCDC** (DIAGNOSE-THEN-FIX): orthogonal. Stage 1 forensic runs in parallel.
- **R-MBSR**: orthogonal. This bundle ships on existing flat-manifest refinement; success here is one input to R-MBSR's blast-radius decision.

## Stakeholders

- **Author**: Gregory Dickson (Pickle Rick)
- **Operator-override sign-off (operator rule #1 deviation, ≤8 ticket cap accepted, per-ticket independence required)**: Gregory Dickson — 2026-05-14 PM
- **Implementer**: refinement team + ≤8 workers via mux-runner on codex backend
- **Reviewers**: any operator who has set both skip flags on a codex launch

## References

- `prds/MASTER_PLAN.md` Phase 1b — this bundle is the queued NEXT pipeline
- Child PRDs in `composes:` frontmatter above
- Refinement team's cycle-3 analyses: `~/.local/share/pickle-rick/sessions/2026-05-14-447493b0/refinement/analysis_{requirements,codebase,risk-scope}.md`
- R-RTRC-7 / R-SAOV-7 trap doors in `extension/CLAUDE.md` — path-vs-symbol asymmetry enforcement
- R-PDD-oneOf trap door — 6-surface schema coordination requirement
- b54f2143 session — R-FRA + R-QGSK operator-friction evidence
- 2026-05-14-9d491b00 session — R-PPPG three-failure-mode evidence

# Bug: bundle validators cannot see forward-created citations (readiness gate + refinement symbol auditor)

**Filed**: 2026-06-10 (babysitter intervention, session 2026-06-10-f50e5c11, v2.0.0-beta.1 bundle launch)
**Severity**: P2 — blocks creation-heavy bundle launches and refinement runs until worked around per-incident
**Status**: Open
**Scope**: TWO validators share one root pathology — annotation-blind symbol/path resolution in surfaces the shared R-FRA-6 module (`extension/src/services/forward-ref-annotation.ts`) does not cover — plus parser defects unique to each. Per `prds/CLAUDE.md`, R-RTRC-2 documents that annotated paths ARE suppressed from `path_not_verified`; every incident below is therefore a defect against documented behavior or an uncovered enforcement surface, not missing design.

## Incidents (one session, one bundle, three validator failures)

### Incident A — refinement symbol auditor, run 1 (`spawn-refinement-team.js` exit 2, 25 phantoms)

- **A1 — forward-created activity events flagged PHANTOM.** All 11 net-new events the bundle registers (`codegraph_index_built`, `worker_silent_death`, `failed_flip_suppressed`, …) flagged "not present in VALID_ACTIVITY_EVENTS". They cannot be present — the bundle creates them. The activity-event checker has no annotation escape on unannotated first contact; adding `(forward-created)` per the R-RTRC-7 grammar cured these (see B1 for where the cure itself failed).
- **A2 — non-symbol backticked tokens misclassified as activity events.** Backticked words co-located on lines mentioning events were registry-checked: `ok`, `status`, `allowed_paths`, `gate_payload`, and `codegraph` (a settings-block name) all flagged "not present in VALID_ACTIVITY_EVENTS". The classifier keys on line context, not on whether the token is cited AS an event.
- **A3 — exit-code checker keys on the literal phrase "exit code".** Any backticked token on a line containing "exit code" was checked against `PipelineRunnerExitCode`: function names (`getImpactRadius`), type names (`ImpactAnalysisPayload`), and field names (`allowed_paths`, `dependencies`, `status`) all flagged FAIL. Only rewording ("blocking behavior unchanged") removed them.
- **A4 — `path_not_verified` noise (19 warnings).** Non-paths treated as repo paths: `releases/latest` (gh URL segment), `init/indexAll/sync/searchNodes/getCallers/getImpactRadius/buildContext/close` (slash-joined method list), `extension/node_modules`, plus directories the PRD was *proposing* (`tests/expensive/`). Warnings only, but they pollute `refinement_manifest.json#ticket_quality_warnings`.

### Incident B — refinement symbol auditor, run 2 (exit 2, 5 residual phantoms)

- **B1 — annotation parser chokes when the annotation abuts a closing parenthesis.** `(forward-created))` — the annotated symbol being the last item of a parenthesized list — fails to parse and the symbol stays PHANTOM. List-interior items parsed with a trailing-comma artifact (audit detail column showed `"(forward-created),"`); list-final items failed outright. This violates the R-RTRC-7 grammar's intent (annotation outside backticks, one ASCII space — both satisfied). Workaround: restructure prose into em-dash lists so no annotation abuts `)`.
- **B2 — exit-code checker honors no annotation at all.** `getImpactRadius` (forward-created, annotated) and `ImpactAnalysisPayload` (annotated) remained FAIL — the exit-code path combines A3's context-keying with zero annotation support. Workaround: strip the phrase "exit code" from those lines entirely.

Run 3 went green only after a standalone dry-run of `writeSymbolAudit` + `runSymbolAuditEnforcement` against the patched PRD (ENFORCEMENT_STATUS=0) — that pre-spawn dry-run should arguably be part of the skill flow.

### Incident C — `check-readiness` at pipeline launch (exit 2, 30 findings, READINESS HALT, pipeline dead in 16s)

- **C1 — file_path resolver blind inside command strings and tables (23 findings).** Forward-created test files cited inside AC verify-command strings (`` `node --test tests/check-update-prerelease.test.js` ``) and inside Test Expectations table cells flagged "Referenced ticket file path does not resolve". The R-RTRC-7 annotation cannot be expressed inside a command string, and the resolver does not fall back to: (a) the same ticket's annotated prose citation of the same path, (b) the ticket's own "Files to modify/create" declaration, or (c) sibling tickets' declarations — e.g. `fdd9e119` was flagged for `tests/silent-death-recovery.test.js` even though it carries the Form-2 annotation `(created by ticket 90574654)` and ticket `90574654` declares the file.
- **C2 — contract resolver blind to annotations (7 findings).** Bundle-introduced API symbols (`CodeGraph.init`, `indexAll()`, `CodegraphService.create`, `getSessionCounters()`, `PickleSettings.codegraph`, `codegraph.enabled`) flagged "Referenced contract does not resolve" despite forward-reference annotations on their defining citations. `extractContractReferences` (R-RTRC-2 site) evidently suppresses annotated PATHS but not annotated SYMBOLS/contracts.

## Recoveries applied

- **A/B**: PRD annotated + reworded around the parsers. Cost: two full analyst-team re-runs (~40 min wall, 9 worker spawns burned).
- **C**: documented CLAUDE.md Step 0 creation-heavy downgrade — thresholds tripped (25 tickets, 17/25 forward-creating under `extension/tests/`) → `state.flags.skip_quality_gates_reason = "creation-heavy bundle: 25 tickets, 17/25 forward-creating under extension/tests/"` (unified R-QGSK flag per `prds/CLAUDE.md`), session resumed, pipeline relaunched green (manager spawned, ticket 931c492f proceeding).
- **Note on blast radius of the workaround**: the unified skip waives BOTH the readiness gate and the ticket-audit gate for the entire bundle — including the checks that would catch genuinely phantom paths. Every creation-heavy bundle currently pays one dead launch + a manual flag and then runs ungated.

## Fix proposal (machine-checkable)

Extend the EXISTING shared module rather than inventing a new mechanism — `forward-ref-annotation.ts` (R-FRA-6) is already imported by `check-readiness.ts` and `audit-ticket-bundle.ts`; the gaps are coverage and grammar robustness:

1. **Bundle-creation index** (new export in the R-FRA-6 module): build an index from every bundle ticket's "Files to modify/create" sections + annotated citations. Both validators consult it before flagging any `tests/**`, `scripts/**`, `src/**`, or `data/**` path. Declared-or-annotated anywhere in the bundle → not a finding (fixes C1 cross-ticket cases, A1).
2. **Command-string coverage**: a path inside a backticked command string is covered when the same path appears in the bundle-creation index (fixes C1 verify-command cases).
3. **Grammar hardening**: `FORWARD_REF_ANNOTATION_RE` accepts trailing `,` `;` `)` `.` immediately after the annotation's closing paren (fixes B1); add a unit matrix for all three forms × four trailing chars.
4. **Annotation honor in ALL checkers**: apply the grammar in the exit-code checker and the contract resolver (`extractContractReferences` symbol branch), not only the path branch (fixes A3/B2/C2).
5. **Classifier precision**: registry-check a token only when cited AS an event/exit code (`event \`X\``, `emits \`X\``, `exit code \`N\``), not merely co-located on a line containing those words (fixes A2/A3 false positives on `ok`/`status`/`getImpactRadius`).
6. **`path_not_verified` precision**: skip URL segments, slash-joined identifier lists (>2 slashes + no file extension), and `node_modules` (fixes A4).

**Acceptance criteria**:
- Fixture bundle with annotated forward-created files in verify commands, tables, and cross-ticket citations → `check-readiness` zero findings AND symbol audit PASS, no skip flag.
- Control fixture with one genuinely phantom path + one phantom event → BOTH validators still fail, naming exactly those two (the gate keeps its teeth).
- Grammar unit matrix: `(forward-created))`, `(forward-created),`, `(created by ticket ab1234cd).`, `(introduced by ticket ab1234cd);` all parse.
- Regression proof: re-run THIS bundle's 25 tickets through `check-readiness` with the fix and WITHOUT `skip_quality_gates_reason` → zero findings.
- `audit-ticket-forward-refs.sh` (R-FRA-2) green against the fixture bundle.

## Verification of recovery

- `mux-runner.log`: `READINESS HALT` 2026-06-10T20:20:13Z → flag set → relaunch 2026-06-11T01:25:29Z → iterations 2-3 proceeded, manager spawned, 931c492f in research.
- `refinement_manifest.json`: run 3 `all_success: true`, `ac_shape_smells: []`.

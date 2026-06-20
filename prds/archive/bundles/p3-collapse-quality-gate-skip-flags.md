---
title: P3 — Collapse skip_readiness_reason + skip_ticket_audit_reason into a single skip_quality_gates_reason
status: Draft
filed: 2026-05-14
priority: P3
type: bug-process
r_code_prefix: R-QGSK
backend_constraint: any
related:
  - prds/archive/bug-reports/p2-forward-ref-annotation-readiness-vs-audit-bundle-drift.md  # R-FRA — once gate parity is established, the two skip flags become semantically equivalent
---

# P3 — Two skip flags exist where one should suffice

## Symptom

`state.flags.skip_readiness_reason` and `state.flags.skip_ticket_audit_reason` are independent string fields in `state.json`. To bypass BOTH gates for a pre-validated bundle (e.g. one refined by the 3-analyst team), operator must set BOTH flags with effectively the same justification text. Forgetting either flag halts the runner.

Witnessed in pipeline `2026-05-13-b54f2143` (R-TSPF launch):
- Operator set `skip_readiness_reason` after the first halt.
- Pipeline relaunched, immediately hit `TICKET AUDIT HALT`.
- Operator had to set `skip_ticket_audit_reason` separately and relaunch a third time.

## Root cause

`mux-runner.ts` reads `state.flags.skip_readiness_reason` to bypass `check-readiness.js` and reads `state.flags.skip_ticket_audit_reason` separately to bypass `audit-ticket-bundle.js`. The two flags were added independently as each gate landed (R-RDY family for readiness, R-TAQ/R-RTRC family for audit-ticket-bundle). They cover the same operator-justification semantics: "this bundle is pre-validated, bypass automated content checks." There is no use case in which an operator wants to bypass one but not the other — if the refinement team validated the tickets, both gates should be off; if the tickets are sketchy, both gates should be on.

## Functional requirements

- **FR-1**: A single flag `state.flags.skip_quality_gates_reason` (string, non-empty when set) bypasses BOTH `check-readiness.js` AND `audit-ticket-bundle.js` with the same justification.
- **FR-2**: Backwards-compat: if `skip_readiness_reason` is set but `skip_quality_gates_reason` is not, the runner reads `skip_readiness_reason` AND ALSO bypasses audit-ticket-bundle (one-way merge). Same for `skip_ticket_audit_reason`. This keeps in-flight sessions from breaking on the rename.
- **FR-3**: The migration to a unified flag is implemented in `state-manager.ts::migrateState` (alongside other state migrations), so new sessions written after R-QGSK ships only carry the unified flag.
- **FR-4**: Deprecation warning logged when a session carries only one of the two old flags: `"skip_<X>_reason is deprecated; both quality gates will be bypassed. Use skip_quality_gates_reason."`

## Acceptance criteria

- **AC-1**: Setting only `state.flags.skip_quality_gates_reason = "<reason>"` causes BOTH gates to bypass with that reason logged — Verify: launch a bundle with the flag set, both gates log `"<gate name> bypassed via state.flags.skip_quality_gates_reason: <reason>"` — Type: integration
- **AC-2**: A session carrying only the old `skip_readiness_reason` flag still works (back-compat) AND emits the deprecation warning — Verify: launch with old flag, runner bypasses both gates, deprecation warning appears in log — Type: integration
- **AC-3**: Same as AC-2 for `skip_ticket_audit_reason` — Type: integration
- **AC-4**: `state-manager.ts::migrateState` upgrades old-flag-only state.json to unified flag on first write — Verify: synthetic state.json with only `skip_readiness_reason`, run migrator, assert `skip_quality_gates_reason` is set and old flag is removed — Type: test
- **AC-5**: Regression test in `extension/tests/state-manager-skip-flags-migration.test.js` covers AC-1..AC-4.
- **AC-6**: Release gate passes — Verify: `cd extension && npx tsc --noEmit && npm run test:fast` — Type: test

## Out of scope

- Removing the gates themselves.
- Adding a NEW skip flag for any other gate (e.g. citadel doesn't currently support a skip flag and this PRD does not add one).
- Changing the skip-flag *semantics* (still a non-empty string requiring operator justification).

## Why P3

Pure ergonomics — operator types two flags instead of one. Worth shipping as a clean-up bundle but not a pipeline-blocker. Pair opportunistically with any state-manager.ts touch or with R-FRA (which removes the underlying reason to need either flag for most bundles).

## Implementation order

- **R-QGSK-1**: Add `skip_quality_gates_reason` field to `State` type in `extension/src/types/index.ts`.
- **R-QGSK-2**: Update `mux-runner.ts` to check the unified flag first, then fall back to either legacy flag with deprecation warning.
- **R-QGSK-3**: Migration in `state-manager.ts::migrateState`.
- **R-QGSK-4**: Regression test suite.
- **R-QGSK-5**: Docs update (`extension/CLAUDE.md` and `prds/CLAUDE.md` skip-flag section).

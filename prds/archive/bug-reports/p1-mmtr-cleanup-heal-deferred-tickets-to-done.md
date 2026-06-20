---
title: P2 — heal deferred-Skipped R-MMTR-2/3/4 to Done once test-flake root cause R-WMW lands
status: Draft
filed: 2026-05-13
priority: P2
type: cleanup
r_code_prefix: R-MMTRH
backend_constraint: any
related:
  - prds/archive/bug-reports/p1-mux-runner-no-claude-manager-relaunch-on-max-turns.md
  - prds/archive/bug-reports/p1-auto-skip-acceptance-criteria-false-positive-on-committed-tickets.md  # R-ASCH (revised P2) explains why these landed Skipped
---

# P2 — heal deferred-Skipped R-MMTR-2/3/4 to Done after R-WMW fix lands

## Context

Session `2026-05-13-c122b0f7` produced three tickets whose worker code commits landed in git but whose frontmatter status remained `Skipped` per worker contract because the workers self-deferred AC-7 (tests pass) due to an unrelated `auto-resume.stop-conditions > prints [warn] banner past retry 3` flake (filed under R-WMW PRD earlier today):

| Ticket | Commit | DEFERRED reason |
|--------|--------|-----------------|
| d97acb1e (R-MMTR-2) | 42148351 | AC-7 blocked by `extension/tests/microverse.test.js:191` and `mux-runner.output-stall.spec.js:181` flakes |
| f9f3ace5 (R-MMTR-3) | 5c7d089c | `test:integration` red on unrelated branch failures |
| 05c47442 (R-MMTR-4) | 053f6fa6 | `test:fast` fails outside ticket scope in `auto-resume.stop-conditions` |

The downstream consequence: completion dashboards report `1/58 Done` (or `2/58` with R-MMTR-5's trap-door pin) instead of the truer `4-5/58`. The pipeline's `done | skipped` filter treats them equivalently for traversal, so no functional impact — only operator-facing tracking.

## Action

After R-WMW (auto-resume flake) ships and the test suite is reliably green:

1. **Re-run** the per-ticket validation gate (`cd extension && npm run test:fast`) on a clean checkout that includes commits `42148351`, `5c7d089c`, and `053f6fa6` plus the R-WMW fix.
2. **Confirm** each of d97acb1e/f9f3ace5/05c47442's AC checklist would now pass.
3. **Flip** each ticket's frontmatter from `status: "Skipped"` to `status: "Done"` (the `completion_commit:` field is already present and accurate).
4. **Append** `healed_at:` and `healed_reason: "R-MMTRH heal — R-WMW shipped; deferred AC-N now passes; ticket work was correct all along"` to each.
5. **Remove** the `# DEFERRED:` line from each ticket file body since the underlying blocker is resolved.

## Acceptance Criteria

- **AC-1:** R-WMW PRD has shipped (its `completion_commit` field is populated on disk).
- **AC-2:** `cd extension && npm run test:fast` exits 0 with zero failures on the merged main branch.
- **AC-3:** d97acb1e, f9f3ace5, 05c47442 ticket files each have `status: "Done"`, `completion_commit: <preserved>`, `healed_at: <ISO>`, no `# DEFERRED:` line in body.
- **AC-4:** A small integration test `extension/tests/integration/mmtrh-heal-script.test.js` validates that the heal script (R-MMTRH-2 below) idempotently produces the expected frontmatter from a fixture.

## Implementation

- **R-MMTRH-1**: Write `extension/scripts/heal-deferred-tickets.sh` taking a session dir + a list of ticket-id+commit-sha pairs; for each, runs the per-ticket validation gate, and on success flips the frontmatter + removes the DEFERRED line. Idempotent (re-running is a no-op).
- **R-MMTRH-2**: Add a fixture-based integration test.

## Out of Scope

- Auto-running the heal script as part of pipeline finalization (operator-driven only; the dependency on R-WMW completion is asynchronous).
- Backfilling other sessions' deferred-Skipped tickets (manual review per session; not worth a global migration).

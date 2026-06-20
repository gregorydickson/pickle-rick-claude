---
title: P2 — auto-skip rationale field misleadingly reports `acceptance_criteria_not_checked` for worker-deferred tickets
status: Revised (P1 → P2; original scope retracted)
filed: 2026-05-13
revised: 2026-05-13
priority: P2
type: bug
r_code_prefix: R-ASCH
backend_constraint: any
related:
  - prds/archive/bug-reports/p1-mux-runner-no-claude-manager-relaunch-on-max-turns.md  # surfaced this bug during R-MMTR mega bundle session 2026-05-13-c122b0f7
---

# REVISION NOTE (2026-05-13)

The original P1 framing of this PRD was **misdiagnosed**. The claim that `validateAutoTicketCompletion` should auto-`Done` any ticket with a commit-on-HEAD regardless of AC state CONTRADICTS the worker contract documented in `.claude/commands/send-to-morty.md`:

> "If an acceptance criterion contradicts reality (e.g. fixture baseline mismatch, missing dependency, AC against non-existent file), commit the unblocked subset and append a `# DEFERRED: <reason>` line to the ticket file. DO NOT flip `status: Done` for a deferred ticket."

Re-inspection of session `2026-05-13-c122b0f7` shows ALL three observed auto-skipped tickets (d97acb1e, f9f3ace5, 05c47442) carry `# DEFERRED:` lines explaining unrelated branch failures that prevented full AC satisfaction. The runner's auto-skip was correct in all three cases. The manual heal performed at 19:25Z was wrong and has been reverted at 20:15Z. Only `ecebb5d2` (no DEFERRED line, worker flipped `status: Done` per contract) is genuinely `Done`.

Downgraded P1 → P2. The remaining narrow defect is documented below.

---

# P2 — auto-skip rationale misleadingly reports `acceptance_criteria_not_checked` for worker-deferred tickets

## Narrow Defect

When a worker emits `COMPLETION_COMMIT_RECORDED`, writes all 6 phase artifacts, AND appends a `# DEFERRED: <reason>` line, the mux-runner safety net at `extension/src/bin/mux-runner.ts:1182-1206` calls `markTicketSkipped` with `verdict.reason === 'acceptance_criteria_not_checked'`. This is technically true (no checkboxes are ticked) but operationally misleading: the actual cause is the worker's explicit deferral, not a worker oversight.

Symptoms:
- Operator triage of `mux-runner.log` sees `Marked ticket <id> as Skipped (acceptance_criteria_not_checked)` and concludes the worker failed to satisfy AC.
- The DEFERRED reason and the test failures cited within it remain undiscovered without manually opening each ticket file.
- Activity event `ticket_auto_skip_no_evidence` carries `reason: acceptance_criteria_not_checked` instead of `reason: worker_deferred` or `reason: deferred_unrelated_branch_failure`.
- The `# DEFERRED:` lines themselves are valuable forensic signal that gets buried.

## Acceptance Criteria

- **AC-1:** `validateAutoTicketCompletion` parses ticket content for a line matching `/^#\s*DEFERRED:\s*(.+)$/m` AFTER the early `isTerminalTicketStatus` check but BEFORE `hasCheckedAcceptanceCriteria`. When found AND `hasCompletionCommit()` returns non-absent, the function returns `{action: 'skip', reason: 'worker_deferred', deferral_reason: <captured-text>}`.
- **AC-2:** When `applyAutoTicketCompletionValidation` encounters `verdict.reason === 'worker_deferred'`, it logs `Marked ticket <id> as Skipped (worker_deferred: <truncated-reason-180-chars>)` and emits `ticket_auto_skip_no_evidence` with payload `{ reason: 'worker_deferred', deferral_reason: <full-text>, completion_commit: <sha-if-present> }`.
- **AC-3:** The `AutoTicketCompletionValidation` type adds optional fields `deferral_reason?: string` and `completion_commit?: string` to support the richer telemetry.
- **AC-4:** New schema entry in `extension/src/types/activity-events.schema.json` for `ticket_auto_skip_no_evidence` enumerates valid `reason` values: `acceptance_criteria_not_checked` (legacy), `no_commit_referencing_ticket_since_current_set` (legacy), `worker_deferred` (new). When `reason === 'worker_deferred'`, `gate_payload.deferral_reason` is required.
- **AC-5:** Integration test `extension/tests/integration/auto-skip-worker-deferred.test.js` constructs a session with a `Todo` ticket containing `# DEFERRED: <text>` and a real commit; asserts the skip path runs, reason is `worker_deferred`, the activity event carries `deferral_reason`, and stderr shows the truncated reason.
- **AC-6:** Unit test in `extension/tests/mux-runner-validate-auto-ticket-completion.test.js` covers four cases:
  1. DEFERRED + commit + bullet AC → `skip`, reason `worker_deferred`
  2. DEFERRED + no commit → `skip`, reason `worker_deferred` (deferral takes precedence even without commit because worker explicitly declared deferred state)
  3. No DEFERRED + commit + bullet AC → `skip`, reason `acceptance_criteria_not_checked` (legacy behavior preserved — operator decides)
  4. No DEFERRED + commit + all-checked AC → `done`, reason `commit_and_acceptance_checked` (preserved)
- **AC-7:** `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npm run test:fast` pass.

## Trap Door

`src/bin/mux-runner.ts` (R-ASCH-1 deferral-aware skip rationale) — INVARIANT: `validateAutoTicketCompletion` MUST detect `# DEFERRED:` lines in ticket content (regex `/^#\s*DEFERRED:\s*(.+)$/m`) and route them to `{action: 'skip', reason: 'worker_deferred', deferral_reason: <captured>}` BEFORE the legacy `hasCheckedAcceptanceCriteria` check. The activity event `ticket_auto_skip_no_evidence` MUST include `deferral_reason` when reason is `worker_deferred`. BREAKS: operator triage of auto-skipped tickets cannot distinguish "worker self-deferred for known reason" from "worker did not satisfy AC"; deferral context is buried in ticket file body. ENFORCE: extension/tests/integration/auto-skip-worker-deferred.test.js, extension/tests/mux-runner-validate-auto-ticket-completion.test.js. PATTERN_SHAPE: `/\^#\\s\*DEFERRED:/` regex use in `validateAutoTicketCompletion`.

## Retracted Scope (do NOT implement)

The original P1 acceptance criteria (AC-1 through AC-7 in the pre-revision version) proposed to:
- Check `hasCompletionCommit()` BEFORE `hasCheckedAcceptanceCriteria()` and auto-`Done` on commit evidence.
- Treat empty AC sections as ambiguous (return `true`).

Both proposals are **rejected** because they violate the worker contract for `# DEFERRED:` tickets. Auto-`Done`-ing a deferred ticket would incorrectly mark unfinished work as complete and erode the deferral audit trail.

## Out of Scope

- Adding a new `Deferred` ticket status to `TicketStatus` (potentially valuable but invasive — would require updates to status histogram, dashboards, `collectTickets` filter, status emoji table at `pickle-utils.ts:347-353`, and the `done | skipped` filter at `mux-runner.ts:472, 924, 978`. File a separate PRD if operators want this.)
- Backfilling improved skip reasons for historical sessions (one-shot manual review; not worth a migration script).
- Forcing refinement-team to emit `- [ ]` checkboxes (separate PRD — the bullet style is fine because deferral is an explicit contract, not an oversight).

## Verification

Reproduce in session `2026-05-13-c122b0f7`:
```bash
SD=~/.local/share/pickle-rick/sessions/2026-05-13-c122b0f7
for t in d97acb1e f9f3ace5 05c47442; do
  echo "=== $t ==="
  rtk proxy grep -E "^# DEFERRED:" $SD/$t/linear_ticket_*.md
done
# All three carry # DEFERRED: lines citing unrelated branch failures.
# Verifies the auto-skip was correct, only the rationale was misleading.
```

## Lessons (for future bug triage)

1. **Don't heal Skipped tickets without checking for `# DEFERRED:` lines.** The runner's Skipped status may be a faithful echo of the worker's explicit deferral, not a bug.
2. **`status: "Skipped"` is currently overloaded.** It means both "worker didn't even start" AND "worker did the work but contract requires non-Done." Distinguishing these is the operator-experience gap above.
3. **`completion_commit:` + `status: "Skipped"` is a valid composite state** in the current schema — it means "work committed, deferred per contract." Operators reading the dashboard should be taught this.

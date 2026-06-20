# P2 Bug-Fix Bundle — R-WMNP: wmw-auto-skip no-progress loop (source-blind + uncapped + order-deadlock)

**Finding:** #106 R-WMNP (MASTER_PLAN). **Priority:** P2 (autonomy + work-loss-risk; recurrence on an uncovered path of shipped #99 R-WCUC / #100 R-CHTS).
**Source:** Live babysitting incident, session `2026-06-08-ce6ae444` (R-RGED #105 build), ticket `1c1d094c` (T3, new `pattern-conformance-audit.ts`), 2026-06-08.

## Incident

T3 produced a correct new analyzer + two test files + runner wiring in the working tree, `tsc`-compiled clean, but was **two trivial fixes from green** (one `no-useless-assignment` eslint error + one false-positive test: a `(?!EXCLUDED\.)` lookahead defeated by whitespace backtracking). The worker could not close those two gaps across context-cleared respawns. The runtime then:

1. flipped the ticket `Failed/oversized_no_progress` via `wmw-auto-skip` at **5/5** then **6/5** consecutive "zero-progress" spawns (mux-runner.log), and
2. **re-spawned the same ticket within the same pickle phase** (iterations 12→16) rather than advancing or invoking the RecoveryController ladder, with
3. the per-ticket iteration cap **perpetually skipped** (`per-ticket cap-check skipped: stale cache (current_ticket=…, max_iter=undefined, budget_start=undefined, tier=medium)`), so nothing bounded the loop, and
4. on a clean relaunch, `state.current_ticket` still pointed at the flipped ticket → the manager **re-engaged it** (order-deadlock) instead of selecting the next Todo.

Babysitter recovery (this incident): froze the orchestrator, fixed the 2 gaps (`(?!\s*EXCLUDED\.)` + dropped the dead initializer), recompiled, ran the gate green (24/24 T3 tests, tsc + eslint clean), committed T3 (`4f0df46b`), marked the ticket Done, **cleared `current_ticket`** + per-ticket cache via `StateManager.update`, relaunched → advanced to T4.

## Why the shipped fixes don't cover this

- **#99 R-WCUC (v1.101.0)** commits *gate-passing* uncommitted work before failing. T3's work was **gate-failing** (1 lint + 1 test), so R-WCUC correctly did not auto-commit — but the ticket then looped forever instead of being driven to green or bounded.
- **#100 R-CHTS / B-ORSR (v1.102.0)** added the RecoveryController ladder on the `closer_handoff_terminal` trigger. The `wmw-auto-skip` no-progress trigger is a **distinct path** that flips Failed + respawns inside the pickle phase and **never reaches the ladder**.

## Acceptance Criteria (machine-checkable)

- [ ] **AC-R-WMNP-1 — no-progress signal counts source-tree deltas, not only artifact files.** The per-spawn progress measurement (`worker_artifact_progress`) MUST treat a change in working-tree source files (git `status`/`diff` line delta vs the prior spawn snapshot) as progress, not only a change in lifecycle artifact count (`research_*.md`/`plan_*.md`/`*_review.md`). A scripted worker that creates or grows a source file each spawn while writing no new artifacts MUST NOT accrue `zero_progress_count`. — Type: test (`extension/tests/...wmnp-source-progress...test.js`, forward-created)
- [ ] **AC-R-WMNP-2 — a set `current_ticket` always has an enforced per-ticket cap.** When `state.current_ticket` is set but `current_ticket_max_iterations` is absent/non-positive, the R-CNAR-1 iteration_start self-heal MUST **repopulate** the per-ticket cache from the ticket tier (not merely clear-on-null), so the per-ticket cap-check is never perpetually skipped. After an iteration_start with `current_ticket` set + cache undefined, `current_ticket_max_iterations` is a positive integer. — Type: test
- [ ] **AC-R-WMNP-3 — a terminal no-progress flip clears `current_ticket` (no relaunch order-deadlock).** When the no-progress path writes a ticket `Failed`, it MUST clear `state.current_ticket` (+ per-ticket cache) OR ticket-selection MUST skip a `current_ticket` that is already `Done`/`Failed`. After a no-progress Failed flip + relaunch, the manager selects the next Todo ticket, never the flipped one. — Type: test
- [ ] **AC-R-WMNP-4 — the wmw-auto-skip terminal path routes through the RecoveryController ladder.** Before a bare respawn loop, a no-progress ticket with a near-green diff MUST be offered the same ladder as `closer_handoff_terminal` (fix-forward-trivial / execute-converged-plan / auto-split / escalate→`recovery_exhausted`), not respawned indefinitely. — Type: test
- [ ] **AC-R-WMNP-5 — typecheck + lint clean.** `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1`. — Type: typecheck

## Out of Scope

Citadel/review-efficacy (that is #105 R-RGED). The codex no-progress authority seam (#104, shipped v1.103.0) — this finding is the claude/worker pickle-phase no-progress path.

## Notes

Bundle owner: a future drain-queue row. Schema-neutral expectations (no new state schema; `worker_artifact_progress` already exists). MINOR version. Relates to memory `feedback_pickle_rick_autonomy_north_star` and `feedback_commit_uncommitted_verified_work_before_respawn`.

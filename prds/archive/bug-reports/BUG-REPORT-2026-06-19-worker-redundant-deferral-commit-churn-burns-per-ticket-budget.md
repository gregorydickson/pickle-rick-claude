# Worker emits ~12 redundant `record deferred conformance` no-op commits on one ticket → burns per-ticket iteration budget → pickle phase caps out before remaining tickets run

**Status**: Draft (P3, capture-only) — captured by babysitter during a live `/pickle-pipeline --backend codex` run. NOT dispatched.

**Severity**: P3 — efficiency/ergonomic defect (no data loss; completed work preserved), but it materially shortened a run: a single ticket's deferral-churn consumed the per-ticket budget (60) and tripped the mux iteration cap (exit code 3) **before** the last 6 tickets (W4 + wiring + 4 hardening) got a turn, so the pipeline never reached citadel.

**Class**: D1/D2 adjacent — commit-and-continue recovery (R-ORSR-2) with no idempotent-defer guard; relates to #124 R-DPMC-3 (unsatisfiable-ticket fast-fail, DEFERRED) and the verification-deferral pattern.

## Symptom

`git log` on the run's branch shows a single ticket (`26cd29db`, W3b reprocess) producing a long run of near-identical deferral commits — **9 of them confirmed EMPTY** (commit tree SHA == parent tree SHA, i.e. `git commit --allow-empty` with zero file change; verified by tree comparison). Only 2 commits in the ticket's run were real work (`f17a2ff5d` reprocess flow +21/-3; `7835fefa3` commit-and-continue recovery +127); the rest are no-ops:

```
d271d7f23 chore(26cd29db): record deferred verification handoff
58d228162 chore(26cd29db): record deferred conformance state
e5f913780 chore(26cd29db): record deferred conformance handoff
961693cbd chore(26cd29db): record deferred conformance
c6184fc6e 26cd29db defer blocked reprocess verification
92ee47ff7 chore(26cd29db): record conformance follow-up
70703daed 26cd29db: record deferred conformance
a72d0e227 chore(26cd29db): record deferred conformance
b3489d46a chore(26cd29db): record deferred conformance status
...  (~12 total)
```

Then:
```
mux-runner exiting with code 3: per-ticket budget (60)
Max iterations reached (60/60). Exiting.
Phase pickle exited with code 3
Phase pickle hit iteration cap; 7/14 tickets remain unfinished.
```

## Reproduction (observed)

- Session `2026-06-19-2b1e2707` (LOA-1387 bank-statement resilience, `/pickle-pipeline --backend codex`, 14 tickets).
- Ticket `26cd29db` had two ACs unsatisfiable **from the worker's allowed file set**:
  1. `pnpm test:e2e --testPathPattern=bank-statement` → "No tests found" (the referenced `test/bank-statement.e2e-spec.ts` does not exist in the checkout; it was a forward-created target the worker did not create).
  2. `pnpm run typecheck` fails on **pre-existing** unrelated baseline errors (`src/classify-split`, `src/events`, `src/property-data`) outside ticket scope.
- The worker correctly recognized it could not green these and invoked commit-and-continue ("record deferred conformance"), but did so **repeatedly (~12×)** rather than once, each iteration re-deferring and re-committing, until the per-ticket budget (60) tripped the global cap.

## Root cause (hypothesis)

The R-ORSR-2 commit-and-continue recovery has **no idempotent-defer guard**: when a ticket's remaining AC is unsatisfiable from the allowed file set, each manager iteration re-runs the same blocked verification, re-records the same deferral, and commits again — a fixpoint that never converges to terminal within budget. Combined with two upstream triggers: (a) a forward-created verify target the worker treats as "absent → defer" instead of "create", and (b) repo-wide `typecheck` failing on pre-existing out-of-scope errors.

## Workaround (this incident)

Relaunched the pipeline; completed tickets are preserved (Done with committed work), so the relaunch resumes at the next Todo ticket with a fresh per-ticket budget.

## Proposed direction (capture-only)

- **AC-1 (idempotent defer):** once a ticket records a deferred-conformance entry for a specific unsatisfiable AC, the same AC must not trigger another commit on subsequent iterations — defer once, mark the ticket terminal (Done-with-deferral), move on. No N-commit churn.
- **AC-2 (scope-aware verify):** a `Verify` command that fails ONLY due to out-of-scope/pre-existing errors (e.g. typecheck errors in files the ticket cannot touch) should be classified as "blocked-out-of-scope" (defer once) rather than re-attempted every iteration.
- **AC-3 (forward-created verify targets):** when a ticket's `Verify` references a test file that does not exist and is not marked forward-created, surface it at readiness (decomposition-time), not as runtime defer-churn. (Authoring-side: refiner should require forward-created annotation on verify-target spec files too.)

## Cross-references

- **#124 R-DPMC-3** — unsatisfiable-ticket fast-fail (DEFERRED); same "fail-one not stall-all" principle, here for verification-defer rather than scope-fence.
- **#126 R-CCEM** — sibling codex completion-evidence defect from the same session.
- R-ORSR-2 — commit-and-continue recovery (the seam that needs the idempotent-defer guard).

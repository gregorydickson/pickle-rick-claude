# BUG-REPORT 2026-06-28 — R-MVFM: microverse failure-memory records only regressions, never plateaus → denylist is dead on the dominant stall

**Code:** R-MVFM (MicroVerse Failure Memory)
**Priority:** P3 — efficacy/correctness of the convergence loop; no crash, no data loss. Deferred behind the active reliability queue (R-WPEX↻, R-SIGF) per the reliability-first north star.
**Backend:** backend-agnostic (the defect is in the runner, not the worker spawn path).
**Discovered:** 2026-06-28, while evaluating whether RUC-NLPIR/Arbor's Hypothesis-Tree Refinement (HTR) is worth borrowing for the microverse loop. The investigation surfaced this wiring bug instead — and it is the cheaper, subtractive fix HTR would otherwise have masked.

## Summary

Microverse maintains a `failed_approaches: string[]` denylist that is injected into the next iteration's worker prompt as a `## Failed Approaches (DO NOT RETRY)` block (`appendFailedApproachesHandoff`, `microverse-runner.ts:2566`). The intent: stop the loop from re-proposing changes that already failed to help.

In practice the denylist is **dead on the dominant real-world stall pattern**, because it is populated from exactly one trigger — a metric **regression**:

```
// microverse-runner.ts:3408
if (classification === 'regressed') {
  ...
  replaceMicroverseState(state, recordFailedApproach(state,
    `Iteration ${ctx.iteration}: score dropped from ${previousScore} to ${metricResult.score}`));
}
```

A `held` iteration — the worker made changes that **did not move the metric** — is a failed attempt at progress, but it is **never recorded**. The next worker therefore receives an empty DO-NOT-RETRY list and is free to re-propose the same ineffective change. On a plateau (improve once, then `held, held, held…`) the denylist stays empty for the entire streak until `stall_limit` is hit.

## Evidence (live session ground truth)

Every microverse run under `~/.local/share/pickle-rick/sessions/` with real iterations shows the same shape, and **`failed_approaches` is empty (0) in all of them** despite multi-iteration `held` plateaus:

| Session | Metric | Trajectory | Exit | failed_approaches |
|---|---|---|---|---|
| 2026-06-22-27298c24 | principle violations | 7→5, held×3, →4, **held×5** | stall 5/5 "converged" @4 (target 0) | **0** |
| 2026-06-22-b6b75d07 | principle violations | 17→13, **held×5** | stall 5/5 "converged" @13 (target 0) | **0** |
| 2026-06-23-27d9ad00 | principle violations | 40→22, held×1 | stopped early @22 | **0** |
| 2026-06-28-952ab2a6 | principle violations | 34→31 | stopped early @31 | **0** |

The `failure_history` array *does* record `no_progress` classes for held iterations (e.g. 27298c24: `{iteration:5, failure_class:"no_progress", description:"held: 5 vs 5"}`) — so the loop **knows** it plateaued. That knowledge is simply never routed into `failed_approaches`, the one field the next worker actually reads.

**Caveat on the dataset:** all four real runs optimize the same szechuan principle-violation (LLM-judged) metric. The wiring defect is universal (it is in the code, not the metric), but plateau shape for numeric metrics (coverage, perf, lint count) has not been directly observed. The fix is metric-agnostic.

**Secondary observation (out of scope, note only):** every run targets `0` violations on an LLM-judged count, which is effectively unreachable; a `held` plateau at 4 or 13 is partly an over-ambitious target, independent of failure memory. Do NOT fold a target-realism change into this fix.

## Root cause

The failure-memory mechanism is wired to the rarest classification (`regressed`) and ignores the most common stall classification (`held`/`no_progress`). The denylist therefore captures the one event that almost never happens in a deslop/convergence run and misses the one that always does.

This is a **single mis-wired trigger**, not a missing subsystem. The recording function (`recordFailedApproach`), the storage (`failed_approaches`), and the prompt injection (`appendFailedApproachesHandoff`) all already exist and work — they are simply never fed the plateau case.

## Relationship to Arbor / HTR (decision record)

Arbor's HTR (arXiv 2606.11926) adds a hypothesis **tree** with upward backpropagation of distilled lessons. Adopting it would be a large additive change (second orchestrator, Python, ~thousands of LOC) against a standing subtract-before-add / reliability-first principle. The investigation showed that ~90% of HTR's relevant benefit for *our* loop is captured by fixing this dead denylist — i.e. routing the `held`/`no_progress` case into the existing failure memory. **HTR's genuine residual edge (holding multiple competing live hypotheses via branching) is deferred** and is NOT in scope here. This bug-fix is the subtractive alternative to importing Arbor.

## The fix

Route `held` / `no_progress` iterations into `failed_approaches` so the DO-NOT-RETRY handoff is populated on plateaus, and make the recorded description specific enough to steer the next worker away from the same move.

### Acceptance criteria

- **AC-MVFM-01** — `recordFailedApproach` (or an equivalent call) fires when an iteration is classified `held`, not only `regressed`. The recorded entry distinguishes plateau (`held: N vs N`) from regression (`score dropped from N to M`). Machine-checkable: a unit test driving a `held` iteration asserts `failed_approaches.length` increments by 1.
- **AC-MVFM-02** — The recorded `held` entry includes enough context to be actionable in the next prompt (at minimum the iteration number and the unchanged score; if a per-iteration approach summary is available in state, include it). No raw object dumps.
- **AC-MVFM-03** — `appendFailedApproachesHandoff` emits the populated block on the iteration following a `held` plateau (integration-style test: run 2 iterations where #1 is `held`, assert iteration #2's composed prompt contains the `## Failed Approaches (DO NOT RETRY)` block with the #1 entry).
- **AC-MVFM-04** — No double-counting: a single iteration contributes at most one `failed_approaches` entry regardless of how many classifiers touch it. Existing `regressed` behavior is unchanged (regression still records exactly one entry).
- **AC-MVFM-05** — De-duplication guard: identical consecutive `held` descriptions are not appended N times for an N-long plateau (either dedupe, or record once per distinct approach). Prevents the prompt from ballooning on long plateaus. Machine-checkable: 5 identical `held` iterations yield ≤ a documented cap of entries, not 5 verbatim dupes.

### Out of scope (do NOT add)

- No hypothesis **tree** / branching (that is the deferred HTR residual).
- No change to `stall_limit`, `convergence_target`, or target-realism.
- No new state schema version if `failed_approaches` already accommodates the strings (prefer reuse — it does).

## Simplification Review (subtract-before-add)

1. **Does this remove more than it adds?** It adds no new field, no new function, no schema bump — it re-points an existing trigger at an additional classification and adds a dedupe guard. The net new surface is a few lines plus tests. It is the explicit *alternative* to the large additive option (importing Arbor/HTR), so it subtracts a would-be dependency.
2. **Is there an existing mechanism to reuse?** Yes — `recordFailedApproach`, `failed_approaches`, and `appendFailedApproachesHandoff` all exist and are exercised; only the `held` path is unwired.
3. **Can a guard be collapsed instead of added?** This does not add a guard; it activates dead capacity. The dedupe (AC-05) is the only new guard and exists solely to bound prompt growth.
4. **What breaks if we do nothing?** The denylist remains decorative; plateaus burn `stall_limit` iterations re-trying ineffective moves with zero memory — the exact wheel-spinning the field was built to prevent.

## Test plan

- Unit: `extension/tests/microverse-*.test.js` — `held` iteration increments `failed_approaches` (AC-01); regression path unchanged (AC-04); 5-long identical plateau respects the dedupe cap (AC-05).
- Integration: 2-iteration fixture, #1 `held`, assert composed iteration-#2 prompt contains the populated DO-NOT-RETRY block (AC-03).
- Regression guard: existing finalizer/handoff tests (`microverse-runner-finalizer.test.js`) still pass with a non-empty `failed_approaches`.

## Build approach

Standard pickle build is fine — the fix edits the runner's classification-handling path, not the worker-spawn path, so the R-PSRB self-build hazard does not apply. Single small ticket. Hand-build acceptable given size.

# BUG — R-ORSR-2 commit-and-continue recovery flips a ticket to Done WITHOUT the implementation landing

**Filed:** 2026-07-16 · **Hit while:** LOA-1763 pipeline, ticket B6b (`adb35445`, order 610 — "Delete both FIRSTCOLONY gates")
**Component:** `extension/**` — the R-ORSR-2 "commit-and-continue recovery" path + the Done-flip / completion-evidence oracle
**Severity:** HIGH — the single most important cleanup ticket in a 66-ticket bundle was marked **Done** with **zero implementation committed**, and the tally showed 70/71 Done.
**Status:** CAPTURE-ONLY (pipeline left running; the missed edit is tracked for a manual post-pipeline fix)

## What happened

B6b's job: delete the two `"FIRSTCOLONY"` runtime gates in `appraisal.processor.ts` (`:625` early-return
for non-FC; `:3063` eval-bag gate), replaced by B-DEPLOY's readiness predicate (which DID land).

The ticket flipped to **`status: Done`**, `worker_gate_verdict: "green"`, and the pipeline advanced to
order 620 (hardening). But:

- **Both gates are still in the source** — `grep '"FIRSTCOLONY"'` over `src` (excl bundles/tests) still
  returns **2** (`:625`, `:3063`). The deletion never happened.
- The **only commit tagged to the ticket** is `f39e09f1a fix(adb35445): commit-and-continue recovery
  (R-ORSR-2)` — a recovery/salvage commit, not the gate edit.
- The ticket dir holds **10 `worker_session_*.log`** files. Every `handoff_notes.md` entry reads:
  *"Tried: launch smoke test (worker-setup init + repo/toolchain/target-file probes) — Failed: none …
  **Next focus: real B6b impl** in appraisal.processor.ts (delete FIRSTCOLONY literals…)"*

So the worker **re-ran a launch/smoke diagnostic on all 10 attempts and never reached the actual edit.**
R-ORSR-2 recovery committed the diagnostic artifacts and continued each time; after the retry budget, the
completion oracle accepted the recovery commit as evidence and flipped the ticket **Done**.

## The defect

**A recovery/salvage commit is being treated as completion evidence.** `f39e09f1a` is tagged with the
ticket hash (`adb35445`) but its subject is `commit-and-continue recovery (R-ORSR-2)` — it is explicitly a
*"I could not finish, saving state"* commit. The completion predicate should treat an R-ORSR-2 recovery
commit as **NOT satisfying** the ticket's acceptance criteria — especially when those ACs are
machine-checkable and FALSE (`grep: zero FIRSTCOLONY` is still 2; `lender-isolation.e2e` unrun).

Two things compounded:
1. **The worker burned its whole turn on a launch smoke-test diagnostic** and never got to the edit —
   10 times. Whatever makes the worker re-probe instead of implement is the upstream cause.
2. **R-ORSR-2 recovery + the Done-flip did not re-check the ticket's own grep/e2e ACs** before accepting.
   A ticket whose AC is `! grep FIRSTCOLONY src` should not go Done while that grep returns 2.

This is adjacent to R-AICF / R-CECX (evidence-oracle disagreement) but distinct: here the commit *exists*
and *is* hash-tagged, so the inferred-completion path accepts it — but it is a **recovery** commit, not an
implementation commit, and the ACs are verifiably unmet.

## Repro

1. A ticket whose worker repeatedly fails to reach implementation (here: re-runs a smoke diagnostic each turn).
2. R-ORSR-2 commit-and-continue fires, committing salvage state tagged with the ticket hash.
3. After the retry budget, the ticket flips Done on the recovery commit — ACs never re-verified.

## Suggested ACs

- `it("an R-ORSR-2 recovery commit does NOT satisfy the completion predicate — a ticket with only a recovery commit stays In Progress or goes Failed, never Done")`
- `it("before flipping Done, a ticket's machine-checkable ACs (grep/e2e) are re-run; a FALSE grep AC blocks the Done-flip")`
- `it("a worker that consumes N consecutive turns on launch/smoke diagnostics without editing a declared target file is surfaced as stuck, not silently recovered")`

## Impact + workaround

70/71 showed Done while the branch's central cleanup (gates down, engine lender-agnostic) was NOT applied
— `grep FIRSTCOLONY` = 2, not 0. **Workaround:** the two-line gate deletion is a trivial, well-specified
manual edit (delete the `:625` early-return and the `:3063` eval-bag gate condition; B-DEPLOY's readiness
predicate already replaces them). Tracked for a hand-fix after the pipeline's own phases (citadel /
anatomy-park / szechuan) complete, so it lands with the branch rather than racing the running pipeline.

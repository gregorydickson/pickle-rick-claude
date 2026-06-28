# BUG-REPORT 2026-06-28 — doc-only deliverable left uncommitted → pickle 0/4; durable-boundary committer coverage gap (R-WUDC)

**Incident:** B-APNC (R-APNC) build, `--backend claude`, `/pickle-pipeline --scope branch`, session
`2026-06-28-4209388b`. The **pickle phase exited `pipeline_phase_incomplete` at 0/4 phases** after 55m
20s (iter 7 / 500 — NOT the iteration cap), stranding a fully-completed-but-uncommitted ticket. The
babysitter hand-recovered and the pipeline then advanced normally. Logged per the loop-failure directive
([[feedback_loop_failure_log_bug_prd_and_master_plan]]).

## Finding (P2) — R-WUDC: doc-only deliverable stranded uncommitted, durable-boundary committer did not capture it

The bundle had 2 tickets:
- **`5dc68f98` (WS-1+WS-2, code):** completed + committed (`4ad6d2d9`) → `Done`. ✅
- **`6803d887` (WS-3, doc-only):** "subtract-pass discipline section in `.claude/commands/anatomy-park.md`
  + README". The worker ran its **full lifecycle** — `research_6803d887.md`, `plan_6803d887.md`,
  `conformance_6803d887.md`, plan_review/research_review all present — and **produced the deliverable**
  (a correct, complete 14-line `### Override 1.6: Subtract-pass discipline` section, later verified to
  satisfy AC-APNC-4 + pass all doc-coupled tests). BUT the edit was left **uncommitted** in the working
  tree and the ticket stayed `status: Todo`.

Runner log (`pipeline-runner.log`):
```
Phase pickle exited with code 0
Phase pickle exited but 1/2 tickets remain pending (1 Done) — not all-tickets-terminal, marking phase incomplete (not advancing)
Phase pickle exited (exit_reason=done_without_commit_evidence); 1/2 tickets remain unfinished.
  20  6803d887  WS-3 — subtract-pass discipline section ...  [status: Todo]
Pipeline finished: 0/4 phases, 55m 20s
```

**The gap.** Two safety nets that should have caught this both missed:
1. The worker's own Done-flip was (correctly) refused — `done_without_commit_evidence` — because there
   was no commit. Correct behavior, but it left the ticket `Todo` rather than salvaging the work.
2. **The B-DURA durable-boundary committer** (`commitGatePassingDeliverableOnExitPath` /
   `commitGatePassingDeliverableAtBoundary`, whose whole purpose is "worker left gate-green dirty work
   but committed nothing → runner authors a commit") did **NOT** fire for this ticket.

**Hypothesis (to investigate).** The durable-boundary committer is keyed to specific exit paths
(worker timeout / salvage / manager-relaunch boundary) and/or to gate-passing work under `extension/`.
This deliverable was (a) **doc-only**, editing `.claude/commands/anatomy-park.md` — **outside `extension/`**,
so the armed `runBetweenTicketFastTests` #99 gate (which runs in `extension/`) sees no relevant diff —
and (b) produced on a **clean manager-turn exit** (the manager finished its turn, exit code 0, not a
timeout/salvage), so the exit-path committer's trigger condition likely never armed. Net: a doc-only
deliverable on the clean-exit path is **not** covered by the durable-iteration-boundary commit, and the
phase declares incomplete with verified work stranded uncommitted. This is a NEW variant of the
worker-uncommitted-work class ([[R-WUWC]] / R-WSE / B-DURA family) specific to **doc-only / non-`extension/`
deliverables** and the **clean manager-exit** path.

## Fix direction (reuse-first; for a future bundle)

Extend the durable-boundary committer's coverage so a ticket whose worker produced lifecycle artifacts
(`conformance_*.md` present) + a non-empty working-tree diff attributable to the ticket — **including
doc-only diffs outside `extension/`** — has that diff committed + the ticket flipped `Done` at the phase
boundary, rather than left `Todo`. Reuse the existing exit-path committer + the `worker_gate_verdict`
authority (a doc-only ticket has no `extension/src` diff → trivially green). Do NOT add a parallel
mechanism; close the coverage gap on the path that already exists. Alternatively: gate the boundary
committer on "lifecycle complete (conformance present) + attributable dirty diff" rather than on the
narrower timeout/salvage triggers.

## Recovery taken (babysitter, verified)

1. Confirmed the uncommitted `anatomy-park.md` edit was complete + correct (AC-APNC-4 grep present; ran
   the doc-coupled tests `scope-preflight-ordering`, `anatomy-park-gate-integration`,
   `worker-templates-include-scope-preflight`, `scope-errors-doc-parity` — all green).
2. Committed the verified doc work attributed to the ticket (`080e7e60`).
3. Flipped `6803d887` → `Done` + `completion_commit: 080e7e60` (heal-via-edit-then-resume recipe).
4. Cleared stale `worker_artifact_progress` / `detached_worker` / `current_ticket` to avoid relaunch
   mis-routing, then re-launched `pipeline-runner.js` (self-activates via `claimPipelineRunnerActive`).
5. Pickle re-entered, found both tickets terminal → **graduated** → advanced to citadel → anatomy-park →
   szechuan. Build is now progressing normally toward beta.27.

## Severity / priority

**P2** — recoverable (verified work preserved; ~5 min hand-recovery), but it is silent data-stranding:
without a babysitter the build sits at 0/4 with completed work uncommitted. Same impact class as the
B-DURA cluster it falls outside of. Worth a focused fix bundle when the drain queue reaches it.

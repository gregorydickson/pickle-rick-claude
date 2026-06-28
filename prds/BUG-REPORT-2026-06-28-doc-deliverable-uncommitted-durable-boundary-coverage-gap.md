# BUG-REPORT 2026-06-28 — B-APNC pickle 0/4: R-WPEX worker log-flush death recurred + manager inline-recovery committed only 1 of 2 tickets

> **CORRECTION (2026-06-28, after deeper investigation prompted by the operator):** the original title/finding
> of this report ("R-WUDC — doc-only deliverable / durable-boundary committer coverage gap") was **WRONG** and
> is retracted. This is **not a brand-new bug**. The manager's own iteration-6 narration shows the true trigger
> is the **known R-WPEX detached-`claude -p` worker silent-death-on-log-flush class** (already filed + shipped:
> `archive/bundles/p1-bug-fix-bundle-r-wpex-worker-silent-death.md`,
> `archive/bundles/p1-bug-fix-bundle-b-wpex-auto-large-tier-detached-worker-poll.md`,
> `archive/bug-reports/p2-worker-silent-exit-and-ticket-path-drift.md`). The corrected analysis is below.

**Incident:** B-APNC (R-APNC) build, `--backend claude`, `/pickle-pipeline --scope branch`, session
`2026-06-28-4209388b`. The **pickle phase exited `pipeline_phase_incomplete` at 0/4 phases** after 55m
20s (iter 7 / 500 — NOT the iteration cap), leaving one ticket's completed work uncommitted. Babysitter
hand-recovered; the pipeline then advanced. Logged per the loop-failure directive
([[feedback_loop_failure_log_bug_prd_and_master_plan]]).

## Root cause (corrected) — R-WPEX recurrence + manager inline-recovery incompleteness

The manager's iteration-6 stream states it directly:
- *"The worker died on log-flush, not on the work."*
- *"the lifecycle ran through implement; only the verify/review artifacts are missing because of the
  log-flush death. I performed those phases myself."*
- *"6803d887 (WS-3) — IN PROGRESS 🔄 In-process `morty-implementer` … avoiding the detached-`claude -p`
  flush bug that killed the spawn-morty [worker]."*

Sequence:
1. **R-WPEX RECURRED (primary).** The detached `claude -p` spawn-morty workers died on **log-flush**
   (the artifacts/work survived; the worker process died at flush/exit). This is the documented R-WPEX /
   worker-silent-exit class — previously triaged **MONITOR-only ("likely transient load",
   [[project_wpex_worker_silent_death_monitor]])**. This is a fresh repro on a not-obviously-overloaded
   system, which is the condition that memory says should **reopen R-WPEX** rather than stay monitor-only.
   `5dc68f98` has 3 `worker_session` logs (spawn + retries, all flush-died); `6803d887` has **none** —
   for it the manager skipped spawn-morty entirely and used an in-process `morty-implementer`.
2. **Manager inline recovery (worked, but partial).** The manager recovered both tickets' work in its own
   context: it validated + committed `5dc68f98` (`4ad6d2d9`, marked Done + recorded the boundary commit),
   and delivered `6803d887`'s deliverable via the in-process subagent.
3. **Phase exited mid-recovery.** The pickle manager loop ended (clean exit code 0, iter 7) **after
   committing 1 of 2 tickets but before committing/Done-flipping `6803d887`**. So `6803d887` was left
   `status: Todo` with its `anatomy-park.md` edit uncommitted → `1/2 tickets pending` →
   `pipeline_phase_incomplete` → `0/4 phases`. (The `done_without_commit_evidence` log line is the Done-flip
   guard correctly refusing the uncommitted ticket.)

**What is NOT the cause (retracted):** the B-DURA durable-boundary exit-path committer is not the right
lens here — the work was being recovered *inline by the manager*, not stranded by a worker-exit path the
committer watches; and the "doc-only / outside-`extension/`" angle is incidental, not causal.

## The genuinely-actionable findings

1. **Reopen R-WPEX** (P2→consider P1): detached `claude -p` workers still die on log-flush, no longer
   plausibly "transient load." The R-WPEX/B-WPEX fixes (auto large-tier detached poll, worker-shutdown
   flush-and-drain `worker-shutdown.ts`) did not prevent this recurrence on a `medium`-tier worker. Needs a
   fresh repro-driven look at the `flushAndExit` / `once(sessionLog,'close')` drain vs the actual death
   class (SIGKILL/segfault/OOM produce 0-byte logs per R-WSE-2; this was "died on flush" with artifacts
   intact — a distinct flavor).
2. **Manager inline-recovery should commit per-ticket, not batch** (the smaller, possibly-new bit): when the
   manager hand-recovers multiple flush-died workers in one turn, it must commit+Done-flip **each ticket as
   it finishes** so a turn/loop exit can't strand an already-delivered ticket uncommitted. (Mitigated in
   practice by the operator/babysitter, but it is what turned a recoverable R-WPEX hit into a 0/4 phase
   failure.)

## Recovery taken (babysitter, verified)

1. Confirmed `6803d887`'s uncommitted `anatomy-park.md` edit was complete + correct (AC-APNC-4 grep present;
   doc-coupled tests `scope-preflight-ordering`, `anatomy-park-gate-integration`,
   `worker-templates-include-scope-preflight`, `scope-errors-doc-parity` all green).
2. Committed the verified doc work attributed to the ticket (`080e7e60`).
3. Flipped `6803d887` → `Done` + `completion_commit: 080e7e60` (heal-via-edit-then-resume).
4. Cleared stale `worker_artifact_progress` / `detached_worker` / `current_ticket`; relaunched
   `pipeline-runner.js`. Pickle re-entered → both terminal → graduated → advanced to citadel → anatomy-park.

## Severity / priority

**P2.** Recoverable (verified work preserved; ~5 min hand-recovery). The headline is the **R-WPEX
recurrence** (the trigger); the manager-inline-recovery-per-ticket-commit gap is the secondary, narrower
fix. Not a new defect class.

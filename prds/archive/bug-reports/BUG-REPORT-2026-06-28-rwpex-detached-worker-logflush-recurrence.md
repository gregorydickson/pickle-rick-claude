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

## Diagnostic update — the actual trigger is the DETACHED-SPAWN PATH, not load (operator-prompted, 2026-06-28)

"It doesn't stall every time" — cross-session comparison shows why. The necessary condition is **whether the
manager spawns a detached `spawn-morty` `claude -p` worker at all**; the in-process delivery path is immune.

| Session | tickets | detached `claude -p` workers spawned | result |
|---|---|---|---|
| **B-CWGE** (`2026-06-28-952ab2a6`) | 3 | **0** — all `worker_session` logs absent; manager built every ticket **in-process** | clean **4/4** |
| **B-APNC** (`2026-06-28-4209388b`) | 2 | **3** on `5dc68f98`, **every one a 0-byte log** (flush-death signature) | **0/4** stall |

Findings from the comparison:
- The flush-death lives **only on the detached `claude -p` (`spawn-morty`) exit path**. When the manager
  builds in-process (`morty-implementer` subagent → no `worker_session` log), the bug **cannot fire** —
  B-CWGE proved it (0 detached spawns, 0 deaths, clean). "Not every time" = the manager doesn't always spawn
  detached; it's a per-ticket judgment, and managers have been *learning to avoid it* (B-CWGE went fully
  in-process; B-APNC's manager pivoted to in-process for ticket 2 after ticket 1's 3 deaths).
- **Load is likely NOT the trigger** (contradicts the original "transient load" triage). B-APNC's pickle ran
  **21:07–22:02Z**; the babysitter's heavy background gates ran **before** (gate6 ended ~20:59Z) and **after**
  (apnc-gate started ~22:37Z), **not during** — so the 3 deaths happened on a relatively idle machine. It is
  a real **flush/drain bug in the detached `claude -p` worker exit**, not a load artifact.
- The 0-byte logs distinguish it: the worker dies **before/while its log stream flushes** — a distinct flavor
  from the SIGKILL/segfault/OOM 0-byte class R-WSE-2 already covers, and from a clean exit.
- **Caveat: n=2 sessions.** The detached-vs-in-process correlation + the 0-byte logs are strong; the "not
  load" claim rests on this one window's timing. Settle it in the repro (run with and without concurrent load).

## The plan (restart-ready) — R-WPEX↻

**This is the next drain item. Build approach: HAND-BUILD in-process (R-PSRB).** The fix edits the detached
worker exit path, which is exactly the path an autonomous pipeline's own workers run on — so a pipeline run
risks re-triggering the bug while building its fix (B-APNC demonstrated it). The in-process `morty-implementer`
path is the immune one (B-CWGE proved it), so hand-building in-process sidesteps the bug entirely.

1. **Repro FIRST (test-driven, do not guess the fix).** Write a deterministic test that spawns a detached
   `claude -p`-shaped child producing a LARGE stdout log and asserts the `worker_session` log fully drains on
   exit (the `flushAndExit` → `once(sessionLog,'close')` path in `services/worker-shutdown.ts` + the detached
   spawn in `bin/spawn-morty.ts`). Run it **with and without concurrent load** to settle whether load is a
   contributing factor or irrelevant. Target the "died-on-flush, artifacts-intact, 0-byte session log" flavor
   specifically — NOT the SIGKILL/OOM class (R-WSE-2).
2. **Fix the drain race** the repro exposes (likely: the detached child's stdout pipe isn't fully drained
   before the parent/child exits; or `flushAndExit`'s `'close'` await doesn't cover the detached case).
3. **Secondary (smaller): manager inline-recovery should commit PER-TICKET, not batch** — when the manager
   hand-recovers multiple flush-died workers in one turn, commit+Done-flip each ticket as it finishes so a
   turn/loop exit can't strand an already-delivered ticket (this is what turned a recoverable R-WPEX hit into
   the 0/4 failure). Lives in the pickle manager prompt / send-to-morty guidance.
4. Full local gate, ship the next beta, sweep this report to `archive/bug-reports/`.

Files in scope: `extension/src/services/worker-shutdown.ts` (`flushAndExit`), `extension/src/bin/spawn-morty.ts`
(detached `claude -p` spawn + `runWorkerProcess`), the worker-shutdown test. Pre-build: re-`git log`/grep HEAD
for any since-shipped flush-drain fix (`feedback_prelaunch_residual_check_stale_findings`).

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

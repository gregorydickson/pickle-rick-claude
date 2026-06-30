# BUG REPORT — beta.31 routes explicit-`medium` tickets through the large-tier DETACHED poll path, which false-fails them in ~980ms → false `EPIC_COMPLETED`, pickle 0/N

**Filed:** 2026-06-30 (surfaced launching the B-SSVR `/pickle-pipeline --scope branch` run, session `2026-06-30-38285dba`, the FIRST pipeline run on the beta.31 runtime deployed earlier today)
**Code:** R-LTDM (Large-Tier Detached, Medium-tier false-fail) — **R-MWBG runtime-half REOPENED** (cross-ref [[R-MWBG]]; the beta.31 fix is the introducing change)
**Priority:** P1 — blocks autonomous building of ANY `complexity_tier: medium` ticket via mux/pipeline on the deployed runtime. Reproduced 3× deterministically this session.
**Component:** `extension/src/bin/mux-runner.ts` — `tierExceedsBashCeiling` (`:3353`) routing + the large-tier detached spawn/poll lifecycle (`spawnDetachedLargeTierWorker` `:3395+`, the main-loop poll seam `~:6090-6124`, and the no-progress/`wmw-auto-skip-oversized` evaluation reached from it).

## Symptom (observed, reproduced 3×)

A `/pickle-pipeline --scope branch` build of a 2-ticket bundle (both `complexity_tier: medium`, zero file overlap) exits with:

```
PHASE 1/4: PICKLE (backend=claude)
Phase pickle exited with code 0
Phase pickle exited but 2/2 tickets remain pending (0 Done) — not all-tickets-terminal, marking phase incomplete (not advancing)
Pipeline finished: 0/4 phases, 0m 3s
```

mux-runner internals (pane buffer):
```
all-tickets-done (2/2): synthesizing EPIC_COMPLETED completion
🥒 mux-runner Complete  Iterations: 16  Elapsed: 0m 2s  FinalPhase: completed  Active: false
```

Both tickets end `status: Failed`, `failed_reason: no_progress_timeout`, each with a **0-byte** `worker_session_<pid>.log`. The activity trace per failed run is: `large_tier_worker_spawned` → `large_tier_worker_poll` ×~3 → (`worker_artifact_progress_zero` / `worker_auto_skip_oversized`) → `epic_completed`.

## Root cause (verified mechanism; precise internal trigger flagged below)

1. **beta.31 routes explicit-`medium` through the LARGE detached path.** `tierExceedsBashCeiling(state, sessionDir, ticketId)` (`mux-runner.ts:3353`) reads the ticket's explicit `complexity_tier`, resolves its tier budget, and returns `budget.worker_timeout_seconds > BASH_TOOL_CEILING_SECONDS`. The medium-tier budget is **3600s > 600s**, so it returns `true`. The main-loop seam (`~:6102`) gates detached routing on `state.current_ticket_tier === 'large' || tierExceedsBashCeiling(...)` — so **every explicit-`medium` ticket now spawns through the detached large-tier lifecycle**, a path built and previously exercised only for `large`. (Pre-beta.31 the gate was `=== 'large'` only, so medium spawned synchronously and this path was never reached for medium.)

2. **The detached poll loop concludes "no progress" in ~980ms — before the worker can produce anything.** Measured from the activity log: `large_tier_worker_spawned 13:25:00.329Z` → `epic_completed 13:25:01.309Z` = **980ms**. The detached `claude -p` worker writes nothing in <1s (its `worker_session` log is legitimately empty that early — `text` output format buffers), the poll/no-progress evaluation reads zero artifacts + an empty log as terminal no-progress, flips the ticket `Failed`/`no_progress_timeout`, and the all-tickets-terminal synthesis fires a **false `EPIC_COMPLETED`** (Failed counts as terminal). The outer loop spun **16 iterations in ~2s** — it is not honouring the worker's `worker_timeout` (3600s) or any first-artifact grace window.

## Proof it is the poll lifecycle, not the worker / not the environment

- **`claude -p` is healthy.** A direct `claude -p --dangerously-skip-permissions "Reply PROBE_OK"` returned `PROBE_OK`, exit 0. No rate-limit (`five_hour` not parked), no `circuit_breaker.json`, no `rate_limit_wait.json`.
- **A FOREGROUND spawn-morty (same invocation, minus detach) does NOT instant-die.** Running the identical `spawn-morty.js … --ticket-id 4bea20de --timeout 3600 --backend claude` in the FOREGROUND ran the **full 110s** without concluding (killed by the probe's `timeout`), having flipped the ticket to `In Progress` and still working — i.e. a real worker needs **minutes**, not ~1s. The asymmetry (detached concludes in 980ms vs foreground still alive at 110s) localizes the defect to the detached **poll/no-progress evaluation**, not the worker.
- **Not the stale-state false-flip.** Reproduced AFTER a full clean reset (`worker_artifact_progress = {}`, `detached_worker = null`, `iteration = 0`, tickets → Todo, un-terminalized). Identical 980ms false-fail. So this is distinct from the [[project_resh_wedge_detector_falsekill_committed_not_deployed]] / [[project_wmw_auto_skip_near_green_wedge_recovery]] stale-cache class (though it shares the `wmw-auto-skip-oversized` symptom surface, R-WMNP).

## Impact

- **Every `complexity_tier: medium` ticket is unbuildable via mux/`pipeline-runner` on the deployed beta.31 runtime** — it is false-failed in ~1s and the pickle phase reports `0/N`, never advancing to citadel/anatomy-park/szechuan. Medium is the default tier for any iteration-loop/orchestrator-touching fix (per `extension/CLAUDE.md` "build ≥ medium").
- **This is the FIRST pipeline run on beta.31** (deployed 2026-06-30). No prior shipped bundle exercised it: B-RELHYG (beta.30, "clean /pickle-pipeline 4/4, 178m") ran on the pre-`tierExceedsBashCeiling` runtime where medium spawned synchronously. So this is a **fresh beta.31 regression**, exactly the risk the MASTER_PLAN rebuild notes flagged: *"the detached lifecycle (built for LARGE) does NOT preserve those invariants for medium."*

## Fix direction (reuse-first; this is the R-MWBG runtime half, again)

The beta.31 `tierExceedsBashCeiling` change correctly identifies that medium > 600s needs ceiling survival, but the detached lifecycle it routes them into does not give the worker a first-artifact grace window before the no-progress/oversized evaluation fires. Candidate fixes (pick after a source trace of the exact 980ms trigger):

1. **Grace window before the first no-progress/oversized verdict on the detached path** — do not evaluate `worker_artifact_progress_zero` / `wmw-auto-skip-oversized` until at least one real poll interval (or `breaker_recovery_grace_seconds`-style window) has elapsed since `large_tier_worker_spawned`. Reuse the existing detached poll cadence; the bug is that the verdict fires on poll #1.
2. **OR** make the detached path honour the worker's `worker_timeout` the way the synchronous path does (the 16-iterations-in-2s shows the outer loop is not waiting on the detached worker).
3. **Narrow the routing** so only genuinely-`large` (or workers actually under a 600s ceiling) take the detached path — the runner inside a tmux pane is NOT under the 600s Bash-tool ceiling, so medium could spawn synchronously there (the ceiling that motivates detaching only applies when the runner itself is a headless-Bash child). A runtime "am I under the ceiling?" signal would let medium stay synchronous in tmux/interactive launches.

Kill-switch note: `PICKLE_LARGE_TIER_DETACHED=off` does NOT help — it reverts to `routeLargeTierTicket`, which merely emits `large_tier_routed` and punts to interactive `/pickle-tmux` (it does not build the ticket). So there is no operator escape hatch that still builds medium tickets autonomously today.

**Open question for the fixer (do NOT guess):** the exact 980ms trigger — is it the `wmw-auto-skip-oversized` threshold firing on poll #1, the `no_progress_timeout` evaluation, or the outer-loop cadence not awaiting the detached worker? Trace `spawnDetachedLargeTierWorker` → the `:6090-6124` poll seam → the no-progress/auto-skip evaluation with timestamps before choosing fix (1) vs (2).

## Build-around used this session (so B-SSVR still ships)

Because medium tickets cannot be built autonomously on beta.31, the B-SSVR fixes (R-SSBR + R-ISVP) are being hand-built via in-process subagents (the documented detached-worker-silent-death recovery — [[project_bdsan2_session_handbuild_under_contention]] / [[project_dead_code_scaffolding_silent_death_handbuild]]), gated and committed by the operator. R-LTDM itself is a salvage/iteration-loop-adjacent runtime fix and must be built ≥ medium with the detached path verified — a candidate for the next reliability drain.

**Cross-links:** [[R-MWBG]] (introducing change — runtime half reopened), [[R-WPEX]] (sibling 0-byte detached-log class, but that was a flush durability gap with artifacts intact; this is a premature-poll-verdict with NO artifacts), R-WMNP (shared `wmw-auto-skip-oversized` symptom surface).

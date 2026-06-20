# P1 Bug-Fix Bundle — R-MWIS: mux-runner worker-exit idle-stall (silent hang, completed work stranded)

**Finding:** #107 R-MWIS (MASTER_PLAN). **Priority:** P1 (silent total hang + work-loss-risk; the pipeline self-recovers from NOTHING — no loop, no error, no event).
**Source:** Live babysitting incident, session `2026-06-08-ce6ae444` (R-RGED #105 build), ticket `548559f1` (T5, PR#1707 fixtures + G1/G2), 2026-06-08.

## Incident

T5's worker (claude -p) spawned (`worker_spawn_backend_resolved` 22:49:59), ran ~21 min of research+implement, produced `research_548559f1.md` AND the **complete, gate-passing AC-6 deliverable** in the working tree (`extension/tests/citadel/fixtures/loa907-{clean,dirty}.diff` + a 298-line `loa907-regression.test.js`, 22/22 tests green, tsc clean), its `tmux_iteration_21.log` grew to ~496KB, then the worker **exited** (log froze 23:13). The mux-runner did **NOT** detect the exit:

- both `pipeline-runner` and `mux-runner` sat at **0.0% CPU** (`STAT S+`) idle;
- **no** `Iteration 22`, no worker respawn, no outcome processing;
- last activity event was the 22:49:59 worker spawn — **~30 min of total silence**;
- **no** rate-limit wait, **no** circuit-breaker trip (CLOSED), `last_error: null`, `consecutive_subprocess_errors: 0`;
- the worker's `worker_session_*.log` was **0 bytes** (render-lag / silent exit);
- the completed, gate-passing deliverable sat **uncommitted** — a clean-tree relaunch would have **discarded** it.

Babysitter recovery: froze both runners, backed up the WIP reset-proof, verified green (tsc + 22/22), committed T5 (`80e84fd8`), marked the ticket Done, cleared `current_ticket`, relaunched the deployed pipeline-runner → advanced to wiring (`1eb80f18`).

## Why this is a distinct class (not #99 R-WCUC, not #106 R-WMNP)

- **#99 R-WCUC** (commit gate-passing work before *failing*) and **#106 R-WMNP** (wmw-auto-skip flips Failed + respawns in a loop) both require the no-progress detector to RUN. Here the mux **never reaches any detector** — it hangs at 0% CPU. There is no Failed flip, no respawn, no auto-skip, no event. The worker exit is simply never observed.
- Root hypothesis: the mux's worker-exit signal depends on a log-emitted completion/promise token (or a stop-hook) rather than the child-process exit code as the PRIMARY signal; a worker that exits with a **0-byte log** (emits no token) is never noticed, so the blocking wait / poll loop hangs forever.

## Acceptance Criteria (machine-checkable)

- [ ] **AC-R-MWIS-1 — process-exit is the PRIMARY worker-completion signal.** The mux-runner MUST observe worker-subprocess termination via the child process exit (wait/exit code), INDEPENDENT of whether the worker wrote any session-log output or emitted a completion/promise token. A scripted worker that exits (zero OR non-zero) while writing 0 bytes to its session log MUST cause the mux loop to process the outcome within a bounded time, never hang at 0% CPU. — Type: test (`extension/tests/...mux-silent-worker-exit...test.js`, forward-created)
- [ ] **AC-R-MWIS-2 — mux main-loop idle watchdog.** While `state.active === true` with no rate-limit/breaker/wait state, if the mux makes no progress (no iteration advance, no worker spawn, no state write) for longer than a bounded threshold, it MUST emit a diagnostic activity event (`mux_idle_stall_detected`) and attempt self-recovery (re-evaluate current ticket / respawn), rather than sit silently at 0% CPU. — Type: test
- [ ] **AC-R-MWIS-3 — commit completed work on the exit path.** When the mux processes a worker exit and a gate-passing uncommitted deliverable exists in the tree, it MUST commit it before advancing (reuse the #99 R-WCUC commit-before-failing path; #99 owns that behavior — this bundle wires the idle-stall/exit path into it). A completed-but-uncommitted ticket MUST NOT be left for manual recovery. — Type: test
- [ ] **AC-R-MWIS-4 — typecheck + lint clean.** `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1`. — Type: typecheck

## Out of Scope

The no-progress *detector* semantics (#106 R-WMNP) and the gate-passing-commit *behavior* itself (#99 R-WCUC own that). This bundle is specifically the **worker-exit observation + idle-stall watchdog**.

## Notes

Schema-neutral apart from the new `mux_idle_stall_detected` activity event (MINOR). Relates to memory `feedback_pickle_rick_autonomy_north_star`, `feedback_commit_uncommitted_verified_work_before_respawn`, and `project_wmw_auto_skip_near_green_wedge_recovery` (sibling recovery class). Recovery recipe for operators while unshipped: freeze both runners → back up WIP → verify green → commit → mark ticket Done → clear `current_ticket` (deployed StateManager) → relaunch deployed pipeline-runner in tmux.

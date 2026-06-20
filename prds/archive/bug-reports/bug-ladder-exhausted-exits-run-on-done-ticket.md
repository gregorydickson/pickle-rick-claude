# Bug: WMW recovery ladder exits the entire run on an already-Done ticket; citadel handoff missing state.prd_path

**Filed**: 2026-06-11 (babysitter intervention #2, session 2026-06-10-f50e5c11, v2.0.0-beta.1 bundle)
**Severity**: P1 — strands an entire bundle behind one completed ticket; every multi-ticket run is exposed
**Status**: Open

## Incident

Ticket 931c492f (R2 prerelease semver) completed successfully: commit `18322f7b` landed, phantom-Done watcher repeatedly confirmed "kept ticket 931c492f Done — valid completion_commit evidence", tsc clean, new test green. Yet mux-runner exited the whole run at iteration 14:

```
[01:57:24] [observe] worker_artifact_progress_zero: ticket 931c492f produced no new review/conformance artifacts for 3 consecutive spawns
[01:57:25] Phantom-Done watcher kept ticket 931c492f Done — valid completion_commit evidence
[01:59:47] recovery_exhausted: ladder exhausted for 931c492f (ladder_exhausted) at wmw-auto-skip — exiting at iteration 14.
[01:59:47] mux-runner finished. 14 iterations, 34m 17s
```

24 Todo tickets stranded. Two defects:

1. **D1 — ladder counts zero-progress against a Done ticket and exits instead of advancing.** The WMW artifact-progress observer kept attributing "no new review/conformance artifacts" to a ticket whose lifecycle had finished (Done + valid completion_commit). The recovery ladder then exhausted and chose run-exit over ticket-advance. The phantom-Done watcher and the WMW observer evaluated the same ticket with opposite conclusions in the same iterations — the ladder never consulted ticket status/completion evidence before charging the counter or selecting the exit action.
2. **D2 — pickle "completed" handoff leaves citadel unrunnable.** pipeline-runner treated the mux exit as phase-complete (1/4) and started citadel, which immediately failed: `citadel: missing state.prd_path or state.start_commit — failing phase`. `state.start_commit` existed; `state.prd_path` was never set by setup (session created via `--paused` PRD-drafting flow, then resumed; no code path stamps prd_path). Citadel would have failed at the REAL phase boundary too, even after a healthy pickle.

## Recovery applied

- Verified the landed commit independently (tsc + `node --test tests/check-update-prerelease.test.js` green).
- `setup.js --tmux --resume`, then state repair via node script: `prd_path=$SESSION/prd_refined.md`, re-asserted `skip_quality_gates_reason` (resume preserves flags but belt-and-suspenders), `current_ticket` already cleared.
- Relaunched `launch.sh` in tmux. Verified: iteration 16, next ticket 08e75a59 In Progress, 4 workers.
- Contributing shapes noted: 0-byte `worker_session_82620.log` and 157-byte `worker_session_85042.log` in the ticket dir — silent-death exits inflated the zero-progress count. (The H2 ticket 90574654 in this very bundle implements salvage-first handling for exactly this; D1 remains a separate ladder-policy bug.)

## Fix proposal (machine-checkable)

1. **Done-ticket guard in the ladder**: before charging `worker_artifact_progress.zero_progress_count` or executing any ladder rung, re-read ticket frontmatter; status Done with explicit completion_commit → reset the ticket's progress counter, clear current_ticket, ADVANCE to next runnable ticket. Run-exit is reserved for: no runnable tickets remain, or global caps.
2. **Exit-action audit**: `ladder_exhausted` on a per-ticket basis must never terminate the run while ≥1 runnable Todo ticket exists; emit `ticket_ladder_exhausted {ticket}` and advance instead.
3. **prd_path stamping**: setup stamps `state.prd_path` at session creation when a PRD exists (`prd_refined.md` preferred, else `prd.md`), and `--resume` backfills it when missing. Citadel's precondition then holds for any session with a PRD.
4. AC: fixture run with ticket A Done (valid commit) + worker spawns producing zero artifacts → runner advances to ticket B within one iteration, no run-exit; resumed legacy session without prd_path → citadel phase starts.

## Verification of recovery

- mux-runner.log: Iteration 16 started 02:11:01Z, phantom-Done kept 931c492f, current_ticket=08e75a59, 4 claude workers live.

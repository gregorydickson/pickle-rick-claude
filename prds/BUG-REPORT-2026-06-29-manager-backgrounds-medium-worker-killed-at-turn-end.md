# BUG-REPORT 2026-06-29 — R-MWBG: pickle manager backgrounds a medium-tier worker spawn and ends its `-p` turn → worker killed → 0-byte log → pipeline_phase_incomplete

**Code:** R-MWBG (Manager Worker BackGround kill). **Priority:** P1 — blocks autonomous medium-tier bundles (the dominant ticket tier). **Backend:** claude (the pickle manager is `claude -p`). **Discovered:** 2026-06-29, B-SIGF pickle phase, session `2026-06-29-e68fda19`, by the babysitter monitoring the run.

## Incident

B-SIGF (`/pickle-pipeline --scope branch`, backend=claude, 10 tickets). The pickle phase shipped ticket 1 (`6d0892db` → real commit `18f2ccc1`, the shared-detector extraction) then **stalled on ticket 2 `be536995` (medium tier) and exited `pipeline_phase_incomplete` 0/4 at iter 5 / 25m**, leaving 9/10 tickets pending. Babysitter recovered (preserved ticket 1 Done; reset `be536995` → Todo). Logged per the loop-failure directive.

## Root cause (decisive, from the manager's own iteration-5 stream)

The pickle MANAGER is a `claude -p` subprocess (max-turns) running `_pickle-manager-prompt.md`. For `be536995` (medium tier, `worker_timeout=1200s`) the manager reasoned the spawn would exceed the **600s Bash-tool ceiling**, so it **spawned `spawn-morty` via Bash `run_in_background`** (task `bcvgx4h2n`) and then **ended its turn** ("Morty spawned detached … backgrounded to dodge the 600s Bash ceiling … The harness re-invokes me when it completes"). The manager's mental model is the TOP-LEVEL Claude Code agent's (background task → harness re-invokes on completion) — but a **`claude -p` subprocess does not get re-invoked, and a backgrounded child does not survive the `-p` turn ending**. The transcript shows `task_updated bcvgx4h2n status:killed` stamped at the exact manager-turn-end epoch (`1782713965`). The worker was killed before it wrote anything → **two 0-byte `worker_session` logs** (pids 6387 @iter4, 8192 @iter5; the pattern recurred each iteration), **zero artifacts**, **no commit**. The manager then tried to Done-flip `be536995`; `guardCompletionCommitBeforeDone` correctly refused (`done_without_commit_evidence`); the pickle phase exited incomplete → `pipeline_phase_incomplete` 0/4.

**Distinct from [[R-WPEX]]** (detached large-tier worker dies on log-FLUSH with artifacts intact — beta.28 fsync fix). Here the worker never starts: it is REAPED at manager-turn-end because it was a Bash-backgrounded child of a `-p` subprocess. **Distinct from R-WSE-2** (SIGKILL/OOM). The trigger is the manager *choosing to background* a spawn that exceeds the 600s ceiling.

## Why it didn't bite recent clean bundles

B-CWGE/B-APNC/B-RPGT managers built medium tickets **in-process** (the `morty-implementer` subagent path — immune, finishes within the turn) or the worker fit under 600s. This manager instance instead chose detached `spawn-morty` + Bash-background. It is **manager-behavior variance**: the reliable path (in-process) vs the fragile path (Bash-background a `-p` child). The architectural gap underneath: **a medium-tier worker (1200s) exceeds the 600s Bash ceiling, and only LARGE tier has the sanctioned detached-worker lifecycle** (`largeTierDetachedEnabled` / `routeLargeTierTicket` / `state.detached_worker` / `PICKLE_LARGE_TIER_DETACHED`). Medium tier has no ceiling-survival path, so the manager improvises one that dies.

## Fix direction (subtract-before-add; reuse the shipped detached lifecycle)

Two complementary halves, pick the smaller that closes it:
1. **Manager prompt (cheap, reuse):** in `_pickle-manager-prompt.md`, explicitly forbid spawning workers via Bash `run_in_background` (it does not survive a `-p` manager turn); the manager MUST either build in-process via the `morty-implementer` path or hand the ticket to the orchestrator's detached lifecycle. State the `-p`-turn-end-kills-background-tasks fact so a manager never re-derives the broken pattern.
2. **Runtime (the real fix, reuse B-WPEX-AUTO):** extend the detached-worker lifecycle so ANY ticket whose resolved `worker_timeout` exceeds the Bash ceiling — not just `large` tier — routes through `routeLargeTierTicket`/`state.detached_worker` + the orchestrator poll-reattach, instead of a manager Bash call that the manager then backgrounds. This removes the ceiling-vs-timeout tension at its root.

⚠️ **R-PSRB self-modifying-recovery:** half (2) edits the mux-runner worker-spawn lifecycle — a pipeline's own workers run that path, so it must be **hand-built in-process** (or built then `install.sh`-deployed before the rest of the bundle runs), not via a clean autonomous pipeline. Half (1) is a doc/prompt change, buildable normally.

## Concurrent constraint at incident time

The iter-5 stream also carried a `rate_limit_event`: **five_hour utilization 0.95** (surpassed the 0.9 threshold, resets ~2h50m out). The babysitter therefore **did not relaunch** B-SIGF this tick — a relaunch would (a) re-trigger this bug and re-stall, and (b) burn the last 5% of the 5-hour budget. Relaunch is deferred until the rate window has headroom AND half (1) of the fix ships.

## Recovery taken (babysitter, verified)

1. Confirmed `6d0892db` is genuinely Done with real commit `18f2ccc1` (the shared-detector extraction) — preserved.
2. Reset `be536995` frontmatter `In Progress → Todo` (zero progress: 0-byte logs, no artifacts, no commit — nothing to salvage). `current_ticket`/`detached_worker` already null.
3. Did NOT relaunch (rate wall + would re-stall). B-SIGF session left resumable at `2026-06-29-e68fda19`; HEAD `18f2ccc1` (ticket-1 commit, local-only, unpushed — preserved for the eventual closer).

## Severity / priority

**P1.** Blocks autonomous completion of any medium-tier bundle whenever the manager picks the Bash-background path — i.e. non-deterministically but recurrently. The cheap half (manager-prompt forbid) likely removes most occurrences; the runtime half closes it structurally.

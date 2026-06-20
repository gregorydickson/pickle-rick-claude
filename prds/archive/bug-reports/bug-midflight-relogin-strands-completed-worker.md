# Bug: mid-pipeline account re-login hangs an in-flight worker, stranding completed-but-uncommitted work behind an idle mux

**Filed**: 2026-06-11 (babysitter intervention #6, session 2026-06-10-f50e5c11, v2.0.0-beta.1 bundle)
**Severity**: P2 — operator-triggered, but silently strands verified work and idles the pipeline indefinitely with no self-recovery
**Status**: Open

## Incident

Operator switched accounts mid-run (`/login` to a fresh-quota account, then `/model` to Opus 4.8) to escape the B-RLAR rate-limit wall. The pipeline had relaunched cleanly on the new account (iter 51→58). But the H4 worker (pid 26825) spawned at iter 58 (14:55Z) was mid-flight during a subsequent re-login and HUNG:

- Worker process stayed ALIVE 46 min (`ETIME 45:56`) but consumed only 1:40 of CPU at 0.8% — stalled on a dead/re-authed API connection, not working.
- mux-runner + pipeline-runner both pinned at 0.0% CPU; `mux-runner.log` frozen 46 min at "Iteration 58", state.json never advanced.
- The worker had ALREADY completed the full lifecycle before hanging: `research_*.md` (10:09), `research_review.md`, `plan_*.md` (10:11), `plan_review.md`, **`conformance_7eb9fa20.md` (10:39)** — all present in the ticket dir; the working tree held the complete, coherent H4 diff (mux-runner.ts/spawn-morty.ts/pickle-utils.ts/types + schema enum + forward-created test + sibling test updates). It hung in the gap between writing conformance and signaling `<promise>I AM DONE</promise>` / committing.

Net: ~46 min of VERIFIED, gate-green work sat uncommitted behind an idle mux that would never advance on its own. The 0-byte `worker_session_*.log` files (a known late-render artifact) gave no signal either way.

## Recovery applied

1. Distinguished hung-but-alive worker (ETIME≫CPU, mux 0% CPU, log frozen) from a healthy long large-tier ticket via two 55s-spaced samples (no iteration/log advance).
2. Killed worker + mux + pipeline-runner.
3. **Independently re-verified the abandoned work** before trusting it: `tsc --noEmit` clean; `failed-flip-suppression.test.js` 28/28; `runnability-contract-doc-shape.test.js` 0 fail; 5 sibling suites 35 pass/0 fail/2 pre-existing-skip; eslint 0 errors; read `conformance_7eb9fa20.md` (worker self-verdict PASS, 240/240 full AC batch).
4. Committed reset-proof as `9c647ed3` (amended in the load-bearing `activity-events.schema.json` enum addition the H4 code emits); marked ticket Done with explicit `completion_commit: 9c647ed3`.
5. Cleared `current_ticket` + poisoned `worker_artifact_progress`; `setup.js --resume`; relaunched. Iter 59 advanced to e56ed23f (H1). 6/25 Done.

## Fix proposal (machine-checkable)

1. **Worker liveness watchdog by CPU, not just process existence**: the mux idle-stall watchdog (`evaluateMuxIdleStallWatchdog`, `mux-runner.ts:3159`) should treat "child worker alive but <N seconds CPU over >M minutes wall AND no artifact mtime advance" as a stall, not as healthy-because-pid-exists. On trip: run the silent-death salvage path (ticket 90574654's `checkPartialLifecycleExit` policy) — which now EXISTS — to detect the completed-lifecycle case (conformance present) and commit+advance instead of idling.
2. **Conformance-present fast-path**: when a current ticket has a complete artifact set (research/plan/conformance) and a gate-green tree but the worker is unresponsive, the runtime should validate-and-commit rather than wait for the lost `I AM DONE` token. This is the H4-completed-but-hung shape exactly.
3. **Operator guard (docs)**: document that `/login` / `/model` mid-run can strand the active worker; the babysitter recovery recipe (verify-then-commit-then-relaunch) becomes the canonical response and is added to MEMORY.
4. AC: fixture with a complete artifact set + gate-green tree + a worker stub that never emits the done token → watchdog commits the work and advances within one idle-eval cycle; fixture with an INCOMPLETE artifact set + unresponsive worker → does NOT auto-commit (waits / restarts the ticket).

## Verification of recovery

- `9c647ed3` on main (H4 complete: 28/28 + schema enum + non-runnable hold).
- mux-runner.log 15:45:27Z: Iteration 59, current_ticket=e56ed23f, orphan manager 26825 reaped, worker live. 6 Done / 1 In Progress / 18 Todo.

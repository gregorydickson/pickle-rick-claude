# P1 Bug-Fix Bundle — R-WPEX: worker spawns die silently (0-byte logs) — root cause: 600s Bash-tool ceiling SIGKILLs foreground spawn-morty under headless manager

**Finding:** #108 R-WPEX (MASTER_PLAN). **Priority:** P1 (blocks normal worker spawning → every bundle falls back to slow manager-hand-build). **Status: REPRO CAPTURED 2026-06-13 — mechanism confirmed (MASTER_PLAN row 152, session `2026-06-13-2bd4740a`, finding #108): a headless `claude -p` MANAGER cannot hold a >600s (large-tier) worker against the 600s Bash-tool ceiling; the foreground `spawn-morty` is SIGKILLed at 600s → its non-detached worker child dies → buffered stdout lost → 0-byte log. Root cause is NOT spawn-morty dying on its own. The GA fix is the large-tier ROUTING fallback (AC-GA-REC-2, ticket de345802); the exit-drain ACs (AC-R-WPEX-1/2/3) are demoted to post-GA conditional.**
**Source:** Live babysitting, B-WMNP #106 build, session `2026-06-08-f5131cfa`, 2026-06-09.

## Observed symptom

During the B-WMNP #106 build (the FIRST bundle to run on the freshly-deployed **v1.105.0** runtime), every `claude -p` WORKER spawn died **silently**: `worker_session_<pid>.log` 0 bytes, **zero lifecycle artifacts** (no research/plan), git tree clean, each worker process ran ~3–4 min then exited. After 5 no-progress iterations the circuit breaker tripped (`circuit_open`). The mux MANAGER (mux-runner's own claude invocation) worked **fine** — it diagnosed the silent workers and **hand-built all 4 tickets itself** (R-ORSR ladder), which is how B-WMNP shipped (v1.105.1).

Discriminators observed:
- Worker-spawn-specific: the manager's claude calls succeeded; only `spawn-morty.js → claude -p` worker spawns produced nothing.
- Started exactly at the **v1.105.0 deploy** (R-MWIS idle-stall fix). The prior bundle (R-MWIS, built on the pre-v1.105.0 runtime) had healthy workers.
- `spawn_stdout.log` showed spawn-morty.js ran (banner + "ticket → In Progress"), so spawn-morty started and spawned claude; the 0-byte `worker_session` means **claude produced nothing** before exit.

## Confirmed root cause (captured 2026-06-13, session `2026-06-13-2bd4740a`, MASTER_PLAN row 152)

The captured repro identified the **600s Bash-tool manager ceiling**, NOT spawn-morty output
truncation: a headless `claude -p` MANAGER cannot hold a >600s (large-tier) worker. The foreground
`spawn-morty` path is SIGKILLed at 600s → its non-detached worker child dies → buffered stdout is lost
→ 0-byte log. (The bg-task + Monitor improvisation fares no better: the headless `-p` manager EXITS once
it stops calling tools, reaping the worker at ~3–4 min.) The GA fix is the large-tier ROUTING fallback
(`routeLargeTierTicket`, AC-GA-REC-2, ticket de345802) — route large-tier tickets to interactive
`/pickle-tmux` (a persistent-REPL manager that survives the turn-end ceiling) instead of a raw foreground
`spawn-morty`. The two pre-repro candidates below are retained for the record but are superseded.

### Pre-repro candidates (SUPERSEDED — retained for history, do not fix speculatively)

1. **v1.105.0 R-MWIS regression** (`b63bd763`): `proc.on('exit')` + `EXIT_DRAIN_FALLBACK_MS=250` made process-exit the PRIMARY worker-completion signal. **However**, static review shows a `settled` single-resolution guard and `'close'` short-circuiting the 250ms `'exit'` path in the healthy case — so a premature-resolve/truncation is **not obviously present**. The mux's `proc` is the **spawn-morty.js** subprocess (not claude directly); spawn-morty.js spawns claude at `spawn-morty.ts:1710` (`stdio:['inherit','pipe','pipe']`). For this to be the cause, spawn-morty.js's `'exit'` would have to fire + finalize before claude's piped output reaches the worker_session log.
2. **Environmental / transient load**: this session ran 3 bundles + many background test suites (test:fast ~5800 tests ×3, integration, expensive) over ~7 hours; the rapid worker `claude -p` spawns may have been starved/failed for capacity. The manager (fewer calls) survived.

## Repro plan (REQUIRED before any fix)

Launch the next bundle (or a minimal `spawn-morty.js` invocation) on the current v1.105.1 runtime and observe the worker:
- If workers STILL die silently (0-byte `worker_session`, zero artifacts) with the system otherwise idle → **confirms a code regression** (candidate 1). Proceed to the fix.
- If workers produce normal output → it was transient load (candidate 2); close #108 as not-reproducible, keep the hand-build fallback documented.

## Acceptance Criteria — post-GA conditional (exit-drain, NOT required for GA)

The following ACs (AC-R-WPEX-1/2/3) describe the exit-drain fix (candidate 1 from the original,
pre-repro hypothesis). The captured repro (finding #108, MASTER_PLAN row 152) identified a DIFFERENT root
cause — the 600s Bash-tool manager ceiling, not spawn-morty output truncation. These ACs are therefore
demoted: they are explicitly **post-GA**, conditional, and do NOT gate GA. The GA fix is the large-tier
routing fallback (AC-GA-REC-2, ticket de345802, `routeLargeTierTicket`).

- [ ] **(post-GA conditional) AC-R-WPEX-1 — a healthy worker is never finalized before its output is captured.** A real (non-scripted) `claude -p` worker that produces output MUST have that output present in `worker_session_<pid>.log` and its lifecycle artifacts on disk before the mux finalizes the iteration. The exit-primary completion path MUST NOT truncate a healthy worker's piped output (e.g. keep `'close'` as the primary completion signal, with an `'exit'`+LONG-timeout fallback — 30–60s, configurable — solely to preserve the R-MWIS no-hang guarantee on a genuinely silent exit; NOT 250ms). — Type: test (real-worker, not scripted)
- [ ] **AC-R-WPEX-2 — R-MWIS no-hang preserved.** A genuinely silent 0-byte worker exit still finalizes within the bounded fallback window (no 0%-CPU hang). The `mux-silent-worker-exit.test.js` invariant stays green. — Type: test
- [ ] **AC-R-WPEX-3 — typecheck + lint clean.** — Type: typecheck

## Out of Scope

The R-MWIS idle-stall fix's intent (process-exit as a no-hang backstop) is CORRECT and must be preserved — this is about not letting the backstop's *short* drain truncate healthy workers.

## Notes

Workaround while unfixed: the mux MANAGER hand-builds tickets when workers die silently (functional but slow; R-ORSR ladder). Relates to memory `project_mux_worker_exit_idle_stall_recovery` (the R-MWIS fix this may regress) and `feedback_loop_failure_log_bug_prd_and_master_plan`.

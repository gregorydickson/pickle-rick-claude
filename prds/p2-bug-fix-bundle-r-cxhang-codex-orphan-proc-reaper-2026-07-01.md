---
r_code: R-CXHANG
priority: P2
status: Todo
source_bug_report: prds/MASTER_PLAN.md (B-SIGFH codex GA soak findings, 2026-07-01)
bundle_thesis: >
  Codex worker procs from crashed/force-killed sessions orphan and accumulate across days
  (R-SLEAK amplified on codex, which hangs on network I/O and never self-exits) until they
  saturate the machine and starve new pipelines. The existing negative-PID subtree reap only runs
  on CLEAN teardown/timeout. Add a setup-time (and periodic) orphan-worker reaper that REUSES that
  reap primitive to clear procs no live pickle session owns. Reliability fix (codex-GA blocker),
  not a feature.
---

# R-CXHANG — codex orphaned-worker-proc reaper (session-GC, reuse-first)

## Problem

During the B-SIGFH codex GA soak (2026-07-01), **8 codex worker processes from prior days' runs
(ages 16h–2 days) survived their sessions as orphans, saturated the machine, and starved the active
pipeline's workers into 0-byte hangs — this killed run 1.** Only an operator `kill -9` cleared them
(they were network-I/O-blocked, so my sandbox couldn't reap them, but a real shell could — they were
NOT truly unkillable). This is the **R-SLEAK class** ("leaked orphan runners persist for days;
session-GC unbuilt" — see [[project_wpex_worker_silent_death_monitor]] / R-SLEAK drain row),
amplified on codex because `codex exec` blocks on OpenAI-API reads that can hang indefinitely, so a
codex worker does not self-exit when its session dies.

**Why the existing reap misses them (verified in the spawn/reap code):** workers ARE spawned
`detached` to lead their own process group (`spawn-morty.ts:2105`, `backend-spawn.ts:770`), and
timeout/teardown reap the whole group via `process.kill(-pid, sig)`
(`spawn-morty.ts:975 killProcessTree` / `:2124`, `pipeline-runner.ts:1073 reapChildSubtree`, R-OMTD).
**But that reap only runs on CLEAN teardown or a worker timeout.** When a session crashes, is
SIGKILL'd at the harness 600s ceiling without a graceful shutdown, or is force-killed by an operator
freeze, no teardown runs — the detached codex group re-parents to PID 1 and lingers. Across many
such sessions over days, orphans accumulate with nothing to collect them.

## Current state (do NOT rebuild — REUSE)

- `spawn-morty.ts:975 killProcessTree(proc, signal)` — negative-PID group kill + leader fallback. **REUSE.**
- `pipeline-runner.ts:1073 reapChildSubtree(child, leadsGroup, signal)` — R-OMTD subtree reap. **REUSE.**
- Workers/codex already spawn `detached` (own process group) — the reap primitive works; it just
  isn't *invoked* for orphans-from-crashed-sessions. **Do NOT change the spawn/detach model.**
- `state-manager.ts:isProcessAlive`, `StateManager.read()`, `pickle-utils.ts` session-liveness
  helpers (dead-pid demotion, `recoverStaleActiveFlag`) — **REUSE** to decide "no live session owns this."
- The SIGTERM→SIGKILL escalation in `spawn-morty.ts` (`killEscalation`) — **REUSE** the escalation shape.

## Simplification Review (subtract-before-add)

- **Is the addition necessary?** Yes — a genuine reliability defect that killed a run and blocks codex
  GA; there is no existing collector for orphans-from-crashed-sessions. This is the ONE case where
  adding (a thin GC) beats subtracting, because the missing collector *is* the bug.
- **Reuse not add?** Almost entirely reuse: the GC is a thin scan that calls the EXISTING
  `killProcessTree` / `reapChildSubtree` negative-PID reap + the EXISTING session-liveness readers.
  It adds one bounded helper + one activity event, not a new subsystem.
- **Guards existing brittle complexity?** No — it collects leaked resources; it does not gate or
  wrap a brittle guard. It is the R-SLEAK "session-GC" the drain queue already deferred.
- **Subtracts?** It removes the standing operator-kill/reboot workaround and the cross-session
  contention class. No state field or schema change (no bump).

## Interface Contracts

**New reaper (WS-1)** — `reapOrphanedWorkerProcs(opts?): { scanned: number; reaped: number }` (home:
`services/pickle-utils.ts` or a small `services/orphan-reaper.ts`). Enumerates worker procs (codex
vendor binary `codex-darwin-arm64/**/bin/codex` AND `claude -p` worker spawns), classifies each as
ORPHANED when it is not owned by any live pickle session (owning session `active:false`/missing, OR
re-parented to PID 1 / dead parent), and reaps ORPHANED procs via the existing negative-PID group
kill with SIGTERM→SIGKILL escalation. MUST NOT reap a proc owned by a live session (positive
ownership required before any kill). Emits `worker_orphan_reaped` per reap. Bounded wall-budget; safe
no-op on win32 (no process groups). Kill-switch env `PICKLE_ORPHAN_REAP=off`.

## Workstreams & acceptance criteria

### WS-1 — Setup-time orphan-worker reaper (the core fix)
- **AC-CXHANG-1**: `reapOrphanedWorkerProcs` reaps a codex/worker proc whose owning session is
  `active:false` or whose parent is dead/PID-1, and returns `{scanned, reaped}`; it MUST NOT reap a
  proc whose owning session is `active:true` with a live pid. Verify: a unit test with a fake proc
  table + fake session states asserts orphan reaped, live-session proc spared (inject the proc-lister
  + killer so no real processes are touched).
- **AC-CXHANG-2**: the reaper is invoked once at pipeline bootstrap in `setup.ts` (before the first
  worker spawn), best-effort (a reaper throw never blocks launch), logging `{scanned, reaped}`.
  Verify: `grep -q reapOrphanedWorkerProcs extension/src/bin/setup.ts`; a setup test asserts the call
  fires and a reaper exception is swallowed.
- **AC-CXHANG-3**: reaping REUSES the existing negative-PID primitive — no new kill implementation.
  Verify: the reaper calls `killProcessTree`/`reapChildSubtree` (or a shared extraction of it); a
  trap-door/grep asserts no second `process.kill(-` implementation is introduced.
- **AC-CXHANG-4**: `PICKLE_ORPHAN_REAP=off` makes the reaper an inert no-op (no scan, no kill).
  Verify: unit test with the env set asserts `{scanned:0, reaped:0}` and no killer invocation.

### WS-2 — Guarantee the timeout/teardown reap escalates to SIGKILL on a stuck codex group
- **AC-CXHANG-5**: when a codex worker ignores SIGTERM (network-blocked), the existing kill path
  escalates to `SIGKILL` on the process GROUP within the documented grace window (it does not leave
  the group on SIGTERM alone). Verify: a test drives `killProcessTree` against a mock proc that
  ignores SIGTERM and asserts a subsequent `process.kill(-pid, 'SIGKILL')`. (If already guaranteed,
  this AC is a characterization test pinning it; no code change.)
- **AC-CXHANG-6**: teardown/freeze paths (`pipeline-runner` shutdown handlers, mux-runner forensic
  exits) reap the worker subtree even on the abnormal-exit path — a session killed without clean
  teardown still collects its group on the NEXT setup via WS-1. Verify: an integration test that
  spawns a detached sleeper, abandons it (no teardown), then runs WS-1's reaper and asserts it's
  collected.

### Closer ticket
- **AC-CXHANG-CLOSER**: full local release gate green; compiled JS matches TS; version bumped (PATCH
  — additive reliability helper, no user-facing surface change) to the next beta; `install.sh`
  deployed (when no concurrent session blocks it); `git push` + `gh release`; MASTER_PLAN R-CXHANG
  row → SHIPPED (and note it closes the R-SLEAK session-GC gap); PRD archived.

## Trap-door obligations
- The reaper MUST require POSITIVE ownership proof before any kill — never reap a proc a live session
  owns (false-reap of an active worker is worse than a leaked orphan). Pin with a test asserting a
  live-session proc is spared.
- No second negative-PID kill implementation — reuse `killProcessTree`/`reapChildSubtree`.
- No state-schema change / `LATEST_SCHEMA_VERSION` bump.

## Non-goals
- Fixing codex's underlying network-I/O hang (upstream `codex exec` behavior — out of our control).
- A always-on background daemon/watchdog process (setup-time + teardown invocation is sufficient;
  a persistent poller is new machinery this bundle deliberately avoids — revisit only if orphans
  still accumulate WITHIN a single long session).
- Changing the detached-spawn / process-group model (it is correct; the gap is invocation coverage).

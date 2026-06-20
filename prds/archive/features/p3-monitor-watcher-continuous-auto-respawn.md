---
title: P3 — Monitor watcher panes need continuous auto-respawn (not iteration-boundary-only)
status: Draft
date: 2026-05-04
priority: P3
type: enhancement
peer_prds:
  related:
    - prds/archive/bug-reports/pipeline-state-desync-and-pane-respawn-tmpdir.md   # SHIPPED — original `restartDeadWatcherPanes` impl + pane-respawn tmpdir invariant
    - prds/archive/bug-reports/p1-iteration-cap-and-phantom-done-handshake.md     # context — long iterations make this gap more visible
---

# PRD — Monitor watcher panes need continuous auto-respawn

## Symptoms

Reliability-bundle session `2026-05-03-7d9ee8cc` (claude backend, ~20-25 min per iteration):

- Pane 0 (`monitor.js`) — alive, refreshing every 2s
- Pane 1 (`log-watcher.js`) — **◤ FEED TERMINATED ◢** + shell prompt
- Pane 2 (`morty-watcher.js`) — **◤ FEED TERMINATED ◢** + shell prompt
- Pane 3 (`raw-morty.js`) — **◤ FEED TERMINATED ◢** + shell prompt

Last-visible output before termination on pane 1 and pane 3 included repeated codex usage-limit error lines. Panes self-revived on the next iteration boundary (next `ensureMonitorWindow` call), but stayed dead for the duration of the in-progress iteration (~20+ minutes of opaque progress for the operator).

## Why this is distinct from the existing `restartDeadWatcherPanes` work

`restartDeadWatcherPanes` (committed via `prds/archive/bug-reports/pipeline-state-desync-and-pane-respawn-tmpdir.md`) handles the case where a pane's command is no longer `node` — and the trap-door invariant in `extension/CLAUDE.md` enforces that. **It works.** But it's call-site-driven, fired only at:

- `pipeline-runner.ts:1314` — phase boundary (citadel → anatomy-park → szechuan-sauce)
- `mux-runner.ts:2296` — manager-loop iteration boundary
- `microverse-runner.ts:2162` — microverse startup

Per-ticket iterations on claude backend run 20-25 minutes. Per-phase boundaries are minutes-to-hours apart. **There is no within-iteration watchdog.** A watcher that dies at minute 1 of a 25-minute iteration leaves three blank panes for 24 minutes.

## Root cause

Two independent contributors:

| # | Cause | Fix surface |
|---|---|---|
| **A** | `ensureMonitorWindow` is invoked only on iteration/phase boundaries — not on a continuous timer. | Add a watchdog timer to `monitor.js` (the dashboard pane is already long-lived) that polls sibling panes every 30s and calls `restartDeadWatcherPanes` when needed. |
| **B** | Watchers themselves exit on transient stream conditions (EOF on a tailed file that gets rotated/recreated, downstream stdin EOF, etc.) — they should self-recover. The `restartDeadWatcherPanes` log line we observed when pane content showed `FEED TERMINATED` confirms the watcher process exited cleanly back to shell, not crashed. | `tailFile` / `processLine` in `log-watcher.ts`, `morty-watcher.ts`, `raw-morty.ts`, `refinement-watcher.ts` should treat EOF as transient: keep polling for new bytes/file rotations rather than printing `FEED TERMINATED` and exiting. |

Either fix alone closes the operator-visible gap. Both together make the watcher subsystem robust.

## Reproducer

1. Launch any `pickle-tmux` session with monitor window.
2. In any watcher pane, send `q`/`Ctrl+C` (or wait for a real stream-EOF condition).
3. Observe `◤ FEED TERMINATED ◢` plus shell prompt persists until the next iteration boundary.
4. Pane self-revives on next `ensureMonitorWindow` call (verified — works as designed).

Expected with this PRD: dead watcher pane respawns within 30s regardless of iteration phase.

## Scope

**In scope:**
- Continuous watchdog timer inside `monitor.js` (the only always-running pane in the monitor window).
- Watcher self-resilience for `log-watcher.ts`, `morty-watcher.ts`, `raw-morty.ts`, `refinement-watcher.ts`: do not exit on stream EOF; treat target file/stream re-creation as expected.

**Out of scope:**
- Adding new monitor pane types or layouts (separate concern).
- Changing the `restartDeadWatcherPanes` algorithm itself — it correctly skips active `node` panes per the existing invariant; only the call frequency changes.
- Pane 0 (`monitor.js`) self-supervision — if the dashboard dies, the whole window is in trouble; that's a separate pickle.

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| **R-MWR-1** | `monitor.ts` runs a watchdog timer every 30s that calls `restartDeadWatcherPanes(sessionDir, extensionRoot, 'pickle' \| inferMonitorMode())` for the current monitor window. Timer is best-effort: any thrown error logs to stderr and is swallowed (must not crash the dashboard render). | P0 |
| **R-MWR-2** | Watchdog is disabled when `process.env.PICKLE_MONITOR_WATCHDOG === 'off'` (kill-switch for tests and edge-case debugging). | P1 |
| **R-MWR-3** | Watchdog logs each respawn decision to `mux-runner.log` via `appendWatcherRestartLog` (already-public helper), tagged `monitor-watchdog:` to distinguish from boundary-driven respawns. | P0 |
| **R-MWR-4** | `log-watcher.ts`, `morty-watcher.ts`, `raw-morty.ts` do NOT exit on EOF of the target file. They poll for size growth or file re-creation indefinitely until liveness probe (`StateManager.read()` per existing trap-door invariants) reports session inactive — which is the existing exit condition and remains unchanged. | P0 |
| **R-MWR-5** | `refinement-watcher.ts` follows the same EOF behavior as R-MWR-4 for refinement-manifest log files. | P1 |
| **R-MWR-6** | The `◤ FEED TERMINATED ◢` banner is reserved for explicit liveness-probe inactive exit, never EOF. EOF prints (at most) a single dim status line `(reconnecting...)` and continues polling. | P1 |
| **R-MWR-7** | Regression test covering R-MWR-1: simulate a dead watcher pane (mocked tmux probe returning non-`node`), advance fake timer 30s, assert respawn invoked exactly once. Anchors in `extension/tests/monitor-watchdog.test.js` (new). | P0 |
| **R-MWR-8** | Regression test covering R-MWR-4: synthesize a tailed log file, write content, truncate, write more content. Assert watcher process stays alive across truncate and consumes the post-truncate content. Anchors in `extension/tests/log-watcher.test.js` (extend). | P0 |

## Acceptance Criteria

- **AC-MWR-01** — `extension/src/bin/monitor.ts` registers a 30s `setInterval` that calls `restartDeadWatcherPanes`. Verified by `extension/tests/monitor-watchdog.test.js`.
- **AC-MWR-02** — Killing pane 1, 2, or 3 mid-iteration during a live `pickle-tmux` run results in respawn within 60s (worst-case = one full poll cycle plus tmux probe latency). Verified via integration test or smoke run notes appended to this PRD.
- **AC-MWR-03** — All four watchers (`log-watcher`, `morty-watcher`, `raw-morty`, `refinement-watcher`) survive `truncate -s 0` of their target log file. Verified by extending each watcher's existing test.
- **AC-MWR-04** — `PICKLE_MONITOR_WATCHDOG=off` disables the timer (smoke test + unit test).
- **AC-MWR-05** — `mux-runner.log` shows `monitor-watchdog: respawned <name> in pane <N>` lines distinguishable from boundary-driven `restartDeadWatcherPanes:` lines.
- **AC-MWR-06** — Trap door added to `extension/CLAUDE.md`: `src/bin/monitor.ts` (watchdog) — INVARIANT: dashboard registers a continuous 30s watchdog that calls `restartDeadWatcherPanes`; watchdog errors are swallowed and never crash the dashboard render. ENFORCE: `extension/tests/monitor-watchdog.test.js`.
- **AC-MWR-07** — Trap door extended for each watcher: `src/bin/<watcher>.ts` (EOF resilience) — INVARIANT: tailed file EOF is transient; only liveness-probe inactive triggers `FEED TERMINATED` exit. ENFORCE: corresponding test file.

## Implementation Sketch

### R-MWR-1..3 (watchdog inside monitor.ts)

```ts
// In monitor.ts, after the dashboard render loop is established:
if (process.env.PICKLE_MONITOR_WATCHDOG !== 'off') {
  const sessionDir = /* already known */;
  const extensionRoot = getExtensionRoot();
  const mode = inferMonitorMode(sessionDir);
  setInterval(() => {
    try {
      const respawned = restartDeadWatcherPanes(sessionDir, extensionRoot, mode);
      if (respawned.length > 0) {
        appendWatcherRestartLog(sessionDir, `monitor-watchdog: respawned ${respawned.join(', ')}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[monitor-watchdog] swallowed: ${msg}\n`);
    }
  }, 30_000).unref();
}
```

`.unref()` is mandatory — the timer must not keep the process alive past the dashboard's natural exit conditions.

### R-MWR-4..6 (watcher EOF resilience)

In each watcher's tail loop, replace any `if (no new bytes since last poll) { print FEED TERMINATED; exit }` with: continue polling. The only exit path remains `liveness probe → state inactive`.

## Open questions

1. Should the 30s poll interval be configurable via `pickle_settings.json` (`monitor_watchdog_interval_ms`)? Recommendation: hardcode for now, refactor only if a real use case appears.
2. Does a respawn-storm need rate-limiting (e.g., if a watcher keeps dying every poll cycle due to a real bug)? Recommendation: detect ≥3 consecutive respawns of the same pane in 5 minutes, log a `monitor-watchdog: respawn-storm pane=<N>` event, and stop respawning that pane until the next iteration boundary. Add as R-MWR-9 if needed in refinement.

## Workaround until shipped

None needed at user-action level — `ensureMonitorWindow` will respawn dead panes at the next iteration boundary (already happened on session `2026-05-03-7d9ee8cc`). Manual respawn:

```bash
SESSION_DIR=~/.local/share/pickle-rick/sessions/<date-hash>
BIN=$HOME/.claude/pickle-rick/extension/bin
tmux send-keys -t pipeline-<hash>:1.1 "node $BIN/log-watcher.js $SESSION_DIR" Enter
tmux send-keys -t pipeline-<hash>:1.2 "node $BIN/morty-watcher.js $SESSION_DIR" Enter
tmux send-keys -t pipeline-<hash>:1.3 "node $BIN/raw-morty.js $SESSION_DIR" Enter
```

# PRD: Watcher Pane Recovery on Mux-Runner Relaunch

**Status**: Draft (2026-04-28)
**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension. tmux orchestrator with a 4-pane monitor window per session.
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`.
**Discovered**: during god-fn epic codex run on session `2026-04-25-9152e64b`. After mux-runner exited at the 4h hang-guard mark and was relaunched (manually or via the new codex_manager_relaunch path in `bf4a002`), only the dashboard pane (`monitor.js`) survived. The other three watcher panes had exited to a `zsh` prompt on the `state.active: false` snapshot and stayed dead even after the new mux-runner brought the session back live.

---

## Problem

The 4-pane monitor window is created once by `ensureMonitorWindow()` (in `extension/src/services/pickle-utils.ts:867+`) on initial pipeline-runner launch. The default `pickle` layout populates panes via `extension/scripts/tmux-monitor.sh`:

| Pane | Watcher | Purpose |
|---|---|---|
| 0 (top-left) | `monitor.js` | Ticket dashboard, phase, iteration, CB state |
| 1 (top-right) | `log-watcher.js` | Iteration NDJSON event stream |
| 2 (bottom-left) | `morty-watcher.js` (or `refinement-watcher.js` in refine mode) | Live worker output |
| 3 (bottom-right) | `raw-morty.js` | Raw worker stdout |

Per the trap-door catalog in `extension/CLAUDE.md`, `log-watcher`, `morty-watcher`, and `raw-morty` all read session liveness via `StateManager.read()`. When `state.active === false`, they self-terminate cleanly so a crashed/exited session doesn't tail forever. **That part works.**

The gap: when a *new* mux-runner takes session ownership and flips `state.active` back to `true` — either via:

- User-initiated relaunch (`node pipeline-runner.js <session>`)
- The codex-manager auto-relaunch path added in `bf4a002` (≤5 retries on subprocess error)
- Pipeline-runner advancing from phase 1 → 2 → 3

…the dead watcher panes remain at `zsh` prompts. The dashboard (`monitor.js`) survives because it's the always-on meta-watcher; the other three never get respawned.

**User-visible symptom**: monitor window looks alive but 3 of 4 panes are stale. User has to either manually `tmux send-keys` the relaunch commands per pane, kill the whole pipeline and restart, or spin a new tmux session.

**Reproducer**: kill any active pickle-tmux session mid-run, then relaunch via `pipeline-runner.js`. The 4-pane window persists from the old run; only `monitor.js` is alive.

---

## Root Cause

`ensureMonitorWindow()` is **first-launch-only**. It checks whether the `monitor` window exists; if so, it logs `"monitor window already exists"` and returns without inspecting individual pane state. There's no `restartDeadWatcherPanes()` helper, and mux-runner doesn't call any equivalent on session-ownership-claim.

Specifically (today's behavior):
- Watcher exits cleanly when it sees `state.active: false` → leaves a `zsh` prompt in the pane.
- New mux-runner takes ownership → calls `ensureMonitorWindow()` → sees existing window → no-op.
- Watcher panes remain dead until manual intervention.

The trap-door invariants for the watcher scripts (in `extension/CLAUDE.md`) document the exit-on-inactive-state behavior as correct. The complementary respawn-on-active-state behavior was never wired up.

---

## Solution

Make `ensureMonitorWindow()` idempotent at the **pane level**, not the **window level**. When the window already exists, inspect each pane's current command and respawn dead watchers via `tmux send-keys` using the same command line that `tmux-monitor.sh` would have used on first launch.

A pane is "dead" when its `pane_current_command` is a shell (e.g. `zsh`, `bash`) instead of `node`. Detecting that with `tmux display-message -p -t <session>:monitor.<n> "#{pane_current_command}"` is straightforward.

The respawn must be backend/mode-aware: `pickle` mode uses `morty-watcher.js` in pane 2, `refine` mode swaps in `refinement-watcher.js`. The mode is already selected by `inferMonitorMode()` in pickle-utils.ts and used by tmux-monitor.sh; the new helper consults the same source.

---

## Acceptance Criteria

- **AC-WPR-01** Calling `ensureMonitorWindow()` on a session with a pre-existing monitor window where panes 1, 2, 3 are at a shell prompt and `state.active: true` → those three panes are respawned with `log-watcher.js`, `morty-watcher.js` (or `refinement-watcher.js` per mode), and `raw-morty.js` respectively.
- **AC-WPR-02** Calling `ensureMonitorWindow()` on a session with all 4 panes alive → no-op (no duplicate watcher spawns; no `tmux send-keys` invocations).
- **AC-WPR-03** Calling `ensureMonitorWindow()` on a session with `state.active: false` → no respawn (preserves the watcher self-termination contract; respawn only fires when the session is actually live again).
- **AC-WPR-04** When mux-runner takes session ownership (sets `state.active: true` and stamps `pid = process.pid`), it calls `ensureMonitorWindow()` exactly once. Existing call in `pipeline-runner` start path should also reach this fix on phase transitions; verify no double-call.
- **AC-WPR-05** When pipeline-runner advances phase (pickle → anatomy-park → szechuan-sauce), each phase's runner takes ownership and triggers a fresh pane-recovery sweep so the watcher panes follow phase transitions.
- **AC-WPR-06** Detection method: `pane_current_command !== 'node'` is the dead-pane heuristic. Other long-running processes (e.g. `vim`, `less`) on a watcher pane are unexpected; treat them as dead and respawn (logged as `WARN`).
- **AC-WPR-07** Mode selection (`pickle` vs `refine` vs `meeseeks`/`council`) honors `inferMonitorMode(state)` so refinement-watcher fires correctly during PRD refinement reruns.

## Non-goals

- Recovering dead `monitor.js` (pane 0). It's the meta-watcher and shouldn't die; if it does, the tmux session is already in worse shape than this fix can address.
- Recreating the entire monitor window (which `ensureMonitorWindow` already handles for the not-yet-created case).
- Adding a periodic poll loop. Recovery fires on session-ownership claim only; no background polling.

---

## Atomic Tickets

### T1 — Pane-level dead-watcher detection + respawn helper

Add `restartDeadWatcherPanes(sessionDir, extensionRoot, mode)` to `extension/src/services/pickle-utils.ts`. Inputs: session dir (for arg threading), extension root (for `bin/*.js` paths), mode (`'pickle' | 'refine' | 'meeseeks' | 'council'`). For each of panes 1, 2, 3:

1. Read `pane_current_command` via `tmux display-message -p`.
2. If not `'node'`, derive the appropriate watcher command from the mode (mirror tmux-monitor.sh's switch).
3. Send via `tmux send-keys -t <session>:monitor.<n> '<cmd>' Enter`.
4. Log to runner log: `restartDeadWatcherPanes: respawned <watcher-name> in pane <n>`.

If the monitor window doesn't exist, fall through to the existing `ensureMonitorWindow` create path. If `state.active === false`, return early without respawn.

### T2 — Wire restart into ensureMonitorWindow

Change `ensureMonitorWindow()`'s "already exists" branch from log-and-return to log-and-call-`restartDeadWatcherPanes()`. The function stays single-public-entry-point for callers (mux-runner, microverse-runner, pipeline-runner all already invoke it).

### T3 — Regression test in `ensure-monitor-window.test.js`

Three new test cases:

- Pre-existing window, dead panes 1/2/3, active state → respawn fires for all three with mode-correct commands. Use `spawnSyncFn` seam to capture the `tmux send-keys` invocations.
- Pre-existing window, all panes alive (commands are `node`) → no respawn.
- Pre-existing window, dead panes, but `state.active: false` → no respawn (preserves watcher self-termination contract).

Cover all three modes (`pickle`, `refine`, `meeseeks`).

### T4 — Documentation: trap-door entry

Add an INVARIANT entry to `extension/CLAUDE.md` for `pickle-utils.ts: restartDeadWatcherPanes` documenting:

- BREAKS: monitor window has stale watcher panes for the rest of the pipeline lifetime; user has to manually relaunch each watcher.
- ENFORCE: the three regression tests in T3.

---

## Verification Plan

1. **Reproducer first**: launch a fresh `pickle-tmux` run, kill mux-runner mid-iteration, relaunch via `pipeline-runner.js <session>`. Confirm without the fix: 3 panes show `zsh` prompts. Apply fix, redeploy, repeat: expect all 3 panes to respawn watchers.
2. **Phase transition test**: run a `pickle-pipeline` end-to-end. As phase 1 → 2 → 3 transitions happen, each transition flips active off then back on; watchers should follow.
3. **Mode test**: run `pickle-refine-prd`. Pane 2 should host `refinement-watcher.js`, not `morty-watcher.js`.
4. **No-op test**: launch fresh, all panes alive from initial create; ensureMonitorWindow on second call (e.g. resume) should not spawn anything new — verify via `tmux list-panes -F "#{pane_current_command}"`.

---

## Files Likely Touched

```
extension/src/services/pickle-utils.ts          # add restartDeadWatcherPanes; wire into ensureMonitorWindow
extension/scripts/tmux-monitor.sh               # if helper logic is shared, refactor to single source of truth
extension/tests/ensure-monitor-window.test.js   # T3 regression cases
extension/CLAUDE.md                             # T4 trap-door entry
```

---

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | tmux send-keys races with shell prompt rendering, dropping characters | Use `-l` literal mode + `Enter` separately; same pattern as `tmux-monitor.sh` |
| R2 | Mode misdetection respawns wrong watcher (e.g. morty-watcher in refine mode) | T3 explicitly covers all three modes; `inferMonitorMode()` is single source of truth |
| R3 | Multiple ownership-claims trigger duplicate restarts | Idempotency check (pane_current_command === 'node') before respawn — AC-WPR-02 |
| R4 | Long-running tool in a pane (`vim`, `less`) interpreted as alive watcher when it isn't a watcher at all | Acceptable: treat anything other than `node` as dead and respawn (AC-WPR-06). Pane-name check could be added later but not in scope |
| R5 | Respawn fires while the previous watcher is still in its own SIGINT cleanup path | Watchers exit on inactive state without lingering subprocesses; the shell prompt is the post-exit state. No race observed in the manual repro |

---

## Linked context

Discovered during the god-function refactor epic codex run (session `2026-04-25-9152e64b`). The relaunch path was added by commit `bf4a002` (codex-manager auto-relaunch on subprocess error) — this PRD closes a follow-up gap that bf4a002 surfaced: relaunching the *runner* without relaunching the *monitor*.

Related trap-doors already documented in `extension/CLAUDE.md`:
- `src/bin/log-watcher.ts` — exit-on-inactive invariant (correct behavior)
- `src/bin/morty-watcher.ts` — same
- `src/bin/raw-morty.ts` — same
- `src/services/pickle-utils.ts` `inferMonitorMode()` — orphan-tmp monitor mode recovery

This PRD adds the inverse contract: when active comes back, panes recover.

---
title: P3 — monitor 4-pane window collapses to 2 on iteration 1; watchdog cannot repair (R-MWR layout-fragility + R-MDS-class mode-mismatch crash, compound)
status: Draft
filed: 2026-05-13
priority: P3 (cosmetic — iteration loop is unaffected; operator loses visibility)
type: bug
related:
  - prds/archive/features/p3-monitor-watcher-continuous-auto-respawn.md   # R-MWR — shipped via `ed6a58e3` family. This PRD extends it: the continuous watchdog cannot repair a *collapsed* layout, only relaunch into surviving panes.
  - prds/p3-monitor-dashboard-stale-after-pickle-to-anatomy-park-transition.md   # R-MDS, Finding #15 — same class of mode-mismatch crash. R-MDS focuses on pickle→anatomy transitions. This PRD adds a new trigger: szechuan-sauce sessions spawned with `mode=pickle`.
  - prds/archive/bug-reports/p3-mux-runner-monitor-respawn-uses-temp-dir-not-session-root.md   # R-MMRT, Finding #27 — adjacent monitor-respawn pathing bug. Codex-specific per its PRD; not the trigger here, but lives in the same surface.
---

# P3 — monitor 4-pane window collapses to 2 on iteration 1; watchdog cannot repair

## Problem (one paragraph)

A fresh szechuan-sauce session (`2026-05-13-db129229`, `--backend claude`, target `loanlight-api/packages/api/src/lib/appraisal-pipeline`) was launched with the standard 4-pane monitor. Within the first 30 seconds — before the in-monitor respawn watchdog's `setInterval(tick, 30_000)` could fire even once — all 4 monitor node processes (`monitor.js`, `log-watcher.js`, `morty-watcher.js`, `raw-morty.js`) had exited. Tmux's default `remain-on-exit off` removed 2 of the 4 panes; the layout collapsed from a 2x2 grid to a 1x2 horizontal split. The 2 surviving panes' parent shells stayed but their node processes are dead (`pane_current_command` reports a stale `node` while `ps -p` shows `-zsh`). The continuous watchdog (`restartDeadWatcherPanes` per `pickle-utils.js:1450`) — even if it had armed in a surviving pane — has no `tmux split-window` fallback for the case where the target pane index has been removed by tmux's layout collapse, so it cannot rebuild the missing panes. The iteration loop is otherwise healthy and progressing; only the operator's at-a-glance monitor view is wrecked.

## Observed incident

**Session**: `~/.local/share/pickle-rick/sessions/2026-05-13-db129229/` (szechuan-sauce R2 on `loanlight-api/gregory/1025-appraisal-epic`).

**Launch sequence**:
- `14:12:40.955Z` — `microverse-runner started`
- `14:12:41.050Z` — `ensureMonitorWindow: created 4-pane monitor (mode=pickle) on szechuan-db129229`
- `14:12:41.091Z` — `Starting gap analysis phase`
- `14:13:22.654Z` — first Stop hook fires (worker is actively running)
- `14:18:38.257Z` — worker still progressing (iteration log fresh)

**Monitor state when inspected at ~14:19Z**:
```
$ tmux list-windows -t szechuan-db129229
0: bash- (1 panes) [80x24]
1: monitor* (2 panes) [169x43] [layout dd1a,169x43,0,0{85x43,0,0,138,83x43,86,0,140}]
```

Was created with `4276` layout (2x2 grid, 4 panes). Now `dd1a` layout (horizontal split, 2 panes).

**Process inventory**:
```
$ pgrep -af "node.*\.(js|ts)"
(empty — no node processes at all)

$ tmux list-panes -t szechuan-db129229:1 -F '#{pane_id} pid=#{pane_pid} cmd=#{pane_current_command}'
%138 pid=32558 cmd=node    ← tmux cache, not actual
%140 pid=32580 cmd=node    ← tmux cache, not actual

$ ps -p 32558 -o pid,ppid,command
32558 24883 -zsh           ← actual: zsh shell, node has exited

$ ps -p 32580 -o pid,ppid,command
32580 24883 -zsh           ← same
```

**Watcher restart log**:
```
$ ls -la ~/.local/share/pickle-rick/sessions/2026-05-13-db129229/mux-runner.log
ls: No such file or directory
```

`appendWatcherRestartLog` writes to `${sessionDir}/mux-runner.log` on every watchdog tick (success or failure). File doesn't exist = zero ticks. The watchdog never ran in any surviving pane.

**Session is otherwise healthy**:
- `state.active: true`
- `state.iteration: 1`
- `state.exit_reason: null`
- `pid: 32365` (microverse-runner) — still up
- `launch_shell_pid: 32312` (bash launch.sh) — still up
- `tmux_iteration_1.log` — 271 KB and growing, last timestamp 14:18:38Z (current)

The worker is making real progress. The visible failure is the *display layer*, not the iteration loop.

## Root cause analysis — two compounding bugs

### Bug 1 — Monitor processes all die early (likely R-MDS-class mode mismatch)

`ensureMonitorWindow` spawned the 4-pane monitor with `mode=pickle` per the runner log. But this is a szechuan-sauce session — `state.command_template: "szechuan-sauce.md"`. The dashboard's `render()` function in `monitor.js` reads mode-specific state fields. For `mode=pickle`, render expects pickle-mode fields (`Tickets`, `Active`, `Circuit`, `MetricTrend`). For a szechuan-sauce session with `state.step="prd"`, those fields are absent → `render()` throws → `monitor.js` catches and exits with code 2:

```js
// extension/bin/monitor.js:790-805
while (true) {
    let active;
    try {
        active = await render(sessionDir, mode);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[monitor] ${msg}\n`);
        process.exit(2);  // ← all 4 panes hit this within seconds of start
    }
    ...
}
```

R-MDS (`prds/p3-monitor-dashboard-stale-after-pickle-to-anatomy-park-transition.md`, Finding #15) covers the *transition* case (pickle → anatomy-park). R-MDS-3 added `checkAndSwapMode` to hot-swap mode on phase change. But the hot-swap runs *after* `render()` succeeds in the loop body — if the first `render()` throws on initial mode-mismatch (session NEVER ran a pickle phase; it was szechuan-sauce from the start), the hot-swap never gets a chance to run. The process exits before its safety net engages.

This is a **new trigger case for R-MDS**: not pickle→anatomy transitions, but szechuan-sauce sessions where the monitor is spawned in pickle mode from the start.

### Bug 2 — Watchdog cannot repair a collapsed layout (R-MWR structural gap)

R-MWR (`prds/archive/features/p3-monitor-watcher-continuous-auto-respawn.md`) shipped a `setInterval`-based watchdog inside `monitor.js` that calls `restartDeadWatcherPanes` every 30 seconds. The watchdog is correct for the case where a pane's node process dies but the pane itself still exists (e.g. `remain-on-exit on`). It's structurally broken for the case where tmux removed the pane entirely.

```js
// extension/services/pickle-utils.js:1466-1484
for (const watcher of watcherPaneCommands(sessionDir, extensionRoot, mode)) {
    const target = `${sessionName}:monitor.${watcher.pane}`;  // e.g. ":monitor.2"
    const currentCommand = readPaneCurrentCommand(target, spawnSyncFn);
    if (currentCommand === null) {
        appendWatcherRestartLog(sessionDir, `${logTag} WARN: unable to read pane_current_command for pane ${watcher.pane}`);
        continue;  // ← bails — never split-window's a replacement
    }
    if (currentCommand === 'node')
        continue;
    // ...send-keys to existing pane to relaunch...
}
```

When tmux removes a dead pane (default `remain-on-exit off`), the index referenced as `monitor.2` or `monitor.3` resolves to no pane. `readPaneCurrentCommand` returns `null`. The function logs a WARN and `continue`s — there is **no `tmux split-window` fallback** to re-create the missing pane.

In this incident, the watchdog also never *ran* (no log entries, no `mux-runner.log` file), so even the WARN doesn't appear. The watchdog was unreffed (`handle.unref()` per `monitor.js:733`), and the parent monitor.js exited before the first 30-second tick could fire. So the layout-collapse-repair gap is a *latent* bug here — it didn't fire because the precondition (watchdog running) didn't hold. But the moment a long-running session has even one pane survive past 30s and then another collapses, the gap surfaces.

### Why the existing PRDs don't already cover this

- **R-MWR** assumes pane targets exist; doesn't handle layout-collapse.
- **R-MDS** focuses on pickle→anatomy mode transitions; doesn't enumerate szechuan-sauce as a fresh-start trigger and doesn't address the pre-first-render crash window where `checkAndSwapMode` hasn't yet run.
- **R-MMRT** is codex-specific (per-iteration temp dir leak); not the trigger here.

## Source surface

**Files to touch**:
- `extension/src/bin/monitor.js` — either (a) defer first `render()` call until mode auto-detection runs, or (b) make `render()` mode-mismatch-tolerant (no-op + retry instead of throw), or (c) make `ensureMonitorWindow` infer mode from `state.command_template` instead of defaulting to `pickle`.
- `extension/src/services/pickle-utils.ts` — extend `restartDeadWatcherPanes` to detect pane-missing (`currentCommand === null`) as "collapsed layout" and use `tmux split-window` to re-create the pane before send-keys.
- `extension/src/services/pickle-utils.ts` — `ensureMonitorWindow`'s mode argument: trace where `mode=pickle` is hardcoded for non-pickle sessions and fix.
- `extension/tests/integration/monitor-collapsed-layout-respawn.test.ts` (new) — regression coverage.

## Atomic tickets — R-MWCL family ("monitor watcher collapsed layout")

### R-MWCL-1 — Infer monitor mode from `state.command_template`, not pickle default
- When `ensureMonitorWindow` is called with no explicit mode argument, read `state.command_template` from the session and map: `pickle*.md → pickle`, `anatomy-park.md → microverse`, `szechuan-sauce.md → microverse`, `meeseeks*.md → meeseeks`, `council*.md → council`, etc.
- The current call site logs `created 4-pane monitor (mode=pickle)` for a szechuan-sauce session — that's the wrong mode. Fix the mode resolution so the monitor starts in the correct mode and `render()` doesn't throw on missing pickle fields.
- File: `extension/src/services/pickle-utils.ts` `ensureMonitorWindow`. ~20 LOC + tests.

### R-MWCL-2 — Make `render()` mode-mismatch tolerant
- Defense in depth: even with R-MWCL-1, races between session-start and monitor-mode-resolution should not crash. If `render(sessionDir, mode)` encounters a missing-field error that's consistent with a mode mismatch (vs a genuine I/O error), log to stderr and return `active: false` instead of throwing. The loop will then enter the `!active` retry path which already calls `checkAndSwapMode` on the next tick.
- File: `extension/src/bin/monitor.js` `render()`. ~15 LOC + tests.

### R-MWCL-3 — `restartDeadWatcherPanes` collapsed-layout fallback
- When `readPaneCurrentCommand(target)` returns `null`, do NOT just log+continue. Instead:
  1. Detect whether the monitor window itself still exists (`tmux list-panes -t <session>:monitor` succeeds with some panes).
  2. If yes and the target pane index is missing, `tmux split-window -t <session>:monitor -d` to create a new pane, then `tmux send-keys` to it.
  3. Re-arrange layout via `tmux select-layout -t <session>:monitor tiled` (or the layout string the original `ensureMonitorWindow` used) so the new pane lands in a reasonable position.
- Log every collapsed-layout repair attempt with a distinct tag (`collapsed-layout-repair`) so future incidents are diagnosable.
- File: `extension/src/services/pickle-utils.ts` `restartDeadWatcherPanes`. ~40 LOC + tests.

### R-MWCL-4 — Capture monitor stderr to a session-local log
- Today, when `monitor.js` exits with `process.stderr.write('[monitor] <msg>')`, the stderr goes to the tmux pane's stdout and dies when the pane closes. Diagnosis is forensic. Plumb `monitor.js`'s stderr to `${sessionDir}/monitor-<paneIdx>.log` so post-mortem inspection has data.
- Implementation: when `ensureMonitorWindow` spawns each monitor pane, pipe stderr to a per-pane log file (e.g. `bash -c 'node monitor.js ... 2>monitor-0.log'`).
- File: `extension/src/services/pickle-utils.ts` `ensureMonitorWindow` / `watcherPaneCommands`. ~15 LOC + tests.

### R-MWCL-5 — Watchdog initial tick: fire on first interval, not after first interval
- Today: `setInterval(tick, 30_000)` waits 30s before the first tick. If monitor.js dies within that window (as it did here), the watchdog never runs.
- Change: call `tick()` once synchronously at startup, then `setInterval(tick, 30_000)` for subsequent ticks. First-30s death window narrows from `[0, ∞)` to `[0, 30)` measured *from the first tick*.
- Also: surface the first tick to a startup log line so its execution is observable.
- File: `extension/src/bin/monitor.js` `startRespawnWatchdog`. ~5 LOC + tests.

### R-MWCL-6 — Regression test
- New: `extension/tests/integration/monitor-collapsed-layout-respawn.test.ts`.
- Scenario A: spawn 4-pane monitor in a mock tmux session. Kill panes 2 and 3. Assert that within (R-MWCL-5's first-tick + 1s) the layout has been repaired back to 4 panes.
- Scenario B: spawn monitor with `mode=pickle` but `command_template=szechuan-sauce.md` in state.json. Assert `render()` does NOT throw; mode auto-swaps to the correct mode within 2 ticks.
- ~120 LOC.

### R-MWCL-7 — Trap-door entry in `extension/src/services/CLAUDE.md`
- INVARIANT: `ensureMonitorWindow` MUST infer monitor mode from `state.command_template` when not given an explicit mode; defaulting to `pickle` for non-pickle templates causes immediate `render()` crashes.
- INVARIANT: `restartDeadWatcherPanes` MUST handle the case where a target pane index has been collapsed away by tmux (`readPaneCurrentCommand === null`) by creating a new pane, not by logging-and-continuing.
- ENFORCE: `monitor-collapsed-layout-respawn.test.ts`.
- PATTERN_SHAPE: `ensureMonitorWindow(..., 'pickle')` called with a non-pickle `state.command_template`; OR `restartDeadWatcherPanes`'s `if (currentCommand === null) { ...continue; }` path without a `tmux split-window` fallback above it.

## Reproduction (deterministic)

1. Launch any non-pickle template session: `/szechuan-sauce` or `/anatomy-park` on claude or codex.
2. Within 30 seconds of launch, observe `tmux list-windows -t <session>` — watch for the monitor window layout collapsing from 4 panes to 2 (or fewer).
3. `pgrep -af node` — confirm no monitor node processes are running.
4. `ls ${sessionDir}/mux-runner.log` — confirm the watcher log doesn't exist (proof the watchdog never ticked).
5. Iteration loop continues (state.active still true, iteration log still growing) — display layer is the only casualty.

## Estimated scope

- R-MWCL-1..7 total: ~250 LOC, ~half-day to full-day, single PR.
- Could bundle with R-MDS (#15) since R-MWCL-2 partially supersedes R-MDS-3's hot-swap.

## Session evidence

- Failing session: `~/.local/share/pickle-rick/sessions/2026-05-13-db129229/`
  - `microverse-runner.log` — shows `created 4-pane monitor (mode=pickle)` for a szechuan-sauce session
  - `tmux_iteration_1.log` — fresh, worker active
  - No `mux-runner.log` (proof of zero watchdog ticks)
  - `state.json` — `command_template: "szechuan-sauce.md"` while runner logged `mode=pickle`
- Tmux state captured: layout `4276` at start (4 panes 2x2) → `dd1a` at inspection (2 panes 1x2)

## Cross-references

- **R-MDS** (Finding #15, `prds/p3-monitor-dashboard-stale-after-pickle-to-anatomy-park-transition.md`): same class of bug. R-MWCL-1 and R-MWCL-2 expand R-MDS's scope from "pickle→anatomy transition" to "any session that starts with a mismatched mode, including szechuan-sauce." Consider merging this PRD's tickets into R-MDS or shipping the two together.
- **R-MWR** (`prds/archive/features/p3-monitor-watcher-continuous-auto-respawn.md`): shipped via `ed6a58e3` family. R-MWCL-3 is the structural gap R-MWR didn't cover — collapsed-layout repair. R-MWCL-5 narrows R-MWR's first-tick window.
- **R-MMRT** (Finding #27, `prds/archive/bug-reports/p3-mux-runner-monitor-respawn-uses-temp-dir-not-session-root.md`): adjacent but different root cause. Cross-ref only.

## Notes

- All 4 monitor processes died in the first ~30 seconds. R-MWCL-4 (capture monitor stderr to file) is the *highest-value diagnostic ticket* — without it, every future occurrence is forensic guesswork. Worth shipping first even if behavioral fixes are deferred.
- Operator workaround (per MASTER_PLAN's BUNDLE-B aux monitor note): `tmux attach -t monitor-aux-<hash>` — separate tmux session running monitor.js standalone, immune to in-session pane collapse. Documented but not automated; consider a `/pickle-aux-monitor <session-hash>` skill as a P3 follow-up.

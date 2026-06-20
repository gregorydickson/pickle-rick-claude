---
title: "P2 — Monitor respawn uses temp-dir/empty sessionDir, kills monitor mid-run (R-MMRT)"
status: Draft
filed: 2026-05-15
priority: P2
type: bug
finding: 27
r_codes:
  - R-MMRT-1
  - R-MMRT-2
  - R-MMRT-3
  - R-MMRT-4
  - R-MMRT-5
  - R-MMRT-6
sister_prds:
  - prds/archive/bug-reports/p3-monitor-watcher-collapsed-layout-repair-gap.md
  - prds/p3-monitor-dashboard-stale-after-pickle-to-anatomy-park-transition.md
related:
  - prds/MASTER_PLAN.md
---

# PRD — Monitor Respawn sessionDir Drift (R-MMRT)

**Author**: Pickle Rick
**Project**: `pickle-rick-claude`
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`, local-only
**Severity**: P2 (was P3 in MASTER_PLAN; promoted 2026-05-15 PM)

## Problem

### Symptom

The 4-pane monitor window (panes 0=monitor.js, 1=log-watcher.js, 2=morty-watcher.js / refinement-watcher.js / `tail -F`, 3=raw-morty.js) collapses to 3 or fewer panes during long-running codex pipelines. Once collapsed, panes stay dead for the remainder of the run because the in-process R-MWR-1 watchdog (in monitor.js pane 0) has also died.

Operator-visible result: the 4-pane Matrix-style dashboard either freezes on a stale render or shows empty zsh prompts; structured progress reporting is lost for the rest of the autonomous run (typically 14-22h on codex bundles).

### Triggering evidence (session 2026-05-15-c543d227)

Pipeline launched 2026-05-15T18:00:18Z (B2 operational trifecta + R-RSU, 26 tickets, codex backend). At 18:13:15Z (~13 min into pickle phase 1/4, iter 2 in flight) the monitor window had collapsed:

```
tmux list-panes -t pipeline-c543d227:monitor:
  pane=0 idx=%992 cmd=zsh dead=0 pid=89459 width=80 height=14
  pane=1 idx=%991 cmd=zsh dead=0 pid=89454 width=40 height=9
  pane=2 idx=%993 cmd=zsh dead=0 pid=89463 width=39 height=9
  (pane 3 deleted, layout collapsed 2x2 → 1+row)
```

All three remaining panes were running `zsh` (not `node`). Pane buffer contents:

```
pane 0 (was monitor.js):    empty + zsh prompt
pane 1 (was log-watcher.js, swallowed by adjacency collapse): n/a
pane 2 (was morty-watcher.js):
  "Usage: node morty-watcher.js <session-dir>"
pane 3 (was raw-morty.js, before its pane was reclaimed):
  "000gn/T/pipeline-signal-session-cMdRqM"  ← previous respawn used a codex temp dir
  "Usage: node raw-morty.js <session-dir>"  ← subsequent respawn used empty sessionDir
```

The pane-3 buffer captures the smoking gun: **two consecutive bad respawns** of `raw-morty.js`, the first with a codex per-spawn temp directory (`/private/var/folders/2w/j4nf5k_17ys16yzvmhcx0brh0000gn/T/pipeline-signal-session-cMdRqM`) and the second with no `sessionDir` argument at all.

### Root cause

`extension/src/services/pickle-utils.ts::watcherPaneCommands(sessionDir, extensionRoot, mode)` constructs respawn commands by template-interpolating `sessionDir` into a shell line:

```ts
return [
  { pane: 0, name: 'monitor.js',        command: `node ${path.join(binRoot, 'monitor.js')} ${sessionDir}` },
  { pane: 1, name: 'log-watcher.js',    command: `node ${path.join(binRoot, 'log-watcher.js')} ${sessionDir}` },
  paneTwo,
  { pane: 3, name: 'raw-morty.js',      command: `node ${path.join(binRoot, 'raw-morty.js')} ${sessionDir}` },
];
```

`restartDeadWatcherPanes(sessionDir, extensionRoot, mode, ..., logTag)` then runs each command via `tmux send-keys -t <target> <command> Enter` (line 1708). The function does NOT validate that `sessionDir`:

1. Is non-empty (truthy)
2. Exists on disk (`fs.existsSync(sessionDir)`)
3. Contains a readable `state.json`
4. Matches the canonical SESSION_ROOT recorded in `state.session_dir`

Result: any caller that passes an empty string, a stale codex temp dir, or any other malformed path produces a respawn command that the watcher interprets as "no argument" → `process.argv.length === 2` → the watcher's argv parser falls into its `Usage:` branch → `process.exit(1)`.

Once a watcher exits, tmux's default `remain-on-exit off` deletes the pane and the layout auto-collapses neighboring panes. When pane 0 (monitor.js) is itself the victim, the in-process R-MWR-1 watchdog (`startRespawnWatchdog({ sessionDir })`) dies with it; no more 30s ticks fire to re-arm the watchers. The monitor stays dead until the next pipeline-runner phase boundary (typically tens of minutes to hours later, if at all).

### Why bad sessionDir reaches the respawn

Pipeline-runner calls `respawnMonitorWindowForMode(runtime.sessionDir, phase)` at every non-citadel phase boundary (R-MDS-1 trap door, already shipped). `runtime.sessionDir` is set once at runtime construction (`pipeline-runner.ts:1775`) and should be canonical. So that path likely works.

But `restartDeadWatcherPanes` is also called by `ensureMonitorWindow` boundary calls AND by the in-process R-MWR-1 watchdog inside `monitor.ts`. The in-process watchdog passes monitor.ts's own `sessionDir` (its `argv[2]`). If monitor.ts itself was ever respawned with a bad `sessionDir`, its watchdog inherits the bad path and recursively kills every watcher pane.

Suspected drift sources:
- **Codex per-iteration spawn**: pipeline-runner forks codex workers with their own working directories (`/private/var/.../T/pipeline-signal-session-<rand>`). If any of these paths leak into `respawnMonitorWindowForMode`'s `sessionDir` argument (via `process.cwd()`, an inherited env var, or a stale runtime field), the resulting respawn uses the temp dir. By the time the watcher boots, the temp dir is cleaned up → `fs.existsSync(sessionDir)` is false → usage branch fires.
- **`process.cwd()` mutation**: if any code path computes `sessionDir` from `process.cwd()` (rather than reading from `runtime.sessionDir`), codex spawns that mutate cwd corrupt the value.
- **Inherited env var**: `PICKLE_STATE_FILE` or similar env vars might be set by codex temp-dir setup and leak into watcher invocations.

The pane-3 buffer's `pipeline-signal-session-cMdRqM` substring is the smoking-gun signature: this is a codex `--ephemeral --skip-git-repo-check` per-spawn dir, NOT the canonical SESSION_ROOT.

### Severity rationale (promotion P3 → P2)

Original Finding #27 filing (2026-05-12) classed this as P3 cosmetic on the rationale that "the actual pipeline progresses normally underneath". That rationale was correct for short pipelines where operator-visibility loss was bounded.

For 14-22h codex bundles running in unattended mode, the rationale inverts: per the [[feedback_morty_validation_log_heuristic]] memory + Finding #29 R-MWCL's own note ("operator-visibility blast-radius amplifier; promotes any P3 worker bug to operator-blind P1 in autonomous mode"), a dead monitor for 80%+ of a multi-hour autonomous run is operationally P1.

Recurrence is structural (every codex-backend session ≥ a few iterations), not stochastic. Bundle 2026-05-15-c543d227's monitor died inside the first 13 minutes of a planned 14-22h run, on the bundle that was specifically queued to fix three monitor-adjacent operator-friction taxes.

## Scope

### In-scope

- `extension/src/services/pickle-utils.ts::restartDeadWatcherPanes` — validate `sessionDir` before any tmux send-keys; skip + log when invalid.
- `extension/src/services/pickle-utils.ts::watcherPaneCommands` — emit defense-in-depth runtime check so the constructed command refuses to run with an empty arg.
- `extension/src/lib/monitor-respawn.ts::respawnMonitorWindowForMode` — same validation pattern; refuse to respawn-pane with a malformed sessionDir.
- `extension/src/bin/monitor.ts::startRespawnWatchdog` — when its sessionDir is invalid at boot, refuse to schedule the timer (return null) and emit `monitor_respawn_session_dir_invalid` activity event.
- Audit all callers of `restartDeadWatcherPanes` and `respawnMonitorWindowForMode` for the value passed as `sessionDir`. Document the canonical source.
- New trap-door entry in `extension/src/services/CLAUDE.md` pinning the sessionDir validation invariant.
- New regression test simulating the bad-respawn path (empty + temp-dir cases).
- New activity event `monitor_respawn_session_dir_invalid` registered in `VALID_ACTIVITY_EVENTS`.

### Out of scope (separate PRDs)

- R-MWCL `inferMonitorMode` fix for `'szechuan-sauce'` / `'anatomy-park'` (Finding #29, separate PRD already in flight as bundle 2026-05-15-c543d227 ticket `799d5ebe`).
- R-MWCL-3 `restartDeadWatcherPanes` collapsed-layout `tmux split-window` fallback (same bundle, ticket `40cab843`). This PRD is upstream — preventing the bad respawn in the first place obviates much of R-MWCL-3's recreate logic.
- General tmux pane lifecycle hardening beyond the sessionDir argument resolution path.

## Functional Requirements

### R-MMRT-1 — Validate sessionDir at every respawn entry point

`restartDeadWatcherPanes` MUST validate `sessionDir` before invoking `watcherPaneCommands` or `tmux send-keys`:

1. Truthy, non-empty string.
2. `fs.existsSync(sessionDir)` returns true.
3. `path.join(sessionDir, 'state.json')` exists as a regular file.
4. The recovered state (`StateManager.read(...)`) carries `state.session_dir === sessionDir` (canonical-equality guard).

Failure of any check → skip the respawn loop, append a structured WARN line to `mux-runner.log`, emit a `monitor_respawn_session_dir_invalid` activity event, return.

Same validation pattern applied to `respawnMonitorWindowForMode` (entry-point gate before invoking `tmux respawn-pane`).

**Acceptance**: a unit test calls `restartDeadWatcherPanes('')`, `restartDeadWatcherPanes('/nonexistent/dir')`, and `restartDeadWatcherPanes('/tmp/pipeline-signal-session-XXXX')` (with no state.json) and asserts that NO tmux send-keys runs in any case; one activity event is emitted per call.

**Verify**: `cd extension && npm run test:fast` exits 0.

**Files**: `extension/src/services/pickle-utils.ts`, `extension/src/lib/monitor-respawn.ts`, new test `extension/tests/restart-dead-watcher-panes-sessiondir-validation.test.js`.

### R-MMRT-2 — `startRespawnWatchdog` refuses to arm with invalid sessionDir

Monitor.ts's in-process watchdog (R-MWR-1) MUST validate its own `sessionDir` argument BEFORE scheduling the setInterval. If validation fails (empty / nonexistent / no state.json / state.session_dir mismatch), it MUST NOT call `setInterval`; it MUST emit `monitor_respawn_session_dir_invalid` to stderr and `monitor-stderr.log` (once R-MWCL-4 ships) and return `null`.

This is defense-in-depth: even if a bad respawn slips past R-MMRT-1's caller-side guards and monitor.js starts up with a bad sessionDir, the watchdog will refuse to compound the failure by spawning more bad respawns every 30s.

**Acceptance**: a unit test calls `startRespawnWatchdog({ sessionDir: '' })` and asserts the returned value is `null` and no setInterval timer is scheduled.

**Verify**: `cd extension && npm run test:fast` exits 0.

**Files**: `extension/src/bin/monitor.ts`, extend `extension/tests/monitor-watchdog.test.js`.

### R-MMRT-3 — Audit + document every sessionDir source

Walk every caller of `restartDeadWatcherPanes` and `respawnMonitorWindowForMode`. For each call site, document the canonical source of `sessionDir`:

| Callsite | Current source | Canonical source |
|---|---|---|
| `pipeline-runner.ts:1714` | `runtime.sessionDir` | should match `process.argv[2]` resolved via `path.resolve` |
| `pipeline-runner.ts:2187..2191` | `runtime.sessionDir` | same |
| `monitor.ts:851` | `process.argv[2]` parsed by `parseMonitorArgs` | same |
| `mux-runner.ts` (boundary calls, if any) | TBD by audit | should be `state.session_dir` |

For any callsite that derives `sessionDir` from `process.cwd()` or an env var rather than a state-anchored value, replace with `state.session_dir` read via `StateManager.read(statePath)`.

**Acceptance**: a code-walk audit document at `extension/docs/sessiondir-respawn-audit.md` lists every callsite + its source; no callsite uses `process.cwd()` or unanchored env vars as the SoT for `sessionDir`.

**Files**: `extension/docs/sessiondir-respawn-audit.md` (new), any pickle-utils.ts / mux-runner.ts / pipeline-runner.ts edits the audit surfaces.

### R-MMRT-4 — Trap-door pin in `extension/src/services/CLAUDE.md`

Add an ENFORCE entry asserting:

> `restartDeadWatcherPanes(sessionDir, ...)` and `respawnMonitorWindowForMode(sessionDir, ...)` MUST validate `sessionDir` (non-empty, fs.existsSync, state.json present, state.session_dir matches canonical) BEFORE any tmux send-keys / respawn-pane invocation. Invalid sessionDir produces zero spawns and one `monitor_respawn_session_dir_invalid` activity event. Verified by `extension/tests/restart-dead-watcher-panes-sessiondir-validation.test.js` + `bash extension/scripts/audit-trap-door-enforcement.sh`.

**Acceptance**: `bash extension/scripts/audit-trap-door-enforcement.sh` exits 0; the new ENFORCE entry is counted in its summary.

**Files**: `extension/src/services/CLAUDE.md`.

### R-MMRT-5 — Regression test for the cascade

Integration test that:

1. Constructs a session with valid state.json + 4-pane monitor.
2. Simulates a respawn with `sessionDir=''` and asserts: zero tmux send-keys, one activity event emitted, no pane killed, no watchdog kill.
3. Simulates a respawn with `sessionDir='/tmp/pipeline-signal-session-FAKE'` (path exists but has no state.json) and asserts the same.
4. Simulates the cascade: start watchdog with valid sessionDir, then mutate runtime sessionDir to invalid mid-flight (simulating codex temp-dir drift) and assert watchdog stops with one event, panes stay alive.

**Acceptance**: `cd extension && npm run test:integration` exits 0; the new integration test is picked up.

**Files**: `extension/tests/integration/monitor-respawn-sessiondir-cascade.test.js` (new).

### R-MMRT-6 — Closer

Atomic closer ticket: minor version bump in `extension/package.json` (state schema unchanged → patch bump fine), run full release gate from `extension/`, deploy via `bash install.sh --closer-context --no-confirm`, verify md5 parity on the 5 most-trafficked compiled files, update MASTER_PLAN entry for Finding #27 (mark CLOSED + move to archive).

**Acceptance**:
- Version bumped, release gate exit 0, `git status` clean.
- MASTER_PLAN.md no longer lists Finding #27 in Open Findings.

**Files**: `extension/package.json`, `prds/MASTER_PLAN.md`, deployed copies under `~/.claude/pickle-rick/extension/`.

## Interface Contracts

### Contract 1 — `restartDeadWatcherPanes` precondition

`restartDeadWatcherPanes(sessionDir, extensionRoot, mode, spawnSyncFn?, logTag?)`. When `sessionDir` does not satisfy R-MMRT-1's four-check predicate, the function MUST return without invoking `spawnSyncFn` for tmux send-keys.

### Contract 2 — `monitor_respawn_session_dir_invalid` activity event

Registered in `VALID_ACTIVITY_EVENTS`. Payload shape:

```typescript
{
  event: 'monitor_respawn_session_dir_invalid',
  ts: string,        // ISO-8601
  caller: string,    // 'restartDeadWatcherPanes' | 'respawnMonitorWindowForMode' | 'startRespawnWatchdog'
  sessionDir: string,// the bad value
  reason: 'empty' | 'enoent' | 'no_state_json' | 'session_dir_mismatch',
}
```

### Contract 3 — Watchdog null-return

`startRespawnWatchdog({ sessionDir })` returns `null` (vs. the normal `IntervalHandle`) when sessionDir validation fails. Callers MUST be tolerant of null (no setInterval handle to track / cancel).

## Verification Strategy

- Unit tests for `restartDeadWatcherPanes` sessionDir validation (R-MMRT-1).
- Unit tests for `startRespawnWatchdog` refuse-to-arm path (R-MMRT-2).
- Integration test for the cascade scenario (R-MMRT-5).
- Audit doc walk-through (R-MMRT-3).
- Audit script verifies trap-door entry (R-MMRT-4).
- Release gate validates against the full test tier (R-MMRT-6).

## Risk Register

- **R1**: Validation may be too strict and refuse legitimate respawns for sessions whose `state.session_dir` field drifts (e.g., relative-path stored). Mitigation: validation compares via `path.resolve(sessionDir)` to `path.resolve(state.session_dir)`, not raw string equality.
- **R2**: Activity event emission per failed tick could flood the log when watchdog is in a persistent bad state. Mitigation: emit at most once per (caller, sessionDir, reason) tuple per session via in-memory dedup.
- **R3**: Refusing to respawn when `state.json` is missing could leave watchers dead during session bootstrap, where state.json may not yet exist. Mitigation: bootstrap is handled by `setup.ts` which always writes state.json BEFORE `ensureMonitorWindow` is called; the race window is sub-second and the next watchdog tick (30s later) will pick it up.

## Out-of-band concerns

- R-MMRT-3's audit may surface that the original sessionDir corruption is in mux-runner's manager-relaunch path or codex spawn fork. If so, file follow-up sub-tickets per surface.
- This PRD does NOT change tmux's `remain-on-exit` default (which is what causes the layout to collapse on watcher exit). That's R-MWCL-3's territory.
- The `monitor-stderr.log` capture (R-MWCL-4) would have made this diagnosis trivial; another reason to ship R-MWCL alongside.

## Success definition

Run a 14h+ codex pipeline. After the run, `monitor_respawn_session_dir_invalid` event count is zero (or strictly bounded by known operator interventions); `tmux list-windows` shows the 4-pane monitor still alive at the end of the run; `monitor.js` PID at end-of-run is the same as at start (or a clean phase-boundary respawn).

# PRD: Monitor Dashboard Pane Frozen on Pickle-Phase View After Transition to Anatomy-Park / Szechuan-Sauce

**Status**: Bug PRD (2026-05-09) — UX/observability gap. The 4-pane monitor that `pipeline-runner.ts` spawns at launch is correct for the pickle phase, but its dashboard pane (1.0) and ticket-pointer pane (1.2) freeze on pickle-phase template after `pipeline-runner` transitions to anatomy-park (Phase 3/4) or szechuan-sauce (Phase 4/4). Worker-output panes (1.1, 1.3) continue updating live with bash/edit calls from the anatomy-park worker, so the operator sees activity but no phase-appropriate dashboard. Result: an operator glancing at the monitor sees "11 tickets done / closer shipped" indefinitely, even after pickle phase ends and anatomy-park has spent hours iterating.
**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`
**Triggering session**: `2026-05-09-7ff82595` — `/pickle-pipeline --no-refine --backend claude prds/archive/bundles/p1-bug-fix-bundle-2026-05-08-mega.md`. Pickle phase shipped 11/11 tickets at 16:35 UTC; anatomy-park has been iterating since (currently iter 12/100 at the time of this PRD). Monitor pane 1.0 still renders the pickle-phase template ("Tickets: ... 10 more above ... [x] a7fa5858: [Section K] Closer", "Active: ▣ ONLINE", "Metric Trend (lower is better, target: —): No measurements yet") despite `state.step === 'anatomy-park'` and `pipeline-status.current_phase === 'anatomy-park'` for hours.
**Sibling of**: `prds/archive/bundles/loop-runner-relaunch-status-bugs.md` (mux-runner ownership ordering vs `ensureMonitorWindow` — Bug A) and `prds/archive/features/p3-monitor-watcher-continuous-auto-respawn.md` (R-MWR — pane-respawn watchdog). Both address pane *liveness*; this PRD addresses pane *content correctness across phase boundaries*. R-MWR ensures the monitor process keeps running; this PRD ensures the monitor process renders the right thing once it's running through a phase change.

---

## Severity: P3

- Pipeline correctness is unaffected — commits land, anatomy-park iterates, gates run. The bug is purely observational.
- Operator confidence degrades: the dashboard displays stale state long enough that an inattentive operator could conclude the pipeline has stalled. They reach for `tmux kill-session` based on a screenshot, when in fact the pipeline is healthy. (Did not happen in this session because the operator double-checked via `state.json` and `pipeline-runner.log`.)
- Climbs to P2 if combined with: (a) any operator who relies on the dashboard for cancel/continue decisions without spot-checking state.json, OR (b) a long-running anatomy-park / szechuan-sauce run where the operator is monitoring remotely and `tmux capture-pane` is the only window they have. The mitigation is to publicize "monitor pane is stale during phase 2-4 — read state.json instead", but a fix is cheaper.

---

## What was missed

### Live state at observation (2026-05-09 evening UTC)

```
state.json:
  step: "anatomy-park"
  iteration: 12
  max_iterations: 100
  current_ticket: ""              # anatomy-park doesn't use ticket-style identifiers

pipeline-status.json:
  status: "running"
  current_phase: "anatomy-park"
  completed_phases: 2              # pickle ✓ + citadel ✓
  total_phases: 4
  updated_at: "2026-05-09T16:35:55.517Z"   # NOT updated since phase transition

monitor process (PID 5837):
  alive
  started: 2026-05-09 06:38 PT (pipeline launch)
  command: node ~/.claude/pickle-rick/extension/bin/monitor.js <session-root>
```

### What pane 1.0 (dashboard) shows

```
  Current:    none
  Active:     ▣ ONLINE
  Circuit:    CLOSED

Metric Trend (lower is better, target: —)
  No measurements yet

Tickets:
  ... 10 more above ...
  [x] a7fa5858: [Section K] Closer — version 1.73.0 + deploy parity + MASTER_PLAN bookkeeping (R-CLOSER-1..3)

Recent output:
  🔧 Bash
  🔧 Bash
  🔧 Bash
  🔧 Bash

Refreshing every 2s  •  Ctrl+C to detach
```

Three structural problems:

1. **`Tickets:` block is pickle-phase-only.** Anatomy-park doesn't have tickets in the per-section sense; it has subsystem rotations × iterations × convergence state. The dashboard renders a stale "all tickets done" view forever.
2. **`Metric Trend` is empty** (`No measurements yet`). Anatomy-park's microverse-runner DOES emit per-iteration trend data (`microverse.json:convergence.history` + `consecutive_clean` + `stall_counter`), but the monitor doesn't read or render it.
3. **`Current: none`** — should be displaying the current subsystem under analysis (e.g. `subsystem: extension/services/citadel — iteration 12/100, consecutive_clean=0`).

### What panes 1.1 and 1.3 show (worker-output panes)

```
1.1 (worker stream A):                  1.3 (worker stream B):
🔧 Bash: git status                     ⚡ Bash → git add src/types/activity-events.schema.json src/types/CLAUDE.md tests/cap-check-skipped-stale-cache-schema-conformance.test.js && git status
🔧 Bash: git add extension/src/type…    ⚡ Bash → git diff --cached --stat
🔧 Bash: pwd && git status 2>&1 | h…
🔧 Bash: git add src/types/activity…
🔧 Bash: git diff --cached --stat
```

These ARE updating live — the worker is actively committing anatomy-park HIGH fixes (commits `b3eb4395`, `7c497b88`, `9cde5ffb`, `a5672fa3`, `e10c1695`, `1aa2dd42`, `98f41b14`, `51968214` — 8 HIGH commits since pickle phase ended). So the watcher infrastructure works; it's specifically the *structured dashboard* that's stale.

### Pane 1.2 (ticket pointer)

```
▸ 3941449a
```

`3941449a` was Section J's ticket (R-MJCP judge probe fix) which closed during pickle phase. Pane 1.2 should now display the current anatomy-park subsystem rotation + iteration index, not a pickle-phase ticket id.

### Pane 1.2 also shows `Warning: no stdin data received in 3s, …`

The pickle-phase pane was wired to consume stdin from the manager process; once the manager exits at pickle phase end, no stdin arrives, and the pane logs the warning forever instead of detaching or reattaching to the new producer.

---

## Root causes

### RC-1 — `pipeline-runner.ts` does not kill + respawn the monitor at phase boundaries

`pipeline-runner.ts` calls `ensureMonitorWindow()` once at startup (per `pipeline-runner.log:11:38:50.055Z` `ensureMonitorWindow: created 4-pane monitor (mode=pickle)`). That call locks the mode in `mode=pickle`. Subsequent phase transitions emit `PHASE 2/4: CITADEL` and `PHASE 3/4: ANATOMY-PARK` log lines but do NOT swap the monitor pane's mode.

The mode is captured in the pane's invocation: `node monitor.js <session-root>` — and `monitor.js` reads `state.step` once at boot and binds its render template. When `state.step` changes from `pickle` to `anatomy-park`, the monitor process either doesn't re-read or doesn't re-bind.

### RC-2 — `monitor.js` render template is pickle-phase-shaped (Tickets / Active / Circuit / MetricTrend)

The dashboard at pane 1.0 renders four blocks tuned for pickle phase:

- **Tickets**: list of `linear_ticket_*.md` from session root, with `[x]` / `[ ]` from `status: Done` frontmatter.
- **Active**: pickle-loop manager liveness (online/offline).
- **Circuit**: pickle-phase circuit-breaker state (closed/half-open/open).
- **Metric Trend**: presumably reads `microverse.json` but only when the field exists; empty for pickle.

For anatomy-park / szechuan-sauce, the equivalent dashboard would be:

- **Subsystems**: list of subsystems from `microverse.json:subsystems[*]` with `[clean]` / `[unclean]` markers per `consecutive_clean`.
- **Active**: microverse-runner liveness.
- **Convergence**: `consecutive_clean=N/2` + `stall_counter=N/limit` + last-iteration timestamp.
- **Metric Trend**: render `microverse.json:convergence.history[*].score` over the last N iterations.

### RC-3 — Monitor watchdog (`startRespawnWatchdog`) doesn't notice mode-pane staleness

The R-MWR-7 / R-PSAI-5 monitor-pane-zero watchdog respawns dead panes within 30s, but it does not detect *stale* panes (process alive, polling, but rendering wrong-mode content). The watchdog's liveness check is based on `pane_current_command !== 'node'`, which is "monitor.js running" not "monitor.js rendering correct mode for current step".

### RC-4 — Pipeline-runner's `ensureMonitorWindow` lacks a `mode` argument distinct from boot mode

The function signature today is `ensureMonitorWindow(sessionDir)`. It returns `'created'` / `'exists'`. There's no `ensureMonitorWindow(sessionDir, { mode: 'anatomy-park' })` and no `respawnMonitorWindowForMode(sessionDir, 'anatomy-park')`. So pipeline-runner has no API to ask the monitor infrastructure to switch modes.

### RC-5 — `microverse-runner.ts` has its own log + JSON output but no monitor handoff

`microverse-runner.log` and `microverse.json` exist (we see iteration 5..12 log entries). `microverse-runner` doesn't tell the monitor process "I am the new producer; rebind your render template." The handoff contract is implicit / absent.

---

## Requirements

### R-MDS-1 — Pipeline-runner respawns monitor pane at phase boundaries

`extension/src/bin/pipeline-runner.ts` gains a phase-transition hook that, at every `PHASE N/4: <NAME>` boundary, invokes:

```ts
await respawnMonitorWindowForMode(sessionDir, currentPhase);
```

Where `currentPhase ∈ { 'pickle', 'citadel', 'anatomy-park', 'szechuan-sauce' }`. The function:

1. Sends a `kill 0` signal to the existing monitor.js process via `state.monitor_pid` if recorded.
2. Spawns a new `monitor.js <session-dir> --mode <currentPhase>` in pane 1.0.
3. Updates `state.json:monitor_pid` and `state.json:monitor_mode` so subsequent re-launches honor the binding.

Citadel runs in 1.3s and doesn't really need a dashboard refresh; mode swap may be skipped for `citadel` and applied only at `pickle → anatomy-park` and `anatomy-park → szechuan-sauce` boundaries. Implementer's call.

### R-MDS-2 — `monitor.js` accepts `--mode <name>` and dispatches render template

`extension/src/bin/monitor.ts` gains:

```ts
const args = parseArgs(process.argv);
const mode = args.mode ?? readStateMode(sessionDir);   // fallback: read state.step

const render = {
  pickle:        renderPickleDashboard,
  citadel:       renderPickleDashboard,    // same template; citadel is fast
  'anatomy-park': renderMicroverseDashboard,
  'szechuan-sauce': renderMicroverseDashboard,
}[mode];

setInterval(() => {
  console.clear();
  render(readState(sessionDir), readMicroverse(sessionDir), readPipelineStatus(sessionDir));
}, 2000);
```

`renderMicroverseDashboard` reads `microverse.json` and renders subsystems / convergence / metric trend per RC-2's anatomy-park-shaped layout.

### R-MDS-3 — Mode auto-detection from state.step on each render

Even if R-MDS-1's respawn fails for any reason, `monitor.js` MUST re-check `state.step` on every render tick (every 2s) and switch render template when it changes. This is a defense-in-depth: respawn is the load-bearing fix; auto-detection is the safety net.

```ts
let lastMode = mode;
setInterval(() => {
  const currentMode = readStateMode(sessionDir);
  if (currentMode !== lastMode) {
    log(`mode transition detected: ${lastMode} → ${currentMode}`);
    lastMode = currentMode;
  }
  console.clear();
  RENDERS[currentMode](state, microverse, pipelineStatus);
}, 2000);
```

### R-MDS-4 — `renderMicroverseDashboard` displays subsystem + convergence + metric trend

For phase ∈ { anatomy-park, szechuan-sauce }, the dashboard renders:

```
  Phase:      Anatomy-Park (3/4)         |  Phase:      Szechuan-Sauce (4/4)
  Iteration:  12 / 100                   |  Iteration:  N / 50
  Convergence: 0/2 consecutive clean     |  Convergence: ...
  Stall:      0 / 3                      |  Stall:      0 / 5
  Active:     ▣ ONLINE (microverse-runner PID NNNN)

Subsystems:
  [clean]   bin
  [unclean] services      ← currently iterating
  [clean]   types

Metric Trend (lower is better, target: 0)
  iter 1: 8.4
  iter 2: 6.1
  ...
  iter 12: 1.2

Recent output:
  🔧 ... (last 4 worker bash/edit lines from microverse-runner stdout)

Refreshing every 2s  •  Ctrl+C to detach
```

Field sources:
- Iteration / max — `microverse.json:iterations` + the `--max-iterations` cap recorded at setup time.
- Convergence + Stall — `microverse.json:convergence.{consecutive_clean, stall_counter, stall_limit}`.
- Subsystems — `microverse.json:subsystems[*]` (anatomy-park sets this; szechuan-sauce may differ).
- Metric Trend — `microverse.json:convergence.history[*].score` (last 10 entries).
- Recent output — last 4 lines from `microverse-runner.log` newer than `pipeline-runner.log`'s last `PHASE` line.

### R-MDS-5 — Pane 1.2 ticket pointer ↔ subsystem pointer

Pane 1.2 today displays `▸ <ticket_hash>` for the active pickle ticket. After phase transition, it should display `▸ <subsystem-name> (iter <n>)` for the active anatomy-park subsystem. The pane producer (a small Node script that reads state and writes the pointer line) MUST swap its data source from `state.current_ticket` (pickle) to `microverse.json:current_subsystem` (anatomy-park / szechuan).

### R-MDS-6 — Drop the "no stdin data received in 3s" warning when the producer process has exited

Pane 1.2's `Warning: no stdin data received in 3s, …` keeps printing because the producer process is gone. Either:

1. Detect producer-process death and exit the pane (let the watchdog respawn it pointing at the new producer), OR
2. Suppress the warning when `state.step !== <pane's bound phase>` (the pane is intentionally idle, not malfunctioning).

Implementer chooses; (1) is cleaner because R-MDS-1's respawn does the rebinding.

### R-MDS-7 — Trap-door entry pinned in `extension/CLAUDE.md`

> `bin/pipeline-runner.ts` (phase transition) — INVARIANT: every `PHASE N/4` boundary MUST invoke `respawnMonitorWindowForMode(sessionDir, currentPhase)` (citadel may opt out). BREAKS: monitor pane 1.0 freezes on pickle-phase template, displaying stale ticket data through anatomy-park + szechuan-sauce; operator confidence degrades; remote operators who trust the dashboard make wrong cancel/continue decisions. ENFORCE: extension/tests/integration/monitor-mode-transition.test.js.

### R-MDS-8 — Regression test asserting mode swap

`extension/tests/integration/monitor-mode-transition.test.js` (NEW) launches a synthetic 2-phase pipeline (pickle → anatomy-park) with stub workers, asserts:

1. Pane 1.0 capture during pickle phase contains "Tickets:".
2. Pane 1.0 capture after pipeline-runner emits `PHASE 3/4: ANATOMY-PARK` and waits 5s contains "Subsystems:" and does NOT contain "Tickets:".
3. `state.json:monitor_mode` is `'anatomy-park'` after transition.

Verified via `tmux capture-pane -p` calls to the test session's monitor window.

---

## Acceptance Criteria

- **AC-MDS-01** — `pipeline-runner.ts` invokes `respawnMonitorWindowForMode(sessionDir, phase)` at each non-citadel phase boundary; verified by log line `monitor: respawned for mode <phase>` in `pipeline-runner.log`.
- **AC-MDS-02** — `monitor.js --mode anatomy-park` renders the microverse-shaped dashboard (Subsystems / Convergence / Stall / Metric Trend) and does NOT render the Tickets block.
- **AC-MDS-03** — `monitor.js` without `--mode` reads `state.step` and renders the matching template; mode change at runtime (state.step transitions on next file-watch tick) MUST cause the render template to swap within 4s (2 ticks).
- **AC-MDS-04** — Pane 1.2 ticket pointer swaps from `▸ <ticket_hash>` to `▸ <subsystem-name> (iter N)` after phase transition.
- **AC-MDS-05** — The "no stdin data received in 3s" warning does not appear in pane 1.2 after a successful phase respawn.
- **AC-MDS-06** — Trap-door entry per R-MDS-7 lives in `extension/CLAUDE.md` and is found by `extension/tests/trap-door-conformance.test.js`.
- **AC-MDS-07** — Regression test `extension/tests/integration/monitor-mode-transition.test.js` passes per R-MDS-8.
- **AC-MDS-08** — Manual reproduction: launch `/pickle-pipeline` against any small bundle PRD; observe pane 1.0 transitions from Tickets-shaped to Subsystems-shaped within 4s of pickle phase ending. Anatomy-park's Convergence + Stall + Metric Trend update live as iterations land.

---

## Out of scope

- Redesigning the 4-pane layout itself — current layout is fine; this PRD only fixes content rendering per phase.
- Adding new dashboard surfaces (e.g. trap-door coverage live count) — separate enhancement.
- The pickle-phase Tickets block layout — unchanged.
- `microverse-runner` log format — unchanged (we read existing fields).

---

## Cross-references

- Sister bugs (pane liveness, not content correctness): `prds/archive/bundles/loop-runner-relaunch-status-bugs.md`, `prds/archive/features/p3-monitor-watcher-continuous-auto-respawn.md` (R-MWR), `prds/archive/bug-reports/p2-pickle-pipeline-no-scope-auto-inference.md` R-PSAI-5 (pane 0 watchdog).
- Triggering session: `2026-05-09-7ff82595` running `prds/archive/bundles/p1-bug-fix-bundle-2026-05-08-mega.md`. Live capture above is from this session at iter 12/100 of anatomy-park phase.
- Code references:
  - `extension/src/bin/pipeline-runner.ts` (phase-transition site; needs R-MDS-1 hook).
  - `extension/src/bin/monitor.ts` (render-template dispatcher; needs R-MDS-2/3/4).
  - `extension/src/services/pickle-utils.ts` (`ensureMonitorWindow`, `startRespawnWatchdog` — needs `respawnMonitorWindowForMode` companion).

---

## How to ship

Atomic single-file plus tests. Worker time: 2-3h.

1. Add `respawnMonitorWindowForMode(sessionDir, mode)` to `pickle-utils.ts`.
2. Refactor `monitor.js` to dispatch per-mode render template; add `--mode` arg + `state.step` fallback.
3. Build `renderMicroverseDashboard` reading `microverse.json`.
4. Wire the phase-boundary respawn call into `pipeline-runner.ts`.
5. Ship regression test + trap-door entry in same commit.

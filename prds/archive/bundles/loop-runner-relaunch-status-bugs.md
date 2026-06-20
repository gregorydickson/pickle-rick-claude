# PRD: Loop-Runner Relaunch Status Bugs (3 compounding)

**Status**: **SHIPPED** (2026-05-01) — 6 commits across 5 atomic tickets (LRR-T1..T5 + closer) on session `2026-05-01-21605b33` via `/pickle-pipeline --backend codex`.

Commits (chronological): `087930e` clear-exit-reason helper · `80f5c2a` claim mux-runner ownership before monitor recovery (Bug A) · `e4ca4bd` recover dead monitor pane zero (Bug B) · `2013e2a` clear stale exit reasons on relaunch (Bug C) · `00a0dc8` fix phase-marker reset transitions · `67a2ca0` document relaunch-recovery invariants. Pickle phase exited clean (3 iterations, 41m). Citadel phase exited clean (1 finding). **Anatomy-park phase failed at iter 2** with "gate baseline missing after commit, falling back to strict mode" → exit 1; szechuan-sauce phase 4/4 never ran. The 2 anatomy-park findings (ac-phase-gate command-timeout HIGH, check-readiness-snapshot recovery HIGH) were trap-doored to `extension/CLAUDE.md` but no fix commits landed in that pipeline. The ac-phase-gate finding was independently fixed by commit `d5270c0`; check-readiness-snapshot recovery remains open as a P3 residual.

Three compounding bugs in `mux-runner.ts` + `pickle-utils.ts` caused "monitor looks dead + state lies about exit" after relaunch; all three closed by the shipped tickets.

**Original problem statement** (2026-05-01) — surfaced live during v1.63.0 overnight bundle relaunch into session `2026-04-30-bc104e78`.
**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`
**Origin**: live debug session 2026-05-01 ~07:43-09:38 CDT during v1.63.0 bundle relaunch + phase transition. Pipeline was running cleanly under codex (10/10 tickets shipped in 112m, then advancing through citadel + anatomy-park phases), but the operator-visible status was misleading: tmux pane 0 showed yesterday's "Pipeline finished" footer, all 4 watcher panes were at zsh prompts, and `state.json.exit_reason` read `"fatal"`. After clean pickle-phase exit a NEW instance of Bug C surfaced: state.json showed `exit_reason: "success"`, `step: "review"`, `current_ticket: null` from the pickle finalizeTerminalState call coexisting with `command_template: "anatomy-park.md"` and `pid: <microverse-pid>` from the next phase's spawn. The loop was actually fine — the status presentation lied at TWO different transition moments. Three compounding bugs, with Bug C now scoped to cover both relaunch AND phase transition triggers.

---

## Symptoms (operator-visible)

When relaunching `pipeline-runner.js` into a session whose previous run ended in any forensic-exit path (READINESS HALT, fatal, signal, stall, timeout):

1. **Watcher panes 1-3 stay dead** — at zsh prompts after relaunch. The watchers self-terminated on yesterday's `active: false` and the WPR-shipped respawn helper (`restartDeadWatcherPanes`) does not fire even though the new run flips `active: true`.
2. **Dashboard pane 0 stays dead** — `monitor.js` was killed by yesterday's failure. WPR explicitly scoped pane 0 OUT as a non-goal, so no helper recovers it. Operators see a stale "Pipeline finished" prompt.
3. **`state.exit_reason` lies** — yesterday's `"fatal"` (or `"readiness_halt"`, `"stall"`, `"timeout"`, `"signal"`, etc.) persists across the relaunch. Reading state.json then misclassifies a healthy mid-research run as crashed.

Net effect: operator looks at the monitor, sees three dead panes + a "fatal" exit reason, concludes "it exited" — but the loop is fine and shipping commits.

---

## The three bugs (with file:line evidence)

### Bug A — `ensureMonitorWindow()` invoked BEFORE `active` flips true

**Evidence** from `${SESSION_ROOT}/mux-runner.log` at 12:43:22Z (today's relaunch):

```
[2026-05-01T12:43:22.633Z] ensureMonitorWindow: monitor window already exists on pipeline-bc104e78 (mode=pickle)
[2026-05-01T12:43:22.634Z] ensureMonitorWindow: exists                          ← respawn-check ran HERE
[2026-05-01T12:43:22.635Z] Session ownership taken (active: false → true)       ← active was still false above
```

**Root cause**: `mux-runner.ts` startup ordering calls `ensureMonitorWindow()` (which delegates to `restartDeadWatcherPanes()` for existing windows) before the session ownership claim flips `state.active: false → true`. The respawn helper reads state, sees `active: false`, and skips per the AC-WPR-03 invariant: "Calling `ensureMonitorWindow()` on a session with `state.active: false` → no respawn (preserves the watcher self-termination contract)."

That invariant is correct in isolation — watchers should NOT respawn into an inactive session. But the ordering means the respawn check NEVER fires on a relaunch into a previously-failed session, because `active` is still false at the moment the check runs.

**Files implicated**:
- `extension/src/bin/mux-runner.ts` — startup sequence (search for `Session ownership taken` log line and find the `ensureMonitorWindow` call site directly above it)
- `extension/src/services/pickle-utils.ts:907` — `restartDeadWatcherPanes` (works correctly; not the bug; victim of the ordering)

**Fix**: reorder `mux-runner.ts` startup so `Session ownership taken` happens BEFORE `ensureMonitorWindow()`. The flip is atomic via `StateManager.write` so observers see consistent state.

### Bug B — `monitor.js` pane 0 has no recovery path

**Evidence** from `prds/archive/features/watcher-pane-recovery.md` Non-goals:

> Recovering dead `monitor.js` (pane 0). It's the meta-watcher and shouldn't die; if it does, the tmux session is already in worse shape than this fix can address.

That non-goal was based on the assumption that `monitor.js` is invincible. **Empirically false** — yesterday's READINESS HALT killed all 4 panes. When the readiness gate exits 2 and the runner deactivates, the monitor's state-watch loop sees `active: false` and exits. Or the parent tmux pane closing (when send-keys'd command finishes) takes the dashboard with it.

**Files implicated**:
- `extension/src/services/pickle-utils.ts:907+` — `restartDeadWatcherPanes` skips pane 0 by design; needs a sibling helper or extension
- `extension/src/bin/monitor.js` — does it self-terminate on `active: false`? Need to verify (per the trap-door catalog, log-watcher / morty-watcher / raw-morty all do; monitor probably does too)

**Fix options**:
1. Extend `restartDeadWatcherPanes` to cover pane 0 too. Drop the "monitor.js shouldn't die" assumption.
2. New `restartDeadDashboardPane(sessionDir, extensionRoot)` helper called alongside `restartDeadWatcherPanes`.
3. Make `monitor.js` not self-terminate on `active: false`; instead poll for reactivation.

Recommend option 1 for symmetry — one function, four panes, one invariant.

### Bug C — `exit_reason` not cleared on session reactivation OR phase transition

**Evidence (Trigger 1 — relaunch into previously-failed session)**: `state.json` at the start of debug:
```json
{ "active": true, "step": "research", "iteration": 8, "current_ticket": "1a984379", "exit_reason": "fatal" }
```

`exit_reason` was set to `"fatal"` by yesterday's `recordExitReason()` call when the readiness halt fired. The session was then reactivated (active: false → true) by today's setup.js + mux-runner ownership claim. But `exit_reason` was never cleared as part of the reactivation transaction. So state-readers see a "fatal" marker that has nothing to do with the current run.

**Evidence (Trigger 2 — phase transition within a single run, observed live 2026-05-01 14:35Z)**: pickle phase exited cleanly via `finalizeTerminalState({step:'completed', exit_reason:'success'})`. Pipeline-runner advanced to phase 2 (citadel) → phase 3 (anatomy-park). Microverse-runner spawned, took session ownership, set `state.command_template: 'anatomy-park.md'` and `state.pid: 5456`. But state.json still showed:

```json
{
  "active": true,
  "step": "review",                    ← stale from pickle phase exit
  "current_ticket": null,              ← stale from pickle phase exit
  "exit_reason": "success",            ← stale from pickle phase exit
  "command_template": "anatomy-park.md", ← updated by anatomy-park spawn
  "pid": 5456                          ← updated by anatomy-park spawn
}
```

Two phases, conflicting state. State-readers can't tell whether anatomy-park is starting (true) or pickle just exited (true 3 seconds ago, no longer relevant). Other forensic-marker fields (`step`, `current_ticket`) ALSO don't get cleared on phase transition — they get overwritten by the next phase's first iteration, but during the transition gap they lie.

**Root cause**: `recordExitReason(reason)` and `finalizeTerminalState({...})` write forensic markers on every exit path (per `extension/CLAUDE.md` mux-runner / microverse-runner / pipeline-runner deactivation invariants — introduced v1.62.2). Their inverse — clearing those markers on reactivation/phase-entry — is missing. Three call paths leave stale values:
1. `setup.ts --resume` flips active but leaves prior-run exit_reason
2. `mux-runner.ts` Session ownership taken leaves prior-run exit_reason
3. `microverse-runner.ts` Session ownership taken leaves prior-phase exit_reason / step / current_ticket
4. `pipeline-runner.ts` phase transition does NOT reset per-phase forensic markers between phases

**Files implicated**:
- `extension/src/bin/setup.ts` — `--resume` path sets active: true; should also null forensic markers
- `extension/src/bin/mux-runner.ts` — Session ownership taken path should null forensic markers
- `extension/src/bin/microverse-runner.ts` — Session ownership taken path should null forensic markers
- `extension/src/bin/pipeline-runner.ts` — phase-entry transition should null forensic markers from prior phase before spawning next phase's runner
- `extension/src/services/pickle-utils.ts` — wherever `recordExitReason` is exported, add a paired `clearExitReason(statePath)` helper that nulls the full set of forensic markers atomically (`exit_reason`, optionally `step` if at phase boundary)

**Fix**: introduce `clearExitReason(statePath, opts?: { resetStep?: boolean, resetCurrentTicket?: boolean })` paired with `recordExitReason`. Call from all 4 transition sites listed above as part of the reactivation/phase-entry write transaction. The field is forensic only — it should reflect the CURRENT context's state, not a leftover from a prior dead run OR a prior completed phase.

**Severity bump**: this bug fires on every phase transition (every pickle→anatomy-park, every anatomy-park→szechuan-sauce, every relaunch). Originally classified P1 based on relaunch-only frequency; now P1 with much higher hit rate — every multi-phase pipeline trips it twice.

---

## Reproducers

### Reproducer 1 — Relaunch into previously-failed session (triggers all 3 bugs)

```bash
# 1. Launch any pickle epic
node ~/.claude/pickle-rick/extension/bin/setup.js --tmux --max-iterations 1 --task "noop"
# (let it run to a forensic exit — readiness halt, signal, stall, fatal — any forensic path)

# 2. Relaunch via pipeline-runner OR mux-runner against the same session
SESSION_ROOT=<path-to-session>
node ~/.claude/pickle-rick/extension/bin/setup.js --tmux --resume "$SESSION_ROOT"
node ~/.claude/pickle-rick/extension/bin/pipeline-runner.js "$SESSION_ROOT"

# 3. Observe failures:
#    a) tmux list-panes -t <session>:1 -F "#{pane_current_command}" → 4× zsh (Bug A + Bug B)
#    b) cat $SESSION_ROOT/state.json | jq .exit_reason → still the old terminal value (Bug C trigger 1)
#    c) loop is actually running fine (state.active: true, iterations advancing, commits landing)
```

### Reproducer 2 — Phase transition (triggers Bug C only, observable on every multi-phase run)

```bash
# 1. Launch any /pickle-pipeline run with ≥2 phases (e.g. pickle + anatomy-park)
node ~/.claude/pickle-rick/extension/bin/setup.js --tmux --task "your task" --backend codex
# Write pipeline.json with phases ["pickle", "anatomy-park", "szechuan-sauce"]
node ~/.claude/pickle-rick/extension/bin/pipeline-runner.js "$SESSION_ROOT"

# 2. Wait for pickle phase to complete (clean success)
# 3. During the ~2-3s gap between pickle exit and anatomy-park's first iteration:
cat $SESSION_ROOT/state.json | jq '{step, current_ticket, exit_reason, command_template, pid}'
# Output during gap:
#   step: "review"                       ← stale from pickle finalizeTerminalState
#   current_ticket: null                 ← stale from pickle exit
#   exit_reason: "success"               ← stale from pickle exit
#   command_template: "anatomy-park.md"  ← updated by anatomy-park spawn
#   pid: <microverse-runner-pid>         ← updated by anatomy-park spawn
# Two phases worth of state coexist in one snapshot.

# 4. After anatomy-park's first iteration overwrites step/current_ticket, exit_reason still lingers
#    until the next forensic exit OR the next phase transition.
```


---

## Acceptance Criteria

### Bug A — ordering fix
- **AC-LRR-A1** `mux-runner.ts` startup sequence: `Session ownership taken` log line appears BEFORE `ensureMonitorWindow:` log line on every relaunch.
- **AC-LRR-A2** Integration test in `extension/tests/mux-runner-relaunch.test.js`: pre-write `state.json` with `active: false`, `exit_reason: "fatal"`. Spawn mux-runner. Assert `restartDeadWatcherPanes` is invoked AFTER `state.active` is flipped to true.
- **AC-LRR-A3** Existing AC-WPR-03 invariant ("active=false → no respawn") still holds — verified by the existing WPR test suite remaining green.

### Bug B — pane 0 recovery
- **AC-LRR-B1** `restartDeadWatcherPanes` (or sibling helper) respawns pane 0 (`monitor.js` dashboard) when its `pane_current_command !== 'node'` AND `state.active: true`.
- **AC-LRR-B2** Regression test in `extension/tests/ensure-monitor-window.test.js`: existing window with all 4 panes at zsh + active=true → all 4 respawned. Pre-existing 3-pane test cases (panes 1, 2, 3) remain green.
- **AC-LRR-B3** WPR PRD's non-goal "Recovering dead monitor.js" is removed; replace with positive ENFORCE for the new test case.

### Bug C — exit_reason clear on reactivation AND phase transition
- **AC-LRR-C1** `setup.ts --resume` clears `state.exit_reason: null` in the same atomic write that sets `active: true`.
- **AC-LRR-C2** `mux-runner.ts` Session ownership taken path clears `state.exit_reason: null` in the same atomic write that flips active.
- **AC-LRR-C3** `microverse-runner.ts` Session ownership taken path clears `state.exit_reason: null` AND `state.current_ticket: null` (microverse runs are not per-ticket scoped) in the same atomic write that flips active.
- **AC-LRR-C4** `pipeline-runner.ts` phase-entry transition clears `state.exit_reason: null` and `state.step: null` (or to phase-default like `'research'`) BEFORE spawning the next phase's runner, so observers don't see prior-phase state during the transition gap.
- **AC-LRR-C5** New helper `clearExitReason(statePath, opts?: { resetStep?: boolean, resetCurrentTicket?: boolean })` exported from `pickle-utils.ts` (paired with existing `recordExitReason`), used by all four transition sites.
- **AC-LRR-C6** Unit test: pre-write state with `exit_reason: "fatal"`, `step: "review"`, `current_ticket: "abc"`. Call `clearExitReason(statePath, {resetStep: true, resetCurrentTicket: true})`. Assert all three nulled. Call without opts. Assert only exit_reason cleared. Assert no other field touched.
- **AC-LRR-C7** Integration test (relaunch): after relaunch into a previously-failed session, state.exit_reason is null (not the leftover terminal value).
- **AC-LRR-C8** Integration test (phase transition): mock pipeline-runner with phases `["pickle", "anatomy-park"]`; after pickle phase clean exit, snapshot state during the gap before anatomy-park spawns. Assert `exit_reason === null`. Assert `step` is null OR equal to anatomy-park's phase-default. Assert no `step: "review"` leak from pickle.

### Cross-cutting
- **AC-LRR-D1** `extension/CLAUDE.md` trap-door catalog updated: WPR entry expanded to cover pane 0; new entry for `clearExitReason` invariant.
- **AC-LRR-D2** Full test suite passes — `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test`.
- **AC-LRR-D3** Reproducer above passes: relaunch into a forensic-exited session shows all 4 panes alive + `exit_reason: null` within 2s of `Session ownership taken`.

---

## Verification Plan

1. **Unit tests** (Bug C): clearExitReason isolation — pre/post state diff confirms only `exit_reason` field touched.
2. **Integration tests** (Bugs A + B + C): tmpdir + tmux harness, mock state.json with each forensic exit_reason value, run mux-runner startup, capture log + final state.
3. **Manual reproducer**: kill a real session mid-research, relaunch, confirm all 4 panes respawn + state clean.
4. **Regression**: existing watcher-self-termination tests (AC-WPR-03) still green — `active: false` still blocks respawn.

---

## Non-Goals

- Not redesigning the watcher self-termination contract. Watchers correctly exit on `active: false`. The bugs are in the reactivation path, not the termination path.
- Not adding "is the loop healthy?" status checks beyond `exit_reason`. That field staying clean is sufficient.
- Not fixing the underlying cause of yesterday's readiness halt — that's already fixed in v1.63.0 (`--skip-readiness <reason>` flag + 9-ticket reauthor). This PRD is about presentation hygiene on relaunch.
- Not migrating away from tmux send-keys to a more robust pane-message protocol. That's a separate ergonomic improvement.

---

## Risks

| ID | Risk | Mitigation |
|---|---|---|
| R-LRR-1 | Reordering `ensureMonitorWindow` after `Session ownership taken` exposes a window where the runner is "active" but the monitor hasn't been refreshed → status reads might briefly see active without watcher updates | Window is sub-second; existing watchers poll on 2s cadence so worst-case operator-visible delay is one cycle. Acceptable. |
| R-LRR-2 | Clearing `exit_reason` on reactivation loses forensic data from the prior run | Forensic data lives in tmux-runner.log, hooks.log, and per-iteration logs — those are already write-once. exit_reason was redundant tag. |
| R-LRR-3 | Pane 0 respawn might race with `monitor.js` self-termination loop, causing a flicker | restartDeadWatcherPanes already handles this for panes 1-3 via "command !== 'node'" check; same logic applies to pane 0. |
| R-LRR-4 | Bug C fix changes write-pattern in setup.ts and mux-runner.ts; risk of touching unrelated state fields if implemented sloppily | AC-LRR-C4 isolation test pins the diff to exit_reason only. |
| R-LRR-5 | Empirical "monitor.js shouldn't die" assumption may have been correct under most load → readiness-halt was an unusual death mode. Extending recovery may mask other dashboard bugs | Net positive: dashboard recovery should be unconditional regardless of cause. If monitor.js has a real bug, restart will surface it (it'll re-die). |
| R-LRR-6 | All three fixes touch the runner startup path — risk of a subtle change-of-meaning interacting with `finalizeTerminalState` / `safeDeactivate` (per the v1.62.2 invariant catalog) | Each AC verifies via the existing trap-door tests for clean-success vs forensic exit paths. Don't merge until those are green. |

---

## Files Likely Touched

```
extension/src/bin/mux-runner.ts            # Bug A ordering + Bug C clear (mux-runner ownership)
extension/src/bin/microverse-runner.ts     # Bug C clear (microverse-runner ownership, anatomy-park entry)
extension/src/bin/pipeline-runner.ts       # Bug C clear (per-phase transition)
extension/src/bin/setup.ts                 # Bug C clear on --resume
extension/src/services/pickle-utils.ts     # Bug B pane 0 + Bug C clearExitReason helper
extension/CLAUDE.md                        # WPR entry updated; new clearExitReason entry; phase-transition invariant
extension/tests/mux-runner-relaunch.test.js              # NEW (Bug A integration)
extension/tests/ensure-monitor-window.test.js            # extend (Bug B 4-pane case)
extension/tests/clear-exit-reason.test.js                # NEW (Bug C unit + relaunch + phase transition)
extension/tests/setup.test.js                             # extend (Bug C resume case)
extension/tests/pipeline-runner.test.js                  # extend (Bug C phase transition case)
extension/tests/microverse.test.js                       # extend (Bug C ownership claim case)
extension/package.json                                    # register 2 new test files
```

Total estimate: ~350-450 LOC source + ~200 LOC tests = **~500-650 LOC**. (Bumped from prior ~400-500 estimate after Bug C scope expansion to cover phase transitions.)

---

## Atomic Tickets (rough decomposition for refiner)

| Order | ID | Title | Tier |
|---|---|---|---|
| 10 | LRR-T1 | Bug C: `clearExitReason(statePath, opts?)` helper + unit tests | small |
| 20 | LRR-T2 | Bug A: reorder mux-runner startup so Session ownership taken comes BEFORE ensureMonitorWindow | medium |
| 30 | LRR-T3 | Bug B: extend `restartDeadWatcherPanes` to cover pane 0 (monitor.js) + 4-pane regression test | medium |
| 40 | LRR-T4 | Wire `clearExitReason` into `setup.ts --resume` + `mux-runner.ts` ownership claim (relaunch path) | small |
| 50 | LRR-T5 | Wire `clearExitReason` into `microverse-runner.ts` ownership claim + `pipeline-runner.ts` per-phase transition (phase transition path) | medium |
| 60 | LRR-T6 | Update `extension/CLAUDE.md`: WPR pane-0 invariant + `clearExitReason` invariant + phase-transition forensic-marker reset invariant | small |

6 tickets total; ~4-5 hours on codex backend.

---

## Linked Context

- Live debug session evidence: `~/.local/share/pickle-rick/sessions/2026-04-30-bc104e78/`
- Surfaced during v1.63.0 overnight bundle (T1-T9 — 9/10 done at time of bug discovery)
- Original WPR PRD with the non-goal that Bug B violates: `prds/archive/features/watcher-pane-recovery.md` §Non-goals
- Trap-door catalog with the AC-WPR-03 invariant: `extension/CLAUDE.md` `restartDeadWatcherPanes` entry
- recordExitReason invariant: `extension/CLAUDE.md` mux-runner / pipeline-runner deactivation entries (introduced v1.62.2)

---

## Rollout

1. Slot into next overnight bundle after v1.63.0 ships (this current run's T9 must complete first)
2. Could also stack on top of `prds/hermes-integration.md` as part of the same bundle since both are post-v1.63.0 follow-ups
3. v1.63.x patch release (or v1.64.0 minor if bundled with hermes)

## Operator workaround (until shipped)

When monitor looks dead after a relaunch:

```bash
# Clear stale exit_reason
node -e 'const fs=require("fs");const p="<SESSION_ROOT>/state.json";const s=JSON.parse(fs.readFileSync(p,"utf8"));s.exit_reason=null;fs.writeFileSync(p,JSON.stringify(s,null,2));'

# Respawn watcher panes 1-3
node -e '
import("'"$HOME"'/.claude/pickle-rick/extension/services/pickle-utils.js").then(m => {
  const mode = m.inferMonitorMode("<SESSION_ROOT>");
  m.restartDeadWatcherPanes("<SESSION_ROOT>", "'"$HOME"'/.claude/pickle-rick", mode);
});
'

# Manually relaunch monitor.js in pane 0
tmux send-keys -t <SESSION_NAME>:1.0 "node $HOME/.claude/pickle-rick/extension/bin/monitor.js <SESSION_ROOT>" Enter
```

This is exactly what got run live during the v1.63.0 debug at 09:35 CDT and recovered the monitor cleanly.

---
title: P2 — stop-hook blocks launcher conversation of tmux bundle via mapped-orphan session (compounds with recoverStaleActiveFlag gap)
status: Draft
date: 2026-05-04
priority: P2
type: bug
peer_prds:
  related:
    - prds/archive/bundles/p1-bug-fix-bundle-2026-05-04.md          # observed during this bundle's launch
    - prds/archive/bug-reports/p3-pipeline-runner-dirty-tree-guard-blocks-self-cleanup.md  # adjacent — same launch hour
    - prds/archive/bug-reports/p3-paused-session-orphan-blocks-stop-hook.md                # parent — paused-orphan demotion
---

# PRD — stop-hook blocks launcher conversation when tmux owns the loop

## Symptoms

After successfully launching the P1 bug-fix bundle into `tmux pipeline-f416c6cc` on 2026-05-04 PM, the **launcher conversation** (Claude Code chat that ran `/pickle-pipeline`) repeatedly received `Stop hook feedback: 🥒 **Pickle Rick Loop Active** (Iteration 0 of 100)` on every turn-end. The launcher's job was complete (mux-runner had been spawned in tmux); the loop driver was now the tmux session, not the launcher chat. But the stop-hook kept the chat alive forever, burning conversation context on micro-checks.

Forensic ladder uncovered **three compounding bugs**:

| # | Bug | Location | Severity |
|---|---|---|---|
| 1 | **Stop-hook default-fallthrough has NO `tmux_mode` check** — for tmux-owned loops the launcher chat should APPROVE; instead it BLOCKs. | `extension/src/hooks/handlers/stop-hook.ts:198-203` | **P2** |
| 2 | **`recoverStaleActiveFlag` did not demote orphan session `2026-05-04-b20c7a0a`** despite `pid=null` AND `current_sessions.json` mapped PID 85257 being dead. | `extension/src/services/state-manager.ts (paused-orphan demotion trap-door)` | **P2** |
| 3 | **Stop-hook resolved launcher's cwd to the orphan first, not the live bundle session** — orphan was the most-recently-mapped entry for the cwd; mapped-session-filter rules at `src/hooks/resolve-state.ts (mapped-session filter)` should have skipped it. | `extension/src/hooks/resolve-state.ts` | **P3** |

The user-visible "Iteration 0 of 100" text the launcher received was **the orphan session's iteration display** — not the live bundle session (`f416c6cc`, `iteration=2`, `max_iterations=∞`). Bug #3 fed wrong state into the hook; bug #1 then BLOCKed even though there's no work for the launcher to do. Bug #2 explains why the orphan was still `active=true` instead of being demoted.

## Forensic ladder (in order discovered)

### Pass 1 — observed text doesn't match live state

```
$SESSION_ROOT=/Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-04-f416c6cc
$ jq '{active,iteration,max_iterations,backend}' "$SESSION_ROOT/state.json"
{ "active": true, "iteration": 2, "max_iterations": 0, "backend": "codex" }
# But user saw: "🥒 Pickle Rick Loop Active (Iteration 0 of 100)"
```

### Pass 2 — stop-hook source review

```ts
// extension/src/hooks/handlers/stop-hook.ts:195-203
const maxIter = finiteNumber(state.max_iterations);
const curIter = finiteNumber(state.iteration);
const iterSuffix = maxIter > 0 ? ` of ${maxIter}` : '';
return {
  decision: 'block',
  reason: `🥒 **Pickle Rick Loop Active** (Iteration ${curIter}${iterSuffix})`,
  logMessage: 'Decision: BLOCK (Default continuation)',
  token,
};
```

For `max_iterations=0` (unlimited), the suffix is empty — text would be just `Iteration 2`. The user saw `Iteration 0 of 100` → state read MUST be from a different session.

### Pass 3 — `current_sessions.json` mapping

```json
"/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude": {
  "sessionPath": "/Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-04-b20c7a0a",
  "pid": 85257
}
```

The cwd is mapped to **orphan session `b20c7a0a`** (PID 85257), not the live bundle `f416c6cc`. PID 85257 was DEAD (`ps -p 85257` → no match).

### Pass 4 — orphan session state

```bash
$ jq '{active,iteration,max_iterations,pid,started_at}' /path/to/b20c7a0a/state.json
{ "active": true, "iteration": 0, "max_iterations": 100, "pid": null, "started_at": "2026-05-04T18:32:00.346Z" }
```

`active: true` AND `pid: null` AND mapped owner PID dead — exactly the demotion trigger described in `extension/CLAUDE.md` `state-manager.ts (paused-orphan demotion)` trap-door:

> INVARIANT: `recoverStaleActiveFlag` demotes a session whose `active=true` but PID is dead AND no current claim is found, recording `exit_reason='orphan-paused-no-claim'` and emitting a `paused_session_orphan_demoted` activity event.

Recovery did NOT fire. The orphan stayed `active=true` for 30+ minutes, shadowing the live bundle session for any cwd-based resolution.

### Pass 5 — stop-hook log shows BLOCK on the orphan

```
[2026-05-04T18:35:16.120Z] [StopHookJS] State file found: .../b20c7a0a/state.json
[2026-05-04T18:35:16.120Z] [StopHookJS] State: active=true, iteration=0/100
[2026-05-04T18:35:16.121Z] [StopHookJS] Decision: BLOCK (Default continuation)
```

Hook found the orphan, read `active=true`, BLOCKED the launcher chat with the message `Iteration 0 of 100` — feedback the user observed.

## Why this is distinct from `prds/archive/bug-reports/p3-paused-session-orphan-blocks-stop-hook.md`

The parent PRD shipped via the reliability bundle (Section C). Its fix targets `recoverStaleActiveFlag` to demote paused sessions. But that demotion path:
- Triggers only when state-manager READS the orphan state
- Is currently keyed off `state.pid` being a dead PID — null is treated as "no claim attempted yet"
- Doesn't consult `current_sessions.json` map for the actual owning PID

This bug is a **second-order failure**: when the orphan was created by an inner pipeline-runner spawn (writing state.json with no `state.pid` claim because the worker died before claiming), `recoverStaleActiveFlag` never demotes it because the keying field is null, not dead. The actual owning PID is in `current_sessions.json` — which the demotion path doesn't consult.

Plus: even if recovery DID fire, the stop-hook would still BLOCK the launcher conversation when state.tmux_mode=true and the loop is running in tmux. That's a separate issue captured as Bug #1 above.

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| **R-SHB-1** | `extension/src/hooks/handlers/stop-hook.ts:198-203` default-fallthrough adds `state.tmux_mode === true` check. When true, return `{ decision: 'approve', logMessage: 'Decision: APPROVE (tmux owns this loop, launcher may stop)', token }`. The launcher conversation IS the wrong place to drive a tmux-owned loop. | P0 |
| **R-SHB-2** | `extension/src/services/state-manager.ts:recoverStaleActiveFlag` extends demotion logic: when `state.pid === null` AND the cwd's `current_sessions.json` entry maps to a dead PID, treat as orphan and demote with `exit_reason='orphan-paused-no-claim'` + `paused_session_orphan_demoted` activity event. Bridges the gap between "no claim attempted" and "claim attempted but dead". | P1 |
| **R-SHB-3** | `extension/src/hooks/resolve-state.ts (mapped-session filter)` extended: a mapped session whose `current_sessions.json` PID is dead AND state.json shows `active=true` with `pid=null` is treated as orphan and skipped before live-same-cwd-fallback rank. Prevents the resolve from selecting orphans. | P2 |
| **R-SHB-4** | New trap-door in `extension/CLAUDE.md`: `src/hooks/handlers/stop-hook.ts (tmux passthrough)` — INVARIANT: default-fallthrough APPROVEs when `state.tmux_mode === true` (launcher conversations of tmux-owned loops MUST be allowed to stop). ENFORCE: `extension/tests/stop-hook-tmux-passthrough.test.js`. | P1 |

## Acceptance Criteria

| AC | Verification |
|---|---|
| **AC-SHB-01** | Launcher conversation for a tmux-owned loop receives APPROVE decision on stop. Type: test. Fixture: `state.tmux_mode=true`, `state.active=true`, no tokens in transcript → result.decision === 'approve'. |
| **AC-SHB-02** | Orphan session with `state.active=true`, `state.pid=null`, mapped PID dead → demoted on next state read. Verify: regression fixture in `extension/tests/services/recover-stale-active-flag-mapped-orphan.test.js`. Type: test. |
| **AC-SHB-03** | Mapped-session filter skips orphan + ranks live-same-cwd fallback above. Verify: extend `extension/tests/resolve-state.test.js` with mapped-orphan fixture. Type: test. |
| **AC-SHB-04** | Trap-door enforced. Type: lint. |
| **AC-SHB-05** | E2E: launch a fresh tmux pipeline session, observe launcher chat NOT blocked by stop-hook. Type: integration. |

## Workaround until R-SHB-1..4 land

```bash
# When you observe repeated "Pickle Rick Loop Active" feedback on a tmux-owned session:
ORPHAN=~/.local/share/pickle-rick/sessions/<orphan-hash>
LIVE=~/.local/share/pickle-rick/sessions/<live-hash>

# 1. Demote the orphan
jq '.active = false | .exit_reason = "orphan-paused-no-claim"' "$ORPHAN/state.json" > /tmp/s.json && mv /tmp/s.json "$ORPHAN/state.json"

# 2. Update current_sessions.json to point to the live session
jq --arg cwd "$(pwd)" --arg path "$LIVE" '.[$cwd] = {sessionPath: $path, pid: 0}' \
   ~/.local/share/pickle-rick/current_sessions.json > /tmp/cs.json && mv /tmp/cs.json ~/.local/share/pickle-rick/current_sessions.json
```

Note: even with the workaround, R-SHB-1 is still needed because the live session itself has `active=true` and the launcher chat will still be blocked by the default-fallthrough until the bundle finishes ~17h later.

## Cross-references

- Bundle session: `~/.local/share/pickle-rick/sessions/2026-05-04-f416c6cc/` (live)
- Orphan session: `~/.local/share/pickle-rick/sessions/2026-05-04-b20c7a0a/` (pid=null, active=true, demoted manually as workaround)
- Orphan creation timeline: 18:32:00.346Z (~12 min after pipeline launch at 18:31:48Z) — orphan was created by an inner pipeline-runner spawn that wrote state.json before the worker claimed PID
- current_sessions.json mapping: `/Users/gregorydickson/.local/share/pickle-rick/current_sessions.json`
- Hooks log on bundle session: `$SESSION_ROOT/hooks.log` (44 entries; latest at 18:19:38Z, then silence — hook stopped writing here when current_sessions.json flipped to orphan)
- Hooks log on orphan: `$ORPHAN/hooks.log` (continued BLOCK decisions through 18:35:26Z when forensic was run)
- Source: `extension/src/hooks/handlers/stop-hook.ts:198-203` (default-fallthrough no-tmux-mode-check)
- Source: `extension/src/services/state-manager.ts (paused-orphan demotion trap-door)` — current implementation keys off `state.pid` only; needs map-PID-dead bridge
- Parent: `prds/archive/bug-reports/p3-paused-session-orphan-blocks-stop-hook.md` — different angle on the same orphan-shadowing failure mode

— Pickle Rick out. *belch*

---

## 2026-05-05 mid-day forensic addendum — phantom map entries after pipeline crash

**Discovered while recovering from run #5 crash (bundle session `2026-05-04-f416c6cc` exited at 05:44 with `exit_reason="failed"`, `active=false`).**

After the crash, `~/.local/share/pickle-rick/current_sessions.json` contained TWO new entries pointing at session paths that **did not exist on disk**:

```json
"/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude": {
    "sessionPath": ".../sessions/2026-05-05-e7af445b",
    "pid": 75005
},
"/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude/extension": {
    "sessionPath": ".../sessions/2026-05-05-0e4f6e9c",
    "pid": 17453
}
```

Verification: `ls -d ~/.local/share/pickle-rick/sessions/2026-05-05-e7af445b` → does not exist. Same for `0e4f6e9c`. The map points at nothing.

**This is a NEW failure mode beyond the three bugs originally filed**:

### R-SHB-5 (NEW) — `recoverStaleActiveFlag` should demote on missing-sessionDir

**Bug**: When a worker spawn (or auto-resume script, or test fixture) writes a `current_sessions.json` entry but the session dir is later deleted (or was never created), the map entry persists. Future cwd-resolution rounds rank that orphan above any live same-cwd session.

**Current behavior**: `recoverStaleActiveFlag()` checks `state.pid` liveness AND mapped-PID liveness, but does NOT check whether `sessionPath` exists on disk. If the session dir is gone, the recovery short-circuits and leaves the map entry intact.

**Fix**: extend `recoverStaleActiveFlag` (or add a sibling `pruneOrphanedMapEntries`) — for each `current_sessions.json` entry, verify `sessionPath` exists AND `state.json` exists at that path. Missing → demote with `exit_reason='orphan-session-dir-missing'` and emit `phantom_session_demoted` activity event.

**Test**: integration test that writes a current_sessions.json entry pointing at a non-existent path, runs the recovery routine, asserts the entry is removed and the event fired.

### R-SHB-6 (NEW) — mux-runner should clean its OWN map entry on terminal exit

**Bug**: When `mux-runner.ts` exits via the forensic path (`finalizeTerminalState({ exitReason: 'failed' })` or signal handler `safeDeactivate`), it leaves the runner's own `current_sessions.json` entry pointing at a now-inactive session. The next cwd resolution sees `active=false` (correct) but the entry persists indefinitely.

**Compounded with R-SHB-5**: the entry's path still exists (it's the dead session itself, not a phantom), so R-SHB-5's prune doesn't fire. Need separate logic: "active=false" + "exit_reason ∈ failed/orphan-paused-no-claim" → `pruneOrphanedMapEntries` removes the entry on the next cwd-resolve hit OR mux-runner removes it explicitly at deactivation.

**Fix**: add map-entry cleanup to the forensic exit paths in `mux-runner.ts` deactivation invariant. Update trap-door entry to require map cleanup alongside `safeDeactivate + recordExitReason`.

**Test**: `mux-runner.test.js` extended to assert that after `finalizeTerminalState({ exitReason: 'failed' })`, the matching `current_sessions.json` entry is removed (or its inactive flag is detected on the next read).

### Operator workaround applied 2026-05-05 mid-day

After run #5 crash, operator manually edited `current_sessions.json` to remove the two phantom entries before relaunching run #6 (recovery sequence: phantom prune → R-WSE-1 reset to Todo → relaunch). Documented here as evidence that the gap is exploitable in practice and the workaround is non-obvious. Slot 1n's existing 4 R-SHB requirements + these 2 NEW requirements bring the total to 6.

---
status: draft
priority: P2
filed: 2026-05-05
slot: 1u
forensic_origin: bundle session 2026-05-04-f416c6cc run #5 (live observation 2026-05-05 02:11 local)
related: prds/archive/features/p3-monitor-watcher-continuous-auto-respawn.md
---

# PRD: Manager Stop-Hook Nudge Cadence Wastes Turns During Worker Waits

**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`

## Problem

When a manager-loop manager is **idle waiting on a long-running worker** (large tier ≥30min budgets), the stop-hook nudges the manager via synthetic stop-hook-feedback messages at ~2 second cadence. The manager has no work to do — the worker is mid-flight, no new artifacts yet — so it replies with a no-op like `"Waiting for Monitor signal."` (8 output tokens, the same input cache).

Live forensics from session `2026-05-04-f416c6cc` run #5, 2026-05-05 ~02:11 local:

- Worker for ticket `51d826c9` (R-CNAR-1, large) launched at 02:04. Research + plan artifacts landed 02:09–02:10. Worker still in implement/verify phase at 02:11+.
- Manager log `tmux_iteration_2.log` (~600KB at observation): **154 stop-hook turns in ~27 minutes of worker activity**.
- Of those 154, **133 are identical `"Waiting for Monitor signal."` replies** (8 output tokens each). The remainder are short substantive observations like *"Worker still alive (PID 76464). Conformance landed but code_review not yet — Morty still on review phase."*

Per turn cost = ~62 cache-creation tokens + 153,400 cache-read tokens + 8 output tokens. Cache reads are cheap, but the manager's `--max-turns 400` budget is **blown through at ~50 turns/15min during worker waits**. At that rate, a single large worker (80min budget) consumes ~270 manager turns just **waiting**. Two consecutive large workers exceed the cap, forcing a mid-worker manager respawn — which works, but is gratuitous: nothing changed; the new manager re-reads state and resumes waiting.

**Why this is a P2, not a P3:**

- Direct cost: every wasted manager turn is ~150K cache-read tokens. Across a 62-ticket bundle with ~10 large-tier tickets, that's potentially **300K wasted manager turns × 150K tokens = ~45B cache-read tokens**, none of which produce work.
- Indirect cost: forced manager respawns mid-worker are silent failure-mode magnets — anything that goes wrong during respawn (state read race, current_ticket forensics, etc.) adds noise to bundle postmortems.
- Operator perception: "monitor isn't updating" complaints (which is what filed this PRD) are the *correct read of a wrong root cause* — the real symptom is manager turn churn with zero state-delta.

## Root cause (preliminary — refinement to confirm)

Two candidate mechanisms, possibly compounding:

### M1 — Stop-hook always says "continue" when active

`extension/src/hooks/handlers/stop-hook.ts` returns `approve` (continue) whenever `state.active === true && session is not over budget`. When the manager has just emitted "Waiting for Monitor signal." (no tool calls, no state changes), the hook still nudges immediately. There's no "manager is genuinely idle, slow the cadence" mode.

### M2 — No event-driven nudge

The current cadence is **fixed** (~2s polling). The stop-hook does not observe:
- `state.json` mtime (no change → manager has nothing new to react to)
- Worker artifact mtimes (`research_*.md`, `plan_*.md`, `conformance_*.md`, `code_review_*.md` in `${SESSION_ROOT}/<ticket>/`)
- Worker process liveness (PID alive vs. exited)

A nudge at 2s cadence is appropriate when manager is *actively producing* (post-tool-use, post-bash). When manager output is degenerate ("Waiting for…"), nudge cadence should back off until *something downstream changes*.

## Proposal

Two-layer fix, M2 is the keystone:

1. **Backoff cadence on degenerate manager turns.** When N consecutive manager turns produce the "wait" pattern (regex match on a documented set: "Waiting for Monitor", "Worker still", "Continuing to wait"), the stop-hook switches to **event-aware nudge**: poll `state.json` mtime + worker artifact mtimes + worker PID liveness; only nudge when one of those changes OR when a hard fallback timer (configurable, default 60s) elapses.

2. **Activity instrumentation.** Emit `manager_idle_backoff_engaged` and `manager_idle_backoff_released` events so postmortems can see how often this fired and how much it saved.

The "wait pattern" detection lives **inside the stop-hook**, which has access to manager stdout via the hook payload. No manager-prompt change required (existing degenerate replies remain the trigger; manager doesn't need to know about the cadence change).

## Requirements

### R-MSCN-1 — Wait-pattern detection
- Add `WAIT_PATTERN_REGEXES` constant to `stop-hook.ts` covering observed degenerate replies:
  - `/^Waiting for Monitor signal\.?$/`
  - `/^Worker still (running|alive|in [a-z ]+ phase)/`
  - `/^Continuing to wait/`
  - `/^Worker only \d+ min old/`
  - `/^Worker \(PID \d+\) alive/`
- Refinement Cycle 2 codebase-analyst expands the list from `tmux_iteration_*.log` corpus across recent runs.

### R-MSCN-2 — Backoff state machine
- After **3 consecutive manager turns** matching `WAIT_PATTERN_REGEXES`, stop-hook transitions to **idle-backoff** mode.
- In idle-backoff mode, stop-hook:
  - Polls `state.json` mtime (cached at backoff entry)
  - Polls worker PID liveness (`ps -p <state.last_worker_pid>` or fallback `kill -0`)
  - Polls expected artifact paths in `${SESSION_ROOT}/<current_ticket>/` (`conformance_*.md`, `code_review_*.md`, `plan_*.md` if not yet present)
  - Returns `block` (no nudge) until ANY change OR fallback timer fires
- Fallback timer: configurable via `pickle_settings.json:manager_idle_backoff_fallback_ms` (default `60_000`).
- ANY non-wait manager turn exits idle-backoff mode immediately.

### R-MSCN-3 — Activity events
- New events:
  - `manager_idle_backoff_engaged` — emitted on transition INTO backoff. Payload: `{ session, ticket, consecutive_wait_turns, last_worker_pid }`.
  - `manager_idle_backoff_released` — emitted on transition OUT. Payload: `{ session, ticket, duration_ms, release_reason: 'state_mtime'|'worker_exit'|'artifact_landed'|'fallback_timer' }`.
- Both registered in `VALID_ACTIVITY_EVENTS` (`extension/src/types/index.ts`) + `activity-events.schema.json`.

### R-MSCN-4 — Tests
- `extension/tests/stop-hook-idle-backoff.test.js`:
  - 3 wait-pattern turns trigger backoff
  - 1 non-wait turn releases backoff
  - state.json mtime change releases backoff
  - artifact-file landing releases backoff
  - fallback timer releases backoff after 60s simulated time
  - `manager_idle_backoff_engaged`/`_released` events emitted with correct payloads
- Regression: `extension/tests/stop-hook-state-matrix.test.js` extended to cover the new backoff branch.
- Forensic replay: `extension/tests/integration/manager-turn-budget-large-worker.test.js` simulates a 60min worker wait and asserts manager-turn count stays under 80 (vs current ~270 unchecked).

### R-MSCN-5 — Trap-door + invariant
- Add to `extension/CLAUDE.md` `## Trap Doors`:
  > `src/hooks/handlers/stop-hook.ts` (idle backoff) — INVARIANT: manager turns matching `WAIT_PATTERN_REGEXES` for ≥3 consecutive iterations switch the hook to event-aware nudge mode; nudge resumes only on state.json mtime change, worker exit, artifact landing, or `manager_idle_backoff_fallback_ms` elapsing. BREAKS: manager `--max-turns` budget exhausts during long worker waits, forcing gratuitous mid-worker respawns. ENFORCE: extension/tests/stop-hook-idle-backoff.test.js, extension/tests/integration/manager-turn-budget-large-worker.test.js.

### R-MSCN-6 — Settings
- New `pickle_settings.json` entry: `manager_idle_backoff_fallback_ms` (default 60000, integer ≥ 1000, ≤ 600000).
- Read via `recoverableJsonRead`; promoted dead tmp same as other settings.
- `setup.ts` validates and persists.

## Acceptance Criteria

- **AC-MSCN-01** — `stop-hook.ts` detects ≥3 consecutive wait-pattern turns and enters idle-backoff mode.
- **AC-MSCN-02** — Idle-backoff exits on state.json mtime change. Verified by unit test that touches state.json mid-backoff.
- **AC-MSCN-03** — Idle-backoff exits on worker artifact landing. Verified by test that creates a `conformance_*.md` mid-backoff.
- **AC-MSCN-04** — Idle-backoff exits on worker PID exit. Verified by test that mock-kills a worker PID.
- **AC-MSCN-05** — Idle-backoff exits on fallback timer (60s default). Verified by simulated-clock test.
- **AC-MSCN-06** — `manager_idle_backoff_engaged` + `_released` events registered + emitted with correct payloads.
- **AC-MSCN-07** — Forensic replay test: 60min simulated worker wait keeps manager turn count ≤ 80 (down from ~270).
- **AC-MSCN-08** — Trap-door entry exists for `stop-hook.ts (idle backoff)` with INVARIANT/BREAKS/ENFORCE.
- **AC-MSCN-09** — `manager_idle_backoff_fallback_ms` setting reads/writes correctly + validates via `setup.ts`.

## Open Questions (refine before implement)

1. **Should idle-backoff also delay the *first* nudge after manager output, not just consecutive wait-patterns?** Recommendation: no — the first manager turn after a tool call SHOULD nudge promptly to keep momentum. Only sequences of degenerate replies trigger backoff.

2. **Should the manager prompt itself learn to say `[STOP_TURN]` instead of `"Waiting for Monitor signal."`?** Pro: cleaner; the stop-hook STOP_TURN handling already exists. Con: prompt change touches many lifecycle paths. Recommendation: defer to a follow-up; this PRD's hook-side fix is reversible without touching prompts.

3. **What's the right minimum-consecutive-wait threshold?** Currently proposing 3. Cycle 1 should validate against the live corpus — if 2 consecutive waits already indicate "wait stretch," lower the threshold.

4. **Worker artifact polling list — fixed set or derived?** Currently proposing fixed (`research_*.md`, `plan_*.md`, `conformance_*.md`, `code_review_*.md`). Cycle 2 codebase-analyst should confirm there's no other artifact class that signals "manager should react now."

## Notes

- Sister to slot 1k (`prds/archive/features/p3-monitor-watcher-continuous-auto-respawn.md`): both are about "monitor pane appears stuck during long worker waits." 1k is about pane respawn; 1u is about manager turn cadence. Independent fixes; both land in the next bundle.
- Sister to slot 1t (`prds/archive/bug-reports/p2-remove-pipeline-wall-clock-time-cap.md`): 1t removes wall-clock cap; 1u prevents manager `--max-turns` cap from biting during waits. Both shore up "let the pipeline run as long as it needs."
- This PRD does NOT touch the manager prompt. Manager continues emitting "Waiting for Monitor signal." — the hook side is the fix point.
- Live forensic file: `~/.local/share/pickle-rick/sessions/2026-05-04-f416c6cc/tmux_iteration_2.log` (~600KB at observation; 154 stop-hook turns counted).

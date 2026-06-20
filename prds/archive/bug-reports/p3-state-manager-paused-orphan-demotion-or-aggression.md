---
title: P3 — `getPausedOrphanDemotion` uses `||` between age-stale and dead-mapped-pid; fresh state with stale mapped PID gets demoted prematurely (R-POD)
status: Draft
filed: 2026-05-13
priority: P3 (recovery works in practice — the symptom is masked by a setup-side workaround in `resumeSession` that claims the session-map PID before recovery runs; the underlying state-manager logic remains over-aggressive)
type: bug
r_codes:
  - R-POD-1
  - R-POD-2
  - R-POD-3
related:
  - prds/archive/bug-reports/p1-iteration-cap-and-phantom-done-handshake.md   # R-ICP — adjacent state-manager / session-map ownership surface. R-POD touches the demotion side of the same ownership story.
---

# P3 — state-manager `getPausedOrphanDemotion` `||` is too aggressive

## Problem (one paragraph)

`extension/src/services/state-manager.ts:185` `getPausedOrphanDemotion` uses `||` between (a) `ageMs >= 300_000` (state file untouched ≥ 5 min) and (b) `deadMappedPid` (the PID recorded in `session-map.json` for this session is no longer alive). Either condition is sufficient to trigger demotion to `paused_orphan` status. Result: **a state file that was just written (fresh) but whose mapped session-map PID happens to be dead gets demoted prematurely** — the system treats a still-active, freshly-checkpointed session as an orphan. Agent `a02d0120` (the 2026-05-13 Setup/Monitor test-fix decomposer Morty) flagged this and worked around it on the setup side by having `setup.ts:resumeSession` claim the session-map PID before recovery runs. That setup-side fix is correct as a belt-and-suspenders, but the underlying state-manager predicate remains over-aggressive: the boolean operator should be `&&` (both age-stale AND dead-mapped-pid) so that a fresh state file is never demoted regardless of what `session-map.json` reports for the mapped PID.

## Observed incident

**Source**: Agent `a02d0120` decomposer-Morty output during the 2026-05-13 manual fan-out (session `2026-05-13-c122b0f7`, decomposer for R-MDS / Setup-Monitor source PRD).

**Agent's notes** (paraphrased from the decomposer worker log + ticket file):

> While auditing `resumeSession`, found that `getPausedOrphanDemotion` returns `'demote'` when **either** the state file is older than 5 minutes **or** the mapped session-map PID is dead. A fresh state (age < 1s) with a dead mapped PID would still be demoted. Fixed it on the setup side by having `resumeSession` reclaim the session-map PID before invoking recovery, but the state-manager-side `||` is too aggressive and should be `&&`.

**Why this matters**: the `session-map.json` PID can become stale for entirely benign reasons — e.g. a previous tmux-mode launch script exited and recorded a now-defunct PID, while the actual mux-runner forked off and updated its own state.json. Without the setup-side claim-first workaround (which Agent `a02d0120` added but is a side-channel — not all entry points go through `resumeSession`), the bare `getPausedOrphanDemotion` call returns `'demote'` for a healthy session.

**Setup-side workaround** (correct but masking the underlying bug):

```ts
// extension/src/bin/setup.ts:resumeSession  (post-a02d0120)
const sessionMap = readSessionMap();
const entry = sessionMap[sessionId];
if (entry && !pidAlive(entry.pid)) {
    sessionMap[sessionId] = { ...entry, pid: process.pid };
    writeSessionMap(sessionMap);
}
const recovery = recoverState(...);
```

By overwriting the session-map PID before `recoverState` (which calls `getPausedOrphanDemotion`) runs, the predicate's `deadMappedPid` branch never fires. But this only protects callers that go through `resumeSession`. Any other consumer of `getPausedOrphanDemotion` — including direct calls from `dispatch.ts`, `monitor.js`, or future call sites — gets the over-aggressive behavior.

## Root cause

The `||` predicate at `extension/src/services/state-manager.ts:185` (verify exact line on `tsc` output):

```ts
// Current (over-aggressive):
function getPausedOrphanDemotion({ ageMs, deadMappedPid }): 'demote' | 'keep' {
    if (ageMs >= 300_000 || deadMappedPid) return 'demote';
    return 'keep';
}
```

The intent (per the surrounding comments / git history) is to detect **true orphans**: sessions whose owning process is gone AND whose state hasn't been touched in a long time. Either condition alone is insufficient signal:

- **Fresh state + dead mapped PID** = a healthy session whose `session-map.json` entry is stale (e.g. launch-shell exited, mux-runner took over). Demoting this is wrong.
- **Stale state + live mapped PID** = a session whose owning process is alive but has been stuck (e.g. waiting on a slow subprocess). Demoting this is wrong (the owner could still wake up).
- **Stale state + dead mapped PID** = a true orphan. Demoting is correct.
- **Fresh state + live mapped PID** = healthy. No demotion.

The current `||` collapses cases 1+3 into "demote" and case 2 into "demote" — only case 4 escapes demotion. The correct predicate is `&&`: only demote when BOTH conditions hold.

## Source surface

**Files to touch**:

- `extension/src/services/state-manager.ts` — change `||` to `&&` at the `getPausedOrphanDemotion` predicate site (verify exact line via `grep -n "ageMs >= 300_000" extension/src/services/state-manager.ts`).
- `extension/tests/services/resolve-state-paused-orphan.test.js` — new test cases covering all 4 cells of the 2x2 `(age fresh|stale) × (mapped pid alive|dead)` matrix. Existing tests likely only cover the stale+dead case (true orphan).
- `extension/src/services/CLAUDE.md` — trap-door pin.

## Atomic tickets — R-POD family ("paused-orphan demotion")

### R-POD-1 — Change `||` to `&&` in `getPausedOrphanDemotion`

- Edit `extension/src/services/state-manager.ts` line ~185 (verify):
  - Old: `if (ageMs >= 300_000 || deadMappedPid) return 'demote';`
  - New: `if (ageMs >= 300_000 && deadMappedPid) return 'demote';`
- Update the JSDoc / comment block to reflect the new semantics: "Demote only when state is BOTH age-stale (≥5 min untouched) AND the mapped session-map PID is dead. Either condition alone is insufficient signal."
- Preserve the `activity` event emission downstream (`paused_orphan_demoted`) — only the predicate changes; the event surface is unchanged.
- File: `extension/src/services/state-manager.ts`. ~5 LOC + comment.

### R-POD-2 — Regression test: 2x2 matrix in `resolve-state-paused-orphan.test.js`

- Extend (or create) `extension/tests/services/resolve-state-paused-orphan.test.js` with four cells:
  - **Cell A**: fresh state (age 1s) + live mapped PID → `'keep'`. Existing behavior, regression guard.
  - **Cell B**: fresh state (age 1s) + dead mapped PID → `'keep'`. **NEW** — this is the case the bug demoted incorrectly. Assert `'keep'` after R-POD-1 fix.
  - **Cell C**: stale state (age 6min) + live mapped PID → `'keep'`. **NEW** — owner alive, state may resume; demotion is wrong here too. Assert `'keep'` after R-POD-1 fix.
  - **Cell D**: stale state (age 6min) + dead mapped PID → `'demote'`. True orphan. Existing behavior, regression guard.
- Use `node --test`; fixture state files written to a tmp dir; mock `pidAlive` to return the test-controlled value.
- Verify the test FAILS against current `||` predicate (Cells B and C) and PASSES against `&&` (R-POD-1).
- File: `extension/tests/services/resolve-state-paused-orphan.test.js`. ~80 LOC.

### R-POD-3 — Trap-door pin in `extension/src/services/CLAUDE.md`

- INVARIANT: `getPausedOrphanDemotion` MUST require BOTH `ageMs >= STATE_STALE_THRESHOLD_MS` AND `deadMappedPid`. Either condition alone is insufficient to demote a session — fresh state with a stale session-map PID is a healthy session whose launch-shell PID has merely rolled over, and stale state with a live mapped PID is a slow but still-owned session.
- ENFORCE: `tests/services/resolve-state-paused-orphan.test.js` covers all 4 cells of the (age, pid) matrix.
- PATTERN_SHAPE: `||` between an age-staleness check and a process-liveness check in any demotion / orphan-detection predicate. Should be `&&`.
- File: `extension/src/services/CLAUDE.md` (verify it exists; subsystem-claude-md audit 2026-05-08 noted some subsystems lack a CLAUDE.md — create if missing).

## Estimated scope

- R-POD-1..3 total: ~100 LOC across one source-file one-liner, one new test file, one trap-door entry.
- Single PR, < 1 hour worker time.
- After this lands, the setup-side claim-first workaround in `resumeSession` (added by Agent `a02d0120`) becomes redundant defense-in-depth — keep it, but it stops being load-bearing.

## Reproduction (deterministic)

1. Create a state.json with `mtime = now` (fresh).
2. Write `session-map.json` with `{ <session-id>: { pid: <DEAD_PID> } }` where DEAD_PID is any never-allocated PID (e.g. 999999 on macOS).
3. Call `getPausedOrphanDemotion({ ageMs: 1_000, deadMappedPid: true })` — current code returns `'demote'`; with R-POD-1 returns `'keep'`.
4. Equivalently: spin up a fresh mux-runner session, kill the launch shell after the runner forks, observe whether a sibling `dispatch` invocation demotes the runner's state.

## Cross-references

- **R-ICP** (`prds/archive/bug-reports/p1-iteration-cap-and-phantom-done-handshake.md`): adjacent in surface — same session-map.json ownership story. R-ICP-1/2 fixed the cap-hit code path; R-POD addresses the demotion-predicate side of the same ownership concern.
- Agent `a02d0120` decomposer worker output (session `2026-05-13-c122b0f7` refinement subdirectory) — discovery context.

## Notes

- This is P3 not P2 because the setup-side workaround in `resumeSession` (Agent `a02d0120`'s contribution) practically prevents the demotion misfire for tmux-mode and pickle-mode launches that go through the setup path. Other entry points exist (e.g. monitor pane checks, ad-hoc dispatch invocations) and would still trip the bug, but they're operator-facing rather than pipeline-killing.
- The change is small and isolated (~5 LOC source, ~80 LOC test). Worth shipping in any next bug-fix bundle that touches state-manager.ts to avoid re-merge friction.

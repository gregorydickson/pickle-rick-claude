---
r_code: B-RSHM
priority: P2
status: Todo
bundle_thesis: >
  Pure subtraction, two workstreams, one thesis: retire the deprecated interactive-lifecycle
  machinery that tmux-only operation made dead weight. WS-1 strips the stop-hook's dead non-tmux
  continuation/nudge branches (KEEPING the still-live-under-tmux idle-backoff + update-cadence).
  WS-2 retires the whole chain_meeseeks/meeseeks review-loop subsystem (superseded by
  szechuan-sauce + anatomy-park; commands already deprecated). No new code — removal + doc/test sync.
---

# B-RSHM — retire stop-hook dead-code + the chain_meeseeks subsystem

## Problem

Two deprecated-but-still-present interactive-lifecycle features survive from before tmux became the
sole launch path. Both are now dead weight or superseded, and carry test + trap-door + settings
surface that the reliable baseline does not need. (North star: subtract feature-accretion back to
the reliable baseline — see `feedback_autonomous_first_subtract_features_back_to_reliable_baseline`.)

**Premise-check (from the 2026-07-01 blast-radius map — two operator premises were partly FALSE, so
scope is corrected here):**
- **Interactive `/pickle` is confirmed gone** (`pntr-pickle-deprecated.test.js` / `pickle-deprecated.js`
  exits non-zero; no `pickle.md`). So the stop-hook's non-tmux continuation branches ARE dead. ✅
- **BUT the stop-hook is NOT fully removable:** its `evaluateManagerIdleBackoff` (manager turn-budget
  protection during long worker waits) and `maybeSpawnUpdateCheck` (auto-update-on-stop) run under
  tmux inside the manager subprocess (which has `PICKLE_STATE_FILE`, so it falls past the
  early-approve at `stop-hook.ts:824`). These STAY. ❌ (wholesale removal rejected)
- **`meeseeks.md` is load-bearing runtime infrastructure**, not just a command: `mux-runner.ts`
  loads it as the manager template for the `chain_meeseeks` flow. Deleting the file alone breaks
  `/pickle-refine-prd --meeseeks`, `/portal-gun --meeseeks`, `--chain-meeseeks` at runtime. So WS-2
  is a whole-subsystem retirement, not a file delete. ❌ (one-file-delete rejected)

## Current state (do NOT touch — SHARED / load-bearing)

- `evaluateManagerIdleBackoff` + `maybeSpawnUpdateCheck` + the tmux-passthrough APPROVE in
  `stop-hook.ts` — STAY (WS-1 keeps these).
- `.claude/agents/morty-reviewer.md`, `.claude/agents/morty-phase-reviewer.md` — SHARED with
  `/pickle-tmux`; NOT meeseeks-exclusive. STAY.
- `meeseeks_pass` activity event — fires for ANY review-clean pass (szechuan/citadel/pickle), not
  just meeseeks. STAY (keep the event name + validity).
- `setup.ts` idle-backoff plumbing (`DEFAULT_MANAGER_IDLE_BACKOFF_FALLBACK_MS`,
  `resolveManagerIdleBackoffFallbackMs`, `manager_idle_backoff_fallback_ms`) — SHARED with the
  retained idle-backoff. STAY.

## Simplification Review (subtract-before-add)

Both workstreams are **pure removal** — the ideal case. No new guard, gate, flag, state field, or
machinery is added; both leave the system smaller and flatter.
- **WS-1:** *Necessary?* Removal only — deletes the dead non-tmux branches + their tests.
  *Reuse not add?* N/A (nothing added). *Subtracts?* Yes — dead branches, their tests, and (optionally)
  the `consecutive_short_responses` field. *Guards brittle complexity?* Removes complexity from a
  heavily-tested hook without touching its live paths.
- **WS-2:** *Necessary?* Removal of a superseded, already-deprecated review loop. *Reuse not add?*
  N/A. *Subtracts?* A whole subsystem — 2 command files, ~15 mux-runner branches, a MonitorMode, a
  settings cluster, two CLI flag entry points, and their tests. *Guards brittle?* Removes a
  runtime-template coupling (`meeseeks.md not found` failure mode) entirely.
- **State-schema note (both):** `consecutive_short_responses` (WS-1) and `chain_meeseeks` (WS-2) are
  optional `State` fields. Default posture: **retain both as optional/unused to AVOID a
  `LATEST_SCHEMA_VERSION` bump** (a schema migration is new machinery — exactly what subtract-before-add
  discourages) — remove only their now-dead read/write LOGIC + field-invariant tests, leaving the
  harmless optional field. An implementer MAY remove the fields if it can be done without a schema
  bump; otherwise leave them.

## Workstreams & acceptance criteria

### WS-1 — Strip the stop-hook's dead non-tmux interactive branches
**Removes** (all dead now that `/pickle` interactive is gone + tmux is required): the non-tmux
default continuation, `review-clean` below-min continuation, `prd-complete`/`ticket-selected`
checkpoint blocks, the degenerate/short-response BLOCK-nudge branches, the `active:false` completion
mutation, and the `session-end` emission — i.e. every path guarded by `tmux_mode !== true`.
**Keeps:** `evaluateManagerIdleBackoff`, `maybeSpawnUpdateCheck`, the tmux-passthrough/early-approve,
`StateManager.read()` usage, and completion-token detection ONLY where it gates `maybeSpawnUpdateCheck`.

- **AC-RSHM-1**: `stop-hook.ts` contains no branch that returns `decision:'block'` (the hook is
  approve-only post-subtraction, since every BLOCK path was non-tmux). Verify: `grep -c "block" extension/src/hooks/handlers/stop-hook.ts` shows only type-declaration/comment occurrences, no BLOCK-return in `classifyDecision`; `node --test extension/tests/stop-hook-tmux-passthrough.test.js` green.
- **AC-RSHM-2**: idle-backoff + update-cadence are UNCHANGED — `evaluateManagerIdleBackoff` and
  `maybeSpawnUpdateCheck` remain and pass. Verify: `cd extension && node --test tests/stop-hook-idle-backoff.test.js tests/integration/manager-turn-budget-large-worker.test.js` green; `maybeSpawnUpdateCheck` still spawns `check-update.js` per the update-cadence test.
- **AC-RSHM-3**: the dead-branch tests are removed and the retained-behavior tests pass. Verify:
  `stop-hook-tmux-passthrough.test.js`, `stop-hook-idle-backoff.test.js`, `stop-hook-state-matrix.test.js` (trimmed to live paths), `stop-hook.test.js` (trimmed) all green; deleted: the non-tmux-continuation/degenerate-block test cases + `fixtures/stop-hook-states.json` entries they used.
- **AC-RSHM-4**: trap doors + State-reader coverage synced — the `tmux passthrough` + `idle backoff`
  + `update cadence` stop-hook trap doors in `extension/CLAUDE.md` + `extension/src/hooks/CLAUDE.md`
  are updated to reflect approve-only behavior (idle-backoff + update-cadence entries UNCHANGED); the
  `stop-hook.ts` State-reader coverage entry stays. Verify: `bash extension/scripts/audit-trap-door-enforcement.sh` green.
- **AC-RSHM-5**: `consecutive_short_responses` dead read/write logic removed; field retained optional
  in `types/index.ts` (no schema bump). Verify: `grep -c "consecutive_short_responses" extension/src/hooks/handlers/stop-hook.ts` == 0; `node -p "require('./extension/package.json').version"` schema-relevant version unchanged; `node --test extension/tests/state-field-invariants.test.js` green (invariant line relaxed to "optional, retained").

### WS-2 — Retire the chain_meeseeks / meeseeks review-loop subsystem
**De-wire first (order matters — the command file is a live template):** the `--meeseeks` entry
points (`.claude/commands/pickle-refine-prd.md:16,794`, `.claude/commands/portal-gun.md:12,655`),
the `--chain-meeseeks` handler + persistence (`setup.ts:682,1101,1122,1357`), `transitionToMeeseeks`
+ the ~15 `templateName === 'meeseeks.md'` branches (`mux-runner.ts:2906,3357,7484,9378…11005`), the
`chain_meeseeks` clears (`pipeline-runner.ts:1355,1539,2293`), the `MonitorMode 'meeseeks'` union +
layout branches (`pickle-utils.ts:2026,2080,2315,2352,2648`; `monitor.ts:211,216,1036`), the
`BOOLEAN_KEYS` entry (`pickle-utils.ts:1965`), and the meeseeks settings
(`default_meeseeks_min_passes`/`max_passes`/`model`, `meeseeks_model_tiers`). **Then delete** the two
command files.

- **AC-RSHM-6**: `.claude/commands/meeseeks.md` and `.claude/commands/meeseeks-zellij.md` are removed
  and no runtime path resolves `command_template === 'meeseeks.md'`. Verify: `! test -f .claude/commands/meeseeks.md`; `grep -rc "meeseeks.md" extension/src/bin/mux-runner.ts` == 0.
- **AC-RSHM-7**: the `--meeseeks` / `--chain-meeseeks` entry points are gone and no command appends
  them. Verify: `grep -rc "chain-meeseeks\|--meeseeks" .claude/commands/ extension/src/bin/setup.ts` == 0 (except a one-line deprecation note if kept).
- **AC-RSHM-8**: `transitionToMeeseeks` and all meeseeks-template branches are removed from
  `mux-runner.ts`; epic-completion no longer branches on `chain_meeseeks`. Verify: `grep -rc "transitionToMeeseeks\|chain_meeseeks" extension/src/bin/mux-runner.ts` == 0; `cd extension && npx tsc --noEmit` green.
- **AC-RSHM-9**: the `MonitorMode 'meeseeks'` layout is removed from `pickle-utils.ts` + `monitor.ts`
  and no test expects a meeseeks monitor mode. Verify: `grep -rc "'meeseeks'" extension/src/services/pickle-utils.ts extension/src/bin/monitor.ts` == 0; `node --test extension/tests/monitor-mode-resilience.test.js tests/ensure-monitor-window.test.js` green.
- **AC-RSHM-10**: SHARED assets untouched — `morty-reviewer.md`, `morty-phase-reviewer.md`, and the
  `meeseeks_pass` activity event still exist and validate. Verify: `test -f .claude/agents/morty-reviewer.md && test -f .claude/agents/morty-phase-reviewer.md`; `grep -q meeseeks_pass extension/src/types/index.ts` (event stays in `VALID_ACTIVITY_EVENTS`).
- **AC-RSHM-11**: docs synced — `help-pickle.md`, `pickle-refine-prd.md`, `portal-gun.md`,
  `pickle-standup.md` no longer offer `--meeseeks`; README needs no change (no meeseeks refs). Verify: `grep -rc "meeseeks" README.md` == 0 (already true); the four command docs updated.
- **AC-RSHM-12**: `chain_meeseeks` dead logic removed; field retained optional (no schema bump).
  Verify: `grep -rc "chain_meeseeks" extension/src/bin/ extension/src/services/` == 0 (field decl in `types/index.ts` may remain); `node --test extension/tests/setup.test.js tests/mux-runner.test.js tests/pipeline-runner.test.js` green.

### Closer ticket
- **AC-RSHM-CLOSER**: full local release gate green (tsc + eslint + all audits + fast-c4 +
  integration + expensive); compiled JS matches TS; version bumped (MINOR — removes commands + flags,
  a user-facing surface change) to the next beta; `bash install.sh` deployed (when no concurrent
  session blocks it); `git push` + `gh release`; MASTER_PLAN B-RSHM row → SHIPPED; PRD archived.

## Trap-door obligations
- WS-1 MUST NOT alter `evaluateManagerIdleBackoff` or `maybeSpawnUpdateCheck` behavior — their trap
  doors + tests stay green unchanged. A regression there re-opens the manager-turn-churn class.
- WS-2 MUST NOT delete `meeseeks.md` before every `command_template === 'meeseeks.md'` resolver and
  `chain_meeseeks` transition is removed (else runtime `meeseeks.md not found`).
- Neither workstream introduces a `LATEST_SCHEMA_VERSION` bump; optional fields are retained.

## Non-goals
- Removing `morty-reviewer`/`morty-phase-reviewer` or the `meeseeks_pass` event (SHARED).
- A state-schema migration to drop `consecutive_short_responses` / `chain_meeseeks` (retain optional).
- Touching szechuan-sauce / anatomy-park / citadel (the review loops that SUPERSEDE meeseeks).

---
title: Pipeline state desync + watcher-pane EXTENSION_DIR tmpdir respawn
status: Shipped
date: 2026-05-01
priority: P1
shipped: T0-T5 in v1.66.0; T6-T10 in v1.67.0
backend: codex-required
---

# PRD — Pipeline state desync + watcher-pane EXTENSION_DIR tmpdir respawn

Three compounding bugs surfaced live during the v1.65.0 pipeline run on session `2026-05-01-21605b33`. The pipeline ran correctly underneath, but every observability surface lied about it. Operator perception was "the loop hung" when in fact the harness was committing tickets every ~10 minutes and pipeline-runner was advancing phases — none of it visible in `state.json` or in two of the four monitor panes.

## Background

Live evidence captured at `2026-05-01T18:10Z`:

- `pipeline-runner.log` shows: PICKLE done (3 iterations, 41m, exit 0), CITADEL done (1 finding, exit 0), ANATOMY-PARK started (`gap analysis phase`), still running.
- `mux-runner.log` shows: `mux-runner finished. 3 iterations, 41m 0s` — pickle phase ran cleanly.
- `state.json` shows: `iteration: 1`, `step: "review"`, `current_ticket: null`, `activity` length=1 (one event from `17:21:34`, frozen 49 minutes), mtime stuck at `17:21:34`.
- Monitor pane 0 (dashboard): rendered successfully but stuck on the frozen state.json view.
- Monitor pane 1 (`log-watcher.js`): dead at zsh prompt with `Error: Cannot find module '/private/var/folders/2w/.../pickle-mux-runner-Z28Sqo/extension/bin/log-watcher.js'`.
- Monitor pane 3 (`raw-morty.js`): dead at zsh prompt with the same `MODULE_NOT_FOUND` against a `pickle-mux-runner-XXXXX` tmpdir path.

Six commits landed correctly during the dead window (`80f5c2a` … `67a2ca0`). Functionally the loop succeeded; observably it was opaque.

## Root Cause Analysis

### Bug 1 — runner state-update sync (`mux-runner.ts`, `pipeline-runner.ts`)

`mux-runner.ts:1760` increments a **local** `iteration` variable per outer-loop pass and emits `--- Iteration N (state.iteration=0) ---` to `mux-runner.log`. That local counter is read by:

- `buildHandoffSummary(state, sessionDir, iteration + 1)` for worker prompts
- `logActivity({ event: 'iteration_start', iteration })` (line 1764)
- `logActivity({ event: 'iteration_end', iteration })` (line 1888)

It is **never written back to `state.json`**. The trap-door INVARIANT for `state.iteration` (`state-field-invariants.test.js`) only requires that the field be a finite integer — it does not require runners to advance it. So the test suite is green while the field is silently zero forever.

Consumers that read `state.iteration` get a stale value:
- `monitor.ts` dashboard renders the wrong iteration number.
- `mux-runner.ts:1748` `state.iteration has not advanced in 2 outer-loop iterations (stuck at ${state.iteration})` — this stall detection is **broken by design**: `state.iteration` cannot advance because nothing writes it.
- `setup.ts` resume logic that reads `state.iteration` to decide whether to start fresh.

### Bug 2 — pipeline phase transitions don't update `state.step`

`pipeline-runner.ts:1356` `writeRunningStatus()` writes `pipeline-status.json` with `current_phase` on each phase boundary. It does **not** update `state.json` `step` or `current_ticket`. Per the trap-door catalog, `step` should "advance only through lifecycle transitions understood by runners and status" — but pipeline-runner is the orchestrator that drives those transitions and it touches a sibling JSON file, not the canonical `state.json` field.

Result: when PICKLE phase exits with `step: "review"` (the last value mux-runner wrote, via `finalizeTerminalState({step:'completed'})` — wait, that should have advanced step to `"completed"`. Let me re-check: pickle phase exited cleanly per `pipeline-runner.log:Phase pickle completed successfully`, but state.step is `"review"`, not `"completed"`. **So Bug 2 has a sub-bug**: mux-runner's finalize at the end of the pickle phase didn't fire either, OR pipeline-runner reset step to `"review"` for the next phase and never advanced it.

Either way: `state.step` is the wrong field by the time anatomy-park starts, and pipeline-runner does nothing to correct it.

The trap-door INVARIANT for the recently-shipped LRR-T5 says: "phase entry clears stale prior-phase `exit_reason` and `step` before spawning the next runner". This is wired for `exit_reason` but the `step` clear-and-set-to-the-new-phase is missing.

### Bug 3 — `getExtensionRoot()` trusts a stale `EXTENSION_DIR` env var

`pickle-utils.ts:178`:

```ts
export function getExtensionRoot(): string {
  return process.env.EXTENSION_DIR || path.join(os.homedir(), '.claude/pickle-rick');
}
```

There is **no validation** that `EXTENSION_DIR` points at a real directory containing `extension/bin/log-watcher.js`. The dead panes show the launcher tried:

```
node /private/var/folders/2w/.../pickle-mux-runner-Z28Sqo/extension/bin/log-watcher.js
```

`pickle-mux-runner-` is the **test-fixture tmpdir prefix** from `extension/tests/mux-runner.test.js:17`:

```js
return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mux-runner-')));
```

A prior test run set `EXTENSION_DIR=<tmpdir>` in the user's parent shell environment (or it was inherited via tmux's `update-environment`). Tmux passes its environment to all panes, so when pipeline-runner spawned the watcher panes via `ensureMonitorWindow`, `getExtensionRoot()` returned the test tmpdir. The tmpdir was already cleaned up by `rmdirSync` at test teardown, so `node` couldn't find the script.

`restartDeadWatcherPanes` (`pickle-utils.ts:1266`, just shipped as LRR-T2) re-uses the same `getExtensionRoot()` call, so respawn retries used the same broken path — both `Z28Sqo` and `JXZi5X` suffixes appear in pane history, evidence of multiple respawn cycles all targeting the same dead tmpdir.

The fix surface is in three places, all bounded:

1. `getExtensionRoot()` validates the directory contains `extension/bin/log-watcher.js` and falls back to `~/.claude/pickle-rick` when the override is broken.
2. The fallback emits a one-line warning to `stderr` and `state.activity` so the operator knows the env var was ignored.
3. `tmux new-session` / `tmux new-window` invocations either (a) explicitly clear `EXTENSION_DIR` for production launches, or (b) the env var is named differently for test isolation (`EXTENSION_DIR_TEST` or similar) so production code never sees a test override.

## Functional Requirements

- **FR-1** — `mux-runner.ts` writes `state.iteration` to `state.json` at the start of each outer-loop iteration, before `logActivity({ event: 'iteration_start' })`. Atomic via `StateManager.update()`.
- **FR-2** — `mux-runner.ts` writes `state.current_ticket` to `state.json` whenever the local `currentTicket` variable changes (ticket selected, ticket completed, ticket null between tickets). Atomic.
- **FR-3** — `mux-runner.ts` writes `state.step` to `state.json` on each lifecycle phase transition (`research` → `plan` → `implement` → `review` → `completed`). The set of valid transitions is the existing `VALID_STEPS` enum.
- **FR-4** — `pipeline-runner.ts` writes `state.step = '<phase>'` (e.g. `'pickle'`, `'citadel'`, `'anatomy-park'`, `'szechuan-sauce'`) at the START of each phase, BEFORE spawning the phase subprocess. Add the four phase names to `VALID_STEPS` and the `Step` union in `types/index.ts`.
- **FR-5** — `pipeline-runner.ts` emits a `phase_transition` activity event on each phase boundary with `{from_phase, to_phase, exit_reason_prev}`. Activity event added to `VALID_ACTIVITY_EVENTS`.
- **FR-6** — `pipeline-runner.ts:writeRunningStatus()` continues to write `pipeline-status.json` (don't break that contract); the new `state.json` writes are additive.
- **FR-7** — `getExtensionRoot()` validates the `EXTENSION_DIR` override by `fs.existsSync(path.join(EXTENSION_DIR, 'extension', 'bin', 'log-watcher.js'))`. On miss, fall back to `~/.claude/pickle-rick` AND emit a one-time `stderr` warning + a `extension_dir_fallback` activity event with `{requested_dir, fallback_dir, reason: 'missing_log_watcher'}`.
- **FR-8** — `restartDeadWatcherPanes` (and any other watcher-spawn site) MUST resolve scripts via the validated `getExtensionRoot()` path; PATTERN_SHAPE check rejects bare `process.env.EXTENSION_DIR` reads outside `getExtensionRoot()`.
- **FR-9** — Test-fixture code that sets `EXTENSION_DIR` to a tmpdir uses an `EXTENSION_DIR_TEST_OVERRIDE` env var (or equivalent) that `getExtensionRoot()` only honors when explicitly opted into via `process.env.NODE_ENV === 'test'` or a sentinel. Production tmux launches don't risk inheriting a stale override.

## Non-Functional Requirements

- **NFR-1** — Backward-compatible: existing test suite (3464 tests) must remain green after changes. Tests that pin `EXTENSION_DIR` to a tmpdir are migrated to the test-only env var.
- **NFR-2** — No new external dependencies.
- **NFR-3** — `state.json` writes are atomic via `StateManager.update()` (existing primitive); no raw `fs.writeFileSync`.
- **NFR-4** — Performance: per-iteration state writes add at most one fsync per iteration. Already true for activity-logger writes; FR-1..FR-3 piggyback.

## Acceptance Criteria

| ID | Phase | Check |
|---|---|---|
| **AC-PSD-A1** | per-phase | After running a 3-iteration mux-runner pickle phase, `state.json:iteration` = 3 (not 0). Test: `tests/mux-runner-state-iteration.test.js` (NEW). |
| **AC-PSD-A2** | per-phase | After mux-runner picks ticket `<X>`, `state.json:current_ticket` = `<X>`. After completing it, `current_ticket` = `null` until the next pick. Test: `tests/mux-runner-state-current-ticket.test.js` (NEW). |
| **AC-PSD-A3** | per-phase | mux-runner advances `state.json:step` through `research → plan → implement → review → completed` in order; no skips, no regressions. Test: `tests/mux-runner-state-step.test.js` (NEW). |
| **AC-PSD-B1** | per-phase | At the start of each pipeline phase, `state.json:step` equals the phase name (`pickle`, `citadel`, `anatomy-park`, `szechuan-sauce`). Test: `tests/pipeline-runner-state-step.test.js` (NEW). |
| **AC-PSD-B2** | per-phase | On each phase boundary, `state.activity[]` gains a `phase_transition` event with `from_phase`, `to_phase`, `exit_reason_prev`. Test added to existing `tests/pipeline-runner.test.js`. |
| **AC-PSD-B3** | post-refinement | `VALID_STEPS` and the `Step` union in `types/index.ts` include `'pickle'`, `'citadel'`, `'anatomy-park'`, `'szechuan-sauce'`. `VALID_ACTIVITY_EVENTS` includes `phase_transition` and `extension_dir_fallback`. Test: existing `tests/types-gate-events.test.js`. |
| **AC-PSD-C1** | per-phase | `getExtensionRoot()` returns the canonical `~/.claude/pickle-rick` when `EXTENSION_DIR=/nonexistent` is set, and emits a `extension_dir_fallback` activity event. Test: `tests/get-extension-root-fallback.test.js` (NEW). |
| **AC-PSD-C2** | per-phase | `restartDeadWatcherPanes` resolves watcher scripts only via `getExtensionRoot()`; raw `process.env.EXTENSION_DIR` reads outside that helper are caught by an ESLint rule (or PATTERN_SHAPE assertion). Test: `tests/no-bare-extension-dir.test.js` (NEW) or eslint rule. |
| **AC-PSD-C3** | bundle-end | After running the live test scenario (`EXTENSION_DIR=/nonexistent /pickle-pipeline <prd>`), all four monitor panes (0, 1, 2, 3) are alive (`pane_current_command = node`) and reading from `~/.claude/pickle-rick/extension/bin/`. Manual verification + `tests/integration/pipeline-tmpdir-fallback.test.js` (NEW). |
| **AC-PSD-D1** | per-phase | After full v1.65.0+ pipeline run, `state.json:iteration` matches `mux-runner.log:"--- Iteration N"` final count, `state.step` ends at `'completed'`, `state.activity[]` length matches the count of `iteration_start` events emitted. Test: `tests/integration/pipeline-state-coherence.test.js` (NEW). |
| **AC-PSD-D2** | post-refinement | New trap-door INVARIANTs added to `extension/CLAUDE.md` for: (a) mux-runner state-iteration write, (b) pipeline-runner phase-step write, (c) getExtensionRoot validation. Each with PATTERN_SHAPE for ESLint or grep enforcement. Test: existing `tests/test-registration-hygiene.test.js`. |

## Tasks (atomic, execution order)

| Order | ID | Title | Estimated LOC |
|---|---|---|---|
| 10 | **PSD-T0** | Type/enum extensions: add 4 phase names + 2 activity events to `VALID_STEPS`, `Step` union, `VALID_ACTIVITY_EVENTS`. AC-PSD-B3. | ~25 |
| 20 | **PSD-T1** | `mux-runner.ts`: persist `state.iteration` on iteration_start. AC-PSD-A1. | ~40 |
| 30 | **PSD-T2** | `mux-runner.ts`: persist `state.current_ticket` on ticket pick/clear. AC-PSD-A2. | ~50 |
| 40 | **PSD-T3** | `mux-runner.ts`: persist `state.step` on lifecycle transitions. AC-PSD-A3. | ~60 |
| 50 | **PSD-T4** | `pipeline-runner.ts`: write `state.step = phase` at phase entry; emit `phase_transition` activity event. AC-PSD-B1, AC-PSD-B2. | ~70 |
| 60 | **PSD-T5** | `pickle-utils.ts:getExtensionRoot()`: validate, fall back, log. AC-PSD-C1. | ~30 |
| 70 | **PSD-T6** | Test-fixture migration: replace `EXTENSION_DIR=<tmpdir>` with the new test-only opt-in pattern in `tests/mux-runner.test.js` and any sibling fixtures that follow the same pattern. AC-PSD-C1, NFR-1. | ~80 |
| 80 | **PSD-T7** | ESLint rule or `tests/no-bare-extension-dir.test.js`: forbid `process.env.EXTENSION_DIR` reads outside `getExtensionRoot()`. AC-PSD-C2. | ~40 |
| 90 | **PSD-T8** | Integration test: `tests/integration/pipeline-state-coherence.test.js` end-to-end. AC-PSD-D1. | ~120 |
| 100 | **PSD-T9** | Trap-door catalog updates in `extension/CLAUDE.md`: 3 new INVARIANTs with PATTERN_SHAPEs. AC-PSD-D2. | ~30 |
| 110 | **PSD-T10** | Closer: bump version to v1.66.0, run full release gate. | ~5 |

**Total**: ~550 LOC. 11 atomic tickets including closer.

## Out of Scope

- Migration of `pipeline-status.json` content into `state.json` (kept as separate file per existing trap-door INVARIANT). State writes are additive, not replacing.
- Refactoring `state.activity` to be a separate file (the `state-field-invariants.test.js` INVARIANT requires it inline).
- Adding a heartbeat/keepalive mechanism (separate concern; would be its own PRD).

## Implementation Guidance

- Use `StateManager.update(statePath, (s) => ({...s, iteration: nextIter}))` — never raw `fs.writeFileSync`.
- For PSD-T4 phase-step writes, the new step values intentionally collide with the phase name strings already in pipeline-runner's `PHASES` enum. Don't introduce a parallel naming scheme.
- For PSD-T5, the validation check is a single `fs.existsSync(path.join(extDir, 'extension', 'bin', 'log-watcher.js'))`. Don't validate every script; one canonical sentinel is sufficient.
- For PSD-T6, the test-fixture migration must preserve the existing test-isolation behavior. The simplest pattern: introduce `EXTENSION_DIR_TEST` env var that `getExtensionRoot()` checks ONLY when `process.env.NODE_ENV === 'test'`. Keep the production env var name to avoid breaking external scripts that may set it intentionally.
- The new trap-door catalog entries should match the existing voice and PATTERN_SHAPE format. Examples in `extension/CLAUDE.md`.

## Risks

| ID | Risk | Mitigation |
|---|---|---|
| R1 | Per-iteration `state.json` writes contend with `StateManager` lock under high concurrency | Existing `StateManager.update()` already handles atomic locks; piggyback on existing primitive |
| R2 | `phase_transition` event flood overwhelms activity log | Phase transitions fire ~4-5 times per pipeline (not per iteration); volume is negligible |
| R3 | `EXTENSION_DIR` validation fallback masks a real misconfiguration | The `extension_dir_fallback` activity event is the explicit audit trail; operator can grep for it |
| R4 | Test-fixture migration breaks CI | PSD-T6 must be its own PR with full CI run; tests should opt-in to the new env-var pattern explicitly |
| R5 | New phase names in `VALID_STEPS` break older session state files | Backward-compatible: schema version stays v3; new values are additive to the enum |
| R6 | A live pipeline crashes mid-write and leaves `state.iteration` desynced anyway | `StateManager.update` is atomic via tmp-rename; partial-write cannot land |

## Reproducer (manual)

```bash
# 1. Set up the broken state
mkdir -p /tmp/pickle-test-broken/extension/bin
EXTENSION_DIR=/tmp/pickle-test-broken
rm -rf $EXTENSION_DIR/extension/bin/log-watcher.js  # ensure it's missing

# 2. Launch a pipeline
EXTENSION_DIR=/tmp/pickle-test-broken \
  /pickle-pipeline prds/archive/bundles/loop-runner-relaunch-status-bugs.md

# 3. Inspect state mid-run after iteration 2 starts
jq '{iteration, step, current_ticket, activity_len: (.activity | length)}' \
  ~/.local/share/pickle-rick/sessions/<latest>/state.json

# 4. Inspect monitor panes
for p in 0 1 2 3; do tmux capture-pane -t pipeline-<hash>.$p -p | tail -3; done
```

Pre-fix: state.iteration=0, step=research, current_ticket=null, activity_len=1, panes 1+3 dead with MODULE_NOT_FOUND.
Post-fix: state.iteration=2, step=pickle, current_ticket=<hash>, activity_len≥10, panes 1+3 alive (node), warning emitted that EXTENSION_DIR was overridden.

## Operator workaround (until shipped)

Until the fix lands, operators must:

1. Verify `env | grep EXTENSION_DIR` is empty in the launching shell. If set to a non-canonical path, `unset EXTENSION_DIR` before invoking pickle commands.
2. Read pipeline progress from `pipeline-runner.log` and `mux-runner.log`, NOT `state.json`. Add the phase name and iteration to a manual TODO list since the monitor will be stuck.
3. If panes 1 and 3 die, manually relaunch them with explicit canonical paths:
   ```
   tmux send-keys -t <session>.1 "node ~/.claude/pickle-rick/extension/bin/log-watcher.js <SESSION_ROOT>" C-m
   tmux send-keys -t <session>.3 "node ~/.claude/pickle-rick/extension/bin/raw-morty.js <SESSION_ROOT>" C-m
   ```

— Pickle Rick out. *belch*

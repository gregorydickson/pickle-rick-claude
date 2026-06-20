---
title: P1 — mux-runner misclassifies claude manager max-turns exit as subprocess error (no relaunch path for non-codex backends)
status: Draft
filed: 2026-05-10
priority: P1
type: bug
backend_constraint: claude
related:
  - prds/p1-bug-fix-bundle-2026-05-10.md   # bit this bundle on iter 2; not in scope for closer
  - prds/archive/bug-reports/p1-iteration-cap-and-phantom-done-handshake.md   # sibling cap-handshake family (R-ICP-1/2 cap exit code)
  - prds/archive/bug-reports/p1-pipeline-runner-aborts-on-judge-timeout-no-finalize-gate.md   # sibling transient-vs-fatal classification bug (R-PRJT)
---

# P1 — mux-runner misclassifies claude manager max-turns exit as subprocess error

## Problem

When a `tmux_mode` mux-runner manager subprocess hits its `--max-turns` budget on the claude backend, Claude CLI exits cleanly (`stop_reason: "end_turn"`, `terminal_reason: "completed"`, `is_error: false`). The manager's last `result` event shows the next-ticket spawn it kicked off before running out of turns — work was progressing. But mux-runner classifies this exit as `completion: 'error'` and falls through to `'Subprocess error. Exiting loop.'`, deactivates the session, and the whole pipeline tears down.

Codex backend has an existing escape hatch — `evaluateCodexManagerRelaunch` at `mux-runner.ts:3705-3724` — that respawns the manager up to `CODEX_MANAGER_RELAUNCH_CAP` (=10) times when there are still pending tickets. **Claude backend has no equivalent.** Claude managers also run out of turns; they need the same bounded relaunch path.

## Observed incident

Session `2026-05-10-84ad0873` (bundle 2026-05-10, pickle phase, iter 2 of mux-runner):
- Iteration 2 ran continuously **15:16 UTC → 19:16 UTC = 4h 00m 0s**
- Manager `claude -p ... --max-turns 400` (per `mux-runner.ts:1325-1328`, `Defaults.MANAGER_MAX_TURNS`)
- Manager processed tickets R-SLLJ-3 through R-CCNW-4: 16 successful per-ticket loops. Turn counts per `result` event in `tmux_iteration_2.log` (sampled tail): `5 → 37 (4× config-protected retry) → 6 → 12 → 10` just for the last 5 tickets
- Last `result` event: `terminal_reason: "completed"`, `stop_reason: "end_turn"`, `is_error: false`, `result: "Morty running for 1c3e2426. Awaiting completion."`
- 40ms later `mux-runner.log`: `[19:16:45.273Z] Subprocess error. Exiting loop.` then `[19:16:45.276Z] mux-runner finished. 2 iterations, 251m 45s`
- `pipeline-runner.log`: `Phase pickle exited with code 1` → `Phase pickle failed (exit 1) — stopping pipeline`
- 16/37 tickets shipped, 21 stranded; operator manually relaunched `bash launch.sh ${SESSION_ROOT} ${SESSION_ROOT}` and the pipeline picked up at the same `current_ticket=1c3e2426`

Bundle-level damage: **0** (state.json + ticket dirs survive the manager exit; relaunch resumes cleanly). Operator damage: **1 manual intervention** required to detect-and-fix what should have been auto-recovered, plus ~3 min context-switching cost. **Recurrence is when, not if** — every long-running pickle phase (≥10 tickets) on claude backend is at risk.

## Root cause analysis

### Code path

`extension/src/bin/mux-runner.ts`:

1. **Manager spawn budget** (lines 1325-1328):
   ```ts
   let maxTurns: number = Defaults.MANAGER_MAX_TURNS;
   maxTurns = positiveIntegerOrNull(settings.default_tmux_max_turns)
     ?? positiveIntegerOrNull(state.max_turns)
     ?? maxTurns;
   ```
   `Defaults.MANAGER_MAX_TURNS` = 400. Burns through in 4h on a high-ticket-count iteration.

2. **Manager exit classification** (lines 1395-1444):
   The classifier returns `{ completion: 'error', timedOut: false, exitCode: null, wallSeconds }` for any exit where the manager didn't emit a recognized promise token (`TASK_COMPLETED`, `EPIC_COMPLETED`, `EXISTENCE_IS_PAIN`, etc.). A manager that runs out of turns AFTER spawning a Morty ("Morty running for 1c3e2426. Awaiting completion.") never gets to emit a final promise — Claude CLI exits via `end_turn` at the turn boundary.

3. **Error-path branch** (lines 3696-3730):
   ```ts
   else if (result === 'error') {
     // ... codex-only relaunch path 3703-3723 ...
     log('Subprocess error. Exiting loop.');
     recordExitReason(statePath, 'error');
     safeDeactivate(statePath);
     removeRunnerSessionMapEntry(statePath, log);
     exitReason = 'error';
     break;
   }
   ```
   The codex relaunch escape hatch (`evaluateCodexManagerRelaunch`) gates on `state.backend === 'codex'` internally (see `extension/src/services/codex-manager-relaunch.ts:51-60`). Claude backend skips the relaunch decision and falls through to the unconditional exit.

### Why the codex path exists and claude doesn't

The codex path was added because codex managers are long-lived and the 4h hang-guard SIGTERM produces `{ completion: 'error', timedOut: true }` (line 1397). The comment at `mux-runner.ts:3697-3702` reads: *"Codex tmux_mode runs ONE long-lived manager subprocess that loops across many tickets internally. The 4h hang-guard SIGTERMs it..."*

That comment is wrong-by-omission. **Claude managers also loop across many tickets internally** in tmux_mode — they just consume `--max-turns` turns instead of wall-clock seconds. The structural shape is identical (one long-lived subprocess, many internal iterations); the boundary signal is different (turn budget vs wall-clock). Both deserve bounded-relaunch.

### Why this is a sibling of R-PRJT and R-ICP

- **R-PRJT** (judge_timeout): pipeline-runner misclassified a transient measurement timeout as a fatal exit. Same shape: transient ≠ fatal, but the classifier conflated them.
- **R-ICP-1/2** (cap-exit code 3): mux-runner's `iteration_cap_exhausted` exit code differentiates "operator-cap hit" from "subprocess crashed" so auto-resume.sh can stop cleanly. Same shape: clean exit-via-cap is operationally different from fault-exit.
- This bug (R-MMTR): claude manager's `--max-turns` exit is the **third member** of the "clean exit via cap that gets misclassified as fatal" family. Each fix lands at a different layer (microverse-runner, pipeline-runner, mux-runner). All three share the same operator-impact pattern: convergence work survives on disk but the runtime forfeits it.

## Solution

Generalize `evaluateCodexManagerRelaunch` to a backend-agnostic `evaluateManagerRelaunch` that fires the bounded-relaunch path for both claude and codex. Add a max-turns-specific detection so the relaunch tag/event clearly distinguishes "manager ran out of turns" from "manager crashed" from "manager 4h-hang-guard timeout".

### Atomic tickets

#### R-MMTR-1 — Detect max-turns exit signature

Add helper `detectManagerMaxTurnsExit(managerResult: ManagerSpawnResult): boolean` in `mux-runner.ts`. Returns true when:
- `result.completion === 'error'` AND
- `result.timedOut === false` AND
- `result.exitCode === 0` (Claude CLI exits 0 on graceful turn-budget exhaustion) AND
- The last `result` JSON event in the iteration log has `stop_reason === 'end_turn'` AND `terminal_reason === 'completed'` AND `is_error === false`

Returns false for crash/timeout/genuine-error exits.

**Files**: `extension/src/bin/mux-runner.ts` (new helper near line 1430), `extension/tests/mux-runner-max-turns-detection.test.js` (new). Pure-function helper, ~30 LOC + test.

#### R-MMTR-2 — Generalize codex-relaunch to backend-agnostic manager-relaunch

Rename `evaluateCodexManagerRelaunch` → `evaluateManagerRelaunch` in `extension/src/services/codex-manager-relaunch.ts`. Drop the internal `state.backend === 'codex'` gate. Add new `exitKind: 'codex_4h_hang_guard' | 'claude_max_turns' | 'other_error'` parameter so the caller can record different telemetry per-class. Keep `CODEX_MANAGER_RELAUNCH_CAP` (=10) as the cap; add `CLAUDE_MANAGER_RELAUNCH_CAP` (default 20 — claude's max-turns runs out faster than codex's 4h hang-guard so we expect more relaunches per session). Rename file: `codex-manager-relaunch.ts` → `manager-relaunch.ts`. Backwards-compat re-export of the old symbol for 1 version, then drop.

**Files**: `extension/src/services/codex-manager-relaunch.ts` (rename + signature change), `extension/src/services/manager-relaunch.ts` (new home), `extension/src/types/index.ts` (`CLAUDE_MANAGER_RELAUNCH_CAP` in `Defaults`), `extension/tests/manager-relaunch.test.js` (replaces `codex-manager-relaunch.test.js`). ~80 LOC + test.

#### R-MMTR-3 — Wire claude max-turns path into mux-runner error branch

At `mux-runner.ts:3696-3730`, replace the codex-only `evaluateCodexManagerRelaunch` call with a backend-aware `evaluateManagerRelaunch` call. Before the call, classify the exit:
```ts
const exitKind = detectManagerMaxTurnsExit(/* ... */)
  ? 'claude_max_turns'
  : /* existing classification */ 'codex_4h_hang_guard' | 'other_error';
```
Pass `exitKind` through to `evaluateManagerRelaunch`. The relaunch log line becomes `${backend} manager subprocess exited via ${exitKind} with ${pendingCount} ticket(s) still pending — relaunching (count ${nextRelaunchCount}/${cap}).`

**Files**: `extension/src/bin/mux-runner.ts:3696-3730` (refactor branch), `extension/tests/mux-runner-claude-max-turns-relaunch.test.js` (new — fixture-driven integration test that simulates a max-turns exit and asserts mux-runner respawns the manager rather than tearing down). ~50 LOC + integration test.

#### R-MMTR-4 — Activity event for max-turns relaunches

Register `manager_max_turns_relaunch` in `VALID_ACTIVITY_EVENTS` (`extension/src/types/index.ts`). Schema-conformant emission (per the iter-7/8/9 trap-door regression class):
- `event`, `ts` required
- `gate_payload: { backend, relaunch_count, cap, pending_count, last_ticket_seen }` required
- Emit from `recordManagerRelaunch` (renamed from `recordCodexManagerRelaunch`)

Add schema definition in `extension/src/types/activity-events.schema.json` per the iter-9 producer/schema parity invariant. Add row in `extension/tests/activity-event-payload.test.js` EVENT_CASES. Add row in `spawn-refinement-team.ts:ACTIVITY_EVENT_SCHEMA_SECTION` so refinement analysts know about the event.

**Files**: `extension/src/types/index.ts`, `extension/src/types/activity-events.schema.json`, `extension/src/services/manager-relaunch.ts`, `extension/src/bin/spawn-refinement-team.ts:ACTIVITY_EVENT_SCHEMA_SECTION`, `extension/tests/activity-event-payload.test.js` (EVENT_CASES row), `extension/tests/manager-max-turns-relaunch-schema-conformance.test.js` (new). ~40 LOC + tests.

#### R-MMTR-5 — Trap-door pin

Add to `extension/src/bin/CLAUDE.md` under `## Trap Doors`:

```markdown
- `mux-runner.ts` (R-MMTR-3 claude max-turns relaunch) — INVARIANT: when the manager subprocess on the claude backend exits via `--max-turns` exhaustion (clean Claude CLI `end_turn` exit with non-empty pending-ticket queue), `mux-runner.ts:3696-3730` MUST call `evaluateManagerRelaunch` (not the legacy `evaluateCodexManagerRelaunch`) and respawn up to `Defaults.CLAUDE_MANAGER_RELAUNCH_CAP` (=20) times rather than logging `Subprocess error. Exiting loop.`. BREAKS: long pickle phases on claude backend (≥10 tickets per mux iteration) tear down at the 400-turn boundary, stranding remaining tickets; operator must manually `bash launch.sh` to resume. ENFORCE: extension/tests/mux-runner-claude-max-turns-relaunch.test.js, extension/tests/manager-relaunch.test.js.
```

**Files**: `extension/src/bin/CLAUDE.md` (new entry). ~10 lines.

#### R-MMTR-6 — Regression test: 4h+ iter simulation

End-to-end integration test that:
1. Spins up a synthetic session with 20 Todo tickets
2. Spawns mux-runner with `--max-turns 5` (forces frequent exits)
3. Mocks Morty completion (immediate Done frontmatter write) so all 20 tickets process
4. Asserts: pipeline completes all 20 tickets via 4-5 manager respawns; `mux-runner.log` contains `manager subprocess exited via claude_max_turns` lines; final exit_reason is `success`, not `error`

**Files**: `extension/tests/integration/mux-runner-claude-max-turns-e2e.test.js` (new). ~120 LOC.

#### R-MMTR-7 — Closer

Bump `extension/package.json:version` patch (X.Y.Z → X.Y.Z+1). Run release gate: `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast`. Deploy via `bash install.sh` and verify md5 parity 5/5. Update MASTER_PLAN: close Open Finding #19, add entry in Recently Shipped.

**Files**: `extension/package.json`, `prds/MASTER_PLAN.md`. ~10 lines.

## Acceptance criteria

- [ ] **AC-MMTR-01** — `detectManagerMaxTurnsExit` returns true ONLY for clean `end_turn` exits with non-empty pending tickets (R-MMTR-1)
- [ ] **AC-MMTR-02** — Claude max-turns exit triggers `evaluateManagerRelaunch`, not `Subprocess error. Exiting loop.` (R-MMTR-3)
- [ ] **AC-MMTR-03** — `CLAUDE_MANAGER_RELAUNCH_CAP=20` is the default cap; configurable via `pickle_settings.claude_manager_relaunch_cap` (R-MMTR-2)
- [ ] **AC-MMTR-04** — `manager_max_turns_relaunch` activity event registered + schema-conformant + EVENT_CASES test + spawn-refinement-team prompt section updated (R-MMTR-4)
- [ ] **AC-MMTR-05** — Trap-door entry at `extension/src/bin/CLAUDE.md` enforced by `mux-runner-claude-max-turns-relaunch.test.js` + `manager-relaunch.test.js` (R-MMTR-5)
- [ ] **AC-MMTR-06** — E2E regression: 20-ticket session with `--max-turns 5` completes all 20 via auto-relaunch; final exit_reason is `success` (R-MMTR-6)
- [ ] **AC-MMTR-07** — Legacy `evaluateCodexManagerRelaunch` re-exported for one version then dropped; codex behavior unchanged (R-MMTR-2)
- [ ] **AC-MMTR-08** — Replay: synthetic session matching the 2026-05-10-84ad0873 iter-2 incident shape auto-recovers without manual `bash launch.sh` (R-MMTR-6 fixture)

## Out of scope

- **Increasing `MANAGER_MAX_TURNS` default**: 400 is the right call for cost-per-iteration. The fix is recovery, not budget expansion.
- **State.json schema changes**: relaunch metadata already persists via `codex_manager_relaunch_count` field (rename to `manager_relaunch_count` lives in R-MMTR-2 backwards-compat path; field semantic stays the same).
- **Pipeline-runner changes**: pipeline-runner.ts:1670 (R-PRJT territory) already handles `judge_timeout`. This bug fires one layer up (mux-runner subprocess management); pipeline-runner sees mux exit 0 if relaunch succeeds.
- **Codex 4h hang-guard relaunch**: works today, no changes to codex semantics other than the rename.

## Risk register

| Risk | Mitigation |
|---|---|
| Claude relaunch cap 20 too low for very long pickle phases | Make configurable via settings; default 20 covers 8000 turns of work (20 × 400) = ~80h of single-ticket-thick work; realistic worst case is 2-3 relaunches per 4h iter, so 20 covers ~24h+ |
| Relaunch loop floods if manager crash-loops at startup | `evaluateManagerRelaunch` already includes a "did we make progress since last relaunch" gate (R-CMR-2 from the codex path); reuse it |
| State.json field `codex_manager_relaunch_count` rename breaks old state.json files | One-version backwards-compat: read both names, write the new name; migrate-on-read |
| Test fixture for `--max-turns 5` is brittle | Use deterministic completion-promise mocks; assert behavior, not log-line exact text |

## Severity escalation

Today's incident: 21 tickets stranded; recovery 3 minutes. **One operator was in the loop.** If this hits during overnight runs, recovery is the morning after — every overnight pickle phase on claude backend (which is the recommended backend after the R-CCPL codex hallucination fix) is at risk. Escalate to P0 if any pipeline burns a full overnight cycle on this. For now, P1 — recoverable by manual intervention, fix is atomic ~half-day.

## Verification path

1. Cherry-pick fix onto current branch (post-bundle-2026-05-10)
2. Run regression: `extension/tests/integration/mux-runner-claude-max-turns-e2e.test.js`
3. Replay bundle 2026-05-10 iter-2 scenario as fixture: 17 simulated tickets with `--max-turns 5`; expect 3-4 auto-relaunches; expect exit_reason=success
4. Live-run validation on next ≥10-ticket claude pipeline phase

---
title: pipeline-runner doesn't claim state.active=true on relaunch into a failed session
status: Shipped
date: 2026-05-01
priority: P3
shipped: P0 bundle Section C
backend: codex-required
peer_prds:
  related:
    - prds/archive/bug-reports/pipeline-state-desync-and-pane-respawn-tmpdir.md  # Bug 1+2 are sibling state-field maintenance gaps; this completes the set
    - prds/archive/bundles/loop-runner-relaunch-status-bugs.md  # LRR Bug C handled exit_reason clearing on relaunch; this is the active-flip gap LRR didn't cover
---

# PRD — pipeline-runner doesn't claim `state.active=true` on relaunch into failed session

## Symptom (observed live, 2026-05-01 PM)

When relaunching `/pickle-pipeline` into a session whose previous run ended `failed` (e.g. readiness halt), the watchers (`log-watcher.js`, `raw-morty.js`) periodically self-terminate with `◤ FEED TERMINATED ◢` even though the new pipeline-runner is actively working. Their liveness probe reads `state.active=false` (correctly preserved as forensic state from the failed run) and they exit per their trap-door INVARIANT.

Pane capture from session `2026-05-01-325ccb80`:

```
The delegated process is still running. I'm continuing to…
codex
Still no completion output from the worker. I'm waiting a…
codex
Morty has not exited yet. I'm polling once more and will …

──ｱ───────────5────ｼ────ﾅ─────ﾕ──ﾑﾅ──5───-─────────ｱ──────ｱ─
◤ FEED TERMINATED ◢
```

Operator workaround: manually flip `state.active=true` after relaunch.

## Distinguishing from siblings

- **Not Bug 1 of `pipeline-state-desync-and-pane-respawn-tmpdir.md`**: that PRD covers `state.iteration` persistence by mux-runner, which already shipped via PSD-T1 in v1.66.0. The in-flight bundle's pickle phase IS persisting iteration correctly (`Iteration 1 (state.iteration=1)` in mux-runner.log).
- **Not Bug 2**: that covers `state.step` on pipeline phase transitions. Phase transitions aren't the trigger here — relaunch is.
- **Not LRR Bug C**: that PRD shipped clearing of `state.exit_reason` on reactivation; `state.active` flip-to-true is a separate field with separate ownership semantics.
- **Not the watcher INVARIANT**: log-watcher and raw-morty are doing exactly what they should — `INVARIANT: liveness probes read state.json through StateManager.read()` (extension/CLAUDE.md). The bug is on the runner side: pipeline-runner doesn't claim `active=true` when starting a phase against a session that previously failed.

## Root cause (suspected)

`pipeline-runner.ts` startup sequence at session reactivation does not call any equivalent of mux-runner's `Session ownership taken (active: false → true)` flip (LRR-T1, `80f5c2a`). It assumes the session is already active (set by setup.js or mux-runner) and just begins running phases.

When relaunch path is `bash $SESSION_ROOT/launch.sh $SESSION_ROOT` (which runs pipeline-runner directly, bypassing setup.js), and the prior run left `state.active=false` (per `finalizeTerminalState` on the failed first attempt), pipeline-runner inherits the lying state and never corrects it.

The mux-runner LRR-T1 ownership flip DOES fire when mux-runner spawns for a phase, but only AFTER pipeline-runner has been running for ~1-2 seconds and entered the pickle phase. During that window — and during phase transitions where one runner exits cleanly (active=false) before the next runner starts — watchers see `active=false` and self-terminate.

## Functional Requirements

- **FR-1** — `pipeline-runner.ts` startup MUST claim `state.active=true` (with `pid=process.pid`) atomically via `StateManager.update()` before entering the first phase. Should be idempotent: if already true, no-op.
- **FR-2** — On phase transition (between PHASE N exit and PHASE N+1 entry), pipeline-runner MUST keep `state.active=true` until the entire pipeline finalizes. Per-phase runners (mux-runner, microverse-runner) may flip `state.active=false` at their finalize, but pipeline-runner's outer loop overrides this back to true at the start of the next phase.
- **FR-3** — When a phase fails and pipeline-runner halts the pipeline, the final `finalizeTerminalState({ exitReason: 'failed' })` correctly sets `active=false` for forensic preservation (existing behavior, no change).
- **FR-4** — When `bash launch.sh` is the relaunch entry-point (bypassing setup.js), pipeline-runner detects this case (e.g., session has `active=false, exit_reason='failed', step='completed'`) and treats it as relaunch — re-claiming `active=true` and clearing the prior `exit_reason` before phase 1 starts. This mirrors LRR-T3's `clearExitReason()` helper but for `active`.

## Non-Functional Requirements

- **NFR-1** — Backward-compatible: existing tests must pass.
- **NFR-2** — Clean-shutdown semantics preserved: if pipeline-runner crashes mid-phase, `active` should NOT be left true forever (existing top-level fatal catch handles this).

## Acceptance Criteria

| ID | Phase | Check |
|---|---|---|
| AC-PRA-01 | per-phase | After `bash launch.sh` relaunches into a session with `state.active=false, exit_reason='failed'`, within 1 second `state.active` flips to true and `exit_reason` is cleared. Test: `tests/pipeline-runner-relaunch-active-claim.test.js` (NEW). |
| AC-PRA-02 | per-phase | At pipeline finalize-success, `state.active=false` and `exit_reason='completed'` (existing behavior). At pipeline finalize-failed, `state.active=false` and `exit_reason='failed'` (existing). Test added to existing `tests/pipeline-runner.test.js`. |
| AC-PRA-03 | per-phase | log-watcher.js and raw-morty.js do NOT self-terminate during a healthy pipeline run. Integration test: spawn pipeline + watchers, sleep 60s, assert watchers still alive. Test: `tests/integration/pipeline-watcher-liveness.test.js` (NEW). |
| AC-PRA-04 | post-refinement | Trap-door INVARIANT in `extension/CLAUDE.md`: `pipeline-runner.ts` claims `state.active=true` at startup; verifies on every iteration boundary that active is still true. PATTERN_SHAPE for grep enforcement. |

## Tasks

| Order | ID | Title | Estimated LOC |
|---|---|---|---|
| 10 | PRA-T1 | `pipeline-runner.ts` startup: claim active=true via StateManager.update; clear stale exit_reason. AC-PRA-01. | ~30 |
| 20 | PRA-T2 | `pipeline-runner.ts` phase boundary: re-claim active=true before each phase entry. AC-PRA-02. | ~20 |
| 30 | PRA-T3 | Integration test: pipeline-watcher-liveness.test.js. AC-PRA-03. | ~80 |
| 40 | PRA-T4 | Trap-door catalog entry. AC-PRA-04. | ~15 |
| 50 | PRA-T5 | Closer: bump version, run release gate. | ~5 |

**Total**: ~150 LOC. 5 atomic tickets.

## Out of Scope

- Watcher-side fixes (`log-watcher.js` / `raw-morty.js` keep their existing self-terminate-on-active=false behavior — that's correct).
- Replacing `state.active` with a different liveness primitive.

## Operator workaround (until fix lands)

After every `bash launch.sh` relaunch into a previously-failed session:

```bash
SESSION_ROOT=~/.local/share/pickle-rick/sessions/<id>
node -e "const fs=require('fs');const p='$SESSION_ROOT/state.json';const s=JSON.parse(fs.readFileSync(p,'utf8'));if(!s.active){s.active=true;s.exit_reason=null;const t=p+'.tmp.'+process.pid;fs.writeFileSync(t,JSON.stringify(s,null,2));fs.renameSync(t,p);}"
```

The 30-min watchdog cron `bcdd4a30` automates this for the in-flight bundle session.

## Cross-references

- Surfaced live: bundle session `2026-05-01-325ccb80` after readiness-halt-then-relaunch on 2026-05-01 PM.
- Sibling fixes:
  - LRR-T1 `80f5c2a` — mux-runner ownership flip (works for direct mux-runner spawn, not pipeline-runner relaunch path)
  - LRR-T3 `2013e2a` — clear stale exit_reason on relaunch (handles exit_reason but not active)
  - PSD-T1 v1.66.0 — mux-runner persists state.iteration (per-iteration writes; doesn't flip active)
- Watcher INVARIANTs at extension/CLAUDE.md (log-watcher.ts, raw-morty.ts, morty-watcher.ts) — correctly self-terminate; not the bug surface.

— Pickle Rick out. *belch*

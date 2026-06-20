---
title: P1 bug-fix bundle — B-WSWA — schema-safe land of R-WMW worker-artifact-progress tracking (LATEST_SCHEMA_VERSION 4→5)
status: SHIPPED 2026-05-30 (verify-first closed 2026-06-02) — STALE PRD; do not re-launch. Schema v4→5 + worker_artifact_progress + K=3/K=5 events landed via ba276e43 (R-WSWA-1) + 4084702e (R-WSWA-2) and siblings; LATEST_SCHEMA_VERSION=5 in HEAD AND deployed; events worker_artifact_progress_zero / worker_auto_skip_oversized registered; FAILURE_REASONS includes oversized_no_progress; artifact-progress-detector.test.js present. #74 R-WSWA + #33 R-WMW DONE.
filed: 2026-05-30
priority: P1
type: bug-bundle
code: B-WSWA
composes:
  - "#74 R-WSWA — schema-version-bump bundle cannot self-deploy mid-run (state_schema_version_ahead R-WSRC-2 trip)"
  - "#33 R-WMW — manager wedges on oversized ticket; no artifact-progress detection (owned here per drain-queue overlap rule; removed from B-WEDGE)"
source:
  - prds/archive/bug-reports/p2-worker-manager-wedge-oversized-ticket-no-artifact-progress.md   # R-WMW design + ACs
---

# B-WSWA — schema-safe re-land of R-WMW worker-artifact-progress tracking

## Trigger

Finding #74 (R-WSWA): the R-WMW fix for the oversized-ticket wedge (#33) REQUIRES a new persisted `state.json` field (`worker_artifact_progress`) → `LATEST_SCHEMA_VERSION` 4→5. The prior attempt (session `pickle-e4f1269f`, 2026-05-25) recompiled, wrote a v5 `state.json`, but the already-running mux-runner (older compiled binary loaded at process start) read it and tripped the R-WSRC-2 graceful exit `state_schema_version_ahead`. Design gap: a schema bump cannot self-deploy MID-run. This bundle lands the work correctly from a clean no-active-pipeline state, so the fresh runner loads v5 — the mid-run caveat does not apply.

## Root cause

R-WMW (#33): when one Morty ticket exceeds the manager's max-turns budget, the manager loops research→plan without ever delegating to `spawn-morty` for completion. No artifact-progress detection exists, so the wedge is silent for ~60+ min until operator SIGINT (incident `2026-05-13-ba01c135` ticket `3ab68cdd`: 4 spawn events, one 157-byte worker log, zero `code_review_*.md`/`conformance_*.md`). The fix needs a persisted per-ticket artifact-progress counter that survives manager relaunch — hence the schema field, hence the bump.

## Scope / version

- **Version: MINOR** (1.85.0 → 1.86.0). The `schema_version` 4→5 increment is forward-migrated via `normalizeV5StateDefaults` (old v4 state.json auto-upgrades on read, backward-compatible), so it is a feature add, not a breaking change, per the babysitter DECISION RULES.
- **Overlap:** B-WSWA owns #33 R-WMW (earlier drain-queue row than B-WEDGE); B-WEDGE recomposes to #30 R-RSU only.
- Schema migration uses the sanctioned `_internalSchemaBump` path (the ONLY permitted R-WSRC-1 write-ceiling bypass).

## Atomic tickets

### R-WSWA-1 [schema-migration] (medium) — Bump LATEST_SCHEMA_VERSION 4→5 + forward migration
- Bump `LATEST_SCHEMA_VERSION = 5` in `extension/src/types/index.ts`.
- Add `normalizeV5StateDefaults(state)` in `extension/src/services/state-manager.ts` (mirrors `normalizeV3StateDefaults` pattern) initializing the new optional field `worker_artifact_progress` (a per-ticket map: `{ [ticketId]: { spawn_count, last_artifact_count, zero_progress_count } }`) to `{}` when absent; call it from ALL THREE `migrateSchema` branches.
- The migration write that increments `schema_version` MUST pass `_internalSchemaBump: true` (per R-WSRC-1 exemption); no other call site may.
- Rebuild deployed `extension/types/index.js` + `extension/services/state-manager.js` in the same change (AC-RVN-08 deploy parity).
- Add the `worker_artifact_progress` field invariant to `extension/CLAUDE.md` `## state.json Field Invariants`.
- **AC:** `LATEST_SCHEMA_VERSION===5` in source AND deployed; a v4 state.json read returns schema_version 5 with `worker_artifact_progress: {}` and no `SchemaVersionAheadError`; `state-manager.test.js` + `state-schema-version-deploy-parity.test.js` green.

### R-WSWA-2 (medium) — Artifact-progress tracking + K=3 observability (R-WMW-2)
- In `mux-runner.ts`, per ticket snapshot `code_review_*.md` + `conformance_*.md` count BEFORE each worker spawn and AFTER it exits; persist deltas into `state.worker_artifact_progress[ticketId]` via `StateManager.update()` (NOT in-process memory — MUST survive manager relaunch per R-MMTR boundary).
- After K=3 (`PICKLE_WMW_OBSERVE_K`, default 3) consecutive zero-delta spawns on the same ticket, emit `worker_artifact_progress_zero` (observability only, no action).
- **AC:** integration fixture shows the counter persists across a simulated manager relaunch; `worker_artifact_progress_zero` fires at exactly K=3.

### R-WSWA-3 (medium) — Auto-skip at K=5 (R-WMW-3)
- After K=5 (`PICKLE_WMW_SKIP_K`, default 5) consecutive zero-progress spawns, flip the ticket to `Failed` with reason `oversized_no_progress` (recoverable — dirty tree preserved), emit `worker_auto_skip_oversized`, advance the loop.
- Add `oversized_no_progress` to `FAILURE_REASONS` in `extension/src/types/index.ts`.
- **AC:** at K=5 the ticket ends `Failed`/`oversized_no_progress`; dirty tree untouched; loop advances to next ticket or relaunches manager per R-MMTR.

### R-WSWA-4 (small) — Event registration + payload enrichment (the #74 "event payload enrichment per original AC" + EVENT_NAMES/VALID_ACTIVITY_EVENTS drift)
- Register `worker_artifact_progress_zero` and `worker_auto_skip_oversized` in `VALID_ACTIVITY_EVENTS`, `EVENT_NAMES`, and `activity-events.schema.json` with `gate_payload` quartet `{ ticket_id, spawn_count, last_artifact_count, manager_turn_budget_remaining }` (the original R-WSWA AC).
- **AC:** `activity-event-payload.test.js` schema-conformance green for both new events; no EVENT_NAMES/VALID_ACTIVITY_EVENTS drift (the 5-regression class from #74 resolved).

### R-WSWA-5 (medium) — Regression integration test (R-WMW-4)
- New `extension/tests/integration/worker-manager-wedge-oversized.test.js` + `extension/tests/fixtures/oversized-umbrella-ticket.md` + fake-worker (always exits clean, zero artifacts).
- **AC:** asserts K=3 observability events, 1 `worker_auto_skip_oversized`, ticket ends `Failed`/`oversized_no_progress`.

### R-WSWA-6 (small) — Trap-door pin (R-WMW-5)
- Pin the artifact-progress + auto-skip invariant in `extension/src/bin/CLAUDE.md` (per-ticket artifact-count snapshots across spawn boundaries; K=3 emit; K=5 auto-skip; `oversized_no_progress` recoverable). ENFORCE: `worker-manager-wedge-oversized.test.js`.
- **AC:** `audit-trap-door-enforcement.sh` green with the new entry (ENFORCE test exists per R-WSWA-5).

### C-WSWA-CLOSER [manager] (small) — Ship
- Full release gate from `extension/` (tsc --noEmit, eslint --max-warnings=-1, tsc, all audit-*.sh, test:fast, test:integration, RUN_EXPENSIVE_TESTS=1 test:expensive). Confirm GREEN.
- Bump `extension/package.json` 1.85.0 → **1.86.0** (MINOR — forward-migrated schema add). `bash install.sh` (confirm deploy parity incl. types/state-manager). Verify clean tree + JS==TS.
- `git push` + `gh release create v1.86.0`.
- Update `prds/MASTER_PLAN.md`: B-WSWA → SHIPPED; close #74 + #33; B-WEDGE recomposed to #30 R-RSU only.

## Acceptance criteria

| ID | Criterion | Evidence | Owner |
|---|---|---|---|
| AC-WSWA-01 | `LATEST_SCHEMA_VERSION===5` source+deployed; v4→v5 forward migration adds `worker_artifact_progress:{}`; no schema-ahead trip. | state-manager + deploy-parity tests. | R-WSWA-1 |
| AC-WSWA-02 | Per-ticket artifact-progress counter persists across manager relaunch; `worker_artifact_progress_zero` at K=3. | Integration test. | R-WSWA-2 |
| AC-WSWA-03 | K=5 auto-skip → `Failed`/`oversized_no_progress`, dirty tree preserved, `worker_auto_skip_oversized` emitted. | Integration test. | R-WSWA-3 |
| AC-WSWA-04 | Both new events registered (VALID_ACTIVITY_EVENTS + EVENT_NAMES + schema) with the gate_payload quartet; no drift. | activity-event-payload test. | R-WSWA-4 |
| AC-WSWA-05 | Oversized-fixture regression test green. | `worker-manager-wedge-oversized.test.js`. | R-WSWA-5 |
| AC-WSWA-06 | Trap-door pinned + enforced. | `audit-trap-door-enforcement.sh`. | R-WSWA-6 |
| AC-WSWA-07 | Ship: gate green, v1.86.0 tagged, MASTER_PLAN repointed, #74+#33 closed, B-WEDGE recomposed. | git log + gh release + MASTER_PLAN diff. | C-WSWA-CLOSER |

## Trap doors
- **R-WSWA-SCHEMA** — `_internalSchemaBump` is the ONLY write-ceiling bypass; the v5 migration is the only call site. ENFORCE: state-manager schema-write-ceiling test.
- **R-WSWA-PERSIST** — artifact-progress counter is persisted (survives relaunch), never in-process only. ENFORCE: `worker-manager-wedge-oversized.test.js`.

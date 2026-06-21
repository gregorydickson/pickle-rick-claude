---
title: "R-WSDO — worker-produced-nothing observability breadcrumb"
priority: P3
status: Ready
schema_neutral: true
date: 2026-06-21
source: prds/BUG-REPORT-2026-06-21-pipeline-self-referential-build-catch22-and-orphan-mux.md
---

# R-WSDO — Worker-produced-nothing breadcrumb

## Problem
When a worker spawn yields a **0-byte `worker_session_<pid>.log`** AND a **zero artifact delta**, there
is no forensic signal to distinguish (a) silent death, (b) spawn failure, (c) a worker that ran but
produced nothing. This blindness cost an overnight misdiagnosis during the B-PCOMP build (we read it as
contention when the real cause was deterministic). The existing `worker_partial_lifecycle_exit` (R-WSE-2)
covers "research APPROVED but later artifacts missing" — NOT "produced nothing at all".

## Solution
Emit a new activity event **`worker_produced_nothing`** from `mux-runner.ts` immediately after the
existing post-iteration artifact-delta snapshot (the `recordWorkerArtifactProgress` site), when BOTH
hold: the iteration's `worker_session_<pid>.log` is 0 bytes AND the artifact delta for the ticket is 0.
Payload carries `{ ticket, gate_payload: { spawn_pid, session_log_bytes, artifact_delta } }` plus the
standard `event` + `ts`. Best-effort (try/catch — telemetry never crashes the runner). Observability
ONLY: it never changes reap/salvage behavior (the reap decision stays exactly as-is).

## Interface Contracts
- **Inputs:** the just-finished iteration's ticket id, its `worker_session_<pid>.log` path, and the
  pre/post artifact counts already computed at the `recordWorkerArtifactProgress` call site.
- **Outputs:** at most one `worker_produced_nothing` activity event per qualifying spawn, written via the
  same `writeActivityEntry`/`logActivity` path used by sibling events; payload shape
  `{ event: 'worker_produced_nothing', ts: <ISO>, ticket: <id>, gate_payload: { spawn_pid: number, session_log_bytes: 0, artifact_delta: 0 } }`.
- **Errors:** any failure in the breadcrumb path is swallowed (best-effort); never throws into the loop.
- **Invariants:** the event is registered in `VALID_ACTIVITY_EVENTS` (`src/types/index.ts`) and has a
  `oneOf` definition in `src/types/activity-events.schema.json` with `required: ['event','ts','ticket','gate_payload']`; emission is observability-only and does not alter reap/salvage control flow.

## Acceptance Criteria
- [ ] A spawn with a 0-byte `worker_session_<pid>.log` AND zero artifact delta emits exactly one
  `worker_produced_nothing` event with the payload quartet — Verify: `node --test extension/tests/worker-produced-nothing.test.js` — Type: test
- [ ] A spawn that produced artifacts (positive delta) does NOT emit the event — Verify: same test, negative case — Type: test
- [ ] The event is registered + schema-conformant — Verify: `node --test extension/tests/activity-event-payload.test.js` — Type: test
- [ ] Reap/salvage behavior is unchanged (observability-only) — Verify: `node --test extension/tests/integration/worker-manager-wedge-oversized.test.js` — Type: test
- [ ] Type checker passes — Verify: `cd extension && npx tsc --noEmit` — Type: typecheck

## Test Expectations
| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| Breadcrumb fires | `extension/tests/worker-produced-nothing.test.js` (forward-created) | 0-byte log + 0 delta | one event, payload quartet present |
| No false positive | `extension/tests/worker-produced-nothing.test.js` (forward-created) | positive artifact delta | no event |

## Conformance Check
- [ ] Type checker passes — no new errors
- [ ] Test runner passes — all acceptance tests
- [ ] Event registered in `VALID_ACTIVITY_EVENTS` + schema `oneOf`
- [ ] Reap/salvage control flow untouched (observability-only)

## Simplification Review
1. **Necessary?** Yes — closes the R-WSDO forensic blind spot logged in the bug report; one event, no new control flow.
2. **Reuse vs add?** Reuses the existing `writeActivityEntry` path + the artifact counts already computed at the `recordWorkerArtifactProgress` site; adds no new probe.
3. **Guards brittle complexity?** No new guard — pure observability.
4. **Subtract?** No subtraction available (net +1 event); reason: it is the minimal signal that removes an N-hour misdiagnosis class.

## NOT in Scope
Changing reap/salvage behavior. Capturing the worker exit code/signal beyond what is reapable at the call
site. R-SLEAK session-GC (separate deferred finding).

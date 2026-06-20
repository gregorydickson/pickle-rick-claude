# DRAFT PRD: extension/src/types/ CLAUDE.md — Public Export Documentation

**Status**: DRAFT (follow-up from audit ticket 2bc35531)
**Drift class**: INCOMPLETE (1% export coverage — only 1/101 exports mentioned)
**Priority**: P3

## Problem

`extension/src/types/CLAUDE.md` contains only 2 trap-door entries (`activity-events.schema.json`, `index.ts`). It does not enumerate the 101 public exports from `index.ts` (the canonical shared-types module), the schema fallback, or the plumbus-frame-analyzer types. The types module is imported by nearly every other subsystem and its invariants cascade through the entire codebase.

## Public Exports by File

| File | Key exports |
|------|-------------|
| index.ts | State, Backend, BackendResolutionSource, WorkerBackendResolutionSource, BACKENDS, ExitReason, isFailureExit, VALID_ACTIVITY_EVENTS, ActivityEventType, ActivityEvent, PromiseTokens, LockError, StateError, TransactionError, FALSE_EPIC_THRESHOLD, TICKET_TIER_BUDGETS, TicketTier |
| attractor-schema.fallback.ts | AttrScope, AttrType, AttrDef, FallbackSchema, ATTRACTOR_SCHEMA_FALLBACK, ALL_ATTRS |
| index.ts (continued) | ALL_EXITS, ALL_STEPS, ALL_TICKET_STATUSES, ARTIFACT_PREFIXES, VALID_EFFORTS |
| engine-keys-registry.ts | EngineKeysRegistry |
| plumbus-frame-analyzer.ts | ContextKeyRow, DiamondRoutingRow, CycleRow, AnalyzerOutput, Node |

## Full Export List from index.ts (key symbols)

State, Backend, BackendResolutionSource, WorkerBackendResolutionSource, BACKENDS, ExitReason, ALL_EXITS, isFailedExit, isFailureExit, Step, ALL_STEPS, TicketTier, TicketTierBudget, TICKET_TIER_BUDGETS, FALSE_EPIC_THRESHOLD, VALID_ACTIVITY_EVENTS, ActivityEventType, ActivityEvent, ActivityLogEntry, ActivityEventSource, PromiseTokens, PROMISE_TOKEN_STRINGS, StateError, LockError, TransactionError, InvalidActivityEventError, SchemaVersionDeployDriftError, VALID_EFFORTS, ReasoningEffort, ARTIFACT_PREFIXES, ALL_TICKET_STATUSES, TicketStatus

## Suggested Invariants

- `VALID_ACTIVITY_EVENTS` — The authoritative set of valid event types; `log-activity.js` rejects events not in this set
- `ExitReason` / `isFailureExit` — `isFailureExit` is the canonical predicate; callers must not inline their own exit-reason checks
- `BACKENDS` / `Backend` — All valid backend identifiers; new backends must be added here before being used in spawn logic
- `TICKET_TIER_BUDGETS` — Base tier budgets; never mutated at runtime; overrides go through `getTicketTierBudgetWithOverrides`
- `ARTIFACT_PREFIXES` — The canonical list of lifecycle artifact prefixes; retry-ticket uses this for archival

## Suggested Trap-Door Entries

```
- `src/types/index.ts` (VALID_ACTIVITY_EVENTS) — INVARIANT: every new activity event type must be added to VALID_ACTIVITY_EVENTS before log-activity.js will accept it; runtime callers validate against this set. BREAKS: new event types are silently rejected by the logger. ENFORCE: extension/tests/activity-event-payload.test.js.
- `src/types/index.ts` (ExitReason) — INVARIANT: isFailureExit / isFailedExit are the canonical exit-reason predicates; inline string comparisons are forbidden. BREAKS: new exit reasons added to ExitReason but not to isFailureExit cause auto-resume.sh to loop forever on non-failure exits. ENFORCE: extension/tests/auto-resume-stop-conditions.test.js.
```

## Acceptance Criteria (for follow-up ticket)

- [ ] `extension/src/types/CLAUDE.md` enumerates all key exports from index.ts with cross-subsystem invariants
- [ ] Trap-door entries for `VALID_ACTIVITY_EVENTS` and `ExitReason`/`isFailureExit` added
- [ ] Drift audit script reports `OK` for types/ subsystem after update

---
id: co03cc03
title: "Add TIMEOUT_EXCEEDED StateErrorCode + handler in state-manager.ts"
status: Todo
priority: High
order: 30
complexity_tier: medium
mapped_requirements: []
created: 2026-06-14
updated: 2026-06-14
expected_consumer_files: expected_consumer_files.json
---

<!-- audit: 7-class checked 2026-06-14 -->

# Description

**cross-file justification**: `state-manager.ts` consumes `StateErrorCode` from `types/index.ts` — a new variant must be declared in the type union AND handled in the state-manager's error switch.

## Problem to solve

Long-running state operations that hit the lock timeout emit a generic `LOCK_FAILED` code, which is indistinguishable from a write failure at the call site. A dedicated `TIMEOUT_EXCEEDED` `StateErrorCode` variant would let callers distinguish timed-out locks from outright write failures and apply different retry strategies.

## Implementation Details

### Files to modify

- `extension/src/types/index.ts` — add `'TIMEOUT_EXCEEDED'` to the `StateErrorCode` union type
- `extension/src/services/state-manager.ts` — add `case 'TIMEOUT_EXCEEDED':` to the relevant error-handling switch; throw a `LockError` with the new code when a lock poll exceeds `lockTimeoutMs`

## Acceptance Criteria

- [ ] `StateErrorCode` in `types/index.ts` includes `'TIMEOUT_EXCEEDED'`
- [ ] `state-manager.ts` throws `new LockError('TIMEOUT_EXCEEDED', ...)` on lock poll timeout
- [ ] Existing `LOCK_FAILED` paths are unmodified

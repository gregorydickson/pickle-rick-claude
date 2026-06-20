# DRAFT PRD: extension/src/hooks/ CLAUDE.md — Public Export Documentation

**Status**: DRAFT (follow-up from audit ticket 2bc35531)
**Drift class**: INCOMPLETE (0% export coverage)
**Priority**: P3

## Problem

`extension/src/hooks/CLAUDE.md` contains only 2 trap-door entries. It does not enumerate public exports from the 2 source files (resolve-state.ts, dispatch.ts). The hooks subsystem is a security-critical boundary (config protection, stop-hook) and agents modifying it need invariant context.

## Public Exports by File

| File | Exports |
|------|---------|
| resolve-state.ts | selectScannedStateFile, resolveStateFile, loadActiveState, approve |
| dispatch.ts | (CLI entry point, no named exports) |
| handlers/config-protection.ts | (handler, invoked via dispatch) |
| handlers/stop-hook.ts | (handler, invoked via dispatch) |

## Suggested Invariants

- `resolve-state.ts` — `resolveStateFile` is the canonical hook session resolver; callers must not bypass it in favor of direct `state.json` reads
- `approve` — The only valid hook decision values are `"approve"` and `"block"` (never `"allow"`)
- `loadActiveState` — Returns recovered state via `StateManager.read()`; must not return raw `JSON.parse` results
- `selectScannedStateFile` — Scans same-cwd sessions as fallback when `current_sessions.json` is stale or absent

## Suggested Trap-Door Entries

```
- `src/hooks/resolve-state.ts` (approve sentinel) — INVARIANT: the only valid hook response values are "approve" and "block"; "allow" is rejected by the harness. BREAKS: hooks silently fail to block protected operations. ENFORCE: extension/tests/stop-hook.test.js, extension/tests/config-protection.test.js.
```

## Acceptance Criteria (for follow-up ticket)

- [ ] `extension/src/hooks/CLAUDE.md` updated to enumerate all exports from resolve-state.ts
- [ ] Handler-level invariants documented (config-protection, stop-hook)
- [ ] Drift audit script reports `OK` for hooks/ subsystem after update

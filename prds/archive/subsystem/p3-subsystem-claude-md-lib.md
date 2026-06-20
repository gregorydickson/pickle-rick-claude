# DRAFT PRD: extension/src/lib/ CLAUDE.md — Public Export Documentation

**Status**: DRAFT (follow-up from audit ticket 2bc35531)
**Drift class**: INCOMPLETE (0% export coverage)
**Priority**: P3

## Problem

`extension/src/lib/CLAUDE.md` contains only 2 trap-door entries for `context-key-matrix.ts` and `diamond-routing.ts`. It does not enumerate all 13 public exports across the 8 source files. The lib/ subsystem provides pure graph algorithms and utilities consumed by the plumbus-frame-analyzer pipeline.

## Public Exports by File

| File | Exports |
|------|---------|
| cluster-fix-selector.ts | FrameId, Finding, selectFix |
| context-key-matrix.ts | buildContextKeyMatrix |
| diamond-routing.ts | buildDiamondRouting |
| engine-keys-registry.ts | loadEngineKeysRegistry, isUserWritten, isEngineWritten |
| plumbus-kill-switch.ts | shouldRunGenerativeAudit |
| severity.ts | Severity, maxSeverity |
| tarjan-scc.ts | buildCycles |
| verification-comparator.ts | structuralEqual |

## Suggested Invariants

- `buildCycles` (tarjan-scc.ts) — Pure function; input is adjacency list, output is array of SCC arrays. No I/O side effects.
- `structuralEqual` (verification-comparator.ts) — Deep structural equality; does not use JSON.stringify; handles circular refs.
- `shouldRunGenerativeAudit` (plumbus-kill-switch.ts) — Reads `PLUMBUS_GENERATIVE_AUDIT` env var; returns false when set to `"off"`.
- `loadEngineKeysRegistry` (engine-keys-registry.ts) — Runtime-validates the registry JSON as string arrays before returning.
- `selectFix` (cluster-fix-selector.ts) — Selects highest-severity finding from a cluster; `maxSeverity` is the ordering function.

## Suggested Trap-Door Entries

```
- `src/lib/plumbus-kill-switch.ts` — INVARIANT: shouldRunGenerativeAudit returns false only when PLUMBUS_GENERATIVE_AUDIT === 'off' (exact lowercase). BREAKS: non-exact comparisons disable audit on misconfigured envs. ENFORCE: extension/tests/plumbus-frame-analyzer-contract.test.js.
- `src/lib/severity.ts` — INVARIANT: Severity is a comparable type; maxSeverity is the only authoritative comparator. BREAKS: direct string comparison produces wrong fix selection order. ENFORCE: extension/tests/plumbus-frame-analyzer-contract.test.js.
```

## Acceptance Criteria (for follow-up ticket)

- [ ] `extension/src/lib/CLAUDE.md` enumerates all 13 exports with per-function invariants
- [ ] Trap-door entries added for kill-switch and severity comparator
- [ ] Drift audit script reports `OK` for lib/ subsystem after update

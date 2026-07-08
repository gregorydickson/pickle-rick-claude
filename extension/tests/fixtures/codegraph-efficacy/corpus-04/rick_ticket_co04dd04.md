---
id: co04dd04
title: "Thread configurable workerSpawnTimeoutMs from spawn-morty.ts into backend-spawn.ts"
status: Todo
priority: High
order: 40
complexity_tier: medium
mapped_requirements: []
created: 2026-06-14
updated: 2026-06-14
expected_consumer_files: expected_consumer_files.json
---

<!-- audit: 7-class checked 2026-06-14 -->

# Description

**cross-file justification**: `spawn-morty.ts` invokes `backend-spawn.ts` helpers for subprocess launch — a new timeout field must be added to backend-spawn's `SpawnOptions` type AND read at spawn-morty's call site.

## Problem to solve

Worker subprocess spawn timeouts are currently hardcoded in `backend-spawn.ts`. A new `workerSpawnTimeoutMs` field in the pickle settings should flow from `spawn-morty.ts` (which reads the settings) into `backend-spawn.ts` (which owns the `spawnSync` call). Currently there is no mechanism to pass this value across the module boundary.

## Implementation Details

### Files to modify

- `extension/src/services/backend-spawn.ts` — add `workerSpawnTimeoutMs?: number` to the `SpawnOptions` interface; use it (with a compiled-in default fallback) in the `spawnSync` call
- `extension/src/bin/spawn-morty.ts` — read `settings.workerSpawnTimeoutMs` from the resolved pickle settings and pass it as `workerSpawnTimeoutMs` in the `SpawnOptions` object

## Acceptance Criteria

- [ ] `SpawnOptions.workerSpawnTimeoutMs?: number` exists in `backend-spawn.ts`
- [ ] `spawn-morty.ts` passes `workerSpawnTimeoutMs` when the setting is defined
- [ ] Omitting the setting falls back to the existing compiled default

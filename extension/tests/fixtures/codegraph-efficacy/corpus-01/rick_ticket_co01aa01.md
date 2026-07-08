---
id: co01aa01
title: "Add queryContext() to CodegraphService and wire into setup.ts"
status: Todo
priority: High
order: 10
complexity_tier: medium
mapped_requirements: []
created: 2026-06-14
updated: 2026-06-14
expected_consumer_files: expected_consumer_files.json
---

<!-- audit: 7-class checked 2026-06-14 -->

# Description

**cross-file justification**: `setup.ts:17` imports `CodegraphService` — any new service method must be declared in `codegraph-service.ts` and called in `setup.ts`.

## Problem to solve

The codegraph probe needs a `queryContext(ticketDir: string): string` method on `CodegraphService` that queries the DB for files referenced by a ticket and returns a formatted context block. Currently `CodegraphService` has no such method, so `setup.ts` cannot inject context at the right point in the session summary.

## Implementation Details

### Files to modify

- `extension/src/services/codegraph-service.ts` — add `queryContext(ticketDir: string): string | null` method; returns `null` when the service is disabled or the DB is absent
- `extension/src/bin/setup.ts` — import and call `queryContext()` after the session summary is written; append result to the worker prompt under a `## Code Graph Context` header

## Acceptance Criteria

- [ ] `CodegraphService.queryContext()` is defined with the correct signature
- [ ] `setup.ts` calls `svc.queryContext(ticketDir)` and appends the result when non-null
- [ ] Calling `queryContext()` when disabled returns `null` without touching the DB

---
id: co05ee05
title: "Add p95ByDay token aggregation to metrics.ts backed by computeP95 in metrics-utils.ts"
status: Todo
priority: High
order: 50
complexity_tier: medium
mapped_requirements: []
created: 2026-06-14
updated: 2026-06-14
expected_consumer_files: expected_consumer_files.json
---

<!-- audit: 7-class checked 2026-06-14 -->

# Description

**cross-file justification**: `bin/metrics.ts` imports aggregation helpers from `services/metrics-utils.ts` — the new `computeP95` function must be added to the utils module and consumed in the metrics binary's report builder.

## Problem to solve

The `/pickle-metrics` report shows mean token usage but hides tail latency. A `p95ByDay` row — the 95th-percentile tokens per day — would surface runaway sessions. The computation logic belongs in `metrics-utils.ts` (reusable aggregation), while the report column belongs in `metrics.ts` (formatting and output).

## Implementation Details

### Files to modify

- `extension/src/services/metrics-utils.ts` — add `computeP95(values: number[]): number` function; export it; return 0 for empty arrays
- `extension/src/bin/metrics.ts` — import `computeP95` from `metrics-utils.ts`; call it over the per-day token arrays; emit a `p95ByDay` row in the JSON and text report

## Acceptance Criteria

- [ ] `computeP95` is exported from `metrics-utils.ts`
- [ ] `metrics.ts` imports and calls `computeP95`
- [ ] `/pickle-metrics` JSON output includes a `p95ByDay` field
- [ ] Empty-array input to `computeP95` returns 0 without throwing

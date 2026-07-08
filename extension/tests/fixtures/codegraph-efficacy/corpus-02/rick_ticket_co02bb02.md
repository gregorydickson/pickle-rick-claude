---
id: co02bb02
title: "Adjust convergence gate minDelta threshold + microverse-runner call site"
status: Todo
priority: High
order: 20
complexity_tier: medium
mapped_requirements: []
created: 2026-06-14
updated: 2026-06-14
expected_consumer_files: expected_consumer_files.json
---

<!-- audit: 7-class checked 2026-06-14 -->

# Description

**cross-file justification**: `microverse-runner.ts:72` imports `runGate` from `convergence-gate.ts` — the threshold constant lives in the service, and the call-site parameter lives in the runner.

## Problem to solve

The default `minDelta` threshold in `convergenceGate` is too aggressive for small codebases: it fires a no-progress event when a gate delta is non-zero but below the threshold. Raising the threshold requires updating the default in `convergence-gate.ts` AND updating the `minDelta` argument passed at the call site in `microverse-runner.ts`.

## Implementation Details

### Files to modify

- `extension/src/services/convergence-gate.ts` — change the default `MIN_DELTA` constant from 0 to a named export `DEFAULT_MIN_DELTA = 0.02`; update internal usages
- `extension/src/bin/microverse-runner.ts` — update the `runGate(...)` call to pass `minDelta: DEFAULT_MIN_DELTA` explicitly, imported from `convergence-gate.ts`

## Acceptance Criteria

- [ ] `DEFAULT_MIN_DELTA` exported from `convergence-gate.ts`
- [ ] `microverse-runner.ts` imports and passes `DEFAULT_MIN_DELTA` to `runGate`
- [ ] No-progress event count decreases for near-threshold deltas in integration tests

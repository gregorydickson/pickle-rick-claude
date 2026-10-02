# B-LANES-UNCHECKED — disclose lanes integrated without a typecheck (#52 lane part; branch-specific, `exp/b-lanes`)

Issue #52 reported `anatomy lanes: integration_check: unavailable — accepting the lane` for monorepo lanes. The
general half of #52, the unbounded refusal loop, shipped as B-SELFRED. This bundle is the lane-only remainder.

## Mechanism (read at `exp/b-lanes@1816dc36`)

`pickLane` (`extension/src/services/anatomy-lanes.ts` ~`:303`) calls `runIntegrationTypecheck`. That returns
`'unavailable'` when no typecheck command ran, which is the case in a monorepo whose typecheck scripts live deeper
than discovery reaches. The lane then returns `'integrated'`. Only a log line records that the lane was never checked:
- `archive/lanes.json` says `integrated`;
- the phase verdict reads `converged`;
- the pipeline reports plain success.

A lane integrated without a check is indistinguishable from a checked one. This is the fake-green class.

## Fix — disclose, do not refuse

Refusing on `'unavailable'` would discard every monorepo lane's work, which takes output to zero. The honest fix is
disclosure through channels that already exist:

1. `IntegrateLanesResult` gains `checks: ('green' | 'unavailable' | null)[]`, one per lane in roster order. `null`
   means the lane was not picked or its pick conflicted. `pickLane` already computes the value, so return it and
   stop dropping it.
2. Each `archive/lanes.json` row (`LaneOutcome`) gains `integration_check: 'green' | 'unavailable' | null`, taken
   from (1). `outcome` stays `integrated`. The work did land.
3. If at least one lane was integrated with `integration_check === 'unavailable'`, `runAnatomyLanes` records
   `integration_typecheck` in the parent session's `microverse.json` `cap_unmeasured_checks`, via the EXISTING
   `recordCapUnmeasured` (`services/microverse-state.ts`), which `finalize-gate.ts` already uses. The existing
   `reportConvergedWithUnmeasured` then appends `converged_with_unmeasured:integration_typecheck` to the phase
   disposition, and the existing verdict path withholds success.
   - No new event, field-reader, disposition or halt.
   - If the parent has no `microverse.json` at that point, research must establish that. Then create it through
     `writeMicroverseState`, or pick the nearest existing channel, and justify the choice in the research artifact.

## Acceptance criteria (the new cases fail at `1816dc36`)

1. In the existing integration fixture in `extension/tests/pipeline-runner.test.js` (the `14b/14c` block ~`:5223`
   shows the harness), stub typecheck discovery so that NO command runs. Then:
   - both lanes are `integrated`;
   - each `lanes.json` row has `integration_check: 'unavailable'`;
   - parent `microverse.json` `cap_unmeasured_checks` contains `integration_typecheck`.

   Verify: `cd extension && ./node_modules/.bin/tsc && node --test --test-name-pattern="unchecked integration"
   tests/pipeline-runner.test.js`.
2. Control: a fixture whose typecheck runs green yields `integration_check: 'green'` and NO `integration_typecheck`
   entry in `cap_unmeasured_checks`.
3. The existing `14b/14c` red case still yields `integration_red` and its row carries `integration_check: null`,
   because the pick was undone. The whole `tests/pipeline-runner.test.js` passes.
4. `./node_modules/.bin/tsc --noEmit` and `./node_modules/.bin/eslint src/ --max-warnings=0` exit 0.

## Simplification Review
- Reuses `recordCapUnmeasured` → `reportConvergedWithUnmeasured`, the B-CAPGATE disclosure. It adds one field to the
  result the value already flowed through, and one to the row.
- It subtracts a silent acceptance: the log line becomes a measured disclosure.

## Out of scope
- Deeper typecheck discovery for monorepos (a separate question).
- #52's lane that never passed gap analysis: no cause is known yet, and the evidence is outside this repo.

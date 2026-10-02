# B-LANES-UNCHECKED-FIX — a regression test that never runs, and the catalog entry pointing at it (branch-specific, `exp/b-lanes`)

The gate on `exp/b-lanes@266152d4` passed 21/22 legs. `test_fast_budget` is red with 2 deterministic failures in all
3 runs, both in `extension/tests/citadel/rule-set-invariant-audit.test.js`. The audit reports
`extension/src/bin/CLAUDE.md: entries below the cut are malformed: malformed-triple:bad-enforce-ref`. Measured
2026-10-01.

## Mechanism

Anatomy-park commit `a213e996` fixed a HIGH (AP-LANES-ITER1-01: `discloseUnmeasuredIntegration` must carry an
integrated lane's own `cap_unmeasured_checks` to the parent). Because no pipeline-runner test file was in that lane's
scope, it hosted the regression test in `extension/src/bin/__tests__/microverse-runner.handleIterationOutcome.spec.ts`.

- **The test never runs.** `bin/test-runner.js` `discoverTestFiles` collects only `*.test.js` files, so
  `bin/__tests__/*.spec.js` is in no tier. The fix it pins is therefore unpinned.
- **The audit rejects the reference.** The catalog entry's ENFORCE points at `….spec.ts`, which the audit's
  `ENFORCE_HAS_REF_RE` (`/\.(test\.js|spec\.js|sh)\b/`) rejects.

The audit is right twice over: the reference is to source, and the test it names is dead.

## Fix

1. Move the `AP-LANES-ITER1-01` test case, unchanged in substance, into `extension/tests/pipeline-runner.test.js`.
   Express it in that file's JS idiom.
2. Delete that case from `extension/src/bin/__tests__/microverse-runner.handleIterationOutcome.spec.ts`. Leave the
   file's other, pre-existing cases alone. Recompile so the `extension/bin/__tests__/` mirror matches.
3. Point the AP-LANES-ITER1-01 entry's ENFORCE in `extension/src/bin/CLAUDE.md` at
   `extension/tests/pipeline-runner.test.js#AP-LANES-ITER1-01`. Keep the entry on one physical line.

## Acceptance criteria (measured red at `266152d4`)

1. `cd extension && ./node_modules/.bin/tsc && node --test tests/citadel/rule-set-invariant-audit.test.js` passes
   (HEAD: 2 failing). `bash scripts/audit-trap-door-enforcement.sh` exits 0.
2. `cd extension && node --test --test-name-pattern="AP-LANES-ITER1-01" tests/pipeline-runner.test.js` runs exactly 1
   passing test (HEAD: 0 tests match).
   - Mutation control: making `discloseUnmeasuredIntegration` skip the lanes' own caps reds it. Record that in a
     comment.
3. `grep -c "AP-LANES-ITER1-01" extension/src/bin/__tests__/microverse-runner.handleIterationOutcome.spec.ts`
   returns 0 (HEAD: ≥ 1).
4. `./node_modules/.bin/tsc --noEmit` and `./node_modules/.bin/eslint src/ --max-warnings=0` exit 0.

## Simplification Review

This moves one test to where the runner finds it, and repoints one reference. No product change.

## Out of scope

The other `bin/__tests__/*.spec.ts` cases are also never run by any tier. That is a separate finding, recorded in
this PRD only.

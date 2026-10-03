# B-LANES-MERGE-G — the merge of B-ATTRIB-G made a lane wiring test's fixture unmeasurable (branch-specific, `exp/b-lanes`)

The gate on `exp/b-lanes@d27b8be1` (merge of `main` / B-ATTRIB-G into the branch, gate `20261002T004822Z-46820`)
is red on `test_fast_budget`: ONE deterministic failure in all 3 runs,
`extension/tests/pipeline-runner.test.js` › `B-LANES wiring: end to end through main()` › `AC 1` —
`the phase finalizes clean: 1 !== 0`. Measured 2026-10-02.

## Mechanism

Two correct changes meet for the first time in this merge:

- **Branch (B-LANES-UNCHECKED):** when no typecheck command can run on the integration worktree,
  `runIntegrationTypecheck` returns `unavailable`, the lane is accepted, and
  `discloseUnmeasuredIntegration` discloses `integration_typecheck` as an unmeasured check.
- **Main (B-ATTRIB-G D2, `f73e828d`):** a converged phase whose `cap_unmeasured_checks` is non-empty
  WITHHOLDS the success verdict (`counters.nonConvergent++`), so `main()` exits 1.

The AC 1 fixture (`makeFixture` in that describe) seeds only `<lane>/{a,b,c}.ts` — no project marker — so every
integration check is `unavailable` (log: `integration_check: unavailable — accepting the lane` ×3, then
`converged_with_unmeasured:integration_typecheck`). The test still asserts exit 0. **The product is right; the
test's fixture no longer measures what its title claims** ("verdict converged" means a MEASURED clean run).

Probe at HEAD (compiled `services/anatomy-lanes.js`): a bare dir → `unavailable`; the same dir with a
`package.json` whose `scripts.typecheck` is `true` → `green`; with `false` → `red`.

## Fix

1. Give the B-LANES wiring fixture a runnable typecheck: seed a root `package.json`
   (`{"name":"fx","private":true,"scripts":{"typecheck":"true"}}`) in `makeFixture`'s initial commit, so AC 1 is a
   measured clean run and keeps asserting exit 0. AC 2 (serial) must stay green.
2. Add one sibling case in the same describe, titled `AC 1b: an UNMEASURED integration check withholds success`:
   the fixture WITHOUT the typecheck script (pass an option to `makeFixture`), `anatomy_max_parallel_lanes: 3`;
   assert `main()` returns non-zero, the log matches `converged_with_unmeasured:integration_typecheck`, and all
   three lanes are still integrated in `archive/lanes.json` (nothing halts; only the verdict is withheld).
   Label it a regression guard: it passes at HEAD by design.

No product source changes.

## Acceptance criteria (measured at `d27b8be1`)

1. `cd extension && ./node_modules/.bin/tsc && node --test --test-name-pattern="AC 1: anatomy_max_parallel_lanes 3" tests/pipeline-runner.test.js`
   → 1 passing test (HEAD: 1 failing, `1 !== 0`).
2. `cd extension && node --test --test-name-pattern="AC 1b" tests/pipeline-runner.test.js` → exactly 1 passing test
   (HEAD: 0 tests match). Mutation control, recorded in a comment: forcing `discloseUnmeasuredIntegration` to
   return no checks reds AC 1b.
3. `cd extension && node --test --test-name-pattern="B-LANES wiring" tests/pipeline-runner.test.js` → 0 failures
   (HEAD: 1 failure).
4. `./node_modules/.bin/tsc --noEmit` and `./node_modules/.bin/eslint src/ --max-warnings=0` exit 0.

## Simplification Review

1. Necessary? Only a fixture marker and one guard case; no product addition.
2. Reuse: reuses `makeFixture`, `fixingRunner`, `runLaneMain`.
3. Guards brittle complexity? No — both behaviours are the intended ones; the fixture was stale.
4. Subtraction: none available; the honest fix is making the fixture measurable.

## Out of scope

`main` (no lane wiring there). B-ATTRIB-L (queue step 3).

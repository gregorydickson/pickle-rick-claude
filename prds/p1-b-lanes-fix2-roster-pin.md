# B-LANES-FIX2 — the 10-lane roster test pins the LIVE tree (branch-specific; `exp/b-lanes` only)

Gate `20260927T025918Z-86096` on `exp/b-lanes` at `a0785b25` (after the rule-P merge of B-FINALGATE): `test_fast_budget`
is red on one deterministic case in every run. The case is `extension/tests/pipeline-runner.test.js:737` "B-LANES lane
discovery › AC-1: the repo root yields exactly the pinned 10-lane roster".

## Mechanism (measured 2026-09-27)
The test runs `discoverSubsystems(<live repo root>)` and asserts an exact 10-lane set. Since that set was pinned, `main`
gained 6 script files under `prds/` (`prds/research/e3/*.py`, `prds/research/e3b/*.py`,
`prds/research/tools/field-timing.py`). That crosses the ≥ 3-source floor, so `prds` becomes an 11th lane. Measured
now: `bin extension/. extension/src/. extension/src/bin extension/src/services extension/tests/__fixtures__
extension/tests/. extension/tests/citadel extension/tests/integration extension/tests/services prds`. The lane rule is
correct. **The test is brittle: it pins a moving tree to a fixed answer**, and any future file added anywhere in the
repo can red it.

## Fix
Run AC-1 against a **pinned snapshot**: `git archive <pinned sha>` (the sha the roster was measured at, `57beb52c`, or
the closest commit that reproduces the 10-lane set; measure it) into a temp dir, and call `discoverSubsystems` on that
snapshot. Keep the exact 10-name assertion. Do NOT loosen it to "≥ N lanes" and do not special-case `prds`. If the
snapshot needs untracked build output that `git archive` omits (e.g. compiled mirrors), reproduce what the test needs,
or derive generated files from the archived tsconfig exactly as the live code does. Clean up the temp dir.

## Acceptance criteria (measured at `a0785b25`: red)
1. `cd extension && node --test --test-name-pattern="pinned 10-lane roster" tests/pipeline-runner.test.js` passes (HEAD: red,
   actual 11 lanes including `prds`).
2. Control: adding a 3-file source directory to the LIVE repo does not change the test result, while changing the
   pinned snapshot's tree does.
3. The whole `tests/pipeline-runner.test.js` file passes; `./node_modules/.bin/tsc --noEmit` and eslint exit 0.

## Out of scope
Changing the lane rule; excluding `prds` from discovery (the scripts are real code).

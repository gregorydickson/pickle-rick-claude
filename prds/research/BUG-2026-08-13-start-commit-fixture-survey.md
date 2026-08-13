# Survey: every `start_commit` fixture, reachability under the empty-branch-diff skip

## Scope and rule applied

Candidate set (pinned): `grep -rln "start_commit" extension/tests/*.test.js` at HEAD (`14d0f54e`) returns **45** files. All 45 are accounted for below.

Classification rule: the production predicate is `shouldSkipPhaseForEmptyBranchDiff`
(`extension/src/bin/pipeline-runner.ts:2052`), which skips a phase — `anatomy-park` or
`szechuan-sauce` **only** — when BOTH conjuncts hold:

1. `effectiveAllowedPaths` is empty/undefined (an **unscoped** run), AND
2. `isBranchDiffEmpty(repoRoot, readStartCommitFromState(sessionDir))` returns `true`
   — i.e. `getDiffFiles(startCommit, 'HEAD', repoRoot).length === 0` AND the working
   tree is clean (`listWorkingTreeDirtyPaths().length === 0`).

`isBranchDiffEmpty` returns `null` (not empty — never skips) whenever `startCommit` is
absent/unreachable or the diff/dirty-scan throws, so a fixture that never sets
`state.start_commit` cannot trigger this skip regardless of anything else it does.

**A passing test is not proof of reachability.** A fixture can assert on a code path
that is `pickle`/`citadel`-only (the skip never applies there), on a synthetic
`PipelineRuntime` object fed straight into a pure function
(`isFatalPhaseFailure`/`shouldHaltAfterPhase`/`executeCitadelPhase`) that never calls
`setupAnatomyPark`/`setupSzechuanSauce`, or on a session that never sets
`start_commit` at all — and in every one of those shapes the fixture is green whether
or not the code under test ever reaches the empty-branch-diff predicate. Reachability
therefore has to be established per-fixture by tracing what function is actually
invoked and what git state it runs against, not by reading the assertion list.

## Method

1. Enumerated the 45-file candidate set by the pinned grep.
2. Narrowed to files that can possibly reach the predicate: only fixtures that (a)
   import `pipeline-runner.js` AND (b) either call `setupAnatomyPark(`/
   `setupSzechuanSauce(`/`main(` directly, or configure a `phases` array containing
   `anatomy-park`/`szechuan-sauce` that a driven `main()` run will walk into.
3. For each surviving candidate, read the fixture's git-repo setup to determine
   whether `start_commit` is set, and if so whether HEAD has any commit past it (or
   whether the fixture's own helper explicitly makes a follow-up commit) at the point
   the phase in question executes.
4. Classified each of the 45 as **reached** (drives `setupAnatomyPark`/
   `setupSzechuanSauce`/`main()` with a genuine non-empty diff or with a scoped
   `allowed_paths`, so the phase actually runs), **not-applicable** (never reaches
   `shouldSkipPhaseForEmptyBranchDiff` at all — different phase, different predicate,
   or `start_commit` never set), or **unreached** (the skip fires and silences the
   very code path the fixture means to exercise).

## Results — all 45 accounted for

| # | File | Drives anatomy-park/szechuan-sauce? | start_commit set? | Diff empty at phase entry? | Classification | Action |
|---|---|---|---|---|---|---|
| 1 | activity-event-payload.test.js | No — schema-conformance fixtures only, no git repo | n/a | n/a | not-applicable | none |
| 2 | audit-ticket-bundle-naming.test.js | No — `audit-ticket-bundle.js`, unrelated binary | `null` literal in a scope.json fixture | n/a | not-applicable | none |
| 3 | audit-ticket-bundle-noise.test.js | No — same as above | `null` literal | n/a | not-applicable | none |
| 4 | audit-ticket-bundle-severity-threshold.test.js | No — same as above | `null` literal | n/a | not-applicable | none |
| 5 | b-pxbo-ws3b-ws1-crash-resume.test.js | No — never imports `pipeline-runner.js` | yes (state fixture) | n/a | not-applicable | none |
| 6 | citadel-pipeline-regression-smoke.test.js | Yes — `main()`, 4-phase config | yes, `fixture.base` | No — `createReplayRepo` commits `headFiles` after capturing `base`, both fixtures used (`loa-618-diff-fixture.json`, `noise-floor-diff-fixture.json`) carry non-empty `headFiles` | **reached** | none |
| 7 | dsan2-regression-corpus.test.js | No — pipeline is `['pickle','citadel']` only | yes | n/a (skip only applies to anatomy-park/szechuan-sauce) | not-applicable | none |
| 8 | failed-terminal-all-count-sites.test.js | No — tests the declared-file completion-evidence window, a different `start_commit` consumer | yes (different feature) | n/a | not-applicable | none |
| 9 | guard-completion-commit-baseline-rejection.test.js | No — never imports `pipeline-runner.js`; tests R-CXOR-2 baseline rejection | yes (different feature) | n/a | not-applicable | none |
| 10 | guard-completion-commit-tsc-gate.test.js | No — same as above | yes | n/a | not-applicable | none |
| 11 | microverse-worker-mode-startcommit-wiring.test.js | No — tests `handleWorkerMode`'s `startCommit` forward to the R-ORSR-6 interface-sweep guard, not the phase-skip predicate | yes (different feature) | n/a | not-applicable | none |
| 12 | no-premature-drain.test.js | No — never imports `pipeline-runner.js`; tests R-CXOR-2 / drain logic | yes (different feature) | n/a | not-applicable | none |
| 13 | nostop-gates-arm-agreement.test.js | No — never imports `pipeline-runner.js` | yes (different feature) | n/a | not-applicable | none |
| 14 | nostop-gates-invariant.test.js | No — synthetic `PipelineRuntime` fed directly into `isFatalPhaseFailure`/`shouldHaltAfterPhase`/`classifyMicroverseHaltDecision`; `config.phases` is inert metadata, `setupAnatomyPark`/`setupSzechuanSauce`/`main()` never called | yes, but unused by the functions under test | n/a | not-applicable | none |
| 15 | nostop-gates-phase-loop.test.js | No — `main()` driven, but every row's pipeline is `['pickle','citadel']` (default `writePipeline`) | yes | n/a | not-applicable | none |
| 16 | nostop-gates-sibling-parity.test.js | No — same synthetic-runtime shape as #14 | yes, unused | n/a | not-applicable | none |
| 17 | one-readevidence-oracle.test.js | No — never imports `pipeline-runner.js`; tests the completion-evidence oracle (R-CXOR-2/R-CCQF) | yes (different feature) | n/a | not-applicable | none |
| 18 | oneabort-termination-invariant.test.js | Yes for its one `main()`-driving test (`AC-OA-1c`); every other test calls `runAllBackendsExhaustedFinalizeGate`/`logPhaseHaltReason` directly (no phase-skip involvement) | yes, only on the `AC-OA-1c` test | No — that test uses `makeRepo({ createFollowupCommit: true })` (fixed by `c5b81af7`) | **reached** | none — already fixed |
| 19 | oneabort-termination-matrix.test.js | No — calls `runJudgeTimeoutFinalizeGate`/`runAllBackendsExhaustedFinalizeGate` directly on a synthetic `PipelineRuntime`; those finalize-gate runners never call `setupAnatomyPark`/`setupSzechuanSauce`, so `shouldSkipPhaseForEmptyBranchDiff` is never on the call path regardless of `start_commit`/diff state | yes, but unused by the functions under test | n/a | not-applicable | none |
| 20 | pickle-recover-coverage.test.js | No — never imports `pipeline-runner.js` | n/a | n/a | not-applicable | none |
| 21 | pipeline-empty-diff-terminates.test.js | Yes — this IS the dedicated positive test for the skip itself (`start_commit: headSha`, no follow-up commit, by design) | yes, `= headSha` | Yes, intentionally | **reached** (by design — the assertion IS that the phase skips and the pipeline terminates cleanly) | none |
| 22 | pipeline-runner-citadel-advisory-surfacing.test.js | No — drives `executeCitadelPhase` only (citadel, not anatomy-park/szechuan-sauce) | yes, fake sha, no real repo | n/a | not-applicable | none |
| 23 | pipeline-runner-citadel-mechanical-idempotence.test.js | No — same shape as #22 | yes | n/a | not-applicable | none |
| 24 | pipeline-runner-citadel-mechanical-remediation.test.js | No — same shape as #22 | yes | n/a | not-applicable | none |
| 25 | pipeline-runner-citadel-mechanical-skip.test.js | No — same shape as #22 | yes | n/a | not-applicable | none |
| 26 | pipeline-runner-design-safe.test.js | Calls `setupAnatomyPark`/`setupSzechuanSauce` directly, but `makeSessionDir` never writes a `start_commit` field | no | n/a (predicate always `null`) | not-applicable | none |
| 27 | pipeline-runner-dispatch.test.js | Partially — see detail | see detail | see detail | **mixed; see below** | none needed (all reached or not-applicable) |
| 28 | pipeline-runner-done-without-commit-evidence-fatal.test.js | No — pipeline is `['pickle','citadel']` throughout | yes | n/a | not-applicable | none |
| 29 | pipeline-runner-done-without-commit-evidence-reason-report.test.js | No — `main()`-driving describe block uses `['pickle','citadel']`; the AC-MWMO-D2-11 describe block calls `logPhaseHaltReason` directly on a synthetic runtime | yes | n/a | not-applicable | none |
| 30 | pipeline-runner-halt-on-incomplete.test.js | No — every pipeline is `['pickle']` or `['pickle','citadel']` | yes | n/a | not-applicable | none |
| 31 | pipeline-runner-phase-fail-continue.test.js | Yes for its `main()`-driving tests | yes | No — all `main()`-driving fixtures route through `makeRuntime`/`makePipelineSession`, which pass `createFollowupCommit: true` (fixed by `c5b81af7`); the two tests with plain `makeRepo()` (`applyStrictPhasesOverride` cases) never call `main()` at all | **reached** | none — already fixed |
| 32 | pipeline-runner-phase-no-progress.test.js | No — every pipeline is `['pickle']` or `['pickle','citadel']` | yes | n/a | not-applicable | none |
| 33 | pipeline-runner-prnf9.test.js | No — calls `isFatalPhaseFailure`/`shouldHaltAfterPhase` directly, no phase dispatch | yes | n/a | not-applicable | none |
| 34 | pipeline-runner.test.js | No — the one `setupAnatomyPark` describe block (`AP-EXT-ITER5-01`) uses `makeAnatomySessionDir`, which never sets `start_commit`; every other `start_commit` usage in the file feeds the pickle-phase crash-floor predicate (`isFatalPhaseFailure`), a different code path | mixed (absent where it matters) | n/a | not-applicable | none |
| 35 | rrh-forward-ref-coverage.test.js | No — never imports `pipeline-runner.js` | n/a | n/a | not-applicable | none |
| 36 | rrh-pickle-incomplete.test.js | No — every pipeline is `['pickle']` or `['pickle','citadel']` | yes | n/a | not-applicable | none |
| 37 | rrh-prdpath-resume.test.js | No — drives `executeCitadelPhase` (citadel preflight) or the real `setup.js` CLI (which does not run anatomy-park/szechuan-sauce) | yes | n/a | not-applicable | none |
| 38 | runner-authored-trailer.test.js | No — never imports `pipeline-runner.js`; tests `mux-runner.ts` trailer stamping | n/a | n/a | not-applicable | none |
| 39 | setup.test.js | No — never imports `pipeline-runner.js`; tests `setup.ts` | n/a | n/a | not-applicable | none |
| 40 | start-commit-salvage-guards.test.js | No — never imports `pipeline-runner.js`; tests `mux-runner.ts` salvage guards keyed on `start_commit` | n/a | n/a | not-applicable | none |
| 41 | state-manager.test.js | No — never imports `pipeline-runner.js` | n/a | n/a | not-applicable | none |
| 42 | szechuan-scope.test.js | Yes — the dedicated `setupSzechuanSauce` empty-diff tests (`AC-B1`, positive; `AC-B2`, negative-control with a real follow-up commit on `feature`) | yes | AC-B1: yes, by design (asserts the skip); AC-B2: no, `git checkout -b feature` + a real commit before calling `setupSzechuanSauce` | **reached** — both are dedicated, correctly-shaped tests for this exact predicate | none |
| 43 | worker-gate-not-run-invariant.test.js | No — never imports `pipeline-runner.js` | n/a | n/a | not-applicable | none |
| 44 | worker-produced-everything-but-commit.test.js | No — never imports `pipeline-runner.js`; tests `mux-runner.ts` | n/a | n/a | not-applicable | none |
| 45 | wuwc-reproducer.test.js | No — the one `main()`-driving test's pipeline is `['pickle']` only, never reaches `anatomy-park`/`szechuan-sauce` | yes | n/a | not-applicable | none |

### Row 27 detail — `pipeline-runner-dispatch.test.js`

This file mixes several `makeSession(...)` calls; only three set `start_commit` (via
`updateState(sessionDir, { start_commit: fixture.startCommit })` after
`writeCitadelHighFixture`), and all three are **reached**:

- `main persists canonical phase transitions before phase execution` (phases:
  `['pickle','anatomy-park','szechuan-sauce']`)
- `main inserts citadel between pickle and anatomy and passes report context downstream`
- `main does NOT halt on High citadel findings when citadel_strict is enabled`

`writeCitadelHighFixture` captures `base` after the first commit, then makes a second
commit (`change implementation`) before returning `{ startCommit: base }` — so the
branch diff between `start_commit` and `HEAD` is non-empty by construction, and the
mocked `spawnRunner` never adds commits that would matter (the diff is already
non-empty at pipeline start). anatomy-park/szechuan-sauce dispatch is asserted by
`calls.length` and `assertRunnerScript(..., 'microverse-runner.js')`, which pass only
if the phase actually spawned — confirming the skip did not fire.

Every other `makeSession([...])` call in this file (`main dispatches anatomy-park
through microverse-runner after setup`, `main recovers newer dead-writer pipeline.json
tmp before dispatch`, `main dispatches szechuan-sauce through microverse-runner with
domain and focus setup`, `main preserves anatomy-park empty scope failure`) uses the
default `writeBaseState`, which never sets `start_commit` — the predicate is `null`
there and can never skip, so those rows are not-applicable to this survey (they
exercise dispatch/scope logic that is orthogonal to the empty-branch-diff predicate).

## Unreached fixtures found and fixed

**None remaining.** The two known failures cited in the ticket
(`oneabort-termination-invariant.test.js`, `pipeline-runner-phase-fail-continue.test.js`)
were already fixed by `c5b81af7` (`fix(tests): restore reachability in oneabort and
phase-fail-continue fixtures`), using the `createFollowupCommit` idiom: `startCommit`
is captured before an explicit follow-up commit, so the branch diff at phase-execution
time is provably non-empty. This survey confirms every `main()`-driving call site in
both files that reaches `anatomy-park`/`szechuan-sauce` now goes through that idiom
(`oneabort-termination-invariant.test.js`'s sole `main()` test at `AC-OA-1c`;
`pipeline-runner-phase-fail-continue.test.js`'s `makeRuntime`/`makePipelineSession`
helpers, used by every `main()`-driving test in the file).

No other candidate in the 45-file set drives `setupAnatomyPark`/`setupSzechuanSauce`/
`main()` toward those two phases with an empty diff while expecting the phase to
actually run. The remaining candidates that DO drive those phases toward a real diff
(`citadel-pipeline-regression-smoke.test.js`, `pipeline-runner-dispatch.test.js`'s
three citadel-fixture tests, `szechuan-scope.test.js`'s `AC-B2`) were all found to make
an explicit follow-up commit (or ship non-empty fixture content) before the phase
runs, so they were never at risk.

## Why a passing test is not proof of reachability (worked examples from this survey)

- `pipeline-runner-design-safe.test.js` calls `setupAnatomyPark`/`setupSzechuanSauce`
  directly and asserts on their `design_safe` output — but its session fixture never
  sets `start_commit`, so the empty-branch-diff predicate is permanently `null`
  (never skips) regardless of what git state exists. The test's assertions are
  wrapped in `if (result === true)` guards, so even a future regression that made the
  phase start skipping for an unrelated reason would silently no-op the assertion
  rather than fail it — this file is correct-as-is today, but it is a second-order
  illustration of the same "green does not mean reached" class this ticket surveys.
- `nostop-gates-invariant.test.js` and `nostop-gates-sibling-parity.test.js` both
  build a `PipelineRuntime` object whose `config.phases` array names
  `anatomy-park`/`szechuan-sauce`, which reads at a glance like a phase-config
  fixture for those phases — but the object is fed directly into
  `isFatalPhaseFailure`/`shouldHaltAfterPhase`/`classifyMicroverseHaltDecision`,
  none of which ever call `setupAnatomyPark`/`setupSzechuanSauce`. `config.phases`
  is inert metadata to those functions. Grepping for the phase names alone would
  have miscounted these as reachable; tracing which function actually consumes
  `runtime`/`config` was required to rule them out.

## Fixes applied under `c5b81af7`'s rules

None required by this survey — the two previously-broken fixtures are already fixed,
and no further unreached fixture was found. No test file outside `extension/tests/`
and this report was modified.

# P3 — Pre-existing test flakes: council-publish hung-timeout + scope-resolver rg→grep recovery

**Priority**: P3 (advisory; doesn't block release per gate rule "ESLint errors block release; warnings are advisory" — but should be green for clean ship reports)
**Surfaced**: v1.69.0 release gate run (2026-05-03 PM)
**Predates**: v1.66.0 — both tests have stable failure history; not regressions from anything in v1.66.0..v1.69.0 (138 commits)

## Failures

### F1 — `tests/council-publish.test.js:867`

```
publishCouncilStack: hung `gh pr comment` is aborted by timeout, classified as failed
AssertionError: 2 !== 1 at council-publish.test.js:885
expected report.failed === 1, got 2
```

**Setup**: `gh` mock with two PRs (`feat/one` → #42, `feat/two` → #99) and `prComment: { hangOnCall: [1] }` so the first invocation hangs, second returns normally. Test expects: 1 failed (the hung call), 1 posted (the second), elapsed < 10s.

**Observed**: `report.failed === 2` — both invocations classified as failed instead of just the hung one.

**Diagnostic angle**: Either the timeout-classification path leaks across invocations, or the second `gh pr comment` is also failing (mock setup, environmental, or `ghTimeoutMs: 2000` cascading after the first hang). Prior fix attempt: `71e5c1e test: stabilize full-suite flakes — cap concurrency + bump council-publish gh timeout`. Doesn't seem to have stuck.

### F2 — `tests/scope-resolver-import-walks.test.js:111` (parent suite `computeOneHop import walks` also fails)

```
rg fails and grep recovers
AssertionError: false !== true
expected hasWarning(output.warnings, 'rg', 'fail') === true
```

**Setup**: `runInRepo({ rg: FAIL_SCRIPT(2), grep: SUCCESS_SCRIPT })` — rg returns exit 2, grep succeeds. Expects: result `['a.ts', 'b.ts']`, an `rg/fail` warning emitted, no `grep/fail` warning.

**Observed**: `rg/fail` warning is missing from `output.warnings`.

**Diagnostic angle**: Either the warning emitter dropped the rg-failure path, or warning categorization labels rg failures differently now. Prior fix attempts: `0390916`, `ac7c496` (timing budget bumps). The failure isn't a timing issue — it's a content-of-warnings issue, so the budget bumps didn't address the actual root cause.

**Resolved** (`e331fab7`): Root-cause diagnosis found the `console.warn` at `_runRgImportWalk` (scope-resolver.ts:728 / compiled JS:610) correctly emits `rg fail` on any non-0/non-1 rg exit code since commit `be2e675`. `hasWarning(warnings, 'rg', 'fail')` regex `\brg\b[^\n]*\bfail\b` matches the emitted string. Both test files run 10/10 green at HEAD. No production code change was required; the fix predated the PRD.

## Acceptance Criteria

- **AC-TF-1** F1 passes: hung call counted as 1 failed, second call as 1 posted; elapsed < 10s. Verify by running the test in isolation 10× consecutively — must be 10/10 green.
- **AC-TF-2** F2 passes: `rg/fail` warning emitted, result is `['a.ts', 'b.ts']`. Verify by running the parent `computeOneHop import walks` suite — must be 4/4 green.
- **AC-TF-3** Full release gate is clean: `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test` exits 0.
- **AC-TF-4** Diagnose root cause first (don't just bump timeouts again). Document the actual fix in commit message: what was misclassified / what warning was dropped, why prior timing-bump fixes missed it.

## Out of Scope

- Other tests that may flake under high concurrency. Scope this PRD to F1 + F2 only.
- Changing the production paths (`publishCouncilStack`, `computeOneHop`) more than the minimum needed to make the assertions hold — these tests are fixtures over real code, so prefer fixing the test setup or the warning/classification semantics rather than restructuring the production callers.

## Notes

Both failures are deterministic on this machine (Darwin 25.3.0, repo at `/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude/extension`) — they fail on every full `npm test` run. They predate the v1.66.0 GitHub tag, so they were already flaky-or-broken when v1.66.0 shipped. The release gate rule per `extension/CLAUDE.md` calls out ESLint errors as blocking and warnings as advisory; test failures aren't explicitly addressed, so they've been allowed to ship for several releases. This PRD raises the bar to "clean release gate" before the next tag.

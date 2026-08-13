# BUG-2026-08-13 — The empty-branch-diff skip makes two fixtures stop reaching the code they test

## Summary

`514bd4a7` added a correct production rule — a phase whose run authored no reviewable change skips instead of spinning — and two fast-tier tests went red as a result. Neither the rule nor the assertions are wrong. **Two test fixtures build a repo whose `start_commit` equals `HEAD`, so under the new rule their phase now skips and the path under test never executes.**

The tree is red at HEAD and this is the whole of it: 647 pass / 2 fail.

## Evidence

Bisected in an isolated worktree with an identical `--grep` on both sides:

| Tree | Result |
|---|---|
| `08a14a55~1` (before the skip) | **648 pass / 0 fail** |
| HEAD | **647 pass / 2 fail** |

Failing:

1. `extension/tests/oneabort-termination-invariant.test.js:418` — `every phase degraded ⇒ non-zero exit, failed status, and NO closer release plan` (suite `AC-OA-1c: a degraded phase never claims success`)
2. `extension/tests/pipeline-runner-phase-fail-continue.test.js` — `anatomy-park judge_timeout runs finalize-gate instead of halting pipeline`

### Root cause, read rather than inferred

`makeRepo()` in `extension/tests/oneabort-termination-invariant.test.js` seeds a repo, commits once, and returns that commit as the baseline:

```
git(['commit', '-q', '-m', 'seed'], repo);
return { repo, startCommit: git(['rev-parse', 'HEAD'], repo) };
```

So `start_commit..HEAD` is empty. `isBranchDiffEmpty` correctly reports that the run authored nothing, the phase skips, the degradation path never runs, and the pipeline exits 0 — so the assertion that a degraded phase never claims success never gets the chance to fire.

The fixture's own comment shows its author had already defended against the *previous* skip:

> discoverSubsystems enumerates directories holding source files; **seed one so the microverse phases find a real subsystem instead of skipping for empty scope.**

They anticipated `empty_scope`. `empty_branch_diff` is a second, different skip that did not exist when the fixture was written.

### The second file already contains the fix

`extension/tests/pipeline-runner-phase-fail-continue.test.js:40`:

```
function makeRepo({ createFollowupCommit = false } = {}) {
```

The parameter to author a commit after the baseline **already exists** — and `:190` proves the intent, a test named `shouldHaltAfterPhase pickle continue when commits exist after start_commit`. The failing case simply does not pass it.

That is strong evidence for the fix direction: authoring a follow-up commit is an established, deliberate fixture idiom in this repo, not an invention of this PRD.

## The distinction that governs this work

**The fixtures no longer reach the code they test. They are not asserting the wrong thing.**

Making a fixture reach its subject again is restoring reachability. Weakening or deleting an assertion because production changed is accommodating a bug — the failure mode that produced R-GTDT, and one this repository has an explicit rule about. This PRD does the first and forbids the second.

`AC-OA-1c` in particular must survive intact: it pins *"continuing is NOT claiming success"*, which is the honesty rule at the top of `CLAUDE.md`. A bundle that relaxed it to go green would be deleting the guard against exactly the fake-green this project is trying to eliminate.

## Non-goals

- **Not** disabling, weakening or gating the `empty_branch_diff` skip. The production rule is correct.
- **Not** re-simplifying the `start_commit`-only base resolution. That took three iterations and its history is recorded in the `514bd4a7` ticket's `TASK_NOTES.md` under an explicit *"do NOT re-simplify this back"*.
- **Not** weakening, deleting, or narrowing either failing assertion.
- **Not** a broad fixture sweep. Only fixtures the skip actually unreaches are in scope.

## Workstreams

### WS-A — Restore reachability in the two failing fixtures

Give each failing case a real review surface: a commit authored **after** `start_commit`, so the phase runs and the assertion executes as written.

- `extension/tests/pipeline-runner-phase-fail-continue.test.js` — pass the existing `createFollowupCommit: true` to the failing case. No new mechanism.
- `extension/tests/oneabort-termination-invariant.test.js` — `makeRepo()` has no such parameter; add one following the sibling file's idiom rather than inventing a different shape.

Record, per changed fixture, **why** the new setup is correct — so a future reader cannot mistake it for a test bent to match new behaviour.

**Acceptance criteria**

- `AC-A1` — Both named tests pass, and **neither assertion is modified**. Verify by diffing: the change touches fixture setup only; assertion lines are byte-identical.
- `AC-A2` — The full fast tier is green: `node bin/test-runner.js --tier fast --test-concurrency=4` reports 0 failures. `--grep` is NOT acceptable verification — it filters by test *name* and skips nearly every body, which is how this regression reached HEAD.
- `AC-A3` — Each changed fixture carries a comment naming the skip it now defends against, in the style of the existing `empty_scope` comment, so the next skip's author sees the precedent.
- `AC-A4` — The `empty_branch_diff` skip and its `start_commit`-only base are unchanged. Verify: `git diff` touches no non-test file.

### WS-B — Find any other fixture the skip unreaches

Two failures surfaced from a full-tier run. The same shape — a fixture whose `start_commit` equals `HEAD` driving a phase expected to execute — may exist elsewhere and be masked by tests that pass for unrelated reasons.

Enumerate fixtures that set `start_commit` and drive a phase, and report which have an empty baseline-to-HEAD diff. Fix only those that are actually unreached; report the rest.

**Acceptance criteria**

- `AC-B1` — A committed report enumerates every test fixture setting `start_commit`, with its baseline-to-HEAD diff status and whether it drives a phase.
- `AC-B2` — Any fixture found unreached is fixed under WS-A's rules, or the report states why it is correct as-is.
- `AC-B3` — The report explicitly states that a passing test is not proof of reachability — a fixture can pass while skipping the path it means to exercise, which is precisely how these two behaved before the skip existed.

## Interface Contracts

No production interface changes. This bundle touches test fixtures only.

**`makeRepo` (`extension/tests/oneabort-termination-invariant.test.js`)**
- Inputs: gains an optional flag to author a post-baseline commit, matching the sibling file's `createFollowupCommit` naming.
- Outputs: `{ repo, startCommit }` unchanged in shape.
- Errors: unchanged.
- Invariants: the default remains today's behaviour, so untouched callers are unaffected.

## Test Expectations

`node:test` has no `describe.each` / `test.each`; table-driven cases use `for (const c of CASES) test(...)`.

| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| AC-A1 | `extension/tests/oneabort-termination-invariant.test.js` | Degraded phase still never claims success | Phase RUNS, degrades, pipeline exits non-zero, no closer release plan — assertion text unchanged |
| AC-A1 | `extension/tests/pipeline-runner-phase-fail-continue.test.js` | judge_timeout still runs finalize-gate | Case passes `createFollowupCommit: true`; assertion text unchanged |
| AC-A2 | full fast tier | No regressions anywhere | `--tier fast --test-concurrency=4` reports 0 failures |
| AC-B1 | ticket artifact | Fixture survey | Every `start_commit`-setting fixture listed with diff status |

## Simplification Review

**What is removed rather than added?** Nothing is added to production. One fixture gains a flag that already exists in its sibling — the change makes two fixtures consistent with an established idiom rather than introducing a new one.

**Is any workstream a guard over a broken mechanism?** No. The mechanism is correct; the fixtures stopped reaching it.

**Could deletion solve it instead?** Deleting or weakening the assertions would turn the tier green immediately and is explicitly forbidden — `AC-OA-1c` pins the honesty rule this project exists to defend.

**Does this add an abort or halt condition?** No production code changes at all.

## Residuals

1. This regression reached HEAD because a ticket's conformance verdict was `ALL_PASS` against its own acceptance criteria while the full tier was red. That gap is a separate, larger finding — a per-ticket verdict is not a tree verdict — and is the subject of `prds/BUG-2026-08-12-success-verdict-blind-to-test-dimension.md`.
2. `514bd4a7` is marked Done with **no** `worker_gate_verdict` and no `worker_gate_tests_verdict`, stamped with a manager-authored preservation commit. Out of scope here; recorded because it is the same fake-green family.
3. The `--grep` trap is now twice-observed: it filters by test name, completes in seconds, and skips nearly every body. Worth a docs note so it is not mistaken for a fast proxy for the tier.

## Build constraints

- Build via `/pickle-tmux`. Test-fixture work only; runs unattended.
- Precondition: no other pipeline running on this host.
- The bundle is complete only when the FULL fast tier is green — not when the two named tests pass.

# PRD: God Function Remediation (Refined)

**Status**: Shipped (v1.59.x — T0-T19, 16 implementation + 4 hardening tickets)

*(refined: requirements, codebase, risk-scope analysts × 3 cycles)*

## Problem

A four-team audit of `extension/src/` identified **13 god functions** across 11 files —
functions exceeding 80 LOC, cyclomatic complexity > 10, or mixing 4+ unrelated
responsibilities. Four are severe (300+ LOC). They concentrate the riskiest control
flow in the system (orchestrators, hook handlers, subprocess spawners) and resist
unit testing because every responsibility must be set up before any single branch
can be exercised.

Concrete observed offenders *(refined: codebase analyst, line ranges corrected)*:

- Original `_emitDot` was refactored into a post-refactor coordinator at
  `dot-builder.ts:2318-2422`, with topology emitters split into helpers such as
  `_initializeEmitContext` (`1347-1435`), `_emitFanOutTopology` (`1608-1645`),
  `_emitCompetingTopology` (`1647-1664`), `_emitConvergenceTopology`
  (`1667-1845`), `_emitSequentialPhases` (`1848-2249`), `_emitMicroverseLoop`
  (`2251-2289`), and `_emitReviewRatchet` (`2291-2315`). The retained
  post-emission edge-rewiring passes are P25 catastrophic recovery at `2335-2339`
  and P0 isolated-workspace commit-and-push splice at `2344-2385`. *(refined:
  codebase analyst — prior PRD said "5 topologies"; correct count is 6 producers
  + 2 post-passes.)*
- Original `main` in `mux-runner.ts` was refactored into `runMuxRunnerMain`
  (`1508-2226`) plus exported loop helpers: `processRateLimitCycle`
  (`1183-1197`), `processIterationOutcome` (`1252-1260`), and
  `processCompletionBranch` (`1417-1454`). The loop still coordinates
  rate-limit state, circuit breaker, ticket lifecycle, and signal handling.
- Original `main` in `microverse-runner.ts` was refactored around
  `executeMainLoop` (`1433-1459`) and helper phases for rate-limit polling,
  metric measurement, regression rollback, and stall detection.
- Original `main` in `stop-hook.ts` was refactored into token detection at
  `detectCompletionTokens` (`102-116`) and decision routing at
  `classifyDecisionInternal` (`175-203`) plus `classifyTokenDecision`
  (`205-247`) for the **8 completion token types** enumerated below.

## Goals

1. No function in `extension/src/` exceeds **120 LOC** (statements, excluding blanks/
   comments), with **two carve-outs** *(refined: requirements + risk analysts —
   promoted from per-ticket to goal-level)*:
   - **Topology emitters in `dot-builder.ts`** may be up to **200 LOC** because ≥ 70%
     of the body is string-literal output via `emit({...})`. Cyclomatic complexity
     still ≤ 15.
   - **`executeMainLoop` in `microverse-runner.ts`** may be up to **200 LOC** because
     the iteration body is intrinsically sequential. Cyclomatic complexity still ≤ 15.
2. No function in `extension/src/` exceeds **cyclomatic complexity 15**.
3. Each extracted helper is independently testable — `node --test` covers the
   helper directly, not only via its parent. **All extracted helpers are exported**
   *(refined: risk analyst — drops the prior "module-private unless tested" clause;
   tests import from compiled JS, so testability requires export)*.
4. Behavior is preserved: full lint + test gate (`cd extension && npx tsc --noEmit
   && npx eslint src/ --max-warnings=-1 && npx tsc && npm test`) passes after each
   ticket, **plus** the three hygiene gates already in `package.json:13`
   (`tests/test-registration-hygiene.test.js`, `tests/test-quality-hygiene.test.js`,
   `tests/complexity-tier.test.js`) *(refined: codebase analyst)*.
5. **Behavior of the deployed runtime contract — hook decisions, state.json schema,
   CLI args — is byte-identical pre/post each refactor PR** *(refined: requirements
   + risk analysts — corrected wording; prior "do not change deployed files" was
   technically false because `bash install.sh` always rsyncs)*. Verified by
   transcript-replay fixtures captured in T0 and a deployed-hooks smoke test in T14.

## Non-Goals

- No new features. No new commands. **No `--dry-run` flag, no `DRY_RUN` env var**
  *(refined: requirements + risk + codebase analysts — prior T7 AC violated this)*.
- Not refactoring `state-manager.ts`, `metrics-utils.ts`, or any file the audit
  cleared.
- Not introducing dependency injection frameworks, class hierarchies, or plugin
  architectures.
- **Not generalizing trap-door spawn helpers across files** *(refined: risk
  analyst)*. T13's `_runRgImportWalk`/`_runGrepImportWalk` are PRIVATE to
  `scope-resolver.ts`. T12 does not introduce a shared osascript helper.
  Cross-file trap-door consolidation (`council-publish.ts:gh`,
  `plumbus-frame-analyzer.ts:bun`, `pickle-utils.ts:displayMacNotification`) is a
  separate epic.

## Approach

1. **One ticket = one PR. Atomic.** No batching.
2. **Full gate per PR**: `cd extension && npx tsc --noEmit && npx eslint src/
   --max-warnings=-1 && npx tsc && npm test`. Plus the three hygiene gates fire
   automatically as part of `npm test`.
3. **Same-file PR rebase rule**: T1, T10, T11 all touch `dot-builder.ts` (line
   current ranges 2318-2422, 1194-1224, 980-1045 — non-overlapping). Any merge order works
   provided each PR rebases onto its merged predecessor before review *(refined:
   requirements + codebase + risk analysts — prior "smallest-first" rule was wrong;
   non-overlapping ranges).
4. **Test placement**: unit tests in `extension/tests/<name>.test.js`; integration
   tests (subprocess spawn, real fs) in `extension/tests/integration/<name>.test.js`.
   Both must be appended to `extension/package.json:13`'s test allowlist *(refined:
   codebase analyst — `tests/test-registration-hygiene.test.js` enforces presence)*.
5. **`package.json:13` append protocol**: new test files appended at end of line in
   dependency order. Second-merging PR rebases by re-appending. T14 alphabetizes
   the entire allowlist as a one-shot epic-closer *(refined: risk analyst — prior
   "structurally rebase-incompatible" claim was overstated; tail-of-line appends
   are git-merge-friendly)*.
6. **Version cadence — single bump at epic close**: per-PR commits use
   `refactor(god-fn):` prefix WITHOUT version bumps. T14 bumps `1.54.2 → 1.55.0`
   (semver-MINOR justified: new internal test seam in T7 plus new exported helpers).
   Acknowledges contradiction with `pickle-rick-claude/CLAUDE.md` "refactor = patch"
   guidance — explicit one-line justification: 13 patches in one epic = release
   noise *(refined: requirements + risk analysts)*.
7. **Fixture lockdown protocol**: all fixtures committed in T0
   (`extension/tests/fixtures/{dot-builder,mux-runner,microverse,stop-hook,setup}/`)
   are LOCKED. Mid-epic fixture updates require a separate `fixture-update`-labeled
   PR citing the SHA of the runtime change. Refactor PRs T1–T13 MUST NOT modify
   fixtures inline *(refined: risk analyst)*.
8. **Helper-signature spec rule**: every extracted helper has its TypeScript
   signature declared in the ticket body BEFORE the PR opens. Helpers that report
   success/failure return discriminated unions (`{ kind: 'ok', value } | { kind:
   'fail', reason }`), NOT booleans. Helpers that mutate state declare the
   contract: either (a) take an injectable update callback, or (b) return new
   state. **Side-effects via passed-in mutable refs are FORBIDDEN** *(refined: risk
   analyst — recurring "collapse N blocks" trap)*.
9. **Trap-door preservation**: T12 and T13 abide by the silent-hang trap-door
   conventions in `extension/CLAUDE.md`. Every `spawnSync` into a foreign tool
   keeps its `timeout` literal. T12 must not introduce or modify `osascript` call
   sites; `displayMacNotification` (sibling at `pickle-utils.ts:1117+`) remains
   untouched *(refined: codebase + risk analysts)*.
10. **Rollback discipline**: each PR is independently revertible via `git revert
    <sha>`. If revert conflicts due to downstream dependency, revert in reverse
    merge order until conflict resolves. Fixture-update PRs revert independently;
    orphan fixtures get reverted with the refactor *(refined: risk analyst)*.
11. **Reviewer rotation**: single named reviewer for the epic, ≤ 24h SLA per PR.
    If multiple reviewers, name the merge sequencer who arbitrates rebase
    conflicts *(refined: requirements analyst)*.
12. Each refactor file's LOC may grow 5-15% post-refactor due to helper signature
    boilerplate and split documentation. Cohesion (each function has one
    responsibility) supersedes raw line count *(refined: risk analyst — ~50 helpers
    across 11 files)*.

## Acceptance Criteria (epic-level, machine-checkable)

After all tickets land:

- `cd extension && npx eslint src/ --max-warnings=0` passes — promoted from `warn`
  to `error` by T14 with the global rules `complexity: ['error', 15]` and
  `max-lines-per-function: ['error', { max: 120, skipBlankLines: true,
  skipComments: true }]`, plus T0-installed per-file `files:` overrides for
  `dot-builder.ts` and `microverse-runner.ts` (200 LOC each, complexity still 15)
  *(refined: requirements + risk analysts — replaces the broken `find...awk
  END{}` AC; flat-config `eslint.config.js`, NOT `.eslintrc`)*.
- `cd extension && npm test` passes; test count ≥ baseline (T0
  `extension/REFACTOR_BASELINE.md`) + 56 new tests minimum (sum of per-ticket
  `min_new_tests`) *(refined: requirements analyst — concrete sum)*.
- `cd extension && bash scripts/smoke-deployed-hooks.sh` exits 0 — invokes
  deployed `stop-hook.js` against each of 8 token-fixture transcripts and
  asserts byte-identical decisions vs. T0 baseline *(refined: risk analyst — Goal
  #5 integration verification)*.
- `git log --oneline | grep -c 'refactor(god-fn)'` ≥ 15 (T0–T14).

## Risks

| Risk | Mitigation |
|---|---|
| Behavior drift in mux-runner's rate-limit loop | State-transition fixture replay against `processRateLimitCycle`; `tests/mux-runner.test.js` (83.6KB) and `tests/mux-runner-pending-guard.test.js` continue to pass |
| stop-hook returns wrong decision after split | Decision fixture replay covering all 8 token types; CI fails if any decision branch lacks a fixture |
| dot-builder topology emission produces different DOT output | Golden-file fixtures for 6 topology helpers; byte-equal assertions in T1 PR |
| Iteration ordering changes in microverse main loop | Mutation-trace fixture across full convergence cycle replayed pre/post in T3 |
| T1 silent regression of post-emission edge mutation invariants (P25 + P0 isolated-workspace) | Post-pass MUST remain inline in `_emitDot` after all topology emitters; golden fixture suite includes `workspace: 'isolated'` + convergence case |
| T13 silently regresses `findImporters` rg/grep timeout (FIFO/FUSE/backtracking trap door) | `_runRgImportWalk`/`_runGrepImportWalk` thread `timeoutMs`; `tests/scope-one-hop-hang-guard.test.js` continues to pass; per-helper hang-path tests use existing `__hang__` shim pattern |
| T12 silently regresses `ensureMonitorWindow` per-call timeouts (5 spawnSync paths) | Each extracted helper preserves original timeout literals; `tests/ensure-monitor-window.test.js` extended with timeout-propagation assertions |
| T12 inadvertently touches `displayMacNotification` (4th trap door, same file) | Diff-scope assertion in PR review: every hunk start ≥ 749 AND end ≤ 848; `tests/notification-hang-guard.test.js` continues to pass |
| ESLint LOC carve-outs (200 LOC for T1 topology, T3 executeMainLoop) require flat-config `files:` overrides that no ticket adds | T0 adds two `files:` override blocks at `warn`; T14 promotes to `error` |
| `package.json:13` test-allowlist tail-of-line append collisions across 13 PRs | Append-at-end protocol; T14 alphabetizes once at epic close; `test-registration-hygiene.test.js` enforces presence per-PR |
| Cyclomatic-15 ceiling unverified-feasible for proposed splits | T0 runs speculative-split feasibility proof; documents at `extension/REFACTOR_FEASIBILITY.md`; T1/T2 redesign before opening PR if any helper would exceed 15 |
| Mid-epic fixture updates orphan rollback semantics | Fixture lockdown protocol (Approach §7); fixture-update PRs are separate and labeled |
| Helper extraction "collapse N blocks" tickets fork on signature decisions (T2, T7, T9) | Helper-signature spec rule (Approach §8); every helper signature pre-declared in ticket body |
| 13 sequential GitHub releases create user update fatigue + ~50min CI on release gate alone | Approach §6: T14 single bump 1.54.2 → 1.55.0; per-PR commits use `refactor(god-fn):` without version bump |
| T13 helpers temptation to generalize across other 3 trap-door files | T13 explicit scope freeze: helpers are PRIVATE to `scope-resolver.ts`; cross-file trap-door work is a separate epic |
| T4 depends on Anthropic `claude -p` CLI signal-handling semantics | Pin tested CLI version in `tests/fixtures/spawn-morty/cli-version.txt`; CI advisory if local CLI differs |
| Manual smoke test in T12 cannot gate CI | Replace with automated test using stub `tmux` shim (same pattern as `scope-one-hop-hang-guard.test.js`) |

## Token Enumeration (T5)

*(refined: codebase + requirements analysts — verified at `stop-hook.ts:102-116`)*

| # | Token | Source | Roles | Effect |
|---|---|---|---|---|
| 1 | `state.completion_promise` (variable, configured per-session) | line 171 | all | full exit |
| 2 | `EPIC_COMPLETED` | 174 | all | full exit + activity event |
| 3 | `TASK_COMPLETED` | 175 | all | full exit + activity event |
| 4 | `ANALYSIS_DONE` | 177 | refinement-worker only | full exit |
| 5 | `EXISTENCE_IS_PAIN` \|\| `THE_CITADEL_APPROVES` | 178 | all | full exit (review_clean), gated by `min_iterations` |
| 6 | `WORKER_DONE` | 179 | worker only | full exit |
| 7 | `PRD_COMPLETE` | 182 | non-worker | block (inline) / approve (tmux) — checkpoint |
| 8 | `TICKET_SELECTED` | 183 | non-worker | block (inline) / approve (tmux) — checkpoint |

T5 requires **9 tests minimum**: 8 token-presence tests + 1 alias-equivalence test
asserting `EXISTENCE_IS_PAIN` and `THE_CITADEL_APPROVES` produce byte-identical
decisions on the same transcript fixture. The OR-alias is a token-format
silent-failure class (rename either side and the default branch silently swallows
it).

## T1 Post-Pass Invariants (Non-Extracted)

*(refined: codebase + requirements analysts)*

These remain in the post-refactor `_emitDot` coordinator AFTER all topology
emitters run:

- **P25 catastrophic-recovery `_linkEdge`** at `dot-builder.ts:2335-2339`: gated on
  `!this._hasFanOut && !this._hasCompeting && this._implPhases.length > 0 && !this._hasConvergence`.
- **P0 isolated-workspace edge-splice** at `dot-builder.ts:2344-2385`: surgical
  `edges.findIndex` + `edges.splice` + `seenEdges.delete` + `edgeList.splice` to
  remove `repro_verify -> done` (convergence branch 2356-2369) or `quality_review
  -> exit` (non-convergence branch 2370-2381), then re-thread through
  `commit_and_push`.

Required regression tests (in addition to 6 helper tests):
- Build a spec with `workspace: 'isolated'` + convergence; assert final `edgeList`
  contains `repro_verify -> commit_and_push` AND `commit_and_push -> done` AND
  does NOT contain `repro_verify -> done`.
- Build a spec satisfying `!isFanOut && !hasCompeting && implPhases.length > 0 &&
  !hasConvergence`; assert `regression_check -> setup_deps` with
  `loop_restart='true'` is present.

## Closure-Threading Strategy (T1, binding)

*(refined: codebase analyst — picks default to avoid implementer flame war)*

**Strategy A (default)**: Promote 4 closures (`emit`, `link`, `linkEdge`,
`emitSubgraph`) to private methods on `DotBuilder`; current helpers are `_emit`,
`_link`, `_linkEdge`, and `_emitSubgraph` at `dot-builder.ts:1437-1478`.
Promote 8 mutable buffers + `nodeMap` to instance fields cleared at the start of
each `_emitDot()` invocation. The `_built` guard at `1194-1197` prevents
re-entry, so transient mutation is safe.

**Strategy B (alternative, requires PR-description justification)**: Thread a
17-field `EmitContext` interface through every helper.

T1 implementer picks Strategy A unless the reviewer accepts a documented reason
for B in the PR description.

## Fixture Taxonomy

*(refined: risk analyst)*

- `golden-file fixture` (`tests/fixtures/dot-builder/golden-*.dot`): byte-equal
  output of `_emitDot` for a representative spec, captured by running pre-refactor
  binary, asserted via `assert.strictEqual(actual, expected)`.
- `state-transition fixture`
  (`tests/fixtures/mux-runner/rate-limit-cycle-2026-04.json`): ordered list of
  `{state-in, state-out}` pairs across the rate-limit cycle, captured by
  instrumented run of `tests/integration/mux-loop.test.js`, replayed with
  `processRateLimitCycle` + assertion of identical sequence.
- `mutation-trace fixture` (`tests/fixtures/microverse/convergence-mutations.json`):
  ordered list of `state.json` writes across a convergence cycle, captured
  similarly, replayed with `executeMainLoop`.
- `decision fixture` (`tests/fixtures/stop-hook/token-{1..8}.json`): pairs of
  `{transcript, expected-decision}` for each of the 8 token types. Plus
  `token-alias-equivalence.json` asserting `EXISTENCE_IS_PAIN` and
  `THE_CITADEL_APPROVES` produce byte-identical decisions.

## Implementation Task Breakdown

| Order | ID | Title | Priority | Tier | Files | min_new_tests | Trap Door |
|---|---|---|---|---|---|---|---|
| 10 | 6f3e3f01 | T0 — Pre-refactor scaffolding (fixtures, ESLint carve-outs, feasibility, baseline) | High | medium | `eslint.config.js`, `package.json`, `tests/fixtures/**`, `scripts/smoke-deployed-hooks.sh`, `REFACTOR_*.md` | 0 | — |
| 20 | f068af3f | T1 — Split _emitDot in dot-builder.ts (6 topology helpers, 2 post-passes inline) | High | large | `src/services/dot-builder.ts`, `tests/dot-builder-emit-helpers.test.js` | 8 | — |
| 30 | 53caa9a4 | T2 — Split main() in mux-runner.ts (outer loop only) | High | large | `src/bin/mux-runner.ts`, `tests/process-iteration-outcome.test.js` | 4 | — |
| 40 | 2b4b0501 | T3 — Split main() in microverse-runner.ts (200 LOC carve-out for executeMainLoop) | High | large | `src/bin/microverse-runner.ts`, `tests/microverse-helpers.test.js` | 3 | — |
| 50 | 626cd1d5 | T4 — Split main() in spawn-morty.ts (finalize stays nested closure) | High | large | `src/bin/spawn-morty.ts`, `tests/spawn-morty-helpers.test.js` | 4 | — |
| 60 | 5059df9a | T5 — Split main() in stop-hook.ts (8 token detectors + alias-equivalence) | High | large | `src/hooks/handlers/stop-hook.ts`, `tests/stop-hook-helpers.test.js` | 9 | — |
| 70 | 16efc5dc | T6 — Split main() in spawn-refinement-team.ts (manifest atomicity) | Medium | medium | `src/bin/spawn-refinement-team.ts`, `tests/refinement-manifest-atomic.test.js` | 1 | — |
| 80 | 7aa55af1 | T7 — Split main() in pipeline-runner.ts (PhaseConfig dispatch, NO --dry-run) | High | medium | `src/bin/pipeline-runner.ts`, `tests/pipeline-runner-dispatch.test.js` | 1 | — |
| 90 | f5ac5de1 | T8 — Split main() in setup.ts (parseArguments, resume, init, summary) | Medium | medium | `src/bin/setup.ts`, `tests/setup.test.js` (NEW) | 3 | — |
| 100 | a6c9c59b | T9 — Split main() in jar-runner.ts (current task loop helpers around 393-439, tier promoted) | Medium | medium | `src/bin/jar-runner.ts`, `tests/jar-runner-helpers.test.js` | 5 | — |
| 110 | e54eebf6 | T10 — Split build() in dot-builder.ts (preflight, convergence, structural rules) | Medium | small | `src/services/dot-builder.ts`, `tests/dot-builder-build-helpers.test.js` | 3 | — |
| 120 | e2e6e1cc | T11 — Split fromSpec() in dot-builder.ts (parsePhases, parseConvergenceSpec) | Low | small | `src/services/dot-builder.ts`, `tests/dot-builder-fromspec-helpers.test.js` | 2 | — |
| 130 | 189df244 | T12 — Split ensureMonitorWindow() in pickle-utils.ts | Medium | small | `src/services/pickle-utils.ts:927-1088`, `tests/ensure-monitor-window-stub.test.js` | 2 | **YES** (displayMacNotification sibling) |
| 140 | bdfb528b | T13 — Split findImporters() in scope-resolver.ts (helpers PRIVATE) | Low | small | `src/services/scope-resolver.ts`, `tests/scope-resolver-import-walks.test.js` | 4 | **YES** (FIFO/FUSE rg/grep hang) |
| 150 | 5fa8759a | T14 — Epic closer: ESLint to error, alphabetize, 1.55.0 bump, smoke | High | trivial | `eslint.config.js`, `package.json`, GitHub release | 0 | — |
| 160 | e5e73494 | T15 — Wire: integrate all extracted helpers (Library variant) | High | medium | All MODIFIED_FILES | 0 | — |
| 170 | 24cd1805 | Harden: code quality review of god-function refactor diff | High | large | All 14 MODIFIED_FILES | varies | — |
| 180 | 9dbd0bfd | Audit: data flow integrity for god-function refactor diff | High | large | All 14 MODIFIED_FILES | varies | — |
| 190 | d6e98b45 | Harden: test quality review of god-function refactor diff | High | large | All new test files | varies | — |
| 200 | 7be94584 | Audit: cross-reference consistency for god-function refactor | High | medium | DOC_FILES + impl files | 0 | — |

**Per-ticket minimum new tests sum**: 0+8+4+3+4+9+1+1+3+5+3+2+2+4+0 = **49** new unit tests minimum from T0–T14. Hardening tickets add additional regression tests as findings demand.

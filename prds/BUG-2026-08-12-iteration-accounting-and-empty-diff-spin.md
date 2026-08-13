# BUG-2026-08-12 — The iteration metric measures the design as failure, and an empty branch diff spins until killed

## Summary

Two defects in the same loop, both cheap, both subtractive, and the first one blocks measuring any other fix.

1. **`wasted_iter` marks the pipeline's own designed behaviour as waste.** The predicate is `action === 'revert' || postIterSha === preIterSha` — any iteration that does not move the SHA. That set includes the *designed* re-spawn-resume turn and a legitimately clean pass with nothing to fix. The resulting 92% "wasted" figure cannot distinguish working-as-intended from broken, so no reliability fix can be shown to help.
2. **A run whose branch diff is empty has no exit and spins until something kills it.** The empty-scope skip exists and is well-built, but by explicit design it does not cover the unscoped case — which is exactly what an empty diff produces.

Neither fix adds a mechanism. The first narrows a predicate; the second extends an existing one to a case it already almost covers.

## Evidence

### Defect 1 — the metric

`extension/src/bin/mux-runner.ts:2786`:

```
const wasted = input.action === 'revert' || input.postIterSha === input.preIterSha;
```

A no-SHA-movement iteration is recorded as `wasted: true`. Three different things land in that bucket:

**(a) The designed re-spawn-resume turn.** The manager prompt states the contract in its own words:

> if a worker's Bash call IS cut off at the ceiling before it signals `<promise>I AM DONE</promise>`, simply re-spawn the SAME `spawn-morty.js` command in the foreground on your next turn — the worker RESUMES from its on-disk artifacts
> The mux-runner relaunches you (R-MMTR) to give you the turns you need.

The ceiling is **not ours**: `600000` appears nowhere in `extension/src` — it is the agent harness's Bash cap. Meanwhile `pickle_settings.json:33` sets `default_worker_timeout_seconds: 2400`. Pickle-rick budgets workers 40 minutes and the host cuts a synchronous wait at 10, so the handoff is routine, expected, and explicitly designed for. The iteration banks no commit; the work continues and commits later.

**(b) Clean passes.** Transcript classification of 82 August manager turns: 40 ran no `git commit`, and **10 of those (25%) were correct passes with nothing to fix**. A phase that finds no defect and commits nothing has behaved perfectly.

**(c) Real defects** — the residue that actually matters, and the only part the metric should be counting.

Consequence: the headline reliability number for this project is unusable in both directions. It cannot show a regression distinctly from a busy re-spawn cycle, and it cannot show an improvement at all, because fixing a real defect moves a figure dominated by (a) and (b). **Every reliability decision made against this metric for the past two months was made against noise.**

### Defect 2 — the empty-diff spin

Session `2026-08-07-35088221` ran nine consecutive ~15-second iterations, each reaching the same conclusion. Iteration 22, verbatim:

```
same wall as 21 prior iterations.
- HEAD `9947b3afd` = tip of `main`; `git diff main...HEAD` empty, working tree clean.
- No branch-authored code exists to deslop. Every candidate violation would be a
  pre-existing issue on unmodified lines … so all drop before scoring.
```

The worker was correct every time and emitted `<promise>TASK_COMPLETED</promise>` every time. The real blocker was environmental (`GITHUB_PACKAGES_TOKEN` unset, no `node_modules`). The run never self-terminated; its `exit_reason` is `signal:SIGHUP` — it ended only because something outside killed it.

**Why the existing skip did not fire.** `extension/src/bin/pipeline-runner.ts:2001-2016`:

```
function shouldSkipSzechuanForEmptyScope(...): boolean {
  const paths = isCodeFreeScope(effectiveAllowedPaths) ? effectiveAllowedPaths : null;
  if (!paths) return false;
  ...
}
```

Its docstring is explicit: *"Returns false (no emission) for an unscoped run or a scope with at least one code file."* The invariant in `extension/src/bin/CLAUDE.md:85` states the same rule deliberately: *"An UNSCOPED szechuan run (empty `effectiveAllowedPaths`) MUST still run."*

So the skip covers **"scope has files, none of them are code"** and deliberately not **"there is no branch diff at all."** An empty `git diff main...HEAD` yields no scope, which is the unscoped path, which must still run. The phase runs, finds nothing, commits nothing, and the loop re-selects it forever.

That rule is correct for its original purpose — an unscoped run on a repo with real branch work should deslop the whole tree rather than silently skip. The uncovered case is narrower than "unscoped": it is *unscoped **because the branch diff is empty***, which is a different fact and is knowable before the phase starts.

## Non-goals

- **Not** removing the "unscoped runs must still run" rule. A genuinely unscoped run over a real branch diff must continue to run; only the empty-diff case changes.
- **Not** adding a watchdog, stall detector, or iteration cap. Thirteen no-progress mechanisms already exist; this adds none.
- **Not** halting anything. The empty-diff case ends a *phase* cleanly, as the existing skip already does for its own case.
- **Not** changing what `wasted_iter` is emitted for — only what counts as `wasted: true`, plus the fields needed to tell the classes apart.

## Workstreams

### WS-A — Make the iteration metric able to show improvement

Narrow `wasted` to iterations that are genuinely unproductive, and record the discriminator so the classes can be separated after the fact.

An iteration is **not** wasted when either holds:
- the turn ended with a live worker still running (the designed re-spawn-resume handoff), or
- the phase completed and reported nothing to do (a clean pass).

Both facts are already available at the emit site or one call away: the handoff is observable from the worker's liveness/backgrounding, and the clean pass from the phase's own disposition (`PhaseSetupResult` / `skipReason` already thread a per-phase disposition into `counters.phaseSkips`).

Emit an explicit `wasted_reason` (or equivalent) alongside `wasted`, so a future reader can recount without re-deriving from transcripts — the analysis that produced this PRD had to classify 82 manager transcripts by hand because the telemetry could not answer it.

**The two runners need different fixes. Do not share one mechanism.**

- **microverse** already names the handoff class. `extension/src/bin/microverse-runner.ts:4224` emits
  `emitMicroverseWastedIter(ctx, lastAction === 'revert' ? 'revert' : 'worker')` — `'worker'` is an existing
  label for exactly the designed-handoff iteration, marked wasted today *only* because the SHA did not move.
  The fix here is a one-token predicate change over a label that already exists. **A liveness probe is neither
  needed nor appropriate.**
- **mux** has no such label. `action` is `outcome.completion` ∈ `{task_completed, review_clean, continue, inactive, error}`,
  none of which names the handoff. The ticket must derive the class from the strongest available observable and
  **state in the ticket which observable it chose and why** — a liveness probe is permitted here but is not
  assumed, and a weaker proxy must be justified against the alternatives.

**Acceptance criteria**

- `AC-A1-mv` — In microverse, an iteration emitted with `action: 'worker'` is recorded `wasted: false`. No new probe, no new field; the predicate consumes the existing label.
- `AC-A1-mux` — In mux, an iteration that ended with the designed worker handoff is recorded `wasted: false`, and the ticket records which observable identifies it and why that one.
- `AC-A2` — An iteration whose phase completed with nothing to do is recorded `wasted: false`.
- `AC-A3` — An iteration that produced no commit for any other reason is recorded `wasted: true`.
- `AC-A4` — Every `wasted_iter` event carries a reason field. The reason vocabulary is a **closed** set defined in one place. Note `WastedIterAction` (`extension/src/bin/microverse-runner.ts:124`) is `'accept' | 'revert' | 'no_commit' | 'worker' | IterationExitType` — an **open** set, because `IterationExitType` is an independent union. The reason field must NOT inherit that openness: either close it, or map the open input onto a closed reason vocabulary and assert the mapping is total.
- `AC-A5` — **Exactly one `wasted_iter` event is emitted per iteration per runner.** Microverse has four emit sites (`:4224`, `:4377`, `:4385`, `:4562`); if any iteration can reach two of them, the "rate" in `AC-A6` moves without any classification changing. Assert the invariant directly; if it does not hold today, the ticket states so and fixes it before `AC-A6` is measurable.
- `AC-A6` — Machine-checkable recount, **unit stated**: over a committed fixture corpus, report per-class **counts** (`worker_handoff`, `clean_pass`, `revert`, `no_progress`) and the wasted **rate per iteration** (not per event — see `AC-A5`), under both the old and new predicates. The bundle passes when the new rate is below the old one AND the per-class counts sum to the iteration count. A predicate reproducing the old rate has fixed nothing. The corpus is August-only (Residual 4); label it as such in the artifact.
- `AC-A7` — **Tests pinning the old formula are updated with recorded reasoning, never silently rewritten.** `buildEfficiencySection` (`extension/src/bin/microverse-runner.ts:2885`) is asserted by `extension/tests/microverse-final-report.test.js`, including a case whose own comment states the contract being changed (*"wasted = 1 revert + 2 missing = 3"*). If the efficiency line adopts the shared classifier, that test changes — and the ticket must record, per changed assertion, why the new expectation is correct. Leaving the printed percentage on the old formula while `AC-A6` reports the new one is also forbidden: the operator would read two different numbers for one quantity.
- `AC-A8` — `npx tsc --noEmit` and `npx eslint src/ --max-warnings=-1` green.

### WS-B — An empty branch diff ends the phase instead of spinning

Extend the existing empty-scope skip to the case where the scope is empty *because the branch diff is empty*. This is one new condition inside a predicate that already exists, already emits an operator WARN, already emits an activity event, and already threads a `skipReason` into `pipeline-status.json:phase_skips`.

The distinction the predicate must make:
- `effectiveAllowedPaths` empty **and** the branch diff is empty → **skip the phase** (new).
- `effectiveAllowedPaths` empty **and** the branch diff is non-empty → **run unscoped** (unchanged — this is the rule in `extension/src/bin/CLAUDE.md:85` and it stays).

**Acceptance criteria**

- `AC-B1` — With an empty branch diff, the phase skips and emits the existing WARN + empty-scope activity event with a cause naming the empty diff.
- `AC-B2` — With an empty `effectiveAllowedPaths` but a **non-empty** branch diff, the phase still runs unscoped. A test asserts this directly — it is the invariant WS-B must not break.
- `AC-B3` — A run whose every phase skips for an empty diff reaches its own terminal state rather than requiring an external signal. Asserted by driving the loop, not by inspecting a flag.
- `AC-B4` — The skip records a skip reason reaching `phase_skips` in the pipeline status artifact, and **that reason distinguishes an empty-diff run from a doc-only / code-free run.**

  **This requires a new reason value, and the choice is not neutral — silence ships the weaker option.** `PhaseSkipReason` (`extension/src/bin/pipeline-runner.ts:130`) is `'empty_scope' | 'no_subsystems' | 'setup_error'`, and its docstring at `:127-129` already claims this case:

  > `empty_scope` = the scope filter **/ branch diff** left no review surface

  So a worker satisfies this criterion literally by reusing `empty_scope` and adding nothing — the cheapest implementation, and the source comment currently *documents it as correct*. That passes the letter and fails the purpose.

  The ticket MUST add a distinct value (e.g. `empty_branch_diff`) **and co-scope the docstring edit at `extension/src/bin/pipeline-runner.ts:127-129` plus `extension/src/types/CLAUDE.md:22`** — otherwise the tree ships two contradictory definitions of `empty_scope`. Both files go in the same ticket allowlist as the predicate; a per-file scope fence that omits either makes the ticket unsatisfiable.
- `AC-B5` — `extension/tests/szechuan-scope.test.js` and `extension/tests/anatomy-park-scope.test.js` stay green; the R-PSSS invariant tests are not rewritten to accommodate this change.

## Interface Contracts

**`wasted_iter` event** (existing, extended)
- Inputs: unchanged emit sites (`extension/src/bin/mux-runner.ts:2786`, `extension/src/bin/microverse-runner.ts:3368`).
- Outputs: adds a reason field; `wasted` becomes false for the handoff and clean-pass classes.
- Errors: an indeterminate class records `wasted: true` with reason `no_progress` — the conservative direction, since under-counting waste would hide real defects.
- Invariants: `wasted: true` implies the iteration produced no commit; the converse no longer holds.

**`shouldSkipSzechuanForEmptyScope`** (existing, extended)
- Inputs: adds the branch-diff emptiness fact.
- Outputs: `true` (skip) for empty-scope-because-empty-diff; unchanged otherwise.
- Errors: if branch-diff emptiness cannot be determined, return `false` — run the phase. Failing toward running preserves today's behaviour and cannot introduce a silent skip.
- Invariants: an unscoped run with a real branch diff still runs. That is `AC-B2`.

## Test Expectations

`node:test` has no `describe.each`/`test.each`; use `for (const c of CASES) test(...)`.

| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| AC-A1 | `extension/tests/wasted-iter-classification.test.js` | Live-worker handoff is not waste | Iteration with a live worker records `wasted: false`, reason `worker_handoff` |
| AC-A2 | `extension/tests/wasted-iter-classification.test.js` | Clean pass is not waste | Phase with nothing to do records `wasted: false`, reason `clean_pass` |
| AC-A3 | `extension/tests/wasted-iter-classification.test.js` | Genuine no-progress is waste | No commit, no handoff, no clean pass → `wasted: true`, reason `no_progress` |
| AC-A4 | `extension/tests/wasted-iter-classification.test.js` | Reason is always present | Every emitted event carries one of the four reasons |
| AC-B1 | `extension/tests/szechuan-scope.test.js` | Empty diff skips the phase | WARN + activity event emitted, cause names the empty diff |
| AC-B2 | `extension/tests/szechuan-scope.test.js` | Unscoped with real diff still runs | Phase runs; no skip event emitted |
| AC-B3 | `extension/tests/pipeline-empty-diff-terminates.test.js` | Run self-terminates | Loop reaches its own terminal state with no external signal |

## Simplification Review

**What is removed rather than added?** WS-A removes two false classifications from a predicate. WS-B removes an infinite re-selection path. Neither adds a mechanism, a field beyond one reason string, or a gate.

**Is any workstream a guard over a broken mechanism?** No. WS-B extends a predicate that already works for its own case; WS-A narrows an existing computation.

**Could deletion solve it instead?** For WS-A, considered deleting `wasted_iter` entirely — rejected, because the project then has no iteration-productivity signal at all, and the corpus reconstruction that produced this PRD depended on it. The subtraction adopted is deleting the false positives, not the metric.

**Does this add an abort or halt condition?** No. WS-B ends a *phase* through the existing skip path — the same disposition `anatomy_park_empty_scope_skip` already uses — and lets the run finalize normally. `AC-B3` asserts the run terminates on its own rather than being stopped.

## Residuals

1. The `2400s` worker budget versus the harness's `600s` synchronous ceiling is a standing mismatch. It is *handled* (re-spawn-resume) and is not a defect, but it means iteration counts overstate work-units by a factor that varies with worker length. Worth stating in operator docs so the next reader does not rediscover it as a bug — as this session did.
2. `microverse-runner.ts:3368` emits `wasted_iter` with the same predicate. WS-A must cover it or the metric stays half-fixed; if the classes differ for microverse, say how rather than sharing the predicate blindly.
3. The empty-diff spin was *triggered* by an environmental blocker (`GITHUB_PACKAGES_TOKEN` unset, no `node_modules`). WS-B stops the spin but does not surface the blocker. A run that can do nothing because its environment is unprovisioned should say so; that is a separate, larger question about readiness reporting.
4. June/July telemetry is gone — no `state.json`, no `tmux_iteration_*.log`. `AC-A5`'s recount can only use the surviving August corpus (n=82 turns), so the "materially below 92%" comparison is August-only and should be labelled as such.

## Build constraints

- Build via `/pickle-tmux`. This touches the iteration loop and phase setup, not the salvage or completion-evidence path, so it runs unattended.
- WS-A and WS-B are independent; either may land first.
- Sequenced ahead of `prds/BUG-2026-08-12-success-verdict-blind-to-test-dimension.md` — until WS-A lands, no reliability change can be shown to have helped.

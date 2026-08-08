# B-CRASHFLOOR — the pickle branch never reads `exit_reason`, and the amnesiac breaker zeroes its own bound

**Priority:** P1 (reliability — a crash-floor verdict is unreachable, and an unbounded loop burns budget)
**Source bug report:** `prds/BUG-REPORT-2026-08-07-toolchain-unavailable-not-treated-as-halt-stall-detection-blind-to-identical-verdicts.md`
**Field incident:** `/pickle-pipeline` session `2026-08-07-35088221`, $13.21 across ~11 judge cycles
**build_mode:** unattended — this bundle edits phase-exit classification and the microverse no-commit
classifier. Neither is the salvage / completion-evidence / Done-flip path, so R-PSRB does not apply
(`prds/CLAUDE.md` → "Self-modifying-recovery bundles" names phase-exit edits as pipeline-safe).

## Problem

Two independent defects, both verified against source and session artifacts. Neither is the defect the
original bug report inferred; both corrections make the fix strictly smaller.

### V1 — the pickle branch of `isFatalPhaseFailure` never reads `exit_reason`

`extension/src/bin/mux-runner.ts` detects a missing target toolchain, stamps
`exit_reason = 'toolchain_unavailable'`, emits a `session_end` activity record, and deactivates — all
within 268 ms of phase 1 starting. That machinery is complete, deployed, and correct.

`extension/src/bin/pipeline-runner.ts` then discards the verdict:

- `shouldHaltAfterPhase(phase, exitCode, runtime)` is keyed on the exit **code**. It reads state (for
  `pipeline_continue_on_phase_fail`) but never consults `exit_reason`.
- `isFatalPhaseFailure(phase, runtime)` **does** consult `exit_reason` — but only on the
  `anatomy-park` / `szechuan-sauce` branch, against `isMicroverseFatalReason`. The `pickle` branch
  reads state and checks **only** `start_commit`.

So the reader exists, the writer exists, and they are on different branches. Exit code `1` falls
through to the R-PHC-6 continue-by-default path and the pipeline advances into citadel, anatomy-park
and szechuan-sauce against a repo with no toolchain.

This is a **stated-but-unwired policy**. The root `CLAUDE.md` halt set names *"toolchain unavailable"*
as a genuine crash floor; R-PHC-6 mandates continuing on non-fatal non-zero `pickle` exits. Neither
rule references the other and no code reconciles them, so the crash floor is unreachable through the
phase boundary no matter how well the detector works.

### V2 — a turn-count proxy outranks observable truth, and the breaker resets its own counter

`classifyNoCommitExit` in `extension/src/bin/microverse-runner.ts` evaluates a `num_turns < 5` test
**before** any content check. A worker that correctly concludes "blocked, no toolchain, cannot verify a
fix" reaches that conclusion in few turns — being right is fast — so a decisive correct verdict is
classified `amnesiac`. The amnesiac handler logs `not counting as stall` and returns without touching
`stall_counter`. Field confirmation: `stall_counter: 0` and `convergence.history: []` after 22
iterations.

The path is then unbounded **by construction**: at 2 strikes `resetGapAnalysisForAmnesiacBreaker`
returns `consecutive_amnesiac_exits: 0` and `status: 'gap_analysis'`, so the counter that bounds the
breaker is zeroed by the breaker, and each cycle pays a fresh LLM baseline measurement.
`consecutive_amnesiac_exits` can never exceed 2.

The authoritative facts — empty diff, `HEAD` unchanged, `HEAD == start_commit`, zero commits — were all
observable and all ignored in favour of a turn count.

## Simplification Review

### WS-1 (pickle-branch crash-floor read)

1. **Is the addition necessary at all?** No new mechanism. This adds **zero** new state fields,
   detectors, gates, or flags. The detector, the `exit_reason` persistence, the terminal-reason set,
   and the `exit_reason` read pattern all already exist and ship today.
2. **Can it REUSE instead of ADD?** Yes — this is pure reuse. `isFatalPhaseFailure` already consults
   `exit_reason` on its microverse branch against `isMicroverseFatalReason`. WS-1 applies the same
   shape on the pickle branch against mux-runner's already-exported terminal set. Precedent for
   reading `exit_reason` at this exact seam: R-CCR-3 (stale-handoff clearance) and R-ICP-2
   (`PhaseIncomplete`), both in `runPhaseIteration`.
3. **Does it guard EXISTING brittle complexity that should be SUBTRACTED?** No — the opposite. It
   removes an asymmetry (one branch reads the field, the other does not) rather than guarding it.
   Explicitly REJECTED alternative: a prose-signature classifier that pattern-matches worker output
   for "no node_modules" — that invents a proxy where a structured signal already exists, and is the
   exact mistake the source bug report made.
4. **What can this SUBTRACT?** Executed phases. When the crash floor is honoured at phase 1,
   citadel / anatomy-park / szechuan-sauce do not run at all in this scenario — three phases and
   ~11 judge cycles removed from the failure path.

### WS-2 (amnesiac proxy + breaker bound)

1. **Is the addition necessary at all?** No new state. Both halves are **deletions or demotions** of
   existing code.
2. **Can it REUSE instead of ADD?** Yes — the truth signals the proxy should defer to
   (`preIterSha` / `postIterSha` / commit count) are already computed and already passed to
   `classifyStall` in the same file. WS-2 consults what is already in hand.
3. **Does it guard EXISTING brittle complexity that should be SUBTRACTED?** Yes, and it subtracts it.
   `num_turns < 5` is brittle by construction: it cannot distinguish a lazy worker from a correct fast
   one. It is demoted below the truth checks or removed. The breaker's `consecutive_amnesiac_exits: 0`
   reset is deleted outright — a bound that resets itself is not a bound. Explicitly REJECTED
   alternative: hashing worker verdict text and halting on N identical hashes — a second proxy layered
   on the first, which the source bug report proposed and which this review strikes.
4. **What can this SUBTRACT?** One proxy branch, one counter reset, and an unbounded loop class.

**Net across the bundle: no new state field, no new detector, no new gate, no new skip flag.**

## The crash-floor set is a STRICT SUBSET of the failure set — this is the bundle's central hazard

`FAILURE_EXIT_REASONS` (`extension/src/bin/mux-runner.ts`, a module-private `ReadonlySet<ExitReason>`
surfaced only through the exported predicate `isFailureExit`) contains **15 members**, including
`error`, `stall`, `circuit_open`, `rate_limit_exhausted`, `timeout_repeat`, and
`manager_persistent_hallucination`.

**Halting the pipeline on that set would add roughly a dozen new abort conditions and is FORBIDDEN.**
The root `CLAUDE.md` is binding: *"Do not add abort conditions — every new one is a new way for
reliability and quality to both reach zero."* Those reasons are quality/measurement verdicts and MUST
continue to park-and-flag.

The subject set for WS-1 is the **crash floor** — cannot-physically-continue only — as enumerated in
`CLAUDE.md`. Intersected with the `ExitReason` union, the members not already handled are exactly:

| Crash-floor reason | Already handled? |
|---|---|
| `toolchain_unavailable` | **NO — this bundle's gap** |
| `state_working_dir_missing` | **NO — same gap** |
| `state_schema_version_ahead` | **NO — same gap** |
| missing `start_commit` | yes — `isFatalPhaseFailure` `!startCommit` arm |
| `cancelled` (operator cancel) | yes — `isHaltExit` |
| `iteration_cap_exhausted` | yes — exit code 3 → `reportPhaseIncomplete` (R-ICP-1/2) |

So WS-1 adds **three** reasons to the pickle branch's halt consideration, not fifteen. Any
implementation that reaches for `isFailureExit` as the predicate is WRONG and must be rejected in
review.

**Visibility note:** the crash-floor set must become consultable from `pipeline-runner.ts`. Exporting
an existing const (or adding a narrow exported predicate beside `isFailureExit`) is a visibility
change, not new state — it does not violate the net-subtractive claim. Do NOT widen
`FAILURE_EXIT_REASONS` itself, and do NOT add a new state field.

## Interface Contracts

**`extension/src/bin/pipeline-runner.ts`**

```ts
// current
export function shouldHaltAfterPhase(
  phase: PhaseName, exitCode: number, runtime: PipelineRuntime
): boolean
export function isFatalPhaseFailure(
  phase: PhaseName, runtime: PipelineRuntime
): boolean
```
`isFatalPhaseFailure` already reads `sm.read(runtime.statePath)`. Its `anatomy-park`/`szechuan-sauce`
arm consults `runnerState.exit_reason` via `isMicroverseFatalReason`; its `pickle` arm consults only
`runnerState.start_commit`. **Invariant after the fix:** the `pickle` arm additionally returns `true`
when `exit_reason` is a crash-floor member, and returns `false` for every non-crash-floor reason
(continue-by-default preserved). Signatures MUST NOT change — no new parameter is needed, the state
handle is already in scope.

**`extension/src/bin/mux-runner.ts`**

```ts
export type ExitReason = 'success' | 'cancelled' | ... | 'toolchain_unavailable';
export const isFailureExit: (r: ExitReason) => boolean;   // NOT the predicate to use here
```
**Errors:** a state read failure inside `isFatalPhaseFailure` is already caught and falls through to
non-halt (fail-open). Preserve that — a transient read error must not manufacture a halt.

**`extension/src/bin/microverse-runner.ts`**

```ts
export type NoCommitExitClassification = 'clean_pass' | 'stall' | 'amnesiac';
export function classifyNoCommitExit(iterLogFile: string): NoCommitExitClassification
export function resetGapAnalysisForAmnesiacBreaker(
  state: MicroverseState, sessionDir: string
): MicroverseState
```
**Invariants after the fix:** `classifyNoCommitExit` returns `amnesiac` only when the turn-count
signal is present AND the iteration is not provably no-op (empty diff with equal pre/post SHA);
`resetGapAnalysisForAmnesiacBreaker`'s returned object does NOT contain
`consecutive_amnesiac_exits: 0`. Return types MUST NOT change — `NoCommitExitClassification` gains no
new member.

## Test Expectations

| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| crash-floor halts | `extension/tests/pipeline-runner.test.js` | pickle exits non-zero with each crash-floor `exit_reason` | `shouldHaltAfterPhase`/`isFatalPhaseFailure` returns `true` for each |
| non-floor continues | `extension/tests/pipeline-runner.test.js` | pickle exits non-zero with `error`/`stall`/`rate_limit_exhausted`/`circuit_open` | returns `false` — R-PHC-6 continue-by-default preserved |
| no abort widening | `extension/tests/pipeline-runner.test.js` | the halt predicate is not `isFailureExit` | every non-crash-floor member of `FAILURE_EXIT_REASONS` does NOT halt |
| read-error fail-open | `extension/tests/pipeline-runner.test.js` | `sm.read` throws | returns `false`, no manufactured halt |
| attribution survives | `extension/tests/pipeline-runner.test.js` | halt path then finalize | stamped `exit_reason` readable after `finalizePipeline` |
| proxy defers to truth | `extension/tests/microverse.test.js` | turn counts 0..4, empty diff, equal SHAs | classification is never `amnesiac` |
| proxy still works | `extension/tests/microverse.test.js` | low turns, NON-empty diff | `amnesiac` still reachable — the branch is demoted, not dead |
| breaker is bounded | `extension/tests/microverse.test.js` | 10 consecutive amnesiac-shaped iterations | terminal exit reached; baseline-measurement count bounded |
| breaker keeps count | `extension/tests/microverse.test.js` | `resetGapAnalysisForAmnesiacBreaker` return value | does not set `consecutive_amnesiac_exits` to 0 |
| convergence regression | `extension/tests/microverse-convergence.test.js` | genuine changing progress | not misread as stall or amnesiac |

## Acceptance Criteria

ACs are quantified universally over the exported unions rather than over a hardcoded reason list, so a
reason added later inherits the contract by construction.

- [ ] For **every** member `r` of the crash-floor set, a `pickle` phase that exits non-zero with `state.exit_reason === r` halts instead of advancing — Verify: a test deriving the subject list from the crash-floor set at runtime (no hardcoded literals) and asserting halt for each member — Type: test
- [ ] For **every** `ExitReason` NOT in the crash-floor set — including every non-floor member of `FAILURE_EXIT_REASONS` (`error`, `stall`, `circuit_open`, `rate_limit_exhausted`, `timeout_repeat`, …) — a non-zero `pickle` exit continues to citadel exactly as today — Verify: a test deriving the complement at runtime and asserting non-halt for each; this is the anti-abort-widening guard and MUST fail if the implementation reaches for `isFailureExit` — Type: test
- [ ] The count of pipeline-halting conditions on the pickle branch grows by exactly the crash-floor members named in the PRD table and no others — Verify: a test asserting the halting-reason count against that enumerated set — Type: test
- [ ] A state-read failure inside the halt decision still fails OPEN (no manufactured halt) — Verify: a test making `sm.read` throw and asserting non-halt — Type: test
- [ ] The halt is attributed, not silent: the persisted `exit_reason` survives `finalizePipeline` so `pipeline-status.json` does not report a bare `failed` — Verify: assert the stamped reason is readable after finalize (the R-PRH three-case contract already covers this shape) — Type: test
- [ ] `classifyNoCommitExit` does NOT return `amnesiac` for any iteration whose diff is empty AND whose pre/post SHAs are equal, for **every** `num_turns` value below the proxy threshold — Verify: a test iterating turn counts 0..4 with empty diff + unchanged SHA, asserting the classification is never `amnesiac` — Type: test
- [ ] The proxy is demoted, not deleted-by-accident: `amnesiac` remains reachable for a low-turn iteration whose diff is NON-empty — Verify: a test asserting `amnesiac` is still returned in that case — Type: test
- [ ] The amnesiac path is provably bounded: for a worker returning the same sub-threshold blocked result N times, the runner reaches a terminal exit and the count of LLM baseline measurements is bounded — Verify: a test driving 10 consecutive amnesiac-shaped iterations, asserting terminal exit and a bounded measurement count (today both are unbounded) — Type: test
- [ ] `resetGapAnalysisForAmnesiacBreaker` does not reset `consecutive_amnesiac_exits` — Verify: assert the returned object does not set that field to 0 — Type: test
- [ ] Regression floor: genuine iterative convergence is not misread as a stall or an amnesiac exit — Verify: `cd extension && npm run test:fast` green, including `extension/tests/microverse-convergence.test.js` and `extension/tests/microverse-llm-judge-non-determinism-recovery.test.js` — Type: test
- [ ] Net-subtractive: the diff introduces no new state field and no new `skip_*_reason` — Verify: `git diff` adds no key to the state/microverse-state type declarations and no new skip flag — Type: test
- [ ] Type checker passes — Verify: `cd extension && npx tsc --noEmit` — Type: typecheck
- [ ] Lint passes — Verify: `cd extension && npx eslint src/ --max-warnings=-1` — Type: lint

## NOT in Scope

- **Judge non-determinism on an empty diff.** Across ~11 cycles against a provably unchanged empty
  diff the judge returned `3, 2, 4, 1, … 0`. Adjacent to the reopened R-JPCM and the R-SLLJ ledger
  work. It is the reason each amnesiac reset cost money, and a non-deterministic baseline defeats
  threshold tuning by construction — but it is a separate finding and must not be absorbed here.
- **The inherited R-GADEL integration-tier red** (~10 failures bisected to `a7d6d9ec`, shelved by
  operator decision). Leave red, name as inherited.
- **Changing `targetToolchainMissing`, the R-PFNT preflight, or any mux-runner detection code.** The
  detector is correct and proved it in the field. If a fix appears to require changing it, STOP and
  record why in the conformance artifact.
- **Raising the B-APNC no-clean-pass ceiling** (a separate anatomy-park convergence question).

## Exit State

A crash-floor `exit_reason` stamped by the pickle-phase runner halts the pipeline at the phase
boundary, attributed and logged, with the continue-by-default behaviour preserved for every non-floor
reason. The microverse no-commit classifier defers to observable truth over a turn-count proxy, and
the amnesiac breaker is bounded. The system is smaller by one proxy branch, one counter reset, and
three phases on the failure path.

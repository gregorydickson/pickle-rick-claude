# B-CRASHFLOOR — the pickle branch never reads `exit_reason`, and the amnesiac proxy outranks truth

*(refined: requirements + codebase-context + risk-scope analysts, 3 cycles, 2026-08-08)*

**Priority:** P1 (reliability)
**Source bug report:** `prds/BUG-REPORT-2026-08-07-toolchain-unavailable-not-treated-as-halt-stall-detection-blind-to-identical-verdicts.md`
**Field incident:** session `2026-08-07-35088221` — evidence already extracted; **no ticket reads that session directory** (it lives outside the repo and may be pruned).
**build_mode:** unattended. A running pipeline executes DEPLOYED JS; the source diff lands only at `install.sh`. Covers WS-2 as well as WS-1.

## Problem

### V1 — the pickle branch of `isFatalPhaseFailure` never reads `exit_reason`

`mux-runner.ts` detects a missing target toolchain, stamps `exit_reason = 'toolchain_unavailable'`
(`extension/src/bin/mux-runner.ts:9985`), emits `session_end`, deactivates, and exits code 1 — 268 ms
into phase 1. That machinery is complete, deployed, and correct.

`pipeline-runner.ts` discards it. `shouldHaltAfterPhase` (`extension/src/bin/pipeline-runner.ts:2846`)
is keyed on the exit **code**. `isFatalPhaseFailure` (`:2803`) *does* consult `exit_reason` — but only
on its `anatomy-park`/`szechuan-sauce` arm (`:2826`, via `isMicroverseFatalReason`). The `pickle` arm
(`:2806`) checks only `start_commit`. Writer and reader sit on different branches, so the crash floor
is unreachable and the pipeline advances into citadel, anatomy-park and szechuan-sauce against a repo
with no toolchain.

**The pickle arm has exactly ONE halting condition today** (`if (!startCommit) return true`, `:2822`).
B-GTRUTH WS-A2 and B-NOSTOP-GATES WS-1 deliberately emptied it of *quality* verdicts (see the
in-source comments at `:2805-2820`). Crash-floor reasons are cannot-physically-continue **facts**, not
measurements, so re-adding them is consistent with — not a reversal of — those bundles.

### V2 — a turn-count proxy outranks observable truth

`classifyNoCommitExit` (`extension/src/bin/microverse-runner.ts:1518`) evaluates `num_turns < 5`
(`:1530`) **before** any content check. A worker that correctly concludes "blocked, nothing to fix"
does so in few turns — being right is fast — so a decisive correct verdict is classified `amnesiac`.
The handler (`:3749`) logs `not counting as stall` and never touches `stall_counter`. Field
confirmation: `stall_counter: 0`, `convergence.history: []` after 22 iterations.

**Corrected from the source bug report — the loop is NOT "unbounded by construction".**
`runIterationPreamble` returns `'iteration_budget_exhausted'` at `ctx.iteration >= max_iterations`
(`:4188-4193`) — but **only when `maxIter > 0`** (`:4191`). A session with `max_iterations` absent or
`0` has no iteration bound at all (test fixtures do exactly this — `extension/tests/microverse.test.js:946`).
Where a bound exists it is large: `pickle_settings.json` ships `default_max_iterations: 500`, and
`preparePhaseState` writes per-phase values via the `resetByPhase` map
(`extension/src/bin/pipeline-runner.ts:229-230`, `:3040-3050`, `:1426`) read at
`extension/src/bin/microverse-runner.ts:4188`. At the field-measured ~$1.20 per amnesiac cycle
($13.21 / ~11 cycles) the ceiling is **hundreds of dollars of judge spend per session** before the
loop self-terminates. Not literally unbounded — economically indistinguishable from it. The `$13.21`
figure is **evidence only**; there is no cost AC.

## CUJs

### CUJ-1 — operator launches a pipeline against a repo with no installed toolchain
1. Operator runs `/pickle-pipeline` in a working dir whose `package.json` has no `node_modules`.
2. `targetToolchainMissing` trips; the runner stamps `exit_reason = 'toolchain_unavailable'`, emits
   `session_end`, deactivates, exits code 1 — ~268 ms.
3. The phase boundary reads the stamped reason and halts. Citadel / anatomy-park / szechuan-sauce
   never start.
4. Operator sees `exit_reason: toolchain_unavailable` in `pipeline-status.json` plus one halt line
   naming phase and reason — **not** "no build progress this run".
5. Operator runs `npm ci` and relaunches. No state surgery.

**Failure state:** any non-crash-floor reason at step 2 → the pipeline continues to citadel exactly as
today.
**No escape hatch:** there is no flag or env var that makes step 3 continue. Recovery from a misfire
is revert-and-redeploy of the extension. This is deliberate — see `## Risks`.

### CUJ-2 — a worker is correct and fast, and the microverse stops paying for it
1. A microverse iteration's worker concludes "blocked, nothing to fix" in 3 turns, commits nothing.
2. The iteration is **provably no-op** (clean working tree AND `ctx.preIterSha === ctx.postIterSha`
   AND zero commits), so it classifies `stall` — the turn count does not outrank that.
3. `stall_counter` increments (field-observed today: stays at `0`).
4. Within `stall_limit` iterations the run exits `'stalled_below_target'`, attributed.

**Failure state:** the same worker with a DIRTY tree that `autoRescueDirtyTree` declined still
classifies `amnesiac` — the proxy is demoted, not deleted.

## The crash-floor set is a STRICT SUBSET of the failure set — the bundle's central hazard

`FAILURE_EXIT_REASONS` (`extension/src/bin/mux-runner.ts:4459`, module-private, surfaced only via the
exported `isFailureExit`) has **15** members including `error`, `stall`, `circuit_open`,
`rate_limit_exhausted`, `timeout_repeat`. `ExitReason` (`:4434`) has **21**.

**Halting on that set would add 12 abort conditions and is FORBIDDEN** — the root `CLAUDE.md` binds:
*"Do not add abort conditions."* Those are quality/measurement verdicts and MUST park-and-flag.

| Crash-floor reason | Status |
|---|---|
| `toolchain_unavailable` | **LIVE — this bundle closes it.** Stamped at `mux-runner.ts:9985`, exit code 1 |
| `state_working_dir_missing` | **LIVE — this bundle closes it.** Nine stamping sites (`:7675` via `breakWithExitReason`, `:10199`, `:10604`, `:10692`, `:10772`, `:10854`, `:11679`, `:11802`), exit code 1 |
| `state_schema_version_ahead` | **contract-only, ZERO live paths.** Stamped solely by `handleSchemaVersionAhead` (`mux-runner.ts:134-158`) which `process.exit(3)`s → consumed by `resolvePhaseIncompleteOutcome` (`pipeline-runner.ts:4329`) **two lines before** `shouldHaltAfterPhase` (`:4331`). Stays a SET MEMBER so a future code-1 route inherits the contract; its AC is satisfied by writing `exit_reason` synthetically |
| missing `start_commit` | already handled — `isFatalPhaseFailure` `!startCommit` arm (`:2822`) |
| `cancelled` (operator cancel) | already handled — `isHaltExit` (`:4448`) |
| `iteration_cap_exhausted` | already handled — exit code 3 → `reportPhaseIncomplete` (R-ICP-1/2) |

**WS-1 closes TWO live reasons.** Halting-condition arithmetic: pickle arm **1 → 3**, and AC-CF-04
**removes** one (the fail-closed `catch`). Any fourth is abort widening and MUST fail review. An
implementation whose halt predicate is `isFailureExit` is **wrong** and must be rejected.

## Interface Contracts

### New exports — `extension/src/types/index.ts`, beside `MICROVERSE_FATAL_REASONS` (`:1310`)

```ts
export const CRASH_FLOOR_EXIT_REASONS = [
  'toolchain_unavailable', 'state_working_dir_missing', 'state_schema_version_ahead',
] as const;
export const EXIT_REASONS: readonly ExitReason[];   // AC-CF-02's complement needs an iterable value
```
Placement precedent is exact: `pipeline-runner.ts:23` already imports `MICROVERSE_FATAL_REASONS` from
`../types/index.js`, builds a local set (`:2781`), and consults it via a local predicate (`:2798`).
Mirror that shape. `FAILURE_EXIT_REASONS` stays module-private and is **NOT** widened. Both exports
MUST be registered in the Module Export Catalog (`extension/src/bin/CLAUDE.md`, subsystem-contract
rule #4) in the same change — that file goes in the WS-1 allowlist.

### `extension/src/bin/pipeline-runner.ts`

```ts
export function shouldHaltAfterPhase(phase, exitCode: number, runtime): boolean
export function isFatalPhaseFailure(phase, runtime): boolean
```
Signatures MUST NOT change — `isFatalPhaseFailure` already calls `sm.read(runtime.statePath)`.

**`pipeline_continue_on_phase_fail` is a strict-mode OPT-IN, not a continue escape hatch.** It is
backfilled to `true` on every session (`extension/src/services/state-manager.ts:645`), `--strict-phases`
writes `false` (`pipeline-runner.ts:3136-3138`), and the only halt-path consumer tests `=== false`
(`:2857`). There is no operator setting asking the pipeline to continue past a crash floor and
nothing for the crash-floor read to override.

**Read-error behaviour is CHANGED, not preserved.** `isFatalPhaseFailure`'s `catch` returns `true`
today — **fail-CLOSED** (`:2841-2843`). This bundle changes it to `false`. That REMOVES an abort
condition. (`shouldHaltAfterPhase`'s own catch at `:2859-2861` already falls through to non-halt; the
two functions differ and the original PRD conflated them.)

### `extension/src/bin/microverse-runner.ts`

```ts
export type NoCommitExitClassification = 'clean_pass' | 'stall' | 'amnesiac';   // gains no member
export function classifyNoCommitExit(iterLogFile: string): NoCommitExitClassification
```
**The truth check does NOT belong in `classifyNoCommitExit`** — its signature sees one file, while the
SHAs live on `ctx` in the caller (`:3736`, used `:3762-3763`). It belongs in `handleNoCommitStall`.

**The demoted verdict routes to the EXISTING `stall` arm. No new mechanism is required and none may
be added.** `handleNoCommitStall`'s stall arm (`:3760-3775`) already calls `recordStall`
(`extension/src/services/microverse-state.ts:322-330` — increments `convergence.stall_counter` AND
zeroes `consecutive_amnesiac_exits`), then `isConverged` (`:424`, `stall_counter >= stall_limit`),
then `convergenceExitReason('stall')` → `'stalled_below_target'` (`microverse-runner.ts:3732-3734`).
`'stalled_below_target'` is in **neither** `MICROVERSE_FATAL_REASONS` **nor** `MICROVERSE_FAILURE_REASONS`
(`extension/src/types/index.ts:1310-1321`), so it terminates the loop **without adding a phase-level
abort**. Regression floor already on disk: `extension/tests/microverse-convergence.test.js:1147`
(AC-JPCM-8). Because `recordStall` zeroes the counter, the `resetGapAnalysisForAmnesiacBreaker` call
site (`:3752-3755`) is **removed outright** and its `gap_analysis.md` truncation (`:3671-3677`) goes
with it. **A new `max_amnesiac_exits` field, a new exit reason, or a new counter is a review-blocking
defect.**

**The truth check MUST be evaluated before the `clean_pass` substring arm** (`:1531-1537`), not merely
before the turn arm. That arm matches bare `'clean'` against `String(result?.result ?? content)` — the
**whole log file** when the JSON result line is absent — and `clean_pass` returns the literal
`'converged'` (`:3742-3748`). The blocked-worker log this bundle exists to fix contains both `'clean'`
and `'nothing to fix'`. Demoting the proxy without pinning the target converts an expensive-but-honest
loop into a cheap **fake-green**, which is strictly worse than the bug.

**`replaceMicroverseState` (`:2949-2955`) mutates the caller's object in place.** `handleNoCommitStall`
relies on read-after-write at `:3750-3752`. Do not convert it to a reassignment.

**"Provably no-op" is defined as:** clean working tree AND `ctx.preIterSha === ctx.postIterSha` AND
zero commits.

## Acceptance Criteria

- [ ] **AC-CF-01** For every member of `CRASH_FLOOR_EXIT_REASONS`, a `pickle` phase exiting non-zero with that `exit_reason` halts — Verify: a test deriving the subject list from the exported const at runtime (no hardcoded literals) — Type: test
- [ ] **AC-CF-02** For every `ExitReason` NOT in the crash-floor set — including every non-floor `FAILURE_EXIT_REASONS` member — a non-zero `pickle` exit continues to citadel — Verify: a test deriving the complement from `EXIT_REASONS` at runtime; MUST fail if the halt predicate is `isFailureExit` — Type: test
- [ ] **AC-CF-03** The pickle arm's halting-condition count goes 1 → 3 and no further — Verify: assert against the enumerated crash-floor set — Type: test
- [ ] **AC-CF-04** A state-read failure inside `isFatalPhaseFailure` fails OPEN. **This CHANGES `catch { return true }` (`pipeline-runner.ts:2841-2843`) to `false`, REMOVING an abort condition** — Verify: a test making `sm.read` throw, asserting non-halt — Type: test
- [ ] **AC-CF-05** On a crash-floor halt the operator string names the reason, not `"zero commits since baseline <sha> — no build progress this run"`. `getFatalPickleHaltReason` (`:4001-4029`) reads `exit_reason` only on its `commitCount > 0` branch (`:4021-4027`); a toolchain halt has zero commits and hits `:4013-4016`. Its stale doc comment (`:3991-3999`, still describing the zero-commits arm B-NOSTOP-GATES deleted) is corrected in the same diff — Verify: assert the string for a zero-commit + `toolchain_unavailable` state contains the reason — Type: test
- [ ] **AC-CF-06** A provably no-op no-commit iteration classifies `stall` — never `amnesiac`, never `clean_pass` — Verify: drive `handleNoCommitStall` with equal SHAs, `num_turns` derived from the threshold constant, and a log containing both `"clean"` and `"nothing to fix"`; assert the returned reason is NOT `'converged'`. A `'converged'` is a fake-green and MUST fail — Type: test
- [ ] **AC-CF-07** The proxy is demoted, not deleted: `amnesiac` remains reachable when `handleNoCommitStall` is entered with a DIRTY tree — the two live paths are `autoRescueDirtyTree` declining on foreign-only dirt (`:3812-3815`) and its commit throwing (`:3823-3826`) — Verify: an integration-shaped test constructing one of those states. A unit test on `classifyNoCommitExit` alone does NOT satisfy this — Type: test
- [ ] **AC-CF-08** The amnesiac path terminates on the EXISTING stall ceiling, not a budget: with `max_iterations = 50` and `max_time_minutes = 0`, repeated sub-threshold blocked results reach terminal `'stalled_below_target'` within `stall_limit` iterations, with ≤ `stall_limit` LLM baseline measurements — Verify: assert the exact terminal reason and that the exit iteration is `< 50`, so `iteration_budget_exhausted` (`:4188-4193`) cannot be the mechanism — Type: test
- [ ] **AC-CF-09** `NoCommitExitClassification` gains no new member — Verify: assert the union has exactly three members — Type: test
- [ ] **AC-CF-10** A default session (flag unset → backfilled `true`) halts on a crash-floor reason — Verify: a test with the flag absent — Type: test
- [ ] **AC-CF-11** A `--strict-phases` session (flag `false`) also halts on a crash-floor reason — Verify: a test with the flag `false` — Type: test
- [ ] **AC-CF-12** An absent or unrecognised `exit_reason` on a non-zero pickle exit does NOT halt — Verify: tests for `undefined` and for an unknown string — Type: test
- [ ] **AC-CF-13** A crash-floor `exit_reason` co-resident with a stale handoff reason still halts (`runPhaseIteration:4304-4311` clears a stale handoff before `:4331`) — Verify: a test with both set — Type: test
- [ ] **AC-CF-14** When `pickle` halts on a crash-floor reason, citadel / anatomy-park / szechuan-sauce are never invoked — Verify: drive the phase loop with a stubbed phase runner through `dispatchHaltAction` (`:4331`, `:4336-4337`); assert the downstream invocation list is empty — Type: test
- [ ] **AC-CF-15** A crash-floor halt does not run the abort-path typecheck/lint gate and emits no `tsc_gate_failed` record. `dispatchHaltAction` runs `runGate({checks:['typecheck','lint']})` (`:4192-4197`, 30 s/check via `extension/src/services/convergence-gate.ts:598`) which is guaranteed red on a repo with no `node_modules` — Verify: stub `runGate`, drive a crash-floor halt, assert it was not called and no `tsc_gate_failed` event emitted — Type: test
- [ ] **AC-CF-16** `extension/tests/microverse-convergence.test.js:1147` (AC-JPCM-8) stays green — Verify: `cd extension && npm run test:fast` — Type: test
- [ ] **AC-CF-17** Net-subtractive: no new state field, no new exit reason, no new counter, no new `skip_*_reason` — Verify: `git diff` adds no key to the state/microverse-state type declarations — Type: test
- [ ] **AC-CF-18** Type checker and lint pass — Verify: `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1` — Type: typecheck

## Test Expectations

| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| AC-CF-01/02/03/10/11/12/13 | `extension/tests/pipeline-runner.test.js` | crash-floor halt matrix — **net-new coverage**; nothing today asserts phase-boundary disposition for either live reason | halt for floor members, non-halt for the complement |
| AC-CF-04 | `extension/tests/pipeline-runner.test.js` | `sm.read` throws | non-halt (changed from fail-closed) |
| AC-CF-05 | `extension/tests/pipeline-runner.test.js` | zero-commit + `toolchain_unavailable` | operator string names the reason |
| AC-CF-14/15 | `extension/tests/pipeline-runner.test.js` | stubbed phase runner + stubbed `runGate` | no downstream phases; no `tsc_gate_failed` |
| AC-CF-06/09 | `extension/tests/microverse-stall-resilience.test.js` | **`:97` (`returns amnesiac for fewer than five turns`) encodes pre-fix behaviour and goes RED** | updated in the same ticket |
| AC-CF-08 | `extension/tests/microverse-stall-resilience.test.js` | **`:152` and `:174` encode pre-fix behaviour and go RED**; `:174` is caller-level | updated in the same ticket |
| AC-CF-07 | `extension/tests/microverse.test.js` | dirty-tree entry path; note `:954` drives `handleNoCommitStall` with equal SHAs asserting `stall_category: 'tests_red_no_progress'` — verify still green | `amnesiac` still reachable |
| AC-CF-16 | `extension/tests/microverse-convergence.test.js` | `:1147` AC-JPCM-8 — the mechanism WS-2 reuses | must stay green |

**Ticket allowlists MUST contain every file named above** — the per-file scope fence
(`check-scope-diff.ts` preflight) blocks edits to files outside the allowlist, so an allowlist missing
`microverse-stall-resilience.test.js` yields an unsatisfiable ticket, zero commits, and a wedge.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Abort widening — implementer reaches for `isFailureExit` or halts on a quality verdict | P0 | AC-CF-02 derives the complement at runtime and asserts non-halt; review MUST reject any diff whose halt predicate is `isFailureExit` |
| Demoting the proxy exposes the `'clean'` substring arm → literal `'converged'` → **fake-green** | P0 | AC-CF-06 fails on `'converged'`; the truth check sits before the substring arm, not merely before the turn arm |
| Deleting the reset in isolation latches `>= 2` true → gap analysis every iteration → **doubles** the burn | P0 | Route to the existing `stall` arm; `recordStall` zeroes the counter naturally and the whole breaker call site is deleted |
| A worker invents `max_amnesiac_exits` because the PRD never names the terminal chain | P0 | The chain is named verbatim in Interface Contracts; a new counter/field/exit-reason is review-blocking |
| AC-CF-08 passes pre-fix if the harness lets the iteration cap terminate the loop | P0 | Pin `max_iterations = 50`, `max_time_minutes = 0`, assert exit iteration `< 50` and reason `'stalled_below_target'` |
| Scope-fence deadlock from an allowlist missing `microverse-stall-resilience.test.js` | P0 | All test files enumerated above are allowlisted |
| Halt path runs a guaranteed-red typecheck/lint gate on a toolchain-less repo | P1 | AC-CF-15 skips the abort gate on a crash-floor halt — a subtraction |
| `getFatalPickleHaltReason` tells the operator "no build progress" on this bundle's own incident | P1 | AC-CF-05 |
| Halting at phase 1 changes `pipeline-status.json` record shape for downstream consumers (attractor, babysitter, metrics) | P1 | A partial phase list is acceptable and expected; the halt writes an attributed status |
| **No runtime mitigation for a misfiring crash-floor halt** — no flag, no env var, no settings key | P1 | Deliberate on a three-member cannot-physically-continue set. Rollback is revert-and-redeploy of the extension |
| Collateral deletion of the three sibling `consecutive_amnesiac_exits` resets | P1 | Named in `## NOT in Scope` |
| Bundle edits the classifier its own anatomy/szechuan phases run through | P1 | The running pipeline executes DEPLOYED pre-fix JS; unattended is safe |

## Simplification Review

### WS-1
1. **Necessary?** No new mechanism. Two exported consts (a visibility change beside an existing
   precedent) and a read of a field already persisted.
2. **REUSE?** Pure reuse — `isFatalPhaseFailure` already consults `exit_reason` on its microverse arm;
   WS-1 applies the same shape to the pickle arm. Precedent for reading `exit_reason` at this seam:
   R-CCR-3 and R-ICP-2.
3. **Guard brittle complexity, or subtract?** Subtracts — removes a branch asymmetry, flips one
   fail-closed catch open (removing an abort), and skips a guaranteed-red gate. REJECTED alternative:
   a prose-signature classifier matching worker output; that invents a proxy where a structured signal
   exists — the exact mistake the source bug report made.
4. **SUBTRACT?** Three phases removed from the failure path; one abort condition removed; one
   guaranteed-red gate skipped.

### WS-2
1. **Necessary?** No new state. The proxy demotion and the breaker-call-site removal are subtractions;
   the bound is supplied by shipped code.
2. **REUSE?** The terminal chain (`recordStall` → `isConverged` → `'stalled_below_target'`) ships
   today and is already tested at `microverse-convergence.test.js:1147`.
3. **Guard brittle complexity, or subtract?** Subtracts. `num_turns < 5` cannot distinguish a lazy
   worker from a correct fast one; it is demoted below the truth check. **DECIDED: demoted, not
   removed** — AC-CF-07 requires it to stay reachable for dirty trees. REJECTED: hashing verdict text
   (a second proxy on the first).
4. **SUBTRACT?** One proxy branch demoted, one breaker call site plus its `gap_analysis.md` truncation
   deleted, one unbounded-burn class removed.

**Net: no new state field, no new exit reason, no new counter, no new gate, no new skip flag.**

## NOT in Scope

Each bullet: if an AC appears to require crossing the line, **STOP and record why in the conformance
artifact** rather than crossing it.

- **Judge non-determinism on an empty diff** (scores `3, 2, 4, 1, … 0` across ~11 cycles on an
  unchanged empty diff). Adjacent to reopened R-JPCM and the R-SLLJ ledger work. Separate finding.
- **The inherited R-GADEL integration-tier red** (~10 failures bisected to `a7d6d9ec`, shelved).
  Leave red; **report it as inherited in the conformance artifact** so it does not read as this
  bundle's regression.
- **`targetToolchainMissing`, the R-PFNT preflight, or any mux-runner detection code.** The detector
  is correct and proved it in the field.
- **Giving `pipeline_continue_on_phase_fail: true` a continue-past-crash-floor meaning.** It is
  strict-mode-only; inverting it changes the default contract for every existing session.
- **`isFatalPhaseFailure`'s trailing `return true` (`pipeline-runner.ts:2840`)**, which makes
  `citadel` and any future phase unconditionally phase-fatal. Pre-existing; does NOT count toward the
  halting-condition delta. Do not "tidy" it while chasing AC-CF-03.
- **The three sibling `consecutive_amnesiac_exits` resets** in `microverse-state.ts`
  (`recordIteration`, `recordStall`, `clearAmnesiacExits`) — all correct. `clearAmnesiacExits` is
  called directly by the convergence arm (`microverse-runner.ts:3743`), so deleting it changes the
  convergence-exit path. Only `resetGapAnalysisForAmnesiacBreaker`'s call site is removed.
- **`replaceMicroverseState`'s in-place mutation semantics (`:2949-2955`).** Do not convert to a
  reassignment; `handleNoCommitStall` relies on read-after-write.
- **Widening `FAILURE_EXIT_REASONS`.** It stays module-private.
- **Raising the B-APNC no-clean-pass ceiling** (a separate anatomy-park convergence question).
- **Re-reading session `2026-08-07-35088221`.** Its figures are already-extracted evidence; the
  directory may have been pruned.

## Exit State

A crash-floor `exit_reason` stamped by the pickle-phase runner halts the pipeline at the phase
boundary — attributed, logged with the reason (not "no build progress"), without running a
guaranteed-red gate, and with continue-by-default preserved for all 18 non-floor reasons. The
microverse no-commit classifier defers to observable truth over a turn-count proxy and terminates on
the existing stall ceiling as `'stalled_below_target'`. The system is smaller by one proxy branch, one
breaker call site, one abort condition, one guaranteed-red gate, and three phases on the failure path.

## Implementation Task Breakdown

| Order | ID | Title | Priority | Entry | Exit | Files |
|---|---|---|---|---|---|---|
| 10 | `2b7f4c19` | Export the crash-floor set and halt the pickle branch on it | High | green tree | AC-CF-01/02/03/04/09-13/17 pass | `types/index.ts`, `pipeline-runner.ts`, `bin/CLAUDE.md`, `tests/pipeline-runner.test.js` |
| 20 | `8e3a5d62` | Make the crash-floor halt honest and cheap | High | 10 Done | AC-CF-05/14/15 pass | `pipeline-runner.ts`, `tests/pipeline-runner.test.js` |
| 30 | `c41d9f07` | Demote the turn proxy below truth; route to the existing stall ceiling | High | 20 Done | AC-CF-06/07/08/16 pass | `microverse-runner.ts`, `tests/microverse-stall-resilience.test.js`, `tests/microverse.test.js`, `tests/microverse-convergence.test.js` |

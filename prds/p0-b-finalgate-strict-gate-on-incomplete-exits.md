# B-FINALGATE — anatomy-park fails in the field on pre-existing debt at finalize-gate, and `state.json` reports it `converged`

**Field evidence (operator, `prds/research/tools/field-timing-results-2026-09-26.md`):** in **3 of 3** field pipeline runs
on an operator monorepo (2026-09-24/25, pre-B-CAPGATE runtime), anatomy-park's microverse exited with an error, then
`finalize-gate failed after error (exit 2) — phase not completed, run cannot report success`. finalize-gate took
59.4 of 811 wall-clock minutes. In all three, `state.json` still recorded `exit_reason: converged`.

B-CAPGATE (#48, deployed 2026-09-26) fixed the **cap** route: it now judges only failures that are new against the
session baseline. Its PRD declared the follow-up this bundle covers: **finalize-gate stays strict and baseline-free on
every other incomplete microverse exit** (`anatomy_non_convergent`, iteration cap, budget cap, `error`), so the same
pre-existing debt still fails the phase there.

## Mechanism (measured at `main` HEAD `218fb91c`, 2026-09-26)

1. **Strict finalize-gate on incomplete exits.** Every microverse failure exit except `judge_timeout` routes to
   `run-finalize-gate-incomplete` (`pipeline-runner.ts:~5478-5480`, per the B-CAPGATE refinement). finalize-gate then
   runs strict over typecheck, lint and tests (`finalize-gate.ts:~336-343`) with no baseline. Pre-existing failures fail
   the phase. The cap now uses `mode: baseline` against the session `gate/baseline.json`; finalize-gate does not.
2. **`state.json` reports only the LAST phase.** `resetStateForPhase` clears `exit_reason` before each phase
   (`pipeline-runner.ts:1746-1751`). After anatomy-park fails, szechuan-sauce runs and converges, so the final
   `state.json` says `exit_reason: converged`, while the pipeline verdict (`pipeline-status.json`) says the run cannot
   report success. Research must list every consumer that reads `state.exit_reason` after a pipeline (e.g. `/pickle-status`,
   `pickle-recover`, `setup --resume`, `monitor`, the stop hook) and whether any treats it as the run's outcome.

**Unknown, measure first:** why the microverse exited `error` in the two runs that were not the #48 session. The field
logs are off-machine, so research states which exits the fix covers, and the operator supplies the reason tokens.

## Fix

1. **finalize-gate on an incomplete exit uses the same rule as the cap:** baseline mode against the session
   `gate/baseline.json` when it exists (never creating it), the same `allowedPaths` as capture, and no phase-wide `since`
   (see the B-CAPGATE rationale). Strict, with a log line, only when no baseline exists. Timeout-only reds are disclosed
   through the existing `converged_with_unmeasured`-style disposition, never counted as failed. **Reuse the cap's code
   path, extracted into one shared function, rather than writing a second copy of the rule.**
2. **The run's recorded outcome matches the pipeline verdict.** At pipeline end, the verdict that already exists in
   `pipeline-status.json` is also reflected in `state.json`, via one explicit field or by not overwriting an earlier
   failed phase's reason. Research picks the smaller change. No consumer may read "converged" for a run whose
   pipeline verdict is failed or degraded.

## Acceptance criteria (measure each at HEAD before shipping)

1. An incomplete anatomy-park exit (e.g. `anatomy_non_convergent`) with baseline F, where finalize-gate sees exactly F
   → the phase is not `finalize_gate_failed:*` (HEAD: failed). Control: strict mode reds it.
2. The same exit with F plus one NEW failure → the phase fails, as today.
3. No baseline → strict, with a log line naming the fallback (HEAD behaviour kept).
4. A run in which anatomy-park fails and szechuan-sauce converges ends with `state.json` NOT reporting a successful
   outcome that `pipeline-status.json` contradicts (HEAD: `exit_reason: converged`). Assert on the field the consumers
   actually read.
5. One implementation of the baseline-aware verdict serves both the cap and finalize-gate (`grep` shows a single
   definition, called from both sites).
6. `./node_modules/.bin/tsc --noEmit` and `./node_modules/.bin/eslint src/ --max-warnings=0` exit 0; touched tests pass.

## Simplification Review

Collapses two gate rules (cap: baseline; finalize: strict) into one. The outcome fix removes a disagreement between
two records of the same run. No new gate leg, env var or exit reason.

## Out of scope

Build-phase parallelism (#43, an operator decision); the microverse's own exit reasons.

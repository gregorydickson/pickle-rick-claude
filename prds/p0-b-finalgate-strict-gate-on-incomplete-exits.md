# B-FINALGATE — finalize-gate and its remediator on field repos (#49, #50, #51 + strict gate on incomplete exits)

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


## Operator-filed issues folded in (2026-09-26; re-measured at HEAD `c8a2e123`)

All four items share one surface (finalize-gate + the gate remediator), so they ride one bundle.

- **#49 — a failed pipeline ends with `state.json` `exit_reason: converged`.** CONFIRMED:
  `readExistingExitReason` (`extension/src/bin/pipeline-runner.ts:4728-4735`) returns ANY non-empty reason, so
  `finalizeFailedPipeline` (`:~4740-4745`) keeps a later phase's `converged` rather than stamping a failure. This
  REPLACES Fix §2 above with the precise rule: when `pipelineFailed`, a **success-class** reason (`converged`, and any
  other success reason a phase writes) is never preserved. A specific FAILURE reason already stamped (e.g.
  `done_without_commit_evidence`) still is (AC-MWMO-D2-10). Classify success with the existing microverse
  disposition classifier; do not add a new success list. AC: the phase sequence converged → finalize-gate failed →
  converged ends with a failure-class `exit_reason`. Mutation: "preserve any non-empty reason" reds it; a stamped
  specific failure reason is still preserved.
- **#50 — finalize-gate remediates failures no edit can fix.** CONFIRMED: `isUnmeasuredFailure`
  (`extension/src/bin/finalize-gate.ts:312-314`) tests `isCheckUnmeasured(...) && !path.isAbsolute(failure.file)`. The
  unparsed fallback in `buildFailures` (`extension/src/services/convergence-gate.ts:1114`, `:1190`) emits
  `file: pkgDir`, which is absolute and a DIRECTORY, so the row counts as remediable. The remediator is spawned up to
  the cycle cap (field: 4 cycles, 46 min, 13% of the run). The principle is **"does the row name an editable source
  file"**, not "is the path absolute": a directory (or non-file) row of an unmeasured check is unmeasured and is
  reported via `reportUnmeasuredGate` with NO remediator spawn. A real source-file failure of a check that timed out in
  a sibling dir stays remediable. AC: both directions tested; mutation 1 (revert to `!path.isAbsolute`) reds the
  directory case; mutation 2 (treat every unmeasured-check row as unmeasured) reds the sibling case.
- **#51 — the remediation brief injects pickle-rick's own `extension/CLAUDE.md` into every target repo.**
  CONFIRMED: `loadTrapDoorSection` (`extension/src/bin/spawn-gate-remediator.ts:302-317`) reads the `CLAUDE.md` two
  directories above the compiled script (the deployed pickle-rick extension) and never the session `working_dir`; no
  production caller injects `extensionClaudeMdContent`; `buildBriefContent` (`:152-153`) pastes it whole. Fix:
  Section 3 is drawn from the **target repo**: its `CLAUDE.md` files at the root and along each failing path, trap-door
  / rules sections only, within a stated size bound. pickle-rick's own file appears only when the target IS
  pickle-rick. No `CLAUDE.md` in the target → the section says so, with no fallback. AC: a field-repo fixture brief
  contains no pickle-rick content; a pickle-rick target contains its own; mutation: restoring the script-relative read
  reds the field-repo test.

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

Build-phase parallelism (#43, an operator decision); the microverse's own exit reasons; the timing script's gaps (field-timing.py).

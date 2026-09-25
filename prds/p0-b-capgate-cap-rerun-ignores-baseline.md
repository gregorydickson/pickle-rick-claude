# B-CAPGATE — anatomy-park's deferral-cap gate ignores the baseline (#48)

**PRIME DIRECTIVE.** A measurement verdict must never end a phase in error. At the R-APXG-3 deferral cap,
anatomy-park re-runs the gate and treats any red as `error`. That then fails finalize-gate
(`finalize_gate_failed:error`) and the pipeline completes 3 of 4 phases. In the operator's field run (a pnpm
monorepo target; details in #48), every failure the cap saw was **pre-existing**: it was in the iteration-1
baseline, with `new_failures_vs_baseline: 0`. The phase still ended `error`. The same gate also pushed a worker
into adding a script to the target repo's `package.json` so a gate command would resolve.

## Mechanism — measured at `main` HEAD `0092b491`, 2026-09-25

- `extension/src/bin/microverse-runner.ts:5750-5776`: at `POST_CONVERGENCE_GATE_DEFERRAL_LIMIT` (3), the runner
  calls `runGateFn({ workingDir, mode: 'strict', scope: 'full', checks: ['typecheck','lint'] })` and returns
  `'error'` on `status === 'red'`.
- `extension/src/services/convergence-gate.ts`: `GateMode = 'baseline' | 'strict'`. The baseline is consulted
  only when `opts.mode === 'baseline' && opts.baselinePath` (`:1839`, `:2007`). **Strict mode never subtracts the
  baseline**, so pre-existing failures are red at the cap. That produces `baseline_used: false`,
  `new_failures_vs_baseline: 0`, `status: red`.
- The per-iteration gate already runs in baseline mode against the session's `gate/baseline.json`. The cap is
  the one caller that drops it.
- `GATE_CHECK_TIMEOUT` (`convergence-gate.ts:29`) and a missing package script (`ERR_PNPM_NO_SCRIPT`, already
  classified at `:1205` as `missing pnpm script`) mean the check did not measure the tree. They are
  not failures of it.

## Fix

1. **The cap re-run uses the same baseline the per-iteration gate uses**: `mode: 'baseline'` with the session's
   `gate/baseline.json`. The tree is RED at the cap only for failures **not** in the baseline. With no readable
   baseline, keep today's behaviour and say so in the log.
2. **Unmeasured is not failed.** A check that timed out or could not run (missing script) is recorded as
   `unmeasured` in `check_status`, never as a failure, at the cap and in each cycle. Converging with an
   unmeasured check is allowed and is **disclosed**: the phase disposition and `pipeline-status.json` carry the
   caveat, and the run withholds any "all green" claim. No halt.
3. **Never invoke a script a package does not define.** When the lint/test command runs per workspace package,
   read that package's `package.json` scripts first. A package without the script is skipped and recorded as
   unmeasured for that check.
4. **Scope-fence research (measure before building).** Determine whether the existing worker scope fence
   (`check-scope-diff`) already makes an out-of-allowlist target `package.json` edit a `SCOPE_VIOLATION`. If it
   does, add only a regression test. If it does not, record the finding in this bundle's research artifact and do
   NOT build a new fence here; the operator decides.

## Files (starting points; research confirms)

- `extension/src/bin/microverse-runner.ts` (cap re-run; `postConvergenceGate…`)
- `extension/src/services/convergence-gate.ts` (baseline mode, `check_status`, timeout/no-script classification,
  per-package command resolution)
- `extension/src/bin/pipeline-runner.ts` (disposition and `pipeline-status.json` caveat), only if needed
- existing tests covering R-APXG-3 and the gate (find with `grep -rl "APXG-3\|DEFERRAL_LIMIT\|runGate" extension/tests`).
  Do not create new test files.

## Acceptance criteria

1. **Pre-existing failures don't block the cap.** With `gate/baseline.json` holding failures F, and the cap re-run
   returning exactly F (`new_failures_vs_baseline: 0`), the cap returns `'converged'`, and the phase disposition is
   not `finalize_gate_failed:*` (HEAD: `'error'`). Falsifying control: restoring `mode: 'strict'` at the cap reds
   this test.
2. **A NEW failure still blocks.** Baseline F plus one new failure at the cap → `'error'` (unchanged at HEAD).
3. **Unmeasured is disclosed, not failed.** A cycle whose only non-green checks are `GATE_CHECK_TIMEOUT` and a
   missing script records `check_status` = `unmeasured` for them (HEAD: `failed`), converges, and the phase
   disposition / `pipeline-status.json` carries an unmeasured caveat.
4. **No undefined script runs.** A two-package fixture where one package lacks the lint script: the gate does not
   invoke it for that package and records that package's lint as unmeasured (HEAD: the invocation errors
   `ERR_PNPM_NO_SCRIPT`).
5. `cd extension && ./node_modules/.bin/tsc --noEmit && npx eslint src/ --max-warnings=0` exits 0; touched test
   files pass under Node 24 and Node 22.

## Simplification Review

- **Necessary?** Yes: a measurement verdict ends a phase in `error`, which the prime directive forbids.
- **Subtraction:** the cap stops being the one gate caller that ignores the baseline, so one divergent mode goes
  away. "Unmeasured" reuses the existing unmeasured classification. No new gate leg, env var or exit reason.

## Out of scope

The gate's lint/test time budgets (they are per-machine tunables); new scope-fence machinery (item 4 only
measures).

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

## Refinement — BINDING decisions (override earlier text where they differ)

*(refined: requirements, codebase and risk-scope analysts, 3 cycles each on claude-opus-5-5, read at `4a8b0c4c`)*

**Premise, measured.** The cap has THREE withhold producers (AP-EXT-ITER221-01, `extension/src/bin/CLAUDE.md` ~`:351`):
`deferConvergenceOnGateRegression` (`microverse-runner.ts:1512-1529`); the interface-sweep **unmeasured** withhold
(`:1446-1458`); the interface-sweep self-introduced withhold (`:1459-1478`, `selfRedOpen`). On a pnpm monorepo a
package without the gate's script makes the typecheck sweep unmeasurable (`typecheck_unmeasurable`) every iteration,
which alone burns the three deferrals. The field session is not on this machine, so which producer fired there is a
hypothesis; the fix covers both routes. `new_failures_vs_baseline: 0` is a strict-mode literal
(`convergence-gate.ts:1988`), not a measurement.

**Order: T-SCRIPT → T-DISCLOSE → T-CAP.**

1. **T-SCRIPT (prerequisite).** `canRunTestScript` (`convergence-gate.ts:~1610-1622`) returns `true` for every non-`tests`
   check. Widen it to a script-presence check for every package-manager check: derive the script name from the command
   via `delegatedScriptName` / `PACKAGE_MANAGER_RUN_RE`, read the package's `package.json` `scripts` (the reader
   `classifyTestScriptSafety` already exists), and if the name is absent, skip the spawn → `'skipped'` (NOT unmeasured:
   `extension/src/services/CLAUDE.md:226` keeps `'skipped'` out of the unmeasured set on purpose). This removes the
   `ERR_PNPM_NO_SCRIPT` row entirely (whose `file` is an absolute `pkgDir`, which `isUnmeasuredFailure` would misread as a
   real failure) and keeps baseline capture certifiable (`project_type !== null`).
2. **T-DISCLOSE.** A new microverse-state field carries cap caveats. `pipeline-runner.ts` records disposition
   `converged_with_unmeasured:<checks>` via `appendPhaseDisposition`, following the
   `done_over_unmeasured_worker_gate_tests:` precedent (`pipeline-runner.ts:~5683-5687`): reported, NOT counted
   `nonConvergent`, no new status handling. `<checks>` = every requested cap check whose status is not `'ran'` and that
   has a configured command (so a total-deadline `break` that leaves `lint` `'skipped'` still names it —
   `convergence-gate.ts:1742-1767`). Register the field in `extension/src/types/index.ts` in this ticket.
   `GateCheckStatus` stays exactly three members.
3. **T-CAP.** In `handlePostConvergenceGateDeferral` (`microverse-runner.ts:~5724-5787`):
   `baselinePath = path.join(ctx.sessionDir,'gate','baseline.json')`;
   `mode = await pathExists(baselinePath) ? 'baseline' : 'strict'` (precedent `:833`); pass `baselinePath` ONLY in
   baseline mode (never create the file); pass `allowedPaths: currentMv.allowed_paths` (parity with capture,
   `:681-689`; widen the param with `currentMv?`, and update narrow-shape callers in the same ticket). **Do NOT pass
   `since`**: `isSelfIntroducedFailure` is file-axis (`convergence-gate.ts:316-321`), so a phase-wide `since` keeps every
   pre-existing failure in a file the phase edited → the #48 symptom. Self-introduced breaks are already caught per
   iteration (`since: preIterSha`, sticky `postConvergenceSelfRedOpen`). Strict fallback logs
   `[R-APXG-3] no baseline at <path> — strict cap gate`. When every remaining cap failure has
   `ruleOrCode === 'GATE_CHECK_TIMEOUT'`, converge and carry the T-DISCLOSE caveat. A thrown cap gate → `'converged'`,
   log the message, carry the caveat, and NEVER print the bare `convergence signal trusted — exiting cleanly` line.
   Leave the `tsc_gate_failed` / `compile_error` emission and its pin alone.
4. **Fence (research inside T-CAP, no new machinery).** Record in T-CAP's research artifact:
   `SCOPE_FENCE_ANATOMY_PATH_ACTIVE: yes|no` and `SCOPE_FENCE_BLOCKS_COMMIT: yes|no` for an out-of-allowlist target
   `package.json` edit, with the evidence command. Add a regression case in an existing `check-scope-diff` test file only
   if both are yes.

### Acceptance criteria (replace the PRD's)
Hosts (existing files only): `tests/services/convergence-gate-workspaces.test.js` (fast; T-SCRIPT),
`tests/rpgt-exit-paths.test.js` (integration, real `runGate`; T-CAP), `tests/pipeline-runner.test.js` (T-DISCLOSE).
No existing `mode: 'strict'` assertion is in scope (`rpgt-exit-paths.test.js:~308,326` pin the ABORT path;
`convergence-gate-no-disown-wiring.test.js:~1607` bounds the cap and must stay green).

- **AC-S (T-SCRIPT).** Two-package workspace fixture, only package B defines `lint`: `runGate({checks:['lint']})` spawns
  nothing in A (zero failures whose `file` is A's dir), `check_status.lint === 'ran'`, and a baseline captured over the
  fixture has `project_type !== null`. Measure the HEAD half first (expected: an absolute-path `missing pnpm script` row,
  `check_status.lint === 'failed'`); if HEAD already skips, declare `zero_diff_intent: already-satisfied`.
- **AC-1a.** Baseline F captured via the real `runGate({mode:'baseline',…})`; cap sees exactly F → `'converged'`.
  Control: `mode:'strict'` at the cap → red.
- **AC-1c.** The fixture commits an edit to F's file leaving F byte-identical → `'converged'`. Control: adding
  `since: <pre-edit sha>` → red.
- **AC-1d.** Workspace fixture with a failing OUT-of-scope package, baseline captured with `allowedPaths` →
  `'converged'`. Control: dropping `allowedPaths` at the cap → red.
- **AC-2.** F plus one new in-scope failure → `'error'` (unchanged).
- **AC-3.** Only `GATE_CHECK_TIMEOUT` rows remain after subtraction → `'converged'` and the disposition contains
  `converged_with_unmeasured:`; a total-deadline timeout during `typecheck` lists `lint` too. Timeout plus any other
  remaining failure → `'error'`. Control: replace the timeout predicate with `() => false` → the converge row reds.
- **AC-6.** No `gate/baseline.json` + red tree → `'error'`, the file is still absent afterwards, and the log contains
  `[R-APXG-3] no baseline at`. Control: pass `baselinePath` unconditionally AND force `mode: 'baseline'` → red
  (the gate then captures a baseline, so the file appears and the verdict is green). `baselinePath` alone stays
  green — `runGate` reads it only in baseline mode, so that mutation is equivalent (measured).
- **AC-7.** A throwing cap gate → `'converged'`, the log contains the error message, the disposition contains
  `converged_with_unmeasured`, and the log does NOT contain `convergence signal trusted`.
- **AC-5.** `./node_modules/.bin/tsc --noEmit` and `./node_modules/.bin/eslint src/ --max-warnings=0` exit 0; touched
  files pass via `node bin/test-runner.js <file>` (Node 22 is CI-supplied).

### Out of scope (verbatim)
(1) finalize-gate's strict, baseline-free gate on non-`converged` microverse exits (`run-finalize-gate-incomplete`):
the same pre-existing debt still yields `finalize_gate_failed:*` on `anatomy_non_convergent`, iteration-cap and budget
exits — a follow-up. (2) Per-cycle unmeasured semantics (`runChangedPerIterationGate`, the interface-sweep withhold,
the uncertifiable-baseline defer), governed by `extension/src/services/CLAUDE.md:226` and `:237`. (3) The cap re-checks
`['typecheck','lint']` only, not `tests`. (4) Convergence files other than `anatomy-park.json` (no baseline by default →
the strict fallback line is expected). (5) Repos whose baseline is uncertifiable never reach the cap (`selfRedOpen`
latch); T-SCRIPT shrinks that population. Cite catalog entries by FILE + topic: the id `AP-EXT-ITER6-01` labels five
unrelated entries.

### Residual risk (stated)
With the baseline absent, the per-iteration gate also runs strict and bumps `iteration_regressions`, so the cap still
fires and errors exactly as in #48; the fallback is correct but does not cure that population.

## Implementation Task Breakdown

| Order | ID | Title |
|---|---|---|
| 10 | 8b3ed8df | The gate never spawns a package-manager script that the package does not define |
| 20 | c308e582 | Cap caveats are carried in microverse state and reported as a converged_with_unmeasured phase disposition |
| 30 | 5941c07c | The anatomy-park deferral cap judges only failures that are new against the session baseline |
| 40 | e681e2f6 | Harden: code quality review of B-CAPGATE |
| 50 | 1f2284aa | Audit: data flow integrity for B-CAPGATE |
| 60 | b74e2a73 | Harden: test quality review of B-CAPGATE |
| 70 | 41e4ce5c | Audit: cross-reference consistency for B-CAPGATE |

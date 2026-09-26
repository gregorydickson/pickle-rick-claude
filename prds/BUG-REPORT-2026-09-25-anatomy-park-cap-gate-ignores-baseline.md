# R-APBGL — anatomy-park's deferral-cap gate ignores the baseline, so pre-existing failures block convergence

**Status:** Open (capture-only, 2026-09-25)
**Priority:** P1. On monorepo targets anatomy-park cannot converge. It exits `finalize_gate_failed:error`, and the pipeline reports 3/4 phases.
**Observed on:** loanlight-api, LOA-2425 pipeline session `2026-09-24-c13bddae`, worktree `.worktrees/loa-2425`, head `abcf214512` at the start of the phase.

## Summary

At its R-APXG-3 cap (`POST_CONVERGENCE_GATE_DEFERRAL_LIMIT=3`), anatomy-park re-runs `runGate` and refuses to converge on a RED tree. On this run, every gate cycle reported the failures as **entirely pre-existing**, yet the verdict was still `red`:

```
gate/gate_result_cycle_2026-09-25T18-46-38Z.json (and the 3 later cycles, identical)
  "status": "red",
  "baseline_used": false,
  "total_raw_failure_count": 3,
  "new_failures_vs_baseline": 0,
  "check_status": { "typecheck": "ran", "lint": "failed", "tests": "failed" }
```

The worker converged at iterations 4, 5 and 6. Each time the post-convergence gate deferred. At the cap the runner logged `re-ran gate at cap — RED tree, refusing converge` and exited `error`. Finalize-gate then failed (`exit 2`). The runner recorded `phase_dispositions: {"anatomy-park": "finalize_gate_failed:error"}`, and the pipeline finished `3/4 phases`.

All three "failures" were in the baseline captured at iteration 1, **before anatomy-park changed anything** (`gate/baseline.json`):

| check | failure | nature |
|---|---|---|
| lint | `packages/app`: `ERR_PNPM_NO_SCRIPT Missing script: lint:quiet` | the gate runs a script name the package does not define |
| lint | `GATE_CHECK_TIMEOUT: lint timed out after 60000ms` | the budget is too small for this repo; loanlight-api `lint:quiet` takes several minutes |
| tests | `GATE_CHECK_TIMEOUT: tests timed out after 300000ms` | the full loanlight-api suite is ~1,800 suites and takes well over 5 minutes |

Every iteration also logged `interface-change sweep NOT RUN (typecheck_unmeasurable)`.

## Second-order damage: the gate pressured a worker into editing product code

A pickle phase worker "fixed" the gate by adding a `lint:quiet` script to the product repo's `packages/app/package.json`, in commit `6eb4eacb5b` "chore: LOA-2425 gate — give packages/app a lint:quiet script". That change was malformed (`"lint:no-legacy-rules":"./…"`, which a later szechuan commit had to re-space) and out of the ticket's scope. The operator had to revert it before the PR. A gate that invokes a script the target does not define turns tooling gaps into product-repo churn.

## Expected behaviour

1. At the cap, a failure present in the iteration-1 baseline must not make the tree RED. `new_failures_vs_baseline: 0` must mean "no regression". Today the cap re-run appears to evaluate raw failures with `baseline_used: false`.
2. `GATE_CHECK_TIMEOUT` and `ERR_PNPM_NO_SCRIPT` are **unmeasured**, not **failed**. `unmeasured_*.md` already classifies the timeouts this way, but the cap verdict still counts them as RED. The gate should report "unmeasured" and let the phase converge under a disclosed caveat, the same as R-ISSC-style short-circuits, rather than exit `error`.
3. The per-package lint script should be resolved per package. It should never invoke a script the package does not define. At minimum, skip packages without it and record them as unmeasured.

## Where to look (unverified pointers, not a diagnosis)

- `extension/src/bin/microverse-runner.ts`: the R-APXG-3 cap re-run (`re-ran gate at cap`) and the `baseline_used` plumbing near `:876`.
- `extension/src/services/convergence-gate.ts`: `GATE_CHECK_TIMEOUT` construction (`:29`), and the result shape that returns `baseline_used: false` (`:1331`).
- `extension/src/bin/mux-runner.ts:7761`: another `baseline_used: false` producer.

## Repro

1. Run a `/pickle-pipeline` whose target is a pnpm monorepo in which one package lacks the gate's lint script, and whose full test suite exceeds 300 s (e.g. loanlight-api).
2. Let anatomy-park's worker signal convergence three times.
3. Observe `gate_result_cycle_*.json` with `new_failures_vs_baseline: 0` and `status: red`, followed by `finalize_gate_failed:error`.

Session artifacts: `~/.local/share/pickle-rick/sessions/2026-09-24-c13bddae/{microverse-runner.log,pipeline-runner.log,gate/}`.

## Acceptance criteria

- **AC1.** Given a baseline whose failures equal the cap re-run's failures (`new_failures_vs_baseline: 0`), the cap verdict is not RED and the phase converges. Integration test: seed `gate/baseline.json` with the failures above, stub the gate result to match, and assert the disposition is not `finalize_gate_failed:*`.
- **AC2.** A cycle whose only non-green checks are `GATE_CHECK_TIMEOUT` / `ERR_PNPM_NO_SCRIPT` records them as unmeasured, and the pipeline status surfaces the caveat. Test: assert the `check_status` value is `unmeasured` (not `failed`) and that the phase disposition carries the caveat.
- **AC3.** Mutation: re-introducing the raw-failure RED check at the cap turns AC1's test red.
- **AC4.** The gate never runs a package script the package's `package.json` does not define. Test with a two-package fixture where one package lacks the script: the gate does not error on that package.
- **AC5 (guard against the second-order damage).** A pickle worker prompt or scope fence forbids adding gate-appeasement scripts to target-repo manifests that the ticket's `Files to modify` does not list. Test: a scope-fence case where a `package.json` edit outside the allowlist is a SCOPE_VIOLATION.

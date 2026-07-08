# BUG-REPORT 2026-07-08 — worker-gate verifies with a single flaky `npm run test:fast`, so a flake false-reds a GREEN bundle and R-CWGE fail-closes fatal

**Severity:** P2 (reliability — false-negative that fatally stops a green pipeline; not a correctness/data-loss bug)
**Surfaced:** babysitting the R-LTNC codex soak (session `2026-07-08-b89bb506`), 2026-07-08.
**Class:** flake → fail-closed false-fatal. Adjacent to R-CIFB (test:fast c=8 timeout-flake), R-CWGE (worker-gate fail-closed), R-CXHANG/R-SLEAK (codex orphan resource contention amplifier).

## Symptom
The R-LTNC bundle built cleanly on codex: ticket 9bdcecd5 (225-file rename + hermetic backfill test) committed and flipped **Done**; the pipeline advanced to 17599066. Then the **between-ticket gate** re-verified 9bdcecd5 and fatal-stopped the whole pipeline at **0/4 phases**:

```
[fatal] ticket 9bdcecd5 cannot flip Done: worker_gate_verdict='red'
        (computed_via=between_ticket_gate). Done requires a GREEN worker-gate
        verdict (eslint+tsc+test:fast); a red or absent/unverifiable verdict is
        fail-closed (R-CWGE).
Phase pickle exited (exit_reason=done_without_commit_evidence); 2/3 tickets remain.
```

**But the tree was GREEN.** Post-hoc, on the exact committed tree: `tsc --noEmit` PASS, `eslint src/` PASS, `test:fast:budget` **5/5 runs, 0 failures**, `audit-ticket-bundle-backfill` ≥12-pin ✔, real-Linear preserve-list intact. The "red" was a **flake**, not a real failure.

## Root cause
The between-ticket gate computes its verdict with a **single raw run**:

- `mux-runner.ts:638` — `spawnSync('npm', ['run', 'test:fast'], …)` (one run), with a `between_ticket_gate_timeout` fallback (`:691`).
- `recomputeAbsentWorkerGateVerdict` (`mux-runner.ts:4593–4595`) recomputes an absent verdict over "the full eslint+tsc+**test:fast** contract" — again a single run.

`test:fast` is **timeout-shaped flaky at c=8** (documented: R-CIFB; the operator rule is "re-run at c=4 for authoritative green"). The worker itself reported it *"did not yield a trustworthy terminal result"* for the fast suite during the run. Under **codex**, resource contention from orphan `codex app-server` processes (one 2 days old; R-CXHANG/R-SLEAK) amplified the timeout-flakiness.

R-CWGE (correctly) treats a **red OR absent/unverifiable** verdict as fail-closed. That fail-closed policy is load-bearing and correct — the defect is **its input**: the gate's verdict is only as reliable as a single flaky `test:fast` run, while the **release gate** already computes an authoritative flake-resistant signal via `test:fast:budget` / `check-flake-budget.js` (5 runs, tolerate ≤budget failures). A single-run gate turns a c=8 flake into a **false red → fatal 0/4 on a green bundle.**

## Fix (reuse-first — do NOT add a retry-guard around R-CWGE)
Make the between-ticket gate and `recomputeAbsentWorkerGateVerdict` verify `test:fast` through the **same flake-resistant signal the release gate already uses** (`check-flake-budget.js` / `test:fast:budget`), instead of one raw `npm run test:fast`. R-CWGE stays fail-**closed** (unchanged); only its **input** becomes reliable.

Two candidate shapes (scope in the PRD — pick the cheaper that removes the flake):
1. **Lower concurrency**: run the gate's `test:fast` at **c=4** (the known non-flaky concurrency) rather than the default c=8 — a config change, no new machinery, removes the timeout-flake at the source. Cheapest.
2. **Budget signal**: consult `check-flake-budget.js` for the verdict. More robust but ~5× the test time per ticket boundary — likely too expensive to run at every gate; prefer (1), reserve (2) for a single bounded re-verify on a first red.

**Contributing cause (separate, already-known):** reap orphan `codex app-server` processes — the R-CXHANG reaper (beta.37) keys on `--add-dir` under the sessions root and does NOT catch `codex app-server` procs, which accumulate and starve the machine (R-SLEAK). Widen the reaper's ownership signal or add an age-based `codex app-server` sweep.

## Simplification Review (subtract-before-add)
1. **Necessary?** No new guard/flag/state field. It **changes the gate's existing `spawnSync('npm run test:fast')` call** to a lower-concurrency / flake-budget invocation. Net-neutral-to-subtractive.
2. **Reuse?** Yes — reuse `check-flake-budget.js` / the c=4 concurrency the release gate already relies on. No parallel mechanism.
3. **Guards existing brittle complexity?** It **removes** brittleness (a flaky single-run verdict), it does not guard it. Explicitly NOT adding a retry-hatch around R-CWGE (that would be guards-on-guards).
4. **Subtracts?** Removes a false-red failure class — a green bundle can no longer be fatally stopped by one c=8 test:fast flake.

## Evidence / repro
- Session `2026-07-08-b89bb506`: `mux-runner.log` (`[fatal] … worker_gate_verdict='red' (computed_via=between_ticket_gate)`), `pipeline-runner.log` (`Pipeline finished: 0/4 phases`).
- Green proof on the same committed tree (commits `2028aeb0`/`88a49eea`/`98b3df84`/`598e1a74`): `babysit-fast.log` (`flake-budget OK failures=0 … runs_completed=5`), `babysit-backfill.log` (`✔ … ≥12 findings`).
- Source: `mux-runner.ts:638` (single `spawnSync npm run test:fast`), `:4593–4595` (`recomputeAbsentWorkerGateVerdict`).

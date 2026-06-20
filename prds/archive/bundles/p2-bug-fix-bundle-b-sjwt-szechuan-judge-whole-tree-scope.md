---
title: P2 — szechuan-sauce LLM judge scores the whole TARGET tree, not scope.json:allowed_paths (B-SJWT)
status: Ready
filed: 2026-06-04
priority: P2
type: bug-bundle
finding: 95
code: R-SJWT
composes:
  - "#95 R-SJWT"
distinct_from:
  - "#47 R-SJET (judge spawn-mechanism hang — async/stdin/env; ALREADY SHIPPED, verify-first confirmed at HEAD v1.97.0). R-SJWT is the orthogonal scope/size axis: the spawn is fine, but the judge is asked to score too much."
---

# B-SJWT — Scope the szechuan judge to allowed_paths

## Trigger

Scoped `/szechuan-sauce` runs (e.g. the HS-SWEEP, 2026-06-03) repeatedly hit `exit_reason: judge_timeout`. Verify-first ruled out the (already-shipped) R-SJET spawn-hang: the judge spawn is async with stdin closed. The real cause is that the LLM-judge metric scores the **entire** TARGET tree.

`TARGET` must be `extension/` (the project root) so the convergence gate can detect the project type and write a real regression-guard baseline — a narrower target writes a 2ms empty baseline. So even a tightly-scoped szechuan run (`scope.json:allowed_paths` = a handful of files) asks the judge to read the whole repo each scoring call.

Two consequences:
- **(a) Timeout.** Default `key_metric.timeout_seconds: 300` (`DEFAULT_METRIC` in `init-microverse.ts`) is insufficient for whole-tree scoring on a large repo. The judge times out after 4 backoff attempts and aborts the run. HS-3 szechuan died at iter-3 scoring (3 fixes salvaged); HS-4 died at **baseline** with 0 iterations (1 fix salvaged during gap-analysis).
- **(b) Score inflation.** Whole-tree scoring counts out-of-scope violations the scope-locked worker cannot fix (e.g. the HS-5 judge flagged `transaction-ticket-ops.ts safeErrorMessage`, out of HS-5 scope), inflating the score so it never reaches the convergence target 0 — the run converges only via a worker "clean pass", and plateaus (HS-12 held at 8 for 4 iterations).

**Proven interim workaround (do not regress):** passing `--metric-json` with `timeout_seconds: 600` cleared the baseline timeout — HS-5..14 szechuan all converged with it.

## Root cause

`buildJudgePrompt` / `measureLlmMetricAttempt` in `microverse-runner.ts` instruct the judge to score `Target path: <TARGET>` (= `extension/`). The judge metric carries no knowledge of `scope.json:allowed_paths`, so for a scoped run the scoring surface is the whole project, not the files the worker may touch.

## Acceptance criteria (machine-checkable)

**R-SJWT-1 — judge scores allowed_paths when a scope file is present.**
- When `microverse.json` has a non-empty `allowed_paths` (scoped run), the judge prompt built by `buildJudgePrompt` MUST instruct the judge to review ONLY those paths (enumerated), not the whole TARGET tree. When `allowed_paths` is empty/absent (unscoped run), behavior is unchanged (whole-target scoring).
- AC: a unit test asserts the built prompt for a scoped microverse state contains each `allowed_paths` entry and does NOT contain the bare "review the code at the target path" whole-tree instruction; the unscoped state still produces the whole-tree instruction.

**R-SJWT-2 — raise the szechuan default judge timeout.**
- `DEFAULT_METRIC.timeout_seconds` (the LLM szechuan metric default in `init-microverse.ts`) MUST be raised from 300 to 600 so unscoped/large-tree scoring does not abort on the first slow judge call. (Belt-and-suspenders with R-SJWT-1; harmless when scoping reduces the surface.)
- AC: `init-microverse.test.js` asserts `DEFAULT_METRIC.timeout_seconds === 600`; existing `judge_model`-absence invariant (SCJM-T5) preserved.

**R-SJWT-3 — convergence-to-0 reachable for scoped runs.**
- With R-SJWT-1, a scoped szechuan run's score reflects only in-scope violations, so a run that fixes all in-scope violations reaches 0 (not a plateau on out-of-scope dupes).
- AC: a regression test (mocked judge) drives a scoped run where the only remaining violations are out-of-scope and asserts the in-scope score path is what the convergence comparison uses.

**R-SJWT-TD — trap door.**
- `microverse-runner.ts` (or `init-microverse.ts`): pin the invariant "scoped microverse runs (`allowed_paths` non-empty) build the judge prompt over `allowed_paths`, never the whole TARGET" in the relevant subsystem `CLAUDE.md`, ENFORCEd by the R-SJWT-1 test, with a `PATTERN_SHAPE`.

## Ticket classes

- **R-SJWT-1** (tier: medium) — scope the judge prompt to `allowed_paths` in `buildJudgePrompt`/`measureLlmMetricAttempt`; preserve whole-tree behavior when unscoped. +unit test.
- **R-SJWT-2** (tier: small) — raise `DEFAULT_METRIC.timeout_seconds` 300→600; update `init-microverse.test.js`.
- **R-SJWT-3** (tier: small) — convergence-to-0 regression test for scoped runs + R-SJWT-TD trap door.
- **C-SJWT-CLOSER** (tier: small, owner: manager) — recompile `.ts`→`.js` parity, full gate, version bump (MINOR — changes the szechuan judge metric default + scoping behavior), install.sh, push, gh release.

## Notes

- Distinct from #47 R-SJET (spawn-mechanism, shipped). R-SJWT is scope/size only — do NOT touch the async spawn / stdin / env path (R-SJET-1a trap door).
- The judge always spawns via claude (SCJM-T5 / R-SCJM-5 trap doors) — do not regress that.
- Schema-neutral (no state schema change).

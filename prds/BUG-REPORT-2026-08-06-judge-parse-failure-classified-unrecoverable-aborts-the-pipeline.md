# BUG REPORT 2026-08-06 — R-JUNS: an unparseable judge answer is classified *unrecoverable* and aborts the pipeline

**Priority:** P1 — killed a 590-minute run at the last phase
**Found:** B-OFFREPO session `2026-08-04-183319b4`, szechuan-sauce phase, 2026-08-06T00:58:17Z.
**Status:** open, unfixed. All 5 tickets Done; no work lost.

## What happened

```
ERROR: Metric measurement failed (baseline_unmeasurable_unrecoverable) after 4 attempt(s):
       judge output did not contain a numeric score
microverse-runner finished. 10 iterations, 211m 57s, exit: baseline_unmeasurable_unrecoverable
Phase szechuan-sauce: microverse exited with baseline_unmeasurable_unrecoverable
       — pipeline aborting (no finalize-gate)
Pipeline finished: 2/4 phases, 590m 40s
```

The LLM judge returned output containing **no number**. That is a *formatting* failure by a
re-promptable model. The run ended.

## The classification path — a prose answer is "unrecoverable"

1. `extractScore(output)` returns `null` → `{ failureKind: 'failed', message: 'judge output did not
   contain a numeric score' }` — `extension/src/bin/microverse-runner.ts:2303`.
2. `'failed'` matches no case in the classifier and falls to **`default:` →
   `'baseline_unmeasurable_unrecoverable'`** (`:3005`, and again at `:3025`).
3. `baseline_unmeasurable_unrecoverable` ∈ `MICROVERSE_FATAL_REASONS`
   (`extension/src/types/index.ts:1296-1300`).
4. Fatal ⇒ `pipeline-runner.ts:4049` aborts **without running the finalize-gate**.

**The asymmetry is the defect.** Timeouts and rate-limits are explicitly routed to `judge_timeout` /
`baseline_unmeasurable_transient` — the recoverable classes. A malformed-but-present answer, which is
the *most* obviously retryable failure an LLM produces, gets the harshest classification available,
purely because it lands on `default:`.

## Directive-2 tension

`baseline_unmeasurable_unrecoverable` is **not** in [[B-NOSTOP-GATES]]' sanctioned halt set
(`!start_commit`, unreadable state, `state_schema_version_ahead`, `state_working_dir_missing`,
`toolchain_unavailable`, budget/iteration cap, operator cancel, `--strict-phases`). It is a
**measurement** failure, not a crash floor.

Per the binding operator directives — *"a quality GATE that STOPS the system takes quality to ZERO"*
and *"an imperfect-but-completed run is a success"* — a phase that cannot measure its metric should
**park, flag, and let the pipeline finish**. Here it aborted and skipped the finalize-gate, so the
phase's own work was never gate-verified.

Note the microverse loop genuinely cannot *converge* without a baseline — that is real. But
"this phase cannot converge" and "this pipeline must stop" are different dispositions, which is
precisely the distinction B-NOSTOP-GATES drew: **honesty is a REPORTING property, halting is a
DISPOSITION, and they are not the same wire.**

## Nothing announced it

R-JPCM WS-2 shipped `emitJudgeParseDiagnostic` on the thesis that *"a dead ledger must be loud."*
Grepping this session's `microverse-runner.log` for judge-parse / dead-ledger / legacy-fallback
diagnostics returns **0**. The only trace is a `process.stderr.write` line. The alarm built for
judge-parse trouble did not sound for the judge-parse failure that killed the run.

## Candidate fix — subtractive, two independent halves

1. **Reclassify.** A parse failure is by definition retryable — route `'failed'` to
   `baseline_unmeasurable_transient` rather than letting it fall through `default:` to
   *unrecoverable*. Prefer an explicit case over widening the default.
2. **Remove `baseline_unmeasurable_unrecoverable` from `MICROVERSE_FATAL_REASONS`.** A metric that
   cannot be measured should end the *phase* honestly (`stalled_below_target` already exists as the
   honest non-convergent disposition) and let the pipeline run its finalize-gate.

⛔ Do **not** add retry budget on top of the existing 4 attempts — the attempts are not the problem;
the classification of their outcome is.

## Related

Same session, same family: [[R-EROS]] (a roster misdescription stamped `recovery_exhausted`) and
[[R-ISSC]] (a gate that hides half its surface when it fails). All three are the measurement layer
mis-reporting, not the code under test.

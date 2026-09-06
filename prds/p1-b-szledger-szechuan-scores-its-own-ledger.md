# B-SZLEDGER — the first redesign: split szechuan's generator from its loop

---
title: "B-SZLEDGER — szechuan scores a list it already holds; delete the measurement, keep the discovery"
status: draft
priority: P1
type: redesign-bundle
composes: [B-CLIBRITTLE-scoring-path, B-JUDGETO, github-7, szechuan-baseline-unmeasurable]
---

## Why szechuan is the right first part

It is **0-for-2** — it has produced nothing in this session's two completed bundles, so this redesign
**cannot regress it**. It carries the most machinery of any phase. And its own source already states the
invariant that makes the redesign provable rather than speculative.

## The finding — the score is a tautology

`microverse-runner.ts:1999`, in the judge prompt contract:

> *"For a count-type metric `score` MUST equal `violations.length`"*

So the system spawns an LLM, asks it to score a tree, and then **requires the returned score to equal
the length of the violation list returned in the same response** — a value it already holds. A
`basis=ledger_count` classification already exists (`:4332`) alongside `basis=set_ops`. The measurement
apparatus computes, expensively and unreliably, a number the ledger defines.

**Discovery is real and stays. Scoring is derived and goes.**

## What this deletes, and what it fixes for free

Removing the judge from the SCORING path removes the entire failure surface that has broken szechuan:

- `baseline_unmeasurable_unrecoverable` becomes **unreachable for count-type metrics** — a baseline is
  the length of a list we hold, so it cannot time out, cannot be rejected by a CLI config validator, and
  cannot exhaust 4 attempts at 600s.
- It removes the ambient-CLI coupling ([[B-CLIBRITTLE]]) *on this path*. The 2026-09-04 CLI upgrade
  2.1.252 → 2.1.260 disabled szechuan for five days precisely here.
- It removes the 600s budget ([[B-JUDGETO]]) from the baseline path entirely, rather than resizing it.
- GitHub **#7** ("the worker never works the ledger the metric scores") dissolves: with one ledger there
  is no second thing to score.

Candidate deletions on the scoring path (`microverse-runner.ts`, 5,864 lines):
`measureLlmMetric` `:2278` · `measureLlmMetricWithBackoff` `:3321` · `probeJudgeBackendAvailability`
`:2900` · `classifyJudgeError` `:2379` · the baseline retry/backoff ladder.
`buildJudgePrompt` `:1941` and `parseLlmJudgeOutput` `:2241` **stay** — they serve discovery.

## Acceptance criteria (machine-checkable)

- **AC-1 Verify the invariant in REAL data before relying on it.** Across every recorded session with a
  judge result, assert `score === violations.length`. State the sample size and any exception. **If it
  does not hold universally, STOP and report** — the redesign's premise is that it does.
- **AC-2** A count-type metric's score is computed from the ledger with **no subprocess on the scoring
  path**. Mutation-verify: reintroducing a spawn reddens.
- **AC-3** `baseline_unmeasurable_*` is unreachable for count-type metrics. Enumerate the paths that
  could still produce it and show each is gone or does not apply. Negative control: a non-count metric,
  if any survives, still measures as before.
- **AC-4** The judge still DISCOVERS. A run must produce violations from the lens and append them to the
  ledger; deleting the discovery spawn must redden a test. This is the AC that stops the redesign from
  turning szechuan into a no-op that trivially "converges" at zero.
- **AC-5** Net LOC in `microverse-runner.ts` goes **DOWN**, stated as a number. This is the grade.
- **AC-6** No new abort condition; `MICROVERSE_FATAL_REASONS` stays at one member.
- **AC-7** Closer: szechuan **measures a baseline and reaches iteration 1 on a live phase run** — the
  thing it has not done since 2026-09-01 — plus the full release gate with a genuinely-run soak.

## Non-goals

- Do NOT delete the judge. Discovery is the 139 commits szechuan has produced; only the metric goes.
- Do NOT raise or retune `timeout_seconds`. The path it guards is being removed.
- Do NOT touch anatomy-park's loop in this bundle. It works (423 commits, converged 2/2). One part first.

## Ticket classes

1. AC-1 invariant verification against the live corpus (evidence; gates everything after it).
2. AC-2 + AC-3 ledger-derived scoring and the unreachability proof.
3. AC-4 discovery-path pin and its negative control.
4. AC-5 deletion sweep + LOC accounting.
5. Closer: live szechuan run + gate.

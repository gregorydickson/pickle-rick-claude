---
title: "Codegraph A/B Efficacy Protocol — CGH-3 Post-Install Operator Run"
date: 2026-06-14
ticket: 934a72b3
bundle: B-CGH
verdict: PROTOCOL
---

# Codegraph A/B Efficacy Protocol

> **Purpose**: Measure whether the `## Code Graph Context` injection (CGH-3) improves worker output quality across the 5-ticket cross-file corpus. Run once after the first production deploy with `codegraph.enabled: true`. Record the delta in `## Results` below.

---

## Numbered Procedure

1. **Confirm the deployed runtime has codegraph enabled.** Run `node ~/.claude/pickle-rick/extension/bin/codegraph-efficacy-probe.js` — expect `codegraph-efficacy-probe: loaded 5 corpus ticket(s), reps=1`. A non-zero exit means the corpus dir is missing or malformed; fix before proceeding.

2. **Capture the WITHOUT baseline.** Temporarily set `PICKLE_CODEGRAPH=off` in the shell, then run the probe in dry-run mode (`--reps 0` is intentionally unsupported — instead, run a controlled single-worker pass over each corpus ticket with a fixed seed prompt that omits the `## Code Graph Context` section). Record the resulting diff for each ticket as `baseline/without/<ticket>/worker.diff`.

3. **Capture the WITH measurement.** Unset `PICKLE_CODEGRAPH=off` (so `codegraph.enabled: true` is in effect), run the same single-worker pass for each corpus ticket — this time the `## Code Graph Context` section IS injected. Record each diff as `baseline/with/<ticket>/worker.diff`.

4. **Score each diff pair.** For each ticket, run the probe's deterministic scorers over the two diffs:
   - `hallucinatedRefCount(diff, REPO_ROOT)` via `check-readiness.ts:countUnresolvedReferences` — counts backtick paths that fail the resolver
   - `consumerFileJaccard(diffTouchedFiles(diff), expectedConsumerFiles)` — Jaccard overlap against the fixture's oracle
   - Record `gate_pass` (worker conformance gate: `runWorkerGate(...).ok`) for each run
   Record one `codegraph_efficacy_sample` activity event per (ticket, with/without) pair via `log-activity.js`.

5. **Aggregate substrate metrics.** From the two sessions (WITH vs. WITHOUT), pull the named substrate metrics from `state.json.activity` and `pickle-metrics` output:
   - `path_not_verified` event count (activity events emitted by `check-readiness.ts`)
   - no-progress event count (activity events emitted by `mux-runner.ts` on no-advance iterations)
   - tokens: total input+output tokens (from `pickle-metrics` aggregation, `metrics.ts`/`metrics-utils.ts`)
   - wall-clock: total session wall time in seconds (from `pickle-metrics` timing fields)
   - citadel finding count: count of findings from the citadel runner in each session
   - anatomy-park finding count: count of findings from the anatomy-park runner in each session
   - sibling-test-drift count: count of sibling-test-drift instances from closer audit logs

6. **Record the signed delta** (`WITH − WITHOUT`) for each metric in the `## Results` table below. A negative delta for `path_not_verified`, no-progress, and finding counts is the improvement signal; a positive delta for `consumerFileJaccard` and `gate_pass` rate is the improvement signal.

7. **Decision gate.** If the aggregate Jaccard delta ≤ 0 AND the `path_not_verified` delta ≥ 0 across the corpus, revert `codegraph.enabled` to `false` (the efficacy safety net from the B-CGH post-install plan). Otherwise, leave enabled and document the result as the official baseline.

---

## Results

> Fill in this table after the post-install operator run (Step 6 above). One row per substrate metric. Baseline = WITHOUT-codegraph value. Measurement = WITH-codegraph value. Delta = Measurement − Baseline (negative = fewer events/tokens = improvement for most metrics).

| Metric | Source | Baseline (WITHOUT) | Measurement (WITH) | Delta | Signal direction |
|---|---|---|---|---|---|
| `path_not_verified` count | `check-readiness.ts` activity event | — | — | — | negative = improvement |
| no-progress count | `mux-runner.ts` activity event | — | — | — | negative = improvement |
| tokens (total input+output) | `pickle-metrics` (`metrics.ts`/`metrics-utils.ts`) | — | — | — | negative = improvement |
| wall-clock (seconds) | `pickle-metrics` timing fields | — | — | — | negative = improvement |
| citadel finding count | anatomy-park citadel runner output | — | — | — | negative = improvement |
| anatomy-park finding count | anatomy-park runner output | — | — | — | negative = improvement |
| sibling-test-drift count | closer audit logs | — | — | — | negative = improvement |

---

## Corpus Reference

| Fixture | Cross-file pair | `expected_consumer_files` |
|---|---|---|
| `corpus-01` | `codegraph-service.ts` ↔ `setup.ts` | setup.ts imports CodegraphService at line 17 |
| `corpus-02` | `convergence-gate.ts` ↔ `microverse-runner.ts` | microverse-runner.ts imports runGate at line 72 |
| `corpus-03` | `types/index.ts` ↔ `state-manager.ts` | state-manager.ts consumes StateErrorCode from types |
| `corpus-04` | `spawn-morty.ts` ↔ `backend-spawn.ts` | spawn-morty.ts invokes backend-spawn helpers |
| `corpus-05` | `metrics.ts` ↔ `metrics-utils.ts` | metrics.ts imports aggregation helpers from utils |

---

## Notes

- This protocol is consumed by the CGH-3a probe (`extension/bin/codegraph-efficacy-probe.js`) and by the post-install operator runbook.
- No pruned-session artifacts are referenced — the corpus is entirely self-contained under `extension/tests/fixtures/codegraph-efficacy/`.
- The baseline MUST be recorded before the first production session under `codegraph.enabled: true`; retro-fitting from contaminated logs is invalid.

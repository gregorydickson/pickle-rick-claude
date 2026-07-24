# Worker-Gate True-Positive Rate (WS-A3b, report-only)

Report-only measurement per `prds/p1-b-gtruth-ground-truth-over-proxies-and-codegraph-enablement.md` §WS-A3b.
This artifact records a number and a pre-declared threshold; it does **not** decide whether to repair, retire, or
otherwise change the worker gate — that is an explicit follow-on decision (see "Not in scope").

## Fixture

Path: `extension/tests/fixtures/worker-gate-tp-rate/labelled-gate-verdicts.json`

16 hand-labelled records, checked in. **No record was read from or derived from
`~/.local/share/pickle-rick/sessions` or any other mutable runtime/session directory** — every field below is
authored directly in the fixture, so the computation in this report is 100% reproducible from that one file.

## Method

**Derived verdict rule** (mirrors `computeWorkerGateVerdict()` in `extension/src/bin/spawn-morty.ts`, the
persisted-verdict logic as of R-WGFR/WS-A3a — eslint+tsc only, `test:fast` dropped as flaky):

```
verdict = 'red'   if (!lint_ok || !tsc_ok)
verdict = 'green' otherwise
```

**Ground truth** (`ground_truth_defect`) is labelled independently of the tool outcome: `true` only for a
behavior-affecting defect — the change would have produced a wrong runtime result, a crash, or otherwise
misbehaved if shipped as-is. `false` covers both a cosmetic/stylistic tool trip with no behavioral effect, and a
genuinely clean change.

Confusion-matrix terms (positive = `ground_truth_defect`):

| Term | Condition |
|---|---|
| TP | verdict=red AND ground_truth_defect=true |
| FP | verdict=red AND ground_truth_defect=false |
| TN | verdict=green AND ground_truth_defect=false |
| FN | verdict=green AND ground_truth_defect=true |

**TP-rate (sensitivity)** = TP / (TP + FN) — the fraction of real defects that reach the gate which the gate
actually flags red.

## Pre-declared repair-vs-retire threshold

*(stated here, before the result, per WS-A3b's acceptance criteria)*

- **TP-rate ≥ 0.60 → REPAIR.** The gate catches most real defects that reach it; keep it blocking and invest in
  closing the remaining false-negative gap.
- **TP-rate < 0.60 → RETIRE-AS-BLOCKING.** False negatives dominate — the gate misses most real defects that reach
  it, so blocking exclusively on it is low-value. Candidate for demotion to advisory, or for supplementing with a
  different check class.

This bound is fixed before the number below is computed, and it is a candidate signal for a follow-on decision —
not an instruction this ticket acts on.

## Result

Counted directly from the 16-record fixture:

| | ground_truth_defect=true | ground_truth_defect=false |
|---|---|---|
| **verdict=red** | TP = 4 | FP = 4 |
| **verdict=green** | FN = 4 | TN = 4 |

- **TP-rate (sensitivity) = TP / (TP + FN) = 4 / (4 + 4) = 0.50**
- Precision (context only, not the gated metric) = TP / (TP + FP) = 4 / (4 + 4) = 0.50

Per the pre-declared threshold, **0.50 < 0.60 → RETIRE-AS-BLOCKING band.** This report states that fact only. The
number is reported regardless of which side of the threshold it falls on, per WS-A3b's acceptance criteria.

## Reproduction

Every field needed to reproduce the counts above lives in the fixture. Example manual check with `jq`:

```
jq '[.records[] | select((.lint_ok==false or .tsc_ok==false) and .ground_truth_defect==true)] | length' \
  extension/tests/fixtures/worker-gate-tp-rate/labelled-gate-verdicts.json
# => 4 (TP)
```

Swap the two boolean conditions to recover FP/TN/FN. No helper script is required for a 16-record fixture; the
`_meta` block documents the exact derivation and labelling rules used.

## Not in scope

- Repairing, retiring, or otherwise changing worker-gate behavior based on this number — a follow-on decision.
- Reading `~/.local/share/pickle-rick/sessions` or any other mutable runtime state.
- Expanding the fixture to reflect real historical session data (it is a labelled reference dataset, not a replay
  of live sessions — see the mutable-state prohibition above).

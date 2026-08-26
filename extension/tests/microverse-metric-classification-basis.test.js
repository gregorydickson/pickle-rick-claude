// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareMetric,
  compareMetricWithBasis,
  createMicroverseState,
  recordIteration,
} from '../services/microverse-state.js';
import { formatMetricComparisonFigures } from '../bin/microverse-runner.js';

const BASE_OPTS = {
  prdPath: '/tmp/test.md',
  metric: {
    description: 'violations',
    validation: 'true',
    type: 'llm',
    timeout_seconds: 30,
    tolerance: 0,
    direction: 'lower',
  },
  stallLimit: 50,
};

function historyEntry(iteration, score, classification) {
  return {
    iteration,
    metric_value: String(score),
    score,
    action: classification === 'regressed' ? 'revert' : 'accept',
    description: `${classification}: ${score}`,
    pre_iteration_sha: '',
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// AC-V1 — case 1: 36 -> 33 at tolerance 0, direction 'lower' must not classify 'held'.
// Ledger: 2 resolved, 1 new (net reduction), the new id overlaps a remaining id ("sets intersected"
// — the B-CGSHIP shape). The old compareMetricSetOps read the overlap as disqualifying and returned
// 'held'; the fix drops that overlap from the decision and classifies purely on the net count delta.
// ---------------------------------------------------------------------------

test('AC-V1 case 1: 36->33 net reduction with id overlap noise classifies improved, not held', () => {
  const current = { resolved: ['v1', 'v2'], new: ['v3'], remaining: ['v3', 'v4'] };
  const previous = { resolved: [], new: ['v1', 'v2', 'v3', 'v4'], remaining: [] };
  const result = compareMetric(33, 36, 0, 'lower', current, previous);
  assert.notEqual(result, 'held', 'a net reduction must not classify held even with id overlap noise');
  assert.equal(result, 'improved');
});

// ---------------------------------------------------------------------------
// AC-V1 — case 2: 1 -> 1 at tolerance 0 must not classify 'improved'.
// Ledger: 1 resolved, 1 new (lateral wash, net-zero) — the beta.16 shape. The old predicate only
// checked `resolvedSet.size > 0 && intersectionSize === 0` and never compared resolved to new counts
// for equality, so it read this as 'improved'. The fix requires strict inequality.
// ---------------------------------------------------------------------------

test('AC-V1 case 2: 1->1 lateral wash (equal resolved/new counts) classifies held, not improved', () => {
  const current = { resolved: ['v1'], new: ['v2'], remaining: ['v3'] };
  const previous = { resolved: [], new: ['v1', 'v3'], remaining: [] };
  const result = compareMetric(1, 1, 0, 'lower', current, previous);
  assert.notEqual(result, 'improved', 'a lateral wash must not classify improved');
  assert.equal(result, 'held');
});

// ---------------------------------------------------------------------------
// AC-V1 — case 3: the printed figures match the deciding comparator's basis. A set-ops decision must
// never carry a `previous=` figure (the numeric framing), since that decision did not consult
// tolerance/previous-score comparison at all.
// ---------------------------------------------------------------------------

test('AC-V1 case 3: a set-ops decision reports set-ops figures, never a contradicting previous=', () => {
  const current = { resolved: ['v1', 'v2'], new: ['v3'], remaining: ['v3', 'v4'] };
  const previous = { resolved: [], new: ['v1', 'v2', 'v3', 'v4'], remaining: [] };
  const comparison = compareMetricWithBasis(33, 36, 0, 'lower', current, previous);
  assert.equal(comparison.classification, 'improved');
  assert.equal(comparison.figures.basis, 'set_ops');
  assert.ok(!('previous' in comparison.figures), 'set-ops figures must not carry a previous score');
  assert.ok(!('tolerance' in comparison.figures), 'set-ops figures must not carry a tolerance');

  const line = formatMetricComparisonFigures(comparison.figures);
  assert.doesNotMatch(line, /previous=/, 'the printed line must not print a contradicting previous=<score>');
  assert.match(line, /basis=set_ops/);
});

test('AC-V1 case 3 (numeric control): a numeric decision keeps the previous=/tolerance= framing', () => {
  const comparison = compareMetricWithBasis(5, 10, 1, 'lower');
  assert.equal(comparison.classification, 'improved');
  assert.equal(comparison.figures.basis, 'numeric');
  const line = formatMetricComparisonFigures(comparison.figures);
  assert.match(line, /previous=10/);
  assert.match(line, /tolerance=1/);
});

// ---------------------------------------------------------------------------
// AC-V2 — reproduce the 36 · 36 · 36 · 33 · 33 sequence through recordIteration and assert the stall
// counter RESETS at the 36 -> 33 step instead of climbing to 5 / parking.
// ---------------------------------------------------------------------------

const AC_V2_STEPS = [
  // [score, ledger-vs-previous shape, expectedClassification]
  { score: 36, current: { resolved: [], new: [], remaining: ['a', 'b'] }, previous: { resolved: [], new: ['a', 'b'], remaining: [] } },
  { score: 36, current: { resolved: [], new: [], remaining: ['a', 'b'] }, previous: { resolved: [], new: [], remaining: ['a', 'b'] } },
  { score: 36, current: { resolved: [], new: [], remaining: ['a', 'b'] }, previous: { resolved: [], new: [], remaining: ['a', 'b'] } },
  // 36 -> 33: net reduction with the same id-overlap-noise shape as AC-V1 case 1.
  { score: 33, current: { resolved: ['a', 'b'], new: ['c'], remaining: ['c', 'd'] }, previous: { resolved: [], new: ['a', 'b', 'c', 'd'], remaining: [] } },
  // 33 -> 33: lateral wash, same shape as AC-V1 case 2.
  { score: 33, current: { resolved: ['c'], new: ['e'], remaining: ['d'] }, previous: { resolved: [], new: ['c', 'd'], remaining: [] } },
];

test('AC-V2: 36*36*36*33*33 resets the stall counter on the genuine improvement instead of reaching 5', () => {
  let state = createMicroverseState(BASE_OPTS);
  let previousScore = state.baseline_score;
  const stallCounterAfterStep = [];

  for (const [i, step] of AC_V2_STEPS.entries()) {
    const classification = compareMetric(step.score, previousScore, 0, 'lower', step.current, step.previous);
    const entry = historyEntry(i + 1, step.score, classification);
    state = recordIteration(state, entry, classification);
    stallCounterAfterStep.push(state.convergence.stall_counter);
    if (classification !== 'regressed') { previousScore = step.score; }
  }

  // Steps 1-3 (36/36/36): held, held, held -> counter climbs to 3.
  assert.equal(stallCounterAfterStep[0], 1);
  assert.equal(stallCounterAfterStep[1], 2);
  assert.equal(stallCounterAfterStep[2], 3);
  // Step 4 (36->33): genuine improvement -> counter RESETS to 0, never reaching 4 or 5.
  assert.equal(stallCounterAfterStep[3], 0, 'a genuine improvement must reset the stall counter');
  // Step 5 (33->33): lateral wash -> held, counter increments from the reset baseline, not from 4.
  assert.equal(stallCounterAfterStep[4], 1);
  assert.ok(
    Math.max(...stallCounterAfterStep) < state.convergence.stall_limit,
    'the sequence must never approach the stall_limit that would park the phase',
  );
});

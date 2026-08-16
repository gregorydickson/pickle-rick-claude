// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPostFinalVerdict } from '../bin/mux-runner.js';

function gate({ ok = true, failures = [], timed_out = false, timeout_ms = null } = {}) {
  return { ok, failures, timed_out, timeout_ms };
}

test('not_applicable when the working dir has no extension/, and it is NOT degraded', () => {
  const result = classifyPostFinalVerdict({
    gate: null,
    applicable: false,
    verdictTs: null,
    finalCommitTs: 100,
    baselineFailures: [],
  });
  assert.strictEqual(result.state, 'not_applicable');
  assert.strictEqual(result.degraded, false);
});

test('timed_out: true classifies inconclusive with an EMPTY dimension list', () => {
  const result = classifyPostFinalVerdict({
    gate: gate({ ok: false, timed_out: true, failures: [{ name: '__timeout__', file: 'npm run test:fast' }] }),
    applicable: true,
    verdictTs: 200,
    finalCommitTs: 100,
    baselineFailures: [],
  });
  assert.strictEqual(result.state, 'inconclusive');
  assert.strictEqual(result.degraded, true);
  assert.deepStrictEqual(result.dimensions, []);
});

test('a verdict whose ts pre-dates the final commit classifies absent, not red and not green', () => {
  const result = classifyPostFinalVerdict({
    gate: gate({ ok: false, failures: [{ name: 'some_test', file: 'a.test.js' }] }),
    applicable: true,
    verdictTs: 50,
    finalCommitTs: 100,
    baselineFailures: [],
  });
  assert.strictEqual(result.state, 'absent');
  assert.strictEqual(result.degraded, true);
});

test('verdictTs === finalCommitTs counts as fresh, not absent', () => {
  const result = classifyPostFinalVerdict({
    gate: gate({ ok: true }),
    applicable: true,
    verdictTs: 100,
    finalCommitTs: 100,
    baselineFailures: [],
  });
  assert.strictEqual(result.state, 'green');
});

test('a red gate whose failures all appear in baselineFailures classifies green; adding any failure outside the baseline classifies red', () => {
  const baselineOnly = classifyPostFinalVerdict({
    gate: gate({ ok: false, failures: [{ name: 'flaky_a', file: 'a.test.js' }] }),
    applicable: true,
    verdictTs: 200,
    finalCommitTs: 100,
    baselineFailures: ['flaky_a'],
  });
  assert.strictEqual(baselineOnly.state, 'green');
  assert.strictEqual(baselineOnly.degraded, false);

  const withNewFailure = classifyPostFinalVerdict({
    gate: gate({
      ok: false,
      failures: [
        { name: 'flaky_a', file: 'a.test.js' },
        { name: 'new_regression', file: 'b.test.js' },
      ],
    }),
    applicable: true,
    verdictTs: 200,
    finalCommitTs: 100,
    baselineFailures: ['flaky_a'],
  });
  assert.strictEqual(withNewFailure.state, 'red');
  assert.strictEqual(withNewFailure.degraded, true);
  assert.deepStrictEqual(withNewFailure.dimensions, ['flaky_a', 'new_regression']);
});

// `finalCommitTs === null` is NOT a synonym for "the bundle committed nothing": `gitCommitEpoch` /
// `readHeadCommit` (mux-runner.ts) collapse every git-probe failure to null — unreadable HEAD,
// a `git show` timeout, a non-repo working dir. The four cases below pin that an unknown commit
// time only ever suppresses the STALENESS check; it never decides the tier verdict.
test('a CLEAN gate with an unknown final-commit time classifies green and is NOT degraded', () => {
  const result = classifyPostFinalVerdict({
    gate: gate({ ok: true }),
    applicable: true,
    verdictTs: 50,
    finalCommitTs: null,
    baselineFailures: [],
  });
  assert.strictEqual(result.state, 'green');
  assert.strictEqual(result.degraded, false);
});

test('an unknown final-commit time must NOT launder a RED gate into green', () => {
  const result = classifyPostFinalVerdict({
    gate: gate({ ok: false, failures: [{ name: 'real_regression', file: 'x.test.js' }] }),
    applicable: true,
    verdictTs: 50,
    finalCommitTs: null,
    baselineFailures: [],
  });
  assert.strictEqual(result.state, 'red');
  assert.strictEqual(result.degraded, true);
  assert.deepStrictEqual(result.dimensions, ['real_regression']);
});

test('an unknown final-commit time does not outrank the timeout branch: still inconclusive', () => {
  const result = classifyPostFinalVerdict({
    gate: gate({ ok: false, timed_out: true, failures: [{ name: '__timeout__', file: 'npm run test:fast' }] }),
    applicable: true,
    verdictTs: 50,
    finalCommitTs: null,
    baselineFailures: [],
  });
  assert.strictEqual(result.state, 'inconclusive');
  assert.strictEqual(result.degraded, true);
  assert.deepStrictEqual(result.dimensions, []);
});

test('an unknown final-commit time does not bypass baseline subtraction: baseline-only stays green', () => {
  const result = classifyPostFinalVerdict({
    gate: gate({ ok: false, failures: [{ name: 'flaky_a', file: 'a.test.js' }] }),
    applicable: true,
    verdictTs: 50,
    finalCommitTs: null,
    baselineFailures: ['flaky_a'],
  });
  assert.strictEqual(result.state, 'green');
  assert.strictEqual(result.degraded, false);
});

test('garbage input classifies absent, never green', () => {
  const result = classifyPostFinalVerdict({
    gate: { garbage: true },
    applicable: true,
    verdictTs: 200,
    finalCommitTs: 100,
    baselineFailures: [],
  });
  assert.strictEqual(result.state, 'absent');
  assert.strictEqual(result.degraded, true);
});

test('gate === null with applicable true classifies absent', () => {
  const result = classifyPostFinalVerdict({
    gate: null,
    applicable: true,
    verdictTs: null,
    finalCommitTs: 100,
    baselineFailures: [],
  });
  assert.strictEqual(result.state, 'absent');
});

// The two states above are covered individually, which is not the same claim as covering the
// DIFFERENCE between them — and the difference is the whole point. `not_applicable` is the positive
// fact "this repo ships no tier to measure" (off-repo bundles stay green, the repo-agnostic
// invariant); `absent` is "we could not measure", which must read degraded. A regression collapsing
// them EITHER way passes both individual tests: merging onto `not_applicable` fake-GREENs an
// unmeasurable tier, merging onto `absent` fake-REDs every off-repo bundle. Only varying the single
// discriminating input catches both directions, so this case holds every other field constant.
test('not_applicable and absent are DIFFERENT verdicts, not two labels for one outcome', () => {
  const shared = { gate: null, verdictTs: null, finalCommitTs: 100, baselineFailures: [] };
  const notApplicable = classifyPostFinalVerdict({ ...shared, applicable: false });
  const absent = classifyPostFinalVerdict({ ...shared, applicable: true });

  assert.notStrictEqual(notApplicable.state, absent.state, 'the two states must not collapse');
  assert.notStrictEqual(
    notApplicable.degraded,
    absent.degraded,
    'the difference must reach `degraded` — that is the only field the withholding wire reads',
  );

  // Pinned concretely so the assertions above cannot be satisfied by the pair swapping places.
  assert.strictEqual(notApplicable.state, 'not_applicable');
  assert.strictEqual(notApplicable.degraded, false);
  assert.strictEqual(absent.state, 'absent');
  assert.strictEqual(absent.degraded, true);
});

test('a clean gate classifies green and is NOT degraded', () => {
  const result = classifyPostFinalVerdict({
    gate: gate({ ok: true }),
    applicable: true,
    verdictTs: 200,
    finalCommitTs: 100,
    baselineFailures: [],
  });
  assert.strictEqual(result.state, 'green');
  assert.strictEqual(result.degraded, false);
});

test('a red gate with failures outside an empty baseline classifies red with dimensions populated', () => {
  const result = classifyPostFinalVerdict({
    gate: gate({ ok: false, failures: [{ name: 'real_regression', file: 'c.test.js' }] }),
    applicable: true,
    verdictTs: 200,
    finalCommitTs: 100,
    baselineFailures: [],
  });
  assert.strictEqual(result.state, 'red');
  assert.strictEqual(result.degraded, true);
  assert.deepStrictEqual(result.dimensions, ['real_regression']);
});

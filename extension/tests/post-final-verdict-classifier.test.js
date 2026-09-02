// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPostFinalVerdict } from '../bin/mux-runner.js';

// AP-EXT-ITER157-02: `measured` DEFAULTS off `timed_out` rather than to a bare `true`, because
// that is what the producer does — a timed-out gate measured nothing. Every pre-existing case
// therefore keeps the disposition it was written for, and a case that wants the third state
// (exit 0 over a tier that ran nothing) says `measured: false` out loud.
function gate({ ok = true, failures = [], timed_out = false, timeout_ms = null, measured = !timed_out } = {}) {
  return { ok, failures, timed_out, timeout_ms, measured };
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

// ---------------------------------------------------------------------------
// AP-EXT-ITER157-02 — a gate that EXITED 0 without executing a test is not green.
//
// `bin/test-runner.js --tier fast` exits 0 printing only `[no files for tier fast]` on an
// empty selection, so `runBetweenTicketFastTests` returns `ok: true` for a tier that ran
// nothing. Pre-fix this classifier's only no-measurement arm keyed on `timed_out`, so that
// gate fell through to the `gate.ok` green and stamped `post_final_verdict:
// {state:'green', degraded:false}` — the BUNDLE's success verdict, which
// `pipeline-runner.ts:readDegradedPostFinalVerdict` keys on to decide whether to withhold it.
//
// These cases drive the classifier through its exported entry point, on the same
// `{ok:true, failures:[], timed_out:false}` record the producer actually returns for an
// empty tier — the discriminator is `measured` and nothing else.

test('AP-EXT-ITER157-02: a gate that exited 0 without measuring a test is inconclusive, NOT green', () => {
  const result = classifyPostFinalVerdict({
    gate: gate({ ok: true, measured: false }),
    applicable: true,
    verdictTs: 200,
    finalCommitTs: 100,
    baselineFailures: [],
  });
  assert.strictEqual(result.state, 'inconclusive');
  assert.strictEqual(result.degraded, true, 'an unmeasured tier must withhold the success verdict');
  assert.deepEqual(result.dimensions, []);
});

// The positive control that forbids passing by refusing everything: the SAME record with the
// single `measured` bit flipped must still be green. Without this, `return finalize(
// 'inconclusive')` at the top of the function passes the case above.
test('AP-EXT-ITER157-02 comparator: the same exit-0 gate WITH a measurement stays green', () => {
  const result = classifyPostFinalVerdict({
    gate: gate({ ok: true, measured: true }),
    applicable: true,
    verdictTs: 200,
    finalCommitTs: 100,
    baselineFailures: [],
  });
  assert.strictEqual(result.state, 'green');
  assert.strictEqual(result.degraded, false);
});

// The blast-radius fence: `measured` gates the GREEN claim and NOTHING else. A gate that exited
// NON-ZERO is unmeasured too whenever it died before emitting a summary — a pretest script
// failure is exactly that shape — and it must still classify RED with its failure names intact.
// Hoisting the measurement check up beside the timeout arm passes the two cases above and
// silently swallows this one, which is why it is pinned separately.
test('AP-EXT-ITER157-02: an unmeasured gate that exited NON-ZERO still classifies red, with dimensions', () => {
  const result = classifyPostFinalVerdict({
    gate: gate({
      ok: false,
      timed_out: false,
      measured: false,
      failures: [{ name: 'npm run test:fast', file: '', script_failure: true }],
    }),
    applicable: true,
    verdictTs: 200,
    finalCommitTs: 100,
    baselineFailures: [],
  });
  assert.strictEqual(result.state, 'red', 'an unmeasured gate can still REPORT a failure it observed');
  assert.strictEqual(result.degraded, true);
  assert.deepEqual(result.dimensions, ['npm run test:fast'], 'the attribution must not be dropped');
});

// The timeout arm is untouched by this fix and stays keyed on `timed_out` — pinned here with
// `measured` left at its producer value so a future edit cannot quietly re-route it.
test('AP-EXT-ITER157-02: the timeout arm still classifies inconclusive with an EMPTY dimension list', () => {
  const timedOut = classifyPostFinalVerdict({
    gate: gate({ ok: false, timed_out: true, failures: [{ name: '__timeout__', file: 'npm run test:fast' }] }),
    applicable: true,
    verdictTs: 200,
    finalCommitTs: 100,
    baselineFailures: [],
  });
  assert.strictEqual(timedOut.state, 'inconclusive');
  assert.strictEqual(timedOut.degraded, true);
  assert.deepEqual(timedOut.dimensions, []);
});

// A gate object that does not DECLARE the axis is not a gate result. It lands on the existing
// `absent` arm (degraded) rather than being coerced silently in either direction — the same
// refusal `{garbage: true}` already gets.
test('AP-EXT-ITER157-02: an old-shape gate with no `measured` field classifies absent, never green', () => {
  const result = classifyPostFinalVerdict({
    gate: { ok: true, failures: [], timed_out: false, timeout_ms: null },
    applicable: true,
    verdictTs: 200,
    finalCommitTs: 100,
    baselineFailures: [],
  });
  assert.strictEqual(result.state, 'absent');
  assert.strictEqual(result.degraded, true);
});

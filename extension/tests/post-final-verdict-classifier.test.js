// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPostFinalVerdict, parseBetweenTicketFastGateFailures } from '../bin/mux-runner.js';

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
// M1 (ROOT M1, PRD p1-b-measure-the-measurement-must-mean-what-it-names.md): the post-final
// verdict must carry the script-failure diagnostic tail beside the name, in a field of its own.

// M1-1: a script_failure entry's name AND its diagnostic tail both reach the classifier's output.
test('M1-1: a script-failure gate persists the failure name AND its diagnostic tail', () => {
  const result = classifyPostFinalVerdict({
    gate: gate({
      ok: false,
      timed_out: false,
      measured: false,
      failures: [{
        name: 'script failure: pretest:fast',
        file: '',
        script_failure: true,
        message: 'audit-test-tiers.sh: FAIL — tests/foo.test.js missing @tier header',
      }],
    }),
    applicable: true,
    verdictTs: 200,
    finalCommitTs: 100,
    baselineFailures: [],
  });
  assert.strictEqual(result.state, 'red');
  // M1-2: dimensions keeps its existing shape — an array of name strings, untouched.
  assert.deepStrictEqual(result.dimensions, ['script failure: pretest:fast']);
  // M1-1: the tail lands in its own field, not concatenated into dimensions.
  assert.deepStrictEqual(result.diagnostics, [{
    name: 'script failure: pretest:fast',
    message: 'audit-test-tiers.sh: FAIL — tests/foo.test.js missing @tier header',
  }]);
});

// M1-3 (negative control): a red gate with parsed real test names still records those names in
// dimensions, and diagnostics stays empty — the tail never replaces or duplicates a real name.
test('M1-3: a red gate with real (non-script) TAP failures carries no diagnostics tail', () => {
  const result = classifyPostFinalVerdict({
    gate: gate({
      ok: false,
      failures: [
        { name: 'widget_test.js > explodes', file: 'widget_test.js' },
        { name: 'gadget_test.js > breaks', file: 'gadget_test.js' },
      ],
    }),
    applicable: true,
    verdictTs: 200,
    finalCommitTs: 100,
    baselineFailures: [],
  });
  assert.strictEqual(result.state, 'red');
  assert.deepStrictEqual(result.dimensions, ['widget_test.js > explodes', 'gadget_test.js > breaks']);
  assert.deepStrictEqual(result.diagnostics, []);
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

// ---------------------------------------------------------------------------
// Q2 (ROOT Q2, PRD p1-b-zero-the-last-two-bugs-and-the-last-carve-out.md, GitHub #28): a tier that
// exited NON-ZERO while every node:test summary it printed reported `fail 0` is UNMEASURED, not a
// measured regression. It classifies `inconclusive` — still degraded, still carrying its tail.
//
// Every case below drives the REAL producer (`parseBetweenTicketFastGateFailures`) over tier output
// and hands its entries to the classifier. The zero-failure fact is decided over the WHOLE output:
// occurrence 1's recorded tail shows `parallel_exit=1 serial_exit=0` beside the SERIAL half's
// `fail 0`, so the 20-line `message` tail alone can omit the half that actually failed.

function classifyTierOutput(output, { measured = true } = {}) {
  const failures = parseBetweenTicketFastGateFailures(output, '/repo');
  const result = classifyPostFinalVerdict({
    gate: gate({ ok: false, failures, measured }),
    applicable: true,
    verdictTs: 200,
    finalCommitTs: 100,
    baselineFailures: [],
  });
  return { failures, result };
}

const BANNER = '> pickle-rick-scripts@2.1.0 test:fast:parallel\n> node bin/test-runner.js --tier fast\n';

function specSummary({ tests = 5, fail = 0, cancelled = 0 } = {}) {
  return [
    `ℹ tests ${tests}`,
    'ℹ suites 1',
    `ℹ pass ${tests - fail - cancelled}`,
    `ℹ fail ${fail}`,
    `ℹ cancelled ${cancelled}`,
    'ℹ skipped 0',
    'ℹ todo 0',
    'ℹ duration_ms 12.5',
  ].join('\n');
}

// Recorded verbatim from the two sessions that withheld success on this shape.
// 2026-09-14-ae80e917: state.json post_final_verdict.diagnostics[0].message.
const OCCURRENCE_2_TAIL = "✔ AC-GTRUTH-A1-1: an ABSENT/un-injected worker gate refuses the zero-diff Done-flip (156.626208ms)\n✔ roster honesty: decision=attribution REFUSES a fully-declared zero-diff ticket (129.484666ms)\n✔ the arm is not inert: decision=phantom-watch KEEPS a declared zero-diff Done (120.844709ms)\n✔ phantom-watch keep does NOT extend to an undeclared absent-evidence Done (127.517209ms)\n✔ R-CXOR-2: a declaration does NOT launder a baseline-sha stamp (99.070375ms)\n✔ AC-GTRUTH-A1-3: no sentinel sha literal beyond the pre-existing test-mode bypass (257.723708ms)\n✔ AC-GTRUTH-A1-5: guardCompletionCommitBeforeDone stays policy-free (shape mapping only) (98.852709ms)\n✔ F9: `zero_diff_intent` is READ-ONLY in production — a producer must bring an authorship constraint (596.172083ms)\n✔ F9: the sanctioned read is still present — this pin fails closed (87.950375ms)\n✔ AP-EXT-ITER176-01: codeMask blanks comments by grammar, and moves nothing (0.465959ms)\n✔ AC-GTRUTH-A1-4: the zero-diff path performs no git write (4.389042ms)\n✔ AP-EXT-ITER182-01: no pin reads a source file outside the declared readers (4.6825ms)\nℹ tests 9538\nℹ suites 579\nℹ pass 9534\nℹ fail 0\nℹ cancelled 0\nℹ skipped 3\nℹ todo 1\nℹ duration_ms 254138.842834";
// 2026-09-12-a4d141e1: its post_final_verdict predates M1 and kept no tail, so this is the same
// gate's recorded entry at state.json last_between_ticket_gate.failures[0].
const OCCURRENCE_1_ENTRY = {
  name: 'script failure: test:fast:serial',
  file: '',
  script_failure: true,
  message: "✔ AP-EXT-ITER123-01: the SCAN arm accepts over the R-CCR-1 fallbackDir, like its explicit sibling (139.15225ms)\n✔ AP-EXT-ITER123-01: the phantom-Done watcher KEEPS an inferred-stamped ticket whose working_dir is unusable (173.872125ms)\n✔ AP-EXT-ITER123-01: widening the accept arms does NOT launder a foreign-attributed inferred sha (135.309334ms)\n✔ AP-EXT-ITER123-01: a definite not-exists on the primary rung is still FINAL (no always-try-the-fallback degrade) (141.589333ms)\n✔ ref'd sole-settle-path timer: fires reliably with no other handle holding the loop (85.332583ms)\n✔ negative control: an unref'd sole-settle-path timer does NOT reliably fire (proves the mechanism) (33.264709ms)\n✔ no promise's sole settle path is an unref'd timer, anywhere under src/ or tests/ (861.633416ms)\n✔ every KNOWN_UNFIXED entry is still a real violation — the exception list rots red, not green (0.097042ms)\n✔ the sole-settle-path scan is not vacuous: it finds settling timers under EVERY root (0.082125ms)\n✔ the helper widening flags a helper-settled unref'd timer and spares a heartbeat (1.521667ms)\nℹ tests 403\nℹ suites 24\nℹ pass 401\nℹ fail 0\nℹ cancelled 0\nℹ skipped 2\nℹ todo 0\nℹ duration_ms 61630.713125\ntest:fast halves measured: parallel_exit=1 serial_exit=0\ntest:fast FAILED (parallel_exit=1 serial_exit=0)",
};

test('Q2-1: a non-zero tier exit whose summary reports zero test failures classifies inconclusive, not red', () => {
  const output = `${BANNER}✔ passes (0.3ms)\n${specSummary()}`;
  const { failures, result } = classifyTierOutput(output);
  assert.strictEqual(result.state, 'inconclusive');
  // Q2-3: inconclusive still withholds the success verdict and still records the diagnostic tail.
  assert.strictEqual(result.degraded, true, 'an unmeasured tier must withhold the success verdict');
  assert.deepStrictEqual(result.dimensions, ['script failure: test:fast:parallel']);
  assert.deepStrictEqual(result.diagnostics, [{ name: failures[0].name, message: failures[0].message }]);
  assert.match(result.diagnostics[0].message, /ℹ fail 0/);
});

test('Q2-2: a non-zero exit WITH reported test failures still classifies red', () => {
  const output = `${BANNER}✔ passes (0.3ms)\n▶ suite\n  ✖ breaks (0.4ms)\n✖ suite (0.5ms)\n${specSummary({ fail: 1 })}\n✖ failing tests:`;
  const { result } = classifyTierOutput(output);
  assert.strictEqual(result.state, 'red');
  assert.deepStrictEqual(result.dimensions, ['script failure: test:fast:parallel']);
});

test('Q2-2: a non-zero exit carrying NO parseable fail count stays red and is not stamped', () => {
  const output = '> pickle-rick-scripts@2.1.0 pretest:fast\n> bash scripts/audit-test-tiers.sh\n\naudit-test-tiers.sh: FAIL — tests/foo.test.js missing @tier header';
  const { failures, result } = classifyTierOutput(output, { measured: false });
  assert.strictEqual(result.state, 'red');
  assert.strictEqual('reported_zero_failures' in failures[0], false, 'no summary is no evidence of zero failures');
});

// node:test counts a timed-out test under `cancelled`, NOT `fail` (measured on node v24.19.0), so a
// `fail 0` line can sit beside a test that did not pass. Its `✖` marker is the evidence.
test('Q2-2: `fail 0` beside a cancelled test (✖ marker) stays red', () => {
  const output = `${BANNER}✔ passes (0.3ms)\n✖ slow (51.3ms)\n${specSummary({ fail: 0, cancelled: 1 })}`;
  const { result } = classifyTierOutput(output);
  assert.strictEqual(result.state, 'red');
});

// The occurrence-1 hazard, isolated to the count conjunct (no marker in either half): the LAST
// half's `fail 0` must not answer for an earlier half that reported failures.
test('Q2-2: an earlier half reporting failures stays red even when the last half reports fail 0', () => {
  const output = `${BANNER}${specSummary({ fail: 2 })}\n> pickle-rick-scripts@2.1.0 test:fast:serial\n${specSummary()}\ntest:fast FAILED (parallel_exit=1 serial_exit=0)`;
  const { result } = classifyTierOutput(output);
  assert.strictEqual(result.state, 'red');
});

test('Q2-2: a real TAP failure named by the parser stays red', () => {
  const output = `${BANNER}not ok 1 - widget explodes\n  ---\n  location: '/repo/tests/widget.test.js:3:1'\n  ...\n# tests 1\n# fail 0`;
  const { failures, result } = classifyTierOutput(output);
  assert.strictEqual(failures[0].script_failure, undefined);
  assert.strictEqual(result.state, 'red');
});

test('Q2-4: both recorded session shapes replay to inconclusive through the producer', () => {
  for (const tail of [OCCURRENCE_2_TAIL, OCCURRENCE_1_ENTRY.message]) {
    const { failures, result } = classifyTierOutput(tail);
    assert.strictEqual(failures[0].reported_zero_failures, true);
    assert.strictEqual(result.state, 'inconclusive');
    assert.strictEqual(result.degraded, true);
    assert.strictEqual(result.diagnostics[0].message, failures[0].message);
  }
});

// The pre-fix record — the entry exactly as it was persisted, with no zero-failure stamp — still
// classifies red. The classifier never re-derives the fact from a tail it cannot trust.
test('Q2-4: the recorded entries without the producer stamp still classify red', () => {
  const occurrence2Entry = { name: 'script failure: test:fast:parallel', file: '', script_failure: true, message: OCCURRENCE_2_TAIL };
  for (const entry of [occurrence2Entry, OCCURRENCE_1_ENTRY]) {
    const result = classifyPostFinalVerdict({
      gate: gate({ ok: false, failures: [entry] }),
      applicable: true,
      verdictTs: 200,
      finalCommitTs: 100,
      baselineFailures: [],
    });
    assert.strictEqual(result.state, 'red');
  }
});

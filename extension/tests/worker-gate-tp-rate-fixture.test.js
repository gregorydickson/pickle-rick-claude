// @tier: fast
//
// B-GTRUTH WS-A3b — the executable consumer of the worker-gate TP-rate measurement.
//
// WS-A3b is report-only: its acceptance is "the number is recorded and the threshold
// stated", explicitly un-gateable on the number's sign. That makes it uniquely easy to
// let rot. The fixture and the report shipped with NO reader of any kind — a
// one-character edit to a `ground_truth_defect` label would silently invalidate the
// only number the workstream exists to produce, and the report's claim that the result
// is "100% reproducible from that one file" was itself unverified.
//
// So this file recomputes the confusion matrix from the fixture and checks it against
// numbers PARSED OUT OF the report. Nothing here is hardcoded from the report: a test
// carrying its own copy of `TP = 4` would keep passing while fixture and report drifted
// apart, which is the exact failure being closed. Either the two agree or this goes red.
//
// It does NOT re-litigate the measurement. Whether 0.50 argues for repairing or retiring
// the gate is a follow-on decision (report §"Not in scope"); this file only holds the
// number honest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const FIXTURE_PATH = path.join(
  import.meta.dirname, 'fixtures', 'worker-gate-tp-rate', 'labelled-gate-verdicts.json',
);
const REPORT_PATH = path.join(
  import.meta.dirname, '..', 'docs', 'worker-gate-tp-rate-wsa3b.md',
);

const QUADRANTS = ['TP', 'FP', 'TN', 'FN'];

function loadFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

function loadReport() {
  return fs.readFileSync(REPORT_PATH, 'utf8');
}

/**
 * Pull one required number out of the report. Fails CLOSED: a reshaped report throws
 * here rather than yielding undefined, which would make every comparison below pass by
 * comparing two absent values.
 */
function requireReportNumber(report, re, what) {
  const m = re.exec(report);
  assert.ok(
    m,
    `could not parse ${what} out of docs/worker-gate-tp-rate-wsa3b.md — the report was `
    + 'reshaped, so this test can no longer hold its numbers against the fixture. Fix the '
    + 'regex or the report; do NOT delete the assertion.',
  );
  return Number(m[1]);
}

/** The report's own derived-verdict rule: red iff either dimension failed. */
function derivedVerdict(record) {
  return (!record.lint_ok || !record.tsc_ok) ? 'red' : 'green';
}

function confusionMatrix(records) {
  const counts = { TP: 0, FP: 0, TN: 0, FN: 0 };
  for (const record of records) {
    const red = derivedVerdict(record) === 'red';
    if (red) counts[record.ground_truth_defect ? 'TP' : 'FP'] += 1;
    else counts[record.ground_truth_defect ? 'FN' : 'TN'] += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// The measurement itself
// ---------------------------------------------------------------------------

test('WS-A3b: the recorded confusion matrix is reproducible from the checked-in fixture', () => {
  const report = loadReport();
  const counts = confusionMatrix(loadFixture().records);

  const reported = Object.fromEntries(QUADRANTS.map((q) => [
    q,
    requireReportNumber(report, new RegExp(`${q} = (\\d+)`), `the reported ${q} count`),
  ]));

  assert.deepEqual(
    counts,
    reported,
    'the confusion matrix recomputed from labelled-gate-verdicts.json must equal the one '
    + 'recorded in docs/worker-gate-tp-rate-wsa3b.md. A mismatch means a fixture label was '
    + 'edited without re-deriving the report (or vice versa) — the recorded number is then '
    + 'a claim about a dataset that no longer exists.',
  );
});

test('WS-A3b: the recorded TP-rate is the one the fixture actually yields', () => {
  const report = loadReport();
  const { TP, FN } = confusionMatrix(loadFixture().records);

  const m = /TP-rate \(sensitivity\) = TP \/ \(TP \+ FN\) = (\d+) \/ \((\d+) \+ (\d+)\) = ([\d.]+)/
    .exec(report);
  assert.ok(m, 'could not parse the TP-rate line out of the report — fails closed');

  const [, reportedTp, reportedTpAgain, reportedFn, reportedRate] = m;

  // The report shows its work as `TP / (TP + FN)`. Check the arithmetic it displays, not
  // just its answer: a report can state a correct rate beside operands that no longer
  // match the fixture, and that is still a broken record.
  assert.equal(Number(reportedTp), TP, 'the report\'s TP operand must match the fixture');
  assert.equal(Number(reportedTpAgain), TP, 'the report\'s denominator TP term must match the fixture');
  assert.equal(Number(reportedFn), FN, 'the report\'s FN operand must match the fixture');

  assert.ok(TP + FN > 0, 'a fixture with no ground-truth defects makes sensitivity undefined');
  assert.equal(
    Number(reportedRate).toFixed(2),
    (TP / (TP + FN)).toFixed(2),
    'the recorded TP-rate must equal the rate the fixture yields',
  );
});

test('WS-A3b: the report lands the result in the band its own pre-declared threshold implies', () => {
  const report = loadReport();
  const { TP, FN } = confusionMatrix(loadFixture().records);
  const rate = TP / (TP + FN);

  const repairAt = requireReportNumber(
    report, /TP-rate ≥ ([\d.]+) → REPAIR/, 'the REPAIR threshold',
  );
  const retireAt = requireReportNumber(
    report, /TP-rate < ([\d.]+) → RETIRE-AS-BLOCKING/, 'the RETIRE-AS-BLOCKING threshold',
  );
  assert.equal(
    repairAt,
    retireAt,
    'the two threshold statements must name the SAME bound — a gap or overlap between them '
    + 'would leave a rate that falls in neither band, or in both',
  );

  const bandMatch = /→ (REPAIR|RETIRE-AS-BLOCKING) band/.exec(report);
  assert.ok(bandMatch, 'could not parse the concluded band out of the report — fails closed');

  assert.equal(
    bandMatch[1],
    rate >= repairAt ? 'REPAIR' : 'RETIRE-AS-BLOCKING',
    `the report concludes the ${bandMatch[1]} band, but the fixture yields ${rate} against a `
    + `pre-declared bound of ${repairAt}. The threshold was fixed BEFORE the number was `
    + 'computed; moving the conclusion to fit a changed number would retro-fit the bound.',
  );
});

// ---------------------------------------------------------------------------
// Fixture integrity — the labels the measurement is computed from
// ---------------------------------------------------------------------------

test('WS-A3b: the fixture carries the record count the report counted', () => {
  const { records } = loadFixture();
  const reportedCount = requireReportNumber(
    loadReport(), /(\d+)-record fixture/, 'the reported record count',
  );
  assert.equal(
    records.length,
    reportedCount,
    'adding or removing a record without re-deriving the report leaves the recorded number '
    + 'describing a different dataset',
  );
});

test('WS-A3b: every record is strictly boolean on all three labelled axes', () => {
  for (const record of loadFixture().records) {
    for (const field of ['lint_ok', 'tsc_ok', 'ground_truth_defect']) {
      assert.equal(
        typeof record[field],
        'boolean',
        `record ${record.id}: ${field} must be a strict boolean — the derived-verdict rule `
        + 'and the ground-truth join are both truthiness tests, so a string "false" or a '
        + 'missing key would be silently counted as its opposite',
      );
    }
  }
});

test('WS-A3b: record ids are unique', () => {
  const ids = loadFixture().records.map((r) => r.id);
  assert.equal(
    new Set(ids).size,
    ids.length,
    'duplicate ids make a record unciteable from the report and hide an accidental paste',
  );
});

test('WS-A3b: each quadrant label agrees with the record\'s own two axes', () => {
  for (const record of loadFixture().records) {
    const expected = derivedVerdict(record) === 'red'
      ? (record.ground_truth_defect ? 'TP' : 'FP')
      : (record.ground_truth_defect ? 'FN' : 'TN');
    assert.equal(
      record.quadrant,
      expected,
      `record ${record.id}: the quadrant label duplicates information already carried by `
      + 'lint_ok/tsc_ok/ground_truth_defect, so it can disagree with them. It is the '
      + 'human-readable handle the report cites; a stale label misattributes a record to the '
      + 'wrong cell for every reader who trusts it over the booleans.',
    );
  }
});

test('WS-A3b: the derived-verdict rule this test applies is the one the fixture declares', () => {
  const rule = loadFixture()._meta?.derived_verdict_rule;
  assert.ok(rule, '_meta.derived_verdict_rule must be present — it is the fixture\'s contract '
    + 'with every consumer, including this one');
  assert.match(
    rule,
    /!lint_ok \|\| !tsc_ok/,
    'this test computes `red iff (!lint_ok || !tsc_ok)`. If the fixture ever declares a '
    + 'different rule, the two have silently diverged and every count above is measuring '
    + 'something the fixture no longer claims.',
  );
});

// ---------------------------------------------------------------------------
// Provenance — WS-A3b's checked-in-fixture constraint
// ---------------------------------------------------------------------------

test('WS-A3b: no record is derived from mutable runtime/session state', () => {
  // Scoped to `records` deliberately: `_meta.purpose` legitimately NAMES the sessions
  // directory in prose to state the prohibition, so scanning the whole document would
  // fire on the constraint's own wording rather than on a violation.
  const serialized = JSON.stringify(loadFixture().records);
  for (const marker of ['.local/share/pickle-rick', '.claude/pickle-rick', '/sessions/']) {
    assert.ok(
      !serialized.includes(marker),
      `a record references "${marker}". WS-A3b requires a checked-in labelled dataset: a `
      + 'record sourced from the mutable sessions dir is not reproducible by anyone else and '
      + 'makes the recorded number unauditable.',
    );
  }
});

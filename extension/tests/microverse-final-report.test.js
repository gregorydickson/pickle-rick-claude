// @tier: fast
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFailureDistribution,
  buildEfficiencySection,
  writeFinalReport,
} from '../bin/microverse-runner.js';
import { replayCorpus } from '../bin/wasted-iter-replay.js';

// ── buildFailureDistribution ──

test('buildFailureDistribution: normal case with multiple classes', () => {
  const history = [
    { failure_class: 'test_regression' },
    { failure_class: 'test_regression' },
    { failure_class: 'test_regression' },
    { failure_class: 'build_break' },
  ];
  const result = buildFailureDistribution(history);
  assert.ok(result.includes('## Failure Distribution'), 'has section header');
  assert.ok(result.includes('| test_regression | 3 |'), 'test_regression count');
  assert.ok(result.includes('| build_break | 1 |'), 'build_break count');
  assert.ok(result.includes('| Class | Count |'), 'has table header');
});

test('buildFailureDistribution: empty failure_history', () => {
  const result = buildFailureDistribution([]);
  assert.ok(result.includes('## Failure Distribution'), 'has section header');
  assert.ok(result.includes('No failures recorded'), 'shows no failures message');
  assert.ok(!result.includes('| Class |'), 'no table rendered');
});

test('buildFailureDistribution: single failure class', () => {
  const history = [
    { failure_class: 'regression' },
    { failure_class: 'regression' },
  ];
  const result = buildFailureDistribution(history);
  assert.ok(result.includes('| regression | 2 |'));
});

test('buildFailureDistribution: all five failure classes', () => {
  const history = [
    { failure_class: 'tool_failure' },
    { failure_class: 'approach_exhaustion' },
    { failure_class: 'regression' },
    { failure_class: 'metric_unstable' },
    { failure_class: 'no_progress' },
  ];
  const result = buildFailureDistribution(history);
  assert.ok(result.includes('| tool_failure | 1 |'));
  assert.ok(result.includes('| approach_exhaustion | 1 |'));
  assert.ok(result.includes('| regression | 1 |'));
  assert.ok(result.includes('| metric_unstable | 1 |'));
  assert.ok(result.includes('| no_progress | 1 |'));
});

test('buildFailureDistribution: sorted by count descending', () => {
  const history = [
    { failure_class: 'regression' },
    { failure_class: 'tool_failure' },
    { failure_class: 'tool_failure' },
    { failure_class: 'tool_failure' },
    { failure_class: 'regression' },
  ];
  const result = buildFailureDistribution(history);
  const toolIdx = result.indexOf('tool_failure');
  const regIdx = result.indexOf('regression');
  assert.ok(toolIdx < regIdx, 'higher count class appears first');
});

// ── buildEfficiencySection ──

test('buildEfficiencySection: 2 reverts out of 8 iterations', () => {
  const history = [
    { action: 'accept' },
    { action: 'revert' },
    { action: 'accept' },
    { action: 'revert' },
    { action: 'accept' },
    { action: 'accept' },
    { action: 'accept' },
    { action: 'accept' },
  ];
  const result = buildEfficiencySection(history, 8);
  assert.ok(result.includes('## Efficiency'), 'has section header');
  assert.ok(result.includes('**Wasted iterations**: 2 / 8 (25%)'), 'correct count and percentage');
});

test('buildEfficiencySection: 0 reverts (clean run)', () => {
  const history = [
    { action: 'accept' },
    { action: 'accept' },
    { action: 'accept' },
  ];
  const result = buildEfficiencySection(history, 3);
  assert.ok(result.includes('**Wasted iterations**: 0 / 3 (0%)'));
});

test('buildEfficiencySection: all reverts', () => {
  const history = [
    { action: 'revert' },
    { action: 'revert' },
    { action: 'revert' },
  ];
  const result = buildEfficiencySection(history, 3);
  assert.ok(result.includes('**Wasted iterations**: 3 / 3 (100%)'));
});

test('buildEfficiencySection: stall iterations (no commits = missing from history)', () => {
  // AC-A7 (ticket 14ebb20d): this case's comment used to read `wasted = 1 revert + 2 missing
  // = 3`, which is the DELETED formula — the second, private computation of waste that
  // `buildEfficiencySection` used to carry. The expectation below is unchanged, but its
  // reasoning is not, and the criterion requires the reasoning be recorded rather than
  // inferred from a number that happens to match.
  //
  // Under the shared classifier: 5 iterations, 3 with a history entry. `buildEfficiencySection`
  // projects each present entry to a moved HEAD, so the two `accept`s score `committed` and the
  // `revert` scores `revert`; it projects each absent one to `no_commit` with null SHAs, so both
  // score `no_progress`. Waste = 1 revert + 2 no_progress = 3.
  //
  // That the number matches the old formula is not a coincidence of this input: those two
  // projections reproduce `reverts + missing` exactly, so the two agree on EVERY input. No input
  // separates them numerically, which is why the AC-A7 delegation test below is STRUCTURAL —
  // the printed figure cannot witness it.
  const history = [
    { action: 'accept' },
    { action: 'revert' },
    { action: 'accept' },
  ];
  const result = buildEfficiencySection(history, 5);
  assert.ok(result.includes('**Wasted iterations**: 3 / 5 (60%)'));
});

test('buildEfficiencySection: zero total iterations', () => {
  const result = buildEfficiencySection([], 0);
  assert.ok(result.includes('**Wasted iterations**: 0 / 0 (0%)'));
});

test('buildEfficiencySection: percentage rounds correctly', () => {
  // 1 revert out of 3 = 33.333...% → 33%
  const history = [
    { action: 'accept' },
    { action: 'revert' },
    { action: 'accept' },
  ];
  const result = buildEfficiencySection(history, 3);
  assert.ok(result.includes('**Wasted iterations**: 1 / 3 (33%)'));
});

// ── AC-A7: one quantity, one number ──
//
// `buildEfficiencySection` used to carry its own waste formula, a second computation of
// the quantity the `wasted_iter` predicate reports. These two tests pin that it now
// delegates to the shared classifier, so the operator-facing percentage and the replay
// cannot drift into two authoritative-looking numbers for one thing.

test('AC-A7: the efficiency line and the replay agree on the same input', () => {
  // 5 iterations: 2 accepts (committed), 1 revert, 2 with no history entry (no commit).
  const history = [
    { action: 'accept' },
    { action: 'revert' },
    { action: 'accept' },
  ];
  const printed = buildEfficiencySection(history, 5);

  // The same five iterations as the events the runtime would have emitted for them.
  const session = '2026-08-05-aa11bb22';
  const events = [
    { session, action: 'accept', pre_iter_sha: 'a', post_iter_sha: 'b' },
    { session, action: 'revert', pre_iter_sha: 'b', post_iter_sha: 'b' },
    { session, action: 'accept', pre_iter_sha: 'b', post_iter_sha: 'c' },
    { session, action: 'no_commit', pre_iter_sha: 'c', post_iter_sha: 'c' },
    { session, action: 'no_commit', pre_iter_sha: 'c', post_iter_sha: 'c' },
  ];
  const replayed = replayCorpus(events);

  assert.equal(replayed.iterations, 5);
  assert.equal(replayed.new.wasted, 3, 'replay: 1 revert + 2 no-commit');
  assert.equal(Math.round(replayed.new.rate * 100), 60);
  assert.ok(
    printed.includes(`**Wasted iterations**: ${replayed.new.wasted} / 5 (60%)`),
    `efficiency line "${printed.trim()}" must report the replay's figure, not its own`,
  );
});

// Ticket 14ebb20d. The two AC-A7 tests either side of this one asserted a printed NUMBER, and
// a number cannot witness this criterion: the deleted expression (`reverts + missing`) and the
// classifier agree on every possible input, because `buildEfficiencySection` projects present
// history entries to a moved HEAD and absent ones to null SHAs. Both AC-A7 tests would stay
// green with the private formula restored verbatim — decoration, by the ticket's own
// definition. AC-A7 is about WHICH computation produced the figure, so the oracle has to be
// structural.
test('AC-A7: buildEfficiencySection computes waste ONLY by delegating to the classifier', () => {
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bin', 'microverse-runner.ts'),
    'utf-8',
  );
  const fnIdx = source.indexOf('export function buildEfficiencySection(');
  assert.ok(fnIdx >= 0, 'anchor lost: the buildEfficiencySection declaration');
  const endIdx = source.indexOf('\n}', fnIdx);
  assert.ok(endIdx > fnIdx, 'anchor lost: the end of buildEfficiencySection');
  const body = source.slice(fnIdx, endIdx);

  assert.match(
    body, /classifyMuxIteration\(/,
    'the efficiency line must read its verdict from the shared classifier',
  );
  // The deleted formula's signature: counting the `revert` action directly. Any comparison
  // against that literal inside this function is a second, private waste computation — the
  // exact drift AC-A7 forbids, where the operator reads two authoritative-looking numbers for
  // one quantity.
  assert.doesNotMatch(
    body, /===\s*'revert'|includes\('revert'\)|action\s*!==\s*'revert'/,
    'buildEfficiencySection tests the `revert` action itself — a second waste formula is back',
  );
});

test('AC-A7: the efficiency line retains no second formula', () => {
  // The classifier is total over `action`, so an action outside 'accept' | 'revert' still
  // lands in a class instead of falling through a formula that only knew how to count
  // reverts. A present history entry projects to a moved HEAD, so `worker` scores
  // `committed` here (not `worker_handoff` — that arm needs an unmoved HEAD); either way
  // it is not waste, and only the revert is.
  const printed = buildEfficiencySection([{ action: 'worker' }, { action: 'revert' }], 2);
  assert.ok(
    printed.includes('**Wasted iterations**: 1 / 2 (50%)'),
    `only the revert is waste: got "${printed.trim()}"`,
  );
});

test('writeFinalReport uses local-day filename at UTC boundary', () => {
  const previousTz = process.env.TZ;
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mv-report-'));
  try {
    process.env.TZ = 'America/Chicago';
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-04-29T00:30:00Z') });
    writeFinalReport(
      sessionDir,
      {
        status: 'iterating',
        prd_path: '/tmp/prd.md',
        key_metric: { description: 'test', validation: 'echo 50', type: 'command', timeout_seconds: 5, tolerance: 2 },
        convergence: { stall_limit: 3, stall_counter: 0, history: [] },
        gap_analysis_path: '',
        failed_approaches: [],
        failure_history: [],
        baseline_score: 40,
      },
      'limit_reached',
      0,
      0,
    );

    const memoryDir = path.join(sessionDir, 'memory');
    assert.equal(fs.existsSync(path.join(memoryDir, 'microverse_report_2026-04-28.md')), true);
    assert.equal(fs.existsSync(path.join(memoryDir, 'microverse_report_2026-04-29.md')), false);
  } finally {
    mock.timers.reset();
    if (previousTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTz;
    }
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('writeFinalReport handles worker-managed state without key metric', () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mv-report-worker-'));
  try {
    writeFinalReport(
      sessionDir,
      {
        status: 'iterating',
        prd_path: '/tmp/prd.md',
        convergence_mode: 'worker',
        convergence_file: 'worker-convergence.json',
        convergence: { stall_limit: 3, stall_counter: 0, history: [] },
        gap_analysis_path: '',
        failed_approaches: [],
        failure_history: [],
        baseline_score: 0,
      },
      'converged',
      1,
      5,
    );

    const memoryDir = path.join(sessionDir, 'memory');
    const reports = fs.readdirSync(memoryDir).filter((file) => file.startsWith('microverse_report_'));
    assert.equal(reports.length, 1);
    const report = fs.readFileSync(path.join(memoryDir, reports[0]), 'utf8');
    assert.ok(report.includes('- **Metric**: Worker-managed convergence'));
    assert.ok(report.includes('- **Convergence Mode**: worker'));
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// @tier: fast
/**
 * Ticket 129c61c4 (AC-A6): the recount is only evidence if it runs over a fixed,
 * committed population. These tests pin that population and both predicates' verdicts
 * over it, so a change to either predicate that silently reproduces the old rate fails
 * here instead of shipping as an unmeasured claim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CorpusConsistencyError,
  assertPopulationConsistent,
  classifyUnderNewPredicate,
  classifyUnderOldPredicate,
  formatReplayReport,
  isRealSession,
  loadCorpusDir,
  replayCorpus,
} from '../bin/wasted-iter-replay.js';

const CORPUS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'wasted-iter-corpus',
);

/** The committed corpus, replayed. One `wasted_iter` event is one iteration. */
function replayFixtureCorpus() {
  const { events, window } = loadCorpusDir(CORPUS_DIR);
  return { raw: events, result: replayCorpus(events, window) };
}

test('replay reports per-class counts and a per-iteration rate under BOTH predicates', () => {
  const { result } = replayFixtureCorpus();

  assert.equal(result.iterations, 20, '20 real iterations in the committed corpus');

  assert.deepEqual(result.old.classes, {
    committed: 6,
    worker_handoff: 0,
    clean_pass: 0,
    revert: 2,
    no_progress: 12,
  }, 'old predicate cannot see the handoff or clean-pass classes — it charges both to no_progress');
  assert.equal(result.old.wasted, 14);
  assert.equal(result.old.rate, 14 / 20, 'old rate is 70%');

  assert.deepEqual(result.new.classes, {
    committed: 6,
    worker_handoff: 5,
    clean_pass: 2,
    revert: 2,
    no_progress: 5,
  }, 'new predicate separates the 4 worker-label + 1 artifact-delta handoffs and 2 clean passes');
  assert.equal(result.new.wasted, 7);
  assert.equal(result.new.rate, 7 / 20, 'new rate is 35%');
});

test('the new rate is strictly below the old rate', () => {
  const { result } = replayFixtureCorpus();
  assert.ok(
    result.new.rate < result.old.rate,
    `new rate ${result.new.rate} must be below old rate ${result.old.rate} — a predicate that `
    + 'reproduces the old rate has fixed nothing',
  );
});

test('per-class counts sum to the corpus iteration count, under both predicates', () => {
  const { result } = replayFixtureCorpus();
  for (const predicate of ['old', 'new']) {
    const summed = Object.values(result[predicate].classes).reduce((a, b) => a + b, 0);
    assert.equal(summed, result.iterations, `${predicate} per-class counts sum to the iteration count`);
  }
});

test('an inconsistent population fails loudly rather than reporting a rate', () => {
  // Guards the guard: the consistency check is only worth having if it can fire.
  const short = { committed: 3, worker_handoff: 0, clean_pass: 0, revert: 1, no_progress: 0 };
  assert.throws(
    () => assertPopulationConsistent(short, 20, 'old'),
    (err) => err instanceof CorpusConsistencyError
      && /sum to 4 but the corpus holds 20 iterations/.test(err.message)
      && /does not add up/.test(err.message),
    'per-class counts short of the iteration count must throw, not round',
  );

  // And it must not fire on a population that does add up.
  assert.doesNotThrow(() => assertPopulationConsistent(short, 4, 'old'));
});

test('fixture/synthetic sessions contribute zero', () => {
  const { raw, result } = replayFixtureCorpus();

  // Non-vacuous: the corpus really does hold the synthetic events, and they really are
  // dropped. If the exclusion regressed, raw and counted would be equal.
  assert.equal(raw.length, 24, 'the corpus file holds 24 wasted_iter records');
  assert.equal(result.iterations, 20, 'only the 20 real-session records are counted');
  assert.equal(result.excludedFixtureSessions, 1);
  assert.equal(result.excludedFixtureEvents, 4);

  const synthetic = raw.filter(e => e.session === 'pickle-apxg3-3-gyQUnD');
  assert.equal(synthetic.length, 4, 'the known synthetic session is present in the corpus');
  assert.equal(isRealSession('pickle-apxg3-3-gyQUnD'), false);
  assert.equal(isRealSession('2026-08-05-aa11bb22'), true);

  // The synthetic events are all `accept` with a moved SHA, so counting them would push
  // `committed` from 6 to 10 under both predicates. It stays at 6.
  assert.equal(result.old.classes.committed, 6);
  assert.equal(result.new.classes.committed, 6);
});

test('real-session id shape is the whole exclusion rule', () => {
  assert.equal(isRealSession('2026-08-13-71ecebb6'), true);
  assert.equal(isRealSession('2026-08-13-71ECEBB6'), false, 'hex is lowercase');
  assert.equal(isRealSession('2026-08-13-71ecebb'), false, 'exactly 8 hex chars');
  assert.equal(isRealSession('pickle-orsr6-selfred-X7btjb'), false);
  assert.equal(isRealSession(''), false);
});

test('the new predicate reads the handoff from either observable', () => {
  const unmoved = { session: '2026-08-05-aa11bb22', pre_iter_sha: 'x', post_iter_sha: 'x' };

  // microverse observes the handoff by label...
  assert.deepEqual(
    classifyUnderNewPredicate({ ...unmoved, action: 'worker' }),
    { wasted: false, reason: 'worker_handoff' },
  );
  // ...mux observes the same disposition by artifact delta.
  assert.deepEqual(
    classifyUnderNewPredicate({ ...unmoved, action: 'continue', artifact_delta: 2 }),
    { wasted: false, reason: 'worker_handoff' },
  );
  // No delta and no label is the conservative arm.
  assert.deepEqual(
    classifyUnderNewPredicate({ ...unmoved, action: 'continue', artifact_delta: 0 }),
    { wasted: true, reason: 'no_progress' },
  );
  // A revert is wasted regardless of what the SHAs say.
  assert.deepEqual(
    classifyUnderNewPredicate({ session: 'x', action: 'revert', pre_iter_sha: 'a', post_iter_sha: 'b' }),
    { wasted: true, reason: 'revert' },
  );
});

test('the old predicate is the deleted expression, reconstructed', () => {
  // `action === 'revert' || postIterSha === preIterSha`
  const cases = [
    [{ action: 'worker', pre_iter_sha: 'x', post_iter_sha: 'x' }, true, 'no_progress'],
    [{ action: 'task_completed', pre_iter_sha: 'x', post_iter_sha: 'x' }, true, 'no_progress'],
    [{ action: 'accept', pre_iter_sha: 'x', post_iter_sha: 'y' }, false, 'committed'],
    [{ action: 'revert', pre_iter_sha: 'x', post_iter_sha: 'y' }, true, 'revert'],
    [{ action: 'accept', pre_iter_sha: null, post_iter_sha: null }, true, 'no_progress'],
  ];
  for (const [event, wasted, reason] of cases) {
    assert.deepEqual(
      classifyUnderOldPredicate({ session: '2026-08-05-aa11bb22', ...event }),
      { wasted, reason },
      `old predicate on action=${event.action}`,
    );
  }
});

test('AP-EXT-ITER59-01: a half-null HEAD pair reads NOT wasted under the old predicate', () => {
  // The deleted expression is `action === 'revert' || postIterSha === preIterSha`, with no
  // null arm at all: one unreadable HEAD makes `post === pre` false, so the old rule scored
  // the iteration committed. `classifyMuxIteration`'s null-safe `moved` is the NEW rule's
  // handling and must never leak into this column.
  const oldExpression = (event) =>
    event.action === 'revert' || (event.post_iter_sha ?? null) === (event.pre_iter_sha ?? null);

  const halfNull = [
    { action: 'accept', pre_iter_sha: null, post_iter_sha: 'abc' },
    { action: 'accept', pre_iter_sha: 'abc', post_iter_sha: null },
    { action: 'worker', post_iter_sha: 'abc' },            // pre absent entirely
    { action: 'accept', pre_iter_sha: 'abc' },             // post absent entirely
    // Controls: the shapes that already agreed must keep agreeing.
    { action: 'accept', pre_iter_sha: 'abc', post_iter_sha: 'def' },
    { action: 'accept', pre_iter_sha: 'abc', post_iter_sha: 'abc' },
    { action: 'accept', pre_iter_sha: null, post_iter_sha: null },
    { action: 'revert', pre_iter_sha: 'abc', post_iter_sha: 'def' },
  ];

  for (const event of halfNull) {
    const verdict = classifyUnderOldPredicate({ session: '2026-08-05-aa11bb22', ...event });
    assert.equal(
      verdict.wasted,
      oldExpression(event),
      `old predicate diverged from the deleted expression on ${JSON.stringify(event)}`,
    );
    assert.equal(
      verdict.reason,
      verdict.wasted ? (event.action === 'revert' ? 'revert' : 'no_progress') : 'committed',
      `old-predicate reason must follow its own verdict on ${JSON.stringify(event)}`,
    );
  }
});

test('AP-EXT-ITER59-01: a half-null corpus does not inflate the OLD wasted rate', () => {
  // The whole flow, not the predicate alone: replayCorpus -> tally -> rate. Two real-session
  // iterations whose HEAD read failed at exactly one boundary — the live shape, since both
  // SHAs come from a failable `readHeadCommit` read an iteration apart.
  const corpus = [
    { session: '2026-08-05-aa11bb22', iteration: 1, action: 'accept', pre_iter_sha: null, post_iter_sha: 'abc' },
    { session: '2026-08-05-aa11bb22', iteration: 2, action: 'accept', pre_iter_sha: 'def', post_iter_sha: null },
  ];
  const result = replayCorpus(corpus);

  assert.equal(result.iterations, 2);
  assert.equal(result.old.wasted, 0, 'the old rule scored a half-null pair NOT wasted');
  assert.equal(result.old.rate, 0, 'so the OLD column must not be inflated to 100%');
  assert.deepEqual(result.old.classes, {
    committed: 2,
    worker_handoff: 0,
    clean_pass: 0,
    revert: 0,
    no_progress: 0,
  });

  // The NEW rule genuinely differs here — an unreadable HEAD is not evidence of a commit —
  // and that difference must survive, so the fix cannot pass by flattening both columns.
  assert.equal(result.new.wasted, 2);
  assert.deepEqual(result.new.classes, {
    committed: 0,
    worker_handoff: 0,
    clean_pass: 0,
    revert: 0,
    no_progress: 2,
  });
  assert.ok(
    result.new.rate > result.old.rate,
    'on this population the OLD rule is the more forgiving one — a replay that reports the '
    + 'reverse has imported the new rule into the old column and overstated the drop',
  );
});

test('the report records the window, both rates, and the excluded population', () => {
  const { result } = replayFixtureCorpus();
  const report = formatReplayReport(result);

  assert.match(report, /\*\*Window\*\*: 2026-08-05 \.\. 2026-08-06/);
  assert.match(report, /\*\*Iterations counted\*\*: 20/);
  assert.match(report, /\*\*Excluded fixture sessions\*\*: 1 \(4 events\)/);
  assert.match(report, /\*\*Wasted \(OLD\)\*\*: 14 \/ 20 \(70%\)/);
  assert.match(report, /\*\*Wasted \(NEW\)\*\*: 7 \/ 20 \(35%\)/);
  for (const reason of ['committed', 'worker_handoff', 'clean_pass', 'revert', 'no_progress']) {
    assert.ok(report.includes(`\`${reason}\``), `report carries the ${reason} row`);
  }
});

test('an empty corpus reports zero rather than dividing by zero', () => {
  const result = replayCorpus([]);
  assert.equal(result.iterations, 0);
  assert.equal(result.old.rate, 0);
  assert.equal(result.new.rate, 0);
  assert.match(formatReplayReport(result), /\*\*Window\*\*: empty corpus/);
});

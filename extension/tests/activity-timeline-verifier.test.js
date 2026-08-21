// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findOverlapViolations,
  buildGateCompletionReport,
} from '../services/activity-timeline-verifier.js';

function spawnEvt(ts, ticket) {
  return { event: 'worker_spawn_backend_resolved', ts, backend: 'claude', source: 'default', pid: 1, ticket };
}

function gateFailedEvt(ts, ticket, gatePhase, failures) {
  return { event: 'worker_gate_failed', ts, ticket_id: ticket, gate_phase: gatePhase, failures, retry_count: 0 };
}

// PRD Evidence timeline, session 2026-08-13-1a29993f (must FAIL the predicate)
const EVIDENCE_TIMELINE = [
  spawnEvt('2026-08-13T01:16:04.000Z', '2e77f26e'),
  spawnEvt('2026-08-13T01:26:39.000Z', 'f8559470'),
  gateFailedEvt('2026-08-13T01:52:45.000Z', '2e77f26e', 'test:fast', [{ name: '__timeout__', file: '', message: 'timed out' }]),
  spawnEvt('2026-08-13T01:57:33.000Z', '119acf6a'),
  spawnEvt('2026-08-13T02:17:05.000Z', '185a93ee'),
  gateFailedEvt('2026-08-13T02:31:17.000Z', '119acf6a', 'test:fast', [{ name: '__timeout__', file: '', message: 'timed out' }]),
];

// Same tickets, serialized: each ticket's terminal event lands before the next spawn.
const SERIALIZED_TIMELINE = [
  spawnEvt('2026-08-13T01:16:04.000Z', '2e77f26e'),
  gateFailedEvt('2026-08-13T01:26:00.000Z', '2e77f26e', 'test:fast', []),
  spawnEvt('2026-08-13T01:26:39.000Z', 'f8559470'),
  gateFailedEvt('2026-08-13T01:52:00.000Z', 'f8559470', 'test:fast', []),
  spawnEvt('2026-08-13T01:57:33.000Z', '119acf6a'),
  gateFailedEvt('2026-08-13T02:16:00.000Z', '119acf6a', 'test:fast', []),
  spawnEvt('2026-08-13T02:17:05.000Z', '185a93ee'),
];

test('findOverlapViolations: PRD Evidence timeline fails, naming the offending pairs', () => {
  // The quoted PRD excerpt never shows f8559470's own terminal event, so — honestly —
  // a third pair (f8559470 -> 119acf6a) is ALSO unresolved-overlap within this literal
  // window; the predicate reports all three rather than silently narrowing to the two
  // pairs the PRD prose calls out by name.
  const violations = findOverlapViolations(EVIDENCE_TIMELINE);
  assert.equal(violations.length, 3);
  assert.equal(violations[0].priorTicket, '2e77f26e');
  assert.equal(violations[0].nextTicket, 'f8559470');
  assert.equal(violations[1].priorTicket, 'f8559470');
  assert.equal(violations[1].nextTicket, '119acf6a');
  assert.equal(violations[2].priorTicket, '119acf6a');
  assert.equal(violations[2].nextTicket, '185a93ee');
});

test('findOverlapViolations: serialized timeline passes', () => {
  const violations = findOverlapViolations(SERIALIZED_TIMELINE);
  assert.deepEqual(violations, []);
});

// AP-EXT-ITER6-01: every fixture above hands EVERY ticket a `worker_gate_failed`, so the
// gate-red branch was the only hand-off the predicate had ever been driven through. A ticket
// that finishes CLEANLY never emits one — its manager-side terminal event is
// `boundary_commit_resolved` (mux-runner:commitGatePassingDeliverableAtBoundary). Shapes below
// are copied from real session 2026-08-20-54c74299, where Done ticket 7c91858f was reported as
// an overlap violation 11 minutes after it had already resolved its boundary commit.
function boundaryCommitEvt(ts, ticket, outcome = 'committed') {
  return {
    event: 'boundary_commit_resolved', ts, ticket,
    gate_payload: { outcome, pre_iter_sha: 'cda524e6', post_iter_sha: '8829b15d' },
  };
}

test('findOverlapViolations: a cleanly-completed prior ticket is not an overlap', () => {
  const activity = [
    spawnEvt('2026-08-21T14:15:55.262Z', '7c91858f'),
    boundaryCommitEvt('2026-08-21T14:33:02.445Z', '7c91858f'),
    spawnEvt('2026-08-21T14:44:50.519Z', '87b562c2'),
  ];
  assert.deepEqual(findOverlapViolations(activity), []);
});

test('findOverlapViolations: worker_completion_commit_announced is NOT terminal', () => {
  // spawn-morty writes this from the LIVE worker's stdout, so it proves the worker is
  // running, not that it stopped. Counting it would mask a genuine overlap.
  const activity = [
    spawnEvt('2026-08-21T14:15:55.262Z', '7c91858f'),
    {
      event: 'worker_completion_commit_announced', ts: '2026-08-21T14:33:02.445Z',
      ticket_id: '7c91858f', source: 'pickle', sha: '0df05c84',
    },
    spawnEvt('2026-08-21T14:44:50.519Z', '87b562c2'),
  ];
  const violations = findOverlapViolations(activity);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].priorTicket, '7c91858f');
  assert.equal(violations[0].nextTicket, '87b562c2');
});

test('buildGateCompletionReport: tier_phase_skipped ticket is not_run, distinct from a timeout', () => {
  const activity = [
    spawnEvt('2026-08-14T00:00:00.000Z', 'aaaa1111'),
    {
      event: 'tier_phase_skipped', ts: '2026-08-14T00:00:01.000Z', ticket_id: 'aaaa1111',
      tier: 'small', skipped_phases: ['test:fast'],
    },
  ];
  const report = buildGateCompletionReport(activity);
  const t = report.tickets.find((x) => x.ticket === 'aaaa1111');
  assert.equal(t.skipped, true);
  assert.equal(t.timedOut, false);
  assert.equal(t.observedCompletion, false);
  assert.equal(t.reason, 'skipped');
});

test('buildGateCompletionReport: __timeout__ failure marks timedOut, not observed', () => {
  const activity = [
    spawnEvt('2026-08-14T00:00:00.000Z', 'bbbb2222'),
    gateFailedEvt('2026-08-14T00:30:00.000Z', 'bbbb2222', 'test:fast', [{ name: '__timeout__', file: '', message: 'timed out' }]),
  ];
  const report = buildGateCompletionReport(activity);
  const t = report.tickets.find((x) => x.ticket === 'bbbb2222');
  assert.equal(t.timedOut, true);
  assert.equal(t.observedCompletion, false);
  assert.equal(t.wallClockMs, 30 * 60 * 1000);
  assert.equal(report.summary.timeouts, 1);
});

test('buildGateCompletionReport: a spawned ticket with no negative signal is an observed completion', () => {
  const activity = [spawnEvt('2026-08-14T00:00:00.000Z', 'cccc3333')];
  const report = buildGateCompletionReport(activity);
  const t = report.tickets.find((x) => x.ticket === 'cccc3333');
  assert.equal(t.observedCompletion, true);
  assert.equal(t.reason, 'observed');
  assert.equal(report.summary.observedCompletions, 1);
  assert.equal(report.summary.verdict, '1 observed completions, 0 timeouts');
});

test('buildGateCompletionReport: narrow tier forces every ticket to non-observed, even absent negative signal', () => {
  const activity = [spawnEvt('2026-08-14T00:00:00.000Z', 'dddd4444')];
  const report = buildGateCompletionReport(activity, { workerGateTier: 'narrow' });
  const t = report.tickets.find((x) => x.ticket === 'dddd4444');
  assert.equal(t.observedCompletion, false);
  assert.equal(t.reason, 'narrow_tier_shortcircuit');
  assert.equal(report.narrowTierVacuity, true);
  assert.equal(report.summary.observedCompletions, 0);
});

test('buildGateCompletionReport: a zero-fast-tier-phase timeline reports zero observed completions, not a pass', () => {
  const report = buildGateCompletionReport([]);
  assert.equal(report.tickets.length, 0);
  assert.equal(report.summary.observedCompletions, 0);
  assert.equal(report.summary.verdict, '0 observed completions, 0 timeouts');
});

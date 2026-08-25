// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  findOverlapViolations,
  buildGateCompletionReport,
} from '../services/activity-timeline-verifier.js';
import { runVerifyActivityTimeline } from '../bin/verify-activity-timeline.js';

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

// ---------------------------------------------------------------------------
// AP-EXT-ITER39-01: a terminal event from a PRIOR run of the same ticket must
// not vouch for its CURRENT run. Relaunch is routine (silent_death_respawn_cap,
// bounded_terminal_escape_cap), and measured live: 6 of 8 tickets in session
// 2026-08-22-a1e33756 were re-spawned. Assert the CLI VERDICT ("OVERLAP: none",
// exit 0) — the pre-fix predicate returned a well-formed empty array, so a
// "does it throw" or shape oracle greens over the whole defect.
// ---------------------------------------------------------------------------

function boundaryEvt(ts, ticket) {
  return { event: 'boundary_commit_resolved', ts, ticket_id: ticket };
}

function withSessionDir(activity, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-atv-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({ session_dir: dir, working_dir: dir, activity }),
    );
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('AP-EXT-ITER39-01: a relaunched ticket with no terminal for its LAST run is an overlap', () => {
  // A run 1 ends (gate_failed). A relaunches — run 2 never terminates. B spawns.
  const activity = [
    spawnEvt('2026-08-22T10:00:00.000Z', 'aaaa1111'),
    gateFailedEvt('2026-08-22T10:05:00.000Z', 'aaaa1111', 'test:fast', []),
    spawnEvt('2026-08-22T10:06:00.000Z', 'aaaa1111'),
    spawnEvt('2026-08-22T10:10:00.000Z', 'bbbb2222'),
  ];

  const violations = findOverlapViolations(activity);
  assert.equal(violations.length, 1, 'run-2 of aaaa1111 had no terminal before bbbb2222 spawned');
  assert.equal(violations[0].priorTicket, 'aaaa1111');
  assert.equal(violations[0].nextTicket, 'bbbb2222');
  // The reported prior spawn must be run 2's, not run 1's — otherwise the
  // operator is pointed at a run that DID terminate.
  assert.equal(violations[0].priorSpawnTs, '2026-08-22T10:06:00.000Z');

  const { exitCode, output } = withSessionDir(activity, runVerifyActivityTimeline);
  assert.equal(exitCode, 1, 'the CLI must not exit 0 over a live overlap');
  assert.match(output, /OVERLAP: 1 violation/);
  assert.doesNotMatch(output, /OVERLAP: none/);
});

test('AP-EXT-ITER39-01: a stale terminal cannot vouch across an interleaved re-spawn', () => {
  // A ends, B ends, A is RETRIED and never terminates, C spawns.
  const activity = [
    spawnEvt('2026-08-22T10:00:00.000Z', 'aaaa1111'),
    boundaryEvt('2026-08-22T10:01:00.000Z', 'aaaa1111'),
    spawnEvt('2026-08-22T10:02:00.000Z', 'bbbb2222'),
    boundaryEvt('2026-08-22T10:03:00.000Z', 'bbbb2222'),
    spawnEvt('2026-08-22T10:04:00.000Z', 'aaaa1111'),
    spawnEvt('2026-08-22T10:05:00.000Z', 'cccc3333'),
  ];

  const violations = findOverlapViolations(activity);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].priorTicket, 'aaaa1111');
  assert.equal(violations[0].nextTicket, 'cccc3333');
});

test('AP-EXT-ITER39-01 control: a relaunched ticket that DOES terminate is not an overlap', () => {
  // Same relaunch shape, but run 2 resolves its boundary before B spawns.
  // Narrowing the window must not manufacture a violation here.
  const activity = [
    spawnEvt('2026-08-22T10:00:00.000Z', 'aaaa1111'),
    gateFailedEvt('2026-08-22T10:05:00.000Z', 'aaaa1111', 'test:fast', []),
    spawnEvt('2026-08-22T10:06:00.000Z', 'aaaa1111'),
    boundaryEvt('2026-08-22T10:09:00.000Z', 'aaaa1111'),
    spawnEvt('2026-08-22T10:10:00.000Z', 'bbbb2222'),
  ];

  assert.deepEqual(findOverlapViolations(activity), []);

  const { exitCode, output } = withSessionDir(activity, runVerifyActivityTimeline);
  assert.equal(exitCode, 0);
  assert.match(output, /OVERLAP: none/);
});

test('AP-EXT-ITER39-01 control: a terminal exactly AT the spawn instant still counts', () => {
  // The window is inclusive at both ends: a terminal landing on the same
  // millisecond as its own run's spawn is that run's terminal, not a stale one.
  const activity = [
    spawnEvt('2026-08-22T10:00:00.000Z', 'aaaa1111'),
    boundaryEvt('2026-08-22T10:00:00.000Z', 'aaaa1111'),
    spawnEvt('2026-08-22T10:00:00.000Z', 'bbbb2222'),
  ];
  assert.deepEqual(findOverlapViolations(activity), []);
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER4-01: the AP-EXT-ITER39-01 staleness rule — an event from one run
// must never be paired with another run of the same ticket — was fixed in
// `findOverlapViolations` only. `collectSpawnTsByTicket` kept the FIRST spawn and
// `computeWallClockMs` subtracted it from a terminal that may belong to a much
// later run, charging the ticket every idle second between its runs.
//
// Measured on real sessions before the fix: `a38de7dc` (2026-08-24-218474cb)
// reported 46m for a run that took 8m; `b94d8693` (2026-08-22-b2ecaea6) 43m for 7m.
// Relaunch is not an edge case — 24 of 42 ticket entries across the 7 real
// sessions on this box were re-spawned.
//
// Asserts the operator-visible `wall_clock_ms` COLUMN, not just the pure
// function: the pre-fix code returned a well-formed positive number, so a
// "is it a number" oracle greens over the whole defect.
// ---------------------------------------------------------------------------

test('AP-EXT-ITER4-01: a relaunched ticket is measured from the spawn its terminal belongs to', () => {
  // Run 1 resolves cleanly at +20m. Run 2 relaunches 2h after run 1 and times out 30m in.
  const activity = [
    spawnEvt('2026-08-22T10:00:00.000Z', 'aaaa1111'),
    boundaryEvt('2026-08-22T10:20:00.000Z', 'aaaa1111'),
    spawnEvt('2026-08-22T12:00:00.000Z', 'aaaa1111'),
    gateFailedEvt('2026-08-22T12:30:00.000Z', 'aaaa1111', 'test:fast', [{ name: '__timeout__', file: '', message: 'timed out' }]),
  ];

  const report = buildGateCompletionReport(activity);
  const t = report.tickets.find((x) => x.ticket === 'aaaa1111');
  assert.equal(t.timedOut, true);
  assert.equal(
    t.wallClockMs,
    30 * 60 * 1000,
    'the timing-out run took 30m; anchoring on run 1 reports the 150m since its spawn',
  );

  const { output } = withSessionDir(activity, runVerifyActivityTimeline);
  assert.match(output, /aaaa1111 \| false \| 1800000 \|/);
  assert.doesNotMatch(output, /\| 9000000 \|/);
});

test('AP-EXT-ITER4-01: three runs anchor on the third, not the first', () => {
  const activity = [
    spawnEvt('2026-08-22T10:00:00.000Z', 'bbbb2222'),
    boundaryEvt('2026-08-22T10:05:00.000Z', 'bbbb2222'),
    spawnEvt('2026-08-22T11:00:00.000Z', 'bbbb2222'),
    boundaryEvt('2026-08-22T11:05:00.000Z', 'bbbb2222'),
    spawnEvt('2026-08-22T12:00:00.000Z', 'bbbb2222'),
    gateFailedEvt('2026-08-22T12:10:00.000Z', 'bbbb2222', 'test:fast', []),
  ];
  const t = buildGateCompletionReport(activity).tickets.find((x) => x.ticket === 'bbbb2222');
  assert.equal(t.wallClockMs, 10 * 60 * 1000);
});

test('AP-EXT-ITER4-01 control: a single-run ticket measures exactly as before', () => {
  const activity = [
    spawnEvt('2026-08-14T00:00:00.000Z', 'cccc3333'),
    gateFailedEvt('2026-08-14T00:30:00.000Z', 'cccc3333', 'test:fast', [{ name: '__timeout__', file: '', message: 'timed out' }]),
  ];
  const t = buildGateCompletionReport(activity).tickets.find((x) => x.ticket === 'cccc3333');
  assert.equal(t.wallClockMs, 30 * 60 * 1000);
});

test('AP-EXT-ITER4-01: a terminal preceding every spawn reports no measurement, not a negative one', () => {
  // Truncated day-file / clock skew: the terminal has no owning run in the window.
  const activity = [
    gateFailedEvt('2026-08-22T09:00:00.000Z', 'dddd4444', 'test:fast', []),
    spawnEvt('2026-08-22T10:00:00.000Z', 'dddd4444'),
  ];
  const t = buildGateCompletionReport(activity).tickets.find((x) => x.ticket === 'dddd4444');
  assert.equal(t.wallClockMs, null, 'a negative duration is not a measurement');

  const { output } = withSessionDir(activity, runVerifyActivityTimeline);
  assert.match(output, /dddd4444 \| false \| n\/a \|/);
});

test('AP-EXT-ITER4-01: a spawned ticket with unparseable spawn timestamps is still reported', () => {
  // Dropping the ticket to avoid an unanchored measurement would delete a spawned
  // ticket from the operator's table — the reverse of the honesty this file exists for.
  const activity = [
    { event: 'worker_spawn_backend_resolved', ts: 'not-a-timestamp', ticket: 'eeee5555' },
  ];
  const report = buildGateCompletionReport(activity);
  const t = report.tickets.find((x) => x.ticket === 'eeee5555');
  assert.ok(t, 'the ticket was spawned; it must appear in the report');
  assert.equal(t.spawned, true);
  assert.equal(t.wallClockMs, null);
});

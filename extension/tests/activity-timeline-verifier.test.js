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

// ---------------------------------------------------------------------------
// AP-EXT-ITER148-01: an "observed completion" must rest on a POSITIVE terminal.
//
// The predecessor derived it from absence alone (`!narrowTierVacuity && !skipped &&
// !timedOut && !failedNonTimeout`), so a ticket that was spawned and never heard from
// again — killed run, halt, still in flight — was indistinguishable from one that
// finished. Measured over the 74 real spawned tickets in this box's 7 sessions: 59 read
// `observed`, and 56 of those carried NO terminal event of any kind. The case this
// replaces asserted exactly that behaviour, which is why the defect shipped green.
//
// The clean terminal is `boundary_commit_resolved` — the SAME vocabulary
// `findOverlapViolations` was already hardened onto by AP-EXT-ITER6-01, which had
// established that `worker_completion_commit_announced` is written from the LIVE
// worker's stdout and is not terminal. `classifyTicketGate` read that non-terminal
// event instead; no manager emits it (0 occurrences across those 7 sessions, against 10
// for `boundary_commit_resolved`), so its clean arm never fired.
// ---------------------------------------------------------------------------

test('AP-EXT-ITER148-01: a spawned ticket with NO terminal event is unresolved, not observed', () => {
  const activity = [spawnEvt('2026-08-14T00:00:00.000Z', 'cccc3333')];
  const report = buildGateCompletionReport(activity);
  const t = report.tickets.find((x) => x.ticket === 'cccc3333');
  assert.equal(t.observedCompletion, false, 'absence of a negative signal is not evidence of completion');
  assert.equal(t.reason, 'unresolved');
  assert.equal(t.wallClockMs, null, 'nothing ended, so there is nothing to measure');
  assert.equal(report.summary.observedCompletions, 0);
  assert.equal(report.summary.unresolved, 1);
  assert.equal(report.summary.verdict, '0 observed completions, 0 timeouts, 1 unresolved');
});

test('AP-EXT-ITER148-01 positive control: a clean boundary IS an observed completion, and is measured', () => {
  // The negative case above is satisfiable by a predicate that never says "observed";
  // this control fails such a collapse, and pins the wall clock the dead clean-terminal
  // channel could never produce.
  const activity = [
    spawnEvt('2026-08-14T00:00:00.000Z', 'dddd4444'),
    boundaryEvt('2026-08-14T00:12:00.000Z', 'dddd4444'),
  ];
  const report = buildGateCompletionReport(activity);
  const t = report.tickets.find((x) => x.ticket === 'dddd4444');
  assert.equal(t.observedCompletion, true);
  assert.equal(t.reason, 'observed');
  assert.equal(t.wallClockMs, 12 * 60 * 1000, 'the clean terminal must anchor a measurement');
  assert.equal(report.summary.observedCompletions, 1);
  assert.equal(report.summary.unresolved, 0);
});

test('AP-EXT-ITER148-01: worker_completion_commit_announced does not make a ticket observed', () => {
  // The exact event the predecessor read. It is written from the live worker's stdout,
  // so it proves the worker was RUNNING — the same reason AP-EXT-ITER6-01 keeps it out
  // of findOverlapViolations' terminal set. Both readers must agree on that.
  const activity = [
    spawnEvt('2026-08-14T00:00:00.000Z', 'eeee5555'),
    {
      event: 'worker_completion_commit_announced', ts: '2026-08-14T00:12:00.000Z',
      ticket_id: 'eeee5555', source: 'pickle', sha: '0df05c84',
    },
  ];
  const t = buildGateCompletionReport(activity).tickets.find((x) => x.ticket === 'eeee5555');
  assert.equal(t.observedCompletion, false);
  assert.equal(t.reason, 'unresolved');
  assert.equal(t.wallClockMs, null, 'a live-worker event must not anchor a run duration');
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
  assert.equal(report.summary.verdict, '0 observed completions, 0 timeouts, 0 unresolved');
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
  // Run 1 never resolves — no terminal of any kind, which is WHY it was relaunched (the
  // dominant real shape: 56 of the 74 spawned tickets on this box end with no terminal).
  // Run 2 relaunches 2h after run 1 and times out 30m in. Run 1 deliberately carries no
  // `boundaryEvt`: with the clean-terminal channel live (AP-EXT-ITER148-01) a run-1
  // boundary would become the EARLIEST terminal, and measuring it from run 1's own spawn
  // is a number an anchor-on-first-spawn bug also produces — the case would stop
  // discriminating the very defect it exists for.
  const activity = [
    spawnEvt('2026-08-22T10:00:00.000Z', 'aaaa1111'),
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
    // Runs 1 and 2 leave no terminal; only run 3 resolves. Same reason as the case above:
    // an earlier run's terminal is measurable from that run's OWN spawn, so it cannot
    // discriminate anchor-on-first from anchor-on-owning-run.
    spawnEvt('2026-08-22T10:00:00.000Z', 'bbbb2222'),
    spawnEvt('2026-08-22T11:00:00.000Z', 'bbbb2222'),
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

// ---------------------------------------------------------------------------
// AP-EXT-ITER82-01: the overlap check was gated on `ticket !== lastTicket`, so a
// ticket re-spawned over its own still-live predecessor was never examined at all —
// not even against the AP-EXT-ITER39-01 window one line below it.
//
// Serialization does not turn on ticket identity: `acquireWorkerSpawnLock` admits one
// worker per SESSION. A same-ticket relaunch over a live predecessor races two workers
// inside ONE ticket directory, which is the worse shape, not the exempt one.
//
// Measured before the fix over the 14 real sessions on the authoring box: 40 consecutive
// same-ticket spawn pairs held no terminal event in their window and every one reported
// `OVERLAP: none`. Asserts the operator-visible CLI verdict, not just the array length —
// the pre-fix predicate returned a well-formed empty array, so a shape oracle greens over
// the entire defect.
// ---------------------------------------------------------------------------

test('AP-EXT-ITER82-01: a ticket re-spawned with no terminal for its prior run is an overlap', () => {
  const activity = [
    spawnEvt('2026-08-22T10:00:00.000Z', 'aaaa1111'),
    spawnEvt('2026-08-22T10:06:00.000Z', 'aaaa1111'),
  ];

  const violations = findOverlapViolations(activity);
  assert.equal(violations.length, 1, 'run 1 of aaaa1111 had no terminal when run 2 spawned');
  assert.equal(violations[0].priorTicket, 'aaaa1111');
  assert.equal(violations[0].nextTicket, 'aaaa1111');
  assert.equal(violations[0].priorSpawnTs, '2026-08-22T10:00:00.000Z');
  assert.equal(violations[0].nextSpawnTs, '2026-08-22T10:06:00.000Z');

  const { exitCode, output } = withSessionDir(activity, runVerifyActivityTimeline);
  assert.equal(exitCode, 1, 'the CLI must not exit 0 over a same-ticket overlap');
  assert.match(output, /OVERLAP: 1 violation/);
  assert.doesNotMatch(output, /OVERLAP: none/);
});

test('AP-EXT-ITER82-01 control: a serialized relaunch of the same ticket is not an overlap', () => {
  // Identical shape, but run 1 resolves its boundary before run 2 spawns. Dropping the
  // ticket-identity precondition must not manufacture a violation over routine relaunch.
  const activity = [
    spawnEvt('2026-08-22T10:00:00.000Z', 'aaaa1111'),
    boundaryEvt('2026-08-22T10:05:00.000Z', 'aaaa1111'),
    spawnEvt('2026-08-22T10:06:00.000Z', 'aaaa1111'),
    boundaryEvt('2026-08-22T10:09:00.000Z', 'aaaa1111'),
  ];

  assert.deepEqual(findOverlapViolations(activity), []);

  const { exitCode, output } = withSessionDir(activity, runVerifyActivityTimeline);
  assert.equal(exitCode, 0);
  assert.match(output, /OVERLAP: none/);
});

test('AP-EXT-ITER82-01: a stale terminal cannot vouch across a same-ticket re-spawn', () => {
  // run 1 terminates, run 2 does not, run 3 spawns. The window's lower bound must pin the
  // check to run 2 — run 1's boundary is not allowed to vouch for it.
  const activity = [
    spawnEvt('2026-08-22T10:00:00.000Z', 'aaaa1111'),
    boundaryEvt('2026-08-22T10:01:00.000Z', 'aaaa1111'),
    spawnEvt('2026-08-22T10:02:00.000Z', 'aaaa1111'),
    spawnEvt('2026-08-22T10:03:00.000Z', 'aaaa1111'),
  ];

  const violations = findOverlapViolations(activity);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].priorSpawnTs, '2026-08-22T10:02:00.000Z');
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER115-01 — the CLI must read the gate tier from the EXTENSION ROOT
//
// `resolveWorkerGateTier(root)` reads `<root>/pickle_settings.json`. The CLI used to
// hand it `state.working_dir` — the TARGET repo — which carries that file only when the
// target happens to BE the pickle-rick source tree. Everywhere else the read missed and
// the resolver fell through to its `'fast'` default silently, pinning `narrowTierVacuity`
// false. A narrow-tier run emits no per-ticket gate event at all, so every spawned ticket
// then printed as an observed completion: a gate that never ran reported as a gate that
// passed.
//
// The fixture is deliberately NOT "settings absent". A decoy `pickle_settings.json` sits
// in the working dir declaring the OPPOSITE tier, so the assertion can only pass if the
// reader actually switched roots — an oracle that merely observed the default would stay
// green if the argument were changed to any other settings-less path.
function withTierRoots(workingDirTier, extensionRootTier, activity, fn) {
  const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-atv-extroot-'));
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-atv-sess-'));
  const priorExtensionDir = process.env.EXTENSION_DIR;
  try {
    // INSTALL_ROOT_SENTINEL, so getExtensionRoot() honors EXTENSION_DIR without needing
    // the NODE_ENV/EXTENSION_DIR_TEST escape hatch.
    fs.writeFileSync(path.join(extRoot, '.pickle-install-root'), '');
    fs.writeFileSync(
      path.join(extRoot, 'pickle_settings.json'),
      JSON.stringify({ worker_gate_tier: extensionRootTier }),
    );
    fs.writeFileSync(
      path.join(sessionDir, 'pickle_settings.json'),
      JSON.stringify({ worker_gate_tier: workingDirTier }),
    );
    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      JSON.stringify({ session_dir: sessionDir, working_dir: sessionDir, activity }),
    );
    process.env.EXTENSION_DIR = extRoot;
    return fn(sessionDir);
  } finally {
    if (priorExtensionDir === undefined) delete process.env.EXTENSION_DIR;
    else process.env.EXTENSION_DIR = priorExtensionDir;
    fs.rmSync(extRoot, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
}

test('AP-EXT-ITER115-01: a narrow tier at the extension root vacates the CLI verdict, even when the working dir says otherwise', () => {
  // A GENUINELY completed run — spawn plus its clean manager-side terminal — so the
  // narrow-tier override is doing the vacating. Bare-spawn fixtures used to read as an
  // observed completion on their own (AP-EXT-ITER148-01); against that predicate this
  // case passed without the override ever having to fire.
  const activity = [
    spawnEvt('2026-08-30T10:00:00.000Z', 'eeee5555'),
    boundaryEvt('2026-08-30T10:15:00.000Z', 'eeee5555'),
  ];

  const { exitCode, output } = withTierRoots('fast', 'narrow', activity, runVerifyActivityTimeline);

  assert.match(
    output,
    /GATE VERDICT: 0 observed completions, 0 timeouts, 0 unresolved \(narrow-tier short-circuit/,
    'a narrow tier emits no per-ticket gate event, so nothing may be counted as observed',
  );
  assert.match(output, /eeee5555 \| false \| 900000 \| false \| narrow_tier_shortcircuit/);
  assert.doesNotMatch(output, /1 observed completions/);
  // The overlap axis is independent of the tier and must be untouched by this fix.
  assert.equal(exitCode, 0);
  assert.match(output, /OVERLAP: none/);
});

test('AP-EXT-ITER115-01 control: a fast tier at the extension root still counts the completion', () => {
  // The non-tautology twin. Same activity, same decoy — only the extension root's tier
  // differs, so an assertion that simply always read "not observed" fails here.
  const activity = [
    spawnEvt('2026-08-30T10:00:00.000Z', 'eeee5555'),
    boundaryEvt('2026-08-30T10:15:00.000Z', 'eeee5555'),
  ];

  const { exitCode, output } = withTierRoots('narrow', 'fast', activity, runVerifyActivityTimeline);

  assert.match(output, /GATE VERDICT: 1 observed completions, 0 timeouts, 0 unresolved/);
  assert.doesNotMatch(output, /narrow-tier short-circuit/);
  assert.match(output, /eeee5555 \| true \| 900000 \| false \| observed/);
  assert.equal(exitCode, 0);
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER155-01: a ticket's DISPOSITION must rest on a terminal from its CURRENT run.
//
// AP-EXT-ITER39-01 established the staleness rule and AP-EXT-ITER4-01 restated it for the
// wall clock, but both PATTERN_SHAPEs name their own function, so neither could see that
// `classifyTicketGate` scanned the WHOLE activity array for a terminal naming the ticket.
// Run 1's boundary therefore vouched for run N forever — the precise failure the overlap
// comment warns about, live in the sibling reader one function away.
//
// MEASURED over the 74 real spawned tickets in this box's 7 sessions: 5 of the 6 `observed`
// verdicts rested on a clean boundary PRECEDING the ticket's last spawn with no terminal at
// all after it (`5209a55d` in 2026-08-31-fa2fdee6 was its whole session's single "observed
// completion", off three run-1..3 boundaries while run 4 vanished), and 2 more read `failed`
// off a gate failure from an earlier run. AP-EXT-ITER148-01 corrected the headline from 59
// to 6; ground truth is 1.
//
// Asserts the operator-visible CLI column as well as the pure report: the pre-fix code
// returned a well-formed disposition, so a "is it a string" oracle greens over the defect.
// ---------------------------------------------------------------------------

test('AP-EXT-ITER155-01: a clean boundary from an EARLIER run does not make the current run observed', () => {
  const activity = [
    spawnEvt('2026-08-31T19:48:33.000Z', '5209a55d'),
    boundaryEvt('2026-08-31T20:04:30.000Z', '5209a55d'),
    spawnEvt('2026-08-31T20:45:03.000Z', '5209a55d'),
  ];
  const report = buildGateCompletionReport(activity);
  const t = report.tickets.find((x) => x.ticket === '5209a55d');
  assert.equal(t.observedCompletion, false, "run 1's boundary cannot vouch for run 2");
  assert.equal(t.reason, 'unresolved');
  assert.equal(t.wallClockMs, null, 'the current run never ended, so there is nothing to measure');
  assert.equal(report.summary.observedCompletions, 0);
  assert.equal(report.summary.unresolved, 1);

  const { output } = withSessionDir(activity, runVerifyActivityTimeline);
  assert.match(output, /5209a55d \| false \| n\/a \| false \| unresolved/);
});

test('AP-EXT-ITER155-01: a gate failure from an EARLIER run does not make the current run failed', () => {
  // The same defect on the negative channel: `e98d9866` (2026-08-26-27e0ac68) read `failed`
  // off a run-1 gate red while its run-2 spawn produced no terminal at all.
  const activity = [
    spawnEvt('2026-08-26T13:07:00.000Z', 'e98d9866'),
    gateFailedEvt('2026-08-26T13:16:56.000Z', 'e98d9866', 'test:fast', []),
    spawnEvt('2026-08-26T13:21:36.000Z', 'e98d9866'),
  ];
  const t = buildGateCompletionReport(activity).tickets.find((x) => x.ticket === 'e98d9866');
  assert.equal(t.failedNonTimeout, false, "run 1's gate red is not evidence that run 2 ended");
  assert.equal(t.reason, 'unresolved');
});

test('AP-EXT-ITER155-01 control: a relaunched ticket whose LAST run terminates is still observed', () => {
  // The two cases above are satisfiable by a bound that discards every terminal. This one
  // is not: the run bound must admit the current run's own terminal, and measure from it.
  const activity = [
    spawnEvt('2026-08-31T19:48:33.000Z', 'aaaa1111'),
    boundaryEvt('2026-08-31T20:04:30.000Z', 'aaaa1111'),
    spawnEvt('2026-08-31T20:45:03.000Z', 'aaaa1111'),
    boundaryEvt('2026-08-31T21:00:03.000Z', 'aaaa1111'),
  ];
  const report = buildGateCompletionReport(activity);
  const t = report.tickets.find((x) => x.ticket === 'aaaa1111');
  assert.equal(t.observedCompletion, true);
  assert.equal(t.reason, 'observed');
  assert.equal(t.wallClockMs, 15 * 60 * 1000, "measured from run 2's spawn, not run 1's");
  assert.equal(report.summary.observedCompletions, 1);
});

test('AP-EXT-ITER155-01 control: a terminal exactly AT the last spawn instant still counts', () => {
  // Mirrors the AP-EXT-ITER39-01 boundary-equality control: the bound is `>=`, so a
  // same-instant terminal is inside the current run, not stale.
  const activity = [
    spawnEvt('2026-08-22T10:00:00.000Z', 'bbbb2222'),
    spawnEvt('2026-08-22T11:00:00.000Z', 'bbbb2222'),
    boundaryEvt('2026-08-22T11:00:00.000Z', 'bbbb2222'),
  ];
  const t = buildGateCompletionReport(activity).tickets.find((x) => x.ticket === 'bbbb2222');
  assert.equal(t.observedCompletion, true);
  assert.equal(t.wallClockMs, 0, 'a same-instant terminal measures zero, not null');
});

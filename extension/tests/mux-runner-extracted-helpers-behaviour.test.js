// @tier: integration
/**
 * R2a (ticket 42cac5ca) — behavioural coverage for the three newest helpers extracted
 * from `runMuxRunnerMain`: `runPreSpawnLivenessWatchdogs`, `classifyAndRecordIterationEnd`
 * and `muxEpicFinalizeScan`. A live mutant in each turned 0 of 4615 candidate tests red.
 *
 * Every case CALLS the compiled helper against a real temp session (state.json, ticket
 * files, activity jsonl, git repos) and asserts what it DID: the returned step, the
 * state.json writes, the exit_reason stamps, the activity events, the tracker/anchor
 * mutations and, where there are several, their order. No source text is read.
 *
 * Integration tier: the CPU liveness arm samples `ps`, and the finalize scan's Failed
 * ticket exclusion shells out to git.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');

// Sandbox the data root BEFORE the module loads, so no activity or session-map write can
// reach the operator's real ~/.local/share/pickle-rick.
const DATA_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-extracted-helpers-')));
process.env.PICKLE_DATA_ROOT = DATA_ROOT;
delete process.env.PICKLE_REFINEMENT_LOCK;
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete process.env[key];

const reapDataRoot = () => fs.rmSync(DATA_ROOT, { recursive: true, force: true });
process.on('exit', reapDataRoot);
after(reapDataRoot);

const mux = await import('../bin/mux-runner.js');

const THRESHOLD_SECONDS = 60;
let sessionSeq = 0;

function makeSession(overrides = {}) {
  sessionSeq += 1;
  const sessionDir = path.join(DATA_ROOT, 'sessions', `2026-09-15-r2a${String(sessionSeq).padStart(4, '0')}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  const statePath = path.join(sessionDir, 'state.json');
  const state = {
    active: true,
    working_dir: sessionDir,
    step: 'implement',
    iteration: 4,
    max_iterations: 10,
    max_time_minutes: 0,
    worker_timeout_seconds: 3600,
    start_time_epoch: Date.now(),
    completion_promise: null,
    original_prompt: 'r2a fixture',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 5,
    worker_artifact_progress: {},
    ...overrides,
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return { sessionDir, statePath, state };
}

function readState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function writeTicket(sessionDir, id, status, order) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(
    path.join(ticketDir, `rick_ticket_${id}.md`),
    ['---', `id: "${id}"`, `status: "${status}"`, `order: ${order}`, '---', `# ${id}`].join('\n'),
  );
  return ticketDir;
}

/** Activity events this session wrote to the sandboxed jsonl sink. */
function readActivity(sessionDir, event) {
  const dir = path.join(DATA_ROOT, 'activity');
  if (!fs.existsSync(dir)) return [];
  const session = path.basename(sessionDir);
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n'))
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((e) => e.session === session && e.event === event);
}

/** A clock that advances one second per read and remembers every value it handed out. */
function steppingClock(startMs) {
  const readings = [];
  const now = () => {
    const value = startMs + readings.length * 1000;
    readings.push(value);
    return value;
  };
  return { now, readings };
}

function emptyAnchor() {
  return {
    cpuLivenessTicketId: null,
    cpuLivenessAnchorPid: null,
    cpuLivenessAnchorEpoch: 0,
    cpuLivenessAnchorCpuSeconds: null,
    cpuLivenessAnchorMtimeMs: 0,
  };
}

/** An anchor no code path would ever produce: any CPU-watchdog pass rewrites it. */
function sentinelAnchor() {
  return {
    cpuLivenessTicketId: 'sentinel-ticket',
    cpuLivenessAnchorPid: 424242,
    cpuLivenessAnchorEpoch: 1,
    cpuLivenessAnchorCpuSeconds: 7,
    cpuLivenessAnchorMtimeMs: 1,
  };
}

function livenessInput(session, { now, lastProgressEpoch, anchor, ...overrides }) {
  const logs = [];
  const stallTrackers = { lastStateIteration: 4, stallCount: 2, lastProgressEpoch };
  const input = {
    state: session.state,
    statePath: session.statePath,
    sessionDir: session.sessionDir,
    extensionRoot: EXTENSION_ROOT,
    iteration: 5,
    curIter: 4,
    now,
    idleStallThresholdSeconds: THRESHOLD_SECONDS,
    idleStallRecoveryCap: 3,
    idleStallRecoveryCount: 0,
    cbEnabled: false,
    cbState: null,
    stallTrackers,
    anchor,
    log: (msg) => logs.push(msg),
    ...overrides,
  };
  return { input, logs, stallTrackers };
}

// ─────────────────────────── runPreSpawnLivenessWatchdogs ───────────────────────────

test('runPreSpawnLivenessWatchdogs: fresh progress and no ticket proceeds, carrying the recovery count and touching nothing', () => {
  const session = makeSession();
  const before = fs.readFileSync(session.statePath, 'utf8');
  const clock = steppingClock(50_000_000);
  const anchor = emptyAnchor();
  const { input, stallTrackers } = livenessInput(session, {
    now: clock.now, lastProgressEpoch: 50_000_000, anchor, idleStallRecoveryCount: 2,
  });

  const step = mux.runPreSpawnLivenessWatchdogs(input);

  assert.deepEqual(step, { kind: 'proceed', idleStallRecoveryCount: 2 });
  assert.equal(fs.readFileSync(session.statePath, 'utf8'), before, 'state.json must not be written');
  assert.deepEqual(stallTrackers, { lastStateIteration: 4, stallCount: 2, lastProgressEpoch: 50_000_000 });
  assert.deepEqual(anchor, emptyAnchor());
  assert.equal(readActivity(session.sessionDir, 'mux_idle_stall_detected').length, 0);
});

test('runPreSpawnLivenessWatchdogs: a live rate-limit park gates the idle watchdog off however stale progress is', () => {
  const session = makeSession();
  fs.writeFileSync(
    path.join(session.sessionDir, 'rate_limit_wait.json'),
    JSON.stringify({ wait_until: new Date(Date.now() + 3_600_000).toISOString() }),
  );
  const before = fs.readFileSync(session.statePath, 'utf8');
  const clock = steppingClock(60_000_000);
  const { input, stallTrackers } = livenessInput(session, {
    now: clock.now, lastProgressEpoch: 60_000_000 - 3_600_000, anchor: emptyAnchor(),
  });

  const step = mux.runPreSpawnLivenessWatchdogs(input);

  assert.deepEqual(step, { kind: 'proceed', idleStallRecoveryCount: 0 });
  assert.equal(fs.readFileSync(session.statePath, 'utf8'), before);
  assert.equal(stallTrackers.stallCount, 2, 'a gated watchdog must not reset the stall trackers');
  assert.equal(readActivity(session.sessionDir, 'mux_idle_stall_detected').length, 0);
});

test('runPreSpawnLivenessWatchdogs: an idle stall past the recovery cap exits idle_stall_unrecoverable before the CPU watchdog runs', () => {
  const session = makeSession();
  const clock = steppingClock(70_000_000);
  const anchor = sentinelAnchor();
  const { input, stallTrackers } = livenessInput(session, {
    now: clock.now,
    lastProgressEpoch: 70_000_000 - (THRESHOLD_SECONDS + 30) * 1000,
    anchor,
    idleStallRecoveryCap: 0,
  });

  const step = mux.runPreSpawnLivenessWatchdogs(input);

  assert.deepEqual(step, { kind: 'exit', exitReason: 'idle_stall_unrecoverable' });
  const persisted = readState(session.statePath);
  assert.equal(persisted.exit_reason, 'idle_stall_unrecoverable');
  assert.equal(persisted.active, false, 'the escalation must deactivate the session');
  assert.deepEqual(anchor, sentinelAnchor(), 'the CPU watchdog must not run after an idle exit');
  assert.deepEqual(stallTrackers, {
    lastStateIteration: 4, stallCount: 2, lastProgressEpoch: 70_000_000 - (THRESHOLD_SECONDS + 30) * 1000,
  });
  assert.equal(
    readActivity(session.sessionDir, 'mux_idle_stall_detected').length,
    0,
    'the cap escalation is not a self-recovery and emits no stall-detected event',
  );
});

test('runPreSpawnLivenessWatchdogs: an idle stall with no working_dir emits the stall event, then stamps state_working_dir_missing and exits', () => {
  const session = makeSession();
  const passState = { ...session.state };
  delete passState.working_dir;
  const clock = steppingClock(80_000_000);
  const { input } = livenessInput(session, {
    state: passState,
    now: clock.now,
    lastProgressEpoch: 80_000_000 - (THRESHOLD_SECONDS + 5) * 1000,
    anchor: sentinelAnchor(),
  });

  const step = mux.runPreSpawnLivenessWatchdogs(input);

  assert.deepEqual(step, { kind: 'exit', exitReason: 'state_working_dir_missing' });
  const events = readActivity(session.sessionDir, 'mux_idle_stall_detected');
  assert.equal(events.length, 1);
  assert.equal(events[0].iteration, 5);
  assert.deepEqual(
    {
      threshold: events[0].gate_payload.threshold_seconds,
      idle: events[0].gate_payload.idle_seconds,
      observed: events[0].gate_payload.observed_iteration,
    },
    { threshold: THRESHOLD_SECONDS, idle: THRESHOLD_SECONDS + 5, observed: 4 },
  );
  const persisted = readState(session.statePath);
  assert.equal(persisted.exit_reason, 'state_working_dir_missing');
  assert.equal(persisted.active, false);
});

test('runPreSpawnLivenessWatchdogs: a recovered idle stall re-selects the pending ticket, then resets the trackers on a LATER clock read and continues', () => {
  const session = makeSession();
  writeTicket(session.sessionDir, 'aa11', 'Todo', 1);
  const clock = steppingClock(90_000_000);
  const anchor = sentinelAnchor();
  const { input, stallTrackers } = livenessInput(session, {
    now: clock.now,
    lastProgressEpoch: 90_000_000 - (THRESHOLD_SECONDS + 60) * 1000,
    anchor,
  });

  const step = mux.runPreSpawnLivenessWatchdogs(input);

  assert.deepEqual(step, { kind: 'continue', idleStallRecoveryCount: 1 });
  assert.equal(readState(session.statePath).current_ticket, 'aa11', 'self-recovery must persist the re-selected ticket');
  assert.equal(readActivity(session.sessionDir, 'mux_idle_stall_detected').length, 1);
  // Ordering: the decision read the clock once, and the tracker reset read it AFTER recovery.
  assert.equal(clock.readings.length, 2);
  assert.deepEqual(stallTrackers, { lastStateIteration: -1, stallCount: 0, lastProgressEpoch: clock.readings[1] });
  assert.deepEqual(anchor, sentinelAnchor(), 'a recovered idle pass continues without running the CPU watchdog');
});

test('runPreSpawnLivenessWatchdogs: a CPU-stalled worker is recovered — cpu stall event, next ticket persisted, trackers and anchor reset', () => {
  const session = makeSession({ current_ticket: 'cc01' });
  const ticketDir = writeTicket(session.sessionDir, 'cc01', 'Done', 1);
  writeTicket(session.sessionDir, 'cc02', 'Todo', 2);
  fs.writeFileSync(path.join(ticketDir, `worker_session_${process.pid}.log`), 'worker running\n');
  const anchorCpuSeconds = mux.sampleWorkerCpuSeconds(process.pid);
  assert.equal(typeof anchorCpuSeconds, 'number', 'precondition: ps must be able to sample this process');

  const start = 100_000_000;
  const clock = steppingClock(start);
  const anchor = {
    cpuLivenessTicketId: 'cc01',
    cpuLivenessAnchorPid: process.pid,
    cpuLivenessAnchorEpoch: start - (THRESHOLD_SECONDS + 60) * 1000,
    cpuLivenessAnchorCpuSeconds: anchorCpuSeconds,
    cpuLivenessAnchorMtimeMs: 0,
  };
  const { input, stallTrackers } = livenessInput(session, {
    now: clock.now, lastProgressEpoch: start, anchor, idleStallRecoveryCount: 3,
  });

  const step = mux.runPreSpawnLivenessWatchdogs(input);

  assert.deepEqual(step, { kind: 'continue', idleStallRecoveryCount: 3 });
  const events = readActivity(session.sessionDir, 'mux_idle_stall_detected');
  assert.equal(events.length, 1);
  assert.equal(events[0].gate_payload.liveness, 'cpu');
  assert.equal(events[0].gate_payload.current_ticket, 'cc01');
  assert.equal(readState(session.statePath).current_ticket, 'cc02');
  assert.deepEqual(stallTrackers, { lastStateIteration: -1, stallCount: 0, lastProgressEpoch: clock.readings.at(-1) });
  assert.deepEqual(
    [anchor.cpuLivenessTicketId, anchor.cpuLivenessAnchorPid, anchor.cpuLivenessAnchorCpuSeconds],
    [null, null, null],
  );
});

test('runPreSpawnLivenessWatchdogs: a newly observed worker seeds the CPU anchor and proceeds without writing state', () => {
  const session = makeSession({ current_ticket: 'dd01' });
  const ticketDir = writeTicket(session.sessionDir, 'dd01', 'In Progress', 1);
  fs.writeFileSync(path.join(ticketDir, `worker_session_${process.pid}.log`), 'worker running\n');
  const before = fs.readFileSync(session.statePath, 'utf8');
  const clock = steppingClock(110_000_000);
  const anchor = emptyAnchor();
  const { input } = livenessInput(session, { now: clock.now, lastProgressEpoch: 110_000_000, anchor });

  const step = mux.runPreSpawnLivenessWatchdogs(input);

  assert.deepEqual(step, { kind: 'proceed', idleStallRecoveryCount: 0 });
  assert.equal(anchor.cpuLivenessTicketId, 'dd01');
  assert.equal(anchor.cpuLivenessAnchorPid, process.pid);
  assert.equal(anchor.cpuLivenessAnchorEpoch, clock.readings[1]);
  assert.equal(typeof anchor.cpuLivenessAnchorCpuSeconds, 'number');
  assert.equal(fs.readFileSync(session.statePath, 'utf8'), before);
});

// ─────────────────────────── classifyAndRecordIterationEnd ───────────────────────────

function iterationEnd(session, iteration, outcome, logBody = 'worker output\n') {
  const iterLogFile = path.join(session.sessionDir, `tmux_iteration_${iteration}.log`);
  fs.writeFileSync(iterLogFile, logBody);
  const result = mux.classifyAndRecordIterationEnd({
    outcome: { completion: 'continue', timedOut: false, exitCode: 0, wallSeconds: 12, ...outcome },
    iterLogFile,
    sessionDir: session.sessionDir,
    iteration,
    state: session.state,
  });
  const events = readActivity(session.sessionDir, 'iteration_end').filter((e) => e.iteration === iteration);
  return { result, events };
}

test('classifyAndRecordIterationEnd: a completed manager turn is success and records iteration_end with the session backend', () => {
  const session = makeSession({ backend: 'codex' });
  const { result, events } = iterationEnd(session, 7, { completion: 'task_completed' });

  assert.deepEqual(result, { type: 'success' });
  assert.equal(events.length, 1);
  assert.deepEqual(
    { source: events[0].source, exit_type: events[0].exit_type, backend: events[0].backend },
    { source: 'pickle', exit_type: 'success', backend: 'codex' },
  );
});

test('classifyAndRecordIterationEnd: a rejected rate_limit_event in the iteration log classifies api_limit and records it', () => {
  const session = makeSession();
  const log = [
    JSON.stringify({ type: 'assistant', message: 'working' }),
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_900_000_000, rateLimitType: 'five_hour' } }),
    '',
  ].join('\n');
  const { result, events } = iterationEnd(session, 8, {}, log);

  assert.deepEqual(result, {
    type: 'api_limit',
    rateLimitInfo: { limited: true, sawEvents: true, resetsAt: 1_900_000_000, rateLimitType: 'five_hour' },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].exit_type, 'api_limit');
});

test('classifyAndRecordIterationEnd: the outcome timing reaches the classifier — timedOut is a timeout carrying exitCode and wallSeconds', () => {
  const session = makeSession();
  const timedOut = iterationEnd(session, 9, { timedOut: true, exitCode: 143, wallSeconds: 901 });
  const control = iterationEnd(session, 10, { timedOut: false, exitCode: 143, wallSeconds: 901 });

  assert.deepEqual(timedOut.result, { type: 'timeout', exitCode: 143, wallSeconds: 901 });
  assert.equal(timedOut.events.length, 1);
  assert.equal(timedOut.events[0].exit_type, 'timeout');
  assert.deepEqual(control.result, { type: 'success' }, 'the same log without timedOut must not read as a timeout');
  assert.equal(control.events[0].exit_type, 'success');
});

test('classifyAndRecordIterationEnd: a subprocess error is error and the event names the iteration it ended', () => {
  const session = makeSession();
  const { result, events } = iterationEnd(session, 11, { completion: 'error', exitCode: 1 });

  assert.deepEqual(result, { type: 'error' });
  assert.equal(events.length, 1);
  assert.equal(events[0].exit_type, 'error');
  assert.equal(events[0].session, path.basename(session.sessionDir));
});

// ─────────────────────────── muxEpicFinalizeScan ───────────────────────────

const GIT_ENV = { ...process.env, GIT_CONFIG_COUNT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

function git(cwd, args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=R2a Fixture', '-c', 'user.email=r2a@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, env: GIT_ENV, encoding: 'utf8', timeout: 30000 },
  ).trim();
}

/**
 * repoA sits exactly at the session baseline with a clean tree, so a Failed ticket is
 * terminal-excludable there; repoB is a clone one commit past it, where it is not.
 */
function makeBaselineRepos() {
  const repos = path.join(DATA_ROOT, `repos-${++sessionSeq}`);
  const repoA = path.join(repos, 'a');
  const repoB = path.join(repos, 'b');
  fs.mkdirSync(repoA, { recursive: true });
  git(repoA, ['init', '-q']);
  fs.writeFileSync(path.join(repoA, 'a.txt'), 'a\n');
  git(repoA, ['add', 'a.txt']);
  git(repoA, ['commit', '-q', '-m', 'baseline']);
  const baseline = git(repoA, ['rev-parse', 'HEAD']);
  git(repos, ['clone', '-q', repoA, repoB]);
  fs.writeFileSync(path.join(repoB, 'b.txt'), 'b\n');
  git(repoB, ['add', 'b.txt']);
  git(repoB, ['commit', '-q', '-m', 'past the baseline']);
  return { repoA, repoB, baseline };
}

function finalizeFixture() {
  const { repoA, repoB, baseline } = makeBaselineRepos();
  const session = makeSession({ working_dir: repoA, start_commit: baseline });
  writeTicket(session.sessionDir, 'ff01', 'Failed', 1);
  writeTicket(session.sessionDir, 'dd01', 'Done', 2);
  return { session, repoA, repoB };
}

test('muxEpicFinalizeScan: the scan runs over the FIRST non-empty working dir it is given', () => {
  const { session, repoA, repoB } = finalizeFixture();

  // Control: the working dir is observable — the Failed ticket is pending past the baseline.
  assert.equal(mux.muxEpicFinalizeScan(session.sessionDir, repoB)().pendingCount, 1);

  assert.deepEqual(
    mux.muxEpicFinalizeScan(session.sessionDir, undefined, repoA, repoB)(),
    { doneCount: 1, commitCount: 0, pendingCount: 0, ticketCount: 2 },
  );
  assert.deepEqual(
    mux.muxEpicFinalizeScan(session.sessionDir, '', repoB, repoA)(),
    { doneCount: 1, commitCount: 0, pendingCount: 1, ticketCount: 2 },
    'a later excludable dir must not rescue the first non-empty one',
  );
});

test('muxEpicFinalizeScan: the returned scan is deferred — it reads the roster when called, not when built', () => {
  const { session, repoA } = finalizeFixture();
  const scan = mux.muxEpicFinalizeScan(session.sessionDir, repoA);

  writeTicket(session.sessionDir, 'ff01', 'Done', 1);

  assert.deepEqual(scan(), { doneCount: 2, commitCount: 0, pendingCount: 0, ticketCount: 2 });
});

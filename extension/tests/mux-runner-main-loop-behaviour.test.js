// @tier: integration
/**
 * R2b (ticket 92bb9767) — drives the REAL `runMuxRunnerMain` loop through `driveMuxRunnerMain`.
 *
 * Every other reference to the loop in tests/ is source text. This suite calls it over fixture sessions,
 * replacing only the three effects it cannot perform in-process (the manager spawn, the 1s wall sleep and
 * process termination), and asserts what the loop DID:
 * - the exit code;
 * - the state.json dispositions and exit_reason stamps;
 * - the activity events and their ORDER.
 *
 * Every other effect runs for real, steered by environment only:
 * - tmux unset;
 * - orphan reaping and codegraph off;
 * - a hermetic extension root;
 * - a PATH osascript shim;
 * - a sandboxed data root.
 *
 * Integration tier: each session builds a real git repo and the loop shells out to git.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Sandbox every side-effect channel BEFORE the module loads.
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-main-loop-')));
const DATA_ROOT = path.join(ROOT, 'data');
const HERMETIC_EXTENSION_ROOT = path.join(ROOT, 'extension-root');
const SHIM_DIR = path.join(ROOT, 'shim');
fs.mkdirSync(DATA_ROOT);
fs.mkdirSync(HERMETIC_EXTENSION_ROOT);
fs.mkdirSync(SHIM_DIR);
// The install-root sentinel makes getExtensionRoot honour EXTENSION_DIR; its `extension/` does not exist, so the
// startup fast-test reaper can match no live process.
fs.writeFileSync(path.join(HERMETIC_EXTENSION_ROOT, '.pickle-install-root'), '');
fs.copyFileSync(path.join(EXTENSION_ROOT, '..', 'pickle_settings.json'), path.join(HERMETIC_EXTENSION_ROOT, 'pickle_settings.json'));
// The terminal report posts a darwin notification through a PATH-resolved osascript.
fs.writeFileSync(path.join(SHIM_DIR, 'osascript'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

Object.assign(process.env, {
  PICKLE_DATA_ROOT: DATA_ROOT,
  PICKLE_TEST_MODE: '1',
  PICKLE_CODEGRAPH: 'off',
  PICKLE_ORPHAN_REAP: 'off',
  EXTENSION_DIR: HERMETIC_EXTENSION_ROOT,
  PATH: `${SHIM_DIR}${path.delimiter}${process.env.PATH}`,
});
for (const key of ['TMUX', 'PICKLE_REFINEMENT_LOCK', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete process.env[key];

const reapRoot = () => fs.rmSync(ROOT, { recursive: true, force: true });
process.on('exit', reapRoot);
after(reapRoot);

const mux = await import('../bin/mux-runner.js');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 }).trim();

let sessionSeq = 0;

/** A session over a real git repo; tickets with `commit: true` get a trailered commit and a completion_commit stamp. */
function makeSession({ tickets, stateOverrides = {} }) {
  sessionSeq += 1;
  const sessionDir = path.join(DATA_ROOT, 'sessions', `2026-09-15-r2b${String(sessionSeq).padStart(5, '0')}`);
  const repo = path.join(ROOT, `repo-${sessionSeq}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'r2b@example.test');
  git(repo, 'config', 'user.name', 'r2b');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  const baseSha = git(repo, 'rev-parse', 'HEAD');

  for (const ticket of tickets) {
    const frontmatter = ['---', `id: "${ticket.id}"`, `title: "ticket ${ticket.id}"`, `status: "${ticket.status}"`, `order: ${ticket.order}`, 'complexity_tier: trivial'];
    if (ticket.commit) {
      fs.writeFileSync(path.join(repo, `${ticket.id}.txt`), `${ticket.id}\n`);
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', `work ${ticket.id}`, '-m', `Pickle-Ticket: ${ticket.id}`);
      frontmatter.push(`completion_commit: ${git(repo, 'rev-parse', 'HEAD')}`);
    }
    frontmatter.push('---', `# ${ticket.id}`, '', '## Acceptance Criteria', '- [x] done');
    const ticketDir = path.join(sessionDir, ticket.id);
    fs.mkdirSync(ticketDir);
    fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticket.id}.md`), frontmatter.join('\n'));
  }

  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    active: true,
    tmux_mode: true,
    pid: process.pid,
    working_dir: repo,
    step: 'implement',
    iteration: 0,
    max_iterations: 5,
    max_time_minutes: 0,
    worker_timeout_seconds: 3600,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'r2b main loop fixture',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 5,
    start_commit: baseSha,
    backend: 'claude',
    worker_artifact_progress: {},
    flags: { skip_quality_gates_reason: 'r2b main loop fixture' },
    ...stateOverrides,
  }, null, 2));
  return { sessionDir, statePath };
}

const readState = (statePath) => JSON.parse(fs.readFileSync(statePath, 'utf8'));

/** This session's records from the sandboxed activity jsonl sink, in write order. */
function readActivity(sessionDir) {
  const dir = path.join(DATA_ROOT, 'activity');
  if (!fs.existsSync(dir)) return [];
  const session = path.basename(sessionDir);
  return fs.readdirSync(dir).sort()
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n'))
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.session === session);
}

/** Runs the real loop over `session`; `outcomeFor(iteration)` stands in for the manager spawn. */
async function driveLoop(session, outcomeFor) {
  const spawnedIterations = [];
  const exitCodes = [];
  const originalArgv = process.argv[2];
  process.argv[2] = session.sessionDir;
  try {
    await mux.driveMuxRunnerMain({
      runIteration: async (sessionDir, iteration) => {
        assert.equal(sessionDir, session.sessionDir, 'the loop must spawn for the session it was driven over');
        spawnedIterations.push(iteration);
        return outcomeFor(iteration);
      },
      sleep: async () => {},
      exit: (code) => { exitCodes.push(code); },
    });
  } finally {
    process.argv[2] = originalArgv;
  }
  assert.equal(exitCodes.length, 1, `the loop must reach its terminal exit exactly once, got ${JSON.stringify(exitCodes)}`);
  return { exitCode: exitCodes[0], spawnedIterations };
}

const eventNames = (entries) => entries.map((entry) => entry.event);

test('R2b-1: all tickets Done — the loop finalizes the epic without spawning and exits success', async () => {
  const session = makeSession({
    tickets: [
      { id: 'aaaa1111', status: 'Done', order: 1, commit: true },
      { id: 'bbbb2222', status: 'Done', order: 2, commit: true },
    ],
  });

  const { exitCode, spawnedIterations } = await driveLoop(session, () => {
    throw new Error('an all-Done roster must not spawn a manager');
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(spawnedIterations, []);

  const state = readState(session.statePath);
  assert.equal(state.active, false);
  assert.equal(state.step, 'completed');
  assert.equal(state.exit_reason, 'completed');
  assert.equal(JSON.parse(state.completion_promise).kind, 'EPIC_COMPLETED');
  assert.equal(JSON.parse(state.completion_promise).reason, 'all-tickets-done');
  assert.ok(eventNames(state.activity).includes('epic_completed'), 'the epic finalize is recorded in state.activity');

  const activity = readActivity(session.sessionDir);
  assert.deepEqual(eventNames(activity), ['iteration_start', 'session_end']);
  assert.equal(activity[1].error, undefined, 'a success exit carries no error');
});

test('R2b-2: a worker iteration that produces nothing records its disposition and events in order', async () => {
  const ticketId = 'cccc3333';
  const session = makeSession({
    tickets: [{ id: ticketId, status: 'In Progress', order: 1 }],
    stateOverrides: { current_ticket: ticketId, max_iterations: 2 },
  });

  const { exitCode, spawnedIterations } = await driveLoop(session, () => (
    { completion: 'inactive', timedOut: false, exitCode: 0, wallSeconds: 1 }
  ));

  assert.deepEqual(spawnedIterations, [1]);
  assert.equal(exitCode, 0);

  const state = readState(session.statePath);
  assert.equal(state.exit_reason, undefined, 'a non-halt exit stamps no exit_reason');
  assert.equal(state.current_ticket, ticketId);
  assert.equal(state.worker_artifact_progress[ticketId].spawn_count, 1);
  assert.equal(state.worker_artifact_progress[ticketId].last_artifact_count, 0);
  assert.ok(eventNames(state.activity).includes('worker_produced_nothing'), 'the empty spawn is recorded in state.activity');

  const ordered = readActivity(session.sessionDir)
    .filter((entry) => ['iteration_start', 'iteration_end', 'wasted_iter', 'session_end'].includes(entry.event))
    .map((entry) => `${entry.event}:${entry.exit_type ?? entry.reason ?? entry.error ?? ''}`);
  assert.deepEqual(ordered, ['iteration_start:', 'iteration_end:inactive', 'wasted_iter:no_progress', 'session_end:']);

  const runnerLog = fs.readFileSync(path.join(session.sessionDir, 'mux-runner.log'), 'utf8');
  assert.match(runnerLog, /Session deactivated\. Exiting loop\./, 'the exit is the inactive branch, not a halt');
});

test('R2b-3: repeated timeouts are a halt-class exit — timeout_repeat is stamped in state.json', async () => {
  const ticketId = 'dddd4444';
  const session = makeSession({
    tickets: [{ id: ticketId, status: 'In Progress', order: 1 }],
    stateOverrides: { current_ticket: ticketId, max_iterations: 6 },
  });

  const { exitCode, spawnedIterations } = await driveLoop(session, () => (
    { completion: 'error', timedOut: true, exitCode: null, wallSeconds: 3600 }
  ));

  assert.deepEqual(spawnedIterations, [1, 2, 3]);
  assert.equal(exitCode, 1, 'timeout_repeat is a failure exit');

  const state = readState(session.statePath);
  assert.equal(state.exit_reason, 'timeout_repeat');
  assert.equal(state.active, false);
  const stateEvents = eventNames(state.activity);
  const haltedAt = stateEvents.indexOf('ticket_timeout_halted_no_progress');
  assert.ok(haltedAt >= 0, 'the no-progress timeout halt is recorded');
  assert.ok(stateEvents.indexOf('halt', haltedAt) > haltedAt, 'the halt record follows the timeout verdict');

  const activity = readActivity(session.sessionDir);
  const iterationEnds = activity.filter((entry) => entry.event === 'iteration_end');
  assert.deepEqual(iterationEnds.map((entry) => entry.exit_type), ['error', 'error', 'error']);
  const last = activity[activity.length - 1];
  assert.equal(last.event, 'session_end');
  assert.equal(last.error, 'timeout_repeat', 'the terminal event names the halt reason');
});

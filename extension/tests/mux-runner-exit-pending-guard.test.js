// @tier: fast
// AC-A2 (ticket d3a22538, B-DSAN2 WS-A): mux-runner must NOT exit 0 when a clean
// manager exit (end_turn / max-turns) leaves tickets non-terminal. The exported
// seam `processCompletionBranch` is targeted directly; the live loop in
// `runMuxRunnerMain` carries the identical gate so source-order parity holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  processCompletionBranch,
  evaluateEpicCompletion,
} from '../bin/mux-runner.js';

function makeTmpDir(prefix = 'pickle-exit-pending-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeTicket(sessionDir, id, status) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  const content = [
    '---',
    `id: ${id}`,
    `title: ${id} fixture`,
    `status: ${status}`,
    'order: 1',
    '---',
    '',
    '# Fixture',
  ].join('\n');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${id}.md`), content);
}

function writeState(sessionDir, overrides = {}) {
  const state = {
    active: false,
    backend: 'claude',
    working_dir: sessionDir,
    step: 'implement',
    iteration: 3,
    max_iterations: 20,
    // No wall-clock cap so evaluateManagerRelaunch never returns 'time_limit'.
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'AC-A2 exit-pending-guard fixture',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 1,
    // Fresh relaunch count so the cap is not exhausted on the first pass.
    manager_relaunch_count: 0,
    ...overrides,
  };
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return { state, statePath };
}

// A clean claude manager exit: inactive completion, no timeout, null exit code.
// detectManagerInactiveExit(...) is true for this shape, and on the claude
// backend classifyManagerRelaunchExit returns a non-codex kind.
const inactiveOutcome = {
  completion: 'inactive',
  timedOut: false,
  exitCode: null,
  wallSeconds: 0,
};

function buildContext(sessionDir, statePath, outcome, logs, deactivateCalls) {
  return {
    sessionDir,
    statePath,
    extensionRoot: process.cwd(),
    iteration: 3,
    outcome,
    iterLogFile: path.join(sessionDir, 'tmux_iteration_3.log'),
    maxTurns: 40,
    cbState: null,
    log: message => logs.push(message),
    deactivate: target => deactivateCalls.push(target),
  };
}

async function withFixture({ allDone = false, stateOverrides = {} } = {}, run) {
  const dir = makeTmpDir();
  const dataRoot = makeTmpDir('pickle-exit-pending-data-');
  const previousDataRoot = process.env.PICKLE_DATA_ROOT;
  try {
    process.env.PICKLE_DATA_ROOT = dataRoot;
    writeTicket(dir, 'ticket-001', allDone ? 'Done' : 'Todo');
    writeTicket(dir, 'ticket-002', 'Done');
    const { state, statePath } = writeState(dir, stateOverrides);
    fs.writeFileSync(path.join(dir, 'tmux_iteration_3.log'), '');
    const logs = [];
    const deactivateCalls = [];
    const ctx = buildContext(dir, statePath, inactiveOutcome, logs, deactivateCalls);
    await run({ dir, state, statePath, logs, deactivateCalls, ctx, dataRoot });
  } finally {
    if (previousDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = previousDataRoot;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

// AC: "clean manager exit with pending routes through evaluateManagerRelaunch"
//   + "no exit-0 when ≥1 ticket non-terminal".
test('claude clean inactive exit with ≥1 pending ticket relaunches (NOT cancelled exit-0)', async () => {
  await withFixture({ allDone: false }, async ({ state, statePath, logs, deactivateCalls, ctx }) => {
    const action = await processCompletionBranch(state, 'inactive', ctx);
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

    assert.equal(action.kind, 'relaunch', `expected relaunch, got ${JSON.stringify(action)}`);
    assert.notEqual(action.kind, 'break');
    assert.equal(action.pendingTickets, 1);
    assert.equal(deactivateCalls.length, 0, 'a pending bundle must not deactivate');
    assert.equal(persisted.manager_relaunch_count, 1);
    assert.ok(
      !logs.includes('Session deactivated. Exiting loop.'),
      `did not expect the clean-exit log, got:\n${logs.join('\n')}`,
    );
    assert.ok(
      logs.some(line => line.includes('relaunching')),
      `expected a relaunching log line, got:\n${logs.join('\n')}`,
    );
  });
});

// AC: "exit gated on all-terminal" — the legitimate clean exit-0 path.
test('claude clean inactive exit with ALL tickets Done falls through to cancelled (exit-0 allowed)', async () => {
  await withFixture({ allDone: true }, async ({ state, logs, deactivateCalls, ctx }) => {
    const action = await processCompletionBranch(state, 'inactive', ctx);

    assert.equal(action.kind, 'break', `expected break, got ${JSON.stringify(action)}`);
    assert.equal(action.reason, 'cancelled');
    assert.equal(deactivateCalls.length, 0);
    assert.ok(
      logs.includes('Session deactivated. Exiting loop.'),
      `expected the clean-exit log, got:\n${logs.join('\n')}`,
    );
    assert.ok(
      !logs.some(line => line.includes('relaunching')),
      `did not expect a relaunch log, got:\n${logs.join('\n')}`,
    );
  });
});

// AC: "mux exit-0 gated by evaluateEpicCompletion all-terminal decision" — the
// authority directly: a queue with ≥1 non-done ticket is never 'genuine'.
test('evaluateEpicCompletion is not genuine while ≥1 ticket is non-terminal', () => {
  const T = (id, status) => ({
    id, title: id, status, order: 0, type: null,
    working_dir: null, completed_at: null, skipped_at: null,
  });
  const decision = evaluateEpicCompletion({
    tickets: [T('a', 'Done'), T('b', 'Todo'), T('c', 'Done')],
    currentTicket: null,
    priorFalseCount: 0,
    priorFalseTicket: null,
  });
  assert.notEqual(decision.kind, 'genuine', `expected non-genuine, got ${JSON.stringify(decision)}`);

  // Control: an all-terminal queue IS genuine, so the gate only blocks pending work.
  const allDone = evaluateEpicCompletion({
    tickets: [T('a', 'Done'), T('b', 'Skipped'), T('c', 'Done')],
    currentTicket: null,
    priorFalseCount: 0,
    priorFalseTicket: null,
  });
  assert.equal(allDone.kind, 'genuine');
});

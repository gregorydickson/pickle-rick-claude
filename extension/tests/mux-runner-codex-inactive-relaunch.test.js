// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  processCompletionBranch,
  processIterationOutcome,
  detectManagerInactiveExit,
  classifyManagerRelaunchExit,
} from '../bin/mux-runner.js';
import { Defaults } from '../types/index.js';

function makeTmpDir(prefix = 'pickle-codex-inactive-') {
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
    backend: 'codex',
    working_dir: sessionDir,
    step: 'implement',
    iteration: 3,
    max_iterations: 20,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'codex inactive relaunch regression fixture',
    current_ticket: 'ticket-001',
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 1,
    manager_relaunch_count: 0,
    ...overrides,
  };
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return { state, statePath };
}

function readActivityEvents(dataRoot) {
  const activityDir = path.join(dataRoot, 'activity');
  if (!fs.existsSync(activityDir)) return [];
  return fs.readdirSync(activityDir)
    .filter(entry => entry.endsWith('.jsonl'))
    .flatMap(entry => fs.readFileSync(path.join(activityDir, entry), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line)));
}

function buildContext(sessionDir, statePath, outcome, logs, deactivateCalls, extra = {}) {
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
    ...extra,
  };
}

const inactiveOutcome = {
  completion: 'inactive',
  timedOut: false,
  exitCode: null,
  wallSeconds: 0,
};

async function withFixture(stateOverrides, run) {
  const dir = makeTmpDir();
  const dataRoot = makeTmpDir('pickle-codex-inactive-data-');
  const previousDataRoot = process.env.PICKLE_DATA_ROOT;
  try {
    process.env.PICKLE_DATA_ROOT = dataRoot;
    writeTicket(dir, 'ticket-001', 'Todo');
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

test('detectManagerInactiveExit: true for inactive + no timeout + null exitCode', () => {
  assert.equal(detectManagerInactiveExit(inactiveOutcome), true);
});

test('detectManagerInactiveExit: false when timedOut is true', () => {
  assert.equal(detectManagerInactiveExit({ ...inactiveOutcome, timedOut: true }), false);
});

test('detectManagerInactiveExit: false when completion is not inactive', () => {
  assert.equal(detectManagerInactiveExit({ ...inactiveOutcome, completion: 'error' }), false);
  assert.equal(detectManagerInactiveExit({ ...inactiveOutcome, completion: 'continue' }), false);
});

test('detectManagerInactiveExit: false when exitCode is not null', () => {
  assert.equal(detectManagerInactiveExit({ ...inactiveOutcome, exitCode: 0 }), false);
  assert.equal(detectManagerInactiveExit({ ...inactiveOutcome, exitCode: 1 }), false);
});

test('detectManagerInactiveExit: false for undefined', () => {
  assert.equal(detectManagerInactiveExit(undefined), false);
});

test('classifyManagerRelaunchExit: returns codex_session_inactive for codex inactive outcome', () => {
  const state = {
    active: false,
    backend: 'codex',
    working_dir: process.cwd(),
    step: 'implement',
    iteration: 1,
    max_iterations: 20,
    schema_version: 1,
  };
  const kind = classifyManagerRelaunchExit(state, inactiveOutcome, '/dev/null', null);
  assert.equal(kind, 'codex_session_inactive');
});

test('classifyManagerRelaunchExit: returns other_error for claude inactive outcome', () => {
  const state = {
    active: false,
    backend: 'claude',
    working_dir: process.cwd(),
    step: 'implement',
    iteration: 1,
    max_iterations: 20,
    schema_version: 1,
  };
  const kind = classifyManagerRelaunchExit(state, inactiveOutcome, '/dev/null', null);
  assert.equal(kind, 'other_error');
});

test('codex-inactive-relaunch: relaunches on inactive exit with pending tickets', async () => {
  await withFixture({}, async ({ state, statePath, logs, deactivateCalls, ctx, dataRoot }) => {
    const action = await processCompletionBranch(state, 'inactive', ctx);
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

    assert.equal(action.kind, 'relaunch', `expected relaunch, got ${JSON.stringify(action)}`);
    assert.equal(action.relaunchCount, 1);
    assert.equal(action.pendingTickets, 1);
    assert.equal(deactivateCalls.length, 0, 'should not deactivate on relaunch');
    assert.equal(persisted.manager_relaunch_count, 1);
    assert.ok(
      logs.some(line => line.includes('codex_session_inactive')),
      `expected codex_session_inactive relaunch log, got:\n${logs.join('\n')}`,
    );
    assert.ok(
      logs.some(line => line.includes('relaunching')),
      `expected relaunching log, got:\n${logs.join('\n')}`,
    );

    const events = readActivityEvents(dataRoot);
    const relaunchEvent = events.find(e => e.event === 'manager_max_turns_relaunch');
    assert.ok(relaunchEvent, `expected manager_max_turns_relaunch event, got: ${JSON.stringify(events.map(e => e.event))}`);
    assert.equal(relaunchEvent.backend, 'codex');
    assert.equal(relaunchEvent.relaunch_count, 1);
    assert.equal(relaunchEvent.cap, Defaults.CODEX_MANAGER_RELAUNCH_CAP);
    assert.equal(relaunchEvent.pending_count, 1);
  });
});

test('codex-inactive-relaunch: no relaunch when cap exceeded', async () => {
  await withFixture(
    { manager_relaunch_count: Defaults.CODEX_MANAGER_RELAUNCH_CAP },
    async ({ state, logs, deactivateCalls, ctx }) => {
      const action = await processCompletionBranch(state, 'inactive', ctx);

      assert.equal(action.kind, 'break');
      assert.equal(action.reason, 'cancelled');
      assert.ok(
        logs.includes('Session deactivated. Exiting loop.'),
        `expected deactivation log, got:\n${logs.join('\n')}`,
      );
    },
  );
});

test('codex-inactive-relaunch: no relaunch when no pending tickets', async () => {
  await withFixture({}, async ({ dir, state, logs, ctx }) => {
    // Mark the only Todo ticket as Done
    const ticketFile = path.join(dir, 'ticket-001', 'rick_ticket_ticket-001.md');
    const raw = fs.readFileSync(ticketFile, 'utf-8');
    fs.writeFileSync(ticketFile, raw.replace('status: Todo', 'status: Done'));

    const action = await processCompletionBranch(state, 'inactive', ctx);

    assert.equal(action.kind, 'break');
    assert.equal(action.reason, 'cancelled');
    assert.ok(logs.includes('Session deactivated. Exiting loop.'));
  });
});

test('codex-inactive-relaunch: claude inactive WITH pending relaunches (AC-A2)', async () => {
  // AC-A2 (ticket d3a22538): a clean claude manager exit (end_turn / max-turns)
  // with ≥1 pending ticket must route through evaluateManagerRelaunch and relaunch
  // rather than fall through to the clean exit-0 path.
  await withFixture({ backend: 'claude' }, async ({ state, logs, deactivateCalls, ctx }) => {
    const action = await processCompletionBranch(state, 'inactive', ctx);

    assert.equal(action.kind, 'relaunch', `expected relaunch, got ${JSON.stringify(action)}`);
    assert.equal(action.pendingTickets, 1);
    assert.equal(deactivateCalls.length, 0);
    assert.ok(
      !logs.includes('Session deactivated. Exiting loop.'),
      `did not expect the clean-exit log, got:\n${logs.join('\n')}`,
    );
    assert.ok(
      logs.some(line => line.includes('relaunching')),
      `expected relaunching log, got:\n${logs.join('\n')}`,
    );
  });
});

test('codex-inactive-relaunch: timedOut inactive does NOT relaunch via inactive path', async () => {
  await withFixture({}, async ({ dir, state, statePath, logs, ctx }) => {
    const timedOutInactive = { ...inactiveOutcome, timedOut: true };
    const timedCtx = buildContext(dir, statePath, timedOutInactive, logs, []);
    const action = await processCompletionBranch(state, 'inactive', timedCtx);

    assert.equal(action.kind, 'break');
    assert.equal(action.reason, 'cancelled');
  });
});

test('codex-inactive-relaunch: processIterationOutcome routes codex inactive to relaunch', async () => {
  await withFixture({}, async ({ state, statePath, logs, deactivateCalls, ctx }) => {
    const action = await processIterationOutcome(state, inactiveOutcome, ctx);
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

    assert.equal(action.kind, 'relaunch');
    assert.equal(action.relaunchCount, 1);
    assert.equal(deactivateCalls.length, 0);
    assert.equal(persisted.manager_relaunch_count, 1);
  });
});

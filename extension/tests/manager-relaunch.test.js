// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  evaluateManagerRelaunch,
  recordManagerRelaunch,
} from '../services/manager-relaunch.js';
import { isGenuineCrashOrSpawnFailure } from '../bin/mux-runner.js';
import { StateManager } from '../services/state-manager.js';
import { Defaults } from '../types/index.js';

function relaunchDecision(overrides = {}) {
  return {
    shouldRelaunch: true,
    pendingCount: 1,
    nextRelaunchCount: 1,
    reason: 'eligible',
    cap: Defaults.CLAUDE_MANAGER_RELAUNCH_CAP,
    backend: 'claude',
    exitKind: 'other_error',
    ...overrides,
  };
}

const pendingTickets = [
  { id: 'done', status: 'Done', title: '', order: 1, type: null, working_dir: null, completed_at: null, skipped_at: null },
  { id: 'pending', status: 'Todo', title: '', order: 2, type: null, working_dir: null, completed_at: null, skipped_at: null },
];

function stateFixture(overrides = {}) {
  return {
    active: true,
    step: 'implement',
    iteration: 1,
    max_iterations: 100,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000),
    max_time_minutes: 720,
    working_dir: process.cwd(),
    backend: 'codex',
    manager_relaunch_count: 3,
    schema_version: 3,
    ...overrides,
  };
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

function withExtensionRoot(settings, fn) {
  const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-ext-root-'));
  const prevExtensionDir = process.env.EXTENSION_DIR;
  try {
    fs.writeFileSync(path.join(extensionRoot, '.pickle-install-root'), '');
    fs.writeFileSync(path.join(extensionRoot, 'pickle_settings.json'), JSON.stringify(settings, null, 2));
    process.env.EXTENSION_DIR = extensionRoot;
    return fn();
  } finally {
    if (prevExtensionDir === undefined) delete process.env.EXTENSION_DIR;
    else process.env.EXTENSION_DIR = prevExtensionDir;
    fs.rmSync(extensionRoot, { recursive: true, force: true });
  }
}

test('manager-relaunch exports canonical symbols', () => {
  assert.equal(typeof evaluateManagerRelaunch, 'function');
  assert.equal(typeof recordManagerRelaunch, 'function');
});

test('manager-relaunch preserves codex behavior below cap', () => {
  const decision = evaluateManagerRelaunch(stateFixture(), pendingTickets, null, 'codex_4h_hang_guard');
  const simple = evaluateManagerRelaunch(stateFixture(), true);

  assert.equal(decision.shouldRelaunch, true);
  assert.equal(decision.reason, 'eligible');
  assert.equal(decision.pendingCount, 1);
  assert.equal(decision.nextRelaunchCount, 4);
  assert.equal(decision.cap, Defaults.CODEX_MANAGER_RELAUNCH_CAP);
  assert.equal(simple.should_relaunch, true);
  assert.equal(simple.cap, Defaults.CODEX_MANAGER_RELAUNCH_CAP);
});

test('manager-relaunch allows claude with cap 20', () => {
  const state = stateFixture({ backend: 'claude', manager_relaunch_count: 19 });
  const eligible = evaluateManagerRelaunch(state, pendingTickets, null, 'claude_max_turns');
  const capped = evaluateManagerRelaunch(
    { ...state, manager_relaunch_count: Defaults.CLAUDE_MANAGER_RELAUNCH_CAP },
    pendingTickets,
    null,
    'claude_max_turns',
  );

  assert.equal(eligible.shouldRelaunch, true);
  assert.equal(eligible.nextRelaunchCount, 20);
  assert.equal(eligible.cap, Defaults.CLAUDE_MANAGER_RELAUNCH_CAP);
  assert.equal(eligible.exitKind, 'claude_max_turns');
  assert.equal(capped.shouldRelaunch, false);
  assert.equal(capped.reason, 'cap_exceeded');
});

test('manager-relaunch chooses claude cap from exit kind even when backend is not claude', () => {
  const decision = evaluateManagerRelaunch(
    stateFixture({ backend: 'codex', manager_relaunch_count: 19 }),
    pendingTickets,
    null,
    'claude_max_turns',
  );

  assert.equal(decision.shouldRelaunch, true);
  assert.equal(decision.nextRelaunchCount, 20);
  assert.equal(decision.cap, Defaults.CLAUDE_MANAGER_RELAUNCH_CAP);
  assert.equal(decision.backend, 'codex');
  assert.equal(decision.exitKind, 'claude_max_turns');
});

test('manager-relaunch reads claude cap override from pickle_settings.json', () => {
  withExtensionRoot({ claude_manager_relaunch_cap: 25 }, () => {
    const decision = evaluateManagerRelaunch(
      stateFixture({ backend: 'codex', manager_relaunch_count: 24 }),
      pendingTickets,
      null,
      'claude_max_turns',
    );
    assert.equal(decision.shouldRelaunch, true);
    assert.equal(decision.nextRelaunchCount, 25);
    assert.equal(decision.cap, 25);
  });
});

test('manager-relaunch preserves the progress gate via circuit breaker OPEN', () => {
  const decision = evaluateManagerRelaunch(
    stateFixture({ backend: 'codex', manager_relaunch_count: 0 }),
    pendingTickets,
    { state: 'OPEN', reason: 'no_progress' },
    'claude_max_turns',
  );

  assert.equal(decision.shouldRelaunch, false);
  assert.equal(decision.reason, 'circuit_open');
  assert.equal(decision.pendingCount, 0);
  assert.equal(decision.nextRelaunchCount, 0);
  assert.equal(decision.cap, Defaults.CLAUDE_MANAGER_RELAUNCH_CAP);
});

test('recordManagerRelaunch persists canonical counter and emits activity event', () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-relaunch-service-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-relaunch-service-data-'));
  const previousDataRoot = process.env.PICKLE_DATA_ROOT;
  const statePath = path.join(sessionDir, 'state.json');

  try {
    process.env.PICKLE_DATA_ROOT = dataRoot;
    fs.writeFileSync(statePath, JSON.stringify(stateFixture({ codex_manager_relaunch_count: 3, manager_relaunch_count: undefined }), null, 2));

    const decision = evaluateManagerRelaunch(JSON.parse(fs.readFileSync(statePath, 'utf-8')), pendingTickets, null);
    assert.equal(decision.shouldRelaunch, true);

    recordManagerRelaunch(statePath, sessionDir, decision, 7, () => {});

    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(persisted.manager_relaunch_count, 4);
    assert.equal('codex_manager_relaunch_count' in persisted, false);

    const relaunchEvent = readActivityEvents(dataRoot).find(event => event.event === 'codex_manager_relaunch');
    assert.ok(relaunchEvent);
    assert.equal(relaunchEvent.iteration, 7);
    assert.equal(relaunchEvent.session, path.basename(sessionDir));
  } finally {
    if (previousDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = previousDataRoot;
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('recordManagerRelaunch emits manager_max_turns_relaunch payload for claude max-turn exits', () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-relaunch-service-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-relaunch-service-data-'));
  const previousDataRoot = process.env.PICKLE_DATA_ROOT;
  const statePath = path.join(sessionDir, 'state.json');

  try {
    process.env.PICKLE_DATA_ROOT = dataRoot;
    fs.writeFileSync(statePath, JSON.stringify(stateFixture({
      backend: 'claude',
      current_ticket: '620fea14',
      manager_relaunch_count: 2,
    }), null, 2));

    const decision = evaluateManagerRelaunch(
      JSON.parse(fs.readFileSync(statePath, 'utf-8')),
      pendingTickets,
      null,
      'claude_max_turns',
    );
    assert.equal(decision.shouldRelaunch, true);

    recordManagerRelaunch(statePath, sessionDir, decision, 7, () => {});

    const relaunchEvent = readActivityEvents(dataRoot).find(event => event.event === 'manager_max_turns_relaunch');
    assert.ok(relaunchEvent);
    assert.equal(relaunchEvent.backend, 'claude');
    assert.equal(relaunchEvent.relaunch_count, 3);
    assert.equal(relaunchEvent.cap, Defaults.CLAUDE_MANAGER_RELAUNCH_CAP);
    assert.equal(relaunchEvent.pending_count, 1);
    assert.equal(relaunchEvent.last_ticket_seen, '620fea14');
    assert.equal(relaunchEvent.iteration, 7);
    assert.equal(relaunchEvent.session, path.basename(sessionDir));
  } finally {
    if (previousDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = previousDataRoot;
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('StateManager migrates codex_manager_relaunch_count to manager_relaunch_count on read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-relaunch-migrate-'));
  const statePath = path.join(dir, 'state.json');
  const sm = new StateManager();

  try {
    fs.writeFileSync(statePath, JSON.stringify(stateFixture({
      manager_relaunch_count: undefined,
      codex_manager_relaunch_count: 6,
    }), null, 2));

    const state = sm.read(statePath);
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

    assert.equal(state.manager_relaunch_count, 6);
    assert.equal(state.codex_manager_relaunch_count, undefined);
    assert.equal(persisted.manager_relaunch_count, 6);
    assert.equal('codex_manager_relaunch_count' in persisted, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// R-PPXR AC-PPXR-2: a deterministic non-zero exitCode is a genuine crash — the suppressor returns true
// and the relaunch stays vetoed (fatal teardown), even with pending tickets below cap. No log needed:
// the non-zero exit-code arm fires before any log inspection.
test('isGenuineCrashOrSpawnFailure: deterministic non-zero exitCode is fatal (predicate true / suppressed)', () => {
  const decision = relaunchDecision({ pendingCount: 1, nextRelaunchCount: 1 });
  const outcome = { completion: 'error', exitCode: 1, timedOut: false, wallSeconds: 2 };
  assert.equal(isGenuineCrashOrSpawnFailure(decision, outcome, undefined), true);
});

// R-PPXR AC-PPXR-2: a null-exit cut-off (started-but-no-result log) with NO pending work, or AT cap,
// stays fatal — there is nothing left to recover, so the suppressor returns true.
test('isGenuineCrashOrSpawnFailure: null-exit cut-off stays fatal when no pending work or at cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-ppxr-fatal-'));
  try {
    const cutOffLog = path.join(dir, 'iter.log');
    fs.writeFileSync(cutOffLog, '{"type":"system"}\n{"type":"user"}\n');
    const noPending = relaunchDecision({ pendingCount: 0, nextRelaunchCount: 1 });
    const atCap = relaunchDecision({
      pendingCount: 1,
      nextRelaunchCount: Defaults.CLAUDE_MANAGER_RELAUNCH_CAP + 1,
    });
    const cutOff = { completion: 'error', exitCode: null, timedOut: false, wallSeconds: 5 };
    assert.equal(isGenuineCrashOrSpawnFailure(noPending, cutOff, cutOffLog), true);
    assert.equal(isGenuineCrashOrSpawnFailure(atCap, cutOff, cutOffLog), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

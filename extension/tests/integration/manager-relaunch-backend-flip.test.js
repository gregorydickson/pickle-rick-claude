// @tier: integration
// AC-XBL-08 — Regression test: state.backend=codex and state.backend=claude are
// both eligible for manager relaunch, with backend-specific caps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluateManagerRelaunch } from '../../services/manager-relaunch.js';
import { StateManager } from '../../services/state-manager.js';

function makeTmpDir(prefix = 'pickle-xbl08-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const PENDING_TICKETS = [
  { id: 'ticket-001', status: 'Todo', title: 'Pending work', order: 1, type: null, working_dir: null, completed_at: null, skipped_at: null },
  { id: 'ticket-002', status: 'Done', title: 'Already done', order: 2, type: null, working_dir: null, completed_at: null, skipped_at: null },
];

function withCleanEnv(fn) {
  const prevRefinement = process.env.PICKLE_REFINEMENT_LOCK;
  const prevBackend = process.env.PICKLE_BACKEND;
  try {
    delete process.env.PICKLE_REFINEMENT_LOCK;
    delete process.env.PICKLE_BACKEND;
    return fn();
  } finally {
    if (prevRefinement === undefined) delete process.env.PICKLE_REFINEMENT_LOCK;
    else process.env.PICKLE_REFINEMENT_LOCK = prevRefinement;
    if (prevBackend === undefined) delete process.env.PICKLE_BACKEND;
    else process.env.PICKLE_BACKEND = prevBackend;
  }
}

function makeState(overrides = {}) {
  return {
    active: true,
    backend: 'codex',
    working_dir: '/tmp/test-repo',
    iteration: 1,
    max_iterations: 5,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000),
    max_time_minutes: 720,
    schema_version: 1,
    manager_relaunch_count: 0,
    original_prompt: 'manager-relaunch-backend-flip regression fixture',
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/test-session',
    ...overrides,
  };
}

test('AC-XBL-08: manager-relaunch-backend-flip — codex backend yields shouldRelaunch:true', () => {
  withCleanEnv(() => {
    const state = makeState({ backend: 'codex' });
    const decision = evaluateManagerRelaunch(state, PENDING_TICKETS, null);
    assert.equal(decision.shouldRelaunch, true, 'state.backend=codex with pending tickets must trigger relaunch');
    assert.equal(decision.reason, 'eligible', 'reason must be eligible for codex with pending work');
  });
});

test('AC-XBL-08: manager-relaunch-backend-flip — mutating to claude yields shouldRelaunch:true', () => {
  withCleanEnv(() => {
    const state = makeState({ backend: 'claude' });
    const decision = evaluateManagerRelaunch(state, PENDING_TICKETS, null);
    assert.equal(decision.shouldRelaunch, true, 'state.backend=claude with pending tickets must trigger relaunch');
    assert.equal(decision.reason, 'eligible');
    assert.equal(decision.cap, 20);
  });
});

test('AC-XBL-08: manager-relaunch-backend-flip — sequential flip: codex→true then claude→true', () => {
  // Core regression: single state object mutated between decisions, same ticket list.
  // Locks in manager-relaunch.ts behavior.
  withCleanEnv(() => {
    const state = makeState({ backend: 'codex' });

    const first = evaluateManagerRelaunch(state, PENDING_TICKETS, null);
    assert.equal(first.shouldRelaunch, true, 'first decision (codex) must shouldRelaunch');
    assert.equal(first.reason, 'eligible', 'first decision reason must be eligible');

    state.backend = 'claude';

    const second = evaluateManagerRelaunch(state, PENDING_TICKETS, null);
    assert.equal(second.shouldRelaunch, true, 'second decision (claude) must shouldRelaunch');
    assert.equal(second.reason, 'eligible');
    assert.equal(second.cap, 20);
  });
});

test('AC-XBL-08: manager-relaunch-backend-flip — state-file-backed: StateManager read path', () => {
  // Verifies the real dispatch path: state read via StateManager then evaluated.
  const tmpDir = makeTmpDir();
  try {
    const sessionDir = path.join(tmpDir, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    const statePath = path.join(sessionDir, 'state.json');

    const sm = new StateManager();

    fs.writeFileSync(statePath, JSON.stringify(makeState({ backend: 'codex', working_dir: sessionDir, session_dir: sessionDir }), null, 2));

    withCleanEnv(() => {
      const codexState = sm.read(statePath);
      const first = evaluateManagerRelaunch(codexState, PENDING_TICKETS, null);
      assert.equal(first.shouldRelaunch, true, 'state-file codex backend must shouldRelaunch');
      assert.equal(first.reason, 'eligible');
    });

    sm.update(statePath, s => { s.backend = 'claude'; });

    withCleanEnv(() => {
      const claudeState = sm.read(statePath);
      const second = evaluateManagerRelaunch(claudeState, PENDING_TICKETS, null);
      assert.equal(second.shouldRelaunch, true, 'state-file claude backend must shouldRelaunch');
      assert.equal(second.reason, 'eligible');
      assert.equal(second.cap, 20);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

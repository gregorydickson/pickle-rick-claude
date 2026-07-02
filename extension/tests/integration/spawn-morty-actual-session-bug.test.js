// @tier: integration
// R-XBL-7b — Reproduces actual session 2026-05-03-7d9ee8cc conditions.
// state.backend='claude', PICKLE_REFINEMENT_LOCK=1, manager-relaunch path triggered.
// Since c271a1f7 ("generalize manager relaunch handling") the relaunch evaluator
// is backend-agnostic: claude managers DO relaunch (R-MMTR-3), so the protection
// is no longer "no relaunch" but "the relaunch targets the claude backend, never
// codex". Assert decision.backend resolves to 'claude' — no codex hijack of a
// claude session. Bug was NOT env poisoning (that is R-XBL-7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluateManagerRelaunch } from '../../services/manager-relaunch.js';
import { StateManager } from '../../services/state-manager.js';

function makeTmpDir(prefix = 'pickle-xbl7b-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const PENDING_TICKETS = [
  { id: 'ticket-001', status: 'Todo', title: 'Pending work', order: 1, type: null, working_dir: null, completed_at: null, skipped_at: null },
  { id: 'ticket-002', status: 'Done', title: 'Already done', order: 2, type: null, working_dir: null, completed_at: null, skipped_at: null },
];

function writeSessionState(sessionDir, overrides = {}) {
  const state = {
    active: true,
    backend: 'claude',
    working_dir: sessionDir,
    iteration: 1,
    max_iterations: 5,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000),
    max_time_minutes: 720,
    schema_version: 1,
    codex_manager_relaunch_count: 0,
    original_prompt: 'actual session 2026-05-03-7d9ee8cc reproduction',
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    ...overrides,
  };
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state, null, 2));
}

function withRefinementLock(value, fn) {
  const prev = process.env.PICKLE_REFINEMENT_LOCK;
  try {
    if (value === undefined) {
      delete process.env.PICKLE_REFINEMENT_LOCK;
    } else {
      process.env.PICKLE_REFINEMENT_LOCK = value;
    }
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PICKLE_REFINEMENT_LOCK;
    else process.env.PICKLE_REFINEMENT_LOCK = prev;
  }
}

test('R-XBL-7b: spawn-morty-actual-session-bug — state.backend=claude + PICKLE_REFINEMENT_LOCK=1 relaunches as claude, never codex', () => {
  // Reproduces actual session 2026-05-03-7d9ee8cc: session was running as claude,
  // PICKLE_REFINEMENT_LOCK=1 was active, the manager-relaunch path evaluated.
  const tmpDir = makeTmpDir();
  try {
    const sessionDir = path.join(tmpDir, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    writeSessionState(sessionDir, { backend: 'claude' });

    withRefinementLock('1', () => {
      const sm = new StateManager();
      const state = sm.read(path.join(sessionDir, 'state.json'));

      const decision = evaluateManagerRelaunch(state, PENDING_TICKETS, null);

      assert.equal(decision.backend, 'claude', 'claude session must never be hijacked into a codex manager relaunch');
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('R-XBL-7b: spawn-morty-actual-session-bug — PICKLE_REFINEMENT_LOCK=1 forces claude even if state.backend=codex', () => {
  // Defense layer: even if state.backend='codex' (stale/mismatch scenario),
  // PICKLE_REFINEMENT_LOCK=1 forces resolveBackend to return 'claude', so the
  // relaunch decision resolves to the claude backend. The lock is non-overridable.
  const tmpDir = makeTmpDir();
  try {
    const sessionDir = path.join(tmpDir, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    writeSessionState(sessionDir, { backend: 'codex' });

    withRefinementLock('1', () => {
      const sm = new StateManager();
      const state = sm.read(path.join(sessionDir, 'state.json'));

      const decision = evaluateManagerRelaunch(state, PENDING_TICKETS, null);

      assert.equal(
        decision.backend,
        'claude',
        'refinement lock must force claude even when state.backend=codex',
      );
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('R-XBL-7b: spawn-morty-actual-session-bug — without PICKLE_REFINEMENT_LOCK, state.backend=claude still resolves claude', () => {
  // Belt-and-suspenders: even without the refinement lock, state.backend=claude
  // alone resolves the relaunch backend to claude. State is the single source
  // of truth (R-XBL-2) — no codex hijack.
  const tmpDir = makeTmpDir();
  try {
    const sessionDir = path.join(tmpDir, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    writeSessionState(sessionDir, { backend: 'claude' });

    withRefinementLock(undefined, () => {
      const sm = new StateManager();
      const state = sm.read(path.join(sessionDir, 'state.json'));

      const decision = evaluateManagerRelaunch(state, PENDING_TICKETS, null);

      assert.equal(decision.backend, 'claude', 'state.backend=claude must resolve claude without the refinement lock too');
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

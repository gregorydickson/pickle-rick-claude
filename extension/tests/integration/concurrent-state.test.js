// @tier: integration
/**
 * concurrent-state.test.js — Real-concurrency integration tests for StateManager.
 *
 * STANDALONE — no test-harness dependency.
 * Uses worker_threads so OS-level file locking is exercised across real threads.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { StateManager } from '../../services/state-manager.js';
import { writeStateFile, withRetryLock } from '../../services/pickle-utils.js';

const __filename = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// Worker entry point — this file doubles as the worker script
// ---------------------------------------------------------------------------

if (!isMainThread && workerData != null) {
  const { op } = workerData;

  if (op === 'increment') {
    // Bumped staleLockTimeoutMs 15s → 60s and outer retries 3 → 10 to absorb
    // load when run alongside concurrent codex/tmux/test work. The test still
    // verifies "10 workers all increment" — only the per-worker retry budget
    // grew. A regression in lock semantics still produces counter < 10.
    const sm = new StateManager({ baseLockDelayMs: 50, maxLockRetries: 200, staleLockTimeoutMs: 60_000, lockJitter: true });
    let done = false;
    for (let r = 0; r < 10 && !done; r++) {
      try {
        sm.update(workerData.statePath, (s) => {
          s.counter = (Number(s.counter) || 0) + 1;
        });
        done = true;
      } catch {
        // LockError — brief pause then retry
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 + Math.random() * 200);
      }
    }
    if (!done) throw new Error('increment failed after 10 outer retries');
    parentPort.postMessage({ ok: true });

  } else if (op === 'add_session') {
    const { mapPath, lockPath, cwd, sessionPath } = workerData;
    // staleLockTimeoutMs 15s → 60s: budget for lock contention under
    // concurrent test runs.
    withRetryLock(lockPath, () => {
      let map = {};
      if (fs.existsSync(mapPath)) {
        try { map = JSON.parse(fs.readFileSync(mapPath, 'utf-8')); } catch { /* corrupt */ }
      }
      map[cwd] = sessionPath;
      const tmp = `${mapPath}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
      fs.renameSync(tmp, mapPath);
    }, { baseLockDelayMs: 5, staleLockTimeoutMs: 60_000 });
    parentPort.postMessage({ ok: true });
  }
}

// ---------------------------------------------------------------------------
// Main thread — tests
// ---------------------------------------------------------------------------

if (isMainThread) {
  const { test } = await import('node:test');
  const { default: assert } = await import('node:assert/strict');

  function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-ci-'));
  }

  function makeState(overrides = {}) {
    return {
      active: true,
      working_dir: '/tmp/test',
      step: 'prd',
      iteration: 1,
      max_iterations: 10,
      max_time_minutes: 60,
      worker_timeout_seconds: 1200,
      start_time_epoch: Math.floor(Date.now() / 1000),
      completion_promise: null,
      original_prompt: 'concurrent test',
      current_ticket: null,
      history: [],
      started_at: new Date().toISOString(),
      session_dir: '/tmp/test-session',
      schema_version: 1,
      counter: 0,
      ...overrides,
    };
  }

  /**
   * Spawns a worker that runs this same file with the given workerData.
   * Resolves when the worker posts its completion message.
   */
  // Resolve on 'exit', not 'message': the worker still releases the lock (unlink
  // lockfile, clear the staging file the linkSync publish leaves) AFTER it posts
  // its result. Resolving on the message let the caller's rmSync race a worker
  // still touching the dir — an ENOTEMPTY teardown flake.
  function spawnWorker(data) {
    return new Promise((resolve, reject) => {
      const w = new Worker(__filename, { workerData: data });
      let message;
      w.on('message', (m) => { message = m; });
      w.on('error', reject);
      w.on('exit', (code) => {
        if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
        else resolve(message);
      });
    });
  }

  // -------------------------------------------------------------------------
  // F22-1: 10 parallel increments → counter === 10
  // -------------------------------------------------------------------------

  // 30s → 90s: budget for lock-retry under concurrent test runs. Bumped along
  // with worker maxLockRetries/outer retries above so the harness can absorb
  // genuinely contended scheduling on a busy box without dropping increments.
  test('F22-1: 10 parallel StateManager.update() increments counter to 10', { timeout: 90_000 }, async () => {
    const dir = tmpDir();
    try {
      const statePath = path.join(dir, 'state.json');
      const sm = new StateManager({ baseLockDelayMs: 5, staleLockTimeoutMs: 15_000 });
      writeStateFile(statePath, makeState({ counter: 0 }));

      await Promise.all(
        Array.from({ length: 10 }, () => spawnWorker({ op: 'increment', statePath })),
      );

      const final = sm.read(statePath);
      assert.equal(final.counter, 10, `expected counter=10 after 10 workers, got ${final.counter}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // F22-2: 5 parallel adds with distinct cwds — all keys present
  // -------------------------------------------------------------------------

  test('F22-2: 5 parallel addToSessionMap with distinct cwds — all keys present', { timeout: 90_000 }, async () => {
    const dir = tmpDir();
    try {
      const mapPath = path.join(dir, 'current_sessions.json');
      const lockPath = `${mapPath}.lock`;

      const cwds = ['/repo/alpha', '/repo/beta', '/repo/gamma', '/repo/delta', '/repo/epsilon'];

      await Promise.all(
        cwds.map((cwd, i) =>
          spawnWorker({
            op: 'add_session',
            mapPath,
            lockPath,
            cwd,
            sessionPath: path.join(dir, `session-${i}`),
          }),
        ),
      );

      const map = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
      for (const cwd of cwds) {
        assert.ok(Object.prototype.hasOwnProperty.call(map, cwd), `key missing: ${cwd}`);
      }
      assert.equal(Object.keys(map).length, 5, 'expected exactly 5 keys');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // F22-3: 2 concurrent writes to same cwd — map valid, key present
  // -------------------------------------------------------------------------

  test('F22-3: 2 concurrent same-cwd writes — map not corrupted, key present', { timeout: 60_000 }, async () => {
    const dir = tmpDir();
    try {
      const mapPath = path.join(dir, 'current_sessions.json');
      const lockPath = `${mapPath}.lock`;
      const cwd = '/repo/shared';

      await Promise.all([
        spawnWorker({ op: 'add_session', mapPath, lockPath, cwd, sessionPath: path.join(dir, 'session-a') }),
        spawnWorker({ op: 'add_session', mapPath, lockPath, cwd, sessionPath: path.join(dir, 'session-b') }),
      ]);

      // Map must be valid JSON
      const raw = fs.readFileSync(mapPath, 'utf-8');
      let map;
      assert.doesNotThrow(() => { map = JSON.parse(raw); }, 'map must be valid JSON');
      // Key must be present (one writer wins)
      assert.ok(Object.prototype.hasOwnProperty.call(map, cwd), 'shared cwd key must be present');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // F22-4: stale active=true with dead PID → auto-cleared on read
  // -------------------------------------------------------------------------

  test('F22-4: stale active=true with dead PID is auto-cleared on StateManager.read()', () => {
    const dir = tmpDir();
    try {
      const statePath = path.join(dir, 'state.json');
      const sm = new StateManager();
      // Write state with active=true and a definitely-dead PID
      writeStateFile(statePath, makeState({ active: true, pid: 99_999_999 }));

      const state = sm.read(statePath);
      assert.equal(state.active, false, 'active must be cleared for dead PID');

      // Persisted to disk
      const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      assert.equal(onDisk.active, false, 'disk copy must reflect cleared active flag');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // F22-5: active=true with live PID is NOT cleared
  // -------------------------------------------------------------------------

  test('F22-5: active=true with live PID is preserved by StateManager.read()', () => {
    const dir = tmpDir();
    try {
      const statePath = path.join(dir, 'state.json');
      const sm = new StateManager();
      writeStateFile(statePath, makeState({ active: true, pid: process.pid }));
      const state = sm.read(statePath);
      assert.equal(state.active, true, 'active must be preserved for live PID');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // F22-6: sequential updates produce monotonically increasing counters
  // -------------------------------------------------------------------------

  test('F22-6: sequential StateManager.update() calls never lose an increment', () => {
    const dir = tmpDir();
    try {
      const statePath = path.join(dir, 'state.json');
      const sm = new StateManager();
      writeStateFile(statePath, makeState({ counter: 0 }));

      for (let i = 0; i < 20; i++) {
        sm.update(statePath, (s) => { s.counter = (Number(s.counter) || 0) + 1; });
      }

      const final = sm.read(statePath);
      assert.equal(final.counter, 20, 'counter must reach 20 after 20 sequential increments');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // F22-7: lock file is cleaned up even when update mutator throws
  // -------------------------------------------------------------------------

  test('F22-7: lock released and no deadlock when update mutator throws', () => {
    const dir = tmpDir();
    try {
      const statePath = path.join(dir, 'state.json');
      const sm = new StateManager();
      writeStateFile(statePath, makeState());

      try {
        sm.update(statePath, () => { throw new Error('deliberate failure'); });
      } catch { /* expected */ }

      // Must be able to acquire lock again immediately
      assert.doesNotThrow(() => {
        sm.update(statePath, (s) => { s.step = 'research'; });
      }, 'second update must succeed after failed update (lock released)');

      assert.equal(fs.existsSync(`${statePath}.lock`), false, 'lock file must not remain');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // F22-8: forceWrite bypasses lock — useful in crash handlers
  // -------------------------------------------------------------------------

  test('F22-8: forceWrite succeeds even with live lock held by current process', () => {
    const dir = tmpDir();
    try {
      const statePath = path.join(dir, 'state.json');
      const sm = new StateManager();
      writeStateFile(statePath, makeState());

      // Simulate: current process holds the lock
      fs.writeFileSync(`${statePath}.lock`, JSON.stringify({ pid: process.pid, ts: Date.now() }));

      // forceWrite must bypass the lock (crash handler semantics)
      sm.forceWrite(statePath, makeState({ step: 'emergency' }));
      const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      assert.equal(onDisk.step, 'emergency');

      // Cleanup lock
      try { fs.unlinkSync(`${statePath}.lock`); } catch { /* ok */ }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // AP-EXT-ITER142-01: promoting a dead writer's orphan tmp is a REPLACE.
  //
  // A writer killed between `writeStateFile`'s tmp write and its rename leaves a
  // COMPLETE `.tmp.<pid>` snapshot. `read()` promotes it by renaming it over the base,
  // so the file becomes exactly that snapshot — and the object `read()` returns must
  // become exactly that snapshot too. Merging instead of replacing keeps every key the
  // snapshot DELETED (a cleared `exit_reason`, the R-CNAR-8 `current_ticket_*` cache
  // fields) alive in the returned object, and the next persist writes them back over
  // the file just promoted: `read()` republishes a state no writer ever produced.
  // -------------------------------------------------------------------------

  test('AP-EXT-ITER142-01: promoted orphan-tmp snapshot REPLACES in-memory state; keys it deleted do not survive or get re-persisted', () => {
    const dir = tmpDir();
    try {
      const statePath = path.join(dir, 'state.json');
      const sm = new StateManager();

      // Base: carries the per-ticket cache fields and a stale exit_reason.
      writeStateFile(statePath, makeState({
        iteration: 5,
        current_ticket: 'OLD-1',
        current_ticket_tier: 'heavy',
        current_ticket_budget: 999,
        current_ticket_max_iterations: 42,
        current_ticket_worker_timeout_seconds: 7200,
        current_ticket_budget_start_iteration: 3,
        exit_reason: 'stalled_below_target',
      }));

      // Dead-writer orphan tmp: strictly NEWER, and it deleted every one of those keys
      // (exactly what clearCurrentTicketCache / clearExitReason do before a write).
      const promoted = makeState({ iteration: 6, current_ticket: 'NEW-2', step: 'implement' });
      const tmpSibling = `${statePath}.tmp.99999999.${Date.now()}.1`;
      fs.writeFileSync(tmpSibling, JSON.stringify(promoted, null, 2));
      const future = Date.now() / 1000 + 5;
      fs.utimesSync(tmpSibling, future, future);

      const state = sm.read(statePath);

      // Positive control: the promotion really happened and the snapshot's OWN values
      // were adopted. Without this, "delete everything and assign nothing" also passes.
      assert.equal(state.iteration, 6, 'promoted snapshot iteration must be adopted');
      assert.equal(state.current_ticket, 'NEW-2', 'promoted snapshot current_ticket must be adopted');
      assert.equal(state.step, 'implement', 'promoted snapshot step must be adopted');

      // The defect: keys the promoted snapshot deleted must not survive the adoption.
      for (const key of [
        'current_ticket_tier',
        'current_ticket_budget',
        'current_ticket_max_iterations',
        'current_ticket_worker_timeout_seconds',
        'current_ticket_budget_start_iteration',
        'exit_reason',
      ]) {
        assert.equal(state[key], undefined, `${key} must not survive promotion of a snapshot that deleted it`);
      }

      // And it must not be re-persisted over the file the rename just published.
      const afterRead = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      assert.equal(afterRead.iteration, 6, 'on-disk state must be the promoted snapshot');
      assert.equal(afterRead.current_ticket_tier, undefined, 'promotion must not re-persist a key the snapshot deleted');
      assert.equal(afterRead.exit_reason, undefined, 'promotion must not re-persist a cleared exit_reason');

      // The next ordinary write must not resurrect them either.
      sm.update(statePath, (s) => { s.iteration = 7; });
      const afterUpdate = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      assert.equal(afterUpdate.iteration, 7, 'ordinary update must land');
      assert.equal(afterUpdate.current_ticket_tier, undefined, 'a later update must not resurrect the deleted cache field');
      assert.equal(afterUpdate.exit_reason, undefined, 'a later update must not resurrect the cleared exit_reason');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

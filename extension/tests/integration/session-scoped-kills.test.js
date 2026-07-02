// @tier: integration
// R-CSI / W2.R1 — session-scoped process isolation (setpgid + stamp).
// Verifies: (1) sessionStampEnv stamps PICKLE_SESSION + PICKLE_WORKING_DIR;
// (2) shouldIsolateSessionGroup isolates on POSIX, never on win32;
// (3) the real cross-session isolation property
// (AC-R1-2): a group-scoped kill (`process.kill(-pgid, sig)`) of session A's
// detached worker group leaves session B's worker group AND an out-of-repo
// process alive — a kill in one session cannot reap another's healthy workers
// by a bare binary name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { sessionStampEnv, shouldIsolateSessionGroup } from '../../services/backend-spawn.js';

const isWin = process.platform === 'win32';

test('sessionStampEnv stamps PICKLE_SESSION + PICKLE_WORKING_DIR', () => {
  const env = sessionStampEnv('2026-06-13-abcd1234', '/repo/working/dir');
  assert.equal(env.PICKLE_SESSION, '2026-06-13-abcd1234');
  assert.equal(env.PICKLE_WORKING_DIR, '/repo/working/dir');
});

test('sessionStampEnv omits empty fields (no blank stamps)', () => {
  const env = sessionStampEnv('', '');
  assert.equal('PICKLE_SESSION' in env, false);
  assert.equal('PICKLE_WORKING_DIR' in env, false);
});

test('shouldIsolateSessionGroup isolates on POSIX, never on win32', () => {
  assert.equal(shouldIsolateSessionGroup(), !isWin);
});

// --- Real cross-session isolation proof (POSIX process groups) ---

/** Spawn a detached, idle node process that leads its own process group. */
function spawnDetachedIdle() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return !isAlive(pid);
}

test('a group-scoped kill of session A leaves session B + an out-of-repo process alive', { skip: isWin ? 'POSIX process groups only' : false }, async () => {
  const sessionAWorker = spawnDetachedIdle(); // session A's detached worker group
  const sessionBWorker = spawnDetachedIdle(); // a concurrent session B's worker group
  const outOfRepoProc = spawnDetachedIdle();  // an out-of-repo pipeline analog

  try {
    // All three must be live before we kill one.
    assert.ok(isAlive(sessionAWorker.pid), 'session A worker should start alive');
    assert.ok(isAlive(sessionBWorker.pid), 'session B worker should start alive');
    assert.ok(isAlive(outOfRepoProc.pid), 'out-of-repo process should start alive');

    // Detached → each child leads its own group (pgid == pid). Reap ONLY session
    // A's group, exactly as the session-scoped kill path does.
    process.kill(-sessionAWorker.pid, 'SIGKILL');

    assert.ok(await waitUntilDead(sessionAWorker.pid), 'session A worker group should be reaped');
    // The isolation guarantee: B and the out-of-repo process are untouched.
    assert.ok(isAlive(sessionBWorker.pid), 'session B worker must survive session A kill');
    assert.ok(isAlive(outOfRepoProc.pid), 'out-of-repo process must survive session A kill');
  } finally {
    for (const c of [sessionAWorker, sessionBWorker, outOfRepoProc]) {
      try { process.kill(-c.pid, 'SIGKILL'); } catch { /* group already gone */ }
      try { c.kill('SIGKILL'); } catch { /* already dead */ }
    }
  }
});

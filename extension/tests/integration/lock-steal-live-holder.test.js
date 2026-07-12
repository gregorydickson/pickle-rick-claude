// @tier: integration
/**
 * lock-steal-live-holder.test.js — a stale-lock steal must never evict a LIVE holder.
 *
 * All three file locks in the tree (withRetryLock's session-map lock, StateManager's state.json lock,
 * and withLock's gate lock) recover from an abrupt-death strand by stealing the dead holder's
 * lockfile. The steal is two operations on a PATH — form a staleness verdict, then remove the file —
 * and between them a rival can evict the dead holder and take a live lock at that same path. The
 * loser then removes the live holder's lockfile and walks into the critical section alongside it.
 *
 * The gate lock reached this contract last: it hand-rolled its own acquire/release, wrote a
 * {pid,ts} payload nothing ever read back, and had NO steal path at all — so one SIGKILL wedged
 * every later gate for that workingDir, permanently. It steals ONLY on positive proof of death: a
 * gate legitimately holds for minutes (it wraps a full typecheck/lint/test run), so the age-based
 * arm the session-map lock carries would evict a live holder here.
 *
 * Observed pre-fix on the deployed build: 8 processes contending behind one dead-pid lock lost
 * updates in 30/30 rounds. The steal now carries the inode it judged and refuses to evict anything
 * else, so the verdict and the eviction are provably about the same file.
 *
 * `tests/integration/chaos/lock-contention.test.js` races two LIVE writers and never plants a dead
 * holder, so the steal path it would have to enter is unreachable there. This file owns that path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { inspectLockFile, stealLockFile, withLock } from '../../services/state-manager.js';
import { LockError } from '../../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PICKLE_UTILS = path.resolve(__dirname, '../../services/pickle-utils.js');
const STATE_MANAGER = path.resolve(__dirname, '../../services/state-manager.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-lock-steal-'));
}

/** Mirrors the private `gateLockPath` in state-manager.ts — the gate lock is NOT session-scoped. */
function gateLockPath(key) {
  const hash = createHash('sha256').update(key).digest('hex');
  return path.join(os.tmpdir(), `pickle-gate-lock-${hash}.lock`);
}

function gateKey(label) {
  return `gate-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function removeGateLock(lp) {
  for (const p of [lp, `${lp}.steal`]) {
    try { fs.unlinkSync(p); } catch { /* already gone */ }
  }
}

/** A pid that is provably dead: spawn a process, wait for its exit, reuse its pid. */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  const pid = child.pid;
  await once(child, 'exit');
  return pid;
}

// --- the primitive: identity-checked steal ---------------------------------------------------

test('stealLockFile refuses to evict a live holder that replaced the inspected lock', async () => {
  const dir = tmpDir();
  const lock = path.join(dir, 'map.lock');

  // A dead holder's lock is on disk, and a contender inspects it and judges it stale.
  fs.writeFileSync(lock, String(await deadPid()));
  const snapshot = inspectLockFile(lock);
  assert.ok(snapshot, 'contender must be able to inspect the dead holder lock');

  // Before the contender acts on that verdict, a RIVAL steals the dead lock and acquires its own.
  // This is the exact interleave: same path, different file.
  fs.unlinkSync(lock);
  fs.writeFileSync(lock, String(process.pid)); // rival is alive — it is us
  const liveIno = fs.statSync(lock).ino;
  assert.notEqual(liveIno, snapshot.ino, 'rival must hold a genuinely different file');

  // The contender now performs the steal it decided on. It must NOT take the rival's live lock.
  const stole = stealLockFile(lock, snapshot);

  assert.equal(stole, false, 'contender must report that it stole nothing');
  assert.ok(fs.existsSync(lock), 'the live holder’s lock must survive');
  assert.equal(fs.statSync(lock).ino, liveIno, 'the surviving lock must be the SAME file, restored');
  assert.equal(fs.readFileSync(lock, 'utf-8'), String(process.pid), 'live holder’s payload intact');

  // No tombstone litter left behind.
  assert.deepEqual(fs.readdirSync(dir), ['map.lock']);
});

test('stealLockFile evicts the lock when it is still the inode that was inspected', async () => {
  const dir = tmpDir();
  const lock = path.join(dir, 'map.lock');
  fs.writeFileSync(lock, String(await deadPid()));

  const snapshot = inspectLockFile(lock);
  assert.equal(stealLockFile(lock, snapshot), true);
  assert.equal(fs.existsSync(lock), false, 'the dead holder’s lock is gone');
  assert.deepEqual(fs.readdirSync(dir), [], 'no tombstone litter');
});

test('inspectLockFile reads identity, age and payload from one snapshot; null when absent', () => {
  const dir = tmpDir();
  const lock = path.join(dir, 'map.lock');

  assert.equal(inspectLockFile(lock), null, 'absent lock is not an error');

  fs.writeFileSync(lock, '4242');
  const snapshot = inspectLockFile(lock);
  assert.equal(snapshot.payload, '4242');
  assert.equal(snapshot.ino, fs.statSync(lock).ino);
  assert.ok(Number.isFinite(snapshot.mtimeMs));
});

// --- the data flow: real processes through the real locks ------------------------------------

/**
 * Runs `contenders` real processes that all pass a file barrier at once and then take `lockModule`'s
 * lock to do a read-modify-write. They start out contending behind a DEAD holder, so every one of
 * them enters the steal path simultaneously. Returns the final counter value.
 */
async function raceBehindDeadHolder({ dir, body, contenders }) {
  const counter = path.join(dir, 'counter.json');
  const go = path.join(dir, 'go');
  const child = path.join(dir, 'child.mjs');

  fs.writeFileSync(counter, JSON.stringify({ n: 0 }));
  fs.writeFileSync(child, body);

  const kids = Array.from({ length: contenders }, () =>
    spawn(process.execPath, [child, dir], { stdio: ['ignore', 'ignore', 'pipe'] }));

  // Let every contender reach the barrier, so they all form their steal verdict together.
  await new Promise((resolve) => setTimeout(resolve, 500));
  fs.writeFileSync(go, '1');
  await Promise.all(kids.map((k) => once(k, 'exit')));

  return JSON.parse(fs.readFileSync(counter, 'utf-8')).n;
}

test('withRetryLock: concurrent session-map writers behind a dead holder lose no updates', async () => {
  const dir = tmpDir();
  const contenders = 8;

  // The session-map lock guards a read-modify-write of current_sessions.json (setup.ts:updateSessionMap,
  // cancel.ts). A double holder silently drops one process's map entry.
  fs.writeFileSync(path.join(dir, 'map.lock'), String(await deadPid()));

  const n = await raceBehindDeadHolder({
    dir,
    contenders,
    body: `
      import fs from 'node:fs';
      import path from 'node:path';
      import { withRetryLock } from ${JSON.stringify(PICKLE_UTILS)};
      const dir = process.argv[2];
      while (!fs.existsSync(path.join(dir, 'go'))) { /* barrier */ }
      const counter = path.join(dir, 'counter.json');
      withRetryLock(path.join(dir, 'map.lock'), () => {
        const n = JSON.parse(fs.readFileSync(counter, 'utf-8')).n;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120); // hold, so a co-holder is observable
        fs.writeFileSync(counter, JSON.stringify({ n: n + 1 }));
      }, { maxRetries: 40, baseLockDelayMs: 20 });
    `,
  });

  assert.equal(n, contenders,
    `expected ${contenders} serialized updates, saw ${n} — two processes held the session-map lock at once`);
});

test('StateManager: concurrent state writers behind a dead holder lose no updates', async () => {
  const dir = tmpDir();
  const contenders = 8;
  const statePath = path.join(dir, 'state.json');

  fs.writeFileSync(statePath, JSON.stringify({ schema_version: 5, iteration: 0, active: true }));
  fs.writeFileSync(`${statePath}.lock`, JSON.stringify({ pid: await deadPid(), ts: Date.now() }));

  const kids = Array.from({ length: contenders }, () =>
    spawn(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import path from 'node:path';
      import { StateManager } from ${JSON.stringify(STATE_MANAGER)};
      const dir = ${JSON.stringify(dir)};
      while (!fs.existsSync(path.join(dir, 'go'))) { /* barrier */ }
      const sm = new StateManager({ maxLockRetries: 40, baseLockDelayMs: 20 });
      sm.update(path.join(dir, 'state.json'), (s) => {
        const n = s.iteration;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
        s.iteration = n + 1;
      });
    `], { stdio: ['ignore', 'ignore', 'pipe'] }));

  await new Promise((resolve) => setTimeout(resolve, 500));
  fs.writeFileSync(path.join(dir, 'go'), '1');
  await Promise.all(kids.map((k) => once(k, 'exit')));

  const iteration = JSON.parse(fs.readFileSync(statePath, 'utf-8')).iteration;
  assert.equal(iteration, contenders,
    `expected ${contenders} serialized updates, saw ${iteration} — two processes held the state lock at once`);
});

// --- the gate lock: the third lock, which had no steal path at all ---------------------------

test('withLock: a gate lock stranded by a dead holder is reclaimed, not waited out', async () => {
  const key = gateKey('strand');
  const lp = gateLockPath(key);

  // The exact abrupt-death strand: a gate holder was SIGKILLed and never reached its release.
  // The lock lives in os.tmpdir() keyed by workingDir, so it outlives the pipeline that stranded it.
  fs.writeFileSync(lp, String(await deadPid()));

  try {
    let ran = false;
    await withLock(key, { timeout_ms: 2_000, retry_interval_ms: 25 }, async () => { ran = true; });

    assert.ok(ran, 'the gate must reclaim a provably-dead holder and run — pre-fix it waited out the '
      + 'full timeout and threw LockError, so every later gate for that workingDir wedged forever');
    assert.equal(fs.existsSync(lp), false, 'the reclaimed lock is released on the way out');
  } finally {
    removeGateLock(lp);
  }
});

test('withLock: a LIVE gate holder is never stolen', async () => {
  const key = gateKey('live');
  const lp = gateLockPath(key);

  // A gate legitimately holds for minutes (typecheck + lint + tests). Our own pid is alive, so this
  // is a live holder — the reclaim must refuse it and the contender must time out rather than walk
  // into the critical section alongside it.
  fs.writeFileSync(lp, String(process.pid));

  try {
    await assert.rejects(
      () => withLock(key, { timeout_ms: 300, retry_interval_ms: 25 }, async () => {}),
      (err) => err instanceof LockError && err.key === key,
      'a live gate holder must survive: reclaim requires positive proof of death, not age',
    );
    assert.equal(fs.readFileSync(lp, 'utf-8'), String(process.pid), 'live holder’s lock is untouched');
  } finally {
    removeGateLock(lp);
  }
});

test('withLock: concurrent gate writers behind a dead holder lose no updates', async () => {
  const dir = tmpDir();
  const contenders = 8;
  const key = gateKey('race');
  const lp = gateLockPath(key);

  // Every contender forms its steal verdict against the SAME dead holder at once. Without the
  // withStealRight serialization, one evicts the dead lock, another takes a live lock at that path,
  // and a third removes THAT — two gates then write gate/baseline.json concurrently.
  fs.writeFileSync(lp, String(await deadPid()));

  try {
    const n = await raceBehindDeadHolder({
      dir,
      contenders,
      body: `
        import fs from 'node:fs';
        import path from 'node:path';
        import { withLock } from ${JSON.stringify(STATE_MANAGER)};
        const dir = process.argv[2];
        while (!fs.existsSync(path.join(dir, 'go'))) { /* barrier */ }
        const counter = path.join(dir, 'counter.json');
        await withLock(${JSON.stringify(key)}, { timeout_ms: 20_000, retry_interval_ms: 20 }, async () => {
          const n = JSON.parse(fs.readFileSync(counter, 'utf-8')).n;
          await new Promise((r) => setTimeout(r, 120)); // hold, so a co-holder is observable
          fs.writeFileSync(counter, JSON.stringify({ n: n + 1 }));
        });
      `,
    });

    assert.equal(n, contenders,
      `expected ${contenders} serialized updates, saw ${n} — two processes held the gate lock at once`);
  } finally {
    removeGateLock(lp);
  }
});

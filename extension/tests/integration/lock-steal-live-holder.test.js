// @tier: integration
/**
 * lock-steal-live-holder.test.js — a stale-lock steal must never evict a LIVE holder.
 *
 * Both file locks in the tree (withRetryLock's session-map lock and StateManager's state.json lock)
 * recover from an abrupt-death strand by stealing the dead holder's lockfile. The steal is two
 * operations on a PATH — form a staleness verdict, then remove the file — and between them a rival
 * can evict the dead holder and take a live lock at that same path. The loser then removes the live
 * holder's lockfile and walks into the critical section alongside it.
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
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { inspectLockFile, stealLockFile } from '../../services/state-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PICKLE_UTILS = path.resolve(__dirname, '../../services/pickle-utils.js');
const STATE_MANAGER = path.resolve(__dirname, '../../services/state-manager.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-lock-steal-'));
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

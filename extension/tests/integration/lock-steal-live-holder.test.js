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
import { fileURLToPath, pathToFileURL } from 'node:url';

import { StateManager, acquireLockFile, inspectLockFile, isDeadPidPayload, isProcessAlive, stealLockFile, withLock } from '../../services/state-manager.js';
import { applyCourseCorrectionRestructure } from '../../services/transaction-ticket-ops.js';
import { spawnGateRemediatorMain } from '../../bin/spawn-gate-remediator.js';
import { LockError } from '../../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PICKLE_UTILS = path.resolve(__dirname, '../../services/pickle-utils.js');
const STATE_MANAGER_SRC = path.resolve(__dirname, '../../src/services/state-manager.ts');
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
  // This is the exact interleave: same path, different acquisition.
  //
  // Do NOT assert the rival landed on a different inode. ext4 recycles inode numbers immediately,
  // so on Linux the rival routinely gets the SAME number the dead holder had — which is precisely
  // why identity cannot be the inode number. Asserting otherwise only asserts which filesystem we
  // are on; the behaviour below must hold either way.
  fs.unlinkSync(lock);
  fs.writeFileSync(lock, String(process.pid)); // rival is alive — it is us
  const liveIno = fs.statSync(lock).ino;

  // The contender now performs the steal it decided on. It must NOT take the rival's live lock.
  const stole = stealLockFile(lock, snapshot);

  assert.equal(stole, false, 'contender must report that it stole nothing');
  assert.ok(fs.existsSync(lock), 'the live holder’s lock must survive');
  assert.equal(fs.statSync(lock).ino, liveIno, 'the surviving lock must be the SAME file, untouched');
  assert.equal(fs.readFileSync(lock, 'utf-8'), String(process.pid), 'live holder’s payload intact');

  // No tombstone litter left behind.
  assert.deepEqual(fs.readdirSync(dir), ['map.lock']);
});

// R-LSPC-2. The ONLY reason the case above went green on macOS is that APFS does not recycle inode
// numbers eagerly; ext4 does, and hands the rival's brand-new lock the very number the dead holder's
// had. An ino-only check then reads "still the file I judged" and evicts a LIVE holder. Reproduce
// that deterministically on ANY filesystem by handing stealLockFile the verdict it formed, wearing
// the live file's inode — byte-for-byte what a recycled inode looks like from the code's side.
// This test FAILS against an inode-only comparison, on every platform. That is the point: the bug
// hid for three releases behind a filesystem that happened to be forgiving.
test('stealLockFile refuses a live holder that landed on the RECYCLED inode of the lock it judged', async () => {
  const dir = tmpDir();
  const lock = path.join(dir, 'map.lock');

  fs.writeFileSync(lock, String(await deadPid()));
  const judged = inspectLockFile(lock);
  assert.ok(judged, 'contender must be able to inspect the dead holder lock');

  // The rival replaces it, and the filesystem recycles the inode number straight back.
  fs.unlinkSync(lock);
  fs.writeFileSync(lock, String(process.pid)); // rival is alive — it is us
  const live = inspectLockFile(lock);
  assert.ok(live, 'the rival lock must be inspectable');

  const recycled = { ...judged, ino: live.ino };
  assert.equal(recycled.ino, live.ino, 'fixture: the judged snapshot now wears the LIVE inode');
  assert.notEqual(recycled.raw, live.raw, 'fixture: but the bytes are still the dead holder’s');

  const stole = stealLockFile(lock, recycled);

  assert.equal(stole, false, 'an inode-number match is NOT proof of identity — the steal must refuse');
  assert.ok(fs.existsSync(lock), 'the live holder’s lock must survive an inode-number collision');
  assert.equal(fs.readFileSync(lock, 'utf-8'), String(process.pid), 'live holder’s payload intact');
  assert.deepEqual(fs.readdirSync(dir), ['map.lock'], 'no tombstone litter');
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

/**
 * A steal that renames the lock away before it can see what it captured has to vacate the path to
 * judge it. On a mismatch it cannot put the file back atomically: a contender that acquires in that
 * window makes the restoring `link` fail EEXIST, the cleanup unlinks the file regardless, and the
 * steal has destroyed a live lock it neither created nor judged — while its holder's inode is still
 * in `lockInodes`, so both processes proceed into the critical section and a state update is lost.
 *
 * That damage is only observable when a contender lands inside the window, which no single-threaded
 * test can force, and `state-manager.ts` imports `* as fs` — a sealed namespace, so the restoring
 * link cannot be made to fail from here either. What IS checkable is the shape that makes the window
 * impossible: judge the lock through a second link, and remove it only once its inode is proven to
 * be the one that was judged. `withStealRight` cannot cover this — the steal that reclaims a
 * stranded steal-rights lock (`withStealRight` itself) is the one steal nothing can serialize.
 */
test('stealLockFile verifies the inode before it removes the lock — never the other way round', () => {
  const src = fs.readFileSync(STATE_MANAGER_SRC, 'utf-8');
  const body = src.slice(
    src.indexOf('export function stealLockFile'),
    src.indexOf('export function withStealRight'),
  );
  assert.ok(body.length > 0, 'stealLockFile must precede withStealRight in state-manager.ts');

  assert.ok(
    body.includes('fs.linkSync(lockPath, tombstone)'),
    'the lock must be judged through a SECOND LINK, so it is never unpublished while unverified',
  );
  assert.ok(
    !/fs\.renameSync\(\s*lockPath/.test(body),
    'renaming the lock away before the identity check vacates the path — a contender acquires in ' +
      'that window and the mismatch cleanup then destroys its brand-new lock',
  );

  // Identity is the full bytes + inode (sameLock), NOT the inode number: ext4 recycles inode
  // numbers, so an ino-only verdict evicts a live holder that landed on the recycled number.
  const verdict = body.indexOf('sameLock(stolen, snapshot)');
  const removal = body.indexOf('fs.unlinkSync(lockPath)');
  assert.ok(verdict > 0, 'the full-identity check must be present (inode number alone is not identity)');
  assert.equal(body.includes('stolenIno !== snapshot.ino'), false,
    'the ino-only verdict must be gone — it evicts a live holder on a recycled inode');
  assert.ok(removal > 0, 'the removal of the judged lock must be present');
  assert.ok(verdict < removal, 'the identity check must run BEFORE the lock is removed');
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

// AP-EXT-ITER192-01. Every other lock in this file has a "LIVE holder is never stolen" case; the
// state.json lock — the highest-value one — did not, and that gap is exactly where an age-based
// steal arm survived. `StateManager.acquireLock` wrote a `{pid,ts}` payload and its private
// `isStaleLockSnapshot` read `ts`, so a holder older than `staleLockTimeoutMs` (30s by default) was
// judged stale WHETHER OR NOT IT WAS ALIVE. `transaction` holds this lock across
// `applyTicketFileWrites`, i.e. for as long as a restructure takes to rewrite every ticket in the
// session — the very duration `reclaimDeadRestructureLock` refuses an age verdict over. The steal
// then puts two writers in the critical section and one silently erases the other's `state.json`.
//
// The pre-existing dead-holder case above plants a FRESH `ts`, so it goes green on the death arm
// alone and never noticed the age arm; this case plants a LIVE pid with a STALE `ts`, which only the
// age arm can act on. Both must hold: reclaim a dead holder at any age, never a live one at any age.
test('AP-EXT-ITER192-01: a LIVE state holder is never stolen, however old its lock is', () => {
  const dir = tmpDir();
  const statePath = path.join(dir, 'state.json');
  const lp = `${statePath}.lock`;

  try {
    fs.writeFileSync(statePath, JSON.stringify({ schema_version: 5, iteration: 0, active: true }));

    // Our own pid is alive, and the lock is far older than the 30s default window.
    const payload = JSON.stringify({ pid: process.pid, ts: Date.now() - 120_000 });
    fs.writeFileSync(lp, payload);

    const sm = new StateManager({ maxLockRetries: 1, baseLockDelayMs: 5, lockJitter: false });

    assert.throws(
      () => sm.update(statePath, (s) => { s.iteration = 99; }),
      (err) => err instanceof LockError && err.code === 'LOCK_FAILED',
      'a live state holder must survive: the steal verdict is proof of death, never age',
    );

    assert.equal(fs.readFileSync(lp, 'utf-8'), payload, 'live holder’s lock must be untouched');
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf-8')).iteration, 0,
      'the contender must not have entered the critical section and written state.json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

// --- the fourth lock: restructure.lock -------------------------------------------------------
//
// The course-correction transaction lock was the last holdout of the shape the gate lock shed: an
// O_EXCL create, a {pid,ts} payload nothing read back, and a bare unlink release. It had no steal
// path, so one SIGKILL stranded restructure.lock and every later course correction for that session
// died on EEXIST — permanently, with no runtime recovery. Like the gate lock it steals ONLY on proof
// of death: a restructure legitimately holds while it rewrites every ticket in the session.

function writeTicket(sessionDir, ticketId) {
  const ticketPath = path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`);
  fs.mkdirSync(path.dirname(ticketPath), { recursive: true });
  const content = ['---', `id: ${ticketId}`, 'status: "Todo"', 'title: "Example"', '---', '', '# Example', ''].join('\n');
  fs.writeFileSync(ticketPath, content);
  return { ticketPath, content };
}

function writeState(sessionDir) {
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    active: true, working_dir: sessionDir, step: 'implement', iteration: 1, max_iterations: 3,
    max_time_minutes: 30, worker_timeout_seconds: 1200, start_time_epoch: 1, completion_promise: null,
    original_prompt: 'test', current_ticket: 'kill123', history: [], started_at: '2026-04-30T00:00:00.000Z',
    session_dir: sessionDir, schema_version: 3, tickets_version: 4, last_course_correction: null, activity: [],
  }, null, 2));
}

function restructure(sessionDir) {
  return applyCourseCorrectionRestructure({
    sessionRoot: sessionDir,
    proposalPath: path.join(sessionDir, 'change_proposal_2026-04-30T12-00-00Z.md'),
    restartTicketId: null,
    killedTicketIds: ['kill123'],
    now: '2026-04-30T12:00:00.000Z',
  });
}

test('applyCourseCorrectionRestructure: a restructure lock stranded by a dead holder is reclaimed', async () => {
  const dir = tmpDir();
  try {
    const killed = writeTicket(dir, 'kill123');
    writeState(dir);

    // A restructure was SIGKILLed mid-transaction: its lockfile outlives the process that made it.
    const lock = path.join(dir, 'restructure.lock');
    fs.writeFileSync(lock, String(await deadPid()));

    const result = restructure(dir);

    assert.equal(result.ticketsVersion, 5, 'the restructure must reclaim the strand and run, not die on EEXIST');
    assert.match(fs.readFileSync(killed.ticketPath, 'utf-8'), /^status: "Killed"$/m);
    assert.equal(fs.existsSync(lock), false, 'the reclaimed lock is released on the way out, not leaked');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applyCourseCorrectionRestructure: a LIVE restructure holder is never stolen', () => {
  const dir = tmpDir();
  try {
    const killed = writeTicket(dir, 'kill123');
    writeState(dir);

    // The holder is this very process — demonstrably alive, so its pid can never read as dead.
    const lock = path.join(dir, 'restructure.lock');
    fs.writeFileSync(lock, String(process.pid));

    assert.throws(() => restructure(dir), /EEXIST/, 'a live holder must still be refused');

    assert.equal(fs.readFileSync(killed.ticketPath, 'utf-8'), killed.content,
      'the live holder’s in-flight transaction must be untouched');
    assert.equal(fs.readFileSync(lock, 'utf-8'), String(process.pid), 'the live holder’s lock must survive');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- the sixth lock: remediator.lockfile ------------------------------------------------------
//
// R-GRLS. The gate remediator was the last holdout of the shape the gate and restructure locks shed:
// an O_EXCL create with NO payload at all, and a release wired only to `process.on('exit')` — which
// SIGKILL/SIGTERM skip. One abrupt death stranded gate/remediator.lockfile, and because the EEXIST
// branch returns exit code 0, every later remediator for that session exited CLEAN having edited
// nothing — indistinguishable from a successful remediation. That is the false-GREEN class: a red
// gate reported as handled. Like its siblings it now reclaims ONLY on proof of death — a remediator
// legitimately holds for minutes while it drives a worker turn, so an age verdict would evict a live one.

function writeGateResult(sessionDir) {
  const gateDir = path.join(sessionDir, 'gate');
  fs.mkdirSync(gateDir, { recursive: true });
  const gateResultPath = path.join(gateDir, 'gate_result.json');
  fs.writeFileSync(gateResultPath, JSON.stringify({
    status: 'red',
    elapsed_ms: 1234,
    failures: [{
      check: 'typecheck', file: 'src/thing.ts', line: 12, ruleOrCode: 'TS2345',
      message: 'Argument of type string is not assignable to parameter of type number',
      severity: 'error', occurrence_index: 0,
    }],
  }));
  return { gateDir, gateResultPath };
}

async function runRemediator(sessionDir, gateResultPath) {
  const out = [];
  const code = await spawnGateRemediatorMain({
    argv: ['--gate-result', gateResultPath, '--session-root', sessionDir, '--reason', 'strict'],
    isoOverride: '2026-04-30T12-00-00Z',
    extensionClaudeMdContent: '## Trap Doors\n\n_none_\n',
    stdout: (m) => out.push(m),
    stderr: () => {},
  });
  return { code, out };
}

test('spawn-gate-remediator: a remediator lock stranded by a dead holder is reclaimed and the gate IS remediated', async () => {
  const dir = tmpDir();
  try {
    const { gateDir, gateResultPath } = writeGateResult(dir);

    // A remediator was SIGKILLed mid-run: its payload-bearing lockfile outlives the process.
    const lock = path.join(gateDir, 'remediator.lockfile');
    fs.writeFileSync(lock, String(await deadPid()));

    const { code, out } = await runRemediator(dir, gateResultPath);

    assert.equal(code, 0);
    // The load-bearing assertion: real work, not a clean no-op. Pre-fix this emitted LOCKOUT_PATH
    // and wrote no brief, while still exiting 0 — the caller could not tell the two apart.
    assert.ok(out.some(l => l.startsWith('BRIEF_PATH=')),
      'the strand must be reclaimed and the brief written, not skipped as a concurrent run');
    assert.ok(!out.some(l => l.startsWith('LOCKOUT_PATH=')), 'a dead holder must not produce a lockout');
    const briefs = fs.readdirSync(gateDir).filter(f => f.endsWith('_brief.md'));
    assert.equal(briefs.length, 1, 'exactly one remediation brief must exist on disk');
    assert.equal(fs.existsSync(lock), false, 'the reclaimed lock is released on the way out, not leaked');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Like writeGateResult, but the failing file is a real, absolute path the caller controls. */
function writeGateResultForFile(sessionDir, absFilePath) {
  const gateDir = path.join(sessionDir, 'gate');
  fs.mkdirSync(gateDir, { recursive: true });
  const gateResultPath = path.join(gateDir, `gate_result_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(gateResultPath, JSON.stringify({
    status: 'red',
    elapsed_ms: 1234,
    failures: [{
      check: 'typecheck', file: absFilePath, line: 1, ruleOrCode: 'TS2345',
      message: 'Argument of type string is not assignable to parameter of type number',
      severity: 'error', occurrence_index: 0,
    }],
  }));
  return { gateDir, gateResultPath };
}

test('spawn-gate-remediator: a lock ACTUALLY SIGKILLed mid-hold is reclaimed and leaves no lockfile behind', async () => {
  const dir = tmpDir();
  try {
    const targetFile = path.join(dir, 'target.ts');
    fs.writeFileSync(targetFile, 'export const x: number = 1;\n');
    const { gateDir, gateResultPath } = writeGateResultForFile(dir, targetFile);
    const lock = path.join(gateDir, 'remediator.lockfile');
    const sentinelPath = path.join(dir, 'holding.sentinel');
    const remediatorUrl = pathToFileURL(path.resolve(__dirname, '../../bin/spawn-gate-remediator.js')).href;

    // A real child process: acquires the lock exactly like production, then — ONLY on the
    // failing-file read (which happens strictly AFTER lock acquisition, never on the
    // gate-result read) — blocks synchronously via Atomics.wait so the parent has a reliable
    // window to observe the lock held live and then SIGKILL the holder mid-critical-section.
    const src = `
      import(${JSON.stringify(remediatorUrl)}).then(({ spawnGateRemediatorMain }) => {
        const fs = require('node:fs');
        const [gateResultPath, sessionRoot, sentinelPath] = process.argv.slice(1);
        spawnGateRemediatorMain({
          argv: ['--gate-result', gateResultPath, '--session-root', sessionRoot, '--reason', 'strict'],
          readFileFn: (p, enc) => {
            const data = fs.readFileSync(p, enc);
            if (p !== gateResultPath) {
              fs.writeFileSync(sentinelPath, 'holding');
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
            }
            return data;
          },
          stdout: () => {},
          stderr: () => {},
        }).then((code) => process.exit(code));
      });
    `;
    const child = spawn(process.execPath, ['-e', src, gateResultPath, dir, sentinelPath], {
      stdio: 'ignore',
      timeout: 30_000,
    });

    try {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(sentinelPath)) {
        if (Date.now() > deadline) {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          assert.fail('child never reached the blocking read while holding the lock');
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      // The lock is genuinely held, live, by the child we are about to kill.
      assert.ok(fs.existsSync(lock), 'the lock must be on disk while the child holds it');
      assert.match(fs.readFileSync(lock, 'utf-8'), new RegExp(`(^|\\n)${child.pid}(\\n|$)`),
        'the held lock must carry the live child’s own pid');

      // The actual SIGKILL: any process.on('exit') the child registered NEVER runs.
      process.kill(child.pid, 'SIGKILL');
      await once(child, 'exit');

      // This is the ticket's premise, true in isolation: SIGKILL strands the lockfile.
      assert.ok(fs.existsSync(lock), 'SIGKILL must strand the lockfile — process.on(exit) cannot prevent this');

      // A later remediator reclaims on proof of death and performs real work.
      const { gateResultPath: gateResultPath2 } = writeGateResultForFile(dir, targetFile);
      const { code, out } = await runRemediator(dir, gateResultPath2);

      assert.equal(code, 0);
      assert.ok(out.some((l) => l.startsWith('BRIEF_PATH=')),
        'the SIGKILLed holder must be reclaimed and real remediation work performed');
      assert.equal(fs.existsSync(lock), false,
        'no leak: the lock left behind by the SIGKILLed process must be gone after reclaim');
    } finally {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('spawn-gate-remediator: a LIVE remediator holder is never stolen', async () => {
  const dir = tmpDir();
  try {
    const { gateDir, gateResultPath } = writeGateResult(dir);

    // The holder is this very process — demonstrably alive, so its pid can never read as dead.
    const lock = path.join(gateDir, 'remediator.lockfile');
    fs.writeFileSync(lock, String(process.pid));

    const { code, out } = await runRemediator(dir, gateResultPath);

    assert.equal(code, 0, 'deferring to a live remediator is still a clean exit');
    assert.ok(out.some(l => l.startsWith('LOCKOUT_PATH=')), 'a live holder must produce a lockout');
    assert.ok(!out.some(l => l.startsWith('BRIEF_PATH=')), 'a live holder must not be raced into a second brief');
    assert.equal(fs.readFileSync(lock, 'utf-8'), String(process.pid), 'the live holder’s lock must survive');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('spawn-gate-remediator: the lock it publishes carries a bare pid, so a later strand is reclaimable', async () => {
  const dir = tmpDir();
  try {
    const { gateDir, gateResultPath } = writeGateResult(dir);
    const lock = path.join(gateDir, 'remediator.lockfile');

    // Observe the payload while the lock is held: readFile runs mid-run, before the release.
    let payloadWhileHeld = null;
    await spawnGateRemediatorMain({
      argv: ['--gate-result', gateResultPath, '--session-root', dir, '--reason', 'strict'],
      isoOverride: '2026-04-30T12-00-00Z',
      extensionClaudeMdContent: '## Trap Doors\n\n_none_\n',
      readFileFn: (p, enc) => {
        // `loadGateResult` also runs through this seam, BEFORE the lock is taken — capture only
        // once the lockfile actually exists, or we would sample the pre-acquire absence.
        if (payloadWhileHeld === null && fs.existsSync(lock)) {
          payloadWhileHeld = fs.readFileSync(lock, 'utf-8');
        }
        return fs.readFileSync(p, enc);
      },
      stdout: () => {},
      stderr: () => {},
    });

    // The pre-fix create-then-close published an EMPTY payload; isDeadPidPayload('') is NaN → never
    // dead → a steal bolted onto it would silently never fire. The payload IS the reclaimability.
    assert.ok(payloadWhileHeld !== null, 'the lock must have been observed while held');
    assert.match(payloadWhileHeld, new RegExp(`(^|\\n)${process.pid}(\\n|$)`),
      'the held lock must carry this process’s bare pid, the encoding isDeadPidPayload reads');
    assert.equal(isDeadPidPayload(String(process.pid)), false, 'a live bare pid must read as not-dead');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- the primitive: the lock and its payload are published together ---------------------------

/** Spins in its own process recording whether `lock` is ever on disk holding fewer than `full` bytes. */
function spawnPublishObserver(lock, full, readyPath) {
  const src = `
    const fs = require('node:fs');
    const [lock, full, ready] = [process.argv[1], Number(process.argv[2]), process.argv[3]];
    fs.writeFileSync(ready, '1');
    let sawIncomplete = false, sawComplete = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !sawComplete) {
      try {
        if (fs.statSync(lock).size < full) sawIncomplete = true; else sawComplete = true;
      } catch { /* not published yet */ }
    }
    process.stdout.write(JSON.stringify({ sawIncomplete, sawComplete }));
  `;
  return spawn(process.execPath, ['-e', src, lock, String(full), readyPath], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

async function waitForFile(p, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(p)) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return false;
}

test('acquireLockFile publishes the lock and its payload in one step — never the lock alone', async () => {
  const dir = tmpDir();
  try {
    const lock = path.join(dir, 'gate.lock');
    const ready = path.join(dir, 'observer-ready');

    // A holder killed between "create the lock file" and "write the holder pid" publishes an EMPTY
    // payload, and the next test proves that strand can never be reclaimed. For a real pid the window
    // is microseconds wide, so widen it with a payload big enough to watch — the invariant it proves
    // (the lock is never on disk without the pid that holds it) does not depend on payload size.
    const payload = 'x'.repeat(32 * 1024 * 1024);
    const observer = spawnPublishObserver(lock, payload.length, ready);
    assert.ok(await waitForFile(ready), 'observer must be watching before the lock is taken');

    assert.ok(acquireLockFile(lock, payload), 'acquire must succeed on an unheld lock');

    let out = '';
    observer.stdout.on('data', chunk => { out += chunk; });
    await once(observer, 'close');
    const seen = JSON.parse(out);

    assert.equal(seen.sawComplete, true, 'observer must have seen the published lock at all');
    assert.equal(seen.sawIncomplete, false,
      'the lock must never be observable without its payload — that state is an unreclaimable strand');

    // Read the bytes directly: this payload is deliberately far larger than inspectLockFile's
    // read cap (the size is what widens the publish window this test watches).
    const rawOnDisk = fs.readFileSync(lock, 'utf-8');
    assert.ok(rawOnDisk.startsWith('#pk:'), 'the acquisition must carry a nonce — the bytes ARE the identity');
    assert.equal(rawOnDisk.slice(rawOnDisk.indexOf('\n') + 1), payload, 'the published payload must be intact');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['gate.lock', 'observer-ready'],
      'the staging file used to publish atomically must not be left behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock published without its payload is never reclaimed — the strand the atomic publish prevents', async () => {
  const key = gateKey('empty-payload');
  const lp = gateLockPath(key);
  try {
    // Exactly what a holder killed mid-publish used to leave behind: the lock exists, the pid never landed.
    fs.writeFileSync(lp, '');

    // The reclaim rule refuses it, and MUST: a LIVE holder is empty in that same window, so a steal
    // keyed on an empty payload would evict one. The publish is what has to change, not the reclaim.
    assert.equal(isDeadPidPayload(''), false, 'an empty payload is not proof of death');

    await assert.rejects(
      withLock(key, { timeout_ms: 600, retry_interval_ms: 50 }, async () => 'unreachable'),
      err => err instanceof LockError,
      'an empty-payload lock wedges every later gate for this key — the gate lock has no age arm to fall back on',
    );
  } finally {
    removeGateLock(lp);
  }
});

/**
 * AP-EXT-ITER33-01 — a pid we may not SIGNAL is not a pid we may PROVE dead.
 *
 * `process.kill(pid, 0)` fails two ways and they are opposite facts: ESRCH means the process is
 * gone, EPERM means it is RIGHT THERE under another euid. The probe collapsed both into `false`,
 * so `isDeadPidPayload` reported a LIVE holder dead and the steal evicted its lock — two writers
 * in the critical section, which is the exact catastrophe this file exists to prevent.
 *
 * The assertion is the STEAL VERDICT plus the lockfile on disk, not the probe's return value: a
 * boolean oracle greens the moment someone re-widens the errno and re-narrows the caller.
 */
test('a lock whose holder answers EPERM is never stolen — unsignalable is not dead', () => {
  const dir = tmpDir();
  const lp = path.join(dir, 'state.json.lock');
  try {
    const holderPid = 424242;
    const throwErrno = (code) => () => {
      const err = new Error(`kill ${code}`);
      err.code = code;
      throw err;
    };

    assert.ok(acquireLockFile(lp, String(holderPid)), 'fixture: the holder must publish its lock');

    // Production shape at every steal site: judge the payload, then steal only on a dead verdict.
    const epermSnapshot = inspectLockFile(lp);
    assert.equal(isDeadPidPayload(epermSnapshot.payload, throwErrno('EPERM')), false,
      'EPERM says the holder EXISTS and is not ours to signal — that is not proof of death');
    if (isDeadPidPayload(epermSnapshot.payload, throwErrno('EPERM'))) stealLockFile(lp, epermSnapshot);
    assert.equal(fs.existsSync(lp), true, 'the live holder’s lock must survive the reclaim sweep');

    // Not vacuous: the same code path DOES evict a holder that is provably gone.
    const esrchSnapshot = inspectLockFile(lp);
    assert.equal(isDeadPidPayload(esrchSnapshot.payload, throwErrno('ESRCH')), true,
      'ESRCH is positive proof of death — the steal must still fire on it');
    assert.equal(stealLockFile(lp, esrchSnapshot), true, 'a dead holder’s lock is reclaimable');
    assert.equal(fs.existsSync(lp), false, 'the dead holder’s lock must be gone');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pid 1 is alive: the real kernel answer, whichever way this test runs as', () => {
  // Non-root: kill(1, 0) throws EPERM. Root: it succeeds. Both mean ALIVE, so this arm cannot
  // pass as root over a broken probe the way a uid-dependent fixture would.
  assert.equal(isProcessAlive(1), true, 'init/launchd is running — an unsignalable pid is not a dead one');
  assert.equal(isProcessAlive(0), true, 'pid 0 addresses our own process group — never proof of death');
  assert.equal(isProcessAlive(-1), true, 'a negative pid addresses a group — never proof of death');
});

/**
 * AP-EXT-ITER109-01 — the probe names the ONE errno that proves death, not the ones that do not.
 *
 * AP-EXT-ITER33-01 fixed the EPERM collapse by enumerating the survivor (`code === 'EPERM'` reads
 * alive, everything else reads dead). That is the incomplete-set shape, and the next member had
 * already shipped: Node rejects a pid above 2^31-1 with `ERR_INVALID_ARG_TYPE` BEFORE the syscall
 * runs, so a lock payload carrying one read as PROVABLY DEAD and the steal evicted a holder nobody
 * had accounted for — the same two-writers catastrophe, through a different errno. Every reader on
 * the path to the probe bounds a pid at "positive integer" and nothing tighter (`isDeadPidPayload`,
 * `isStaleLockSnapshot`, `state.pid`), so the value reaches it straight off disk.
 *
 * Driven through the REAL `process.kill`, never an injected errno: an injected-errno oracle is
 * precisely what the pre-fix predicate already satisfied.
 */
test('a lock payload whose pid is out of kill(2) range is never stolen — unaccountable is not dead', async () => {
  const OUT_OF_RANGE_PID = 2_147_483_648; // 2^31 — one past the largest pid process.kill accepts

  // Precondition: this pid really does fail outside the ESRCH/EPERM pair. Without proving that
  // first, the case below pins nothing — it would pass over a probe that never saw a third class.
  let thrownCode = null;
  try { process.kill(OUT_OF_RANGE_PID, 0); } catch (err) { thrownCode = err.code; }
  assert.ok(thrownCode && thrownCode !== 'ESRCH' && thrownCode !== 'EPERM',
    `fixture: kill(${OUT_OF_RANGE_PID}, 0) must fail outside the ESRCH/EPERM pair, got ${thrownCode}`);

  const dir = tmpDir();
  const lp = path.join(dir, 'state.json.lock');
  const deadLp = path.join(dir, 'dead-holder.lock');
  try {
    assert.ok(acquireLockFile(lp, String(OUT_OF_RANGE_PID)), 'fixture: the holder must publish its lock');

    // Production shape at every steal site: judge the payload, then steal only on a dead verdict.
    const snapshot = inspectLockFile(lp);
    assert.equal(isDeadPidPayload(snapshot.payload), false,
      'a pid kill(2) never even examined is not a pid we proved dead');
    if (isDeadPidPayload(snapshot.payload)) stealLockFile(lp, snapshot);
    assert.equal(fs.existsSync(lp), true, 'the unaccountable holder’s lock must survive the reclaim sweep');

    // Not vacuous: the same call path still evicts a holder that is provably gone.
    assert.ok(acquireLockFile(deadLp, String(await deadPid())), 'fixture: the dead holder must publish its lock');
    const deadSnapshot = inspectLockFile(deadLp);
    assert.equal(isDeadPidPayload(deadSnapshot.payload), true,
      'ESRCH is still positive proof of death — the steal must fire on it');
    assert.equal(stealLockFile(deadLp, deadSnapshot), true, 'a dead holder’s lock is reclaimable');
    assert.equal(fs.existsSync(deadLp), false, 'the dead holder’s lock must be gone');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an out-of-range pid and a non-Error throw both defer to LIVE at the probe', () => {
  assert.equal(isProcessAlive(2_147_483_648), true,
    'kill(2) rejected the argument before it ran — that is no evidence about the process');
  assert.equal(isProcessAlive(424242, () => { throw 'not an Error'; }), true,
    'a throw carrying no errno at all is the least accountable answer there is');
});

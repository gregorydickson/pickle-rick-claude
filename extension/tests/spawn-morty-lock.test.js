// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  acquireWorkerSpawnLock,
  releaseWorkerSpawnLock,
  workerSpawnLockPath,
  WorkerSpawnLockContendedError,
} from '../bin/spawn-morty.js';
import { acquireLockFile, releaseLockFile, inspectLockFile } from '../services/state-manager.js';
import { CAP_SPAWN_MORTY_DEFAULT_BUDGET } from './__helpers__/subprocess-cap.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPAWN_MORTY_BIN = path.resolve(__dirname, '../bin/spawn-morty.js');
const SPAWN_MORTY_SOURCE = fs.readFileSync(path.resolve(__dirname, '../bin/spawn-morty.js'), 'utf-8');
const SPAWN_REFINEMENT_SOURCE = fs.readFileSync(path.resolve(__dirname, '../bin/spawn-refinement-team.js'), 'utf-8');
const MICROVERSE_RUNNER_SOURCE = fs.readFileSync(path.resolve(__dirname, '../bin/microverse-runner.js'), 'utf-8');

function writeExtensionSentinel(extensionDir) {
  const sentinelDir = path.join(extensionDir, 'extension', 'bin');
  fs.mkdirSync(sentinelDir, { recursive: true });
  fs.writeFileSync(path.join(sentinelDir, 'log-watcher.js'), '');
}

function writeNoopCodexShim(shimDir, logPath) {
  fs.mkdirSync(shimDir, { recursive: true });
  const shimPath = path.join(shimDir, 'codex');
  fs.writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(logPath)}, 'codex shim ran — the lock should have prevented this');
process.exit(0);
`);
  fs.chmodSync(shimPath, 0o755);
  return shimPath;
}

function mkSessionRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-worker-lock-')));
}

// --- AC-1: reuse, not hand-roll -------------------------------------------------

test('AC-1: spawn-morty.js contains no O_EXCL and no exit/SIGTERM lock-release handler', () => {
  assert.equal((SPAWN_MORTY_SOURCE.match(/O_EXCL/g) ?? []).length, 0);
  assert.doesNotMatch(SPAWN_MORTY_SOURCE, /process\.on\(['"]exit['"]/);
  assert.doesNotMatch(SPAWN_MORTY_SOURCE, /process\.on\(['"]SIGTERM['"]/);
  assert.match(SPAWN_MORTY_SOURCE, /acquireLockFile/);
  assert.match(SPAWN_MORTY_SOURCE, /releaseLockFile/);
});

// --- AC-2 / AC-8: reclaimable payload, no age arm, happy path doesn't steal -----

test('AC-2/AC-8: a lock held by a LIVE pid is never stolen; the happy path acquires without a steal', async () => {
  const sessionRoot = mkSessionRoot();
  try {
    const first = await acquireWorkerSpawnLock(sessionRoot);
    assert.equal(first.inert, false);

    // Second acquisition against the same live-held lock must time out, not steal.
    await assert.rejects(
      () => acquireWorkerSpawnLock(sessionRoot, 200),
      (err) => {
        assert.ok(err instanceof WorkerSpawnLockContendedError);
        assert.equal(err.incumbentPid, String(process.pid));
        return true;
      },
    );

    releaseWorkerSpawnLock(first);

    // Happy path: after a clean release, the next acquire succeeds via the plain
    // acquireLockFile path — assert no `.steal` sub-lock artifact was ever created.
    const stealRightsPath = `${workerSpawnLockPath(sessionRoot)}.steal`;
    assert.equal(fs.existsSync(stealRightsPath), false);
    const second = await acquireWorkerSpawnLock(sessionRoot);
    assert.equal(second.inert, false);
    assert.equal(fs.existsSync(stealRightsPath), false);
    releaseWorkerSpawnLock(second);
  } finally {
    fs.rmSync(sessionRoot, { recursive: true, force: true });
  }
});

// --- AC-4: a SIGKILLed holder is reclaimed, not stranded ------------------------

test('AC-4: a lock held by a dead pid is reclaimed by the next acquire', async () => {
  const sessionRoot = mkSessionRoot();
  try {
    const lockPath = workerSpawnLockPath(sessionRoot);
    // Simulate a strand: publish a lock naming a pid that is provably dead.
    // A freshly-allocated high pid with no live process is a reasonable dead-pid
    // stand-in on every platform this suite runs on.
    const deadPid = 999_999_999;
    const staleHandle = acquireLockFile(lockPath, String(deadPid));
    assert.ok(staleHandle !== null, 'precondition: lock file did not already exist');

    const before = inspectLockFile(lockPath);
    assert.equal(before?.payload, String(deadPid));

    const reclaimed = await acquireWorkerSpawnLock(sessionRoot);
    assert.equal(reclaimed.inert, false);

    // Reclaim proof: the lock now carries THIS process's pid, not the dead one.
    const after = inspectLockFile(lockPath);
    assert.equal(after?.payload, String(process.pid));
    assert.notEqual(after?.raw, before?.raw);

    releaseWorkerSpawnLock(reclaimed);
  } finally {
    fs.rmSync(sessionRoot, { recursive: true, force: true });
  }
});

// --- AC-9: release contract ------------------------------------------------------

test('AC-9: releaseWorkerSpawnLock removes the lock file only for the acquisition that holds it', async () => {
  const sessionRoot = mkSessionRoot();
  try {
    const lockPath = workerSpawnLockPath(sessionRoot);
    const acquisition = await acquireWorkerSpawnLock(sessionRoot);
    assert.equal(fs.existsSync(lockPath), true);
    releaseWorkerSpawnLock(acquisition);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(sessionRoot, { recursive: true, force: true });
  }
});

// --- AC-12: kill-switch ----------------------------------------------------------

test('AC-12: PICKLE_WORKER_LOCK=off makes the lock inert — no file, no contention', async () => {
  const sessionRoot = mkSessionRoot();
  const priorEnv = process.env.PICKLE_WORKER_LOCK;
  process.env.PICKLE_WORKER_LOCK = 'off';
  try {
    const first = await acquireWorkerSpawnLock(sessionRoot);
    const second = await acquireWorkerSpawnLock(sessionRoot);
    assert.equal(first.inert, true);
    assert.equal(second.inert, true);
    assert.equal(fs.existsSync(workerSpawnLockPath(sessionRoot)), false);
    releaseWorkerSpawnLock(first);
    releaseWorkerSpawnLock(second);
  } finally {
    if (priorEnv === undefined) delete process.env.PICKLE_WORKER_LOCK;
    else process.env.PICKLE_WORKER_LOCK = priorEnv;
    fs.rmSync(sessionRoot, { recursive: true, force: true });
  }
});

test('AC-12: any other value keeps the lock active', async () => {
  const sessionRoot = mkSessionRoot();
  const priorEnv = process.env.PICKLE_WORKER_LOCK;
  process.env.PICKLE_WORKER_LOCK = '1';
  try {
    const first = await acquireWorkerSpawnLock(sessionRoot);
    assert.equal(first.inert, false);
    assert.equal(fs.existsSync(workerSpawnLockPath(sessionRoot)), true);
    releaseWorkerSpawnLock(first);
  } finally {
    if (priorEnv === undefined) delete process.env.PICKLE_WORKER_LOCK;
    else process.env.PICKLE_WORKER_LOCK = priorEnv;
    fs.rmSync(sessionRoot, { recursive: true, force: true });
  }
});

// --- AC-13: exempt spawners (assert by absence, forward-regression guard) -------

test('AC-13: spawn-refinement-team.js and microverse-runner.js are not routed through this lock', () => {
  for (const name of ['workerSpawnLockPath', 'acquireWorkerSpawnLock', 'WORKER_SPAWN_LOCK_FILENAME']) {
    assert.doesNotMatch(SPAWN_REFINEMENT_SOURCE, new RegExp(name));
    assert.doesNotMatch(MICROVERSE_RUNNER_SOURCE, new RegExp(name));
  }
});

// --- AC-3 / AC-9 / AC-10: end-to-end contention through main() -----------------

test('AC-3/AC-9/AC-10: a real spawn contends on a pre-held lock — event, sentinel, exit code, no ticket write', () => {
  const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-spawn-morty-lock-e2e-')));
  writeExtensionSentinel(tmpDir);
  const sessionDir = path.join(tmpDir, 'session');
  const ticketId = 'lockcontend01';
  const ticketDir = path.join(sessionDir, ticketId);
  const workspaceDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    active: true,
    backend: 'codex',
    iteration: 1,
    schema_version: 1,
    working_dir: workspaceDir,
  }));
  const ticketPath = path.join(ticketDir, `rick_ticket_${ticketId}.md`);
  fs.writeFileSync(ticketPath, [
    '---',
    `id: ${ticketId}`,
    'title: fixture ticket',
    'status: "In Progress"',
    'complexity_tier: medium',
    '---',
    '# Description',
    'fixture',
    '',
  ].join('\n'));

  const shimDir = path.join(tmpDir, 'bin');
  const shimLog = path.join(tmpDir, 'codex-invocation.json');
  writeNoopCodexShim(shimDir, shimLog);

  // Pre-seed the lock as held by THIS live test process, before spawn-morty runs.
  const lockPath = path.join(sessionDir, 'worker-spawn.lock');
  const incumbentHandle = acquireLockFile(lockPath, String(process.pid));
  assert.ok(incumbentHandle !== null, 'precondition: lock file did not already exist');

  try {
    const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
      'implement the thing',
      '--ticket-id', ticketId,
      '--ticket-path', ticketDir,
      '--timeout', '30',
    ], {
      env: {
        ...process.env,
        EXTENSION_DIR: tmpDir,
        PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
        PICKLE_BACKEND: '',
      },
      encoding: 'utf-8',
      timeout: CAP_SPAWN_MORTY_DEFAULT_BUDGET,
    });

    // Distinct non-zero exit code, not the existing exit(1) paths in this file.
    assert.equal(result.status, 2);
    assert.match(result.stdout, new RegExp(`WORKER_SPAWN_CONTENDED: ${process.pid} ${ticketId}`));

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const activity = Array.isArray(state.activity) ? state.activity : [];
    const event = activity.find((entry) => entry?.event === 'worker_spawn_lock_contended');
    assert.ok(event, 'expected worker_spawn_lock_contended activity event');
    assert.equal(event.ticket_id, ticketId);
    assert.equal(event.incumbent_pid, String(process.pid));
    assert.ok(typeof event.waited_ms === 'number' && event.waited_ms >= 0);

    // No ticket frontmatter write, no state step/current_ticket flip.
    const ticketContent = fs.readFileSync(ticketPath, 'utf-8');
    assert.match(ticketContent, /status: "In Progress"/);
    assert.equal(state.step, undefined);
    assert.equal(state.current_ticket, undefined);

    // The codex shim never ran — contention short-circuited before the spawn.
    assert.equal(fs.existsSync(shimLog), false);
  } finally {
    releaseLockFile(lockPath, incumbentHandle);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

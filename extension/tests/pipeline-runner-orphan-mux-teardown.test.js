// @tier: fast
// R-OMTD: killing pipeline-runner must reap its mux-runner child subtree — no
// orphan grandchild re-parents to PID 1. This is a real-fork test: it spawns a
// harness that replicates the production teardown (spawn the "mux-runner" child
// `detached:true`, then on SIGTERM reap the whole group via process.kill(-pid)),
// the mux child forks a long-lived grandchild that INHERITS the group, then we
// SIGTERM the harness and assert the grandchild dies within N seconds.
//
// detached:true ALONE is insufficient with inherited stdio — without the
// negative-PID group reap the grandchild survives and re-parents to PID 1. The
// "control" scenario (direct child.kill() only) proves that orphan persists, so
// the test fails if the group reap is ever removed.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Per-file accumulator for afterEach subprocess reaping.
// Entries: { pid: number, groupKill: boolean }
// groupKill=true → process.kill(-pid, signal) to reap the whole process group
//   (used for mux which spawns with detached:true and leads its own group).
const _spawnedForTeardown = [];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-omtd-'));
}

// Grandchild: writes its pid, then sleeps long. It must be reaped by the
// group SIGTERM, not by its own logic.
function grandchildSource(pidFile) {
  return `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
// Ignore SIGTERM if NOT delivered to the group — only a group signal reaches us.
setInterval(() => {}, 1000);
`;
}

// "mux-runner" child: forks the grandchild (inheriting its own group), records
// its own pid, then idles. Inherited stdio matches the production spawn.
function muxSource(grandchildScript, muxPidFile, grandchildPidFile) {
  return `
const { spawn } = require('child_process');
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(muxPidFile)}, String(process.pid));
// Grandchild inherits this process's group (detached:false) — exactly the
// case where a single child.kill() on the harness's direct child misses it.
spawn(process.execPath, [${JSON.stringify(grandchildScript)}], { stdio: 'inherit', detached: false });
setInterval(() => {}, 1000);
`;
}

// Harness = stand-in for pipeline-runner. `mode` selects the teardown:
//   'group'  -> reap the subtree via process.kill(-child.pid) (R-OMTD fix)
//   'direct' -> legacy child.kill() only (control; orphan must survive)
function harnessSource(muxScript, mode) {
  return `
const { spawn } = require('child_process');
const child = spawn(process.execPath, [${JSON.stringify(muxScript)}], {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true, // own process group
});
process.on('SIGTERM', () => {
  if (${JSON.stringify(mode)} === 'group' && typeof child.pid === 'number') {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  } else {
    try { child.kill('SIGTERM'); } catch {}
  }
  process.exit(0);
});
setInterval(() => {}, 1000);
`;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

function readPid(file) {
  try {
    const raw = fs.readFileSync(file, 'utf-8').trim();
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function runScenario(mode) {
  const dir = tmpDir();
  const grandchildPidFile = path.join(dir, 'grandchild.pid');
  const muxPidFile = path.join(dir, 'mux.pid');
  const grandchildScript = path.join(dir, 'grandchild.js');
  const muxScript = path.join(dir, 'mux.js');
  const harnessScript = path.join(dir, 'harness.js');

  fs.writeFileSync(grandchildScript, grandchildSource(grandchildPidFile));
  fs.writeFileSync(muxScript, muxSource(grandchildScript, muxPidFile, grandchildPidFile));
  fs.writeFileSync(harnessScript, harnessSource(muxScript, mode));

  const harness = spawn(process.execPath, [harnessScript], { stdio: 'ignore' });
  if (typeof harness.pid === 'number') {
    _spawnedForTeardown.push({ pid: harness.pid, groupKill: false });
  }

  try {
    // Wait for the whole tree to come up.
    const up = await waitFor(() => readPid(grandchildPidFile) !== null, 8000);
    assert.ok(up, 'grandchild should have started and recorded its pid');
    const grandchildPid = readPid(grandchildPidFile);
    assert.ok(isAlive(grandchildPid), 'grandchild should be alive before teardown');

    // Tear down the harness (== SIGTERM to pipeline-runner).
    harness.kill('SIGTERM');

    const grandchildDied = await waitFor(() => !isAlive(grandchildPid), 6000);
    return { grandchildPid, grandchildDied };
  } finally {
    // Cleanup: never leave a real orphan from the test itself.
    const gp = readPid(grandchildPidFile);
    if (gp && isAlive(gp)) { try { process.kill(gp, 'SIGKILL'); } catch {} }
    const mp = readPid(muxPidFile);
    if (mp && isAlive(mp)) { try { process.kill(mp, 'SIGKILL'); } catch {} }
    // Track mux pid for group reap in afterEach (catches orphaned grandchildren in
    // the mux's process group that survived the direct-pid kill above).
    if (mp !== null) _spawnedForTeardown.push({ pid: mp, groupKill: true });
    try { harness.kill('SIGKILL'); } catch {}
  }
}

describe('R-OMTD: orphan-mux teardown', () => {
  afterEach(() => {
    const entries = _spawnedForTeardown.splice(0);
    for (const { pid, groupKill } of entries) {
      try { process.kill(groupKill ? -pid : pid, 'SIGKILL'); } catch {}
    }
  });

  test('group reap kills the mux grandchild subtree within N seconds', async () => {
    const { grandchildDied } = await runScenario('group');
    assert.equal(grandchildDied, true, 'grandchild must be reaped by the process-group SIGTERM (no PPID-1 orphan)');
  });

  test('control: direct child.kill alone leaves the grandchild orphaned', async () => {
    const { grandchildPid, grandchildDied } = await runScenario('direct');
    // Proves the negative-PID group reap is load-bearing: without it the
    // grandchild survives. (Kill it so the assertion below is the only failure.)
    if (!grandchildDied && isAlive(grandchildPid)) {
      try { process.kill(grandchildPid, 'SIGKILL'); } catch {}
    }
    assert.equal(grandchildDied, false, 'direct child.kill must NOT reach the grandchild — group reap is required');
  });
});

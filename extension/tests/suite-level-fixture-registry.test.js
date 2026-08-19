// @tier: integration
/**
 * Suite-level registry teardown that survives abnormal runner death.
 *
 * AC1: spawn fixture cohort, then simulate the next suite's startup sweep
 * (`reapPreviousRunFixtures`) reaping them from a registry left on disk.
 * AC2: `reapFixturesSync` (the primitive `process.on('exit')` calls) kills a
 * live fixture synchronously.
 *
 * Fixtures are DOUBLE-FORKED via a throwaway launcher (same shape as the
 * sibling `integration/orphan-worker-reaper-real-proc.test.js`): the launcher
 * spawns the real fixture detached (own session, so `pgid === pid`) then
 * exits immediately, reparenting the fixture to init. A DIRECT child of this
 * test process would sit as a ZOMBIE once killed until this process's event
 * loop reaped SIGCHLD — and the reap primitives block synchronously
 * (`Atomics.wait` grace loop), so that reap never happens in-window;
 * `process.kill(pid, 0)`/`ps -p` both report a zombie as still alive. A
 * grandchild is reaped by init, independent of this process's event loop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import {
  initFixturePidRegistry,
  recordFixturePid,
  reapFixtures,
  reapFixturesSync,
  reapPreviousRunFixtures,
} from '../services/orphan-reaper.js';

function makeTmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

/** Throwaway launcher: spawns the real fixture detached, then exits immediately. */
const LAUNCHER_SCRIPT = [
  "const { spawn } = require('node:child_process');",
  "const fs = require('node:fs');",
  'const child = spawn(process.argv[1], ["-e", process.argv[2]], { detached: true, stdio: "ignore" });',
  'fs.writeFileSync(process.argv[3], String(child.pid));',
  'child.unref();',
  'process.exit(0);',
].join('\n');

function fixtureScript(registryPath, duration) {
  // Sleeps (or exits after `duration`ms) and records its own PID nowhere —
  // the launcher's pidfile is the source of truth so the parent never races
  // reading the fixture's own registry write.
  return `
const duration = ${duration};
if (duration) {
  setTimeout(() => process.exit(0), duration);
} else {
  setInterval(() => {}, 1000);
}
`;
}

/** Double-fork a detached sleeper fixture; returns its real pid via a pidfile handoff. */
function spawnFixture(binDir, name, duration) {
  const pidFile = path.join(binDir, `${name}.pid`);
  const launcher = spawn(process.execPath, ['-e', LAUNCHER_SCRIPT, process.execPath, fixtureScript(null, duration), pidFile], {
    detached: true,
    stdio: 'ignore',
    timeout: 10_000,
  });
  launcher.unref();
  return pidFile;
}

async function resolvePid(pidFile) {
  await waitFor(() => fs.existsSync(pidFile), 10_000, `pidfile ${pidFile} written`);
  return Number(fs.readFileSync(pidFile, 'utf-8').trim());
}

test('AC1: spawn fixture cohort, verify startup sweep reaps them from a registry on disk', async () => {
  const registryDir = makeTmp('suite-fixture-registry-ac1-');
  const binDir = makeTmp('suite-fixture-registry-ac1-bin-');
  const registryPath = initFixturePidRegistry(registryDir);

  const pidFile = spawnFixture(binDir, 'orphan', null);
  const fixturePid = await resolvePid(pidFile);
  recordFixturePid(registryPath, fixturePid);
  await waitFor(() => isAlive(fixturePid), 10_000, 'fixture alive after spawn');

  // Verify the fixture PID is in the registry.
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
  assert.ok(registry.pids.includes(fixturePid), 'fixture PID recorded in registry');

  // Simulate a runner crash: the registry is left on disk with a live PID.
  // The NEXT suite's startup sweep collects it.
  const reaped = reapPreviousRunFixtures(registryDir);
  assert.ok(reaped > 0, 'startup sweep reaped at least one fixture');
  await waitFor(() => !isAlive(fixturePid), 10_000, 'fixture collected by startup sweep');
});

test('AC2: reapFixturesSync (the process.on(exit) primitive) reaps a live fixture', async () => {
  const registryDir = makeTmp('suite-fixture-registry-ac2-');
  const binDir = makeTmp('suite-fixture-registry-ac2-bin-');
  const registryPath = initFixturePidRegistry(registryDir);

  const pidFile = spawnFixture(binDir, 'orphan', null);
  const fixturePid = await resolvePid(pidFile);
  recordFixturePid(registryPath, fixturePid);
  await waitFor(() => isAlive(fixturePid), 10_000, 'fixture alive after spawn');

  const reaped = reapFixturesSync(registryPath);
  assert.ok(reaped > 0, 'sync reap cleaned up fixtures');
  await waitFor(() => !isAlive(fixturePid), 10_000, 'fixture was synchronously reaped');
});

test('afterAll hook (reapFixtures) reaps fixtures asynchronously', async () => {
  const registryDir = makeTmp('suite-fixture-registry-async-');
  const binDir = makeTmp('suite-fixture-registry-async-bin-');
  const registryPath = initFixturePidRegistry(registryDir);

  const pidFile = spawnFixture(binDir, 'orphan', null);
  const fixturePid = await resolvePid(pidFile);
  recordFixturePid(registryPath, fixturePid);
  await waitFor(() => isAlive(fixturePid), 10_000, 'fixture alive after spawn');

  const reaped = await reapFixtures(registryPath);
  assert.equal(reaped, 1, 'one fixture was reaped');
  await waitFor(() => !isAlive(fixturePid), 10_000, 'fixture is gone');
});

test('startup sweep ignores stale registries (older than 24 hours)', async () => {
  const registryDir = makeTmp('suite-fixture-registry-stale-');
  const binDir = makeTmp('suite-fixture-registry-stale-bin-');
  const registryPath = initFixturePidRegistry(registryDir);

  const pidFile = spawnFixture(binDir, 'orphan', null);
  const fixturePid = await resolvePid(pidFile);
  recordFixturePid(registryPath, fixturePid);
  await waitFor(() => isAlive(fixturePid), 10_000, 'fixture alive after spawn');

  // Touch the registry file to make it appear old (25 hours).
  const oldMtime = Date.now() - (25 * 3600 * 1000);
  fs.utimesSync(registryPath, oldMtime / 1000, oldMtime / 1000);

  const reaped = reapPreviousRunFixtures(registryDir);
  assert.equal(reaped, 0, 'stale registry was ignored');
  assert.ok(isAlive(fixturePid), 'fixture still alive after stale-registry skip');

  try { process.kill(-fixturePid, 'SIGKILL'); } catch { /* already dead */ }
});

test('reapFixtures handles non-existent registries gracefully', async () => {
  const registryPath = path.join(makeTmp('suite-fixture-registry-missing-'), 'nonexistent.json');
  const reaped = await reapFixtures(registryPath);
  assert.equal(reaped, 0, 'no error on missing registry');
});

test('reapFixturesSync handles non-existent registries gracefully', () => {
  const registryPath = path.join(makeTmp('suite-fixture-registry-missing-sync-'), 'nonexistent.json');
  const reaped = reapFixturesSync(registryPath);
  assert.equal(reaped, 0, 'no error on missing registry');
});

test('recordFixturePid prevents duplicate PID entries', () => {
  const registryDir = makeTmp('suite-fixture-registry-dup-');
  const registryPath = initFixturePidRegistry(registryDir);

  const testPid = process.pid;
  recordFixturePid(registryPath, testPid);
  recordFixturePid(registryPath, testPid);
  recordFixturePid(registryPath, testPid);

  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
  const pidCount = registry.pids.filter(p => p === testPid).length;
  assert.equal(pidCount, 1, 'PID recorded only once despite multiple calls');
});

test('reapFixtures skips invalid PID entries', async () => {
  const registryDir = makeTmp('suite-fixture-registry-invalid-');
  const registryPath = initFixturePidRegistry(registryDir);

  // Write a registry with mixed valid and invalid PIDs (none of them alive
  // fixtures — the point is graceful handling, not a real reap).
  const registry = {
    started_at_epoch_ms: Date.now(),
    pids: [-1, 0, 1.5, 999999999],
  };
  fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf-8');

  const reaped = await reapFixtures(registryPath);
  assert.equal(reaped, 0, 'no valid live pid to reap, handled without error');
});

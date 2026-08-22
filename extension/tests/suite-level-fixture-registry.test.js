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

/** Double-fork `script` detached; returns the pidfile the launcher hands its real pid back through. */
function spawnDetachedFixture(binDir, name, script) {
  const pidFile = path.join(binDir, `${name}.pid`);
  const launcher = spawn(
    process.execPath,
    ['-e', LAUNCHER_SCRIPT, process.execPath, script, pidFile],
    { detached: true, stdio: 'ignore', timeout: 10_000 },
  );
  launcher.unref();
  return pidFile;
}

/** Double-fork a detached sleeper fixture; returns its real pid via a pidfile handoff. */
function spawnFixture(binDir, name, duration) {
  return spawnDetachedFixture(binDir, name, fixtureScript(null, duration));
}

/**
 * Group-leader fixture whose child OUTLIVES it: the leader exits on SIGTERM, the
 * child ignores SIGTERM and stays in the leader's process group. After the grace
 * period the leader PID is gone but `kill(-pid, ...)` still succeeds, which is the
 * exact shape that made the pre-fix escalation count one reap twice.
 */
const SURVIVING_GROUP_SCRIPT = [
  "const { spawn } = require('node:child_process');",
  // The child self-terminates after 30s so a leaked group member cannot outlive
  // the run even if the leader (and its spawn timeout) is already gone.
  "const childSrc = \"process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 30000);\";",
  "spawn(process.execPath, ['-e', childSrc], { stdio: 'ignore', timeout: 30000 });",
  "process.on('SIGTERM', () => process.exit(0));",
  'setInterval(() => {}, 1000);',
].join('\n');

/** Double-fork a detached group leader whose child survives the leader's own exit. */
function spawnSurvivingGroupFixture(binDir, name) {
  return spawnDetachedFixture(binDir, name, SURVIVING_GROUP_SCRIPT);
}

/**
 * Leader that IGNORES SIGTERM, so the grace window expires and the reaper must
 * escalate to a group SIGKILL — the one escalation arm the SIGTERM-obedient
 * fixtures above never reach. Self-terminates after 30s so a leaked leader
 * cannot outlive the run.
 */
const SIGTERM_DEAF_SCRIPT = [
  "process.on('SIGTERM', () => {});",
  'setTimeout(() => process.exit(0), 30000);',
  'setInterval(() => {}, 1000);',
].join('\n');

/** Double-fork a detached leader that only a SIGKILL can stop. */
function spawnSigtermDeafFixture(binDir, name) {
  return spawnDetachedFixture(binDir, name, SIGTERM_DEAF_SCRIPT);
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

test('AC2: reapFixturesSync counts one reap per PID when the group outlives its leader', async () => {
  const registryDir = makeTmp('suite-fixture-registry-ac2-group-');
  const binDir = makeTmp('suite-fixture-registry-ac2-group-bin-');
  const registryPath = initFixturePidRegistry(registryDir);

  const pidFile = spawnSurvivingGroupFixture(binDir, 'orphan');
  const leaderPid = await resolvePid(pidFile);
  recordFixturePid(registryPath, leaderPid);
  await waitFor(() => isAlive(leaderPid), 10_000, 'group leader alive after spawn');

  // The leader dies during the SIGTERM grace window, but its SIGTERM-ignoring
  // child keeps the process group alive, so the SIGKILL escalation still
  // succeeds. `reaped` must count the PID once — a delivered group signal is
  // not a confirmed death.
  const reaped = reapFixturesSync(registryPath);
  assert.equal(reaped, 1, 'one registered PID reaped exactly once');
  assert.ok(!isAlive(leaderPid), 'group leader is gone');

  try { process.kill(-leaderPid, 'SIGKILL'); } catch { /* group already gone */ }
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

test('afterAll hook (reapFixtures) escalates to SIGKILL when the leader ignores SIGTERM', async () => {
  const registryDir = makeTmp('suite-fixture-registry-async-deaf-');
  const binDir = makeTmp('suite-fixture-registry-async-deaf-bin-');
  const registryPath = initFixturePidRegistry(registryDir);

  const pidFile = spawnSigtermDeafFixture(binDir, 'orphan');
  const fixturePid = await resolvePid(pidFile);
  recordFixturePid(registryPath, fixturePid);
  await waitFor(() => isAlive(fixturePid), 10_000, 'SIGTERM-deaf fixture alive after spawn');

  // SIGTERM is swallowed, so the grace window expires and only the group SIGKILL
  // ends it. The count still reflects a CONFIRMED death, not a delivered signal.
  const reaped = await reapFixtures(registryPath);
  assert.equal(reaped, 1, 'one registered PID reaped exactly once after the SIGKILL escalation');
  assert.ok(!isAlive(fixturePid), 'SIGTERM-deaf fixture is gone');
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

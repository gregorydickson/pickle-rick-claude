// @tier: integration
/**
 * R-CXHANG AC-CXHANG-6 (+ AC-CXHANG-5 characterization) integration tests.
 *
 * (a) AC-6: a detached worker-shaped proc abandoned WITHOUT teardown (its
 *     session state.json says active:false) is collected on the NEXT setup-time
 *     reap via a REAL ps scan and REAL group kill — including the SIGKILL
 *     escalation path, because the fixture ignores SIGTERM (the codex
 *     network-blocked class).
 * (b) control: a sibling worker-shaped proc whose owning session is LIVE
 *     (active:true, pid = this test process) is NOT killed.
 * (c) AC-5 characterization: killProcessGroup SIGTERM→SIGKILL escalation kills
 *     a real SIGTERM-ignoring detached group within the grace window. Pins
 *     existing behavior — no product change.
 *
 * The worker shape is faked with a tmpdir symlink `claude` → the real node
 * binary running the SIGTERM-ignoring sleeper fixture, with worker-shaped argv
 * (--dangerously-skip-permissions + --add-dir <sessionsRoot>/<sess>/<ticket> + -p).
 *
 * Both fakes are DOUBLE-FORKED via a throwaway node launcher (same shape as the
 * AC-8 sibling `orphan-worker-reaper-tmp-prefix-drain.test.js`), so each one is
 * a grandchild that reparents to init while still leading its own process group
 * (`pgid === pid`, granted by the launcher's own `detached: true` spawn). A
 * DIRECT child of this test process would, once group-SIGKILLed, sit as a
 * ZOMBIE until this process's event loop reaped SIGCHLD — and the reap's verify
 * window is a blocking `Atomics.wait` (`orphan-reaper.ts` `sleepSync`), so that
 * never happens in-window. `process.kill(pid, 0)` reports a zombie as ALIVE, so
 * a real, landed kill was tallied `unverified` instead of `reaped`. A grandchild
 * is reaped by init, independent of this process's event loop.
 *
 * PARALLEL-SAFETY (AC-R2-3): the scan is a REAL `ps` invocation, but its output
 * is filtered to the pids this test itself planted before the reaper sees it.
 * An unfiltered machine-wide scan combined with `minAgeSeconds: 0` makes EVERY
 * process on the box a candidate, and the `tmp_fixture` class needs no owning
 * session at all — so a sibling test's non-detached subprocess carrying a
 * `pickle-*` tmpdir path in its argv becomes reapable, and the group SIGKILL
 * then lands on the test runner's OWN process group (siblings share the
 * runner's pgid), killing the whole tier. Filtering the candidate set to
 * planted pids keeps everything real — real ps columns, real etime/pgid/ppid,
 * real ownership attribution, real escalation, real liveness verify — while
 * making it structurally impossible for a kill to reach a pid this test did
 * not create. Same containment the AC-8 sibling gets from its `psOutput`
 * injection, without fabricating any ps column.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  killProcessGroup,
  reapOrphanedWorkerProcs,
  initFixturePidRegistry,
  recordFixturePid,
  reapFixtures,
  reapFixturesSync,
  reapPreviousRunFixtures,
} from '../../services/orphan-reaper.js';
import { LATEST_SCHEMA_VERSION } from '../../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, '../fixtures/sigterm-ignoring-sleeper.js');

process.env.PICKLE_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cxhang-int-data-'));

// Suite-level net (survives a SIGKILLed test runner): a prior crashed run of
// THIS file leaves its registry on disk at a stable path, so the sweep below
// collects it before any fixture in this run is planted. `process.on('exit')`
// covers a hard abort of this process; `after()` covers a normal/timed-out
// finish. Both fire in addition to each test's own `finally` SIGKILL, which
// only runs if this process survives to reach it.
const FIXTURE_REGISTRY_DIR = path.join(os.tmpdir(), 'pickle-orphan-reaper-registry-real-proc');
reapPreviousRunFixtures(FIXTURE_REGISTRY_DIR);
const FIXTURE_REGISTRY_PATH = initFixturePidRegistry(FIXTURE_REGISTRY_DIR);
process.on('exit', () => reapFixturesSync(FIXTURE_REGISTRY_PATH));
after(async () => { await reapFixtures(FIXTURE_REGISTRY_PATH); });

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

function makeSession(sessionsRoot, name, state) {
  const dir = path.join(sessionsRoot, name);
  fs.mkdirSync(path.join(dir, 'ticket1'), { recursive: true });
  if (state !== undefined) {
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
      schema_version: LATEST_SCHEMA_VERSION,
      activity: [],
      ...state,
    }));
  }
  return dir;
}

/**
 * Throwaway launcher: spawns the real fixture detached (own session, so
 * `pgid === pid`), records its pid, then exits immediately — leaving the
 * fixture a grandchild of the test process, reparented to init.
 * argv: [claudeLink, fixture, pidFile, ticketPath]
 */
const LAUNCHER_SCRIPT = [
  "const { spawn } = require('node:child_process');",
  "const fs = require('node:fs');",
  'const argv = [process.argv[2], "--dangerously-skip-permissions", "--add-dir", process.argv[4], "-p", "x"];',
  'const child = spawn(process.argv[1], argv, { detached: true, stdio: "ignore", env: process.env });',
  'fs.writeFileSync(process.argv[3], String(child.pid));',
  'child.unref();',
  'process.exit(0);',
].join('\n');

/** Double-fork a detached SIGTERM-ignoring sleeper disguised as a claude worker. */
function spawnFakeWorker(claudeLink, ticketPath, readyFile, pidFile) {
  const launcher = spawn(
    process.execPath,
    ['-e', LAUNCHER_SCRIPT, claudeLink, FIXTURE, pidFile, ticketPath],
    {
      detached: true,
      stdio: 'ignore',
      timeout: 10_000,
      env: { ...process.env, CXHANG_READY_FILE: readyFile },
    },
  );
  launcher.unref();
  return { readyFile, pidFile };
}

async function resolvePid(pidFile) {
  await waitFor(() => fs.existsSync(pidFile), 10_000, `pidfile ${pidFile} written`);
  const pid = Number(fs.readFileSync(pidFile, 'utf-8').trim());
  recordFixturePid(FIXTURE_REGISTRY_PATH, pid);
  return pid;
}

const PS_ARGS = ['-axo', 'pid=,pgid=,ppid=,etime=,command='];

/** Real `ps` output, no fabricated columns. */
function realPsOutput() {
  return execFileSync('ps', PS_ARGS, { encoding: 'utf-8', timeout: 5_000, maxBuffer: 8 * 1024 * 1024 });
}

/**
 * Injectable scanner that runs the REAL `ps` and then keeps only the lines
 * whose pid is one this test planted. Every candidate the reaper can reach —
 * and therefore every group it can signal — is one of `allowedPids`.
 */
function scanPlantedPidsOnly(allowedPids) {
  const allowed = new Set(allowedPids);
  return () => realPsOutput()
    .split(/\r?\n/)
    .filter(line => allowed.has(Number(line.trim().split(/\s+/)[0])))
    .join('\n');
}

/** Real pgid of a live pid, from `ps`; null when the pid is already gone. */
function pgidOf(pid) {
  for (const line of realPsOutput().split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (Number(cols[0]) === pid) return Number(cols[1]);
  }
  return null;
}

test('AC-CXHANG-6: abandoned detached worker is collected by the next reap; live-session control proc is spared', async () => {
  const sessionsRoot = makeTmp('cxhang-int-sess-');
  const binDir = makeTmp('cxhang-int-bin-');
  const claudeLink = path.join(binDir, 'claude');
  fs.symlinkSync(process.execPath, claudeLink);

  const deadSess = makeSession(sessionsRoot, 'sess-dead', { active: false });
  const liveSess = makeSession(sessionsRoot, 'sess-live', { active: true, pid: process.pid });
  const reaperSess = makeSession(sessionsRoot, 'sess-reaper', { active: true, pid: process.pid });
  const statePath = path.join(reaperSess, 'state.json');

  const orphanHandle = spawnFakeWorker(
    claudeLink,
    path.join(deadSess, 'ticket1'),
    path.join(binDir, 'orphan.ready'),
    path.join(binDir, 'orphan.pid'),
  );
  const controlHandle = spawnFakeWorker(
    claudeLink,
    path.join(liveSess, 'ticket1'),
    path.join(binDir, 'control.ready'),
    path.join(binDir, 'control.pid'),
  );

  let orphanPid;
  let controlPid;

  try {
    orphanPid = await resolvePid(orphanHandle.pidFile);
    controlPid = await resolvePid(controlHandle.pidFile);
    await waitFor(
      () => fs.existsSync(orphanHandle.readyFile) && fs.existsSync(controlHandle.readyFile),
      10_000,
      'both fake workers ready (SIGTERM handlers installed)',
    );
    // A fixture that never launched must not masquerade as a successful reap.
    assert.ok(isAlive(orphanPid), `planted orphan pid=${orphanPid} running before the reap`);
    assert.ok(isAlive(controlPid), `planted control pid=${controlPid} running before the reap`);

    // Every group the reaper can signal here is a group this test leads
    // (double-fork gives each fake `pgid === pid`), so no kill can reach the
    // test runner's own process group — the AC-R2-3 containment, asserted.
    assert.equal(pgidOf(orphanPid), orphanPid, 'planted orphan leads its own process group');
    assert.equal(pgidOf(controlPid), controlPid, 'planted control leads its own process group');

    // Abandon: no teardown ran for the orphan's session. Run the setup-time
    // reaper with REAL ps scan and REAL kill, min-age disabled for the test —
    // the scan is scoped to the two pids planted above (see PARALLEL-SAFETY).
    const result = reapOrphanedWorkerProcs({
      sessionsRoot,
      statePath,
      minAgeSeconds: 0,
      graceMs: 500,
      scan: scanPlantedPidsOnly([orphanPid, controlPid]),
    });

    assert.equal(result.scanned, 2, 'exactly the two planted fake workers were candidates');
    assert.equal(result.reaped, 1, 'exactly the dead-session orphan was reaped');
    assert.equal(result.unverified, 0, 'no reap attempt went unverified');

    // The SIGTERM-ignoring orphan died → the SIGKILL escalation fired (AC-5 in vivo).
    await waitFor(() => !isAlive(orphanPid), 10_000, 'orphan collected');

    // Positive-ownership trap door: the live session's worker is untouched.
    assert.ok(isAlive(controlPid), 'live-session control proc MUST NOT be killed');

    // worker_orphan_reaped event landed on the invoking session's state.
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const events = (state.activity ?? []).filter(e => e.event === 'worker_orphan_reaped');
    assert.ok(events.length >= 1, 'worker_orphan_reaped event emitted');
    assert.equal(events[0].owning_session, 'sess-dead');
  } finally {
    // Scoped to this test's own recorded pids — never a bare binary name.
    for (const pid of [orphanPid, controlPid]) {
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
});

test('AC-CXHANG-5 characterization: killProcessGroup escalation collects a real SIGTERM-ignoring group', async () => {
  const readyFile = path.join(makeTmp('cxhang-int-esc-'), 'sleeper.ready');
  const child = spawn(process.execPath, [FIXTURE], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CXHANG_READY_FILE: readyFile },
  });
  child.unref();
  recordFixturePid(FIXTURE_REGISTRY_PATH, child.pid);
  try {
    await waitFor(() => fs.existsSync(readyFile), 10_000, 'sleeper ready (SIGTERM handler installed)');

    // SIGTERM alone does NOT collect it (the codex network-blocked class).
    assert.equal(killProcessGroup(child.pid, 'SIGTERM'), true, 'group SIGTERM sent');
    await new Promise(r => setTimeout(r, 500));
    assert.ok(isAlive(child.pid), 'fixture ignores SIGTERM by design');

    // Escalation collects the group within the grace window.
    assert.equal(killProcessGroup(child.pid, 'SIGKILL'), true, 'group SIGKILL sent');
    await waitFor(() => !isAlive(child.pid), 5_000, 'sleeper collected by SIGKILL');
  } finally {
    if (typeof child.pid === 'number') {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
});

// @tier: integration
/**
 * WS-1/AC-8 (ticket 6a0dd3e4): end-to-end drain of the `tmp_fixture` class
 * (R-WGTORPH) with REAL spawned processes and REAL kill — no `kill`/`isAlive`
 * stubbing. Only `etime` is fabricated (via the `psOutput` injection point),
 * because waiting out the real 600s min-age floor is not viable in a test;
 * the pids, the group-kill signal delivery, and the post-run liveness census
 * are all real.
 *
 * Fixtures are double-forked via a throwaway node LAUNCHER process (detached,
 * exits immediately after spawning the real fixture also detached) so the
 * fixture grandchild both reparents to PID 1 (ppid=1, exactly like a real
 * abandoned worker) AND remains its own process-group leader (pgid===pid,
 * since `detached:true` on the launcher's OWN spawn call already gave it a
 * new session before the launcher exits). A shell `cmd & disown` background
 * job does NOT have this property — the backgrounded grandchild inherits the
 * shell's pgid, not its own, so a fabricated `pgid===pid` ps line would target
 * the wrong (already-dead) process group and the kill silently no-ops.
 * Likewise a DIRECT child of this test process would sit as a zombie once
 * killed until this process's (synchronous, blocking-sleep) event loop got
 * around to reaping it, which would falsely read as "still alive" through the
 * reap's own verify window; a grandchild is reaped by init, independent of
 * this process's event loop.
 *
 * Plants N=3 orphan-shaped fixtures (aged past the floor) plus one
 * live/under-age negative control of the identical argv shape, so the drain
 * is proven discriminating, not just destructive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reapOrphanedWorkerProcs } from '../../services/orphan-reaper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, '../fixtures/sigterm-ignoring-sleeper.js');
const ORPHAN_COUNT = 3;

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

/**
 * Double-forks a real orphan via a throwaway launcher: the launcher spawns
 * the real fixture detached (own session, pgid===pid) then exits immediately,
 * so the fixture reparents to PID 1 while keeping its own process group.
 */
const LAUNCHER_SCRIPT = [
  "const { spawn } = require('node:child_process');",
  "const fs = require('node:fs');",
  'const child = spawn(process.argv[1], [process.argv[2]], { detached: true, stdio: "ignore", env: process.env });',
  'fs.writeFileSync(process.argv[3], String(child.pid));',
  'child.unref();',
  'process.exit(0);',
].join('\n');

function spawnFixture(binDir, name) {
  const readyFile = path.join(binDir, `${name}.ready`);
  const pidFile = path.join(binDir, `${name}.pid`);
  const launcher = spawn(process.execPath, ['-e', LAUNCHER_SCRIPT, process.execPath, FIXTURE, pidFile], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CXHANG_READY_FILE: readyFile },
  });
  launcher.unref();
  return { readyFile, pidFile };
}

async function resolvePid(pidFile) {
  await waitFor(() => fs.existsSync(pidFile), 10_000, `pidfile ${pidFile} written`);
  return Number(fs.readFileSync(pidFile, 'utf-8').trim());
}

/** Fabricated `ps -axo pid=,pgid=,ppid=,etime=,command=` line for a real (grandchild, ppid=1) pid. */
function psLine(pid, etime, tmpToken) {
  // Double-forked orphans are their own session/group leader: pgid === pid.
  return `${pid} ${pid} 1 ${etime} ${process.execPath} ${FIXTURE} ${tmpToken}`;
}

test('AC-8: N planted tmp-prefix orphans are drained to zero; a same-shaped under-age control survives', async () => {
  const sessionsRoot = makeTmp('r-wgtorph-drain-sess-');
  const binDir = makeTmp('r-wgtorph-drain-bin-');

  const orphanHandles = [];
  for (let i = 0; i < ORPHAN_COUNT; i++) {
    orphanHandles.push(spawnFixture(binDir, `orphan${i}`));
  }
  const controlHandle = spawnFixture(binDir, 'control');

  const orphanPids = [];
  let controlPid;

  try {
    for (const handle of orphanHandles) {
      orphanPids.push(await resolvePid(handle.pidFile));
    }
    controlPid = await resolvePid(controlHandle.pidFile);
    await waitFor(
      () => [...orphanHandles.map(o => o.readyFile), controlHandle.readyFile].every(f => fs.existsSync(f)),
      10_000,
      'all planted fixtures ready (SIGTERM handlers installed)',
    );
    // Confirmed real orphans: reparented to init, not a child of this process.
    for (const pid of [...orphanPids, controlPid]) {
      assert.ok(isAlive(pid), `planted pid=${pid} running before the reap`);
    }

    const orphanLines = orphanPids.map((pid, i) => psLine(
      pid,
      '11:40', // 700s — past the 600s default min-age floor
      path.join(os.tmpdir(), `pickle-drain-fixture-${i}`, 'w'),
    ));
    const controlLine = psLine(
      controlPid,
      '00:05', // 5s — same argv shape, under-age: must survive
      path.join(os.tmpdir(), 'pickle-drain-fixture-control', 'w'),
    );
    const psOutput = [...orphanLines, controlLine].join('\n');

    const result = reapOrphanedWorkerProcs({
      sessionsRoot,
      psOutput,
      graceMs: 300,
      killVerifyMs: 3000,
    });

    assert.equal(result.scanned, ORPHAN_COUNT + 1, 'all 4 planted candidates matched the tmp_fixture pattern');
    assert.equal(result.reaped, ORPHAN_COUNT, 'exactly the N aged orphans were reaped');
    assert.equal(result.unverified, 0, 'no reap attempt went unverified');

    // Post-run census, independent of the returned tally: real liveness check
    // per planted pid, not trust in the counter alone.
    for (const pid of orphanPids) {
      await waitFor(() => !isAlive(pid), 10_000, `orphan pid=${pid} collected`);
    }
    const survivingOrphans = orphanPids.filter(isAlive).length;
    assert.equal(survivingOrphans, 0, 'post-run census: zero orphans surviving');
    assert.equal(result.reaped, ORPHAN_COUNT - survivingOrphans, 'returned reaped count matches count actually gone');

    // Negative control: same shape, under-age — the drain must be discriminating.
    assert.ok(isAlive(controlPid), 'live/under-age control of the same shape MUST survive the drain');
  } finally {
    for (const pid of [...orphanPids, controlPid].filter(Boolean)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
});

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
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killProcessGroup, reapOrphanedWorkerProcs } from '../../services/orphan-reaper.js';
import { LATEST_SCHEMA_VERSION } from '../../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, '../fixtures/sigterm-ignoring-sleeper.js');

process.env.PICKLE_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cxhang-int-data-'));

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

/** Spawn a detached SIGTERM-ignoring sleeper disguised as a claude worker. */
function spawnFakeWorker(claudeLink, ticketPath, readyFile) {
  const child = spawn(
    claudeLink,
    [FIXTURE, '--dangerously-skip-permissions', '--add-dir', ticketPath, '-p', 'x'],
    { detached: true, stdio: 'ignore', env: { ...process.env, CXHANG_READY_FILE: readyFile } },
  );
  child.unref();
  return child;
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

  const orphanReady = path.join(binDir, 'orphan.ready');
  const controlReady = path.join(binDir, 'control.ready');
  const orphan = spawnFakeWorker(claudeLink, path.join(deadSess, 'ticket1'), orphanReady);
  const control = spawnFakeWorker(claudeLink, path.join(liveSess, 'ticket1'), controlReady);

  try {
    await waitFor(
      () => fs.existsSync(orphanReady) && fs.existsSync(controlReady),
      10_000,
      'both fake workers ready (SIGTERM handlers installed)',
    );

    // Abandon: no teardown ran for the orphan's session. Run the setup-time
    // reaper with REAL ps scan and REAL kill, min-age disabled for the test.
    const result = reapOrphanedWorkerProcs({
      sessionsRoot,
      statePath,
      minAgeSeconds: 0,
      graceMs: 500,
    });

    assert.ok(result.scanned >= 2, `expected both fake workers scanned, got ${result.scanned}`);
    assert.ok(result.reaped >= 1, `expected the orphan reaped, got ${result.reaped}`);

    // The SIGTERM-ignoring orphan died → the SIGKILL escalation fired (AC-5 in vivo).
    await waitFor(() => !isAlive(orphan.pid), 10_000, 'orphan collected');

    // Positive-ownership trap door: the live session's worker is untouched.
    assert.ok(isAlive(control.pid), 'live-session control proc MUST NOT be killed');

    // worker_orphan_reaped event landed on the invoking session's state.
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const events = (state.activity ?? []).filter(e => e.event === 'worker_orphan_reaped');
    assert.ok(events.length >= 1, 'worker_orphan_reaped event emitted');
    assert.equal(events[0].owning_session, 'sess-dead');
  } finally {
    for (const child of [orphan, control]) {
      if (typeof child.pid === 'number') {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
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

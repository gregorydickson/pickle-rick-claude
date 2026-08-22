// @tier: fast
/**
 * WS-2 regression tests: bounded-escalation verify-by-pid for the orphan
 * reaper. AC-3: SIGTERM -> SIGKILL -> verify, reaped ONLY on confirmed death.
 * AC-3a: a SIGKILL-survivor is never counted as reaped. AC-3b: a 20-candidate
 * population never silently drops a candidate at the wall-budget deadline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { reapOrphanedWorkerProcs } from '../services/orphan-reaper.js';

function makeTmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wskv-test-')));
}

process.env.PICKLE_DATA_ROOT = makeTmp();

function makeSession(sessionsRoot, name, state) {
  const dir = path.join(sessionsRoot, name);
  fs.mkdirSync(path.join(dir, 'ticket1'), { recursive: true });
  if (state !== undefined) {
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
      schema_version: 5,
      activity: [],
      ...state,
    }));
  }
  return dir;
}

function codexLine(pid, pgid, etime, ticketPath) {
  return `${pid} ${pgid} 1 ${etime} /Users/x/.npm/codex-darwin-arm64/bin/codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral --ignore-rules --ignore-user-config --add-dir /Users/x/repo --add-dir ${ticketPath} -- do the thing`;
}

test('AC-3: escalates SIGTERM -> SIGKILL and counts reaped ONLY after verification confirms death', () => {
  const sessionsRoot = makeTmp();
  const deadSess = makeSession(sessionsRoot, 'sess-dead', { active: false });
  const reaperSess = makeSession(sessionsRoot, 'sess-reaper', { active: true, pid: process.pid });
  const statePath = path.join(reaperSess, 'state.json');

  const kills = [];
  // "SIGTERM-immune": isAlive stays true until SIGKILL has been sent, then false.
  let sigkillSent = false;
  const result = reapOrphanedWorkerProcs({
    sessionsRoot,
    statePath,
    psOutput: codexLine(9001, 9001, '20:00:00', path.join(deadSess, 'ticket1')),
    kill: (pgid, sig) => { kills.push([pgid, sig]); if (sig === 'SIGKILL') sigkillSent = true; return true; },
    isAlive: () => !sigkillSent,
    sleep: () => {},
  });

  assert.equal(result.reaped, 1, 'reaped only after SIGKILL-then-verify confirms death');
  assert.equal(result.unverified, 0);
  assert.deepEqual(kills, [[9001, 'SIGTERM'], [9001, 'SIGKILL']], 'escalation must actually fire SIGKILL, not just SIGTERM');

  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  const events = (state.activity ?? []).filter(e => e.event === 'worker_orphan_reaped');
  assert.equal(events.length, 1);
});

test('AC-3a: a candidate that survives SIGKILL is NOT counted as reaped, and is reported unverified', () => {
  const sessionsRoot = makeTmp();
  const deadSess = makeSession(sessionsRoot, 'sess-dead', { active: false });
  const reaperSess = makeSession(sessionsRoot, 'sess-reaper', { active: true, pid: process.pid });
  const statePath = path.join(reaperSess, 'state.json');

  const kills = [];
  const result = reapOrphanedWorkerProcs({
    sessionsRoot,
    statePath,
    psOutput: codexLine(9002, 9002, '20:00:00', path.join(deadSess, 'ticket1')),
    kill: (pgid, sig) => { kills.push([pgid, sig]); return true; },
    isAlive: () => true, // permanently immune — kill has no effect at all
    sleep: () => {},
    killVerifyMs: 50,
  });

  assert.equal(result.reaped, 0, 'a SIGKILL-survivor must never be counted as reaped');
  assert.equal(result.unverified, 1);
  assert.deepEqual(kills, [[9002, 'SIGTERM'], [9002, 'SIGKILL']]);

  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  const reapedEvents = (state.activity ?? []).filter(e => e.event === 'worker_orphan_reaped');
  const unverifiedEvents = (state.activity ?? []).filter(e => e.event === 'worker_orphan_reap_unverified');
  assert.equal(reapedEvents.length, 0, 'no false-positive reaped telemetry');
  assert.equal(unverifiedEvents.length, 1);
  assert.equal(unverifiedEvents[0].pid, 9002);
  assert.equal(unverifiedEvents[0].reason, 'survived_sigkill');
});

test('AC-3b: a 20-candidate population never silently drops a candidate at the wall-budget deadline', () => {
  const sessionsRoot = makeTmp();
  const deadSess = makeSession(sessionsRoot, 'sess-dead', { active: false });
  const reaperSess = makeSession(sessionsRoot, 'sess-reaper', { active: true, pid: process.pid });
  const statePath = path.join(reaperSess, 'state.json');

  const CANDIDATE_COUNT = 20;
  const psOutput = Array.from({ length: CANDIDATE_COUNT }, (_, i) => {
    const pid = 9100 + i;
    return codexLine(pid, pid, '20:00:00', path.join(deadSess, 'ticket1'));
  }).join('\n');

  // Each SIGTERM kill call blocks a few real ms (Atomics.wait), so real
  // wall-clock time passes across the 20 candidates without any test-level
  // real sleeps or timers; a small wallBudgetMs then trips partway through.
  const buf = new Int32Array(new SharedArrayBuffer(4));
  const logLines = [];
  const result = reapOrphanedWorkerProcs({
    sessionsRoot,
    statePath,
    psOutput,
    kill: (pgid, sig) => {
      if (sig === 'SIGTERM') Atomics.wait(buf, 0, 0, 15);
      return true;
    },
    isAlive: () => false, // every attempted kill verifies dead immediately
    sleep: () => {},
    wallBudgetMs: 100,
    log: (msg) => { logLines.push(msg); },
  });

  assert.equal(result.scanned, CANDIDATE_COUNT);
  assert.equal(result.reaped + result.unverified, CANDIDATE_COUNT, 'every candidate must be accounted for — none silently dropped');
  assert.ok(result.unverified > 0, 'the fixture must actually exercise the budget-exceeded path');

  // Every one of the 20 pids appears in some log line (reaped or unverified).
  for (let i = 0; i < CANDIDATE_COUNT; i++) {
    const pid = 9100 + i;
    assert.ok(logLines.some(line => line.includes(`pid=${pid} `)), `pid ${pid} must appear in a log line`);
  }

  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  const unverifiedBudgetEvents = (state.activity ?? []).filter(e => e.event === 'worker_orphan_reap_unverified' && e.reason === 'budget_exceeded');
  assert.equal(unverifiedBudgetEvents.length, result.unverified, 'budget-skipped candidates must be reported via the unverified telemetry event');
});

/**
 * AC-6 (ticket b2252ef3): pins the AP-EXT-ITER2-01 realpath fix in
 * `orphan-reaper.ts:tmpRootPrefixes` against regression. `os.tmpdir()` on
 * macOS is the LEXICAL `/var/folders/...` form (`/var` -> `/private/var`),
 * while a spawned process's argv carries the REALPATH `/private/var/...`
 * form `path.resolve` does not follow. This builds the argv directly from
 * `fs.realpathSync(os.tmpdir())` (no symlink simulation) so the fixture is
 * exactly the realpath form a live orphan's argv carries.
 */
test('AC-6: an argv token in the REALPATH tmpdir form (/private/var/... on macOS) is matched and reaped, not dropped at the prefix compare', () => {
  const sessionsRoot = makeTmp();
  const realTmpRoot = fs.realpathSync(os.tmpdir());
  const gateDir = path.join(realTmpRoot, 'pickle-ac6-realpath-pin');
  const command = `node ${gateDir}/bin/npm run test:fast`;

  const kills = [];
  const result = reapOrphanedWorkerProcs({
    sessionsRoot,
    psOutput: `31337 31337 1 20:00:00 ${command}`, // 20h old, well past the 600s min-age floor
    kill: (pgid, sig) => { kills.push([pgid, sig]); return true; },
    isAlive: () => false,
    sleep: () => {},
  });

  assert.equal(result.scanned, 1, 'a realpath-form argv must be scanned — scanned=0 here is the AP-EXT-ITER2-01 false-green regression signature');
  assert.equal(result.reaped, 1, 'the realpath-form orphan must reach the actual reap path, not just the parser');
  assert.deepEqual(kills, [[31337, 'SIGTERM']]);
  assert.equal(result.by_match_class.tmp_prefix_fixture, 1);
});

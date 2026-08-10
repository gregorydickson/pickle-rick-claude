// @tier: fast
/**
 * R-CXHANG regression tests: codex orphaned-worker-proc reaper (session-GC).
 *
 * AC-CXHANG-1: reap a worker proc whose owning session is not live; NEVER reap
 *              a proc owned by a live session (positive ownership required).
 * AC-CXHANG-4: PICKLE_ORPHAN_REAP=off makes the reaper an inert no-op.
 * AC-CXHANG-5 (shape): SIGTERM→SIGKILL escalation on a proc ignoring SIGTERM.
 *
 * Third instance of the established orphan-reaper pattern (see
 * tests/mux-runner-orphan-test-runner-reaper.test.js and
 * tests/oms-orphan-manager-reaped.test.js) — injectable scan/kill, fixture
 * ps tables, real tmpdir session state, no real processes touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  killProcessGroup,
  parseWorkerProcsFromPs,
  reapOrphanedWorkerProcs,
  ORPHAN_REAP_ENV_VAR,
} from '../services/orphan-reaper.js';
import { buildWorkerInvocation } from '../services/backend-spawn.js';
import { VALID_ACTIVITY_EVENTS, LATEST_SCHEMA_VERSION } from '../types/index.js';

function makeTmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cxhang-test-')));
}

// Sandbox any incidental activity writes away from the real data root.
process.env.PICKLE_DATA_ROOT = makeTmp();

/** Build a sessions root with one session dir; optionally write its state.json. */
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

function codexLine(pid, pgid, etime, ticketPath) {
  return `${pid} ${pgid} 1 ${etime} /Users/x/.npm/codex-darwin-arm64/bin/codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral --ignore-rules --ignore-user-config --add-dir /Users/x/repo --add-dir ${ticketPath} -- do the thing`;
}

function claudeLine(pid, pgid, etime, ticketPath) {
  return `${pid} ${pgid} 1 ${etime} /usr/local/bin/claude --dangerously-skip-permissions --add-dir /Users/x/repo --add-dir ${ticketPath} -p worker prompt here`;
}

// ---------------------------------------------------------------------------
// killProcessGroup — the shared negative-PID primitive (AC-CXHANG-3)
// ---------------------------------------------------------------------------

test('killProcessGroup: returns false on win32 (no process groups)', () => {
  assert.equal(killProcessGroup(12345, 'SIGTERM', 'win32'), false);
});

test('killProcessGroup: returns false for non-positive or non-integer pid', () => {
  assert.equal(killProcessGroup(0, 'SIGTERM', 'darwin'), false);
  assert.equal(killProcessGroup(-5, 'SIGTERM', 'darwin'), false);
  assert.equal(killProcessGroup(1.5, 'SIGTERM', 'darwin'), false);
});

test('killProcessGroup: returns false when the group is already gone', () => {
  // PID 2^22-ish is far above any live pid ceiling on macOS/Linux defaults.
  assert.equal(killProcessGroup(4194000, 'SIGTERM', process.platform), false);
});

// ---------------------------------------------------------------------------
// parseWorkerProcsFromPs
// ---------------------------------------------------------------------------

test('parseWorkerProcsFromPs: empty output yields no candidates', () => {
  assert.deepEqual(parseWorkerProcsFromPs('', '/tmp/sessions'), []);
});

test('parseWorkerProcsFromPs: detects codex and claude workers, attributes owning session', () => {
  const sessionsRoot = makeTmp();
  const sessA = path.join(sessionsRoot, 'sess-a');
  const psOutput = [
    codexLine(100, 100, '16:03:00', path.join(sessA, 'ticket1')),
    claudeLine(200, 200, '2-01:00:00', path.join(sessA, 'ticket2')),
    // noise: not worker-shaped
    `300 300 1 05:00:00 /usr/bin/node --test /tmp/whatever.test.js`,
    `400 400 1 05:00:00 sleep 9999`,
    // claude but NOT a worker (no -p)
    `500 500 1 05:00:00 /usr/local/bin/claude --dangerously-skip-permissions --resume`,
    // codex but no bypass flag
    `600 600 1 05:00:00 /usr/local/bin/codex exec --add-dir ${path.join(sessA, 'ticket1')} -- x`,
  ].join('\n');
  const result = parseWorkerProcsFromPs(psOutput, sessionsRoot);
  assert.equal(result.length, 2);
  assert.equal(result[0].pid, 100);
  assert.equal(result[0].pgid, 100);
  assert.equal(result[0].owningSessionDir, sessA);
  assert.ok(result[0].etime_seconds >= 16 * 3600);
  assert.equal(result[1].pid, 200);
  assert.equal(result[1].owningSessionDir, sessA);
  assert.ok(result[1].etime_seconds >= 2 * 86400);
});

test('parseWorkerProcsFromPs: worker with no --add-dir under sessionsRoot has null attribution', () => {
  const sessionsRoot = makeTmp();
  const psOutput = claudeLine(700, 700, '10:00:00', '/somewhere/else/ticket');
  const result = parseWorkerProcsFromPs(psOutput, sessionsRoot);
  assert.equal(result.length, 1);
  assert.equal(result[0].owningSessionDir, null);
});

test('parseWorkerProcsFromPs: matcher matches the REAL spawn invocation shapes (drift pin)', () => {
  const sessionsRoot = makeTmp();
  const ticketPath = path.join(makeSession(sessionsRoot, 'sess-drift'), 'ticket1');
  for (const backend of ['codex', 'claude']) {
    const inv = buildWorkerInvocation(backend, {
      prompt: 'do the work',
      addDirs: [sessionsRoot, ticketPath],
    });
    const command = `/usr/local/bin/${inv.cmd} ${inv.args.join(' ')}`;
    const result = parseWorkerProcsFromPs(`901 901 1 12:00:00 ${command}`, sessionsRoot);
    assert.equal(result.length, 1, `${backend} invocation must be worker-shaped: ${command}`);
    assert.equal(result[0].owningSessionDir, path.join(sessionsRoot, 'sess-drift'),
      `${backend} invocation must attribute via --add-dir`);
  }
});

// ---------------------------------------------------------------------------
// reapOrphanedWorkerProcs — AC-CXHANG-1 classification
// ---------------------------------------------------------------------------

test('AC-CXHANG-1: reaps orphan (active:false session), spares live session, spares unattributable', () => {
  const sessionsRoot = makeTmp();
  const deadSess = makeSession(sessionsRoot, 'sess-dead', { active: false });
  const liveSess = makeSession(sessionsRoot, 'sess-live', { active: true, pid: process.pid });
  const reaperSess = makeSession(sessionsRoot, 'sess-reaper', { active: true, pid: process.pid });
  const statePath = path.join(reaperSess, 'state.json');

  const psOutput = [
    codexLine(1001, 1001, '16:00:00', path.join(deadSess, 'ticket1')),   // orphan → reap
    claudeLine(1002, 1002, '16:00:00', path.join(liveSess, 'ticket1')),  // live session → spare
    claudeLine(1003, 1003, '16:00:00', '/not/under/root/ticket'),        // unattributable → spare
  ].join('\n');

  const kills = [];
  const result = reapOrphanedWorkerProcs({
    sessionsRoot,
    statePath,
    psOutput,
    kill: (pgid, sig) => { kills.push([pgid, sig]); return true; },
    isAlive: (pid) => pid === process.pid, // orphan dies on first signal; session pid live
    sleep: () => {},
  });

  assert.equal(result.scanned, 3);
  assert.equal(result.reaped, 1);
  assert.deepEqual(kills, [[1001, 'SIGTERM']], 'ONLY the orphan pgid gets signaled');

  // worker_orphan_reaped activity event landed on the reaper session state
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  const events = (state.activity ?? []).filter(e => e.event === 'worker_orphan_reaped');
  assert.equal(events.length, 1);
  assert.equal(events[0].pid, 1001);
  assert.equal(events[0].pgid, 1001);
  assert.ok(typeof events[0].ts === 'string' && events[0].ts.length > 0, 'explicit ts stamped');
  assert.equal(events[0].owning_session, 'sess-dead');
  assert.ok(events[0].argv_summary.includes('codex'));
});

test('AC-CXHANG-1: missing state.json (crashed/pruned session) classifies as orphan', () => {
  const sessionsRoot = makeTmp();
  const goneSess = makeSession(sessionsRoot, 'sess-gone'); // no state.json written
  const kills = [];
  const result = reapOrphanedWorkerProcs({
    sessionsRoot,
    psOutput: claudeLine(2001, 2001, '20:00:00', path.join(goneSess, 'ticket1')),
    kill: (pgid, sig) => { kills.push([pgid, sig]); return true; },
    isAlive: () => false,
    sleep: () => {},
  });
  assert.equal(result.reaped, 1);
  assert.deepEqual(kills, [[2001, 'SIGTERM']]);
});

// AP-EXT-ITER30-01: an UNREADABLE state.json is not an absent one.
// `readRecoverableJsonObject` returns null for BOTH "no such file" and "the
// read threw" (EMFILE/ENFILE/EIO/EACCES/EISDIR — the c=8 fd-exhaustion class),
// and the pre-fix predicate read that null as "session is dead" and group-
// SIGKILLed a LIVE sibling pipeline's worker. Assert the KILLS, not the return
// shape: the pre-fix call also returned {scanned:1} — with the proc dead.
test('AP-EXT-ITER30-01: an UNREADABLE state.json spares the proc (not proof of death)', () => {
  const sessionsRoot = makeTmp();
  const sess = makeSession(sessionsRoot, 'sess-unreadable'); // no state.json file...
  // ...a DIRECTORY at its path instead: readFileSync throws EISDIR for every
  // uid, so the fixture does not silently pass when tests run as root.
  fs.mkdirSync(path.join(sess, 'state.json'));

  const kills = [];
  const result = reapOrphanedWorkerProcs({
    sessionsRoot,
    psOutput: codexLine(3201, 3201, '20:00:00', path.join(sess, 'ticket1')),
    kill: (pgid, sig) => { kills.push([pgid, sig]); return true; },
    isAlive: () => false,
    sleep: () => {},
  });

  assert.equal(result.scanned, 1, 'the proc is still scanned and attributed');
  assert.equal(result.reaped, 0);
  assert.deepEqual(kills, [], 'a session whose state we cannot read is NEVER reaped');
});

test('AP-EXT-ITER30-01: an unparseable state.json spares the proc', () => {
  const sessionsRoot = makeTmp();
  const sess = makeSession(sessionsRoot, 'sess-corrupt');
  fs.writeFileSync(path.join(sess, 'state.json'), '{"active": tr');

  const kills = [];
  const result = reapOrphanedWorkerProcs({
    sessionsRoot,
    psOutput: claudeLine(3202, 3202, '20:00:00', path.join(sess, 'ticket1')),
    kill: (pgid, sig) => { kills.push([pgid, sig]); return true; },
    isAlive: () => false,
    sleep: () => {},
  });

  assert.equal(result.reaped, 0);
  assert.deepEqual(kills, []);
});

test('AC-CXHANG-1: active:true session with provably-dead pid classifies as orphan (dead-pid demotion)', () => {
  const sessionsRoot = makeTmp();
  const zombieSess = makeSession(sessionsRoot, 'sess-zombie', { active: true, pid: 4194001 });
  const kills = [];
  const result = reapOrphanedWorkerProcs({
    sessionsRoot,
    psOutput: codexLine(3001, 3001, '20:00:00', path.join(zombieSess, 'ticket1')),
    kill: (pgid, sig) => { kills.push([pgid, sig]); return true; },
    isAlive: () => false,
    sleep: () => {},
  });
  assert.equal(result.reaped, 1);
});

test('AC-CXHANG-1: active:true session with NO pid field is spared (conservative bias)', () => {
  const sessionsRoot = makeTmp();
  const noPidSess = makeSession(sessionsRoot, 'sess-nopid', { active: true });
  const kills = [];
  const result = reapOrphanedWorkerProcs({
    sessionsRoot,
    psOutput: codexLine(3101, 3101, '20:00:00', path.join(noPidSess, 'ticket1')),
    kill: (pgid, sig) => { kills.push([pgid, sig]); return true; },
    isAlive: () => false,
    sleep: () => {},
  });
  assert.equal(result.reaped, 0);
  assert.deepEqual(kills, []);
});

test('min-age guard: orphan younger than 600s is spared by default', () => {
  const sessionsRoot = makeTmp();
  const deadSess = makeSession(sessionsRoot, 'sess-young', { active: false });
  const kills = [];
  const result = reapOrphanedWorkerProcs({
    sessionsRoot,
    psOutput: codexLine(4001, 4001, '05:00', path.join(deadSess, 'ticket1')), // 5 min
    kill: (pgid, sig) => { kills.push([pgid, sig]); return true; },
    isAlive: () => false,
    sleep: () => {},
  });
  assert.equal(result.scanned, 1);
  assert.equal(result.reaped, 0);
  assert.deepEqual(kills, []);
});

test('never signals its own process/parent group even when attribution says orphan', () => {
  const sessionsRoot = makeTmp();
  const deadSess = makeSession(sessionsRoot, 'sess-self', { active: false });
  const kills = [];
  const result = reapOrphanedWorkerProcs({
    sessionsRoot,
    psOutput: claudeLine(process.pid, process.pid, '20:00:00', path.join(deadSess, 'ticket1')),
    kill: (pgid, sig) => { kills.push([pgid, sig]); return true; },
    isAlive: () => false,
    sleep: () => {},
  });
  assert.equal(result.reaped, 0);
  assert.deepEqual(kills, []);
});

// ---------------------------------------------------------------------------
// AC-CXHANG-5 shape: SIGTERM → SIGKILL escalation
// ---------------------------------------------------------------------------

test('escalation: a proc that survives SIGTERM past the grace window gets SIGKILL on its group', () => {
  const sessionsRoot = makeTmp();
  const deadSess = makeSession(sessionsRoot, 'sess-stuck', { active: false });
  const kills = [];
  const result = reapOrphanedWorkerProcs({
    sessionsRoot,
    psOutput: codexLine(5001, 5001, '20:00:00', path.join(deadSess, 'ticket1')),
    kill: (pgid, sig) => { kills.push([pgid, sig]); return true; },
    isAlive: (pid) => pid === 5001, // network-blocked codex ignores SIGTERM forever
    sleep: () => {},
    graceMs: 50,
  });
  assert.equal(result.reaped, 1);
  assert.deepEqual(kills, [[5001, 'SIGTERM'], [5001, 'SIGKILL']]);
});

// ---------------------------------------------------------------------------
// AC-CXHANG-4: kill-switch + win32 no-op
// ---------------------------------------------------------------------------

test('AC-CXHANG-4: PICKLE_ORPHAN_REAP=off is inert — no scan, no kill, {0,0}', () => {
  let scanCalls = 0;
  const kills = [];
  const result = reapOrphanedWorkerProcs({
    sessionsRoot: makeTmp(),
    env: { [ORPHAN_REAP_ENV_VAR]: 'off' },
    scan: () => { scanCalls += 1; return ''; },
    kill: (pgid, sig) => { kills.push([pgid, sig]); return true; },
  });
  assert.deepEqual(result, { scanned: 0, reaped: 0 });
  assert.equal(scanCalls, 0, 'scan must not run under the kill-switch');
  assert.deepEqual(kills, []);
});

test('AC-CXHANG-4: only the literal lowercase "off" disables', () => {
  let scanCalls = 0;
  const result = reapOrphanedWorkerProcs({
    sessionsRoot: makeTmp(),
    env: { [ORPHAN_REAP_ENV_VAR]: 'OFF' },
    scan: () => { scanCalls += 1; return ''; },
    kill: () => true,
  });
  assert.equal(scanCalls, 1, 'non-lowercase value keeps the reaper active');
  assert.deepEqual(result, { scanned: 0, reaped: 0 });
});

test('win32: safe no-op — no scan, {0,0}', () => {
  let scanCalls = 0;
  const result = reapOrphanedWorkerProcs({
    sessionsRoot: makeTmp(),
    platform: 'win32',
    scan: () => { scanCalls += 1; return ''; },
  });
  assert.deepEqual(result, { scanned: 0, reaped: 0 });
  assert.equal(scanCalls, 0);
});

test('never throws: a throwing scan is swallowed (best-effort)', () => {
  const result = reapOrphanedWorkerProcs({
    sessionsRoot: makeTmp(),
    scan: () => { throw new Error('ps exploded'); },
  });
  assert.deepEqual(result, { scanned: 0, reaped: 0 });
});

// ---------------------------------------------------------------------------
// Registration (the recurring B-CWGE/B-APNC closer bug — register new events!)
// ---------------------------------------------------------------------------

test('worker_orphan_reaped is registered in VALID_ACTIVITY_EVENTS', () => {
  assert.ok(
    VALID_ACTIVITY_EVENTS.includes('worker_orphan_reaped'),
    'worker_orphan_reaped must be in VALID_ACTIVITY_EVENTS',
  );
});

test('no schema bump: LATEST_SCHEMA_VERSION stays 5', () => {
  assert.equal(LATEST_SCHEMA_VERSION, 5, 'R-CXHANG is schema-neutral');
});

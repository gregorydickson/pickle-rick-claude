// @tier: fast
/**
 * Ticket d2368bde: widen `isWorkerShapedCommand` so the node-spawned worker
 * gate npm shim family (a tmpdir, pickle-prefixed dir's bin npm script) is
 * recognized as worker-shaped and reaches the existing `tmp_fixture` branch
 * in `parseWorkerProcsFromPs`. Downstream gates (ownership trap door,
 * minAgeSeconds, dead-pid demotion) are unchanged — only the first-gate
 * rejection for this family is fixed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseWorkerProcsFromPs, reapOrphanedWorkerProcs } from '../services/orphan-reaper.js';

test('AC-4: the exact live argv shape (node <tmpdir>/pickle-*/bin/npm run test:fast) yields one tmp_fixture candidate', () => {
  const sessionsRoot = path.join(os.tmpdir(), 'd2368bde-sessions-root');
  const gateDir = path.join(os.tmpdir(), 'pickle-spawn-morty-worker-gate-ctSoCs');
  const command = `node ${gateDir}/bin/npm run test:fast`;
  const result = parseWorkerProcsFromPs(`9101 9101 1 20:00:00 ${command}`, sessionsRoot);
  assert.equal(result.length, 1, 'the node/bin/npm shape must be admitted');
  assert.equal(result[0].kind, 'tmp_fixture');
  assert.equal(result[0].matchClass, 'tmp_prefix_fixture');
  assert.equal(result[0].owningSessionDir, null);
});

test('AC-4 (negative): an unrelated node script.js invocation yields no candidate', () => {
  const sessionsRoot = path.join(os.tmpdir(), 'd2368bde-sessions-root');
  const command = 'node script.js';
  const result = parseWorkerProcsFromPs(`9102 9102 1 20:00:00 ${command}`, sessionsRoot);
  assert.equal(result.length, 0, 'a bare unrelated node invocation must never match');
});

test('AC-4 (negative): a node invocation under a non-pickle tmpdir path does not match', () => {
  const sessionsRoot = path.join(os.tmpdir(), 'd2368bde-sessions-root');
  const otherDir = path.join(os.tmpdir(), 'other-tool-xyz');
  const command = `node ${otherDir}/bin/npm run test:fast`;
  const result = parseWorkerProcsFromPs(`9103 9103 1 20:00:00 ${command}`, sessionsRoot);
  assert.equal(result.length, 0, 'a non pickle- prefixed tmpdir path must not match');
});

test('AC-4 (scope check): isPickleTmpBinNpmPath narrows to bin/npm — a sibling non-npm path under the same pickle- tmpdir is not itself worker-shaped, but still reaches tmp_fixture via the pre-existing broad tmp-prefix fallback', () => {
  const sessionsRoot = path.join(os.tmpdir(), 'd2368bde-sessions-root');
  const gateDir = path.join(os.tmpdir(), 'pickle-spawn-morty-worker-gate-ctSoCs');
  const command = `node ${gateDir}/lib/other.js`;
  const result = parseWorkerProcsFromPs(`9104 9104 1 20:00:00 ${command}`, sessionsRoot);
  assert.equal(result.length, 1, 'the pre-existing tmp-prefix fallback (unrelated to this widening) still admits any path under a pickle- tmpdir');
  assert.equal(result[0].kind, 'tmp_fixture');
});

test('AC-5: a young candidate of the node/bin/npm family (age below minAgeSeconds) is NOT reaped', () => {
  const sessionsRoot = path.join(os.tmpdir(), 'd2368bde-sessions-root');
  const gateDir = path.join(os.tmpdir(), 'pickle-spawn-morty-worker-gate-young');
  const command = `node ${gateDir}/bin/npm run test:fast`;
  const kills = [];
  const result = reapOrphanedWorkerProcs({
    sessionsRoot,
    psOutput: `9105 9105 1 05:00 ${command}`, // 5 minutes, well under the 600s floor
    kill: (pgid, sig) => { kills.push([pgid, sig]); return true; },
    isAlive: () => false,
    sleep: () => {},
  });
  assert.equal(result.scanned, 1, 'still admitted by the parser');
  assert.equal(result.reaped, 0, 'but spared by the min-age gate — a live worker-gate child cannot be collected');
  assert.deepEqual(kills, []);
});

test('AC-5: an old candidate of the node/bin/npm family (age above minAgeSeconds) IS reaped', () => {
  const sessionsRoot = path.join(os.tmpdir(), 'd2368bde-sessions-root');
  const gateDir = path.join(os.tmpdir(), 'pickle-spawn-morty-worker-gate-old');
  const command = `node ${gateDir}/bin/npm run test:fast`;
  const kills = [];
  const result = reapOrphanedWorkerProcs({
    sessionsRoot,
    psOutput: `9106 9106 1 16:00:00 ${command}`, // 16 hours, well above the 600s floor
    kill: (pgid, sig) => { kills.push([pgid, sig]); return true; },
    isAlive: () => false,
    sleep: () => {},
  });
  assert.equal(result.reaped, 1, 'an old candidate reaches the same reap path as other tmp_fixture matches');
  assert.deepEqual(kills, [[9106, 'SIGTERM']]);
});

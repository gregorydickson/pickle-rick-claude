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
import * as fs from 'node:fs';
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


/**
 * AP-EXT-ITER2-01: the tmpdir matchers compared an argv path against
 * `path.resolve(os.tmpdir())`, which is LEXICAL — it does not follow symlinks. On macOS
 * `os.tmpdir()` is `/var/folders/…/T` (where `/var` -> `/private/var`) while a spawned
 * process's argv carries the realpath form `/private/var/folders/…/T`, so `startsWith`
 * rejected every real orphan: 10 alive `pickle-spawn-morty-worker-gate-*` procs measured
 * against a reaper reporting `scanned=0`.
 *
 * Every case ABOVE builds its fixture with `path.join(os.tmpdir(), …)` — the same lexical
 * form the predicate compared against — which is why this suite stayed green while
 * production was blind. The cases BELOW drive the form MISMATCH instead, by pointing
 * `TMPDIR` at a symlink whose target holds the argv path. That reproduces the macOS `/var`
 * relationship on any platform, so the pin is not host-shaped.
 */
/**
 * Run `fn` with `os.tmpdir()` resolving through a SYMLINK to the real temp root, and hand
 * it the real (link-free) root — the form a spawned process's argv actually carries.
 */
function withSymlinkedTmpdir(fn) {
  const realTmp = fs.realpathSync(os.tmpdir());
  const holder = fs.mkdtempSync(path.join(realTmp, 'ap-ext-iter2-01-'));
  const link = path.join(holder, 'tmplink');
  fs.symlinkSync(realTmp, link);
  const priorTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = link;
  try {
    assert.equal(path.resolve(os.tmpdir()), link, 'precondition: os.tmpdir() must read the symlink');
    assert.notEqual(link, realTmp, 'precondition: the two forms must actually differ');
    fn({ realTmp, link });
  } finally {
    if (priorTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = priorTmpdir;
    fs.rmSync(holder, { recursive: true, force: true });
  }
}

test('AP-EXT-ITER2-01: a worker-gate orphan whose argv carries the REALPATH tmp root is still admitted', () => {
  withSymlinkedTmpdir(({ realTmp, link }) => {
    const gateDir = path.join(realTmp, 'pickle-spawn-morty-worker-gate-KUWFIE');
    const command = `node ${gateDir}/bin/npm run test:fast`;
    const result = parseWorkerProcsFromPs(`12054 12054 1 26:29 ${command}`, path.join(link, 'sessions'));
    assert.equal(result.length, 1, 'the realpath-form argv must reach the parser, not be dropped at the tmpdir prefix compare');
    assert.equal(result[0].kind, 'tmp_fixture');
    assert.equal(result[0].matchClass, 'tmp_prefix_fixture');
  });
});

test('AP-EXT-ITER2-01: the realpath-form orphan reaches the actual reap path, not just the parser', () => {
  withSymlinkedTmpdir(({ realTmp, link }) => {
    const gateDir = path.join(realTmp, 'pickle-spawn-morty-worker-gate-tXZApi');
    const kills = [];
    const result = reapOrphanedWorkerProcs({
      sessionsRoot: path.join(link, 'sessions'),
      psOutput: `25572 25572 1 01:30:38 node ${gateDir}/bin/npm run test:fast`,
      kill: (pgid, sig) => { kills.push([pgid, sig]); return true; },
      isAlive: () => false,
      sleep: () => {},
    });
    assert.equal(result.scanned, 1, 'scanned=0 over a live orphan is the false-green this pins');
    assert.equal(result.reaped, 1);
    assert.deepEqual(kills, [[25572, 'SIGTERM']]);
  });
});

test('AP-EXT-ITER2-01: the broad tmp-prefix fixture matcher is fixed on the same axis, not just the bin/npm one', () => {
  withSymlinkedTmpdir(({ realTmp, link }) => {
    // Not worker-shaped (no bin/npm, not codex/claude) — it can only be admitted by
    // resolveTmpPrefixFixturePath, so this case isolates the second collapsed call site.
    const fixtureDir = path.join(realTmp, 'cxhang-int-bin-abc123');
    const result = parseWorkerProcsFromPs(
      `31765 31765 1 47:57 ${fixtureDir}/hang.sh`,
      path.join(link, 'sessions'),
    );
    assert.equal(result.length, 1, 'the tmp-prefix fixture arm must accept the realpath form too');
    assert.equal(result[0].matchClass, 'tmp_prefix_fixture');
  });
});

test('AP-EXT-ITER2-01: the LEXICAL form still matches — the fix widens the roots, it does not swap them', () => {
  withSymlinkedTmpdir(({ link }) => {
    const gateDir = path.join(link, 'pickle-spawn-morty-worker-gate-9S0Oc8');
    const result = parseWorkerProcsFromPs(`19623 19623 1 36:48 node ${gateDir}/bin/npm run test:fast`, path.join(link, 'sessions'));
    assert.equal(result.length, 1, 'the pre-existing lexical-form match must not regress');
    assert.equal(result[0].matchClass, 'tmp_prefix_fixture');
  });
});

test('AP-EXT-ITER2-01 (negative): widening the tmp roots does not admit paths outside tmpdir', () => {
  withSymlinkedTmpdir(({ link }) => {
    const result = parseWorkerProcsFromPs(
      '44444 44444 1 47:57 node /opt/other-tool/pickle-spawn-morty-worker-gate-x/bin/npm run test:fast',
      path.join(link, 'sessions'),
    );
    assert.equal(result.length, 0, 'a pickle-shaped path anchored outside tmpdir must still be rejected');
  });
});

test('AP-EXT-ITER2-01 (negative): a non-pickle first segment under the realpath root is still rejected', () => {
  withSymlinkedTmpdir(({ realTmp, link }) => {
    const otherDir = path.join(realTmp, 'other-tool-xyz');
    const result = parseWorkerProcsFromPs(
      `44445 44445 1 47:57 node ${otherDir}/bin/npm run test:fast`,
      path.join(link, 'sessions'),
    );
    assert.equal(result.length, 0, 'the prefix allow-list must still gate the widened roots');
  });
});

test('AP-EXT-ITER2-01: the tmp-root memo is keyed on the tmpdir value, so a reassigned TMPDIR is never served a stale root', () => {
  // Prime the cache against the ambient tmpdir first...
  parseWorkerProcsFromPs('55555 55555 1 47:57 node /nowhere/bin/npm', '/nowhere/sessions');
  // ...then flip TMPDIR and require the new root to take effect immediately.
  withSymlinkedTmpdir(({ realTmp, link }) => {
    const gateDir = path.join(realTmp, 'pickle-spawn-morty-worker-gate-my8F07');
    const result = parseWorkerProcsFromPs(`93266 93266 1 01:35:35 node ${gateDir}/bin/npm run test:fast`, path.join(link, 'sessions'));
    assert.equal(result.length, 1, 'a stale memo would reject the orphan under the new tmpdir');
  });
});

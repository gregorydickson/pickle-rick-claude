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

/**
 * Ticket 4329498d (AC-6): pin the realpath handling on the shape the test-runner seam
 * ACTUALLY produces, which every case above misses.
 *
 * `test-runner.ts` mkdtemps a `pickle-`-prefixed disposable root and hands it to the spawned
 * test child as `TMPDIR`. Fixtures created inside that child therefore live one level DEEPER
 * than anything pinned above: the argv path is `<tmp>/pickle-<root>/cp-git-<n>`, where the
 * `pickle-` segment is the disposable ROOT and the leaking fixture is its CHILD. Every
 * `AP-EXT-ITER2-01` case above pins a path whose `pickle-` segment is the argv path's own
 * basename — a first-segment match that happens to also be the last. Nesting is the untested
 * axis, and it is the only one the seam produces in production.
 */
test('4329498d AC-6: a NESTED fixture under a pickle- disposable root, in realpath form, is admitted', () => {
  withSymlinkedTmpdir(({ realTmp, link }) => {
    // The seam's shape: disposable root `pickle-<rand>`, leaking fixture `cp-git-<n>` inside it.
    // `cp-git-` is deliberately NOT in TEST_OWNED_TMP_PREFIXES — admission must come from the
    // FIRST segment beneath tmpdir (the pickle- root), which is precisely what constraint (a)
    // buys and what a `tmp.XXXXXX` root would have destroyed.
    const nested = path.join(realTmp, 'pickle-Xk4mZq', 'cp-git-17');
    const result = parseWorkerProcsFromPs(
      `61001 61001 1 12:04 node ${nested}/run.js`,
      path.join(link, 'sessions'),
    );
    assert.equal(result.length, 1, 'a fixture nested under the disposable pickle- root must still match');
    assert.equal(result[0].kind, 'tmp_fixture');
    assert.equal(result[0].matchClass, 'tmp_prefix_fixture');
  });
});

/**
 * Constraint (c)'s safety corollary. The seam removes its disposable root on exit, while a
 * leaked child proc may still be alive holding the removed path in its argv. `resolveUnderTmpRoot`
 * is a pure `startsWith` compare with no `existsSync`, so removal does not blind argv matching —
 * an `existsSync` guard added there would make cleanup-on-exit and reapability mutually exclusive.
 */
test('4329498d AC-6: an ALREADY-REMOVED pickle- root still matches — the compare is lexical, not stat-based', () => {
  withSymlinkedTmpdir(({ realTmp, link }) => {
    const removedRoot = path.join(realTmp, 'pickle-neverExisted4329498d');
    assert.equal(fs.existsSync(removedRoot), false, 'precondition: the root must not exist on disk');
    const result = parseWorkerProcsFromPs(
      `61002 61002 1 12:05 node ${removedRoot}/cp-state-3/run.js`,
      path.join(link, 'sessions'),
    );
    assert.equal(result.length, 1, 'a stat-based guard here would silently un-reap every cleaned-up root');
    assert.equal(result[0].matchClass, 'tmp_prefix_fixture');
  });
});

/**
 * The control for both cases above. Without it, they would pass unchanged in a world where the
 * `TEST_OWNED_TMP_PREFIXES` gate had been deleted — i.e. in exactly the world where `04df0897`
 * has been silently reverted and a `tmp.XXXXXX` root makes every fixture orphan unmatchable.
 * Nesting support must not widen admission to ANY deep path under tmpdir.
 */
test('4329498d AC-6 (negative): the same nested fixture under a NON-test-owned root is still rejected', () => {
  withSymlinkedTmpdir(({ realTmp, link }) => {
    // `tmp.XXXXXX` is the literal shape a bare `mktemp -d` would have produced at the seam.
    const nested = path.join(realTmp, 'tmp.8Fj2Kd', 'cp-git-17');
    const result = parseWorkerProcsFromPs(
      `61003 61003 1 12:06 node ${nested}/run.js`,
      path.join(link, 'sessions'),
    );
    assert.equal(result.length, 0, 'admission must key on the FIRST segment prefix, not on depth under tmpdir');
  });
});

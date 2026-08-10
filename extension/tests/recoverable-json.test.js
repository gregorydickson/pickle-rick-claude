// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readRecoverableJsonObject } from '../services/recoverable-json.js';

function makeTempDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recoverable-json-')));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function setMtime(filePath, epochMs) {
  const time = new Date(epochMs);
  fs.utimesSync(filePath, time, time);
}

function withTempDir(fn) {
  const dir = makeTempDir();
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const DEAD_PID = 99_999_999;
const BASE_TIME = 1_700_000_000_000;

test('readRecoverableJsonObject promotes an orphan tmp when it is newer than the base file', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'cache.json');
    const tmp = `${target}.tmp.${DEAD_PID}.orphan`;
    writeJson(target, { source: 'base' });
    writeJson(tmp, { source: 'orphan-tmp' });
    setMtime(target, BASE_TIME);
    setMtime(tmp, BASE_TIME + 1_000);

    const recovered = readRecoverableJsonObject(target);

    assert.deepEqual(recovered, { source: 'orphan-tmp' });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { source: 'orphan-tmp' });
    assert.equal(fs.existsSync(tmp), false);
  });
});

test('readRecoverableJsonObject skips a tmp owned by a live PID', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'cache.json');
    const tmp = `${target}.tmp.${process.pid}`;
    writeJson(target, { source: 'base' });
    writeJson(tmp, { source: 'live-tmp' });
    setMtime(target, BASE_TIME);
    // The live-PID skip heuristic only treats the tmp as in-flight when its
    // mtime is at/after the owning process's start time. A live process cannot
    // have authored a file older than itself, so the tmp must be stamped now.
    setMtime(tmp, Date.now());

    const recovered = readRecoverableJsonObject(target);

    assert.deepEqual(recovered, { source: 'base' });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { source: 'base' });
    assert.equal(fs.existsSync(tmp), true);
  });
});

test('readRecoverableJsonObject promotes a newer tmp owned by a dead PID', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'cache.json');
    const tmp = `${target}.tmp.${DEAD_PID}`;
    writeJson(target, { source: 'base' });
    writeJson(tmp, { source: 'dead-pid-tmp' });
    setMtime(target, BASE_TIME);
    setMtime(tmp, BASE_TIME + 1_000);

    const recovered = readRecoverableJsonObject(target);

    assert.deepEqual(recovered, { source: 'dead-pid-tmp' });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { source: 'dead-pid-tmp' });
    assert.equal(fs.existsSync(tmp), false);
  });
});

test('readRecoverableJsonObject promotes a valid dead tmp when the base file is missing', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'cache.json');
    const tmp = `${target}.tmp.${DEAD_PID}`;
    writeJson(tmp, { source: 'missing-base-tmp' });
    setMtime(tmp, BASE_TIME + 1_000);

    const recovered = readRecoverableJsonObject(target);

    assert.deepEqual(recovered, { source: 'missing-base-tmp' });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { source: 'missing-base-tmp' });
    assert.equal(fs.existsSync(tmp), false);
  });
});

test('readRecoverableJsonObject promotes a newer dead tmp when the base file is corrupt', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'cache.json');
    const tmp = `${target}.tmp.${DEAD_PID}`;
    fs.writeFileSync(target, '{not json');
    writeJson(tmp, { source: 'corrupt-base-tmp' });
    setMtime(target, BASE_TIME);
    setMtime(tmp, BASE_TIME + 1_000);

    const recovered = readRecoverableJsonObject(target);

    assert.deepEqual(recovered, { source: 'corrupt-base-tmp' });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { source: 'corrupt-base-tmp' });
    assert.equal(fs.existsSync(tmp), false);
  });
});

test('readRecoverableJsonObject deletes stale dead tmp files without replacing the base file', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'cache.json');
    const staleTmp = `${target}.tmp.${DEAD_PID}`;
    writeJson(target, { source: 'base' });
    writeJson(staleTmp, { source: 'stale-tmp' });
    setMtime(target, BASE_TIME + 2_000);
    setMtime(staleTmp, BASE_TIME + 1_000);

    const recovered = readRecoverableJsonObject(target);

    assert.deepEqual(recovered, { source: 'base' });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { source: 'base' });
    assert.equal(fs.existsSync(staleTmp), false);
  });
});

test('readRecoverableJsonObject deletes invalid dead tmp files without replacing the base file', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'cache.json');
    const invalidTmp = `${target}.tmp.${DEAD_PID}`;
    writeJson(target, { source: 'base' });
    fs.writeFileSync(invalidTmp, JSON.stringify(['not', 'an', 'object']));
    setMtime(target, BASE_TIME);
    setMtime(invalidTmp, BASE_TIME + 1_000);

    const recovered = readRecoverableJsonObject(target);

    assert.deepEqual(recovered, { source: 'base' });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { source: 'base' });
    assert.equal(fs.existsSync(invalidTmp), false);
  });
});

test('readRecoverableJsonObject promotes an equal-mtime dead tmp (R-CIFB-B tie-to-tmp)', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'cache.json');
    const tmp = `${target}.tmp.${DEAD_PID}`;
    writeJson(target, { source: 'base' });
    writeJson(tmp, { source: 'tie-tmp' });
    // IDENTICAL forced mtime — the Linux coarse-mtime tie the fix must promote.
    setMtime(target, BASE_TIME);
    setMtime(tmp, BASE_TIME);

    const recovered = readRecoverableJsonObject(target);

    assert.deepEqual(recovered, { source: 'tie-tmp' });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { source: 'tie-tmp' });
    assert.equal(fs.existsSync(tmp), false);
  });
});

test('readRecoverableJsonObject resolves equal-mtime competing tmps first-seen-wins (R-CIFB-B pinned ordering)', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'cache.json');
    // Two dead tmps with IDENTICAL mtime. Winner-selection keeps strict `>`, so the
    // FIRST tmp entry the readdir scan reaches wins (and is never replaced on a tie).
    const tmpA = `${target}.tmp.${DEAD_PID - 1}`;
    const tmpB = `${target}.tmp.${DEAD_PID}`;
    writeJson(target, { source: 'base' });
    writeJson(tmpA, { source: `pid-${DEAD_PID - 1}` });
    writeJson(tmpB, { source: `pid-${DEAD_PID}` });
    setMtime(target, BASE_TIME);
    setMtime(tmpA, BASE_TIME + 1_000);
    setMtime(tmpB, BASE_TIME + 1_000);

    // Derive the pinned (first-seen) winner from the same scan order the impl uses.
    const baseName = path.basename(target);
    const tmpPrefix = baseName + '.tmp.';
    const firstSeen = fs
      .readdirSync(dir)
      .filter((e) => e.startsWith(tmpPrefix))[0];
    const expected = { source: `pid-${firstSeen.slice(tmpPrefix.length)}` };

    const recovered = readRecoverableJsonObject(target);

    assert.deepEqual(recovered, expected, 'first-seen tmp must win the equal-mtime tie');
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), expected);
  });
});

test('readRecoverableJsonObject promotes the highest-mtime tmp from multiple competing dead writers', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'cache.json');
    const olderTmp = `${target}.tmp.${DEAD_PID - 1}`;
    const newestTmp = `${target}.tmp.${DEAD_PID}`;
    writeJson(target, { source: 'base' });
    writeJson(olderTmp, { source: 'older-tmp' });
    writeJson(newestTmp, { source: 'newest-tmp' });
    setMtime(target, BASE_TIME);
    setMtime(olderTmp, BASE_TIME + 1_000);
    setMtime(newestTmp, BASE_TIME + 2_000);

    const recovered = readRecoverableJsonObject(target);

    assert.deepEqual(recovered, { source: 'newest-tmp' });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { source: 'newest-tmp' });
    assert.equal(fs.existsSync(newestTmp), false);
    assert.equal(fs.existsSync(olderTmp), true);
  });
});

test('readRecoverableJsonObject ignores files outside the recoverable tmp pattern', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'cache.json');
    const nonMatching = path.join(dir, 'cache.json.tmp.not-a-pid');
    writeJson(target, { source: 'base' });
    writeJson(nonMatching, { source: 'ignored' });
    setMtime(target, BASE_TIME);
    setMtime(nonMatching, BASE_TIME + 1_000);

    const recovered = readRecoverableJsonObject(target);

    assert.deepEqual(recovered, { source: 'base' });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { source: 'base' });
    assert.deepEqual(JSON.parse(fs.readFileSync(nonMatching, 'utf8')), { source: 'ignored' });
  });
});

// AP-EXT-ITER29-01: delete authority is "readable AND unparseable", never an
// errno allowlist. A symlink loop makes readFileSync throw ELOOP — a read
// failure outside the retired {EACCES,EPERM,EISDIR} list — so the pre-fix body
// classified a perfectly valid snapshot as garbage and unlinked it.
test('readRecoverableJsonObject preserves an orphan tmp whose read fails with a non-allowlisted errno', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'cache.json');
    const tmp = `${target}.tmp.${DEAD_PID}`;
    writeJson(target, { source: 'base' });
    // ELOOP: tmp -> loop-a -> loop-b -> loop-a
    const loopA = path.join(dir, 'loop-a');
    const loopB = path.join(dir, 'loop-b');
    fs.symlinkSync(loopB, loopA);
    fs.symlinkSync(loopA, loopB);
    fs.symlinkSync(loopA, tmp);

    let readErrno = null;
    try {
      fs.readFileSync(tmp, 'utf-8');
    } catch (err) {
      readErrno = err.code;
    }
    assert.equal(readErrno, 'ELOOP', 'fixture must produce a non-allowlisted read failure');

    const recovered = readRecoverableJsonObject(target);

    // The unreadable tmp is NOT deleted, and the readable base still wins.
    // lstat, not existsSync — existsSync follows the loop and reports false.
    assert.ok(fs.lstatSync(tmp, { throwIfNoEntry: false }), 'unreadable orphan tmp must survive');
    assert.deepEqual(recovered, { source: 'base' });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { source: 'base' });
  });
});

// The other half of the collapse: a READ that succeeds and yields unparseable
// bytes is still positively proven garbage and is still unlinked.
test('readRecoverableJsonObject still unlinks a readable-but-unparseable orphan tmp', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'cache.json');
    const tmp = `${target}.tmp.${DEAD_PID}`;
    writeJson(target, { source: 'base' });
    fs.writeFileSync(tmp, '{ not json');

    const recovered = readRecoverableJsonObject(target);

    assert.equal(fs.existsSync(tmp), false, 'proven-garbage tmp must be unlinked');
    assert.deepEqual(recovered, { source: 'base' });
  });
});

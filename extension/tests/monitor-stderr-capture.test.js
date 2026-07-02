// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  MONITOR_STDERR_CAP_BYTES,
  MONITOR_STDERR_LOG_NAME,
  appendMonitorStderrLog,
  buildMonitorStderrHeader,
  createMonitorStderrCapture,
} from '../bin/monitor.js';

const ALL_MONITOR_MODES = ['pickle', 'council', 'refinement', 'szechuan-sauce', 'anatomy-park'];

function makeSessionDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-monitor-stderr-')));
}

function readLog(sessionDir) {
  return fs.readFileSync(path.join(sessionDir, MONITOR_STDERR_LOG_NAME), 'utf8');
}

test('monitor stderr capture: first write per process includes header and payload', () => {
  const sessionDir = makeSessionDir();
  try {
    const writes = [];
    const capture = createMonitorStderrCapture({
      sessionDir,
      stderr: {
        write(chunk, _encoding, cb) {
          writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
          if (typeof cb === 'function') cb(null);
          return true;
        },
      },
    });

    capture.write('[monitor] render exploded\n');

    const log = readLog(sessionDir);
    assert.match(log, /^\[monitor-stderr\] session=[^ ]+ pid=\d+ ts=\d{4}-\d{2}-\d{2}T/);
    assert.match(log, /\[monitor\] render exploded/);
    assert.equal(capture.getHasWrittenHeader(), true);
    assert.equal(writes.join(''), '[monitor] render exploded\n');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('monitor stderr capture: append helper preserves thrown render message verbatim for every monitor mode', () => {
  for (const mode of ALL_MONITOR_MODES) {
    const sessionDir = makeSessionDir();
    try {
      const errLine = `[monitor] render failure for mode=${mode}: synthetic boom\n`;
      appendMonitorStderrLog({ sessionDir, chunk: errLine, firstWriteForProcess: true });
      const log = readLog(sessionDir);
      assert.match(log, new RegExp(errLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  }
});

test('monitor stderr capture: helper builds stable header shape', () => {
  const sessionDir = '/tmp/pickle-session-hash';
  const header = buildMonitorStderrHeader(sessionDir, 4321, '2026-05-15T20:00:00.000Z');
  assert.equal(
    header,
    '[monitor-stderr] session=pickle-session-hash pid=4321 ts=2026-05-15T20:00:00.000Z\n',
  );
});

test('monitor stderr capture: writes above 64 KB rotate and emit monitor_stderr_rotated', () => {
  const sessionDir = makeSessionDir();
  const activityEvents = [];
  try {
    const largeChunk = `${'x'.repeat(100 * 1024)}\n`;
    const result = appendMonitorStderrLog({
      sessionDir,
      chunk: largeChunk,
      firstWriteForProcess: true,
      logFn: (payload) => activityEvents.push(payload),
    });

    const logPath = path.join(sessionDir, MONITOR_STDERR_LOG_NAME);
    const stat = fs.statSync(logPath);
    const log = fs.readFileSync(logPath);

    assert.equal(result.rotated, true);
    assert.ok(result.bytesDropped > 0, 'rotation should report dropped bytes');
    assert.ok(stat.size <= MONITOR_STDERR_CAP_BYTES, `expected log <= ${MONITOR_STDERR_CAP_BYTES}, got ${stat.size}`);
    assert.equal(activityEvents.length, 1);
    assert.equal(activityEvents[0].event, 'monitor_stderr_rotated');
    assert.equal(activityEvents[0].session, path.basename(sessionDir));
    assert.equal(activityEvents[0].cap, MONITOR_STDERR_CAP_BYTES);
    assert.ok(activityEvents[0].bytes_dropped > 0);
    assert.equal(log.includes(Buffer.from(largeChunk.subarray ? largeChunk : largeChunk).toString('utf8').slice(-1024)), true);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('monitor stderr capture: second write does not repeat the header', () => {
  const sessionDir = makeSessionDir();
  try {
    appendMonitorStderrLog({ sessionDir, chunk: 'first\n', firstWriteForProcess: true });
    appendMonitorStderrLog({ sessionDir, chunk: 'second\n', firstWriteForProcess: false });
    const log = readLog(sessionDir);
    const headerMatches = log.match(/\[monitor-stderr\]/g) || [];
    assert.equal(headerMatches.length, 1);
    assert.match(log, /first\nsecond\n$/);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

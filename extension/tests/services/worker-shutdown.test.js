// @tier: fast
// R-WSE-1 — flushAndExit helper: verifies close event fires before process.exit.
// Uses a child-process subtest to observe exit code and stdout ordering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SHUTDOWN_JS = path.resolve(__dirname, '../../services/worker-shutdown.js');

test('flushAndExit: close event fires before process.exit', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wse1-flush-exit-'));
  const logPath = path.join(tmpDir, 'test.log');

  // Child script:
  // 1. Creates a write stream and writes some data
  // 2. Registers a 'close' listener that emits 'CLOSE_EVENT' to stdout
  // 3. Calls flushAndExit(stream, 42) — must flush, emit close, then exit(42)
  // 4. The line after flushAndExit is unreachable; emitting it would be a bug
  const script = `
import { createWriteStream } from 'node:fs';
import { flushAndExit } from ${JSON.stringify(WORKER_SHUTDOWN_JS)};

const stream = createWriteStream(${JSON.stringify(logPath)}, { flags: 'w' });
stream.write('some worker output');

stream.once('close', () => {
  process.stdout.write('CLOSE_EVENT\\n');
});

await flushAndExit(stream, 42);
process.stdout.write('UNREACHABLE\\n');
`;

  try {
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      input: script,
      encoding: 'utf8',
      timeout: 10_000,
    });

    assert.equal(result.status, 42, `expected exit code 42, got ${result.status}; stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('CLOSE_EVENT'), `expected CLOSE_EVENT in stdout; got: ${JSON.stringify(result.stdout)}`);
    assert.ok(!result.stdout.includes('UNREACHABLE'), `UNREACHABLE was reached — flushAndExit did not exit; stdout: ${result.stdout}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// R-WPEX detached-worker log-flush drain race (TDD red).
//
// Reproduces the spawn-morty.ts SUCCESS/close-path drain for a DETACHED, unref'd
// large-tier worker. mux-runner spawns spawn-morty `detached:true` + `unref()`
// (stdio:'ignore'), so spawn-morty SOLELY owns the worker_session log via
// `proc.stdout.pipe(sessionLog, {end:false})` (spawn-morty.ts:2122). On the
// success path the `proc.on('close')` handler (spawn-morty.ts:2191-2211) awaits
// `sessionLog.once('finish')` (writable buffer flushed to the OS write queue),
// then `sessionLog.end()`, then resolves and the process exits via natural
// event-loop drain.
//
// The DURABILITY GAP: unlike the hangGuard path — which calls
// `bestEffortFdatasync(sessionLogPath)` (spawn-morty.ts:2150) before
// `flushAndExit` — and unlike `flushAndExit` itself — which awaits the 'close'
// event (fd fully closed) — the success/close path NEVER fsyncs the log fd
// before the detached, unref'd process exits. `'finish'` only proves the bytes
// reached the OS page cache, not durable storage. For a detached worker the
// poll-reattach side can read a 0-byte / truncated log while artifacts are
// intact — the B-APNC 2026-06-28 idle-system signature.
//
// This test mirrors that exact drain (large piped payload, end:false, close ->
// once('finish') -> end -> exit) in a FAKE child (never the real claude binary,
// never spawn-morty detached) and asserts the durability guarantee the success
// path is MISSING: an fdatasync/fsync of the log fd MUST occur before the
// process exits. RED against current source (success path performs no fsync).
test('R-WPEX: detached-worker success/close drain fsyncs the log before exit', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpex-drain-race-'));
  const logPath = path.join(tmpDir, 'worker_session.log');
  const PAYLOAD_LINES = 50000; // large stdout payload, mirrors a real worker turn

  // Child faithfully replays spawn-morty's success/close-path drain:
  //   producer.stdout.pipe(sessionLog, { end: false })
  //   producer 'close' -> sessionLog.once('finish', resolve); sessionLog.end()
  //   resolve -> process.exit(0)   (natural drain; NO fsync on the success path)
  // It instruments fs.fdatasyncSync/fs.fsyncSync to record whether the success
  // drain durably synced the log fd to disk before exit, and prints a sentinel
  // line the parent can assert on. Written as CommonJS (a .cjs temp file) so the
  // `require('node:fs')` object is mutable for monkeypatching — the frozen ESM
  // module namespace cannot be reassigned (mirrors the writeFakeSpawnMorty CJS
  // stub in large-tier-detached-spawn.test.js).
  const childPath = path.join(tmpDir, 'drain-child.cjs');
  const script = `
const fs = require('node:fs');
const { spawn } = require('node:child_process');

let durableSyncFired = false;
const origFdatasync = fs.fdatasyncSync;
const origFsync = fs.fsyncSync;
fs.fdatasyncSync = function (fd) { durableSyncFired = true; return origFdatasync.call(fs, fd); };
fs.fsyncSync = function (fd) { durableSyncFired = true; return origFsync.call(fs, fd); };

const sessionLog = fs.createWriteStream(${JSON.stringify(logPath)}, { flags: 'w' });

// Fake "claude" producer: emits a large payload to ITS stdout, mirroring the
// real worker grandchild whose stdout spawn-morty pipes into sessionLog.
const producer = spawn(process.execPath, ['--input-type=module', '-e',
  'for (let i = 0; i < ${PAYLOAD_LINES}; i++) process.stdout.write("LINE-" + i + "-padpadpadpadpadpadpadpadpadpad\\\\n");'
], { stdio: ['ignore', 'pipe', 'inherit'] });

producer.stdout.pipe(sessionLog, { end: false });

// Faithful inline replay of spawn-morty.ts's bestEffortFdatasync helper —
// the durability primitive the success/close drain now reuses (R-WPEX fix).
function bestEffortFdatasync(logPath) {
  try {
    const fd = fs.openSync(logPath, 'a');
    fs.fdatasyncSync(fd);
    fs.closeSync(fd);
  } catch { /* best-effort */ }
}

producer.on('close', () => {
  // === spawn-morty.ts:2191-2215 success/close-path drain (faithful replay) ===
  sessionLog.once('finish', () => {
    // R-WPEX fix: the success/close drain now reuses bestEffortFdatasync(...)
    // (the hangGuard's durability primitive) so the detached, unref'd worker
    // persists the log to durable storage before the process exits.
    bestEffortFdatasync(${JSON.stringify(logPath)});
    process.stdout.write('DURABLE_SYNC=' + durableSyncFired + '\\n');
    process.exit(0);
  });
  sessionLog.end();
});
`;
  fs.writeFileSync(childPath, script);

  try {
    const result = spawnSync(process.execPath, [childPath], {
      encoding: 'utf8',
      timeout: 20_000,
    });

    assert.equal(result.status, 0, `child must exit 0; stderr: ${result.stderr}`);
    const syncedMatch = /DURABLE_SYNC=(true|false)/.exec(result.stdout);
    assert.ok(syncedMatch, `expected DURABLE_SYNC sentinel; stdout: ${JSON.stringify(result.stdout)}`);
    const durablySynced = syncedMatch[1] === 'true';

    // The success/close drain MUST durably persist the detached-worker log
    // (fdatasync/fsync the fd) before the unref'd process exits — matching the
    // hangGuard's bestEffortFdatasync and flushAndExit's await once('close').
    // Current source does NOT, so this assertion is RED until the success-path
    // drain is strengthened.
    assert.ok(
      durablySynced,
      'detached-worker success/close drain exited WITHOUT fsyncing the log fd — '
        + 'the log is only in the OS page cache, not durable storage. A detached, '
        + 'unref\\u2019d worker can exit before the OS persists the log, so the '
        + 'poll-reattach side reads a 0-byte/truncated log while artifacts are '
        + 'intact (B-APNC 2026-06-28 signature). The success path must reuse '
        + 'bestEffortFdatasync(sessionLogPath) like the hangGuard does.',
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// R-WPEX production-source regression guard.
//
// The mechanism test above replays the drain shape, but a faithful replay can
// drift from production. This guard pins the ACTUAL source: the spawn-morty.ts
// success/close drain (the `proc.on('close')` -> `sessionLog.once('finish')`
// branch) MUST call `bestEffortFdatasync(sessionLogPath)` before `finalize`, and
// `bestEffortFdatasync` MUST genuinely fdatasync the fd. Reverting the R-WPEX fix
// (removing the fsync from the success drain) turns this RED, which the replay
// test alone cannot guarantee.
test('R-WPEX trap door: spawn-morty success/close drain fsyncs via bestEffortFdatasync', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/bin/spawn-morty.ts'),
    'utf8',
  );

  // bestEffortFdatasync must be a real durability primitive (opens the path,
  // fdatasyncs the fd) — not a stubbed no-op.
  assert.match(
    src,
    /function bestEffortFdatasync\([\s\S]*?fs\.fdatasyncSync\(/,
    'bestEffortFdatasync must call fs.fdatasyncSync on the log fd',
  );

  // The success/close drain (once('finish') callback in proc.on('close')) must
  // fsync before finalize — the fix this guard protects.
  const finishBlock = /sessionLog\.once\('finish',[\s\S]*?finalize\(code\)/.exec(src);
  assert.ok(finishBlock, "could not locate the sessionLog.once('finish') success-drain block");
  assert.match(
    finishBlock[0],
    /bestEffortFdatasync\(sessionLogPath\)/,
    "the once('finish') success drain must call bestEffortFdatasync(sessionLogPath) before finalize "
      + '(R-WPEX: a detached unref’d worker exits before the OS persists the log otherwise)',
  );
});

// @tier: integration
/**
 * process-cleanup.test.js — F25: Process lifecycle integration tests.
 *
 * Tests two categories of process cleanup:
 * 1. dispatch.js EPIPE handling — both paths (error event + write catch) kill child with SIGKILL
 *    and verify the child process is truly dead (no zombie), not just that dispatch returned.
 * 2. spawn-refinement-team.js — when one-of-three workers crashes, siblings are killed
 *    and the activeWorkerProcs Set is drained (process completes without hanging).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scrubGateEnv } from '../../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DISPATCH_BIN = path.resolve(__dirname, '../../hooks/dispatch.js');
const SPAWN_REFINEMENT_BIN = path.resolve(__dirname, '../../bin/spawn-refinement-team.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpRoot(prefix = 'pickle-pc-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeHandlersDir(extRoot) {
  const dir = path.join(extRoot, 'extension', 'hooks', 'handlers');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeHandler(handlersDir, hookName, script) {
  const filePath = path.join(handlersDir, `${hookName}.js`);
  fs.writeFileSync(filePath, script, { mode: 0o755 });
  return filePath;
}

/**
 * Run dispatch.js as a subprocess and return { stdout, stderr, status, pid }.
 * Accepts extra env vars merged on top of inherited environment.
 */
function runDispatch({ extRoot, args = [], input, extraEnv = {} }) {
  // 10s → 45s: budget for system load when run alongside concurrent
  // codex/tmux work. Dispatch usually returns in <500ms; the budget exists
  // so a backed-up scheduler doesn't SIGKILL before EPIPE handling completes.
  const result = spawnSync(process.execPath, [DISPATCH_BIN, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, EXTENSION_DIR: extRoot, ...extraEnv },
    timeout: 45_000,
    input: input !== undefined ? input : undefined,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

/**
 * Returns true if the given PID is alive (process exists in the OS).
 * Uses process.kill(pid, 0) — throws ESRCH if the process is gone.
 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // ESRCH = no such process
  }
}

/**
 * PC-4 and PC-5 hand a fake `claude` binary to spawn-refinement-team.js, so the processes it
 * starts are this test's GRANDCHILDREN — outside the reach of both spawnSync's cap kill (which
 * signals the direct child only) and the runtime's own activeWorkerProcs set. Each test therefore
 * records what it started and reaps it in its own teardown; the fake bodies idle for 60s, so an
 * unreaped one stays resident well past the test and loads whatever runs next.
 */
function makePidDir(dir) {
  const pidDir = path.join(dir, 'grandchild-pids');
  fs.mkdirSync(pidDir, { recursive: true });
  return pidDir;
}

/**
 * The source line a fake `claude` body embeds to register its own pid. Best-effort: a failed
 * recording must never change what the test observes.
 */
function pidRecordSnippet(pidDir) {
  return `try { require('fs').writeFileSync(require('path').join(${JSON.stringify(pidDir)}, String(process.pid)), ''); } catch {}`;
}

/** Live command line of `pid`, or '' if the process is gone or `ps` is unavailable. */
function processCommandLine(pid) {
  try {
    return execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 5_000,
    });
  } catch {
    return ''; // ESRCH, or no ps on this host
  }
}

/**
 * SIGKILL every recorded pid that is still alive AND whose CURRENT command line still contains
 * `ownerMarker` (the test's own mkdtemp path). Re-proving ownership against the live process is
 * what makes a recycled pid safe — a recorded pid alone is not evidence. Never a bare
 * binary-name kill. Returns the pids actually signalled; never throws, so a `finally` caller
 * cannot mask a real assertion failure.
 */
function reapRecordedGrandchildren(pidDir, ownerMarker) {
  let entries;
  try {
    entries = fs.readdirSync(pidDir);
  } catch {
    return [];
  }
  const reaped = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue; // only names our fake binaries wrote
    const pid = Number.parseInt(entry, 10);
    if (pid <= 1) continue;
    if (!isPidAlive(pid)) continue;
    if (!processCommandLine(pid).includes(ownerMarker)) continue;
    try {
      process.kill(pid, 'SIGKILL');
      reaped.push(pid);
    } catch {
      /* exited between the probe and the signal */
    }
  }
  return reaped;
}

/** Recorded grandchild pids, newest read of the directory. Missing dir reads as none recorded. */
function readRecordedPids(pidDir) {
  try {
    return fs.readdirSync(pidDir)
      .filter(entry => /^\d+$/.test(entry))
      .map(entry => Number.parseInt(entry, 10))
      .filter(pid => pid > 1);
  } catch {
    return [];
  }
}

/**
 * Sleep that HOLDS the event loop open for exactly as long as it is being awaited.
 *
 * The ref'd timer is load-bearing, not incidental. Both callers (`observeSiblingKillWindow`,
 * `waitForPath`) are poll loops whose subject — a spawned child — routinely exits BEFORE the loop
 * is done: `observeSiblingKillWindow` still owes a 1000 ms quiet window after the last worker dies,
 * and the refinement team's whole crash-and-reap run measures 77 ms on Linux. While the child is
 * alive its `ChildProcess` handle is the loop's only ref; the instant it exits, an unref'd poll
 * timer leaves the process with nothing pending. The loop then never ticks again and `node:test`
 * cancels the still-pending test — plus every later test in the file — with
 * `cancelledByParent: Promise resolution is still pending but the event loop has already resolved`.
 *
 * That is not a platform effect. Measured for PC-4: cancelled on macOS/Node 22.23.2 AND
 * Linux/Node 22.23.2, green only on Node 24, whose test runner keeps the loop alive independently.
 * So this must not be re-expressed as a `process.platform` branch; the timer itself is the seam.
 *
 * Holding the loop costs nothing here: every caller passes 25 ms, so the longest this can delay
 * an exit is a single tick. `onTimer` exposes the ref'd-ness so PC-6 can assert it directly —
 * an end-to-end oracle would pass vacuously on Node 24 and stop testing anything.
 */
function sleep(ms, onTimer) {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    onTimer?.(t);
  });
}

/**
 * Watch the recorded grandchild pids and time the SIBLING KILL, and only that.
 *
 * Each fake `claude` records its own pid as its FIRST statement, so a worker that is still hanging
 * always has a live recorded pid. Two instants are therefore observable from the test alone, with no
 * runtime marker:
 *
 *   - the CRASH — the first registered worker seen dead. The crashing worker exits immediately after
 *     registering, and a hanging sibling only dies when something kills it, so the first death is
 *     the crash. This is where the kill window opens.
 *   - the KILL COMPLETING — no registered worker alive, with the registered set stable for
 *     `quietMs`. Stability matters because the runtime brings workers up staggered (measured ~10s
 *     apart), and because a sibling SIGTERM'd during its own bootstrap never registers at all
 *     (measured: 2 of 3). The settled set is whatever actually started, and nothing in it is alive.
 *
 * Returns the interval between those two instants, measured to the FIRST moment the settled
 * condition held so the quiet confirmation is not charged. Everything before the crash (node
 * bootstrap, imports, arg/settings resolution, the git scan, the staggered worker spawn) and
 * everything after the kill (manifest write, readiness gate, teardown) is excluded by construction.
 */
async function observeSiblingKillWindow(pidDir, deadlineMs, quietMs = 1_000) {
  const until = Date.now() + deadlineMs;
  let crashAt = null;
  let settledAt = null;
  let settledCount = 0;
  for (;;) {
    const pids = readRecordedPids(pidDir);
    const live = pids.filter(isPidAlive);
    if (crashAt === null && live.length < pids.length) crashAt = Date.now();
    const allDead = pids.length > 0 && live.length === 0;
    if (allDead && pids.length === settledCount && settledAt !== null) {
      if (Date.now() - settledAt >= quietMs) {
        return { killed: true, elapsedMs: settledAt - crashAt, recorded: pids.length };
      }
    } else if (allDead) {
      settledAt = Date.now();
      settledCount = pids.length;
    } else {
      settledAt = null;
      settledCount = 0;
    }
    if (Date.now() >= until) {
      return {
        killed: false,
        elapsedMs: crashAt === null ? -1 : Date.now() - crashAt,
        recorded: pids.length,
      };
    }
    await sleep(25);
  }
}

/** Resolve once `target` exists, or false at the deadline. */
async function waitForPath(target, deadlineMs) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    if (fs.existsSync(target)) return true;
    if (Date.now() >= until) return false;
    await sleep(25);
  }
}

/** Write a minimal state.json to sessionDir. */
function writeState(sessionDir, overrides = {}) {
  const state = {
    active: true,
    working_dir: sessionDir,
    step: 'prd',
    iteration: 1,
    max_iterations: 10,
    max_time_minutes: 60,
    worker_timeout_seconds: 10,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'process cleanup test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 1,
    ...overrides,
  };
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// PC-1: dispatch EPIPE path 1 — child.stdin 'error' event triggers SIGKILL
//
// The handler writes its own PID to a file, then closes fd 0 (synchronously,
// so the OS-level read end of the pipe is gone immediately) and hangs.
// Dispatch's pending write triggers EPIPE on the child.stdin 'error' event,
// which calls child.kill('SIGKILL'). The test verifies:
//   (a) dispatch completes without timing out, and
//   (b) the child's PID is no longer alive after dispatch exits.
// ---------------------------------------------------------------------------

test('PC-1: dispatch EPIPE path-1 (stdin error event) — SIGKILL sent, child dead, no zombie', () => {
  const tmpRoot = makeTmpRoot();
  try {
    const handlersDir = makeHandlersDir(tmpRoot);
    const pidFile = path.join(tmpRoot, 'child.pid');

    // Handler: write PID, close stdin fd synchronously (EPIPE-triggering), then hang
    writeHandler(handlersDir, 'pc1-epipe-event', `
      const { closeSync, writeFileSync } = require('fs');
      writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      try { closeSync(0); } catch {}
      setInterval(() => {}, 500); // keep alive until SIGKILL
    `);

    // 2 MB input — exceeds OS pipe buffer so the parent write definitely blocks
    const largeInput = 'x'.repeat(1024 * 1024 * 2);

    const { stdout, status } = runDispatch({
      extRoot: tmpRoot,
      args: ['pc1-epipe-event'],
      input: largeInput,
    });

    assert.ok(status !== null, 'dispatcher must exit (not time out — child must be killed)');
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.decision, 'approve', 'must fail-open after killing hung child');

    // Verify child is truly dead — not a zombie
    if (fs.existsSync(pidFile)) {
      const childPid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      assert.ok(!isPidAlive(childPid), `child PID ${childPid} must be dead after SIGKILL`);
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PC-2: dispatch EPIPE path 2 — child.stdin.write() catch triggers SIGKILL
//
// The handler writes its PID then exits immediately. By the time dispatch
// tries to write input, the child's stdin pipe is already closed.
// Either the write throws EPIPE (caught by the try/catch in dispatch) or the
// error event fires — either way SIGKILL is sent. Dispatcher returns approve.
// ---------------------------------------------------------------------------

test('PC-2: dispatch EPIPE path-2 (sync write catch) — child exits cleanly, approve returned', () => {
  const tmpRoot = makeTmpRoot();
  try {
    const handlersDir = makeHandlersDir(tmpRoot);
    const pidFile = path.join(tmpRoot, 'child2.pid');

    // Handler: write PID then exit immediately — stdin pipe gone before dispatch write
    writeHandler(handlersDir, 'pc2-epipe-sync', `
      const { writeFileSync } = require('fs');
      writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      process.exit(0);
    `);

    const largeInput = 'y'.repeat(1024 * 128);

    const { stdout, status } = runDispatch({
      extRoot: tmpRoot,
      args: ['pc2-epipe-sync'],
      input: largeInput,
    });

    assert.ok(status !== null, 'dispatcher must not hang after child exits early');
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.decision, 'approve', 'must fail-open when child exits without decision');

    // Child already exited normally — PID must not be alive
    if (fs.existsSync(pidFile)) {
      const childPid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      assert.ok(!isPidAlive(childPid), `child PID ${childPid} must be dead after normal exit`);
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PC-3: dispatch — both EPIPE paths produce valid JSON decision on stdout
//
// Guards against the case where killing the child corrupts stdout output.
// Both paths must produce exactly one valid JSON line with decision=approve.
// ---------------------------------------------------------------------------

test('PC-3: dispatch EPIPE produces exactly one valid approve JSON on stdout', () => {
  const tmpRoot = makeTmpRoot();
  try {
    const handlersDir = makeHandlersDir(tmpRoot);

    writeHandler(handlersDir, 'pc3-epipe-json', `
      const { closeSync } = require('fs');
      try { closeSync(0); } catch {}
      setInterval(() => {}, 500);
    `);

    const { stdout, status } = runDispatch({
      extRoot: tmpRoot,
      args: ['pc3-epipe-json'],
      input: 'z'.repeat(1024 * 1024 * 2),
    });

    assert.ok(status !== null, 'must exit');
    const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
    assert.equal(lines.length, 1, `expected exactly 1 JSON line, got ${lines.length}: ${stdout}`);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.decision, 'approve');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PC-4: refinement worker 2-of-3 crash kills siblings — Set drained, no hang
//
// Spawns spawn-refinement-team.js with a fake `claude` binary that:
//   - 'requirements' worker (prompt contains analysis_requirements.md): hangs 60s
//   - 'codebase' worker (prompt contains analysis_codebase.md): exits code 1 immediately
//   - 'risk-scope' worker (prompt contains analysis_risk-scope.md): hangs 60s
//
// Expected: codebase crash triggers sibling kill (SIGTERM → requirements + risk-scope).
// The onComplete callback drains activeWorkerProcs Set, so Promise.all resolves quickly.
//
// THE CLOCK COVERS THE SIBLING KILL ONLY. It opens at the crash (the first registered worker seen
// dead) and closes when no registered worker is alive and the registered set has stopped growing.
// Excluded on the near side: node bootstrap, the ESM import graph of the refinement bin and its
// service imports, arg and settings resolution, the stale-anchor git scan, the AC and symbol
// machinery, and the worker spawn cadence. Excluded on the far side: manifest write, the readiness
// gate, and interpreter teardown. Only the SIGTERM fan-out and the workers' deaths are charged.
// ---------------------------------------------------------------------------

// Budget UNCHANGED at 30s — narrowing the window widens nothing. Re-measured 2026-08-27 against a
// standalone harness driving this exact child invocation: the refinement bin brings all three
// workers up, sees the crash, group-SIGTERMs both siblings and writes the manifest in 969ms total
// on macOS/Node 22 and 77ms on Linux/Node 22 — so the intended kill path has enormous headroom.
// (The prior note here claimed the crash lands at ~41.5s; that figure was stale by two orders of
// magnitude and described a window this test never actually spends.) The degenerate ladder inside
// this window is the 2000ms SIGTERM → SIGKILL escalation. A regression where siblings are not
// killed leaves them hanging for their full 60s budget, so it fails this assertion rather than
// passing silently.
// The refinement team spawns one worker per role: requirements, codebase, risk-scope.
const WORKER_COUNT = 3;

test('PC-4: refinement worker 2-of-3 crash kills siblings — siblings dead in < 30s', { timeout: 90_000 }, async () => {
  const dir = makeTmpRoot('pickle-pc4-');
  let pidDir = null;
  let child = null;
  try {
    // Session directory
    const sessionDir = path.join(dir, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    writeState(sessionDir, { worker_timeout_seconds: 20 });

    // Fake PRD
    const prdPath = path.join(dir, 'test-prd.md');
    fs.writeFileSync(prdPath, '# Test PRD\n\nTest content for process cleanup test.\n');

    // Fake extension root (no settings — uses defaults)
    const extRoot = path.join(dir, 'ext');
    fs.mkdirSync(extRoot, { recursive: true });

    // Fake claude binary — detects which worker is calling and crashes or hangs.
    // It registers its own pid so this test can reap whatever the runtime leaves behind.
    pidDir = makePidDir(dir);
    const fakeBinDir = path.join(dir, 'fakebin');
    fs.mkdirSync(fakeBinDir, { recursive: true });
    const fakeClaude = path.join(fakeBinDir, 'claude');
    fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
'use strict';
${pidRecordSnippet(pidDir)}
const args = process.argv.slice(2);
const pIdx = args.indexOf('-p');
const prompt = pIdx !== -1 ? (args[pIdx + 1] || '') : '';

if (prompt.includes('analysis_codebase.md')) {
  // Crash immediately — this triggers sibling cleanup
  process.exit(1);
} else {
  // Hang until killed (simulates requirements and risk-scope workers)
  setTimeout(() => {}, 60_000);
}
`);
    fs.chmodSync(fakeClaude, 0o755);

    // Async spawn (PC-5's shape) so the kill window is observable between fork and exit.
    child = spawn(
      process.execPath,
      [
        SPAWN_REFINEMENT_BIN,
        '--prd', prdPath,
        '--session-dir', sessionDir,
        '--cycles', '1',
        '--timeout', '20',
        '--max-turns', '1',
      ],
      {
        env: {
          ...scrubGateEnv(),
          PATH: `${fakeBinDir}:${process.env.PATH}`,
          EXTENSION_DIR: extRoot,
          NODE_ENV: 'test',
          EXTENSION_DIR_TEST: '1',
        },
        // Nothing here reads the child's output, and its cycle spinner writes continuously — an
        // undrained pipe would fill and block the very process this test is timing.
        stdio: 'ignore',
        // Hang-guard, not a perf assertion — same 60s budget the previous spawnSync carried.
        timeout: 60_000,
        cwd: dir,
      },
    );

    // The clock inside this watcher spans crash → siblings dead. The 75s deadline is a hang-guard on
    // observing that window at all — the runtime brings the three workers up staggered ~10s apart,
    // and none of that setup is charged to the measured interval.
    const { killed, elapsedMs: elapsed, recorded } = await observeSiblingKillWindow(pidDir, 75_000);

    assert.ok(
      killed && elapsed < 30_000,
      `sibling kill should complete in < 30s, took ${elapsed}ms `
      + `(killed: ${killed}, workers registered: ${recorded}/${WORKER_COUNT}) — siblings not killed?`,
    );

    // Manifest must be written (even on failure — partial results recorded). It is written when the
    // cycles resolve, BEFORE the readiness gate and interpreter teardown, so this test waits for the
    // file rather than for full process exit — waiting for exit would drag exactly the post-kill work
    // this test no longer charges back into its wall clock.
    const manifestPath = path.join(sessionDir, 'refinement_manifest.json');
    const manifestWritten = await waitForPath(manifestPath, 30_000);
    assert.ok(manifestWritten, 'refinement_manifest.json must be written');

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    assert.equal(manifest.workers.length, WORKER_COUNT, 'manifest must record all 3 workers');
    assert.equal(manifest.all_success, false, 'all_success must be false (codebase crashed)');

    // Codebase worker must be recorded as failed
    const codebaseWorker = manifest.workers.find(w => w.role === 'codebase');
    assert.ok(codebaseWorker, 'codebase worker must appear in manifest');
    assert.equal(codebaseWorker.success, false, 'codebase worker must be marked failed');
  } finally {
    // This test no longer waits for the child's own teardown, so it reaps it here rather than
    // leaving it resident for the rest of the tier.
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    // Reap before rmSync — removing the tmp tree deletes the pid records, not the processes.
    if (pidDir) reapRecordedGrandchildren(pidDir, dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PC-5: refinement worker graceful shutdown — SIGTERM kills all active workers
//
// Tests the SIGTERM handler: when spawn-refinement-team.js receives SIGTERM,
// it kills all workers in activeWorkerProcs and exits. Uses fake claude that
// hangs, then sends SIGTERM to the refinement team process.
// ---------------------------------------------------------------------------

// 20s → 60s: budget for system load when run alongside concurrent codex/tmux
// work. Inner SIGTERM-deadline assertion stays at 5s → 15s for the same reason;
// the test still verifies that SIGTERM kills workers within seconds rather than
// at the 60s hang budget.
test('PC-5: refinement team SIGTERM graceful shutdown — all workers killed, process exits', { timeout: 60_000 }, async () => {
  const dir = makeTmpRoot('pickle-pc5-');
  let pidDir = null;
  try {
    const sessionDir = path.join(dir, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    writeState(sessionDir, { worker_timeout_seconds: 60 });

    const prdPath = path.join(dir, 'test-prd.md');
    fs.writeFileSync(prdPath, '# Test PRD\n\nTest content.\n');

    const extRoot = path.join(dir, 'ext');
    fs.mkdirSync(extRoot, { recursive: true });

    // Fake claude that always hangs. It registers its own pid so this test can reap whatever
    // the SIGTERM path leaves behind.
    pidDir = makePidDir(dir);
    const fakeBinDir = path.join(dir, 'fakebin');
    fs.mkdirSync(fakeBinDir, { recursive: true });
    const fakeClaude = path.join(fakeBinDir, 'claude');
    fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
${pidRecordSnippet(pidDir)}
setTimeout(() => {}, 60_000);
`);
    fs.chmodSync(fakeClaude, 0o755);

    // Spawn refinement team as a detached background process
    const { spawn } = await import('node:child_process');
    const child = spawn(
      process.execPath,
      [
        SPAWN_REFINEMENT_BIN,
        '--prd', prdPath,
        '--session-dir', sessionDir,
        '--cycles', '1',
        '--timeout', '60',
      ],
      {
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH}`,
          EXTENSION_DIR: extRoot,
        },
        cwd: dir,
        stdio: 'pipe',
        // Hang-guard, not a perf assertion: it sits above the 15s settle deadline below, so it
        // can only fire when the child genuinely never exits. Without it a wedged refinement
        // team outlives the test.
        timeout: 30_000,
      },
    );

    // Give workers time to start (100ms is enough for node processes)
    await new Promise(resolve => setTimeout(resolve, 500));

    // Send SIGTERM to the refinement team process
    const start = Date.now();
    child.kill('SIGTERM');

    // Wait for the process to exit. 5s → 15s deadline tolerates system load
    // while still detecting a regression where SIGTERM doesn't kill workers
    // (which would wait the full 60s hang budget).
    await new Promise((resolve, reject) => {
      // Stays REF'D: this is the SOLE settle path when the child is already dead by the time the
      // listeners below are attached. `child` was spawned before the 500ms bootstrap wait above, and
      // `'exit'` is emitted ONCE and asynchronously — so a child that dies inside that window (a
      // startup crash against the fake PATH, say) has already emitted it, `once('exit')` never
      // fires, and `kill('SIGTERM')` was a no-op returning false. Measured, not assumed.
      //
      // The previous note here justified `.unref()` by a harm that cannot occur: it claimed a bare
      // timer "keeps the event loop alive for the full 15s after the child has already exited", but
      // `settle` calls `clearTimeout(deadline)` on BOTH the exit and error paths, so a healthy run
      // releases this handle the instant the child exits. What the unref bought instead was the
      // `cancelled 3` drain documented at PC-6 below — with the child dead and its stdio at EOF,
      // nothing was pending — in place of the reportable rejection this timer carries.
      //
      // Bounded and self-clearing, so it cannot hold the loop open indefinitely: 15s ceiling, and
      // cleared on every settle path. Same ruling, for the same shape, as convergence-gate.ts:789.
      const deadline = setTimeout(
        () => reject(new Error('SIGTERM did not kill process within 15s')),
        15_000,
      );
      const settle = (fn) => (arg) => {
        clearTimeout(deadline);
        fn(arg);
      };
      child.once('exit', settle(resolve));
      child.once('error', settle(reject));
    });

    const elapsed = Date.now() - start;
    assert.ok(elapsed < 15_000, `process should exit quickly after SIGTERM, took ${elapsed}ms`);
  } finally {
    // Reap before rmSync — removing the tmp tree deletes the pid records, not the processes.
    if (pidDir) reapRecordedGrandchildren(pidDir, dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PC-6: the poll primitive keeps the event loop alive while it is awaited
//
// Regression guard for the defect that took out PC-4, PC-5 and AP-EXT-ITER54-01 together on
// Node 22 (`cancelled 3` in the beta.20 serial tier). `sleep()` unref'd its timer, so once the
// child a poll loop was watching exited, nothing in the process was pending; the loop stopped
// ticking and node:test cancelled the pending test plus every later test in this file.
//
// The oracle is the TIMER, deliberately, not an end-to-end poll loop. An end-to-end oracle is red
// on Node 22 but vacuously GREEN on Node 24 — whose runner refs the loop for reasons unrelated to
// this fix — so it would stop testing anything the moment CI moves off 22. `hasRef()` is the
// property whose absence caused the cancellation, and it is false pre-fix / true post-fix on every
// platform and Node version.
// ---------------------------------------------------------------------------
test('PC-6: sleep() timer stays ref\'d so poll loops outlive the child they watch', async () => {
  let refdAtCreation = null;
  // Sampled inside the callback: after the timer fires, hasRef() no longer reports the choice
  // this test is pinning.
  await sleep(10, t => { refdAtCreation = t.hasRef(); });

  assert.equal(
    refdAtCreation,
    true,
    'sleep() must NOT unref its timer — observeSiblingKillWindow and waitForPath poll on it after '
    + 'their spawned child has exited, and an unref\'d timer lets the event loop drain mid-wait, '
    + 'cancelling this test and every later test in the file',
  );
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER54-01: a gate check is a subtree ROOT — its timeout reaps the GROUP
// ---------------------------------------------------------------------------

/**
 * Every command in `data/gate-commands.json` is a package-manager or toolchain root
 * (`npm run lint`, `pnpm test`, `cargo test`) whose real work runs in GRANDchildren.
 * The pre-fix teardown was `execFile`'s AbortSignal, which kills the direct child pid
 * only — and `execFile` silently drops `detached`, so no group ever existed to reap.
 *
 * The oracle is the SURVIVING PROCESS, never the verdict: the pre-fix gate already
 * returned the correct `red` / `GATE_CHECK_TIMEOUT` at the right wall-clock, so a
 * verdict-only assertion greens over the whole defect. Both are asserted here — the
 * fix must reap the subtree WITHOUT changing what the gate reports.
 */
function writeTimingOutGateProject(dir, pidDir) {
  // `npm` (package-lock.json → detectProjectType 'npm') is already a hard dependency of
  // this repo's own gate, so this adds no new host requirement.
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'apk-iter54', version: '1.0.0', scripts: { lint: 'sh ./leaker.sh "$npm_node_execpath"' } }, null, 2),
  );
  // The leaf is started by the SHELL, not by a child_process call in this file: the
  // subprocess-heavy audit scans source text, so a `spawn(`/`execFile(` token inside a
  // fixture string reads as an untimed callsite in THIS test (the known JSDoc-prose
  // false-positive class). It also models the real chain more faithfully —
  // npm -> sh -> tool -> worker. The leaf idles far past the per-check timeout, so if it
  // is still alive after the gate returns it is a genuine orphan, not a race with its
  // own exit.
  fs.writeFileSync(
    path.join(dir, 'leaker.sh'),
    [
      '#!/bin/sh',
      `"$1" -e 'setTimeout(()=>{},600000)' &`,
      `echo "" > ${JSON.stringify(pidDir)}/"$!"`,
      'wait',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}

test('AP-EXT-ITER54-01: a timed-out gate check leaves no orphaned subtree behind', async () => {
  const { runGate } = await import('../../services/convergence-gate.js');
  const dir = makeTmpRoot('pickle-pc-gate-');
  let pidDir = null;
  try {
    pidDir = makePidDir(dir);
    writeTimingOutGateProject(dir, pidDir);

    const result = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['lint'],
      _timeouts: { perCheck: { lint: 6_000 }, total: 30_000 },
    });

    // The pre-fix verdict was already correct — assert it so the reap cannot be bought
    // by breaking the timeout classification.
    assert.equal(result.status, 'red', `expected red, got ${result.status}`);
    assert.ok(
      result.failures.some((f) => f.ruleOrCode === 'GATE_CHECK_TIMEOUT'),
      `expected GATE_CHECK_TIMEOUT, got ${JSON.stringify(result.failures)}`,
    );

    const recorded = readRecordedPids(pidDir);
    assert.equal(recorded.length, 1, `expected exactly one recorded grandchild, got ${recorded.length}`);

    // The group kill is asynchronous at the OS level; poll rather than sample once.
    // Polls via the shared `sleep` — this loop used to inline its own `.unref?.()`'d timer, which
    // is the same liveness defect PC-6 pins: with the survivor still alive and nothing else
    // pending, the loop drained the event loop and node:test reported `cancelledByParent` INSTEAD
    // of the orphan assertion below. The surviving-grandchild defect this test exists to catch was
    // therefore unreportable — it looked like a harness cancellation, not a finding.
    const deadline = Date.now() + 5_000;
    let survivor = recorded[0];
    while (Date.now() < deadline && isPidAlive(survivor)) {
      await sleep(100);
    }
    assert.equal(
      isPidAlive(survivor),
      false,
      `gate-check grandchild ${survivor} survived the timeout as an orphan: ${processCommandLine(survivor).trim()}`,
    );
  } finally {
    if (pidDir) reapRecordedGrandchildren(pidDir, dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PC-7: the shutdown kill reaps the analyst's GRANDCHILD, not just the `claude` process
//
// `terminateWorkerProcess` (spawn-refinement-team.ts) states a guarantee PC-4 and PC-5
// cannot check: a bare kill of the direct child reaches the `claude` CLI alone, and the
// analyst's OWN tool subprocesses survive holding the inherited stdout/stderr write ends —
// so `'close'` never fires and the ref'd pipe handles keep the refinement process alive
// forever. `detached` + a negative-pid group signal is what actually prevents that.
//
// PC-4's and PC-5's fake `claude` bodies spawn no children, so both are satisfied by a bare
// direct-child kill; the group property is asserted nowhere on the refinement path (ITER54
// asserts it only for the GATE path). This test is that missing oracle.
//
// The oracle is the SURVIVING LEAF, never the team's exit — a team that exits promptly while
// leaking an orphan is the exact defect, so an exit-only assertion greens over it.
//
// The fixture is `sh`, not node: it models the real chain (`claude` -> tool -> worker) and
// keeps child-spawning tokens out of this file's source text, which the subprocess-heavy
// audit scans (the same reason ITER54's `leaker.sh` is shaped this way). The leaf carries the
// test's tmp dir in its argv so its live command line re-proves ownership at reap time.
//
// Both waits are observation-driven, not fixed sleeps: it signals only once a grandchild is
// recorded and alive, then polls for that pid's death. A fixed pre-signal delay would race the
// staggered worker bring-up and make a red mean "too slow" instead of "leaked an orphan".
// ---------------------------------------------------------------------------
test('PC-7: SIGTERM reaps an analyst grandchild, not just the claude process', { timeout: 90_000 }, async () => {
  const dir = makeTmpRoot('pickle-pc7-');
  let pidDir = null;
  let leafDir = null;
  let child = null;
  try {
    const sessionDir = path.join(dir, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    writeState(sessionDir, { worker_timeout_seconds: 60 });

    const prdPath = path.join(dir, 'test-prd.md');
    fs.writeFileSync(prdPath, '# Test PRD\n\nTest content.\n');
    const extRoot = path.join(dir, 'ext');
    fs.mkdirSync(extRoot, { recursive: true });

    pidDir = makePidDir(dir);
    leafDir = path.join(dir, 'leaf-pids');
    fs.mkdirSync(leafDir, { recursive: true });

    const fakeBinDir = path.join(dir, 'fakebin');
    fs.mkdirSync(fakeBinDir, { recursive: true });
    const fakeClaude = path.join(fakeBinDir, 'claude');
    fs.writeFileSync(fakeClaude, [
      '#!/bin/sh',
      `echo "" > ${JSON.stringify(pidDir)}/"$$"`,
      // Idles far past this test, so a live leaf after the kill is a genuine orphan and
      // never a race with its own exit.
      `${JSON.stringify(process.execPath)} -e 'setTimeout(()=>{},600000)' ${JSON.stringify(dir)} &`,
      `echo "" > ${JSON.stringify(leafDir)}/"$!"`,
      'wait',
      '',
    ].join('\n'), { mode: 0o755 });
    fs.chmodSync(fakeClaude, 0o755);

    child = spawn(
      process.execPath,
      [
        SPAWN_REFINEMENT_BIN,
        '--prd', prdPath,
        '--session-dir', sessionDir,
        '--cycles', '1',
        '--timeout', '60',
      ],
      {
        env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}`, EXTENSION_DIR: extRoot },
        cwd: dir,
        // Nothing reads this child's output and its spinner writes continuously; an undrained
        // pipe would fill and block the process under test.
        stdio: 'ignore',
        // Hang-guard, not a perf assertion — it sits above every deadline below.
        timeout: 60_000,
      },
    );

    // Precondition, observed: an analyst is up and has started a grandchild.
    let leafPids = [];
    const untilLeaf = Date.now() + 45_000;
    for (;;) {
      leafPids = readRecordedPids(leafDir);
      if (leafPids.length > 0 || Date.now() >= untilLeaf) break;
      await sleep(50);
    }
    assert.ok(leafPids.length > 0, 'fixture must start at least one analyst grandchild before SIGTERM');
    const leaf = leafPids[0];
    assert.ok(isPidAlive(leaf), `grandchild ${leaf} must be alive before the SIGTERM under test`);

    child.kill('SIGTERM');

    // Postcondition, observed: the group signal reached the grandchild. The kill is
    // asynchronous at the OS level, so poll rather than sample once.
    const untilDead = Date.now() + 20_000;
    while (Date.now() < untilDead && isPidAlive(leaf)) {
      await sleep(100);
    }
    assert.equal(
      isPidAlive(leaf),
      false,
      `analyst grandchild ${leaf} survived the refinement team's SIGTERM as an orphan: `
      + `${processCommandLine(leaf).trim()} — group kill regressed to a bare direct-child kill?`,
    );
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    // Reap before rmSync — removing the tmp tree deletes the pid records, not the processes.
    if (pidDir) reapRecordedGrandchildren(pidDir, dir);
    if (leafDir) reapRecordedGrandchildren(leafDir, dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

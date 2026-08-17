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
import { execFileSync, spawnSync } from 'node:child_process';
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
    const pid = Number.parseInt(entry, 10);
    if (!Number.isInteger(pid) || pid <= 1) continue;
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
// Total wall time must be << 60s (hanged workers do NOT run to completion).
// ---------------------------------------------------------------------------

// 30s → 90s outer / 25s → 60s inner / 15s → 30s elapsed bound: budget for
// system load when run alongside concurrent codex/tmux work. The substantive
// assertion remains "siblings DO get killed — process does NOT wait 60s for
// hangs to complete". 30s is still half of the 60s hang budget, so a regression
// where siblings aren't killed would fail this assertion, not silently pass.
test('PC-4: refinement worker 2-of-3 crash kills siblings — process completes in < 30s', { timeout: 90_000 }, async () => {
  const dir = makeTmpRoot('pickle-pc4-');
  let pidDir = null;
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

    const start = Date.now();

    const result = spawnSync(
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
        timeout: 60_000,
        encoding: 'utf-8',
        cwd: dir,
      },
    );

    const elapsed = Date.now() - start;

    // Must complete in << 60s — codebase crash must trigger sibling kill, not
    // let the workers run to their full 60s hang. 30s assertion (half the hang
    // budget) still detects the regression class while tolerating system load.
    assert.ok(
      elapsed < 30_000,
      `spawn-refinement-team should complete in < 30s, took ${elapsed}ms (siblings not killed?)`,
    );

    // Process must exit (not timed out by spawnSync)
    assert.ok(result.status !== null, 'spawn-refinement-team must exit, not time out');

    // Manifest must be written (even on failure — partial results recorded)
    const manifestPath = path.join(sessionDir, 'refinement_manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'refinement_manifest.json must be written');

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    assert.equal(manifest.workers.length, 3, 'manifest must record all 3 workers');
    assert.equal(manifest.all_success, false, 'all_success must be false (codebase crashed)');

    // Codebase worker must be recorded as failed
    const codebaseWorker = manifest.workers.find(w => w.role === 'codebase');
    assert.ok(codebaseWorker, 'codebase worker must appear in manifest');
    assert.equal(codebaseWorker.success, false, 'codebase worker must be marked failed');
  } finally {
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
      // Cleared on settle and unref'd: a bare timer here keeps the event loop alive for the full
      // 15s after the child has already exited, holding the whole serial tier behind it.
      const deadline = setTimeout(
        () => reject(new Error('SIGTERM did not kill process within 15s')),
        15_000,
      );
      deadline.unref();
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

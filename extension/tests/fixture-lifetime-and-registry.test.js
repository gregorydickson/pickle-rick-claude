// @tier: fast
/**
 * Ticket 7011cd90: sigterm-ignoring-sleeper.js self-terminates on a bounded
 * lifetime (env-overridable, falls back to the compiled default on
 * absent/garbage input) and registers its own PID in a run-scoped registry
 * file (also env-gated, best-effort, existing callers unaffected when unset).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, 'fixtures/sigterm-ignoring-sleeper.js');

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

test('fixture self-exits unaided once its env-set lifetime bound elapses', async () => {
  const child = spawn(process.execPath, [FIXTURE], {
    stdio: 'ignore',
    env: { ...process.env, PICKLE_FIXTURE_MAX_LIFETIME_MS: '300' },
  });
  try {
    await waitFor(() => !isAlive(child.pid), 5_000, 'fixture exited unaided past its 300ms bound');
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

test('fixture falls back to the compiled default when the lifetime env is absent or garbage', async () => {
  const children = [
    spawn(process.execPath, [FIXTURE], { stdio: 'ignore', env: { ...process.env } }),
    spawn(process.execPath, [FIXTURE], {
      stdio: 'ignore',
      env: { ...process.env, PICKLE_FIXTURE_MAX_LIFETIME_MS: 'not-a-number' },
    }),
  ];
  try {
    // Neither should have self-exited within a window far below the 120s default.
    await new Promise(r => setTimeout(r, 500));
    for (const child of children) {
      assert.ok(isAlive(child.pid), `pid=${child.pid} must still be alive under the default bound`);
    }
  } finally {
    for (const child of children) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
});

test('fixture appends its PID to the run-scoped registry when the env var is set', async () => {
  const registryPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-registry-')), 'pids.txt');
  const child = spawn(process.execPath, [FIXTURE], {
    stdio: 'ignore',
    env: { ...process.env, PICKLE_FIXTURE_MAX_LIFETIME_MS: '300', PICKLE_FIXTURE_PID_REGISTRY: registryPath },
  });
  try {
    await waitFor(() => !isAlive(child.pid), 5_000, 'fixture exited unaided past its bound');
    const lines = fs.readFileSync(registryPath, 'utf-8').trim().split('\n');
    assert.ok(lines.includes(String(child.pid)), `registry must contain spawned pid=${child.pid}; got: ${lines}`);
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

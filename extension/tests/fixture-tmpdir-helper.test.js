// @tier: fast
/**
 * Ticket 63463c5e (D6, R-ORCG): the shared fixture-tempdir helper
 * (`tests/helpers/fixture-tmpdir.js`). Mirrors the three-part crash-surviving net proven in
 * `fixture-lifetime-and-registry.test.js` (D1): a startup sweep for SIGKILL/OOM,
 * `process.on('exit')` for cancel/throw, and `after()` for a normal end or a per-test
 * timeout — each covers a death the others cannot. Unlike D1's PID registry, a directory has
 * no liveness signal of its own, so staleness here is decided by the OWNING PROCESS's
 * liveness (one registry file per pid, no cross-process writes, no locking needed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkFixtureTmpDir, cleanupOwnedFixtureDirs, reapPreviousRunFixtureDirs } from './helpers/fixture-tmpdir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_DIR = path.join(os.tmpdir(), 'pickle-fixture-tmpdir-registry');

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('mkFixtureTmpDir creates a real directory tracked by the current process', () => {
  const dir = mkFixtureTmpDir('pickle-fixture-helper-test-');
  try {
    assert.ok(fs.existsSync(dir), 'the directory must exist immediately');
    assert.ok(fs.statSync(dir).isDirectory());
    const registryPath = path.join(REGISTRY_DIR, `${process.pid}.json`);
    assert.ok(fs.existsSync(registryPath), 'this process must have its own registry file');
    const recorded = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    assert.ok(recorded.includes(dir), 'the created dir must be recorded in the own-pid registry');
  } finally {
    cleanupOwnedFixtureDirs();
  }
});

test('cleanupOwnedFixtureDirs removes every owned directory and its own registry file', () => {
  const dir = mkFixtureTmpDir('pickle-fixture-helper-test-');
  assert.ok(fs.existsSync(dir));
  cleanupOwnedFixtureDirs();
  assert.ok(!fs.existsSync(dir), 'the directory must be gone after cleanup');
  const registryPath = path.join(REGISTRY_DIR, `${process.pid}.json`);
  assert.ok(!fs.existsSync(registryPath), 'the own-pid registry file must be gone after cleanup');
});

test('reapPreviousRunFixtureDirs does NOT sweep a directory owned by a still-alive pid', () => {
  // Negative control: a live sibling's fixtures must never be swept, mirroring the
  // process-group hazard D1 flags for its own PID registry.
  const liveDir = mkFixtureTmpDir('pickle-fixture-helper-live-');
  try {
    assert.ok(isAlive(process.pid), 'sanity: this process is alive');
    reapPreviousRunFixtureDirs();
    assert.ok(fs.existsSync(liveDir), 'a directory owned by a live pid must survive the sweep');
  } finally {
    cleanupOwnedFixtureDirs();
  }
});

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

test('D6: a dead owner\'s fixture directory survives SIGKILL, then is reaped by the startup sweep', async () => {
  const helperPath = path.join(__dirname, 'helpers', 'fixture-tmpdir.js');
  const script = `
    import { mkFixtureTmpDir } from ${JSON.stringify(helperPath)};
    const dir = mkFixtureTmpDir('pickle-fixture-helper-killed-');
    process.stdout.write(dir + '\\n');
    setInterval(() => {}, 1000);
  `;
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-fixture-helper-scriptdir-'));
  const scriptPath = path.join(scriptDir, 'child.mjs');
  fs.writeFileSync(scriptPath, script);

  const child = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'inherit'], timeout: 30_000 });

  let killedDir = '';
  try {
    // Block until the child reports the directory it created — no process.on('exit')/
    // after() has run for the CHILD yet at this point.
    let buf = '';
    child.stdout.on('data', (chunk) => { buf += chunk.toString(); });
    await waitFor(() => buf.includes('\n'), 10_000, 'child reported its fixture directory');
    killedDir = buf.trim();
    assert.ok(killedDir.length > 0, 'the child must have reported a created directory');
    assert.ok(fs.existsSync(killedDir), 'the directory must exist right after creation');

    // SIGKILL bypasses process.on('exit') entirely — neither of the other two nets fires.
    child.kill('SIGKILL');
    await waitFor(() => !isAlive(child.pid), 5000, 'child process actually dead');
    assert.ok(fs.existsSync(killedDir), 'SIGKILL must leave the directory behind — this is the abnormal-termination case');

    const registryPath = path.join(REGISTRY_DIR, `${child.pid}.json`);
    assert.ok(fs.existsSync(registryPath), 'the killed child\'s registry file must survive the kill too');

    // The THIRD net: a fresh startup sweep (this process, a different pid) reaps it.
    reapPreviousRunFixtureDirs();
    assert.ok(!fs.existsSync(killedDir), 'the startup sweep must reap a dead owner\'s directory');
    assert.ok(!fs.existsSync(registryPath), 'the startup sweep must also remove the dead owner\'s registry file');
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
    if (killedDir) { try { fs.rmSync(killedDir, { recursive: true, force: true }); } catch { /* already gone */ } }
    fs.rmSync(scriptDir, { recursive: true, force: true });
  }
});

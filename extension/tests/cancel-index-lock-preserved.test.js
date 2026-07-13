// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANCEL_BIN = path.resolve(__dirname, '../bin/cancel.js');
const CANCEL_SRC = path.resolve(__dirname, '../src/bin/cancel.ts');

function makeTmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-piwg4-')));
}

function setupSession(extRoot) {
  const workingDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-piwg4-repo-')));
  fs.mkdirSync(path.join(workingDir, '.git'), { recursive: true });

  const sessionDir = path.join(extRoot, 'sessions', '2026-05-14-piwg4test');
  fs.mkdirSync(sessionDir, { recursive: true });
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    active: true,
    working_dir: workingDir,
    step: 'research',
    iteration: 1,
    schema_version: 3,
    pid: process.pid,
    started_at: new Date().toISOString(),
  }, null, 2));
  fs.writeFileSync(path.join(extRoot, 'current_sessions.json'), JSON.stringify({ [workingDir]: sessionDir }, null, 2));
  return { sessionDir, workingDir, statePath };
}

function runCancel(extRoot, cwd) {
  const env = { ...process.env, PICKLE_DATA_ROOT: extRoot };
  return spawnSync('node', [CANCEL_BIN], { cwd, env, encoding: 'utf-8', timeout: 30_000 });
}

function readActivityEvents(extRoot) {
  const activityDir = path.join(extRoot, 'activity');
  if (!fs.existsSync(activityDir)) return [];
  const events = [];
  for (const f of fs.readdirSync(activityDir).filter((n) => n.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(activityDir, f), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* ignore malformed lines */ }
    }
  }
  return events;
}

// The lock git owns is never ours to remove. git records no holder pid and releases
// index.lock by close()-then-rename(), so a probe that reads "unheld" cannot prove
// "unowned" — inside git's close→rename window a live git still owns a lock no probe
// can see. Removing it there lets a second git take the same lock: two writers in the
// index critical section. cancel reports; it does not delete.

test('cancel preserves .git/index.lock even when it looks perfectly abandoned (no holder, within the old window)', () => {
  const extRoot = makeTmpRoot();
  const { workingDir, statePath } = setupSession(extRoot);
  const lockPath = path.join(workingDir, '.git', 'index.lock');

  // The exact input the deleted cleanup path unlinked: no live holder, and an mtime
  // just BEFORE the session's last activity (so the old relative-mtime window passed).
  fs.writeFileSync(lockPath, 'lock-content');
  const stateMtime = fs.statSync(statePath).mtimeMs;
  fs.utimesSync(lockPath, new Date(stateMtime - 30_000), new Date(stateMtime - 30_000));

  const result = runCancel(extRoot, workingDir);
  assert.strictEqual(result.status, 0, `cancel exit non-zero: ${result.stderr || result.stdout}`);

  assert.strictEqual(fs.existsSync(lockPath), true, 'cancel must NOT remove the lock');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf-8'), 'lock-content', 'lock content untouched');
});

test('cancel reports the leftover lock: warns with the remedy and emits stale_index_lock_detected', () => {
  const extRoot = makeTmpRoot();
  const { workingDir } = setupSession(extRoot);
  const lockPath = path.join(workingDir, '.git', 'index.lock');
  fs.writeFileSync(lockPath, '');

  const result = runCancel(extRoot, workingDir);
  assert.strictEqual(result.status, 0, `cancel exit non-zero: ${result.stderr || result.stdout}`);

  assert.match(result.stderr, /still exists/, 'warns that the lock is still there');
  assert.ok(result.stderr.includes(`rm -f ${lockPath}`), `stderr must name the remedy, got: ${result.stderr}`);

  const events = readActivityEvents(extRoot);
  const detected = events.find((e) => e.event === 'stale_index_lock_detected');
  assert.ok(detected, `expected stale_index_lock_detected, got: ${events.map((e) => e.event).join(', ')}`);
  assert.strictEqual(detected.gate_payload.path, lockPath, 'payload path matches');
  assert.ok(typeof detected.gate_payload.mtime === 'string', 'mtime is a string');
  assert.ok(Number.isInteger(detected.gate_payload.age_seconds), 'age_seconds is an integer');
  assert.ok(detected.gate_payload.age_seconds >= 0, 'age_seconds is non-negative');
});

test('cancel with no lock present emits no lock event', () => {
  const extRoot = makeTmpRoot();
  const { workingDir } = setupSession(extRoot);

  const result = runCancel(extRoot, workingDir);
  assert.strictEqual(result.status, 0, `cancel exit non-zero: ${result.stderr || result.stdout}`);

  const events = readActivityEvents(extRoot);
  assert.ok(!events.find((e) => e.event === 'stale_index_lock_detected'), 'no event without a lock');
});

test('cancel.ts holds no destructive path to index.lock: no unlink, no liveness probe', () => {
  const src = fs.readFileSync(CANCEL_SRC, 'utf-8');

  // The unlink is the bug. A probe cannot license it, so neither may return.
  assert.ok(!/unlinkSync\s*\(\s*lockPath/.test(src), 'cancel.ts must never unlinkSync the index.lock path');
  assert.ok(!/probeLockHolder/.test(src), 'the lock-holder probe must stay deleted — it only ever licensed the unlink');
  assert.ok(!/\blsof\b/.test(src), 'no lsof probe in cancel.ts');
  assert.ok(!/\bpgrep\b/.test(src), 'no pgrep probe in cancel.ts');
  assert.ok(!/spawnSync/.test(src), 'cancel.ts spawns no subprocess on the cancel path');
});

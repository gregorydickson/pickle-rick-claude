// @tier: fast
/**
 * Ticket 7011cd90: sigterm-ignoring-sleeper.js self-terminates on a bounded
 * lifetime (env-overridable, falls back to the compiled default on
 * absent/garbage input) and registers its own PID in a run-scoped registry
 * file (also env-gated, best-effort, existing callers unaffected when unset).
 *
 * D1 (R-ORCG): the fixtures spawned here are released through the SHARED
 * suite-level registry seam (`services/orphan-reaper.js`), not only through each
 * test's `finally`. A `finally` is unreachable on timeout / OOM / cancel, and
 * this fixture ignores SIGTERM by design (`fixtures/sigterm-ignoring-sleeper.js`),
 * so an abandoned instance outlives its runner for the whole of its 120s default
 * bound — and the two spawns below that exercise that default are the ones whose
 * assertion REQUIRES them to still be alive. Note also that the `timeout:` option
 * on these spawns is inert: Node's timeout kills with SIGTERM, which this fixture
 * ignores.
 *
 * The seam is three parts because each covers a different death, and no one part
 * covers another's: `after()` for a normal end or a test timeout,
 * `process.on('exit')` for cancel or an uncaught throw, and the startup sweep for
 * SIGKILL/OOM — under which neither callback runs at all.
 *
 * Every spawn passes `detached: true` so the child is its own process-group
 * leader (pgid === pid). The registry escalation signals a process GROUP
 * (`killProcessGroup(pid)` -> `kill(-pid)`), which addresses nothing when a child
 * merely inherits the runner's group: the registry would faithfully record four
 * pids it could never signal, burn the full grace+verify budget, and report zero
 * reaps while the orphans stayed alive.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  reapPreviousRunFixtures,
  initFixturePidRegistry,
  recordFixturePid,
  reapFixtures,
  reapFixturesSync,
} from '../services/orphan-reaper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, 'fixtures/sigterm-ignoring-sleeper.js');

// Suite-level net: see the identical block in
// integration/orphan-worker-reaper-tmp-prefix-drain.test.js for the rationale.
const FIXTURE_REGISTRY_DIR = path.join(os.tmpdir(), 'pickle-orphan-reaper-registry-fixture-lifetime');
reapPreviousRunFixtures(FIXTURE_REGISTRY_DIR);
const FIXTURE_REGISTRY_PATH = initFixturePidRegistry(FIXTURE_REGISTRY_DIR);
process.on('exit', () => reapFixturesSync(FIXTURE_REGISTRY_PATH));
after(async () => { await reapFixtures(FIXTURE_REGISTRY_PATH); });

/**
 * Spawn the fixture as its own process-group leader and record it in the registry
 * before the test can fail, so the crash nets have it even if nothing below runs.
 */
function spawnFixture(env) {
  const child = spawn(process.execPath, [FIXTURE], {
    stdio: 'ignore',
    timeout: 30_000,
    detached: true,
    env: { ...process.env, ...env },
  });
  recordFixturePid(FIXTURE_REGISTRY_PATH, child.pid);
  return child;
}

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
  const child = spawnFixture({ PICKLE_FIXTURE_MAX_LIFETIME_MS: '300' });
  try {
    await waitFor(() => !isAlive(child.pid), 5_000, 'fixture exited unaided past its 300ms bound');
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

test('fixture falls back to the compiled default when the lifetime env is absent or garbage', async () => {
  const children = [
    spawnFixture({}),
    spawnFixture({ PICKLE_FIXTURE_MAX_LIFETIME_MS: 'not-a-number' }),
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
  const child = spawnFixture({
    PICKLE_FIXTURE_MAX_LIFETIME_MS: '300',
    PICKLE_FIXTURE_PID_REGISTRY: registryPath,
  });
  try {
    await waitFor(() => !isAlive(child.pid), 5_000, 'fixture exited unaided past its bound');
    const lines = fs.readFileSync(registryPath, 'utf-8').trim().split('\n');
    assert.ok(lines.includes(String(child.pid)), `registry must contain spawned pid=${child.pid}; got: ${lines}`);
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

/**
 * Source with comments removed, so the pin below reads CODE and never prose. A
 * docblock naming `recordFixturePid` is not a call to it, and matching one would
 * let a file look wired while recording nothing — the exact fake-green the pin
 * exists to catch. Only block comments and comment-ONLY lines are stripped, so no
 * `//` inside a string literal can swallow a real call on the same line.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}

/**
 * The seam calls a real spawner must make. A MENTION is not a call — an imported
 * but uncalled `recordFixturePid` records nothing — so the check below tests for
 * an invocation, and these names are stored WITHOUT their paren so that this
 * declaration cannot satisfy the very scan it defines.
 */
const REQUIRED_SEAM_CALLS = [
  { name: 'recordFixturePid', consequence: 'its orphans survive a killed run' },
  { name: 'reapPreviousRunFixtures', consequence: 'nothing collects them after a SIGKILL' },
];

/** Every `*.test.js` under `tests/`, including subdirectories. */
function collectTestFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTestFiles(full));
    else if (entry.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

/**
 * D1 (R-ORCG): pin the INVARIANT, not the consumer list. The ticket shipped a
 * four-row table of fixture consumers that was already wrong by one row —
 * orphan-worker-reaper.test.js names the fixture only inside fabricated `ps`
 * strings and spawns nothing at all. A pin encoding that table would need
 * maintaining and would rot green, one consumer away from the next silent leak.
 *
 * So the set is DERIVED: a file is a spawner if it names the fixture and can
 * actually spawn. Files that only mention it are exempt BECAUSE they cannot leak,
 * which is checked on every run rather than asserted once in a review artifact —
 * add a real spawn to one and this fails immediately.
 */
test('D1 (R-ORCG): every real spawner of the sleeper fixture releases it through the shared registry seam', () => {
  const spawners = collectTestFiles(__dirname)
    .map(file => ({ file, code: stripComments(fs.readFileSync(file, 'utf-8')) }))
    .filter(({ code }) => code.includes('sigterm-ignoring-sleeper') && code.includes('node:child_process'));

  // Non-vacuity: a selector that admits nothing passes trivially and pins nothing.
  assert.ok(spawners.length > 0, 'the selector must admit the real spawners, else this test proves nothing');

  for (const { file, code } of spawners) {
    const rel = path.relative(__dirname, file);
    for (const { name, consequence } of REQUIRED_SEAM_CALLS) {
      // `${name}(` is composed, never written out: a literal `foo(` in this very
      // assertion would be found by the scan and would make THIS file pass itself.
      assert.ok(code.includes(`${name}(`), `${rel} spawns the sleeper fixture but never calls ${name} — ${consequence}`);
    }
  }
});

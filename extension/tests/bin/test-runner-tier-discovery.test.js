// @tier: integration
// SERIAL: subprocess-timeout-coupling — the wedged-child timeout test (:257)
// spawns a real `node --test` child with a fixed 5000ms runner timeout; under
// `test:fast` --test-concurrency=8 the child can be SIGKILLed before it registers
// as a running test, starving the `/cancelled 1|tests 1/` stdout assertion (R-TFP).
// Serialized via tests/integration/.serial-tests.json (runs at --test-concurrency=1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');
const RUNNER_PATH = path.join(EXTENSION_ROOT, 'bin', 'test-runner.js');

function makeFixtureRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'test-runner-tier-'));
}

function cleanupFixtureRoot(root) {
  rmSync(root, { recursive: true, force: true });
}

function writeFixtureTest(root, relativePath, tier, body = '') {
  const fullPath = path.join(root, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(
    fullPath,
    `// @tier: ${tier}\nimport { test } from 'node:test';\nimport assert from 'node:assert/strict';\n${body || "test('fixture', () => assert.equal(1, 1));"}\n`,
  );
}

function writeQuarantine(root, content) {
  const manifestPath = path.join(root, 'tests', 'QUARANTINE.md');
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, content);
}

function writeSerialManifest(root, content) {
  const manifestPath = path.join(root, 'tests', 'integration', '.serial-tests.json');
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(content, null, 2));
}

function runRunner(root, args, options = {}) {
  const env = { ...process.env, ...options.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [RUNNER_PATH, ...args], {
    cwd: root,
    encoding: 'utf8',
    env,
  });
}

function stdoutLines(result) {
  return result.stdout.trim().split(/\r?\n/).filter(Boolean);
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

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

test('discovery walks all tagged test tiers', () => {
  const root = makeFixtureRoot();
  try {
    writeFixtureTest(root, 'tests/fast-a.test.js', 'fast');
    writeFixtureTest(root, 'tests/integration/integration-a.test.js', 'integration');
    writeFixtureTest(root, 'tests/expensive-a.test.js', 'expensive');
    writeFixtureTest(root, 'tests/contracts/contract-a.test.js', 'contract');

    assert.deepEqual(stdoutLines(runRunner(root, ['--tier', 'fast', '--dry-run'])), [
      'tests/fast-a.test.js',
    ]);
    assert.deepEqual(stdoutLines(runRunner(root, ['--tier', 'integration', '--dry-run'])), [
      'tests/integration/integration-a.test.js',
    ]);
    assert.deepEqual(stdoutLines(runRunner(root, ['--tier', 'expensive', '--dry-run'], {
      env: { RUN_EXPENSIVE_TESTS: '1' },
    })), [
      'tests/expensive-a.test.js',
    ]);
    assert.deepEqual(stdoutLines(runRunner(root, ['--tier', 'contract', '--dry-run'])), [
      'tests/contracts/contract-a.test.js',
    ]);
  } finally {
    cleanupFixtureRoot(root);
  }
});

test('quarantine excludes fast and integration tier files', () => {
  const root = makeFixtureRoot();
  try {
    writeFixtureTest(root, 'tests/fast-keep.test.js', 'fast');
    writeFixtureTest(root, 'tests/fast-quarantined.test.js', 'fast');
    writeFixtureTest(root, 'tests/integration/integration-quarantined.test.js', 'integration');
    writeQuarantine(root, [
      '# Quarantine',
      '- tests/fast-quarantined.test.js',
      '- `tests/integration/integration-quarantined.test.js`',
      '',
    ].join('\n'));

    const fastFiles = stdoutLines(runRunner(root, ['--tier', 'fast', '--dry-run']));
    assert.deepEqual(fastFiles, ['tests/fast-keep.test.js']);

    const integration = runRunner(root, ['--tier', 'integration', '--dry-run']);
    assert.equal(integration.status, 0);
    assert.deepEqual(stdoutLines(integration), []);
    assert.match(integration.stderr, /\[no files for tier integration\]/);
  } finally {
    cleanupFixtureRoot(root);
  }
});

test('manifest include mode selects only listed integration files', () => {
  const root = makeFixtureRoot();
  try {
    writeFixtureTest(root, 'tests/integration/a.test.js', 'integration');
    writeFixtureTest(root, 'tests/integration/b.test.js', 'integration');
    writeSerialManifest(root, { entries: ['tests/integration/b.test.js'] });

    const result = runRunner(root, [
      '--tier', 'integration',
      '--manifest', 'tests/integration/.serial-tests.json',
      '--manifest-mode', 'include',
      '--dry-run',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(stdoutLines(result), ['tests/integration/b.test.js']);
  } finally {
    cleanupFixtureRoot(root);
  }
});

test('manifest exclude mode removes listed integration files', () => {
  const root = makeFixtureRoot();
  try {
    writeFixtureTest(root, 'tests/integration/a.test.js', 'integration');
    writeFixtureTest(root, 'tests/integration/b.test.js', 'integration');
    writeSerialManifest(root, { entries: ['tests/integration/b.test.js'] });

    const result = runRunner(root, [
      '--tier', 'integration',
      '--manifest', 'tests/integration/.serial-tests.json',
      '--manifest-mode', 'exclude',
      '--dry-run',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(stdoutLines(result), ['tests/integration/a.test.js']);
  } finally {
    cleanupFixtureRoot(root);
  }
});

test('manifest path is required for manifest mode', () => {
  const root = makeFixtureRoot();
  try {
    const result = runRunner(root, ['--tier', 'integration', '--manifest-mode', 'include']);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /--manifest and --manifest-mode must be provided together/);
  } finally {
    cleanupFixtureRoot(root);
  }
});

test('missing manifest fails loudly', () => {
  const root = makeFixtureRoot();
  try {
    writeFixtureTest(root, 'tests/integration/a.test.js', 'integration');

    const result = runRunner(root, [
      '--tier', 'integration',
      '--manifest', 'tests/integration/.serial-tests.json',
      '--manifest-mode', 'include',
      '--dry-run',
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Manifest not found: tests\/integration\/\.serial-tests\.json/);
  } finally {
    cleanupFixtureRoot(root);
  }
});

test('quarantine retains expensive tier files', () => {
  const root = makeFixtureRoot();
  try {
    writeFixtureTest(root, 'tests/expensive-quarantined.test.js', 'expensive');
    writeQuarantine(root, '- tests/expensive-quarantined.test.js\n');

    assert.deepEqual(stdoutLines(runRunner(root, ['--tier', 'expensive', '--dry-run'], {
      env: { RUN_EXPENSIVE_TESTS: '1' },
    })), [
      'tests/expensive-quarantined.test.js',
    ]);
  } finally {
    cleanupFixtureRoot(root);
  }
});

test('expensive tier is skipped unless RUN_EXPENSIVE_TESTS is set', () => {
  const root = makeFixtureRoot();
  try {
    writeFixtureTest(root, 'tests/expensive-a.test.js', 'expensive');

    const result = runRunner(root, ['--tier', 'expensive', '--dry-run'], {
      env: { RUN_EXPENSIVE_TESTS: '' },
    });

    assert.equal(result.status, 0);
    assert.deepEqual(stdoutLines(result), []);
    assert.match(result.stderr, /\[skipped: RUN_EXPENSIVE_TESTS unset\]/);
  } finally {
    cleanupFixtureRoot(root);
  }
});

test('invalid tier exits 2', () => {
  const root = makeFixtureRoot();
  try {
    const result = runRunner(root, ['--tier', 'bogus']);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown tier: bogus/);
  } finally {
    cleanupFixtureRoot(root);
  }
});

test('positional argv behavior still runs the selected file', () => {
  const root = makeFixtureRoot();
  try {
    writeFixtureTest(
      root,
      'tests/positional.test.js',
      'fast',
      [
        "test('positional fixture', () => {",
        "  assert.equal(process.env.TEST_RUNNER_POSITIONAL, '1');",
        '});',
      ].join('\n'),
    );
    writeFixtureTest(
      root,
      'tests/unselected.test.js',
      'fast',
      "test('unselected fixture', () => assert.fail('unselected test should not run'));",
    );

    const result = runRunner(root, ['tests/positional.test.js'], {
      env: { TEST_RUNNER_POSITIONAL: '1' },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    cleanupFixtureRoot(root);
  }
});

test('runner scopes a disposable pickle-prefixed TMPDIR to the spawned child only, removed on exit', () => {
  const root = makeFixtureRoot();
  const realTmpdir = os.tmpdir();
  const markerPath = path.join(realTmpdir, `test-runner-tmpdir-marker-${process.pid}-${Date.now()}.txt`);
  try {
    writeFixtureTest(
      root,
      'tests/capture-tmpdir.test.js',
      'fast',
      [
        "import fs from 'node:fs';",
        "test('capture child TMPDIR', () => {",
        `  fs.writeFileSync(${JSON.stringify(markerPath)}, process.env.TMPDIR || '');`,
        '  assert.equal(1, 1);',
        '});',
      ].join('\n'),
    );

    const envBefore = process.env.TMPDIR;
    const result = runRunner(root, ['tests/capture-tmpdir.test.js']);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    // (b) the redirect is scoped to the spawnSync child's env option only — never exported at
    // npm-script / this-process level. If it were `process.env.TMPDIR = ...` in the parent, THIS
    // process's own env would carry the mutation after the call returns.
    assert.equal(process.env.TMPDIR, envBefore, 'the runner must never mutate its own process.env.TMPDIR');

    const childTmpdir = readFileSync(markerPath, 'utf8');
    assert.ok(childTmpdir, 'the spawned child must have observed a TMPDIR override');
    assert.notEqual(childTmpdir, realTmpdir, 'the child TMPDIR must differ from the parent test process TMPDIR');

    // (a) root basename MUST start with 'pickle-' so orphan-reaper's TEST_OWNED_TMP_PREFIXES admits it.
    assert.match(path.basename(childTmpdir), /^pickle-/);

    // (c) the root is removed on exit — no leftover directory after the run completes.
    assert.equal(existsSync(childTmpdir), false, 'the disposable TMPDIR root must be removed after the run');

    // Two independent runs must each get their own disposable root (no reuse/leak of prior state).
    writeFileSync(markerPath, '');
    const result2 = runRunner(root, ['tests/capture-tmpdir.test.js']);
    assert.equal(result2.status, 0, result2.stderr || result2.stdout);
    const childTmpdir2 = readFileSync(markerPath, 'utf8');
    assert.notEqual(childTmpdir2, childTmpdir, 'each run must get a fresh disposable TMPDIR root');
    assert.equal(existsSync(childTmpdir2), false);
  } finally {
    rmSync(markerPath, { force: true });
    cleanupFixtureRoot(root);
  }
});

test('runner still removes the disposable TMPDIR root when the spawned child fails', () => {
  const root = makeFixtureRoot();
  const realTmpdir = os.tmpdir();
  const markerPath = path.join(realTmpdir, `test-runner-tmpdir-marker-fail-${process.pid}-${Date.now()}.txt`);
  try {
    writeFixtureTest(
      root,
      'tests/capture-tmpdir-fail.test.js',
      'fast',
      [
        "import fs from 'node:fs';",
        "test('capture then fail', () => {",
        `  fs.writeFileSync(${JSON.stringify(markerPath)}, process.env.TMPDIR || '');`,
        "  assert.fail('deliberate failure to exercise non-zero exit cleanup');",
        '});',
      ].join('\n'),
    );

    const result = runRunner(root, ['tests/capture-tmpdir-fail.test.js']);
    assert.notEqual(result.status, 0);

    const childTmpdir = readFileSync(markerPath, 'utf8');
    assert.match(path.basename(childTmpdir), /^pickle-/);
    assert.equal(existsSync(childTmpdir), false, 'cleanup must run even when the child exits non-zero');
  } finally {
    rmSync(markerPath, { force: true });
    cleanupFixtureRoot(root);
  }
});

test('runner times out wedged child test process instead of hanging indefinitely', async () => {
  const root = makeFixtureRoot();
  const grandchildMarkerPath = path.join(root, 'grandchild.pid');
  try {
    // AP-EXT-ITER54-01 (test-runner.ts sibling): `--test` isolates this file in its OWN
    // per-file child process — one level below the harness `spawnSync`'s timeout directly
    // signals — and that per-file process here spawns a FURTHER descendant of its own
    // (deliberately NOT detached, so it shares the harness's process group). This models
    // the general `npm -> node --test` grandchild shape: a wedged leaf whose parent's own
    // signal handling cannot be trusted to cascade the kill down to it. If the runner's
    // teardown only ever signals the direct child pid, this grandchild reparents to init
    // and survives — proven locally by running this fixture against the pre-fix runner
    // (recorded pid stays alive past the poll deadline below).
    writeFixtureTest(
      root,
      'tests/hangs.test.js',
      'fast',
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        `const grandchild = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 600000)'], { stdio: 'ignore', timeout: 30_000 });`,
        'grandchild.unref();',
        `writeFileSync(${JSON.stringify(grandchildMarkerPath)}, String(grandchild.pid));`,
        "test('blocks event loop past timeout', () => {",
        '  const shared = new SharedArrayBuffer(4);',
        '  const view = new Int32Array(shared);',
        '  Atomics.wait(view, 0, 0, 60_000);',
        '});',
      ].join('\n'),
    );

    const startedAt = Date.now();
    // 200ms → 5000ms: under 8-way full-suite concurrency the wedged fixture
    // child must actually spawn and *register as a running test* with the
    // runner before the runner's timeout fires — otherwise the runner SIGKILLs
    // it before it counts as a test and prints nothing on stdout (the flaky
    // empty-stdout failure). The fixture blocks the event loop for 60s via
    // Atomics.wait, so any timeout < 60_000 still proves the runner does not
    // hang indefinitely; 5s only absorbs scheduler jitter at child startup.
    const RUNNER_TIMEOUT_MS = 5_000;
    const result = runRunner(root, ['tests/hangs.test.js'], {
      env: { PICKLE_TEST_RUNNER_TIMEOUT_MS: String(RUNNER_TIMEOUT_MS) },
    });

    assert.ok(
      result.status === 1 || /ETIMEDOUT|timed out/i.test(result.stderr),
      `expected timeout failure, got status=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
    assert.match(result.stderr, /ETIMEDOUT|timed out/i);
    // node 22/macOS report the wedged child as `cancelled 1`/`tests 1`; node 24 on
    // Linux CI reports `Interrupted while running:` (B-CITAIL T1 — additive accept).
    assert.match(result.stdout, /cancelled 1|tests 1|Interrupted while running/i);
    // Ceiling = RUNNER_TIMEOUT_MS + generous spawn/teardown slack, still far
    // below the 60s fixture sleep so a real indefinite hang is still caught.
    assert.ok(Date.now() - startedAt < RUNNER_TIMEOUT_MS + 25_000, 'timeout should fail fast');

    assert.ok(existsSync(grandchildMarkerPath), 'wedged fixture never recorded its grandchild pid');
    const grandchildPid = Number(readFileSync(grandchildMarkerPath, 'utf8').trim());
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, `invalid recorded pid: ${grandchildPid}`);

    // The group kill (or the OS reclaiming the group) is asynchronous; poll rather than
    // sample once.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && isPidAlive(grandchildPid)) {
      await sleep(100);
    }
    assert.equal(
      isPidAlive(grandchildPid),
      false,
      `wedged fixture's grandchild ${grandchildPid} survived the runner timeout as an orphan`,
    );
  } finally {
    try {
      const gc = existsSync(grandchildMarkerPath) ? Number(readFileSync(grandchildMarkerPath, 'utf8').trim()) : 0;
      if (gc > 0 && isPidAlive(gc)) { process.kill(gc, 'SIGKILL'); }
    } catch {
      // Best-effort: nothing left to reap.
    }
    cleanupFixtureRoot(root);
  }
});

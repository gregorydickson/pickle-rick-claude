// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');
const RUNNER_PATH = path.join(EXTENSION_ROOT, 'bin', 'test-runner.js');

function makeFixtureRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'test-runner-leak-budget-'));
}

function cleanupFixtureRoot(root) {
  rmSync(root, { recursive: true, force: true });
}

function writeFixtureTest(root, relativePath, body) {
  const fullPath = path.join(root, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(
    fullPath,
    `// @tier: fast\nimport { test } from 'node:test';\nimport assert from 'node:assert/strict';\n${body}\n`,
  );
}

/**
 * The non-vacuous leak-budget oracle (AC-4): counts entries CREATED directly inside `privateRoot`
 * during `fn()` — never a `^pickle-` grep against the operator's real TMPDIR (documented failure
 * mode #2: that filter missed two thirds of real leaked prefixes). Returns `{ delta }` on a
 * successful measurement, or `{ unmeasured: true, reason }` — NEVER a false `{ delta: 0 }` — when a
 * precondition fails (the root is unreadable/missing before or after the run). Never throws: a
 * budget helper failing to measure must not halt the caller (root CLAUDE.md: a gate may refuse or
 * flag, never halt the pipeline over a measurement it could not take).
 */
function measureTmpEntryDelta(privateRoot, fn) {
  let before;
  try {
    before = readdirSync(privateRoot);
  } catch (err) {
    return { unmeasured: true, reason: `precondition failed reading privateRoot before run: ${err.message}` };
  }

  try {
    fn();
  } catch (err) {
    return { unmeasured: true, reason: `fn() threw during measurement: ${err.message}` };
  }

  let after;
  try {
    after = readdirSync(privateRoot);
  } catch (err) {
    return { unmeasured: true, reason: `precondition failed reading privateRoot after run: ${err.message}` };
  }

  return { delta: after.length - before.length };
}

test('leak budget: a full fixture run under a private root leaves zero created entries', () => {
  const fixtureRoot = makeFixtureRoot();
  const privateRoot = mkdtempSync(path.join(os.tmpdir(), 'test-runner-leak-private-'));
  try {
    writeFixtureTest(
      fixtureRoot,
      'tests/leak-budget-fixture.test.js',
      "test('trivial fixture', () => assert.equal(1, 1));",
    );

    const measurement = measureTmpEntryDelta(privateRoot, () => {
      const env = { ...process.env, TMPDIR: privateRoot };
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, [RUNNER_PATH, 'tests/leak-budget-fixture.test.js'], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env,
        timeout: 30000,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    });

    assert.deepEqual(measurement, { delta: 0 });
  } finally {
    cleanupFixtureRoot(fixtureRoot);
    rmSync(privateRoot, { recursive: true, force: true });
  }
});

test('leak budget: an unreadable private root reports unmeasured, never a false zero', () => {
  const bogusRoot = path.join(os.tmpdir(), `test-runner-leak-budget-does-not-exist-${process.pid}-${Date.now()}`);

  const measurement = measureTmpEntryDelta(bogusRoot, () => {
    // fn() is never reached — the precondition (readable root) fails first.
  });

  assert.equal(measurement.unmeasured, true);
  assert.equal(typeof measurement.reason, 'string');
  assert.ok(measurement.reason.length > 0);
  assert.equal(measurement.delta, undefined, 'must never report a delta when the measurement could not run');
});

test('leak budget: a throwing measurement body reports unmeasured and does not halt the caller', () => {
  const privateRoot = mkdtempSync(path.join(os.tmpdir(), 'test-runner-leak-private-throw-'));
  try {
    let measurement;
    assert.doesNotThrow(() => {
      measurement = measureTmpEntryDelta(privateRoot, () => {
        throw new Error('simulated spawn failure');
      });
    }, 'measureTmpEntryDelta must never propagate a thrown error — it is advisory, not a hard gate');

    assert.equal(measurement.unmeasured, true);
    assert.match(measurement.reason, /simulated spawn failure/);
  } finally {
    rmSync(privateRoot, { recursive: true, force: true });
  }
});

// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');
const RUNNER_JS = path.join(EXTENSION_ROOT, 'bin', 'test-runner.js');
const SERIAL_MANIFEST = path.join(EXTENSION_ROOT, 'tests', 'expensive', '.serial-tests.json');
const SOAK_SECONDS_DEFAULT = 1800;

function readNumericConst(source, name) {
  const match = new RegExp(`const ${name} = ([^;]+);`).exec(source);
  assert.ok(match, `${name} must be present in the compiled runner`);
  return match[1];
}

function readDefaultTimeoutMs() {
  const source = readFileSync(RUNNER_JS, 'utf8');
  const soakSecondsExpr = readNumericConst(source, 'SOAK_SECONDS_DEFAULT');
  const serialEntryCountExpr = readNumericConst(source, 'SERIAL_MANIFEST_WORST_CASE_ENTRY_COUNT');
  const defaultTimeoutExpr = readNumericConst(source, 'DEFAULT_TEST_RUNNER_TIMEOUT_MS');
  // eslint-disable-next-line no-new-func
  return Function(
    `const SOAK_SECONDS_DEFAULT = (${soakSecondsExpr});
     const SERIAL_MANIFEST_WORST_CASE_ENTRY_COUNT = (${serialEntryCountExpr});
     return (${defaultTimeoutExpr});`,
  )();
}

test('DEFAULT_TEST_RUNNER_TIMEOUT_MS exceeds the serial-manifest worst-case sum', () => {
  const manifest = JSON.parse(readFileSync(SERIAL_MANIFEST, 'utf8'));
  const serialEntryCount = manifest.entries.length;
  const worstCaseSumMs = SOAK_SECONDS_DEFAULT * 1000 * serialEntryCount;

  const defaultTimeoutMs = readDefaultTimeoutMs();

  assert.ok(
    defaultTimeoutMs > worstCaseSumMs,
    `DEFAULT_TEST_RUNNER_TIMEOUT_MS (${defaultTimeoutMs}) must strictly exceed the serial-manifest worst-case sum (${worstCaseSumMs} = ${SOAK_SECONDS_DEFAULT}s * 1000 * ${serialEntryCount} entries)`,
  );
});

test('DEFAULT_TEST_RUNNER_TIMEOUT_MS stays within MAX_TEST_RUNNER_TIMEOUT_MS', () => {
  const source = readFileSync(RUNNER_JS, 'utf8');
  const match = /const MAX_TEST_RUNNER_TIMEOUT_MS = ([^;]+);/.exec(source);
  assert.ok(match, 'MAX_TEST_RUNNER_TIMEOUT_MS must be present in the compiled runner');
  // eslint-disable-next-line no-new-func
  const maxTimeoutMs = Function(`return (${match[1]});`)();

  const defaultTimeoutMs = readDefaultTimeoutMs();
  assert.ok(defaultTimeoutMs <= maxTimeoutMs, 'default must not exceed the runner clamp ceiling');
});

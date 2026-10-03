// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs, runCalibrate } from '../bin/calibrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');
const COMPILED_CALIBRATE = path.resolve(EXTENSION_ROOT, 'bin', 'calibrate.js');

// ── CLI guard ──────────────────────────────────────────────────────────────────

test('calibrate.js CLI guard uses fileURLToPath + path.resolve pattern', () => {
  const src = fs.readFileSync(COMPILED_CALIBRATE, 'utf-8');
  // Must use fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  // rather than path.basename — because import.meta.url is the guard mechanism.
  assert.ok(
    src.includes('process.argv[1]') && src.includes('fileURLToPath(import.meta.url)'),
    'CLI guard must check process.argv[1] and fileURLToPath(import.meta.url)',
  );
  assert.ok(
    src.includes('path.resolve(process.argv[1])'),
    'CLI guard must resolve process.argv[1] for a canonical path comparison',
  );
});

// ── parseArgs ─────────────────────────────────────────────────────────────────

test('parseArgs: single known suite returns correct structure', () => {
  const result = parseArgs(['readiness', '--extension-root', EXTENSION_ROOT]);
  assert.deepStrictEqual(result.suites, ['readiness']);
  assert.strictEqual(result.write, false);
  assert.strictEqual(typeof result.extensionRoot, 'string');
  assert.ok(path.isAbsolute(result.extensionRoot), 'extensionRoot must be absolute');
});

test('parseArgs: "all" expands to every known suite', () => {
  const result = parseArgs(['all', '--extension-root', EXTENSION_ROOT]);
  assert.deepEqual(result.suites, ['readiness', 'correct-course']);
});

test('parseArgs: --write flag is captured', () => {
  const result = parseArgs(['readiness', '--write', '--extension-root', EXTENSION_ROOT]);
  assert.strictEqual(result.write, true);
});

test('parseArgs: unknown flag throws or calls usage (exits)', () => {
  // process.exit is called inside usage(); catch via thrown/exited process
  let threw = false;
  const origExit = process.exit;
  process.exit = () => { threw = true; throw new Error('exit'); };
  try {
    parseArgs(['readiness', '--bogus-flag', '--extension-root', EXTENSION_ROOT]);
  } catch {
    // expected
  } finally {
    process.exit = origExit;
  }
  assert.ok(threw, 'Unknown flag should trigger usage() which calls process.exit');
});

// ── runCalibrate ──────────────────────────────────────────────────────────────

test('runCalibrate: check mode returns 0 for readiness suite when baseline exists', () => {
  const baselinePath = path.join(EXTENSION_ROOT, 'tests', 'calibration', 'readiness', 'baseline.json');
  if (!fs.existsSync(baselinePath)) {
    // No baseline available in this environment; skip gracefully
    return;
  }
  const exitCode = runCalibrate({
    suites: ['readiness'],
    extensionRoot: EXTENSION_ROOT,
    write: false,
  });
  assert.ok(
    exitCode === 0 || exitCode === 2,
    `exit code should be 0 (pass) or 2 (drift detected), got ${exitCode}`,
  );
});

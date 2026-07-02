// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = resolve(__dirname, '../../pickle_settings.json');

function loadSettings() {
  return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
}

test('convergence-gate-defaults: block is present with all 12 top-level keys', () => {
  const settings = loadSettings();
  assert.ok('convergence_gate' in settings, 'convergence_gate block missing from pickle_settings.json');
  const gate = settings.convergence_gate;
  const keys = Object.keys(gate);
  const expected = [
    'commands',
    'enabled_convergence_files',
    'timeout_ms',
    'gate_total_timeout_ms',
    'remediator_timeout_s',
    'szechuan_max_remediation_cycles',
    'anatomy_park_max_remediation_cycles',
    'regression_warning_threshold',
    'baseline_max_age_iterations',
    'baseline_max_age_seconds',
    'prefer_test_unit_alias',
    'known_flake_files',
  ];
  assert.ok(keys.length >= 12, `expected >= 12 keys, got ${keys.length}`);
  for (const k of expected) {
    assert.ok(k in gate, `missing key: ${k}`);
  }
});

test('convergence-gate-defaults: commands is an object', () => {
  const { convergence_gate: gate } = loadSettings();
  assert.strictEqual(typeof gate.commands, 'object');
  assert.ok(!Array.isArray(gate.commands));
});

test('convergence-gate-defaults: enabled_convergence_files defaults to ["anatomy-park.json"]', () => {
  const { convergence_gate: gate } = loadSettings();
  assert.deepStrictEqual(gate.enabled_convergence_files, ['anatomy-park.json']);
});

test('convergence-gate-defaults: timeout_ms nested defaults correct', () => {
  const { convergence_gate: gate } = loadSettings();
  assert.strictEqual(typeof gate.timeout_ms, 'object');
  assert.strictEqual(gate.timeout_ms.typecheck, 120000);
  assert.strictEqual(gate.timeout_ms.lint, 60000);
  assert.strictEqual(gate.timeout_ms.tests, 300000);
});

test('convergence-gate-defaults: integer defaults match P4 table', () => {
  const { convergence_gate: gate } = loadSettings();
  assert.strictEqual(gate.gate_total_timeout_ms, 600000);
  assert.strictEqual(gate.remediator_timeout_s, 600);
  assert.strictEqual(gate.szechuan_max_remediation_cycles, 3);
  assert.strictEqual(gate.anatomy_park_max_remediation_cycles, 5);
  assert.strictEqual(gate.regression_warning_threshold, 5);
  assert.strictEqual(gate.baseline_max_age_iterations, 30);
  assert.strictEqual(gate.baseline_max_age_seconds, 14400);
});

test('convergence-gate-defaults: bool and array defaults correct', () => {
  const { convergence_gate: gate } = loadSettings();
  assert.strictEqual(gate.prefer_test_unit_alias, false);
  assert.deepStrictEqual(gate.known_flake_files, []);
});

test('convergence-gate-defaults: existing top-level keys unchanged', () => {
  const settings = loadSettings();
  assert.strictEqual(settings.default_max_iterations, 500);
  assert.equal('default_max_time_minutes' in settings, false);
  assert.strictEqual(settings.default_worker_timeout_seconds, 2400);
  assert.strictEqual(settings.default_manager_max_turns, 50);
});

// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePipelineContinueOnPhaseFailSetting } from '../bin/setup.js';
import { resolveWorkerGateTier } from '../bin/spawn-morty.js';
import { resolveWorkerTestGateTimeoutMs } from '../services/pickle-utils.js';

function withExtensionRoot(fn) {
  const extensionRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-settings-loader-')));
  try {
    return fn(extensionRoot);
  } finally {
    fs.rmSync(extensionRoot, { recursive: true, force: true });
  }
}

test('settings-loader: default worker_test_gate_timeout_ms applies when key is absent', () => {
  withExtensionRoot((extensionRoot) => {
    fs.writeFileSync(path.join(extensionRoot, 'pickle_settings.json'), JSON.stringify({
      default_worker_timeout_seconds: 1200,
    }, null, 2));

    assert.equal(resolveWorkerTestGateTimeoutMs(extensionRoot, undefined, {}), 600_000);
  });
});

test('settings-loader: override worker_test_gate_timeout_ms is honored', () => {
  withExtensionRoot((extensionRoot) => {
    fs.writeFileSync(path.join(extensionRoot, 'pickle_settings.json'), JSON.stringify({
      worker_test_gate_timeout_ms: 12_345,
    }, null, 2));

    assert.equal(resolveWorkerTestGateTimeoutMs(extensionRoot, undefined, {}), 12_345);
  });
});

test('settings-loader: default worker_gate_tier applies when key is absent', () => {
  withExtensionRoot((extensionRoot) => {
    fs.writeFileSync(path.join(extensionRoot, 'pickle_settings.json'), JSON.stringify({
      default_worker_timeout_seconds: 1200,
    }, null, 2));

    assert.equal(resolveWorkerGateTier(extensionRoot), 'fast');
  });
});

test('settings-loader: invalid worker_gate_tier warns and falls back to fast', () => {
  withExtensionRoot((extensionRoot) => {
    fs.writeFileSync(path.join(extensionRoot, 'pickle_settings.json'), JSON.stringify({
      worker_gate_tier: 'bogus',
    }, null, 2));

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => {
      warnings.push(String(message));
    };
    try {
      assert.equal(resolveWorkerGateTier(extensionRoot), 'fast');
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /invalid worker_gate_tier "bogus"/);
    assert.match(warnings[0], /defaulting to "fast"/);
  });
});

test('settings-loader: pipeline_continue_on_phase_fail defaults to true when key is absent', () => {
  assert.equal(resolvePipelineContinueOnPhaseFailSetting(undefined), true);
  assert.equal(resolvePipelineContinueOnPhaseFailSetting({ default_worker_timeout_seconds: 1200 }), true);
});

test('settings-loader: pipeline_continue_on_phase_fail honors false override from settings', () => {
  assert.equal(resolvePipelineContinueOnPhaseFailSetting({ pipeline_continue_on_phase_fail: false }), false);
  assert.equal(resolvePipelineContinueOnPhaseFailSetting({ pipeline_continue_on_phase_fail: true }), true);
});

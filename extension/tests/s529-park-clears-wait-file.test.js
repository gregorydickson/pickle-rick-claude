// @tier: fast
// Regression (anatomy-park: extension — HIGH): the metric-path park writes
// rate_limit_wait.json {waiting:true} on park entry but, pre-fix, never cleared it on the
// recovery/success or ceiling-exhaustion exit paths — unlike the symmetric manager-mode
// clearRateLimitWaitFile. A stale waiting:true file makes monitor.appendRateLimitField render
// "Rate limited … wait ending..." forever after the API recovers. Both exit paths must clear it.
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _deps,
  measureLlmMetricWithBackoff,
} from '../bin/microverse-runner.js';

const PROBE_OK = { code: 0, stderr: 'claude/2.1.0' };
const STEP_429 = { code: 1, stderr: 'API Error: 529 Overloaded' };
function STEP_SUCCESS(metric) {
  return { code: 0, stdout: JSON.stringify({ score: metric }) };
}

function makeSpawnMock(steps) {
  return (_cmd, _args, _opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    process.nextTick(() => {
      const step = steps.shift() ?? { code: 0 };
      if (step.stderr) { child.stderr.write(step.stderr); }
      if (step.stdout) { child.stdout.write(step.stdout); }
      child.stdout.end();
      child.stderr.end();
      child.emit('close', step.code ?? 0, null);
    });
    return child;
  };
}

const LEGACY_ENV = 'PICKLE_JUDGE_LEGACY_SPAWN';
const SESSION = 's529-clear-test-001';

let dataRoot;
let waitFile;
let savedDataRoot;
let savedLegacy;

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's529-clear-'));
  const sessionDir = path.join(dataRoot, 'sessions', SESSION);
  fs.mkdirSync(sessionDir, { recursive: true });
  waitFile = path.join(sessionDir, 'rate_limit_wait.json');
  savedDataRoot = process.env.PICKLE_DATA_ROOT;
  savedLegacy = process.env[LEGACY_ENV];
  process.env.PICKLE_DATA_ROOT = dataRoot;
  delete process.env[LEGACY_ENV];
});

afterEach(() => {
  if (savedDataRoot === undefined) { delete process.env.PICKLE_DATA_ROOT; }
  else { process.env.PICKLE_DATA_ROOT = savedDataRoot; }
  if (savedLegacy === undefined) { delete process.env[LEGACY_ENV]; }
  else { process.env[LEGACY_ENV] = savedLegacy; }
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

function withDeps(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) saved[k] = _deps[k];
  Object.assign(_deps, overrides);
  return fn().finally(() => { Object.assign(_deps, saved); });
}

const ATTEMPT_ACTIVITY = { session: SESSION, iteration: 1, spawnContext: 'baseline' };

describe('metric-path park clears rate_limit_wait.json on exit', () => {
  test('park → recovery: wait file is removed after a metric is measured', async () => {
    const steps = [
      PROBE_OK,
      STEP_429, STEP_429, STEP_429, STEP_429, // round 1 → park
      STEP_SUCCESS(0.85),                      // round 2 → success
    ];
    // emitMetricParkWait fires the rate_limit_wait event then writes the file, both before the
    // park sleep. The 3 backoff sleeps precede any park, so only assert existence once parked.
    let parked = false;
    await withDeps({
      spawn: makeSpawnMock(steps),
      sleep: async () => {
        if (parked) {
          assert.ok(fs.existsSync(waitFile), 'expected rate_limit_wait.json present during park');
        }
      },
      logActivity: (evt) => { if (evt.event === 'rate_limit_wait') { parked = true; } },
      metricParkMaxMs: 3000,
      metricParkWaitMs: 1500,
    }, async () => {
      const result = await measureLlmMetricWithBackoff(
        'improve coverage', 1, '/tmp', undefined, undefined, undefined,
        undefined, 'claude', [], ATTEMPT_ACTIVITY,
      );
      assert.ok(result.metric !== null, 'expected a metric after park+retry');
    });
    assert.ok(!fs.existsSync(waitFile),
      'rate_limit_wait.json must be cleared after the judge recovers');
  });

  test('park → ceiling exhausted: wait file is removed on the transient exit', async () => {
    const steps = [PROBE_OK, ...Array(12).fill(STEP_429)];
    await withDeps({
      spawn: makeSpawnMock(steps),
      sleep: async () => {},
      logActivity: () => {},
      metricParkMaxMs: 3000,
      metricParkWaitMs: 1500,
    }, async () => {
      const result = await measureLlmMetricWithBackoff(
        'improve coverage', 1, '/tmp', undefined, undefined, undefined,
        undefined, 'claude', [], ATTEMPT_ACTIVITY,
      );
      assert.equal(result.metric, null);
      assert.equal(result.exhaustedFailureKind, 'rate_limited');
    });
    assert.ok(!fs.existsSync(waitFile),
      'rate_limit_wait.json must be cleared when the park ceiling is exhausted');
  });
});

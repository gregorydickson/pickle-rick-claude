// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  _deps,
  measureLlmMetricWithBackoff,
} from '../bin/microverse-runner.js';

// Probe step: exit 0 with version string (signals CLI available, not rate-limited).
const PROBE_OK = { code: 0, stderr: 'claude/2.1.0' };
// Attempt step: exit 1 with 429 stderr → rate_limited.
const STEP_429 = { code: 1, stderr: 'API Error: 429 Too Many Requests' };
// Attempt step: exit 1 with timeout error → timeout.
const STEP_ETIMEDOUT = { code: 1, stderr: 'ETIMEDOUT' };
// Attempt step: exit 0 with a parseable metric in stdout.
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
      if (step.stderr) child.stderr.write(step.stderr);
      if (step.stdout) child.stdout.write(step.stdout);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', step.code ?? 0, null);
    });
    return child;
  };
}

const LEGACY_ENV = 'PICKLE_JUDGE_LEGACY_SPAWN';

function withDeps(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) saved[k] = _deps[k];
  const prevLegacy = process.env[LEGACY_ENV];
  delete process.env[LEGACY_ENV];
  Object.assign(_deps, overrides);
  return fn().finally(() => {
    Object.assign(_deps, saved);
    if (prevLegacy === undefined) delete process.env[LEGACY_ENV];
    else process.env[LEGACY_ENV] = prevLegacy;
  });
}

const FAKE_ATTEMPT_ACTIVITY = {
  session: 'test-session-001',
  iteration: 1,
  spawnContext: 'baseline',
};

describe('AC-S529-3: park-then-success — rate_limited exhaustion parks and retries', () => {
  test('probe ok + 4x 429 → park → 1 success → metric returned, attempts > 4', async () => {
    // 1 probe + 4 inner-loop 429s exhaust the first round → park fires (ceiling = 3000ms)
    // → 1 probe skipped (probe is once per call) → next round attempt 1 succeeds
    // NOTE: probe is called once before the while loop, so after park the inner loop
    // calls measureLlmMetricAttempt directly (no re-probe). Steps for attempts 5-8
    // drain until success.
    const steps = [
      PROBE_OK,
      STEP_429, STEP_429, STEP_429, STEP_429, // round 1 inner loop
      STEP_SUCCESS(0.85),                      // round 2 attempt 1 succeeds
    ];
    const events = [];
    await withDeps({
      spawn: makeSpawnMock(steps),
      sleep: async () => {},
      logActivity: (evt) => events.push(evt),
      metricParkMaxMs: 3000,
      metricParkWaitMs: 1500,
    }, async () => {
      const result = await measureLlmMetricWithBackoff(
        'improve coverage', 1, '/tmp', undefined, undefined, undefined,
        undefined, 'claude', [], FAKE_ATTEMPT_ACTIVITY,
      );
      assert.ok(result.metric !== null, 'expected metric to be returned after park+retry');
      assert.ok(result.attempts > 4, `expected attempts > 4, got ${result.attempts}`);
    });
  });
});

describe('AC-S529-6: ceiling exhaustion — park ceiling exhausted → baseline_unmeasurable_transient', () => {
  test('probe ok + 12x 429 (3 park cycles) exhausts 3000ms ceiling → metric null, exhaustedFailureKind rate_limited', async () => {
    // metricParkMaxMs=3000, metricParkWaitMs=1500: allows 2 park sleeps (1500+1500=3000).
    // Round 1: 4×429 → park (1500ms, cumulative=1500)
    // Round 2: 4×429 → park (1500ms, cumulative=3000)
    // Round 3: 4×429 → remainingMs=0 → break
    const steps = [
      PROBE_OK,
      ...Array(12).fill(STEP_429),
    ];
    await withDeps({
      spawn: makeSpawnMock(steps),
      sleep: async () => {},
      logActivity: () => {},
      metricParkMaxMs: 3000,
      metricParkWaitMs: 1500,
    }, async () => {
      const result = await measureLlmMetricWithBackoff(
        'improve coverage', 1, '/tmp', undefined, undefined, undefined,
        undefined, 'claude', [], FAKE_ATTEMPT_ACTIVITY,
      );
      assert.equal(result.metric, null);
      assert.equal(result.exhaustedFailureKind, 'rate_limited');
      assert.ok(result.attempts >= 12, `expected at least 12 attempts, got ${result.attempts}`);
    });
  });
});

describe('AC-S529-7: observable park — rate_limit_wait event emitted during park', () => {
  test('probe ok + 4x 429 → park → success: rate_limit_wait event emitted with session + duration_min', async () => {
    const steps = [
      PROBE_OK,
      STEP_429, STEP_429, STEP_429, STEP_429,
      STEP_SUCCESS(0.9),
    ];
    const events = [];
    await withDeps({
      spawn: makeSpawnMock(steps),
      sleep: async () => {},
      logActivity: (evt) => events.push(evt),
      metricParkMaxMs: 3000,
      metricParkWaitMs: 1500,
    }, async () => {
      await measureLlmMetricWithBackoff(
        'improve coverage', 1, '/tmp', undefined, undefined, undefined,
        undefined, 'claude', [], FAKE_ATTEMPT_ACTIVITY,
      );
      const parkEvents = events.filter(e => e.event === 'rate_limit_wait');
      assert.ok(parkEvents.length >= 1, `expected at least one rate_limit_wait event, got ${parkEvents.length}`);
      const evt = parkEvents[0];
      assert.equal(evt.session, FAKE_ATTEMPT_ACTIVITY.session);
      assert.ok(typeof evt.duration_min === 'number' && evt.duration_min >= 1,
        `expected duration_min >= 1, got ${evt.duration_min}`);
    });
  });
});

describe('AC-S529-4: non-rate_limited failure does not trigger park', () => {
  test('probe ok + 4x ETIMEDOUT → exhaustedFailureKind timeout, no extra sleep beyond 3 backoffs', async () => {
    const steps = [
      PROBE_OK,
      STEP_ETIMEDOUT, STEP_ETIMEDOUT, STEP_ETIMEDOUT, STEP_ETIMEDOUT,
    ];
    let sleepCalls = 0;
    await withDeps({
      spawn: makeSpawnMock(steps),
      sleep: async () => { sleepCalls++; },
      logActivity: () => {},
      metricParkMaxMs: 3000,
      metricParkWaitMs: 1500,
    }, async () => {
      const result = await measureLlmMetricWithBackoff(
        'improve coverage', 1, '/tmp',
      );
      assert.equal(result.metric, null);
      assert.equal(result.exhaustedFailureKind, 'timeout');
      // Only 3 backoff sleeps (between 4 attempts); no park sleep.
      assert.equal(sleepCalls, 3, `expected 3 backoff sleeps, got ${sleepCalls}`);
    });
  });
});

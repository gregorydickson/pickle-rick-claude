// @tier: fast
//
// R-WTFT regression: locks in the worker `test:fast` gate timeout default at
// 600_000 ms (10 min) and validates the `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS`
// env-var override path including parse-failure fallback and floor clamping.
//
// Background: the previous 240_000 ms (4 min) cap was killing legitimate runs
// on Opus hardware when the ~4994-test fast suite ran for >4 min, rolling
// back all worker artifacts and flipping tickets Failed mid-validation. See
// session pickle-216774d6 ticket R-WUWC-1 incident (2026-05-23).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS,
  WORKER_TEST_GATE_TIMEOUT_FLOOR_MS,
  WORKER_TEST_GATE_TIMEOUT_ENV_VAR,
  resolveWorkerTestGateTimeoutMs,
  DEFAULT_TIER_STALL_THRESHOLD_MS,
  TIER_STALL_THRESHOLD_FLOOR_MS,
  TIER_STALL_THRESHOLD_ENV_VAR,
  resolveTierStallThresholdMs,
} from '../services/pickle-utils.js';

test('R-WTFT default is 600_000 ms (10 min, ~3x headroom over ~3 min real-world fast-suite floor)', () => {
  assert.equal(DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS, 600_000);
});

test('R-WTFT floor for env override is 60_000 ms', () => {
  assert.equal(WORKER_TEST_GATE_TIMEOUT_FLOOR_MS, 60_000);
});

test('R-WTFT env override name is PICKLE_WORKER_TEST_FAST_TIMEOUT_MS', () => {
  assert.equal(WORKER_TEST_GATE_TIMEOUT_ENV_VAR, 'PICKLE_WORKER_TEST_FAST_TIMEOUT_MS');
});

test('R-WTFT no env, no settings -> default', () => {
  const got = resolveWorkerTestGateTimeoutMs(undefined, null, {});
  assert.equal(got, DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS);
});

test('R-WTFT env override accepted in valid range (120_000 ms)', () => {
  const got = resolveWorkerTestGateTimeoutMs(undefined, null, {
    [WORKER_TEST_GATE_TIMEOUT_ENV_VAR]: '120000',
  });
  assert.equal(got, 120_000);
});

test('R-WTFT env override clamps to floor (30_000 -> 60_000)', () => {
  const got = resolveWorkerTestGateTimeoutMs(undefined, null, {
    [WORKER_TEST_GATE_TIMEOUT_ENV_VAR]: '30000',
  });
  assert.equal(got, WORKER_TEST_GATE_TIMEOUT_FLOOR_MS);
});

test('R-WTFT env override at exact floor passes through', () => {
  const got = resolveWorkerTestGateTimeoutMs(undefined, null, {
    [WORKER_TEST_GATE_TIMEOUT_ENV_VAR]: '60000',
  });
  assert.equal(got, 60_000);
});

test('R-WTFT env override well above default passes through (1_800_000 = 30 min)', () => {
  const got = resolveWorkerTestGateTimeoutMs(undefined, null, {
    [WORKER_TEST_GATE_TIMEOUT_ENV_VAR]: '1800000',
  });
  assert.equal(got, 1_800_000);
});

test('R-WTFT invalid env (non-numeric) falls back to default', () => {
  const got = resolveWorkerTestGateTimeoutMs(undefined, null, {
    [WORKER_TEST_GATE_TIMEOUT_ENV_VAR]: 'foo',
  });
  assert.equal(got, DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS);
});

test('R-WTFT invalid env (float) falls back to default', () => {
  const got = resolveWorkerTestGateTimeoutMs(undefined, null, {
    [WORKER_TEST_GATE_TIMEOUT_ENV_VAR]: '120000.5',
  });
  assert.equal(got, DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS);
});

test('R-WTFT invalid env (negative) falls back to default', () => {
  const got = resolveWorkerTestGateTimeoutMs(undefined, null, {
    [WORKER_TEST_GATE_TIMEOUT_ENV_VAR]: '-1000',
  });
  assert.equal(got, DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS);
});

test('R-WTFT invalid env (zero) falls back to default', () => {
  const got = resolveWorkerTestGateTimeoutMs(undefined, null, {
    [WORKER_TEST_GATE_TIMEOUT_ENV_VAR]: '0',
  });
  assert.equal(got, DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS);
});

test('R-WTFT empty env string falls back to default', () => {
  const got = resolveWorkerTestGateTimeoutMs(undefined, null, {
    [WORKER_TEST_GATE_TIMEOUT_ENV_VAR]: '',
  });
  assert.equal(got, DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS);
});

test('R-WTFT env override wins over settings value', () => {
  const settings = { worker_test_gate_timeout_ms: 300_000 };
  const got = resolveWorkerTestGateTimeoutMs(undefined, settings, {
    [WORKER_TEST_GATE_TIMEOUT_ENV_VAR]: '450000',
  });
  assert.equal(got, 450_000);
});

test('R-WTFT settings used when env absent and settings valid', () => {
  const settings = { worker_test_gate_timeout_ms: 300_000 };
  const got = resolveWorkerTestGateTimeoutMs(undefined, settings, {});
  assert.equal(got, 300_000);
});

// ---------------------------------------------------------------------------
// R-TIERWEDGE (FR-B1): N for the tier-run stall detector is its OWN resolved
// setting, with a floor and a compiled-default fallback.
//
// Every case below resolves against an EXPLICIT env object and never reads
// ambient `process.env`. That is deliberate and load-bearing: it is what lets
// `PICKLE_TIER_STALL_THRESHOLD_MS` stay OUT of `PICKLE_GATE_SCRUBBED_ENV_KEYS`
// (a test that cannot observe an operator's export cannot be contaminated by
// one), so the scrub enumeration does not have to grow to accommodate this key.
// ---------------------------------------------------------------------------

test('R-TIERWEDGE stall-threshold default is 600_000 ms', () => {
  assert.equal(DEFAULT_TIER_STALL_THRESHOLD_MS, 600_000);
});

test('R-TIERWEDGE stall-threshold floor is 60_000 ms', () => {
  assert.equal(TIER_STALL_THRESHOLD_FLOOR_MS, 60_000);
});

test('R-TIERWEDGE stall-threshold env override name is PICKLE_TIER_STALL_THRESHOLD_MS', () => {
  assert.equal(TIER_STALL_THRESHOLD_ENV_VAR, 'PICKLE_TIER_STALL_THRESHOLD_MS');
});

test('R-TIERWEDGE no env -> compiled default', () => {
  assert.equal(resolveTierStallThresholdMs({}), DEFAULT_TIER_STALL_THRESHOLD_MS);
});

test('R-TIERWEDGE env override accepted in valid range (120_000 ms)', () => {
  const got = resolveTierStallThresholdMs({ [TIER_STALL_THRESHOLD_ENV_VAR]: '120000' });
  assert.equal(got, 120_000);
});

test('R-TIERWEDGE env override clamps up to the floor (30_000 -> 60_000)', () => {
  const got = resolveTierStallThresholdMs({ [TIER_STALL_THRESHOLD_ENV_VAR]: '30000' });
  assert.equal(got, TIER_STALL_THRESHOLD_FLOOR_MS);
});

test('R-TIERWEDGE env override at exactly the floor passes through', () => {
  const got = resolveTierStallThresholdMs({ [TIER_STALL_THRESHOLD_ENV_VAR]: '60000' });
  assert.equal(got, 60_000);
});

test('R-TIERWEDGE env override well above the default passes through (1_800_000 = 30 min)', () => {
  const got = resolveTierStallThresholdMs({ [TIER_STALL_THRESHOLD_ENV_VAR]: '1800000' });
  assert.equal(got, 1_800_000);
});

// Invalid input must degrade to the compiled default, never to NaN (which would
// make `Date.now() - lastActivityAt < NaN` false and fire the detector on the
// very first poll, killing every tier run immediately).
for (const raw of ['abc', '', '   ', '0', '-1', '1.5', '1e3ms', 'Infinity', 'NaN']) {
  test(`R-TIERWEDGE invalid env value ${JSON.stringify(raw)} falls back to the compiled default`, () => {
    const got = resolveTierStallThresholdMs({ [TIER_STALL_THRESHOLD_ENV_VAR]: raw });
    assert.equal(got, DEFAULT_TIER_STALL_THRESHOLD_MS);
    assert.ok(Number.isInteger(got), 'resolver must never return a non-integer');
  });
}

// THE regression this ticket exists to prevent. Root CLAUDE.md "Tune-Back CUJs" #1
// instructs operators to raise PICKLE_WORKER_TEST_FAST_TIMEOUT_MS per-machine, and
// `resolveWorkerTestGateTimeoutMs` applies no upper clamp. Before the split, that
// value WAS the stall window, so following the documented tune-back pushed hang
// detection from ~10 minutes out to 3 hours.
test('R-TIERWEDGE the gate wall-clock override does NOT widen the stall window', () => {
  const env = { [WORKER_TEST_GATE_TIMEOUT_ENV_VAR]: '10800000' };
  assert.equal(
    resolveWorkerTestGateTimeoutMs(undefined, null, env),
    10_800_000,
    'the gate budget still honours the documented per-machine tune-back',
  );
  assert.equal(
    resolveTierStallThresholdMs(env),
    DEFAULT_TIER_STALL_THRESHOLD_MS,
    'but the stall window must stay at its own default — the two are independent',
  );
});

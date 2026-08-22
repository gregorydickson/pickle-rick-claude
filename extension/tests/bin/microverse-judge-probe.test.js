// @tier: fast
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as os from 'node:os';
import * as fs from 'node:fs';
import {
  _deps,
  probeJudgeBackendAvailability,
  measureLlmMetricWithBackoff,
  classifyJudgeError,
  JudgeMeasurementTimeout,
  JudgeMeasurementSpawnFailed,
} from '../../bin/microverse-runner.js';
import { buildJudgeEnv } from '../../services/judge-spawn-env.js';

function makeEnoentError() {
  const err = new Error('spawn claude ENOENT');
  err.code = 'ENOENT';
  return err;
}

function makeEtimedoutError() {
  const err = new Error('spawnSync claude ETIMEDOUT');
  err.code = 'ETIMEDOUT';
  return err;
}

function makeGenericError() {
  return new Error('something went wrong');
}

function makeSpawnMock(steps, seenOptions = []) {
  return (_cmd, _args, opts) => {
    seenOptions.push(opts);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    process.nextTick(() => {
      const step = steps.shift() ?? { type: 'success', stdout: '' };
      if (step.type === 'error') {
        child.emit('error', step.error);
        return;
      }
      if (step.stdout) child.stdout.write(step.stdout);
      if (step.stderr) child.stderr.write(step.stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', step.code ?? 0, null);
    });
    return child;
  };
}

describe('classifyJudgeError', () => {
  test('ENOENT → cli_missing', () => {
    assert.deepEqual(classifyJudgeError(makeEnoentError()), { failureKind: 'cli_missing' });
  });

  test('ETIMEDOUT → timeout', () => {
    assert.deepEqual(classifyJudgeError(makeEtimedoutError()), { failureKind: 'timeout' });
  });

  test('generic error → unknown', () => {
    assert.deepEqual(classifyJudgeError(makeGenericError()), { failureKind: 'unknown' });
  });

  test('non-object → unknown', () => {
    assert.deepEqual(classifyJudgeError('a string error'), { failureKind: 'unknown' });
  });

  test('JudgeMeasurementTimeout → timeout with elapsed_ms', () => {
    const err = new JudgeMeasurementTimeout('judge timed out after 30s', 30000);
    const result = classifyJudgeError(err);
    assert.equal(result.failureKind, 'timeout');
    assert.equal(result.elapsed_ms, 30000);
  });

  test('JudgeMeasurementSpawnFailed ENOENT → cli_missing', () => {
    const err = new JudgeMeasurementSpawnFailed('spawn failed', 'ENOENT');
    assert.deepEqual(classifyJudgeError(err), { failureKind: 'cli_missing' });
  });

  test('JudgeMeasurementSpawnFailed other code → spawn_failed with cause_code', () => {
    const err = new JudgeMeasurementSpawnFailed('spawn failed', 'EACCES');
    const result = classifyJudgeError(err);
    assert.equal(result.failureKind, 'spawn_failed');
    assert.equal(result.cause_code, 'EACCES');
  });

  test('JudgeMeasurementTimeout instanceof check', () => {
    const err = new JudgeMeasurementTimeout('timed out', 5000);
    assert.ok(err instanceof JudgeMeasurementTimeout);
    assert.equal(err.kind, 'timeout');
    assert.equal(err.elapsed_ms, 5000);
  });

  test('JudgeMeasurementSpawnFailed instanceof check', () => {
    const err = new JudgeMeasurementSpawnFailed('spawn failed', 'ENOENT');
    assert.ok(err instanceof JudgeMeasurementSpawnFailed);
    assert.equal(err.kind, 'spawn_failed');
    assert.equal(err.cause_code, 'ENOENT');
  });
});

describe('probeJudgeBackendAvailability', () => {
  test('returns kind:ok on success', async () => {
    const previousLegacy = process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    const previousStateFile = process.env['PICKLE_STATE_FILE'];
    const previousClaudeCode = process.env['CLAUDECODE'];
    const previousPath = process.env['PATH'];
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    process.env['PICKLE_STATE_FILE'] = '/tmp/outer-state.json';
    process.env['CLAUDECODE'] = 'outer-session';
    process.env['PATH'] = '/usr/bin';
    const orig = _deps.spawn;
    const seenOptions = [];
    _deps.spawn = makeSpawnMock([{ type: 'success', stdout: 'claude/2.1.0' }], seenOptions);
    try {
      const result = await probeJudgeBackendAvailability('claude', '/tmp');
      assert.equal(result.kind, 'ok');
      assert.deepEqual(seenOptions[0]?.stdio, ['ignore', 'pipe', 'pipe']);
      assert.equal(seenOptions[0]?.env?.['PICKLE_STATE_FILE'], undefined);
      assert.equal(seenOptions[0]?.env?.['CLAUDECODE'], undefined);
      assert.equal(seenOptions[0]?.env?.['PATH'], '/usr/bin');
    } finally {
      _deps.spawn = orig;
      if (previousLegacy === undefined) delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
      else process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = previousLegacy;
      if (previousStateFile === undefined) delete process.env['PICKLE_STATE_FILE'];
      else process.env['PICKLE_STATE_FILE'] = previousStateFile;
      if (previousClaudeCode === undefined) delete process.env['CLAUDECODE'];
      else process.env['CLAUDECODE'] = previousClaudeCode;
      if (previousPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = previousPath;
    }
  });

  test('returns kind:missing on ENOENT', async () => {
    const previousLegacy = process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    const orig = _deps.spawn;
    _deps.spawn = makeSpawnMock([{ type: 'error', error: makeEnoentError() }]);
    try {
      const result = await probeJudgeBackendAvailability('claude', '/tmp');
      assert.equal(result.kind, 'missing');
      assert.ok('message' in result);
    } finally {
      _deps.spawn = orig;
      if (previousLegacy === undefined) delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
      else process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = previousLegacy;
    }
  });

  test('returns kind:timeout on ETIMEDOUT', async () => {
    const previousLegacy = process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    const orig = _deps.spawn;
    _deps.spawn = makeSpawnMock([{ type: 'error', error: makeEtimedoutError() }]);
    try {
      const result = await probeJudgeBackendAvailability('claude', '/tmp');
      assert.equal(result.kind, 'timeout');
      assert.ok('message' in result);
    } finally {
      _deps.spawn = orig;
      if (previousLegacy === undefined) delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
      else process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = previousLegacy;
    }
  });

  test('returns kind:failed on generic error', async () => {
    const previousLegacy = process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    const orig = _deps.spawn;
    _deps.spawn = makeSpawnMock([{ type: 'error', error: makeGenericError() }]);
    try {
      const result = await probeJudgeBackendAvailability('claude', '/tmp');
      assert.equal(result.kind, 'failed');
      assert.ok('message' in result);
    } finally {
      _deps.spawn = orig;
      if (previousLegacy === undefined) delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
      else process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = previousLegacy;
    }
  });
});

describe('measureLlmMetricWithBackoff — probe classification behavior', () => {
  test('ENOENT probe short-circuits to judge_cli_missing with attempts:0', async () => {
    const previousLegacy = process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    const orig = _deps.spawn;
    _deps.spawn = makeSpawnMock([{ type: 'error', error: makeEnoentError() }]);
    try {
      const result = await measureLlmMetricWithBackoff('fix bugs', 30, '/tmp');
      assert.equal(result.metric, null);
      assert.equal(result.exitReason, 'judge_cli_missing');
      assert.equal(result.attempts, 0);
    } finally {
      _deps.spawn = orig;
      if (previousLegacy === undefined) delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
      else process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = previousLegacy;
    }
  });

  test('ETIMEDOUT probe does NOT return judge_cli_missing — falls through to backoff loop', async () => {
    const previousLegacy = process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    const orig = { spawn: _deps.spawn, sleep: _deps.sleep };
    _deps.spawn = makeSpawnMock([
      { type: 'error', error: makeEtimedoutError() },
      { type: 'error', error: makeEtimedoutError() },
      { type: 'error', error: makeEtimedoutError() },
      { type: 'error', error: makeEtimedoutError() },
      { type: 'error', error: makeEtimedoutError() },
    ]);
    _deps.sleep = async () => {};
    try {
      const result = await measureLlmMetricWithBackoff('fix bugs', 30, '/tmp');
      assert.equal(result.metric, null);
      assert.notEqual(result.exitReason, 'judge_cli_missing',
        'ETIMEDOUT probe must NOT produce judge_cli_missing');
      assert.equal(result.exitReason, 'judge_timeout');
    } finally {
      _deps.spawn = orig.spawn;
      _deps.sleep = orig.sleep;
      if (previousLegacy === undefined) delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
      else process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = previousLegacy;
    }
  });

  test('backoff loop returns judge_timeout when all attempts time out', async () => {
    const previousLegacy = process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    const orig = { spawn: _deps.spawn, sleep: _deps.sleep };
    _deps.spawn = makeSpawnMock([
      { type: 'error', error: makeEtimedoutError() },
      { type: 'error', error: makeEtimedoutError() },
      { type: 'error', error: makeEtimedoutError() },
      { type: 'error', error: makeEtimedoutError() },
      { type: 'error', error: makeEtimedoutError() },
    ]);
    _deps.sleep = async () => {};
    try {
      const result = await measureLlmMetricWithBackoff('fix bugs', 30, '/tmp');
      assert.equal(result.exitReason, 'judge_timeout');
      assert.ok(result.attempts > 0, 'attempts should be > 0 (backoff ran)');
    } finally {
      _deps.spawn = orig.spawn;
      _deps.sleep = orig.sleep;
      if (previousLegacy === undefined) delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
      else process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = previousLegacy;
    }
  });

  test('codex session emits fallback telemetry when claude judge measurement succeeds', async () => {
    const previousLegacy = process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    const orig = {
      spawn: _deps.spawn,
      logActivity: _deps.logActivity,
    };
    const events = [];
    const seenOptions = [];
    let measurementCalls = 0;
    _deps.spawn = makeSpawnMock([
      { type: 'success', stdout: 'claude/2.1.0' },
      { type: 'success', stdout: '8' },
    ], seenOptions);
    _deps.logActivity = (event) => {
      events.push({ ts: new Date().toISOString(), ...event });
    };
    try {
      const result = await measureLlmMetricWithBackoff(
        'fix bugs',
        30,
        '/tmp',
        undefined,
        undefined,
        undefined,
        undefined,
        'codex',
        [],
        { session: 'session-1', iteration: 3, spawnContext: 'iteration' },
      );
      assert.deepEqual(result.metric, { raw: '8', score: 8 });
      measurementCalls = seenOptions.length - 1;
      assert.equal(measurementCalls, 1);
      assert.deepEqual(seenOptions[0]?.stdio, ['ignore', 'pipe', 'pipe']);
      assert.deepEqual(seenOptions[1]?.stdio, ['ignore', 'pipe', 'pipe']);
      assert.equal(events.length, 1);
      // R-SJET-3: nested_claude_detected and pre_spawn_env_key_names are
      // environment-dependent (depend on CLAUDE_CODE/CLAUDECODE and inherited
      // PATH-class keys). Extract them from the deepEqual and assert shape only.
      assert.equal(typeof events[0].gate_payload.nested_claude_detected, 'boolean');
      assert.ok(Array.isArray(events[0].gate_payload.pre_spawn_env_key_names));
      const {
        nested_claude_detected: _ncd,
        pre_spawn_env_key_names: _psekn,
        ...gateRest
      } = events[0].gate_payload;
      assert.deepEqual({ ...events[0], gate_payload: gateRest }, {
        ts: events[0].ts,
        event: 'judge_measurement_attempted',
        source: 'pickle',
        session: 'session-1',
        iteration: 3,
        backend: 'codex',
        judge_backend: 'claude',
        model: 'claude-sonnet-4-6',
        fallback_activated: true,
        spawn_context: 'iteration',
        gate_payload: {
          attempt: 1,
          elapsed_ms: events[0].gate_payload.elapsed_ms,
          outcome: 'success',
          timeout_class: null,
          probe_kind: 'ok',
        },
      });
      assert.equal(Number.isInteger(events[0].gate_payload.elapsed_ms), true);
      assert.equal(events[0].gate_payload.elapsed_ms >= 0, true);
    } finally {
      _deps.spawn = orig.spawn;
      _deps.logActivity = orig.logActivity;
      if (previousLegacy === undefined) delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
      else process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = previousLegacy;
    }
  });
});

// ---------------------------------------------------------------------------
// R-ORCG (b1bb51ca): no pickle-judge-* XDG_RUNTIME_DIR survives a judge spawn
// ---------------------------------------------------------------------------

function listPickleJudgeTmpDirs() {
  return new Set(fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('pickle-judge-')));
}

describe('R-ORCG: judge XDG_RUNTIME_DIR cleanup', () => {
  test('AC-3: probeJudgeBackendAvailability success (nested) leaves no pickle-judge-* dir', async () => {
    const previousClaudeCode = process.env['CLAUDECODE'];
    process.env['CLAUDECODE'] = 'outer-session';
    const orig = _deps.spawn;
    _deps.spawn = makeSpawnMock([{ type: 'success', stdout: 'claude/2.1.0' }]);
    const before = listPickleJudgeTmpDirs();
    try {
      const result = await probeJudgeBackendAvailability('claude', '/tmp');
      assert.equal(result.kind, 'ok');
    } finally {
      _deps.spawn = orig;
      if (previousClaudeCode === undefined) delete process.env['CLAUDECODE'];
      else process.env['CLAUDECODE'] = previousClaudeCode;
    }
    const after = listPickleJudgeTmpDirs();
    assert.deepEqual([...after].filter(d => !before.has(d)), [], 'no new pickle-judge-* dir should survive');
  });

  test('AC-3: probeJudgeBackendAvailability failure (nested, abnormal exit) still leaves no pickle-judge-* dir', async () => {
    const previousClaudeCode = process.env['CLAUDECODE'];
    process.env['CLAUDECODE'] = 'outer-session';
    const orig = _deps.spawn;
    _deps.spawn = makeSpawnMock([{ type: 'error', error: makeEnoentError() }]);
    const before = listPickleJudgeTmpDirs();
    try {
      const result = await probeJudgeBackendAvailability('claude', '/tmp');
      assert.equal(result.kind, 'missing');
    } finally {
      _deps.spawn = orig;
      if (previousClaudeCode === undefined) delete process.env['CLAUDECODE'];
      else process.env['CLAUDECODE'] = previousClaudeCode;
    }
    const after = listPickleJudgeTmpDirs();
    assert.deepEqual([...after].filter(d => !before.has(d)), [], 'no new pickle-judge-* dir should survive a spawn failure');
  });

  test('AC-3 + AC-3a: a full nested-claude measureLlmMetricWithBackoff success run leaves no pickle-judge-* dir (covers the probe, the attempt, and the :2593 telemetry-only key-names probe)', async () => {
    const previousClaudeCode = process.env['CLAUDECODE'];
    process.env['CLAUDECODE'] = 'outer-session';
    const orig = { spawn: _deps.spawn, logActivity: _deps.logActivity };
    _deps.spawn = makeSpawnMock([
      { type: 'success', stdout: 'claude/2.1.0' }, // probeJudgeBackendAvailability
      { type: 'success', stdout: '9' }, // measureLlmMetricAttempt
    ]);
    _deps.logActivity = () => {};
    const before = listPickleJudgeTmpDirs();
    try {
      const result = await measureLlmMetricWithBackoff('fix bugs', 30, '/tmp');
      assert.deepEqual(result.metric, { raw: '9', score: 9 });
    } finally {
      _deps.spawn = orig.spawn;
      _deps.logActivity = orig.logActivity;
      if (previousClaudeCode === undefined) delete process.env['CLAUDECODE'];
      else process.env['CLAUDECODE'] = previousClaudeCode;
    }
    const after = listPickleJudgeTmpDirs();
    assert.deepEqual([...after].filter(d => !before.has(d)), [], 'no new pickle-judge-* dir should survive a full measurement run');
  });

  test('AC-3a: nested pre_spawn_env_key_names — CONTENTS assertion (41 keys incl XDG_RUNTIME_DIR), not Array.isArray', () => {
    const filler = {};
    for (let i = 1; i <= 40; i++) filler[`FILLER_${i}`] = `v${i}`;
    const baseEnv = {
      ...filler,
      CLAUDECODE: 'outer-session',
      PICKLE_FOO_1: 'x',
      PICKLE_FOO_2: 'y',
      XDG_RUNTIME_DIR: '/run/user/1000',
    };
    assert.equal(Object.keys(baseEnv).length, 44, 'fixture precondition: 44-key baseEnv');
    const env = buildJudgeEnv('claude', true, baseEnv);
    try {
      const keys = Object.keys(env);
      assert.equal(keys.length, 41, 'nested env must have exactly 41 keys');
      assert.ok(keys.includes('XDG_RUNTIME_DIR'), 'nested env must include XDG_RUNTIME_DIR');
      assert.ok(!keys.includes('CLAUDECODE'), 'nested env must strip CLAUDECODE');
      assert.ok(!keys.includes('PICKLE_FOO_1'), 'nested env must strip PICKLE_* prefixed keys');
      assert.ok(!keys.includes('PICKLE_FOO_2'), 'nested env must strip PICKLE_* prefixed keys');
    } finally {
      try { fs.rmSync(env['XDG_RUNTIME_DIR'], { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  test('AC-3a: unnested (passthrough) pre_spawn_env_key_names — CONTENTS assertion (44 keys incl the 4 contamination markers), not Array.isArray', () => {
    const filler = {};
    for (let i = 1; i <= 40; i++) filler[`FILLER_${i}`] = `v${i}`;
    const baseEnv = {
      ...filler,
      PICKLE_BACKEND: 'placeholder',
      PICKLE_ROLE: 'manager',
      PICKLE_REFINEMENT_LOCK: '0',
      CLAUDECODE: 'outer-session',
    };
    assert.equal(Object.keys(baseEnv).length, 44, 'fixture precondition: 44-key baseEnv');
    const env = buildJudgeEnv('codex', false, baseEnv);
    const keys = Object.keys(env);
    assert.equal(keys.length, 44, 'unnested env must have exactly 44 keys');
    for (const marker of ['PICKLE_BACKEND', 'PICKLE_ROLE', 'PICKLE_REFINEMENT_LOCK', 'CLAUDECODE']) {
      assert.ok(keys.includes(marker), `unnested env must include contamination marker ${marker}`);
    }
  });

  test('AC-3a: the telemetry-only preSpawnEnvKeyNames probe (measureLlmMetricWithBackoff) creates no surviving pickle-judge-* dir even on immediate probe failure', async () => {
    const previousClaudeCode = process.env['CLAUDECODE'];
    process.env['CLAUDECODE'] = 'outer-session';
    const orig = { spawn: _deps.spawn, sleep: _deps.sleep };
    _deps.spawn = makeSpawnMock([{ type: 'error', error: makeEnoentError() }]);
    const before = listPickleJudgeTmpDirs();
    try {
      const result = await measureLlmMetricWithBackoff('fix bugs', 30, '/tmp');
      assert.equal(result.exitReason, 'judge_cli_missing');
    } finally {
      _deps.spawn = orig.spawn;
      _deps.sleep = orig.sleep;
      if (previousClaudeCode === undefined) delete process.env['CLAUDECODE'];
      else process.env['CLAUDECODE'] = previousClaudeCode;
    }
    const after = listPickleJudgeTmpDirs();
    assert.deepEqual([...after].filter(d => !before.has(d)), [], 'the cli_missing short-circuit must not leak the probe env dir');
  });
});

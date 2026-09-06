// @tier: fast
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  _deps,
  probeJudgeBackendAvailability,
  measureLlmMetricWithBackoff,
  classifyJudgeError,
  classifyMicroverseDisposition,
  JudgeMeasurementTimeout,
  JudgeMeasurementSpawnFailed,
  JUDGE_SYSTEM_PROMPT,
  buildJudgePrompt,
  parseLlmJudgeOutput,
} from '../../bin/microverse-runner.js';
import { classifyMicroverseHaltDecision, isFatalPhaseFailure } from '../../bin/pipeline-runner.js';
import { LATEST_SCHEMA_VERSION } from '../../types/index.js';
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
    // AC-3a: plant the contamination markers ourselves rather than reading
    // whatever the host happens to export. That is what makes the CONTENTS
    // assertions below deterministic — the pre-fix comment called this payload
    // "environment-dependent" and settled for Array.isArray, which cannot fail.
    const plantedEnv = {
      CLAUDECODE: '1',
      PICKLE_ROLE: 'probe-fixture',
      PICKLE_BACKEND: 'probe-fixture',
    };
    const previousPlanted = {};
    for (const [k, v] of Object.entries(plantedEnv)) {
      previousPlanted[k] = process.env[k];
      process.env[k] = v;
    }
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
      // AC-3a: `pre_spawn_env_key_names` is the SHIPPED observable proving the
      // R-SJET-3 DANGEROUS_PREFIXES strip happened at the runner's own probe
      // call site. Assert CONTENTS, not shape: passing `isNested=false` there
      // (or skipping the call) reports the outer session's contamination
      // markers as present — the exact condition R-SJET-3 detects — while a
      // tmpdir count still goes green. Pins are membership-based because the
      // key COUNT is host-dependent; the 41/44 counts stay pinned against the
      // synthetic fixture below. Include-assertions keep the exclude-assertions
      // from passing vacuously over an empty list.
      const keyNames = events[0].gate_payload.pre_spawn_env_key_names;
      assert.ok(Array.isArray(keyNames), 'pre_spawn_env_key_names must be an array');
      // We planted CLAUDECODE above, so the runner must have detected nesting.
      assert.equal(
        events[0].gate_payload.nested_claude_detected,
        true,
        'nested_claude_detected must be true when CLAUDECODE is set (mutating isNested to false fails here)',
      );
      for (const stripped of ['CLAUDECODE', 'PICKLE_ROLE', 'PICKLE_BACKEND']) {
        assert.ok(
          !keyNames.includes(stripped),
          `pre_spawn_env_key_names must NOT include the stripped marker ${stripped} — its presence means the nested branch did not run`,
        );
      }
      assert.ok(
        keyNames.includes('XDG_RUNTIME_DIR'),
        'pre_spawn_env_key_names must include XDG_RUNTIME_DIR — the nested branch substitutes an isolated runtime dir',
      );
      assert.ok(
        keyNames.includes('PATH'),
        'pre_spawn_env_key_names must include PATH — guards the exclude-assertions against a vacuously empty list',
      );
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
      // Restore by captured value, including the absent case — a bare delete
      // would clobber a marker the host legitimately exported.
      for (const k of Object.keys(plantedEnv)) {
        if (previousPlanted[k] === undefined) { delete process.env[k]; }
        else process.env[k] = previousPlanted[k];
      }
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
      if (previousClaudeCode === undefined) { delete process.env['CLAUDECODE']; }
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
      if (previousClaudeCode === undefined) { delete process.env['CLAUDECODE']; }
      else process.env['CLAUDECODE'] = previousClaudeCode;
    }
    const after = listPickleJudgeTmpDirs();
    assert.deepEqual([...after].filter(d => !before.has(d)), [], 'no new pickle-judge-* dir should survive a spawn failure');
  });

  test('AC-3 + AC-3a: a full nested-claude measureLlmMetricWithBackoff success run leaves no pickle-judge-* dir (covers the probe, the attempt, and the telemetry-only key-names probe)', async () => {
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
      if (previousClaudeCode === undefined) { delete process.env['CLAUDECODE']; }
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
      if (previousClaudeCode === undefined) { delete process.env['CLAUDECODE']; }
      else process.env['CLAUDECODE'] = previousClaudeCode;
    }
    const after = listPickleJudgeTmpDirs();
    assert.deepEqual([...after].filter(d => !before.has(d)), [], 'the cli_missing short-circuit must not leak the probe env dir');
  });
});

// ---------------------------------------------------------------------------
// R-JUNS (FR-B2, ticket 57cd73e0) — VERIFY-FIRST disposal.
//
// The filed defect says `mapJudgeMeasurementFailure` sends an unparseable judge answer through its
// `default:` arm to `baseline_unmeasurable_unrecoverable`, and asks for it to be routed to
// `baseline_unmeasurable_transient` instead. Measurement refutes the premise three ways:
//
//   1. That `default:` arm is STATICALLY UNREACHABLE. `JudgeFailureExitReason`
//      (microverse-runner.ts:99) has exactly three members and the switch cases all three. A parse
//      failure arrives at `case 'judge_timeout'` carrying `exhaustedFailureKind: 'failed'` and takes
//      the ternary's else branch. AC-JUNS-1 pins that arrival shape.
//   2. There is NO parse-failure-specific signal to route on. `exhaustedFailureKind: 'failed'` is
//      produced identically by an unparseable answer, a spawn EACCES and an unknown error, so
//      routing on it would make a genuine spawn failure retryable — the fail-open the ticket itself
//      forbids. (Documented, deliberately NOT pinned: the conflation is a residual, not a contract.)
//   3. The re-route would change NOTHING observable. AC-JUNS-2 pins that.
//
// What these tests deliberately do NOT pin is the mapping itself — that a parse failure yields
// `_unrecoverable` specifically. Freezing the disputed routing would block the very fix a future
// ticket might legitimately make. Commit 1b635b4c declined to pin R-JUNS for exactly this reason
// ("pinning a live defect would freeze the wrong contract"); these pins assert instead the
// invariant that holds under EITHER routing.
// ---------------------------------------------------------------------------

const PARSE_FAILURE_LAST_ERROR = 'judge output did not contain a numeric score';

/** Probe reply + four attempt replies (the backoff spends 1 + backoffsMs.length), none containing a
 *  numeric score. makeSpawnMock's own default reply is also non-numeric, so an arity drift degrades
 *  to "still a parse failure" rather than to a spurious pass. */
const UNPARSEABLE_JUDGE_STEPS = [
  { type: 'success', stdout: 'claude/2.1.0' },
  { type: 'success', stdout: 'I cannot score this codebase.' },
  { type: 'success', stdout: 'sorry, no rating available' },
  { type: 'success', stdout: 'unable to comply' },
  { type: 'success', stdout: 'no score' },
];

/** Every disposition observable any production consumer actually reads, for one exit reason.
 *  Answers through a real state.json so `isFatalPhaseFailure` runs the shipped `sm.read` path.
 *  schema_version MUST be current: a stale value makes `sm.read` throw, and `isFatalPhaseFailure`
 *  fails OPEN to `false` (pipeline-runner.ts:3225-3230) — every assertion would then pass for the
 *  wrong reason. Hence LATEST_SCHEMA_VERSION rather than a literal. */
function dispositionTuple(exitReason) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r-juns-'));
  try {
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      schema_version: LATEST_SCHEMA_VERSION,
      exit_reason: exitReason,
      start_commit: 'abc1234',
      status: 'stopped',
      tickets: [],
      activity: [],
    }));
    const runtime = { statePath, sessionDir: dir, workingDir: dir };
    return {
      haltAction: classifyMicroverseHaltDecision(exitReason).action,
      exitCode: classifyMicroverseDisposition(exitReason).exitCode,
      fatalOnAnatomyPark: isFatalPhaseFailure('anatomy-park', runtime),
      fatalOnSzechuanSauce: isFatalPhaseFailure('szechuan-sauce', runtime),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('R-JUNS: an unparseable judge answer never breaks the phase loop', () => {
  test('AC-JUNS-1: a parse failure exits as (judge_timeout, failed) and its reason does NOT abort — under either candidate routing', async () => {
    const previousLegacy = process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    const orig = { spawn: _deps.spawn, sleep: _deps.sleep };
    // Copy: makeSpawnMock drains its steps with shift(), so the shared const must not be consumed.
    _deps.spawn = makeSpawnMock([...UNPARSEABLE_JUDGE_STEPS]);
    _deps.sleep = async () => {};
    let result;
    try {
      result = await measureLlmMetricWithBackoff('fix bugs', 30, '/tmp');
    } finally {
      _deps.spawn = orig.spawn;
      _deps.sleep = orig.sleep;
      if (previousLegacy === undefined) delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
      else process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = previousLegacy;
    }

    // Precondition: this really was a PARSE failure. Without the lastError assertion the test would
    // pass just as well on a plain timeout, which lands in the same (exitReason, kind) shape — the
    // message is the only thing that distinguishes them, which is finding (2) above in miniature.
    assert.equal(result.metric, null);
    assert.equal(result.lastError, PARSE_FAILURE_LAST_ERROR,
      'the failure under test must be an unparseable answer, not a timeout wearing the same shape');
    assert.equal(result.exitReason, 'judge_timeout',
      'a parse failure reaches mapJudgeMeasurementFailure via case judge_timeout, NOT via default:');
    assert.equal(result.exhaustedFailureKind, 'failed');

    // The disposition half — this is the assertion the ticket asks for, made end-to-end on the
    // reason rather than on the mapping function's return value. Both the reason a parse failure
    // routes to today and the one FR-B2 proposes must leave the phase loop intact.
    for (const reason of ['baseline_unmeasurable_unrecoverable', 'baseline_unmeasurable_transient']) {
      const decision = classifyMicroverseHaltDecision(reason);
      assert.notEqual(decision.action, 'abort',
        `${reason} must never abort the phase (CLAUDE.md: a gate may never break the phase loop)`);
      assert.equal(decision.action, 'run-finalize-gate-incomplete', `${reason} routes to the incomplete finalize gate`);
    }
  });

  test('AC-JUNS-1-control: classifyMicroverseHaltDecision DOES return abort for a crash-floor input', () => {
    // Positive control for the pin above. Without it, AC-JUNS-1's `notEqual(action,'abort')`
    // would also pass if the function never returned 'abort' at all (e.g. stubbed to a constant),
    // asserting nothing.
    assert.equal(classifyMicroverseHaltDecision(undefined).action, 'abort',
      'the crash floor must still abort — otherwise the pin above discriminates nothing');
  });

  test('AC-JUNS-2: _transient and _unrecoverable are disposition-identical, so re-routing between them is a no-op', () => {
    const transient = dispositionTuple('baseline_unmeasurable_transient');
    const unrecoverable = dispositionTuple('baseline_unmeasurable_unrecoverable');

    // This is the measurement that disposes FR-B2: every observable a production consumer reads is
    // the same for both reasons, so routing parse failures from one to the other changes nothing.
    assert.deepEqual(transient, unrecoverable,
      'FR-B2 proposes re-routing between these two reasons; that is only meaningful if they differ');

    // The single field that DOES differ is the one no production consumer reads: all four
    // `reportAs` consumers collapse 'failure' and 'non-fatal-halt' identically
    // (pipeline-runner.ts:3186 and :5262, microverse-runner.ts:5776 and microverseExitCode).
    assert.equal(classifyMicroverseDisposition('baseline_unmeasurable_transient').reportAs, 'non-fatal-halt');
    assert.equal(classifyMicroverseDisposition('baseline_unmeasurable_unrecoverable').reportAs, 'failure');

    // TRIPWIRE, deliberate: if a later ticket legitimately demotes `baseline_unmeasurable_transient`
    // to arm-non-fatal (which needs tests/s529-classify-route.test.js:210,228 in its fence), this
    // deepEqual goes RED. That is the intended signal, not a brittle assertion: it means R-JUNS has
    // become live again and FR-B2 should be re-opened rather than left closed as a no-op.
  });

  test('AC-JUNS-2-control: the tuple discriminates on the HALT fields, not just the exit code', () => {
    // Positive control for AC-JUNS-2, paired so that only the `isFatalPhaseFailure` half can
    // decide it. `haltAction` and `exitCode` are computed from the reason alone and never read
    // state.json, so a pair differing on either of them keeps this arm green while both halt
    // fields are silently false — measured: with a fixture `sm.read` rejects, every
    // `isFatalPhaseFailure` call fails OPEN to false (pipeline-runner.ts:3225-3230), AC-JUNS-2's
    // deepEqual still passes, and a `converged` vs `_unrecoverable` control still passes too,
    // on the exitCode 0-vs-1 difference alone. These two reasons agree on both cheap fields, so
    // the collapse reddens this arm instead of hiding behind them.
    const halting = dispositionTuple('baseline_unmeasurable_unrecoverable');
    const nonHalting = dispositionTuple('stalled_below_target');

    assert.equal(halting.haltAction, nonHalting.haltAction,
      'the pair must agree on haltAction, or this arm can pass without reading state.json');
    assert.equal(halting.exitCode, nonHalting.exitCode,
      'the pair must agree on exitCode, or this arm can pass without reading state.json');
    assert.notDeepEqual(halting, nonHalting,
      'dispositionTuple must vary by reason on the halt fields, or AC-JUNS-2 compares two constants',
    );
  });
});

// R-JPCM: the judge's system prompt, the judge's user prompt, and the parser that reads the
// judge's reply are three surfaces that must describe ONE wire format. They drifted once already
// (b88d16ce, 2026-08-29): `buildJudgePrompt` had been aligned with `parseLlmJudgeOutput` by an
// earlier fix, but JUDGE_SYSTEM_PROMPT still demanded "a single line containing ONLY a number" —
// a contradiction a model can satisfy while obeying neither. b88d16ce collapsed both prompts onto
// one private JUDGE_OUTPUT_JSON_SCHEMA constant.
//
// That constant is NOT exported, so these pins deliberately do not reach for it. They read the
// prompt VALUES the judge is actually sent and round-trip the shape those prompts advertise
// through the real parser. That is the stronger instrument: it measures the contract as the judge
// experiences it, and it stays valid if the constant is ever renamed or restructured.
describe('R-JPCM judge output contract', () => {
  const SCHEMA_MARKER = 'matching this schema, and NOTHING else: ';

  /** Slice the advertised JSON schema object out of a prompt string. */
  function advertisedSchema(text) {
    const marked = text.indexOf(SCHEMA_MARKER);
    const from = marked >= 0 ? marked + SCHEMA_MARKER.length : 0;
    const line = text.slice(from).split('\n').find((l) => l.trim().startsWith('{"score"'));
    return (line ?? '').trim();
  }

  // The advertised schema is a TEMPLATE (`<number>`, `"high"|"med"|"low"`), not valid JSON, so
  // JSON.parse cannot be used. Scan for quoted keys at brace-depth 1 only.
  function topLevelKeys(schema) {
    const keys = [];
    let depth = 0;
    let inString = false;
    let current = '';
    for (let i = 0; i < schema.length; i++) {
      const ch = schema[i];
      if (inString) {
        if (ch === '"') {
          inString = false;
          if (depth === 1 && /^\s*:/.test(schema.slice(i + 1))) keys.push(current);
          current = '';
        } else {
          current += ch;
        }
        continue;
      }
      if (ch === '"') { inString = true; current = ''; continue; }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
    }
    return keys;
  }

  /** A judge reply built from exactly the keys the prompts advertise. */
  function responseForKeys(keys) {
    const byKey = {
      score: 3,
      violations: [{ id: 'v1', path: 'a.ts', line: 7, severity: 'high', description: 'd' }],
      resolved: [],
      new: ['v1'],
      remaining: [],
    };
    return Object.fromEntries(keys.map((k) => [k, byKey[k]]));
  }

  test('AC-JPCM-1: the system prompt and the user prompt advertise the same output schema', () => {
    const fromSystem = advertisedSchema(JUDGE_SYSTEM_PROMPT);
    const fromUser = advertisedSchema(buildJudgePrompt({ goal: 'g', cwd: '/tmp' }));

    // Anti-vacuity guard. Without it this test would pass if BOTH extractions returned '' — e.g.
    // if the marker prose were reworded — comparing two empty strings and reporting agreement
    // between two prompts it never actually read.
    assert.ok(fromSystem.includes('"score"'), 'no schema extracted from JUDGE_SYSTEM_PROMPT');
    assert.ok(fromUser.includes('"score"'), 'no schema extracted from buildJudgePrompt output');

    assert.equal(
      fromSystem,
      fromUser,
      'JUDGE_SYSTEM_PROMPT and buildJudgePrompt must advertise one wire format (R-JPCM)',
    );
  });

  test('AC-JPCM-2: the advertised shape is exactly what parseLlmJudgeOutput accepts as full', () => {
    const keys = topLevelKeys(advertisedSchema(JUDGE_SYSTEM_PROMPT));

    // Pin the SET, not just its usability: a schema that silently loses a key would otherwise
    // still round-trip, because the parser's own requirements would have shrunk with it.
    assert.deepEqual(keys, ['score', 'violations', 'resolved', 'new', 'remaining']);

    const parsed = parseLlmJudgeOutput(JSON.stringify(responseForKeys(keys)));
    assert.equal(parsed.shape, 'full', 'a reply obeying the advertised schema must parse as full');
    // TIER-1.4 B-SZLEDGER: score is derived from violations.length (1), not the
    // fixture's self-reported score of 3 — the ledger is authoritative now.
    assert.equal(parsed.score, 1);
    assert.equal(parsed.violations.length, 1);
    assert.deepEqual(parsed.new, ['v1']);
  });

  test('AC-JPCM-2-control: every advertised key is load-bearing in the parser', () => {
    // Control arm for AC-JPCM-2. Its green means nothing on its own: a parser that ignored its
    // input entirely — or one that no longer required these keys — would also return 'full'. This
    // arm proves the parser genuinely discriminates on each advertised key, so `full` is evidence.
    //
    // The key list is DERIVED from the advertised schema, not hardcoded, so a contract that grows
    // a key is covered automatically rather than silently escaping a stale enumeration.
    const keys = topLevelKeys(advertisedSchema(JUDGE_SYSTEM_PROMPT));
    const full = responseForKeys(keys);
    const arrayKeys = keys.filter((k) => Array.isArray(full[k]));
    assert.ok(arrayKeys.length > 0, 'no array keys derived — control arm would assert nothing');

    for (const omitted of arrayKeys) {
      const partial = responseForKeys(keys.filter((k) => k !== omitted));
      assert.notEqual(
        parseLlmJudgeOutput(JSON.stringify(partial)).shape,
        'full',
        `omitting "${omitted}" must not still parse as full, or the schema over-advertises`,
      );
    }

    // TIER-1.4 B-SZLEDGER: `score` is derived from violations.length in the full shape,
    // so a malformed self-reported score no longer degrades the result at all — the
    // ledger is authoritative regardless of what obj.score claims or how it is typed.
    const wrongType = { ...full, score: '3' };
    assert.equal(parseLlmJudgeOutput(JSON.stringify(wrongType)).score, full.violations.length);
  });
});

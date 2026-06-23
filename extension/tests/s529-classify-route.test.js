// @tier: fast
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  _deps,
  classifyJudgeError,
  measureLlmMetricWithBackoff,
  JudgeMeasurementTimeout,
} from '../bin/microverse-runner.js';
import { classifyMicroverseHaltDecision, isFatalPhaseFailure } from '../bin/pipeline-runner.js';

const TMP_DIRS = new Set();

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_DIRS.add(dir);
  return dir;
}

afterEach(() => {
  for (const d of TMP_DIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
  TMP_DIRS.clear();
});

function makeSpawnMock(steps) {
  return (_cmd, _args, _opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    process.nextTick(() => {
      const step = steps.shift() ?? { code: 0 };
      if (step.stderr) child.stderr.write(step.stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', step.code ?? 0, null);
    });
    return child;
  };
}

function writeStateWithExitReason(sessionDir, exitReason) {
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    active: false,
    working_dir: sessionDir,
    step: 'implement',
    iteration: 0,
    max_iterations: 100,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 's529 test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 3,
    backend: 'claude',
    exit_reason: exitReason,
  }, null, 2));
  return statePath;
}

describe('AC-S529-1: classifyJudgeError — 529/429 → rate_limited', () => {
  test('529 Overloaded message → rate_limited', () => {
    const err = new Error('API Error: 529 Overloaded');
    assert.deepEqual(classifyJudgeError(err), { failureKind: 'rate_limited' });
  });

  test('429 Too Many Requests message → rate_limited', () => {
    const err = new Error('API Error: 429 Too Many Requests');
    assert.deepEqual(classifyJudgeError(err), { failureKind: 'rate_limited' });
  });

  test('code 529 in error message → rate_limited', () => {
    const err = new Error('status 529');
    assert.deepEqual(classifyJudgeError(err), { failureKind: 'rate_limited' });
  });

  test('R-SJET-1b ordering: JudgeMeasurementTimeout with 529 text → timeout (instanceof wins)', () => {
    const err = new JudgeMeasurementTimeout('judge timed out 529 error', 30000);
    const result = classifyJudgeError(err);
    assert.equal(result.failureKind, 'timeout');
  });

  test('ETIMEDOUT takes priority over 529 text', () => {
    const err = new Error('ETIMEDOUT on 529 request');
    assert.deepEqual(classifyJudgeError(err), { failureKind: 'timeout' });
  });

  test('generic error without 529/429 → unknown', () => {
    assert.deepEqual(classifyJudgeError(new Error('something else failed')), { failureKind: 'unknown' });
  });
});

describe('backoff exhaustion: all-429 attempts → exhaustedFailureKind rate_limited', () => {
  test('probe ok + 4x 429 failures → metric null, exhaustedFailureKind rate_limited', async () => {
    const previousLegacy = process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    const orig = _deps.spawn;
    const origSleep = _deps.sleep;
    const origParkMaxMs = _deps.metricParkMaxMs;
    _deps.sleep = async () => {};
    // Disable park ceiling so this test stays a pure backoff-exhaustion check.
    _deps.metricParkMaxMs = 0;
    // probe (exit 0 success) + 4 attempts (exit 1 with 429 stderr)
    _deps.spawn = makeSpawnMock([
      { code: 0, stderr: 'claude/2.1.0' },
      { code: 1, stderr: 'API Error: 429 Too Many Requests' },
      { code: 1, stderr: 'API Error: 429 Too Many Requests' },
      { code: 1, stderr: 'API Error: 429 Too Many Requests' },
      { code: 1, stderr: 'API Error: 429 Too Many Requests' },
    ]);
    try {
      const result = await measureLlmMetricWithBackoff('improve coverage', 1, '/tmp');
      assert.equal(result.metric, null);
      assert.ok('exhaustedFailureKind' in result, 'result must have exhaustedFailureKind');
      assert.equal(result.exhaustedFailureKind, 'rate_limited');
    } finally {
      _deps.spawn = orig;
      _deps.sleep = origSleep;
      _deps.metricParkMaxMs = origParkMaxMs;
      if (previousLegacy === undefined) delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
      else process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = previousLegacy;
    }
  });

  test('probe ok + mix of timeout then 429 → exhaustedFailureKind timeout (timeout wins)', async () => {
    const previousLegacy = process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    const orig = _deps.spawn;
    const origSleep = _deps.sleep;
    _deps.sleep = async () => {};
    // probe ok; attempt 1 = timeout error; attempts 2-4 = 429
    _deps.spawn = makeSpawnMock([
      { code: 0 },
      { code: 1, stderr: 'ETIMEDOUT' },
      { code: 1, stderr: 'API Error: 429 Too Many Requests' },
      { code: 1, stderr: 'API Error: 429 Too Many Requests' },
      { code: 1, stderr: 'API Error: 429 Too Many Requests' },
    ]);
    try {
      const result = await measureLlmMetricWithBackoff('improve coverage', 1, '/tmp');
      assert.equal(result.metric, null);
      assert.ok('exhaustedFailureKind' in result);
      assert.equal(result.exhaustedFailureKind, 'timeout');
    } finally {
      _deps.spawn = orig;
      _deps.sleep = origSleep;
      if (previousLegacy === undefined) delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
      else process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = previousLegacy;
    }
  });
});

describe('AC-S529-4: isFatalPhaseFailure + classifyMicroverseHaltDecision', () => {
  test('classifyMicroverseHaltDecision(baseline_unmeasurable_transient) → run-finalize-gate-incomplete', () => {
    const decision = classifyMicroverseHaltDecision('baseline_unmeasurable_transient');
    assert.equal(decision.action, 'run-finalize-gate-incomplete');
    assert.equal(decision.recognizedExitReason, 'baseline_unmeasurable_transient');
  });

  test('isFatalPhaseFailure anatomy-park with baseline_unmeasurable_transient → true', () => {
    const sessionDir = tmpDir('s529-fatal-');
    const statePath = writeStateWithExitReason(sessionDir, 'baseline_unmeasurable_transient');
    const runtime = {
      sessionDir,
      extensionRoot: process.cwd(),
      statePath,
      config: { phases: ['anatomy-park'], target: sessionDir },
      target: sessionDir,
      workingDir: sessionDir,
      repoRoot: sessionDir,
      backend: 'claude',
      phaseEnv: {},
      log: () => {},
    };
    assert.equal(isFatalPhaseFailure('anatomy-park', runtime), true);
  });

  test('isFatalPhaseFailure szechuan-sauce with baseline_unmeasurable_transient → true', () => {
    const sessionDir = tmpDir('s529-fatal-sz-');
    const statePath = writeStateWithExitReason(sessionDir, 'baseline_unmeasurable_transient');
    const runtime = {
      sessionDir,
      extensionRoot: process.cwd(),
      statePath,
      config: { phases: ['szechuan-sauce'], target: sessionDir },
      target: sessionDir,
      workingDir: sessionDir,
      repoRoot: sessionDir,
      backend: 'claude',
      phaseEnv: {},
      log: () => {},
    };
    assert.equal(isFatalPhaseFailure('szechuan-sauce', runtime), true);
  });
});

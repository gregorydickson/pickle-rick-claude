// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  _deps,
  executeGapAnalysis,
  measureAndClassifyIteration,
} from '../bin/microverse-runner.js';
import { readMicroverseState } from '../services/microverse-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(__dirname, '..');

function createTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-microverse-baseline-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'init');
  execSync('git add .', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function createSessionDir(workingDir) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mv-baseline-session-'));
  const runnerState = {
    active: true,
    working_dir: workingDir,
    step: 'implement',
    iteration: 0,
    max_iterations: 10,
    max_time_minutes: 60,
    worker_timeout_seconds: 120,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: dir,
    tmux_mode: true,
    command_template: 'microverse.md',
    backend: 'claude',
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(runnerState, null, 2));
  const mvState = {
    status: 'gap_analysis',
    prd_path: '/tmp/prd.md',
    key_metric: {
      description: 'judge quality gate',
      validation: 'improve code quality',
      type: 'llm',
      timeout_seconds: 60,
      tolerance: 0,
      judge_model: 'claude-sonnet-4-6',
    },
    convergence: { stall_limit: 3, stall_counter: 0, history: [] },
    gap_analysis_path: '',
    failed_approaches: [],
    baseline_score: 0,
  };
  fs.writeFileSync(path.join(dir, 'microverse.json'), JSON.stringify(mvState, null, 2));
  return { dir, runnerState };
}

function makeContext(sessionDir, runnerState, workingDir) {
  return {
    sessionDir,
    extensionRoot,
    statePath: path.join(sessionDir, 'state.json'),
    workingDir,
    startTime: Date.now(),
    initialIteration: 0,
    enableFailureClassification: false,
    cgSettings: {
      enabled_convergence_files: [],
      regression_warning_threshold: 5,
      remediator_timeout_s: 600,
      baseline_max_age_iterations: 30,
      baseline_max_age_seconds: 14_400,
    },
    rateLimitWaitMinutes: 0,
    maxRateLimitRetries: 0,
    log: () => {},
    currentRunnerState: runnerState,
    iteration: 0,
    consecutiveRateLimits: 0,
  };
}

function makeSpawnError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const makeEtimedoutError = () => makeSpawnError('spawnSync claude ETIMEDOUT', 'ETIMEDOUT');
const makeEnoentError = () => makeSpawnError('spawnSync claude ENOENT', 'ENOENT');
const makeUnsupportedModelError = () => new Error('claude-sonnet-4-6 model is not supported when using Codex with a ChatGPT account');
const makeSchemaInvalidError = () => new Error('schema-invalid: response payload did not satisfy the expected schema');

async function runBaselineFailureScenario({ probeResult = 'ok', attemptErrorFactory }) {
  process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = '1';
  const original = {
    execFileSync: _deps.execFileSync,
    runIteration: _deps.runIteration,
    sleep: _deps.sleep,
  };
  const workingDir = createTempGitRepo();
  const session = createSessionDir(workingDir);
  const ctx = makeContext(session.dir, session.runnerState, workingDir);
  let measurementCalls = 0;

  _deps.runIteration = async () => ({
    completion: 'success',
    timedOut: false,
    exitCode: 0,
    wallSeconds: 1,
  });
  _deps.sleep = async () => {};
  _deps.execFileSync = (_cmd, args) => {
    if (Array.isArray(args) && args[0] === '--version') {
      if (probeResult === 'timeout') throw makeEtimedoutError();
      if (probeResult === 'missing') throw makeEnoentError();
      if (probeResult === 'failed') throw attemptErrorFactory();
      return 'Claude Code 2.1.126';
    }
    measurementCalls++;
    throw attemptErrorFactory();
  };

  try {
    await assert.rejects(
      executeGapAnalysis(readMicroverseState(session.dir), ctx),
      (err) => err?.name === 'MicroverseExitError',
    );
    return {
      persisted: readMicroverseState(session.dir),
      measurementCalls,
    };
  } finally {
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    _deps.execFileSync = original.execFileSync;
    _deps.runIteration = original.runIteration;
    _deps.sleep = original.sleep;
    fs.rmSync(session.dir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
}

describe('microverse-baseline-classification', () => {
  test('all attempts ETIMEDOUT -> judge_timeout transient', async () => {
    const { persisted, measurementCalls } = await runBaselineFailureScenario({
      probeResult: 'ok',
      attemptErrorFactory: makeEtimedoutError,
    });

    assert.equal(measurementCalls > 0, true);
    assert.equal(persisted.exit_reason, 'judge_timeout');
    assert.equal(persisted.status, 'stopped');
  });

  test('ENOENT -> judge_cli_missing fatal', async () => {
    const { persisted, measurementCalls } = await runBaselineFailureScenario({
      probeResult: 'ok',
      attemptErrorFactory: makeEnoentError,
    });

    assert.equal(measurementCalls > 0, true);
    assert.equal(persisted.exit_reason, 'judge_cli_missing');
    assert.equal(persisted.status, 'stopped');
  });

  test('unsupported-model -> metric_unmeasurable_unrecoverable fatal', async () => {
    const { persisted, measurementCalls } = await runBaselineFailureScenario({
      probeResult: 'ok',
      attemptErrorFactory: makeUnsupportedModelError,
    });

    assert.equal(measurementCalls > 0, true);
    assert.equal(persisted.exit_reason, 'metric_unmeasurable_unrecoverable');
    assert.equal(persisted.status, 'stopped');
  });

  test('schema-invalid -> metric_unmeasurable_unrecoverable fatal', async () => {
    const { persisted, measurementCalls } = await runBaselineFailureScenario({
      probeResult: 'ok',
      attemptErrorFactory: makeSchemaInvalidError,
    });

    assert.equal(measurementCalls > 0, true);
    assert.equal(persisted.exit_reason, 'metric_unmeasurable_unrecoverable');
    assert.equal(persisted.status, 'stopped');
  });

  test('iteration ETIMEDOUT attempts emit baseline_attempt_timeout telemetry per attempt', async () => {
    process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = '1';
    const original = {
      execFileSync: _deps.execFileSync,
      sleep: _deps.sleep,
      logActivity: _deps.logActivity,
    };
    const workingDir = createTempGitRepo();
    const session = createSessionDir(workingDir);
    const ctx = makeContext(session.dir, session.runnerState, workingDir);
    const events = [];

    _deps.sleep = async () => {};
    _deps.execFileSync = (_cmd, args) => {
      if (Array.isArray(args) && args[0] === '--version') return 'Claude Code 2.1.126';
      throw makeEtimedoutError();
    };
    _deps.logActivity = (event) => {
      events.push({ ts: new Date().toISOString(), ...event });
    };

    try {
      const state = readMicroverseState(session.dir);
      state.status = 'iterating';
      state.baseline_score = 40;
      state.key_metric = {
        description: 'judge quality gate',
        validation: 'improve code quality',
        type: 'llm',
        timeout_seconds: 60,
        tolerance: 0,
        judge_model: 'claude-sonnet-4-6',
      };
      state.convergence = { stall_limit: 3, stall_counter: 0, history: [] };

      const result = await measureAndClassifyIteration(state, { raw: '40', score: 40 }, ctx);
      assert.deepEqual(result, { kind: 'failed', exitReason: 'judge_timeout' });

      const timeoutEvents = events.filter((event) => event.event === 'baseline_attempt_timeout');
      assert.equal(timeoutEvents.length, 4, 'iteration retries should emit four timeout events');
      timeoutEvents.forEach((event, index) => {
        assert.equal(event.session, path.basename(session.dir));
        assert.equal(event.iteration, ctx.iteration);
        assert.equal(event.gate_payload.attempt, index + 1);
        assert.equal(event.gate_payload.classifier, 'timeout');
        assert.equal(Number.isInteger(event.gate_payload.elapsed_ms), true);
        assert.equal(event.gate_payload.elapsed_ms >= 0, true);
      });
    } finally {
      delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
      _deps.execFileSync = original.execFileSync;
      _deps.sleep = original.sleep;
      _deps.logActivity = original.logActivity;
      fs.rmSync(session.dir, { recursive: true, force: true });
      fs.rmSync(workingDir, { recursive: true, force: true });
    }
  });

  test('iteration unsupported-model failures stay fatal instead of degrading to judge_timeout', async () => {
    process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = '1';
    const original = {
      execFileSync: _deps.execFileSync,
      sleep: _deps.sleep,
    };
    const workingDir = createTempGitRepo();
    const session = createSessionDir(workingDir);
    const ctx = makeContext(session.dir, session.runnerState, workingDir);

    _deps.sleep = async () => {};
    _deps.execFileSync = (_cmd, args) => {
      if (Array.isArray(args) && args[0] === '--version') return 'Claude Code 2.1.126';
      throw makeUnsupportedModelError();
    };

    try {
      const state = readMicroverseState(session.dir);
      state.status = 'iterating';
      state.baseline_score = 40;
      state.key_metric = {
        description: 'judge quality gate',
        validation: 'improve code quality',
        type: 'llm',
        timeout_seconds: 60,
        tolerance: 0,
        judge_model: 'claude-sonnet-4-6',
      };
      state.convergence = { stall_limit: 3, stall_counter: 0, history: [] };

      const result = await measureAndClassifyIteration(state, { raw: '40', score: 40 }, ctx);
      assert.deepEqual(result, { kind: 'failed', exitReason: 'metric_unmeasurable_unrecoverable' });
    } finally {
      delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
      _deps.execFileSync = original.execFileSync;
      _deps.sleep = original.sleep;
      fs.rmSync(session.dir, { recursive: true, force: true });
      fs.rmSync(workingDir, { recursive: true, force: true });
    }
  });

  test('successful codex-session measurement emits fallback telemetry and preserves late-baseline behavior', async () => {
    process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = '1';
    const original = {
      execFileSync: _deps.execFileSync,
      sleep: _deps.sleep,
      logActivity: _deps.logActivity,
    };
    const workingDir = createTempGitRepo();
    const session = createSessionDir(workingDir);
    const ctx = makeContext(session.dir, { ...session.runnerState, backend: 'codex' }, workingDir);
    const events = [];

    _deps.sleep = async () => {};
    _deps.execFileSync = (_cmd, args) => {
      if (Array.isArray(args) && args[0] === '--version') return 'Claude Code 2.1.126';
      return '7';
    };
    _deps.logActivity = (event) => {
      events.push({ ts: new Date().toISOString(), ...event });
    };

    try {
      const state = readMicroverseState(session.dir);
      state.status = 'iterating';
      state.baseline_score = 0;
      state.key_metric = {
        description: 'judge quality gate',
        validation: 'improve code quality',
        type: 'llm',
        timeout_seconds: 60,
        tolerance: 0,
        judge_model: 'claude-sonnet-4-6',
      };
      state.convergence = { stall_limit: 3, stall_counter: 0, history: [] };

      const result = await measureAndClassifyIteration(state, { raw: '', score: 0 }, ctx);
      assert.deepEqual(result, { kind: 'unchanged' });
      assert.equal(state.baseline_score, 7, 'late baseline should still be adopted on success');

      const attemptedEvents = events.filter((event) => event.event === 'judge_measurement_attempted');
      assert.equal(attemptedEvents.length, 1);
      assert.equal(attemptedEvents[0].backend, 'codex');
      assert.equal(attemptedEvents[0].judge_backend, 'claude');
      assert.equal(attemptedEvents[0].fallback_activated, true);
      assert.equal(attemptedEvents[0].spawn_context, 'iteration');
      assert.equal(attemptedEvents[0].gate_payload.attempt, 1);
      assert.equal(attemptedEvents[0].gate_payload.outcome, 'success');
      assert.equal(attemptedEvents[0].gate_payload.timeout_class, null);
      assert.equal(attemptedEvents[0].gate_payload.probe_kind, 'ok');

      const timeoutEvents = events.filter((event) => event.event === 'baseline_attempt_timeout');
      assert.equal(timeoutEvents.length, 0);
    } finally {
      delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
      _deps.execFileSync = original.execFileSync;
      _deps.sleep = original.sleep;
      _deps.logActivity = original.logActivity;
      fs.rmSync(session.dir, { recursive: true, force: true });
      fs.rmSync(workingDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Z2 (GitHub #25). The shared judge/command measurement mapper named every non-timeout failure
// after ONE of its two callers (`baseline_unmeasurable_*`), so session 2026-09-14-ec274d75 logged
// "LLM baseline metric: 3" and then, eleven minutes later, an ITERATION parse failure as
// `baseline_unmeasurable_unrecoverable`. The reason now names the failure; the phase rides beside it.
// ---------------------------------------------------------------------------

const UNPARSEABLE_JUDGE_ANSWER = 'I cannot score this codebase.';
const BASELINE_PREFIXED = /\bbaseline_unmeasurable/;

/** Runs `fn` with the legacy judge spawn, a no-op sleep, and captured activity + log lines. */
async function withCapturedJudge(judgeAnswer, fn) {
  process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = '1';
  const original = { execFileSync: _deps.execFileSync, sleep: _deps.sleep, logActivity: _deps.logActivity, runIteration: _deps.runIteration };
  const workingDir = createTempGitRepo();
  const session = createSessionDir(workingDir);
  const logs = [];
  const events = [];
  const ctx = { ...makeContext(session.dir, session.runnerState, workingDir), log: (line) => logs.push(line) };
  const judge = { answer: judgeAnswer };
  _deps.sleep = async () => {};
  _deps.runIteration = async () => ({ completion: 'success', timedOut: false, exitCode: 0, wallSeconds: 1 });
  _deps.execFileSync = (_cmd, args) => {
    if (Array.isArray(args) && args[0] === '--version') return 'Claude Code 2.1.126';
    return judge.answer;
  };
  _deps.logActivity = (event) => { events.push(event); };
  try {
    return await fn({ session, ctx, logs, events, judge });
  } finally {
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    Object.assign(_deps, original);
    fs.rmSync(session.dir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
}

const terminalFailureEvents = (events) => events.filter((e) => e.gate_payload && 'phase' in e.gate_payload);

describe('Z2: metric_unmeasurable_* names the failure, the phase is a separate field', () => {
  test('Z2-2 (control, baseline): a genuine baseline failure records phase baseline', async () => {
    await withCapturedJudge(UNPARSEABLE_JUDGE_ANSWER, async ({ session, ctx, logs, events }) => {
      await assert.rejects(
        executeGapAnalysis(readMicroverseState(session.dir), ctx),
        (err) => err?.name === 'MicroverseExitError',
      );
      assert.equal(readMicroverseState(session.dir).exit_reason, 'metric_unmeasurable_unrecoverable');
      const terminal = terminalFailureEvents(events);
      assert.equal(terminal.length, 1, 'exactly one terminal measurement-failure event');
      assert.equal(terminal[0].event, 'metric_unmeasurable');
      assert.equal(terminal[0].gate_payload.phase, 'baseline');
      assert.ok(logs.some((l) => /metric_unmeasurable_unrecoverable, phase: baseline/.test(l)), logs.join('\n'));
    });
  });

  test('Z2-3 (control, iteration): the ec274d75 worked case — baseline succeeds, the iteration fails, nothing is baseline-prefixed', async () => {
    await withCapturedJudge('3', async ({ session, ctx, logs, events, judge }) => {
      const state = readMicroverseState(session.dir);
      await executeGapAnalysis(state, ctx);
      assert.equal(state.baseline_score, 3, 'precondition: the baseline measurement succeeded');

      logs.length = 0;
      events.length = 0;
      judge.answer = UNPARSEABLE_JUDGE_ANSWER;
      state.status = 'iterating';
      const result = await measureAndClassifyIteration(state, { raw: '3', score: 3 }, ctx);

      assert.deepEqual(result, { kind: 'failed', exitReason: 'metric_unmeasurable_unrecoverable' });
      const terminal = terminalFailureEvents(events);
      assert.equal(terminal.length, 1, 'exactly one terminal measurement-failure event');
      assert.equal(terminal[0].event, 'metric_unmeasurable');
      assert.equal(terminal[0].gate_payload.phase, 'iteration');
      assert.ok(logs.some((l) => /metric_unmeasurable_unrecoverable, phase: iteration/.test(l)), logs.join('\n'));

      assert.doesNotMatch(result.exitReason, BASELINE_PREFIXED);
      for (const e of events) assert.doesNotMatch(e.event, BASELINE_PREFIXED, `event ${e.event}`);
      for (const l of logs) assert.doesNotMatch(l, BASELINE_PREFIXED, `log line: ${l}`);
    });
  });
});

describe('Z2-4 / Z2-5: legacy spellings read and classify identically; the renamed dispositions are unchanged', () => {
  /** Every disposition observable a production consumer reads, through a REAL state.json and `sm.read`. */
  async function dispositionTuple(exitReason) {
    const [{ classifyMicroverseHaltDecision, isFatalPhaseFailure }, { classifyMicroverseDisposition }, { StateManager }, { LATEST_SCHEMA_VERSION }] = await Promise.all([
      import('../bin/pipeline-runner.js'),
      import('../bin/microverse-runner.js'),
      import('../services/state-manager.js'),
      import('../types/index.js'),
    ]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z2-disposition-'));
    try {
      const statePath = path.join(dir, 'state.json');
      fs.writeFileSync(statePath, JSON.stringify({
        schema_version: LATEST_SCHEMA_VERSION, exit_reason: exitReason, start_commit: 'abc1234',
        status: 'stopped', tickets: [], activity: [],
      }));
      const runtime = { statePath, sessionDir: dir, workingDir: dir };
      const readBack = new StateManager().read(statePath).exit_reason;
      const { reportAs, exitCode } = classifyMicroverseDisposition(exitReason);
      return {
        readBack,
        reportAs,
        exitCode,
        haltAction: classifyMicroverseHaltDecision(exitReason).action,
        haltActionAfterRead: classifyMicroverseHaltDecision(readBack).action,
        fatalOnAnatomyPark: isFatalPhaseFailure('anatomy-park', runtime),
        fatalOnSzechuanSauce: isFatalPhaseFailure('szechuan-sauce', runtime),
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Sibling reasons whose dispositions this change does NOT touch — the non-circular anchor for the old values. */
  const UNTOUCHED_SIBLING = {
    metric_unmeasurable_transient: 'all_judge_backends_exhausted',
    metric_unmeasurable_unrecoverable: 'judge_cli_missing',
  };

  test('Z2-4: a persisted legacy exit_reason reads back renamed and classifies identically', async () => {
    const { LEGACY_MICROVERSE_EXIT_REASON_RENAMES } = await import('../types/index.js');
    const pairs = Object.entries(LEGACY_MICROVERSE_EXIT_REASON_RENAMES);
    assert.equal(pairs.length, 3, 'bare, _transient and _unrecoverable');
    for (const [legacy, current] of pairs) {
      const legacyTuple = await dispositionTuple(legacy);
      const currentTuple = await dispositionTuple(current);
      assert.equal(legacyTuple.readBack, current, `${legacy} must read back as ${current}`);
      assert.notEqual(legacyTuple.haltAction, 'abort', `${legacy} must never abort`);
      assert.deepEqual(legacyTuple, currentTuple, `${legacy} must classify exactly as ${current}`);
    }
  });

  test('Z2-5: each renamed reason keeps its old reportAs / exitCode / fatal-ness / halt action', async () => {
    for (const [renamed, sibling] of Object.entries(UNTOUCHED_SIBLING)) {
      const renamedTuple = await dispositionTuple(renamed);
      const siblingTuple = await dispositionTuple(sibling);
      const { readBack: _r, ...renamedObservables } = renamedTuple;
      const { readBack: _s, ...siblingObservables } = siblingTuple;
      assert.deepEqual(renamedObservables, siblingObservables,
        `${renamed} must keep the disposition it shared with ${sibling} before the rename`);
    }
    const transient = await dispositionTuple('metric_unmeasurable_transient');
    const unrecoverable = await dispositionTuple('metric_unmeasurable_unrecoverable');
    assert.notEqual(transient.reportAs, unrecoverable.reportAs,
      'control: the tuple discriminates the two renamed reasons, so the parity above is not a constant');
    assert.equal(transient.haltAction, 'run-finalize-gate-incomplete');
    assert.equal(unrecoverable.fatalOnAnatomyPark, true);
  });
});

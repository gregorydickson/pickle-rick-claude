// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  executeMainLoop,
  measureAndClassifyIteration,
  parseLlmJudgeOutput,
  _deps,
} from '../bin/microverse-runner.js';
import {
  createMicroverseState,
  readMicroverseState,
  writeMicroverseState,
  generateViolationId,
  updateViolationLedger,
} from '../services/microverse-state.js';

function makeTempDir(prefix = 'pickle-mv-helper-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeRunnerState(sessionDir, workingDir, overrides = {}) {
  return {
    active: true,
    working_dir: workingDir,
    step: 'implement',
    iteration: 0,
    max_iterations: 10,
    max_time_minutes: 60,
    worker_timeout_seconds: 0,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    tmux_mode: true,
    command_template: 'microverse.md',
    ...overrides,
  };
}

function makeMetric(validation) {
  return {
    description: 'score',
    validation,
    type: 'command',
    timeout_seconds: 5,
    tolerance: 2,
    direction: 'higher',
  };
}

function makeContext(sessionDir, workingDir, state, overrides = {}) {
  return {
    sessionDir,
    extensionRoot: path.resolve('.'),
    statePath: path.join(sessionDir, 'state.json'),
    workingDir,
    startTime: Date.now(),
    initialIteration: 0,
    enableFailureClassification: false,
    cgSettings: {
      enabled_convergence_files: ['anatomy-park.json'],
      regression_warning_threshold: 5,
      remediator_timeout_s: 600,
      baseline_max_age_iterations: 30,
      baseline_max_age_seconds: 14_400,
    },
    rateLimitWaitMinutes: 1,
    maxRateLimitRetries: 1,
    log: () => {},
    currentRunnerState: state,
    iteration: 1,
    consecutiveRateLimits: 0,
    preIterSha: 'pre',
    postIterSha: 'post',
    ...overrides,
  };
}

function makeSession(score) {
  const sessionDir = makeTempDir();
  const workingDir = makeTempDir();
  const scoreFile = path.join(workingDir, 'score.txt');
  fs.writeFileSync(scoreFile, `${score}\n`);
  const runnerState = makeRunnerState(sessionDir, workingDir);
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(runnerState, null, 2));
  const mv = createMicroverseState({
    prdPath: path.join(workingDir, 'prd.md'),
    metric: makeMetric('cat score.txt'),
    stallLimit: 5,
  });
  mv.status = 'iterating';
  mv.baseline_score = 50;
  writeMicroverseState(sessionDir, mv);
  return { sessionDir, workingDir, scoreFile, runnerState, mv };
}

test('measureAndClassifyIteration returns improved and records accepted history', async () => {
  const { sessionDir, workingDir, runnerState, mv } = makeSession(60);
  try {
    const ctx = makeContext(sessionDir, workingDir, runnerState);
    const result = await measureAndClassifyIteration(mv, { raw: '50', score: 50 }, ctx);
    assert.equal(result.kind, 'improved');
    assert.equal(mv.convergence.history[0].classification, 'improved');
    assert.equal(readMicroverseState(sessionDir).convergence.history[0].action, 'accept');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('measureAndClassifyIteration returns regressed and rolls back', async () => {
  const { sessionDir, workingDir, runnerState, mv } = makeSession(40);
  const originalReset = _deps.resetToSha;
  let rolledBackTo = null;
  try {
    _deps.resetToSha = (sha) => { rolledBackTo = sha; };
    const ctx = makeContext(sessionDir, workingDir, runnerState, { preIterSha: 'rollback-sha' });
    const result = await measureAndClassifyIteration(mv, { raw: '50', score: 50 }, ctx);
    assert.deepEqual(result, { kind: 'regressed', rollback: true });
    assert.equal(rolledBackTo, 'rollback-sha');
    assert.equal(mv.convergence.history[0].action, 'revert');
    assert.equal(mv.failed_approaches.length, 1);
  } finally {
    _deps.resetToSha = originalReset;
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('measureAndClassifyIteration returns unchanged for held score and increments stall', async () => {
  const { sessionDir, workingDir, runnerState, mv } = makeSession(51);
  try {
    const ctx = makeContext(sessionDir, workingDir, runnerState);
    const result = await measureAndClassifyIteration(mv, { raw: '50', score: 50 }, ctx);
    assert.deepEqual(result, { kind: 'unchanged' });
    assert.equal(mv.convergence.history[0].classification, 'held');
    assert.equal(mv.convergence.stall_counter, 1);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('measureAndClassifyIteration returns failed judge_timeout for command metric timeouts', async () => {
  const { sessionDir, workingDir, runnerState, mv } = makeSession(60);
  mv.key_metric.validation = 'sleep 10 && echo 60';
  mv.key_metric.timeout_seconds = 1;
  try {
    const ctx = makeContext(sessionDir, workingDir, runnerState);
    const result = await measureAndClassifyIteration(mv, { raw: '50', score: 50 }, ctx);
    assert.deepEqual(result, { kind: 'failed', exitReason: 'judge_timeout' });
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('measureAndClassifyIteration returns failed baseline_unmeasurable_unrecoverable on command metric spawn failure', async () => {
  const { sessionDir, workingDir, runnerState, mv } = makeSession(60);
  const originalSpawn = _deps.spawn;
  const originalSleep = _deps.sleep;
  try {
    _deps.sleep = async () => {};
    _deps.spawn = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.stderr = new EventEmitter();
      child.stderr.setEncoding = () => {};
      child.stdin = { end() {} };
      child.kill = () => true;
      queueMicrotask(() => {
        const err = new Error('spawn /bin/sh EACCES');
        err.code = 'EACCES';
        child.emit('error', err);
      });
      return child;
    };
    const ctx = makeContext(sessionDir, workingDir, runnerState);
    const result = await measureAndClassifyIteration(mv, { raw: '50', score: 50 }, ctx);
    assert.deepEqual(result, { kind: 'failed', exitReason: 'baseline_unmeasurable_unrecoverable' });
  } finally {
    _deps.spawn = originalSpawn;
    _deps.sleep = originalSleep;
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('measureAndClassifyIteration consumes structured LLM judge ledger before numeric comparison', async () => {
  const sessionDir = makeTempDir('pickle-mv-llm-session-');
  const workingDir = makeTempDir('pickle-mv-llm-work-');
  const runnerState = makeRunnerState(sessionDir, workingDir, { backend: 'claude' });
  const judgeOutput = {
    score: 40,
    violations: [
      {
        id: 'new-violation',
        path: 'src/foo.ts',
        line: 12,
        rule: 'no-any',
        severity: 'high',
        description: 'new violation',
      },
    ],
    resolved: ['old-violation'],
    new: ['new-violation'],
    remaining: [],
  };
  const mv = createMicroverseState({
    prdPath: path.join(workingDir, 'prd.md'),
    metric: {
      description: 'quality',
      validation: 'improve code quality',
      type: 'llm',
      timeout_seconds: 60,
      tolerance: 2,
      direction: 'higher',
      judge_model: 'claude-sonnet-4-6',
    },
    stallLimit: 3,
  });
  mv.status = 'iterating';
  mv.baseline_score = 40;
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(runnerState, null, 2));
  writeMicroverseState(sessionDir, mv);

  process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = '1';
  const originalExec = _deps.execFileSync;
  try {
    _deps.execFileSync = (_cmd, args) => {
      if (Array.isArray(args) && args[0] === '--version') return 'Claude Code 2.1.126';
      return JSON.stringify(judgeOutput);
    };
    const ctx = makeContext(sessionDir, workingDir, runnerState, {
      iteration: 2,
      preIterSha: 'a'.repeat(40),
      postIterSha: 'b'.repeat(40),
    });
    const result = await measureAndClassifyIteration(mv, { raw: '40', score: 40 }, ctx);
    // AC-V1 case 2 (ticket 76f7fa90): resolved=['old-violation'], new=['new-violation'] is a violation-count
    // lateral wash (equal resolved/new counts) — compareMetricSetOps now classifies this 'held', not 'improved',
    // matching the beta.16 field observation (1 -> 1 misread as 'improved') that this ticket corrects.
    assert.deepEqual(result, { kind: 'unchanged' });
    assert.equal(mv.convergence.history[0].classification, 'held');
    assert.deepEqual(
      mv.violation_ledger?.map(({ path: filePath, line, rule, first_seen_iter, last_seen_iter }) => ({
        path: filePath,
        line,
        rule,
        first_seen_iter,
        last_seen_iter,
      })),
      [{
        path: 'src/foo.ts',
        line: 12,
        rule: 'no-any',
        first_seen_iter: 2,
        last_seen_iter: 2,
      }],
    );
  } finally {
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    _deps.execFileSync = originalExec;
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('measureAndClassifyIteration drops resolved violations from the live ledger before the next judge pass', async () => {
  const sessionDir = makeTempDir('pickle-mv-llm-resolved-session-');
  const workingDir = makeTempDir('pickle-mv-llm-resolved-work-');
  const runnerState = makeRunnerState(sessionDir, workingDir, { backend: 'claude' });
  const firstJudgeOutput = {
    score: 40,
    violations: [
      {
        id: 'repeat-violation',
        path: 'src/foo.ts',
        line: 12,
        rule: 'no-any',
        severity: 'high',
        description: 'new violation',
      },
    ],
    resolved: [],
    new: ['repeat-violation'],
    remaining: [],
  };
  const secondJudgeOutput = {
    score: 40,
    violations: [],
    resolved: ['repeat-violation'],
    new: [],
    remaining: [],
  };
  const mv = createMicroverseState({
    prdPath: path.join(workingDir, 'prd.md'),
    metric: {
      description: 'quality',
      validation: 'improve code quality',
      type: 'llm',
      timeout_seconds: 60,
      tolerance: 2,
      direction: 'higher',
      judge_model: 'claude-sonnet-4-6',
    },
    stallLimit: 3,
  });
  mv.status = 'iterating';
  mv.baseline_score = 40;
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(runnerState, null, 2));
  writeMicroverseState(sessionDir, mv);

  process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = '1';
  const originalExec = _deps.execFileSync;
  const originalReset = _deps.resetToSha;
  let pass = 0;
  try {
    _deps.resetToSha = () => {};
    _deps.execFileSync = (_cmd, args) => {
      if (Array.isArray(args) && args[0] === '--version') return 'Claude Code 2.1.126';
      pass += 1;
      return JSON.stringify(pass === 1 ? firstJudgeOutput : secondJudgeOutput);
    };
    const firstCtx = makeContext(sessionDir, workingDir, runnerState, {
      iteration: 2,
      preIterSha: 'a'.repeat(40),
      postIterSha: 'b'.repeat(40),
    });
    const secondCtx = makeContext(sessionDir, workingDir, runnerState, {
      iteration: 3,
      preIterSha: 'c'.repeat(40),
      postIterSha: 'd'.repeat(40),
    });

    await measureAndClassifyIteration(mv, { raw: '40', score: 40 }, firstCtx);
    assert.equal(mv.violation_ledger?.length, 1, 'first pass should seed the live ledger');

    await measureAndClassifyIteration(mv, { raw: '40', score: 40 }, secondCtx);
    assert.deepEqual(mv.violation_ledger, [], 'resolved violations must be removed from the live ledger');
  } finally {
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    _deps.resetToSha = originalReset;
    _deps.execFileSync = originalExec;
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('executeMainLoop replays convergence mutation fixture order', async () => {
  const fixturePath = path.join('tests', 'fixtures', 'microverse', 'convergence-mutations.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
  const sessionDir = makeTempDir('pickle-mv-replay-session-');
  const workingDir = makeTempDir('pickle-mv-replay-work-');
  const scoreFile = path.join(workingDir, 'score.txt');
  const runnerState = makeRunnerState(sessionDir, workingDir, { max_iterations: 5 });
  const originalRunIteration = _deps.runIteration;
  const originalGetHeadSha = _deps.getHeadSha;
  const originalSleep = _deps.sleep;
  const originalReset = _deps.resetToSha;
  const scores = [60, 61, 62];
  const shas = ['pre001', 'abc001', 'pre002', 'abc002', 'pre003', 'abc003'];
  const postShas = [];
  try {
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(runnerState, null, 2));
    const mv = createMicroverseState({
      prdPath: path.join(workingDir, 'prd.md'),
      metric: { ...makeMetric('cat score.txt'), tolerance: 5 },
      stallLimit: 2,
    });
    mv.status = 'iterating';
    mv.baseline_score = fixture.cycle[0].after.baseline_score;
    writeMicroverseState(sessionDir, mv);

    let iterationIndex = 0;
    _deps.runIteration = async () => {
      fs.writeFileSync(scoreFile, `${scores[iterationIndex++]}\n`);
      return { completion: 'success', exitCode: 0, timedOut: false, wallSeconds: 1 };
    };
    _deps.getHeadSha = () => {
      const sha = shas.shift() ?? 'abc003';
      if (sha.startsWith('abc')) postShas.push(sha);
      return sha;
    };
    _deps.sleep = async () => {};
    _deps.resetToSha = () => {};

    const ctx = makeContext(sessionDir, workingDir, runnerState, {
      iteration: 0,
      startTime: Date.now(),
    });
    await executeMainLoop(mv, ctx);
    const actual = readMicroverseState(sessionDir);
    const expectedAfter = fixture.cycle[2].after.convergence;
    const actualMutations = actual.convergence.history.map(({ score, iteration, action, classification }, index) => ({
      score,
      iteration,
      sha: postShas[index],
      ...(action === 'accept' && classification === 'improved' ? { action } : {}),
      classification,
    }));
    assert.deepStrictEqual(
      actualMutations,
      expectedAfter.history,
    );
    assert.equal(actual.convergence.stall_counter, expectedAfter.stall_counter);
  } finally {
    _deps.runIteration = originalRunIteration;
    _deps.getHeadSha = originalGetHeadSha;
    _deps.sleep = originalSleep;
    _deps.resetToSha = originalReset;
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER4-01 — the ±5 line-drift reuse lookup must fire on the shape the
// judge actually produces. `buildJudgePrompt`'s output schema names no `rule`,
// so `parseLlmJudgeOutput` leaves `Violation.rule` undefined on every real
// violation. The pre-fix predicate stored that raw `undefined` and compared it
// against a `?? ''`-defaulted current value, so `undefined === ''` was false and
// the reuse branch could never run: measured 41/41 live ledger entries on this
// box carried no `rule`, and 41/41 had first_seen_iter === last_seen_iter.
//
// Drive the REAL parser, not a hand-shaped fixture — the two pre-existing
// fuzzy-match cases above both hand-write `rule: 'no-any'` / `'strict-null'`,
// the one shape production never emits, which is why they stayed green.
// ---------------------------------------------------------------------------

/** A judge payload in exactly the shape `buildJudgePrompt` demands — note: no `rule` key. */
const AP_ITER4_OPTS = {
  prdPath: '/tmp/test.md',
  metric: { description: 'coverage', validation: 'echo 80', type: 'command', timeout_seconds: 30, tolerance: 1 },
  stallLimit: 3,
};

function judgeOutputAtLine(line, id) {
  return JSON.stringify({
    score: 1,
    violations: [{ id, path: 'src/foo.ts', line, severity: 'high', description: 'function too long' }],
    resolved: [], new: [id], remaining: [],
  });
}

test('AP-EXT-ITER4-01: a real judge violation (no `rule` key) keeps its id across a ±5 line drift', () => {
  const state = createMicroverseState(AP_ITER4_OPTS);
  state.violation_ledger = [];

  updateViolationLedger(state, parseLlmJudgeOutput(judgeOutputAtLine(100, 'v1')), 1);
  assert.equal(state.violation_ledger.length, 1);
  const firstId = state.violation_ledger[0].id;
  assert.equal(state.violation_ledger[0].first_seen_iter, 1);

  // The worker edited above it; the same violation is now 3 lines down.
  updateViolationLedger(state, parseLlmJudgeOutput(judgeOutputAtLine(103, firstId)), 2);
  assert.equal(state.violation_ledger.length, 1, 'the drifted violation must reuse, not duplicate');
  assert.equal(state.violation_ledger[0].id, firstId, 'ID must survive the drift');
  assert.equal(state.violation_ledger[0].first_seen_iter, 1, 'first_seen_iter must carry the age');
  assert.equal(state.violation_ledger[0].last_seen_iter, 2);
  assert.equal(state.violation_ledger[0].line, 103, 'the entry tracks the new location');
});

test('AP-EXT-ITER4-01: a judge violation with no `path` either still reuses its entry', () => {
  const state = createMicroverseState(AP_ITER4_OPTS);
  state.violation_ledger = [];
  const raw = (line, id) => JSON.stringify({
    score: 1,
    violations: [{ id, line, severity: 'med', description: 'no location' }],
    resolved: [], new: [id], remaining: [],
  });

  updateViolationLedger(state, parseLlmJudgeOutput(raw(40, 'v1')), 1);
  const firstId = state.violation_ledger[0].id;
  updateViolationLedger(state, parseLlmJudgeOutput(raw(42, firstId)), 2);
  assert.equal(state.violation_ledger.length, 1);
  assert.equal(state.violation_ledger[0].id, firstId);
  assert.equal(state.violation_ledger[0].first_seen_iter, 1);
});

test('AP-EXT-ITER4-01 control: a drift BEYOND ±5 still takes a new id (the fix does not over-match)', () => {
  const state = createMicroverseState(AP_ITER4_OPTS);
  state.violation_ledger = [];

  updateViolationLedger(state, parseLlmJudgeOutput(judgeOutputAtLine(100, 'v1')), 1);
  const firstId = state.violation_ledger[0].id;
  updateViolationLedger(state, parseLlmJudgeOutput(judgeOutputAtLine(120, 'v2')), 2);
  assert.equal(state.violation_ledger.length, 1);
  assert.notEqual(state.violation_ledger[0].id, firstId, 'beyond the window is a different violation');
  assert.equal(state.violation_ledger[0].first_seen_iter, 2);
});

test('AP-EXT-ITER4-01 control: normalizing identity does not change any generated id', () => {
  // The canonical form is exactly what generateViolationId already defaulted to,
  // so a deployed ledger's ids stay stable across this fix — no churn on upgrade.
  assert.equal(
    generateViolationId({ id: 'v1', path: 'src/foo.ts', line: 42, severity: 'high', description: 'd' }),
    generateViolationId({ id: 'v1', path: 'src/foo.ts', line: 42, rule: '', severity: 'high', description: 'd' }),
  );
  assert.equal(
    generateViolationId({ id: 'v1', path: '<arch>', rule: 'arch:layering', severity: 'high', description: 'd' }),
    'module:v1:rule:layering',
  );
});

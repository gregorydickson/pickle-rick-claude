// @tier: fast
// AC-A1-mv / AC-A5 (ticket 0aff6be2): the 'worker' handoff iteration must never be counted as
// wasted, and the runner must emit exactly one wasted_iter event per iteration regardless of
// which of the four emit sites (worker mode, metric no-commit, metric accept/revert, non-success
// exit) fires. Drives the real handleIterationOutcome — no reimplementation of the predicate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { StateManager } from '../services/state-manager.js';
import { _deps, handleIterationOutcome } from '../bin/microverse-runner.js';

const stateManager = new StateManager();

function createTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-wic-work-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email test@test.com', { cwd: dir });
  execSync('git config user.name test', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed');
  execSync('git add -A && git commit -q -m seed', { cwd: dir });
  return dir;
}

function readWastedIterEvents(dataRoot) {
  const activityDir = path.join(dataRoot, 'activity');
  if (!fs.existsSync(activityDir)) return [];
  const events = [];
  for (const entry of fs.readdirSync(activityDir)) {
    if (!entry.endsWith('.jsonl')) continue;
    for (const line of fs.readFileSync(path.join(activityDir, entry), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* ignore malformed fixture lines */ }
    }
  }
  return events.filter((event) => event.event === 'wasted_iter');
}

function makeRunnerState(sessionDir, workingDir) {
  return {
    active: true,
    working_dir: workingDir,
    step: 'anatomy-park',
    iteration: 7,
    max_iterations: 200,
    max_time_minutes: 0,
    worker_timeout_seconds: 0,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'wasted-iter-classification',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    backend: 'claude',
  };
}

function makeContext(sessionDir, statePath, workingDir, runnerState, preIterSha) {
  return {
    sessionDir,
    extensionRoot: path.resolve(sessionDir, '..'),
    statePath,
    workingDir,
    startTime: Date.now(),
    initialIteration: 6,
    enableFailureClassification: false,
    cgSettings: {
      enabled_convergence_files: ['anatomy-park.json'],
      regression_warning_threshold: 5,
      remediator_timeout_s: 600,
      baseline_max_age_iterations: 30,
      baseline_max_age_seconds: 14_400,
    },
    rateLimitWaitMinutes: 60,
    maxRateLimitRetries: 3,
    log: () => {},
    currentRunnerState: runnerState,
    iteration: 7,
    consecutiveRateLimits: 0,
    preIterSha,
  };
}

async function withSandbox(fn) {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-wic-session-'));
  const workingDir = createTempGitRepo();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-wic-data-'));
  const previousDataRoot = process.env.PICKLE_DATA_ROOT;
  try {
    process.env.PICKLE_DATA_ROOT = dataRoot;
    return await fn({ sessionDir, workingDir, dataRoot });
  } finally {
    if (previousDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = previousDataRoot;
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

// --- Worker mode: the ONLY path that can emit action:'worker'. ---

function makeWorkerMicroverseState(historyForThisIteration) {
  return {
    status: 'iterating',
    prd_path: 'prds/anatomy.md',
    convergence: {
      stall_limit: 5,
      stall_counter: 0,
      history: historyForThisIteration ? [historyForThisIteration] : [],
    },
    gap_analysis_path: 'gap.md',
    failed_approaches: [],
    baseline_score: 0,
    failure_history: [],
    approach_exhaustion_fired: false,
    convergence_mode: 'worker',
    convergence_file: 'anatomy-park.json',
    current_subsystem: 'alpha',
    consecutive_subprocess_errors: 0,
    iteration_regressions: 0,
  };
}

async function runWorkerModeHarness({ preSha, postSha, historyAction }) {
  return withSandbox(async ({ sessionDir, workingDir, dataRoot }) => {
    const runnerState = makeRunnerState(sessionDir, workingDir);
    const statePath = path.join(sessionDir, 'state.json');
    const microverseState = makeWorkerMicroverseState(
      historyAction ? { iteration: 7, action: historyAction } : undefined,
    );
    // eslint-disable-next-line pickle/no-raw-state-write -- initial creation: no existing state to lock against
    stateManager.forceWrite(statePath, runnerState);
    fs.writeFileSync(path.join(sessionDir, 'microverse.json'), JSON.stringify(microverseState, null, 2));
    fs.writeFileSync(path.join(sessionDir, 'anatomy-park.json'), JSON.stringify({
      subsystems: ['alpha'],
      current_index: 0,
      stall_counts: { alpha: 0 },
    }, null, 2));

    const original = {
      collectTickets: _deps.collectTickets,
      getHeadSha: _deps.getHeadSha,
      sleep: _deps.sleep,
      runWorkerManagedIteration: _deps.runWorkerManagedIteration,
    };
    try {
      _deps.collectTickets = () => [];
      _deps.getHeadSha = () => postSha;
      _deps.sleep = async () => {};
      _deps.runWorkerManagedIteration = async (opts) => ({
        currentMv: opts.currentMv,
        converged: false,
        reason: 'still iterating',
      });

      await handleIterationOutcome(
        microverseState,
        { raw: '0', score: 0 },
        makeContext(sessionDir, statePath, workingDir, runnerState, preSha),
        { completion: 'task_completed', timedOut: false, exitCode: 0, wallSeconds: 30 },
      );
      return readWastedIterEvents(dataRoot);
    } finally {
      _deps.collectTickets = original.collectTickets;
      _deps.getHeadSha = original.getHeadSha;
      _deps.sleep = original.sleep;
      _deps.runWorkerManagedIteration = original.runWorkerManagedIteration;
    }
  });
}

test('AC-A1-mv: worker handoff with HEAD unchanged is not wasted', async () => {
  const events = await runWorkerModeHarness({ preSha: 'a'.repeat(40), postSha: 'a'.repeat(40) });
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'worker');
  assert.equal(events[0].wasted, false);
});

test('AC-A1-mv: worker handoff with HEAD moved is also not wasted', async () => {
  const events = await runWorkerModeHarness({ preSha: 'a'.repeat(40), postSha: 'b'.repeat(40) });
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'worker');
  assert.equal(events[0].wasted, false);
});

test('AC-A1-mv: a worker-mode iteration the worker itself recorded as reverted stays wasted', async () => {
  const events = await runWorkerModeHarness({
    preSha: 'a'.repeat(40),
    postSha: 'b'.repeat(40),
    historyAction: 'revert',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'revert');
  assert.equal(events[0].wasted, true);
});

// --- Metric mode: 'accept' / 'revert' / 'no_commit' must stay unchanged by the fix. ---

function makeMetricMicroverseState(validation) {
  return {
    status: 'iterating',
    prd_path: 'prds/test.md',
    key_metric: { description: 'test', validation, type: 'command', timeout_seconds: 5, tolerance: 2 },
    convergence: { stall_limit: 5, stall_counter: 0, history: [] },
    gap_analysis_path: '',
    failed_approaches: [],
    baseline_score: 40,
    failure_history: [],
    approach_exhaustion_fired: false,
  };
}

async function runMetricModeHarness({ validation, sameSha }) {
  return withSandbox(async ({ sessionDir, workingDir, dataRoot }) => {
    const runnerState = makeRunnerState(sessionDir, workingDir);
    const statePath = path.join(sessionDir, 'state.json');
    const microverseState = makeMetricMicroverseState(validation);
    // eslint-disable-next-line pickle/no-raw-state-write -- initial creation: no existing state to lock against
    stateManager.forceWrite(statePath, runnerState);
    fs.writeFileSync(path.join(sessionDir, 'microverse.json'), JSON.stringify(microverseState, null, 2));

    // A 'revert' classification triggers a REAL `git reset --hard <preIterSha>`
    // (guardedMicroverseRollback), so preSha must be a real commit — a fake hex string 404s.
    const realPreSha = execSync('git rev-parse HEAD', { cwd: workingDir }).toString().trim();
    let realPostSha = realPreSha;
    if (!sameSha) {
      fs.writeFileSync(path.join(workingDir, 'change.txt'), 'edit');
      execSync('git add -A && git commit -q -m change', { cwd: workingDir });
      realPostSha = execSync('git rev-parse HEAD', { cwd: workingDir }).toString().trim();
    }

    const original = { getHeadSha: _deps.getHeadSha };
    let calls = 0;
    try {
      _deps.getHeadSha = () => {
        calls++;
        return calls === 1 ? realPreSha : realPostSha;
      };

      await handleIterationOutcome(
        microverseState,
        { raw: '40', score: 40 },
        makeContext(sessionDir, statePath, workingDir, runnerState, realPreSha),
        { completion: 'task_completed', timedOut: false, exitCode: 0, wallSeconds: 30 },
      );
      return readWastedIterEvents(dataRoot);
    } finally {
      _deps.getHeadSha = original.getHeadSha;
    }
  });
}

test("AC-A1-mv: metric-mode 'accept' (SHA moved, score improved) stays not wasted", async () => {
  const events = await runMetricModeHarness({ validation: 'echo 50', sameSha: false });
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'accept');
  assert.equal(events[0].wasted, false);
});

test("AC-A1-mv: metric-mode 'revert' (SHA moved, score regressed) stays wasted", async () => {
  const events = await runMetricModeHarness({ validation: 'echo 10', sameSha: false });
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'revert');
  assert.equal(events[0].wasted, true);
});

test("AC-A1-mv: metric-mode 'no_commit' (HEAD unchanged) stays wasted", async () => {
  const events = await runMetricModeHarness({ validation: 'echo 50', sameSha: true });
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'no_commit');
  assert.equal(events[0].wasted, true);
});

// --- AC-A5: exactly one wasted_iter event per iteration, across every reachable emit site. ---

test('AC-A5: a non-success iteration exit emits exactly one wasted_iter event', async () => {
  const events = await withSandbox(async ({ sessionDir, workingDir, dataRoot }) => {
    const runnerState = makeRunnerState(sessionDir, workingDir);
    const statePath = path.join(sessionDir, 'state.json');
    const microverseState = makeMetricMicroverseState('echo 50');
    // eslint-disable-next-line pickle/no-raw-state-write -- initial creation: no existing state to lock against
    stateManager.forceWrite(statePath, runnerState);
    fs.writeFileSync(path.join(sessionDir, 'microverse.json'), JSON.stringify(microverseState, null, 2));

    const original = { getHeadSha: _deps.getHeadSha };
    try {
      _deps.getHeadSha = () => 'a'.repeat(40);
      await handleIterationOutcome(
        microverseState,
        { raw: '40', score: 40 },
        makeContext(sessionDir, statePath, workingDir, runnerState, 'a'.repeat(40)),
        { completion: 'error', timedOut: false, exitCode: 1, wallSeconds: 30 },
      );
      return readWastedIterEvents(dataRoot);
    } finally {
      _deps.getHeadSha = original.getHeadSha;
    }
  });
  assert.equal(events.length, 1, 'a non-success exit must not also reach a metric/worker emit site');
  assert.equal(events[0].action, 'error');
  assert.equal(events[0].wasted, true);
});

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
import { fileURLToPath } from 'node:url';
import { StateManager } from '../services/state-manager.js';
import { _deps, handleIterationOutcome } from '../bin/microverse-runner.js';
import { classifyMuxIteration, emitMuxWastedIter } from '../bin/mux-runner.js';
import { MUX_ITERATION_REASONS } from '../types/index.js';

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

// --- Mux mode (ticket 7addedbf): AC-A1-mux / AC-A2 / AC-A3 / AC-A4. ---
//
// Mux has no 'worker' label — its action IS `outcome.completion`. The observable that
// identifies the designed worker handoff is the lifecycle-artifact delta: the handoff is
// defined by the next spawn resuming from the worker's on-disk artifacts, so the artifacts
// appearing IS the disposition. Rationale + rejected alternatives: plan_2026-08-13.md.

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function classifyMux({ action, preIterSha = SHA_A, postIterSha = SHA_A, artifactDelta = 0 }) {
  return classifyMuxIteration({ action, preIterSha, postIterSha, artifactDelta });
}

test('AC-A1-mux: an iteration ending in the designed worker handoff is NOT wasted', () => {
  assert.deepEqual(
    classifyMux({ action: 'continue', artifactDelta: 2 }),
    { wasted: false, reason: 'worker_handoff' },
  );
});

test('AC-A1-mux: the handoff verdict survives the real emitter', async () => {
  const events = await withSandbox(async ({ sessionDir, dataRoot }) => {
    emitMuxWastedIter({
      sessionDir,
      iteration: 7,
      action: 'continue',
      preIterSha: SHA_A,
      postIterSha: SHA_A,
      artifactDelta: 1,
    });
    return readWastedIterEvents(dataRoot);
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].runner, 'mux');
  assert.equal(events[0].wasted, false);
  assert.equal(events[0].reason, 'worker_handoff');
});

test('AC-A1-mux: a handoff whose commit also landed reports the commit, not the handoff', () => {
  assert.deepEqual(
    classifyMux({ action: 'continue', postIterSha: SHA_B, artifactDelta: 3 }),
    { wasted: false, reason: 'committed' },
  );
});

for (const action of ['task_completed', 'review_clean']) {
  test(`AC-A2: '${action}' with nothing to do is NOT wasted`, () => {
    assert.deepEqual(
      classifyMux({ action }),
      { wasted: false, reason: 'clean_pass' },
    );
  });
}

for (const action of ['continue', 'error', 'inactive']) {
  test(`AC-A3: '${action}' with no commit and no artifacts IS wasted`, () => {
    assert.deepEqual(
      classifyMux({ action }),
      { wasted: true, reason: 'no_progress' },
    );
  });
}

test('AC-A3: an unmappable action records the conservative verdict', () => {
  assert.deepEqual(
    classifyMux({ action: 'not_a_real_completion' }),
    { wasted: true, reason: 'no_progress' },
  );
});

test('AC-A3: a commit is never wasted, whatever the action', () => {
  assert.deepEqual(
    classifyMux({ action: 'error', postIterSha: SHA_B }),
    { wasted: false, reason: 'committed' },
  );
});

test('AC-A3: an unreadable HEAD is not evidence of a commit', () => {
  assert.deepEqual(
    classifyMux({ action: 'continue', postIterSha: null }),
    { wasted: true, reason: 'no_progress' },
  );
});

test("AC-A3: the legacy 'revert' term is preserved", () => {
  assert.deepEqual(
    classifyMux({ action: 'revert', postIterSha: SHA_B }),
    { wasted: true, reason: 'revert' },
  );
});

// AC-A4: the mapping from `outcome.completion` to the reason vocabulary is TOTAL, and the
// vocabulary is closed. The action list is derived from the `IterationOutcome` declaration
// in source rather than hand-copied, so a member added to that union without a mapping
// reddens this loop instead of being silently skipped. `node:test` has no `test.each`.

function readCompletionUnionMembers() {
  const typesPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'src',
    'types',
    'index.ts',
  );
  const source = fs.readFileSync(typesPath, 'utf-8');
  const iface = /export interface IterationOutcome \{([\s\S]*?)\n\}/.exec(source);
  assert.ok(iface, 'IterationOutcome interface not found in src/types/index.ts');
  const completion = /completion:\s*([^;]+);/.exec(iface[1]);
  assert.ok(completion, 'completion member not found on IterationOutcome');
  return completion[1].split('|').map((part) => part.trim().replace(/^'|'$/g, ''));
}

const COMPLETION_MEMBERS = readCompletionUnionMembers();

test('AC-A4: the completion union was parsed, not silently empty', () => {
  assert.ok(COMPLETION_MEMBERS.length >= 5, `parsed only ${COMPLETION_MEMBERS.length} members`);
  for (const member of COMPLETION_MEMBERS) {
    assert.match(member, /^[a-z_]+$/, `unparsed union member: ${member}`);
  }
});

// Every (artifactDelta, postIterSha) shape an iteration can end in, against a fixed preIterSha.
const TOTALITY_SHAPES = [null, 0, 2].flatMap(
  (artifactDelta) => [SHA_A, SHA_B, null].map((postIterSha) => ({ artifactDelta, postIterSha })),
);

for (const action of COMPLETION_MEMBERS) {
  test(`AC-A4: '${action}' maps to exactly one reason from the closed vocabulary`, () => {
    for (const { artifactDelta, postIterSha } of TOTALITY_SHAPES) {
      const verdict = classifyMuxIteration({ action, preIterSha: SHA_A, postIterSha, artifactDelta });
      const shape = `${action}/delta=${artifactDelta}/post=${postIterSha}`;
      assert.ok(
        MUX_ITERATION_REASONS.includes(verdict.reason),
        `${shape} produced an out-of-vocabulary reason: ${verdict.reason}`,
      );
      assert.equal(typeof verdict.wasted, 'boolean');
      // The ticket's invariant: `wasted: true` implies the iteration produced no commit.
      const movedHead = postIterSha !== null && postIterSha !== SHA_A;
      assert.ok(!(verdict.wasted && movedHead), `${shape} reported wasted over a moved HEAD`);
      assert.ok(!(verdict.wasted && verdict.reason === 'committed'), `${shape} is wasted AND committed`);
    }
  });
}

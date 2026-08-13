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
import { classifyMuxIteration, createWastedIterEmitter, emitMuxWastedIter } from '../bin/mux-runner.js';
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

    const original = { getHeadSha: _deps.getHeadSha, sleep: _deps.sleep };
    let calls = 0;
    try {
      // A measurement that cannot be parsed retries once behind `_deps.sleep`
      // (measureMetricWithRetry). Stub it so the failure path costs no wall-clock.
      _deps.sleep = async () => {};
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
      _deps.sleep = original.sleep;
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

// Ticket 2ed9a852 (H1): `handleMetricMode`'s measurement-failure arm returned ahead of its
// emit, so the last iteration of every measurement-failed run went unrecorded. The
// iteration is real — it reaches that arm only because HEAD moved — and an unrecorded
// iteration is a hole in the population the rate is read over.
test('2ed9a852 H1: a metric-mode iteration whose MEASUREMENT failed is still recorded', async () => {
  const events = await runMetricModeHarness({ validation: 'echo not-a-number', sameSha: false });
  assert.equal(events.length, 1, 'the measurement-failure exit recorded no wasted_iter event');
  assert.equal(events[0].runner, 'microverse');
  assert.ok(
    MUX_ITERATION_REASONS.includes(events[0].reason),
    `out-of-vocabulary reason: ${events[0].reason}`,
  );
  // The commit landed; only the measurement failed. Rule order scores the moved HEAD
  // `committed`, and the action names why the iteration ended rather than pre-judging it.
  assert.equal(events[0].reason, 'committed');
  assert.equal(events[0].wasted, false);
  assert.ok(events[0].action, 'the emitted action must name the exit reason, not be empty');
});

// --- AC-A5: exactly one wasted_iter event per iteration, across every reachable emit site. ---

/**
 * Drive `handleIterationOutcome` down the non-success exit path against ONE RunContext.
 *
 * `emissions` is how many times that context is driven: 1 is the single non-success exit
 * (AC-A5), 2 is the shape a fifth emit site — or a widened `IterationExitType` — would
 * produce, which ticket 2ed9a852 (H2) makes the emitter refuse. `advanceIteration` bumps
 * `ctx.iteration` between the two so the per-iteration guard can be told apart from a guard
 * that wedges the emitter for the rest of the run.
 */
async function runNonSuccessHarness({ emissions = 1, advanceIteration = false } = {}) {
  return withSandbox(async ({ sessionDir, workingDir, dataRoot }) => {
    const runnerState = makeRunnerState(sessionDir, workingDir);
    const statePath = path.join(sessionDir, 'state.json');
    const microverseState = makeMetricMicroverseState('echo 50');
    // eslint-disable-next-line pickle/no-raw-state-write -- initial creation: no existing state to lock against
    stateManager.forceWrite(statePath, runnerState);
    fs.writeFileSync(path.join(sessionDir, 'microverse.json'), JSON.stringify(microverseState, null, 2));

    const logLines = [];
    const ctx = makeContext(sessionDir, statePath, workingDir, runnerState, 'a'.repeat(40));
    ctx.log = (msg) => logLines.push(msg);

    const original = { getHeadSha: _deps.getHeadSha };
    try {
      _deps.getHeadSha = () => 'a'.repeat(40);
      const outcome = { completion: 'error', timedOut: false, exitCode: 1, wallSeconds: 30 };
      for (let call = 0; call < emissions; call++) {
        if (call > 0 && advanceIteration) ctx.iteration += 1;
        await handleIterationOutcome(microverseState, { raw: '40', score: 40 }, ctx, outcome);
      }
      return { events: readWastedIterEvents(dataRoot), logLines };
    } finally {
      _deps.getHeadSha = original.getHeadSha;
    }
  });
}

test('AC-A5: a non-success iteration exit emits exactly one wasted_iter event', async () => {
  const { events } = await runNonSuccessHarness();
  assert.equal(events.length, 1, 'a non-success exit must not also reach a metric/worker emit site');
  assert.equal(events[0].action, 'error');
  assert.equal(events[0].wasted, true);
});

// --- Ticket 6625e3ed: the microverse emitter fails conservative and speaks the vocabulary. ---
//
// The mux-path sibling of the first case is `AC-A3: an unreadable HEAD is not evidence of a
// commit` below. Until 6625e3ed the microverse emitter carried its own inline predicate, so it
// had no such arm: `postIterSha === preIterSha` with one side null is `false`, and a failed HEAD
// read scored NOT wasted. Both cases drive the real emitter and read the emitted JSONL — a test
// that restated the predicate would be blind to exactly the defect this pins.

async function runNonSuccessExitHarness({ preSha }) {
  return withSandbox(async ({ sessionDir, workingDir, dataRoot }) => {
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
        makeContext(sessionDir, statePath, workingDir, runnerState, preSha),
        { completion: 'error', timedOut: false, exitCode: 1, wallSeconds: 30 },
      );
      return readWastedIterEvents(dataRoot);
    } finally {
      _deps.getHeadSha = original.getHeadSha;
    }
  });
}

test('6625e3ed: an unreadable pre-iteration HEAD is not evidence of a commit (microverse path)', async () => {
  const events = await runNonSuccessExitHarness({ preSha: null });
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'error');
  assert.equal(events[0].pre_iter_sha, null, 'the fixture must actually exercise the one-null-SHA case');
  assert.equal(
    events[0].wasted,
    true,
    'one readable SHA is not a commit — the conservative arm must fire, not the equality shortcut',
  );
  assert.equal(events[0].reason, 'no_progress');
});

test('6625e3ed: every microverse emission carries a reason from the closed vocabulary', async () => {
  const cases = [
    await runWorkerModeHarness({ preSha: 'a'.repeat(40), postSha: 'a'.repeat(40) }),
    await runWorkerModeHarness({ preSha: 'a'.repeat(40), postSha: 'b'.repeat(40) }),
    await runMetricModeHarness({ validation: 'echo 20', sameSha: true }),
    await runNonSuccessExitHarness({ preSha: 'a'.repeat(40) }),
  ];
  for (const events of cases) {
    assert.equal(events.length, 1);
    assert.ok(
      MUX_ITERATION_REASONS.includes(events[0].reason),
      `microverse emitted reason ${JSON.stringify(events[0].reason)}, outside the closed vocabulary`,
    );
  }
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

// Ticket 14ebb20d: every assertion below that reads `MUX_ITERATION_REASONS.includes(reason)`
// is only as strong as that set is small. Widening the tuple by one member would leave all of
// them green while silently admitting the reason they exist to exclude — an out-of-vocabulary
// verdict. AC-A4 requires the vocabulary be CLOSED, and "closed" was an unasserted property of
// the source declaration until this test. Membership, in declaration order.
test('AC-A4: the reason vocabulary is exactly five members, and closed', () => {
  assert.deepEqual(
    [...MUX_ITERATION_REASONS],
    ['committed', 'worker_handoff', 'clean_pass', 'revert', 'no_progress'],
  );
  // The value the unlisted-exit-type case below feeds in must NOT be a reason. If a future
  // change made it one, that test would pass by admitting its own input instead of by mapping
  // it onto the conservative arm.
  assert.equal(MUX_ITERATION_REASONS.includes('output_stall'), false);
});

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

// ---------------------------------------------------------------------------
// Ticket 2ed9a852 (C1): the mux loop's `wasted_iter` emit sits ~460 lines below the
// `runIteration` call, and six post-iteration `continue` statements exited ahead of it.
// Every one of those exits is reached only through the zero-artifact-delta bookkeeping,
// so the unemitted iterations were exactly the ones the classifier scores `no_progress`
// — the reported waste rate was read over a population biased away from waste.
//
// The defect is REACHABILITY inside a ~1300-line `while` body in `runMuxRunnerMain`,
// which no test can drive without a live session, tmux, and a worker spawn. So the
// mechanism is pinned behaviorally (the two tests below) and the reachability is pinned
// structurally against the source (the third). A test that re-derived the branch
// conditions would certify itself and see nothing.
// ---------------------------------------------------------------------------

test('2ed9a852 C1: the per-iteration emitter fires exactly once however often it is called', async () => {
  const events = await withSandbox(async ({ sessionDir, dataRoot }) => {
    const emitOnce = createWastedIterEmitter(() => ({
      sessionDir,
      iteration: 11,
      action: 'continue',
      preIterSha: SHA_A,
      postIterSha: SHA_A,
      artifactDelta: 0,
    }));
    emitOnce();
    emitOnce();
    emitOnce();
    return readWastedIterEvents(dataRoot);
  });
  assert.equal(events.length, 1, 'an iteration must be recorded exactly once, never re-charged');
  assert.equal(events[0].runner, 'mux');
  assert.equal(events[0].iteration, 11);
  assert.equal(events[0].action, 'continue');
  // A zero-progress spawn: no commit, no artifacts. This is the verdict the six early
  // exits were dropping on the floor.
  assert.equal(events[0].wasted, true);
  assert.equal(events[0].reason, 'no_progress');
});

test('2ed9a852 C1: the emitter reads its input at emit time, not at bind time', async () => {
  const events = await withSandbox(async ({ sessionDir, dataRoot }) => {
    // Stands in for `readHeadCommit(iterWorkingDir)`: on the fall-through path the emit
    // runs after the ticket-boundary block, where a salvage commit may have landed. That
    // commit belongs to the iteration that produced it, so a value captured at bind time
    // would mis-score the iteration as `no_progress`.
    let head = SHA_A;
    const emitOnce = createWastedIterEmitter(() => ({
      sessionDir,
      iteration: 12,
      action: 'continue',
      preIterSha: SHA_A,
      postIterSha: head,
      artifactDelta: 0,
    }));
    head = SHA_B;
    emitOnce();
    return readWastedIterEvents(dataRoot);
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].post_iter_sha, SHA_B, 'the thunk was evaluated at bind time, not emit time');
  assert.equal(events[0].reason, 'committed');
  assert.equal(events[0].wasted, false);
});

/**
 * The post-`runIteration` span of `runMuxRunnerMain`, sliced from source.
 *
 * Both reachability tests below read the SAME span, so they cannot drift onto different
 * regions of the loop and disagree about what "post-iteration" means.
 */
function sliceMuxPostIterationSpan() {
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bin', 'mux-runner.ts'),
    'utf-8',
  );
  const lines = source.split('\n');

  // Anchor the span. A rename must fail loudly here rather than green a zero-length slice.
  const startIndex = lines.findIndex((line) => line.includes('await runIteration(sessionDir, iteration, extensionRoot)'));
  assert.ok(startIndex >= 0, 'anchor lost: the runIteration call site in runMuxRunnerMain');
  const endIndex = lines.findIndex((line, i) => i > startIndex && line.trim() === 'emitWastedIterOnce();' && line.startsWith('    emitWastedIterOnce'));
  assert.ok(endIndex > startIndex, 'anchor lost: the fall-through emitWastedIterOnce() call site');

  return lines.slice(startIndex, endIndex + 1);
}

test('2ed9a852 C1: every post-runIteration early exit in the mux loop records its iteration', () => {
  const span = sliceMuxPostIterationSpan();
  const earlyExits = span.filter((line) => /(^|\s)continue;\s*$/.test(line)).length;
  const emits = span.filter((line) => line.includes('emitWastedIterOnce();')).length;

  assert.ok(earlyExits > 0, 'the span found no early exits — the slice is wrong, not the code');
  // Every `continue` in the span carries its own emit; the `+ 1` is the fall-through call
  // that closes the span. Both sides are counted from the file, so a seventh early exit
  // added later without an emit turns this RED instead of silently under-reporting waste.
  assert.equal(
    emits,
    earlyExits + 1,
    `${earlyExits} post-runIteration early exit(s) but ${emits} emit call(s): an iteration exits the mux loop without recording its wasted_iter verdict`,
  );
});

/**
 * The maximal run of contiguous preceding lines sharing this line's EXACT indentation.
 *
 * This is the mechanical stand-in for "the exit block this statement belongs to". It has to
 * be mechanical to be reproducible, and it has to stop at an indentation change to be
 * correct: the ladder arms at `mux-runner.ts` pair an `emitWastedIterOnce(); continue;` at
 * one depth with a sibling `break;` one depth out. A rule that merely scanned backwards N
 * lines would credit the sibling's emit to the `break` and report the hole as closed.
 */
function precedingStatementRun(span, index) {
  const indentOf = (line) => /^(\s*)/.exec(line)[1];
  const indent = indentOf(span[index]);
  const run = [];
  for (let i = index - 1; i >= 0; i--) {
    if (span[i].trim() === '' || indentOf(span[i]) !== indent) break;
    run.push(span[i]);
  }
  return run;
}

// Ticket 14ebb20d: the C1 assertion above pins the `continue` form of a post-iteration exit
// and is blind to the `break` form. Both leave the mux loop after a worker ran; a `break`
// leaves it for good, so the iteration it drops is the LAST one of that run. Those exits are
// not a random sample either — every one of them terminates on a failure or halt disposition,
// which is precisely the population the classifier scores `no_progress`. Dropping them biases
// the reported waste rate AWAY from waste, which is the original defect, third costume.
//
// Seven such exits ship today, none of them emitting (each `exitReason` named for legibility;
// see conformance_2026-08-13.md for the enumeration with line numbers):
//
//   state_working_dir_missing ×2 · recovery_exhausted ×2
//   silent-death respawn cap ×1 · done_without_commit_evidence ×2
//
// The implementation is read-only in this ticket, so this is a RATCHET CEILING, not a pin: an
// eighth unemitted `break` turns it RED, and it stays green as the count falls to zero when
// the residual is fixed. An equality pin would go red ON the fix — a test that punishes the
// repair is worse than no test.
const UNEMITTED_BREAK_CEILING = 7;

test('14ebb20d: no NEW post-runIteration `break` exits the mux loop without recording its iteration', () => {
  const span = sliceMuxPostIterationSpan();

  const breakIndexes = span
    .map((line, i) => (/(^|\s)break;\s*$/.test(line) ? i : -1))
    .filter((i) => i >= 0);
  assert.ok(
    breakIndexes.length > 0,
    'the span found no `break` exits — the slice is wrong, not the code',
  );

  const unemitted = breakIndexes.filter(
    (i) => !precedingStatementRun(span, i).some((line) => line.includes('emitWastedIterOnce();')),
  );

  assert.ok(
    unemitted.length <= UNEMITTED_BREAK_CEILING,
    `${unemitted.length} post-runIteration \`break\` exit(s) record no wasted_iter verdict, above the `
    + `${UNEMITTED_BREAK_CEILING} known residuals. A new terminal exit was added without an `
    + `emitWastedIterOnce() — its iteration ran a worker and will be missing from the population `
    + 'the waste rate is read over. Exits without an emit:\n'
    + unemitted.map((i) => `  ${span[i].trim()}  <- ${precedingStatementRun(span, i)[0]?.trim() ?? '(block start)'}`).join('\n'),
  );

});

// Guards the guard, on a synthetic span rather than on shipped source. A rule that credited a
// sibling arm's emit to the terminal `break` would report zero unemitted exits, and the
// ceiling above would then certify a hole it never looked at. Asserting the RULE here instead
// of asserting `unemitted.length > 0` keeps the check alive after the residual is fixed —
// pinning a non-zero residual count would be another test that punishes its own repair.
test('14ebb20d: the exit-block rule does not credit a sibling arm\'s emit to a terminal break', () => {
  // The shape at the ladder arms: an emitting `continue` nested one level inside, and the
  // exhausted `break` one indent out. Only the `continue` is covered by that emit.
  const span = [
    '          if (ladderAction === \'advance\') {',
    '            emitWastedIterOnce();',
    '            continue;',
    '          }',
    '          recordExitReason(statePath, \'recovery_exhausted\');',
    '          break;',
  ];
  const runAtBreak = precedingStatementRun(span, 5);
  assert.ok(
    !runAtBreak.some((line) => line.includes('emitWastedIterOnce();')),
    'the nested arm\'s emit was credited to the terminal break — the rule over-matches',
  );

  // ...and it does still credit an emit that genuinely precedes the exit at the same depth.
  const emitting = ['          emitWastedIterOnce();', '          break;'];
  assert.ok(
    precedingStatementRun(emitting, 1).some((line) => line.includes('emitWastedIterOnce();')),
    'an emit at the exit\'s own depth must count — the rule under-matches',
  );
});

// ---------------------------------------------------------------------------
// Ticket 2ed9a852 (H2): `handleIterationOutcome` emits for every non-success exit and may
// then fall through to the mode handlers, which emit again. Nothing reaches both today,
// but that separation is a four-case exhaustion over `IterationExitType` against
// `classifyIterationExit` and `handleIterationErrorOrStop` — four accidents, none of them
// local to the emitter. A sixth union member, or a `return null` added to that dispatcher,
// would double-charge an iteration. Emit-once is now a property of the emitter.
// ---------------------------------------------------------------------------

/** Parse the `IterationExitType` union members straight from the type declaration. */
function readIterationExitTypeMembers() {
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'types', 'index.ts'),
    'utf-8',
  );
  const declaration = source.match(/export type IterationExitType =([^;]*);/);
  assert.ok(declaration, 'anchor lost: the IterationExitType declaration in src/types/index.ts');
  return [...declaration[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
}

const EXIT_TYPE_MEMBERS = readIterationExitTypeMembers();

test('2ed9a852 H2: a second emission for the same iteration is suppressed, and said so', async () => {
  const { events, logLines } = await runNonSuccessHarness({ emissions: 2 });
  assert.equal(events.length, 1, 'the same iteration was charged twice');
  assert.equal(events[0].iteration, 7);
  assert.ok(
    logLines.some((line) => line.includes('wasted_iter already recorded for iteration 7')),
    `suppression must be logged, never silent. Log lines: ${JSON.stringify(logLines)}`,
  );
});

test('2ed9a852 H2: the guard is per-iteration, not per-run — the next iteration records', async () => {
  const { events } = await runNonSuccessHarness({ emissions: 2, advanceIteration: true });
  assert.equal(events.length, 2, 'the guard wedged the emitter for the rest of the run');
  assert.deepEqual(events.map((event) => event.iteration).sort(), [7, 8]);
});

// The ticket's AC: the mapping is total over the OPEN input set. `WastedIterAction` ends in
// `IterationExitType`, and `handleIterationOutcome` forwards `exitResult.type` verbatim, so a
// value the union does not carry today must still map to the closed reason vocabulary — and
// must land on the conservative side. The value is checked absent from the parsed union, so
// this stays a test of an UNLISTED input even if the union grows.
test('2ed9a852: an IterationExitType value not in the known list still maps to a closed reason', async () => {
  const unlisted = 'output_stall';
  assert.ok(
    !EXIT_TYPE_MEMBERS.includes(unlisted),
    `'${unlisted}' joined IterationExitType (${EXIT_TYPE_MEMBERS.join(', ')}) — pick a value the union still lacks`,
  );
  assert.ok(EXIT_TYPE_MEMBERS.length >= 5, `parsed only ${EXIT_TYPE_MEMBERS.length} members — the parse is broken`);

  const events = await withSandbox(async ({ sessionDir, dataRoot }) => {
    emitMuxWastedIter({
      sessionDir,
      iteration: 9,
      action: unlisted,
      preIterSha: SHA_A,
      postIterSha: SHA_A,
      artifactDelta: null,
    });
    return readWastedIterEvents(dataRoot);
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].action, unlisted, 'the action must round-trip verbatim, not be normalized away');
  assert.ok(
    MUX_ITERATION_REASONS.includes(events[0].reason),
    `an unlisted exit type produced an out-of-vocabulary reason: ${events[0].reason}`,
  );
  // Conservative, and explicitly so: an unrecognized disposition over-reports waste rather
  // than quietly crediting an iteration that may have produced nothing.
  assert.equal(events[0].reason, 'no_progress');
  assert.equal(events[0].wasted, true);
});

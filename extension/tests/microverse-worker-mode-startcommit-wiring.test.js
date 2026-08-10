// @tier: fast
// AP-EXT-ITER14-01 — the R-ORSR-6 interface-change sweep arms ONLY when `handleWorkerMode`
// forwards `startCommit` into `runWorkerManagedIteration`. `handleWorkerMode` is the SOLE
// production call site, so an omitted field makes `applyInterfaceChangeSweepGuard` — and with
// it the whole INV-NO-SELF-DISOWN guard — unreachable dead code in every shipped run.
//
// The five existing sweep tests (tests/microverse-interface-change-sweep.test.js) all call
// `runInterfaceChangeSweep` DIRECTLY, so they stay green with the wiring removed. This file
// pins the WIRING at the one seam that crosses it: the opts object the runner hands the
// worker-managed iteration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateManager } from '../services/state-manager.js';
import { _deps, handleIterationOutcome } from '../bin/microverse-runner.js';

const stateManager = new StateManager();

function makeMicroverseState() {
  return {
    status: 'iterating',
    prd_path: 'prds/anatomy.md',
    convergence: { stall_limit: 5, stall_counter: 0, history: [] },
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

function makeRunnerState(sessionDir, workingDir, startCommit) {
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
    original_prompt: 'AP-EXT-ITER14-01',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    backend: 'claude',
    ...(startCommit === undefined ? {} : { start_commit: startCommit }),
  };
}

function makeContext(sessionDir, statePath, currentRunnerState) {
  return {
    sessionDir,
    extensionRoot: path.resolve(sessionDir, '..'),
    statePath,
    workingDir: currentRunnerState.working_dir,
    startTime: Date.now(),
    initialIteration: 6,
    enableFailureClassification: true,
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
    currentRunnerState,
    iteration: 7,
    consecutiveRateLimits: 0,
  };
}

// Drives the REAL handleWorkerMode (reached through the exported handleIterationOutcome) and
// returns the opts object it passed to the worker-managed iteration.
async function captureWorkerIterationOpts(startCommit) {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-apiter14-session-'));
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-apiter14-work-'));
  const runnerState = makeRunnerState(sessionDir, workingDir, startCommit);
  const statePath = path.join(sessionDir, 'state.json');
  const microverseState = makeMicroverseState();

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
  let captured = null;
  try {
    _deps.collectTickets = () => [];
    _deps.getHeadSha = () => 'deadbeef';
    _deps.sleep = async () => {};
    _deps.runWorkerManagedIteration = async (opts) => {
      captured = opts;
      return { currentMv: opts.currentMv, converged: false, reason: 'still iterating' };
    };

    const result = await handleIterationOutcome(
      microverseState,
      { raw: '0', score: 0 },
      makeContext(sessionDir, statePath, runnerState),
      { completion: 'task_completed', timedOut: false, exitCode: 0, wallSeconds: 30 },
    );
    assert.equal(result, 'continue', 'worker mode must keep iterating for this fixture');
    assert.ok(captured, 'handleWorkerMode must reach runWorkerManagedIteration');
    return captured;
  } finally {
    _deps.collectTickets = original.collectTickets;
    _deps.getHeadSha = original.getHeadSha;
    _deps.sleep = original.sleep;
    _deps.runWorkerManagedIteration = original.runWorkerManagedIteration;
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
}

test('AP-EXT-ITER14-01: handleWorkerMode forwards state.start_commit so the R-ORSR-6 sweep can arm', async () => {
  const opts = await captureWorkerIterationOpts('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
  assert.equal(
    opts.startCommit,
    'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    'the sweep arms only on a non-empty startCommit; omitting it makes the no-disown guard dead code',
  );
  // Prove the value satisfies handleWorkerManagedIteration's own arming predicate.
  assert.equal(typeof opts.startCommit === 'string' && opts.startCommit.trim().length > 0, true);
});

test('AP-EXT-ITER14-01: a session with no start_commit leaves the sweep disarmed (no fabricated base)', async () => {
  const opts = await captureWorkerIterationOpts(undefined);
  assert.equal(opts.startCommit, undefined, 'absent start_commit must stay absent, never a placeholder sha');
});

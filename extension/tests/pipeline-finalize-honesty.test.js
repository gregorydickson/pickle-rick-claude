// @tier: fast
//
// B-NONSTOP WS-2 (AC-NS-6 / AC-NS-5): finalizePhaseSuccess non-pickle honesty gate +
// phase_dispositions observability. A non-convergent anatomy-park / szechuan-sauce phase
// must NOT be reported as a clean success; a genuinely converged phase still counts; the
// pickle/citadel paths are unchanged; and pipeline-status.json carries an additive-optional
// phase_dispositions field that older status files (without it) still parse cleanly.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  __setSpawnRunnerForTests,
  buildPipelineCompletePanel,
  finalizePhaseSuccess,
  main,
  writePipelineStatus,
} from '../bin/pipeline-runner.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-finalize-honesty-'));
}

// A state.json shape StateManager.read() accepts (mirrors tests/pipeline-runner.test.js).
function writeState(statePath, exitReason) {
  fs.writeFileSync(statePath, JSON.stringify({
    active: false,
    working_dir: '/tmp',
    step: 'completed',
    iteration: 3,
    max_iterations: 500,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: path.dirname(statePath),
    tmux_mode: true,
    exit_reason: exitReason,
  }));
}

function makeRuntime(dir) {
  const statePath = path.join(dir, 'state.json');
  return {
    runtime: {
      sessionDir: dir,
      statePath,
      // writeRunningStatus reads only runtime.config.phases.length + sessionDir.
      config: { phases: [{}, {}, {}, {}] },
      workingDir: '/tmp',
      log: () => {},
    },
    statePath,
    cancelMarker: path.join(dir, 'pipeline-cancel'), // absent → cancel check is false
  };
}

function readStatus(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'pipeline-status.json'), 'utf-8'));
}

describe('finalizePhaseSuccess non-pickle honesty gate', () => {
  test('AC-NS-6: non-convergent szechuan-sauce (exit 1) is reported non-convergent, not completed', () => {
    const dir = tmpDir();
    const { runtime, statePath, cancelMarker } = makeRuntime(dir);
    writeState(statePath, 'approach_exhaustion');
    const logs = [];
    runtime.log = (m) => logs.push(m);
    const counters = { completed: 0, skipped: 0, phaseSkips: {}, nonConvergent: 0, phaseDispositions: {} };

    const outcome = finalizePhaseSuccess(runtime, counters, cancelMarker, 'szechuan-sauce', 1, runtime.log);

    assert.equal(outcome.action, 'continue');
    assert.equal(counters.completed, 0, 'must NOT count a non-convergent phase as completed');
    assert.equal(counters.nonConvergent, 1);
    assert.equal(counters.phaseDispositions['szechuan-sauce'], 'approach_exhaustion');
    assert.ok(!logs.some((l) => l.includes('completed successfully')), 'no false success log');
    assert.ok(logs.some((l) => l.includes('did NOT converge')), 'emits the honest non-convergent log');

    const status = readStatus(dir);
    assert.equal(status.phase_dispositions['szechuan-sauce'], 'approach_exhaustion');
    fs.rmSync(dir, { recursive: true });
  });

  /**
   * The two tests above/below vary BOTH exitCode and exit_reason together, so neither one
   * isolates which input drives the honesty branch. It is `exit_reason`: the branch at
   * pipeline-runner.ts:4221-4238 reads `rawPhase` + `state.exit_reason` and never looks at
   * `exitCode` (that is consumed only by the pickle-only `maybeStampPhaseGraduation`).
   *
   * These two tests supply the isolated axes. The exit-0 case is also the genuinely
   * untested reachable edge: a microverse phase CAN exit 0 having stamped a give-up reason,
   * and the honesty gate is the only thing standing between that and a fake-green.
   */
  test('AC-NS-6 (exit_reason is the discriminant): exit 0 + non-convergent reason is still reported non-convergent', () => {
    const dir = tmpDir();
    const { runtime, statePath, cancelMarker } = makeRuntime(dir);
    writeState(statePath, 'iteration_budget_exhausted');
    const logs = [];
    runtime.log = (m) => logs.push(m);
    const counters = { completed: 0, skipped: 0, phaseSkips: {}, nonConvergent: 0, phaseDispositions: {} };

    // Only exitCode differs from the exit-1 case above — the verdict must not.
    const outcome = finalizePhaseSuccess(runtime, counters, cancelMarker, 'szechuan-sauce', 0, runtime.log);

    assert.equal(outcome.action, 'continue');
    assert.equal(counters.completed, 0, 'a zero exit code must not launder a give-up into a completion');
    assert.equal(counters.nonConvergent, 1);
    assert.equal(counters.phaseDispositions['szechuan-sauce'], 'iteration_budget_exhausted');
    assert.ok(!logs.some((l) => l.includes('completed successfully')), 'no false success log on exit 0');
    assert.equal(readStatus(dir).phase_dispositions['szechuan-sauce'], 'iteration_budget_exhausted');
    fs.rmSync(dir, { recursive: true });
  });

  test('AC-NS-6 (exit_reason is the discriminant): exit 1 + converged still counts completed', () => {
    const dir = tmpDir();
    const { runtime, statePath, cancelMarker } = makeRuntime(dir);
    writeState(statePath, 'converged');
    const logs = [];
    runtime.log = (m) => logs.push(m);
    const counters = { completed: 0, skipped: 0, phaseSkips: {}, nonConvergent: 0, phaseDispositions: {} };

    // The mirror image: a non-zero exit does not by itself make a converged phase dishonest.
    const outcome = finalizePhaseSuccess(runtime, counters, cancelMarker, 'szechuan-sauce', 1, runtime.log);

    assert.equal(outcome.action, 'continue');
    assert.equal(counters.completed, 1, 'convergence is decided by exit_reason, not the exit code');
    assert.equal(counters.nonConvergent, 0);
    assert.equal(counters.phaseDispositions['szechuan-sauce'], undefined);
    assert.ok(logs.some((l) => l.includes('completed successfully')), 'genuine convergence logs success');
    assert.equal(readStatus(dir).phase_dispositions, undefined);
    fs.rmSync(dir, { recursive: true });
  });

  // Both-clean case. Retained as the plain happy path; the two tests above are what pin
  // WHICH input the branch keys on.
  test('AC-NS-6: genuine success (exit 0, converged) still counts completed, no disposition', () => {
    const dir = tmpDir();
    const { runtime, statePath, cancelMarker } = makeRuntime(dir);
    writeState(statePath, 'converged');
    const logs = [];
    runtime.log = (m) => logs.push(m);
    const counters = { completed: 0, skipped: 0, phaseSkips: {}, nonConvergent: 0, phaseDispositions: {} };

    const outcome = finalizePhaseSuccess(runtime, counters, cancelMarker, 'szechuan-sauce', 0, runtime.log);

    assert.equal(outcome.action, 'continue');
    assert.equal(counters.completed, 1, 'genuine convergence still counts');
    assert.equal(counters.nonConvergent, 0);
    assert.equal(counters.phaseDispositions['szechuan-sauce'], undefined);
    assert.ok(logs.some((l) => l.includes('completed successfully')), 'genuine success logs success');

    const status = readStatus(dir);
    assert.equal(status.phase_dispositions, undefined, 'no phase_dispositions key on a clean run');
    fs.rmSync(dir, { recursive: true });
  });

  test('AC-NS-6 citadel carve-out: citadel (exit 1) never enters the honesty branch', () => {
    const dir = tmpDir();
    const { runtime, statePath, cancelMarker } = makeRuntime(dir);
    // Even with a non-convergent-looking exit_reason on disk, citadel must not be gated by it.
    writeState(statePath, 'approach_exhaustion');
    const logs = [];
    runtime.log = (m) => logs.push(m);
    const counters = { completed: 0, skipped: 0, phaseSkips: {}, nonConvergent: 0, phaseDispositions: {} };

    const outcome = finalizePhaseSuccess(runtime, counters, cancelMarker, 'citadel', 1, runtime.log);

    assert.equal(outcome.action, 'continue');
    assert.equal(counters.completed, 1, 'citadel keeps its own audit-exit-code path (counts completed)');
    assert.equal(counters.nonConvergent, 0);
    assert.equal(counters.phaseDispositions['citadel'], undefined, 'no phase_dispositions entry for citadel');

    const status = readStatus(dir);
    assert.equal(status.phase_dispositions, undefined);
    fs.rmSync(dir, { recursive: true });
  });

  test('non-convergent phase still honors operator cancellation (cancel marker → break)', () => {
    const dir = tmpDir();
    const { runtime, statePath, cancelMarker } = makeRuntime(dir);
    writeState(statePath, 'stalled_below_target');
    fs.writeFileSync(cancelMarker, 'SIGINT'); // operator cancelled mid-phase
    const counters = { completed: 0, skipped: 0, phaseSkips: {}, nonConvergent: 0, phaseDispositions: {} };

    const outcome = finalizePhaseSuccess(runtime, counters, cancelMarker, 'anatomy-park', 1, runtime.log);

    assert.equal(outcome.action, 'break', 'cancelled pipeline must not advance to the next phase');
    // The phase is still reported non-convergent before the break.
    assert.equal(counters.nonConvergent, 1);
    assert.equal(counters.phaseDispositions['anatomy-park'], 'stalled_below_target');
    assert.equal(counters.completed, 0);
    fs.rmSync(dir, { recursive: true });
  });

  test('AC-NS-5 backward parse: a status file written without phase_dispositions parses cleanly', () => {
    const dir = tmpDir();
    // Simulate an older / all-converged run: no phase_dispositions supplied.
    writePipelineStatus(dir, 'completed', {
      current_phase: null,
      completed_phases: 4,
      skipped_phases: 0,
      total_phases: 4,
    });
    const status = readStatus(dir);
    assert.equal(status.status, 'completed');
    assert.equal(status.phase_dispositions, undefined, 'additive-optional: key absent when not supplied');

    // And when supplied non-empty, it is carried.
    writePipelineStatus(dir, 'running', {
      current_phase: null,
      completed_phases: 1,
      skipped_phases: 0,
      total_phases: 4,
      phase_dispositions: { 'anatomy-park': 'stalled_below_target' },
    });
    const status2 = readStatus(dir);
    assert.equal(status2.phase_dispositions['anatomy-park'], 'stalled_below_target');
    fs.rmSync(dir, { recursive: true });
  });
});

// B-NOSTOP-GATES WS-3 (AC-NSG-12): the completion panel must state the parked
// count and must not render an unqualified "Complete" when parked > 0.
describe('AC-NSG-12: completion panel honesty with parked tickets', () => {
  test('buildPipelineCompletePanel states the parked count when > 0', () => {
    const counters = { completed: 3, skipped: 0, phaseSkips: {}, nonConvergent: 0, phaseDispositions: {} };
    const panel = buildPipelineCompletePanel(counters, '3/4', 0, 2);
    assert.equal(panel.Parked, '2', 'panel must state the parked count');
  });

  function tmpSessionDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'nsg-panel-session-'));
  }

  function tmpRepoDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'nsg-panel-repo-'));
  }

  function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
  }

  function initRepo(dir) {
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'user.email', 'test@test.local'], dir);
    git(['config', 'user.name', 'Test'], dir);
    git(['config', 'commit.gpgsign', 'false'], dir);
    fs.writeFileSync(path.join(dir, 'seed.ts'), 'export const x = 1;\n');
    git(['add', '.'], dir);
    git(['commit', '-q', '-m', 'seed'], dir);
  }

  function writeFullState(sessionDir, repo) {
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
      active: false,
      working_dir: repo,
      step: 'implement',
      iteration: 0,
      max_iterations: 100,
      max_time_minutes: 720,
      worker_timeout_seconds: 1200,
      start_time_epoch: 1000,
      completion_promise: null,
      original_prompt: 'AC-NSG-12 test',
      current_ticket: null,
      history: [],
      started_at: new Date().toISOString(),
      session_dir: sessionDir,
      schema_version: 3,
      tmux_mode: false,
      chain_meeseeks: false,
      backend: 'claude',
    }, null, 2));
  }

  function writePipelineConfig(sessionDir, repo) {
    fs.writeFileSync(path.join(sessionDir, 'pipeline.json'), JSON.stringify({
      phases: ['pickle'],
      target: repo,
      anatomy_stall_limit: 3,
      szechuan_stall_limit: 5,
      anatomy_max_iterations: 100,
      szechuan_max_iterations: 50,
      dirty_exempt_segments: ['prds', 'docs'],
    }, null, 2));
  }

  function writeTicket(sessionDir, id, order, status) {
    const ticketDir = path.join(sessionDir, id);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, `rick_ticket_${id}.md`),
      `---\nid: ${id}\ntitle: Panel test ticket ${id}\nstatus: ${status}\norder: ${order}\n---\n\n# Test\n`,
    );
  }

  class ExitIntercept extends Error {
    constructor(code) {
      super(`process.exit(${code})`);
      this.code = code;
    }
  }

  async function captureMainExit(sessionDir, expectedCode) {
    const originalExit = process.exit;
    const originalTmux = process.env.TMUX;
    delete process.env.TMUX;
    process.exit = (code) => { throw new ExitIntercept(code ?? 0); };
    try {
      await assert.rejects(
        () => main(sessionDir),
        (err) => err instanceof ExitIntercept && err.code === expectedCode,
      );
    } finally {
      process.exit = originalExit;
      if (originalTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = originalTmux;
    }
  }

  afterEach(() => {
    __setSpawnRunnerForTests(null);
  });

  test('a parked-ticket run refuses an unqualified Complete (status stays non-completed)', async () => {
    const repo = tmpRepoDir();
    const sessionDir = tmpSessionDir();
    try {
      initRepo(repo);
      writeFullState(sessionDir, repo);
      writePipelineConfig(sessionDir, repo);
      writeTicket(sessionDir, 'ddd44444', 1, 'Todo');

      __setSpawnRunnerForTests(async () => {
        const statePath = path.join(sessionDir, 'state.json');
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        state.exit_reason = 'iteration_cap_exhausted';
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
        return { exitCode: 3, stdout: '', stderr: '' };
      });

      await captureMainExit(sessionDir, 3);

      const status = JSON.parse(fs.readFileSync(path.join(sessionDir, 'pipeline-status.json'), 'utf-8'));
      assert.notEqual(status.status, 'completed', 'a parked ticket must not render an unqualified Complete status');
    } finally {
      __setSpawnRunnerForTests(null);
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

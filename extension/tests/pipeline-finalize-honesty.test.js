// @tier: fast
//
// B-NONSTOP WS-2 (AC-NS-6 / AC-NS-5): finalizePhaseSuccess non-pickle honesty gate +
// phase_dispositions observability. A non-convergent anatomy-park / szechuan-sauce phase
// must NOT be reported as a clean success; a genuinely converged phase still counts; the
// pickle/citadel paths are unchanged; and pipeline-status.json carries an additive-optional
// phase_dispositions field that older status files (without it) still parse cleanly.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { finalizePhaseSuccess, writePipelineStatus } from '../bin/pipeline-runner.js';

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

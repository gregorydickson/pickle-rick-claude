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
  POST_FINAL_DEGRADED_MARKER,
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
// `postFinalVerdict` is optional: omitted, the key is absent, which is what every session
// predating ticket 4dd2d658 looks like on disk.
function writeState(statePath, exitReason, postFinalVerdict) {
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
    ...(postFinalVerdict === undefined ? {} : { post_final_verdict: postFinalVerdict }),
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

// R-NOPOSTTIER (ticket fa3d0f5a): a degraded post-final-commit fast-tier verdict must withhold
// the success verdict through the SAME `counters.nonConvergent` term the WS-B red-offender
// branch already raises — no new gate, field, halt, or exit reason. Session
// 2026-08-15-b88a6603 finished with `last_between_ticket_gate.ok: false` on disk AND an
// unqualified success; ticket 4dd2d658 now produces a FRESH verdict, which would be ignored
// exactly the same way without this.
describe('R-NOPOSTTIER: a degraded post-final verdict withholds the success verdict', () => {
  function runPickle(dir, postFinalVerdict) {
    const { runtime, statePath, cancelMarker } = makeRuntime(dir);
    writeState(statePath, 'completed', postFinalVerdict);
    const logs = [];
    runtime.log = (m) => logs.push(m);
    const counters = { completed: 0, skipped: 0, phaseSkips: {}, nonConvergent: 0, phaseDispositions: {} };
    const outcome = finalizePhaseSuccess(runtime, counters, cancelMarker, 'pickle', 0, runtime.log);
    return { outcome, counters, logs };
  }

  test('AC-2: a red verdict raises nonConvergent and names the degraded marker', () => {
    const dir = tmpDir();
    const { outcome, counters } = runPickle(dir, { state: 'red', degraded: true, dimensions: ['widget explodes'] });

    assert.equal(counters.nonConvergent, 1, 'the existing withholding term must be raised');
    assert.ok(
      counters.phaseDispositions.pickle.startsWith(`${POST_FINAL_DEGRADED_MARKER}:`),
      'the disposition must carry the degraded marker',
    );
    // AC-3: withholding the verdict is NOT failing the phase. The run still completes.
    assert.equal(outcome.action, 'continue', 'the phase loop must not break');
    assert.equal(counters.completed, 1, 'the phase still executed — this is a verdict, not a shortfall');
    assert.equal(readStatus(dir).phase_dispositions.pickle, counters.phaseDispositions.pickle);
    fs.rmSync(dir, { recursive: true });
  });

  /**
   * The AC-2 oracle. `classifyPostFinalVerdict` returns `dimensions: []` for a red gate whose
   * `failures` array is empty, and the names it WOULD carry come from
   * `parseBetweenTicketFastGateFailures`, whose fallback is a bare first-non-blank-line pick
   * (R-GBANNER, out of scope). So nothing here may assert a specific failing-test string — the
   * assertion is on the MARKER plus a non-empty attribution, and it must hold with `failures: []`.
   */
  test('AC-2 parser independence: degraded with dimensions: [] still withholds, and no test NAME is asserted', () => {
    const dir = tmpDir();
    const { counters } = runPickle(dir, { state: 'red', degraded: true, dimensions: [] });

    assert.equal(counters.nonConvergent, 1, 'an empty dimension list must not launder a red verdict');
    const disposition = counters.phaseDispositions.pickle;
    assert.ok(disposition.startsWith(`${POST_FINAL_DEGRADED_MARKER}:`), 'marker must be present');
    assert.ok(
      disposition.slice(POST_FINAL_DEGRADED_MARKER.length + 1).length > 0,
      'the marker must carry a non-empty attribution (the verdict state), not an empty suffix',
    );
    fs.rmSync(dir, { recursive: true });
  });

  // The two remaining degraded states. `absent` is the one that matters most: an unmeasurable
  // tier is not evidence of health, and classifying it green is the fake-green this closes.
  for (const state of ['inconclusive', 'absent']) {
    test(`AC-2: a ${state} verdict also withholds the success verdict`, () => {
      const dir = tmpDir();
      const { counters, outcome } = runPickle(dir, { state, degraded: true, dimensions: [] });
      assert.equal(counters.nonConvergent, 1);
      assert.equal(counters.phaseDispositions.pickle, `${POST_FINAL_DEGRADED_MARKER}:${state}`);
      assert.equal(outcome.action, 'continue');
      fs.rmSync(dir, { recursive: true });
    });
  }

  // AC-3: off-repo bundles stay green. `not_applicable` is what `runPostFinalMeasurement`
  // records when the working dir has no `extension/` — there was no tier to measure.
  test('AC-3: a not_applicable verdict does NOT withhold success', () => {
    const dir = tmpDir();
    const { counters, logs } = runPickle(dir, { state: 'not_applicable', degraded: false, dimensions: [] });

    assert.equal(counters.nonConvergent, 0, 'an off-repo bundle must stay green');
    assert.equal(counters.phaseDispositions.pickle, undefined, 'no disposition on a non-degraded verdict');
    assert.ok(logs.some((l) => l.includes('completed successfully')), 'the success log still fires');
    assert.equal(readStatus(dir).phase_dispositions, undefined);
    fs.rmSync(dir, { recursive: true });
  });

  test('AC-3: a green verdict changes nothing about today\'s behavior', () => {
    const dir = tmpDir();
    const { counters, logs } = runPickle(dir, { state: 'green', degraded: false, dimensions: [] });
    assert.equal(counters.nonConvergent, 0);
    assert.equal(counters.phaseDispositions.pickle, undefined);
    assert.ok(logs.some((l) => l.includes('completed successfully')));
    fs.rmSync(dir, { recursive: true });
  });

  // Every session predating ticket 4dd2d658 has no such key. A missing verdict must not be
  // read as degraded — that would withhold the verdict on every historical resume.
  test('an absent post_final_verdict field does NOT withhold success', () => {
    const dir = tmpDir();
    const { counters, logs } = runPickle(dir, undefined);
    assert.equal(counters.nonConvergent, 0);
    assert.equal(counters.phaseDispositions.pickle, undefined);
    assert.ok(logs.some((l) => l.includes('completed successfully')));
    fs.rmSync(dir, { recursive: true });
  });

  // A malformed record cannot fabricate a withholding either — the reader demands an explicit
  // `degraded: true` plus a non-empty string state, and returns null for anything else.
  test('a malformed post_final_verdict does NOT withhold success', () => {
    const dir = tmpDir();
    for (const malformed of [null, 'red', { degraded: true }, { state: 'red' }, { state: '', degraded: true }]) {
      const { counters } = runPickle(dir, malformed);
      assert.equal(counters.nonConvergent, 0, `malformed verdict ${JSON.stringify(malformed)} must be inert`);
    }
    fs.rmSync(dir, { recursive: true });
  });

  // The withholding must not clobber the sibling WS-B attribution — both facts are true.
  test('the degraded marker APPENDS to a disposition the red-offender branch already wrote', () => {
    const dir = tmpDir();
    const { runtime, statePath, cancelMarker } = makeRuntime(dir);
    writeState(statePath, 'completed', { state: 'red', degraded: true, dimensions: [] });
    const counters = {
      completed: 0,
      skipped: 0,
      phaseSkips: {},
      nonConvergent: 1,
      phaseDispositions: { pickle: 'done_over_red_worker_gate_tests:aaa11111' },
    };

    finalizePhaseSuccess(runtime, counters, cancelMarker, 'pickle', 0, () => {});

    assert.equal(
      counters.phaseDispositions.pickle,
      `done_over_red_worker_gate_tests:aaa11111; ${POST_FINAL_DEGRADED_MARKER}:red`,
      'both attributions must survive',
    );
    assert.equal(counters.nonConvergent, 2, 'both withholding sources count');
    fs.rmSync(dir, { recursive: true });
  });
});

// AC-12: a conforming-looking implementation could write the marker to state.json and display
// NOTHING. `phase_dispositions` already reached `pipeline-status.json` — a file read after the
// process is gone. The operator watching the run saw a bare `Non-convergent: 1` with no cause.
describe('AC-12: the degraded marker reaches the operator-visible completion output', () => {
  test('buildPipelineCompletePanel renders the disposition string, not just the count', () => {
    const counters = {
      completed: 4,
      skipped: 0,
      phaseSkips: {},
      nonConvergent: 1,
      phaseDispositions: { pickle: `${POST_FINAL_DEGRADED_MARKER}:red` },
    };
    const panel = buildPipelineCompletePanel(counters, '4/4', 90, 0);

    assert.ok(
      Object.values(panel).some((v) => v.includes(POST_FINAL_DEGRADED_MARKER)),
      'the rendered panel must state the degraded marker somewhere an operator can read it',
    );
    assert.equal(panel['Non-convergent'], '1', 'the existing count row is unchanged');
  });

  test('a clean run renders no Dispositions row (additive, byte-identical happy path)', () => {
    const counters = { completed: 4, skipped: 0, phaseSkips: {}, nonConvergent: 0, phaseDispositions: {} };
    const panel = buildPipelineCompletePanel(counters, '4/4', 90, 0);
    assert.equal(panel.Dispositions, undefined);
    assert.deepEqual(Object.keys(panel), ['Phases', 'Elapsed']);
  });
});

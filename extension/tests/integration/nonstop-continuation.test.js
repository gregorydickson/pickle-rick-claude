// @tier: integration
//
// B-NONSTOP AC-NS-1 — end-to-end proof that a non-convergent phase NEVER halts the
// pipeline and NEVER reports a give-up as success, across a real phase boundary.
//
// The per-unit tickets (T1-T5) each verify their own slice in isolation: the exit-reason
// union, `isConverged`, the disposition map, the finalize-gate honesty branch, and the
// halt arms. This file wires them together over the assembled `pipeline-runner` phase
// loop and drives the two operator journeys the field report names:
//
//   AC-NS-1a  anatomy-park exhausts its iteration budget mid-pipeline
//             -> reported non-convergent, szechuan-sauce still runs in the SAME run
//   AC-NS-1b  szechuan-sauce exhausts its iteration budget as the terminal phase
//             -> honest finalize, no success log, no abort, no successor phase
//
// Both drive the REAL `main()` loop; only the runner subprocess is stubbed (via the
// `__setSpawnRunnerForTests` seam) so the microverse exit is controllable. Phase setup
// still runs for real through `execFileSync`, so the fixture repo must carry enough
// source files for subsystem discovery.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  __setSpawnRunnerForTests,
  classifyMicroverseHaltDecision,
  main,
} from '../../bin/pipeline-runner.js';
import { classifyMicroverseDisposition } from '../../bin/microverse-runner.js';

/** The Template-A non-convergent exit both journeys are built on. */
const BUDGET_EXHAUSTED = 'iteration_budget_exhausted';

class ExitIntercept extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function initRepo(repo) {
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@test.local'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.mkdirSync(path.join(repo, 'services'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'services', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'services', 'b.ts'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(repo, 'services', 'c.ts'), 'export const c = 3;\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'seed'], repo);
}

/**
 * A session whose phase list is exactly `phases`, with LOW per-phase iteration budgets
 * (the persisted AP_MAX_ITER / SZ_MAX_ITER form) and the wall-clock cap DISABLED
 * (`max_time_minutes: 0`) so the only budget that can be exhausted is the iteration one.
 */
function makeSession(phases) {
  const repo = tmpDir('nonstop-repo-');
  const sessionDir = tmpDir('nonstop-session-');
  initRepo(repo);
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    active: false,
    working_dir: repo,
    step: 'implement',
    iteration: 0,
    max_iterations: 100,
    max_time_minutes: 0,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    tmux_mode: true,
    chain_meeseeks: false,
    backend: 'claude',
  }, null, 2));
  fs.writeFileSync(path.join(sessionDir, 'pipeline.json'), JSON.stringify({
    phases,
    target: repo,
    anatomy_stall_limit: 3,
    szechuan_stall_limit: 5,
    anatomy_max_iterations: 2,
    szechuan_max_iterations: 2,
    dirty_exempt_segments: ['prds', 'docs'],
  }, null, 2));
  return { repo, sessionDir };
}

function readState(sessionDir) {
  return JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
}

function writeExitReason(sessionDir, reason) {
  const statePath = path.join(sessionDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  state.exit_reason = reason;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function readPipelineStatus(sessionDir) {
  const p = path.join(sessionDir, 'pipeline-status.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function readRunnerLog(sessionDir) {
  return fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
}

async function expectMainExit(sessionDir, code) {
  const originalExit = process.exit;
  const originalTmux = process.env.TMUX;
  // The phase-boundary monitor respawn is best-effort; with no tmux session name it
  // degrades to a no-op instead of touching a real pane.
  delete process.env.TMUX;
  process.exit = ((actualCode) => {
    throw new ExitIntercept(actualCode ?? 0);
  });
  try {
    await assert.rejects(
      () => main(sessionDir),
      (err) => err instanceof ExitIntercept && err.code === code,
    );
  } finally {
    process.exit = originalExit;
    if (originalTmux === undefined) {
      delete process.env.TMUX;
    } else {
      process.env.TMUX = originalTmux;
    }
  }
}

afterEach(() => {
  __setSpawnRunnerForTests(null);
});

// ---------------------------------------------------------------------------
// AC-NS-1a — mid-pipeline: anatomy-park gives up, szechuan-sauce still runs
// ---------------------------------------------------------------------------

test('AC-NS-1a: anatomy-park budget exhaustion is non-convergent AND szechuan-sauce runs in the same run', async () => {
  const { repo, sessionDir } = makeSession(['anatomy-park', 'szechuan-sauce']);
  const phasesSpawned = [];
  // Snapshot of pipeline-status.json taken WHILE the run is still in flight, at the
  // moment szechuan-sauce starts. This is the live observation that anatomy's
  // disposition was recorded and that anatomy was not counted a clean completion.
  let statusAtSzechuanStart = null;

  __setSpawnRunnerForTests(async () => {
    const step = readState(sessionDir).step;
    phasesSpawned.push(step);
    if (step === 'anatomy-park') {
      // The subsystem loop ran out of iteration budget without converging.
      writeExitReason(sessionDir, BUDGET_EXHAUSTED);
      return { exitCode: 1, stdout: '', stderr: '' };
    }
    statusAtSzechuanStart = readPipelineStatus(sessionDir);
    writeExitReason(sessionDir, 'converged');
    return { exitCode: 0, stdout: '', stderr: '' };
  });

  try {
    // anatomy is reported non-convergent (neither completed nor skipped), so the run
    // ends honestly as a non-success — but it ends via the normal finalize, not an abort.
    await expectMainExit(sessionDir, 1);
    const log = readRunnerLog(sessionDir);

    // (iii) szechuan-sauce started in-process, in the SAME run. This is the headline
    // claim: a non-convergent mid-pipeline phase does not stop the pipeline.
    assert.deepEqual(
      phasesSpawned,
      ['anatomy-park', 'szechuan-sauce'],
      'szechuan-sauce must run in the same process after a non-convergent anatomy-park',
    );
    assert.ok(
      statusAtSzechuanStart,
      'pipeline-status.json must exist by the time szechuan-sauce starts',
    );

    // (i) the anatomy disposition is recorded and is NOT a success disposition.
    assert.equal(
      statusAtSzechuanStart.phase_dispositions?.['anatomy-park'],
      BUDGET_EXHAUSTED,
      'anatomy-park disposition must be recorded in pipeline-status.json',
    );
    assert.notEqual(
      classifyMicroverseDisposition(BUDGET_EXHAUSTED).reportAs,
      'success',
      'iteration_budget_exhausted must never classify as a success disposition',
    );
    assert.equal(classifyMicroverseDisposition(BUDGET_EXHAUSTED).reportAs, 'non-convergent');

    // (ii) anatomy did NOT count as a clean completion.
    assert.equal(
      statusAtSzechuanStart.completed_phases,
      0,
      'a non-convergent anatomy-park must not increment completed_phases',
    );
    assert.doesNotMatch(
      log,
      /Phase anatomy-park completed successfully/,
      'a give-up must never be reported as success',
    );
    assert.match(
      log,
      /Phase anatomy-park did NOT converge \(iteration_budget_exhausted\)/,
      'the non-convergent outcome must be reported honestly',
    );

    // The run never aborts on a Template-A disposition.
    assert.notEqual(
      classifyMicroverseHaltDecision(BUDGET_EXHAUSTED).action,
      'abort',
      'a Template-A non-convergent disposition must never route to abort',
    );
    assert.doesNotMatch(log, /aborting \(no finalize-gate\)/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-NS-1b — terminal: szechuan-sauce gives up, pipeline finalizes honestly
// ---------------------------------------------------------------------------

test('AC-NS-1b: szechuan-sauce budget exhaustion finalizes honestly without aborting', async () => {
  const { repo, sessionDir } = makeSession(['szechuan-sauce']);
  const phasesSpawned = [];

  __setSpawnRunnerForTests(async () => {
    phasesSpawned.push(readState(sessionDir).step);
    writeExitReason(sessionDir, BUDGET_EXHAUSTED);
    return { exitCode: 1, stdout: '', stderr: '' };
  });

  try {
    // Reaching finalize at all is the point: the loop ran to its end and exited through
    // the normal finalize path. Exit 1 is the HONEST non-success terminal (the phase did
    // not converge), not an abort.
    await expectMainExit(sessionDir, 1);
    const log = readRunnerLog(sessionDir);

    // (iii) there is no successor phase, and the run never aborted.
    assert.deepEqual(
      phasesSpawned,
      ['szechuan-sauce'],
      'szechuan-sauce is terminal — no successor phase may run',
    );
    assert.notEqual(
      classifyMicroverseHaltDecision(BUDGET_EXHAUSTED).action,
      'abort',
      'a Template-A non-convergent disposition must never route to abort',
    );
    assert.doesNotMatch(log, /aborting \(no finalize-gate\)/);

    // (ii) NO success log for a phase that gave up.
    assert.doesNotMatch(
      log,
      /Phase szechuan-sauce completed successfully/,
      'a give-up must never be reported as success',
    );
    assert.match(
      log,
      /Phase szechuan-sauce did NOT converge \(iteration_budget_exhausted\)/,
      'the non-convergent outcome must be reported honestly',
    );

    // The run reached finalize and reported the phase as non-convergent rather than
    // completed: 0 of 1 phases completed, with the honest disposition in the log.
    const status = readPipelineStatus(sessionDir);
    assert.ok(status, 'pipeline-status.json must exist after finalize');
    assert.equal(
      status.completed_phases,
      0,
      'a non-convergent szechuan-sauce must not increment completed_phases',
    );
    assert.equal(status.status, 'failed', 'the terminal status must be an honest non-success');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-NS-1b (i) — CANARY: the disposition must survive into the TERMINAL status file.
//
// `writeRunningStatus` supplies `phase_dispositions` mid-run, but `writePipelineStatus`
// builds a FRESH payload and renameSync-overwrites rather than merging — so whatever the
// terminal `writePipelineStatus` call in `finalizePipeline` omits is erased at exit. This
// canary pins that call to keep carrying `phase_dispositions` (and `phase_skips`, dropped
// by the identical mechanism): without them the operator-visible artifact reports a bare
// `failed` with no reason the phase gave up — the fake-green reporting this bundle exists
// to eliminate, one frame later.
//
// Was xfail through the WS-2 ticket, whose scope fence held only this test; the fix landed
// with the szechuan-sauce deslop pass that read the canary.
// ---------------------------------------------------------------------------

test('AC-NS-1b (i): terminal pipeline-status.json carries the non-convergent disposition', async () => {
  const { repo, sessionDir } = makeSession(['szechuan-sauce']);

  __setSpawnRunnerForTests(async () => {
    writeExitReason(sessionDir, BUDGET_EXHAUSTED);
    return { exitCode: 1, stdout: '', stderr: '' };
  });

  try {
    await expectMainExit(sessionDir, 1);
    const status = readPipelineStatus(sessionDir);
    assert.ok(status, 'pipeline-status.json must exist after finalize');
    assert.equal(
      status.phase_dispositions?.['szechuan-sauce'],
      BUDGET_EXHAUSTED,
      'the terminal pipeline-status.json must carry the non-convergent disposition '
        + `(observed: ${JSON.stringify(status)})`,
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

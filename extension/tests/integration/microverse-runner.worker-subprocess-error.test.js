// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeStateFile } from '../../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '../..');
const RUNNER_PATH = path.join(EXTENSION_ROOT, 'bin', 'microverse-runner.js');
const FIXTURE_BACKEND_PATH = path.join(__dirname, 'fixtures', 'mock-backend-error-at-5.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeStateFile(filePath, value);
}

function makeGitRepo(root) {
  const workingDir = path.join(root, 'repo');
  fs.mkdirSync(workingDir, { recursive: true });
  execFileSync('git', ['init'], { cwd: workingDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: workingDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workingDir, stdio: 'pipe' });
  fs.writeFileSync(path.join(workingDir, 'package.json'), JSON.stringify({
    name: 'rapmw8-fixture',
    private: true,
    scripts: {
      typecheck: 'node -e "process.exit(0)"',
      lint: 'node -e "process.exit(0)"',
      test: 'node -e "process.exit(0)"',
    },
  }, null, 2));
  execFileSync('git', ['add', '.'], { cwd: workingDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: workingDir, stdio: 'pipe' });
  return workingDir;
}

function makeRunnerState(sessionDir, workingDir) {
  return {
    active: true,
    working_dir: workingDir,
    step: 'implement',
    iteration: 0,
    max_iterations: 10,
    max_time_minutes: 10,
    worker_timeout_seconds: 0,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'R-APMW-8 integration fixture',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    command_template: 'anatomy-park.md',
    backend: 'codex',
    schema_version: 3,
  };
}

function makeMicroverseState(sessionDir, workingDir) {
  return {
    status: 'iterating',
    prd_path: path.join(sessionDir, 'prd.md'),
    convergence: {
      stall_limit: 3,
      stall_counter: 0,
      history: [],
    },
    convergence_mode: 'worker',
    convergence_file: 'anatomy-park.json',
    gap_analysis_path: path.join(sessionDir, 'gap_analysis.md'),
    failed_approaches: [],
    baseline_score: 0,
    failure_history: [],
    approach_exhaustion_fired: false,
    iteration_regressions: 0,
    gate_regression_threshold_warning_emitted: false,
    allowed_paths: [workingDir],
    consecutive_subprocess_errors: 0,
  };
}

function writeFreshGateBaseline(sessionDir, workingDir) {
  writeJson(path.join(sessionDir, 'gate', 'baseline.json'), {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    working_dir: workingDir,
    project_type: 'npm',
    checks: ['typecheck', 'lint', 'tests'],
    failures: [],
  });
}

function tailRunnerLog(sessionDir) {
  const runnerLog = path.join(sessionDir, 'microverse-runner.log');
  if (!fs.existsSync(runnerLog)) return '(missing microverse-runner.log)';
  const lines = fs.readFileSync(runnerLog, 'utf-8').trim().split('\n');
  return lines.slice(-20).join('\n');
}

// The fixture drives the runner to its 10-iteration cap, so it exits `iteration_budget_exhausted`.
// The R-NS-9 disposition map (src/bin/microverse-runner.ts) governs that exit:
// `{ reportAs: 'non-convergent', exitCode: 1 }` — budget exhaustion is honestly non-convergent,
// never a success. Assert the code TOGETHER with the reason so a disposition change cannot drift
// the exit code past this test the way a bare `status === 0` did.
const BUDGET_EXHAUSTED_EXIT_CODE = 1;

function assertBudgetExhaustedExit(fixture) {
  assert.equal(fixture.result.status, BUDGET_EXHAUSTED_EXIT_CODE, fixture.failureContext);
  assert.match(fixture.combinedOutput, /exit: iteration_budget_exhausted/, fixture.failureContext);
}

function runFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rapmw8-'));
  try {
    const sessionDir = path.join(root, 'session');
    const workingDir = makeGitRepo(root);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Fixture PRD\n');
    fs.writeFileSync(path.join(sessionDir, 'gap_analysis.md'), '# Gap Analysis\n');
    writeJson(path.join(sessionDir, 'state.json'), makeRunnerState(sessionDir, workingDir));
    writeJson(path.join(sessionDir, 'microverse.json'), makeMicroverseState(sessionDir, workingDir));
    writeJson(path.join(sessionDir, 'anatomy-park.json'), {
      subsystems: ['fixture'],
      current_index: 0,
      pass_counts: { fixture: 0 },
      consecutive_clean: { fixture: 0 },
      stall_counts: { fixture: 0 },
      stall_limit: 3,
      converged: false,
      reason: 'not started',
    });
    writeFreshGateBaseline(sessionDir, workingDir);

    const result = spawnSync(process.execPath, [RUNNER_PATH, sessionDir], {
      cwd: EXTENSION_ROOT,
      encoding: 'utf-8',
      env: {
        ...process.env,
        PICKLE_DATA_ROOT: path.join(root, 'pickle-data'),
        PICKLE_TEST_BACKEND_PATH: FIXTURE_BACKEND_PATH,
      },
    });

    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    const failureContext =
      `${combinedOutput}\n--- microverse-runner.log tail ---\n${tailRunnerLog(sessionDir)}`;
    const finalRunnerState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    const finalMicroverseState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'microverse.json'), 'utf-8'));
    return {
      result,
      combinedOutput,
      failureContext,
      finalRunnerState,
      finalMicroverseState,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('R-APMW-8: runner recovers from one error at iter 5', { timeout: 60_000 }, () => {
  const fixture = runFixture();
  assertBudgetExhaustedExit(fixture);
  assert.match(fixture.combinedOutput, /--- Iteration 6 ---/, fixture.failureContext);
  assert.match(fixture.combinedOutput, /Max iterations reached \(10\/10\)\. Exiting\./, fixture.failureContext);
  assert.equal(fixture.finalRunnerState.iteration, 10);
});

test('R-APMW-8: final state shows reset counter', { timeout: 60_000 }, () => {
  const fixture = runFixture();
  assertBudgetExhaustedExit(fixture);
  assert.equal(fixture.finalMicroverseState.consecutive_subprocess_errors, 0);
});

test('R-APMW-8: final state records last_subprocess_error.iteration', { timeout: 60_000 }, () => {
  const fixture = runFixture();
  assertBudgetExhaustedExit(fixture);
  assert.equal(fixture.finalRunnerState.last_subprocess_error.iteration, 5);
  assert.equal(fixture.finalRunnerState.last_error.iteration, 5);
});

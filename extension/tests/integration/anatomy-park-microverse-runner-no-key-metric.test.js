// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeStateFile } from '../../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '../..');
const RUNNER_PATH = path.join(EXTENSION_ROOT, 'bin', 'microverse-runner.js');
const RUNNER_SOURCE_PATH = path.join(EXTENSION_ROOT, 'src', 'bin', 'microverse-runner.ts');

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
    name: 'aprc-no-key-metric-fixture',
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
    max_iterations: 3,
    max_time_minutes: 10,
    worker_timeout_seconds: 0,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'APRC no key metric integration fixture',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    command_template: 'anatomy-park.md',
    backend: 'claude',
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

function writeChildRunner(root) {
  const childPath = path.join(root, 'run-microverse-child.mjs');
  fs.writeFileSync(childPath, [
    `import * as fs from 'node:fs';`,
    `const sessionDir = process.argv[2];`,
    `const runner = await import(${JSON.stringify(pathToFileURL(RUNNER_PATH).href)});`,
    `runner._deps.sleep = async () => {};`,
    // The stub plays the WORKER: it writes the convergence file and exits. The production
    // handleWorkerManagedIteration must read it, so the counted log lines are the runner's own.
    `runner._deps.runIteration = async (_sessionDir, iteration) => {`,
    `  const cleanPasses = Math.max(0, iteration - 1);`,
    `  const converged = iteration >= 3;`,
    `  const reason = converged ? 'fixture clean pass 2/2' : 'fixture clean pass ' + cleanPasses + '/2; continuing rotation';`,
    `  fs.writeFileSync(new URL('anatomy-park.json', 'file://' + _sessionDir + '/'), JSON.stringify({`,
    `    subsystems: ['fixture'],`,
    `    current_index: 0,`,
    `    pass_counts: { fixture: iteration },`,
    `    consecutive_clean: { fixture: converged ? 2 : cleanPasses },`,
    `    stall_counts: { fixture: 0 },`,
    `    stall_limit: 3,`,
    `    converged,`,
    `    reason,`,
    `  }, null, 2));`,
    `  fs.writeFileSync(new URL('tmux_iteration_' + iteration + '.log', 'file://' + _sessionDir + '/'), 'fixture worker success\\n');`,
    `  return { completion: 'success', timedOut: false, exitCode: 0, wallSeconds: 1 };`,
    `};`,
    `await runner.main(sessionDir);`,
    '',
  ].join('\n'));
  return childPath;
}

test('anatomy-park microverse-runner completes without key_metric after worker convergence is not yet', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aprc-no-key-metric-'));
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

    const childPath = writeChildRunner(root);
    const result = spawnSync(process.execPath, [childPath, sessionDir], {
      cwd: EXTENSION_ROOT,
      encoding: 'utf-8',
      env: {
        ...process.env,
        PICKLE_DATA_ROOT: path.join(root, 'pickle-data'),
      },
    });

    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, combinedOutput);
    assert.match(combinedOutput, /--- Iteration 1 ---/);
    assert.match(combinedOutput, /--- Iteration 2 ---/);
    assert.match(combinedOutput, /--- Iteration 3 ---/);
    assert.equal((combinedOutput.match(/worker convergence: not yet/g) ?? []).length, 2, combinedOutput);
    assert.doesNotMatch(combinedOutput, /Cannot read properties of undefined \(reading 'description'\)/);
    assert.doesNotMatch(combinedOutput, /\[FATAL\]/);

    const finalMv = JSON.parse(fs.readFileSync(path.join(sessionDir, 'microverse.json'), 'utf-8'));
    const finalRunnerState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(finalMv.exit_reason, 'converged');
    assert.equal(finalRunnerState.iteration, 3);
    assert.equal(Object.hasOwn(finalMv, 'key_metric'), false, 'fixture must omit key_metric');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('anatomy-park guard audit: microverse-runner routes key_metric and history reads through helpers', () => {
  const source = fs.readFileSync(RUNNER_SOURCE_PATH, 'utf-8');

  assert.match(source, /function keyMetricDescription\(/);
  assert.match(source, /function normalizeHistoryEntries\(/);
  assert.doesNotMatch(source, /mvState\.key_metric\.\w+/);
  assert.match(source, /const filteredHistory = normalizeHistoryEntries\(history\);/);
  assert.match(source, /const history = normalizeHistoryEntries\(mvState\.convergence\?\.history\);/);
  assert.match(source, /const history = normalizeHistoryEntries\(metricConv\.history\);/);
  assert.match(source, /const accepted = normalizeHistoryEntries\(mvState\.convergence\?\.history\)/);
});

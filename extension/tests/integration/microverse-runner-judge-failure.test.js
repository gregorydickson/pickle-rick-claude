// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeStateFile } from '../../services/pickle-utils.js';
import { createMicroverseState } from '../../services/microverse-state.js';
import { measureLlmMetric, measureLlmMetricWithBackoff, _deps, handleWorkerManagedIteration } from '../../bin/microverse-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '../..');
const INIT_PATH = path.join(EXTENSION_ROOT, 'bin', 'init-microverse.js');
const RUNNER_PATH = path.join(EXTENSION_ROOT, 'bin', 'microverse-runner.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeStateFile(filePath, value);
}

function withTempExtensionSettings(settings, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-ext-settings-'));
  const prev = {
    EXTENSION_DIR: process.env.EXTENSION_DIR,
    EXTENSION_DIR_TEST: process.env.EXTENSION_DIR_TEST,
    NODE_ENV: process.env.NODE_ENV,
  };
  fs.writeFileSync(path.join(dir, 'pickle_settings.json'), JSON.stringify(settings, null, 2));
  process.env.EXTENSION_DIR = dir;
  process.env.EXTENSION_DIR_TEST = '1';
  process.env.NODE_ENV = 'test';
  const cleanup = () => {
    if (prev.EXTENSION_DIR === undefined) delete process.env.EXTENSION_DIR;
    else process.env.EXTENSION_DIR = prev.EXTENSION_DIR;
    if (prev.EXTENSION_DIR_TEST === undefined) delete process.env.EXTENSION_DIR_TEST;
    else process.env.EXTENSION_DIR_TEST = prev.EXTENSION_DIR_TEST;
    if (prev.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev.NODE_ENV;
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    const result = fn(dir);
    if (result && typeof result.then === 'function') {
      return result.finally(cleanup);
    }
    cleanup();
    return result;
  } catch (err) {
    cleanup();
    throw err;
  }
}

function makeGitRepo(root) {
  const workingDir = path.join(root, 'repo');
  fs.mkdirSync(workingDir, { recursive: true });
  execFileSync('git', ['init'], { cwd: workingDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: workingDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workingDir, stdio: 'pipe' });
  fs.writeFileSync(path.join(workingDir, 'package.json'), JSON.stringify({ name: 'mv-judge-failure-fixture', private: true }, null, 2));
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
    original_prompt: 'microverse judge failure integration fixture',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    command_template: 'microverse.md',
    backend: 'codex',
    schema_version: 3,
    min_iterations: 1,
  };
}

function writeChildRunner(root) {
  const childPath = path.join(root, 'run-microverse-child.mjs');
  fs.writeFileSync(childPath, [
    `import * as fs from 'node:fs';`,
    `import * as path from 'node:path';`,
    `const sessionDir = process.argv[2];`,
    `const runner = await import(${JSON.stringify(pathToFileURL(RUNNER_PATH).href)});`,
    `runner._deps.sleep = async () => {};`,
    `runner._deps.getHeadSha = () => 'fixture-sha';`,
    `runner._deps.execFileSync = (cmd, args) => {`,
    `  // Judge always uses claude binary even when session backend=codex (R-SCJM-2).`,
    `  if (cmd === 'claude') {`,
    `    fs.writeFileSync(path.join(sessionDir, 'captured-judge-argv.json'), JSON.stringify(args, null, 2));`,
    `    throw new Error('fixture judge unreachable');`,
    `  }`,
    `  return '';`,
    `};`,
    `// The default (non-legacy) judge path spawns through _deps.spawn, not execFileSync.`,
    `const realSpawn = runner._deps.spawn;`,
    `runner._deps.spawn = (cmd, args, opts) => {`,
    `  if (cmd === 'claude') {`,
    `    fs.writeFileSync(path.join(sessionDir, 'captured-judge-argv.json'), JSON.stringify(args, null, 2));`,
    `    throw new Error('fixture judge unreachable');`,
    `  }`,
    `  return realSpawn(cmd, args, opts);`,
    `};`,
    `runner._deps.runIteration = async (_sessionDir, iteration) => {`,
    `  fs.writeFileSync(path.join(_sessionDir, 'tmux_iteration_' + iteration + '.log'), 'fixture worker success\\\\n');`,
    `  if (iteration >= 1) {`,
    `    fs.writeFileSync(path.join(_sessionDir, 'microverse-result.json'), JSON.stringify({ converged: true, reason: 'fixture worker said done' }, null, 2));`,
    `  }`,
    `  return { completion: 'success', timedOut: false, exitCode: 0, wallSeconds: 1 };`,
    `};`,
    `await runner.main(sessionDir);`,
    '',
  ].join('\n'));
  return childPath;
}

test('codex backend: judge uses claude binary with default model (R-SCJM-2)', async () => {
  // Regression guard for R-SCJM-2: with session backend=codex, the judge
  // must spawn via claude (not codex) and always include --model claude-sonnet-4-6.
  process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = '1';
  const originalExec = _deps.execFileSync;
  const capturedArgv = [];
  _deps.execFileSync = (cmd, args) => {
    assert.equal(cmd, 'claude', `judge must use claude binary even when session backend=codex, got: ${cmd}`);
    capturedArgv.push(args);
    throw new Error('fixture judge unreachable');
  };

  try {
    const first = await measureLlmMetric('default metric fixture', 30, os.tmpdir(), undefined, [], undefined, undefined, 'codex');
    const second = await measureLlmMetric('default metric fixture', 30, os.tmpdir(), undefined, [], undefined, undefined, 'codex');

    assert.equal(first, null);
    assert.equal(second, null);
    assert.equal(capturedArgv.length, 2);
    for (const argv of capturedArgv) {
      const modelIdx = argv.indexOf('--model');
      assert.ok(modelIdx >= 0, `claude judge must include --model flag: ${JSON.stringify(argv)}`);
      assert.equal(argv[modelIdx + 1], 'claude-sonnet-4-6', `judge must use DEFAULT_JUDGE_MODEL: ${JSON.stringify(argv)}`);
    }
  } finally {
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    _deps.execFileSync = originalExec;
  }
});

test('microverse codex judge setting still measures through claude binary (R-SCJM-5)', async () => {
  process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = '1';
  const originalExec = _deps.execFileSync;
  const captured = [];
  _deps.execFileSync = (cmd, args) => {
    captured.push({ cmd, args });
    return Array.isArray(args) && args[0] === '--version' ? 'claude/2.1.0' : '13';
  };

  try {
    const result = await withTempExtensionSettings(
      { microverse: { judge_backend: 'codex' } },
      () => measureLlmMetricWithBackoff('settings fixture', 30, os.tmpdir(), undefined, [], undefined, undefined, 'codex'),
    );

    assert.deepEqual(result.metric, { raw: '13', score: 13 });
    const measurementCalls = captured.filter(({ args }) => !args.includes('--version'));
    assert.equal(measurementCalls.length, 1);
    assert.equal(measurementCalls[0].cmd, 'claude', 'judge measurement must stay on claude when settings pin codex');
  } finally {
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    _deps.execFileSync = originalExec;
  }
});

test('microverse-runner codex worker convergence with empty history honors worker convergence for metric_type=none', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-runner-judge-failure-'));
  try {
    const sessionDir = path.join(root, 'session');
    const workingDir = makeGitRepo(root);
    fs.mkdirSync(sessionDir, { recursive: true });
    writeJson(path.join(sessionDir, 'state.json'), makeRunnerState(sessionDir, workingDir));

    execFileSync(process.execPath, [
      INIT_PATH,
      sessionDir,
      workingDir,
      '--stall-limit',
      '3',
      '--convergence-mode',
      'worker',
      '--convergence-file',
      'microverse-result.json',
    ], { cwd: EXTENSION_ROOT, stdio: 'pipe' });
    const initializedMv = createMicroverseState({
      prdPath: 'prd.md',
      metric: {
        description: 'worker-managed convergence',
        validation: '',
        type: 'none',
        timeout_seconds: 30,
        tolerance: 0,
      },
      stallLimit: 3,
      convergenceMode: 'worker',
      convergenceFile: 'microverse-result.json',
    });
    initializedMv.status = 'iterating';
    initializedMv.gap_analysis_path = 'gap.md';
    fs.writeFileSync(path.join(sessionDir, 'microverse.json'), JSON.stringify(initializedMv, null, 2));
    writeJson(path.join(sessionDir, 'microverse-result.json'), { converged: false, reason: 'not started' });

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
    assert.equal(fs.existsSync(path.join(sessionDir, 'captured-judge-argv.json')), false, 'worker-managed convergence must not invoke judge CLI');

    const finalMv = JSON.parse(fs.readFileSync(path.join(sessionDir, 'microverse.json'), 'utf-8'));
    assert.equal(finalMv.exit_reason, 'converged');
    assert.equal(finalMv.status, 'converged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('convergence guard fires when all history scores are null (R-SCJM-3)', async () => {
  // Regression guard for R-SCJM-3: in worker convergence mode with a non-none
  // metric type, if every history entry has a null score the guard must block
  // convergence and return judge_unreachable.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-null-score-guard-'));
  try {
    const sessionDir = path.join(root, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });

    // convergence file: worker signals done
    const cfPath = path.join(sessionDir, 'microverse-result.json');
    fs.writeFileSync(cfPath, JSON.stringify({ converged: true, reason: 'fixture done' }));

    // currentMv: metric_type='llm' (non-none) + worker mode + all null scores in history
    const currentMv = {
      status: 'iterating',
      prd_path: 'prd.md',
      key_metric: { description: 'judge quality', validation: '', type: 'llm', timeout_seconds: 30, tolerance: 0 },
      convergence: {
        stall_limit: 3,
        stall_counter: 0,
        history: [
          { iteration: 1, metric_value: '', score: null, action: 'accept', description: 'iter1', pre_iteration_sha: 'sha1', timestamp: new Date().toISOString() },
          { iteration: 2, metric_value: '', score: null, action: 'accept', description: 'iter2', pre_iteration_sha: 'sha2', timestamp: new Date().toISOString() },
        ],
      },
      gap_analysis_path: 'gap.md',
      failed_approaches: [],
      baseline_score: 0,
      failure_history: [],
      approach_exhaustion_fired: false,
      convergence_file: 'microverse-result.json',
      convergence_mode: 'worker',
    };

    const result = await handleWorkerManagedIteration({
      currentMv,
      preIterSha: 'sha2',
      workingDir: sessionDir,
      sessionDir,
      enabledFiles: [],
      regressionWarningThreshold: 0,
      backend: 'claude',
      remediatorTimeoutS: 30,
      log: () => {},
      iteration: 2,
      minIterations: 1,
      _deps: {
        runGateFn: async () => ({ status: 'green', failures: [], baseline_used: false, allowed_paths_used: false, elapsed_ms: 0, total_raw_failure_count: 0, new_failures_vs_baseline: 0 }),
        logActivityFn: () => {},
        getHeadShaFn: () => 'sha2',
      },
    });

    assert.equal(result.converged, false, 'guard must block convergence when all scores are null');
    assert.equal(result.exitReason, 'judge_unreachable', 'exit reason must be judge_unreachable when all scores are null');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('judge failure with Codex ChatGPT error exits judge_unreachable with non-zero status (R-SCJM-4)', () => {
  // Regression guard for R-SCJM-4: when the judge spawn throws the literal
  // Codex ChatGPT unsupported-model error twice (pre-seeded as null-score history),
  // the runner must exit judge_unreachable with a non-zero status code.
  const CODEX_CHATGPT_ERROR = 'claude-sonnet-4-6 model is not supported when using Codex with a ChatGPT account';

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-judge-chatgpt-error-'));
  try {
    const sessionDir = path.join(root, 'session');
    const workingDir = makeGitRepo(root);
    fs.mkdirSync(sessionDir, { recursive: true });

    writeJson(path.join(sessionDir, 'state.json'), makeRunnerState(sessionDir, workingDir));

    execFileSync(process.execPath, [
      INIT_PATH,
      sessionDir,
      workingDir,
      '--stall-limit',
      '3',
      '--convergence-mode',
      'worker',
      '--convergence-file',
      'microverse-result.json',
    ], { cwd: EXTENSION_ROOT, stdio: 'pipe' });

    // LLM metric + worker mode + 2 null-score history entries representing the
    // judge having thrown the Codex ChatGPT error twice in prior iterations.
    const mv = createMicroverseState({
      prdPath: 'prd.md',
      metric: {
        description: 'judge quality gate',
        validation: 'echo judge',
        type: 'llm',
        timeout_seconds: 30,
        tolerance: 0,
      },
      stallLimit: 3,
      convergenceMode: 'worker',
      convergenceFile: 'microverse-result.json',
    });
    mv.status = 'iterating';
    mv.gap_analysis_path = 'gap.md';
    mv.baseline_score = 0;
    mv.convergence.history = [
      {
        iteration: 1,
        metric_value: '',
        score: null,
        action: 'accept',
        description: 'iter1: judge threw Codex ChatGPT error',
        pre_iteration_sha: 'sha1',
        timestamp: new Date().toISOString(),
      },
      {
        iteration: 2,
        metric_value: '',
        score: null,
        action: 'accept',
        description: 'iter2: judge threw Codex ChatGPT error',
        pre_iteration_sha: 'sha2',
        timestamp: new Date().toISOString(),
      },
    ];
    fs.writeFileSync(path.join(sessionDir, 'microverse.json'), JSON.stringify(mv, null, 2));

    // Worker signals convergence; guard blocks it because all history scores are null.
    writeJson(path.join(sessionDir, 'microverse-result.json'), { converged: true, reason: 'worker done' });

    const childPath = path.join(root, 'run-chatgpt-error.mjs');
    fs.writeFileSync(childPath, [
      `import * as fs from 'node:fs';`,
      `import * as path from 'node:path';`,
      `const sessionDir = process.argv[2];`,
      `const runner = await import(${JSON.stringify(pathToFileURL(RUNNER_PATH).href)});`,
      `runner._deps.sleep = async () => {};`,
      `runner._deps.getHeadSha = () => 'fixture-sha';`,
      `// Stub: any claude invocation (probe or measurement) throws the literal Codex ChatGPT error.`,
      `runner._deps.execFileSync = (cmd, _args) => {`,
      `  if (cmd === 'claude') {`,
      `    throw new Error(${JSON.stringify(CODEX_CHATGPT_ERROR)});`,
      `  }`,
      `  return '';`,
      `};`,
      `runner._deps.runIteration = async (_sessionDir, iteration) => {`,
      `  fs.writeFileSync(path.join(_sessionDir, 'tmux_iteration_' + iteration + '.log'), 'fixture worker success\\n');`,
      `  return { completion: 'success', timedOut: false, exitCode: 0, wallSeconds: 1 };`,
      `};`,
      `await runner.main(sessionDir);`,
      '',
    ].join('\n'));

    const result = spawnSync(process.execPath, [childPath, sessionDir], {
      cwd: EXTENSION_ROOT,
      encoding: 'utf-8',
      env: {
        ...process.env,
        PICKLE_DATA_ROOT: path.join(root, 'pickle-data'),
      },
    });

    const combinedOutput = `${result.stdout}\n${result.stderr}`;

    // (b) non-zero exit
    assert.notEqual(result.status, 0, `expected non-zero exit; got ${result.status}\n${combinedOutput}`);

    // (a) microverse.json records judge_unreachable
    const finalMv = JSON.parse(fs.readFileSync(path.join(sessionDir, 'microverse.json'), 'utf-8'));
    assert.equal(
      finalMv.exit_reason,
      'judge_unreachable',
      `microverse.json.exit_reason: expected judge_unreachable, got ${finalMv.exit_reason}\n${combinedOutput}`,
    );

    // (c) state.json reflects the judge_unreachable terminal state
    const finalState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(
      finalState.exit_reason,
      'judge_unreachable',
      `state.json.exit_reason: expected judge_unreachable, got ${finalState.exit_reason}\n${combinedOutput}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

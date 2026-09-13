// @tier: fast
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  __setSpawnRunnerForTests,
  main,
} from '../bin/pipeline-runner.js';

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

function makeSession() {
  const repo = tmpDir('pipeline-aph-repo-');
  const sessionDir = tmpDir('pipeline-aph-session-');
  initRepo(repo);
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
    original_prompt: 'test',
    current_ticket: 'TICKET-7',
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    tmux_mode: true,
    chain_meeseeks: true,
    backend: 'claude',
  }, null, 2));
  fs.writeFileSync(path.join(sessionDir, 'pipeline.json'), JSON.stringify({
    phases: ['anatomy-park', 'szechuan-sauce'],
    target: repo,
    anatomy_stall_limit: 3,
    szechuan_stall_limit: 5,
    anatomy_max_iterations: 100,
    szechuan_max_iterations: 50,
    dirty_exempt_segments: ['prds', 'docs'],
  }, null, 2));
  return { repo, sessionDir };
}

async function expectMainExit(sessionDir, code) {
  const originalExit = process.exit;
  const originalTmux = process.env.TMUX;
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

function assertRunnerScript(actualPath, scriptName) {
  const normalized = path.normalize(actualPath);
  assert.deepEqual(normalized.split(path.sep).slice(-3), ['extension', 'bin', scriptName]);
}

afterEach(() => {
  __setSpawnRunnerForTests(null);
});

test('pipeline advances from worker-mode anatomy-park convergence into szechuan-sauce', async () => {
  const { repo, sessionDir } = makeSession();
  const calls = [];
  __setSpawnRunnerForTests(async (cmd, args) => {
    calls.push({ cmd, args });
    if (calls.length === 1) {
      fs.writeFileSync(path.join(sessionDir, 'anatomy-park.json'), JSON.stringify({
        converged: true,
        reason: 'worker convergence complete',
      }, null, 2));
      fs.writeFileSync(path.join(sessionDir, 'microverse.json'), JSON.stringify({
        status: 'converged',
        exit_reason: 'converged',
        convergence_mode: 'worker',
        convergence_file: 'anatomy-park.json',
      }, null, 2));
      fs.writeFileSync(path.join(sessionDir, 'microverse-finalizer-error.json'), JSON.stringify({
        status: 'stopped',
        exit_reason: 'error',
        preserved_exit_reason: 'converged',
      }, null, 2));
    }
    return 0;
  });

  try {
    await expectMainExit(sessionDir, 0);
    assert.equal(calls.length, 2);
    assertRunnerScript(calls[0].args[0], 'microverse-runner.js');
    assertRunnerScript(calls[1].args[0], 'microverse-runner.js');
    const finalizerError = JSON.parse(fs.readFileSync(path.join(sessionDir, 'microverse-finalizer-error.json'), 'utf-8'));
    assert.equal(finalizerError.preserved_exit_reason, 'converged');
    const prd = fs.readFileSync(path.join(sessionDir, 'prd.md'), 'utf-8');
    assert.match(prd, /Szechuan Sauce/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('pipeline downgrades known anatomy-park missing-key-metric fatal to phase_skipped_with_warning', async () => {
  const { repo, sessionDir } = makeSession();
  const calls = [];
  __setSpawnRunnerForTests(async (cmd, args) => {
    calls.push({ cmd, args });
    if (calls.length === 1) {
      const statePath = path.join(sessionDir, 'state.json');
      const currentState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      currentState.exit_reason = 'fatal';
      currentState.command_template = 'anatomy-park.md';
      fs.writeFileSync(statePath, JSON.stringify(currentState, null, 2));
      return {
        exitCode: 1,
        stdout: '',
        stderr: "TypeError: Cannot read properties of undefined (reading 'description')\n",
      };
    }
    return 0;
  });

  try {
    // B-RELVERD V4: the downgrade still CONTINUES (szechuan-sauce runs — calls.length 2), but
    // the crash is named `crash_downgraded` and withholds success, so the run exits Failure (1).
    await expectMainExit(sessionDir, 1);
    assert.equal(calls.length, 2);
    assertRunnerScript(calls[0].args[0], 'microverse-runner.js');
    assertRunnerScript(calls[1].args[0], 'microverse-runner.js');

    const status = JSON.parse(fs.readFileSync(path.join(sessionDir, 'pipeline-status.json'), 'utf-8'));
    assert.equal(status.phase_skips['anatomy-park'], 'crash_downgraded');

    const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.match(runnerLog, /phase_skipped_with_warning/);
    assert.match(runnerLog, /anatomy_park_missing_key_metric/);

    const prd = fs.readFileSync(path.join(sessionDir, 'prd.md'), 'utf-8');
    assert.match(prd, /Szechuan Sauce/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// @tier: integration
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  __setSpawnRunnerForTests,
  main,
} from '../../bin/pipeline-runner.js';

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

function makeSession(phases) {
  const repo = tmpDir('pipeline-jr-repo-');
  const sessionDir = tmpDir('pipeline-jr-session-');
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

afterEach(() => {
  __setSpawnRunnerForTests(null);
});

test('all_judge_backends_exhausted + gate pass → exit code 3 (PhaseIncomplete), exit_reason=pipeline_phase_incomplete, auto-resume=true', async () => {
  const { repo, sessionDir } = makeSession(['szechuan-sauce']);
  const spawnCalls = [];
  let callCount = 0;
  __setSpawnRunnerForTests(async (cmd, args) => {
    spawnCalls.push({ cmd, args: [...args] });
    callCount++;
    const statePath = path.join(sessionDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    if (callCount === 1) {
      // microverse-runner: exits with all_judge_backends_exhausted
      state.exit_reason = 'all_judge_backends_exhausted';
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      return { exitCode: 1, stdout: '', stderr: '' };
    }
    // finalize-gate: pass (exit 0)
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  try {
    // PhaseIncomplete = exit code 3
    await expectMainExit(sessionDir, 3);

    const finalizeGateCalls = spawnCalls.filter(c => c.args.some(a => String(a).includes('finalize-gate.js')));
    assert.equal(finalizeGateCalls.length, 1, 'finalize-gate.js must be spawned once for all_judge_backends_exhausted');

    const statePath = path.join(sessionDir, 'state.json');
    const finalState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(finalState.exit_reason, 'pipeline_phase_incomplete', 'exit_reason must be pipeline_phase_incomplete on gate pass');

    const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.match(runnerLog, /all_judge_backends_exhausted/, 'log must mention the exit reason');
    assert.match(runnerLog, /marking phase incomplete/, 'log must mention phase incomplete');
    assert.doesNotMatch(runnerLog, /aborting \(no finalize-gate\)/, 'log must NOT contain abort message');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('all_judge_backends_exhausted + gate fail → exit code 1 (failed), auto-resume=false', async () => {
  const { repo, sessionDir } = makeSession(['szechuan-sauce']);
  const spawnCalls = [];
  let callCount = 0;
  __setSpawnRunnerForTests(async (cmd, args) => {
    spawnCalls.push({ cmd, args: [...args] });
    callCount++;
    const statePath = path.join(sessionDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    if (callCount === 1) {
      state.exit_reason = 'all_judge_backends_exhausted';
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      return { exitCode: 1, stdout: '', stderr: '' };
    }
    // finalize-gate: fail (cap exhausted, exit 2)
    return { exitCode: 2, stdout: '', stderr: '' };
  });
  try {
    await expectMainExit(sessionDir, 1);

    const finalizeGateCalls = spawnCalls.filter(c => c.args.some(a => String(a).includes('finalize-gate.js')));
    assert.equal(finalizeGateCalls.length, 1, 'finalize-gate.js must still be spawned when it will fail');

    const statePath = path.join(sessionDir, 'state.json');
    const finalState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    // AC-MWMO-D2-10 (R-MWMO d2 WS-3, `5e544152`): finalizePipeline no longer overwrites a
    // specific recorded exit_reason with the generic 'failed' — it preserves it, matching the
    // sibling phaseIncomplete/handoffStop branch (and the `pipeline_phase_incomplete` assertion
    // above). 'failed' is stamped ONLY when no reason was recorded. Erasing a named disposition
    // into a generic one is the observability loss the operating principles forbid.
    assert.equal(
      finalState.exit_reason,
      'all_judge_backends_exhausted',
      'exit_reason must PRESERVE the recorded reason when the gate fails (not erase it to "failed")',
    );

    const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.match(runnerLog, /all_judge_backends_exhausted/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('judge_cli_missing → terminal disposition, finalize-gate NOT spawned, exit code 1, auto-resume=false', async () => {
  const { repo, sessionDir } = makeSession(['szechuan-sauce']);
  const spawnCalls = [];
  __setSpawnRunnerForTests(async (cmd, args) => {
    spawnCalls.push({ cmd, args: [...args] });
    const statePath = path.join(sessionDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    state.exit_reason = 'judge_cli_missing';
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    return { exitCode: 1, stdout: '', stderr: '' };
  });
  try {
    await expectMainExit(sessionDir, 1);

    const finalizeGateCalls = spawnCalls.filter(c => c.args.some(a => String(a).includes('finalize-gate.js')));
    assert.equal(finalizeGateCalls.length, 0, 'finalize-gate.js must NOT be spawned for judge_cli_missing (terminal)');

    const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.doesNotMatch(runnerLog, /running finalize-gate anyway/);
    assert.doesNotMatch(runnerLog, /marking phase incomplete/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

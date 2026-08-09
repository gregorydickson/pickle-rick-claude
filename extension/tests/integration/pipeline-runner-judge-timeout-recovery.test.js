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
  const repo = tmpDir('pipeline-jt-repo-');
  const sessionDir = tmpDir('pipeline-jt-session-');
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

test('szechuan-sauce exits judge_timeout — finalize-gate is spawned with skill=szechuan', async () => {
  const { repo, sessionDir } = makeSession(['szechuan-sauce']);
  const spawnCalls = [];
  let callCount = 0;
  __setSpawnRunnerForTests(async (cmd, args) => {
    spawnCalls.push({ cmd, args: [...args] });
    callCount++;
    const statePath = path.join(sessionDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    if (callCount === 1) {
      // microverse-runner: exits with judge_timeout
      state.exit_reason = 'judge_timeout';
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      return { exitCode: 1, stdout: '', stderr: '' };
    }
    // finalize-gate: exits 0
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  try {
    await expectMainExit(sessionDir, 0);
    const finalizeGateCalls = spawnCalls.filter(c => c.args.some(a => String(a).includes('finalize-gate.js')));
    assert.equal(finalizeGateCalls.length, 1, 'finalize-gate.js must be spawned exactly once for judge_timeout');
    assert.ok(
      finalizeGateCalls[0].args.some(a => String(a) === 'szechuan'),
      'finalize-gate must be called with skill=szechuan for szechuan-sauce phase',
    );
    const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.match(runnerLog, /running finalize-gate anyway/, 'log must contain R-PRJT-2 recovery message');
    assert.doesNotMatch(runnerLog, /aborting \(no finalize-gate\)/, 'log must NOT contain abort message');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('anatomy-park exits judge_timeout — finalize-gate is spawned with skill=anatomy-park', async () => {
  const { repo, sessionDir } = makeSession(['anatomy-park']);
  const spawnCalls = [];
  let callCount = 0;
  __setSpawnRunnerForTests(async (cmd, args) => {
    spawnCalls.push({ cmd, args: [...args] });
    callCount++;
    const statePath = path.join(sessionDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    if (callCount === 1) {
      state.exit_reason = 'judge_timeout';
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      return { exitCode: 1, stdout: '', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  try {
    await expectMainExit(sessionDir, 0);
    const finalizeGateCalls = spawnCalls.filter(c => c.args.some(a => String(a).includes('finalize-gate.js')));
    assert.equal(finalizeGateCalls.length, 1, 'finalize-gate.js must be spawned for judge_timeout in anatomy-park');
    assert.ok(
      finalizeGateCalls[0].args.some(a => String(a) === 'anatomy-park'),
      'finalize-gate must be called with skill=anatomy-park',
    );
    const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.match(runnerLog, /running finalize-gate anyway/);
    assert.doesNotMatch(runnerLog, /aborting \(no finalize-gate\)/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('judge_timeout with failing finalize-gate exits pipeline with failure', async () => {
  const { repo, sessionDir } = makeSession(['szechuan-sauce']);
  const spawnCalls = [];
  let callCount = 0;
  __setSpawnRunnerForTests(async (cmd, args) => {
    spawnCalls.push({ cmd, args: [...args] });
    callCount++;
    const statePath = path.join(sessionDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    if (callCount === 1) {
      state.exit_reason = 'judge_timeout';
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      return { exitCode: 1, stdout: '', stderr: '' };
    }
    // finalize-gate fails
    return { exitCode: 2, stdout: '', stderr: '' };
  });
  try {
    await expectMainExit(sessionDir, 1);
    const finalizeGateCalls = spawnCalls.filter(c => c.args.some(a => String(a).includes('finalize-gate.js')));
    assert.equal(finalizeGateCalls.length, 1, 'finalize-gate.js must still be spawned when it will fail');
    const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.match(runnerLog, /running finalize-gate anyway/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// B-ONEABORT AC-OA-1a: judge_unreachable is a MICROVERSE_EXIT_REASONS union member, so it routes
// to run-finalize-gate-incomplete, not a bare abort — mirrors the f378ffd1 reconciliation already
// applied to the fast-tier twin pipeline-runner-judge-unreachable.test.js. The gate IS spawned;
// here it fails (stub returns exitCode 1 for every call), so the phase breaks and the pipeline
// still exits 1 — degraded, not a bare abort.
test('judge_unreachable (union member) — finalize-gate IS spawned, gate fails, pipeline degrades to exit 1 (does not abort)', async () => {
  const { repo, sessionDir } = makeSession(['szechuan-sauce']);
  const spawnCalls = [];
  __setSpawnRunnerForTests(async (cmd, args) => {
    spawnCalls.push({ cmd, args: [...args] });
    const statePath = path.join(sessionDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    state.exit_reason = 'judge_unreachable';
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    return { exitCode: 1, stdout: '', stderr: '' };
  });
  try {
    await expectMainExit(sessionDir, 1);
    const finalizeGateCalls = spawnCalls.filter(c => c.args.some(a => String(a).includes('finalize-gate.js')));
    assert.equal(
      finalizeGateCalls.length,
      1,
      'finalize-gate.js MUST be spawned for judge_unreachable — union member, B-ONEABORT AC-OA-1a',
    );
    const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.match(runnerLog, /finalize-gate failed after judge_unreachable/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

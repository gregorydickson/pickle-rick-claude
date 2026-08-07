// @tier: fast
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

function makeSession(phases) {
  const repo = tmpDir('pipeline-jur-repo-');
  const sessionDir = tmpDir('pipeline-jur-session-');
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

function writeExitReason(sessionDir, exitReason) {
  const statePath = path.join(sessionDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  state.exit_reason = exitReason;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function makeJudgeSpawnAck(sessionDir, spawnCalls, exitReason, finalizeGateExitCode = 0) {
  let microverseSpawned = false;
  return async (cmd, args) => {
    spawnCalls.push({ cmd, args: [...args] });
    const scriptName = path.basename(args[0]);
    if (scriptName === 'microverse-runner.js') {
      microverseSpawned = true;
      writeExitReason(sessionDir, exitReason);
      return { exitCode: 1, stdout: '', stderr: '' };
    }
    if (scriptName === 'finalize-gate.js') {
      assert.equal(microverseSpawned, true, 'finalize-gate must only run after the judge exit reason is persisted');
      return { exitCode: finalizeGateExitCode, stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected runner spawn: ${scriptName}`);
  };
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

test('judge halt classification keeps judge_timeout recoverable and judge_unreachable fatal', () => {
  assert.deepEqual(classifyMicroverseHaltDecision('judge_timeout'), {
    action: 'run-finalize-gate',
    recognizedExitReason: 'judge_timeout',
  });
  // B-ONEABORT AC-OA-1a: judge_unreachable is a MICROVERSE_EXIT_REASONS union member, so it
  // routes to the finalize-gate (degraded, not aborted) — no union member reaches the abort floor.
  assert.deepEqual(classifyMicroverseHaltDecision('judge_unreachable'), {
    action: 'run-finalize-gate-incomplete',
    recognizedExitReason: 'judge_unreachable',
  });
  assert.deepEqual(classifyMicroverseHaltDecision('not-a-real-exit'), {
    action: 'abort',
    recognizedExitReason: null,
  });
});

test('szechuan-sauce exits judge_unreachable — pipeline runs finalize-gate and degrades, does not abort', async () => {
  const { repo, sessionDir } = makeSession(['szechuan-sauce']);
  const spawnCalls = [];
  __setSpawnRunnerForTests(makeJudgeSpawnAck(sessionDir, spawnCalls, 'judge_unreachable'));
  try {
    // B-ONEABORT AC-OA-1a/AC-OA-1c: judge_unreachable is a union member, not the crash floor — the
    // phase runs finalize-gate rather than aborting, but the run stays degraded (nonConvergent++),
    // so the pipeline still exits 1 to withhold the success verdict (never a bare abort).
    await expectMainExit(sessionDir, 1);
    assert.ok(spawnCalls.length >= 1, 'microverse-runner must have been spawned (setup must not have skipped the phase)');
    const finalizeGateCalls = spawnCalls.filter(c => c.args.some(a => String(a).includes('finalize-gate.js')));
    assert.equal(finalizeGateCalls.length, 1, 'finalize-gate.js must be spawned exactly once when microverse exits with judge_unreachable');
    const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.match(runnerLog, /judge_unreachable/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('anatomy-park exits judge_unreachable — pipeline runs finalize-gate and degrades, does not abort', async () => {
  const { repo, sessionDir } = makeSession(['anatomy-park']);
  const spawnCalls = [];
  __setSpawnRunnerForTests(makeJudgeSpawnAck(sessionDir, spawnCalls, 'judge_unreachable'));
  try {
    // B-ONEABORT AC-OA-1a/AC-OA-1c: judge_unreachable is a union member, not the crash floor — the
    // phase runs finalize-gate rather than aborting, but the run stays degraded (nonConvergent++),
    // so the pipeline still exits 1 to withhold the success verdict (never a bare abort).
    await expectMainExit(sessionDir, 1);
    assert.ok(spawnCalls.length >= 1, 'microverse-runner must have been spawned (setup must not have skipped the phase)');
    const finalizeGateCalls = spawnCalls.filter(c => c.args.some(a => String(a).includes('finalize-gate.js')));
    assert.equal(finalizeGateCalls.length, 1, 'finalize-gate.js must be spawned exactly once when microverse exits with judge_unreachable');
    const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.match(runnerLog, /judge_unreachable/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('anatomy-park judge_timeout runs finalize-gate instead of halting pipeline', async () => {
  const { repo, sessionDir } = makeSession(['anatomy-park']);
  const spawnCalls = [];
  __setSpawnRunnerForTests(makeJudgeSpawnAck(sessionDir, spawnCalls, 'judge_timeout'));
  try {
    await expectMainExit(sessionDir, 0);
    const finalizeGateCalls = spawnCalls.filter((call) => call.args.some((arg) => String(arg).includes('finalize-gate.js')));
    assert.equal(finalizeGateCalls.length, 1, 'finalize-gate.js must be spawned exactly once for anatomy-park judge_timeout');
    assert.ok(finalizeGateCalls[0].args.includes('anatomy-park'));
    const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.match(runnerLog, /running finalize-gate anyway/);
    assert.match(runnerLog, /finalize-gate passed after judge_timeout recovery/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

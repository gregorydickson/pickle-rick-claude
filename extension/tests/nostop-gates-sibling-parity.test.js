// @tier: fast
/**
 * B-NOSTOP-GATES — sibling parity between the two recovery-gate
 * `PhaseIterationOutcome` producers (`runJudgeTimeoutFinalizeGate`,
 * `runAllBackendsExhaustedFinalizeGate`). Both spawn `finalize-gate.js`
 * and branch on `gateResult.exitCode === 0` — a passing gate must always
 * `continue`, never `break`. Only the failing branch (non-zero exit)
 * legitimately breaks the pipeline; this ticket does not change that.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  __setSpawnRunnerForTests,
  runJudgeTimeoutFinalizeGate,
  runAllBackendsExhaustedFinalizeGate,
} from '../bin/pipeline-runner.js';

const TMP_DIRS = new Set();

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_DIRS.add(dir);
  return dir;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function makeRepo() {
  const repo = tmpDir('sibling-parity-repo-');
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test User'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.writeFileSync(path.join(repo, 'seed.ts'), 'export const x = 1;\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'seed'], repo);
  const startCommit = git(['rev-parse', 'HEAD'], repo);
  return { repo, startCommit };
}

function writeState(sessionDir, overrides = {}) {
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    active: false,
    step: 'anatomy-park',
    iteration: 0,
    max_iterations: 100,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 'nostop-gates sibling parity test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 3,
    backend: 'claude',
    ...overrides,
  }, null, 2));
  return statePath;
}

/** Build a minimal PipelineRuntime object the way production code does. */
function makeRuntime({ startCommit, repo } = {}) {
  const sessionDir = tmpDir('sibling-parity-session-');
  const statePath = writeState(sessionDir, {
    working_dir: repo,
    start_commit: startCommit,
  });
  return {
    sessionDir,
    extensionRoot: process.cwd(),
    statePath,
    config: {
      phases: ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce'],
      target: repo,
      anatomy_stall_limit: 3,
      szechuan_stall_limit: 5,
      anatomy_max_iterations: 100,
      szechuan_max_iterations: 50,
      citadel_strict: false,
      dirty_exempt_segments: ['prds', 'docs'],
    },
    target: repo,
    workingDir: repo,
    repoRoot: repo,
    backend: 'claude',
    phaseEnv: {},
    log: () => {},
  };
}

function freshCounters() {
  return { completed: 0, skipped: 0, phaseSkips: {}, nonConvergent: 0, phaseDispositions: {} };
}

function stubGateExit(exitCode) {
  __setSpawnRunnerForTests(async () => ({ exitCode, stdout: '', stderr: '' }));
}

afterEach(() => {
  __setSpawnRunnerForTests(null);
  for (const dir of TMP_DIRS) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  TMP_DIRS.clear();
});

describe('runAllBackendsExhaustedFinalizeGate', () => {
  test('passing gate (exitCode 0) continues and increments counters.completed', async () => {
    const { repo, startCommit } = makeRepo();
    const runtime = makeRuntime({ repo, startCommit });
    const counters = freshCounters();
    stubGateExit(0);

    const outcome = await runAllBackendsExhaustedFinalizeGate(runtime, counters, 'anatomy-park', () => {});

    assert.equal(outcome.action, 'continue');
    assert.equal(outcome.phaseIncomplete, undefined);
    assert.equal(counters.completed, 1);
  });

  test('failing gate (exitCode 1) still breaks', async () => {
    const { repo, startCommit } = makeRepo();
    const runtime = makeRuntime({ repo, startCommit });
    const counters = freshCounters();
    stubGateExit(1);

    const outcome = await runAllBackendsExhaustedFinalizeGate(runtime, counters, 'anatomy-park', () => {});

    assert.equal(outcome.action, 'break');
    assert.equal(counters.completed, 0);
  });
});

describe('sibling parity — runJudgeTimeoutFinalizeGate vs runAllBackendsExhaustedFinalizeGate', () => {
  test('both siblings return the same action on a passing gate', async () => {
    const { repo, startCommit } = makeRepo();

    const judgeRuntime = makeRuntime({ repo, startCommit });
    const judgeCounters = freshCounters();
    stubGateExit(0);
    const judgeOutcome = await runJudgeTimeoutFinalizeGate(judgeRuntime, judgeCounters, 'szechuan-sauce', () => {});

    const allBackendsRuntime = makeRuntime({ repo, startCommit });
    const allBackendsCounters = freshCounters();
    stubGateExit(0);
    const allBackendsOutcome = await runAllBackendsExhaustedFinalizeGate(
      allBackendsRuntime, allBackendsCounters, 'szechuan-sauce', () => {},
    );

    assert.equal(judgeOutcome.action, 'continue');
    assert.equal(allBackendsOutcome.action, judgeOutcome.action);
    assert.equal(judgeCounters.completed, 1);
    assert.equal(allBackendsCounters.completed, 1);
  });
});

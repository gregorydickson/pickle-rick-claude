// @tier: fast
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  __setSpawnRunnerForTests,
  applyStrictPhasesOverride,
  buildCloserReleasePlan,
  executeCloserReleasePlan,
  isFatalPhaseFailure,
  logPhaseContinueReason,
  main,
  recordRecoverablePhaseFailure,
  shouldHaltAfterPhase,
} from '../bin/pipeline-runner.js';
import { MICROVERSE_FATAL_REASONS } from '../types/index.js';

const TMP_DIRS = new Set();

class ExitIntercept extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_DIRS.add(dir);
  return dir;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function makeRepo({ createFollowupCommit = false } = {}) {
  const repo = tmpDir('pipeline-phase-repo-');
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test User'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  // discoverSubsystems enumerates directories with source files; seed under services/
  // so anatomy-park / szechuan-sauce phases find a real subsystem rather than skipping.
  // createFollowupCommit defends against a second, later skip: empty_branch_diff
  // (shouldSkipPhaseForEmptyBranchDiff) — a caller that forgets the flag gets
  // startCommit === HEAD, the phase's branch diff reads empty, and it never runs.
  fs.mkdirSync(path.join(repo, 'services'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'services', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'services', 'b.ts'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(repo, 'services', 'c.ts'), 'export const c = 3;\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'seed'], repo);
  const startCommit = git(['rev-parse', 'HEAD'], repo);
  if (createFollowupCommit) {
    fs.writeFileSync(path.join(repo, 'services', 'a.ts'), 'export const a = 11;\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'followup'], repo);
  }
  return { repo, startCommit };
}

function writeState(sessionDir, repo, overrides = {}) {
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    active: false,
    working_dir: repo,
    step: 'implement',
    iteration: 0,
    max_iterations: 100,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 'phase halt test',
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

function writePipeline(sessionDir, repo, overrides = {}) {
  const pipelinePath = path.join(sessionDir, 'pipeline.json');
  fs.writeFileSync(pipelinePath, JSON.stringify({
    phases: ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce'],
    target: repo,
    anatomy_stall_limit: 3,
    szechuan_stall_limit: 5,
    anatomy_max_iterations: 100,
    szechuan_max_iterations: 50,
    citadel_strict: false,
    dirty_exempt_segments: ['prds', 'docs'],
    ...overrides,
  }, null, 2));
  return pipelinePath;
}

function makeRuntime({
  createFollowupCommit = false,
  stateOverrides = {},
  configOverrides = {},
} = {}) {
  const sessionDir = tmpDir('pipeline-phase-session-');
  const { repo, startCommit } = makeRepo({ createFollowupCommit });
  const statePath = writeState(sessionDir, repo, {
    start_commit: startCommit,
    ...stateOverrides,
  });
  return {
    runtime: {
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
        ...configOverrides,
      },
      target: repo,
      workingDir: repo,
      repoRoot: repo,
      backend: 'claude',
      phaseEnv: {},
      log: () => {},
    },
    sessionDir,
  };
}

function makePipelineSession({
  createFollowupCommit = false,
  stateOverrides = {},
  pipelineOverrides = {},
} = {}) {
  const sessionDir = tmpDir('pipeline-phase-main-session-');
  const { repo, startCommit } = makeRepo({ createFollowupCommit });
  const statePath = writeState(sessionDir, repo, {
    start_commit: startCommit,
    tmux_mode: true,
    chain_meeseeks: false,
    pipeline_continue_on_phase_fail: true,
    ...stateOverrides,
  });
  writePipeline(sessionDir, repo, pipelineOverrides);
  return { repo, sessionDir, statePath };
}

async function expectMainExit(sessionDir, code, opts = {}) {
  const originalExit = process.exit;
  const originalTmux = process.env.TMUX;
  delete process.env.TMUX;
  process.exit = ((actualCode) => {
    throw new ExitIntercept(actualCode ?? 0);
  });
  try {
    await assert.rejects(
      () => main(sessionDir, opts),
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
  for (const dir of TMP_DIRS) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  TMP_DIRS.clear();
});

describe('shouldHaltAfterPhase', () => {
  test('shouldHaltAfterPhase pickle continue when commits exist after start_commit', () => {
    const { runtime } = makeRuntime({ createFollowupCommit: true });

    assert.equal(isFatalPhaseFailure('pickle', runtime), false);
    assert.equal(shouldHaltAfterPhase('pickle', 1, runtime), false);
  });

  // B-NOSTOP-GATES WS-1: zero commits since baseline is a QUALITY signal (reported
  // via maybeStampPhaseGraduation's phase_no_progress branch, which now advances
  // instead of halting), not a crash-floor cannot-continue condition.
  // OLD (pre-WS-1): isFatalPhaseFailure/shouldHaltAfterPhase both returned true —
  // zero commits hard-halted the pipeline before the honest-report-and-advance path
  // ever ran.
  // NEW (WS-1): both return false — the `!startCommit` arm (:2805) is the only
  // remaining fatal condition for pickle; zero commits with a startCommit present
  // falls through to the non-fatal, continue-by-default path (R-PHC-6).
  test('shouldHaltAfterPhase pickle does not halt when zero commits exist after start_commit', () => {
    const { runtime } = makeRuntime();

    assert.equal(isFatalPhaseFailure('pickle', runtime), false);
    assert.equal(shouldHaltAfterPhase('pickle', 1, runtime), false);
  });

  test('shouldHaltAfterPhase anatomy fatal when exit_reason is judge_cli_missing', () => {
    const { runtime } = makeRuntime({
      stateOverrides: { exit_reason: 'judge_cli_missing' },
    });

    assert.ok(MICROVERSE_FATAL_REASONS.includes('judge_cli_missing'));
    assert.equal(isFatalPhaseFailure('anatomy-park', runtime), true);
    assert.equal(shouldHaltAfterPhase('anatomy-park', 1, runtime), true);
  });
});

test('strict-phases cli override persists state.pipeline_continue_on_phase_fail=false', () => {
  const { repo } = makeRepo();
  const sessionDir = tmpDir('pipeline-phase-session-');
  const statePath = writeState(sessionDir, repo, {
    schema_version: 3,
    pipeline_continue_on_phase_fail: true,
  });

  const changed = applyStrictPhasesOverride(statePath, true);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

  assert.equal(changed, true);
  assert.equal(state.pipeline_continue_on_phase_fail, false);
});

test('strict-phases cli override is a no-op when strict mode is not requested', () => {
  const { repo } = makeRepo();
  const sessionDir = tmpDir('pipeline-phase-session-');
  const statePath = writeState(sessionDir, repo, {
    schema_version: 3,
    pipeline_continue_on_phase_fail: true,
  });

  const changed = applyStrictPhasesOverride(statePath, false);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

  assert.equal(changed, false);
  assert.equal(state.pipeline_continue_on_phase_fail, true);
});

test('anatomy-park judge_timeout runs finalize-gate instead of halting pipeline', async () => {
  const { repo, sessionDir } = makePipelineSession({
    createFollowupCommit: true,
    pipelineOverrides: { phases: ['anatomy-park'] },
  });
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

  await expectMainExit(sessionDir, 0);

  const finalizeGateCalls = spawnCalls.filter((call) => call.args.some((arg) => String(arg).includes('finalize-gate.js')));
  assert.equal(finalizeGateCalls.length, 1);
  assert.ok(finalizeGateCalls[0].args.includes('anatomy-park'));
  const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
  assert.match(runnerLog, /running finalize-gate anyway/);
  assert.match(runnerLog, /finalize-gate passed after judge_timeout recovery/);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('persisted pipeline_continue_on_phase_fail=false halts on non-zero pickle exit even when commits exist', async () => {
  const { repo, sessionDir, statePath } = makePipelineSession({
    createFollowupCommit: true,
    stateOverrides: { pipeline_continue_on_phase_fail: false },
    pipelineOverrides: { phases: ['pickle', 'citadel'] },
  });

  __setSpawnRunnerForTests(async () => ({ exitCode: 1, stdout: '', stderr: '' }));

  await expectMainExit(sessionDir, 1);

  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  const events = Array.isArray(state.activity)
    ? state.activity.filter((entry) => entry.event === 'recoverable_phase_failure')
    : [];
  assert.equal(events.length, 0);
  const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
  assert.doesNotMatch(runnerLog, /continuing to citadel for automated remediation/);
  assert.match(runnerLog, /Phase pickle failed \(exit 1\) — stopping pipeline/);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('--strict-phases halts at runtime and persists pipeline_continue_on_phase_fail=false', async () => {
  const { repo, sessionDir, statePath } = makePipelineSession({
    createFollowupCommit: true,
    pipelineOverrides: { phases: ['pickle', 'citadel'] },
  });

  __setSpawnRunnerForTests(async () => ({ exitCode: 1, stdout: '', stderr: '' }));

  await expectMainExit(sessionDir, 1, { strictPhases: true });

  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  assert.equal(state.pipeline_continue_on_phase_fail, false);
  const events = Array.isArray(state.activity)
    ? state.activity.filter((entry) => entry.event === 'recoverable_phase_failure')
    : [];
  assert.equal(events.length, 0);
  const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
  assert.match(runnerLog, /strict phase policy enabled via --strict-phases/);
  assert.match(runnerLog, /Phase pickle failed \(exit 1\) — stopping pipeline/);
  assert.doesNotMatch(runnerLog, /continuing to citadel for automated remediation/);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('recoverable_phase_failure emitted on every non-fatal exit during simulated 4-phase pipeline', () => {
  const { runtime } = makeRuntime({ createFollowupCommit: true });
  const phases = runtime.config.phases;

  recordRecoverablePhaseFailure(runtime, 'pickle', 1, phases.indexOf('pickle'), 'continue');
  fs.writeFileSync(runtime.statePath, JSON.stringify({
    ...JSON.parse(fs.readFileSync(runtime.statePath, 'utf-8')),
    exit_reason: 'judge_timeout',
  }, null, 2));
  recordRecoverablePhaseFailure(runtime, 'anatomy-park', 1, phases.indexOf('anatomy-park'), 'continue');
  fs.writeFileSync(runtime.statePath, JSON.stringify({
    ...JSON.parse(fs.readFileSync(runtime.statePath, 'utf-8')),
    exit_reason: 'error',
  }, null, 2));
  recordRecoverablePhaseFailure(runtime, 'szechuan-sauce', 1, phases.indexOf('szechuan-sauce'), 'continue');

  const state = JSON.parse(fs.readFileSync(runtime.statePath, 'utf-8'));
  const events = state.activity.filter((entry) => entry.event === 'recoverable_phase_failure');

  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((entry) => entry.phase),
    ['pickle', 'anatomy-park', 'szechuan-sauce'],
  );
  assert.deepEqual(events[0].downstream_phases_remaining, ['citadel', 'anatomy-park', 'szechuan-sauce']);
  assert.deepEqual(events[1].downstream_phases_remaining, ['szechuan-sauce']);
  assert.deepEqual(events[2].downstream_phases_remaining, []);
  assert.equal(events[0].reason, 'non-fatal pickle exit, commits present');
  assert.equal(events[0].fatal, false);
  assert.equal(events[0].decision, 'continue');
});

test('continue path logs next remediation phase for pickle to citadel', () => {
  const logs = [];
  const { runtime } = makeRuntime({ createFollowupCommit: true });
  runtime.log = (msg) => logs.push(msg);

  logPhaseContinueReason(runtime, 'pickle', 1);

  assert.match(
    logs.join('\n'),
    /Phase pickle exited with code 1 \(non-fatal\) — continuing to citadel for automated remediation/,
  );
});

test('continue path logs no remaining phases for last phase', () => {
  const logs = [];
  const { runtime } = makeRuntime();
  runtime.log = (msg) => logs.push(msg);

  logPhaseContinueReason(runtime, 'szechuan-sauce', 1);

  assert.match(logs.join('\n'), /no remaining phases/);
});

test('closer skip install and tag when prior phase non-zero recoverable failure exists', () => {
  const plan = buildCloserReleasePlan({
    activity: [
      {
        event: 'recoverable_phase_failure',
        phase: 'pickle',
        exit_code: 1,
      },
    ],
  });
  let installCalled = false;
  let tagCalled = false;

  executeCloserReleasePlan(plan, {
    install: () => { installCalled = true; },
    tag: () => { tagCalled = true; },
  }, () => {});

  assert.equal(plan.release, false);
  assert.equal(installCalled, false);
  assert.equal(tagCalled, false);
});

test('closer log skip install message when prior phase non-zero recoverable failure exists', () => {
  const logs = [];
  const plan = buildCloserReleasePlan({
    activity: [
      {
        event: 'recoverable_phase_failure',
        phase: 'anatomy-park',
        exit_code: 2,
      },
    ],
  });

  executeCloserReleasePlan(plan, {
    install: () => {},
    tag: () => {},
  }, (msg) => logs.push(msg));

  assert.match(
    logs.join('\n'),
    /Closer: prior phase non-zero exit detected — skipping install and tag/,
  );
});

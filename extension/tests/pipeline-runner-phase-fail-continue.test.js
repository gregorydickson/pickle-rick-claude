// @tier: fast
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  __setSpawnRunnerForTests,
  applyStrictPhasesOverride,
  buildCloserReleasePlan,
  computePipelineVerdict,
  executeCloserReleasePlan,
  finalizePhaseSuccess,
  isFatalPhaseFailure,
  logPhaseContinueReason,
  main,
  recordRecoverablePhaseFailure,
  runAnatomyLanes,
  shouldHaltAfterPhase,
  writeSkippedByScope,
} from '../bin/pipeline-runner.js';
import { MICROVERSE_FATAL_REASONS } from '../types/index.js';
import { StateManager } from '../services/state-manager.js';

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

test('makeRepo createFollowupCommit: startCommit precedes the follow-up commit', () => {
  const { repo, startCommit } = makeRepo({ createFollowupCommit: true });
  const head = git(['rev-parse', 'HEAD'], repo);
  assert.notEqual(startCommit, head);
  fs.rmSync(repo, { recursive: true, force: true });
});

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

  // Deliberate pin inversion (ticket 2ecd5464, B-ONEABORT residual): `judge_cli_missing` is a
  // measurement-tooling absence, not a state-integrity floor — B-NOSTOP-GATES requires it to
  // park-and-report, not halt. It is demoted out of MICROVERSE_FATAL_REASONS, whose only remaining
  // member is `session_state_corrupted`. This is the intended outcome, not a weakened test: the
  // membership assertion below now asserts ABSENCE where it used to assert presence.
  //
  // `isFatalPhaseFailure`/`shouldHaltAfterPhase` still return `true` here and that is UNCHANGED —
  // `isFatalPhaseFailure`'s anatomy-park branch reads `judge_cli_missing`'s `failure` disposition
  // off `MICROVERSE_DISPOSITIONS` and independently routes the halt-dispatch path. That path then
  // consults `classifyMicroverseHaltDecision`, which — because `judge_cli_missing` is a
  // `MICROVERSE_EXIT_REASONS` union member — resolves to `run-finalize-gate-incomplete`: the
  // pipeline runs finalize-gate and, on pass, continues to the next phase with success withheld
  // (see `oneabort-termination-invariant.test.js`'s `AC-2ecd5464` block for the four-property proof).
  test('shouldHaltAfterPhase anatomy fatal when exit_reason is judge_cli_missing', () => {
    const { runtime } = makeRuntime({
      stateOverrides: { exit_reason: 'judge_cli_missing' },
    });

    assert.ok(!MICROVERSE_FATAL_REASONS.includes('judge_cli_missing'));
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

// ---------------------------------------------------------------------------
// B-RELVERD ROOT V2 (GitHub #15): a microverse phase exits all_judge_backends_exhausted and its
// fallback finalize gate ALSO fails. That is a measurement failure, not the crash floor, so the
// run must reach the NEXT phase — asserted on the phase index reached, never the exit code.
// ---------------------------------------------------------------------------

function stubFailedFinalizeGate(sessionDir) {
  const spawnCalls = [];
  __setSpawnRunnerForTests(async (cmd, args) => {
    spawnCalls.push([...args]);
    const script = path.basename(String(args[0]));
    if (script === 'microverse-runner.js') {
      const statePath = path.join(sessionDir, 'state.json');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      state.exit_reason = 'all_judge_backends_exhausted';
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      return { exitCode: 1, stdout: '', stderr: '' };
    }
    return { exitCode: script === 'finalize-gate.js' ? 1 : 0, stdout: '', stderr: '' };
  });
  return spawnCalls;
}

function finalizeGateSkills(spawnCalls) {
  return spawnCalls
    .filter((args) => path.basename(String(args[0])) === 'finalize-gate.js')
    .map((args) => args[2]);
}

test('V2-2: a failed all-backends-exhausted finalize gate continues to the next phase', async () => {
  const { repo, sessionDir } = makePipelineSession({
    createFollowupCommit: true,
    pipelineOverrides: { phases: ['anatomy-park', 'szechuan-sauce'] },
  });
  const spawnCalls = stubFailedFinalizeGate(sessionDir);

  await expectMainExit(sessionDir, 1);

  const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
  assert.match(runnerLog, /PHASE 2\/2: SZECHUAN-SAUCE/, 'the run must reach phase index 2');
  assert.deepEqual(finalizeGateSkills(spawnCalls), ['anatomy-park', 'szechuan']);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('V2-3: --strict-phases still stops on a failed all-backends-exhausted finalize gate', async () => {
  const { repo, sessionDir } = makePipelineSession({
    createFollowupCommit: true,
    pipelineOverrides: { phases: ['anatomy-park', 'szechuan-sauce'] },
  });
  const spawnCalls = stubFailedFinalizeGate(sessionDir);

  await expectMainExit(sessionDir, 1, { strictPhases: true });

  const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
  assert.doesNotMatch(runnerLog, /PHASE 2\/2: SZECHUAN-SAUCE/, 'strict mode must not reach phase index 2');
  assert.deepEqual(finalizeGateSkills(spawnCalls), ['anatomy-park']);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('V2-4: continuing past a failed finalize gate still reports failed and names the phase', async () => {
  const { repo, sessionDir } = makePipelineSession({
    createFollowupCommit: true,
    pipelineOverrides: { phases: ['anatomy-park', 'szechuan-sauce'] },
  });
  stubFailedFinalizeGate(sessionDir);

  await expectMainExit(sessionDir, 1);

  const status = JSON.parse(fs.readFileSync(path.join(sessionDir, 'pipeline-status.json'), 'utf-8'));
  assert.equal(status.status, 'failed', 'continuing is not claiming success');
  assert.equal(status.completed_phases, 0);
  assert.match(status.phase_dispositions?.['anatomy-park'] ?? '', /^finalize_gate_failed:all_judge_backends_exhausted$/);
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

// ---------------------------------------------------------------------------
// AP-EXT-ITER83-01: the anatomy-park missing-key-metric downgrade is a
// continue-past-nonzero like every other one in the phase loop, and must leave
// the SAME evidence behind.
//
// Pre-fix, `shouldSkipAnatomyPhaseWithWarning`'s branch returned
// `{action:'continue'}` before `recordRecoverablePhaseFailure` — the sole writer
// of `recoverable_phase_failure`. `buildCloserReleasePlan` withholds install+tag
// on exactly that event, so a CRASHED anatomy-park phase (exit 1,
// exit_reason='fatal') produced `{release:true,install:true,tag:true}` and the
// `Closer: prior phase non-zero exit detected` refusal line was never logged —
// the one signal an operator reads as "the closer refused the tag"
// (prds/MASTER_PLAN.md:2172 records that exact reading).
//
// Both cases drive the REAL loop through `main`, then read the resulting
// state.json through the shipped `buildCloserReleasePlan` rather than a fixture.
// ---------------------------------------------------------------------------

function driveAnatomyMissingKeyMetricCrash() {
  const { repo, sessionDir, statePath } = makePipelineSession({
    createFollowupCommit: true,
    pipelineOverrides: { phases: ['anatomy-park'] },
  });
  let callCount = 0;
  __setSpawnRunnerForTests(async () => {
    callCount++;
    if (callCount === 1) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      state.exit_reason = 'fatal';
      state.command_template = 'anatomy-park.md';
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      return {
        exitCode: 1,
        stdout: '',
        stderr: "TypeError: Cannot read properties of undefined (reading 'description')\n",
      };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  return { repo, sessionDir, statePath };
}

test('AP-EXT-ITER83-01: downgraded anatomy-park crash records recoverable_phase_failure and withholds closer release', async () => {
  const { repo, sessionDir, statePath } = driveAnatomyMissingKeyMetricCrash();

  // B-RELVERD V4: the crash is named `crash_downgraded`, which withholds success, so the
  // run exits Failure (1) — a crashed deep-review phase is not a successful run.
  await expectMainExit(sessionDir, 1);

  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  const events = (Array.isArray(state.activity) ? state.activity : [])
    .filter((entry) => entry.event === 'recoverable_phase_failure');
  assert.equal(events.length, 1, 'the downgraded crash must leave one recoverable_phase_failure');
  assert.equal(events[0].phase, 'anatomy-park');
  assert.equal(events[0].exit_code, 1);
  assert.equal(events[0].fatal, false);
  assert.equal(events[0].decision, 'continue');

  // The consequence the event exists for, read through the shipped builder.
  const plan = buildCloserReleasePlan(state);
  assert.equal(plan.release, false, 'a crashed anatomy-park phase must not clear install+tag');
  assert.equal(plan.install, false);
  assert.equal(plan.tag, false);

  // The withheld verdict now skips the closer outright, so the refusal line no longer reaches
  // pipeline-runner.log; the shipped executor still refuses this plan and says so.
  const closerLog = [];
  let installCalled = false;
  let tagCalled = false;
  executeCloserReleasePlan(plan, {
    install: () => { installCalled = true; },
    tag: () => { tagCalled = true; },
  }, (msg) => closerLog.push(msg));
  assert.equal(installCalled, false);
  assert.equal(tagCalled, false);
  assert.match(closerLog.join('\n'), /Closer: prior phase non-zero exit detected — skipping install and tag/);

  const status = JSON.parse(fs.readFileSync(path.join(sessionDir, 'pipeline-status.json'), 'utf-8'));
  assert.equal(status.status, 'failed', 'V4-1: the downgraded crash withholds the success verdict');
  assert.equal(status.phase_skips['anatomy-park'], 'crash_downgraded', 'V4-1: the disposition is named');
  fs.rmSync(repo, { recursive: true, force: true });
});

// Control: the downgrade still CONTINUES — B-RELVERD V4 moves the disposition (a named
// `crash_downgraded` skip that withholds success) but must never widen the branch into a
// halt. The run reaches finalize and reports failed; it does not stop mid-loop.
test('AP-EXT-ITER83-01 control: the missing-key-metric downgrade still continues to finalize, withholding success', async () => {
  const { repo, sessionDir } = driveAnatomyMissingKeyMetricCrash();

  await expectMainExit(sessionDir, 1);

  const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
  assert.match(runnerLog, /phase_skipped_with_warning/);
  assert.match(runnerLog, /anatomy_park_missing_key_metric/);
  assert.match(runnerLog, /Pipeline finished:/, 'V4-5: the run reached finalize, not a mid-loop stop');
  const status = JSON.parse(fs.readFileSync(path.join(sessionDir, 'pipeline-status.json'), 'utf-8'));
  assert.equal(status.status, 'failed');
  assert.equal(status.skipped_phases, 1);
  assert.equal(status.current_phase, null, 'the terminal status write ran');
  fs.rmSync(repo, { recursive: true, force: true });
});

// V4-3: the withhold keys on the NAME, not on "a skip happened". A benign empty-scope skip
// stays a successful skip; only `crash_downgraded` withholds.
test('B-RELVERD V4-3: an ordinary empty-scope skip still reports success; crash_downgraded withholds', () => {
  const { runtime } = makeRuntime({ configOverrides: { phases: ['anatomy-park'] } });
  const counters = (reason) => ({
    completed: 0,
    skipped: 1,
    phaseSkips: { 'anatomy-park': reason },
    nonConvergent: 0,
    phaseDispositions: {},
  });

  const benign = computePipelineVerdict(runtime, counters('empty_scope'));
  assert.equal(benign.pipelineFailed, false);
  assert.equal(benign.unsuccessful, false, 'an empty-scope skip is still a success');

  const crashed = computePipelineVerdict(runtime, counters('crash_downgraded'));
  assert.equal(crashed.pipelineFailed, false, 'the phase is accounted for — this is not a shortfall');
  assert.equal(crashed.unsuccessful, true);
  assert.equal(crashed.effectiveFailed, true);
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER211-02: `buildCloserReleasePlan` derives a RELEASE verdict from an
// ABSENCE in `state.activity` — and `state.activity` is a bounded drop-oldest
// ring (`state-manager.ts:ACTIVITY_RING_MAX` = 2000). `recoverable_phase_failure`
// is written EARLY in a run, so it sits in the evicted PREFIX. Pre-fix it was not
// in `isExemptActivityEvent`, so a long degraded run evicted its own degradation
// breadcrumb and the closer read "no prior non-zero exit" — returning
// `{release,install,tag}` all true and auto-tagging a release, which is exactly
// the success verdict CLAUDE.md's PRIME DIRECTIVE says a degraded run must
// withhold. The over-cap condition is not hypothetical: the cap exists because a
// real run reached 7021 entries (state-manager.ts, B-PDBL D1).
//
// This drives the REAL phase loop through `main` to produce the breadcrumb, then
// pushes the ring over the cap through the REAL `StateManager.update` write path
// (which is what invokes `trimActivityRing`), then reads the surviving state back
// through the shipped `buildCloserReleasePlan`. No fixture stands in for either
// end of the wire.
// ---------------------------------------------------------------------------

const RING_OVERFLOW_FILLER = 2500;

function floodActivityRing(statePath, count) {
  const sm = new StateManager();
  sm.update(statePath, (state) => {
    const activity = Array.isArray(state.activity) ? state.activity : [];
    const filler = Array.from({ length: count }, (_, i) => ({
      event: 'worker_backend_resolved',
      ts: new Date().toISOString(),
      seq: i,
    }));
    // Append AFTER the existing entries so the breadcrumb is the OLDEST — the
    // position drop-oldest eviction actually takes.
    state.activity = [...activity, ...filler];
  });
}

test('AP-EXT-ITER211-02: an over-cap activity ring must not evict the degradation breadcrumb into a clean closer release', async () => {
  const { repo, sessionDir, statePath } = driveAnatomyMissingKeyMetricCrash();

  // B-RELVERD V4: the downgraded crash withholds success (exit 1); the breadcrumb this case
  // pins is written before finalize either way.
  await expectMainExit(sessionDir, 1);

  const before = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  const beforeBreadcrumbs = before.activity.filter((e) => e.event === 'recoverable_phase_failure');
  assert.equal(beforeBreadcrumbs.length, 1, 'precondition: the crash left exactly one breadcrumb');
  assert.equal(
    before.activity.findIndex((e) => e.event === 'recoverable_phase_failure') <
      before.activity.length,
    true,
  );

  floodActivityRing(statePath, RING_OVERFLOW_FILLER);

  const after = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  // The ring really was trimmed — otherwise this test would pass without the cap
  // ever engaging, and would not be measuring eviction at all.
  assert.ok(
    after.activity.length < before.activity.length + RING_OVERFLOW_FILLER,
    `precondition: trimActivityRing must have engaged (len=${after.activity.length})`,
  );
  assert.equal(after.activity.length, 2000, 'the ring is capped at ACTIVITY_RING_MAX');

  const survivors = after.activity.filter((e) => e.event === 'recoverable_phase_failure');
  assert.equal(
    survivors.length,
    1,
    'the degradation breadcrumb must survive eviction — its absence INVERTS the closer verdict',
  );
  assert.equal(survivors[0].phase, 'anatomy-park');
  assert.equal(survivors[0].exit_code, 1);

  // The consequence the exemption exists for, read through the shipped builder.
  const plan = buildCloserReleasePlan(after);
  assert.equal(plan.release, false, 'a degraded run must still withhold release after eviction');
  assert.equal(plan.install, false, 'a degraded run must not auto-install after eviction');
  assert.equal(plan.tag, false, 'a degraded run must not auto-tag after eviction');
  assert.equal(plan.skipReason, 'prior phase non-zero exit detected');

  let installCalled = false;
  let tagCalled = false;
  executeCloserReleasePlan(plan, {
    install: () => { installCalled = true; },
    tag: () => { tagCalled = true; },
  }, () => {});
  assert.equal(installCalled, false);
  assert.equal(tagCalled, false);

  fs.rmSync(repo, { recursive: true, force: true });
});

// Control: the exemption must not make the ring unbounded, and must not preserve
// ordinary high-cardinality events. Without this, widening `isExemptActivityEvent`
// to a blanket `return true` would also satisfy the case above.
test('AP-EXT-ITER211-02 control: the exemption is narrow — non-exempt events are still evicted and the cap still holds', async () => {
  const { repo, statePath } = driveAnatomyMissingKeyMetricCrash();
  const sm = new StateManager();

  sm.update(statePath, (state) => {
    state.activity = [
      { event: 'recoverable_phase_failure', ts: new Date().toISOString(), phase: 'pickle', exit_code: 1 },
      ...Array.from({ length: 2500 }, (_, i) => ({
        event: 'worker_backend_resolved',
        ts: new Date().toISOString(),
        seq: i,
      })),
    ];
  });

  const after = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  assert.equal(after.activity.length, 2000, 'the cap still bounds the ring');
  assert.equal(
    after.activity.filter((e) => e.event === 'worker_backend_resolved').length,
    1999,
    'ordinary events are still evicted oldest-first — the exemption did not become blanket',
  );
  assert.equal(after.activity[0].event, 'recoverable_phase_failure');
  assert.equal(after.activity.filter((e) => e.event === 'recoverable_phase_failure').length, 1);

  fs.rmSync(repo, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER289-01: a phase SETUP persists several artifacts (`anatomy-park.json`,
// the phase `prd.md`, `judge-context.md`) and `phaseConfig.setup` was called BARE in
// `runConfiguredPhase` — no recovery frame anywhere between it and the CLI fatal
// handler. So any of those writes throwing ended the whole run with the phase and
// every phase AFTER it never run: the identical halt AP-EXT-ITER288-01/-02 closed at
// the citadel phase's own body, one call site over.
//
// Two INDEPENDENT causes, both root-independent (no file modes — a mode-based row is
// vacuous under uid 0):
//   (a) `<session>/anatomy-park.json` occupied by a DIRECTORY  -> writeStateFile's
//       renameSync raises EISDIR inside `writeAnatomyConfig`.
//   (b) `<session>/prd.md` a BROKEN SYMLINK                    -> the setup's own
//       prd.md write raises ENOENT. `existsSync` is false on a broken symlink, so
//       the load-time backend assert and `archiveFile` both skip it: this reaches
//       the SETUP, not the runtime load.
//
// Assert the PHASES REACHED and the on-disk disposition, never the return value:
// `runConfiguredPhase` reports `{skipped:true}` on every degraded path, so a
// return-value oracle greens over the halt.
// ---------------------------------------------------------------------------

// Drives the real `main()` over a two-phase pipeline, recording which phase runners
// were spawned. `breakSetup` corrupts one session artifact before the run.
function driveTwoPhaseRunWithBrokenSetup(breakSetup) {
  const { repo, sessionDir } = makePipelineSession({
    createFollowupCommit: true,
    pipelineOverrides: {
      phases: ['anatomy-park', 'szechuan-sauce'],
      anatomy_max_iterations: 1,
      szechuan_max_iterations: 1,
    },
  });
  if (breakSetup) breakSetup(sessionDir);
  const runnersSpawned = [];
  __setSpawnRunnerForTests(async (_cmd, args) => {
    runnersSpawned.push(path.basename(String(args?.[0] ?? '')));
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  return { repo, sessionDir, runnersSpawned };
}

function readStatus(sessionDir) {
  return JSON.parse(fs.readFileSync(path.join(sessionDir, 'pipeline-status.json'), 'utf-8'));
}

test('AP-EXT-ITER289-01: an unwritable anatomy-park.json skips that phase — the NEXT phase still runs', async () => {
  const { repo, sessionDir, runnersSpawned } = driveTwoPhaseRunWithBrokenSetup((dir) => {
    fs.mkdirSync(path.join(dir, 'anatomy-park.json'), { recursive: true });
  });

  // Exit 1 because the degrade WITHHOLDS success — the run still reached finalize.
  await expectMainExit(sessionDir, 1);

  assert.deepEqual(
    runnersSpawned,
    ['microverse-runner.js'],
    'the phase AFTER the failed setup still ran — pre-fix this was 0 runners',
  );
  const status = readStatus(sessionDir);
  assert.equal(status.phase_skips['anatomy-park'], 'setup_error', 'the degrade is named, not silent');
  assert.equal(status.status, 'failed', 'continuing is not claiming success');
  assert.equal(status.current_phase, null, 'the terminal status write ran — the loop reached finalize');
  const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
  assert.match(runnerLog, /anatomy-park: setup failed: .*EISDIR/, 'the cause is reported');
  assert.match(runnerLog, /Pipeline finished:/, 'the run reached finalize, not a mid-loop fatal');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('AP-EXT-ITER289-01: a second independent cause — an unwritable session prd.md — degrades the same way', async () => {
  const { repo, sessionDir, runnersSpawned } = driveTwoPhaseRunWithBrokenSetup((dir) => {
    fs.symlinkSync('/nonexistent-ap-ext-iter289-01/x', path.join(dir, 'prd.md'));
  });

  await expectMainExit(sessionDir, 1);

  assert.deepEqual(runnersSpawned, [], 'both setups failed — but on their own, not by ending the run');
  const status = readStatus(sessionDir);
  assert.equal(status.phase_skips['anatomy-park'], 'setup_error');
  assert.equal(status.phase_skips['szechuan-sauce'], 'setup_error', 'the loop reached the second phase');
  assert.equal(status.status, 'failed');
  assert.equal(status.skipped_phases, 2);
  const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
  assert.match(runnerLog, /szechuan-sauce: setup failed: .*ENOENT/);
  assert.match(runnerLog, /Pipeline finished:/);
  fs.rmSync(repo, { recursive: true, force: true });
});

// Over-trigger control: the frame must not turn a HEALTHY setup into a skip. Without
// this, degrading unconditionally would satisfy both cases above.
test('AP-EXT-ITER289-01 control: a healthy setup still runs both phases and reports success', async () => {
  const { repo, sessionDir, runnersSpawned } = driveTwoPhaseRunWithBrokenSetup(null);

  await expectMainExit(sessionDir, 0);

  assert.deepEqual(runnersSpawned, ['microverse-runner.js', 'microverse-runner.js']);
  const status = readStatus(sessionDir);
  assert.deepEqual(status.phase_skips ?? {}, {}, 'no phase was skipped');
  assert.equal(status.status, 'completed');
  assert.equal(status.completed_phases, 2);
  fs.rmSync(repo, { recursive: true, force: true });
});

// The REPORTING half. Continuing past a failed setup must not report the run as
// successful — `setup_error` joins `crash_downgraded` in the ONE named set of
// DEGRADED skip reasons, while the "nothing to do" skips stay benign.
test('AP-EXT-ITER289-01: a setup_error skip withholds success; a no-work skip does not', () => {
  const { runtime } = makeRuntime({ configOverrides: { phases: ['anatomy-park'] } });
  const counters = (reason) => ({
    completed: 0,
    skipped: 1,
    phaseSkips: { 'anatomy-park': reason },
    nonConvergent: 0,
    phaseDispositions: {},
  });

  for (const benignReason of ['empty_scope', 'empty_branch_diff', 'no_subsystems']) {
    const benign = computePipelineVerdict(runtime, counters(benignReason));
    assert.equal(benign.unsuccessful, false, `${benignReason} is a phase with no work, not a degradation`);
  }

  for (const degradedReason of ['setup_error', 'crash_downgraded']) {
    const degraded = computePipelineVerdict(runtime, counters(degradedReason));
    assert.equal(degraded.pipelineFailed, false, `${degradedReason}: the phase is accounted for`);
    assert.equal(degraded.unsuccessful, true, `${degradedReason} withholds the success verdict`);
    assert.equal(degraded.effectiveFailed, true);
  }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER290-01 — a "Pure audit file" write ended the whole pipeline.
//
// `writeSkippedByScope` writes `archive/skipped_by_scope.<phase>.json`, and its own
// docblock calls it a pure audit file. But its throw was rethrown by
// `refreshPhaseScope` (only SCOPE_EMPTY_POST_BUILD is special-cased there, and that
// path throws too), and nothing above it caught — `main` wraps the phase loop in
// `try`/`finally`, NOT `try`/`catch`. So an observability write ended the run with
// the phase and every phase AFTER it never run: the same halt AP-EXT-ITER288-01/-02
// and AP-EXT-ITER289-01 closed, one call site over.
//
// Root-independent break (no file modes — a mode-based row is vacuous under uid 0):
// the artifact's own output path occupied by a DIRECTORY, giving EISDIR from the
// rename. It touches nothing but this writer's final step, so the throw cannot be
// attributed to a neighbouring write.
//
// The scope fixture uses mode:'paths', which `computeRefreshedAllowed` returns
// VERBATIM — no diff, no HEAD dependency — so it can never trip refreshScope's own
// SCOPE_EMPTY_POST_BUILD refusal, which is what blocks a branch-mode fixture from
// ever reaching this writer.
//
// Assert the PHASES REACHED and the on-disk disposition, never the return value.
// ---------------------------------------------------------------------------

function seedPathsModeScope(sessionDir) {
  fs.writeFileSync(path.join(sessionDir, 'scope.json'), JSON.stringify({
    version: 1,
    mode: 'paths',
    strategy: 'strict',
    base_ref: null,
    base_sha: null,
    head_sha: null,
    allowed_paths: ['services/a.ts'],
    resolved_at: new Date().toISOString(),
    refresh_history: [],
  }, null, 2));
}

async function runScopedPipeline(breakAudit) {
  const { repo, sessionDir, runnersSpawned } = driveTwoPhaseRunWithBrokenSetup((dir) => {
    seedPathsModeScope(dir);
    if (breakAudit) {
      fs.mkdirSync(path.join(dir, 'archive', 'skipped_by_scope.anatomy-park.json'), { recursive: true });
    }
  });
  // exit 0: an unwritable AUDIT file loses no work, so success is NOT withheld.
  await expectMainExit(sessionDir, 0);
  const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
  const status = readStatus(sessionDir);
  // szechuan-sauce refreshes scope too, so its audit artifact is the un-broken
  // half: it must still LAND. Without this, a writer degraded into a no-op would
  // satisfy every other assertion here.
  const auditWritten = fs.existsSync(path.join(sessionDir, 'archive', 'skipped_by_scope.szechuan-sauce.json'));
  fs.rmSync(repo, { recursive: true, force: true });
  return { runnersSpawned, status, runnerLog, auditWritten };
}

test('AP-EXT-ITER290-01: an unwritable skipped_by_scope audit file no longer ends the run', async () => {
  const { runnersSpawned, status, runnerLog } = await runScopedPipeline(true);

  // Pre-fix this was 0 runners: the EISDIR escaped main() and every phase after
  // the audit write never ran.
  assert.ok(runnersSpawned.length > 0, 'the pipeline still spawned its phase runners');
  assert.equal(status.status, 'completed', 'the run reached a terminal status');
  assert.notEqual(status.status, 'running', 'pre-fix pipeline-status.json was left saying running');
  assert.match(runnerLog, /Pipeline finished:/, 'the run reached finalize, not a mid-loop fatal');
  // Degrading must not be SILENT — the log line is the honest report.
  assert.match(
    runnerLog,
    /scope-audit: could not write skipped_by_scope\.anatomy-park\.json: .*EISDIR/,
    'the audit failure and its cause are reported',
  );
  assert.match(runnerLog, /observability only, phase unaffected/);
});

// Over-trigger control: the frame must not change what a HEALTHY run does, and the
// audit artifact must still actually be written. Without this, swallowing every
// write unconditionally — or never writing at all — would satisfy the case above.
test('AP-EXT-ITER290-01 control: a healthy audit write is unchanged and still lands', async () => {
  const broken = await runScopedPipeline(true);
  const healthy = await runScopedPipeline(false);

  assert.deepEqual(
    broken.runnersSpawned,
    healthy.runnersSpawned,
    'a failed audit write is invisible to the pipeline outcome — same phases run',
  );
  assert.equal(broken.status.status, healthy.status.status, 'same terminal status');
  assert.doesNotMatch(healthy.runnerLog, /scope-audit: could not write/, 'no warning on a healthy run');
  assert.equal(healthy.auditWritten, true, 'the audit artifact is still actually written');
  assert.equal(broken.auditWritten, true, 'breaking one phase audit file does not suppress the other');
});

test('AP-EXT-ITER290-01: writeSkippedByScope reports its failure through the caller-supplied log', () => {
  const sessionDir = tmpDir('ap-ext-iter290-audit-');
  fs.mkdirSync(path.join(sessionDir, 'archive', 'skipped_by_scope.szechuan-sauce.json'), { recursive: true });
  const scope = { head_sha: 'deadbeef', allowed_paths: ['services/a.ts'] };
  const lines = [];

  // The contract lives at the writer, not at its one production call site: a
  // second caller inherits the degrade instead of re-forking the guard.
  assert.doesNotThrow(() => {
    writeSkippedByScope(sessionDir, 'szechuan-sauce', scope, sessionDir, sessionDir, (m) => lines.push(m));
  });

  assert.equal(lines.length, 1, 'exactly one warning, not a silent swallow');
  assert.match(lines[0], /scope-audit: could not write skipped_by_scope\.szechuan-sauce\.json/);
  const leaked = fs.readdirSync(path.join(sessionDir, 'archive')).filter((f) => f.includes('.tmp.'));
  assert.deepEqual(leaked, [], 'the tmp file is cleaned up on the degrade path');
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER291-01: a failed seeded-scope write must not end the run at LOAD.
//
// The seeded-scope write lives in `setupScope`'s SCOPE_EMPTY_DIFF catch, reached from
// `loadPipelineRuntime` — which `main()` calls BEFORE entering its `try`/`finally`.
// Pre-fix the throw escaped `main()` entirely: 0 phase runners, `exit_reason` never
// stamped, and `pipeline-status.json` never created at all (the halt lands before
// `writeRunningStatus`, so unlike its AP-EXT-ITER289/290 siblings it leaves no artifact
// whatsoever for a monitor to read).
//
// Assert the PHASES REACHED and the on-disk disposition, never the return value.
// ---------------------------------------------------------------------------

function makeSeededScopeSession(breakScope) {
  // NO follow-up commit: an empty pre-build branch diff is what raises SCOPE_EMPTY_DIFF
  // and routes setup into the seeded-scope recovery this case exercises.
  const { repo, sessionDir } = makePipelineSession({
    stateOverrides: { current_ticket: 'seed-e2e' },
    pipelineOverrides: {
      phases: ['anatomy-park', 'szechuan-sauce'],
      scope: 'branch',
      scope_base: 'main',
      anatomy_max_iterations: 1,
      szechuan_max_iterations: 1,
    },
  });
  const ticketDir = path.join(sessionDir, 'seed-e2e');
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, 'rick_ticket_seed-e2e.md'), [
    '---', 'id: seed-e2e', 'title: Seed', 'status: In Progress', 'updated: "2026-09-19"', '---',
    '# Implementation Details',
    '**Files to modify/create**: `services/feature.ts`', '',
  ].join('\n'));
  if (breakScope) fs.mkdirSync(path.join(sessionDir, 'scope.json'), { recursive: true });
  const runnersSpawned = [];
  __setSpawnRunnerForTests(async (_cmd, args) => {
    runnersSpawned.push(path.basename(String(args?.[0] ?? '')));
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  return { repo, sessionDir, runnersSpawned };
}

test('AP-EXT-ITER291-01: an unwritable scope.json degrades the seed — the run still reaches the phase loop', async () => {
  const { repo, sessionDir } = makeSeededScopeSession(true);

  // Pre-fix this rejected with a raw EISDIR instead of an intercepted process.exit.
  await expectMainExit(sessionDir, 0);

  const statusPath = path.join(sessionDir, 'pipeline-status.json');
  assert.ok(fs.existsSync(statusPath), 'pipeline-status.json exists — pre-fix the halt landed before it was ever written');
  assert.equal(readStatus(sessionDir).current_phase, null, 'the terminal status write ran — the loop reached finalize');

  const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
  assert.match(runnerLog, /could not seed pickle-phase scope: .*EISDIR|could not seed pickle-phase scope — .*EISDIR/, 'the cause is reported, not swallowed');
  assert.match(runnerLog, /Pipeline finished:/, 'the run reached finalize, not a load-time fatal');
  fs.rmSync(repo, { recursive: true, force: true });
});

// The over-trigger control for this fix lives at the `setupScope` seam
// (tests/pipeline-scope-ticket-seed.test.js, `AP-EXT-ITER291-01 control`), not here.
// A healthy branch-mode seed cannot reach finalize in THIS harness: seeding requires an
// empty pre-build branch diff, and with no real build phase to produce one,
// `refreshPhaseScope` then raises the documented `SCOPE_EMPTY_POST_BUILD` refusal. That
// is pre-existing, deliberate behaviour (`throwOnEmptyScope`) and not this fix's to pin.
// The seam-level control asserts the healthy seed LANDS and logs no degrade, so
// degrading unconditionally still reds.

// ---------------------------------------------------------------------------
// B-LANES 13d/13g (b870ab5f): N lanes produce ONE verdict. Each lane runner stops on
// its own state, so a non-convergent lane is invisible to `finalizePhaseSuccess` —
// which reads only the PARENT exit_reason — unless the lane pool aggregates the lane
// reasons into that one field. `finalizePhaseSuccess` is unchanged; the aggregation
// write is what makes it see the lanes.
// ---------------------------------------------------------------------------

const LANE_VERDICT_NAMES = ['alpha', 'beta', 'gamma'];

function makeLaneVerdictRuntime() {
  const repo = fs.realpathSync(tmpDir('pipeline-lane-verdict-repo-'));
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test User'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  for (const name of LANE_VERDICT_NAMES) {
    fs.mkdirSync(path.join(repo, name));
    for (const f of ['a', 'b', 'c']) fs.writeFileSync(path.join(repo, name, `${f}.ts`), `export const ${f} = 1;\n`);
  }
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'seed'], repo);
  const sessionDir = fs.realpathSync(tmpDir('pipeline-lane-verdict-session-'));
  for (let n = 1; n <= LANE_VERDICT_NAMES.length; n++) TMP_DIRS.add(`${sessionDir}--lane-${n}`);
  // A live parent is claimed by its runner's pid; unclaimed it reads as a phantom and is demoted.
  const statePath = writeState(sessionDir, repo, { active: true, pid: process.pid, exit_reason: null });
  const { runtime } = makeRuntime();
  return {
    repo,
    runtime: {
      ...runtime, sessionDir, statePath, target: repo, workingDir: repo, repoRoot: repo, designSafe: false,
      // Lane setup resolves `<extensionRoot>/extension/bin/*.js`: the repo root, not extension/.
      extensionRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
    },
    lanes: LANE_VERDICT_NAMES.map((name) => ({ name, dir: name, excludes: [], testRatioApplies: false, fileCount: 3 })),
  };
}

/** Stub lane runner: stamps each lane's own exit_reason, as a microverse runner would. */
function stampLaneReasons(reasonFor) {
  return async (_cmd, args) => {
    const laneDir = args[1];
    const statePath = path.join(laneDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const n = Number(/--lane-(\d+)$/.exec(laneDir)[1]);
    fs.writeFileSync(statePath, JSON.stringify({ ...state, exit_reason: reasonFor(n), active: false }));
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

const freshCounters = () => ({ completed: 0, skipped: 0, phaseSkips: {}, nonConvergent: 0, phaseDispositions: {} });
const noCancelMarker = (runtime) => path.join(runtime.sessionDir, 'pipeline-cancel');

test('B-LANES 13d/13g: one non-convergent lane of three makes the phase non-convergent', async () => {
  const { runtime, lanes } = makeLaneVerdictRuntime();
  __setSpawnRunnerForTests(stampLaneReasons((n) => (n === 2 ? 'anatomy_non_convergent' : 'converged')));

  const exitCode = await runAnatomyLanes(runtime, lanes, 3);

  assert.equal(exitCode, 1, 'a non-convergent lane does not report a clean lane run');
  const parent = JSON.parse(fs.readFileSync(runtime.statePath, 'utf-8'));
  assert.equal(parent.exit_reason, 'anatomy_non_convergent', 'ONE parent verdict carries the lane that failed');
  const counters = freshCounters();
  finalizePhaseSuccess(runtime, counters, noCancelMarker(runtime), 'anatomy-park', exitCode, () => {});
  assert.equal(counters.nonConvergent, 1);
  assert.equal(counters.completed, 0);
  assert.equal(counters.phaseDispositions['anatomy-park'], 'anatomy_non_convergent');
});

test('B-LANES 13d/13g control: all lanes converged — the phase completes', async () => {
  const { runtime, lanes } = makeLaneVerdictRuntime();
  __setSpawnRunnerForTests(stampLaneReasons(() => 'converged'));

  const exitCode = await runAnatomyLanes(runtime, lanes, 3);

  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(fs.readFileSync(runtime.statePath, 'utf-8')).exit_reason, 'converged');
  const counters = freshCounters();
  finalizePhaseSuccess(runtime, counters, noCancelMarker(runtime), 'anatomy-park', exitCode, () => {});
  assert.equal(counters.completed, 1);
  assert.equal(counters.nonConvergent, 0);
});

test('B-LANES 13g falsifying control: without the aggregation write the same lanes read as completed', async () => {
  const { runtime, lanes } = makeLaneVerdictRuntime();
  __setSpawnRunnerForTests(stampLaneReasons((n) => (n === 2 ? 'anatomy_non_convergent' : 'converged')));
  await runAnatomyLanes(runtime, lanes, 3);
  const lane2 = JSON.parse(fs.readFileSync(path.join(`${runtime.sessionDir}--lane-2`, 'state.json'), 'utf-8'));
  assert.equal(lane2.exit_reason, 'anatomy_non_convergent', 'the lane itself still holds its non-convergent reason');

  // Remove only the parent write the lane pool made: finalizePhaseSuccess reads the parent
  // alone, so the lane's reason is invisible and the phase is miscounted as completed.
  const parent = JSON.parse(fs.readFileSync(runtime.statePath, 'utf-8'));
  fs.writeFileSync(runtime.statePath, JSON.stringify({ ...parent, exit_reason: null }));
  const counters = freshCounters();
  finalizePhaseSuccess(runtime, counters, noCancelMarker(runtime), 'anatomy-park', 0, () => {});
  assert.equal(counters.completed, 1, 'no aggregation → the non-convergent lane is reported as completed');
  assert.equal(counters.nonConvergent, 0);
});

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

  await expectMainExit(sessionDir, 0);

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

  const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
  assert.match(
    runnerLog,
    /Closer: prior phase non-zero exit detected — skipping install and tag/,
  );
  fs.rmSync(repo, { recursive: true, force: true });
});

// Control: the downgrade itself is unchanged — this fix moves the EVIDENCE wire,
// never the disposition wire. Without this, widening the branch into a halt or a
// nonConvergent bump would also satisfy the case above.
test('AP-EXT-ITER83-01 control: the missing-key-metric downgrade still continues and exits 0', async () => {
  const { repo, sessionDir } = driveAnatomyMissingKeyMetricCrash();

  await expectMainExit(sessionDir, 0);

  const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
  assert.match(runnerLog, /phase_skipped_with_warning/);
  assert.match(runnerLog, /anatomy_park_missing_key_metric/);
  const status = JSON.parse(fs.readFileSync(path.join(sessionDir, 'pipeline-status.json'), 'utf-8'));
  assert.equal(status.status, 'completed');
  assert.equal(status.skipped_phases, 1);
  fs.rmSync(repo, { recursive: true, force: true });
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

  await expectMainExit(sessionDir, 0);

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

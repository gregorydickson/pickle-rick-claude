// @tier: fast
/**
 * B-ONEABORT WS-ONEABORT-1 (AC-OA-1a / AC-OA-1b / AC-OA-1c) — the classifier abort collapsed to
 * the crash floor, and a degraded phase never claims success.
 *
 * A halted run produces no output, and no output has no quality (`CLAUDE.md`, first section).
 * `classifyMicroverseHaltDecision` used to abort the whole pipeline on eight triggers; exactly one
 * of them is a genuine crash floor. This file pins the collapse and the honesty rule that comes
 * with it: continuing is NOT claiming success.
 *
 * The subject list is DERIVED from the exported `MICROVERSE_EXIT_REASONS` union at runtime, never
 * hand-copied — adding a member without giving it a disposition reddens this suite by construction.
 * `describe.each(` does not exist in `node:test` (verified: `typeof test.describe.each ===
 * 'undefined'`), so the parametrization is a runtime `for…of`, matching the precedent in
 * `tests/microverse-disposition-map.test.js:28-36`.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  __setSpawnRunnerForTests,
  __setCloserReleaseActionsForTests,
  classifyMicroverseHaltDecision,
  runAllBackendsExhaustedFinalizeGate,
  logPhaseHaltReason,
  shouldHaltAfterPhase,
  main,
} from '../bin/pipeline-runner.js';
import { MICROVERSE_EXIT_REASONS } from '../types/index.js';

const TMP_DIRS = new Set();

// Hang guard, NOT a perf assertion (extension/CLAUDE.md, serial-manifest hygiene principle): an
// unbounded git here can wedge the whole tier forever.
const GIT_TIMEOUT_MS = 30_000;

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
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: GIT_TIMEOUT_MS }).trim();
}

function makeRepo() {
  const repo = tmpDir('oneabort-repo-');
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test User'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  // discoverSubsystems enumerates directories holding source files; seed one so the microverse
  // phases find a real subsystem instead of skipping for empty scope.
  fs.mkdirSync(path.join(repo, 'services'), { recursive: true });
  for (const name of ['a.ts', 'b.ts', 'c.ts']) {
    fs.writeFileSync(path.join(repo, 'services', name), `export const ${name[0]} = 1;\n`);
  }
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'seed'], repo);
  return { repo, startCommit: git(['rev-parse', 'HEAD'], repo) };
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
    original_prompt: 'oneabort termination invariant test',
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

/** Build a minimal PipelineRuntime the way production code does. */
function makeRuntime({ repo, startCommit, exitReason = null } = {}) {
  const sessionDir = tmpDir('oneabort-session-');
  const statePath = writeState(sessionDir, {
    working_dir: repo,
    start_commit: startCommit,
    exit_reason: exitReason,
  });
  return {
    sessionDir,
    extensionRoot: process.cwd(),
    statePath,
    config: {
      phases: ['anatomy-park'],
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

/** The reasons that route to the incomplete gate — every union member except the R-PRJT-2 one. */
const INCOMPLETE_GATE_REASONS = MICROVERSE_EXIT_REASONS.filter((r) => r !== 'judge_timeout');

/**
 * The ONE reason pair that legitimately shares a residual key. `state-manager.ts`
 * `migrateLegacyBaselineExitReason` rewrites the legacy bare `baseline_unmeasurable` to
 * `baseline_unmeasurable_unrecoverable` on every `StateManager.read()`, so the bare form can never
 * survive a read to reach the classifier. That collapse is upstream of this ticket and deliberate;
 * pinning it here keeps it the ONLY one — any other pair sharing a key reddens the cardinality
 * assertion below.
 */
const LEGACY_MIGRATED_ON_READ = { baseline_unmeasurable: 'baseline_unmeasurable_unrecoverable' };
const residualFor = (reason) => LEGACY_MIGRATED_ON_READ[reason] ?? reason;

afterEach(() => {
  __setSpawnRunnerForTests(null);
  __setCloserReleaseActionsForTests(null);
  for (const dir of TMP_DIRS) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  TMP_DIRS.clear();
});

describe('AC-OA-1a: no member of the exported exit-reason union resolves to abort', () => {
  test('the union is non-empty, so the loop below cannot pass vacuously', () => {
    assert.ok(MICROVERSE_EXIT_REASONS.length >= 10, 'union unexpectedly small — check the import');
  });

  // Runtime `for…of` over the exported union — see the file header on `describe.each(`.
  for (const reason of MICROVERSE_EXIT_REASONS) {
    test(`${reason} does not abort and carries its own reason`, () => {
      const decision = classifyMicroverseHaltDecision(reason);
      assert.notEqual(decision.action, 'abort', `${reason} must not abort at the classifier site`);
      assert.equal(decision.recognizedExitReason, reason);
    });
  }

  test('judge_timeout keeps its R-PRJT-2 transient route; every other member runs the incomplete gate', () => {
    assert.equal(classifyMicroverseHaltDecision('judge_timeout').action, 'run-finalize-gate');
    for (const reason of INCOMPLETE_GATE_REASONS) {
      assert.equal(
        classifyMicroverseHaltDecision(reason).action,
        'run-finalize-gate-incomplete',
        `${reason} must route to the incomplete gate`,
      );
    }
  });
});

describe('AC-OA-1a: the crash floor still aborts', () => {
  test('session_state_corrupted is the named floor — it is NOT in the exit union', () => {
    assert.ok(
      !MICROVERSE_EXIT_REASONS.includes('session_state_corrupted'),
      'the floor must be excepted against the union it actually lives in (MICROVERSE_FATAL_REASONS)',
    );
    assert.deepEqual(classifyMicroverseHaltDecision('session_state_corrupted'), {
      action: 'abort',
      recognizedExitReason: 'session_state_corrupted',
    });
  });

  for (const nonString of [null, undefined, 42, {}, []]) {
    test(`a non-string exit_reason (${JSON.stringify(nonString) ?? 'undefined'}) aborts unattributed`, () => {
      assert.deepEqual(classifyMicroverseHaltDecision(nonString), {
        action: 'abort',
        recognizedExitReason: null,
      });
    });
  }

  test('a string in neither union keeps the unattributed abort (ticket 20 scope)', () => {
    assert.deepEqual(classifyMicroverseHaltDecision('some_unknown_reason'), {
      action: 'abort',
      recognizedExitReason: null,
    });
  });
});

describe('AC-OA-1b: the residual carries the reason, so distinct reasons yield distinct keys', () => {
  test('every incomplete-gate reason lands verbatim in phaseDispositions', async () => {
    const observed = new Map();
    for (const reason of INCOMPLETE_GATE_REASONS) {
      const { repo, startCommit } = makeRepo();
      const runtime = makeRuntime({ repo, startCommit, exitReason: reason });
      const counters = freshCounters();
      stubGateExit(0);

      const outcome = await runAllBackendsExhaustedFinalizeGate(runtime, counters, 'anatomy-park', () => {});

      assert.equal(outcome.action, 'continue');
      assert.equal(
        counters.phaseDispositions['anatomy-park'],
        residualFor(reason),
        `${reason} must reach the residual verbatim, not collapse into one key`,
      );
      observed.set(reason, counters.phaseDispositions['anatomy-park']);
    }
    // Distinct reason ⇒ distinct residual value, modulo the one documented read-time migration.
    assert.equal(
      new Set(observed.values()).size,
      new Set(INCOMPLETE_GATE_REASONS.map(residualFor)).size,
      'residual keys collapsed — distinct reasons must not share one ledger key',
    );
  });

  test('an unreadable state degrades to the incumbent label, never to an abort', async () => {
    const { repo, startCommit } = makeRepo();
    const runtime = makeRuntime({ repo, startCommit });
    fs.writeFileSync(runtime.statePath, 'not json at all');
    const counters = freshCounters();
    stubGateExit(0);

    const outcome = await runAllBackendsExhaustedFinalizeGate(runtime, counters, 'anatomy-park', () => {});

    assert.equal(outcome.action, 'continue');
    assert.equal(counters.phaseDispositions['anatomy-park'], 'all_judge_backends_exhausted');
  });

  test('the log names the reason, not a generic "recovery attempted"', async () => {
    const { repo, startCommit } = makeRepo();
    const runtime = makeRuntime({ repo, startCommit, exitReason: 'baseline_unmeasurable_transient' });
    const lines = [];
    stubGateExit(0);

    await runAllBackendsExhaustedFinalizeGate(runtime, freshCounters(), 'anatomy-park', (m) => lines.push(m));

    assert.match(lines.join('\n'), /finalize-gate passed after baseline_unmeasurable_transient/);
  });
});

describe('AC-OA-4: the incumbent reasons keep their existing counter behaviour', () => {
  for (const reason of ['baseline_unmeasurable_transient', 'all_judge_backends_exhausted', 'no_progress']) {
    test(`${reason}: a passing gate still increments counters.completed`, async () => {
      const { repo, startCommit } = makeRepo();
      const runtime = makeRuntime({ repo, startCommit, exitReason: reason });
      const counters = freshCounters();
      stubGateExit(0);

      const outcome = await runAllBackendsExhaustedFinalizeGate(runtime, counters, 'anatomy-park', () => {});

      // PINNED: `completed` is unchanged (nostop-gates-sibling-parity.test.js:134 pins it too).
      // The degraded verdict rides the SEPARATE `nonConvergent` term instead.
      assert.equal(counters.completed, 1);
      assert.equal(counters.nonConvergent, 1);
      assert.equal(outcome.phaseIncomplete, undefined);
    });
  }

  test('a failing gate still breaks and touches no counter', async () => {
    const { repo, startCommit } = makeRepo();
    const runtime = makeRuntime({ repo, startCommit, exitReason: 'all_judge_backends_exhausted' });
    const counters = freshCounters();
    stubGateExit(1);

    const outcome = await runAllBackendsExhaustedFinalizeGate(runtime, counters, 'anatomy-park', () => {});

    assert.equal(outcome.action, 'break');
    assert.equal(counters.completed, 0);
    assert.equal(counters.nonConvergent, 0);
    assert.deepEqual(counters.phaseDispositions, {});
  });
});

/**
 * B-ONEABORT WS-ONEABORT-2 (AC-OA-2a/AC-OA-2b), ticket 9e6608a8: "no unattributed termination" —
 * quantified over the actual termination SITES inside `logPhaseHaltReason`, not over the
 * `MicroverseHaltDecision` return type. Two of the surviving sites (the bare `else` in the
 * non-pickle/citadel branch and the outer `catch`) never construct a decision object at all, so an
 * assertion over `MicroverseHaltDecision.recognizedExitReason` would pass vacuously here.
 */
describe('AC-OA-2a/AC-OA-2b: every logPhaseHaltReason termination site names a reason', () => {
  const haltMsgFor = (rawPhase, exitCode) => `Phase ${rawPhase} failed (exit ${exitCode}) — stopping pipeline`;

  test('SITE 1 — the bare non-pickle/non-microverse branch (citadel) is not silent', () => {
    const { repo, startCommit } = makeRepo();
    const runtime = makeRuntime({ repo, startCommit });
    const lines = [];

    const action = logPhaseHaltReason(runtime, 'citadel', 1, (m) => lines.push(m));

    assert.equal(action, 'abort');
    assert.equal(lines.length, 1);
    assert.notEqual(lines[0], haltMsgFor('citadel', 1), 'must not be the bare stopping-pipeline message');
    assert.match(lines[0], /\(non-pickle-phase failure, exit code 1\)/);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test('SITE 2 — an unclassifiable exit_reason names itself, quantified over arbitrary input', () => {
    const unclassifiableInputs = [undefined, null, 42, true, {}, [], 'some_unrecognized_reason'];
    for (const exitReason of unclassifiableInputs) {
      const { repo, startCommit } = makeRepo();
      const runtime = makeRuntime({ repo, startCommit, exitReason });
      const lines = [];

      const action = logPhaseHaltReason(runtime, 'anatomy-park', 1, (m) => lines.push(m));

      assert.equal(action, 'abort', `${JSON.stringify(exitReason)} must still abort`);
      assert.equal(lines.length, 1);
      assert.notEqual(
        lines[0],
        haltMsgFor('anatomy-park', 1),
        `${JSON.stringify(exitReason)} must not resolve to the bare stopping-pipeline message`,
      );
      assert.match(
        lines[0],
        /\(unclassified:/,
        `${JSON.stringify(exitReason)} must carry a named unclassified reason, never silence`,
      );
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('SITE 3 — an unreadable state.json still names the halt reason', () => {
    const { repo, startCommit } = makeRepo();
    const runtime = makeRuntime({ repo, startCommit });
    fs.writeFileSync(runtime.statePath, 'not json at all');
    const lines = [];

    const action = logPhaseHaltReason(runtime, 'anatomy-park', 1, (m) => lines.push(m));

    assert.equal(action, 'abort');
    assert.equal(lines.length, 1);
    assert.notEqual(lines[0], haltMsgFor('anatomy-park', 1));
    assert.match(lines[0], /\(state read failed:/);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test('the guarded arms (classifyMicroverseHaltDecision non-string + fallthrough) are reachable and named when pipeline_continue_on_phase_fail is false', () => {
    for (const exitReason of [undefined, 'some_unrecognized_reason']) {
      const { repo, startCommit } = makeRepo();
      const sessionDir = tmpDir('oneabort-guarded-arm-session-');
      const statePath = writeState(sessionDir, {
        working_dir: repo,
        start_commit: startCommit,
        exit_reason: exitReason,
        pipeline_continue_on_phase_fail: false,
      });
      const runtime = {
        sessionDir,
        extensionRoot: process.cwd(),
        statePath,
        config: {
          phases: ['anatomy-park'],
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

      // The classifier alone says this is non-fatal (it is not in MICROVERSE_FATAL_REASONS and
      // is not a recognized member of the exit union), so isFatalPhaseFailure returns false.
      // Only the strict-phase policy override reaches the guarded classifyMicroverseHaltDecision
      // arms that return recognizedExitReason: null.
      assert.equal(
        shouldHaltAfterPhase('anatomy-park', 1, runtime),
        true,
        'pipeline_continue_on_phase_fail:false must force a halt even for a non-fatal reason',
      );

      const lines = [];
      const action = logPhaseHaltReason(runtime, 'anatomy-park', 1, (m) => lines.push(m));

      assert.equal(action, 'abort');
      assert.equal(lines.length, 1);
      assert.match(lines[0], /\(unclassified:/, `guarded arm for ${JSON.stringify(exitReason)} must name a reason`);
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('AC-OA-1c: a degraded phase never claims success', () => {
  test('every phase degraded ⇒ non-zero exit, failed status, and NO closer release plan', async () => {
    const { repo, startCommit } = makeRepo();
    const sessionDir = tmpDir('oneabort-main-session-');
    const statePath = writeState(sessionDir, {
      working_dir: repo,
      start_commit: startCommit,
      step: 'implement',
      tmux_mode: true,
      pipeline_continue_on_phase_fail: true,
    });
    fs.writeFileSync(path.join(sessionDir, 'pipeline.json'), JSON.stringify({
      phases: ['anatomy-park'],
      target: repo,
      anatomy_stall_limit: 3,
      szechuan_stall_limit: 5,
      anatomy_max_iterations: 100,
      szechuan_max_iterations: 50,
      citadel_strict: false,
      dirty_exempt_segments: ['prds', 'docs'],
    }, null, 2));

    let installCalls = 0;
    let tagCalls = 0;
    __setCloserReleaseActionsForTests({
      install: () => { installCalls++; },
      tag: () => { tagCalls++; },
    });

    let spawnCount = 0;
    __setSpawnRunnerForTests(async () => {
      spawnCount++;
      if (spawnCount === 1) {
        // The phase itself exits non-zero having degraded: a judge that answered in prose.
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        state.exit_reason = 'baseline_unmeasurable_unrecoverable';
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
        return { exitCode: 1, stdout: '', stderr: '' };
      }
      // Everything downstream (the finalize gate) is green.
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const originalExit = process.exit;
    const originalTmux = process.env.TMUX;
    delete process.env.TMUX;
    process.exit = (code) => { throw new ExitIntercept(code ?? 0); };
    try {
      // The pipeline RAN to completion — but it does NOT report success.
      await assert.rejects(
        () => main(sessionDir),
        (err) => err instanceof ExitIntercept && err.code !== 0,
      );
    } finally {
      process.exit = originalExit;
      if (originalTmux === undefined) delete process.env.TMUX; else process.env.TMUX = originalTmux;
    }

    // It did NOT abort: the finalize gate ran over the converged work.
    assert.ok(spawnCount >= 2, 'the finalize gate must have run — the phase must not abort');
    assert.equal(installCalls, 0, 'a degraded run must not reach executeCloserReleasePlan');
    assert.equal(tagCalls, 0, 'a degraded run must not auto-release');

    const status = JSON.parse(fs.readFileSync(path.join(sessionDir, 'pipeline-status.json'), 'utf-8'));
    assert.equal(status.status, 'failed', 'a degraded run must not report a completed status');
    assert.equal(
      status.phase_dispositions['anatomy-park'],
      'baseline_unmeasurable_unrecoverable',
      'the residual must name the degradation for the operator',
    );
    fs.rmSync(repo, { recursive: true, force: true });
  });
});

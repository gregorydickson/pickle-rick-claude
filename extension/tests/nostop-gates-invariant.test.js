// @tier: fast
/**
 * B-NOSTOP-GATES WS-1 — AC-NSG-5b.
 *
 * ONE RULE: honesty is a REPORTING property, halting is a DISPOSITION, they are
 * not the same wire. For the pickle phase, with a `start_commit` present and
 * `pipeline_continue_on_phase_fail !== false`, NO quality-verdict exit_reason
 * may halt the pipeline — this holds for every incomplete/quality exit_reason
 * and every non-zero exit code mux-runner can produce for a phase that
 * genuinely ran (1 or 3).
 *
 * Two crash-floor pins verify the invariant is bounded, not universal:
 *   - `pipeline_continue_on_phase_fail === false` (the `--strict-phases` /
 *     persisted opt-in) still halts regardless of exit_reason/exitCode.
 *   - a missing `start_commit` still halts — progress is unmeasurable, and no
 *     downstream honesty gate can report around that.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  __setSpawnRunnerForTests,
  isFatalPhaseFailure,
  shouldHaltAfterPhase,
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
  const repo = tmpDir('nostop-invariant-repo-');
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
    step: 'implement',
    iteration: 0,
    max_iterations: 100,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 'nostop-gates invariant test',
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
function makeRuntime({ startCommit, repo, stateOverrides = {} } = {}) {
  const sessionDir = tmpDir('nostop-invariant-session-');
  const statePath = writeState(sessionDir, {
    working_dir: repo,
    start_commit: startCommit,
    ...stateOverrides,
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

afterEach(() => {
  __setSpawnRunnerForTests(null);
  for (const dir of TMP_DIRS) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  TMP_DIRS.clear();
});

// The exit_reason vocabulary a quality-verdict pickle exit can carry. Sourced
// from mux-runner.ts's INCOMPLETE_EXIT_REASONS ({'done_without_commit_evidence'})
// plus the two pipeline-runner-internal incomplete stamps this ticket widens
// ('pipeline_phase_incomplete', 'phase_no_progress'). Not re-exported from
// mux-runner.ts, so the set is enumerated here rather than imported.
const QUALITY_VERDICT_EXIT_REASONS = [
  'done_without_commit_evidence',
  'pipeline_phase_incomplete',
  'phase_no_progress',
];

const MUX_NONZERO_EXIT_CODES = [1, 3];

describe('AC-NSG-5b — ONE RULE: quality-verdict exit_reasons never halt pickle', () => {
  for (const reason of QUALITY_VERDICT_EXIT_REASONS) {
    for (const exitCode of MUX_NONZERO_EXIT_CODES) {
      test(`exit_reason=${reason}, exitCode=${exitCode}: shouldHaltAfterPhase('pickle', ...) === false`, () => {
        const { repo, startCommit } = makeRepo();
        const runtime = makeRuntime({
          repo,
          startCommit,
          stateOverrides: {
            exit_reason: reason,
            pipeline_continue_on_phase_fail: true,
          },
        });

        assert.equal(
          isFatalPhaseFailure('pickle', runtime),
          false,
          `isFatalPhaseFailure must not fatal pickle for exit_reason=${reason}`,
        );
        assert.equal(
          shouldHaltAfterPhase('pickle', exitCode, runtime),
          false,
          `shouldHaltAfterPhase must not halt pickle for exit_reason=${reason}, exitCode=${exitCode}`,
        );
      });
    }
  }
});

describe('AC-NSG-5b — crash-floor pins (the invariant is bounded, not universal)', () => {
  test('pipeline_continue_on_phase_fail === false still halts regardless of exit_reason/exitCode', () => {
    const { repo, startCommit } = makeRepo();
    const runtime = makeRuntime({
      repo,
      startCommit,
      stateOverrides: {
        exit_reason: 'done_without_commit_evidence',
        pipeline_continue_on_phase_fail: false,
      },
    });

    // isFatalPhaseFailure itself is unaffected by the strict-phase override —
    // it is shouldHaltAfterPhase's SECOND check (:2846) that enforces the pin.
    assert.equal(isFatalPhaseFailure('pickle', runtime), false);
    assert.equal(
      shouldHaltAfterPhase('pickle', 3, runtime),
      true,
      '--strict-phases / persisted pipeline_continue_on_phase_fail=false is the bundle\'s ONLY ' +
      'rollback path and MUST survive this ticket\'s subtraction',
    );
  });

  test('missing start_commit still halts pickle — progress is unmeasurable', () => {
    const { repo } = makeRepo();
    const runtime = makeRuntime({
      repo,
      startCommit: undefined,
      stateOverrides: {
        exit_reason: 'done_without_commit_evidence',
        pipeline_continue_on_phase_fail: true,
      },
    });

    assert.equal(
      isFatalPhaseFailure('pickle', runtime),
      true,
      'a missing start_commit means progress is literally unmeasurable — no downstream honesty ' +
      'gate can report around that, so this arm (:2805 in the plan) stays fatal',
    );
    assert.equal(shouldHaltAfterPhase('pickle', 3, runtime), true);
  });
});

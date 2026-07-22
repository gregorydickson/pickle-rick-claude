// @tier: fast
/**
 * R-PRNF-9 regression tests — one per AC.
 *
 * AC-PRNF-9-1: zero commits-since-start_commit → isFatalPhaseFailure returns true.
 * AC-PRNF-9-4: partial build with commits → isFatalPhaseFailure returns false
 *              (no regression of continue path; AC-WDSUB-9 over-reach proof).
 * AC-PRNF-9-5: R-PHC-6 / R-ICP-2 not regressed — shouldHaltAfterPhase returns false for
 *              a non-fatal pickle non-zero exit with downstream phases queued.
 */
import { test, afterEach } from 'node:test';
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

// ─── helpers ────────────────────────────────────────────────────────────────

const TMP_DIRS = new Set();

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_DIRS.add(dir);
  return dir;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function makeRepo({ withFollowupCommit = false } = {}) {
  const repo = tmpDir('prnf9-repo-');
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test User'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.writeFileSync(path.join(repo, 'seed.ts'), 'export const x = 1;\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'seed'], repo);
  const startCommit = git(['rev-parse', 'HEAD'], repo);
  if (withFollowupCommit) {
    fs.writeFileSync(path.join(repo, 'seed.ts'), 'export const x = 2;\n');
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
    original_prompt: 'prnf9 test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 3,
    tmux_mode: false,
    chain_meeseeks: false,
    backend: 'claude',
    ...overrides,
  }, null, 2));
  return statePath;
}

/** Build a minimal PipelineRuntime object the way production code does. */
function makeRuntime({ withFollowupCommit = false, stateOverrides = {} } = {}) {
  const sessionDir = tmpDir('prnf9-session-');
  const { repo, startCommit } = makeRepo({ withFollowupCommit });
  const statePath = writeState(sessionDir, repo, {
    start_commit: startCommit,
    ...stateOverrides,
  });
  const runtime = {
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
  return { runtime, sessionDir, statePath, repo, startCommit };
}

afterEach(() => {
  __setSpawnRunnerForTests(null);
  for (const dir of TMP_DIRS) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  TMP_DIRS.clear();
});

// ─── AC-PRNF-9-1 ────────────────────────────────────────────────────────────
test('AC-PRNF-9-1: isFatalPhaseFailure returns true when pickle exits with zero commits since start_commit', () => {
  // No followup commit — countCommitsSince(startCommit, repo) === 0
  const { runtime } = makeRuntime({ withFollowupCommit: false });

  // No readiness_halt is set, so code must fall through to commit-count path
  const result = isFatalPhaseFailure('pickle', runtime);
  assert.equal(result, true,
    'isFatalPhaseFailure should return true when zero commits exist since start_commit');
});

// ─── AC-PRNF-9-4 ────────────────────────────────────────────────────────────
test('AC-PRNF-9-4: isFatalPhaseFailure returns false when pickle produced commits and exit_reason is not readiness_halt', () => {
  // Partial build scenario: pickle errored AFTER producing commits, no readiness_halt
  const { runtime } = makeRuntime({
    withFollowupCommit: true, // countCommitsSince > 0
    // no exit_reason override — simulates a normal non-readiness-halt failure
  });

  const result = isFatalPhaseFailure('pickle', runtime);
  assert.equal(result, false,
    'isFatalPhaseFailure must return false when commits exist and exit_reason is not readiness_halt (continue path not regressed)');
});

// ─── AC-PRNF-9-5 ────────────────────────────────────────────────────────────
test('AC-PRNF-9-5: R-PHC-6 / R-ICP-2 not regressed — shouldHaltAfterPhase returns false for non-fatal pickle non-zero exit with downstream phases', () => {
  // Non-fatal: commits exist, no readiness_halt → isFatalPhaseFailure=false
  // pipeline_continue_on_phase_fail not explicitly set to false → default continue
  const { runtime, statePath } = makeRuntime({
    withFollowupCommit: true,
    stateOverrides: {
      pipeline_continue_on_phase_fail: true, // R-PHC-6 continue-by-default
    },
  });

  // isFatalPhaseFailure must be false (precondition)
  assert.equal(isFatalPhaseFailure('pickle', runtime), false,
    'precondition: isFatalPhaseFailure must be false for a partial-build non-readiness exit');

  // shouldHaltAfterPhase must NOT halt (R-PHC-6 continue-by-default preserved)
  const halt = shouldHaltAfterPhase('pickle', 1, runtime);
  assert.equal(halt, false,
    'shouldHaltAfterPhase must return false for a non-fatal pickle non-zero exit when downstream phases are queued (R-PHC-6 not regressed)');
});

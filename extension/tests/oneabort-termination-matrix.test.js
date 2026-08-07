// @tier: fast
/**
 * B-ONEABORT WS-ONEABORT-4 (AC-OA-4a/AC-OA-4b): a falsifiable, machine-readable termination
 * matrix generated from REAL execution of `classifyMicroverseHaltDecision` + the finalize-gate
 * runners, proving every non-floor `MICROVERSE_EXIT_REASONS` member reaches the finalize gate
 * rather than aborting. The matrix is written to `prds/research/oneabort-termination-matrix.json`
 * on every run — never hand-transcribed — and `assertMatrixInvariants` is shared between the
 * real-matrix pass (must not throw) and a mutated-clone negative fixture (must throw), so the
 * test can go RED on a real regression.
 */
import { test, describe, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  __setSpawnRunnerForTests,
  classifyMicroverseHaltDecision,
  runJudgeTimeoutFinalizeGate,
  runAllBackendsExhaustedFinalizeGate,
} from '../bin/pipeline-runner.js';
import { MICROVERSE_EXIT_REASONS } from '../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MATRIX_PATH = path.resolve(__dirname, '..', '..', 'prds', 'research', 'oneabort-termination-matrix.json');

const TMP_DIRS = new Set();
const GIT_TIMEOUT_MS = 30_000;

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_DIRS.add(dir);
  return dir;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: GIT_TIMEOUT_MS }).trim();
}

function makeRepo() {
  const repo = tmpDir('oneabort-matrix-repo-');
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test User'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
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
    original_prompt: 'oneabort termination matrix test',
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

function makeRuntime({ repo, startCommit, exitReason = null } = {}) {
  const sessionDir = tmpDir('oneabort-matrix-session-');
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

/**
 * Runs the real classifier + finalize-gate runners (gate stubbed to exit 0) for every
 * `MICROVERSE_EXIT_REASONS` member plus the `session_state_corrupted` crash floor, and returns
 * one record per reason. Real execution, not transcription — AC-OA-4a.
 */
async function generateMatrix() {
  const matrix = [];
  for (const reason of MICROVERSE_EXIT_REASONS) {
    const { repo, startCommit } = makeRepo();
    const runtime = makeRuntime({ repo, startCommit, exitReason: reason });
    const counters = freshCounters();
    stubGateExit(0);

    const decision = classifyMicroverseHaltDecision(reason);
    let pipelineReachedFinalize = false;
    let residualReason = decision.recognizedExitReason;

    if (decision.action === 'run-finalize-gate') {
      const outcome = await runJudgeTimeoutFinalizeGate(runtime, counters, 'anatomy-park', () => {});
      pipelineReachedFinalize = outcome.action === 'continue';
      residualReason = decision.recognizedExitReason;
    } else if (decision.action === 'run-finalize-gate-incomplete') {
      const outcome = await runAllBackendsExhaustedFinalizeGate(runtime, counters, 'anatomy-park', () => {});
      pipelineReachedFinalize = outcome.action === 'continue';
      residualReason = counters.phaseDispositions['anatomy-park'];
    }

    matrix.push({
      reason,
      action: decision.action,
      pipeline_reached_finalize: pipelineReachedFinalize,
      residual_reason: residualReason ?? '',
      is_floor: false,
    });
  }

  const floorDecision = classifyMicroverseHaltDecision('session_state_corrupted');
  matrix.push({
    reason: 'session_state_corrupted',
    action: floorDecision.action,
    pipeline_reached_finalize: false,
    residual_reason: floorDecision.recognizedExitReason ?? '',
    is_floor: true,
  });

  return matrix;
}

/**
 * Shared invariant-checker: throws (via node:assert/strict) when violated, so the SAME code path
 * validates the real matrix (must not throw) and a fabricated negative fixture (must throw) —
 * AC-OA-4b's falsifiability requirement.
 */
function assertMatrixInvariants(matrix, unionMembers) {
  assert.ok(Array.isArray(matrix) && matrix.length >= 1, 'matrix must be a non-empty array');
  for (const record of matrix) {
    assert.ok(
      'reason' in record && 'action' in record && 'pipeline_reached_finalize' in record && 'residual_reason' in record,
      `record missing required keys: ${JSON.stringify(record)}`,
    );
  }
  for (const member of unionMembers) {
    assert.ok(
      matrix.some((r) => r.reason === member),
      `MICROVERSE_EXIT_REASONS member "${member}" is missing from the matrix — exhaustive-key AC violated`,
    );
  }
  for (const record of matrix) {
    if (record.is_floor === true) continue;
    assert.notEqual(record.action, 'abort', `non-floor reason "${record.reason}" must not abort`);
    assert.equal(record.pipeline_reached_finalize, true, `non-floor reason "${record.reason}" must reach finalize`);
    assert.ok(
      typeof record.residual_reason === 'string' && record.residual_reason.length > 0,
      `non-floor reason "${record.reason}" must carry a non-empty residual_reason`,
    );
  }
}

let realMatrix;

before(async () => {
  realMatrix = await generateMatrix();
  fs.mkdirSync(path.dirname(MATRIX_PATH), { recursive: true });
  fs.writeFileSync(MATRIX_PATH, JSON.stringify(realMatrix, null, 2) + '\n');
});

afterEach(() => {
  __setSpawnRunnerForTests(null);
  for (const dir of TMP_DIRS) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  TMP_DIRS.clear();
});

describe('AC-OA-4a: the termination matrix is generated by real execution', () => {
  test('the matrix file exists on disk and parses with >= 1 record', () => {
    const parsed = JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf-8'));
    assert.ok(Array.isArray(parsed) && parsed.length >= 1);
  });

  test('the union is non-empty, so the exhaustive-key check cannot pass vacuously', () => {
    assert.ok(MICROVERSE_EXIT_REASONS.length >= 10, 'union unexpectedly small — check the import');
  });
});

describe('AC-OA-4b: the assertion derives its expected key set from the exported union at runtime', () => {
  test('every MICROVERSE_EXIT_REASONS member appears in the real matrix', () => {
    assertMatrixInvariants(realMatrix, MICROVERSE_EXIT_REASONS);
  });

  test('a matrix missing a union member fails the exhaustive-key check', () => {
    const missingOne = realMatrix.filter((r) => r.reason !== MICROVERSE_EXIT_REASONS[0]);
    assert.throws(() => assertMatrixInvariants(missingOne, MICROVERSE_EXIT_REASONS), assert.AssertionError);
  });
});

describe('AC-OA-4b: every non-floor member reaches finalize with a non-empty residual', () => {
  test('the real matrix satisfies the invariant (positive control)', () => {
    assert.doesNotThrow(() => assertMatrixInvariants(realMatrix, MICROVERSE_EXIT_REASONS));
  });

  test('a fabricated matrix with a non-floor reason recording action:"abort" FAILS the assertion — falsifiable', () => {
    const fabricated = realMatrix.map((r) => ({ ...r }));
    const target = fabricated.find((r) => r.is_floor !== true);
    assert.ok(target, 'fixture must contain at least one non-floor record');
    target.action = 'abort';
    assert.throws(() => assertMatrixInvariants(fabricated, MICROVERSE_EXIT_REASONS), assert.AssertionError);
  });

  test('the crash floor itself aborts and is excepted from the non-floor invariant', () => {
    const floor = realMatrix.find((r) => r.reason === 'session_state_corrupted');
    assert.ok(floor, 'floor record must be present');
    assert.equal(floor.is_floor, true);
    assert.equal(floor.action, 'abort');
  });
});

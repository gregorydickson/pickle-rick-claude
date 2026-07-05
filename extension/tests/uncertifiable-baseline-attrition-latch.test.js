// @tier: integration
// R-SZGB-C-A: proves the uncertifiable-baseline defer arms the EXISTING R-ORSR-6
// no-attrition latch (ctx.postConvergenceSelfRedOpen) instead of letting a worker
// force-converge a tsc-RED tree by attrition at the R-APXG-3 deferral cap.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  ensurePerIterationGateBaseline,
  handleWorkerManagedIteration,
  handleIterationOutcome,
} = await import(path.resolve(__dirname, '../bin/microverse-runner.js'));

// ---------------------------------------------------------------------------
// Env isolation: keep real activity-logger writes off the operator's data dir.
// ---------------------------------------------------------------------------
let dataRoot;
const savedEnv = {};

before(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'szgbc-data-'));
  for (const k of ['PICKLE_DATA_ROOT', 'PICKLE_DATA_DIR', 'PICKLE_REFINEMENT_LOCK']) {
    savedEnv[k] = process.env[k];
  }
  process.env.PICKLE_DATA_ROOT = dataRoot;
  delete process.env.PICKLE_DATA_DIR;
  delete process.env.PICKLE_REFINEMENT_LOCK;
});

after(() => {
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) { delete process.env[k]; }
    else process.env[k] = savedEnv[k];
  }
  if (dataRoot) { fs.rmSync(dataRoot, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeGitRepo(prefix) {
  const dir = mkTmp(prefix);
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

function commitAll(dir, message) {
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', message], { cwd: dir, stdio: 'pipe' });
}

function headSha(dir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
}

function makeMv(overrides = {}) {
  return {
    status: 'iterating',
    prd_path: 'prd.md',
    key_metric: { description: 'test', validation: 'echo 1', type: 'command', timeout_seconds: 30, tolerance: 1 },
    convergence: { stall_limit: 5, stall_counter: 0, history: [] },
    gap_analysis_path: 'gap.md',
    failed_approaches: [],
    baseline_score: 0,
    failure_history: [],
    approach_exhaustion_fired: false,
    convergence_mode: 'worker',
    convergence_file: 'anatomy-park.json',
    iteration_regressions: 0,
    gate_regression_threshold_warning_emitted: false,
    ...overrides,
  };
}

// A real npm project with a lint check that can be triggered to fail — the CERTIFIABLE
// fixture shape shared by AC-SZGBC-03/04 (mirrors anatomy-park-baseline-gate.test.js's
// writeGateFixtureRepo).
function writeCertifiableFixtureRepo(dir) {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'szgbc-gate-fixture',
      private: true,
      scripts: {
        typecheck: 'node scripts/typecheck.cjs',
        lint: 'node scripts/lint.cjs',
        test: 'node scripts/test.cjs',
      },
    }, null, 2),
  );
  fs.writeFileSync(path.join(dir, 'scripts', 'typecheck.cjs'), 'process.exit(0);\n');
  fs.writeFileSync(
    path.join(dir, 'scripts', 'lint.cjs'),
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "if (!fs.existsSync(path.join(process.cwd(), 'trigger-lint.txt'))) process.exit(0);",
      "const failingFile = path.join(process.cwd(), 'src', 'broken.js');",
      "console.error(failingFile);",
      "console.error('  1:1  error  simulated lint regression  no-simulated-regression');",
      "console.error('');",
      "console.error('✖ 1 problem (1 error, 0 warnings)');",
      'process.exit(1);',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(dir, 'scripts', 'test.cjs'), 'process.exit(0);\n');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'broken.js'), 'module.exports = 1;\n');
}

const BASE_OPTS = {
  regressionWarningThreshold: 5,
  backend: 'claude',
  remediatorTimeoutS: 600,
  log: () => {},
};

// ===========================================================================
// AC-SZGBC-01: headline attrition repro (multi-iteration drive through the real
// producer via the exported handleIterationOutcome boundary — no stubbing of
// runWorkerManagedIteration).
// ===========================================================================

test('AC-SZGBC-01: 3 consecutive worker-signaled converges against an uncertifiable baseline over a tsc-RED tree cannot force-converge at the deferral cap', async () => {
  const workingDir = makeGitRepo('szgbc-uncert-repo-');
  const sessionDir = mkTmp('szgbc-uncert-session-');
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({ backend: 'claude', active: true }));

  try {
    fs.writeFileSync(path.join(workingDir, 'README.md'), 'no project marker here\n');
    commitAll(workingDir, 'initial clean state');

    await ensurePerIterationGateBaseline({
      currentMv: makeMv({ key_metric: undefined }),
      workingDir,
      sessionDir,
      enabledFiles: ['anatomy-park.json'],
      log: () => {},
    });

    const baseline = JSON.parse(fs.readFileSync(path.join(sessionDir, 'gate', 'baseline.json'), 'utf-8'));
    assert.equal(baseline.project_type, null, 'fixture precondition: baseline must be uncertifiable');

    const state = makeMv({ key_metric: undefined });
    const ctx = {
      sessionDir,
      statePath,
      workingDir,
      iteration: 1,
      preIterSha: headSha(workingDir),
      consecutiveRateLimits: 0,
      currentRunnerState: { backend: 'claude', min_iterations: 1 },
      cgSettings: {
        enabled_convergence_files: ['anatomy-park.json'],
        regression_warning_threshold: 5,
        remediator_timeout_s: 60,
      },
      log: () => {},
    };
    const outcome = { completion: 'task_completed', timedOut: false };
    const exitReasons = [];

    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(workingDir, 'broken.ts'), `let x${i}: number = "s";\n`);
      fs.writeFileSync(
        path.join(sessionDir, 'anatomy-park.json'),
        JSON.stringify({ converged: true, reason: 'clean passes done' }),
      );
      commitAll(workingDir, `introduce tsc-RED change ${i} under an uncertifiable target`);
      ctx.iteration = i + 1;
      const result = await handleIterationOutcome(state, { raw: '', score: null }, ctx, outcome);
      exitReasons.push(result);
      ctx.preIterSha = ctx.postIterSha;
    }

    assert.deepEqual(
      exitReasons,
      ['continue', 'continue', 'continue'],
      `an uncertifiable baseline must never let the worker force-converge past the deferral cap, got: ${JSON.stringify(exitReasons)}`,
    );
    assert.equal(
      ctx.postConvergenceSelfRedOpen,
      true,
      'the uncertifiable-baseline defer must arm the R-ORSR-6 no-attrition latch (postConvergenceSelfRedOpen)',
    );
  } finally {
    rm(workingDir);
    rm(sessionDir);
  }
});

// ===========================================================================
// AC-SZGBC-02: latch source — direct single-iteration return-shape assertion.
// ===========================================================================

test('AC-SZGBC-02: the uncertifiable-baseline defer return carries selfRedOpen:true (latch source, not a fresh RED gate result)', async () => {
  const workingDir = makeGitRepo('szgbc-uncert-single-repo-');
  const sessionDir = mkTmp('szgbc-uncert-single-session-');

  try {
    fs.writeFileSync(path.join(workingDir, 'README.md'), 'no project marker here\n');
    commitAll(workingDir, 'initial clean state');

    await ensurePerIterationGateBaseline({
      currentMv: makeMv({ key_metric: undefined }),
      workingDir,
      sessionDir,
      enabledFiles: ['anatomy-park.json'],
      log: () => {},
    });

    const preIterSha = headSha(workingDir);
    fs.writeFileSync(path.join(workingDir, 'broken.ts'), 'let x: number = "s";\n');
    fs.writeFileSync(
      path.join(sessionDir, 'anatomy-park.json'),
      JSON.stringify({ converged: true, reason: 'clean passes done' }),
    );
    commitAll(workingDir, 'introduce tsc-RED change under an uncertifiable target');

    const result = await handleWorkerManagedIteration({
      ...BASE_OPTS,
      currentMv: makeMv({ key_metric: undefined }),
      preIterSha,
      workingDir,
      sessionDir,
      iteration: 1,
      enabledFiles: ['anatomy-park.json'],
      _deps: { writeMicroverseStateFn: () => {}, logActivityFn: () => {} },
    });

    assert.equal(result.converged, false, 'an uncertifiable baseline must never certify convergence');
    assert.equal(
      result.selfRedOpen,
      true,
      'the uncertifiable-baseline defer return must carry selfRedOpen:true so the caller arms the latch',
    );
  } finally {
    rm(workingDir);
    rm(sessionDir);
  }
});

// ===========================================================================
// AC-SZGBC-03: regression guard — a genuine strict-mode regression is unchanged.
// ===========================================================================

test('AC-SZGBC-03: a genuine strict-mode regression (real lint failure, certifiable baseline) keeps its existing return shape — no spurious selfRedOpen', async () => {
  const workingDir = makeGitRepo('szgbc-strict-repo-');
  const sessionDir = mkTmp('szgbc-strict-session-');

  try {
    writeCertifiableFixtureRepo(workingDir);
    commitAll(workingDir, 'initial clean state');

    await ensurePerIterationGateBaseline({
      currentMv: makeMv({ key_metric: undefined }),
      workingDir,
      sessionDir,
      enabledFiles: ['anatomy-park.json'],
      log: () => {},
    });

    const baseline = JSON.parse(fs.readFileSync(path.join(sessionDir, 'gate', 'baseline.json'), 'utf-8'));
    assert.equal(baseline.project_type, 'npm', 'fixture precondition: baseline must be certifiable');

    const preIterSha = headSha(workingDir);
    fs.writeFileSync(
      path.join(sessionDir, 'anatomy-park.json'),
      JSON.stringify({ converged: true, reason: 'clean passes done' }),
    );
    fs.writeFileSync(path.join(workingDir, 'trigger-lint.txt'), 'trigger\n');
    commitAll(workingDir, 'introduce final-iteration lint regression');

    const result = await handleWorkerManagedIteration({
      ...BASE_OPTS,
      currentMv: makeMv({ key_metric: undefined }),
      preIterSha,
      workingDir,
      sessionDir,
      iteration: 1,
      enabledFiles: ['anatomy-park.json'],
      _deps: { writeMicroverseStateFn: () => {}, logActivityFn: () => {} },
    });

    assert.equal(result.converged, false, 'a genuine strict-mode regression must still defer convergence');
    assert.equal(result.reason, 'per-iteration gate left unresolved regressions');
    assert.equal(
      result.selfRedOpen,
      undefined,
      'a genuine strict-mode regression must never arm the uncertifiable-baseline latch',
    );
  } finally {
    rm(workingDir);
    rm(sessionDir);
  }
});

// ===========================================================================
// AC-SZGBC-04: regression guard — the healthy path still converges normally.
// ===========================================================================

test('AC-SZGBC-04: a certifiable baseline with a clean tree still converges normally, unaffected by the new sink', async () => {
  const workingDir = makeGitRepo('szgbc-healthy-repo-');
  const sessionDir = mkTmp('szgbc-healthy-session-');

  try {
    writeCertifiableFixtureRepo(workingDir);
    commitAll(workingDir, 'initial clean state');

    await ensurePerIterationGateBaseline({
      currentMv: makeMv({ key_metric: undefined }),
      workingDir,
      sessionDir,
      enabledFiles: ['anatomy-park.json'],
      log: () => {},
    });

    const baseline = JSON.parse(fs.readFileSync(path.join(sessionDir, 'gate', 'baseline.json'), 'utf-8'));
    assert.equal(baseline.project_type, 'npm', 'fixture precondition: baseline must be certifiable');

    const preIterSha = headSha(workingDir);
    fs.writeFileSync(
      path.join(sessionDir, 'anatomy-park.json'),
      JSON.stringify({ converged: true, reason: 'clean passes done' }),
    );
    fs.writeFileSync(path.join(workingDir, 'harmless.txt'), 'no regression here\n');
    commitAll(workingDir, 'harmless clean commit');

    const result = await handleWorkerManagedIteration({
      ...BASE_OPTS,
      currentMv: makeMv({ key_metric: undefined }),
      preIterSha,
      workingDir,
      sessionDir,
      iteration: 1,
      enabledFiles: ['anatomy-park.json'],
      _deps: { writeMicroverseStateFn: () => {}, logActivityFn: () => {} },
    });

    assert.equal(result.converged, true, 'a certifiable baseline with a clean tree must converge');
    assert.equal(result.selfRedOpen, undefined, 'a converged healthy pass must never carry selfRedOpen');
  } finally {
    rm(workingDir);
    rm(sessionDir);
  }
});

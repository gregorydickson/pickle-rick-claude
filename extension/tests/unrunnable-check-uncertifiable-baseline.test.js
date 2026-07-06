// @tier: integration
// R-SZGB-D-A: proves an unrunnable check (missing npm 'typecheck' script) marks the
// per-iteration baseline uncertifiable (project_type: null) and routes through the EXISTING
// R-SZGB-B/C uncertifiable-baseline certification-refusal path — no new gate, flag, state
// field, or activity event. Modeled directly on uncertifiable-baseline-attrition-latch.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

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
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'szgbd-data-'));
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

// R-SZGB-D-A fixture: a real npm project whose 'typecheck' script is ABSENT (so
// `npm run typecheck` fails with `npm error Missing script`), while 'lint' and 'test' both
// run and exit 0 — proving the uncertifiable classification is driven by the missing
// typecheck check specifically, not by a wholesale unrunnable project.
function writeMissingTypecheckScriptFixtureRepo(dir) {
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'szgbd-gate-fixture',
      private: true,
      scripts: {
        lint: 'node -e "process.exit(0)"',
        test: 'node -e "process.exit(0)"',
      },
    }, null, 2),
  );
}

const BASE_OPTS = {
  regressionWarningThreshold: 5,
  backend: 'claude',
  remediatorTimeoutS: 600,
  log: () => {},
};

// ===========================================================================
// AC-SZGBD-01 (headline): a missing npm typecheck script marks the baseline
// uncertifiable; the certification consumer refuses to certify convergence even on a
// clean/no-new-regression iteration.
// ===========================================================================

test('AC-SZGBD-01: a missing npm typecheck script marks the baseline uncertifiable and refuses to certify a clean iteration', async () => {
  const workingDir = makeGitRepo('szgbd-uncert-repo-');
  const sessionDir = mkTmp('szgbd-uncert-session-');

  try {
    writeMissingTypecheckScriptFixtureRepo(workingDir);
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

    const preIterSha = headSha(workingDir);
    fs.writeFileSync(
      path.join(sessionDir, 'anatomy-park.json'),
      JSON.stringify({ converged: true, reason: 'clean passes done' }),
    );
    fs.writeFileSync(path.join(workingDir, 'harmless.txt'), 'no regression here\n');
    commitAll(workingDir, 'harmless clean commit under an unrunnable typecheck check');

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

    assert.equal(result.converged, false, 'an uncertifiable baseline must never certify convergence, even net-zero replay');
    assert.equal(
      result.selfRedOpen,
      true,
      'the uncertifiable-baseline defer must arm the existing R-ORSR-6 no-attrition latch (selfRedOpen)',
    );
  } finally {
    rm(workingDir);
    rm(sessionDir);
  }
});

// ===========================================================================
// AC-SZGBD-02 (tsc-RED no longer escapes): with the unrunnable typecheck check, a
// tsc-RED change does NOT converge across a multi-iteration drive — reproduces the live
// R-SZGB escape at the per-check granularity this ticket closes.
// ===========================================================================

test('AC-SZGBD-02: a tsc-RED change under an unrunnable typecheck check never force-converges across 3 iterations', async () => {
  const workingDir = makeGitRepo('szgbd-red-repo-');
  const sessionDir = mkTmp('szgbd-red-session-');
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({ backend: 'claude', active: true }));

  try {
    writeMissingTypecheckScriptFixtureRepo(workingDir);
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
      commitAll(workingDir, `introduce tsc-RED change ${i} under an unrunnable typecheck check`);
      ctx.iteration = i + 1;
      const result = await handleIterationOutcome(state, { raw: '', score: null }, ctx, outcome);
      exitReasons.push(result);
      ctx.preIterSha = ctx.postIterSha;
    }

    assert.deepEqual(
      exitReasons,
      ['continue', 'continue', 'continue'],
      `an unrunnable typecheck check must never let a tsc-RED tree force-converge, got: ${JSON.stringify(exitReasons)}`,
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
// AC-SZGBD-05 (no new surface): the fail-closed decision routes through the EXISTING
// R-SZGB-B uncertifiable-baseline consumer via a bare log line — no new activity event,
// no new GateBaselineFile field.
// ===========================================================================

test('AC-SZGBD-05: no new activity event literal and no new GateBaselineFile field were added', () => {
  const compiledGate = fs.readFileSync(path.join(repoRoot, 'extension', 'services', 'convergence-gate.js'), 'utf-8');
  const typesSrc = fs.readFileSync(path.join(repoRoot, 'extension', 'src', 'types', 'index.ts'), 'utf-8');

  const logLineIdx = compiledGate.indexOf('baseline uncertifiable, cannot certify');
  assert.ok(logLineIdx !== -1, 'compiled gate must contain the uncertifiable-baseline log line');

  const precedingSlice = compiledGate.slice(Math.max(0, logLineIdx - 200), logLineIdx);
  assert.ok(
    /console\.error/.test(precedingSlice),
    'the uncertifiable-baseline log line must be emitted via a bare console.error, not emit(...)/logActivity(...)',
  );
  assert.ok(
    !/\bemit\(/.test(precedingSlice) && !/logActivity\(/.test(precedingSlice),
    'the uncertifiable-baseline log line must NOT be wrapped in an emit(...) or logActivity(...) call (no new activity event)',
  );

  const gateBaselineFileMatch = typesSrc.match(/export interface GateBaselineFile \{[\s\S]*?\n\}/);
  assert.ok(gateBaselineFileMatch, 'GateBaselineFile interface must exist in src/types/index.ts');
  const gateBaselineFileBody = gateBaselineFileMatch[0];
  assert.equal(
    gateBaselineFileBody,
    [
      'export interface GateBaselineFile {',
      '  schema_version: 1;',
      '  captured_at: string;',
      '  captured_iteration?: number;',
      '  working_dir: string;',
      "  project_type: 'pnpm' | 'npm' | 'yarn' | 'cargo' | 'go' | 'bun' | null;",
      "  checks: ('typecheck' | 'lint' | 'tests')[];",
      '  failures: GateFailure[];',
      '}',
    ].join('\n'),
    'GateBaselineFile must retain exactly its pre-existing field set — no new field added',
  );
});

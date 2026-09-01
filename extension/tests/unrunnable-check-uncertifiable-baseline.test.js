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

const { runGate } = await import(path.resolve(__dirname, '../services/convergence-gate.js'));

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
    assert.deepEqual(
      baseline.check_status,
      { typecheck: 'failed', lint: 'ran', tests: 'ran' },
      'check_status must be populated from what ACTUALLY ran (typecheck spawned but classified unrunnable => failed; ' +
        'lint/tests spawned and completed => ran), never copied wholesale from the requested opts.checks set',
    );

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
// AC-SZGBD-05 (no new ACTIVITY EVENT surface, but AC-5' adds the per-check status field):
// the fail-closed decision still routes through the EXISTING R-SZGB-B uncertifiable-baseline
// consumer via a bare log line — no new activity event. GateBaselineFile DOES gain the
// `check_status` field (AC-5' — ticket a38de7dc): a skipped run must be distinguishable from
// a clean measurement, which the pre-existing `failures: []`-only shape could not express.
// ===========================================================================

test('AC-SZGBD-05: no new activity event literal was added; GateBaselineFile gains exactly the AC-5\' check_status field', () => {
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
      "  check_status?: Partial<Record<'typecheck' | 'lint' | 'tests', 'ran' | 'skipped' | 'failed'>>;",
      '}',
    ].join('\n'),
    'GateBaselineFile must retain its pre-existing field set plus exactly the AC-5\' check_status field (schema_version stays the literal 1)',
  );
});

// ===========================================================================
// AC-5' backward compatibility: a baseline written before this field existed must still
// load without throwing BASELINE_CORRUPT.
// ===========================================================================

test("AC-5': a baseline file written without check_status still loads (backward compat, no BASELINE_CORRUPT)", async () => {
  const workingDir = makeGitRepo('szgbd-legacy-baseline-');
  try {
    fs.writeFileSync(
      path.join(workingDir, 'package.json'),
      JSON.stringify({
        name: 'legacy-baseline-fixture',
        private: true,
        scripts: { lint: 'node -e "process.exit(0)"' },
      }, null, 2),
    );
    commitAll(workingDir, 'initial clean state');

    const baselinePath = path.join(workingDir, 'gate', 'baseline.json');
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    // A baseline written before AC-5' (ticket a38de7dc) carries no `check_status` key at all.
    const legacyBaseline = {
      schema_version: 1,
      captured_at: new Date().toISOString(),
      working_dir: workingDir,
      project_type: 'npm',
      checks: ['lint'],
      failures: [],
    };
    assert.equal('check_status' in legacyBaseline, false, 'fixture precondition: no check_status key');
    fs.writeFileSync(baselinePath, JSON.stringify(legacyBaseline));

    const result = await runGate({
      workingDir,
      mode: 'baseline',
      scope: 'full',
      checks: ['lint'],
      baselinePath,
    });

    assert.equal(
      result.status,
      'green',
      'a legacy baseline missing check_status must load and subtract cleanly, not throw BASELINE_CORRUPT',
    );
    assert.equal(
      result.baseline_used,
      true,
      'the legacy baseline on disk must be the one consulted, proving loadBaselineFile succeeded on the field-less shape',
    );
  } finally {
    rm(workingDir);
  }
});

// ===========================================================================
// AP-EXT-ITER6-01: the TIMEOUT arm of the same fact R-SZGB-D closed for the unrunnable arm.
//
// A check that timed out inspected NOTHING, exactly like a check whose command was missing.
// Pre-fix, `runGate` derived the uncertifiable flag from `unrunnableCheck !== null`, which
// `runGateCheck`'s GateTimeoutError branch never sets — so the baseline persisted CERTIFIABLE
// with `<check>::<timeout>::GATE_CHECK_TIMEOUT` recorded as an ordinary pre-existing failure,
// and every later iteration that timed out the same way had that fingerprint subtracted and
// reported green over a check that never once ran.
//
// Drives the REAL data flow end-to-end: a real npm project, the real `runGate` spawn, the real
// persisted `gate/baseline.json`, and the real `isBaselineUncertifiable` consumer reached
// through `handleWorkerManagedIteration` — never the predicate in isolation.
// ===========================================================================

// A real npm project whose `typecheck` script outlives the per-check timeout the gate is given,
// while `lint`/`test` complete immediately — so the classification is driven by the timed-out
// check specifically, not by a wholesale unrunnable project. The sleep is comfortably longer
// than the injected timeout and comfortably shorter than the 120s production default, so the
// SAME fixture times out under the small budget and runs clean under the real one.
const TIMEOUT_FIXTURE_SLEEP_MS = 2000;
const TIMEOUT_FIXTURE_BUDGET_MS = 250;

function writeSlowTypecheckFixtureRepo(dir) {
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'apext6-gate-fixture',
      private: true,
      scripts: {
        typecheck: `node -e "setTimeout(() => process.exit(0), ${TIMEOUT_FIXTURE_SLEEP_MS})"`,
        lint: 'node -e "process.exit(0)"',
        test: 'node -e "process.exit(0)"',
      },
    }, null, 2),
  );
}

async function captureBaselineWithTypecheckBudget(workingDir, sessionDir, perCheckTypecheckMs) {
  return runGate({
    workingDir,
    mode: 'baseline',
    scope: 'full',
    checks: ['typecheck', 'lint', 'tests'],
    baselinePath: path.join(sessionDir, 'gate', 'baseline.json'),
    baselineIteration: 1,
    _timeouts: { perCheck: { typecheck: perCheckTypecheckMs }, total: 120_000 },
  });
}

function readBaseline(sessionDir) {
  return JSON.parse(fs.readFileSync(path.join(sessionDir, 'gate', 'baseline.json'), 'utf-8'));
}

test('AP-EXT-ITER6-01: a TIMED-OUT check marks the baseline uncertifiable and refuses to certify a clean iteration', async () => {
  const workingDir = makeGitRepo('apext6-timeout-repo-');
  const sessionDir = mkTmp('apext6-timeout-session-');

  try {
    writeSlowTypecheckFixtureRepo(workingDir);
    commitAll(workingDir, 'initial clean state');

    await captureBaselineWithTypecheckBudget(workingDir, sessionDir, TIMEOUT_FIXTURE_BUDGET_MS);

    const baseline = readBaseline(sessionDir);
    assert.equal(
      baseline.check_status.typecheck,
      'failed',
      'fixture precondition: the injected per-check budget must actually fire the typecheck timeout',
    );
    assert.ok(
      baseline.failures.some((f) => f.check === 'typecheck' && f.ruleOrCode === 'GATE_CHECK_TIMEOUT'),
      `fixture precondition: the timeout must be recorded as a failure, got ${JSON.stringify(baseline.failures)}`,
    );
    assert.equal(
      baseline.project_type,
      null,
      'a timed-out check inspected NOTHING, so the baseline must carry the uncertifiable signal — ' +
        'the same project_type: null the unrunnable arm already sets',
    );

    const preIterSha = headSha(workingDir);
    fs.writeFileSync(
      path.join(sessionDir, 'anatomy-park.json'),
      JSON.stringify({ converged: true, reason: 'clean passes done' }),
    );
    fs.writeFileSync(path.join(workingDir, 'harmless.txt'), 'no regression here\n');
    commitAll(workingDir, 'harmless clean commit under a timed-out typecheck check');

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

    assert.equal(
      result.converged,
      false,
      'a baseline whose typecheck never ran must never certify convergence, even on a net-zero replay',
    );
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

// Over-rejection control: the SAME fixture under a realistic per-check budget completes, so the
// widened predicate must leave an ordinary measured run fully certifiable. Without this, a fix
// that marked every baseline uncertifiable would pass the headline case above.
test('AP-EXT-ITER6-01 control: the same fixture under a realistic budget stays CERTIFIABLE', async () => {
  const workingDir = makeGitRepo('apext6-control-repo-');
  const sessionDir = mkTmp('apext6-control-session-');

  try {
    writeSlowTypecheckFixtureRepo(workingDir);
    commitAll(workingDir, 'initial clean state');

    await captureBaselineWithTypecheckBudget(workingDir, sessionDir, 60_000);

    const baseline = readBaseline(sessionDir);
    assert.equal(baseline.check_status.typecheck, 'ran', 'control precondition: typecheck must complete under a realistic budget');
    assert.equal(
      baseline.project_type,
      'npm',
      'a check that RAN is a measurement — widening the uncertifiable signal must not deem an ordinary run uncertifiable',
    );
    assert.deepEqual(
      baseline.failures,
      [],
      'the control fixture is clean, so no failure (least of all a phantom timeout) may be baselined',
    );
  } finally {
    rm(workingDir);
    rm(sessionDir);
  }
});

// `'skipped'` must stay OUT of the predicate. This repo's own `test` script is refused by
// canRunTestScript, so folding 'skipped' in would defer every anatomy-park iteration — a new
// abort condition rather than a closed hole.
test('AP-EXT-ITER6-01: a SKIPPED check is not an unmeasured one — a refused test script stays certifiable', async () => {
  const workingDir = makeGitRepo('apext6-skipped-repo-');
  const sessionDir = mkTmp('apext6-skipped-session-');

  try {
    fs.writeFileSync(
      path.join(workingDir, 'package.json'),
      JSON.stringify({
        name: 'apext6-skipped-fixture',
        private: true,
        scripts: {
          typecheck: 'node -e "process.exit(0)"',
          lint: 'node -e "process.exit(0)"',
          // `integration` is in UNSAFE_TEST_SCRIPT_REGEX, so canRunTestScript refuses to spawn it.
          test: 'node -e "process.exit(0)" --integration',
        },
      }, null, 2),
    );
    commitAll(workingDir, 'initial clean state');

    await captureBaselineWithTypecheckBudget(workingDir, sessionDir, 60_000);

    const baseline = readBaseline(sessionDir);
    assert.equal(baseline.check_status.tests, 'skipped', 'fixture precondition: the unsafe test script must be refused, not run');
    assert.equal(
      baseline.project_type,
      'npm',
      'a refused test script is a DECISION, not a failed measurement — it must not make the baseline uncertifiable',
    );
  } finally {
    rm(workingDir);
    rm(sessionDir);
  }
});

// ===========================================================================
// AP-EXT-ITER127-01: the same fact ACROSS TARGET DIRS.
//
// AP-EXT-ITER6-01 pinned the three EVENTS that mean "this check inspected nothing"
// (unrunnable / per-check timeout / cumulative cutoff) in a single-dir project. What was
// never fixtured is the COMPOSITION: `collectGateFailures` loops over `targetDirs` and
// merges each dir's verdict for the SAME check through `escalateCheckStatus`, whose
// escalate-only rank is the ONE thing stopping a sibling package's clean `'ran'` from
// erasing a package whose check could not run at all.
//
// Measured on the shipped compiled module: with the merge reduced to `return next`, this
// exact fixture persists `project_type: "npm"` and `check_status: {typecheck: "ran"}` —
// a CERTIFIABLE baseline claiming a typecheck ran in a package that has no typecheck
// script — while the operator-facing "baseline uncertifiable" line still prints, because
// that log rides the separate `unrunnableCheck` field. The whole 160-case convergence-gate
// suite stays green through it.
//
// The missing-script package sits in the MIDDLE of the workspace so the pin is order-
// INDEPENDENT: under a last-write-wins merge the surviving status is a clean sibling's
// `'ran'` whichever direction `targetDirs` is walked.
// ===========================================================================

const WORKSPACE_TYPECHECK_PACKAGES = ['a', 'b', 'c'];
const WORKSPACE_MISSING_TYPECHECK_PACKAGE = 'b';

// Each package's `typecheck` appends its own name to a marker file, so the test can prove
// the sibling checks REALLY RAN. Without that proof the case could pass because the gate
// never visited them — the merge would then never be exercised and the pin would cover
// nothing.
function writeWorkspaceTypecheckFixtureRepo(dir, markerPath, missingPackage) {
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'apext127-workspace-root',
      private: true,
      workspaces: ['packages/*'],
    }, null, 2),
  );
  fs.writeFileSync(markerPath, '');
  for (const name of WORKSPACE_TYPECHECK_PACKAGES) {
    const pkgDir = path.join(dir, 'packages', name);
    fs.mkdirSync(pkgDir, { recursive: true });
    const scripts = {};
    if (name !== missingPackage) {
      scripts.typecheck = `node -e "require('fs').appendFileSync('${markerPath}', '${name}\\n')"`;
    }
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, scripts }, null, 2));
  }
}

function readMarkedPackages(markerPath) {
  return fs.readFileSync(markerPath, 'utf-8').split('\n').filter(Boolean).sort();
}

async function captureWorkspaceTypecheckBaseline(workingDir, sessionDir) {
  return runGate({
    workingDir,
    mode: 'baseline',
    scope: 'full',
    checks: ['typecheck'],
    baselinePath: path.join(sessionDir, 'gate', 'baseline.json'),
    baselineIteration: 1,
    _timeouts: { perCheck: { typecheck: 60_000 }, total: 120_000 },
  });
}

test('AP-EXT-ITER127-01: a sibling package running the check clean must not erase a package whose check could not run', async () => {
  const workingDir = makeGitRepo('apext127-workspace-repo-');
  const sessionDir = mkTmp('apext127-workspace-session-');

  try {
    const markerPath = path.join(sessionDir, 'typecheck-marker.txt');
    writeWorkspaceTypecheckFixtureRepo(workingDir, markerPath, WORKSPACE_MISSING_TYPECHECK_PACKAGE);
    commitAll(workingDir, 'initial clean state');

    await captureWorkspaceTypecheckBaseline(workingDir, sessionDir);

    assert.deepEqual(
      readMarkedPackages(markerPath),
      WORKSPACE_TYPECHECK_PACKAGES.filter((n) => n !== WORKSPACE_MISSING_TYPECHECK_PACKAGE),
      'fixture precondition: both sibling packages must really RUN their typecheck, so the ' +
        'per-dir merge is exercised with a clean measurement on either side of the missing one',
    );

    const baseline = readBaseline(sessionDir);
    assert.equal(
      baseline.check_status.typecheck,
      'failed',
      'the merge across target dirs is escalate-only: a clean sibling package is not evidence ' +
        'that the check ran in the package that has no such script',
    );
    assert.equal(
      baseline.project_type,
      null,
      'a check that inspected NOTHING in one workspace package leaves the whole baseline ' +
        'uncertifiable — otherwise every later iteration subtracts against a baseline that ' +
        'claims a measurement it never made',
    );
  } finally {
    rm(workingDir);
    rm(sessionDir);
  }
});

// Over-rejection control: the SAME workspace with every package's typecheck present must stay
// fully certifiable. Without this, a "fix" that uncertified every multi-package baseline would
// satisfy the headline case above.
test('AP-EXT-ITER127-01 control: a workspace whose packages all run the check stays CERTIFIABLE', async () => {
  const workingDir = makeGitRepo('apext127-control-repo-');
  const sessionDir = mkTmp('apext127-control-session-');

  try {
    const markerPath = path.join(sessionDir, 'typecheck-marker.txt');
    writeWorkspaceTypecheckFixtureRepo(workingDir, markerPath, null);
    commitAll(workingDir, 'initial clean state');

    await captureWorkspaceTypecheckBaseline(workingDir, sessionDir);

    assert.deepEqual(
      readMarkedPackages(markerPath),
      [...WORKSPACE_TYPECHECK_PACKAGES].sort(),
      'control precondition: every package must run its typecheck',
    );

    const baseline = readBaseline(sessionDir);
    assert.equal(baseline.check_status.typecheck, 'ran', 'every package measured, so the check RAN');
    assert.equal(
      baseline.project_type,
      'npm',
      'a workspace in which every package measured the check is an ordinary measured run — ' +
        'the escalate-only merge must not deem it uncertifiable',
    );
    assert.deepEqual(baseline.failures, [], 'the control workspace is clean, so nothing may be baselined');
  } finally {
    rm(workingDir);
    rm(sessionDir);
  }
});

// @tier: fast
// R-SZGB-D-A: isUnrunnableCheckResult classifies a check whose COMMAND never ran (missing
// npm/pnpm/yarn script, ENOENT, exit 127) as distinct from a check that ran and found real
// failures. Baseline-mode integration proves the fail-closed wiring reuses the R-SZGB-B
// `project_type: null` uncertifiable-baseline signal (no new field, no new consumer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { baselineUnmeasuredChecks, buildFailures, isUnrunnableCheckResult, runBaselineAwareGate, runGate } from '../../services/convergence-gate.js';

// ---------------------------------------------------------------------------
// AC-SZGBD-03 regression guard: isUnrunnableCheckResult unit cases.
// ---------------------------------------------------------------------------

test('isUnrunnableCheckResult: exit 0 is never unrunnable, even with junk text', () => {
  assert.equal(isUnrunnableCheckResult({ stdout: 'ENOENT command not found', stderr: '', exitCode: 0 }), false);
});

test('isUnrunnableCheckResult: real npm "Missing script" output is unrunnable', () => {
  const stderr = [
    'npm error Missing script: "typecheck"',
    'npm error',
    'npm error To see a list of scripts, run:',
    'npm error   npm run',
  ].join('\n');
  assert.equal(isUnrunnableCheckResult({ stdout: '', stderr, exitCode: 1 }), true);
});

test('isUnrunnableCheckResult: legacy npm ERR! missing script wording is unrunnable', () => {
  assert.equal(isUnrunnableCheckResult({ stdout: '', stderr: 'npm ERR! missing script: typecheck', exitCode: 1 }), true);
});

test('isUnrunnableCheckResult: pnpm ERR_PNPM_NO_SCRIPT is unrunnable', () => {
  const stderr = ' ERR_PNPM_NO_SCRIPT  Missing script: typecheck\n\nCommand "typecheck" not found';
  assert.equal(isUnrunnableCheckResult({ stdout: '', stderr, exitCode: 1 }), true);
});

test('isUnrunnableCheckResult: yarn missing-script wording is unrunnable', () => {
  assert.equal(isUnrunnableCheckResult({ stdout: '', stderr: 'error Command "typecheck" not found.', exitCode: 1 }), true);
});

test('isUnrunnableCheckResult: exit 127 with empty output is unrunnable', () => {
  assert.equal(isUnrunnableCheckResult({ stdout: '', stderr: '', exitCode: 127 }), true);
});

test('isUnrunnableCheckResult: ENOENT text is unrunnable', () => {
  assert.equal(isUnrunnableCheckResult({ stdout: '', stderr: 'spawn tsc ENOENT', exitCode: 1 }), true);
});

test('isUnrunnableCheckResult: runtime "tool not installed" preflight message is unrunnable', () => {
  assert.equal(isUnrunnableCheckResult({ stdout: '', stderr: 'tool not installed: tsc', exitCode: 1 }), true);
});

test('isUnrunnableCheckResult: a genuine tsc TSxxxx failure is NOT unrunnable', () => {
  const stdout = 'src/foo.ts(3,5): error TS2322: Type \'string\' is not assignable to type \'number\'.\n';
  assert.equal(isUnrunnableCheckResult({ stdout, stderr: '', exitCode: 2 }), false);
});

test('isUnrunnableCheckResult: a genuine eslint violation is NOT unrunnable', () => {
  const stdout = [
    '/repo/src/foo.js',
    "  1:1  error  'foo' is defined but never used  no-unused-vars",
    '',
    '✖ 1 problem (1 error, 0 warnings)',
    '',
  ].join('\n');
  assert.equal(isUnrunnableCheckResult({ stdout, stderr: '', exitCode: 1 }), false);
});

test('isUnrunnableCheckResult: a genuine failing test run is NOT unrunnable', () => {
  const stdout = 'not ok 1 - should add two numbers\n# fail 1\n';
  assert.equal(isUnrunnableCheckResult({ stdout, stderr: '', exitCode: 1 }), false);
});

// ---------------------------------------------------------------------------
// AC-SZGBD-01 / AC-SZGBD-04 fixture preconditions at the gate-service level.
// ---------------------------------------------------------------------------

function mkFixtureDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// The typecheck script EXISTS but its command is an uninstalled binary (`command not found`). An
// ABSENT script is never spawned by the gate and records `'skipped'`, so it cannot trigger this.
test('runGate baseline: an unrunnable npm typecheck command marks the persisted baseline uncertifiable (project_type: null)', async () => {
  const workingDir = mkFixtureDir('cg-szgbd-unrunnable-command-');
  try {
    fs.writeFileSync(
      path.join(workingDir, 'package.json'),
      JSON.stringify({
        name: 'szgbd-fixture',
        private: true,
        scripts: { typecheck: 'szgbd-uninstalled-binary-xyz', lint: 'node -e "process.exit(0)"' },
      }, null, 2),
    );
    const baselinePath = path.join(workingDir, 'gate', 'baseline.json');

    const result = await runGate({
      workingDir,
      mode: 'baseline',
      scope: 'full',
      checks: ['typecheck'],
      baselinePath,
    });

    assert.equal(result.status, 'green', 'baseline capture always reports green at capture time');
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    assert.equal(
      baseline.project_type,
      null,
      'an unrunnable check must mark the persisted baseline uncertifiable via project_type: null',
    );
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('runGate baseline: an all-runnable-and-clean npm project still certifies (project_type unaffected)', async () => {
  const workingDir = mkFixtureDir('cg-szgbd-healthy-');
  try {
    fs.writeFileSync(
      path.join(workingDir, 'package.json'),
      JSON.stringify({ name: 'szgbd-healthy-fixture', private: true, scripts: { typecheck: 'node -e "process.exit(0)"' } }, null, 2),
    );
    const baselinePath = path.join(workingDir, 'gate', 'baseline.json');

    const result = await runGate({
      workingDir,
      mode: 'baseline',
      scope: 'full',
      checks: ['typecheck'],
      baselinePath,
    });

    assert.equal(result.status, 'green');
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    assert.equal(
      baseline.project_type,
      'npm',
      'a fully runnable clean project must keep its real project_type — no fail-closed override',
    );
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('runGate baseline: a genuine typecheck failure (real TSxxxx-shaped output) is NOT marked uncertifiable', async () => {
  const workingDir = mkFixtureDir('cg-szgbd-real-failure-');
  try {
    fs.mkdirSync(path.join(workingDir, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(workingDir, 'package.json'),
      JSON.stringify({
        name: 'szgbd-real-failure-fixture',
        private: true,
        scripts: { typecheck: 'node scripts/typecheck.cjs' },
      }, null, 2),
    );
    fs.writeFileSync(
      path.join(workingDir, 'scripts', 'typecheck.cjs'),
      "console.log(\"src/foo.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\");\nprocess.exit(2);\n",
    );
    const baselinePath = path.join(workingDir, 'gate', 'baseline.json');

    const result = await runGate({
      workingDir,
      mode: 'baseline',
      scope: 'full',
      checks: ['typecheck'],
      baselinePath,
    });

    assert.equal(result.status, 'green', 'baseline capture always reports green at capture time');
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    assert.equal(
      baseline.project_type,
      'npm',
      'a real tsc failure must be captured as an ordinary subtractable baseline failure, not uncertifiable',
    );
    assert.equal(baseline.failures.length, 1, 'the real tsc failure must still be captured in the baseline');
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER318-01: a check with NO exit status.
//
// `runCheckSubtree`'s `close` handler receives `(code, signal)`, and an externally killed
// check delivers `code === null` — `error` never fires, so the AP-EXT-ITER316-01 exec-failure
// path cannot see this at all. Collapsing that null onto `1` made a check that never completed
// byte-identical to one that ran and exited 1. These two cases pin the halves that collapse
// destroyed: the CLASSIFICATION (it did not run) and the FINGERPRINT (baseline subtraction must
// not remove it as an ordinary exit-1 failure).
//
// The over-trigger controls live above: the three `NOT unrunnable` cases (real tsc failure,
// real eslint violation, real failing test run) all red under a blanket always-unrunnable
// mutant, so neither case below can pass vacuously.
// ---------------------------------------------------------------------------

test('AP-EXT-ITER318-01: a result carrying NO exit status is unrunnable', () => {
  assert.equal(
    isUnrunnableCheckResult({ stdout: 'ran 400 of 900 tests...', stderr: '', exitCode: null }),
    true,
    'no exit status means the check never completed — there is no measurement to trust, however much output it managed to print first',
  );
});

test('AP-EXT-ITER318-01: a no-exit-status failure does not borrow a real exit code\'s fingerprint', () => {
  const [killed] = buildFailures({ stdout: '', stderr: '', exitCode: null }, 'typecheck', '/pkg');
  const [real] = buildFailures({ stdout: '', stderr: '', exitCode: 1 }, 'typecheck', '/pkg');

  assert.equal(killed.ruleOrCode, 'no-exit-status');
  assert.match(killed.message, /no exit status/);
  assert.notEqual(
    killed.ruleOrCode, real.ruleOrCode,
    'sharing the generic exit-N fingerprint is what let baseline subtraction remove the phantom on every later pass',
  );
  assert.notEqual(killed.message, real.message);
  // The arm the null check sits beside is unmoved: exit 0 is still no failure at all.
  assert.deepEqual(buildFailures({ stdout: '', stderr: '', exitCode: 0 }, 'typecheck', '/pkg'), []);
});

// ---------------------------------------------------------------------------
// B-ATTRIB-G G1: a check the BASELINE did not measure is unmeasured, never red.
// ---------------------------------------------------------------------------

function writeBaseline(checkStatus) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g1-baseline-'));
  const baselinePath = path.join(dir, 'baseline.json');
  fs.writeFileSync(baselinePath, JSON.stringify({
    schema_version: 1, captured_at: new Date().toISOString(), working_dir: dir,
    project_type: 'npm', checks: ['typecheck', 'lint'], failures: [], check_status: checkStatus,
  }));
  return { dir, baselinePath };
}

const redTypecheckGate = async () => ({
  status: 'red',
  failures: [{ check: 'typecheck', file: '/x/a.ts', line: 1, ruleOrCode: 'TS2322', message: 'm', severity: 'error', occurrence_index: 0 }],
  baseline_used: true, allowed_paths_used: false, elapsed_ms: 0, total_raw_failure_count: 1, new_failures_vs_baseline: 1,
  check_status: { typecheck: 'ran', lint: 'ran' },
});

test('G1: runBaselineAwareGate reports unmeasured (not red) for a typecheck the baseline failed to measure', async () => {
  const { dir, baselinePath } = writeBaseline({ typecheck: 'failed', lint: 'ran' });
  try {
    const out = await runBaselineAwareGate({ workingDir: dir, baselinePath, checks: ['typecheck', 'lint'], runGateFn: redTypecheckGate });
    assert.deepEqual(out.verdict, { unmeasured: ['typecheck'] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('G1 negative control: a typecheck the baseline DID measure stays red', async () => {
  const { dir, baselinePath } = writeBaseline({ typecheck: 'ran', lint: 'ran' });
  try {
    const out = await runBaselineAwareGate({ workingDir: dir, baselinePath, checks: ['typecheck', 'lint'], runGateFn: redTypecheckGate });
    assert.equal(out.verdict, 'red');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('G1: baselineUnmeasuredChecks — legacy baseline (no check_status) and absent current yield none', () => {
  assert.deepEqual(baselineUnmeasuredChecks({ typecheck: 'ran' }, undefined, ['typecheck']), []);
  assert.deepEqual(baselineUnmeasuredChecks(undefined, { typecheck: 'failed' }, ['typecheck']), []);
  assert.deepEqual(baselineUnmeasuredChecks({ typecheck: 'ran', tests: 'skipped' }, { typecheck: 'skipped', tests: 'skipped' }, ['typecheck', 'tests']), ['typecheck']);
});

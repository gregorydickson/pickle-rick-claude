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
import { isUnrunnableCheckResult, runGate } from '../../services/convergence-gate.js';

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

test('runGate baseline: a missing npm typecheck script marks the persisted baseline uncertifiable (project_type: null)', async () => {
  const workingDir = mkFixtureDir('cg-szgbd-missing-script-');
  try {
    fs.writeFileSync(
      path.join(workingDir, 'package.json'),
      JSON.stringify({ name: 'szgbd-fixture', private: true, scripts: { lint: 'node -e "process.exit(0)"' } }, null, 2),
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

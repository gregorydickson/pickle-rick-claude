// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { runGate } from '../../services/convergence-gate.js';

async function withGitPnpmFixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-git-'));
  try {
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const MINIMAL_PKG = JSON.stringify({
  name: 'gate-test',
  version: '1.0.0',
  scripts: {
    typecheck: 'node -e "process.exit(0)"',
    lint: 'node -e "process.exit(0)"',
    test: 'node -e "process.exit(0)"',
  },
}, null, 2);

function makeLintScript(failures) {
  const output = [
    'src/foo.ts',
    ...failures.map(f => `  ${f.line}:1  error  ${f.message}  ${f.ruleOrCode}`),
  ].join('\n');
  const program = `console.error(${JSON.stringify(output)}); process.exit(1);`;
  return `node -e ${JSON.stringify(program)}`;
}

test('runGate: returns GateResult with all required fields', async () => {
  await withGitPnpmFixture(async dir => {
    fs.writeFileSync(path.join(dir, 'package.json'), MINIMAL_PKG);
    // pnpm-lock.yaml makes it a pnpm project; pnpm test runs scripts reliably
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\n');
    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });

    const result = await runGate({ workingDir: dir, mode: 'strict', scope: 'full', checks: ['tests'] });
    assert.ok(['green', 'red', 'green-with-known-flake-warnings'].includes(result.status), `invalid status: ${result.status}`);
    assert.ok(Array.isArray(result.failures));
    assert.equal(typeof result.baseline_used, 'boolean');
    assert.equal(typeof result.allowed_paths_used, 'boolean');
    assert.equal(typeof result.elapsed_ms, 'number');
    assert.ok(result.elapsed_ms >= 0);
    assert.equal(typeof result.total_raw_failure_count, 'number');
    assert.equal(typeof result.new_failures_vs_baseline, 'number');
    assert.equal(result.status, 'green');
    assert.equal(result.baseline_used, false);
    assert.equal(result.new_failures_vs_baseline, 0);
  });
});

test('runGate: scope=changed since=HEAD~1 processes changed files', async () => {
  await withGitPnpmFixture(async dir => {
    fs.writeFileSync(path.join(dir, 'package.json'), MINIMAL_PKG);
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\n');
    fs.writeFileSync(path.join(dir, 'file1.ts'), 'const x = 1;');
    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });

    fs.writeFileSync(path.join(dir, 'file2.ts'), 'const y = 2;');
    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "add file2"', { cwd: dir, stdio: 'pipe' });

    const result = await runGate({ workingDir: dir, mode: 'strict', scope: 'changed', since: 'HEAD~1', checks: ['tests'] });
    assert.equal(result.status, 'green');
    // `status` alone cannot tell a run from the no_changed_files skip (both are green).
    assert.equal(result.check_status?.tests, 'ran', 'a non-empty diff must measure the tests check');
  });
});

test('runGate: scope=changed with no prior commit (HEAD~1 invalid) returns green', async () => {
  await withGitPnpmFixture(async dir => {
    fs.writeFileSync(path.join(dir, 'package.json'), MINIMAL_PKG);
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\n');
    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });

    // HEAD~1 doesn't exist → git diff fails → no changed files → return early
    const result = await runGate({ workingDir: dir, mode: 'strict', scope: 'changed', since: 'HEAD~1', checks: ['tests'] });
    assert.equal(result.status, 'green');
    assert.equal(result.check_status?.tests, 'skipped', 'an unenumerable diff must declare a skip, not a run');
    assert.deepEqual(result.failures, []);
  });
});

test('runGate: unknown project type returns green with no failures', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-empty-'));
  try {
    const result = await runGate({ workingDir: dir, mode: 'strict', scope: 'full', checks: ['tests'] });
    assert.equal(result.status, 'green');
    assert.deepEqual(result.failures, []);
    assert.equal(result.total_raw_failure_count, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runGate: baseline mode fingerprints duplicate lint failures across capture and subtraction', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-baseline-'));
  try {
    const baselinePath = path.join(dir, 'gate', 'baseline.json');
    const pkg = {
      name: 'baseline-roundtrip-test',
      version: '1.0.0',
      scripts: {
        lint: makeLintScript([
          { line: 5, message: 'first duplicate', ruleOrCode: 'no-unused-vars' },
          { line: 20, message: 'second duplicate', ruleOrCode: 'no-unused-vars' },
        ]),
      },
    };
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'foo.ts'), 'export const foo = 1;\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));

    const captured = await runGate({
      workingDir: dir,
      mode: 'baseline',
      scope: 'full',
      checks: ['lint'],
      baselinePath,
    });

    assert.equal(captured.status, 'green');
    assert.equal(captured.baseline_used, false);
    assert.equal(captured.total_raw_failure_count, 2);
    assert.equal(captured.new_failures_vs_baseline, 0);

    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    assert.deepEqual(
      baseline.failures.map(f => ({ file: path.basename(f.file), line: f.line, occurrence_index: f.occurrence_index })),
      [
        { file: 'foo.ts', line: 5, occurrence_index: 0 },
        { file: 'foo.ts', line: 20, occurrence_index: 1 },
      ],
      'baseline capture must persist duplicate fingerprints with stable occurrence indices'
    );

    const replay = await runGate({
      workingDir: dir,
      mode: 'baseline',
      scope: 'full',
      checks: ['lint'],
      baselinePath,
    });

    assert.equal(replay.status, 'green');
    assert.equal(replay.baseline_used, true);
    assert.equal(replay.total_raw_failure_count, 2);
    assert.equal(replay.new_failures_vs_baseline, 0);
    assert.deepEqual(replay.failures, [], 'identical duplicate failures should subtract against baseline');

    pkg.scripts.lint = makeLintScript([
      { line: 5, message: 'first duplicate', ruleOrCode: 'no-unused-vars' },
      { line: 20, message: 'second duplicate', ruleOrCode: 'no-unused-vars' },
      { line: 30, message: 'third duplicate', ruleOrCode: 'no-unused-vars' },
    ]);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));

    const regression = await runGate({
      workingDir: dir,
      mode: 'baseline',
      scope: 'full',
      checks: ['lint'],
      baselinePath,
    });

    assert.equal(regression.status, 'red');
    assert.equal(regression.baseline_used, true);
    assert.equal(regression.total_raw_failure_count, 3);
    assert.equal(regression.new_failures_vs_baseline, 1);
    assert.deepEqual(
      regression.failures.map(f => ({
        file: path.basename(f.file),
        line: f.line,
        ruleOrCode: f.ruleOrCode,
        occurrence_index: f.occurrence_index,
      })),
      [
        {
          file: 'foo.ts',
          line: 30,
          ruleOrCode: 'no-unused-vars',
          occurrence_index: 2,
        },
      ],
      'a new duplicate must survive subtraction with the next occurrence index'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runGate: baseline mode promotes newer dead tmp baseline before subtraction', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-baseline-tmp-'));
  try {
    const baselinePath = path.join(dir, 'gate', 'baseline.json');
    const tmpBaselinePath = `${baselinePath}.tmp.99999999`;
    const pkg = {
      name: 'baseline-tmp-test',
      version: '1.0.0',
      scripts: {
        lint: makeLintScript([
          { line: 5, message: 'baseline failure', ruleOrCode: 'no-unused-vars' },
        ]),
      },
    };
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'foo.ts'), 'export const foo = 1;\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));

    const staleBaseline = {
      schema_version: 1,
      captured_at: '2026-04-01T00:00:00.000Z',
      working_dir: dir,
      project_type: 'npm',
      checks: ['lint'],
      failures: [],
    };
    const recoveredBaseline = {
      ...staleBaseline,
      captured_at: '2026-04-01T00:00:01.000Z',
      failures: [{
        check: 'lint',
        file: path.join(dir, 'src', 'foo.ts'),
        line: 5,
        ruleOrCode: 'no-unused-vars',
        message: 'baseline failure',
        severity: 'error',
        occurrence_index: 0,
      }],
    };
    fs.writeFileSync(baselinePath, JSON.stringify(staleBaseline, null, 2));
    fs.writeFileSync(tmpBaselinePath, JSON.stringify(recoveredBaseline, null, 2));
    const baseTime = new Date(Date.now() - 10_000);
    const tmpTime = new Date();
    fs.utimesSync(baselinePath, baseTime, baseTime);
    fs.utimesSync(tmpBaselinePath, tmpTime, tmpTime);

    const replay = await runGate({
      workingDir: dir,
      mode: 'baseline',
      scope: 'full',
      checks: ['lint'],
      baselinePath,
    });

    assert.equal(replay.status, 'green');
    assert.equal(replay.baseline_used, true);
    assert.equal(replay.total_raw_failure_count, 1);
    assert.equal(replay.new_failures_vs_baseline, 0);
    assert.deepEqual(replay.failures, [], 'recovered baseline failure should subtract current lint failure');
    assert.equal(fs.existsSync(tmpBaselinePath), false, 'dead tmp baseline should be consumed');
    const promoted = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    assert.equal(promoted.failures.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

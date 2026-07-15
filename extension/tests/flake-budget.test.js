// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkFlakeBudgetMain } from '../bin/check-flake-budget.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '../bin/check-flake-budget.js');

function makeTmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flake-budget-')));
}

function writeSyntheticTest(dir) {
  const stateFile = path.join(dir, 'state.txt');
  const testFile = path.join(dir, 'synthetic-flake.test.js');
  const source = `import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { test } from 'node:test';

const stateFile = process.env.FLAKE_STATE_FILE;
const failRuns = Number.parseInt(process.env.FLAKE_FAIL_RUNS ?? '0', 10);
let count = 0;

try {
  count = Number.parseInt(fs.readFileSync(stateFile, 'utf8'), 10);
} catch {}

count += 1;
fs.writeFileSync(stateFile, String(count));

test('synthetic flake budget probe', () => {
  assert.ok(count > failRuns, 'forced failure for run ' + count);
});
`;
  fs.writeFileSync(testFile, source);
  return { stateFile, testFile };
}

function runBudgetCheck({ runs, failBudget, failRuns }) {
  const dir = makeTmpDir();
  const { stateFile, testFile } = writeSyntheticTest(dir);
  return {
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
    result: spawnSync(
      process.execPath,
      [BIN, `--runs=${runs}`, `--fail-budget=${failBudget}`, '--timeout=30000'],
      {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
        timeout: 45000,
        env: {
          ...process.env,
          PICKLE_FLAKE_BUDGET_TEST_FILE: testFile,
          FLAKE_STATE_FILE: stateFile,
          FLAKE_FAIL_RUNS: String(failRuns),
        },
      },
    ),
  };
}

test('flake-budget passes when all runs pass', () => {
  const run = runBudgetCheck({ runs: 3, failBudget: 2, failRuns: 0 });
  try {
    assert.equal(run.result.status, 0, `stderr: ${run.result.stderr}`);
    assert.match(run.result.stdout, /flake-budget OK/);
  } finally {
    run.cleanup();
  }
});

test('flake-budget passes at the failure budget boundary', () => {
  const run = runBudgetCheck({ runs: 3, failBudget: 1, failRuns: 1 });
  try {
    assert.equal(run.result.status, 0, `stderr: ${run.result.stderr}`);
    assert.match(run.result.stdout, /failures=1 budget=1/);
  } finally {
    run.cleanup();
  }
});

test('flake-budget fails when failures exceed the budget', () => {
  const run = runBudgetCheck({ runs: 4, failBudget: 1, failRuns: 2 });
  try {
    assert.equal(run.result.status, 1, `stdout: ${run.result.stdout}\nstderr: ${run.result.stderr}`);
    assert.match(run.result.stderr, /FAIL_BUDGET_EXCEEDED/);
    assert.match(run.result.stderr, /failures=2 budget=1/);
  } finally {
    run.cleanup();
  }
});

// R-FBTN: the exceeded report must NAME the flaky test(s), not just count them.
test('flake-budget names the flaky test when the budget is exceeded', () => {
  const run = runBudgetCheck({ runs: 4, failBudget: 1, failRuns: 2 });
  try {
    assert.equal(run.result.status, 1, `stdout: ${run.result.stdout}\nstderr: ${run.result.stderr}`);
    assert.match(run.result.stderr, /FLAKY_TESTS/);
    assert.match(run.result.stderr, /synthetic flake budget probe/);
  } finally {
    run.cleanup();
  }
});

test('flake-budget child spawn passes a maxBuffer well above the 1MB spawnSync default', async () => {
  // Regression: the fast tier (~5000 tests at concurrency 8) emits >1MB of stdout
  // on CI; without an explicit maxBuffer spawnSync throws ENOBUFS and the run is
  // misreported as a harness failure (CI run 27578083942, test:fast:budget).
  const capturedOpts = [];
  const fakeSpawnSync = (_execPath, _args, opts) => {
    capturedOpts.push(opts);
    return { status: 0, stdout: 'ℹ tests 1\nok 1 - synthetic\n', stderr: '', error: null };
  };

  const code = await checkFlakeBudgetMain({
    argv: ['--runs=2', '--fail-budget=0', '--timeout=30000'],
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PICKLE_FLAKE_BUDGET_TEST_FILE: BIN },
    stdout: () => {},
    stderr: () => {},
    spawnSyncFn: fakeSpawnSync,
  });

  assert.equal(code, 0);
  assert.ok(capturedOpts.length >= 1, 'spawnSyncFn was invoked');
  for (const opts of capturedOpts) {
    assert.ok(
      typeof opts.maxBuffer === 'number' && opts.maxBuffer >= 64 * 1024 * 1024,
      `maxBuffer must be >= 64MB to hold the fast-suite stream, got: ${opts.maxBuffer}`,
    );
  }
});

test('flake-budget fails closed when the child test target is missing', () => {
  const dir = makeTmpDir();
  try {
    const missingTestFile = path.join(dir, 'missing.test.js');
    const result = spawnSync(
      process.execPath,
      [BIN, '--runs=1', '--fail-budget=1', '--timeout=30000'],
      {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
        timeout: 45000,
        env: {
          ...process.env,
          PICKLE_FLAKE_BUDGET_TEST_FILE: missingTestFile,
        },
      },
    );

    assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /Flake-budget target not found:/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

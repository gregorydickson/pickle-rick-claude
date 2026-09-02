// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkFlakeBudgetMain } from '../bin/check-flake-budget.js';
import { resolveSubprocessCap } from './__helpers__/subprocess-cap.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '../bin/check-flake-budget.js');
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CI_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const RELEASE_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'release.yml');

/** The per-run budget every call site below passes to the subject as `--timeout=`. */
const CHILD_RUN_TIMEOUT_SECONDS = 30;

/**
 * Hang guard for spawns of check-flake-budget.js, derived from the subject's own declared
 * per-run budget rather than the hand-picked 45_000ms literal it replaces (a margin nobody
 * chose and nothing re-checked when either number moved).
 *
 * The per-run budget, not the multi-run product, is the input: `--runs=4` would derive
 * 4 x 30s -> 360_000ms, above MAX_SUBPROCESS_CAP_MS, and would throw. Each run of the
 * synthetic probe finishes in well under a second; the inner `--timeout` only binds if a
 * run hangs, and one hung run is what this cap is here to bound.
 */
const CAP_FLAKE_BUDGET_CHILD = resolveSubprocessCap({
    subjectTimeoutSeconds: CHILD_RUN_TIMEOUT_SECONDS,
});

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
      [BIN, `--runs=${runs}`, `--fail-budget=${failBudget}`, `--timeout=${CHILD_RUN_TIMEOUT_SECONDS * 1000}`],
      {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
        timeout: CAP_FLAKE_BUDGET_CHILD,
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

// WS-D/AC-D1: the exceeded report must attribute failures per run, not as a bare union.
test('flake-budget names the flaky test per run when the budget is exceeded', () => {
  const run = runBudgetCheck({ runs: 4, failBudget: 1, failRuns: 2 });
  try {
    assert.equal(run.result.status, 1, `stdout: ${run.result.stdout}\nstderr: ${run.result.stderr}`);
    assert.match(run.result.stderr, /RUN \d+ FAILED:/);
    assert.match(run.result.stderr, /synthetic flake budget probe/);
    assert.match(run.result.stderr, /RUN \d+ LOG: /);
  } finally {
    run.cleanup();
  }
});

// AC-D1: loop over the three report blocks with a stubbed spawnSyncFn — per-run names
// are that run's own, not the union, and each block is present.
test('flake-budget report emits per-run blocks, not a cross-run union', async () => {
  const runOutputs = [
    { status: 1, stdout: '✖ test alpha (10ms)\nnot ok 1 - test alpha\n', stderr: '' },
    { status: 1, stdout: '✖ test beta (20ms)\nnot ok 1 - test beta\n', stderr: '' },
  ];
  let call = 0;
  const fakeSpawnSyncFn = () => runOutputs[call++];
  const lines = [];

  const code = await checkFlakeBudgetMain({
    argv: ['--runs=2', '--fail-budget=1', '--timeout=30000'],
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PICKLE_FLAKE_BUDGET_TEST_FILE: BIN },
    stdout: () => {},
    stderr: (msg) => lines.push(msg),
    spawnSyncFn: fakeSpawnSyncFn,
  });

  assert.equal(code, 1);
  const text = lines.join('\n');
  assert.match(text, /RUN 1 FAILED:/);
  assert.match(text, /test alpha/);
  assert.match(text, /RUN 2 FAILED:/);
  assert.match(text, /test beta/);

  const run1Block = lines.slice(
    lines.findIndex((l) => l.startsWith('RUN 1 FAILED:')),
    lines.findIndex((l) => l.startsWith('RUN 2 FAILED:')),
  ).join('\n');
  assert.doesNotMatch(run1Block, /test beta/, 'run 1 block must not carry run 2\'s failing test');

  assert.match(text, /RUN 1 LOG: /);
  assert.match(text, /RUN 2 LOG: /);
});

// AC-D2: a stub failing the SAME test in runs 1-3 marks it REPEATED ACROSS RUNS.
test('flake-budget marks a test that fails in three consecutive runs as repeated', async () => {
  const fakeSpawnSyncFn = () => ({
    status: 1,
    stdout: '✖ persistent flake (5ms)\nnot ok 1 - persistent flake\n',
    stderr: '',
  });
  const lines = [];

  const code = await checkFlakeBudgetMain({
    argv: ['--runs=3', '--fail-budget=2', '--timeout=30000'],
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PICKLE_FLAKE_BUDGET_TEST_FILE: BIN },
    stdout: () => {},
    stderr: (msg) => lines.push(msg),
    spawnSyncFn: fakeSpawnSyncFn,
  });

  assert.equal(code, 1);
  const text = lines.join('\n');
  assert.match(text, /REPEATED ACROSS RUNS:/);
  assert.match(text, /persistent flake/);
});

// AC-D2: three DISTINCT single-run failures must produce NO REPEATED ACROSS RUNS block.
test('flake-budget omits REPEATED ACROSS RUNS when every failure is distinct', async () => {
  const runOutputs = [
    { status: 1, stdout: '✖ test one (1ms)\nnot ok 1 - test one\n', stderr: '' },
    { status: 1, stdout: '✖ test two (2ms)\nnot ok 1 - test two\n', stderr: '' },
    { status: 1, stdout: '✖ test three (3ms)\nnot ok 1 - test three\n', stderr: '' },
  ];
  let call = 0;
  const fakeSpawnSyncFn = () => runOutputs[call++];
  const lines = [];

  const code = await checkFlakeBudgetMain({
    argv: ['--runs=3', '--fail-budget=2', '--timeout=30000'],
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PICKLE_FLAKE_BUDGET_TEST_FILE: BIN },
    stdout: () => {},
    stderr: (msg) => lines.push(msg),
    spawnSyncFn: fakeSpawnSyncFn,
  });

  assert.equal(code, 1);
  const text = lines.join('\n');
  assert.doesNotMatch(text, /REPEATED ACROSS RUNS:/);
});

// AC-D3/AC-D5: each per-run log records durations and result.status; null is distinguishable
// from a numeric exit code; every printed RUN <i> LOG: path exists on disk.
test('flake-budget per-run log records durations, status, and exists on disk; null status is distinct from numeric', async () => {
  const runOutputs = [
    { status: 1, stdout: '✖ timed test (43829.123ms)\nnot ok 1 - timed test\n', stderr: '' },
    { status: null, stdout: '✖ timed test (45044.5ms)\nnot ok 1 - timed test\n', stderr: '' },
  ];
  let call = 0;
  const fakeSpawnSyncFn = () => runOutputs[call++];
  const lines = [];

  const code = await checkFlakeBudgetMain({
    argv: ['--runs=2', '--fail-budget=1', '--timeout=30000'],
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PICKLE_FLAKE_BUDGET_TEST_FILE: BIN },
    stdout: () => {},
    stderr: (msg) => lines.push(msg),
    spawnSyncFn: fakeSpawnSyncFn,
  });

  assert.equal(code, 1);
  const logLines = lines.filter((l) => l.startsWith('RUN ') && l.includes(' LOG: '));
  assert.equal(logLines.length, 2);

  const logPaths = logLines.map((l) => l.split(' LOG: ')[1]);
  for (const logPath of logPaths) {
    assert.doesNotThrow(() => fs.statSync(logPath), `log path must exist on disk: ${logPath}`);
  }

  const run1Contents = fs.readFileSync(logPaths[0], 'utf8');
  assert.match(run1Contents, /status=1/);
  assert.match(run1Contents, /43829\.123ms/);

  const run2Contents = fs.readFileSync(logPaths[1], 'utf8');
  assert.match(run2Contents, /status=null/);
  assert.doesNotMatch(run2Contents, /status=1\b/);
  assert.match(run2Contents, /45044\.5ms/);
});

// 38ee7e86/F3: a run that fails WITHIN budget must still name the failing test, its
// duration, and its log path. Pre-fix the success path printed only the OK count line,
// so `flake-budget OK failures=1 budget=2` discarded every attribution it had already
// built — the exact state e7c9ada3 was left in, passing its budget with no way to say
// which test was marginal. Assert on STDOUT: within budget is not a failure, and
// FAIL_BUDGET_EXCEEDED on stderr must stay unambiguous.
test('flake-budget attributes a within-budget failure on stdout without failing the gate', async () => {
  const runOutputs = [
    { status: 1, stdout: '✖ marginal probe (88123.5ms)\nnot ok 1 - marginal probe\n', stderr: '' },
    { status: 0, stdout: 'ℹ tests 1\nok 1 - marginal probe\n', stderr: '' },
    { status: 0, stdout: 'ℹ tests 1\nok 1 - marginal probe\n', stderr: '' },
  ];
  let call = 0;
  const out = [];
  const err = [];

  const code = await checkFlakeBudgetMain({
    argv: ['--runs=3', '--fail-budget=2', '--timeout=30000'],
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PICKLE_FLAKE_BUDGET_TEST_FILE: BIN },
    stdout: (msg) => out.push(msg),
    stderr: (msg) => err.push(msg),
    spawnSyncFn: () => runOutputs[call++],
  });

  const stdout = out.join('\n');
  assert.equal(code, 0, `within budget must still exit 0, stderr: ${err.join('\n')}`);
  assert.match(stdout, /flake-budget OK failures=1 budget=2/);
  assert.match(stdout, /RUN 1 FAILED: status=1/, 'must attribute the failing run');
  assert.match(stdout, /marginal probe/, 'must name the failing test');
  assert.match(stdout, /duration=88123\.5ms/, 'must carry the duration that makes it marginal');

  const logLines = out.filter((l) => l.startsWith('RUN ') && l.includes(' LOG: '));
  assert.equal(logLines.length, 1, 'must print the log path for the failing run');
  const logPath = logLines[0].split(' LOG: ')[1];
  assert.doesNotThrow(() => fs.statSync(logPath), `log path must exist on disk: ${logPath}`);

  assert.doesNotMatch(err.join('\n'), /FAIL_BUDGET_EXCEEDED/, 'within budget is not a failure');
});

// R-FBTN-2/AC-M3: a non-budgetable failure (a harness crash — no ✖/not-ok/ℹ-tests markers)
// must still write the child's full stdout/stderr to a log path, and that path must be named
// in the thrown error. Pre-fix this branch threw immediately with only a first-line guess and
// wrote no log at all, discarding the only diagnostic evidence.
test('flake-budget writes the full child output to a log path on a non-budgetable failure, and names it in the error', async () => {
  const stdout = '▶ AC-6: Operator/terminal surface guard\nsome unrelated progress line\n';
  const stderr = 'FATAL ERROR: JavaScript heap out of memory\n';

  const err = [];
  const code = await checkFlakeBudgetMain({
    argv: ['--runs=1', '--fail-budget=0', '--timeout=30000'],
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PICKLE_FLAKE_BUDGET_TEST_FILE: BIN },
    stdout: () => {},
    stderr: (msg) => err.push(msg),
    spawnSyncFn: () => ({ status: 1, stdout, stderr, error: null }),
  });

  assert.equal(code, 1);
  const message = err.join('\n');
  assert.match(message, /Flake-budget child failed before reporting test results/);

  const pathMatch = message.match(/written to (\S+)/);
  assert.ok(pathMatch, `error message must name a log path, got: ${message}`);
  const logPath = pathMatch[1];
  assert.doesNotThrow(() => fs.statSync(logPath), `log path must exist on disk: ${logPath}`);

  const logContents = fs.readFileSync(logPath, 'utf8');
  assert.ok(logContents.includes(stdout.trim()), 'log must contain the full child stdout');
  assert.ok(logContents.includes(stderr.trim()), 'log must contain the full child stderr');
});

// R-FBTN-2/AC-M3b (mutation-verify): the error message must never be able to name a PASSING
// test as the cause. The old `summarizeHarnessFailure` heuristic reported "the first non-empty
// line of stderr+stdout" as if it were a diagnosis — but the first-printed file can be one that
// passes 16/16, while the real failure (e.g. an OOM) is elsewhere in the output. Construct that
// exact shape and assert the message accuses nothing but the log path.
test('flake-budget error message cannot name a passing test on a non-budgetable failure', async () => {
  const passingSuiteHeader = '▶ AC-6: Operator/terminal surface guard';
  const stdout = `${passingSuiteHeader}\n(this suite would pass 16/16 if the harness had not crashed first)\n`;
  const stderr = 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n';

  const err = [];
  const code = await checkFlakeBudgetMain({
    argv: ['--runs=1', '--fail-budget=0', '--timeout=30000'],
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PICKLE_FLAKE_BUDGET_TEST_FILE: BIN },
    stdout: () => {},
    stderr: (msg) => err.push(msg),
    spawnSyncFn: () => ({ status: 1, stdout, stderr, error: null }),
  });

  assert.equal(code, 1);
  const message = err.join('\n');
  assert.doesNotMatch(
    message,
    /AC-6: Operator\/terminal surface guard/,
    'the message must not accuse the passing suite whose header printed first',
  );
  assert.doesNotMatch(
    message,
    /heap limit|heap out of memory/,
    'the message must not quote a raw diagnostic line as the accusation either — only the log path',
  );
  assert.match(message, /written to \S+/, 'the message must still point at the full-output log');
});

// Negative control: a report that printed unconditionally would pass the case above.
test('flake-budget stays a one-liner when every run passes', async () => {
  const out = [];

  const code = await checkFlakeBudgetMain({
    argv: ['--runs=3', '--fail-budget=2', '--timeout=30000'],
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PICKLE_FLAKE_BUDGET_TEST_FILE: BIN },
    stdout: (msg) => out.push(msg),
    stderr: () => {},
    spawnSyncFn: () => ({ status: 0, stdout: 'ℹ tests 1\nok 1 - clean\n', stderr: '' }),
  });

  assert.equal(code, 0);
  assert.match(out.join('\n'), /flake-budget OK failures=0 budget=2/);
  assert.deepEqual(
    out.filter((l) => l.startsWith('RUN ')), [],
    'a clean run must emit no per-run attribution',
  );
});

// 94833eaf: `Number.parseInt` truncates at the first non-digit, so an unguarded
// parse read `--runs=1e3` as 1 — a thousand requested runs silently became one and
// the gate reported OK. The load-bearing assertion is that NO child is spawned:
// pre-fix the value parsed and the loop ran, so a message-only assertion would
// have passed over the defect.
const NON_INTEGER_FLAG_CASES = [
  { argv: ['--runs=1e3'], flag: '--runs' },
  { argv: ['--runs=5x'], flag: '--runs' },
  { argv: ['--runs=2.9'], flag: '--runs' },
  // Already rejected pre-fix, but only by accident: parseInt('0x10', 10) is 0 and
  // 0 < the --runs minimum of 1, so the range arm caught it. Kept as a control —
  // it stays green under a reverted shape guard, unlike the five above.
  { argv: ['--runs=0x10'], flag: '--runs' },
  { argv: ['--fail-budget=0abc'], flag: '--fail-budget' },
  { argv: ['--timeout=30000ms'], flag: '--timeout' },
];

for (const c of NON_INTEGER_FLAG_CASES) {
  test(`flake-budget rejects a non-integer flag value instead of truncating it — ${c.argv[0]}`, async () => {
    let spawnCalls = 0;
    const lines = [];

    const code = await checkFlakeBudgetMain({
      argv: c.argv,
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PICKLE_FLAKE_BUDGET_TEST_FILE: BIN },
      stdout: () => {},
      stderr: (msg) => lines.push(msg),
      spawnSyncFn: () => {
        spawnCalls += 1;
        return { status: 0, stdout: 'ℹ tests 1\nok 1 - synthetic\n', stderr: '' };
      },
    });

    assert.equal(code, 1, `expected rejection for ${c.argv[0]}, stderr: ${lines.join('\n')}`);
    assert.equal(spawnCalls, 0, `${c.argv[0]} must be rejected before any run is spawned`);
    const text = lines.join('\n');
    assert.ok(text.includes(c.flag), `error must name ${c.flag}, got: ${text}`);
    assert.match(text, /must be an integer/);
  });
}

// Negative control: a guard that rejected everything would pass the cases above.
test('flake-budget still accepts a clean integer flag value', async () => {
  let spawnCalls = 0;
  const code = await checkFlakeBudgetMain({
    argv: ['--runs=2', '--fail-budget=0', '--timeout=30000'],
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PICKLE_FLAKE_BUDGET_TEST_FILE: BIN },
    stdout: () => {},
    stderr: () => {},
    spawnSyncFn: () => {
      spawnCalls += 1;
      return { status: 0, stdout: 'ℹ tests 1\nok 1 - synthetic\n', stderr: '' };
    },
  });

  assert.equal(code, 0);
  assert.equal(spawnCalls, 2, 'both requested runs must execute');
});

// The range arm keeps reporting through the same message, so the shape guard did
// not fork the operator-facing contract.
test('flake-budget reports an out-of-range integer through the same message', async () => {
  const lines = [];
  const code = await checkFlakeBudgetMain({
    argv: ['--runs=0'],
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PICKLE_FLAKE_BUDGET_TEST_FILE: BIN },
    stdout: () => {},
    stderr: (msg) => lines.push(msg),
    spawnSyncFn: () => {
      throw new Error('no run may be spawned for an out-of-range --runs');
    },
  });

  assert.equal(code, 1);
  assert.match(lines.join('\n'), /--runs must be an integer >= 1, got: 0/);
});

// AC-D4: exit-code semantics are unchanged by this restructuring.
test('flake-budget exit codes stay 0 within budget and 1 over budget', () => {
  const withinBudget = runBudgetCheck({ runs: 3, failBudget: 2, failRuns: 0 });
  try {
    assert.equal(withinBudget.result.status, 0);
  } finally {
    withinBudget.cleanup();
  }

  const overBudget = runBudgetCheck({ runs: 4, failBudget: 1, failRuns: 2 });
  try {
    assert.equal(overBudget.result.status, 1);
  } finally {
    overBudget.cleanup();
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
        timeout: CAP_FLAKE_BUDGET_CHILD,
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

// AP-EXT-ITER53-01: `PICKLE_FLAKE_BUDGET_TEST_FILE` replaces the ENTIRE fast tier
// with one file, and `npm run test:fast:budget` is the only fast-tier execution in
// the release gate. Pre-fix the OK line was byte-identical either way, so an
// exported shell variable turned the gate green over ~5000 tests that never ran and
// left no trace saying so. The load-bearing assertion is that the two verdicts
// DIFFER: asserting either line alone passes over a hardcoded label.
function envWithoutFlakeBudgetOverride() {
  const env = { ...process.env };
  delete env.PICKLE_FLAKE_BUDGET_TEST_FILE;
  return env;
}

async function captureOkVerdict(env) {
  const lines = [];
  const code = await checkFlakeBudgetMain({
    argv: ['--runs=1', '--fail-budget=0', '--timeout=30000'],
    cwd: path.resolve(__dirname, '..'),
    env,
    stdout: (msg) => lines.push(msg),
    stderr: () => {},
    spawnSyncFn: () => ({ status: 0, stdout: 'ℹ tests 1\nok 1 - synthetic\n', stderr: '' }),
  });
  assert.equal(code, 0, `expected a clean run, stdout: ${lines.join('\n')}`);
  return lines.join('\n');
}

test('flake-budget names the fast tier it measured in the OK verdict', async () => {
  const verdict = await captureOkVerdict(envWithoutFlakeBudgetOverride());
  assert.match(verdict, /^flake-budget OK /m);
  // FR-A1: the fast tier is a parallel/serial split, so the verdict names BOTH halves. A target
  // naming only one half would be the same fake-green this field exists to prevent — it would
  // read identically whether the serial half ran or was silently dropped.
  assert.match(
    verdict,
    /target=bin\/test-runner\.js --tier fast --manifest tests\/\.serial-tests\.json --manifest-mode exclude --test-concurrency=8/,
    `a default run must name the parallel half, got: ${verdict}`,
  );
  assert.match(
    verdict,
    /bin\/test-runner\.js --tier fast --manifest tests\/\.serial-tests\.json --manifest-mode include --test-concurrency=1/,
    `a default run must name the serial half, got: ${verdict}`,
  );
});

test('flake-budget OK verdict distinguishes a single-file run from the fast tier', async () => {
  const tierVerdict = await captureOkVerdict(envWithoutFlakeBudgetOverride());
  const overrideVerdict = await captureOkVerdict({
    ...envWithoutFlakeBudgetOverride(),
    PICKLE_FLAKE_BUDGET_TEST_FILE: BIN,
  });

  assert.ok(
    overrideVerdict.includes(`target=--test --test-concurrency=8 ${BIN}`),
    `an overridden run must name the single file it measured, got: ${overrideVerdict}`,
  );
  assert.notEqual(
    overrideVerdict,
    tierVerdict,
    'a one-file run and a whole-tier run must not report identical verdicts',
  );
  assert.ok(
    !overrideVerdict.includes('--tier fast'),
    `an overridden run must not claim the fast tier, got: ${overrideVerdict}`,
  );
});

test('flake-budget names the measured target in the FAIL_BUDGET_EXCEEDED header too', async () => {
  const lines = [];
  const code = await checkFlakeBudgetMain({
    argv: ['--runs=2', '--fail-budget=0', '--timeout=30000'],
    cwd: path.resolve(__dirname, '..'),
    env: { ...envWithoutFlakeBudgetOverride(), PICKLE_FLAKE_BUDGET_TEST_FILE: BIN },
    stdout: () => {},
    stderr: (msg) => lines.push(msg),
    spawnSyncFn: () => ({ status: 1, stdout: '✖ test alpha (10ms)\n', stderr: '' }),
  });

  assert.equal(code, 1);
  const header = lines.find((line) => line.startsWith('FAIL_BUDGET_EXCEEDED'));
  assert.ok(header, `expected a FAIL_BUDGET_EXCEEDED header, got: ${lines.join('\n')}`);
  assert.ok(
    header.includes(`target=--test --test-concurrency=8 ${BIN}`),
    `the over-budget header must name the measured target, got: ${header}`,
  );
});

// --- FR-A1: the budget drives the same parallel/serial split CI runs ---------------------
//
// `npm run test:fast:budget` is the ONLY fast-tier execution in the release gate, so if it
// measured the tier as one undifferentiated c=8 pool it would keep reproducing the very
// contention the split exists to remove — and would certify a configuration nothing ships.

/** Records every child argv the subject spawns, so a dropped half is visible as a missing call. */
function recordingSpawnSyncFn(results) {
  const calls = [];
  let index = 0;
  const fn = (_execPath, args) => {
    calls.push(args);
    const result = results[Math.min(index, results.length - 1)];
    index += 1;
    return result;
  };
  fn.calls = calls;
  return fn;
}

const PASSING_HALF = { status: 0, stdout: 'ℹ tests 1\nok 1 - synthetic\n', stderr: '' };

test('flake-budget runs BOTH fast halves per run, parallel first then serial', async () => {
  const spawnSyncFn = recordingSpawnSyncFn([PASSING_HALF]);
  const code = await checkFlakeBudgetMain({
    argv: ['--runs=2', '--fail-budget=0', '--timeout=30000'],
    cwd: path.resolve(__dirname, '..'),
    env: envWithoutFlakeBudgetOverride(),
    stdout: () => {},
    stderr: () => {},
    spawnSyncFn,
  });

  assert.equal(code, 0);
  assert.equal(
    spawnSyncFn.calls.length,
    4,
    `2 runs x 2 halves must be 4 child spawns, got ${spawnSyncFn.calls.length}: ${JSON.stringify(spawnSyncFn.calls)}`,
  );
  for (let run = 0; run < 2; run += 1) {
    const parallel = spawnSyncFn.calls[run * 2];
    const serial = spawnSyncFn.calls[run * 2 + 1];
    assert.deepEqual(
      parallel,
      ['bin/test-runner.js', '--tier', 'fast', '--manifest', 'tests/.serial-tests.json', '--manifest-mode', 'exclude', '--test-concurrency=8'],
      `run ${run + 1} parallel half argv drifted`,
    );
    assert.deepEqual(
      serial,
      ['bin/test-runner.js', '--tier', 'fast', '--manifest', 'tests/.serial-tests.json', '--manifest-mode', 'include', '--test-concurrency=1'],
      `run ${run + 1} serial half argv drifted`,
    );
  }
});

// The `&&` short-circuit defect this shape exists to prevent, asserted from the failing side:
// the serial half must still be SPAWNED after the parallel half fails, and its failure must
// still count. `test:integration` had exactly this bug once already.
test('flake-budget measures the serial half even after the parallel half fails', async () => {
  const failingParallel = { status: 1, stdout: 'ℹ tests 1\n✖ parallel-side failure (5ms)\n', stderr: '' };
  const spawnSyncFn = recordingSpawnSyncFn([failingParallel, PASSING_HALF]);
  const stdout = [];
  const code = await checkFlakeBudgetMain({
    argv: ['--runs=1', '--fail-budget=1', '--timeout=30000'],
    cwd: path.resolve(__dirname, '..'),
    env: envWithoutFlakeBudgetOverride(),
    stdout: (msg) => stdout.push(msg),
    stderr: () => {},
    spawnSyncFn,
  });

  assert.equal(code, 0, 'one failure against a budget of 1 stays within budget');
  assert.equal(
    spawnSyncFn.calls.length,
    2,
    'the serial half must still run after the parallel half fails — no && short-circuit',
  );
  assert.deepEqual(spawnSyncFn.calls[1].slice(-3), ['--manifest-mode', 'include', '--test-concurrency=1']);
  assert.ok(
    stdout.join('\n').includes('parallel-side failure'),
    `the failing half must be attributed, got: ${stdout.join('\n')}`,
  );
});

test('flake-budget counts a serial-half-only failure against the budget', async () => {
  const failingSerial = { status: 1, stdout: 'ℹ tests 1\n✖ serial-side failure (5ms)\n', stderr: '' };
  const spawnSyncFn = recordingSpawnSyncFn([PASSING_HALF, failingSerial]);
  const stderr = [];
  const code = await checkFlakeBudgetMain({
    argv: ['--runs=1', '--fail-budget=0', '--timeout=30000'],
    cwd: path.resolve(__dirname, '..'),
    env: envWithoutFlakeBudgetOverride(),
    stdout: () => {},
    stderr: (msg) => stderr.push(msg),
    spawnSyncFn,
  });

  assert.equal(code, 1, 'a serial-half failure must red the gate exactly like a parallel-half one');
  assert.ok(
    stderr.some((line) => line.includes('serial-side failure')),
    `the serial half's failure must be named, got: ${stderr.join('\n')}`,
  );
});

// Classification is per FAILING half, never over the concatenation: a passing half always emits
// `ℹ tests N`, so a combined scan would read a CRASHED half as a budgetable flake purely because
// its sibling reported results — turning a harness crash into a tolerated flake.
test('flake-budget still throws on a crashed half that a passing sibling would otherwise mask', async () => {
  const crashedSerial = { status: 1, stdout: '', stderr: 'SyntaxError: Unexpected token\n' };
  const spawnSyncFn = recordingSpawnSyncFn([PASSING_HALF, crashedSerial]);
  const stderr = [];
  const code = await checkFlakeBudgetMain({
    argv: ['--runs=1', '--fail-budget=2', '--timeout=30000'],
    cwd: path.resolve(__dirname, '..'),
    env: envWithoutFlakeBudgetOverride(),
    stdout: () => {},
    stderr: (msg) => stderr.push(msg),
    spawnSyncFn,
  });

  assert.equal(code, 1, 'a non-budgetable crash must fail even with budget remaining');
  assert.ok(
    stderr.some((line) => line.includes('failed before reporting test results')),
    `a crashed half must report as non-budgetable, got: ${stderr.join('\n')}`,
  );
});

test('PICKLE_FLAKE_BUDGET_TEST_FILE still collapses to a single invocation', async () => {
  const spawnSyncFn = recordingSpawnSyncFn([PASSING_HALF]);
  const code = await checkFlakeBudgetMain({
    argv: ['--runs=1', '--fail-budget=0', '--timeout=30000'],
    cwd: path.resolve(__dirname, '..'),
    env: { ...envWithoutFlakeBudgetOverride(), PICKLE_FLAKE_BUDGET_TEST_FILE: BIN },
    stdout: () => {},
    stderr: () => {},
    spawnSyncFn,
  });

  assert.equal(code, 0);
  assert.equal(spawnSyncFn.calls.length, 1, 'the single-file override must not run a serial half');
  assert.deepEqual(spawnSyncFn.calls[0], ['--test', '--test-concurrency=8', BIN]);
});

// --- FR-A2: the CI/release workflows must upload the per-run logs this file writes ------
//
// No YAML-parsing library is a devDependency here (package.json is out of scope for this
// ticket); these tests parse the workflow text the same line-based way
// release-gate-parity.test.js and release-tag-version-guard.test.js already do.

/** The literal prefix `runIterations` passes to `mkdtempSync`, read from the shipped runtime
 * rather than duplicated here -- if the log-dir shape ever changes, this test changes with it
 * instead of silently drifting from what the script actually creates. */
function readFlakeBudgetLogDirPrefix() {
  const source = fs.readFileSync(BIN, 'utf8');
  const match = source.match(/mkdtempSync\(path\.join\(os\.tmpdir\(\),\s*['"]([^'"]+)['"]\)\)/);
  assert.ok(match, 'could not find the mkdtempSync(os.tmpdir(), "<prefix>") shape in check-flake-budget.js');
  return match[1];
}

const LOG_DIR_PREFIX = readFlakeBudgetLogDirPrefix();
const LOG_DIR_GLOB_FRAGMENT = `${LOG_DIR_PREFIX}*`;

function readWorkflowText(workflowPath) {
  return fs.readFileSync(workflowPath, 'utf8');
}

// Step boundary convention copied from release-tag-version-guard.test.js's guardStepBlock:
// steps are authored at 6-space indent in every workflow in this repo, so a step's block runs
// from its own `- name:` header up to (but not including) the next `- name:`/`- uses:` line.
function uploadArtifactStepBlock(workflowText) {
  const usesIndex = workflowText.indexOf('uses: actions/upload-artifact@v4');
  assert.notEqual(usesIndex, -1, 'workflow has no actions/upload-artifact@v4 step');

  const nameStart = workflowText.lastIndexOf('\n      - name:', usesIndex);
  assert.notEqual(nameStart, -1, 'could not find the step name header preceding the upload-artifact use');

  const nextStep = workflowText.indexOf('\n      - name:', usesIndex);
  const nextUse = workflowText.indexOf('\n      - uses:', usesIndex);
  const candidates = [nextStep, nextUse].filter((index) => index !== -1);
  const end = candidates.length > 0 ? Math.min(...candidates) : workflowText.length;

  return workflowText.slice(nameStart, end);
}

function extractField(block, field) {
  const match = block.match(new RegExp(`^\\s*${field}:\\s*(.+)\\s*$`, 'm'));
  return match ? match[1].trim() : null;
}

const WORKFLOWS = [
  ['ci.yml', CI_WORKFLOW],
  ['release.yml', RELEASE_WORKFLOW],
];

for (const [label, workflowPath] of WORKFLOWS) {
  test(`${label} declares a flake-budget upload-artifact step guarded by failure() with if-no-files-found: warn`, () => {
    const block = uploadArtifactStepBlock(readWorkflowText(workflowPath));

    const ifCondition = extractField(block, 'if');
    assert.equal(ifCondition, 'failure()', `${label} upload step must be guarded by if: failure()`);

    const pathValue = extractField(block, 'path');
    assert.ok(pathValue, `${label} upload step must declare a path:`);
    assert.ok(
      pathValue.endsWith(LOG_DIR_GLOB_FRAGMENT),
      `${label} upload path '${pathValue}' must end with the mktemp glob '${LOG_DIR_GLOB_FRAGMENT}' check-flake-budget.js actually creates`,
    );

    const ifNoFilesFound = extractField(block, 'if-no-files-found');
    assert.equal(
      ifNoFilesFound,
      'warn',
      `${label} upload step must use if-no-files-found: warn -- 'error' would add a new red path for gate failures that never reach test:fast:budget`,
    );
  });

  test(`${label} places the flake-budget upload step after the gate run: step`, () => {
    const workflow = readWorkflowText(workflowPath);
    const uploadIndex = workflow.indexOf('uses: actions/upload-artifact@v4');
    const gateIndex = workflow.indexOf('npm run test:fast:budget');

    assert.notEqual(uploadIndex, -1, `${label} has no upload-artifact step`);
    assert.notEqual(gateIndex, -1, `${label} has no npm run test:fast:budget invocation`);
    assert.ok(
      uploadIndex > gateIndex,
      `${label} must declare the upload step AFTER the gate run: step, not before it`,
    );
  });

  test(`${label} gate run: line is unchanged by the upload-step edit`, () => {
    const workflow = readWorkflowText(workflowPath);
    assert.ok(
      workflow.includes(
        'npm run test:fast:budget && npm run test:integration && npm run test:contract && RUN_EXPENSIVE_TESTS=1 npm run test:expensive',
      ),
      `${label} gate run: line must still end in the exact release-gate tail (unchanged by this ticket)`,
    );
  });
}

// The critical proof: the declared glob pattern must actually resolve against a directory
// built the exact way check-flake-budget.js builds it -- a string that merely "looks like"
// the right pattern is not evidence the upload step will find anything on a real runner.
test('the declared flake-budget glob pattern matches a directory built the same way the script builds one', () => {
  const block = uploadArtifactStepBlock(readWorkflowText(CI_WORKFLOW));
  const pathValue = extractField(block, 'path');
  const globFragment = pathValue.slice(pathValue.lastIndexOf('/') + 1);
  assert.equal(
    globFragment,
    LOG_DIR_GLOB_FRAGMENT,
    'the workflow path\'s final segment must be exactly the glob fragment check-flake-budget.js creates',
  );

  const escaped = globFragment.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const globRegExp = new RegExp(`^${escaped.replace(/\*/g, '[^/]*')}$`);

  const createdDir = fs.mkdtempSync(path.join(os.tmpdir(), LOG_DIR_PREFIX));
  try {
    assert.match(
      path.basename(createdDir),
      globRegExp,
      `a real mkdtempSync('${LOG_DIR_PREFIX}') directory must match the declared workflow glob`,
    );
    // Negative control: an unrelated directory name must NOT match, so the pin has teeth.
    assert.doesNotMatch(
      'unrelated-tmp-dir-name',
      globRegExp,
      'the glob regex must not match an unrelated directory name',
    );
  } finally {
    fs.rmSync(createdDir, { recursive: true, force: true });
  }
});

// AP-EXT-ITER157-01: `target=` names the argv the run REQUESTED; nothing named the size it
// MEASURED. Two doors reach a green verdict over an unmeasured tier, and neither moves the argv:
// `bin/test-runner.js --tier fast …` exits 0 printing only `[no files for tier fast]` when its
// selection is empty (case A measures that), and an ambient env can narrow what the child
// registers with the argv byte-identical (case D). Pre-fix `flake-budget OK failures=0
// runs_completed=5 runs_requested=5 target=…` was byte-identical to a real green in both.
// Assert the VERDICT and the measured count, never the exit code alone — the pre-fix run
// returned 0 in every one of these shapes.

const EMPTY_TIER_STDERR = '[no files for tier fast]\n';

test('AP-EXT-ITER157-01(a): the real tier runner exits 0 with NO node:test summary on an empty selection', () => {
  const dir = makeTmpDir();
  try {
    // An existing test file that is NOT in the fast tier: the include-filter yields zero files,
    // which is the only way `readManifestEntries` (it rejects absent entries) lets a tier go empty.
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ entries: ['tests/integration/deploy-lifecycle-soak.test.js'] }),
    );

    const result = spawnSync(
      process.execPath,
      [
        path.resolve(__dirname, '..', 'bin/test-runner.js'),
        '--tier', 'fast',
        '--manifest', manifestPath,
        '--manifest-mode', 'include',
        '--test-concurrency=1',
      ],
      { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: CAP_FLAKE_BUDGET_CHILD },
    );

    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /\[no files for tier fast\]/);
    assert.ok(
      !/^(?:ℹ|#)[ \t]+tests[ \t]+\d+/m.test(`${result.stdout}\n${result.stderr}`),
      `an empty selection must emit no node:test summary, got: ${result.stdout}${result.stderr}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER157-01(b): a half that exits 0 having run nothing is refused, not reported OK', async () => {
  const emptyHalf = { status: 0, stdout: '', stderr: EMPTY_TIER_STDERR };
  // The fixture's own precondition: this shape is a SUCCESS exit, so the case cannot pass
  // because of a non-zero status — case (a) measures that the real runner emits exactly it.
  assert.equal(emptyHalf.status, 0);

  const out = [];
  const err = [];
  const code = await checkFlakeBudgetMain({
    argv: ['--runs=5', '--fail-budget=2', '--timeout=30000'],
    cwd: path.resolve(__dirname, '..'),
    env: envWithoutFlakeBudgetOverride(),
    stdout: (msg) => out.push(msg),
    stderr: (msg) => err.push(msg),
    spawnSyncFn: () => ({ ...emptyHalf }),
  });

  assert.equal(code, 1, `stdout: ${out.join('\n')}`);
  assert.deepEqual(
    out.filter((l) => l.startsWith('flake-budget OK')), [],
    `a tier that ran nothing must not print an OK verdict, got: ${out.join('\n')}`,
  );
  const message = err.join('\n');
  assert.match(message, /failed before reporting test results/);
  const pathMatch = message.match(/written to (\S+)/);
  assert.ok(pathMatch, `the refusal must name a log path, got: ${message}`);
  assert.ok(
    fs.readFileSync(pathMatch[1], 'utf8').includes(EMPTY_TIER_STDERR.trim()),
    'the log must carry the child output that could not be measured',
  );
});

/** A real test file whose registered test COUNT is chosen by an ambient env var, not by argv. */
function writeEnvSizedTest(dir) {
  const testFile = path.join(dir, 'env-sized.test.js');
  fs.writeFileSync(
    testFile,
    `import { test } from 'node:test';
const n = Number.parseInt(process.env.AP24_TEST_COUNT ?? '1', 10);
for (let i = 0; i < n; i += 1) test('env-sized case ' + i, () => {});
`,
  );
  return testFile;
}

test('AP-EXT-ITER157-01(d): the OK verdict names the size measured, so an argv-blind narrowing is visible', async () => {
  const dir = makeTmpDir();
  try {
    const testFile = writeEnvSizedTest(dir);
    const runWith = async (count) => {
      const out = [];
      const code = await checkFlakeBudgetMain({
        argv: ['--runs=1', '--fail-budget=0', '--timeout=60000'],
        cwd: path.resolve(__dirname, '..'),
        env: {
          ...envWithoutFlakeBudgetOverride(),
          PICKLE_FLAKE_BUDGET_TEST_FILE: testFile,
          AP24_TEST_COUNT: String(count),
        },
        stdout: (msg) => out.push(msg),
        stderr: () => {},
        spawnSyncFn: undefined,
      });
      assert.equal(code, 0, `a real green run must stay green, got: ${out.join('\n')}`);
      return out.join('\n');
    };

    const wide = await runWith(3);
    const narrowed = await runWith(1);

    // Precondition: the argv is byte-identical across the two runs, so `target=` cannot
    // distinguish them — pre-fix the whole verdict line was identical too.
    const targetOf = (verdict) => verdict.slice(verdict.indexOf('target='));
    assert.equal(targetOf(wide), targetOf(narrowed), 'the two runs must share one target= argv');

    assert.match(wide, /\btests=3\b/, `the wide run must name 3 measured tests, got: ${wide}`);
    assert.match(narrowed, /\btests=1\b/, `the narrowed run must name 1 measured test, got: ${narrowed}`);
    assert.notEqual(wide, narrowed, 'a narrowed run must not print a verdict identical to the wide one');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

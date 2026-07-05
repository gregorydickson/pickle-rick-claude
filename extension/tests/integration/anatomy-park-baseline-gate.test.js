// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  ensurePerIterationGateBaseline,
  runPerIterationGateHook,
  handleWorkerManagedIteration,
  loadConvergenceGateSettings,
  loadFailureClassificationFlag,
} = await import(
  path.resolve(__dirname, '../../bin/microverse-runner.js')
);

const { runGate } = await import(
  path.resolve(__dirname, '../../services/convergence-gate.js')
);

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

function makeGateResult(status = 'green', failureCount = 0) {
  return {
    status,
    failures: Array.from({ length: failureCount }, (_, i) => ({
      check: 'lint',
      file: `src/foo${i}.ts`,
      line: i + 1,
      ruleOrCode: 'no-unused-vars',
      message: 'unused',
      severity: 'error',
      occurrence_index: 0,
    })),
    baseline_used: false,
    allowed_paths_used: false,
    elapsed_ms: 100,
    total_raw_failure_count: failureCount,
    new_failures_vs_baseline: failureCount,
  };
}

const BASE_OPTS = {
  preIterSha: 'sha-before',
  workingDir: '/tmp/test-wd',
  sessionDir: '/tmp/test-session',
  enabledFiles: ['anatomy-park.json'],
  regressionWarningThreshold: 5,
  backend: 'claude',
  remediatorTimeoutS: 600,
  log: () => {},
};

function makeGitRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

function writeGateFixtureRepo(dir) {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'gate-fixture',
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
  fs.writeFileSync(
    path.join(dir, 'scripts', 'test.cjs'),
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "if (!fs.existsSync(path.join(process.cwd(), 'trigger-test.txt'))) process.exit(0);",
      "console.error('simulated test regression');",
      'process.exit(1);',
      '',
    ].join('\n'),
  );
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'broken.js'), 'module.exports = 1;\n');
}

function commitAll(dir, message) {
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', message], { cwd: dir, stdio: 'pipe' });
}

// AC-SZGB-06 fixture: a real npm project with a `typecheck` script that always fails, so a
// resolved child project surfaces a genuine typecheck failure (not a fixture stub that always
// passes, like writeGateFixtureRepo's typecheck.cjs).
function writeTypecheckFailureProject(childDir) {
  fs.mkdirSync(childDir, { recursive: true });
  fs.writeFileSync(
    path.join(childDir, 'package.json'),
    JSON.stringify({
      name: 'nested-typecheck-fixture',
      private: true,
      scripts: { typecheck: 'node typecheck.cjs' },
    }, null, 2),
  );
  fs.writeFileSync(
    path.join(childDir, 'typecheck.cjs'),
    [
      "console.error(\"src/index.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\");",
      'process.exit(1);',
      '',
    ].join('\n'),
  );
}

// Fixture i: gate enabled + commits happened + gate green → no events
test('gate-fixture-i: green gate + commits → no regression events', async () => {
  const events = [];
  const writtenStates = [];

  // Per-test temp sessionDir + pre-staged baseline.json so the gate runs in
  // 'baseline' mode (not 'strict'), which avoids the unrelated
  // baseline_recapture_attempted emission that fires whenever a strict gate
  // runs without an existing baseline file. The assertion below is testing
  // green-gate idle behavior, not the recapture path.
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-gate-fixture-i-'));
  fs.mkdirSync(path.join(sessionDir, 'gate'), { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'gate', 'baseline.json'),
    JSON.stringify({ failures: [], total_raw_failure_count: 0 }),
  );

  try {
    const mv = await runPerIterationGateHook({
      ...BASE_OPTS,
      sessionDir,
      currentMv: makeMv(),
      _deps: {
        getHeadShaFn: () => 'sha-after',
        runGateFn: async () => makeGateResult('green', 0),
        runRemediatorFn: async () => { assert.fail('remediator must not be called on green gate'); },
        writeMicroverseStateFn: (_, s) => writtenStates.push(s),
        logActivityFn: (e) => events.push(e),
      },
    });

    assert.equal(events.length, 0, `No events for green gate, got: ${JSON.stringify(events)}`);
    assert.equal(writtenStates.length, 0, 'No state writes for green gate');
    assert.equal(mv.iteration_regressions, 0);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// Fixture ii: gate red + remediator succeeds → no regression event
test('gate-fixture-ii: red gate + remediator success → no regression', async () => {
  const events = [];

  const mv = await runPerIterationGateHook({
    ...BASE_OPTS,
    currentMv: makeMv(),
    _deps: {
      getHeadShaFn: () => 'sha-after',
      runGateFn: async () => makeGateResult('red', 2),
      runRemediatorFn: async () => ({ success: true }),
      writeMicroverseStateFn: () => {},
      logActivityFn: (e) => events.push(e),
    },
  });

  assert.ok(
    !events.some(e => e.event === 'iteration_left_regression'),
    'No regression event when remediator succeeds',
  );
  assert.equal(mv.iteration_regressions, 0, 'iteration_regressions must not increment on success');
});

// Fixture iii: convergence_file not in allowlist → gate does not fire
test('gate-fixture-iii: convergence_file not in allowlist → gate not called', async () => {
  let gateCallCount = 0;
  const events = [];

  await runPerIterationGateHook({
    ...BASE_OPTS,
    currentMv: makeMv({ convergence_file: 'my-custom.json' }),
    enabledFiles: ['anatomy-park.json'],
    _deps: {
      getHeadShaFn: () => 'sha-after',
      runGateFn: async () => { gateCallCount++; return makeGateResult('red', 1); },
      runRemediatorFn: async () => ({ success: false }),
      writeMicroverseStateFn: () => {},
      logActivityFn: (e) => events.push(e),
    },
  });

  assert.equal(gateCallCount, 0, 'runGate must not be called when file not in allowlist');
  assert.equal(events.length, 0, `No events for disabled gate, got: ${JSON.stringify(events)}`);
});

// Fixture iv: gate red + remediator fails → iteration_regressions increments
test('gate-fixture-iv: red gate + remediator fail → iteration_regressions increments', async () => {
  const events = [];
  let lastWrittenMv;

  const mv = await runPerIterationGateHook({
    ...BASE_OPTS,
    currentMv: makeMv({ iteration_regressions: 2 }),
    _deps: {
      getHeadShaFn: () => 'sha-after',
      runGateFn: async () => makeGateResult('red', 3),
      runRemediatorFn: async () => ({ success: false }),
      writeMicroverseStateFn: (_, s) => { lastWrittenMv = s; },
      logActivityFn: (e) => events.push(e),
    },
  });

  assert.equal(mv.iteration_regressions, 3, 'iteration_regressions must increment from 2 → 3');
  assert.ok(lastWrittenMv, 'state must be persisted after regression');
  assert.equal(lastWrittenMv.iteration_regressions, 3);

  const regEvent = events.find(e => e.event === 'iteration_left_regression');
  assert.ok(regEvent, `iteration_left_regression event must be emitted, got: ${JSON.stringify(events)}`);
  assert.equal(regEvent.gate_payload.failures_in, 3);
});

// Fixture v: convergence_file = 'microverse.json' → not in default allowlist, zero gate events
test('gate-fixture-v: microverse.json convergence_file → zero gate events', async () => {
  let gateCallCount = 0;
  const events = [];

  await runPerIterationGateHook({
    ...BASE_OPTS,
    currentMv: makeMv({ convergence_file: 'microverse.json' }),
    enabledFiles: ['anatomy-park.json'],
    _deps: {
      getHeadShaFn: () => 'sha-after',
      runGateFn: async () => { gateCallCount++; return makeGateResult('red', 1); },
      runRemediatorFn: async () => ({ success: false }),
      writeMicroverseStateFn: () => {},
      logActivityFn: (e) => events.push(e),
    },
  });

  assert.equal(gateCallCount, 0, 'runGate must not be called for microverse.json');
  assert.ok(
    !events.some(e => typeof e.event === 'string' && e.event.startsWith('gate_')),
    `No gate_* events for microverse.json, got: ${JSON.stringify(events)}`,
  );
});

// Fixture vi: no commits → gate_skipped with reason 'no_commits'
test('gate-fixture-vi: no commits → gate_skipped event', async () => {
  const events = [];
  let gateCallCount = 0;

  await runPerIterationGateHook({
    ...BASE_OPTS,
    currentMv: makeMv(),
    _deps: {
      getHeadShaFn: () => 'sha-before', // same SHA → no commits
      runGateFn: async () => { gateCallCount++; return makeGateResult('green', 0); },
      runRemediatorFn: async () => ({ success: false }),
      writeMicroverseStateFn: () => {},
      logActivityFn: (e) => events.push(e),
    },
  });

  assert.equal(gateCallCount, 0, 'runGate must not be called when no commits happened');
  const skipEvent = events.find(e => e.event === 'gate_skipped');
  assert.ok(skipEvent, `gate_skipped event must be emitted, got: ${JSON.stringify(events)}`);
  assert.equal(skipEvent.gate_payload?.reason, 'no_commits');
});

// Threshold warning: 6 regressions → warning fires exactly once, second crossing silent
test('threshold-warning: 6 regressions → exactly one warning, second crossing silent', async () => {
  const logs = [];
  const events = [];

  // Start at regressionWarningThreshold=5 with iteration_regressions=5 (at threshold, not above)
  let mv = makeMv({ iteration_regressions: 5, gate_regression_threshold_warning_emitted: false });

  const runWithRegression = async (currentMv) => runPerIterationGateHook({
    ...BASE_OPTS,
    currentMv,
    log: (msg) => logs.push(msg),
    _deps: {
      getHeadShaFn: () => 'sha-after',
      runGateFn: async () => makeGateResult('red', 1),
      runRemediatorFn: async () => ({ success: false }),
      writeMicroverseStateFn: () => {},
      logActivityFn: (e) => events.push(e),
    },
  });

  // First run: regressions 5 → 6 (> threshold=5), warning fires
  mv = await runWithRegression(mv);
  assert.equal(mv.iteration_regressions, 6);
  assert.equal(mv.gate_regression_threshold_warning_emitted, true);

  const warningEvents = events.filter(e => e.event === 'gate_regression_threshold_warning');
  assert.equal(warningEvents.length, 1, 'warning event fired exactly once after first crossing');
  assert.ok(logs.some(l => l.includes('regression')), 'warning log must mention regression');

  // Second run: warning must NOT fire again
  mv = await runWithRegression(mv);
  const warningEventsAfter = events.filter(e => e.event === 'gate_regression_threshold_warning');
  assert.equal(warningEventsAfter.length, 1, 'warning must not fire a second time');
  assert.equal(mv.gate_regression_threshold_warning_emitted, true, 'flag must remain true');
});

test('bootstrap baseline: first post-bootstrap lint regression is flagged instead of becoming the baseline', async () => {
  const workingDir = makeGitRepo('ap-gate-repo-');
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-gate-session-'));
  writeGateFixtureRepo(workingDir);
  commitAll(workingDir, 'initial clean state');

  await ensurePerIterationGateBaseline({
    currentMv: makeMv(),
    workingDir,
    sessionDir,
    enabledFiles: ['anatomy-park.json'],
    log: () => {},
  });

  const baselinePath = path.join(sessionDir, 'gate', 'baseline.json');
  assert.ok(fs.existsSync(baselinePath), 'baseline must be captured before the first iteration gate');

  const preIterSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workingDir, encoding: 'utf-8' }).trim();
  fs.writeFileSync(path.join(workingDir, 'trigger-lint.txt'), 'trigger\n');
  commitAll(workingDir, 'introduce lint regression');

  const events = [];
  let writtenMv;
  const mv = await runPerIterationGateHook({
    ...BASE_OPTS,
    currentMv: makeMv(),
    preIterSha,
    workingDir,
    sessionDir,
    _deps: {
      runRemediatorFn: async () => ({ success: false }),
      writeMicroverseStateFn: (_, next) => { writtenMv = next; },
      logActivityFn: (event) => events.push(event),
    },
  });

  assert.equal(mv.iteration_regressions, 1, 'first regression after bootstrap must increment iteration_regressions');
  assert.equal(writtenMv.iteration_regressions, 1, 'regression state must be persisted');
  assert.ok(
    events.some((event) => event.event === 'iteration_left_regression' && event.gate_payload?.failures_in === 1),
    `expected iteration_left_regression event, got: ${JSON.stringify(events)}`,
  );
});

test('bootstrap baseline: green gate result without baseline file is diagnosed and rejected', async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-gate-missing-baseline-session-'));
  const logs = [];
  const events = [];

  await assert.rejects(
    () => ensurePerIterationGateBaseline({
      currentMv: makeMv(),
      workingDir: '/tmp/test-wd',
      sessionDir,
      enabledFiles: ['anatomy-park.json'],
      log: (msg) => logs.push(msg),
      _deps: {
        runGateFn: async () => makeGateResult('green', 0),
        logActivityFn: (event) => events.push(event),
      },
    }),
    /baseline initialization failed/,
  );

  assert.equal(
    fs.existsSync(path.join(sessionDir, 'gate', 'baseline.json')),
    false,
    'diagnostic failure must not fabricate a baseline file',
  );
  assert.ok(
    logs.some((msg) => msg.includes('baseline initialization failed')),
    `expected actionable failure log, got ${JSON.stringify(logs)}`,
  );
  assert.ok(
    !logs.some((msg) => msg.includes('initialized per-iteration gate baseline')),
    `success log must not fire without a baseline file, got ${JSON.stringify(logs)}`,
  );
  assert.ok(
    events.some((event) => event.event === 'gate_baseline_init_failed'),
    `expected gate_baseline_init_failed event, got ${JSON.stringify(events)}`,
  );
});

test('AC-GBM-B2: missing per-iteration baseline is recaptured once before strict mode', async () => {
  const workingDir = makeGitRepo('ap-gate-recapture-repo-');
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-gate-recapture-session-'));
  writeGateFixtureRepo(workingDir);
  commitAll(workingDir, 'initial clean state');

  const preIterSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workingDir, encoding: 'utf-8' }).trim();
  fs.writeFileSync(path.join(workingDir, 'trigger-lint.txt'), 'trigger\n');
  commitAll(workingDir, 'iteration introduces lint regression');
  const postIterSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workingDir, encoding: 'utf-8' }).trim();
  const baselinePath = path.join(sessionDir, 'gate', 'baseline.json');
  const calls = [];
  const logs = [];

  const mv = await runPerIterationGateHook({
    ...BASE_OPTS,
    currentMv: makeMv(),
    preIterSha,
    workingDir,
    sessionDir,
    log: (msg) => logs.push(msg),
    _deps: {
      getHeadShaFn: () => postIterSha,
      runGateFn: async (opts) => {
        calls.push({
          mode: opts.mode,
          scope: opts.scope,
          baselinePath: opts.baselinePath,
          head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workingDir, encoding: 'utf-8' }).trim(),
        });
        if (opts.mode === 'baseline' && opts.scope === 'full') {
          fs.mkdirSync(path.dirname(opts.baselinePath), { recursive: true });
          fs.writeFileSync(opts.baselinePath, JSON.stringify({
            schema_version: 1,
            captured_at: new Date().toISOString(),
            working_dir: workingDir,
            project_type: 'npm',
            checks: ['typecheck', 'lint', 'tests'],
            failures: [],
          }, null, 2));
          return makeGateResult('green', 0);
        }
        assert.equal(opts.mode, 'baseline', 'successful recapture must make changed gate run in baseline mode');
        assert.equal(opts.scope, 'changed');
        assert.equal(opts.baselinePath, baselinePath);
        return makeGateResult('green', 0);
      },
      runRemediatorFn: async () => { assert.fail('remediator must not run when recaptured baseline gate is green'); },
      writeMicroverseStateFn: () => {},
      logActivityFn: () => {},
    },
  });

  assert.equal(mv.iteration_regressions, 0);
  assert.equal(calls.length, 2, `expected one recapture and one changed gate, got: ${JSON.stringify(calls)}`);
  assert.deepEqual(
    calls.map((call) => ({ mode: call.mode, scope: call.scope })),
    [
      { mode: 'baseline', scope: 'full' },
      { mode: 'baseline', scope: 'changed' },
    ],
  );
  assert.equal(calls[0].head, preIterSha, 'recapture must run against the pre-iteration tree');
  assert.equal(calls[1].head, postIterSha, 'changed gate must run after restoring the post-iteration tree');
  assert.ok(fs.existsSync(baselinePath), 'recapture must create the missing baseline file');
  assert.ok(
    !calls.some((call) => call.mode === 'strict'),
    `successful recapture must avoid strict mode, got: ${JSON.stringify(calls)}`,
  );
  assert.ok(
    logs.some((msg) => msg.includes('recaptured per-iteration gate baseline')),
    `expected recapture success log, got: ${JSON.stringify(logs)}`,
  );
});

test('bootstrap baseline: first post-bootstrap test regression is flagged instead of false-greening the iteration', async () => {
  const workingDir = makeGitRepo('ap-gate-test-repo-');
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-gate-test-session-'));
  writeGateFixtureRepo(workingDir);
  commitAll(workingDir, 'initial clean state');

  await ensurePerIterationGateBaseline({
    currentMv: makeMv(),
    workingDir,
    sessionDir,
    enabledFiles: ['anatomy-park.json'],
    log: () => {},
  });

  const baselinePath = path.join(sessionDir, 'gate', 'baseline.json');
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
  assert.deepEqual(
    baseline.checks,
    ['typecheck', 'lint', 'tests'],
    'baseline must cover tests so pure test regressions cannot slip past the per-iteration gate',
  );

  const preIterSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workingDir, encoding: 'utf-8' }).trim();
  fs.writeFileSync(path.join(workingDir, 'trigger-test.txt'), 'trigger\n');
  commitAll(workingDir, 'introduce test regression');

  const events = [];
  let writtenMv;
  const mv = await runPerIterationGateHook({
    ...BASE_OPTS,
    currentMv: makeMv(),
    preIterSha,
    workingDir,
    sessionDir,
    _deps: {
      runRemediatorFn: async () => ({ success: false }),
      writeMicroverseStateFn: (_, next) => { writtenMv = next; },
      logActivityFn: (event) => events.push(event),
    },
  });

  assert.equal(mv.iteration_regressions, 1, 'pure test regressions must increment iteration_regressions');
  assert.equal(writtenMv.iteration_regressions, 1, 'test regression state must be persisted');
  assert.ok(
    events.some((event) => event.event === 'iteration_left_regression' && event.gate_payload?.failures_in === 1),
    `expected iteration_left_regression event for the test regression, got: ${JSON.stringify(events)}`,
  );
});

test('stale baseline refresh: matching stale failure is discarded before the next iteration gate runs', async () => {
  const workingDir = makeGitRepo('ap-gate-stale-repo-');
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-gate-stale-session-'));
  writeGateFixtureRepo(workingDir);
  commitAll(workingDir, 'initial clean state');

  const baselinePath = path.join(sessionDir, 'gate', 'baseline.json');
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, JSON.stringify({
    schema_version: 1,
    captured_at: new Date().toISOString(),
    working_dir: workingDir,
    project_type: 'npm',
    checks: ['typecheck', 'lint', 'tests'],
    failures: [{
      check: 'lint',
      file: path.join(workingDir, 'src', 'broken.js'),
      line: 1,
      ruleOrCode: 'no-simulated-regression',
      message: 'simulated lint regression',
      severity: 'error',
      occurrence_index: 0,
    }],
  }, null, 2));

  const baselineLogs = [];
  await ensurePerIterationGateBaseline({
    currentMv: makeMv(),
    workingDir,
    sessionDir,
    enabledFiles: ['anatomy-park.json'],
    currentIteration: 30,
    baselineMaxAgeIterations: 30,
    baselineMaxAgeSeconds: 14_400,
    log: (msg) => baselineLogs.push(msg),
  });

  const refreshedBaseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
  assert.deepEqual(
    refreshedBaseline.failures,
    [],
    'stale baseline must be recaptured from the clean pre-iteration tree instead of reusing stale failures',
  );
  assert.ok(
    baselineLogs.some((msg) => msg.includes('refreshing per-iteration gate baseline')),
    `expected stale-baseline refresh log, got: ${JSON.stringify(baselineLogs)}`,
  );

  const preIterSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workingDir, encoding: 'utf-8' }).trim();
  fs.writeFileSync(path.join(workingDir, 'trigger-lint.txt'), 'trigger\n');
  commitAll(workingDir, 'introduce lint regression after refresh');

  const events = [];
  let writtenMv;
  const mv = await runPerIterationGateHook({
    ...BASE_OPTS,
    currentMv: makeMv(),
    preIterSha,
    workingDir,
    sessionDir,
    _deps: {
      runRemediatorFn: async () => ({ success: false }),
      writeMicroverseStateFn: (_, next) => { writtenMv = next; },
      logActivityFn: (event) => events.push(event),
    },
  });

  assert.equal(mv.iteration_regressions, 1, 'refreshed baseline must not subtract the new lint regression');
  assert.equal(writtenMv.iteration_regressions, 1, 'refreshed-baseline regression must persist state');
  assert.ok(
    events.some((event) => event.event === 'iteration_left_regression' && event.gate_payload?.failures_in === 1),
    `expected iteration_left_regression after stale baseline refresh, got: ${JSON.stringify(events)}`,
  );
});

test('fresh recaptured baseline: iteration-age check uses captured_iteration instead of absolute loop count', async () => {
  const workingDir = makeGitRepo('ap-gate-fresh-age-repo-');
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-gate-fresh-age-session-'));
  writeGateFixtureRepo(workingDir);
  commitAll(workingDir, 'initial clean state');

  await ensurePerIterationGateBaseline({
    currentMv: makeMv(),
    workingDir,
    sessionDir,
    enabledFiles: ['anatomy-park.json'],
    currentIteration: 30,
    baselineMaxAgeIterations: 30,
    baselineMaxAgeSeconds: 14_400,
    log: () => {},
  });

  const baselinePath = path.join(sessionDir, 'gate', 'baseline.json');
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
  assert.equal(baseline.captured_iteration, 30, 'baseline recapture must persist the capture iteration');

  const logs = [];
  await ensurePerIterationGateBaseline({
    currentMv: makeMv(),
    workingDir,
    sessionDir,
    enabledFiles: ['anatomy-park.json'],
    currentIteration: 31,
    baselineMaxAgeIterations: 30,
    baselineMaxAgeSeconds: 14_400,
    log: (msg) => logs.push(msg),
  });

  assert.ok(
    !logs.some((msg) => msg.includes('refreshing per-iteration gate baseline')),
    `freshly recaptured baseline must remain fresh on the next loop, got: ${JSON.stringify(logs)}`,
  );
});

test('worker convergence: converged=true is deferred when the per-iteration gate leaves regressions behind', async () => {
  const workingDir = makeGitRepo('ap-gate-worker-converged-repo-');
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-gate-worker-converged-session-'));
  writeGateFixtureRepo(workingDir);
  commitAll(workingDir, 'initial clean state');

  await ensurePerIterationGateBaseline({
    currentMv: makeMv(),
    workingDir,
    sessionDir,
    enabledFiles: ['anatomy-park.json'],
    log: () => {},
  });

  const preIterSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workingDir, encoding: 'utf-8' }).trim();
  fs.writeFileSync(path.join(sessionDir, 'anatomy-park.json'), JSON.stringify({ converged: true, reason: 'clean passes done' }));
  fs.writeFileSync(path.join(workingDir, 'trigger-lint.txt'), 'trigger\n');
  commitAll(workingDir, 'introduce final-iteration lint regression');

  const events = [];
  const logs = [];
  let writtenMv;
  const result = await handleWorkerManagedIteration({
    ...BASE_OPTS,
    currentMv: makeMv(),
    preIterSha,
    workingDir,
    sessionDir,
    iteration: 7,
    log: (msg) => logs.push(msg),
    _deps: {
      runRemediatorFn: async () => ({ success: false }),
      writeMicroverseStateFn: (_, next) => { writtenMv = next; },
      logActivityFn: (event) => events.push(event),
    },
  });

  assert.equal(result.converged, false, 'worker convergence must be deferred when the final iteration still leaves regressions');
  assert.equal(result.reason, 'per-iteration gate left unresolved regressions');
  assert.equal(result.currentMv.iteration_regressions, 1, 'final converged iteration must still record the regression');
  assert.equal(writtenMv.iteration_regressions, 1, 'regression state must persist before exit');
  assert.ok(
    events.some((event) => event.event === 'iteration_left_regression' && event.gate_payload?.failures_in === 1),
    `expected iteration_left_regression before converged exit, got: ${JSON.stringify(events)}`,
  );
  assert.ok(
    logs.some((msg) => msg.includes('running per-iteration gate before exit')),
    `expected worker convergence gate log, got: ${JSON.stringify(logs)}`,
  );
  assert.ok(
    logs.some((msg) => msg.includes('convergence deferred')),
    `expected convergence deferral log, got: ${JSON.stringify(logs)}`,
  );
});

test('worker convergence: dead-writer tmp snapshot is promoted before convergence check', async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-gate-worker-tmp-session-'));
  const stalePath = path.join(sessionDir, 'anatomy-park.json');
  const tmpPath = path.join(sessionDir, 'anatomy-park.json.tmp.999999');
  fs.writeFileSync(stalePath, JSON.stringify({ converged: false }));
  fs.writeFileSync(tmpPath, JSON.stringify({ converged: true, reason: 'recovered clean passes' }));
  const future = new Date(Date.now() + 1000);
  fs.utimesSync(tmpPath, future, future);

  // Pre-populate convergence.history with a scored entry — the dying writer
  // had presumably accrued at least one iteration before crashing. The
  // dead-tmp recovery being asserted here is independent of any metric-mode
  // convergence-history guard behavior.
  const mvWithHistory = makeMv({
    convergence: {
      stall_limit: 5,
      stall_counter: 0,
      history: [{ iteration: 7, action: 'accept', score: 1, classification: 'improved' }],
    },
  });

  const logs = [];
  const result = await handleWorkerManagedIteration({
    ...BASE_OPTS,
    currentMv: mvWithHistory,
    preIterSha: 'sha-same',
    sessionDir,
    iteration: 8,
    log: (msg) => logs.push(msg),
    _deps: {
      getHeadShaFn: () => 'sha-same',
      runGateFn: async () => { assert.fail('gate must not run when no commits happened'); },
      writeMicroverseStateFn: () => {},
      logActivityFn: () => {},
    },
  });

  assert.equal(result.converged, true);
  assert.equal(result.reason, 'recovered clean passes');
  assert.equal(fs.existsSync(tmpPath), false, 'dead writer tmp should be consumed during convergence recovery');
  assert.deepEqual(JSON.parse(fs.readFileSync(stalePath, 'utf-8')), {
    converged: true,
    reason: 'recovered clean passes',
  });
  assert.ok(
    logs.some((msg) => msg.includes('worker convergence signaled')),
    `expected recovered convergence log, got: ${JSON.stringify(logs)}`,
  );
});

test('microverse startup settings promote newer dead tmp before gate/failure settings are read', () => {
  const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-gate-settings-tmp-'));
  const settingsPath = path.join(extRoot, 'pickle_settings.json');
  const tmpPath = `${settingsPath}.tmp.999999`;
  fs.writeFileSync(settingsPath, JSON.stringify({
    enable_failure_classification: true,
    convergence_gate: {
      enabled_convergence_files: [],
      regression_warning_threshold: 9,
      remediator_timeout_s: 60,
      baseline_max_age_iterations: 30,
      baseline_max_age_seconds: 14_400,
    },
  }));
  fs.writeFileSync(tmpPath, JSON.stringify({
    enable_failure_classification: false,
    convergence_gate: {
      enabled_convergence_files: ['anatomy-park.json'],
      regression_warning_threshold: 2,
      remediator_timeout_s: 120,
      baseline_max_age_iterations: 4,
      baseline_max_age_seconds: 600,
    },
  }));
  const future = new Date(Date.now() + 1000);
  fs.utimesSync(tmpPath, future, future);

  const settings = loadConvergenceGateSettings(extRoot);
  const failureClassification = loadFailureClassificationFlag(extRoot);

  assert.deepEqual(settings.enabled_convergence_files, ['anatomy-park.json']);
  assert.equal(settings.regression_warning_threshold, 2);
  assert.equal(settings.remediator_timeout_s, 120);
  assert.equal(settings.baseline_max_age_iterations, 4);
  assert.equal(settings.baseline_max_age_seconds, 600);
  assert.equal(failureClassification, false);
  assert.equal(fs.existsSync(tmpPath), false, 'dead settings tmp should be consumed before startup settings are returned');
});

test('microverse startup settings default invalid numeric gate controls before runner use', () => {
  const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-gate-settings-invalid-'));
  try {
    fs.writeFileSync(path.join(extRoot, 'pickle_settings.json'), JSON.stringify({
      convergence_gate: {
        enabled_convergence_files: [42, '', '   '],
        regression_warning_threshold: 0,
        remediator_timeout_s: 0.5,
        baseline_max_age_iterations: -1,
        baseline_max_age_seconds: Number.POSITIVE_INFINITY,
      },
    }));

    const settings = loadConvergenceGateSettings(extRoot);

    assert.deepEqual(settings.enabled_convergence_files, ['anatomy-park.json']);
    assert.equal(settings.regression_warning_threshold, 5);
    assert.equal(settings.remediator_timeout_s, 600);
    assert.equal(settings.baseline_max_age_iterations, 30);
    assert.equal(settings.baseline_max_age_seconds, 14_400);
  } finally {
    fs.rmSync(extRoot, { recursive: true, force: true });
  }
});

// AC-SZGB-08 (mechanism finding): Hypothesis 2 held — a persisted gate baseline with
// `project_type: null` (zero captured checks; observed live in `gate/baseline.json` for session
// `2026-07-02-b3c45331`) was read by the worker-managed convergence seam as a clean pass with
// zero regressions, letting a tsc-RED commit converge silently. anatomy-park shared this defect
// with szechuan-sauce/microverse because both flow through the same shared seam
// (`runPerIterationGateHook` -> `runChangedPerIterationGate`). The tests below prove the
// fail-CLOSED fix: an uncertifiable baseline can no longer certify convergence (AC-SZGB-05), a
// WS-1-resolved target still catches a real typecheck failure end-to-end (AC-SZGB-06), and a
// healthy certifiable baseline is unaffected (AC-SZGB-07).
test('AC-SZGB-05: uncertifiable baseline (project_type: null) blocks worker convergence despite a tsc-RED commit', async () => {
  const workingDir = makeGitRepo('ap-gate-uncertifiable-repo-');
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-gate-uncertifiable-session-'));
  fs.writeFileSync(path.join(workingDir, 'README.md'), 'no project marker here\n');
  commitAll(workingDir, 'initial clean state');

  await ensurePerIterationGateBaseline({
    currentMv: makeMv({ key_metric: undefined }),
    workingDir,
    sessionDir,
    enabledFiles: ['anatomy-park.json'],
    log: () => {},
  });

  const baselinePath = path.join(sessionDir, 'gate', 'baseline.json');
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
  assert.equal(baseline.project_type, null, 'fixture precondition: baseline must be uncertifiable');

  const preIterSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workingDir, encoding: 'utf-8' }).trim();
  // Simulated tsc-RED commit: a real type error. Since the target has no resolvable project it
  // is never actually type-checked — this is exactly the fail-OPEN hole under test.
  fs.writeFileSync(path.join(workingDir, 'broken.ts'), 'let x: number = "s";\n');
  fs.writeFileSync(path.join(sessionDir, 'anatomy-park.json'), JSON.stringify({ converged: true, reason: 'clean passes done' }));
  commitAll(workingDir, 'introduce tsc-RED change under an uncertifiable target');

  const logs = [];
  let writtenMv;
  const result = await handleWorkerManagedIteration({
    ...BASE_OPTS,
    currentMv: makeMv({ key_metric: undefined }),
    preIterSha,
    workingDir,
    sessionDir,
    iteration: 1,
    log: (msg) => logs.push(msg),
    _deps: {
      writeMicroverseStateFn: (_, next) => { writtenMv = next; },
      logActivityFn: () => {},
    },
  });

  assert.equal(result.converged, false, 'an uncertifiable baseline must never certify convergence');
  assert.ok(
    logs.some((msg) => msg.includes('gate: uncertifiable baseline (no project type detected at target) — cannot certify convergence')),
    `expected uncertifiable-baseline log, got: ${JSON.stringify(logs)}`,
  );
  assert.equal(result.currentMv.iteration_regressions, 1, 'uncertifiable-baseline defer must record a regression like a real gate regression');
  assert.equal(writtenMv.iteration_regressions, 1, 'regression state must be persisted before exit');
});

test('AC-SZGB-06: WS-1 project-root resolution surfaces a REAL typecheck failure (resolve -> run -> catch)', async () => {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-gate-ws1-resolve-'));
  try {
    // No project marker at workingDir itself; the ONE resolvable child below is what WS-1's
    // depth-1 resolver (resolveProjectRootOneLevelDown) requires (exactly one candidate).
    writeTypecheckFailureProject(path.join(workingDir, 'child-pkg'));

    const result = await runGate({
      workingDir,
      mode: 'strict',
      scope: 'full',
      checks: ['typecheck'],
    });

    assert.equal(result.status, 'red', 'a project resolved one level down must surface its own typecheck failure, not a silent skip');
    assert.ok(
      result.failures.some((f) => f.check === 'typecheck'),
      `expected a typecheck failure, got: ${JSON.stringify(result.failures)}`,
    );
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('AC-SZGB-07: certifiable baseline (non-null project_type) + clean tree still converges normally', async () => {
  const workingDir = makeGitRepo('ap-gate-certifiable-repo-');
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-gate-certifiable-session-'));
  writeGateFixtureRepo(workingDir);
  commitAll(workingDir, 'initial clean state');

  await ensurePerIterationGateBaseline({
    currentMv: makeMv({ key_metric: undefined }),
    workingDir,
    sessionDir,
    enabledFiles: ['anatomy-park.json'],
    log: () => {},
  });

  const baselinePath = path.join(sessionDir, 'gate', 'baseline.json');
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
  assert.equal(baseline.project_type, 'npm', 'fixture precondition: baseline must be certifiable');

  const preIterSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workingDir, encoding: 'utf-8' }).trim();
  fs.writeFileSync(path.join(sessionDir, 'anatomy-park.json'), JSON.stringify({ converged: true, reason: 'clean passes done' }));
  fs.writeFileSync(path.join(workingDir, 'harmless.txt'), 'no regression here\n');
  commitAll(workingDir, 'harmless clean commit');

  const logs = [];
  const writtenStates = [];
  const result = await handleWorkerManagedIteration({
    ...BASE_OPTS,
    currentMv: makeMv({ key_metric: undefined }),
    preIterSha,
    workingDir,
    sessionDir,
    iteration: 1,
    log: (msg) => logs.push(msg),
    _deps: {
      writeMicroverseStateFn: (_, s) => writtenStates.push(s),
      logActivityFn: () => {},
    },
  });

  assert.equal(result.converged, true, 'a certifiable baseline with a clean tree must converge, unaffected by the new fail-closed check');
  assert.equal(writtenStates.length, 0, 'a clean certifiable pass must not record any regression');
  assert.ok(
    !logs.some((msg) => msg.includes('uncertifiable baseline')),
    `uncertifiable-baseline log must not fire for a certifiable baseline, got: ${JSON.stringify(logs)}`,
  );
});

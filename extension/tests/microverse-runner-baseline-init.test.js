// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensurePerIterationGateBaseline } from '../bin/microverse-runner.js';
import { readRecoverableJsonObject } from '../services/recoverable-json.js';

function tmpDir(prefix = 'pickle-mv-baseline-init-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
    convergence_mode: 'worker',
    convergence_file: 'anatomy-park.json',
    ...overrides,
  };
}

function makeGateResult() {
  return {
    status: 'green',
    failures: [],
    baseline_used: false,
    allowed_paths_used: false,
    elapsed_ms: 10,
    total_raw_failure_count: 0,
    new_failures_vs_baseline: 0,
  };
}

test('baseline init rejects a successful gate run when the baseline file is missing', async () => {
  const workingDir = tmpDir('pickle-mv-baseline-work-');
  const sessionDir = tmpDir('pickle-mv-baseline-session-');
  const logs = [];
  const events = [];

  try {
    await assert.rejects(
      () => ensurePerIterationGateBaseline({
        currentMv: makeMv(),
        workingDir,
        sessionDir,
        enabledFiles: ['anatomy-park.json'],
        log: (msg) => logs.push(msg),
        _deps: {
          runGateFn: async () => makeGateResult(),
          logActivityFn: (event) => events.push(event),
        },
      }),
      /baseline initialization failed/,
    );

    assert.equal(fs.existsSync(path.join(sessionDir, 'gate', 'baseline.json')), false);
    assert.ok(
      logs.some((msg) => msg.includes('baseline initialization failed')),
      `expected failure log, got ${JSON.stringify(logs)}`,
    );
    assert.ok(
      !logs.some((msg) => msg.includes('initialized per-iteration gate baseline')),
      `success log must be gated on disk state, got ${JSON.stringify(logs)}`,
    );
    assert.ok(
      events.some((event) => event.event === 'gate_baseline_init_failed'),
      `expected gate_baseline_init_failed event, got ${JSON.stringify(events)}`,
    );
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('baseline init logs success only after the baseline file exists on disk', async () => {
  const workingDir = tmpDir('pickle-mv-baseline-work-');
  const sessionDir = tmpDir('pickle-mv-baseline-session-');
  const logs = [];
  const events = [];

  try {
    await ensurePerIterationGateBaseline({
      currentMv: makeMv(),
      workingDir,
      sessionDir,
      enabledFiles: ['anatomy-park.json'],
      log: (msg) => logs.push(msg),
      _deps: {
        runGateFn: async ({ baselinePath }) => {
          fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
          fs.writeFileSync(baselinePath, JSON.stringify({ checks: [], failures: [] }, null, 2));
          return makeGateResult();
        },
        logActivityFn: (event) => events.push(event),
      },
    });

    assert.equal(fs.existsSync(path.join(sessionDir, 'gate', 'baseline.json')), true);
    assert.ok(
      logs.some((msg) => msg.includes('initialized per-iteration gate baseline')),
      `expected success log after baseline write, got ${JSON.stringify(logs)}`,
    );
    assert.ok(
      !events.some((event) => event.event === 'gate_baseline_init_failed'),
      `did not expect gate_baseline_init_failed, got ${JSON.stringify(events)}`,
    );
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// AP-BIN-ITER79-01: `gate/baseline.json` is written atomically (persistGateBaseline ->
// writeStateFile, tmp `.tmp.<pid>.<ts>.<seq>`) and read back by every consumer through
// readRecoverableJsonObject, so an interrupted write leaves an orphan that IS the baseline
// to all of them. Both arms below were measured on the shipped compiled runtime before the
// fix. Assert the RESURRECTION and the run's survival, never the return value: the stale arm
// already returned normally and the absent arm already threw, so a "did it throw" oracle
// greens over both defects.
function deadPid() {
  let pid = 999001;
  const alive = (p) => {
    try { process.kill(p, 0); return true; } catch (err) { return err.code === 'EPERM'; }
  };
  while (alive(pid)) pid += 1;
  return pid;
}

function writeBaseline(filePath, marker, capturedIteration, workingDir) {
  fs.writeFileSync(filePath, JSON.stringify({
    schema_version: 1,
    captured_at: new Date().toISOString(),
    captured_iteration: capturedIteration,
    working_dir: workingDir,
    project_type: 'npm',
    checks: [],
    failures: [],
    marker,
  }, null, 2));
}

test('AP-BIN-ITER79-01: a rejected stale baseline stays deleted — its orphan tmp is not promoted back', async () => {
  const sessionDir = tmpDir('pickle-mv-baseline-resurrect-');
  const baselinePath = path.join(sessionDir, 'gate', 'baseline.json');
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });

  try {
    writeBaseline(baselinePath, 'STALE-BASE', 50, sessionDir);
    const orphan = `${baselinePath}.tmp.${deadPid()}.${Date.now()}.7`;
    writeBaseline(orphan, 'ORPHAN', 50, sessionDir);
    // Age the BASE by mtime so assertBaselineFresh throws BaselineStaleError before it ever
    // calls readUsableBaseline — that ordering is what leaves the orphan un-promoted.
    const oldMs = Date.now() - 7 * 24 * 3600 * 1000;
    fs.utimesSync(baselinePath, new Date(oldMs), new Date(oldMs));

    await ensurePerIterationGateBaseline({
      currentMv: makeMv(),
      workingDir: sessionDir,
      sessionDir,
      enabledFiles: ['anatomy-park.json'],
      log: () => {},
      currentIteration: 50,
      baselineMaxAgeIterations: 100,
      baselineMaxAgeSeconds: 60,
      _deps: {
        runGateFn: async () => { throw new Error('recapture failed'); },
        logActivityFn: () => {},
      },
    });

    assert.equal(fs.existsSync(orphan), false, 'the orphan tmp must be removed with the base');

    // A consumer read (isBaselineUncertifiable / readUsableBaseline / maybeEmitComplexityRegression)
    // must not resurrect the baseline the runner just rejected.
    assert.equal(
      readRecoverableJsonObject(baselinePath),
      null,
      'a recovery read must not promote the rejected baseline back onto disk',
    );
    assert.equal(
      fs.existsSync(baselinePath),
      false,
      'gate/baseline.json must stay absent so the post-commit gate falls back to strict mode',
    );
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AP-BIN-ITER79-01: an orphan-only baseline is present, not absent — a capture failure defers instead of killing the run', async () => {
  const sessionDir = tmpDir('pickle-mv-baseline-orphanonly-');
  const baselinePath = path.join(sessionDir, 'gate', 'baseline.json');
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });

  try {
    // No base — a usable baseline sits only in the promotable set, which every reader sees.
    const orphan = `${baselinePath}.tmp.${deadPid()}.${Date.now()}.3`;
    writeBaseline(orphan, 'USABLE-IN-PROMOTABLE-SET', 50, sessionDir);

    // Pre-fix this classified 'absent', so `if (!staleRefresh) throw err` rethrew and the run died.
    await ensurePerIterationGateBaseline({
      currentMv: makeMv(),
      workingDir: sessionDir,
      sessionDir,
      enabledFiles: ['anatomy-park.json'],
      log: () => {},
      currentIteration: 50,
      baselineMaxAgeIterations: 100,
      baselineMaxAgeSeconds: 3600,
      _deps: {
        runGateFn: async () => { throw new Error('recapture failed'); },
        logActivityFn: () => {},
      },
    });
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AP-BIN-ITER79-01 control: a fresh baseline is left intact, orphan and all', async () => {
  const sessionDir = tmpDir('pickle-mv-baseline-fresh-');
  const baselinePath = path.join(sessionDir, 'gate', 'baseline.json');
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });

  try {
    writeBaseline(baselinePath, 'FRESH-BASE', 50, sessionDir);
    const orphan = `${baselinePath}.tmp.${deadPid()}.${Date.now()}.1`;
    writeBaseline(orphan, 'ORPHAN', 50, sessionDir);

    let gateRan = false;
    await ensurePerIterationGateBaseline({
      currentMv: makeMv(),
      workingDir: sessionDir,
      sessionDir,
      enabledFiles: ['anatomy-park.json'],
      log: () => {},
      currentIteration: 50,
      baselineMaxAgeIterations: 100,
      baselineMaxAgeSeconds: 3600,
      _deps: {
        runGateFn: async () => { gateRan = true; return makeGateResult(); },
        logActivityFn: () => {},
      },
    });

    // The fix must not degrade into "always delete and recapture".
    assert.equal(gateRan, false, 'a fresh baseline must short-circuit before any gate run');
    assert.equal(fs.existsSync(baselinePath), true, 'a fresh baseline must survive');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

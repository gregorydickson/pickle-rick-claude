// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

import { classifyMicroverseDisposition, markMicroverseFatalError, finalizeMicroverseRun, dropOutOfSurfaceViolations, measureAndClassifyIteration, _deps } from '../bin/microverse-runner.js';
import { classifyPostFinalVerdict, parseBetweenTicketFastGateFailures, runBetweenTicketFastTests } from '../bin/mux-runner.js';
import { writeMicroverseState, readMicroverseState, createMicroverseState, recordIteration, recordStall, deriveStallCause } from '../services/microverse-state.js';
import { MICROVERSE_EXIT_REASONS, EXIT_REASONS } from '../types/index.js';
import { loadMicroverseJson } from './helpers/microverse-corpora.js';

const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tmpDir(prefix = 'pickle-mv-disposition-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * `MicroverseExitReason` is DERIVED from the runtime `MICROVERSE_EXIT_REASONS` array
 * (`typeof MICROVERSE_EXIT_REASONS[number]`), so the compiled `types/index.js` carries the
 * membership as real data — no doc-comment mirror to scrape and no way for the two to drift.
 *
 * Enumerating it is what makes the completeness test below real. An earlier assertion counted
 * `EXPECTED`'s own keys against a hardcoded 18, so a 19th union member could ship without ever
 * reddening the test named to prevent exactly that.
 */
function readUnionMembersFromMirror() {
  assert.ok(MICROVERSE_EXIT_REASONS.length > 0, 'MICROVERSE_EXIT_REASONS must enumerate at least one member');
  return new Set(MICROVERSE_EXIT_REASONS);
}

// AC-J1 (B-JUDGESCOPE db605b05): the judge review-surface derivation reuses the existing
// 'metric_unmeasurable_unrecoverable' member for a fail-closed reason — it must add NO member.
// tsc stays green when a const array is widened, so this invariant is pinned by the test alone;
// an explicit count assertion (not merely "the string is absent") is what AC-J4-2 requires.
test('MICROVERSE_EXIT_REASONS gains no member for the judge review-surface fail-closed path', () => {
  assert.equal(MICROVERSE_EXIT_REASONS.length, 17, 'member count must stay unchanged — a widened array still type-checks');
  assert.ok(MICROVERSE_EXIT_REASONS.includes('metric_unmeasurable_unrecoverable'), 'the fail-closed path reuses this existing member');
});

/** The same membership, read from the TS source of truth rather than the compiled array. */
function readUnionMembersFromSource(srcTypesPath) {
  const source = fs.readFileSync(srcTypesPath, 'utf-8');
  const start = source.indexOf('export const MICROVERSE_EXIT_REASONS = [');
  assert.ok(start !== -1, 'MICROVERSE_EXIT_REASONS must be present in src/types/index.ts');
  const block = source.slice(start, source.indexOf('];', start));
  return new Set([...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
}

const EXPECTED = {
  converged: { reportAs: 'success', exitCode: 0 },
  stalled_below_target: { reportAs: 'non-convergent', exitCode: 1 },
  iteration_budget_exhausted: { reportAs: 'non-convergent', exitCode: 1 },
  time_budget_exhausted: { reportAs: 'non-convergent', exitCode: 1 },
  limit_reached: { reportAs: 'non-convergent', exitCode: 1 },
  no_progress: { reportAs: 'non-convergent', exitCode: 1 },
  stopped: { reportAs: 'non-convergent', exitCode: 1 },
  approach_exhaustion: { reportAs: 'non-convergent', exitCode: 1 },
  anatomy_non_convergent: { reportAs: 'non-convergent', exitCode: 1 },
  rate_limit_exhausted: { reportAs: 'failure', exitCode: 1 },
  error: { reportAs: 'failure', exitCode: 1 },
  judge_unreachable: { reportAs: 'failure', exitCode: 1 },
  judge_timeout: { reportAs: 'non-fatal-halt', exitCode: 1 },
  all_judge_backends_exhausted: { reportAs: 'non-fatal-halt', exitCode: 1 },
  metric_unmeasurable_transient: { reportAs: 'non-fatal-halt', exitCode: 1 },
  metric_unmeasurable_unrecoverable: { reportAs: 'failure', exitCode: 1 },
  judge_cli_missing: { reportAs: 'failure', exitCode: 1 },
};

for (const [reason, expected] of Object.entries(EXPECTED)) {
  test(`classifyMicroverseDisposition('${reason}') matches the WS-5 table`, () => {
    assert.deepEqual(classifyMicroverseDisposition(reason), expected);
  });
}

test('every MicroverseExitReason member is covered by EXPECTED (fixture completeness)', () => {
  // Derived from the union itself, not a hardcoded count: a new exit reason that nobody adds
  // to EXPECTED fails HERE, and the diff names the missing member instead of reporting
  // "expected 18, got 19".
  assert.deepEqual(new Set(Object.keys(EXPECTED)), readUnionMembersFromMirror());
});

// Source and compiled now share ONE declaration, so lockstep holds by construction rather than
// by discipline — this pins that `npx tsc` was actually run, catching a stale compiled tree.
// In a deployed tree `src/` is absent and there is nothing to compare.
test('the compiled array stays in lockstep with the TS source (in-repo only)', (t) => {
  const srcTypesPath = path.join(EXTENSION_ROOT, 'src', 'types', 'index.ts');
  if (!fs.existsSync(srcTypesPath)) {
    t.skip('src/types/index.ts absent — deployed tree, no source to compare');
    return;
  }
  assert.deepEqual(readUnionMembersFromMirror(), readUnionMembersFromSource(srcTypesPath));
});

test('an unknown exit reason classifies non-success through classifyMicroverseDisposition', () => {
  assert.deepEqual(classifyMicroverseDisposition('totally_unrecognized_reason'), {
    reportAs: 'non-success',
    exitCode: 1,
  });
});

for (const giveUp of ['approach_exhaustion', 'no_progress', 'stopped', 'limit_reached']) {
  test(`give-up reason '${giveUp}' returns exit code 1 (non-success), not converged`, () => {
    const disposition = classifyMicroverseDisposition(giveUp);
    assert.equal(disposition.exitCode, 1);
    assert.notEqual(disposition.reportAs, 'success');
  });
}

test('only converged returns exit code 0', () => {
  for (const reason of Object.keys(EXPECTED)) {
    const disposition = classifyMicroverseDisposition(reason);
    if (reason === 'converged') {
      assert.equal(disposition.exitCode, 0);
    } else {
      assert.equal(disposition.exitCode, 1, `${reason} should be exit code 1`);
    }
  }
});

test('markMicroverseFatalError preserves converged (success) via the single map', () => {
  const sessionDir = tmpDir();
  try {
    const mvPath = path.join(sessionDir, 'microverse.json');
    fs.writeFileSync(mvPath, JSON.stringify({ status: 'converged', exit_reason: 'converged' }, null, 2));
    assert.equal(markMicroverseFatalError(sessionDir), 'preserved');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('markMicroverseFatalError overwrites a non-success give-up reason (no_progress)', () => {
  const sessionDir = tmpDir();
  try {
    const mvPath = path.join(sessionDir, 'microverse.json');
    fs.writeFileSync(mvPath, JSON.stringify({ status: 'iterating', exit_reason: 'no_progress' }, null, 2));
    assert.equal(markMicroverseFatalError(sessionDir), 'overwritten');
    const mv = JSON.parse(fs.readFileSync(mvPath, 'utf-8'));
    assert.equal(mv.exit_reason, 'error');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('markMicroverseFatalError overwrites the dead legacy "completed"/"success" strings (no longer special-cased)', () => {
  for (const legacyReason of ['completed', 'success']) {
    const sessionDir = tmpDir();
    try {
      const mvPath = path.join(sessionDir, 'microverse.json');
      fs.writeFileSync(mvPath, JSON.stringify({ status: 'iterating', exit_reason: legacyReason }, null, 2));
      assert.equal(markMicroverseFatalError(sessionDir), 'overwritten');
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  }
});

test('markMicroverseFatalError overwrites an unknown exit reason (no fallthrough)', () => {
  const sessionDir = tmpDir();
  try {
    const mvPath = path.join(sessionDir, 'microverse.json');
    fs.writeFileSync(mvPath, JSON.stringify({ status: 'iterating', exit_reason: 'totally_unrecognized_reason' }, null, 2));
    assert.equal(markMicroverseFatalError(sessionDir), 'overwritten');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// B-NONSTOP WS-5 regression (ticket 5f076d7c): the finalize fallback must stamp the
// disposition into state.json. `microverse.json` is written BEFORE the try, so a bare
// `safeDeactivate` in the catch leaves the two surfaces disagreeing — state.json has no
// exit_reason, `finalizePhaseSuccess`'s `typeof exitReason === 'string'` guard falls
// through, and a NON-CONVERGENT phase gets counted as a clean success (fake-green).
test('finalize fallback stamps the disposition into state.json when finalizeTerminalState throws', () => {
  const sessionDir = tmpDir();
  const realFinalize = _deps.finalizeTerminalState;
  try {
    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ active: true, exit_reason: null }, null, 2));

    // Force the documented degraded path.
    _deps.finalizeTerminalState = () => { throw new Error('injected lock failure'); };

    const outcome = {
      state: { status: 'iterating', exit_reason: null, history: [], failed_approaches: [], failure_history: [] },
      exitReason: 'approach_exhaustion',
      iterations: 4,
      elapsedSeconds: 12,
    };
    // ctx carries only what the finalizer reads: statePath + iteration.
    finalizeMicroverseRun(sessionDir, { statePath, iteration: 4 }, outcome, () => {});

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const mv = JSON.parse(fs.readFileSync(path.join(sessionDir, 'microverse.json'), 'utf-8'));

    // The finding is a DIVERGENCE, so pin both surfaces, not just one.
    assert.equal(state.exit_reason, 'approach_exhaustion');
    assert.equal(mv.exit_reason, 'approach_exhaustion');
    assert.equal(state.exit_reason, mv.exit_reason);
  } finally {
    _deps.finalizeTerminalState = realFinalize;
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// da44ff00 (AC-J3-4): the drop count `dropOutOfSurfaceViolations` returns must reach the
// persisted phase artifact (microverse.json), not merely an in-memory return value — the same
// carries-into-the-artifact discipline every other WS-5 disposition test in this file already
// pins for `exit_reason`.
//
// e562164b: this case used to perform the accumulation itself (`mv.out_of_surface_findings_dropped
// += droppedCount` in the test body), so removing the runtime accumulation left it GREEN. It now
// drives the real consume path — `measureAndClassifyIteration` over a scoped llm session — and
// reads the count back from disk, seeded non-zero so an overwrite is told apart from an add.
const AC_J3_4_DIFF = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -9,1 +9,1 @@',
  '-old',
  '+new',
].join('\n');

test('AC-J3-4: dropOutOfSurfaceViolations.droppedCount round-trips through microverse.json', async () => {
  const sessionDir = tmpDir();
  const workingDir = tmpDir('pickle-mv-disposition-work-');
  const violations = [
    { id: 'pre', path: 'src/foo.ts', line: 3, severity: 'low', description: 'pre-existing, dropped' },
    { id: 'touched', path: 'src/foo.ts', line: 9, severity: 'low', description: 'touched, kept' },
  ];
  const surface = { kind: 'derived', paths: ['src/foo.ts'], base: 'f'.repeat(40) };
  const originalSpawn = _deps.spawnSync;
  const originalExec = _deps.execFileSync;
  // git diff shows only line 9 of src/foo.ts as touched; every other spawn is the real one.
  _deps.spawnSync = (cmd, args, opts) => (cmd === 'git' && Array.isArray(args) && args.includes('diff')
    ? { status: 0, stdout: AC_J3_4_DIFF }
    : originalSpawn(cmd, args, opts));
  process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = '1';
  _deps.execFileSync = (_cmd, args) => (Array.isArray(args) && args[0] === '--version'
    ? 'Claude Code 2.1.126'
    : JSON.stringify({ score: 2, violations, resolved: [], new: ['pre', 'touched'], remaining: [] }));
  try {
    assert.equal(
      dropOutOfSurfaceViolations(violations, surface, workingDir).droppedCount,
      1,
      'the return value itself must carry the count',
    );

    fs.writeFileSync(path.join(sessionDir, 'scope.json'), JSON.stringify({
      version: 1, mode: 'branch', base_sha: surface.base, allowed_paths: surface.paths,
    }));
    const runnerState = {
      active: true, working_dir: workingDir, step: 'implement', iteration: 0, max_iterations: 10,
      max_time_minutes: 60, worker_timeout_seconds: 0, start_time_epoch: Math.floor(Date.now() / 1000),
      completion_promise: null, original_prompt: 'test', current_ticket: null, history: [],
      started_at: new Date().toISOString(), session_dir: sessionDir, tmux_mode: true,
      command_template: 'microverse.md', backend: 'claude',
    };
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(runnerState, null, 2));
    const mv = createMicroverseState({
      prdPath: path.join(workingDir, 'prd.md'),
      metric: { description: 'x', validation: 'x', type: 'llm', timeout_seconds: 60, tolerance: 0, direction: 'lower', judge_model: 'claude-sonnet-4-6' },
      stallLimit: 3,
    });
    mv.status = 'iterating';
    mv.baseline_score = 2;
    mv.out_of_surface_findings_dropped = 2;
    writeMicroverseState(sessionDir, mv);

    await measureAndClassifyIteration(mv, { raw: '2', score: 2 }, {
      sessionDir, workingDir, extensionRoot: EXTENSION_ROOT, statePath: path.join(sessionDir, 'state.json'),
      startTime: Date.now(), initialIteration: 0, enableFailureClassification: false,
      cgSettings: { enabled_convergence_files: [], regression_warning_threshold: 5, remediator_timeout_s: 600, baseline_max_age_iterations: 30, baseline_max_age_seconds: 14_400 },
      rateLimitWaitMinutes: 0, maxRateLimitRetries: 0, log: () => {}, currentRunnerState: runnerState,
      iteration: 1, consecutiveRateLimits: 0, preIterSha: 'a'.repeat(40), postIterSha: 'b'.repeat(40),
    });

    assert.equal(
      readMicroverseState(sessionDir).out_of_surface_findings_dropped,
      3,
      'the runtime must ADD this pass\'s drop to the persisted count and write it to the phase artifact on disk',
    );
  } finally {
    _deps.spawnSync = originalSpawn;
    _deps.execFileSync = originalExec;
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// cfc530c6 (AC-J4-1..5): stalled_below_target names the mechanism that exhausted the stall
// budget, derived from ONE named field (`convergence.last_stall_signal`), never guessed from
// `history` shape or `iteration_regressions`. See `deriveStallCause` in
// `../services/microverse-state.js`.
// ---------------------------------------------------------------------------------------------

function makeCauseState() {
  return createMicroverseState({
    prdPath: '/tmp/prd.md',
    metric: {
      description: 'test metric',
      validation: 'cat score.txt',
      type: 'command',
      timeout_seconds: 60,
      tolerance: 0,
      direction: 'higher',
    },
    stallLimit: 5,
  });
}

function makeCauseHistoryEntry(overrides = {}) {
  return {
    iteration: 1,
    metric_value: '0',
    score: 0,
    action: 'revert',
    description: 'test entry',
    pre_iteration_sha: 'abc123',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

test('deriveStallCause covers improved via recordIteration', () => {
  let mv = makeCauseState();
  mv = recordIteration(mv, makeCauseHistoryEntry({ action: 'accept' }), 'improved');
  const disposition = deriveStallCause(mv, 7);
  assert.equal(disposition.cause, 'improved');
  assert.equal(disposition.inputs.last_stall_signal, 'improved');
  assert.equal(disposition.inputs.iteration, 7);
});

test('deriveStallCause covers held via recordIteration', () => {
  let mv = makeCauseState();
  mv = recordIteration(mv, makeCauseHistoryEntry({ action: 'accept' }), 'held');
  const disposition = deriveStallCause(mv, 3);
  assert.equal(disposition.cause, 'held');
  assert.equal(disposition.inputs.last_stall_signal, 'held');
});

test('deriveStallCause covers regressed via recordIteration', () => {
  let mv = makeCauseState();
  mv = recordIteration(mv, makeCauseHistoryEntry({ action: 'revert' }), 'regressed');
  const disposition = deriveStallCause(mv, 5);
  assert.equal(disposition.cause, 'regressed');
  assert.equal(disposition.inputs.last_stall_signal, 'regressed');
});

test('deriveStallCause covers no-commit via recordStall', () => {
  let mv = makeCauseState();
  mv = recordStall(mv);
  const disposition = deriveStallCause(mv, 2);
  assert.equal(disposition.cause, 'no-commit');
  assert.equal(disposition.inputs.last_stall_signal, 'no-commit');
});

test('recordStall overwrites a stale improved signal — the four-improving-then-five-no-commit scenario', () => {
  let mv = makeCauseState();
  mv = recordIteration(mv, makeCauseHistoryEntry({ iteration: 1, action: 'accept' }), 'improved');
  // Five subsequent no-commit stalls must NOT leave the stale 'improved' signal in place.
  for (let i = 0; i < 5; i++) mv = recordStall(mv);
  const disposition = deriveStallCause(mv, 6);
  assert.equal(disposition.cause, 'no-commit');
});

test('EXIT_REASONS.length is unchanged — assert the count, not string absence', () => {
  assert.equal(EXIT_REASONS.length, 20);
});

test('derivation inputs, including the iteration number, are persisted with the cause', () => {
  let mv = makeCauseState();
  mv = recordStall(mv);
  const disposition = deriveStallCause(mv, 42);
  assert.deepEqual(disposition.inputs, { last_stall_signal: 'no-commit', iteration: 42 });
});

test('an underivable cause (non-empty legacy history, no last_stall_signal) reports unknown with its inputs, never guessed', () => {
  const mv = makeCauseState();
  mv.convergence.history = [makeCauseHistoryEntry({ classification: 'regressed' })];
  // last_stall_signal deliberately absent (legacy shape).
  const disposition = deriveStallCause(mv, 9);
  assert.equal(disposition.cause, 'unknown');
  assert.equal(disposition.inputs.last_stall_signal, null);
  assert.equal(disposition.inputs.iteration, 9);
});

test('replaying both vendored sessions renders DIFFERENT causes', () => {
  const a4d141e1 = loadMicroverseJson('2026-09-12-a4d141e1');
  const c5a7eb48 = loadMicroverseJson('2026-09-15-c5a7eb48');

  assert.equal(a4d141e1.exit_reason, 'stalled_below_target');
  assert.equal(c5a7eb48.exit_reason, 'stalled_below_target');
  assert.equal(a4d141e1.convergence.history.length, 1);
  assert.equal(c5a7eb48.convergence.history.length, 0);

  const causeA = deriveStallCause(a4d141e1, 2).cause;
  const causeB = deriveStallCause(c5a7eb48, 0).cause;

  assert.notEqual(causeA, causeB);
  // Documented, not incidental: non-empty legacy history with no live signal is unknown
  // (the ticket's forbidden "history.length > 0 implies regression" discriminator is never
  // built); empty legacy history is a sound backfill to 'no-commit', since recordIteration
  // appends unconditionally and so an empty history proves no scored iteration ever ran.
  assert.equal(causeA, 'unknown');
  assert.equal(causeB, 'no-commit');
});

// ---------------------------------------------------------------------------------------------
// b0c8b863 (AC-T1-1, AC-T1-6): `916b6489` made test-runner.ts stamp
// `[test-runner] child terminated by signal <SIG>` on stderr when its spawned child dies by
// signal. This carries that attribution into `state.post_final_verdict.dimensions` — the field a
// human or a later run actually reads — without touching `state`/`degraded`/the withhold
// decision, which stay decided purely by `gate.ok`/`gate.measured`/`reported_zero_failures`.
// ---------------------------------------------------------------------------------------------

const SIGNAL_KILLED_OUTPUT = [
  '> pickle-rick-scripts@2.1.0 test:fast',
  '> npm run test:fast:parallel; p=$?; npm run test:fast:serial; s=$?',
  '',
  '> pickle-rick-scripts@2.1.0 test:fast:parallel',
  '> node bin/test-runner.js --tier fast --manifest tests/.serial-tests.json --manifest-mode exclude --test-concurrency=8',
  '',
  '[test-runner] child terminated by signal SIGTERM',
].join('\n');

const GENUINE_FAILURE_OUTPUT = [
  '> pickle-rick-scripts@2.1.0 test:fast:parallel',
  '> node bin/test-runner.js --tier fast',
  'not ok 1 - widget explodes',
  '  ---',
  "  location: '/repo/tests/widget.test.js:3:1'",
  '  ...',
  '# tests 1',
  '# fail 1',
].join('\n');

test('a signal-terminated tier measurement records the signal in post_final_verdict.dimensions', () => {
  const failures = parseBetweenTicketFastGateFailures(SIGNAL_KILLED_OUTPUT, '/repo');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].script_failure, true);
  assert.equal(failures[0].name, 'script failure: test:fast:parallel (signal: SIGTERM)');

  const result = classifyPostFinalVerdict({
    gate: { ok: false, failures, timed_out: false, timeout_ms: null, measured: false },
    applicable: true,
    verdictTs: 200,
    finalCommitTs: 100,
    baselineFailures: [],
  });
  assert.deepEqual(result.dimensions, ['script failure: test:fast:parallel (signal: SIGTERM)']);
});

test('a tier that genuinely failed records its dimensions exactly as today (no signal suffix)', () => {
  const failures = parseBetweenTicketFastGateFailures(GENUINE_FAILURE_OUTPUT, '/repo');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].script_failure, undefined, 'a real TAP failure is never marked script_failure');
  assert.equal(failures[0].name, 'widget explodes');

  const result = classifyPostFinalVerdict({
    gate: { ok: false, failures, timed_out: false, timeout_ms: null, measured: true },
    applicable: true,
    verdictTs: 200,
    finalCommitTs: 100,
    baselineFailures: [],
  });
  assert.deepEqual(result.dimensions, ['widget explodes']);
});

test('the degraded flag and the withhold decision are unchanged by signal attribution in either case', () => {
  const signalFailures = parseBetweenTicketFastGateFailures(SIGNAL_KILLED_OUTPUT, '/repo');
  const signalResult = classifyPostFinalVerdict({
    gate: { ok: false, failures: signalFailures, timed_out: false, timeout_ms: null, measured: false },
    applicable: true,
    verdictTs: 200,
    finalCommitTs: 100,
    baselineFailures: [],
  });
  assert.equal(signalResult.state, 'red');
  assert.equal(signalResult.degraded, true, 'a withheld verdict is unaffected by the dimension string content');

  const genuineFailures = parseBetweenTicketFastGateFailures(GENUINE_FAILURE_OUTPUT, '/repo');
  const genuineResult = classifyPostFinalVerdict({
    gate: { ok: false, failures: genuineFailures, timed_out: false, timeout_ms: null, measured: true },
    applicable: true,
    verdictTs: 200,
    finalCommitTs: 100,
    baselineFailures: [],
  });
  assert.equal(genuineResult.state, 'red');
  assert.equal(genuineResult.degraded, true);

  // Both cases classify identically to `state:'red', degraded:true` — the signal attribution
  // changed only the STRING inside `dimensions`, never the verdict this ticket must leave alone.
  assert.equal(signalResult.state, genuineResult.state);
  assert.equal(signalResult.degraded, genuineResult.degraded);
});

// ---------------------------------------------------------------------------------------------
// Wiring (ticket 69d099f1, B-TRUTHEXIT): the tests above prove parseBetweenTicketFastGateFailures
// and classifyPostFinalVerdict handle a HAND-AUTHORED SIGNAL_KILLED_OUTPUT string correctly — but
// that fixture could drift from what test-runner.ts actually emits without ever reddening. This
// drives a REAL bin/test-runner.js child, kills its own spawned test process with a real signal,
// and feeds the REAL captured stdout+stderr — combined exactly as runBetweenTicketFastTests
// builds its `output` (`${stdout}\n${stderr}`) — through the real, unmocked parse and classify
// functions. No hand-authored signal-line text enters this test.
// ---------------------------------------------------------------------------------------------

const WIRING_TEST_RUNNER_JS = path.join(EXTENSION_ROOT, 'bin', 'test-runner.js');

function wiringSleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function wiringWaitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true;
    wiringSleepSync(20);
  }
  return false;
}

/** Mirrors test-runner-timeout.test.js's findInnerChildPid: locates test-runner.js's direct spawnSync child. */
function wiringFindInnerChildPid(outerPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = execFileSync('ps', ['-o', 'pid,ppid,command', '-ax'], { encoding: 'utf8', timeout: 5000 });
    for (const line of out.split('\n').slice(1)) {
      const match = /^\s*(\d+)\s+(\d+)\s/.exec(line);
      if (match && Number(match[2]) === outerPid) return Number(match[1]);
    }
    wiringSleepSync(50);
  }
  return null;
}

function spawnRealTestRunner(fixture) {
  // Scrub NODE_TEST_CONTEXT/NODE_TEST_WORKER_ID: this file runs under `node --test` itself,
  // and those two vars leaking into the spawned child change its reporting behavior (mirrors
  // test-runner-timeout.test.js's spawnRunner()).
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const child = spawn(process.execPath, [WIRING_TEST_RUNNER_JS, fixture], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
    env,
  });
  const captured = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { captured.stdout += chunk; });
  child.stderr.on('data', (chunk) => { captured.stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
  return { child, captured, closed };
}

test('wiring: a REAL signal-killed test-runner.js child\'s captured output reaches post_final_verdict.dimensions through the real parse and classify path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-wiring-signal-'));
  const marker = path.join(dir, 'marker');
  const fixture = path.join(dir, 'slow.test.js');
  try {
    fs.writeFileSync(
      fixture,
      [
        "import { test } from 'node:test';",
        "import { writeFileSync } from 'node:fs';",
        "test('slow', async () => {",
        `  writeFileSync(${JSON.stringify(marker)}, 'started');`,
        '  await new Promise((resolve) => setTimeout(resolve, 30000));',
        '});',
      ].join('\n'),
    );

    const { child, captured, closed } = spawnRealTestRunner(fixture);

    assert.ok(wiringWaitForFile(marker, 10000), 'fixture test must start and write its marker');
    const innerPid = wiringFindInnerChildPid(child.pid, 10000);
    assert.ok(innerPid, "must resolve the runner's direct spawnSync child pid");
    process.kill(innerPid, 'SIGKILL');

    const code = await closed;
    assert.notEqual(code, 0, 'a signal-terminated child must exit non-zero');
    assert.match(
      captured.stderr,
      /\[test-runner\] child terminated by signal SIGKILL/,
      'sanity: the real producer (test-runner.ts) must emit its own signal-attribution line',
    );

    // Combine exactly as runBetweenTicketFastTests builds `output`.
    const output = `${captured.stdout}\n${captured.stderr}`;

    const failures = parseBetweenTicketFastGateFailures(output, dir);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].script_failure, true);
    assert.match(
      failures[0].name,
      /\(signal: SIGKILL\)$/,
      'the real parser must attribute the REAL captured signal line — not a hand-authored one',
    );

    const result = classifyPostFinalVerdict({
      gate: { ok: false, failures, timed_out: false, timeout_ms: null, measured: false },
      applicable: true,
      verdictTs: 200,
      finalCommitTs: 100,
      baselineFailures: [],
    });
    assert.equal(result.dimensions.length, 1);
    assert.match(
      result.dimensions[0],
      /\(signal: SIGKILL\)$/,
      'a real killed tier must reach post_final_verdict.dimensions naming the real signal, end to end',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// d5b5add3 (AC-T1-3, the fail direction end to end): the hand-authored GENUINE_FAILURE_OUTPUT above
// parses to a TAP name and never reaches the attribution, so it stays GREEN under an always-attribute
// producer or parser. A REAL failing test-runner child parses as a script failure — the attribution IS
// reached — so this control reds if either side invents a signal the child never died by.
test('wiring (control): a REAL genuinely-failing test-runner.js child reaches post_final_verdict.dimensions with no signal attribution', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-wiring-fail-'));
  const fixture = path.join(dir, 'fail.test.js');
  try {
    fs.writeFileSync(
      fixture,
      [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "test('fails', () => { assert.fail('boom'); });",
      ].join('\n'),
    );

    const { captured, closed } = spawnRealTestRunner(fixture);
    const code = await closed;
    assert.equal(code, 1, 'a genuinely failing tier exits 1');

    const failures = parseBetweenTicketFastGateFailures(`${captured.stdout}\n${captured.stderr}`, dir);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].script_failure, true, 'the real output must reach the attribution, or this control is vacuous');

    const result = classifyPostFinalVerdict({
      gate: { ok: false, failures, timed_out: false, timeout_ms: null, measured: true },
      applicable: true,
      verdictTs: 200,
      finalCommitTs: 100,
      baselineFailures: [],
    });
    assert.equal(result.dimensions.length, 1);
    assert.doesNotMatch(result.dimensions[0], /\(signal:/, 'a genuine failure must not be attributed to a signal');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Audit 4ee9ef19 (B-TRUTHEXIT data-flow): the hop AFTER test-runner. When the gate's OWN child —
// `npm run test:fast` — dies by signal, no test-runner stderr line exists to attribute it, so
// `runBetweenTicketFastTests` must carry its own `SpawnSyncReturns.signal` into the dimension.
// Driven through the REAL gate with a PATH `npm` shim; the exit-1 control proves the suffix is
// keyed on the signal, not on the failure.
// ---------------------------------------------------------------------------------------------

function runGateWithNpmShim(shimBody) {
  const root = tmpDir('pickle-gate-signal-');
  const extensionDir = path.join(root, 'extension');
  const shimDir = path.join(root, 'bin');
  fs.mkdirSync(extensionDir, { recursive: true });
  fs.mkdirSync(shimDir, { recursive: true });
  const shim = path.join(shimDir, 'npm');
  fs.writeFileSync(shim, `#!/bin/sh\necho "ℹ tests 5"\necho "ℹ pass 5"\necho "ℹ fail 0"\n${shimBody}\n`);
  fs.chmodSync(shim, 0o755);
  const originalPath = process.env.PATH;
  const originalTimeout = process.env.PICKLE_WORKER_TEST_FAST_TIMEOUT_MS;
  process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ''}`;
  delete process.env.PICKLE_WORKER_TEST_FAST_TIMEOUT_MS;
  try {
    const gate = runBetweenTicketFastTests(extensionDir, root, 30000);
    const verdict = classifyPostFinalVerdict({
      gate, applicable: true, verdictTs: 200, finalCommitTs: 100, baselineFailures: [],
    });
    return { gate, verdict };
  } finally {
    process.env.PATH = originalPath;
    if (originalTimeout === undefined) delete process.env.PICKLE_WORKER_TEST_FAST_TIMEOUT_MS;
    else process.env.PICKLE_WORKER_TEST_FAST_TIMEOUT_MS = originalTimeout;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('audit 4ee9ef19: a gate whose own npm child is SIGKILLed names the signal in post_final_verdict.dimensions', { skip: process.platform === 'win32' }, () => {
  const { gate, verdict } = runGateWithNpmShim('kill -KILL $$');
  assert.equal(gate.ok, false, 'a killed tier is still not green (AC-T1-4)');
  assert.equal(gate.failures.length, 1);
  assert.match(gate.failures[0].name, /\(signal: SIGKILL\)$/, 'the gate spawn\'s own signal must reach the failure name');
  assert.equal(verdict.state, 'inconclusive', 'attribution must not move the disposition (AC-T1-6)');
  assert.equal(verdict.degraded, true);
  assert.deepEqual(verdict.dimensions, [gate.failures[0].name]);
});

test('audit 4ee9ef19: a gate whose npm child exits 1 carries no signal attribution (control)', { skip: process.platform === 'win32' }, () => {
  const { gate, verdict } = runGateWithNpmShim('exit 1');
  assert.equal(gate.ok, false);
  assert.equal(gate.failures.length, 1);
  assert.doesNotMatch(gate.failures[0].name, /\(signal:/, 'no signal ⇒ no attribution; absent must stay distinguishable');
  assert.equal(verdict.state, 'inconclusive');
});

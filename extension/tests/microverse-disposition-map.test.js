// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyMicroverseDisposition, markMicroverseFatalError, finalizeMicroverseRun, dropOutOfSurfaceViolations, _deps } from '../bin/microverse-runner.js';
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
test('AC-J3-4: dropOutOfSurfaceViolations.droppedCount round-trips through microverse.json', () => {
  const sessionDir = tmpDir();
  try {
    const originalSpawn = _deps.spawnSync;
    _deps.spawnSync = () => ({
      status: 0,
      // git diff shows only line 9 of src/foo.ts as touched.
      stdout: [
        'diff --git a/src/foo.ts b/src/foo.ts',
        '--- a/src/foo.ts',
        '+++ b/src/foo.ts',
        '@@ -9,1 +9,1 @@',
        '-old',
        '+new',
      ].join('\n'),
    });
    let dropped;
    try {
      dropped = dropOutOfSurfaceViolations(
        [
          { id: 'pre', path: 'src/foo.ts', line: 3, severity: 'low', description: 'pre-existing, dropped' },
          { id: 'touched', path: 'src/foo.ts', line: 9, severity: 'low', description: 'touched, kept' },
        ],
        { kind: 'derived', paths: ['src/foo.ts'], base: 'f'.repeat(40) },
        sessionDir,
      );
    } finally {
      _deps.spawnSync = originalSpawn;
    }
    assert.equal(dropped.droppedCount, 1, 'the return value itself must carry the count');

    const mv = createMicroverseState({
      prdPath: '/tmp/prd.md',
      metric: { description: 'x', validation: 'x', type: 'llm', timeout_seconds: 60, tolerance: 0 },
      stallLimit: 3,
    });
    mv.out_of_surface_findings_dropped = (mv.out_of_surface_findings_dropped ?? 0) + dropped.droppedCount;
    writeMicroverseState(sessionDir, mv);

    const persisted = readMicroverseState(sessionDir);
    assert.equal(
      persisted.out_of_surface_findings_dropped,
      1,
      'the count must reach the phase artifact on disk, not merely an in-memory field',
    );
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
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

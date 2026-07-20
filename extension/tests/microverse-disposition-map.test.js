// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyMicroverseDisposition, markMicroverseFatalError, finalizeMicroverseRun, _deps } from '../bin/microverse-runner.js';
import { MICROVERSE_EXIT_REASONS } from '../types/index.js';

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
  baseline_unmeasurable_transient: { reportAs: 'non-fatal-halt', exitCode: 1 },
  baseline_unmeasurable: { reportAs: 'failure', exitCode: 1 },
  baseline_unmeasurable_unrecoverable: { reportAs: 'failure', exitCode: 1 },
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

// @tier: integration
/**
 * microverse-convergence.test.js — Integration tests for microverse convergence state machine.
 *
 * Tests the full read/write cycle and convergence logic with real tmpdir filesystem.
 * All recordIteration/recordStall/recordFailedApproach functions return new state (immutable).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createMicroverseState,
  recordIteration,
  recordStall,
  recordFailedApproach,
  isConverged,
  writeMicroverseState,
  readMicroverseState,
  compareMetric,
} from '../../services/microverse-state.js';

const TEST_METRIC = {
  description: 'integration test score',
  validation: 'echo 50',
  type: 'command',
  timeout_seconds: 30,
  tolerance: 2,
};

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mv-'));
}

// ---------------------------------------------------------------------------
// createMicroverseState + isConverged
// ---------------------------------------------------------------------------

test('MV-int-1: createMicroverseState produces a valid initial state persisted to disk', () => {
  const dir = tmpDir();
  try {
    const state = createMicroverseState({ prdPath: 'prd.md', metric: TEST_METRIC, stallLimit: 3 });
    writeMicroverseState(dir, state);

    const restored = readMicroverseState(dir);
    assert.ok(restored !== null, 'state should persist and be readable');
    assert.equal(restored.key_metric.description, TEST_METRIC.description);
    assert.equal(restored.convergence.stall_limit, 3);
    assert.equal(restored.convergence.stall_counter, 0);
    assert.equal(isConverged(restored), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MV-int-2: isConverged returns false when stall_counter < stall_limit', () => {
  const dir = tmpDir();
  try {
    let state = createMicroverseState({ prdPath: 'prd.md', metric: TEST_METRIC, stallLimit: 3 });
    state = { ...state, convergence: { ...state.convergence, stall_counter: 2 } };
    writeMicroverseState(dir, state);
    assert.equal(isConverged(readMicroverseState(dir)), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MV-int-3: isConverged returns true when stall_counter >= stall_limit', () => {
  const dir = tmpDir();
  try {
    let state = createMicroverseState({ prdPath: 'prd.md', metric: TEST_METRIC, stallLimit: 3 });
    state = { ...state, convergence: { ...state.convergence, stall_counter: 3 } };
    writeMicroverseState(dir, state);
    assert.equal(isConverged(readMicroverseState(dir)), 'stall');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// recordIteration — real filesystem round-trips (immutable state)
// ---------------------------------------------------------------------------

test('MV-int-4: improve → stall → stall convergence cycle with real tmpdir', () => {
  const dir = tmpDir();
  try {
    let state = createMicroverseState({ prdPath: 'prd.md', metric: TEST_METRIC, stallLimit: 2 });
    state = { ...state, baseline_score: 50 };

    // Iteration 1: improve (score rises well above tolerance)
    state = recordIteration(state, { score: 60, iteration: 1, sha: 'abc001', action: 'accept' });
    writeMicroverseState(dir, state);
    assert.equal(readMicroverseState(dir).convergence.stall_counter, 0, 'improvement resets stall counter');

    // Iteration 2: hold (within tolerance of last accepted)
    state = readMicroverseState(dir);
    state = recordIteration(state, { score: 61, iteration: 2, sha: 'abc002' });
    writeMicroverseState(dir, state);
    assert.equal(readMicroverseState(dir).convergence.stall_counter, 1, 'hold increments stall counter');

    // Iteration 3: hold again → converged
    state = readMicroverseState(dir);
    state = recordIteration(state, { score: 62, iteration: 3, sha: 'abc003' });
    writeMicroverseState(dir, state);
    assert.equal(isConverged(readMicroverseState(dir)), 'stall', 'should converge after stall_limit holds');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MV-int-5: stall then recovery resets stall_counter', () => {
  const dir = tmpDir();
  try {
    let state = createMicroverseState({ prdPath: 'prd.md', metric: TEST_METRIC, stallLimit: 3 });
    state = { ...state, baseline_score: 50 };

    // Stall twice
    state = recordStall(state);
    state = recordStall(state);
    assert.equal(state.convergence.stall_counter, 2);

    // Then improve → counter resets
    state = recordIteration(state, { score: 80, iteration: 1, sha: 'sha1', action: 'accept' });
    assert.equal(state.convergence.stall_counter, 0, 'improvement after stalls resets counter');

    writeMicroverseState(dir, state);
    assert.equal(readMicroverseState(dir).convergence.stall_counter, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// recordFailedApproach — persistence
// ---------------------------------------------------------------------------

test('MV-int-6: recordFailedApproach persists across read/write cycle', () => {
  const dir = tmpDir();
  try {
    let state = createMicroverseState({ prdPath: 'prd.md', metric: TEST_METRIC, stallLimit: 3 });
    state = recordFailedApproach(state, 'tried memoization — no gain');
    state = recordFailedApproach(state, 'tried loop unrolling — regressed');
    writeMicroverseState(dir, state);

    const restored = readMicroverseState(dir);
    assert.equal(restored.failed_approaches.length, 2);
    assert.ok(restored.failed_approaches[0].includes('memoization'));
    assert.ok(restored.failed_approaches[1].includes('loop unrolling'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// readMicroverseState — missing file
// ---------------------------------------------------------------------------

test('MV-int-7: readMicroverseState returns null when microverse.json does not exist', () => {
  const dir = tmpDir();
  try {
    assert.equal(readMicroverseState(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// compareMetric — direction independence
// ---------------------------------------------------------------------------

test('MV-int-8: compareMetric direction=lower classifies score drop as improved', () => {
  assert.equal(compareMetric(80, 100, 1, 'lower'), 'improved');
  assert.equal(compareMetric(120, 100, 1, 'lower'), 'regressed');
  assert.equal(compareMetric(100, 100, 1, 'lower'), 'held');
});

test('MV-int-9: compareMetric direction=higher classifies score rise as improved', () => {
  assert.equal(compareMetric(80, 100, 1, 'higher'), 'regressed');
  assert.equal(compareMetric(120, 100, 1, 'higher'), 'improved');
  assert.equal(compareMetric(100, 100, 1, 'higher'), 'held');
});

// ---------------------------------------------------------------------------
// writeMicroverseState — atomic write (no .tmp left behind)
// ---------------------------------------------------------------------------

test('MV-int-10: writeMicroverseState leaves no .tmp files after successful write', () => {
  const dir = tmpDir();
  try {
    const state = createMicroverseState({ prdPath: 'prd.md', metric: TEST_METRIC, stallLimit: 3 });
    writeMicroverseState(dir, state);

    const tmpFiles = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
    assert.equal(tmpFiles.length, 0, `unexpected .tmp files: ${tmpFiles.join(', ')}`);
    assert.equal(fs.existsSync(path.join(dir, 'microverse.json')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Full convergence walk — F23 scenario
// ---------------------------------------------------------------------------

test('MV-int-11: 5-iteration walk: improve×2, revert, stall (non-consecutive), improve → 3 accepted 1 reverted 1 stall', () => {
  const dir = tmpDir();
  try {
    // stall_limit=3 so one stall + one revert don't trigger convergence
    let state = createMicroverseState({ prdPath: 'prd.md', metric: TEST_METRIC, stallLimit: 3 });
    state = { ...state, baseline_score: 50 };

    // Iter 1: improved vs baseline 50 → accept, stall_counter resets to 0
    state = recordIteration(state, { score: 65, iteration: 1, sha: 'sha1', action: 'accept' });
    writeMicroverseState(dir, state);
    state = readMicroverseState(dir);

    // Iter 2: improved vs last accepted 65 → accept, stall_counter stays 0
    state = recordIteration(state, { score: 80, iteration: 2, sha: 'sha2', action: 'accept' });
    writeMicroverseState(dir, state);
    state = readMicroverseState(dir);

    // Iter 3: regressed vs last accepted 80 → revert, stall_counter → 1
    state = recordIteration(state, { score: 40, iteration: 3, sha: 'sha3', action: 'revert' });
    writeMicroverseState(dir, state);
    state = readMicroverseState(dir);

    // Iter 4: held within tolerance of last accepted 80 (score 81, tol 2) → no action (stall)
    // stall_counter → 2, non-consecutive (revert then stall, not converged: 2 < 3)
    state = recordIteration(state, { score: 81, iteration: 4, sha: 'sha4' });
    writeMicroverseState(dir, state);
    state = readMicroverseState(dir);
    assert.equal(isConverged(state), null, 'non-consecutive stall must not trigger convergence');
    assert.equal(state.convergence.stall_counter, 2);

    // Iter 5: improved vs last accepted 80 → accept, stall_counter resets to 0
    state = recordIteration(state, { score: 100, iteration: 5, sha: 'sha5', action: 'accept' });
    state = { ...state, status: 'converged' };
    writeMicroverseState(dir, state);
    state = readMicroverseState(dir);

    const history = state.convergence.history;
    assert.equal(history.length, 5, '5 recordIteration calls must produce 5 history entries');
    assert.equal(
      history.filter((h) => h.action === 'accept').length,
      3,
      '3 accepted entries (iter 1, 2, 5)',
    );
    assert.equal(
      history.filter((h) => h.action === 'revert').length,
      1,
      '1 reverted entry (iter 3)',
    );
    assert.equal(
      history.filter((h) => !h.action).length,
      1,
      '1 stall entry with no action (iter 4 held within tolerance)',
    );
    assert.equal(state.status, 'converged', 'status must be converged after final improvement');
    assert.equal(state.convergence.stall_counter, 0, 'stall_counter resets after accepted improvement');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

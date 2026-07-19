// @tier: fast
/**
 * microverse-converged-branch.test.js
 *
 * Covers ticket 25fa1aed: isConverged must discriminate WHICH branch fired
 * ('target' | 'stall' | null), not just whether convergence happened. Verifies:
 *   - an overshoot (lower-direction score strictly below target) classifies 'target',
 *     never 'stall' — a target-beating run must never read as a give-up.
 *   - stall-exhaustion (stall_counter >= stall_limit, target never hit) classifies 'stall'.
 *   - the stall backstop terminates within stall_limit iterations, with no dependency
 *     on max_time_minutes (a pure stall_counter arithmetic bound).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createMicroverseState,
    isConverged,
    recordStall,
} from '../services/microverse-state.js';

const TEST_METRIC = {
    description: 'violations',
    validation: 'count',
    type: 'llm',
    timeout_seconds: 60,
    tolerance: 0,
    direction: 'lower',
};

test('isConverged: overshoot (lower direction, score below target) classifies target, not stall', () => {
    const state = createMicroverseState({
        prdPath: '/tmp/prd.md',
        metric: TEST_METRIC,
        stallLimit: 5,
        convergenceTarget: 0,
    });
    state.baseline_score = 10;
    state.convergence.history = [
        {
            iteration: 1, metric_value: '-3', score: -3, action: 'accept',
            description: 'overshot target', pre_iteration_sha: 'abc',
            timestamp: new Date().toISOString(),
        },
    ];
    // stall_counter stays at 0 (below stall_limit=5) — only the target branch can fire.
    assert.equal(state.convergence.stall_counter, 0);
    assert.equal(isConverged(state), 'target', 'overshoot must classify target, never stall');
});

test('isConverged: stall-exhaustion with target never hit classifies stall', () => {
    const state = createMicroverseState({
        prdPath: '/tmp/prd.md',
        metric: { ...TEST_METRIC, direction: 'higher' },
        stallLimit: 3,
        convergenceTarget: 90,
    });
    state.baseline_score = 0;
    state.convergence.history = [
        {
            iteration: 1, metric_value: '10', score: 10, action: 'accept',
            description: 'far from target', pre_iteration_sha: 'abc',
            timestamp: new Date().toISOString(),
        },
    ];
    state.convergence.stall_counter = 3; // >= stall_limit=3; target (90) never reached (score=10)
    assert.equal(isConverged(state), 'stall', 'stall-exhaustion must classify stall, not target');
});

test('isConverged: stall backstop terminates within stall_limit + margin, independent of wall-clock', () => {
    const stallLimit = 4;
    let state = createMicroverseState({
        prdPath: '/tmp/prd.md',
        metric: TEST_METRIC,
        stallLimit,
    });
    // No convergence_target and no max_time_minutes set — the ONLY backstop is stall_counter
    // arithmetic. Assert it does not fire early and does fire at exactly stall_limit.
    for (let i = 1; i < stallLimit; i++) {
        state = recordStall(state);
        assert.equal(isConverged(state), null, `must not converge before stall_limit at stall ${i}`);
    }
    state = recordStall(state);
    assert.equal(state.convergence.stall_counter, stallLimit);
    assert.equal(isConverged(state), 'stall', 'must converge via stall branch at exactly stall_limit');
});

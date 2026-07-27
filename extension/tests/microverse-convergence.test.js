// @tier: fast
/**
 * microverse-convergence.test.js
 *
 * Integration test for the 5-event convergence scenario using the pure
 * state-machine layer (no subprocess, no git, no claude). Drives:
 *
 *   Iter 1: score=7.0  vs baseline=5.0  → improved   → accept  (stall=0)
 *   Iter 2: score=9.0  vs prev=7.0      → improved   → accept  (stall=0)
 *   Iter 3: score=4.0  vs prev=9.0      → regressed  → revert  (stall=1) + failedApproach
 *   Iter 4: no commits                  → recordStall          (stall=2)  [non-consecutive: two improvements precede]
 *   Iter 5: score=9.1  vs prev=9.0      → held        → accept  (stall=3 ≥ limit=3 → converged)
 *
 * Total: 5 processed events (4 history entries + 1 raw stall), 3 accepted,
 *        1 reverted, 1 stall, isConverged === true.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    compareMetric,
    createMicroverseState,
    recordIteration,
    recordStall,
    recordFailedApproach,
    isConverged,
    writeMicroverseState,
    readMicroverseState,
} from '../services/microverse-state.js';
import { buildJudgePrompt, parseLlmJudgeOutput, extractScore } from '../bin/microverse-runner.js';

function makeTmpDir() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mv-conv-')));
}

function makeEntry(iteration, score, action, pre_sha = 'abc0000') {
    return {
        iteration,
        metric_value: String(score),
        score,
        action,
        description: `score=${score}`,
        pre_iteration_sha: pre_sha,
        timestamp: new Date().toISOString(),
    };
}

// ---------------------------------------------------------------------------
// compareMetric — direction='higher'
// ---------------------------------------------------------------------------

test('compareMetric: improved when score exceeds previous + tolerance', () => {
    assert.equal(compareMetric(7.0, 5.0, 0.5, 'higher'), 'improved');
});

test('compareMetric: held when score within tolerance (higher)', () => {
    assert.equal(compareMetric(9.1, 9.0, 0.5, 'higher'), 'held');
});

test('compareMetric: regressed when score drops below previous - tolerance', () => {
    assert.equal(compareMetric(4.0, 9.0, 0.5, 'higher'), 'regressed');
});

test('compareMetric: direction=lower — improved when current < previous - tolerance', () => {
    assert.equal(compareMetric(3.0, 9.0, 0.5, 'lower'), 'improved');
});

test('compareMetric: returns held for non-finite inputs', () => {
    assert.equal(compareMetric(NaN, 5.0, 0.5), 'held');
    assert.equal(compareMetric(5.0, NaN, 0.5), 'held');
    assert.equal(compareMetric(5.0, 5.0, NaN), 'held');
});

// ---------------------------------------------------------------------------
// Full 5-event convergence scenario
// ---------------------------------------------------------------------------

test('convergence scenario: 5 events — 4 history entries, 3 accepted, 1 reverted, 1 stall, converged', () => {
    const metric = {
        description: 'test score',
        validation: 'echo 5',
        type: 'command',
        tolerance: 0.5,
        timeout_seconds: 10,
        direction: 'higher',
    };
    let mv = createMicroverseState({ prdPath: 'prd.md', metric: metric, stallLimit: 3 });
    mv.baseline_score = 5.0;
    mv.status = 'iterating';

    // --- Iter 1: score=7.0 vs baseline=5.0 → improved → accept ---
    const class1 = compareMetric(7.0, 5.0, 0.5, 'higher');
    assert.equal(class1, 'improved');
    const entry1 = makeEntry(1, 7.0, 'accept');
    mv = recordIteration(mv, entry1, class1);
    assert.equal(mv.convergence.stall_counter, 0, 'stall_counter resets after improvement');
    assert.equal(isConverged(mv), null);

    // --- Iter 2: score=9.0 vs prev=7.0 → improved → accept ---
    const class2 = compareMetric(9.0, 7.0, 0.5, 'higher');
    assert.equal(class2, 'improved');
    const entry2 = makeEntry(2, 9.0, 'accept');
    mv = recordIteration(mv, entry2, class2);
    assert.equal(mv.convergence.stall_counter, 0, 'stall_counter stays 0 on second improvement');
    assert.equal(isConverged(mv), null);

    // --- Iter 3: score=4.0 vs prev=9.0 → regressed → revert + failedApproach ---
    const class3 = compareMetric(4.0, 9.0, 0.5, 'higher');
    assert.equal(class3, 'regressed');
    const entry3 = makeEntry(3, 4.0, 'revert');
    mv = recordFailedApproach(mv, 'Iteration 3: score dropped from 9.0 to 4.0');
    mv = recordIteration(mv, entry3, class3);
    assert.equal(mv.convergence.stall_counter, 1, 'stall_counter increments on revert');
    assert.equal(mv.failed_approaches.length, 1, 'failed approach recorded');
    assert.equal(isConverged(mv), null);

    // --- Iter 4: no commits (non-consecutive stall) → recordStall only ---
    // Non-consecutive: two improvements preceded this stall, so it's isolated
    mv = recordStall(mv);
    assert.equal(mv.convergence.stall_counter, 2, 'stall_counter increments on no-commit stall');
    assert.equal(mv.convergence.history.length, 3, 'recordStall does not add history entry');
    assert.equal(isConverged(mv), null);

    // --- Iter 5: score=9.1 vs last-accepted=9.0, delta=0.1 < tolerance=0.5 → held → accept ---
    const lastAccepted = [...mv.convergence.history].reverse().find(h => h.action === 'accept');
    assert.ok(lastAccepted, 'there is a prior accepted entry');
    const prevScore = lastAccepted.score;
    const class5 = compareMetric(9.1, prevScore, 0.5, 'higher');
    assert.equal(class5, 'held', 'score within tolerance → held');
    const entry5 = makeEntry(5, 9.1, 'accept');
    mv = recordIteration(mv, entry5, class5);
    assert.equal(mv.convergence.stall_counter, 3, 'held entry increments stall_counter');
    assert.equal(isConverged(mv), 'stall', 'stall_counter=3 >= stall_limit=3 → converged');

    // --- Final assertions ---
    const history = mv.convergence.history;
    assert.equal(history.length, 4, '4 history entries (recordIteration × 4)');

    const accepted = history.filter(h => h.action === 'accept');
    assert.equal(accepted.length, 3, '3 accepted entries');

    const reverted = history.filter(h => h.action === 'revert');
    assert.equal(reverted.length, 1, '1 reverted entry');

    // The 5th event was the raw stall (recordStall), confirmed by stall_counter
    // reaching 3 via: 1 (revert) + 1 (recordStall) + 1 (held) = 3
    assert.equal(mv.convergence.stall_counter, 3, 'accumulated stall_counter reflects 5th stall event');
});

// ---------------------------------------------------------------------------
// Intermediate non-convergence: stall before limit
// ---------------------------------------------------------------------------

test('convergence: not triggered when stall_counter < stall_limit', () => {
    const metric = {
        description: 'score',
        validation: 'echo 5',
        type: 'command',
        tolerance: 1.0,
        timeout_seconds: 10,
        direction: 'higher',
    };
    let mv = createMicroverseState({ prdPath: 'prd.md', metric: metric, stallLimit: 5 });
    mv.baseline_score = 0;
    mv.status = 'iterating';

    // 4 stalls — should not converge until 5th
    for (let i = 0; i < 4; i++) {
        mv = recordStall(mv);
        assert.equal(isConverged(mv), null, `should not converge at stall ${i + 1}`);
    }
    mv = recordStall(mv);
    assert.equal(isConverged(mv), 'stall', 'converges at stall_limit=5');
});

// ---------------------------------------------------------------------------
// Improvement resets stall_counter
// ---------------------------------------------------------------------------

test('convergence: improvement resets stall_counter to 0', () => {
    const metric = {
        description: 'score',
        validation: 'echo 5',
        type: 'command',
        tolerance: 0.1,
        timeout_seconds: 10,
        direction: 'higher',
    };
    let mv = createMicroverseState({ prdPath: 'prd.md', metric: metric, stallLimit: 3 });
    mv.baseline_score = 0;
    mv.status = 'iterating';

    // Accumulate 2 stalls
    mv = recordStall(mv);
    mv = recordStall(mv);
    assert.equal(mv.convergence.stall_counter, 2);

    // Improvement resets counter
    const entry = makeEntry(1, 5.0, 'accept');
    mv = recordIteration(mv, entry, 'improved');
    assert.equal(mv.convergence.stall_counter, 0, 'improvement resets stall_counter');
    assert.equal(isConverged(mv), null, 'not converged after reset');
});

// ---------------------------------------------------------------------------
// Rollback scenario: regression increments stall and records failed approach
// ---------------------------------------------------------------------------

test('convergence: regression increments stall, accept revert not accept', () => {
    const metric = {
        description: 'score',
        validation: 'echo 5',
        type: 'command',
        tolerance: 0.5,
        timeout_seconds: 10,
        direction: 'higher',
    };
    let mv = createMicroverseState({ prdPath: 'prd.md', metric: metric, stallLimit: 3 });
    mv.baseline_score = 10.0;
    mv.status = 'iterating';

    const regression = makeEntry(1, 3.0, 'revert');
    mv = recordIteration(mv, regression, 'regressed');
    assert.equal(mv.convergence.history[0].action, 'revert');
    assert.equal(mv.convergence.stall_counter, 1);
});

// ---------------------------------------------------------------------------
// Write/read round-trip — microverse.json persisted correctly
// ---------------------------------------------------------------------------

test('writeMicroverseState / readMicroverseState: round-trip preserves all fields', () => {
    const dir = makeTmpDir();
    try {
        const metric = {
            description: 'coverage',
            validation: 'echo 80',
            type: 'command',
            tolerance: 1.0,
            timeout_seconds: 30,
            direction: 'higher',
        };
        let mv = createMicroverseState({ prdPath: 'prd.md', metric: metric, stallLimit: 3 });
        mv.baseline_score = 75.0;
        mv.status = 'iterating';

        // Record one improvement
        const entry = makeEntry(1, 80.0, 'accept');
        mv = recordIteration(mv, entry, 'improved');
        mv = recordFailedApproach(mv, 'tried inline caching');

        writeMicroverseState(dir, mv);

        const restored = readMicroverseState(dir);
        assert.ok(restored !== null, 'should read back non-null state');
        assert.equal(restored.baseline_score, 75.0);
        assert.equal(restored.convergence.history.length, 1);
        assert.equal(restored.convergence.history[0].score, 80.0);
        assert.equal(restored.failed_approaches.length, 1);
        assert.equal(restored.failed_approaches[0], 'tried inline caching');
        assert.equal(restored.status, 'iterating');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('readMicroverseState: returns null when microverse.json does not exist', () => {
    const dir = makeTmpDir();
    try {
        const result = readMicroverseState(dir);
        assert.equal(result, null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Direction='lower' convergence
// ---------------------------------------------------------------------------

test('convergence: direction=lower — regressed when score increases', () => {
    const metric = {
        description: 'error count',
        validation: 'echo 10',
        type: 'command',
        tolerance: 1.0,
        timeout_seconds: 10,
        direction: 'lower',
    };
    let mv = createMicroverseState({ prdPath: 'prd.md', metric: metric, stallLimit: 2 });
    mv.baseline_score = 10.0;
    mv.status = 'iterating';

    // Score went UP — bad for lower direction → regressed
    const class1 = compareMetric(15.0, 10.0, 1.0, 'lower');
    assert.equal(class1, 'regressed');

    // Score went DOWN — good → improved
    const class2 = compareMetric(5.0, 10.0, 1.0, 'lower');
    assert.equal(class2, 'improved');

    const entry = makeEntry(1, 5.0, 'accept');
    mv = recordIteration(mv, entry, 'improved');
    assert.equal(mv.convergence.stall_counter, 0);
});

// ---------------------------------------------------------------------------
// Worker-managed convergence: type='none', convergence_mode, convergence_file
// ---------------------------------------------------------------------------

test('createMicroverseState with type: none metric sets key_metric.type to none', () => {
    const metric = {
        description: 'worker-managed',
        validation: '',
        type: 'none',
        tolerance: 0,
        timeout_seconds: 0,
        direction: 'higher',
    };
    const mv = createMicroverseState({ prdPath: 'prd.md', metric, stallLimit: 3 });
    assert.equal(mv.key_metric.type, 'none');
    assert.equal(mv.baseline_score, 0);
});

test('createMicroverseState with convergenceMode: worker sets convergence_mode', () => {
    const metric = {
        description: 'test',
        validation: 'echo 1',
        type: 'command',
        tolerance: 0.5,
        timeout_seconds: 10,
    };
    const mv = createMicroverseState({ prdPath: 'prd.md', metric, stallLimit: 3, convergenceMode: 'worker' });
    assert.equal(mv.convergence_mode, 'worker');
});

test('createMicroverseState with convergenceFile sets convergence_file', () => {
    const metric = {
        description: 'test',
        validation: 'echo 1',
        type: 'none',
        tolerance: 0,
        timeout_seconds: 0,
    };
    const mv = createMicroverseState({
        prdPath: 'prd.md',
        metric,
        stallLimit: 3,
        convergenceMode: 'worker',
        convergenceFile: 'ap.json',
    });
    assert.equal(mv.convergence_mode, 'worker');
    assert.equal(mv.convergence_file, 'ap.json');
});

test('createMicroverseState without convergenceMode defaults to undefined', () => {
    const metric = {
        description: 'test',
        validation: 'echo 1',
        type: 'command',
        tolerance: 0.5,
        timeout_seconds: 10,
    };
    const mv = createMicroverseState({ prdPath: 'prd.md', metric, stallLimit: 3 });
    assert.equal(mv.convergence_mode, undefined);
    assert.equal(mv.convergence_file, undefined);
});

test('createMicroverseState with convergenceMode: metric sets convergence_mode to metric', () => {
    const metric = {
        description: 'test',
        validation: 'echo 1',
        type: 'command',
        tolerance: 0.5,
        timeout_seconds: 10,
    };
    const mv = createMicroverseState({ prdPath: 'prd.md', metric, stallLimit: 3, convergenceMode: 'metric' });
    assert.equal(mv.convergence_mode, 'metric');
});

// ---------------------------------------------------------------------------
// R-SJWT-3: scoped judge prompt convergence-to-0 regression
// ---------------------------------------------------------------------------

test('R-SJWT-1: buildJudgePrompt with allowedPaths omits "Target path:" for scoped run', () => {
    const prompt = buildJudgePrompt(
        'Reduce code quality violations',
        '/repo',
        [],
        '/repo/src',
        undefined,
        [],
        ['src/foo.ts', 'src/bar.ts'],
    );
    assert.ok(!prompt.includes('Target path:'), 'scoped prompt must not include "Target path:"');
    assert.ok(prompt.includes('Review ONLY these paths:'), 'scoped prompt must include "Review ONLY these paths:"');
});

test('R-SJWT-1: buildJudgePrompt with allowedPaths enumerates each allowed path', () => {
    const allowedPaths = ['src/foo.ts', 'src/bar.ts', 'src/baz.ts'];
    const prompt = buildJudgePrompt(
        'Reduce violations',
        '/repo',
        [],
        '/repo/src',
        undefined,
        [],
        allowedPaths,
    );
    for (const p of allowedPaths) {
        assert.ok(prompt.includes(`- ${p}`), `scoped prompt must enumerate allowed path: ${p}`);
    }
});

test('R-SSOC L1: scoped judge prompt constrains SCORING to allowed_paths and keeps the R-SJWT-1 pins', () => {
    const allowedPaths = ['src/foo.ts', 'src/bar.ts'];
    const prompt = buildJudgePrompt(
        'Reduce violations',
        '/repo',
        [],
        '/repo/src',
        undefined,
        [],
        allowedPaths,
    );
    // R-SSOC: the judge must score ONLY in-scope violations (whole-tree scoring
    // steers the worker off-scope — baseline 24 on a clean 12-file scope).
    assert.ok(
        prompt.includes('Count ONLY violations located within these paths'),
        'scoped prompt must constrain scoring to the allowed paths',
    );
    // R-SJWT-1/R-SJWT-TD pins must survive: header present, paths enumerated,
    // "Target path:" absent.
    assert.ok(prompt.includes('Review ONLY these paths:'), 'R-SJWT-1 header pin');
    assert.ok(!prompt.includes('Target path:'), 'R-SJWT-1 Target-path-absent pin');
    for (const p of allowedPaths) {
        assert.ok(prompt.includes(`- ${p}`), `R-SJWT-1 enumeration pin: ${p}`);
    }
});

test('R-SJWT-3: convergence-to-0 — scoped judge score of 0 classifies as improved, not held', () => {
    // When a scoped judge prompt restricts evaluation to allowed_paths only,
    // and the only remaining violations are out-of-scope, the judge returns score=0.
    // compareMetric must classify that as 'improved', not 'held', so convergence
    // completes at 0 instead of plateauing at a non-zero value.
    const classification = compareMetric(0, 3, 0.5, 'lower');
    assert.equal(classification, 'improved', 'score 0 vs prior 3 (lower-is-better) must classify as improved');
    assert.notEqual(classification, 'held', 'score 0 must not classify as held — would cause false plateau');
});

// ---------------------------------------------------------------------------
// R-JPCM — the judge's PROMPT and its PARSER must agree on one output contract.
//
// The prompt demanded a bare integer; `parseLlmJudgeOutput` demanded a JSON
// object. Every measurement therefore landed in `emptyJudgeResult('malformed')`,
// so `violation_ledger` rebuilt from empty forever and `compareMetric`'s set-ops
// branch was unreachable — five real fixes read as `held: 4 vs 4` while the
// score path kept working, because `extractScore` has its own fallback. The
// failure is silent by construction: the number works, the payload is dropped.
// ---------------------------------------------------------------------------

test('AC-JPCM-1: buildJudgePrompt asks for the JSON object the parser accepts, not a bare integer', () => {
    const prompt = buildJudgePrompt('Reduce violations', '/repo', [], '/repo/src');
    assert.ok(
        !prompt.includes('Output ONLY a single integer'),
        'the bare-integer contract is what starved the parser — it must be gone',
    );
    // The four keys `parseLlmJudgeOutput` requires for shape 'full'. Asking for
    // fewer re-opens the bug via the 'legacy' shape.
    for (const key of ['"score"', '"violations"', '"resolved"', '"new"', '"remaining"']) {
        assert.ok(prompt.includes(key), `prompt must request the ${key} key`);
    }
    assert.ok(
        prompt.includes('score` MUST equal `violations.length'),
        'count-type metrics must pin score to the evidence array, not a free-floating integer',
    );
});

test("AC-JPCM-2: a well-formed judge object parses as shape 'full' with violations preserved", () => {
    const raw = JSON.stringify({
        score: 2,
        violations: [
            { id: 'dup-guard', path: 'src/a.ts', line: 12, severity: 'high', description: 'duplicated guard' },
            { id: 'dead-arg', path: 'src/b.ts', line: 3, severity: 'low', description: 'unused parameter' },
        ],
        resolved: [],
        new: ['dup-guard', 'dead-arg'],
        remaining: [],
    });

    const result = parseLlmJudgeOutput(raw);

    // 'full' was UNREACHABLE under the old prompt — this is the pin that it is
    // reachable at all.
    assert.equal(result.shape, 'full', "a compliant judge response must parse as shape 'full'");
    assert.equal(result.score, 2);
    assert.equal(result.violations.length, 2, 'violations must survive the parse');
    assert.equal(result.violations.length, result.score, 'AC-JPCM-2: score must equal violations.length');
    assert.deepEqual(result.violations.map((v) => v.id), ['dup-guard', 'dead-arg']);
    assert.deepEqual(result.new, ['dup-guard', 'dead-arg']);
});

test('AC-JPCM-2: the ledger set-ops arrays survive the parse so compareMetric can use them', () => {
    // The flat-score case the bug hid: same count, but one resolved and one new.
    // Numerically `held`; via set-ops, real progress.
    const raw = JSON.stringify({
        score: 2,
        violations: [
            { id: 'kept', severity: 'med', description: 'still here' },
            { id: 'fresh', severity: 'low', description: 'newly introduced' },
        ],
        resolved: ['gone'],
        new: ['fresh'],
        remaining: ['kept'],
    });

    const result = parseLlmJudgeOutput(raw);

    assert.equal(result.shape, 'full');
    assert.deepEqual(result.resolved, ['gone'], 'resolved ids feed the set-ops branch');
    assert.deepEqual(result.new, ['fresh']);
    assert.deepEqual(result.remaining, ['kept']);
});

test('AC-JPCM-5: a non-compliant bare-number judge still yields a score via the extractScore fallback', () => {
    // The safety net the PRD requires us to keep: worst case is today's
    // behaviour (working score, dead ledger), never a broken phase.
    assert.equal(extractScore('8'), 8);
    assert.equal(extractScore('Some prose about the tree.\n\n4'), 4);
    assert.equal(extractScore('**7**'), 7);

    // ...and it still reads a compliant JSON object, so ONE response satisfies
    // both readers.
    assert.equal(extractScore(JSON.stringify({ score: 5, violations: [], resolved: [], new: [], remaining: [] })), 5);
});

test('AC-JPCM-5: a bare number is NOT mistaken for a structured result', () => {
    // `JSON.parse('8')` succeeds and yields a number, not an object. If that
    // ever classified as 'full' it would rebuild the ledger from an empty
    // violations array and re-create the bug with no visible parse failure.
    const result = parseLlmJudgeOutput('8');
    assert.notEqual(result.shape, 'full', 'a bare number must never classify as a structured judge result');
    assert.deepEqual(result.violations, []);
});

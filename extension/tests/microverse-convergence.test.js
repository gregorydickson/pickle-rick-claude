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
    updateViolationLedger,
} from '../services/microverse-state.js';
import {
    buildJudgePrompt,
    parseLlmJudgeOutput,
    extractScore,
    emitJudgeParseDiagnostic,
    emitJudgeLedgerDiagnostic,
    emitJudgeLegacyShapeDiagnostic,
    handleNoCommitStall,
    classifyAnatomyNonConvergence,
    markMicroverseFatalError,
    auditPostIterationScope,
    JUDGE_SYSTEM_PROMPT,
    _deps,
} from '../bin/microverse-runner.js';
import { VALID_ACTIVITY_EVENTS } from '../types/index.js';

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
// AP-EXT-ITER22-01 — an EMPTY prior ledger is not prior context.
//
// Reproduces the first-scored-iteration data flow exactly as microverse-runner
// builds it: `previousLedger` is derived from `state.violation_ledger`, which is
// empty until the first `updateViolationLedger` call, and the judge — per its own
// prompt contract — puts every id in `new` when it is handed no prior list. The
// pre-fix presence-only gate read that as `new > resolved` -> 'regressed' and fed
// a false "score dropped" into failed_approaches + the stall counter.
// ---------------------------------------------------------------------------

/** Mirrors microverse-runner.ts `measureAndClassifyIteration` (the shape==='full' branch). */
function runnerLedgerSnapshots(state, judgeResult) {
    return {
        previousLedger: { resolved: [], new: [], remaining: (state.violation_ledger ?? []).map(e => e.id) },
        currentLedger: {
            resolved: judgeResult.resolved,
            new: judgeResult.new,
            remaining: judgeResult.remaining,
        },
    };
}

const FIRST_PASS_METRIC = {
    description: 'violations', validation: 'judge', type: 'llm',
    timeout_seconds: 60, tolerance: 0, direction: 'lower',
};

test('AP-EXT-ITER22-01: the judge prompt still declares the no-prior-list contract this relies on', () => {
    const prompt = buildJudgePrompt('Reduce violations', '/repo', [], '/repo/src', undefined, []);
    assert.match(
        prompt,
        /when there is no such list, `resolved` and `remaining` are `\[\]` and every id goes in `new`/,
        'first-pass ledger shape is a judge-contract dependency of compareMetric',
    );
});

test('AP-EXT-ITER22-01: first scored iteration with an EMPTY prior ledger is not a regression', () => {
    const state = createMicroverseState({
        prdPath: '/repo/prd.md', metric: FIRST_PASS_METRIC, stallLimit: 3,
        convergenceMode: 'metric',
    });
    assert.deepEqual(state.violation_ledger, [], 'baseline never populates the ledger');

    // Judge's documented first-pass shape: every id in `new`, resolved/remaining empty.
    // Score and id count agree, as an llm-judge pass always makes them: 8 violations, score 8.
    const judgeResult = {
        score: 8, violations: [],
        resolved: [], new: ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8'], remaining: [],
    };
    const { previousLedger, currentLedger } = runnerLedgerSnapshots(state, judgeResult);

    // baseline 12 violations -> 8: a real improvement. Pre-fix this returned 'regressed'.
    assert.equal(
        compareMetric(8, 12, 0, 'lower', currentLedger, previousLedger),
        'improved',
    );
});

test('AP-EXT-ITER22-01: first scored iteration that genuinely got worse still regresses', () => {
    // baseline 2 violations -> 5.
    const judgeResult = {
        score: 5, violations: [],
        resolved: [], new: ['v1', 'v2', 'v3', 'v4', 'v5'], remaining: [],
    };
    const { previousLedger, currentLedger } = runnerLedgerSnapshots({ violation_ledger: [] }, judgeResult);
    assert.equal(
        compareMetric(5, 2, 0, 'lower', currentLedger, previousLedger),
        'regressed',
    );
});

test('AP-EXT-ITER22-01: a POPULATED prior ledger still takes the set-ops branch', () => {
    const state = { violation_ledger: [{ id: 'a' }, { id: 'b' }] };

    // 2 carried + 2 net-new -> regressed by set-ops (numeric args are inert on this branch).
    const worse = runnerLedgerSnapshots(state, { resolved: [], new: ['c', 'd'], remaining: ['a', 'b'] });
    assert.equal(compareMetric(4, 2, 0, 'lower', worse.currentLedger, worse.previousLedger), 'regressed');

    // both resolved, none re-reported -> improved by set-ops.
    const better = runnerLedgerSnapshots(state, { resolved: ['a', 'b'], new: [], remaining: [] });
    assert.equal(compareMetric(0, 2, 0, 'lower', better.currentLedger, better.previousLedger), 'improved');
});

test('AP-EXT-ITER22-01: a malformed ledger falls through to numeric (subsumes the deleted catch)', () => {
    const malformed = { resolved: null, new: undefined, remaining: 'nope' };
    assert.equal(compareMetric(3, 9, 0.5, 'lower', malformed, malformed), 'improved');
    assert.equal(compareMetric(9, 3, 0.5, 'lower', malformed, malformed), 'regressed');
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

test('AC-JPCM-11: the judge SYSTEM prompt and the user-turn buildJudgePrompt agree on one output contract', () => {
    // buildJudgePrompt was fixed to demand the JSON object parseLlmJudgeOutput accepts,
    // but the SEPARATE system prompt sent to the same judge invocation
    // (buildJudgeAttemptInvocation's `systemPrompt: JUDGE_SYSTEM_PROMPT`) still told the
    // model to output "a single line containing ONLY a number" — a live contradiction
    // inside one judge turn that this pin closes by deriving both from one constant.
    assert.ok(
        !/ONLY a number/i.test(JUDGE_SYSTEM_PROMPT),
        'the system prompt must not resurrect the bare-number contract the user prompt no longer asks for',
    );

    const prompt = buildJudgePrompt('Reduce violations', '/repo', [], '/repo/src');
    // Both prompts must cite the identical JSON schema string — not merely "both mention
    // JSON" — proving they derive from one shared source rather than two hand-authored
    // descriptions that can drift apart again.
    const schemaMatch = prompt.match(/\{"score":[^\n]*"remaining": \["<id>"\]\}/);
    assert.ok(schemaMatch, 'buildJudgePrompt must contain the JSON schema line');
    assert.ok(
        JUDGE_SYSTEM_PROMPT.includes(schemaMatch[0]),
        'the system prompt must embed the exact same JSON schema string as buildJudgePrompt',
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

// ---------------------------------------------------------------------------
// R-JPCM WS-2 — a dead ledger must be LOUD.
//
// `judge_json_parse_failed` was registered end-to-end months ago — union entry,
// schema definition, top-level `oneOf` $ref, payload fixture — and had no
// producer: the only emission was a bare `process.stderr.write`. So the one
// signal that says "the violation ledger is dead" never reached the activity
// log, /pickle-status, or metrics. Five emissions in one session were invisible
// to an attentive operator, and the phase reported honest convergence.
//
// The parser stays a pure query: it reports the reason on its result, and the
// runtime seam records the event. Putting the write in the parser would append
// fabricated parse failures to the real activity log on every test run —
// poisoning the exact signal this restores.
// ---------------------------------------------------------------------------

const ACTIVITY_SCHEMA = JSON.parse(
    fs.readFileSync(new URL('../src/types/activity-events.schema.json', import.meta.url), 'utf8'),
);

function captureJudgeDiagnostics(rawOutput) {
    const captured = [];
    emitJudgeParseDiagnostic(parseLlmJudgeOutput(rawOutput), rawOutput, (event) => captured.push(event));
    return captured;
}

function assertConformsToSchema(event) {
    const definition = ACTIVITY_SCHEMA.definitions.judge_json_parse_failed;
    for (const key of definition.required) {
        assert.ok(key in event, `emitted event is missing schema-required key '${key}'`);
    }
    for (const key of definition.properties.gate_payload.required) {
        assert.ok(key in event.gate_payload, `gate_payload is missing schema-required key '${key}'`);
    }
    assert.equal(event.event, definition.properties.event.const);
}

test('AC-JPCM-7: judge_json_parse_failed is registered AND reachable from the schema top-level oneOf', () => {
    assert.ok(
        VALID_ACTIVITY_EVENTS.includes('judge_json_parse_failed'),
        'the event must be in VALID_ACTIVITY_EVENTS or the logger rejects it',
    );
    assert.ok(ACTIVITY_SCHEMA.definitions.judge_json_parse_failed, 'the schema must define the event');
    // A definition without a top-level $ref is inert — it validates nothing.
    assert.ok(
        ACTIVITY_SCHEMA.oneOf.some((entry) => entry.$ref === '#/definitions/judge_json_parse_failed'),
        'the definition must be referenced from the top-level oneOf',
    );
});

test('AC-JPCM-7: a degraded parse emits exactly one schema-conformant judge_json_parse_failed', () => {
    const captured = captureJudgeDiagnostics('not-json{garbage');

    assert.equal(captured.length, 1, 'a malformed judge response must produce the registered event');
    assertConformsToSchema(captured[0]);
    assert.equal(captured[0].source, 'pickle');
    assert.ok(
        captured[0].gate_payload.parse_error_message.length > 0,
        'the reason must travel from the parser, not be re-derived by the caller',
    );
});

test('AC-JPCM-7: every degraded shape reaches the activity log, not just a failed JSON.parse', () => {
    // Three distinct degrade paths, one event contract. The 'partial' and
    // not-an-object arms parse cleanly as JSON — only the parser knows they
    // starved the ledger.
    const cases = [
        ['not-json{garbage', 'malformed'],
        ['8', 'malformed'],
        [JSON.stringify({ score: 5, violations: 'oops' }), 'partial'],
    ];
    for (const [raw, expectedShape] of cases) {
        assert.equal(parseLlmJudgeOutput(raw).shape, expectedShape, `${raw} must degrade as ${expectedShape}`);
        const captured = captureJudgeDiagnostics(raw);
        assert.equal(captured.length, 1, `${expectedShape} must emit the event`);
        assertConformsToSchema(captured[0]);
    }
});

test('AC-JPCM-7: a clean full-shape parse emits NOTHING', () => {
    const raw = JSON.stringify({
        score: 1,
        violations: [{ id: 'a', severity: 'low', description: 'x' }],
        resolved: [],
        new: ['a'],
        remaining: [],
    });
    assert.equal(parseLlmJudgeOutput(raw).shape, 'full');
    assert.deepEqual(captureJudgeDiagnostics(raw), [], 'a healthy judge must not fire the dead-ledger alarm');
});

test('AC-JPCM-7: the event payload truncates raw judge output to 512 chars', () => {
    const captured = captureJudgeDiagnostics('x'.repeat(1024));
    assert.equal(captured.length, 1);
    assert.equal(
        captured[0].gate_payload.raw_output_truncated_512.length,
        512,
        'an unbounded raw judge response must not be copied into the activity log',
    );
});

test('AC-JPCM-7: the diagnostic is WIRED at the runtime seam, in source and in the shipped mirror', () => {
    // The bug being fixed is a producer that exists and is never called. A test
    // that only exercises `emitJudgeParseDiagnostic` directly would stay green
    // while the seam call is deleted — rebuilding the same defect one layer up.
    // The compiled mirror is checked too: a source-only pin passes while the
    // shipped runtime (which is what actually runs) has no emission.
    const files = [
        ['source', new URL('../src/bin/microverse-runner.ts', import.meta.url)],
        ['compiled mirror', new URL('../bin/microverse-runner.js', import.meta.url)],
    ];
    for (const [label, fileUrl] of files) {
        const body = fs.readFileSync(fileUrl, 'utf8');
        const parseAt = body.indexOf('parseLlmJudgeOutput(metricResult.raw)');
        assert.ok(parseAt !== -1, `${label}: the runtime judge-parse seam must exist`);
        const emitAt = body.indexOf('emitJudgeParseDiagnostic(judgeResult, metricResult.raw)');
        assert.ok(
            emitAt > parseAt,
            `${label}: the parse seam must emit judge_json_parse_failed — an unwired producer is the bug`,
        );
    }
});

test('AC-JPCM-7: parseLlmJudgeOutput stays a pure query — it writes no activity event', () => {
    // The regression this guards: "simplifying" by calling logActivity inside
    // the parser. Its unit tests call it directly, so every test run would
    // append fabricated judge_json_parse_failed events to the operator's real
    // activity log — making the restored signal untrustworthy.
    const dataRoot = makeTmpDir();
    const previousDataRoot = process.env.PICKLE_DATA_ROOT;
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.env.PICKLE_DATA_ROOT = dataRoot;
    process.stderr.write = () => true;
    try {
        const result = parseLlmJudgeOutput('not-json{garbage');
        assert.equal(result.shape, 'malformed');
        assert.equal(
            typeof result.parse_error_message,
            'string',
            'the parser must REPORT the reason so the caller can log it',
        );
        assert.equal(
            fs.existsSync(path.join(dataRoot, 'activity')),
            false,
            'parsing must not touch the activity log',
        );
    } finally {
        process.stderr.write = originalWrite;
        if (previousDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = previousDataRoot;
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// R-SLLJ-6 — the LIVE-ledger receipt.
//
// `judge_violation_ledger_advanced` is registered at all four touchpoints and
// had ZERO producers anywhere in extension/src/. Its payload maps exactly onto
// the `updateViolationLedger` callsite in `measureAndClassifyIteration`, which
// — since the prompt/parser contract was repaired — finally receives non-empty
// ledgers. This is the event that proves that repair works in the field: the
// score alone cannot, because a pass that resolves one violation and finds one
// new reads `held: N vs N`, identical to a pass that did nothing.
//
// Same producer/mutator split as its sibling: `updateViolationLedger` is called
// directly by its own unit tests, so the write lives at the runtime seam.
// ---------------------------------------------------------------------------

const FULL_SHAPE_JUDGE_OUTPUT = JSON.stringify({
    score: 2,
    violations: [
        { id: 'v1', path: 'a.ts', line: 10, rule: 'KISS', severity: 'P2', description: 'nested ternary' },
        { id: 'v2', path: 'b.ts', line: 20, rule: 'DRY', severity: 'P1', description: 'copied gate' },
    ],
    resolved: ['old1', 'old2', 'old3'],
    new: ['v2'],
    remaining: ['v1'],
});

function captureLedgerDiagnostics(rawOutput, priorLedger = []) {
    const judgeResult = parseLlmJudgeOutput(rawOutput);
    const state = { violation_ledger: priorLedger };
    updateViolationLedger(state, judgeResult, 4);
    const captured = [];
    emitJudgeLedgerDiagnostic(judgeResult, state.violation_ledger, (event) => captured.push(event));
    return captured;
}

test('AC-JPCM-9: judge_violation_ledger_advanced is registered AND reachable from the schema top-level oneOf', () => {
    assert.ok(
        VALID_ACTIVITY_EVENTS.includes('judge_violation_ledger_advanced'),
        'the event must be in VALID_ACTIVITY_EVENTS or the logger rejects it',
    );
    assert.ok(ACTIVITY_SCHEMA.definitions.judge_violation_ledger_advanced, 'the schema must define the event');
    // A definition without a top-level $ref is inert — it validates nothing.
    assert.ok(
        ACTIVITY_SCHEMA.oneOf.some((entry) => entry.$ref === '#/definitions/judge_violation_ledger_advanced'),
        'the definition must be referenced from the top-level oneOf',
    );
});

test('AC-JPCM-9: an advanced ledger emits exactly one schema-conformant judge_violation_ledger_advanced', () => {
    const captured = captureLedgerDiagnostics(FULL_SHAPE_JUDGE_OUTPUT);

    assert.equal(captured.length, 1, 'a full-shape pass must produce the registered event');
    const definition = ACTIVITY_SCHEMA.definitions.judge_violation_ledger_advanced;
    for (const key of definition.required) {
        assert.ok(key in captured[0], `emitted event is missing schema-required key '${key}'`);
    }
    for (const key of definition.properties.gate_payload.required) {
        assert.ok(key in captured[0].gate_payload, `gate_payload is missing schema-required key '${key}'`);
    }
    assert.equal(captured[0].event, definition.properties.event.const);
    assert.equal(captured[0].source, 'pickle');
});

test('AC-JPCM-9: the counts are the judge set-ops terms, not re-derived from the score', () => {
    // The three counts are exactly what compareMetric's set-ops branch decides
    // on. A payload that reported `score` three ways would be schema-conformant
    // and useless — the whole point is that 3 resolved + 1 new is NOT a hold.
    const captured = captureLedgerDiagnostics(FULL_SHAPE_JUDGE_OUTPUT);
    assert.deepEqual(captured[0].gate_payload, {
        resolved_count: 3,
        new_count: 1,
        remaining_count: 1,
        ledger_size: 2,
    });
});

test('AC-JPCM-9: the advance REPLACES the ledger, so a post-advance size differs from the prior one', () => {
    // Why a post-advance read is the only honest one: `updateViolationLedger`
    // replaces rather than appends, so prior and post sizes genuinely differ and
    // reading the wrong one is an off-by-one-iteration lie. This drives the real
    // mutator; production's read ORDER is pinned separately by the seam-anchor
    // test below, which matches the exact post-advance expression — this test
    // cannot see production and does not claim to.
    const priorLedger = Array.from({ length: 5 }, (_, i) => ({
        id: `stale${i}`,
        path: `stale${i}.ts`,
        line: 1,
        rule: 'YAGNI',
        first_seen_iter: 1,
        last_seen_iter: 3,
        severity: 'P3',
        description: 'gone',
    }));
    const captured = captureLedgerDiagnostics(FULL_SHAPE_JUDGE_OUTPUT, priorLedger);
    assert.equal(
        captured[0].gate_payload.ledger_size,
        2,
        'ledger_size must describe the ledger the iteration produced, not the one it replaced',
    );
});

test('AC-JPCM-9: a converged pass reports honest zeros rather than staying silent', () => {
    // Zero violations is the convergence case. Suppressing the event there would
    // make "the judge found nothing" indistinguishable from "the judge never ran"
    // — which is the dead-ledger ambiguity this whole orbit exists to remove.
    const captured = captureLedgerDiagnostics(
        JSON.stringify({ score: 0, violations: [], resolved: ['v1'], new: [], remaining: [] }),
    );
    assert.equal(captured.length, 1, 'convergence must still be recorded');
    assert.deepEqual(captured[0].gate_payload, {
        resolved_count: 1,
        new_count: 0,
        remaining_count: 0,
        ledger_size: 0,
    });
});

test('AC-JPCM-9: the diagnostic is WIRED at the runtime seam, in source and in the shipped mirror', () => {
    // The bug being fixed is a producer that does not exist. A test exercising
    // `emitJudgeLedgerDiagnostic` directly would stay green with no seam call —
    // rebuilding the same defect one layer up. The compiled mirror is checked
    // too: a source-only pin passes while the runtime that actually executes
    // emits nothing.
    const files = [
        ['source', new URL('../src/bin/microverse-runner.ts', import.meta.url)],
        ['compiled mirror', new URL('../bin/microverse-runner.js', import.meta.url)],
    ];
    for (const [label, fileUrl] of files) {
        const body = fs.readFileSync(fileUrl, 'utf8');
        const advanceAt = body.indexOf('updateViolationLedger(state, judgeResult, ctx.iteration)');
        assert.ok(advanceAt !== -1, `${label}: the runtime ledger-advance seam must exist`);
        // Anchor on the CALL, not the name: the compiled mirror's one-line
        // function signature also reads `emitJudgeLedgerDiagnostic(judgeResult,`
        // and sits above the seam, so a looser anchor passes on a deleted call.
        const emitAt = body.indexOf('emitJudgeLedgerDiagnostic(judgeResult, state.violation_ledger)');
        assert.ok(
            emitAt > advanceAt,
            `${label}: the ledger advance must emit judge_violation_ledger_advanced AFTER it advances — an unwired producer is the bug`,
        );
    }
});

test('AC-JPCM-9: updateViolationLedger stays a pure mutator — it writes no activity event', () => {
    // The regression this guards: "simplifying" by moving the emit inside the
    // mutator. Its unit tests call it directly, so every test run would append
    // fabricated ledger events to the operator's real activity log — making the
    // restored signal untrustworthy, exactly as it would for the parse sibling.
    const dataRoot = makeTmpDir();
    const previousDataRoot = process.env.PICKLE_DATA_ROOT;
    process.env.PICKLE_DATA_ROOT = dataRoot;
    try {
        const state = { violation_ledger: [] };
        updateViolationLedger(state, parseLlmJudgeOutput(FULL_SHAPE_JUDGE_OUTPUT), 4);
        assert.equal(state.violation_ledger.length, 2, 'the mutator must still advance the ledger');
        assert.equal(
            fs.existsSync(path.join(dataRoot, 'activity')),
            false,
            'advancing the ledger must not touch the activity log',
        );
    } finally {
        if (previousDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = previousDataRoot;
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// R-SLLJ-6 — the LEGACY-FALLBACK notice, third and last of the trio.
//
// `judge_legacy_shape_inferred` is registered at all four touchpoints and its
// only emission was a payload-less `process.stderr.write`, off the activity log
// entirely — while the schema REQUIRES `gate_payload.{score, raw_keys}`.
//
// Where the parse alarm says the output was unreadable and the ledger receipt
// says the ledger moved, this one says the output was READABLE but carried no
// set-ops terms: the ledger holds at its prior contents and compareMetric falls
// back to bare scores. Without it, that degradation is indistinguishable from a
// genuine hold.
//
// The nullable-`score` decision is pinned below. It was deferred twice because
// `score` is null on this path while the schema typed it `number`.
// ---------------------------------------------------------------------------

const LEGACY_SHAPE_JUDGE_OUTPUT = JSON.stringify({ score: 7.5, notes: 'looks fine' });

function captureLegacyDiagnostics(rawOutput) {
    const captured = [];
    emitJudgeLegacyShapeDiagnostic(parseLlmJudgeOutput(rawOutput), (event) => captured.push(event));
    return captured;
}

test('AC-JPCM-10: judge_legacy_shape_inferred is registered AND reachable from the schema top-level oneOf', () => {
    assert.ok(
        VALID_ACTIVITY_EVENTS.includes('judge_legacy_shape_inferred'),
        'the event must be in VALID_ACTIVITY_EVENTS or the logger rejects it',
    );
    assert.ok(ACTIVITY_SCHEMA.definitions.judge_legacy_shape_inferred, 'the schema must define the event');
    // A definition without a top-level $ref is inert — it validates nothing.
    assert.ok(
        ACTIVITY_SCHEMA.oneOf.some((entry) => entry.$ref === '#/definitions/judge_legacy_shape_inferred'),
        'the definition must be referenced from the top-level oneOf',
    );
});

test('AC-JPCM-10: a legacy-shape parse emits exactly one schema-conformant event carrying the raw keys', () => {
    const captured = captureLegacyDiagnostics(LEGACY_SHAPE_JUDGE_OUTPUT);

    assert.equal(captured.length, 1, 'a legacy-shape pass must produce the registered event');
    const definition = ACTIVITY_SCHEMA.definitions.judge_legacy_shape_inferred;
    for (const key of definition.required) {
        assert.ok(key in captured[0], `emitted event is missing schema-required key '${key}'`);
    }
    for (const key of definition.properties.gate_payload.required) {
        assert.ok(key in captured[0].gate_payload, `gate_payload is missing schema-required key '${key}'`);
    }
    assert.equal(captured[0].event, definition.properties.event.const);
    assert.equal(captured[0].source, 'pickle');
    // raw_keys is what makes the event diagnosable: it says WHICH shape arrived,
    // so an operator can tell a renamed field from a judge that ignored the prompt.
    assert.deepEqual(captured[0].gate_payload, { score: 7.5, raw_keys: ['score', 'notes'] });
});

test('AC-JPCM-10: a legacy parse with NO score still emits, and the schema admits the null', () => {
    // The decision this pins. An object with neither structured fields nor a
    // number is the most degraded legacy parse there is — the case where the
    // notice matters MOST. Gating the emit on a non-null score would silence the
    // alarm exactly there, rebuilding the silent-failure defect this trio closes;
    // substituting 0 would make the one event that says "the judge fell back"
    // report a score the judge never produced. So it reports what arrived.
    const captured = captureLegacyDiagnostics(JSON.stringify({ verdict: 'looks good to me' }));

    assert.equal(captured.length, 1, 'a scoreless legacy pass is the loudest case, not a silent one');
    assert.deepEqual(captured[0].gate_payload, { score: null, raw_keys: ['verdict'] });
    assert.deepEqual(
        ACTIVITY_SCHEMA.definitions.judge_legacy_shape_inferred.properties.gate_payload.properties.score.type,
        ['number', 'null'],
        'the schema must admit the null the legacy path really produces, or the emit is unconformant',
    );
});

test('AC-JPCM-10: the non-legacy shapes stay silent — the notice is not a per-iteration heartbeat', () => {
    // A full-shape pass is the healthy path and a malformed one already has its
    // own alarm. Emitting here too would make "the judge degraded" ambient, which
    // is how the stderr-only version stayed invisible for months.
    assert.equal(captureLegacyDiagnostics(FULL_SHAPE_JUDGE_OUTPUT).length, 0, 'a full-shape pass must not emit');
    assert.equal(captureLegacyDiagnostics('not json at all').length, 0, 'a malformed parse has its own event');
    assert.equal(
        captureLegacyDiagnostics(JSON.stringify({ violations: 'not-an-array' })).length,
        0,
        'a partial parse has its own event',
    );
});

test('AC-JPCM-10: the diagnostic is WIRED at the runtime seam, in source and in the shipped mirror', () => {
    // The bug being fixed is a producer that does not exist. A test exercising
    // `emitJudgeLegacyShapeDiagnostic` directly would stay green with no seam
    // call — rebuilding the same defect one layer up. Anchor on the CALL, not the
    // name: the one-argument signature in the compiled mirror sits above the seam
    // and a looser anchor would pass on a deleted call.
    const files = [
        ['source', new URL('../src/bin/microverse-runner.ts', import.meta.url)],
        ['compiled mirror', new URL('../bin/microverse-runner.js', import.meta.url)],
    ];
    for (const [label, fileUrl] of files) {
        const body = fs.readFileSync(fileUrl, 'utf8');
        const parseAt = body.indexOf('const judgeResult = parseLlmJudgeOutput(metricResult.raw)');
        assert.ok(parseAt !== -1, `${label}: the runtime judge-parse seam must exist`);
        const emitAt = body.indexOf('emitJudgeLegacyShapeDiagnostic(judgeResult)');
        assert.ok(
            emitAt > parseAt,
            `${label}: the parse must emit judge_legacy_shape_inferred AFTER it parses — an unwired producer is the bug`,
        );
    }
});

test('AC-JPCM-10: parseLlmJudgeOutput stays a pure query on the legacy path too', () => {
    // Same regression guard as both siblings: "simplifying" by moving the emit
    // into the parser would append fabricated legacy notices to the operator's
    // real activity log on every test run that parses a score-only fixture.
    const dataRoot = makeTmpDir();
    const previousDataRoot = process.env.PICKLE_DATA_ROOT;
    process.env.PICKLE_DATA_ROOT = dataRoot;
    const originalWrite = process.stderr.write;
    process.stderr.write = () => true;
    try {
        parseLlmJudgeOutput(LEGACY_SHAPE_JUDGE_OUTPUT);
        const wrote = fs
            .readdirSync(dataRoot, { recursive: true, withFileTypes: true })
            .some((entry) => entry.isFile() && entry.name.endsWith('.jsonl'));
        assert.equal(wrote, false, 'parsing must not touch the activity log');
    } finally {
        process.stderr.write = originalWrite;
        if (previousDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = previousDataRoot;
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// AC-JPCM-8 — the no-commit stall exit must not mislabel a give-up as success
//
// `isConverged` is three-valued ('target' | 'stall' | null) precisely so its
// consumers can tell "the metric arrived" from "the loop ran out of patience"
// (ticket 25fa1aed). `evaluateIterationOutcome` honored that; the no-commit
// stall path re-collapsed it to a boolean and returned 'converged' either way
// — a phase that stopped committing at score 2 against target 0 reported
// success, exit code 0. Both sites now route through one mapper.
//
// These drive the COMPILED bin/ mirror, which is the artifact the runner
// actually executes, so no separate source-vs-mirror anchor is needed.
// ---------------------------------------------------------------------------

function makeLowerIsBetterState({ stallLimit, convergenceTarget, lastScore, stallCounter }) {
    const state = createMicroverseState({
        prdPath: 'prd.md',
        metric: {
            description: 'violations',
            validation: 'count',
            type: 'llm',
            tolerance: 0,
            timeout_seconds: 60,
            direction: 'lower',
        },
        stallLimit,
        convergenceTarget,
    });
    state.status = 'iterating';
    state.baseline_score = 10;
    state.convergence.stall_counter = stallCounter;
    state.convergence.history = [makeEntry(1, lastScore, 'accept')];
    return state;
}

// A missing iteration log classifies 'stall' (not clean_pass / amnesiac), which
// is the branch that used to hard-code 'converged'. Leaving pre/postIterSha off
// ctx keeps classifyStall null, so the stall path writes nothing to the
// operator's real activity log.
//
// AC-CF-16: that SHA-less ctx also leaves the observable-truth check unproven, so these two cases
// keep exercising the classifier path deliberately — they pin the terminal chain
// (recordStall -> isConverged -> convergenceExitReason) that the demoted proxy is now routed into,
// and they must stay green unchanged.
function runNoCommitStall(state, sessionDir) {
    return handleNoCommitStall(
        state,
        { sessionDir, log: () => {} },
        path.join(sessionDir, 'no-such-iteration.log'),
    );
}

test('AC-JPCM-8: a no-commit exit that exhausts stall_limit below target reports stalled_below_target', async () => {
    const sessionDir = makeTmpDir();
    try {
        const state = makeLowerIsBetterState({
            stallLimit: 5,
            convergenceTarget: 0,
            lastScore: 2, // ABOVE the target of 0 — the metric never arrived
            stallCounter: 4, // the recordStall inside takes it to 5 == stall_limit
        });

        const result = await runNoCommitStall(state, sessionDir);

        assert.equal(state.convergence.stall_counter, 5, 'precondition: stall_limit reached');
        assert.equal(isConverged(state), 'stall', 'precondition: the stall branch fired, not target');
        assert.equal(
            result,
            'stalled_below_target',
            'score 2 against target 0 is a give-up, not a convergence — `converged` here is the AC-JPCM-8 mislabel',
        );
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

test('AC-JPCM-8: a no-commit exit that DID reach the target still reports converged', async () => {
    const sessionDir = makeTmpDir();
    try {
        const state = makeLowerIsBetterState({
            stallLimit: 5,
            convergenceTarget: 0,
            lastScore: 0, // AT the target
            stallCounter: 0, // recordStall takes it to 1, well under the limit
        });

        const result = await runNoCommitStall(state, sessionDir);

        assert.equal(isConverged(state), 'target', 'precondition: the target branch fired');
        assert.equal(result, 'converged', 'a genuine target hit must not be demoted by the honesty fix');
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER4-01: the B-APNC ceiling asks "has this subsystem EVER passed
// clean?", not "is its clean STREAK currently zero?". `consecutive_clean` resets
// to 0 on the next pass that finds anything, so a subsystem that went clean once
// and then surfaced one more finding used to halt as "no clean pass" — one pass
// short of the 2-consecutive-clean convergence target.
// ---------------------------------------------------------------------------

test('AP-EXT-ITER4-01: a subsystem with an earlier clean pass is NOT halted after its streak resets', () => {
    const config = {
        subsystems: ['extension'],
        current_index: 0,
        pass_counts: { extension: 9 },
        // streak reset by the pass-9 finding — the pass-8 clean survives only in findings_history
        consecutive_clean: { extension: 0 },
        findings_history: {
            extension: [
                { iteration: 8, subsystem: 'extension', findings: [] },
                { iteration: 9, subsystem: 'extension', findings: [{ id: 'X-1', severity: 'HIGH' }] },
            ],
        },
    };
    assert.equal(
        classifyAnatomyNonConvergence(config, 8),
        null,
        'a subsystem that passed clean at iteration 8 has not "run 9 passes with no clean pass"',
    );
});

test('AP-EXT-ITER4-01: a subsystem that never passed clean still halts at the ceiling', () => {
    const config = {
        subsystems: ['extension'],
        current_index: 0,
        pass_counts: { extension: 9 },
        consecutive_clean: { extension: 0 },
        findings_history: {
            extension: [
                { iteration: 8, subsystem: 'extension', findings: [{ id: 'X-1', severity: 'HIGH' }] },
                { iteration: 9, subsystem: 'extension', findings: [{ id: 'X-2', severity: 'HIGH' }] },
            ],
        },
    };
    const hit = classifyAnatomyNonConvergence(config, 8);
    assert.ok(hit, 'the B-APNC ceiling must still fire when every recorded pass had findings');
    assert.equal(hit.subsystem, 'extension');
    assert.equal(hit.passCount, 9);
});

test('AP-EXT-ITER4-01: an unrecognized findings_history shape leaves the ceiling armed', () => {
    const base = {
        subsystems: ['extension'],
        current_index: 0,
        pass_counts: { extension: 8 },
        consecutive_clean: { extension: 0 },
    };
    for (const history of [
        undefined,
        { extension: 'not-an-array' },
        { extension: [{ iteration: 8 }] },            // findings absent — not evidence of clean
        { extension: [{ iteration: 8, findings: null }] },
        { other: [{ iteration: 8, findings: [] }] },  // a DIFFERENT subsystem's clean pass
    ]) {
        const hit = classifyAnatomyNonConvergence({ ...base, findings_history: history }, 8);
        assert.ok(hit, `expected halt for findings_history=${JSON.stringify(history)}`);
    }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER13-01: the ever-clean term must recognize the shape the PRODUCER
// actually writes. `findings_history` entries come from the anatomy-park worker
// prompt, which mandates only "append current findings summary" — no schema. A
// shipped session records a clean pass as a COUNT plus a verdict, never as an
// empty array, so the array-only reading was inert against every real ledger
// and the ceiling halted a subsystem that HAD passed clean.
//
// The fixtures below are verbatim entry shapes from a live
// `anatomy-park.json` (session 2026-08-09-20c4107d, subsystem `bin`).
// ---------------------------------------------------------------------------

test('AP-EXT-ITER13-01: a count-shaped clean pass is evidence of a clean pass', () => {
    const config = {
        subsystems: ['bin'],
        current_index: 0,
        pass_counts: { bin: 9 },
        // streak reset by the pass-9 finding; the pass-8 clean survives only in findings_history
        consecutive_clean: { bin: 0 },
        findings_history: {
            bin: [
                { iteration: 8, subsystem: 'bin', findings: 0, verdict: 'clean', note: 'all scripts re-verified' },
                { iteration: 9, subsystem: 'bin', findings: 1, verdict: 'fixed', fix: 'deadbeef — HIGH something' },
            ],
        },
    };
    assert.equal(
        classifyAnatomyNonConvergence(config, 8),
        null,
        'a `findings: 0` pass is a clean pass — the subsystem has not "run 9 passes with no clean pass"',
    );
});

test('AP-EXT-ITER13-01: a verdict-only clean pass is evidence of a clean pass', () => {
    const config = {
        subsystems: ['bin'],
        current_index: 0,
        pass_counts: { bin: 9 },
        consecutive_clean: { bin: 0 },
        findings_history: {
            bin: [
                { iteration: 8, subsystem: 'bin', verdict: 'Clean' },
                { iteration: 9, subsystem: 'bin', findings: 2, verdict: 'fixed' },
            ],
        },
    };
    assert.equal(
        classifyAnatomyNonConvergence(config, 8),
        null,
        'a `verdict: clean` pass is a clean pass regardless of letter case',
    );
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER44-01: the ever-clean term reads a SECOND live spelling of the same
// two concepts. The prompt (Override 5) fixes no entry schema, so a shipped run
// records the count as `confident_findings` and the outcome as `result` — the
// `findings`/`verdict` pair AP-EXT-ITER13-01 taught the reader is only one of the
// dialects in the wild. Against the `result`/`confident_findings` dialect the
// ever-clean term went inert again and the ceiling halted `bin` as "no clean
// pass" one pass after it recorded one.
//
// The entries below are VERBATIM from a live `anatomy-park.json`
// (session 2026-08-22-5c53a293, subsystem `bin`) — not hand-authored. A
// hand-authored fixture is exactly what let the previous inert reading pass.
// ---------------------------------------------------------------------------

test('AP-EXT-ITER44-01: a result/confident_findings clean pass is evidence of a clean pass', () => {
    const config = {
        subsystems: ['bin', 'extension'],
        current_index: 0,
        pass_counts: { bin: 8, extension: 2 },
        // the streak was reset by the pass-2 finding; the pass-1 clean survives only in the ledger
        consecutive_clean: { bin: 0, extension: 0 },
        stall_counts: { bin: 2, extension: 0 },
        findings_history: {
            bin: [
                { pass: 1, date: '2026-08-23', result: 'clean', confident_findings: 0, dropped_candidates: 5 },
                { pass: 2, date: '2026-08-23', result: 'stalled_scope_fence', confident_findings: 1, dropped_candidates: 5 },
            ],
            extension: [
                { pass: 1, date: '2026-08-23', result: 'fixed', confident_findings: 1, dropped_candidates: 3 },
            ],
        },
    };
    assert.equal(
        classifyAnatomyNonConvergence(config, 8),
        null,
        'a `confident_findings: 0` / `result: clean` pass is a clean pass — `bin` has not "run 8 passes with no clean pass"',
    );
});

test('AP-EXT-ITER44-01: the two arms are OR-ed, so widening the key table can never NARROW the reader', () => {
    const base = {
        subsystems: ['bin'],
        current_index: 0,
        pass_counts: { bin: 8 },
        consecutive_clean: { bin: 0 },
    };
    // A contradictory entry — a non-empty count beside a `clean` outcome. Ranking the count arm
    // above the verdict arm reads these non-clean and ARMS the ceiling, which is strictly worse
    // than the pre-table reader (it had no `confident_findings` key and honoured the verdict).
    // Bias WIDE: uncertain evidence must never halt. Both orderings of the contradiction are
    // pinned so neither key table can acquire precedence over the other.
    for (const history of [
        { bin: [{ pass: 8, confident_findings: [{ id: 'X-1' }], verdict: 'clean' }] },
        { bin: [{ pass: 8, confident_findings: 3, result: 'clean' }] },
        { bin: [{ pass: 8, findings: 3, verdict: 'clean' }] },
        { bin: [{ pass: 8, findings: [{ id: 'X-1' }], confident_findings: 0 }] },
    ]) {
        assert.equal(
            classifyAnatomyNonConvergence({ ...base, findings_history: history }, 8),
            null,
            `a contradictory entry must not arm the ceiling: ${JSON.stringify(history)}`,
        );
    }
});

test('AP-EXT-ITER44-01: a result-only clean verdict counts, and non-clean dialect passes stay armed', () => {
    const base = {
        subsystems: ['bin'],
        current_index: 0,
        pass_counts: { bin: 8 },
        consecutive_clean: { bin: 0 },
    };
    assert.equal(
        classifyAnatomyNonConvergence(
            { ...base, findings_history: { bin: [{ pass: 8, result: 'Clean' }] } },
            8,
        ),
        null,
        'a `result: clean` pass with no count is a clean pass, regardless of letter case',
    );
    for (const history of [
        // every recorded pass in this dialect had findings
        { bin: [{ pass: 8, result: 'stalled_scope_fence', confident_findings: 1 }] },
        { bin: [{ pass: 8, result: 'fixed', confident_findings: 2 }] },
        // a non-clean outcome with no count is not evidence either
        { bin: [{ pass: 8, result: 'stalled_scope_fence' }] },
        // a string count is an unrecognized shape, not a zero
        { bin: [{ pass: 8, confident_findings: '0' }] },
    ]) {
        const hit = classifyAnatomyNonConvergence({ ...base, findings_history: history }, 8);
        assert.ok(hit, `expected halt for findings_history=${JSON.stringify(history)}`);
    }
});

test('AP-EXT-ITER13-01: count-shaped and verdict-shaped NON-clean passes leave the ceiling armed', () => {
    const base = {
        subsystems: ['bin'],
        current_index: 0,
        pass_counts: { bin: 8 },
        consecutive_clean: { bin: 0 },
    };
    for (const history of [
        // a non-zero count is a pass WITH findings — not evidence of clean
        { bin: [{ iteration: 8, findings: 1, verdict: 'fixed' }] },
        // a non-clean verdict with no count is not evidence either
        { bin: [{ iteration: 8, verdict: 'fixed' }] },
        // NaN/Infinity counts are not zero
        { bin: [{ iteration: 8, findings: Number.NaN }] },
        // a string '0' is an unrecognized shape, not a count
        { bin: [{ iteration: 8, findings: '0' }] },
    ]) {
        const hit = classifyAnatomyNonConvergence({ ...base, findings_history: history }, 8);
        assert.ok(hit, `expected halt for findings_history=${JSON.stringify(history)}`);
    }
});

/**
 * AP-EXT-ITER7-01: `microverse.json` is written tmp-rename, so a crash in that window
 * leaves ONLY `microverse.json.tmp.<pid>`. `markMicroverseFatalError` short-circuited on
 * `fs.existsSync(mvPath)` immediately ABOVE its own `readRecoverableJsonObject(mvPath)`,
 * making that recovery call dead code — the top-level fatal handler then exited silently
 * without stamping `stopped`/`error`, and the "worker/fatal state" trap door's promotion
 * claim was false. The pre-fix code returned `null` quietly, so assert the RETURN
 * DISPOSITION, the promoted file on disk, and the written contents — never "no throw".
 */
function fatalDeadPidForTmp() {
    for (const candidate of [999_999, 888_888, 777_777]) {
        try { process.kill(candidate, 0); } catch { return candidate; }
    }
    throw new Error('no dead pid available for fixture');
}

test('AP-EXT-ITER7-01: a tmp-only microverse.json is still stamped stopped/error, and is promoted', () => {
    const sessionDir = makeTmpDir();
    try {
        const mvPath = path.join(sessionDir, 'microverse.json');
        const tmpPath = `${mvPath}.tmp.${fatalDeadPidForTmp()}`;
        fs.writeFileSync(tmpPath, JSON.stringify({ status: 'iterating', exit_reason: 'no_progress' }, null, 2));
        assert.equal(fs.existsSync(mvPath), false, 'fixture must start with NO base microverse.json');

        assert.equal(markMicroverseFatalError(sessionDir), 'overwritten');

        assert.equal(fs.existsSync(mvPath), true, 'the recoverable read must promote the tmp');
        assert.equal(fs.existsSync(tmpPath), false);
        const written = JSON.parse(fs.readFileSync(mvPath, 'utf-8'));
        assert.equal(written.status, 'stopped');
        assert.equal(written.exit_reason, 'error');
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

test('AP-EXT-ITER7-01: a tmp-only successful exit is preserved, not overwritten', () => {
    const sessionDir = makeTmpDir();
    try {
        const mvPath = path.join(sessionDir, 'microverse.json');
        const tmpPath = `${mvPath}.tmp.${fatalDeadPidForTmp()}`;
        fs.writeFileSync(tmpPath, JSON.stringify({ status: 'iterating', exit_reason: 'converged' }, null, 2));

        assert.equal(markMicroverseFatalError(sessionDir), 'preserved');

        const sibling = JSON.parse(
            fs.readFileSync(path.join(sessionDir, 'microverse-finalizer-error.json'), 'utf-8'),
        );
        assert.equal(sibling.preserved_exit_reason, 'converged');
        assert.equal(
            JSON.parse(fs.readFileSync(mvPath, 'utf-8')).exit_reason,
            'converged',
            'a successful exit reason must survive the fatal mark',
        );
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

test('AP-EXT-ITER7-01: a genuinely absent microverse.json is still a no-op (null)', () => {
    const sessionDir = makeTmpDir();
    try {
        assert.equal(markMicroverseFatalError(sessionDir), null);
        assert.equal(fs.existsSync(path.join(sessionDir, 'microverse.json')), false);
        assert.equal(fs.existsSync(path.join(sessionDir, 'microverse-finalizer-error.json')), false);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

// AP-EXT-ITER8-02: `scope.json` is written tmp-rename, so a crash in that window leaves
// only `scope.json.tmp.<pid>`. The R-SSOC post-iteration scope audit used to pre-gate on
// `fs.existsSync(scope.json)` and silently no-op there — committed paths outside the fence
// went unreported (fail-OPEN, no `worker_edit_outside_scope` event). Reading through
// `readRecoverableJsonObject` promotes the dead tmp onto the base path, which also re-arms
// `checkScopeDiff` (that helper existsSync-gates its own read).
function runTmpOnlyScopeAudit({ committedFiles, writeTmp = true }) {
    const sessionDir = makeTmpDir();
    const captured = [];
    const origSpawn = _deps.spawnSync;
    const origLog = _deps.logActivity;
    try {
        if (writeTmp) {
            // pid 999999 is outside the default macOS/Linux pid range → provably dead writer.
            fs.writeFileSync(
                path.join(sessionDir, 'scope.json.tmp.999999'),
                JSON.stringify({ allowed_paths: ['extension/src/bin'] }),
            );
        }
        _deps.spawnSync = () => ({ status: 0, stdout: committedFiles.map((f) => f + '\0').join('') });
        _deps.logActivity = (ev) => { captured.push(ev); };
        const ctx = {
            sessionDir,
            workingDir: sessionDir,
            preIterSha: 'a'.repeat(40),
            postIterSha: 'b'.repeat(40),
            log: () => {},
        };
        auditPostIterationScope(ctx, { current_subsystem: 'extension' });
        return {
            events: captured.filter((e) => e.event === 'worker_edit_outside_scope'),
            promoted: fs.existsSync(path.join(sessionDir, 'scope.json')),
        };
    } finally {
        _deps.spawnSync = origSpawn;
        _deps.logActivity = origLog;
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
}

test('AP-EXT-ITER8-02: a tmp-only scope.json still audits — drift is reported, not swallowed', () => {
    const { events, promoted } = runTmpOnlyScopeAudit({
        committedFiles: ['extension/src/services/pickle-utils.ts'],
    });
    assert.equal(promoted, true, 'the dead scope.json tmp must be promoted onto the base path');
    assert.equal(events.length, 1, 'the out-of-scope commit must emit worker_edit_outside_scope');
    assert.deepEqual(
        events[0].gate_payload.staged_paths_outside_scope,
        ['extension/src/services/pickle-utils.ts'],
    );
});

test('AP-EXT-ITER8-02: a tmp-only scope.json does not fabricate drift for in-scope commits', () => {
    const { events, promoted } = runTmpOnlyScopeAudit({
        committedFiles: ['extension/src/bin/microverse-runner.ts'],
    });
    assert.equal(promoted, true);
    assert.equal(events.length, 0, 'an in-scope commit must stay silent');
});

test('AP-EXT-ITER8-02: a genuinely absent scope.json remains a no-op', () => {
    const { events, promoted } = runTmpOnlyScopeAudit({
        committedFiles: ['anything/at/all.ts'],
        writeTmp: false,
    });
    assert.equal(promoted, false, 'no scope.json may be conjured from nothing');
    assert.equal(events.length, 0);
});

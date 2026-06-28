// @tier: fast
/**
 * anatomy-park-convergence-guard.test.js  (B-APNC WS-1 + WS-2)
 *
 * WS-1: anatomy-park halts-and-reports a non-convergent subsystem after N passes
 *       (default 8, env PICKLE_APNC_MAX_PASSES_WITHOUT_CLEAN) without a clean pass,
 *       as a NON-FATAL phase end (pipeline continues to szechuan per R-PHC-6).
 * WS-2: a worker pass whose committed fix RAISES the subsystem's lint complexity-rule
 *       count (eslint complexity / max-lines-per-function) over the pass-start baseline
 *       is counted as a non-clean (regressing) pass and emits a breadcrumb.
 *
 * Covers AC-APNC-1 / AC-APNC-2 / AC-APNC-3 against the pure classifiers and the thin
 * runner-wired emitters (no subprocess, no git, no claude).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    _deps,
    classifyAnatomyNonConvergence,
    maybeHaltAnatomyNonConvergent,
    countComplexityRuleFailures,
    classifyComplexityRegression,
    maybeEmitComplexityRegression,
} from '../bin/microverse-runner.js';
import { classifyMicroverseHaltDecision } from '../bin/pipeline-runner.js';
import { resolveApncMaxPassesWithoutClean } from '../bin/mux-runner.js';
import { isMicroverseFailureExit, MICROVERSE_FATAL_REASONS } from '../types/index.js';

function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'apnc-'));
}

function lintFailure(ruleOrCode) {
    return {
        check: 'lint',
        file: 'extension/src/services/ticket-completion-evidence.ts',
        line: 1,
        ruleOrCode,
        message: `${ruleOrCode} exceeded`,
        severity: 'error',
        occurrence_index: 0,
    };
}

/** Run fn with _deps.logActivity stubbed to capture emitted events. */
function withCapturedActivity(fn) {
    const original = _deps.logActivity;
    const events = [];
    _deps.logActivity = (entry) => { events.push(entry); };
    try {
        const result = fn(events);
        return { result, events };
    } finally {
        _deps.logActivity = original;
    }
}

// ---------------------------------------------------------------------------
// AC-APNC-1: pass_counts >= 8 with consecutive_clean === 0 → halt; 7 → continue.
// ---------------------------------------------------------------------------

test('AC-APNC-1: pass_counts=8 & consecutive_clean=0 → non-convergent halt disposition', () => {
    const config = {
        subsystems: ['extension'],
        current_index: 0,
        pass_counts: { extension: 8 },
        consecutive_clean: { extension: 0 },
    };
    const hit = classifyAnatomyNonConvergence(config, resolveApncMaxPassesWithoutClean());
    assert.ok(hit, 'expected a non-convergent halt disposition (not continue)');
    assert.equal(hit.subsystem, 'extension');
    assert.equal(hit.passCount, 8);
});

test('AC-APNC-1: pass_counts=7 still continues (null disposition)', () => {
    const config = {
        subsystems: ['extension'],
        current_index: 0,
        pass_counts: { extension: 7 },
        consecutive_clean: { extension: 0 },
    };
    assert.equal(classifyAnatomyNonConvergence(config, 8), null);
});

test('AC-APNC-1: a clean pass (consecutive_clean > 0) is NOT non-convergent even at the cap', () => {
    const config = {
        subsystems: ['extension'],
        current_index: 0,
        pass_counts: { extension: 12 },
        consecutive_clean: { extension: 1 },
    };
    assert.equal(classifyAnatomyNonConvergence(config, 8), null);
});

test('AC-APNC-1: env override PICKLE_APNC_MAX_PASSES_WITHOUT_CLEAN tunes the ceiling', () => {
    assert.equal(resolveApncMaxPassesWithoutClean({}), 8, 'default is 8');
    assert.equal(resolveApncMaxPassesWithoutClean({ PICKLE_APNC_MAX_PASSES_WITHOUT_CLEAN: '3' }), 3);
    // invalid / non-positive / fractional fall back to the default
    assert.equal(resolveApncMaxPassesWithoutClean({ PICKLE_APNC_MAX_PASSES_WITHOUT_CLEAN: '0' }), 8);
    assert.equal(resolveApncMaxPassesWithoutClean({ PICKLE_APNC_MAX_PASSES_WITHOUT_CLEAN: '-2' }), 8);
    assert.equal(resolveApncMaxPassesWithoutClean({ PICKLE_APNC_MAX_PASSES_WITHOUT_CLEAN: '2.5' }), 8);
    assert.equal(resolveApncMaxPassesWithoutClean({ PICKLE_APNC_MAX_PASSES_WITHOUT_CLEAN: 'oops' }), 8);
});

test('AC-APNC-1: malformed/absent config yields null (defensive)', () => {
    assert.equal(classifyAnatomyNonConvergence(null, 8), null);
    assert.equal(classifyAnatomyNonConvergence({}, 8), null);
    assert.equal(classifyAnatomyNonConvergence({ subsystems: [] }, 8), null);
});

// ---------------------------------------------------------------------------
// AC-APNC-2: the halt emits exactly ONE operator-visible event (subsystem + pass
// count) AND pipeline-runner treats it as a non-fatal phase end (continues), NOT a crash.
// ---------------------------------------------------------------------------

test('AC-APNC-2: classifyMicroverseHaltDecision routes anatomy_non_convergent to a non-fatal continue', () => {
    const decision = classifyMicroverseHaltDecision('anatomy_non_convergent');
    assert.equal(decision.action, 'run-finalize-gate-incomplete', 'must continue, not abort');
    assert.notEqual(decision.action, 'abort');
    assert.equal(decision.recognizedExitReason, 'anatomy_non_convergent');
});

test('AC-APNC-2: anatomy_non_convergent is NOT a fatal/failure microverse exit', () => {
    assert.equal(isMicroverseFailureExit('anatomy_non_convergent'), false);
    assert.ok(!MICROVERSE_FATAL_REASONS.includes('anatomy_non_convergent'));
});

test('AC-APNC-2: halt emits exactly ONE anatomy_park_non_convergent_halt naming subsystem + pass count', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(
        path.join(dir, 'anatomy-park.json'),
        JSON.stringify({
            subsystems: ['extension'],
            current_index: 0,
            pass_counts: { extension: 8 },
            consecutive_clean: { extension: 0 },
        }),
    );
    const ctx = { sessionDir: dir, log: () => {} };
    const state = { convergence_file: 'anatomy-park.json' };

    const { result, events } = withCapturedActivity(() => maybeHaltAnatomyNonConvergent(state, ctx));

    assert.equal(result, 'anatomy_non_convergent');
    const halts = events.filter((e) => e.event === 'anatomy_park_non_convergent_halt');
    assert.equal(halts.length, 1, 'exactly one operator-visible halt event');
    assert.equal(halts[0].gate_payload.subsystem, 'extension');
    assert.equal(halts[0].gate_payload.pass_count, 8);
    assert.ok(typeof halts[0].ts === 'string' && halts[0].ts.length > 0, 'event carries ts');
});

test('AC-APNC-2: below the ceiling emits NO halt event and returns null', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(
        path.join(dir, 'anatomy-park.json'),
        JSON.stringify({
            subsystems: ['extension'],
            current_index: 0,
            pass_counts: { extension: 7 },
            consecutive_clean: { extension: 0 },
        }),
    );
    const ctx = { sessionDir: dir, log: () => {} };
    const state = { convergence_file: 'anatomy-park.json' };

    const { result, events } = withCapturedActivity(() => maybeHaltAnatomyNonConvergent(state, ctx));

    assert.equal(result, null);
    assert.equal(events.filter((e) => e.event === 'anatomy_park_non_convergent_halt').length, 0);
});

// ---------------------------------------------------------------------------
// AC-APNC-3: a pass whose post-iteration lint complexity-rule count > pass baseline
// is non-clean + emits anatomy_park_complexity_regression; a lower/hold pass is unaffected.
// ---------------------------------------------------------------------------

test('AC-APNC-3: countComplexityRuleFailures counts only complexity / max-lines-per-function lint rules', () => {
    const failures = [
        lintFailure('complexity'),
        lintFailure('max-lines-per-function'),
        lintFailure('no-unused-vars'), // not a complexity rule
        { check: 'typecheck', file: 'x.ts', line: 1, ruleOrCode: 'TS2322', message: '', severity: 'error', occurrence_index: 0 },
    ];
    assert.equal(countComplexityRuleFailures(failures), 2);
    assert.equal(countComplexityRuleFailures([]), 0);
    assert.equal(countComplexityRuleFailures(null), 0);
});

test('AC-APNC-3: classifyComplexityRegression — strictly greater is a regression', () => {
    const baseline = [lintFailure('complexity')];
    const worse = [lintFailure('complexity'), lintFailure('max-lines-per-function')];
    assert.equal(classifyComplexityRegression(baseline, worse), true);
});

test('AC-APNC-3: classifyComplexityRegression — lower or hold is NOT a regression', () => {
    const baseline = [lintFailure('complexity'), lintFailure('complexity')];
    const held = [lintFailure('complexity'), lintFailure('complexity')];
    const lower = [lintFailure('complexity')];
    assert.equal(classifyComplexityRegression(baseline, held), false);
    assert.equal(classifyComplexityRegression(baseline, lower), false);
});

test('AC-APNC-3: a regressing pass emits exactly ONE anatomy_park_complexity_regression breadcrumb', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'gate'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'gate', 'baseline.json'),
        JSON.stringify({ schema_version: 1, failures: [lintFailure('complexity')] }),
    );
    const ctx = { sessionDir: dir, log: () => {} };
    const state = { current_subsystem: 'extension' };
    const post = [lintFailure('complexity'), lintFailure('max-lines-per-function')];

    const { result, events } = withCapturedActivity(() => maybeEmitComplexityRegression(state, ctx, post));

    assert.equal(result, true, 'regressing pass is non-clean');
    const breadcrumbs = events.filter((e) => e.event === 'anatomy_park_complexity_regression');
    assert.equal(breadcrumbs.length, 1, 'exactly one breadcrumb');
    assert.equal(breadcrumbs[0].gate_payload.subsystem, 'extension');
    assert.equal(breadcrumbs[0].gate_payload.baseline_complexity_count, 1);
    assert.equal(breadcrumbs[0].gate_payload.post_complexity_count, 2);
});

test('AC-APNC-3: a holding/lowering pass is unaffected — no breadcrumb, returns false', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'gate'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'gate', 'baseline.json'),
        JSON.stringify({ schema_version: 1, failures: [lintFailure('complexity'), lintFailure('complexity')] }),
    );
    const ctx = { sessionDir: dir, log: () => {} };
    const state = { current_subsystem: 'extension' };
    const held = [lintFailure('complexity'), lintFailure('complexity')];

    const { result, events } = withCapturedActivity(() => maybeEmitComplexityRegression(state, ctx, held));

    assert.equal(result, false);
    assert.equal(events.filter((e) => e.event === 'anatomy_park_complexity_regression').length, 0);
});

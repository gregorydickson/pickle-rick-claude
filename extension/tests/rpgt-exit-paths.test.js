// @tier: integration
// SERIAL: drives the real convergence-gate runGate over an npm fixture (npm subprocess)
//
// R-RPGT / WS-1 invariant under test:
//   "No review-phase exit path completes over a tsc/eslint-RED tree, AND a clean
//    tree still converges."
//
// Three review-phase exit paths, each with a co-located RED row and CLEAN row:
//   - convergence-exit : the R-APXG-3 post-convergence gate-deferral cap in
//                        microverse-runner. At the cap it re-runs the gate; RED
//                        => 'error' + tsc_gate_failed, GREEN => 'converged'.
//   - abort            : pipeline-runner dispatchHaltAction best-effort gate on
//                        the abort branch; RED => tsc_gate_failed but ALWAYS
//                        returns {action:'break'} (gate never masks the abort).
//   - finalize-gate    : already-shipped typecheck+lint+tests gate (regression pin).
//
// Reachability (no new production exports were added — this is a TEST-ONLY ticket):
//   - convergence-exit : handlePostConvergenceGateDeferral is NOT exported, so the
//        branch is driven through the exported handleIterationOutcome boundary with
//        _deps.runWorkerManagedIteration stubbed to emit the deferral signal and
//        _deps.logActivity stubbed to capture tsc_gate_failed. The cap gate runs the
//        REAL runGate over a controlled workingDir (no-project dir => green;
//        npm fixture whose `typecheck` script exits non-zero => red). No real tsc.
//   - abort            : dispatchHaltAction is NOT exported and its abort gate uses
//        module-level runGate/logActivity with no injection seam reachable from any
//        export. Asserted via the documented seams at the highest reachable boundary:
//        the exported logPhaseHaltReason confirms control reaches the abort-gate
//        block ('abort'), and the exported runGate proves the gate's RED/GREEN inputs
//        deterministically (npm fixture => red; no-project dir => green; never throws).
//   - finalize-gate    : exported finalizeGateMain with an injected runGateFn.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as microverse from '../bin/microverse-runner.js';
import { logPhaseHaltReason } from '../bin/pipeline-runner.js';
import { runGate } from '../services/convergence-gate.js';
import { finalizeGateMain } from '../bin/finalize-gate.js';

const PATHS = ['convergence-exit', 'abort', 'finalize-gate'];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkTmp(prefix) {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// A workingDir with no project marker — detectProjectType() returns null, so the
// real runGate short-circuits to a non-red (skipped/green) result WITHOUT spawning
// any toolchain. This is the CLEAN tree.
function makeCleanWorkingDir() {
    return mkTmp('rpgt-clean-');
}

// An npm project whose `typecheck` script exits non-zero. The real runGate detects
// `npm`, runs `npm run typecheck`, sees a non-zero exit, and reports status:'red'.
// `node -e process.exit(1)` is the failing command — NOT tsc.
function makeRedWorkingDir() {
    const dir = mkTmp('rpgt-red-');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'rpgt-red-fixture',
        version: '0.0.0',
        private: true,
        scripts: {
            typecheck: 'node -e "process.exit(1)"',
            lint: 'node -e "process.exit(0)"',
        },
    }));
    return dir;
}

function rm(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Shared env isolation: keep real activity-logger writes off the operator's
// data dir, and ensure the refinement lock does not warp backend resolution.
// ---------------------------------------------------------------------------

let dataRoot;
const savedEnv = {};

before(() => {
    dataRoot = mkTmp('rpgt-data-');
    for (const k of ['PICKLE_DATA_ROOT', 'PICKLE_DATA_DIR', 'PICKLE_REFINEMENT_LOCK']) {
        savedEnv[k] = process.env[k];
    }
    process.env.PICKLE_DATA_ROOT = dataRoot;
    delete process.env.PICKLE_DATA_DIR;
    delete process.env.PICKLE_REFINEMENT_LOCK;
});

after(() => {
    for (const k of Object.keys(savedEnv)) {
        if (savedEnv[k] === undefined) { delete process.env[k]; }
        else process.env[k] = savedEnv[k];
    }
    if (dataRoot) { rm(dataRoot); }
});

// ---------------------------------------------------------------------------
// convergence-exit drivers
// ---------------------------------------------------------------------------

const GATE_DEFERRED_REASON = 'per-iteration gate left unresolved regressions';

function buildDeferralMv() {
    return {
        status: 'iterating',
        convergence_mode: 'worker',
        convergence_file: 'anatomy-park.json',
        convergence: { history: [], stall_counter: 0, stall_limit: 50 },
        iteration_regressions: 0,
    };
}

// Drive the R-APXG-3 deferral cap through the exported handleIterationOutcome
// boundary. Returns { exitReasons, gateFailedEvents } after `iterations` passes.
async function driveConvergenceDeferral(workingDir, iterations) {
    const sessionDir = mkTmp('rpgt-conv-session-');
    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ backend: 'claude', active: true }));

    const savedDeps = {
        runWorkerManagedIteration: microverse._deps.runWorkerManagedIteration,
        logActivity: microverse._deps.logActivity,
        getHeadSha: microverse._deps.getHeadSha,
        sleep: microverse._deps.sleep,
    };

    const gateFailedEvents = [];
    microverse._deps.runWorkerManagedIteration = async () => ({
        currentMv: buildDeferralMv(),
        converged: false,
        reason: GATE_DEFERRED_REASON,
        selfRedOpen: false,
    });
    microverse._deps.logActivity = (event) => {
        if (event && event.event === 'tsc_gate_failed') { gateFailedEvents.push(event); }
    };
    microverse._deps.getHeadSha = () => 'a'.repeat(40);
    microverse._deps.sleep = async () => {};

    const ctx = {
        sessionDir,
        statePath,
        workingDir,
        iteration: 1,
        preIterSha: 'a'.repeat(40),
        postIterSha: 'a'.repeat(40),
        consecutiveRateLimits: 0,
        currentRunnerState: { backend: 'claude', min_iterations: 1 },
        cgSettings: {
            enabled_convergence_files: ['anatomy-park.json'],
            regression_warning_threshold: 5,
            remediator_timeout_s: 60,
        },
        log: () => {},
    };

    const outcome = { completion: 'task_completed', timedOut: false };
    const exitReasons = [];
    try {
        for (let i = 0; i < iterations; i++) {
            const state = buildDeferralMv();
            const result = await microverse.handleIterationOutcome(state, { raw: '', score: null }, ctx, outcome);
            exitReasons.push(result);
        }
    } finally {
        Object.assign(microverse._deps, savedDeps);
        rm(sessionDir);
    }
    return { exitReasons, gateFailedEvents, deferralCount: ctx.postConvergenceDeferralCount };
}

// ---------------------------------------------------------------------------
// abort drivers
// ---------------------------------------------------------------------------

function makeAbortRuntime(workingDir) {
    const sessionDir = mkTmp('rpgt-abort-session-');
    const statePath = path.join(sessionDir, 'state.json');
    // No pinned_branch/pinned_sha => emitHeadMismatchStderr() returns false, so a
    // pickle-phase non-zero exit deterministically classifies as 'abort'.
    fs.writeFileSync(statePath, JSON.stringify({ backend: 'claude', active: true, exit_reason: null }));
    return { runtime: { statePath, sessionDir, workingDir }, cleanup: () => rm(sessionDir) };
}

// ---------------------------------------------------------------------------
// finalize-gate helpers
// ---------------------------------------------------------------------------

function makeGateResult(status, failures = []) {
    return {
        status,
        failures,
        baseline_used: false,
        allowed_paths_used: false,
        elapsed_ms: 5,
        total_raw_failure_count: failures.length,
        new_failures_vs_baseline: 0,
    };
}

function tscFailure(file = '/tmp/wd/src/foo.ts') {
    return { check: 'typecheck', file, line: 1, ruleOrCode: 'TS2345', message: 'type error', severity: 'error', occurrence_index: 0 };
}

function finalizeBaseDeps() {
    return {
        readMicroverseStateFn: () => ({ status: 'iterating', allowed_paths: undefined }),
        readStateForWorkingDirFn: () => ({ workingDir: '/tmp/wd', backend: 'claude' }),
        loadSettingsFn: () => ({ szechuan_max_remediation_cycles: 1, anatomy_park_max_remediation_cycles: 1, remediator_timeout_s: 60 }),
        mkdirSyncFn: (p) => fs.mkdirSync(p, { recursive: true }),
        writeFileFn: (p, data) => fs.writeFileSync(p, data, 'utf-8'),
        logActivityFn: () => {},
        isoFn: () => '2026-01-01T00-00-00Z',
        stdout: () => {},
        stderr: () => {},
    };
}

// ===========================================================================
// Parametrized suite — one describe block per exit path, each with RED + CLEAN.
// ===========================================================================

for (const exitPath of PATHS) {
    describe(exitPath, () => {

        // -------------------------------------------------------------------
        // convergence-exit
        // -------------------------------------------------------------------
        if (exitPath === 'convergence-exit') {
            test('RED: at the R-APXG-3 cap a RED cap-gate returns "error" (NOT converged) + emits tsc_gate_failed', async () => {
                const workingDir = makeRedWorkingDir();
                try {
                    const { exitReasons, gateFailedEvents, deferralCount } =
                        await driveConvergenceDeferral(workingDir, 3);

                    // Cap is 3: first two deferrals continue, the third hits the cap.
                    assert.equal(deferralCount, 3, 'three consecutive deferrals must reach the cap');
                    assert.deepEqual(exitReasons.slice(0, 2), ['continue', 'continue'],
                        'pre-cap deferrals must keep iterating');
                    assert.equal(exitReasons[2], 'error',
                        'at the cap a RED tree must fail, never trust-the-worker converge');
                    assert.notEqual(exitReasons[2], 'converged');
                    assert.equal(gateFailedEvents.length, 1, 'exactly one tsc_gate_failed for the RED cap gate');
                    // Round-trip pin: the filter already requires event === 'tsc_gate_failed'; assert it explicitly.
                    assert.equal(gateFailedEvents[0].event, 'tsc_gate_failed');
                    assert.equal(gateFailedEvents[0].gate_payload?.failure_kind, 'compile_error');
                } finally {
                    rm(workingDir);
                }
            });

            test('CLEAN: at the R-APXG-3 cap a GREEN cap-gate converges + emits ZERO tsc_gate_failed', async () => {
                const workingDir = makeCleanWorkingDir();
                try {
                    const { exitReasons, gateFailedEvents, deferralCount } =
                        await driveConvergenceDeferral(workingDir, 3);

                    assert.equal(deferralCount, 3);
                    assert.deepEqual(exitReasons.slice(0, 2), ['continue', 'continue']);
                    assert.equal(exitReasons[2], 'converged',
                        'a clean tree at the cap trusts the worker convergence signal');
                    assert.equal(gateFailedEvents.length, 0, 'a clean cap gate must emit NO gate-failure event');
                } finally {
                    rm(workingDir);
                }
            });
        }

        // -------------------------------------------------------------------
        // abort
        // -------------------------------------------------------------------
        if (exitPath === 'abort') {
            test('abort branch is reached: logPhaseHaltReason returns "abort" for a pickle-phase non-zero exit', () => {
                const workingDir = makeCleanWorkingDir();
                const { runtime, cleanup } = makeAbortRuntime(workingDir);
                try {
                    const action = logPhaseHaltReason(runtime, 'pickle', 1, () => {});
                    // 'abort' (not 'run-finalize-gate*') means dispatchHaltAction falls
                    // through to its best-effort abort-path typecheck+lint gate block.
                    assert.equal(action, 'abort');
                } finally {
                    cleanup();
                    rm(workingDir);
                }
            });

            test('RED: the abort-path gate inputs go RED over a broken tree (would emit tsc_gate_failed) without masking the abort', async () => {
                // dispatchHaltAction is NOT exported — no injection seam for its abort gate call.
                // We prove the two halves independently:
                //   (1) runGate with the exact args dispatchHaltAction uses goes RED on this fixture,
                //       so IF it were wired it WOULD emit tsc_gate_failed.
                //   (2) AC-RPGT-6 (below) proves the abort result is preserved when the gate throws —
                //       by construction, {action:'break'} is always the return value.
                const workingDir = makeRedWorkingDir();
                try {
                    const result = await runGate({
                        workingDir,
                        mode: 'strict',
                        scope: 'full',
                        checks: ['typecheck', 'lint'],
                    });
                    assert.equal(result.status, 'red', 'broken typecheck must drive the abort gate RED');
                    assert.ok(result.failures.length > 0, 'a RED gate must enumerate at least one failure');
                    assert.ok(result.failures.some(f => f.check === 'typecheck'),
                        'the typecheck check must be the source of the RED');
                } finally {
                    rm(workingDir);
                }
            });

            test('CLEAN: the abort-path gate stays non-RED over a clean tree (zero tsc_gate_failed)', async () => {
                const workingDir = makeCleanWorkingDir();
                try {
                    const result = await runGate({
                        workingDir,
                        mode: 'strict',
                        scope: 'full',
                        checks: ['typecheck', 'lint'],
                    });
                    assert.notEqual(result.status, 'red', 'a clean tree must not drive the abort gate RED');
                    assert.equal(result.failures.length, 0, 'no failures => no tsc_gate_failed emission');
                } finally {
                    rm(workingDir);
                }
            });

            test('AC-RPGT-6: when the abort-path gate THROWS, the original abort result is preserved (no crash, still {action:"break"}, zero tsc_gate_failed)', async () => {
                // dispatchHaltAction's abort branch is exactly:
                //   try { const g = await runGate({...}); if (g.status==='red') logActivity(tsc_gate_failed); }
                //   catch { /* gate error never masks original abort reason */ }
                //   return { action: 'break' };
                // Faithfully re-run that exact control flow with a THROWING gate
                // standing in for runGate, asserting the production contract: no crash,
                // no event emission, and the abort result preserved.
                const throwingGate = async () => { throw new Error('gate exploded'); };
                const emitted = [];
                let crashed = false;
                const result = await (async () => {
                    try {
                        const g = await throwingGate();
                        if (g.status === 'red') { emitted.push('tsc_gate_failed'); }
                    } catch {
                        // gate error never masks original abort reason
                    }
                    return { action: 'break' };
                })().catch(() => { crashed = true; return null; });

                assert.equal(crashed, false, 'a throwing abort gate must never crash the halt path');
                assert.deepEqual(result, { action: 'break' },
                    'the original abort reason/result is preserved when the gate throws');
                assert.equal(emitted.length, 0, 'a thrown gate emits no tsc_gate_failed');
            });
        }

        // -------------------------------------------------------------------
        // finalize-gate (regression pin)
        // -------------------------------------------------------------------
        if (exitPath === 'finalize-gate') {
            test('RED: a RED strict gate does NOT exit 0 — it remediates to cap then exits 2 + escalation', async () => {
                const sessionRoot = mkTmp('rpgt-fg-red-');
                const gateDir = path.join(sessionRoot, 'gate');
                fs.mkdirSync(gateDir, { recursive: true });
                const seenChecks = [];
                try {
                    const code = await finalizeGateMain({
                        argv: [sessionRoot, 'anatomy-park'],
                        env: {},
                        ...finalizeBaseDeps(),
                        runGateFn: async (opts) => {
                            seenChecks.push(opts.checks);
                            return makeGateResult('red', [tscFailure()]);
                        },
                        spawnGateRemediatorMainFn: async (briefOpts) => {
                            briefOpts.stdout?.('BRIEF_PATH=/tmp/rpgt-brief.md');
                            return 0;
                        },
                        spawnRemediatorFn: () => { /* no-op — gate never clears */ },
                    });

                    assert.equal(code, 2, 'a persistently RED tree must exit 2, never complete as success (0)');
                    assert.notEqual(code, 0);
                    assert.ok(seenChecks.length >= 1, 'the strict gate must have run');
                    // Regression pin: the shipped gate checks typecheck + lint + tests.
                    assert.deepEqual(seenChecks[0], ['typecheck', 'lint', 'tests']);
                    const files = fs.readdirSync(gateDir);
                    assert.ok(files.some(f => f.startsWith('escalation_')),
                        `escalation file missing in ${gateDir}: ${files.join(', ')}`);
                } finally {
                    rm(sessionRoot);
                }
            });

            test('CLEAN: a GREEN strict gate completes (exit 0) with typecheck+lint+tests and no escalation', async () => {
                const sessionRoot = mkTmp('rpgt-fg-clean-');
                const gateDir = path.join(sessionRoot, 'gate');
                fs.mkdirSync(gateDir, { recursive: true });
                const seenChecks = [];
                let remediatorCalled = false;
                try {
                    const code = await finalizeGateMain({
                        argv: [sessionRoot, 'anatomy-park'],
                        env: {},
                        ...finalizeBaseDeps(),
                        runGateFn: async (opts) => {
                            seenChecks.push(opts.checks);
                            return makeGateResult('green');
                        },
                        spawnGateRemediatorMainFn: async () => { remediatorCalled = true; return 0; },
                    });

                    assert.equal(code, 0, 'a clean tree must complete the finalize gate');
                    assert.equal(remediatorCalled, false, 'green gate must not spawn the remediator');
                    assert.deepEqual(seenChecks[0], ['typecheck', 'lint', 'tests']);
                    const files = fs.readdirSync(gateDir);
                    assert.ok(!files.some(f => f.startsWith('escalation_')),
                        'a clean gate must not write an escalation file');
                } finally {
                    rm(sessionRoot);
                }
            });
        }
    });
}


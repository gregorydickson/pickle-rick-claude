// @tier: fast
// R-APXG-3: regression tests for the post-convergence exit-gate wall-count bound.
// The bound prevents an indefinite hang when the per-iteration gate keeps deferring
// convergence (e.g., because withCleanTemporaryCheckout fails on an out-of-scope
// dirty file and the strict gate then finds pre-existing failures).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleIterationOutcome, _deps } from '../bin/microverse-runner.js';
import {
    createMicroverseState,
    writeMicroverseState,
} from '../services/microverse-state.js';

function makeTempDir(prefix = 'pickle-apxg3-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeRunnerState(sessionDir, workingDir) {
    return {
        active: true,
        working_dir: workingDir,
        step: 'implement',
        iteration: 0,
        max_iterations: 50,
        max_time_minutes: 60,
        worker_timeout_seconds: 0,
        start_time_epoch: Math.floor(Date.now() / 1000),
        completion_promise: null,
        original_prompt: 'test',
        current_ticket: null,
        history: [],
        started_at: new Date().toISOString(),
        session_dir: sessionDir,
        tmux_mode: true,
        command_template: 'anatomy-park.md',
    };
}

function makeWorkerCtx(sessionDir, workingDir, runnerState) {
    return {
        sessionDir,
        extensionRoot: path.resolve('.'),
        statePath: path.join(sessionDir, 'state.json'),
        workingDir,
        startTime: Date.now(),
        initialIteration: 0,
        enableFailureClassification: false,
        cgSettings: {
            enabled_convergence_files: ['anatomy-park.json'],
            regression_warning_threshold: 5,
            remediator_timeout_s: 600,
            baseline_max_age_iterations: 30,
            baseline_max_age_seconds: 14_400,
        },
        rateLimitWaitMinutes: 1,
        maxRateLimitRetries: 1,
        log: () => {},
        currentRunnerState: runnerState,
        iteration: 1,
        consecutiveRateLimits: 0,
        preIterSha: 'abc0000',
        postIterSha: 'abc0000',
        postConvergenceDeferralCount: 0,
    };
}

function setupSession(sessionDir, workingDir) {
    const runnerState = makeRunnerState(sessionDir, workingDir);
    fs.writeFileSync(
        path.join(sessionDir, 'state.json'),
        JSON.stringify(runnerState, null, 2),
    );
    const mv = createMicroverseState({
        prdPath: path.join(workingDir, 'prd.md'),
        metric: {
            description: 'none',
            validation: 'none',
            type: 'none',
            timeout_seconds: 0,
            tolerance: 0,
            direction: 'lower',
        },
        stallLimit: 5,
    });
    mv.status = 'iterating';
    mv.convergence_mode = 'worker';
    mv.convergence_file = 'anatomy-park.json';
    writeMicroverseState(sessionDir, mv);
    // anatomy-park.json convergence file (worker convergence state)
    fs.writeFileSync(
        path.join(sessionDir, 'anatomy-park.json'),
        JSON.stringify({ subsystems: [], current_index: 0, stall_counts: {} }),
    );
    return { runnerState, mv };
}

const GATE_DEFERRAL_REASON = 'per-iteration gate left unresolved regressions';
const isTerminal = (result) => result !== null && result !== 'continue';

// Drives handleIterationOutcome the way executeMainLoop does, stopping at the first terminal result.
// `workerResult(mv, call)` is the worker's per-iteration return (call is 1-based); `gate`, when
// given, stubs the baseline-aware cap gate. Returns every result, the terminal one last.
async function driveIterations({ workerResult, getHeadSha, gate, iterations = 10 }) {
    const sessionDir = makeTempDir('pickle-apxg3-');
    const workingDir = makeTempDir('pickle-apxg3-w-');
    const origRunWorker = _deps.runWorkerManagedIteration;
    const origGetHead = _deps.getHeadSha;
    const origSleep = _deps.sleep;
    const origRunGate = _deps.runGate;
    try {
        const { runnerState, mv } = setupSession(sessionDir, workingDir);
        let call = 0;
        _deps.runWorkerManagedIteration = async () => workerResult(mv, (call += 1));
        _deps.getHeadSha = getHeadSha;
        _deps.sleep = async () => {};
        if (gate) _deps.runGate = gate;

        const ctx = makeWorkerCtx(sessionDir, workingDir, runnerState);
        // outcome: worker ran successfully (classifyIterationExit → { type: 'success' })
        const outcome = { completion: 'task_completed', timedOut: false, exitCode: 0, wallSeconds: 1 };
        const baseline = { raw: '', score: 0 };

        const results = [];
        for (let i = 1; i <= iterations; i++) {
            ctx.iteration = i;
            const result = await handleIterationOutcome(mv, baseline, ctx, outcome);
            results.push(result);
            if (isTerminal(result)) break;
        }
        return results;
    } finally {
        _deps.runWorkerManagedIteration = origRunWorker;
        _deps.getHeadSha = origGetHead;
        _deps.sleep = origSleep;
        _deps.runGate = origRunGate;
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
    }
}

// Worker that always claims convergence but has it deferred by the per-iteration gate.
const alwaysDeferred = (mv) => ({ currentMv: mv, converged: false, reason: GATE_DEFERRAL_REASON });

// AC-APXG-3-1: gate completes within bounded iterations — no indefinite hang.
// Simulates the scenario where an out-of-scope dirty file causes withCleanTemporaryCheckout
// to fail, falling back to strict mode, but the strict gate also fails (pre-existing failures).
// The defensive bound (POST_CONVERGENCE_GATE_DEFERRAL_LIMIT = 3) must fire before the
// 4th deferred-convergence iteration, returning 'converged' to exit cleanly.
test('R-APXG-3-1: post-convergence gate deferral exits within bounded wall-count (no hang)', async () => {
    const results = await driveIterations({ workerResult: alwaysDeferred, getHeadSha: () => 'abc1234' });

    // Must exit within the deferral limit (3), never reaching call 10
    assert.ok(
        results.length <= 3,
        `gate bound must fire by call 3 (POST_CONVERGENCE_GATE_DEFERRAL_LIMIT); took ${results.length}`,
    );
    assert.ok(isTerminal(results.at(-1)), 'exit gate must produce a terminal reason — no indefinite hang');
});

// AC-APXG-3-2: terminal disposition is 'converged' — closing banner is reached,
// no manual kill needed.
test('R-APXG-3-2: terminal disposition after deferral bound is converged (not error/hung)', async () => {
    const results = await driveIterations({ workerResult: alwaysDeferred, getHeadSha: () => 'def5678' });

    // AC-APXG-3-2: the session exits as 'converged' — the worker's convergence signal is
    // trusted; the closing banner path (microverseExitCode('converged') = 0) is reached
    // without a manual kill.
    assert.equal(
        results.at(-1),
        'converged',
        'terminal disposition must be converged so the closing banner is reached — not null (hang) or error',
    );
});

// Regression: non-deferred iterations reset the deferral counter so only
// consecutive gate-deferrals count toward the limit.
test('R-APXG-3: deferral counter resets on non-deferred iteration', async () => {
    // calls 1-2: deferred convergence
    // call 3: normal stall (not a gate deferral) — resets the counter
    // calls 4-6: deferred convergence again → bound fires on call 6
    let callCount = 0;
    const results = await driveIterations({
        workerResult: (mv, call) => {
            callCount = call;
            return call === 3 ? { currentMv: mv, converged: false, reason: 'stall' } : alwaysDeferred(mv);
        },
        getHeadSha: () => 'reset-sha',
    });

    // Counter resets at call 3, so the limit fires at call 6 (3 consecutive after reset)
    assert.equal(callCount, 6, `deferral bound must fire on call 6 (2 deferred + 1 reset + 3 deferred); got ${callCount}`);
    assert.equal(results.at(-1), 'converged', 'terminal disposition after reset+reaccumulation must be converged');
});

// R-ORSR-6 INV-NO-DEFERRAL-FORCE-EXIT-ON-SELF-RED, as bounded by B-SELFRED: a worker that disowns its
// OWN tsc red (the interface-change sweep flags a self-introduced break -> selfRedOpen: true) can
// never be converged by attrition alone. The refusal is unbounded only while work lands: after
// POST_CONVERGENCE_GATE_DEFERRAL_LIMIT refusals with HEAD UNCHANGED the baseline-aware cap gate
// (`runCapGate`, reached through `_deps.runGate`) decides — never the worker's claim. RED ends the
// phase 'no_progress'; a HEAD that moves keeps resetting the count, so the bound cannot fire.
// (The pre-B-SELFRED pin held HEAD constant with no gate stub and demanded 'converged' never come
// back at all, which B-SELFRED changed on purpose.)
//
// Mutation controls, each verified on the compiled mirror to red ONLY its own case:
//   (a) turn the `verdict.kind === 'red'` arm of `handleSelfRedRefusalBound` into `return 'converged'`;
//   (b) make `recordSelfRedRefusal` stop resetting the count when HEAD moves (always increment).
function capGateStub(status) {
    const red = status === 'red';
    const stub = async () => {
        stub.calls += 1;
        return {
            status,
            failures: red
                ? [{ ruleOrCode: 'TS0000', message: 'still broken', severity: 'error', occurrence_index: 0 }]
                : [],
            baseline_used: false,
            allowed_paths_used: false,
            elapsed_ms: 0,
            total_raw_failure_count: red ? 1 : 0,
            new_failures_vs_baseline: red ? 1 : 0,
            check_status: { typecheck: 'ran', lint: 'ran' },
        };
    };
    stub.calls = 0;
    return stub;
}

// Every iteration the worker signals the gate-deferral reason AND the sweep reports a
// self-introduced whole-repo break (selfRedOpen: true) — the worker disowns its own regression.
function driveSelfRedIterations({ getHeadSha, gate, iterations }) {
    return driveIterations({
        workerResult: (mv) => ({ ...alwaysDeferred(mv), selfRedOpen: true }),
        getHeadSha,
        gate,
        iterations,
    });
}

test('R-ORSR-6: HEAD unchanged + RED cap gate is never converged and ends no_progress at the bound', async () => {
    const gate = capGateStub('red');
    const results = await driveSelfRedIterations({ getHeadSha: () => 'selfred1', gate, iterations: 6 });

    assert.ok(
        results.every((r) => r !== 'converged'),
        `a red cap gate must never converge a self-introduced red; got ${JSON.stringify(results)}`,
    );
    // Deferrals 1 and 2 keep iterating; deferral 3 reaches POST_CONVERGENCE_GATE_DEFERRAL_LIMIT.
    assert.deepEqual(
        results.slice(0, 2).map(isTerminal), [false, false],
        `the bound must not fire before the limit; got ${JSON.stringify(results)}`,
    );
    assert.equal(
        results[2], 'no_progress',
        `the bound must end the phase non-convergent when the cap gate is red; got ${JSON.stringify(results)}`,
    );
    assert.equal(results.length, 3, 'the terminal result must end the loop at the bound');
    assert.equal(gate.calls, 1, 'the cap gate, not the worker claim, must have decided the terminal result');
});

test('R-ORSR-6: HEAD advancing each iteration is never converged even with a GREEN cap gate', async () => {
    const gate = capGateStub('green');
    let head = 0;
    const results = await driveSelfRedIterations({ getHeadSha: () => `selfred-head-${(head += 1)}`, gate, iterations: 6 });

    assert.ok(
        results.every((r) => r !== 'converged'),
        `a self-introduced red must not be disowned by attrition while HEAD keeps moving; got ${JSON.stringify(results)}`,
    );
    assert.equal(results.length, 6, `no iteration may be terminal while work lands; got ${JSON.stringify(results)}`);
    assert.equal(gate.calls, 0, 'a moving HEAD resets the refusal count, so the bound must never consult the gate');
});

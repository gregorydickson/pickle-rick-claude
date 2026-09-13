// @tier: fast
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { finalizeGateMain } from '../../bin/finalize-gate.js';
import { AC_PHASE_MANIFEST } from '../../services/ac-phase-gate.js';

function makeTmpDir() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fg-test-')));
}

function makeGateResult(status = 'green', failures = []) {
    return {
        status,
        failures,
        baseline_used: false,
        allowed_paths_used: false,
        elapsed_ms: 10,
        total_raw_failure_count: failures.length,
        new_failures_vs_baseline: 0,
    };
}

function makeFailure(file = '/tmp/src/foo.ts') {
    return { check: 'lint', file, line: 1, ruleOrCode: 'no-any', message: 'no any', severity: 'error', occurrence_index: 0 };
}

function baseDeps(sessionRoot) {
    return {
        readMicroverseStateFn: () => ({ status: 'iterating', allowed_paths: undefined }),
        readStateForWorkingDirFn: () => ({ workingDir: '/tmp/wd', backend: 'claude' }),
        loadSettingsFn: () => ({ szechuan_max_remediation_cycles: 2, anatomy_park_max_remediation_cycles: 2, remediator_timeout_s: 60 }),
        mkdirSyncFn: () => {},
        writeFileFn: (p, data) => fs.writeFileSync(p, data, 'utf-8'),
        logActivityFn: () => {},
        isoFn: () => '2026-01-01T00-00-00Z',
        stdout: () => {},
        stderr: () => {},
    };
}

// ---------------------------------------------------------------------------
// Arg validation
// ---------------------------------------------------------------------------

describe('arg validation', () => {
    test('missing session-root → exit 1', async () => {
        const errs = [];
        const code = await finalizeGateMain({
            argv: [],
            stderr: m => errs.push(m),
            stdout: () => {},
        });
        assert.equal(code, 1);
        assert.ok(errs.some(l => l.includes('Usage')));
    });

    test('missing skill → exit 1', async () => {
        const code = await finalizeGateMain({
            argv: ['/tmp/session'],
            stderr: () => {},
            stdout: () => {},
        });
        assert.equal(code, 1);
    });

    test('invalid skill → exit 1', async () => {
        const errs = [];
        const code = await finalizeGateMain({
            argv: ['/tmp/session', 'bad-skill'],
            stderr: m => errs.push(m),
            stdout: () => {},
        });
        assert.equal(code, 1);
        assert.ok(errs.some(l => l.includes('Invalid skill')));
    });
});

// ---------------------------------------------------------------------------
// PICKLE_GATE_DISABLED kill switch
// ---------------------------------------------------------------------------

describe('PICKLE_GATE_DISABLED', () => {
    test('PICKLE_GATE_DISABLED=1 → exit 0, gate_skipped event emitted', async () => {
        const events = [];
        const outs = [];
        const code = await finalizeGateMain({
            argv: ['/tmp/session', 'szechuan'],
            env: { PICKLE_GATE_DISABLED: '1' },
            logActivityFn: e => events.push(e),
            stdout: m => outs.push(m),
            stderr: () => {},
        });
        assert.equal(code, 0);
        assert.ok(events.some(e => e.event === 'gate_skipped' && e.gate_payload?.reason === 'kill_switch'));
        assert.ok(outs.some(l => l.includes('PICKLE_GATE_DISABLED')));
    });

    test('PICKLE_GATE_DISABLED unset → gate runs normally', async () => {
        const sessionRoot = makeTmpDir();
        fs.mkdirSync(path.join(sessionRoot, 'gate'), { recursive: true });
        let gateCalled = false;
        const code = await finalizeGateMain({
            argv: [sessionRoot, 'szechuan'],
            env: {},
            ...baseDeps(sessionRoot),
            runGateFn: async () => { gateCalled = true; return makeGateResult('green'); },
        });
        assert.equal(code, 0);
        assert.ok(gateCalled);
        fs.rmSync(sessionRoot, { recursive: true, force: true });
    });
});

// ---------------------------------------------------------------------------
// Green first cycle
// ---------------------------------------------------------------------------

describe('green gate', () => {
    test('phase-ordered AC bundle-end failure halts before strict gate', async () => {
        const sessionRoot = makeTmpDir();
        fs.writeFileSync(path.join(sessionRoot, AC_PHASE_MANIFEST), JSON.stringify({
            acceptance_criteria: [
                {
                    id: 'AC-BUNDLE-END',
                    evaluation_phase: 'bundle-end',
                    command: [process.execPath, '-e', 'process.exit(1)'],
                },
                {
                    id: 'AC-PER-PHASE',
                    evaluation_phase: 'per-phase',
                    command: [process.execPath, '-e', 'process.exit(1)'],
                },
            ],
        }));
        let gateCalled = false;
        const code = await finalizeGateMain({
            argv: [sessionRoot, 'szechuan'],
            ...baseDeps(sessionRoot),
            runGateFn: async () => { gateCalled = true; return makeGateResult('green'); },
        });

        assert.equal(code, 2);
        assert.equal(gateCalled, false);
    });

    test('green on cycle 1 → exit 0 without calling remediator', async () => {
        const sessionRoot = makeTmpDir();
        fs.mkdirSync(path.join(sessionRoot, 'gate'), { recursive: true });
        let remediatorCalled = false;
        const code = await finalizeGateMain({
            argv: [sessionRoot, 'szechuan'],
            env: {},
            ...baseDeps(sessionRoot),
            runGateFn: async () => makeGateResult('green'),
            spawnGateRemediatorMainFn: async () => { remediatorCalled = true; return 0; },
        });
        assert.equal(code, 0);
        assert.equal(remediatorCalled, false);
        fs.rmSync(sessionRoot, { recursive: true, force: true });
    });

    test('green-with-known-flake-warnings → exit 0', async () => {
        const sessionRoot = makeTmpDir();
        fs.mkdirSync(path.join(sessionRoot, 'gate'), { recursive: true });
        const code = await finalizeGateMain({
            argv: [sessionRoot, 'anatomy-park'],
            env: {},
            ...baseDeps(sessionRoot),
            runGateFn: async () => makeGateResult('green-with-known-flake-warnings'),
        });
        assert.equal(code, 0);
        fs.rmSync(sessionRoot, { recursive: true, force: true });
    });
});

// ---------------------------------------------------------------------------
// Cap exhaustion → exit 2 + escalation file
// ---------------------------------------------------------------------------

describe('cap exhaustion', () => {
    test('invalid numeric settings default before controlling strict gate loop', async () => {
        const sessionRoot = makeTmpDir();
        const gateDir = path.join(sessionRoot, 'gate');
        fs.mkdirSync(gateDir, { recursive: true });

        const failure = makeFailure('/tmp/wd/src/foo.ts');
        const briefPath = path.join(sessionRoot, 'brief.md');
        fs.writeFileSync(briefPath, 'fix the gate');
        let gateRuns = 0;
        const timeouts = [];

        const code = await finalizeGateMain({
            argv: [sessionRoot, 'anatomy-park'],
            env: {},
            readMicroverseStateFn: () => ({ status: 'iterating', allowed_paths: undefined }),
            readStateForWorkingDirFn: () => ({ workingDir: '/tmp/wd', backend: 'claude' }),
            loadSettingsFn: () => ({
                szechuan_max_remediation_cycles: -1,
                anatomy_park_max_remediation_cycles: 0,
                remediator_timeout_s: 0.5,
            }),
            mkdirSyncFn: (p) => fs.mkdirSync(p, { recursive: true }),
            writeFileFn: (p, data) => fs.writeFileSync(p, data, 'utf-8'),
            logActivityFn: () => {},
            isoFn: () => '2026-01-01T00-00-00Z',
            runGateFn: async () => {
                gateRuns += 1;
                return makeGateResult('red', [failure]);
            },
            spawnGateRemediatorMainFn: async (briefOpts) => {
                briefOpts.stdout?.(`BRIEF_PATH=${briefPath}`);
                return 0;
            },
            spawnRemediatorFn: (_cmd, _args, opts) => {
                timeouts.push(opts.timeout);
            },
            stdout: () => {},
            stderr: () => {},
        });

        assert.equal(code, 2);
        assert.equal(gateRuns, 5, 'invalid anatomy cap should fall back to the default five cycles');
        assert.deepEqual(timeouts, [600_000, 600_000, 600_000, 600_000, 600_000]);
        fs.rmSync(sessionRoot, { recursive: true, force: true });
    });

    test('cap=1 persistent failure → exit 2 + escalation file', async () => {
        const sessionRoot = makeTmpDir();
        const gateDir = path.join(sessionRoot, 'gate');
        fs.mkdirSync(gateDir, { recursive: true });

        const failure = makeFailure('/tmp/wd/src/foo.ts');
        const code = await finalizeGateMain({
            argv: [sessionRoot, 'szechuan'],
            env: {},
            readMicroverseStateFn: () => ({ status: 'iterating', allowed_paths: undefined }),
            readStateForWorkingDirFn: () => ({ workingDir: '/tmp/wd', backend: 'claude' }),
            loadSettingsFn: () => ({ szechuan_max_remediation_cycles: 1, anatomy_park_max_remediation_cycles: 1, remediator_timeout_s: 60 }),
            mkdirSyncFn: (p) => fs.mkdirSync(p, { recursive: true }),
            writeFileFn: (p, data) => fs.writeFileSync(p, data, 'utf-8'),
            logActivityFn: () => {},
            isoFn: () => '2026-01-01T00-00-00Z',
            runGateFn: async () => makeGateResult('red', [failure]),
            spawnGateRemediatorMainFn: async (briefOpts) => {
                briefOpts.stdout?.('BRIEF_PATH=/tmp/brief.md');
                return 0;
            },
            spawnRemediatorFn: () => { /* no-op — gate won't clear */ },
            stdout: () => {},
            stderr: () => {},
        });

        assert.equal(code, 2);
        const files = fs.readdirSync(gateDir);
        assert.ok(files.some(f => f.startsWith('escalation_')), `escalation file missing in ${gateDir}: ${files.join(', ')}`);
        fs.rmSync(sessionRoot, { recursive: true, force: true });
    });
});

// ---------------------------------------------------------------------------
// microverse.json missing → exit 1
// ---------------------------------------------------------------------------

describe('error conditions', () => {
    test('missing microverse.json → exit 1', async () => {
        const errs = [];
        const code = await finalizeGateMain({
            argv: ['/nonexistent/session', 'szechuan'],
            env: {},
            readMicroverseStateFn: () => null,
            readStateForWorkingDirFn: () => ({ workingDir: '/tmp', backend: 'claude' }),
            loadSettingsFn: () => ({ szechuan_max_remediation_cycles: 3, anatomy_park_max_remediation_cycles: 5, remediator_timeout_s: 600 }),
            mkdirSyncFn: () => {},
            writeFileFn: () => {},
            logActivityFn: () => {},
            isoFn: () => '2026-01-01T00-00-00Z',
            stderr: m => errs.push(m),
            stdout: () => {},
        });
        assert.equal(code, 1);
        assert.ok(errs.some(l => l.includes('microverse.json')));
    });

    test('missing state.json → exit 1', async () => {
        const errs = [];
        const code = await finalizeGateMain({
            argv: ['/nonexistent/session', 'szechuan'],
            env: {},
            readMicroverseStateFn: () => ({ status: 'iterating', allowed_paths: undefined }),
            readStateForWorkingDirFn: () => null,
            loadSettingsFn: () => ({ szechuan_max_remediation_cycles: 3, anatomy_park_max_remediation_cycles: 5, remediator_timeout_s: 600 }),
            mkdirSyncFn: () => {},
            writeFileFn: () => {},
            logActivityFn: () => {},
            isoFn: () => '2026-01-01T00-00-00Z',
            stderr: m => errs.push(m),
            stdout: () => {},
        });
        assert.equal(code, 1);
        assert.ok(errs.some(l => l.includes('state.json')));
    });

    test('default state reader recovers orphan tmp before choosing working_dir', async () => {
        const sessionRoot = makeTmpDir();
        const staleRepo = path.join(sessionRoot, 'stale-repo');
        const liveRepo = path.join(sessionRoot, 'live-repo');
        fs.mkdirSync(staleRepo, { recursive: true });
        fs.mkdirSync(liveRepo, { recursive: true });

        const statePath = path.join(sessionRoot, 'state.json');
        // R-anatomy-park-services orphan-tmp validation requires complete state snapshots
        // (working_dir, original_prompt, started_at, session_dir as strings; iteration,
        // max_iterations, max_time_minutes, worker_timeout_seconds, start_time_epoch
        // finite; history array; completion_promise key present). Partial snapshots are
        // rejected to prevent corrupting state.json mid-write.
        const baseState = {
            working_dir: staleRepo,
            backend: 'claude',
            step: 'research',
            iteration: 1,
            max_iterations: 50,
            max_time_minutes: 720,
            worker_timeout_seconds: 1200,
            start_time_epoch: 1700000000,
            original_prompt: 'test',
            session_dir: sessionRoot,
            started_at: '2026-01-01T00:00:00Z',
            history: [],
            completion_promise: null,
            schema_version: 3,
        };
        fs.writeFileSync(statePath, JSON.stringify(baseState));
        fs.writeFileSync(`${statePath}.tmp.99999999`, JSON.stringify({
            ...baseState,
            working_dir: liveRepo,
            backend: 'codex',
            iteration: 2,
        }));

        const seen = [];
        const code = await finalizeGateMain({
            argv: [sessionRoot, 'anatomy-park'],
            env: {},
            readMicroverseStateFn: () => ({ status: 'iterating', allowed_paths: undefined }),
            loadSettingsFn: () => ({ szechuan_max_remediation_cycles: 1, anatomy_park_max_remediation_cycles: 1, remediator_timeout_s: 60 }),
            mkdirSyncFn: (p) => fs.mkdirSync(p, { recursive: true }),
            writeFileFn: (p, data) => fs.writeFileSync(p, data, 'utf-8'),
            logActivityFn: () => {},
            isoFn: () => '2026-01-01T00-00-00Z',
            runGateFn: async (opts) => {
                seen.push({ workingDir: opts.workingDir });
                return makeGateResult('green');
            },
            stdout: () => {},
            stderr: () => {},
        });

        assert.equal(code, 0);
        assert.deepEqual(seen, [{ workingDir: liveRepo }]);
        const promotedState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(promotedState.working_dir, liveRepo);
        assert.equal(promotedState.backend, 'codex');

        fs.rmSync(sessionRoot, { recursive: true, force: true });
    });

    test('strict gate result handoff bypasses injected plain writer and reaches brief prep as JSON', async () => {
        const sessionRoot = makeTmpDir();
        const failure = makeFailure('/tmp/wd/src/foo.ts');
        let gateRuns = 0;
        let briefSawResult = false;

        const code = await finalizeGateMain({
            argv: [sessionRoot, 'anatomy-park'],
            env: {},
            readMicroverseStateFn: () => ({ status: 'iterating', allowed_paths: undefined }),
            readStateForWorkingDirFn: () => ({ workingDir: '/tmp/wd', backend: 'claude' }),
            loadSettingsFn: () => ({ szechuan_max_remediation_cycles: 2, anatomy_park_max_remediation_cycles: 2, remediator_timeout_s: 60 }),
            mkdirSyncFn: (p) => fs.mkdirSync(p, { recursive: true }),
            writeFileFn: (p, data) => {
                assert.ok(!path.basename(p).startsWith('gate_result_cycle_'), 'gate-result handoff must not use the injectable plain writer');
                fs.writeFileSync(p, data, 'utf-8');
            },
            logActivityFn: () => {},
            isoFn: () => '2026-01-01T00-00-00Z',
            runGateFn: async () => {
                gateRuns += 1;
                return gateRuns === 1 ? makeGateResult('red', [failure]) : makeGateResult('green');
            },
            spawnGateRemediatorMainFn: async (briefOpts) => {
                const gateResultPath = briefOpts.argv[briefOpts.argv.indexOf('--gate-result') + 1];
                const raw = JSON.parse(fs.readFileSync(gateResultPath, 'utf-8'));
                assert.equal(raw.status, 'red');
                assert.equal(raw.failures.length, 1);
                briefSawResult = true;
                briefOpts.stdout?.('BRIEF_PATH=/tmp/brief.md');
                return 0;
            },
            spawnRemediatorFn: () => {},
            stdout: () => {},
            stderr: () => {},
        });

        assert.equal(code, 0);
        assert.equal(briefSawResult, true);
        fs.rmSync(sessionRoot, { recursive: true, force: true });
    });

    test('default settings loader promotes newer dead-writer tmp before applying remediation cap', async () => {
        const sessionRoot = makeTmpDir();
        const extRoot = makeTmpDir();
        const settingsPath = path.join(extRoot, 'pickle_settings.json');
        const tmpSettingsPath = `${settingsPath}.tmp.99999999`;
        const failure = makeFailure('/tmp/wd/src/foo.ts');
        const briefPath = path.join(sessionRoot, 'brief.md');
        const previousExtensionDir = process.env.EXTENSION_DIR;

        fs.writeFileSync(settingsPath, JSON.stringify({
            convergence_gate: {
                szechuan_max_remediation_cycles: 2,
                anatomy_park_max_remediation_cycles: 2,
                remediator_timeout_s: 60,
            },
        }));
        fs.writeFileSync(tmpSettingsPath, JSON.stringify({
            convergence_gate: {
                szechuan_max_remediation_cycles: 1,
                anatomy_park_max_remediation_cycles: 1,
                remediator_timeout_s: 60,
            },
        }));
        const newer = new Date(Date.now() + 1000);
        fs.utimesSync(tmpSettingsPath, newer, newer);
        fs.writeFileSync(briefPath, 'fix the gate');

        let gateRuns = 0;
        try {
            process.env.EXTENSION_DIR = extRoot;
            const code = await finalizeGateMain({
                argv: [sessionRoot, 'anatomy-park'],
                env: {},
                readMicroverseStateFn: () => ({ status: 'iterating', allowed_paths: undefined }),
                readStateForWorkingDirFn: () => ({ workingDir: '/tmp/wd', backend: 'claude' }),
                mkdirSyncFn: (p) => fs.mkdirSync(p, { recursive: true }),
                writeFileFn: (p, data) => fs.writeFileSync(p, data, 'utf-8'),
                logActivityFn: () => {},
                isoFn: () => '2026-01-01T00-00-00Z',
                runGateFn: async () => {
                    gateRuns += 1;
                    return makeGateResult('red', [failure]);
                },
                spawnGateRemediatorMainFn: async (briefOpts) => {
                    briefOpts.stdout?.(`BRIEF_PATH=${briefPath}`);
                    return 0;
                },
                spawnRemediatorFn: () => {},
                stdout: () => {},
                stderr: () => {},
            });

            assert.equal(code, 2);
            assert.equal(gateRuns, 1, 'recovered cap=1 should stop after one strict gate run');
            assert.equal(fs.existsSync(tmpSettingsPath), false);
            const promoted = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
            assert.equal(promoted.convergence_gate.anatomy_park_max_remediation_cycles, 1);
        } finally {
            if (previousExtensionDir === undefined) delete process.env.EXTENSION_DIR;
            else process.env.EXTENSION_DIR = previousExtensionDir;
            fs.rmSync(sessionRoot, { recursive: true, force: true });
            fs.rmSync(extRoot, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// V3 (GitHub #15): a sentinel-only failing list must not burn a remediation cycle
// ---------------------------------------------------------------------------

describe('V3: unmeasured sentinel-only failures', () => {
    // What runGate returns when a check times out: a `<timeout>` pseudo-file AND check_status 'failed'.
    const timeoutFailure = { check: 'tests', file: '<timeout>', line: 0, ruleOrCode: 'GATE_CHECK_TIMEOUT', message: 'tests timed out after 300000ms', severity: 'error', occurrence_index: 0 };

    function runV3(sessionRoot, gateResult) {
        const calls = { gate: 0, briefPrep: 0, remediator: 0, briefFailures: [] };
        const briefPath = path.join(sessionRoot, 'brief.md');
        fs.writeFileSync(briefPath, 'fix the gate');
        return finalizeGateMain({
            argv: [sessionRoot, 'szechuan'],
            env: {},
            ...baseDeps(sessionRoot),
            runGateFn: async () => { calls.gate += 1; return gateResult; },
            spawnGateRemediatorMainFn: async (briefOpts) => {
                calls.briefPrep += 1;
                const resultPath = briefOpts.argv[briefOpts.argv.indexOf('--gate-result') + 1];
                calls.briefFailures.push(JSON.parse(fs.readFileSync(resultPath, 'utf-8')).failures);
                briefOpts.stdout?.(`BRIEF_PATH=${briefPath}`);
                return 0;
            },
            spawnRemediatorFn: () => { calls.remediator += 1; },
        }).then(code => ({ code, calls }));
    }

    test('V3-1: a sentinel-only failing list is reported unmeasured and spends no remediation cycle', async () => {
        const sessionRoot = makeTmpDir();
        const gateDir = path.join(sessionRoot, 'gate');
        fs.mkdirSync(gateDir, { recursive: true });
        const result = { ...makeGateResult('red', [timeoutFailure]), check_status: { typecheck: 'ran', lint: 'ran', tests: 'failed' } };

        const { code, calls } = await runV3(sessionRoot, result);

        assert.equal(calls.gate, 1, 'the gate is not re-run against a check that cannot measure');
        assert.equal(calls.briefPrep, 0, 'no brief is prepared for a pseudo-file');
        assert.equal(calls.remediator, 0, 'no remediator is spawned for a pseudo-file');
        assert.equal(code, 2, 'unmeasured is not success');
        assert.ok(fs.readdirSync(gateDir).some(f => f.startsWith('unmeasured_')), 'the unmeasured gate is reported');
        fs.rmSync(sessionRoot, { recursive: true, force: true });
    });

    test('V3-4: a genuine failing file still consumes a cycle and is remediated', async () => {
        const sessionRoot = makeTmpDir();
        fs.mkdirSync(path.join(sessionRoot, 'gate'), { recursive: true });
        const real = makeFailure('/tmp/wd/src/foo.ts');
        const result = { ...makeGateResult('red', [timeoutFailure, real]), check_status: { typecheck: 'ran', lint: 'ran', tests: 'failed' } };

        const { code, calls } = await runV3(sessionRoot, result);

        assert.equal(code, 2, 'cap exhausted — gate never clears');
        assert.equal(calls.remediator, 2, 'every cycle up to the cap spawns the remediator');
        assert.ok(calls.briefFailures.every(fs_ => fs_.some(f => f.file === real.file)), 'the real failure reaches every brief');
        fs.rmSync(sessionRoot, { recursive: true, force: true });
    });

    test('V3: the remediation brief carries only actionable failures, never the pseudo-file', async () => {
        const sessionRoot = makeTmpDir();
        fs.mkdirSync(path.join(sessionRoot, 'gate'), { recursive: true });
        const real = makeFailure('/tmp/wd/src/foo.ts');
        const result = { ...makeGateResult('red', [timeoutFailure, real]), check_status: { typecheck: 'ran', lint: 'ran', tests: 'failed' } };

        const { calls } = await runV3(sessionRoot, result);

        assert.deepEqual(calls.briefFailures.map(fs_ => fs_.map(f => f.file)), [[real.file], [real.file]]);
        fs.rmSync(sessionRoot, { recursive: true, force: true });
    });

    test('V3-4: a real failure of a check that timed out in a sibling dir is still remediated', async () => {
        const sessionRoot = makeTmpDir();
        fs.mkdirSync(path.join(sessionRoot, 'gate'), { recursive: true });
        // check_status escalates across target dirs, so one dir's timeout marks the whole check 'failed'.
        const realTests = { ...timeoutFailure, file: '/tmp/wd/packages/b', ruleOrCode: '1', message: 'not ok 1 - b breaks' };
        const result = { ...makeGateResult('red', [timeoutFailure, realTests]), check_status: { typecheck: 'ran', lint: 'ran', tests: 'failed' } };

        const { calls } = await runV3(sessionRoot, result);

        assert.equal(calls.remediator, 2);
        assert.ok(calls.briefFailures[0].some(f => f.file === '/tmp/wd/packages/b'), 'the real tests failure reaches the brief');
        fs.rmSync(sessionRoot, { recursive: true, force: true });
    });
});

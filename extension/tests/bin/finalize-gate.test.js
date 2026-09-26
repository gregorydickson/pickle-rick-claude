// @tier: fast
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { finalizeGateMain, namesEditableFile } from '../../bin/finalize-gate.js';
import { AC_PHASE_MANIFEST } from '../../services/ac-phase-gate.js';
import { assignOccurrenceIndices, buildFailures, subtractBaseline } from '../../services/convergence-gate.js';

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

function baseDeps(sessionRoot, mvWrites = []) {
    return {
        readMicroverseStateFn: () => ({ status: 'iterating', allowed_paths: undefined }),
        writeMicroverseStateFn: (dir, state) => { mvWrites.push({ dir, state }); },
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
        const calls = { gate: 0, briefPrep: 0, remediator: 0, briefFailures: [], mvWrites: [] };
        const briefPath = path.join(sessionRoot, 'brief.md');
        fs.writeFileSync(briefPath, 'fix the gate');
        return finalizeGateMain({
            argv: [sessionRoot, 'szechuan'],
            env: {},
            ...baseDeps(sessionRoot, calls.mvWrites),
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

    test('V3-1: a sentinel-only failing list is disclosed unmeasured (exit 0) and spends no remediation cycle', async () => {
        const sessionRoot = makeTmpDir();
        const gateDir = path.join(sessionRoot, 'gate');
        fs.mkdirSync(gateDir, { recursive: true });
        const result = { ...makeGateResult('red', [timeoutFailure]), check_status: { typecheck: 'ran', lint: 'ran', tests: 'failed' } };

        const { code, calls } = await runV3(sessionRoot, result);

        assert.equal(calls.gate, 1, 'the gate is not re-run against a check that cannot measure');
        assert.equal(calls.briefPrep, 0, 'no brief is prepared for a pseudo-file');
        assert.equal(calls.remediator, 0, 'no remediator is spawned for a pseudo-file');
        // B-FINALGATE: unmeasured is DISCLOSED (exit 0 + cap_unmeasured_checks), never a failed phase.
        assert.equal(code, 0, 'an unmeasured check is disclosed, not failed');
        assert.ok(fs.readdirSync(gateDir).some(f => f.startsWith('unmeasured_')), 'the unmeasured gate is reported');
        assert.deepEqual(calls.mvWrites.map(w => w.state.cap_unmeasured_checks), [['tests']]);
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
        // The sibling's row names a REAL, editable file — a row that names only a directory is #50's
        // subject and is pinned by the B-FINALGATE #50 block below.
        const realFile = path.join(sessionRoot, 'packages', 'b', 'b.test.js');
        fs.mkdirSync(path.dirname(realFile), { recursive: true });
        fs.writeFileSync(realFile, 'x');
        const realTests = { ...timeoutFailure, file: realFile, ruleOrCode: 'b breaks', message: 'not ok 1 - b breaks' };
        const result = { ...makeGateResult('red', [timeoutFailure, realTests]), check_status: { typecheck: 'ran', lint: 'ran', tests: 'failed' } };

        const { calls } = await runV3(sessionRoot, result);

        assert.equal(calls.remediator, 2);
        assert.ok(calls.briefFailures[0].some(f => f.file === realFile), 'the real tests failure reaches the brief');
        fs.rmSync(sessionRoot, { recursive: true, force: true });
    });
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER272-01: the scope split and the fence must share ONE path space
// ---------------------------------------------------------------------------

function initScopeRepo() {
    const root = makeTmpDir();
    // 30_000 matches `git-utils.ts`'s own git budget and clears the subprocess-heavy WARN band
    // (<= 15000), so this fixture needs no serial-manifest entry.
    const git = (args, extra = {}) =>
        execFileSync('git', args, { cwd: root, timeout: 30_000, ...extra });
    git(['init'], { stdio: 'ignore' });
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test User']);
    fs.mkdirSync(path.join(root, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pkg', 'mod.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(root, 'other.ts'), 'export const b = 2;\n');
    git(['add', '-A']);
    git(['commit', '-m', 'fixture', '--no-gpg-sign'], { stdio: 'ignore' });
    return root;
}

// Drives the SHIPPED finalize gate over a REAL git repo: `allowed_paths` is spelled
// repo-root-relative (the `resolve-scope.ts` --show-toplevel contract, R-RSBI-2) while
// `workingDir` is `state.working_dir` = the operator's launch dir. Returns the exit code
// and whether the cycle declared every failure out of scope.
async function runScopeSplit({ repoRoot, workingDir, failureFile, allowedPaths }) {
    const sessionRoot = makeTmpDir();
    fs.mkdirSync(path.join(sessionRoot, 'gate'), { recursive: true });
    const lines = [];
    let remediatedFailures = null;

    const code = await finalizeGateMain({
        argv: [sessionRoot, 'anatomy-park'],
        env: {},
        readMicroverseStateFn: () => ({ status: 'iterating', allowed_paths: allowedPaths }),
        readStateForWorkingDirFn: () => ({ workingDir, backend: 'claude' }),
        loadSettingsFn: () => ({ szechuan_max_remediation_cycles: 1, anatomy_park_max_remediation_cycles: 1, remediator_timeout_s: 60 }),
        mkdirSyncFn: (p) => fs.mkdirSync(p, { recursive: true }),
        writeFileFn: (p, data) => fs.writeFileSync(p, data, 'utf-8'),
        logActivityFn: () => {},
        isoFn: () => '2026-01-01T00-00-00Z',
        runGateFn: async () => makeGateResult('red', [makeFailure(path.join(repoRoot, failureFile))]),
        spawnGateRemediatorMainFn: async (briefOpts) => {
            remediatedFailures = briefOpts.gateResult?.failures ?? 'brief-prepared';
            briefOpts.stdout?.('BRIEF_PATH=/tmp/brief.md');
            return 0;
        },
        spawnRemediatorFn: () => { /* gate never clears */ },
        stdout: m => lines.push(m),
        stderr: m => lines.push(m),
    });

    fs.rmSync(sessionRoot, { recursive: true, force: true });
    return {
        code,
        declaredAllOutOfScope: lines.some(l => l.includes('all failures are out-of-scope')),
        remediatedFailures,
    };
}

describe('AP-EXT-ITER272-01 scope split path space', () => {
    test('AP-EXT-ITER272-01: a fenced failure is IN scope when working_dir sits BELOW the git root', async () => {
        const repoRoot = initScopeRepo();
        const result = await runScopeSplit({
            repoRoot,
            workingDir: path.join(repoRoot, 'pkg'),
            failureFile: 'pkg/mod.ts',
            allowedPaths: ['pkg/mod.ts'],
        });

        // Pre-fix this relativized against `pkg/`, yielding `mod.ts`, which matches nothing
        // in a repo-root-relative fence: exit 0 over a RED gate.
        assert.equal(
            result.declaredAllOutOfScope, false,
            'a failure the fence explicitly allows must not be declared out-of-scope from a nested launch dir'
        );
        assert.notEqual(result.code, 0, 'a red gate whose failure is in-scope must not exit 0');
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('AP-EXT-ITER272-01 control: an UNFENCED failure stays out of scope from a nested launch dir', async () => {
        const repoRoot = initScopeRepo();
        const result = await runScopeSplit({
            repoRoot,
            workingDir: path.join(repoRoot, 'pkg'),
            failureFile: 'other.ts',
            allowedPaths: ['pkg/mod.ts'],
        });

        // The fix must not pass by forcing everything in-scope — the fence still narrows.
        assert.equal(result.declaredAllOutOfScope, true, 'an out-of-fence failure must still be out-of-scope');
        assert.equal(result.code, 0);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('AP-EXT-ITER272-01 control: the flat-root case is unchanged — fenced failure still in scope', async () => {
        const repoRoot = initScopeRepo();
        const result = await runScopeSplit({
            repoRoot,
            workingDir: repoRoot,
            failureFile: 'pkg/mod.ts',
            allowedPaths: ['pkg/mod.ts'],
        });

        assert.equal(result.declaredAllOutOfScope, false);
        assert.notEqual(result.code, 0);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});

// ---------------------------------------------------------------------------
// B-FINALGATE: an incomplete anatomy-park exit is judged against the session baseline
// ---------------------------------------------------------------------------

describe('B-FINALGATE: finalize-gate judges anatomy-park against the session baseline', () => {
    const OLD = makeFailure('/tmp/wd/src/old.ts');
    const NEW = makeFailure('/tmp/wd/src/new.ts');
    const TESTS_TIMEOUT = { check: 'tests', file: '<timeout>', line: 0, ruleOrCode: 'GATE_CHECK_TIMEOUT', message: 'tests timed out after 300000ms', severity: 'error', occurrence_index: 0 };

    function writeBaseline(sessionRoot, failures, raw) {
        const gateDir = path.join(sessionRoot, 'gate');
        fs.mkdirSync(gateDir, { recursive: true });
        const baselinePath = path.join(gateDir, 'baseline.json');
        fs.writeFileSync(baselinePath, raw ?? JSON.stringify({
            schema_version: 1,
            captured_at: '2026-09-26T01:02:03.000Z',
            working_dir: '/tmp/wd',
            project_type: null,
            checks: ['typecheck', 'lint', 'tests'],
            failures,
        }));
        return baselinePath;
    }

    // Emulates runGate's subtraction: baseline mode drops every row the baseline already holds.
    function subtractingGate(seen, { baselineRows, allRows, checkStatus }) {
        return async (opts) => {
            seen.push({ mode: opts.mode, baselinePath: opts.baselinePath });
            const rows = opts.mode === 'baseline' ? allRows.filter(r => !baselineRows.includes(r)) : allRows;
            return { ...makeGateResult(rows.length ? 'red' : 'green', rows), check_status: checkStatus };
        };
    }

    async function runFinalize(sessionRoot, skill, runGateFn) {
        const run = { errs: [], seen: [], briefFailures: [], mvWrites: [], remediator: 0 };
        const briefPath = path.join(sessionRoot, 'brief.md');
        fs.writeFileSync(briefPath, 'fix the gate');
        run.code = await finalizeGateMain({
            argv: [sessionRoot, skill],
            env: {},
            ...baseDeps(sessionRoot, run.mvWrites),
            mkdirSyncFn: (p) => fs.mkdirSync(p, { recursive: true }),
            stderr: m => run.errs.push(m),
            runGateFn,
            spawnGateRemediatorMainFn: async (briefOpts) => {
                const resultPath = briefOpts.argv[briefOpts.argv.indexOf('--gate-result') + 1];
                run.briefFailures.push(JSON.parse(fs.readFileSync(resultPath, 'utf-8')).failures.map(f => f.file));
                briefOpts.stdout?.(`BRIEF_PATH=${briefPath}`);
                return 0;
            },
            spawnRemediatorFn: () => { run.remediator += 1; },
        });
        return run;
    }

    test('AC-1: anatomy-park with baseline F that sees exactly F passes in baseline mode', async () => {
        const sessionRoot = makeTmpDir();
        const baselinePath = writeBaseline(sessionRoot, [OLD]);
        const seen = [];
        const run = await runFinalize(sessionRoot, 'anatomy-park', subtractingGate(seen, { baselineRows: [OLD], allRows: [OLD] }));
        assert.equal(run.code, 0, 'pre-existing debt alone must not fail the phase');
        assert.deepEqual(seen, [{ mode: 'baseline', baselinePath }]);
        assert.equal(run.remediator, 0);
        assert.ok(run.errs.some(l => l === '[finalize-gate] baseline mode (captured 2026-09-26T01:02:03.000Z)'), run.errs.join('\n'));
        fs.rmSync(sessionRoot, { recursive: true, force: true });
    });

    test('AC-1 control: the same debt with NO baseline is judged strict and fails', async () => {
        const sessionRoot = makeTmpDir();
        const seen = [];
        const run = await runFinalize(sessionRoot, 'anatomy-park', subtractingGate(seen, { baselineRows: [OLD], allRows: [OLD] }));
        assert.equal(run.code, 2);
        assert.ok(seen.every(s => s.mode === 'strict' && s.baselinePath === undefined), 'strict mode never forwards a baseline path');
        assert.equal(fs.existsSync(path.join(sessionRoot, 'gate', 'baseline.json')), false, 'strict mode never captures a baseline');
        fs.rmSync(sessionRoot, { recursive: true, force: true });
    });

    test('AC-2: F plus one NEW failure still fails, and the brief names only the new row', async () => {
        const sessionRoot = makeTmpDir();
        writeBaseline(sessionRoot, [OLD]);
        const seen = [];
        const run = await runFinalize(sessionRoot, 'anatomy-park', subtractingGate(seen, { baselineRows: [OLD], allRows: [OLD, NEW] }));
        assert.equal(run.code, 2, 'a new failure exhausts the cap');
        assert.deepEqual(run.briefFailures, [[NEW.file], [NEW.file]]);
        fs.rmSync(sessionRoot, { recursive: true, force: true });
    });

    for (const [label, raw] of [['absent', null], ['unparseable', '{']]) {
        test(`AC-3: an ${label} baseline falls back to strict and says so`, async () => {
            const sessionRoot = makeTmpDir();
            fs.mkdirSync(path.join(sessionRoot, 'gate'), { recursive: true });
            if (raw !== null) writeBaseline(sessionRoot, [], raw);
            const seen = [];
            const run = await runFinalize(sessionRoot, 'anatomy-park', subtractingGate(seen, { baselineRows: [], allRows: [] }));
            assert.equal(run.code, 0);
            assert.deepEqual(seen.map(s => s.mode), ['strict']);
            assert.ok(run.errs.some(l => l.startsWith('[finalize-gate] strict (no usable baseline at ')), run.errs.join('\n'));
            if (raw !== null) assert.equal(fs.readFileSync(path.join(sessionRoot, 'gate', 'baseline.json'), 'utf-8'), raw, 'the baseline is never rewritten');
            fs.rmSync(sessionRoot, { recursive: true, force: true });
        });
    }

    test('AC-4: szechuan stays strict even when anatomy left a baseline holding F', async () => {
        const sessionRoot = makeTmpDir();
        writeBaseline(sessionRoot, [OLD]);
        const seen = [];
        const run = await runFinalize(sessionRoot, 'szechuan', subtractingGate(seen, { baselineRows: [OLD], allRows: [OLD] }));
        assert.equal(run.code, 2, 'szechuan is judged strict over the same debt');
        assert.ok(seen.every(s => s.mode === 'strict' && s.baselinePath === undefined));
        assert.ok(run.errs.some(l => l === '[finalize-gate] strict (skill szechuan is not baseline-scoped)'), run.errs.join('\n'));
        fs.rmSync(sessionRoot, { recursive: true, force: true });
    });

    test('AC-5: an incomplete exit whose only red is a tests timeout is disclosed, exit 0', async () => {
        const sessionRoot = makeTmpDir();
        fs.mkdirSync(path.join(sessionRoot, 'gate'), { recursive: true });
        const seen = [];
        const run = await runFinalize(sessionRoot, 'anatomy-park', subtractingGate(seen, {
            baselineRows: [], allRows: [TESTS_TIMEOUT], checkStatus: { typecheck: 'ran', lint: 'ran', tests: 'failed' },
        }));
        assert.equal(run.code, 0, 'unmeasured never exits 2');
        assert.equal(run.remediator, 0);
        assert.equal(run.mvWrites.length, 1);
        assert.ok(run.mvWrites[0].state.cap_unmeasured_checks.includes('tests'));
        assert.equal(run.mvWrites[0].dir, sessionRoot);
        fs.rmSync(sessionRoot, { recursive: true, force: true });
    });

    test('AC-8: a baseline-subtracted tests timeout reads unmeasured, not a silent green', async () => {
        const sessionRoot = makeTmpDir();
        writeBaseline(sessionRoot, [TESTS_TIMEOUT]);
        const seen = [];
        // Baseline mode subtracts the timeout row, so `status` alone is green; check_status is not.
        const run = await runFinalize(sessionRoot, 'anatomy-park', subtractingGate(seen, {
            baselineRows: [TESTS_TIMEOUT], allRows: [TESTS_TIMEOUT], checkStatus: { typecheck: 'ran', lint: 'ran', tests: 'failed' },
        }));
        assert.equal(run.code, 0);
        assert.deepEqual(seen.map(s => s.mode), ['baseline']);
        assert.deepEqual(run.mvWrites.map(w => w.state.cap_unmeasured_checks), [['tests']]);
        fs.rmSync(sessionRoot, { recursive: true, force: true });
    });
});

// ---------------------------------------------------------------------------
// B-FINALGATE #50: a failure row that names no editable file is never remediated or subtracted
// ---------------------------------------------------------------------------

describe('B-FINALGATE #50: finalize-gate never remediates or subtracts a row that cannot be attributed', () => {
    const TIMEOUT_LINT = { check: 'lint', file: '<timeout>', line: 0, ruleOrCode: 'GATE_CHECK_TIMEOUT', message: 'lint timed out after 300000ms', severity: 'error', occurrence_index: 0 };
    const LINT_TIMED_OUT = { typecheck: 'ran', lint: 'failed', tests: 'ran' };
    const ALL_RAN = { typecheck: 'ran', lint: 'ran', tests: 'ran' };

    // NESTED package dir: `<root>/packages/app`, so the fallback row's `file` (the package dir) is an
    // ANCESTOR of every allowed path — the shape `matchesAllowedPath`'s ancestor arm exists for.
    function makePackage() {
        const root = makeTmpDir();
        const pkgDir = path.join(root, 'packages', 'app');
        const siblingDir = path.join(root, 'packages', 'other');
        const broken = path.join(pkgDir, 'src', 'broken.ts');
        const sibling = path.join(siblingDir, 'src', 'sibling.ts');
        for (const f of [broken, sibling]) {
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, 'export const x = 1;\n');
        }
        fs.mkdirSync(path.join(root, 'gate'), { recursive: true });
        return { root, pkgDir, broken, sibling, allowed: ['packages/app/src/broken.ts', 'packages/other/src/sibling.ts'] };
    }

    function writeBaselineFile(root, failures) {
        fs.writeFileSync(path.join(root, 'gate', 'baseline.json'), JSON.stringify({
            schema_version: 1,
            captured_at: '2026-09-26T01:02:03.000Z',
            working_dir: root,
            project_type: null,
            checks: ['typecheck', 'lint', 'tests'],
            failures: assignOccurrenceIndices(failures),
        }));
    }

    // The gate double runs the REAL `subtractBaseline` in baseline mode, honouring the same opts the
    // real `runGate` reads, so the wiring finalize-gate → helper → subtraction is what is under test.
    function gateOver({ raw, baseline, checkStatus = ALL_RAN, seen }) {
        return async (opts) => {
            seen?.push({ mode: opts.mode, keepFallbackRows: opts.keepFallbackRows });
            const indexed = assignOccurrenceIndices(raw);
            const rows = opts.mode === 'baseline'
                ? subtractBaseline(indexed, { failures: assignOccurrenceIndices(baseline) }, undefined, opts.keepFallbackRows)
                : indexed;
            return { ...makeGateResult(rows.length ? 'red' : 'green', rows), check_status: checkStatus };
        };
    }

    async function runNested(pkg, { skill = 'anatomy-park', runGateFn, statFn }) {
        const run = { errs: [], briefFailures: [], mvWrites: [], remediator: 0, briefPrep: 0 };
        const briefPath = path.join(pkg.root, 'brief.md');
        fs.writeFileSync(briefPath, 'fix the gate');
        run.code = await finalizeGateMain({
            argv: [pkg.root, skill],
            env: {},
            ...baseDeps(pkg.root, run.mvWrites),
            readMicroverseStateFn: () => ({ status: 'iterating', allowed_paths: pkg.allowed }),
            readStateForWorkingDirFn: () => ({ workingDir: pkg.root, backend: 'claude' }),
            mkdirSyncFn: (p) => fs.mkdirSync(p, { recursive: true }),
            stderr: m => run.errs.push(m),
            statFn,
            runGateFn,
            spawnGateRemediatorMainFn: async (briefOpts) => {
                run.briefPrep += 1;
                const resultPath = briefOpts.argv[briefOpts.argv.indexOf('--gate-result') + 1];
                run.briefFailures.push(JSON.parse(fs.readFileSync(resultPath, 'utf-8')).failures.map(f => f.file));
                briefOpts.stdout?.(`BRIEF_PATH=${briefPath}`);
                return 0;
            },
            spawnRemediatorFn: () => { run.remediator += 1; },
        });
        return run;
    }

    const coarse = (pkgDir, check = 'tests', exitCode = 1) => buildFailures({ stdout: '', stderr: '', exitCode }, check, pkgDir);
    const named = (pkgDir, name) => buildFailures({ stdout: `not ok 1 - ${name}\n`, stderr: '', exitCode: 1 }, 'tests', pkgDir);

    test('namesEditableFile: relative and existing regular files are editable; directories, pseudo-files and stat errors are not', () => {
        const pkg = makePackage();
        const row = (file) => ({ check: 'lint', file, line: 1, ruleOrCode: 'r', message: 'm', severity: 'error', occurrence_index: 0 });
        const stat = fs.statSync;
        assert.equal(namesEditableFile(row('src/a.ts'), stat), true, 'relative');
        assert.equal(namesEditableFile(row(pkg.broken), stat), true, 'absolute regular file');
        assert.equal(namesEditableFile(row(pkg.pkgDir), stat), false, 'absolute directory');
        assert.equal(namesEditableFile(row(path.join(pkg.pkgDir, 'missing.ts')), stat), false, 'absolute missing file');
        assert.equal(namesEditableFile(row('<timeout>'), stat), false, 'pseudo-file');
        assert.equal(namesEditableFile(row(pkg.broken), () => { throw new Error('EACCES'); }), false, 'stat error');
        fs.rmSync(pkg.root, { recursive: true, force: true });
    });

    test('AC-F4: a check that timed out whose only other row names just a package dir spawns nothing and is disclosed unmeasured', async () => {
        const pkg = makePackage();
        const rows = [TIMEOUT_LINT, ...coarse(pkg.pkgDir, 'lint')];
        const run = await runNested(pkg, { skill: 'szechuan', runGateFn: gateOver({ raw: rows, baseline: [], checkStatus: LINT_TIMED_OUT }) });
        assert.equal(run.remediator, 0, 'no remediator for a row no edit can fix');
        assert.equal(run.briefPrep, 0);
        assert.equal(run.code, 0, 'unmeasured is disclosed, never a failed phase');
        assert.deepEqual(run.mvWrites.map(w => w.state.cap_unmeasured_checks), [['lint']]);
        fs.rmSync(pkg.root, { recursive: true, force: true });
    });

    test('AC-F3: a check that timed out in one dir plus a NEW editable row in another is remediated on that row', async () => {
        const pkg = makePackage();
        const fresh = { check: 'lint', file: pkg.sibling, line: 3, ruleOrCode: 'no-any', message: 'no any', severity: 'error', occurrence_index: 0 };
        const rows = [TIMEOUT_LINT, ...coarse(pkg.pkgDir, 'lint'), fresh];
        const run = await runNested(pkg, { skill: 'szechuan', runGateFn: gateOver({ raw: rows, baseline: [], checkStatus: LINT_TIMED_OUT }) });
        assert.equal(run.code, 2, 'the editable row is never fixed by the fake remediator, so the cap is exhausted');
        assert.equal(run.remediator, 2);
        assert.deepEqual(run.briefFailures, [[pkg.sibling], [pkg.sibling]], 'the brief names the editable row only');
        assert.deepEqual(run.mvWrites, [], 'nothing was disclosed as unmeasured while a real failure stands');
        fs.rmSync(pkg.root, { recursive: true, force: true });
    });

    test('AC-F1: a coarse (fallback) row present in the baseline AND now is not subtracted — the check is unmeasured, not green', async () => {
        const pkg = makePackage();
        writeBaselineFile(pkg.root, coarse(pkg.pkgDir));
        const seen = [];
        const run = await runNested(pkg, { runGateFn: gateOver({ raw: coarse(pkg.pkgDir), baseline: coarse(pkg.pkgDir), seen }) });
        assert.deepEqual(seen.map(s => s.mode), ['baseline']);
        assert.ok(seen.every(s => s.keepFallbackRows === true), 'finalize-gate asks for fallback rows to be kept');
        assert.equal(run.remediator, 0);
        assert.equal(run.code, 0);
        assert.deepEqual(run.mvWrites.map(w => w.state.cap_unmeasured_checks), [['tests']], 'a silent green would leave this empty');
        fs.rmSync(pkg.root, { recursive: true, force: true });
    });

    test('AC-F2: baseline test A plus a NEW test B fails, and the brief names B only', async () => {
        const pkg = makePackage();
        const A = named(pkg.pkgDir, 'alpha breaks');
        const B = named(pkg.pkgDir, 'beta breaks');
        writeBaselineFile(pkg.root, A);
        const run = await runNested(pkg, { runGateFn: gateOver({ raw: [...A, ...B], baseline: A }) });
        assert.equal(run.code, 2, 'a new failing test is remediated, never disclosed away');
        assert.equal(run.remediator, 2);
        assert.equal(run.briefFailures.length, 2);
        const briefed = run.briefFailures[0];
        assert.deepEqual(briefed, [pkg.pkgDir], 'exactly one row reaches the brief');
        fs.rmSync(pkg.root, { recursive: true, force: true });
    });

    test('AC-F2 control: the row that reaches the brief is B, not A', async () => {
        const pkg = makePackage();
        const A = named(pkg.pkgDir, 'alpha breaks');
        const B = named(pkg.pkgDir, 'beta breaks');
        writeBaselineFile(pkg.root, A);
        const rows = [];
        const run = await runNested(pkg, {
            runGateFn: gateOver({ raw: [...A, ...B], baseline: A }),
            statFn: fs.statSync,
        });
        // Re-read what the brief was handed: the gate-result JSON lists the rows by ruleOrCode.
        const gateResults = fs.readdirSync(path.join(pkg.root, 'gate')).filter(f => f.startsWith('gate_result_cycle_'));
        for (const f of gateResults) rows.push(...JSON.parse(fs.readFileSync(path.join(pkg.root, 'gate', f), 'utf-8')).failures.map(r => r.ruleOrCode));
        assert.ok(rows.length > 0 && rows.every(r => r === 'beta breaks'), `only B is briefed, got ${JSON.stringify(rows)}`);
        assert.equal(run.code, 2);
        fs.rmSync(pkg.root, { recursive: true, force: true });
    });

    test('a stat error on an absolute row makes it non-editable: the seam is honoured', async () => {
        const pkg = makePackage();
        const row = { check: 'lint', file: pkg.broken, line: 1, ruleOrCode: '1', message: 'lint failed with exit code 1', severity: 'error', occurrence_index: 0 };
        const run = await runNested(pkg, {
            skill: 'szechuan',
            runGateFn: gateOver({ raw: [row], baseline: [] }),
            statFn: () => { throw new Error('EACCES'); },
        });
        assert.equal(run.remediator, 0, 'an unreadable file is not an editable one');
        assert.equal(run.code, 0);
        fs.rmSync(pkg.root, { recursive: true, force: true });
    });
});

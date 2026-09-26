// @tier: integration
/**
 * Integration test: anatomy-park scoped final gate
 * OOS-only failures → OOS file written, remediator never called, exit 0.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { finalizeGateMain } from '../../bin/finalize-gate.js';

function makeTmpDir() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fg-ap-')));
}

function makeRedResult(failures) {
    return { status: 'red', failures, baseline_used: false, allowed_paths_used: false, elapsed_ms: 5, total_raw_failure_count: failures.length, new_failures_vs_baseline: 0 };
}

function readOutOfScopeReport(gateDir) {
    const gateFiles = fs.readdirSync(gateDir);
    const outOfScopeFiles = gateFiles.filter(f => f.startsWith('out_of_scope_failures_'));
    assert.equal(outOfScopeFiles.length, 1, `Expected exactly one OOS file, got: ${gateFiles.join(', ')}`);
    const reportPath = path.join(gateDir, outOfScopeFiles[0]);
    return fs.readFileSync(reportPath, 'utf-8').trimEnd().split('\n');
}

describe('anatomy-park scoped final gate', () => {
    test('all failures in web-app (out of scope) → OOS file written, no remediator, exit 0', async () => {
        const sessionRoot = makeTmpDir();
        const workingDir = makeTmpDir();
        const gateDir = path.join(sessionRoot, 'gate');
        fs.mkdirSync(gateDir, { recursive: true });

        // Failure is in packages/web-app — out of scope when scope=packages/api
        const oosFailure = {
            check: 'lint',
            file: path.join(workingDir, 'packages/web-app/src/foo.ts'),
            line: 10,
            ruleOrCode: 'no-any',
            message: 'no any types',
            severity: 'error',
            occurrence_index: 0,
        };

        let gateCalls = 0;
        let remediatorCalled = false;
        const events = [];

        const code = await finalizeGateMain({
            argv: [sessionRoot, 'anatomy-park'],
            env: {},
            readMicroverseStateFn: () => ({
                status: 'iterating',
                allowed_paths: ['packages/api/**'],
            }),
            readStateForWorkingDirFn: () => ({ workingDir, backend: 'claude' }),
            loadSettingsFn: () => ({ szechuan_max_remediation_cycles: 3, anatomy_park_max_remediation_cycles: 5, remediator_timeout_s: 60 }),
            mkdirSyncFn: (p) => fs.mkdirSync(p, { recursive: true }),
            writeFileFn: (p, data) => fs.writeFileSync(p, data, 'utf-8'),
            logActivityFn: e => events.push(e),
            isoFn: () => '2026-01-01T00-00-00Z',
            runGateFn: async () => { gateCalls++; return makeRedResult([oosFailure]); },
            spawnGateRemediatorMainFn: async () => { remediatorCalled = true; return 0; },
            spawnRemediatorFn: () => { remediatorCalled = true; },
            stdout: () => {},
            stderr: () => {},
        });

        assert.equal(code, 0, 'should exit 0 when all failures are out-of-scope');
        assert.equal(gateCalls, 1, 'gate should run once');
        assert.equal(remediatorCalled, false, 'remediator must NOT be called when all failures are OOS');

        // OOS file should be written
        const reportLines = readOutOfScopeReport(gateDir);
        assert.equal(reportLines[0], '# Out-of-Scope Gate Failures');
        assert.equal(reportLines[2], 'Cycle: 1');
        assert.equal(reportLines[3], 'Skill: anatomy-park');
        assert.equal(
            reportLines[6],
            `- \`${oosFailure.file}\` [lint] no-any: no any types`,
            'OOS file should serialize the exact failure row'
        );

        const outOfScopeEvent = events.find(e => e.event === 'gate_out_of_scope_failures_present');
        assert.deepEqual(outOfScopeEvent, {
            event: 'gate_out_of_scope_failures_present',
            source: 'pickle',
            gate_payload: { count: 1, cycle: 1 },
        });

        fs.rmSync(sessionRoot, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
    });

    test('mixed: in-scope + OOS failures → OOS file written, remediator called for in-scope', async () => {
        const sessionRoot = makeTmpDir();
        const workingDir = makeTmpDir();
        const gateDir = path.join(sessionRoot, 'gate');
        fs.mkdirSync(gateDir, { recursive: true });

        const inScopeFailure = {
            check: 'lint',
            file: path.join(workingDir, 'packages/api/src/route.ts'),
            line: 5, ruleOrCode: 'no-any', message: 'no any', severity: 'error', occurrence_index: 0,
        };
        const oosFailure = {
            check: 'lint',
            file: path.join(workingDir, 'packages/web-app/src/foo.ts'),
            line: 10, ruleOrCode: 'no-any', message: 'no any', severity: 'error', occurrence_index: 0,
        };

        let gateCalls = 0;
        let remediatorCalled = false;

        const code = await finalizeGateMain({
            argv: [sessionRoot, 'anatomy-park'],
            env: {},
            readMicroverseStateFn: () => ({
                status: 'iterating',
                allowed_paths: ['packages/api/**'],
            }),
            readStateForWorkingDirFn: () => ({ workingDir, backend: 'claude' }),
            loadSettingsFn: () => ({ szechuan_max_remediation_cycles: 3, anatomy_park_max_remediation_cycles: 2, remediator_timeout_s: 60 }),
            mkdirSyncFn: (p) => fs.mkdirSync(p, { recursive: true }),
            writeFileFn: (p, data) => fs.writeFileSync(p, data, 'utf-8'),
            logActivityFn: () => {},
            isoFn: () => `2026-01-01T${String(gateCalls).padStart(2, '0')}-00-00Z`,
            // Gate: red with both failures on first call, green on second
            runGateFn: async () => {
                const call = gateCalls++;
                if (call === 0) return makeRedResult([inScopeFailure, oosFailure]);
                return { status: 'green', failures: [], baseline_used: false, allowed_paths_used: false, elapsed_ms: 5, total_raw_failure_count: 0, new_failures_vs_baseline: 0 };
            },
            spawnGateRemediatorMainFn: async (briefOpts) => {
                remediatorCalled = true;
                const briefPath = path.join(gateDir, 'brief.md');
                fs.writeFileSync(briefPath, '# Brief', 'utf-8');
                briefOpts.stdout?.(`BRIEF_PATH=${briefPath}`);
                return 0;
            },
            spawnRemediatorFn: () => {},
            stdout: () => {},
            stderr: () => {},
        });

        assert.equal(code, 0, 'should exit 0 after in-scope failure cleared');
        assert.equal(remediatorCalled, true, 'remediator should run for in-scope failure');

        const reportLines = readOutOfScopeReport(gateDir);
        assert.equal(
            reportLines[6],
            `- \`${oosFailure.file}\` [lint] no-any: no any`,
            'OOS report should include the out-of-scope failure only'
        );

        fs.rmSync(sessionRoot, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
    });

    test('package-level test failure stays in scope when allowed_paths names an exact file under that package, and is disclosed unmeasured', async () => {
        const sessionRoot = makeTmpDir();
        const workingDir = makeTmpDir();
        const gateDir = path.join(sessionRoot, 'gate');
        fs.mkdirSync(gateDir, { recursive: true });

        const inScopeTestFailure = {
            check: 'tests',
            file: path.join(workingDir, 'packages/api'),
            line: 0,
            ruleOrCode: '1',
            message: 'tests failed',
            severity: 'error',
            occurrence_index: 0,
        };

        let gateCalls = 0;
        let remediatorCalled = false;
        const writtenStates = [];

        const code = await finalizeGateMain({
            argv: [sessionRoot, 'anatomy-park'],
            env: {},
            readMicroverseStateFn: () => ({
                status: 'iterating',
                allowed_paths: ['packages/api/src/route.ts'],
            }),
            readStateForWorkingDirFn: () => ({ workingDir, backend: 'claude' }),
            loadSettingsFn: () => ({ szechuan_max_remediation_cycles: 3, anatomy_park_max_remediation_cycles: 2, remediator_timeout_s: 60 }),
            mkdirSyncFn: (p) => fs.mkdirSync(p, { recursive: true }),
            writeFileFn: (p, data) => fs.writeFileSync(p, data, 'utf-8'),
            logActivityFn: () => {},
            isoFn: () => `2026-01-01T${String(gateCalls).padStart(2, '0')}-30-00Z`,
            runGateFn: async () => { gateCalls++; return makeRedResult([inScopeTestFailure]); },
            writeMicroverseStateFn: (_root, state) => { writtenStates.push(state); },
            spawnGateRemediatorMainFn: async () => { remediatorCalled = true; return 0; },
            spawnRemediatorFn: () => {},
            stdout: () => {},
            stderr: () => {},
        });

        // #50: the row names no editable file and no rule or test identity, so it is unmeasured —
        // disclosed and exit 0, never a remediation cycle — and it stays IN scope (no OOS report).
        assert.equal(code, 0, 'an unmeasured in-scope row is disclosed, never a failed phase');
        assert.equal(gateCalls, 1, 'no remediation cycle is spent, so the gate runs once');
        assert.equal(remediatorCalled, false, 'an unattributable row must never reach brief-prep');
        const gateFiles = fs.readdirSync(gateDir);
        assert.equal(gateFiles.filter(f => f.startsWith('out_of_scope_failures_')).length, 0, 'the row must not be written as out-of-scope');
        const unmeasured = gateFiles.filter(f => f.startsWith('unmeasured_'));
        assert.equal(unmeasured.length, 1, `expected one unmeasured report, got: ${gateFiles.join(', ')}`);
        assert.ok(fs.readFileSync(path.join(gateDir, unmeasured[0]), 'utf-8').includes(inScopeTestFailure.file), 'the report names the disclosed row');
        assert.deepEqual(writtenStates.map(s => s.cap_unmeasured_checks), [['tests']], 'the unmeasured check rides cap_unmeasured_checks');

        fs.rmSync(sessionRoot, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
    });

    test('synthetic gate timeout failure stays in scope when allowed_paths are present, and is disclosed unmeasured', async () => {
        const sessionRoot = makeTmpDir();
        const workingDir = makeTmpDir();
        const gateDir = path.join(sessionRoot, 'gate');
        fs.mkdirSync(gateDir, { recursive: true });

        const syntheticFailure = {
            check: 'tests',
            file: '<timeout>',
            line: 0,
            ruleOrCode: 'GATE_CHECK_TIMEOUT',
            message: 'tests timed out after 1000ms',
            severity: 'error',
            occurrence_index: 0,
        };

        let gateCalls = 0;
        let remediatorCalled = false;
        const writtenStates = [];

        const code = await finalizeGateMain({
            argv: [sessionRoot, 'anatomy-park'],
            env: {},
            readMicroverseStateFn: () => ({
                status: 'iterating',
                allowed_paths: ['packages/api/**'],
            }),
            readStateForWorkingDirFn: () => ({ workingDir, backend: 'claude' }),
            loadSettingsFn: () => ({ szechuan_max_remediation_cycles: 3, anatomy_park_max_remediation_cycles: 2, remediator_timeout_s: 60 }),
            mkdirSyncFn: (p) => fs.mkdirSync(p, { recursive: true }),
            writeFileFn: (p, data) => fs.writeFileSync(p, data, 'utf-8'),
            logActivityFn: () => {},
            isoFn: () => `2026-01-01T${String(gateCalls).padStart(2, '0')}-45-00Z`,
            runGateFn: async () => { gateCalls++; return makeRedResult([syntheticFailure]); },
            writeMicroverseStateFn: (_root, state) => { writtenStates.push(state); },
            spawnGateRemediatorMainFn: async () => { remediatorCalled = true; return 0; },
            spawnRemediatorFn: () => {},
            stdout: () => {},
            stderr: () => {},
        });

        // #50: the row names no editable file and no rule or test identity, so it is unmeasured —
        // disclosed and exit 0, never a remediation cycle — and it stays IN scope (no OOS report).
        assert.equal(code, 0, 'an unmeasured in-scope row is disclosed, never a failed phase');
        assert.equal(gateCalls, 1, 'no remediation cycle is spent, so the gate runs once');
        assert.equal(remediatorCalled, false, 'an unattributable row must never reach brief-prep');
        const gateFiles = fs.readdirSync(gateDir);
        assert.equal(gateFiles.filter(f => f.startsWith('out_of_scope_failures_')).length, 0, 'the row must not be written as out-of-scope');
        const unmeasured = gateFiles.filter(f => f.startsWith('unmeasured_'));
        assert.equal(unmeasured.length, 1, `expected one unmeasured report, got: ${gateFiles.join(', ')}`);
        assert.ok(fs.readFileSync(path.join(gateDir, unmeasured[0]), 'utf-8').includes(syntheticFailure.file), 'the report names the disclosed row');
        assert.deepEqual(writtenStates.map(s => s.cap_unmeasured_checks), [['tests']], 'the unmeasured check rides cap_unmeasured_checks');

        fs.rmSync(sessionRoot, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
    });

    test('no allowed_paths → all failures treated as in-scope', async () => {
        const sessionRoot = makeTmpDir();
        const workingDir = makeTmpDir();
        const gateDir = path.join(sessionRoot, 'gate');
        fs.mkdirSync(gateDir, { recursive: true });

        const failure = {
            check: 'lint',
            file: path.join(workingDir, 'src/foo.ts'),
            line: 1, ruleOrCode: 'no-any', message: 'no any', severity: 'error', occurrence_index: 0,
        };

        let remediatorCalled = false;

        const code = await finalizeGateMain({
            argv: [sessionRoot, 'anatomy-park'],
            env: {},
            readMicroverseStateFn: () => ({ status: 'iterating', allowed_paths: undefined }),
            readStateForWorkingDirFn: () => ({ workingDir, backend: 'claude' }),
            loadSettingsFn: () => ({ szechuan_max_remediation_cycles: 3, anatomy_park_max_remediation_cycles: 1, remediator_timeout_s: 60 }),
            mkdirSyncFn: (p) => fs.mkdirSync(p, { recursive: true }),
            writeFileFn: (p, data) => fs.writeFileSync(p, data, 'utf-8'),
            logActivityFn: () => {},
            isoFn: () => '2026-01-01T00-00-00Z',
            runGateFn: async () => makeRedResult([failure]),
            spawnGateRemediatorMainFn: async (briefOpts) => {
                remediatorCalled = true;
                const briefPath = path.join(gateDir, 'brief.md');
                fs.writeFileSync(briefPath, '# Brief', 'utf-8');
                briefOpts.stdout?.(`BRIEF_PATH=${briefPath}`);
                return 0;
            },
            spawnRemediatorFn: () => {},
            stdout: () => {},
            stderr: () => {},
        });

        // No allowed_paths → failure is in-scope → remediator runs → cap=1 → exit 2
        assert.equal(code, 2);
        assert.equal(remediatorCalled, true);

        const gateFiles = fs.readdirSync(gateDir);
        assert.equal(gateFiles.filter(f => f.startsWith('out_of_scope_failures_')).length, 0, 'no OOS file when no scope set');

        fs.rmSync(sessionRoot, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
    });
});

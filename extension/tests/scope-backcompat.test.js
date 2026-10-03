// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setupAnatomyPark } from '../bin/pipeline-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// R-CIFB: repo root (not deployed ~/.claude/pickle-rick) so setupAnatomyPark
// spawns the repo's extension/bin/init-microverse.js — CI never runs install.sh.
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.resolve(__dirname, '..', 'bin', 'init-microverse.js');
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');

function makeTarget(prefix = 'backcompat-target-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeSession(prefix = 'backcompat-session-') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        active: false,
        working_dir: dir,
        step: 'review',
        iteration: 0,
        max_iterations: 10,
        max_time_minutes: 60,
        worker_timeout_seconds: 1200,
        start_time_epoch: Math.floor(Date.now() / 1000),
        completion_promise: null,
        original_prompt: 'test',
        current_ticket: null,
        history: [],
        started_at: new Date().toISOString(),
        session_dir: dir,
    }, null, 2));
    return dir;
}

function makeSubsystem(root, name, fileCount = 3) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < fileCount; i++) {
        fs.writeFileSync(path.join(dir, `f${i}.ts`), `export const x${i} = ${i};\n`);
    }
}

function cleanup(...dirs) {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

function readFixture(name) {
    return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8'));
}

function normalizeMicroverse(state) {
    const copy = { ...state };
    delete copy.prd_path;
    delete copy.gap_analysis_path;
    delete copy.judge_context_path;
    return copy;
}

// ---------------------------------------------------------------------------
// (a) Pipeline mode, no --scope → no scope.json written
// ---------------------------------------------------------------------------

test('backcompat (a): pipeline no --scope → no scope.json written', () => {
    const session = makeSession();
    try {
        const scopeFlag = undefined;

        if (scopeFlag) {
            throw new Error('unreachable — test setup error');
        }

        assert.ok(
            !fs.existsSync(path.join(session, 'scope.json')),
            'no scope.json when --scope is omitted from pipeline invocation',
        );

        const state = JSON.parse(fs.readFileSync(path.join(session, 'state.json'), 'utf-8'));
        assert.equal(
            state.phases_entered,
            undefined,
            'phases_entered not written when scope omitted',
        );
    } finally {
        cleanup(session);
    }
});

// ---------------------------------------------------------------------------
// (b) anatomy-park.json deep-equals committed baseline fixture
// ---------------------------------------------------------------------------

test('backcompat (b): anatomy-park.json deep-equals baseline fixture when no scope', () => {
    const session = makeSession();
    const target = makeTarget();
    try {
        makeSubsystem(target, 'alpha');
        makeSubsystem(target, 'beta');
        makeSubsystem(target, 'gamma');

        setupAnatomyPark(session, target, 3, EXTENSION_ROOT, () => {});

        const actual = JSON.parse(fs.readFileSync(path.join(session, 'anatomy-park.json'), 'utf-8'));
        const baseline = readFixture('backcompat-baseline-anatomy-park.json');

        // `lanes` is intentionally additive (B-LANES); readers ignore unknown fields.
        assert.deepStrictEqual(actual, baseline);
    } finally {
        cleanup(session, target);
    }
});

// ---------------------------------------------------------------------------
// (c) microverse.json has no allowed_paths when --allowed-paths-file omitted
// ---------------------------------------------------------------------------

test('backcompat (c): microverse.json has no allowed_paths when scope flag omitted', () => {
    const session = makeSession();
    try {
        execFileSync(process.execPath, [
            CLI_PATH,
            session, '/some/target',
            '--stall-limit', '5',
            '--convergence-target', '0',
            // 15s → 45s: budget for system load under concurrent test runs.
        ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 45_000 });

        const state = JSON.parse(fs.readFileSync(path.join(session, 'microverse.json'), 'utf-8'));

        assert.equal(state.allowed_paths, undefined, 'no allowed_paths field when --allowed-paths-file omitted');

        const normalized = normalizeMicroverse(state);
        const baseline = readFixture('backcompat-baseline-szechuan.json');
        assert.deepStrictEqual(normalized, baseline);
    } finally {
        cleanup(session);
    }
});

// ---------------------------------------------------------------------------
// (d) Standalone matches pipeline: both omit scope → identical subsystem output
// ---------------------------------------------------------------------------

test('backcompat (d): standalone and pipeline produce identical anatomy-park.json when both omit scope', () => {
    const session1 = makeSession('backcompat-pipeline-');
    const session2 = makeSession('backcompat-standalone-');
    const target = makeTarget();
    try {
        makeSubsystem(target, 'foo');
        makeSubsystem(target, 'bar');

        setupAnatomyPark(session1, target, 3, EXTENSION_ROOT, () => {});
        setupAnatomyPark(session2, target, 3, EXTENSION_ROOT, () => {});

        const ap1 = JSON.parse(fs.readFileSync(path.join(session1, 'anatomy-park.json'), 'utf-8'));
        const ap2 = JSON.parse(fs.readFileSync(path.join(session2, 'anatomy-park.json'), 'utf-8'));

        assert.deepStrictEqual(ap1, ap2, 'anatomy-park.json identical across pipeline invocations when scope omitted');
        assert.equal(ap1.subsystems.includes('foo'), true);
        assert.equal(ap1.subsystems.includes('bar'), true);

        const mv1 = JSON.parse(fs.readFileSync(path.join(session1, 'microverse.json'), 'utf-8'));
        const mv2 = JSON.parse(fs.readFileSync(path.join(session2, 'microverse.json'), 'utf-8'));
        assert.equal(mv1.allowed_paths, undefined);
        assert.equal(mv2.allowed_paths, undefined);
    } finally {
        cleanup(session1, session2, target);
    }
});

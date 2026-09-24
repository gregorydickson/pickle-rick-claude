// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { precleanPausedOrphansBeforeCreate } from '../bin/setup.js';
import { StateManager } from '../services/state-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeTmpRoot() {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'preclean-test-')));
    const sessionsRoot = path.join(dir, 'sessions');
    fs.mkdirSync(sessionsRoot, { recursive: true });
    return { dir, sessionsRoot };
}

function makeSession(sessionsRoot, sessionId, stateOverrides) {
    const sessionDir = path.join(sessionsRoot, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const statePath = path.join(sessionDir, 'state.json');
    const defaultState = {
        active: true,
        pid: null,
        working_dir: process.cwd(),
        schema_version: 3,
        step: 'prd',
        iteration: 0,
        max_iterations: 50,
        max_time_minutes: 60,
        worker_timeout_seconds: 1200,
        start_time_epoch: Math.floor(Date.now() / 1000) - 400,
        completion_promise: null,
        original_prompt: 'test',
        current_ticket: null,
        history: [],
        started_at: new Date(Date.now() - 400_000).toISOString(),
        session_dir: sessionDir,
        tmux_mode: false,
        min_iterations: 0,
        command_template: null,
        chain_meeseeks: false,
        backend: null,
        archaeology: null,
        tickets_version: 0,
        last_course_correction: null,
        phase_personas_active: false,
        flags: {},
        readiness: { cycle_history: [] },
        codex_version_seen: null,
        activity: [],
    };
    fs.writeFileSync(statePath, JSON.stringify({ ...defaultState, ...stateOverrides }));
    return statePath;
}

function backdate(statePath, ageMs = 400_000) {
    const pastTime = new Date(Date.now() - ageMs);
    fs.utimesSync(statePath, pastTime, pastTime);
}

function readState(statePath) {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
}

// AC-1: stale orphan with matching cwd is demoted with precleanup exit_reason and activity event
test('(AC-1) stale same-cwd paused-orphan is demoted with orphan-paused-no-claim-precleanup', () => {
    const { dir, sessionsRoot } = makeTmpRoot();
    try {
        const sessionId = 'preclean-ac1';
        const statePath = makeSession(sessionsRoot, sessionId, {
            active: true,
            pid: null,
            working_dir: process.cwd(),
        });
        backdate(statePath);

        precleanPausedOrphansBeforeCreate(sessionsRoot, new StateManager());

        const updated = readState(statePath);
        assert.strictEqual(updated.active, false, 'active should be false after precleanup');
        assert.strictEqual(updated.exit_reason, 'orphan-paused-no-claim-precleanup');
        const events = updated.activity ?? [];
        const precleaned = events.find(e => e?.event === 'paused_session_orphan_precleaned');
        assert.ok(precleaned, `Expected paused_session_orphan_precleaned event; got: ${JSON.stringify(events)}`);
        assert.ok(typeof precleaned.mtime_age_seconds === 'number' && precleaned.mtime_age_seconds > 0, 'mtime_age_seconds should be positive');
        assert.strictEqual(precleaned.step, 'preclean_before_create');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// AC-2: session with different working_dir is NOT demoted
test('(AC-2) different-cwd session is not touched', () => {
    const { dir, sessionsRoot } = makeTmpRoot();
    try {
        const statePath = makeSession(sessionsRoot, 'preclean-ac2', {
            active: true,
            pid: null,
            working_dir: '/some/completely/different/path',
        });
        backdate(statePath);

        precleanPausedOrphansBeforeCreate(sessionsRoot, new StateManager());

        const state = readState(statePath);
        assert.strictEqual(state.active, true, 'different-cwd session should remain active');
        assert.ok(!state.exit_reason, 'no exit_reason should be set');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// AC-3: fresh session (mtime <= 300s) is NOT demoted
test('(AC-3) fresh session under 300s is not demoted', () => {
    const { dir, sessionsRoot } = makeTmpRoot();
    try {
        const statePath = makeSession(sessionsRoot, 'preclean-ac3', {
            active: true,
            pid: null,
            working_dir: process.cwd(),
        });
        // Backdate by only 100s — under the 300s threshold
        backdate(statePath, 100_000);

        precleanPausedOrphansBeforeCreate(sessionsRoot, new StateManager());

        const state = readState(statePath);
        assert.strictEqual(state.active, true, 'fresh session should remain active');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// AC-4: session with a live pid is NOT demoted
test('(AC-4) session with non-null pid is not demoted', () => {
    const { dir, sessionsRoot } = makeTmpRoot();
    try {
        const statePath = makeSession(sessionsRoot, 'preclean-ac4', {
            active: true,
            pid: 12345,
            working_dir: process.cwd(),
        });
        backdate(statePath);

        precleanPausedOrphansBeforeCreate(sessionsRoot, new StateManager());

        const state = readState(statePath);
        assert.strictEqual(state.active, true, 'session with pid should remain active');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

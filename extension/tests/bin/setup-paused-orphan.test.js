// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanPausedOrphans } from '../../bin/setup.js';
import { StateManager } from '../../services/state-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeTmpRoot() {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-scan-test-')));
    const sessionsRoot = path.join(dir, 'sessions');
    fs.mkdirSync(sessionsRoot, { recursive: true });
    return { dir, sessionsRoot };
}

// R-POD demotion needs a session map at dataRoot/current_sessions.json pointing
// the cwd at a dead PID. Tests that exercise the demote path (--paused mode)
// must write this; the warn-only path (no --paused) still fires on age-staleness
// alone via scanPausedOrphans' separate warning predicate.
function writeDeadSessionMap(dataRoot, sessionDir) {
    const mapPath = path.join(dataRoot, 'current_sessions.json');
    fs.writeFileSync(
        mapPath,
        JSON.stringify({ [process.cwd()]: { sessionPath: sessionDir, pid: 999999 } }),
    );
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
    };
    fs.writeFileSync(statePath, JSON.stringify({ ...defaultState, ...stateOverrides }));
    return statePath;
}

function backdate(statePath, ageMs = 400_000) {
    const pastTime = new Date(Date.now() - ageMs);
    fs.utimesSync(statePath, pastTime, pastTime);
}

function writeRecoverableTmp(statePath, stateOverrides, ageMs = 350_000) {
    const tmpPath = `${statePath}.tmp.999999.snapshot`;
    const baseState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    fs.writeFileSync(tmpPath, JSON.stringify({ ...baseState, ...stateOverrides }));
    const pastTime = new Date(Date.now() - ageMs);
    fs.utimesSync(tmpPath, pastTime, pastTime);
    return tmpPath;
}

function makeConfig(overrides = {}) {
    return {
        pausedMode: false,
        loopLimit: 100,
        timeLimit: 720,
        resumeMode: false,
        ...overrides,
    };
}

test('(a) same-cwd stale orphan triggers stderr warning with session ID', () => {
    const { sessionsRoot, dir } = makeTmpRoot();
    try {
        const sessionId = 'test-session-orphan-a';
        const statePath = makeSession(sessionsRoot, sessionId, {
            active: true,
            pid: null,
            working_dir: process.cwd(),
        });
        backdate(statePath);

        const stderrLines = [];
        const origWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = (msg) => { stderrLines.push(msg); return true; };
        try {
            scanPausedOrphans(sessionsRoot, makeConfig(), new StateManager());
        } finally {
            process.stderr.write = origWrite;
        }

        assert.ok(
            stderrLines.some(l => l.includes(sessionId)),
            `Expected warning containing "${sessionId}" in stderr lines: ${JSON.stringify(stderrLines)}`,
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('(b) --paused flag auto-demotes: state.active becomes false', () => {
    const { sessionsRoot, dir } = makeTmpRoot();
    try {
        const sessionId = 'test-session-orphan-b';
        const statePath = makeSession(sessionsRoot, sessionId, {
            active: true,
            pid: null,
            working_dir: process.cwd(),
        });
        backdate(statePath);
        writeDeadSessionMap(dir, path.dirname(statePath));

        // Silence stderr during scan
        const origWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = () => true;
        try {
            scanPausedOrphans(sessionsRoot, makeConfig({ pausedMode: true }), new StateManager());
        } finally {
            process.stderr.write = origWrite;
        }

        const updated = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(updated.active, false, 'state.active should be false after --paused demote');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('(b2) --paused uses newer recoverable tmp snapshot before orphan demotion', () => {
    const { sessionsRoot, dir } = makeTmpRoot();
    try {
        const sessionId = 'test-session-orphan-b2';
        const statePath = makeSession(sessionsRoot, sessionId, {
            active: false,
            pid: null,
            working_dir: process.cwd(),
        });
        backdate(statePath, 450_000);
        writeRecoverableTmp(statePath, {
            active: true,
            pid: null,
            working_dir: process.cwd(),
            // iteration:1 keeps this snapshot off the R-PTSB-3 phantom signature so the
            // age-gated paused-orphan path (orphan-paused-no-claim) under test fires.
            iteration: 1,
        }, 350_000);
        writeDeadSessionMap(dir, path.dirname(statePath));

        const origWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = () => true;
        try {
            scanPausedOrphans(sessionsRoot, makeConfig({ pausedMode: true }), new StateManager());
        } finally {
            process.stderr.write = origWrite;
        }

        const updated = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(updated.active, false, 'promoted paused orphan snapshot should still be demoted');
        assert.equal(updated.exit_reason, 'orphan-paused-no-claim');
        assert.ok(
            updated.activity.some((entry) => entry?.kind === 'paused_session_orphan_demoted'),
            'expected paused_session_orphan_demoted activity after promoting tmp snapshot',
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('(c) different-cwd orphan is ignored — no warning', () => {
    const { sessionsRoot, dir } = makeTmpRoot();
    try {
        const sessionId = 'test-session-orphan-c';
        const statePath = makeSession(sessionsRoot, sessionId, {
            active: true,
            pid: null,
            working_dir: '/some/completely/different/cwd',
        });
        backdate(statePath);

        const stderrLines = [];
        const origWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = (msg) => { stderrLines.push(msg); return true; };
        try {
            scanPausedOrphans(sessionsRoot, makeConfig(), new StateManager());
        } finally {
            process.stderr.write = origWrite;
        }

        const warnings = stderrLines.filter(l => l.includes('WARNING') && l.includes(sessionId));
        assert.equal(warnings.length, 0, `Expected no warning for different-cwd orphan, got: ${JSON.stringify(warnings)}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('(d) fresh-mtime orphan is ignored — no warning', () => {
    const { sessionsRoot, dir } = makeTmpRoot();
    try {
        const sessionId = 'test-session-orphan-d';
        makeSession(sessionsRoot, sessionId, {
            active: true,
            pid: null,
            working_dir: process.cwd(),
        });
        // Do NOT backdate — mtime is fresh (< 300s)

        const stderrLines = [];
        const origWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = (msg) => { stderrLines.push(msg); return true; };
        try {
            scanPausedOrphans(sessionsRoot, makeConfig(), new StateManager());
        } finally {
            process.stderr.write = origWrite;
        }

        const warnings = stderrLines.filter(l => l.includes('WARNING') && l.includes(sessionId));
        assert.equal(warnings.length, 0, `Expected no warning for fresh-mtime orphan, got: ${JSON.stringify(warnings)}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

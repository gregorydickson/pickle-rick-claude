// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANCEL_BIN = path.resolve(__dirname, '../bin/cancel.js');

/**
 * Create an isolated temp root directory for EXTENSION_DIR.
 * Uses fs.realpathSync to resolve macOS /var -> /private/var symlinks,
 * ensuring path keys in the sessions map match process.cwd() in subprocesses.
 */
function makeTmpRoot() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-cancel-')));
}

/**
 * Write a current_sessions.json into the given extension root.
 */
function writeSessionsMap(extRoot, map) {
    fs.writeFileSync(path.join(extRoot, 'current_sessions.json'), JSON.stringify(map, null, 2));
}

/**
 * Read and parse the current_sessions.json from the given extension root.
 */
function readSessionsMap(extRoot) {
    return JSON.parse(fs.readFileSync(path.join(extRoot, 'current_sessions.json'), 'utf-8'));
}

/**
 * Create a session directory with a state.json inside it.
 */
function makeSessionDir(parentDir, active = true) {
    const sessionDir = path.join(parentDir, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    const state = { active, step: 'research', iteration: 1, original_prompt: 'test' };
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state, null, 2));
    return sessionDir;
}

/**
 * Read and parse state.json from a session directory.
 */
function readState(sessionDir) {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
}

/**
 * Run cancel.js as a subprocess with isolated EXTENSION_DIR.
 * @param {string} extRoot - the EXTENSION_DIR to use
 * @param {string} cwd - the working directory (used as the sessions map key)
 */
function runCancelSubprocess(extRoot, cwd) {
    return execFileSync(process.execPath, [CANCEL_BIN], {
        cwd,
        env: { ...process.env, EXTENSION_DIR: extRoot },
        encoding: 'utf-8',
    });
}

// --- No sessions map ---

test('cancelSession: returns early when no sessions map', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // No current_sessions.json or matching session state written — should not throw
        const output = runCancelSubprocess(tmpRoot, tmpRoot);
        assert.ok(output.includes('No active session found'), 'should report missing session');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- No session for cwd ---

test('cancelSession: returns early when cwd not in sessions map', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // Sessions map exists but doesn't contain our cwd
        writeSessionsMap(tmpRoot, { '/some/other/path': '/some/other/session' });

        const output = runCancelSubprocess(tmpRoot, tmpRoot);
        assert.ok(output.includes('No active session found'), 'should report no session for cwd');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Missing state.json ---

test('cancelSession: returns early when state.json missing', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // Session dir exists but has no state.json. R-SHB-6's pruneOrphanedMapEntries
        // (services/pickle-utils.ts) reaps the phantom map entry before cancel.ts
        // sees it, so the terminal message is "No active session found" rather than
        // the dead-code "State file not found" branch in cancel.ts.
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });

        writeSessionsMap(tmpRoot, { [tmpRoot]: sessionDir });

        const output = runCancelSubprocess(tmpRoot, tmpRoot);
        assert.ok(output.includes('No active session found'), 'should report no active session after prune');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Happy path: sets active=false ---

test('cancelSession: sets active=false in state.json', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = makeSessionDir(tmpRoot, true);
        writeSessionsMap(tmpRoot, { [tmpRoot]: sessionDir });

        runCancelSubprocess(tmpRoot, tmpRoot);

        const updated = readState(sessionDir);
        assert.equal(updated.active, false, 'active should be false after cancel');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Sessions map cleanup ---

test('cancelSession: removes cwd entry from sessions map after cancel', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = makeSessionDir(tmpRoot, true);
        // Real other-cwd + other-session dirs with a stub state.json so
        // R-SHB-6's pruneOrphanedMapEntries doesn't reap the unrelated entry
        // before we get a chance to assert it survived cancel.
        const otherCwd = path.join(tmpRoot, 'other-cwd');
        const otherSession = path.join(tmpRoot, 'other-session');
        fs.mkdirSync(otherCwd, { recursive: true });
        fs.mkdirSync(otherSession, { recursive: true });
        fs.writeFileSync(
            path.join(otherSession, 'state.json'),
            JSON.stringify({ active: true, step: 'research', iteration: 1, original_prompt: 'other' }, null, 2),
        );

        writeSessionsMap(tmpRoot, {
            [tmpRoot]: sessionDir,
            [otherCwd]: otherSession,
        });

        runCancelSubprocess(tmpRoot, tmpRoot);

        const map = readSessionsMap(tmpRoot);
        assert.equal(map[tmpRoot], undefined, 'cancelled cwd must be removed from sessions map');
        assert.equal(map[otherCwd], otherSession, 'other sessions must not be affected');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('cancelSession: promotes newer dead current_sessions tmp before removing cwd entry', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const cwdDir = path.join(tmpRoot, 'repo');
        const otherCwd = path.join(tmpRoot, 'other-repo');
        const sessionDir = path.join(tmpRoot, 'sessions', 'cancelled-session');
        const otherSessionDir = path.join(tmpRoot, 'sessions', 'other-session');
        fs.mkdirSync(cwdDir, { recursive: true });
        fs.mkdirSync(otherCwd, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.mkdirSync(otherSessionDir, { recursive: true });
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({
                active: true,
                working_dir: cwdDir,
                session_dir: sessionDir,
                step: 'implement',
                iteration: 2,
                original_prompt: 'cancel recovered map session',
            }, null, 2)
        );
        fs.writeFileSync(
            path.join(otherSessionDir, 'state.json'),
            JSON.stringify({
                active: true,
                working_dir: otherCwd,
                session_dir: otherSessionDir,
                step: 'research',
                iteration: 1,
                original_prompt: 'preserve other session',
            }, null, 2)
        );
        const mapPath = path.join(tmpRoot, 'current_sessions.json');
        fs.writeFileSync(mapPath, JSON.stringify({ [cwdDir]: sessionDir }, null, 2));
        const tmpMapPath = `${mapPath}.tmp.99999999`;
        fs.writeFileSync(tmpMapPath, JSON.stringify({
            [cwdDir]: sessionDir,
            [otherCwd]: otherSessionDir,
        }, null, 2));
        const newer = new Date(Date.now() + 1000);
        fs.utimesSync(tmpMapPath, newer, newer);

        runCancelSubprocess(tmpRoot, cwdDir);

        const map = readSessionsMap(tmpRoot);
        assert.equal(map[cwdDir], undefined, 'cancelled cwd must be removed from recovered map');
        assert.equal(map[otherCwd], otherSessionDir, 'newer tmp map entries must be preserved');
        assert.equal(fs.existsSync(tmpMapPath), false, 'dead tmp map should be promoted before rewrite');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('cancelSession: promotes tmp-only recoverable state before deactivating the session', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const cwdDir = path.join(tmpRoot, 'repo');
        const sessionDir = path.join(tmpRoot, 'sessions', 'recoverable-session');
        const statePath = path.join(sessionDir, 'state.json');
        const tmpStatePath = `${statePath}.tmp.99999999`;
        fs.mkdirSync(cwdDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(tmpStatePath, JSON.stringify({
            active: true,
            working_dir: cwdDir,
            session_dir: sessionDir,
            step: 'implement',
            iteration: 4,
            original_prompt: 'cancel tmp-only recoverable session',
        }, null, 2));
        writeSessionsMap(tmpRoot, { [cwdDir]: sessionDir });

        const output = runCancelSubprocess(tmpRoot, cwdDir);

        const updated = readState(sessionDir);
        assert.equal(updated.active, false, 'recovered tmp-only session should be deactivated');
        assert.equal(fs.existsSync(tmpStatePath), false, 'recoverable tmp should be promoted');
        assert.ok(output.includes('Loop Cancelled'), `expected cancel success output, got: ${output}`);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Already inactive: refuse to masquerade as a live loop ---

test('cancelSession: already-inactive mapped session reports no active loop and stays inactive', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = makeSessionDir(tmpRoot, false);
        writeSessionsMap(tmpRoot, { [tmpRoot]: sessionDir });

        const output = runCancelSubprocess(tmpRoot, tmpRoot);

        const updated = readState(sessionDir);
        assert.ok(output.includes('No active session found'), 'inactive mapped session should not be treated as active');
        assert.equal(updated.active, false, 'active should remain false');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Pipeline sessions: the runner's phase loop reads a marker, not state.active ---

test('cancelSession: an inactive PIPELINE session still gets the pipeline-cancel marker and is not reported as absent', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = makeSessionDir(tmpRoot, false);
        fs.writeFileSync(path.join(sessionDir, 'pipeline.json'), JSON.stringify({ phases: ['pickle'] }));
        writeSessionsMap(tmpRoot, { [tmpRoot]: sessionDir });

        const output = runCancelSubprocess(tmpRoot, tmpRoot);

        assert.ok(fs.existsSync(path.join(sessionDir, 'pipeline-cancel')), 'the marker is what the phase loop reads');
        assert.ok(!output.includes('No active session found'), `a cancelled pipeline must not be reported as no session: ${output}`);
        assert.equal(readState(sessionDir).active, false);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('cancelSession: an ACTIVE pipeline session gets the marker and is deactivated as before', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = makeSessionDir(tmpRoot, true);
        fs.writeFileSync(path.join(sessionDir, 'pipeline.json'), JSON.stringify({ phases: ['pickle'] }));
        writeSessionsMap(tmpRoot, { [tmpRoot]: sessionDir });

        runCancelSubprocess(tmpRoot, tmpRoot);

        assert.ok(fs.existsSync(path.join(sessionDir, 'pipeline-cancel')));
        assert.equal(readState(sessionDir).active, false);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('cancelSession: a non-pipeline session never gets a marker', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = makeSessionDir(tmpRoot, true);
        writeSessionsMap(tmpRoot, { [tmpRoot]: sessionDir });

        runCancelSubprocess(tmpRoot, tmpRoot);

        assert.ok(!fs.existsSync(path.join(sessionDir, 'pipeline-cancel')), 'only a pipeline session has a phase loop to stop');
        assert.equal(readState(sessionDir).active, false);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Preserves other state fields ---

test('cancelSession: preserves other state fields when setting active=false', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        const state = { active: true, step: 'implement', iteration: 3, original_prompt: 'build the thing' };
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state, null, 2));

        writeSessionsMap(tmpRoot, { [tmpRoot]: sessionDir });

        runCancelSubprocess(tmpRoot, tmpRoot);

        const updated = readState(sessionDir);
        assert.equal(updated.active, false, 'active should be false');
        assert.equal(updated.step, 'implement', 'step should be preserved');
        assert.equal(updated.iteration, 3, 'iteration should be preserved');
        assert.equal(updated.original_prompt, 'build the thing', 'original_prompt should be preserved');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('cancelSession: falls back to active session state when the sessions map is missing', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const cwdDir = path.join(tmpRoot, 'repo');
        const sessionDir = path.join(tmpRoot, 'sessions', 'fallback-session');
        fs.mkdirSync(cwdDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({
                active: true,
                working_dir: cwdDir,
                session_dir: sessionDir,
                step: 'implement',
                iteration: 2,
                original_prompt: 'fallback-cancel',
            }, null, 2)
        );

        runCancelSubprocess(tmpRoot, cwdDir);

        const updated = readState(sessionDir);
        assert.equal(updated.active, false, 'active should be false after fallback cancel');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('cancelSession: unreadable mapped state falls back to the live same-cwd session', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const cwdDir = path.join(tmpRoot, 'repo');
        const staleSessionDir = path.join(tmpRoot, 'sessions', 'stale-session');
        const liveSessionDir = path.join(tmpRoot, 'sessions', 'live-session');
        fs.mkdirSync(cwdDir, { recursive: true });
        fs.mkdirSync(staleSessionDir, { recursive: true });
        fs.mkdirSync(liveSessionDir, { recursive: true });
        writeSessionsMap(tmpRoot, { [cwdDir]: staleSessionDir });
        fs.writeFileSync(path.join(staleSessionDir, 'state.json'), '{{{corrupt json');
        fs.writeFileSync(
            path.join(liveSessionDir, 'state.json'),
            JSON.stringify({
                active: true,
                working_dir: cwdDir,
                session_dir: liveSessionDir,
                step: 'implement',
                iteration: 2,
                original_prompt: 'cancel the live session',
            }, null, 2)
        );

        runCancelSubprocess(tmpRoot, cwdDir);

        const updated = readState(liveSessionDir);
        assert.equal(updated.active, false, 'live session should be deactivated');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('cancelSession: inactive same-cwd fallback session does not masquerade as an active loop', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const cwdDir = path.join(tmpRoot, 'repo');
        const sessionDir = path.join(tmpRoot, 'sessions', 'inactive-session');
        fs.mkdirSync(cwdDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({
                active: false,
                working_dir: cwdDir,
                session_dir: sessionDir,
                step: 'done',
                iteration: 9,
                original_prompt: 'completed-session',
            }, null, 2)
        );

        const output = runCancelSubprocess(tmpRoot, cwdDir);
        assert.ok(
            output.includes('No active session found'),
            `Expected inactive fallback to be ignored, got: ${output}`
        );

        const updated = readState(sessionDir);
        assert.equal(updated.active, false, 'inactive fallback should remain untouched');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('cancelSession: mapped session missing working_dir does not outrank the live same-cwd session', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const cwdDir = path.join(tmpRoot, 'repo');
        const staleSessionDir = path.join(tmpRoot, 'sessions', 'stale-session');
        const liveSessionDir = path.join(tmpRoot, 'sessions', 'live-session');
        fs.mkdirSync(cwdDir, { recursive: true });
        fs.mkdirSync(staleSessionDir, { recursive: true });
        fs.mkdirSync(liveSessionDir, { recursive: true });
        writeSessionsMap(tmpRoot, { [cwdDir]: staleSessionDir });
        fs.writeFileSync(
            path.join(staleSessionDir, 'state.json'),
            JSON.stringify({
                active: true,
                session_dir: staleSessionDir,
                step: 'implement',
                iteration: 1,
                original_prompt: 'stale mapped session without cwd proof',
            }, null, 2)
        );
        fs.writeFileSync(
            path.join(liveSessionDir, 'state.json'),
            JSON.stringify({
                active: true,
                working_dir: cwdDir,
                session_dir: liveSessionDir,
                step: 'implement',
                iteration: 2,
                original_prompt: 'cancel the live session',
            }, null, 2)
        );

        runCancelSubprocess(tmpRoot, cwdDir);

        const staleState = readState(staleSessionDir);
        const liveState = readState(liveSessionDir);
        assert.equal(staleState.active, true, 'stale session should remain active');
        assert.equal(liveState.active, false, 'live session should be deactivated');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Unreadable sessions map ---

test('cancelSession: returns early when sessions map is unreadable JSON', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // Write garbage to sessions map; no fallback session state exists
        fs.writeFileSync(path.join(tmpRoot, 'current_sessions.json'), '{{{{not json}}}}');

        const output = runCancelSubprocess(tmpRoot, tmpRoot);
        assert.ok(output.includes('No active session found'), 'should report missing session');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Unreadable state.json should NOT print "Loop Cancelled" (deep review pass 5)
// ---------------------------------------------------------------------------

test('cancelSession: unreadable state.json does NOT print Loop Cancelled', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        // Write corrupt state.json
        fs.writeFileSync(path.join(sessionDir, 'state.json'), '{{{corrupt json');

        writeSessionsMap(tmpRoot, { [tmpRoot]: sessionDir });

        const output = runCancelSubprocess(tmpRoot, tmpRoot);
        // Must NOT claim the loop was cancelled when state was unreadable
        assert.ok(
            !output.includes('Loop Cancelled'),
            `Should not print "Loop Cancelled" for unreadable state, got: ${output}`
        );
        // Should print an appropriate error message
        assert.ok(
            output.includes('unreadable') || output.includes('Failed'),
            `Should report unreadable state or failure, got: ${output}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

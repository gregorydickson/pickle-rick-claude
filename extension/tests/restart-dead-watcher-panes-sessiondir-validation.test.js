// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    validateSessionDirOrSkip,
    _resetSessionDirInvalidEmittedForTests,
    restartDeadWatcherPanes,
    ensureMonitorWindow,
} from '../services/pickle-utils.js';
import { respawnMonitorWindowForMode } from '../lib/monitor-respawn.js';

// R-TSPF-4: serialize PATH shim mutations across tests that call restartDeadWatcherPanes.
let withPathQueue = Promise.resolve();
function withSerializedPath(shimDir, fn) {
    const run = async () => {
        const savedPath = process.env.PATH;
        try {
            process.env.PATH = `${shimDir}${path.delimiter}${savedPath || ''}`;
            return await fn();
        } finally {
            if (savedPath === undefined) delete process.env.PATH;
            else process.env.PATH = savedPath;
        }
    };
    const queued = withPathQueue.then(run, run);
    withPathQueue = queued.catch(() => undefined);
    return queued;
}

function makeValidSessionDir(tmpRoot, stateExtra = {}) {
    const sessionDir = path.join(tmpRoot, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
        path.join(sessionDir, 'state.json'),
        JSON.stringify({ active: true, command_template: null, ...stateExtra }),
    );
    return sessionDir;
}

function makeExtRoot(tmpRoot) {
    const extRoot = path.join(tmpRoot, 'ext');
    fs.mkdirSync(path.join(extRoot, 'extension', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(extRoot, 'extension', 'bin', 'log-watcher.js'), '// sentinel\n');
    return extRoot;
}

function makeTmpRoot(prefix = 'pickle-sdv-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function noOpSpawnSync() {
    return { status: 0, stdout: '', stderr: '' };
}

function makeSpawnCapture(sessionName = 'test-session') {
    const calls = [];
    const spawnSyncFn = (command, args = []) => {
        calls.push({ command, args: [...args] });
        if (command === 'tmux' && args[0] === 'display-message') {
            return { status: 0, stdout: `${sessionName}\n`, stderr: '' };
        }
        if (command === 'tmux' && args[0] === 'display-message' && args[1] === '-p' && args[2] === '-t') {
            return { status: 0, stdout: 'node\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
    };
    return { calls, spawnSyncFn };
}

// ─── validateSessionDirOrSkip: basic predicate ────────────────────────────────

test('validateSessionDirOrSkip: empty string → false', () => {
    _resetSessionDirInvalidEmittedForTests();
    assert.equal(validateSessionDirOrSkip('', 'restartDeadWatcherPanes'), false);
});

test('validateSessionDirOrSkip: undefined coerced to empty → false', () => {
    _resetSessionDirInvalidEmittedForTests();
    // @ts-ignore — testing runtime guard
    assert.equal(validateSessionDirOrSkip(undefined, 'restartDeadWatcherPanes'), false);
});

test('validateSessionDirOrSkip: non-existent path → false', () => {
    _resetSessionDirInvalidEmittedForTests();
    assert.equal(validateSessionDirOrSkip('/tmp/does-not-exist-pickle-sdv-xyz', 'restartDeadWatcherPanes'), false);
});

test('validateSessionDirOrSkip: existing dir but no state.json → false', () => {
    _resetSessionDirInvalidEmittedForTests();
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'nosession');
        fs.mkdirSync(sessionDir, { recursive: true });
        assert.equal(validateSessionDirOrSkip(sessionDir, 'restartDeadWatcherPanes'), false);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('validateSessionDirOrSkip: valid sessionDir with state.json → true', () => {
    _resetSessionDirInvalidEmittedForTests();
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = makeValidSessionDir(tmpRoot);
        assert.equal(validateSessionDirOrSkip(sessionDir, 'restartDeadWatcherPanes'), true);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('validateSessionDirOrSkip: state.json session_dir mismatch → false', () => {
    _resetSessionDirInvalidEmittedForTests();
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = makeValidSessionDir(tmpRoot, { session_dir: '/completely/different/path' });
        assert.equal(validateSessionDirOrSkip(sessionDir, 'restartDeadWatcherPanes'), false);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('validateSessionDirOrSkip: state.json session_dir matches (after path.resolve) → true', () => {
    _resetSessionDirInvalidEmittedForTests();
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = makeValidSessionDir(tmpRoot);
        // session_dir in state matches the real path
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({ active: true, command_template: null, session_dir: sessionDir }),
        );
        assert.equal(validateSessionDirOrSkip(sessionDir, 'restartDeadWatcherPanes'), true);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// ─── validateSessionDirOrSkip: activity event emission ────────────────────────

test('validateSessionDirOrSkip: emits activity event on invalid sessionDir', () => {
    _resetSessionDirInvalidEmittedForTests();
    const tmpRoot = makeTmpRoot();
    const savedDataRoot = process.env.PICKLE_DATA_ROOT;
    try {
        process.env.PICKLE_DATA_ROOT = tmpRoot;
        validateSessionDirOrSkip('', 'restartDeadWatcherPanes');

        const activityDir = path.join(tmpRoot, 'activity');
        const files = fs.existsSync(activityDir) ? fs.readdirSync(activityDir) : [];
        assert.ok(files.length > 0, 'activity JSONL file should be written');
        const content = fs.readFileSync(path.join(activityDir, files[0]), 'utf-8');
        const entry = JSON.parse(content.trim());
        assert.equal(entry.event, 'monitor_respawn_session_dir_invalid');
        assert.equal(entry.gate_payload.caller, 'restartDeadWatcherPanes');
        assert.equal(entry.gate_payload.reason, 'empty');
        assert.equal(entry.source, 'pickle');
    } finally {
        if (savedDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = savedDataRoot;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// ─── validateSessionDirOrSkip: dedup ──────────────────────────────────────────

test('validateSessionDirOrSkip: dedup — second call with same tuple emits no second event', () => {
    _resetSessionDirInvalidEmittedForTests();
    const tmpRoot = makeTmpRoot();
    const savedDataRoot = process.env.PICKLE_DATA_ROOT;
    try {
        process.env.PICKLE_DATA_ROOT = tmpRoot;
        const fakeDir = '/tmp/pickle-sdv-nonexistent-dedup';

        validateSessionDirOrSkip(fakeDir, 'restartDeadWatcherPanes');
        validateSessionDirOrSkip(fakeDir, 'restartDeadWatcherPanes');

        const activityDir = path.join(tmpRoot, 'activity');
        const files = fs.existsSync(activityDir) ? fs.readdirSync(activityDir) : [];
        assert.ok(files.length > 0, 'activity dir should exist');
        const content = fs.readFileSync(path.join(activityDir, files[0]), 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        assert.equal(lines.length, 1, 'dedup: only one event per unique tuple');
    } finally {
        if (savedDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = savedDataRoot;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('validateSessionDirOrSkip: different callers emit separate events for same sessionDir', () => {
    _resetSessionDirInvalidEmittedForTests();
    const tmpRoot = makeTmpRoot();
    const savedDataRoot = process.env.PICKLE_DATA_ROOT;
    try {
        process.env.PICKLE_DATA_ROOT = tmpRoot;
        const fakeDir = '/tmp/pickle-sdv-nonexistent-callers';

        validateSessionDirOrSkip(fakeDir, 'restartDeadWatcherPanes');
        validateSessionDirOrSkip(fakeDir, 'respawnMonitorWindowForMode');

        const activityDir = path.join(tmpRoot, 'activity');
        const files = fs.existsSync(activityDir) ? fs.readdirSync(activityDir) : [];
        const content = fs.readFileSync(path.join(activityDir, files[0]), 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        assert.equal(lines.length, 2, 'different callers emit separate events');
    } finally {
        if (savedDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = savedDataRoot;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// ─── restartDeadWatcherPanes: validation gate ─────────────────────────────────

test('restartDeadWatcherPanes: empty sessionDir → no tmux spawn calls', () =>
    withSerializedPath(os.tmpdir(), async () => {
        _resetSessionDirInvalidEmittedForTests();
        const { calls, spawnSyncFn } = makeSpawnCapture();
        restartDeadWatcherPanes('', os.tmpdir(), 'pickle', spawnSyncFn);
        const tmuxCalls = calls.filter(c => c.command === 'tmux');
        assert.equal(tmuxCalls.length, 0, 'no tmux calls when sessionDir is empty');
    }));

test('restartDeadWatcherPanes: non-existent sessionDir → no tmux spawn calls', () =>
    withSerializedPath(os.tmpdir(), async () => {
        _resetSessionDirInvalidEmittedForTests();
        const { calls, spawnSyncFn } = makeSpawnCapture();
        restartDeadWatcherPanes('/tmp/pickle-sdv-nonexistent-restart', os.tmpdir(), 'pickle', spawnSyncFn);
        const tmuxCalls = calls.filter(c => c.command === 'tmux');
        assert.equal(tmuxCalls.length, 0, 'no tmux calls when sessionDir does not exist');
    }));

test('restartDeadWatcherPanes: no state.json → no tmux spawn calls', () =>
    withSerializedPath(os.tmpdir(), async () => {
        _resetSessionDirInvalidEmittedForTests();
        const tmpRoot = makeTmpRoot();
        try {
            const sessionDir = path.join(tmpRoot, 'nosession');
            fs.mkdirSync(sessionDir, { recursive: true });
            const extRoot = makeExtRoot(tmpRoot);
            const { calls, spawnSyncFn } = makeSpawnCapture();
            restartDeadWatcherPanes(sessionDir, extRoot, 'pickle', spawnSyncFn);
            const tmuxCalls = calls.filter(c => c.command === 'tmux');
            assert.equal(tmuxCalls.length, 0, 'no tmux calls when state.json is absent');
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    }));

test('restartDeadWatcherPanes: valid inactive sessionDir → skips after validation passes but isSessionInactive', () =>
    withSerializedPath(os.tmpdir(), async () => {
        _resetSessionDirInvalidEmittedForTests();
        const tmpRoot = makeTmpRoot();
        try {
            // active: false → isSessionInactive returns true → function returns after validation
            const sessionDir = makeValidSessionDir(tmpRoot, { active: false });
            const extRoot = makeExtRoot(tmpRoot);
            const { calls, spawnSyncFn } = makeSpawnCapture();
            restartDeadWatcherPanes(sessionDir, extRoot, 'pickle', spawnSyncFn);
            // validation passes (valid dir), then isSessionInactive short-circuits before tmux
            const tmuxCalls = calls.filter(c => c.command === 'tmux');
            assert.equal(tmuxCalls.length, 0, 'inactive session: no tmux calls, but validation passed');
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    }));

// ─── respawnMonitorWindowForMode: validation gate ─────────────────────────────

test('respawnMonitorWindowForMode: empty sessionDir → no tmux spawn calls', async () => {
    _resetSessionDirInvalidEmittedForTests();
    const calls = [];
    const spawnSyncFn = (command, args = []) => {
        calls.push({ command, args: [...args] });
        return { status: 0, stdout: '', stderr: '' };
    };
    await respawnMonitorWindowForMode('', 'pickle', spawnSyncFn);
    const tmuxCalls = calls.filter(c => c.command === 'tmux');
    assert.equal(tmuxCalls.length, 0, 'no tmux calls when sessionDir is empty');
});

test('respawnMonitorWindowForMode: non-existent sessionDir → no tmux spawn calls', async () => {
    _resetSessionDirInvalidEmittedForTests();
    const calls = [];
    const spawnSyncFn = (command, args = []) => {
        calls.push({ command, args: [...args] });
        return { status: 0, stdout: '', stderr: '' };
    };
    await respawnMonitorWindowForMode('/tmp/pickle-sdv-nonexistent-respawn', 'pickle', spawnSyncFn);
    const tmuxCalls = calls.filter(c => c.command === 'tmux');
    assert.equal(tmuxCalls.length, 0, 'no tmux calls when sessionDir does not exist');
});

test('respawnMonitorWindowForMode: valid sessionDir → tmux respawn-pane called', async () => {
    _resetSessionDirInvalidEmittedForTests();
    const tmpRoot = makeTmpRoot();
    const savedDataRoot = process.env.PICKLE_DATA_ROOT;
    try {
        process.env.PICKLE_DATA_ROOT = tmpRoot;
        const sessionDir = makeValidSessionDir(tmpRoot);
        const calls = [];
        const spawnSyncFn = (command, args = []) => {
            calls.push({ command, args: [...args] });
            if (command === 'tmux' && args[0] === 'display-message') {
                return { status: 0, stdout: 'test-session\n', stderr: '' };
            }
            return { status: 0, stdout: '', stderr: '' };
        };
        await respawnMonitorWindowForMode(sessionDir, 'pickle', spawnSyncFn);
        const respawnCalls = calls.filter(c => c.command === 'tmux' && c.args[0] === 'respawn-pane');
        assert.ok(respawnCalls.length > 0, 'tmux respawn-pane called for valid sessionDir');
    } finally {
        if (savedDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = savedDataRoot;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// ─── restartDeadWatcherPanes: ambient tmux session must own the sessionDir ─────
// `#S` names the tmux session the PROCESS sits in, not the one we manage. A
// runner launched from an unrelated tmux (test fixture, operator's own window)
// would otherwise send-keys its pane commands — with Enter — into a stranger's
// live monitor pane.

function makeDataRootSession(dataRoot, name) {
    const sessionDir = path.join(dataRoot, 'sessions', name);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
        path.join(sessionDir, 'state.json'),
        JSON.stringify({ active: true, command_template: null, session_dir: sessionDir }),
    );
    return sessionDir;
}

test('restartDeadWatcherPanes: ambient tmux session owned by ANOTHER pickle session → no send-keys', () => {
    const savedDataRoot = process.env.PICKLE_DATA_ROOT;
    const tmpRoot = makeTmpRoot();
    try {
        process.env.PICKLE_DATA_ROOT = tmpRoot;
        makeDataRootSession(tmpRoot, '2026-07-11-86dd509f');
        // We manage a DIFFERENT session, but we are running inside the live
        // tmux session of `2026-07-11-86dd509f`.
        const sessionDir = makeValidSessionDir(tmpRoot);
        const extRoot = makeExtRoot(tmpRoot);
        const { calls, spawnSyncFn } = makeSpawnCapture('pipeline-86dd509f');

        restartDeadWatcherPanes(sessionDir, extRoot, 'pickle', spawnSyncFn);

        const sendKeys = calls.filter(c => c.command === 'tmux' && c.args[0] === 'send-keys');
        assert.equal(sendKeys.length, 0, 'must not type into a pane of a foreign pickle session');
    } finally {
        if (savedDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = savedDataRoot;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('restartDeadWatcherPanes: ambient tmux session owns THIS sessionDir → respawns', () => {
    const savedDataRoot = process.env.PICKLE_DATA_ROOT;
    const tmpRoot = makeTmpRoot();
    try {
        process.env.PICKLE_DATA_ROOT = tmpRoot;
        const sessionDir = makeDataRootSession(tmpRoot, '2026-07-11-86dd509f');
        const extRoot = makeExtRoot(tmpRoot);
        const { calls, spawnSyncFn } = makeSpawnCapture('pipeline-86dd509f');

        restartDeadWatcherPanes(sessionDir, extRoot, 'pickle', spawnSyncFn);

        const sendKeys = calls.filter(c => c.command === 'tmux' && c.args[0] === 'send-keys');
        assert.ok(sendKeys.length > 0, 'our own monitor window is still repaired');
    } finally {
        if (savedDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = savedDataRoot;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('restartDeadWatcherPanes: tmux session carrying no hash of ours → no send-keys', () => {
    const savedDataRoot = process.env.PICKLE_DATA_ROOT;
    const tmpRoot = makeTmpRoot();
    try {
        process.env.PICKLE_DATA_ROOT = tmpRoot;
        makeDataRootSession(tmpRoot, '2026-07-11-86dd509f');
        const sessionDir = makeValidSessionDir(tmpRoot);
        const extRoot = makeExtRoot(tmpRoot);
        // Fail CLOSED: a name we cannot tie to our own session dir is not ours to drive.
        const { calls, spawnSyncFn } = makeSpawnCapture('pickle-dead');

        restartDeadWatcherPanes(sessionDir, extRoot, 'pickle', spawnSyncFn);

        const sendKeys = calls.filter(c => c.command === 'tmux' && c.args[0] === 'send-keys');
        assert.equal(sendKeys.length, 0, 'a tmux session we cannot claim is never driven');
    } finally {
        if (savedDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = savedDataRoot;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// The live-hijack regression: a worker's data root does NOT contain the operator's
// session, so resolving the ambient name against the data root finds no owner and
// falls open. Ownership must come from the (name, sessionDir) pair alone.
test('restartDeadWatcherPanes: ambient session absent from OUR data root → still no send-keys', () => {
    const savedDataRoot = process.env.PICKLE_DATA_ROOT;
    const tmpRoot = makeTmpRoot();
    try {
        // Sandboxed data root: the live `pipeline-86dd509f` session is nowhere in it.
        process.env.PICKLE_DATA_ROOT = tmpRoot;
        const sessionDir = makeValidSessionDir(tmpRoot);
        const extRoot = makeExtRoot(tmpRoot);
        const { calls, spawnSyncFn } = makeSpawnCapture('pipeline-86dd509f');

        restartDeadWatcherPanes(sessionDir, extRoot, 'pickle', spawnSyncFn);

        const sendKeys = calls.filter(c => c.command === 'tmux' && c.args[0] === 'send-keys');
        assert.equal(sendKeys.length, 0, 'an unresolvable ambient session must not fall open');
    } finally {
        if (savedDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = savedDataRoot;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// ─── ensureMonitorWindow: same ownership gate, higher stakes ──────────────────
//
// `restartDeadWatcherPanes` only ever sent keys. `ensureMonitorWindow` resolves its
// target from the same ambient `#S` but can `kill-window` (on @pickle_monitor_mode
// mismatch) and `new-window` — i.e. destroy a stranger's monitor window and rebuild
// it pointed at our session dir. The mode-mismatch fixture below is exactly that path.

function makeMonitorExtRoot(tmpRoot) {
    const extRoot = makeExtRoot(tmpRoot);
    fs.mkdirSync(path.join(extRoot, 'extension', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(extRoot, 'extension', 'scripts', 'tmux-monitor.sh'), '# sentinel\n');
    return extRoot;
}

/** Ambient tmux advertises `sessionName` and already hosts a monitor window built for `existingMode`. */
function makeModeMismatchCapture(sessionName, existingMode = 'council') {
    const calls = [];
    const spawnSyncFn = (command, args = []) => {
        calls.push({ command, args: [...args] });
        if (command === 'tmux' && args[0] === 'display-message') {
            return { status: 0, stdout: `${sessionName}\n`, stderr: '' };
        }
        if (command === 'tmux' && args[0] === 'list-windows') {
            return { status: 0, stdout: 'bash\nmonitor\n', stderr: '' };
        }
        if (command === 'tmux' && args[0] === 'show-option') {
            return { status: 0, stdout: `${existingMode}\n`, stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
    };
    return { calls, spawnSyncFn };
}

test('ensureMonitorWindow: foreign tmux session with a mode mismatch → never kills its window', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // We manage `session`; we are running inside the live tmux of `2026-07-11-86dd509f`,
        // whose monitor window was built for a different mode.
        const sessionDir = makeValidSessionDir(tmpRoot);
        const extRoot = makeMonitorExtRoot(tmpRoot);
        const { calls, spawnSyncFn } = makeModeMismatchCapture('pipeline-86dd509f', 'council');

        const result = ensureMonitorWindow({
            sessionDir,
            extensionRoot: extRoot,
            mode: 'pickle',
            inTmux: true,
            spawnSyncFn,
            bashBin: 'bash',
        });

        assert.equal(result.status, 'skipped');
        const killed = calls.filter(c => c.command === 'tmux' && c.args[0] === 'kill-window');
        assert.equal(killed.length, 0, "must not kill a stranger's monitor window");
        const bashed = calls.filter(c => c.command === 'bash');
        assert.equal(bashed.length, 0, 'must not build a monitor window in a session we do not own');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('ensureMonitorWindow: our own tmux session with a mode mismatch → still recreates', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = makeDataRootSession(tmpRoot, '2026-07-11-86dd509f');
        const extRoot = makeMonitorExtRoot(tmpRoot);
        const { calls, spawnSyncFn } = makeModeMismatchCapture('pipeline-86dd509f', 'council');

        const result = ensureMonitorWindow({
            sessionDir,
            extensionRoot: extRoot,
            mode: 'pickle',
            inTmux: true,
            spawnSyncFn,
            bashBin: 'bash',
        });

        assert.equal(result.status, 'recreated');
        const killed = calls.filter(c => c.command === 'tmux' && c.args[0] === 'kill-window');
        assert.equal(killed.length, 1, 'our own stale monitor window is still replaced');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('ensureMonitorWindow: tmux session carrying no hash of ours → fails closed', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = makeValidSessionDir(tmpRoot);
        const extRoot = makeMonitorExtRoot(tmpRoot);
        const { calls, spawnSyncFn } = makeModeMismatchCapture('pickle-dead', 'council');

        const result = ensureMonitorWindow({
            sessionDir,
            extensionRoot: extRoot,
            mode: 'pickle',
            inTmux: true,
            spawnSyncFn,
            bashBin: 'bash',
        });

        assert.equal(result.status, 'skipped');
        assert.equal(calls.filter(c => c.args[0] === 'kill-window').length, 0);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

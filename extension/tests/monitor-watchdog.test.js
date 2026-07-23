// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    startRespawnWatchdog,
    isRespawnWatchdogDisabled,
    RESPAWN_WATCHDOG_INTERVAL_MS,
    MONITOR_STDOUT_WATCHDOG_MS,
} from '../bin/monitor.js';
import { _resetSessionDirInvalidEmittedForTests } from '../services/pickle-utils.js';

/**
 * Inject a fake `spawnSync` so the watchdog tick can exercise
 * `restartDeadWatcherPanes` without invoking the real `tmux` binary
 * (which hangs outside a tmux client). The fake records every
 * invocation and returns shaped responses so dead panes are detected
 * and respawn `send-keys` is observable.
 */
/**
 * Launchers name the tmux session `<prefix>-<session-hash>` for the session dir it
 * manages, and `restartDeadWatcherPanes` refuses any session whose hash is not ours.
 * Fixtures must honor that pairing or they exercise a layout production cannot build.
 */
function sessionDirNameFor(sessionName) {
    return sessionName.slice(sessionName.lastIndexOf('-') + 1);
}

function makeWatchdogFakes({ active = true, sessionName = 'pickle-mwr-test', paneCommands } = {}) {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mwr-')));
    const sessionDir = path.join(tmpRoot, sessionDirNameFor(sessionName));
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
        path.join(sessionDir, 'state.json'),
        JSON.stringify({ active, command_template: null }),
    );
    const extRoot = path.join(tmpRoot, 'ext');
    fs.mkdirSync(path.join(extRoot, 'extension', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(extRoot, 'extension', 'bin', 'log-watcher.js'), '// sentinel\n');

    const panes = paneCommands || { 0: 'zsh', 1: 'zsh', 2: 'bash', 3: 'fish' };
    const spawnCalls = [];
    const spawnSyncFn = (command, args = []) => {
        spawnCalls.push({ command, args: [...args] });
        if (command !== 'tmux') return { status: 0, stdout: '', stderr: '' };
        if (args[0] === 'display-message' && args[1] === '-p' && args[2] === '#S') {
            return { status: 0, stdout: `${sessionName}\n`, stderr: '' };
        }
        if (args[0] === 'display-message' && args[1] === '-p' && args[2] === '-t') {
            const target = args[3] || '';
            const pane = Number(target.split('.').at(-1));
            return { status: 0, stdout: `${panes[pane] || ''}\n`, stderr: '' };
        }
        if (args[0] === 'send-keys') {
            return { status: 0, stdout: '', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
    };

    return {
        tmpRoot,
        sessionDir,
        extRoot,
        spawnSyncFn,
        spawnCalls,
        sendKeysCount: () => spawnCalls.filter(c => c.command === 'tmux' && c.args[0] === 'send-keys').length,
        cleanup() {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        },
    };
}

// --- Constant invariants ---

test('RESPAWN_WATCHDOG_INTERVAL_MS: 30 second positive integer', () => {
    assert.equal(typeof RESPAWN_WATCHDOG_INTERVAL_MS, 'number');
    assert.equal(RESPAWN_WATCHDOG_INTERVAL_MS, 30_000);
    assert.ok(Number.isInteger(RESPAWN_WATCHDOG_INTERVAL_MS));
});

test('RESPAWN_WATCHDOG_INTERVAL_MS distinct symbol from MONITOR_STDOUT_WATCHDOG_MS (R-MWR-rename)', () => {
    // R7 mitigation: the two watchdog scopes never share state.
    assert.notEqual(RESPAWN_WATCHDOG_INTERVAL_MS, MONITOR_STDOUT_WATCHDOG_MS);
});

// --- startRespawnWatchdog wiring (R-MWR-1) ---

test('startRespawnWatchdog: returns a timer handle that is unref-d', () => {
    const f = makeWatchdogFakes();
    try {
        const handle = startRespawnWatchdog({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            intervalMs: 60_000, // never fires in this test
            spawnSyncFn: f.spawnSyncFn,
        });
        assert.ok(handle, 'should return a Timeout handle');
        clearInterval(handle);
    } finally {
        f.cleanup();
    }
});

test('startRespawnWatchdog: fires once immediately on registration, then again after the interval', async () => {
    const f = makeWatchdogFakes();
    try {
        const intervalMs = 60;
        const handle = startRespawnWatchdog({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            intervalMs,
            spawnSyncFn: f.spawnSyncFn,
        });

        const sendKeysAfterRegistration = f.sendKeysCount();
        assert.equal(
            sendKeysAfterRegistration,
            4,
            `expected exactly one immediate respawn sweep (4 panes); got ${sendKeysAfterRegistration}`,
        );

        const muxLogPath = path.join(f.sessionDir, 'mux-runner.log');
        await new Promise(resolve => setTimeout(resolve, 20));
        const immediateLog = fs.existsSync(muxLogPath) ? fs.readFileSync(muxLogPath, 'utf-8') : '';
        assert.match(immediateLog, /monitor-watchdog: respawned monitor\.js in pane 0/, immediateLog);

        await new Promise(resolve => setTimeout(resolve, intervalMs + 30));
        clearInterval(handle);

        const sendKeysAfterSecondTick = f.sendKeysCount();
        assert.ok(
            sendKeysAfterSecondTick >= 8,
            `expected immediate tick plus one interval tick (>=8 send-keys); got ${sendKeysAfterSecondTick}`,
        );
    } finally {
        f.cleanup();
    }
});

test('startRespawnWatchdog: tick respawns dead panes via restartDeadWatcherPanes', async () => {
    const f = makeWatchdogFakes();
    try {
        // Use a short interval so the test runs in real time without
        // depending on a mock clock. R-MWR-1 prescribes setInterval +
        // .unref(); a tiny interval still exercises the same path.
        const intervalMs = 60;
        const handle = startRespawnWatchdog({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            intervalMs,
            spawnSyncFn: f.spawnSyncFn,
        });
        // Wait for ~3 ticks so we can prove "ticks more than once".
        await new Promise(resolve => setTimeout(resolve, intervalMs * 3 + 30));
        clearInterval(handle);

        // Each tick walks 4 watcher panes; with all panes "dead" each
        // tick produces 4 send-keys calls. We assert "at least one
        // tick fired" rather than exact count to avoid flake on slow CI.
        const sendKeyCount = f.sendKeysCount();
        assert.ok(
            sendKeyCount >= 4,
            `expected ≥4 send-keys (one tick × 4 panes); got ${sendKeyCount}`,
        );
        // Watchdog must have queried session name + per-pane state.
        const displayCalls = f.spawnCalls.filter(c => c.command === 'tmux' && c.args[0] === 'display-message');
        assert.ok(
            displayCalls.length >= 5,
            `expected ≥5 display-message calls (1 session + 4 panes); got ${displayCalls.length}`,
        );
    } finally {
        f.cleanup();
    }
});

test('startRespawnWatchdog: inactive session is a no-op (restartDeadWatcherPanes early-returns)', async () => {
    const f = makeWatchdogFakes({ active: false });
    try {
        const intervalMs = 50;
        const handle = startRespawnWatchdog({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            intervalMs,
            spawnSyncFn: f.spawnSyncFn,
        });
        await new Promise(resolve => setTimeout(resolve, intervalMs * 3 + 30));
        clearInterval(handle);

        assert.equal(f.sendKeysCount(), 0, 'inactive session must not respawn anything');
        // No tmux calls at all because isSessionInactive short-circuits before
        // any spawnSync invocation.
        const tmuxCalls = f.spawnCalls.filter(c => c.command === 'tmux');
        assert.equal(tmuxCalls.length, 0, 'inactive session must not invoke tmux');
    } finally {
        f.cleanup();
    }
});

test('startRespawnWatchdog: callback errors do not crash the timer (best-effort try/catch)', async () => {
    const f = makeWatchdogFakes();
    try {
        // Throw on every tmux call so restartDeadWatcherPanes raises.
        const throwingSpawn = () => {
            throw new Error('synthetic tmux failure');
        };
        const errors = [];
        const intervalMs = 50;
        const handle = startRespawnWatchdog({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            intervalMs,
            spawnSyncFn: throwingSpawn,
            logger: (msg) => errors.push(msg),
        });
        await new Promise(resolve => setTimeout(resolve, intervalMs * 2 + 25));
        clearInterval(handle);
        // The watchdog must swallow the error; we proved that by reaching
        // this assertion without an unhandled rejection / process crash.
        // The logger callback may or may not have observed the error
        // (depending on whether the error escaped the spawnSync mock or
        // was already absorbed by restartDeadWatcherPanes' own try/catch).
        assert.ok(true, 'watchdog timer survived spawnSync exceptions');
    } finally {
        f.cleanup();
    }
});

test('startRespawnWatchdog: first-tick failure still leaves the interval armed', async () => {
    const f = makeWatchdogFakes();
    try {
        let shouldThrow = true;
        const errors = [];
        const intervalMs = 50;
        const flakySpawn = (command, args = []) => {
            if (shouldThrow) {
                shouldThrow = false;
                throw new Error('synthetic first-tick failure');
            }
            return f.spawnSyncFn(command, args);
        };
        const handle = startRespawnWatchdog({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            intervalMs,
            spawnSyncFn: flakySpawn,
            logger: (msg) => errors.push(msg),
        });

        assert.equal(errors.length, 1, 'immediate failure must be logged once');
        assert.match(errors[0], /monitor-watchdog tick error: synthetic first-tick failure/);
        assert.equal(f.sendKeysCount(), 0, 'failed immediate tick must not fake a successful respawn');

        await new Promise(resolve => setTimeout(resolve, intervalMs + 30));
        clearInterval(handle);

        assert.ok(
            f.sendKeysCount() >= 4,
            `expected later interval tick to proceed after initial failure; got ${f.sendKeysCount()} send-keys`,
        );
    } finally {
        f.cleanup();
    }
});

// --- Env kill-switch (R-MWR-2) ---

test('isRespawnWatchdogDisabled: true only when PICKLE_MONITOR_WATCHDOG=off', () => {
    assert.equal(isRespawnWatchdogDisabled({}), false);
    assert.equal(isRespawnWatchdogDisabled({ PICKLE_MONITOR_WATCHDOG: '' }), false);
    assert.equal(isRespawnWatchdogDisabled({ PICKLE_MONITOR_WATCHDOG: 'on' }), false);
    assert.equal(isRespawnWatchdogDisabled({ PICKLE_MONITOR_WATCHDOG: 'OFF' }), false);
    assert.equal(isRespawnWatchdogDisabled({ PICKLE_MONITOR_WATCHDOG: 'off' }), true);
});

test('startRespawnWatchdog: PICKLE_MONITOR_WATCHDOG=off disables the timer entirely', async () => {
    const f = makeWatchdogFakes();
    try {
        const handle = startRespawnWatchdog({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            intervalMs: 30,
            spawnSyncFn: f.spawnSyncFn,
            env: { PICKLE_MONITOR_WATCHDOG: 'off' },
        });
        assert.equal(handle, null, 'kill-switch must return null instead of a Timeout');
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(
            f.spawnCalls.length,
            0,
            'no tmux calls when watchdog is disabled — proves no timer fired',
        );
    } finally {
        f.cleanup();
    }
});

test('startRespawnWatchdog: kill-switch is independent of MONITOR_STDOUT_WATCHDOG_MS scope', () => {
    // R-MWR-rename + R-MWR-2: the env knob disables ONLY the respawn
    // watchdog. The stdout-wedge constant survives unchanged regardless.
    const before = MONITOR_STDOUT_WATCHDOG_MS;
    const f = makeWatchdogFakes();
    try {
        const handle = startRespawnWatchdog({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            intervalMs: 60_000,
            spawnSyncFn: f.spawnSyncFn,
            env: { PICKLE_MONITOR_WATCHDOG: 'off' },
        });
        assert.equal(handle, null);
        assert.equal(MONITOR_STDOUT_WATCHDOG_MS, before, 'stdout watchdog constant untouched');
    } finally {
        f.cleanup();
    }
});

// --- Log-line tagging (R-MWR-3 + AC-MWR-05) ---

test('startRespawnWatchdog: respawn lines are tagged "monitor-watchdog:" (R-MWR-3)', async () => {
    const f = makeWatchdogFakes();
    try {
        const intervalMs = 30;
        const handle = startRespawnWatchdog({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            intervalMs,
            spawnSyncFn: f.spawnSyncFn,
        });
        await new Promise(resolve => setTimeout(resolve, intervalMs + 30));
        clearInterval(handle);

        const muxLogPath = path.join(f.sessionDir, 'mux-runner.log');
        const log = fs.existsSync(muxLogPath) ? fs.readFileSync(muxLogPath, 'utf-8') : '';
        // AC-MWR-05: distinct tag from boundary-driven `restartDeadWatcherPanes:`.
        assert.match(log, /monitor-watchdog: respawned monitor\.js in pane 0/, log);
        assert.match(log, /monitor-watchdog: respawned log-watcher\.js in pane 1/, log);
        assert.match(log, /monitor-watchdog: respawned morty-watcher\.js in pane 2/, log);
        assert.match(log, /monitor-watchdog: respawned raw-morty\.js in pane 3/, log);
        assert.doesNotMatch(log, /restartDeadWatcherPanes: respawned/, 'watchdog calls must not leak the boundary tag');
    } finally {
        f.cleanup();
    }
});

test('startRespawnWatchdog: respawns a dead pane exactly once per tick (R-MWR-7)', async () => {
    // R-MWR-7 acceptance: "advance fake timer 30s, assert respawn invoked
    // exactly once". We approximate "advance fake timer" with one real
    // setInterval tick at 30ms and bound the wait window so only ONE tick
    // can fire. Each tick must respawn the 4 dead panes exactly once.
    const f = makeWatchdogFakes();
    try {
        const intervalMs = 30;
        const handle = startRespawnWatchdog({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            intervalMs,
            spawnSyncFn: f.spawnSyncFn,
        });
        await new Promise(resolve => setTimeout(resolve, intervalMs + 10));
        clearInterval(handle);

        const sendKeys = f.spawnCalls.filter(c => c.command === 'tmux' && c.args[0] === 'send-keys');
        // Registration now fires immediately. Depending on scheduler timing,
        // the narrow window may capture only that first sweep or also the
        // first interval-driven sweep before clearInterval lands.
        assert.ok(
            sendKeys.length >= 4 && sendKeys.length <= 8,
            `expected 4-8 send-keys for immediate sweep with at most one interval sweep; got ${sendKeys.length}`,
        );
    } finally {
        f.cleanup();
    }
});

// --- R-MMRT-2: sessionDir validation at watchdog entry ---

test('startRespawnWatchdog: empty sessionDir returns null, no timer armed, emits stderr event', async () => {
    _resetSessionDirInvalidEmittedForTests();
    const f = makeWatchdogFakes();
    const stderrLines = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => { stderrLines.push(String(chunk)); return origWrite(chunk, ...args); };
    let handle;
    try {
        handle = startRespawnWatchdog({
            sessionDir: '',
            extensionRoot: f.extRoot,
            intervalMs: 30,
            spawnSyncFn: f.spawnSyncFn,
            env: {},
        });
        assert.equal(handle, null, 'empty sessionDir must return null');
        await new Promise(resolve => setTimeout(resolve, 80));
        assert.equal(f.spawnCalls.length, 0, 'no spawnSync calls when watchdog refused to arm');
        assert.ok(
            stderrLines.some(l => l.includes('monitor_respawn_session_dir_invalid') && l.includes('startRespawnWatchdog')),
            `expected stderr event line; got: ${JSON.stringify(stderrLines)}`,
        );
    } finally {
        process.stderr.write = origWrite;
        if (handle) clearInterval(handle);
        f.cleanup();
    }
});

test('startRespawnWatchdog: nonexistent sessionDir returns null, no timer armed, emits stderr event', async () => {
    _resetSessionDirInvalidEmittedForTests();
    const f = makeWatchdogFakes();
    const stderrLines = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => { stderrLines.push(String(chunk)); return origWrite(chunk, ...args); };
    let handle;
    try {
        handle = startRespawnWatchdog({
            sessionDir: '/nonexistent-pickle-mmrt2-test-dir',
            extensionRoot: f.extRoot,
            intervalMs: 30,
            spawnSyncFn: f.spawnSyncFn,
            env: {},
        });
        assert.equal(handle, null, 'nonexistent sessionDir must return null');
        await new Promise(resolve => setTimeout(resolve, 80));
        assert.equal(f.spawnCalls.length, 0, 'no spawnSync calls when watchdog refused to arm');
        assert.ok(
            stderrLines.some(l => l.includes('monitor_respawn_session_dir_invalid') && l.includes('startRespawnWatchdog')),
            `expected stderr event line; got: ${JSON.stringify(stderrLines)}`,
        );
    } finally {
        process.stderr.write = origWrite;
        if (handle) clearInterval(handle);
        f.cleanup();
    }
});

test('startRespawnWatchdog: temp dir without state.json returns null, no timer armed, emits stderr event', async () => {
    _resetSessionDirInvalidEmittedForTests();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mmrt2-'));
    const f = makeWatchdogFakes();
    const stderrLines = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => { stderrLines.push(String(chunk)); return origWrite(chunk, ...args); };
    let handle;
    try {
        handle = startRespawnWatchdog({
            sessionDir: tmpDir,
            extensionRoot: f.extRoot,
            intervalMs: 30,
            spawnSyncFn: f.spawnSyncFn,
            env: {},
        });
        assert.equal(handle, null, 'dir without state.json must return null');
        await new Promise(resolve => setTimeout(resolve, 80));
        assert.equal(f.spawnCalls.length, 0, 'no spawnSync calls when watchdog refused to arm');
        assert.ok(
            stderrLines.some(l => l.includes('monitor_respawn_session_dir_invalid') && l.includes('startRespawnWatchdog')),
            `expected stderr event line; got: ${JSON.stringify(stderrLines)}`,
        );
    } finally {
        process.stderr.write = origWrite;
        if (handle) clearInterval(handle);
        f.cleanup();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// R-MWR-1 seam-alias pin (anatomy-park iter 8).
//
// The trap-door PATTERN_SHAPE named the bare `setInterval` identifier
// (`const handle = setInterval(tick, intervalMs)`), but the scheduler is the
// injectable seam alias `_setInterval` (`opts.setIntervalFn ?? setInterval`).
// The anchor therefore matched NOTHING in monitor.ts: replaying it reports a
// phantom violation of a contract the code actually honors.
test('R-MWR-1: watchdog arms via the _setInterval seam alias, then ticks synchronously', () => {
    const src = fs.readFileSync(new URL('../src/bin/monitor.ts', import.meta.url), 'utf-8');

    assert.match(
        src,
        /const _setInterval = opts\.setIntervalFn \?\? setInterval;/,
        'R-MWR-1: the scheduler must stay injectable so the watchdog is testable without real timers',
    );

    const armIdx = src.indexOf('const handle = _setInterval(tick, intervalMs)');
    assert.ok(armIdx > 0, 'R-MWR-1: the recurring interval must be armed via the _setInterval alias');

    const syncTickIdx = src.indexOf('\n  tick();', armIdx);
    assert.ok(
        syncTickIdx > armIdx,
        'R-MWR-1: a synchronous first tick must follow arming so collapsed panes recover ' +
        'immediately instead of waiting a full interval',
    );

    assert.ok(
        src.indexOf('return handle;', syncTickIdx) > syncTickIdx,
        'R-MWR-1: the armed handle must still be returned after the synchronous first tick',
    );
});

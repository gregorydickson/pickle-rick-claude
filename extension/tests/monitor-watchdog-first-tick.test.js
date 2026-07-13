// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { startRespawnWatchdog, RESPAWN_WATCHDOG_INTERVAL_MS } from '../bin/monitor.js';
import { _resetSessionDirInvalidEmittedForTests } from '../services/pickle-utils.js';

function makeFirstTickFakes({ active = true, paneCommands } = {}) {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mwcl5-')));
    // Session dir carries the hash the fake tmux `#S` advertises (`pickle-mwcl5-test`) —
    // restartDeadWatcherPanes refuses any tmux session whose hash is not ours.
    const sessionDir = path.join(tmpRoot, 'test');
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
            return { status: 0, stdout: 'pickle-mwcl5-test\n', stderr: '' };
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
        muxLogPath: path.join(sessionDir, 'mux-runner.log'),
        sendKeysCount: () => spawnCalls.filter(c => c.command === 'tmux' && c.args[0] === 'send-keys').length,
        cleanup() {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        },
    };
}

// (a) First tick fires synchronously — sendKeys observable without any await
test('R-MWCL-5: first tick fires synchronously at startup', () => {
    const f = makeFirstTickFakes();
    try {
        // Use a fake setInterval that never fires (interval = infinity effectively)
        // so only the synchronous first tick can produce send-keys calls.
        const registeredCallbacks = [];
        const fakeSetInterval = (fn, _ms) => {
            registeredCallbacks.push(fn);
            return { unref() {} };
        };
        startRespawnWatchdog({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            intervalMs: 999_999,
            spawnSyncFn: f.spawnSyncFn,
            setIntervalFn: fakeSetInterval,
        });

        // No await — send-keys must have fired synchronously.
        const count = f.sendKeysCount();
        assert.equal(
            count,
            4,
            `expected 4 send-keys from synchronous first tick; got ${count}`,
        );
        // Interval callback registered but never called.
        assert.equal(registeredCallbacks.length, 1, 'setInterval called exactly once');
    } finally {
        f.cleanup();
    }
});

// (b) Startup log line precedes any setInterval-scheduled tick
test('R-MWCL-5: startup log line written before first tick fires', () => {
    const f = makeFirstTickFakes();
    try {
        const intervalCallbacks = [];
        const fakeSetInterval = (fn, _ms) => {
            intervalCallbacks.push(fn);
            return { unref() {} };
        };
        startRespawnWatchdog({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            intervalMs: 999_999,
            spawnSyncFn: f.spawnSyncFn,
            setIntervalFn: fakeSetInterval,
        });

        // Read log before any interval tick fires.
        const logBeforeInterval = fs.existsSync(f.muxLogPath)
            ? fs.readFileSync(f.muxLogPath, 'utf-8')
            : '';
        assert.match(
            logBeforeInterval,
            /monitor-watchdog startup: first tick at /,
            `startup log line missing before interval tick; log: ${logBeforeInterval}`,
        );

        // The startup line should appear before the first respawn line.
        const startupIdx = logBeforeInterval.indexOf('startup: first tick at');
        const respawnIdx = logBeforeInterval.indexOf('monitor-watchdog: respawned');
        assert.ok(
            startupIdx !== -1,
            'startup log line must exist',
        );
        assert.ok(
            respawnIdx === -1 || startupIdx < respawnIdx,
            `startup line (pos ${startupIdx}) must precede any respawn line (pos ${respawnIdx})`,
        );

        // Now fire interval callback manually — respawn lines appear AFTER startup line.
        if (intervalCallbacks[0]) intervalCallbacks[0]();
        const logAfterInterval = fs.readFileSync(f.muxLogPath, 'utf-8');
        const startupIdxAfter = logAfterInterval.indexOf('startup: first tick at');
        const respawnIdxAfter = logAfterInterval.indexOf('monitor-watchdog: respawned');
        assert.ok(startupIdxAfter < respawnIdxAfter,
            `startup line (pos ${startupIdxAfter}) must precede interval-driven respawn (pos ${respawnIdxAfter})`);
    } finally {
        f.cleanup();
    }
});

// (c) First-tick error caught and logged to stderr; no unhandled rejection
test('R-MWCL-5: first-tick error logged to stderr without unhandled rejection', () => {
    const f = makeFirstTickFakes();
    const stderrLines = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
        stderrLines.push(String(chunk));
        return origWrite(chunk, ...args);
    };
    try {
        const throwingSpawn = () => { throw new Error('synthetic first-tick failure'); };
        const fakeSetInterval = (_fn, _ms) => ({ unref() {} });
        const errors = [];
        startRespawnWatchdog({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            intervalMs: 999_999,
            spawnSyncFn: throwingSpawn,
            setIntervalFn: fakeSetInterval,
            logger: (msg) => errors.push(msg),
        });
        // Process must still be alive (no crash = no unhandled rejection).
        assert.ok(true, 'process survived first-tick throw');
        // Error logged to stderr.
        assert.ok(
            stderrLines.some(l => l.includes('[respawn-watchdog] first-tick error:') && l.includes('synthetic first-tick failure')),
            `expected stderr first-tick error; got: ${JSON.stringify(stderrLines)}`,
        );
        // Error also logged to the logger callback (backward compat).
        assert.ok(
            errors.some(e => e.includes('monitor-watchdog tick error: synthetic first-tick failure')),
            `expected logger to receive error; got: ${JSON.stringify(errors)}`,
        );
    } finally {
        process.stderr.write = origWrite;
        f.cleanup();
    }
});

// (c) subsequent ticks still fire after first-tick error
test('R-MWCL-5: interval ticks still fire after first-tick error', () => {
    const f = makeFirstTickFakes();
    try {
        let shouldThrow = true;
        const flakySpawn = (command, args = []) => {
            if (shouldThrow) {
                shouldThrow = false;
                throw new Error('flaky first tick');
            }
            return f.spawnSyncFn(command, args);
        };
        const capturedCallbacks = [];
        const fakeSetInterval = (fn, _ms) => {
            capturedCallbacks.push(fn);
            return { unref() {} };
        };
        startRespawnWatchdog({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            intervalMs: 999_999,
            spawnSyncFn: flakySpawn,
            setIntervalFn: fakeSetInterval,
        });
        // First tick errored — no send-keys.
        assert.equal(f.sendKeysCount(), 0, 'failed first tick must not produce send-keys');
        // Fire the interval callback manually — should succeed.
        if (capturedCallbacks[0]) capturedCallbacks[0]();
        assert.ok(f.sendKeysCount() >= 4,
            `interval tick after first-tick error must proceed; got ${f.sendKeysCount()} send-keys`);
    } finally {
        f.cleanup();
    }
});

// (d) 30s cadence preserved — setInterval receives RESPAWN_WATCHDOG_INTERVAL_MS
test('R-MWCL-5: setInterval called with RESPAWN_WATCHDOG_INTERVAL_MS by default', () => {
    const f = makeFirstTickFakes();
    try {
        let capturedMs;
        const fakeSetInterval = (fn, ms) => {
            capturedMs = ms;
            return { unref() {} };
        };
        startRespawnWatchdog({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            spawnSyncFn: f.spawnSyncFn,
            setIntervalFn: fakeSetInterval,
        });
        assert.equal(
            capturedMs,
            RESPAWN_WATCHDOG_INTERVAL_MS,
            `expected interval ${RESPAWN_WATCHDOG_INTERVAL_MS}ms; got ${capturedMs}`,
        );
        assert.equal(capturedMs, 30_000, 'cadence must be 30 seconds');
    } finally {
        f.cleanup();
    }
});

// (d) custom intervalMs overrides default (regression for tick cadence)
test('R-MWCL-5: custom intervalMs passed through to setInterval', () => {
    const f = makeFirstTickFakes();
    try {
        let capturedMs;
        const fakeSetInterval = (fn, ms) => {
            capturedMs = ms;
            return { unref() {} };
        };
        startRespawnWatchdog({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            intervalMs: 12_345,
            spawnSyncFn: f.spawnSyncFn,
            setIntervalFn: fakeSetInterval,
        });
        assert.equal(capturedMs, 12_345, 'custom intervalMs must reach setInterval');
    } finally {
        f.cleanup();
    }
});

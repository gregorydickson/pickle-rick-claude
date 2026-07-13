// @tier: fast
// R-MWCL-3: collapsed-layout fallback for restartDeadWatcherPanes
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync as realSpawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { restartDeadWatcherPanes } from '../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// R-TSPF-4: serialize PATH mutations so concurrent tests don't clobber each other.
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

function loadRobustSpawnSync(command, args, opts) {
    return realSpawnSync(command, args, { ...opts, timeout: 60_000 });
}

/**
 * Minimal fixture: creates a fake tmux that can simulate:
 * - Specific panes missing (display-message exits 1)
 * - Monitor window missing (list-panes exits 1)
 * - split-window, send-keys, select-layout logged to calls.log
 *
 * opts.missingPanes: number[]  — pane indices where display-message should fail
 * opts.windowMissing: boolean  — if true, list-panes exits 1
 * opts.sendKeysFails: boolean  — if true, send-keys exits 1
 * opts.sessionName: string
 */
/**
 * Launchers name the tmux session `<prefix>-<session-hash>` for the session dir it
 * manages, and `restartDeadWatcherPanes` refuses any session whose hash is not ours.
 * Fixtures must honor that pairing or they exercise a layout production cannot build.
 */
function sessionDirNameFor(sessionName) {
    return sessionName.slice(sessionName.lastIndexOf('-') + 1);
}

function makeCollapsedFakes(opts = {}) {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mwcl3-')));
    const callsLog = path.join(tmpRoot, 'calls.log');
    const shimDir = path.join(tmpRoot, 'bin');
    fs.mkdirSync(shimDir, { recursive: true });

    const sessionName = opts.sessionName || 'mwcl3-test';

    const sessionDir = path.join(tmpRoot, sessionDirNameFor(sessionName));
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
        path.join(sessionDir, 'state.json'),
        JSON.stringify({ active: true, command_template: null }),
    );

    const extRoot = path.join(tmpRoot, 'ext');
    fs.mkdirSync(path.join(extRoot, 'extension', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(extRoot, 'extension', 'bin', 'log-watcher.js'), '// sentinel\n');

    const missingPanes = new Set(opts.missingPanes || []);
    const windowMissing = opts.windowMissing === true;
    const sendKeysFails = opts.sendKeysFails === true;

    // Pane commands for panes that are NOT missing — default to 'bash' (non-node = dead watcher)
    const paneCommands = opts.paneCommands || { 0: 'node', 1: 'node', 2: 'bash', 3: 'node' };
    for (const pane of [0, 1, 2, 3]) {
        fs.writeFileSync(path.join(tmpRoot, `.pane-${pane}`), paneCommands[pane] || 'node');
    }

    const fakeTmux = path.join(shimDir, 'tmux');
    fs.writeFileSync(
        fakeTmux,
        `#!/bin/sh
echo "tmux $*" >> "${callsLog}"
case "$1" in
  display-message)
    case "$*" in
      *monitor.0*pane_current_command*) ${missingPanes.has(0) ? 'exit 1' : `cat "${path.join(tmpRoot, '.pane-0')}"`} ;;
      *monitor.1*pane_current_command*) ${missingPanes.has(1) ? 'exit 1' : `cat "${path.join(tmpRoot, '.pane-1')}"`} ;;
      *monitor.2*pane_current_command*) ${missingPanes.has(2) ? 'exit 1' : `cat "${path.join(tmpRoot, '.pane-2')}"`} ;;
      *monitor.3*pane_current_command*) ${missingPanes.has(3) ? 'exit 1' : `cat "${path.join(tmpRoot, '.pane-3')}"`} ;;
      *) echo "${sessionName}" ;;
    esac
    ;;
  list-panes)
    ${windowMissing ? 'exit 1' : 'echo "0"; echo "1"; echo "3"'}
    ;;
  send-keys)
    ${sendKeysFails ? 'exit 1' : 'exit 0'}
    ;;
  *)
    exit 0
    ;;
esac
`,
    );
    fs.chmodSync(fakeTmux, 0o755);

    return {
        tmpRoot,
        sessionDir,
        extRoot,
        callsLog,
        shimDir,
        cleanup() {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        },
        readCalls() {
            return fs.existsSync(callsLog) ? fs.readFileSync(callsLog, 'utf-8') : '';
        },
        readRunnerLog() {
            const logPath = path.join(sessionDir, 'mux-runner.log');
            return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
        },
        withPath(fn) {
            return withSerializedPath(shimDir, fn);
        },
    };
}

// AC-1: split-window called when pane 2 missing but monitor window has surviving panes
// AC-2: send-keys called with correct morty-watcher.js command for pane 2
// AC-3: select-layout tiled invoked after split + send-keys
// AC-4: log line contains literal tag 'collapsed-layout-repair'
test('restartDeadWatcherPanes collapsed-layout: split-window + send-keys + select-layout + collapsed-layout-repair log when pane 2 missing but window survives', async () => {
    const f = makeCollapsedFakes({
        sessionName: 'mwcl3-split',
        missingPanes: [2],
        paneCommands: { 0: 'node', 1: 'node', 2: 'bash', 3: 'node' },
        windowMissing: false,
    });
    try {
        await f.withPath(() =>
            restartDeadWatcherPanes(f.sessionDir, f.extRoot, 'pickle', loadRobustSpawnSync),
        );

        const calls = f.readCalls();
        // AC-1: split-window for missing pane 2 (pane-2 uses -v -l 40% targeting monitor.0)
        assert.match(calls, /tmux split-window.*monitor\.0/, 'split-window must target monitor.0 for pane 2');

        // AC-2: send-keys with morty-watcher.js for pane 2
        assert.match(calls, /tmux send-keys.*monitor\.2.*morty-watcher\.js/, 'send-keys must use morty-watcher.js for pane 2');

        // AC-3: select-layout tiled after split + send-keys
        assert.match(calls, /tmux select-layout.*monitor.*tiled/, 'select-layout tiled must be invoked after repair');

        // AC-4: collapsed-layout-repair tag in mux-runner.log
        const runnerLog = f.readRunnerLog();
        assert.match(runnerLog, /collapsed-layout-repair/, 'mux-runner.log must contain collapsed-layout-repair tag');
    } finally {
        f.cleanup();
    }
});

// AC-5: monitor window missing → ensureMonitorWindow is called, no split-window
test('restartDeadWatcherPanes collapsed-layout: escalates to ensureMonitorWindow when monitor window is entirely missing', async () => {
    const f = makeCollapsedFakes({
        sessionName: 'mwcl3-window-missing',
        missingPanes: [2],
        windowMissing: true,
    });

    let ensureMonitorWindowCalled = false;
    let ensureMonitorWindowOpts = null;

    const ensureMonitorWindowSpy = (opts) => {
        ensureMonitorWindowCalled = true;
        ensureMonitorWindowOpts = opts;
        return { status: 'created', recreate: true };
    };

    try {
        await f.withPath(() =>
            restartDeadWatcherPanes(
                f.sessionDir,
                f.extRoot,
                'pickle',
                loadRobustSpawnSync,
                'restartDeadWatcherPanes',
                ensureMonitorWindowSpy,
            ),
        );

        // AC-5: ensureMonitorWindow spy was called
        assert.ok(ensureMonitorWindowCalled, 'ensureMonitorWindow must be called when monitor window is missing');
        assert.equal(ensureMonitorWindowOpts?.sessionDir, f.sessionDir, 'ensureMonitorWindow must receive correct sessionDir');
        assert.equal(ensureMonitorWindowOpts?.inTmux, true, 'ensureMonitorWindow must receive inTmux: true');

        // No split-window when window is missing (ensureMonitorWindow handles it)
        const calls = f.readCalls();
        assert.doesNotMatch(calls, /tmux split-window/, 'split-window must NOT be called when escalating to ensureMonitorWindow');

        // Log must contain collapsed-layout-repair + "monitor window missing"
        const runnerLog = f.readRunnerLog();
        assert.match(runnerLog, /collapsed-layout-repair.*monitor window missing/, 'log must tag collapsed-layout-repair with window-missing context');
    } finally {
        f.cleanup();
    }
});

// select-layout must NOT be called when send-keys fails (failed repair)
test('restartDeadWatcherPanes collapsed-layout: select-layout not called when send-keys fails', async () => {
    const f = makeCollapsedFakes({
        sessionName: 'mwcl3-send-fail',
        missingPanes: [2],
        windowMissing: false,
        sendKeysFails: true,
    });
    try {
        await f.withPath(() =>
            restartDeadWatcherPanes(f.sessionDir, f.extRoot, 'pickle', loadRobustSpawnSync),
        );

        const calls = f.readCalls();
        assert.match(calls, /tmux split-window/, 'split-window must still be called');
        assert.doesNotMatch(calls, /tmux select-layout/, 'select-layout must NOT be called after a failed send-keys');
    } finally {
        f.cleanup();
    }
});

// @tier: fast
import { describe as nodeDescribe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync as realSpawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';

// Load-robust spawnSync injection for the real-shim `ensureMonitorWindow` /
// `restartDeadWatcherPanes` tests. The SUT passes hardcoded 5s/10s timeouts to
// every internal tmux/bash spawnSync; under 8-way full-suite concurrency on a
// loaded host even a fast `/bin/sh` shim can starve past 5s, so a kill-window /
// set-option / tmux-monitor.sh call returns non-zero and the result-status or
// calls-log assertions flake. The SUT exposes `spawnSyncFn` as an injectable
// option precisely so tests can control subprocess behaviour — widening the
// per-call timeout here only prevents a spurious SIGKILL of a healthy shim;
// real hang detection is unaffected because every shim exits promptly.
function loadRobustSpawnSync(command, args, opts) {
    return realSpawnSync(command, args, { ...opts, timeout: 60_000 });
}

import {
    ensureMonitorWindow,
    inferMonitorMode,
    monitorModesCompatible,
    restartDeadWatcherPanes,
    watcherPaneCommands,
    _resetExtensionDirFallbackForTests,
} from '../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const describe = Object.assign(
    (name, fn) => nodeDescribe(name, fn),
    {
        each(cases) {
            return (name, fn) => {
                for (const row of cases) {
                    const values = Array.isArray(row) ? row : [row];
                    test(format(name, ...values), () => fn(...values));
                }
            };
        },
    },
);

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

/**
 * Launchers name the tmux session `<prefix>-<session-hash>` for the session dir it
 * manages, and `restartDeadWatcherPanes` refuses any session whose hash is not ours.
 * Fixtures must honor that pairing or they exercise a layout production cannot build.
 */
function sessionDirNameFor(sessionName) {
    return sessionName.slice(sessionName.lastIndexOf('-') + 1);
}

/**
 * Set up a tmpdir with a fake tmux + fake bash so ensureMonitorWindow can be
 * exercised without a real tmux server. The shims record every invocation to
 * `$TMP/calls.log` so assertions can inspect what happened.
 */
function makeFakes(opts) {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-monitor-')));
    const callsLog = path.join(tmpRoot, 'calls.log');
    const shimDir = path.join(tmpRoot, 'bin');
    fs.mkdirSync(shimDir, { recursive: true });

    const sessionName = opts.sessionName || 'pickle-test';

    // Session dir with minimal state.json — inferMonitorMode reads it.
    const sessionDir = path.join(tmpRoot, sessionDirNameFor(sessionName));
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
        path.join(sessionDir, 'state.json'),
        JSON.stringify({ active: true, command_template: opts.commandTemplate || null }),
    );

    // Extension root with a stub tmux-monitor.sh. We don't let the real one
    // run — the fake bash intercepts the shebang-less invocation and just
    // records its argv to the calls log.
    const extRoot = path.join(tmpRoot, 'ext');
    fs.mkdirSync(path.join(extRoot, 'extension', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(extRoot, 'extension', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(extRoot, 'extension', 'bin', 'log-watcher.js'), '// sentinel\n');
    fs.writeFileSync(
        path.join(extRoot, 'extension', 'scripts', 'tmux-monitor.sh'),
        '#!/bin/sh\necho "real script would run" >&2\nexit 0\n',
    );

    // Fake tmux: dispatches on subcommand. `display-message` echoes the
    // session name; `list-windows` echoes either "monitor" or "runner"
    // depending on whether $TMP/.monitor-exists marker is present;
    // `show-option @pickle_monitor_mode` echoes whatever is in
    // $TMP/.monitor-mode (empty = unset); `kill-window` and `set-option`
    // drop a marker so assertions can observe them.
    const fakeTmux = path.join(tmpRoot, 'fake-tmux.sh');
    const pathTmux = path.join(shimDir, 'tmux');
    const markerPath = path.join(tmpRoot, '.monitor-exists');
    const modeMarkerPath = path.join(tmpRoot, '.monitor-mode');
    const killMarkerPath = path.join(tmpRoot, '.monitor-killed');
    const paneCommands = opts.paneCommands || { 0: 'node', 1: 'node', 2: 'node', 3: 'node' };
    for (const pane of [0, 1, 2, 3]) {
        fs.writeFileSync(path.join(tmpRoot, `.pane-${pane}`), paneCommands[pane] || '');
    }
    fs.writeFileSync(
        fakeTmux,
        `#!/bin/sh
echo "tmux $*" >> "${callsLog}"
case "$1" in
  display-message)
    case "$*" in
      *monitor.0*pane_current_command*) cat "${path.join(tmpRoot, '.pane-0')}" ;;
      *monitor.1*pane_current_command*) cat "${path.join(tmpRoot, '.pane-1')}" ;;
      *monitor.2*pane_current_command*) cat "${path.join(tmpRoot, '.pane-2')}" ;;
      *monitor.3*pane_current_command*) cat "${path.join(tmpRoot, '.pane-3')}" ;;
      *) echo "${sessionName}" ;;
    esac
    ;;
  list-windows)
    if [ -f "${markerPath}" ]; then
      echo monitor
    else
      echo runner
    fi
    ;;
  show-option)
    if [ -f "${modeMarkerPath}" ]; then
      cat "${modeMarkerPath}"
    fi
    ;;
  kill-window)
    touch "${killMarkerPath}"
    rm -f "${markerPath}"
    rm -f "${modeMarkerPath}"
    ;;
  set-option)
    # Last arg is the mode value; stamp it so subsequent show-option sees it.
    eval "mode=\\\${$#}"
    printf "%s" "$mode" > "${modeMarkerPath}"
    ;;
esac
exit 0
`,
    );
    fs.chmodSync(fakeTmux, 0o755);
    fs.copyFileSync(fakeTmux, pathTmux);
    fs.chmodSync(pathTmux, 0o755);

    // Fake bash: records invocation, doesn't actually execute the script.
    const fakeBash = path.join(tmpRoot, 'fake-bash.sh');
    fs.writeFileSync(
        fakeBash,
        `#!/bin/sh
echo "bash $*" >> "${callsLog}"
exit 0
`,
    );
    fs.chmodSync(fakeBash, 0o755);

    return {
        tmpRoot,
        sessionDir,
        extRoot,
        callsLog,
        markerPath,
        modeMarkerPath,
        killMarkerPath,
        shimDir,
        tmuxBin: fakeTmux,
        bashBin: fakeBash,
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

function makeWatcherFakes(opts = {}) {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-watcher-pane-')));
    const callsLog = path.join(tmpRoot, 'calls.log');
    const shimDir = path.join(tmpRoot, 'bin');
    fs.mkdirSync(shimDir, { recursive: true });

    const sessionName = opts.sessionName || 'pickle-watch';

    const sessionDir = path.join(tmpRoot, sessionDirNameFor(sessionName));
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
        path.join(sessionDir, 'state.json'),
        JSON.stringify({ active: opts.active ?? true, command_template: opts.commandTemplate || null }),
    );

    const extRoot = path.join(tmpRoot, 'ext');
    fs.mkdirSync(path.join(extRoot, 'extension', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(extRoot, 'extension', 'bin', 'log-watcher.js'), '// sentinel\n');

    const paneCommands = opts.paneCommands || { 0: 'zsh', 1: 'zsh', 2: 'bash', 3: 'fish' };
    const missingPanes = new Set(opts.missingPanes || []);
    for (const pane of [0, 1, 2, 3]) {
        fs.writeFileSync(path.join(tmpRoot, `.pane-${pane}`), paneCommands[pane] || '');
    }

    const fakeTmux = path.join(shimDir, 'tmux');
    fs.writeFileSync(
        fakeTmux,
        `#!/bin/sh
echo "tmux $*" >> "${callsLog}"
if [ "$1" = "display-message" ]; then
  case "$*" in
    *monitor.0*pane_current_command*)
      if [ -f "${path.join(tmpRoot, '.missing-0')}" ]; then
        exit 1
      fi
      cat "${path.join(tmpRoot, '.pane-0')}" ;;
    *monitor.1*pane_current_command*)
      if [ -f "${path.join(tmpRoot, '.missing-1')}" ]; then
        exit 1
      fi
      cat "${path.join(tmpRoot, '.pane-1')}" ;;
    *monitor.2*pane_current_command*)
      if [ -f "${path.join(tmpRoot, '.missing-2')}" ]; then
        exit 1
      fi
      cat "${path.join(tmpRoot, '.pane-2')}" ;;
    *monitor.3*pane_current_command*)
      if [ -f "${path.join(tmpRoot, '.missing-3')}" ]; then
        exit 1
      fi
      cat "${path.join(tmpRoot, '.pane-3')}" ;;
    *) echo "${sessionName}" ;;
  esac
elif [ "$1" = "split-window" ]; then
  target=""
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "-t" ]; then
      target="$arg"
      break
    fi
    prev="$arg"
  done
  case "$target" in
    *monitor.0)
      rm -f "${path.join(tmpRoot, '.missing-1')}" "${path.join(tmpRoot, '.missing-2')}"
      ;;
    *monitor.1)
      rm -f "${path.join(tmpRoot, '.missing-0')}"
      ;;
    *monitor.2)
      rm -f "${path.join(tmpRoot, '.missing-3')}"
      ;;
  esac
fi
exit 0
`,
    );
    fs.chmodSync(fakeTmux, 0o755);

    for (const pane of missingPanes) {
        fs.writeFileSync(path.join(tmpRoot, `.missing-${pane}`), '');
    }

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

function makeInjectedMonitorFakes(opts = {}) {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-monitor-injected-')));
    const sessionName = opts.sessionName || 'pickle-injected';
    const sessionDir = path.join(tmpRoot, sessionDirNameFor(sessionName));
    const extRoot = path.join(tmpRoot, 'ext');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(path.join(extRoot, 'extension', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(extRoot, 'extension', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(extRoot, 'extension', 'bin', 'log-watcher.js'), '// sentinel\n');
    fs.writeFileSync(
        path.join(extRoot, 'extension', 'scripts', 'tmux-monitor.sh'),
        '#!/bin/sh\nexit 0\n',
    );
    fs.writeFileSync(
        path.join(sessionDir, 'state.json'),
        JSON.stringify({ active: opts.active ?? true, command_template: opts.commandTemplate || null }),
    );

    const monitorExists = opts.monitorExists ?? true;
    const monitorMode = opts.monitorMode || opts.mode || 'pickle';
    const paneCommands = opts.paneCommands || { 0: 'node', 1: 'node', 2: 'node', 3: 'node' };
    const calls = [];
    const spawnSyncFn = (command, args = []) => {
        calls.push({ command, args: [...args] });
        if (command !== 'tmux') return { status: 0, stdout: '', stderr: '' };
        if (args[0] === 'display-message' && args[1] === '-p' && args[2] === '#S') {
            return { status: 0, stdout: `${sessionName}\n`, stderr: '' };
        }
        if (args[0] === 'display-message' && args[1] === '-p' && args[2] === '-t') {
            const target = args[3] || '';
            const pane = Number(target.split('.').at(-1));
            return { status: 0, stdout: `${paneCommands[pane] || ''}\n`, stderr: '' };
        }
        if (args[0] === 'list-windows') {
            return { status: 0, stdout: monitorExists ? 'monitor\n' : 'runner\n', stderr: '' };
        }
        if (args[0] === 'show-option') {
            return { status: 0, stdout: `${monitorMode}\n`, stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
    };

    return {
        tmpRoot,
        sessionDir,
        extRoot,
        calls,
        cleanup() {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        },
        readRunnerLog() {
            const logPath = path.join(sessionDir, 'mux-runner.log');
            return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
        },
        spawnSyncFn,
    };
}

function tmuxCalls(f, subcommand) {
    return f.calls.filter(call => call.command === 'tmux' && call.args[0] === subcommand);
}

test('ensureMonitorWindow: skipped when not inside tmux', () => {
    const f = makeFakes({});
    try {
        const result = ensureMonitorWindow({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            inTmux: false,
            tmuxBin: f.tmuxBin,
            bashBin: f.bashBin,
            spawnSyncFn: loadRobustSpawnSync,
        });
        assert.equal(result.status, 'skipped');
        assert.equal(f.readCalls(), '', 'should not invoke tmux or bash when skipped');
    } finally {
        f.cleanup();
    }
});

test('ensureMonitorWindow: creates monitor when window does not exist', () => {
    const f = makeFakes({ sessionName: 'pickle-abc12345' });
    try {
        const result = ensureMonitorWindow({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            inTmux: true,
            tmuxBin: f.tmuxBin,
            bashBin: f.bashBin,
            spawnSyncFn: loadRobustSpawnSync,
        });
        assert.equal(result.status, 'created');
        const calls = f.readCalls();
        assert.match(calls, /tmux display-message/);
        assert.match(calls, /tmux list-windows -t pickle-abc12345/);
        // bash invocation carries the script path, session name, session dir, mode
        assert.match(calls, /bash .+tmux-monitor\.sh pickle-abc12345 .+abc12345 pickle/);
    } finally {
        f.cleanup();
    }
});

test('ensureMonitorWindow: existing monitor respawns dead monitor and watcher panes with injected spawn capture', () => {
    const cases = [
        {
            mode: 'pickle',
            commandTemplate: null,
            pane2: /monitor\.2.*node .+morty-watcher\.js .+/,
        },
        {
            mode: 'refinement',
            commandTemplate: null,
            pane2: /monitor\.2.*node .+refinement-watcher\.js .+/,
        },
        {
            mode: undefined,
            monitorMode: 'council',
            commandTemplate: 'council-of-ricks.md',
            pane2: /monitor\.2.*tail -F .+\/mux-runner\.log/,
        },
    ];

    for (const { mode, monitorMode, commandTemplate, pane2 } of cases) {
        const f = makeInjectedMonitorFakes({
            sessionName: `${monitorMode || mode}-dead`,
            mode,
            monitorMode,
            commandTemplate,
            paneCommands: { 0: 'zsh', 1: 'zsh', 2: 'bash', 3: 'fish' },
        });
        try {
            const result = ensureMonitorWindow({
                sessionDir: f.sessionDir,
                extensionRoot: f.extRoot,
                inTmux: true,
                mode,
                spawnSyncFn: f.spawnSyncFn,
            });

            assert.equal(result.status, 'exists');
            const sendKeys = tmuxCalls(f, 'send-keys');
            assert.equal(sendKeys.length, 4);
            assert.match(sendKeys[0].args.join(' '), /monitor\.0.*node .+monitor\.js .+/);
            assert.match(sendKeys[1].args.join(' '), /monitor\.1.*node .+log-watcher\.js .+/);
            assert.match(sendKeys[2].args.join(' '), pane2);
            assert.match(sendKeys[3].args.join(' '), /monitor\.3.*node .+raw-morty\.js .+/);
            assert.equal(tmuxCalls(f, 'display-message').filter(call => call.args.includes('#{pane_current_command}')).length, 4);
            assert.doesNotMatch(f.readRunnerLog(), /failed to respawn/);
        } finally {
            f.cleanup();
        }
    }
});

test('ensureMonitorWindow: stale EXTENSION_DIR falls back before watcher pane respawn', () => {
    const f = makeInjectedMonitorFakes({
        sessionName: 'pickle-fallback',
        paneCommands: { 0: 'node', 1: 'zsh', 2: 'node', 3: 'node' },
    });
    const invalidRoot = path.join(f.tmpRoot, 'deleted-ext');
    const dataRoot = path.join(f.tmpRoot, 'data');
    const savedExt = process.env.EXTENSION_DIR;
    const savedData = process.env.PICKLE_DATA_ROOT;
    const savedAllow = process.env.EXTENSION_DIR_TEST;
    const savedWrite = process.stderr.write;
    try {
        process.env.EXTENSION_DIR = invalidRoot;
        process.env.PICKLE_DATA_ROOT = dataRoot;
        delete process.env.EXTENSION_DIR_TEST;
        process.stderr.write = () => true;
        _resetExtensionDirFallbackForTests();

        const result = ensureMonitorWindow({
            sessionDir: f.sessionDir,
            inTmux: true,
            spawnSyncFn: f.spawnSyncFn,
        });

        assert.equal(result.status, 'exists');
        const sendKeys = tmuxCalls(f, 'send-keys');
        assert.equal(sendKeys.length, 1);
        assert.match(
            sendKeys[0].args.join(' '),
            /monitor\.1.*node .+\.claude\/pickle-rick\/extension\/bin\/log-watcher\.js .+/,
        );
        assert.doesNotMatch(sendKeys[0].args.join(' '), /deleted-ext/);
    } finally {
        process.stderr.write = savedWrite;
        if (savedExt === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = savedExt;
        if (savedData === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = savedData;
        if (savedAllow === undefined) delete process.env.EXTENSION_DIR_TEST;
        else process.env.EXTENSION_DIR_TEST = savedAllow;
        _resetExtensionDirFallbackForTests();
        f.cleanup();
    }
});

test('ensureMonitorWindow: existing monitor with all monitor panes alive is a no-op', () => {
    const f = makeInjectedMonitorFakes({
        sessionName: 'pickle-alive',
        paneCommands: { 0: 'node', 1: 'node', 2: 'node', 3: 'node' },
    });
    try {
        const result = ensureMonitorWindow({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            inTmux: true,
            spawnSyncFn: f.spawnSyncFn,
        });

        assert.equal(result.status, 'exists');
        assert.equal(tmuxCalls(f, 'send-keys').length, 0);
        assert.equal(tmuxCalls(f, 'display-message').filter(call => call.args.includes('#{pane_current_command}')).length, 4);
        assert.equal(f.readRunnerLog(), '');
    } finally {
        f.cleanup();
    }
});

test('ensureMonitorWindow: inactive existing monitor skips watcher respawn', () => {
    const f = makeInjectedMonitorFakes({
        active: false,
        sessionName: 'pickle-inactive',
        paneCommands: { 0: 'zsh', 1: 'zsh', 2: 'bash', 3: 'fish' },
    });
    try {
        const result = ensureMonitorWindow({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            inTmux: true,
            spawnSyncFn: f.spawnSyncFn,
        });

        assert.equal(result.status, 'exists');
        assert.equal(tmuxCalls(f, 'send-keys').length, 0);
        assert.equal(tmuxCalls(f, 'display-message').filter(call => call.args.includes('#{pane_current_command}')).length, 0);
        assert.equal(f.readRunnerLog(), '');
    } finally {
        f.cleanup();
    }
});

test('ensureMonitorWindow: existing monitor window runs exactly one pane-recovery sweep', async () => {
    const f = makeFakes({
        sessionName: 'pickle-abc12345',
        paneCommands: { 0: 'node', 1: 'zsh', 2: 'node', 3: 'bash' },
    });
    // Simulate existing monitor window stamped with the same mode we'll infer.
    fs.writeFileSync(f.markerPath, '1');
    fs.writeFileSync(f.modeMarkerPath, 'pickle');
    try {
        let result;
        await f.withPath(() => {
            result = ensureMonitorWindow({
                sessionDir: f.sessionDir,
                extensionRoot: f.extRoot,
                inTmux: true,
                tmuxBin: f.tmuxBin,
                bashBin: f.bashBin,
                spawnSyncFn: loadRobustSpawnSync,
            });
        });
        assert.equal(result.status, 'exists');
        const calls = f.readCalls();
        assert.match(calls, /tmux list-windows/);
        assert.match(calls, /tmux show-option/, 'should read stamped mode');
        assert.match(calls, /tmux display-message -p -t pickle-abc12345:monitor\.0 #\{pane_current_command\}/);
        assert.match(calls, /tmux display-message -p -t pickle-abc12345:monitor\.1 #\{pane_current_command\}/);
        assert.match(calls, /tmux display-message -p -t pickle-abc12345:monitor\.2 #\{pane_current_command\}/);
        assert.match(calls, /tmux display-message -p -t pickle-abc12345:monitor\.3 #\{pane_current_command\}/);
        assert.match(calls, /tmux send-keys -t pickle-abc12345:monitor\.1 .+log-watcher\.js .+ Enter/);
        assert.match(calls, /tmux send-keys -t pickle-abc12345:monitor\.3 .+raw-morty\.js .+ Enter/);
        assert.equal((calls.match(/tmux send-keys/g) || []).length, 2, 'should respawn each dead pane once');
        assert.doesNotMatch(calls, /tmux kill-window/, 'should not kill a compatible window');
        assert.doesNotMatch(calls, /bash .+tmux-monitor\.sh/, 'should not spawn script when monitor exists');
        assert.match(f.readRunnerLog(), /restartDeadWatcherPanes: respawned log-watcher\.js in pane 1/);
        assert.match(f.readRunnerLog(), /restartDeadWatcherPanes: respawned raw-morty\.js in pane 3/);
    } finally {
        f.cleanup();
    }
});

test('ensureMonitorWindow: phase re-entry performs a fresh recovery sweep with mode-specific pane 2', async () => {
    const cases = [
        ['pickle', 'pickle.md', /tmux send-keys -t pickle-phase:monitor\.2 .+morty-watcher\.js .+ Enter/],
        ['refinement', null, /tmux send-keys -t refinement-phase:monitor\.2 .+refinement-watcher\.js .+ Enter/],
        ['council', 'council-of-ricks.md', /tmux send-keys -t council-phase:monitor\.2 .+tail -F .+\/mux-runner\.log.* Enter/],
    ];

    const outer = makeFakes({ sessionName: 'outer-phase' });
    const inner = makeFakes({ sessionName: 'inner-phase' });
    const initialPath = process.env.PATH;
    let releaseOuter;
    let innerEntered = false;
    let innerPath;
    let resolveOuterReady;
    const outerReady = new Promise(resolve => {
        resolveOuterReady = resolve;
    });
    try {
        const outerRun = outer.withPath(async () => {
            resolveOuterReady();
            await new Promise(resolve => {
                releaseOuter = resolve;
            });
        });
        await outerReady;

        const innerRun = inner.withPath(async () => {
            innerEntered = true;
            innerPath = process.env.PATH;
        });

        assert.equal(innerEntered, false);
        assert.ok(process.env.PATH.startsWith(`${outer.shimDir}${path.delimiter}`));

        releaseOuter();
        await outerRun;
        await innerRun;

        assert.equal(innerEntered, true);
        assert.ok(innerPath.startsWith(`${inner.shimDir}${path.delimiter}`));
        assert.equal(process.env.PATH, initialPath);
    } finally {
        outer.cleanup();
        inner.cleanup();
    }

    for (const [mode, commandTemplate, paneTwoPattern] of cases) {
        const f = makeFakes({
            sessionName: `${mode}-phase`,
            commandTemplate,
            paneCommands: { 0: 'node', 1: 'node', 2: 'zsh', 3: 'node' },
        });
        fs.writeFileSync(f.markerPath, '1');
        fs.writeFileSync(f.modeMarkerPath, mode);
        try {
            let result;
            await f.withPath(() => {
                result = ensureMonitorWindow({
                    sessionDir: f.sessionDir,
                    extensionRoot: f.extRoot,
                    inTmux: true,
                    tmuxBin: f.tmuxBin,
                    bashBin: f.bashBin,
                    spawnSyncFn: loadRobustSpawnSync,
                    mode,
                });
            });
            assert.equal(result.status, 'exists');
            const calls = f.readCalls();
            assert.match(calls, paneTwoPattern);
            assert.equal((calls.match(/tmux display-message -p -t/g) || []).length, 4);
            assert.equal((calls.match(/tmux send-keys/g) || []).length, 1);
            assert.doesNotMatch(calls, /bash .+tmux-monitor\.sh/);
        } finally {
            f.cleanup();
        }
    }
});

test('ensureMonitorWindow: same-mode refinement monitor respawns only refinement watcher pane', async () => {
    const f = makeFakes({
        sessionName: 'refinement-same-mode',
        paneCommands: { 0: 'node', 1: 'node', 2: 'zsh', 3: 'node' },
    });
    fs.writeFileSync(f.markerPath, '1');
    fs.writeFileSync(f.modeMarkerPath, 'refinement');
    try {
        let result;
        await f.withPath(() => {
            result = ensureMonitorWindow({
                sessionDir: f.sessionDir,
                extensionRoot: f.extRoot,
                inTmux: true,
                tmuxBin: f.tmuxBin,
                bashBin: f.bashBin,
                spawnSyncFn: loadRobustSpawnSync,
                mode: 'refinement',
            });
        });

        assert.equal(result.status, 'exists');
        const calls = f.readCalls();
        assert.equal((calls.match(/tmux send-keys/g) || []).length, 1);
        assert.match(
            calls,
            /tmux send-keys -t refinement-same-mode:monitor\.2 .+refinement-watcher\.js .+ Enter/,
        );
        assert.doesNotMatch(calls, /morty-watcher\.js/);
        assert.doesNotMatch(calls, /tail -F .+mux-runner\.log/);
        assert.doesNotMatch(calls, /tmux kill-window/);
        assert.doesNotMatch(calls, /bash .+tmux-monitor\.sh/);
    } finally {
        f.cleanup();
    }
});

test('ensureMonitorWindow: runner call sites remain limited to pipeline, mux, and microverse', () => {
    const files = [
        path.resolve(__dirname, '../src/bin/pipeline-runner.ts'),
        path.resolve(__dirname, '../src/bin/mux-runner.ts'),
        path.resolve(__dirname, '../src/bin/microverse-runner.ts'),
    ];
    const counts = files.map(file => {
        const source = fs.readFileSync(file, 'utf-8');
        return (source.match(/ensureMonitorWindow\(\{/g) || []).length;
    });

    assert.deepEqual(counts, [1, 1, 1]);
});

test('extension root trap-door: production script resolution does not read process.env.EXTENSION_DIR outside helper', () => {
    const srcRoot = path.resolve(__dirname, '../src');
    const allowed = new Set([
        path.join(srcRoot, 'services', 'pickle-utils.ts'),
        path.join(srcRoot, 'hooks', 'dispatch.ts'),
    ]);
    const offenders = [];
    const scan = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                scan(fullPath);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
            if (allowed.has(fullPath)) continue;
            const source = fs.readFileSync(fullPath, 'utf-8');
            if (source.includes('process.env.EXTENSION_DIR')) offenders.push(path.relative(srcRoot, fullPath));
        }
    };

    scan(srcRoot);
    assert.deepEqual(offenders, []);
});

test('restartDeadWatcherPanes: respawns dead pickle monitor and watcher panes 0, 1, 2, and 3', async () => {
    const f = makeWatcherFakes({ sessionName: 'pickle-dead', paneCommands: { 0: 'zsh', 1: 'zsh', 2: 'bash', 3: 'fish' } });
    try {
        await f.withPath(() => restartDeadWatcherPanes(f.sessionDir, f.extRoot, 'pickle', loadRobustSpawnSync));

        const calls = f.readCalls();
        assert.match(calls, /tmux display-message -p #S/);
        assert.match(calls, /tmux display-message -p -t pickle-dead:monitor\.0 #\{pane_current_command\}/);
        assert.match(calls, /tmux send-keys -t pickle-dead:monitor\.0 .+monitor\.js .+ Enter/);
        assert.match(calls, /tmux display-message -p -t pickle-dead:monitor\.1 #\{pane_current_command\}/);
        assert.match(calls, /tmux send-keys -t pickle-dead:monitor\.1 .+log-watcher\.js .+ Enter/);
        assert.match(calls, /tmux send-keys -t pickle-dead:monitor\.2 .+morty-watcher\.js .+ Enter/);
        assert.match(calls, /tmux send-keys -t pickle-dead:monitor\.3 .+raw-morty\.js .+ Enter/);
        assert.match(f.readRunnerLog(), /restartDeadWatcherPanes: respawned monitor\.js in pane 0/);
        assert.match(f.readRunnerLog(), /restartDeadWatcherPanes: respawned log-watcher\.js in pane 1/);
        assert.match(f.readRunnerLog(), /restartDeadWatcherPanes: respawned morty-watcher\.js in pane 2/);
        assert.match(f.readRunnerLog(), /restartDeadWatcherPanes: respawned raw-morty\.js in pane 3/);
    } finally {
        f.cleanup();
    }
});

test('restartDeadWatcherPanes: all monitor panes already running node is a no-op', async () => {
    const f = makeWatcherFakes({ paneCommands: { 0: 'node', 1: 'node', 2: 'node', 3: 'node' } });
    try {
        await f.withPath(() => restartDeadWatcherPanes(f.sessionDir, f.extRoot, 'pickle', loadRobustSpawnSync));

        const calls = f.readCalls();
        assert.match(calls, /tmux display-message -p -t pickle-watch:monitor\.0 #\{pane_current_command\}/);
        assert.match(calls, /tmux display-message -p -t pickle-watch:monitor\.1 #\{pane_current_command\}/);
        assert.doesNotMatch(calls, /tmux send-keys/);
        assert.equal(f.readRunnerLog(), '');
    } finally {
        f.cleanup();
    }
});

test('restartDeadWatcherPanes: inactive session skips pane probing and respawn', async () => {
    const f = makeWatcherFakes({ active: false, paneCommands: { 0: 'zsh', 1: 'zsh', 2: 'bash', 3: 'fish' } });
    try {
        await f.withPath(() => restartDeadWatcherPanes(f.sessionDir, f.extRoot, 'pickle', loadRobustSpawnSync));

        assert.equal(f.readCalls(), '');
        assert.equal(f.readRunnerLog(), '');
    } finally {
        f.cleanup();
    }
});

test('restartDeadWatcherPanes: non-node long-running command is treated as dead and logged as warn', async () => {
    const f = makeWatcherFakes({ paneCommands: { 0: 'node', 1: 'node', 2: 'vim', 3: 'node' } });
    try {
        await f.withPath(() => restartDeadWatcherPanes(f.sessionDir, f.extRoot, 'pickle', loadRobustSpawnSync));

        const calls = f.readCalls();
        assert.match(calls, /tmux send-keys -t pickle-watch:monitor\.2 .+morty-watcher\.js .+ Enter/);
        assert.doesNotMatch(calls, /tmux send-keys -t pickle-watch:monitor\.1/);
        assert.doesNotMatch(calls, /tmux send-keys -t pickle-watch:monitor\.3/);
        assert.match(f.readRunnerLog(), /restartDeadWatcherPanes WARN: pane 2 command 'vim' is not node/);
    } finally {
        f.cleanup();
    }
});

test('restartDeadWatcherPanes: mode-specific pane 2 command uses refinement and mux log tail modes', async () => {
    const cases = [
        ['refinement', /tmux send-keys -t refinement-watch:monitor\.2 .+refinement-watcher\.js .+ Enter/],
        ['council', /tmux send-keys -t council-watch:monitor\.2 .+tail -F .+\/mux-runner\.log.* Enter/],
    ];

    for (const [mode, paneTwoPattern] of cases) {
        const f = makeWatcherFakes({
            sessionName: `${mode}-watch`,
            paneCommands: { 0: 'node', 1: 'node', 2: 'zsh', 3: 'node' },
        });
        try {
            await f.withPath(() => restartDeadWatcherPanes(f.sessionDir, f.extRoot, mode, loadRobustSpawnSync));
            const calls = f.readCalls();
            assert.match(calls, paneTwoPattern);
            assert.doesNotMatch(calls, /refine-watcher/);
        } finally {
            f.cleanup();
        }
    }
});

test('restartDeadWatcherPanes: missing pane recreates collapsed layout via split-window fallback', async () => {
    const f = makeWatcherFakes({
        sessionName: 'pickle-collapsed',
        paneCommands: { 0: 'node', 1: 'node', 2: 'bash', 3: 'fish' },
        missingPanes: [2, 3],
    });
    try {
        await f.withPath(() => restartDeadWatcherPanes(f.sessionDir, f.extRoot, 'pickle', loadRobustSpawnSync));

        const calls = f.readCalls();
        assert.match(calls, /tmux split-window -v -l 40% -t pickle-collapsed:monitor\.0/);
        assert.match(calls, /tmux send-keys -t pickle-collapsed:monitor\.2 .+morty-watcher\.js .+ Enter/);
        assert.match(calls, /tmux split-window -h -t pickle-collapsed:monitor\.2/);
        assert.match(calls, /tmux send-keys -t pickle-collapsed:monitor\.3 .+raw-morty\.js .+ Enter/);
        assert.match(f.readRunnerLog(), /restartDeadWatcherPanes WARN: pane 2 missing; recreated via pickle-collapsed:monitor\.0/);
        assert.match(f.readRunnerLog(), /restartDeadWatcherPanes WARN: pane 3 missing; recreated via pickle-collapsed:monitor\.2/);
    } finally {
        f.cleanup();
    }
});

// AP-EXT-ITER87-01. The health predicate used to be a hardcoded `'node'`
// literal, decoupled from the command the respawn path actually launches. Two
// healthy shapes reported something else and were flagged dead forever:
//   - council's pane 2 runs `tail -F`, so it reports `tail`;
//   - every wrapped respawn ran `bash -c 'CMD 2>>log'`, where bash FORKS and
//     stays the pane's foreground process, so tmux reports `bash`.
// Every pre-existing fixture in this file used `node` for healthy and a shell
// name for dead, so neither shape was ever presented and the defect stayed
// green for the function's whole life.
test('restartDeadWatcherPanes: council pane 2 running tail -F is healthy, not dead', async () => {
    const f = makeWatcherFakes({
        sessionName: 'council-tail',
        paneCommands: { 0: 'node', 1: 'node', 2: 'tail', 3: 'node' },
    });
    try {
        await f.withPath(() => restartDeadWatcherPanes(f.sessionDir, f.extRoot, 'council', loadRobustSpawnSync));

        const calls = f.readCalls();
        assert.doesNotMatch(
            calls,
            /tmux send-keys -t council-tail:monitor\.2/,
            'a live `tail -F` pane must not be respawned',
        );
        assert.doesNotMatch(f.readRunnerLog(), /pane 2 command 'tail' is not/);
        // Negative control: the OTHER panes of the same window still expect
        // `node`, so the fix is not "accept anything".
        assert.doesNotMatch(calls, /tmux send-keys -t council-tail:monitor\.0/);
        assert.doesNotMatch(calls, /tmux send-keys -t council-tail:monitor\.3/);
    } finally {
        f.cleanup();
    }
});

test('restartDeadWatcherPanes: council pane 2 fallen back to a shell is still dead', async () => {
    const f = makeWatcherFakes({
        sessionName: 'council-dead',
        paneCommands: { 0: 'node', 1: 'node', 2: 'zsh', 3: 'node' },
    });
    try {
        await f.withPath(() => restartDeadWatcherPanes(f.sessionDir, f.extRoot, 'council', loadRobustSpawnSync));

        assert.match(
            f.readCalls(),
            /tmux send-keys -t council-dead:monitor\.2 .+tail -F .+\/mux-runner\.log.* Enter/,
        );
        assert.match(f.readRunnerLog(), /pane 2 command 'zsh' is not tail/);
    } finally {
        f.cleanup();
    }
});

describe.each([
    ['pickle'],
    ['council'],
    ['refinement'],
    ['szechuan-sauce'],
    ['anatomy-park'],
])('watcherPaneCommands pane-command/health-predicate contract: mode=%s', (mode) => {
    test('every pane execs its program, and `process` is that program', () => {
        const panes = watcherPaneCommands('/tmp/session-xyz', '/deploy/root', mode);
        assert.equal(panes.length, 4);
        for (const { pane, command, process: expectedProcess } of panes) {
            // The wrapper MUST `exec`, or bash stays the foreground process and
            // `#{pane_current_command}` reports `bash` for a healthy pane.
            const execPrefix = `bash -c 'exec `;
            assert.ok(command.startsWith(execPrefix), `pane ${pane} does not exec its program: ${command}`);
            const launchedProgram = command.slice(execPrefix.length).split(' ')[0];
            assert.equal(
                path.basename(launchedProgram),
                expectedProcess,
                `pane ${pane}: launched program and health expectation disagree`,
            );
            assert.ok(expectedProcess && !expectedProcess.includes('/'), `pane ${pane}: process must be a bare program name`);
        }
    });

    test('pane 2 health expectation tracks the mode-specific program', () => {
        const paneTwo = watcherPaneCommands('/tmp/session-xyz', '/deploy/root', mode).find(c => c.pane === 2);
        assert.equal(paneTwo.process, mode === 'council' ? 'tail' : 'node');
    });
});

test('restartDeadWatcherPanes: trap-door entry documents T3 regressions and size cap', () => {
    const claudeMd = fs.readFileSync(path.resolve(__dirname, '../CLAUDE.md'), 'utf-8');
    // Filter to the CANONICAL pane-recovery invariant by its exact scope tag.
    // Sibling entries reuse the same file/function (R-MWR-* logTag, R-MMRT-*
    // sessionDir validation, etc.) but each uses a distinct parenthetical tag,
    // so anchoring on `(restartDeadWatcherPanes)` keeps this match precise.
    const entries = claudeMd
        .split('\n')
        .filter(line => line.includes('`src/services/pickle-utils.ts` (restartDeadWatcherPanes)'));

    assert.equal(entries.length, 1, `expected 1 canonical pane-recovery entry, got: ${JSON.stringify(entries)}`);
    const [entry] = entries;
    assert.ok(entry.length <= 1500, `trap-door entry is ${entry.length} chars`);
    assert.match(entry, /INVARIANT:/);
    assert.match(
        entry,
        /BREAKS: monitor window has stale monitor or watcher panes for the rest of the pipeline lifetime; user has to manually relaunch each pane\./,
    );
    assert.match(entry, /ENFORCE:/);
    assert.match(entry, /restartDeadWatcherPanes: respawns dead pickle monitor and watcher panes 0, 1, 2, and 3/);
    assert.match(entry, /restartDeadWatcherPanes: all monitor panes already running node is a no-op/);
    assert.match(entry, /restartDeadWatcherPanes: inactive session skips pane probing and respawn/);
});

test('ensureMonitorWindow: kills and recreates when existing window has different @mode', async () => {
    const f = makeFakes({ sessionName: 'pickle-abc12345', commandTemplate: 'council-of-ricks.md' });
    // Simulate an existing monitor window stamped for a different mode
    // (e.g. a previous anatomy-park / pickle pipeline phase).
    fs.writeFileSync(f.markerPath, '1');
    fs.writeFileSync(f.modeMarkerPath, 'pickle');
    try {
        let result;
        await f.withPath(() => {
            result = ensureMonitorWindow({
                sessionDir: f.sessionDir,
                extensionRoot: f.extRoot,
                inTmux: true,
                tmuxBin: f.tmuxBin,
                bashBin: f.bashBin,
                spawnSyncFn: loadRobustSpawnSync,
            });
        });
        assert.equal(result.status, 'recreated');
        const calls = f.readCalls();
        assert.match(calls, /tmux list-windows/);
        assert.match(calls, /tmux show-option -w -qv -t pickle-abc12345:monitor @pickle_monitor_mode/);
        assert.match(calls, /tmux kill-window -t pickle-abc12345:monitor/, 'should kill stale window');
        assert.match(calls, /bash .+tmux-monitor\.sh pickle-abc12345 .+ council/, 'should respawn in council mode');
        assert.match(calls, /tmux set-option -w -t pickle-abc12345:monitor @pickle_monitor_mode council/, 'should stamp new mode');
        assert.ok(fs.existsSync(f.killMarkerPath), 'kill-window must have fired');
    } finally {
        f.cleanup();
    }
});

test('monitorModesCompatible: unset existing => incompatible; matching => compatible', () => {
    assert.equal(monitorModesCompatible(null, 'council'), false);
    assert.equal(monitorModesCompatible('', 'council'), false);
    assert.equal(monitorModesCompatible('pickle', 'council'), false);
    assert.equal(monitorModesCompatible('council', 'council'), true);
    assert.equal(monitorModesCompatible('refinement', 'refinement'), true);
});

test('monitorModesCompatible: every MonitorMode member matches only itself', () => {
    const modes = ['pickle', 'council', 'refinement', 'szechuan-sauce', 'anatomy-park'];
    for (const mode of modes) {
        assert.equal(monitorModesCompatible(mode, mode), true, `expected ${mode} to match itself`);
        assert.equal(
            monitorModesCompatible(mode === 'pickle' ? 'council' : 'pickle', mode),
            false,
            `expected ${mode} to reject a different existing mode`,
        );
    }
});

test('ensureMonitorWindow: infers council mode from state.command_template glob', async () => {
    const f = makeFakes({ sessionName: 'council-glob-abc', commandTemplate: 'council-of-ricks.md' });
    try {
        let result;
        await f.withPath(() => {
            result = ensureMonitorWindow({
                sessionDir: f.sessionDir,
                extensionRoot: f.extRoot,
                inTmux: true,
                tmuxBin: f.tmuxBin,
                bashBin: f.bashBin,
                spawnSyncFn: loadRobustSpawnSync,
            });
        });
        assert.equal(result.status, 'created');
        assert.match(f.readCalls(), /tmux-monitor\.sh council-glob-abc .+ council/);
    } finally {
        f.cleanup();
    }
});

test('ensureMonitorWindow: infers council mode from state.command_template', async () => {
    const f = makeFakes({ sessionName: 'council-abc', commandTemplate: 'council-of-ricks.md' });
    try {
        let result;
        await f.withPath(() => {
            result = ensureMonitorWindow({
                sessionDir: f.sessionDir,
                extensionRoot: f.extRoot,
                inTmux: true,
                tmuxBin: f.tmuxBin,
                bashBin: f.bashBin,
                spawnSyncFn: loadRobustSpawnSync,
            });
        });
        assert.equal(result.status, 'created');
        assert.match(f.readCalls(), /tmux-monitor\.sh council-abc .+ council/);
    } finally {
        f.cleanup();
    }
});

test('ensureMonitorWindow: explicit mode overrides state-inferred mode', async () => {
    const f = makeFakes({ sessionName: 'pickle-abc', commandTemplate: 'szechuan-sauce.md' });
    try {
        let result;
        await f.withPath(() => {
            result = ensureMonitorWindow({
                sessionDir: f.sessionDir,
                extensionRoot: f.extRoot,
                inTmux: true,
                tmuxBin: f.tmuxBin,
                bashBin: f.bashBin,
                spawnSyncFn: loadRobustSpawnSync,
                mode: 'refinement',
            });
        });
        assert.equal(result.status, 'created');
        assert.match(f.readCalls(), /tmux-monitor\.sh pickle-abc .+ refinement/);
    } finally {
        f.cleanup();
    }
});

test('ensureMonitorWindow: returns error when tmux-monitor.sh is missing', async () => {
    const f = makeFakes({});
    // Delete the stub script to simulate a broken install.
    fs.rmSync(path.join(f.extRoot, 'extension', 'scripts', 'tmux-monitor.sh'));
    try {
        let result;
        await f.withPath(() => {
            result = ensureMonitorWindow({
                sessionDir: f.sessionDir,
                extensionRoot: f.extRoot,
                inTmux: true,
                tmuxBin: f.tmuxBin,
                bashBin: f.bashBin,
                spawnSyncFn: loadRobustSpawnSync,
            });
        });
        assert.equal(result.status, 'error');
        assert.match(result.reason, /script missing/);
    } finally {
        f.cleanup();
    }
});

test('inferMonitorMode: defaults to pickle when state.json missing', () => {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mode-')));
    try {
        assert.equal(inferMonitorMode(tmpRoot), 'pickle');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

describe.each([
    ['szechuan-sauce.md', 'szechuan-sauce'],
    ['anatomy-park.md', 'anatomy-park'],
    ['meeseeks.md', 'pickle'],
    ['council-of-ricks.md', 'council'],
    ['refinement.md', 'refinement'],
    [undefined, 'pickle'],
    ['unknown-template.md', 'pickle'],
])('inferMonitorMode template %s => %s', (template, expected) => {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mode-')));
    try {
        const state = template === undefined ? {} : { command_template: template };
        fs.writeFileSync(path.join(tmpRoot, 'state.json'), JSON.stringify(state));
        assert.equal(inferMonitorMode(tmpRoot), expected);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('inferMonitorMode: recovers orphan tmp state before reading command_template', () => {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mode-')));
    try {
        const statePath = path.join(tmpRoot, 'state.json');
        const baseFields = {
            working_dir: tmpRoot,
            original_prompt: 'orphan tmp recovery',
            started_at: '2026-05-12T00:00:00.000Z',
            session_dir: tmpRoot,
            step: 'implement',
            max_iterations: 50,
            max_time_minutes: 0,
            worker_timeout_seconds: 1200,
            start_time_epoch: 1778600000,
            history: [],
            completion_promise: null,
        };
        fs.writeFileSync(
            statePath,
            JSON.stringify({ ...baseFields, command_template: 'pickle.md', iteration: 1, schema_version: 1 }),
        );
        fs.writeFileSync(
            `${statePath}.tmp.99999999`,
            JSON.stringify({ ...baseFields, command_template: 'szechuan-sauce.md', iteration: 2, schema_version: 1 }),
        );

        assert.equal(inferMonitorMode(tmpRoot), 'szechuan-sauce');
        const promoted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(promoted.command_template, 'szechuan-sauce.md');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

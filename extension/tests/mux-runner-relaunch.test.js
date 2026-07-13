// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_RUNNER_BIN = path.resolve(__dirname, '../bin/mux-runner.js');

function makeTmpRoot() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mux-relaunch-')));
}

function writeJson(file, value) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

async function waitForFileText(file, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const text = fs.readFileSync(file, 'utf-8');
            if (text.trim().length > 0) return text;
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                throw error;
            }
        }
        // Race-Class: fake-tmux-write-vs-read-timing. The fake tmux pane probe
        // returns before its delayed log write lands, so this test needs a
        // bounded existence/content barrier instead of a fixed "wait long enough".
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for non-empty file: ${file}`);
}

function buildSession(tmpRoot) {
    const extDir = path.join(tmpRoot, 'ext');
    fs.mkdirSync(path.join(extDir, 'extension', 'bin'), { recursive: true });

    // Session dir carries the hash the fake tmux `#S` advertises (`pickle-relaunch`) —
    // restartDeadWatcherPanes refuses any tmux session whose hash is not ours.
    const sessionDir = path.join(tmpRoot, 'relaunch');
    fs.mkdirSync(sessionDir, { recursive: true });

    writeJson(path.join(sessionDir, 'state.json'), {
        active: false,
        exit_reason: 'fatal',
        tmux_mode: true,
        working_dir: tmpRoot,
        step: 'implement',
        iteration: 1,
        max_iterations: 100,
        max_time_minutes: 1,
        worker_timeout_seconds: 1200,
        // Far enough in the past that the wall-clock guard fires on the first
        // loop pass, producing a clean exit_reason='limit' exit (code 0) so
        // this test exercises the relaunch-ownership-before-monitor invariant
        // without colliding with the iteration_cap_exhausted exit (code 3).
        start_time_epoch: Math.floor(Date.now() / 1000) - 7200,
        completion_promise: null,
        original_prompt: 'relaunch ordering test',
        current_ticket: null,
        history: [],
        started_at: new Date().toISOString(),
        session_dir: sessionDir,
    });

    const shimDir = path.join(tmpRoot, 'bin');
    fs.mkdirSync(shimDir, { recursive: true });
    const callsLog = path.join(tmpRoot, 'tmux-calls.log');
    const observedStateLog = path.join(tmpRoot, 'observed-state.log');
    const fakeTmux = path.join(shimDir, 'tmux');
    // Race-Class: fake-tmux-write-vs-read-timing. Delay the append so the
    // test still covers the ENOENT window between pane probing and
    // observed-state.log creation; runnerLog/finalState assertions below keep
    // the relaunch ordering and terminal teardown checks anchored separately.
    fs.writeFileSync(
        fakeTmux,
        `#!/bin/sh
echo "tmux $*" >> "${callsLog}"
case "$1" in
  display-message)
    case "$*" in
      *pane_current_command*)
        node -e "const fs=require('fs'); const payload=JSON.stringify({active:true, exit_reason:null}) + '\\n'; setTimeout(() => fs.appendFileSync(process.argv[1], payload), 100);" "${observedStateLog}" >/dev/null 2>&1 &
        echo zsh
        ;;
      *)
        echo pickle-relaunch
        ;;
    esac
    ;;
  list-windows)
    echo monitor
    ;;
  show-option)
    echo pickle
    ;;
  send-keys)
    ;;
esac
exit 0
`,
    );
    fs.chmodSync(fakeTmux, 0o755);

    return { extDir, sessionDir, shimDir, observedStateLog };
}

test('mux-runner relaunch claims ownership before monitor recovery sees session state', async () => {
    const tmpRoot = makeTmpRoot();
    try {
        const { extDir, sessionDir, shimDir, observedStateLog } = buildSession(tmpRoot);

        const result = spawnSync(process.execPath, [MUX_RUNNER_BIN, sessionDir], {
            env: {
                ...process.env,
                EXTENSION_DIR: extDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
                TMUX: '/tmp/tmux-1/default,1,0',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });
        const output = `${result.stderr ?? ''}${result.stdout ?? ''}`;
        assert.equal(result.status, 0, `Expected clean loop-ceiling exit. Output:\n${output}`);

        const runnerLog = fs.readFileSync(path.join(sessionDir, 'mux-runner.log'), 'utf-8');
        const ownershipIndex = runnerLog.indexOf('Session ownership taken');
        const monitorIndex = runnerLog.indexOf('ensureMonitorWindow:');
        assert.ok(ownershipIndex >= 0, `Expected ownership log. Got:\n${runnerLog}`);
        assert.ok(monitorIndex >= 0, `Expected monitor log. Got:\n${runnerLog}`);
        assert.ok(
            ownershipIndex < monitorIndex,
            `Expected ownership before monitor recovery. Got:\n${runnerLog}`,
        );

        const observed = (await waitForFileText(observedStateLog))
            .trim()
            .split('\n')
            .map(line => JSON.parse(line));
        assert.ok(observed.length > 0, 'monitor recovery should observe relaunched state');
        for (const state of observed) {
            assert.deepEqual(state, { active: true, exit_reason: null });
        }

        const finalState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        assert.equal(finalState.active, false, 'loop ceiling should still deactivate terminal state');
        assert.equal(typeof finalState.pid, 'number', `Expected runner pid stamp, got ${JSON.stringify(finalState)}`);
        assert.ok(finalState.pid > 0, `Expected positive runner pid, got ${finalState.pid}`);
        assert.equal(finalState.exit_reason, 'limit');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

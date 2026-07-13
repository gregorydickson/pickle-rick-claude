// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureMonitorWindow } from '../services/pickle-utils.js';

function makeStubTmuxEnv() {
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-monitor-stub-')));
  // Launchers name the tmux session `<prefix>-<session-hash>` for the dir it manages, and
  // ensureMonitorWindow refuses a session whose hash is not ours. The stub `#S` below
  // advertises `pickle-stub`, so the session dir must be `stub`.
  const sessionDir = path.join(tmpRoot, 'stub');
  const extensionRoot = path.join(tmpRoot, 'ext');

  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(path.join(extensionRoot, 'extension', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(extensionRoot, 'extension', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(extensionRoot, 'extension', 'bin', 'log-watcher.js'), '// sentinel\n');
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ command_template: 'council-of-ricks.md' }));
  fs.writeFileSync(path.join(extensionRoot, 'extension', 'scripts', 'tmux-monitor.sh'), '#!/bin/sh\nexit 0\n');

  let monitorExists = false;
  let monitorMode = null;
  let killCount = 0;
  const captured = [];
  const spawnSyncFn = (cmd, args = [], opts = {}) => {
    const call = {
      cmd: String(cmd),
      args: [...args],
      timeout: opts?.timeout,
    };
    captured.push(call);
    if (call.cmd === 'tmux') {
      switch (call.args[0]) {
        case 'display-message':
          return { status: 0, stdout: 'pickle-stub\n', stderr: '' };
        case 'list-windows':
          return { status: 0, stdout: monitorExists ? 'monitor\n' : 'runner\n', stderr: '' };
        case 'show-option':
          return { status: 0, stdout: monitorMode ? `${monitorMode}\n` : '', stderr: '' };
        case 'kill-window':
          killCount += 1;
          monitorExists = false;
          monitorMode = null;
          return { status: 0, stdout: '', stderr: '' };
        case 'set-option':
          monitorMode = String(call.args.at(-1) ?? '');
          monitorExists = true;
          return { status: 0, stdout: '', stderr: '' };
        default:
          return { status: 0, stdout: '', stderr: '' };
      }
    }
    if (call.cmd === 'bash') {
      monitorExists = true;
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  return {
    tmpRoot,
    sessionDir,
    extensionRoot,
    spawnSyncFn,
    setMonitorMode(mode) {
      monitorMode = mode;
      monitorExists = true;
    },
    getMonitorMode() {
      return monitorMode;
    },
    getKillCount() {
      return killCount;
    },
    isMonitorPresent() {
      return monitorExists;
    },
    readCalls() {
      return captured.map((call) => `${call.cmd} ${call.args.join(' ')}`.trim()).join('\n');
    },
    captured,
    cleanup() {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

test('ensureMonitorWindow: stub tmux creates, recreates, stamps mode, and preserves timeouts', () => {
  const env = makeStubTmuxEnv();

  try {
    const created = ensureMonitorWindow({
      sessionDir: env.sessionDir,
      extensionRoot: env.extensionRoot,
      inTmux: true,
      spawnSyncFn: env.spawnSyncFn,
    });
    assert.equal(created.status, 'created');
    assert.equal(env.isMonitorPresent(), true, 'monitor marker should be created');
    assert.equal(env.getMonitorMode(), 'council');

    env.setMonitorMode('pickle');
    const beforeRecreate = env.captured.length;
    const recreated = ensureMonitorWindow({
      sessionDir: env.sessionDir,
      extensionRoot: env.extensionRoot,
      inTmux: true,
      spawnSyncFn: env.spawnSyncFn,
    });
    assert.equal(recreated.status, 'recreated');
    assert.equal(env.getKillCount(), 1, 'stale monitor should be killed');
    assert.equal(env.getMonitorMode(), 'council');

    const calls = env.readCalls();
    assert.match(calls, /tmux kill-window -t pickle-stub:monitor/);
    assert.match(calls, /bash .+tmux-monitor\.sh pickle-stub .+stub council/);
    assert.match(calls, /tmux set-option -w -t pickle-stub:monitor @pickle_monitor_mode council/);

    const recreateTimeouts = env.captured.slice(beforeRecreate)
      .filter((call) => (
        call.args[0] === 'display-message' ||
        call.args[0] === 'list-windows' ||
        call.args[0] === 'kill-window' ||
        call.args[0] === 'set-option' ||
        call.cmd === 'bash'
      ))
      .map((call) => call.timeout);
    assert.deepEqual(recreateTimeouts, [5_000, 5_000, 5_000, 10_000, 5_000]);
  } finally {
    env.cleanup();
  }
});

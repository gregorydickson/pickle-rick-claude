// @tier: integration
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  restartDeadWatcherPanes,
  _resetSessionDirInvalidEmittedForTests,
} from '../../services/pickle-utils.js';
import { startRespawnWatchdog } from '../../bin/monitor.js';

/**
 * Regression guard for the sessionDir respawn cascade (R-MMRT-5):
 *   bad sessionDir → restartDeadWatcherPanes/startRespawnWatchdog bails early
 *   → zero tmux send-keys, one monitor_respawn_session_dir_invalid event.
 *
 * All tmux calls go through a mocked spawnSyncFn — no real tmux binary needed.
 */

function makeActivityEnv() {
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-cascade-')));
  const savedDataRoot = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = tmpRoot;
  _resetSessionDirInvalidEmittedForTests();

  return {
    tmpRoot,
    readEvents() {
      const activityDir = path.join(tmpRoot, 'activity');
      if (!fs.existsSync(activityDir)) return [];
      return fs.readdirSync(activityDir)
        .filter(f => f.endsWith('.jsonl'))
        .flatMap(f =>
          fs.readFileSync(path.join(activityDir, f), 'utf-8')
            .trim().split('\n')
            .filter(Boolean)
            .map(l => JSON.parse(l)),
        );
    },
    cleanup() {
      if (savedDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
      else process.env.PICKLE_DATA_ROOT = savedDataRoot;
      _resetSessionDirInvalidEmittedForTests();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

function makeSpawnCapture(sessionName = 'cascade-test', paneCommands = {}) {
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
      const cmd = paneCommands[pane] ?? 'node';
      return { status: 0, stdout: `${cmd}\n`, stderr: '' };
    }
    if (args[0] === 'send-keys') {
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return {
    spawnSyncFn,
    sendKeysCalls: () => calls.filter(c => c.command === 'tmux' && c.args[0] === 'send-keys'),
  };
}

// Session dir carries the hash the fake tmux session name (`cascade-test`) advertises —
// restartDeadWatcherPanes refuses any tmux session whose hash is not ours.
function makeValidSession(tmpRoot) {
  const sessionDir = path.join(tmpRoot, 'test');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'state.json'),
    JSON.stringify({ active: true, command_template: null }),
  );
  const extRoot = path.join(tmpRoot, 'ext');
  fs.mkdirSync(path.join(extRoot, 'extension', 'bin'), { recursive: true });
  // Sentinel file required by getExtensionRoot validation.
  fs.writeFileSync(path.join(extRoot, 'extension', 'bin', 'log-watcher.js'), '// sentinel\n');
  return { sessionDir, extRoot };
}

describe('monitor-respawn-sessiondir-cascade (R-MMRT-5)', () => {
  test('restartDeadWatcherPanes with empty sessionDir: zero send-keys, one event reason empty, no pane killed', () => {
    const env = makeActivityEnv();
    try {
      const { spawnSyncFn, sendKeysCalls } = makeSpawnCapture();

      restartDeadWatcherPanes('', os.tmpdir(), 'pickle', spawnSyncFn);

      assert.equal(sendKeysCalls().length, 0, 'zero send-keys on empty sessionDir');

      const events = env.readEvents().filter(e => e.event === 'monitor_respawn_session_dir_invalid');
      assert.equal(events.length, 1, 'exactly one monitor_respawn_session_dir_invalid event');
      assert.equal(events[0].gate_payload.reason, 'empty', 'event reason is empty');
    } finally {
      env.cleanup();
    }
  });

  test('restartDeadWatcherPanes on dir with no state.json: zero send-keys, one event reason no_state_json', () => {
    const env = makeActivityEnv();
    // path.join(os.tmpdir(), ...) so the path exists at fs level but has no state.json
    const fakePath = path.join(os.tmpdir(), `pipeline-signal-session-FAKE-${Date.now()}`);
    fs.mkdirSync(fakePath, { recursive: true });
    try {
      const { spawnSyncFn, sendKeysCalls } = makeSpawnCapture();

      restartDeadWatcherPanes(fakePath, os.tmpdir(), 'pickle', spawnSyncFn);

      assert.equal(sendKeysCalls().length, 0, 'zero send-keys when no state.json present');

      const events = env.readEvents().filter(e => e.event === 'monitor_respawn_session_dir_invalid');
      assert.equal(events.length, 1, 'exactly one monitor_respawn_session_dir_invalid event');
      assert.equal(events[0].gate_payload.reason, 'no_state_json', 'event reason is no_state_json');
    } finally {
      fs.rmSync(fakePath, { recursive: true, force: true });
      env.cleanup();
    }
  });

  test('startRespawnWatchdog cascade: mid-flight sessionDir mutation stops tmux work, one event, panes stay alive', async () => {
    const env = makeActivityEnv();
    let handle = null;
    try {
      const { sessionDir, extRoot } = makeValidSession(env.tmpRoot);
      // All panes alive: none will be respawned on the first (valid) tick.
      const { spawnSyncFn, sendKeysCalls } = makeSpawnCapture('cascade-session', {
        0: 'node', 1: 'node', 2: 'node', 3: 'node',
      });

      const opts = {
        sessionDir,
        extensionRoot: extRoot,
        intervalMs: 50,
        spawnSyncFn,
      };

      handle = startRespawnWatchdog(opts);
      assert.ok(handle !== null, 'watchdog arms successfully on valid sessionDir');

      // First tick fired synchronously at registration (R-MWCL-5).
      // All panes are 'node' so no send-keys should have occurred.
      assert.equal(sendKeysCalls().length, 0, 'first tick: zero send-keys (all panes alive)');

      // Simulate codex temp-dir drift: invalidate sessionDir mid-flight.
      // Reset dedup so the next tick's event is observable.
      _resetSessionDirInvalidEmittedForTests();
      opts.sessionDir = '';

      // Yield to the event loop so the 50ms interval can fire at least once.
      await new Promise(resolve => setTimeout(resolve, 150));

      assert.equal(sendKeysCalls().length, 0, 'after mutation: still zero send-keys, panes untouched');

      const events = env.readEvents().filter(e => e.event === 'monitor_respawn_session_dir_invalid');
      assert.equal(events.length, 1, 'exactly one monitor_respawn_session_dir_invalid event after mutation (dedup prevents duplicates)');
      assert.equal(events[0].gate_payload.reason, 'empty', 'event reason is empty after sessionDir nulled');
    } finally {
      if (handle !== null) clearInterval(handle);
      env.cleanup();
    }
  });
});

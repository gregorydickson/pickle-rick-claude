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
import {
  startRespawnWatchdog,
  checkAndSwapMode,
  render,
} from '../../bin/monitor.js';

/**
 * Launchers name the tmux session `<prefix>-<session-hash>` for the session dir it
 * manages, and `restartDeadWatcherPanes` refuses any session whose hash is not ours.
 * Fixtures must honor that pairing or they exercise a layout production cannot build.
 */
function sessionDirNameFor(sessionName) {
  return sessionName.slice(sessionName.lastIndexOf('-') + 1);
}

function makeValidSession(tmpRoot, { active = true, step = null, commandTemplate = null, includeSessionDir = false, sessionName = 'collapsed-test' } = {}) {
  const sessionDir = path.join(tmpRoot, sessionDirNameFor(sessionName));
  fs.mkdirSync(sessionDir, { recursive: true });
  const state = { active, command_template: commandTemplate };
  if (step != null) state.step = step;
  if (includeSessionDir) state.session_dir = sessionDir;
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state));
  const extRoot = path.join(tmpRoot, 'ext');
  fs.mkdirSync(path.join(extRoot, 'extension', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(extRoot, 'extension', 'bin', 'log-watcher.js'), '// sentinel\n');
  return { sessionDir, extRoot };
}

function makeNoopSink() {
  return {
    write(_chunk, cb) { if (typeof cb === 'function') cb(null); return true; },
    once() { return {}; },
    off() {},
  };
}

function makeCollapsedSpawnFn(sessionName = 'collapsed-test', { missingPanes = [2, 3] } = {}) {
  const calls = [];
  const spawnSyncFn = (command, args = []) => {
    calls.push({ command, args: [...args] });
    if (command !== 'tmux') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'display-message' && args[1] === '-p' && args[2] === '#S') {
      return { status: 0, stdout: `${sessionName}\n`, stderr: '' };
    }
    if (args[0] === 'display-message' && args[1] === '-p' && args[2] === '-t') {
      const pane = Number((args[3] || '').split('.').at(-1));
      if (missingPanes.includes(pane)) return { status: 1, stdout: '', stderr: 'no such pane' };
      return { status: 0, stdout: 'node\n', stderr: '' };
    }
    if (args[0] === 'list-panes') return { status: 0, stdout: '0\n1\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return {
    spawnSyncFn,
    splitCalls: () => calls.filter(c => c.command === 'tmux' && c.args[0] === 'split-window'),
    sendKeysCalls: () => calls.filter(c => c.command === 'tmux' && c.args[0] === 'send-keys'),
  };
}

describe('monitor-collapsed-layout-respawn (R-MWCL-3 + R-MWCL-5 + R-MWCL-1 + R-MWCL-2)', () => {

  describe('Scenario A: collapsed-layout repair', () => {
    test('watchdog synchronous first-tick recreates panes 2+3 and writes collapsed-layout-repair', () => {
      const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mclr-a1-')));
      _resetSessionDirInvalidEmittedForTests();
      try {
        const { sessionDir, extRoot } = makeValidSession(tmpRoot, { sessionName: 'watchdog-session' });
        const { spawnSyncFn, splitCalls, sendKeysCalls } = makeCollapsedSpawnFn('watchdog-session');

        startRespawnWatchdog({
          sessionDir,
          extensionRoot: extRoot,
          setIntervalFn: (_fn, _ms) => ({ unref() {} }),
          spawnSyncFn,
        });

        assert.ok(splitCalls().length >= 2, `expected ≥2 split-window calls for panes 2+3, got ${splitCalls().length}`);

        const pane2Send = sendKeysCalls().find(c => (c.args[2] || '').includes(':monitor.2'));
        const pane3Send = sendKeysCalls().find(c => (c.args[2] || '').includes(':monitor.3'));
        assert.ok(pane2Send, 'send-keys targeted pane 2');
        assert.ok(pane3Send, 'send-keys targeted pane 3');

        const log = fs.readFileSync(path.join(sessionDir, 'mux-runner.log'), 'utf-8');
        assert.ok(log.includes('collapsed-layout-repair'), 'mux-runner.log contains collapsed-layout-repair');
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        _resetSessionDirInvalidEmittedForTests();
      }
    });

    test('send-keys commands reference morty-watcher.js and raw-morty.js', () => {
      const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mclr-a2-')));
      _resetSessionDirInvalidEmittedForTests();
      try {
        const { sessionDir, extRoot } = makeValidSession(tmpRoot, { sessionName: 'watcher-cmd-session' });
        const { spawnSyncFn, sendKeysCalls } = makeCollapsedSpawnFn('watcher-cmd-session');

        restartDeadWatcherPanes(sessionDir, extRoot, 'pickle', spawnSyncFn);

        const pane2Send = sendKeysCalls().find(c => (c.args[2] || '').includes(':monitor.2'));
        const pane3Send = sendKeysCalls().find(c => (c.args[2] || '').includes(':monitor.3'));

        assert.ok(pane2Send?.args[3]?.includes('morty-watcher.js'), `pane 2 command should reference morty-watcher.js, got: ${pane2Send?.args[3]}`);
        assert.ok(pane3Send?.args[3]?.includes('raw-morty.js'), `pane 3 command should reference raw-morty.js, got: ${pane3Send?.args[3]}`);
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        _resetSessionDirInvalidEmittedForTests();
      }
    });
  });

  describe('Scenario B: mode auto-recovery', () => {
    test('render returns false on TypeError; checkAndSwapMode swaps to microverse; next render succeeds', async () => {
      const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mclr-b1-')));
      try {
        const { sessionDir } = makeValidSession(tmpRoot, {
          step: 'szechuan-sauce',
          commandTemplate: 'szechuan-sauce.md',
          includeSessionDir: true,
        });
        const noopSink = makeNoopSink();

        const result1 = await render(sessionDir, 'pickle', noopSink, () => {
          throw new TypeError('pickle mode rendering against szechuan-sauce session');
        });
        assert.equal(result1, false, 'render returns false on TypeError (R-MWCL-2)');

        const events = [];
        const newMode = checkAndSwapMode(sessionDir, 'pickle', (evt) => events.push(evt));
        assert.equal(newMode, 'microverse', 'checkAndSwapMode infers microverse from szechuan-sauce step (R-MWCL-1)');
        assert.ok(events.some(e => e.event === 'monitor_mode_swapped'), 'monitor_mode_swapped event emitted');

        const result3 = await render(sessionDir, 'microverse', noopSink);
        assert.equal(result3, true, 'render succeeds with correct microverse mode');
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    test('Scenarios A and B are independent', async () => {
      const tmpRootA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mclr-ab-a-')));
      const tmpRootB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mclr-ab-b-')));
      _resetSessionDirInvalidEmittedForTests();
      try {
        const { sessionDir: sDirA, extRoot: extRootA } = makeValidSession(tmpRootA, { sessionName: 'independent-a' });
        const { spawnSyncFn: spawnA, splitCalls } = makeCollapsedSpawnFn('independent-a');
        startRespawnWatchdog({
          sessionDir: sDirA,
          extensionRoot: extRootA,
          setIntervalFn: (_fn, _ms) => ({ unref() {} }),
          spawnSyncFn: spawnA,
        });
        assert.ok(splitCalls().length >= 2, 'Scenario A: split-window called for missing panes 2+3');

        const { sessionDir: sDirB } = makeValidSession(tmpRootB, {
          step: 'szechuan-sauce',
          commandTemplate: 'szechuan-sauce.md',
          includeSessionDir: true,
        });
        const noopSink = makeNoopSink();
        const renderResult = await render(sDirB, 'pickle', noopSink, () => {
          throw new TypeError('mode mismatch in isolation test');
        });
        assert.equal(renderResult, false, 'Scenario B: render false is independent of Scenario A state');
        const swappedMode = checkAndSwapMode(sDirB, 'pickle', () => {});
        assert.equal(swappedMode, 'microverse', 'Scenario B: mode swap is independent of Scenario A state');
      } finally {
        fs.rmSync(tmpRootA, { recursive: true, force: true });
        fs.rmSync(tmpRootB, { recursive: true, force: true });
        _resetSessionDirInvalidEmittedForTests();
      }
    });
  });
});

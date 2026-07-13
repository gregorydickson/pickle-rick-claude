// @tier: integration
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { restartDeadWatcherPanes } from '../../services/pickle-utils.js';

/**
 * AC-PSAI-09 trap-door: confirms that pane 0 (the monitor dashboard) is
 * respawned by `restartDeadWatcherPanes` when its `pane_current_command`
 * is not `node` (i.e., the monitor process has died mid-run).
 *
 * pane 0 being dead while the session is still active is the exact scenario
 * described in R-PSAI-5: a mid-run monitor crash should be caught by the
 * next `ensureMonitorWindow` call (via `restartDeadWatcherPanes`) or by the
 * 30s heartbeat in `startRespawnWatchdog`.
 */

/**
 * Launchers name the tmux session `<prefix>-<session-hash>` for the session dir it
 * manages, and `restartDeadWatcherPanes` refuses any session whose hash is not ours.
 * Fixtures must honor that pairing or they exercise a layout production cannot build.
 */
function sessionDirNameFor(sessionName) {
  return sessionName.slice(sessionName.lastIndexOf('-') + 1);
}

function makeSessionFixture({
  sessionName = 'pickle-pane0-test',
  paneCommands = { 0: 'zsh', 1: 'node', 2: 'node', 3: 'node' },
  active = true,
} = {}) {
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-pane0-')));
  const sessionDir = path.join(tmpRoot, sessionDirNameFor(sessionName));
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'state.json'),
    JSON.stringify({ active, command_template: null }),
  );
  const extRoot = path.join(tmpRoot, 'ext');
  fs.mkdirSync(path.join(extRoot, 'extension', 'bin'), { recursive: true });
  // Provide sentinel file so getExtensionRoot validates the override.
  fs.writeFileSync(path.join(extRoot, 'extension', 'bin', 'log-watcher.js'), '// sentinel\n');

  const spawnCalls = [];
  const spawnSyncFn = (command, args = []) => {
    spawnCalls.push({ command, args: [...args] });
    if (command !== 'tmux') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'display-message' && args[1] === '-p' && args[2] === '#S') {
      return { status: 0, stdout: `${sessionName}\n`, stderr: '' };
    }
    if (args[0] === 'display-message' && args[1] === '-p' && args[2] === '-t') {
      const target = args[3] ?? '';
      const pane = Number(target.split('.').at(-1));
      return { status: 0, stdout: `${paneCommands[pane] ?? ''}\n`, stderr: '' };
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
    spawnCalls,
    spawnSyncFn,
    sendKeysCalls: () => spawnCalls.filter(c => c.command === 'tmux' && c.args[0] === 'send-keys'),
    pane0SendKeys: () =>
      spawnCalls.filter(
        c => c.command === 'tmux' && c.args[0] === 'send-keys' &&
          (c.args[2] ?? '').includes('monitor.0') || (c.args[1] ?? '') === '-t' && (c.args[2] ?? '').includes('monitor.0'),
      ),
    cleanup() {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

describe('monitor pane-0 respawn watchdog (AC-PSAI-09 trap-door)', () => {
  test('restartDeadWatcherPanes respawns pane 0 when pane_current_command is not node', () => {
    // All panes dead (non-node), including pane 0.
    const f = makeSessionFixture({ paneCommands: { 0: 'zsh', 1: 'bash', 2: 'bash', 3: 'fish' } });
    try {
      restartDeadWatcherPanes(f.sessionDir, f.extRoot, 'pickle', f.spawnSyncFn);
      const sends = f.sendKeysCalls();
      // Must have attempted to respawn all 4 panes (0, 1, 2, 3).
      assert.ok(sends.length >= 4, `expected ≥4 send-keys calls; got ${sends.length}`);
      // Specifically check that at least one send-keys targeted pane 0.
      const targetedPanes = sends.map(s => {
        const targetArg = s.args.indexOf('-t');
        return targetArg >= 0 ? String(s.args[targetArg + 1] ?? '') : '';
      });
      const pane0Targeted = targetedPanes.some(t => t.endsWith('.0'));
      assert.ok(pane0Targeted, `pane 0 was not targeted for respawn; targets were: ${targetedPanes.join(', ')}`);
    } finally {
      f.cleanup();
    }
  });

  test('restartDeadWatcherPanes skips pane 0 when it is already running node', () => {
    // Only pane 0 alive; panes 1-3 dead.
    const f = makeSessionFixture({ paneCommands: { 0: 'node', 1: 'bash', 2: 'bash', 3: 'bash' } });
    try {
      restartDeadWatcherPanes(f.sessionDir, f.extRoot, 'pickle', f.spawnSyncFn);
      const sends = f.sendKeysCalls();
      // Panes 1-3 should be respawned; pane 0 should NOT.
      const targetedPanes = sends.map(s => {
        const targetArg = s.args.indexOf('-t');
        return targetArg >= 0 ? String(s.args[targetArg + 1] ?? '') : '';
      });
      const pane0Targeted = targetedPanes.some(t => t.endsWith('.0'));
      assert.ok(!pane0Targeted, `pane 0 was incorrectly targeted when it was already running node`);
      assert.ok(sends.length >= 3, `expected ≥3 send-keys for dead panes 1-3; got ${sends.length}`);
    } finally {
      f.cleanup();
    }
  });

  test('restartDeadWatcherPanes is a no-op for inactive sessions (pane 0 included)', () => {
    const f = makeSessionFixture({
      active: false,
      paneCommands: { 0: 'zsh', 1: 'zsh', 2: 'zsh', 3: 'zsh' },
    });
    try {
      restartDeadWatcherPanes(f.sessionDir, f.extRoot, 'pickle', f.spawnSyncFn);
      const sends = f.sendKeysCalls();
      assert.equal(sends.length, 0, 'inactive session must not respawn any pane including pane 0');
    } finally {
      f.cleanup();
    }
  });

  test('pane 0 is included in watcherPaneCommands (structural check)', () => {
    // Verify the structural invariant: all 4 display-message calls are issued
    // when all panes are dead, confirming pane 0 is probed.
    const f = makeSessionFixture({ paneCommands: { 0: 'zsh', 1: 'zsh', 2: 'zsh', 3: 'zsh' } });
    try {
      restartDeadWatcherPanes(f.sessionDir, f.extRoot, 'pickle', f.spawnSyncFn);
      const displayCalls = f.spawnCalls.filter(
        c => c.command === 'tmux' && c.args[0] === 'display-message' && c.args[1] === '-p' && c.args[2] === '-t',
      );
      // 4 panes probed: 0, 1, 2, 3
      assert.ok(displayCalls.length >= 4, `expected ≥4 pane display-message probes; got ${displayCalls.length}`);
      const probedPanes = displayCalls.map(c => Number(String(c.args[3]).split('.').at(-1)));
      assert.ok(probedPanes.includes(0), 'pane 0 must be probed by restartDeadWatcherPanes');
    } finally {
      f.cleanup();
    }
  });
});

// @tier: fast
import { describe as nodeDescribe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { format } from 'node:util';

import { inferMonitorMode, restartDeadWatcherPanes } from '../services/pickle-utils.js';
import {
  MONITOR_STDERR_LOG_NAME,
  appendMonitorStderrLog,
  inferModeFromStep,
  startRespawnWatchdog,
} from '../bin/monitor.js';

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

const MONITOR_MODE_CASES = [
  ['pickle', 'pickle.md', 'implement', 'pickle', /morty-watcher\.js/],
  ['council', 'council-of-ricks.md', 'plan', 'pickle', /tail -F .+mux-runner\.log/],
  ['refinement', 'refinement.md', 'verify', 'pickle', /refinement-watcher\.js/],
  ['szechuan-sauce', 'szechuan-sauce.md', 'szechuan-sauce', 'microverse', /pane-1-2-pointer\.js/],
  ['anatomy-park', 'anatomy-park.md', 'anatomy-park', 'microverse', /pane-1-2-pointer\.js/],
];

function makeSessionRoot(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeState(sessionDir, overrides = {}) {
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    active: true,
    command_template: null,
    schema_version: 4,
    step: 'implement',
    ...overrides,
  }));
}

function makeExtensionRoot(tmpRoot) {
  const extRoot = path.join(tmpRoot, 'ext');
  const binRoot = path.join(extRoot, 'extension', 'bin');
  fs.mkdirSync(binRoot, { recursive: true });
  for (const file of ['log-watcher.js', 'monitor.js', 'morty-watcher.js', 'pane-1-2-pointer.js', 'raw-morty.js', 'refinement-watcher.js']) {
    fs.writeFileSync(path.join(binRoot, file), '// stub\n');
  }
  return extRoot;
}

/**
 * Launchers name the tmux session `<prefix>-<session-hash>` for the session dir it
 * manages, and `restartDeadWatcherPanes` refuses any session whose hash is not ours.
 * Fixtures must honor that pairing or they exercise a layout production cannot build.
 */
function sessionDirNameFor(sessionName) {
  return sessionName.slice(sessionName.lastIndexOf('-') + 1);
}

function makeMonitorFixture({ template, sessionName = 'pickle-monitor' }) {
  const tmpRoot = makeSessionRoot('pickle-monitor-resilience-');
  const sessionDir = path.join(tmpRoot, sessionDirNameFor(sessionName));
  writeState(sessionDir, { command_template: template });
  return {
    tmpRoot,
    sessionDir,
    extRoot: makeExtensionRoot(tmpRoot),
    cleanup() {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

function makeRestartSpawn(sessionDir, sessionName) {
  const spawnCalls = [];
  const paneCommands = { 0: 'node', 1: 'node', 2: '', 3: '' };
  const spawnSyncFn = (command, args = []) => {
    spawnCalls.push({ command, args: [...args] });
    if (command !== 'tmux') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'display-message' && args[1] === '-p' && args[2] === '#S') {
      return { status: 0, stdout: `${sessionName}\n`, stderr: '' };
    }
    if (args[0] === 'display-message' && args[1] === '-p' && args[2] === '-t') {
      const target = args[3] || '';
      const pane = Number(target.split('.').at(-1));
      if (pane === 2 || pane === 3) {
        return { status: 1, stdout: '', stderr: `missing pane ${pane}` };
      }
      return { status: 0, stdout: `${paneCommands[pane] || ''}\n`, stderr: '' };
    }
    if (args[0] === 'split-window' || args[0] === 'send-keys') {
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return {
    sessionDir,
    spawnCalls,
    spawnSyncFn,
    readRunnerLog() {
      const logPath = path.join(sessionDir, 'mux-runner.log');
      return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    },
  };
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readMonitorStderr(sessionDir) {
  return fs.readFileSync(path.join(sessionDir, MONITOR_STDERR_LOG_NAME), 'utf8');
}

function sendKeysCalls(spawnCalls) {
  return spawnCalls.filter((call) => call.command === 'tmux' && call.args[0] === 'send-keys');
}

function paneTargetCalls(spawnCalls, pane) {
  return spawnCalls.filter((call) =>
    call.command === 'tmux'
    && call.args[0] === 'send-keys'
    && call.args[2].endsWith(`monitor.${pane}`)
  );
}

// --- R-MWCL-1: mode inference ---

describe.each(MONITOR_MODE_CASES)(
  'R-MWCL-1 %s: inferMonitorMode resolves concrete monitor mode',
  (mode, template) => {
    const tmpRoot = makeSessionRoot('pickle-monitor-mode-');
    try {
      writeState(tmpRoot, { command_template: template });
      assert.equal(inferMonitorMode(tmpRoot), mode);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  },
);

// --- R-MWCL-2: extended step inference ---

describe.each(MONITOR_MODE_CASES)(
  'R-MWCL-2 %s: inferModeFromStep preserves the current exported step bucket contract',
  (mode, _template, step, expectedStepMode) => {
    assert.equal(
      inferModeFromStep(step),
      expectedStepMode,
      `mode ${mode} should map step ${step} to ${expectedStepMode}`,
    );
  },
);

// --- R-MWCL-3: split-window fallback ---

describe.each(MONITOR_MODE_CASES)(
  'R-MWCL-3 %s: collapsed watcher layout recreates pane 2 and pane 3 with the mode-specific command',
  (mode, template, _step, _expectedStepMode, paneTwoPattern) => {
    const fixture = makeMonitorFixture({ template, sessionName: `${mode}-collapsed` });
    try {
      const restart = makeRestartSpawn(fixture.sessionDir, `${mode}-collapsed`);
      restartDeadWatcherPanes(fixture.sessionDir, fixture.extRoot, mode, restart.spawnSyncFn);

      const callsText = restart.spawnCalls
        .map((call) => `${call.command} ${call.args.join(' ')}`)
        .join('\n');
      assert.match(callsText, new RegExp(`tmux split-window -v -l 40% -t ${escapeRegex(`${mode}-collapsed:monitor.0`)}`));
      assert.match(callsText, new RegExp(`tmux split-window -h -t ${escapeRegex(`${mode}-collapsed:monitor.2`)}`));

      const paneTwoCalls = paneTargetCalls(restart.spawnCalls, 2);
      assert.equal(paneTwoCalls.length, 1, `expected one pane 2 send-keys for ${mode}`);
      assert.match(paneTwoCalls[0].args[3], paneTwoPattern);

      const paneThreeCalls = paneTargetCalls(restart.spawnCalls, 3);
      assert.equal(paneThreeCalls.length, 1, `expected one pane 3 send-keys for ${mode}`);
      assert.match(paneThreeCalls[0].args[3], /raw-morty\.js/);

      const runnerLog = restart.readRunnerLog();
      assert.match(runnerLog, /pane 2 missing; recreated via/);
      assert.match(runnerLog, /pane 3 missing; recreated via/);
    } finally {
      fixture.cleanup();
    }
  },
);

// --- R-MWCL-4: stderr capture ---

describe.each(MONITOR_MODE_CASES)(
  'R-MWCL-4 %s: render failure is captured in monitor-stderr.log',
  (mode, template) => {
    const fixture = makeMonitorFixture({ template });
    try {
      const errLine = `[monitor] render failure for mode=${mode}: synthetic boom\n`;
      appendMonitorStderrLog({
        sessionDir: fixture.sessionDir,
        chunk: errLine,
        firstWriteForProcess: true,
      });
      const log = readMonitorStderr(fixture.sessionDir);
      assert.match(log, /^\[monitor-stderr\] session=/);
      assert.match(log, new RegExp(escapeRegex(errLine)));
    } finally {
      fixture.cleanup();
    }
  },
);

// --- R-MWCL-5: first-tick watchdog ---

describe.each(MONITOR_MODE_CASES)(
  'R-MWCL-5 %s: watchdog fires immediately and uses the mode-specific pane 2 command',
  async (mode, template, _step, _expectedStepMode, paneTwoPattern) => {
    const fixture = makeMonitorFixture({ template, sessionName: `${mode}-watchdog` });
    try {
      const sessionName = `${mode}-watchdog`;
      const paneCommands = { 0: 'zsh', 1: 'bash', 2: 'fish', 3: 'sh' };
      const spawnCalls = [];
      const spawnSyncFn = (command, args = []) => {
        spawnCalls.push({ command, args: [...args] });
        if (command !== 'tmux') return { status: 0, stdout: '', stderr: '' };
        if (args[0] === 'display-message' && args[1] === '-p' && args[2] === '#S') {
          return { status: 0, stdout: `${sessionName}\n`, stderr: '' };
        }
        if (args[0] === 'display-message' && args[1] === '-p' && args[2] === '-t') {
          const pane = Number((args[3] || '').split('.').at(-1));
          return { status: 0, stdout: `${paneCommands[pane] || ''}\n`, stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      };

      const handle = startRespawnWatchdog({
        sessionDir: fixture.sessionDir,
        extensionRoot: fixture.extRoot,
        intervalMs: 40,
        spawnSyncFn,
      });
      assert.ok(handle, 'watchdog should return a timer handle');

      const immediateSendKeys = sendKeysCalls(spawnCalls);
      assert.equal(immediateSendKeys.length, 4, `expected one immediate sweep for ${mode}`);
      const paneTwoCall = paneTargetCalls(spawnCalls, 2)[0];
      assert.match(paneTwoCall.args[3], paneTwoPattern);

      await new Promise((resolve) => setTimeout(resolve, 70));
      clearInterval(handle);

      assert.ok(sendKeysCalls(spawnCalls).length >= 8, `expected a later interval sweep for ${mode}`);
    } finally {
      fixture.cleanup();
    }
  },
);

describe.each(MONITOR_MODE_CASES)(
  'R-MWCL-5 %s: first-tick failure still leaves the watchdog interval armed',
  async (mode, template) => {
    const fixture = makeMonitorFixture({ template, sessionName: `${mode}-watchdog-flaky` });
    try {
      const sessionName = `${mode}-watchdog-flaky`;
      const basePaneCommands = { 0: 'zsh', 1: 'bash', 2: 'fish', 3: 'sh' };
      const spawnCalls = [];
      let shouldThrow = true;
      const errors = [];
      const baseSpawn = (command, args = []) => {
        spawnCalls.push({ command, args: [...args] });
        if (command !== 'tmux') return { status: 0, stdout: '', stderr: '' };
        if (args[0] === 'display-message' && args[1] === '-p' && args[2] === '#S') {
          return { status: 0, stdout: `${sessionName}\n`, stderr: '' };
        }
        if (args[0] === 'display-message' && args[1] === '-p' && args[2] === '-t') {
          const pane = Number((args[3] || '').split('.').at(-1));
          return { status: 0, stdout: `${basePaneCommands[pane] || ''}\n`, stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      };
      const flakySpawn = (command, args = []) => {
        if (shouldThrow) {
          shouldThrow = false;
          throw new Error(`synthetic first-tick failure for ${mode}`);
        }
        return baseSpawn(command, args);
      };

      const handle = startRespawnWatchdog({
        sessionDir: fixture.sessionDir,
        extensionRoot: fixture.extRoot,
        intervalMs: 40,
        spawnSyncFn: flakySpawn,
        logger: (msg) => errors.push(msg),
      });

      assert.equal(errors.length, 1, `expected immediate error log for ${mode}`);
      assert.match(errors[0], new RegExp(`monitor-watchdog tick error: synthetic first-tick failure for ${escapeRegex(mode)}`));
      assert.equal(sendKeysCalls(spawnCalls).length, 0);

      await new Promise((resolve) => setTimeout(resolve, 70));
      clearInterval(handle);

      assert.ok(sendKeysCalls(spawnCalls).length >= 4, `expected later recovery tick for ${mode}`);
    } finally {
      fixture.cleanup();
    }
  },
);

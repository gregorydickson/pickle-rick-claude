// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync as realSpawnSync } from 'node:child_process';

import { restartDeadWatcherPanes } from '../../services/pickle-utils.js';
import { RESPAWN_WATCHDOG_INTERVAL_MS } from '../../bin/monitor.js';

// Load-robust spawnSync injection. `restartDeadWatcherPanes` passes a
// hardcoded `timeout: 5_000` to every internal `tmux` spawnSync; under 8-way
// full-suite concurrency on a loaded host even a fast `/bin/sh` tmux shim can
// starve past 5s, so a `split-window`/`send-keys` call returns non-zero and
// the layout-restoration assertions flake. The SUT exposes its `spawnSyncFn`
// as an injectable parameter precisely so tests can control subprocess
// behaviour — here we widen the per-call timeout to a value that survives
// scheduler pressure. Real hang detection is unaffected: the shim always
// exits promptly, this only prevents a spurious SIGKILL of a healthy shim.
function loadRobustSpawnSync(cmd, args, opts) {
  return realSpawnSync(cmd, args, { ...opts, timeout: 60_000 });
}

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

function makeCollapsedLayoutFixture({
  sessionName = 'pickle-collapsed-layout',
  mode = 'pickle',
  missingPanes = [2, 3],
} = {}) {
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-monitor-resilience-')));
  const callsLog = path.join(tmpRoot, 'calls.log');
  const shimDir = path.join(tmpRoot, 'bin');
  fs.mkdirSync(shimDir, { recursive: true });

  const sessionDir = path.join(tmpRoot, sessionDirNameFor(sessionName));
  const extRoot = path.join(tmpRoot, 'ext');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(path.join(extRoot, 'extension', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ active: true, command_template: null }));
  fs.writeFileSync(path.join(extRoot, 'extension', 'bin', 'log-watcher.js'), '// sentinel\n');

  for (const pane of missingPanes) {
    fs.writeFileSync(path.join(tmpRoot, `.missing-${pane}`), '');
  }
  for (const pane of [0, 1, 2, 3]) {
    fs.writeFileSync(path.join(tmpRoot, `.pane-${pane}`), 'node');
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
      cat "${path.join(tmpRoot, '.pane-0')}"
      ;;
    *monitor.1*pane_current_command*)
      if [ -f "${path.join(tmpRoot, '.missing-1')}" ]; then
        exit 1
      fi
      cat "${path.join(tmpRoot, '.pane-1')}"
      ;;
    *monitor.2*pane_current_command*)
      if [ -f "${path.join(tmpRoot, '.missing-2')}" ]; then
        exit 1
      fi
      cat "${path.join(tmpRoot, '.pane-2')}"
      ;;
    *monitor.3*pane_current_command*)
      if [ -f "${path.join(tmpRoot, '.missing-3')}" ]; then
        exit 1
      fi
      cat "${path.join(tmpRoot, '.pane-3')}"
      ;;
    *)
      echo "${sessionName}"
      ;;
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
      rm -f "${path.join(tmpRoot, '.missing-2')}"
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

  return {
    mode,
    shimDir,
    sessionDir,
    extRoot,
    readCalls() {
      return fs.existsSync(callsLog) ? fs.readFileSync(callsLog, 'utf-8') : '';
    },
    missingCount() {
      return [0, 1, 2, 3]
        .map(pane => path.join(tmpRoot, `.missing-${pane}`))
        .filter(marker => fs.existsSync(marker))
        .length;
    },
    withPath(fn) {
      return withSerializedPath(shimDir, fn);
    },
    cleanup() {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

test('restartDeadWatcherPanes restores a collapsed 1x2 watcher layout within the watchdog bound', async () => {
  const f = makeCollapsedLayoutFixture();
  const startedAt = Date.now();
  try {
    await f.withPath(() => restartDeadWatcherPanes(f.sessionDir, f.extRoot, f.mode, loadRobustSpawnSync));

    const durationMs = Date.now() - startedAt;
    const calls = f.readCalls();

    assert.equal(f.missingCount(), 0, 'collapsed layout should have no missing watcher panes after fallback');
    assert.match(calls, /tmux split-window -v -l 40% -t pickle-collapsed-layout:monitor\.0/);
    assert.match(calls, /tmux send-keys -t pickle-collapsed-layout:monitor\.2 .+morty-watcher\.js .+layout.+ Enter/);
    assert.match(calls, /tmux split-window -h -t pickle-collapsed-layout:monitor\.2/);
    assert.match(calls, /tmux send-keys -t pickle-collapsed-layout:monitor\.3 .+raw-morty\.js .+layout.+ Enter/);
    assert.ok(
      durationMs <= RESPAWN_WATCHDOG_INTERVAL_MS + 100,
      `recovery should stay within watchdog bound; got ${durationMs}ms`,
    );
  } finally {
    f.cleanup();
  }
});

test('restartDeadWatcherPanes collapsed-layout fixtures share the serialized PATH trap-door', async () => {
  const outer = makeCollapsedLayoutFixture({ sessionName: 'pickle-outer-layout' });
  const inner = makeCollapsedLayoutFixture({ sessionName: 'pickle-inner-layout' });
  const initialPath = process.env.PATH;
  let releaseOuter;
  let resolveOuterReady;
  let innerEntered = false;
  let innerPath = '';
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
      innerPath = process.env.PATH || '';
      restartDeadWatcherPanes(inner.sessionDir, inner.extRoot, inner.mode, loadRobustSpawnSync);
    });

    assert.equal(innerEntered, false, 'second fixture must wait for the serialized PATH queue');
    assert.ok((process.env.PATH || '').startsWith(`${outer.shimDir}${path.delimiter}`));

    releaseOuter();
    await outerRun;
    await innerRun;

    assert.equal(innerEntered, true);
    assert.ok(innerPath.startsWith(`${inner.shimDir}${path.delimiter}`));
    assert.equal(process.env.PATH, initialPath);
    assert.match(inner.readCalls(), /tmux split-window -v -l 40% -t pickle-inner-layout:monitor\.0/);
    assert.match(inner.readCalls(), /tmux split-window -h -t pickle-inner-layout:monitor\.2/);
  } finally {
    outer.cleanup();
    inner.cleanup();
  }
});

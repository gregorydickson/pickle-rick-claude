// @tier: fast
// AC-R-RESH-4 (#122-AC3): the child-mux wedge detector keys staleness on the
// most-recent tmux_iteration_*.log mtime, not state.json mtime alone.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  armChildMuxRunnerHeartbeat,
  __armPhaseChildMuxRunnerHeartbeatForTests,
  __setPhaseRunnerContextForTests,
} from '../bin/pipeline-runner.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-wedge-mtime-'));
}

const STALL_SECONDS = 1800;

function makeChild() {
  return {
    pid: 4242,
    killed: false,
    signal: null,
    kill(signal) {
      this.killed = true;
      this.signal = signal;
    },
  };
}

// Drive a single tick with controllable `now`; real fs.statSync reads the
// real-file mtimes set via fs.utimesSync (same pattern as the existing
// armChildMuxRunnerHeartbeat test in pipeline-runner.test.js).
function runTick(dir, nowMs) {
  const events = [];
  const child = makeChild();
  let tick = null;
  const handle = armChildMuxRunnerHeartbeat(
    { child, sessionDir: dir, heartbeatMs: 60_000, stallSeconds: STALL_SECONDS },
    {
      setInterval: (fn) => { tick = fn; return 123; },
      clearInterval: () => {},
      now: () => nowMs,
      isProcessAlive: () => true,
      emitActivity: (event) => { events.push(event); },
    },
  );
  assert.equal(typeof tick, 'function');
  tick();
  handle.stop();
  return { child, events };
}

function setMtime(p, whenMs) {
  const when = new Date(whenMs);
  fs.utimesSync(p, when, when);
}

describe('child-mux wedge detector keys on iteration-log mtime (AC-R-RESH-4)', () => {
  test('(a) fresh iteration-log, stale state.json -> NO wedge kill', () => {
    const dir = tmpDir();
    const now = Date.now();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ active: true }));
    setMtime(statePath, now - (STALL_SECONDS + 600) * 1000); // 40 min stale

    const logPath = path.join(dir, 'tmux_iteration_3.log');
    fs.writeFileSync(logPath, '{}');
    setMtime(logPath, now - 5 * 1000); // 5s fresh

    const { child, events } = runTick(dir, now);

    assert.equal(child.killed, false, 'fresh iteration log must not be killed');
    assert.equal(child.signal, null);
    assert.equal(events.length, 0, 'no wedge event when liveness is fresh');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('(b) state.json AND iteration-log both stale -> wedge fires off the log mtime', () => {
    const dir = tmpDir();
    const now = Date.now();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ active: true }));
    setMtime(statePath, now - (STALL_SECONDS + 1200) * 1000);

    const logPath = path.join(dir, 'tmux_iteration_3.log');
    fs.writeFileSync(logPath, '{}');
    const logStaleMs = now - (STALL_SECONDS + 60) * 1000; // 1860s stale, > threshold
    setMtime(logPath, logStaleMs);

    const { child, events } = runTick(dir, now);

    assert.equal(child.signal, 'SIGTERM', 'genuinely-frozen session still trips');
    assert.equal(child.killed, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'child_mux_runner_wedge_detected');
    // elapsed + iso derive from the LOG mtime (the freshest liveness signal),
    // not the staler state.json mtime. Read the on-disk mtime back via statSync
    // because fs.utimesSync rounds sub-second, so the intended logStaleMs can
    // differ from the persisted mtime by ~1ms — what matters is that the wedge
    // keys off the log, not the staler state.json (which is 1140s older here).
    const actualLogMtime = fs.statSync(logPath).mtimeMs;
    assert.equal(events[0].gate_payload.elapsed_seconds, Math.floor((now - actualLogMtime) / 1000));
    assert.equal(events[0].gate_payload.last_state_mtime_iso, new Date(actualLogMtime).toISOString());

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('(a-max) multiple iteration-logs -> keys off the MAX (freshest) mtime, not first/last', () => {
    // Two logs: tmux_iteration_1.log is stale (> threshold), tmux_iteration_3.log is fresh.
    // resolveChildMuxLivenessMtime takes the MAX across all logs, so liveness is fresh -> no kill.
    // A "first-log" or "last-readdir-entry" implementation would wrongly key off the stale log.
    const dir = tmpDir();
    const now = Date.now();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ active: true }));
    setMtime(statePath, now - (STALL_SECONDS + 600) * 1000); // state.json also stale

    const stale = path.join(dir, 'tmux_iteration_1.log');
    fs.writeFileSync(stale, '{}');
    setMtime(stale, now - (STALL_SECONDS + 300) * 1000); // 2100s stale, > threshold

    const fresh = path.join(dir, 'tmux_iteration_3.log');
    fs.writeFileSync(fresh, '{}');
    setMtime(fresh, now - 5 * 1000); // 5s fresh

    const { child, events } = runTick(dir, now);

    assert.equal(child.killed, false, 'MAX mtime is fresh -> must not kill');
    assert.equal(child.signal, null);
    assert.equal(events.length, 0, 'no wedge event when the freshest log is fresh');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('(c) no iteration-log -> falls back to state.json mtime', () => {
    const dir = tmpDir();
    const now = Date.now();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ active: true }));
    const stateStaleMs = now - (STALL_SECONDS + 60) * 1000;
    setMtime(statePath, stateStaleMs);
    // no tmux_iteration_*.log present

    const { child, events } = runTick(dir, now);

    assert.equal(child.signal, 'SIGTERM', 'stale state.json with no log still trips via fallback');
    assert.equal(events.length, 1);
    assert.equal(events[0].gate_payload.last_state_mtime_iso, new Date(stateStaleMs).toISOString());
    assert.equal(events[0].gate_payload.elapsed_seconds, Math.floor((now - stateStaleMs) / 1000));

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('(c-fresh) no iteration-log, fresh state.json -> NO wedge kill', () => {
    const dir = tmpDir();
    const now = Date.now();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ active: true }));
    setMtime(statePath, now - 10 * 1000); // fresh

    const { child, events } = runTick(dir, now);

    assert.equal(child.killed, false);
    assert.equal(events.length, 0);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('armPhaseChildMuxRunnerHeartbeat sessionDir override (AC-HEARTBEAT)', () => {
  test('unit dir fresh, parent dir stale: sessionDir=unitDir -> no wedge; sessionDir omitted (parent) -> wedge', () => {
    const parentDir = tmpDir();
    const unitDir = tmpDir();
    const now = Date.now();

    // Parent session dir: state.json well past the stall window, no iteration logs of
    // its own -> resolveChildMuxLivenessMtime falls back to the stale state.json mtime.
    const parentStatePath = path.join(parentDir, 'state.json');
    fs.writeFileSync(parentStatePath, JSON.stringify({ active: true }));
    setMtime(parentStatePath, now - (STALL_SECONDS + 600) * 1000); // 40 min stale

    // Unit session dir: its own state.json + a fresh iteration log -> liveness is fresh.
    const unitStatePath = path.join(unitDir, 'state.json');
    fs.writeFileSync(unitStatePath, JSON.stringify({ active: true }));
    setMtime(unitStatePath, now - (STALL_SECONDS + 600) * 1000);
    const unitLogPath = path.join(unitDir, 'tmux_iteration_1.log');
    fs.writeFileSync(unitLogPath, '{}');
    setMtime(unitLogPath, now - 5 * 1000); // 5s fresh

    __setPhaseRunnerContextForTests({
      sessionDir: parentDir,
      extensionRoot: '/tmp',
      childMuxRunnerHeartbeatMs: 60_000,
      childMuxRunnerStallSeconds: STALL_SECONDS,
    });

    try {
      // Armed with the unit dir override: liveness is fresh -> no wedge.
      {
        let tick = null;
        const child = makeChild();
        const events = [];
        const handle = __armPhaseChildMuxRunnerHeartbeatForTests(
          child,
          ['mux-runner.js'],
          unitDir,
          {
            setInterval: (fn) => { tick = fn; return 1; },
            clearInterval: () => {},
            now: () => now,
            isProcessAlive: () => true,
            emitActivity: (event) => { events.push(event); },
          },
        );
        assert.equal(typeof tick, 'function');
        tick();
        handle.stop();

        assert.equal(child.killed, false, 'unit dir liveness is fresh -> must not kill');
        assert.equal(events.length, 0, 'no wedge event when the unit dir is fresh');
      }

      // Armed with no override (falls back to phaseRunnerContext.sessionDir, the stale
      // parent dir): control proving the same setup DOES wedge without the override.
      {
        let tick = null;
        const child = makeChild();
        const events = [];
        const handle = __armPhaseChildMuxRunnerHeartbeatForTests(
          child,
          ['mux-runner.js'],
          undefined,
          {
            setInterval: (fn) => { tick = fn; return 1; },
            clearInterval: () => {},
            now: () => now,
            isProcessAlive: () => true,
            emitActivity: (event) => { events.push(event); },
          },
        );
        assert.equal(typeof tick, 'function');
        tick();
        handle.stop();

        assert.equal(child.signal, 'SIGTERM', 'parent dir liveness is stale -> must wedge');
        assert.equal(child.killed, true);
        assert.equal(events.length, 1);
        assert.equal(events[0].event, 'child_mux_runner_wedge_detected');
      }
    } finally {
      __setPhaseRunnerContextForTests(null);
      fs.rmSync(parentDir, { recursive: true, force: true });
      fs.rmSync(unitDir, { recursive: true, force: true });
    }
  });
});

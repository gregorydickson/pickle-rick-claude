// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyDecision, evaluateManagerIdleBackoff } from '../hooks/handlers/stop-hook.js';
import { StateManager } from '../services/state-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'stop-hook-states.json'), 'utf-8'),
);

// Cardinality canary — guards against silent drift in the keyed-object oracle.
// Per Definitions in prd_refined.md: pid ∈ {null, alive, dead} × active ∈ {true, false}
// × mtime ∈ {fresh, stale} × iteration ∈ {0, 1, max-1, max, max+1} = 3×2×2×5 = 60.
test('matrix fixture has exactly 60 cells (R-RTC-5 cardinality)', () => {
  assert.equal(
    Object.keys(FIXTURES).length,
    60,
    'expected 3×2×2×5 = 60 cells per the boundary-driven Definitions axes',
  );
});

// Spawn a process that exits immediately to get a reliably dead PID.
const _deadPidResult = spawnSync(process.execPath, ['--eval', ''], { timeout: 5_000 });
const DEAD_PID = _deadPidResult.pid;
const ALIVE_PID = process.pid;

const MAX_ITER = 10;
const STALE_OFFSET_SECONDS = 6 * 60; // 6 min — past the 5-min orphan-demotion threshold

function buildState({ pid, active, iteration }) {
  return {
    schema_version: 3,
    active,
    working_dir: process.cwd(),
    step: 'research',
    iteration,
    max_iterations: MAX_ITER,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000) - 30,
    completion_promise: null,
    original_prompt: 'matrix test',
    current_ticket: null,
    history: [],
    started_at: new Date(Date.now() - 30_000).toISOString(),
    session_dir: os.tmpdir(),
    tmux_mode: false,
    pid,
    activity: [],
    backend: 'claude',
    teams_mode: false,
    consecutive_short_responses: 0,
    false_epic_completed_count: 0,
  };
}

const sm = new StateManager();

function runCell({ pidLabel, active, mtime, iteration }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shs-'));
  try {
    // R-POD requires the canonical data-root layout (dataRoot/sessions/<hash>/state.json)
    // so readSessionsMapForState can locate current_sessions.json one level above sessions/.
    const sessionsDir = path.join(tmpDir, 'sessions');
    const sessionDir = path.join(sessionsDir, 'cell');
    fs.mkdirSync(sessionDir, { recursive: true });
    const stateFile = path.join(sessionDir, 'state.json');
    const pid =
      pidLabel === 'null' ? null : pidLabel === 'alive' ? ALIVE_PID : DEAD_PID;

    const state = buildState({ pid, active, iteration });
    state.session_dir = sessionDir;
    state.working_dir = sessionDir;
    fs.writeFileSync(stateFile, JSON.stringify(state));

    // R-POD `&&` predicate: orphan-paused demotion fires only when state is age-stale
    // AND the cwd's current_sessions.json maps to a dead PID. The null+stale cells
    // model the abandoned-paused-interview class — write a session map pointing at a
    // dead launch-shell PID so demotion fires per the documented contract.
    if (mtime === 'stale' && pidLabel === 'null' && active) {
      const mapPath = path.join(tmpDir, 'current_sessions.json');
      fs.writeFileSync(
        mapPath,
        JSON.stringify({ [sessionDir]: { sessionPath: sessionDir, pid: DEAD_PID } }),
      );
    }

    if (mtime === 'stale') {
      const staleTimeSec = Date.now() / 1000 - STALE_OFFSET_SECONDS;
      fs.utimesSync(stateFile, staleTimeSec, staleTimeSec);
    }

    // StateManager.read() runs full recovery: orphan-paused demotion (pid=null + stale + dead mapped pid)
    // and dead-pid demotion. Mirrors what the stop-hook binary does before classifyDecision.
    const recovered = sm.read(stateFile);

    // Mirror approveEarlyIfNeeded: inactive state always approves before reaching classifyDecision.
    // The "reason" for an early approve is whatever recovery stamped on exit_reason
    // (e.g. 'orphan-paused-no-claim') or the literal 'inactive' for plain active=false.
    if (recovered.active !== true) {
      return { decision: 'approve', reason: recovered.exit_reason ?? 'inactive' };
    }

    const result = classifyDecision(recovered, '', '');
    return { decision: result.decision, reason: result.reason ?? result.logMessage ?? '' };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 60-cell parametrized matrix
// ---------------------------------------------------------------------------

for (const [key, oracle] of Object.entries(FIXTURES)) {
  const [pidLabel, activeLabel, mtimeLabel, iterLabel] = key.split(':');
  const active = activeLabel === 'true';
  const iteration = parseInt(iterLabel, 10);

  test(key, () => {
    const { decision, reason } = runCell({ pidLabel, active, mtime: mtimeLabel, iteration });
    const tuple = `(pid=${pidLabel}, active=${activeLabel}, mtime=${mtimeLabel}, iteration=${iterLabel})`;
    assert.equal(
      decision,
      oracle.expected,
      `${tuple} expected=${oracle.expected} got=${decision} reason="${reason}"`,
    );
    // Case-insensitive substring keeps the fixture vocabulary-agnostic across
    // APPROVE logMessage prose ("Decision: APPROVE (Max iterations reached: 10/10)",
    // "... (Interactive loop retired — ...)") and recovery-set exit_reason values
    // ("orphan-paused-no-claim"). B-RSHM WS-1: classifyDecision is approve-only.
    assert.ok(
      reason.toLowerCase().includes(oracle.reason_substring.toLowerCase()),
      `${tuple} expected reason to include "${oracle.reason_substring}" but got "${reason}"`,
    );
  });
}

// ---------------------------------------------------------------------------
// xfail placeholder — ab62807f already landed so all 60 live cells pass.
// Remove this todo when Section D axes are defined.
// ---------------------------------------------------------------------------

test('stop-hook state matrix: Section D expansion cells (xfail placeholder)', (t) => {
  t.todo('Section D cells not yet defined; extend matrix when new state axes are added');
});

test('stop-hook state matrix: wait-pattern branch engages idle backoff on the third manager wait turn', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shs-idle-'));
  const sessionDir = path.join(tmpDir, 'session');
  const ticketDir = path.join(sessionDir, 'abc123');
  const stateFile = path.join(sessionDir, 'state.json');
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, `worker_session_${process.pid}.log`), 'alive\n');
  fs.writeFileSync(path.join(stateFile), JSON.stringify(buildState({
    pid: null,
    active: true,
    iteration: 1,
  })));
  const state = {
    ...buildState({ pid: null, active: true, iteration: 1 }),
    current_ticket: 'abc123',
    session_dir: sessionDir,
  };
  const previous = process.env.EXTENSION_DIR;
  process.env.EXTENSION_DIR = path.resolve(__dirname, '../..');
  try {
    assert.equal(evaluateManagerIdleBackoff(state, stateFile, 'Waiting for Monitor signal.', '', () => {}, 0)?.decision, 'block');
    assert.equal(evaluateManagerIdleBackoff(state, stateFile, 'Waiting for Monitor signal.', '', () => {}, 2_000)?.decision, 'block');
    const third = evaluateManagerIdleBackoff(state, stateFile, 'Waiting for Monitor signal.', '', () => {}, 4_000);
    assert.equal(third?.decision, 'block');
    assert.match(third?.reason || '', /Idle backoff engaged/);
  } finally {
    if (previous === undefined) delete process.env.EXTENSION_DIR;
    else process.env.EXTENSION_DIR = previous;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

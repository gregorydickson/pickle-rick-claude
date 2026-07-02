// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STOP_HOOK = path.resolve(__dirname, '../hooks/handlers/stop-hook.js');
const RESOLVE_STATE = path.resolve(__dirname, '../hooks/resolve-state.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a valid base state, with optional overrides. */
function baseState(overrides = {}) {
  return {
    active: true,
    pid: process.pid, // phantom-demotion guard: pid!=null exempts claimed sessions
    working_dir: process.cwd(),
    step: 'prd',
    iteration: 0,
    max_iterations: 5,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000) - 30,
    completion_promise: null,
    original_prompt: 'test task',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/pickle-test',
    tmux_mode: false,
    ...overrides,
  };
}

function writeExtensionSentinel(extensionDir) {
  const sentinelDir = path.join(extensionDir, 'extension', 'bin');
  fs.mkdirSync(sentinelDir, { recursive: true });
  fs.writeFileSync(path.join(sentinelDir, 'log-watcher.js'), '');
}

/**
 * Run stop-hook.js as a subprocess.
 *
 * Options:
 *   state           – state object written to state.json
 *   response        – value for last_assistant_message in the hook input JSON
 *   role            – value for PICKLE_ROLE env var (omitted if undefined)
 *   setStateFileEnv – if true (default), sets PICKLE_STATE_FILE; if false,
 *                     the hook resolves state via current_sessions.json instead
 *
 * Returns { decision, state, debugLog } where state is the (possibly updated)
 * state.json read back after the hook exits and debugLog is the hook's debug.log.
 */
function runHook(opts = {}) {
  const { state = baseState(), response = '', role = undefined, setStateFileEnv = true } = opts;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-'));
  writeExtensionSentinel(tmpDir);
  const sessionDir = path.join(tmpDir, 'session');
  fs.mkdirSync(sessionDir);
  const stateFile = path.join(sessionDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(state));

  // Always write a sessions map so tests that set setStateFileEnv=false still work.
  fs.writeFileSync(
    path.join(tmpDir, 'current_sessions.json'),
    JSON.stringify({ [process.cwd()]: sessionDir })
  );

  const env = { ...process.env, EXTENSION_DIR: tmpDir, FORCE_COLOR: '0' };
  delete env.PICKLE_ROLE;
  delete env.PICKLE_STATE_FILE;
  if (setStateFileEnv) env.PICKLE_STATE_FILE = stateFile;
  if (role !== undefined) env.PICKLE_ROLE = role;

  try {
    const stdout = execFileSync(process.execPath, [STOP_HOOK], {
      input: JSON.stringify({ last_assistant_message: response }),
      encoding: 'utf-8',
      env,
    });
    const debugLogPath = path.join(tmpDir, 'debug.log');
    return {
      decision: JSON.parse(stdout.trim()),
      state: JSON.parse(fs.readFileSync(stateFile, 'utf-8')),
      debugLog: fs.existsSync(debugLogPath) ? fs.readFileSync(debugLogPath, 'utf-8') : '',
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Run stop-hook.js with raw stdin (no JSON wrapping) for testing empty/corrupted input.
 * Returns { decision, debugLog }.
 */
function runHookRaw(opts = {}) {
  const { state = baseState(), stdin = '', setStateFileEnv = true } = opts;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-raw-'));
  writeExtensionSentinel(tmpDir);
  const sessionDir = path.join(tmpDir, 'session');
  fs.mkdirSync(sessionDir);
  const stateFile = path.join(sessionDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fs.writeFileSync(
    path.join(tmpDir, 'current_sessions.json'),
    JSON.stringify({ [process.cwd()]: sessionDir })
  );

  const env = { ...process.env, EXTENSION_DIR: tmpDir, FORCE_COLOR: '0' };
  delete env.PICKLE_ROLE;
  delete env.PICKLE_STATE_FILE;
  if (setStateFileEnv) env.PICKLE_STATE_FILE = stateFile;

  try {
    const stdout = execFileSync(process.execPath, [STOP_HOOK], {
      input: stdin,
      encoding: 'utf-8',
      env,
    });
    const debugLogPath = path.join(tmpDir, 'debug.log');
    const debugLog = fs.existsSync(debugLogPath)
      ? fs.readFileSync(debugLogPath, 'utf-8')
      : '';
    return { decision: JSON.parse(stdout.trim()), debugLog };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function makeStopHookFixture(prefix = 'ph-rate-limit-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  writeExtensionSentinel(tmpDir);
  const sessionDir = path.join(tmpDir, 'session');
  const checkUpdateDir = path.join(tmpDir, 'extension', 'bin');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(checkUpdateDir, { recursive: true });
  fs.writeFileSync(path.join(checkUpdateDir, 'check-update.js'), 'process.exit(0);\n');
  fs.writeFileSync(
    path.join(tmpDir, 'current_sessions.json'),
    JSON.stringify({ [process.cwd()]: sessionDir })
  );
  return {
    tmpDir,
    sessionDir,
    stateFile: path.join(sessionDir, 'state.json'),
    debugLogPath: path.join(tmpDir, 'debug.log'),
    spawnEpochPath: path.join(tmpDir, 'last-check-spawn.epoch'),
  };
}

function runHookInFixture(fixture, opts = {}) {
  const {
    state = baseState({
      schema_version: 3,
      completion_promise: 'DONE_FOR_RATE_LIMIT',
      session_dir: fixture.sessionDir,
    }),
    response = '<promise>DONE_FOR_RATE_LIMIT</promise>',
  } = opts;
  fs.writeFileSync(fixture.stateFile, JSON.stringify(state));
  const env = {
    ...process.env,
    EXTENSION_DIR: fixture.tmpDir,
    FORCE_COLOR: '0',
    PICKLE_STATE_FILE: fixture.stateFile,
  };
  delete env.PICKLE_ROLE;
  execFileSync(process.execPath, [STOP_HOOK], {
    input: JSON.stringify({ last_assistant_message: response }),
    encoding: 'utf-8',
    env,
  });
  return fs.existsSync(fixture.debugLogPath)
    ? fs.readFileSync(fixture.debugLogPath, 'utf-8')
    : '';
}

// ---------------------------------------------------------------------------
// Bypass conditions — always approve, no state mutation
// ---------------------------------------------------------------------------

test('stop-hook: no state file found → approve', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-'));
  writeExtensionSentinel(tmpDir);
  try {
    const env = {
      ...process.env,
      EXTENSION_DIR: tmpDir,
      FORCE_COLOR: '0',
      PICKLE_STATE_FILE: path.join(tmpDir, 'nonexistent.json'),
    };
    delete env.PICKLE_ROLE;
    const stdout = execFileSync(process.execPath, [STOP_HOOK], {
      input: JSON.stringify({ last_assistant_message: '' }),
      encoding: 'utf-8',
      env,
    });
    assert.deepEqual(JSON.parse(stdout.trim()), { decision: 'approve' });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('stop-hook: working_dir mismatch → approve, state unchanged', () => {
  const { decision, state } = runHook({
    state: baseState({ working_dir: '/tmp/some-other-project' }),
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true);
});

test('stop-hook: session inactive → approve', () => {
  const { decision, state } = runHook({ state: baseState({ active: false }) });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false);
});

test('stop-hook: stale active=true dead pid from PICKLE_STATE_FILE is recovered to inactive before hook gating', () => {
  const { decision, state } = runHook({
    state: baseState({ active: true, pid: 99999999 }),
    response: '',
    setStateFileEnv: true,
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false, 'dead-pid recovery must clear stale active sessions before stop-hook gating');
});

test('stop-hook: symlink cwd alias does not trigger early approve for a live same-repo session', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-symlink-'));
  const originalCwd = process.cwd();
  try {
    const repoRoot = path.join(tmp, 'repo-real');
    const repoAlias = path.join(tmp, 'repo-alias');
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.symlinkSync(repoRoot, repoAlias);

    process.chdir(repoAlias);
    const { decision, debugLog } = runHook({
      state: baseState({ working_dir: repoRoot }),
      response: 'Still working on the ticket.',
    });
    assert.equal(decision.decision, 'approve');
    assert.doesNotMatch(debugLog, /CWD Mismatch/, 'symlink alias must not be treated as a foreign cwd');
    assert.match(debugLog, /Interactive loop retired/, 'must reach the classify fallthrough, not the early approve');
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('stop-hook: tmux_mode, no PICKLE_STATE_FILE (main window) → approve, state unchanged', () => {
  // Main Claude window: resolves state via sessions map, not PICKLE_STATE_FILE
  const { decision, state } = runHook({
    state: baseState({ tmux_mode: true }),
    setStateFileEnv: false,
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'main window must not deactivate the session');
});

test('stop-hook: stale state (active:false + tmux_mode:true) → inactive path fires first, not tmux defer', () => {
    // REGRESSION: a stale state.json from a prior tmux session (active:false but
    // tmux_mode:true) used to short-circuit through the "tmux defer" early-exit
    // BEFORE the inactive check, masking a wrong-state-file resolution bug. The
    // inactive check must fire first so the decision reflects the actual state.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-stale-'));
    writeExtensionSentinel(tmpDir);
    const sessionDir = path.join(tmpDir, 'session');
    fs.mkdirSync(sessionDir);
    const stateFile = path.join(sessionDir, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify(baseState({ active: false, tmux_mode: true })));
    fs.writeFileSync(
        path.join(tmpDir, 'current_sessions.json'),
        JSON.stringify({ [process.cwd()]: sessionDir }),
    );
    const env = { ...process.env, EXTENSION_DIR: tmpDir, FORCE_COLOR: '0', PICKLE_STATE_FILE: stateFile };
    delete env.PICKLE_ROLE;
    try {
        execFileSync(process.execPath, [STOP_HOOK], {
            input: JSON.stringify({ last_assistant_message: '' }),
            encoding: 'utf-8',
            env,
        });
        const debugLog = fs.readFileSync(path.join(tmpDir, 'debug.log'), 'utf-8');
        assert.match(debugLog, /Decision: APPROVE \(Session inactive\)/,
            'stale inactive session must hit the inactive branch, not tmux defer');
        assert.doesNotMatch(debugLog, /tmux mode — main window defers to tmux-runner/,
            'inactive check must fire before tmux defer check');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('stop-hook: tmux_mode, PICKLE_STATE_FILE set (subprocess) → approves when tmux owns the loop', () => {
  // Subprocess: default fallthrough still approves once tmux owns the loop.
  const { decision } = runHook({
    state: baseState({ tmux_mode: true }),
    setStateFileEnv: true,
    response: '',
  });
  assert.deepEqual(decision, { decision: 'approve' });
});

// ---------------------------------------------------------------------------
// Exit conditions — approve; the hook never mutates active (runner owns lifecycle)
// ---------------------------------------------------------------------------

test('stop-hook: EPIC_COMPLETED → approve, active unchanged (hook never deactivates)', () => {
  const { decision, state } = runHook({
    response: 'Work done. <promise>EPIC_COMPLETED</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'B-RSHM: stop-hook no longer writes active — runner owns lifecycle');
});

test('stop-hook: TASK_COMPLETED → approve, active unchanged (hook never deactivates)', () => {
  const { decision, state } = runHook({
    response: '<promise>TASK_COMPLETED</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'B-RSHM: stop-hook no longer writes active — runner owns lifecycle');
});

test('stop-hook: recovered disabled auto-update settings suppress completion update spawn', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-update-settings-'));
  writeExtensionSentinel(tmpDir);
  const sessionDir = path.join(tmpDir, 'session');
  const stateFile = path.join(sessionDir, 'state.json');
  const settingsPath = path.join(tmpDir, 'pickle_settings.json');
  const checkUpdateDir = path.join(tmpDir, 'extension', 'bin');
  const checkUpdatePath = path.join(checkUpdateDir, 'check-update.js');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(checkUpdateDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(baseState({ session_dir: sessionDir })));
  fs.writeFileSync(settingsPath, JSON.stringify({ auto_update_enabled: true }));
  fs.writeFileSync(`${settingsPath}.tmp.99999999`, JSON.stringify({ auto_update_enabled: false }));
  fs.writeFileSync(checkUpdatePath, 'process.exit(0);\n');
  const older = new Date(Date.now() - 10_000);
  const newer = new Date();
  fs.utimesSync(settingsPath, older, older);
  fs.utimesSync(`${settingsPath}.tmp.99999999`, newer, newer);

  const env = { ...process.env, EXTENSION_DIR: tmpDir, FORCE_COLOR: '0', PICKLE_STATE_FILE: stateFile };
  delete env.PICKLE_ROLE;

  try {
    const stdout = execFileSync(process.execPath, [STOP_HOOK], {
      input: JSON.stringify({ last_assistant_message: '<promise>TASK_COMPLETED</promise>' }),
      encoding: 'utf-8',
      env,
    });
    assert.deepEqual(JSON.parse(stdout.trim()), { decision: 'approve' });
    const debugLog = fs.readFileSync(path.join(tmpDir, 'debug.log'), 'utf-8');
    assert.match(debugLog, /Auto-update disabled in settings, skipping/);
    assert.doesNotMatch(debugLog, /Spawning detached check-update process/);
    assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).auto_update_enabled, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('stop-hook.rate-limit first-spawn: fresh state spawns once', () => {
  const fixture = makeStopHookFixture();
  try {
    const log = runHookInFixture(fixture);
    assert.match(log, /Spawning detached check-update process/);
    assert.ok(fs.existsSync(fixture.spawnEpochPath), 'spawn epoch file should be written');
  } finally {
    fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
  }
});

test('stop-hook.rate-limit: 100 invocations in 30s produce no more than one spawn', () => {
  const fixture = makeStopHookFixture();
  try {
    fs.writeFileSync(
      path.join(fixture.tmpDir, 'pickle_settings.json'),
      JSON.stringify({ update_check_interval_hours: 1 })
    );
    let log = '';
    for (let i = 0; i < 100; i += 1) {
      log = runHookInFixture(fixture);
    }
    const spawnCount = (log.match(/Spawning detached check-update process/g) || []).length;
    assert.ok(spawnCount <= 1, `expected <=1 spawn, got ${spawnCount}`);
    assert.match(log, /check-update spawn skipped: rate-limited/);
  } finally {
    fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
  }
});

test('stop-hook.rate-limit: one-hour interval blocks respawn within the same hour', () => {
  const fixture = makeStopHookFixture();
  try {
    fs.writeFileSync(
      path.join(fixture.tmpDir, 'pickle_settings.json'),
      JSON.stringify({ update_check_interval_hours: 1 })
    );
    const fortyMinutesAgo = Math.floor(Date.now() / 1000) - (40 * 60);
    fs.writeFileSync(fixture.spawnEpochPath, `${fortyMinutesAgo}\n`);

    const log = runHookInFixture(fixture);

    assert.doesNotMatch(log, /Spawning detached check-update process/);
    assert.match(log, /check-update spawn skipped: rate-limited/);
  } finally {
    fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
  }
});

test('stop-hook.rate-limit epoch-write: spawn writes recent epoch file mtime', () => {
  const fixture = makeStopHookFixture();
  try {
    const before = Date.now();
    runHookInFixture(fixture);
    const stat = fs.statSync(fixture.spawnEpochPath);
    assert.ok(stat.mtimeMs >= before - 1000, `expected recent mtime, got ${stat.mtime.toISOString()}`);
    const writtenEpoch = Number(fs.readFileSync(fixture.spawnEpochPath, 'utf-8').trim());
    assert.ok(Number.isFinite(writtenEpoch), 'spawn epoch file should contain a finite epoch');
  } finally {
    fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
  }
});

test('stop-hook: EPIC_COMPLETED + tmux_mode → approve, active UNCHANGED (runner owns active)', () => {
  const { decision, state } = runHook({
    state: baseState({ tmux_mode: true }),
    response: '<promise>EPIC_COMPLETED</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'tmux mode: runner owns active — hook must not deactivate');
});

test('stop-hook: TASK_COMPLETED + tmux_mode → approve, active UNCHANGED (runner owns active)', () => {
  const { decision, state } = runHook({
    state: baseState({ tmux_mode: true }),
    response: '<promise>TASK_COMPLETED</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'tmux mode: runner owns active — hook must not deactivate');
});

test('stop-hook: custom completion_promise match → approve, active unchanged', () => {
  const { decision, state } = runHook({
    state: baseState({ completion_promise: 'MY_CUSTOM_DONE' }),
    response: 'All done. <promise>MY_CUSTOM_DONE</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true);
});

test('stop-hook: completion_promise set but wrong token → approve without completion detection', () => {
  const { decision, debugLog } = runHook({
    state: baseState({ completion_promise: 'MY_CUSTOM_DONE' }),
    response: 'Not done yet, still iterating on it.',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.match(debugLog, /hasPromise=false/, 'wrong token must not read as the completion promise');
  assert.doesNotMatch(debugLog, /Task\/Worker complete/);
});

test('stop-hook: worker + I AM DONE → approve, active unchanged', () => {
  const { decision, state } = runHook({
    state: baseState({ active: true }),
    response: '<promise>I AM DONE</promise>',
    role: 'worker',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'workers must not deactivate the session');
});

test('stop-hook: worker + EPIC_COMPLETED → approve, active unchanged', () => {
  const { decision, state } = runHook({
    state: baseState({ active: true }),
    response: '<promise>EPIC_COMPLETED</promise>',
    role: 'worker',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'workers must not deactivate the session');
});

// ---------------------------------------------------------------------------
// Checkpoint conditions — approve unconditionally (B-RSHM: inline checkpoint
// blocks retired; the runner owns phase respawn)
// ---------------------------------------------------------------------------

test('stop-hook: PRD_COMPLETE (non-tmux) → approve (checkpoint blocks retired)', () => {
  const { decision, debugLog } = runHook({ response: '<promise>PRD_COMPLETE</promise>' });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.match(debugLog, /checkpoint — runner will respawn/);
});

test('stop-hook: TICKET_SELECTED (non-tmux) → approve (checkpoint blocks retired)', () => {
  const { decision, debugLog } = runHook({ response: '<promise>TICKET_SELECTED</promise>' });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.match(debugLog, /checkpoint — runner will respawn/);
});

// ---------------------------------------------------------------------------
// Checkpoint conditions (tmux subprocess) — approve, no state change
// ---------------------------------------------------------------------------

test('stop-hook: TICKET_SELECTED + tmux_mode + PICKLE_STATE_FILE → approve, no deactivate', () => {
  const { decision, state } = runHook({
    state: baseState({ tmux_mode: true }),
    setStateFileEnv: true,
    response: '<promise>TICKET_SELECTED</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'checkpoint in tmux mode must not deactivate');
});

test('stop-hook: PRD_COMPLETE + tmux_mode + PICKLE_STATE_FILE → approve', () => {
  const { decision } = runHook({
    state: baseState({ tmux_mode: true }),
    setStateFileEnv: true,
    response: '<promise>PRD_COMPLETE</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
});

// ---------------------------------------------------------------------------
// Worker suppression — workers ignore manager checkpoint tokens
// ---------------------------------------------------------------------------

test('stop-hook: worker + PRD_COMPLETE → not treated as checkpoint, falls to default approve', () => {
  // isWorker=true makes roleAllowsToken false, so the checkpoint path is not entered
  const { decision, debugLog } = runHook({
    state: baseState({ active: true }),
    response: '<promise>PRD_COMPLETE</promise>',
    role: 'worker',
  });
  assert.equal(decision.decision, 'approve');
  assert.doesNotMatch(debugLog, /checkpoint — runner will respawn/, 'worker must not hit the manager checkpoint path');
});

test('stop-hook: state.worker=true (no PICKLE_ROLE) → NOT treated as worker', () => {
  // state.worker is a dead field — only PICKLE_ROLE=worker determines worker mode
  const { decision, debugLog } = runHook({
    state: baseState({ worker: true }),
    response: '<promise>I AM DONE</promise>',
  });
  assert.equal(decision.decision, 'approve');
  assert.match(debugLog, /isWorkerDone=false/, 'state.worker alone must not activate worker mode');
});

// ---------------------------------------------------------------------------
// Iteration and time limits
// ---------------------------------------------------------------------------

test('stop-hook: iteration >= max_iterations → approve via limit path, active unchanged', () => {
  const { decision, state, debugLog } = runHook({
    state: baseState({ iteration: 5, max_iterations: 5 }),
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'B-RSHM: limit exits no longer deactivate — runner owns lifecycle');
  assert.match(debugLog, /Max iterations reached: 5\/5/);
});

test('stop-hook: iteration > max_iterations → approve via limit path', () => {
  const { decision, debugLog } = runHook({
    state: baseState({ iteration: 7, max_iterations: 5 }),
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.match(debugLog, /Max iterations reached: 7\/5/);
});

test('stop-hook: max_iterations=0 (unlimited) → never fires limit, falls to default approve', () => {
  const { decision, debugLog } = runHook({
    state: baseState({ iteration: 999, max_iterations: 0 }),
  });
  assert.equal(decision.decision, 'approve');
  assert.doesNotMatch(debugLog, /Max iterations reached/);
  assert.match(debugLog, /Interactive loop retired/);
});

test('stop-hook: iteration limit + tmux_mode → approve, active UNCHANGED (runner handles limits)', () => {
  const { decision, state } = runHook({
    state: baseState({ tmux_mode: true, iteration: 5, max_iterations: 5 }),
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'tmux mode: runner handles limits — hook must not deactivate');
});

test('stop-hook: time limit reached → approve via limit path, active unchanged', () => {
  const { decision, state, debugLog } = runHook({
    state: baseState({
      start_time_epoch: Math.floor(Date.now() / 1000) - 3700, // 61 minutes ago
      max_time_minutes: 60,
    }),
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'B-RSHM: limit exits no longer deactivate — runner owns lifecycle');
  assert.match(debugLog, /Time limit reached/);
});

test('stop-hook: max_time_minutes=0 (unlimited) → never fires limit, falls to default approve', () => {
  const { decision, debugLog } = runHook({
    state: baseState({
      start_time_epoch: Math.floor(Date.now() / 1000) - 99999,
      max_time_minutes: 0,
    }),
  });
  assert.equal(decision.decision, 'approve');
  assert.doesNotMatch(debugLog, /Time limit reached/);
});

test('stop-hook: time limit + tmux_mode → approve, active UNCHANGED (runner handles limits)', () => {
  const { decision, state } = runHook({
    state: baseState({
      tmux_mode: true,
      start_time_epoch: Math.floor(Date.now() / 1000) - 3700,
      max_time_minutes: 60,
    }),
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'tmux mode: runner handles limits — hook must not deactivate');
});

// ---------------------------------------------------------------------------
// Default fallthrough — approve-only (B-RSHM: the non-tmux continuation BLOCK
// is retired; every classify path is approve)
// ---------------------------------------------------------------------------

test('stop-hook: active session, no tokens → approve, log carries iteration numbers', () => {
  const { decision, debugLog } = runHook({
    state: baseState({ iteration: 3, max_iterations: 10 }),
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.match(debugLog, /iteration 3 of 10/);
});

test('stop-hook: max_iterations=0 → default approve log has no "of N"', () => {
  const { decision, debugLog } = runHook({
    state: baseState({ iteration: 2, max_iterations: 0 }),
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.doesNotMatch(debugLog, /iteration 2 of/);
});

test('stop-hook: promise token with surrounding text is still detected', () => {
  const { decision, debugLog } = runHook({
    response: 'Done with everything!\n<promise>EPIC_COMPLETED</promise>\nGoodbye.',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.match(debugLog, /Task\/Worker complete/);
});

test('stop-hook: token with extra whitespace inside tags IS matched (tolerant)', () => {
  // Whitespace-tolerant regex — spaces inside tags still trigger the match
  const { decision, debugLog } = runHook({
    response: '<promise> EPIC_COMPLETED </promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.match(debugLog, /Task\/Worker complete/);
});

// ---------------------------------------------------------------------------
// resolve-state.ts exports
// ---------------------------------------------------------------------------

const { resolveStateFile, loadActiveState } = await import(RESOLVE_STATE);

test('resolve-state: resolveStateFile returns path when PICKLE_STATE_FILE set and file exists', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  const stateFile = path.join(tmpDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(baseState()));
  const saved = process.env.PICKLE_STATE_FILE;
  try {
    process.env.PICKLE_STATE_FILE = stateFile;
    assert.equal(resolveStateFile(tmpDir), stateFile);
  } finally {
    if (saved === undefined) delete process.env.PICKLE_STATE_FILE;
    else process.env.PICKLE_STATE_FILE = saved;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolve-state: resolveStateFile returns null when PICKLE_STATE_FILE file is missing', () => {
  const saved = process.env.PICKLE_STATE_FILE;
  try {
    process.env.PICKLE_STATE_FILE = '/tmp/does-not-exist-ever.json';
    assert.equal(resolveStateFile('/tmp'), null);
  } finally {
    if (saved === undefined) delete process.env.PICKLE_STATE_FILE;
    else process.env.PICKLE_STATE_FILE = saved;
  }
});

test('resolve-state: resolveStateFile resolves via sessions map when no PICKLE_STATE_FILE', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  const sessionDir = path.join(tmpDir, 'session');
  fs.mkdirSync(sessionDir);
  const stateFile = path.join(sessionDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(baseState({ session_dir: sessionDir })));
  fs.writeFileSync(
    path.join(tmpDir, 'current_sessions.json'),
    JSON.stringify({ [process.cwd()]: sessionDir })
  );
  const saved = process.env.PICKLE_STATE_FILE;
  try {
    delete process.env.PICKLE_STATE_FILE;
    assert.equal(resolveStateFile(tmpDir), stateFile);
  } finally {
    if (saved !== undefined) process.env.PICKLE_STATE_FILE = saved;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolve-state: resolveStateFile returns null when cwd not in sessions map', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  fs.writeFileSync(
    path.join(tmpDir, 'current_sessions.json'),
    JSON.stringify({ '/some/other/dir': '/some/session' })
  );
  const saved = process.env.PICKLE_STATE_FILE;
  try {
    delete process.env.PICKLE_STATE_FILE;
    assert.equal(resolveStateFile(tmpDir), null);
  } finally {
    if (saved !== undefined) process.env.PICKLE_STATE_FILE = saved;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolve-state: loadActiveState returns state for active session with matching cwd', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  const stateFile = path.join(tmpDir, 'state.json');
  const state = { active: true, working_dir: process.cwd(), step: 'prd' };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  try {
    const loaded = loadActiveState(stateFile);
    assert.equal(loaded.active, true);
    assert.equal(loaded.step, 'prd');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolve-state: loadActiveState returns null for inactive session', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  const stateFile = path.join(tmpDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ active: false, working_dir: process.cwd() }));
  try {
    assert.equal(loadActiveState(stateFile), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolve-state: loadActiveState returns null for cwd mismatch', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  const stateFile = path.join(tmpDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ active: true, working_dir: '/some/other/dir' }));
  try {
    assert.equal(loadActiveState(stateFile), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolve-state: loadActiveState returns null when active is string "true" (strict check)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  const stateFile = path.join(tmpDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ active: "true", working_dir: process.cwd() }));
  try {
    assert.equal(loadActiveState(stateFile), null,
      'string "true" should not pass strict === true check');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Disabled marker — /disable-pickle creates this file to suppress the hook
// ---------------------------------------------------------------------------

test('stop-hook: disabled marker file → approve immediately, state unchanged', () => {
  const state = baseState();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-'));
  writeExtensionSentinel(tmpDir);
  const sessionDir = path.join(tmpDir, 'session');
  fs.mkdirSync(sessionDir);
  const stateFile = path.join(sessionDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(state));
  // Create the disabled marker file
  fs.writeFileSync(path.join(tmpDir, 'disabled'), '');

  const env = { ...process.env, EXTENSION_DIR: tmpDir, FORCE_COLOR: '0', PICKLE_STATE_FILE: stateFile };
  delete env.PICKLE_ROLE;

  try {
    const stdout = execFileSync(process.execPath, [STOP_HOOK], {
      input: JSON.stringify({ last_assistant_message: '' }),
      encoding: 'utf-8',
      env,
    });
    assert.deepEqual(JSON.parse(stdout.trim()), { decision: 'approve' });
    // State should NOT be modified (no deactivation)
    const afterState = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    assert.equal(afterState.active, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('stop-hook: no disabled marker → hook processes normally (classify fallthrough runs)', () => {
  // Sanity check: without the marker, the hook must run the full classify path
  const { decision, debugLog } = runHook({ state: baseState(), response: 'just some text about the ongoing work' });
  assert.equal(decision.decision, 'approve');
  assert.match(debugLog, /Interactive loop retired/);
});

// ---------------------------------------------------------------------------
// Fail-open: corrupt state.json and invalid stdin
// ---------------------------------------------------------------------------

test('stop-hook: corrupt state.json → approve (fail-open)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-'));
  writeExtensionSentinel(tmpDir);
  const sessionDir = path.join(tmpDir, 'session');
  fs.mkdirSync(sessionDir);
  const stateFile = path.join(sessionDir, 'state.json');
  fs.writeFileSync(stateFile, '{{{invalid json!!!');

  const env = { ...process.env, EXTENSION_DIR: tmpDir, FORCE_COLOR: '0', PICKLE_STATE_FILE: stateFile };
  delete env.PICKLE_ROLE;

  try {
    const stdout = execFileSync(process.execPath, [STOP_HOOK], {
      input: JSON.stringify({ last_assistant_message: '' }),
      encoding: 'utf-8',
      env,
    });
    assert.deepEqual(JSON.parse(stdout.trim()), { decision: 'approve' });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('stop-hook: empty stdin → approve (fail-open)', () => {
  const { decision } = runHook({ state: baseState({ active: false }), response: '' });
  assert.deepEqual(decision, { decision: 'approve' });
});

// ---------------------------------------------------------------------------
// Refinement worker — ANALYSIS_DONE token handling
// ---------------------------------------------------------------------------

test('stop-hook: refinement-worker + ANALYSIS_DONE → approve, active unchanged', () => {
  const { decision, state } = runHook({
    state: baseState({ active: true }),
    response: '<promise>ANALYSIS_DONE</promise>',
    role: 'refinement-worker',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'refinement workers must not deactivate the session');
});

test('stop-hook: refinement-worker + no token → default approve (continuation blocks retired)', () => {
  const { decision, debugLog } = runHook({
    state: baseState({ active: true }),
    response: 'Still working on analysis...',
    role: 'refinement-worker',
  });
  assert.equal(decision.decision, 'approve');
  assert.doesNotMatch(debugLog, /Task\/Worker complete/);
});

test('stop-hook: non-refinement role + ANALYSIS_DONE → not treated as completion', () => {
  // ANALYSIS_DONE should only work for refinement-worker role
  const { decision, debugLog } = runHook({
    state: baseState({ active: true }),
    response: '<promise>ANALYSIS_DONE</promise>',
    role: 'manager',
  });
  assert.equal(decision.decision, 'approve');
  assert.doesNotMatch(debugLog, /Task\/Worker complete/, 'ANALYSIS_DONE must not read as completion for a manager');
});

// ---------------------------------------------------------------------------
// Number() coercion for string numeric state fields (deep review pass 5)
// ---------------------------------------------------------------------------

test('stop-hook: string max_iterations and iteration still trigger limit check', () => {
  const { decision, debugLog } = runHook({
    state: baseState({ iteration: '3', max_iterations: '3' }),
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.match(debugLog, /Max iterations reached: 3\/3/, 'string numerics must still hit the limit path');
});

test('stop-hook: string start_time_epoch and max_time_minutes still trigger time limit', () => {
  const { decision, debugLog } = runHook({
    state: baseState({
      start_time_epoch: String(Math.floor(Date.now() / 1000) - 3700),
      max_time_minutes: '60',
    }),
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.match(debugLog, /Time limit reached/, 'string time values must still hit the limit path');
});

test('stop-hook: string "true" active is treated as inactive (strict boolean check)', () => {
  const { decision, state } = runHook({
    state: baseState({ active: "true" }),
    response: 'some text',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, "true", 'string "true" should not be modified — session treated as inactive');
});

test('stop-hook: string "true" tmux_mode is NOT treated as tmux mode (strict boolean check)', () => {
  // tmux_mode stored as string "true" (truthy but !== true) should NOT trigger tmux early-exit
  // setStateFileEnv: false so the tmux main-window branch (!process.env.PICKLE_STATE_FILE) is reachable
  const { decision, debugLog } = runHook({
    state: baseState({ tmux_mode: "true" }),
    response: 'This is a longer response that avoids the degenerate short-response detection',
    setStateFileEnv: false,
  });
  // Must fall through to the non-tmux default approve, not the tmux main-window defer
  assert.equal(decision.decision, 'approve');
  assert.doesNotMatch(debugLog, /main window defers to tmux-runner/);
  assert.match(debugLog, /Interactive loop retired/, 'string tmux_mode must take the non-tmux fallthrough');
});

// ---------------------------------------------------------------------------
// EXISTENCE_IS_PAIN token — meeseeks code review loop
// ---------------------------------------------------------------------------

test('stop-hook: EXISTENCE_IS_PAIN → approve (standard completion), active unchanged', () => {
  const { decision, state } = runHook({
    response: '<promise>EXISTENCE_IS_PAIN</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'B-RSHM: hook never deactivates');
});

test('stop-hook: EXISTENCE_IS_PAIN below min_iterations (non-tmux) → approve for runner respawn', () => {
  const { decision, state, debugLog } = runHook({
    state: baseState({ min_iterations: 10, iteration: 3 }),
    response: '<promise>EXISTENCE_IS_PAIN</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'below min_iterations — active must stay true');
  assert.match(debugLog, /below min, runner continues/);
});

test('stop-hook: EXISTENCE_IS_PAIN below min_iterations (tmux) → approve for runner respawn', () => {
  const { decision, state } = runHook({
    state: baseState({ min_iterations: 10, iteration: 3, tmux_mode: true }),
    response: '<promise>EXISTENCE_IS_PAIN</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'below min_iterations — active must stay true for runner to continue');
});

test('stop-hook: EXISTENCE_IS_PAIN at min_iterations → approve as completion', () => {
  const { decision, state, debugLog } = runHook({
    state: baseState({ min_iterations: 10, iteration: 10 }),
    response: '<promise>EXISTENCE_IS_PAIN</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'B-RSHM: hook never deactivates');
  assert.match(debugLog, /Task\/Worker complete/);
});

test('stop-hook: EXISTENCE_IS_PAIN at min_iterations + tmux_mode → approve, active UNCHANGED', () => {
  const { decision, state } = runHook({
    state: baseState({ tmux_mode: true, min_iterations: 10, iteration: 10 }),
    response: '<promise>EXISTENCE_IS_PAIN</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'tmux mode: runner owns active — hook must not deactivate');
});

// ---------------------------------------------------------------------------
// THE_CITADEL_APPROVES token — council of ricks stack review loop
// ---------------------------------------------------------------------------

test('stop-hook: THE_CITADEL_APPROVES → approve (standard completion), active unchanged', () => {
  const { decision, state } = runHook({
    response: '<promise>THE_CITADEL_APPROVES</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'B-RSHM: hook never deactivates');
});

test('stop-hook: THE_CITADEL_APPROVES below min_iterations (non-tmux) → approve for runner respawn', () => {
  const { decision, state, debugLog } = runHook({
    state: baseState({ min_iterations: 10, iteration: 3 }),
    response: '<promise>THE_CITADEL_APPROVES</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'below min_iterations — active must stay true');
  assert.match(debugLog, /below min, runner continues/);
});

test('stop-hook: THE_CITADEL_APPROVES below min_iterations (tmux) → approve for runner respawn', () => {
  const { decision, state } = runHook({
    state: baseState({ min_iterations: 10, iteration: 3, tmux_mode: true }),
    response: '<promise>THE_CITADEL_APPROVES</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'below min_iterations — active must stay true for runner to continue');
});

test('stop-hook: THE_CITADEL_APPROVES at min_iterations → approve as completion', () => {
  const { decision, state, debugLog } = runHook({
    state: baseState({ min_iterations: 10, iteration: 10 }),
    response: '<promise>THE_CITADEL_APPROVES</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'B-RSHM: hook never deactivates');
  assert.match(debugLog, /Task\/Worker complete/);
});

test('stop-hook: THE_CITADEL_APPROVES at min_iterations + tmux_mode → approve, active UNCHANGED', () => {
  const { decision, state } = runHook({
    state: baseState({ tmux_mode: true, min_iterations: 10, iteration: 10 }),
    response: '<promise>THE_CITADEL_APPROVES</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'tmux mode: runner owns active — hook must not deactivate');
});

test('stop-hook: EPIC_COMPLETED ignores min_iterations → still approves as completion', () => {
  const { decision, debugLog } = runHook({
    state: baseState({ min_iterations: 10, iteration: 2 }),
    response: '<promise>EPIC_COMPLETED</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.match(debugLog, /Task\/Worker complete/, 'EPIC_COMPLETED must ignore min_iterations — no regression');
});

// ---------------------------------------------------------------------------
// Rate limit detection — approve exit so mux-runner handles backoff
// ---------------------------------------------------------------------------

test('stop-hook: short rate limit message → approve (hand off to runner)', () => {
  const { decision, state } = runHook({
    response: "You're out of extra usage · resets Mar 6 at 11am",
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'rate limit approve must not deactivate — runner owns lifecycle');
});

test('stop-hook: "rate limit" short message → approve', () => {
  const { decision } = runHook({
    response: 'API rate limit exceeded.',
  });
  assert.deepEqual(decision, { decision: 'approve' });
});

test('stop-hook: "usage limit reached" short message → approve', () => {
  const { decision } = runHook({
    response: 'Your usage limit has been reached.',
  });
  assert.deepEqual(decision, { decision: 'approve' });
});

test('stop-hook: "hour limit" short message → approve', () => {
  const { decision } = runHook({
    response: 'You have exceeded your 5 requests per hour limit.',
  });
  assert.deepEqual(decision, { decision: 'approve' });
});

test('stop-hook: long response mentioning rate limit → NOT classified as rate limit', () => {
  // > 500 chars: normal conversation about rate limits, not a synthetic error
  const longText = 'I hit a rate limit but recovered and continued working on the task. ' +
    'Here is what I found during my research phase. '.repeat(15);
  assert.ok(longText.length > 500, 'test setup: text must be > 500 chars');
  const { decision, debugLog } = runHook({ response: longText });
  assert.equal(decision.decision, 'approve');
  assert.doesNotMatch(debugLog, /Rate limit detected/, 'long responses mentioning rate limits must not classify as rate-limit');
});

test('stop-hook: empty response → NOT classified as rate limit', () => {
  const { decision, debugLog } = runHook({ response: '' });
  assert.equal(decision.decision, 'approve');
  assert.doesNotMatch(debugLog, /Rate limit detected/);
});

test('stop-hook: rate limit in tmux subprocess → approve, active unchanged', () => {
  const { decision, state } = runHook({
    state: baseState({ tmux_mode: true }),
    setStateFileEnv: true,
    response: "You're out of extra usage · resets Mar 6 at 11am",
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'tmux mode: runner owns active');
});

// ---------------------------------------------------------------------------
// NaN/undefined edge cases
// ---------------------------------------------------------------------------

test('stop-hook: NaN/undefined numeric state fields do not crash', () => {
  // max_iterations is undefined, iteration is "abc" → Number("abc") = NaN → || 0
  const { decision, debugLog } = runHook({
    state: baseState({ iteration: 'abc', max_iterations: undefined, max_time_minutes: undefined, start_time_epoch: undefined }),
  });
  assert.equal(decision.decision, 'approve', 'should fall through to default approve without crashing');
  assert.match(debugLog, /Interactive loop retired/);
});

// ---------------------------------------------------------------------------
// Edge cases: empty completion_promise, start_time_epoch=0 (pass 9)
// ---------------------------------------------------------------------------

test('stop-hook: completion_promise empty string → not treated as custom promise', () => {
  // !!("") is false, so hasPromise should be false even if responseText has <promise></promise>
  const { decision, debugLog } = runHook({
    state: baseState({ completion_promise: '' }),
    response: 'no tokens here',
  });
  assert.equal(decision.decision, 'approve');
  assert.match(debugLog, /hasPromise=false/, 'empty string completion_promise should not match anything');
});

test('stop-hook: start_time_epoch=0 with max_time_minutes>0 → time limit skipped', () => {
  // maxTimeMins > 0 && startEpoch > 0 — when epoch is 0, the condition short-circuits
  const { decision, debugLog } = runHook({
    state: baseState({
      start_time_epoch: 0,
      max_time_minutes: 1, // 1 minute — would trigger if epoch were valid
      iteration: 1,
      max_iterations: 100,
    }),
  });
  assert.equal(decision.decision, 'approve');
  assert.doesNotMatch(debugLog, /Time limit reached/, 'start_time_epoch=0 should disable time limit check');
});

// ---------------------------------------------------------------------------
// No-op / ack loop detection — approve exit to break degenerate feedback loops
// ---------------------------------------------------------------------------

test('stop-hook: "Acknowledged." response → approve (no-op detection)', () => {
  const { decision } = runHook({
    state: baseState({ iteration: 3, max_iterations: 50 }),
    response: 'Acknowledged.',
  });
  assert.equal(decision.decision, 'approve');
});

test('stop-hook: "OK" short response → approve (matches no-op pattern)', () => {
  // "OK" matches /^ok\.?$/i → no-op pattern → immediate approve regardless of counter.
  const { decision } = runHook({
    state: baseState({ iteration: 5, max_iterations: 50 }),
    response: 'OK',
  });
  assert.equal(decision.decision, 'approve');
});

test('stop-hook: "  Understood  " padded response → approve (no-op pattern after trim)', () => {
  // After trim: "Understood" (10 chars) matches /^understood\.?$/i → no-op → immediate approve.
  const { decision } = runHook({
    state: baseState({ iteration: 1, max_iterations: 10 }),
    response: '  Understood  ',
  });
  assert.equal(decision.decision, 'approve');
});

test('stop-hook: "Continuing." (12 chars) → approve (genuine no-op pattern match)', () => {
  // 12 chars after trim — above degenerate threshold, must be caught by no-op pattern
  const { decision } = runHook({
    state: baseState({ iteration: 2, max_iterations: 10 }),
    response: ' Continuing.',
  });
  assert.equal(decision.decision, 'approve');
});

test('stop-hook: "Got it." response → approve (matches no-op pattern)', () => {
  // "Got it." matches /^got it\.?$/i → no-op pattern → immediate approve regardless of counter.
  const { decision } = runHook({
    state: baseState({ iteration: 2, max_iterations: 10 }),
    response: 'Got it.',
  });
  assert.equal(decision.decision, 'approve');
});

test('stop-hook: substantive response without tokens → default approve (not a no-op)', () => {
  const { decision, debugLog } = runHook({
    state: baseState({ iteration: 2, max_iterations: 10 }),
    response: 'I fixed the linting error in utils.ts and ran the tests.',
  });
  assert.equal(decision.decision, 'approve');
  assert.match(debugLog, /Interactive loop retired/, 'substantive text must take the default fallthrough, not the no-op path');
});

test('stop-hook: no-op detection does not fire for empty response', () => {
  // Empty responses fall to the default approve path
  const { decision, debugLog } = runHook({
    state: baseState({ iteration: 2, max_iterations: 10 }),
    response: '',
  });
  assert.equal(decision.decision, 'approve');
  assert.doesNotMatch(debugLog, /No-op response detected/);
});

// ---------------------------------------------------------------------------
// Degenerate short / whitespace response detection — approve-only (B-RSHM:
// the consecutive-short-response BLOCK-nudge counter is retired)
// ---------------------------------------------------------------------------

test('stop-hook: whitespace-only response → approve, active unchanged', () => {
  const { decision, state, debugLog } = runHook({
    state: baseState({ iteration: 6, max_iterations: 50 }),
    response: '  \n\n',
  });
  assert.equal(decision.decision, 'approve');
  assert.equal(state.active, true, 'B-RSHM: hook never deactivates');
  assert.match(debugLog, /Whitespace-only response/);
});

test('stop-hook: 2-char response → approve immediately, no counter written (nudge retired)', () => {
  const { decision, state, debugLog } = runHook({
    state: baseState({ iteration: 6, max_iterations: 50 }),
    response: 'no',
  });
  assert.equal(decision.decision, 'approve', 'short manager output approves — mux-runner owns the respawn');
  assert.equal(state.active, true);
  assert.equal(state.consecutive_short_responses, undefined, 'counter field must never be written');
  assert.match(debugLog, /Degenerate short response/);
});

test('stop-hook: 10-char response → approve (degenerate boundary), no counter written', () => {
  const { decision, state, debugLog } = runHook({
    state: baseState({ iteration: 3, max_iterations: 50 }),
    response: '0123456789',
  });
  assert.equal(decision.decision, 'approve');
  assert.equal(state.consecutive_short_responses, undefined);
  assert.match(debugLog, /Degenerate short response/);
});

test('stop-hook: 11-char non-matching response → default approve (above degenerate threshold)', () => {
  const { decision, debugLog } = runHook({
    state: baseState({ iteration: 3, max_iterations: 50 }),
    response: '01234567890',
  });
  assert.equal(decision.decision, 'approve');
  assert.match(debugLog, /Interactive loop retired/, '11 chars is above the degenerate threshold — default path');
});

test('stop-hook: tab-only response → approve (whitespace-only detection)', () => {
  const { decision } = runHook({
    state: baseState({ iteration: 2, max_iterations: 50 }),
    response: '\t\t',
  });
  assert.equal(decision.decision, 'approve');
});

test('stop-hook: \\r\\n response → approve (whitespace-only detection)', () => {
  const { decision } = runHook({
    state: baseState({ iteration: 2, max_iterations: 50 }),
    response: '\r\n',
  });
  assert.equal(decision.decision, 'approve');
});

test('stop-hook: single newline response → approve (whitespace-only detection)', () => {
  const { decision } = runHook({
    state: baseState({ iteration: 2, max_iterations: 50 }),
    response: '\n',
  });
  assert.equal(decision.decision, 'approve');
});

test('stop-hook: short response in tmux mode → approve (runner owns the respawn)', () => {
  const { decision, state } = runHook({
    state: baseState({ tmux_mode: true, iteration: 3, max_iterations: 50 }),
    response: 'no',
  });
  assert.equal(decision.decision, 'approve');
  assert.equal(state.active, true, 'short response must not deactivate — runner handles lifecycle');
  assert.equal(state.consecutive_short_responses, undefined, 'counter field must never be written');
});

test('stop-hook: no-op "Acknowledged." (non-tmux) → approve, active unchanged', () => {
  const { decision, state } = runHook({
    state: baseState({ iteration: 3, max_iterations: 50 }),
    response: 'Acknowledged.',
  });
  assert.equal(decision.decision, 'approve');
  assert.equal(state.active, true, 'B-RSHM: hook never deactivates');
});

test('stop-hook: whitespace-only response in tmux mode → approve', () => {
  const { decision, state } = runHook({
    state: baseState({ tmux_mode: true, iteration: 3, max_iterations: 50 }),
    response: '  \n\n',
  });
  assert.equal(decision.decision, 'approve');
  assert.equal(state.active, true, 'whitespace approve must not deactivate');
});

// ---------------------------------------------------------------------------
// Consecutive-short-response counter RETIRED (B-RSHM WS-1) — short responses
// approve immediately; a stale persisted counter is ignored and never rewritten.
// ---------------------------------------------------------------------------

test('stop-hook: stale persisted counter is ignored and left untouched', () => {
  const { decision, state } = runHook({
    state: baseState({ iteration: 6, max_iterations: 50, consecutive_short_responses: 2 }),
    response: 'Waiting.',
  });
  assert.equal(decision.decision, 'approve', 'short response approves immediately — no counting');
  assert.equal(state.active, true);
  assert.equal(state.consecutive_short_responses, 2, 'stale optional field is left exactly as persisted');
});

test('stop-hook: worker + short response → approve immediately', () => {
  const { decision } = runHook({
    state: baseState({ iteration: 2, max_iterations: 50 }),
    response: 'wait',
    role: 'worker',
  });
  assert.equal(decision.decision, 'approve', 'worker short response exits immediately (own lifecycle)');
});

test('stop-hook: refinement-worker + short response → approve immediately', () => {
  const { decision } = runHook({
    state: baseState({ iteration: 2, max_iterations: 50 }),
    response: 'wait',
    role: 'refinement-worker',
  });
  assert.equal(decision.decision, 'approve');
});

test('stop-hook: substantive response with stale counter → default approve, counter untouched', () => {
  const longResponse = 'I finished editing utils.ts and the tests are passing. Here is a detailed summary of the work.';
  assert.ok(longResponse.length > 10);
  const { decision, state, debugLog } = runHook({
    state: baseState({ iteration: 4, max_iterations: 50, consecutive_short_responses: 2 }),
    response: longResponse,
  });
  assert.equal(decision.decision, 'approve');
  assert.equal(state.consecutive_short_responses, 2, 'no reset write — the counter has no runtime writer');
  assert.match(debugLog, /Interactive loop retired/);
});

// ---------------------------------------------------------------------------
// F19: empty stdin + corrupted JSON handling
// ---------------------------------------------------------------------------

test('stop-hook: empty stdin → approve silently, no debug log written', () => {
  const { decision, debugLog } = runHookRaw({ stdin: '' });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(debugLog, '', 'must not write any log entry for empty stdin');
});

test('stop-hook: whitespace-only stdin → approve silently', () => {
  const { decision, debugLog } = runHookRaw({ stdin: '   \n  ' });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(debugLog, '', 'must not write any log entry for whitespace stdin');
});

test('stop-hook: corrupted non-empty JSON → warn with 100-char preview, approve fail-open', () => {
  const corrupted = '{"broken": this is not valid json because values cannot be unquoted}';
  const { decision, debugLog } = runHookRaw({ stdin: corrupted });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.ok(debugLog.includes('WARN: corrupted hook input'), 'must log a WARN about corrupted input');
  assert.ok(debugLog.includes(corrupted.slice(0, 40)), 'must include a preview of the corrupted input');
});

test('stop-hook: corrupted input longer than 100 chars → preview truncated with ellipsis', () => {
  const corrupted = 'x'.repeat(200) + ' not json';
  const { decision, debugLog } = runHookRaw({ stdin: corrupted });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.ok(debugLog.includes('...'), 'must include ellipsis when input exceeds 100 chars');
  assert.ok(!debugLog.includes(corrupted), 'must not log the full input');
});

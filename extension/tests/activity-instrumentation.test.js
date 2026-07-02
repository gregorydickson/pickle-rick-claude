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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseState(overrides = {}) {
  return {
    active: true,
    // Live owning pid so the R-PTSB-3 phantom-demotion guard does not demote
    // these active manager fixtures on read (which would suppress the lifecycle
    // activity events under test); demotion tests override pid/active explicitly.
    pid: process.pid,
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

/**
 * Run stop-hook.js and return { decision, state, activityEvents }.
 * activityEvents is an array of parsed JSONL lines from the activity dir.
 */
function runHookWithActivity(opts = {}) {
  const { state = baseState(), response = '', role = undefined } = opts;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-'));
  const sessionDir = path.join(tmpDir, 'session');
  fs.mkdirSync(sessionDir);
  const stateFile = path.join(sessionDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(state));

  fs.writeFileSync(
    path.join(tmpDir, 'current_sessions.json'),
    JSON.stringify({ [process.cwd()]: sessionDir })
  );

  const env = {
    ...process.env,
    EXTENSION_DIR: tmpDir,
    FORCE_COLOR: '0',
    PICKLE_STATE_FILE: stateFile,
    NODE_ENV: 'test',
    EXTENSION_DIR_TEST: '1',
  };
  delete env.PICKLE_ROLE;
  if (role !== undefined) env.PICKLE_ROLE = role;

  try {
    const stdout = execFileSync(process.execPath, [STOP_HOOK], {
      input: JSON.stringify({ last_assistant_message: response }),
      encoding: 'utf-8',
      env,
    });

    const activityDir = path.join(tmpDir, 'activity');
    let activityEvents = [];
    if (fs.existsSync(activityDir)) {
      for (const f of fs.readdirSync(activityDir)) {
        if (f.endsWith('.jsonl')) {
          const lines = fs.readFileSync(path.join(activityDir, f), 'utf-8').trim().split('\n').filter(Boolean);
          activityEvents.push(...lines.map(l => JSON.parse(l)));
        }
      }
    }

    return {
      decision: JSON.parse(stdout.trim()),
      state: JSON.parse(fs.readFileSync(stateFile, 'utf-8')),
      activityEvents,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// stop-hook: per-token activity events
// ---------------------------------------------------------------------------

test('activity: EXISTENCE_IS_PAIN emits meeseeks_pass', () => {
  const { activityEvents } = runHookWithActivity({
    state: baseState({ iteration: 5 }),
    response: '<promise>EXISTENCE_IS_PAIN</promise>',
  });
  assert.equal(activityEvents.length, 1);
  assert.equal(activityEvents[0].event, 'meeseeks_pass');
  assert.equal(activityEvents[0].source, 'pickle');
  assert.equal(activityEvents[0].pass, 5);
  assert.ok(activityEvents[0].session, 'should have session ID');
});

test('activity: THE_CITADEL_APPROVES emits meeseeks_pass', () => {
  const { activityEvents } = runHookWithActivity({
    state: baseState({ iteration: 3 }),
    response: '<promise>THE_CITADEL_APPROVES</promise>',
  });
  assert.equal(activityEvents.length, 1);
  assert.equal(activityEvents[0].event, 'meeseeks_pass');
  assert.equal(activityEvents[0].source, 'pickle');
  assert.equal(activityEvents[0].pass, 3);
  assert.ok(activityEvents[0].session, 'should have session ID');
});

test('activity: EPIC_COMPLETED emits epic_completed', () => {
  const { activityEvents } = runHookWithActivity({
    state: baseState({ original_prompt: 'Build the portal gun' }),
    response: '<promise>EPIC_COMPLETED</promise>',
  });
  assert.equal(activityEvents.length, 1);
  assert.equal(activityEvents[0].event, 'epic_completed');
  assert.equal(activityEvents[0].source, 'pickle');
  assert.equal(activityEvents[0].epic, 'Build the portal gun');
});

test('activity: TASK_COMPLETED (non-worker) emits ticket_completed', () => {
  const { activityEvents } = runHookWithActivity({
    state: baseState({ current_ticket: 'abc123', step: 'implement' }),
    response: '<promise>TASK_COMPLETED</promise>',
  });
  assert.equal(activityEvents.length, 1);
  assert.equal(activityEvents[0].event, 'ticket_completed');
  assert.equal(activityEvents[0].ticket, 'abc123');
  assert.equal(activityEvents[0].step, 'implement');
});

test('activity: worker + I AM DONE emits NO events', () => {
  const { activityEvents } = runHookWithActivity({
    response: '<promise>I AM DONE</promise>',
    role: 'worker',
  });
  assert.equal(activityEvents.length, 0, 'workers must not emit activity events');
});

test('activity: refinement-worker + ANALYSIS_DONE emits NO events', () => {
  const { activityEvents } = runHookWithActivity({
    response: '<promise>ANALYSIS_DONE</promise>',
    role: 'refinement-worker',
  });
  assert.equal(activityEvents.length, 0, 'refinement workers must not emit activity events');
});

test('activity: TASK_COMPLETED with null current_ticket still emits ticket_completed', () => {
  const { activityEvents } = runHookWithActivity({
    state: baseState({ current_ticket: null, step: 'implement' }),
    response: '<promise>TASK_COMPLETED</promise>',
  });
  assert.equal(activityEvents.length, 1);
  assert.equal(activityEvents[0].event, 'ticket_completed');
  assert.equal(activityEvents[0].ticket, undefined, 'null current_ticket should produce undefined ticket');
  assert.equal(activityEvents[0].step, 'implement');
});

test('activity: custom completion_promise emits NO per-token events', () => {
  const { activityEvents } = runHookWithActivity({
    state: baseState({ completion_promise: 'MY_CUSTOM' }),
    response: '<promise>MY_CUSTOM</promise>',
  });
  assert.equal(activityEvents.length, 0, 'custom promise tokens must not emit activity events');
});

// ---------------------------------------------------------------------------
// stop-hook: limit exits emit NO session_end (B-RSHM WS-1 — the inline
// session-end emission was retired with the non-tmux interactive loop; runners
// own session lifecycle events)
// ---------------------------------------------------------------------------

test('activity: max iterations limit (non-tmux) emits NO session_end', () => {
  const { activityEvents } = runHookWithActivity({
    state: baseState({ iteration: 5, max_iterations: 5 }),
  });
  assert.equal(activityEvents.length, 0, 'stop-hook no longer emits session_end on limit exits');
});

test('activity: time limit (non-tmux) emits NO session_end', () => {
  const { activityEvents } = runHookWithActivity({
    state: baseState({
      start_time_epoch: Math.floor(Date.now() / 1000) - 3700,
      max_time_minutes: 60,
    }),
  });
  assert.equal(activityEvents.length, 0, 'stop-hook no longer emits session_end on limit exits');
});

test('activity: max iterations limit (tmux) does NOT emit session_end', () => {
  const { activityEvents } = runHookWithActivity({
    state: baseState({ iteration: 5, max_iterations: 5, tmux_mode: true }),
  });
  assert.equal(activityEvents.length, 0, 'tmux sessions should not emit session_end from stop-hook');
});

test('activity: time limit (tmux) does NOT emit session_end', () => {
  const { activityEvents } = runHookWithActivity({
    state: baseState({
      start_time_epoch: Math.floor(Date.now() / 1000) - 3700,
      max_time_minutes: 60,
      tmux_mode: true,
    }),
  });
  assert.equal(activityEvents.length, 0, 'tmux sessions should not emit session_end from stop-hook');
});

// ---------------------------------------------------------------------------
// stop-hook: no events on default block or bypass
// ---------------------------------------------------------------------------

test('activity: default block (no tokens) emits NO events', () => {
  const { activityEvents } = runHookWithActivity({
    response: 'just doing work',
  });
  assert.equal(activityEvents.length, 0);
});

test('activity: inactive session emits NO events', () => {
  const { activityEvents } = runHookWithActivity({
    state: baseState({ active: false }),
  });
  assert.equal(activityEvents.length, 0);
});

// @tier: integration
/**
 * mux-loop.test.js — Mux-runner loop logic integration tests.
 *
 * Tests two key mux-runner loop scenarios using its exported pure functions:
 *
 * 1. success/rate_limit/success (wait+resume):
 *    - Iteration 1 succeeds → consecutiveRateLimits stays 0
 *    - Iteration 2 hits rate limit → computeRateLimitAction returns 'wait'
 *    - Iteration 3 succeeds → counter resets to 0
 *
 * 2. success/success/stall with CB open (deactivated):
 *    - canExecute(OPEN state) → false → state.active set to false
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateManager } from '../../services/state-manager.js';
import { writeStateFile } from '../../services/pickle-utils.js';
import { canExecute } from '../../services/circuit-breaker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  classifyCompletion,
  classifyIterationExit,
  computeRateLimitAction,
  loadRateLimitSettings,
  detectRateLimitInText,
} = await import(path.resolve(__dirname, '../../bin/mux-runner.js'));

function tmpDir(prefix = 'pickle-ml-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeState(overrides = {}) {
  return {
    active: true,
    working_dir: '/tmp/test',
    step: 'implement',
    iteration: 3,
    max_iterations: 20,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'mux loop test',
    current_ticket: 'TICK-001',
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/test-session',
    schema_version: 1,
    ...overrides,
  };
}

// Helper: build a stream-json formatted log line with assistant message
function assistantLine(text) {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  });
}

// Helper: build a result line (alternative format)
function resultLine(text) {
  return JSON.stringify({ type: 'result', result: text });
}

// ---------------------------------------------------------------------------
// classifyCompletion — token detection in assistant output
// ---------------------------------------------------------------------------

test('ML-1: classifyCompletion — EPIC_COMPLETED in assistant content → task_completed', () => {
  const output = assistantLine('All tickets done! <promise>EPIC_COMPLETED</promise>');
  assert.equal(classifyCompletion(output), 'task_completed');
});

test('ML-2: classifyCompletion — EXISTENCE_IS_PAIN in result → review_clean', () => {
  const output = resultLine('Review passed. <promise>EXISTENCE_IS_PAIN</promise>');
  assert.equal(classifyCompletion(output), 'review_clean');
});

test('ML-3: classifyCompletion — THE_CITADEL_APPROVES in assistant content → review_clean', () => {
  const output = assistantLine('Citadel approves! <promise>THE_CITADEL_APPROVES</promise>');
  assert.equal(classifyCompletion(output), 'review_clean');
});

test('ML-4: classifyCompletion — no tokens → continue', () => {
  const output = assistantLine('Working on the implementation...');
  assert.equal(classifyCompletion(output), 'continue');
});

test('ML-5: classifyCompletion — TASK_COMPLETED (single ticket done) → continue (not epic exit)', () => {
  // TASK_COMPLETED is a single-ticket token — does NOT trigger loop exit
  const output = assistantLine('Ticket done! <promise>TASK_COMPLETED</promise>');
  assert.equal(classifyCompletion(output), 'continue');
});

test('ML-6: classifyCompletion — token in user/tool_result content is ignored (no false positive)', () => {
  // The user message contains EPIC_COMPLETED in a code review context —
  // classifyCompletion must filter it out (only assistant content counts).
  const userLine = JSON.stringify({
    type: 'user',
    message: { content: '<promise>EPIC_COMPLETED</promise>' },
  });
  const toolLine = JSON.stringify({
    type: 'tool_result',
    content: '<promise>EPIC_COMPLETED</promise>',
  });
  const output = [userLine, toolLine].join('\n');
  assert.equal(classifyCompletion(output), 'continue', 'must not trigger on user/tool_result content');
});

test('ML-7: classifyCompletion — EPIC_COMPLETED in plain text (non-JSON) → task_completed', () => {
  // Plain text mode (no JSON lines) — entire output treated as assistant content
  const output = 'All work is done. <promise>EPIC_COMPLETED</promise>';
  assert.equal(classifyCompletion(output), 'task_completed');
});

// ---------------------------------------------------------------------------
// Scenario 1: success / rate_limit / success (wait + resume)
//
// Simulates 3 consecutive iterations of the mux-runner loop using the
// pure exported functions that govern rate limit decisions.
// ---------------------------------------------------------------------------

test('ML-8: rate_limit sequence — iter1 success keeps counter at 0', () => {
  const dir = tmpDir();
  try {
    const logFile = path.join(dir, 'iter1.log');
    fs.writeFileSync(logFile, assistantLine('Done. <promise>TASK_COMPLETED</promise>') + '\n');

    let consecutiveRateLimits = 0;
    const exit1 = classifyIterationExit('task_completed', logFile);
    assert.equal(exit1.type, 'success');

    if (exit1.type === 'success') consecutiveRateLimits = 0;
    assert.equal(consecutiveRateLimits, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ML-9: rate_limit sequence — iter2 rate_limit increments counter, action=wait', () => {
  const dir = tmpDir();
  try {
    const logFile = path.join(dir, 'iter2.log');
    const rlEvent = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: null, rateLimitType: 'hour' },
    });
    fs.writeFileSync(logFile, rlEvent + '\n');

    let consecutiveRateLimits = 0;
    const exit2 = classifyIterationExit('continue', logFile);
    assert.equal(exit2.type, 'api_limit');

    consecutiveRateLimits++;
    const action = computeRateLimitAction(exit2, consecutiveRateLimits, 3, 60);
    assert.equal(action.action, 'wait');
    assert.equal(action.waitSource, 'config'); // no resetsAt → config source
    assert.equal(consecutiveRateLimits, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ML-10: rate_limit sequence — iter3 success resets counter to 0 (resume after wait)', () => {
  const dir = tmpDir();
  try {
    const logFile = path.join(dir, 'iter3.log');
    fs.writeFileSync(logFile, assistantLine('Resuming. <promise>EPIC_COMPLETED</promise>') + '\n');

    let consecutiveRateLimits = 1; // from iter2
    const exit3 = classifyIterationExit('task_completed', logFile);
    assert.equal(exit3.type, 'success');

    // Mirrors: if (exitType === 'success') consecutiveRateLimits = 0;
    if (exit3.type === 'success') consecutiveRateLimits = 0;
    assert.equal(consecutiveRateLimits, 0, 'counter must reset to 0 after success');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ML-11: rate_limit sequence — bail when consecutive exhausts retries (no resetsAt)', () => {
  // Simulates: 3 consecutive rate limits, no API reset time → bail
  let consecutiveRateLimits = 0;
  const maxRetries = 3;

  for (let i = 0; i < maxRetries; i++) {
    consecutiveRateLimits++;
    const action = computeRateLimitAction({ type: 'api_limit', rateLimitInfo: null }, consecutiveRateLimits, maxRetries, 60);
    if (i < maxRetries - 1) {
      assert.equal(action.action, 'wait', `iter ${i + 1}: should still wait`);
    } else {
      assert.equal(action.action, 'bail', `iter ${maxRetries}: should bail at max retries`);
    }
  }
});

test('ML-12: rate_limit sequence — API resetsAt always waits even past max retries', () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 1800;
  // 10 consecutive limits, max=3, but resetsAt is available → always wait
  const action = computeRateLimitAction(
    { type: 'api_limit', rateLimitInfo: { limited: true, resetsAt, rateLimitType: 'hour' } },
    10,
    3,
    60,
  );
  assert.equal(action.action, 'wait', 'API resetsAt overrides bail logic');
  assert.equal(action.resetCounter, true, 'API-guided wait must reset counter on resume');
});

// ---------------------------------------------------------------------------
// Scenario 2: success/success/stall with circuit breaker open → deactivated
//
// When the CB transitions to OPEN, canExecute returns false and the runner
// calls safeDeactivate. Tests the CB gating + state deactivation.
// ---------------------------------------------------------------------------

test('ML-13: CB OPEN state — canExecute returns false', () => {
  const openState = {
    state: 'OPEN',
    reason: 'Identical errors for 3 consecutive iterations',
    failure_count: 3,
    success_count: 0,
    last_failure_at: Date.now(),
    last_known_head: null,
    last_known_step: 'implement',
    last_known_ticket: null,
  };
  assert.equal(canExecute(openState), false, 'OPEN circuit must block execution');
});

test('ML-14: CB CLOSED state — canExecute returns true', () => {
  const closedState = { state: 'CLOSED', reason: null };
  assert.equal(canExecute(closedState), true);
});

test('ML-15: CB HALF_OPEN state — canExecute returns true (probe allowed)', () => {
  const halfOpenState = { state: 'HALF_OPEN', reason: 'Recovery probe' };
  assert.equal(canExecute(halfOpenState), true);
});

test('ML-16: CB open → safeDeactivate sets active=false (session deactivated)', () => {
  const dir = tmpDir();
  try {
    const statePath = path.join(dir, 'state.json');
    const sm = new StateManager();
    writeStateFile(statePath, makeState({ active: true, iteration: 5 }));

    // Simulate safeDeactivate: sm.update sets active=false
    sm.update(statePath, s => { s.active = false; });

    const state = sm.read(statePath);
    assert.equal(state.active, false, 'state.active must be false after CB open deactivation');

    // Verify persisted
    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(onDisk.active, false, 'deactivation must be written to disk');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// loadRateLimitSettings — settings parsing
// ---------------------------------------------------------------------------

test('ML-23: loadRateLimitSettings — returns defaults when no settings file', () => {
  const dir = tmpDir();
  try {
    const extRoot = path.join(dir, 'ext');
    fs.mkdirSync(extRoot, { recursive: true });
    // No pickle_settings.json

    const { waitMinutes, maxRetries } = loadRateLimitSettings(extRoot);
    assert.equal(waitMinutes, 5, 'default wait is 5 minutes');
    assert.equal(maxRetries, 3, 'default max retries is 3');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ML-24: loadRateLimitSettings — reads custom values from pickle_settings.json', () => {
  const dir = tmpDir();
  try {
    const extRoot = path.join(dir, 'ext');
    fs.mkdirSync(extRoot, { recursive: true });
    fs.writeFileSync(
      path.join(extRoot, 'pickle_settings.json'),
      JSON.stringify({ default_rate_limit_wait_minutes: 30, default_max_rate_limit_retries: 5 }),
    );

    const { waitMinutes, maxRetries } = loadRateLimitSettings(extRoot);
    assert.equal(waitMinutes, 30);
    assert.equal(maxRetries, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ML-25: loadRateLimitSettings — ignores sub-1 values (uses defaults)', () => {
  const dir = tmpDir();
  try {
    const extRoot = path.join(dir, 'ext');
    fs.mkdirSync(extRoot, { recursive: true });
    fs.writeFileSync(
      path.join(extRoot, 'pickle_settings.json'),
      JSON.stringify({ default_rate_limit_wait_minutes: 0, default_max_rate_limit_retries: 0 }),
    );

    const { waitMinutes, maxRetries } = loadRateLimitSettings(extRoot);
    assert.equal(waitMinutes, 5, 'zero wait must use default');
    assert.equal(maxRetries, 3, 'zero retries must use default');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

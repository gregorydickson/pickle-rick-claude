// @tier: fast
// Forward test for AC-R-RESH-2: false-completion guard before EPIC finalizeTerminalState.
// Covers three scenarios: pending ticket blocks finalize, all-Done/Skipped finalizes, and
// limit-path (exit_reason:'limit') finalizes even with a pending ticket (guard not applied).

// PICKLE_TEST_MODE bypasses guardCompletionCommitBeforeDone for synthetic sessions.
process.env.PICKLE_TEST_MODE = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyAllTicketsDoneCompletion, processCompletionBranch } from '../bin/mux-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeTmp(prefix = 'pr-fcg-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeSession(sessionDir, opts = {}) {
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    schema_version: 3,
    active: true,
    step: 'implement',
    iteration: 1,
    max_iterations: 15,
    worker_timeout_seconds: 3600,
    start_time_epoch: opts.start_time_epoch ?? Math.floor(Date.now() / 1000),
    max_time_minutes: opts.max_time_minutes ?? 0,
    current_ticket: opts.current_ticket ?? null,
    working_dir: opts.working_dir ?? sessionDir,
    backend: opts.backend ?? 'claude',
    completion_promise: null,
    history: [],
  }, null, 2));
  return statePath;
}

function makeTicket(sessionDir, id, status, opts = {}) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  const lines = [
    '---',
    `id: "${id}"`,
    `title: "Ticket ${id}"`,
    `status: "${status}"`,
    'order: 1',
  ];
  if (opts.completion_commit) lines.push(`completion_commit: "${opts.completion_commit}"`);
  lines.push('---', '', '# Body');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${id}.md`), lines.join('\n'));
}

function withDataRoot(dataRoot, fn) {
  const prev = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prev;
  }
}

// --- applyAllTicketsDoneCompletion guard tests ---

test('false-completion guard: Todo ticket blocks applyAllTicketsDoneCompletion', () => {
  const sessionDir = makeTmp();
  try {
    const statePath = makeSession(sessionDir);
    makeTicket(sessionDir, 'aaa', 'Done');
    makeTicket(sessionDir, 'bbb', 'Todo');

    const logs = [];
    const fired = applyAllTicketsDoneCompletion(statePath, sessionDir, 1, m => logs.push(m), sessionDir);

    assert.equal(fired, false, 'should return false with a Todo ticket');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.notEqual(state.step, 'completed', 'step must NOT be completed');
    assert.equal(state.active, true, 'active must remain true');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('false-completion guard: all-Done tickets finalize via applyAllTicketsDoneCompletion', () => {
  const sessionDir = makeTmp();
  try {
    const statePath = makeSession(sessionDir);
    makeTicket(sessionDir, 'aaa', 'Done');
    makeTicket(sessionDir, 'bbb', 'Done');

    const logs = [];
    const fired = applyAllTicketsDoneCompletion(statePath, sessionDir, 1, m => logs.push(m), sessionDir);

    assert.equal(fired, true, 'should return true when all tickets are Done');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.step, 'completed', 'state.step must be completed');
    assert.equal(state.active, false, 'active must be false after finalize');
    assert.equal(state.exit_reason, 'completed', 'exit_reason must be completed');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('false-completion guard: Done+Skipped mix finalizes via applyAllTicketsDoneCompletion', () => {
  const sessionDir = makeTmp();
  try {
    const statePath = makeSession(sessionDir);
    makeTicket(sessionDir, 'aaa', 'Done');
    makeTicket(sessionDir, 'bbb', 'Skipped');
    makeTicket(sessionDir, 'ccc', 'Done');

    const logs = [];
    const fired = applyAllTicketsDoneCompletion(statePath, sessionDir, 1, m => logs.push(m), sessionDir);

    assert.equal(fired, true, 'should return true when all tickets are Done or Skipped');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.step, 'completed', 'state.step must be completed');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('false-completion guard: In Progress ticket blocks applyAllTicketsDoneCompletion', () => {
  const sessionDir = makeTmp();
  try {
    const statePath = makeSession(sessionDir);
    makeTicket(sessionDir, 'aaa', 'Done');
    makeTicket(sessionDir, 'bbb', 'In Progress');

    const fired = applyAllTicketsDoneCompletion(statePath, sessionDir, 1, () => {}, sessionDir);

    assert.equal(fired, false, 'should return false when a ticket is In Progress');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.active, true, 'active must remain true');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('false-completion guard: Failed ticket blocks applyAllTicketsDoneCompletion', () => {
  // The terminal predicate is done||skipped. A Failed ticket is the realistic post-error
  // non-terminal case (distinct from Todo/In Progress) and MUST block finalize — otherwise a
  // bundle with an unresolved failure could be sealed as completed.
  const sessionDir = makeTmp();
  try {
    const statePath = makeSession(sessionDir);
    makeTicket(sessionDir, 'aaa', 'Done');
    makeTicket(sessionDir, 'bbb', 'Failed');

    const fired = applyAllTicketsDoneCompletion(statePath, sessionDir, 1, () => {}, sessionDir);

    assert.equal(fired, false, 'should return false when a ticket is Failed');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.notEqual(state.step, 'completed', 'step must NOT be completed with a Failed ticket');
    assert.equal(state.active, true, 'active must remain true');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// --- processTaskCompleted (genuine-EPIC seam) tests ---
// processCompletionBranch('task_completed', ...) routes to processTaskCompleted, whose
// genuine-EPIC exit calls ctxFinalize(ctx, 'success'). A pending (non-Done/Skipped) ticket
// MUST route to recovery (kind:'continue'), never finalize step:'completed'.

function makeTaskCompletedCtx(sessionDir, statePath, logs) {
  return {
    sessionDir,
    statePath,
    extensionRoot: path.resolve(__dirname, '../../'),
    iteration: 1,
    log: m => logs.push(m),
    cbEnabled: false,
    cbState: null,
    outcome: { completion: 'task_completed', timedOut: false, exitCode: 0 },
    iterLogFile: path.join(sessionDir, 'tmux_iteration_1.log'),
    maxTurns: null,
  };
}

test('false-completion guard: Todo ticket routes EPIC seam to recovery (not finalize)', async () => {
  const sessionDir = makeTmp();
  const dataRoot = makeTmp('pr-fcg-data-');
  try {
    // current_ticket null + one Done + one Todo: evaluateEpicCompletion sees a pending ticket
    // and routes to recover_* (continue) BEFORE the genuine finalize — proving the manager-exit
    // EPIC seam never finalizes step:'completed' while a ticket is non-terminal.
    const statePath = makeSession(sessionDir, { current_ticket: null });
    makeTicket(sessionDir, 'aaa', 'Done', { completion_commit: 'a'.repeat(8) });
    makeTicket(sessionDir, 'bbb', 'Todo');

    const logs = [];
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const ctx = makeTaskCompletedCtx(sessionDir, statePath, logs);

    let action;
    await withDataRoot(dataRoot, async () => {
      action = await processCompletionBranch(state, 'task_completed', ctx);
    });

    assert.equal(action.kind, 'continue', `expected continue (recovery), got '${action.kind}'`);
    const finalState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.notEqual(finalState.step, 'completed', 'step must NOT be completed with a Todo ticket');
    assert.notEqual(finalState.exit_reason, 'completed', 'exit_reason must NOT be completed');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('false-completion guard: all-Done EPIC seam finalizes step:completed (guard pass-through)', async () => {
  const sessionDir = makeTmp();
  const dataRoot = makeTmp('pr-fcg-data-');
  try {
    const statePath = makeSession(sessionDir, { current_ticket: null });
    makeTicket(sessionDir, 'aaa', 'Done', { completion_commit: 'a'.repeat(8) });
    makeTicket(sessionDir, 'bbb', 'Done', { completion_commit: 'b'.repeat(8) });

    const logs = [];
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const ctx = makeTaskCompletedCtx(sessionDir, statePath, logs);

    let action;
    await withDataRoot(dataRoot, async () => {
      action = await processCompletionBranch(state, 'task_completed', ctx);
    });

    assert.equal(action.kind, 'break', `expected break (finalize), got '${action.kind}'`);
    assert.equal(action.reason, 'success', `expected reason=success, got '${action.reason}'`);
    const finalState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(finalState.step, 'completed', 'step must be completed when all tickets Done');
    assert.equal(finalState.active, false, 'active must be false after finalize');
    assert.ok(
      logs.some(l => l.includes('false-completion guard')) === false,
      'guard must NOT log a refusal when all tickets are terminal',
    );
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// --- limit path unaffected ---

test('false-completion guard: limit path finalizes even with pending ticket (guard not applied)', async () => {
  // The 'limit' finalizeTerminalState at lines 6507/6564 is NOT guarded.
  // Set up a session with a Todo ticket and an already-expired time limit so that
  // processCompletionBranch(result='inactive') routes through the time_limit path,
  // which should finalize despite the pending ticket.
  const sessionDir = makeTmp();
  const dataRoot = makeTmp('pr-fcg-data-');
  try {
    const ticketId = 'ticket-limit-test';
    makeTicket(sessionDir, ticketId, 'Todo');

    // State with a very old start_time_epoch and 1-minute budget → time_limit exceeded.
    const statePath = makeSession(sessionDir, {
      current_ticket: ticketId,
      start_time_epoch: 1,
      max_time_minutes: 1,
      backend: 'claude',
    });

    const logs = [];
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const ctx = {
      sessionDir,
      statePath,
      extensionRoot: path.resolve(__dirname, '../../'),
      iteration: 1,
      log: m => logs.push(m),
      cbEnabled: false,
      cbState: null,
      // outcome triggers detectManagerInactiveExit → true
      outcome: { completion: 'inactive', timedOut: false, exitCode: null },
      // Non-existent log file: detectManagerMaxTurnsExit checks completion!=='error' first → returns false
      iterLogFile: path.join(sessionDir, 'tmux_iteration_1.log'),
      maxTurns: null,
    };

    let action;
    await withDataRoot(dataRoot, async () => {
      action = await processCompletionBranch(state, 'inactive', ctx);
    });

    // The time_limit path finalizes with exitReason:'limit' regardless of pending tickets.
    assert.equal(action.kind, 'break', `expected kind=break for time_limit path, got '${action.kind}'`);
    assert.equal(action.reason, 'limit', `expected reason=limit for time_limit path, got '${action.reason}'`);

    // Verify finalized state has exitReason:'limit' (not 'completed')
    const finalState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(finalState.exit_reason, 'limit', 'exit_reason must be limit for time_limit path');
    assert.equal(finalState.step, 'completed', 'step must be completed after time_limit finalize');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

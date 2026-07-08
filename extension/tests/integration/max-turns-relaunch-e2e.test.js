// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMaxTurnsRelaunchE2E } from './mmtr6-harness.ts';
import { evaluateManagerRelaunch } from '../../bin/mux-runner.js';
import { managerRelaunchCapForBackend } from '../../services/manager-relaunch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build a minimal session fixture dir with nDone Done tickets and nPending
 * pending (Todo) tickets. Returns the fixture dir path (caller must clean up).
 */
function makeSessionFixture(nDone, nPending, stateOverrides = {}) {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mmtr6-e2e-fix-')),
  );
  const total = nDone + nPending;
  for (let i = 1; i <= total; i++) {
    const id = 'f' + String(i).padStart(7, '0');
    const status = i <= nDone ? 'Done' : 'Todo';
    const ticketDir = path.join(dir, id);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, `rick_ticket_${id}.md`),
      [
        '---',
        `id: ${id}`,
        `title: ${id} fixture`,
        `status: ${status}`,
        `order: ${i}`,
        '---',
        '',
        '# Fixture',
      ].join('\n'),
    );
  }
  const currentTicket = nDone > 0
    ? 'f' + String(nDone).padStart(7, '0')
    : 'f0000001';
  const state = {
    active: true,
    backend: 'claude',
    working_dir: dir,
    step: 'implement',
    iteration: 3,
    max_iterations: 20,
    // max_time_minutes: 0 disables the wall-clock cap in evaluateManagerRelaunch
    max_time_minutes: 0,
    worker_timeout_seconds: 1200,
    start_time_epoch: 0,
    completion_promise: null,
    original_prompt: 'mmtr6 e2e fixture',
    current_ticket: currentTicket,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: dir,
    schema_version: 1,
    manager_relaunch_count: 0,
    ...stateOverrides,
  };
  fs.writeFileSync(
    path.join(dir, 'session_state.json'),
    JSON.stringify(state, null, 2),
  );
  return dir;
}

// ── Scenario 1: clean relaunch ────────────────────────────────────────────────

test('max-turns-relaunch-e2e: clean relaunch — one max-turns exit with pending tickets, relaunch, drain to all-Done', async () => {
  // 19 Done + 1 pending. After one manager_max_turns_relaunch event the single
  // pending ticket advances to Done, so doneCount===20 and manager_relaunch_count===1.
  // No deactivate (teardownReason remains null — harness stopped normally).
  const fixture = makeSessionFixture(19, 1);
  try {
    const result = await runMaxTurnsRelaunchE2E({
      sessionFixture: fixture,
      expectedRelaunchCount: 1,
      expectedDoneCount: 20,
    });

    assert.equal(
      result.relaunchCount,
      1,
      `expected exactly 1 manager_max_turns_relaunch relaunch, got ${result.relaunchCount}`,
    );
    assert.equal(
      result.doneCount,
      20,
      `expected all 20 tickets Done after clean relaunch drain, got ${result.doneCount}`,
    );
    // teardownReason===null means no break action from processIterationOutcome —
    // the harness stopped normally after reaching expectedRelaunchCount (no deactivate).
    assert.equal(
      result.teardownReason,
      null,
      `expected no deactivate when manager_relaunch_count===1 is below cap, got teardownReason=${result.teardownReason}`,
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

// ── Scenario 2: consecutive relaunches up to cap ──────────────────────────────

test('max-turns-relaunch-e2e: consecutive relaunches up to cap — repeated max-turns exits with progress, queue drains all-Done', async () => {
  // Default fixture: 10 Done + 10 pending (mmtr6-synthetic-session).
  // 10 manager_max_turns_relaunch events fire, each advancing one ticket.
  // manager_relaunch_count increments each pass: well below CLAUDE_MANAGER_RELAUNCH_CAP (20).
  const DEFAULT_FIXTURE = path.join(
    __dirname,
    '../fixtures/mmtr6-synthetic-session',
  );
  const result = await runMaxTurnsRelaunchE2E({
    sessionFixture: DEFAULT_FIXTURE,
    expectedRelaunchCount: 10,
    expectedDoneCount: 20,
  });

  assert.equal(
    result.relaunchCount,
    10,
    `expected manager_relaunch_count to reach 10 (one manager_max_turns_relaunch per pass), got ${result.relaunchCount}`,
  );
  assert.equal(
    result.doneCount,
    20,
    `expected all 20 tickets Done after consecutive relaunch drain, got ${result.doneCount}`,
  );
  assert.equal(
    result.teardownReason,
    null,
    `expected no premature teardown below CLAUDE_MANAGER_RELAUNCH_CAP, got ${result.teardownReason}`,
  );
});

// ── Scenario 3: cap-exceeded / no-progress halt ───────────────────────────────

test('max-turns-relaunch-e2e: cap-exceeded / no-progress halt — loop halts rather than relaunching at CLAUDE_MANAGER_RELAUNCH_CAP', async () => {
  // manager_relaunch_count starts at cap-1.
  // Pass 0: relaunch eligible (count < cap) → increments count to cap, advances 1 ticket.
  // Pass 1: evaluateManagerRelaunch returns reason:'cap_exceeded' (count===cap) →
  //   processCompletionBranch breaks with reason:'error' + ctxDeactivate().
  // codex_manager_no_progress variant: 2 zero-progress codex passes also halt the loop.
  const claudeCap = managerRelaunchCapForBackend('claude');
  const fixture = makeSessionFixture(10, 10, { manager_relaunch_count: claudeCap - 1 });
  try {
    const result = await runMaxTurnsRelaunchE2E({
      sessionFixture: fixture,
      expectedRelaunchCount: 100,
      expectedDoneCount: 11,
    });

    // Loop must halt via cap_exceeded — teardownReason is non-null (break action fired)
    assert.ok(
      result.teardownReason !== null,
      'expected loop to halt when cap exceeded (teardownReason must be set, not null)',
    );
    // Tickets remain pending — not all Done (halt happened before queue drained)
    assert.ok(
      result.doneCount < 20,
      `expected pending tickets to remain after cap-exceeded halt, got doneCount=${result.doneCount}`,
    );

    // Direct verification: evaluateManagerRelaunch returns reason:'cap_exceeded' at claudeCap.
    // This is the claude path; codex path emits codex_manager_no_progress activity event instead.
    const pendingTickets = [{ id: 'f0000001', status: 'Todo', order: 1, title: 'fixture' }];
    const capEval = evaluateManagerRelaunch(
      {
        backend: 'claude',
        manager_relaunch_count: claudeCap,
        max_time_minutes: 0,
        start_time_epoch: 0,
      },
      pendingTickets,
      null,
      'claude_max_turns',
    );
    assert.equal(
      capEval.reason,
      'cap_exceeded',
      `evaluateManagerRelaunch must return cap_exceeded when manager_relaunch_count (${claudeCap}) equals CLAUDE_MANAGER_RELAUNCH_CAP`,
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { applyAllTicketsDoneCompletion } from '../../bin/mux-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeSession(tmpDir) {
  const sessionDir = path.join(tmpDir, 'session');
  mkdirSync(sessionDir, { recursive: true });
  const statePath = path.join(sessionDir, 'state.json');
  writeFileSync(statePath, JSON.stringify({
    schema_version: 1,
    active: true,
    working_dir: tmpDir,
    iteration: 0,
    step: 'implement',
    max_iterations: 10,
    completion_promise: null,
    history: [],
  }, null, 2));
  return { sessionDir, statePath };
}

function makeTicket(sessionDir, id, status) {
  const ticketDir = path.join(sessionDir, id);
  mkdirSync(ticketDir, { recursive: true });
  writeFileSync(path.join(ticketDir, `rick_ticket_${id}.md`), [
    '---',
    `id: ${id}`,
    `title: "Ticket ${id}"`,
    `status: "${status}"`,
    'order: 1',
    '---',
    '',
    '# Body',
  ].join('\n'));
}

test('mux-runner-completion: all-done queue fires EPIC_COMPLETED', () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'pickle-mux-completion-all-done-'));
  try {
    const { sessionDir, statePath } = makeSession(tmpDir);
    makeTicket(sessionDir, 'aaa', 'Done');
    makeTicket(sessionDir, 'bbb', 'Done');
    makeTicket(sessionDir, 'ccc', 'Done');

    const logs = [];
    const fired = applyAllTicketsDoneCompletion(statePath, sessionDir, 1, msg => logs.push(msg));

    assert.equal(fired, true, 'should return true when all tickets are Done');

    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.step, 'completed', 'state.step must be "completed"');
    assert.equal(state.active, false, 'state.active must be false after finalize');
    assert.equal(state.exit_reason, 'completed', 'state.exit_reason must be "completed"');
    assert.ok(state.completion_promise !== null, 'state.completion_promise must be set');

    const promise = JSON.parse(state.completion_promise);
    assert.equal(promise.kind, 'EPIC_COMPLETED', 'completion_promise.kind must be EPIC_COMPLETED');
    assert.equal(promise.reason, 'all-tickets-done', 'completion_promise.reason must be all-tickets-done');
    assert.ok(typeof promise.ts === 'string' && promise.ts.length > 0, 'completion_promise.ts must be ISO string');

    const epicEntry = (state.activity || []).find(e => e.kind === 'EPIC_COMPLETED');
    assert.ok(epicEntry, 'state.activity must contain an entry with kind EPIC_COMPLETED');
    assert.equal(epicEntry.event, 'epic_completed', 'activity entry event must be "epic_completed"');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('mux-runner-completion: mixed-status queue does NOT fire', () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'pickle-mux-completion-mixed-'));
  try {
    const { sessionDir, statePath } = makeSession(tmpDir);
    makeTicket(sessionDir, 'aaa', 'Done');
    makeTicket(sessionDir, 'bbb', 'In Progress');
    makeTicket(sessionDir, 'ccc', 'Done');

    const fired = applyAllTicketsDoneCompletion(statePath, sessionDir, 1, () => {});

    assert.equal(fired, false, 'should return false when a ticket is In Progress');

    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.notEqual(state.step, 'completed', 'step must NOT be completed');
    assert.equal(state.active, true, 'active must remain true');
    assert.equal(state.completion_promise, null, 'completion_promise must remain null');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('mux-runner-completion: empty queue (N=0) does NOT fire', () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'pickle-mux-completion-empty-'));
  try {
    const { sessionDir, statePath } = makeSession(tmpDir);

    const fired = applyAllTicketsDoneCompletion(statePath, sessionDir, 1, () => {});

    assert.equal(fired, false, 'should return false when no tickets exist');

    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.notEqual(state.step, 'completed', 'step must NOT be completed for empty queue');
    assert.equal(state.active, true, 'active must remain true');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('mux-runner-completion: completion_promise shape matches BNF', () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'pickle-mux-completion-shape-'));
  try {
    const { sessionDir, statePath } = makeSession(tmpDir);
    makeTicket(sessionDir, 'x1', 'Done');

    applyAllTicketsDoneCompletion(statePath, sessionDir, 3, () => {});

    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const promise = JSON.parse(state.completion_promise);

    assert.ok(['EPIC_COMPLETED', 'BUDGET_EXHAUSTED', 'ERROR'].includes(promise.kind),
      'kind must be one of EPIC_COMPLETED|BUDGET_EXHAUSTED|ERROR');
    assert.ok(typeof promise.reason === 'string' && promise.reason.length > 0,
      'reason must be a non-empty string');
    const parsed = new Date(promise.ts);
    assert.ok(Number.isFinite(parsed.getTime()), 'ts must be valid ISO-8601');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

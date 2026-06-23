// @tier: fast
// R-REIN regression — refund the per-ticket recovery budget on explicit status reset.
//
// Bug (BUG-REPORT-2026-06-22 Run-3 addendum, facet 2): the documented operator recovery
// "reset a Failed ticket's frontmatter status -> Todo, then relaunch" is INERT. The spent
// `bounded_terminal_escape` attempts persist in state.recovery_attempts across the reset,
// so on the very first no-progress relaunch evaluateBoundedEscape sees priorCount >= cap
// and force-escapes the ticket again — the phase re-exits recovery_exhausted in ~2s with
// no real re-attempt.
//
// Fix: refundRecoveryBudgetOnReset clears the ticket's prior spent bounded-escape entries
// from the ledger WHEN (and only when) the current frontmatter status is Todo AND spent
// attempts exist — so the recovery ladder starts fresh and the ticket is re-attempted.
// A ticket NOT reset (still Failed/spent) keeps its spent attempts and still exhausts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  refundRecoveryBudgetOnReset,
  evaluateBoundedEscape,
  BOUNDED_ESCAPE_STRATEGY,
  BOUNDED_ESCAPE_CAP,
} from '../bin/mux-runner.js';
import { StateManager } from '../services/state-manager.js';

function tempRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-recovery-refund-')));
}

function writeTicket(sessionDir, id, status) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  const fm = ['---', `id: ${id}`, 'title: Recovery refund fixture', `status: ${status}`, 'order: 1', '---', '', '# Test'];
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${id}.md`), fm.join('\n'));
}

function baseState(ticketId, overrides = {}) {
  return {
    active: true,
    working_dir: '/nonexistent-non-repo',
    step: 'implement',
    iteration: 5,
    max_iterations: 60,
    max_time_minutes: 0,
    worker_timeout_seconds: 99,
    start_time_epoch: 1,
    completion_promise: null,
    original_prompt: 'recovery-refund test',
    current_ticket: ticketId,
    history: [],
    started_at: new Date(0).toISOString(),
    session_dir: '',
    recovery_attempts: [],
    ...overrides,
  };
}

function ledgerEntries(ticketId, n, outcome = 'failed') {
  return Array.from({ length: n }, (_, i) => ({
    strategy: BOUNDED_ESCAPE_STRATEGY,
    outcome,
    reason: 'no_progress_relaunch',
    iteration: i,
    ticket: ticketId,
  }));
}

function writeState(sessionDir, state) {
  const sm = new StateManager();
  const statePath = path.join(sessionDir, 'state.json');
  sm.forceWrite(statePath, state);
  return statePath;
}

test('reset-to-Todo ticket with spent attempts: budget refunded → fresh ladder, NOT recovery_exhausted', () => {
  const root = tempRoot();
  try {
    // Operator reset the exhausted ticket's frontmatter to Todo.
    writeTicket(root, 't1', 'Todo');
    const statePath = writeState(root, baseState('t1', {
      recovery_attempts: ledgerEntries('t1', BOUNDED_ESCAPE_CAP + 2),
    }));

    const result = refundRecoveryBudgetOnReset(statePath, root, 't1', 9, () => {});
    assert.equal(result.refunded, true, 'an explicit Todo reset with spent attempts must refund');
    assert.equal(result.cleared, BOUNDED_ESCAPE_CAP + 2, 'all spent bounded-escape attempts cleared');

    // The ledger is now empty of this ticket's spent attempts → ladder starts fresh.
    const sm = new StateManager();
    const refunded = sm.read(statePath);
    const remaining = (refunded.recovery_attempts || []).filter(
      a => a.strategy === BOUNDED_ESCAPE_STRATEGY && a.ticket === 't1' && a.outcome === 'failed',
    );
    assert.equal(remaining.length, 0, 'no spent attempts survive the refund');

    // Proof of re-attempt: were the manager to pick it up (In Progress), it would NOT
    // immediately escape — priorCount is back to 0, well below cap.
    const inProgress = { ...refunded, current_ticket: 't1' };
    writeTicket(root, 't1', 'In Progress');
    const esc = evaluateBoundedEscape(inProgress, root);
    assert.equal(esc.priorCount, 0, 'count reads zero after refund');
    assert.equal(esc.escape, false, 'a refunded ticket is re-attempted, not force-escaped');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('NOT reset (still Failed) with spent attempts: NO refund → still exhausts', () => {
  const root = tempRoot();
  try {
    // Ticket was NOT reset — frontmatter still terminal/non-Todo.
    writeTicket(root, 't1', 'Failed');
    const statePath = writeState(root, baseState('t1', {
      recovery_attempts: ledgerEntries('t1', BOUNDED_ESCAPE_CAP),
    }));

    const result = refundRecoveryBudgetOnReset(statePath, root, 't1', 9, () => {});
    assert.equal(result.refunded, false, 'a non-Todo ticket must not refund');
    assert.equal(result.cleared, 0);

    // The spent attempts are preserved → the cap still trips when In Progress.
    const sm = new StateManager();
    const after = sm.read(statePath);
    const preserved = (after.recovery_attempts || []).filter(
      a => a.strategy === BOUNDED_ESCAPE_STRATEGY && a.ticket === 't1' && a.outcome === 'failed',
    );
    assert.equal(preserved.length, BOUNDED_ESCAPE_CAP, 'spent attempts preserved without a reset');

    writeTicket(root, 't1', 'In Progress');
    const esc = evaluateBoundedEscape({ ...after, current_ticket: 't1' }, root);
    assert.equal(esc.priorCount, BOUNDED_ESCAPE_CAP, 'count unchanged for a non-reset ticket');
    assert.equal(esc.escape, true, 'a non-reset exhausted ticket still escapes (exhausts) correctly');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Todo ticket with NO spent attempts: no-op (conservative)', () => {
  const root = tempRoot();
  try {
    writeTicket(root, 't1', 'Todo');
    const statePath = writeState(root, baseState('t1', { recovery_attempts: [] }));
    const result = refundRecoveryBudgetOnReset(statePath, root, 't1', 9, () => {});
    assert.equal(result.refunded, false, 'nothing to refund when no spent attempts exist');
    assert.equal(result.cleared, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refund clears ONLY the reset ticket; a sibling ticket keeps its spent attempts', () => {
  const root = tempRoot();
  try {
    writeTicket(root, 't1', 'Todo');   // reset
    writeTicket(root, 't2', 'Failed'); // untouched sibling
    const statePath = writeState(root, baseState('t1', {
      recovery_attempts: [
        ...ledgerEntries('t1', BOUNDED_ESCAPE_CAP),
        ...ledgerEntries('t2', BOUNDED_ESCAPE_CAP),
      ],
    }));

    const result = refundRecoveryBudgetOnReset(statePath, root, 't1', 9, () => {});
    assert.equal(result.refunded, true);
    assert.equal(result.cleared, BOUNDED_ESCAPE_CAP);

    const sm = new StateManager();
    const after = sm.read(statePath);
    const t1 = (after.recovery_attempts || []).filter(a => a.ticket === 't1');
    const t2 = (after.recovery_attempts || []).filter(a => a.ticket === 't2');
    assert.equal(t1.length, 0, 'reset ticket attempts cleared');
    assert.equal(t2.length, BOUNDED_ESCAPE_CAP, 'sibling ticket attempts untouched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('no ticketId → no-op', () => {
  const root = tempRoot();
  try {
    const statePath = writeState(root, baseState(null, { current_ticket: null }));
    const result = refundRecoveryBudgetOnReset(statePath, root, '', 9, () => {});
    assert.equal(result.refunded, false);
    assert.equal(result.cleared, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

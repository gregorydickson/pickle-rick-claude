// @tier: fast
// AC-A4 (f8000435) regression — bounded terminal escape for an unreclaimable
// In Progress ticket on the non-codex manager-relaunch path.
//
// AC-A1 + AC-A2 make a pickle phase with a pending ticket REFUSE to complete.
// The inverse hazard: an In Progress ticket the manager can never finish would
// relaunch up to CLAUDE_MANAGER_RELAUNCH_CAP (20) sterile times. This escape
// forces the ticket terminal (salvage → Skipped) after BOUNDED_ESCAPE_CAP
// consecutive no-progress relaunches, counted from the PERSISTED
// state.recovery_attempts ledger so the cap survives `setup.js --resume`.
//
// Pure-function coverage (no runner spawn): exercises the exported
// evaluateBoundedEscape / recordBoundedEscapeAttempt / executeBoundedEscape seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  evaluateBoundedEscape,
  recordBoundedEscapeAttempt,
  executeBoundedEscape,
  BOUNDED_ESCAPE_STRATEGY,
} from '../bin/mux-runner.js';
import { getTicketStatus, resolveHardeningSettings } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';

// R-RRPC-1/3: the cap is no longer a mux-runner.js const — it's resolved from
// resolveHardeningSettings(). Use the compiled default (3) explicitly here so
// this fixture stays independent of the resolver's internal default value.
const BOUNDED_ESCAPE_CAP = resolveHardeningSettings(null).bounded_terminal_escape_cap;

function tempRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-bounded-escape-')));
}

function writeTicket(sessionDir, id, status) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  const fm = ['---', `id: ${id}`, 'title: Bounded escape fixture', `status: ${status}`, 'order: 1', '---', '', '# Test'];
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${id}.md`), fm.join('\n'));
}

function writeState(sessionDir, state) {
  const sm = new StateManager();
  const statePath = path.join(sessionDir, 'state.json');
  sm.forceWrite(statePath, state);
  return statePath;
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
    original_prompt: 'bounded-escape test',
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

test('evaluateBoundedEscape: In Progress below cap does NOT escape', () => {
  const root = tempRoot();
  try {
    writeTicket(root, 't1', 'In Progress');
    const state = baseState('t1', { recovery_attempts: ledgerEntries('t1', BOUNDED_ESCAPE_CAP - 1) });
    const e = evaluateBoundedEscape(state, root, BOUNDED_ESCAPE_CAP);
    assert.equal(e.escape, false, 'below cap must not escape');
    assert.equal(e.ticketId, 't1');
    assert.equal(e.priorCount, BOUNDED_ESCAPE_CAP - 1);
    assert.equal(e.cap, BOUNDED_ESCAPE_CAP);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('evaluateBoundedEscape: In Progress AT cap escapes', () => {
  const root = tempRoot();
  try {
    writeTicket(root, 't1', 'In Progress');
    const state = baseState('t1', { recovery_attempts: ledgerEntries('t1', BOUNDED_ESCAPE_CAP) });
    const e = evaluateBoundedEscape(state, root, BOUNDED_ESCAPE_CAP);
    assert.equal(e.escape, true, 'at/above cap with In Progress must escape');
    assert.equal(e.priorCount, BOUNDED_ESCAPE_CAP);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bounded escape to terminal: forces Skipped, records ledger, does NOT loop', () => {
  const root = tempRoot();
  try {
    writeTicket(root, 't1', 'In Progress');
    const statePath = writeState(root, baseState('t1', { recovery_attempts: ledgerEntries('t1', BOUNDED_ESCAPE_CAP) }));

    // Precondition: escape fires.
    const sm = new StateManager();
    let state = sm.read(statePath);
    assert.equal(evaluateBoundedEscape(state, root, BOUNDED_ESCAPE_CAP).escape, true);

    // Force terminal.
    const flipped = executeBoundedEscape(statePath, root, '/nonexistent-non-repo', 't1', 9, BOUNDED_ESCAPE_CAP, () => {});
    assert.equal(flipped, true, 'ticket frontmatter flipped to terminal');

    // Ticket is now terminal (Skipped counts terminal per PRD AC-A4 Risks).
    assert.equal((getTicketStatus(root, 't1') || '').toLowerCase().replace(/["']/g, '').trim(), 'skipped');

    // A success ledger entry was appended.
    state = sm.read(statePath);
    const successEntries = (state.recovery_attempts || []).filter(
      a => a.strategy === BOUNDED_ESCAPE_STRATEGY && a.ticket === 't1' && a.outcome === 'success',
    );
    assert.equal(successEntries.length, 1, 'one success ledger entry recorded');

    // One-shot: the now-terminal ticket no longer escapes (no infinite loop).
    assert.equal(evaluateBoundedEscape(state, root, BOUNDED_ESCAPE_CAP).escape, false, 'terminal ticket must not re-escape');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cap survives setup.js --resume: count comes from persisted ledger, not a process counter', () => {
  const root = tempRoot();
  try {
    writeTicket(root, 't1', 'In Progress');

    // Simulate the PRE-resume session: cap no-progress attempts already on disk.
    const statePath = writeState(root, baseState('t1', { recovery_attempts: [] }));
    for (let i = 0; i < BOUNDED_ESCAPE_CAP; i++) {
      recordBoundedEscapeAttempt(statePath, 't1', i, () => {});
    }

    // Simulate `setup.js --resume`: a FRESH process re-reads the persisted state.
    // No in-memory counter carries over — the count must come from the ledger.
    const resumedSm = new StateManager();
    const resumedState = resumedSm.read(statePath);
    const e = evaluateBoundedEscape(resumedState, root, BOUNDED_ESCAPE_CAP);
    assert.equal(e.priorCount, BOUNDED_ESCAPE_CAP, 'count rehydrated from persisted recovery_attempts');
    assert.equal(e.escape, true, 'cap respected post-resume from the persisted ledger');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('non-In-Progress tickets never escape (Todo not started; Done/Skipped already terminal)', () => {
  for (const status of ['Todo', 'Done', 'Skipped']) {
    const root = tempRoot();
    try {
      writeTicket(root, 't1', status);
      // Even far above cap, a non-In-Progress ticket is not escape-eligible.
      const state = baseState('t1', { recovery_attempts: ledgerEntries('t1', BOUNDED_ESCAPE_CAP + 5) });
      assert.equal(evaluateBoundedEscape(state, root, BOUNDED_ESCAPE_CAP).escape, false, `${status} must not escape`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('no current_ticket → no escape', () => {
  const root = tempRoot();
  try {
    const state = baseState(null, { current_ticket: null });
    const e = evaluateBoundedEscape(state, root, BOUNDED_ESCAPE_CAP);
    assert.equal(e.escape, false);
    assert.equal(e.ticketId, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

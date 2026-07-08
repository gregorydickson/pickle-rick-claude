// @tier: fast
// R-CNAR-1 part 2 regression — global max_iterations and per-ticket
// current_ticket_max_iterations must fire INDEPENDENTLY.
//
// Pre-fix (the bug): applyTicketTierBudget overwrote state.max_iterations
// with the per-ticket tier value. The cap-check then conflated global cap
// with per-ticket budget — operator's global cap was silently truncated to
// the smallest tier ceiling encountered, and the pipeline exited at the
// per-ticket budget regardless of how much global runway remained.
//
// Post-fix invariant: state.max_iterations is preserved across
// applyTicketTierBudget calls (global cap), and state.current_ticket_max_iterations
// holds the tier ceiling. Cap-check exits on whichever fires first:
//   (a) per-ticket: budgetIter >= state.current_ticket_max_iterations
//   (b) global:     state.iteration >= state.max_iterations
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  applyTicketTierBudget,
  clearStalePerTicketCacheAtIterationStart,
  clearStaleTicketCacheFields,
  hasStalePerTicketCacheFields,
  isValidPerTicketCapCache,
  stalePerTicketCacheDiagnostic,
} from '../bin/mux-runner.js';

function tempRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-cap-split-')));
}

function writeTicket(sessionDir, id, tier) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  const fm = ['---', `id: ${id}`, 'title: Cap split fixture', 'status: Todo', 'order: 1'];
  if (tier) fm.push(`complexity_tier: ${tier}`);
  fm.push('---', '', '# Test');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${id}.md`), fm.join('\n'));
}

function freshState(ticketId, overrides = {}) {
  return {
    active: true,
    working_dir: process.cwd(),
    step: 'implement',
    iteration: 0,
    max_iterations: 60,         // operator-set global cap
    max_time_minutes: 60,
    worker_timeout_seconds: 99,
    start_time_epoch: 1,
    completion_promise: null,
    original_prompt: 'cap-split test',
    current_ticket: ticketId,
    history: [],
    started_at: new Date(0).toISOString(),
    session_dir: '',
    ...overrides,
  };
}

test('cap-split: applyTicketTierBudget preserves operator global state.max_iterations', () => {
  const root = tempRoot();
  try {
    writeTicket(root, 't1', 'small');   // small tier → 10 iter ceiling per R-CNAR-1
    const state = freshState('t1');
    assert.equal(state.max_iterations, 60, 'precondition: operator set global to 60');

    applyTicketTierBudget(state, root);

    // Bug pre-fix: state.max_iterations would be 10 (small-tier value) here.
    assert.equal(state.max_iterations, 60, 'global cap MUST be preserved');
    assert.equal(state.current_ticket_max_iterations, 10, 'per-ticket cache reflects small-tier');
    assert.equal(state.current_ticket_tier, 'small');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cap-split: switching tier mid-session does NOT mutate global cap', () => {
  const root = tempRoot();
  try {
    writeTicket(root, 't1', 'large');     // large → 60 iter
    writeTicket(root, 't2', 'trivial');   // trivial → 5 iter
    const state = freshState('t1', { max_iterations: 200 });

    applyTicketTierBudget(state, root);
    assert.equal(state.max_iterations, 200, 'after large: global preserved');
    assert.equal(state.current_ticket_max_iterations, 60);

    // Simulate ticket transition (mux-runner.runIteration update-state.js path
    // clears these on ticket change; replicate that explicitly).
    state.current_ticket = 't2';
    delete state.current_ticket_tier;
    delete state.current_ticket_max_iterations;
    delete state.current_ticket_worker_timeout_seconds;
    delete state.current_ticket_budget_start_iteration;

    applyTicketTierBudget(state, root);
    assert.equal(state.max_iterations, 200, 'after trivial: global STILL preserved');
    assert.equal(state.current_ticket_max_iterations, 5, 'per-ticket cache shrunk to trivial-tier');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cap-split: per-ticket cache populated even when no global cap is set', () => {
  // Edge case: operator launches with state.max_iterations === 0 (no global cap).
  // The per-ticket cache MUST still populate so the per-ticket cap-check at
  // mux-runner.ts can fire.
  const root = tempRoot();
  try {
    writeTicket(root, 't1', 'medium');
    const state = freshState('t1', { max_iterations: 0 });

    applyTicketTierBudget(state, root);

    assert.equal(state.max_iterations, 0, 'operator-set 0 preserved');
    assert.equal(state.current_ticket_max_iterations, 30, 'per-ticket medium-tier cache set');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cap-split: worker_timeout_seconds remains per-ticket (unchanged behavior)', () => {
  // The fix preserves worker_timeout_seconds being overwritten per-ticket-tier
  // because spawn-morty.ts and friends consume it as the per-spawn worker
  // budget. Documenting that this is the deliberate carve-out from the fix.
  const root = tempRoot();
  try {
    writeTicket(root, 't1', 'large');
    const state = freshState('t1', { worker_timeout_seconds: 99 });

    applyTicketTierBudget(state, root);

    assert.equal(state.worker_timeout_seconds, 80 * 60, 'large-tier per-spawn timeout written');
    assert.equal(state.current_ticket_worker_timeout_seconds, 80 * 60, 'and cached');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- R-CNAR-7 stale-cache cap-trip guard ---

test('R-CNAR-7 clearStaleTicketCacheFields: clears all 5 cache fields when populated', () => {
  const state = {
    active: true,
    working_dir: '/tmp',
    step: 'implement',
    iteration: 11,
    max_iterations: 500,
    max_time_minutes: 60,
    worker_timeout_seconds: 99,
    start_time_epoch: 1,
    completion_promise: null,
    original_prompt: '',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp',
    tmux_mode: false,
    schema_version: 9,
    backend: 'claude',
    current_ticket_tier: 'medium',
    current_ticket_budget: 30,
    current_ticket_max_iterations: 30,
    current_ticket_worker_timeout_seconds: 1200,
    current_ticket_budget_start_iteration: 5,
  };

  const cleared = clearStaleTicketCacheFields(state);

  assert.equal(cleared, 5, 'all 5 cache fields cleared');
  assert.equal(state.current_ticket_tier, undefined);
  assert.equal(state.current_ticket_budget, undefined);
  assert.equal(state.current_ticket_max_iterations, undefined);
  assert.equal(state.current_ticket_worker_timeout_seconds, undefined);
  assert.equal(state.current_ticket_budget_start_iteration, undefined);
  // unrelated fields preserved
  assert.equal(state.iteration, 11);
  assert.equal(state.max_iterations, 500);
  assert.equal(state.current_ticket, null);
});

test('R-CNAR-7 clearStaleTicketCacheFields: idempotent (re-run on cleared state is no-op)', () => {
  const state = { current_ticket: null };

  const first = clearStaleTicketCacheFields(state);
  const second = clearStaleTicketCacheFields(state);

  assert.equal(first, 0, 'no fields to clear');
  assert.equal(second, 0, 'still no fields');
});

test('R-CNAR-7 clearStaleTicketCacheFields: returns count of fields cleared (partial)', () => {
  const state = {
    current_ticket: null,
    current_ticket_max_iterations: 30,
    current_ticket_worker_timeout_seconds: 1200,
    // tier/budget/budget_start_iteration absent
  };

  const cleared = clearStaleTicketCacheFields(state);

  assert.equal(cleared, 2, 'only the 2 populated fields cleared');
  assert.equal(state.current_ticket_max_iterations, undefined);
  assert.equal(state.current_ticket_worker_timeout_seconds, undefined);
});

test('R-CNAR-7 stale-cache guard: exact 2026-05-05 resume reproducer is skipped, not treated as valid cap cache', () => {
  const state = {
    current_ticket: null,
    current_ticket_max_iterations: 10,
    current_ticket_budget_start_iteration: 10,
    current_ticket_tier: 'small',
    iteration: 18,
  };

  assert.equal(isValidPerTicketCapCache(state), false);
  assert.equal(
    stalePerTicketCacheDiagnostic(state),
    'per-ticket cap-check skipped: stale cache (current_ticket=null, max_iter=10, budget_start=10, tier=small)',
  );
});

test('R-CNAR-7 stale-cache guard: invalid current_ticket_max_iterations is treated as stale cache', () => {
  assert.equal(isValidPerTicketCapCache({
    current_ticket: 'abc',
    current_ticket_max_iterations: 0,
    current_ticket_budget_start_iteration: 1,
    current_ticket_tier: 'medium',
  }), false);
});

test('R-CNAR-7 stale-cache guard: invalid current_ticket_budget_start_iteration is treated as stale cache', () => {
  assert.equal(isValidPerTicketCapCache({
    current_ticket: 'abc',
    current_ticket_max_iterations: 30,
    current_ticket_budget_start_iteration: -1,
    current_ticket_tier: 'medium',
  }), false);
  assert.equal(isValidPerTicketCapCache({
    current_ticket: 'abc',
    current_ticket_max_iterations: 30,
    current_ticket_budget_start_iteration: 1.5,
    current_ticket_tier: 'medium',
  }), false);
});

test('R-CNAR-7 stale-cache guard: invalid current_ticket_tier is treated as stale cache', () => {
  assert.equal(isValidPerTicketCapCache({
    current_ticket: 'abc',
    current_ticket_max_iterations: 30,
    current_ticket_budget_start_iteration: 2,
    current_ticket_tier: 'bogus',
  }), false);
});

test('R-CNAR-7 stale-cache guard: fully valid cache remains eligible for per-ticket cap-check', () => {
  assert.equal(isValidPerTicketCapCache({
    current_ticket: 'abc',
    current_ticket_max_iterations: 30,
    current_ticket_budget_start_iteration: 2,
    current_ticket_tier: 'medium',
  }), true);
});

test('R-CNAR-7 stale-cache guard: clean idle state is not treated as stale cache', () => {
  assert.equal(hasStalePerTicketCacheFields({
    current_ticket_tier: undefined,
    current_ticket_budget: undefined,
    current_ticket_max_iterations: undefined,
    current_ticket_worker_timeout_seconds: undefined,
    current_ticket_budget_start_iteration: undefined,
  }), false);
  assert.equal(isValidPerTicketCapCache({
    current_ticket: null,
    current_ticket_max_iterations: undefined,
    current_ticket_budget_start_iteration: undefined,
    current_ticket_tier: undefined,
  }), false);
});

test('R-CNAR-7 iteration_start self-heal: clears stale cache when current_ticket=null', () => {
  const root = tempRoot();
  try {
    const statePath = path.join(root, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      active: true,
      working_dir: root,
      step: 'implement',
      iteration: 18,
      max_iterations: 500,
      max_time_minutes: 60,
      worker_timeout_seconds: 99,
      start_time_epoch: 1,
      completion_promise: null,
      original_prompt: '',
      current_ticket: null,
      history: [],
      started_at: new Date(0).toISOString(),
      session_dir: root,
      current_ticket_tier: 'small',
      current_ticket_budget: 10,
      current_ticket_max_iterations: 10,
      current_ticket_worker_timeout_seconds: 600,
      current_ticket_budget_start_iteration: 10,
    }, null, 2));

    const logs = [];
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const updated = clearStalePerTicketCacheAtIterationStart(statePath, state, msg => logs.push(msg));

    assert.deepEqual(logs, ['clearing stale per-ticket cache fields (current_ticket=null)']);
    assert.equal(hasStalePerTicketCacheFields(updated), false);
    assert.equal(updated.current_ticket_tier, undefined);
    assert.equal(updated.current_ticket_budget, undefined);
    assert.equal(updated.current_ticket_max_iterations, undefined);
    assert.equal(updated.current_ticket_worker_timeout_seconds, undefined);
    assert.equal(updated.current_ticket_budget_start_iteration, undefined);

    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(persisted.current_ticket_tier, undefined);
    assert.equal(persisted.current_ticket_budget, undefined);
    assert.equal(persisted.current_ticket_max_iterations, undefined);
    assert.equal(persisted.current_ticket_worker_timeout_seconds, undefined);
    assert.equal(persisted.current_ticket_budget_start_iteration, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

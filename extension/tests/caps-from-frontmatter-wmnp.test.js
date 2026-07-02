// @tier: fast
// W4c (AC-W4c-1) regression — the per-ticket no-progress cap is ALWAYS
// populated from ticket frontmatter at decision time; a stale/undefined cache
// can never yield max_iter=0 (cap silently disabled) → R-WMNP unbounded
// in-phase respawn loop.
//
// Root cause (R-WMNP): wmw-auto-skip respawned a near-green ticket in-phase
// forever because the per-ticket cap read a stale `undefined` cache →
// max_iter=undefined → the `ticketMaxIter > 0` guard skipped the cap.
//
// repopulateNoProgressCapFromFrontmatter re-derives the cap via the R-CNAR-1
// `applyTicketTierBudget` path (frontmatter complexity_tier → tier budget).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  repopulateNoProgressCapFromFrontmatter,
  isValidPerTicketCapCache,
} from '../bin/mux-runner.js';

// small-tier ceiling per TICKET_TIER_BUDGETS (pickle-utils.ts): max_iterations=10.
const SMALL_TIER_MAX_ITER = 10;

function tempRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-w4c-')));
}

function writeTicket(sessionDir, id, tier) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  const fm = ['---', `id: ${id}`, 'title: W4c cap fixture', 'status: Todo', 'order: 1'];
  if (tier) fm.push(`complexity_tier: ${tier}`);
  fm.push('---', '', '# Test');
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${id}.md`), fm.join('\n'));
}

function writeState(root, overrides = {}) {
  const statePath = path.join(root, 'state.json');
  const base = {
    active: true,
    working_dir: root,
    step: 'implement',
    iteration: 5,
    max_iterations: 60,
    max_time_minutes: 60,
    worker_timeout_seconds: 99,
    start_time_epoch: 1,
    completion_promise: null,
    original_prompt: 'w4c test',
    current_ticket: 't1',
    history: [],
    started_at: new Date(0).toISOString(),
    session_dir: root,
  };
  fs.writeFileSync(statePath, JSON.stringify({ ...base, ...overrides }, null, 2));
  return statePath;
}

function readState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

const noop = () => {};

test('W4c: ticket frontmatter present + invalid cache → cap derived from tier budget', () => {
  const root = tempRoot();
  try {
    writeTicket(root, 't1', 'small');
    // SET ticket, NO per-ticket cap cache (the invalid-cache shape).
    const statePath = writeState(root, { current_ticket: 't1' });
    const state = readState(statePath);
    assert.equal(isValidPerTicketCapCache(state), false, 'precondition: cache invalid');

    const updated = repopulateNoProgressCapFromFrontmatter(statePath, state, noop, root);

    assert.equal(isValidPerTicketCapCache(updated), true, 'cap cache now valid');
    assert.equal(updated.current_ticket_max_iterations, SMALL_TIER_MAX_ITER,
      'cap derived from small-tier budget');
    assert.equal(updated.current_ticket_tier, 'small');
    // R-CNAR-1 part-2 trap door: global cap untouched.
    assert.equal(updated.max_iterations, 60, 'global max_iterations preserved');
    // Persisted to disk.
    assert.equal(readState(statePath).current_ticket_max_iterations, SMALL_TIER_MAX_ITER);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('W4c: stale cache `undefined` → cap re-derived from frontmatter, never unbounded', () => {
  const root = tempRoot();
  try {
    writeTicket(root, 't1', 'small');
    // Explicit stale-undefined max_iter (the R-WMNP cache shape).
    const statePath = writeState(root, {
      current_ticket: 't1',
      current_ticket_tier: 'small',
      current_ticket_max_iterations: undefined,
      current_ticket_budget_start_iteration: undefined,
    });
    const state = readState(statePath);
    assert.equal(state.current_ticket_max_iterations, undefined, 'precondition: max_iter undefined');
    assert.equal(isValidPerTicketCapCache(state), false);

    const updated = repopulateNoProgressCapFromFrontmatter(statePath, state, noop, root);

    assert.notEqual(updated.current_ticket_max_iterations, undefined, 'no longer undefined');
    assert.equal(Number.isInteger(updated.current_ticket_max_iterations)
      && updated.current_ticket_max_iterations > 0, true, 'cap is a bounded positive integer');
    assert.equal(updated.current_ticket_max_iterations, SMALL_TIER_MAX_ITER);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('W4c R-WMNP repro: SET ticket + invalid cache → bounded cap, cap-check guard is live', () => {
  const root = tempRoot();
  try {
    writeTicket(root, 't1', 'small');
    const statePath = writeState(root, { current_ticket: 't1' });
    const state = readState(statePath);

    const updated = repopulateNoProgressCapFromFrontmatter(statePath, state, noop, root);

    // The cap-check at mux-runner.ts uses `ticketMaxIter > 0` to gate the exit.
    // A bounded positive cap means the guard is LIVE — no unbounded respawn.
    const ticketMaxIter = isValidPerTicketCapCache(updated)
      ? Number(updated.current_ticket_max_iterations)
      : 0;
    assert.equal(ticketMaxIter > 0, true, 'ticketMaxIter > 0 — cap-check is live, loop is bounded');
    assert.equal(ticketMaxIter, SMALL_TIER_MAX_ITER);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('W4c: no-ticket (current_ticket=null) + populated cache → pass-through (no write)', () => {
  const root = tempRoot();
  try {
    // No-ticket stale-cache case is owned by shouldEmitStalePerTicketCapSkip;
    // the W4c helper must NOT touch it.
    const statePath = writeState(root, {
      current_ticket: null,
      current_ticket_tier: 'small',
      current_ticket_budget: 10,
      current_ticket_max_iterations: 10,
      current_ticket_budget_start_iteration: 3,
    });
    const before = readState(statePath);
    const updated = repopulateNoProgressCapFromFrontmatter(statePath, before, noop, root);

    // Returned and on-disk state unchanged (pass-through).
    assert.equal(updated, before, 'returns the same state object (no sm.update)');
    assert.equal(readState(statePath).current_ticket_max_iterations, 10, 'cache untouched on disk');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

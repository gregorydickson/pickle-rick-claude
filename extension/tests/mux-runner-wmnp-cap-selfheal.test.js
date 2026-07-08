// @tier: fast
//
// AC-R-WMNP-2: a SET current_ticket whose per-ticket cap cache is missing/invalid
// must be REPOPULATED from the ticket's complexity tier at iteration_start, so the
// per-ticket cap-check is never perpetually skipped. The clear-on-null path must
// still clear. Throwaway temp fixtures only.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function writeTicket(sessionDir, ticketId, tier) {
  const dir = path.join(sessionDir, ticketId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `rick_ticket_${ticketId}.md`),
    `---\nid: ${ticketId}\ntitle: "t"\nstatus: "In Progress"\norder: 10\ncomplexity_tier: ${tier}\n---\n# t\n`,
  );
}

function baseState(dir, ticketId) {
  return {
    active: true,
    working_dir: dir,
    step: 'implement',
    iteration: 7,
    max_iterations: 100,
    max_time_minutes: 0,
    worker_timeout_seconds: 3600,
    start_time_epoch: 1,
    completion_promise: null,
    original_prompt: 'AC-R-WMNP-2',
    current_ticket: ticketId,
    history: [],
    started_at: new Date(0).toISOString(),
    session_dir: dir,
    schema_version: 5,
    activity: [],
  };
}

test('AC-R-WMNP-2: set current_ticket + undefined cache repopulates per-ticket cap from tier', async () => {
  const { clearStalePerTicketCacheAtIterationStart, isValidPerTicketCapCache } =
    await import('../bin/mux-runner.js');
  const { getTicketTierBudgetWithOverrides } = await import('../services/pickle-utils.js');
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmnp-selfheal-'));
  try {
    const ticketId = 'cap01';
    writeTicket(sessionDir, ticketId, 'medium');
    const statePath = path.join(sessionDir, 'state.json');
    // current_ticket set, NO per-ticket cap cache fields → the incident shape.
    const state = baseState(sessionDir, ticketId);
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    assert.equal(isValidPerTicketCapCache(state), false, 'precondition: cache invalid');

    const logs = [];
    const updated = clearStalePerTicketCacheAtIterationStart(statePath, state, (m) => logs.push(m), sessionDir);

    assert.equal(isValidPerTicketCapCache(updated), true, 'cache is valid after self-heal');
    assert.ok(Number.isInteger(updated.current_ticket_max_iterations) && updated.current_ticket_max_iterations > 0,
      'current_ticket_max_iterations is a positive integer');
    assert.ok(Number.isInteger(updated.current_ticket_budget_start_iteration) && updated.current_ticket_budget_start_iteration >= 0,
      'current_ticket_budget_start_iteration is a non-negative integer');
    assert.equal(updated.current_ticket_tier, 'medium', 'tier read from ticket frontmatter');

    const expected = getTicketTierBudgetWithOverrides(updated, 'medium');
    assert.equal(updated.current_ticket_max_iterations, expected.max_iterations, 'matches the tier map');

    // Persisted to disk, not just the in-memory object.
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(persisted.current_ticket_max_iterations, expected.max_iterations);
    assert.ok(logs.some((l) => l.includes('repopulating per-ticket cap cache')), 'logs the repopulation');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-R-WMNP-2: clear-on-null path still clears stale cache', async () => {
  const { clearStalePerTicketCacheAtIterationStart, hasStalePerTicketCacheFields } =
    await import('../bin/mux-runner.js');
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmnp-clear-'));
  try {
    const statePath = path.join(sessionDir, 'state.json');
    const state = {
      ...baseState(sessionDir, 'x'),
      current_ticket: null,
      current_ticket_tier: 'small',
      current_ticket_max_iterations: 10,
      current_ticket_budget_start_iteration: 10,
      current_ticket_worker_timeout_seconds: 600,
    };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    const logs = [];
    const updated = clearStalePerTicketCacheAtIterationStart(statePath, state, (m) => logs.push(m), sessionDir);

    assert.equal(hasStalePerTicketCacheFields(updated), false, 'stale cache cleared on null current_ticket');
    assert.ok(logs.some((l) => l.includes('current_ticket=null')), 'logs the clear');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

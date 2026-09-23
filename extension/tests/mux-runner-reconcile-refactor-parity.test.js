// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTicketDesyncWinner } from '../bin/mux-runner.js';

// The resolver reads only its two arguments, so each fixture is an in-memory
// roster plus the expected resolution — no mirrored implementation to drift.
const fixtures = [
  { name: 'zero-tickets', currentTicket: 'ticket-current', roster: {}, expected: { winner: null, action: 'noop' } },
  { name: 'already-synced', currentTicket: 'ticket-a', roster: { 'ticket-a': 'In Progress' }, expected: { winner: 'ticket-a', action: 'noop' } },
  { name: 'failed-no-progress', currentTicket: 'ticket-b', roster: { 'ticket-b': 'Failed' }, expected: { winner: 'ticket-b', action: 'noop' } },
  { name: 'done-no-progress', currentTicket: 'ticket-done', roster: { 'ticket-done': 'Done' }, expected: { winner: 'ticket-done', action: 'noop' } },
  { name: 'skipped-no-progress', currentTicket: 'ticket-skip', roster: { 'ticket-skip': 'Skipped', 'ticket-next': 'Todo' }, expected: { winner: 'ticket-skip', action: 'noop' } },
  {
    name: 'desync-detected',
    currentTicket: 'ticket-current',
    roster: { 'ticket-current': 'Todo', 'ticket-frontmatter': 'In Progress' },
    expected: { winner: 'ticket-frontmatter', action: 'sync' },
  },
  { name: 'null-pointer-nothing-in-progress', currentTicket: null, roster: { 'ticket-a': 'Todo' }, expected: { winner: null, action: 'noop' } },
  { name: 'empty-pointer-nothing-in-progress', currentTicket: '', roster: { 'ticket-a': 'Todo' }, expected: { winner: null, action: 'noop' } },
  { name: 'null-pointer-one-in-progress', currentTicket: null, roster: { 'ticket-a': 'In Progress' }, expected: { winner: 'ticket-a', action: 'sync' } },
  // An unreadable/missing ticket reads as '' (readTicketStatusMap) — pending, so it is restored.
  { name: 'pointer-absent-from-roster', currentTicket: 'ticket-gone', roster: { 'ticket-a': 'Todo' }, expected: { winner: 'ticket-gone', action: 'sync' } },
  { name: 'unreadable-pointer', currentTicket: 'ticket-a', roster: { 'ticket-a': '' }, expected: { winner: 'ticket-a', action: 'sync' } },
];

test('reconcile-desync resolver fixtures', () => {
  for (const fixture of fixtures) {
    const actual = resolveTicketDesyncWinner({ current_ticket: fixture.currentTicket }, new Map(Object.entries(fixture.roster)));
    assert.deepEqual(actual, fixture.expected, fixture.name);
  }
});

function resolveOverRoster(pointerStatus, siblingStatus = 'Todo') {
  const frontmatterStatuses = new Map([
    ['aaaa1111', pointerStatus],
    ['bbbb2222', siblingStatus],
    ['cccc3333', siblingStatus],
  ]);
  return resolveTicketDesyncWinner({ current_ticket: 'aaaa1111' }, frontmatterStatuses);
}

test('B-CURTIX AC1: a Done or Skipped current_ticket with nothing In Progress is not re-stamped', () => {
  for (const status of ['Done', 'Skipped', '"Done"', 'skipped']) {
    assert.deepEqual(resolveOverRoster(status), { winner: 'aaaa1111', action: 'noop' }, `${status} pointer`);
  }
});

test('B-CURTIX AC1: a Failed current_ticket and an all-terminal roster stay noop', () => {
  assert.deepEqual(resolveOverRoster('Failed'), { winner: 'aaaa1111', action: 'noop' });
  assert.deepEqual(resolveOverRoster('Skipped', 'Done'), { winner: 'aaaa1111', action: 'noop' });
});

test('B-CURTIX AC1 control: a pending current_ticket with nothing In Progress still syncs', () => {
  assert.deepEqual(resolveOverRoster('Todo'), { winner: 'aaaa1111', action: 'sync' });
});

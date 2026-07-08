// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveTicketDesyncWinner,
  hasSubstantiveManagerHandoff,
} from '../bin/mux-runner.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mux-refactor-parity-'));
}

function makeTicketDir(baseDir, ticketId, status) {
  const ticketDir = path.join(baseDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), [
    '---',
    `id: ${ticketId}`,
    `status: "${status}"`,
    'order: 1',
    '---',
    '# Ticket',
    '',
  ].join('\n'));
  return ticketDir;
}

function writeConformance(ticketDir) {
  const content = [
    '# Conformance',
    '',
    '## Manager Handoff',
    '- Reviewed by operator',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(ticketDir, `conformance_2026-05-18.md`), content);
}

function readManagerHandoffStatus(ticketDir) {
  try {
    const entries = fs.readdirSync(ticketDir);
    const latest = entries
      .filter((entry) => /^conformance_.*\.md$/.test(entry))
      .sort()
      .at(-1);
    if (!latest) return false;
    const fixture = fs.readFileSync(path.join(ticketDir, latest), 'utf-8');
    return hasSubstantiveManagerHandoff(fixture);
  } catch {
    return false;
  }
}

function resolveLegacy(state, frontmatterStatuses) {
  const currentTicket =
    typeof state.current_ticket === 'string' && state.current_ticket.length > 0
      ? state.current_ticket
      : null;
  const ticketIds = [...frontmatterStatuses.keys()];
  const inProgress = ticketIds
    .filter((ticketId) => {
      const status = frontmatterStatuses.get(ticketId);
      const normalized = String(status ?? '').toLowerCase().replace(/["']/g, '').trim();
      return normalized === 'in progress';
    })
    .map((id) => ({ id }));

  const winner = inProgress.some((ticket) => ticket.id === currentTicket)
    ? currentTicket
    : inProgress.at(0)?.id ?? currentTicket;

  if (ticketIds.length === 0) return { winner: null, action: 'noop' };
  if (inProgress.length === 1 && winner === currentTicket) return { winner, action: 'noop' };

  const currentStatus = currentTicket ? frontmatterStatuses.get(currentTicket) ?? null : null;
  const normalizedCurrentStatus = String(currentStatus ?? '').toLowerCase().replace(/["']/g, '').trim();

  if (inProgress.length === 0 && normalizedCurrentStatus === 'failed') {
    return { winner, action: 'noop' };
  }

  if (inProgress.length === 0 && normalizedCurrentStatus === 'done' && currentTicket) {
    const conformance = readManagerHandoffStatus(path.join(state.session_dir, currentTicket));
    if (conformance) {
      return { winner, action: 'noop' };
    }
  }

  return { winner, action: 'sync' };
}

test('reconcile-desync-refactor parity fixtures', () => {
  const fixtures = [
    {
      name: 'zero-tickets',
      state: { current_ticket: 'ticket-current', session_dir: null },
      tickets: [],
      expectedWinner: null,
    },
    {
      name: 'already-synced',
      state: { current_ticket: 'ticket-a', session_dir: '/ignored' },
      tickets: [
        { id: 'ticket-a', status: 'In Progress' },
      ],
      expectedWinner: 'ticket-a',
    },
    {
      name: 'failed-no-progress',
      state: { current_ticket: 'ticket-b', session_dir: '/ignored' },
      tickets: [
        { id: 'ticket-b', status: 'Failed' },
      ],
      expectedWinner: 'ticket-b',
    },
    {
      name: 'done-with-manager-handoff',
      state: { current_ticket: 'ticket-done', session_dir: null, useSessionDir: true },
      tickets: [
        { id: 'ticket-done', status: 'Done' },
      ],
      expectedWinner: 'ticket-done',
      withManagerHandoff: true,
    },
    {
      name: 'desync-detected',
      state: { current_ticket: 'ticket-current', session_dir: '/ignored' },
      tickets: [
        { id: 'ticket-current', status: 'Todo' },
        { id: 'ticket-frontmatter', status: 'In Progress' },
      ],
      expectedWinner: 'ticket-frontmatter',
    },
  ];

  for (const fixture of fixtures) {
    const root = tmpDir();
    try {
      const sessionDir = path.join(root, 'session');
      fs.mkdirSync(sessionDir, { recursive: true });

      const frontmatterStatuses = new Map();
      for (const ticket of fixture.tickets) {
        makeTicketDir(sessionDir, ticket.id, ticket.status);
        frontmatterStatuses.set(ticket.id, ticket.status);
      }

      if (fixture.withManagerHandoff && fixture.state.current_ticket) {
        const ticketDir = path.join(sessionDir, fixture.state.current_ticket);
        fs.mkdirSync(ticketDir, { recursive: true });
        writeConformance(ticketDir);
      }

      const state = {
        current_ticket: fixture.state.current_ticket,
        session_dir: fixture.state.useSessionDir ? sessionDir : fixture.state.session_dir,
      };

      const expected = resolveLegacy(state, frontmatterStatuses);
      const actual = resolveTicketDesyncWinner(state, frontmatterStatuses);
      assert.equal(actual.action, expected.action, `${fixture.name}: action mismatch`);
      assert.equal(actual.winner, expected.winner, `${fixture.name}: winner mismatch`);
      if (fixture.expectedWinner !== undefined) {
        assert.equal(actual.winner, fixture.expectedWinner, `${fixture.name}: expected winner mismatch`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

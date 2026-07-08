// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { applyCourseCorrectionRestructure } from '../../services/transaction-ticket-ops.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'course-correct-hot-swap-'));
}

function withSession(fn) {
  const sessionDir = tmpDir();
  try {
    fn(sessionDir);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
}

function writeTicket(sessionDir, ticketId, status = 'Todo') {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const ticketPath = path.join(ticketDir, `rick_ticket_${ticketId}.md`);
  const content = [
    '---',
    `id: ${ticketId}`,
    `status: "${status}"`,
    'title: "Example"',
    '---',
    '',
    '# Example',
    '',
  ].join('\n');
  fs.writeFileSync(ticketPath, content);
  return { ticketPath, content };
}

function writeState(sessionDir, currentTicket) {
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    active: true,
    working_dir: sessionDir,
    step: 'implement',
    iteration: 1,
    max_iterations: 3,
    max_time_minutes: 30,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1,
    completion_promise: null,
    original_prompt: 'integration',
    current_ticket: currentTicket,
    history: [],
    started_at: '2026-04-30T00:00:00.000Z',
    session_dir: sessionDir,
    schema_version: 3,
    tickets_version: 0,
    last_course_correction: null,
    activity: [],
  }, null, 2));
}

function readState(sessionDir) {
  return JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
}

test('course-correct hot-swap branch a redirects killed current ticket to restart ticket', () => {
  withSession((sessionDir) => {
    writeTicket(sessionDir, 'dead123');
    writeState(sessionDir, 'dead123');

    const result = applyCourseCorrectionRestructure({
      sessionRoot: sessionDir,
      proposalPath: path.join(sessionDir, 'change_proposal_2026-04-30T20-00-00Z.md'),
      restartTicketId: 'restart123',
      killedTicketIds: ['dead123'],
      addedTickets: [{ ticketId: 'restart123', body: '# Restart\n' }],
      now: '2026-04-30T20:00:00.000Z',
    });

    const state = readState(sessionDir);
    assert.equal(result.branch, 'a');
    assert.equal(state.current_ticket, 'restart123');
    assert.equal(state.tickets_version, 1);
    assert.equal(state.activity.some(entry => entry.event === 'course_corrected' && entry.branch === 'a'), true);
  });
});

test('course-correct hot-swap branch b keeps surviving current ticket', () => {
  withSession((sessionDir) => {
    writeTicket(sessionDir, 'keep123');
    writeTicket(sessionDir, 'dead123');
    writeState(sessionDir, 'keep123');

    const result = applyCourseCorrectionRestructure({
      sessionRoot: sessionDir,
      proposalPath: path.join(sessionDir, 'change_proposal_2026-04-30T20-05-00Z.md'),
      restartTicketId: null,
      killedTicketIds: ['dead123'],
      now: '2026-04-30T20:05:00.000Z',
    });

    const state = readState(sessionDir);
    assert.equal(result.branch, 'b');
    assert.equal(state.current_ticket, 'keep123');
    assert.equal(state.tickets_version, 1);
    assert.equal(state.activity.some(entry => entry.event === 'course_corrected' && entry.branch === 'b'), true);
  });
});

test('course-correct hot-swap branch c materializes and redirects to added current ticket', () => {
  withSession((sessionDir) => {
    writeTicket(sessionDir, 'keep123');
    writeState(sessionDir, 'new123');

    const result = applyCourseCorrectionRestructure({
      sessionRoot: sessionDir,
      proposalPath: path.join(sessionDir, 'change_proposal_2026-04-30T20-10-00Z.md'),
      restartTicketId: null,
      addedTickets: [{ ticketId: 'new123', body: '# New\n' }],
      now: '2026-04-30T20:10:00.000Z',
    });

    const state = readState(sessionDir);
    const redirect = state.activity.find(entry => entry.event === 'current_ticket_redirected_to_new');
    assert.equal(result.branch, 'c');
    assert.equal(state.current_ticket, 'new123');
    assert.equal(fs.existsSync(path.join(sessionDir, 'new123', 'rick_ticket_new123.md')), true);
    assert.equal(redirect.to_ticket_id, 'new123');
    assert.equal(state.activity.some(entry => entry.event === 'course_corrected' && entry.branch === 'c'), true);
  });
});

test('course-correct hot-swap partial failure replay-reverses applied ledger steps', () => {
  withSession((sessionDir) => {
    const killed = writeTicket(sessionDir, 'dead123');
    writeState(sessionDir, 'keep123');
    const badDirPath = path.join(sessionDir, 'bad123');
    fs.mkdirSync(badDirPath);

    assert.throws(
      () => applyCourseCorrectionRestructure({
        sessionRoot: sessionDir,
        proposalPath: path.join(sessionDir, 'change_proposal_2026-04-30T20-15-00Z.md'),
        restartTicketId: null,
        killedTicketIds: ['dead123'],
        addedTickets: [{
          ticketId: 'bad123',
          files: [{ path: badDirPath, content: 'cannot overwrite directory' }],
        }],
        now: '2026-04-30T20:15:00.000Z',
      }),
      /EISDIR|illegal operation on a directory|is a directory/,
    );

    assert.equal(fs.readFileSync(killed.ticketPath, 'utf-8'), killed.content);
    assert.equal(readState(sessionDir).tickets_version, 0);
  });
});

// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applyCourseCorrectionRestructure,
  materializeNewTicket,
  recoverCourseCorrectionFromLedger,
  replayReverseLedger,
  updateTicketStatusInTransaction,
} from '../services/transaction-ticket-ops.js';
import { markTicketDone, markTicketSkipped } from '../services/pickle-utils.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'transaction-ticket-ops-'));
}

function withDir(fn) {
  const dir = tmpDir();
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
  return { ticketDir, ticketPath, content };
}

function writeState(sessionDir, overrides = {}) {
  const state = {
    active: true,
    working_dir: sessionDir,
    step: 'implement',
    iteration: 1,
    max_iterations: 3,
    max_time_minutes: 30,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1,
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: '2026-04-30T00:00:00.000Z',
    session_dir: sessionDir,
    schema_version: 3,
    tickets_version: 0,
    last_course_correction: null,
    activity: [],
    ...overrides,
  };
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state, null, 2));
  return state;
}

function readState(sessionDir) {
  return JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf-8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

test('updateTicketStatusInTransaction returns a planned write without mutating the ticket file', () => {
  withDir((sessionDir) => {
    const { ticketPath, content } = writeTicket(sessionDir, 'abc123');

    const planned = updateTicketStatusInTransaction('abc123', 'Done', sessionDir, {
      now: '2026-04-30T12:00:00.000Z',
    });

    assert.equal(planned.path, ticketPath);
    assert.match(planned.content, /^status: "Done"$/m);
    assert.match(planned.content, /^completed_at: "2026-04-30T12:00:00.000Z"$/m);
    assert.equal(fs.readFileSync(ticketPath, 'utf-8'), content);
  });
});

test('materializeNewTicket returns a ticket directory and planned files', () => {
  withDir((sessionDir) => {
    const planned = materializeNewTicket({
      ticketId: 'new123',
      sessionDir,
      frontmatter: { title: 'New Ticket', order: 7 },
      body: '# New Ticket\n',
    });

    assert.equal(planned.dirPath, path.join(sessionDir, 'new123'));
    assert.deepEqual(planned.files.map(file => file.path), [
      path.join(sessionDir, 'new123', 'rick_ticket_new123.md'),
    ]);
    assert.match(planned.files[0].content, /^id: "new123"$/m);
    assert.match(planned.files[0].content, /^status: "Todo"$/m);
    assert.match(planned.files[0].content, /^title: "New Ticket"$/m);
    assert.match(planned.files[0].content, /^order: 7$/m);
    assert.match(planned.files[0].content, /# New Ticket/);
    assert.equal(fs.existsSync(planned.dirPath), false);
  });
});

test('replayReverseLedger removes created files and restores backed-up content', () => {
  withDir((sessionDir) => {
    const createdPath = path.join(sessionDir, 'created', 'file.md');
    const updatedPath = path.join(sessionDir, 'updated.md');
    const ledgerPath = path.join(sessionDir, 'ledger.json');
    fs.mkdirSync(path.dirname(createdPath), { recursive: true });
    fs.writeFileSync(createdPath, 'created');
    fs.writeFileSync(updatedPath, 'new');
    fs.writeFileSync(ledgerPath, JSON.stringify({
      entries: [
        { action: 'create', path: path.relative(sessionDir, createdPath) },
        { action: 'write', path: updatedPath, beforeContent: 'old' },
      ],
    }));

    const restored = replayReverseLedger(ledgerPath, sessionDir);

    assert.equal(fs.existsSync(createdPath), false);
    assert.equal(fs.readFileSync(updatedPath, 'utf-8'), 'old');
    assert.deepEqual(restored, [{ path: updatedPath, content: 'old' }]);
  });
});

test('replayReverseLedger rejects paths outside the session root', () => {
  withDir((sessionDir) => {
    const ledgerPath = path.join(sessionDir, 'ledger.json');
    fs.writeFileSync(ledgerPath, JSON.stringify({
      entries: [
        { action: 'create', path: '../outside.md' },
      ],
    }));

    assert.throws(
      () => replayReverseLedger(ledgerPath, sessionDir),
      /Path escapes ticket transaction root/,
    );
  });
});

test('applyCourseCorrectionRestructure kills, adds, bumps tickets_version, and writes apply ledger', () => {
  withDir((sessionDir) => {
    const killed = writeTicket(sessionDir, 'kill123');
    writeState(sessionDir, { current_ticket: 'kill123', tickets_version: 4 });
    const proposalPath = path.join(sessionDir, 'change_proposal_2026-04-30T12-00-00Z.md');

    const result = applyCourseCorrectionRestructure({
      sessionRoot: sessionDir,
      proposalPath,
      restartTicketId: 'new123',
      killedTicketIds: ['kill123'],
      addedTickets: [{
        ticketId: 'new123',
        frontmatter: { title: 'Replacement' },
        body: '# Replacement\n',
      }],
      now: '2026-04-30T12:00:00.000Z',
    });

    const state = readState(sessionDir);
    const killedContent = fs.readFileSync(killed.ticketPath, 'utf-8');
    const newTicketPath = path.join(sessionDir, 'new123', 'rick_ticket_new123.md');
    const ledger = readJsonl(result.ledgerPath);

    assert.equal(result.branch, 'a');
    assert.equal(result.ticketsVersion, 5);
    assert.equal(state.current_ticket, 'new123');
    assert.equal(state.tickets_version, 5);
    assert.equal(state.last_course_correction.restart_ticket_id, 'new123');
    assert.match(killedContent, /^status: "Killed"$/m);
    assert.equal(fs.existsSync(newTicketPath), true);
    assert.match(fs.readFileSync(newTicketPath, 'utf-8'), /^title: "Replacement"$/m);
    assert.equal(path.basename(result.ledgerPath), 'change_proposal_2026-04-30T12-00-00Z_apply.log');
    assert.equal(ledger.some(entry => entry.operation === 'kill_ticket' && entry.status === 'applied'), true);
    assert.equal(ledger.some(entry => entry.operation === 'add_ticket' && entry.status === 'applied'), true);
    assert.equal(state.activity.some(entry => entry.event === 'course_corrected' && entry.branch === 'a'), true);
    assert.equal(state.activity.some(entry => entry.event === 'readiness_delta_requested'), true);
  });
});

test('applyCourseCorrectionRestructure branch b keeps current_ticket unchanged', () => {
  withDir((sessionDir) => {
    writeTicket(sessionDir, 'keep123');
    writeTicket(sessionDir, 'kill123');
    writeState(sessionDir, { current_ticket: 'keep123', tickets_version: 2 });

    const result = applyCourseCorrectionRestructure({
      sessionRoot: sessionDir,
      proposalPath: path.join(sessionDir, 'change_proposal_2026-04-30T12-30-00Z.md'),
      restartTicketId: null,
      killedTicketIds: ['kill123'],
      now: '2026-04-30T12:30:00.000Z',
    });

    const state = readState(sessionDir);
    assert.equal(result.branch, 'b');
    assert.equal(state.current_ticket, 'keep123');
    assert.equal(state.activity.some(entry => entry.event === 'course_corrected' && entry.branch === 'b'), true);
  });
});

test('applyCourseCorrectionRestructure branch c redirects current_ticket to newly added ticket', () => {
  withDir((sessionDir) => {
    writeTicket(sessionDir, 'keep123');
    writeState(sessionDir, { current_ticket: 'new123', tickets_version: 2, activity: [] });

    const result = applyCourseCorrectionRestructure({
      sessionRoot: sessionDir,
      proposalPath: path.join(sessionDir, 'change_proposal_2026-04-30T12-45-00Z.md'),
      restartTicketId: null,
      addedTickets: [{
        ticketId: 'new123',
        frontmatter: { title: 'New Current' },
        body: '# New Current\n',
      }],
      now: '2026-04-30T12:45:00.000Z',
    });

    const state = readState(sessionDir);
    const redirect = state.activity.find(entry => entry.event === 'current_ticket_redirected_to_new');
    assert.equal(result.branch, 'c');
    assert.equal(state.current_ticket, 'new123');
    assert.equal(redirect.from_ticket_id, 'new123');
    assert.equal(redirect.to_ticket_id, 'new123');
    assert.equal(redirect.ticket_id, 'new123');
    assert.equal(state.activity.some(entry => entry.event === 'course_corrected' && entry.branch === 'c'), true);
  });
});

test('applyCourseCorrectionRestructure replays reverse ledger on partial failure', () => {
  withDir((sessionDir) => {
    const killed = writeTicket(sessionDir, 'kill123');
    writeState(sessionDir, { current_ticket: 'keep123', tickets_version: 1 });
    const badDirPath = path.join(sessionDir, 'bad123');
    fs.mkdirSync(badDirPath);

    assert.throws(
      () => applyCourseCorrectionRestructure({
        sessionRoot: sessionDir,
        proposalPath: path.join(sessionDir, 'change_proposal_2026-04-30T13-00-00Z.md'),
        restartTicketId: null,
        killedTicketIds: ['kill123'],
        addedTickets: [{
          ticketId: 'bad123',
          files: [{ path: badDirPath, content: 'cannot write over directory' }],
        }],
        now: '2026-04-30T13:00:00.000Z',
      }),
      /EISDIR|illegal operation on a directory|is a directory/,
    );

    const state = readState(sessionDir);
    assert.equal(fs.readFileSync(killed.ticketPath, 'utf-8'), killed.content);
    assert.equal(state.tickets_version, 1);
    assert.equal(state.activity.length, 0);
  });
});

test('recoverCourseCorrectionFromLedger reverse-replays applied steps and records recovery activity', () => {
  withDir((sessionDir) => {
    const ticket = writeTicket(sessionDir, 'abc123', 'Killed');
    writeState(sessionDir, { activity: [] });
    const ledgerPath = path.join(sessionDir, 'change_proposal_2026-04-30T15-00-00Z_apply.log');
    fs.writeFileSync(ledgerPath, [
      JSON.stringify({
        step: 1,
        action: 'write',
        operation: 'kill_ticket',
        ticket_id: 'abc123',
        path: ticket.ticketPath,
        status: 'applied',
        recovery_class: 'restore-previous-content',
        beforeContent: ticket.content,
        previousContent: ticket.content,
        afterContent: fs.readFileSync(ticket.ticketPath, 'utf-8'),
        createdAt: '2026-04-30T15:00:00.000Z',
      }),
      '',
    ].join('\n'));

    const result = recoverCourseCorrectionFromLedger({
      sessionRoot: sessionDir,
      ledgerPath,
      mode: 'reverse',
      now: '2026-04-30T15:05:00.000Z',
    });

    assert.deepEqual(result.recoveredSteps, [1]);
    assert.equal(result.lastSuccessfulStep, 1);
    assert.equal(fs.readFileSync(ticket.ticketPath, 'utf-8'), ticket.content);
    const state = readState(sessionDir);
    assert.equal(state.activity.some(entry => entry.event === 'course_correct_recovered' && entry.mode === 'reverse'), true);
  });
});

// AP-EXT-ITER12-01: a SIGKILL between the forward writeFileSync and the 'applied'
// ledger append leaves the file overwritten on disk under a 'started'-only entry.
// Reverse recovery MUST restore it — the restore content is already in the ledger.
test('recoverCourseCorrectionFromLedger reverse-restores a started-only crash-window step', () => {
  withDir((sessionDir) => {
    const applied = writeTicket(sessionDir, 'aaa111', 'Todo');
    const crashed = writeTicket(sessionDir, 'bbb222', 'Todo');
    writeState(sessionDir, { activity: [] });

    // Both files are already overwritten on disk — the forward pass got that far.
    fs.writeFileSync(applied.ticketPath, 'OVERWRITTEN-APPLIED');
    fs.writeFileSync(crashed.ticketPath, 'OVERWRITTEN-CRASHED');

    const entry = (step, ticket, status) => JSON.stringify({
      step,
      action: 'write',
      operation: 'kill_ticket',
      ticket_id: path.basename(path.dirname(ticket.ticketPath)),
      path: ticket.ticketPath,
      status,
      recovery_class: 'restore-previous-content',
      beforeContent: ticket.content,
      previousContent: ticket.content,
      afterContent: 'OVERWRITTEN',
      createdAt: '2026-04-30T15:00:00.000Z',
    });

    const ledgerPath = path.join(sessionDir, 'change_proposal_2026-04-30T15-00-00Z_apply.log');
    fs.writeFileSync(ledgerPath, [
      entry(1, applied, 'started'),
      entry(1, applied, 'applied'),
      entry(2, crashed, 'started'), // crash landed here — no 'applied' line follows
      '',
    ].join('\n'));

    const result = recoverCourseCorrectionFromLedger({
      sessionRoot: sessionDir,
      ledgerPath,
      mode: 'reverse',
      now: '2026-04-30T15:05:00.000Z',
    });

    // The crashed step is recovered, and reported — not silently skipped.
    assert.deepEqual(result.recoveredSteps, [2, 1]);
    assert.equal(fs.readFileSync(crashed.ticketPath, 'utf-8'), crashed.content);
    assert.equal(fs.readFileSync(applied.ticketPath, 'utf-8'), applied.content);
    // lastSuccessfulStep keeps its 'last applied step' meaning and does not cap reversal.
    assert.equal(result.lastSuccessfulStep, 1);
  });
});

// A 'failed' entry means writeFileSync threw — which can still leave a partial
// file (ENOSPC). Same ledger, same rule: reverse it.
test('recoverCourseCorrectionFromLedger reverse-restores a failed step with a partial write', () => {
  withDir((sessionDir) => {
    const ticket = writeTicket(sessionDir, 'ccc333', 'Todo');
    writeState(sessionDir, { activity: [] });
    fs.writeFileSync(ticket.ticketPath, 'PARTIAL-WRI');

    const ledgerPath = path.join(sessionDir, 'change_proposal_2026-04-30T15-00-00Z_apply.log');
    fs.writeFileSync(ledgerPath, [
      JSON.stringify({
        step: 1,
        action: 'write',
        operation: 'kill_ticket',
        ticket_id: 'ccc333',
        path: ticket.ticketPath,
        status: 'failed',
        error: 'ENOSPC: no space left on device',
        recovery_class: 'restore-previous-content',
        beforeContent: ticket.content,
        previousContent: ticket.content,
        afterContent: 'OVERWRITTEN',
        createdAt: '2026-04-30T15:00:00.000Z',
      }),
      '',
    ].join('\n'));

    const result = recoverCourseCorrectionFromLedger({
      sessionRoot: sessionDir,
      ledgerPath,
      mode: 'reverse',
      now: '2026-04-30T15:05:00.000Z',
    });

    assert.deepEqual(result.recoveredSteps, [1]);
    assert.equal(fs.readFileSync(ticket.ticketPath, 'utf-8'), ticket.content);
  });
});

// A create-step reversal deletes; if the crashed write never landed, the
// existsSync guard makes it a no-op. Pins the safe fail direction.
test('reverse recovery of a started create-step whose write never landed is a no-op', () => {
  withDir((sessionDir) => {
    writeState(sessionDir, { activity: [] });
    const neverCreated = path.join(sessionDir, 'ddd444', 'rick_ticket_ddd444.md');

    const ledgerPath = path.join(sessionDir, 'change_proposal_2026-04-30T15-00-00Z_apply.log');
    fs.writeFileSync(ledgerPath, [
      JSON.stringify({
        step: 1,
        action: 'create',
        operation: 'add_ticket',
        ticket_id: 'ddd444',
        path: neverCreated,
        status: 'started',
        recovery_class: 'delete-created',
        beforeContent: null,
        previousContent: null,
        afterContent: 'NEW',
        createdAt: '2026-04-30T15:00:00.000Z',
      }),
      '',
    ].join('\n'));

    const result = recoverCourseCorrectionFromLedger({
      sessionRoot: sessionDir,
      ledgerPath,
      mode: 'reverse',
      now: '2026-04-30T15:05:00.000Z',
    });

    assert.deepEqual(result.recoveredSteps, [1]);
    assert.equal(fs.existsSync(neverCreated), false);
  });
});

test('recoverCourseCorrectionFromLedger forward-replays ledger only with force', () => {
  withDir((sessionDir) => {
    const ticket = writeTicket(sessionDir, 'abc123', 'Todo');
    writeState(sessionDir, { activity: [] });
    const nextContent = ticket.content.replace('status: "Todo"', 'status: "Killed"');
    const ledgerPath = path.join(sessionDir, 'change_proposal_2026-04-30T16-00-00Z_apply.log');
    fs.writeFileSync(ledgerPath, [
      JSON.stringify({
        step: 1,
        action: 'write',
        operation: 'kill_ticket',
        ticket_id: 'abc123',
        path: ticket.ticketPath,
        status: 'failed',
        recovery_class: 'restore-previous-content',
        beforeContent: ticket.content,
        previousContent: ticket.content,
        afterContent: nextContent,
        createdAt: '2026-04-30T16:00:00.000Z',
      }),
      '',
    ].join('\n'));

    assert.throws(
      () => recoverCourseCorrectionFromLedger({ sessionRoot: sessionDir, ledgerPath, mode: 'forward' }),
      /--recover requires --force/,
    );

    const result = recoverCourseCorrectionFromLedger({
      sessionRoot: sessionDir,
      ledgerPath,
      mode: 'forward',
      force: true,
      now: '2026-04-30T16:05:00.000Z',
    });

    assert.deepEqual(result.recoveredSteps, [1]);
    assert.match(fs.readFileSync(ticket.ticketPath, 'utf-8'), /^status: "Killed"$/m);
    const state = readState(sessionDir);
    assert.equal(state.activity.some(entry => entry.event === 'course_correct_recovered' && entry.mode === 'forward'), true);
  });
});

test('applyCourseCorrectionRestructure auto-apply failure writes HALT file and activity', () => {
  withDir((sessionDir) => {
    writeTicket(sessionDir, 'kill123');
    writeState(sessionDir, { current_ticket: 'keep123', tickets_version: 1, activity: [] });
    const badDirPath = path.join(sessionDir, 'bad123');
    fs.mkdirSync(badDirPath);

    assert.throws(
      () => applyCourseCorrectionRestructure({
        sessionRoot: sessionDir,
        proposalPath: path.join(sessionDir, 'change_proposal_2026-04-30T17-00-00Z.md'),
        restartTicketId: null,
        killedTicketIds: ['kill123'],
        addedTickets: [{
          ticketId: 'bad123',
          files: [{ path: badDirPath, content: 'cannot write over directory' }],
        }],
        now: '2026-04-30T17:00:00.000Z',
        autoApply: true,
      }),
      /EISDIR|illegal operation on a directory|is a directory/,
    );

    const haltPath = path.join(sessionDir, 'HALT_2026-04-30T17-00-00Z.md');
    assert.equal(fs.existsSync(haltPath), true);
    const halt = fs.readFileSync(haltPath, 'utf-8');
    assert.match(halt, /Failed step: 2/);
    assert.match(halt, /--recover-from-ledger/);
    assert.match(halt, /--recover --force/);
    assert.match(halt, /--reset-current-ticket/);
    const state = readState(sessionDir);
    assert.equal(state.activity.some(entry => entry.event === 'course_correct_apply_failed' && entry.failed_step === 2), true);
  });
});

test('applyCourseCorrectionRestructure refuses to run while restructure lock exists', () => {
  withDir((sessionDir) => {
    const ticket = writeTicket(sessionDir, 'kill123');
    writeState(sessionDir, { current_ticket: 'kill123' });
    const lockPath = path.join(sessionDir, 'restructure.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: Date.now() }));

    assert.throws(
      () => applyCourseCorrectionRestructure({
        sessionRoot: sessionDir,
        proposalPath: path.join(sessionDir, 'change_proposal_2026-04-30T14-00-00Z.md'),
        restartTicketId: null,
        killedTicketIds: ['kill123'],
        now: '2026-04-30T14:00:00.000Z',
      }),
      /EEXIST/,
    );

    assert.equal(fs.readFileSync(ticket.ticketPath, 'utf-8'), ticket.content);
    assert.equal(readState(sessionDir).tickets_version, 0);
    fs.rmSync(lockPath, { force: true });
  });
});

test('existing ticket status wrappers write planned content at the wrapper boundary', () => {
  withDir((sessionDir) => {
    const doneTicket = writeTicket(sessionDir, 'done123');
    const skippedTicket = writeTicket(sessionDir, 'skip123');

    assert.equal(markTicketDone(sessionDir, 'done123'), true);
    assert.equal(markTicketSkipped(sessionDir, 'skip123'), true);

    const doneContent = fs.readFileSync(doneTicket.ticketPath, 'utf-8');
    const skippedContent = fs.readFileSync(skippedTicket.ticketPath, 'utf-8');
    assert.match(doneContent, /^status: "Done"$/m);
    assert.match(doneContent, /^completed_at: ".+"$/m);
    assert.match(skippedContent, /^status: "Skipped"$/m);
    assert.match(skippedContent, /^skipped_at: ".+"$/m);
  });
});

// AP-EXT-ITER12-01 anchor executability (anatomy-park iter 9).
//
// The catalog entry read "BOTH rollback paths over the apply ledger select via
// `selectForwardEntries`". That was false at its own authoring commit d1e6302c:
// the two consumers are `reverseAppliedEntries` and `forwardReplayEntries` (a
// FORWARD replay, not a rollback), while the in-transaction rollback
// `replayReverseLedger` filters nothing. The guarded behaviour — a `started`-only
// crash-window step IS reversed — held on every path; only the anchor was wrong,
// which sends a reviewer hunting a guard that never existed.
//
// This pins the anchor by RUNNING it, not by restating it.
test('AP-EXT-ITER12-01: selectForwardEntries has exactly two consumers, and replayReverseLedger is not one', () => {
  const src = fs.readFileSync(
    path.resolve(import.meta.dirname, '../src/services/transaction-ticket-ops.ts'),
    'utf-8',
  );
  const consumers = src
    .split('\n')
    .filter(line => line.includes('selectForwardEntries(') && !line.includes('function selectForwardEntries'));
  assert.equal(consumers.length, 2, 'selectForwardEntries consumer count drifted from the catalog anchor');

  const bodyOf = (name) => {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start > -1, `${name} not found`);
    const next = src.indexOf('\nfunction ', start + 1);
    const nextExport = src.indexOf('\nexport function ', start + 1);
    const ends = [next, nextExport].filter(i => i > -1);
    return src.slice(start, ends.length ? Math.min(...ends) : src.length);
  };

  assert.match(bodyOf('reverseAppliedEntries'), /selectForwardEntries\(entries\)/);
  assert.match(bodyOf('forwardReplayEntries'), /selectForwardEntries\(entries\)/);
  // The in-transaction rollback deliberately filters NOTHING — a status filter
  // here would drop the `started`-only crash window the invariant exists to save.
  const replay = bodyOf('replayReverseLedger');
  assert.match(replay, /parseLedgerContent\(fs\.readFileSync\(ledgerPath/);
  assert.doesNotMatch(replay, /selectForwardEntries/);
});

// The behavioural half: whatever the anchor says, the in-transaction rollback
// must restore a step whose ledger only ever reached `started` (SIGKILL between
// the overwrite and the `applied` append — its beforeContent is the only copy).
test('AP-EXT-ITER12-01: replayReverseLedger reverses a started-only crash-window step', () => {
  withDir((dir) => {
    // The shape `rollbackAndHaltApply` actually sees: step 1 completed
    // (started+applied), step 2 died in the crash window (started only, its
    // `failed` append never landed). BOTH must be reversed — the started-only
    // entry's beforeContent is the only copy of that file.
    const fileA = path.join(dir, 'ticket-a', 'rick_ticket_a.md');
    const fileB = path.join(dir, 'ticket-b', 'rick_ticket_b.md');
    for (const f of [fileA, fileB]) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, 'AFTER (half-applied)', 'utf-8');
    }

    const entry = (step, target, status) => JSON.stringify({
      step,
      action: 'write',
      operation: 'kill_ticket',
      ticket_id: path.basename(path.dirname(target)),
      path: target,
      status,
      recovery_class: 'restore-previous-content',
      beforeContent: `BEFORE ${step} (the only copy)`,
      previousContent: `BEFORE ${step} (the only copy)`,
      afterContent: 'AFTER (half-applied)',
      content: 'AFTER (half-applied)',
      createdAt: '2026-07-23T00:00:00.000Z',
    });

    const ledgerPath = path.join(dir, 'change_proposal_x_apply.log');
    fs.writeFileSync(ledgerPath, [
      entry(1, fileA, 'started'),
      entry(1, fileA, 'applied'),
      entry(2, fileB, 'started'),
    ].join('\n') + '\n', 'utf-8');

    replayReverseLedger(ledgerPath, dir);

    assert.equal(fs.readFileSync(fileA, 'utf-8'), 'BEFORE 1 (the only copy)');
    assert.equal(
      fs.readFileSync(fileB, 'utf-8'),
      'BEFORE 2 (the only copy)',
      'the started-only crash-window step was not reversed',
    );
  });
});

// AP-EXT-ITER8-02: `applyPlannedWrite` records `beforeContent: null` for a file
// that EXISTED but whose read threw. Deciding the reversal from content-nullness
// then reads that as "the apply created it" and DELETES a pre-existing file.
// The reversal decision must come from the `action` discriminant instead.
test('AP-EXT-ITER8-02: a write-action entry with no recorded prior content is never deleted', () => {
  withDir((sessionDir) => {
    const ticket = writeTicket(sessionDir, 'abc123', 'Todo');
    writeState(sessionDir, { activity: [] });
    fs.writeFileSync(ticket.ticketPath, 'OVERWRITTEN BY THE APPLY\n');

    const ledgerPath = path.join(sessionDir, 'change_proposal_2026-08-10T00-00-00Z_apply.log');
    fs.writeFileSync(ledgerPath, JSON.stringify({
      step: 1,
      action: 'write',
      operation: 'kill_ticket',
      ticket_id: 'abc123',
      path: ticket.ticketPath,
      status: 'applied',
      recovery_class: 'restore-previous-content',
      beforeContent: null,
      previousContent: null,
      afterContent: 'OVERWRITTEN BY THE APPLY\n',
      createdAt: '2026-08-10T00:00:00.000Z',
    }) + '\n');

    recoverCourseCorrectionFromLedger({
      sessionRoot: sessionDir,
      ledgerPath,
      mode: 'reverse',
      now: '2026-08-10T00:05:00.000Z',
    });

    assert.equal(
      fs.existsSync(ticket.ticketPath),
      true,
      'reverse recovery DELETED a file the ledger says pre-dated the transaction',
    );
    assert.equal(fs.readFileSync(ticket.ticketPath, 'utf-8'), 'OVERWRITTEN BY THE APPLY\n');
  });
});

test('AP-EXT-ITER8-02: replayReverseLedger leaves a write-action entry with no prior content in place', () => {
  withDir((sessionDir) => {
    const ticket = writeTicket(sessionDir, 'def456', 'Todo');
    const createdPath = path.join(sessionDir, 'def456', 'created.md');
    fs.writeFileSync(createdPath, 'created by the apply\n');

    const ledgerPath = path.join(sessionDir, 'reverse.ledger.json');
    fs.writeFileSync(ledgerPath, JSON.stringify({
      entries: [
        { action: 'write', path: ticket.ticketPath, beforeContent: null },
        { action: 'create', path: createdPath },
      ],
    }));

    replayReverseLedger(ledgerPath, sessionDir);

    assert.equal(fs.existsSync(ticket.ticketPath), true, 'a pre-existing file was destroyed by the replay');
    assert.equal(fs.existsSync(createdPath), false, 'a create-action entry must still be deleted');
  });
});

// The apply side must not manufacture that ambiguous record in the first place:
// an existing file it cannot read has no recoverable prior content, so the write
// is refused rather than made unreversible.
test('AP-EXT-ITER8-02: applying over an unreadable existing file is refused, not silently unreversible', () => {
  withDir((sessionDir) => {
    writeState(sessionDir, { activity: [] });
    // A file already sitting at the new ticket's target path, unreadable — so the
    // apply's before-read throws and it has no prior content to reverse to.
    const targetDir = path.join(sessionDir, 'ghi789');
    fs.mkdirSync(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, 'rick_ticket_ghi789.md');
    fs.writeFileSync(targetPath, 'PRE-EXISTING, UNREADABLE\n');
    // Write-only: the before-read throws, but the overwrite would SUCCEED — so only
    // the guard, not the OS, stands between the apply and an unreversible write.
    fs.chmodSync(targetPath, 0o200);

    let threw = null;
    try {
      applyCourseCorrectionRestructure({
        sessionRoot: sessionDir,
        proposalPath: path.join(sessionDir, 'change_proposal.md'),
        restartTicketId: 'ghi789',
        addedTickets: [{ ticketId: 'ghi789', frontmatter: { title: 'New' }, body: '# New\n' }],
        now: '2026-08-10T00:00:00.000Z',
      });
    } catch (err) {
      threw = err;
    } finally {
      fs.chmodSync(targetPath, 0o644);
    }

    assert.notEqual(threw, null, 'the apply overwrote a file whose prior content it could not read');
    assert.equal(
      fs.readFileSync(targetPath, 'utf-8'),
      'PRE-EXISTING, UNREADABLE\n',
      'the unreversible write must not have landed',
    );
  });
});

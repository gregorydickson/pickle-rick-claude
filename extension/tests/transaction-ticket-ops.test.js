// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  materializeNewTicket,
  replayReverseLedger,
  updateTicketStatusInTransaction,
} from '../services/transaction-ticket-ops.js';
import { markTicketDone, markTicketSkipped, markTicketWithStatus } from '../services/pickle-utils.js';
import { validateCourseCorrectionProposal } from '../bin/correct-course.js';

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

// AP-EXT-ITER12-01: a ledger replay must restore a step whose ledger only ever
// reached `started` (SIGKILL between the overwrite and the `applied` append — its
// beforeContent is the only copy).
test('AP-EXT-ITER12-01: replayReverseLedger reverses a started-only crash-window step', () => {
  withDir((dir) => {
    // The shape a crashed apply leaves: step 1 completed
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

// AP-EXT-ITER8-02: the reversal decision comes from the `action` discriminant, never
// content-nullness — a write-action entry with no prior content is left in place.
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

// AP-EXT-ITER197-01: `parseLedgerContent` chose the container-vs-JSONL branch on a
// LINE COUNT (`startsWith('{') && !includes('\n')`). A one-entry apply ledger — the
// step-1 crash window, `started` appended and the overwrite landed but the `applied`
// append never did — satisfies that test exactly, so it was resolved as a
// `ReverseLedger` wrapper, yielded no `entries`/`actions`/`steps`, and returned [].
// The replay then reversed NOTHING and reported success, while
// the entry's `beforeContent` was the only surviving copy of the file.
//
// The oracle is DIFFERENTIAL: the same entry, duplicated to make the ledger two
// lines, reverses correctly today. Only the line count differs, so a fixture that
// uses the two-line form cannot observe the defect at all.
function crashWindowEntry(step, target) {
  return JSON.stringify({
    step,
    action: 'write',
    operation: 'kill_ticket',
    ticket_id: path.basename(path.dirname(target)),
    path: target,
    status: 'started',
    recovery_class: 'restore-previous-content',
    beforeContent: 'BEFORE (the only copy)',
    previousContent: 'BEFORE (the only copy)',
    afterContent: 'AFTER (half-applied)',
    content: 'AFTER (half-applied)',
    createdAt: '2026-09-03T00:00:00.000Z',
  });
}

test('AP-EXT-ITER197-01: a ONE-entry apply ledger reverses its crash-window step', () => {
  withDir((dir) => {
    const file = path.join(dir, 'ticket-a', 'rick_ticket_a.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'AFTER (half-applied)', 'utf-8');

    const ledgerPath = path.join(dir, 'change_proposal_x_apply.log');
    fs.writeFileSync(ledgerPath, crashWindowEntry(1, file) + '\n', 'utf-8');

    const restored = replayReverseLedger(ledgerPath, dir);

    assert.equal(
      fs.readFileSync(file, 'utf-8'),
      'BEFORE (the only copy)',
      'the sole ledger entry was resolved as an empty wrapper and its step went unreversed',
    );
    assert.equal(restored.length, 1, 'a one-entry ledger must report the step it restored');
  });
});

test('AP-EXT-ITER197-01: one-entry and two-entry ledgers of the SAME step agree', () => {
  withDir((dir) => {
    const outcomeFor = (lineCount) => {
      const file = path.join(dir, `ticket-${lineCount}`, 'rick_ticket.md');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'AFTER (half-applied)', 'utf-8');
      const ledgerPath = path.join(dir, `change_proposal_${lineCount}_apply.log`);
      const line = crashWindowEntry(1, file);
      fs.writeFileSync(ledgerPath, Array(lineCount).fill(line).join('\n') + '\n', 'utf-8');
      const restored = replayReverseLedger(ledgerPath, dir);
      return { content: fs.readFileSync(file, 'utf-8'), restoredAny: restored.length > 0 };
    };

    // Line count is an incidental property of the ledger, never a format signal.
    assert.deepEqual(outcomeFor(1), outcomeFor(2));
  });
});

test('AP-EXT-ITER197-01: a multi-line ReverseLedger wrapper is still read as a container', () => {
  withDir((sessionDir) => {
    const createdPath = path.join(sessionDir, 'created', 'file.md');
    const updatedPath = path.join(sessionDir, 'updated.md');
    fs.mkdirSync(path.dirname(createdPath), { recursive: true });
    fs.writeFileSync(createdPath, 'created');
    fs.writeFileSync(updatedPath, 'new');

    const ledgerPath = path.join(sessionDir, 'ledger.json');
    // Pretty-printed — multi-line, so the old line-count discriminator sent it to
    // the JSONL branch and `JSON.parse('{')` threw instead of reversing anything.
    fs.writeFileSync(ledgerPath, JSON.stringify({
      entries: [
        { action: 'create', path: path.relative(sessionDir, createdPath) },
        { action: 'write', path: updatedPath, beforeContent: 'old' },
      ],
    }, null, 2));

    const restored = replayReverseLedger(ledgerPath, sessionDir);

    assert.equal(fs.existsSync(createdPath), false);
    assert.equal(fs.readFileSync(updatedPath, 'utf-8'), 'old');
    assert.deepEqual(restored, [{ path: updatedPath, content: 'old' }]);
  });
});

test('AP-EXT-ITER197-01: a bare JSON-array ledger is read as a container', () => {
  withDir((sessionDir) => {
    const updatedPath = path.join(sessionDir, 'updated.md');
    fs.writeFileSync(updatedPath, 'new');

    const ledgerPath = path.join(sessionDir, 'ledger.json');
    // The third container form: a top-level array, with no wrapper object around it.
    fs.writeFileSync(ledgerPath, JSON.stringify([
      { action: 'write', path: updatedPath, beforeContent: 'old' },
    ]));

    const restored = replayReverseLedger(ledgerPath, sessionDir);

    assert.equal(fs.readFileSync(updatedPath, 'utf-8'), 'old');
    assert.deepEqual(restored, [{ path: updatedPath, content: 'old' }]);
  });
});

/**
 * AP-EXT-ITER223-01: `markTicketWithStatus` is THE ticket-status writer (`markTicketDone`,
 * `markTicketSkipped`, `setup.ts` and `mux-runner.ts` all route through it), and its boolean is
 * every caller's "did the status land?" oracle. The wrapper catches everything and otherwise
 * returns `true`, so the ONLY thing that can report a no-op is `assertStatusWasUpdated`'s throw.
 * That guard covers two no-op modes -- the status already equals the target, and the file carries
 * NO `status:` line so the rewrite regex never matched -- and only the first had a fixture
 * (`pickle-utils.test.js`, "no-op when already Done"). Narrowing the guard to the already-equal
 * case alone therefore survived the entire fast tier while `markTicketDone` returned `true` over a
 * file whose status stayed `null`; downstream, `norm(null)` is never `done`, so the ticket is
 * permanently non-terminal and `EPIC_COMPLETED` never fires. Absent LLM-authored frontmatter is a
 * measured class here, not a hypothetical -- see R-TIDNULL in `collectTickets` for `id`.
 *
 * Pinned as a DERIVED biconditional over a case table rather than as hand-picked expectations:
 * a third no-op mode is covered the moment it exists, with no row to remember to add.
 */
test('AP-EXT-ITER223-01: markTicketWithStatus returns true exactly when the status changed to the target', () => {
  const CASES = [
    { name: 'no status line in frontmatter', frontmatter: ['title: "x"'], target: 'Done' },
    { name: 'status already the target', frontmatter: ['status: "Done"', 'title: "x"'], target: 'Done' },
    { name: 'status differs, terminal target', frontmatter: ['status: "Todo"', 'title: "x"'], target: 'Done' },
    { name: 'status differs, non-terminal target', frontmatter: ['status: "Todo"', 'title: "x"'], target: 'In Progress' },
  ];

  withDir((sessionDir) => {
    const observed = CASES.map((testCase, index) => {
      const ticketId = `apiter223${index}`;
      fs.mkdirSync(path.join(sessionDir, ticketId), { recursive: true });
      const ticketPath = path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`);
      fs.writeFileSync(ticketPath, `---\nid: ${ticketId}\n${testCase.frontmatter.join('\n')}\n---\n\n# body\n`);

      const readStatus = () => {
        const match = fs.readFileSync(ticketPath, 'utf-8').match(/^status:\s*"?([^"\n]*)"?$/m);
        return match ? match[1] : null;
      };
      const before = readStatus();
      const returned = markTicketWithStatus(sessionDir, ticketId, testCase.target);
      return {
        name: testCase.name,
        returned,
        landed: before !== testCase.target && readStatus() === testCase.target,
      };
    });

    // The contract, uniformly: the boolean claims the status CHANGED to the target. A no-op --
    // for any reason -- must report false, and a real transition must report true.
    for (const row of observed) {
      assert.equal(
        row.returned,
        row.landed,
        `${row.name}: markTicketWithStatus returned ${row.returned} but landed=${row.landed}`,
      );
    }

    // Both sides must be populated, or a constant-returning writer would satisfy the
    // biconditional vacuously.
    assert.ok(observed.some(row => row.landed), 'no case exercised a real transition');
    assert.ok(observed.some(row => !row.landed), 'no case exercised a no-op');
  });
});

// AP-EXT-ITER242-01: validateCourseCorrectionProposal gates a course-correction
// proposal, and it slices its three inputs out of the proposal
// markdown with SECTION_HEADING_PATTERN (correct-course.ts). Two of that pattern's
// set-membership discriminators -- the start-of-line anchor and the {2,3} hash-count
// upper bound -- decide which lines close a section, and both were wholly unfixtured:
// amputating either left all 128 cases across the eight reachers GREEN. Over-matching
// fails OPEN in the truncating direction (an extra boundary can only SHORTEN a section,
// never extend it), so an Impact Map whose ticket ids sit below a sub-heading loses them
// and a VALID proposal is rejected for "must enumerate at least one ticket". Each arm gets its own case so a red names the discriminator.
describe('validateCourseCorrectionProposal section boundaries (AP-EXT-ITER242-01)', () => {
  const DISCOVERY = 'the ticket plan assumed a single writer';

  function buildProposal(impactMapBody) {
    return [
      '## Discovery Summary',
      '',
      DISCOVERY,
      '',
      '## Impact Map',
      '',
      ...impactMapBody,
      '',
      '## Restart Point',
      '',
      'ticket_id: keep123',
      '',
    ].join('\n');
  }

  function validate(sessionDir, impactMapBody) {
    return validateCourseCorrectionProposal({
      proposalContent: buildProposal(impactMapBody),
      discoveryStatement: DISCOVERY,
      sessionRoot: sessionDir,
      killedTicketIds: [],
    });
  }

  // Positive control: with no sub-heading shapes in the body, every arm of the pattern is
  // irrelevant and the proposal passes. Without this a mutant that rejected EVERYTHING
  // would satisfy the two negative cases vacuously.
  test('a proposal whose Impact Map carries no sub-heading shapes passes', () => {
    withDir((sessionDir) => {
      writeTicket(sessionDir, 'keep123');
      const result = validate(sessionDir, ['- ticket_id: keep123']);
      assert.deepEqual(result.failures, []);
      assert.equal(result.passed, true);
      assert.deepEqual(result.referencedTicketIds, ['keep123']);
    });
  });

  // Hash-count arm: `#### ` is four markers, so it is BODY, not a section boundary.
  // Widen {2,3} to {2,} and it becomes one -- Impact Map ends above the ticket id.
  test('a #### sub-heading inside the Impact Map does not close the section', () => {
    withDir((sessionDir) => {
      writeTicket(sessionDir, 'keep123');
      const result = validate(sessionDir, [
        '#### Kept tickets',
        '',
        '- ticket_id: keep123',
      ]);
      assert.deepEqual(result.referencedTicketIds, ['keep123']);
      assert.equal(result.passed, true);
    });
  });

  // Anchor arm: an INDENTED `## ` is a line that merely contains a heading marker.
  // Drop the `^` and it becomes a boundary -- same truncation, different spelling.
  test('an indented ## line inside the Impact Map does not close the section', () => {
    withDir((sessionDir) => {
      writeTicket(sessionDir, 'keep123');
      const result = validate(sessionDir, [
        '  ## quoting the old plan heading',
        '',
        '- ticket_id: keep123',
      ]);
      assert.deepEqual(result.referencedTicketIds, ['keep123']);
      assert.equal(result.passed, true);
    });
  });
});

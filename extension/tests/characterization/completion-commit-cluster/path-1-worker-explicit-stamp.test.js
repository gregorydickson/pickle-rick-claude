// @tier: integration
// Characterization test for Path 1: worker-explicit-stamp
// updateTicketFrontmatter(ticketId, sessionDir, {status:'Done', completion_commit:sha})
// called from spawn-morty.js:956 when runWorkerGate succeeds.
//
// Decision-matrix: path_id 1 — assert what the code DOES today.
// No live git against host repo. No git repo needed for this path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { updateTicketFrontmatter } from '../../../services/git-utils.js';
import { readFrontmatterField } from '../../../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MATRIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'decision-matrix.json'), 'utf8'));
const ENTRY = MATRIX.paths.find(p => p.path_id === 1);

function makeTmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'char-path1-')));
}

// Extract ticket ID from the fixture skeleton (key = "<hash>/rick_ticket_<hash>.md")
function ticketIdFromEntry(entry) {
  const key = Object.keys(entry.fixture.session_dir_skeleton).find(k => /^[a-f0-9]+\/linear_ticket/.test(k));
  return key ? key.split('/')[0] : null;
}

function writeTicket(sessionDir, ticketId, frontmatter) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const lines = ['---'];
  for (const [k, v] of Object.entries(frontmatter)) {
    lines.push(`${k}: "${v}"`);
  }
  // No body text — frontmatter-only ticket so setFrontmatterField can INSERT
  // new fields via the /\n---(\r?\n?)$/ pattern.
  lines.push('order: 1', '---');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), lines.join('\n') + '\n');
  return path.join(ticketDir, `rick_ticket_${ticketId}.md`);
}

test('path-1 worker-explicit-stamp: updateTicketFrontmatter writes status:Done + completion_commit atomically', () => {
  const root = makeTmp();
  try {
    const ticketId = ticketIdFromEntry(ENTRY);
    const fm = ENTRY.fixture.session_dir_skeleton[`${ticketId}/rick_ticket_${ticketId}.md`].frontmatter;
    const ticketPath = writeTicket(root, ticketId, fm);

    // Characterize: path-1 writes status:Done + completion_commit in one call
    updateTicketFrontmatter(ticketId, root, { status: 'Done', completion_commit: 'abc1234' });

    const content = fs.readFileSync(ticketPath, 'utf8');
    const status = readFrontmatterField(content, 'status');
    const commit = readFrontmatterField(content, 'completion_commit');

    assert.equal(status, 'Done', `path-1 expected status=Done, got '${status}'`);
    assert.equal(commit, 'abc1234', `path-1 expected completion_commit=abc1234, got '${commit}'`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('path-1 worker-explicit-stamp: updateTicketFrontmatter writes null completion_commit on failure (Failed path)', () => {
  const root = makeTmp();
  try {
    const ticketId = ticketIdFromEntry(ENTRY);
    const fm = ENTRY.fixture.session_dir_skeleton[`${ticketId}/rick_ticket_${ticketId}.md`].frontmatter;
    writeTicket(root, ticketId, fm);

    // Characterize: failed path writes status:Failed + null completion_commit
    updateTicketFrontmatter(ticketId, root, { status: 'Failed', completion_commit: null });

    const ticketPath = path.join(root, ticketId, `rick_ticket_${ticketId}.md`);
    const content = fs.readFileSync(ticketPath, 'utf8');
    const status = readFrontmatterField(content, 'status');
    const commit = readFrontmatterField(content, 'completion_commit');

    assert.equal(status, 'Failed', `path-1 failure expected status=Failed, got '${status}'`);
    assert.equal(commit, null, `path-1 failure expected completion_commit=null, got '${commit}'`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('path-1 worker-explicit-stamp: decision-matrix evidence_source matches explicit', () => {
  assert.equal(ENTRY.evidence_source, 'explicit',
    `expected evidence_source=explicit for path 1, got '${ENTRY.evidence_source}'`);
});

test('path-1 worker-explicit-stamp: expected end-state matches current behaviour', () => {
  const root = makeTmp();
  try {
    const ticketId = ticketIdFromEntry(ENTRY);
    const fm = ENTRY.fixture.session_dir_skeleton[`${ticketId}/rick_ticket_${ticketId}.md`].frontmatter;
    writeTicket(root, ticketId, fm);
    updateTicketFrontmatter(ticketId, root, { status: 'Done', completion_commit: 'abc1234' });

    const ticketPath = path.join(root, ticketId, `rick_ticket_${ticketId}.md`);
    const content = fs.readFileSync(ticketPath, 'utf8');
    // Matrix says watcher_decision='keep' when completion_commit is present
    const commit = readFrontmatterField(content, 'completion_commit');
    assert.ok(commit !== null && commit.length > 0,
      'path-1 expected completion_commit present (watcher will keep Done)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

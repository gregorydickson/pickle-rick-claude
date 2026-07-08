// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { updateTicketFrontmatter } from '../services/git-utils.js';

function makeTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-ticket-frontmatter-'));
}

test('updateTicketFrontmatter: Failed status clears inferred completion evidence', () => {
  const root = makeTmpRoot();
  try {
    const sessionDir = path.join(root, 'session');
    const ticketId = 'e5f6a7b8';
    const ticketDir = path.join(sessionDir, ticketId);
    fs.mkdirSync(ticketDir, { recursive: true });
    const ticketPath = path.join(ticketDir, `rick_ticket_${ticketId}.md`);
    fs.writeFileSync(ticketPath, `---
id: ${ticketId}
title: Test ticket
status: "In Progress"
completion_commit: "abc1234"
completion_commit_inferred: "def5678"
---

## Acceptance Criteria
- [x] failure is durable
`);

    updateTicketFrontmatter(ticketId, sessionDir, {
      status: 'Failed',
      completion_commit: null,
    });

    const updated = fs.readFileSync(ticketPath, 'utf8');
    assert.match(updated, /status: "Failed"/);
    assert.doesNotMatch(updated, /^completion_commit:/m);
    assert.doesNotMatch(updated, /^completion_commit_inferred:/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('updateTicketFrontmatter: Done persists completion_commit when the field is ABSENT', () => {
  // Regression for AP-HS6-1: the add-path fallback in setFrontmatterField anchors on
  // the closing `---` at end-of-string. Running it against the full document (the bug)
  // left the closing `---` mid-string, so an absent completion_commit was silently
  // dropped — stamping Done with no completion evidence (done_without_commit_evidence).
  const root = makeTmpRoot();
  try {
    const sessionDir = path.join(root, 'session');
    const ticketId = 'a1b2c3d4';
    const ticketDir = path.join(sessionDir, ticketId);
    fs.mkdirSync(ticketDir, { recursive: true });
    const ticketPath = path.join(ticketDir, `rick_ticket_${ticketId}.md`);
    // Frontmatter intentionally has NO completion_commit line (the normal at-creation shape),
    // followed by a real body so the closing `---` is mid-document.
    fs.writeFileSync(ticketPath, `---
id: ${ticketId}
title: "Persist the SHA"
status: "In Progress"
updated: "2026-06-02"
---

## Acceptance Criteria
- [x] completion evidence is durable
`);

    updateTicketFrontmatter(ticketId, sessionDir, {
      status: 'Done',
      completion_commit: 'deadbeefcafe1234',
    });

    const updated = fs.readFileSync(ticketPath, 'utf8');
    assert.match(updated, /status: "Done"/);
    // The SHA must be persisted INSIDE the frontmatter block, not dropped.
    assert.match(updated, /^completion_commit: "deadbeefcafe1234"$/m);
    const fmBlock = updated.slice(0, updated.indexOf('\n---', 4));
    assert.ok(fmBlock.includes('completion_commit: "deadbeefcafe1234"'),
      'completion_commit must live in the frontmatter block, not the body');
    // Body must survive intact.
    assert.match(updated, /completion evidence is durable/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

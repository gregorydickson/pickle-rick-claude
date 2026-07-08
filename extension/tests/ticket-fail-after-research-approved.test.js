// @tier: fast
/**
 * R-WSE-3: Stderr breadcrumb when ticket status is Failed AND
 * research_review.md ends in APPROVED.
 * AC-WSE-03: breadcrumb format matches pinned regex.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { checkFailedAfterResearchApproved } from '../bin/mux-runner.js';

const BREADCRUMB_RE = /^\[warn\] \[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] ⚠ ticket \S+ failed AFTER research APPROVED — see .+\/$/m;

function makeSession() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pickle-wse3-'));
  const sessionDir = path.join(tmp, 'session');
  mkdirSync(sessionDir, { recursive: true });
  return { tmp, sessionDir };
}

function makeTicket(sessionDir, ticketId, status, reviewContent) {
  const ticketDir = path.join(sessionDir, ticketId);
  mkdirSync(ticketDir, { recursive: true });
  writeFileSync(
    path.join(ticketDir, `rick_ticket_${ticketId}.md`),
    `---\nid: ${ticketId}\ntitle: Test ticket\nstatus: ${status}\norder: 1\n---\n\n# Test\n`,
  );
  if (reviewContent !== null) {
    writeFileSync(path.join(ticketDir, 'research_review.md'), reviewContent);
  }
}

function captureStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try { fn(); } finally { process.stderr.write = orig; }
  return chunks.join('');
}

test('ticket-fail-after-research-approved: Failed + APPROVED emits breadcrumb matching pinned format', () => {
  const { tmp, sessionDir } = makeSession();
  try {
    makeTicket(sessionDir, 'abc123', 'Failed', '# Review\n\nAPPROVED');
    const output = captureStderr(() => checkFailedAfterResearchApproved(sessionDir, 'abc123'));
    assert.ok(output.length > 0, 'Expected breadcrumb to be written to stderr');
    assert.match(output, BREADCRUMB_RE, `Breadcrumb format mismatch. Got: ${output}`);
    assert.ok(output.includes('abc123'), 'Breadcrumb must include ticket id');
    assert.ok(output.includes(sessionDir), 'Breadcrumb must include session dir');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ticket-fail-after-research-approved: Failed + NOT APPROVED emits no breadcrumb', () => {
  const { tmp, sessionDir } = makeSession();
  try {
    makeTicket(sessionDir, 'abc123', 'Failed', '# Review\n\nNEEDS REVISION');
    const output = captureStderr(() => checkFailedAfterResearchApproved(sessionDir, 'abc123'));
    assert.equal(output, '', 'Expected no breadcrumb when research_review.md does not end in APPROVED');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ticket-fail-after-research-approved: Non-Failed status + APPROVED emits no breadcrumb', () => {
  const { tmp, sessionDir } = makeSession();
  try {
    makeTicket(sessionDir, 'abc123', 'Todo', '# Review\n\nAPPROVED');
    const output = captureStderr(() => checkFailedAfterResearchApproved(sessionDir, 'abc123'));
    assert.equal(output, '', 'Expected no breadcrumb when ticket status is not Failed');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ticket-fail-after-research-approved: Missing research_review.md emits no breadcrumb', () => {
  const { tmp, sessionDir } = makeSession();
  try {
    makeTicket(sessionDir, 'abc123', 'Failed', null);
    const output = captureStderr(() => checkFailedAfterResearchApproved(sessionDir, 'abc123'));
    assert.equal(output, '', 'Expected no breadcrumb when research_review.md is absent');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ticket-fail-after-research-approved: Missing ticket dir silently returns', () => {
  const { tmp, sessionDir } = makeSession();
  try {
    const output = captureStderr(() => checkFailedAfterResearchApproved(sessionDir, 'nonexistent'));
    assert.equal(output, '', 'Expected silent no-op when ticket dir does not exist');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

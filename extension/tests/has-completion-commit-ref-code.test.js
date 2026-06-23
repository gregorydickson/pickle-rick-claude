// @tier: fast
//
// R-CCRC-1 regression: `readEvidence` must scan for the ticket's
// `r_code:` frontmatter value using word-boundary matching in addition to
// the existing ticket-id + title-extracted scan.
//
// 4 live incidents in B-APWS + B-WSRC-GR: workers committed using the R-code
// convention (e.g. `test(R-APWS-7):`) and the gate stamped empty
// `completion_commit:` even though the commit was present in git.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readEvidence } from '../services/ticket-completion-evidence.js';

function mkTmp(prefix = 'pickle-ccrc-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'initial', '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
}

function makeCommit(dir, msg) {
  const file = path.join(dir, `${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(file, 'work\n');
  execFileSync('git', ['add', path.basename(file)], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', msg, '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function writeTicket(sessionDir, ticketId, { rCode = null, title = 'fixture ticket' } = {}) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const lines = ['---', `id: ${ticketId}`, `title: "${title}"`, 'status: "Done"'];
  if (rCode) lines.push(`r_code: ${rCode}`);
  lines.push('---', '# Body');
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`), lines.join('\n'));
}

// Group 1: Direct ticket-id match — backstop for existing behavior -----------

test('R-CCRC-1: ticket-id in commit message returns inferred (existing behavior)', () => {
  const root = mkTmp();
  try {
    initGitRepo(root);
    const sha = makeCommit(root, 'feat(abc12345): implement the feature');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'abc12345', { title: 'some feature without R-code in title' });
    const ev = readEvidence({ sessionDir, ticketId: 'abc12345', workingDir: root });
    assert.equal(ev.kind, 'committed');
    assert.equal(ev.sha, sha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Group 2: R-code only match ------------------------------------------------

test('R-CCRC-1: r_code conventional commit match (title lacks R-code)', () => {
  const root = mkTmp();
  try {
    initGitRepo(root);
    // Commit uses R-code as scope; ticket-id NOT in message
    const sha = makeCommit(root, 'test(R-APWS-7): add regression test for has-completion-commit');
    const sessionDir = path.join(root, 'session');
    // Title intentionally does not contain the R-code
    writeTicket(sessionDir, 'deadbeef', { rCode: 'R-APWS-7', title: 'Add APWS regression suite' });
    const ev = readEvidence({ sessionDir, ticketId: 'deadbeef', workingDir: root });
    assert.equal(ev.sha, sha);
    assert.equal(ev.kind, 'committed',
      'r_code frontmatter must extend scan to catch R-code-scoped commits');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Group 3: Recovery-shape match ---------------------------------------------

test('R-CCRC-1: recovery-shape commit body contains R-code', () => {
  const root = mkTmp();
  try {
    initGitRepo(root);
    const sha = makeCommit(root, 'fix(abc00001): recover R-APWS-9 work from dropped commit');
    const sessionDir = path.join(root, 'session');
    // Title does NOT contain R-APWS-9; ticket-id not in commit message
    writeTicket(sessionDir, 'cafe0001', { rCode: 'R-APWS-9', title: 'APWS recovery ticket' });
    const ev = readEvidence({ sessionDir, ticketId: 'cafe0001', workingDir: root });
    assert.equal(ev.sha, sha);
    assert.equal(ev.kind, 'committed',
      'R-code in recovery commit body must be found via r_code frontmatter field');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Group 4: Word-boundary — R-APWS-1 must NOT match R-APWS-10 ----------------

test('R-CCRC-1: word-boundary — r_code R-APWS-1 does not match R-APWS-10 commit', () => {
  const root = mkTmp();
  try {
    initGitRepo(root);
    // Only R-APWS-10 is mentioned; R-APWS-1 is a different ticket
    makeCommit(root, 'feat(R-APWS-10): implement APWS-10 feature');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'feed0001', { rCode: 'R-APWS-1', title: 'APWS-1 fix' });
    const ev = readEvidence({ sessionDir, ticketId: 'feed0001', workingDir: root });
    assert.equal(ev.kind, 'absent',
      'R-APWS-1 must NOT false-match a commit that only mentions R-APWS-10');
    assert.equal(ev.sha, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Group 5: No match ---------------------------------------------------------

test('R-CCRC-1: no matching commit returns absent', () => {
  const root = mkTmp();
  try {
    initGitRepo(root);
    makeCommit(root, 'feat(R-ZZZZ-99): completely unrelated commit');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'babe0001', { rCode: 'R-APWS-7', title: 'APWS ticket' });
    const ev = readEvidence({ sessionDir, ticketId: 'babe0001', workingDir: root });
    assert.equal(ev.kind, 'absent');
    assert.equal(ev.sha, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Group 6: AC-CCRC-07 replay — 4 live incidents ----------------------------
// Synthesize commits with the same message SHAPES that caused the gate misses.
// Real SHAs live in a different history; we use the ticket-IDs from the
// incident table and commit messages that do NOT contain the ticket-id,
// forcing the fix to prove the R-code path does the work.

test('R-CCRC-07 replay: 1511a4bc / R-APWS-7 commit shape', () => {
  const root = mkTmp();
  try {
    initGitRepo(root);
    const sha = makeCommit(root, 'test(R-APWS-7): add has-completion-commit-quoted-form regression test');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, '1511a4bc', { rCode: 'R-APWS-7', title: 'R-CCQF regression tests' });
    const ev = readEvidence({ sessionDir, ticketId: '1511a4bc', workingDir: root });
    assert.equal(ev.sha, sha);
    assert.equal(ev.kind, 'committed', 'incident 1511a4bc / R-APWS-7');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R-CCRC-07 replay: 27aedb81 / R-APWS-8 commit shape', () => {
  const root = mkTmp();
  try {
    initGitRepo(root);
    const sha = makeCommit(root, 'feat(R-APWS-8): autoFillCompletionCommit SOFT-variant auto-promote');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, '27aedb81', { rCode: 'R-APWS-8', title: 'WUWC SOFT-variant auto-promote' });
    const ev = readEvidence({ sessionDir, ticketId: '27aedb81', workingDir: root });
    assert.equal(ev.sha, sha);
    assert.equal(ev.kind, 'committed', 'incident 27aedb81 / R-APWS-8');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R-CCRC-07 replay: 0fee5b66 / R-APWS-9 recovery shape', () => {
  const root = mkTmp();
  try {
    initGitRepo(root);
    // Recovery commit: other SHA as scope, R-APWS-9 in body — ticket-id not present
    const sha = makeCommit(root, 'fix(abc00010): recover R-APWS-9 work from dropped commit');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, '0fee5b66', { rCode: 'R-APWS-9', title: 'PEDC clear-on-recovery exit_reason' });
    const ev = readEvidence({ sessionDir, ticketId: '0fee5b66', workingDir: root });
    assert.equal(ev.sha, sha);
    assert.equal(ev.kind, 'committed', 'incident 0fee5b66 / R-APWS-9');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R-CCRC-07 replay: eee90f16 / R-WSRC-GR-1 commit shape', () => {
  const root = mkTmp();
  try {
    initGitRepo(root);
    // Commit uses R-code as scope; ticket-id not in message
    const sha = makeCommit(root, 'feat(R-WSRC-GR-1): block prohibited git verbs from worker subprocesses');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'eee90f16', { rCode: 'R-WSRC-GR-1', title: 'Git boundary rules hook coverage' });
    const ev = readEvidence({ sessionDir, ticketId: 'eee90f16', workingDir: root });
    assert.equal(ev.sha, sha);
    assert.equal(ev.kind, 'committed', 'incident eee90f16 / R-WSRC-GR-1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

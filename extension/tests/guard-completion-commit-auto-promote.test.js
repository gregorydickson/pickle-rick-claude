// @tier: fast
//
// R-WUWC SOFT-variant regression: when the worker `git commit`-ed referencing
// the ticket id but did NOT add `completion_commit:` to the ticket frontmatter,
// `guardCompletionCommitBeforeDone` MUST auto-promote the inferred SHA into the
// frontmatter (via `autoFillCompletionCommit`) and pass the guard. The legacy
// behavior (refuse the Done flip and halt with `done_without_commit_evidence`)
// is the bug class documented in
// `prds/p1-bug-fix-bundle-b-wuwc-reproducer-2026-05-23.md` (live incident
// 2026-05-23 session `2026-05-23-17b2f716` ticket `be5a047d`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { guardCompletionCommitBeforeDone } from '../bin/mux-runner.js';
import { readFrontmatterField } from '../services/pickle-utils.js';

function mkTmp(prefix = 'pickle-guard-auto-promote-') {
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

function writeTicketFrontmatter(sessionDir, ticketId, status, extra = []) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const lines = [
    '---',
    `id: ${ticketId}`,
    'title: Worker that commits without stamping completion_commit',
    `status: "${status}"`,
    'order: 1',
    ...extra,
    '---',
    '# Body',
  ];
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), lines.join('\n'));
}

test('guardCompletionCommitBeforeDone: SOFT-variant inferred SHA is auto-promoted to explicit', (t) => {
  // PICKLE_TEST_MODE bypasses the guard entirely; the live runtime never sets
  // it. Strip it for this test so the real guard logic runs.
  const prev = process.env.PICKLE_TEST_MODE;
  delete process.env.PICKLE_TEST_MODE;
  t.after(() => { if (prev !== undefined) process.env.PICKLE_TEST_MODE = prev; });

  const root = mkTmp();
  try {
    initGitRepo(root);
    // Worker writes a file, commits it with the ticket-id in the message,
    // edits frontmatter to status: Done — but does NOT add completion_commit:.
    const ticketId = 'be5a547d';
    fs.writeFileSync(path.join(root, 'worker.txt'), 'work\n');
    execFileSync('git', ['add', 'worker.txt'], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', `${ticketId} add regression test`, '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    const sessionDir = path.join(root, 'session');
    writeTicketFrontmatter(sessionDir, ticketId, 'Done');
    const ticketFile = path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`);
    // Sanity-check the precondition: no completion_commit field yet.
    assert.equal(readFrontmatterField(fs.readFileSync(ticketFile, 'utf8'), 'completion_commit'), null);

    const result = guardCompletionCommitBeforeDone({
      sessionDir,
      ticketId,
      workingDir: root,
      flags: null,
      rereadBackoffMs: 0,
    });

    // Guard must pass (auto-promotion succeeded).
    assert.equal(result.ok, true, `guard rejected: ${result.ok === false ? result.reason : ''}`);
    assert.equal(result.sha, sha);

    // Frontmatter must now carry an explicit completion_commit:.
    const persisted = readFrontmatterField(fs.readFileSync(ticketFile, 'utf8'), 'completion_commit');
    assert.equal(persisted, sha, 'guard MUST persist the inferred SHA into the ticket frontmatter');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('guardCompletionCommitBeforeDone: still fails closed when no git evidence exists', (t) => {
  const prev = process.env.PICKLE_TEST_MODE;
  delete process.env.PICKLE_TEST_MODE;
  t.after(() => { if (prev !== undefined) process.env.PICKLE_TEST_MODE = prev; });

  const root = mkTmp();
  try {
    initGitRepo(root);
    // No worker commit at all — ticket frontmatter says Done but git is clean.
    const ticketId = 'absent99';
    const sessionDir = path.join(root, 'session');
    writeTicketFrontmatter(sessionDir, ticketId, 'Done');

    const result = guardCompletionCommitBeforeDone({
      sessionDir,
      ticketId,
      workingDir: root,
      flags: null,
      rereadBackoffMs: 0,
    });

    assert.equal(result.ok, false);
    assert.equal(result.source, 'absent');
    assert.match(result.reason, /cannot flip Done/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

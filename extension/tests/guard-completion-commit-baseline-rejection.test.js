// @tier: integration
// anatomy-park R-CXOR-2 wiring: the baseline-SHA rejection (commit 1cbe4078) lives
// in readEvidence but was wired into NO production caller — so a worker that stamps
// completion_commit === start_commit was accepted as 'explicit' by the Done-flip
// guard (the codex orphan-reset false-Done class). This drives the PRODUCTION
// guardCompletionCommitBeforeDone (not readEvidence directly) against a REAL repo
// where HEAD === baseline === stamped completion_commit, proving the end-to-end gap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { guardCompletionCommitBeforeDone } from '../bin/mux-runner.js';

function makeTmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cxor2-guard-')));
}

function git(repoDir, args) {
  return execFileSync('git', ['-C', repoDir, ...args], { timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function initRepo(repoDir) {
  git(repoDir, ['init']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
}

function commitFile(repoDir, name, body, msg) {
  fs.writeFileSync(path.join(repoDir, name), body);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', msg]);
  return git(repoDir, ['rev-parse', 'HEAD']);
}

function writeTicket(sessionDir, ticketId, sha) {
  const dir = path.join(sessionDir, ticketId);
  fs.mkdirSync(dir, { recursive: true });
  const content = ['---', `id: ${ticketId}`, 'status: In Progress', `completion_commit: ${sha}`, '---', ''].join('\n');
  fs.writeFileSync(path.join(dir, `rick_ticket_${ticketId}.md`), content);
}

function writeState(sessionDir, startCommit) {
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ schema_version: 5, start_commit: startCommit, pinned_sha: null }));
}

// The guard early-returns ok:true when PICKLE_TEST_MODE === '1' (sandbox bypass).
// These tests must exercise the REAL evidence path, so the var must be unset.
function withoutTestMode(fn) {
  const prev = process.env.PICKLE_TEST_MODE;
  delete process.env.PICKLE_TEST_MODE;
  try { return fn(); } finally { if (prev !== undefined) process.env.PICKLE_TEST_MODE = prev; }
}

test('guard rejects completion_commit === start_commit (R-CXOR-2 now active in the Done-flip path)', () => {
  withoutTestMode(() => {
    const root = makeTmp();
    const sessionDir = path.join(root, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    initRepo(root);
    const baseline = commitFile(root, 'init.txt', 'init', 'baseline');

    // Worker did no new work but stamped the baseline SHA as its completion_commit.
    writeTicket(sessionDir, 'abc12345', baseline);
    writeState(sessionDir, baseline);

    const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId: 'abc12345', workingDir: root, rereadBackoffMs: 0 });
    assert.equal(guard.ok, false, 'a baseline-equal completion_commit must NOT flip the ticket Done');
    assert.match(guard.reason, /absent/, "evidence collapses to 'absent' once the baseline guard fires");
  });
});

test('guard accepts a distinct real commit (no false rejection)', () => {
  withoutTestMode(() => {
    const root = makeTmp();
    const sessionDir = path.join(root, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    initRepo(root);
    const baseline = commitFile(root, 'init.txt', 'init', 'baseline');
    const real = commitFile(root, 'work.txt', 'real work', 'feat: real ticket work');

    writeTicket(sessionDir, 'abc12345', real);
    writeState(sessionDir, baseline);

    const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId: 'abc12345', workingDir: root, rereadBackoffMs: 0 });
    assert.equal(guard.ok, true, 'a distinct non-baseline commit is still accepted as explicit evidence');
    assert.equal(guard.sha, real);
  });
});

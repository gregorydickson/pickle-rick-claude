// @tier: integration
//
// B-GITATTR WS-2 consumer regression: `readEvidence` must attribute completion
// evidence via the `Pickle-Ticket` git trailer (stamped by the WS-1 producer
// hook) as the highest-precedence scan pass, ahead of the existing ref-token
// message-inference pass, while a trailer naming a DIFFERENT ticket must never
// be laundered into an attribution via a coincidental message/file-touch match.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readEvidence } from '../../services/ticket-completion-evidence.js';

function mkTmp(prefix = 'pickle-gitattr-') {
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

function makeCommitWithTrailer(dir, msg, trailerValue) {
  const file = path.join(dir, `${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(file, 'work\n');
  execFileSync('git', ['add', path.basename(file)], { cwd: dir });
  execFileSync(
    'git',
    ['commit', '-q', '-m', msg, '--trailer', `Pickle-Ticket: ${trailerValue}`, '--no-gpg-sign'],
    { cwd: dir, stdio: 'ignore' },
  );
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function writeTicket(sessionDir, ticketId, { title = 'fixture ticket', completionCommit = null } = {}) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const lines = ['---', `id: ${ticketId}`, `title: "${title}"`, 'status: "Done"'];
  if (completionCommit) lines.push(`completion_commit: ${completionCommit}`);
  lines.push('---', '# Body');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), lines.join('\n'));
}

test('AC-GA-6/7: commit with no ticket-id/r_code in subject attributes via its Pickle-Ticket trailer', () => {
  const root = mkTmp();
  try {
    initGitRepo(root);
    const sha = makeCommitWithTrailer(root, 'audit: [HIGH] tighten completion evidence', 'trlr0001');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'trlr0001');
    const ev = readEvidence({ sessionDir, ticketId: 'trlr0001', workingDir: root });
    assert.equal(ev.kind, 'committed');
    assert.equal(ev.sha, sha);
    assert.equal(ev.via, 'scan');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC-GA-6/7: a trailer naming a different ticket is refused as foreign attribution (no laundering via message match)', () => {
  const root = mkTmp();
  try {
    initGitRepo(root);
    // Subject WORD-BOUNDARY matches our own ticket-id — Pass 1 (ref-token) would
    // attribute this commit to us if the trailer exclusion were not wired in.
    // The trailer positively names a DIFFERENT ticket.
    makeCommitWithTrailer(root, 'fix(trlr0002): patch adjacent to trlr0002 scope', 'other9999');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'trlr0002');
    const ev = readEvidence({ sessionDir, ticketId: 'trlr0002', workingDir: root });
    assert.equal(ev.kind, 'absent', 'a foreign trailer must suppress the ref-token match on the same commit');
    assert.equal(ev.sha, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC-GA-6/7: explicit reachable completion_commit still wins over a conflicting trailer', () => {
  const root = mkTmp();
  try {
    initGitRepo(root);
    const explicitSha = makeCommit(root, 'feat(trlr0003): real delivering commit');
    makeCommitWithTrailer(root, 'chore: unrelated later commit', 'other-ticket-id');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'trlr0003', { completionCommit: explicitSha });
    const ev = readEvidence({ sessionDir, ticketId: 'trlr0003', workingDir: root });
    assert.equal(ev.kind, 'committed');
    assert.equal(ev.sha, explicitSha);
    assert.equal(ev.via, 'explicit');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC-GA-6/7: a baseline sha carrying a matching trailer is still rejected', () => {
  const root = mkTmp();
  try {
    initGitRepo(root);
    const baselineSha = makeCommitWithTrailer(root, 'chore: session baseline', 'trlr0004');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'trlr0004');
    const ev = readEvidence({
      sessionDir,
      ticketId: 'trlr0004',
      workingDir: root,
      startCommit: baselineSha,
    });
    // guardScanHit downgrades a scan-arm baseline hit to `no_evidence` (not
    // `baseline_sha` — that reason is reserved for the explicit-field path per
    // the WS-2 arm-agreement docstring on guardScanHit). The acceptance bar is
    // "not attributed", i.e. kind === 'absent'.
    assert.equal(ev.kind, 'absent');
    assert.equal(ev.sha, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC-GA-6/7: git failure (non-repo workingDir) returns absent, never throws', () => {
  const root = mkTmp();
  try {
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'trlr0005');
    const ev = readEvidence({ sessionDir, ticketId: 'trlr0005', workingDir: root });
    assert.equal(ev.kind, 'absent');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC-GA-6/7: precedence order — trailer pass runs and wins ahead of the ref-token pass', () => {
  const root = mkTmp();
  try {
    initGitRepo(root);
    // OLD: subject WORD-BOUNDARY matches the ticket id, no trailer. If the
    // trailer pass did not run (or ran after Pass 1), Pass 1 would find and
    // return THIS commit, since it iterates newest-first and this is the only
    // ref-token match in the log.
    const oldSha = makeCommit(root, 'fix(trlr0006): initial attempt at trlr0006');
    // NEW: subject/body contains NO ticket-id token at all (Pass 1 cannot find
    // it on its own), but its trailer names this ticket.
    const newSha = makeCommitWithTrailer(root, 'chore: follow-up cleanup', 'trlr0006');
    assert.notEqual(oldSha, newSha);
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'trlr0006');
    const ev = readEvidence({ sessionDir, ticketId: 'trlr0006', workingDir: root });
    assert.equal(ev.kind, 'committed');
    assert.equal(ev.sha, newSha, 'the trailer-matching commit must win — proves the trailer pass ran ahead of Pass 1, which alone would have returned the OLD ref-token match');
    assert.equal(ev.via, 'scan');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

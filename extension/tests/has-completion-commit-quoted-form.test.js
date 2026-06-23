// @tier: fast
//
// R-CCQF regression: `readEvidence` must accept ALL three documented
// frontmatter serializations of `completion_commit:` as `kind: 'committed'`:
//   1. Unquoted short SHA  (auto-promote helper writes this shape)
//   2. Unquoted full SHA   (codex tool calls write this shape)
//   3. Quoted (single OR double) short OR full SHA
//      (codex/human direct edits typically write the quoted shape)
//
// Live incident: 2026-05-23 session `2026-05-23-48e6309a` closer ticket
// `26301c6a` wrote shape #3 and the gate stamped `done_without_commit_evidence`
// even though the commit `724f69d4...` existed in git. See PRD
// `prds/p2-completion-commit-quoted-form-and-exit-reason-2026-05-24.md`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeCompletionCommitField } from '../services/pickle-utils.js';
import { readEvidence } from '../services/ticket-completion-evidence.js';

function mkTmp(prefix = 'pickle-ccqf-') {
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

function makeRealCommit(dir, suffix) {
  fs.writeFileSync(path.join(dir, `worker_${suffix}.txt`), 'work\n');
  execFileSync('git', ['add', `worker_${suffix}.txt`], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', `bundle: real commit ${suffix}`, '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function writeTicket(sessionDir, ticketId, completionLine) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`), [
    '---',
    `id: ${ticketId}`,
    'title: R-CCQF fixture',
    'status: "Done"',
    completionLine,
    '---',
    '# Body',
  ].join('\n'));
}

// AC-CCQF-01..04: parser shape coverage --------------------------------------

test('R-CCQF: normalizeCompletionCommitField accepts unquoted short SHA', () => {
  assert.equal(normalizeCompletionCommitField('4b38893c'), '4b38893c');
  assert.equal(normalizeCompletionCommitField('  4b38893c  '), '4b38893c');
});

test('R-CCQF: normalizeCompletionCommitField accepts unquoted full SHA (40 chars)', () => {
  const sha = '724f69d4db8aae9b5f8e4ab7f3abfa0a72c5f6c8';
  assert.equal(normalizeCompletionCommitField(sha), sha);
});

test('R-CCQF: normalizeCompletionCommitField accepts double-quoted full SHA', () => {
  const sha = '724f69d4db8aae9b5f8e4ab7f3abfa0a72c5f6c8';
  assert.equal(normalizeCompletionCommitField(`"${sha}"`), sha);
});

test('R-CCQF: normalizeCompletionCommitField accepts single-quoted short SHA', () => {
  assert.equal(normalizeCompletionCommitField("'4b38893c'"), '4b38893c');
});

test('R-CCQF: normalizeCompletionCommitField rejects truncated (<7 chars) SHA', () => {
  assert.equal(normalizeCompletionCommitField('4b3889'), null);
  assert.equal(normalizeCompletionCommitField('"4b3"'), null);
});

test('R-CCQF: normalizeCompletionCommitField rejects non-hex chars', () => {
  assert.equal(normalizeCompletionCommitField('4b38893g'), null); // 'g' is non-hex
  assert.equal(normalizeCompletionCommitField('"not-a-sha-at-all"'), null);
});

test('R-CCQF: normalizeCompletionCommitField returns null for null/undefined/empty', () => {
  assert.equal(normalizeCompletionCommitField(null), null);
  assert.equal(normalizeCompletionCommitField(undefined), null);
  assert.equal(normalizeCompletionCommitField(''), null);
  assert.equal(normalizeCompletionCommitField('""'), null);
});

// AC-CCQF-04: integration — real git repo + ticket file with each shape ------

test('R-CCQF: readEvidence classifies quoted full SHA as committed', () => {
  const root = mkTmp();
  try {
    initGitRepo(root);
    const sha = makeRealCommit(root, 'quoted-full');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'qf001', `completion_commit: "${sha}"`);
    const ev = readEvidence({ sessionDir, ticketId: 'qf001', workingDir: root });
    assert.equal(ev.kind, 'committed', 'quoted full SHA must classify as committed (R-CCQF live incident class)');
    assert.equal(ev.sha, sha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R-CCQF: readEvidence classifies unquoted full SHA as committed', () => {
  const root = mkTmp();
  try {
    initGitRepo(root);
    const sha = makeRealCommit(root, 'unquoted-full');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'uf001', `completion_commit: ${sha}`);
    const ev = readEvidence({ sessionDir, ticketId: 'uf001', workingDir: root });
    assert.equal(ev.kind, 'committed');
    assert.equal(ev.sha, sha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R-CCQF: readEvidence classifies single-quoted short SHA as committed', () => {
  const root = mkTmp();
  try {
    initGitRepo(root);
    const fullSha = makeRealCommit(root, 'single-short');
    const shortSha = fullSha.slice(0, 8);
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'sq001', `completion_commit: '${shortSha}'`);
    const ev = readEvidence({ sessionDir, ticketId: 'sq001', workingDir: root });
    assert.equal(ev.kind, 'committed');
    assert.equal(ev.sha, shortSha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R-CCQF: corrupt SHA (truncated) classifies as absent, not inferred', () => {
  const root = mkTmp();
  try {
    initGitRepo(root);
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'bad001', 'completion_commit: "abc"'); // 3 chars — too short
    const ev = readEvidence({ sessionDir, ticketId: 'bad001', workingDir: root });
    // Parse failure -> falls through frontmatter check; no R-code/ticket-id in
    // any commit message either, so terminal classification is `absent`.
    assert.equal(ev.kind, 'absent', 'corrupt SHA must classify as absent');
    assert.equal(ev.sha, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R-CCQF: live-incident fixture (session 2026-05-23-48e6309a/26301c6a shape)', () => {
  // Replay the exact frontmatter shape from the live incident.
  const root = mkTmp();
  try {
    initGitRepo(root);
    const sha = makeRealCommit(root, '724f69d4');
    const sessionDir = path.join(root, 'session');
    const ticketDir = path.join(sessionDir, '26301c6a');
    fs.mkdirSync(ticketDir, { recursive: true });
    // Real-world shape: title is quoted, status is quoted, completion_commit
    // is quoted with the FULL 40-char SHA. This is what closer workers emit
    // via codex's edit primitive.
    fs.writeFileSync(path.join(ticketDir, 'linear_ticket_26301c6a.md'), [
      '---',
      'id: 26301c6a',
      'title: "R-WUWC-3-CLOSER — MASTER_PLAN bookkeeping"',
      'status: Done',
      'priority: High',
      `completion_commit: "${sha}"`,
      '---',
      '# Description',
    ].join('\n'));
    const ev = readEvidence({ sessionDir, ticketId: '26301c6a', workingDir: root });
    assert.equal(ev.kind, 'committed',
      'live incident shape must classify as committed — gate must not refuse a fully-shipped commit');
    assert.equal(ev.sha, sha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

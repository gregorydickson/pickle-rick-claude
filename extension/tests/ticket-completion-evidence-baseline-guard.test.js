// @tier: integration
// R-CXOR-2: False-Done guard — completion_commit equal to baseline SHAs must be rejected.
// AC-CXOR-2-1: baseline-equal is rejected; distinct real commit is accepted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readEvidence } from '../services/ticket-completion-evidence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeTmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cxor2-')));
}

function writeTicket(sessionDir, ticketId, sha) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const content = [
    '---',
    `id: ${ticketId}`,
    `status: Done`,
    `completion_commit: ${sha}`,
    '---',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`), content);
}

function initGitRepoWithCommit(repoDir) {
  execFileSync('git', ['-C', repoDir, 'init'], { timeout: 8000, stdio: 'ignore' });
  execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com'], { timeout: 8000, stdio: 'ignore' });
  execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test'], { timeout: 8000, stdio: 'ignore' });
  fs.writeFileSync(path.join(repoDir, 'init.txt'), 'init');
  execFileSync('git', ['-C', repoDir, 'add', '.'], { timeout: 8000, stdio: 'ignore' });
  execFileSync('git', ['-C', repoDir, 'commit', '-m', 'R-CXOR-2 test commit'], { timeout: 8000, stdio: 'ignore' });
  return execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], {
    timeout: 8000,
    encoding: 'utf8',
  }).trim();
}

const BASELINE_SHA = 'aabbccddeeff0011223344556677889900112233';
const PINNED_SHA   = '1122334455667788990011223344556677889900';
const TICKET_ID    = 'testticket';

test('R-CXOR-2: completion_commit equal to startCommit is rejected as evidence', () => {
  const root = makeTmp();
  const sessionDir = path.join(root, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  writeTicket(sessionDir, TICKET_ID, BASELINE_SHA);

  const result = readEvidence({
    sessionDir,
    ticketId: TICKET_ID,
    workingDir: root,
    startCommit: BASELINE_SHA,
  });

  assert.equal(result.kind, 'absent',
    'completion_commit equal to startCommit must be rejected (kind: absent)');
});

test('R-CXOR-2: completion_commit equal to pinnedSha is rejected as evidence', () => {
  const root = makeTmp();
  const sessionDir = path.join(root, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  writeTicket(sessionDir, TICKET_ID, PINNED_SHA);

  const result = readEvidence({
    sessionDir,
    ticketId: TICKET_ID,
    workingDir: root,
    pinnedSha: PINNED_SHA,
  });

  assert.equal(result.kind, 'absent',
    'completion_commit equal to pinnedSha must be rejected (kind: absent)');
});

test('R-CXOR-2: a distinct non-baseline commit is accepted as committed evidence', () => {
  const root = makeTmp();
  const sessionDir = path.join(root, 'session');
  const repoDir = path.join(root, 'repo');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(repoDir, { recursive: true });

  const realSha = initGitRepoWithCommit(repoDir);

  writeTicket(sessionDir, TICKET_ID, realSha);

  const result = readEvidence({
    sessionDir,
    ticketId: TICKET_ID,
    workingDir: repoDir,
    startCommit: BASELINE_SHA,
    pinnedSha: PINNED_SHA,
  });

  assert.equal(result.kind, 'committed',
    'distinct real commit must be accepted as committed evidence (B-DURA T70)');
  assert.equal(result.sha, realSha);
});

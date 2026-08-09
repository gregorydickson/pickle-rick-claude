// @tier: integration
// Characterization test for Path 2: worker-autofill-belt-and-suspenders
// autoFillCompletionCommit called at spawn-morty.js:966 after updateTicketFrontmatter.
// When completion_commit absent: fills from git-log + stages the ticket file.
// When completion_commit already present: no-op (action='already_present').
//
// Decision-matrix: path_id 2 — assert what the code DOES today.
// Uses a local tmp git repo. No live git against the host repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { autoFillCompletionCommit } from '../../../bin/auto-fill-completion-commit.js';
import { readFrontmatterField } from '../../../services/pickle-utils.js';
import { commitWorkerFixture } from '../../__helpers__/worker-commit-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MATRIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'decision-matrix.json'), 'utf8'));
const ENTRY = MATRIX.paths.find(p => p.path_id === 2);

function makeTmp(prefix = 'char-path2-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir) {
  const opts = { cwd: dir, stdio: 'ignore' };
  execFileSync('git', ['init', '-q'], opts);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], opts);
  execFileSync('git', ['commit', '-q', '-m', 'initial', '--no-gpg-sign'], opts);
}

function writeTicket(sessionDir, ticketId, extraFrontmatter = {}) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const fm = { id: ticketId, status: 'Done', title: 'Test ticket', order: 1, ...extraFrontmatter };
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    lines.push(`${k}: "${v}"`);
  }
  lines.push('---', '# Body');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), lines.join('\n'));
  return path.join(ticketDir, `rick_ticket_${ticketId}.md`);
}

test('path-2 autofill: absent completion_commit — fills from git-log, action=filled', () => {
  const root = makeTmp();
  try {
    initGitRepo(root);
    const sessionDir = path.join(root, 'session');
    const ticketId = ENTRY.fixture.session_dir_skeleton['state.json'].current_ticket;
    const ticketPath = writeTicket(sessionDir, ticketId);
    const statePath = path.join(sessionDir, 'state.json');
    const epoch = Math.floor(Date.now() / 1000) - 60;
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ start_time_epoch: epoch, activity: [] }, null, 2));

    // Create a commit referencing the ticket id (post-start_time_epoch)
    // a4e48c26 deleted subject-line inference — production attributes via a git trailer
    // that names the ticket, so this fixture stamps one instead of relying on the subject alone.
    fs.writeFileSync(path.join(root, 'change.txt'), 'worker output\n');
    execFileSync('git', ['add', 'change.txt'], { cwd: root, stdio: 'ignore' });
    const sha = commitWorkerFixture({ cwd: root, ticketId, message: `fix(${ticketId}): implement ticket` });

    const result = autoFillCompletionCommit({ sessionDir, workingDir: root, ticketId, statePath });

    // Characterize current behaviour: action=filled, sha matches commit
    assert.equal(result.length, 1, `expected 1 result, got ${result.length}`);
    assert.equal(result[0].action, 'filled', `expected action=filled, got '${result[0].action}'`);
    assert.equal(result[0].sha, sha, `expected sha=${sha}, got '${result[0].sha}'`);

    const content = fs.readFileSync(ticketPath, 'utf8');
    const commit = readFrontmatterField(content, 'completion_commit');
    assert.ok(commit !== null, 'completion_commit should be written to frontmatter');

    // Staged check
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' });
    assert.match(staged, new RegExp(`rick_ticket_${ticketId}\\.md`),
      'ticket file should be staged after fill');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('path-2 autofill: already_present completion_commit — no-op, action=already_present', () => {
  const root = makeTmp();
  try {
    initGitRepo(root);
    const sessionDir = path.join(root, 'session');
    const ticketId = ENTRY.fixture.session_dir_skeleton['state.json'].current_ticket;
    const ticketPath = writeTicket(sessionDir, ticketId, { completion_commit: 'abc1234' });
    const statePath = path.join(sessionDir, 'state.json');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ start_time_epoch: Math.floor(Date.now() / 1000), activity: [] }, null, 2));

    const result = autoFillCompletionCommit({ sessionDir, workingDir: root, ticketId, statePath });

    // Characterize current behaviour: action=already_present, sha unchanged
    assert.equal(result.length, 1, `expected 1 result, got ${result.length}`);
    assert.equal(result[0].action, 'already_present',
      `expected action=already_present, got '${result[0].action}'`);
    assert.equal(result[0].sha, 'abc1234', `expected sha=abc1234, got '${result[0].sha}'`);

    const content = fs.readFileSync(ticketPath, 'utf8');
    const commit = readFrontmatterField(content, 'completion_commit');
    assert.equal(commit, 'abc1234', 'completion_commit must remain unchanged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('path-2 autofill: decision-matrix evidence_source matches inferred', () => {
  assert.equal(ENTRY.evidence_source, 'inferred',
    `expected evidence_source=inferred for path 2, got '${ENTRY.evidence_source}'`);
});

test('path-2 autofill: no git evidence → action=no_evidence', () => {
  const root = makeTmp();
  try {
    initGitRepo(root);
    const sessionDir = path.join(root, 'session');
    const ticketId = ENTRY.fixture.session_dir_skeleton['state.json'].current_ticket;
    writeTicket(sessionDir, ticketId);
    const statePath = path.join(sessionDir, 'state.json');
    fs.mkdirSync(sessionDir, { recursive: true });
    // start_time_epoch in the future → no commits will match the scan window
    const futureEpoch = Math.floor(Date.now() / 1000) + 999_999;
    fs.writeFileSync(statePath, JSON.stringify({ start_time_epoch: futureEpoch, activity: [] }, null, 2));

    const result = autoFillCompletionCommit({ sessionDir, workingDir: root, ticketId, statePath });

    assert.equal(result.length, 1, `expected 1 result, got ${result.length}`);
    assert.equal(result[0].action, 'no_evidence',
      `expected action=no_evidence, got '${result[0].action}'`);
    assert.equal(result[0].sha, null, `expected sha=null, got '${result[0].sha}'`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

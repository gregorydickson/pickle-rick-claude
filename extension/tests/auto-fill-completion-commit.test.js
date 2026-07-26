// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { autoFillCompletionCommit } from '../bin/auto-fill-completion-commit.js';

function makeTmpRoot(prefix = 'pickle-auto-fill-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial fixture', '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
}

function writeTicket(sessionDir, ticketId, status = 'Done') {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const ticketPath = path.join(ticketDir, `rick_ticket_${ticketId}.md`);
  fs.writeFileSync(ticketPath, [
    '---',
    `id: ${ticketId}`,
    'title: R-CCC-5 Auto-fill test',
    `status: "${status}"`,
    'order: 1',
    '---',
    '# R-CCC-5 Auto-fill test',
  ].join('\n'));
  return ticketPath;
}

function readActivityEvents(statePath) {
  const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  return Array.isArray(raw.activity) ? raw.activity : [];
}

test('autoFillCompletionCommit: fills missing completion_commit, stages the ticket file, and is idempotent', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    const sessionDir = path.join(root, 'session');
    const ticketId = '167fcaf9';
    const ticketPath = writeTicket(sessionDir, ticketId);
    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      start_time_epoch: Math.floor(Date.now() / 1000) - 60,
      activity: [],
    }, null, 2));

    fs.writeFileSync(path.join(root, 'worker-output.txt'), 'worker changes\n');
    execFileSync('git', ['add', 'worker-output.txt'], { cwd: root });
    execFileSync(
      'git',
      ['commit', '-m', 'close completion gap', '--trailer', `Pickle-Ticket: ${ticketId}`, '--no-gpg-sign'],
      { cwd: root, stdio: 'ignore' },
    );
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    const first = autoFillCompletionCommit({
      sessionDir,
      workingDir: root,
      ticketId,
      statePath,
    });
    assert.deepEqual(first, [{ ticketId, sha, action: 'filled' }]);
    const updated = fs.readFileSync(ticketPath, 'utf8');
    assert.match(updated, new RegExp(`completion_commit:\\s+"${sha}"`));

    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' });
    assert.match(staged, new RegExp(`rick_ticket_${ticketId}\\.md`));

    const second = autoFillCompletionCommit({
      sessionDir,
      workingDir: root,
      ticketId,
      statePath,
    });
    assert.deepEqual(second, [{ ticketId, sha, action: 'already_present' }]);

    const events = readActivityEvents(statePath).filter((entry) => entry.event === 'completion_commit_auto_filled');
    assert.equal(events.length, 1);
    assert.equal(events[0].ticket_id, ticketId);
    assert.equal(events[0].sha, sha);
    assert.equal(events[0].helper, 'auto_fill');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('autoFillCompletionCommit: promotes recoverable state tmp before inferring completion evidence', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    const sessionDir = path.join(root, 'session');
    const ticketId = '4b5f3f21';
    const ticketPath = writeTicket(sessionDir, ticketId);
    const statePath = path.join(sessionDir, 'state.json');
    const oldEpoch = 1_700_000_000;
    const commitEpoch = oldEpoch + 60;
    const recoveredEpoch = oldEpoch + 120;

    fs.writeFileSync(statePath, JSON.stringify({
      start_time_epoch: oldEpoch,
      activity: [],
    }, null, 2));

    fs.writeFileSync(path.join(root, 'worker-output.txt'), 'worker changes\n');
    execFileSync('git', ['add', 'worker-output.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', `fix(${ticketId}): stale session evidence`, '--no-gpg-sign'], {
      cwd: root,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: `${commitEpoch} +0000`,
        GIT_COMMITTER_DATE: `${commitEpoch} +0000`,
      },
    });

    fs.writeFileSync(
      `${statePath}.tmp.999999999.1`,
      JSON.stringify({
        start_time_epoch: recoveredEpoch,
        activity: [],
      }, null, 2),
    );

    const result = autoFillCompletionCommit({
      sessionDir,
      workingDir: root,
      ticketId,
      statePath,
    });

    assert.deepEqual(result, [{ ticketId, sha: null, action: 'no_evidence' }]);
    const updated = fs.readFileSync(ticketPath, 'utf8');
    assert.doesNotMatch(updated, /completion_commit:/);
    const recoveredState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(recoveredState.start_time_epoch, recoveredEpoch);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('autoFillCompletionCommit: recovers tmp-only state before filtering completion evidence', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    const sessionDir = path.join(root, 'session');
    const ticketId = '8ac24b3e';
    const ticketPath = writeTicket(sessionDir, ticketId);
    const statePath = path.join(sessionDir, 'state.json');
    const recoveredEpoch = 1_700_000_120;
    const commitEpoch = recoveredEpoch - 60;

    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      `${statePath}.tmp.999999999.1`,
      JSON.stringify({
        start_time_epoch: recoveredEpoch,
        activity: [],
      }, null, 2),
    );

    fs.writeFileSync(path.join(root, 'worker-output.txt'), 'worker changes\n');
    execFileSync('git', ['add', 'worker-output.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', `fix(${ticketId}): stale session evidence`, '--no-gpg-sign'], {
      cwd: root,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: `${commitEpoch} +0000`,
        GIT_COMMITTER_DATE: `${commitEpoch} +0000`,
      },
    });

    const result = autoFillCompletionCommit({
      sessionDir,
      workingDir: root,
      ticketId,
      statePath,
    });

    assert.deepEqual(result, [{ ticketId, sha: null, action: 'no_evidence' }]);
    const updated = fs.readFileSync(ticketPath, 'utf8');
    assert.doesNotMatch(updated, /completion_commit:/);
    const recoveredState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(recoveredState.start_time_epoch, recoveredEpoch);
    assert.equal(fs.existsSync(`${statePath}.tmp.999999999.1`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

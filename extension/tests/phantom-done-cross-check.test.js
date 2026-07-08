// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { inspectPhantomDoneTicketFile } from '../bin/mux-runner.js';

function makeTmpRoot(prefix = 'pickle-phantom-done-cross-check-') {
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

test('inspectPhantomDoneTicketFile: promotes git-inferred SHA to EXPLICIT completion_commit instead of reverting Done', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    fs.writeFileSync(path.join(root, 'worker.txt'), 'work\n');
    execFileSync('git', ['add', 'worker.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'bundle/C: R-CCC-5 watcher inference', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    const sessionDir = path.join(root, 'session');
    const ticketId = 'phantom01';
    const ticketDir = path.join(sessionDir, ticketId);
    fs.mkdirSync(ticketDir, { recursive: true });
    const ticketPath = path.join(ticketDir, `rick_ticket_${ticketId}.md`);
    fs.writeFileSync(ticketPath, [
      '---',
      `id: ${ticketId}`,
      'status: "Done"',
      'order: 1',
      '---',
      '# R-CCC-5 watcher inference',
    ].join('\n'));

    const result = inspectPhantomDoneTicketFile(ticketPath, sessionDir, root, 'Todo');
    assert.equal(result.changed, true);
    assert.equal(result.reason, 'backfilled');
    assert.equal(result.commit, sha);

    // D1 (84c209ae) promote-once: the git-verified SHA is written as EXPLICIT
    // completion_commit (NOT completion_commit_inferred) and the inferred field is
    // deleted, so the next phantom-Done re-scan classifies `explicit` → keep and the
    // backfill count stays stable instead of re-firing every pass.
    const updated = fs.readFileSync(ticketPath, 'utf8');
    assert.match(updated, new RegExp(`completion_commit:\\s+"${sha}"`));
    assert.doesNotMatch(updated, /completion_commit_inferred:/);
    assert.match(updated, /status: "Done"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

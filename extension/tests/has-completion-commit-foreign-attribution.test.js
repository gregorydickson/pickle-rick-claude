// @tier: fast
// R-OMA (WS-4, B-PXBO): readEvidence rejects an explicit completion_commit ONLY
// when it is POSITIVELY attributed to a DIFFERENT ticket id (LOA-1588: a no-op /
// clean-audit ticket borrowing another ticket's e2e commit hash). Default = accept:
// explicit-SHA-wins (R-RIC-EXPLICIT) must still pass for generic / own-ticket messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// R-PTSB: sandbox the data root even though readEvidence does not write session state.
process.env.PICKLE_DATA_ROOT = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-oma-dataroot-')),
);

import { readEvidence } from '../services/ticket-completion-evidence.js';

function makeTmpRoot(prefix = 'pickle-oma-') {
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

function commitWith(dir, file, message) {
  fs.writeFileSync(path.join(dir, file), `work for ${file}\n`);
  execFileSync('git', ['add', file], { cwd: dir });
  execFileSync('git', ['commit', '-m', message, '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function writeTicket(sessionDir, ticketId, lines) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`), lines.join('\n'));
}

// AC-OMA-2: a no-op/clean-audit ticket borrowing a DIFFERENT ticket's e2e commit
// hash (commit message names the sibling) is rejected → kind:'absent' (no-change).
test('R-OMA: explicit SHA positively attributed to a DIFFERENT ticket is rejected', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    // Commit authored for sibling ticket e2efeat1 (subject names it).
    const foreignSha = commitWith(root, 'e2e.txt', 'feat(e2efeat1): add e2e coverage');

    const sessionDir = path.join(root, 'session');
    // Sibling ticket exists in the session.
    writeTicket(sessionDir, 'e2efeat1', ['---', 'id: e2efeat1', 'status: "Done"', '---', '# e2e feature']);
    // No-op audit ticket borrows the sibling's hash.
    writeTicket(sessionDir, 'noop0001', [
      '---',
      'id: noop0001',
      'title: clean audit no-op',
      'status: "Done"',
      `completion_commit: "${foreignSha}"`,
      '---',
      '# clean audit no-op',
    ]);

    const evidence = readEvidence({ sessionDir, ticketId: 'noop0001', workingDir: root });
    assert.equal(evidence.kind, 'absent');
    assert.equal(evidence.sha, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// AC-OMA-3 / R-RIC-EXPLICIT: an explicit SHA with a GENERIC message must STILL
// resolve committed (absence of a matching message is NOT grounds for rejection).
test('R-RIC-EXPLICIT: explicit SHA with a generic commit message still resolves committed', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    const sha = commitWith(root, 'work.txt', 'chore: tidy up files');

    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'sibling1', ['---', 'id: sibling1', 'status: "Done"', '---', '# sibling']);
    writeTicket(sessionDir, 'generic1', [
      '---',
      'id: generic1',
      'status: "Done"',
      `completion_commit: "${sha}"`,
      '---',
      '# generic message ticket',
    ]);

    const evidence = readEvidence({ sessionDir, ticketId: 'generic1', workingDir: root });
    assert.equal(evidence.kind, 'committed');
    assert.equal(evidence.sha, sha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// AC-OMA-3: a legit fix(<ownTicketId>): commit still resolves committed — own
// attribution wins even when sibling tickets exist in the session.
test('R-OMA: explicit SHA naming its OWN ticket id resolves committed', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    const sha = commitWith(root, 'own.txt', 'fix(ownfix01): real own-ticket work');

    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'otherone', ['---', 'id: otherone', 'status: "Done"', '---', '# other']);
    writeTicket(sessionDir, 'ownfix01', [
      '---',
      'id: ownfix01',
      'status: "Done"',
      `completion_commit: "${sha}"`,
      '---',
      '# own work',
    ]);

    const evidence = readEvidence({ sessionDir, ticketId: 'ownfix01', workingDir: root });
    assert.equal(evidence.kind, 'committed');
    assert.equal(evidence.sha, sha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A commit naming BOTH this ticket and a sibling is own-attribution → accept
// (own attribution wins over foreign match).
test('R-OMA: a commit naming this ticket AND a sibling resolves committed (own wins)', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    const sha = commitWith(root, 'both.txt', 'fix(mine0001): work, supersedes sibling0002');

    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'sibling0002', ['---', 'id: sibling0002', 'status: "Done"', '---', '# sib']);
    writeTicket(sessionDir, 'mine0001', [
      '---',
      'id: mine0001',
      'status: "Done"',
      `completion_commit: "${sha}"`,
      '---',
      '# mine',
    ]);

    const evidence = readEvidence({ sessionDir, ticketId: 'mine0001', workingDir: root });
    assert.equal(evidence.kind, 'committed');
    assert.equal(evidence.sha, sha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// No sessionDir context → no sibling enumeration possible → default accept (the
// foreign check is a narrow exception, never match-required).
test('R-OMA: without sessionDir context the explicit SHA is accepted (default = accept)', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    const sha = commitWith(root, 'x.txt', 'feat(somethingelse): unrelated');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'tk000001', [
      '---', 'id: tk000001', 'status: "Done"', `completion_commit: "${sha}"`, '---', '# tk',
    ]);
    // ticketPath supplied directly, NO sessionDir → no sibling scan.
    const evidence = readEvidence({
      ticketPath: path.join(sessionDir, 'tk000001', 'linear_ticket_tk000001.md'),
      workingDir: root,
    });
    assert.equal(evidence.kind, 'committed');
    assert.equal(evidence.sha, sha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

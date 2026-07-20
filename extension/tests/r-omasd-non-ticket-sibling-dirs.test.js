// @tier: fast
// R-OMASD: `enumerateSiblingTicketIds` must enumerate ONLY real ticket dirs.
// A session root also holds non-ticket dirs (`gate`, `archive`, `refinement`,
// `microverse_*`, plus anatomy-park subsystem dirs like `bin` / `extension`).
// Those basenames are ordinary English words that word-boundary-match routine
// commit subjects, so admitting them into the R-OMA foreign-attribution set
// makes a ticket's OWN correctly-stamped commit read as `foreign_attribution` →
// hard-absent → Done-flip refused / phantom-watcher revert of shipped work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// R-PTSB: sandbox the data root even though readEvidence does not write session state.
process.env.PICKLE_DATA_ROOT = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-omasd-dataroot-')),
);

import { readEvidence } from '../services/ticket-completion-evidence.js';

function makeTmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-omasd-')));
}

function initGitRepo(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial fixture', '--no-gpg-sign'], {
    cwd: dir,
    stdio: 'ignore',
  });
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
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), lines.join('\n'));
}

// The non-ticket dirs a real session root actually contains. Verified against
// session 2026-07-19-afe23e5b, whose root held exactly these alongside 11 ticket dirs.
const NON_TICKET_DIRS = ['gate', 'archive', 'refinement', 'bin', 'extension', 'microverse_szechuan-sauce'];

function makeSessionRoot(root) {
  const sessionDir = path.join(root, 'session');
  for (const d of NON_TICKET_DIRS) fs.mkdirSync(path.join(sessionDir, d), { recursive: true });
  return sessionDir;
}

// The load-bearing case: a ticket's OWN commit, correctly stamped and reachable,
// whose subject happens to contain a non-ticket sibling dir name. Pre-fix this
// returned {kind:'absent', absentReason:'foreign_attribution'}.
for (const { dir, subject } of [
  { dir: 'gate', subject: 'fix(R-XYZ): tighten the readiness gate' },
  { dir: 'extension', subject: 'refactor: split the extension loader' },
  { dir: 'bin', subject: 'chore: move the script under bin' },
  { dir: 'archive', subject: 'fix: move the stale baseline into archive' },
]) {
  test(`R-OMASD: own commit naming non-ticket sibling dir "${dir}" stays committed`, () => {
    const root = makeTmpRoot();
    try {
      initGitRepo(root);
      const ownSha = commitWith(root, `${dir}-work.txt`, subject);

      const sessionDir = makeSessionRoot(root);
      // Subject names NEITHER this ticket's id NOR its r_code — the exact shape
      // the own-attribution escape hatch cannot rescue.
      writeTicket(sessionDir, 'c46045a6', [
        '---',
        'id: c46045a6',
        'title: some unrelated work',
        'status: "Done"',
        `completion_commit: "${ownSha}"`,
        '---',
        '# work',
      ]);

      const evidence = readEvidence({ sessionDir, ticketId: 'c46045a6', workingDir: root });
      assert.equal(
        evidence.kind,
        'committed',
        `commit subject "${subject}" must not read as foreign attribution`,
      );
      assert.equal(evidence.sha, ownSha);
      assert.equal(evidence.absentReason, undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

// Guard the narrowing: a genuine foreign attribution (subject names a REAL
// sibling ticket dir) must still be rejected. Narrowing the enumeration must not
// blind the R-OMA scan.
test('R-OMASD: genuine foreign attribution to a real sibling ticket is still rejected', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    const foreignSha = commitWith(root, 'e2e.txt', 'feat(e2efeat1): add e2e coverage');

    const sessionDir = makeSessionRoot(root);
    // A REAL sibling ticket dir (holds a rick_ticket_*.md).
    writeTicket(sessionDir, 'e2efeat1', ['---', 'id: e2efeat1', 'status: "Done"', '---', '# e2e']);
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
    assert.equal(evidence.absentReason, 'foreign_attribution');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A directory that merely LOOKS like a ticket hash but holds no ticket artifact
// is not a ticket — it cannot source a foreign-attribution rejection.
test('R-OMASD: hash-shaped dir with no rick_ticket artifact is not a sibling ticket', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    const ownSha = commitWith(root, 'work.txt', 'fix: touch up deadbeef handling');

    const sessionDir = makeSessionRoot(root);
    // Hash-shaped, but empty — an artifact-less leftover, not a ticket.
    fs.mkdirSync(path.join(sessionDir, 'deadbeef'), { recursive: true });
    writeTicket(sessionDir, 'c46045a6', [
      '---',
      'id: c46045a6',
      'status: "Done"',
      `completion_commit: "${ownSha}"`,
      '---',
      '# work',
    ]);

    const evidence = readEvidence({ sessionDir, ticketId: 'c46045a6', workingDir: root });
    assert.equal(evidence.kind, 'committed');
    assert.equal(evidence.sha, ownSha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

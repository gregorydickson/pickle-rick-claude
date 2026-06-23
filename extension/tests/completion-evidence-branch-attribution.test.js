// @tier: fast
//
// R-CECB: declared-file-touch branch attribution in readEvidence.
//
// A green worker commit with a human/LOA subject (no completion_commit frontmatter,
// no ticket-id / r_code in the subject) that touches one of the ticket's declared
// in-scope files must attribute to the ticket. A commit outside the declared scope,
// carrying a different ticket's ref token, a red commit, or an ambiguous commit
// (touching two tickets' declared files) must NOT attribute.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readEvidence } from '../services/ticket-completion-evidence.js';

function mkTmp(prefix = 'pickle-cecb-') {
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

/** Commit a specific set of repo-relative file paths with a given subject. */
function commitFiles(dir, relPaths, msg) {
  for (const rel of relPaths) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `work ${Date.now()} ${Math.random()}\n`);
    execFileSync('git', ['add', rel], { cwd: dir });
  }
  execFileSync('git', ['commit', '-q', '-m', msg, '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function writeTicket(sessionDir, ticketId, { declaredPaths = [], rCode = null, title = 'fixture' } = {}) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const lines = ['---', `id: ${ticketId}`, `title: "${title}"`, 'status: "Done"'];
  if (rCode) lines.push(`r_code: ${rCode}`);
  lines.push('---', '# Body', '## Files to modify');
  for (const p of declaredPaths) lines.push(`- \`${p}\``);
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`), lines.join('\n'));
}

const PASS = () => 'passing';
const FAIL = () => 'failing';

test('file-touch primary: green LOA-subject commit touching declared files → attributed', () => {
  const root = mkTmp();
  try {
    initGitRepo(root);
    const declared = 'extension/src/services/cecb-feature.ts';
    const sha = commitFiles(root, [declared], 'feat: 1.C — implement the feature (LOA-1369)');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'abc12345', { declaredPaths: [declared], title: 'CECB feature' });
    const ev = readEvidence({ sessionDir, ticketId: 'abc12345', workingDir: root, greenGate: PASS });
    assert.equal(ev.kind, 'committed', 'attributable via declared-file-touch (B-DURA T70: committed)');
    assert.equal(ev.sha, sha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC-PCOMP-2b(i): commit touching only files OUTSIDE declared scope → NOT attributed', () => {
  const root = mkTmp();
  try {
    initGitRepo(root);
    commitFiles(root, ['extension/src/services/unrelated.ts'], 'feat: 2.A — unrelated (LOA-2000)');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'abc12345', { declaredPaths: ['extension/src/services/cecb-feature.ts'] });
    const ev = readEvidence({ sessionDir, ticketId: 'abc12345', workingDir: root, greenGate: PASS });
    assert.equal(ev.kind, 'absent');
    assert.equal(ev.sha, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC-PCOMP-2b(ii): commit carrying a DIFFERENT ticket ref token (no declared-file touch) → NOT attributed', () => {
  const root = mkTmp();
  try {
    initGitRepo(root);
    // Commit references r_code R-OTHER-1 and touches a file the ticket does NOT declare.
    commitFiles(root, ['extension/src/services/other.ts'], 'feat(R-OTHER-1): other ticket work');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'abc12345', {
      declaredPaths: ['extension/src/services/cecb-feature.ts'],
      rCode: 'R-CECB-1',
    });
    const ev = readEvidence({ sessionDir, ticketId: 'abc12345', workingDir: root, greenGate: PASS });
    assert.equal(ev.kind, 'absent', 'a different ticket\'s ref token must not attribute to this ticket');
    assert.equal(ev.sha, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC-PCOMP-2b(iii): RED commit (greenGate failing) → NOT attributed', () => {
  const root = mkTmp();
  try {
    initGitRepo(root);
    const declared = 'extension/src/services/cecb-feature.ts';
    commitFiles(root, [declared], 'feat: 1.C — implement (LOA-1369)');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'abc12345', { declaredPaths: [declared] });
    const ev = readEvidence({ sessionDir, ticketId: 'abc12345', workingDir: root, greenGate: FAIL });
    assert.equal(ev.kind, 'absent', 'a red commit must not attribute');
    assert.equal(ev.sha, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ambiguous: commit touches TWO tickets\' declared files → attribute to NEITHER', () => {
  const root = mkTmp();
  try {
    initGitRepo(root);
    const shared = 'extension/src/services/shared.ts';
    commitFiles(root, [shared], 'feat: 1.C — shared change (LOA-1369)');
    const sessionDir = path.join(root, 'session');
    // Both tickets declare the same file → ambiguous.
    writeTicket(sessionDir, 'abc12345', { declaredPaths: [shared] });
    writeTicket(sessionDir, 'def67890', { declaredPaths: [shared] });
    const ev = readEvidence({ sessionDir, ticketId: 'abc12345', workingDir: root, greenGate: PASS });
    assert.equal(ev.kind, 'absent', 'a commit touching two tickets\' declared files attributes to neither');
    assert.equal(ev.sha, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('newest green wins among multiple declared-file-touching commits', () => {
  const root = mkTmp();
  try {
    initGitRepo(root);
    const declared = 'extension/src/services/cecb-feature.ts';
    commitFiles(root, [declared], 'feat: 1.C — first pass (LOA-1369)');
    const newest = commitFiles(root, [declared], 'feat: 1.C — second pass (LOA-1369)');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'abc12345', { declaredPaths: [declared] });
    const ev = readEvidence({ sessionDir, ticketId: 'abc12345', workingDir: root, greenGate: PASS });
    assert.equal(ev.sha, newest, 'the newest green declared-file-touching commit wins');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ref-token scan still wins when present (existing behavior preserved)', () => {
  const root = mkTmp();
  try {
    initGitRepo(root);
    const declared = 'extension/src/services/cecb-feature.ts';
    const sha = commitFiles(root, [declared], 'feat(abc12345): id in subject');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'abc12345', { declaredPaths: [declared] });
    // greenGate would reject, but the ref-token scan runs first and does not consult it.
    const ev = readEvidence({ sessionDir, ticketId: 'abc12345', workingDir: root, greenGate: FAIL });
    assert.equal(ev.kind, 'committed');
    assert.equal(ev.sha, sha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

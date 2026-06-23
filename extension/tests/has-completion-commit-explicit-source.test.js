// @tier: fast
//
// RED-STATE regression test — B-RIC-EXPLICIT bundle (finding #83).
//
// Incident: 2026-05-26 21:55Z, session `pickle-ea04b6f8`, ticket `110f51bd`.
// `linear_ticket_110f51bd.md` had an explicit `completion_commit:` frontmatter
// field. `hasCompletionCommit` still returned `source: 'inferred'` because
// `gitCommitExists(workingDir, sha)` returned false (the SHA wasn't verifiable
// in the supplied workingDir), causing the explicit branch at pickle-utils.ts:947
// to be skipped. `findMatchingCommit` then found the commit by `110f51bd` in
// the message and returned `source: 'inferred'` instead of `source: 'explicit'`.
// `guardCompletionCommitBeforeDone` raised a fatal, bricking the pipeline.
//
// All four assertions below MUST FAIL with the current code (red state).
// They pass after the R-RIC-EXPLICIT-2 fix decouples `gitCommitExists` from
// the explicit-frontmatter branch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeCompletionCommitField } from '../services/pickle-utils.js';
import { readEvidence } from '../services/ticket-completion-evidence.js';

// The exact SHA from the ea04b6f8 incident — present in the real repo,
// but NOT in fresh tmp git repos created by these tests.
const INCIDENT_SHA  = '6ef59f22dd25e94817b704225e80a92efe9cba31';
const INCIDENT_SHORT = '6ef59f22';
const TICKET_ID     = '110f51bd';

function mkTmp(prefix = 'pickle-bric-') {
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

// Commits a file whose message contains the ticket ID — so findMatchingCommit
// can find it and return `inferred`. The commit SHA will differ from INCIDENT_SHA.
function makeCommitWithTicketId(gitDir, ticketId) {
  fs.writeFileSync(path.join(gitDir, `${ticketId}.txt`), 'fixture work\n');
  execFileSync('git', ['add', `${ticketId}.txt`], { cwd: gitDir });
  execFileSync('git', ['commit', '-q', '-m', `fix(${ticketId}): fixture commit`, '--no-gpg-sign'],
    { cwd: gitDir, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gitDir, encoding: 'utf8' }).trim();
}

function writeTicket(sessionDir, ticketId, completionLine) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`), [
    '---',
    `id: ${ticketId}`,
    'title: "R-SMTEST-3 — R-RIC-EXPLICIT fixture"',
    'status: Done',
    completionLine,
    '---',
    '# Description',
    'Fixture ticket for B-RIC-EXPLICIT regression test.',
  ].join('\n'));
}

// ── RED-STATE tests (AC-BRIC-01) ─────────────────────────────────────────────
// All four assertions below FAIL until R-RIC-EXPLICIT-2 is applied.

// R-AFCC-DEEP-3C/4A: INCIDENT_SHA is NOT in the fresh test repo, so git cat-file -e
// returns non-zero → source: 'absent' (R-AFCC-DEEP-4A collapsed the legacy
// 'unreachable' source into 'absent'). The critical invariant is unchanged: presence
// of a completion_commit field does NOT fall through to findMatchingCommit (no
// 'inferred'), so guardCompletionCommitBeforeDone still refuses the Done flip.

test('R-RIC-EXPLICIT: quoted full SHA in frontmatter → source must not be inferred (unreachable when SHA absent from repo)', () => {
  const root = mkTmp('pickle-bric-qf-');
  try {
    initGitRepo(root);
    makeCommitWithTicketId(root, TICKET_ID);
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, TICKET_ID, `completion_commit: "${INCIDENT_SHA}"`);
    const ev = readEvidence({ sessionDir, ticketId: TICKET_ID, workingDir: root });
    assert.equal(ev.kind, 'absent', 'explicit frontmatter must not fall through to scan; unreachable SHA reads absent (B-DURA T70), guard still refuses Done');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R-RIC-EXPLICIT: unquoted full SHA in frontmatter → source must not be inferred (unreachable when SHA absent from repo)', () => {
  const root = mkTmp('pickle-bric-uf-');
  try {
    initGitRepo(root);
    makeCommitWithTicketId(root, TICKET_ID);
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, TICKET_ID, `completion_commit: ${INCIDENT_SHA}`);
    const ev = readEvidence({ sessionDir, ticketId: TICKET_ID, workingDir: root });
    assert.equal(ev.kind, 'absent', 'explicit frontmatter must not fall through to scan; unreachable SHA reads absent (B-DURA T70), guard still refuses Done');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R-RIC-EXPLICIT: unquoted short SHA in frontmatter → source must not be inferred (unreachable when SHA absent from repo)', () => {
  const root = mkTmp('pickle-bric-us-');
  try {
    initGitRepo(root);
    makeCommitWithTicketId(root, TICKET_ID);
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, TICKET_ID, `completion_commit: ${INCIDENT_SHORT}`);
    const ev = readEvidence({ sessionDir, ticketId: TICKET_ID, workingDir: root });
    assert.equal(ev.kind, 'absent', 'explicit frontmatter must not fall through to scan; unreachable SHA reads absent (B-DURA T70), guard still refuses Done');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R-RIC-EXPLICIT: quoted short SHA in frontmatter → source must not be inferred (unreachable when SHA absent from repo)', () => {
  const root = mkTmp('pickle-bric-qs-');
  try {
    initGitRepo(root);
    makeCommitWithTicketId(root, TICKET_ID);
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, TICKET_ID, `completion_commit: "${INCIDENT_SHORT}"`);
    const ev = readEvidence({ sessionDir, ticketId: TICKET_ID, workingDir: root });
    assert.equal(ev.kind, 'absent', 'explicit frontmatter must not fall through to scan; unreachable SHA reads absent (B-DURA T70), guard still refuses Done');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── normalizeCompletionCommitField — SHA form coverage (GREEN, guards R-CCQF) ─

test('R-RIC-EXPLICIT: normalizeCompletionCommitField — quoted full incident SHA → plain hex', () => {
  assert.equal(normalizeCompletionCommitField(`"${INCIDENT_SHA}"`), INCIDENT_SHA);
});

test('R-RIC-EXPLICIT: normalizeCompletionCommitField — unquoted full incident SHA → plain hex', () => {
  assert.equal(normalizeCompletionCommitField(INCIDENT_SHA), INCIDENT_SHA);
});

test('R-RIC-EXPLICIT: normalizeCompletionCommitField — quoted short incident SHA → plain hex', () => {
  assert.equal(normalizeCompletionCommitField(`"${INCIDENT_SHORT}"`), INCIDENT_SHORT);
});

test('R-RIC-EXPLICIT: normalizeCompletionCommitField — unquoted short incident SHA → plain hex', () => {
  assert.equal(normalizeCompletionCommitField(INCIDENT_SHORT), INCIDENT_SHORT);
});

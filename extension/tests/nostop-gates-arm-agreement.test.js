// @tier: fast
//
// B-NOSTOP-GATES WS-2 — arm-agreement invariant (AC-NSG-10b).
//
// Before this fix, the scan arm of `readEvidence` applied NONE of the guards the
// explicit arm applies to the identical SHA shape (isBaselineSha, R-CXOR-2;
// isForeignAttributedExplicitSha, R-OMA). `promoteOnceAndReprobe` persisted a
// scan-accepted SHA into the explicit `completion_commit` field, and the next
// read sent it down the explicit arm — where the SAME sha could be rejected. One
// arm's accept became the other arm's refusal, and the promote step is what
// MANUFACTURED the disagreement (a ticket that a moment ago had accepted evidence
// had none a moment later).
//
// This is the arm-agreement invariant: for any SHA `S` and ticket `T`, if the
// scan arm accepts `S` for `T`, then persisting `S` as `T`'s EXPLICIT
// `completion_commit` and re-reading must never yield `absent`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readEvidence, persistEvidence } from '../services/ticket-completion-evidence.js';

function mkTmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir, initialMessage = 'initial fixture') {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', initialMessage, '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function commitWith(dir, file, message) {
  fs.writeFileSync(path.join(dir, file), `work for ${file}\n`);
  execFileSync('git', ['add', file], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', message, '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

/** A commit carrying a `Pickle-Ticket: <ticketId>` trailer — the git-authoritative scan path. */
function commitWithTrailer(dir, file, message, ticketId) {
  fs.writeFileSync(path.join(dir, file), `work for ${file}\n`);
  execFileSync('git', ['add', file], { cwd: dir });
  execFileSync(
    'git',
    ['commit', '-q', '-m', message, '--trailer', `Pickle-Ticket: ${ticketId}`, '--no-gpg-sign'],
    { cwd: dir, stdio: 'ignore' },
  );
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function writeTicket(sessionDir, ticketId, lines) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), lines.join('\n'));
  return ticketDir;
}

// ---------------------------------------------------------------------------
// Shape 1 — own-commit: THIS ticket's own id is word-boundary-named. Must hold
// BEFORE and AFTER the fix — the common case (own attribution always wins).
// ---------------------------------------------------------------------------

test('AC-NSG-10b (own-commit): scan accept round-trips to explicit, never absent', () => {
  const root = mkTmp('pickle-arm-own-');
  try {
    initGitRepo(root);
    const sha = commitWithTrailer(root, 'own.txt', 'real own-ticket work', 'agown001');

    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'agsib002', ['---', 'id: agsib002', 'status: "Done"', '---', '# sibling']);
    writeTicket(sessionDir, 'agown001', ['---', 'id: agown001', 'status: "In Progress"', '---', '# own ticket']);

    const ctx = { sessionDir, ticketId: 'agown001', workingDir: root };
    const first = readEvidence(ctx);
    assert.equal(first.kind, 'committed', 'own-ticket commit must be scan-accepted');
    assert.equal(first.via, 'scan');
    assert.equal(first.sha, sha);

    const persisted = persistEvidence(ctx, first.sha, { stage: 'best-effort' });
    assert.equal(persisted.action, 'written');

    const second = readEvidence(ctx);
    assert.notEqual(second.kind, 'absent', 'the arm-agreement invariant: an accepted scan sha must never flip to absent on re-read');
    assert.equal(second.kind, 'committed');
    assert.equal(second.via, 'explicit');
    assert.equal(second.sha, sha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Shape 2 — foreign: a commit whose message word-boundary-names a SIBLING
// ticket id, but ALSO carries a bundle-generic token (this ticket's own TITLE
// mentions an R-code the commit also cites) so the pre-fix scan arm would
// accept it via that generic token. Reproduces the reported wedge shape
// (fc4f44f1/33f4960b, 0bde4711/ef394937): scan accepts a commit that names a
// DIFFERENT ticket, promote persists it, explicit-arm re-read rejects it.
// ---------------------------------------------------------------------------

test('AC-NSG-10b (foreign): scan never accepts a sibling-attributed sha — first read is already absent', () => {
  const root = mkTmp('pickle-arm-foreign-');
  try {
    initGitRepo(root);
    // Names the SIBLING ticket id AND cites the bundle-generic R-code this
    // ticket's own title also mentions — pre-fix, the scan arm's title-derived
    // R-code matcher accepts this commit for THIS ticket even though the
    // message positively attributes to a different ticket.
    const sha = commitWith(root, 'sib.txt', 'audit(fgsib002): sibling work, refs R-SHARED');

    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'fgsib002', ['---', 'id: fgsib002', 'status: "Done"', '---', '# sibling ticket']);
    writeTicket(sessionDir, 'fgown001', [
      '---', 'id: fgown001', 'title: "WS-2 fix for R-SHARED bundle"', 'status: "In Progress"', '---',
      '# own ticket',
    ]);

    const ctx = { sessionDir, ticketId: 'fgown001', workingDir: root };
    const first = readEvidence(ctx);
    assert.notEqual(first.kind, 'committed', 'a sibling-attributed commit must never be scan-accepted');
    assert.equal(first.kind, 'absent');
    assert.equal(first.absentReason, 'no_evidence',
      'a scan-arm rejection is a best-effort miss, not a positive foreign-attribution finding — that hard reason stays explicit-field-only');

    // Nothing was accepted, so there is nothing to persist — the round trip is
    // vacuously safe. Confirm explicitly: persisting the candidate sha directly
    // (bypassing the scan guard) still must not silently launder it via a
    // second scan-arm accept path.
    const persisted = persistEvidence(ctx, sha, { stage: 'best-effort' });
    assert.equal(persisted.action, 'written');
    const second = readEvidence(ctx);
    assert.equal(second.kind, 'absent', 'a foreign-attributed sha stays absent even once explicitly stamped (R-OMA hard-absent, unlaundered)');
    assert.equal(second.absentReason, 'foreign_attribution');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Shape 3 — baseline: THIS ticket's own ref token appears in the session's
// INITIAL (baseline) commit message. Pre-fix the scan arm would accept the
// baseline sha; post-fix it must never accept a baseline sha via scan either.
// ---------------------------------------------------------------------------

test('AC-NSG-10b (baseline): scan never accepts the session start_commit', () => {
  const root = mkTmp('pickle-arm-baseline-');
  try {
    const baselineSha = initGitRepo(root, 'fix(bstck001): accidentally names ticket in baseline commit');

    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'bstck001', ['---', 'id: bstck001', 'status: "In Progress"', '---', '# baseline-named ticket']);

    const ctx = { sessionDir, ticketId: 'bstck001', workingDir: root, startCommit: baselineSha };
    const first = readEvidence(ctx);
    assert.notEqual(first.kind, 'committed', 'a baseline sha must never be scan-accepted');
    assert.equal(first.kind, 'absent');
    assert.equal(first.absentReason, 'no_evidence');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Shape 4 — unreachable: an EXPLICIT completion_commit stamped with a sha that
// does not exist in the repo. Confirms the pre-existing R-AICF fall-through is
// undisturbed by this change: with no scan/inferred fallback available, it
// stays absent/unreachable_explicit_unattributable both before and after.
// ---------------------------------------------------------------------------

test('AC-NSG-10b (unreachable): explicit-unreachable fall-through is undisturbed', () => {
  const root = mkTmp('pickle-arm-unreachable-');
  try {
    initGitRepo(root);

    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'unrch001', [
      '---',
      'id: unrch001',
      'status: "In Progress"',
      'completion_commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"',
      '---',
      '# unreachable stamp',
    ]);

    const ctx = { sessionDir, ticketId: 'unrch001', workingDir: root };
    const evidence = readEvidence(ctx);
    assert.equal(evidence.kind, 'absent');
    assert.equal(evidence.absentReason, 'unreachable_explicit_unattributable');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

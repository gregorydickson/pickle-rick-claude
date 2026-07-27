// @tier: integration
/**
 * B-1SEAM WS1b (R-AICF root-cause prong): reconcileWorkerCommitAttribution
 * verifies the worker-claimed completion sha against git ground truth in the
 * preWorkerHead..HEAD window — a hallucinated/unreachable/out-of-window sha is
 * DISCARDED and replaced by the real in-window commit (normalized to the full
 * 40-char form), and an untagged single-commit tip gains a
 * `Pickle-Ticket: <ticketId>` trailer so every ref-token scanner can attribute
 * it. Live incident: session 2026-07-01-9e922602 ticket c46045a6 — a codex
 * worker committed real untagged work, stamped a HALLUCINATED full sha, and
 * the done-guard/watcher/guard trio accepted/reverted/fataled on the same
 * ticket. This kills the hallucinated-stamp class at the source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { reconcileWorkerCommitAttribution } from '../bin/spawn-morty.js';

const TICKET_ID = 'c46045a6';
const HALLUCINATED_SHA = '224678f39759e1da0000000000000000deadbeef';
const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const TICKET_WORD_RE = new RegExp(`\\b${TICKET_ID}\\b`);

function makeTmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws1b-attr-')));
}

function git(repoDir, args) {
  return execFileSync('git', ['-C', repoDir, ...args], {
    timeout: 8000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function commitFile(repoDir, name, body, msg) {
  fs.writeFileSync(path.join(repoDir, name), body);
  git(repoDir, ['add', '--', name]);
  git(repoDir, ['commit', '-m', msg, '--no-gpg-sign']);
  return git(repoDir, ['rev-parse', 'HEAD']);
}

function initRepo() {
  const repoDir = makeTmp();
  git(repoDir, ['init']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  git(repoDir, ['config', 'commit.gpgsign', 'false']);
  const baseSha = commitFile(repoDir, 'base.txt', 'base\n', 'base commit');
  return { repoDir, baseSha };
}

function messageOf(repoDir, sha) {
  return git(repoDir, ['log', '-1', '--format=%B', sha]);
}

/** The consumer's oracle: git's parsed trailer view, not a raw-message grep. */
function parsedTicketTrailers(repoDir, sha) {
  return git(repoDir, ['log', '-1', '--format=%(trailers:key=Pickle-Ticket,valueonly)', sha])
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
}

function parsedTrailer(repoDir, sha, key) {
  return git(repoDir, ['log', '-1', `--format=%(trailers:key=${key},valueonly)`, sha]).trim();
}

test('hallucinated claimed sha is discarded and replaced by the verified full in-window sha', () => {
  const { repoDir, baseSha } = initRepo();
  const c1 = commitFile(repoDir, 'a.txt', 'a\n', 'Add Reducto Redis circuit store');
  const c2 = commitFile(repoDir, 'b.txt', 'b\n', 'unrelated follow-up');

  const result = reconcileWorkerCommitAttribution(repoDir, TICKET_ID, baseSha, HALLUCINATED_SHA, {
    declaredFiles: ['a.txt'],
  });

  assert.match(result ?? '', FULL_SHA_RE, 'returns a full 40-char sha');
  assert.equal(result, c1, 'declared-file scan picks the real commit, not the hallucinated claim');
  // Multi-commit window: no amend — history untouched.
  assert.equal(git(repoDir, ['rev-parse', 'HEAD']), c2);
  assert.doesNotMatch(messageOf(repoDir, c1), TICKET_WORD_RE);
});

test('short claimed sha in-window is normalized to the full 40-char form', () => {
  const { repoDir, baseSha } = initRepo();
  const c1 = commitFile(repoDir, 'a.txt', 'a\n', `feat(${TICKET_ID}): tagged work`);
  commitFile(repoDir, 'b.txt', 'b\n', 'follow-up');

  const result = reconcileWorkerCommitAttribution(repoDir, TICKET_ID, baseSha, c1.slice(0, 9), {});

  assert.equal(result, c1, 'short in-window claim resolves to the full sha');
});

test('claimed sha equal to the baseline (out-of-window) is discarded and replaced', () => {
  const { repoDir, baseSha } = initRepo();
  const c1 = commitFile(repoDir, 'a.txt', 'a\n', `feat(${TICKET_ID}): real work`);
  const c2 = commitFile(repoDir, 'b.txt', 'b\n', 'newer work');

  const result = reconcileWorkerCommitAttribution(repoDir, TICKET_ID, baseSha, baseSha, {});

  assert.equal(result, c2, 'baseline claim falls back to the newest in-window commit');
  assert.notEqual(result, c1);
});

test('untagged single-commit tip is amended with a Pickle-Ticket trailer (word-boundary attributable)', () => {
  const { repoDir, baseSha } = initRepo();
  const c1 = commitFile(repoDir, 'a.txt', 'a\n', 'Add Reducto Redis circuit store');

  const result = reconcileWorkerCommitAttribution(repoDir, TICKET_ID, baseSha, null, {
    declaredFiles: ['a.txt'],
  });

  const head = git(repoDir, ['rev-parse', 'HEAD']);
  assert.match(result ?? '', FULL_SHA_RE);
  assert.equal(result, head, 'returned sha tracks the amended tip');
  assert.notEqual(result, c1, 'tip was amended (new sha)');
  const message = messageOf(repoDir, head);
  assert.match(message, TICKET_WORD_RE, 'amended message word-boundary-matches the ticket id');
  assert.deepEqual(parsedTicketTrailers(repoDir, head), [TICKET_ID], 'trailer parses via the consumer\'s oracle, not a raw-message grep');
  assert.match(message, /Add Reducto Redis circuit store/, 'original message preserved');
});

/**
 * AP-EXT-ITER4-01 (CRITICAL): the already-attributed guard must consult the
 * CONSUMER's oracle — git's parsed trailer view — not the raw message. git
 * parses trailers from the LAST paragraph only, so a ticket id in the subject
 * or body prose is NOT attribution. This test previously asserted the opposite
 * (`fix(<id>): already tagged` => "NOT amended"), which encoded the divergent
 * oracle as the contract and let the bug ship: 7 consecutive commits on
 * release/v2.1-beta carry `(ticket 6b7c3b82)` in prose with ZERO parsed
 * Pickle-Ticket trailer, so `scanGitLogByTrailer` — the only git-log arm after
 * B-GITATTR WS-3 — reads evidence `absent` and the Done-flip refuses
 * `done_without_commit_evidence`.
 */
test('a PROSE-only ticket-id mention is not attribution — the tip IS amended', () => {
  const { repoDir, baseSha } = initRepo();
  const c1 = commitFile(repoDir, 'a.txt', 'a\n', `fix(${TICKET_ID}): mentioned only in the subject`);

  assert.deepEqual(parsedTicketTrailers(repoDir, c1), [], 'precondition: prose mention parses as NO trailer');

  const result = reconcileWorkerCommitAttribution(repoDir, TICKET_ID, baseSha, c1, {});

  const head = git(repoDir, ['rev-parse', 'HEAD']);
  assert.equal(result, head, 'returned sha tracks the amended tip');
  assert.notEqual(result, c1, 'prose mention did NOT suppress the stamp');
  assert.deepEqual(parsedTicketTrailers(repoDir, head), [TICKET_ID], 'the trailer scan can now attribute the commit');
});

test('a real parsed Pickle-Ticket trailer DOES suppress the amend (idempotent)', () => {
  const { repoDir, baseSha } = initRepo();
  const c1 = commitFile(repoDir, 'a.txt', 'a\n', `real work\n\nPickle-Ticket: ${TICKET_ID}`);

  assert.deepEqual(parsedTicketTrailers(repoDir, c1), [TICKET_ID], 'precondition: trailer parses');

  const result = reconcileWorkerCommitAttribution(repoDir, TICKET_ID, baseSha, c1, {});

  assert.equal(result, c1);
  assert.equal(git(repoDir, ['rev-parse', 'HEAD']), c1, 'no amend — sha unchanged');
  assert.deepEqual(parsedTicketTrailers(repoDir, c1), [TICKET_ID], 'trailer not duplicated');
});

/**
 * AC-LAND-10: the guard is KEY-PRESENCE, not value-equality. A commit already
 * carrying a `Pickle-Ticket` trailer for a DIFFERENT ticket id must be left
 * alone — a value-match guard would fall through to the writer, and
 * `--if-exists addIfDifferentNeighbor` would then ADD a second value instead
 * of leaving the existing one alone, ending with two parsed values.
 */
test('a DIFFERENT-id Pickle-Ticket trailer is left alone — exactly ONE parsed value survives', () => {
  const { repoDir, baseSha } = initRepo();
  const OTHER_TICKET_ID = 'deadbeef';
  const c1 = commitFile(repoDir, 'a.txt', 'a\n', `real work\n\nPickle-Ticket: ${OTHER_TICKET_ID}`);

  assert.deepEqual(parsedTicketTrailers(repoDir, c1), [OTHER_TICKET_ID], 'precondition: foreign trailer parses');

  const result = reconcileWorkerCommitAttribution(repoDir, TICKET_ID, baseSha, c1, {});

  assert.equal(result, c1, 'foreign trailer presence suppressed the amend — sha unchanged');
  assert.equal(git(repoDir, ['rev-parse', 'HEAD']), c1, 'no amend happened');
  const trailersAfter = parsedTicketTrailers(repoDir, c1);
  assert.equal(trailersAfter.length, 1, 'exactly one parsed Pickle-Ticket value survives');
  assert.deepEqual(trailersAfter, [OTHER_TICKET_ID], 'the pre-existing foreign value is untouched, not duplicated');
});

/**
 * AP-EXT-ITER4-02 (HIGH): the trailer must be written with git's own trailer
 * WRITER so it joins the existing trailer block. A `-m message -m trailer`
 * append opens a NEW paragraph, demoting every pre-existing trailer to body
 * prose — `Co-Authored-By` parses before the amend and returns EMPTY after.
 */
test('pre-existing trailers survive the amend instead of being demoted to prose', () => {
  const { repoDir, baseSha } = initRepo();
  const c1 = commitFile(
    repoDir,
    'a.txt',
    'a\n',
    'untagged work\n\nCo-Authored-By: Somebody <s@b.com>\nSigned-off-by: Dev <d@b.com>',
  );

  assert.equal(parsedTrailer(repoDir, c1, 'Co-Authored-By'), 'Somebody <s@b.com>', 'precondition: parses pre-amend');

  const result = reconcileWorkerCommitAttribution(repoDir, TICKET_ID, baseSha, null, { declaredFiles: ['a.txt'] });

  const head = git(repoDir, ['rev-parse', 'HEAD']);
  assert.equal(result, head, 'tip was amended');
  assert.deepEqual(parsedTicketTrailers(repoDir, head), [TICKET_ID], 'Pickle-Ticket parses');
  assert.equal(
    parsedTrailer(repoDir, head, 'Co-Authored-By'),
    'Somebody <s@b.com>',
    'Co-Authored-By still parses — not demoted into body prose',
  );
  assert.equal(parsedTrailer(repoDir, head, 'Signed-off-by'), 'Dev <d@b.com>', 'Signed-off-by still parses');
});

test('amend is SKIPPED on a dirty index (staged foreign work must not be swept in)', () => {
  const { repoDir, baseSha } = initRepo();
  const c1 = commitFile(repoDir, 'a.txt', 'a\n', 'untagged work');
  fs.writeFileSync(path.join(repoDir, 'staged.txt'), 'foreign\n');
  git(repoDir, ['add', '--', 'staged.txt']);

  const result = reconcileWorkerCommitAttribution(repoDir, TICKET_ID, baseSha, c1, {});

  assert.equal(result, c1, 'verified sha still returned');
  assert.equal(git(repoDir, ['rev-parse', 'HEAD']), c1, 'no amend on dirty index');
  assert.doesNotMatch(messageOf(repoDir, c1), TICKET_WORD_RE);
  const staged = git(repoDir, ['diff', '--cached', '--name-only']);
  assert.equal(staged, 'staged.txt', 'staged work left untouched');
});

test('amend is SKIPPED on a multi-commit window', () => {
  const { repoDir, baseSha } = initRepo();
  commitFile(repoDir, 'a.txt', 'a\n', 'first untagged');
  const c2 = commitFile(repoDir, 'b.txt', 'b\n', 'second untagged');

  const result = reconcileWorkerCommitAttribution(repoDir, TICKET_ID, baseSha, c2, {});

  assert.equal(result, c2);
  assert.equal(git(repoDir, ['rev-parse', 'HEAD']), c2, 'no amend on multi-commit window');
  assert.doesNotMatch(messageOf(repoDir, c2), TICKET_WORD_RE);
});

test('preWorkerHead === HEAD is a no-op (returns null, repo untouched)', () => {
  const { repoDir, baseSha } = initRepo();

  const result = reconcileWorkerCommitAttribution(repoDir, TICKET_ID, baseSha, HALLUCINATED_SHA, {});

  assert.equal(result, null);
  assert.equal(git(repoDir, ['rev-parse', 'HEAD']), baseSha);
});

test('null preWorkerHead is a no-op', () => {
  const { repoDir } = initRepo();
  commitFile(repoDir, 'a.txt', 'a\n', 'work');

  assert.equal(reconcileWorkerCommitAttribution(repoDir, TICKET_ID, null, null, {}), null);
});

test('git failure is best-effort: non-repo workingDir returns null, never throws', () => {
  const dir = makeTmp();

  assert.equal(reconcileWorkerCommitAttribution(dir, TICKET_ID, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', HALLUCINATED_SHA, {}), null);
});

test('no declared-file match falls back to the newest in-window commit', () => {
  const { repoDir, baseSha } = initRepo();
  commitFile(repoDir, 'a.txt', 'a\n', 'older');
  const c2 = commitFile(repoDir, 'b.txt', 'b\n', 'newest');

  const result = reconcileWorkerCommitAttribution(repoDir, TICKET_ID, baseSha, HALLUCINATED_SHA, {
    declaredFiles: ['nonexistent.txt'],
  });

  assert.equal(result, c2);
});

// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { inspectPhantomDoneTicketFile, refreshPriorStatusAfterInspect, restorablePriorStatus } from '../bin/mux-runner.js';

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
    execFileSync(
      'git',
      ['commit', '-m', 'watcher inference', '--trailer', 'Pickle-Ticket: phantom01', '--no-gpg-sign'],
      { cwd: root, stdio: 'ignore' },
    );
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

// --- AP-EXT-ITER191-01: `Done` must never enter the watcher's prior-status map ---
//
// `priorStatusMap` has two writers. `seedPriorTicketStatus` refused Done at install
// time; `refreshPriorStatusAfterInspect` had no such guard and its reason allow-list
// admitted `has_completion_commit` — a reason `inspectPhantomDoneTicketFile` only
// ever returns when the live status IS Done, so the ordinary "Done with a resolvable
// commit" inspect seeded `Done`. A later revert then wrote Done over Done, which
// `updateTicketStatusInTransaction` refuses as a no-op, so `writeTicketStatus`
// returned false and the refused revert surfaced as `reason: 'unparseable'`: the
// phantom Done survived and the log blamed the ticket file. `'unparseable'` is not in
// the allow-list either, so the poisoned entry was never cleared — permanent.

function writeDoneTicket(sessionDir, ticketId, sha, status = 'Done') {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const ticketPath = path.join(ticketDir, `rick_ticket_${ticketId}.md`);
  fs.writeFileSync(ticketPath, [
    '---', `id: ${ticketId}`, `status: "${status}"`, 'order: 1',
    `completion_commit: "${sha}"`, '---', '# body',
  ].join('\n'));
  return ticketPath;
}

const UNREACHABLE_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

test('AP-EXT-ITER191-01: a has_completion_commit inspect does not seed Done into the prior-status map', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const sessionDir = path.join(root, 'session');
    const ticketPath = writeDoneTicket(sessionDir, 'phantom02', sha);

    const priorStatusMap = new Map();
    const result = inspectPhantomDoneTicketFile(ticketPath, sessionDir, root, 'Todo');
    assert.equal(result.reason, 'has_completion_commit');

    refreshPriorStatusAfterInspect(priorStatusMap, 'phantom02', ticketPath, result);
    assert.equal(priorStatusMap.has('phantom02'), false,
      'a Done ticket must leave no prior-status entry — Done is what a revert undoes');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER191-01: after a has_completion_commit inspect, a due revert still reverts (not unparseable)', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const sessionDir = path.join(root, 'session');
    const ticketPath = writeDoneTicket(sessionDir, 'phantom03', sha);
    const priorStatusMap = new Map();

    // Inspect 1: the ordinary Done-with-resolvable-commit case.
    const first = inspectPhantomDoneTicketFile(ticketPath, sessionDir, root, priorStatusMap.get('phantom03') ?? 'Todo');
    refreshPriorStatusAfterInspect(priorStatusMap, 'phantom03', ticketPath, first);

    // Inspect 2: same ticket, commit no longer resolvable → a revert is due.
    writeDoneTicket(sessionDir, 'phantom03', UNREACHABLE_SHA);
    const second = inspectPhantomDoneTicketFile(ticketPath, sessionDir, root, priorStatusMap.get('phantom03') ?? 'Todo');

    assert.equal(second.reason, 'reverted', 'the revert must land, not be refused as unparseable');
    assert.equal(second.changed, true);
    assert.match(fs.readFileSync(ticketPath, 'utf8'), /status: "Todo"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER191-01 control: the map still restores a real prior status (In Progress)', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const sessionDir = path.join(root, 'session');
    const ticketPath = writeDoneTicket(sessionDir, 'phantom04', sha, 'In Progress');
    const priorStatusMap = new Map();

    const notDone = inspectPhantomDoneTicketFile(ticketPath, sessionDir, root, 'Todo');
    assert.equal(notDone.reason, 'not_done');
    refreshPriorStatusAfterInspect(priorStatusMap, 'phantom04', ticketPath, notDone);
    assert.equal(priorStatusMap.get('phantom04'), 'In Progress');

    // The ticket flips Done without a resolvable commit → revert restores In Progress,
    // which is the whole reason the map exists.
    writeDoneTicket(sessionDir, 'phantom04', UNREACHABLE_SHA);
    const reverted = inspectPhantomDoneTicketFile(ticketPath, sessionDir, root, priorStatusMap.get('phantom04') ?? 'Todo');
    assert.equal(reverted.reason, 'reverted');
    assert.match(fs.readFileSync(ticketPath, 'utf8'), /status: "In Progress"/);

    refreshPriorStatusAfterInspect(priorStatusMap, 'phantom04', ticketPath, reverted);
    assert.equal(priorStatusMap.get('phantom04'), 'In Progress');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER191-01: restorablePriorStatus is the ONE predicate both map writers share', () => {
  for (const rejected of ['Done', 'done', 'DONE', '  Done  ', '"Done"', "'done'", '', '   ', null, undefined]) {
    assert.equal(restorablePriorStatus(rejected), null, `must refuse ${JSON.stringify(rejected)}`);
  }
  assert.equal(restorablePriorStatus('Todo'), 'Todo');
  assert.equal(restorablePriorStatus('In Progress'), 'In Progress');
  // Quote/whitespace normalization is uniform, so a hand-edited `status: "Todo "`
  // cannot smuggle a value past the Done check nor land unnormalized in the map.
  assert.equal(restorablePriorStatus(' In Progress '), 'In Progress');
  assert.equal(restorablePriorStatus('"Todo"'), 'Todo');
});

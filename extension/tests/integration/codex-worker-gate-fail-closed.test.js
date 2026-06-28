// @tier: integration
// WS-1 characterization (TDD red): documents the pre-WS-2 fail-OPEN — an absent
// worker-gate verdict on a non-salvage Done-flip path still flips Done. WS-2 (R-CWGE)
// flips this assertion to ok:false (fail-closed).
//
// guardCompletionCommitBeforeDone (mux-runner.ts) fail-CLOSES on a RED worker-gate
// verdict ONLY for a salvage / no_progress_timeout disposition (the
// isNoProgressTimeoutDisposition && workerGateTscWasRed branch). For a NORMAL committed
// ticket with NO recorded worker-gate verdict field, it returns { ok: true, sha } —
// flipping Done purely on commit-existence, regardless of code health. That
// fail-OPEN-on-absent behavior is the bug WS-2 makes fail-CLOSED.
//
// Harness mirrors guard-completion-commit-tsc-gate.test.js: real git repo + temp
// session dir, explicit git-reachable completion_commit, PICKLE_TEST_MODE UNSET so the
// real evidence + disposition path runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DATA_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwge-data-')));
process.env.PICKLE_DATA_ROOT = DATA_ROOT;

const { guardCompletionCommitBeforeDone } = await import('../../bin/mux-runner.js');

function makeTmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwge-guard-')));
}

function git(repoDir, args) {
  return execFileSync('git', ['-C', repoDir, ...args], { timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function initRepo(repoDir) {
  git(repoDir, ['init']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
}

function commitFile(repoDir, name, body, msg) {
  fs.writeFileSync(path.join(repoDir, name), body);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', msg]);
  return git(repoDir, ['rev-parse', 'HEAD']);
}

// A NORMAL committed ticket: explicit completion_commit, NO failed_reason (not a
// salvage / no_progress disposition), and NO worker_gate_tsc_ok / worker_gate_verdict
// frontmatter field at all.
function writeTicket(sessionDir, ticketId, sha) {
  const dir = path.join(sessionDir, ticketId);
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['---', `id: ${ticketId}`, 'status: In Progress', `completion_commit: ${sha}`, '---', ''];
  fs.writeFileSync(path.join(dir, `linear_ticket_${ticketId}.md`), lines.join('\n'));
}

function writeState(sessionDir, startCommit) {
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ schema_version: 5, start_commit: startCommit, pinned_sha: null }));
}

// The guard early-returns ok:true under PICKLE_TEST_MODE=1 — this test MUST exercise
// the REAL evidence + disposition path, so the var must be unset and restored after.
function withoutTestMode(fn) {
  const prev = process.env.PICKLE_TEST_MODE;
  delete process.env.PICKLE_TEST_MODE;
  try { return fn(); } finally { if (prev !== undefined) process.env.PICKLE_TEST_MODE = prev; }
}

function setup() {
  const root = makeTmp();
  const sessionDir = path.join(root, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  initRepo(root);
  const baseline = commitFile(root, 'init.txt', 'init', 'baseline');
  const real = commitFile(root, 'work.txt', 'real work', 'feat: real ticket work');
  writeTicket(sessionDir, 'abc12345', real);
  writeState(sessionDir, baseline);
  return { root, sessionDir, real };
}

// AC-CWGE-1 (characterization, fail-OPEN): a normally-committed ticket with NO recorded
// worker-gate verdict and NO salvage/no_progress disposition still flips Done on
// commit-existence alone. WS-2 flips this to ok:false.
test('R-CWGE WS-1: absent worker-gate verdict on a non-salvage Done-flip still flips Done (pre-WS-2 fail-OPEN)', () => {
  withoutTestMode(() => {
    const { root, sessionDir, real } = setup();
    const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId: 'abc12345', workingDir: root, rereadBackoffMs: 0 });
    assert.equal(guard.ok, true, 'CURRENT behavior: commit-existence alone flips Done with no worker-gate verdict (WS-2 makes this ok:false)');
    assert.equal(guard.sha, real, 'the committed sha is attributed');
  });
});

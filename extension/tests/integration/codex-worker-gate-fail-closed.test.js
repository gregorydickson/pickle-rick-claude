// @tier: integration
// B-CWGE WS-2 (R-CWGE): the recorded worker-gate verdict is authoritative on EVERY
// Done-flip path. guardCompletionCommitBeforeDone (mux-runner.ts) fail-CLOSES on a
// red OR absent/unverifiable verdict.
//
// For a NORMAL committed ticket with NO recorded worker-gate verdict, WS-2 computes one
// via the between-ticket fast gate. In this temp-repo harness there is no `extension/`
// dir, so the JS worker gate is NOT APPLICABLE (a non-pickle-rick target, e.g.
// loanlight-api) -> verdict 'green' -> Done flips (NOT universally fail-closed). The core
// fail-closed behavior is pinned by the explicit `worker_gate_verdict: red` case below;
// `worker_gate_verdict: green` flips Done.
//
// Harness mirrors guard-completion-commit-tsc-gate.test.js: real git repo + temp
// session dir, explicit git-reachable completion_commit, PICKLE_TEST_MODE UNSET so the
// real evidence + verdict path runs.

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

// A NORMAL committed ticket: explicit completion_commit, NO failed_reason. The optional
// `verdict` adds a `worker_gate_verdict` frontmatter field; omitted => absent.
function writeTicket(sessionDir, ticketId, sha, { verdict } = {}) {
  const dir = path.join(sessionDir, ticketId);
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['---', `id: ${ticketId}`, 'status: In Progress', `completion_commit: ${sha}`];
  if (verdict !== undefined) { lines.push(`worker_gate_verdict: ${verdict}`); }
  lines.push('---', '');
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
  try { return fn(); } finally { if (prev !== undefined) { process.env.PICKLE_TEST_MODE = prev; } }
}

function setup({ verdict } = {}) {
  const root = makeTmp();
  const sessionDir = path.join(root, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  initRepo(root);
  const baseline = commitFile(root, 'init.txt', 'init', 'baseline');
  const real = commitFile(root, 'work.txt', 'real work', 'feat: real ticket work');
  writeTicket(sessionDir, 'abc12345', real, { verdict });
  writeState(sessionDir, baseline);
  return { root, sessionDir, real };
}

// AC-CWGE-6 (gate not applicable): a normally-committed ticket with NO recorded
// worker-gate verdict computes one via the between-ticket fast gate. The temp-repo harness
// has no `extension/` dir (a non-pickle-rick target), so the JS worker gate is NOT
// applicable -> verdict 'green' -> Done flips. This pins that fail-closed does NOT
// universally refuse Done-flips on non-pickle-rick repos (regression guard).
test('R-CWGE WS-2: absent verdict on a non-pickle-rick target (no extension/) flips Done (gate not applicable)', () => {
  withoutTestMode(() => {
    const { root, sessionDir, real } = setup();
    const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId: 'abc12345', workingDir: root, rereadBackoffMs: 0 });
    assert.equal(guard.ok, true, 'no extension/ dir => worker gate not applicable => verdict green => Done flips');
    assert.equal(guard.sha, real, 'the committed sha is attributed');
  });
});

// AC-CWGE-3: an explicit GREEN verdict preserves the happy path.
test('R-CWGE WS-2: explicit worker_gate_verdict=green flips Done (happy path preserved)', () => {
  withoutTestMode(() => {
    const { root, sessionDir, real } = setup({ verdict: 'green' });
    const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId: 'abc12345', workingDir: root, rereadBackoffMs: 0 });
    assert.equal(guard.ok, true, 'a recorded green verdict flips Done');
    assert.equal(guard.sha, real, 'the committed sha is attributed');
  });
});

// AC-CWGE-4: an explicit RED verdict is fail-closed.
test('R-CWGE WS-2: explicit worker_gate_verdict=red is fail-CLOSED', () => {
  withoutTestMode(() => {
    const { root, sessionDir } = setup({ verdict: 'red' });
    const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId: 'abc12345', workingDir: root, rereadBackoffMs: 0 });
    assert.equal(guard.ok, false, 'a recorded red verdict must NOT flip Done (R-CWGE fail-closed)');
  });
});

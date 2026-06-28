// @tier: integration
// B-PXBO WS-2 (R-DOTR): the Done-flip guard must reject a salvage / no_progress_timeout
// commit over tsc-RED code (gated on the worker gate's persisted tscOk verdict), while
// leaving the normal happy path AND green-salvage path untouched.
//
// R-PTSB: this test invokes guardCompletionCommitBeforeDone, a session-writing mux-runner
// helper (its R-WUWC auto-promote upserts ticket frontmatter), so PICKLE_DATA_ROOT is
// sandboxed to a tmp dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DATA_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dotr-data-')));
process.env.PICKLE_DATA_ROOT = DATA_ROOT;

const { guardCompletionCommitBeforeDone } = await import('../bin/mux-runner.js');

function makeTmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dotr-guard-')));
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

// Build a ticket whose explicit completion_commit attributes a real commit, plus the
// optional WS-2 disposition (failed_reason) and persisted worker_gate_tsc_ok fields.
function writeTicket(sessionDir, ticketId, sha, { failedReason, tscOk } = {}) {
  const dir = path.join(sessionDir, ticketId);
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['---', `id: ${ticketId}`, 'status: In Progress', `completion_commit: ${sha}`];
  if (failedReason !== undefined) lines.push(`failed_reason: ${failedReason}`);
  if (tscOk !== undefined) lines.push(`worker_gate_tsc_ok: ${tscOk}`);
  lines.push('---', '');
  fs.writeFileSync(path.join(dir, `linear_ticket_${ticketId}.md`), lines.join('\n'));
}

function writeState(sessionDir, startCommit) {
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ schema_version: 5, start_commit: startCommit, pinned_sha: null }));
}

// The guard early-returns ok:true under PICKLE_TEST_MODE=1 — these tests must exercise
// the REAL evidence + disposition path, so the var must be unset.
function withoutTestMode(fn) {
  const prev = process.env.PICKLE_TEST_MODE;
  delete process.env.PICKLE_TEST_MODE;
  try { return fn(); } finally { if (prev !== undefined) process.env.PICKLE_TEST_MODE = prev; }
}

function setup({ failedReason, tscOk } = {}) {
  const root = makeTmp();
  const sessionDir = path.join(root, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  initRepo(root);
  const baseline = commitFile(root, 'init.txt', 'init', 'baseline');
  const real = commitFile(root, 'work.txt', 'real work', 'feat: real ticket work');
  writeTicket(sessionDir, 'abc12345', real, { failedReason, tscOk });
  writeState(sessionDir, baseline);
  return { root, sessionDir, real };
}

// AC-DOTR-2: salvage / no_progress_timeout disposition + tsc RED -> guard REFUSES.
test('R-DOTR: no_progress_timeout disposition + tsc-RED rejects the Done-flip', () => {
  withoutTestMode(() => {
    const { root, sessionDir } = setup({ failedReason: 'no_progress_timeout', tscOk: 'false' });
    const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId: 'abc12345', workingDir: root, rereadBackoffMs: 0 });
    assert.equal(guard.ok, false, 'a salvage commit over tsc-RED code must NOT flip Done');
    assert.match(guard.reason, /tsc-RED|R-DOTR/, 'rejection names the tsc-RED disposition gate');
  });
});

test('R-DOTR: oversized_no_progress disposition + tsc-RED also rejects (all NO_PROGRESS reasons)', () => {
  withoutTestMode(() => {
    const { root, sessionDir } = setup({ failedReason: 'oversized_no_progress', tscOk: 'false' });
    const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId: 'abc12345', workingDir: root, rereadBackoffMs: 0 });
    assert.equal(guard.ok, false);
  });
});

// AC-DOTR-3: green-salvage path STILL flips Done (no regression).
test('R-DOTR: no_progress_timeout disposition + tsc-GREEN still flips Done', () => {
  withoutTestMode(() => {
    const { root, sessionDir, real } = setup({ failedReason: 'no_progress_timeout', tscOk: 'true' });
    const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId: 'abc12345', workingDir: root, rereadBackoffMs: 0 });
    assert.equal(guard.ok, true, 'a green salvage commit is accepted (AC-DOTR-3)');
    assert.equal(guard.sha, real);
  });
});

test('R-DOTR: no_progress_timeout disposition + ABSENT tsc field still flips Done (no signal => no gate)', () => {
  withoutTestMode(() => {
    const { root, sessionDir, real } = setup({ failedReason: 'no_progress_timeout' });
    const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId: 'abc12345', workingDir: root, rereadBackoffMs: 0 });
    assert.equal(guard.ok, true, 'an absent tsc verdict (worker never ran tsc) does NOT gate');
    assert.equal(guard.sha, real);
  });
});

// AC-DOTR-4: the tsc gate fires ONLY on salvage/timeout dispositions. A normally-completed
// ticket (no failed_reason) that happens to carry a stale tsc-RED verdict is NOT re-gated.
test('R-DOTR: normal ticket (no failed_reason) + tsc-RED is NOT re-gated (AC-DOTR-4)', () => {
  withoutTestMode(() => {
    const { root, sessionDir, real } = setup({ tscOk: 'false' });
    const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId: 'abc12345', workingDir: root, rereadBackoffMs: 0 });
    assert.equal(guard.ok, true, 'no salvage disposition => the tsc gate never fires');
    assert.equal(guard.sha, real);
  });
});

// AC-DOTR-1 (subtract): the gate consumes the EXISTING WorkerGateCheckResult.tscOk shape
// persisted into ticket frontmatter — there is no new state field and no second tsc run.
test('R-DOTR: no-new-state-field — gate reads worker_gate_tsc_ok frontmatter, never re-runs tsc', () => {
  const src = fs.readFileSync(new URL('../../extension/src/bin/mux-runner.ts', import.meta.url), 'utf8');
  // The guard's disposition + tsc-verdict reads are frontmatter reads, not a tsc spawn.
  assert.match(src, /workerGateTscWasRed/, 'guard reads the persisted tsc verdict via a frontmatter helper');
  assert.match(src, /isNoProgressTimeoutDisposition/, 'guard detects disposition via the existing failed_reason read');
  // No forbidden parallel runnability state field was introduced (R-RMBS-1/-3).
  assert.doesNotMatch(src, /state\.(failed|blocked|skipped)_tickets/, 'no parallel runnability set');
  // The spawn-morty producer persists tscOk without a second tsc invocation in the guard.
  const spawnSrc = fs.readFileSync(new URL('../../extension/src/bin/spawn-morty.ts', import.meta.url), 'utf8');
  assert.match(spawnSrc, /persistWorkerGateTscOk/, 'spawn-morty persists the already-computed tscOk');
});

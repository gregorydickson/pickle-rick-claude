// @tier: integration
// B-CWGE WS-2 (R-CWGE): the Done-flip guard makes the recorded worker-gate verdict
// (`worker_gate_verdict`) authoritative on EVERY committed Done-flip path — a red OR
// absent/unverifiable verdict is fail-closed; only a GREEN verdict flips Done. This
// generalizes the prior salvage-only tsc gate (R-DOTR) and preserves no regression on
// the salvage / no_progress_timeout fail-closed case.
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

const DATA_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwge-data-')));
process.env.PICKLE_DATA_ROOT = DATA_ROOT;

const { guardCompletionCommitBeforeDone } = await import('../bin/mux-runner.js');

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

// Build a ticket whose explicit completion_commit attributes a real commit, plus the
// optional disposition (failed_reason) and persisted worker_gate_verdict fields.
function writeTicket(sessionDir, ticketId, sha, { failedReason, verdict } = {}) {
  const dir = path.join(sessionDir, ticketId);
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['---', `id: ${ticketId}`, 'status: In Progress', `completion_commit: ${sha}`];
  if (failedReason !== undefined) lines.push(`failed_reason: ${failedReason}`);
  if (verdict !== undefined) { lines.push(`worker_gate_verdict: ${verdict}`); }
  lines.push('---', '');
  fs.writeFileSync(path.join(dir, `rick_ticket_${ticketId}.md`), lines.join('\n'));
}

function writeState(sessionDir, startCommit) {
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ schema_version: 5, start_commit: startCommit, pinned_sha: null }));
}

// The guard early-returns ok:true under PICKLE_TEST_MODE=1 — these tests must exercise
// the REAL evidence + verdict path, so the var must be unset.
function withoutTestMode(fn) {
  const prev = process.env.PICKLE_TEST_MODE;
  delete process.env.PICKLE_TEST_MODE;
  try { return fn(); } finally { if (prev !== undefined) process.env.PICKLE_TEST_MODE = prev; }
}

// `onRepo` opts the fixture into the PICKLE-RICK shape by creating the `extension/` tree.
// That directory is exactly what `isAdvisoryWorkerGateVerdict` (mux-runner.ts) probes to
// tell "our own repo" from "a target repo", so it is load-bearing for any assertion about a
// RED verdict. Default OFF: the off-repo shape is the one the not-applicable cases need.
function setup({ failedReason, verdict, onRepo = false } = {}) {
  const root = makeTmp();
  const sessionDir = path.join(root, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  if (onRepo) { fs.mkdirSync(path.join(root, 'extension'), { recursive: true }); }
  initRepo(root);
  const baseline = commitFile(root, 'init.txt', 'init', 'baseline');
  const real = commitFile(root, 'work.txt', 'real work', 'feat: real ticket work');
  writeTicket(sessionDir, 'abc12345', real, { failedReason, verdict });
  writeState(sessionDir, baseline);
  return { root, sessionDir, real };
}

// AC-CWGE-3 (no regression): salvage / no_progress_timeout disposition + RED verdict
// -> guard REFUSES (the original R-DOTR fail-closed case, now via the unified verdict).
//
// B-OFFREPO: `onRepo: true` is load-bearing. `isAdvisoryWorkerGateVerdict` (mux-runner.ts)
// reads a red as ADVISORY when `<workingDir>/extension` is absent, because a red authored by
// a target repo's own toolchain is a finding to flag, not a refusal to issue. Left off-repo
// (as this fixture was written), the guard would ACCEPT and this test would green over the
// very fail-closed path it names. The off-repo disposition of a red is pinned separately in
// tests/worker-gate-offrepo-runs.test.js.
test('R-CWGE: no_progress_timeout disposition + RED verdict on pickle-rick itself rejects the Done-flip', () => {
  withoutTestMode(() => {
    const { root, sessionDir } = setup({ failedReason: 'no_progress_timeout', verdict: 'red', onRepo: true });
    const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId: 'abc12345', workingDir: root, rereadBackoffMs: 0 });
    assert.equal(guard.ok, false, 'a salvage commit over a RED verdict must NOT flip Done');
    assert.match(guard.reason, /worker_gate_verdict|R-CWGE/, 'rejection names the worker-gate verdict gate');
  });
});

// B-OFFREPO: same on-repo requirement as the sibling above — a red is only fail-closed on
// pickle-rick's own repo, which the `extension/` tree is what makes this fixture.
test('R-CWGE: oversized_no_progress disposition + RED verdict on pickle-rick itself also rejects', () => {
  withoutTestMode(() => {
    const { root, sessionDir } = setup({ failedReason: 'oversized_no_progress', verdict: 'red', onRepo: true });
    const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId: 'abc12345', workingDir: root, rereadBackoffMs: 0 });
    assert.equal(guard.ok, false);
  });
});

// AC-CWGE-3: a GREEN verdict still flips Done (no regression on the happy path).
test('R-CWGE: no_progress_timeout disposition + GREEN verdict still flips Done', () => {
  withoutTestMode(() => {
    const { root, sessionDir, real } = setup({ failedReason: 'no_progress_timeout', verdict: 'green' });
    const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId: 'abc12345', workingDir: root, rereadBackoffMs: 0 });
    assert.equal(guard.ok, true, 'a green salvage commit is accepted (AC-CWGE-3)');
    assert.equal(guard.sha, real);
  });
});

// AC-CWGE-5/6: an ABSENT verdict on a salvage disposition computes one via the
// between-ticket gate. This fixture stays OFF-repo (the default) — it has no `extension/`
// dir, so it is a non-pickle-rick target and the JS worker gate is NOT applicable ->
// verdict not_run -> Done flips. B-OFFREPO: the mechanism changed, the outcome did not —
// the resolver returns `not_run` and never manufactures a green; the old "verdict green"
// reading named a mechanism that no longer exists. This
// preserves R-DOTR's AC-DOTR-3 (a salvage commit with no gate signal is not gated) and
// proves fail-closed does not universally refuse salvage Done-flips on non-pickle-rick
// repos. Fail-closed on a salvage disposition fires on a RED verdict (above) or a RED
// computed gate when `extension/` exists.
test('R-CWGE: no_progress_timeout + ABSENT verdict on a non-pickle-rick target flips Done (gate not applicable)', () => {
  withoutTestMode(() => {
    const { root, sessionDir, real } = setup({ failedReason: 'no_progress_timeout' });
    const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId: 'abc12345', workingDir: root, rereadBackoffMs: 0 });
    assert.equal(guard.ok, true, 'no extension/ dir => worker gate not applicable => verdict not_run => Done flips');
    assert.equal(guard.sha, real);
  });
});

// AC-CWGE-4: the verdict gate fires on EVERY committed path now — a normally-completed
// ticket (no failed_reason) carrying a RED verdict is also fail-closed.
//
// B-OFFREPO: `onRepo: true` for the same reason as the two salvage-disposition siblings —
// fail-closed is an ON-repo contract, and the `extension/` tree is what the classifier probes.
test('R-CWGE: normal ticket (no failed_reason) + RED verdict on pickle-rick itself is fail-CLOSED', () => {
  withoutTestMode(() => {
    const { root, sessionDir } = setup({ verdict: 'red', onRepo: true });
    const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId: 'abc12345', workingDir: root, rereadBackoffMs: 0 });
    assert.equal(guard.ok, false, 'a RED verdict fails closed on every Done-flip path (AC-CWGE-4)');
  });
});

// A normal ticket with a GREEN verdict flips Done.
test('R-CWGE: normal ticket + GREEN verdict flips Done', () => {
  withoutTestMode(() => {
    const { root, sessionDir, real } = setup({ verdict: 'green' });
    const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId: 'abc12345', workingDir: root, rereadBackoffMs: 0 });
    assert.equal(guard.ok, true);
    assert.equal(guard.sha, real);
  });
});

// AC-CWGE (source assertion): the guard reads the persisted verdict, spawn-morty
// persists it, and no parallel runnability state field was introduced (R-RMBS-1).
test('R-CWGE: guard reads worker_gate_verdict; spawn-morty persists it; no parallel runnability set', () => {
  const src = fs.readFileSync(new URL('../../extension/src/bin/mux-runner.ts', import.meta.url), 'utf8');
  assert.match(src, /readWorkerGateVerdict/, 'guard reads the persisted verdict via a frontmatter helper');
  assert.doesNotMatch(src, /state\.(failed|blocked|skipped)_tickets/, 'no parallel runnability set');
  const spawnSrc = fs.readFileSync(new URL('../../extension/src/bin/spawn-morty.ts', import.meta.url), 'utf8');
  assert.match(spawnSrc, /persistWorkerGateVerdict/, 'spawn-morty persists the worker-gate verdict');
});

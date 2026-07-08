// @tier: fast
//
// e56ed23f — orphan-chain ff-only reattach as a delta over
// detectAndRecoverHeadRegression. Four AC fixtures:
//   (a) 2-commit chain orphaned by hard reset → HEAD == chain tip, chain_length 2
//   (b) divergent HEAD (new commit after orphan) → zero mutation + held
//   (c) no-SHA fixture → fsck discovery reattaches
//   (d) out-of-window dangling commit → NOT reattached
//
// Fixture helpers mirror tests/mux-runner-head-regression.test.js and import the
// COMPILED detectAndRecoverHeadRegression from ../bin/mux-runner.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { detectAndRecoverHeadRegression } from '../bin/mux-runner.js';

function tmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-orphan-chain-')));
}

function initGitRepo(repoDir) {
  execFileSync('git', ['init', '--quiet'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.local'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
}

function gitCommit(repoDir, message) {
  fs.writeFileSync(path.join(repoDir, `commit-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`), message);
  execFileSync('git', ['add', '-A'], { cwd: repoDir });
  execFileSync('git', ['commit', '--no-gpg-sign', '-m', message], { cwd: repoDir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim();
}

function headSha(repoDir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim();
}

function objCount(repoDir) {
  return Number(execFileSync('git', ['rev-list', '--all', '--count'], { cwd: repoDir, encoding: 'utf-8' }).trim());
}

function makeTicketFile(sessionDir, ticketId, status, completionCommit) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const frontmatter = [
    '---',
    `id: ${ticketId}`,
    `title: Test ticket`,
    `status: "${status}"`,
    completionCommit ? `completion_commit: ${completionCommit}` : '',
    '---',
    '# Test',
  ].filter(Boolean).join('\n');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), frontmatter);
}

function makeStatePath(sessionDir) {
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({ active: true, schema_version: 5, iteration: 1, recovery_attempts: [], activity: [] }));
  return statePath;
}

function setup() {
  const tmp = tmpRoot();
  const repoDir = path.join(tmp, 'repo');
  const sessionDir = path.join(tmp, 'session');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  initGitRepo(repoDir);
  return { tmp, repoDir, sessionDir };
}

// (a) 2-commit chain orphaned by hard reset → HEAD == chain tip, chain_length 2.
test('orphan-chain: 2-commit chain orphaned by hard reset → HEAD == chain tip, orphan_commit_reattached chain_length 2', () => {
  const { tmp, repoDir, sessionDir } = setup();
  const startCommit = gitCommit(repoDir, 'baseline');
  const commit1 = gitCommit(repoDir, 'test: work commit 1'); // interior
  const commit2 = gitCommit(repoDir, 'test: work commit 2'); // chain tip
  execFileSync('git', ['reset', '--hard', startCommit], { cwd: repoDir });

  const ticketId = 'chain-reattach-1';
  makeTicketFile(sessionDir, ticketId, 'Done', commit1); // frontmatter points at the INTERIOR commit
  const statePath = makeStatePath(sessionDir);
  const log = [];

  const result = detectAndRecoverHeadRegression({
    ticketId,
    workingDir: repoDir,
    startCommit,
    completionCommitSha: commit1,
    sessionDir,
    statePath,
    iteration: 1,
    iterationStartMs: Date.now() - 5000,
    log: (m) => log.push(m),
  });

  assert.equal(result.detected, true);
  assert.equal(result.recovered, true);
  assert.equal(result.action, 'ff_reattached');
  // HEAD must land at the chain TIP (commit2), not the interior commit1
  assert.equal(headSha(repoDir), commit2, 'HEAD must advance to the chain tip, not the interior commit');

  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  const event = (state.activity || []).find((e) => e.event === 'orphan_commit_reattached');
  assert.ok(event, 'orphan_commit_reattached event must be emitted');
  assert.equal(event.ticket, ticketId);
  assert.equal(event.sha, commit2, 'event.sha must be the chain tip');
  assert.equal(event.chain_length, 2, 'two orphaned commits → chain_length 2');
  assert.equal(event.prev_head, startCommit, 'prev_head must be the regressed HEAD');
  assert.ok(event.ts, 'ts must be present');

  fs.rmSync(tmp, { recursive: true, force: true });
});

// (b) Divergent orphan: the orphan lives on a sibling line (not a descendant of
// startCommit), so HEAD is at startCommit (regression DETECTED) yet ff-only is
// impossible — the orphan is not a fast-forward target.
test('orphan-chain: divergent fixture (orphan not a fast-forward of HEAD) → zero mutation + orphan_commit_unreattachable + held', () => {
  const { tmp, repoDir, sessionDir } = setup();
  const root = gitCommit(repoDir, 'root');
  const mainBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim();
  // Sibling orphan line off root.
  execFileSync('git', ['checkout', '-q', '-b', 'orphanline', root], { cwd: repoDir });
  const orphanCommit = gitCommit(repoDir, 'test: divergent orphaned work');
  // Back to the main branch and advance — startCommit is a sibling of the orphan, both off root.
  execFileSync('git', ['checkout', '-q', mainBranch], { cwd: repoDir });
  const startCommit = gitCommit(repoDir, 'baseline (sibling of orphan)');
  // Delete the branch so the orphan becomes dangling but is NOT ff-reachable from startCommit.
  execFileSync('git', ['branch', '-q', '-D', 'orphanline'], { cwd: repoDir });
  assert.equal(headSha(repoDir), startCommit, 'HEAD at startCommit (regression baseline)');
  const headBefore = headSha(repoDir);
  const objBefore = objCount(repoDir);

  const ticketId = 'diverge-1';
  makeTicketFile(sessionDir, ticketId, 'Done', orphanCommit);
  const statePath = makeStatePath(sessionDir);

  const result = detectAndRecoverHeadRegression({
    ticketId,
    workingDir: repoDir,
    startCommit,
    completionCommitSha: orphanCommit,
    sessionDir,
    statePath,
    iteration: 1,
    iterationStartMs: Date.now() - 5000,
    log: () => {},
  });

  assert.equal(result.detected, true);
  assert.equal(result.recovered, false, 'divergent HEAD cannot ff-only reattach');
  // Zero mutation invariant
  assert.equal(headSha(repoDir), headBefore, 'HEAD must not move on divergence');
  assert.ok(objCount(repoDir) >= objBefore, 'history must not be rewritten on divergence');

  // The orphan SHA is a real, verifiable commit object → salvage evidence is
  // present, so the hold path SUPPRESSES the flip (action flip_suppressed) and
  // PRESERVES the ticket status (held for operator) — never marks it Failed,
  // never rewrites history.
  assert.ok(
    result.action === 'flip_suppressed' || result.action === 'suppression_cap_escalate',
    `evidence present → action must be a hold variant, got: ${result.action}`,
  );
  const ticketContent = fs.readFileSync(path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`), 'utf-8');
  assert.ok(!ticketContent.includes('status: "Failed"'), 'hold path must not mark the ticket Failed');

  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  const event = (state.activity || []).find((e) => e.event === 'orphan_commit_unreattachable');
  assert.ok(event, 'orphan_commit_unreattachable event must be emitted on divergence');
  assert.equal(event.ticket, ticketId);
  assert.equal(event.sha, orphanCommit);
  assert.ok(event.reason, 'reason must be present');
  assert.ok(event.ts, 'ts must be present');

  fs.rmSync(tmp, { recursive: true, force: true });
});

// (c) No-SHA fixture: empty frontmatter completion_commit, real orphan present →
// fsck discovery finds the chain and reattaches.
test('orphan-chain: no-SHA fixture (frontmatter blank) → fsck discovery reattaches', () => {
  const { tmp, repoDir, sessionDir } = setup();
  const startCommit = gitCommit(repoDir, 'baseline');
  const orphanCommit = gitCommit(repoDir, 'test: no-sha discovery work');
  execFileSync('git', ['reset', '--hard', startCommit], { cwd: repoDir });

  const ticketId = 'nosha-1';
  makeTicketFile(sessionDir, ticketId, 'Done', null); // no completion_commit
  const statePath = makeStatePath(sessionDir);
  const log = [];

  const result = detectAndRecoverHeadRegression({
    ticketId,
    workingDir: repoDir,
    startCommit,
    completionCommitSha: null, // no recorded SHA — forces fsck discovery
    sessionDir,
    statePath,
    iteration: 1,
    iterationStartMs: Date.now() - 5000, // window covers the orphan
    log: (m) => log.push(m),
  });

  assert.equal(result.detected, true);
  assert.equal(result.recovered, true, 'fsck discovery should find the orphan and reattach');
  assert.equal(result.action, 'ff_reattached');
  assert.equal(headSha(repoDir), orphanCommit, 'HEAD must advance to the discovered orphan');

  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  const event = (state.activity || []).find((e) => e.event === 'orphan_commit_reattached');
  assert.ok(event, 'orphan_commit_reattached must be emitted on discovery reattach');
  assert.equal(event.sha, orphanCommit);
  assert.equal(event.chain_length, 1);

  fs.rmSync(tmp, { recursive: true, force: true });
});

// (d) Out-of-window dangling commit: the orphan commit-time is far before the
// iteration window start, so resolveOrphanSha's window filter drops it.
test('orphan-chain: out-of-window dangling commit is NOT reattached', () => {
  const { tmp, repoDir, sessionDir } = setup();
  const startCommit = gitCommit(repoDir, 'baseline');
  gitCommit(repoDir, 'test: old work'); // orphan, committed "now"
  execFileSync('git', ['reset', '--hard', startCommit], { cwd: repoDir });
  const headBefore = headSha(repoDir);
  const objBefore = objCount(repoDir);

  const ticketId = 'oldts-1';
  makeTicketFile(sessionDir, ticketId, 'Done', null); // no SHA → discovery path (window-filtered)
  const statePath = makeStatePath(sessionDir);

  // iterationStartMs is FAR in the future: the orphan commit-time (~now) falls
  // before windowStart - skew, so the discovery window filter drops it.
  const futureWindowStart = Date.now() + 3_600_000; // +1h
  const result = detectAndRecoverHeadRegression({
    ticketId,
    workingDir: repoDir,
    startCommit,
    completionCommitSha: null,
    sessionDir,
    statePath,
    iteration: 1,
    iterationStartMs: futureWindowStart,
    log: () => {},
  });

  assert.equal(result.detected, true);
  assert.equal(result.recovered, false, 'out-of-window orphan must not be reattached');
  assert.equal(headSha(repoDir), headBefore, 'HEAD must not move');
  assert.ok(objCount(repoDir) >= objBefore, 'history must not be rewritten');
  // No candidate discovered → held/failed via evidence-absent branch
  assert.ok(
    result.action === 'flip_suppressed' || result.action === 'suppression_cap_escalate' || result.action === 'marked_failed',
    `action must be a hold variant or marked_failed, got: ${result.action}`,
  );

  fs.rmSync(tmp, { recursive: true, force: true });
});

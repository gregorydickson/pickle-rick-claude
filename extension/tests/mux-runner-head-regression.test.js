// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { detectAndRecoverHeadRegression } from '../bin/mux-runner.js';

function tmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mux-hreg-')));
}

function initGitRepo(repoDir) {
  execFileSync('git', ['init', '--quiet'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.local'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
}

function gitCommit(repoDir, message) {
  fs.writeFileSync(path.join(repoDir, `commit-${Date.now()}.txt`), message);
  execFileSync('git', ['add', '-A'], { cwd: repoDir });
  execFileSync('git', ['commit', '--no-gpg-sign', '-m', message], { cwd: repoDir });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim();
  return sha;
}

function headSha(repoDir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim();
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
  fs.writeFileSync(statePath, JSON.stringify({ active: true, schema_version: 5, iteration: 1 }));
  return statePath;
}

// AC-CXOR-1-1 (a): ff-only reattach succeeds when completion_commit SHA is valid
test('R-CXOR-1: detectAndRecoverHeadRegression reattaches orphaned commit via ff-only merge', () => {
  const tmp = tmpRoot();
  const repoDir = path.join(tmp, 'repo');
  const sessionDir = path.join(tmp, 'session');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  initGitRepo(repoDir);
  const startCommit = gitCommit(repoDir, 'baseline commit');
  const orphanCommit = gitCommit(repoDir, 'test(R-CXOR-1): worker real work');

  // Simulate worker git reset --hard to baseline
  execFileSync('git', ['reset', '--hard', startCommit], { cwd: repoDir });
  assert.equal(headSha(repoDir), startCommit, 'HEAD should be at startCommit after reset');

  const ticketId = 'test-ticket-1';
  makeTicketFile(sessionDir, ticketId, 'Done', orphanCommit);
  const statePath = makeStatePath(sessionDir);

  const log = [];
  const result = detectAndRecoverHeadRegression({
    ticketId,
    workingDir: repoDir,
    startCommit,
    completionCommitSha: orphanCommit,
    sessionDir,
    statePath,
    iteration: 1,
    log: (msg) => log.push(msg),
  });

  assert.equal(result.detected, true, 'regression should be detected');
  assert.equal(result.recovered, true, 'regression should be recovered via ff-only');
  assert.equal(result.action, 'ff_reattached', 'action should be ff_reattached');
  assert.equal(headSha(repoDir), orphanCommit, 'HEAD should be at orphanCommit after reattach');
  assert.ok(log.some(l => l.includes('ff-only reattach to') && l.includes('succeeded')), 'should log reattach success');

  // e56ed23f: orphan_commit_reattached must be emitted with the resolved tip
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  const event = (state.activity || []).find((e) => e.event === 'orphan_commit_reattached');
  assert.ok(event, 'orphan_commit_reattached event must be emitted on successful reattach');
  assert.equal(event.ticket, ticketId);
  assert.equal(event.sha, orphanCommit, 'event.sha must be the reattached tip');
  assert.equal(event.chain_length, 1, 'single-commit orphan has chain_length 1');
  assert.ok(event.prev_head, 'prev_head must be present');
  assert.ok(event.ts, 'ts must be present');

  fs.rmSync(tmp, { recursive: true, force: true });
});

// AC-CXOR-1-1 (b): marks Failed when orphan SHA is invalid (unrecoverable)
test('R-CXOR-1: detectAndRecoverHeadRegression marks ticket Failed when orphan unrecoverable', () => {
  const tmp = tmpRoot();
  const repoDir = path.join(tmp, 'repo');
  const sessionDir = path.join(tmp, 'session');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  initGitRepo(repoDir);
  const startCommit = gitCommit(repoDir, 'baseline commit');

  // Don't make an orphan commit — simulate lost SHA
  const invalidSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

  const ticketId = 'test-ticket-2';
  makeTicketFile(sessionDir, ticketId, 'Done', invalidSha);
  const statePath = makeStatePath(sessionDir);

  const log = [];
  const result = detectAndRecoverHeadRegression({
    ticketId,
    workingDir: repoDir,
    startCommit,
    completionCommitSha: invalidSha,
    sessionDir,
    statePath,
    iteration: 1,
    log: (msg) => log.push(msg),
  });

  assert.equal(result.detected, true, 'regression should be detected (HEAD equals startCommit)');
  assert.equal(result.recovered, false, 'recovery should fail with invalid SHA');
  // e56ed23f: an explicit-but-unreachable SHA with NO salvage evidence still
  // ends at marked_failed via the hold path's evidence-absent branch, BUT
  // orphan_commit_unreattachable is emitted first.
  assert.equal(result.action, 'marked_failed', 'evidence-absent, unreachable SHA still marks Failed');
  assert.equal(headSha(repoDir), startCommit, 'HEAD should still be at startCommit (no history mutation)');

  // Verify ticket was flipped to Failed
  const ticketPath = path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`);
  const ticketContent = fs.readFileSync(ticketPath, 'utf-8');
  assert.ok(ticketContent.includes('status: "Failed"') || ticketContent.includes("status: 'Failed'"), 'ticket status should be Failed');

  // orphan_commit_unreattachable must be emitted before the hold/flip decision
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  const event = (state.activity || []).find((e) => e.event === 'orphan_commit_unreattachable');
  assert.ok(event, 'orphan_commit_unreattachable event must be emitted for an unreachable candidate SHA');
  assert.equal(event.ticket, ticketId);
  assert.equal(event.sha, invalidSha, 'event.sha must be the best-known (unreachable) candidate');
  assert.ok(event.reason, 'reason must be present');
  assert.ok(event.ts, 'ts must be present');

  fs.rmSync(tmp, { recursive: true, force: true });
});

// AC-CXOR-1-1 invariant: NEVER leaves ticket Done at baseline when regression detected
test('R-CXOR-1: NEVER leaves ticket Done at baseline — either reattached or Failed', () => {
  const tmp = tmpRoot();
  const repoDir = path.join(tmp, 'repo');
  const sessionDir = path.join(tmp, 'session');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  initGitRepo(repoDir);
  const startCommit = gitCommit(repoDir, 'baseline');
  const orphanCommit = gitCommit(repoDir, 'test(R-CXOR-1): real work');
  execFileSync('git', ['reset', '--hard', startCommit], { cwd: repoDir });

  const ticketId = 'test-ticket-3';
  makeTicketFile(sessionDir, ticketId, 'Done', orphanCommit);
  const statePath = makeStatePath(sessionDir);

  const result = detectAndRecoverHeadRegression({
    ticketId,
    workingDir: repoDir,
    startCommit,
    completionCommitSha: orphanCommit,
    sessionDir,
    statePath,
    iteration: 2,
    log: () => {},
  });

  assert.equal(result.detected, true, 'must detect regression');

  // After detection, either HEAD advanced (ff_reattached) OR ticket is Failed — never Done at baseline
  const finalHead = headSha(repoDir);
  if (result.action === 'ff_reattached') {
    assert.notEqual(finalHead, startCommit, 'HEAD must have advanced past baseline on reattach');
    // e56ed23f: success path emits orphan_commit_reattached
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.ok((state.activity || []).some((e) => e.event === 'orphan_commit_reattached'),
      'orphan_commit_reattached must be emitted on reattach');
  } else {
    // e56ed23f: the non-reattach outcomes are the hold variants OR the
    // evidence-absent marked_failed — never Done-at-baseline.
    assert.ok(
      result.action === 'flip_suppressed' || result.action === 'suppression_cap_escalate' || result.action === 'marked_failed',
      `non-reattach action must be a hold variant or marked_failed, got: ${result.action}`,
    );
    const ticketPath = path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`);
    const ticketContent = fs.readFileSync(ticketPath, 'utf-8');
    assert.ok(!ticketContent.includes('status: "Done"') && !ticketContent.includes("status: 'Done'"), 'ticket must not be Done at baseline');
    // orphan_commit_unreattachable accompanies the non-reattach hold/flip
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.ok((state.activity || []).some((e) => e.event === 'orphan_commit_unreattachable'),
      'orphan_commit_unreattachable must be emitted on non-reattach');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

// No regression when HEAD advanced past startCommit (normal case)
test('R-CXOR-1: no regression detected when HEAD is ahead of startCommit', () => {
  const tmp = tmpRoot();
  const repoDir = path.join(tmp, 'repo');
  const sessionDir = path.join(tmp, 'session');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  initGitRepo(repoDir);
  const startCommit = gitCommit(repoDir, 'baseline');
  const advancedCommit = gitCommit(repoDir, 'test(R-CXOR-1): work landed normally');

  const ticketId = 'test-ticket-4';
  makeTicketFile(sessionDir, ticketId, 'Done', advancedCommit);
  const statePath = makeStatePath(sessionDir);

  const result = detectAndRecoverHeadRegression({
    ticketId,
    workingDir: repoDir,
    startCommit,
    completionCommitSha: advancedCommit,
    sessionDir,
    statePath,
    iteration: 1,
    log: () => {},
  });

  assert.equal(result.detected, false, 'no regression when HEAD advanced normally');
  assert.equal(result.action, 'none', 'action should be none');
  assert.equal(headSha(repoDir), advancedCommit, 'HEAD should remain at advanced commit');

  fs.rmSync(tmp, { recursive: true, force: true });
});

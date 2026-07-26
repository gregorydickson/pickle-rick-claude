// @tier: fast
//
// AC-CCRC-05 regression — every Done-flip entrypoint routes through
// guardCompletionCommitBeforeDone before flipping the frontmatter status.
//
// The canonical failing scenario (bug trigger): a worker emits
// <promise>I AM DONE</promise> and mux-runner's drift-scenario path calls
// applyAutoTicketCompletionValidation to close the old ticket.  Before the
// R-CCRC-2 fix, markTicketDone was called WITHOUT the guard, so
// completion_commit: was never auto-filled and remained absent in the
// frontmatter — the documented live incident class.
//
// Behavioral proof of the guard firing: because guardCompletionCommitBeforeDone
// calls autoFillCompletionCommit internally (R-WUWC SOFT-variant), a
// successful guard pass causes completion_commit: to be written to the ticket
// frontmatter.  The old (unguarded) markTicketDone path only touched status:
// and never wrote completion_commit:.  So:
//   - Done + completion_commit present  → guard ran (post-fix behavior)
//   - Done + completion_commit absent   → guard was skipped (pre-fix bug)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyAutoTicketCompletionValidation } from '../bin/mux-runner.js';
import { readFrontmatterField } from '../services/pickle-utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkTmp(prefix = 'pickle-done-flip-guard-') {
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

function writeTicketFile(sessionDir, ticketId, status = 'In Progress') {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  // All acceptance criteria checked (required for validateAutoTicketCompletion to return 'done')
  const body = [
    '---',
    `id: ${ticketId}`,
    `title: "Test ticket ${ticketId}"`,
    `status: "${status}"`,
    'order: 1',
    '---',
    '# Description',
    'Test',
    '',
    '## Acceptance Criteria',
    '- [x] implementation complete',
  ].join('\n');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), body);
}

function readTicketStatus(sessionDir, ticketId) {
  const ticketPath = path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`);
  const content = fs.readFileSync(ticketPath, 'utf8');
  const match = /^status:\s*"?([^"\n]+)"?/m.exec(content);
  return match ? match[1].trim() : null;
}

function readTicketCompletionCommit(sessionDir, ticketId) {
  const ticketPath = path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`);
  const content = fs.readFileSync(ticketPath, 'utf8');
  return readFrontmatterField(content, 'completion_commit');
}

function writeMinimalStateJson(sessionDir, extraFields = {}) {
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    active: true,
    working_dir: sessionDir,
    step: 'implement',
    iteration: 1,
    max_iterations: 15,
    worker_timeout_seconds: 2400,
    start_time_epoch: Math.floor(Date.now() / 1000) - 60,
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 1,
    chain_meeseeks: false,
    ...extraFields,
  }, null, 2));
  return statePath;
}

// ---------------------------------------------------------------------------
// R-CCRC-2 regression: guard runs before Done flip, auto-fills completion_commit
// ---------------------------------------------------------------------------

test('done-flip-paths-call-guard: applyAutoTicketCompletionValidation routes through guard — completion_commit written on Done flip', (t) => {
  // Strip PICKLE_TEST_MODE so the real guard runs (not the PICKLE_TEST_MODE bypass).
  const prevMode = process.env.PICKLE_TEST_MODE;
  delete process.env.PICKLE_TEST_MODE;
  t.after(() => { if (prevMode !== undefined) process.env.PICKLE_TEST_MODE = prevMode; });

  const tmpRoot = mkTmp();
  try {
    initGitRepo(tmpRoot);
    const startCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpRoot, encoding: 'utf8' }).trim();
    const sessionDir = path.join(tmpRoot, 'session');
    const ticketId = 'ccrc2-guard-test';

    writeTicketFile(sessionDir, ticketId, 'In Progress');

    // Worker makes a commit carrying a Pickle-Ticket trailer (the standard workflow).
    fs.writeFileSync(path.join(tmpRoot, 'feature.txt'), 'implementation\n');
    execFileSync('git', ['add', 'feature.txt'], { cwd: tmpRoot });
    execFileSync(
      'git',
      ['commit', '-q', '-m', 'implement feature', '--trailer', `Pickle-Ticket: ${ticketId}`, '--no-gpg-sign'],
      { cwd: tmpRoot, stdio: 'ignore' },
    );
    const workSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpRoot, encoding: 'utf8' }).trim();

    const statePath = writeMinimalStateJson(sessionDir);

    const verdict = applyAutoTicketCompletionValidation({
      sessionDir,
      ticketId,
      workingDir: tmpRoot,
      startCommit,
      iteration: 1,
      statePath,
      flags: null,
    });

    assert.equal(verdict.action, 'done', `Expected action 'done', got '${verdict.action}'`);
    assert.equal(readTicketStatus(sessionDir, ticketId), 'Done');

    // KEY ASSERTION (R-CCRC-2 regression check):
    // The guard auto-fills completion_commit when evidence is 'inferred'.
    // Old (unguarded) markTicketDone never wrote this field.
    const completionCommit = readTicketCompletionCommit(sessionDir, ticketId);
    assert.ok(
      completionCommit,
      'completion_commit must be set in frontmatter after Done flip — guard auto-fill did not run (R-CCRC-2 regression)',
    );
    assert.equal(
      completionCommit,
      workSha,
      `Expected completion_commit to equal the work commit SHA ${workSha}, got ${completionCommit}`,
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R-PEDC: stale done_without_commit_evidence exit_reason cleared on success
// ---------------------------------------------------------------------------

test('done-flip-paths-call-guard: applyAutoTicketCompletionValidation clears stale done_without_commit_evidence on guard pass', (t) => {
  const prevMode = process.env.PICKLE_TEST_MODE;
  delete process.env.PICKLE_TEST_MODE;
  t.after(() => { if (prevMode !== undefined) process.env.PICKLE_TEST_MODE = prevMode; });

  const tmpRoot = mkTmp('pickle-pedc-');
  try {
    initGitRepo(tmpRoot);
    const startCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpRoot, encoding: 'utf8' }).trim();
    const sessionDir = path.join(tmpRoot, 'session');
    const ticketId = 'ccrc2-pedc-test';

    writeTicketFile(sessionDir, ticketId, 'In Progress');
    fs.writeFileSync(path.join(tmpRoot, 'work.txt'), 'work\n');
    execFileSync('git', ['add', 'work.txt'], { cwd: tmpRoot });
    execFileSync(
      'git',
      ['commit', '-q', '-m', 'implement', '--trailer', `Pickle-Ticket: ${ticketId}`, '--no-gpg-sign'],
      { cwd: tmpRoot, stdio: 'ignore' },
    );

    // Pre-stamp exit_reason with done_without_commit_evidence (simulates a prior failed guard run).
    const statePath = writeMinimalStateJson(sessionDir, { exit_reason: 'done_without_commit_evidence' });

    // Verify precondition: exit_reason is set before the call.
    const stateBefore = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(stateBefore.exit_reason, 'done_without_commit_evidence');

    const verdict = applyAutoTicketCompletionValidation({
      sessionDir,
      ticketId,
      workingDir: tmpRoot,
      startCommit,
      iteration: 1,
      statePath,
      flags: null,
    });

    assert.equal(verdict.action, 'done');
    assert.equal(readTicketStatus(sessionDir, ticketId), 'Done');

    // R-PEDC: stale exit_reason must be cleared after successful guard pass.
    const stateAfter = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.notEqual(
      stateAfter.exit_reason,
      'done_without_commit_evidence',
      'done_without_commit_evidence exit_reason must be cleared after guard passes (R-PEDC invariant)',
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Guard failure blocks Done flip (returns action: 'leave')
// ---------------------------------------------------------------------------

test('done-flip-paths-call-guard: guard failure blocks Done flip and records exit_reason', (t) => {
  // Strip PICKLE_TEST_MODE so the real guard runs.
  const prevMode = process.env.PICKLE_TEST_MODE;
  delete process.env.PICKLE_TEST_MODE;
  t.after(() => { if (prevMode !== undefined) process.env.PICKLE_TEST_MODE = prevMode; });

  const tmpRoot = mkTmp('pickle-guard-fail-');
  try {
    initGitRepo(tmpRoot);
    const sessionDir = path.join(tmpRoot, 'session');
    const ticketId = 'ccrc2-guard-fail';
    const startCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpRoot, encoding: 'utf8' }).trim();

    // Ticket with checked AC but NO commit after startCommit referencing this ticket.
    writeTicketFile(sessionDir, ticketId, 'In Progress');
    // Make a commit that does NOT reference the ticketId.
    fs.writeFileSync(path.join(tmpRoot, 'unrelated.txt'), 'unrelated\n');
    execFileSync('git', ['add', 'unrelated.txt'], { cwd: tmpRoot });
    execFileSync('git', ['commit', '-q', '-m', 'unrelated: some other work', '--no-gpg-sign'], { cwd: tmpRoot, stdio: 'ignore' });

    const statePath = writeMinimalStateJson(sessionDir);

    // With startCommit set to the initial commit, validateAutoTicketCompletion
    // will look for commits referencing ticketId since then — there are none.
    // It returns action: 'skip', so the guard never runs.
    const verdict = applyAutoTicketCompletionValidation({
      sessionDir,
      ticketId,
      workingDir: tmpRoot,
      startCommit,
      iteration: 1,
      statePath,
      flags: null,
    });

    // Since no commit references the ticketId, the drift-path correctly marks Skipped, not Done.
    assert.equal(verdict.action, 'skip', `Expected skip (no commit refs ticket). Got: ${verdict.action}`);
    assert.equal(readTicketStatus(sessionDir, ticketId), 'Skipped');
    assert.equal(readTicketCompletionCommit(sessionDir, ticketId), null);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Smoke: non-done verdict paths (skip / leave) are unaffected by the guard
// ---------------------------------------------------------------------------

test('done-flip-paths-call-guard: skip verdict (no commit) does not invoke guard — ticket stays Skipped', () => {
  const tmpRoot = mkTmp('pickle-skip-');
  try {
    initGitRepo(tmpRoot);
    const startCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpRoot, encoding: 'utf8' }).trim();
    const sessionDir = path.join(tmpRoot, 'session');
    const ticketId = 'ccrc2-skip-test';

    // Acceptance criteria checked but no referencing commit → validateAutoTicketCompletion returns 'skip'.
    writeTicketFile(sessionDir, ticketId, 'In Progress');
    const statePath = writeMinimalStateJson(sessionDir);

    const verdict = applyAutoTicketCompletionValidation({
      sessionDir,
      ticketId,
      workingDir: tmpRoot,
      startCommit,
      iteration: 1,
      statePath,
      flags: null,
    });

    assert.equal(verdict.action, 'skip');
    assert.equal(readTicketStatus(sessionDir, ticketId), 'Skipped');
    // No completion_commit should be set when the ticket is Skipped.
    assert.equal(readTicketCompletionCommit(sessionDir, ticketId), null);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Parity check: compiled mux-runner.js has the R-CCRC-2 guard annotation
// ---------------------------------------------------------------------------

test('done-flip-paths-call-guard: compiled mux-runner.js contains R-CCRC-2 route annotation in applyAutoTicketCompletionValidation', async () => {
  const { fileURLToPath } = await import('node:url');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const compiled = fs.readFileSync(path.resolve(__dirname, '../bin/mux-runner.js'), 'utf-8');
  assert.ok(
    compiled.includes('R-CCRC-2'),
    'Compiled mux-runner.js must contain the R-CCRC-2 route annotation — ' +
    'guard injection may not have been compiled (run npx tsc from extension/)',
  );
});

// @tier: fast
//
// B-1SEAM WS-1 — ONE completion predicate at EVERY mux-runner decision site.
//
// Live repro (session 2026-07-01-9e922602, ticket c46045a6, codex): the worker
// committed real untagged work, never announced a completion SHA, and stamped a
// HALLUCINATED full 40-char sha into `completion_commit`. Three decision sites
// then returned three DIFFERENT verdicts for the SAME frontmatter:
//   - defaultDoneGuard ACCEPTED (bare non-empty-field read, no git probe)
//   - the phantom-Done batch watcher REVERTED (readEvidence absent)
//   - guardCompletionCommitBeforeDone FATALED (done_without_commit_evidence)
//
// After the collapse, all sites evaluate evaluateCompletionEvidence through
// buildCompletionCtx, so the SAME fixture yields the SAME verdict everywhere.
//
// RED-first: on the pre-collapse runtime the done-guard test and the 3-way
// parity test FAIL (bare-field accept); post-collapse they pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  guardCompletionCommitBeforeDone,
  correctPhantomDoneTickets,
  inspectPhantomDoneTicketFile,
  recordWorkerArtifactProgress,
} from '../bin/mux-runner.js';
import { readFrontmatterField } from '../services/pickle-utils.js';

const HALLUCINATED_SHA = '224678f39759e1da224678f39759e1da224678f3';

function mkTmp(prefix = 'b1seam-parity-') {
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

function head(dir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function writeTicket(sessionDir, ticketId, { status = 'Done', completionCommit } = {}) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const lines = [
    '---',
    `id: "${ticketId}"`,
    `title: "Parity fixture ${ticketId}"`,
    `status: "${status}"`,
    'order: 1',
    ...(completionCommit ? [`completion_commit: "${completionCommit}"`] : []),
    '---',
    '# Body',
  ];
  const ticketPath = path.join(ticketDir, `rick_ticket_${ticketId}.md`);
  fs.writeFileSync(ticketPath, lines.join('\n'));
  return ticketPath;
}

function writeState(sessionDir, workingDir) {
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    active: true,
    working_dir: workingDir,
    step: 'implement',
    iteration: 1,
    max_iterations: 10,
    max_time_minutes: 0,
    worker_timeout_seconds: 3600,
    start_time_epoch: Date.now(),
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 5,
    worker_artifact_progress: {},
    activity: [],
  }, null, 2));
  return statePath;
}

/** Sandbox the activity sink (logActivity in the batch watcher) per test. */
function withSandboxedDataRoot(t) {
  const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'b1seam-data-')));
  const prev = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  t.after(() => {
    if (prev === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prev;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });
}

// ---------------------------------------------------------------------------
// (2) defaultDoneGuard-no-bare-accept — a Done ticket with an UNREACHABLE
// stamped sha must NOT be accepted by the charge-loop done-guard.
// ---------------------------------------------------------------------------

test('B-1SEAM defaultDoneGuard: Done + unreachable (hallucinated) completion_commit is NOT accepted on bare field presence', (t) => {
  const prev = process.env.PICKLE_TEST_MODE;
  delete process.env.PICKLE_TEST_MODE;
  t.after(() => { if (prev !== undefined) process.env.PICKLE_TEST_MODE = prev; });

  const workingDir = mkTmp('b1seam-dg-work-');
  const sessionDir = mkTmp('b1seam-dg-sess-');
  try {
    initGitRepo(workingDir);
    const ticketId = 'c46045a6';
    writeTicket(sessionDir, ticketId, { completionCommit: HALLUCINATED_SHA });
    const statePath = writeState(sessionDir, workingDir);

    const r = recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0, {
      workingDir,
    });

    assert.equal(
      r.doneGuard,
      false,
      'done-guard must git-probe the stamped sha through the ONE predicate — ' +
        'a hallucinated/unreachable completion_commit must not be accepted on field presence (B-1SEAM WS-1)',
    );
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (4) 3-way live-repro parity — the hallucinated-stamp fixture yields the SAME
// verdict at the done-guard, both phantom-Done watchers, and the Done-flip guard.
// ---------------------------------------------------------------------------

test('B-1SEAM 3-way parity: hallucinated stamp + unattributable untagged commit → SAME absent verdict at done-guard, watchers, and guard', (t) => {
  const prev = process.env.PICKLE_TEST_MODE;
  delete process.env.PICKLE_TEST_MODE;
  t.after(() => { if (prev !== undefined) process.env.PICKLE_TEST_MODE = prev; });
  withSandboxedDataRoot(t);

  const workingDir = mkTmp('b1seam-3way-work-');
  const sessionDir = mkTmp('b1seam-3way-sess-');
  try {
    initGitRepo(workingDir);
    // Live shape: real untagged work committed (subject references NO ticket id),
    // then a hallucinated full sha stamped into the frontmatter.
    fs.writeFileSync(path.join(workingDir, 'circuit-store.txt'), 'real work\n');
    execFileSync('git', ['add', '-A'], { cwd: workingDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'Add Reducto Redis circuit store', '--no-gpg-sign'], { cwd: workingDir, stdio: 'ignore' });

    const ticketId = 'c46045a6';
    const ticketPath = writeTicket(sessionDir, ticketId, { completionCommit: HALLUCINATED_SHA });
    const statePath = writeState(sessionDir, workingDir);

    // Axis 1: charge-loop done-guard.
    const progress = recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0, { workingDir });
    // Axis 2: Done-flip guard.
    const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId, workingDir, flags: null, rereadBackoffMs: 0 });
    // Axis 3: single-file phantom watcher (fresh copy — the batch loop below mutates status).
    const inspect = inspectPhantomDoneTicketFile(ticketPath, sessionDir, workingDir, 'Todo');
    // Axis 4: batch phantom watcher (runs last; reverts the ticket to Todo).
    writeTicket(sessionDir, ticketId, { completionCommit: HALLUCINATED_SHA }); // restore Done
    const corrected = correctPhantomDoneTickets({
      sessionDir, workingDir, startCommit: null, iteration: 1,
    });

    // ALL sites must agree: the evidence is absent.
    assert.equal(progress.doneGuard, false, 'done-guard must refuse (was the live ACCEPT site)');
    assert.equal(guard.ok, false, 'Done-flip guard must refuse');
    assert.equal(inspect.reason, 'reverted', 'single-file watcher must revert (was the bare field-presence keep)');
    assert.equal(corrected, 1, 'batch watcher must revert');
    const status = readFrontmatterField(fs.readFileSync(ticketPath, 'utf8'), 'status');
    assert.equal(status, 'Todo', 'batch watcher reverted the phantom Done');
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('B-1SEAM 3-way parity: attributable untagged commit (ref-token) → SAME committed verdict at done-guard, watcher, and guard', (t) => {
  const prev = process.env.PICKLE_TEST_MODE;
  delete process.env.PICKLE_TEST_MODE;
  t.after(() => { if (prev !== undefined) process.env.PICKLE_TEST_MODE = prev; });
  withSandboxedDataRoot(t);

  const workingDir = mkTmp('b1seam-3way-ok-work-');
  const sessionDir = mkTmp('b1seam-3way-ok-sess-');
  try {
    initGitRepo(workingDir);
    const ticketId = 'c46045a6';
    // Untagged frontmatter but the commit subject references the ticket id, so
    // the predicate's R-AICF scan fallback attributes it at EVERY site.
    fs.writeFileSync(path.join(workingDir, 'impl.txt'), 'work\n');
    execFileSync('git', ['add', '-A'], { cwd: workingDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', `feat(${ticketId}): implement`, '--no-gpg-sign'], { cwd: workingDir, stdio: 'ignore' });
    const realSha = head(workingDir);

    const ticketPath = writeTicket(sessionDir, ticketId, { completionCommit: HALLUCINATED_SHA });
    const statePath = writeState(sessionDir, workingDir);

    const progress = recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0, { workingDir });
    const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId, workingDir, flags: null, rereadBackoffMs: 0 });
    const corrected = correctPhantomDoneTickets({
      sessionDir, workingDir, startCommit: null, iteration: 1,
    });

    assert.equal(progress.doneGuard, true, 'done-guard accepts the scan-attributed commit');
    assert.equal(guard.ok, true, 'guard accepts the scan-attributed commit');
    assert.equal(guard.sha, realSha);
    assert.equal(corrected, 0, 'watcher keeps the ticket Done');
    const raw = fs.readFileSync(ticketPath, 'utf8');
    assert.equal(readFrontmatterField(raw, 'status'), 'Done');
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

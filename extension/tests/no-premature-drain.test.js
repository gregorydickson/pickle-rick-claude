// @tier: integration
// B-DURA T50 (AC-DURA-7) — the pickle phase MUST NOT drain its queue prematurely.
// It MUST NOT exit while any non-`Failed` ticket is Todo / In Progress (real,
// unattempted work) and the iteration budget is unspent; it advances ONLY when
// every ticket is terminal (Done | Skipped | Failed). Grounded in the same
// processTaskCompleted / evaluateEpicCompletion / finalizeIfTrulyComplete seam T40
// governs — no parallel phase-exit logic. R-CECX run-3 (LOA-1488): codex drained
// the pickle phase at iter 49/500 with 4 Todo tickets never attempted → 0/4.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { processCompletionBranch } from '../bin/mux-runner.js';

function makeTmp(prefix = 'dura-t50-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'initial', '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
}

function head(dir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function writeTicket(sessionDir, ticketId, status, completionCommit, declaredFile) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const lines = ['---', `id: "${ticketId}"`, `title: "Test ${ticketId}"`, `status: "${status}"`, 'order: 1'];
  if (completionCommit) lines.push(`completion_commit: "${completionCommit}"`);
  lines.push('---', '# Description');
  if (declaredFile) lines.push('## Files to modify', `- \`${declaredFile}\``);
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`), lines.join('\n'));
}

function withDataRoot(dataRoot, fn) {
  const prev = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.PICKLE_DATA_ROOT; else process.env.PICKLE_DATA_ROOT = prev;
  }
}

function writeState(statePath, sessionDir, workingDir, currentTicket, startCommit) {
  fs.writeFileSync(statePath, JSON.stringify({
    active: true, step: 'implement', iteration: 1, max_iterations: 500,
    worker_timeout_seconds: 3600, start_time_epoch: Math.floor(Date.now() / 1000),
    max_time_minutes: 0, current_ticket: currentTicket, working_dir: workingDir,
    start_commit: startCommit, backend: 'claude', schema_version: 3,
  }, null, 2));
}

function makeCtx(sessionDir, statePath) {
  return {
    sessionDir,
    statePath,
    extensionRoot: path.resolve(import.meta.dirname, '../'),
    iteration: 1,
    log: () => {},
    cbEnabled: false,
    cbState: null,
  };
}

const cleanup = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };

test('AC-DURA-7 keep-draining: current ticket Done but an unattempted Todo remains + budget unspent → phase does NOT exit (continue)', async () => {
  const workingDir = makeTmp('dura-t50-keep-');
  initGitRepo(workingDir);
  const sessionDir = workingDir; // session data inside the repo (self-build shape)
  const dataRoot = makeTmp('dura-t50-keep-data-');
  try {
    const startCommit = head(workingDir);
    writeTicket(sessionDir, 'aaaa0001', 'Done', startCommit ? 'abc1234' : 'abc1234');
    // Give the Done ticket a real reachable completion_commit so the guard passes.
    const real = head(workingDir);
    writeTicket(sessionDir, 'aaaa0001', 'Done', real);
    // An unattempted hardening ticket still Todo.
    writeTicket(sessionDir, 'bbbb0002', 'Todo');
    const statePath = path.join(sessionDir, 'state.json');
    writeState(statePath, sessionDir, workingDir, 'aaaa0001', startCommit);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

    let action;
    await withDataRoot(dataRoot, async () => {
      action = await processCompletionBranch(state, 'task_completed', makeCtx(sessionDir, statePath));
    });
    // A remaining unattempted Todo must keep the phase draining — never break/success.
    assert.equal(action.kind, 'continue', `expected continue (keep draining), got ${action.kind}/${action.reason}`);
  } finally {
    cleanup(workingDir, dataRoot);
  }
});

test('AC-DURA-7 advance-on-all-terminal: every ticket Done/Failed → phase advances (break success)', async () => {
  const workingDir = makeTmp('dura-t50-adv-');
  initGitRepo(workingDir);
  // sessionDir OUTSIDE the working repo so writing tickets/state does not dirty the
  // tree under test (the Failed ticket's conjunctive guard requires a clean tree).
  const sessionDir = makeTmp('dura-t50-adv-sess-');
  const dataRoot = makeTmp('dura-t50-adv-data-');
  try {
    const startCommit = head(workingDir);
    // Land a real (non-baseline) commit so the current ticket's completion_commit is
    // genuine work evidence (R-CXOR-2 rejects a completion_commit === start_commit).
    fs.writeFileSync(path.join(workingDir, 'work.txt'), 'real work\n');
    execFileSync('git', ['add', '-A'], { cwd: workingDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'feat: aaaa0001', '--no-gpg-sign'], { cwd: workingDir, stdio: 'ignore' });
    const realCommit = head(workingDir);
    writeTicket(sessionDir, 'aaaa0001', 'Done', realCommit);
    // A second ticket already Failed (terminal-for-advance — does NOT force a re-drain).
    // It declares a file the real commit did NOT touch → its start_commit..HEAD
    // declared-file window is empty + tree clean → terminal-excludable.
    writeTicket(sessionDir, 'bbbb0002', 'Failed', undefined, 'extension/src/untouched.ts');
    const statePath = path.join(sessionDir, 'state.json');
    writeState(statePath, sessionDir, workingDir, 'aaaa0001', startCommit);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

    let action;
    await withDataRoot(dataRoot, async () => {
      action = await processCompletionBranch(state, 'task_completed', makeCtx(sessionDir, statePath));
    });
    // Every ticket is terminal (Done + Failed) → the phase advances.
    assert.equal(action.kind, 'break', `expected break (advance), got ${action.kind}`);
    assert.equal(action.reason, 'success', `expected reason=success, got ${action.reason}`);
  } finally {
    cleanup(workingDir, sessionDir, dataRoot);
  }
});

test('AC-DURA-7 source pin: no-premature-drain guard keeps draining ONLY on Todo/In-Progress (Failed is terminal-for-advance)', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../src/bin/mux-runner.ts'), 'utf8');
  const idx = src.indexOf('no-premature-drain: ${nonFailedPending.length}');
  assert.ok(idx >= 0, 'the no-premature-drain log line must be present in processTaskCompleted');
  // The drain predicate excludes done, skipped AND failed (only Todo/In-Progress drain).
  assert.ok(src.includes("n !== 'done' && n !== 'skipped' && n !== 'failed'"),
    'keep-draining predicate must treat Failed as terminal-for-advance (Done|Skipped|Failed all terminal)');
  // Grounded in the same evaluateEpicCompletion/finalize seam (no parallel exit logic).
  assert.ok(src.includes('evaluateEpicCompletion('), 'phase-exit must derive from evaluateEpicCompletion');
});

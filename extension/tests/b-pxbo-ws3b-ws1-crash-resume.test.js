// @tier: integration
//
// B-PXBO WS-3-FacetB + WS-1 regression tests.
//
// WS-3-FacetB (R-CRSR): a crash-resume relaunch must (a) skip an already-Done
// large-tier ticket whose completion is durably committed instead of re-selecting
// it (AC-CRSR-3: never flip Done->Failed), and (b) reset the per-PROCESS ticket
// budget baseline so an inherited spent current_ticket_budget_start_iteration does
// not instantly trip the cap-check.
//
// WS-1 (R-DPGT): the shared oracle-recheck helper (isTicketOracleCommitted) is the
// committed-vs-absent wrapper both WS-3-FacetB and pipeline-runner's
// reportPhaseIncomplete consume. AC-DPGT-3: no new state field; reuse readEvidence.
//
// R-PTSB: every session-writing helper invocation sandboxes PICKLE_DATA_ROOT.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolvePreTicket,
  isTicketOracleCommitted,
  applyTicketTierBudget,
  _resetTicketBudgetProcessBaseline,
} from '../bin/mux-runner.js';

function mkTmp(prefix = 'pickle-pxbo-') {
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

function commitTicketWork(gitDir, ticketId) {
  fs.writeFileSync(path.join(gitDir, `${ticketId}.txt`), 'work\n');
  execFileSync('git', ['add', `${ticketId}.txt`], { cwd: gitDir });
  execFileSync('git', ['commit', '-q', '-m', `fix(${ticketId}): durable work`, '--no-gpg-sign'],
    { cwd: gitDir, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gitDir, encoding: 'utf8' }).trim();
}

function writeTicket(sessionDir, ticketId, { status, order = 1, completionCommit = null }) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const lines = [
    '---',
    `id: ${ticketId}`,
    `title: "${ticketId} fixture"`,
    `status: ${status}`,
    `order: ${order}`,
  ];
  if (completionCommit) lines.push(`completion_commit: ${completionCommit}`);
  lines.push('---', '# Description', 'fixture');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), lines.join('\n'));
}

function withDataRoot(fn) {
  const dataRoot = mkTmp('pickle-dataroot-');
  const prev = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    return fn(dataRoot);
  } finally {
    if (prev === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prev;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

// ── WS-3-FacetB AC-CRSR-3: resumed Done-with-durable-commit ticket is skipped ──

test('WS-3-FacetB: resolvePreTicket re-routes past a Done ticket with durable commit', () => {
  withDataRoot(() => {
    const repo = mkTmp('pxbo-repo-');
    const session = mkTmp('pxbo-session-');
    try {
      initGitRepo(repo);
      const sha = commitTicketWork(repo, 'done0001');
      // Resumed current_ticket: Done with a durable (git-reachable) completion_commit.
      writeTicket(session, 'done0001', { status: 'Done', order: 1, completionCommit: sha });
      // A genuinely-pending next ticket.
      writeTicket(session, 'todo0002', { status: 'Todo', order: 2 });

      // With workingDir supplied, the Done-with-durable-commit current_ticket must NOT
      // be returned — re-route to the next pending ticket (AC-CRSR-3 precondition: it
      // never reaches the per-ticket cap-check that could flip Done->Failed).
      const resolved = resolvePreTicket(session, 'done0001', repo);
      assert.equal(resolved, 'todo0002',
        'resumed Done-with-durable-commit current_ticket must re-route to the next pending ticket');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(session, { recursive: true, force: true });
    }
  });
});

test('WS-3-FacetB: resolvePreTicket still HONORS a Done closer ticket WITHOUT committed evidence', () => {
  withDataRoot(() => {
    const repo = mkTmp('pxbo-repo2-');
    const session = mkTmp('pxbo-session2-');
    try {
      initGitRepo(repo);
      // Done ticket, NO completion_commit and no commit referencing it → oracle absent.
      // This is the manager-handoff residual path the legacy comment preserves.
      writeTicket(session, 'closer01', { status: 'Done', order: 1 });
      const resolved = resolvePreTicket(session, 'closer01', repo);
      assert.equal(resolved, 'closer01',
        'a Done ticket WITHOUT committed evidence must still be honored (closer-handoff path)');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(session, { recursive: true, force: true });
    }
  });
});

test('WS-3-FacetB: without workingDir resolvePreTicket preserves legacy honored-current_ticket behavior', () => {
  withDataRoot(() => {
    const repo = mkTmp('pxbo-repo3-');
    const session = mkTmp('pxbo-session3-');
    try {
      initGitRepo(repo);
      const sha = commitTicketWork(repo, 'done0003');
      writeTicket(session, 'done0003', { status: 'Done', order: 1, completionCommit: sha });
      writeTicket(session, 'todo0004', { status: 'Todo', order: 2 });
      // No workingDir → no oracle probe → legacy behavior: honor the set current_ticket.
      const resolved = resolvePreTicket(session, 'done0003');
      assert.equal(resolved, 'done0003',
        'absent workingDir must preserve the legacy honored-current_ticket path');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(session, { recursive: true, force: true });
    }
  });
});

// ── Shared oracle-recheck helper (WS-3-FacetB + WS-1) ──

test('shared helper: isTicketOracleCommitted is committed for a durable commit, absent otherwise', () => {
  withDataRoot(() => {
    const repo = mkTmp('pxbo-orc-repo-');
    const session = mkTmp('pxbo-orc-session-');
    try {
      initGitRepo(repo);
      const sha = commitTicketWork(repo, 'committed1');
      writeTicket(session, 'committed1', { status: 'Done', order: 1, completionCommit: sha });
      writeTicket(session, 'absent0002', { status: 'Todo', order: 2 });

      assert.equal(
        isTicketOracleCommitted({ sessionDir: session, ticketId: 'committed1', workingDir: repo }),
        true,
        'a ticket with a git-reachable completion_commit must read committed',
      );
      assert.equal(
        isTicketOracleCommitted({ sessionDir: session, ticketId: 'absent0002', workingDir: repo }),
        false,
        'a Todo ticket with no commit must read absent (not committed)',
      );
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(session, { recursive: true, force: true });
    }
  });
});

test('shared helper: a baseline-equal completion_commit (R-CXOR-2) is NOT committed', () => {
  withDataRoot(() => {
    const repo = mkTmp('pxbo-base-repo-');
    const session = mkTmp('pxbo-base-session-');
    try {
      initGitRepo(repo);
      const baselineSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      // Stamp the ticket with the session baseline SHA → R-CXOR-2 rejection.
      writeTicket(session, 'baseline1', { status: 'Done', order: 1, completionCommit: baselineSha });
      // state.json carries start_commit = baselineSha so the helper wires it in.
      fs.writeFileSync(path.join(session, 'state.json'), JSON.stringify({
        active: true, start_commit: baselineSha, session_dir: session,
      }));
      assert.equal(
        isTicketOracleCommitted({ sessionDir: session, ticketId: 'baseline1', workingDir: repo }),
        false,
        'a completion_commit equal to the session baseline must be rejected (R-CXOR-2)',
      );
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(session, { recursive: true, force: true });
    }
  });
});

// ── WS-3-FacetB per-process budget reset ──

test('WS-3-FacetB: applyTicketTierBudget re-baselines an inherited (prior-process) baseline once per process', () => {
  withDataRoot(() => {
    const repo = mkTmp('pxbo-budget-repo-');
    const session = mkTmp('pxbo-budget-session-');
    try {
      initGitRepo(repo);
      writeTicket(session, 'budget01', { status: 'Todo', order: 1 });
      _resetTicketBudgetProcessBaseline();

      // Simulate a crash-resume: state inherited a STALE baseline (0) from a prior
      // process, now resumed at iteration 12. Without the per-process reset, the
      // budget delta would be ~11 and instantly trip the per-ticket cap.
      const state = {
        current_ticket: 'budget01',
        current_ticket_budget_start_iteration: 0,
        iteration: 12,
        max_iterations: 50,
        worker_timeout_seconds: 1200,
      };
      applyTicketTierBudget(state, session);
      assert.equal(state.current_ticket_budget_start_iteration, 11,
        'first per-process apply must re-baseline the inherited baseline to iteration-1');

      // A SECOND same-process apply (e.g. the per-iteration apply) must NOT re-baseline
      // again — genuine no-progress within this process still accrues against the cap.
      state.iteration = 14;
      applyTicketTierBudget(state, session);
      assert.equal(state.current_ticket_budget_start_iteration, 11,
        'second same-process apply must leave the process-fresh baseline untouched');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(session, { recursive: true, force: true });
    }
  });
});

test('WS-3-FacetB: applyTicketTierBudget sets the baseline on first use when absent (legacy gate)', () => {
  withDataRoot(() => {
    const repo = mkTmp('pxbo-budget2-repo-');
    const session = mkTmp('pxbo-budget2-session-');
    try {
      initGitRepo(repo);
      writeTicket(session, 'budget02', { status: 'Todo', order: 1 });
      _resetTicketBudgetProcessBaseline();
      const state = {
        current_ticket: 'budget02',
        iteration: 5,
        max_iterations: 50,
        worker_timeout_seconds: 1200,
      };
      applyTicketTierBudget(state, session);
      assert.equal(state.current_ticket_budget_start_iteration, 4,
        'absent baseline must be set to iteration-1 (legacy === undefined gate preserved)');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(session, { recursive: true, force: true });
    }
  });
});

// ── WS-1 AC-DPGT-3: no new state field, reuse readEvidence ──

test('WS-1 AC-DPGT-3: pipeline-runner consumes the shared helper, never imports readEvidence directly', () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'bin', 'pipeline-runner.ts'),
    'utf8',
  );
  // No direct oracle import (R-AFCC-CALLER-ENUMERATION): the only readEvidence access
  // is via the mux-runner helper.
  assert.ok(
    !/import\s+\{[^}]*\breadEvidence\b[^}]*\}\s+from/.test(src),
    'pipeline-runner.ts MUST NOT import readEvidence directly (caller-pin)',
  );
  assert.ok(
    /import\s+\{[^}]*isTicketOracleCommitted[^}]*\}\s+from\s+['"]\.\/mux-runner\.js['"]/.test(src),
    'pipeline-runner.ts MUST consume isTicketOracleCommitted from mux-runner.js',
  );
  // No forbidden parallel-runnability state fields anywhere (R-RMBS-1/-3).
  assert.ok(
    !/state\.(failed|blocked|skipped)_tickets/.test(src),
    'no parallel runnability set may be introduced',
  );
});

test('WS-1 AC-DPGT-3: the shared helper reuses readEvidence and introduces no new state field', () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'bin', 'mux-runner.ts'),
    'utf8',
  );
  // The helper body calls readEvidence (the shipped oracle), not a bespoke scan.
  assert.ok(
    /export function isTicketOracleCommitted\([\s\S]*?readEvidence\(/.test(src),
    'isTicketOracleCommitted MUST call readEvidence (reuse the single oracle)',
  );
  // No forbidden parallel-runnability state fields.
  assert.ok(
    !/state\.(failed|blocked|skipped)_tickets/.test(src),
    'no parallel runnability set may be introduced in mux-runner.ts',
  );
});

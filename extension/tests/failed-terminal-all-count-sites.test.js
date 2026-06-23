// @tier: integration
// B-DURA T40 (AC-DURA-6/7) — Failed is terminal-for-phase-advance under ONE
// conjunctive guard (start_commit..HEAD declared-file window empty AND tree clean)
// applied IDENTICALLY at all 4 advance/finalize count sites:
//   1. muxBundleScan (via applyAllTicketsDoneCompletion finalize)
//   2. applyAllTicketsDoneCompletion (every pre-check + reconcile re-scan)
//   3. findPendingNonCurrentTickets
//   4. evaluateEpicCompletion
// A spuriously-Failed BUILD ticket with a NON-empty window OR a dirty tree BLOCKS
// advance (false-green guard). The runnability site isPendingMuxTicket is UNCHANGED
// (Failed stays runnable for the heal-flow) and NO parallel state.*_tickets set is
// introduced (R-RMBS-1 / runnability-contract-doc-shape).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isFailedTicketTerminalExcludable,
  findPendingNonCurrentTickets,
  evaluateEpicCompletion,
} from '../bin/mux-runner.js';

function mkTmp(prefix = 'dura-t40-') {
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

// Write a ticket whose `## Files to modify` declares `extension/src/foo.ts`.
function writeFailedTicket(sessionDir, ticketId, declaredFile = 'extension/src/foo.ts') {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const fm = [
    '---',
    `id: "${ticketId}"`,
    `title: "Failed ${ticketId}"`,
    'status: "Failed"',
    'order: 1',
    '---',
    '# Description',
    '## Files to modify',
    `- \`${declaredFile}\``,
  ].join('\n');
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`), fm);
}

const cleanup = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };

const F = 'ffff0001'; // Failed ticket

// ---------------------------------------------------------------------------
// Shared predicate: the conjunctive guard
// ---------------------------------------------------------------------------

test('AC-DURA-6: Failed ticket with EMPTY window + CLEAN tree → terminal-excludable (the shared guard says exclude)', () => {
  const workingDir = mkTmp('dura-t40-excl-');
  initGitRepo(workingDir);
  const sessionDir = mkTmp('dura-t40-excl-sess-');
  try {
    const startCommit = head(workingDir); // baseline; no commits since → empty window
    writeFailedTicket(sessionDir, F);
    const excludable = isFailedTicketTerminalExcludable({ sessionDir, workingDir, startCommit }, F);
    assert.equal(excludable, true, 'empty window + clean tree → Failed is terminal-excludable');
  } finally {
    cleanup(workingDir, sessionDir);
  }
});

test('AC-DURA-7 false-green guard: Failed BUILD ticket with NON-empty window (declared file touched) → NOT excludable, BLOCKS advance', () => {
  const workingDir = mkTmp('dura-t40-nonempty-');
  initGitRepo(workingDir);
  const sessionDir = mkTmp('dura-t40-nonempty-sess-');
  try {
    const startCommit = head(workingDir);
    writeFailedTicket(sessionDir, F, 'extension/src/foo.ts');
    // A commit since baseline that touches the ticket's declared file → real work.
    fs.mkdirSync(path.join(workingDir, 'extension', 'src'), { recursive: true });
    fs.writeFileSync(path.join(workingDir, 'extension', 'src', 'foo.ts'), 'export const x = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: workingDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'real work in foo.ts', '--no-gpg-sign'], { cwd: workingDir, stdio: 'ignore' });

    const excludable = isFailedTicketTerminalExcludable({ sessionDir, workingDir, startCommit }, F);
    assert.equal(excludable, false, 'non-empty declared-file window → spuriously-Failed build ticket BLOCKS advance');
  } finally {
    cleanup(workingDir, sessionDir);
  }
});

test('AC-DURA-7 false-green guard: Failed ticket with DIRTY tree → NOT excludable, BLOCKS advance', () => {
  const workingDir = mkTmp('dura-t40-dirty-');
  initGitRepo(workingDir);
  const sessionDir = mkTmp('dura-t40-dirty-sess-');
  try {
    const startCommit = head(workingDir);
    writeFailedTicket(sessionDir, F);
    // Uncommitted deliverable leaves the tree dirty.
    fs.writeFileSync(path.join(workingDir, 'uncommitted.txt'), 'pending work\n');

    const excludable = isFailedTicketTerminalExcludable({ sessionDir, workingDir, startCommit }, F);
    assert.equal(excludable, false, 'dirty tree → BLOCKS advance');
  } finally {
    cleanup(workingDir, sessionDir);
  }
});

test('conservative: missing start_commit → NOT excludable (block advance)', () => {
  const workingDir = mkTmp('dura-t40-nobase-');
  initGitRepo(workingDir);
  const sessionDir = mkTmp('dura-t40-nobase-sess-');
  try {
    writeFailedTicket(sessionDir, F);
    const excludable = isFailedTicketTerminalExcludable({ sessionDir, workingDir, startCommit: null }, F);
    assert.equal(excludable, false, 'no baseline → cannot prove window empty → block');
  } finally {
    cleanup(workingDir, sessionDir);
  }
});

// ---------------------------------------------------------------------------
// Per-site application: identical predicate at the 4 count sites
// ---------------------------------------------------------------------------

const DONE = { id: 'dddd0001', status: 'Done' };
const FAILED = { id: F, status: 'Failed' };

test('AC-DURA-6 site findPendingNonCurrentTickets: Failed with empty window+clean tree is EXCLUDED from pending (phase advances)', () => {
  const workingDir = mkTmp('dura-t40-fp-');
  initGitRepo(workingDir);
  const sessionDir = mkTmp('dura-t40-fp-sess-');
  try {
    const startCommit = head(workingDir);
    writeFailedTicket(sessionDir, F);
    const tickets = [DONE, FAILED];
    const gitCtx = { sessionDir, workingDir, startCommit };
    const pending = findPendingNonCurrentTickets(tickets, null, gitCtx);
    assert.equal(pending.length, 0, 'Failed-excludable ticket must NOT count as pending → phase advances, never 0/4');
  } finally {
    cleanup(workingDir, sessionDir);
  }
});

test('AC-DURA-7 site findPendingNonCurrentTickets: Failed with non-empty window BLOCKS advance (counts as pending)', () => {
  const workingDir = mkTmp('dura-t40-fp2-');
  initGitRepo(workingDir);
  const sessionDir = mkTmp('dura-t40-fp2-sess-');
  try {
    const startCommit = head(workingDir);
    writeFailedTicket(sessionDir, F, 'extension/src/foo.ts');
    fs.mkdirSync(path.join(workingDir, 'extension', 'src'), { recursive: true });
    fs.writeFileSync(path.join(workingDir, 'extension', 'src', 'foo.ts'), 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: workingDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'foo work', '--no-gpg-sign'], { cwd: workingDir, stdio: 'ignore' });
    const gitCtx = { sessionDir, workingDir, startCommit };
    const pending = findPendingNonCurrentTickets([DONE, FAILED], null, gitCtx);
    assert.deepEqual(pending.map(t => t.id), [F], 'spuriously-Failed build ticket BLOCKS advance');
  } finally {
    cleanup(workingDir, sessionDir);
  }
});

test('findPendingNonCurrentTickets without gitCtx: Failed counts as pending (conservative false-green block)', () => {
  const pending = findPendingNonCurrentTickets([DONE, FAILED], null, null);
  assert.deepEqual(pending.map(t => t.id), [F], 'no git context → Failed blocks advance');
});

test('AC-DURA-6 site evaluateEpicCompletion: Failed with empty window+clean tree → genuine completion (excluded from pendingIds)', () => {
  const workingDir = mkTmp('dura-t40-ee-');
  initGitRepo(workingDir);
  const sessionDir = mkTmp('dura-t40-ee-sess-');
  try {
    const startCommit = head(workingDir);
    writeFailedTicket(sessionDir, F);
    const decision = evaluateEpicCompletion({
      tickets: [DONE, FAILED],
      currentTicket: null,
      priorFalseCount: 0,
      priorFalseTicket: null,
      failedTerminalGitContext: { sessionDir, workingDir, startCommit },
    });
    assert.equal(decision.kind, 'genuine', 'empty-window Failed must be excluded → genuine completion (never 0/4)');
  } finally {
    cleanup(workingDir, sessionDir);
  }
});

test('AC-DURA-7 site evaluateEpicCompletion: Failed with non-empty window → recover (NOT genuine; blocks)', () => {
  const workingDir = mkTmp('dura-t40-ee2-');
  initGitRepo(workingDir);
  const sessionDir = mkTmp('dura-t40-ee2-sess-');
  try {
    const startCommit = head(workingDir);
    writeFailedTicket(sessionDir, F, 'extension/src/foo.ts');
    fs.mkdirSync(path.join(workingDir, 'extension', 'src'), { recursive: true });
    fs.writeFileSync(path.join(workingDir, 'extension', 'src', 'foo.ts'), 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: workingDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'foo work', '--no-gpg-sign'], { cwd: workingDir, stdio: 'ignore' });
    const decision = evaluateEpicCompletion({
      tickets: [DONE, FAILED],
      currentTicket: null,
      priorFalseCount: 0,
      priorFalseTicket: null,
      failedTerminalGitContext: { sessionDir, workingDir, startCommit },
    });
    assert.notEqual(decision.kind, 'genuine', 'a real-work Failed build ticket must block genuine completion');
    assert.ok(decision.pendingIds?.includes(F), 'the Failed build ticket must remain in pendingIds');
  } finally {
    cleanup(workingDir, sessionDir);
  }
});

// ---------------------------------------------------------------------------
// Runnability held + no parallel state set
// ---------------------------------------------------------------------------

test('AC-DURA: isPendingMuxTicket runnability is UNCHANGED — Failed stays runnable (source pin)', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../src/bin/mux-runner.ts'), 'utf8');
  const fnStart = src.indexOf('function isPendingMuxTicket');
  const fnBody = src.slice(fnStart, fnStart + 400);
  // Runnability is frontmatter-authoritative: only done/skipped are non-runnable.
  assert.ok(/status !== 'done' && status !== 'skipped'/.test(fnBody),
    "isPendingMuxTicket must keep Failed runnable (status !== 'done' && status !== 'skipped')");
  assert.ok(!/isFailedTicketTerminalExcludable/.test(fnBody),
    'isPendingMuxTicket must NOT apply the advance-count guard (runnability stays frontmatter-authoritative)');
});

test('AC-DURA: NO parallel state.(failed|blocked|skipped)_tickets field introduced (source pin)', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../src/bin/mux-runner.ts'), 'utf8');
  const types = fs.readFileSync(path.resolve(import.meta.dirname, '../src/types/index.ts'), 'utf8');
  assert.ok(!/state\.(failed|blocked|skipped)_tickets/.test(src), 'no parallel state set in mux-runner.ts');
  assert.ok(!/(failed|blocked|skipped)_tickets\??\s*:/.test(types), 'no parallel state set field in types/index.ts');
});

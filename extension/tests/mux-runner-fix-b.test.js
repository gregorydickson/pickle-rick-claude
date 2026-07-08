// @tier: integration
/**
 * Fix B — three confirmed mux-runner.ts reliability bugs + one comment/parity fix.
 *
 * M1 — exit-path commit ownership: commitGatePassingDeliverableOnExitPath must NOT
 *      stage/commit dirty work that belongs to ANOTHER ticket's session dir under
 *      `previousTicket`. Ticket-owned work is still committed (Case A preserved).
 *
 * L2 — idle-stall recovery attempt cap: consecutive idle-stall self-recoveries are
 *      bounded; on exceed the loop escalates (idle_stall_unrecoverable). A real
 *      progress event resets the counter.
 *
 * L5 — all-terminal short-circuit: when every pending ticket is terminal-Failed and
 *      current_ticket is null, the loop must exit (recovery_exhausted) rather than
 *      enter runIteration with a null ticket.
 *
 * L6 — recovery-ladder entry-point parity: attemptRecoveryBeforeTerminal is wired at
 *      THREE call sites (closer-handoff, codex-no-progress, wmw-auto-skip); the
 *      doc comment must say three.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  commitGatePassingDeliverableOnExitPath,
  partitionExitPathDirtyByOwnership,
  evaluateIdleStallRecoveryCap,
  noRunnableTicketsRemain,
  isFailureExit,
} from '../bin/mux-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_SRC = path.resolve(__dirname, '../src/bin/mux-runner.ts');
const src = fs.readFileSync(MUX_SRC, 'utf8');

function makeTmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
function initGitRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'extension'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'extension', 'README.md'), 'fixture\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'initial', '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
}
function writeTicket(sessionDir, ticketId, status, order = 1) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const lines = ['---', `id: "${ticketId}"`, `status: "${status}"`, `order: ${order}`];
  if (status === 'Failed') lines.push('failed_reason: "oversized_no_progress"');
  lines.push('---', '# Body');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), lines.join('\n'));
}
function porcelain(dir) {
  return execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim();
}
const cleanup = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const passGate = () => ({ ok: true, failures: [], timed_out: false, timeout_ms: 0 });

function baseInput(sessionDir, workingDir, ticketId, runGate) {
  return {
    sessionDir,
    statePath: path.join(sessionDir, 'state.json'),
    workingDir,
    ticketId,
    extensionRoot: path.join(workingDir, 'extension'),
    flags: null,
    log: () => {},
    runGate,
  };
}

// ---------------------------------------------------------------------------
// M1 — ownership partition (pure helper)
// ---------------------------------------------------------------------------

test('M1: partition marks paths under ANOTHER ticket dir as foreign, source as owned', () => {
  const sessionDir = '/data/session';
  const workingDir = '/data/session'; // shared dir worst-case
  const allTicketIds = ['aaaa1111', 'bbbb2222'];
  const dirty = [
    'aaaa1111/research_x.md',   // current ticket — owned
    'bbbb2222/plan_y.md',       // FOREIGN ticket — must be excluded
    'extension/src/foo.ts',     // source deliverable — owned
  ];
  const { owned, foreign } = partitionExitPathDirtyByOwnership(dirty, workingDir, sessionDir, 'aaaa1111', allTicketIds);
  assert.deepEqual(foreign, ['bbbb2222/plan_y.md']);
  assert.deepEqual(owned.sort(), ['aaaa1111/research_x.md', 'extension/src/foo.ts']);
});

test('M1: partition with sessionDir outside workingDir treats all non-foreign as owned', () => {
  const sessionDir = '/data/session';
  const workingDir = '/repo';
  const dirty = ['extension/src/foo.ts', 'README.md'];
  const { owned, foreign } = partitionExitPathDirtyByOwnership(dirty, workingDir, sessionDir, 'aaaa1111', ['aaaa1111', 'bbbb2222']);
  assert.deepEqual(foreign, []);
  assert.deepEqual(owned.sort(), ['README.md', 'extension/src/foo.ts']);
});

test('M1: ONLY foreign dirty work in the tree → exit-commit returns clean-ticket-tree, does NOT commit', () => {
  // sessionDir lives INSIDE the git repo so a foreign ticket dir shows up in the dirty set.
  const workingDir = makeTmp('fixb-m1-foreign-');
  initGitRepo(workingDir);
  const sessionDir = path.join(workingDir, 'sessiondata');
  try {
    const CUR = 'aaaa1111';
    const OTHER = 'bbbb2222';
    writeTicket(sessionDir, CUR, 'In Progress');
    writeTicket(sessionDir, OTHER, 'In Progress');
    // Commit the baseline ticket files so they are NOT dirty — only the foreign
    // ticket's NEW deliverable should be in the dirty set below.
    execFileSync('git', ['add', '-A'], { cwd: workingDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'baseline tickets', '--no-gpg-sign'], { cwd: workingDir, stdio: 'ignore' });
    // Dirty work belongs to OTHER ticket's dir only; NOTHING owned by CUR is dirty.
    fs.writeFileSync(path.join(sessionDir, OTHER, 'plan_foreign.md'), 'foreign work\n');
    assert.notEqual(porcelain(workingDir), '', 'precondition: tree dirty (foreign work)');

    const result = commitGatePassingDeliverableOnExitPath(baseInput(sessionDir, workingDir, CUR, passGate));

    assert.equal(result.committed, false, `expected no commit, got reason=${result.reason}`);
    assert.equal(result.reason, 'clean-ticket-tree');
    // The foreign work must NOT have been committed under CUR.
    assert.notEqual(porcelain(workingDir), '', 'foreign work must remain uncommitted');
  } finally {
    cleanup(workingDir);
  }
});

test('M1: ticket-owned dirty work is still committed (happy path preserved)', () => {
  const workingDir = makeTmp('fixb-m1-owned-');
  initGitRepo(workingDir);
  const sessionDir = makeTmp('fixb-m1-owned-sess-');
  try {
    const CUR = 'aaaa1111';
    writeTicket(sessionDir, CUR, 'In Progress');
    // Source deliverable in the repo — owned (no foreign ticket dir involved).
    fs.writeFileSync(path.join(workingDir, 'extension', 'deliverable.txt'), 'shipped work\n');
    assert.notEqual(porcelain(workingDir), '');

    const result = commitGatePassingDeliverableOnExitPath(baseInput(sessionDir, workingDir, CUR, passGate));

    assert.equal(result.committed, true, `expected commit, got reason=${result.reason}`);
    assert.equal(result.reason, 'committed');
    assert.equal(porcelain(workingDir), '', 'owned work committed');
  } finally {
    cleanup(workingDir, sessionDir);
  }
});

// ---------------------------------------------------------------------------
// L2 — idle-stall recovery attempt cap (pure helper)
// ---------------------------------------------------------------------------

test('L2: idle-stall recovery cap escalates only AFTER exceeding the cap', () => {
  // cap = 3 → recoveries 1,2,3 are allowed, the 4th (count becomes > cap) escalates.
  assert.equal(evaluateIdleStallRecoveryCap(1, 3), false);
  assert.equal(evaluateIdleStallRecoveryCap(2, 3), false);
  assert.equal(evaluateIdleStallRecoveryCap(3, 3), false, 'at the cap is still allowed');
  assert.equal(evaluateIdleStallRecoveryCap(4, 3), true, 'over the cap escalates');
});

test('L2: idle_stall_unrecoverable is a failure exit', () => {
  assert.equal(isFailureExit('idle_stall_unrecoverable'), true);
});

test('L2: wiring — main loop increments a recovery counter, caps it, and escalates to idle_stall_unrecoverable', () => {
  const slice = src.slice(src.indexOf('evaluateMuxIdleStallWatchdog({'));
  assert.ok(/idleStallRecoveryCount/.test(slice), 'loop must track a consecutive idle-stall recovery counter');
  assert.ok(/evaluateIdleStallRecoveryCap\(/.test(slice), 'loop must consult evaluateIdleStallRecoveryCap');
  assert.ok(/recordExitReason\(statePath, 'idle_stall_unrecoverable'\)/.test(slice), 'over-cap escalates with idle_stall_unrecoverable');
  // Counter resets on genuine progress (exit-commit committed or iteration-advance).
  assert.ok(/idleStallRecoveryCount = 0/.test(src), 'counter must reset on real progress');
});

// ---------------------------------------------------------------------------
// L5 — all-terminal short-circuit (pure helper + wiring)
// ---------------------------------------------------------------------------

test('L5: noRunnableTicketsRemain is true when all pending tickets are terminal-Failed', () => {
  const sessionDir = makeTmp('fixb-l5-allfailed-');
  try {
    writeTicket(sessionDir, 'aaaa1111', 'Failed', 1);
    writeTicket(sessionDir, 'bbbb2222', 'Failed', 2);
    assert.equal(noRunnableTicketsRemain(sessionDir), true);
  } finally {
    cleanup(sessionDir);
  }
});

test('L5: noRunnableTicketsRemain is false when a Todo ticket remains', () => {
  const sessionDir = makeTmp('fixb-l5-mixed-');
  try {
    writeTicket(sessionDir, 'aaaa1111', 'Failed', 1);
    writeTicket(sessionDir, 'bbbb2222', 'Todo', 2);
    assert.equal(noRunnableTicketsRemain(sessionDir), false);
  } finally {
    cleanup(sessionDir);
  }
});

test('L5: noRunnableTicketsRemain is false when there are NO tickets (avoid false-terminal on empty session)', () => {
  const sessionDir = makeTmp('fixb-l5-empty-');
  try {
    assert.equal(noRunnableTicketsRemain(sessionDir), false);
  } finally {
    cleanup(sessionDir);
  }
});

test('L5: wiring — null preTicket + no runnable tickets short-circuits BEFORE runIteration', () => {
  // The guard must sit after the all-Done check and gate on a null resolved ticket.
  // W4b: the empty roster (all-Failed, no runnable) resolves to the honest ladder
  // terminal `recovery_exhausted` (the legacy `all_tickets_terminal` was retired
  // in the guard-layer kill-switch prune).
  assert.ok(/noRunnableTicketsRemain\(sessionDir\)/.test(src), 'loop must call noRunnableTicketsRemain');
  assert.ok(/!preTicket/.test(src), 'loop must short-circuit on a null preTicket');
  assert.ok(/empty roster \(all-Failed, no runnable ticket\)[\s\S]{0,400}?recordExitReason\(statePath, 'recovery_exhausted'\)/.test(src),
    'all-terminal short-circuit must record recovery_exhausted');
  assert.ok(!src.includes("'all_tickets_terminal'"), 'retired all_tickets_terminal literal must not reappear');
});

test('L5: recovery_exhausted is a failure exit (auto-resume stops)', () => {
  assert.equal(isFailureExit('recovery_exhausted'), true);
});

// ---------------------------------------------------------------------------
// L6 — recovery-ladder entry-point parity (comment + grep)
// ---------------------------------------------------------------------------

test('L6 (W4a): attemptRecoveryBeforeTerminal runs the ladder from exactly ONE place', () => {
  // Post-W4a topology: the choke point is `routeRecoveryBeforeTerminal`; every seam
  // routes through IT, and `attemptRecoveryBeforeTerminal` (which holds the sole
  // `runRecoveryLadder` invocation) is called only by the wrapper. The "single
  // decision site" invariant is what AC-W4a-1 pins — see
  // extension/tests/halt-or-recover-choke-point.test.js for the full matrix + lint.
  const directCallSites = src.split('\n').filter(line =>
    /\battemptRecoveryBeforeTerminal\(/.test(line) &&
    !/export function attemptRecoveryBeforeTerminal/.test(line) &&
    !/^\s*\/\//.test(line) &&
    !/\* /.test(line),
  );
  assert.equal(directCallSites.length, 1,
    `expected 1 direct attemptRecoveryBeforeTerminal call (inside routeRecoveryBeforeTerminal), found ${directCallSites.length}`);
  // The DECISION (ladder invocation) is unique.
  const ladderCalls = src.split('\n').filter(line => /runRecoveryLadder\(deps\)/.test(line));
  assert.equal(ladderCalls.length, 1, 'runRecoveryLadder must be invoked at exactly one decision site');
});

test('L6 (W4a): the recovery-adapter doc comment enumerates every routed seam', () => {
  assert.ok(!/BOTH terminal authorities/.test(src), 'stale "BOTH terminal authorities" comment must be gone');
  // The W4a comment names the original THREE plus the two W4a additions.
  assert.ok(/closer.?handoff/i.test(src) && /codex/i.test(src) && /wmw.?auto.?skip/i.test(src),
    'comment must enumerate closer-handoff, codex-no-progress, wmw-auto-skip');
  assert.ok(/timeout_repeat/.test(src) && /idle_stall_unrecoverable/.test(src),
    'comment must enumerate the W4a additions timeout_repeat + idle_stall_unrecoverable');
});

// @tier: fast
//
// AC-W3-1: ONE parametrized matrix for the salvage-before-fail primitive.
//   describe.each([5 seams]) × describe.each([gate-passing, gate-failing,
//   gate-errored, clean-tree]).
// Asserts the SalvageOutcome contract per cell:
//   - gate-passing  -> committed-done + real sha (commit happened, ticket Done)
//   - gate-failing  -> archived-todo  (archive BEFORE reset; ticket Todo)
//   - gate-errored  -> archived-todo
//   - clean-tree    -> no-op
// Plus the cross-cutting invariants:
//   - NEVER `reset --hard` over uncommitted work (archive precedes any reset).
//   - reflog has no orphaned ticket commit afterward (ff-reattach cell recovers).
//   - the ownership partition `partitionExitPathDirtyByOwnership` survives.
//
// MUST remain ONE parametrized file — do NOT fan out per seam.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { salvageTicket } from '../lib/salvage-ticket.js';
import {
  partitionExitPathDirtyByOwnership,
  routeExitPathSalvage,
  readActiveFailedFlipHolds,
  noRunnableTicketsRemain,
} from '../bin/mux-runner.js';
import { getTicketStatus } from '../services/pickle-utils.js';

// The 5 interruption seams (AC-W3-1 seam axis).
const SEAMS = [
  'no_progress_fail',
  'external_sigterm',
  'signal_shutdown',
  'silent_zero_byte_worker_exit',
  'manager_mid_implement_crash',
];

// The 4 tree-state cells (AC-W3-1 disposition axis).
const TREE_STATES = ['gate-passing', 'gate-failing', 'gate-errored', 'clean-tree'];

const SHA = 'abc1234';

/**
 * Build an injectable SalvageDeps that drives a given tree-state and records
 * every destructive action so the test can prove ordering (archive-before-reset)
 * and that no `reset --hard` runs over uncommitted work.
 */
function makeDeps(treeState, recorder) {
  const dirty = treeState !== 'clean-tree';
  const gateVerdict =
    treeState === 'gate-passing' ? 'passing'
    : treeState === 'gate-errored' ? 'errored'
    : 'failing';
  return {
    reconcile: () => ({
      headSha: SHA,
      dirty,
      dirtyPaths: dirty ? ['extension/src/foo.ts'] : [],
      ticketStatuses: { t1: 'In Progress' },
      tickets: [{ id: 't1', status: 'In Progress' }],
    }),
    gate: () => gateVerdict,
    commitScoped: () => {
      recorder.push('commit-scoped');
      return { committed: true, sha: SHA };
    },
    archive: () => {
      recorder.push('archive');
      return { patchPath: '/tmp/p.patch', files: ['extension/src/foo.ts'], filesTruncated: false };
    },
    resetTodo: () => {
      recorder.push('reset-todo');
    },
    ffReattach: () => ({ recovered: false }),
  };
}

describe('salvageTicket matrix (AC-W3-1: 5 seams × 4 tree-states)', () => {
  for (const seam of SEAMS) {
    describe(`seam: ${seam}`, () => {
      for (const treeState of TREE_STATES) {
        describe(`tree-state: ${treeState}`, () => {
          it('produces the contract disposition + never resets over uncommitted work', () => {
            const recorder = [];
            const outcome = salvageTicket(
              { sessionDir: '/s', workingDir: '/w', ticketId: 't1', log: () => {} },
              makeDeps(treeState, recorder),
            );

            if (treeState === 'gate-passing') {
              assert.equal(outcome.disposition, 'committed-done');
              assert.equal(outcome.sha, SHA, 'committed-done carries a real commit sha');
              assert.ok(recorder.includes('commit-scoped'), 'scoped commit ran');
              assert.ok(!recorder.includes('reset-todo'), 'gate-passing never resets the ticket');
              assert.ok(!recorder.includes('archive'), 'gate-passing never archives');
            } else if (treeState === 'clean-tree') {
              assert.equal(outcome.disposition, 'no-op');
              assert.deepEqual(recorder, [], 'clean tree takes no destructive action');
            } else {
              // gate-failing / gate-errored
              assert.equal(outcome.disposition, 'archived-todo');
              assert.equal(outcome.archived, true, 'dirty diff was archived');
              // INVARIANT: archive BEFORE reset — never reset --hard over uncommitted work.
              const ai = recorder.indexOf('archive');
              const ri = recorder.indexOf('reset-todo');
              assert.ok(ai >= 0 && ri >= 0, 'both archive and reset ran');
              assert.ok(ai < ri, 'archive precedes reset (no reset --hard over uncommitted work)');
              assert.ok(!recorder.includes('commit-scoped'), 'gate-failing/errored never commits');
            }
          });
        });
      }
    });
  }
});

describe('salvageTicket cross-cutting invariants', () => {
  it('HEAD regressed off a committed ticket -> auto-ff-reattach (reflog has no orphan)', () => {
    const recorder = [];
    const deps = makeDeps('gate-failing', recorder);
    deps.ffReattach = () => ({ recovered: true, sha: 'deadbee' });
    const outcome = salvageTicket(
      { sessionDir: '/s', workingDir: '/w', ticketId: 't1', startCommit: 'base000', completionCommitSha: 'deadbee', log: () => {} },
      deps,
    );
    assert.equal(outcome.disposition, 'ff-reattached');
    assert.equal(outcome.sha, 'deadbee', 'reattached the orphaned tip — no orphan left in reflog');
    // ff-reattach short-circuits before any archive/reset/commit.
    assert.deepEqual(recorder, [], 'reattach takes precedence over archive/reset');
  });

  it('an already-Done ticket is a no-op (model-driven path owns it)', () => {
    const recorder = [];
    const deps = makeDeps('gate-passing', recorder);
    deps.reconcile = () => ({
      headSha: SHA,
      dirty: true,
      dirtyPaths: ['x'],
      ticketStatuses: { t1: 'Done' },
      tickets: [{ id: 't1', status: 'Done' }],
    });
    const outcome = salvageTicket(
      { sessionDir: '/s', workingDir: '/w', ticketId: 't1', log: () => {} },
      deps,
    );
    assert.equal(outcome.disposition, 'no-op');
    assert.deepEqual(recorder, [], 'terminal ticket takes no salvage action');
  });

  it('throws are swallowed best-effort (no destructive action leaks)', () => {
    const deps = makeDeps('gate-failing', []);
    deps.reconcile = () => { throw new Error('reconcile boom'); };
    const outcome = salvageTicket(
      { sessionDir: '/s', workingDir: '/w', ticketId: 't1', log: () => {} },
      deps,
    );
    assert.equal(outcome.disposition, 'error');
  });

  it('partitionExitPathDirtyByOwnership survives (ownership partition preserved)', () => {
    // The PRESERVE invariant: the ownership partition must still be exported and
    // correctly split owned vs foreign session-dir paths.
    const { owned, foreign } = partitionExitPathDirtyByOwnership(
      ['extension/src/a.ts', 'sessions/sess/OTHER/research_x.md', 'sessions/sess/MINE/plan.md'],
      '/repo',
      '/repo/sessions/sess',
      'MINE',
      ['MINE', 'OTHER'],
    );
    assert.ok(owned.includes('extension/src/a.ts'), 'source deliverable owned');
    assert.ok(owned.includes('sessions/sess/MINE/plan.md'), 'own ticket artifact owned');
    assert.ok(foreign.includes('sessions/sess/OTHER/research_x.md'), 'sibling ticket artifact foreign');
  });
});

// aafc633a: routeExitPathSalvage is the ONE shared dep-set builder consumed by
// all three exit-commit call sites (mux-runner.ts :11351 / :11444 / :11520),
// so driving the exported function once against the REAL salvage-ticket.js +
// git-utils.js wiring covers all three by construction (AC-1/AC-2/AC-3). Uses
// a real git repo (matches the start-commit-salvage-guards.test.js pattern) —
// none of the functions under test read PICKLE_DATA_ROOT (all take an
// explicit sessionDir), so no data-root sandbox is required.
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 15000 }).trim();
}

function initRepoWithExtensionDir() {
  const repo = mkdtempSync(path.join(tmpdir(), 'pickle-restwiring-repo-'));
  git(['init', '-q'], repo);
  git(['config', 'user.email', 'restwiring@test.local'], repo);
  git(['config', 'user.name', 'restwiring'], repo);
  mkdirSync(path.join(repo, 'extension'), { recursive: true });
  writeFileSync(path.join(repo, 'tracked.txt'), 'base\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'base', '--no-gpg-sign'], repo);
  return repo;
}

function makeHeldSessionDir(workingDir, ticketId) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pickle-restwiring-session-'));
  const sessionDir = path.join(tmp, 'session');
  const ticketDir = path.join(sessionDir, ticketId);
  mkdirSync(ticketDir, { recursive: true });
  writeFileSync(
    path.join(ticketDir, `rick_ticket_${ticketId}.md`),
    `---\nid: ${ticketId}\ntitle: Held ticket ${ticketId}\nstatus: In Progress\norder: 1\n---\n\n# Test\n`,
  );
  const statePath = path.join(sessionDir, 'state.json');
  writeFileSync(
    statePath,
    JSON.stringify({
      active: true, schema_version: 5, working_dir: workingDir, step: 'implement',
      iteration: 1, max_iterations: 50, worker_timeout_seconds: 600,
      start_time_epoch: Math.floor(Date.now() / 1000), original_prompt: 'restwiring test',
      session_dir: sessionDir, started_at: new Date().toISOString(), history: [],
      tmux_mode: false, backend: 'claude', activity: [],
      recovery_attempts: [
        { strategy: 'failed_flip_suppressed', outcome: 'success', ticket: ticketId, iteration: 1, reason: 'held for test' },
      ],
    }),
  );
  return { tmp, sessionDir, statePath };
}

const failingRunGate = () => ({ ok: false, failures: [], timed_out: false, timeout_ms: null });
const passingRunGate = () => ({ ok: true, failures: [], timed_out: false, timeout_ms: null });

/** Normalizes a raw frontmatter status the same way readActiveFailedFlipHolds does. */
function normalizedStatus(sessionDir, ticketId) {
  return (getTicketStatus(sessionDir, ticketId) || '').toLowerCase().replace(/["']/g, '').trim();
}

/**
 * Builds a real repo + a session dir holding one ticket under an active
 * failed_flip_suppressed hold, dirties the tree, runs `fn`, then cleans up
 * both temp roots regardless of outcome.
 */
function withHeldTicketFixture(ticketId, fn) {
  const repo = initRepoWithExtensionDir();
  let sessionTmp;
  try {
    const { tmp, sessionDir, statePath } = makeHeldSessionDir(repo, ticketId);
    sessionTmp = tmp;
    writeFileSync(path.join(repo, 'tracked.txt'), 'dirty\n'); // isWorkingTreeDirty(repo) === true
    const route = (runGate) => routeExitPathSalvage({
      sessionDir, statePath, workingDir: repo, ticketId,
      extensionRoot: path.join(repo, 'extension'), flags: null, log: () => {}, runGate,
    });
    fn({ sessionDir, route });
  } finally {
    rmSync(repo, { recursive: true, force: true });
    if (sessionTmp) { rmSync(sessionTmp, { recursive: true, force: true }); }
  }
}

describe('routeExitPathSalvage: shared dep-set release wiring (aafc633a)', () => {
  it('AC-1: a gate-failing dirty tree resets frontmatter status to the literal "todo"', () => {
    withHeldTicketFixture('restw001', ({ sessionDir, route }) => {
      const result = route(failingRunGate);
      assert.equal(result.committed, false, 'gate-failing dirty tree never commits');
      assert.equal(normalizedStatus(sessionDir, 'restw001'), 'todo', 'resetTodo must write the literal frontmatter status "todo"');
    });
  });

  it('AC-2: releasing the hold clears readActiveFailedFlipHolds; noRunnableTicketsRemain is false throughout (C5/R-EROS)', () => {
    withHeldTicketFixture('restw002', ({ sessionDir, route }) => {
      // Before release: the hold is active, but the ticket's status is still
      // "In Progress" (the suppression preserves status instead of flipping
      // Failed) — genuinely unfinished, not Failed. C5 (R-EROS): the roster
      // must NOT read as exhausted just because the ticket is unselectable.
      assert.ok(readActiveFailedFlipHolds(sessionDir).has('restw002'), 'hold is active before release');
      assert.equal(noRunnableTicketsRemain(sessionDir), false, 'held-but-In-Progress ticket must not make the roster look exhausted');

      route(failingRunGate);

      assert.equal(readActiveFailedFlipHolds(sessionDir).has('restw002'), false, 'hold released after resetTodo');
      assert.equal(noRunnableTicketsRemain(sessionDir), false, 'roster is runnable again — L5 terminal must not fire');
    });
  });

  it('a gate-passing dirty tree still commits + Done (archive/resetTodo path not taken)', () => {
    withHeldTicketFixture('restw003', ({ sessionDir, route }) => {
      const result = route(passingRunGate);
      assert.equal(result.committed, true, 'gate-passing dirty tree commits');
      assert.equal(normalizedStatus(sessionDir, 'restw003'), 'done', 'gate-passing path flips Done, not Todo');
    });
  });
});

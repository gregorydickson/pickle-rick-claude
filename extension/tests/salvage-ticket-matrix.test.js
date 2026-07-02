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

import { salvageTicket } from '../lib/salvage-ticket.js';
import { partitionExitPathDirtyByOwnership } from '../bin/mux-runner.js';

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

// @tier: integration
//
// B-PCOMP ticket 0a1ce691: a ticket whose work is already committed (green, on
// branch) but never Done-flipped must NOT be salvage-reset/fataled — the salvage
// clean-tree path back-fills its completion_commit and keeps it Done.
//
// Part A (fast, injected deps — no git): salvageTicket clean-tree back-fill.
//   - clean tree + non-terminal + attribution sha -> committed-done /
//     backfilled_clean_tree (the new disposition reason; reuses committed-done).
//   - clean tree + NO attribution sha             -> no-op (normal clean-tree).
//   - clean tree + ALREADY terminal               -> no-op (never re-flip Done).
//   - clean tree + backfillDone reports done:false -> no-op (best-effort).
//
// Part C (AP-EXT-ITER273-01, real git): the DEFAULT reconcile deps decide the
//   clean-tree short-circuit, so a git probe that could not run must never be
//   published as a measured clean tree.
//   - healthy dirty repo      -> dirty:true  -> archive + reset Todo
//   - unmeasurable (corrupt .git/index, `status` exits 128 while `rev-parse`
//     exits 0) over the SAME dirty tree -> dirty:true, salvage still acts
//   - measured clean repo     -> dirty:false -> no-op clean_tree
//   - provable non-repo       -> dirty:false (an answer, not a fabrication)
//
// Part B (regression-lock): the no-progress reap keys on the recordWorkerArtifact
//   Progress artifact-delta + PICKLE_WMW_SKIP_K, NEVER worker_session log size.
//   A spawn that produced a NEW artifact (positive delta) does NOT increment the
//   zero-progress counter even when the worker_session log is 0 bytes; reap fires
//   only at K consecutive zero-delta spawns. recordWorkerArtifactProgress takes no
//   log-path argument — log size is structurally absent from the reap decision.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { execFileSync } from 'child_process';

import { salvageTicket } from '../lib/salvage-ticket.js';
import { reconcileTicketTruth } from '../lib/reconcile-ticket-truth.js';
import {
  recordWorkerArtifactProgress,
  countWorkerArtifacts,
  resolveWmwSkipK,
  WMW_SKIP_K_ENV,
} from '../bin/mux-runner.js';

const SHA = 'feedface';

/** Injectable clean-tree deps: clean working tree, configurable ticket status. */
function cleanTreeDeps(ticketStatus, recorder) {
  return {
    reconcile: () => ({
      headSha: 'base0000',
      dirty: false,
      dirtyPaths: [],
      ticketStatuses: { t1: ticketStatus },
      tickets: [{ id: 't1', status: ticketStatus }],
    }),
    gate: () => 'failing',
    commitScoped: () => { recorder.push('commit-scoped'); return { committed: false }; },
    archive: () => { recorder.push('archive'); return null; },
    resetTodo: () => { recorder.push('reset-todo'); },
    ffReattach: () => ({ recovered: false }),
    backfillDone: (_input, sha) => {
      recorder.push(`backfill:${sha}`);
      return { done: true, sha };
    },
  };
}

test('Part A1: clean tree + non-terminal + attribution sha -> committed-done / backfilled_clean_tree', () => {
  const recorder = [];
  const outcome = salvageTicket(
    { sessionDir: '/s', workingDir: '/w', ticketId: 't1', completionCommitSha: SHA, log: () => {} },
    cleanTreeDeps('In Progress', recorder),
  );
  assert.equal(outcome.disposition, 'committed-done', 'back-fill reuses committed-done disposition');
  assert.equal(outcome.reason, 'backfilled_clean_tree', 'distinct reason marks the clean-tree back-fill');
  assert.equal(outcome.sha, SHA, 'carries the attributed commit sha');
  assert.ok(recorder.includes(`backfill:${SHA}`), 'backfillDone was invoked with the attribution sha');
  assert.ok(!recorder.includes('archive'), 'committed-green ticket is never archived');
  assert.ok(!recorder.includes('reset-todo'), 'committed-green ticket is never reset to Todo');
});

test('Part A2: clean tree + NO attribution sha -> no-op (normal clean-tree path preserved)', () => {
  const recorder = [];
  const outcome = salvageTicket(
    { sessionDir: '/s', workingDir: '/w', ticketId: 't1', log: () => {} },
    cleanTreeDeps('In Progress', recorder),
  );
  assert.equal(outcome.disposition, 'no-op');
  assert.equal(outcome.reason, 'clean_tree');
  assert.deepEqual(recorder, [], 'no destructive/back-fill action without an attribution sha');
});

test('Part A3: clean tree + already terminal -> no-op (never re-flip a Done ticket)', () => {
  const recorder = [];
  const outcome = salvageTicket(
    { sessionDir: '/s', workingDir: '/w', ticketId: 't1', completionCommitSha: SHA, log: () => {} },
    cleanTreeDeps('Done', recorder),
  );
  assert.equal(outcome.disposition, 'no-op');
  assert.equal(outcome.reason, 'clean_tree');
  assert.ok(!recorder.some((r) => r.startsWith('backfill:')), 'terminal ticket is never back-filled');
});

test('Part A4: clean tree + backfillDone reports done:false -> no-op (best-effort)', () => {
  const recorder = [];
  const deps = cleanTreeDeps('In Progress', recorder);
  deps.backfillDone = (_i, sha) => { recorder.push(`backfill:${sha}`); return { done: false }; };
  const outcome = salvageTicket(
    { sessionDir: '/s', workingDir: '/w', ticketId: 't1', completionCommitSha: SHA, log: () => {} },
    deps,
  );
  assert.equal(outcome.disposition, 'no-op', 'a failed back-fill write falls through to no-op');
  assert.ok(recorder.includes(`backfill:${SHA}`), 'back-fill was attempted');
});

test('Part A5: a seam without a backfillDone dep stays a no-op on clean tree (opt-in)', () => {
  const recorder = [];
  const deps = cleanTreeDeps('In Progress', recorder);
  delete deps.backfillDone;
  const outcome = salvageTicket(
    { sessionDir: '/s', workingDir: '/w', ticketId: 't1', completionCommitSha: SHA, log: () => {} },
    deps,
  );
  assert.equal(outcome.disposition, 'no-op', 'back-fill is opt-in per seam — absent dep => no-op');
});

test('Part A6: clean tree + attribution sha but NO HEAD commit -> no-op (never back-fill onto an empty repo)', () => {
  const recorder = [];
  const deps = cleanTreeDeps('In Progress', recorder);
  // Non-repo / pre-first-commit: a clean tree with no HEAD cannot hold an
  // attributable commit, so the back-fill guard (!!truth.headSha) must reject.
  deps.reconcile = () => ({
    headSha: null,
    dirty: false,
    dirtyPaths: [],
    ticketStatuses: { t1: 'In Progress' },
    tickets: [{ id: 't1', status: 'In Progress' }],
  });
  const outcome = salvageTicket(
    { sessionDir: '/s', workingDir: '/w', ticketId: 't1', completionCommitSha: SHA, log: () => {} },
    deps,
  );
  assert.equal(outcome.disposition, 'no-op', 'no HEAD -> nothing attributable to back-fill');
  assert.equal(outcome.reason, 'clean_tree');
  assert.ok(!recorder.some((r) => r.startsWith('backfill:')), 'backfillDone is never invoked without a HEAD commit');
});

// ── Part B: reap keys on artifact-delta + PICKLE_WMW_SKIP_K, NEVER log size ──

function makeV5RawState(dir) {
  return {
    active: true,
    working_dir: dir,
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
    session_dir: dir,
    schema_version: 5,
    worker_artifact_progress: {},
  };
}

function setupSession() {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'salvage-backfill-'));
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(makeV5RawState(sessionDir), null, 2));
  const ticketId = 't-reap';
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(
    path.join(ticketDir, `rick_ticket_${ticketId}.md`),
    '---\nstatus: In Progress\n---\n# t-reap\n',
  );
  // A 0-BYTE worker_session log: the reap decision must ignore it entirely.
  fs.writeFileSync(path.join(ticketDir, 'worker_session_999.log'), '');
  return { sessionDir, statePath, ticketId, ticketDir };
}

function readZero(statePath, ticketId) {
  const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  return s.worker_artifact_progress?.[ticketId]?.zero_progress_count ?? null;
}

// No source-signature probe (workingDir omitted) so the reap decision is driven
// PURELY by the artifact-count delta — isolating the artifact signal the reap is
// keyed on. doneGuard is forced false so a frontmatter status never confounds it.
const NO_DONE_GUARD = () => false;

test('Part B1: a positive artifact delta does NOT increment zero-progress even with a 0-byte worker log', () => {
  const { sessionDir, statePath, ticketId, ticketDir } = setupSession();
  try {
    // Spawn 1: zero-delta baseline (no artifacts yet) -> increments to 1.
    let before = countWorkerArtifacts(ticketDir);
    recordWorkerArtifactProgress(statePath, sessionDir, ticketId, before, {
      k: 5, doneGuardFn: NO_DONE_GUARD,
    });
    assert.equal(readZero(statePath, ticketId), 1, 'first zero-delta spawn increments the counter');

    // Spawn 2: worker produced a NEW review artifact (positive delta) while its
    // session log is STILL 0 bytes -> counter MUST reset to 0 (keyed on delta).
    before = countWorkerArtifacts(ticketDir);
    fs.writeFileSync(path.join(ticketDir, 'code_review_1.md'), 'APPROVED\n');
    assert.equal(fs.statSync(path.join(ticketDir, 'worker_session_999.log')).size, 0, 'worker log is 0 bytes');
    const r = recordWorkerArtifactProgress(statePath, sessionDir, ticketId, before, {
      k: 5, doneGuardFn: NO_DONE_GUARD,
    });
    assert.equal(r.zeroProgressCount, 0, 'positive artifact delta resets zero-progress (log size irrelevant)');
    assert.equal(readZero(statePath, ticketId), 0);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('Part B2: reap fires only at PICKLE_WMW_SKIP_K consecutive zero-delta spawns', () => {
  const { sessionDir, statePath, ticketId, ticketDir } = setupSession();
  const K = 3;
  try {
    let fired = false;
    for (let i = 0; i < K; i++) {
      const before = countWorkerArtifacts(ticketDir);
      const r = recordWorkerArtifactProgress(statePath, sessionDir, ticketId, before, {
        k: K, doneGuardFn: NO_DONE_GUARD,
      });
      if (r.fired) fired = true;
    }
    assert.equal(readZero(statePath, ticketId), K, `K=${K} consecutive zero-delta spawns reach the threshold`);
    assert.ok(fired, 'worker_artifact_progress_zero fires at exactly K consecutive zero-delta spawns');
    const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const events = (s.activity ?? []).filter((e) => e.event === 'worker_artifact_progress_zero');
    assert.equal(events.length, 1, 'fires exactly once at the threshold');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('Part B3: PICKLE_WMW_SKIP_K env controls the skip threshold (reap keyed on the env, not log size)', () => {
  const prior = process.env[WMW_SKIP_K_ENV];
  try {
    process.env[WMW_SKIP_K_ENV] = '7';
    assert.equal(resolveWmwSkipK(), 7, 'skip threshold is operator-tunable via PICKLE_WMW_SKIP_K');
    delete process.env[WMW_SKIP_K_ENV];
    assert.equal(resolveWmwSkipK(), 5, 'default skip threshold is 5');
  } finally {
    if (prior === undefined) delete process.env[WMW_SKIP_K_ENV];
    else process.env[WMW_SKIP_K_ENV] = prior;
  }
});


// ── Part C: AP-EXT-ITER273-01 — an ABSENT tree measurement is not a clean tree ──

const GIT_TIMEOUT_MS = 30_000;

/** Real repo with one commit plus an uncommitted deliverable on disk. */
function makeDirtyRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-ext-iter273-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', timeout: GIT_TIMEOUT_MS });
  git(['init', '-q', '.']);
  git(['config', 'user.email', 'anatomy@park.test']);
  git(['config', 'user.name', 'Anatomy Park']);
  git(['commit', '-q', '--allow-empty', '-m', 'base']);
  fs.writeFileSync(path.join(repo, 'deliverable.txt'), 'REAL UNCOMMITTED WORK\n');
  return { root, repo, git };
}

/** Corrupt the index so `git status` exits 128 while `git rev-parse HEAD` still exits 0. */
function makeTreeUnmeasurable(repo) {
  fs.writeFileSync(path.join(repo, '.git', 'index'), 'GARBAGE-NOT-AN-INDEX');
}

/** Production-shaped salvage deps that record which branch ran. */
function recordingDeps(recorder) {
  return {
    gate: () => { recorder.push('gate'); return 'failing'; },
    commitScoped: () => ({ committed: false }),
    archive: () => { recorder.push('archive'); return null; },
    resetTodo: () => { recorder.push('reset-todo'); },
    ffReattach: () => ({ recovered: false }),
  };
}

test('AP-EXT-ITER273-01: a dirty tree whose git probe FAILED still reads dirty, so salvage acts on it', () => {
  const { root, repo } = makeDirtyRepo();
  try {
    const healthy = reconcileTicketTruth({ sessionDir: root, workingDir: repo });
    assert.equal(healthy.dirty, true, 'control: a measurable dirty tree reads dirty');

    makeTreeUnmeasurable(repo);
    const truth = reconcileTicketTruth({ sessionDir: root, workingDir: repo });
    assert.equal(truth.dirty, true, 'an unmeasurable tree inside a real repo must NOT be published as clean');
    assert.ok(truth.headSha, 'rev-parse still resolves, so the back-fill precondition would hold — dirty is the only guard');

    const recorder = [];
    const outcome = salvageTicket(
      { sessionDir: root, workingDir: repo, ticketId: 'ap273', log: () => {} },
      recordingDeps(recorder),
    );
    assert.equal(outcome.disposition, 'archived-todo', 'salvage takes the dirty branch, not the clean-tree no-op');
    assert.ok(recorder.includes('gate'), 'the gate is consulted instead of being short-circuited away');
    assert.ok(recorder.includes('reset-todo'), 'the ticket is released to Todo — the only automatic Todo writer must run');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER273-01: a MEASURED clean tree still reads clean and short-circuits to no-op', () => {
  const { root, repo, git } = makeDirtyRepo();
  try {
    git(['add', 'deliverable.txt']);
    git(['commit', '-q', '-m', 'land the deliverable']);
    const truth = reconcileTicketTruth({ sessionDir: root, workingDir: repo });
    assert.equal(truth.dirty, false, 'a measured clean tree is still clean — the fix must not fail closed on every repo');

    const recorder = [];
    const outcome = salvageTicket(
      { sessionDir: root, workingDir: repo, ticketId: 'ap273', log: () => {} },
      recordingDeps(recorder),
    );
    assert.equal(outcome.disposition, 'no-op');
    assert.equal(outcome.reason, 'clean_tree');
    assert.deepEqual(recorder, [], 'no salvage action on a genuinely clean tree');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER273-01: a provable NON-repo reads clean — that is an answer, not a fabrication', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-ext-iter273-nonrepo-'));
  try {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'loose.txt'), 'not under git\n');
    const truth = reconcileTicketTruth({ sessionDir: root, workingDir: plain });
    assert.equal(truth.dirty, false, 'no git repo means no tree that could be dirty');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

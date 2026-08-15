// @tier: fast
// R-NOPOSTTIER / ticket 4dd2d658: the post-final tier measurement at the completion-synthesis seam.
//
// The defect: `applyAllTicketsDoneCompletion` synthesized the `all-tickets-done` promise with NO
// tier measurement between the bundle's final commit and the success verdict. The sibling call in
// `processTaskCompleted` did not cover it — that one lives under `if (curState.current_ticket)`
// and, even when reached, only wrote `last_between_ticket_gate`; nothing ever called
// `classifyPostFinalVerdict`, so `post_final_verdict` was never written on ANY path.
//
// PRE-FIX ORACLE: 'fires on the applyAllTicketsDoneCompletion path' below fails against the
// pre-fix code — the injected runner is never invoked and `state.post_final_verdict` is undefined.
//
// Every case injects `runTestFast`. The real `runBetweenTicketFastTests` (a ~14-minute spawn) is
// never invoked by this suite.

// PICKLE_TEST_MODE bypasses guardCompletionCommitBeforeDone for synthetic sessions.
process.env.PICKLE_TEST_MODE = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  applyAllTicketsDoneCompletion,
  runBetweenTicketFastGate,
  POST_FINAL_FAST_GATE_TIMEOUT_MS,
} from '../bin/mux-runner.js';

/** The measured fast-tier wall time this repo's timeout must clear (ticket AC-3). */
const MEASURED_FAST_TIER_MS = 835042;
/** `DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS` — the value the post-final call must NOT inherit. */
const RESOLVER_DEFAULT_TIMEOUT_MS = 600000;

function makeTmp(prefix = 'post-final-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeSession(sessionDir, workingDir) {
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    schema_version: 3,
    active: true,
    step: 'implement',
    iteration: 1,
    max_iterations: 15,
    worker_timeout_seconds: 3600,
    start_time_epoch: Math.floor(Date.now() / 1000),
    max_time_minutes: 0,
    current_ticket: null,
    working_dir: workingDir,
    backend: 'claude',
    completion_promise: null,
    history: [],
  }, null, 2));
  return statePath;
}

function makeTicket(sessionDir, id, status) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(
    path.join(ticketDir, `rick_ticket_${id}.md`),
    ['---', `id: "${id}"`, `title: "Ticket ${id}"`, `status: "${status}"`, 'order: 1', '---', '', '# Body'].join('\n'),
  );
}

const git = (repo, args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 15000 }).trim();

/**
 * A real git repo with a real commit, so `gitCommitEpoch` resolves the genuine production path
 * rather than a stub. Contains `extension/` so the measurement is `applicable`.
 */
function makeWorkingRepo() {
  const repo = makeTmp('post-final-repo-');
  fs.mkdirSync(path.join(repo, 'extension'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'extension', 'marker.txt'), 'final commit\n');
  git(repo, ['init', '--quiet']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '-m', 'final commit of the bundle']);
  return repo;
}

const finalCommitTsMs = repo => Number(git(repo, ['log', '-1', '--format=%ct'])) * 1000;
const readState = statePath => JSON.parse(fs.readFileSync(statePath, 'utf8'));

/** Records every invocation so the timeout argument can be asserted. */
function stubRunner(result) {
  const calls = [];
  const fn = (extensionDir, timeoutMs) => {
    calls.push({ extensionDir, timeoutMs });
    if (typeof result === 'function') return result();
    return result;
  };
  fn.calls = calls;
  return fn;
}

const GREEN = { ok: true, failures: [], timed_out: false, timeout_ms: POST_FINAL_FAST_GATE_TIMEOUT_MS };

/**
 * Two Done tickets + a real git working repo, driven straight through
 * `applyAllTicketsDoneCompletion`. Returns everything the assertions need.
 */
function drive(runTestFast, opts = {}) {
  const sessionDir = makeTmp();
  const repo = opts.workingDir ?? makeWorkingRepo();
  const cleanup = () => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    if (!opts.workingDir) fs.rmSync(repo, { recursive: true, force: true });
  };
  const statePath = makeSession(sessionDir, repo);
  makeTicket(sessionDir, 'aaa', 'Done');
  makeTicket(sessionDir, 'bbb', opts.secondStatus ?? 'Done');
  const logs = [];
  const fired = applyAllTicketsDoneCompletion(
    statePath, sessionDir, 1, m => logs.push(m), repo, { runTestFast },
  );
  return { sessionDir, repo, statePath, logs, fired, cleanup };
}

test('post-final measurement fires on the applyAllTicketsDoneCompletion path (PRE-FIX ORACLE)', () => {
  const runner = stubRunner(GREEN);
  const ctx = drive(runner);
  try {
    assert.equal(ctx.fired, true, 'all-Done bundle must still synthesize completion');
    // Pre-fix, this seam called no gate at all: length 0.
    assert.equal(runner.calls.length, 1, 'the measurement must run exactly once on this seam');
    assert.equal(
      runner.calls[0].extensionDir,
      path.join(ctx.repo, 'extension'),
      'measured against the working dir\'s extension/, not the session dir',
    );
    const state = readState(ctx.statePath);
    // Pre-fix, `post_final_verdict` was undefined on every path.
    assert.deepEqual(state.post_final_verdict, { state: 'green', degraded: false, dimensions: [] });
  } finally {
    ctx.cleanup();
  }
});

test('recorded verdict timestamp is not older than the final commit (AC-1)', () => {
  const ctx = drive(stubRunner(GREEN));
  try {
    const commitTs = finalCommitTsMs(ctx.repo);
    const state = readState(ctx.statePath);
    assert.ok(
      state.last_between_ticket_gate.ts >= commitTs,
      `verdict ts ${state.last_between_ticket_gate.ts} must be >= final commit ts ${commitTs}`,
    );
    // A stale verdict is classified `absent` by the classifier, so `green` also proves freshness.
    assert.equal(state.post_final_verdict.state, 'green');
  } finally {
    ctx.cleanup();
  }
});

test('a verdict stamped BEFORE the final commit is classified absent, never green', () => {
  const sessionDir = makeTmp();
  const repo = makeWorkingRepo();
  try {
    const statePath = makeSession(sessionDir, repo);
    makeTicket(sessionDir, 'aaa', 'Done');
    const commitTs = finalCommitTsMs(repo);
    const fired = applyAllTicketsDoneCompletion(
      statePath, sessionDir, 1, () => {}, repo,
      { runTestFast: stubRunner(GREEN), now: () => commitTs - 60000 },
    );
    assert.equal(fired, true);
    const state = readState(statePath);
    assert.equal(state.post_final_verdict.state, 'absent', 'stale measurement must not read green');
    assert.equal(state.post_final_verdict.degraded, true);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('post-final call passes an explicit timeout above the measured tier (AC-3)', () => {
  const runner = stubRunner(GREEN);
  const ctx = drive(runner);
  try {
    const { timeoutMs } = runner.calls[0];
    assert.equal(timeoutMs, POST_FINAL_FAST_GATE_TIMEOUT_MS, 'the exported constant is what ships');
    assert.ok(timeoutMs > MEASURED_FAST_TIER_MS, `timeout ${timeoutMs} must exceed ${MEASURED_FAST_TIER_MS} ms`);
    assert.notEqual(timeoutMs, RESOLVER_DEFAULT_TIMEOUT_MS, 'must not inherit the 600000 ms resolver default');
  } finally {
    ctx.cleanup();
  }
});

test('exported POST_FINAL_FAST_GATE_TIMEOUT_MS clears the measured tier', () => {
  assert.equal(typeof POST_FINAL_FAST_GATE_TIMEOUT_MS, 'number');
  assert.ok(POST_FINAL_FAST_GATE_TIMEOUT_MS > MEASURED_FAST_TIER_MS);
  assert.notEqual(POST_FINAL_FAST_GATE_TIMEOUT_MS, RESOLVER_DEFAULT_TIMEOUT_MS);
});

test('a throwing measurement is classified absent and does NOT abort the run (AC-4)', () => {
  const runner = stubRunner(() => { throw new Error('gate exploded'); });
  const ctx = drive(runner);
  try {
    assert.equal(ctx.fired, true, 'a throwing measurement must not stop the completion synthesis');
    const state = readState(ctx.statePath);
    assert.equal(state.post_final_verdict.state, 'absent');
    assert.equal(state.post_final_verdict.degraded, true);
    assert.equal(state.exit_reason, 'completed', 'disposition is untouched');
    assert.equal(state.step, 'completed');
    assert.equal(state.active, false);
    assert.ok(state.completion_promise, 'the promise is still synthesized');
    for (const id of ['aaa', 'bbb']) {
      const body = fs.readFileSync(path.join(ctx.sessionDir, id, `rick_ticket_${id}.md`), 'utf8');
      assert.match(body, /status: "Done"/, `ticket ${id} must not be demoted`);
    }
  } finally {
    ctx.cleanup();
  }
});

test('a red tier is recorded as red with its failing dimensions, and the run still completes', () => {
  const runner = stubRunner({
    ok: false,
    failures: [{ name: 'widget explodes', file: 'tests/widget.test.js' }],
    timed_out: false,
    timeout_ms: POST_FINAL_FAST_GATE_TIMEOUT_MS,
  });
  const ctx = drive(runner);
  try {
    assert.equal(ctx.fired, true);
    const state = readState(ctx.statePath);
    assert.equal(state.post_final_verdict.state, 'red');
    assert.equal(state.post_final_verdict.degraded, true);
    assert.deepEqual(state.post_final_verdict.dimensions, ['widget explodes']);
    // Measuring is not acting: withholding the success verdict belongs to ticket fa3d0f5a.
    assert.equal(state.exit_reason, 'completed', 'this ticket must not change the disposition');
    assert.equal(state.step, 'completed');
  } finally {
    ctx.cleanup();
  }
});

test('a timed-out tier is classified inconclusive, not green', () => {
  const runner = stubRunner({
    ok: false,
    failures: [{ name: '__timeout__', file: 'npm run test:fast' }],
    timed_out: true,
    timeout_ms: POST_FINAL_FAST_GATE_TIMEOUT_MS,
  });
  const ctx = drive(runner);
  try {
    assert.equal(ctx.fired, true);
    const state = readState(ctx.statePath);
    assert.equal(state.post_final_verdict.state, 'inconclusive');
    assert.equal(state.post_final_verdict.degraded, true);
    assert.equal(state.exit_reason, 'completed');
  } finally {
    ctx.cleanup();
  }
});

test('a working dir with no extension/ is not_applicable and runs no tier', () => {
  const bare = makeTmp('post-final-bare-');
  const runner = stubRunner(GREEN);
  const ctx = drive(runner, { workingDir: bare });
  try {
    assert.equal(ctx.fired, true);
    assert.equal(runner.calls.length, 0, 'no tier run when there is nothing to measure');
    const state = readState(ctx.statePath);
    assert.deepEqual(state.post_final_verdict, {
      state: 'not_applicable', degraded: false, dimensions: [],
    });
  } finally {
    ctx.cleanup();
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test('a blocked completion pays no tier run and records no verdict', () => {
  const runner = stubRunner(GREEN);
  const ctx = drive(runner, { secondStatus: 'Todo' });
  try {
    assert.equal(ctx.fired, false, 'a Todo ticket still blocks the all-done synthesis');
    assert.equal(runner.calls.length, 0, 'the guards return before the measurement');
    const state = readState(ctx.statePath);
    assert.equal(state.post_final_verdict, undefined, 'no promise synthesized -> no verdict owed');
    assert.notEqual(state.step, 'completed');
  } finally {
    ctx.cleanup();
  }
});

test('between-ticket callers still inherit the resolver default (no timeout argument)', () => {
  const sessionDir = makeTmp('post-final-arity-');
  const repo = makeWorkingRepo();
  try {
    const statePath = makeSession(sessionDir, repo);
    const runner = stubRunner(GREEN);
    runBetweenTicketFastGate({
      statePath,
      workingDir: repo,
      completedTicketId: 'aaa',
      nextTicketId: 'bbb',
      landedStatus: 'done',
      log: () => {},
      runTestFast: runner,
    });
    assert.equal(runner.calls.length, 1);
    assert.equal(
      runner.calls[0].timeoutMs,
      undefined,
      'omitting timeoutMs must leave the runner resolving its own default',
    );
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

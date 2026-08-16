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
  runPostFinalMeasurement,
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

/** An initialized repo containing `extension/`, so the measurement is `applicable`. No commit yet. */
function initRepo(prefix) {
  const repo = makeTmp(prefix);
  fs.mkdirSync(path.join(repo, 'extension'), { recursive: true });
  git(repo, ['init', '--quiet']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  return repo;
}

/**
 * A real git repo with a real commit, so `gitCommitEpoch` resolves the genuine production path
 * rather than a stub.
 */
function makeWorkingRepo() {
  const repo = initRepo('post-final-repo-');
  fs.writeFileSync(path.join(repo, 'extension', 'marker.txt'), 'final commit\n');
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
    statePath, sessionDir, 1, m => logs.push(m), repo, { runTestFast, ...opts.deps },
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
  const repo = makeWorkingRepo();
  const staleTs = finalCommitTsMs(repo) - 60000;
  const ctx = drive(stubRunner(GREEN), { workingDir: repo, deps: { now: () => staleTs } });
  try {
    assert.equal(ctx.fired, true);
    const state = readState(ctx.statePath);
    assert.equal(state.post_final_verdict.state, 'absent', 'stale measurement must not read green');
    assert.equal(state.post_final_verdict.degraded, true);
  } finally {
    ctx.cleanup();
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

// AC-11: a bundle that committed nothing reports green and is NOT degraded. The classifier's
// `finalCommitTs: null` cases pin the logic; this pins the SEAM, where that null is produced by the
// production `readHeadCommit`/`gitCommitEpoch` probes against a real commit-less repo rather than
// injected. Both directions are asserted in one place on purpose: the green half alone would also
// pass under a regression that laundered an unknown commit time straight to green, and the red half
// is what forbids it.
test('AC-11: a bundle with no commit at all reports green, and a red tier still reports red', () => {
  const repo = initRepo('post-final-emptyrepo-');
  const greenSession = makeTmp('post-final-empty-green-');
  const redSession = makeTmp('post-final-empty-red-');
  try {
    const greenRunner = stubRunner(GREEN);
    const greenVerdict = runPostFinalMeasurement({
      statePath: makeSession(greenSession, repo),
      workingDir: repo,
      completedTicketId: 'aaa',
      log: () => {},
      runTestFast: greenRunner,
    });
    // Without this the case could pass as `not_applicable` — a different non-degraded state
    // reached for the wrong reason, since that arm never runs the tier at all.
    assert.equal(greenRunner.calls.length, 1, 'the tier must actually have been measured');
    assert.deepEqual(greenVerdict, { state: 'green', degraded: false, dimensions: [] });
    assert.deepEqual(
      readState(path.join(greenSession, 'state.json')).post_final_verdict,
      { state: 'green', degraded: false, dimensions: [] },
    );

    const redRunner = stubRunner({
      ok: false,
      failures: [{ name: 'real_regression', file: 'tests/x.test.js' }],
      timed_out: false,
      timeout_ms: POST_FINAL_FAST_GATE_TIMEOUT_MS,
    });
    const redVerdict = runPostFinalMeasurement({
      statePath: makeSession(redSession, repo),
      workingDir: repo,
      completedTicketId: 'aaa',
      log: () => {},
      runTestFast: redRunner,
    });
    assert.equal(redRunner.calls.length, 1);
    assert.equal(redVerdict.state, 'red', 'an unknown commit time must not launder a red tier green');
    assert.equal(redVerdict.degraded, true);
  } finally {
    for (const d of [repo, greenSession, redSession]) fs.rmSync(d, { recursive: true, force: true });
  }
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

test('a throwing clock still RECORDS a verdict — surviving is not enough (f7f188f4)', () => {
  // Ticket f7f188f4 (audit, HIGH). The clock read used to sit ABOVE the measurement's own try, so
  // a throwing clock escaped `runPostFinalMeasurement` entirely: the seam-level wrap in
  // `applyAllTicketsDoneCompletion` kept the run alive, but `state.post_final_verdict` was never
  // written. An UNWRITTEN verdict is not neutral — `pipeline-runner.ts:readDegradedPostFinalVerdict`
  // reads an absent field as null, i.e. non-degraded, i.e. report success. So "the run survived"
  // and "the tier was honestly reported" are different facts, and this case used to assert only
  // the first. It now asserts both.
  const ctx = drive(stubRunner(GREEN), {
    deps: { now: () => { throw new Error('clock exploded'); } },
  });
  try {
    assert.equal(ctx.fired, true, 'the completion synthesis must survive any measurement throw');
    const state = readState(ctx.statePath);
    assert.equal(state.exit_reason, 'completed', 'measuring is not acting — disposition untouched');
    assert.equal(state.step, 'completed');
    assert.ok(state.completion_promise, 'the promise is still synthesized');
    assert.deepEqual(
      state.post_final_verdict,
      { state: 'absent', degraded: true, dimensions: [] },
      'a throw must be recorded as absent/degraded, never left unwritten',
    );
    // The throw is now caught by the measurement's own catch, so it is that log that fires — the
    // seam-level wrap in applyAllTicketsDoneCompletion is no longer reached on this path.
    assert.ok(
      ctx.logs.some(l => l.includes('post-final tier measurement threw (classified absent)')),
      'the measurement catch must log the swallowed failure',
    );
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
    // AC-4b at the SEAM, not just the classifier: `__timeout__` is the gate's own sentinel, not a
    // test that failed, so it must not reach the persisted dimension list where an operator would
    // read it as a failing test name.
    assert.deepEqual(state.post_final_verdict.dimensions, []);
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

// Ticket f7f188f4 (audit, CRITICAL): `not_applicable` is a POSITIVE fact — we looked and the repo
// ships no `extension/` tier. A BLANK working dir is the UNKNOWN. Before the fix both took the
// same `applicable: false` arm, so "we could not look" classified `not_applicable`,
// `degraded: false` — and `pipeline-runner.ts:readDegradedPostFinalVerdict` reads a non-degraded
// verdict as fine, so a red tier under an unreadable working dir reported SUCCESS. That is the
// fake-GREEN direction of the exact collapse this bundle exists to prevent.
//
// The two cases below are a matched pair and must stay that way: the blank-dir case alone would
// also pass under a regression that collapsed BOTH inputs to `absent`, which would fake-RED every
// off-repo bundle and break the repo-agnostic invariant. The `not_applicable` control is what
// proves the fix DISTINGUISHES them rather than merging them the other way.
test('a BLANK working dir is absent/degraded, never not_applicable (f7f188f4)', () => {
  const sessionDir = makeTmp('post-final-blankwd-');
  const statePath = makeSession(sessionDir, '');
  const runner = stubRunner(GREEN);
  try {
    const verdict = runPostFinalMeasurement({
      statePath,
      workingDir: '',
      completedTicketId: 'aaa',
      log: () => {},
      runTestFast: runner,
    });
    assert.equal(runner.calls.length, 0, 'an unknown working dir must not spawn a tier run');
    // The returned verdict and the persisted one must agree — a divergence here is the same
    // write-vs-read defect class the audit is tracing.
    const expected = { state: 'absent', degraded: true, dimensions: [] };
    assert.deepEqual(verdict, expected, 'returned verdict');
    assert.deepEqual(readState(statePath).post_final_verdict, expected, 'persisted verdict');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('CONTROL: a real dir with no extension/ stays not_applicable, non-degraded (f7f188f4)', () => {
  const sessionDir = makeTmp('post-final-baredir-');
  const bare = makeTmp('post-final-bare-repo-');
  const statePath = makeSession(sessionDir, bare);
  const runner = stubRunner(GREEN);
  try {
    const verdict = runPostFinalMeasurement({
      statePath,
      workingDir: bare,
      completedTicketId: 'aaa',
      log: () => {},
      runTestFast: runner,
    });
    assert.equal(runner.calls.length, 0);
    const expected = { state: 'not_applicable', degraded: false, dimensions: [] };
    assert.deepEqual(verdict, expected, 'off-repo bundles must NOT be marked degraded');
    assert.deepEqual(readState(statePath).post_final_verdict, expected);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test('a throw BETWEEN the two applicability facts still lands on absent (f7f188f4)', () => {
  // The catch must guarantee `absent` structurally, not as a side effect of WHICH statement threw.
  // `workingDirKnown` is assigned before `applicable`, so a throw in the window between them used
  // to leave the pair `true`/`false` — and `applicable || !workingDirKnown` reads that exact pair
  // as `not_applicable`, the non-degraded arm. Same laundering as the blank-dir case, one
  // statement later.
  //
  // Driven with a workingDir whose `trim()` succeeds but which `path.join` then rejects. Contrived
  // by construction — the point is that the invariant holds for ANY throw, which is not something
  // a well-typed input can demonstrate.
  const sessionDir = makeTmp('post-final-midthrow-');
  const statePath = makeSession(sessionDir, 'x');
  const runner = stubRunner(GREEN);
  const logs = [];
  try {
    const verdict = runPostFinalMeasurement({
      statePath,
      workingDir: { trim: () => 'not-a-string-path' },
      completedTicketId: 'aaa',
      log: m => logs.push(m),
      runTestFast: runner,
    });
    assert.equal(runner.calls.length, 0, 'no tier run when applicability never resolved');
    const expected = { state: 'absent', degraded: true, dimensions: [] };
    assert.deepEqual(verdict, expected, 'returned verdict');
    assert.deepEqual(readState(statePath).post_final_verdict, expected, 'persisted verdict');
    assert.ok(
      logs.some(l => l.includes('post-final tier measurement threw (classified absent)')),
      'the throw must be logged, not silently swallowed',
    );
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// The measurement has TWO independent try blocks and only the first was covered. The second
// (`runPostFinalMeasurement`'s `sm.update` wrap) catches a state file that will not take the write
// and logs `post-final verdict not persisted (ignored)`. That branch is the one place where the
// RETURNED verdict and the PERSISTED verdict legitimately diverge — and
// `pipeline-runner.ts:readDegradedPostFinalVerdict` reads only the persisted one, so a degraded
// verdict that fails to persist is reported as success. The log line is the operator's only trail,
// which is exactly why it is asserted rather than assumed.
//
// A blank working dir is what isolates the branch: `applicable` is false, so the gate is never
// called and `runBetweenTicketFastGate`'s own unguarded `sm.update` never runs — the corrupt state
// file is therefore reached by the persist wrap ALONE, not by the measurement wrap upstream of it.
test('an unpersistable verdict is logged and returned, never thrown (the persist wrap)', () => {
  const sessionDir = makeTmp('post-final-nopersist-');
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, 'this is not json{');
  const runner = stubRunner(GREEN);
  const logs = [];
  try {
    const verdict = runPostFinalMeasurement({
      statePath,
      workingDir: '',
      completedTicketId: 'aaa',
      log: m => logs.push(m),
      runTestFast: runner,
    });

    assert.equal(runner.calls.length, 0, 'a blank working dir must not spawn a tier run');
    assert.deepEqual(
      verdict,
      { state: 'absent', degraded: true, dimensions: [] },
      'the classification is still correct — only the write failed',
    );
    assert.ok(
      logs.some(l => l.includes('post-final verdict not persisted (ignored)')),
      'the persist failure must be logged, not silently swallowed',
    );
    // The divergence this branch creates, pinned so it cannot widen unnoticed: the file is left
    // exactly as found, so nothing downstream can read a half-written verdict.
    assert.equal(fs.readFileSync(statePath, 'utf8'), 'this is not json{');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
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

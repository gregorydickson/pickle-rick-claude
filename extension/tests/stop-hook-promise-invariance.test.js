// @tier: fast
// R-NOPOSTTIER ticket 9aa67006 / AC-8: the `completion_promise` string is NOT modified by this
// bundle, and the stop hook still recognizes completion when the post-final verdict is degraded.
//
// This file used to assert that against a test-local `buildPromise()` reimplementation of the
// synthesis line, seeded into the fixture unconditionally — so the verdict was never an input and
// the assertion compared a test constant against a test constant. No mutation of the runtime could
// redden it. The tests below drive the REAL synthesis seam
// (`applyAllTicketsDoneCompletion`, mux-runner.ts) and feed its PERSISTED promise to the REAL
// consumer (`detectCompletionTokens`, stop-hook.ts), so folding a degraded marker into the promise
// fails here instead of passing quietly.

// PICKLE_TEST_MODE bypasses guardCompletionCommitBeforeDone for synthetic sessions.
process.env.PICKLE_TEST_MODE = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { applyAllTicketsDoneCompletion } from '../bin/mux-runner.js';
import { detectCompletionTokens, evaluateManagerIdleBackoff } from '../hooks/handlers/stop-hook.js';

/** The keys the promise carries, and the only keys it may ever carry. */
const PROMISE_KEYS = ['kind', 'reason', 'ts'];

function tmpDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const git = (repo, args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 15000 }).trim();

/** A real repo with `extension/` (so the measurement is applicable) and a real final commit. */
function makeWorkingRepo() {
  const repo = tmpDir('promise-invariance-repo-');
  fs.mkdirSync(path.join(repo, 'extension'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'extension', 'marker.txt'), 'final commit\n');
  git(repo, ['init', '--quiet']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '-m', 'final commit of the bundle']);
  return repo;
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
    original_prompt: 'test task',
    history: [],
  }, null, 2));
  return statePath;
}

function makeTicket(sessionDir, id) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(
    path.join(ticketDir, `rick_ticket_${id}.md`),
    ['---', `id: "${id}"`, `title: "Ticket ${id}"`, 'status: "Done"', 'order: 1', '---', '', '# Body'].join('\n'),
  );
}

// AP-EXT-ITER157-02: both stubs declare `measured: true`. `ok` is only the tier's EXIT CODE;
// a gate that omits the did-it-RUN axis is not a gate result and classifies `absent`, which
// would make BOTH arms of this invariance pair degraded and hide the very difference it pins.
const GREEN_GATE = () => ({ ok: true, failures: [], timed_out: false, timeout_ms: 1_800_000, measured: true });
const RED_GATE = () => ({ ok: false, failures: [], timed_out: false, timeout_ms: 1_800_000, measured: true });

/**
 * Drives the real all-tickets-done synthesis under an injected gate and returns the state it
 * persisted. Each call builds its own session and repo — no fixture is shared between cases.
 */
function synthesize(runTestFast) {
  const sessionDir = tmpDir('promise-invariance-session-');
  const repo = makeWorkingRepo();
  try {
    const statePath = makeSession(sessionDir, repo);
    makeTicket(sessionDir, 'aaa11111');
    makeTicket(sessionDir, 'bbb22222');
    const fired = applyAllTicketsDoneCompletion(
      statePath, sessionDir, 1, () => {}, repo, { runTestFast },
    );
    assert.equal(fired, true, 'the all-Done bundle must synthesize its completion promise');
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

test('AC-8: the SHIPPED promise carries exactly {kind,reason,ts} under a degraded verdict', () => {
  const state = synthesize(RED_GATE);

  // The fixture is only meaningful if the verdict genuinely went degraded — otherwise this is the
  // green case wearing a red label and proves nothing about the degraded path.
  assert.equal(state.post_final_verdict.state, 'red');
  assert.equal(state.post_final_verdict.degraded, true);

  const parsed = JSON.parse(state.completion_promise);
  assert.deepEqual(Object.keys(parsed), PROMISE_KEYS, 'no verdict field may join the promise');
  assert.equal(parsed.kind, 'EPIC_COMPLETED');
  assert.equal(parsed.reason, 'all-tickets-done');
});

test('AC-8: green and degraded runs synthesize a byte-identical promise apart from `ts`', () => {
  const green = synthesize(GREEN_GATE);
  const red = synthesize(RED_GATE);

  assert.equal(green.post_final_verdict.degraded, false, 'the green run must not be degraded');
  assert.equal(red.post_final_verdict.degraded, true, 'the red run must be degraded');

  // `ts` is the only field allowed to differ between two runs; everything else is the contract the
  // stop hook matches literally, so it must not move with the verdict.
  const strip = (raw) => {
    const o = JSON.parse(raw);
    delete o.ts;
    return o;
  };
  assert.deepEqual(strip(red.completion_promise), strip(green.completion_promise));
  assert.equal(
    red.completion_promise.length,
    green.completion_promise.length,
    'a degraded run must not lengthen the promise string either',
  );
});

test('AC-8: the stop hook still recognizes completion under a degraded verdict', () => {
  const state = synthesize(RED_GATE);
  assert.equal(state.post_final_verdict.degraded, true);

  const transcript = `manager chatter <promise>${state.completion_promise}</promise> trailing`;
  const result = detectCompletionTokens(transcript, state);

  assert.equal(result.kind, 'completion-promise', 'a degraded run must still be able to terminate');
  assert.equal(result.promise, state.completion_promise);
});

test('AC-8: the stop hook still recognizes completion under a green verdict', () => {
  const state = synthesize(GREEN_GATE);
  assert.equal(state.post_final_verdict.degraded, false);

  const transcript = `manager chatter <promise>${state.completion_promise}</promise> trailing`;
  assert.equal(detectCompletionTokens(transcript, state).kind, 'completion-promise');
});

// The five verdict states the classifier can produce, checked against the consumer rather than the
// producer: whatever a future author records in `post_final_verdict`, the stop hook keys on
// `completion_promise` alone and must keep terminating the loop.
test('AC-8: every post_final_verdict state still terminates the loop', () => {
  const base = synthesize(GREEN_GATE);
  const transcript = `<promise>${base.completion_promise}</promise>`;

  for (const verdictState of ['green', 'red', 'inconclusive', 'absent', 'not_applicable']) {
    const state = {
      ...base,
      post_final_verdict: { state: verdictState, degraded: verdictState !== 'green', dimensions: [] },
    };
    assert.equal(
      detectCompletionTokens(transcript, state).kind,
      'completion-promise',
      `verdict state "${verdictState}" must not block completion detection`,
    );
  }
});

// AP-EXT-ITER4-01 (subsystem contract #1): the stop hook's CLI entry guard must survive a
// symlinked install root. `dispatch.ts` builds the handler argv from
// `EXTENSION_DIR || join(os.homedir(), '.claude/pickle-rick')` and never realpaths it, while Node
// DOES realpath `import.meta.url`. The pre-fix realpath-exact compare therefore disagreed with
// itself through `install.sh --prefix <symlinked path>` (any macOS `/tmp`/`/var` prefix, or a
// relocated `$HOME`): `main()` never ran, the hook emitted nothing, and dispatch's "no valid
// decision JSON" arm fell back to approve — the Stop hook approved the stop and the pipeline loop
// ended with no exit_reason and no error.
//
// Drives the SHIPPED handler as a real subprocess through a real symlink and asserts the EMITTED
// DECISION. An argv/source oracle (grepping for the guard shape) is deliberately avoided: it greens
// the moment someone swaps one realpath-exact form for another, which is exactly how the sibling
// `auto-fill-completion-commit.ts` carried the same defect under a different spelling.
const SHIPPED_STOP_HOOK = path.join(import.meta.dirname, '..', 'hooks', 'handlers', 'stop-hook.js');

/** Runs the shipped stop-hook with empty stdin under a hermetic data/extension root. */
function runShippedStopHook(scriptPath, tmp) {
  return execFileSync(process.execPath, [scriptPath], {
    input: '',
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, PICKLE_DATA_ROOT: path.join(tmp, 'data'), EXTENSION_DIR: path.join(tmp, 'ext') },
  }).trim();
}

test('AP-EXT-ITER4-01: the stop hook still emits a decision through a symlinked install root', () => {
  const tmp = tmpDir('stop-hook-symlink-root-');
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ext'), { recursive: true });

  // A symlinked handlers dir reproduces the `--prefix`/relocated-$HOME relationship on ANY
  // platform: argv[1] carries the link, `import.meta.url` resolves to the target.
  const linkedHandlers = path.join(tmp, 'handlers-link');
  fs.symlinkSync(path.dirname(SHIPPED_STOP_HOOK), linkedHandlers);

  const throughSymlink = runShippedStopHook(path.join(linkedHandlers, 'stop-hook.js'), tmp);
  assert.notEqual(
    throughSymlink,
    '',
    'stop hook produced NO output through a symlinked install root — dispatch falls back to approve and the loop ends silently',
  );
  assert.equal(JSON.parse(throughSymlink).decision, 'approve');

  // Control: the same invocation through the real path must behave identically, so a future
  // regression is attributable to the symlink axis and not to the hermetic env.
  const throughRealPath = runShippedStopHook(SHIPPED_STOP_HOOK, tmp);
  assert.deepEqual(JSON.parse(throughSymlink), JSON.parse(throughRealPath));
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER233-01: the idle-backoff gate must not claim a COMPLETION turn.
//
// `evaluateManagerIdleBackoff` runs BEFORE `classifyDecisionInternal` and the two are joined
// by `??`, so any turn the gate returns a decision for is a turn the token reader NEVER sees.
// Its wait matchers are unanchored substrings, so a manager that narrates a worker and signs
// off in the same response was claimed by the gate: token unread, no completion activity,
// and the turn BLOCKED back into the model. Measured live in session 2026-09-06-f625727a
// (15:19:14.666): `isTaskFinished=true` and `Decision: BLOCK` on the same 2638-char turn.
//
// Asserted against the REAL exported gate, not a source grep — the null/decision return IS
// the observable, and a source oracle greens on any respelling of the guard.

/** A session dir shaped the way the gate requires: a current ticket and a real session_dir. */
function makeIdleBackoffState() {
  const sessionDir = tmpDir('idle-backoff-session-');
  fs.mkdirSync(path.join(sessionDir, 'ticket-a'), { recursive: true });
  const stateFile = path.join(sessionDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ active: true }));
  return { sessionDir, stateFile, state: { session_dir: sessionDir, current_ticket: 'ticket-a' } };
}

// The live shape: narration that trips the unanchored `worker still` matcher, plus a sign-off.
const NARRATED_COMPLETION =
  'The worker still had a failing assertion, so I re-ran the tier and it is green now.\n\n' +
  '<promise>TASK_COMPLETED</promise>';

test('AP-EXT-ITER233-01: a wait-matching turn that carries an actionable token is left to the token classifier', () => {
  const { stateFile, state } = makeIdleBackoffState();

  // Precondition: the token reader really does see a completion token in this transcript,
  // so a null return below cannot be explained by the transcript lacking one.
  assert.equal(detectCompletionTokens(NARRATED_COMPLETION, state).kind, 'task-completed');

  const decision = evaluateManagerIdleBackoff(state, stateFile, NARRATED_COMPLETION, '');
  assert.equal(
    decision,
    null,
    'idle-backoff gate claimed a turn carrying TASK_COMPLETED — the token reader never runs and the completion is blocked',
  );
});

test('AP-EXT-ITER233-01: a genuine idle wait turn is still claimed and still blocks', () => {
  const { stateFile, state } = makeIdleBackoffState();

  // Narrowness control: strip ONLY the token and the gate must resume owning the turn.
  const idleOnly = NARRATED_COMPLETION.replace('<promise>TASK_COMPLETED</promise>', '');
  const decision = evaluateManagerIdleBackoff(state, stateFile, idleOnly, '');
  assert.notEqual(decision, null, 'gate stopped claiming a real idle wait turn — the backoff is now dead machinery');
  assert.equal(decision.decision, 'block');
});

test('AP-EXT-ITER233-01: a token this role may NOT act on does not release the gate', () => {
  const { stateFile, state } = makeIdleBackoffState();

  // `I AM DONE` is worker-only. A manager turn carrying it is NOT a completion turn, so a
  // bare `kind !== 'none'` release would wrongly hand this turn to the token classifier —
  // which would drop it too, since `roleAllowsToken` rejects it. This pins the conjunction.
  const workerToken = NARRATED_COMPLETION.replace('TASK_COMPLETED', 'I AM DONE');
  assert.equal(detectCompletionTokens(workerToken, state).kind, 'worker-done');

  const decision = evaluateManagerIdleBackoff(state, stateFile, workerToken, '');
  assert.notEqual(decision, null, 'gate released on a token the manager role cannot act on');
  assert.equal(decision.decision, 'block');
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER245-01: the idle-backoff artifact scanner selects by SUFFIX, never by a
// lifecycle-phase prefix list.
//
// `getWorkerArtifactMtimeMs` takes the MAX MTIME of the ticket dir and feeds the
// `artifact_landed` release, so "an artifact this list cannot name" and "the worker made no
// progress" were one answer. Same shape AP-EXT-ITER108-01 fixed in `maybeEmitManagerTurnProgress`.
//
// Asserted through the REAL exported gate — the release/block return IS the observable, and the
// `.log` control below is what keeps the fix from degenerating into "any file counts".

/** An engaged backoff snapshot whose ONLY unmet release condition is `artifact_landed`. */
function engagedBackoff(artifactMtimeMs) {
  const { sessionDir, stateFile, state } = makeIdleBackoffState();
  const engagedAtMs = Date.now();
  fs.writeFileSync(
    path.join(sessionDir, '.manager-idle-backoff.json'),
    JSON.stringify({
      consecutive_wait_turns: 3,
      engaged_at_ms: engagedAtMs,
      // Baselines the OTHER four release reasons out: state mtime unchanged, ticket unchanged,
      // pid alive (our own), and `nowMs` well inside the 60s fallback window.
      state_mtime_ms: fs.statSync(stateFile).mtimeMs,
      artifact_mtime_ms: artifactMtimeMs,
      worker_pid: process.pid,
      ticket: 'ticket-a',
    }),
  );
  return { ticketDir: path.join(sessionDir, 'ticket-a'), stateFile, state, nowMs: engagedAtMs + 1_000 };
}

const IDLE_TURN = 'Worker still running — continuing to wait for the monitor signal.';

// The blind names, measured: across 71 live ticket dirs the newest `.md` matched NO prefix in
// 71 of them — `rick_ticket_<hash>.md` in 68, `handoff_notes.md` in 3.
for (const artifact of ['handoff_notes.md', 'rick_ticket_ticket-a.md']) {
  test(`AP-EXT-ITER245-01: a landed ${artifact} releases the idle backoff`, () => {
    const { ticketDir, stateFile, state, nowMs } = engagedBackoff(1_000);
    fs.writeFileSync(path.join(ticketDir, artifact), '# progress\n');

    const decision = evaluateManagerIdleBackoff(state, stateFile, IDLE_TURN, '', () => {}, nowMs);
    assert.notEqual(decision, null, 'gate stopped claiming a real idle wait turn');
    assert.equal(
      decision.decision,
      'approve',
      `${artifact} landed and the backoff did not release — the scanner cannot name this artifact`,
    );
    assert.match(decision.logMessage, /artifact_landed/);
  });
}

test('AP-EXT-ITER245-01: a non-markdown ticket-dir file does NOT release the idle backoff', () => {
  // Narrowness control. `worker_session_<pid>.log` is appended to continuously while the worker
  // runs, so a scanner that dropped the suffix predicate entirely would release on every turn
  // and the backoff would be dead machinery.
  const { ticketDir, stateFile, state, nowMs } = engagedBackoff(1_000);
  fs.writeFileSync(path.join(ticketDir, `worker_session_${process.pid}.log`), 'chatter\n');

  const decision = evaluateManagerIdleBackoff(state, stateFile, IDLE_TURN, '', () => {}, nowMs);
  assert.notEqual(decision, null, 'gate stopped claiming a real idle wait turn');
  assert.equal(decision.decision, 'block', 'a worker log counted as a landed artifact — the backoff never engages');
});

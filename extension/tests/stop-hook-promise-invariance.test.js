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
import { detectCompletionTokens } from '../hooks/handlers/stop-hook.js';

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

const GREEN_GATE = () => ({ ok: true, failures: [], timed_out: false, timeout_ms: 1_800_000 });
const RED_GATE = () => ({ ok: false, failures: [], timed_out: false, timeout_ms: 1_800_000 });

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

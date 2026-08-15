// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCompletionTokens } from '../hooks/handlers/stop-hook.js';

// Mirrors the sole synthesis site: extension/src/bin/mux-runner.ts:2388
// `s.completion_promise = JSON.stringify({ kind: PromiseTokens.EPIC_COMPLETED, reason: 'all-tickets-done', ts });`
function buildPromise(ts) {
  return JSON.stringify({ kind: 'EPIC_COMPLETED', reason: 'all-tickets-done', ts });
}

const FIXED_TS = '2026-08-15T00:00:00.000Z';
const PINNED_PROMISE = '{"kind":"EPIC_COMPLETED","reason":"all-tickets-done","ts":"2026-08-15T00:00:00.000Z"}';

const VERDICT_CASES = [
  { label: 'green', post_final_verdict: { state: 'green', degraded: false, dimensions: [] } },
  { label: 'red', post_final_verdict: { state: 'red', degraded: true, dimensions: ['fast'] } },
  { label: 'inconclusive', post_final_verdict: { state: 'inconclusive', degraded: true, dimensions: [] } },
  { label: 'absent', post_final_verdict: { state: 'absent', degraded: false, dimensions: [] } },
  { label: 'not_applicable', post_final_verdict: { state: 'not_applicable', degraded: false, dimensions: [] } },
  { label: 'field-not-present', post_final_verdict: undefined },
];

function baseState(overrides = {}) {
  return {
    active: true,
    working_dir: process.cwd(),
    step: 'completed',
    iteration: 0,
    max_iterations: 50,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000) - 30,
    completion_promise: buildPromise(FIXED_TS),
    original_prompt: 'test task',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/pickle-promise-invariance-test',
    tmux_mode: false,
    ...overrides,
  };
}

test('completion_promise is byte-identical across all post_final_verdict states', () => {
  for (const c of VERDICT_CASES) {
    const state = baseState({ post_final_verdict: c.post_final_verdict });
    assert.equal(
      state.completion_promise,
      PINNED_PROMISE,
      `verdict state "${c.label}" must not alter the completion_promise shape`,
    );
  }
});

test('detectCompletionTokens recognizes completion under a green verdict', () => {
  const state = baseState({
    post_final_verdict: { state: 'green', degraded: false, dimensions: [] },
  });
  const transcript = `some manager chatter <promise>${state.completion_promise}</promise> trailing`;
  const result = detectCompletionTokens(transcript, state);
  assert.equal(result.kind, 'completion-promise');
});

test('detectCompletionTokens recognizes completion under a degraded verdict', () => {
  const state = baseState({
    post_final_verdict: { state: 'red', degraded: true, dimensions: ['fast'] },
  });
  const transcript = `some manager chatter <promise>${state.completion_promise}</promise> trailing`;
  const result = detectCompletionTokens(transcript, state);
  assert.equal(result.kind, 'completion-promise');
});

// AC-8 / mutation-sensitivity pin: a future author who folds the degraded marker into the promise
// itself must trip this assertion. See conformance artifact for the observed-failure record from
// manually mutating buildPromise() to add a `degraded` key and re-running this suite.
test('pinned promise template never carries verdict-state key names', () => {
  assert.equal(PINNED_PROMISE.includes('degraded'), false);
  assert.equal(PINNED_PROMISE.includes('"state"'), false);
  assert.deepEqual(Object.keys(JSON.parse(PINNED_PROMISE)), ['kind', 'reason', 'ts']);
});

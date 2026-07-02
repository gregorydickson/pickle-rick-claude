// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyDecision,
  detectCompletionTokens,
  detectDegenerateResponse,
} from '../hooks/handlers/stop-hook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'stop-hook');

function baseState(overrides = {}) {
  return {
    active: true,
    working_dir: process.cwd(),
    step: 'prd',
    iteration: 0,
    max_iterations: 50,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000) - 30,
    completion_promise: null,
    original_prompt: 'test task',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/pickle-helper-test',
    tmux_mode: false,
    ...overrides,
  };
}

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

function fixtureState(fixture) {
  return baseState(fixture.state || {});
}

const tokenCases = [
  ['custom completion promise', 'completion-promise', () => ({
    transcript: '<promise>CUSTOM_DONE</promise>',
    state: baseState({ completion_promise: 'CUSTOM_DONE' }),
  })],
  ['fixture token 1', 'epic-completed', () => readFixture('token-1.json')],
  ['fixture token 2', 'task-completed', () => readFixture('token-2.json')],
  ['fixture token 3', 'analysis-done', () => readFixture('token-3.json')],
  ['fixture token 4', 'review-clean', () => readFixture('token-4.json')],
  ['fixture token 6', 'worker-done', () => readFixture('token-6.json')],
  ['fixture token 7', 'prd-complete', () => readFixture('token-7.json')],
  ['fixture token 8', 'ticket-selected', () => readFixture('token-8.json')],
];

for (const [label, expectedKind, buildCase] of tokenCases) {
  test(`detectCompletionTokens: ${label} returns ${expectedKind}`, () => {
    const data = buildCase();
    const state = data.state?.working_dir ? data.state : fixtureState(data);
    assert.equal(detectCompletionTokens(data.transcript, state).kind, expectedKind);
  });
}

test('detectCompletionTokens: review-clean aliases classify to the same token kind', () => {
  const tokenA = readFixture('token-4.json');
  const tokenB = readFixture('token-5.json');
  assert.deepEqual(
    detectCompletionTokens(tokenA.transcript, fixtureState(tokenA)),
    detectCompletionTokens(tokenB.transcript, fixtureState(tokenB)),
  );
});

test('classifyDecision: review-clean aliases produce byte-identical decisions', () => {
  const fixture = readFixture('token-alias-equivalence.json');
  const state = fixtureState(fixture);
  const decisions = fixture.transcripts.map((transcript) => classifyDecision(state, transcript, fixture.role || ''));
  assert.equal(JSON.stringify(decisions[0]), JSON.stringify(decisions[1]));
  assert.equal(decisions[0].decision, fixture.expected_decision);
});

test('classifyDecision: token fixture replay matches expected decisions', () => {
  for (const name of fs.readdirSync(FIXTURE_DIR).filter((file) => /^token-.*\.json$/.test(file)).sort()) {
    const fixture = readFixture(name);
    if (Array.isArray(fixture.transcripts)) {
      for (const transcript of fixture.transcripts) {
        assert.equal(classifyDecision(fixtureState(fixture), transcript, fixture.role || '').decision, fixture.expected_decision, name);
      }
      continue;
    }
    assert.equal(
      classifyDecision(fixtureState(fixture), fixture.transcript, fixture.role || '').decision,
      fixture.expected_decision,
      name,
    );
  }
});

test('detectDegenerateResponse: short response approves without mutating input state (B-RSHM nudge retired)', () => {
  const state = baseState();
  const before = JSON.stringify(state);
  const result = detectDegenerateResponse(state, 'wait');
  assert.equal(JSON.stringify(state), before);
  assert.deepEqual(result, { decision: 'approve' });
});

test('classifyDecision: non-tmux default fallthrough approves (interactive loop retired)', () => {
  const result = classifyDecision(
    baseState({ tmux_mode: false, iteration: 3, max_iterations: 10 }),
    'Substantive progress update that is well above the degenerate length threshold.',
    '',
  );
  assert.equal(result.decision, 'approve');
  assert.match(result.logMessage, /interactive loop retired/i);
});

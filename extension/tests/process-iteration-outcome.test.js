// @tier: fast
// F3 / R-DWC: this test file uses synthetic temp-dir sessions whose workingDir
// is not a real git repo. The F3 completion_commit guard bypasses on
// PICKLE_TEST_MODE=1 per R-WSRC-4 sandbox parity; set it module-wide.
process.env.PICKLE_TEST_MODE = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  processRateLimitCycle,
  processIterationOutcome,
} from '../bin/mux-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, 'fixtures', 'mux-runner', 'rate-limit-cycle-2026-04.json');

function tmpSession() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-process-outcome-')));
  const statePath = path.join(dir, 'state.json');
  return { dir, statePath };
}

function baseState(overrides = {}) {
  return {
    active: true,
    iteration: 1,
    max_iterations: 10,
    min_iterations: 0,
    worker_timeout_seconds: 30,
    start_time_epoch: 1714080000,
    max_time_minutes: 60,
    step: 'implement',
    current_ticket: 't1',
    working_dir: process.cwd(),
    ...overrides,
  };
}

function baseOutcome(overrides = {}) {
  return {
    completion: 'continue',
    timedOut: false,
    exitCode: 0,
    wallSeconds: 1,
    ...overrides,
  };
}

function ctx(session, overrides = {}) {
  const logs = [];
  let now = 1714080000 * 1000;
  const context = {
    sessionDir: session.dir,
    statePath: session.statePath,
    extensionRoot: path.resolve('.'),
    iteration: 1,
    iterLogFile: path.join(session.dir, 'tmux_iteration_1.log'),
    log: (msg) => logs.push(msg),
    now: () => now,
    sleep: async (ms) => { now += ms; },
    readState: () => JSON.parse(fs.readFileSync(session.statePath, 'utf-8')),
    deactivate: () => {
      const state = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
      state.active = false;
      fs.writeFileSync(session.statePath, JSON.stringify(state, null, 2));
    },
    writeHandoff: (dir, content) => fs.writeFileSync(path.join(dir, 'handoff.txt'), content),
    writeTimeout: () => {},
    cbEnabled: false,
    ...overrides,
  };
  return { context, logs, setNow: (value) => { now = value; } };
}

function writeState(session, state) {
  fs.writeFileSync(session.statePath, JSON.stringify(state, null, 2));
}

function writeTicket(sessionDir, id, status, order = 1) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${id}.md`), [
    '---',
    `id: ${id}`,
    'title: Test ticket',
    `status: "${status}"`,
    `order: ${order}`,
    '---',
    '',
  ].join('\n'));
}

function withFrozenDate(epochMs, fn) {
  const original = Date.now;
  Date.now = () => epochMs;
  try {
    return fn();
  } finally {
    Date.now = original;
  }
}

test('processRateLimitCycle: rate-limit exhausted returns break', async () => {
  const session = tmpSession();
  try {
    writeState(session, baseState());
    const { context } = ctx(session, {
      exitResult: { type: 'api_limit' },
      consecutiveRateLimits: 3,
      maxRateLimitRetries: 3,
    });
    const action = await processRateLimitCycle(baseState(), context);
    assert.deepEqual({ kind: action.kind, reason: action.reason }, { kind: 'break', reason: 'rate_limit_exhausted' });
  } finally {
    fs.rmSync(session.dir, { recursive: true, force: true });
  }
});

test('processRateLimitCycle: max_time_minutes already exceeded at entry still parks (B3) — not its concern', async () => {
  // e9bdac75 B3: time-limit enforcement is the main loop's job, not the rate-limit cycle's.
  // Even with the wall-clock budget already blown at entry, the park proceeds and resumes
  // (continue) rather than short-circuiting with a 'limit' break.
  const session = tmpSession();
  try {
    const state = baseState({ max_time_minutes: 1 });
    writeState(session, state);
    const { context, setNow } = ctx(session, {
      exitResult: { type: 'api_limit', rateLimitInfo: { resetsAt: 1714083600 } },
      rateLimitWaitMinutes: 1,
      parkJitterMs: 0,
      sleep: async () => setNow(1714083601 * 1000),
    });
    setNow((1714080000 + 61) * 1000);
    const action = await withFrozenDate(1714080000 * 1000, () => processRateLimitCycle(state, context));
    assert.equal(action.kind, 'continue');
  } finally {
    fs.rmSync(session.dir, { recursive: true, force: true });
  }
});

test('processRateLimitCycle: cancelled during wait returns cancelled break', async () => {
  const session = tmpSession();
  try {
    const state = baseState();
    writeState(session, state);
    let reads = 0;
    const { context } = ctx(session, {
      exitResult: { type: 'api_limit', rateLimitInfo: { resetsAt: 1714083600 } },
      readState: () => {
        reads++;
        return reads > 1 ? { ...state, active: false } : state;
      },
    });
    const action = await withFrozenDate(1714080000 * 1000, () => processRateLimitCycle(state, context));
    assert.deepEqual({ kind: action.kind, reason: action.reason }, { kind: 'break', reason: 'cancelled' });
  } finally {
    fs.rmSync(session.dir, { recursive: true, force: true });
  }
});

test('processRateLimitCycle: parked wall is EXCLUDED from max_time_minutes (B3) — no limit break', async () => {
  // e9bdac75 B3: a rate-limit park advances start_time_epoch by the parked duration so
  // the wait is excluded from the max_time_minutes budget. A sub-budget max_time_minutes
  // therefore must NOT trip a 'limit' break mid-park; the cycle resumes (continue).
  const session = tmpSession();
  try {
    const state = baseState({ max_time_minutes: 1 });
    writeState(session, state);
    const { context, setNow } = ctx(session, {
      exitResult: { type: 'api_limit', rateLimitInfo: { resetsAt: 1714083600 } },
      parkJitterMs: 0,
      // Jump the clock just past the (jitter-free) resume target so the park wait
      // completes in a single poll — deterministic, no real sleep.
      sleep: async () => setNow(1714083601 * 1000),
    });
    const action = await withFrozenDate(1714080000 * 1000, () => processRateLimitCycle(state, context));
    assert.equal(action.kind, 'continue');
    const persisted = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
    assert.ok(persisted.start_time_epoch > 1714080000, 'start_time_epoch advanced past parked wall');
    assert.equal(persisted.rate_limit_park, null);
  } finally {
    fs.rmSync(session.dir, { recursive: true, force: true });
  }
});

test('processRateLimitCycle: non-rate-limit input returns noop', async () => {
  const session = tmpSession();
  try {
    writeState(session, baseState());
    const { context } = ctx(session, { exitResult: { type: 'success' } });
    const action = await processRateLimitCycle(baseState(), context);
    assert.equal(action.kind, 'noop');
  } finally {
    fs.rmSync(session.dir, { recursive: true, force: true });
  }
});

test('processRateLimitCycle: wake path returns continue and writes handoff', async () => {
  const session = tmpSession();
  try {
    const state = baseState();
    writeState(session, state);
    const { context } = ctx(session, {
      exitResult: { type: 'api_limit', rateLimitInfo: { resetsAt: 1714080001, rateLimitType: 'tokens' } },
      consecutiveRateLimits: 1,
    });
    const action = await withFrozenDate(1714080000 * 1000, () => processRateLimitCycle(state, context));
    assert.equal(action.kind, 'continue');
    assert.equal(action.consecutiveRateLimits, 0);
    assert.equal(fs.existsSync(path.join(session.dir, 'handoff.txt')), true);
  } finally {
    fs.rmSync(session.dir, { recursive: true, force: true });
  }
});

test('processRateLimitCycle: no max_time_minutes honors full wait and resumes', async () => {
  const session = tmpSession();
  try {
    const state = baseState({ max_time_minutes: undefined });
    writeState(session, state);
    const targetWaitMs = 4 * 60 * 60 * 1000;
    let sleptMs = 0;
    const { context, setNow } = ctx(session, {
      exitResult: { type: 'api_limit', rateLimitInfo: { resetsAt: 1714094400, rateLimitType: 'requests' } },
      rateLimitWaitMinutes: 240,
      sleep: async (ms) => {
        sleptMs += ms;
        setNow(1714080000 * 1000 + sleptMs);
      },
    });
    const action = await withFrozenDate(1714080000 * 1000, () => processRateLimitCycle(state, context));
    assert.equal(action.kind, 'continue');
    assert.ok(sleptMs >= targetWaitMs, `expected full 4h wait without session-cap clamp, got ${sleptMs}ms`);
  } finally {
    fs.rmSync(session.dir, { recursive: true, force: true });
  }
});

test('processRateLimitCycle: fixture replay output sequence matches fixture', async () => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
  const observed = [];
  for (const item of fixture.cases) {
    const session = tmpSession();
    try {
      const state = baseState(item.state_in || {});
      writeState(session, state);
      const overrides = item.case === 'rate_limit_exhausted'
        ? { exitResult: { type: 'api_limit' }, consecutiveRateLimits: 3, maxRateLimitRetries: 3 }
        : { exitResult: { type: 'api_limit', rateLimitInfo: { resetsAt: item.state_in?.resets_at_epoch || 1714083600 } } };
      if (item.case === 'cancelled_during_wait') {
        overrides.readState = () => ({ ...state, active: false });
      }
      const { context, setNow } = ctx(session, overrides);
      if (item.state_in?.elapsed_seconds) setNow((1714080000 + item.state_in.elapsed_seconds) * 1000);
      const action = await withFrozenDate(1714080000 * 1000, () => processRateLimitCycle(state, context));
      observed.push({
        case: item.case,
        state_out: {
          active: action.kind === 'continue',
          exit_reason: action.kind === 'break' ? action.reason : null,
          counter_reset: action.consecutiveRateLimits === 0,
        },
      });
    } finally {
      fs.rmSync(session.dir, { recursive: true, force: true });
    }
  }
  assert.equal(observed.length, fixture.cases.length);
  assert.deepEqual(observed.map(o => o.case), fixture.cases.map(o => o.case));
});

test('processIterationOutcome: task_completed clean exits success', async () => {
  const session = tmpSession();
  try {
    writeTicket(session.dir, 't1', 'Done');
    const state = baseState();
    writeState(session, state);
    const { context } = ctx(session);
    const action = await processIterationOutcome(state, baseOutcome({ completion: 'task_completed' }), context);
    assert.deepEqual({ kind: action.kind, reason: action.reason }, { kind: 'break', reason: 'success' });
  } finally {
    fs.rmSync(session.dir, { recursive: true, force: true });
  }
});

test('processIterationOutcome: task_completed with pending tickets continues', async () => {
  const session = tmpSession();
  try {
    writeTicket(session.dir, 't1', 'Done', 1);
    writeTicket(session.dir, 't2', 'Todo', 2);
    const state = baseState();
    writeState(session, state);
    const { context } = ctx(session);
    const action = await processIterationOutcome(state, baseOutcome({ completion: 'task_completed' }), context);
    assert.equal(action.kind, 'continue');
  } finally {
    fs.rmSync(session.dir, { recursive: true, force: true });
  }
});

test('processIterationOutcome: review_clean below min_iterations returns noop', async () => {
  const session = tmpSession();
  try {
    const state = baseState({ iteration: 2, min_iterations: 3 });
    writeState(session, state);
    const { context } = ctx(session);
    const action = await processIterationOutcome(state, baseOutcome({ completion: 'review_clean' }), context);
    assert.equal(action.kind, 'noop');
  } finally {
    fs.rmSync(session.dir, { recursive: true, force: true });
  }
});

test('processIterationOutcome: review_clean at min_iterations exits success', async () => {
  const session = tmpSession();
  try {
    const state = baseState({ iteration: 3, min_iterations: 3 });
    writeState(session, state);
    const { context } = ctx(session);
    const action = await processIterationOutcome(state, baseOutcome({ completion: 'review_clean' }), context);
    assert.deepEqual({ kind: action.kind, reason: action.reason }, { kind: 'break', reason: 'success' });
  } finally {
    fs.rmSync(session.dir, { recursive: true, force: true });
  }
});

test('processIterationOutcome: inactive exits cancelled', async () => {
  const session = tmpSession();
  try {
    const state = baseState();
    writeState(session, state);
    const { context } = ctx(session);
    const action = await processIterationOutcome(state, baseOutcome({ completion: 'inactive' }), context);
    assert.deepEqual({ kind: action.kind, reason: action.reason }, { kind: 'break', reason: 'cancelled' });
  } finally {
    fs.rmSync(session.dir, { recursive: true, force: true });
  }
});

test('processIterationOutcome: error exits error', async () => {
  const session = tmpSession();
  try {
    const state = baseState({ max_time_minutes: 0 });
    writeState(session, state);
    const { context } = ctx(session);
    const action = await processIterationOutcome(state, baseOutcome({ completion: 'error' }), context);
    assert.deepEqual({ kind: action.kind, reason: action.reason }, { kind: 'break', reason: 'error' });
  } finally {
    fs.rmSync(session.dir, { recursive: true, force: true });
  }
});

test('processIterationOutcome: exhausted wall-clock budget exits limit instead of error', async () => {
  const session = tmpSession();
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const state = baseState({
      backend: 'codex',
      start_time_epoch: nowSec - 300,
      max_time_minutes: 5,
      current_ticket: 't-pending',
    });
    writeState(session, state);
    writeTicket(session.dir, 't-pending', 'Todo');
    const { context } = ctx(session);
    const realNow = Date.now;
    Date.now = () => nowSec * 1000;
    try {
      const action = await processIterationOutcome(state, baseOutcome({ completion: 'error', timedOut: true }), context);
      assert.deepEqual({ kind: action.kind, reason: action.reason }, { kind: 'break', reason: 'limit' });
      const persisted = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
      assert.equal(persisted.active, false);
      assert.equal(persisted.current_ticket, null);
      assert.equal(persisted.exit_reason, 'limit');
    } finally {
      Date.now = realNow;
    }
  } finally {
    fs.rmSync(session.dir, { recursive: true, force: true });
  }
});

function initGitRepo(repoDir) {
  execFileSync('git', ['init', '--quiet'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.local'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'baseline\n');
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'baseline', '--quiet'], { cwd: repoDir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim();
}

function cbState(overrides = {}) {
  return {
    state: 'CLOSED',
    last_change: new Date().toISOString(),
    consecutive_no_progress: 0,
    consecutive_same_error: 0,
    last_error_signature: null,
    last_known_head: '',
    last_known_step: 'implement',
    last_known_ticket: 't1',
    last_progress_iteration: 0,
    total_opens: 0,
    reason: '',
    opened_at: null,
    history: [],
    ...overrides,
  };
}

test('processIterationOutcome: CB OPEN trip exits circuit_open', async () => {
  const session = tmpSession();
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-cb-open-')));
  try {
    const head = initGitRepo(repo);
    const state = baseState({ working_dir: repo });
    writeState(session, state);
    const { context } = ctx(session, {
      cbEnabled: true,
      cbState: cbState({ last_known_head: head, consecutive_no_progress: 4 }),
      cbSettings: { enabled: true, noProgressThreshold: 1, sameErrorThreshold: 5, halfOpenAfter: 2 },
      cbPath: path.join(session.dir, 'circuit_breaker.json'),
    });
    const action = await processIterationOutcome(state, baseOutcome({ completion: 'continue' }), context);
    assert.deepEqual({ kind: action.kind, reason: action.reason }, { kind: 'break', reason: 'circuit_open' });
  } finally {
    fs.rmSync(session.dir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('processIterationOutcome: CB HALF_OPEN closes on progress', async () => {
  const session = tmpSession();
  try {
    const state = baseState({ step: 'review' });
    writeState(session, state);
    const { context } = ctx(session, {
      cbEnabled: true,
      cbState: cbState({ state: 'HALF_OPEN', last_known_step: 'implement' }),
      cbSettings: { enabled: true, noProgressThreshold: 2, sameErrorThreshold: 5, halfOpenAfter: 1 },
      cbPath: path.join(session.dir, 'circuit_breaker.json'),
    });
    const action = await processIterationOutcome(state, baseOutcome({ completion: 'continue' }), context);
    assert.equal(action.kind, 'noop');
    assert.equal(action.cbState.state, 'CLOSED');
  } finally {
    fs.rmSync(session.dir, { recursive: true, force: true });
  }
});

// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  getCircuitBreakerBudget,
  processIterationOutcome,
} from '../bin/mux-runner.js';

function tmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mux-cb-')));
}

function initGitRepo(repoDir) {
  execFileSync('git', ['init', '--quiet'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.local'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'baseline\n');
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'baseline', '--quiet'], { cwd: repoDir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim();
}

function writeTicket(sessionDir, id, tierLine) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  const frontmatter = [
    '---',
    `id: ${id}`,
    'title: Test ticket',
    'status: "In Progress"',
  ];
  if (tierLine !== null) frontmatter.push(tierLine);
  frontmatter.push('---', '', '# Test');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${id}.md`), frontmatter.join('\n'));
}

function baseState(sessionDir, repoDir, overrides = {}) {
  return {
    active: true,
    working_dir: repoDir,
    step: 'implement',
    iteration: 1,
    max_iterations: 10,
    max_time_minutes: 60,
    worker_timeout_seconds: 30,
    start_time_epoch: 1714080000,
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: 't1',
    history: [],
    started_at: new Date(0).toISOString(),
    session_dir: sessionDir,
    ...overrides,
  };
}

function writeState(sessionDir, state) {
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state, null, 2));
}

function cbState(head, consecutiveNoProgress, overrides = {}) {
  return {
    state: 'CLOSED',
    last_change: new Date(0).toISOString(),
    consecutive_no_progress: consecutiveNoProgress,
    consecutive_same_error: 0,
    last_error_signature: null,
    last_known_head: head,
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

async function runNoProgressCase({ tierLine, consecutiveNoProgress }) {
  const root = tmpRoot();
  const sessionDir = path.join(root, 'session');
  const repoDir = path.join(root, 'repo');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(repoDir, { recursive: true });
  try {
    const head = initGitRepo(repoDir);
    writeTicket(sessionDir, 't1', tierLine);
    const state = baseState(sessionDir, repoDir);
    writeState(sessionDir, state);
    const logs = [];
    const context = {
      sessionDir,
      statePath: path.join(sessionDir, 'state.json'),
      extensionRoot: root,
      iteration: consecutiveNoProgress + 1,
      iterLogFile: path.join(sessionDir, 'tmux_iteration_1.log'),
      log: (msg) => logs.push(msg),
      readState: () => JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8')),
      deactivate: () => {},
      writeState: (targetPath, value) => fs.writeFileSync(targetPath, JSON.stringify(value, null, 2)),
      writeTimeout: () => {},
      cbEnabled: true,
      cbState: cbState(head, consecutiveNoProgress),
      cbSettings: { enabled: true, noProgressThreshold: 99, sameErrorThreshold: 50, halfOpenAfter: 2 },
      cbPath: path.join(sessionDir, 'circuit_breaker.json'),
    };

    const action = await processIterationOutcome(state, {
      completion: 'continue',
      timedOut: false,
      exitCode: 0,
      wallSeconds: 1,
    }, context);
    return {
      action,
      logs,
      state: JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8')),
      cb: JSON.parse(fs.readFileSync(path.join(sessionDir, 'circuit_breaker.json'), 'utf-8')),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('getCircuitBreakerBudget parses and caches tier budgets', () => {
  const root = tmpRoot();
  try {
    writeTicket(root, 't1', 'complexity_tier: large');
    const state = { current_ticket: 't1' };
    assert.deepEqual(getCircuitBreakerBudget(state, root), { tier: 'large', budget: 12 });
    assert.equal(state.current_ticket_tier, 'large');
    assert.equal(state.current_ticket_budget, 12);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getCircuitBreakerBudget defaults missing and malformed tiers to medium budget', () => {
  const root = tmpRoot();
  try {
    writeTicket(root, 'missing', null);
    writeTicket(root, 'malformed', 'complexity_tier: bogus');

    assert.deepEqual(
      getCircuitBreakerBudget({ current_ticket: 'missing' }, root),
      { tier: 'medium', budget: 5 },
    );
    assert.deepEqual(
      getCircuitBreakerBudget({ current_ticket: 'malformed' }, root),
      { tier: 'medium', budget: 5 },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mux-runner circuit breaker respects tier boundaries', async () => {
  const cases = [
    { name: 'large', tierLine: 'complexity_tier: large', budget: 12 },
    { name: 'medium', tierLine: 'complexity_tier: medium', budget: 5 },
    { name: 'small', tierLine: 'complexity_tier: small', budget: 4 },
    { name: 'trivial', tierLine: 'complexity_tier: trivial', budget: 3 },
    { name: 'missing', tierLine: null, budget: 5 },
    { name: 'malformed', tierLine: 'complexity_tier: wrong', budget: 5 },
  ];

  for (const c of cases) {
    const before = await runNoProgressCase({
      tierLine: c.tierLine,
      consecutiveNoProgress: c.budget - 2,
    });
    assert.notEqual(before.action.kind, 'break', `${c.name}: should not trip before budget`);
    assert.equal(before.cb.consecutive_no_progress, c.budget - 1);

    const atBudget = await runNoProgressCase({
      tierLine: c.tierLine,
      consecutiveNoProgress: c.budget - 1,
    });
    assert.deepEqual(
      { kind: atBudget.action.kind, reason: atBudget.action.reason },
      { kind: 'break', reason: 'circuit_open' },
      `${c.name}: should trip at budget`,
    );
    assert.equal(atBudget.cb.state, 'OPEN');
    assert.match(atBudget.cb.reason, new RegExp(`tier: \\w+, budget: ${c.budget}`));
  }
});

test('mux-runner circuit breaker trip log includes tier and budget', async () => {
  const result = await runNoProgressCase({
    tierLine: 'complexity_tier: large',
    consecutiveNoProgress: 11,
  });
  const tripLog = result.logs.find((line) => line.startsWith('Circuit breaker tripped:'));
  assert.match(
    tripLog,
    /Circuit breaker tripped: No progress in \d+ iterations \(tier: \w+, budget: \d+\)/,
  );
  assert.equal(tripLog, 'Circuit breaker tripped: No progress in 12 iterations (tier: large, budget: 12)');
});

// @tier: fast
/**
 * B-NOSTOP-GATES WS-3 (AC-NSG-11 / AC-NSG-13): every parked ticket — a ticket a
 * phase reports incomplete over but advances past instead of halting on
 * (directive 2: park, flag, continue) — emits exactly ONE
 * `ticket_auto_skip_no_evidence` residual activity event via `logActivity`
 * (activity JSONL sink ONLY, never `writeActivityEntry`/`state.json.activity`).
 * A zero-parked run must render the completion panel byte-identical to the
 * pre-WS-3 shape (AC-NSG-13).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  __setSpawnRunnerForTests,
  buildPipelineCompletePanel,
  main,
} from '../bin/pipeline-runner.js';

class ExitIntercept extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function initRepo(dir) {
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@test.local'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'seed.ts'), 'export const x = 1;\n');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'seed'], dir);
}

function writeState(sessionDir, repo, overrides = {}) {
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    active: false,
    working_dir: repo,
    step: 'implement',
    iteration: 0,
    max_iterations: 100,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 'nostop-gates-residual test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 3,
    tmux_mode: false,
    chain_meeseeks: false,
    backend: 'claude',
    ...overrides,
  }, null, 2));
}

function writePipeline(sessionDir, repo, phases = ['pickle']) {
  fs.writeFileSync(path.join(sessionDir, 'pipeline.json'), JSON.stringify({
    phases,
    target: repo,
    anatomy_stall_limit: 3,
    szechuan_stall_limit: 5,
    anatomy_max_iterations: 100,
    szechuan_max_iterations: 50,
    dirty_exempt_segments: ['prds', 'docs'],
  }, null, 2));
}

function writeTicket(sessionDir, id, order, status = 'Todo') {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(
    path.join(ticketDir, `rick_ticket_${id}.md`),
    `---\nid: ${id}\ntitle: Residual test ticket ${id}\nstatus: ${status}\norder: ${order}\n---\n\n# Test\n`,
  );
}

async function captureMainExit(sessionDir, expectedCode) {
  const originalExit = process.exit;
  const originalTmux = process.env.TMUX;
  delete process.env.TMUX;
  process.exit = (code) => { throw new ExitIntercept(code ?? 0); };
  try {
    await assert.rejects(
      () => main(sessionDir),
      (err) => err instanceof ExitIntercept && err.code === expectedCode,
    );
  } finally {
    process.exit = originalExit;
    if (originalTmux === undefined) {
      delete process.env.TMUX;
    } else {
      process.env.TMUX = originalTmux;
    }
  }
}

function readActivityEvents(dataRoot) {
  const activityDir = path.join(dataRoot, 'activity');
  if (!fs.existsSync(activityDir)) return [];
  const events = [];
  for (const file of fs.readdirSync(activityDir)) {
    if (!file.endsWith('.jsonl')) continue;
    const lines = fs.readFileSync(path.join(activityDir, file), 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) events.push(JSON.parse(line));
  }
  return events;
}

afterEach(() => {
  __setSpawnRunnerForTests(null);
});

test('AC-NSG-11: a 3-parked fixture emits exactly 3 ticket_auto_skip_no_evidence events (no duplicates)', async () => {
  const repo = tmpDir('nsg-residual-repo-');
  const sessionDir = tmpDir('nsg-residual-session-');
  const dataRoot = tmpDir('nsg-residual-dataroot-');
  const savedDataRoot = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    initRepo(repo);
    writeState(sessionDir, repo);
    writePipeline(sessionDir, repo, ['pickle']);

    writeTicket(sessionDir, 'aaa11111', 1);
    writeTicket(sessionDir, 'bbb22222', 2);
    writeTicket(sessionDir, 'ccc33333', 3);

    __setSpawnRunnerForTests(async () => {
      const statePath = path.join(sessionDir, 'state.json');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      state.exit_reason = 'iteration_cap_exhausted';
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      return { exitCode: 3, stdout: '', stderr: '' };
    });

    await captureMainExit(sessionDir, 3);

    const session = path.basename(sessionDir);
    const residuals = readActivityEvents(dataRoot).filter((e) => e.event === 'ticket_auto_skip_no_evidence' && e.session === session);

    assert.equal(residuals.length, 3, 'exactly one residual event per parked ticket');
    const tickets = residuals.map((e) => e.ticket).sort();
    assert.deepEqual(tickets, ['aaa11111', 'bbb22222', 'ccc33333']);
    for (const e of residuals) {
      assert.equal(e.source, 'pickle');
      assert.equal(e.session, session);
      assert.equal(typeof e.iteration, 'number');
    }

    // AC-NSG-11 (sink): the residuals land in the activity JSONL, never state.json.activity.
    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    const stateActivity = Array.isArray(state.activity) ? state.activity : [];
    assert.ok(
      !stateActivity.some((e) => e && e.event === 'ticket_auto_skip_no_evidence'),
      'state.json.activity must gain no parked-residual entries',
    );
  } finally {
    __setSpawnRunnerForTests(null);
    if (savedDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = savedDataRoot;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('AC-NSG-13: zero-parked panel is byte-identical to the pre-WS-3 shape', () => {
  const counters = { completed: 4, skipped: 0, phaseSkips: {}, nonConvergent: 0, phaseDispositions: {} };
  const baseline = { Phases: '4/4', Elapsed: '0m 0s' };
  const panel = buildPipelineCompletePanel(counters, '4/4', 0);
  assert.deepEqual(panel, baseline, 'zero parked tickets must not add a Parked row or otherwise change the panel');
  assert.ok(!('Parked' in panel));
});

test('AC-NSG-13: an explicit zero parkedCount argument matches the default (omitted) argument', () => {
  const counters = { completed: 2, skipped: 1, phaseSkips: {}, nonConvergent: 0, phaseDispositions: {} };
  const withDefault = buildPipelineCompletePanel(counters, '2/3 (1 skipped)', 12);
  const withExplicitZero = buildPipelineCompletePanel(counters, '2/3 (1 skipped)', 12, 0);
  assert.deepEqual(withDefault, withExplicitZero);
});

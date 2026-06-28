// @tier: integration
//
// B-PXBO WS-1 (R-DPGT) grace-drain DEFERRAL positive-path coverage.
//
// The sibling test (b-pxbo-ws3b-ws1-crash-resume.test.js) disables the branch via
// PICKLE_LARGE_TIER_DETACHED='off', and pipeline-runner-halt-on-incomplete.test.js
// covers only the oracle-exclusion case with NO detached_worker. This file covers
// the actually-deferring grace-drain path + its bounded cap:
//
// - AC-DPGT-2: with the detached lifecycle ENABLED and a LIVE detached_worker inside
//   its eligibility window, reportPhaseIncomplete DEFERS — it fires the bounded
//   grace-drain pass loop (the injected sleep is invoked) before deciding the stamp.
// - AC-DPGT-1: if the ticket acquires a durable completion_commit mid-drain, it is
//   EXCLUDED from the unfinished set and pipeline_phase_incomplete is NOT written.
// - AC-DPGT-2 cap: if the drain cap elapses with the worker still uncommitted, the
//   pipeline_phase_incomplete stamp IS written.
// - AC-DPGT-4: a dead/absent detached worker takes the immediate-stamp path (no drain;
//   the injected sleep is never invoked).
//
// The grace-drain wait is injected via _setGraceDrainSleep so no real wall-clock time
// is spent. R-PTSB: PICKLE_DATA_ROOT is sandboxed to a tmp dir per test.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  __setSpawnRunnerForTests,
  _setGraceDrainSleep,
  main,
} from '../bin/pipeline-runner.js';

class ExitIntercept extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

function tmpDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
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
    original_prompt: 'grace-drain test',
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
    path.join(ticketDir, `linear_ticket_${id}.md`),
    `---\nid: ${id}\ntitle: Grace-drain test ticket ${id}\nstatus: ${status}\norder: ${order}\n---\n\n# Test\n`,
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
    if (originalTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTmux;
  }
}

// Run `fn` inside a sandboxed PICKLE_DATA_ROOT with the detached lifecycle env
// override applied, restoring both afterward. Always reset the injected sleep.
function withEnv({ detached }, fn) {
  const prevDataRoot = process.env.PICKLE_DATA_ROOT;
  const prevDetached = process.env.PICKLE_LARGE_TIER_DETACHED;
  const dataRoot = tmpDir('pxbo-gd-dataroot-');
  process.env.PICKLE_DATA_ROOT = dataRoot;
  if (detached === undefined) delete process.env.PICKLE_LARGE_TIER_DETACHED;
  else process.env.PICKLE_LARGE_TIER_DETACHED = detached;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prevDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
      else process.env.PICKLE_DATA_ROOT = prevDataRoot;
      if (prevDetached === undefined) delete process.env.PICKLE_LARGE_TIER_DETACHED;
      else process.env.PICKLE_LARGE_TIER_DETACHED = prevDetached;
      fs.rmSync(dataRoot, { recursive: true, force: true });
    });
}

afterEach(() => {
  __setSpawnRunnerForTests(null);
  _setGraceDrainSleep(() => {});
});

// AC-DPGT-2 + AC-DPGT-1: a LIVE detached worker at the cap defers the stamp, and a
// completion_commit landing MID-DRAIN (via the injected sleep) excludes the ticket so
// pipeline_phase_incomplete is NOT written.
test('WS-1 grace-drain DEFERS, then excludes a ticket that commits mid-drain (AC-DPGT-2/AC-DPGT-1)', () => {
  return withEnv({ detached: '1' }, async () => {
    const repo = tmpDir('pxbo-gd-defer-repo-');
    const sessionDir = tmpDir('pxbo-gd-defer-session-');
    try {
      initRepo(repo);
      writeState(sessionDir, repo);
      writePipeline(sessionDir, repo, ['pickle']);
      // The sole unfinished ticket; the live detached worker is on it.
      writeTicket(sessionDir, 'aaa20001', 1, 'Todo');

      // The phase runner caps out with a LIVE detached_worker (this process pid → isProcessAlive
      // true) on the unfinished ticket, still inside its eligibility window. No commit yet.
      __setSpawnRunnerForTests(async () => {
        const statePath = path.join(sessionDir, 'state.json');
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        state.exit_reason = 'iteration_cap_exhausted';
        state.detached_worker = {
          worker_pid: process.pid,
          ticket_id: 'aaa20001',
          spawned_at_epoch: Date.now(),
          worker_log_path: path.join(sessionDir, 'aaa20001', 'worker_session_1.log'),
        };
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
        return { exitCode: 3, stdout: '', stderr: '' };
      });

      // Injected grace-drain wait: on the FIRST pass, land the worker's durable commit.
      // The next re-resolve through the oracle then excludes the ticket → defer stamp.
      let sleepCalls = 0;
      _setGraceDrainSleep(() => {
        sleepCalls++;
        if (sleepCalls === 1) {
          fs.writeFileSync(path.join(repo, 'aaa20001.ts'), 'export const a = 1;\n');
          git(['add', '.'], repo);
          git(['commit', '-q', '-m', 'fix(aaa20001): durable green work landed mid-drain'], repo);
        }
      });

      await captureMainExit(sessionDir, 3);

      assert.ok(sleepCalls >= 1, 'the bounded grace-drain pass loop must fire at least once (deferral)');

      const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
      assert.notEqual(
        state.exit_reason,
        'pipeline_phase_incomplete',
        'a ticket that commits mid-drain must be excluded → no pipeline_phase_incomplete stamp',
      );

      const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
      assert.ok(
        /grace-drain pass 1\//.test(log),
        'log must record at least one grace-drain pass (the deferral)',
      );
      assert.ok(
        /no phase-incomplete stamp/.test(log),
        'log must record the deferral outcome (no stamp after oracle exclusion)',
      );
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

// AC-DPGT-2 cap: a LIVE detached worker that NEVER commits exhausts the bounded drain
// cap; reportPhaseIncomplete then writes the pipeline_phase_incomplete stamp.
test('WS-1 grace-drain exhausts the bounded cap with an uncommitted worker, then STAMPS (AC-DPGT-2 cap)', () => {
  return withEnv({ detached: '1' }, async () => {
    const repo = tmpDir('pxbo-gd-cap-repo-');
    const sessionDir = tmpDir('pxbo-gd-cap-session-');
    try {
      initRepo(repo);
      writeState(sessionDir, repo);
      writePipeline(sessionDir, repo, ['pickle']);
      writeTicket(sessionDir, 'bbb20002', 1, 'Todo');

      __setSpawnRunnerForTests(async () => {
        const statePath = path.join(sessionDir, 'state.json');
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        state.exit_reason = 'iteration_cap_exhausted';
        state.detached_worker = {
          worker_pid: process.pid,
          ticket_id: 'bbb20002',
          spawned_at_epoch: Date.now(),
          worker_log_path: path.join(sessionDir, 'bbb20002', 'worker_session_1.log'),
        };
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
        return { exitCode: 3, stdout: '', stderr: '' };
      });

      // The worker never commits; the injected sleep just counts passes (no wall-clock).
      let sleepCalls = 0;
      _setGraceDrainSleep(() => { sleepCalls++; });

      await captureMainExit(sessionDir, 3);

      assert.ok(sleepCalls >= 1, 'the grace-drain pass loop must fire (worker stays eligible)');
      assert.ok(sleepCalls <= 3, 'the drain wait must be BOUNDED (GRACE_DRAIN_MAX_PASSES=3), not unbounded');

      const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
      assert.equal(
        state.exit_reason,
        'pipeline_phase_incomplete',
        'an uncommitted worker that exhausts the bounded drain cap must stamp pipeline_phase_incomplete',
      );

      // The unfinished ticket stays Todo (the drain did not falsely complete it).
      const ticketFile = path.join(sessionDir, 'bbb20002', 'linear_ticket_bbb20002.md');
      assert.ok(
        fs.readFileSync(ticketFile, 'utf-8').includes('status: Todo'),
        'the uncommitted ticket must remain Todo after the cap-exhausted stamp',
      );
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

// AC-DPGT-4 (negative): a dead/absent detached worker takes the immediate-stamp path —
// no grace-drain at all (the injected sleep is never invoked).
test('WS-1 dead/absent detached worker stamps immediately with NO drain (AC-DPGT-4)', () => {
  return withEnv({ detached: '1' }, async () => {
    const repo = tmpDir('pxbo-gd-dead-repo-');
    const sessionDir = tmpDir('pxbo-gd-dead-session-');
    try {
      initRepo(repo);
      writeState(sessionDir, repo);
      writePipeline(sessionDir, repo, ['pickle']);
      writeTicket(sessionDir, 'ccc20003', 1, 'Todo');

      // A dead pid (1 is reserved/owned and process.kill(1, 0) throws EPERM → isProcessAlive
      // false for an unprivileged test runner). Use a never-allocated high pid instead to be
      // robust: a pid that is guaranteed dead.
      const deadPid = 2147483646;
      __setSpawnRunnerForTests(async () => {
        const statePath = path.join(sessionDir, 'state.json');
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        state.exit_reason = 'iteration_cap_exhausted';
        state.detached_worker = {
          worker_pid: deadPid,
          ticket_id: 'ccc20003',
          spawned_at_epoch: Date.now(),
          worker_log_path: path.join(sessionDir, 'ccc20003', 'worker_session_1.log'),
        };
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
        return { exitCode: 3, stdout: '', stderr: '' };
      });

      let sleepCalls = 0;
      _setGraceDrainSleep(() => { sleepCalls++; });

      await captureMainExit(sessionDir, 3);

      assert.equal(sleepCalls, 0, 'a dead/absent worker must NOT trigger the grace-drain wait (immediate stamp)');

      const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
      assert.equal(
        state.exit_reason,
        'pipeline_phase_incomplete',
        'a genuinely stuck ticket (dead detached worker) must still stamp pipeline_phase_incomplete',
      );
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

// @tier: integration
/**
 * R-CMWL-5: Regression — full codex continuation path
 *
 * Exercises the complete codex manager continuation path:
 *  - Drain a >3-ticket queue to all-Done across ≥2 manager-session boundaries
 *    without operator relaunch (uses processCompletionBranch loop simulation)
 *  - Assert turn/progress-based continuation: max_time_minutes=0 disables wall-clock
 *    so the 3600s/60-min cutoff never governs; relaunch gated on tickets_remaining && progressed
 *  - R-CMWL-3 dirty-tree boundary: resetInterruptedTicketWorkForRelaunch restores tracked
 *    file to HEAD and removes untracked file at relaunch boundary
 *  - R-CMWL-4 no-progress halt: 3 consecutive inactive exits with no ticket progress
 *    (pass1: set baseline, pass2: count=1, pass3: count=2) → halt(codex_manager_no_progress)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { processCompletionBranch } from '../../bin/mux-runner.js';
import { resetInterruptedTicketWorkForRelaunch } from '../../bin/pipeline-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeDir(prefix = 'pickle-cmwl5-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeTicket(sessionDir, id, status) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(
    path.join(ticketDir, `rick_ticket_${id}.md`),
    `---\nid: ${id}\ntitle: ${id} fixture\nstatus: ${status}\norder: 1\n---\n\n# Fixture\n`,
  );
}

function markTicketDone(sessionDir, id) {
  const ticketFile = path.join(sessionDir, id, `rick_ticket_${id}.md`);
  const raw = fs.readFileSync(ticketFile, 'utf-8');
  fs.writeFileSync(ticketFile, raw.replace(/^status: .+$/m, 'status: Done'));
}

function readTicketStatus(sessionDir, id) {
  const content = fs.readFileSync(
    path.join(sessionDir, id, `rick_ticket_${id}.md`), 'utf-8',
  );
  const m = content.match(/^status:\s*(.+)$/m);
  return m ? m[1].trim().replace(/["']/g, '').toLowerCase() : null;
}

function writeState(sessionDir, overrides = {}) {
  const state = {
    active: false,
    backend: 'codex',
    working_dir: sessionDir,
    step: 'implement',
    iteration: 1,
    max_iterations: 50,
    max_time_minutes: 0,
    worker_timeout_seconds: 3600,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'R-CMWL-5 regression fixture',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 5,
    manager_relaunch_count: 0,
    worker_artifact_progress: {},
    codex_manager_consecutive_no_progress: 0,
    ...overrides,
  };
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return { state, statePath };
}

function buildCtx(sessionDir, statePath, logs, deactivateCalls, iteration = 1) {
  const iterLogFile = path.join(sessionDir, `tmux_iteration_${iteration}.log`);
  if (!fs.existsSync(iterLogFile)) fs.writeFileSync(iterLogFile, '');
  return {
    sessionDir,
    statePath,
    extensionRoot: path.resolve(__dirname, '../../'),
    iteration,
    outcome: { completion: 'inactive', timedOut: false, exitCode: null, wallSeconds: 0 },
    iterLogFile,
    maxTurns: 40,
    cbState: null,
    log: msg => logs.push(msg),
    deactivate: target => deactivateCalls.push(target),
  };
}

// ── Test 1: full drain ──────────────────────────────────────────────────────

test('full drain: >3-ticket queue drains to all-Done across ≥2 manager-session boundaries without operator relaunch', async () => {
  const dir = makeDir();
  const dataRoot = makeDir('pickle-cmwl5-data-');
  const prevDataRoot = process.env.PICKLE_DATA_ROOT;
  try {
    process.env.PICKLE_DATA_ROOT = dataRoot;

    writeTicket(dir, 'td1', 'Todo');
    writeTicket(dir, 'td2', 'Todo');
    writeTicket(dir, 'td3', 'Todo');
    writeTicket(dir, 'td4', 'Todo');

    const { statePath } = writeState(dir);

    const logs = [];
    const deactivateCalls = [];
    let sessionBoundaries = 0;
    const ticketIds = ['td1', 'td2', 'td3', 'td4'];

    for (let i = 0; i < 6; i++) {
      const currentState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      const ctx = buildCtx(dir, statePath, logs, deactivateCalls, i + 1);
      const action = await processCompletionBranch(currentState, 'inactive', ctx);

      if (action.kind === 'relaunch') {
        sessionBoundaries++;
        // Simulate one ticket completing per manager session
        if (sessionBoundaries <= ticketIds.length) {
          markTicketDone(dir, ticketIds[sessionBoundaries - 1]);
        }
      } else {
        assert.equal(action.kind, 'break',
          `unexpected action kind: ${JSON.stringify(action)}`);
        break;
      }
    }

    // All 4 tickets must be Done
    for (const id of ticketIds) {
      assert.equal(readTicketStatus(dir, id), 'done', `ticket ${id} should be Done`);
    }

    // ≥2 session boundaries crossed
    assert.ok(sessionBoundaries >= 2,
      `expected ≥2 manager-session boundaries, got ${sessionBoundaries}`);

    // Exactly 4 relaunches for 4 tickets
    assert.equal(sessionBoundaries, 4, 'expected 4 relaunches for 4 tickets');

    // No deactivations — runner continues without operator intervention
    assert.equal(deactivateCalls.length, 0,
      'runner must not deactivate mid-drain; operator relaunch is NOT required');

    // Persisted relaunch count reflects boundaries crossed
    const finalState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(finalState.manager_relaunch_count, 4);

    // Relaunch logs emitted at each boundary
    assert.ok(
      logs.filter(l => l.includes('relaunching')).length >= 2,
      `expected ≥2 relaunch log lines, got:\n${logs.join('\n')}`,
    );
  } finally {
    if (prevDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prevDataRoot;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// ── Test 2: no hardcoded 3600s/60-min cutoff ────────────────────────────────

test('no hardcoded time cutoff: max_time_minutes=0 disables wall-clock so relaunch is gated on tickets_remaining && progressed only', async () => {
  const dir = makeDir();
  const dataRoot = makeDir('pickle-cmwl5-data-');
  const prevDataRoot = process.env.PICKLE_DATA_ROOT;
  try {
    process.env.PICKLE_DATA_ROOT = dataRoot;

    writeTicket(dir, 'tc1', 'Todo');

    // State with wall-clock cap disabled; start_time_epoch set far in the past
    // to prove that elapsed time alone never triggers a time_limit exit
    const { statePath } = writeState(dir, {
      max_time_minutes: 0,
      start_time_epoch: 1, // epoch=1 → massive elapsed seconds, but cap disabled
    });

    const logs = [];
    const deactivateCalls = [];

    const state1 = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const ctx1 = buildCtx(dir, statePath, logs, deactivateCalls, 1);
    const action1 = await processCompletionBranch(state1, 'inactive', ctx1);

    // Must relaunch, not exit with time_limit/limit
    assert.equal(action1.kind, 'relaunch',
      `expected relaunch despite ancient start_time_epoch, got: ${JSON.stringify(action1)}`);
    assert.ok(
      action1.reason !== 'time_limit' && action1.reason !== 'limit',
      `expected no time_limit reason, got: ${JSON.stringify(action1)}`,
    );
    assert.ok(
      !logs.some(l => l.includes('Time limit reached') || l.includes('time_limit')),
      `no time-limit log expected when max_time_minutes=0, got:\n${logs.join('\n')}`,
    );

    // Complete the ticket; next call must break(cancelled) — NOT break(limit)
    markTicketDone(dir, 'tc1');
    const state2 = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const ctx2 = buildCtx(dir, statePath, logs, deactivateCalls, 2);
    const action2 = await processCompletionBranch(state2, 'inactive', ctx2);

    assert.equal(action2.kind, 'break', `expected break when no pending tickets`);
    assert.equal(action2.reason, 'cancelled',
      `break must be 'cancelled' (no pending), not time-related; got: ${action2.reason}`);
  } finally {
    if (prevDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prevDataRoot;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// ── Test 3: R-CMWL-3 dirty-tree boundary ────────────────────────────────────

test('R-CMWL-3 dirty-tree boundary: resetInterruptedTicketWorkForRelaunch restores tracked file and removes untracked file', () => {
  const repo = makeDir('pickle-cmwl5-repo-');
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, timeout: 10_000 });
    execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: repo, timeout: 10_000 });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo, timeout: 10_000 });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo, timeout: 10_000 });

    // Commit a tracked file
    const srcFile = path.join(repo, 'src.ts');
    fs.writeFileSync(srcFile, 'export const x = 1;\n');
    execFileSync('git', ['add', 'src.ts'], { cwd: repo, timeout: 10_000 });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repo, timeout: 10_000 });

    // Simulate interrupted in-flight ticket: dirty the tracked file
    fs.writeFileSync(srcFile, 'export const x = 2; // partial work from interrupted ticket\n');

    // Simulate a new untracked file from interrupted worker
    const newFile = path.join(repo, 'new-feature.ts');
    fs.writeFileSync(newFile, 'export const feature = true;\n');

    const resetLogs = [];
    resetInterruptedTicketWorkForRelaunch(repo, [], msg => resetLogs.push(msg));

    // Tracked file must be restored to HEAD content
    assert.equal(
      fs.readFileSync(srcFile, 'utf-8'),
      'export const x = 1;\n',
      'tracked file must be restored to HEAD content at relaunch boundary',
    );

    // Untracked file must be removed
    assert.ok(
      !fs.existsSync(newFile),
      'untracked file from interrupted worker must be removed at relaunch boundary',
    );

    // Reset log must be emitted
    assert.ok(
      resetLogs.some(l => l.includes('[relaunch-reset]')),
      `expected [relaunch-reset] log entry, got:\n${resetLogs.join('\n')}`,
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('R-CMWL-3 dirty-tree boundary: clean tree is a no-op (no log emitted)', () => {
  const repo = makeDir('pickle-cmwl5-clean-');
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, timeout: 10_000 });
    execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: repo, timeout: 10_000 });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo, timeout: 10_000 });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo, timeout: 10_000 });

    fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo, timeout: 10_000 });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repo, timeout: 10_000 });

    const cleanLogs = [];
    resetInterruptedTicketWorkForRelaunch(repo, [], msg => cleanLogs.push(msg));

    // No [relaunch-reset] log on a clean tree
    assert.equal(cleanLogs.length, 0,
      `expected no log on clean tree, got:\n${cleanLogs.join('\n')}`);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ── Test 4: R-CMWL-4 no-progress halt ───────────────────────────────────────

test('R-CMWL-4 no-progress halt: 3 consecutive zero-progress inactive exits → halt on pass 3 with codex_manager_no_progress', async () => {
  const dir = makeDir();
  const dataRoot = makeDir('pickle-cmwl5-data-');
  const prevDataRoot = process.env.PICKLE_DATA_ROOT;
  try {
    process.env.PICKLE_DATA_ROOT = dataRoot;

    writeTicket(dir, 'np1', 'Todo');
    writeTicket(dir, 'np2', 'Todo');

    const { statePath } = writeState(dir);

    const logs = [];
    const deactivateCalls = [];

    // Pass 1: baseline=null → set baseline=2, consecutiveCount=0, no halt → RELAUNCH
    const state1 = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const action1 = await processCompletionBranch(state1, 'inactive', buildCtx(dir, statePath, logs, deactivateCalls, 1));
    assert.equal(action1.kind, 'relaunch',
      `pass 1 (set baseline): expected relaunch, got ${JSON.stringify(action1)}`);

    // Pass 2: pendingCount=2=baseline → consecutiveCount=1, no halt → RELAUNCH
    const state2 = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const action2 = await processCompletionBranch(state2, 'inactive', buildCtx(dir, statePath, logs, deactivateCalls, 2));
    assert.equal(action2.kind, 'relaunch',
      `pass 2 (count=1): expected relaunch, got ${JSON.stringify(action2)}`);

    // Pass 3: pendingCount=2=baseline → consecutiveCount=2 ≥ 2 → HALT
    const state3 = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const action3 = await processCompletionBranch(state3, 'inactive', buildCtx(dir, statePath, logs, deactivateCalls, 3));
    assert.equal(action3.kind, 'break',
      `pass 3 (count=2): expected halt, got ${JSON.stringify(action3)}`);
    assert.equal(action3.reason, 'codex_manager_no_progress',
      `halt reason must be codex_manager_no_progress, got: ${action3.reason}`);

    // No-progress log must be emitted on halt
    assert.ok(
      logs.some(l => l.includes('Codex manager made no progress for 2 consecutive relaunch passes')),
      `expected no-progress halt log (consecutiveCount=2), got:\n${logs.join('\n')}`,
    );

    // Deactivation called exactly once on halt
    assert.equal(deactivateCalls.length, 1,
      'exactly one deactivation expected on no-progress halt');

    // Persisted state reflects the halt
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(persisted.codex_manager_consecutive_no_progress, 2);
  } finally {
    if (prevDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prevDataRoot;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('R-CMWL-4 no-progress halt: progress resets consecutive counter so drain continues normally', async () => {
  const dir = makeDir();
  const dataRoot = makeDir('pickle-cmwl5-data-');
  const prevDataRoot = process.env.PICKLE_DATA_ROOT;
  try {
    process.env.PICKLE_DATA_ROOT = dataRoot;

    writeTicket(dir, 'pr1', 'Todo');
    writeTicket(dir, 'pr2', 'Todo');

    const { statePath } = writeState(dir);

    const logs = [];
    const deactivateCalls = [];

    // Pass 1: baseline=null → set baseline=2, no halt → relaunch (no ticket done yet)
    const s1 = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const a1 = await processCompletionBranch(s1, 'inactive', buildCtx(dir, statePath, logs, deactivateCalls, 1));
    assert.equal(a1.kind, 'relaunch', `pass 1: expected relaunch`);

    // Simulate progress: mark one ticket Done
    markTicketDone(dir, 'pr1');

    // Pass 2: pendingCount=1 < baseline=2 → progress detected → consecutiveCount RESET to 0 → relaunch
    const s2 = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const a2 = await processCompletionBranch(s2, 'inactive', buildCtx(dir, statePath, logs, deactivateCalls, 2));
    assert.equal(a2.kind, 'relaunch', `pass 2 (progress made): expected relaunch, not halt`);

    // Verify counter was reset
    const mid = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(mid.codex_manager_consecutive_no_progress, 0,
      'consecutive no-progress counter must reset to 0 when progress is made');

    // No deactivations — the progress reset prevents spurious halt
    assert.equal(deactivateCalls.length, 0, 'no deactivation expected when progress was made');
  } finally {
    if (prevDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prevDataRoot;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

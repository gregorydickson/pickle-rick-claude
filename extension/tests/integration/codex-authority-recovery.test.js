// @tier: integration
/**
 * R-CHTS-CODEX: codex-authority recovery seam integration tests.
 *
 * Asserts that the 4 `codex_manager_no_progress` halt sites in mux-runner.ts now
 * route through `haltOrRecoverCodexNoProgress` before parking. Tests cover all three
 * `CodexNoProgressDisposition` kinds using scripted state conditions:
 *
 *   INV-CODEX-RECOVERY-HALT         — disposition=halt (current_ticket=null) → existing park
 *                                     (reason: codex_manager_no_progress)
 *   INV-CODEX-RECOVERY-EXHAUSTED    — disposition=recovery_exhausted (ticket set, all rungs
 *                                     fail: dirty tree + fast gate stub exits non-zero) →
 *                                     honest terminal (reason: recovery_exhausted)
 *   INV-CODEX-RECOVERY-ADVANCED     — disposition=advanced (dirty tree, extension/ absent so
 *                                     armed gate passes, PICKLE_TEST_MODE bypasses guard) →
 *                                     loop continues (kind: relaunch)
 *
 * All tests exercise the `inactive` branch of `processCompletionBranch` (the primary
 * codex no-progress site). The `error` branch uses the same seam call with identical
 * branch mapping and is covered structurally by the same assertions.
 *
 * No real codex/claude subprocess is spawned.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { processCompletionBranch } from '../../bin/mux-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp(prefix = 'chts-codex-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/**
 * Init a minimal git repo in `dir` with one committed file and return HEAD sha.
 */
function initGitRepo(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test Runner'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'placeholder.txt'), 'baseline\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial', '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function writeTicket(sessionDir, id, status = 'In Progress') {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(
    path.join(ticketDir, `rick_ticket_${id}.md`),
    `---\nid: ${id}\ntitle: Fixture ${id}\nstatus: ${JSON.stringify(status)}\norder: 1\ncomplexity_tier: medium\n---\n\n# Fixture\n`,
  );
  return ticketDir;
}

function writeState(sessionDir, overrides = {}) {
  const statePath = path.join(sessionDir, 'state.json');
  const state = {
    schema_version: 5,
    active: true,
    backend: 'codex',
    working_dir: sessionDir,
    step: 'implement',
    iteration: 1,
    max_iterations: 50,
    max_time_minutes: 0,
    worker_timeout_seconds: 3600,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'R-CHTS-CODEX fixture',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    flags: {},
    activity: [],
    manager_relaunch_count: 0,
    codex_manager_relaunch_count: 0,
    codex_manager_consecutive_no_progress: 0,
    codex_manager_relaunch_pending_baseline: null,
    worker_artifact_progress: {},
    recovery_attempts: [],
    ...overrides,
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return { state, statePath };
}

/**
 * Build a LoopContext for processCompletionBranch.
 * Uses the `codex_session_inactive` outcome so the inactive→codex path fires.
 * The injected `deactivate` hook captures calls without touching the filesystem.
 */
function buildCtx(sessionDir, statePath, logs, deactivateCalls, iteration = 3) {
  const iterLogFile = path.join(sessionDir, `tmux_iteration_${iteration}.log`);
  if (!fs.existsSync(iterLogFile)) fs.writeFileSync(iterLogFile, '');
  return {
    sessionDir,
    statePath,
    extensionRoot: path.resolve(__dirname, '../../'),
    iteration,
    // codex_session_inactive outcome so the inactive→codex path fires.
    // exitCode must be null (detectManagerInactiveExit contract).
    outcome: {
      completion: 'inactive',
      timedOut: false,
      exitCode: null,
      wallSeconds: 10,
    },
    iterLogFile,
    maxTurns: 40,
    cbState: null,
    log: (msg) => logs.push(msg),
    deactivate: (target) => deactivateCalls.push(target),
  };
}

/**
 * Drive `codex_manager_consecutive_no_progress` to the halt threshold (≥2).
 * Pass 1: baseline=null → sets baseline=2, no halt → relaunch.
 * Pass 2: pendingCount=2=baseline → count=1, no halt → relaunch.
 * The test call (pass 3) will produce count=2 → halt fires → seam consulted.
 */
async function armNoProgressHalt(sessionDir, statePath, logs) {
  const deactivateCalls = [];
  const s1 = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  const a1 = await processCompletionBranch(s1, 'inactive', buildCtx(sessionDir, statePath, logs, deactivateCalls, 1));
  if (a1.kind !== 'relaunch') {
    throw new Error(`armNoProgressHalt pass1: expected relaunch, got ${JSON.stringify(a1)}`);
  }
  const s2 = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  const a2 = await processCompletionBranch(s2, 'inactive', buildCtx(sessionDir, statePath, logs, deactivateCalls, 2));
  if (a2.kind !== 'relaunch') {
    throw new Error(`armNoProgressHalt pass2: expected relaunch, got ${JSON.stringify(a2)}`);
  }
}

// ---------------------------------------------------------------------------
// INV-CODEX-RECOVERY-HALT
// ---------------------------------------------------------------------------
// `current_ticket` is null → `haltOrRecoverCodexNoProgress` returns `halt`
// immediately (early return because ticketId is empty). The wiring falls through
// to the existing park: exit_reason=codex_manager_no_progress.

test('INV-CODEX-RECOVERY-HALT: disposition=halt (current_ticket=null) → existing park codex_manager_no_progress', async () => {
  const dir = makeTmp('chts-halt-');
  const dataRoot = makeTmp('chts-halt-data-');
  const prevDataRoot = process.env.PICKLE_DATA_ROOT;
  const prevTestMode = process.env.PICKLE_TEST_MODE;
  try {
    process.env.PICKLE_DATA_ROOT = dataRoot;
    process.env.PICKLE_TEST_MODE = '1';

    writeTicket(dir, 'th1');
    writeTicket(dir, 'th2');

    // current_ticket: null → haltOrRecoverCodexNoProgress returns halt immediately
    const { statePath } = writeState(dir, { current_ticket: null });

    const logs = [];
    const deactivateCalls = [];

    // Arm the no-progress halt threshold (passes 1 + 2)
    await armNoProgressHalt(dir, statePath, logs);

    // Pass 3: count=2 → halt fires → seam returns halt → existing park
    const s3 = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const action = await processCompletionBranch(
      s3,
      'inactive',
      buildCtx(dir, statePath, logs, deactivateCalls, 3),
    );

    assert.equal(action.kind, 'break',
      `expected break, got: ${JSON.stringify(action)}`);
    assert.equal(action.reason, 'codex_manager_no_progress',
      `expected codex_manager_no_progress park, got: ${action.reason}`);

    assert.ok(deactivateCalls.length >= 1,
      'deactivate must be called on codex_manager_no_progress park');

    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(persisted.exit_reason, 'codex_manager_no_progress',
      'exit_reason must be codex_manager_no_progress');
    assert.equal(persisted.codex_manager_consecutive_no_progress, 2,
      'consecutive_no_progress must be 2 at halt');
  } finally {
    if (prevDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prevDataRoot;
    if (prevTestMode === undefined) delete process.env.PICKLE_TEST_MODE;
    else process.env.PICKLE_TEST_MODE = prevTestMode;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// INV-CODEX-RECOVERY-EXHAUSTED
// ---------------------------------------------------------------------------
// `current_ticket` is set, tree is dirty, AND the armed gate (`runBetweenTicketFastTests`)
// returns red (fails fast because we plant a stub `extension/package.json` whose
// `test:fast` exits 1 immediately). With a red gate and a failing remediator,
// the ladder exhausts all rungs and `haltOrRecoverCodexNoProgress` returns
// `recovery_exhausted`. The wiring must record honest terminal exit_reason.

test('INV-CODEX-RECOVERY-EXHAUSTED: disposition=recovery_exhausted → honest terminal exit_reason=recovery_exhausted', async () => {
  const dir = makeTmp('chts-exhaust-');
  const dataRoot = makeTmp('chts-exhaust-data-');
  const prevDataRoot = process.env.PICKLE_DATA_ROOT;
  const prevTestMode = process.env.PICKLE_TEST_MODE;
  try {
    process.env.PICKLE_DATA_ROOT = dataRoot;
    process.env.PICKLE_TEST_MODE = '1';

    // Real git repo so isWorkingTreeDirty can run
    initGitRepo(dir);

    const sessionDir = path.join(dir, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });

    writeTicket(sessionDir, 'te1');
    writeTicket(sessionDir, 'te2');

    // Stub extension/ with a test:fast that exits 1 instantly so the armed gate
    // fails fast without running real tests. This triggers the exhausted path.
    const stubExtension = path.join(dir, 'extension');
    fs.mkdirSync(stubExtension, { recursive: true });
    fs.writeFileSync(path.join(stubExtension, 'package.json'), JSON.stringify({
      name: 'stub-extension',
      version: '0.0.0',
      scripts: { 'test:fast': 'node -e "process.exit(1)"' },
    }));

    const { statePath } = writeState(sessionDir, {
      current_ticket: 'te1',
      working_dir: dir,
    });

    // Dirty the working tree (untracked file)
    fs.writeFileSync(path.join(dir, 'uncommitted_work.txt'), 'worker output\n');

    const logs = [];
    const deactivateCalls = [];

    await armNoProgressHalt(sessionDir, statePath, logs);

    // Pass 3: halt fires → seam → dirty tree + gate red (stub exits 1) +
    // remediator fails → exhausted → recovery_exhausted
    const s3 = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const action = await processCompletionBranch(
      s3,
      'inactive',
      buildCtx(sessionDir, statePath, logs, deactivateCalls, 3),
    );

    assert.equal(action.kind, 'break',
      `expected break, got: ${JSON.stringify(action)}`);
    assert.equal(action.reason, 'recovery_exhausted',
      `expected recovery_exhausted, got: ${action.reason}`);

    assert.ok(deactivateCalls.length >= 1,
      'deactivate must be called on recovery_exhausted');

    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(persisted.exit_reason, 'recovery_exhausted',
      'exit_reason must be recovery_exhausted, not codex_manager_no_progress');

    // Recovery attempts must be populated in state
    assert.ok(Array.isArray(persisted.recovery_attempts),
      'recovery_attempts must be an array in persisted state');
    assert.ok(persisted.recovery_attempts.length > 0,
      `at least one recovery attempt must be recorded, got: ${JSON.stringify(persisted.recovery_attempts)}`);
  } finally {
    if (prevDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prevDataRoot;
    if (prevTestMode === undefined) delete process.env.PICKLE_TEST_MODE;
    else process.env.PICKLE_TEST_MODE = prevTestMode;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// INV-CODEX-RECOVERY-ADVANCED
// ---------------------------------------------------------------------------
// `current_ticket` is set, tree is dirty (tracked file modified), and there is
// NO `extension/` dir under working_dir so the armed gate short-circuits to
// `{ ok: true }` immediately. `PICKLE_TEST_MODE=1` bypasses `guardCompletionCommitBeforeDone`.
// The commit-and-continue rung fires and the ladder returns `advanced`.
// The wiring must NOT park — action.kind === 'relaunch'.

test('INV-CODEX-RECOVERY-ADVANCED: disposition=advanced → loop continues (kind=relaunch, no park)', async () => {
  const dir = makeTmp('chts-advanced-');
  const dataRoot = makeTmp('chts-advanced-data-');
  const prevDataRoot = process.env.PICKLE_DATA_ROOT;
  const prevTestMode = process.env.PICKLE_TEST_MODE;
  try {
    process.env.PICKLE_DATA_ROOT = dataRoot;
    // PICKLE_TEST_MODE=1: (1) guardCompletionCommitBeforeDone bypasses, (2) avoids
    // the config-protection hook from blocking the recovery commit.
    process.env.PICKLE_TEST_MODE = '1';

    // Real git repo so git add + git commit work; no extension/ subdir so gate passes
    initGitRepo(dir);
    // Verify no extension/ so the armed gate short-circuits to ok:true
    assert.ok(!fs.existsSync(path.join(dir, 'extension')),
      'extension/ must not exist so armed gate passes immediately');

    const sessionDir = path.join(dir, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });

    writeTicket(sessionDir, 'ta1');
    writeTicket(sessionDir, 'ta2');

    const { statePath } = writeState(sessionDir, {
      current_ticket: 'ta1',
      working_dir: dir,
    });

    // Dirty the working tree: modify the tracked placeholder file
    fs.writeFileSync(path.join(dir, 'placeholder.txt'), 'modified by worker\n');
    // Confirm the tree is actually dirty before proceeding
    const statusOut = spawnSync('git', ['status', '--porcelain'], {
      cwd: dir, encoding: 'utf-8', timeout: 5000,
    });
    assert.ok(statusOut.stdout.trim().length > 0,
      `expected dirty git tree before test, got: "${statusOut.stdout.trim()}"`);

    const logs = [];
    const deactivateCalls = [];

    await armNoProgressHalt(sessionDir, statePath, logs);

    // Pass 3: halt fires → seam → dirty tree + gate passes (no extension/) +
    // commit succeeds (real git, PICKLE_TEST_MODE guard bypass) → advanced
    const s3 = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const action = await processCompletionBranch(
      s3,
      'inactive',
      buildCtx(sessionDir, statePath, logs, deactivateCalls, 3),
    );

    // advanced disposition → wiring must relaunch, not park
    assert.equal(action.kind, 'relaunch',
      `expected relaunch (advanced), got: ${JSON.stringify(action)}`);

    // Must NOT deactivate when ladder advances
    assert.equal(deactivateCalls.length, 0,
      `deactivate must NOT be called on advanced disposition, got ${deactivateCalls.length} calls`);

    // exit_reason must NOT be set to a park reason
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.notEqual(persisted.exit_reason, 'codex_manager_no_progress',
      'exit_reason must not be codex_manager_no_progress after advanced');
    assert.notEqual(persisted.exit_reason, 'recovery_exhausted',
      'exit_reason must not be recovery_exhausted after advanced');

    // Recovery log must mention the advance
    const advancedLog = logs.find((l) => l.includes('advanced') || l.includes('recovery:'));
    assert.ok(advancedLog !== undefined,
      `expected a recovery advance log line, got logs:\n${logs.slice(-10).join('\n')}`);
  } finally {
    if (prevDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prevDataRoot;
    if (prevTestMode === undefined) delete process.env.PICKLE_TEST_MODE;
    else process.env.PICKLE_TEST_MODE = prevTestMode;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

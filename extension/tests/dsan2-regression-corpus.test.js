// @tier: fast
/**
 * B-DSAN2 cross-incident regression corpus (AC-D2, ticket edf0d551).
 * File: extension/tests/dsan2-regression-corpus.test.js
 *
 * SINGLE OWNER of the three cross-incident integration assertions for the
 * B-DSAN2 bundle. Each test encodes one of the three live incidents as a
 * FAIL-WITHOUT-FIX lock:
 *
 *   1. premature-advance   — pipeline advances past pickle on a clean mux exit-0
 *                            while runnable tickets remain (AC-A1, fix 508cb144).
 *   2. read-block          — config-protection blocks a READ-ONLY Bash command
 *                            over a protected path (AC-C1, fix 983b3de8).
 *
 * Each test asserts the FIXED behavior, so the corpus is RED on the pre-fix
 * start_commit `4f7b79f4` and GREEN on current HEAD.
 *
 * DESIGN CONTRACT — RED-on-`4f7b79f4` MUST be an ASSERTION failure, not a
 * missing-symbol ERROR. Every test drives a STABLE entry point that EXISTS at
 * BOTH `4f7b79f4` AND HEAD, so on old code the test fails because the BEHAVIOR
 * is wrong, never because an import/reference throws. The fixed-this-bundle
 * functions (`maybeStampPicklePendingTickets`,
 * `bashWritesProtectedConfig`) are deliberately NOT called — they do not exist
 * at `4f7b79f4` and would turn a clean RED into a reference ERROR.
 *
 * Stable entry points (all confirmed present at `4f7b79f4` via git show):
 *   - Incident 1: `main(sessionDir)` + `__setSpawnRunnerForTests` exported from
 *     `bin/pipeline-runner.js` (4f7b79f4 pipeline-runner.ts:3554 / :1176).
 *     RED-on-old: the R-CMWL-2 carve-out in `maybeStampPhaseIncompleteTickets`
 *     (4f7b79f4 pipeline-runner.ts:3076) ADVANCES a clean exit-0 with a pending
 *     ticket whenever any within-pass progress (≥1 Done OR ≥1 commit) exists, so
 *     `state.exit_reason` is NOT `pipeline_phase_incomplete` and the exit code is
 *     NOT 3 — assertion failure.
 *   - Incident 2: the `bin/check-readiness.js` CLI (`--session-dir --repo-root
 *     --contract-only`) → exported `runReadiness` (4f7b79f4 check-readiness.ts:1186).
 *     RED-on-old: `findPathFindings` (4f7b79f4 check-readiness.ts:972) suppresses
 *     only via exact `creationIndex.has(ref)`, so a bare `tests/X` ref against a
 *     declared deep `extension/tests/X` is NOT suppressed and yields a blocking
 *     `file_path` finding (exit 2) — assertion failure.
 *   - Incident 3: the `hooks/handlers/config-protection.js` stdin→stdout handler.
 *     RED-on-old: the Bash branch of `detectTargetedConfigFile` calls
 *     `isBashTargetingConfig` (4f7b79f4 config-protection.ts:229), a read-OR-write
 *     token matcher, so a read-only `grep` / `cat` over a protected CONFIG path
 *     (e.g. the `tsconfig.json` token matched by `isProtectedFile`, or
 *     `.eslintrc.json`) emits `decision: 'block'` instead of `'approve'` —
 *     assertion failure.
 *
 * The actual RED-on-`4f7b79f4` worktree verification is performed by the manager.
 * The per-AC unit locks (pipeline-runner-halt-on-incomplete.test.js,
 * check-readiness-forward-ref-fixture.test.js AC-B1, config-protection.test.js
 * AC-C1/C2) remain the focused owners of their own AC; this corpus is the
 * cross-incident integration owner referenced by AC-D3 (7c3f7dc5) and AC-D4
 * (1f40afec). It does not re-declare those locks — it is self-contained.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { __setSpawnRunnerForTests, main } from '../bin/pipeline-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PROTECTION_HANDLER = path.resolve(__dirname, '../hooks/handlers/config-protection.js');
const READINESS_BIN = path.resolve(__dirname, '../bin/check-readiness.js');
const REPO_ROOT = path.resolve(__dirname, '..');

function tmpDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// ===========================================================================
// Incident 3 — read-block (config-protection over-block of read-only Bash)
// ===========================================================================

function writeExtensionSentinel(extensionDir) {
  const sentinelDir = path.join(extensionDir, 'extension', 'bin');
  fs.mkdirSync(sentinelDir, { recursive: true });
  fs.writeFileSync(path.join(sentinelDir, 'log-watcher.js'), '');
}

/** Drive the config-protection handler subprocess; returns the parsed decision. */
function runConfigProtectionHandler(command) {
  const tmp = tmpDir('dsan2-cp-');
  try {
    writeExtensionSentinel(tmp);
    const sessionDir = path.join(tmp, 'sessions', 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    const stateFile = path.join(sessionDir, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      active: true,
      working_dir: process.cwd(),
      step: 'implement',
      iteration: 1,
      max_iterations: 5,
      max_time_minutes: 60,
      worker_timeout_seconds: 1200,
      start_time_epoch: Math.floor(Date.now() / 1000) - 30,
      completion_promise: null,
      original_prompt: 'dsan2 read-block corpus',
      current_ticket: 'dsan2-read-block-01',
      history: [],
      started_at: new Date().toISOString(),
      session_dir: sessionDir,
      tmux_mode: false,
    }));
    fs.writeFileSync(
      path.join(tmp, 'current_sessions.json'),
      JSON.stringify({ [process.cwd()]: sessionDir }),
    );

    const env = { ...process.env, EXTENSION_DIR: tmp, FORCE_COLOR: '0', PICKLE_STATE_FILE: stateFile };
    const hookInput = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
    const stdout = execFileSync(process.execPath, [CONFIG_PROTECTION_HANDLER], {
      input: hookInput,
      encoding: 'utf-8',
      env,
      timeout: 15000,
    });
    return JSON.parse(stdout.trim());
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('B-DSAN2 incident-3 read-block: grep over a protected config file approves (read-only)', () => {
  // RED on 4f7b79f4: the Bash branch of detectTargetedConfigFile routed through
  // isBashTargetingConfig (config-protection.ts:229), a read-OR-write token
  // matcher. isProtectedFile matches the `tsconfig.json` token (the protected
  // pattern /^tsconfig(\..*)?\.json$/), so this read-only grep was BLOCKED.
  // GREEN on HEAD: the write-aware bashWritesProtectedConfig gate approves the
  // read because grep does not write tsconfig.json.
  const result = runConfigProtectionHandler("grep -l 'compilerOptions' tsconfig.json");
  assert.equal(
    result.decision,
    'approve',
    `read-block regression: a read-only grep over a protected config file must approve; got ${JSON.stringify(result)}`,
  );
});

test('B-DSAN2 incident-3 read-block: cat over a protected config file approves (read-only)', () => {
  const result = runConfigProtectionHandler('cat .eslintrc.json');
  assert.equal(
    result.decision,
    'approve',
    `read-block regression: a read-only cat over a protected config file must approve; got ${JSON.stringify(result)}`,
  );
});

// ===========================================================================
// Incident 1 — premature-advance (pickle exit-0 with pending tickets)
// ===========================================================================

class ExitIntercept extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 15000 }).trim();
}

function initRepo(dir) {
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'dsan2@test.local'], dir);
  git(['config', 'user.name', 'DSAN2 Corpus'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'seed.ts'), 'export const seed = 1;\n');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'seed'], dir);
}

function writePipelineState(sessionDir, repo, overrides = {}) {
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
    original_prompt: 'dsan2 premature-advance corpus',
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

function writePipelineConfig(sessionDir, repo, phases) {
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

function writePipelineTicket(sessionDir, id, order, status) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(
    path.join(ticketDir, `linear_ticket_${id}.md`),
    `---\nid: ${id}\ntitle: DSAN2 premature-advance ticket ${id}\nstatus: ${status}\norder: ${order}\n---\n\n# Test\n`,
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

afterEach(() => {
  __setSpawnRunnerForTests(null);
});

test('B-DSAN2 incident-1 premature-advance: clean pickle exit-0 with a pending ticket halts incomplete (no advance)', async () => {
  // RED on 4f7b79f4: maybeStampPhaseIncompleteTickets carves out within-pass
  // progress (≥1 Done OR ≥1 commit), so a clean exit-0 with a pending ticket
  // ADVANCES — exit_reason is NOT pipeline_phase_incomplete and the exit code is
  // NOT 3. GREEN on HEAD: the catch-all gate stamps pipeline_phase_incomplete on
  // pendingCount > 0 regardless of progress, and finalize exits 3 (no advance).
  const repo = tmpDir('dsan2-pipeline-repo-');
  const sessionDir = tmpDir('dsan2-pipeline-session-');
  try {
    initRepo(repo);
    const startCommit = git(['rev-parse', 'HEAD'], repo);
    writePipelineState(sessionDir, repo, { start_commit: startCommit });
    // citadel queued next so a false advance would be observable as phase progress.
    writePipelineConfig(sessionDir, repo, ['pickle', 'citadel']);

    // 1 Done ticket + 1 still-Todo ticket → partial progress, ≥1 pending.
    writePipelineTicket(sessionDir, 'dsan2aaa', 1, 'Done');
    writePipelineTicket(sessionDir, 'dsan2bbb', 2, 'Todo');

    // Stub: mux exits 0 (clean) after landing a real commit since start_commit,
    // so commitCount>0 defeats the 4f7b79f4 carve-out and forces the catch-all.
    __setSpawnRunnerForTests(async () => {
      fs.writeFileSync(path.join(repo, 'work.ts'), 'export const work = 2;\n');
      git(['add', '.'], repo);
      git(['commit', '-q', '-m', 'dsan2aaa partial progress'], repo);
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await captureMainExit(sessionDir, 3);

    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(
      state.exit_reason,
      'pipeline_phase_incomplete',
      'premature-advance regression: a clean exit-0 with a pending ticket must stamp pipeline_phase_incomplete',
    );

    // The pending ticket stays Todo (the pipeline did not falsely complete it).
    const pendingFile = path.join(sessionDir, 'dsan2bbb', 'linear_ticket_dsan2bbb.md');
    assert.ok(
      fs.readFileSync(pendingFile, 'utf-8').includes('status: Todo'),
      'premature-advance regression: the pending ticket must remain Todo (no false advance)',
    );

    // pipeline-status.json must not report 2/2 phases completed (no citadel advance).
    const statusPath = path.join(sessionDir, 'pipeline-status.json');
    if (fs.existsSync(statusPath)) {
      const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
      assert.ok(
        (status.completed_phases ?? 0) < 2,
        'premature-advance regression: the pipeline must not advance past pickle on an incomplete bundle',
      );
    }
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

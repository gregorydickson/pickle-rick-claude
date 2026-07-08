// @tier: fast
/**
 * B-RRH C1/C2 — gate pickle-phase completion on all-tickets-Done, not the mux
 * exit code. An external SIGTERM kills the pickle mux which exits 0; the
 * pipeline must NOT read exit-0 as completion and advance to citadel on a
 * partial build.
 *
 * C2 (mux-runner): on signal teardown with ≥1 ticket remaining, write a
 *   `pickle_incomplete.json` sentinel into SESSION_ROOT + emit the
 *   `pickle_incomplete` activity event.
 * C1 (pipeline-runner): after the pickle mux exits, scan the ticket roster +
 *   sentinel. Any non-Done runnable ticket OR sentinel presence OR missing
 *   roster → INCOMPLETE: do not advance to citadel (no citadel_report.json),
 *   exit PipelineRunnerExitCode.PhaseIncomplete (3), stamp pipeline_phase_incomplete.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  __setSpawnRunnerForTests,
  main,
} from '../bin/pipeline-runner.js';
import { writePickleIncompleteSentinelIfRemaining } from '../bin/mux-runner.js';
import { PipelineRunnerExitCode } from '../types/index.js';

const SENTINEL = 'pickle_incomplete.json';

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
  return git(['rev-parse', 'HEAD'], dir);
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
    original_prompt: 'rrh incomplete test',
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

function writePipeline(sessionDir, repo, phases = ['pickle', 'citadel']) {
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
    `---\nid: ${id}\ntitle: RRH test ticket ${id}\nstatus: ${status}\norder: ${order}\n---\n\n# Test\n`,
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

// ── AC2: SIGTERM-killed mux (sentinel) + clean exit (0) → NO citadel advance ──
// This is the B-XSPA bug: an external SIGTERM kills the mux with ≥1 ticket still
// Todo, but the mux exit code reads 0 (indistinguishable from clean completion).
// C2's teardown drops the `pickle_incomplete.json` sentinel; C1's robust gate
// reads that sentinel and refuses to advance to citadel on the partial build.
// (A clean exit-0 with partial progress and NO sentinel is NOT this bug — that is
// the normal R-CMWL-2 partial-progress path and is covered by the no-progress
// suite, where it advances so downstream remediation is preserved.)
test('SIGTERM-killed mux drops the sentinel → pipeline does NOT advance to citadel (exit 0 disguise)', async () => {
  const repo = tmpDir('rrh-repo-');
  const sessionDir = tmpDir('rrh-session-');
  try {
    const head = initRepo(repo);
    writeState(sessionDir, repo, { start_commit: head });
    writePipeline(sessionDir, repo, ['pickle', 'citadel']);

    // 2 Done, 1 Todo — partial build the SIGTERM interrupted.
    writeTicket(sessionDir, 'aaa11111', 1, 'Done');
    writeTicket(sessionDir, 'bbb22222', 2, 'Done');
    writeTicket(sessionDir, 'ccc33333', 3, 'Todo');

    // Mux exits CLEAN (0) but its signal teardown dropped the sentinel — the
    // SIGTERM-killed-mux disguise that an exit code alone cannot detect.
    __setSpawnRunnerForTests(async () => {
      fs.writeFileSync(
        path.join(sessionDir, SENTINEL),
        JSON.stringify({ remaining_count: 1, total: 3 }),
      );
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await captureMainExit(sessionDir, PipelineRunnerExitCode.PhaseIncomplete);

    // No PHASE 2: citadel never ran, so no citadel_report.json.
    assert.ok(
      !fs.existsSync(path.join(sessionDir, 'citadel_report.json')),
      'citadel must NOT run when the pickle_incomplete sentinel is present',
    );
    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(state.exit_reason, 'pipeline_phase_incomplete');
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ── AC2b: sentinel present forces incomplete even when roster reads all-Done ──
test('pickle_incomplete.json sentinel forces incomplete even on exit 0 with all tickets Done', async () => {
  const repo = tmpDir('rrh-repo-');
  const sessionDir = tmpDir('rrh-session-');
  try {
    const head = initRepo(repo);
    writeState(sessionDir, repo, { start_commit: head });
    writePipeline(sessionDir, repo, ['pickle', 'citadel']);

    writeTicket(sessionDir, 'aaa11111', 1, 'Done');
    writeTicket(sessionDir, 'bbb22222', 2, 'Done');
    // mux dropped the sentinel during teardown before it could finish.
    fs.writeFileSync(
      path.join(sessionDir, SENTINEL),
      JSON.stringify({ reason: 'signal_teardown', remaining_count: 1, total: 2, ts: new Date().toISOString() }),
    );

    __setSpawnRunnerForTests(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    await captureMainExit(sessionDir, PipelineRunnerExitCode.PhaseIncomplete);

    assert.ok(
      !fs.existsSync(path.join(sessionDir, 'citadel_report.json')),
      'sentinel presence must block citadel advance even when all tickets read Done',
    );
    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(state.exit_reason, 'pipeline_phase_incomplete');
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ── AC3: all Done + no sentinel → normal advance preserved ───────────────────
test('all tickets Done + no sentinel advances normally (pickle phase completes)', async () => {
  const repo = tmpDir('rrh-repo-');
  const sessionDir = tmpDir('rrh-session-');
  try {
    const head = initRepo(repo);
    writeState(sessionDir, repo, { start_commit: head });
    // pickle-only pipeline: prove pickle completes (no incomplete exit) without
    // dragging citadel's prd_path/start_commit requirements into the assertion.
    writePipeline(sessionDir, repo, ['pickle']);

    writeTicket(sessionDir, 'aaa11111', 1, 'Done');
    writeTicket(sessionDir, 'bbb22222', 2, 'Done');

    // Land a commit since start so maybeStampPhaseNoProgress also stays clear.
    fs.writeFileSync(path.join(repo, 'impl.ts'), 'export const y = 2;\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'feat: ship aaa11111 bbb22222'], repo);

    __setSpawnRunnerForTests(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    // Normal success → exit code 0 (Success).
    await captureMainExit(sessionDir, PipelineRunnerExitCode.Success);

    assert.ok(
      !fs.existsSync(path.join(sessionDir, SENTINEL)),
      'no sentinel should exist on a clean all-Done run',
    );
    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.notEqual(state.exit_reason, 'pipeline_phase_incomplete');
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ── AC1 (C2): mux sentinel-write + event-emit helper ─────────────────────────
test('writePickleIncompleteSentinelIfRemaining writes sentinel + emits event when ≥1 ticket remains', () => {
  const sessionDir = tmpDir('rrh-c2-session-');
  try {
    writeState(sessionDir, sessionDir);
    writeTicket(sessionDir, 'aaa11111', 1, 'Done');
    writeTicket(sessionDir, 'bbb22222', 2, 'Todo');

    const statePath = path.join(sessionDir, 'state.json');
    const wrote = writePickleIncompleteSentinelIfRemaining(sessionDir, statePath, () => {});

    assert.equal(wrote, true);
    const sentinelPath = path.join(sessionDir, SENTINEL);
    assert.ok(fs.existsSync(sentinelPath), 'sentinel file must be written');
    const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf-8'));
    assert.equal(sentinel.remaining_count, 1);
    assert.equal(sentinel.total, 2);

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.ok(
      Array.isArray(state.activity) && state.activity.some(e => e.event === 'pickle_incomplete'),
      'pickle_incomplete activity event must be emitted into state.activity',
    );
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('writePickleIncompleteSentinelIfRemaining writes NO sentinel when all tickets Done', () => {
  const sessionDir = tmpDir('rrh-c2-session-');
  try {
    writeState(sessionDir, sessionDir);
    writeTicket(sessionDir, 'aaa11111', 1, 'Done');
    writeTicket(sessionDir, 'bbb22222', 2, 'Done');

    const statePath = path.join(sessionDir, 'state.json');
    const wrote = writePickleIncompleteSentinelIfRemaining(sessionDir, statePath, () => {});

    assert.equal(wrote, false);
    assert.ok(
      !fs.existsSync(path.join(sessionDir, SENTINEL)),
      'no sentinel when all tickets are Done',
    );
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

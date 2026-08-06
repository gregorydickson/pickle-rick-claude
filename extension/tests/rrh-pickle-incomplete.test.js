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
import {
  installShutdownSignalHandlers,
  writePickleIncompleteSentinelIfRemaining,
} from '../bin/mux-runner.js';
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

/** A trivial PRD — citadel self-heals state.prd_path by adopting this file. */
function writePrd(sessionDir) {
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Test PRD\n\n## Acceptance Criteria\n- [ ] n/a\n');
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

// ── AC2 (SUPERSEDED by B-NOSTOP-GATES WS-1): SIGTERM-killed mux (sentinel) +
// clean exit (0) → reports incomplete AND ADVANCES ──
// This is the B-XSPA bug: an external SIGTERM kills the mux with ≥1 ticket still
// Todo, but the mux exit code reads 0 (indistinguishable from clean completion).
// C2's teardown drops the `pickle_incomplete.json` sentinel; C1's robust gate
// reads that sentinel and reports the phase incomplete.
// OLD (pre-WS-1): the sentinel FORCED a halt — citadel never ran.
// NEW (WS-1): honesty (the stamp) and halting are separate wires — the sentinel
// still reports incomplete (via reportPhaseIncomplete, unchanged: the ccc33333
// Todo ticket is genuinely unfinished, not oracle-excluded), but the phase now
// ADVANCES to citadel instead of halting before it.
test('SIGTERM-killed mux drops the sentinel → reports incomplete but still ADVANCES to citadel', async () => {
  const repo = tmpDir('rrh-repo-');
  const sessionDir = tmpDir('rrh-session-');
  try {
    const head = initRepo(repo);
    writeState(sessionDir, repo, { start_commit: head });
    writePipeline(sessionDir, repo, ['pickle', 'citadel']);
    writePrd(sessionDir);

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

    // WS-1: exit code stays 3 (phaseIncomplete survives via the main-loop
    // accumulator regardless of action), but citadel IS reached and runs.
    await captureMainExit(sessionDir, PipelineRunnerExitCode.PhaseIncomplete);

    assert.ok(
      fs.existsSync(path.join(sessionDir, 'citadel_report.json')),
      'WS-1: citadel must run — the sentinel reports incomplete but no longer blocks advance',
    );
    const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.match(log, /PHASE 2\/2: CITADEL/);
    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(state.exit_reason, 'pipeline_phase_incomplete');
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ── AC2b (SUPERSEDED by B-NOSTOP-GATES WS-1): sentinel + all-Done roster now
// advances (ground truth wins), while the sentinel still forces exit code 3 ──
// OLD (pre-WS-1): the sentinel forced BOTH a halt (citadel blocked) AND a
// `pipeline_phase_incomplete` stamp, unconditionally — even over an honestly
// all-Done roster (this test's original premise).
// NEW (WS-1): `maybeStampPickleIncompleteRobust` still calls `reportPhaseIncomplete`
// unconditionally and its RETURNED `phaseIncomplete: true` is still hardcoded
// (the sentinel always forces exit code 3 for reconciliation, per the plan) —
// but `reportPhaseIncomplete` ITSELF now defers to ground truth: a genuinely
// all-Done roster (unfinished.length === 0) declines to stamp
// `pipeline_phase_incomplete` at all, and the phase ADVANCES to citadel, which
// runs and succeeds. The exit code (3) and the exit_reason (unstamped) can
// therefore disagree — that split is intentional: the code is the sentinel's
// disposition signal, the reason is the roster's honest verdict.
test('pickle_incomplete.json sentinel forces exit 3 but an honestly all-Done roster still advances to citadel', async () => {
  const repo = tmpDir('rrh-repo-');
  const sessionDir = tmpDir('rrh-session-');
  try {
    const head = initRepo(repo);
    writeState(sessionDir, repo, { start_commit: head });
    writePipeline(sessionDir, repo, ['pickle', 'citadel']);
    writePrd(sessionDir);

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
      fs.existsSync(path.join(sessionDir, 'citadel_report.json')),
      'WS-1: an honestly all-Done roster must reach and run citadel despite the sentinel',
    );
    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.notEqual(
      state.exit_reason,
      'pipeline_phase_incomplete',
      'ground truth (all-Done) must win over the sentinel for the STAMP — only the exit code stays 3',
    );
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

// ── C2 WIRING: the handler that is actually REGISTERED must stamp the sentinel ─
// Every C1 test above hand-writes `pickle_incomplete.json`, so they stayed green
// over a producer that never ran: the sole caller of
// `writePickleIncompleteSentinelIfRemaining` lived in an exported
// `setupSignalHandlers` that nothing invoked, while the handler `runMuxRunnerMain`
// actually registered was an inline twin that omitted the stamp. C1's
// `maybeStampPickleIncompleteRobust` therefore read a file no producer wrote.
// This drives the real registered handler end-to-end.
test('B-RRH C2: the REGISTERED shutdown handler stamps the sentinel when a ticket remains', () => {
  const repo = tmpDir('rrh-c2-repo-');
  const sessionDir = tmpDir('rrh-c2-session-');
  const dataRoot = tmpDir('rrh-c2-data-');
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
  const preexisting = new Map(signals.map((sig) => [sig, process.listeners(sig)]));
  const originalExit = process.exit;
  const originalDataRoot = process.env.PICKLE_DATA_ROOT;
  try {
    initRepo(repo);
    writeState(sessionDir, repo, { active: true });
    writeTicket(sessionDir, 'ddd44444', 1, 'Todo');
    process.env.PICKLE_DATA_ROOT = dataRoot;
    process.exit = (code) => { throw new ExitIntercept(code ?? 0); };

    let released = 0;
    const handler = installShutdownSignalHandlers({
      statePath: path.join(sessionDir, 'state.json'),
      sessionDir,
      log: () => {},
      releaseSessionResources: () => { released += 1; },
    });

    // The returned handler is only meaningful if it is the one wired to signals.
    for (const sig of signals) {
      assert.equal(
        process.listeners(sig).length,
        preexisting.get(sig).length + 1,
        `${sig} handler must be registered`,
      );
    }

    assert.throws(
      () => handler('SIGTERM'),
      (err) => err instanceof ExitIntercept && err.code === 0,
    );

    const sentinelPath = path.join(sessionDir, SENTINEL);
    assert.ok(fs.existsSync(sentinelPath), 'C2 sentinel must be written on signal teardown');
    const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf-8'));
    assert.equal(sentinel.reason, 'signal_teardown');
    assert.equal(sentinel.remaining_count, 1);
    assert.equal(sentinel.total, 1);
    assert.equal(released, 1, 'session-scoped handles must be released on teardown');
  } finally {
    process.exit = originalExit;
    if (originalDataRoot === undefined) {
      delete process.env.PICKLE_DATA_ROOT;
    } else {
      process.env.PICKLE_DATA_ROOT = originalDataRoot;
    }
    for (const sig of signals) {
      for (const listener of process.listeners(sig)) {
        if (!preexisting.get(sig).includes(listener)) process.removeListener(sig, listener);
      }
    }
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// @tier: fast
/**
 * AC-ICP-02 — pipeline-runner halts the pipeline and stamps
 * state.exit_reason = 'pipeline_phase_incomplete' when a phase runner exits
 * with code 3 (PipelineRunnerExitCode.PhaseIncomplete). The unfinished ticket
 * list is written to the pipeline log.
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
import { PipelineRunnerExitCode } from '../types/index.js';

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
    original_prompt: 'halt test',
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
    `---\nid: ${id}\ntitle: Halt test ticket ${id}\nstatus: ${status}\norder: ${order}\n---\n\n# Test\n`,
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

test('PipelineRunnerExitCode.PhaseIncomplete equals 3', () => {
  assert.equal(PipelineRunnerExitCode.PhaseIncomplete, 3);
  assert.equal(PipelineRunnerExitCode.Success, 0);
  assert.equal(PipelineRunnerExitCode.Failure, 1);
});

test('pipeline-runner.halt-on-incomplete-phase', async () => {
  const repo = tmpDir('pipeline-halt-repo-');
  const sessionDir = tmpDir('pipeline-halt-session-');
  try {
    initRepo(repo);
    writeState(sessionDir, repo);
    writePipeline(sessionDir, repo, ['pickle']);

    // Write 3 Todo tickets so reportPhaseIncomplete has something to list
    writeTicket(sessionDir, 'aaa11111', 1);
    writeTicket(sessionDir, 'bbb22222', 2);
    writeTicket(sessionDir, 'ccc33333', 3);

    // Stub: simulate mux-runner capping without EPIC_COMPLETED — exits 3
    __setSpawnRunnerForTests(async () => {
      // mux-runner records iteration_cap_exhausted before exiting 3
      const statePath = path.join(sessionDir, 'state.json');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      state.exit_reason = 'iteration_cap_exhausted';
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      return { exitCode: 3, stdout: '', stderr: '' };
    });

    await captureMainExit(sessionDir, 3);

    // state.exit_reason must be pipeline_phase_incomplete (not iteration_cap_exhausted)
    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(
      state.exit_reason,
      'pipeline_phase_incomplete',
      'pipeline-runner must stamp pipeline_phase_incomplete, not iteration_cap_exhausted',
    );

    // pipeline-runner.log must mention unfinished ticket count
    const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.ok(
      /hit iteration cap/.test(log) || /iteration cap/.test(log),
      'log must contain iteration cap message',
    );
    assert.ok(
      /unfinished/.test(log) || /remain/.test(log),
      'log must mention unfinished ticket count',
    );

    // All 3 tickets must still be Todo (pipeline did not falsely complete them)
    for (const id of ['aaa11111', 'bbb22222', 'ccc33333']) {
      const ticketFile = path.join(sessionDir, id, `rick_ticket_${id}.md`);
      const content = fs.readFileSync(ticketFile, 'utf-8');
      assert.ok(content.includes('status: Todo'), `ticket ${id} must remain Todo after pipeline halt`);
    }
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// AC-A1 (WS-A) / B-NOSTOP-GATES WS-1: a CLEAN mux exit-0 with ≥1 pending ticket AND
// partial progress (≥1 Done + ≥1 commit since start_commit) is a QUALITY signal, not
// a crash-floor halt.
//
// OLD (pre-WS-1): maybeStampPhaseGraduation's "not all-tickets-terminal" branch
// returned {action:'break', phaseIncomplete:true} — pipeline stopped BEFORE citadel,
// exit 3, no advance. Rationale then: "must NOT be treated as phase success."
// NEW (WS-1): the same branch returns {action:'continue', phaseIncomplete:true} —
// the phase reports incomplete for reconciliation but ADVANCES to citadel. In this
// fixture citadel then fails for an unrelated reason (no state.prd_path wired), so
// the session still exits 3 overall — but now because the earlier phaseIncomplete
// flag survives citadel's own break via the main-loop accumulator (WS-1 Phase 7),
// not because pickle itself halted. The behavioral change this test now pins is
// that citadel is REACHED at all — asserted directly against the pipeline log
// rather than inferred from the exit code alone.
test('pipeline-runner.clean-exit0-with-pending-and-progress advances to citadel, reporting incomplete', async () => {
  const repo = tmpDir('pipeline-halt0-repo-');
  const sessionDir = tmpDir('pipeline-halt0-session-');
  try {
    initRepo(repo);
    const startCommit = git(['rev-parse', 'HEAD'], repo);
    writeState(sessionDir, repo, { start_commit: startCommit });
    // citadel is queued next so a false advance would be observable as phase progress.
    writePipeline(sessionDir, repo, ['pickle', 'citadel']);

    // 1 Done ticket + 1 still-Todo ticket → partial progress, ≥1 pending.
    writeTicket(sessionDir, 'ddd44444', 1, 'Done');
    writeTicket(sessionDir, 'eee55555', 2, 'Todo');

    // Stub: mux exits 0 (clean) after landing a real commit since start_commit
    // (so commitCount>0 defeats the maybeStampPhaseIncompleteTickets carve-out).
    __setSpawnRunnerForTests(async () => {
      fs.writeFileSync(path.join(repo, 'work.ts'), 'export const y = 2;\n');
      git(['add', '.'], repo);
      git(['commit', '-q', '-m', 'ddd44444 partial progress'], repo);
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    // finalize exits 3 in THIS fixture (citadel's own unrelated failure keeps the
    // earlier phaseIncomplete flag alive) — see the WS-1 rationale comment above.
    await captureMainExit(sessionDir, 3);

    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(
      state.exit_reason,
      'pipeline_phase_incomplete',
      'clean exit-0 with a pending ticket must stamp pipeline_phase_incomplete',
    );

    // WS-1: citadel MUST be reached — pickle's partial-progress verdict reports
    // incomplete but advances instead of halting before citadel.
    const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.ok(
      /PHASE 2\/2: CITADEL/.test(runnerLog),
      'pickle must advance to citadel on partial-progress incomplete, not halt before it',
    );

    // The pending ticket stays Todo (pipeline did not falsely complete it).
    const pendingFile = path.join(sessionDir, 'eee55555', 'rick_ticket_eee55555.md');
    assert.ok(
      fs.readFileSync(pendingFile, 'utf-8').includes('status: Todo'),
      'pending ticket must remain Todo (no false advance)',
    );

    // pipeline-status.json must not report 2/2 phases completed (no citadel advance).
    const statusPath = path.join(sessionDir, 'pipeline-status.json');
    if (fs.existsSync(statusPath)) {
      const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
      assert.ok(
        (status.completed_phases ?? 0) < 2,
        'pipeline must not advance past the pickle phase on an incomplete bundle',
      );
    }
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// AC-A1 negative case: a clean mux exit-0 with ALL tickets terminal (Done/Skipped)
// MUST advance — the catch-all gate must not introduce a false-positive halt.
test('pipeline-runner.clean-exit0-all-terminal advances (no false halt)', async () => {
  const repo = tmpDir('pipeline-pass0-repo-');
  const sessionDir = tmpDir('pipeline-pass0-session-');
  try {
    initRepo(repo);
    const startCommit = git(['rev-parse', 'HEAD'], repo);
    writeState(sessionDir, repo, { start_commit: startCommit });
    writePipeline(sessionDir, repo, ['pickle']);

    writeTicket(sessionDir, 'fff66666', 1, 'Done');
    writeTicket(sessionDir, 'ggg77777', 2, 'Skipped');

    __setSpawnRunnerForTests(async () => {
      fs.writeFileSync(path.join(repo, 'done.ts'), 'export const z = 3;\n');
      git(['add', '.'], repo);
      git(['commit', '-q', '-m', 'fff66666 all done'], repo);
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    // All terminal → clean success exit 0.
    await captureMainExit(sessionDir, 0);

    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.notEqual(
      state.exit_reason,
      'pipeline_phase_incomplete',
      'all-terminal clean exit-0 must NOT stamp pipeline_phase_incomplete',
    );
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// B-PXBO WS-1 (R-DPGT): reportPhaseIncomplete must RE-RESOLVE each non-Done ticket
// through the completion oracle. A ticket still 'Todo' in frontmatter but whose
// completion landed as a real commit (oracle committed) is excluded from the
// unfinished set — so a detached worker that committed green minutes after the cap
// race is NOT declared phase-incomplete. With the only "unfinished" ticket excluded,
// reportPhaseIncomplete must NOT overwrite the mux iteration_cap_exhausted with
// pipeline_phase_incomplete.
test('pipeline-runner.WS-1 oracle-committed non-Done ticket is excluded from unfinished set', async () => {
  const repo = tmpDir('pipeline-ws1-repo-');
  const sessionDir = tmpDir('pipeline-ws1-session-');
  const prevDataRoot = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = tmpDir('pipeline-ws1-dataroot-');
  try {
    initRepo(repo);
    writeState(sessionDir, repo);
    writePipeline(sessionDir, repo, ['pickle']);

    // Frontmatter says Todo, but the worker committed green referencing the ticket id
    // (the race: the cap-check fired before the frontmatter flip landed).
    writeTicket(sessionDir, 'aaa10001', 1, 'Todo');

    __setSpawnRunnerForTests(async () => {
      // Land a commit whose subject references the ticket id → oracle reads committed.
      fs.writeFileSync(path.join(repo, 'aaa10001.ts'), 'export const a = 1;\n');
      git(['add', '.'], repo);
      git(['commit', '-q', '-m', 'fix(aaa10001): durable green work'], repo);
      const statePath = path.join(sessionDir, 'state.json');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      state.exit_reason = 'iteration_cap_exhausted';
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      return { exitCode: 3, stdout: '', stderr: '' };
    });

    // finalize still exits 3 (phaseIncomplete break), but the oracle-committed ticket
    // is excluded so reportPhaseIncomplete defers the pipeline_phase_incomplete stamp.
    await captureMainExit(sessionDir, 3);

    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.notEqual(
      state.exit_reason,
      'pipeline_phase_incomplete',
      'an oracle-committed non-Done ticket must NOT be counted unfinished (no incomplete stamp)',
    );

    const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.ok(
      /0\/1 tickets unfinished after oracle re-resolution|no phase-incomplete stamp/.test(log),
      'log must record the oracle re-resolution exclusion',
    );
  } finally {
    __setSpawnRunnerForTests(null);
    if (prevDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prevDataRoot;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// @tier: fast
/**
 * AC-MWMO-D2-8 / AC-MWMO-D2-9 — a `done_without_commit_evidence` pickle halt is
 * ALWAYS-FATAL, independent of `isFatalPhaseFailure`'s session-wide
 * `countCommitsSince` heuristic.
 *
 * `done_without_commit_evidence` means THIS ticket has no commit — it says
 * nothing about the session. The naive framing ("otherwise the pipeline
 * proceeds to citadel anyway") is FALSE when tickets are still pending:
 * `maybeStampPhaseGraduation` already refuses to graduate and stamps
 * `pipeline_phase_incomplete` in that case, so pinning a
 * countCommitsSince>0 + tickets-pending scenario would pass TODAY (pre-fix)
 * and prove nothing — it is deliberately NOT pinned here.
 *
 * The case that matters is ALL-TERMINAL: every ticket terminal (Done) but
 * the LAST one exited with no commit of its own, while an EARLIER ticket in
 * the same session already landed a commit (countCommitsSince(start_commit)
 * > 0). Pre-fix, `isFatalPhaseFailure` reads only the session-wide commit
 * count, sees it is nonzero, and returns false — `shouldHaltAfterPhase`
 * doesn't halt, `maybeStampPhaseGraduation` sees pendingCount===0 and
 * graduates unconditionally (it does not consult commit evidence at all),
 * and pipeline-runner logs the fake-green "Phase pickle completed
 * successfully" before advancing to citadel. This test asserts the
 * OPERATOR-VISIBLE OUTCOME (no success log line, citadel never entered,
 * zero completed phases recorded) — not merely that `isFatalPhaseFailure`
 * returns true — and is red-first: it fails on pre-fix source.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  __setSpawnRunnerForTests,
  isFatalPhaseFailure,
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
  return git(['rev-parse', 'HEAD'], dir);
}

function commitFollowup(dir, name) {
  fs.writeFileSync(path.join(dir, `${name}.ts`), `export const ${name} = 1;\n`);
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', name], dir);
}

function writeState(sessionDir, repo, startCommit, overrides = {}) {
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    active: false,
    working_dir: repo,
    step: 'implement',
    iteration: 0,
    max_iterations: 100,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    start_commit: startCommit,
    completion_promise: null,
    original_prompt: 'done_without_commit_evidence all-terminal test',
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

function writePipeline(sessionDir, repo, phases) {
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

function writeTicket(sessionDir, id, order, status) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(
    path.join(ticketDir, `rick_ticket_${id}.md`),
    `---\nid: ${id}\ntitle: dwce all-terminal ticket ${id}\nstatus: ${status}\norder: ${order}\n---\n\n# Test\n`,
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

test('AC-MWMO-D2-8/D2-9: all-terminal bundle with a commit-less final ticket halts pickle fatally, even with earlier session commits', async () => {
  const repo = tmpDir('pipe-dwce-repo-');
  const sessionDir = tmpDir('pipe-dwce-session-');
  try {
    const startCommit = initRepo(repo);
    // An EARLIER ticket in this session already committed real work — this is
    // what makes the session-wide countCommitsSince(startCommit) heuristic
    // return a nonzero count and, pre-fix, mask the LAST ticket's missing
    // commit evidence.
    commitFollowup(repo, 'earlier_ticket_work');

    writeState(sessionDir, repo, startCommit, {
      // The mux-runner halt this bundle is reproducing: the pickle phase
      // exited because the final ticket had no commit of its own.
      exit_reason: 'done_without_commit_evidence',
    });
    writePipeline(sessionDir, repo, ['pickle', 'citadel']);

    // ALL tickets terminal (Done) — pendingCount === 0, so
    // maybeStampPhaseGraduation's proportional gate graduates unconditionally
    // regardless of commit evidence on any individual ticket.
    writeTicket(sessionDir, 'aaa11111', 1, 'Done');
    writeTicket(sessionDir, 'bbb22222', 2, 'Done');

    // Mirrors the real mux-runner mapping: done_without_commit_evidence is a
    // FAILURE_EXIT_REASONS member, so the real runner would exit code 1 here.
    __setSpawnRunnerForTests(async () => {
      return { exitCode: 1, stdout: '', stderr: '' };
    });

    await captureMainExit(sessionDir, PipelineRunnerExitCode.Failure);

    const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');

    // Operator-visible outcome #1: no fake-green completion claim for pickle.
    assert.ok(
      !/Phase pickle completed successfully/.test(log),
      'AC-MWMO-D2-8: an all-terminal bundle with a commit-less final ticket must NOT log ' +
      '"Phase pickle completed successfully" — this line is the red-before-green marker ' +
      '(present pre-fix, absent post-fix)',
    );

    // Operator-visible outcome #2: citadel is never entered.
    assert.ok(
      !/CITADEL/.test(log),
      'AC-MWMO-D2-9: citadel must not be reached when the pickle halt is fatal',
    );

    // Operator-visible outcome #3: pipeline-status.json records zero completed
    // phases and a failed status — the pipeline did not advance.
    const status = JSON.parse(fs.readFileSync(path.join(sessionDir, 'pipeline-status.json'), 'utf-8'));
    assert.equal(status.status, 'failed', 'pipeline-status.json must report failed, not completed');
    assert.equal(
      status.completed_phases,
      0,
      'AC-MWMO-D2-9: zero phases may be recorded complete — the pickle phase itself must not ' +
      'count as completed',
    );
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// Fast unit-level companion to the outcome test above. On its own this proves
// nothing about the fake-green advance (AC-MWMO-D2-9 is explicit that a `true`
// nothing acts on changes nothing) — it exists only as a cheap, targeted
// regression for the boolean itself, alongside the operator-visible-outcome
// test which is the real gate.
test('isFatalPhaseFailure: done_without_commit_evidence is fatal even when countCommitsSince > 0', () => {
  const repo = tmpDir('pipe-dwce-unit-repo-');
  const sessionDir = tmpDir('pipe-dwce-unit-session-');
  try {
    const startCommit = initRepo(repo);
    commitFollowup(repo, 'earlier_ticket_work');
    writeState(sessionDir, repo, startCommit, { exit_reason: 'done_without_commit_evidence' });

    const runtime = {
      sessionDir,
      extensionRoot: process.cwd(),
      statePath: path.join(sessionDir, 'state.json'),
      config: { phases: ['pickle', 'citadel'], target: repo, citadel_strict: false },
      target: repo,
      workingDir: repo,
      repoRoot: repo,
      backend: 'claude',
      phaseEnv: {},
      log: () => {},
    };

    assert.equal(
      isFatalPhaseFailure('pickle', runtime),
      true,
      'done_without_commit_evidence must be fatal regardless of countCommitsSince',
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// non-vacuity note (do NOT pin this as a test case): a countCommitsSince>0 +
// tickets-STILL-PENDING scenario would already halt via
// maybeStampPhaseGraduation's `pendingCount === 0` graduation gate before
// isFatalPhaseFailure's return value can matter — that case passes identically
// pre-fix and post-fix, so pinning it here would prove nothing about this fix.
// The all-terminal case above is the only scenario where WS-2 changes the
// operator-visible outcome.

// @tier: fast
/**
 * AC-MWMO-D2-10 / AC-MWMO-D2-11 — WS-3: a `done_without_commit_evidence` halt
 * must report the reason that was actually recorded, not a generic 'failed'
 * (erasure at finalizePipeline's pipelineFailed branch) and not an invented
 * "halted for a reason other than build progress (e.g. strict phase policy)"
 * (misattribution in getFatalPickleHaltReason's commitCount>0 branch).
 *
 * Both defects are independently pinned here and both fail on pre-fix source:
 *   - AC-MWMO-D2-10: pre-fix, finalizePipeline's `else if (pipelineFailed)`
 *     branch unconditionally calls
 *     `finalizeTerminalState(statePath, { step: 'completed', exitReason: 'failed' })`,
 *     overwriting the specific `done_without_commit_evidence` already stamped
 *     on state.json with the generic 'failed'.
 *   - AC-MWMO-D2-11: pre-fix, `getFatalPickleHaltReason`'s commitCount>0
 *     branch always returns the literal
 *     "halted for a reason other than build progress (e.g. strict phase policy)"
 *     regardless of what was actually recorded — the opposite of the truth
 *     for a done_without_commit_evidence halt, which IS about build progress.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  __setSpawnRunnerForTests,
  logPhaseHaltReason,
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
    original_prompt: 'done_without_commit_evidence reason-report test',
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
    `---\nid: ${id}\ntitle: dwce reason-report ticket ${id}\nstatus: ${status}\norder: ${order}\n---\n\n# Test\n`,
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

// B-GTRUTH WS-A2 RECONCILIATION.
//
// AC-MWMO-D2-10's guarantee is "finalize must not launder a specific halt into the
// generic 'failed'". That guarantee HOLDS — but WS-A2 changes which specific reason
// finalize lands on. The ticket-scoped `done_without_commit_evidence` is now rerouted
// into the PhaseIncomplete contract (mux exit code 3), so the pipeline-level exit_reason
// becomes `pipeline_phase_incomplete` — still specific, still not 'failed'.
//
// The originating reason is not lost: `reportPhaseIncomplete` reads the prior
// exit_reason and names it in its own log line, which this test now asserts. That is
// the "recovery-path report" the reroute is supposed to produce.
//
// SUPERSEDED (SECOND TIME) by B-NOSTOP-GATES WS-1: this exact fixture (2/2 Done,
// earlier session commit, mux exit 3 done_without_commit_evidence) is the wedge
// from the PRD's own bug report (session 2026-07-25-38095284) — an all-terminal
// roster is the healthiest possible state, so it no longer reaches
// `reportPhaseIncomplete`'s stamp path at all (the skip gate fires first).
// OLD (pre-WS-1): pickle halts, stamps `pipeline_phase_incomplete`, names the
// prior reason in the log — "not laundered" via the halt-reason-preservation
// mechanism.
// NEW (WS-1): pickle GRADUATES (no stamp — nothing was genuinely unfinished),
// advances to citadel, which then fails for an unrelated fixture reason (no
// `state.prd_path` wired). The "not laundered" guarantee still holds, but via a
// different mechanism now: pickle never touches `exit_reason` because it never
// halted, and `finalizeFailedPipeline` preserves an existing reason rather than
// overwriting it with the generic 'failed'.
test('AC-MWMO-D2-10 (superseded by B-NOSTOP-GATES WS-1): an all-terminal done_without_commit_evidence roster graduates, and the prior reason survives unlaundered', async () => {
  const repo = tmpDir('pipe-dwce-rr-repo-');
  const sessionDir = tmpDir('pipe-dwce-rr-session-');
  try {
    const startCommit = initRepo(repo);
    // An EARLIER ticket in this session already committed real work, so the
    // session-wide countCommitsSince(startCommit) heuristic is nonzero — the
    // exact shape that lets the specific reason get overwritten pre-fix.
    commitFollowup(repo, 'earlier_ticket_work');

    writeState(sessionDir, repo, startCommit, {
      exit_reason: 'done_without_commit_evidence',
    });
    writePipeline(sessionDir, repo, ['pickle', 'citadel']);
    writeTicket(sessionDir, 'aaa11111', 1, 'Done');
    writeTicket(sessionDir, 'bbb22222', 2, 'Done');

    // Post-WS-A2 mux mapping: done_without_commit_evidence exits 3, not 1.
    __setSpawnRunnerForTests(async () => {
      return { exitCode: PipelineRunnerExitCode.PhaseIncomplete, stdout: '', stderr: '' };
    });

    // WS-1: pickle graduates (all-terminal roster), citadel is reached and then
    // fails for an unrelated reason (no prd_path) — exit 1, not 3.
    await captureMainExit(sessionDir, PipelineRunnerExitCode.Failure);

    const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.match(
      log,
      /all 2 ticket\(s\) accounted for \(Done or oracle-committed\/terminal\) — no phase-incomplete stamp/,
      'an all-terminal roster must skip the phase-incomplete stamp entirely',
    );
    assert.match(
      log,
      /PHASE 2\/2: CITADEL/,
      'pickle must graduate and reach citadel instead of halting on an all-terminal roster',
    );

    const finalState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(
      finalState.exit_reason,
      'done_without_commit_evidence',
      'AC-MWMO-D2-10: the prior reason must survive unlaundered — pickle never touches it (it ' +
      'never halted) and finalizeFailedPipeline preserves an existing reason rather than ' +
      'overwriting it with the generic "failed"',
    );
    assert.notEqual(finalState.exit_reason, 'failed', 'the generic label is what this AC forbids');
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

describe('AC-MWMO-D2-11: getFatalPickleHaltReason reports the recorded reason, not an inferred one', () => {
  function scpinRuntime(dir) {
    return {
      sessionDir: dir,
      statePath: path.join(dir, 'state.json'),
      repoRoot: dir,
      workingDir: dir,
      extensionRoot: dir,
      backend: 'claude',
      phaseEnv: { ...process.env },
      designSafe: false,
      log: () => {},
      config: {
        phases: ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce'],
        target: dir,
        child_mux_runner_heartbeat_ms: 1000,
        child_mux_runner_stall_seconds: 60,
        anatomy_stall_limit: 3,
        szechuan_stall_limit: 5,
        anatomy_max_iterations: 100,
        szechuan_max_iterations: 50,
        citadel_strict: false,
        dirty_exempt_segments: [],
      },
    };
  }

  function writeMinimalState(statePath, startCommit, overrides = {}) {
    const dir = path.dirname(statePath);
    fs.writeFileSync(statePath, JSON.stringify({
      active: true,
      working_dir: dir,
      step: 'pickle',
      iteration: 1,
      max_iterations: 50,
      max_time_minutes: 720,
      worker_timeout_seconds: 1200,
      start_time_epoch: 1000,
      start_commit: startCommit,
      completion_promise: null,
      original_prompt: 'AC-MWMO-D2-11 test',
      current_ticket: null,
      history: [],
      started_at: new Date().toISOString(),
      session_dir: dir,
      schema_version: 3,
      exit_reason: null,
      prd_path: 'prd.md',
      backend: 'claude',
      activity: [],
      ...overrides,
    }, null, 2));
  }

  test('commitCount > 0: names the recorded exit_reason, never claims "strict phase policy"', () => {
    const dir = tmpDir('pipe-dwce-rr-unit-');
    try {
      const startCommit = initRepo(dir);
      // Real progress landed after the baseline was captured — this is the
      // countCommitsSince > 0 case that pre-fix always blamed on
      // "a reason other than build progress (e.g. strict phase policy)".
      commitFollowup(dir, 'progress');

      writeMinimalState(path.join(dir, 'state.json'), startCommit, {
        exit_reason: 'done_without_commit_evidence',
      });
      const runtime = scpinRuntime(dir);

      const logged = [];
      logPhaseHaltReason(runtime, 'pickle', 1, (msg) => logged.push(msg));
      const combined = logged.join('\n');

      assert.doesNotMatch(
        combined,
        /strict phase policy/,
        'AC-MWMO-D2-11: must NOT blame a done_without_commit_evidence halt on strict phase policy',
      );
      assert.match(
        combined,
        /done_without_commit_evidence/,
        'AC-MWMO-D2-11: must name the recorded exit_reason instead of inferring one from the commit count',
      );
      assert.match(
        combined,
        /commit\(s\) since baseline/,
        'must still report the true commit count',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no regression: commitCount === 0 message is unchanged', () => {
    const dir = tmpDir('pipe-dwce-rr-unit-zero-');
    try {
      const startCommit = initRepo(dir);
      // No commits landed after the baseline — commitCount === 0 branch.
      writeMinimalState(path.join(dir, 'state.json'), startCommit, {
        exit_reason: 'done_without_commit_evidence',
      });
      const runtime = scpinRuntime(dir);

      const logged = [];
      logPhaseHaltReason(runtime, 'pickle', 1, (msg) => logged.push(msg));
      const combined = logged.join('\n');

      assert.match(
        combined,
        /zero commits since baseline .* — no build progress this run/,
        'the commitCount === 0 message must be unchanged',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

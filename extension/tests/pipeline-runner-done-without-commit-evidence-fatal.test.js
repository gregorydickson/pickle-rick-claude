// @tier: fast
/**
 * B-GTRUTH WS-A2 — INVERTED from AC-MWMO-D2-8/D2-9's always-fatal framing.
 *
 * WHAT CHANGED AND WHY THE FIXTURE CHANGED WITH IT:
 * `done_without_commit_evidence` is a TICKET-scoped condition ("this ticket produced
 * no attributable commit"). Treating it as phase-FATAL killed the whole pipeline over
 * one ticket, and it was wrong 2/2 in the measured record (10/10 red-gate tickets
 * ended Done anyway). It is now demoted in lockstep across `isHaltExit`,
 * `FAILURE_EXIT_REASONS` (mux-runner.ts) and `isFatalPhaseFailure` (pipeline-runner.ts),
 * and routed into the EXISTING PhaseIncomplete contract via exit code 3.
 *
 * So the fixture's mux exit code moves 1 -> 3. That is NOT a test weakened to fit the
 * code: the fixture's job is to model what the real mux-runner returns, and this
 * bundle changes that mapping (see `mux-runner-done-without-commit-evidence-exit.test.js`,
 * which reads the mapping out of source rather than restating it).
 *
 * WHAT DID NOT CHANGE — the AC-MWMO-D2-8/D2-9 guarantee is preserved, by a better
 * mechanism. The all-terminal shape (every ticket Done, an EARLIER ticket committed so
 * session-wide countCommitsSince > 0, the LAST ticket commit-less) must still NOT
 * fake-green: no "Phase pickle completed successfully", citadel never entered, zero
 * completed phases. Previously that rested on the session-wide commit count; it now
 * rests on `reportPhaseIncomplete`, which consults the completion oracle per ticket.
 * The operator-visible outcome is asserted, not the boolean.
 *
 * SUPERSEDED (SECOND TIME) by B-NOSTOP-GATES WS-1: the "AC-MWMO-D2-8/D2-9
 * guarantee" above — that an all-terminal bundle with a commit-less final
 * ticket must halt pickle as INCOMPLETE, never reach citadel — is exactly the
 * bug this campaign fixes. Session 2026-07-25-38095284 hit precisely this
 * shape (6/6 Done, mux exit 3 done_without_commit_evidence) and it stamped
 * pipeline_phase_incomplete and broke 0/4 phases; citadel never ran. An
 * all-terminal roster is the healthiest possible state — halting on it is the
 * bug, not the guarantee.
 * OLD (pre-WS-1): pickle halts, citadel never entered, exit stays 3.
 * NEW (WS-1): pickle reports honestly (or, when nothing is genuinely
 * unfinished, doesn't stamp at all) and GRADUATES — citadel is reached. In
 * this fixture citadel then fails for an unrelated reason (no state.prd_path
 * wired), so the overall session exits 1 (citadel's own genuine failure), not
 * because pickle halted.
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

test('AC-MWMO-D2-8/D2-9 (superseded by B-NOSTOP-GATES WS-1): all-terminal bundle with a commit-less final ticket GRADUATES — citadel is reached, even with earlier session commits', async () => {
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

    // Mirrors the real mux-runner mapping AFTER WS-A2: done_without_commit_evidence is
    // no longer a FAILURE_EXIT_REASONS member and maps to exit code 3
    // (PipelineRunnerExitCode.PhaseIncomplete), joining 'iteration_cap_exhausted'.
    __setSpawnRunnerForTests(async () => {
      return { exitCode: PipelineRunnerExitCode.PhaseIncomplete, stdout: '', stderr: '' };
    });

    // WS-1: citadel is REACHED (pickle graduates instead of halting), then fails
    // for an unrelated fixture reason (no state.prd_path wired) — exit 1 is
    // citadel's own genuine failure, not a pickle halt.
    await captureMainExit(sessionDir, PipelineRunnerExitCode.Failure);

    const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');

    // Operator-visible outcome #1 (WS-1, inverted): pickle DOES report success and
    // advance — the roster is all-terminal, so there is nothing to report incomplete.
    assert.match(
      log,
      /all 2 ticket\(s\) accounted for.*no phase-incomplete stamp/,
      'an all-terminal roster (Done or oracle-committed/terminal) must skip the ' +
      'phase-incomplete stamp entirely',
    );
    assert.match(
      log,
      /Phase pickle completed successfully/,
      'AC-MWMO-D2-8 (WS-1): an all-terminal bundle must GRADUATE — halting the healthiest ' +
      'possible roster state was the bug this campaign fixes',
    );

    // Operator-visible outcome #2 (WS-1, inverted): citadel IS reached.
    assert.match(
      log,
      /PHASE 2\/2: CITADEL/,
      'AC-MWMO-D2-9 (WS-1): citadel must be reached when pickle graduates an all-terminal roster',
    );

    // The pipeline still correctly reports the citadel-originated failure (an
    // unrelated fixture gap, not a pickle halt) — it is not falsely "completed".
    const status = JSON.parse(fs.readFileSync(path.join(sessionDir, 'pipeline-status.json'), 'utf-8'));
    assert.notEqual(status.status, 'completed', 'citadel\'s own failure must still be reported honestly');
    assert.equal(status.completed_phases, 1, 'pickle counts as completed; citadel does not');

    // The prior mux exit_reason is neither stamped over by pickle (it never halted)
    // nor laundered into the generic 'failed' by finalizeFailedPipeline (which
    // preserves an existing reason rather than overwriting it).
    const finalState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(
      finalState.exit_reason,
      'done_without_commit_evidence',
      'pickle must not stamp pipeline_phase_incomplete over a roster with nothing genuinely ' +
      'unfinished, and the prior reason must survive citadel\'s unrelated failure unlaundered',
    );
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// Fast unit-level companions. On their own these prove nothing about the
// operator-visible advance (the test above is the real gate) — they are cheap,
// targeted pins on the classifier booleans that WS-A2 demotes, plus the two arms it
// must NOT touch.

function fatalRuntime(sessionDir, repo) {
  return {
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
}

function withFatalFixture(fn, { commitFollowupWork = true, stateOverrides = {} } = {}) {
  const repo = tmpDir('pipe-dwce-unit-repo-');
  const sessionDir = tmpDir('pipe-dwce-unit-session-');
  try {
    const startCommit = initRepo(repo);
    if (commitFollowupWork) commitFollowup(repo, 'earlier_ticket_work');
    writeState(sessionDir, repo, startCommit, stateOverrides);
    return fn(fatalRuntime(sessionDir, repo));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
}

test('AC-GTRUTH-A2-4: done_without_commit_evidence is NO LONGER fatal on its own when commits landed', () => {
  withFatalFixture((runtime) => {
    assert.equal(
      isFatalPhaseFailure('pickle', runtime),
      false,
      'WS-A2 demotes done_without_commit_evidence out of the fatal set. It is a ticket-scoped ' +
      'condition and is now routed through the PhaseIncomplete contract (exit code 3) instead ' +
      'of aborting the pipeline. MUST fail on pre-fix source, where :2801 returned true.',
    );
  }, { stateOverrides: { exit_reason: 'done_without_commit_evidence' } });
});

test('AC-GTRUTH-A2-5: the !startCommit guard is untouched — still fatal', () => {
  withFatalFixture((runtime) => {
    assert.equal(
      isFatalPhaseFailure('pickle', runtime),
      true,
      'a session with no recorded baseline cannot be measured at all — that arm stays fatal ' +
      'and WS-A2 must not have widened the demotion into it',
    );
  }, { stateOverrides: { start_commit: '', exit_reason: 'done_without_commit_evidence' } });
});

// SUPERSEDED by B-NOSTOP-GATES WS-1: the "bounded demotion" framing here was
// itself one of the five stacked refinements the campaign subtracts. Zero
// commits since baseline is a QUALITY signal (reported via
// maybeStampPhaseGraduation's phase_no_progress branch, which now advances
// instead of halting), not a crash-floor cannot-continue condition.
// OLD (pre-WS-1): isFatalPhaseFailure('pickle', ...) === true for zero commits
// — "the demotion is bounded, not universal."
// NEW (WS-1): isFatalPhaseFailure('pickle', ...) === false for zero commits —
// the demotion IS now universal for pickle, bounded only by the `!startCommit`
// arm (still fatal, per the sibling AC-GTRUTH-A2-5 test above).
test('AC-GTRUTH-A2-7 (superseded): zero commits since baseline is NO LONGER fatal for pickle', () => {
  withFatalFixture((runtime) => {
    assert.equal(
      isFatalPhaseFailure('pickle', runtime),
      false,
      'B-NOSTOP-GATES WS-1 neutralizes the countCommitsSince===0 arm — a run with zero commits ' +
      'reports incomplete and advances instead of halting fatally.',
    );
  }, { commitFollowupWork: false, stateOverrides: { exit_reason: 'done_without_commit_evidence' } });
});

test('AC-GTRUTH-A2-7: a non-pickle, non-microverse phase failure is STILL fatal', () => {
  withFatalFixture((runtime) => {
    assert.equal(
      isFatalPhaseFailure('citadel', runtime),
      true,
      'the default arm is unchanged — the demotion is scoped to the pickle phase\'s ' +
      'done_without_commit_evidence reason',
    );
  }, { stateOverrides: { exit_reason: 'done_without_commit_evidence' } });
});

// ---------------------------------------------------------------------------
// AC-GTRUTH-A2-1 / A2-2 — what the PhaseIncomplete contract does with the roster.
//
// These are the two shapes the reroute has to tell apart, and they are the reason the
// reroute targets `reportPhaseIncomplete` rather than a blanket halt: that function
// re-resolves every status-unfinished ticket through the completion oracle, so
// "committed but not flipped" and "genuinely still in flight" get different outcomes.
// ---------------------------------------------------------------------------

/** Commits real work carrying a Pickle-Ticket trailer, so the oracle's git-log scan attributes it. */
function commitForTicket(dir, ticketId) {
  fs.writeFileSync(path.join(dir, `${ticketId}.ts`), `export const t = '${ticketId}';\n`);
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'shipped work', '--trailer', `Pickle-Ticket: ${ticketId}`], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

test('AC-GTRUTH-A2-1: committed-but-unflipped + roster-terminal → NO phase-incomplete stamp, pipeline ADVANCES', async () => {
  const repo = tmpDir('pipe-a21-repo-');
  const sessionDir = tmpDir('pipe-a21-session-');
  try {
    const startCommit = initRepo(repo);
    writeState(sessionDir, repo, startCommit, { exit_reason: 'done_without_commit_evidence' });
    // Pickle-only: citadel needs a state.prd_path this fixture deliberately does not
    // supply, so including it would fail the phase for an unrelated reason and mask
    // whether pickle itself graduated.
    writePipeline(sessionDir, repo, ['pickle']);

    writeTicket(sessionDir, 'aaa11111', 1, 'Done');
    // Status-unfinished (not Done) but roster-TERMINAL and its work is in git: the
    // self-build shape. `statusUnfinished > 0 && unfinished.length === 0`.
    writeTicket(sessionDir, 'bbb22222', 2, 'Skipped');
    commitForTicket(repo, 'bbb22222');

    __setSpawnRunnerForTests(async () => {
      return { exitCode: PipelineRunnerExitCode.PhaseIncomplete, stdout: '', stderr: '' };
    });

    await captureMainExit(sessionDir, PipelineRunnerExitCode.Success);

    const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.match(
      log,
      /all 2 ticket\(s\) accounted for \(Done or oracle-committed\/terminal\) — no phase-incomplete stamp/,
      'the oracle re-resolution must recognize the committed-but-unflipped ticket',
    );
    assert.match(
      log,
      /Phase pickle completed successfully/,
      'pickle must GRADUATE: on pre-fix source the exit-3 branch broke unconditionally, so this ' +
      'line was unreachable and the pipeline halted on a proxy rather than on truth',
    );

    const finalState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.notEqual(
      finalState.exit_reason,
      'pipeline_phase_incomplete',
      'no phase-incomplete stamp may be recorded when nothing is genuinely unfinished',
    );

    const status = JSON.parse(fs.readFileSync(path.join(sessionDir, 'pipeline-status.json'), 'utf-8'));
    assert.equal(status.completed_phases, 1, 'the pickle phase must be recorded complete');
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-GTRUTH-A2-2: a genuinely in-flight ticket → no advance, pipeline_phase_incomplete, frontmatter statuses UNCHANGED', async () => {
  const repo = tmpDir('pipe-a22-repo-');
  const sessionDir = tmpDir('pipe-a22-session-');
  try {
    const startCommit = initRepo(repo);
    writeState(sessionDir, repo, startCommit, { exit_reason: 'done_without_commit_evidence' });
    writePipeline(sessionDir, repo, ['pickle', 'citadel']);

    // The loanlight shape, scaled down: earlier tickets shipped, one is still in
    // flight with NO commit of its own, and others are not all terminal.
    writeTicket(sessionDir, 'aaa11111', 1, 'Done');
    commitForTicket(repo, 'aaa11111');
    writeTicket(sessionDir, 'ccc33333', 3, 'In Progress');
    writeTicket(sessionDir, 'ddd44444', 4, 'Todo');

    let calls = 0;
    __setSpawnRunnerForTests(async () => {
      calls += 1;
      return { exitCode: calls === 1 ? PipelineRunnerExitCode.PhaseIncomplete : 0, stdout: '', stderr: '' };
    });

    await captureMainExit(sessionDir, PipelineRunnerExitCode.PhaseIncomplete);

    assert.equal(calls, 1, 'the pipeline must NOT advance to citadel while real work is in flight');

    const finalState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(finalState.exit_reason, 'pipeline_phase_incomplete');

    const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.match(log, /tickets remain unfinished/, 'the unfinished roster must be reported to the operator');

    // The whole point of routing to PhaseIncomplete instead of a failure: the pending
    // tickets stay RUNNABLE. A flip to Failed/Skipped here would discard real work and
    // make the session unrecoverable without an operator edit.
    for (const [id, expected] of [['ccc33333', 'In Progress'], ['ddd44444', 'Todo']]) {
      const body = fs.readFileSync(path.join(sessionDir, id, `rick_ticket_${id}.md`), 'utf-8');
      assert.match(
        body,
        new RegExp(`^status: ${expected}$`, 'm'),
        `ticket ${id} must keep status "${expected}" — the reroute must never terminalize in-flight work`,
      );
    }
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-GTRUTH-A2-6: pipeline_continue_on_phase_fail is not modified by this bundle', () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'bin', 'pipeline-runner.ts'), 'utf-8',
  );
  assert.match(
    src,
    /runnerState\.pipeline_continue_on_phase_fail === false\) return true;/,
    'the strict-phase tightening switch must remain exactly as shipped — WS-A2 demotes one ' +
    'exit reason, it does not touch the operator\'s opt-in halt policy',
  );
});

// non-vacuity note (do NOT pin this as a test case): a countCommitsSince>0 +
// tickets-STILL-PENDING scenario would already halt via
// maybeStampPhaseGraduation's `pendingCount === 0` graduation gate before
// isFatalPhaseFailure's return value can matter — that case passes identically
// pre-fix and post-fix, so pinning it here would prove nothing about this fix.
// The all-terminal case above is the only scenario where WS-2 changes the
// operator-visible outcome.

// @tier: fast
/**
 * R-PIPE-2 / AC-PIPE-02 — pipeline-runner refuses to claim
 * `Phase pickle completed successfully` when the mux-runner stub exits clean
 * (code 0) with 0 Done tickets AND 0 commits since `state.start_commit`.
 * Stamps `state.exit_reason = 'phase_no_progress'` and exits with
 * PipelineRunnerExitCode.PhaseIncomplete (3) so auto-resume.sh can retry-loop.
 *
 * Reverse case: when at least one ticket is marked Done OR at least one
 * commit lands since `state.start_commit`, the pickle phase passes through
 * the existing success path (`state.exit_reason = 'completed'`, exit 0).
 *
 * Closes Bug #48 R-PCFG from `prds/BUG-REPORT-2026-05-18-pipeline-launch-friction.md`
 * (operator session 2026-05-18-6108815e, 13-tickets-unimplemented "green" pipeline).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  __setSpawnRunnerForTests,
  __setCloserReleaseActionsForTests,
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
    original_prompt: 'phase_no_progress test',
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
    `---\nid: ${id}\ntitle: phase_no_progress ticket ${id}\nstatus: ${status}\norder: ${order}\n---\n\n# Test\n`,
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

test('R-PIPE-2: pickle phase clean-exit with 0 Done + 0 commits stamps phase_no_progress', async () => {
  const repo = tmpDir('pipe-pnp-repo-');
  const sessionDir = tmpDir('pipe-pnp-session-');
  try {
    const startCommit = initRepo(repo);
    writeState(sessionDir, repo, startCommit);
    writePipeline(sessionDir, repo, ['pickle']);

    // 3 Todo tickets — none Done
    writeTicket(sessionDir, 'aaa11111', 1, 'Todo');
    writeTicket(sessionDir, 'bbb22222', 2, 'Todo');
    writeTicket(sessionDir, 'ccc33333', 3, 'Todo');

    // Stub: mux-runner exits clean (code 0) without marking any ticket Done.
    // No commits made in repo. This is the exact hallucinated-completion
    // pattern observed in B-SJET-2 attempts 2026-05-18 PM.
    __setSpawnRunnerForTests(async () => {
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await captureMainExit(sessionDir, PipelineRunnerExitCode.PhaseIncomplete);

    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(
      state.exit_reason,
      'phase_no_progress',
      'pipeline-runner must stamp phase_no_progress when pickle exits clean with 0 Done + 0 commits',
    );

    const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.ok(
      /no progress \(0 Done of 3 tickets, 0 commits/.test(log),
      `log must describe the no-progress condition; got:\n${log.split('\n').slice(-10).join('\n')}`,
    );
    assert.ok(
      !/Phase pickle completed successfully/.test(log),
      'log must NOT claim "Phase pickle completed successfully" when no progress was made',
    );

    // All 3 tickets must still be Todo
    for (const id of ['aaa11111', 'bbb22222', 'ccc33333']) {
      const ticketFile = path.join(sessionDir, id, `rick_ticket_${id}.md`);
      const content = fs.readFileSync(ticketFile, 'utf-8');
      assert.ok(content.includes('status: Todo'), `ticket ${id} must remain Todo`);
    }
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-PIPE-2: pickle phase passes when all tickets are Done', async () => {
  const repo = tmpDir('pipe-pnp-done-repo-');
  const sessionDir = tmpDir('pipe-pnp-done-session-');
  try {
    const startCommit = initRepo(repo);
    writeState(sessionDir, repo, startCommit);
    writePipeline(sessionDir, repo, ['pickle']);

    // All tickets Done — bundle fully resolved.
    writeTicket(sessionDir, 'aaa11111', 1, 'Done');
    writeTicket(sessionDir, 'bbb22222', 2, 'Done');

    __setSpawnRunnerForTests(async () => {
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    // Pipeline succeeds → process.exit(0)
    await captureMainExit(sessionDir, PipelineRunnerExitCode.Success);

    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(
      state.exit_reason,
      'completed',
      'pipeline-runner must stamp completed when at least one ticket is Done',
    );

    const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.ok(
      /Phase pickle completed successfully/.test(log),
      'log must claim Phase pickle completed successfully when progress happened',
    );
    assert.ok(
      !/no progress/.test(log),
      'log must NOT describe no-progress condition when a ticket is Done',
    );
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-PIPE-2: pickle phase passes when commits landed since start_commit (no Done tickets)', async () => {
  const repo = tmpDir('pipe-pnp-commits-repo-');
  const sessionDir = tmpDir('pipe-pnp-commits-session-');
  try {
    const startCommit = initRepo(repo);
    writeState(sessionDir, repo, startCommit);
    writePipeline(sessionDir, repo, ['pickle']);

    // No Done tickets; ticket Skipped (terminal, not pending) + worker committed.
    // commitCount>0 keeps phase_no_progress from firing (R-PIPE-2); Skipped
    // keeps pendingCount=0 so phase_incomplete_tickets also doesn't fire.
    writeTicket(sessionDir, 'aaa11111', 1, 'Skipped');

    __setSpawnRunnerForTests(async () => {
      // Simulate a worker landing a real commit during the pickle phase.
      fs.writeFileSync(path.join(repo, 'worker.ts'), 'export const y = 2;\n');
      git(['add', '.'], repo);
      git(['commit', '-q', '-m', 'worker change'], repo);
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await captureMainExit(sessionDir, PipelineRunnerExitCode.Success);

    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(
      state.exit_reason,
      'completed',
      'pipeline-runner must stamp completed when a commit landed even if 0 Done',
    );

    const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.ok(
      /Phase pickle completed successfully/.test(log),
      'log must claim success when a commit landed since start_commit',
    );
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-A1 (WS-A): pickle with N-of-M Done + progress but pending halts pipeline_phase_incomplete', async () => {
  // AC-A1/WS-A all-terminal gate: even when the pickle pass made ≥1 Done ticket or
  // ≥1 commit, a clean exit-0 with pendingCount > 0 must stamp pipeline_phase_incomplete
  // and NOT advance the pipeline phase. The R-CMWL-2 progress carve-out applies only to
  // the mux codex-relaunch loop, never to pipeline-phase advance (B-XSPA / #113 R-XSPA-2).
  const repo = tmpDir('pipe-pppa-repo-');
  const sessionDir = tmpDir('pipe-pppa-session-');
  try {
    const startCommit = initRepo(repo);
    writeState(sessionDir, repo, startCommit);
    writePipeline(sessionDir, repo, ['pickle']);

    // 2 of 5 Done, 3 still Todo + a commit landed. Progress was made.
    writeTicket(sessionDir, 'aaa11111', 1, 'Done');
    writeTicket(sessionDir, 'bbb22222', 2, 'Done');
    writeTicket(sessionDir, 'ccc33333', 3, 'Todo');
    writeTicket(sessionDir, 'ddd44444', 4, 'Todo');
    writeTicket(sessionDir, 'eee55555', 5, 'In Progress');

    __setSpawnRunnerForTests(async () => {
      fs.writeFileSync(path.join(repo, 'partial.ts'), 'export const z = 3;\n');
      git(['add', '.'], repo);
      git(['commit', '-q', '-m', 'partial work'], repo);
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    // AC-A1 (WS-A) supersedes the R-CMWL-2 phase-advance carve-out for PIPELINE phase
    // advance: a clean pickle exit-0 with pendingCount > 0 must NOT advance REGARDLESS
    // of progress — advancing a partially-Done bundle to citadel/anatomy-park is the
    // B-XSPA / #113 R-XSPA-2 defect. maybeStampPicklePendingTickets stamps the uniform
    // pipeline_phase_incomplete reason and exits PhaseIncomplete (3) without advancing.
    await captureMainExit(sessionDir, PipelineRunnerExitCode.PhaseIncomplete);

    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(
      state.exit_reason,
      'pipeline_phase_incomplete',
      'AC-A1: pickle exit-0 with pending must stamp pipeline_phase_incomplete regardless of progress',
    );

    const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.ok(
      /not all-tickets-terminal, marking phase incomplete \(not advancing\)/.test(log),
      'AC-A1: progressing-but-pending pickle must log the all-terminal-gate incomplete line',
    );
    assert.ok(
      !/Phase pickle completed successfully/.test(log),
      'AC-A1: a partially-Done pickle must NOT log "completed successfully"',
    );
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-PPPA: pickle phase with Done + Skipped tickets and no pending advances normally', async () => {
  const repo = tmpDir('pipe-pppa-ok-repo-');
  const sessionDir = tmpDir('pipe-pppa-ok-session-');
  try {
    const startCommit = initRepo(repo);
    writeState(sessionDir, repo, startCommit);
    writePipeline(sessionDir, repo, ['pickle']);

    // Done + Skipped = all terminal, zero pending — a legitimately complete bundle.
    writeTicket(sessionDir, 'aaa11111', 1, 'Done');
    writeTicket(sessionDir, 'bbb22222', 2, 'Skipped');

    __setSpawnRunnerForTests(async () => {
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await captureMainExit(sessionDir, PipelineRunnerExitCode.Success);

    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(state.exit_reason, 'completed', 'Done + Skipped with no pending must advance');

    const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.ok(
      !/tickets remain unresolved/.test(log),
      'Skipped tickets must not count as unresolved',
    );
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-PRH: a manager_handoff_pending phase exit is preserved, not folded into failed', async () => {
  const repo = tmpDir('pipe-prh-repo-');
  const sessionDir = tmpDir('pipe-prh-session-');
  try {
    const startCommit = initRepo(repo);
    writeState(sessionDir, repo, startCommit);
    writePipeline(sessionDir, repo, ['pickle', 'citadel']);
    writeTicket(sessionDir, 'aaa11111', 1, 'Done');
    writeTicket(sessionDir, 'bbb22222', 2, 'Todo');

    // mux-runner exits clean (code 0) but stamps a manager_handoff_pending
    // exit_reason — the worker shipped and the manager must finish the handoff.
    const statePath = path.join(sessionDir, 'state.json');
    __setSpawnRunnerForTests(async () => {
      const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      s.exit_reason = 'manager_handoff_pending';
      fs.writeFileSync(statePath, JSON.stringify(s, null, 2));
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await captureMainExit(sessionDir, PipelineRunnerExitCode.Success);

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(
      state.exit_reason,
      'manager_handoff_pending',
      'pipeline-runner must preserve the handoff exit_reason, not overwrite it with failed',
    );

    const ps = JSON.parse(fs.readFileSync(path.join(sessionDir, 'pipeline-status.json'), 'utf-8'));
    assert.equal(ps.status, 'completed', 'handoff stop must write pipeline-status completed');

    const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.ok(
      /stopped for manager handoff/.test(log),
      `log must describe the handoff stop; got:\n${log.split('\n').slice(-10).join('\n')}`,
    );
    assert.ok(
      !/Phase pickle completed successfully/.test(log),
      'a handoff stop is not a phase success',
    );
    assert.ok(!/Phase citadel/.test(log), 'pipeline must not advance to citadel after a handoff');
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-CCR-10: manager_handoff_pending + unresolved tickets preserves handoff reason', async () => {
  const repo = tmpDir('pipe-ccr10-handoff-pending-repo-');
  const sessionDir = tmpDir('pipe-ccr10-handoff-pending-session-');
  try {
    const startCommit = initRepo(repo);
    writeState(sessionDir, repo, startCommit);
    writePipeline(sessionDir, repo, ['pickle']);

    // 1 Done + 2 Todo: phase exits clean with a handoff reason but unresolved tickets.
    // pipeline-runner must preserve the handoff reason instead of clobbering it with
    // phase_incomplete_tickets.
    writeTicket(sessionDir, 'aaa11111', 1, 'Done');
    writeTicket(sessionDir, 'bbb22222', 2, 'Todo');
    writeTicket(sessionDir, 'ccc33333', 3, 'Todo');

    // mux-runner exits clean (code 0) and stamps a handoff exit_reason.
    // maybeStampPhaseIncompleteTickets should NOT overwrite this with phase_incomplete_tickets.
    const statePath = path.join(sessionDir, 'state.json');
    __setSpawnRunnerForTests(async () => {
      const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      s.exit_reason = 'manager_handoff_pending';
      fs.writeFileSync(statePath, JSON.stringify(s, null, 2));
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await captureMainExit(sessionDir, PipelineRunnerExitCode.Success);

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(
      state.exit_reason,
      'manager_handoff_pending',
      'pipeline-runner must preserve manager_handoff_pending even with unresolved tickets',
    );

    const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.ok(
      /stopped for manager handoff/.test(log),
      `log must describe the handoff stop; got:\n${log.split('\n').slice(-10).join('\n')}`,
    );
    assert.ok(
      !/tickets remain unresolved/.test(log),
      'log must NOT describe incomplete-ticket condition when handoff is present',
    );
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-CCR-10: closer_handoff_terminal + unresolved tickets preserves handoff reason', async () => {
  const repo = tmpDir('pipe-ccr10-handoff-closer-repo-');
  const sessionDir = tmpDir('pipe-ccr10-handoff-closer-session-');
  try {
    const startCommit = initRepo(repo);
    writeState(sessionDir, repo, startCommit);
    writePipeline(sessionDir, repo, ['pickle']);

    // 1 Done + 2 Todo: phase exits clean with a closer_handoff_terminal reason but unresolved tickets.
    // Same test as manager_handoff_pending but covering the second handoff reason.
    writeTicket(sessionDir, 'aaa11111', 1, 'Done');
    writeTicket(sessionDir, 'bbb22222', 2, 'Todo');
    writeTicket(sessionDir, 'ccc33333', 3, 'Todo');

    const statePath = path.join(sessionDir, 'state.json');
    __setSpawnRunnerForTests(async () => {
      const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      s.exit_reason = 'closer_handoff_terminal';
      fs.writeFileSync(statePath, JSON.stringify(s, null, 2));
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await captureMainExit(sessionDir, PipelineRunnerExitCode.Success);

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(
      state.exit_reason,
      'closer_handoff_terminal',
      'pipeline-runner must preserve closer_handoff_terminal even with unresolved tickets',
    );

    const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.ok(
      /stopped for manager handoff/.test(log),
      `log must describe the handoff stop; got:\n${log.split('\n').slice(-10).join('\n')}`,
    );
    assert.ok(
      !/tickets remain unresolved/.test(log),
      'log must NOT describe incomplete-ticket condition when handoff is present',
    );
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-CCR-4: real failure (no handoff) still exits Failure with status failed', async () => {
  const repo = tmpDir('pipe-ccr4-fail-repo-');
  const sessionDir = tmpDir('pipe-ccr4-fail-session-');
  try {
    const startCommit = initRepo(repo);
    writeState(sessionDir, repo, startCommit);
    writePipeline(sessionDir, repo, ['pickle', 'citadel']);
    writeTicket(sessionDir, 'aaa11111', 1, 'Todo');

    // Phase runner exits non-zero with no handoff reason — genuine failure.
    __setSpawnRunnerForTests(async () => ({ exitCode: 1, stdout: '', stderr: '' }));

    await captureMainExit(sessionDir, PipelineRunnerExitCode.Failure);

    const pipelineStatus = JSON.parse(
      fs.readFileSync(path.join(sessionDir, 'pipeline-status.json'), 'utf-8'),
    );
    assert.equal(pipelineStatus.status, 'failed', 'real failure must write pipeline-status failed');
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-CCR-3: non-zero exit + stale manager_handoff_pending does NOT take clean-handoff break', async () => {
  const repo = tmpDir('pipe-ccr3-nonzero-repo-');
  const sessionDir = tmpDir('pipe-ccr3-nonzero-session-');
  try {
    const startCommit = initRepo(repo);
    writeState(sessionDir, repo, startCommit);
    writePipeline(sessionDir, repo, ['pickle', 'citadel']);
    writeTicket(sessionDir, 'aaa11111', 1, 'Todo');

    // Phase runner exits non-zero and leaves a stale manager_handoff_pending
    // in state — this simulates the cross-phase leak scenario.
    const statePath = path.join(sessionDir, 'state.json');
    __setSpawnRunnerForTests(async () => {
      const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      s.exit_reason = 'manager_handoff_pending';
      fs.writeFileSync(statePath, JSON.stringify(s, null, 2));
      return { exitCode: 1, stdout: '', stderr: '' };
    });

    await captureMainExit(sessionDir, PipelineRunnerExitCode.Failure);

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.notEqual(
      state.exit_reason,
      'manager_handoff_pending',
      'non-zero exit must NOT preserve a stale handoff exit_reason',
    );
    assert.ok(!/Phase citadel/.test(
      fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8'),
    ), 'pipeline must not advance to citadel on a failed phase');
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-CCR-3: non-zero exit with stale handoff reason terminates with failure marker, not step:completed+handoff', async () => {
  const repo = tmpDir('pipe-ccr3-twin-repo-');
  const sessionDir = tmpDir('pipe-ccr3-twin-session-');
  try {
    const startCommit = initRepo(repo);
    writeState(sessionDir, repo, startCommit);
    writePipeline(sessionDir, repo, ['pickle']);
    writeTicket(sessionDir, 'aaa11111', 1, 'Todo');

    // Phase runner exits non-zero and stamps closer_handoff_terminal — the
    // twin-read leak scenario: finalizePipeline must NOT see this and produce
    // step:'completed' instead of a failure marker.
    const statePath = path.join(sessionDir, 'state.json');
    __setSpawnRunnerForTests(async () => {
      const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      s.exit_reason = 'closer_handoff_terminal';
      fs.writeFileSync(statePath, JSON.stringify(s, null, 2));
      return { exitCode: 1, stdout: '', stderr: '' };
    });

    await captureMainExit(sessionDir, PipelineRunnerExitCode.Failure);

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    // AC-CCR-3-4 positive contract: a non-zero phase exit carrying a stale
    // handoff reason MUST terminate with the 'failed' failure marker. The
    // earlier `notEqual` alone also passed for null / 'completed' / any other
    // non-handoff value — it never proved the failure marker the AC and this
    // test name ("terminates with failure marker") promise.
    assert.equal(
      state.exit_reason,
      'failed',
      `non-zero phase exit must stamp exit_reason='failed' (the terminal failure `
        + `marker), not leave it null or a handoff reason; got ${JSON.stringify(state.exit_reason)}`,
    );
    // Retained alongside the positive check: documents the specific leak
    // closed — the stale closer_handoff_terminal reason must not survive into
    // finalizePipeline's readHandoffExitReason twin read.
    assert.notEqual(
      state.exit_reason,
      'closer_handoff_terminal',
      'stale handoff exit_reason must be cleared on non-zero exit (twin-read leak fix)',
    );
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-CCR-5: closer-release install/tag NOT invoked when pipeline stops on manager_handoff_pending', async () => {
  const repo = tmpDir('pipe-ccr5-mhp-repo-');
  const sessionDir = tmpDir('pipe-ccr5-mhp-session-');
  let installCalled = 0;
  let tagCalled = 0;
  __setCloserReleaseActionsForTests({ install: () => { installCalled++; }, tag: () => { tagCalled++; } });
  try {
    const startCommit = initRepo(repo);
    writeState(sessionDir, repo, startCommit);
    writePipeline(sessionDir, repo, ['pickle']);
    writeTicket(sessionDir, 'aaa11111', 1, 'Done');

    const statePath = path.join(sessionDir, 'state.json');
    __setSpawnRunnerForTests(async () => {
      const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      s.exit_reason = 'manager_handoff_pending';
      fs.writeFileSync(statePath, JSON.stringify(s, null, 2));
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await captureMainExit(sessionDir, PipelineRunnerExitCode.Success);

    assert.equal(installCalled, 0, 'install must NOT be called on manager_handoff_pending stop');
    assert.equal(tagCalled, 0, 'tag must NOT be called on manager_handoff_pending stop');
  } finally {
    __setSpawnRunnerForTests(null);
    __setCloserReleaseActionsForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-CCR-5: closer-release install/tag NOT invoked when pipeline stops on closer_handoff_terminal', async () => {
  const repo = tmpDir('pipe-ccr5-cht-repo-');
  const sessionDir = tmpDir('pipe-ccr5-cht-session-');
  let installCalled = 0;
  let tagCalled = 0;
  __setCloserReleaseActionsForTests({ install: () => { installCalled++; }, tag: () => { tagCalled++; } });
  try {
    const startCommit = initRepo(repo);
    writeState(sessionDir, repo, startCommit);
    writePipeline(sessionDir, repo, ['pickle']);
    writeTicket(sessionDir, 'aaa11111', 1, 'Done');

    const statePath = path.join(sessionDir, 'state.json');
    __setSpawnRunnerForTests(async () => {
      const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      s.exit_reason = 'closer_handoff_terminal';
      fs.writeFileSync(statePath, JSON.stringify(s, null, 2));
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await captureMainExit(sessionDir, PipelineRunnerExitCode.Success);

    assert.equal(installCalled, 0, 'install must NOT be called on closer_handoff_terminal stop');
    assert.equal(tagCalled, 0, 'tag must NOT be called on closer_handoff_terminal stop');
  } finally {
    __setSpawnRunnerForTests(null);
    __setCloserReleaseActionsForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-CCR-5: closer-release plan entered on clean non-handoff successful pipeline', async () => {
  const repo = tmpDir('pipe-ccr5-ok-repo-');
  const sessionDir = tmpDir('pipe-ccr5-ok-session-');
  let installCalled = 0;
  let tagCalled = 0;
  __setCloserReleaseActionsForTests({ install: () => { installCalled++; }, tag: () => { tagCalled++; } });
  try {
    const startCommit = initRepo(repo);
    writeState(sessionDir, repo, startCommit);
    writePipeline(sessionDir, repo, ['pickle']);
    writeTicket(sessionDir, 'aaa11111', 1, 'Done');
    writeTicket(sessionDir, 'bbb22222', 2, 'Done');

    __setSpawnRunnerForTests(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    await captureMainExit(sessionDir, PipelineRunnerExitCode.Success);

    assert.equal(installCalled, 1, 'install must be called on clean successful pipeline');
    assert.equal(tagCalled, 1, 'tag must be called on clean successful pipeline');
  } finally {
    __setSpawnRunnerForTests(null);
    __setCloserReleaseActionsForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R-CMWL-2: post-phase classifier — both branches
// ---------------------------------------------------------------------------

test('AC-A1 (WS-A): pickle with commits-only progress + pending halts pipeline_phase_incomplete', async () => {
  // doneCount=0, commitCount>0, pendingCount>0 — progress via commit only.
  // The R-CMWL-2 carve-out advances this in the mux relaunch loop, but the AC-A1
  // all-terminal gate (maybeStampPicklePendingTickets) overrides for PIPELINE phase
  // advance: pendingCount > 0 on a clean exit-0 → pipeline_phase_incomplete, exit 3.
  const repo = tmpDir('pipe-cmwl2-b1-repo-');
  const sessionDir = tmpDir('pipe-cmwl2-b1-session-');
  try {
    const startCommit = initRepo(repo);
    writeState(sessionDir, repo, startCommit);
    writePipeline(sessionDir, repo, ['pickle']);

    // All tickets still Todo — no Done yet, but a commit was made (real work happened).
    writeTicket(sessionDir, 'aaa11111', 1, 'Todo');
    writeTicket(sessionDir, 'bbb22222', 2, 'Todo');
    writeTicket(sessionDir, 'ccc33333', 3, 'Todo');

    __setSpawnRunnerForTests(async () => {
      // Simulate a worker landing a commit without marking any ticket Done yet.
      fs.writeFileSync(path.join(repo, 'wip.ts'), 'export const wip = 1;\n');
      git(['add', '.'], repo);
      git(['commit', '-q', '-m', 'wip: in-flight work'], repo);
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    // AC-A1: commitCount>0 progress does NOT advance the pipeline phase while pending.
    await captureMainExit(sessionDir, PipelineRunnerExitCode.PhaseIncomplete);

    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(
      state.exit_reason,
      'pipeline_phase_incomplete',
      'AC-A1: commits-only progress with pending must stamp pipeline_phase_incomplete',
    );

    const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.ok(
      /not all-tickets-terminal, marking phase incomplete \(not advancing\)/.test(log),
      'AC-A1: commits-only-but-pending pickle must log the all-terminal-gate incomplete line',
    );
    assert.ok(
      !/Phase pickle completed successfully/.test(log),
      'AC-A1: a pending pickle must NOT log "completed successfully"',
    );
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-CMWL-2 branch 2: pickle with zero progress + pending tickets stamps terminal reason', async () => {
  // doneCount=0, commitCount=0, pendingCount>0 — zero progress.
  // maybeStampPhaseNoProgress fires first → phase_no_progress (terminal).
  // Confirms the zero-progress branch remains fatal (no regression from R-CMWL-2).
  const repo = tmpDir('pipe-cmwl2-b2-repo-');
  const sessionDir = tmpDir('pipe-cmwl2-b2-session-');
  try {
    const startCommit = initRepo(repo);
    writeState(sessionDir, repo, startCommit);
    writePipeline(sessionDir, repo, ['pickle']);

    writeTicket(sessionDir, 'aaa11111', 1, 'Todo');
    writeTicket(sessionDir, 'bbb22222', 2, 'Todo');
    writeTicket(sessionDir, 'ccc33333', 3, 'Todo');

    // Stub exits 0 with no commits and no Done tickets — genuine zero progress.
    __setSpawnRunnerForTests(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    await captureMainExit(sessionDir, PipelineRunnerExitCode.PhaseIncomplete);

    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    // maybeStampPhaseNoProgress fires first for doneCount=0 + commitCount=0.
    assert.equal(
      state.exit_reason,
      'phase_no_progress',
      'R-CMWL-2 branch 2: zero progress must stamp a terminal reason (phase_no_progress)',
    );

    const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.ok(
      !/Phase pickle completed successfully/.test(log),
      'zero progress must NOT log "Phase pickle completed successfully"',
    );
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

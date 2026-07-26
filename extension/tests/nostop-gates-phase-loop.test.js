// @tier: fast
/**
 * B-NOSTOP-GATES WS-1 — AC-NSG-1.
 *
 * `describe.each`-style matrix over roster shapes x mux exit codes. Every row
 * exercises the FULL `main()` pipeline loop (never a private, unexported
 * function) with a real 2-phase pipeline (`['pickle', 'citadel']`) — citadel is
 * NOT stubbed: it self-heals a `state.prd_path` from a real (trivial) `prd.md`
 * seeded into the session dir and runs its own in-process audit-runner, so
 * "citadel is reached" is proven by an ACTUAL clean citadel pass, not a second
 * spawn-stub call. This keeps every row's overall exit code confined to {0, 3}
 * — a row where pickle advances is never masked by an unrelated citadel
 * failure (see the sibling `pipeline-runner-done-without-commit-evidence-*`
 * fixtures, which accept a missing-prd_path citadel failure and therefore
 * cannot make this "exit code never 1" pin).
 *
 * The terminal triple — banner title/color, parsed `pipeline-status.json`,
 * and the process exit code — is asserted TOGETHER per row from ONE
 * `captureMainExit` invocation. `bannerTitle`/`bannerColor` are derived from
 * `pipeline-status.json`'s `status` field rather than captured console text:
 * `buildPipelineTerminalBanner` (unexported) is a pure function of the same
 * `effectiveFailed` boolean that decides `status`, so deriving the banner from
 * the parsed JSON is equivalent to asserting the real banner without
 * depending on a console string. Advance-vs-halt ("action") is proven via
 * whether citadel's OWN log lines appear — a structural signal (did the
 * lifecycle reach and run the next phase), not a scenario-specific message.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { __setSpawnRunnerForTests, main } from '../bin/pipeline-runner.js';
import { PipelineRunnerExitCode } from '../types/index.js';

const TMP_DIRS = new Set();

class ExitIntercept extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_DIRS.add(dir);
  return dir;
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

/** Commits real work whose message names the ticket id, for oracle-attribution rows. */
function commitForTicket(dir, ticketId) {
  fs.writeFileSync(path.join(dir, `${ticketId}.ts`), `export const t = '${ticketId}';\n`);
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', `fix(${ticketId}): shipped work`], dir);
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
    original_prompt: 'nostop-gates phase-loop test',
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

function writePipeline(sessionDir, repo) {
  fs.writeFileSync(path.join(sessionDir, 'pipeline.json'), JSON.stringify({
    phases: ['pickle', 'citadel'],
    target: repo,
    anatomy_stall_limit: 3,
    szechuan_stall_limit: 5,
    anatomy_max_iterations: 100,
    szechuan_max_iterations: 50,
    citadel_strict: false,
    dirty_exempt_segments: ['prds', 'docs'],
  }, null, 2));
}

/** A trivial PRD — citadel self-heals state.prd_path by adopting this file. */
function writePrd(sessionDir) {
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Test PRD\n\n## Acceptance Criteria\n- [ ] n/a\n');
}

function writeTicket(sessionDir, id, order, status) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(
    path.join(ticketDir, `rick_ticket_${id}.md`),
    `---\nid: ${id}\ntitle: roster ticket ${id}\nstatus: ${status}\norder: ${order}\n---\n\n# Test\n`,
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
  for (const dir of TMP_DIRS) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  TMP_DIRS.clear();
});

/**
 * Runs one roster-shape x muxExit row through the full pipeline and returns the
 * terminal triple plus the structural advance signal. `expectedCode` is the
 * PROCESS exit code the row's disposition predicts (0 or 3 — never 1, per the
 * ONE RULE this ticket enforces).
 */
async function runRow({ tickets, muxExit, expectedCode, stateOverrides = {} }) {
  const repo = tmpDir('nsg-phase-loop-repo-');
  const sessionDir = tmpDir('nsg-phase-loop-session-');
  const startCommit = initRepo(repo);
  writeState(sessionDir, repo, startCommit, stateOverrides);
  writePipeline(sessionDir, repo);
  writePrd(sessionDir);
  for (const t of tickets) {
    writeTicket(sessionDir, t.id, t.order, t.status);
    if (t.commit) commitForTicket(repo, t.id);
  }

  __setSpawnRunnerForTests(async () => ({ exitCode: muxExit, stdout: '', stderr: '' }));

  await captureMainExit(sessionDir, expectedCode);

  const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
  const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
  const pipelineStatus = JSON.parse(fs.readFileSync(path.join(sessionDir, 'pipeline-status.json'), 'utf-8'));
  const bannerColor = pipelineStatus.status === 'completed' ? 'GREEN' : 'RED';
  const bannerTitle = pipelineStatus.status === 'completed' ? 'Pipeline Complete' : 'Pipeline Failed';
  const citadelReached = /PHASE 2\/2: CITADEL/.test(log) && /citadel completed successfully/.test(log);

  return {
    processExit: expectedCode,
    terminalReason: state.exit_reason ?? null,
    pipelineStatus,
    bannerColor,
    bannerTitle,
    citadelReached,
    log,
  };
}

describe('AC-NSG-1 — roster shape x mux exit code, the terminal triple', () => {
  test('6/6 Done (evidenced), muxExit=0: clean graduate, citadel reached, exit 0', async () => {
    const tickets = Array.from({ length: 6 }, (_, i) => ({
      id: `d${i}n${i}n${i}n`, order: i + 1, status: 'Done', commit: true,
    }));
    const r = await runRow({ tickets, muxExit: 0, expectedCode: PipelineRunnerExitCode.Success });

    assert.equal(r.bannerTitle, 'Pipeline Complete');
    assert.equal(r.bannerColor, 'GREEN');
    assert.equal(r.pipelineStatus.status, 'completed');
    assert.equal(r.pipelineStatus.completed_phases, 2);
    assert.notEqual(r.terminalReason, 'pipeline_phase_incomplete');
    assert.notEqual(r.terminalReason, 'phase_no_progress');
    assert.ok(r.citadelReached, 'citadel must be reached on a clean all-Done graduate');
  });

  test('6/6 Done (unevidenced — the field wedge), muxExit=3 done_without_commit_evidence: action !== break, citadel reached, exit 0', async () => {
    const tickets = Array.from({ length: 6 }, (_, i) => ({
      id: `d${i}w${i}w${i}w`, order: i + 1, status: 'Done',
    }));
    const r = await runRow({
      tickets,
      muxExit: PipelineRunnerExitCode.PhaseIncomplete,
      expectedCode: PipelineRunnerExitCode.Success,
      stateOverrides: { exit_reason: 'done_without_commit_evidence' },
    });

    // AC-NSG-1 field-wedge row: this is the exact shape from the PRD's own bug
    // report (session 2026-07-25-38095284) — an all-Done roster must not halt.
    assert.equal(r.bannerTitle, 'Pipeline Complete');
    assert.equal(r.bannerColor, 'GREEN');
    assert.equal(r.pipelineStatus.status, 'completed');
    assert.equal(r.pipelineStatus.completed_phases, 2);
    assert.notEqual(r.terminalReason, 'pipeline_phase_incomplete');
    assert.ok(r.citadelReached, 'AC-NSG-1 field-wedge row: citadel must be reached');
    assert.ok(
      /no genuinely-unfinished and no runnable ticket remaining — graduating/.test(r.log),
      'must reach resolvePhaseIncompleteOutcome\'s graduate branch, never break',
    );
  });

  test('0/6 Done, 0 commits, muxExit=0: anti-fake-green — reports incomplete AND advances', async () => {
    const tickets = Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}o${i}d${i}`, order: i + 1, status: 'Todo',
    }));
    const r = await runRow({ tickets, muxExit: 0, expectedCode: PipelineRunnerExitCode.PhaseIncomplete });

    assert.equal(r.bannerTitle, 'Pipeline Failed');
    assert.equal(r.bannerColor, 'RED');
    assert.notEqual(r.pipelineStatus.status, 'completed', 'must not report success — B-NONSTOP AC-NS-6 / AC-MWMO-D2-8');
    assert.equal(r.terminalReason, 'phase_no_progress');
    assert.ok(r.citadelReached, 'phase_no_progress must still ADVANCE the phase, not halt it');
  });

  test('3 Done / 3 Todo, muxExit=3: stops resumably — action=break, citadel NOT reached', async () => {
    const tickets = [
      ...Array.from({ length: 3 }, (_, i) => ({ id: `d${i}o${i}n${i}`, order: i + 1, status: 'Done', commit: true })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: `t${i}o${i}d${i}`, order: i + 4, status: 'Todo' })),
    ];
    const r = await runRow({
      tickets,
      muxExit: PipelineRunnerExitCode.PhaseIncomplete,
      expectedCode: PipelineRunnerExitCode.PhaseIncomplete,
      stateOverrides: { exit_reason: 'iteration_cap_exhausted' },
    });

    assert.equal(r.bannerTitle, 'Pipeline Failed');
    assert.equal(r.bannerColor, 'RED');
    assert.equal(r.pipelineStatus.completed_phases, 0);
    assert.equal(r.terminalReason, 'pipeline_phase_incomplete');
    assert.ok(!r.citadelReached, 'genuinely-unfinished tickets must stop the pipeline BEFORE citadel (B-PXBO / R-ICP-2 resumability)');
    assert.ok(/Unfinished tickets:/.test(r.log));
  });

  test('6/6 Failed, muxExit=0: phase_no_progress — reports and ADVANCES', async () => {
    const tickets = Array.from({ length: 6 }, (_, i) => ({
      id: `f${i}a${i}i${i}`, order: i + 1, status: 'Failed',
    }));
    const r = await runRow({ tickets, muxExit: 0, expectedCode: PipelineRunnerExitCode.PhaseIncomplete });

    assert.equal(r.terminalReason, 'phase_no_progress');
    assert.ok(r.citadelReached, 'an all-Failed, zero-progress roster still advances honestly');
  });

  test('6/6 Failed, muxExit=3: genuinely unfinished — cap hit, action=break', async () => {
    const tickets = Array.from({ length: 6 }, (_, i) => ({
      id: `f${i}b${i}c${i}`, order: i + 1, status: 'Failed',
    }));
    const r = await runRow({
      tickets,
      muxExit: PipelineRunnerExitCode.PhaseIncomplete,
      expectedCode: PipelineRunnerExitCode.PhaseIncomplete,
    });

    assert.equal(r.terminalReason, 'pipeline_phase_incomplete');
    assert.ok(!r.citadelReached, 'unresolved Failed tickets with no oracle attribution must stop before citadel');
  });

  test('5 Done + 1 In Progress, muxExit=0: partial progress — reports and ADVANCES', async () => {
    const tickets = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `d${i}p${i}p${i}`, order: i + 1, status: 'Done', commit: true })),
      { id: 'inprogress01', order: 6, status: 'In Progress' },
    ];
    const r = await runRow({ tickets, muxExit: 0, expectedCode: PipelineRunnerExitCode.PhaseIncomplete });

    assert.equal(r.terminalReason, 'pipeline_phase_incomplete');
    assert.ok(r.citadelReached, 'partial progress (>=1 Done) is a quality signal that advances, not a halt');
  });

  test('5 Done + 1 In Progress, muxExit=3: same roster — action=break at the cap', async () => {
    const tickets = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `d${i}q${i}q${i}`, order: i + 1, status: 'Done', commit: true })),
      { id: 'inprogress02', order: 6, status: 'In Progress' },
    ];
    const r = await runRow({
      tickets,
      muxExit: PipelineRunnerExitCode.PhaseIncomplete,
      expectedCode: PipelineRunnerExitCode.PhaseIncomplete,
    });

    assert.equal(r.terminalReason, 'pipeline_phase_incomplete');
    assert.ok(!r.citadelReached, 'a genuinely-unfinished In Progress ticket at the iteration cap must still stop before citadel');
  });

  test('Skipped-present (4 Done + 2 Skipped), muxExit=0: terminal via Skipped — clean graduate', async () => {
    const tickets = [
      ...Array.from({ length: 4 }, (_, i) => ({ id: `d${i}s${i}k${i}`, order: i + 1, status: 'Done', commit: true })),
      { id: 'skipped0001', order: 5, status: 'Skipped' },
      { id: 'skipped0002', order: 6, status: 'Skipped' },
    ];
    const r = await runRow({ tickets, muxExit: 0, expectedCode: PipelineRunnerExitCode.Success });

    assert.equal(r.pipelineStatus.status, 'completed');
    assert.notEqual(r.terminalReason, 'pipeline_phase_incomplete');
    assert.notEqual(r.terminalReason, 'phase_no_progress');
    assert.ok(r.citadelReached, 'Skipped is terminal (R-PPPA) — must not count as pending');
  });

  test('Skipped-present (4 Done + 2 Skipped), muxExit=3: terminal via Skipped — clean graduate', async () => {
    // NOTE: unlike collectPicklePhaseProgress's pendingCount (which treats Skipped
    // as terminal directly, R-PPPA), reportPhaseIncomplete's resolveUnfinishedTickets
    // filters ONLY status !== 'done' before oracle exclusion — a Skipped ticket is
    // "unfinished" there unless the oracle also attributes a commit to it. Give the
    // Skipped tickets a commit so they resolve oracle-committed/terminal too (the
    // same technique the pre-existing AC-GTRUTH-A2-1 fixture uses for its own
    // Skipped ticket).
    const tickets = [
      ...Array.from({ length: 4 }, (_, i) => ({ id: `d${i}t${i}r${i}`, order: i + 1, status: 'Done', commit: true })),
      { id: 'skipped0003', order: 5, status: 'Skipped', commit: true },
      { id: 'skipped0004', order: 6, status: 'Skipped', commit: true },
    ];
    const r = await runRow({
      tickets,
      muxExit: PipelineRunnerExitCode.PhaseIncomplete,
      expectedCode: PipelineRunnerExitCode.Success,
      stateOverrides: { exit_reason: 'done_without_commit_evidence' },
    });

    assert.equal(r.pipelineStatus.status, 'completed');
    assert.notEqual(r.terminalReason, 'pipeline_phase_incomplete');
    assert.ok(r.citadelReached, 'Skipped is terminal (R-PPPA) — must not count as pending, even at exit code 3');
  });

  test('empty roster, muxExit=0: ticketCount<=0 carve-out — clean graduate', async () => {
    const r = await runRow({ tickets: [], muxExit: 0, expectedCode: PipelineRunnerExitCode.Success });

    assert.equal(r.pipelineStatus.status, 'completed');
    assert.ok(r.citadelReached, 'a never-decomposed / dispatch-only phase must graduate');
  });

  test('empty roster, muxExit=3: legacy non-ticket fallthrough (UNCHANGED by this ticket) — action=break', async () => {
    const r = await runRow({
      tickets: [],
      muxExit: PipelineRunnerExitCode.PhaseIncomplete,
      expectedCode: PipelineRunnerExitCode.PhaseIncomplete,
    });

    // reportPhaseIncomplete's skip gate requires `total > 0` — an empty roster
    // never satisfies it, so this pre-existing fallthrough is untouched by WS-1.
    assert.equal(r.terminalReason, 'pipeline_phase_incomplete');
    assert.ok(!r.citadelReached, 'the legacy non-ticket exit-3 fallthrough still halts — out of this ticket\'s scope');
  });
});

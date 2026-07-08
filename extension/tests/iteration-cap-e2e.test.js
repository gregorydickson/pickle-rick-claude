// @tier: fast
/**
 * AC-ICP-06 — End-to-end: 5-Todo session, mux-runner hits cap=2 and exits
 * with code 3. Pipeline-runner halts, stamps pipeline_phase_incomplete, logs
 * the unfinished list, and no ticket escapes as a phantom Done.
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
  fs.writeFileSync(path.join(dir, 'app.ts'), 'export const app = 1;\n');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
}

function writeState(sessionDir, repo) {
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    active: false,
    working_dir: repo,
    step: 'implement',
    iteration: 0,
    max_iterations: 2,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 'e2e cap test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 3,
    tmux_mode: false,
    chain_meeseeks: false,
    backend: 'claude',
  }, null, 2));
}

function writePipeline(sessionDir, repo) {
  fs.writeFileSync(path.join(sessionDir, 'pipeline.json'), JSON.stringify({
    phases: ['pickle'],
    target: repo,
    anatomy_stall_limit: 3,
    szechuan_stall_limit: 5,
    anatomy_max_iterations: 100,
    szechuan_max_iterations: 50,
    dirty_exempt_segments: ['prds', 'docs'],
  }, null, 2));
}

function writeTicket(sessionDir, id, order) {
  const dir = path.join(sessionDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `rick_ticket_${id}.md`),
    `---\nid: ${id}\ntitle: E2E ticket ${id}\nstatus: Todo\norder: ${order}\n---\n\n# Body\n`,
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

test('iteration-cap-and-phantom-done-end-to-end', async () => {
  const repo = tmpDir('cap-e2e-repo-');
  const sessionDir = tmpDir('cap-e2e-session-');
  const TICKET_IDS = ['t1a2b3c4', 't2b3c4d5', 't3c4d5e6', 't4d5e6f7', 't5e6f7a8'];
  try {
    initRepo(repo);
    writeState(sessionDir, repo);
    writePipeline(sessionDir, repo);

    // 5 Todo tickets
    TICKET_IDS.forEach((id, i) => writeTicket(sessionDir, id, i + 1));

    // Stub simulates mux-runner hitting global cap=2 after 2 iterations:
    //   - records exit_reason = 'iteration_cap_exhausted' (R-ICP-1)
    //   - exits with code 3 (distinct from 0 and 1)
    __setSpawnRunnerForTests(async () => {
      const statePath = path.join(sessionDir, 'state.json');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      state.exit_reason = 'iteration_cap_exhausted';
      state.iteration = 2;
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      return { exitCode: 3, stdout: '', stderr: '' };
    });

    // Pipeline-runner must exit with code 3 (PhaseIncomplete)
    await captureMainExit(sessionDir, 3);

    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));

    // R-ICP-2: pipeline stamps pipeline_phase_incomplete (overwrites iteration_cap_exhausted)
    assert.equal(
      state.exit_reason,
      'pipeline_phase_incomplete',
      'exit_reason must be pipeline_phase_incomplete after pipeline-runner halts on code 3',
    );

    // No phantom-Done escape: all 5 tickets must remain non-Done
    let doneCount = 0;
    for (const id of TICKET_IDS) {
      const ticketPath = path.join(sessionDir, id, `rick_ticket_${id}.md`);
      const content = fs.readFileSync(ticketPath, 'utf-8');
      if (/status:\s*Done/i.test(content)) doneCount++;
    }
    assert.equal(doneCount, 0, `no tickets should escape as Done: found ${doneCount} Done tickets`);

    // Unfinished ticket list must appear in pipeline-runner.log
    const log = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.ok(
      /iteration cap/.test(log),
      'pipeline log must record iteration cap halt',
    );
    // reportPhaseIncomplete prints "N/M tickets remain unfinished"
    assert.ok(
      /unfinished|remain/.test(log),
      'pipeline log must list unfinished ticket count',
    );
    // At least one ticket ID should appear in the log
    const anyTicketInLog = TICKET_IDS.some(id => log.includes(id));
    assert.ok(anyTicketInLog, 'at least one unfinished ticket ID must appear in the pipeline log');
  } finally {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

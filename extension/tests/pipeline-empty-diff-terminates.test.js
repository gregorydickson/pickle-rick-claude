// @tier: fast
/**
 * WS-B (AC-B3 / AC-B4 / AC-B5) — a run with nothing to review ends ITSELF.
 *
 * Session 2026-08-07-35088221 ran nine consecutive ~15s iterations each
 * concluding "no branch-authored code exists to deslop" and ended only when an
 * external signal killed it (`exit_reason: signal:SIGHUP`). With the empty
 * branch diff now ending the phase, a run whose every phase skips for that
 * reason reaches its own terminal state with no external signal.
 *
 * The termination claim is proven by RUNNING the phase loop (`main`), not by
 * re-deriving it: the loop reaching `finalizePipeline` and calling
 * `process.exit` IS the assertion.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { __setSpawnRunnerForTests, main } from '../bin/pipeline-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_RUNNER_TS = path.resolve(__dirname, '..', 'src', 'bin', 'pipeline-runner.ts');
const TYPES_CLAUDE_MD = path.resolve(__dirname, '..', 'src', 'types', 'CLAUDE.md');

class ExitIntercept extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

function tmpDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 10_000 }).trim();
}

/**
 * A repo whose branch diff is empty: HEAD is the tip of `main`, tree clean.
 * `src/` carries enough source files to be discovered as a subsystem, so
 * anatomy-park skips for the empty diff rather than for `no_subsystems`.
 */
function initEmptyDiffRepo(dir) {
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@test.local'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  for (const name of ['alpha.ts', 'beta.ts', 'gamma.ts']) {
    fs.writeFileSync(path.join(dir, 'src', name), `export const ${name.split('.')[0]} = 1;\n`);
  }
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'seed'], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

function writeSession(sessionDir, repo, headSha) {
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
    original_prompt: 'ws-b empty diff termination test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 3,
    tmux_mode: false,
    chain_meeseeks: false,
    backend: 'claude',
    start_commit: headSha,
  }, null, 2));
  fs.writeFileSync(path.join(sessionDir, 'pipeline.json'), JSON.stringify({
    phases: ['anatomy-park', 'szechuan-sauce'],
    target: repo,
    anatomy_stall_limit: 3,
    szechuan_stall_limit: 5,
    anatomy_max_iterations: 100,
    szechuan_max_iterations: 50,
    dirty_exempt_segments: ['prds', 'docs'],
  }, null, 2));
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# Test PRD\n\n## Acceptance Criteria\n- [ ] n/a\n');
}

async function runMainToExit(sessionDir) {
  const originalExit = process.exit;
  const originalTmux = process.env.TMUX;
  const originalDataRoot = process.env.PICKLE_DATA_ROOT;
  delete process.env.TMUX;
  process.env.PICKLE_DATA_ROOT = path.join(sessionDir, 'data');
  process.exit = (code) => { throw new ExitIntercept(code ?? 0); };
  try {
    await main(sessionDir);
    return null; // returned without exiting — also a terminal state
  } catch (err) {
    if (err instanceof ExitIntercept) return err.code;
    throw err;
  } finally {
    process.exit = originalExit;
    if (originalTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTmux;
    if (originalDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = originalDataRoot;
  }
}

afterEach(() => {
  __setSpawnRunnerForTests(null);
});

test('AC-B3/AC-B5: every phase skipping for an empty branch diff reaches a terminal state with no external signal', async () => {
  const repo = tmpDir('wsb-repo-');
  const sessionDir = tmpDir('wsb-session-');
  try {
    const head = initEmptyDiffRepo(repo);
    writeSession(sessionDir, repo, head);

    let spawns = 0;
    __setSpawnRunnerForTests(() => {
      spawns++;
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    // Terminating IS the assertion: main() returns or exits on its own.
    // Ticket 14ebb20d: and it must terminate CLEANLY. The return value used to be discarded,
    // so a run that ended in failure — or crashed its way out — satisfied "reaches its own
    // terminal state" just as well as the designed exit. A run with nothing to review is not
    // an error; measured disposition is exit code 0.
    const exitCode = await runMainToExit(sessionDir);
    assert.equal(exitCode, 0, 'a run whose every phase skipped for an empty diff must exit clean');

    assert.equal(spawns, 0, 'no phase runner may be spawned when every phase skips');

    const status = JSON.parse(readFileSync(path.join(sessionDir, 'pipeline-status.json'), 'utf8'));
    assert.equal(status.status, 'completed', 'the pipeline must reach its terminal status');
    assert.equal(status.skipped_phases, 2, 'both configured phases must be recorded as skipped');

    // AC-B5: the reason reaches phase_skips in the status artifact.
    assert.deepEqual(status.phase_skips, {
      'anatomy-park': 'empty_branch_diff',
      'szechuan-sauce': 'empty_branch_diff',
    });

    // AC-B4: the reason is distinguishable from a doc-only (code-free scope) skip.
    for (const reason of Object.values(status.phase_skips)) {
      assert.notEqual(reason, 'empty_scope', 'an empty-diff skip must not reuse empty_scope');
    }

    const state = JSON.parse(readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
    assert.ok(
      !(state.exit_reason ?? '').startsWith('signal:'),
      `the run must not end on an external signal; exit_reason=${state.exit_reason}`,
    );
    // Ticket 14ebb20d: the check above passes on `exit_reason === null` via the `?? ''`
    // fallback, so "no external signal" was also satisfied by a run that recorded no
    // disposition at all — which is what an unattributable death looks like. The session
    // 2026-08-07-35088221 this test descends from ended on `signal:SIGHUP`; the point is that
    // the run now stamps its OWN reason, not merely that it failed to stamp SIGHUP.
    assert.equal(state.exit_reason, 'completed', 'the run must record its own terminal reason');
    assert.equal(state.step, 'completed', 'the session must be left in its terminal step');
    assert.equal(state.active, false, 'the session must not be left claiming liveness');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-B4: no source or doc site attributes the branch-diff case to empty_scope', () => {
  const source = readFileSync(PIPELINE_RUNNER_TS, 'utf8');
  const union = source.match(/export type PhaseSkipReason = [^;]+;/);
  assert.ok(union, 'PhaseSkipReason must still be exported from pipeline-runner.ts');
  assert.match(union[0], /'empty_branch_diff'/, 'the union must carry the distinct empty-diff reason');

  // The docstring above the union must no longer claim the branch-diff case for
  // `empty_scope` (the ticket's THE TRAP: reusing the value satisfies the
  // criterion literally while leaving the two cases indistinguishable).
  const unionIdx = source.indexOf('export type PhaseSkipReason');
  const docstring = source.slice(Math.max(0, unionIdx - 600), unionIdx);
  const emptyScopeClaim = docstring.match(/`empty_scope` = [^;]*/);
  assert.ok(emptyScopeClaim, 'the union docstring must still define empty_scope');
  assert.doesNotMatch(
    emptyScopeClaim[0], /branch\s*\n?\s*\/\/\s*diff|branch diff/,
    'empty_scope must no longer be documented as covering the branch-diff case',
  );

  const typesDoc = readFileSync(TYPES_CLAUDE_MD, 'utf8');
  assert.match(typesDoc, /'empty_scope' \| 'empty_branch_diff' \| 'no_subsystems' \| 'setup_error'/,
    'src/types/CLAUDE.md must carry the corrected union');
});

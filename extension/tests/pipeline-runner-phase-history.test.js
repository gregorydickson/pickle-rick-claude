// @tier: fast
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  __setSpawnRunnerForTests,
  main,
} from '../bin/pipeline-runner.js';
import { logActivity } from '../services/activity-logger.js';
import { verifyRecaptureFired } from '../../bin/verify-recapture-fired.js';

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

function initRepo(repo) {
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@test.local'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.mkdirSync(path.join(repo, 'services'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'services', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'services', 'b.ts'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(repo, 'services', 'c.ts'), 'export const c = 3;\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'seed'], repo);
}

function writeBaseState(sessionDir, repo) {
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
    original_prompt: 'phase history test',
    current_ticket: 'TICKET-7',
    history: [],
    activity: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    tmux_mode: true,
    chain_meeseeks: false,
    backend: 'claude',
  }, null, 2));
}

function writePipeline(sessionDir, repo) {
  fs.writeFileSync(path.join(sessionDir, 'pipeline.json'), JSON.stringify({
    phases: ['anatomy-park', 'szechuan-sauce'],
    target: repo,
    anatomy_stall_limit: 3,
    szechuan_stall_limit: 5,
    anatomy_max_iterations: 100,
    szechuan_max_iterations: 50,
    dirty_exempt_segments: ['prds', 'docs'],
  }, null, 2));
}

function makeSession() {
  const repo = tmpDir('pipeline-phase-history-repo-');
  const sessionDir = tmpDir('pipeline-phase-history-session-');
  initRepo(repo);
  writeBaseState(sessionDir, repo);
  writePipeline(sessionDir, repo);
  return { repo, sessionDir };
}

async function expectMainExit(sessionDir, code) {
  const originalExit = process.exit;
  const originalTmux = process.env.TMUX;
  delete process.env.TMUX;
  process.exit = ((actualCode) => {
    throw new ExitIntercept(actualCode ?? 0);
  });
  try {
    await assert.rejects(
      () => main(sessionDir),
      (err) => err instanceof ExitIntercept && err.code === code,
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

test('pipeline-runner persists phase history for anatomy windows used by verify-recapture-fired', async () => {
  const { repo, sessionDir } = makeSession();
  // Sandbox the activity sink: the stub emits through the REAL logActivity (as microverse-runner
  // does), and the verifier reads getDataRoot()/activity — so both must land in a tmp data root,
  // never the operator's live one.
  const dataRoot = tmpDir('pipeline-phase-history-data-');
  const priorDataRoot = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  const childSteps = [];
  __setSpawnRunnerForTests(async () => {
    const statePath = path.join(sessionDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    childSteps.push(state.step);
    if (state.step === 'anatomy-park') {
      // Emit exactly as the real producer does — logActivity, NOT state.activity. The window
      // this test pins is only meaningful if the event reaches the sink the verifier reads.
      logActivity({
        ts: new Date().toISOString(),
        event: 'baseline_recapture_attempted',
        source: 'pickle',
        session: path.basename(sessionDir),
        iteration: 1,
      });
    }
    return 0;
  });

  try {
    await expectMainExit(sessionDir, 0);

    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.deepEqual(childSteps, ['anatomy-park', 'szechuan-sauce']);
    assert.deepEqual(state.history.map((entry) => entry.step), [
      'anatomy-park',
      'szechuan-sauce',
    ]);

    const recaptureResult = verifyRecaptureFired(sessionDir);
    assert.equal(recaptureResult.exitCode, 0, JSON.stringify(recaptureResult.artifact, null, 2));
    assert.equal(recaptureResult.artifact.failure_reason, null);
  } finally {
    if (priorDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = priorDataRoot;
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// Regression guard for the doc/code drift that shipped alongside the phase-history append
// (43fdd55d added the runner append + the src/bin/CLAUDE.md mandate + this file, but left
// extension/CLAUDE.md asserting the pre-fix "runners do NOT append"). Two authoritative trap
// doors in direct contradiction is how a later re-verification pass talks itself into deleting
// a load-bearing append. Pin BOTH docs to the shipped code, not to each other.
test('AC-EXTHIST-1: state.history trap doors in both CLAUDE.md files match the shipped runner append', () => {
  const extensionRoot = path.resolve(import.meta.dirname, '..');
  const runnerSource = fs.readFileSync(
    path.join(extensionRoot, 'src', 'bin', 'pipeline-runner.ts'), 'utf-8');

  // Code truth: persistPhaseTransition appends to state.history. If this ever stops being
  // true the docs below are no longer the drifted side — re-derive before "fixing" them.
  const persistFn = runnerSource.slice(runnerSource.indexOf('function persistPhaseTransition'));
  assert.match(
    persistFn.slice(0, persistFn.indexOf('\n}\n')),
    /s\.history = \[\.\.\.history,/,
    'pipeline-runner.ts:persistPhaseTransition must append to state.history',
  );

  // src/bin/CLAUDE.md must keep mandating it.
  assert.match(
    fs.readFileSync(path.join(extensionRoot, 'src', 'bin', 'CLAUDE.md'), 'utf-8'),
    /INVARIANT: persisted phase transitions MUST append canonical `\{step,timestamp\}` entries to `state\.history`/,
    'src/bin/CLAUDE.md must mandate the pipeline-runner phase-history append',
  );

  // extension/CLAUDE.md's history field invariant must not contradict that mandate.
  const historyInvariant = fs.readFileSync(path.join(extensionRoot, 'CLAUDE.md'), 'utf-8')
    .split('\n')
    .find(line => line.includes('INVARIANT: `history`'));
  assert.ok(historyInvariant, 'extension/CLAUDE.md must document a `history` field invariant');
  assert.doesNotMatch(
    historyInvariant,
    /runners do NOT append|written only by `setup\.ts`/,
    'extension/CLAUDE.md `history` invariant contradicts the pipeline-runner append mandated by src/bin/CLAUDE.md',
  );
  assert.match(
    historyInvariant,
    /pipeline-runner\.ts/,
    'extension/CLAUDE.md `history` invariant must name pipeline-runner.ts as the appending runner',
  );
});

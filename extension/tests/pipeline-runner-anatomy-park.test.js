// @tier: fast
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  __setSpawnRunnerForTests,
  buildFlowLanes,
  discoverLanes,
  main,
  resolveAnatomyLaneRoster,
  setupAnatomyPark,
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
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 30_000 }).trim();
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

function makeSession() {
  const repo = tmpDir('pipeline-aph-repo-');
  const sessionDir = tmpDir('pipeline-aph-session-');
  initRepo(repo);
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
    original_prompt: 'test',
    current_ticket: 'TICKET-7',
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    tmux_mode: true,
    chain_meeseeks: true,
    backend: 'claude',
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

function assertRunnerScript(actualPath, scriptName) {
  const normalized = path.normalize(actualPath);
  assert.deepEqual(normalized.split(path.sep).slice(-3), ['extension', 'bin', scriptName]);
}

afterEach(() => {
  __setSpawnRunnerForTests(null);
});

test('pipeline advances from worker-mode anatomy-park convergence into szechuan-sauce', async () => {
  const { repo, sessionDir } = makeSession();
  const calls = [];
  __setSpawnRunnerForTests(async (cmd, args) => {
    calls.push({ cmd, args });
    if (calls.length === 1) {
      fs.writeFileSync(path.join(sessionDir, 'anatomy-park.json'), JSON.stringify({
        converged: true,
        reason: 'worker convergence complete',
      }, null, 2));
      fs.writeFileSync(path.join(sessionDir, 'microverse.json'), JSON.stringify({
        status: 'converged',
        exit_reason: 'converged',
        convergence_mode: 'worker',
        convergence_file: 'anatomy-park.json',
      }, null, 2));
      fs.writeFileSync(path.join(sessionDir, 'microverse-finalizer-error.json'), JSON.stringify({
        status: 'stopped',
        exit_reason: 'error',
        preserved_exit_reason: 'converged',
      }, null, 2));
    }
    return 0;
  });

  try {
    await expectMainExit(sessionDir, 0);
    assert.equal(calls.length, 2);
    assertRunnerScript(calls[0].args[0], 'microverse-runner.js');
    assertRunnerScript(calls[1].args[0], 'microverse-runner.js');
    const finalizerError = JSON.parse(fs.readFileSync(path.join(sessionDir, 'microverse-finalizer-error.json'), 'utf-8'));
    assert.equal(finalizerError.preserved_exit_reason, 'converged');
    const prd = fs.readFileSync(path.join(sessionDir, 'prd.md'), 'utf-8');
    assert.match(prd, /Szechuan Sauce/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('pipeline downgrades known anatomy-park missing-key-metric fatal to phase_skipped_with_warning', async () => {
  const { repo, sessionDir } = makeSession();
  const calls = [];
  __setSpawnRunnerForTests(async (cmd, args) => {
    calls.push({ cmd, args });
    if (calls.length === 1) {
      const statePath = path.join(sessionDir, 'state.json');
      const currentState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      currentState.exit_reason = 'fatal';
      currentState.command_template = 'anatomy-park.md';
      fs.writeFileSync(statePath, JSON.stringify(currentState, null, 2));
      return {
        exitCode: 1,
        stdout: '',
        stderr: "TypeError: Cannot read properties of undefined (reading 'description')\n",
      };
    }
    return 0;
  });

  try {
    // B-RELVERD V4: the downgrade still CONTINUES (szechuan-sauce runs — calls.length 2), but
    // the crash is named `crash_downgraded` and withholds success, so the run exits Failure (1).
    await expectMainExit(sessionDir, 1);
    assert.equal(calls.length, 2);
    assertRunnerScript(calls[0].args[0], 'microverse-runner.js');
    assertRunnerScript(calls[1].args[0], 'microverse-runner.js');

    const status = JSON.parse(fs.readFileSync(path.join(sessionDir, 'pipeline-status.json'), 'utf-8'));
    assert.equal(status.phase_skips['anatomy-park'], 'crash_downgraded');

    const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.match(runnerLog, /phase_skipped_with_warning/);
    assert.match(runnerLog, /anatomy_park_missing_key_metric/);

    const prd = fs.readFileSync(path.join(sessionDir, 'prd.md'), 'utf-8');
    assert.match(prd, /Szechuan Sauce/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// The lane roster is built once per phase. A resume — setup re-runs, then the roster is resolved again
// — must read the persisted roster back even though lane commits moved HEAD, or every lane ledger keyed
// by the old lane names would be zeroed.
const EXTENSION_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

async function withDataRoot(fn) {
  const dataRoot = tmpDir('pipeline-aph-data-');
  const prior = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.PICKLE_DATA_ROOT; else process.env.PICKLE_DATA_ROOT = prior;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

const readLedger = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'anatomy-park.json'), 'utf-8'));

test('a resumed anatomy-park phase reads the persisted flow roster and keeps the lane ledger', () => withDataRoot(() => {
  const { repo, sessionDir } = makeSession();
  const laneDir = tmpDir('pipeline-aph-lane-');
  const logs = [];
  const log = (m) => logs.push(m);
  try {
    const seed = git(['rev-parse', 'HEAD'], repo);
    fs.writeFileSync(path.join(repo, 'services', 'a.ts'), 'export const a = 10;\n');
    fs.writeFileSync(path.join(repo, 'services', 'b.ts'), 'export const b = 20;\n');
    git(['commit', '-q', '-am', 'review diff'], repo);
    assert.equal(setupAnatomyPark(sessionDir, repo, 3, EXTENSION_ROOT, log), true);
    const runtime = { sessionDir, target: repo, log };
    const first = resolveAnatomyLaneRoster(runtime, seed);
    assert.deepEqual(first.lanes.map((l) => l.name), ['flow:services/a.ts', 'flow:services/b.ts']);

    // The lane session's own ledger, seeded through its writer, then advanced by a pass.
    fs.copyFileSync(path.join(sessionDir, 'state.json'), path.join(laneDir, 'state.json'));
    const lane = first.lanes[1];
    assert.equal(setupAnatomyPark(laneDir, repo, 3, EXTENSION_ROOT, log, undefined, false, { lanes: [lane] }), true);
    const advanced = readLedger(laneDir);
    advanced.pass_counts[lane.name] = 2;
    advanced.findings_history[lane.name] = [{ pass: 1, findings: 1 }];
    fs.writeFileSync(path.join(laneDir, 'anatomy-park.json'), JSON.stringify(advanced));

    // A lane commit moves HEAD: rebuilt, the roster would join a.ts and b.ts into one lane.
    fs.writeFileSync(path.join(repo, 'services', 'b.ts'), "import { a } from './a.js';\nexport const b = a;\n");
    git(['commit', '-q', '-am', 'lane fix'], repo);

    // Resume: setup runs again over the live session, then the roster is resolved again.
    assert.equal(setupAnatomyPark(sessionDir, repo, 3, EXTENSION_ROOT, log), true);
    const resumed = resolveAnatomyLaneRoster(runtime, seed);
    assert.deepEqual(resumed.lanes, first.lanes, 'the persisted roster, not a rebuild');
    assert.equal(setupAnatomyPark(laneDir, repo, 3, EXTENSION_ROOT, log, undefined, false, { lanes: [resumed.lanes[1]] }), true);
    const ledger = readLedger(laneDir);
    assert.equal(ledger.pass_counts[lane.name], 2, 'the lane ledger is not zeroed');
    assert.deepEqual(ledger.findings_history[lane.name], [{ pass: 1, findings: 1 }]);
  } finally {
    for (const dir of [repo, sessionDir, laneDir]) fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('a persisted roster written without files round-trips unchanged', () => withDataRoot(() => {
  const { repo, sessionDir } = makeSession();
  try {
    const directories = discoverLanes(repo).lanes;
    assert.ok(directories.length > 0 && directories.every((l) => !('files' in l)), 'precondition: directory rows carry no files');
    const configPath = path.join(sessionDir, 'anatomy-park.json');
    const written = JSON.stringify({ subsystems: directories.map((l) => l.name), lane_roster: directories });
    fs.writeFileSync(configPath, written);
    const logs = [];
    const roster = resolveAnatomyLaneRoster({ sessionDir, target: repo, log: (m) => logs.push(m) }, null);
    assert.deepEqual(roster.lanes, directories);
    assert.equal(roster.fallbackReason, null);
    assert.equal(fs.readFileSync(configPath, 'utf-8'), written, 'the persisted roster is not rewritten');
    assert.equal(logs.filter((l) => l.includes('fell back to directories')).length, 0);
  } finally {
    for (const dir of [repo, sessionDir]) fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('a persisted roster without files is read back even when a review diff would build flow lanes', () => withDataRoot(() => {
  const { repo, sessionDir } = makeSession();
  try {
    const seed = git(['rev-parse', 'HEAD'], repo);
    fs.writeFileSync(path.join(repo, 'services', 'a.ts'), 'export const a = 10;\n');
    git(['commit', '-q', '-am', 'review diff'], repo);
    const directories = discoverLanes(repo).lanes;
    assert.ok(directories.every((l) => !('files' in l)), 'precondition: directory rows carry no files');
    assert.notDeepEqual(buildFlowLanes(repo, seed, ['services/a.ts']), directories,
      'precondition: a rebuild from this diff would name a different roster');
    const configPath = path.join(sessionDir, 'anatomy-park.json');
    const written = JSON.stringify({ subsystems: directories.map((l) => l.name), lane_roster: directories });
    fs.writeFileSync(configPath, written);
    const logs = [];
    let calls = 0;
    const roster = resolveAnatomyLaneRoster({ sessionDir, target: repo, log: (m) => logs.push(m) }, seed, {
      buildFlowLanes: (...args) => { calls++; return buildFlowLanes(...args); },
    });
    assert.equal(calls, 0, 'the persisted roster wins; the flow builder is not consulted');
    assert.deepEqual(roster.lanes, directories);
    assert.equal(roster.fallbackReason, null);
    assert.equal(fs.readFileSync(configPath, 'utf-8'), written, 'the persisted roster is not rewritten');
    assert.ok(logs.some((l) => l.startsWith('anatomy lanes: reusing the persisted roster')), logs.join('\n'));
  } finally {
    for (const dir of [repo, sessionDir]) fs.rmSync(dir, { recursive: true, force: true });
  }
}));

// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  AMNESIAC_TURN_THRESHOLD,
  _deps,
  appendGapAnalysisFixedBlock,
  buildMicroverseHandoff,
  classifyNoCommitExit,
  handleNoCommitStall,
} from '../bin/microverse-runner.js';
import { createMicroverseState } from '../services/microverse-state.js';

const TEST_METRIC = {
  description: 'quality score',
  validation: 'printf "1\\n"',
  type: 'command',
  timeout_seconds: 5,
  tolerance: 0,
};

function tmpDir(prefix = 'pickle-mrs-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(dir, args) {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function initRepo() {
  const dir = tmpDir('pickle-mrs-repo-');
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'baseline\n');
  git(dir, ['add', 'file.txt']);
  git(dir, ['commit', '-m', 'baseline']);
  const baseline = git(dir, ['rev-parse', 'HEAD']);
  return { dir, baseline };
}

function commitFile(dir, file, content, message) {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, ['add', file]);
  git(dir, ['commit', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

function writeResultLog(dir, name, result) {
  const logPath = path.join(dir, name);
  fs.writeFileSync(logPath, `${JSON.stringify({ type: 'assistant', message: 'working' })}\n${JSON.stringify({
    type: 'result',
    ...result,
  })}\n`);
  return logPath;
}

test('buildMicroverseHandoff includes Recent Changes with at most five commits since baseline', () => {
  const { dir, baseline } = initRepo();
  try {
    for (let i = 1; i <= 6; i++) {
      commitFile(dir, `file${i}.txt`, `change ${i}\n`, `change ${i}`);
    }
    const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    state.baseline_score = 1;
    state.convergence.history.push({
      iteration: 1,
      metric_value: '2',
      score: 2,
      action: 'accept',
      description: 'improved',
      pre_iteration_sha: baseline,
      timestamp: new Date().toISOString(),
    });

    const handoff = buildMicroverseHandoff(state, 2, dir, tmpDir('pickle-mrs-session-'));
    assert.match(handoff, /## Recent Changes/);
    assert.match(handoff, /change 6/);
    assert.match(handoff, /change 2/);
    assert.doesNotMatch(handoff, /change 1/);
    const recentSection = handoff.split('## Recent Changes')[1].split('## PRD:')[0];
    const commitLines = recentSection.split('\n').filter((line) => /^[0-9a-f]{7,}\s/.test(line));
    assert.ok(commitLines.length <= 5, `expected at most 5 commits, got ${commitLines.length}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyNoCommitExit returns amnesiac for fewer than five turns', () => {
  const dir = tmpDir();
  try {
    const logPath = writeResultLog(dir, 'iter.log', {
      num_turns: AMNESIAC_TURN_THRESHOLD - 2,
      result: 'I stopped early.',
    });
    // RECONCILED, NOT WEAKENED: the classifier is unchanged — it still reads the turn count. The
    // proxy was demoted at the CALLER (`handleNoCommitStall`), which outranks this verdict when
    // the iteration is provably a no-op. Pinning the classifier in isolation is exactly what
    // proves the demotion is a re-ranking and not a deletion (AC-CF-07).
    assert.equal(classifyNoCommitExit(logPath), 'amnesiac');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyNoCommitExit returns clean_pass for no violations output', () => {
  const dir = tmpDir();
  try {
    const logPath = writeResultLog(dir, 'iter.log', { num_turns: 8, result: 'No violations remain.' });
    assert.equal(classifyNoCommitExit(logPath), 'clean_pass');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyNoCommitExit returns stall for many turns without clean signal', () => {
  const dir = tmpDir();
  try {
    const logPath = writeResultLog(dir, 'iter.log', { num_turns: 8, result: 'Tried several changes but could not finish.' });
    assert.equal(classifyNoCommitExit(logPath), 'stall');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// AP-EXT-ITER52-01 regression: a log with NO parseable `type:"result"` line carries no verdict.
// The needle scan used to fall back to the whole log, and every clean-needle is a word ordinary
// tool output contains, so a worker killed before emitting its result line read as a clean pass.
test('classifyNoCommitExit returns stall when the log carries no result line, however many clean-needles the body holds', () => {
  const dir = tmpDir();
  try {
    const logPath = path.join(dir, 'killed.log');
    // Verbatim shapes from a real iteration log: a state read, a git probe, a prompt echo.
    fs.writeFileSync(logPath, [
      JSON.stringify({ type: 'assistant', message: '"consecutive_clean": { "extension": 1 }' }),
      JSON.stringify({ type: 'user', message: 'nothing to fix here; no violations remain' }),
      'On branch release/v2.1-beta',
      'nothing to commit, working tree clean',
      'A clean pass is a valid, expected outcome — say "clean" or "no violations".',
    ].join('\n'));
    assert.equal(classifyNoCommitExit(logPath), 'stall');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Same defect at the seam that consumes the verdict. `autoRescueDirtyTree` returns without
// committing when every dirty path is un-attributable, which leaves the tree DIRTY — so
// `isProvablyNoOpIteration` cannot demote, and the classifier's verdict stands unmediated.
// A `clean_pass` there returns `converged` and ends the run reporting success over an
// iteration that built nothing.
test('handleNoCommitStall does not converge on a dirty tree when the killed worker left no result line', async () => {
  const { dir, baseline } = initRepo();
  const sessionDir = tmpDir('pickle-mrs-session-');
  const originalSleep = _deps.sleep;
  _deps.sleep = async () => {};
  try {
    // Un-attributable dirt: autoRescueDirtyTree excludes prds/, so owned is empty and the
    // tree stays dirty through the no-commit seam.
    fs.mkdirSync(path.join(dir, 'prds'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'prds', 'stray.md'), 'un-attributable dirt\n');
    assert.equal(_deps.isWorkingTreeDirty(dir), true, 'precondition: the demotion guard must not fire');

    const logPath = path.join(sessionDir, 'tmux_iteration_7.log');
    fs.writeFileSync(logPath, 'reading consecutive_clean from anatomy-park.json\nworking tree clean\n');

    const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    state.status = 'iterating';

    const result = await handleNoCommitStall(state, {
      sessionDir,
      workingDir: dir,
      preIterSha: baseline,
      postIterSha: baseline,
      log: () => {},
    }, logPath);

    assert.notEqual(result, 'converged', 'a verdict-less killed worker must never report convergence');
    assert.equal(state.convergence.stall_counter, 1, 'it is recorded as the stall it is');
  } finally {
    _deps.sleep = originalSleep;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('appendGapAnalysisFixedBlock appends commit SHA, message, and files', () => {
  const { dir } = initRepo();
  const sessionDir = tmpDir('pickle-mrs-session-');
  try {
    const sha = commitFile(dir, 'fixed.txt', 'fixed\n', 'fix important gap');
    const gapPath = path.join(sessionDir, 'gap_analysis.md');
    fs.writeFileSync(gapPath, '# Gap Analysis\n\n- gap A\n');

    appendGapAnalysisFixedBlock({
      gapAnalysisPath: gapPath,
      workingDir: dir,
      iteration: 4,
      commitSha: sha,
    });

    const content = fs.readFileSync(gapPath, 'utf-8');
    assert.match(content, /## Iteration 4 — Fixed/);
    assert.match(content, new RegExp(`- Commit: ${sha.slice(0, 12)} fix important gap`));
    assert.match(content, /- Files: fixed\.txt/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// REWRITTEN, NOT DELETED: this case used to assert that a SECOND consecutive amnesiac exit forces
// `status: 'gap_analysis'` and truncates gap_analysis.md. That behaviour is precisely what was
// removed. Suppressing the breaker's self-reset instead would have left its `>= 2` predicate
// latched true forever, re-running a paid gap analysis EVERY iteration rather than every second one
// — worse than the bug. Removing the call site dissolves that hazard, because the stall arm's
// `recordStall` zeroes `consecutive_amnesiac_exits` on its own. The inputs are kept verbatim so the
// same iteration shape is still exercised; only the expectations moved.
test('handleNoCommitStall no longer resets gap analysis on a second consecutive amnesiac exit', async () => {
  const sessionDir = tmpDir('pickle-mrs-session-');
  const originalSleep = _deps.sleep;
  _deps.sleep = async () => {};
  try {
    const gapPath = path.join(sessionDir, 'gap_analysis.md');
    const logPath = writeResultLog(sessionDir, 'tmux_iteration_2.log', {
      num_turns: AMNESIAC_TURN_THRESHOLD - 2,
      result: 'short exit',
    });
    fs.writeFileSync(gapPath, '# Gap Analysis\n\nstale item\n');
    const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    state.status = 'iterating';
    state.gap_analysis_path = gapPath;
    state.consecutive_amnesiac_exits = 1;

    // No SHAs and no workingDir on ctx: the truth check cannot prove a no-op, so it falls through
    // and the turn-count proxy still decides. That is the demotion working as specified — truth
    // outranks the proxy where truth exists, and nowhere else.
    const result = await handleNoCommitStall(state, {
      sessionDir,
      log: () => {},
    }, logPath);

    assert.equal(result, null);
    assert.equal(state.status, 'iterating', 'the breaker no longer forces a gap-analysis rerun');
    assert.equal(state.consecutive_amnesiac_exits, 2, 'the amnesiac counter is no longer self-reset');
    assert.equal(state.convergence.stall_counter, 0, 'an unproven iteration still does not count as a stall');
    assert.equal(JSON.parse(fs.readFileSync(path.join(sessionDir, 'microverse.json'), 'utf-8')).status, 'iterating');
    assert.match(fs.readFileSync(gapPath, 'utf-8'), /stale item/, 'gap_analysis.md is no longer truncated');
  } finally {
    _deps.sleep = originalSleep;
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function readSrc(relPath) {
  return fs.readFileSync(path.join(SRC_ROOT, relPath), 'utf-8');
}

// A provably no-op iteration: HEAD unchanged (so zero commits in pre..post by construction) and a
// clean working tree. This is the shape a blocked-but-correct worker leaves behind.
function provablyNoOpCtx(repoDir, sessionDir) {
  const sha = git(repoDir, ['rev-parse', 'HEAD']);
  return {
    sessionDir,
    workingDir: repoDir,
    preIterSha: sha,
    postIterSha: sha,
    iteration: 1,
    log: () => {},
  };
}

test('AC-CF-06: a provably no-op iteration classifies stall, never converged', async () => {
  const { dir } = initRepo();
  const sessionDir = tmpDir('pickle-mrs-session-');
  const originalSleep = _deps.sleep;
  _deps.sleep = async () => {};
  try {
    // The log carries BOTH shields the pre-fix classifier would have honored: a sub-threshold turn
    // count (the `amnesiac` proxy) and the `clean` / `nothing to fix` substrings (the `clean_pass`
    // arm, which returns the literal 'converged'). Observable truth must outrank both.
    const logPath = writeResultLog(sessionDir, 'tmux_iteration_1.log', {
      num_turns: AMNESIAC_TURN_THRESHOLD - 2,
      result: 'The tree is clean and there is nothing to fix — I am blocked.',
    });
    const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    state.status = 'iterating';

    const result = await handleNoCommitStall(state, provablyNoOpCtx(dir, sessionDir), logPath);

    assert.notEqual(
      result,
      'converged',
      "'converged' over a repo that built nothing is a fake-green — reporting success is a strictly worse failure than the expensive-but-honest loop",
    );
    assert.equal(result, null, 'below stall_limit the loop keeps going — the gate parks, it does not halt');
    assert.equal(state.convergence.stall_counter, 1, 'the stall arm ran: stall_counter advanced');
    assert.equal(state.consecutive_amnesiac_exits, 0, 'recordStall zeroed the amnesiac counter — no breaker needed');
  } finally {
    _deps.sleep = originalSleep;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-CF-08: repeated blocked no-op iterations terminate on the existing stall ceiling', async () => {
  const { dir } = initRepo();
  const sessionDir = tmpDir('pickle-mrs-session-');
  const originalSleep = _deps.sleep;
  const originalSpawn = _deps.spawn;
  const originalExecFile = _deps.execFile;
  let judgeSpawns = 0;
  _deps.sleep = async () => {};
  _deps.spawn = (...args) => { judgeSpawns += 1; return originalSpawn(...args); };
  _deps.execFile = (...args) => { judgeSpawns += 1; return originalExecFile(...args); };
  try {
    const STALL_LIMIT = 3;
    const MAX_ITERATIONS = 50;
    const logPath = writeResultLog(sessionDir, 'tmux_iteration_1.log', {
      num_turns: AMNESIAC_TURN_THRESHOLD - 2,
      result: 'still blocked, nothing to fix',
    });
    const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: STALL_LIMIT });
    state.status = 'iterating';
    const ctx = provablyNoOpCtx(dir, sessionDir);

    let iterations = 0;
    let result = null;
    while (result === null && iterations < MAX_ITERATIONS) {
      iterations += 1;
      ctx.iteration = iterations;
      result = await handleNoCommitStall(state, ctx, logPath);
    }

    assert.equal(result, 'stalled_below_target', 'terminates on the SHIPPED stall ceiling — no new exit reason');
    assert.equal(iterations, STALL_LIMIT, 'the bound is stall_limit, reached exactly');
    assert.ok(
      iterations < MAX_ITERATIONS,
      'exit iteration is below max_iterations, so iteration_budget_exhausted cannot be the mechanism under test',
    );
    assert.ok(judgeSpawns <= STALL_LIMIT, `expected <= ${STALL_LIMIT} measurement spawns, got ${judgeSpawns}`);
  } finally {
    _deps.sleep = originalSleep;
    _deps.spawn = originalSpawn;
    _deps.execFile = originalExecFile;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-CF-09: NoCommitExitClassification gains no member', () => {
  const src = readSrc('bin/microverse-runner.ts');
  const decl = /export type NoCommitExitClassification =([^;]+);/.exec(src);
  assert.ok(decl, 'NoCommitExitClassification declaration not found');
  const members = decl[1].match(/'[a-z_]+'/g).map((m) => m.slice(1, -1)).sort();
  assert.deepEqual(members, ['amnesiac', 'clean_pass', 'stall'], 'the union stays exactly three members');
});

test('AC-CF-17: no new microverse-state field, exit reason, or counter', () => {
  const types = readSrc('types/index.ts');
  const block = /export interface MicroverseSessionState \{([\s\S]*?)\n\}/.exec(types);
  assert.ok(block, 'MicroverseSessionState declaration not found');
  const fields = [...block[1].matchAll(/^\s{2}([a-z_]+)\??:/gm)].map((m) => m[1]);
  assert.deepEqual(fields, [
    'status',
    'prd_path',
    'key_metric',
    'convergence',
    'gap_analysis_path',
    'judge_context_path',
    'failed_approaches',
    'baseline_score',
    'convergence_target',
    'convergence_mode',
    'convergence_file',
    'allowed_paths',
    'exit_reason',
    'stash_ref',
    'failure_history',
    'approach_exhaustion_fired',
    'iteration_regressions',
    'gate_regression_threshold_warning_emitted',
    'consecutive_amnesiac_exits',
    'consecutive_subprocess_errors',
    'violation_ledger',
    'current_subsystem',
  ], 'the fix reuses shipped state — a new field here means a new mechanism was added');

  const runner = readSrc('bin/microverse-runner.ts');
  assert.doesNotMatch(runner, /max_amnesiac_exits/, 'no new cap field');
  assert.doesNotMatch(runner, /skip_[a-z_]*_reason\b/, 'no new skip flag');
});

test('handleNoCommitStall clean pass converges without clearing state object', async () => {
  const sessionDir = tmpDir('pickle-mrs-session-');
  try {
    const logPath = writeResultLog(sessionDir, 'tmux_iteration_3.log', { num_turns: 8, result: 'No violations remain.' });
    const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    state.status = 'iterating';

    const result = await handleNoCommitStall(state, {
      sessionDir,
      log: () => {},
    }, logPath);

    assert.equal(result, 'converged');
    assert.equal(state.status, 'iterating');
    assert.equal(state.prd_path, '/tmp/prd.md');
    assert.equal(state.convergence.stall_counter, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sessionDir, 'microverse.json'), 'utf-8')).prd_path, '/tmp/prd.md');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

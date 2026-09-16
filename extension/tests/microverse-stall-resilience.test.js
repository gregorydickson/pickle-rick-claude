// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import {
  AMNESIAC_TURN_THRESHOLD,
  _deps,
  appendGapAnalysisFixedBlock,
  buildMicroverseHandoff,
  buildJudgePrompt,
  selectLedgerEntriesForPrompt,
  classifyMicroverseDisposition,
  autoRescueDirtyTree,
  classifyNoCommitExit,
  handleIterationOutcome,
  handleNoCommitStall,
  applyLedgerPartialProgress,
  readLedgerSizeFigures,
  readLedgerEntryFigures,
  parseLlmJudgeOutput,
  JUDGE_SYSTEM_PROMPT,
  findUnmovableLedgerEntries,
  convergenceExitReason,
  writeFinalReport,
  deriveJudgeReviewSurface,
  measureLlmIteration,
} from '../bin/microverse-runner.js';
import {
  createMicroverseState,
  updateViolationLedger,
  compareMetric,
  compareMetricWithBasis,
  recordIteration,
  isConverged,
  writeMicroverseState,
} from '../services/microverse-state.js';
import { mkFixtureTmpDir } from './helpers/fixture-tmpdir.js';

const TEST_METRIC = {
  description: 'quality score',
  validation: 'printf "1\\n"',
  type: 'command',
  timeout_seconds: 5,
  tolerance: 0,
};

// D6: routed through the shared crash-surviving registry instead of a bare mkdtempSync — a
// thrown assertion before this file's own fs.rmSync cleanup used to leak the directory until
// the 24h derived-prefix sweep caught it; mkFixtureTmpDir's after()/exit hooks catch it
// immediately regardless of how the test ends.
function tmpDir(prefix = 'pickle-mrs-') {
  return mkFixtureTmpDir(prefix);
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
    // da44ff00 (AC-J3-4): the out-of-surface drop count, an additive/optional counter reaching
    // the persisted phase artifact per the ticket's own Interface Contract — a sanctioned
    // addition for a new mechanism, not the drift this pin exists to catch.
    'out_of_surface_findings_dropped',
    // cfc530c6 (AC-J4-4): the stalled_below_target cause + derivation inputs, additive/optional,
    // written once at the stalled_below_target exit only — a sanctioned addition for a new
    // mechanism, not the drift this pin exists to catch.
    'stall_disposition',
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

// AP-EXT-ITER119-01: `converged` over a repo that built nothing, reached through BYSTANDER dirt.
//
// AC-CF-06 above proves the clean-tree case. This is the same invariant on the arm that leaked:
// `isProvablyNoOpIteration` used to ask "is the tree dirty", but `autoRescueDirtyTree` has already
// run by then and has already committed everything ATTRIBUTABLE. Dirt that survives it is dirt it
// explicitly DISOWNED (excluded prefix / out of session scope) and anchored to a salvage ref while
// logging `treating as stall` — and that same disowned dirt then proved the iteration was not a
// no-op, so the prose classifier ran and `clean_pass` returned the literal 'converged'. One
// untracked file under `docs/` was enough to defeat AC-CF-06 without changing a line of the repo.
//
// The cases run the REAL caller sequence (autoRescueDirtyTree then handleNoCommitStall) against a
// real git repo, because the defect lives in the seam between those two functions, not inside
// either one.
const BYSTANDER_ONLY_DIRT = [
  { label: 'docs/', file: path.join('docs', 'workplan.md') },
  { label: 'prds/', file: path.join('prds', 'p1-feature.md') },
];

async function runNoCommitIteration(dir, sessionDir, resultText) {
  const sha = git(dir, ['rev-parse', 'HEAD']);
  const logPath = writeResultLog(sessionDir, 'tmux_iteration_1.log', {
    subtype: 'success',
    num_turns: 60,
    result: resultText,
  });
  const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
  state.status = 'iterating';
  const ctx = {
    sessionDir, workingDir: dir, preIterSha: sha, postIterSha: sha, iteration: 1, log: () => {},
  };
  autoRescueDirtyTree(ctx);
  const headMoved = git(dir, ['rev-parse', 'HEAD']) !== sha;
  if (headMoved) return { headMoved, result: null, state };
  ctx.postIterSha = sha;
  return { headMoved, result: await handleNoCommitStall(state, ctx, logPath), state };
}

for (const { label, file } of BYSTANDER_ONLY_DIRT) {
  test(`AP-EXT-ITER119-01: bystander-only dirt under ${label} cannot turn a zero-commit iteration into 'converged'`, async () => {
    const { dir } = initRepo();
    const sessionDir = tmpDir('pickle-mrs-session-');
    const originalSleep = _deps.sleep;
    _deps.sleep = async () => {};
    const originalLogActivity = _deps.logActivity;
    const activity = [];
    _deps.logActivity = (event) => { activity.push(event); };
    try {
      fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), 'bystander\n');

      const { headMoved, result, state } = await runNoCommitIteration(
        dir, sessionDir, 'Clean pass — no violations found. Nothing committed.',
      );

      assert.equal(headMoved, false, 'auto-rescue must disown this dirt, so HEAD stays put');
      assert.notEqual(
        result,
        'converged',
        `'converged' over a repo that built nothing is a fake-green — one untracked ${label} file must not buy the success verdict AC-CF-06 denies a clean tree`,
      );
      assert.equal(result, null, 'below stall_limit the loop keeps going — the gate parks, it does not halt');
      assert.equal(state.convergence.stall_counter, 1, 'the stall arm ran: stall_counter advanced');
      assert.equal(
        git(dir, ['status', '--porcelain']).trim() !== '', true,
        'the bystander dirt is still there — the verdict changed, the tree did not',
      );
    } finally {
      _deps.sleep = originalSleep;
      _deps.logActivity = originalLogActivity;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
}

// ANTI-OVER-TRIGGER CONTROL. The fix narrows the tree question to ATTRIBUTABLE dirt; it must not
// widen into "every no-commit iteration is a no-op", which would make the classifier dead code.
// Ownable dirt is real worker output, so the iteration is NOT provably a no-op and the classifier's
// verdict must still stand. Mutating the fix to `return true` unconditionally reds this case.
test('AP-EXT-ITER119-01 control: ownable dirt leaves the classifier verdict standing', async () => {
  const { dir } = initRepo();
  const sessionDir = tmpDir('pickle-mrs-session-');
  const originalSleep = _deps.sleep;
  _deps.sleep = async () => {};
  try {
    fs.writeFileSync(path.join(dir, 'worker-output.txt'), 'real uncommitted work\n');
    const sha = git(dir, ['rev-parse', 'HEAD']);
    const logPath = writeResultLog(sessionDir, 'tmux_iteration_1.log', {
      subtype: 'success', num_turns: 60, result: 'Clean pass — no violations found.',
    });
    const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    state.status = 'iterating';

    // handleNoCommitStall called directly: auto-rescue would have committed this dirt, so this
    // pins the predicate itself rather than the pair.
    const result = await handleNoCommitStall(state, {
      sessionDir, workingDir: dir, preIterSha: sha, postIterSha: sha, iteration: 1, log: () => {},
    }, logPath);

    assert.equal(result, 'converged', 'ownable dirt is worker output — the no-op proof must NOT fire');
    assert.equal(state.convergence.stall_counter, 0, 'the stall arm must not have run');
  } finally {
    _deps.sleep = originalSleep;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// Ticket 79686819: is `clean_pass` reachable through the REAL `autoRescueDirtyTree` ->
// `handleNoCommitStall` sequence after db605b05 + da44ff00 (in-scope dirt is auto-committed)?
// The control test above proves the PREDICATE tolerates owned dirt, but calls
// `handleNoCommitStall` directly and its own comment says auto-rescue would have committed
// that dirt in production — so it does not prove the state survives the real caller sequence.
//
// It does: `autoRescueDirtyTree` stages owned dirt and runs `git commit`, but a git failure
// (index lock contention, a rejecting pre-commit hook, disk full, GPG failure ...) leaves the
// dirt UNSTAGED-but-PRESENT (`git reset` only unstages) and `ctx.postIterSha` untouched.
// `handleMetricMode` still sees `postIterSha === preIterSha` and calls `handleNoCommitStall`,
// which re-evaluates `isProvablyNoOpIteration` — the same owned dirt is still there, so it
// returns false and the classifier's independent `clean_pass` verdict is NOT overridden.
//
// Index-lock contention (not a pre-commit hook) is used to force the failure deterministically:
// a rejecting `.git/hooks/pre-commit` is defeated by the pickle worker session's own ambient
// `GIT_CONFIG_KEY_*=core.hooksPath` override (its trailer-hooks redirect), which every `git`
// spawn in this process inherits via `process.env`. Precedent for the index-lock technique:
// `tests/concurrent-git-access-probe-launch.test.js`, `tests/cancel-index-lock-preserved.test.js`.
function jamGitIndexLock(dir) {
  fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '');
}

test('clean_pass is reachable: a failed auto-commit leaves owned dirt behind and the classifier still converges', async () => {
  const { dir } = initRepo();
  const sessionDir = tmpDir('pickle-mrs-session-');
  try {
    fs.writeFileSync(path.join(dir, 'worker-output.txt'), 'real uncommitted work\n');
    jamGitIndexLock(dir);
    const sha = git(dir, ['rev-parse', 'HEAD']);
    const ctx = {
      sessionDir, workingDir: dir, preIterSha: sha, postIterSha: sha, iteration: 1, log: () => {},
    };

    // Real caller sequence: autoRescueDirtyTree runs first, exactly as handleIterationOutcome
    // does when preIterSha === postIterSha.
    autoRescueDirtyTree(ctx);

    assert.equal(git(dir, ['rev-parse', 'HEAD']), sha, 'the rejected commit must not move HEAD');
    assert.notEqual(
      git(dir, ['status', '--porcelain']).trim(), '',
      'the owned dirt must SURVIVE the failed commit — this is the state that makes clean_pass reachable',
    );

    const logPath = writeResultLog(sessionDir, 'tmux_iteration_1.log', {
      subtype: 'success', num_turns: 60, result: 'Clean pass — no violations found.',
    });
    const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    state.status = 'iterating';
    ctx.postIterSha = sha;

    const result = await handleNoCommitStall(state, ctx, logPath);

    assert.equal(
      result, 'converged',
      'a failed auto-commit leaves real owned dirt on disk, and the surviving classifier verdict still converges',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('a failed auto-commit does not converge when the worker\'s own log is not clean_pass-shaped', async () => {
  const { dir } = initRepo();
  const sessionDir = tmpDir('pickle-mrs-session-');
  const originalSleep = _deps.sleep;
  _deps.sleep = async () => {};
  try {
    fs.writeFileSync(path.join(dir, 'worker-output.txt'), 'real uncommitted work\n');
    jamGitIndexLock(dir);
    const sha = git(dir, ['rev-parse', 'HEAD']);
    const ctx = {
      sessionDir, workingDir: dir, preIterSha: sha, postIterSha: sha, iteration: 1, log: () => {},
    };

    autoRescueDirtyTree(ctx);
    assert.notEqual(
      git(dir, ['status', '--porcelain']).trim(), '',
      'precondition: the owned dirt must survive the failed commit, same as the positive case',
    );

    const logPath = writeResultLog(sessionDir, 'tmux_iteration_1.log', {
      subtype: 'success', num_turns: 60, result: 'Blocked — could not complete the task.',
    });
    const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    state.status = 'iterating';
    ctx.postIterSha = sha;

    const result = await handleNoCommitStall(state, ctx, logPath);

    assert.notEqual(
      result, 'converged',
      'the same failed-auto-commit state must NOT converge on its own — only the classifier\'s independent clean_pass verdict may',
    );
    assert.equal(state.convergence.stall_counter, 1, 'the stall arm ran');
  } finally {
    _deps.sleep = originalSleep;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// AP-EXT-ITER184-01: the dirty-tree rescue belonged to ONE convergence mode, not to the iteration.
//
// Every case above runs the METRIC-mode sequence. `autoRescueDirtyTree` had exactly one production
// call site and it was inside `handleMetricMode`, so a WORKER-managed iteration (the mode
// anatomy-park and szechuan-sauce run in) never rescued anything: a worker that authored a
// complete fix and exited before committing left it on the floor — no auto-commit, no salvage
// anchor for the un-attributable remainder, and no gate, because `runPerIterationGateHook` reads
// `preIterSha !== HEAD` and skips. Measured on session 2026-09-01-6a67c80b: 17 of 69 iterations
// ended with HEAD unmoved, and iteration 67 left a complete staged fix that only survived because
// the NEXT worker noticed it by hand.
//
// These cases drive the REAL dispatcher (`handleIterationOutcome`, worker mode) against a real git
// repo, because the defect lives in the seam between the dispatcher and the mode handlers.
function workerModeSession(dir) {
  const sessionDir = tmpDir('pickle-mrs-worker-');
  fs.writeFileSync(path.join(sessionDir, 'anatomy-park.json'), JSON.stringify({
    subsystems: ['alpha'], current_index: 0, pass_counts: { alpha: 1 }, stall_counts: { alpha: 0 },
  }));
  const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
  state.status = 'iterating';
  state.convergence_mode = 'worker';
  state.convergence_file = 'anatomy-park.json';
  state.current_subsystem = 'alpha';
  const ctx = {
    sessionDir,
    extensionRoot: path.resolve(sessionDir, '..'),
    statePath: path.join(sessionDir, 'state.json'),
    workingDir: dir,
    startTime: Date.now(),
    preIterSha: git(dir, ['rev-parse', 'HEAD']),
    iteration: 1,
    consecutiveRateLimits: 0,
    enableFailureClassification: false,
    rateLimitWaitMinutes: 60,
    maxRateLimitRetries: 3,
    cgSettings: {
      enabled_convergence_files: ['anatomy-park.json'],
      regression_warning_threshold: 5,
      remediator_timeout_s: 600,
      baseline_max_age_iterations: 30,
      baseline_max_age_seconds: 14_400,
    },
    currentRunnerState: { active: true, working_dir: dir, backend: 'claude', session_dir: sessionDir },
    log: () => {},
  };
  return { sessionDir, state, ctx };
}

async function runWorkerModeIteration(dir) {
  const { sessionDir, state, ctx } = workerModeSession(dir);
  const original = {
    sleep: _deps.sleep,
    collectTickets: _deps.collectTickets,
    runWorkerManagedIteration: _deps.runWorkerManagedIteration,
  };
  let headAtWorkerHandoff = null;
  try {
    _deps.sleep = async () => {};
    _deps.collectTickets = () => [];
    _deps.runWorkerManagedIteration = async (opts) => {
      headAtWorkerHandoff = git(dir, ['rev-parse', 'HEAD']);
      return { currentMv: opts.currentMv, converged: false, reason: 'still iterating' };
    };
    const result = await handleIterationOutcome(state, { raw: '0', score: 0 }, ctx, {
      completion: 'task_completed', timedOut: false, exitCode: 0, wallSeconds: 30,
    });
    return { result, headAtWorkerHandoff, preIterSha: ctx.preIterSha };
  } finally {
    _deps.sleep = original.sleep;
    _deps.collectTickets = original.collectTickets;
    _deps.runWorkerManagedIteration = original.runWorkerManagedIteration;
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
}

test('AP-EXT-ITER184-01: a worker-managed iteration rescues the complete fix its worker left uncommitted', async () => {
  const { dir } = initRepo();
  try {
    // The shape measured in the field: an in-scope source edit, authored and never committed.
    fs.writeFileSync(path.join(dir, 'fix.ts'), 'export const fixed = true;\n');

    const { result, headAtWorkerHandoff, preIterSha } = await runWorkerModeIteration(dir);

    assert.equal(result, 'continue', 'the rescue must not change the iteration disposition');
    const head = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(
      head,
      preIterSha,
      'worker mode must auto-commit attributable dirt — leaving it on the floor disowns a complete fix',
    );
    assert.match(
      git(dir, ['show', '--name-only', '--format=', 'HEAD']),
      /fix\.ts/,
      'the rescued commit must carry the file the worker authored',
    );
    assert.equal(git(dir, ['status', '--porcelain']).trim(), '', 'the tree is clean after the rescue');
    assert.equal(
      headAtWorkerHandoff,
      head,
      'the rescue must run BEFORE the worker-managed iteration, so its per-iteration gate sees the rescued commit instead of reporting no_commits',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ANTI-OVER-TRIGGER CONTROL. Hoisting the rescue must not fabricate a commit on a clean tree —
// a zero-commit iteration that genuinely produced nothing stays a zero-commit iteration.
test('AP-EXT-ITER184-01 control: a clean worker-managed iteration commits nothing', async () => {
  const { dir, baseline } = initRepo();
  try {
    const { result, headAtWorkerHandoff } = await runWorkerModeIteration(dir);

    assert.equal(result, 'continue');
    assert.equal(git(dir, ['rev-parse', 'HEAD']), baseline, 'no dirt, no commit');
    assert.equal(headAtWorkerHandoff, baseline, 'the worker still sees the unmoved HEAD');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- H7: the worked set IS the scored set ---
//
// Field evidence (session 2026-09-06-f625727a): a 23-entry `violation_ledger`, a brief naming
// ZERO of them, four consecutive `held` passes at exactly 23, terminating `stalled_below_target`.
// The worker re-derived its own candidate pool each iteration and optimised a set the metric did
// not score. These pins hold the two sets together at the one place they can diverge: the
// `selectLedgerEntriesForPrompt` call that both `buildJudgePrompt` and the handoff make.

function ledgerEntry(i, over = {}) {
  return {
    id: `v${i}`,
    path: `src/mod${i}.ts`,
    line: 100 + i,
    rule: `rule-${i}`,
    first_seen_iter: 1,
    last_seen_iter: 1,
    severity: 'med',
    description: `violation number ${i}`,
    ...over,
  };
}

function seededState(ledger) {
  const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
  state.violation_ledger = ledger;
  return state;
}

// AC-H7-1 (metric arm — the one szechuan takes: no `convergence_mode` field).
test('AC-H7-1 metric handoff names every entry of the ledger the judge scores', () => {
  const ledger = [ledgerEntry(1), ledgerEntry(2), ledgerEntry(3)];
  const handoff = buildMicroverseHandoff(seededState(ledger), 4, '/tmp/work', '/tmp/session');

  assert.match(handoff, /## Open Violations/);
  for (const entry of ledger) {
    assert.ok(handoff.includes(entry.id), `brief must name ledger id ${entry.id}`);
    assert.ok(handoff.includes(entry.description), `brief must carry ${entry.id}'s description`);
    assert.ok(handoff.includes(`${entry.path}:${entry.line}`), `brief must locate ${entry.id}`);
  }
});

// AC-H7-1 (worker-managed arm). Both arms, one shared helper — no mode branch may reintroduce
// the asymmetry on one side only.
test('AC-H7-1 worker-managed handoff names every entry of the scored ledger too', () => {
  const state = seededState([ledgerEntry(7), ledgerEntry(8)]);
  state.convergence_mode = 'worker';
  state.convergence_file = 'convergence.json';
  const handoff = buildMicroverseHandoff(state, 2, '/tmp/work', '/tmp/session');

  assert.match(handoff, /## Open Violations/);
  assert.ok(handoff.includes('v7') && handoff.includes('v8'));
});

// The brief and the judge prompt must render the SAME selection — same cap, same ordering.
// A ledger past the cap is where two independently-maintained selections would drift.
test('AC-H7-1 brief and judge prompt select the identical ledger subset past the cap', () => {
  const ledger = [];
  for (let i = 0; i < 60; i++) ledger.push(ledgerEntry(i, { last_seen_iter: i }));

  const selected = selectLedgerEntriesForPrompt(ledger);
  assert.equal(selected.length, 50, 'cap applies');
  assert.equal(selected[0].last_seen_iter, 59, 'most-recent first');

  const handoff = buildMicroverseHandoff(seededState(ledger), 3, '/tmp/work', '/tmp/session');
  const judge = buildJudgePrompt({ goal: 'g', cwd: '/tmp/work', priorViolations: ledger });

  for (const entry of selected) {
    assert.ok(handoff.includes(entry.id), `briefed set must contain ${entry.id}`);
    assert.ok(judge.includes(entry.id), `scored set must contain ${entry.id}`);
  }
  const dropped = ledger.filter((e) => !selected.some((s) => s.id === e.id));
  for (const entry of dropped) {
    assert.ok(!handoff.includes(`[${entry.id}]`), `${entry.id} is outside the scored set`);
    assert.ok(!judge.includes(`[${entry.id}]`), `${entry.id} is outside the briefed set`);
  }
});

// AC-H7-2: end-to-end over a fixture ledger. Fixing an entry the brief NAMED moves the metric,
// because that entry was in the scored set. Runs the real producer + the real classifier.
test('AC-H7-2 fixing a briefed ledger entry measurably moves the metric', () => {
  const ledger = [ledgerEntry(1), ledgerEntry(2), ledgerEntry(3)];
  const state = seededState(ledger);

  const briefBefore = buildMicroverseHandoff(state, 4, '/tmp/work', '/tmp/session');
  const target = ledger[1];
  assert.ok(briefBefore.includes(target.id), 'precondition: the worker was briefed on this entry');

  // The worker fixes it; the next full judge pass reports the remaining two.
  const remaining = [ledger[0], ledger[2]].map((e) => ({
    id: e.id, path: e.path, line: e.line, rule: e.rule,
    severity: e.severity, description: e.description,
  }));
  const scoreBefore = state.violation_ledger.length;
  updateViolationLedger(state, { score: remaining.length, violations: remaining, resolved: [target.id], new: [], remaining: remaining.map((v) => v.id) }, 5);
  const scoreAfter = state.violation_ledger.length;

  assert.equal(scoreAfter, scoreBefore - 1, 'the scored set shrank by the entry that was worked');
  assert.ok(!state.violation_ledger.some((e) => e.id === target.id), 'fixed entry left the ledger');
  assert.equal(
    compareMetric(scoreAfter, scoreBefore, 0, 'lower'),
    'improved',
    'a fixed briefed entry registers as metric improvement, not a stall',
  );
  assert.ok(
    !buildMicroverseHandoff(state, 6, '/tmp/work', '/tmp/session').includes(target.id),
    'the next brief no longer re-briefs the fixed entry',
  );
});

// AC-H7-5: the disposition stays REPORTING. It parks and flags; it must never become a halt.
test('AC-H7-5 stalled_below_target remains a non-convergent reporting disposition', () => {
  assert.deepEqual(
    classifyMicroverseDisposition('stalled_below_target'),
    { reportAs: 'non-convergent', exitCode: 1 },
  );
});

// NEGATIVE CONTROL. Iteration 1 and every clean run have no ledger yet; those briefs must stay
// exactly as they were. Without this, the pins above would pass on a helper that emitted the
// heading unconditionally.
test('AC-H7 control: an absent, empty or malformed ledger adds no Open Violations section', () => {
  for (const ledger of [undefined, [], null, 'nonsense', { id: 'x' }]) {
    const state = seededState(ledger);
    const handoff = buildMicroverseHandoff(state, 1, '/tmp/work', '/tmp/session');
    assert.doesNotMatch(handoff, /## Open Violations/, `no section for ledger=${JSON.stringify(ledger)}`);
  }
  assert.deepEqual(selectLedgerEntriesForPrompt(undefined), []);
  assert.deepEqual(selectLedgerEntriesForPrompt('nonsense'), []);
});

// ---------------------------------------------------------------------------
// R4 (GitHub #23): an unresolvable ledger entry guarantees a stall.
// Fixtures are distilled from the two measured sessions (see each fixture's `note`).
// ---------------------------------------------------------------------------

const R4_FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'r4-szechuan-ledger-replay');
const readR4Fixture = (name) => JSON.parse(fs.readFileSync(path.join(R4_FIXTURE_DIR, name), 'utf-8'));
const AUDIT_RUNNER = 'extension/src/services/citadel/audit-runner.ts';
const HELD_SET_OPS = { classification: 'held', figures: { basis: 'set_ops', resolved: 1, new: 1, remaining: 3 } };
const touchedPaths = (...paths) => () => new Set(paths);
const NOTHING_TOUCHED = () => new Set();

test('R4-1: a held pass whose entry measurably shrank (122 -> 88 lines, same path) classifies improved', () => {
  const result = applyLedgerPartialProgress(
    HELD_SET_OPS,
    [{ path: AUDIT_RUNNER, description: 'buildCitadelAuditReport is 122 lines (hard limit 50); orchestrates 20+ analyzers inline' }],
    [{ path: AUDIT_RUNNER, description: 'runCitadelAnalyzers is 88 lines (hard limit 50); orchestrates 20 analyzer calls inline' }],
    touchedPaths(AUDIT_RUNNER),
  );
  assert.equal(result.classification, 'improved');
  assert.deepEqual(result.figures, { basis: 'partial_progress', path: AUDIT_RUNNER, figure: 'lines', previous: 122, current: 88 });
});

test('R4-1: a falling complexity figure is partial progress too', () => {
  const result = applyLedgerPartialProgress(
    HELD_SET_OPS,
    [{ path: 'src/mux.ts', description: 'runMuxRunnerMain is 1690 code lines, complexity 366' }],
    [{ path: 'src/mux.ts', description: 'runMuxRunnerMain is 1690 code lines, complexity 300' }],
    touchedPaths('src/mux.ts'),
  );
  assert.equal(result.classification, 'improved');
  assert.equal(result.figures.figure, 'complexity');
});

test('R4-2 (negative control): an entry whose figures did not change stays held (121 -> 121)', () => {
  const prior = [{ path: AUDIT_RUNNER, description: 'buildCitadelAuditReport is 121 lines (hard limit 50)' }];
  const current = [{ path: AUDIT_RUNNER, description: 'buildCitadelAuditReport is 121 lines (hard limit 50)' }];
  assert.equal(applyLedgerPartialProgress(HELD_SET_OPS, prior, current, touchedPaths(AUDIT_RUNNER)), HELD_SET_OPS);
  assert.equal(applyLedgerPartialProgress(HELD_SET_OPS, undefined, current, touchedPaths(AUDIT_RUNNER)), HELD_SET_OPS, 'no prior snapshot, no progress claim');
});

test('R4-2: partial progress never upgrades a regression, and a shrink on another path does not count', () => {
  const regressed = { classification: 'regressed', figures: { basis: 'set_ops', resolved: 0, new: 2, remaining: 1 } };
  const shrink = [[{ path: 'a.ts', description: 'fn is 200 lines' }], [{ path: 'a.ts', description: 'fn is 90 lines' }]];
  assert.equal(applyLedgerPartialProgress(regressed, ...shrink, touchedPaths('a.ts')), regressed);
  assert.equal(
    applyLedgerPartialProgress(
      HELD_SET_OPS,
      [{ path: 'a.ts', description: 'fn is 200 lines' }],
      [{ path: 'b.ts', description: 'fn is 90 lines' }],
      touchedPaths('a.ts', 'b.ts'),
    ),
    HELD_SET_OPS,
  );
});

// AP-EXT-ITER265-01: the size figure is the judge's ESTIMATE and it jitters on an entry nobody touched — the
// converged session's own fixture reads `dbba02da` as "121 lines" at iterations 0-1 and "122 lines" at 2.
test('AP-EXT-ITER265-01: a figure that falls on a path no commit touched is judge jitter, not progress', () => {
  const prior = [{ path: AUDIT_RUNNER, description: 'buildCitadelAuditReport is 122 lines (hard limit 50)' }];
  const current = [{ path: AUDIT_RUNNER, description: 'buildCitadelAuditReport is 121 lines (hard limit 50)' }];
  assert.equal(applyLedgerPartialProgress(HELD_SET_OPS, prior, current, NOTHING_TOUCHED), HELD_SET_OPS, 'untouched path');
  assert.equal(applyLedgerPartialProgress(HELD_SET_OPS, prior, current, touchedPaths('other.ts')), HELD_SET_OPS, 'a sibling was touched');
  assert.equal(applyLedgerPartialProgress(HELD_SET_OPS, prior, current, () => null), HELD_SET_OPS, 'unmeasurable range');
  assert.equal(
    applyLedgerPartialProgress(HELD_SET_OPS, prior, current, touchedPaths(AUDIT_RUNNER)).classification,
    'improved',
    'control: the same fall on a committed path is progress',
  );
});

test('AP-EXT-ITER265-01: the committed-path range is enumerated at most once, and only when a figure fell', () => {
  let calls = 0;
  const counting = () => { calls += 1; return new Set(['b.ts']); };
  const unchanged = [{ path: 'a.ts', description: 'fn is 90 lines' }];
  applyLedgerPartialProgress(HELD_SET_OPS, unchanged, unchanged, counting);
  assert.equal(calls, 0, 'no fall, no git enumeration');
  const result = applyLedgerPartialProgress(
    HELD_SET_OPS,
    [{ path: 'a.ts', description: 'fn is 200 lines' }, { path: 'b.ts', description: 'fn is 200 lines' }],
    [{ path: 'a.ts', description: 'fn is 190 lines' }, { path: 'b.ts', description: 'fn is 150 lines' }],
    counting,
  );
  assert.equal(calls, 1);
  assert.equal(result.figures.path, 'b.ts', 'an untouched fall is skipped, the touched one still counts');
});

test('R4-1: size figures are read from the judge description the ledger already carries', () => {
  const cases = [
    ['runMuxRunnerMain is ~2202 lines — violating the 50-line hard limit', { lines: 2202 }],
    ['3232-line catch-all module bundles unrelated concerns', { lines: 3232 }],
    ['runMuxRunnerMain is 1,690 code lines, complexity 366', { lines: 1690, complexity: 366 }],
    ['CitadelJsonReport declares both exit_code and exitCode', {}],
    [undefined, {}],
  ];
  for (const [description, expected] of cases) {
    assert.deepEqual(readLedgerSizeFigures(description), expected, `figures for ${JSON.stringify(description)}`);
  }
});

// ---------------------------------------------------------------------------
// AC-N2 (GitHub #24): the entry's size is a structured field. Prose is the legacy fallback only, because
// "the largest number quoted" is right for a ceiling and wrong for a previous size.
// ---------------------------------------------------------------------------

const N2_PATH = 'src/mux.ts';
const n2Progress = (prior, current) =>
  applyLedgerPartialProgress(HELD_SET_OPS, [{ path: N2_PATH, ...prior }], [{ path: N2_PATH, ...current }], touchedPaths(N2_PATH));
const n2JudgeReply = (violations) =>
  parseLlmJudgeOutput(JSON.stringify({ score: violations.length, violations, resolved: [], new: violations.map((v) => v.id), remaining: [] }));

test('N2-1: the judge output contract advertises the structured size figures', () => {
  assert.ok(JUDGE_SYSTEM_PROMPT.includes('"measured": {"lines": <number>, "complexity": <number>}'));
  assert.match(buildJudgePrompt({ goal: 'g', cwd: '/tmp' }), /`measured` is OPTIONAL/);
});

test('N2-1: the size is written at ledger-entry creation, refreshed on reuse, and cleared when a pass omits it', () => {
  const state = createMicroverseState({
    prdPath: '/tmp/n2.md',
    metric: { description: 'violations', validation: 'judge', type: 'llm', timeout_seconds: 60, tolerance: 0, direction: 'lower' },
    stallLimit: 5,
    convergenceTarget: 0,
  });
  const violation = {
    id: 'mux-main', path: N2_PATH, line: 10, severity: 'high',
    description: 'runMuxRunnerMain is 894 lines, was 1690 lines before extraction', measured: { lines: 894, complexity: 173 },
  };
  updateViolationLedger(state, n2JudgeReply([violation]), 1);
  assert.deepEqual(state.violation_ledger[0].measured, { lines: 894, complexity: 173 });

  updateViolationLedger(state, n2JudgeReply([{ ...violation, measured: { lines: 700 } }]), 2);
  assert.equal(state.violation_ledger.length, 1);
  assert.equal(state.violation_ledger[0].first_seen_iter, 1, 'the reuse arm claimed the prior entry');
  assert.deepEqual(state.violation_ledger[0].measured, { lines: 700 });

  const legacy = { ...violation };
  delete legacy.measured;
  updateViolationLedger(state, n2JudgeReply([legacy]), 3);
  assert.equal(state.violation_ledger[0].measured, undefined, 'a stale figure never survives a pass that omitted it');
});

test('N2-2 (control, ceiling): a description quoting a ceiling still yields the entry\'s own size', () => {
  const current = { description: 'fn is 88 lines (hard limit 50)', measured: { lines: 88 } };
  assert.deepEqual(readLedgerEntryFigures(current), { lines: 88 });
  const result = n2Progress({ description: 'fn is 122 lines (hard limit 50)', measured: { lines: 122 } }, current);
  assert.deepEqual(result.figures, { basis: 'partial_progress', path: N2_PATH, figure: 'lines', previous: 122, current: 88 });
});

test('N2-3 (control, history): a description quoting a previous size yields the CURRENT size', () => {
  const rows = [
    [{ description: 'runMuxRunnerMain is 894 lines', measured: { lines: 894 } },
      { description: 'runMuxRunnerMain is 700 lines, was 1690 lines before extraction', measured: { lines: 700 } }, 894, 700],
    [{ description: 'a 200-line function', measured: { lines: 200 } },
      { description: 'extracted 3 helpers from a 200-line function; now 80 lines', measured: { lines: 80 } }, 200, 80],
  ];
  for (const [prior, current, previous, now] of rows) {
    const result = n2Progress(prior, current);
    assert.equal(result.classification, 'improved', current.description);
    assert.deepEqual(result.figures, { basis: 'partial_progress', path: N2_PATH, figure: 'lines', previous, current: now });
  }
  // The two MISS rows from the ticket, read from a structured entry.
  assert.deepEqual(readLedgerEntryFigures({ description: 'runMuxRunnerMain is 894 lines, was 1690 lines before extraction', measured: { lines: 894 } }), { lines: 894 });
  assert.deepEqual(readLedgerEntryFigures({ description: 'extracted 3 helpers from a 200-line function; now 80 lines', measured: { lines: 80 } }), { lines: 80 });
});

test('N2-4: a legacy entry with no structured field keeps today\'s prose reading and never throws', () => {
  const miss = 'runMuxRunnerMain is 894 lines, was 1690 lines before extraction';
  assert.deepEqual(readLedgerEntryFigures({ description: miss }), { lines: 1690 }, 'legacy behaviour is unchanged, MISS row included');
  assert.deepEqual(readLedgerEntryFigures({ description: undefined }), {});
  assert.equal(n2Progress({ description: 'fn is 200 lines' }, { description: 'fn is 90 lines' }).classification, 'improved');
  assert.equal(
    n2Progress({ description: 'fn is 200 lines' }, { description: 'fn is smaller now', measured: { lines: 90 } }).classification,
    'improved',
    'a legacy prior entry compares against a structured current one',
  );
});

test('N2 fail-closed: a garbage structured figure earns no progress credit and never falls back to prose', () => {
  for (const garbage of [{ lines: NaN }, { lines: -5 }, { lines: '80' }, { lines: Infinity }, {}, 'eighty', null, 42]) {
    const result = n2Progress({ description: 'fn is 200 lines' }, { description: 'fn is 90 lines', measured: garbage });
    assert.equal(result, HELD_SET_OPS, `measured=${String(JSON.stringify(garbage))}`);
  }
  const parsed = n2JudgeReply([{ id: 'g', path: N2_PATH, line: 1, severity: 'low', description: 'fn is 90 lines', measured: { lines: '80', complexity: -3 } }]);
  assert.deepEqual(parsed.violations[0].measured, {}, 'the normalizer keeps only valid figures');
  const absent = n2JudgeReply([{ id: 'h', path: N2_PATH, line: 1, severity: 'low', description: 'd' }]);
  assert.equal('measured' in absent.violations[0], false, 'an absent field stays absent, so the entry reads as legacy');
});

function r4ReplayState(fixture, stallLimit) {
  const state = createMicroverseState({
    prdPath: '/tmp/r4-replay.md',
    metric: { description: 'violations', validation: 'judge', type: 'llm', timeout_seconds: 60, tolerance: 0, direction: fixture.direction },
    stallLimit,
    convergenceTarget: fixture.convergence_target,
  });
  state.baseline_score = fixture.baseline_score;
  return state;
}

/** Replays each recorded judge pass through the runner's comparator chain and the real stall counter. */
function replayJudgePasses(fixture, stallLimit, withPartialProgress) {
  let state = r4ReplayState(fixture, stallLimit);
  const classifications = [];
  for (const { iteration, judge } of fixture.iterations) {
    const priorEntries = state.violation_ledger;
    const previousLedger = { resolved: [], new: [], remaining: priorEntries.map((entry) => entry.id) };
    updateViolationLedger(state, { ...judge, shape: 'full' }, iteration);
    const score = judge.violations.length;
    const lastAccepted = [...state.convergence.history].reverse().find((h) => h.action === 'accept');
    const base = compareMetricWithBasis(
      score, lastAccepted ? lastAccepted.score : state.baseline_score, 0, fixture.direction,
      { resolved: judge.resolved, new: judge.new, remaining: judge.remaining }, previousLedger,
    );
    // The fixtures record judge passes, not commit ranges: model a worker that edited every ledger path.
    const everyLedgerPath = () => new Set([...priorEntries, ...state.violation_ledger].map((entry) => entry.path));
    const comparison = withPartialProgress
      ? applyLedgerPartialProgress(base, priorEntries, state.violation_ledger, everyLedgerPath)
      : base;
    const entry = {
      iteration, metric_value: String(score), score, action: comparison.classification === 'regressed' ? 'revert' : 'accept',
      description: comparison.classification, pre_iteration_sha: '', timestamp: '',
    };
    state = recordIteration(state, entry, comparison.classification);
    classifications.push(comparison.classification);
  }
  return { state, classifications };
}

function r4StallCtx(iteration) {
  const logs = [];
  return { ctx: { iteration, log: (msg) => logs.push(msg) }, logs };
}

test('R4-4 replay fidelity: without the partial-progress term the replay reproduces every recorded classification', () => {
  for (const name of ['converged-2026-09-13-d2e834e1.json', 'stalled-2026-09-12-a4d141e1.json']) {
    const fixture = readR4Fixture(name);
    const { classifications } = replayJudgePasses(fixture, 5, false);
    assert.deepEqual(classifications, fixture.iterations.map((i) => i.recorded_classification), name);
  }
});

test('R4-4 replay: the converged run still converges, and its 122 -> 88 split now reads as progress', () => {
  const fixture = readR4Fixture('converged-2026-09-13-d2e834e1.json');
  const { state, classifications } = replayJudgePasses(fixture, fixture.stall_limit, true);
  assert.equal(classifications[3], 'improved', 'iteration 5 (logged held) is measurable partial progress');
  assert.deepEqual(state.convergence.history.map((h) => h.score), fixture.recorded_history_scores, 'scores are unchanged');
  const branch = isConverged(state);
  assert.equal(branch, 'target');
  const { ctx } = r4StallCtx(9);
  assert.equal(convergenceExitReason(branch, state, ctx), fixture.recorded_exit_reason);
});

test('R4-3/R4-4 replay: the stalled run names the ledger entries the loop failed to move', () => {
  const fixture = readR4Fixture('stalled-2026-09-12-a4d141e1.json');
  assert.deepEqual(replayJudgePasses(fixture, 5, true).classifications, ['regressed'], 'its one scored pass is not upgraded');
  const state = r4ReplayState(fixture, fixture.convergence.stall_limit);
  state.convergence.stall_counter = fixture.convergence.stall_counter;
  state.violation_ledger = fixture.violation_ledger;
  const branch = isConverged(state);
  assert.equal(branch, 'stall');
  const { ctx, logs } = r4StallCtx(fixture.exit_iteration);
  assert.equal(convergenceExitReason(branch, state, ctx), fixture.recorded_exit_reason, 'the exit reason and disposition class are unchanged');
  const ledgerIds = fixture.violation_ledger.map((entry) => entry.id);
  assert.deepEqual(findUnmovableLedgerEntries(state, fixture.exit_iteration).map((entry) => entry.id), ledgerIds);
  assert.ok(logs.some((line) => ledgerIds.every((id) => line.includes(id))), 'the log names every unmoved entry');

  const sessionDir = tmpDir('pickle-r4-report-');
  writeFinalReport(sessionDir, state, fixture.recorded_exit_reason, fixture.exit_iteration, 900);
  const memoryDir = path.join(sessionDir, 'memory');
  const report = fs.readFileSync(path.join(memoryDir, fs.readdirSync(memoryDir)[0]), 'utf-8');
  assert.match(report, /\*\*Exit Reason\*\*: stalled_below_target/);
  assert.ok(
    report.includes(`**Unmovable Ledger Entries**: ${ledgerIds.length} (${ledgerIds[0]} `),
    'the final report attributes the stall to the unmoved entries',
  );
  assert.deepEqual(classifyMicroverseDisposition(fixture.recorded_exit_reason), { reportAs: 'non-convergent', exitCode: 1 });
});

test('R4-3 control: a stall over entries first seen inside the stall window is not attributed to them', () => {
  const state = r4ReplayState({ direction: 'lower', convergence_target: 0, baseline_score: 2 }, 3);
  state.convergence.stall_counter = 3;
  state.violation_ledger = [
    { id: 'late', path: 'a.ts', line: 1, severity: 'low', description: 'x', first_seen_iter: 7, last_seen_iter: 8 },
  ];
  assert.deepEqual(findUnmovableLedgerEntries(state, 8), [], 'window starts at iteration 6; an entry first seen at 7 had no full window');
  const { ctx, logs } = r4StallCtx(8);
  assert.equal(convergenceExitReason('stall', state, ctx), 'stalled_below_target');
  assert.equal(logs.length, 0);
});

// AC-J1-2 (B-JUDGESCOPE db605b05): a scope.json-opted-in session whose surface cannot be
// recovered must record a typed reason, never a silent empty array standing in for
// "unrestricted". `deriveJudgeReviewSurface` is the single named producer (AC-J1-1) every
// measureLlm* call site now uses instead of `state.allowed_paths ?? []`.
//
// e562164b: the stale snapshot must sit ON DISK in microverse.json — the only place a producer
// taking `sessionDir` could read it. Held only in memory, a producer that fell back to (or
// unioned in) `microverse.json.allowed_paths` left every case below GREEN (measured).
const STALE_SNAPSHOT_PATH = 'src/stale-snapshot.ts';

function writeStaleSnapshot(sessionDir, metric = TEST_METRIC) {
  const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric, stallLimit: 3 });
  state.allowed_paths = [STALE_SNAPSHOT_PATH];
  writeMicroverseState(sessionDir, state);
  return state;
}

test('deriveJudgeReviewSurface: no scope.json means never opted in — unscoped, not a failure', () => {
  const sessionDir = tmpDir('pickle-mrs-surface-');
  try {
    assert.deepEqual(deriveJudgeReviewSurface(sessionDir), { kind: 'unscoped' });
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('deriveJudgeReviewSurface: scope.json present but allowed_paths empty is a typed derivation failure', () => {
  const sessionDir = tmpDir('pickle-mrs-surface-');
  try {
    fs.writeFileSync(path.join(sessionDir, 'scope.json'), JSON.stringify({
      version: 1, mode: 'branch', base_sha: 'a'.repeat(40), allowed_paths: [],
    }));
    writeStaleSnapshot(sessionDir);
    const result = deriveJudgeReviewSurface(sessionDir);
    assert.equal(result.kind, 'failed');
    assert.equal(result.reason, 'metric_unmeasurable_unrecoverable');
    assert.ok(!('paths' in result), 'a failed derivation structurally carries no paths field — never an empty array standing in for "unrestricted"');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('deriveJudgeReviewSurface: scope.json present but unparseable is also a typed derivation failure', () => {
  const sessionDir = tmpDir('pickle-mrs-surface-');
  try {
    fs.writeFileSync(path.join(sessionDir, 'scope.json'), 'not json');
    const result = deriveJudgeReviewSurface(sessionDir);
    assert.equal(result.kind, 'failed');
    assert.equal(result.reason, 'metric_unmeasurable_unrecoverable');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('deriveJudgeReviewSurface: scope.json + populated allowed_paths derives successfully', () => {
  const sessionDir = tmpDir('pickle-mrs-surface-');
  try {
    fs.writeFileSync(path.join(sessionDir, 'scope.json'), JSON.stringify({
      version: 1, mode: 'branch', base_sha: 'b'.repeat(40), allowed_paths: ['src/foo.ts'],
    }));
    writeStaleSnapshot(sessionDir);
    assert.deepEqual(
      deriveJudgeReviewSurface(sessionDir),
      { kind: 'derived', paths: ['src/foo.ts'], base: 'b'.repeat(40) },
    );
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ac655b46 (AC-J1-8): CHOSEN LIFETIME is per-iteration/live — the derivation reads scope.json
// fresh, never a MicroverseState.allowed_paths snapshot. A stale state.allowed_paths (as a
// phase-setup snapshot would carry after scope.json was refreshed again) must never leak into
// the derived surface; scope.json's OWN current content is authoritative.
test('deriveJudgeReviewSurface: a stale state.allowed_paths snapshot is never consulted — scope.json alone decides', () => {
  const sessionDir = tmpDir('pickle-mrs-surface-');
  try {
    fs.writeFileSync(path.join(sessionDir, 'scope.json'), JSON.stringify({
      version: 1, mode: 'branch', base_sha: 'c'.repeat(40), allowed_paths: ['src/live.ts'],
    }));
    writeStaleSnapshot(sessionDir);
    assert.deepEqual(
      deriveJudgeReviewSurface(sessionDir),
      { kind: 'derived', paths: ['src/live.ts'], base: 'c'.repeat(40) },
      'the derived surface must come from the live scope.json, never from state.allowed_paths',
    );
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('measureLlmIteration: an underivable surface never reaches the judge backend — typed failure, run continues', async () => {
  const sessionDir = tmpDir('pickle-mrs-surface-');
  const workingDir = tmpDir('pickle-mrs-surface-work-');
  try {
    fs.writeFileSync(path.join(sessionDir, 'scope.json'), JSON.stringify({
      version: 1, mode: 'branch', base_sha: 'c'.repeat(40), allowed_paths: [],
    }));
    const state = writeStaleSnapshot(sessionDir, { description: 'quality', validation: 'improve code quality', type: 'llm', timeout_seconds: 60, tolerance: 2, direction: 'higher', judge_model: 'claude-sonnet-4-6' });
    state.status = 'iterating';

    // e562164b: the stubs record and THROW. They used to delegate to the real execFileSync/spawn,
    // so a regressed short-circuit spawned a real judge (11 s, the real `claude` binary) before
    // this assertion could red; `_deps.sleep` is stubbed so the judge retry backoff cannot stall it either.
    let judgeInvoked = false;
    const originalExec = _deps.execFileSync;
    _deps.execFileSync = () => { judgeInvoked = true; throw new Error('judge backend must not be invoked'); };
    const originalSpawn = _deps.spawn;
    _deps.spawn = () => { judgeInvoked = true; throw new Error('judge backend must not be invoked'); };
    const originalSleep = _deps.sleep;
    _deps.sleep = async () => {};
    const originalLogActivity = _deps.logActivity;
    const activity = [];
    _deps.logActivity = (event) => { activity.push(event); };
    try {
      const ctx = { sessionDir, workingDir, iteration: 1, log: () => {} };
      const result = await measureLlmIteration(state, ctx, 'claude');
      assert.equal(result.kind, 'failed', 'the run continues by reporting a typed failure, never a thrown/halting error');
      assert.equal(result.exitReason, 'metric_unmeasurable_unrecoverable');
      assert.equal(judgeInvoked, false, 'no empty fallback reaches the judge — the derivation failure short-circuits before any judge spawn');
      assert.deepEqual(
        activity.map((e) => e.gate_payload),
        [{ phase: 'iteration', derivation: 'judge_review_surface' }],
        'the typed failure is recorded as exactly one iteration-phase surface-derivation event',
      );
    } finally {
      _deps.execFileSync = originalExec;
      _deps.spawn = originalSpawn;
      _deps.sleep = originalSleep;
      _deps.logActivity = originalLogActivity;
    }
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

// e562164b (AC-J5-4): "do NOT add an arm" had no pin. The arms are the classifier verdicts
// `handleNoCommitStall` branches on — every comparison of `noCommitClass` against a string literal,
// and any `case` of a switch over it — read from the parsed source, so a comment naming a verdict
// cannot answer it and a switch or nested rewrite cannot slip past it.
function noCommitClassArms(source) {
  const sf = ts.createSourceFile('microverse-runner.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let fn = null;
  const find = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'handleNoCommitStall') fn = node;
    else ts.forEachChild(node, find);
  };
  find(sf);
  if (!fn?.body) return null;
  const isSubject = (n) => ts.isIdentifier(n) && n.text === 'noCommitClass';
  const arms = [];
  const visit = (node) => {
    if (ts.isBinaryExpression(node)
      && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)) {
      if (isSubject(node.left) && ts.isStringLiteral(node.right)) arms.push(node.right.text);
      if (isSubject(node.right) && ts.isStringLiteral(node.left)) arms.push(node.left.text);
    }
    if (ts.isSwitchStatement(node) && isSubject(node.expression)) {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) arms.push(clause.expression.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return arms.sort();
}

test('AC-J5-4: handleNoCommitStall keeps exactly its two classifier arms — no third arm', () => {
  assert.deepEqual(
    noCommitClassArms(readSrc('bin/microverse-runner.ts')),
    ['amnesiac', 'clean_pass'],
    'a new noCommitClass arm (or a removed one) changes the no-commit disposition set AC-J5-4 froze — stop and report instead',
  );
});

test('AC-J5-4 control: the arm census reads code, not prose, and sees a switch-shaped third arm', () => {
  const shipped = readSrc('bin/microverse-runner.ts');
  const anchor = "  if (noCommitClass === 'amnesiac') {";
  assert.ok(shipped.includes(anchor), 'precondition: the amnesiac arm anchor is present in the shipped source');
  assert.deepEqual(
    noCommitClassArms(shipped.replace(anchor, `  // if (noCommitClass === 'stall') is prose only\n${anchor}`)),
    ['amnesiac', 'clean_pass'],
    'a comment naming a verdict is not an arm',
  );
  assert.deepEqual(
    noCommitClassArms(shipped.replace(anchor, `  switch (noCommitClass) { case 'stall': break; }\n${anchor}`)),
    ['amnesiac', 'clean_pass', 'stall'],
    'a third arm spelled as a switch must be counted',
  );
});

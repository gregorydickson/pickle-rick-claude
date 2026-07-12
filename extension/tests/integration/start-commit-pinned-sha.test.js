// @tier: integration
//
// R-SCPIN (AC-SCPIN-1/2/3): both start_commit heal seams now ADOPT
// state.pinned_sha instead of guessing merge-base(<default-base>, HEAD) via
// the (now-deleted-at-these-seams) computeBaselineStartCommit. This file
// proves:
//  - AC-SCPIN-2: the post-heal invariant `start_commit === pinned_sha`, plus
//    the DISCRIMINATING oracle `rev-list --count start_commit..HEAD ==
//    commits-the-build-made` in the three PRD-mandated cases (exit-0 build /
//    non-zero-with-commits / unborn-HEAD gains first commit). The oracle is
//    discriminating because a merge-base-based baseline is ALSO an ancestor
//    of HEAD and ALSO != HEAD (so those weaker checks pass on the wrong
//    value too) but produces the WRONG commit count.
//  - AC-SCPIN-3: repinFromHeadOnResume runs BEFORE the start_commit heal in
//    applyResumeConfig, proven behaviorally (a stale pinned_sha must not
//    survive into the healed start_commit).
//  - the citadel seam (healPipelineRequiredFields) adopts pinned_sha and
//    preserves the both-unset honest hard-fail.
//
// Resume/oracle cases drive the COMPILED setup.js via real CLI invocation
// against real temp git repos (PICKLE_DATA_ROOT-sandboxed per
// audit-test-isolation). The citadel case drives executeCitadelPhase
// in-process with stubbed remediation deps (mirrors rrh-prdpath-resume.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  executeCitadelPhase,
  __setCitadelRemediationDepsForTests,
} from '../../bin/pipeline-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.resolve(__dirname, '../../bin/setup.js');

function tmpRoot(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir) {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '--no-gpg-sign', '-q', '-m', 'baseline'], { cwd: dir });
}

function gitSha(dir, ref) {
  return execFileSync('git', ['rev-parse', ref], { cwd: dir, encoding: 'utf-8' }).trim();
}

function commitFile(dir, name, message) {
  fs.writeFileSync(path.join(dir, name), message);
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '--no-gpg-sign', '-q', '-m', message], { cwd: dir });
}

function addFeatureBranchCommits(dir, n) {
  execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: dir });
  for (let i = 0; i < n; i++) {
    commitFile(dir, `feature-${i}.txt`, `feature ${i}`);
  }
}

function runSetupAt(cwd, args, dataRoot) {
  const res = spawnSync(process.execPath, [SETUP, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, FORCE_COLOR: '0', PICKLE_DATA_ROOT: dataRoot },
  });
  if (res.status !== 0) {
    throw new Error(`setup exited ${res.status}:\n${res.stdout}\n${res.stderr}`);
  }
  return res;
}

// Bootstrap a paused session from a NEUTRAL (non-git) cwd, then repoint
// state.working_dir at the target repo — mirrors the neutral-cwd bootstrap
// pattern used across the R-PSCG/R-RRH test suites so start_commit/pinned_sha
// start unset, exactly as a real cross-machine or --paused-from-root session
// would.
function bootstrapPausedSessionAt(dataRoot, repoDir, task) {
  const neutralCwd = tmpRoot('pickle-scpin-cwd-');
  const out = execFileSync(process.execPath, [SETUP, '--paused', '--task', task], {
    cwd: neutralCwd,
    encoding: 'utf-8',
    env: { ...process.env, FORCE_COLOR: '0', PICKLE_DATA_ROOT: dataRoot },
  });
  const match = out.match(/SESSION_ROOT=(.+)/);
  if (!match) throw new Error(`SESSION_ROOT not found in setup output:\n${out}`);
  const sessionRoot = match[1].trim();
  const statePath = path.join(sessionRoot, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  state.working_dir = repoDir;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return sessionRoot;
}

function readState(sessionRoot) {
  return JSON.parse(fs.readFileSync(path.join(sessionRoot, 'state.json'), 'utf-8'));
}

function resumeAt(sessionRoot, dataRoot) {
  return runSetupAt(sessionRoot, ['--resume', sessionRoot, '--paused', '--task', ''], dataRoot);
}

// ── AC-SCPIN-2 Case A: exit-0 build — heal fires on a clean repo, THEN the
// session makes its own commits ("the build"). The oracle must count exactly
// those commits, and a merge-base-of-a-pre-existing-feature-branch baseline
// (also an ancestor of HEAD, also != HEAD) would OVER-count them — proving
// the ancestor/!=HEAD checks are non-discriminating while rev-list --count is.
test('R-SCPIN AC-SCPIN-2 case A (exit-0 build): healed start_commit oracle == exact build-commit count', () => {
  const dataRoot = tmpRoot('pickle-scpin-a-data-');
  const repoDir = tmpRoot('pickle-scpin-a-repo-');
  try {
    initGitRepo(repoDir);
    // Pre-existing history unrelated to this session's own work — if the
    // (defective) merge-base guess were still in play, this is the value it
    // would wrongly select as the baseline.
    addFeatureBranchCommits(repoDir, 2);
    const forkPoint = gitSha(repoDir, 'main');

    const sessionRoot = bootstrapPausedSessionAt(dataRoot, repoDir, 'scpin case A');
    const pre = readState(sessionRoot);
    assert.ok(!pre.start_commit, 'neutral-cwd bootstrap must not have captured start_commit');

    resumeAt(sessionRoot, dataRoot);
    const resumed = readState(sessionRoot);
    assert.ok(resumed.start_commit, 'resume healed start_commit');
    assert.equal(resumed.start_commit, resumed.pinned_sha, 'AC-SCPIN-2 invariant: start_commit === pinned_sha');
    const healedBase = resumed.start_commit;

    // Now the session does its own work: 3 "build" commits.
    commitFile(repoDir, 'build-1.txt', 'build 1');
    commitFile(repoDir, 'build-2.txt', 'build 2');
    commitFile(repoDir, 'build-3.txt', 'build 3');
    const head = gitSha(repoDir, 'HEAD');

    const realCount = Number(
      execFileSync('git', ['rev-list', '--count', `${healedBase}..${head}`], { cwd: repoDir, encoding: 'utf-8' }).trim(),
    );
    assert.equal(realCount, 3, 'discriminating oracle: rev-list --count start_commit..HEAD == exact build-commit count');

    // Non-discriminating checks: forkPoint is ALSO an ancestor of HEAD and
    // ALSO != HEAD, yet gives the WRONG count — proving those weaker checks
    // (used and rejected in the PRD) cannot tell a correct baseline from a
    // 97-commit-early one.
    const isAncestor = spawnSync('git', ['merge-base', '--is-ancestor', forkPoint, head], { cwd: repoDir }).status === 0;
    assert.ok(isAncestor, 'forkPoint must ALSO be an ancestor of HEAD (non-discriminating check #1)');
    assert.notEqual(forkPoint, head, 'forkPoint must ALSO differ from HEAD (non-discriminating check #2)');
    const wrongCount = Number(
      execFileSync('git', ['rev-list', '--count', `${forkPoint}..${head}`], { cwd: repoDir, encoding: 'utf-8' }).trim(),
    );
    assert.notEqual(wrongCount, 3, 'the wrong (merge-base) baseline must NOT produce the correct build-commit count');
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// ── AC-SCPIN-2 Case B: non-zero-with-commits — a prior worker pass left real
// commits behind even though its own process outcome was not a clean finish
// (the heal reasons over git state alone, never over any exit-code
// bookkeeping, so this is representative regardless of how the commits were
// produced). Session resumes TWICE (spawns setup.js twice, per the ticket's
// integration-tier mandate): once to heal start_commit, once more after
// additional commits land — proving start_commit, once healed, is NEVER
// re-derived on a later resume even though pinned_sha keeps tracking HEAD.
test('R-SCPIN AC-SCPIN-2 case B (non-zero-with-commits): start_commit survives a second resume unchanged', () => {
  const dataRoot = tmpRoot('pickle-scpin-b-data-');
  const repoDir = tmpRoot('pickle-scpin-b-repo-');
  try {
    initGitRepo(repoDir);
    const sessionRoot = bootstrapPausedSessionAt(dataRoot, repoDir, 'scpin case B');

    resumeAt(sessionRoot, dataRoot);
    const afterFirstResume = readState(sessionRoot);
    const healedBase = afterFirstResume.start_commit;
    assert.ok(healedBase, 'first resume healed start_commit');

    // Simulate a worker pass that committed real work but did not cleanly
    // finish (e.g. a failed gate after a partial commit) — the commit still
    // landed in git regardless of the process outcome.
    commitFile(repoDir, 'partial-work.txt', 'partial work before a non-zero exit');
    const headAfterPartialWork = gitSha(repoDir, 'HEAD');

    // Second setup.js spawn: resume again. repinFromHeadOnResume WILL move
    // pinned_sha forward to the new HEAD (it re-derives unconditionally when
    // it differs) but the no-overwrite gate (`if (!s.start_commit)`) must
    // keep start_commit fixed at the ORIGINAL healed baseline.
    resumeAt(sessionRoot, dataRoot);
    const afterSecondResume = readState(sessionRoot);
    assert.equal(afterSecondResume.start_commit, healedBase, 'start_commit must survive a second resume byte-identical (no-overwrite)');
    assert.equal(afterSecondResume.pinned_sha, headAfterPartialWork, 'pinned_sha DOES track the new HEAD on the second resume');
    assert.notEqual(afterSecondResume.start_commit, afterSecondResume.pinned_sha, 'once healed, start_commit intentionally diverges from a since-moved pinned_sha');

    const buildCount = Number(
      execFileSync('git', ['rev-list', '--count', `${healedBase}..${headAfterPartialWork}`], { cwd: repoDir, encoding: 'utf-8' }).trim(),
    );
    assert.equal(buildCount, 1, 'oracle still counts exactly the one commit made after the healed baseline');
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// ── AC-SCPIN-2 Case C: unborn-HEAD gains first commit. A repo with zero
// commits cannot resolve HEAD at all (repinFromHeadOnResume's getHeadSha
// throws, observedSha stays undefined, pinned_sha stays unset) — the first
// resume must leave start_commit unset (honest, matches tests/setup.test.js's
// non-git-cwd WARN case). Once the repo gains its genesis commit, a SECOND
// resume must heal start_commit to that exact commit, and the oracle must
// read 0 (the genesis commit itself is the baseline, not a "build commit").
test('R-SCPIN AC-SCPIN-2 case C (unborn-HEAD gains first commit): heals only once HEAD is resolvable', () => {
  const dataRoot = tmpRoot('pickle-scpin-c-data-');
  const repoDir = tmpRoot('pickle-scpin-c-repo-');
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir });

    const sessionRoot = bootstrapPausedSessionAt(dataRoot, repoDir, 'scpin case C');

    resumeAt(sessionRoot, dataRoot);
    const afterFirstResume = readState(sessionRoot);
    assert.ok(!afterFirstResume.start_commit, 'unborn HEAD cannot heal start_commit yet');
    assert.ok(!afterFirstResume.pinned_sha, 'unborn HEAD cannot resolve pinned_sha yet');

    commitFile(repoDir, 'genesis.txt', 'genesis');
    const genesisSha = gitSha(repoDir, 'HEAD');

    resumeAt(sessionRoot, dataRoot);
    const afterSecondResume = readState(sessionRoot);
    assert.equal(afterSecondResume.pinned_sha, genesisSha, 'repin resolves pinned_sha once HEAD is born');
    assert.equal(afterSecondResume.start_commit, genesisSha, 'heal adopts the now-resolvable pinned_sha');
    assert.equal(afterSecondResume.start_commit, afterSecondResume.pinned_sha, 'AC-SCPIN-2 invariant holds');

    const buildCount = Number(
      execFileSync('git', ['rev-list', '--count', `${afterSecondResume.start_commit}..HEAD`], { cwd: repoDir, encoding: 'utf-8' }).trim(),
    );
    assert.equal(buildCount, 0, 'the genesis commit IS the baseline — zero build commits past it');
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// ── AC-SCPIN-3: repinFromHeadOnResume runs BEFORE the start_commit heal.
// Proven behaviorally: stamp a STALE pinned_sha (commit A), lose
// start_commit, advance HEAD to commit B while paused, then resume. The
// healed start_commit must equal B (the FRESH re-derived pin), never A (the
// stale pre-repin value) — only possible if repin ran first.
test('R-SCPIN AC-SCPIN-3: repinFromHeadOnResume runs before the start_commit heal (ordering pin)', () => {
  const dataRoot = tmpRoot('pickle-scpin-ord-data-');
  const repoDir = tmpRoot('pickle-scpin-ord-repo-');
  try {
    initGitRepo(repoDir);
    const commitA = gitSha(repoDir, 'HEAD');

    // In-repo bootstrap: createInitialState co-stamps start_commit=A and
    // pinned_sha=A (the normal-path invariant this ticket's contract cites).
    const boot = runSetupAt(repoDir, ['--paused', '--task', 'scpin ordering'], dataRoot);
    const sessionRoot = boot.stdout.match(/SESSION_ROOT=(.+)/)?.[1]?.trim();
    assert.ok(sessionRoot, 'SESSION_ROOT expected from in-repo bootstrap');
    const statePath = path.join(sessionRoot, 'state.json');
    const pre = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(pre.start_commit, commitA);
    assert.equal(pre.pinned_sha, commitA);

    // Simulate loss of start_commit while pinned_sha remains stale at A —
    // the exact precondition the resume heal must handle.
    delete pre.start_commit;
    fs.writeFileSync(statePath, JSON.stringify(pre, null, 2));

    // Advance HEAD to commit B while the session is paused (e.g. an operator
    // manually advancing the working tree, or a prior ticket's commit that
    // landed before the crash that lost start_commit).
    commitFile(repoDir, 'advance.txt', 'advance while paused');
    const commitB = gitSha(repoDir, 'HEAD');
    assert.notEqual(commitA, commitB, 'fixture must actually advance HEAD');

    resumeAt(sessionRoot, dataRoot);

    const post = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(post.pinned_sha, commitB, 'repin refreshed pinned_sha to current HEAD before the heal ran');
    assert.equal(post.start_commit, commitB, 'heal adopted the FRESH pin, proving repin ran first');
    assert.notEqual(post.start_commit, commitA, 'heal must NOT adopt the stale pre-repin pinned_sha');
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// ── Citadel seam (unset at PHASE 2, per the ticket's Test Expectations
// table): adopts pinned_sha when present; both start_commit AND pinned_sha
// unset still hard-fails honestly (no change to that branch).
function writeCitadelState(statePath, overrides = {}) {
  const dir = path.dirname(statePath);
  fs.writeFileSync(statePath, JSON.stringify({
    active: true,
    working_dir: dir,
    step: 'citadel',
    iteration: 1,
    max_iterations: 50,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 'R-SCPIN citadel-seam test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: dir,
    schema_version: 3,
    exit_reason: null,
    start_commit: undefined,
    backend: 'claude',
    activity: [],
    ...overrides,
  }, null, 2));
}

function makeRuntime(dir) {
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

function citadelResult(findings) {
  return {
    schema: '1.0', schema_version: '1.0', prd_path: 'prd.md', diff_range: 'abc1234..HEAD',
    exit_code: findings.length ? 2 : 0, exitCode: findings.length ? 2 : 0,
    header: { pickle_phase_failed: false, pickle_exit_code: 0 },
    sections: {}, findings, decision_required: [], decisions: [],
    summary: { findings: findings.length, critical: 0, high: 0, medium: 0, low: 0, decision_required: 0, decisions: 0, unguarded_trap_doors: 0 },
    markdown: '', json: {},
  };
}

function stubCleanCitadel() {
  __setCitadelRemediationDepsForTests({
    loadSettings: () => ({ cap: 3, remediatorTimeoutMs: 1000 }),
    runCitadelAudit: async () => citadelResult([]),
    spawnGateRemediatorMain: async () => 0,
    spawnRemediator: () => { /* no-op */ },
  });
}

test('R-SCPIN citadel seam: unset start_commit at PHASE 2 adopts pinned_sha', async () => {
  const sessionDir = tmpRoot('pickle-scpin-citadel-adopt-');
  const repoDir = tmpRoot('pickle-scpin-citadel-adopt-repo-');
  try {
    initGitRepo(repoDir);
    const head = gitSha(repoDir, 'HEAD');
    stubCleanCitadel();
    fs.writeFileSync(path.join(sessionDir, 'prd_refined.md'), '# refined prd\n');
    writeCitadelState(path.join(sessionDir, 'state.json'), {
      prd_path: path.join(sessionDir, 'prd_refined.md'),
      pinned_sha: head,
    });

    const runtime = makeRuntime(sessionDir);
    runtime.repoRoot = repoDir;
    runtime.workingDir = repoDir;
    const { exitCode } = await executeCitadelPhase(runtime);

    assert.equal(exitCode, 0, 'citadel proceeds — start_commit healed from pinned_sha');
    const persisted = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(persisted.start_commit, head, 'healed start_commit adopts pinned_sha');
  } finally {
    __setCitadelRemediationDepsForTests(null);
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('R-SCPIN citadel seam: both start_commit AND pinned_sha unset still hard-fails honestly', async () => {
  const sessionDir = tmpRoot('pickle-scpin-citadel-honest-');
  try {
    stubCleanCitadel();
    fs.writeFileSync(path.join(sessionDir, 'prd_refined.md'), '# refined prd\n');
    writeCitadelState(path.join(sessionDir, 'state.json'), {
      prd_path: path.join(sessionDir, 'prd_refined.md'),
    });

    const { exitCode } = await executeCitadelPhase(makeRuntime(sessionDir));

    assert.equal(exitCode, 1, 'both fields unset → honest hard-fail, no masking');
    const persisted = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.ok(!persisted.start_commit, 'start_commit must remain unset on honest fail');
  } finally {
    __setCitadelRemediationDepsForTests(null);
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// @tier: fast
//
// B-RRH D3/D4/D5 (5783cf7f): the paused-refine → `/pickle-pipeline --resume`
// composition must populate state.prd_path so citadel PHASE 2 does not hard-fail
// on a clean build.
//
// D3: the --resume config resolver sets config.prdPath = <SESSION>/prd_refined.md
//     (else prd.md), so the resume stamp in applyResumeConfig fires.
// D4: the citadel preflight in executeCitadelPhase self-heals a missing prd_path
//     (adopts the session PRD when start_commit is set and a PRD exists), and
//     still fails honestly when NEITHER prd file exists.
// D5: the scripted --paused → refine → --resume fixture reaches PHASE 2 CITADEL.
//
// Resume cases drive the COMPILED setup.js via real CLI invocation against a real
// temp git repo, PICKLE_DATA_ROOT-sandboxed (audit-test-isolation contract).
// Citadel cases drive executeCitadelPhase in-process with stubbed remediation deps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  executeCitadelPhase,
  __setCitadelRemediationDepsForTests,
} from '../bin/pipeline-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.resolve(__dirname, '../bin/setup.js');

function tmpRoot(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initRepo(dir) {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '--no-gpg-sign', '-q', '-m', 'baseline'], { cwd: dir });
}

// Bootstrap a paused session from a NEUTRAL cwd (mirror rrh-resume-reattach C5),
// then repoint state.working_dir at the repo.
function bootstrapPausedSession(dataRoot, repoDir) {
  const neutralCwd = tmpRoot('pickle-rrh-d3-cwd-');
  const out = execFileSync(process.execPath, [SETUP, '--paused', '--task', 'rrh-d3'], {
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

function resume(sessionRoot, dataRoot) {
  return execFileSync(process.execPath, [SETUP, '--resume', sessionRoot, '--paused', '--task', ''], {
    cwd: sessionRoot,
    encoding: 'utf-8',
    env: { ...process.env, FORCE_COLOR: '0', PICKLE_DATA_ROOT: dataRoot },
  });
}

function readState(sessionRoot) {
  return JSON.parse(fs.readFileSync(path.join(sessionRoot, 'state.json'), 'utf-8'));
}

// In-process citadel harness (mirror pipeline-runner.test.js).
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
    original_prompt: 'rrh prd_path self-heal test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: dir,
    schema_version: 3,
    exit_reason: null,
    start_commit: 'abc1234',
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

// Like stubCleanCitadel, but records the opts passed to runCitadelAudit so
// tests can assert the healed start_commit feeds diffRange (R-PSCG).
function stubRecordingCitadel() {
  const captured = { audits: [] };
  __setCitadelRemediationDepsForTests({
    loadSettings: () => ({ cap: 3, remediatorTimeoutMs: 1000 }),
    runCitadelAudit: async (opts) => {
      captured.audits.push(opts);
      return citadelResult([]);
    },
    spawnGateRemediatorMain: async () => 0,
    spawnRemediator: () => { /* no-op */ },
  });
  return captured;
}

// Feature branch fixture: fork off main, add commits so merge-base(main, HEAD)
// is the fork point, not HEAD.
function addFeatureBranchCommits(dir, n = 2) {
  execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: dir });
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(path.join(dir, `feature-${i}.txt`), `feature ${i}`);
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '--no-gpg-sign', '-q', '-m', `feature ${i}`], { cwd: dir });
  }
}

function gitSha(dir, ref) {
  return execFileSync('git', ['rev-parse', ref], { cwd: dir, encoding: 'utf-8' }).trim();
}

// ── D3a: paused → write prd_refined.md → resume → prd_path → existing refined file
test('D3a: --resume populates state.prd_path from prd_refined.md (preferred)', () => {
  const dataRoot = tmpRoot('pickle-rrh-d3a-data-');
  const repoDir = tmpRoot('pickle-rrh-d3a-repo-');
  try {
    initRepo(repoDir);
    const sessionRoot = bootstrapPausedSession(dataRoot, repoDir);
    // Refinement output: both prd.md and prd_refined.md present; refined must win.
    fs.writeFileSync(path.join(sessionRoot, 'prd.md'), '# base prd\n');
    fs.writeFileSync(path.join(sessionRoot, 'prd_refined.md'), '# refined prd\n');

    resume(sessionRoot, dataRoot);

    const state = readState(sessionRoot);
    assert.ok(state.prd_path, 'prd_path must be set after resume');
    assert.ok(fs.existsSync(state.prd_path), 'prd_path must point to an existing file');
    assert.equal(path.basename(state.prd_path), 'prd_refined.md', 'prd_refined.md is preferred');
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// ── D3b: only prd.md present (no refined) → prd_path → prd.md
test('D3b: --resume falls back to prd.md when prd_refined.md is absent', () => {
  const dataRoot = tmpRoot('pickle-rrh-d3b-data-');
  const repoDir = tmpRoot('pickle-rrh-d3b-repo-');
  try {
    initRepo(repoDir);
    const sessionRoot = bootstrapPausedSession(dataRoot, repoDir);
    fs.writeFileSync(path.join(sessionRoot, 'prd.md'), '# base prd only\n');

    resume(sessionRoot, dataRoot);

    const state = readState(sessionRoot);
    assert.ok(state.prd_path, 'prd_path must be set after resume');
    assert.ok(fs.existsSync(state.prd_path), 'prd_path must point to an existing file');
    assert.equal(path.basename(state.prd_path), 'prd.md', 'falls back to prd.md');
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// ── D4: prd_path unset, start_commit set, prd_refined.md present → citadel self-heals (NOT exit 1)
test('D4: citadel self-heals missing prd_path by adopting the session PRD', async () => {
  const dir = tmpRoot('pickle-rrh-d4-');
  try {
    stubCleanCitadel();
    fs.writeFileSync(path.join(dir, 'prd_refined.md'), '# refined prd\n');
    writeCitadelState(path.join(dir, 'state.json'), { prd_path: undefined });

    const { exitCode } = await executeCitadelPhase(makeRuntime(dir));

    assert.equal(exitCode, 0, 'self-heal must run citadel (exit 0), not hard-fail');
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'));
    assert.ok(persisted.prd_path, 'prd_path must be adopted into state');
    assert.equal(path.basename(persisted.prd_path), 'prd_refined.md', 'adopted the refined PRD');
  } finally {
    __setCitadelRemediationDepsForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── D4 honesty: prd_path unset, start_commit set, NEITHER prd file → still fails
test('D4 honesty: citadel fails honestly when no session PRD exists', async () => {
  const dir = tmpRoot('pickle-rrh-d4h-');
  try {
    stubCleanCitadel();
    writeCitadelState(path.join(dir, 'state.json'), { prd_path: undefined });

    const { exitCode } = await executeCitadelPhase(makeRuntime(dir));

    assert.equal(exitCode, 1, 'no PRD anywhere → honest hard-fail (no masking)');
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'));
    assert.ok(!persisted.prd_path, 'prd_path must remain unset on honest fail');
  } finally {
    __setCitadelRemediationDepsForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── D5: scripted paused → refine → resume composition reaches PHASE 2 CITADEL
test('D5: paused → refine → resume composition reaches PHASE 2 CITADEL', async () => {
  const dataRoot = tmpRoot('pickle-rrh-d5-data-');
  const repoDir = tmpRoot('pickle-rrh-d5-repo-');
  try {
    initRepo(repoDir);
    const sessionRoot = bootstrapPausedSession(dataRoot, repoDir);
    // The original in-repo launch captured start_commit from repo HEAD; the
    // neutral-cwd bootstrap helper cannot, so stamp it to mirror a real session.
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim();
    const pre = readState(sessionRoot);
    pre.start_commit = headSha;
    fs.writeFileSync(path.join(sessionRoot, 'state.json'), JSON.stringify(pre, null, 2));
    // Refinement step: produce the refined PRD under the session dir.
    fs.writeFileSync(path.join(sessionRoot, 'prd_refined.md'), '# refined prd for D5\n');

    // --resume populates state.prd_path (D3).
    resume(sessionRoot, dataRoot);
    const resumed = readState(sessionRoot);
    assert.ok(resumed.prd_path && fs.existsSync(resumed.prd_path), 'D3 populated prd_path on resume');

    // PHASE 2 CITADEL against the resumed state must enter (preflight passes).
    stubCleanCitadel();
    const runtime = makeRuntime(sessionRoot);
    runtime.repoRoot = repoDir;
    runtime.workingDir = repoDir;
    const { exitCode } = await executeCitadelPhase(runtime);
    assert.equal(exitCode, 0, 'citadel preflight passes — PHASE 2 CITADEL entered on a clean build');
  } finally {
    __setCitadelRemediationDepsForTests(null);
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// ── R-SCPIN AC-1: start_commit unset, pinned_sha set, prd_path set, repoRoot
// is a git repo with commits past a fork point → citadel preflight ADOPTS
// pinned_sha (the co-stamped session-start baseline), NEVER the merge-base
// guess — the discriminating fixture from R-SCPIN §2 AC-SCPIN-1: pinned_sha
// !== merge-base(main, HEAD) here, so a correct heal and the old (defective)
// merge-base heal produce OBSERVABLY DIFFERENT values.
test('R-SCPIN AC-1: citadel self-heals missing start_commit by ADOPTING pinned_sha, not merge-base', async () => {
  const sessionDir = tmpRoot('pickle-scpin-ac1-session-');
  const repoDir = tmpRoot('pickle-scpin-ac1-repo-');
  try {
    initRepo(repoDir);
    const forkPoint = gitSha(repoDir, 'HEAD');
    addFeatureBranchCommits(repoDir, 2);
    const head = gitSha(repoDir, 'HEAD');
    assert.notEqual(forkPoint, head, 'fixture must have commits past the fork point');

    const captured = stubRecordingCitadel();
    fs.writeFileSync(path.join(sessionDir, 'prd_refined.md'), '# refined prd\n');
    writeCitadelState(path.join(sessionDir, 'state.json'), {
      prd_path: path.join(sessionDir, 'prd_refined.md'),
      start_commit: undefined,
      pinned_sha: head,
    });

    const runtime = makeRuntime(sessionDir);
    runtime.repoRoot = repoDir;
    runtime.workingDir = repoDir;
    const { exitCode } = await executeCitadelPhase(runtime);

    assert.equal(exitCode, 0, 'missing start_commit must self-heal, not hard-fail the phase');
    const persisted = readState(sessionDir);
    assert.equal(persisted.start_commit, head, 'healed start_commit adopts pinned_sha (the feature-branch tip)');
    assert.notEqual(persisted.start_commit, forkPoint, 'healed start_commit must NOT fall back to merge-base(main, HEAD)');
    assert.equal(captured.audits.length > 0, true, 'citadel audit must have run');
    assert.equal(
      captured.audits[0].diffRange,
      `${head}..HEAD`,
      'the HEALED sha (not the stale pre-heal snapshot, not a merge-base guess) feeds diffRange',
    );
  } finally {
    __setCitadelRemediationDepsForTests(null);
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// ── R-PSCG honesty mirror: start_commit unset AND repoRoot non-git → honest fail
test('R-PSCG honesty: citadel fails honestly when start_commit cannot be healed (non-git repoRoot)', async () => {
  const sessionDir = tmpRoot('pickle-pscg-honesty-');
  try {
    stubCleanCitadel();
    fs.writeFileSync(path.join(sessionDir, 'prd_refined.md'), '# refined prd\n');
    writeCitadelState(path.join(sessionDir, 'state.json'), {
      prd_path: path.join(sessionDir, 'prd_refined.md'),
      start_commit: undefined,
    });

    // makeRuntime: repoRoot = sessionDir, which is NOT a git repository.
    const { exitCode } = await executeCitadelPhase(makeRuntime(sessionDir));

    assert.equal(exitCode, 1, 'non-git repoRoot → start_commit unhealable → honest hard-fail');
    const persisted = readState(sessionDir);
    assert.ok(!persisted.start_commit, 'start_commit must remain unset on honest fail');
  } finally {
    __setCitadelRemediationDepsForTests(null);
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ── R-SCPIN symmetric double-heal: BOTH fields unset except pinned_sha, PRD
// file + git repo present → both heal (the exact inversion of the old
// `!prdPath && state.start_commit` cross-gate); start_commit heals by
// ADOPTING pinned_sha, not by recomputing a merge-base guess.
test('R-SCPIN double-heal: citadel heals BOTH missing prd_path and missing start_commit (adopts pinned_sha)', async () => {
  const sessionDir = tmpRoot('pickle-scpin-double-session-');
  const repoDir = tmpRoot('pickle-scpin-double-repo-');
  try {
    initRepo(repoDir);
    stubCleanCitadel();
    fs.writeFileSync(path.join(sessionDir, 'prd_refined.md'), '# refined prd\n');
    const head = gitSha(repoDir, 'HEAD');
    writeCitadelState(path.join(sessionDir, 'state.json'), {
      prd_path: undefined,
      start_commit: undefined,
      pinned_sha: head,
    });

    const runtime = makeRuntime(sessionDir);
    runtime.repoRoot = repoDir;
    runtime.workingDir = repoDir;
    const { exitCode } = await executeCitadelPhase(runtime);

    assert.equal(exitCode, 0, 'both fields heal — phase runs');
    const persisted = readState(sessionDir);
    assert.ok(persisted.prd_path, 'prd_path adopted');
    assert.equal(path.basename(persisted.prd_path), 'prd_refined.md');
    assert.ok(persisted.start_commit, 'start_commit healed');
    assert.equal(persisted.start_commit, head, 'start_commit heals by adopting pinned_sha (== HEAD here)');
  } finally {
    __setCitadelRemediationDepsForTests(null);
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// ── R-PSCG AC-4: the D5 composition WITHOUT the hand-stamp — paused non-git cwd →
// refine → resume-in-repo → citadel. The resume recompute (setup.ts) supplies
// start_commit, so citadel enters with NO manual state surgery.
test('R-PSCG AC-4: paused → refine → resume composition works WITHOUT hand-stamping start_commit', async () => {
  const dataRoot = tmpRoot('pickle-pscg-ac4-data-');
  const repoDir = tmpRoot('pickle-pscg-ac4-repo-');
  try {
    initRepo(repoDir);
    const sessionRoot = bootstrapPausedSession(dataRoot, repoDir);
    const pre = readState(sessionRoot);
    assert.ok(!pre.start_commit, 'neutral-cwd bootstrap must NOT have captured start_commit');
    fs.writeFileSync(path.join(sessionRoot, 'prd_refined.md'), '# refined prd for AC-4\n');

    resume(sessionRoot, dataRoot);
    const resumed = readState(sessionRoot);
    assert.ok(resumed.prd_path && fs.existsSync(resumed.prd_path), 'D3 populated prd_path on resume');
    assert.ok(resumed.start_commit, 'resume recomputed start_commit from the git working_dir');

    stubCleanCitadel();
    const runtime = makeRuntime(sessionRoot);
    runtime.repoRoot = repoDir;
    runtime.workingDir = repoDir;
    const { exitCode } = await executeCitadelPhase(runtime);
    assert.equal(exitCode, 0, 'citadel preflight passes with no hand-stamped start_commit');
  } finally {
    __setCitadelRemediationDepsForTests(null);
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// @tier: integration
// R-MACB (B-1SEAM WS-3) — the microverse worker-timeout auto-rescue
// (`autoRescueDirtyTree`) must NEVER sweep foreign (bystander) dirty paths into
// the rescue commit. Reproduces incident commit 6272304fc (session
// 2026-06-30-456d1d79): a pre-existing untracked docs/*.md belonging to ANOTHER
// session was committed onto the pipeline's feature branch because the rescue
// called the staging helper with EMPTY excludes. Post-fix the rescue routes
// through the shared dirty-tree salvage seam: owned paths (docs/prds excluded,
// scope-filtered) are staged one-by-one, the un-attributable remainder is
// anchored to refs/pickle/salvage/<session>, and a foreign-dirt-only tree
// produces NO commit (falls to the stall path).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { autoRescueDirtyTree } from '../bin/microverse-runner.js';

function makeTmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore', timeout: 30_000 });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, timeout: 30_000 });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, timeout: 30_000 });
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'baseline\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore', timeout: 30_000 });
  execFileSync('git', ['commit', '-q', '-m', 'baseline', '--no-gpg-sign'], { cwd: dir, stdio: 'ignore', timeout: 30_000 });
}

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 30_000 }).trim();
}

function makeCtx(workingDir, sessionDir) {
  const logs = [];
  return {
    ctx: {
      workingDir,
      sessionDir,
      log: (msg) => logs.push(msg),
      preIterSha: git(workingDir, ['rev-parse', 'HEAD']),
      postIterSha: git(workingDir, ['rev-parse', 'HEAD']),
    },
    logs,
  };
}

test('R-MACB: rescue commits ONLY session-owned dirt — foreign docs/prds untracked files survive un-staged and are anchored to the salvage ref', () => {
  const workingDir = makeTmp('macb-rescue-');
  const sessionDir = makeTmp('macb-session-');
  try {
    initGitRepo(workingDir);
    // Pre-existing FOREIGN untracked files from another session's effort
    // (docs/prds are launch-guard-exempt, so they survive into the run).
    fs.mkdirSync(path.join(workingDir, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(workingDir, 'prds'), { recursive: true });
    fs.writeFileSync(path.join(workingDir, 'docs', 'prd-foreign.md'), 'another session WIP\n');
    fs.writeFileSync(path.join(workingDir, 'prds', 'other-session.md'), 'another session PRD\n');
    // Worker dirt: a new source file + a tracked-file modification.
    fs.mkdirSync(path.join(workingDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workingDir, 'src', 'thing.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(workingDir, 'tracked.txt'), 'worker edit\n');

    const preSha = git(workingDir, ['rev-parse', 'HEAD']);
    const { ctx } = makeCtx(workingDir, sessionDir);
    autoRescueDirtyTree(ctx);

    // (a) a rescue commit landed and contains ONLY the worker's paths.
    const headSha = git(workingDir, ['rev-parse', 'HEAD']);
    assert.notEqual(headSha, preSha, 'rescue should auto-commit the owned worker dirt');
    assert.equal(ctx.postIterSha, headSha, 'ctx.postIterSha should advance to the rescue commit');
    const committed = git(workingDir, ['show', '--name-only', '--format=oneline', 'HEAD']);
    assert.match(committed, /src\/thing\.ts/, 'owned new source file must be committed');
    assert.match(committed, /tracked\.txt/, 'owned tracked modification must be committed');
    assert.doesNotMatch(committed, /docs\/prd-foreign\.md/, 'foreign docs untracked file must NOT be swept into the rescue commit');
    assert.doesNotMatch(committed, /prds\/other-session\.md/, 'foreign prds untracked file must NOT be swept into the rescue commit');

    // TIER-3.10 (51392b95): the rescue commit message must state only what
    // this branch observes — no commits were produced and the (owned) tree
    // was dirty — never an unobserved cause like "worker timed out".
    const commitMessage = git(workingDir, ['log', '-1', '--format=%s', 'HEAD']);
    assert.match(
      commitMessage,
      /^microverse: auto-commit \(no commits produced.*dirty tree detected\)$/,
      'rescue commit message must state the observed condition (no commits, dirty tree)',
    );
    assert.doesNotMatch(
      commitMessage,
      /timed out/,
      'rescue commit message must NOT assert a timeout this branch never measures',
    );

    // (b) foreign files remain present and untracked in the worktree.
    assert.ok(fs.existsSync(path.join(workingDir, 'docs', 'prd-foreign.md')), 'foreign file must survive on disk');
    const porcelain = git(workingDir, ['status', '--porcelain', '-uall']);
    assert.match(porcelain, /\?\? docs\/prd-foreign\.md/, 'foreign docs file must stay untracked');
    assert.match(porcelain, /\?\? prds\/other-session\.md/, 'foreign prds file must stay untracked');

    // (c) the salvage ref anchors a recoverable copy of the foreign remainder.
    const ref = `refs/pickle/salvage/${path.basename(sessionDir)}`;
    const refSha = git(workingDir, ['rev-parse', ref]);
    assert.match(refSha, /^[0-9a-f]{40}$/, 'salvage ref must exist');
    const refTree = git(workingDir, ['ls-tree', '-r', '--name-only', ref]);
    assert.match(refTree, /docs\/prd-foreign\.md/, 'salvage ref tree must contain the foreign docs file');
    assert.match(refTree, /prds\/other-session\.md/, 'salvage ref tree must contain the foreign prds file');
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-MACB: foreign-dirt-only tree produces NO rescue commit — anchors the salvage ref and falls to the stall path', () => {
  const workingDir = makeTmp('macb-foreign-only-');
  const sessionDir = makeTmp('macb-session-');
  try {
    initGitRepo(workingDir);
    fs.mkdirSync(path.join(workingDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(workingDir, 'docs', 'prd-foreign.md'), 'another session WIP\n');

    const preSha = git(workingDir, ['rev-parse', 'HEAD']);
    const { ctx, logs } = makeCtx(workingDir, sessionDir);
    autoRescueDirtyTree(ctx);

    assert.equal(git(workingDir, ['rev-parse', 'HEAD']), preSha, 'no commit may be created for foreign-only dirt');
    assert.equal(ctx.postIterSha, preSha, 'ctx.postIterSha must not advance');
    const porcelain = git(workingDir, ['status', '--porcelain', '-uall']);
    assert.match(porcelain, /\?\? docs\/prd-foreign\.md/, 'foreign file must stay untracked');

    const ref = `refs/pickle/salvage/${path.basename(sessionDir)}`;
    const refSha = git(workingDir, ['rev-parse', ref]);
    assert.match(refSha, /^[0-9a-f]{40}$/, 'salvage ref must anchor the foreign remainder');
    assert.ok(
      logs.some((l) => /treating as stall/.test(l)),
      `rescue must log the stall disposition (got: ${JSON.stringify(logs)})`,
    );
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-MACB: scoped session — rescue stages only in-scope owned paths; out-of-scope worker dirt is anchored, not committed', () => {
  const workingDir = makeTmp('macb-scoped-');
  const sessionDir = makeTmp('macb-session-');
  try {
    initGitRepo(workingDir);
    fs.writeFileSync(path.join(sessionDir, 'scope.json'), JSON.stringify({ allowed_paths: ['src/'] }));
    fs.mkdirSync(path.join(workingDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(workingDir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(workingDir, 'src', 'in-scope.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(workingDir, 'lib', 'out-of-scope.ts'), 'export const b = 2;\n');

    const preSha = git(workingDir, ['rev-parse', 'HEAD']);
    const { ctx } = makeCtx(workingDir, sessionDir);
    autoRescueDirtyTree(ctx);

    assert.notEqual(git(workingDir, ['rev-parse', 'HEAD']), preSha, 'in-scope dirt should be rescue-committed');
    const committed = git(workingDir, ['show', '--name-only', '--format=oneline', 'HEAD']);
    assert.match(committed, /src\/in-scope\.ts/, 'in-scope path must be committed');
    assert.doesNotMatch(committed, /lib\/out-of-scope\.ts/, 'out-of-scope path must NOT be committed');
    const porcelain = git(workingDir, ['status', '--porcelain', '-uall']);
    assert.match(porcelain, /\?\? lib\/out-of-scope\.ts/, 'out-of-scope path must stay untracked');
    const refTree = git(workingDir, ['ls-tree', '-r', '--name-only', `refs/pickle/salvage/${path.basename(sessionDir)}`]);
    assert.match(refTree, /lib\/out-of-scope\.ts/, 'out-of-scope remainder must be recoverable from the salvage ref');
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

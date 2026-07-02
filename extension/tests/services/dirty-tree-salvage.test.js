// @tier: integration
// B-1SEAM WS-3 (R-MACB) — unit tests for the shared dirty-tree salvage seam
// (services/dirty-tree-salvage.ts): stashUnattributableRemainder (moved
// verbatim from mux-runner, B-PCOMP #b736337f), salvageDirtyTree (invariant
// enforcer: foreign dirt ⇒ ref anchored, owned-only stage list), and
// stageOwnedPaths (per-path `git add --`, handles deletions).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  stashUnattributableRemainder,
  salvageDirtyTree,
  stageOwnedPaths,
} from '../../services/dirty-tree-salvage.js';

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

test('stashUnattributableRemainder: clean tree → null, no salvage ref created', () => {
  const workingDir = makeTmp('dts-clean-');
  const sessionDir = makeTmp('dts-session-');
  try {
    initGitRepo(workingDir);
    const ret = stashUnattributableRemainder(workingDir, sessionDir, () => {});
    assert.equal(ret, null, 'clean tree must return null');
    assert.throws(
      () => git(workingDir, ['rev-parse', '--verify', `refs/pickle/salvage/${path.basename(sessionDir)}`]),
      'no ref may be created for a clean tree',
    );
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('stashUnattributableRemainder: anchors the WHOLE dirty tree (tracked + untracked) without mutating worktree or index', () => {
  const workingDir = makeTmp('dts-anchor-');
  const sessionDir = makeTmp('dts-session-');
  try {
    initGitRepo(workingDir);
    fs.writeFileSync(path.join(workingDir, 'tracked.txt'), 'modified\n');
    fs.writeFileSync(path.join(workingDir, 'brand-new.txt'), 'untracked\n');
    const porcelainBefore = git(workingDir, ['status', '--porcelain']);
    const stagedBefore = git(workingDir, ['diff', '--cached', '--name-only']);

    const ref = stashUnattributableRemainder(workingDir, sessionDir, () => {});
    assert.equal(ref, `refs/pickle/salvage/${path.basename(sessionDir)}`, 'must return the anchored ref name');

    const refTree = git(workingDir, ['ls-tree', '-r', '--name-only', ref]);
    assert.match(refTree, /tracked\.txt/, 'ref must contain the tracked modification');
    assert.match(refTree, /brand-new\.txt/, 'ref must contain the untracked file');
    assert.equal(git(workingDir, ['status', '--porcelain']), porcelainBefore, 'worktree must be untouched');
    assert.equal(git(workingDir, ['diff', '--cached', '--name-only']), stagedBefore, 'real index must be untouched');
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('salvageDirtyTree: foreign > 0 → ref anchored and stagePaths === owned', () => {
  const workingDir = makeTmp('dts-salvage-');
  const sessionDir = makeTmp('dts-session-');
  try {
    initGitRepo(workingDir);
    fs.writeFileSync(path.join(workingDir, 'owned.txt'), 'mine\n');
    fs.writeFileSync(path.join(workingDir, 'foreign.txt'), 'bystander\n');

    const plan = salvageDirtyTree({
      workingDir,
      sessionDir,
      owned: ['owned.txt'],
      foreign: ['foreign.txt'],
      log: () => {},
    });
    assert.deepEqual(plan.stagePaths, ['owned.txt'], 'stagePaths must be exactly the owned set');
    assert.equal(plan.salvageRef, `refs/pickle/salvage/${path.basename(sessionDir)}`);
    const refTree = git(workingDir, ['ls-tree', '-r', '--name-only', plan.salvageRef]);
    assert.match(refTree, /foreign\.txt/, 'foreign remainder must be recoverable from the ref');
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('salvageDirtyTree: foreign = 0 → salvageRef null, no ref created, owned passes through', () => {
  const workingDir = makeTmp('dts-noforeign-');
  const sessionDir = makeTmp('dts-session-');
  try {
    initGitRepo(workingDir);
    fs.writeFileSync(path.join(workingDir, 'owned.txt'), 'mine\n');

    const plan = salvageDirtyTree({ workingDir, sessionDir, owned: ['owned.txt'], foreign: [], log: () => {} });
    assert.deepEqual(plan.stagePaths, ['owned.txt']);
    assert.equal(plan.salvageRef, null, 'no foreign dirt → no ref');
    assert.throws(
      () => git(workingDir, ['rev-parse', '--verify', `refs/pickle/salvage/${path.basename(sessionDir)}`]),
      'no ref may be created when nothing is foreign',
    );
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('stageOwnedPaths: stages a DELETED tracked file and leaves unlisted dirty paths unstaged', () => {
  const workingDir = makeTmp('dts-stage-');
  try {
    initGitRepo(workingDir);
    fs.writeFileSync(path.join(workingDir, 'doomed.txt'), 'to be deleted\n');
    execFileSync('git', ['add', '-A'], { cwd: workingDir, stdio: 'ignore', timeout: 30_000 });
    execFileSync('git', ['commit', '-q', '-m', 'add doomed', '--no-gpg-sign'], { cwd: workingDir, stdio: 'ignore', timeout: 30_000 });

    fs.rmSync(path.join(workingDir, 'doomed.txt'));
    fs.writeFileSync(path.join(workingDir, 'staged-new.txt'), 'new\n');
    fs.writeFileSync(path.join(workingDir, 'unlisted.txt'), 'not staged\n');

    stageOwnedPaths(workingDir, ['doomed.txt', 'staged-new.txt']);

    const staged = git(workingDir, ['diff', '--cached', '--name-status']);
    assert.match(staged, /^D\tdoomed\.txt$/m, 'deletion must be staged');
    assert.match(staged, /^A\tstaged-new\.txt$/m, 'listed new file must be staged');
    assert.doesNotMatch(staged, /unlisted\.txt/, 'unlisted dirty path must not be staged');
    const porcelain = git(workingDir, ['status', '--porcelain']);
    assert.match(porcelain, /\?\? unlisted\.txt/, 'unlisted path must remain untracked');
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

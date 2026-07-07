// @tier: fast
// R-MPGD-A: preflightAutoCommit / autoRescueDirtyTree must detect git-work-tree
// membership via `git rev-parse --is-inside-work-tree`, not a naive
// `existsSync(path.join(dir, '.git'))` direct-child check. The naive check
// false-negatived for monorepo subdirs (git root one level up) — this proves
// the fixed behavior: a dirty subdir inside a repo auto-commits, and only the
// in-scope subdir path lands in the commit (not sibling-package dirt).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { preflightAutoCommit, autoRescueDirtyTree } from '../bin/microverse-runner.js';

function makeTmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore', timeout: 30_000 });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, timeout: 30_000 });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, timeout: 30_000 });
}

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 30_000 }).trim();
}

function commitAll(dir, message) {
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore', timeout: 30_000 });
  execFileSync('git', ['commit', '-q', '-m', message, '--no-gpg-sign'], { cwd: dir, stdio: 'ignore', timeout: 30_000 });
}

test('AC-MPGD-A3: preflightAutoCommit auto-commits a dirty monorepo subdir with no own .git, committing only the in-scope subdir file', () => {
  const repoRoot = makeTmp('mpgd-preflight-repo-');
  try {
    initGitRepo(repoRoot);
    const apiDir = path.join(repoRoot, 'packages', 'api');
    const otherDir = path.join(repoRoot, 'packages', 'other');
    fs.mkdirSync(apiDir, { recursive: true });
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(apiDir, 'index.ts'), 'export const v = 1;\n');
    fs.writeFileSync(path.join(otherDir, 'index.ts'), 'export const v = 1;\n');
    commitAll(repoRoot, 'baseline');

    // subdir has no own .git — the naive existsSync check would false-negative here.
    assert.ok(!fs.existsSync(path.join(apiDir, '.git')), 'apiDir must not have its own .git');

    // Dirty the in-scope subdir file only.
    fs.writeFileSync(path.join(apiDir, 'index.ts'), 'export const v = 2;\n');

    const logs = [];
    assert.doesNotThrow(
      () => preflightAutoCommit(apiDir, (msg) => logs.push(msg)),
      'a dirty monorepo subdir with a valid parent repo must not abort',
    );

    const headMsg = git(apiDir, ['log', '-1', '--format=%s']);
    assert.equal(headMsg, 'microverse: auto-commit dirty tree before start', 'subdir dirt must be auto-committed');

    const committedFiles = git(apiDir, ['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean);
    assert.ok(
      committedFiles.some((f) => f.endsWith('packages/api/index.ts')),
      `committed files must include the in-scope subdir file; got: ${JSON.stringify(committedFiles)}`,
    );
    assert.ok(
      !committedFiles.some((f) => f.endsWith('packages/other/index.ts')),
      `committed files must NOT include the sibling-package file; got: ${JSON.stringify(committedFiles)}`,
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('AC-MPGD-A3: preflightAutoCommit still throws on a genuine non-git directory', () => {
  const nonGitDir = makeTmp('mpgd-preflight-nongit-');
  try {
    fs.writeFileSync(path.join(nonGitDir, 'dirty.txt'), 'content\n');
    assert.throws(
      () => preflightAutoCommit(nonGitDir, () => {}),
      'a genuinely non-git directory must still throw (unchanged behavior)',
    );
  } finally {
    fs.rmSync(nonGitDir, { recursive: true, force: true });
  }
});

test('AC-MPGD-A4: autoRescueDirtyTree salvages a dirty monorepo subdir with no own .git, no "not a git repository" skip', () => {
  const repoRoot = makeTmp('mpgd-rescue-repo-');
  const sessionDir = makeTmp('mpgd-rescue-session-');
  try {
    initGitRepo(repoRoot);
    const apiDir = path.join(repoRoot, 'packages', 'api');
    const otherDir = path.join(repoRoot, 'packages', 'other');
    fs.mkdirSync(apiDir, { recursive: true });
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(apiDir, 'index.ts'), 'export const v = 1;\n');
    fs.writeFileSync(path.join(otherDir, 'index.ts'), 'export const v = 1;\n');
    commitAll(repoRoot, 'baseline');

    assert.ok(!fs.existsSync(path.join(apiDir, '.git')), 'apiDir must not have its own .git');

    fs.writeFileSync(path.join(apiDir, 'index.ts'), 'export const v = 2;\n');

    const logs = [];
    const preIterSha = git(apiDir, ['rev-parse', 'HEAD']);
    const ctx = {
      workingDir: apiDir,
      sessionDir,
      log: (msg) => logs.push(msg),
      preIterSha,
      postIterSha: preIterSha,
    };

    autoRescueDirtyTree(ctx);

    assert.ok(
      !logs.some((l) => l.includes('not a git repository')),
      `must not skip with 'not a git repository'; logs: ${JSON.stringify(logs)}`,
    );
    assert.notEqual(ctx.postIterSha, preIterSha, 'postIterSha must advance to the new rescue commit');

    const committedFiles = git(apiDir, ['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean);
    assert.ok(
      committedFiles.some((f) => f.endsWith('packages/api/index.ts')),
      `rescue commit must include the owned subdir path; got: ${JSON.stringify(committedFiles)}`,
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-MPGD-A5: isInsideWorkTree passes GIT_REV_PARSE_TIMEOUT_MS as the git spawn timeout', () => {
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'bin', 'microverse-runner.ts'), 'utf8');
  const fnMatch = src.match(/function isInsideWorkTree\(dir: string\): boolean \{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'isInsideWorkTree function body must be found in source');
  assert.ok(
    /timeout:\s*GIT_REV_PARSE_TIMEOUT_MS/.test(fnMatch[0]),
    'isInsideWorkTree must pass GIT_REV_PARSE_TIMEOUT_MS as the timeout option',
  );
});

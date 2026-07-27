// @tier: integration
//
// B-GITATTR WS-1 (AC-GA-1, AC-GA-2, AC-GA-4, AC-GA-5): proves the materialized
// hooks dir forwards to every pre-existing hook (both still execute, a
// non-zero pre-existing hook still aborts the commit) and that an
// unresolvable pre-existing hooks dir materializes nothing while leaving a
// plain commit free to succeed trailer-less. See
// tests/integration/start-commit-pinned-sha.test.js for the established
// tmpRoot/initGitRepo/execFileSync pattern this file follows.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { materializeTrailerHooks } from '../../services/git-trailer-hooks.js';

// Hang guard, not a perf assertion (extension/CLAUDE.md serial-manifest hygiene) — this
// file is already serialized via tests/integration/.serial-tests.json.
const GIT_TIMEOUT_MS = 15_000;

function git(args, dir, env) {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    env: env ?? process.env,
  });
}

// Every tmpRoot is registered and reclaimed, per the ticket's isolation expectation ("each test's
// temp repo created AND removed"). Registration happens HERE rather than at the call sites because
// the managed-hooks callers do `path.join(tmpRoot(...), 'hooks')` and discard the parent path — the
// only place that still holds it is this function.
const TMP_ROOTS = new Set();

function tmpRoot(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  TMP_ROOTS.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of TMP_ROOTS) fs.rmSync(dir, { recursive: true, force: true });
  TMP_ROOTS.clear();
});

function initGitRepo(dir) {
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@test.local'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed');
  git(['add', '-A'], dir);
  git(['commit', '--no-gpg-sign', '-q', '-m', 'baseline'], dir);
}

function hooksPathEnv(managedDir, extra) {
  return {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: managedDir,
    ...extra,
  };
}

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, contents);
  fs.chmodSync(filePath, 0o755);
}

test('gitattr hook forwarding', async (t) => {
  await t.test('a pre-existing pre-commit AND prepare-commit-msg both still run, trailer still appended', () => {
    const repoRoot = tmpRoot('gitattr-fwd-');
    initGitRepo(repoRoot);

    const realHooksDir = path.join(repoRoot, '.git', 'hooks');
    writeExecutable(
      path.join(realHooksDir, 'pre-commit'),
      `#!/bin/sh\ntouch "${path.join(repoRoot, 'pre-commit-ran')}"\nexit 0\n`,
    );
    writeExecutable(
      path.join(realHooksDir, 'prepare-commit-msg'),
      `#!/bin/sh\ntouch "${path.join(repoRoot, 'prepare-commit-msg-ran')}"\nexit 0\n`,
    );

    const managedDir = path.join(tmpRoot('gitattr-managed-fwd-'), 'hooks');
    const materialized = materializeTrailerHooks({ repoRoot, managedDir });
    assert.equal(materialized.ok, true);

    fs.writeFileSync(path.join(repoRoot, 'two.txt'), 'two');
    git(['add', '-A'], repoRoot);
    const env = hooksPathEnv(managedDir, { PICKLE_TICKET_ID: 'd9e0f1a2' });
    git(['commit', '--no-gpg-sign', '-q', '-m', 'chore: forwarding smoke'], repoRoot, env);

    assert.equal(fs.existsSync(path.join(repoRoot, 'pre-commit-ran')), true);
    assert.equal(fs.existsSync(path.join(repoRoot, 'prepare-commit-msg-ran')), true);
    const trailer = git(
      ['log', '-1', "--format=%(trailers:key=Pickle-Ticket,valueonly)"],
      repoRoot,
    ).trim();
    assert.equal(trailer, 'd9e0f1a2');
  });

  await t.test('a non-zero pre-existing hook aborts the commit', () => {
    const repoRoot = tmpRoot('gitattr-fwd-fail-');
    initGitRepo(repoRoot);
    const beforeSha = git(['rev-parse', 'HEAD'], repoRoot).trim();

    const realHooksDir = path.join(repoRoot, '.git', 'hooks');
    writeExecutable(path.join(realHooksDir, 'pre-commit'), '#!/bin/sh\nexit 1\n');

    const managedDir = path.join(tmpRoot('gitattr-managed-fwd-fail-'), 'hooks');
    const materialized = materializeTrailerHooks({ repoRoot, managedDir });
    assert.equal(materialized.ok, true);

    fs.writeFileSync(path.join(repoRoot, 'two.txt'), 'two');
    git(['add', '-A'], repoRoot);
    const env = hooksPathEnv(managedDir, { PICKLE_TICKET_ID: 'e1f2a3b4' });

    assert.throws(() => {
      git(['commit', '--no-gpg-sign', '-q', '-m', 'chore: should abort'], repoRoot, env);
    });
    assert.equal(git(['rev-parse', 'HEAD'], repoRoot).trim(), beforeSha);
  });

  await t.test('an unresolvable pre-existing hooks dir materializes nothing; commit still succeeds trailer-less', () => {
    const notARepo = tmpRoot('gitattr-not-a-repo-');
    const managedDir = path.join(tmpRoot('gitattr-managed-unresolvable-'), 'hooks');

    const materialized = materializeTrailerHooks({ repoRoot: notARepo, managedDir });
    assert.equal(materialized.ok, false);
    assert.equal(fs.existsSync(managedDir), false);

    const repoRoot = tmpRoot('gitattr-plain-commit-');
    initGitRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'two.txt'), 'two');
    git(['add', '-A'], repoRoot);
    git(['commit', '--no-gpg-sign', '-q', '-m', 'chore: plain commit, no hooks wired'], repoRoot);

    const trailer = git(
      ['log', '-1', "--format=%(trailers:key=Pickle-Ticket,valueonly)"],
      repoRoot,
    ).trim();
    assert.equal(trailer, '');
  });
});

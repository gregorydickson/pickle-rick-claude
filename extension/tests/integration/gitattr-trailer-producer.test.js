// @tier: integration
//
// B-GITATTR WS-1 (AC-GA-1, AC-GA-2, AC-GA-4, AC-GA-5): proves the materialized
// prepare-commit-msg hook stamps `Pickle-Ticket: <id>` from `PICKLE_TICKET_ID`,
// idempotently, and that pointing `core.hooksPath` at the managed dir via an
// ephemeral GIT_CONFIG_* env override never mutates the target repo's own
// git config. Drives real `git commit` against real temp repos — see
// tests/integration/start-commit-pinned-sha.test.js for the established
// tmpRoot/initGitRepo/execFileSync pattern this file follows.
import { test } from 'node:test';
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

function tmpRoot(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

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

function trailerValue(dir) {
  return git(
    ['log', '-1', "--format=%(trailers:key=Pickle-Ticket,valueonly)"],
    dir,
  ).trim();
}

test('gitattr trailer producer', async (t) => {
  await t.test('commit with PICKLE_TICKET_ID set yields exactly one Pickle-Ticket trailer', () => {
    const repoRoot = tmpRoot('gitattr-trailer-');
    const managedDir = path.join(tmpRoot('gitattr-managed-'), 'hooks');
    initGitRepo(repoRoot);

    const materialized = materializeTrailerHooks({ repoRoot, managedDir });
    assert.equal(materialized.ok, true);

    fs.writeFileSync(path.join(repoRoot, 'two.txt'), 'two');
    git(['add', '-A'], repoRoot);
    const env = hooksPathEnv(managedDir, { PICKLE_TICKET_ID: 'a3c75c96' });
    git(['commit', '--no-gpg-sign', '-q', '-m', 'audit: [HIGH] cross-ref — no hash'], repoRoot, env);

    assert.equal(trailerValue(repoRoot), 'a3c75c96');
  });

  await t.test('a message already carrying the trailer stays at trailer count 1', () => {
    const repoRoot = tmpRoot('gitattr-trailer-idem-');
    const managedDir = path.join(tmpRoot('gitattr-managed-idem-'), 'hooks');
    initGitRepo(repoRoot);

    const materialized = materializeTrailerHooks({ repoRoot, managedDir });
    assert.equal(materialized.ok, true);

    fs.writeFileSync(path.join(repoRoot, 'two.txt'), 'two');
    git(['add', '-A'], repoRoot);
    const env = hooksPathEnv(managedDir, { PICKLE_TICKET_ID: 'b1d2e3f4' });
    git(
      ['commit', '--no-gpg-sign', '-q', '-m', 'fix: pre-stamped\n\nPickle-Ticket: b1d2e3f4'],
      repoRoot,
      env,
    );

    const body = git(['log', '-1', '--format=%B'], repoRoot);
    const occurrences = (body.match(/^Pickle-Ticket:/gm) ?? []).length;
    assert.equal(occurrences, 1);
    assert.equal(trailerValue(repoRoot), 'b1d2e3f4');
  });

  await t.test('no PICKLE_TICKET_ID leaves the message byte-identical and trailer-less', () => {
    const repoRoot = tmpRoot('gitattr-trailer-noenv-');
    const managedDir = path.join(tmpRoot('gitattr-managed-noenv-'), 'hooks');
    initGitRepo(repoRoot);

    const materialized = materializeTrailerHooks({ repoRoot, managedDir });
    assert.equal(materialized.ok, true);

    fs.writeFileSync(path.join(repoRoot, 'two.txt'), 'two');
    git(['add', '-A'], repoRoot);
    const env = hooksPathEnv(managedDir);
    delete env.PICKLE_TICKET_ID;
    const subject = 'chore: no ticket env set';
    git(['commit', '--no-gpg-sign', '-q', '-m', subject], repoRoot, env);

    const body = git(['log', '-1', '--format=%B'], repoRoot).replace(/\n+$/, '');
    assert.equal(body, subject);
    assert.equal(trailerValue(repoRoot), '');
  });

  await t.test('the target repo itself is never mutated (core.hooksPath stays absent)', () => {
    const repoRoot = tmpRoot('gitattr-trailer-unmutated-');
    const managedDir = path.join(tmpRoot('gitattr-managed-unmutated-'), 'hooks');
    initGitRepo(repoRoot);

    const materialized = materializeTrailerHooks({ repoRoot, managedDir });
    assert.equal(materialized.ok, true);

    fs.writeFileSync(path.join(repoRoot, 'two.txt'), 'two');
    git(['add', '-A'], repoRoot);
    const env = hooksPathEnv(managedDir, { PICKLE_TICKET_ID: 'c5d6e7f8' });
    git(['commit', '--no-gpg-sign', '-q', '-m', 'chore: check repo untouched'], repoRoot, env);

    assert.throws(() => {
      git(['config', '--local', '--get', 'core.hooksPath'], repoRoot);
    });
  });
});

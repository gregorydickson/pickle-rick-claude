// @tier: fast
//
// R-PSCG (B-1SEAM WS-2): unit pins for computeBaselineStartCommit — the
// best-effort baseline primitive the symmetric citadel preflight heal and the
// setup --resume recompute both call. Soft git form throughout: a missing ref
// never throws.
//
//  - non-git dir            → null (caller WARNs / honest-fails)
//  - feature branch fixture → merge-base(default base, HEAD) = fork point, not HEAD
//  - single-branch repo with no main/master/origin → documented degenerate
//    HEAD floor (empty citadel diff beats killing the review tail)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { computeBaselineStartCommit } from '../services/scope-resolver.js';

function tmpRoot(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initRepo(dir, branch = 'main') {
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  commit(dir, 'baseline');
}

function commit(dir, msg) {
  fs.writeFileSync(path.join(dir, `${msg.replace(/\W+/g, '-')}.txt`), msg);
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '--no-gpg-sign', '-q', '-m', msg], { cwd: dir });
}

function sha(dir, ref) {
  return execFileSync('git', ['rev-parse', ref], { cwd: dir, encoding: 'utf-8' }).trim();
}

test('computeBaselineStartCommit: non-git dir → null', () => {
  const dir = tmpRoot('pickle-cbsc-nongit-');
  try {
    assert.equal(computeBaselineStartCommit(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('computeBaselineStartCommit: feature branch past a local main fork → fork-point sha, not HEAD', () => {
  const dir = tmpRoot('pickle-cbsc-feature-');
  try {
    initRepo(dir);
    const forkPoint = sha(dir, 'HEAD');
    execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: dir });
    commit(dir, 'feature one');
    commit(dir, 'feature two');
    const head = sha(dir, 'HEAD');
    assert.notEqual(forkPoint, head, 'fixture must diverge from the fork point');

    assert.equal(computeBaselineStartCommit(dir), forkPoint, 'baseline is merge-base(main, HEAD)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('computeBaselineStartCommit: single-branch local-only repo → HEAD floor (documented degenerate)', () => {
  // Branch deliberately NOT main/master and no origin: no default base resolves,
  // so the primitive falls to the loud HEAD floor.
  const dir = tmpRoot('pickle-cbsc-floor-');
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warns.push(args.join(' ')); };
  try {
    initRepo(dir, 'trunk');
    commit(dir, 'second');
    const head = sha(dir, 'HEAD');

    assert.equal(computeBaselineStartCommit(dir), head, 'HEAD floor when no base resolves');
    assert.ok(
      warns.some(w => /computeBaselineStartCommit/.test(w)),
      'degenerate floor must warn loudly',
    );
  } finally {
    console.warn = origWarn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

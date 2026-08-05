// @tier: fast
//
// R-PSCG (B-1SEAM WS-2): unit pins for computeReviewBase — the best-effort
// review-base primitive the legitimate review-base fallback in
// pipeline-runner.ts calls. Soft git form throughout: a missing ref never
// throws.
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
// AP-EXT-ITER24-01 also pins `resolveScope`'s binary-exclusion contract here.
// The canonical `scope-*.test.js` files are OUTSIDE this session's scope fence
// (`scope.json:allowed_paths`), and this is the in-fence scope-resolver unit
// file with real-git-repo fixtures — see the anatomy-park trap door in
// `src/services/CLAUDE.md`. Move these cases to `scope-resolver.test.js` when a
// session fence carries it.
import { computeReviewBase, resolveScope } from '../services/scope-resolver.js';

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

// --- AP-EXT-ITER24-01: `-\t-\t` means UNDIFFABLE, not binary ---------------
// `getBinaryPathSet` subtracts from the `getDiffFiles` enumeration, so it must
// read the diff through the SAME git contract (`-M100 -z`) and must not treat
// a repo-DECLARED `-diff` (the routine lockfile / generated / snapshot shape)
// as git's own binary DETECTION. Assert the resolved fence, never the probe.

function bareRepo(prefix) {
  const dir = tmpRoot(prefix);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  return dir;
}

function commitAll(dir, msg) {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '--no-gpg-sign', '-q', '-m', msg], { cwd: dir });
  return sha(dir, 'HEAD');
}

// NUL bytes are what makes git's own detector call a blob binary.
const BINARY = Buffer.from([0x41, 0x00, 0x42, 0x00, 0x43, 0x00, 0x44]);

function fenceOf(dir, base) {
  const sessionRoot = tmpRoot('pickle-cbsc-sess-');
  try {
    return resolveScope({ repoRoot: dir, sessionRoot, scopeFlag: `diff:${base}` }).allowed_paths;
  } finally {
    fs.rmSync(sessionRoot, { recursive: true, force: true });
  }
}

test('AP-EXT-ITER24-01: a -diff TEXT file stays in the fence; a real binary is still excluded', () => {
  const dir = bareRepo('pickle-cbsc-nodiff-');
  try {
    fs.writeFileSync(path.join(dir, '.gitattributes'), '*.lock -diff\n');
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'x\n');
    fs.writeFileSync(path.join(dir, 'dep.lock'), 'lock v1\n');
    fs.writeFileSync(path.join(dir, 'real.bin'), BINARY);
    const base = commitAll(dir, 'baseline');

    fs.writeFileSync(path.join(dir, 'keep.txt'), 'x\ny\n');
    fs.writeFileSync(path.join(dir, 'dep.lock'), 'lock v2\n');
    fs.writeFileSync(path.join(dir, 'real.bin'), Buffer.concat([BINARY, BINARY]));
    commitAll(dir, 'feature');

    const allowed = fenceOf(dir, base);
    // The bug: git reports `-\t-\t` for dep.lock because the repo declared
    // `-diff`, and the fence dropped a TEXT file that IS in the branch diff.
    assert.ok(allowed.includes('dep.lock'), `declared -diff TEXT must stay in the fence: ${JSON.stringify(allowed)}`);
    assert.ok(allowed.includes('keep.txt'), 'ordinary text is unaffected');
    // The control that keeps the fix from being a blanket widening.
    assert.ok(!allowed.includes('real.bin'), `git-detected binary must still be excluded: ${JSON.stringify(allowed)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER24-01: an all--diff branch resolves a real fence, not SCOPE_EMPTY_DIFF', () => {
  const dir = bareRepo('pickle-cbsc-alldiff-');
  try {
    fs.writeFileSync(path.join(dir, '.gitattributes'), '*.lock -diff\n');
    fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
    const base = commitAll(dir, 'baseline');

    fs.writeFileSync(path.join(dir, 'dep.lock'), 'lock v2\n');
    commitAll(dir, 'generated only');

    // Pre-fix this threw SCOPE_EMPTY_DIFF ("No files changed between …"), a
    // factually false FATAL: the branch changed a file the fence had dropped.
    assert.deepEqual(fenceOf(dir, base), ['dep.lock']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER24-01: a non-ASCII binary path is excluded (the probe reads -z, like the enumeration)', () => {
  const dir = bareRepo('pickle-cbsc-quoted-');
  try {
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'x\n');
    fs.writeFileSync(path.join(dir, 'café.bin'), BINARY);
    const base = commitAll(dir, 'baseline');

    fs.writeFileSync(path.join(dir, 'keep.txt'), 'x\ny\n');
    fs.writeFileSync(path.join(dir, 'café.bin'), Buffer.concat([BINARY, BINARY]));
    commitAll(dir, 'feature');

    // Without `-z` git C-quotes this as `"caf\303\251.bin"`, which never
    // matches the enumeration's raw path — so the exclusion silently leaked.
    assert.deepEqual(fenceOf(dir, base), ['keep.txt']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER24-01: a RENAMED binary is excluded by its POST-rename name', () => {
  const dir = bareRepo('pickle-cbsc-rename-');
  try {
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'x\n');
    fs.writeFileSync(path.join(dir, 'old.bin'), BINARY);
    const base = commitAll(dir, 'baseline');

    execFileSync('git', ['mv', 'old.bin', 'new.bin'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'x\ny\n');
    commitAll(dir, 'feature');

    // Rename detection is ON by default, so numstat emits `-\t-\t\0old\0new`
    // — an EMPTY inline path field. The enumeration yields the POST-rename
    // name, so that is the one the exclusion has to match.
    assert.deepEqual(fenceOf(dir, base), ['keep.txt']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('computeReviewBase: non-git dir → null', () => {
  const dir = tmpRoot('pickle-cbsc-nongit-');
  try {
    assert.equal(computeReviewBase(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('computeReviewBase: feature branch past a local main fork → fork-point sha, not HEAD', () => {
  const dir = tmpRoot('pickle-cbsc-feature-');
  try {
    initRepo(dir);
    const forkPoint = sha(dir, 'HEAD');
    execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: dir });
    commit(dir, 'feature one');
    commit(dir, 'feature two');
    const head = sha(dir, 'HEAD');
    assert.notEqual(forkPoint, head, 'fixture must diverge from the fork point');

    assert.equal(computeReviewBase(dir), forkPoint, 'baseline is merge-base(main, HEAD)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('computeReviewBase: single-branch local-only repo → HEAD floor (documented degenerate)', () => {
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

    assert.equal(computeReviewBase(dir), head, 'HEAD floor when no base resolves');
    assert.ok(
      warns.some(w => /computeReviewBase/.test(w)),
      'degenerate floor must warn loudly',
    );
  } finally {
    console.warn = origWarn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

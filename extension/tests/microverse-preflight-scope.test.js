// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { preflightAutoCommit } from '../bin/microverse-runner.js';

function createTempGitRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-preflight-scope-'));
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
    fs.writeFileSync(path.join(dir, 'README.md'), 'init');
    execSync('git add . && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
    return dir;
}

// AC-SMAF-1-1: scoped run with out-of-scope dirty file does NOT abort
test('preflightAutoCommit scoped: out-of-scope dirty file does not abort', () => {
    const dir = createTempGitRepo();
    try {
        // Establish an in-scope dir and an out-of-scope dir
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'other'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'src', 'inScope.ts'), 'export const x = 1;');
        fs.writeFileSync(path.join(dir, 'other', 'outOfScope.ts'), 'export const y = 2;');
        execSync('git add . && git commit -m "add src and other"', { cwd: dir, stdio: 'pipe' });

        // Simulate autofix dirtying ONLY an out-of-scope file
        fs.writeFileSync(path.join(dir, 'other', 'outOfScope.ts'), 'export const y = 2; // autofix');

        const logs = [];
        // Should NOT throw — out-of-scope dirt is ignored
        assert.doesNotThrow(
            () => preflightAutoCommit(dir, (msg) => logs.push(msg), ['src/**']),
            'scoped run with only out-of-scope dirt must not abort',
        );

        // Confirm nothing was committed (HEAD commit message unchanged)
        const headMsg = execSync('git log -1 --format=%s', { cwd: dir, encoding: 'utf-8' }).trim();
        assert.notEqual(headMsg, 'microverse: auto-commit dirty tree before start', 'out-of-scope change must not be auto-committed');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// AC-SMAF-1-1b: out-of-scope change is NOT committed (scope leak check)
test('preflightAutoCommit scoped: out-of-scope file remains uncommitted after no-op run', () => {
    const dir = createTempGitRepo();
    try {
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'other'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'src', 'code.ts'), 'export const a = 1;');
        fs.writeFileSync(path.join(dir, 'other', 'lint-victim.ts'), 'export const b = 2;');
        execSync('git add . && git commit -m "baseline"', { cwd: dir, stdio: 'pipe' });

        // Simulate eslint autofix on out-of-scope file
        fs.writeFileSync(path.join(dir, 'other', 'lint-victim.ts'), 'export const b = 2; // eslint-fixed');

        preflightAutoCommit(dir, () => {}, ['src/**']);

        // The out-of-scope file must remain dirty (not staged, not committed)
        const status = execSync('git status --porcelain', { cwd: dir, encoding: 'utf-8' }).trim();
        assert.ok(
            status.includes('other/lint-victim.ts'),
            `out-of-scope dirty file must still be dirty after scoped preflight; status: "${status}"`,
        );
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// AC-MPGD-A3 (R-MPGD-A): unscoped run from a subdir that has no own .git but parent does
// (monorepo subpackage scenario) now auto-commits — `isInsideWorkTree` correctly detects
// work-tree membership via `git rev-parse --is-inside-work-tree` instead of the naive
// direct-child `existsSync(path.join(dir, '.git'))` check this test used to pin as a throw.
test('preflightAutoCommit unscoped: dirty tree in subdir without own .git auto-commits (R-MPGD-A)', () => {
    const parentDir = createTempGitRepo();
    try {
        // Create a subpackage directory — git status works from here (parent .git),
        // and the subpackage itself has no .git directory.
        const subDir = path.join(parentDir, 'packages', 'subpkg');
        fs.mkdirSync(subDir, { recursive: true });
        fs.writeFileSync(path.join(subDir, 'tracked.ts'), 'v1');
        execSync('git add . && git commit -m "add subpkg"', { cwd: parentDir, stdio: 'pipe' });

        // Dirty the tracked file
        fs.writeFileSync(path.join(subDir, 'tracked.ts'), 'v2 dirty');

        // Confirm subDir has no own .git
        assert.ok(!fs.existsSync(path.join(subDir, '.git')), 'subDir must not have its own .git');

        // Without allowedPaths (unscoped), isInsideWorkTree(subDir) is true (parent repo),
        // so the dirty subdir is auto-committed instead of aborting.
        assert.doesNotThrow(
            () => preflightAutoCommit(subDir, () => {}),
            'unscoped run from a monorepo subdir with a valid parent repo must not abort',
        );

        const headMsg = execSync('git log -1 --format=%s', { cwd: subDir, encoding: 'utf-8' }).trim();
        assert.equal(headMsg, 'microverse: auto-commit dirty tree before start', 'subdir dirt must be auto-committed');
    } finally {
        fs.rmSync(parentDir, { recursive: true });
    }
});

// AC-SMAF-1-2 regression: unscoped run with dirty .git repo auto-commits (existing behavior preserved)
test('preflightAutoCommit unscoped: dirty git repo auto-commits (no regression)', () => {
    const dir = createTempGitRepo();
    try {
        fs.writeFileSync(path.join(dir, 'worker-output.txt'), 'worker changes\n');

        preflightAutoCommit(dir, () => {});

        const headMsg = execSync('git log -1 --format=%s', { cwd: dir, encoding: 'utf-8' }).trim();
        assert.equal(headMsg, 'microverse: auto-commit dirty tree before start', 'unscoped run must auto-commit dirty tracked + untracked files');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// Bonus: scoped run with in-scope dirty file only commits that file, not out-of-scope
test('preflightAutoCommit scoped: commits in-scope file, not out-of-scope', () => {
    const dir = createTempGitRepo();
    try {
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'other'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'src', 'code.ts'), 'v1');
        fs.writeFileSync(path.join(dir, 'other', 'unrelated.ts'), 'v1');
        execSync('git add . && git commit -m "baseline"', { cwd: dir, stdio: 'pipe' });

        // Dirty both files
        fs.writeFileSync(path.join(dir, 'src', 'code.ts'), 'v2');
        fs.writeFileSync(path.join(dir, 'other', 'unrelated.ts'), 'v2');
        execSync('git add src/code.ts', { cwd: dir, stdio: 'pipe' });

        preflightAutoCommit(dir, () => {}, ['src/**']);

        const headMsg = execSync('git log -1 --format=%s', { cwd: dir, encoding: 'utf-8' }).trim();
        assert.equal(headMsg, 'microverse: auto-commit dirty tree before start', 'in-scope dirty file must be committed');

        // out-of-scope file must still be dirty
        const status = execSync('git status --porcelain', { cwd: dir, encoding: 'utf-8' }).trim();
        assert.ok(
            status.includes('other/unrelated.ts'),
            `out-of-scope file must remain dirty; status: "${status}"`,
        );

        // in-scope file must be in the committed diff
        const diff = execSync('git show --name-only HEAD --format=', { cwd: dir, encoding: 'utf-8' }).trim();
        assert.ok(diff.includes('src/code.ts'), `in-scope file must appear in committed diff; diff: "${diff}"`);
        assert.ok(!diff.includes('other/unrelated.ts'), `out-of-scope file must NOT appear in committed diff; diff: "${diff}"`);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

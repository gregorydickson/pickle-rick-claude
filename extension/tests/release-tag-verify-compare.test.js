// @tier: fast
// Drives extension/scripts/verify-release-tag.sh against a local throwaway git
// fixture (no network) to pin AC-R5: a release-verification step must COMPARE
// a resolved sha to an expected value and fail on mismatch/absence, not merely
// confirm existence (the exact defect `git ls-remote --tags origin <tag>` had
// after both beta.16 and beta.17 -- see CLAUDE.md Versioning section / B-RELTAG).
// Also pins AC-R2's doc half: CLAUDE.md documents `--target` release tagging.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(EXTENSION_ROOT, '..');
const SCRIPT = path.join(EXTENSION_ROOT, 'scripts', 'verify-release-tag.sh');
const CLAUDE_MD = path.join(REPO_ROOT, 'CLAUDE.md');

function git(args, cwd) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
}

function makeFixtureRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-release-tag-fixture-'));
    git(['init', '-q'], dir);
    git(['config', 'user.email', 'test@test.local'], dir);
    git(['config', 'user.name', 'Test'], dir);
    git(['commit', '-q', '--allow-empty', '-m', 'init'], dir);
    const commitSha = git(['rev-parse', 'HEAD'], dir);
    git(['tag', 'v-light'], dir);
    git(['tag', '-a', 'v-annotated', '-m', 'annotated'], dir);
    return { dir, commitSha };
}

function runScript(args) {
    return spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', timeout: 30_000 });
}

test('lightweight tag match exits zero and prints both shas', () => {
    const { dir, commitSha } = makeFixtureRepo();
    try {
        const result = runScript(['v-light', commitSha, dir]);
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        assert.ok(result.stdout.includes(`expected=${commitSha}`));
        assert.ok(result.stdout.includes(`actual=${commitSha}`));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('annotated tag dereferences via ^{} to the commit sha, not the tag object sha', () => {
    const { dir, commitSha } = makeFixtureRepo();
    try {
        const tagObjectSha = git(['rev-parse', 'v-annotated'], dir);
        assert.notEqual(tagObjectSha, commitSha, 'fixture invariant: annotated tag object sha must differ from the commit it points at');

        const result = runScript(['v-annotated', commitSha, dir]);
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        assert.ok(result.stdout.includes(`actual=${commitSha}`),
            'script must report the dereferenced COMMIT sha as actual, not the tag object sha');
        assert.ok(!result.stdout.includes(`actual=${tagObjectSha}`),
            'script must never report the annotated tag object sha as if it were the commit sha');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('mismatch exits non-zero and prints both expected and actual shas', () => {
    const { dir, commitSha } = makeFixtureRepo();
    try {
        const wrongSha = '0'.repeat(40);
        const result = runScript(['v-light', wrongSha, dir]);
        assert.notEqual(result.status, 0);
        const combined = result.stdout + result.stderr;
        assert.ok(combined.includes(`expected=${wrongSha}`));
        assert.ok(combined.includes(`actual=${commitSha}`));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('missing tag exits non-zero -- absence is not success', () => {
    const { dir, commitSha } = makeFixtureRepo();
    try {
        const result = runScript(['v-does-not-exist', commitSha, dir]);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /not found/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('script is read-only -- the fixture remote tag set is unchanged after a run', () => {
    const { dir, commitSha } = makeFixtureRepo();
    try {
        const before = git(['tag', '--list'], dir);
        runScript(['v-light', commitSha, dir]);
        runScript(['v-annotated', '0'.repeat(40), dir]);
        runScript(['v-nope', commitSha, dir]);
        const after = git(['tag', '--list'], dir);
        assert.equal(after, before, 'verify-release-tag.sh must never push, create, or delete tags');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('empty expected-sha is rejected, not treated as a wildcard match', () => {
    // "$expected_sha"* becomes a bare `*` glob when expected_sha is empty --
    // guards against that silently matching any actual sha (mismatch never fires).
    const { dir } = makeFixtureRepo();
    try {
        const result = runScript(['v-light', '', dir]);
        assert.notEqual(result.status, 0);
        assert.doesNotMatch(result.stdout, /expected= actual=/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('bad invocation (wrong arg count) prints usage and exits non-zero', () => {
    const tooFew = runScript(['only-one-arg']);
    assert.notEqual(tooFew.status, 0);
    assert.match(tooFew.stderr, /Usage/);

    const tooMany = runScript(['a', 'b', 'c', 'd']);
    assert.notEqual(tooMany.status, 0);
    assert.match(tooMany.stderr, /Usage/);
});

function versioningSection(claudeMd) {
    const start = claudeMd.indexOf('## Versioning');
    assert.notEqual(start, -1, 'CLAUDE.md is missing the ## Versioning section');
    const end = claudeMd.indexOf('\n## ', start + 1);
    return claudeMd.slice(start, end === -1 ? claudeMd.length : end);
}

test('CLAUDE.md Versioning section documents --target release tagging (AC-R2)', () => {
    const claudeMd = fs.readFileSync(CLAUDE_MD, 'utf8');
    const section = versioningSection(claudeMd);

    assert.ok(section.includes('--target "$(git rev-parse HEAD)"'),
        'Versioning section must document the exact --target invocation, not just mention the flag name');
    assert.ok(section.includes('gh release create vX.Y.Z --target'),
        'Versioning section must show --target on the gh release create command itself');
});

test('CLAUDE.md Versioning section references verify-release-tag.sh as the comparison step', () => {
    const claudeMd = fs.readFileSync(CLAUDE_MD, 'utf8');
    const section = versioningSection(claudeMd);

    assert.ok(section.includes('verify-release-tag.sh'),
        'Versioning section must point at extension/scripts/verify-release-tag.sh as the mechanical comparison tool (AC-R5 tie-in)');
});

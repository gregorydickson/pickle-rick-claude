// @tier: fast
// Drives extension/scripts/reconcile-release-tags.sh against a local
// throwaway git fixture (no network) containing a deliberately mis-pointed
// tag. Pins AC-R4 of prds/p0-b-reltag-release-tags-point-at-main.md: a
// read-only auditor that reports, per v* tag, the commit it resolves to,
// the extension/package.json version in that tree, the version implied by
// the tag name, and a verdict of OK / MISPOINTED / UNKNOWN -- and exits
// non-zero exactly when a MISPOINTED row exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(EXTENSION_ROOT, 'scripts', 'reconcile-release-tags.sh');

function git(args, cwd) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
}

function writePackageJson(dir, version) {
    fs.mkdirSync(path.join(dir, 'extension'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'extension', 'package.json'),
        JSON.stringify({ name: 'pickle-rick-extension', version }, null, 2) + '\n',
    );
}

function runScript(args) {
    return spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', timeout: 30_000 });
}

function makeFixtureRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-release-tags-fixture-'));
    git(['init', '-q'], dir);
    git(['config', 'user.email', 'test@test.local'], dir);
    git(['config', 'user.name', 'Test'], dir);
    return dir;
}

test('an OK tag and a MISPOINTED tag are both classified correctly, and exit is non-zero', () => {
    const dir = makeFixtureRepo();
    try {
        // v1.0.0 -> correctly-pointed commit.
        writePackageJson(dir, '1.0.0');
        git(['add', '-A'], dir);
        git(['commit', '-q', '-m', 'v1.0.0 release'], dir);
        const okSha = git(['rev-parse', 'HEAD'], dir);
        git(['tag', 'v1.0.0'], dir);

        // v9.9.9 -> deliberately mis-pointed at a commit whose tree carries
        // version 2.0.0, reproducing the beta.16/beta.17 shape.
        writePackageJson(dir, '2.0.0');
        git(['add', '-A'], dir);
        git(['commit', '-q', '-m', 'unrelated bump'], dir);
        const mispointedSha = git(['rev-parse', 'HEAD'], dir);
        git(['tag', 'v9.9.9'], dir);

        const result = runScript([dir]);
        assert.notEqual(result.status, 0, `expected non-zero exit when a MISPOINTED row exists; stdout: ${result.stdout}`);

        const lines = result.stdout.split('\n');
        const okLine = lines.find((l) => l.startsWith('v1.0.0 '));
        const mispointedLine = lines.find((l) => l.startsWith('v9.9.9 '));

        assert.ok(okLine, `expected a v1.0.0 row in:\n${result.stdout}`);
        assert.match(okLine, /\bOK\b/);
        assert.ok(okLine.includes(okSha));

        assert.ok(mispointedLine, `expected a v9.9.9 row in:\n${result.stdout}`);
        assert.match(mispointedLine, /\bMISPOINTED\b/);
        assert.ok(mispointedLine.includes(mispointedSha));
        assert.ok(mispointedLine.includes('2.0.0'), 'MISPOINTED row must show the actual tree version');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a tag whose tree lacks extension/package.json is reported UNKNOWN, not a crash', () => {
    const dir = makeFixtureRepo();
    try {
        fs.writeFileSync(path.join(dir, 'README.md'), 'no package.json here\n');
        git(['add', '-A'], dir);
        git(['commit', '-q', '-m', 'no package.json'], dir);
        const sha = git(['rev-parse', 'HEAD'], dir);
        git(['tag', 'v0.1.0'], dir);

        const result = runScript([dir]);
        assert.equal(result.status, 0, `an all-UNKNOWN fixture must exit zero; stderr: ${result.stderr}`);

        const lines = result.stdout.split('\n');
        const unknownLine = lines.find((l) => l.startsWith('v0.1.0 '));
        assert.ok(unknownLine, `expected a v0.1.0 row in:\n${result.stdout}`);
        assert.match(unknownLine, /\bUNKNOWN\b/);
        assert.ok(unknownLine.includes(sha));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('all-OK fixture exits zero', () => {
    const dir = makeFixtureRepo();
    try {
        writePackageJson(dir, '1.2.3');
        git(['add', '-A'], dir);
        git(['commit', '-q', '-m', 'v1.2.3 release'], dir);
        git(['tag', 'v1.2.3'], dir);

        const result = runScript([dir]);
        assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
        assert.match(result.stdout, /v1\.2\.3\s+OK\b/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('annotated tag dereferences via ^{} to the commit sha, not the tag object sha (reused resolve_tag_sha)', () => {
    const dir = makeFixtureRepo();
    try {
        writePackageJson(dir, '1.0.0');
        git(['add', '-A'], dir);
        git(['commit', '-q', '-m', 'init'], dir);
        const commitSha = git(['rev-parse', 'HEAD'], dir);
        git(['tag', '-a', 'v1.0.0', '-m', 'annotated'], dir);
        const tagObjectSha = git(['rev-parse', 'v1.0.0'], dir);
        assert.notEqual(tagObjectSha, commitSha, 'fixture invariant: annotated tag object sha must differ from the commit it points at');

        const result = runScript([dir]);
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        assert.ok(result.stdout.includes(commitSha), 'must report the dereferenced COMMIT sha');
        assert.ok(!result.stdout.includes(tagObjectSha), 'must never report the annotated tag object sha as if it were the commit sha');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('no v* tags on the remote: exits zero with a stderr note, not a crash', () => {
    const dir = makeFixtureRepo();
    try {
        fs.writeFileSync(path.join(dir, 'README.md'), 'no tags\n');
        git(['add', '-A'], dir);
        git(['commit', '-q', '-m', 'no tags'], dir);

        const result = runScript([dir]);
        assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
        assert.match(result.stderr, /no v\* tags found/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('script is read-only -- the fixture tag set is unchanged after a run', () => {
    const dir = makeFixtureRepo();
    try {
        writePackageJson(dir, '1.0.0');
        git(['add', '-A'], dir);
        git(['commit', '-q', '-m', 'v1.0.0 release'], dir);
        git(['tag', 'v1.0.0'], dir);

        writePackageJson(dir, '2.0.0');
        git(['add', '-A'], dir);
        git(['commit', '-q', '-m', 'unrelated bump'], dir);
        git(['tag', 'v9.9.9'], dir);

        const beforeTags = git(['tag', '-l'], dir);
        const beforeLog = git(['log', '--oneline', '--all'], dir);

        const result = runScript([dir]);
        assert.notEqual(result.status, 0);

        const afterTags = git(['tag', '-l'], dir);
        const afterLog = git(['log', '--oneline', '--all'], dir);

        assert.equal(afterTags, beforeTags, 'tag set must be unchanged by a report-only run');
        assert.equal(afterLog, beforeLog, 'commit history must be unchanged by a report-only run');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('bad invocation (too many args) prints usage and exits non-zero', () => {
    const result = runScript(['origin', 'extra-arg']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage:/);
});

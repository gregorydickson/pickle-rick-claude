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

// AP-EXT-ITER2-01 regression. The auditor used to derive tag NAMES from a
// `git ls-remote` listing and then throw that listing's shas away, re-querying
// `resolve_tag_sha` once per tag. Two consequences, both pinned below:
//   1. N+1 network round-trips where the first listing already held every sha
//      (measured 2m32s vs 0.4s against origin's 258 tags).
//   2. `resolve_tag_sha` returns 1 for BOTH "tag absent" and "git ls-remote
//      failed", so a single transient failure made the loop `continue` --
//      dropping that tag's row AND leaving `any_mispointed` unset. A run whose
//      MISPOINTED tag hit the blip printed a clean table and exited 0.
function makeGitShim(dir, { failRefspec = null } = {}) {
    const shimDir = path.join(dir, 'shim');
    fs.mkdirSync(shimDir, { recursive: true });
    const callLog = path.join(dir, 'ls-remote-calls.log');
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', timeout: 30_000 }).stdout.trim();
    assert.ok(realGit, 'fixture requires a real git on PATH');
    const failArm = failRefspec
        ? `  for a in "$@"; do\n    if [ "$a" = ${JSON.stringify(failRefspec)} ]; then\n      echo "fatal: transient network error" >&2\n      exit 128\n    fi\n  done\n`
        : '';
    fs.writeFileSync(
        path.join(shimDir, 'git'),
        `#!/bin/bash\nif [ "$1" = "ls-remote" ]; then\n  echo "$*" >> ${JSON.stringify(callLog)}\n${failArm}fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
    );
    fs.chmodSync(path.join(shimDir, 'git'), 0o755);
    return {
        shimDir,
        lsRemoteCalls: () => (fs.existsSync(callLog)
            ? fs.readFileSync(callLog, 'utf8').split('\n').filter((l) => l.trim() !== '')
            : []),
    };
}

function seedTwoTagRepo(dir) {
    writePackageJson(dir, '1.0.0');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'v1.0.0 release'], dir);
    git(['tag', 'v1.0.0'], dir);
    // v9.9.9 is MISPOINTED: its tree carries 2.0.0.
    writePackageJson(dir, '2.0.0');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'unrelated bump'], dir);
    git(['tag', 'v9.9.9'], dir);
}

test('AP-EXT-ITER2-01: the whole audit costs exactly ONE git ls-remote, whatever the tag count', () => {
    const dir = makeFixtureRepo();
    try {
        seedTwoTagRepo(dir);
        for (const extra of ['v1.1.0', 'v1.2.0', 'v1.3.0', 'v1.4.0']) git(['tag', extra], dir);

        const shim = makeGitShim(dir);
        const result = spawnSync('bash', [SCRIPT, dir], {
            encoding: 'utf8',
            timeout: 30_000,
            env: { ...process.env, PATH: `${shim.shimDir}${path.delimiter}${process.env.PATH}` },
        });

        const calls = shim.lsRemoteCalls();
        assert.equal(
            calls.length,
            1,
            `the listing already carries every tag's sha; re-querying per tag is what let one blip hide a MISPOINTED row. calls:\n${calls.join('\n')}`,
        );
        // 6 tags all still audited off that single call.
        for (const tag of ['v1.0.0', 'v9.9.9', 'v1.1.0', 'v1.2.0', 'v1.3.0', 'v1.4.0']) {
            assert.ok(
                result.stdout.split('\n').some((l) => l.startsWith(`${tag} `)),
                `expected a ${tag} row in:\n${result.stdout}`,
            );
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('AP-EXT-ITER2-01: a per-tag ls-remote blip can no longer hide a MISPOINTED tag behind a green exit', () => {
    const dir = makeFixtureRepo();
    try {
        seedTwoTagRepo(dir);

        // Fail exactly the single-tag refspec the old per-tag resolution used.
        const shim = makeGitShim(dir, { failRefspec: 'refs/tags/v9.9.9' });
        const result = spawnSync('bash', [SCRIPT, dir], {
            encoding: 'utf8',
            timeout: 30_000,
            env: { ...process.env, PATH: `${shim.shimDir}${path.delimiter}${process.env.PATH}` },
        });

        const mispointedLine = result.stdout.split('\n').find((l) => l.startsWith('v9.9.9 '));
        assert.ok(mispointedLine, `the MISPOINTED row must survive a per-tag blip; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        assert.match(mispointedLine, /\bMISPOINTED\b/);
        assert.notEqual(
            result.status,
            0,
            `a tag set containing a MISPOINTED tag must never exit green; stdout:\n${result.stdout}`,
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('AP-EXT-ITER2-01: list_tag_shas_from_listing is the ONE place the ^{} peel rule lives', () => {
    // resolve_tag_sha must read its sha back through the shared parser rather
    // than re-deriving the peel, so the two scripts cannot drift apart.
    const shared = fs.readFileSync(path.join(EXTENSION_ROOT, 'scripts', 'resolve-tag-sha.sh'), 'utf8');
    const reconcile = fs.readFileSync(SCRIPT, 'utf8');

    assert.match(shared, /list_tag_shas_from_listing\(\)/, 'shared parser must be defined');
    assert.match(shared, /resolve_tag_sha[\s\S]*list_tag_shas_from_listing/, 'resolve_tag_sha must delegate to the shared parser');
    assert.match(reconcile, /list_tag_shas_from_listing "\$listing"/, 'the auditor must read shas from its own listing');
    assert.doesNotMatch(reconcile, /resolve_tag_sha /, 'the auditor must not re-query per tag');

    // Prose may DESCRIBE the peel rule; only executable lines are checked, so a
    // comment mentioning ^{} does not read as a second implementation of it.
    const reconcileCode = reconcile
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');
    assert.doesNotMatch(reconcileCode, /\^\{\}/, 'the peel rule must not be duplicated into the auditor');
});

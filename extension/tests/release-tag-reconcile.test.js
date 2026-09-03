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

// AP-EXT-ITER65-01 regression. The auditor used to derive tag NAMES from a
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

test('AP-EXT-ITER65-01: the whole audit costs exactly ONE git ls-remote, whatever the tag count', () => {
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

test('AP-EXT-ITER65-01: a per-tag ls-remote blip can no longer hide a MISPOINTED tag behind a green exit', () => {
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

/**
 * Body of the top-level shell function `<name>() {`, ending at the first line that
 * is a bare `}` in column 0. Scoping the region is the point: an assertion about one
 * function's contents must not be satisfiable by text elsewhere in the file.
 */
function shellFunctionBody(src, name) {
    const lines = src.split('\n');
    const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
    assert.notEqual(start, -1, `shell function ${name}() must exist`);
    const end = lines.findIndex((l, i) => i > start && l === '}');
    assert.notEqual(end, -1, `shell function ${name}() must be closed by a bare }`);
    return lines.slice(start + 1, end).join('\n');
}

/**
 * EVERY logical statement assigning `<name>=` inside a shell body, with backslash
 * continuations joined so a multi-line command substitution is read whole.
 *
 * All of them, not one of them: whichever assignment's value survives, it came from
 * SOME assignment, so an invariant about that value has to hold for every one. Reading
 * only the first is what AP-EXT-ITER167-02 measured -- a decorative assignment that
 * satisfies the pin followed by a real one that overwrites it stayed green. Reading only
 * the last is the same bet with the opposite index, and a branch defeats it just as
 * quietly. Discovery matches the assignment token after start-of-line, whitespace or `;`
 * so `local x=` / `export x=` are seen without enumerating the declaration keywords;
 * comment lines are dropped so prose naming the variable is not read as code.
 */
function shellAssignments(body, name) {
    const lines = body.split('\n').filter((l) => !/^\s*#/.test(l));
    const assigns = new RegExp(`(^|[\\s;])${name}=`);
    const statements = [];
    for (let i = 0; i < lines.length; i += 1) {
        if (!assigns.test(lines[i])) continue;
        const statement = [];
        for (let j = i; j < lines.length; j += 1) {
            statement.push(lines[j]);
            if (!lines[j].trimEnd().endsWith('\\')) break;
        }
        statements.push(statement.join('\n'));
    }
    assert.ok(statements.length > 0, `${name} must be assigned`);
    return statements;
}

test('AP-EXT-ITER65-01: list_tag_shas_from_listing is the ONE place the ^{} peel rule lives', () => {
    // resolve_tag_sha must read its sha back through the shared parser rather
    // than re-deriving the peel, so the two scripts cannot drift apart.
    const shared = fs.readFileSync(path.join(EXTENSION_ROOT, 'scripts', 'resolve-tag-sha.sh'), 'utf8');
    const reconcile = fs.readFileSync(SCRIPT, 'utf8');

    assert.match(shared, /list_tag_shas_from_listing\(\)/, 'shared parser must be defined');
    // Assert the PRODUCER of resolve_tag_sha's sha, not the co-occurrence of two
    // names anywhere in the file: `/resolve_tag_sha[\s\S]*list_tag_shas_from_listing/`
    // is satisfied by the header comment on line 3 followed by the one on line 11,
    // so it stayed green when the peel rule was re-derived inline inside
    // resolve_tag_sha -- the exact drift this test names (measured, both with and
    // without a behaviour change).
    for (const statement of shellAssignments(shellFunctionBody(shared, 'resolve_tag_sha'), 'actual_sha')) {
        assert.match(
            statement,
            /list_tag_shas_from_listing/,
            `every actual_sha assignment in resolve_tag_sha must come FROM the shared parser, not re-derive the peel; offending statement:\n${statement}`,
        );
    }
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

// AP-EXT-ITER167-02 regression. This helper used to return the FIRST `<name>=`
// statement and stop, singular in name and in reach. A decorative assignment
// through the shared parser followed by a real one that overwrote it with an
// inline peel therefore left the pin above GREEN -- measured 10/10 against the
// exact drift that pin names. It must see EVERY assignment, however spelled, and
// must fail loud rather than vacuously when it sees none.
test('AP-EXT-ITER167-02: shellAssignments reads every assignment, not just the first', () => {
    const drifted = [
        '  local ls_remote_output actual_sha',
        '  actual_sha="$(list_tag_shas_from_listing "$ls_remote_output" \\',
        '    | awk -F\'\\t\' -v want="$tag" \'$1 == want { print $2; exit }\')"',
        '  # actual_sha= is re-derived below; prose naming it must not read as code',
        '  actual_sha="$(printf \'%s\\n\' "$ls_remote_output" \\',
        '    | awk -v want="refs/tags/$tag^{}" \'$2 == want { print $1; exit }\')"',
    ].join('\n');

    const statements = shellAssignments(drifted, 'actual_sha');

    assert.equal(
        statements.length,
        2,
        `both assignments must be seen, not just the first:\n${statements.join('\n--- next ---\n')}`,
    );
    assert.match(statements[0], /list_tag_shas_from_listing/);
    assert.doesNotMatch(
        statements[1],
        /list_tag_shas_from_listing/,
        'the OVERWRITING assignment is the drift; it is the one that must not be invisible',
    );
    assert.ok(
        statements.every((s) => s.includes('awk')),
        'a backslash-continued statement must be read whole, not just its first line',
    );

    assert.equal(
        shellAssignments('  local actual_sha="$(peel)"', 'actual_sha').length,
        1,
        'a `local x=` declaration is an assignment; discovery must not require the name in column 0',
    );
    assert.throws(
        () => shellAssignments('  printf \'%s\' "$actual_sha"', 'actual_sha'),
        /actual_sha must be assigned/,
        'a body with no assignment must fail loud, never return an empty set that passes every check vacuously',
    );
});

// @tier: fast
// AC-RSBI-2-1: same paths:<glob> resolves to same allowed_paths from a
// subpackage directory as from the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '..', 'bin', 'resolve-scope.js');

function git(args, cwd) {
    const res = spawnSync('git', args, {
        cwd,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.invalid',
            GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.invalid',
        },
        encoding: 'utf-8',
    });
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${res.stderr}`);
    return (res.stdout || '').trim();
}

test('AC-RSBI-2-1: paths:<glob> resolves identically from subpackage vs repo root', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-base-'));
    const session1 = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-base-s1-'));
    const session2 = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-base-s2-'));
    try {
        git(['init', '-q', '-b', 'main'], repo);
        git(['config', 'commit.gpgsign', 'false'], repo);

        // root-level TS file
        fs.writeFileSync(path.join(repo, 'root.ts'), 'export const r = 1;\n');
        // subpackage with TS and JS files
        fs.mkdirSync(path.join(repo, 'pkg', 'src'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'pkg', 'src', 'mod.ts'), 'export const m = 2;\n');
        fs.writeFileSync(path.join(repo, 'pkg', 'src', 'util.js'), 'const u = 3;\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'initial'], repo);

        const pkgDir = path.join(repo, 'pkg');

        // invoke from repo root
        execFileSync(process.execPath, [
            CLI_PATH, '--scope', 'paths:**/*.ts', '--session-root', session1,
        ], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });

        // invoke from subpackage — should produce same result after R-RSBI-2 fix
        execFileSync(process.execPath, [
            CLI_PATH, '--scope', 'paths:**/*.ts', '--session-root', session2,
        ], { cwd: pkgDir, stdio: ['pipe', 'pipe', 'pipe'] });

        const scope1 = JSON.parse(fs.readFileSync(path.join(session1, 'scope.json'), 'utf-8'));
        const scope2 = JSON.parse(fs.readFileSync(path.join(session2, 'scope.json'), 'utf-8'));

        assert.deepStrictEqual(
            scope1.allowed_paths,
            scope2.allowed_paths,
            'paths:<glob> from subpackage must produce same allowed_paths as from repo root (AC-RSBI-2-1)',
        );
        assert.ok(scope1.allowed_paths.includes('root.ts'), 'root.ts in allowed_paths');
        assert.ok(scope1.allowed_paths.includes('pkg/src/mod.ts'), 'pkg/src/mod.ts in allowed_paths');
        assert.ok(!scope1.allowed_paths.includes('pkg/src/util.js'), 'util.js excluded (not .ts)');
    } finally {
        fs.rmSync(repo, { recursive: true, force: true });
        fs.rmSync(session1, { recursive: true, force: true });
        fs.rmSync(session2, { recursive: true, force: true });
    }
});

// AP-EXT-ITER326-01: the CLI carried its OWN `rev-parse --show-toplevel` resolver with a
// bare `catch` returning the caller's cwd. Since AP-EXT-ITER322-01 `resolveScope` derives
// its own anchor (`resolveRepoToplevel`), so that resolver was a fifth spelling of one
// predicate whose every arm the callee repeats, and it was DELETED rather than given the
// empty-output arm its siblings have. Deleting a belt puts the whole guarantee on the
// remaining one, so what needs pinning is the DIRECTION the CLI fails when the anchor
// cannot be proven: the deleted `catch` used to swallow "git never spoke" and hand the raw
// cwd in, and the danger of removing it is not a throw but a fall-through that anchors on
// an unproven directory and writes a fence nobody can see is wrong. Both arms run the REAL
// CLI over the SAME repo; the ACCEPT control differs only in whether `git` is on PATH, so
// the REJECT arm cannot pass on a fixture that was never resolvable to begin with.
test('AP-EXT-ITER326-01: CLI fails CLOSED and writes no scope.json when git cannot answer', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-anchor-'));
    const sessionAccept = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-anchor-a-'));
    const sessionReject = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-anchor-r-'));
    const nodeOnlyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-anchor-bin-'));
    try {
        git(['init', '-q', '-b', 'main'], repo);
        git(['config', 'commit.gpgsign', 'false'], repo);
        fs.writeFileSync(path.join(repo, 'above.ts'), 'export const a = 1;\n');
        fs.mkdirSync(path.join(repo, 'pkg'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'pkg', 'below.ts'), 'export const b = 2;\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'initial'], repo);

        const pkgDir = path.join(repo, 'pkg');

        // A PATH carrying node but NOT git: `rev-parse` spawn-fails ENOENT, which is the
        // `status: null` "git never spoke" shape — the exact cell the deleted bare catch
        // swallowed. node must survive the strip or the child never starts and the REJECT
        // assertions would pass against a fixture that measured nothing.
        fs.symlinkSync(process.execPath, path.join(nodeOnlyBin, 'node'));

        // ACCEPT control, same repo, same below-toplevel cwd, git AVAILABLE: proves the
        // fixture really is resolvable and that a raw cwd still anchors at the toplevel,
        // so the REJECT arm's exit 2 is attributable to the missing git and nothing else.
        execFileSync(process.execPath, [
            CLI_PATH, '--scope', 'paths:**/*.ts', '--session-root', sessionAccept,
        ], { cwd: pkgDir, stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000 });
        const accepted = JSON.parse(
            fs.readFileSync(path.join(sessionAccept, 'scope.json'), 'utf-8'),
        );
        assert.ok(
            accepted.allowed_paths.includes('above.ts'),
            'ACCEPT control: a below-toplevel read must still see the file ABOVE the cwd — '
            + 'a cwd-anchored fence would drop it (R-RSBI-2)',
        );
        assert.ok(
            accepted.allowed_paths.includes('pkg/below.ts'),
            'ACCEPT control: below-toplevel file spelled repo-root-relative',
        );

        // REJECT arm: git unreachable, so the anchor cannot be PROVEN.
        const rejected = spawnSync(process.execPath, [
            CLI_PATH, '--scope', 'paths:**/*.ts', '--session-root', sessionReject,
        ], {
            cwd: pkgDir,
            env: { ...process.env, PATH: nodeOnlyBin },
            encoding: 'utf-8',
            timeout: 60000,
        });

        assert.equal(
            rejected.status, 2,
            `unproven anchor must exit 2, got ${rejected.status}: ${rejected.stderr}`,
        );
        assert.deepStrictEqual(
            JSON.parse(rejected.stderr.trim()).code, 'SCOPE_NOT_A_REPO',
            'the refusal must be NAMED, not a bare non-zero exit',
        );
        assert.equal(
            fs.existsSync(path.join(sessionReject, 'scope.json')), false,
            'no fence may be written from an anchor git never proved — a scope.json here '
            + 'is spelled against an unproven directory and reads as a legitimate narrow fence',
        );
    } finally {
        for (const d of [repo, sessionAccept, sessionReject, nodeOnlyBin]) {
            fs.rmSync(d, { recursive: true, force: true });
        }
    }
});

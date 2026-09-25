// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { filterBySubsystem, filterByPaths, resolveScope, refreshScope } from '../services/scope-resolver.js';
import { discoverSubsystems, discoverLanes, isTestFile } from '../bin/pipeline-runner.js';
import { laneAdmits } from '../services/scope-resolver.js';

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

// B-LANES: filterBySubsystem takes lane records; these cases name plain one-dir lanes.
const lane = (name) => ({ name, dir: name, excludes: [], testRatioApplies: true, fileCount: 0 });
const keptNames = (names, ...rest) => filterBySubsystem(names.map(lane), ...rest).map((l) => l.name);

test('filterBySubsystem: 4 subsystems, 2 have files in allowedPaths → returns those 2', () => {
    const repoRoot = '/repo';
    const target = '/repo/pkg';
    const subsystems = ['alpha', 'beta', 'gamma', 'delta'];
    const allowedPaths = [
        'pkg/alpha/index.ts',
        'pkg/gamma/util.ts',
        'pkg/gamma/helper.ts',
    ];
    const result = keptNames(subsystems, allowedPaths, target, repoRoot);
    assert.deepStrictEqual(result, ['alpha', 'gamma']);
});

test('filterByPaths: 10 files, 3 in allowedPaths → returns those 3', () => {
    const repoRoot = '/repo';
    const allowedPaths = ['src/a.ts', 'src/c.ts', 'src/g.ts'];
    const absFiles = [
        '/repo/src/a.ts',
        '/repo/src/b.ts',
        '/repo/src/c.ts',
        '/repo/src/d.ts',
        '/repo/src/e.ts',
        '/repo/src/f.ts',
        '/repo/src/g.ts',
        '/repo/src/h.ts',
        '/repo/src/i.ts',
        '/repo/src/j.ts',
    ];
    const result = filterByPaths(absFiles, allowedPaths, repoRoot);
    assert.deepStrictEqual(result, ['/repo/src/a.ts', '/repo/src/c.ts', '/repo/src/g.ts']);
});

test('resolveScope: binary file (.png) excluded from allowed_paths per FR-26', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-binary-'));
    const session = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-binary-sess-'));
    try {
        git(['init', '-q', '-b', 'main'], dir);
        git(['config', 'commit.gpgsign', 'false'], dir);
        fs.writeFileSync(path.join(dir, 'initial.ts'), 'initial\n');
        git(['add', '.'], dir);
        git(['commit', '-qm', 'initial'], dir);

        git(['checkout', '-qb', 'feature'], dir);
        fs.writeFileSync(path.join(dir, 'feature.ts'), 'export const x = 1;\n');
        // NUL byte makes git detect this as binary
        fs.writeFileSync(path.join(dir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));
        git(['add', '.'], dir);
        git(['commit', '-qm', 'feature'], dir);

        const scope = resolveScope({
            scopeFlag: 'branch',
            scopeBase: 'main',
            sessionRoot: session,
            repoRoot: dir,
        });

        assert.ok(!scope.allowed_paths.includes('image.png'), '.png must not appear in allowed_paths');
        assert.ok(scope.allowed_paths.includes('feature.ts'), 'text file must appear in allowed_paths');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(session, { recursive: true, force: true });
    }
});

test('filterBySubsystem: allowedPaths outside target subtree → returns []', () => {
    const repoRoot = '/repo';
    const target = '/repo/pkg';
    const subsystems = ['alpha', 'beta'];
    // Paths are under 'other/', not 'pkg/' — completely outside target
    const allowedPaths = [
        'other/alpha/index.ts',
        'other/beta/util.ts',
    ];
    const result = keptNames(subsystems, allowedPaths, target, repoRoot);
    assert.deepStrictEqual(result, []);
});

test('pipeline-mode integration: discoverSubsystems lanes feed filterBySubsystem correctly', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-pipeline-int-'));
    try {
        // 4 subsystems — only alpha and gamma are in the scope diff
        for (const name of ['alpha', 'beta', 'gamma', 'delta']) {
            const sub = path.join(root, name);
            fs.mkdirSync(sub);
            for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(sub, `f${i}.ts`), '');
        }

        const discovered = discoverSubsystems(root);
        const names = discovered.map(s => s.name);
        assert.deepStrictEqual(names, ['alpha', 'beta', 'delta', 'gamma']); // sorted

        const allowedPaths = ['alpha/f0.ts', 'gamma/f1.ts'];
        const kept = filterBySubsystem(discovered, allowedPaths, root, root).map((l) => l.name);
        assert.deepStrictEqual(kept, ['alpha', 'gamma']);

        // Simulate the pipeline-runner filter: kept set narrows the discovered list
        const keptSet = new Set(kept);
        const filtered = discovered.filter(s => keptSet.has(s.name));
        assert.equal(filtered.length, 2);
        assert.deepStrictEqual(filtered.map(s => s.name), ['alpha', 'gamma']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER310-02: `filterByTarget`'s two anchors must share a symlink space
//
// Sibling of AP-EXT-ITER310-01 one function over, with a worse failure mode.
// Production sources the two anchors independently: `repoRoot` from
// `git rev-parse --show-toplevel` (pipeline-runner:resolveGitRepoRoot, and the
// `resolve-scope.js` CLI), which git hands back ALREADY realpath-resolved,
// against a `target` that is the raw `pipeline.json:target`. Under a symlinked
// checkout prefix `path.relative` yields a `../`-escaping string, every
// repo-relative path misses it, and the narrowing does not narrow — it EMPTIES.
//
// The three throws that reach are not equally loud, and the loudest is fatal:
// `resolveScope` gives SCOPE_EMPTY_DIFF (demoted by setupScope to a WARN, so a
// scoped session silently runs UNSCOPED) or SCOPE_EMPTY_PATHS, while
// `refreshScope` at anatomy-park gives SCOPE_EMPTY_POST_BUILD — and that phase
// sets `throwOnEmptyScope`, so the throw walks out through `runPhaseIteration`,
// `runPipelinePhaseLoop` and `main`'s try/FINALLY, none of which catch. Measured
// end to end through the real `main()` with the target the only variable:
// direct → exit 0, 2 spawns, 2/2 phases; symlinked → the throw escapes, ZERO
// spawns, 0/2 phases, status `failed`.
//
// The pre-existing fixtures here are synthetic `/repo` anchors that have no
// realpath to take, which is why this file could not fail on the defect.
// ---------------------------------------------------------------------------

function makeSymlinkedRepoFixture() {
    // realpath AT BIRTH: on macOS os.tmpdir() is itself behind /var → /private/var,
    // so an un-resolved base makes the "direct" arm a symlink too and it stops
    // being a control. Never rely on tmpdir being (or not being) a symlink.
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ap310-2-')));
    const repo = path.join(base, 'repo');
    fs.mkdirSync(path.join(repo, 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'other'), { recursive: true });
    git(['init', '-q', '-b', 'main'], repo);
    git(['config', 'commit.gpgsign', 'false'], repo);
    fs.writeFileSync(path.join(repo, 'pkg/a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repo, 'other/b.ts'), 'export const b = 1;\n');
    git(['add', '-A'], repo);
    git(['commit', '-qm', 'base'], repo);
    const baseSha = git(['rev-parse', 'HEAD'], repo);
    // BOTH files change, so a filter degenerating into keep-everything is visible.
    fs.writeFileSync(path.join(repo, 'pkg/a.ts'), 'export const a = 2;\n');
    fs.writeFileSync(path.join(repo, 'other/b.ts'), 'export const b = 2;\n');
    git(['add', '-A'], repo);
    git(['commit', '-qm', 'work'], repo);

    // What production hands in: git's own answer for the root …
    const repoRoot = git(['rev-parse', '--show-toplevel'], repo);
    // … against a target addressed THROUGH an EXPLICIT symlink. Building it
    // here rather than leaning on /tmp keeps the case live on Linux CI, where
    // tmpdir is not a symlink and the axis would otherwise be vacuous.
    const link = path.join(base, 'link');
    fs.symlinkSync(repo, link, 'dir');
    assert.notEqual(
        fs.realpathSync(link), link,
        'fixture invalid: target must reach the repo through a live symlink',
    );

    return { base, repoRoot, baseSha, targetViaLink: path.join(link, 'pkg'), targetDirect: path.join(repo, 'pkg') };
}

function session(base) {
    return fs.mkdtempSync(path.join(base, 'sess-'));
}

test('AP-EXT-ITER310-02: symlinked target still narrows the diff-mode fence instead of emptying it', () => {
    const { base, repoRoot, baseSha, targetViaLink } = makeSymlinkedRepoFixture();
    try {
        const scope = resolveScope({
            scopeFlag: `diff:${baseSha}`,
            scopeBase: null,
            target: targetViaLink,
            sessionRoot: session(base),
            repoRoot,
        });
        // Exactly the in-target file. `other/b.ts` is in the same diff, so an
        // anchor that degenerated into keep-everything would carry it along —
        // this doubles as the blast-radius control on the narrowing itself.
        assert.deepStrictEqual(scope.allowed_paths, ['pkg/a.ts']);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('AP-EXT-ITER310-02: symlinked target still narrows the paths-mode fence instead of emptying it', () => {
    const { base, repoRoot, targetViaLink } = makeSymlinkedRepoFixture();
    try {
        const scope = resolveScope({
            scopeFlag: 'paths:**/*.ts',
            scopeBase: null,
            target: targetViaLink,
            sessionRoot: session(base),
            repoRoot,
        });
        // The glob matches both files; only the target narrowing excludes one.
        assert.deepStrictEqual(scope.allowed_paths, ['pkg/a.ts']);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('AP-EXT-ITER310-02: symlinked target does not fire SCOPE_EMPTY_POST_BUILD at anatomy-park', () => {
    const { base, repoRoot, baseSha, targetViaLink } = makeSymlinkedRepoFixture();
    try {
        const sessionRoot = session(base);
        // Setup resolves with a DIRECT target, so the persisted fence is sound and
        // the only variable left is the raw target refreshScope is handed after.
        resolveScope({
            scopeFlag: `diff:${baseSha}`,
            scopeBase: null,
            target: path.join(repoRoot, 'pkg'),
            sessionRoot,
            repoRoot,
        });
        fs.writeFileSync(
            path.join(sessionRoot, 'state.json'),
            JSON.stringify({ working_dir: repoRoot, phases_entered: [] }),
        );

        // This is the FATAL arm: anatomy-park sets throwOnEmptyScope, and nothing
        // between the throw and the CLI handler catches, so an empty result here
        // costs every remaining phase — not just this one's review surface.
        const refreshed = refreshScope(sessionRoot, 'anatomy-park', {
            repoRoot,
            target: targetViaLink,
            log: () => {},
        });
        assert.deepStrictEqual(refreshed.allowed_paths, ['pkg/a.ts']);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('AP-EXT-ITER310-02: anchoring RESOLVES the target, it does not widen the fence', () => {
    const { base, repoRoot, baseSha, targetViaLink, targetDirect } = makeSymlinkedRepoFixture();
    try {
        const via = resolveScope({
            scopeFlag: `diff:${baseSha}`, scopeBase: null, target: targetViaLink,
            sessionRoot: session(base), repoRoot,
        });
        const direct = resolveScope({
            scopeFlag: `diff:${baseSha}`, scopeBase: null, target: targetDirect,
            sessionRoot: session(base), repoRoot,
        });
        // One tree addressed two ways → one verdict, and `other/b.ts` stays out
        // of both readings. Direction of risk, measured rather than argued.
        assert.deepStrictEqual(via.allowed_paths, direct.allowed_paths);
        assert.deepStrictEqual(direct.allowed_paths, ['pkg/a.ts']);

        // A target with no realpath to take (never created) must still narrow:
        // anchorPair falls back to path.resolve on BOTH sides, so a pair that
        // agreed before anchoring still agrees after.
        const missing = resolveScope({
            scopeFlag: `diff:${baseSha}`, scopeBase: null,
            target: path.join(repoRoot, 'pkg', '..', 'pkg'),
            sessionRoot: session(base), repoRoot,
        });
        assert.deepStrictEqual(missing.allowed_paths, ['pkg/a.ts']);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('AP-EXT-ITER310-02: the repoRoot half of the anchor carries the mirror direction', () => {
    // The wires disagree about WHICH side arrives raw. `refreshPhaseScope` and the
    // `resolve-scope.js` CLI hand in a resolved root against a raw target (the cases
    // above); `setupScope` hands `resolveScope` a RAW `workingDir` as repoRoot, so an
    // operator who supplies an already-resolved `--target` inverts the mismatch.
    // Anchoring only the target would pass every case above and still break here.
    const { base, repoRoot, baseSha, targetDirect } = makeSymlinkedRepoFixture();
    try {
        const rawRoot = path.join(base, 'link'); // the repo addressed through the symlink
        assert.notEqual(fs.realpathSync(rawRoot), rawRoot, 'fixture invalid: root must be raw');
        assert.equal(fs.realpathSync(rawRoot), repoRoot, 'fixture invalid: the two roots must be one tree');

        const scope = resolveScope({
            scopeFlag: `diff:${baseSha}`,
            scopeBase: null,
            target: targetDirect, // resolved target against a raw root
            sessionRoot: session(base),
            repoRoot: rawRoot,
        });
        assert.deepStrictEqual(scope.allowed_paths, ['pkg/a.ts']);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// B-LANES AC-2: every tracked hand-written file the v2.1.0..5fdd4262 diff touches
// maps to exactly ONE lane under the one membership function.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LANE_SOURCE_RE = /\.(ts|js|py|go|rs|java|tsx|jsx)$/;

function gitLines(args) {
    const res = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf-8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(res.status, 0, `git ${args.join(' ')} failed (a shallow clone lacks v2.1.0/5fdd4262): ${res.stderr}`);
    return res.stdout.split('\0').filter(Boolean);
}

test('B-LANES AC-2: every tracked non-generated file in v2.1.0..5fdd4262 maps to exactly one lane', () => {
    const { lanes, generated } = discoverLanes(REPO_ROOT);
    const tracked = new Set(gitLines(['ls-files', '-z']));
    const laneRoots = new Set(lanes.map((l) => l.dir.split('/')[0]));
    const diffFiles = gitLines(['diff', '--name-only', '--no-renames', '-z', 'v2.1.0..5fdd4262'])
        .filter((f) => tracked.has(f) && !generated.has(f) && laneRoots.has(f.split('/')[0]));

    assert.ok(diffFiles.some((f) => /^extension\/tests\/integration\/[^/]+\.test\.js$/.test(f)), 'non-vacuous: integration tests present');
    assert.ok(diffFiles.some((f) => /^extension\/tests\/[^/]+\.test\.js$/.test(f)), 'non-vacuous: loose top-level tests present');
    for (const f of diffFiles) {
        const admitting = lanes.filter((l) => laneAdmits(l, f, generated)).map((l) => l.name);
        assert.equal(admitting.length, 1, `${f} must map to exactly one lane, got [${admitting.join(', ')}]`);
    }

    // Negative control: re-applying the >80% test-only filter to split products
    // drops test lanes, so some diff file stops mapping to any lane.
    const ratioReapplied = lanes.filter((l) => {
        if (l.testRatioApplies) return true;
        const src = [...tracked].filter((f) => LANE_SOURCE_RE.test(f) && !generated.has(f) && laneAdmits(l, f, generated));
        const tests = src.filter((f) => isTestFile(path.posix.basename(f)));
        return src.length >= 3 && tests.length / src.length <= 0.8;
    });
    const unmapped = diffFiles.filter((f) => !ratioReapplied.some((l) => laneAdmits(l, f, generated)));
    assert.ok(unmapped.length > 0, 'the ratio filter must only ever apply to unsplit roots');
});

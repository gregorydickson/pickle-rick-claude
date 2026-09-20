// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveScope, refreshScope, ScopeError } from '../services/scope-resolver.js';

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
    if (res.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed:\n${res.stderr}`);
    }
    return (res.stdout || '').trim();
}

function makeRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-refresh-repo-'));
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'commit.gpgsign', 'false'], dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git(['add', '.'], dir);
    git(['commit', '-qm', 'initial'], dir);
    return dir;
}

function makeSession(repoRoot) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-refresh-session-'));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        active: false,
        working_dir: repoRoot,
        step: 'review',
        iteration: 0,
        max_iterations: 10,
        max_time_minutes: 60,
        worker_timeout_seconds: 1200,
        start_time_epoch: Math.floor(Date.now() / 1000),
        completion_promise: null,
        original_prompt: 'test',
        current_ticket: null,
        history: [],
        started_at: new Date().toISOString(),
        session_dir: dir,
        phases_entered: [],
    }, null, 2));
    return dir;
}

function cleanup(...dirs) {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

test('refreshScope: base_sha frozen across phase refresh', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        git(['checkout', '-qb', 'feature'], repo);
        fs.writeFileSync(path.join(repo, 'f1.ts'), 'v1\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'f1'], repo);

        const initial = resolveScope({
            scopeFlag: 'branch', scopeBase: 'main',
            sessionRoot: session, repoRoot: repo,
        });
        const frozenBase = initial.base_sha;

        // Advance HEAD with a new commit.
        fs.writeFileSync(path.join(repo, 'f2.ts'), 'v2\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'f2'], repo);

        const refreshed = refreshScope(session, 'anatomy-park', { repoRoot: repo });
        assert.ok(refreshed, 'refreshScope returns scope for first entry');
        assert.equal(refreshed.base_sha, frozenBase, 'base_sha unchanged after refresh');
        assert.notEqual(refreshed.head_sha, initial.head_sha, 'head_sha advanced');
    } finally {
        cleanup(repo, session);
    }
});

test('refreshScope: HEAD advances and allowed_paths recomputed', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        git(['checkout', '-qb', 'feature'], repo);
        fs.writeFileSync(path.join(repo, 'first.ts'), 'a\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'first'], repo);

        resolveScope({
            scopeFlag: 'branch', scopeBase: 'main',
            sessionRoot: session, repoRoot: repo,
        });

        // Second commit adds another file → allowed_paths should grow.
        fs.writeFileSync(path.join(repo, 'second.ts'), 'b\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'second'], repo);

        const newHead = git(['rev-parse', 'HEAD'], repo);
        const refreshed = refreshScope(session, 'anatomy-park', { repoRoot: repo });
        assert.ok(refreshed);
        assert.equal(refreshed.head_sha, newHead, 'head_sha equals current HEAD');
        assert.deepStrictEqual(refreshed.allowed_paths, ['first.ts', 'second.ts']);
    } finally {
        cleanup(repo, session);
    }
});

test('refreshScope: writes archive/scope.<phase>.json', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        git(['checkout', '-qb', 'feature'], repo);
        fs.writeFileSync(path.join(repo, 'f.ts'), 'v\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'f'], repo);

        resolveScope({
            scopeFlag: 'branch', scopeBase: 'main',
            sessionRoot: session, repoRoot: repo,
        });

        const refreshed = refreshScope(session, 'anatomy-park', { repoRoot: repo });
        const archivePath = path.join(session, 'archive', 'scope.anatomy-park.json');
        assert.ok(fs.existsSync(archivePath), 'archive file exists');
        const archived = JSON.parse(fs.readFileSync(archivePath, 'utf-8'));
        assert.deepStrictEqual(archived, refreshed, 'archive equals returned scope');
    } finally {
        cleanup(repo, session);
    }
});

test('refreshScope: idempotent — second call for same phase is a no-op', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        git(['checkout', '-qb', 'feature'], repo);
        fs.writeFileSync(path.join(repo, 'f.ts'), 'v\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'f'], repo);

        resolveScope({
            scopeFlag: 'branch', scopeBase: 'main',
            sessionRoot: session, repoRoot: repo,
        });

        const first = refreshScope(session, 'anatomy-park', { repoRoot: repo });
        assert.ok(first, 'first refresh returns scope');

        const second = refreshScope(session, 'anatomy-park', { repoRoot: repo });
        assert.equal(second, null, 'second refresh for same phase returns null');

        const scope = JSON.parse(fs.readFileSync(path.join(session, 'scope.json'), 'utf-8'));
        assert.equal(scope.refresh_history.length, 1, 'refresh_history has exactly one entry');
        assert.equal(scope.refresh_history[0].phase, 'anatomy-park');

        const state = JSON.parse(fs.readFileSync(path.join(session, 'state.json'), 'utf-8'));
        assert.deepStrictEqual(state.phases_entered, ['anatomy-park']);
    } finally {
        cleanup(repo, session);
    }
});

test('refreshScope: promotes newer dead-writer scope.json tmp before recomputing allowed paths', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        const head = git(['rev-parse', 'HEAD'], repo);
        const staleScope = {
            version: 1,
            mode: 'paths',
            strategy: 'strict',
            base_ref: null,
            base_sha: null,
            head_sha: head,
            allowed_paths: ['stale.ts'],
            resolved_at: new Date().toISOString(),
            refresh_history: [],
        };
        const recoveredScope = {
            ...staleScope,
            allowed_paths: ['live.ts'],
        };
        const scopePath = path.join(session, 'scope.json');
        const tmpPath = path.join(session, 'scope.json.tmp.99999999');
        fs.writeFileSync(scopePath, JSON.stringify(staleScope, null, 2));
        fs.writeFileSync(tmpPath, JSON.stringify(recoveredScope, null, 2));
        fs.utimesSync(scopePath, new Date('2026-04-01T00:00:00.000Z'), new Date('2026-04-01T00:00:00.000Z'));
        fs.utimesSync(tmpPath, new Date('2026-04-02T00:00:00.000Z'), new Date('2026-04-02T00:00:00.000Z'));

        const refreshed = refreshScope(session, 'anatomy-park', { repoRoot: repo });

        assert.ok(refreshed);
        assert.deepStrictEqual(refreshed.allowed_paths, ['live.ts']);
        assert.equal(fs.existsSync(tmpPath), false, 'dead-writer tmp should be promoted or removed');
        const persisted = JSON.parse(fs.readFileSync(scopePath, 'utf-8'));
        assert.deepStrictEqual(persisted.allowed_paths, ['live.ts']);
    } finally {
        cleanup(repo, session);
    }
});

test('refreshScope: recovers dead-writer scope.json tmp when base scope is missing', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        const head = git(['rev-parse', 'HEAD'], repo);
        const recoveredScope = {
            version: 1,
            mode: 'paths',
            strategy: 'strict',
            base_ref: null,
            base_sha: null,
            head_sha: head,
            allowed_paths: ['live.ts'],
            resolved_at: new Date().toISOString(),
            refresh_history: [],
        };
        const scopePath = path.join(session, 'scope.json');
        const tmpPath = path.join(session, 'scope.json.tmp.99999999');
        fs.writeFileSync(tmpPath, JSON.stringify(recoveredScope, null, 2));

        const refreshed = refreshScope(session, 'anatomy-park', { repoRoot: repo });

        assert.ok(refreshed);
        assert.deepStrictEqual(refreshed.allowed_paths, ['live.ts']);
        assert.equal(fs.existsSync(scopePath), true, 'dead-writer tmp should be promoted to scope.json');
        assert.equal(fs.existsSync(tmpPath), false, 'dead-writer tmp should be removed after promotion');
        const persisted = JSON.parse(fs.readFileSync(scopePath, 'utf-8'));
        assert.deepStrictEqual(persisted.allowed_paths, ['live.ts']);
    } finally {
        cleanup(repo, session);
    }
});

test('R-SRAA #53: refreshScope rotates a pre-existing archive instead of FATAL on relaunch', () => {
    // Reproduces BUG-REPORT-2026-05-18 Bug 6: launch #1 wrote
    // archive/scope.<phase>.json then crashed before updating phases_entered,
    // so launch #2 saw the leftover archive and FATALed with
    // SCOPE_ARCHIVE_EXISTS — making every relaunch require manual `rm`. The
    // archive now rotates to a timestamped `.<epochMs>.bak` sibling and the
    // relaunch proceeds.
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        git(['checkout', '-qb', 'feature'], repo);
        fs.writeFileSync(path.join(repo, 'f.ts'), 'v\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'f'], repo);

        resolveScope({
            scopeFlag: 'branch', scopeBase: 'main',
            sessionRoot: session, repoRoot: repo,
        });

        // Simulate launch #1's leftover: archive exists, but phases_entered
        // does not yet include the phase (the crash window).
        const archiveDir = path.join(session, 'archive');
        fs.mkdirSync(archiveDir, { recursive: true });
        const leftover = path.join(archiveDir, 'scope.anatomy-park.json');
        fs.writeFileSync(leftover, JSON.stringify({ leftover: true }));

        const result = refreshScope(session, 'anatomy-park', { repoRoot: repo });
        assert.ok(result, 'relaunch must proceed without FATAL');
        assert.equal(result.head_sha?.length, 40, 'fresh archive carries the new HEAD');

        // The leftover was rotated to a `.<epochMs>.bak` sibling.
        const rotated = fs.readdirSync(archiveDir)
            .filter((name) => /^scope\.anatomy-park\.json\.\d+\.bak$/.test(name));
        assert.equal(rotated.length, 1, `expected exactly one rotated archive, got ${rotated.join(', ')}`);
        const rotatedContent = JSON.parse(fs.readFileSync(path.join(archiveDir, rotated[0]), 'utf-8'));
        assert.equal(rotatedContent.leftover, true, 'rotated file must preserve the prior archive content');

        // The fresh archive at the canonical path is the new run, not the leftover.
        const fresh = JSON.parse(fs.readFileSync(leftover, 'utf-8'));
        assert.notEqual(fresh.leftover, true, 'canonical archive path now carries the relaunch result');
    } finally {
        cleanup(repo, session);
    }
});

test('refreshScope: emits "scope-refresh:" log line with phase, head, allowed count', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        git(['checkout', '-qb', 'feature'], repo);
        fs.writeFileSync(path.join(repo, 'f.ts'), 'v\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'f'], repo);

        resolveScope({
            scopeFlag: 'branch', scopeBase: 'main',
            sessionRoot: session, repoRoot: repo,
        });

        const messages = [];
        const log = (msg) => messages.push(msg);
        const refreshed = refreshScope(session, 'anatomy-park', { repoRoot: repo, log });
        assert.ok(refreshed);

        const match = messages.find((m) => m.startsWith('scope-refresh:'));
        assert.ok(match, `expected a scope-refresh log line, got: ${JSON.stringify(messages)}`);
        assert.match(match, /^scope-refresh: phase=anatomy-park head=[0-9a-f]{40} allowed=1$/);
    } finally {
        cleanup(repo, session);
    }
});

test('refreshScope: no scope.json → returns null (scope not configured)', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        // Session has no scope.json — scope not configured.
        const result = refreshScope(session, 'anatomy-park', { repoRoot: repo });
        assert.equal(result, null);
        assert.ok(!fs.existsSync(path.join(session, 'archive', 'scope.anatomy-park.json')));
    } finally {
        cleanup(repo, session);
    }
});

test('refreshScope: SCOPE_EMPTY_POST_BUILD at anatomy-park when diff collapses to zero', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        // Build a scope.json by hand where base_sha === HEAD so the refresh
        // diff is empty. Mirrors the case where pickle committed nothing.
        const head = git(['rev-parse', 'HEAD'], repo);
        const scope = {
            version: 1,
            mode: 'branch',
            strategy: 'strict',
            base_ref: 'main',
            base_sha: head,
            head_sha: head,
            allowed_paths: [],
            resolved_at: new Date().toISOString(),
            refresh_history: [],
        };
        fs.writeFileSync(path.join(session, 'scope.json'), JSON.stringify(scope, null, 2));

        assert.throws(
            () => refreshScope(session, 'anatomy-park', { repoRoot: repo }),
            (err) => err instanceof ScopeError && err.code === 'SCOPE_EMPTY_POST_BUILD',
        );
    } finally {
        cleanup(repo, session);
    }
});

test('refreshScope: paths-mode preserves allowed_paths (no HEAD dependency)', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        fs.mkdirSync(path.join(repo, 'src'));
        fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'a\n');
        fs.writeFileSync(path.join(repo, 'src', 'b.ts'), 'b\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'src'], repo);

        resolveScope({
            scopeFlag: 'paths:src/*.ts',
            sessionRoot: session, repoRoot: repo,
        });

        // Advance HEAD — paths mode must not react to it.
        fs.writeFileSync(path.join(repo, 'unrelated.ts'), 'u\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'unrelated'], repo);

        const refreshed = refreshScope(session, 'szechuan-sauce', { repoRoot: repo });
        assert.ok(refreshed);
        assert.deepStrictEqual(refreshed.allowed_paths, ['src/a.ts', 'src/b.ts']);
    } finally {
        cleanup(repo, session);
    }
});

test('refreshScope: empty diff at non-anatomy phase is tolerated (no throw)', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        const head = git(['rev-parse', 'HEAD'], repo);
        const scope = {
            version: 1,
            mode: 'branch',
            strategy: 'strict',
            base_ref: 'main',
            base_sha: head,
            head_sha: head,
            allowed_paths: [],
            resolved_at: new Date().toISOString(),
            refresh_history: [],
        };
        fs.writeFileSync(path.join(session, 'scope.json'), JSON.stringify(scope, null, 2));

        // szechuan-sauce does not raise SCOPE_EMPTY_POST_BUILD on empty diff.
        const refreshed = refreshScope(session, 'szechuan-sauce', { repoRoot: repo });
        assert.ok(refreshed);
        assert.deepStrictEqual(refreshed.allowed_paths, []);
    } finally {
        cleanup(repo, session);
    }
});

test('refreshScope: unreadable state.json is logged, not swallowed, before treating the phase as not entered', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        fs.writeFileSync(path.join(session, 'state.json'), '{ not json');
        const logs = [];
        try {
            refreshScope(session, 'anatomy-park', { repoRoot: repo, log: (m) => logs.push(m) });
        } catch {
            // Downstream behaviour on a corrupt state is not under test here.
        }
        assert.ok(
            logs.some((m) => m.includes('scope-refresh: phase=anatomy-park could not read')),
            `expected a state-read breadcrumb, got: ${JSON.stringify(logs)}`,
        );
    } finally {
        cleanup(repo, session);
    }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER323-01 — refreshScope derives its own repo-root anchor.
//
// Closes the axis this file was previously VACUOUS on: every pre-existing
// `refreshScope(` case above passes `{ repoRoot: repo }` where `repo` IS the git
// toplevel, so the cwd space and the repo space are the same space and neither the
// caller-trusted parameter nor the `state.working_dir` fallback can be wrong.
//
// The defect is only expressible with a REAL git repo, work BOTH above and below
// the package dir, and a below-toplevel base. Each case asserts AGREEMENT with the
// toplevel reading of the SAME target rather than mere non-emptiness — a fence
// spelled in the wrong space looks exactly like one that legitimately matched
// little, and in the other direction exactly like one that legitimately matched a lot.
// ---------------------------------------------------------------------------

/** A repo whose diff touches a path ABOVE `pkg/sub` and one INSIDE it. */
function makeNestedRepo() {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-refresh-nested-'));
    git(['init', '-q', '-b', 'main'], repo);
    git(['config', 'commit.gpgsign', 'false'], repo);
    fs.mkdirSync(path.join(repo, 'alpha'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'pkg', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
    git(['add', '.'], repo);
    git(['commit', '-qm', 'base'], repo);
    git(['checkout', '-qb', 'feature'], repo);
    fs.writeFileSync(path.join(repo, 'alpha', 'a1.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repo, 'pkg', 'sub', 'b1.ts'), 'export const b = 1;\n');
    git(['add', '.'], repo);
    git(['commit', '-qm', 'work'], repo);
    return { repo, below: path.join(repo, 'pkg', 'sub') };
}

/** A session whose persisted scope was resolved from the TOPLEVEL, as setup does. */
function makeNestedSession(repo, workingDir) {
    const session = makeSession(workingDir);
    resolveScope({ scopeFlag: 'branch', scopeBase: 'main', sessionRoot: session, repoRoot: repo });
    return session;
}

test('AP-EXT-ITER323-01: FIXTURE PRECONDITION — the toplevel reading sees work above AND below pkg/sub', () => {
    const { repo } = makeNestedRepo();
    const session = makeNestedSession(repo, repo);
    try {
        const refreshed = refreshScope(session, 'anatomy-park', { repoRoot: repo, log: () => {} });
        assert.deepStrictEqual(
            refreshed.allowed_paths,
            ['alpha/a1.ts', 'pkg/sub/b1.ts'],
            'fixture must straddle the package dir, or the cases below cannot separate the two path spaces',
        );
    } finally {
        cleanup(repo, session);
    }
});

test('AP-EXT-ITER323-01: a below-toplevel opts.repoRoot agrees with the toplevel reading (target ABOVE it)', () => {
    const { repo, below } = makeNestedRepo();
    const control = makeNestedSession(repo, repo);
    const subject = makeNestedSession(repo, repo);
    try {
        // Pre-fix this is the FATAL arm: `path.relative(pkg/sub, <toplevel>)` is `../..`,
        // every repo-relative diff path fails the prefix test, and anatomy-park's
        // throwOnEmptyScope turns the empty result into SCOPE_EMPTY_POST_BUILD — which
        // ends the pipeline, not just this phase's review surface.
        const expected = refreshScope(control, 'anatomy-park', { repoRoot: repo, target: repo, log: () => {} });
        const actual = refreshScope(subject, 'anatomy-park', { repoRoot: below, target: repo, log: () => {} });
        assert.deepStrictEqual(actual.allowed_paths, expected.allowed_paths);
        assert.deepStrictEqual(actual.allowed_paths, ['alpha/a1.ts', 'pkg/sub/b1.ts']);
    } finally {
        cleanup(repo, control, subject);
    }
});

test('AP-EXT-ITER323-01: a below-toplevel opts.repoRoot agrees with the toplevel reading (target IS it)', () => {
    const { repo, below } = makeNestedRepo();
    const control = makeNestedSession(repo, repo);
    const subject = makeNestedSession(repo, repo);
    try {
        // The other direction, and the DEFAULT one — `config.target || workingDir` makes
        // target === repoRoot whenever no explicit target is configured. Pre-fix
        // `path.relative(pkg/sub, pkg/sub)` is '', filterByTarget returns early, and the
        // fence ADMITS `alpha/a1.ts` — a path outside the target the session narrowed to.
        const expected = refreshScope(control, 'anatomy-park', { repoRoot: repo, target: below, log: () => {} });
        const actual = refreshScope(subject, 'anatomy-park', { repoRoot: below, target: below, log: () => {} });
        assert.deepStrictEqual(actual.allowed_paths, expected.allowed_paths);
        assert.deepStrictEqual(actual.allowed_paths, ['pkg/sub/b1.ts'], 'target narrowing must survive the anchor');
    } finally {
        cleanup(repo, control, subject);
    }
});

test('AP-EXT-ITER323-01: the state.working_dir fallback is anchored too (opts.repoRoot omitted)', () => {
    const { repo, below } = makeNestedRepo();
    const control = makeNestedSession(repo, repo);
    // Only variable: state.working_dir, an unnormalized process.cwd() that is a
    // documented monorepo package dir — never reconciled to --show-toplevel.
    const subject = makeNestedSession(repo, below);
    try {
        const expected = refreshScope(control, 'anatomy-park', { repoRoot: repo, target: repo, log: () => {} });
        const actual = refreshScope(subject, 'anatomy-park', { target: repo, log: () => {} });
        assert.deepStrictEqual(actual.allowed_paths, expected.allowed_paths);
        assert.deepStrictEqual(actual.allowed_paths, ['alpha/a1.ts', 'pkg/sub/b1.ts']);
    } finally {
        cleanup(repo, control, subject);
    }
});

test('AP-EXT-ITER323-01: anchoring NARROWS nothing it should not — a non-repo base still refuses', () => {
    // Negative control: the anchor must not become a way to succeed from anywhere.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-refresh-nonrepo-'));
    const { repo } = makeNestedRepo();
    const session = makeNestedSession(repo, repo);
    try {
        assert.throws(
            () => refreshScope(session, 'anatomy-park', { repoRoot: outside, log: () => {} }),
            (err) => err instanceof ScopeError && err.code === 'SCOPE_NOT_A_REPO',
        );
    } finally {
        cleanup(repo, session, outside);
    }
});

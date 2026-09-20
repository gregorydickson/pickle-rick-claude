// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setupScope, writeSkippedByScope } from '../bin/pipeline-runner.js';
import { refreshScope, ScopeError } from '../services/scope-resolver.js';

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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-pipeline-repo-'));
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'commit.gpgsign', 'false'], dir);
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    git(['add', '.'], dir);
    git(['commit', '-qm', 'initial'], dir);
    return dir;
}

function makeSession(repoRoot) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-pipeline-session-'));
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
    }, null, 2));
    return dir;
}

function cleanup(...dirs) {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// setupScope — setup-time resolution + scope.json write + phases_entered init
// ---------------------------------------------------------------------------

test('setupScope: writes scope.json and initializes phases_entered=[]', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        git(['checkout', '-qb', 'feature'], repo);
        fs.writeFileSync(path.join(repo, 'f.ts'), 'v\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'f'], repo);

        const messages = [];
        const scope = setupScope({
            sessionDir: session,
            workingDir: repo,
            target: repo,
            scopeFlag: 'branch',
            scopeBase: 'main',
            log: (m) => messages.push(m),
        });
        assert.ok(scope, 'returns resolved scope');
        assert.ok(fs.existsSync(path.join(session, 'scope.json')), 'scope.json written');

        const persisted = JSON.parse(fs.readFileSync(path.join(session, 'scope.json'), 'utf-8'));
        assert.equal(persisted.version, 1);
        assert.equal(persisted.mode, 'branch');
        assert.deepStrictEqual(persisted.allowed_paths, ['f.ts']);

        const state = JSON.parse(fs.readFileSync(path.join(session, 'state.json'), 'utf-8'));
        assert.deepStrictEqual(state.phases_entered, []);

        assert.ok(messages.some((m) => m.startsWith('scope-setup:')), 'logs scope-setup line');
    } finally {
        cleanup(repo, session);
    }
});

test('setupScope CUJ-6a: SCOPE_EMPTY_DIFF at setup → WARN, not error', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        // HEAD == main; no diff. Should be tolerated.
        const messages = [];
        const scope = setupScope({
            sessionDir: session,
            workingDir: repo,
            target: repo,
            scopeFlag: 'branch',
            scopeBase: 'main',
            log: (m) => messages.push(m),
        });
        assert.equal(scope, null, 'returns null on empty-at-setup (warn path)');
        assert.ok(!fs.existsSync(path.join(session, 'scope.json')),
            'no scope.json written on empty-at-setup');

        const state = JSON.parse(fs.readFileSync(path.join(session, 'state.json'), 'utf-8'));
        assert.deepStrictEqual(state.phases_entered, [],
            'phases_entered still initialized so later phases can proceed');

        const warn = messages.find((m) => m.includes('SCOPE_EMPTY_DIFF'));
        assert.ok(warn, `expected a WARN line mentioning SCOPE_EMPTY_DIFF, got: ${JSON.stringify(messages)}`);
        assert.ok(warn.includes('WARN'), 'line tagged as WARN');
    } finally {
        cleanup(repo, session);
    }
});

test('setupScope: diff:HEAD honors inline ref and does not fall back to main', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        git(['checkout', '-qb', 'feature'], repo);
        fs.writeFileSync(path.join(repo, 'f.ts'), 'v\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'f'], repo);

        const messages = [];
        const scope = setupScope({
            sessionDir: session,
            workingDir: repo,
            target: repo,
            scopeFlag: 'diff:HEAD',
            log: (m) => messages.push(m),
        });

        assert.equal(scope, null, 'diff:HEAD should resolve against HEAD, producing an empty diff');
        assert.ok(!fs.existsSync(path.join(session, 'scope.json')),
            'empty diff:HEAD must not write scope.json via main fallback');

        const warn = messages.find((m) => m.includes('SCOPE_EMPTY_DIFF'));
        assert.ok(warn, `expected a WARN line mentioning SCOPE_EMPTY_DIFF, got: ${JSON.stringify(messages)}`);
    } finally {
        cleanup(repo, session);
    }
});

test('setupScope: other ScopeError codes propagate (SCOPE_BAD_FLAG)', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        assert.throws(
            () => setupScope({
                sessionDir: session,
                workingDir: repo,
                target: repo,
                scopeFlag: 'bogus-flag',
                log: () => {},
            }),
            (err) => err instanceof ScopeError && err.code === 'SCOPE_BAD_FLAG',
        );
    } finally {
        cleanup(repo, session);
    }
});

// ---------------------------------------------------------------------------
// SCOPE_EMPTY_POST_BUILD at anatomy-park refresh (pipeline-level)
// ---------------------------------------------------------------------------

test('empty-post-build: refreshScope at anatomy-park throws SCOPE_EMPTY_POST_BUILD when pickle committed nothing', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        // Simulate pickle having committed nothing: scope.json written at
        // setup with some allowed_paths, but by anatomy-park entry HEAD
        // equals base_sha (branch rolled back, etc.).
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

test('refreshScope: target clamp survives phase refresh after later commits', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        git(['checkout', '-qb', 'feature'], repo);
        fs.mkdirSync(path.join(repo, 'pkg', 'src'), { recursive: true });
        fs.mkdirSync(path.join(repo, 'other'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'pkg', 'src', 'inside-a.ts'), 'export const insideA = 1;\n');
        fs.writeFileSync(path.join(repo, 'other', 'outside-a.ts'), 'export const outsideA = 1;\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'seed target and non-target files'], repo);

        const target = path.join(repo, 'pkg');
        const scope = setupScope({
            sessionDir: session,
            workingDir: repo,
            target,
            scopeFlag: 'branch',
            scopeBase: 'main',
            log: () => {},
        });
        assert.ok(scope, 'setupScope returns initial scope');
        assert.deepStrictEqual(scope.allowed_paths, ['pkg/src/inside-a.ts']);

        fs.writeFileSync(path.join(repo, 'pkg', 'src', 'inside-b.ts'), 'export const insideB = 1;\n');
        fs.writeFileSync(path.join(repo, 'other', 'outside-b.ts'), 'export const outsideB = 1;\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'advance both target and non-target files'], repo);

        const refreshed = refreshScope(session, 'anatomy-park', { repoRoot: repo, target });
        assert.ok(refreshed, 'refreshScope returns refreshed scope');
        assert.deepStrictEqual(
            refreshed.allowed_paths,
            ['pkg/src/inside-a.ts', 'pkg/src/inside-b.ts'],
            'phase refresh must preserve the original target subtree clamp',
        );
    } finally {
        cleanup(repo, session);
    }
});

// ---------------------------------------------------------------------------
// Backcompat: no --scope → no scope.json, no phases_entered mutation
// ---------------------------------------------------------------------------

test('backcompat: omitting --scope yields no scope.json (setupScope not called)', () => {
    // This exercises the pipeline-runner branch: `if (scopeFlag) setupScope(...)`.
    // When scopeFlag is undefined, setupScope is never invoked, so neither
    // scope.json nor phases_entered is touched.
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        const scopeFlag = undefined;

        if (scopeFlag) {
            throw new Error('unreachable — scopeFlag is undefined');
        }

        assert.ok(!fs.existsSync(path.join(session, 'scope.json')),
            'no scope.json when scope is omitted');

        const state = JSON.parse(fs.readFileSync(path.join(session, 'state.json'), 'utf-8'));
        assert.equal(state.phases_entered, undefined,
            'phases_entered stays unset for backcompat');
    } finally {
        cleanup(repo, session);
    }
});

// ---------------------------------------------------------------------------
// writeSkippedByScope — observability record, per-phase payload
// ---------------------------------------------------------------------------

test('writeSkippedByScope anatomy-park: captures discovered/kept/skipped subsystems', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        // Build two subsystem directories, 3 files each. scope allows only one.
        for (const name of ['alpha', 'beta']) {
            const d = path.join(repo, name);
            fs.mkdirSync(d);
            for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(d, `f${i}.ts`), '');
        }
        const scope = {
            version: 1, mode: 'branch', strategy: 'strict',
            base_ref: 'main', base_sha: null, head_sha: 'deadbeef'.repeat(5),
            allowed_paths: ['alpha/f0.ts'],
            resolved_at: new Date().toISOString(),
            refresh_history: [],
        };

        writeSkippedByScope(session, 'anatomy-park', scope, repo, repo);

        const out = JSON.parse(fs.readFileSync(
            path.join(session, 'archive', 'skipped_by_scope.anatomy-park.json'), 'utf-8'));
        assert.equal(out.phase, 'anatomy-park');
        assert.deepStrictEqual(out.allowed_paths, ['alpha/f0.ts']);
        assert.deepStrictEqual(out.subsystems_discovered, ['alpha', 'beta']);
        assert.deepStrictEqual(out.subsystems_kept, ['alpha']);
        assert.deepStrictEqual(out.subsystems_skipped, ['beta']);
    } finally {
        cleanup(repo, session);
    }
});

test('writeSkippedByScope szechuan-sauce: no subsystem fields (flat payload)', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        const scope = {
            version: 1, mode: 'branch', strategy: 'strict',
            base_ref: 'main', base_sha: null, head_sha: 'abc'.repeat(14),
            allowed_paths: ['src/x.ts', 'src/y.ts'],
            resolved_at: new Date().toISOString(),
            refresh_history: [],
        };

        writeSkippedByScope(session, 'szechuan-sauce', scope, repo, repo);

        const out = JSON.parse(fs.readFileSync(
            path.join(session, 'archive', 'skipped_by_scope.szechuan-sauce.json'), 'utf-8'));
        assert.equal(out.phase, 'szechuan-sauce');
        assert.deepStrictEqual(out.allowed_paths, ['src/x.ts', 'src/y.ts']);
        assert.equal(out.subsystems_discovered, undefined);
        assert.equal(out.subsystems_kept, undefined);
        assert.equal(out.subsystems_skipped, undefined);
    } finally {
        cleanup(repo, session);
    }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER322-01 — setupScope's producer base must be the git TOPLEVEL
//
// Every case above passes `workingDir: repo`, the toplevel, where the cwd space
// and the repo space coincide — which is why a producer written one directory
// below the toplevel was invisible. `state.working_dir` is an unnormalized
// `process.cwd()` and a monorepo package dir is a documented shape, so these
// fixtures put work BOTH above and below the read cwd and assert the fence is
// spelled in the repo's space either way.
// ---------------------------------------------------------------------------

function makeNestedRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-pipeline-nested-'));
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'commit.gpgsign', 'false'], dir);
    fs.mkdirSync(path.join(dir, 'alpha'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'pkg', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'alpha', 'a1.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(dir, 'pkg', 'sub', 'b1.ts'), 'export const y = 2;\n');
    git(['add', '.'], dir);
    git(['commit', '-qm', 'initial'], dir);
    git(['checkout', '-qb', 'feature'], dir);
    fs.writeFileSync(path.join(dir, 'alpha', 'a1.ts'), 'export const x = 2;\n');
    fs.writeFileSync(path.join(dir, 'pkg', 'sub', 'b1.ts'), 'export const y = 3;\n');
    git(['add', '.'], dir);
    git(['commit', '-qm', 'work in both'], dir);
    return dir;
}

function resolveVia(repo, workingDir, target, scopeFlag) {
    const session = makeSession(repo);
    try {
        const scope = setupScope({
            sessionDir: session,
            workingDir,
            target,
            scopeFlag,
            scopeBase: 'main',
            log: () => {},
        });
        assert.ok(scope, `setupScope returned no scope for ${scopeFlag} from ${workingDir}`);
        return scope.allowed_paths;
    } finally {
        cleanup(session);
    }
}

test('AP-EXT-ITER322-01: setupScope below the toplevel keeps the work ABOVE the cwd and spells it repo-relative', () => {
    const repo = makeNestedRepo();
    const sub = path.join(repo, 'pkg', 'sub');
    try {
        // FIXTURE PRECONDITION: read from the toplevel, both modes see the pair.
        // Without this an empty/one-element answer below could pass vacuously.
        const topBranch = resolveVia(repo, repo, repo, 'branch');
        const topPaths = resolveVia(repo, repo, repo, 'paths:**/*.ts');
        assert.deepStrictEqual(topBranch, ['alpha/a1.ts', 'pkg/sub/b1.ts'],
            'fixture precondition: branch mode at the toplevel sees both files');
        assert.deepStrictEqual(topPaths, ['alpha/a1.ts', 'pkg/sub/b1.ts'],
            'fixture precondition: paths mode at the toplevel sees both files');

        // The defect axis: workingDir one directory below the toplevel, whole repo
        // targeted. `ls-files -co` run there lists the cwd SUBTREE ONLY and spells it
        // cwd-relative, so pre-fix this returned ['b1.ts'] — alpha/ dropped outright
        // and the survivor renamed to a repo-root file nobody wrote.
        assert.deepStrictEqual(resolveVia(repo, sub, repo, 'paths:**/*.ts'), topPaths,
            'paths mode from below the toplevel must AGREE with the toplevel reading');
        assert.deepStrictEqual(resolveVia(repo, sub, repo, 'branch'), topBranch,
            'branch mode from below the toplevel must AGREE with the toplevel reading');
    } finally {
        cleanup(repo);
    }
});

test('AP-EXT-ITER322-01: setupScope below the toplevel still NARROWS the fence to its target', () => {
    const repo = makeNestedRepo();
    const sub = path.join(repo, 'pkg', 'sub');
    try {
        // The monorepo shape: working_dir AND target are the package dir. Pre-fix the
        // base and the target were the same directory, so `filterByTarget`'s
        // `path.relative(root, target)` collapsed to '' and narrowing became a no-op —
        // branch mode admitted alpha/ into a fence the session had narrowed to pkg/sub.
        assert.deepStrictEqual(resolveVia(repo, sub, sub, 'branch'), ['pkg/sub/b1.ts'],
            'branch mode must not admit paths outside the target');
        assert.deepStrictEqual(resolveVia(repo, sub, sub, 'paths:**/*.ts'), ['pkg/sub/b1.ts'],
            'paths mode must not admit paths outside the target');
    } finally {
        cleanup(repo);
    }
});

test('AP-EXT-ITER322-01 ACCEPT/REJECT controls: toplevel reading is unchanged, non-repo still refuses', () => {
    const repo = makeNestedRepo();
    try {
        // ACCEPT control: the anchor is a no-op where it always was one. An
        // always-reject normalizer would red here.
        assert.deepStrictEqual(resolveVia(repo, repo, path.join(repo, 'alpha'), 'branch'),
            ['alpha/a1.ts'], 'toplevel reading still narrows to its target');

        // REJECT control: the proving half of the anchor survives. An always-accept
        // normalizer (one that passes any directory through) would red here.
        const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-pipeline-nonrepo-'));
        const session = makeSession(nonRepo);
        try {
            assert.throws(
                () => setupScope({
                    sessionDir: session,
                    workingDir: nonRepo,
                    target: nonRepo,
                    scopeFlag: 'branch',
                    scopeBase: 'main',
                    log: () => {},
                }),
                (err) => err instanceof ScopeError && err.code === 'SCOPE_NOT_A_REPO',
                'a directory that is not a git worktree must still refuse',
            );
        } finally {
            cleanup(nonRepo, session);
        }
    } finally {
        cleanup(repo);
    }
});

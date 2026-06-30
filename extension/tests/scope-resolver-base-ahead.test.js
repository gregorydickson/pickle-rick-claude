// @tier: fast
// R-SSBR: scope-resolver fail-CLOSED on a stale/ahead base ref. Covers the ancestry
// sanity-check in resolveAllowedFromDiffMode (SCOPE_BASE_AHEAD_OF_HEAD vs legitimate
// SCOPE_EMPTY_DIFF) and the pipeline-runner fail-closed runner disposition.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setupScope } from '../bin/pipeline-runner.js';
import { resolveScope, ScopeError } from '../services/scope-resolver.js';

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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-base-ahead-repo-'));
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'commit.gpgsign', 'false'], dir);
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    git(['add', '.'], dir);
    git(['commit', '-qm', 'initial'], dir);
    return dir;
}

function makeSession(repoRoot) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-base-ahead-session-'));
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

/**
 * Builds the canonical "ahead" repo: `main` and `feature` both start at commit A
 * (feature never diverges with commits of its own), then `main` advances past A with
 * a second commit B. On `feature` (checked out as HEAD), `merge-base(main, HEAD) ===
 * headSha === A`, but `rev-parse(main) === B !== headSha` — main is strictly ahead of
 * HEAD, and HEAD has no commits of its own to recover. No candidate in
 * resolveForkPointBase can produce a non-empty diff (feature genuinely has zero work).
 */
function makeAheadRepoNoRecovery() {
    const repo = makeRepo();
    git(['checkout', '-qb', 'feature'], repo);
    git(['checkout', '-q', 'main'], repo);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    git(['add', '.'], repo);
    git(['commit', '-qm', 'second_on_main'], repo);
    git(['checkout', '-q', 'feature'], repo);
    return repo;
}

// ---------------------------------------------------------------------------
// (throw is primary)
// ---------------------------------------------------------------------------

test('resolveScope: auto-default base ahead of HEAD with no recoverable fork-point throws SCOPE_BASE_AHEAD_OF_HEAD', () => {
    const repo = makeAheadRepoNoRecovery();
    const session = makeSession(repo);
    try {
        assert.throws(
            () => resolveScope({
                scopeFlag: 'branch',
                scopeBase: 'main',
                sessionRoot: session,
                repoRoot: repo,
            }),
            (err) => err instanceof ScopeError && err.code === 'SCOPE_BASE_AHEAD_OF_HEAD',
        );
    } finally {
        cleanup(repo, session);
    }
});

// ---------------------------------------------------------------------------
// (reflog-starved fixture)
// ---------------------------------------------------------------------------

test('resolveScope: reflog-starved base (tag, no reflog) ahead of HEAD still throws SCOPE_BASE_AHEAD_OF_HEAD, never spurious SCOPE_EMPTY_DIFF', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        // feature stays at the initial commit (no work of its own).
        git(['checkout', '-qb', 'feature'], repo);
        // A throwaway branch advances past the initial commit and gets tagged; tags
        // carry no reflog, so `git merge-base --fork-point <tag> HEAD` yields nothing
        // (distinct failure mode from the fork-point-resolves-to-headSha case).
        git(['checkout', '-qb', 'temp-advance', 'main'], repo);
        fs.writeFileSync(path.join(repo, 'd.txt'), 'd\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'advance'], repo);
        git(['tag', 'stale-tag'], repo);
        git(['checkout', '-q', 'feature'], repo);

        assert.throws(
            () => resolveScope({
                scopeFlag: 'branch',
                scopeBase: 'stale-tag',
                sessionRoot: session,
                repoRoot: repo,
            }),
            (err) => err instanceof ScopeError && err.code === 'SCOPE_BASE_AHEAD_OF_HEAD',
        );
    } finally {
        cleanup(repo, session);
    }
});

// ---------------------------------------------------------------------------
// (fork-point recovery, conditional)
// ---------------------------------------------------------------------------

test('resolveScope: genuine divergent fallback base recovers and writes scope (does NOT throw)', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        // feature forks from main's initial commit and gets its OWN real commit —
        // local `main` is never touched again, so it stays the genuine fork point.
        git(['checkout', '-qb', 'feature'], repo);
        fs.writeFileSync(path.join(repo, 'c1.txt'), 'c1\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'feature_commit'], repo);

        // stale-base forks from feature's tip and advances further still — this is
        // the auto-default base, which now has HEAD as a strict ancestor.
        git(['checkout', '-qb', 'stale-base'], repo);
        fs.writeFileSync(path.join(repo, 'd1.txt'), 'd1\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'stale_base_advance'], repo);
        git(['checkout', '-q', 'feature'], repo);

        const scope = resolveScope({
            scopeFlag: 'branch',
            scopeBase: 'stale-base',
            sessionRoot: session,
            repoRoot: repo,
        });

        assert.ok(scope.allowed_paths.includes('c1.txt'),
            `expected recovered diff to include c1.txt, got: ${JSON.stringify(scope.allowed_paths)}`);
        assert.ok(fs.existsSync(path.join(session, 'scope.json')), 'scope.json must be written on recovery');
    } finally {
        cleanup(repo, session);
    }
});

// ---------------------------------------------------------------------------
// (true-empty unchanged)
// ---------------------------------------------------------------------------

test('setupScope: genuinely-empty branch (base NOT ahead) still legitimate SCOPE_EMPTY_DIFF', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        // HEAD == main, no checkout of any other branch — base and HEAD are the
        // literal same commit. No ahead-ness; the legacy WARN path must still fire.
        const messages = [];
        const scope = setupScope({
            sessionDir: session,
            workingDir: repo,
            target: repo,
            scopeFlag: 'branch',
            scopeBase: 'main',
            log: (m) => messages.push(m),
        });

        assert.equal(scope, null, 'returns null on empty-at-setup (warn path), not a thrown error');
        assert.ok(!fs.existsSync(path.join(session, 'scope.json')), 'no scope.json written on empty-at-setup');

        const warn = messages.find((m) => m.includes('SCOPE_EMPTY_DIFF'));
        assert.ok(warn, `expected a WARN line mentioning SCOPE_EMPTY_DIFF, got: ${JSON.stringify(messages)}`);
        assert.ok(!messages.some((m) => m.includes('SCOPE_BASE_AHEAD_OF_HEAD')),
            'ancestry check must not fire when base is not ahead');
    } finally {
        cleanup(repo, session);
    }
});

// ---------------------------------------------------------------------------
// (explicit diff not swapped)
// ---------------------------------------------------------------------------

test('resolveScope: explicit diff:<ref> mode never engages the ancestry recompute', () => {
    const repo = makeAheadRepoNoRecovery();
    const session = makeSession(repo);
    try {
        // Same "ahead" topology as the throw-is-primary case, but scopeFlag is the
        // explicit diff:<ref> form — parsed.mode === 'diff' must bypass the ancestry
        // check entirely and fall through to the legacy SCOPE_EMPTY_DIFF behavior.
        assert.throws(
            () => resolveScope({
                scopeFlag: 'diff:main',
                sessionRoot: session,
                repoRoot: repo,
            }),
            (err) => err instanceof ScopeError && err.code === 'SCOPE_EMPTY_DIFF',
        );
    } finally {
        cleanup(repo, session);
    }
});

// ---------------------------------------------------------------------------
// (runner fail-CLOSED, positive) + (runner regression, negative)
// ---------------------------------------------------------------------------

test('setupScope: SCOPE_BASE_AHEAD_OF_HEAD is fail-CLOSED — forensic exit_reason, no scope.json, no return null', () => {
    const repo = makeAheadRepoNoRecovery();
    const session = makeSession(repo);
    try {
        const messages = [];
        // assert.throws proves setupScope does NOT swallow this into a `return null`
        // the way it does for SCOPE_EMPTY_DIFF — the runner-regression negative AC.
        assert.throws(
            () => setupScope({
                sessionDir: session,
                workingDir: repo,
                target: repo,
                scopeFlag: 'branch',
                scopeBase: 'main',
                log: (m) => messages.push(m),
            }),
            (err) => err instanceof ScopeError && err.code === 'SCOPE_BASE_AHEAD_OF_HEAD',
        );

        const state = JSON.parse(fs.readFileSync(path.join(session, 'state.json'), 'utf-8'));
        assert.equal(state.exit_reason, 'scope_base_ahead_of_head',
            'pipeline must record the forensic exit_reason before re-throwing');
        assert.ok(!fs.existsSync(path.join(session, 'scope.json')),
            'must NOT write scope.json + proceed unscoped on a stale/ahead base');
        assert.ok(messages.some((m) => m.includes('SCOPE_BASE_AHEAD_OF_HEAD')),
            `expected a log line mentioning SCOPE_BASE_AHEAD_OF_HEAD, got: ${JSON.stringify(messages)}`);
    } finally {
        cleanup(repo, session);
    }
});

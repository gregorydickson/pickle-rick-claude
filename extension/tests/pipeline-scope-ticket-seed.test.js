// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-scope-ticket-seed-repo-'));
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'commit.gpgsign', 'false'], dir);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'seed.ts'), 'export const seed = 1;\n');
    git(['add', '.'], dir);
    git(['commit', '-qm', 'initial'], dir);
    return dir;
}

function makeSession(repoRoot, ticketId = 'seed1234') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-scope-ticket-seed-session-'));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        active: false,
        working_dir: repoRoot,
        step: 'implement',
        iteration: 0,
        max_iterations: 10,
        max_time_minutes: 60,
        worker_timeout_seconds: 1200,
        start_time_epoch: Math.floor(Date.now() / 1000),
        completion_promise: null,
        original_prompt: 'test',
        current_ticket: ticketId,
        history: [],
        started_at: new Date().toISOString(),
        session_dir: dir,
    }, null, 2));
    return dir;
}

function writeTicket(sessionDir, ticketId, declaredPaths) {
    const ticketDir = path.join(sessionDir, ticketId);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`), [
        '---',
        `id: ${ticketId}`,
        'title: Seed scope test',
        'status: In Progress',
        'updated: "2026-07-02"',
        '---',
        '# Implementation Details',
        `**Files to modify/create**: ${declaredPaths.map((p) => `\`${p}\``).join(', ')}`,
        '',
    ].join('\n'));
}

function cleanup(...dirs) {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

let compiledModulesPromise;

function loadCompiledModules() {
    if (!compiledModulesPromise) {
        compiledModulesPromise = (async () => {
            const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-scope-ticket-seed-build-'));
            fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ type: 'module' }));
            fs.symlinkSync(path.resolve('extension/node_modules'), path.join(outDir, 'node_modules'), 'dir');
            const compile = spawnSync(
                'npx',
                ['tsc', '-p', 'extension/tsconfig.json', '--outDir', outDir],
                { cwd: process.cwd(), encoding: 'utf-8' },
            );
            if (compile.status !== 0) {
                throw new Error(`tsc failed:\n${compile.stderr || compile.stdout}`);
            }
            const pipelineRunner = await import(pathToFileURL(path.join(outDir, 'bin', 'pipeline-runner.js')).href);
            const checkScope = await import(pathToFileURL(path.join(outDir, 'bin', 'check-scope-diff.js')).href);
            return { outDir, setupScope: pipelineRunner.setupScope, checkScopeDiff: checkScope.checkScopeDiff };
        })();
    }
    return compiledModulesPromise;
}

test('setupScope seeds empty pre-build branch scope from ticket-declared file impacts and persists scope.json', async () => {
    const repo = makeRepo();
    const session = makeSession(repo, 'seed-empty');
    try {
        const { setupScope, checkScopeDiff } = await loadCompiledModules();
        writeTicket(session, 'seed-empty', ['src/feature.ts', 'docs/notes.md']);

        const messages = [];
        const scope = setupScope({
            sessionDir: session,
            workingDir: repo,
            target: repo,
            scopeFlag: 'branch',
            scopeBase: 'main',
            log: (m) => messages.push(m),
        });

        assert.ok(scope, 'seeded scope should be returned');
        assert.equal(scope.mode, 'branch');
        assert.deepStrictEqual(scope.allowed_paths, ['docs/notes.md', 'src/feature.ts']);

        const persisted = JSON.parse(fs.readFileSync(path.join(session, 'scope.json'), 'utf-8'));
        assert.deepStrictEqual(persisted.allowed_paths, ['docs/notes.md', 'src/feature.ts']);
        assert.ok(
            messages.some((m) => m === 'scope-setup: seeded pickle-phase scope from ticket file-impact (2 paths)'),
            `expected seeded scope log, got ${JSON.stringify(messages)}`,
        );

        fs.writeFileSync(path.join(repo, 'src', 'feature.ts'), 'export const feature = 1;\n');
        git(['add', 'src/feature.ts'], repo);

        const gate = checkScopeDiff({
            scopeJsonPath: path.join(session, 'scope.json'),
            _getStagedPaths: () => ['src/feature.ts'],
        });
        assert.equal(gate.status, 'ok');
        assert.equal(gate.staged_count, 1);
    } finally {
        cleanup(repo, session);
    }
});

test('setupScope preserves a non-empty resolved branch diff instead of replacing it with ticket-declared paths', async () => {
    const repo = makeRepo();
    const session = makeSession(repo, 'preserve-branch');
    try {
        const { setupScope } = await loadCompiledModules();
        writeTicket(session, 'preserve-branch', ['src/ticket-only.ts']);
        git(['checkout', '-qb', 'feature'], repo);
        fs.writeFileSync(path.join(repo, 'src', 'real-diff.ts'), 'export const realDiff = 1;\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'real diff'], repo);

        const messages = [];
        const scope = setupScope({
            sessionDir: session,
            workingDir: repo,
            target: repo,
            scopeFlag: 'branch',
            scopeBase: 'main',
            log: (m) => messages.push(m),
        });

        assert.ok(scope, 'resolved branch scope should be returned');
        assert.deepStrictEqual(scope.allowed_paths, ['src/real-diff.ts']);
        assert.ok(
            !messages.some((m) => m.includes('seeded pickle-phase scope')),
            `non-empty diff should not seed declared paths, got ${JSON.stringify(messages)}`,
        );
    } finally {
        cleanup(repo, session);
    }
});

test('setupScope leaves explicit paths scope untouched', async () => {
    const repo = makeRepo();
    const session = makeSession(repo, 'paths-untouched');
    try {
        const { setupScope } = await loadCompiledModules();
        writeTicket(session, 'paths-untouched', ['src/ticket-only.ts']);
        fs.writeFileSync(path.join(repo, 'src', 'in-paths.ts'), 'export const inPaths = 1;\n');

        const scope = setupScope({
            sessionDir: session,
            workingDir: repo,
            target: repo,
            scopeFlag: 'paths:src/*.ts',
            log: () => {},
        });

        assert.ok(scope, 'paths scope should resolve');
        assert.equal(scope.mode, 'paths');
        assert.deepStrictEqual(scope.allowed_paths, ['src/in-paths.ts', 'src/seed.ts']);
    } finally {
        cleanup(repo, session);
    }
});

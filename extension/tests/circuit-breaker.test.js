// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

import {
    loadSettings,
    initCircuitBreaker,
    canExecute,
    detectProgress,
    extractErrorSignature,
    formatCircuitBreakerTripReason,
    isConstraintDiscoverySignature,
    normalizeErrorSignature,
    recordIterationResult,
    resetCircuitBreaker,
    startFreshCircuitBreaker,
} from '../services/circuit-breaker.js';

import { buildTmuxNotification } from '../bin/mux-runner.js';

function makeTmpDir(prefix = 'cb-test-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeSettings(overrides = {}) {
    return {
        enabled: true,
        noProgressThreshold: 5,
        sameErrorThreshold: 5,
        halfOpenAfter: 2,
        ...overrides,
    };
}

function initGitRepo(dir) {
    spawnSync('git', ['init'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'file.txt'), 'initial');
    spawnSync('git', ['add', '.'], { cwd: dir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: dir });
    return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).stdout.trim();
}

function makeFreshState(overrides = {}) {
    return {
        state: 'CLOSED',
        last_change: new Date().toISOString(),
        consecutive_no_progress: 0,
        consecutive_same_error: 0,
        last_error_signature: null,
        last_known_head: '',
        last_known_step: null,
        last_known_ticket: null,
        last_progress_iteration: 0,
        total_opens: 0,
        reason: '',
        opened_at: null,
        history: [],
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// loadSettings
// ---------------------------------------------------------------------------

test('loadSettings: reads valid config from pickle_settings.json', () => {
    const tmpDir = makeTmpDir();
    try {
        fs.writeFileSync(path.join(tmpDir, 'pickle_settings.json'), JSON.stringify({
            default_circuit_breaker_enabled: false,
            default_cb_no_progress_threshold: 10,
            default_cb_same_error_threshold: 8,
            default_cb_half_open_after: 3,
        }));
        const cfg = loadSettings(tmpDir);
        assert.equal(cfg.enabled, false);
        assert.equal(cfg.noProgressThreshold, 10);
        assert.equal(cfg.sameErrorThreshold, 8);
        assert.equal(cfg.halfOpenAfter, 3);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('loadSettings: promotes newer dead-writer pickle_settings.json tmp snapshot', () => {
    const tmpDir = makeTmpDir();
    try {
        const settingsPath = path.join(tmpDir, 'pickle_settings.json');
        const tmpPath = `${settingsPath}.tmp.99999999`;
        fs.writeFileSync(settingsPath, JSON.stringify({
            default_circuit_breaker_enabled: true,
            default_cb_no_progress_threshold: 5,
        }));
        fs.writeFileSync(tmpPath, JSON.stringify({
            default_circuit_breaker_enabled: false,
            default_cb_no_progress_threshold: 9,
            default_cb_same_error_threshold: 7,
            default_cb_half_open_after: 4,
        }));
        const newer = new Date(Date.now() + 1_000);
        fs.utimesSync(tmpPath, newer, newer);

        const cfg = loadSettings(tmpDir);

        assert.equal(cfg.enabled, false);
        assert.equal(cfg.noProgressThreshold, 9);
        assert.equal(cfg.sameErrorThreshold, 7);
        assert.equal(cfg.halfOpenAfter, 4);
        assert.equal(fs.existsSync(tmpPath), false, 'dead-writer tmp should be promoted');
        assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).default_circuit_breaker_enabled, false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('loadSettings: returns defaults when file is missing', () => {
    const tmpDir = makeTmpDir();
    try {
        const cfg = loadSettings(tmpDir);
        assert.equal(cfg.enabled, true);
        assert.equal(cfg.noProgressThreshold, 5);
        assert.equal(cfg.sameErrorThreshold, 5);
        assert.equal(cfg.halfOpenAfter, 2);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('loadSettings: enforces minimums and halfOpenAfter < noProgressThreshold', () => {
    const tmpDir = makeTmpDir();
    try {
        fs.writeFileSync(path.join(tmpDir, 'pickle_settings.json'), JSON.stringify({
            default_cb_no_progress_threshold: 1,
            default_cb_same_error_threshold: 0,
            default_cb_half_open_after: 99,
        }));
        const cfg = loadSettings(tmpDir);
        assert.ok(cfg.noProgressThreshold >= 2, `noProgressThreshold should be >= 2, got ${cfg.noProgressThreshold}`);
        assert.ok(cfg.sameErrorThreshold >= 2, `sameErrorThreshold should be >= 2, got ${cfg.sameErrorThreshold}`);
        assert.ok(cfg.halfOpenAfter < cfg.noProgressThreshold,
            `halfOpenAfter (${cfg.halfOpenAfter}) must be < noProgressThreshold (${cfg.noProgressThreshold})`);
        assert.ok(cfg.halfOpenAfter >= 1, `halfOpenAfter should be >= 1, got ${cfg.halfOpenAfter}`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// initCircuitBreaker
// ---------------------------------------------------------------------------

test('initCircuitBreaker: creates fresh state when no file exists', () => {
    const tmpDir = makeTmpDir();
    try {
        const state = initCircuitBreaker(tmpDir, makeSettings());
        assert.equal(state.state, 'CLOSED');
        assert.equal(state.consecutive_no_progress, 0);
        assert.equal(state.consecutive_same_error, 0);
        assert.equal(state.last_error_signature, null);
        assert.deepEqual(state.history, []);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('initCircuitBreaker: loads existing valid state', () => {
    const tmpDir = makeTmpDir();
    try {
        const existing = makeFreshState({
            state: 'HALF_OPEN',
            consecutive_no_progress: 3,
            last_error_signature: 'some-error',
            total_opens: 2,
        });
        fs.writeFileSync(path.join(tmpDir, 'circuit_breaker.json'), JSON.stringify(existing));
        const state = initCircuitBreaker(tmpDir, makeSettings());
        assert.equal(state.state, 'HALF_OPEN');
        assert.equal(state.consecutive_no_progress, 3);
        assert.equal(state.last_error_signature, 'some-error');
        assert.equal(state.total_opens, 2);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('initCircuitBreaker: recovers from corrupted JSON', () => {
    const tmpDir = makeTmpDir();
    try {
        fs.writeFileSync(path.join(tmpDir, 'circuit_breaker.json'), '{not valid json!!!');
        const state = initCircuitBreaker(tmpDir, makeSettings());
        assert.equal(state.state, 'CLOSED');
        assert.equal(state.consecutive_no_progress, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('initCircuitBreaker: a state.json iteration regression does not discard accumulated breaker state (C3)', () => {
    // state.json's iteration is a session-wide field other runners (microverse-runner) and
    // phase-boundary resets (resetStateForPhase, setup.js --resume --reset) can move
    // independently of the breaker's own progress. CB's last_progress_iteration=50 with
    // state.json at iteration=10 must NOT be read as "foreign/stale" and discarded.
    const tmpDir = makeTmpDir();
    try {
        const accumulated = makeFreshState({ state: 'HALF_OPEN', consecutive_no_progress: 4, last_progress_iteration: 50 });
        fs.writeFileSync(path.join(tmpDir, 'circuit_breaker.json'), JSON.stringify(accumulated));
        fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify({ iteration: 10 }));
        const state = initCircuitBreaker(tmpDir, makeSettings());
        assert.equal(state.state, 'HALF_OPEN', 'accumulated breaker state must survive an iteration regression');
        assert.equal(state.consecutive_no_progress, 4);
        assert.equal(state.last_progress_iteration, 50);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('initCircuitBreaker: promotes newer orphan circuit_breaker tmp before deciding state', () => {
    const tmpDir = makeTmpDir();
    try {
        const cbPath = path.join(tmpDir, 'circuit_breaker.json');
        const tmpPath = `${cbPath}.tmp.99999999`;
        fs.writeFileSync(cbPath, JSON.stringify(makeFreshState({ state: 'CLOSED' })));
        fs.writeFileSync(tmpPath, JSON.stringify(makeFreshState({
            state: 'OPEN',
            consecutive_no_progress: 5,
            reason: 'No progress in 5 iterations',
        })));
        const baseTime = new Date('2026-04-28T12:00:00.000Z');
        const tmpTime = new Date('2026-04-28T12:00:01.000Z');
        fs.utimesSync(cbPath, baseTime, baseTime);
        fs.utimesSync(tmpPath, tmpTime, tmpTime);

        const state = initCircuitBreaker(tmpDir, makeSettings());

        assert.equal(state.state, 'OPEN');
        assert.equal(state.consecutive_no_progress, 5);
        assert.equal(fs.existsSync(tmpPath), false, 'promoted tmp should be consumed');
        assert.equal(JSON.parse(fs.readFileSync(cbPath, 'utf-8')).state, 'OPEN');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// canExecute
// ---------------------------------------------------------------------------

test('canExecute: CLOSED returns true', () => {
    assert.equal(canExecute(makeFreshState({ state: 'CLOSED' })), true);
});

test('canExecute: HALF_OPEN returns true', () => {
    assert.equal(canExecute(makeFreshState({ state: 'HALF_OPEN' })), true);
});

test('canExecute: OPEN returns false', () => {
    assert.equal(canExecute(makeFreshState({ state: 'OPEN' })), false);
});

// ---------------------------------------------------------------------------
// detectProgress
// ---------------------------------------------------------------------------

test('detectProgress: first-iteration warm-up always returns hasProgress', () => {
    const tmpDir = makeTmpDir();
    try {
        const result = detectProgress(tmpDir, '', null, 'implement', null, 'ticket-1');
        assert.equal(result.hasProgress, true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectProgress: non-git directory returns hasProgress=true', () => {
    const tmpDir = makeTmpDir();
    try {
        const result = detectProgress(tmpDir, 'abc123', null, 'implement', null, null);
        assert.equal(result.hasProgress, true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectProgress: step change counts as progress', () => {
    const tmpDir = makeTmpDir();
    try {
        const head = initGitRepo(tmpDir);
        const result = detectProgress(tmpDir, head, 'research', 'plan', null, null);
        assert.equal(result.stepChanged, true);
        assert.equal(result.hasProgress, true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectProgress: ticket change counts as progress', () => {
    const tmpDir = makeTmpDir();
    try {
        const head = initGitRepo(tmpDir);
        const result = detectProgress(tmpDir, head, 'implement', 'implement', 'ticket-A', 'ticket-B');
        assert.equal(result.ticketChanged, true);
        assert.equal(result.hasProgress, true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectProgress: detects uncommitted git changes', () => {
    const tmpDir = makeTmpDir();
    try {
        const head = initGitRepo(tmpDir);
        fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'modified');
        const result = detectProgress(tmpDir, head, 'implement', 'implement', null, null);
        assert.equal(result.hasProgress, true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectProgress: clean git repo with same head returns no progress', () => {
    const tmpDir = makeTmpDir();
    try {
        const head = initGitRepo(tmpDir);
        const result = detectProgress(tmpDir, head, 'implement', 'implement', null, null);
        assert.equal(result.hasProgress, false);
        assert.equal(result.currentHead, head);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('R-DEFCHURN #127: an EMPTY commit (HEAD changed, tree unchanged) is NOT progress', () => {
    const tmpDir = makeTmpDir();
    try {
        const head = initGitRepo(tmpDir);
        // Worker's "deferred conformance" no-op: a new commit SHA, zero tree change.
        spawnSync('git', ['commit', '--allow-empty', '-m', 'chore: record deferred conformance'], { cwd: tmpDir });
        const head2 = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf-8' }).stdout.trim();
        assert.notEqual(head2, head, 'sanity: the empty commit advanced HEAD');
        const result = detectProgress(tmpDir, head, 'implement', 'implement', null, null);
        assert.equal(result.hasProgress, false, 'empty commit must not count as progress (else the no-progress breaker never trips)');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER222-01 — the breaker's uncommitted-work read must see UNTRACKED files.
//
// `git diff --stat` + `--stat --cached` covers tracked modifications only, so a
// worker whose entire output is NEW files read as a clean tree HERE, in the breaker
// itself: `noProgressThreshold` such iterations trip OPEN and exit the run
// `circuit_open` over real work on disk. These cases assert the whole SHAPE of the
// work set rather than one hand-picked payload, so a future reader that regresses to
// any tracked-only probe reds on the untracked row while the controls stay green.
// ---------------------------------------------------------------------------

const UNCOMMITTED_WORK_SHAPES = [
    { name: 'untracked file at the repo root', apply: (dir) => { fs.writeFileSync(path.join(dir, 'new-a.js'), 'a'); } },
    { name: 'untracked file in a wholly-untracked subdirectory', apply: (dir) => { fs.mkdirSync(path.join(dir, 'sub')); fs.writeFileSync(path.join(dir, 'sub', 'new-c.ts'), 'c'); } },
    { name: 'tracked modification, unstaged', apply: (dir) => { fs.writeFileSync(path.join(dir, 'file.txt'), 'modified'); } },
    { name: 'tracked modification, staged', apply: (dir) => { fs.writeFileSync(path.join(dir, 'file.txt'), 'modified'); spawnSync('git', ['add', '.'], { cwd: dir }); } },
    { name: 'untracked file, staged', apply: (dir) => { fs.writeFileSync(path.join(dir, 'new-a.js'), 'a'); spawnSync('git', ['add', '.'], { cwd: dir }); } },
    { name: 'tracked deletion', apply: (dir) => { fs.rmSync(path.join(dir, 'file.txt')); } },
];

test('AP-EXT-ITER222-01: every shape of uncommitted work counts as progress', () => {
    const sawProgress = [];
    for (const shape of UNCOMMITTED_WORK_SHAPES) {
        const tmpDir = makeTmpDir();
        try {
            const head = initGitRepo(tmpDir);
            assert.equal(
                detectProgress(tmpDir, head, 'implement', 'implement', 'ticket-A', 'ticket-A').hasProgress,
                false,
                `sanity: the clean tree before "${shape.name}" must read as no progress, else the row proves nothing`,
            );
            shape.apply(tmpDir);
            const result = detectProgress(tmpDir, head, 'implement', 'implement', 'ticket-A', 'ticket-A');
            if (result.hasProgress) sawProgress.push(shape.name);
            assert.ok(
                result.filesChanged > 0,
                `filesChanged must count "${shape.name}" — it is derived from the same read as hasProgress, so a zero here means the two disagree`,
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }
    assert.deepEqual(
        sawProgress,
        UNCOMMITTED_WORK_SHAPES.map((shape) => shape.name),
        'a worker that produced ANY of these and did not commit must not advance the no-progress counter — that path ends in circuit_open with the work still on disk',
    );
});

test('AP-EXT-ITER222-01: a regenerable .codegraph artifact is NOT work', () => {
    const tmpDir = makeTmpDir();
    try {
        const head = initGitRepo(tmpDir);
        fs.mkdirSync(path.join(tmpDir, '.codegraph'));
        fs.writeFileSync(path.join(tmpDir, '.codegraph', 'index.json'), '{}');
        const result = detectProgress(tmpDir, head, 'implement', 'implement', 'ticket-A', 'ticket-A');
        // `.codegraph/` is ignored only through the local, unversioned `.git/info/exclude`,
        // so on a fresh clone it is plain untracked dirt. Counting it as progress would
        // reset the no-progress counter every stagnant iteration and the breaker could
        // never trip at all — the filter is load-bearing, not hygiene.
        assert.equal(result.hasProgress, false, 'a regenerable codegraph artifact must not read as worker progress');
        assert.equal(result.filesChanged, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// AP-EXT-ITER306-01: the SAME case as above, with the session working dir one directory
// BELOW the git toplevel. `git status --porcelain` answers relative to the TOPLEVEL whatever
// cwd it was asked from, while codegraph writes its index at `<workingDir>/.codegraph/` — so
// down here the index arrives spelled `nested/work/.codegraph/...` and a bare
// `.filter(!isCodegraphArtifact)` (which matches a LEADING `.codegraph/` only) declines to
// drop it. The exclusion therefore has to reach git as a cwd-relative PATHSPEC, which is what
// the shared `listWorkingTreeDirtyPathsExcludingCodegraph` does. Every fixture above sits at
// the toplevel, where the two spellings are identical, so this gap was invisible by
// construction — the AP-EXT-ITER305-01 path-space family.
test('AP-EXT-ITER306-01: below the git toplevel a .codegraph artifact is STILL not work', () => {
    const repo = makeTmpDir('cb-test-cg-nested-');
    try {
        const head = initGitRepo(repo);
        const workingDir = path.join(repo, 'nested', 'work');
        fs.mkdirSync(path.join(workingDir, '.codegraph'), { recursive: true });
        fs.writeFileSync(path.join(workingDir, '.codegraph', 'index.json'), '{}');

        const result = detectProgress(workingDir, head, 'implement', 'implement', 'ticket-A', 'ticket-A');
        assert.equal(
            result.hasProgress,
            false,
            'the runtime index must not read as progress from a nested working dir either — counting it resets the no-progress counter every stagnant iteration and the breaker can never trip',
        );
        assert.equal(result.filesChanged, 0);

        // ACCEPT control on the SAME fixture: real work down here MUST still read as
        // progress. Without this, a reader that returns nothing at all from a nested cwd
        // would satisfy the assertions above vacuously.
        fs.writeFileSync(path.join(workingDir, 'real.ts'), 'export const real = 1;\n');
        const withWork = detectProgress(workingDir, head, 'implement', 'implement', 'ticket-A', 'ticket-A');
        assert.equal(withWork.hasProgress, true, 'genuine uncommitted work below the toplevel is still progress');
        assert.equal(withWork.filesChanged, 1, 'the count reports the real file and NOT the codegraph index beside it');
    } finally {
        fs.rmSync(repo, { recursive: true, force: true });
    }
});

test('R-DEFCHURN #127: a REAL commit (HEAD + tree changed) is still progress', () => {
    const tmpDir = makeTmpDir();
    try {
        const head = initGitRepo(tmpDir);
        fs.writeFileSync(path.join(tmpDir, 'new.txt'), 'real work');
        spawnSync('git', ['add', '.'], { cwd: tmpDir });
        spawnSync('git', ['commit', '-m', 'feat: real change'], { cwd: tmpDir });
        const result = detectProgress(tmpDir, head, 'implement', 'implement', null, null);
        assert.equal(result.hasProgress, true, 'a tree-changing commit must still count as progress');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// extractErrorSignature
// ---------------------------------------------------------------------------

test('extractErrorSignature: extracts from NDJSON with error result + assistant text', () => {
    const ndjson = [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it...' }] } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Error: ENOENT /foo/bar' }] } }),
        JSON.stringify({ type: 'result', subtype: 'error_max_turns' }),
    ].join('\n');
    const sig = extractErrorSignature(ndjson);
    assert.ok(sig !== null, 'should extract a signature');
    assert.ok(sig.includes('<PATH>'), 'should normalize paths');
});

test('extractErrorSignature: returns null for clean output (no error result)', () => {
    const ndjson = [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'All done!' }] } }),
        JSON.stringify({ type: 'result', subtype: 'success' }),
    ].join('\n');
    assert.equal(extractErrorSignature(ndjson), null);
});

test('extractErrorSignature: skips malformed NDJSON lines gracefully', () => {
    const ndjson = [
        '{not valid json',
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Failed at /src/main.ts:42:10' }] } }),
        'also not json {{{',
        JSON.stringify({ type: 'result', subtype: 'error_tool' }),
    ].join('\n');
    const sig = extractErrorSignature(ndjson);
    assert.ok(sig !== null, 'should extract signature despite malformed lines');
});

test('extractErrorSignature: returns null when no assistant text before error', () => {
    const ndjson = [
        JSON.stringify({ type: 'result', subtype: 'error_timeout' }),
    ].join('\n');
    assert.equal(extractErrorSignature(ndjson), null);
});

// ---------------------------------------------------------------------------
// normalizeErrorSignature
// ---------------------------------------------------------------------------

test('normalizeErrorSignature: replaces Unix paths with <PATH>', () => {
    const result = normalizeErrorSignature('Error reading /usr/local/lib/node_modules/foo.js');
    assert.ok(result.includes('<PATH>'), `Expected <PATH> in "${result}"`);
    assert.ok(!result.includes('/usr/local'), 'path should be replaced');
});

test('normalizeErrorSignature: replaces line:column with <N>:<N>', () => {
    const result = normalizeErrorSignature('SyntaxError at position :42:10');
    assert.ok(result.includes(':<N>:<N>'), `Expected :<N>:<N> in "${result}"`);
    assert.ok(!result.includes(':42:10'), 'line:col should be replaced');
});

test('normalizeErrorSignature: preserves exit codes (standalone numbers)', () => {
    const result = normalizeErrorSignature('Process exited with code 1');
    assert.ok(result.includes('1'), `Exit code should be preserved in "${result}"`);
});

test('normalizeErrorSignature: replaces UUIDs with <UUID>', () => {
    const result = normalizeErrorSignature('Session a1b2c3d4-e5f6-7890-abcd-ef1234567890 failed');
    assert.ok(result.includes('<UUID>'), `Expected <UUID> in "${result}"`);
    assert.ok(!result.includes('a1b2c3d4'), 'UUID should be replaced');
});

test('normalizeErrorSignature: truncates at 200 chars', () => {
    const longMsg = 'x'.repeat(300);
    const result = normalizeErrorSignature(longMsg);
    assert.equal(result.length, 200);
});

// ---------------------------------------------------------------------------
// recordIterationResult
// ---------------------------------------------------------------------------

test('recordIterationResult: CLOSED → HALF_OPEN after halfOpenAfter no-progress iterations', () => {
    const settings = makeSettings({ halfOpenAfter: 2 });
    let state = makeFreshState({ state: 'CLOSED', consecutive_no_progress: 1 });
    state = recordIterationResult(state, { hasProgress: false, errorSignature: null }, 3, settings);
    assert.equal(state.state, 'HALF_OPEN');
    assert.equal(state.consecutive_no_progress, 2);
});

test('recordIterationResult: HALF_OPEN → CLOSED on progress', () => {
    const settings = makeSettings();
    let state = makeFreshState({ state: 'HALF_OPEN', consecutive_no_progress: 3 });
    state = recordIterationResult(state, { hasProgress: true, errorSignature: null }, 5, settings);
    assert.equal(state.state, 'CLOSED');
    assert.equal(state.consecutive_no_progress, 0);
    assert.equal(state.last_progress_iteration, 5);
});

test('recordIterationResult: HALF_OPEN → OPEN after noProgressThreshold', () => {
    const settings = makeSettings({ noProgressThreshold: 5, halfOpenAfter: 2 });
    let state = makeFreshState({ state: 'HALF_OPEN', consecutive_no_progress: 4 });
    state = recordIterationResult(state, { hasProgress: false, errorSignature: null }, 6, settings);
    assert.equal(state.state, 'OPEN');
    assert.equal(state.consecutive_no_progress, 5);
});

test('recordIterationResult: no-progress constraint discovery opens with correct-course suggestion', () => {
    const settings = makeSettings({ noProgressThreshold: 3, halfOpenAfter: 2 });
    let state = makeFreshState({
        state: 'HALF_OPEN',
        consecutive_no_progress: 2,
        last_error_signature: 'blocked by newly discovered contract constraint',
    });
    state = recordIterationResult(state, {
        hasProgress: false,
        errorSignature: 'blocked by newly discovered contract constraint',
    }, 4, settings);

    assert.equal(isConstraintDiscoverySignature(state.last_error_signature), true);
    assert.equal(state.state, 'OPEN');
    assert.match(state.reason, /No progress in 3 iterations/);
    assert.match(state.reason, /correct-course\.js "<discovery>"/);
    assert.doesNotMatch(state.reason, /pickle-correct-course/, 'no hint at a slash command that has no command file');
});

/**
 * AP-EXT-ITER3-SVC-01 — the suggestion is a command the operator can run as printed.
 * `correct-course.js` exits through `usage()` without `--session-dir`, so a suggestion that
 * omits it sends the operator from a halted run straight into a usage error. Fill the
 * placeholders and feed the printed argv to the real parser.
 */
test('AP-EXT-ITER3-SVC-01: the correct-course suggestion parses under correct-course.js', async () => {
    const { parseArgs } = await import('../bin/correct-course.js');
    const settings = makeSettings({ noProgressThreshold: 3, halfOpenAfter: 2 });
    const state = recordIterationResult(makeFreshState({
        state: 'HALF_OPEN',
        consecutive_no_progress: 2,
        last_error_signature: 'blocked by newly discovered contract constraint',
    }), { hasProgress: false, errorSignature: 'blocked by newly discovered contract constraint' }, 4, settings);
    const command = state.reason.split('correct-course.js')[1];
    assert.ok(command, 'suggestion names correct-course.js');
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-cb-suggest-'));
    const argv = (command.match(/"[^"]*"|\S+/g) ?? [])
        .map((token) => token.replace(/^"|"$/g, ''))
        .map((token) => token.replace('<discovery>', 'new contract constraint').replace('<session-dir>', sessionDir));
    const realExit = process.exit;
    process.exit = (code) => { throw new Error(`correct-course.js exited ${code} on the suggested argv`); };
    try {
        const parsed = parseArgs(argv);
        assert.equal(parsed.sessionDir, path.resolve(sessionDir));
        assert.equal(parsed.discovery, 'new contract constraint');
    } finally {
        process.exit = realExit;
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

/**
 * AP-EXT-ITER249-01 — the trip reason is ANNOTATED, not rebuilt.
 *
 * The test above pins the PRODUCER: `recordIterationResult` appends the
 * correct-course suggestion to `state.reason` on a constraint-discovery trip. Nothing
 * pinned what the runner then does with it. `formatCircuitBreakerTripReason` used to
 * match `/^No progress in (\d+) iterations(?:\..*)?$/` and return a freshly composed
 * prefix, so the suggestion was discarded before the reason reached
 * `circuit_breaker.json`, the runner log, the `circuit_open` activity event and the
 * monitor's Circuit field — every surface an operator reads at the halt. It survived
 * only in `history[]`, which no reader displays. A green producer pin over a consumer
 * that throws the value away is exactly the shape this case closes.
 */
test('AP-EXT-ITER249-01: annotating the trip reason keeps the correct-course suggestion', () => {
    const settings = makeSettings({ noProgressThreshold: 3, halfOpenAfter: 2 });
    let state = makeFreshState({
        state: 'HALF_OPEN',
        consecutive_no_progress: 2,
        last_error_signature: 'blocked by newly discovered contract constraint',
    });
    state = recordIterationResult(state, {
        hasProgress: false,
        errorSignature: 'blocked by newly discovered contract constraint',
    }, 4, settings);
    assert.equal(state.state, 'OPEN');

    const annotated = formatCircuitBreakerTripReason(state.reason, { tier: 'medium', budget: 3 });
    assert.match(annotated, /^No progress in 3 iterations \(tier: medium, budget: 3\)/);
    assert.match(annotated, /correct-course\.js "<discovery>"/);
    assert.doesNotMatch(annotated, /pickle-correct-course/);
});

// Negative controls: the annotation must still land on a bare no-progress reason (so the
// fix cannot pass by dropping the annotation), and must NOT land on a same-error reason
// (so it cannot pass by annotating everything).
test('AP-EXT-ITER249-01: a bare no-progress reason is annotated, a same-error reason is not', () => {
    assert.equal(
        formatCircuitBreakerTripReason('No progress in 5 iterations', { tier: 'large', budget: 12 }),
        'No progress in 5 iterations (tier: large, budget: 12)',
    );
    assert.equal(
        formatCircuitBreakerTripReason('Same error repeated 5 times', { tier: 'medium', budget: 5 }),
        'Same error repeated 5 times',
    );
});

test('recordIterationResult: CLOSED → OPEN on sameErrorThreshold', () => {
    const settings = makeSettings({ sameErrorThreshold: 3 });
    let state = makeFreshState({
        state: 'CLOSED',
        consecutive_same_error: 2,
        last_error_signature: 'err-A',
    });
    state = recordIterationResult(state, { hasProgress: true, errorSignature: 'err-A' }, 4, settings);
    assert.equal(state.state, 'OPEN');
    assert.equal(state.consecutive_same_error, 3);
});

test('recordIterationResult: error counter is independent of progress', () => {
    const settings = makeSettings({ sameErrorThreshold: 5 });
    let state = makeFreshState({
        state: 'CLOSED',
        consecutive_same_error: 1,
        last_error_signature: 'err-X',
    });
    // Progress happens, but same error repeats
    state = recordIterationResult(state, { hasProgress: true, errorSignature: 'err-X' }, 2, settings);
    assert.equal(state.consecutive_same_error, 2);
    assert.equal(state.consecutive_no_progress, 0);
});

test('recordIterationResult: different error resets counter to 1', () => {
    const settings = makeSettings();
    let state = makeFreshState({
        state: 'CLOSED',
        consecutive_same_error: 3,
        last_error_signature: 'err-A',
    });
    state = recordIterationResult(state, { hasProgress: true, errorSignature: 'err-B' }, 4, settings);
    assert.equal(state.consecutive_same_error, 1);
    assert.equal(state.last_error_signature, 'err-B');
});

test('recordIterationResult: no error resets error counter to 0', () => {
    const settings = makeSettings();
    let state = makeFreshState({
        state: 'CLOSED',
        consecutive_same_error: 3,
        last_error_signature: 'err-A',
    });
    state = recordIterationResult(state, { hasProgress: true, errorSignature: null }, 5, settings);
    assert.equal(state.consecutive_same_error, 0);
    assert.equal(state.last_error_signature, null);
});

test('recordIterationResult: error counter persists through HALF_OPEN recovery', () => {
    const settings = makeSettings({ sameErrorThreshold: 5 });
    let state = makeFreshState({
        state: 'HALF_OPEN',
        consecutive_same_error: 2,
        last_error_signature: 'err-X',
    });
    // Progress + same error → recover to CLOSED but error counter still ticks
    state = recordIterationResult(state, { hasProgress: true, errorSignature: 'err-X' }, 3, settings);
    assert.equal(state.state, 'CLOSED');
    assert.equal(state.consecutive_same_error, 3);
});

// ---------------------------------------------------------------------------
// resetCircuitBreaker
// ---------------------------------------------------------------------------

test('resetCircuitBreaker: resets OPEN to CLOSED with zeroed counters', () => {
    const tmpDir = makeTmpDir();
    try {
        const openState = makeFreshState({
            state: 'OPEN',
            consecutive_no_progress: 10,
            consecutive_same_error: 5,
            total_opens: 3,
            history: [{ timestamp: '2026-01-01T00:00:00Z', iteration: 1, from: 'CLOSED', to: 'OPEN', reason: 'test' }],
        });
        fs.writeFileSync(path.join(tmpDir, 'circuit_breaker.json'), JSON.stringify(openState));

        resetCircuitBreaker(tmpDir, 'manual test');

        const after = JSON.parse(fs.readFileSync(path.join(tmpDir, 'circuit_breaker.json'), 'utf-8'));
        assert.equal(after.state, 'CLOSED');
        assert.equal(after.consecutive_no_progress, 0);
        assert.equal(after.consecutive_same_error, 0);
        assert.equal(after.opened_at, null);
        // History preserved + reset entry added
        assert.ok(after.history.length >= 2, 'should preserve history + add reset entry');
        const lastEntry = after.history[after.history.length - 1];
        assert.equal(lastEntry.from, 'OPEN');
        assert.equal(lastEntry.to, 'CLOSED');
        assert.ok(lastEntry.reason.includes('Manual reset'), `reason should include "Manual reset", got: ${lastEntry.reason}`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('resetCircuitBreaker: resets HALF_OPEN to CLOSED', () => {
    const tmpDir = makeTmpDir();
    try {
        const hoState = makeFreshState({ state: 'HALF_OPEN', consecutive_no_progress: 3 });
        fs.writeFileSync(path.join(tmpDir, 'circuit_breaker.json'), JSON.stringify(hoState));

        resetCircuitBreaker(tmpDir, 'half-open reset');

        const after = JSON.parse(fs.readFileSync(path.join(tmpDir, 'circuit_breaker.json'), 'utf-8'));
        assert.equal(after.state, 'CLOSED');
        assert.equal(after.consecutive_no_progress, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('resetCircuitBreaker: CLOSED is a no-op (no file rewrite)', () => {
    const tmpDir = makeTmpDir();
    try {
        const closedState = makeFreshState({ state: 'CLOSED' });
        const content = JSON.stringify(closedState);
        const cbPath = path.join(tmpDir, 'circuit_breaker.json');
        fs.writeFileSync(cbPath, content);
        const mtimeBefore = fs.statSync(cbPath).mtimeMs;

        resetCircuitBreaker(tmpDir, 'noop test');

        const mtimeAfter = fs.statSync(cbPath).mtimeMs;
        assert.equal(mtimeBefore, mtimeAfter, 'file should not be rewritten for CLOSED state');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('resetCircuitBreaker: promotes newer orphan tmp before deciding no-op', () => {
    const tmpDir = makeTmpDir();
    try {
        const cbPath = path.join(tmpDir, 'circuit_breaker.json');
        const tmpPath = `${cbPath}.tmp.99999999`;
        fs.writeFileSync(cbPath, JSON.stringify(makeFreshState({ state: 'CLOSED' })));
        fs.writeFileSync(tmpPath, JSON.stringify(makeFreshState({
            state: 'OPEN',
            history: [{ timestamp: '2026-01-01T00:00:00Z', iteration: 1, from: 'CLOSED', to: 'OPEN', reason: 'test' }],
        })));
        const baseTime = new Date('2026-04-28T12:00:00.000Z');
        const tmpTime = new Date('2026-04-28T12:00:01.000Z');
        fs.utimesSync(cbPath, baseTime, baseTime);
        fs.utimesSync(tmpPath, tmpTime, tmpTime);

        resetCircuitBreaker(tmpDir, 'recover tmp reset');

        const after = JSON.parse(fs.readFileSync(cbPath, 'utf-8'));
        assert.equal(after.state, 'CLOSED');
        assert.equal(fs.existsSync(tmpPath), false, 'reset should consume the newer tmp snapshot');
        assert.equal(after.history.at(-1).from, 'OPEN');
        assert.match(after.history.at(-1).reason, /recover tmp reset/);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// State persistence round-trip
// ---------------------------------------------------------------------------

test('state persistence: write then read back produces equivalent state', () => {
    const tmpDir = makeTmpDir();
    try {
        const settings = makeSettings({ halfOpenAfter: 2, noProgressThreshold: 5, sameErrorThreshold: 5 });
        let state = makeFreshState();

        // Simulate some iterations
        state = recordIterationResult(state, { hasProgress: false, errorSignature: null }, 1, settings);
        state = recordIterationResult(state, { hasProgress: false, errorSignature: null }, 2, settings);
        // Should be HALF_OPEN now
        assert.equal(state.state, 'HALF_OPEN');

        // Write to disk
        const cbPath = path.join(tmpDir, 'circuit_breaker.json');
        fs.writeFileSync(cbPath, JSON.stringify(state, null, 2));

        // Read back via initCircuitBreaker
        const loaded = initCircuitBreaker(tmpDir, settings);
        assert.equal(loaded.state, state.state);
        assert.equal(loaded.consecutive_no_progress, state.consecutive_no_progress);
        assert.equal(loaded.consecutive_same_error, state.consecutive_same_error);
        assert.equal(loaded.last_error_signature, state.last_error_signature);
        assert.equal(loaded.total_opens, state.total_opens);
        assert.equal(loaded.history.length, state.history.length);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Integration: circuit-reset.js CLI
// ---------------------------------------------------------------------------

const CIRCUIT_RESET_BIN = path.join(import.meta.dirname, '..', 'bin', 'circuit-reset.js');

function runResetCli(args, env = {}) {
    // 10s → 30s: budget for system load when run alongside concurrent
    // codex/tmux work. Tests validate CLI behavior, not wall-clock.
    return spawnSync(process.execPath, [CIRCUIT_RESET_BIN, ...args], {
        encoding: 'utf-8',
        timeout: 30000,
        env: { ...process.env, ...env },
    });
}

test('circuit-reset CLI: exits 1 with no args', () => {
    const result = runResetCli([]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage/);
});

test('circuit-reset CLI: resets OPEN session to CLOSED', () => {
    const tmpDir = makeTmpDir();
    try {
        const openState = makeFreshState({ state: 'OPEN', total_opens: 1 });
        fs.writeFileSync(path.join(tmpDir, 'circuit_breaker.json'), JSON.stringify(openState));

        const result = runResetCli([tmpDir, '--reason', 'CLI test reset']);
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);

        const after = JSON.parse(fs.readFileSync(path.join(tmpDir, 'circuit_breaker.json'), 'utf-8'));
        assert.equal(after.state, 'CLOSED');
        assert.equal(after.consecutive_no_progress, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('circuit-reset CLI: CLOSED session exits 0 as no-op', () => {
    const tmpDir = makeTmpDir();
    try {
        const closedState = makeFreshState({ state: 'CLOSED' });
        fs.writeFileSync(path.join(tmpDir, 'circuit_breaker.json'), JSON.stringify(closedState));

        const result = runResetCli([tmpDir]);
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('circuit-reset CLI: writes valid JSON after reset', () => {
    const tmpDir = makeTmpDir();
    try {
        const openState = makeFreshState({ state: 'OPEN' });
        fs.writeFileSync(path.join(tmpDir, 'circuit_breaker.json'), JSON.stringify(openState));

        runResetCli([tmpDir]);

        const raw = fs.readFileSync(path.join(tmpDir, 'circuit_breaker.json'), 'utf-8');
        const parsed = JSON.parse(raw);
        assert.equal(typeof parsed.state, 'string');
        assert.ok(Array.isArray(parsed.history));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('circuit-reset CLI: promotes newer orphan tmp before no-op check', () => {
    const tmpDir = makeTmpDir();
    try {
        const cbPath = path.join(tmpDir, 'circuit_breaker.json');
        const tmpPath = `${cbPath}.tmp.99999999`;
        fs.writeFileSync(cbPath, JSON.stringify(makeFreshState({ state: 'CLOSED' })));
        fs.writeFileSync(tmpPath, JSON.stringify(makeFreshState({ state: 'OPEN' })));
        const baseTime = new Date('2026-04-28T12:00:00.000Z');
        const tmpTime = new Date('2026-04-28T12:00:01.000Z');
        fs.utimesSync(cbPath, baseTime, baseTime);
        fs.utimesSync(tmpPath, tmpTime, tmpTime);

        const result = runResetCli([tmpDir, '--reason', 'CLI tmp recovery']);

        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const after = JSON.parse(fs.readFileSync(cbPath, 'utf-8'));
        assert.equal(after.state, 'CLOSED');
        assert.equal(fs.existsSync(tmpPath), false, 'CLI should consume stale writer tmp');
        assert.equal(after.history.at(-1).from, 'OPEN');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Integration: buildTmuxNotification — circuit_open is a failure
// ---------------------------------------------------------------------------

test('buildTmuxNotification: circuit_open shows "Failed" with isFailure semantics', () => {
    const n = buildTmuxNotification('circuit_open', 'implement', 5, 120);
    assert.equal(n.title, '🥒 Pickle Run Failed');
    assert.ok(n.subtitle.includes('Exit: circuit_open'), `Expected "Exit: circuit_open" in subtitle, got: ${n.subtitle}`);
    assert.ok(n.subtitle.includes('phase: implement'), `Expected phase in subtitle, got: ${n.subtitle}`);
});

// ---------------------------------------------------------------------------
// Gap 2: HALF_OPEN → OPEN via sameErrorThreshold
// ---------------------------------------------------------------------------

test('recordIterationResult: HALF_OPEN → OPEN when same error hits sameErrorThreshold', () => {
    const settings = makeSettings({ sameErrorThreshold: 3, noProgressThreshold: 10 });
    const state = makeFreshState({
        state: 'HALF_OPEN',
        consecutive_same_error: 2,
        last_error_signature: 'repeated-err',
        consecutive_no_progress: 2,
    });
    const next = recordIterationResult(state, { hasProgress: false, errorSignature: 'repeated-err' }, 7, settings);
    assert.equal(next.state, 'OPEN');
    assert.equal(next.consecutive_same_error, 3);
    assert.ok(next.reason.includes('Same error repeated'), `reason should mention same error, got: ${next.reason}`);
});

// ---------------------------------------------------------------------------
// Gap 3: ISO 8601 timestamp normalization
// ---------------------------------------------------------------------------

test('AP-EXT-ITER221-01: an ISO 8601 timestamp is replaced WHOLE, sub-second field included', () => {
    // The ISO rule must run before the line:col rule. Reversed, `:\d+:\d+` eats the
    // `:MM:SS` and leaves `2026-03-01T15:<N>:<N>.376Z` — the `.376` survives and varies
    // per occurrence, so the same error never produces the same signature twice.
    const result = normalizeErrorSignature('Error at 2026-03-01T15:12:06.376Z in module');
    assert.equal(result, 'Error at <TS> in module');
    assert.ok(!/\.\d+Z/.test(result), `sub-second field must not survive, got: ${result}`);
});

test('AP-EXT-ITER221-01: timestamps differing only in sub-seconds normalize identically', () => {
    // The dominant machine-generated shape: `new Date().toISOString()` ALWAYS emits
    // `.sssZ`. Previously pinned only for the rare no-fractional form, which dedups
    // via the line:col rule by accident and hides this case.
    const a = normalizeErrorSignature('Error at 2026-03-01T15:12:06.376Z in module');
    const b = normalizeErrorSignature('Error at 2026-03-01T15:12:06.981Z in module');
    assert.equal(a, b, `Sub-second-only difference must dedup:\n  a: ${a}\n  b: ${b}`);
});

test('normalizeErrorSignature: timestamps at same hour/date normalize identically (no fractional)', () => {
    // Two errors at the same date/hour but different min:sec (no fractional seconds)
    const a = normalizeErrorSignature('Error at 2026-03-01T15:12:06Z in module');
    const b = normalizeErrorSignature('Error at 2026-03-01T15:59:59Z in module');
    assert.equal(a, b, `Same-date/hour timestamps should dedup:\n  a: ${a}\n  b: ${b}`);
});

test('AP-EXT-ITER221-01: a real line:col is still scrubbed alongside a timestamp', () => {
    // Negative control: reordering must not disarm the line:col rule. Without this,
    // the fix could pass by deleting the `:\d+:\d+` rule outright.
    const result = normalizeErrorSignature('at 2026-03-01T15:12:06.376Z /a/b/foo.ts:42:17 failed');
    assert.equal(result, 'at <TS> <PATH>:<N>:<N> failed');
});

test('AP-EXT-ITER221-01: a repeated timestamped error trips the same-error breaker', () => {
    // Exercises the real data flow: worker stream-json -> extractErrorSignature ->
    // recordIterationResult, one iteration per occurrence. Each occurrence carries its
    // own wall-clock timestamp, exactly as a re-emitted worker failure does.
    const settings = makeSettings({ sameErrorThreshold: 3, noProgressThreshold: 99, halfOpenAfter: 98 });
    const ndjson = (ts) => [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }),
        JSON.stringify({
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: `FATAL: worker gate failed at ${ts}` }] },
        }),
        JSON.stringify({ type: 'result', subtype: 'error_during_execution' }),
    ].join('\n');

    const stamps = ['2026-03-01T15:12:06.101Z', '2026-03-01T15:12:07.202Z', '2026-03-01T15:12:08.303Z'];
    const signatures = stamps.map(ts => extractErrorSignature(ndjson(ts)));
    assert.equal(new Set(signatures).size, 1, `one error must yield one signature, got: ${JSON.stringify(signatures)}`);

    let state = makeFreshState({ last_known_head: 'abc1234' });
    stamps.forEach((ts, i) => {
        state = recordIterationResult(state, { hasProgress: false, errorSignature: extractErrorSignature(ndjson(ts)) }, i + 1, settings);
    });
    assert.equal(state.consecutive_same_error, 3, 'the same error must accumulate across iterations');
    assert.equal(state.state, 'OPEN', 'the same-error breaker must trip');
    assert.equal(canExecute(state), false, 'a tripped breaker must stop the loop');
});

test('AP-EXT-ITER221-01: genuinely different errors still do NOT trip the same-error breaker', () => {
    // Over-rejection control: the fix must not collapse distinct errors into one
    // signature, which would trip the breaker on a run that is still making progress.
    const settings = makeSettings({ sameErrorThreshold: 3, noProgressThreshold: 99, halfOpenAfter: 98 });
    const messages = [
        'FATAL: tsc failed at 2026-03-01T15:12:06.101Z',
        'FATAL: eslint failed at 2026-03-01T15:12:07.202Z',
        'FATAL: tests failed at 2026-03-01T15:12:08.303Z',
    ];
    let state = makeFreshState({ last_known_head: 'abc1234' });
    messages.forEach((m, i) => {
        state = recordIterationResult(state, { hasProgress: false, errorSignature: normalizeErrorSignature(m) }, i + 1, settings);
    });
    assert.equal(state.consecutive_same_error, 1, 'distinct errors must reset the same-error counter');
    assert.equal(state.state, 'CLOSED');
});

// ---------------------------------------------------------------------------
// Gap 4: Two paths in same module produce same signature
// ---------------------------------------------------------------------------

test('normalizeErrorSignature: different user home paths produce same signature', () => {
    const sigAlice = normalizeErrorSignature('Error in /Users/alice/project/foo.ts');
    const sigBob = normalizeErrorSignature('Error in /Users/bob/project/foo.ts');
    assert.equal(sigAlice, sigBob, `Signatures should match:\n  alice: ${sigAlice}\n  bob:   ${sigBob}`);
});

// ---------------------------------------------------------------------------
// Gap 5: Exact PRD composite test vector
// ---------------------------------------------------------------------------

test('normalizeErrorSignature: PRD composite vector — path + line:col', () => {
    const result = normalizeErrorSignature('Error in /Users/greg/foo/bar.ts:42:17');
    assert.equal(result, 'Error in <PATH>:<N>:<N>');
});

// ---------------------------------------------------------------------------
// Gap 6: circuit_recovery activity event detection pattern
// ---------------------------------------------------------------------------

test('recordIterationResult: HALF_OPEN → CLOSED transition is detectable by comparing states', () => {
    const settings = makeSettings();
    const state = makeFreshState({
        state: 'HALF_OPEN',
        consecutive_no_progress: 3,
        consecutive_same_error: 0,
    });
    const prevState = state.state;
    const next = recordIterationResult(state, { hasProgress: true, errorSignature: null }, 8, settings);
    const newState = next.state;
    assert.equal(prevState, 'HALF_OPEN');
    assert.equal(newState, 'CLOSED');
    const isRecovery = prevState === 'HALF_OPEN' && newState === 'CLOSED';
    assert.equal(isRecovery, true, 'caller should detect circuit_recovery via state comparison');
    // Verify the transition is recorded in history
    const recoveryEntry = next.history.find(h => h.from === 'HALF_OPEN' && h.to === 'CLOSED');
    assert.ok(recoveryEntry, 'history should contain the HALF_OPEN → CLOSED transition');
});

// ---------------------------------------------------------------------------
// Gap 7: CB-disabled stall counter concept
// ---------------------------------------------------------------------------

test('loadSettings: returns enabled=false when default_circuit_breaker_enabled is false', () => {
    const tmpDir = makeTmpDir();
    try {
        fs.writeFileSync(path.join(tmpDir, 'pickle_settings.json'), JSON.stringify({
            default_circuit_breaker_enabled: false,
        }));
        const cfg = loadSettings(tmpDir);
        assert.equal(cfg.enabled, false, 'CB should be disabled when config says so');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('canExecute: is irrelevant when CB is disabled — config flag gates the call', () => {
    const tmpDir = makeTmpDir();
    try {
        fs.writeFileSync(path.join(tmpDir, 'pickle_settings.json'), JSON.stringify({
            default_circuit_breaker_enabled: false,
        }));
        const cfg = loadSettings(tmpDir);
        assert.equal(cfg.enabled, false);
        // When CB is disabled, the caller should skip canExecute entirely.
        // Prove the flag is the gate: even an OPEN breaker would be ignored.
        const openState = makeFreshState({ state: 'OPEN' });
        assert.equal(canExecute(openState), false, 'canExecute says OPEN=blocked');
        // But the caller checks cfg.enabled FIRST — if false, canExecute is never called.
        // The config flag overrides the circuit state.
        assert.equal(cfg.enabled, false, 'config.enabled=false means CB check is skipped entirely');
        assert.equal(cfg.enabled || canExecute(openState), false,
            'enabled=false short-circuits: canExecute result is irrelevant');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Edge cases: non-array history, string boolean, tool_use-only (pass 9)
// ---------------------------------------------------------------------------

test('initCircuitBreaker: non-array history field defaults to empty array', () => {
    const tmpDir = makeTmpDir();
    try {
        const malformed = makeFreshState({ state: 'CLOSED', history: 'not-an-array' });
        fs.writeFileSync(path.join(tmpDir, 'circuit_breaker.json'), JSON.stringify(malformed));
        const state = initCircuitBreaker(tmpDir, makeSettings());
        assert.equal(state.state, 'CLOSED');
        assert.ok(Array.isArray(state.history), 'history should be coerced to array');
        assert.equal(state.history.length, 0, 'non-array history should default to []');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('initCircuitBreaker: history=null defaults to empty array', () => {
    const tmpDir = makeTmpDir();
    try {
        const malformed = makeFreshState({ state: 'HALF_OPEN', history: null });
        fs.writeFileSync(path.join(tmpDir, 'circuit_breaker.json'), JSON.stringify(malformed));
        const state = initCircuitBreaker(tmpDir, makeSettings());
        assert.ok(Array.isArray(state.history), 'null history should default to []');
        assert.equal(state.history.length, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('loadSettings: string "true" for boolean config is ignored (strict typeof check)', () => {
    const tmpDir = makeTmpDir();
    try {
        fs.writeFileSync(path.join(tmpDir, 'pickle_settings.json'), JSON.stringify({
            default_circuit_breaker_enabled: "true", // string, not boolean
        }));
        const cfg = loadSettings(tmpDir);
        assert.equal(cfg.enabled, true,
            'string "true" should not override default — typeof check rejects non-boolean');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('loadSettings: Infinity and negative values for numeric thresholds are rejected', () => {
    const tmpDir = makeTmpDir();
    try {
        fs.writeFileSync(path.join(tmpDir, 'pickle_settings.json'), JSON.stringify({
            default_cb_no_progress_threshold: Infinity,
            default_cb_same_error_threshold: -5,
            default_cb_half_open_after: NaN,
        }));
        const cfg = loadSettings(tmpDir);
        // Infinity: Number.isFinite(Infinity) → false → default 5, then min 2 → 5
        assert.equal(cfg.noProgressThreshold, 5, 'Infinity should be rejected, keeping default');
        // -5: isFinite but fails > 0 check → default 5, then min 2 → 5
        assert.equal(cfg.sameErrorThreshold, 5, 'negative value should be rejected, keeping default');
        // NaN: isFinite(NaN) → false → default 2
        assert.equal(cfg.halfOpenAfter, 2, 'NaN should be rejected, keeping default');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// CB + state.json iteration sync (F17 invariant)
// ---------------------------------------------------------------------------

test('CB last_progress_iteration stays in sync with state.json iteration — no false staleness', () => {
    // When F17 writes CB inside sm.update, last_progress_iteration should equal
    // the state.json iteration at write time. Reloading must NOT reset to fresh.
    const tmpDir = makeTmpDir();
    try {
        const stateIter = 7;
        fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify({ iteration: stateIter }));

        const settings = makeSettings();
        let cbState = initCircuitBreaker(tmpDir, settings);

        // Record progress at iteration matching state.json (as F17 does)
        cbState = recordIterationResult(
            cbState, { hasProgress: true, errorSignature: null }, stateIter, settings
        );
        // Write CB file (simulating mux-runner's sm.update-protected write)
        fs.writeFileSync(path.join(tmpDir, 'circuit_breaker.json'), JSON.stringify(cbState));

        // Reload: initCircuitBreaker trusts the on-disk breaker state as-is (C3).
        const reloaded = initCircuitBreaker(tmpDir, settings);
        assert.equal(reloaded.last_progress_iteration, stateIter,
            'CB last_progress_iteration should match state.json iteration after synced write');
        assert.equal(reloaded.consecutive_no_progress, 0,
            'synced CB should not be reset (consecutive_no_progress must stay 0)');
        assert.equal(reloaded.state, 'CLOSED', 'synced CB should remain CLOSED');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('AC1: a CLOSED breaker persisted at 4/5 starts fresh on a process start and survives one no-progress iteration', () => {
    // The relaunch contract (reverses C3): a new mux-runner process does not inherit the
    // previous process's no-progress count, so an environmental stop (quota, unsupported
    // model) cannot trip the breaker within one second of the relaunch.
    const tmpDir = makeTmpDir();
    try {
        const settings = makeSettings({ noProgressThreshold: 5 });
        fs.writeFileSync(path.join(tmpDir, 'circuit_breaker.json'), JSON.stringify(
            makeFreshState({ state: 'CLOSED', consecutive_no_progress: 4, last_progress_iteration: 50 })));

        let cbState = startFreshCircuitBreaker(tmpDir);
        cbState = recordIterationResult(cbState, { hasProgress: false, errorSignature: null }, 51, settings);

        assert.equal(canExecute(cbState), true, 'one no-progress iteration after a relaunch must not trip the breaker');
        assert.equal(cbState.consecutive_no_progress, 1);
        assert.equal(cbState.state, 'CLOSED');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('AC1b: a persisted OPEN breaker starts fresh on a process start; history keeps prior entries plus a process start transition', () => {
    const tmpDir = makeTmpDir();
    try {
        const prior = { timestamp: '2026-01-01T00:00:00.000Z', iteration: 5, from: 'CLOSED', to: 'OPEN', reason: 'No progress in 5 iterations' };
        fs.writeFileSync(path.join(tmpDir, 'circuit_breaker.json'), JSON.stringify(
            makeFreshState({ state: 'OPEN', consecutive_no_progress: 5, total_opens: 1, reason: 'No progress in 5 iterations', history: [prior] })));

        const fresh = startFreshCircuitBreaker(tmpDir);

        assert.equal(canExecute(fresh), true);
        assert.equal(fresh.state, 'CLOSED');
        assert.equal(fresh.consecutive_no_progress, 0);
        assert.equal(fresh.consecutive_same_error, 0);
        assert.equal(fresh.history.length, 2);
        assert.deepEqual(fresh.history[0], prior);
        assert.equal(fresh.history[1].reason, 'process start');
        assert.equal(fresh.history[1].from, 'OPEN');
        assert.equal(fresh.history[1].to, 'CLOSED');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('startFreshCircuitBreaker: absent or corrupt breaker file yields a fresh state with no prior history', () => {
    const absent = makeTmpDir();
    const corrupt = makeTmpDir();
    try {
        fs.writeFileSync(path.join(corrupt, 'circuit_breaker.json'), '{ not json');
        for (const dir of [absent, corrupt]) {
            const fresh = startFreshCircuitBreaker(dir);
            assert.equal(fresh.state, 'CLOSED');
            assert.equal(fresh.consecutive_no_progress, 0);
            assert.equal(fresh.history.length, 0, 'no prior breaker, nothing to record a transition from');
        }
    } finally {
        fs.rmSync(absent, { recursive: true, force: true });
        fs.rmSync(corrupt, { recursive: true, force: true });
    }
});

test('AC2 control: five in-process no-progress iterations still trip OPEN after a process start', () => {
    const tmpDir = makeTmpDir();
    try {
        const settings = makeSettings({ noProgressThreshold: 5 });
        fs.writeFileSync(path.join(tmpDir, 'circuit_breaker.json'), JSON.stringify(
            makeFreshState({ state: 'CLOSED', consecutive_no_progress: 4 })));

        let cbState = startFreshCircuitBreaker(tmpDir);
        for (let i = 1; i <= 4; i++) {
            cbState = recordIterationResult(cbState, { hasProgress: false, errorSignature: null }, i, settings);
            assert.notEqual(cbState.state, 'OPEN', `iteration ${i} must not trip`);
        }
        cbState = recordIterationResult(cbState, { hasProgress: false, errorSignature: null }, 5, settings);

        assert.equal(cbState.state, 'OPEN', 'within one process the breaker still accumulates and trips at the threshold');
        assert.equal(canExecute(cbState), false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

/** Call sites of `name` in every non-test `.ts` under `src/`, read from the AST so a comment cannot count. */
function srcCallSites(name) {
    const srcRoot = path.join(import.meta.dirname, '..', 'src');
    const sites = [];
    let parsed = 0;
    for (const entry of fs.readdirSync(srcRoot, { recursive: true })) {
        const rel = String(entry);
        if (!rel.endsWith('.ts') || rel.endsWith('.d.ts') || rel.includes('__tests__')) continue;
        const source = fs.readFileSync(path.join(srcRoot, rel), 'utf-8');
        const sourceFile = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true);
        parsed += 1;
        const visit = (node) => {
            if (ts.isCallExpression(node)) {
                const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
                if (ts.isIdentifier(callee) && callee.text === name) sites.push(rel);
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
    }
    assert.ok(parsed > 10, `src walk parsed only ${parsed} files`);
    return sites;
}

test('a mux-runner process start loads the breaker fresh, never the persisted counts', () => {
    // The service tests above call startFreshCircuitBreaker directly, so they stay green if the
    // runner goes back to initCircuitBreaker and inherits a mid-count breaker on every relaunch.
    assert.ok(
        srcCallSites('startFreshCircuitBreaker').includes(path.join('bin', 'mux-runner.ts')),
        'mux-runner must start its breaker through startFreshCircuitBreaker',
    );
    assert.deepEqual(srcCallSites('initCircuitBreaker'), [], 'no production code may load the persisted breaker as-is');
});

test('extractErrorSignature: assistant with only tool_use blocks (no text) returns null', () => {
    const ndjson = [
        JSON.stringify({
            type: 'assistant',
            message: {
                content: [
                    { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: '/foo' } },
                ]
            }
        }),
        JSON.stringify({ type: 'result', subtype: 'error_max_turns' }),
    ].join('\n');
    const sig = extractErrorSignature(ndjson);
    assert.equal(sig, null, 'should return null when assistant has no text blocks');
});

// ---------------------------------------------------------------------------
// F26: history array cap at 1000
// ---------------------------------------------------------------------------

test('history cap: 1001st transition shifts oldest, length stays 1000', () => {
    const settings = makeSettings({ halfOpenAfter: 2, noProgressThreshold: 5, sameErrorThreshold: 5 });
    // Pre-populate with exactly 1000 history entries
    const prePopulated = Array.from({ length: 1000 }, (_, i) => ({
        timestamp: new Date().toISOString(),
        iteration: i,
        from: 'CLOSED',
        to: 'HALF_OPEN',
        reason: `entry ${i}`,
    }));
    // State at 1 no-progress: one more triggers CLOSED → HALF_OPEN transition (1001st push)
    let state = makeFreshState({ state: 'CLOSED', consecutive_no_progress: 1, history: prePopulated });
    state = recordIterationResult(state, { hasProgress: false, errorSignature: null }, 1001, settings);
    assert.equal(state.state, 'HALF_OPEN', 'should have transitioned to HALF_OPEN');
    assert.equal(state.history.length, 1000, `expected 1000, got ${state.history.length}`);
    assert.ok(!state.history.some(h => h.reason === 'entry 0'), 'oldest entry should have been trimmed');
    assert.ok(state.history.some(h => h.reason === 'entry 1'), 'entry 1 should still be present');
});

// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
    loadSettings,
    initCircuitBreaker,
    canExecute,
    countFilesChanged,
    detectProgress,
    extractErrorSignature,
    isConstraintDiscoverySignature,
    normalizeErrorSignature,
    recordIterationResult,
    resetCircuitBreaker,
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
    assert.match(state.reason, /\/pickle-correct-course "<discovery>"/);
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
// Gap 1: countFilesChanged — zero test coverage
// ---------------------------------------------------------------------------

test('countFilesChanged: parses plural "files changed" from diff --stat output', () => {
    assert.equal(countFilesChanged(' 3 files changed, 10 insertions(+)'), 3);
});

test('countFilesChanged: parses singular "file changed" from diff --stat output', () => {
    assert.equal(countFilesChanged(' 1 file changed'), 1);
});

test('countFilesChanged: returns 0 for empty string', () => {
    assert.equal(countFilesChanged(''), 0);
});

test('countFilesChanged: returns 0 for unrelated text', () => {
    assert.equal(countFilesChanged('no matches here'), 0);
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

test('normalizeErrorSignature: ISO 8601 timestamp has time digits neutralized by line:col rule', () => {
    // Rules fire in order: paths → :\d+:\d+ → ISO timestamps → UUIDs.
    // A real ISO timestamp's :MM:SS is consumed by line:col before the ISO regex runs.
    const result = normalizeErrorSignature('Error at 2026-03-01T15:12:06.376Z in module');
    assert.equal(result, 'Error at 2026-03-01T15:<N>:<N>.376Z in module');
    assert.ok(!result.includes(':12:06'), 'varying time digits are neutralized');
});

test('normalizeErrorSignature: timestamps at same hour/date normalize identically (no fractional)', () => {
    // Two errors at the same date/hour but different min:sec (no fractional seconds)
    const a = normalizeErrorSignature('Error at 2026-03-01T15:12:06Z in module');
    const b = normalizeErrorSignature('Error at 2026-03-01T15:59:59Z in module');
    assert.equal(a, b, `Same-date/hour timestamps should dedup:\n  a: ${a}\n  b: ${b}`);
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

test('AC-C3-1: a breaker count accumulated in phase N is still visible in phase N+1', () => {
    // Drives two phases: phase N accumulates real progress at a high state.iteration
    // (mirrors mux-runner's pickle-phase loop); phase N+1 simulates the session's
    // iteration counter being taken over by a different phase runner (e.g.
    // resetStateForPhase / setup.js --resume --reset / microverse-runner's own loop
    // driving state.iteration back down) with NO circuit_breaker.json write in between —
    // exactly the shape a worker cannot script directly (circuit_breaker.json is
    // R-WSRC-forbidden in a live session), so it is driven at the service seam here.
    const tmpDir = makeTmpDir();
    try {
        // Phase N: state.json at iteration 20, CB claims progress up to iteration 20.
        fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify({ iteration: 20 }));
        const phaseN = makeFreshState({
            state: 'CLOSED', consecutive_no_progress: 3, last_progress_iteration: 20,
        });
        fs.writeFileSync(path.join(tmpDir, 'circuit_breaker.json'), JSON.stringify(phaseN));

        // Phase N+1: the session's iteration counter regresses (a different phase runner
        // or a resumed run now owns state.json), with circuit_breaker.json untouched.
        fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify({ iteration: 2 }));

        const reloaded = initCircuitBreaker(tmpDir, makeSettings());
        assert.equal(reloaded.last_progress_iteration, 20, 'phase N+1 must still see phase N\'s accumulated progress marker');
        assert.equal(reloaded.consecutive_no_progress, 3, 'phase N+1 must still see phase N\'s accumulated no-progress count');
        assert.equal(reloaded.state, 'CLOSED');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('AC-C3-2: a run that would trip the breaker mid-phase still trips it when failures straddle a phase boundary', () => {
    const tmpDir = makeTmpDir();
    try {
        const settings = makeSettings({ noProgressThreshold: 5 });

        // Phase N: 4 consecutive no-progress iterations accumulate at a high iteration.
        fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify({ iteration: 50 }));
        const phaseN = makeFreshState({
            state: 'CLOSED', consecutive_no_progress: 4, last_progress_iteration: 50,
        });
        fs.writeFileSync(path.join(tmpDir, 'circuit_breaker.json'), JSON.stringify(phaseN));

        // Boundary: state.json's iteration regresses to a low value with no CB write.
        fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify({ iteration: 3 }));

        // Phase N+1's mux-runner starts, loads the breaker, and records the 5th
        // consecutive no-progress iteration at ITS OWN (lower) iteration number.
        let cbState = initCircuitBreaker(tmpDir, settings);
        cbState = recordIterationResult(cbState, { hasProgress: false, errorSignature: null }, 4, settings);

        assert.equal(cbState.state, 'OPEN', 'the 5th consecutive no-progress iteration must trip the breaker across the boundary');
        assert.equal(cbState.consecutive_no_progress, 5);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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

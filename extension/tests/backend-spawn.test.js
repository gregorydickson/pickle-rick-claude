// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
    buildWorkerInvocation,
    buildManagerInvocation,
    buildJudgeInvocation,
    resolveBackend,
    resolveBackendFromStateFile,
    resolveBackendFromStateFileWithSource,
    resolveWorkerBackendFromState,
    resolveWorkerBackendFromStateFile,
    isBackend,
    backendEnvOverrides,
} from '../services/backend-spawn.js';

function mkTmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withUnsetBackendEnv(fn) {
    const prev = process.env.PICKLE_BACKEND;
    delete process.env.PICKLE_BACKEND;
    try {
        fn();
    } finally {
        if (prev === undefined) delete process.env.PICKLE_BACKEND;
        else process.env.PICKLE_BACKEND = prev;
    }
}

// --- resolveBackend ---

test('resolveBackend: returns claude when state is null', () => {
    withUnsetBackendEnv(() => {
        assert.equal(resolveBackend(null), 'claude');
    });
});

test('resolveBackend: returns claude when backend is absent', () => {
    withUnsetBackendEnv(() => {
        assert.equal(resolveBackend({}), 'claude');
    });
});

test('resolveBackend: reads backend from state', () => {
    assert.equal(resolveBackend({ backend: 'codex' }), 'codex');
});

test('backend.hermes-accepted: resolves hermes from state and env', () => {
    withUnsetBackendEnv(() => {
        assert.equal(isBackend('hermes'), true);
        assert.equal(resolveBackend({ backend: 'hermes' }), 'hermes');
    });

    const prev = process.env.PICKLE_BACKEND;
    process.env.PICKLE_BACKEND = 'hermes';
    try {
        assert.equal(resolveBackend({}), 'hermes');
    } finally {
        if (prev === undefined) delete process.env.PICKLE_BACKEND;
        else process.env.PICKLE_BACKEND = prev;
    }
});

test('resolveBackend: rejects invalid backend', () => {
    withUnsetBackendEnv(() => {
        assert.equal(resolveBackend({ backend: 'unknown-backend' }), 'claude');
    });
});

test('resolveBackend: falls through to PICKLE_BACKEND env', () => {
    const prev = process.env.PICKLE_BACKEND;
    process.env.PICKLE_BACKEND = 'codex';
    try {
        assert.equal(resolveBackend({}), 'codex');
    } finally {
        if (prev === undefined) delete process.env.PICKLE_BACKEND;
        else process.env.PICKLE_BACKEND = prev;
    }
});

test('isBackend: validates values', () => {
    assert.equal(isBackend('claude'), true);
    assert.equal(isBackend('codex'), true);
    assert.equal(isBackend('hermes'), true);
    assert.equal(isBackend('gpt'), false);
    assert.equal(isBackend(42), false);
});

// --- resolveBackendFromStateFile ---

test('resolveBackendFromStateFile: reads backend from JSON', () => {
    const dir = mkTmpDir('backend-spawn-');
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, JSON.stringify({ backend: 'codex', active: true }));
    assert.equal(resolveBackendFromStateFile(file), 'codex');
});

test('backend.hermes-accepted: reads hermes backend from state file', () => {
    const dir = mkTmpDir('backend-spawn-');
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, JSON.stringify({ backend: 'hermes', active: true }));
    assert.equal(resolveBackendFromStateFile(file), 'hermes');
});

test('resolveBackendFromStateFile: defaults to claude on missing file', () => {
    withUnsetBackendEnv(() => {
        assert.equal(resolveBackendFromStateFile('/nonexistent/state.json'), 'claude');
    });
});

test('resolveBackendFromStateFile: defaults to claude on corrupt JSON', () => {
    const dir = mkTmpDir('backend-spawn-');
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, '{not valid json');
    withUnsetBackendEnv(() => {
        assert.equal(resolveBackendFromStateFile(file), 'claude');
    });
});

// Orphan-tmp recovery via StateManager.read requires a complete state snapshot
// (working_dir, original_prompt, started_at, session_dir as strings; iteration,
// max_iterations, max_time_minutes, worker_timeout_seconds, start_time_epoch as
// finite numbers; history array; completion_promise key present). Partial
// snapshots are intentionally rejected per state-manager.ts orphan-tmp
// validation invariant — keeps a partial mid-write tmp from corrupting state.
function makeFullStateSnapshot(overrides = {}) {
    return {
        working_dir: '/tmp/test-cwd',
        backend: 'claude',
        step: 'research',
        iteration: 1,
        max_iterations: 50,
        max_time_minutes: 720,
        worker_timeout_seconds: 1200,
        start_time_epoch: 1700000000,
        original_prompt: 'test',
        session_dir: '/tmp/test-session',
        started_at: '2026-01-01T00:00:00Z',
        history: [],
        completion_promise: null,
        schema_version: 3,
        ...overrides,
    };
}

test('resolveBackendFromStateFile: recovers higher-iteration orphan tmp backend before resolving', () => {
    const dir = mkTmpDir('backend-spawn-');
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, JSON.stringify(makeFullStateSnapshot({ backend: 'claude', iteration: 1 })));
    fs.writeFileSync(
        `${file}.tmp.99999999`,
        JSON.stringify(makeFullStateSnapshot({ backend: 'codex', iteration: 2 }))
    );
    withUnsetBackendEnv(() => {
        assert.equal(resolveBackendFromStateFile(file), 'codex');
    });
    const promoted = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(promoted.backend, 'codex');
});

test('resolveBackendFromStateFile: recovers newer same-iteration orphan tmp backend before resolving', () => {
    const dir = mkTmpDir('backend-spawn-');
    const file = path.join(dir, 'state.json');
    const baseTs = new Date('2026-04-28T12:00:00.000Z');
    const tmpTs = new Date('2026-04-28T12:00:01.000Z');
    fs.writeFileSync(file, JSON.stringify(makeFullStateSnapshot({ backend: 'claude', iteration: 7 }), null, 2));
    fs.utimesSync(file, baseTs, baseTs);
    fs.writeFileSync(
        `${file}.tmp.99999999`,
        JSON.stringify(makeFullStateSnapshot({ backend: 'codex', iteration: 7 }), null, 2)
    );
    fs.utimesSync(`${file}.tmp.99999999`, tmpTs, tmpTs);
    withUnsetBackendEnv(() => {
        assert.equal(resolveBackendFromStateFile(file), 'codex');
    });
    const promoted = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(promoted.backend, 'codex');
});

test('resolveBackendFromStateFileWithSource: cliBackend overrides persisted state backend', () => {
    const dir = mkTmpDir('backend-spawn-');
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, JSON.stringify({ backend: 'codex', active: true }));
    withUnsetBackendEnv(() => {
        const resolved = resolveBackendFromStateFileWithSource(file, 'hermes');
        assert.equal(resolved.backend, 'hermes');
        assert.equal(resolved.source, 'cli-flag-override');
    });
});

test('resolveWorkerBackendFromState: worker_backend wins over backend', () => {
    withUnsetBackendEnv(() => {
        const resolved = resolveWorkerBackendFromState({ backend: 'claude', worker_backend: 'codex' });
        assert.equal(resolved.backend, 'codex');
        assert.equal(resolved.managerBackend, 'claude');
        assert.equal(resolved.workerBackend, 'codex');
        assert.equal(resolved.source, 'worker_backend');
    });
});

test('resolveWorkerBackendFromState: falls back to backend when worker_backend unset', () => {
    withUnsetBackendEnv(() => {
        const resolved = resolveWorkerBackendFromState({ backend: 'codex' });
        assert.equal(resolved.backend, 'codex');
        assert.equal(resolved.managerBackend, 'codex');
        assert.equal(resolved.workerBackend, null);
        assert.equal(resolved.source, 'backend');
    });
});

test('resolveWorkerBackendFromState: PICKLE_REFINEMENT_LOCK=1 forces claude', () => {
    const prev = process.env.PICKLE_REFINEMENT_LOCK;
    process.env.PICKLE_REFINEMENT_LOCK = '1';
    try {
        const resolved = resolveWorkerBackendFromState({ backend: 'claude', worker_backend: 'hermes' });
        assert.equal(resolved.backend, 'claude');
        assert.equal(resolved.managerBackend, 'claude');
        assert.equal(resolved.workerBackend, null);
        assert.equal(resolved.source, 'env_lock');
    } finally {
        if (prev === undefined) delete process.env.PICKLE_REFINEMENT_LOCK;
        else process.env.PICKLE_REFINEMENT_LOCK = prev;
    }
});

test('resolveWorkerBackendFromStateFile: reads worker_backend from JSON', () => {
    const dir = mkTmpDir('backend-spawn-worker-');
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, JSON.stringify({ backend: 'claude', worker_backend: 'codex', active: true }));
    const resolved = resolveWorkerBackendFromStateFile(file);
    assert.equal(resolved.backend, 'codex');
    assert.equal(resolved.managerBackend, 'claude');
    assert.equal(resolved.workerBackend, 'codex');
    assert.equal(resolved.source, 'worker_backend');
});

// --- buildWorkerInvocation: claude ---

test('buildWorkerInvocation(claude): includes --dangerously-skip-permissions and -p', () => {
    const dir = mkTmpDir('bs-');
    const inv = buildWorkerInvocation('claude', {
        prompt: 'hello world',
        addDirs: [dir],
        model: 'sonnet',
        outputFormat: 'text',
    });
    assert.equal(inv.cmd, 'claude');
    assert.equal(inv.backend, 'claude');
    assert.ok(inv.args.includes('--dangerously-skip-permissions'));
    assert.ok(inv.args.includes('--add-dir'));
    assert.ok(inv.args.includes(dir));
    assert.ok(inv.args.includes('--model'));
    assert.ok(inv.args.includes('sonnet'));
    assert.ok(inv.args.includes('-p'));
    assert.equal(inv.args[inv.args.length - 1], 'hello world');
});

test('buildWorkerInvocation(claude): includes --output-format when non-text', () => {
    const dir = mkTmpDir('bs-');
    const inv = buildWorkerInvocation('claude', {
        prompt: 'x',
        addDirs: [dir],
        outputFormat: 'stream-json',
    });
    const fmtIdx = inv.args.indexOf('--output-format');
    assert.ok(fmtIdx >= 0);
    assert.equal(inv.args[fmtIdx + 1], 'stream-json');
});

test('buildWorkerInvocation(claude): omits --output-format when text (the default)', () => {
    // Guard against a regression that always emits `--output-format text` — an
    // invalid value for the Claude CLI that would fail every worker spawn.
    const inv = buildWorkerInvocation('claude', {
        prompt: 'x',
        addDirs: [],
        outputFormat: 'text',
    });
    assert.equal(inv.args.includes('--output-format'), false);
});

test('buildWorkerInvocation(claude): disables commit attribution through an additive --settings payload', () => {
    const inv = buildWorkerInvocation('claude', { prompt: 'x', addDirs: [] });
    const idx = inv.args.indexOf('--settings');
    assert.ok(idx >= 0, '--settings must be present');
    const settings = JSON.parse(inv.args[idx + 1]);
    assert.deepEqual(settings, { attribution: { commit: '', pr: '', sessionUrl: false } });
    // Control: --settings is a value-carrying flag, so it must not displace the prompt or bypass flag.
    assert.ok(inv.args.includes('--dangerously-skip-permissions'));
    assert.equal(inv.args[inv.args.length - 2], '-p');
    assert.equal(inv.args[inv.args.length - 1], 'x');
});

test('buildWorkerInvocation(codex): carries no claude --settings payload', () => {
    const inv = buildWorkerInvocation('codex', { prompt: 'x', addDirs: [] });
    assert.equal(inv.args.includes('--settings'), false);
});

test('buildWorkerInvocation(claude): drops missing add-dir entries', () => {
    const inv = buildWorkerInvocation('claude', {
        prompt: 'x',
        addDirs: ['/definitely/does/not/exist/abc123'],
    });
    assert.equal(inv.args.includes('--add-dir'), false);
});

// --- buildWorkerInvocation: codex ---

test('buildWorkerInvocation(codex): uses exec with bypass + ephemeral + skip-git', () => {
    const dir = mkTmpDir('bs-');
    const inv = buildWorkerInvocation('codex', {
        prompt: 'hello world',
        addDirs: [dir],
    });
    assert.equal(inv.cmd, 'codex');
    assert.equal(inv.backend, 'codex');
    assert.equal(inv.args[0], 'exec');
    assert.ok(inv.args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(inv.args.includes('--skip-git-repo-check'));
    assert.ok(inv.args.includes('--ephemeral'));
    assert.ok(inv.args.includes('--add-dir'));
    assert.ok(inv.args.includes(dir));
    // Prompt is the final positional after --
    assert.equal(inv.args[inv.args.length - 1], 'hello world');
    assert.equal(inv.args[inv.args.length - 2], '--');
});

test('buildWorkerInvocation(codex): passes model via -m', () => {
    const inv = buildWorkerInvocation('codex', {
        prompt: 'x',
        addDirs: [],
        model: 'gpt-5.4',
    });
    const mIdx = inv.args.indexOf('-m');
    assert.ok(mIdx >= 0);
    assert.equal(inv.args[mIdx + 1], 'gpt-5.4');
});

test('buildWorkerInvocation(codex): omits -m when no model given', () => {
    // Guards the trap-door: a future default to a tier-shaped name ('sonnet') would silently break every codex worker spawn.
    const inv = buildWorkerInvocation('codex', {
        prompt: 'x',
        addDirs: [],
    });
    assert.equal(inv.args.includes('-m'), false);
});

test('buildWorkerInvocation(codex): -m gpt-5.3-codex-spark appears as adjacent ordered args', () => {
    // Codex CLI 0.128.0 accepts `-m gpt-5.3-codex-spark`. The fix plumbs the
    // resolved model from settings (default_codex_model) through to the
    // invocation; this test guards the args ordering — `-m` immediately
    // followed by the model value — so a regression that interleaves another
    // flag between them is caught.
    const inv = buildWorkerInvocation('codex', {
        prompt: 'x',
        addDirs: [],
        model: 'gpt-5.3-codex-spark',
    });
    const mIdx = inv.args.indexOf('-m');
    assert.ok(mIdx >= 0, 'expected -m flag in codex invocation');
    assert.equal(inv.args[mIdx + 1], 'gpt-5.3-codex-spark');
    // -m must precede the `--` prompt separator
    const dashDashIdx = inv.args.indexOf('--');
    assert.ok(dashDashIdx > mIdx + 1, 'expected -m <model> to precede `--` separator');
});

test('buildWorkerInvocation(codex): drops missing add-dir entries (mirrors claude-worker)', () => {
    // Both backends filter non-existent add-dir paths via existsSilently; the
    // claude test already covers this. Mirror it for codex so a regression that
    // removes the filter on one path but not the other is caught.
    const validDir = mkTmpDir('bs-codex-');
    const inv = buildWorkerInvocation('codex', {
        prompt: 'x',
        addDirs: [validDir, '/definitely/does/not/exist/xyz456', ''],
    });
    const addDirCount = inv.args.filter((a) => a === '--add-dir').length;
    assert.equal(addDirCount, 1);
    assert.ok(inv.args.includes(validDir));
    assert.equal(inv.args.includes('/definitely/does/not/exist/xyz456'), false);
});

// --- buildWorkerInvocation: hermes ---

test('backend-spawn.hermes-worker: uses hermes chat query mode with quiet isolated flags', () => {
    const inv = buildWorkerInvocation('hermes', {
        prompt: 'hello hermes',
        addDirs: [],
    });
    assert.equal(inv.cmd, 'hermes');
    assert.equal(inv.backend, 'hermes');
    assert.deepEqual(inv.args.slice(0, 4), ['chat', '-q', 'hello hermes', '-Q']);
    assert.ok(inv.args.includes('--ignore-rules'));
    assert.ok(inv.args.includes('--ignore-user-config'));
});

test('backend-spawn.hermes-worker: passes toolsets provider max-turns and model', () => {
    const inv = buildWorkerInvocation('hermes', {
        prompt: 'x',
        addDirs: [],
        toolsets: ['terminal', ' file ', 'code_execution'],
        provider: 'anthropic',
        maxTurns: 7,
        model: 'anthropic/claude-sonnet-4',
    });
    const maxTurnsIdx = inv.args.indexOf('--max-turns');
    const toolsetsIdx = inv.args.indexOf('--toolsets');
    const providerIdx = inv.args.indexOf('--provider');
    const modelIdx = inv.args.indexOf('-m');
    assert.ok(maxTurnsIdx >= 0);
    assert.equal(inv.args[maxTurnsIdx + 1], '7');
    assert.ok(toolsetsIdx >= 0);
    assert.equal(inv.args[toolsetsIdx + 1], 'terminal,file,code_execution');
    assert.ok(providerIdx >= 0);
    assert.equal(inv.args[providerIdx + 1], 'anthropic');
    assert.ok(modelIdx >= 0);
    assert.equal(inv.args[modelIdx + 1], 'anthropic/claude-sonnet-4');
});

// --- buildManagerInvocation ---

test('buildManagerInvocation(claude): includes stream-json + max-turns + no-session-persistence', () => {
    const dir = mkTmpDir('bs-');
    const inv = buildManagerInvocation('claude', {
        prompt: 'manage',
        addDirs: [dir, '/nonexistent/xyz'],
        maxTurns: 42,
        streamJson: true,
        noSessionPersistence: true,
    });
    assert.equal(inv.cmd, 'claude');
    assert.ok(inv.args.includes('--no-session-persistence'));
    assert.ok(inv.args.includes('--output-format'));
    assert.ok(inv.args.includes('stream-json'));
    assert.ok(inv.args.includes('--verbose'));
    const maxTurnsIdx = inv.args.indexOf('--max-turns');
    assert.ok(maxTurnsIdx >= 0);
    assert.equal(inv.args[maxTurnsIdx + 1], '42');
    // Manager builder passes addDirs through verbatim (no fs.existsSync filter)
    // because mux-runner always passes real session-owned directories.
    const addDirCount = inv.args.filter(a => a === '--add-dir').length;
    assert.equal(addDirCount, 2);
});

test('buildManagerInvocation(codex): same shape as worker invocation', () => {
    const dir = mkTmpDir('bs-');
    const inv = buildManagerInvocation('codex', {
        prompt: 'manage',
        addDirs: [dir],
        maxTurns: 10,
        streamJson: true,
        noSessionPersistence: true,
    });
    assert.equal(inv.cmd, 'codex');
    assert.equal(inv.args[0], 'exec');
    // max-turns, stream-json, no-session-persistence have no codex equivalent — dropped
    assert.equal(inv.args.includes('--max-turns'), false);
    assert.equal(inv.args.includes('--output-format'), false);
    assert.equal(inv.args.includes('--no-session-persistence'), false);
    assert.equal(inv.args[inv.args.length - 1], 'manage');
});

test('buildManagerInvocation(codex): omits -m when no model given', () => {
    // Guards the trap-door: a future default to a tier-shaped name ('sonnet') would silently break every codex manager spawn.
    const inv = buildManagerInvocation('codex', {
        prompt: 'manage',
        addDirs: [],
        maxTurns: 10,
        streamJson: true,
        noSessionPersistence: true,
    });
    assert.equal(inv.args.includes('-m'), false);
});

test('manager-spawn.hermes: buildManagerInvocation uses hermes chat with manager prompt and options', () => {
    const dir = mkTmpDir('bs-');
    const inv = buildManagerInvocation('hermes', {
        prompt: 'manage hermes',
        addDirs: [dir],
        maxTurns: 11,
        streamJson: true,
        noSessionPersistence: true,
        toolsets: ['terminal', 'file'],
        provider: 'anthropic',
        model: 'anthropic/claude-sonnet-4',
    });
    assert.equal(inv.cmd, 'hermes');
    assert.equal(inv.backend, 'hermes');
    assert.deepEqual(inv.args.slice(0, 4), ['chat', '-q', 'manage hermes', '-Q']);
    assert.equal(inv.args.includes('--output-format'), false);
    assert.equal(inv.args.includes('--no-session-persistence'), false);
    assert.equal(inv.args[inv.args.indexOf('--max-turns') + 1], '11');
    assert.equal(inv.args[inv.args.indexOf('--toolsets') + 1], 'terminal,file');
    assert.equal(inv.args[inv.args.indexOf('--provider') + 1], 'anthropic');
    assert.equal(inv.args[inv.args.indexOf('-m') + 1], 'anthropic/claude-sonnet-4');
});

// --- backendEnvOverrides ---

test('backendEnvOverrides: emits PICKLE_BACKEND', () => {
    assert.deepEqual(backendEnvOverrides('codex'), { PICKLE_BACKEND: 'codex' });
    assert.deepEqual(backendEnvOverrides('claude'), { PICKLE_BACKEND: 'claude' });
    assert.deepEqual(backendEnvOverrides('hermes'), { PICKLE_BACKEND: 'hermes' });
});

// --- buildWorkerInvocation: --effort threading ---

test('buildWorkerInvocation(codex): emits -c reasoning.effort=high before -- when effort is set', () => {
    const inv = buildWorkerInvocation('codex', {
        prompt: 'do the thing',
        addDirs: [],
        effort: 'high',
    });
    const dashCIdx = inv.args.indexOf('-c');
    assert.ok(dashCIdx >= 0, 'codex invocation should include -c when effort is set');
    assert.equal(inv.args[dashCIdx + 1], 'reasoning.effort=high');
    // Must come BEFORE the `--` prompt separator or codex parses it as prompt
    const sepIdx = inv.args.indexOf('--');
    assert.ok(sepIdx >= 0 && dashCIdx < sepIdx, '-c must precede --');
    // Prompt is still the final positional after --
    assert.equal(inv.args[inv.args.length - 1], 'do the thing');
});

test('buildWorkerInvocation(codex): emits NO effort flag when effort is unset', () => {
    const inv = buildWorkerInvocation('codex', {
        prompt: 'do the thing',
        addDirs: [],
    });
    assert.equal(inv.args.includes('-c'), false, 'codex invocation should NOT include -c when effort is unset');
    assert.ok(!inv.args.some(a => typeof a === 'string' && a.startsWith('reasoning.effort=')));
});

test('buildWorkerInvocation(codex): all four effort levels round-trip', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh']) {
        const inv = buildWorkerInvocation('codex', {
            prompt: 'x',
            addDirs: [],
            effort: level,
        });
        const dashCIdx = inv.args.indexOf('-c');
        assert.ok(dashCIdx >= 0);
        assert.equal(inv.args[dashCIdx + 1], `reasoning.effort=${level}`);
    }
});

test('buildWorkerInvocation(claude): does NOT emit any effort/reasoning flag whether effort is set or unset', () => {
    // Claude CLI has no public reasoning-effort flag for `claude -p` — must be a no-op.
    const invSet = buildWorkerInvocation('claude', {
        prompt: 'x',
        addDirs: [],
        effort: 'high',
    });
    assert.equal(invSet.args.includes('-c'), false);
    assert.equal(invSet.args.includes('--reasoning-effort'), false);
    assert.equal(invSet.args.includes('reasoning.effort'), false);
    assert.ok(!invSet.args.some(a => typeof a === 'string' && a.startsWith('reasoning.effort=')));
    // No --append-system-prompt sneak-in either
    assert.equal(invSet.args.includes('--append-system-prompt'), false);

    const invUnset = buildWorkerInvocation('claude', {
        prompt: 'x',
        addDirs: [],
    });
    assert.equal(invUnset.args.includes('-c'), false);
    assert.equal(invUnset.args.includes('--reasoning-effort'), false);
    assert.equal(invUnset.args.includes('--append-system-prompt'), false);
});

// --- deepseek backend ---

function withDeepseekKey(key, fn) {
    const prev = process.env.DEEPSEEK_API_KEY;
    if (key === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = key;
    try {
        return fn();
    } finally {
        if (prev === undefined) delete process.env.DEEPSEEK_API_KEY;
        else process.env.DEEPSEEK_API_KEY = prev;
    }
}

test('deepseek backend: isBackend returns true', () => {
    assert.equal(isBackend('deepseek'), true);
});

test('deepseek backend: resolveBackend returns deepseek from state', () => {
    withUnsetBackendEnv(() => {
        assert.equal(resolveBackend({ backend: 'deepseek' }), 'deepseek');
    });
});

test('deepseek backend: resolveBackend returns deepseek from PICKLE_BACKEND env', () => {
    const prev = process.env.PICKLE_BACKEND;
    process.env.PICKLE_BACKEND = 'deepseek';
    try {
        assert.equal(resolveBackend({}), 'deepseek');
    } finally {
        if (prev === undefined) delete process.env.PICKLE_BACKEND;
        else process.env.PICKLE_BACKEND = prev;
    }
});

test('deepseek backend: buildWorkerInvocation returns claude cmd with deepseek backend and env overlay', () => {
    const dir = mkTmpDir('bs-ds-');
    withDeepseekKey('test-ds-key-1234', () => {
        const inv = buildWorkerInvocation('deepseek', {
            prompt: 'hello deepseek',
            addDirs: [dir],
        });
        assert.equal(inv.cmd, 'claude');
        assert.equal(inv.backend, 'deepseek');
        assert.ok(inv.args.includes('--dangerously-skip-permissions'));
        assert.ok(inv.args.includes('-p'));
        assert.equal(inv.args[inv.args.length - 1], 'hello deepseek');
        assert.ok(inv.env != null, 'env overlay must be present');
        assert.equal(inv.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
        assert.equal(inv.env.ANTHROPIC_AUTH_TOKEN, 'test-ds-key-1234');
        assert.ok(typeof inv.env.ANTHROPIC_MODEL === 'string' && inv.env.ANTHROPIC_MODEL.length > 0);
    });
});

test('deepseek backend: buildWorkerInvocation uses ANTHROPIC_MODEL env when set', () => {
    const prevModel = process.env.ANTHROPIC_MODEL;
    process.env.ANTHROPIC_MODEL = 'deepseek-r2';
    withDeepseekKey('test-key', () => {
        const inv = buildWorkerInvocation('deepseek', { prompt: 'x', addDirs: [] });
        assert.equal(inv.env.ANTHROPIC_MODEL, 'deepseek-r2');
    });
    if (prevModel === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = prevModel;
});

test('deepseek backend: buildWorkerInvocation defaults ANTHROPIC_MODEL to deepseek-v4-pro', () => {
    const prevModel = process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_MODEL;
    withDeepseekKey('test-key', () => {
        const inv = buildWorkerInvocation('deepseek', { prompt: 'x', addDirs: [] });
        assert.equal(inv.env.ANTHROPIC_MODEL, 'deepseek-v4-pro');
    });
    if (prevModel === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = prevModel;
});

test('deepseek backend: buildWorkerInvocation throws when DEEPSEEK_API_KEY unset', () => {
    withDeepseekKey(undefined, () => {
        assert.throws(
            () => buildWorkerInvocation('deepseek', { prompt: 'x', addDirs: [] }),
            /DEEPSEEK_API_KEY/,
        );
    });
});

test('deepseek backend: buildManagerInvocation returns claude cmd with deepseek backend and env overlay', () => {
    withDeepseekKey('mgr-key', () => {
        const inv = buildManagerInvocation('deepseek', {
            prompt: 'manage deepseek',
            addDirs: [],
        });
        assert.equal(inv.cmd, 'claude');
        assert.equal(inv.backend, 'deepseek');
        assert.ok(inv.env != null);
        assert.equal(inv.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
        assert.equal(inv.env.ANTHROPIC_AUTH_TOKEN, 'mgr-key');
    });
});

test('deepseek backend: buildJudgeInvocation retains read-only sandbox and carries env overlay', () => {
    withDeepseekKey('judge-key', () => {
        const inv = buildJudgeInvocation('deepseek', {
            prompt: 'judge this',
            addDirs: [],
        });
        assert.equal(inv.cmd, 'claude');
        assert.equal(inv.backend, 'deepseek');
        // Read-only sandbox contract must be preserved
        assert.ok(inv.args.includes('--allowedTools'), 'judge must have --allowedTools');
        const toolsIdx = inv.args.indexOf('--allowedTools');
        assert.equal(inv.args[toolsIdx + 1], 'Read,Glob,Grep');
        assert.ok(inv.args.includes('--no-session-persistence'), 'judge must have --no-session-persistence');
        // Env overlay must be present
        assert.ok(inv.env != null);
        assert.equal(inv.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
        assert.equal(inv.env.ANTHROPIC_AUTH_TOKEN, 'judge-key');
    });
});

test('NFR: claude worker invocation has no env field (zero pollution)', () => {
    const inv = buildWorkerInvocation('claude', { prompt: 'x', addDirs: [] });
    assert.equal(inv.env, undefined, 'claude invocation must not carry env overlay');
});

test('NFR: codex worker invocation has no env field (zero pollution)', () => {
    const inv = buildWorkerInvocation('codex', { prompt: 'x', addDirs: [] });
    assert.equal(inv.env, undefined, 'codex invocation must not carry env overlay');
});

// --- AC-MFW-3: --ignore-user-config retention + Option-D-fallback stub ---

test('AC-MFW-3: buildWorkerInvocation(codex) retains --ignore-user-config', () => {
    // R-MFW-3 invariant: Option C (removing --ignore-user-config) is rejected.
    // This guard ensures a future refactor cannot silently drop the flag.
    const inv = buildWorkerInvocation('codex', { prompt: 'x', addDirs: [] });
    assert.ok(
        inv.args.includes('--ignore-user-config'),
        'codex worker invocation must include --ignore-user-config (FM-4 guard)',
    );
});

test('AC-MFW-3: buildManagerInvocation(codex) retains --ignore-user-config', () => {
    // Codex manager path goes through buildCodexInvocation — same invariant.
    const inv = buildManagerInvocation('codex', { prompt: 'x', addDirs: [] });
    assert.ok(
        inv.args.includes('--ignore-user-config'),
        'codex manager invocation must include --ignore-user-config (FM-4 guard)',
    );
});

test('AC-MFW-3: buildWorkerInvocation(codex) Option-D stub — no per-invocation MCP flag', () => {
    // R-MFW-3 Option-D fallback: codex has no --mcp-config equivalent and
    // per-invocation -c mcp.servers.*=… injection is infeasible with
    // --ignore-user-config active. MCP forwarding for codex is deferred to
    // R-MFW-4 (setup-time snapshot). This test guards that no partial/broken
    // MCP injection was introduced here.
    const inv = buildWorkerInvocation('codex', { prompt: 'x', addDirs: [] });
    assert.equal(
        inv.args.includes('--mcp-config'),
        false,
        'codex invocation must NOT include --mcp-config (no codex equivalent; Option D via R-MFW-4)',
    );
    assert.ok(
        !inv.args.some(a => typeof a === 'string' && a.startsWith('mcp.servers')),
        'codex invocation must NOT include mcp.servers -c override (Option B infeasible)',
    );
});

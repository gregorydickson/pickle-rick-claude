// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// PRD refinement is a Claude-only phase. Even if the parent session opted into
// codex (state.backend === 'codex') or the environment says PICKLE_BACKEND=codex,
// spawn-refinement-team MUST downgrade to claude with a stderr warning. These
// tests lock that invariant against regression.
const {
    buildRefinementWorkerInvocation,
    buildRefinementEnv,
    warnIfCodexRequested,
    __resetRefinementBackendWarning,
    resolveRuntime,
} = await import('../bin/spawn-refinement-team.js');

function mkTmp(prefix = 'spawn-refine-claude-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

test('buildRefinementWorkerInvocation: cmd is "claude" regardless of env/state', () => {
    const prevEnv = process.env.PICKLE_BACKEND;
    process.env.PICKLE_BACKEND = 'codex';
    try {
        const inv = buildRefinementWorkerInvocation({
            prompt: 'analyze the PRD',
            addDirs: [os.tmpdir()],
            maxTurns: 42,
        });
        assert.strictEqual(inv.cmd, 'claude', `expected cmd=claude, got ${inv.cmd}`);
        assert.strictEqual(inv.backend, 'claude', `expected backend=claude, got ${inv.backend}`);
        assert.ok(inv.args.includes('--max-turns'), 'args should include --max-turns');
        const mtIdx = inv.args.indexOf('--max-turns');
        assert.strictEqual(inv.args[mtIdx + 1], '42', '--max-turns value should be preserved');
        // -p <prompt> must be the last pair (claude CLI contract) — --max-turns
        // is spliced BEFORE the -p trailer, not after.
        const pIdx = inv.args.lastIndexOf('-p');
        assert.ok(pIdx > mtIdx, '-p must come after --max-turns');
        assert.strictEqual(inv.args[pIdx + 1], 'analyze the PRD');
    } finally {
        if (prevEnv === undefined) delete process.env.PICKLE_BACKEND;
        else process.env.PICKLE_BACKEND = prevEnv;
    }
});

test('buildRefinementWorkerInvocation: never produces codex CLI shape', () => {
    const inv = buildRefinementWorkerInvocation({
        prompt: 'analyze',
        addDirs: [],
        maxTurns: 0,
    });
    assert.notStrictEqual(inv.cmd, 'codex');
    // codex invocations start with the `exec` subcommand — must NOT appear
    assert.ok(!inv.args.includes('exec'), 'refinement invocation must not look like codex');
    assert.ok(!inv.args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('buildRefinementEnv: PICKLE_BACKEND forced to "claude" even when base env says codex', () => {
    const env = buildRefinementEnv({
        PICKLE_BACKEND: 'codex',
        CLAUDECODE: '1',
        PATH: '/usr/bin',
    });
    assert.strictEqual(env.PICKLE_BACKEND, 'claude');
    assert.strictEqual(env.PICKLE_REFINEMENT_LOCK, '1',
        'PICKLE_REFINEMENT_LOCK sentinel must be set so grandchildren short-circuit resolveBackend to claude');
    assert.strictEqual(env.PICKLE_ROLE, 'refinement-worker');
    assert.strictEqual(env.PYTHONUNBUFFERED, '1');
    assert.strictEqual(env.CLAUDECODE, undefined, 'CLAUDECODE must be stripped to prevent loops');
    assert.strictEqual(env.PATH, '/usr/bin', 'other env vars must pass through');
});

test('warnIfCodexRequested: emits one-shot stderr warning when state.backend is codex', () => {
    __resetRefinementBackendWarning();
    const captured = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
        captured.push(typeof chunk === 'string' ? chunk : String(chunk));
        return true;
    };
    try {
        warnIfCodexRequested('codex', undefined);
        // Second call must NOT re-emit (one-shot)
        warnIfCodexRequested('codex', 'codex');
    } finally {
        process.stderr.write = origWrite;
    }
    const warnings = captured.filter((line) => line.includes('PRD refinement forces backend=claude'));
    assert.strictEqual(warnings.length, 1, `expected exactly one warning, got ${warnings.length}: ${JSON.stringify(captured)}`);
    assert.ok(warnings[0].includes('Refinement is planning, not implementation'));
    assert.ok(warnings[0].includes('[pickle-rick]'));
});

test('warnIfCodexRequested: emits warning when env says codex even if state is absent', () => {
    __resetRefinementBackendWarning();
    const captured = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
        captured.push(typeof chunk === 'string' ? chunk : String(chunk));
        return true;
    };
    try {
        warnIfCodexRequested(undefined, 'codex');
    } finally {
        process.stderr.write = origWrite;
    }
    const warnings = captured.filter((line) => line.includes('PRD refinement forces backend=claude'));
    assert.strictEqual(warnings.length, 1);
});

test('warnIfCodexRequested: stays silent when neither state nor env asks for codex', () => {
    __resetRefinementBackendWarning();
    const captured = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
        captured.push(typeof chunk === 'string' ? chunk : String(chunk));
        return true;
    };
    try {
        warnIfCodexRequested('claude', undefined);
        warnIfCodexRequested(undefined, undefined);
        warnIfCodexRequested('claude', 'claude');
    } finally {
        process.stderr.write = origWrite;
    }
    const warnings = captured.filter((line) => line.includes('PRD refinement forces backend=claude'));
    assert.strictEqual(warnings.length, 0, `no warning expected, got: ${JSON.stringify(captured)}`);
});

test('invariant: PICKLE_REFINEMENT_LOCK=1 forces claude even when state.backend is deepseek', () => {
    const sessionDir = mkTmp();
    try {
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({ backend: 'deepseek', active: true }),
        );
        const prevEnv = process.env.PICKLE_BACKEND;
        const prevLock = process.env.PICKLE_REFINEMENT_LOCK;
        process.env.PICKLE_BACKEND = 'deepseek';
        process.env.PICKLE_REFINEMENT_LOCK = '1';
        try {
            const inv = buildRefinementWorkerInvocation({
                prompt: 'refine with deepseek lock',
                addDirs: [sessionDir],
                maxTurns: 5,
            });
            assert.strictEqual(inv.cmd, 'claude');
            assert.strictEqual(inv.backend, 'claude');
            const env = buildRefinementEnv({ ...process.env });
            assert.strictEqual(env.PICKLE_BACKEND, 'claude');
            assert.strictEqual(env.PICKLE_REFINEMENT_LOCK, '1');
        } finally {
            if (prevEnv === undefined) delete process.env.PICKLE_BACKEND;
            else process.env.PICKLE_BACKEND = prevEnv;
            if (prevLock === undefined) delete process.env.PICKLE_REFINEMENT_LOCK;
            else process.env.PICKLE_REFINEMENT_LOCK = prevLock;
        }
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

// Regression guard — the load-bearing assertion the feature exists to protect.
// If PICKLE_BACKEND=codex AND state.backend=codex, the refinement spawn
// invocation MUST still be claude. Anything else means codex has leaked into
// the planning phase.
test('invariant: PICKLE_BACKEND=codex + state.backend=codex still yields cmd=claude', () => {
    const sessionDir = mkTmp();
    try {
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({ backend: 'codex', active: true }),
        );
        const prevEnv = process.env.PICKLE_BACKEND;
        process.env.PICKLE_BACKEND = 'codex';
        try {
            const inv = buildRefinementWorkerInvocation({
                prompt: 'refine',
                addDirs: [sessionDir],
                maxTurns: 10,
            });
            // THE assertion: hardcoded claude, never codex, regardless of signals.
            assert.strictEqual(inv.cmd, 'claude');
            assert.strictEqual(inv.backend, 'claude');

            const env = buildRefinementEnv({ ...process.env });
            assert.strictEqual(env.PICKLE_BACKEND, 'claude', 'grandchild env must stay claude');
            assert.strictEqual(env.PICKLE_REFINEMENT_LOCK, '1',
                'sentinel lock must propagate so grandchild resolveBackend ignores state.json');
        } finally {
            if (prevEnv === undefined) delete process.env.PICKLE_BACKEND;
            else process.env.PICKLE_BACKEND = prevEnv;
        }
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

// B-REFMODEL: resolve default_refinement_model and --model, thread to every analyst spawn.

test('buildRefinementWorkerInvocation: model reaches the argv before -p', () => {
    const inv = buildRefinementWorkerInvocation({
        prompt: 'analyze the PRD',
        addDirs: [],
        maxTurns: 1,
        model: 'm-x',
    });
    assert.ok(inv.args.includes('--model'), 'args should include --model');
    const modelIdx = inv.args.indexOf('--model');
    assert.strictEqual(inv.args[modelIdx + 1], 'm-x');
    const pIdx = inv.args.lastIndexOf('-p');
    assert.ok(pIdx > modelIdx, '-p must come after --model');
});

test('buildRefinementWorkerInvocation: absent model is a no-op (CONTROL)', () => {
    const withoutKey = buildRefinementWorkerInvocation({
        prompt: 'analyze the PRD',
        addDirs: [],
        maxTurns: 1,
    });
    assert.ok(!withoutKey.args.includes('--model'), 'no --model element when model is omitted');

    const withUndefined = buildRefinementWorkerInvocation({
        prompt: 'analyze the PRD',
        addDirs: [],
        maxTurns: 1,
        model: undefined,
    });
    assert.deepStrictEqual(withUndefined.args, withoutKey.args,
        'an explicit undefined model must produce byte-identical args to an omitted key');
});

test('resolveRuntime: --model flag beats default_refinement_model setting', () => {
    const args = {
        prdPath: '/tmp/does-not-matter.md',
        sessionDir: fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-refine-claude-runtime-')),
        model: 'a',
    };
    try {
        const settings = { defaultCycles: 3, defaultMaxTurns: 100, defaultWorkerTimeout: 3600, defaultModel: 'b' };
        const runtime = resolveRuntime(args, settings);
        assert.strictEqual(runtime.model, 'a');
    } finally {
        fs.rmSync(args.sessionDir, { recursive: true, force: true });
    }
});

test('resolveRuntime: falls back to default_refinement_model when --model absent', () => {
    const args = {
        prdPath: '/tmp/does-not-matter.md',
        sessionDir: fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-refine-claude-runtime-')),
    };
    try {
        const settings = { defaultCycles: 3, defaultMaxTurns: 100, defaultWorkerTimeout: 3600, defaultModel: 'b' };
        const runtime = resolveRuntime(args, settings);
        assert.strictEqual(runtime.model, 'b');
    } finally {
        fs.rmSync(args.sessionDir, { recursive: true, force: true });
    }
});

test('resolveRuntime: model is undefined when neither flag nor setting is present', () => {
    const args = {
        prdPath: '/tmp/does-not-matter.md',
        sessionDir: fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-refine-claude-runtime-')),
    };
    try {
        const settings = { defaultCycles: 3, defaultMaxTurns: 100, defaultWorkerTimeout: 3600 };
        const runtime = resolveRuntime(args, settings);
        assert.strictEqual(runtime.model, undefined);
    } finally {
        fs.rmSync(args.sessionDir, { recursive: true, force: true });
    }
});

test('buildRefinementWorkerInvocation: every analyst role prompt carries the same resolved model', () => {
    const roles = ['requirements', 'codebase', 'risk-scope'];
    const invocations = roles.map((role) => buildRefinementWorkerInvocation({
        prompt: `analyze as ${role}`,
        addDirs: [],
        maxTurns: 1,
        model: 'm-shared',
    }));
    for (const inv of invocations) {
        const modelIdx = inv.args.indexOf('--model');
        assert.ok(modelIdx !== -1, 'every role invocation must carry --model');
        assert.strictEqual(inv.args[modelIdx + 1], 'm-shared');
    }
});

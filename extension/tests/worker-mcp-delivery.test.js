// @tier: fast
//
// c7a7f729 — worker codegraph MCP delivery is ASSERTED, and its degradation is LOUD.
//
// Two halves, matching the ticket:
//
// (a) AC-2 delivery. The settings value being `true` is NOT evidence that a worker
//     received the codegraph MCP server. The evidence is the SPAWNED ARGV and the
//     FILE. These tests drive the real chain end to end —
//       buildWorkerMcpConfig (writes <sessionDir>/mcp/worker-mcp.json)
//         -> resolveSessionWorkerMcpConfig (what spawn-morty actually calls)
//           -> buildWorkerInvocation      (the argv the worker is spawned with)
//     — and assert on the argv and the file's parsed contents, never on settings.
//
// (b) AC-4 degradation. When the codegraph bin is unresolvable or the merge write
//     fails, the run must still proceed on operator passthrough (PRIME DIRECTIVE:
//     a gate that stops the pipeline takes reliability AND quality to zero) but must
//     now emit a `codegraph_degraded` activity event naming the reason. The previous
//     bare stderr line did not satisfy this: nothing downstream could tell "codegraph
//     MCP delivered" from "codegraph MCP silently absent", so the feature read as ON
//     while being OFF.
//
// On a release/tarball install the codegraph bin does NOT resolve — it resolves on a
// dev box only because ~/.claude/pickle-rick/extension/node_modules/@colbymchenry/
// codegraph is a symlink into the source repo. So the degraded branch is the DEFAULT
// path for real users. That is why the forced-degrade tests below use an injected
// seam rather than t.skip: a test that skips on the machines the ticket is about
// would reproduce the very defect class being fixed (a non-run read as a pass).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { buildWorkerMcpConfig, buildWorkerInvocation } from '../services/backend-spawn.js';
import { resolveSessionWorkerMcpConfig } from '../bin/spawn-morty.js';
import { mkTmpDir, rmDir, withEmptyHome } from './__helpers__/empty-home.js';

const require = createRequire(import.meta.url);

/** Resolve the real absolute codegraph bin the same way the implementation does. */
function resolveRealCodegraphBinOrNull() {
    try {
        const pkgJsonPath = require.resolve('@colbymchenry/codegraph/package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
        const binRel = (pkg.bin && pkg.bin.codegraph) || 'npm-shim.js';
        return path.join(path.dirname(pkgJsonPath), binRel);
    } catch {
        return null;
    }
}

const sessionMcpPath = (sessionDir) => path.join(sessionDir, 'mcp', 'worker-mcp.json');

/** A deterministic stand-in for the real serve entry, same shape, same trailing args. */
function fixtureServeEntry(workingDir) {
    return {
        command: 'node',
        args: ['/fixture/abs/codegraph-bin.js', 'serve', '--mcp'],
        env: { CODEGRAPH_NO_WATCH: '1' },
        cwd: workingDir,
    };
}

/**
 * Run `fn` with PICKLE_DATA_ROOT pointed at a scratch dir so activity events land
 * somewhere readable and never pollute the operator's real activity log.
 */
function withTmpActivityRoot(fn) {
    const prevRoot = process.env.PICKLE_DATA_ROOT;
    const prevDir = process.env.PICKLE_DATA_DIR;
    const root = mkTmpDir('wmd-activity-');
    process.env.PICKLE_DATA_ROOT = root;
    delete process.env.PICKLE_DATA_DIR;
    try {
        return fn(root);
    } finally {
        if (prevRoot === undefined) { delete process.env.PICKLE_DATA_ROOT; }
        else process.env.PICKLE_DATA_ROOT = prevRoot;
        if (prevDir !== undefined) { process.env.PICKLE_DATA_DIR = prevDir; }
        rmDir(root);
    }
}

function readEvents(activityRoot, eventName) {
    const dir = path.join(activityRoot, 'activity');
    if (!fs.existsSync(dir)) { return []; }
    const out = [];
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.jsonl')) { continue; }
        for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
            if (!line.trim()) { continue; }
            let ev;
            try { ev = JSON.parse(line); } catch { continue; }
            if (ev.event === eventName) { out.push(ev); }
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// AC-2 — delivery asserted on the SPAWNED ARGV and the FILE
// ---------------------------------------------------------------------------

test('AC-2: real chain delivers --mcp-config <sessionDir>/mcp/worker-mcp.json to the claude worker argv', (t) => {
    const binAbs = resolveRealCodegraphBinOrNull();
    if (!binAbs) {
        return t.skip('@colbymchenry/codegraph bin not resolvable here — AC-4 makes this case visible; see the deterministic twin below');
    }
    const sessionDir = mkTmpDir('wmd-real-');
    const workingDir = mkTmpDir('wmd-real-work-');
    try {
        // 1. Materialize, exactly as setup.ts does.
        const written = buildWorkerMcpConfig(sessionDir, workingDir, { expose_mcp_to_workers: true }, null);
        assert.equal(written, sessionMcpPath(sessionDir), 'merge returns the session-merged path');

        // 2. The FILE exists and carries a real codegraph serve entry.
        assert.ok(fs.existsSync(sessionMcpPath(sessionDir)), 'worker-mcp.json exists on disk');
        const cfg = JSON.parse(fs.readFileSync(sessionMcpPath(sessionDir), 'utf8'));
        const cg = cfg.mcpServers.codegraph;
        assert.ok(cg, 'mcpServers contains a codegraph entry');
        assert.deepEqual(cg.args.slice(-2), ['serve', '--mcp'], "codegraph args end in 'serve --mcp'");
        assert.ok(path.isAbsolute(cg.args[0]), 'the bin path is absolute');
        assert.equal(cg.args[0], binAbs, 'the bin matches the really-resolved package bin (non-vacuous)');

        // 3. The consumption site spawn-morty actually calls picks it up.
        const resolved = resolveSessionWorkerMcpConfig({ backend: 'claude' }, sessionDir);
        assert.equal(resolved, sessionMcpPath(sessionDir), 'spawn-morty resolves the session-merged path');

        // 4. The SPAWNED ARGV carries it.
        const inv = buildWorkerInvocation('claude', { prompt: 'x', addDirs: [], mcpConfig: resolved });
        const idx = inv.args.indexOf('--mcp-config');
        assert.ok(idx >= 0, 'claude worker argv contains --mcp-config');
        assert.equal(inv.args[idx + 1], sessionMcpPath(sessionDir), 'argv value is the session-merged path');
    } finally {
        rmDir(sessionDir);
        rmDir(workingDir);
    }
});

test('AC-2: the same chain holds with an injected serve entry (never skips, so the argv+file assertion is never vacuous)', () => {
    const sessionDir = mkTmpDir('wmd-det-');
    const workingDir = mkTmpDir('wmd-det-work-');
    try {
        const written = buildWorkerMcpConfig(
            sessionDir, workingDir, { expose_mcp_to_workers: true }, null,
            { resolveServeEntry: fixtureServeEntry },
        );
        assert.equal(written, sessionMcpPath(sessionDir));

        const cfg = JSON.parse(fs.readFileSync(sessionMcpPath(sessionDir), 'utf8'));
        assert.deepEqual(cfg.mcpServers.codegraph.args.slice(-2), ['serve', '--mcp']);

        const resolved = resolveSessionWorkerMcpConfig({ backend: 'claude' }, sessionDir);
        const inv = buildWorkerInvocation('claude', { prompt: 'x', addDirs: [], mcpConfig: resolved });
        const idx = inv.args.indexOf('--mcp-config');
        assert.ok(idx >= 0, 'claude worker argv contains --mcp-config');
        assert.equal(inv.args[idx + 1], sessionMcpPath(sessionDir), 'argv value is the session-merged path');
    } finally {
        rmDir(sessionDir);
        rmDir(workingDir);
    }
});

test('AC-2: no session file materialized => no --mcp-config in the worker argv (the negative half)', () => {
    const sessionDir = mkTmpDir('wmd-nofile-');
    try {
        assert.equal(fs.existsSync(sessionMcpPath(sessionDir)), false, 'precondition: nothing materialized');
        const resolved = resolveSessionWorkerMcpConfig({ backend: 'claude' }, sessionDir);
        assert.equal(resolved, undefined, 'resolver returns undefined when the file is absent');
        withEmptyHome(() => {
            const inv = buildWorkerInvocation('claude', { prompt: 'x', addDirs: [], mcpConfig: resolved });
            assert.equal(inv.args.includes('--mcp-config'), false, 'no session file => no --mcp-config');
        });
    } finally {
        rmDir(sessionDir);
    }
});

// ---------------------------------------------------------------------------
// AC-4 — the load-bearing defect: degradation must be LOUD, and must NOT abort
// ---------------------------------------------------------------------------

test('AC-4: FORCED unresolvable bin emits codegraph_degraded naming the reason, and still returns operator passthrough', () => {
    withTmpActivityRoot((activityRoot) => {
        const sessionDir = mkTmpDir('wmd-unres-');
        try {
            const result = buildWorkerMcpConfig(
                sessionDir,
                '/tmp/work',
                { worker_mcp_config_path: '/operator/mcp.json', expose_mcp_to_workers: true },
                { linear: { command: 'op' } },
                // FORCE the branch the real resolver only takes on a tarball install.
                { resolveServeEntry: () => null },
            );

            // Passthrough behaviour is UNCHANGED — the run proceeds (PRIME DIRECTIVE).
            assert.equal(result, '/operator/mcp.json', 'degraded merge returns the operator passthrough path');
            assert.equal(
                fs.existsSync(sessionMcpPath(sessionDir)), false,
                'degraded merge writes no session file',
            );

            // ...but the degradation is now VISIBLE in the activity log.
            const events = readEvents(activityRoot, 'codegraph_degraded')
                .filter(e => e.gate_payload && e.gate_payload.operation === 'worker_mcp_merge');
            assert.equal(events.length, 1, 'exactly one worker_mcp_merge degrade event');
            assert.equal(events[0].reason, 'worker_mcp_bin_unresolved', 'the event NAMES the reason');
            assert.equal(events[0].gate_payload.fallback, 'operator_passthrough', 'the event names the fallback');
            assert.equal(
                events[0].gate_payload.passthrough_path, '/operator/mcp.json',
                'the event names the config the worker actually got instead',
            );
            assert.ok(events[0].ts, 'event carries a timestamp');
        } finally {
            rmDir(sessionDir);
        }
    });
});

test('AC-4: FORCED merge write failure emits codegraph_degraded naming the reason, and still returns operator passthrough', () => {
    withTmpActivityRoot((activityRoot) => {
        const sessionDir = mkTmpDir('wmd-wfail-');
        try {
            // Occupy <sessionDir>/mcp with a FILE so mkdirSync throws EEXIST/ENOTDIR.
            fs.writeFileSync(path.join(sessionDir, 'mcp'), 'not a directory');

            const result = buildWorkerMcpConfig(
                sessionDir,
                '/tmp/work',
                { worker_mcp_config_path: '/operator/mcp.json', expose_mcp_to_workers: true },
                null,
                { resolveServeEntry: fixtureServeEntry },
            );

            assert.equal(result, '/operator/mcp.json', 'write failure returns the operator passthrough path');

            const events = readEvents(activityRoot, 'codegraph_degraded')
                .filter(e => e.gate_payload && e.gate_payload.operation === 'worker_mcp_merge');
            assert.equal(events.length, 1, 'exactly one worker_mcp_merge degrade event');
            assert.equal(events[0].reason, 'worker_mcp_merge_write_failed', 'the event NAMES the reason');
            assert.equal(events[0].gate_payload.fallback, 'operator_passthrough');
            assert.ok(events[0].error, 'the underlying write error is carried for diagnosis');
        } finally {
            rmDir(sessionDir);
        }
    });
});

test('AC-4/AC-8: neither degraded branch throws — a degraded merge is never an abort (PRIME DIRECTIVE)', () => {
    withTmpActivityRoot(() => {
        const sessionDir = mkTmpDir('wmd-noabort-');
        try {
            withEmptyHome(() => {
                assert.doesNotThrow(() => {
                    buildWorkerMcpConfig(sessionDir, '/tmp/work', { expose_mcp_to_workers: true }, null,
                        { resolveServeEntry: () => null });
                }, 'unresolvable bin must not throw');

                fs.writeFileSync(path.join(sessionDir, 'mcp'), 'not a directory');
                assert.doesNotThrow(() => {
                    buildWorkerMcpConfig(sessionDir, '/tmp/work', { expose_mcp_to_workers: true }, null,
                        { resolveServeEntry: fixtureServeEntry });
                }, 'write failure must not throw');
            });
        } finally {
            rmDir(sessionDir);
        }
    });
});

test('AC-4: the emitted event conforms to the registered codegraph_degraded schema (no new event type minted)', () => {
    withTmpActivityRoot((activityRoot) => {
        const sessionDir = mkTmpDir('wmd-schema-');
        try {
            buildWorkerMcpConfig(sessionDir, '/tmp/work', { expose_mcp_to_workers: true }, null,
                { resolveServeEntry: () => null });
            const ev = readEvents(activityRoot, 'codegraph_degraded')
                .find(e => e.gate_payload && e.gate_payload.operation === 'worker_mcp_merge');
            assert.ok(ev, 'precondition: an event was emitted');

            // Validate against the REAL schema definition rather than a hand-copied
            // shape, so a schema change cannot leave this assertion quietly stale.
            const schema = JSON.parse(fs.readFileSync(
                new URL('../src/types/activity-events.schema.json', import.meta.url), 'utf8'));
            const def = schema.definitions.codegraph_degraded;
            assert.ok(def, 'codegraph_degraded is a registered schema definition — no new event type was minted');
            for (const field of def.required) {
                assert.ok(field in ev, `required field '${field}' present`);
            }
            assert.equal(ev.event, def.properties.event.const, 'event name matches the schema const');
            assert.equal(typeof ev.ts, 'string');
            assert.equal(typeof ev.reason, 'string');
        } finally {
            rmDir(sessionDir);
        }
    });
});

test('AC-4: the healthy merge path emits NO worker_mcp_merge degrade event (the event is not always-on noise)', () => {
    withTmpActivityRoot((activityRoot) => {
        const sessionDir = mkTmpDir('wmd-healthy-');
        try {
            buildWorkerMcpConfig(sessionDir, '/tmp/work', { expose_mcp_to_workers: true }, null,
                { resolveServeEntry: fixtureServeEntry });
            const events = readEvents(activityRoot, 'codegraph_degraded')
                .filter(e => e.gate_payload && e.gate_payload.operation === 'worker_mcp_merge');
            assert.equal(events.length, 0, 'a successful merge is not reported as degraded');
        } finally {
            rmDir(sessionDir);
        }
    });
});

// ---------------------------------------------------------------------------
// AC-5 — regression pins: operator file untouched; operator codegraph key wins
// ---------------------------------------------------------------------------

test('AC-5: the operator MCP config file is never written to', () => {
    const sessionDir = mkTmpDir('wmd-nomut-');
    const opDir = mkTmpDir('wmd-operator-');
    try {
        const opPath = path.join(opDir, 'mcp.json');
        const opBody = JSON.stringify({ mcpServers: { linear: { command: 'op', args: ['x'] } } }, null, 2);
        fs.writeFileSync(opPath, opBody);
        const before = fs.readFileSync(opPath);
        const mtimeBefore = fs.statSync(opPath).mtimeMs;

        buildWorkerMcpConfig(
            sessionDir, '/tmp/work',
            { worker_mcp_config_path: opPath, expose_mcp_to_workers: true },
            { linear: { command: 'op', args: ['x'] } },
            { resolveServeEntry: fixtureServeEntry },
        );

        assert.deepEqual(fs.readFileSync(opPath), before, 'operator config bytes are unchanged');
        assert.equal(fs.statSync(opPath).mtimeMs, mtimeBefore, 'operator config was not rewritten');
        assert.ok(fs.existsSync(sessionMcpPath(sessionDir)), 'only the SESSION file was written');
    } finally {
        rmDir(sessionDir);
        rmDir(opDir);
    }
});

test('AC-5: an operator-supplied codegraph key still WINS the name collision', () => {
    const sessionDir = mkTmpDir('wmd-collide-');
    try {
        const operatorCodegraph = { command: 'OPERATOR', args: ['custom'], env: {} };
        buildWorkerMcpConfig(
            sessionDir, '/tmp/work', { expose_mcp_to_workers: true },
            { codegraph: operatorCodegraph },
            { resolveServeEntry: fixtureServeEntry },
        );
        const cg = JSON.parse(fs.readFileSync(sessionMcpPath(sessionDir), 'utf8')).mcpServers.codegraph;
        assert.deepEqual(cg, operatorCodegraph, 'operator codegraph entry wins verbatim (spread-last)');
    } finally {
        rmDir(sessionDir);
    }
});

// ---------------------------------------------------------------------------
// AC-6 — codex workers receive NO --mcp-config (excluded by construction)
// ---------------------------------------------------------------------------

test('AC-6: codex worker argv carries no --mcp-config even when a session config exists', () => {
    const sessionDir = mkTmpDir('wmd-codex-');
    try {
        buildWorkerMcpConfig(sessionDir, '/tmp/work', { expose_mcp_to_workers: true }, null,
            { resolveServeEntry: fixtureServeEntry });
        assert.ok(fs.existsSync(sessionMcpPath(sessionDir)), 'precondition: the session file DOES exist');

        // The reader excludes codex...
        assert.equal(
            resolveSessionWorkerMcpConfig({ backend: 'codex' }, sessionDir), undefined,
            'codex never resolves the session-merged path',
        );
        // ...and even if a path were forced through, the codex arm drops it structurally.
        const inv = buildWorkerInvocation('codex', {
            prompt: 'x', addDirs: [], mcpConfig: sessionMcpPath(sessionDir),
        });
        assert.equal(inv.args.includes('--mcp-config'), false, 'codex worker argv must never carry --mcp-config');
    } finally {
        rmDir(sessionDir);
    }
});

// ---------------------------------------------------------------------------
// AC-8 — PICKLE_CODEGRAPH=off disables everything, including this
// ---------------------------------------------------------------------------

test('AC-8: PICKLE_CODEGRAPH=off makes the writer inert — no session file, operator passthrough', () => {
    const sessionDir = mkTmpDir('wmd-kill-w-');
    try {
        const result = buildWorkerMcpConfig(
            sessionDir, '/tmp/work',
            { worker_mcp_config_path: '/operator/mcp.json', expose_mcp_to_workers: true },
            { linear: { command: 'op' } },
            { resolveServeEntry: fixtureServeEntry, env: { PICKLE_CODEGRAPH: 'off' } },
        );
        assert.equal(result, '/operator/mcp.json', 'kill switch => operator passthrough');
        assert.equal(fs.existsSync(sessionMcpPath(sessionDir)), false, 'kill switch => nothing written');
    } finally {
        rmDir(sessionDir);
    }
});

test('AC-8: PICKLE_CODEGRAPH=off makes the reader inert even when a stale session file exists', () => {
    const sessionDir = mkTmpDir('wmd-kill-r-');
    try {
        // Materialize with the switch OFF (as an earlier session would have), then read
        // it back with the switch ON — the resume case a kill switch is reached for.
        buildWorkerMcpConfig(sessionDir, '/tmp/work', { expose_mcp_to_workers: true }, null,
            { resolveServeEntry: fixtureServeEntry });
        assert.ok(fs.existsSync(sessionMcpPath(sessionDir)), 'precondition: a stale session file exists');

        assert.equal(
            resolveSessionWorkerMcpConfig({ backend: 'claude' }, sessionDir, { PICKLE_CODEGRAPH: 'off' }),
            undefined,
            'kill switch => the stale file never reaches the spawned argv',
        );
        assert.equal(
            resolveSessionWorkerMcpConfig({ backend: 'claude' }, sessionDir, {}),
            sessionMcpPath(sessionDir),
            'control: without the kill switch the same file DOES resolve (non-vacuous)',
        );
    } finally {
        rmDir(sessionDir);
    }
});

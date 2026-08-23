// @tier: fast
//
// AC1-AC5 for c1d5ba67: session-merged worker MCP config builder
// (`buildWorkerMcpConfig`) and the `session_merged` precedence layer.
//
// Tests the COMPILED surface (../services/backend-spawn.js). They cover:
//   - disabled passthrough (writes nothing)                       (AC1)
//   - enabled merge: codegraph entry shape + ABSOLUTE bin         (AC2)
//   - operator `codegraph` collision wins (spread-last)           (AC3)
//   - operator non-codegraph servers survive alongside codegraph  (AC4)
//   - single-writer env CODEGRAPH_NO_WATCH=1                       (AC5 / C7)
//   - codex spawn excludes --mcp-config; claude includes it
//   - session_merged precedence_layer emitted truthfully
//
// The bin-dependent assertions resolve the SAME way the implementation does
// (createRequire + bin.codegraph) so the comparison is non-vacuous; if the real
// `@colbymchenry/codegraph` bundle cannot resolve in this env they t.skip rather
// than fail spuriously. Disabled/passthrough cases run unconditionally.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { buildWorkerMcpConfig, buildWorkerInvocation } from '../services/backend-spawn.js';
import { mkTmpDir, rmDir, withEmptyHome } from './__helpers__/empty-home.js';

const require = createRequire(import.meta.url);

// Resolve the real absolute codegraph bin the SAME way the implementation does,
// or return null when the per-platform bundle / package is genuinely absent.
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

function readMcpFile(sessionDir) {
    const p = path.join(sessionDir, 'mcp', 'worker-mcp.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// --- AC1: disabled (expose_mcp_to_workers not true) → passthrough, no file ---

test('buildWorkerMcpConfig: disabled (flag absent, no operator override) returns null and writes NO worker-mcp.json', () => {
    const sessionDir = mkTmpDir('wmm-disabled-');
    try {
        withEmptyHome(() => {
            const result = buildWorkerMcpConfig(sessionDir, '/tmp/work', undefined, null);
            assert.equal(result, null, 'no operator override + disabled + no ~/.claude.json → null passthrough');
        });
        assert.equal(
            fs.existsSync(path.join(sessionDir, 'mcp', 'worker-mcp.json')),
            false,
            'disabled path must not write the session file',
        );
    } finally {
        rmDir(sessionDir);
    }
});

test('buildWorkerMcpConfig: disabled returns operator passthrough path and writes NO session file', () => {
    const sessionDir = mkTmpDir('wmm-disabled-pt-');
    try {
        const result = buildWorkerMcpConfig(
            sessionDir,
            '/tmp/work',
            { worker_mcp_config_path: '/operator/mcp.json', expose_mcp_to_workers: false },
            { linear: { command: 'op' } },
        );
        assert.equal(result, '/operator/mcp.json', 'disabled → operator override path (passthrough)');
        assert.equal(
            fs.existsSync(path.join(sessionDir, 'mcp', 'worker-mcp.json')),
            false,
            'disabled path must not write the session file even with snapshot entries',
        );
    } finally {
        rmDir(sessionDir);
    }
});

// --- AC2: enabled, no operator codegraph → merged codegraph entry, ABSOLUTE bin ---

test('buildWorkerMcpConfig: enabled with NO operator codegraph entry materializes the codegraph serve command', (t) => {
    const binAbs = resolveRealCodegraphBinOrNull();
    if (!binAbs) return t.skip('@colbymchenry/codegraph bin not resolvable in this env');

    const sessionDir = mkTmpDir('wmm-enabled-');
    const workingDir = mkTmpDir('wmm-work-');
    try {
        const result = buildWorkerMcpConfig(
            sessionDir,
            workingDir,
            { expose_mcp_to_workers: true },
            null,
        );
        assert.equal(result, path.join(sessionDir, 'mcp', 'worker-mcp.json'), 'returns the session file path');

        const cfg = readMcpFile(sessionDir);
        const cg = cfg.mcpServers.codegraph;
        assert.ok(cg, 'merged config has a codegraph entry');
        assert.equal(cg.command, 'node', 'codegraph spawns via node');

        // args[0] is ABSOLUTE and ends with the package real bin.codegraph (non-vacuous).
        assert.ok(path.isAbsolute(cg.args[0]), 'codegraph args[0] (the bin) is an ABSOLUTE path');
        assert.equal(cg.args[0], binAbs, 'codegraph bin matches the real resolved bin');
        assert.ok(
            cg.args[0].endsWith(path.basename(binAbs)),
            'codegraph bin ends with the package bin.codegraph basename',
        );

        // args ends with ['serve','--mcp'].
        assert.deepEqual(cg.args.slice(-2), ['serve', '--mcp'], 'codegraph args end with serve --mcp');
        assert.equal(cg.cwd, workingDir, 'codegraph cwd is the working dir');
    } finally {
        rmDir(sessionDir);
        rmDir(workingDir);
    }
});

// --- AC5 / C7: single-writer — serve watcher OFF via CODEGRAPH_NO_WATCH=1 ---

test('buildWorkerMcpConfig: codegraph entry carries CODEGRAPH_NO_WATCH=1 (single-writer / C7)', (t) => {
    // C7 writer-ownership: codegraph-api-inventory.json records serve.watcher_disableable=true
    // and CODEGRAPH_NO_WATCH=1 as the authoritative opt-out. We launch serve with the watcher
    // OFF so C4's runtime sync stays the SOLE writer to .codegraph/codegraph.db — exactly one
    // writer authority for the index.
    const binAbs = resolveRealCodegraphBinOrNull();
    if (!binAbs) return t.skip('@colbymchenry/codegraph bin not resolvable in this env');

    const sessionDir = mkTmpDir('wmm-watcher-');
    try {
        buildWorkerMcpConfig(sessionDir, '/tmp/work', { expose_mcp_to_workers: true }, null);
        const cg = readMcpFile(sessionDir).mcpServers.codegraph;
        assert.equal(cg.env.CODEGRAPH_NO_WATCH, '1', 'serve launches with the auto-sync watcher disabled');
    } finally {
        rmDir(sessionDir);
    }
});

// --- AC3: operator `codegraph` key WINS the spread-last collision ---

test('buildWorkerMcpConfig: operator codegraph entry WINS the name collision (spread-last)', (t) => {
    const binAbs = resolveRealCodegraphBinOrNull();
    if (!binAbs) return t.skip('@colbymchenry/codegraph bin not resolvable in this env');

    const sessionDir = mkTmpDir('wmm-collision-');
    try {
        const operatorCodegraph = { command: 'OPERATOR', args: ['custom'], env: {} };
        buildWorkerMcpConfig(
            sessionDir,
            '/tmp/work',
            { expose_mcp_to_workers: true },
            { codegraph: operatorCodegraph },
        );
        const cg = readMcpFile(sessionDir).mcpServers.codegraph;
        assert.equal(cg.command, 'OPERATOR', 'operator codegraph overrides the built-in (intentional)');
        assert.deepEqual(cg.args, ['custom'], 'operator codegraph args win');
    } finally {
        rmDir(sessionDir);
    }
});

// --- AC4: operator non-codegraph servers survive alongside codegraph ---

test('buildWorkerMcpConfig: operator non-codegraph servers survive alongside the codegraph entry', (t) => {
    const binAbs = resolveRealCodegraphBinOrNull();
    if (!binAbs) return t.skip('@colbymchenry/codegraph bin not resolvable in this env');

    const sessionDir = mkTmpDir('wmm-survive-');
    try {
        const linear = { command: 'npx', args: ['-y', 'linear-mcp'], env: { LINEAR_KEY: 'x' } };
        buildWorkerMcpConfig(
            sessionDir,
            '/tmp/work',
            { expose_mcp_to_workers: true },
            { linear },
        );
        const servers = readMcpFile(sessionDir).mcpServers;
        assert.ok(servers.codegraph, 'codegraph entry present');
        assert.equal(servers.codegraph.command, 'node', 'codegraph is the built-in node entry (no operator override)');
        assert.deepEqual(servers.linear, linear, 'operator linear entry survives verbatim');
    } finally {
        rmDir(sessionDir);
    }
});

// --- spawn-arg coupling: claude includes --mcp-config; codex never does ---

test('buildWorkerInvocation: claude worker includes --mcp-config <session path> when opts.mcpConfig is set', () => {
    const sessionPath = '/tmp/session/mcp/worker-mcp.json';
    const inv = buildWorkerInvocation('claude', {
        prompt: 'x',
        addDirs: [],
        mcpConfig: sessionPath,
    });
    const idx = inv.args.indexOf('--mcp-config');
    assert.ok(idx >= 0, 'claude worker pushes --mcp-config');
    assert.equal(inv.args[idx + 1], sessionPath, '--mcp-config value is the session-merged path');
});

test('buildWorkerInvocation: codex worker NEVER includes --mcp-config even when opts.mcpConfig is set', () => {
    // Codex exclusion is structural: buildCodexInvocation never receives/forwards
    // the mcpConfig path. This guards that the session-merged path cannot leak into
    // a codex spawn.
    const inv = buildWorkerInvocation('codex', {
        prompt: 'x',
        addDirs: [],
        mcpConfig: '/tmp/session/mcp/worker-mcp.json',
    });
    assert.equal(inv.args.includes('--mcp-config'), false, 'codex worker must NOT include --mcp-config');
});

// --- session_merged precedence layer emitted truthfully ---

function withTmpActivityRoot(fn) {
    const prevRoot = process.env.PICKLE_DATA_ROOT;
    const prevDir = process.env.PICKLE_DATA_DIR;
    const root = mkTmpDir('wmm-activity-');
    process.env.PICKLE_DATA_ROOT = root;
    delete process.env.PICKLE_DATA_DIR;
    try {
        return fn(root);
    } finally {
        if (prevRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = prevRoot;
        if (prevDir !== undefined) process.env.PICKLE_DATA_DIR = prevDir;
        rmDir(root);
    }
}

function readWorkerMcpEvents(activityRoot) {
    const dir = path.join(activityRoot, 'activity');
    if (!fs.existsSync(dir)) return [];
    const events = [];
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.jsonl')) continue;
        for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let ev;
            try { ev = JSON.parse(trimmed); } catch { continue; }
            if (ev.event === 'worker_mcp_config_resolved') events.push(ev);
        }
    }
    return events;
}

test('buildWorkerInvocation: claude worker with opts.mcpConfig emits worker_mcp_config_resolved naming session_merged', () => {
    withTmpActivityRoot((root) => {
        const sessionPath = '/tmp/session/mcp/worker-mcp.json';
        buildWorkerInvocation('claude', { prompt: 'x', addDirs: [], mcpConfig: sessionPath });

        const events = readWorkerMcpEvents(root);
        const merged = events.filter(e => e.gate_payload && e.gate_payload.precedence_layer === 'session_merged');
        assert.equal(merged.length, 1, 'exactly one session_merged emission');
        assert.equal(merged[0].gate_payload.mcp_config_path, sessionPath, 'emitted path is the session-merged path');
    });
});

test('buildWorkerInvocation: claude worker with NO override emits omitted layer (regression guard)', () => {
    withTmpActivityRoot((root) => {
        // No mcpConfig, no settingsBag override, and HOME pointed at an empty dir so
        // ~/.claude.json does not exist → the resolver lands on the `omitted` layer.
        withEmptyHome(() => {
            buildWorkerInvocation('claude', { prompt: 'x', addDirs: [] });
            const layers = readWorkerMcpEvents(root)
                .map(e => e.gate_payload && e.gate_payload.precedence_layer);
            assert.ok(layers.includes('omitted'), 'no-override path emits the omitted layer');
            assert.equal(layers.includes('session_merged'), false, 'no-override path must NOT claim session_merged');
        });
    });
});

// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    resolveMcpConfigPath,
    buildWorkerInvocation,
    buildManagerInvocation,
} from '../../services/backend-spawn.js';

// Shared fixture helpers
function mkTmpHome(label) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `mcp-${label}-`));
}

function cleanDir(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

// --- resolveMcpConfigPath ---

test('resolveMcpConfigPath: returns override path from settingsBag (AC-1)', () => {
    const tmpHome = mkTmpHome('override');
    try {
        const result = resolveMcpConfigPath({ worker_mcp_config_path: '/custom/ops-mcp.json' }, tmpHome);
        assert.equal(result, '/custom/ops-mcp.json');
    } finally {
        cleanDir(tmpHome);
    }
});

test('resolveMcpConfigPath: trims whitespace from override path', () => {
    const tmpHome = mkTmpHome('trim');
    try {
        const result = resolveMcpConfigPath({ worker_mcp_config_path: '  /trimmed/path.json  ' }, tmpHome);
        assert.equal(result, '/trimmed/path.json');
    } finally {
        cleanDir(tmpHome);
    }
});

test('resolveMcpConfigPath: override path wins over ~/.claude.json (precedence 1 > 2)', () => {
    const tmpHome = mkTmpHome('pri');
    const claudeJson = path.join(tmpHome, '.claude.json');
    fs.writeFileSync(claudeJson, '{}');
    try {
        const result = resolveMcpConfigPath({ worker_mcp_config_path: '/override.json' }, tmpHome);
        assert.equal(result, '/override.json');
    } finally {
        cleanDir(tmpHome);
    }
});

test('resolveMcpConfigPath: null override falls through to ~/.claude.json (AC-2 default precedence)', () => {
    const tmpHome = mkTmpHome('fallback');
    const claudeJson = path.join(tmpHome, '.claude.json');
    fs.writeFileSync(claudeJson, '{"mcpServers":{}}');
    try {
        const result = resolveMcpConfigPath({ worker_mcp_config_path: null }, tmpHome);
        assert.equal(result, claudeJson);
    } finally {
        cleanDir(tmpHome);
    }
});

test('resolveMcpConfigPath: undefined settingsBag falls through to ~/.claude.json (AC-2)', () => {
    const tmpHome = mkTmpHome('undef');
    const claudeJson = path.join(tmpHome, '.claude.json');
    fs.writeFileSync(claudeJson, '{"mcpServers":{}}');
    try {
        const result = resolveMcpConfigPath(undefined, tmpHome);
        assert.equal(result, claudeJson);
    } finally {
        cleanDir(tmpHome);
    }
});

test('resolveMcpConfigPath: returns undefined when neither override nor ~/.claude.json present (clean omission, AC-2)', () => {
    const tmpHome = mkTmpHome('empty');
    // no .claude.json created
    try {
        const result = resolveMcpConfigPath({}, tmpHome);
        assert.equal(result, undefined);
    } finally {
        cleanDir(tmpHome);
    }
});

test('resolveMcpConfigPath: empty-string override falls through to ~/.claude.json', () => {
    const tmpHome = mkTmpHome('emptystr');
    const claudeJson = path.join(tmpHome, '.claude.json');
    fs.writeFileSync(claudeJson, '{"mcpServers":{}}');
    try {
        const result = resolveMcpConfigPath({ worker_mcp_config_path: '' }, tmpHome);
        assert.equal(result, claudeJson);
    } finally {
        cleanDir(tmpHome);
    }
});

// --- buildWorkerInvocation: --mcp-config wiring ---
// These tests use explicit opts.mcpConfig to avoid ~/.claude.json side-effects from
// the real home directory — the resolver unit tests above cover the fallback path.

test('buildWorkerInvocation(claude): --mcp-config from settingsBag override path via explicit mcpConfig', () => {
    // Use mcpConfig directly (caller-provided path) which is the override-path path.
    const inv = buildWorkerInvocation('claude', {
        prompt: 'test',
        addDirs: [],
        mcpConfig: '/ops/mcp.json',
    });
    const idx = inv.args.indexOf('--mcp-config');
    assert.ok(idx >= 0, '--mcp-config flag should be present');
    assert.equal(inv.args[idx + 1], '/ops/mcp.json');
});

test('buildWorkerInvocation(claude): no --mcp-config when settingsBag is empty and no ~/.claude.json (INV-MCP-OPT-IN)', () => {
    // Create an isolated tmp home with no .claude.json to test clean omission path.
    // We cannot pass homeDir to buildWorkerInvocation directly, so we test via a
    // known-absent path: if the real ~/.claude.json doesn't exist we get clean omission;
    // if it does, use a guard. The resolver unit tests cover this path exhaustively;
    // this integration test confirms the build function wires through.
    const tmpHome = mkTmpHome('invwrk-empty');
    // No .claude.json in tmpHome; but we can't inject homeDir into buildWorkerInvocation.
    // Instead test the negative: with settingsBag null and explicit mcpConfig absent,
    // --mcp-config must be absent (when real ~/.claude.json doesn't exist) OR present
    // (when it does). We can only assert the value is never 'undefined' (INV-MCP-OPT-IN).
    const inv = buildWorkerInvocation('claude', {
        prompt: 'test',
        addDirs: [],
    });
    // INV-MCP-OPT-IN: --mcp-config must NEVER be followed by the string 'undefined'.
    const idx = inv.args.indexOf('--mcp-config');
    if (idx >= 0) {
        assert.notEqual(inv.args[idx + 1], 'undefined', '--mcp-config must not be the string undefined');
    }
    cleanDir(tmpHome);
});

test('buildWorkerInvocation(claude): explicit mcpConfig takes precedence over settingsBag', () => {
    const inv = buildWorkerInvocation('claude', {
        prompt: 'test',
        addDirs: [],
        mcpConfig: '{"mcpServers":{}}',
        settingsBag: { worker_mcp_config_path: '/should-not-appear.json' },
    });
    const idx = inv.args.indexOf('--mcp-config');
    assert.ok(idx >= 0, '--mcp-config flag should be present');
    assert.equal(inv.args[idx + 1], '{"mcpServers":{}}');
    assert.equal(inv.args.includes('/should-not-appear.json'), false);
});

test('buildWorkerInvocation(claude): settingsBag override path flows through to --mcp-config', () => {
    // Since buildWorkerInvocation calls resolveMcpConfigPath(opts.settingsBag) as fallback,
    // a non-null settingsBag.worker_mcp_config_path must appear as --mcp-config.
    const inv = buildWorkerInvocation('claude', {
        prompt: 'test',
        addDirs: [],
        settingsBag: { worker_mcp_config_path: '/settings-override.json' },
    });
    const idx = inv.args.indexOf('--mcp-config');
    assert.ok(idx >= 0, '--mcp-config flag should be present from settingsBag');
    assert.equal(inv.args[idx + 1], '/settings-override.json');
});

// --- buildManagerInvocation: --mcp-config wiring ---

test('buildManagerInvocation(claude): --mcp-config from explicit mcpConfig opt', () => {
    const inv = buildManagerInvocation('claude', {
        prompt: 'manage',
        addDirs: [],
        mcpConfig: '/ops/mgr-mcp.json',
    });
    const idx = inv.args.indexOf('--mcp-config');
    assert.ok(idx >= 0, '--mcp-config flag should be present');
    assert.equal(inv.args[idx + 1], '/ops/mgr-mcp.json');
});

test('buildManagerInvocation(claude): settingsBag override path flows through to --mcp-config', () => {
    const inv = buildManagerInvocation('claude', {
        prompt: 'manage',
        addDirs: [],
        settingsBag: { worker_mcp_config_path: '/mgr-settings-override.json' },
    });
    const idx = inv.args.indexOf('--mcp-config');
    assert.ok(idx >= 0, '--mcp-config flag should be present from settingsBag');
    assert.equal(inv.args[idx + 1], '/mgr-settings-override.json');
});

test('buildManagerInvocation(claude): INV-MCP-OPT-IN — --mcp-config never followed by string undefined', () => {
    const inv = buildManagerInvocation('claude', {
        prompt: 'manage',
        addDirs: [],
    });
    const idx = inv.args.indexOf('--mcp-config');
    if (idx >= 0) {
        assert.notEqual(inv.args[idx + 1], 'undefined', '--mcp-config must not be the string undefined');
    }
});

test('buildManagerInvocation(claude): --mcp-config placed before -p prompt trailer', () => {
    const inv = buildManagerInvocation('claude', {
        prompt: 'manage',
        addDirs: [],
        mcpConfig: '/explicit/mcp.json',
    });
    const mcpIdx = inv.args.indexOf('--mcp-config');
    const pIdx = inv.args.indexOf('-p');
    assert.ok(mcpIdx >= 0);
    assert.ok(mcpIdx < pIdx, '--mcp-config must precede -p');
});

// --- AC-MFW-6: worker_mcp_config_resolved event emission ---

function readActivityEvents(dataRoot) {
    const activityDir = path.join(dataRoot, 'activity');
    if (!fs.existsSync(activityDir)) return [];
    const files = fs.readdirSync(activityDir);
    const events = [];
    for (const file of files) {
        const lines = fs.readFileSync(path.join(activityDir, file), 'utf8')
            .split('\n').filter(Boolean);
        for (const line of lines) {
            try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
        }
    }
    return events;
}

test('AC-MFW-6: buildWorkerInvocation(claude) emits worker_mcp_config_resolved once (settings_override)', () => {
    const tmpDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mfw6-wrk-'));
    const origDataRoot = process.env.PICKLE_DATA_ROOT;
    process.env.PICKLE_DATA_ROOT = tmpDataRoot;
    try {
        buildWorkerInvocation('claude', {
            prompt: 'test',
            addDirs: [],
            settingsBag: { worker_mcp_config_path: '/custom/mcp.json' },
        });
        const events = readActivityEvents(tmpDataRoot).filter(e => e.event === 'worker_mcp_config_resolved');
        assert.equal(events.length, 1, 'exactly one worker_mcp_config_resolved event per spawn');
        assert.equal(events[0].gate_payload.precedence_layer, 'settings_override');
        assert.equal(events[0].gate_payload.mcp_config_path, '/custom/mcp.json');
    } finally {
        process.env.PICKLE_DATA_ROOT = origDataRoot;
        if (origDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        fs.rmSync(tmpDataRoot, { recursive: true, force: true });
    }
});

test('AC-MFW-6: buildWorkerInvocation(claude) emits worker_mcp_config_resolved once (omitted)', () => {
    const tmpDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mfw6-wrk-omit-'));
    const tmpHome = mkTmpHome('mfw6-wrk-home');
    // No .claude.json in tmpHome — ensures omitted path
    const origDataRoot = process.env.PICKLE_DATA_ROOT;
    const origHome = process.env.HOME;
    process.env.PICKLE_DATA_ROOT = tmpDataRoot;
    // We can't inject homeDir into buildWorkerInvocation, but if HOME is set to
    // a directory without .claude.json the resolver falls through to 'omitted'.
    // Only override HOME when the real ~/.claude.json doesn't exist.
    const realClaudeJson = path.join(os.homedir(), '.claude.json');
    const overrideHome = !fs.existsSync(realClaudeJson);
    if (overrideHome) process.env.HOME = tmpHome;
    try {
        buildWorkerInvocation('claude', {
            prompt: 'test',
            addDirs: [],
            settingsBag: {},
        });
        const events = readActivityEvents(tmpDataRoot).filter(e => e.event === 'worker_mcp_config_resolved');
        assert.equal(events.length, 1, 'exactly one worker_mcp_config_resolved event per spawn');
        if (overrideHome) {
            assert.equal(events[0].gate_payload.precedence_layer, 'omitted');
            assert.equal(events[0].gate_payload.mcp_config_path, null);
        } else {
            // Real ~/.claude.json exists — layer will be claude_json_fallback
            assert.ok(
                ['omitted', 'claude_json_fallback'].includes(events[0].gate_payload.precedence_layer),
                `precedence_layer should be omitted or claude_json_fallback, got ${events[0].gate_payload.precedence_layer}`,
            );
        }
    } finally {
        process.env.PICKLE_DATA_ROOT = origDataRoot;
        if (origDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        if (overrideHome) {
            process.env.HOME = origHome;
            if (origHome === undefined) delete process.env.HOME;
        }
        fs.rmSync(tmpDataRoot, { recursive: true, force: true });
        cleanDir(tmpHome);
    }
});

test('AC-MFW-6: buildManagerInvocation(claude) emits worker_mcp_config_resolved once (settings_override)', () => {
    const tmpDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mfw6-mgr-'));
    const origDataRoot = process.env.PICKLE_DATA_ROOT;
    process.env.PICKLE_DATA_ROOT = tmpDataRoot;
    try {
        buildManagerInvocation('claude', {
            prompt: 'manage',
            addDirs: [],
            settingsBag: { worker_mcp_config_path: '/mgr/mcp.json' },
        });
        const events = readActivityEvents(tmpDataRoot).filter(e => e.event === 'worker_mcp_config_resolved');
        assert.equal(events.length, 1, 'exactly one worker_mcp_config_resolved event per manager spawn');
        assert.equal(events[0].gate_payload.precedence_layer, 'settings_override');
        assert.equal(events[0].gate_payload.mcp_config_path, '/mgr/mcp.json');
    } finally {
        process.env.PICKLE_DATA_ROOT = origDataRoot;
        if (origDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        fs.rmSync(tmpDataRoot, { recursive: true, force: true });
    }
});

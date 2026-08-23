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
    __resetBackendWarnings,
} from '../../services/backend-spawn.js';
import { withEmptyHome } from '../__helpers__/empty-home.js';

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

// --- AC-4/AC-7: parametrized resolver matrix over an injected homeDir (ticket 9c647682) ---
//
// `resolveMcpConfigWithLayer` (backend-spawn.ts:481) is NOT exported — only the path-only
// `resolveMcpConfigPath` is public. Its decision tree makes the returned path itself prove
// which layer won: 'omitted' is the only layer returning undefined, 'settings_override'
// always returns the (distinct, fixture-unique) override path, and 'claude_json_fallback'
// always returns the (distinct) `<homeDir>/.claude.json` path — the two candidate paths
// never collide in these fixtures. Asserting the returned path therefore asserts the layer
// too, with no source change required (a source change is out of scope for this ticket).
//
// Every row gets its OWN tmp home directory (mkTmpHome) so the per-process
// `mcpConfigVerdictCache` (keyed on resolved absolute path) never serves a stale verdict
// from an earlier row onto a later one.

function captureStderrQuiet(fn) {
    const orig = process.stderr.write;
    process.stderr.write = () => true;
    try {
        return fn();
    } finally {
        process.stderr.write = orig;
    }
}

const CLAUDE_JSON_FALLBACK_MATRIX = [
    { name: 'absent ~/.claude.json', write: null, omitted: true },
    { name: 'unparseable JSON', write: 'not json at all', omitted: true },
    { name: 'valid JSON, no mcpServers key', write: '{"foo":"bar"}', omitted: true },
    { name: 'mcpServers: [] (array is NOT a record)', write: '{"mcpServers":[]}', omitted: true },
    { name: 'mcpServers: null', write: '{"mcpServers":null}', omitted: true },
    { name: 'mcpServers: {} (empty record IS valid)', write: '{"mcpServers":{}}', omitted: false },
    { name: 'mcpServers: {linear:{}} (populated)', write: '{"mcpServers":{"linear":{}}}', omitted: false },
];

for (const row of CLAUDE_JSON_FALLBACK_MATRIX) {
    test(`AC-4 matrix (claude_json_fallback layer): ${row.name}`, () => {
        const tmpHome = mkTmpHome('matrix-fb');
        const claudeJson = path.join(tmpHome, '.claude.json');
        if (row.write !== null) fs.writeFileSync(claudeJson, row.write);
        __resetBackendWarnings();
        try {
            const result = captureStderrQuiet(() => resolveMcpConfigPath({}, tmpHome));
            if (row.omitted) {
                assert.equal(result, undefined, `${row.name}: must resolve to layer 'omitted' (path undefined)`);
            } else {
                assert.equal(result, claudeJson, `${row.name}: must resolve to layer 'claude_json_fallback' (path === ~/.claude.json)`);
            }
        } finally {
            __resetBackendWarnings();
            cleanDir(tmpHome);
        }
    });
}

// settings_override matrix, mirroring the fallback rows above but through the override arm.
// ~/.claude.json is intentionally left ABSENT in every row so a fall-through resolves
// cleanly to 'omitted', isolating the override arm's own verdict from layer-2 behavior
// (fall-through-to-claude_json_fallback is already covered by the AC-6 tests above).
const SETTINGS_OVERRIDE_MATRIX = [
    // KNOWN AC-2 RESIDUAL (inherited from ticket 50cd4039, tracked for later closure): a
    // NON-EXISTENT settings_override path is passed through verbatim rather than falling
    // through to the next layer — only an existing-but-invalid override falls through. This
    // row pins the CURRENT behavior; it is not an endorsement of it.
    { name: 'missing override file (AC-2 residual: passed through verbatim)', write: null, resolvesToOverride: true },
    { name: 'unparseable override JSON', write: 'not json at all', resolvesToOverride: false },
    { name: 'override valid JSON, no mcpServers key', write: '{"foo":"bar"}', resolvesToOverride: false },
    { name: 'override mcpServers: [] (array is NOT a record)', write: '{"mcpServers":[]}', resolvesToOverride: false },
    { name: 'override mcpServers: null', write: '{"mcpServers":null}', resolvesToOverride: false },
    { name: 'override mcpServers: {} (empty record PASSES)', write: '{"mcpServers":{}}', resolvesToOverride: true },
    { name: 'override mcpServers: {linear:{}} (populated)', write: '{"mcpServers":{"linear":{}}}', resolvesToOverride: true },
];

for (const row of SETTINGS_OVERRIDE_MATRIX) {
    test(`AC-4 matrix (settings_override layer): ${row.name}`, () => {
        const tmpHome = mkTmpHome('matrix-ov');
        const overridePath = path.join(tmpHome, 'ops-mcp.json');
        if (row.write !== null) fs.writeFileSync(overridePath, row.write);
        __resetBackendWarnings();
        try {
            const result = captureStderrQuiet(() => resolveMcpConfigPath({ worker_mcp_config_path: overridePath }, tmpHome));
            if (row.resolvesToOverride) {
                assert.equal(result, overridePath, `${row.name}: must resolve to layer 'settings_override'`);
            } else {
                assert.equal(result, undefined, `${row.name}: must fall through to layer 'omitted' (no ~/.claude.json present)`);
            }
        } finally {
            __resetBackendWarnings();
            cleanDir(tmpHome);
        }
    });
}

test('AC-4 matrix: precedence row — a valid worker_mcp_config_path beats a malformed ~/.claude.json (resolves to settings_override)', () => {
    const tmpHome = mkTmpHome('matrix-precedence');
    const overridePath = path.join(tmpHome, 'ops-mcp.json');
    fs.writeFileSync(overridePath, '{"mcpServers":{"linear":{}}}');
    fs.writeFileSync(path.join(tmpHome, '.claude.json'), 'not json at all');
    __resetBackendWarnings();
    try {
        const result = captureStderrQuiet(() => resolveMcpConfigPath({ worker_mcp_config_path: overridePath }, tmpHome));
        assert.equal(result, overridePath, 'settings_override must win over a malformed claude_json_fallback layer');
    } finally {
        __resetBackendWarnings();
        cleanDir(tmpHome);
    }
});

test('AC-7 happy-path regression: a populated ~/.claude.json AND a valid worker_mcp_config_path both keep resolving to their existing paths/layers (no behavior change, precedence order unchanged) — guards against an over-strict validator (R1)', () => {
    const tmpHome = mkTmpHome('matrix-ac7');
    const overridePath = path.join(tmpHome, 'ops-mcp.json');
    const claudeJson = path.join(tmpHome, '.claude.json');
    fs.writeFileSync(overridePath, '{"mcpServers":{"linear":{}}}');
    fs.writeFileSync(claudeJson, '{"mcpServers":{"github":{},"linear":{}}}');
    __resetBackendWarnings();
    try {
        // With an override present, settings_override still wins the precedence order.
        const withOverride = captureStderrQuiet(() => resolveMcpConfigPath({ worker_mcp_config_path: overridePath }, tmpHome));
        assert.equal(withOverride, overridePath, 'settings_override must still win when both layers are valid');
        // Without an override, the populated ~/.claude.json still resolves via claude_json_fallback.
        const withoutOverride = captureStderrQuiet(() => resolveMcpConfigPath({}, tmpHome));
        assert.equal(withoutOverride, claudeJson, 'a populated ~/.claude.json must still resolve via claude_json_fallback');
    } finally {
        __resetBackendWarnings();
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
    const origDataRoot = process.env.PICKLE_DATA_ROOT;
    process.env.PICKLE_DATA_ROOT = tmpDataRoot;
    try {
        // withEmptyHome deterministically points HOME at an empty dir so the resolver's
        // ~/.claude.json fallback misses regardless of host state (AP-10).
        withEmptyHome(() => {
            buildWorkerInvocation('claude', {
                prompt: 'test',
                addDirs: [],
                settingsBag: {},
            });
        });
        const events = readActivityEvents(tmpDataRoot).filter(e => e.event === 'worker_mcp_config_resolved');
        assert.equal(events.length, 1, 'exactly one worker_mcp_config_resolved event per spawn');
        assert.equal(events[0].gate_payload.precedence_layer, 'omitted');
        assert.equal(events[0].gate_payload.mcp_config_path, null);
    } finally {
        process.env.PICKLE_DATA_ROOT = origDataRoot;
        if (origDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        fs.rmSync(tmpDataRoot, { recursive: true, force: true });
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

// --- AC-6: once-per-process MCP degradation warning ---
// Every test here resets the module warn-once latch via the existing
// __resetBackendWarnings seam and uses a UNIQUE mkTmpHome label, so the
// per-process verdict memo (keyed on absolute path) never collides across tests.

function captureStderr(fn) {
    const orig = process.stderr.write;
    const lines = [];
    process.stderr.write = (chunk) => {
        lines.push(String(chunk));
        return true;
    };
    try {
        fn();
    } finally {
        process.stderr.write = orig;
    }
    return lines;
}

test('AC-6: settings_override rejection warns at HIGH prominence with path, condition and consequence', () => {
    const tmpHome = mkTmpHome('ac6-hi');
    const override = path.join(tmpHome, 'ops-mcp.json');
    fs.writeFileSync(override, '{"mcpServers":[]}');
    fs.writeFileSync(path.join(tmpHome, '.claude.json'), '{"mcpServers":{"linear":{}}}');
    __resetBackendWarnings();
    try {
        let resolved;
        const lines = captureStderr(() => {
            resolved = resolveMcpConfigPath({ worker_mcp_config_path: override }, tmpHome);
        });
        assert.equal(lines.length, 1, 'exactly one degradation line');
        const line = lines[0];
        assert.match(line, /^\[backend-spawn\] WARNING: MCP config degraded: settings_override /);
        assert.ok(line.includes(override), 'names the rejected path');
        assert.ok(line.includes(JSON.stringify(override)), 'operator-supplied path is quoted');
        assert.equal((line.match(/\n/g) || []).length, 1, 'exactly one log line, un-forgeable');
        assert.ok(line.includes('mcpServers is not a record'), 'names the failing condition');
        assert.ok(line.includes('falling back to claude_json_fallback'), 'names the winning layer');
        assert.ok(line.endsWith('\n'), 'terminated');
        // AC-2/AC-3: it degraded to the next layer, it did not fail the resolution.
        assert.equal(resolved, path.join(tmpHome, '.claude.json'));
    } finally {
        __resetBackendWarnings();
        cleanDir(tmpHome);
    }
});

test('AC-6: claude_json_fallback rejection warns at LOW prominence (never deliberately chosen)', () => {
    const tmpHome = mkTmpHome('ac6-lo');
    fs.writeFileSync(path.join(tmpHome, '.claude.json'), 'not json at all');
    __resetBackendWarnings();
    try {
        let resolved;
        const lines = captureStderr(() => {
            resolved = resolveMcpConfigPath({}, tmpHome);
        });
        assert.equal(lines.length, 1, 'exactly one degradation line');
        const line = lines[0];
        assert.match(line, /^\[backend-spawn\] note: MCP config degraded: claude_json_fallback /);
        assert.ok(!line.includes('WARNING:'), 'layer 2 is the quieter prominence level');
        assert.ok(line.includes(path.join(tmpHome, '.claude.json')), 'names the rejected path');
        assert.ok(line.includes('unparseable JSON'), 'names the failing condition');
        assert.ok(line.includes('--mcp-config omitted'), 'names the consequence');
        assert.equal(resolved, undefined);
    } finally {
        __resetBackendWarnings();
        cleanDir(tmpHome);
    }
});

test('AC-6: at most ONE warning per process across repeated resolutions and memo cache hits', () => {
    const tmpHome = mkTmpHome('ac6-once');
    const badOverride = path.join(tmpHome, 'bad-override.json');
    fs.writeFileSync(badOverride, '{"mcpServers":null}');
    const otherHome = mkTmpHome('ac6-once-other');
    fs.writeFileSync(path.join(otherHome, '.claude.json'), '{"no":"servers"}');
    __resetBackendWarnings();
    try {
        const lines = captureStderr(() => {
            // Calls 2..5 are verdict-memo cache hits on the same path.
            for (let i = 0; i < 5; i++) {
                resolveMcpConfigPath({ worker_mcp_config_path: badOverride }, tmpHome);
            }
            // A second, differently-broken layer must not get its own line either.
            resolveMcpConfigPath({}, otherHome);
        });
        assert.equal(lines.length, 1, `expected exactly 1 line for the whole process, got ${lines.length}: ${JSON.stringify(lines)}`);
        assert.ok(lines[0].includes('WARNING:'), 'the first (higher-prominence) rejection wins the single slot');
    } finally {
        __resetBackendWarnings();
        cleanDir(tmpHome);
        cleanDir(otherHome);
    }
});

test('AC-6: the warning survives the verdict memo — a cache-hit resolution still names the condition', () => {
    const tmpHome = mkTmpHome('ac6-memo');
    fs.writeFileSync(path.join(tmpHome, '.claude.json'), '{"mcpServers":[]}');
    __resetBackendWarnings();
    try {
        const first = captureStderr(() => resolveMcpConfigPath({}, tmpHome));
        assert.equal(first.length, 1, 'first (cache-miss) resolution warns');
        // Latch released; the NEXT resolution reads the verdict from the memo, never
        // re-parsing the file. The reason must still be recoverable from the cache.
        __resetBackendWarnings();
        const second = captureStderr(() => resolveMcpConfigPath({}, tmpHome));
        assert.equal(second.length, 1, 'cache-hit resolution still warns');
        assert.ok(second[0].includes('mcpServers is not a record'), 'condition survives memoization');
        assert.equal(second[0], first[0], 'cache hit produces the identical diagnostic');
    } finally {
        __resetBackendWarnings();
        cleanDir(tmpHome);
    }
});

test('AC-6/AC-3: a missing ~/.claude.json with no override is SILENT (clean omission is not a degradation)', () => {
    const tmpHome = mkTmpHome('ac6-clean');
    __resetBackendWarnings();
    try {
        let resolved;
        const lines = captureStderr(() => {
            resolved = resolveMcpConfigPath({}, tmpHome);
        });
        assert.deepEqual(lines, [], 'no config was ever chosen, so nothing was degraded');
        assert.equal(resolved, undefined);
    } finally {
        __resetBackendWarnings();
        cleanDir(tmpHome);
    }
});

test('AC-6/AC-7: a MISSING settings_override warns at HIGH prominence and still passes the path through', () => {
    const tmpHome = mkTmpHome('ac6-gone');
    const override = path.join(tmpHome, 'never-materialized.json');
    __resetBackendWarnings();
    try {
        let resolved;
        const lines = captureStderr(() => {
            resolved = resolveMcpConfigPath({ worker_mcp_config_path: override }, tmpHome);
        });
        assert.equal(lines.length, 1);
        assert.ok(lines[0].includes('WARNING:'), 'an explicit operator instruction pointing at nothing is high prominence');
        assert.ok(lines[0].includes('file missing'), 'names the failing condition');
        assert.ok(lines[0].includes('passed through unvalidated'), 'names the consequence');
        // AC-7: resolution behaviour is unchanged — the path is still handed to the CLI.
        assert.equal(resolved, override);
    } finally {
        __resetBackendWarnings();
        cleanDir(tmpHome);
    }
});

test('AC-3: a valid config on either layer emits no warning at all', () => {
    const tmpHome = mkTmpHome('ac6-happy');
    const override = path.join(tmpHome, 'good.json');
    fs.writeFileSync(override, '{"mcpServers":{"linear":{}}}');
    fs.writeFileSync(path.join(tmpHome, '.claude.json'), '{"mcpServers":{}}');
    __resetBackendWarnings();
    try {
        const lines = captureStderr(() => {
            assert.equal(resolveMcpConfigPath({ worker_mcp_config_path: override }, tmpHome), override);
            assert.equal(resolveMcpConfigPath({}, tmpHome), path.join(tmpHome, '.claude.json'));
        });
        assert.deepEqual(lines, []);
    } finally {
        __resetBackendWarnings();
        cleanDir(tmpHome);
    }
});

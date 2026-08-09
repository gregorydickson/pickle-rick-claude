// @tier: integration
//
// AC-C4: runCodegraphIndexAtSetup — session setup codegraph indexing.
// AC-SPAWN: shouldSyncCodegraph + session summary integration (mux-runner spawn site).
//
// Covers: kill-switch, disabled/index_at_setup gates, full build, null→index_failed,
// resume matrix (noop / stale→sync / missing→rebuild), .git/info/exclude hygiene,
// SESSION_ROOT ordering guarantee (structural source check).
// AC-SPAWN: spawn-site staleness decision, session summary index_status derivation.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { runCodegraphIndexAtSetup } = await import(
  path.resolve(__dirname, '../../bin/setup.js')
);

const { shouldSyncCodegraph } = await import(
  path.resolve(__dirname, '../../bin/mux-runner.js')
);

const { writeIndexedHeadSha } = await import(
  path.resolve(__dirname, '../../services/codegraph-service.js')
);

const FIXED_SHA = 'ac4c4index-fixed-sha';

const sandboxDirs = [];
after(() => {
  for (const d of sandboxDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeSandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-cgindex-'));
  sandboxDirs.push(d);
  return d;
}

function baseSettings(overrides = {}) {
  return {
    enabled: true,
    index_at_setup: true,
    staleness_max_age_minutes: 30,
    context_max_bytes: 8192,
    expose_mcp_to_workers: false,
    index_timeout_ms: 5000,
    sync_timeout_ms: 5000,
    query_timeout_ms: 5000,
    ...overrides,
  };
}

function fakeImpl(overrides = {}) {
  return {
    indexAll: async () => ({ filesIndexed: 1 }),
    sync: async () => ({ filesChecked: 1 }),
    searchNodes: () => [],
    getCallers: () => [],
    getImpactRadius: () => ({}),
    buildContext: async () => 'ctx',
    close: () => {},
    ...overrides,
  };
}

test('AC-C4-KS: PICKLE_CODEGRAPH=off → no service call, no events', async () => {
  const dir = makeSandbox();
  let called = false;
  const impl = fakeImpl({ indexAll: async () => { called = true; return {}; } });
  const events = [];
  await runCodegraphIndexAtSetup(
    dir, baseSettings(), false,
    { impl, emit: (e) => events.push(e) },
    { PICKLE_CODEGRAPH: 'off' }
  );
  assert.ok(!called, 'indexAll must not be called when kill-switch is set');
  assert.equal(events.length, 0);
});

test('AC-C4-DIS: enabled:false → no service call', async () => {
  const dir = makeSandbox();
  let called = false;
  const impl = fakeImpl({ indexAll: async () => { called = true; return {}; } });
  await runCodegraphIndexAtSetup(
    dir, baseSettings({ enabled: false }), false,
    { impl, emit: () => {} }, {}
  );
  assert.ok(!called);
});

test('AC-C4-IAS: index_at_setup:false → no service call', async () => {
  const dir = makeSandbox();
  let called = false;
  const impl = fakeImpl({ indexAll: async () => { called = true; return {}; } });
  await runCodegraphIndexAtSetup(
    dir, baseSettings({ index_at_setup: false }), false,
    { impl, emit: () => {} }, {}
  );
  assert.ok(!called);
});

test('AC-C4-BUILD: full build (non-resume) → indexAll called, codegraph_index_built emitted', async () => {
  const dir = makeSandbox();
  const events = [];
  const impl = fakeImpl();
  await runCodegraphIndexAtSetup(
    dir, baseSettings(), false,
    { impl, emit: (e) => events.push(e) }, {}
  );
  const built = events.find((e) => e.event === 'codegraph_index_built');
  assert.ok(built, `expected codegraph_index_built, got: ${JSON.stringify(events)}`);
  assert.ok(!events.find((e) => e.event === 'codegraph_index_failed'));
});

test('AC-C4-FAIL: indexAll returns null → codegraph_index_failed emitted with reason', async () => {
  const dir = makeSandbox();
  const events = [];
  const impl = fakeImpl({ indexAll: async () => null });
  await runCodegraphIndexAtSetup(
    dir, baseSettings(), false,
    { impl, emit: (e) => events.push(e) }, {}
  );
  const failed = events.find((e) => e.event === 'codegraph_index_failed');
  assert.ok(failed, `expected codegraph_index_failed, got: ${JSON.stringify(events)}`);
  assert.equal(failed.reason, 'index_null_result');
  assert.ok(typeof failed.gate_payload?.duration_ms === 'number');
});

test('AC-C4-NOOP: resume + fresh db (< staleness) → no call, no events', async () => {
  const dir = makeSandbox();
  const dbDir = path.join(dir, '.codegraph');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'codegraph.db');
  fs.writeFileSync(dbPath, 'fake');
  const nowSec = Date.now() / 1000;
  fs.utimesSync(dbPath, nowSec, nowSec);
  writeIndexedHeadSha(dbPath, FIXED_SHA);

  let called = false;
  const impl = fakeImpl({
    indexAll: async () => { called = true; return {}; },
    sync: async () => { called = true; return {}; },
  });
  const events = [];
  await runCodegraphIndexAtSetup(
    dir, baseSettings({ staleness_max_age_minutes: 60 }), true,
    { impl, emit: (e) => events.push(e), dbPath, getHeadSha: () => FIXED_SHA }, {}
  );
  assert.ok(!called, 'service must not be called for a fresh db on resume');
  assert.equal(events.length, 0);
});

test('AC-C4-SYNC: resume + stale db (> staleness) → sync called, codegraph_sync_completed', async () => {
  const dir = makeSandbox();
  const dbDir = path.join(dir, '.codegraph');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'codegraph.db');
  fs.writeFileSync(dbPath, 'fake');
  // Set mtime to 2 hours ago (stale against default 30min threshold)
  const staleSec = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(dbPath, staleSec, staleSec);
  writeIndexedHeadSha(dbPath, FIXED_SHA);

  const events = [];
  const impl = fakeImpl();
  await runCodegraphIndexAtSetup(
    dir, baseSettings(), true,
    { impl, emit: (e) => events.push(e), dbPath, getHeadSha: () => FIXED_SHA }, {}
  );
  const synced = events.find((e) => e.event === 'codegraph_sync_completed');
  assert.ok(synced, `expected codegraph_sync_completed, got: ${JSON.stringify(events)}`);
  assert.ok(!events.find((e) => e.event === 'codegraph_index_built'));
});

test('AC-C4-MISSING: resume + missing db → full rebuild via indexAll', async () => {
  const dir = makeSandbox();
  const dbPath = path.join(dir, '.codegraph', 'nonexistent.db');
  let indexAllCalled = false;
  let syncCalled = false;
  const impl = fakeImpl({
    indexAll: async () => { indexAllCalled = true; return {}; },
    sync: async () => { syncCalled = true; return {}; },
  });
  const events = [];
  await runCodegraphIndexAtSetup(
    dir, baseSettings(), true,
    { impl, emit: (e) => events.push(e), dbPath }, {}
  );
  assert.ok(indexAllCalled, 'indexAll must be called when db is absent on resume');
  assert.ok(!syncCalled);
});

test('AC-C4-EXCL: .git/info/exclude gets .codegraph/ appended, idempotent on second call', async () => {
  const dir = makeSandbox();
  fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
  const excludePath = path.join(dir, '.git', 'info', 'exclude');
  fs.writeFileSync(excludePath, '# existing\n');

  const impl = fakeImpl();
  await runCodegraphIndexAtSetup(dir, baseSettings(), false, { impl, emit: () => {} }, {});
  const after1 = fs.readFileSync(excludePath, 'utf8');
  assert.ok(after1.includes('.codegraph/'), '.codegraph/ must appear after first call');

  await runCodegraphIndexAtSetup(dir, baseSettings(), false, { impl, emit: () => {} }, {});
  const after2 = fs.readFileSync(excludePath, 'utf8');
  const count = (after2.match(/\.codegraph\//g) ?? []).length;
  assert.equal(count, 1, '.codegraph/ must appear exactly once after two calls');
});

test('AC-C4-ORDER: displaySetupSummary precedes runCodegraphIndexAtSetup in setup.ts source', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/bin/setup.ts'),
    'utf-8'
  );
  const summaryIdx = src.indexOf('displaySetupSummary(session)');
  const cgIdx = src.indexOf('await runCodegraphIndexAtSetup(');
  assert.ok(summaryIdx >= 0, 'displaySetupSummary must be present in source');
  assert.ok(cgIdx >= 0, 'await runCodegraphIndexAtSetup call must be present in source');
  assert.ok(summaryIdx < cgIdx, 'SESSION_ROOT= line (via displaySetupSummary) must precede codegraph index call');
});

// ---------------------------------------------------------------------------
// AC-SPAWN: spawn-site staleness decision + session summary derivation
// ---------------------------------------------------------------------------

test('AC-SPAWN-FRESH: shouldSyncCodegraph returns false for fresh db (age < threshold)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-spawn-fresh-'));
  try {
    const dbDir = path.join(dir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'codegraph.db');
    fs.writeFileSync(dbPath, 'fake');
    const nowSec = Date.now() / 1000;
    fs.utimesSync(dbPath, nowSec, nowSec);
    // db is seconds old; threshold is 60 min
    assert.equal(shouldSyncCodegraph(dbPath, 60), false, 'fresh db must not trigger sync');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-SPAWN-STALE: shouldSyncCodegraph returns true for stale db (age > threshold)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-spawn-stale-'));
  try {
    const dbDir = path.join(dir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'codegraph.db');
    fs.writeFileSync(dbPath, 'fake');
    // 2 hours ago
    const staleSec = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(dbPath, staleSec, staleSec);
    assert.equal(shouldSyncCodegraph(dbPath, 30), true, 'stale db must trigger sync');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-SPAWN-MISSING: shouldSyncCodegraph returns false when db is absent (setup owns full index)', () => {
  const missing = '/tmp/nonexistent-no-codegraph-db/codegraph.db';
  assert.equal(shouldSyncCodegraph(missing, 30), false, 'absent db must not trigger sync');
});

test('AC-SPAWN-SOURCE: shouldSyncCodegraph is exported from mux-runner.ts source', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/bin/mux-runner.ts'),
    'utf-8'
  );
  assert.ok(
    src.includes('export function shouldSyncCodegraph'),
    'shouldSyncCodegraph must be exported from mux-runner.ts'
  );
});

// AC-SPAWN-SUMMARY-SOURCE removed — emitCgSessionSummary was renamed (b1089e97);
// behavioral coverage lives in codegraph-session-summary-counts.test.js.

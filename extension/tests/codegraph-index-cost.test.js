// @tier: fast
//
// CGH-4: codegraph index cost + staleness correctness.
//
// Covers:
//   CGH4-T1: codegraph_index_built carries gate_payload.{files_indexed, duration_ms}
//   CGH4-T2: warm resume with fresh DB → noop (neither indexAll nor sync called)
//   CGH4-T3: warm resume with stale DB → sync called, indexAll NOT called
//   CGH4-T4: cold launch (!isResume) → indexAll called, codegraph_index_built emitted, fail-open on timeout
//   CGH4-T5: concurrent busy DB (locked) → codegraph_degraded emitted, setup does not throw

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');

const { CodegraphService, writeIndexedHeadSha } = await import(path.join(EXTENSION_ROOT, 'services/codegraph-service.js'));
const { runCodegraphIndexAtSetup } = await import(path.join(EXTENSION_ROOT, 'bin/setup.js'));

const FIXED_SHA = 'abc123fixedsha';

// --- cleanup -----------------------------------------------------------------

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function makeTmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cgh4-'));
  tmpDirs.push(d);
  return d;
}

// --- helpers -----------------------------------------------------------------

function cgSettings(overrides = {}) {
  return {
    enabled: true,
    index_at_setup: true,
    staleness_max_age_minutes: 30,
    context_max_bytes: 8192,
    expose_mcp_to_workers: false,
    index_timeout_ms: 5_000,
    sync_timeout_ms: 5_000,
    query_timeout_ms: 5_000,
    ...overrides,
  };
}

function fakeImpl(overrides = {}) {
  return {
    indexAll: async () => ({ filesIndexed: 3 }),
    sync: async () => ({ filesChecked: 3 }),
    searchNodes: () => [],
    getCallers: () => [],
    getImpactRadius: () => [],
    buildContext: async () => '',
    close: () => {},
    ...overrides,
  };
}

function harness(settings, deps = {}) {
  const events = [];
  const svc = CodegraphService.create('/tmp/repo', settings, {
    emit: (e) => events.push(e),
    now: () => new Date().toISOString(),
    env: {},
    ...deps,
  });
  return { svc, events };
}

function createFreshDb(workDir) {
  const cgDir = path.join(workDir, '.codegraph');
  fs.mkdirSync(cgDir, { recursive: true });
  const dbPath = path.join(cgDir, 'codegraph.db');
  fs.writeFileSync(dbPath, '');
  return dbPath;
}

function createStaleDb(workDir, staleMins = 60) {
  const dbPath = createFreshDb(workDir);
  const staleMs = Date.now() - staleMins * 60 * 1_000;
  const staleDate = new Date(staleMs);
  fs.utimesSync(dbPath, staleDate, staleDate);
  return dbPath;
}

// --- tests -------------------------------------------------------------------

// CGH4-T1: codegraph_index_built carries gate_payload.{files_indexed, duration_ms}
test('CGH4-T1: indexAll emits gate_payload with files_indexed and duration_ms', async () => {
  const impl = fakeImpl({ indexAll: async () => ({ filesIndexed: 7 }) });
  const settings = {
    enabled: true,
    index_at_setup: false, // not testing setup path here — test service directly
    staleness_max_age_minutes: 30,
    context_max_bytes: 8192,
    expose_mcp_to_workers: false,
    index_timeout_ms: 5_000,
    sync_timeout_ms: 5_000,
    query_timeout_ms: 5_000,
  };
  const { svc, events } = harness(settings, { impl });
  await svc.indexAll();

  const built = events.find((e) => e.event === 'codegraph_index_built');
  assert.ok(built, 'codegraph_index_built must be emitted');
  assert.ok(built.gate_payload, 'codegraph_index_built must carry gate_payload');
  assert.equal(typeof built.gate_payload.duration_ms, 'number', 'gate_payload.duration_ms must be a number');
  assert.ok(built.gate_payload.duration_ms >= 0, 'gate_payload.duration_ms must be >= 0');
  assert.equal(built.gate_payload.files_indexed, 7, 'gate_payload.files_indexed must match upstream filesIndexed');
});

// CGH4-T1b: duration_ms present even when upstream returns no filesIndexed
test('CGH4-T1b: gate_payload.duration_ms present even when upstream has no filesIndexed', async () => {
  const impl = fakeImpl({ indexAll: async () => ({}) }); // no filesIndexed
  const settings = cgSettings({ index_at_setup: false });
  const { svc, events } = harness(settings, { impl });
  await svc.indexAll();

  const built = events.find((e) => e.event === 'codegraph_index_built');
  assert.ok(built, 'codegraph_index_built must be emitted');
  assert.ok(built.gate_payload, 'must carry gate_payload');
  assert.equal(typeof built.gate_payload.duration_ms, 'number', 'duration_ms must be present');
  assert.equal(built.gate_payload.files_indexed, undefined, 'files_indexed must be absent when upstream returns none');
});

// CGH4-T2: warm resume with fresh DB → noop (action='noop') → neither indexAll nor sync called
test('CGH4-T2: warm resume with fresh DB → noop — no indexAll or sync called', async () => {
  const workDir = makeTmp();
  const dbPath = createFreshDb(workDir);
  writeIndexedHeadSha(dbPath, FIXED_SHA); // sha matches current HEAD (WS-B1 ground truth)

  let indexAllCalled = false;
  let syncCalled = false;
  const impl = fakeImpl({
    indexAll: async () => { indexAllCalled = true; return {}; },
    sync: async () => { syncCalled = true; return {}; },
  });
  const events = [];

  await runCodegraphIndexAtSetup(
    workDir,
    cgSettings({ staleness_max_age_minutes: 30 }),
    /* isResume */ true,
    { impl, emit: (e) => events.push(e), getHeadSha: () => FIXED_SHA },
    {},
  );

  assert.ok(!indexAllCalled, 'indexAll must NOT be called on warm resume with fresh DB (action=noop)');
  assert.ok(!syncCalled, 'sync must NOT be called on warm resume with fresh DB (action=noop)');
  const builtEvents = events.filter((e) => e.event === 'codegraph_index_built' || e.event === 'codegraph_sync_completed');
  assert.equal(builtEvents.length, 0, 'no index-built or sync-completed event on noop');
});

// CGH4-T3: warm resume with stale DB → sync called (action='sync'), indexAll NOT called
test('CGH4-T3: warm resume with stale DB → sync called, indexAll NOT called (action=sync)', async () => {
  const workDir = makeTmp();
  const dbPath = createStaleDb(workDir, 60); // 60 min old → stale vs 30-min threshold
  writeIndexedHeadSha(dbPath, FIXED_SHA); // sha matches current HEAD (WS-B1 ground truth)

  let indexAllCalled = false;
  let syncCalled = false;
  const impl = fakeImpl({
    indexAll: async () => { indexAllCalled = true; return {}; },
    sync: async () => { syncCalled = true; return {}; },
  });
  const events = [];

  await runCodegraphIndexAtSetup(
    workDir,
    cgSettings({ staleness_max_age_minutes: 30 }),
    /* isResume */ true,
    { impl, emit: (e) => events.push(e), getHeadSha: () => FIXED_SHA },
    {},
  );

  assert.ok(!indexAllCalled, 'indexAll must NOT be called on stale-resume (action=sync, not full)');
  assert.ok(syncCalled, 'sync must be called on warm resume with stale DB');
  // action was 'sync' — this is in {'noop','sync'}, never 'full'
  const syncEvent = events.find((e) => e.event === 'codegraph_sync_completed');
  assert.ok(syncEvent, 'codegraph_sync_completed must be emitted on stale warm resume');
});

// CGH4-T4a: cold launch (!isResume) → indexAll called, codegraph_index_built emitted (action='full')
test('CGH4-T4a: cold launch → indexAll called, codegraph_index_built emitted (action=full)', async () => {
  const workDir = makeTmp();

  let indexAllCalled = false;
  const impl = fakeImpl({ indexAll: async () => { indexAllCalled = true; return { filesIndexed: 4 }; } });
  const events = [];

  await runCodegraphIndexAtSetup(
    workDir,
    cgSettings(),
    /* isResume */ false,
    { impl, emit: (e) => events.push(e) },
    {},
  );

  assert.ok(indexAllCalled, 'indexAll must be called on cold launch (action=full)');
  const built = events.find((e) => e.event === 'codegraph_index_built');
  assert.ok(built, 'codegraph_index_built must be emitted');
  assert.ok(built.gate_payload, 'event must carry gate_payload');
  assert.equal(typeof built.gate_payload.duration_ms, 'number', 'gate_payload.duration_ms present');
  assert.equal(built.gate_payload.files_indexed, 4, 'gate_payload.files_indexed from upstream');
});

// CGH4-T4b: cold launch with slow impl → timeout fires, no throw (fail-open)
test('CGH4-T4b: cold launch with impl that times out → fail-open, no throw', async () => {
  const workDir = makeTmp();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const impl = fakeImpl({
    indexAll: async () => {
      await sleep(200); // longer than index_timeout_ms=5
      return {};
    },
  });
  const events = [];

  // Must not throw — fail-open
  await assert.doesNotReject(
    () => runCodegraphIndexAtSetup(
      workDir,
      cgSettings({ index_timeout_ms: 5 }),
      /* isResume */ false,
      { impl, emit: (e) => events.push(e) },
      {},
    ),
    'runCodegraphIndexAtSetup must not throw on timeout (fail-open)',
  );

  const degraded = events.find((e) => e.event === 'codegraph_degraded');
  assert.ok(degraded, 'codegraph_degraded must be emitted on timeout');
  assert.equal(degraded.reason, 'timeout', 'degraded reason must be timeout');
});

// CGH4-T5: concurrent busy DB (DB locked) → codegraph_degraded emitted, setup does not throw
test('CGH4-T5: busy DB (locked) → codegraph_degraded emitted, setup does not block', async () => {
  const workDir = makeTmp();

  const impl = fakeImpl({
    indexAll: async () => { throw new Error('database is locked'); },
  });
  const events = [];

  await assert.doesNotReject(
    () => runCodegraphIndexAtSetup(
      workDir,
      cgSettings(),
      /* isResume */ false,
      { impl, emit: (e) => events.push(e) },
      {},
    ),
    'runCodegraphIndexAtSetup must not throw on locked DB (fail-open)',
  );

  const degraded = events.find((e) => e.event === 'codegraph_degraded');
  assert.ok(degraded, 'codegraph_degraded must be emitted when DB is locked');
  assert.equal(degraded.reason, 'locked', 'degraded reason must be locked for "database is locked" error');
});

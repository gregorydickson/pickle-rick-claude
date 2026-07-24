// @tier: fast
//
// AC-STALE: shouldSyncCodegraph — pure staleness-decision function exported from mux-runner.
// Injectable now/statSync seams; no filesystem side-effects.
//
// AC-GTRUTH-B1: WS-B1 HEAD-sha ground truth for the SEPARATE setup.ts codegraph index-freshness
// gate (`cgResolveIndexAction`, exercised via `runCodegraphIndexAtSetup`). Distinct mechanism from
// `shouldSyncCodegraph` above (that one backs the WS-B2 phase-transition sync, out of scope here).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { shouldSyncCodegraph } = await import(
  path.resolve(__dirname, '../bin/mux-runner.js')
);
const { runCodegraphIndexAtSetup } = await import(
  path.resolve(__dirname, '../bin/setup.js')
);
const { writeIndexedHeadSha } = await import(
  path.resolve(__dirname, '../services/codegraph-service.js')
);

const DB = '/fake/.codegraph/codegraph.db';

test('AC-STALE-STALE: stale db (age > threshold) → returns true', () => {
  const now = () => 1_000_000;
  const statSync = () => ({ mtimeMs: 1_000_000 - (31 * 60 * 1000) }); // 31 min old
  assert.equal(shouldSyncCodegraph(DB, 30, now, statSync), true);
});

test('AC-STALE-FRESH: fresh db (age < threshold) → returns false', () => {
  const now = () => 1_000_000;
  const statSync = () => ({ mtimeMs: 1_000_000 - (5 * 60 * 1000) }); // 5 min old
  assert.equal(shouldSyncCodegraph(DB, 30, now, statSync), false);
});

test('AC-STALE-MISSING: statSync throws (db absent) → returns false', () => {
  const now = () => 1_000_000;
  const statSync = () => { throw new Error('ENOENT'); };
  assert.equal(shouldSyncCodegraph(DB, 30, now, statSync), false);
});

test('AC-STALE-BOUNDARY: age === threshold (exact boundary) → returns true (>= semantics)', () => {
  const now = () => 1_000_000;
  const thresholdMs = 30 * 60 * 1000;
  const statSync = () => ({ mtimeMs: 1_000_000 - thresholdMs });
  assert.equal(shouldSyncCodegraph(DB, 30, now, statSync), true);
});

test('AC-STALE-ZERO: threshold=0 → always stale for any present db', () => {
  const now = () => 1_000_000;
  const statSync = () => ({ mtimeMs: 1_000_000 - 1 }); // 1ms old
  assert.equal(shouldSyncCodegraph(DB, 0, now, statSync), true);
});

test('AC-STALE-INJECTION: injected now + statSync are used (no real fs)', () => {
  let nowCalled = false;
  let statCalled = false;
  const now = () => { nowCalled = true; return 1_000_000; };
  const statSync = () => { statCalled = true; return { mtimeMs: 0 }; };
  shouldSyncCodegraph(DB, 30, now, statSync);
  assert.ok(nowCalled, 'injected now must be called');
  assert.ok(statCalled, 'injected statSync must be called');
});

// --- AC-GTRUTH-B1: setup.ts cgResolveIndexAction HEAD-sha ground truth ------------------------

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function makeGtruthTmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gtruth-b1-'));
  tmpDirs.push(d);
  return d;
}

function gtruthSettings(overrides = {}) {
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

function gtruthImpl(overrides = {}) {
  let indexAllCalled = false;
  let syncCalled = false;
  const impl = {
    indexAll: async () => { indexAllCalled = true; return {}; },
    sync: async () => { syncCalled = true; return {}; },
    close: () => {},
    ...overrides,
  };
  return { impl, calls: () => ({ indexAllCalled, syncCalled }) };
}

function createDb(workDir, ageMinutes = 0) {
  const cgDir = path.join(workDir, '.codegraph');
  fs.mkdirSync(cgDir, { recursive: true });
  const dbPath = path.join(cgDir, 'codegraph.db');
  fs.writeFileSync(dbPath, '');
  if (ageMinutes > 0) {
    const staleDate = new Date(Date.now() - ageMinutes * 60 * 1000);
    fs.utimesSync(dbPath, staleDate, staleDate);
  }
  return dbPath;
}

// AC-GTRUTH-B1-1a: cold repo (no db) → full, regardless of sha deps.
test('AC-GTRUTH-B1-1a: cold repo (no db) → full — indexAll called', async () => {
  const workDir = makeGtruthTmp();
  const { impl, calls } = gtruthImpl();

  await runCodegraphIndexAtSetup(
    workDir,
    gtruthSettings(),
    /* isResume */ true,
    { impl, emit: () => {}, getHeadSha: () => 'shouldnt-matter' },
    {},
  );

  assert.equal(calls().indexAllCalled, true, 'cold repo (no db) must resolve full → indexAll called');
});

// AC-GTRUTH-B1-1b: db present, but no sha sidecar persisted → treat as mismatch → full.
test('AC-GTRUTH-B1-1b: db present with NO sha metadata → full (missing metadata = mismatch)', async () => {
  const workDir = makeGtruthTmp();
  createDb(workDir, 0); // fresh mtime, no sha sidecar written
  const { impl, calls } = gtruthImpl();

  await runCodegraphIndexAtSetup(
    workDir,
    gtruthSettings(),
    /* isResume */ true,
    { impl, emit: () => {}, getHeadSha: () => 'current-head-sha' },
    {},
  );

  assert.equal(calls().indexAllCalled, true, 'missing indexed-sha metadata must resolve full, never noop/sync');
  assert.equal(calls().syncCalled, false, 'sync must not be called when metadata is missing');
});

// AC-GTRUTH-B1-2: sha match + fresh mtime → noop; sha match + stale mtime → sync.
test('AC-GTRUTH-B1-2a: sha match + fresh mtime → noop — neither indexAll nor sync called', async () => {
  const workDir = makeGtruthTmp();
  const dbPath = createDb(workDir, 0);
  writeIndexedHeadSha(dbPath, 'same-sha');
  const { impl, calls } = gtruthImpl();

  await runCodegraphIndexAtSetup(
    workDir,
    gtruthSettings({ staleness_max_age_minutes: 30 }),
    /* isResume */ true,
    { impl, emit: () => {}, getHeadSha: () => 'same-sha' },
    {},
  );

  assert.deepEqual(calls(), { indexAllCalled: false, syncCalled: false }, 'sha-match + fresh mtime must noop');
});

test('AC-GTRUTH-B1-2b: sha match + stale mtime → sync — indexAll NOT called', async () => {
  const workDir = makeGtruthTmp();
  const dbPath = createDb(workDir, 60); // 60min old vs 30min threshold
  writeIndexedHeadSha(dbPath, 'same-sha');
  const { impl, calls } = gtruthImpl();

  await runCodegraphIndexAtSetup(
    workDir,
    gtruthSettings({ staleness_max_age_minutes: 30 }),
    /* isResume */ true,
    { impl, emit: () => {}, getHeadSha: () => 'same-sha' },
    {},
  );

  assert.equal(calls().indexAllCalled, false, 'sha-match + stale mtime must NOT trigger full reindex');
  assert.equal(calls().syncCalled, true, 'sha-match + stale mtime must sync');
});

// AC-GTRUTH-B1-3: the branch-switch regression — sha mismatch + FRESH mtime must resolve full,
// NEVER noop. This is the exact bug the PRD calls out: a 10-minute-old db built on a different
// branch must not silently feed workers phantom context.
test('AC-GTRUTH-B1-3: sha mismatch (different-branch db) + fresh mtime → full, NEVER noop', async () => {
  const workDir = makeGtruthTmp();
  const dbPath = createDb(workDir, 0); // fresh mtime — mtime-only logic would have said noop
  writeIndexedHeadSha(dbPath, 'old-branch-sha');
  const { impl, calls } = gtruthImpl();

  await runCodegraphIndexAtSetup(
    workDir,
    gtruthSettings({ staleness_max_age_minutes: 30 }),
    /* isResume */ true,
    { impl, emit: () => {}, getHeadSha: () => 'new-branch-sha' },
    {},
  );

  assert.equal(calls().indexAllCalled, true, 'a sha-mismatch must resolve full (never noop) even with a fresh mtime');
});

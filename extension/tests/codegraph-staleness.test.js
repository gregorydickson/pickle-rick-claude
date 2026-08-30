// @tier: fast
//
// AC-STALE: shouldSyncCodegraph — pure staleness-decision function exported from mux-runner.
// Injectable now/statSync seams; no filesystem side-effects.
//
// AC-GTRUTH-B1: WS-B1 HEAD-sha ground truth for the setup.ts codegraph index-freshness gate
// (`cgResolveIndexAction`, exercised via `runCodegraphIndexAtSetup`). A distinct mechanism from
// `shouldSyncCodegraph` above, which backs the WS-B2 per-spawn sync.
//
// AP-EXT-ITER116-01: the two are distinct MECHANISMS but answer ONE question — "does this db
// describe the current tree?" — and now share the same ground truth. WS-B1 deferred
// `shouldSyncCodegraph` ("out of scope here", as this header used to say); that deferral is closed.

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
const { writeIndexedHeadSha, CodegraphService } = await import(
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

// AC-GTRUTH-B1-4: the sidecar describes the db AT `dbPath`, so it must not outlive a db that
// corruption-quarantine renamed away. `CodeGraph.init()` indexes only when passed `options.index`
// (data/codegraph-api-inventory.json) and `defaultLoadImpl` passes none — so the rebuilt db is
// EMPTY. A surviving sidecar then makes `cgResolveIndexAction` read sha-match + fresh mtime and
// resolve `noop`, and every worker queries an empty graph with no degrade signal.
function corruptOnIndexImpl() {
  return {
    indexAll: async () => { throw new Error('database disk image is malformed'); },
    sync: async () => ({}),
    buildContext: async () => ({}),
    close: () => {},
  };
}

function rebuiltImpl() {
  return { indexAll: async () => ({}), sync: async () => ({}), buildContext: async () => ({}), close: () => {} };
}

test('AC-GTRUTH-B1-4: corruption-quarantine must not orphan the sha sidecar → next setup resolves full, never noop', async () => {
  const workDir = makeGtruthTmp();
  const dbPath = createDb(workDir, 0);
  writeIndexedHeadSha(dbPath, 'same-sha'); // the db really was indexed at this sha

  // Drive a corrupt-classified op through the DEFAULT quarantine (real fs.renameSync) — every
  // pre-existing quarantine fixture injects `deps.quarantine`, so this path had zero coverage.
  const svc = CodegraphService.create(workDir, gtruthSettings(), {
    impl: corruptOnIndexImpl(),
    emit: () => {},
    rebuild: async () => rebuiltImpl(),
    withFileLock: async (fn) => fn(),
    getHeadSha: () => 'same-sha',
  });
  await svc.indexAll();

  assert.equal(fs.existsSync(dbPath), false, 'precondition: the corrupt db was renamed aside');
  fs.writeFileSync(dbPath, ''); // the rebuild's init() re-creates an EMPTY db at the same path

  const { impl, calls } = gtruthImpl();
  await runCodegraphIndexAtSetup(
    workDir,
    gtruthSettings({ staleness_max_age_minutes: 30 }),
    /* isResume */ true,
    { impl, emit: () => {}, getHeadSha: () => 'same-sha' },
    {},
  );

  assert.equal(
    calls().indexAllCalled,
    true,
    'a rebuilt-empty index must resolve full; a surviving sidecar makes it noop over an EMPTY graph',
  );
});

// --- AP-EXT-ITER116-01: WS-B1 ground truth reaches the PER-SPAWN sync too ----------------------
//
// WS-B1 (9c7f1f10) gated setup.ts's `cgResolveIndexAction` on HEAD-sha ground truth and left
// `shouldSyncCodegraph` — the per-spawn sync decision — on the superseded mtime-only rule, an
// explicit deferral recorded in this file's own header. A fresh mtime proves only that the db was
// WRITTEN recently: every commit the pipeline lands invalidates the index without touching its
// mtime, so a known-stale index read as fresh for the whole staleness window and every worker
// spawned in it queried a graph describing an older tree.
//
// Fixture convention matches AC-GTRUTH-B1 above: real tmpdir, real db file, real sidecar via
// `writeIndexedHeadSha` (so the default `readIndexedHeadSha` is genuinely exercised), with only
// the git resolver injected to keep the tier subprocess-free.

function makeSyncFixture(ageMinutes, indexedSha) {
  const workDir = makeGtruthTmp();
  const dbPath = createDb(workDir, ageMinutes);
  if (indexedSha !== null) writeIndexedHeadSha(dbPath, indexedSha);
  return { workDir, dbPath };
}

test('AP-EXT-ITER116-01: fresh mtime + HEAD moved → sync (mtime alone reported it fresh)', () => {
  const { workDir, dbPath } = makeSyncFixture(0, 'indexed-at-sha');
  assert.equal(
    shouldSyncCodegraph(dbPath, 30, Date.now, fs.statSync, {
      workingDir: workDir,
      getCurrentSha: () => 'head-moved-sha',
    }),
    true,
    'a db indexed at a different HEAD is stale no matter how recently it was written',
  );
});

test('AP-EXT-ITER116-01: fresh mtime + sha match → no sync (fix must not sync every spawn)', () => {
  const { workDir, dbPath } = makeSyncFixture(0, 'same-sha');
  assert.equal(
    shouldSyncCodegraph(dbPath, 30, Date.now, fs.statSync, {
      workingDir: workDir,
      getCurrentSha: () => 'same-sha',
    }),
    false,
    'sha match + fresh mtime must still noop — sync() advances the sidecar, so the decision converges',
  );
});

test('AP-EXT-ITER116-01: fresh mtime + no sidecar → no sync (unresolvable is not evidence)', () => {
  const { workDir, dbPath } = makeSyncFixture(0, null); // no sidecar written
  assert.equal(
    shouldSyncCodegraph(dbPath, 30, Date.now, fs.statSync, {
      workingDir: workDir,
      getCurrentSha: () => 'head-sha',
    }),
    false,
    'an absent indexed-sha cannot prove a mismatch; the mtime bound stands alone',
  );
});

test('AP-EXT-ITER116-01: fresh mtime + mismatch but NO workingDir → no sync (legacy callers)', () => {
  const { dbPath } = makeSyncFixture(0, 'indexed-at-sha');
  assert.equal(
    shouldSyncCodegraph(dbPath, 30, Date.now, fs.statSync, { getCurrentSha: () => 'head-moved-sha' }),
    false,
    'without a workingDir the current HEAD is unresolvable, so mtime decides alone',
  );
});

test('AP-EXT-ITER116-01: stale mtime + sha match → sync (mtime bound survives the fix)', () => {
  const { workDir, dbPath } = makeSyncFixture(60, 'same-sha'); // 60min vs 30min threshold
  let shaProbed = false;
  assert.equal(
    shouldSyncCodegraph(dbPath, 30, Date.now, fs.statSync, {
      workingDir: workDir,
      getCurrentSha: () => { shaProbed = true; return 'same-sha'; },
    }),
    true,
    'the age ceiling still forces a sync even when the index is at the current HEAD',
  );
  assert.equal(shaProbed, false, 'a stale mtime short-circuits before the git probe — no cost on the hot path');
});

test('AP-EXT-ITER116-01: db absent + sha mismatch → no sync (full index is setup\'s job)', () => {
  const workDir = makeGtruthTmp();
  const dbPath = path.join(workDir, '.codegraph', 'codegraph.db'); // never created
  assert.equal(
    shouldSyncCodegraph(dbPath, 30, Date.now, fs.statSync, {
      workingDir: workDir,
      getCurrentSha: () => 'head-moved-sha',
    }),
    false,
    'the db-absent contract is unchanged: a missing db routes to setup, never to a per-spawn sync',
  );
});

test('AP-EXT-ITER116-01: fresh mtime + unresolvable HEAD (non-repo) → no sync', () => {
  const { workDir, dbPath } = makeSyncFixture(0, 'indexed-at-sha');
  assert.equal(
    shouldSyncCodegraph(dbPath, 30, Date.now, fs.statSync, {
      workingDir: workDir,
      getCurrentSha: () => null, // defaultGetHeadSha's documented non-repo / git-absent result
    }),
    false,
    'a null current HEAD cannot prove a mismatch — the sha arm must not read "unresolvable" as "stale"',
  );
});

test('AP-EXT-ITER116-01: fresh mtime + throwing sha resolver → no sync (hot path stays fail-open)', () => {
  const { workDir, dbPath } = makeSyncFixture(0, 'indexed-at-sha');
  assert.equal(
    shouldSyncCodegraph(dbPath, 30, Date.now, fs.statSync, {
      workingDir: workDir,
      getCurrentSha: () => { throw new Error('git exploded'); },
    }),
    false,
    'a throwing resolver must never escape into the per-spawn path',
  );
});

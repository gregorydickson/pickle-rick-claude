// @tier: expensive
// SERIAL: the C0/C7 `serve --mcp` handshake spawns a child process and is heavier than a typical
// expensive-tier case (60s hang-guard timeout); under expensive-tier concurrency it flakes
// (B-V2RG P3 / E9a), so it is listed in tests/integration/.serial-tests.json to run serialized.
//
// C0 spike (ticket 46097c46): real-surface validation of @colbymchenry/codegraph@0.9.9.
//
// Exercises the REAL library against tiny tmp fixture repos and asserts result
// shapes against the PRD API contracts recorded in
// extension/data/codegraph-api-inventory.json. Any surface mismatch (a renamed
// method, a Promise that became sync, a Map that became an array) throws so the
// spike fails LOUDLY — downstream tickets (C1/C5/C6/C7/C9) must not build on a
// fictional API.
//
// Gated on RUN_EXPENSIVE_TESTS=1. The programmatic API ships inside a per-platform
// optionalDependency (@colbymchenry/codegraph-<platform>-<arch>); when that bundle
// is not installed (a CI host that did not fetch it) the suite skips cleanly — but
// ONLY for that documented "platform bundle not installed" condition. Every other
// error propagates.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { buildWorkerMcpConfig } from '../../services/backend-spawn.js';

const require = createRequire(import.meta.url);
const EXPENSIVE = process.env.RUN_EXPENSIVE_TESTS === '1';
const TEST_TIMEOUT_MS = 240_000;
const HANDSHAKE_TIMEOUT_MS = 150_000;
const INVENTORY_PATH = path.resolve(import.meta.dirname, '../../data/codegraph-api-inventory.json');

// Load the library, or return a skip reason when (and only when) the per-platform
// bundle is genuinely absent. A surface mismatch must never be swallowed here.
function loadCodeGraphOrSkipReason() {
  try {
    return { mod: require('@colbymchenry/codegraph'), skip: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/platform bundle|is not installed|not available because/i.test(msg)) {
      return { mod: null, skip: `platform bundle not installed: ${msg.split('\n')[0]}` };
    }
    throw err;
  }
}

function makeFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-spike-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

test('C0: real init/index/query surface matches PRD contracts on a populated fixture', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  if (!EXPENSIVE) return t.skip('set RUN_EXPENSIVE_TESTS=1');
  const { mod, skip } = loadCodeGraphOrSkipReason();
  if (skip) return t.skip(skip);
  const { CodeGraph, getDatabasePath } = mod;
  assert.equal(typeof CodeGraph.init, 'function', 'CodeGraph.init must exist');
  assert.equal(typeof getDatabasePath, 'function', 'getDatabasePath export must exist');

  const dir = makeFixture({
    'src/a.ts': 'export function helper(x: number): number { return x + 1; }\n'
      + 'export function main(): number { return helper(41); }\n',
  });
  let cg;
  try {
    cg = await CodeGraph.init(dir);
    assert.ok(cg instanceof CodeGraph, 'init resolves to a CodeGraph instance');

    // indexAll — async, IndexResult shape.
    const idx = await cg.indexAll();
    assert.equal(idx.success, true, 'indexAll success');
    assert.equal(typeof idx.filesIndexed, 'number', 'IndexResult.filesIndexed');
    assert.equal(typeof idx.nodesCreated, 'number', 'IndexResult.nodesCreated');
    assert.ok(idx.nodesCreated > 0, 'fixture produced nodes');
    assert.ok(Array.isArray(idx.errors), 'IndexResult.errors is an array');
    assert.equal(typeof idx.durationMs, 'number', 'IndexResult.durationMs');

    // DB at .codegraph/codegraph.db, and getDatabasePath agrees.
    const expectedDb = path.join(dir, '.codegraph', 'codegraph.db');
    assert.ok(fs.existsSync(expectedDb), 'db exists at .codegraph/codegraph.db');
    assert.equal(getDatabasePath(dir), expectedDb, 'getDatabasePath resolves the same path');

    // searchNodes — SYNC, SearchResult[] of {node, score}.
    const results = cg.searchNodes('helper');
    assert.ok(Array.isArray(results), 'searchNodes returns an array (sync)');
    assert.ok(results.length > 0, 'searchNodes found the fixture symbol');
    const top = results[0];
    assert.equal(typeof top.score, 'number', 'SearchResult.score is a number');
    assert.equal(typeof top.node.id, 'string', 'SearchResult.node.id');
    assert.equal(typeof top.node.name, 'string', 'SearchResult.node.name');
    assert.equal(typeof top.node.kind, 'string', 'SearchResult.node.kind');
    assert.equal(typeof top.node.filePath, 'string', 'SearchResult.node.filePath');

    const fnNode = (results.find((r) => r.node.kind === 'function') || top).node;

    // getCallers — SYNC, Array<{node, edge}>.
    const callers = cg.getCallers(fnNode.id);
    assert.ok(Array.isArray(callers), 'getCallers returns an array (sync)');
    for (const c of callers) {
      assert.ok(c.node && typeof c.node.id === 'string', 'caller entry has node');
      assert.ok(c.edge && typeof c.edge.kind === 'string', 'caller entry has edge');
    }

    // getImpactRadius — SYNC, Subgraph with nodes:Map, edges:[], roots:[].
    const impact = cg.getImpactRadius(fnNode.id);
    assert.ok(impact.nodes instanceof Map, 'Subgraph.nodes is a Map (NOT an array)');
    assert.ok(Array.isArray(impact.edges), 'Subgraph.edges is an array');
    assert.ok(Array.isArray(impact.roots), 'Subgraph.roots is an array');

    // buildContext — async; default format 'markdown' returns a string; the
    // object form is TaskContext. Accept the documented union.
    const ctx = await cg.buildContext('what does helper do');
    if (typeof ctx === 'string') {
      assert.ok(ctx.length > 0, 'buildContext markdown string is non-empty');
    } else {
      assert.equal(typeof ctx.query, 'string', 'TaskContext.query');
      assert.ok(ctx.subgraph && ctx.subgraph.nodes instanceof Map, 'TaskContext.subgraph');
      assert.ok(Array.isArray(ctx.entryPoints), 'TaskContext.entryPoints');
    }

    // getStats — populated.
    assert.ok(cg.getStats().nodeCount > 0, 'getStats().nodeCount > 0');
  } finally {
    if (cg) assert.equal(cg.close(), undefined, 'close() is sync and returns void');
    rmDir(dir);
  }
});

test('C0: empty-repo fixture yields 0 nodes / null with no throw', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  if (!EXPENSIVE) return t.skip('set RUN_EXPENSIVE_TESTS=1');
  const { mod, skip } = loadCodeGraphOrSkipReason();
  if (skip) return t.skip(skip);
  const { CodeGraph } = mod;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-spike-empty-'));
  let cg;
  try {
    cg = await CodeGraph.init(dir);
    const idx = await cg.indexAll();
    assert.equal(idx.filesIndexed, 0, 'empty repo indexes 0 files');
    assert.equal(idx.nodesCreated, 0, 'empty repo creates 0 nodes');
    assert.equal(cg.getStats().nodeCount, 0, 'empty repo stats nodeCount 0');
    assert.equal(cg.getNode('does-not-exist'), null, 'getNode returns null for missing id');
    const search = cg.searchNodes('anything');
    assert.ok(Array.isArray(search) && search.length === 0, 'searchNodes returns [] on empty repo');
  } finally {
    if (cg) cg.close();
    rmDir(dir);
  }
});

test('C0: serve --mcp stdio handshake (initialize -> tools/list) via absolute node bin', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  if (!EXPENSIVE) return t.skip('set RUN_EXPENSIVE_TESTS=1');
  const { skip } = loadCodeGraphOrSkipReason();
  if (skip) return t.skip(skip);

  // The package `exports` map forbids subpath resolution of the bin, so resolve
  // via the (exported) package.json, then join with bin.codegraph. ABSOLUTE path.
  const pkgJsonPath = require.resolve('@colbymchenry/codegraph/package.json');
  const binAbs = path.join(path.dirname(pkgJsonPath), require(pkgJsonPath).bin.codegraph);
  assert.ok(path.isAbsolute(binAbs), 'resolved bin path is absolute');

  const dir = makeFixture({ 'src/a.ts': 'export function f() { return 1; }\n' });
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binAbs, 'serve', '--mcp'], {
      cwd: dir,
      env: { ...process.env, CODEGRAPH_NO_WATCH: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    let stage = 0;
    let initResult = null;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
      reject(new Error(`handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms (stage ${stage})`));
    }, HANDSHAKE_TIMEOUT_MS);
    const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
    const finish = (fn) => { clearTimeout(timer); try { child.kill('SIGKILL'); } catch { /* best effort */ } fn(); };

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && stage === 0) {
          stage = 1;
          initResult = msg.result;
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2) {
          finish(() => resolve({ initResult, tools: msg.result && msg.result.tools }));
          return;
        }
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pickle-spike', version: '0.0.0' } },
    });
  });
  rmDir(dir);

  assert.ok(result.initResult, 'initialize returned a result');
  assert.ok(result.initResult.serverInfo, 'initialize result has serverInfo');
  assert.ok(result.initResult.protocolVersion, 'initialize result has protocolVersion');
  assert.ok(Array.isArray(result.tools), 'tools/list returned a tools array');
  assert.ok(result.tools.length >= 1, 'tools/list is non-empty');
  for (const tool of result.tools) {
    assert.equal(typeof tool.name, 'string', 'each tool has a string name');
  }
});

test('C7: buildWorkerMcpConfig command drives a real serve --mcp handshake (initialize -> tools/list)', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  if (!EXPENSIVE) return t.skip('set RUN_EXPENSIVE_TESTS=1');
  const { skip } = loadCodeGraphOrSkipReason();
  if (skip) return t.skip(skip);

  // Non-vacuous coupling: instead of re-deriving the bin independently, drive the
  // EXACT command that the production builder materializes into worker-mcp.json.
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wmm-session-'));
  const fixtureDir = makeFixture({ 'src/a.ts': 'export function f() { return 1; }\n' });

  const mcpPath = buildWorkerMcpConfig(sessionDir, fixtureDir, { expose_mcp_to_workers: true }, null);
  // When the package resolves (it does on EXPENSIVE hosts that loaded the bundle)
  // the builder writes the session file; if it ever can't, skip rather than fail.
  if (!mcpPath || !fs.existsSync(mcpPath)) {
    rmDir(sessionDir);
    rmDir(fixtureDir);
    return t.skip('buildWorkerMcpConfig did not materialize a session config (codegraph bin unresolved)');
  }
  const entry = JSON.parse(fs.readFileSync(mcpPath, 'utf8')).mcpServers.codegraph;
  assert.equal(entry.command, 'node', 'materialized codegraph command is node');
  assert.ok(path.isAbsolute(entry.args[0]), 'materialized bin path is absolute');
  assert.deepEqual(entry.args.slice(-2), ['serve', '--mcp'], 'materialized args end with serve --mcp');

  const result = await new Promise((resolve, reject) => {
    const child = spawn(entry.command, entry.args, {
      cwd: entry.cwd,
      env: { ...process.env, ...entry.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    let stage = 0;
    let initResult = null;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
      reject(new Error(`handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms (stage ${stage})`));
    }, HANDSHAKE_TIMEOUT_MS);
    const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
    const finish = (fn) => { clearTimeout(timer); try { child.kill('SIGKILL'); } catch { /* best effort */ } fn(); };

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && stage === 0) {
          stage = 1;
          initResult = msg.result;
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2) {
          finish(() => resolve({ initResult, tools: msg.result && msg.result.tools }));
          return;
        }
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pickle-wmm', version: '0.0.0' } },
    });
  });
  rmDir(sessionDir);
  rmDir(fixtureDir);

  assert.ok(result.initResult && result.initResult.serverInfo, 'initialize result has serverInfo');
  assert.ok(Array.isArray(result.tools) && result.tools.length >= 1, 'tools/list is non-empty');
});

test('C0: committed inventory exists and its method surface matches the real class', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  if (!EXPENSIVE) return t.skip('set RUN_EXPENSIVE_TESTS=1');
  // The inventory JSON itself is a committed artifact — verify it parses and is
  // shaped as C1 expects (every method entry carries a boolean `async`).
  assert.ok(fs.existsSync(INVENTORY_PATH), 'codegraph-api-inventory.json exists');
  const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8'));
  assert.equal(typeof inventory.indexAll.async, 'boolean', 'inventory.indexAll.async is boolean');
  assert.ok(inventory.serve, 'inventory has a serve finding');
  assert.equal(inventory.serve.watcher_disableable, true, 'serve.watcher_disableable recorded');

  const { mod, skip } = loadCodeGraphOrSkipReason();
  if (skip) return t.skip(skip);
  const { CodeGraph } = mod;
  // Every inventoried instance/static method MUST exist on the real surface, or a
  // future version bump silently drifts the recorded contract.
  const real = new Set([
    ...Object.getOwnPropertyNames(CodeGraph.prototype),
    ...Object.getOwnPropertyNames(CodeGraph),
  ]);
  for (const [name, entry] of Object.entries(inventory)) {
    if (name === '_meta' || name === 'serve') continue;
    assert.ok(real.has(name), `inventoried method '${name}' must exist on the real CodeGraph surface`);
    assert.equal(typeof entry.async, 'boolean', `inventory.${name}.async is boolean`);
  }
});

// R-CGBOOT (2026-07-11): the service must BOOTSTRAP a never-initialized repo.
// defaultLoadImpl preferred CodeGraph.open() unconditionally; open() throws
// "Run init() first" when no .codegraph db exists, so index_at_setup could never
// create the first index (live incident: enabled-window trial, session
// 2026-07-11-86dd509f — indexAll -> null, codegraph_degraded load/error).
test('R-CGBOOT: CodegraphService.indexAll bootstraps a never-initialized dir (open-throws -> init fallback)', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  if (!EXPENSIVE) return t.skip('RUN_EXPENSIVE_TESTS!=1');
  const { skip } = loadCodeGraphOrSkipReason();
  if (skip) return t.skip(skip);
  const { CodegraphService } = await import('../../services/codegraph-service.js');
  const dir = makeFixture({
    'src/alpha.ts': 'export function alpha(): number { return 1; }\n',
    'src/beta.ts': "import { alpha } from './alpha.js';\nexport const beta = () => alpha() + 1;\n",
  });
  const events = [];
  try {
    const svc = CodegraphService.create(dir, {
      enabled: true, index_at_setup: true, index_timeout_ms: 120000, sync_timeout_ms: 30000,
      query_timeout_ms: 5000, staleness_max_age_minutes: 30, context_max_bytes: 8192,
      expose_mcp_to_workers: false,
    }, { emit: (e) => events.push(e) });
    const result = await svc.indexAll();
    svc.close();
    const loadDegrades = events.filter((e) => e.event === 'codegraph_degraded' && e.operation === 'load');
    assert.notEqual(result, null, 'indexAll must bootstrap-init a fresh dir, not return null');
    assert.equal(loadDegrades.length, 0, `no load-degrade expected, got: ${JSON.stringify(loadDegrades)}`);
    assert.ok(fs.existsSync(path.join(dir, '.codegraph')), '.codegraph db dir created by bootstrap');
  } finally {
    rmDir(dir);
  }
});

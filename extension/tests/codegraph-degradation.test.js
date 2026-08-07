// @tier: fast
//
// CGH-5: codegraph graceful-degradation fixtures.
// Prove fail-open for every reachable failure mode + kill-switch full short-circuit.
// MCP-merge-fail leg omitted: unreachable while expose_mcp_to_workers:false.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');

const { CodegraphService } = await import(path.join(EXTENSION_ROOT, 'services/codegraph-service.js'));
const { runCodegraphIndexAtSetup } = await import(path.join(EXTENSION_ROOT, 'bin/setup.js'));
const { runCodegraphQueryBatch } = await import(path.join(EXTENSION_ROOT, 'services/codegraph-query-runner.js'));
const { buildCodegraphContextSection } = await import(path.join(EXTENSION_ROOT, 'bin/spawn-morty.js'));
const { writeActivityEntry } = await import(path.join(EXTENSION_ROOT, 'services/state-manager.js'));

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

// An impl where every operation fails — simulates a broken/unavailable binary.
function brokenImpl(errorMessage) {
  const fail = async () => { throw new Error(errorMessage); };
  const failSync = () => { throw new Error(errorMessage); };
  return {
    indexAll: fail,
    sync: fail,
    buildContext: fail,
    searchNodes: failSync,
    getCallers: failSync,
    getImpactRadius: failSync,
    close: () => {},
  };
}

// --- describe.each([['index-failure'],['binary-unresolvable'],['read-only-fs']]) ---
//
// AC-CGH-5-1: parametrized loop over all reachable degradation modes.
// Each scenario asserts:
//   1. runCodegraphIndexAtSetup completes without throwing (fail-open)
//   2. codegraph_degraded emitted at least once during setup
//   3. buildContext returns null → no '## Code Graph Context' injected to worker

const FAILURE_CASES = [
  ['index-failure'],
  ['binary-unresolvable'],
  ['read-only-fs'],
];

for (const [mode] of FAILURE_CASES) {
  test(`fail-open[${mode}]: setup completes, codegraph_degraded emitted, no context injected`, async () => {
    const events = [];
    const emit = (e) => events.push(e);

    let deps;
    if (mode === 'binary-unresolvable') {
      // Binary not found: loadImpl returns null every time.
      // Inject sleep no-op to bypass MCP_STARTUP_BACKOFF_MS delays (500ms + 1500ms)
      // so the 3-attempt retry loop stays within fast-tier budget.
      deps = {
        impl: null,
        loadImpl: async () => null,
        sleep: async () => {},
        emit,
        now: () => 'TS',
        env: {},
      };
    } else {
      const errorMsg = mode === 'read-only-fs'
        ? "EACCES: permission denied, open '.codegraph/codegraph.db'"
        : 'codegraph indexAll: internal error';
      deps = {
        impl: brokenImpl(errorMsg),
        emit,
        now: () => 'TS',
        env: {},
      };
    }

    // 1. Setup must not throw (fail-open).
    await assert.doesNotReject(
      () => runCodegraphIndexAtSetup(
        '/tmp/cgh5-fake-workdir',
        cgSettings(),
        /* isResume */ false,
        deps,
        {}, // env: not PICKLE_CODEGRAPH=off — exercise actual failure path
      ),
      `runCodegraphIndexAtSetup must not throw on ${mode} (fail-open)`,
    );

    // 2. codegraph_degraded must be emitted at least once during setup.
    const degraded = events.filter((e) => e.event === 'codegraph_degraded');
    assert.ok(degraded.length >= 1, `codegraph_degraded must be emitted for ${mode}`);

    // 3. buildContext must return null (no '## Code Graph Context' injected).
    // Fresh service instance with same failure deps; index_at_setup:false avoids
    // double-running indexAll just to reach buildContext.
    const ctxEvents = [];
    const svcDeps = { ...deps, emit: (e) => ctxEvents.push(e) };
    const svc = CodegraphService.create(
      '/tmp/cgh5-fake-workdir',
      cgSettings({ index_at_setup: false }),
      svcDeps,
    );
    const ctx = await svc.buildContext({ title: 'ticket task', description: 'some description' });
    assert.equal(ctx, null, `buildContext must return null (degraded) for ${mode}`);
  });
}

// --- PICKLE_CODEGRAPH=off: kill-switch fully short-circuits --- AC-CGH-5-3

test('PICKLE_CODEGRAPH=off: zero events, no native bundle load, buildContext and indexAll return null', async () => {
  const events = [];
  let loadImplCalled = false;

  const killSwitchEnv = { PICKLE_CODEGRAPH: 'off' };
  const deps = {
    impl: null,
    loadImpl: async () => { loadImplCalled = true; return null; },
    emit: (e) => events.push(e),
    now: () => 'TS',
    env: killSwitchEnv,
  };

  // runCodegraphIndexAtSetup early-returns on PICKLE_CODEGRAPH=off (5th param).
  await assert.doesNotReject(
    () => runCodegraphIndexAtSetup(
      '/tmp/cgh5-fake-workdir',
      cgSettings(),
      /* isResume */ false,
      deps,
      killSwitchEnv,
    ),
    'runCodegraphIndexAtSetup must not throw with PICKLE_CODEGRAPH=off',
  );

  assert.equal(events.length, 0, 'PICKLE_CODEGRAPH=off: zero codegraph activity events from setup');
  assert.equal(loadImplCalled, false, 'PICKLE_CODEGRAPH=off: native bundle must never be loaded during setup');

  // The service itself is also fully inert under the kill-switch (deps.env carries it).
  const svc = CodegraphService.create(
    '/tmp/cgh5-fake-workdir',
    cgSettings({ index_at_setup: false }),
    deps,
  );

  const ctx = await svc.buildContext({ title: 'ticket task', description: 'some description' });
  assert.equal(ctx, null, 'PICKLE_CODEGRAPH=off: buildContext must return null (inert)');

  const idx = await svc.indexAll();
  assert.equal(idx, null, 'PICKLE_CODEGRAPH=off: indexAll must return null (inert)');

  assert.equal(events.length, 0, 'PICKLE_CODEGRAPH=off: zero codegraph activity events from any service call');
  assert.equal(loadImplCalled, false, 'PICKLE_CODEGRAPH=off: native bundle must never be loaded from service calls');
});

// --- AC-CGH-A1: killable-subprocess query boundary ---------------------------
//
// The spawn-path queries run behind a `detached` child that is GROUP-killed on
// timeout (the vendored bin spawns the native binary as a grandchild; a plain
// child `timeout` would leak it). These three tests cover the wedge, the crash,
// and the spawn-path degrade-persist wiring.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freshSession() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cg-degrade-'));
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ schema_version: 5, active: true, activity: [] }));
  return dir;
}

function readActivity(sessionDir) {
  const state = JSON.parse(readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
  return Array.isArray(state.activity) ? state.activity : [];
}

// A wedge fixture: the runner spawns THIS as its child. It spawns a hanging
// grandchild tagged with the marker (visible to `ps`), then hangs itself. Both
// self-exit after 30s so a failed group-kill never leaks past the test run.
function writeWedgeFixture(marker) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cg-wedge-'));
  const file = path.join(dir, 'wedge-child.cjs');
  writeFileSync(
    file,
    [
      "const { spawn } = require('node:child_process');",
      `const marker = process.env.CG_TEST_MARKER || ${JSON.stringify(marker)};`,
      // Grandchild: hangs, marker in argv so `ps -o command=` can find it.
      "spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0), 30000)', marker], { stdio: 'ignore' });",
      // Child hangs — never writes stdout, never exits within the timeout window.
      'setTimeout(() => process.exit(0), 30000);',
      '',
    ].join('\n'),
  );
  return file;
}

const CG_TITLE = 'Inject `searchNodes` context';
const CG_CONTENT = '---\nid: t1\n---\n# body uses `searchNodes`';

test('AC1 wedge: query_timeout skip within the aggregate bound, NO surviving child/grandchild', async () => {
  const sessionDir = freshSession();
  const marker = `CGWEDGE_${process.pid}_${Date.now()}`;
  const fixture = writeWedgeFixture(marker);
  const settings = cgSettings({ query_timeout_ms: 1500, index_at_setup: false });

  const service = CodegraphService.create('/tmp/cg-wedge-wd', settings, {
    // Inject the REAL runner but point it at the wedge fixture + tag the env so the
    // grandchild is greppable. The service group-kills on timeout.
    runQueryBatch: (input, ms) => runCodegraphQueryBatch(input, {
      timeoutMs: ms,
      childScriptPath: fixture,
      env: { ...process.env, CG_TEST_MARKER: marker },
    }),
  });

  const t0 = Date.now();
  const section = await buildCodegraphContextSection({
    tier: 'medium', title: CG_TITLE, ticketContent: CG_CONTENT,
    service, settings, sessionDir, ticketId: 't1',
  });
  const elapsed = Date.now() - t0;

  assert.equal(section, '', 'wedge must yield an empty section');
  // Aggregate bound: one batch race at query_timeout_ms (1500) + spawn/settle overhead.
  assert.ok(elapsed < 6000, `wedge must return bounded, got ${elapsed}ms`);

  const skipped = readActivity(sessionDir).filter((e) => e.event === 'codegraph_context_skipped');
  assert.equal(skipped.length, 1, 'exactly one skip event');
  assert.equal(skipped[0].reason, 'query_timeout', 'reason must be query_timeout');

  // Let the group SIGTERM propagate, then prove no marked process survived.
  await sleep(700);
  const psOut = execFileSync('ps', ['-A', '-o', 'command='], { encoding: 'utf-8' });
  assert.ok(!psOut.includes(marker), 'group-kill must leave NO surviving child/grandchild');
});

test('AC2 crash: query_failed skip + codegraph_degraded with a distinct open reason', async () => {
  const sessionDir = freshSession();
  const degradeEvents = [];
  const settings = cgSettings({ index_at_setup: false });
  const service = CodegraphService.create('/tmp/cg-crash-wd', settings, {
    emit: (e) => degradeEvents.push(e),
    runQueryBatch: async () => ({ status: 'failed', reason: 'shim-exit-1' }),
  });

  const section = await buildCodegraphContextSection({
    tier: 'medium', title: CG_TITLE, ticketContent: CG_CONTENT,
    service, settings, sessionDir, ticketId: 't1',
  });

  assert.equal(section, '', 'crash must yield an empty section');
  const skipped = readActivity(sessionDir).filter((e) => e.event === 'codegraph_context_skipped');
  assert.equal(skipped.length, 1, 'exactly one skip event');
  assert.equal(skipped[0].reason, 'query_failed', 'reason must be query_failed');

  const degraded = degradeEvents.filter((e) => e.event === 'codegraph_degraded');
  assert.ok(degraded.length >= 1, 'a codegraph_degraded must be emitted for the failure');
  assert.equal(degraded[0].reason, 'shim-exit-1', 'degrade reason is the distinct open string');
});

test('AC3 degrade persists to state.json.activity via the emit dep (spawn-path wiring)', async () => {
  const sessionDir = freshSession();
  const statePath = path.join(sessionDir, 'state.json');
  const settings = cgSettings({ index_at_setup: false });

  // Mirror the spawn-morty call-site cgEmit closure: CodegraphEmitEvent → ActivityLogEntry.
  const emit = (event) => {
    const entry = { event: event.event, ts: event.ts };
    if (event.reason) { entry.reason = event.reason; }
    if (event.operation || event.gate_payload) {
      entry.gate_payload = {
        ...(event.operation ? { operation: event.operation } : {}),
        ...(event.gate_payload ?? {}),
      };
    }
    writeActivityEntry(statePath, entry);
  };

  const service = CodegraphService.create('/tmp/cg-a3-wd', settings, {
    emit,
    runQueryBatch: async () => ({ status: 'failed', reason: 'enoent' }),
  });

  const result = await service.runQueryBatch(['x'], []);
  assert.equal(result.status, 'failed', 'runner failure flows through');

  const degraded = readActivity(sessionDir).filter((e) => e.event === 'codegraph_degraded');
  assert.ok(degraded.length >= 1, 'codegraph_degraded must persist to state.json.activity via emit dep');
  assert.equal(degraded[0].gate_payload.operation, 'query', 'operation stamped in gate_payload');
  assert.equal(degraded[0].reason, 'enoent', 'open reason string persisted');
});

// A round-trip fixture: the runner spawns THIS as its child. It reads the batch input from
// stdin, echoes a deterministic ok-result carrying full node/score/file/line + caller shapes,
// then exits 0 — exercising the REAL parent transport (stdin write → child stdout → JSON.parse)
// without the SDK. The prior three tests only cover timeout/failure; none reaches status:'ok'.
function writeRoundTripFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cg-roundtrip-'));
  const file = path.join(dir, 'roundtrip-child.cjs');
  writeFileSync(
    file,
    [
      "let raw = '';",
      "process.stdin.on('data', (c) => { raw += c; });",
      "process.stdin.on('end', () => {",
      '  const input = JSON.parse(raw);',
      '  const searches = {};',
      '  for (const term of input.searches || []) {',
      "    searches[term] = [{ node: { id: 'id-' + term, name: term + 'Fn', file: 'src/' + term + '.ts', line: 42 }, score: 7.5 }];",
      '  }',
      '  const callers = {};',
      '  for (const id of input.callers || []) {',
      "    callers[id] = [{ node: { id: 'c-' + id, name: id + 'Caller' } }];",
      '  }',
      '  process.stdout.write(JSON.stringify({ searches, callers }));',
      '  process.exit(0);',
      '});',
      '',
    ].join('\n'),
  );
  return file;
}

test('round-trip: real runner resolves status=ok with node/score/file/line preserved field-for-field across the subprocess JSON boundary', async () => {
  const fixture = writeRoundTripFixture();
  // timeoutMs is a generous hang-guard for a fast echo child — never a perf assertion, and
  // never shrunk below the wedge test's own bound (serial-manifest hygiene, AC-R-ITIH-4).
  const result = await runCodegraphQueryBatch(
    { workingDir: '/tmp/cg-roundtrip-wd', searches: ['foo', 'bar'], callers: ['n1'] },
    { timeoutMs: 5000, childScriptPath: fixture },
  );

  assert.equal(result.status, 'ok', 'a successful batch must resolve status=ok');
  assert.deepEqual(Object.keys(result.searches).sort(), ['bar', 'foo'], 'every requested term round-trips a key');

  const fooHit = result.searches.foo[0];
  assert.equal(fooHit.score, 7.5, 'score survives the JSON boundary');
  assert.equal(fooHit.node.id, 'id-foo', 'node.id survives');
  assert.equal(fooHit.node.name, 'fooFn', 'node.name survives');
  assert.equal(fooHit.node.file, 'src/foo.ts', 'node.file survives');
  assert.equal(fooHit.node.line, 42, 'node.line survives');

  const barHit = result.searches.bar[0];
  assert.equal(barHit.node.name, 'barFn', 'second term round-trips independently');
  assert.equal(barHit.node.file, 'src/bar.ts');

  assert.deepEqual(
    result.callers.n1,
    [{ node: { id: 'c-n1', name: 'n1Caller' } }],
    'caller entries round-trip field-for-field',
  );
});

// A large-payload round-trip fixture: emits a batch whose serialized JSON far exceeds the
// OS pipe buffer (~64KB), then exits inside the stdout write callback (the fixed runChild
// shape). A bare `write(...); process.exit(0)` would truncate the un-drained tail and the
// parent's JSON.parse would throw `unparseable-stdout`. This drives the REAL parent
// transport so a multi-chunk stdout must reassemble whole.
function writeLargePayloadFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cg-large-'));
  const file = path.join(dir, 'large-child.cjs');
  writeFileSync(
    file,
    [
      "let raw = '';",
      "process.stdin.on('data', (c) => { raw += c; });",
      "process.stdin.on('end', () => {",
      '  const input = JSON.parse(raw);',
      '  const searches = {};',
      "  const blob = 'x'.repeat(4096);", // 4KB per hit → 256 hits ≈ 1MB, well past the pipe buffer
      '  for (const term of input.searches || []) {',
      '    searches[term] = Array.from({ length: 256 }, (_, i) => ({',
      "      node: { id: term + '-' + i, name: term + 'Fn' + i, blob }, score: i,",
      '    }));',
      '  }',
      '  process.stdout.write(JSON.stringify({ searches, callers: {} }), () => process.exit(0));',
      '});',
      '',
    ].join('\n'),
  );
  return file;
}

test('R-CGST large-payload round-trip: >64KB batch reassembles intact (no exit-truncation)', async () => {
  const fixture = writeLargePayloadFixture();
  const result = await runCodegraphQueryBatch(
    { workingDir: '/tmp/cg-large-wd', searches: ['alpha'], callers: [] },
    { timeoutMs: 5000, childScriptPath: fixture },
  );

  assert.equal(result.status, 'ok', 'a large batch must not degrade to unparseable-stdout');
  assert.equal(result.searches.alpha.length, 256, 'every hit in the large payload survives the pipe boundary');
  const last = result.searches.alpha[255];
  assert.equal(last.node.id, 'alpha-255', 'the tail of a >64KB payload is not truncated');
  assert.equal(last.node.blob.length, 4096, 'the final hit payload arrives whole');
});

test('R-CGST source guard: runChild flushes stdout via the write callback before exit', () => {
  const src = readFileSync(
    path.join(EXTENSION_ROOT, 'src/services/codegraph-query-runner.ts'),
    'utf-8',
  );
  // The success-path exit MUST be the argument callback of process.stdout.write, so the
  // payload is drained to the pipe before the child exits. A bare `write(...); exit(0)`
  // truncates unflushed data on payloads larger than the OS pipe buffer.
  assert.match(
    src,
    /process\.stdout\.write\(\s*JSON\.stringify\(\{ searches, callers \}\),\s*\(\)\s*=>\s*\{/,
    'runChild must pass an exit callback to process.stdout.write',
  );
});

// A fixture that destroys its own stdin and then lingers: the parent's buffered write
// therefore breaks AFTER the synchronous `write()` call returns, which is the only shape
// that reaches the asynchronous 'error' event on `child.stdin`. Without a listener on that
// stream, node raises an uncaught exception in the PARENT process.
function writeStdinSlammerFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cg-epipe-'));
  const file = path.join(dir, 'stdin-slammer-child.cjs');
  writeFileSync(
    file,
    [
      // Close the read end without draining, then hold the process open briefly so the
      // parent's pending flush lands on a broken pipe rather than on an exited child.
      'process.stdin.destroy();',
      'setTimeout(() => process.exit(3), 500);',
      '',
    ].join('\n'),
  );
  return file;
}

test('AP-EXT-ITER5-01 async EPIPE on child stdin degrades to a result, never an uncaught parent exception', async () => {
  const fixture = writeStdinSlammerFixture();
  // A payload far past the OS pipe buffer (~64KB) guarantees the write cannot complete
  // synchronously, so the broken pipe can only surface as an async stream 'error'.
  const searches = Array.from({ length: 400 }, (_, i) => `term-${i}-${'q'.repeat(512)}`);

  const result = await runCodegraphQueryBatch(
    { workingDir: '/tmp/cg-epipe-wd', searches, callers: [] },
    { timeoutMs: 5000, childScriptPath: fixture },
  );

  assert.equal(result.status, 'failed', 'a child that never reads the batch must degrade, not resolve ok');
  assert.equal(result.reason, 'shim-exit-3', 'the child exit code is what classifies the failure');
  // Give any un-listened-for stream 'error' a tick to become an uncaught exception before
  // the test completes — node:test attributes it to this test and fails it.
  await new Promise((r) => setTimeout(r, 200));
});

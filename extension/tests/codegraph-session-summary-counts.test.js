// @tier: fast
//
// anatomy-park (extension subsystem) — regression for the b1089e97
// cross-process aggregation gap in `codegraph_session_summary`.
//
// Data flow under test:
//   buildCodegraphContextSection (spawn-morty PROCESS) → writeActivityEntry
//   → state.activity[] persisted to <sessionRoot>/state.json
//   → mux-runner PROCESS reads the same state.json at session end and emits
//     codegraph_session_summary { injected, skipped, ... }
//
// Bug: the summary derived injected/skipped from mux-runner's OWN in-memory
// CodegraphService counters. Those counters are only incremented by
// recordContextInjected/recordContextSkipped inside buildCodegraphContextSection,
// which runs ONLY in the per-spawn spawn-morty process — a different process with
// a different service instance. So mux-runner's counters were structurally always
// 0, and every codegraph_session_summary reported injected:0/skipped:0 regardless
// of how many context sections were actually injected.
//
// Fix: countCodegraphContextEvents reads the persisted activity log (ground truth
// shared across both processes) instead of the always-zero in-memory counters.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countCodegraphContextEvents, countCodegraphDegradedEvents, createCodegraphSession } from '../bin/mux-runner.js';
import { CodegraphService } from '../services/codegraph-service.js';
import { resolveCodegraphSettings } from '../services/pickle-utils.js';

describe('countCodegraphContextEvents (b1089e97 cross-process aggregation)', () => {
  it('counts persisted injected/skipped events from a realistic activity log', () => {
    // Shape mirrors what spawn-morty writes via writeActivityEntry: a mixed
    // activity stream across several ticket spawns, not just the two events.
    const activity = [
      { event: 'iteration_start', ts: '2026-06-14T19:00:00.000Z' },
      { event: 'codegraph_context_injected', ts: '2026-06-14T19:01:00.000Z', ticket: 'aaaa1111', tier: 'medium', terms_count: 4, hits_count: 7, bytes: 2048, build_ms: 12 },
      { event: 'codegraph_context_skipped', ts: '2026-06-14T19:02:00.000Z', reason: 'no_terms' },
      { event: 'manager_turn_progress', ts: '2026-06-14T19:02:30.000Z' },
      { event: 'codegraph_context_injected', ts: '2026-06-14T19:03:00.000Z', ticket: 'bbbb2222', tier: 'large', terms_count: 9, hits_count: 3, bytes: 4096, build_ms: 31 },
      { event: 'codegraph_context_skipped', ts: '2026-06-14T19:04:00.000Z', reason: 'zero_hits' },
      { event: 'codegraph_context_skipped', ts: '2026-06-14T19:05:00.000Z', reason: 'non_graph_tier' },
      { event: 'codegraph_context_injected', ts: '2026-06-14T19:06:00.000Z', ticket: 'cccc3333', tier: 'medium', terms_count: 2, hits_count: 5, bytes: 1024, build_ms: 8 },
    ];

    assert.deepEqual(countCodegraphContextEvents(activity), { injected: 3, skipped: 3 });
  });

  it('is the cross-process fix: persisted events count even when in-memory counters are 0', () => {
    // Simulates the real bug: mux-runner's CodegraphService never recorded any
    // injection (its counters would read injected:0), yet the shared state.json
    // activity log holds the spawn-morty-produced events. Counting from activity
    // must report the real number, NOT 0.
    const muxInMemoryCounters = { ops: 5, degraded: 0, latched: 0, injected: 0, skipped: 0 };
    const persistedActivity = [
      { event: 'codegraph_context_injected', ts: '2026-06-14T19:01:00.000Z', ticket: 'd1', tier: 'medium', terms_count: 1, hits_count: 1, bytes: 64, build_ms: 1 },
      { event: 'codegraph_context_injected', ts: '2026-06-14T19:02:00.000Z', ticket: 'd2', tier: 'medium', terms_count: 1, hits_count: 1, bytes: 64, build_ms: 1 },
    ];

    const derived = countCodegraphContextEvents(persistedActivity);
    assert.equal(derived.injected, 2, 'must reflect persisted events, not the always-zero in-memory counter');
    assert.notEqual(derived.injected, muxInMemoryCounters.injected, 'fix must NOT read the in-memory counter');
  });

  it('returns zeros for absent, empty, or non-codegraph activity', () => {
    assert.deepEqual(countCodegraphContextEvents(undefined), { injected: 0, skipped: 0 });
    assert.deepEqual(countCodegraphContextEvents([]), { injected: 0, skipped: 0 });
    assert.deepEqual(
      countCodegraphContextEvents([{ event: 'iteration_start', ts: '2026-06-14T19:00:00.000Z' }]),
      { injected: 0, skipped: 0 },
    );
  });

  it('tolerates malformed entries without throwing', () => {
    const activity = [
      null,
      undefined,
      {},
      { event: 'codegraph_context_injected', ts: '2026-06-14T19:01:00.000Z' },
    ];
    assert.deepEqual(countCodegraphContextEvents(activity), { injected: 1, skipped: 0 });
  });
});

// a53a1db1 F1: degraded_ops carried the SAME cross-process gap. The session summary read
// `getSessionCounters().degraded` (mux-runner's in-memory service, which only ever runs
// sync()), so every spawn-path query/buildContext degrade — emitted as codegraph_degraded
// into the shared state.json from the per-spawn spawn-morty process — was uncounted. The fix
// counts the persisted codegraph_degraded events (excluding the terminal `latch` emission,
// which the in-memory counter also excludes and which index_status surfaces separately).
describe('countCodegraphDegradedEvents (a53a1db1 cross-process aggregation)', () => {
  it('counts persisted codegraph_degraded events, excluding latch', () => {
    const activity = [
      { event: 'iteration_start', ts: '2026-07-11T19:00:00.000Z' },
      { event: 'codegraph_degraded', ts: '2026-07-11T19:01:00.000Z', reason: 'timeout', gate_payload: { operation: 'query' } },
      { event: 'codegraph_degraded', ts: '2026-07-11T19:02:00.000Z', reason: 'runner-threw', gate_payload: { operation: 'query' } },
      { event: 'codegraph_context_skipped', ts: '2026-07-11T19:02:30.000Z', reason: 'query_timeout' },
      { event: 'codegraph_degraded', ts: '2026-07-11T19:03:00.000Z', reason: 'error', gate_payload: { operation: 'buildContext' } },
      // latch is a terminal event surfaced via index_status:'latched'; it must NOT count as a
      // degraded op (the in-memory counter never incremented `degraded` for it either).
      { event: 'codegraph_degraded', ts: '2026-07-11T19:04:00.000Z', reason: 'error', gate_payload: { operation: 'latch' } },
    ];

    assert.equal(countCodegraphDegradedEvents(activity), 3);
  });

  it('is the cross-process fix: persisted degrades count even when the in-memory counter is 0', () => {
    // The bug: mux-runner's own CodegraphService only ran sync() (degraded:0 here), yet the
    // shared state.json holds spawn-path query degrades. Counting from activity must report
    // the real number, NOT the always-partial in-memory counter.
    const muxInMemoryCounters = { ops: 5, degraded: 0, latched: 0, injected: 0, skipped: 0 };
    const persistedActivity = [
      { event: 'codegraph_degraded', ts: '2026-07-11T19:01:00.000Z', reason: 'timeout', gate_payload: { operation: 'query' } },
      { event: 'codegraph_degraded', ts: '2026-07-11T19:02:00.000Z', reason: 'query-failed', gate_payload: { operation: 'query' } },
    ];

    const derived = countCodegraphDegradedEvents(persistedActivity);
    assert.equal(derived, 2, 'must reflect persisted spawn-path degrades, not the in-memory counter');
    assert.notEqual(derived, muxInMemoryCounters.degraded, 'fix must NOT read the in-memory counter');
  });

  it('counts codegraph_degraded with no gate_payload / no operation (non-latch) as a degrade', () => {
    const activity = [
      { event: 'codegraph_degraded', ts: '2026-07-11T19:01:00.000Z', reason: 'error' },
      { event: 'codegraph_degraded', ts: '2026-07-11T19:02:00.000Z', reason: 'error', gate_payload: {} },
    ];
    assert.equal(countCodegraphDegradedEvents(activity), 2);
  });

  it('returns 0 for absent, empty, or non-degraded activity, and tolerates malformed entries', () => {
    assert.equal(countCodegraphDegradedEvents(undefined), 0);
    assert.equal(countCodegraphDegradedEvents([]), 0);
    assert.equal(countCodegraphDegradedEvents([{ event: 'iteration_start', ts: '2026-07-11T19:00:00.000Z' }]), 0);
    assert.equal(countCodegraphDegradedEvents([null, undefined, {}, { event: 'codegraph_degraded', ts: '2026-07-11T19:01:00.000Z' }]), 1);
  });
});

// The two suites above prove the COUNTERS. They cannot prove the WIRING: both helpers
// are pure, so reverting the emit site to `ctrs.injected`/`ctrs.skipped`/`ctrs.degraded`
// — the exact b1089e97 + a53a1db1 bugs — leaves every assertion above GREEN. Until the
// session got a callable seam the emit site sat inside runMuxRunnerMain with nothing but
// a trap-door PATTERN_SHAPE grep over it, and a grep passes on unreachable code and fails
// on a reformat. These cases drive the REAL `emitSummary` through `createCodegraphSession`
// and read the payload back off the persisted state.json.
describe('createCodegraphSession.emitSummary (b1089e97 wiring)', () => {
  // A session whose PERSISTED activity and whose IN-MEMORY counters disagree on every
  // field, so each assertion below can only pass by reading the correct source.
  function makeDivergentSession() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cg-summary-'));
    const statePath = path.join(dir, 'state.json');
    writeFileSync(statePath, JSON.stringify({
      active: true,
      schema_version: 5,
      session_dir: dir,
      activity: [
        { event: 'iteration_start', ts: '2026-08-05T19:00:00.000Z' },
        { event: 'codegraph_context_injected', ts: '2026-08-05T19:01:00.000Z' },
        { event: 'codegraph_context_injected', ts: '2026-08-05T19:02:00.000Z' },
        { event: 'codegraph_context_skipped', ts: '2026-08-05T19:03:00.000Z', reason: 'zero_hits' },
        { event: 'codegraph_degraded', ts: '2026-08-05T19:04:00.000Z', reason: 'timeout', gate_payload: { operation: 'query' } },
        { event: 'codegraph_degraded', ts: '2026-08-05T19:05:00.000Z', reason: 'error', gate_payload: { operation: 'query' } },
        { event: 'codegraph_degraded', ts: '2026-08-05T19:06:00.000Z', reason: 'error', gate_payload: { operation: 'buildContext' } },
        // latch is surfaced via index_status, never as a degraded op.
        { event: 'codegraph_degraded', ts: '2026-08-05T19:07:00.000Z', reason: 'error', gate_payload: { operation: 'latch' } },
      ],
    }));

    // The mux-runner-side service: the real class, with the counters a real mux-runner
    // instance CANNOT have (they are only ever bumped in the spawn-morty process). Pumped
    // to wrong-but-plausible values so reading them is distinguishable from reading zero.
    const settings = resolveCodegraphSettings({ codegraph: { enabled: true } });
    const service = CodegraphService.create(dir, settings, {});
    for (let i = 0; i < 9; i += 1) service.recordContextInjected();
    for (let i = 0; i < 7; i += 1) service.recordContextSkipped();

    const session = createCodegraphSession({
      statePath,
      sessionDir: dir,
      workingDir: dir,
      log: () => {},
      deps: { resolveSettings: () => settings, createService: () => service },
    });
    return { dir, statePath, service, session };
  }

  function readSummary(statePath) {
    const entries = JSON.parse(readFileSync(statePath, 'utf8')).activity
      .filter((e) => e && e.event === 'codegraph_session_summary');
    assert.equal(entries.length, 1, 'emitSummary must append exactly one summary entry');
    return entries[0];
  }

  it('derives injected/skipped/degraded_ops from persisted activity, not the in-memory counters', async () => {
    const { dir, statePath, service, session } = makeDivergentSession();
    try {
      await session.init();
      session.emitSummary();

      const summary = readSummary(statePath);
      const ctrs = service.getSessionCounters();

      assert.equal(summary.injected, 2, 'injected must come from the persisted activity log');
      assert.equal(summary.skipped, 1, 'skipped must come from the persisted activity log');
      assert.equal(summary.degraded_ops, 3, 'degraded_ops must count persisted non-latch degrades');

      // The cross-process gap itself: mux-runner's own counters are a different
      // process's view and must not reach the payload.
      assert.notEqual(summary.injected, ctrs.injected, 'must NOT read the in-memory injected counter');
      assert.notEqual(summary.skipped, ctrs.skipped, 'must NOT read the in-memory skipped counter');
      assert.notEqual(summary.degraded_ops, ctrs.degraded, 'must NOT read the in-memory degraded counter');
    } finally {
      session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps index_status on the in-memory counters — the split is deliberate', async () => {
    const { dir, statePath, session } = makeDivergentSession();
    try {
      await session.init();
      session.emitSummary();

      // 3 persisted degrades, 0 in-memory: index_status is the long-lived health enum of
      // THIS process's service, so it stays 'healthy'. If it ever tracked persisted
      // degrades it would read 'degraded' here.
      assert.equal(readSummary(statePath).index_status, 'healthy');
    } finally {
      session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is fail-open: a session whose settings disable codegraph emits no summary', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cg-summary-off-'));
    const statePath = path.join(dir, 'state.json');
    writeFileSync(statePath, JSON.stringify({ active: true, schema_version: 5, session_dir: dir, activity: [] }));
    try {
      const session = createCodegraphSession({
        statePath,
        sessionDir: dir,
        workingDir: dir,
        log: () => {},
        deps: {
          resolveSettings: () => resolveCodegraphSettings({ codegraph: { enabled: false } }),
          createService: () => { throw new Error('createService must not run when codegraph is disabled'); },
        },
      });
      await session.init();
      session.emitSummary();
      session.close();

      const activity = JSON.parse(readFileSync(statePath, 'utf8')).activity;
      assert.deepEqual(activity.filter((e) => e && e.event === 'codegraph_session_summary'), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

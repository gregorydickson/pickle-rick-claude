// @tier: integration
/**
 * c6f44d6f (AC-R-WPEXA-11(b) + AC-R-WPEXA-5) — the large-tier POLL branch in
 * mux-runner.ts:runMuxRunnerMain. When a live state.detached_worker matches the
 * current ticket, the orchestrator POLLS it (liveness + re-pointed artifact
 * progress + large_tier_worker_poll) and yields — it NEVER re-spawns. A wedged
 * (alive-but-no-progress) detached worker still trips PICKLE_WMW_SKIP_K.
 *
 * Like the sibling large-tier-detached-spawn.test.js this exercises the seam at
 * the unit-of-contract level using the EXPORTED helpers, not by driving the full
 * mux loop. A tiny in-process driver replicates the poll-branch control flow:
 *   - spawn-morty is invoked ONLY when detached_worker is null (the T3 spawn
 *     branch's !state.detached_worker guard);
 *   - once detached_worker is set, every subsequent tick POLLS via
 *     recordWorkerArtifactProgress (re-pointed at the prior poll's stored count)
 *     and emits large_tier_worker_poll;
 *   - a wedged worker routes through routeDetachedWorkerTerminalNoProgress.
 *
 * PICKLE_RECOVERY_CONSOLIDATION=off makes routeRecoveryBeforeTerminal return
 * fall_through deterministically (no git ladder), so the wedge case lands on the
 * Failed/oversized_no_progress flip without hitting the host repo. Pure in-process
 * (no real subprocess), so this file needs no serial-tests entry.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateManager } from '../../services/state-manager.js';
import {
  recordWorkerArtifactProgress,
  countWorkerArtifacts,
  resolveWmwSkipK,
  routeDetachedWorkerTerminalNoProgress,
} from '../../bin/mux-runner.js';

const sm = new StateManager();

function makeSession(ticketId) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pickle-ltdp-'));
  const sessionDir = path.join(tmp, 'session');
  const ticketDir = path.join(sessionDir, ticketId);
  mkdirSync(ticketDir, { recursive: true });
  // A minimal large-tier ticket file (read by resolveCreditEarlyPhases / flip).
  writeFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`),
    `---\nid: ${ticketId}\nstatus: "In Progress"\ncomplexity_tier: large\n---\n# Ticket\n`);
  const statePath = path.join(sessionDir, 'state.json');
  writeFileSync(statePath, JSON.stringify({
    active: true, schema_version: 5, working_dir: tmp, step: 'implement',
    iteration: 0, max_iterations: 10, worker_timeout_seconds: 4800,
    start_time_epoch: Math.floor(Date.now() / 1000), original_prompt: 'test',
    session_dir: sessionDir, tmux_mode: false, backend: 'claude',
    current_ticket: ticketId, current_ticket_tier: 'large',
    detached_worker: null, worker_artifact_progress: {}, activity: [],
  }));
  return { tmp, sessionDir, ticketDir, statePath };
}

function addConformanceArtifact(ticketDir, n) {
  writeFileSync(path.join(ticketDir, `conformance_poll${n}.md`), `# conformance ${n}\n`);
}

function readState(statePath) {
  return JSON.parse(readFileSync(statePath, 'utf-8'));
}

/**
 * One tick of the poll-branch contract. Returns 'spawned' | 'polled' | 'flipped'.
 * Spawns ONLY when detached_worker is null (mirrors the T3 !detached_worker guard);
 * otherwise polls the live worker. `aliveFn` stubs isProcessAlive.
 */
function runPollTick(ctx) {
  const { sessionDir, statePath, ticketDir, ticketId, extensionRoot, spawnCounter } = ctx;
  const state = readState(statePath);

  if (!state.detached_worker) {
    // T3 spawn branch: spawn exactly once, persist the arm, continue.
    spawnCounter.count += 1;
    sm.update(statePath, s => {
      s.detached_worker = {
        worker_pid: 424242,
        ticket_id: ticketId,
        spawned_at_epoch: Date.now(),
        worker_log_path: path.join(ticketDir, 'worker_session_424242.log'),
      };
    });
    return 'spawned';
  }

  // Poll branch: re-point beforeCount at the PREVIOUS poll's stored count.
  const dw = state.detached_worker;
  const beforeCount = state.worker_artifact_progress?.[dw.ticket_id]?.last_artifact_count ?? 0;
  const pollProgress = recordWorkerArtifactProgress(statePath, sessionDir, dw.ticket_id, beforeCount, {
    iteration: state.iteration,
    workingDir: state.working_dir,
    // Deterministic signature so source-tree churn never masks a true zero delta.
    sourceSignatureFn: () => 'STATIC_SIG',
    creditEarlyPhases: false,
  });

  // Emit large_tier_worker_poll (the seam's writeActivityEntry, mirrored).
  sm.update(statePath, s => {
    s.activity.push({
      event: 'large_tier_worker_poll',
      ts: new Date().toISOString(),
      ticket: dw.ticket_id,
      gate_payload: { worker_pid: dw.worker_pid, ticket_id: dw.ticket_id },
    });
  });

  if (pollProgress.zeroProgressCount >= resolveWmwSkipK()) {
    const disp = routeDetachedWorkerTerminalNoProgress({
      sessionDir, statePath, extensionRoot, workingDir: state.working_dir,
      ticketId: dw.ticket_id, iteration: state.iteration,
      flags: null, log: () => {},
      progress: { spawnCount: pollProgress.spawnCount, zeroProgressCount: pollProgress.zeroProgressCount },
    });
    assert.equal(disp.action, 'continue', 'fall_through wedge flip yields continue');
    return 'flipped';
  }
  return 'polled';
}

test('AC-R-WPEXA-11(b): N polls over one live worker → exactly ONE spawn; poll emitted each poll', () => {
  const ticketId = 'pollabc01';
  const { tmp, sessionDir, ticketDir, statePath } = makeSession(ticketId);
  const spawnCounter = { count: 0 };
  const ctx = { sessionDir, statePath, ticketDir, ticketId, extensionRoot: tmp, spawnCounter };
  try {
    // Tick 1 spawns; ticks 2..6 must all POLL, never re-spawn. The worker keeps
    // landing artifacts so it is never wedged.
    assert.equal(runPollTick(ctx), 'spawned');
    for (let i = 1; i <= 5; i++) {
      addConformanceArtifact(ticketDir, i); // real forward progress before each poll
      const r = runPollTick(ctx);
      assert.equal(r, 'polled', `tick ${i + 1} must poll, not re-spawn/flip`);
    }
    assert.equal(spawnCounter.count, 1, 'exactly ONE spawn across all ticks');
    const polls = readState(statePath).activity.filter(e => e.event === 'large_tier_worker_poll');
    assert.equal(polls.length, 5, 'large_tier_worker_poll emitted once per poll');
    for (const p of polls) {
      assert.equal(p.gate_payload.worker_pid, 424242);
      assert.equal(p.gate_payload.ticket_id, ticketId);
      assert.ok(typeof p.ts === 'string');
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC-R-WPEXA-5: artifact count grows between polls → zero-progress streak resets on non-zero delta', () => {
  const ticketId = 'pollabc02';
  const { tmp, sessionDir, ticketDir, statePath } = makeSession(ticketId);
  const spawnCounter = { count: 0 };
  const ctx = { sessionDir, statePath, ticketDir, ticketId, extensionRoot: tmp, spawnCounter };
  try {
    runPollTick(ctx); // spawn
    // Poll 1 seeds the source-signature baseline (counts as progress, zpc stays 0);
    // each subsequent zero-delta poll increments. Three polls → streak of 2.
    runPollTick(ctx);
    runPollTick(ctx);
    runPollTick(ctx);
    let zpc = readState(statePath).worker_artifact_progress[ticketId].zero_progress_count;
    assert.ok(zpc >= 1, `streak should accrue on zero-delta polls, got ${zpc}`);

    // Now the worker lands a NEW artifact before the next poll → non-zero delta.
    addConformanceArtifact(ticketDir, 1);
    runPollTick(ctx);
    zpc = readState(statePath).worker_artifact_progress[ticketId].zero_progress_count;
    assert.equal(zpc, 0, 'a non-zero artifact delta resets the zero-progress streak');
    // The re-point worked: afterCount reflects the real current count.
    const cur = readState(statePath).worker_artifact_progress[ticketId].last_artifact_count;
    assert.equal(cur, countWorkerArtifacts(ticketDir, { creditEarlyPhases: false }));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC-R-WPEXA-5: wedged detached worker still trips PICKLE_WMW_SKIP_K (Failed/oversized, arm cleared)', () => {
  const ticketId = 'pollabc03';
  const { tmp, sessionDir, ticketDir, statePath } = makeSession(ticketId);
  const spawnCounter = { count: 0 };
  const ctx = { sessionDir, statePath, ticketDir, ticketId, extensionRoot: tmp, spawnCounter };
  const prevConsolidation = process.env.PICKLE_RECOVERY_CONSOLIDATION;
  process.env.PICKLE_RECOVERY_CONSOLIDATION = 'off'; // deterministic fall_through
  try {
    const skipK = resolveWmwSkipK();
    runPollTick(ctx); // spawn
    let flipped = false;
    // Poll repeatedly with NO artifacts: the streak climbs to skipK and flips.
    for (let i = 0; i < skipK + 2 && !flipped; i++) {
      const r = runPollTick(ctx);
      if (r === 'flipped') flipped = true;
    }
    assert.ok(flipped, 'wedged worker must trip the skip threshold');
    assert.equal(spawnCounter.count, 1, 'still exactly ONE spawn even through the wedge');

    const state = readState(statePath);
    assert.equal(state.detached_worker, null, 'detached_worker arm cleared on terminal flip');
    assert.equal(state.current_ticket, null, 'current_ticket cleared on terminal flip');

    const tf = readFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`), 'utf-8');
    assert.match(tf, /status:\s*["']?Failed["']?/, 'ticket flipped to Failed');
    // WS-2d (R-PFNT): the no-progress reason is now finer-grained. This session has no
    // scope.json fence → the classifier picks the honest no_progress_timeout default.
    assert.match(tf, /failed_reason:\s*["']?no_progress_timeout["']?/, 'failed_reason set (unscoped → no_progress_timeout)');

    const skips = state.activity.filter(e => e.event === 'worker_auto_skip_oversized');
    assert.equal(skips.length, 1, 'worker_auto_skip_oversized emitted once');
    assert.equal(skips[0].gate_payload.skip_k, skipK);
    assert.equal(skips[0].gate_payload.failure_reason, 'no_progress_timeout',
      'WS-2d: event payload carries the finer no_progress_timeout reason');
  } finally {
    if (prevConsolidation === undefined) delete process.env.PICKLE_RECOVERY_CONSOLIDATION;
    else process.env.PICKLE_RECOVERY_CONSOLIDATION = prevConsolidation;
    rmSync(tmp, { recursive: true, force: true });
  }
});

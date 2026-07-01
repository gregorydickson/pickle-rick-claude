// @tier: fast
//
// B-WSPU WS-1 regression guard: all tiers route through the single synchronous
// `runIteration` spawn path. The dual detached-worker spawn model (spawn arm +
// poll loop + large-tier routing) was deleted; this test pins the deletion so it
// cannot silently return, and proves the synchronous path survives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as muxRunner from '../bin/mux-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..', 'src', 'bin', 'mux-runner.ts');

// The detached-spawn mechanics deleted in WS-1. If any of these reappears on the
// module surface, the dual-spawn model crept back in.
const DELETED_DETACHED_SPAWN_SYMBOLS = [
  'spawnDetachedLargeTierWorker',
  'routeLargeTierTicket',
  'largeTierDetachedEnabled',
  'tierExceedsBashCeiling',
  'BASH_TOOL_CEILING_SECONDS',
];

test('WS-1: deleted detached-spawn symbols are absent from the module surface', () => {
  for (const symbol of DELETED_DETACHED_SPAWN_SYMBOLS) {
    assert.strictEqual(
      muxRunner[symbol],
      undefined,
      `${symbol} must stay deleted — its return means the detached spawn arm crept back into mux-runner`
    );
  }
});

test('WS-1: the single synchronous spawn path (runIteration) is still exported', () => {
  assert.strictEqual(
    typeof muxRunner.runIteration,
    'function',
    'runIteration is the sole surviving worker-spawn path; it must remain exported'
  );
});

test('WS-1: mux-runner source has no detached spawn arm / poll-loop symbols', () => {
  const source = fs.readFileSync(SRC, 'utf8');

  // Robust source-grep guard: the deleted-arm identifiers must not be defined or
  // called anywhere in the source. The KEPT disposition helpers
  // (routeDeadDetachedWorkerDisposition / routeDetachedWorkerTerminalNoProgress /
  // reapTimedOutDetachedWorker) do NOT reference any of these, so this grep is
  // scoped to the deleted-arm surface only.
  for (const symbol of DELETED_DETACHED_SPAWN_SYMBOLS) {
    assert.ok(
      !source.includes(symbol),
      `source still references deleted detached-spawn symbol "${symbol}" — WS-1 deletion regressed`
    );
  }

  // The deleted spawn-arm's own log strings must be absent from the main loop.
  // These are unique to the detached SPAWN arm (not the KEPT disposition helpers,
  // whose only detached_worker touch is the "clear detached_worker" cleanup line).
  const DELETED_ARM_LOG_STRINGS = [
    'detached spawn-morty',
    '[large-tier] detached spawn',
  ];
  for (const logString of DELETED_ARM_LOG_STRINGS) {
    assert.ok(
      !source.includes(logString),
      `source still contains deleted-arm log string "${logString}" — the detached spawn/poll branch regressed`
    );
  }
});

test('WS-1: the KEPT detached DISPOSITION helpers survive (WS-2 deletes them, not WS-1)', () => {
  const source = fs.readFileSync(SRC, 'utf8');
  // These are intentionally preserved as (now-unreferenced) dead code so tsc stays
  // green; WS-2 deletes them. Guard that WS-1 did not over-delete.
  for (const kept of [
    'routeDeadDetachedWorkerDisposition',
    'routeDetachedWorkerTerminalNoProgress',
    'reapTimedOutDetachedWorker',
  ]) {
    assert.ok(
      source.includes(`function ${kept}`),
      `disposition helper "${kept}" must remain defined for WS-2; WS-1 must not delete it`
    );
  }
});

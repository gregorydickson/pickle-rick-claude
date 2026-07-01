// @tier: fast
//
// B-WSPU regression guard: all tiers route through the single synchronous
// `runIteration` spawn path. The dual detached-worker spawn model — spawn arm +
// poll loop + large-tier routing (WS-1) AND the detached disposition path +
// `state.detached_worker` (WS-2) — was fully deleted; this test pins the deletion
// so it cannot silently return, and proves the synchronous path survives.
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

// The detached DISPOSITION machinery deleted in WS-2 (once WS-1 removed every
// caller). If any reappears, the detached lifecycle crept back in.
const DELETED_DETACHED_DISPOSITION_SYMBOLS = [
  'routeDeadDetachedWorkerDisposition',
  'routeDetachedWorkerTerminalNoProgress',
  'reapTimedOutDetachedWorker',
  'validateDetachedWorkerIdentity',
  'resolveDetachedPollIntervalMs',
];

test('B-WSPU: deleted detached-spawn symbols are absent from the module surface', () => {
  for (const symbol of DELETED_DETACHED_SPAWN_SYMBOLS) {
    assert.strictEqual(
      muxRunner[symbol],
      undefined,
      `${symbol} must stay deleted — its return means the detached spawn arm crept back into mux-runner`
    );
  }
});

test('B-WSPU: deleted detached-disposition symbols are absent from the module surface', () => {
  for (const symbol of DELETED_DETACHED_DISPOSITION_SYMBOLS) {
    assert.strictEqual(
      muxRunner[symbol],
      undefined,
      `${symbol} must stay deleted — its return means the detached disposition lifecycle crept back`
    );
  }
});

test('B-WSPU: the single synchronous spawn path (runIteration) is still exported', () => {
  assert.strictEqual(
    typeof muxRunner.runIteration,
    'function',
    'runIteration is the sole surviving worker-spawn path; it must remain exported'
  );
});

test('B-WSPU: mux-runner source has no detached spawn/poll/disposition symbols', () => {
  const source = fs.readFileSync(SRC, 'utf8');

  for (const symbol of [
    ...DELETED_DETACHED_SPAWN_SYMBOLS,
    ...DELETED_DETACHED_DISPOSITION_SYMBOLS,
  ]) {
    assert.ok(
      !source.includes(symbol),
      `source still references deleted detached symbol "${symbol}" — the dual-spawn model regressed`
    );
  }

  // The deleted spawn-arm's own log strings and the removed state field must be
  // absent from the source entirely.
  const DELETED_MARKERS = [
    'detached spawn-morty',
    '[large-tier] detached spawn',
    'detached_worker',
    'DetachedWorker',
  ];
  for (const marker of DELETED_MARKERS) {
    assert.ok(
      !source.includes(marker),
      `source still contains deleted detached marker "${marker}" — the detached lifecycle regressed`
    );
  }
});

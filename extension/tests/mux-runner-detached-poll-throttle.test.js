// @tier: fast
//
// R-LTDM: the large-tier DETACHED poll branch must throttle each live-worker poll
// so the loop does not spin at CPU speed and accumulate WMW_SKIP_K (5) zero-progress
// polls within ~1s — which false-failed a just-spawned explicit-`medium` ticket
// (~980ms, beta.31 R-MWBG runtime half) before its first-artifact latency, producing
// a false EPIC_COMPLETED and pickle 0/N.
//
// Covers: (1) resolveDetachedPollIntervalMs env parsing; (2) the source invariant
// that `await sleep(resolveDetachedPollIntervalMs())` is present in the detached
// poll branch and precedes the `recordWorkerArtifactProgress(... detachedTicketId ...)`
// zero-progress charge (the throttle gates the charge, not the other way round).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveDetachedPollIntervalMs,
  DETACHED_POLL_INTERVAL_DEFAULT_MS,
  DETACHED_POLL_INTERVAL_ENV,
} from '../bin/mux-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../src/bin/mux-runner.ts');

test('resolveDetachedPollIntervalMs: default when env unset', () => {
  assert.equal(resolveDetachedPollIntervalMs({}), DETACHED_POLL_INTERVAL_DEFAULT_MS);
});

test('resolveDetachedPollIntervalMs: honors a valid positive-integer override', () => {
  assert.equal(resolveDetachedPollIntervalMs({ [DETACHED_POLL_INTERVAL_ENV]: '5000' }), 5000);
});

test('resolveDetachedPollIntervalMs: invalid / zero / negative / fractional → default', () => {
  for (const bad of ['0', '-1', 'abc', '12.5', '', ' ']) {
    assert.equal(
      resolveDetachedPollIntervalMs({ [DETACHED_POLL_INTERVAL_ENV]: bad }),
      DETACHED_POLL_INTERVAL_DEFAULT_MS,
      `bad value ${JSON.stringify(bad)} must fall back to the default`,
    );
  }
});

test('default interval × WMW_SKIP_K is a sane wedge window (≥ several minutes, < worker_timeout)', () => {
  // 5 zero-progress polls must span comfortably more than a worker's first-artifact
  // latency and comfortably less than the 3600s medium worker_timeout T6 backstop.
  const windowSec = (DETACHED_POLL_INTERVAL_DEFAULT_MS / 1000) * 5;
  assert.ok(windowSec >= 300, `wedge window ${windowSec}s must be >= 5 min`);
  assert.ok(windowSec < 3600, `wedge window ${windowSec}s must be < the 3600s worker_timeout`);
});

test('SOURCE INVARIANT: detached poll throttles before charging zero-progress', () => {
  const src = fs.readFileSync(SRC, 'utf-8');

  // The throttle call must exist.
  assert.ok(
    src.includes('await sleep(resolveDetachedPollIntervalMs())'),
    'detached poll branch must `await sleep(resolveDetachedPollIntervalMs())`',
  );

  // It must PRECEDE the detached zero-progress charge — otherwise the loop spins and
  // saturates WMW_SKIP_K before the first throttle, re-opening R-LTDM.
  const sleepIdx = src.indexOf('await sleep(resolveDetachedPollIntervalMs())');
  const chargeIdx = src.indexOf('recordWorkerArtifactProgress(statePath, sessionDir, detachedTicketId');
  assert.ok(chargeIdx !== -1, 'detached recordWorkerArtifactProgress charge site must exist');
  assert.ok(
    sleepIdx !== -1 && sleepIdx < chargeIdx,
    'the throttle sleep must precede the detached zero-progress charge',
  );

  // The throttle must live inside the live-detached-worker poll branch (guarded by
  // the ticket-id match), not somewhere unrelated.
  const pollGuardIdx = src.indexOf('state.detached_worker && state.detached_worker.ticket_id === apTicketId');
  assert.ok(pollGuardIdx !== -1 && pollGuardIdx < sleepIdx,
    'the throttle must sit inside the live-detached-worker poll branch');
});

// @tier: fast
//
// Pins the mechanism behind ticket 228e5fb8 (ROOT 1): an `.unref()`'d timer that is the
// SOLE settle path for a hung async operation does not reliably fire, because its firing
// becomes conditional on some UNRELATED handle happening to hold the event loop open. This
// is the exact reproduction shape `5cce7f5d` (microverse-runner.ts spawnWithClosedStdin) and
// `3b2c0205` (monitor.ts writeWithWatchdog) used to prove their fixes — a handle-free child
// (no real spawn, no other timer, nothing else keeping the loop alive) with a `settled` flag
// and a single `setTimeout` as the only handle in the process. Every timer this ticket ref'd
// (mux-runner.ts hangGuard/outputStallGuard/timeoutResolveTimer/exitDrainTimer, spawn-morty.ts
// runCommand's timeoutHandle and armWorkerHangGuard's hangGuard, convergence-gate.ts
// runCheckCommand's timer) shares this exact shape; a regression back to `.unref()` on any of
// them reproduces the failure asserted here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sole-settle-path-repro.mjs');

test('ref\'d sole-settle-path timer: fires reliably with no other handle holding the loop', () => {
  const result = spawnSync(process.execPath, [FIXTURE], {
    encoding: 'utf-8',
    timeout: 5000,
    env: { ...process.env, PICKLE_TEST_UNREF_TIMER: '0' },
  });
  assert.equal(result.status, 0, `expected clean exit, got status=${result.status} stderr=${result.stderr}`);
  assert.ok(result.stdout.includes('SETTLED true'), `expected the settle path to fire: ${result.stdout}`);
});

test('negative control: an unref\'d sole-settle-path timer does NOT reliably fire (proves the mechanism)', () => {
  const result = spawnSync(process.execPath, [FIXTURE], {
    encoding: 'utf-8',
    timeout: 5000,
    env: { ...process.env, PICKLE_TEST_UNREF_TIMER: '1' },
  });
  assert.notEqual(result.status, 0, `expected the unref'd timer to leave the await unsettled, got status=${result.status}`);
  assert.ok(!result.stdout.includes('SETTLED true'), `the settle path must NOT have fired: ${result.stdout}`);
});

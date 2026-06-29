// @tier: fast
/**
 * R-MWBG: detached-worker gate keys on worker-timeout vs the 600s Bash ceiling,
 * not tier === 'large'. Tests AC-MWBG-1/2/5 predicate + kill-switch shapes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASH_TOOL_CEILING_SECONDS,
  workerTimeoutExceedsBashCeiling,
  largeTierDetachedEnabled,
} from '../bin/mux-runner.js';

// ---------------------------------------------------------------------------
// Predicate boundary — each tier budget
// ---------------------------------------------------------------------------

test('BASH_TOOL_CEILING_SECONDS is 600', () => {
  assert.strictEqual(BASH_TOOL_CEILING_SECONDS, 600);
});

test('workerTimeoutExceedsBashCeiling: trivial (300s) → false', () => {
  assert.strictEqual(workerTimeoutExceedsBashCeiling({ worker_timeout_seconds: 300 }), false);
});

test('workerTimeoutExceedsBashCeiling: small (600s, == ceiling) → false', () => {
  // strictly greater-than; at-ceiling stays synchronous
  assert.strictEqual(workerTimeoutExceedsBashCeiling({ worker_timeout_seconds: 600 }), false);
});

test('workerTimeoutExceedsBashCeiling: medium (3600s) → true', () => {
  assert.strictEqual(workerTimeoutExceedsBashCeiling({ worker_timeout_seconds: 3600 }), true);
});

test('workerTimeoutExceedsBashCeiling: large (4800s) → true', () => {
  assert.strictEqual(workerTimeoutExceedsBashCeiling({ worker_timeout_seconds: 4800 }), true);
});

// ---------------------------------------------------------------------------
// Fail-safe cases — absent / invalid timeout
// ---------------------------------------------------------------------------

test('workerTimeoutExceedsBashCeiling: absent worker_timeout_seconds, no tier → false', () => {
  assert.strictEqual(workerTimeoutExceedsBashCeiling({}), false);
});

test('workerTimeoutExceedsBashCeiling: NaN worker_timeout_seconds, no tier → false', () => {
  assert.strictEqual(workerTimeoutExceedsBashCeiling({ worker_timeout_seconds: NaN }), false);
});

test('workerTimeoutExceedsBashCeiling: zero worker_timeout_seconds, no tier → false', () => {
  assert.strictEqual(workerTimeoutExceedsBashCeiling({ worker_timeout_seconds: 0 }), false);
});

// ---------------------------------------------------------------------------
// Tier-table fallback (when worker_timeout_seconds is absent/invalid)
// ---------------------------------------------------------------------------

test('workerTimeoutExceedsBashCeiling: absent timeout, tier=medium → true via tier table', () => {
  assert.strictEqual(
    workerTimeoutExceedsBashCeiling({ current_ticket_tier: 'medium' }),
    true,
  );
});

test('workerTimeoutExceedsBashCeiling: absent timeout, tier=large → true via tier table', () => {
  assert.strictEqual(
    workerTimeoutExceedsBashCeiling({ current_ticket_tier: 'large' }),
    true,
  );
});

test('workerTimeoutExceedsBashCeiling: absent timeout, tier=small → false via tier table', () => {
  assert.strictEqual(
    workerTimeoutExceedsBashCeiling({ current_ticket_tier: 'small' }),
    false,
  );
});

test('workerTimeoutExceedsBashCeiling: absent timeout, tier=trivial → false via tier table', () => {
  assert.strictEqual(
    workerTimeoutExceedsBashCeiling({ current_ticket_tier: 'trivial' }),
    false,
  );
});

test('workerTimeoutExceedsBashCeiling: absent timeout, unknown tier → false', () => {
  assert.strictEqual(
    workerTimeoutExceedsBashCeiling({ current_ticket_tier: 'bogus' }),
    false,
  );
});

// ---------------------------------------------------------------------------
// worker_timeout_seconds takes precedence over tier table
// ---------------------------------------------------------------------------

test('workerTimeoutExceedsBashCeiling: resolved 601s overrides tier=trivial → true', () => {
  // The resolved per-ticket timeout wins, even if the tier table would say false.
  assert.strictEqual(
    workerTimeoutExceedsBashCeiling({ worker_timeout_seconds: 601, current_ticket_tier: 'trivial' }),
    true,
  );
});

test('workerTimeoutExceedsBashCeiling: resolved 300s overrides tier=large → false', () => {
  // Operator can cap a large-tier ticket below the ceiling; predicate honors it.
  assert.strictEqual(
    workerTimeoutExceedsBashCeiling({ worker_timeout_seconds: 300, current_ticket_tier: 'large' }),
    false,
  );
});

// ---------------------------------------------------------------------------
// Kill-switch parity — PICKLE_LARGE_TIER_DETACHED=off reverts ceiling-exceeding tiers
// ---------------------------------------------------------------------------

test('largeTierDetachedEnabled: default (no env var) → true', () => {
  assert.strictEqual(largeTierDetachedEnabled({}), true);
});

test('largeTierDetachedEnabled: PICKLE_LARGE_TIER_DETACHED=off → false', () => {
  assert.strictEqual(largeTierDetachedEnabled({ PICKLE_LARGE_TIER_DETACHED: 'off' }), false);
});

test('largeTierDetachedEnabled: PICKLE_LARGE_TIER_DETACHED=OFF (uppercase) → true (only lowercase off disables)', () => {
  assert.strictEqual(largeTierDetachedEnabled({ PICKLE_LARGE_TIER_DETACHED: 'OFF' }), true);
});

test('largeTierDetachedEnabled: PICKLE_LARGE_TIER_DETACHED=1 → true', () => {
  assert.strictEqual(largeTierDetachedEnabled({ PICKLE_LARGE_TIER_DETACHED: '1' }), true);
});

// Combined: medium state + kill-switch → detached path disabled
test('medium ticket: predicate true AND kill-switch off → no detached spawn (both gates would skip)', () => {
  const mediumState = { worker_timeout_seconds: 3600, current_ticket_tier: 'medium' };
  assert.strictEqual(workerTimeoutExceedsBashCeiling(mediumState), true, 'predicate true for medium');
  assert.strictEqual(largeTierDetachedEnabled({ PICKLE_LARGE_TIER_DETACHED: 'off' }), false, 'kill-switch disables');
  // Gate conjunction: workerTimeoutExceedsBashCeiling(state) && detachedEnabled → false
  assert.strictEqual(
    workerTimeoutExceedsBashCeiling(mediumState) && largeTierDetachedEnabled({ PICKLE_LARGE_TIER_DETACHED: 'off' }),
    false,
  );
});

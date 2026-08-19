// @tier: fast
/**
 * Ticket 1476a3b7: standalone sweep entry point (`bin/reap-orphans.js`).
 * Unit-tests the injectable wrapper only — no real `ps`/process spawn, kept
 * hermetic and fast per R-TFP/subprocess-heavy-test discipline. Real-process
 * sweep coverage lives in tests/integration/reap-orphans-sweep.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStandaloneOrphanReap } from '../bin/reap-orphans.js';

test('runStandaloneOrphanReap returns the injected reap result', () => {
  const calls = [];
  const result = runStandaloneOrphanReap('/fake/sessions/root', {
    reap: (opts) => {
      calls.push(opts);
      return { scanned: 3, reaped: 1, unverified: 0 };
    },
  });
  assert.deepEqual(result, { scanned: 3, reaped: 1, unverified: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionsRoot, '/fake/sessions/root');
});

test('runStandaloneOrphanReap swallows a throwing reap implementation and returns null', () => {
  const result = runStandaloneOrphanReap('/fake/sessions/root', {
    reap: () => {
      throw new Error('ps failed');
    },
  });
  assert.equal(result, null);
});

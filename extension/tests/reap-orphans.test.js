// @tier: fast
/**
 * Ticket 1476a3b7: standalone sweep entry point (`bin/reap-orphans.js`).
 * Unit-tests the injectable wrapper only — no real `ps`/process spawn, kept
 * hermetic and fast per R-TFP/subprocess-heavy-test discipline. Real-process
 * sweep coverage lives in tests/integration/reap-orphans-sweep.test.js.
 *
 * AC5 (b6b7ddc5): a non-zero sweep prints what it collected (incl. the
 * per-match-class breakdown); a zero-reap sweep stays quiet — no stdout line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStandaloneOrphanReap } from '../bin/reap-orphans.js';

function withCapturedStdout(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test('runStandaloneOrphanReap returns the injected reap result', () => {
  const calls = [];
  let result;
  const lines = withCapturedStdout(() => {
    result = runStandaloneOrphanReap('/fake/sessions/root', {
      reap: (opts) => {
        calls.push(opts);
        return { scanned: 3, reaped: 1, unverified: 0, by_match_class: { session_owned: 1, tmp_prefix_fixture: 0, repo_fixture_path: 0 } };
      },
    });
  });
  assert.deepEqual(result, { scanned: 3, reaped: 1, unverified: 0, by_match_class: { session_owned: 1, tmp_prefix_fixture: 0, repo_fixture_path: 0 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionsRoot, '/fake/sessions/root');
  assert.equal(lines.length, 1, 'a non-zero sweep prints exactly one line');
  assert.match(lines[0], /scanned=3 reaped=1 unverified=0/);
  assert.match(lines[0], /session_owned=1 tmp_prefix_fixture=0 repo_fixture_path=0/);
});

test('runStandaloneOrphanReap stays quiet on a zero-reap sweep', () => {
  let result;
  const lines = withCapturedStdout(() => {
    result = runStandaloneOrphanReap('/fake/sessions/root', {
      reap: () => ({ scanned: 5, reaped: 0, unverified: 0, by_match_class: { session_owned: 0, tmp_prefix_fixture: 0, repo_fixture_path: 0 } }),
    });
  });
  assert.deepEqual(result, { scanned: 5, reaped: 0, unverified: 0, by_match_class: { session_owned: 0, tmp_prefix_fixture: 0, repo_fixture_path: 0 } });
  assert.deepEqual(lines, [], 'a zero-reap sweep must print nothing');
});

test('runStandaloneOrphanReap swallows a throwing reap implementation and returns null', () => {
  const result = runStandaloneOrphanReap('/fake/sessions/root', {
    reap: () => {
      throw new Error('ps failed');
    },
  });
  assert.equal(result, null);
});

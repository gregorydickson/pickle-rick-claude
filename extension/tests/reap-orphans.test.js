// @tier: fast
/**
 * Ticket 1476a3b7: standalone sweep entry point (`bin/reap-orphans.js`).
 * Unit-tests the injectable wrapper only — no real `ps`/process spawn, kept
 * hermetic and fast per R-TFP/subprocess-heavy-test discipline. Real-process
 * sweep coverage lives in tests/integration/reap-orphans-sweep.test.js.
 *
 * AC6 (4b942487, updates AC5/b6b7ddc5's pin): a non-zero sweep prints what it
 * collected (incl. the per-match-class breakdown); a zero-reap sweep now also
 * prints, reporting its scanned count so "nothing matched" is distinguishable
 * from "nothing to do".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStandaloneOrphanReap } from '../bin/reap-orphans.js';
import { reapOrphanedWorkerProcs } from '../services/orphan-reaper.js';

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

test('runStandaloneOrphanReap reports the scanned count on a zero-reap sweep', () => {
  let result;
  const lines = withCapturedStdout(() => {
    result = runStandaloneOrphanReap('/fake/sessions/root', {
      reap: () => ({ scanned: 5, reaped: 0, unverified: 0, by_match_class: { session_owned: 0, tmp_prefix_fixture: 0, repo_fixture_path: 0 } }),
    });
  });
  assert.deepEqual(result, { scanned: 5, reaped: 0, unverified: 0, by_match_class: { session_owned: 0, tmp_prefix_fixture: 0, repo_fixture_path: 0 } });
  assert.equal(lines.length, 1, 'a zero-reap sweep must print exactly one line');
  assert.match(lines[0], /scanned=5 reaped=0/);
});

test('runStandaloneOrphanReap swallows a throwing reap implementation and returns null', () => {
  const result = runStandaloneOrphanReap('/fake/sessions/root', {
    reap: () => {
      throw new Error('ps failed');
    },
  });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER44-01: a sweep that never ran is not a sweep that found nothing.
//
// The kill-switch, the win32 no-op and the best-effort catch each returned their
// own zero tuple, so an unavailable / timed-out / over-buffer process scan rendered
// byte-identically to a quiet box — on the very line MASTER_PLAN cites as post-deploy
// proof ("reports scanned=0 reaped=0 against a genuinely empty census").
// ---------------------------------------------------------------------------

test('AP-EXT-ITER44-01: a failed scan is distinguishable from a genuinely empty one', () => {
  const failed = reapOrphanedWorkerProcs({
    sessionsRoot: '/fake/sessions/root',
    env: {},
    platform: 'darwin',
    scan: () => { throw Object.assign(new Error('ps ENOENT'), { code: 'ENOENT' }); },
  });
  const quiet = reapOrphanedWorkerProcs({
    sessionsRoot: '/fake/sessions/root',
    env: {},
    platform: 'darwin',
    psOutput: '',
  });

  assert.equal(failed.skipped, 'sweep_failed', 'a scan that threw produced no census');
  assert.equal(quiet.skipped, null, 'a scan that ran produced a real census');
  assert.notDeepEqual(failed, quiet, 'the two results must not be interchangeable');
  // Still best-effort: the reaper reports, it never throws into a launch path.
  assert.equal(failed.scanned, 0);
  assert.equal(failed.reaped, 0);
});

test('AP-EXT-ITER44-01: the kill-switch and win32 no-op name themselves too', () => {
  const killSwitched = reapOrphanedWorkerProcs({
    sessionsRoot: '/fake/sessions/root',
    env: { PICKLE_ORPHAN_REAP: 'off' },
    platform: 'darwin',
    scan: () => { throw new Error('scan must never run under the kill-switch'); },
  });
  assert.equal(killSwitched.skipped, 'kill_switch');

  const win32 = reapOrphanedWorkerProcs({
    sessionsRoot: '/fake/sessions/root',
    env: {},
    platform: 'win32',
    scan: () => { throw new Error('scan must never run on win32'); },
  });
  assert.equal(win32.skipped, 'unsupported_platform');
});

test('AP-EXT-ITER44-01: a real sweep over real ps-shaped output still reports skipped:null', () => {
  const psOutput = '4242 4242 1 01:00:00 codex exec --dangerously-bypass-approvals-and-sandbox --add-dir /nope/x/y\n';
  const result = reapOrphanedWorkerProcs({
    sessionsRoot: '/fake/sessions/root',
    env: {},
    platform: 'darwin',
    psOutput,
    kill: () => { throw new Error('unattributable procs are never killed'); },
  });
  assert.equal(result.skipped, null);
  assert.equal(result.scanned, 1, 'the candidate was censused');
  assert.equal(result.reaped, 0, 'and spared — no owning session under the sessions root');
});

test('AP-EXT-ITER44-01: the operator census line says so when the sweep did not run', () => {
  const failedLines = withCapturedStdout(() => {
    runStandaloneOrphanReap('/fake/sessions/root', {
      reap: (opts) => reapOrphanedWorkerProcs({
        ...opts,
        env: {},
        platform: 'darwin',
        scan: () => { throw new Error('ps ETIMEDOUT'); },
      }),
    });
  });
  const quietLines = withCapturedStdout(() => {
    runStandaloneOrphanReap('/fake/sessions/root', {
      reap: (opts) => reapOrphanedWorkerProcs({ ...opts, env: {}, platform: 'darwin', psOutput: '' }),
    });
  });

  assert.equal(failedLines.length, 1);
  assert.equal(quietLines.length, 1);
  assert.notEqual(failedLines[0], quietLines[0], 'the two dispositions must not print the same line');
  assert.match(failedLines[0], /sweep did not run \(sweep_failed\)/);
  assert.doesNotMatch(failedLines[0], /nothing to reap/);
  assert.match(quietLines[0], /scanned=0 reaped=0 \(nothing to reap\)/);
});

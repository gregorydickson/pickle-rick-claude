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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { reapOrphanedWorkerProcs } from '../services/orphan-reaper.js';
import { runPipelineOrphanWorkerReap } from '../bin/mux-runner.js';

process.env.PICKLE_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-iter45-root-'));

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

// ---------------------------------------------------------------------------
// AP-EXT-ITER45-01 — the THIRD consumer: mux-runner's per-iteration sweep
// ---------------------------------------------------------------------------
//
// `runPipelineOrphanWorkerReap` is the third consumer of `reapOrphanedWorkerProcs`
// (with `runStandaloneOrphanReap` above and `setup.ts:runSetupOrphanReap`) and the
// only one that fires every iteration rather than once per run. AP-EXT-ITER44-01
// wired the `skipped` axis into the other two and left this one discarding it.
//
// Every not-run path of the producer returns `reaped: 0`, so before the fix all of
// them fell into the `reaped <= 0` early return: a `ps` that was absent, timed out
// or overflowed its buffer emitted byte-identically to a healthy quiet box —
// nothing at all. The two sibling reapers at the same call sites get this signal
// for free by throwing into the caller's catch; this one cannot, because
// `reapOrphanedWorkerProcs` is contractually best-effort and never throws, leaving
// that catch unreachable for real scan failures.
//
// The per-iteration cadence is why only `sweep_failed` reports: `kill_switch` and
// `unsupported_platform` are constants for the whole run, so restating them each
// iteration would be noise for an operator who deliberately disabled the reaper.

const EMPTY_CLASSES = { session_owned: 0, tmp_prefix_fixture: 0, repo_fixture_path: 0 };

/** Exactly the tuple every not-run path of `reapOrphanedWorkerProcs` returns. */
function notRun(reason) {
  return { scanned: 0, reaped: 0, unverified: 0, by_match_class: { ...EMPTY_CLASSES }, skipped: reason };
}

function runPipelineReapWith(result) {
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-iter45-'));
  const statePath = path.join(sessionRoot, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({ activity: [] }));
  const lines = [];
  runPipelineOrphanWorkerReap(statePath, path.join(sessionRoot, 'sessions'), msg => lines.push(msg), {
    reap: () => result,
  });
  let activity = [];
  try {
    activity = JSON.parse(fs.readFileSync(statePath, 'utf-8')).activity ?? [];
  } catch { /* state unreadable — leave activity empty */ }
  return { lines, activity };
}

test('AP-EXT-ITER45-01: a FAILED sweep logs that it has no census instead of going silent', () => {
  const { lines, activity } = runPipelineReapWith(notRun('sweep_failed'));

  assert.equal(lines.length, 1, 'a sweep_failed must produce exactly one operator line');
  assert.match(lines[0], /no census/i, 'the line must say no census exists, not report counts');
  assert.doesNotMatch(
    lines[0],
    /scanned=/,
    'a sweep with no census must never render a scanned count — that is the false-green wire',
  );
  assert.equal(activity.length, 0, 'a not-run sweep must not emit a reap summary event');
});

test('AP-EXT-ITER45-01: a failed sweep is distinguishable from a genuinely empty census', () => {
  const failed = runPipelineReapWith(notRun('sweep_failed'));
  const quiet = runPipelineReapWith({
    scanned: 41, reaped: 0, unverified: 0, by_match_class: { ...EMPTY_CLASSES }, skipped: null,
  });

  assert.equal(quiet.lines.length, 0, 'a real zero-reap census stays quiet (AC5 no-noise contract)');
  assert.notDeepEqual(
    failed.lines,
    quiet.lines,
    'sweep_failed and a real empty census must not render identically — that collapse IS the bug',
  );
});

test('AP-EXT-ITER45-01: kill-switch and win32 stay quiet — run constants, not per-iteration news', () => {
  for (const reason of ['kill_switch', 'unsupported_platform']) {
    const { lines, activity } = runPipelineReapWith(notRun(reason));
    assert.deepEqual(lines, [], `${reason} must not log every iteration`);
    assert.equal(activity.length, 0, `${reason} must not emit an event`);
  }
});

test('AP-EXT-ITER45-01: a real non-zero sweep still logs its counts and emits its summary', () => {
  const { lines, activity } = runPipelineReapWith({
    scanned: 7,
    reaped: 2,
    unverified: 1,
    by_match_class: { session_owned: 2, tmp_prefix_fixture: 0, repo_fixture_path: 0 },
    skipped: null,
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0], /scanned=7 reaped=2 unverified=1/);
  assert.equal(activity.length, 1, 'a non-zero sweep must still emit worker_orphan_reap_summary');
  assert.equal(activity[0].event, 'worker_orphan_reap_summary');
  assert.equal(activity[0].reaped, 2);
});

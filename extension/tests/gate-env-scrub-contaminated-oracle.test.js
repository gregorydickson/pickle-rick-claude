// @tier: integration
//
// Ticket b9cf08e3 (AC-5): regression oracle for tickets d35f4c61/2015462e. Proves the shared
// production scrub primitive (`scrubGateEnv`, backed by `PICKLE_GATE_SCRUBBED_ENV_KEYS`) still
// keeps a contaminated PARENT env from reaching a real gate-spawned CHILD test process, spawned
// against the real files under `extension/tests/` (not the synthetic fixture repo
// `tests/gate-env-scrub.test.js` uses). Goes RED if the scrub constant is emptied — see
// conformance_*.md for the recorded mutation run.
//
// Per-row `pre_defended` reflects MEASURED behavior (research_2026-08-15.md), not just the PRD's
// original table: `settings-loader`/`install-script`/`mux-runner-between-ticket-gate`/
// `worker-test-fast-timeout` were empirically confirmed immune to this exact contamination even
// with scrubGateEnv fully bypassed (ticket 2015462e's explicit-env-argument fix defends them
// unconditionally, independent of the scrub) — see the measured reasons below. Only
// `gate-env-scrub.test.js` and the two `tests/integration/gitattr-*` files were confirmed to
// actually flip red without the scrub and green with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubGateEnv } from '../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');
const SPAWN_TIMEOUT_MS = 120_000;

// This worker's own ambient env already carries a real GIT_CONFIG_COUNT/KEY_N/VALUE_N trailer-hooks
// fragment (per AC-3 in gate-env-scrub.test.js, worker spawns are NOT scrubbed) — that IS the
// realistic contamination the ticket describes, so it's used as-is rather than overwritten with
// fake GIT_CONFIG_KEY_0/VALUE_0 values (which was measured to break gate-env-scrub.test.js's own
// AC-3, an unrelated pre-existing test that needs a resolvable pre-existing hooks dir to run).
const CONTAMINATED_ENV = {
  PICKLE_WORKER_TEST_FAST_TIMEOUT_MS: '1800000',
  PICKLE_TICKET_ID: 'oracle',
};

const CASES = [
  {
    suite: 'tests/settings-loader.test.js',
    tier: 'fast',
    pre_defended: true,
    reason: 'measured immune: ticket 2015462e (34b5c84f) passes an explicit env={} 3rd arg, bypassing ambient process.env regardless of scrubGateEnv',
  },
  {
    suite: 'tests/install-script.test.js',
    tier: 'fast',
    pre_defended: true,
    reason: 'measured immune: ticket 2015462e (34b5c84f) explicit-env fix; all cases pass with the full contamination set and zero scrub applied',
  },
  {
    suite: 'tests/mux-runner-between-ticket-gate.test.js',
    tier: 'fast',
    pre_defended: true,
    reason: 'measured immune: ticket 2015462e (34b5c84f) explicit-env fix; all cases pass with the full contamination set and zero scrub applied',
  },
  {
    suite: 'tests/worker-test-fast-timeout.test.js',
    tier: 'fast',
    pre_defended: true,
    reason: 'measured immune: every R-WTFT case passes explicit args/env to resolveWorkerTestGateTimeoutMs, independent of ambient contamination',
  },
  { suite: 'tests/gate-env-scrub.test.js', tier: 'fast', pre_defended: false, reason: '' },
  {
    suite: 'tests/services/backend-spawn-trailer-env.test.js',
    tier: 'fast',
    pre_defended: true,
    reason: 'self-defends via withCleanTrailerEnv at :49',
  },
  { suite: 'tests/standup.test.js', tier: 'fast', pre_defended: true, reason: 'self-defends already at HEAD' },
  { suite: 'tests/integration/gitattr-hook-forwarding.test.js', tier: 'integration', pre_defended: false, reason: '' },
  { suite: 'tests/integration/gitattr-trailer-producer.test.js', tier: 'integration', pre_defended: false, reason: '' },
];

function withContaminatedEnv(fn) {
  const keys = Object.keys(CONTAMINATED_ENV);
  const prior = {};
  for (const key of keys) prior[key] = process.env[key];
  Object.assign(process.env, CONTAMINATED_ENV);
  try {
    return fn();
  } finally {
    for (const key of keys) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
}

// Runs each file directly (no `--test` flag): node:test's `test()` calls execute and report on
// process exit regardless of the flag, and spawning `node --test <file>` here would recurse into
// this file's OWN outer `node --test` invocation, which node:test detects and silently no-ops
// (warns "run() is being called recursively" and skips running the child's files entirely).
function spawnFiles(relativeFiles, env) {
  const results = relativeFiles.map((file) =>
    spawnSync('node', [file], { cwd: EXTENSION_ROOT, encoding: 'utf-8', timeout: SPAWN_TIMEOUT_MS, env }),
  );
  const failed = results.find((result) => result.status !== 0);
  return failed ?? results[0];
}

// gitattr-hook-forwarding/gitattr-trailer-producer exercise real `git` behavior directly — the
// real defense is the OUTER scrubGateEnv() applied before the child even starts (matching
// runCommand's unconditional `env: scrubGateEnv()`), so they're spawned scrubbed.
function spawnScrubbedGate(relativeFiles) {
  return spawnFiles(relativeFiles, scrubGateEnv());
}

// gate-env-scrub.test.js is itself the sibling scrub oracle (ticket d35f4c61): it calls
// runWorkerGateTestCommand/runBetweenTicketFastTests internally, which apply their OWN
// scrubGateEnv() before ITS grandchild spawns. It needs the REAL ambient env (including this
// worker's own trailer-hooks fragment) intact to run, so it is spawned UNscrubbed.
function spawnPlainGate(relativeFiles) {
  return spawnFiles(relativeFiles, process.env);
}

test('data integrity: every pre_defended row carries a non-empty reason', () => {
  for (const row of CASES) {
    if (!row.pre_defended) continue;
    assert.ok(
      typeof row.reason === 'string' && row.reason.trim().length > 0,
      `${row.suite} is pre_defended but carries no reason`,
    );
  }
});

test('AC-5: contaminated-parent fast-tier rows exit 0 through the real scrubGateEnv seam', () => {
  const rows = CASES.filter((row) => row.tier === 'fast' && !row.pre_defended);
  assert.ok(rows.length > 0, 'expected at least one non-pre-defended fast row');
  withContaminatedEnv(() => {
    const result = spawnPlainGate(rows.map((row) => row.suite));
    for (const row of rows) {
      assert.equal(result.status, 0, `${row.suite}: contaminated-parent fast spawn must exit 0 (stderr: ${result.stderr.slice(-2000)})`);
    }
  });
});

test('AC-5: contaminated-parent integration-tier rows exit 0 through the real scrubGateEnv seam', () => {
  const rows = CASES.filter((row) => row.tier === 'integration' && !row.pre_defended);
  assert.ok(rows.length > 0, 'expected at least one non-pre-defended integration row');
  withContaminatedEnv(() => {
    const result = spawnScrubbedGate(rows.map((row) => row.suite));
    for (const row of rows) {
      assert.equal(result.status, 0, `${row.suite}: contaminated-parent integration spawn must exit 0 (stderr: ${result.stderr.slice(-2000)})`);
    }
  });
});

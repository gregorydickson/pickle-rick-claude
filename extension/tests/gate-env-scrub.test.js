// @tier: fast
//
// Ticket d35f4c61: the two test-gate spawn sites (spawn-morty.ts runCommand,
// mux-runner.ts runBetweenTicketFastTests) must scrub PICKLE_WORKER_TEST_FAST_TIMEOUT_MS,
// PICKLE_TICKET_ID, and the GIT_CONFIG_* trailer set before spawning — otherwise the
// gate measures the launching worker's environment instead of the tree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  PICKLE_GATE_SCRUBBED_ENV_KEYS,
  scrubGateEnv,
  resolveWorkerTestGateTimeoutMs,
} from '../services/pickle-utils.js';
import { backendEnvOverrides } from '../services/backend-spawn.js';
import { runWorkerGateTestCommand } from '../bin/spawn-morty.js';
import { runBetweenTicketFastTests } from '../bin/mux-runner.js';

const CONTAMINATION = {
  PICKLE_WORKER_TEST_FAST_TIMEOUT_MS: '1800000',
  PICKLE_TICKET_ID: 'contaminated-ticket-id',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/tmp/whatever',
  GIT_CONFIG_KEY_1: 'user.name',
  GIT_CONFIG_VALUE_1: 'contaminated',
};

const KEEP_SET = ['PATH', 'HOME', 'PICKLE_BACKEND', 'PICKLE_TEST_MODE'];

function makeGateFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-env-scrub-'));
  const dumpScript = path.join(dir, 'dump-env.js');
  fs.writeFileSync(
    dumpScript,
    "const fs = require('fs');\nfs.writeFileSync(process.env.DUMP_OUT, JSON.stringify(process.env));\n"
  );
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'gate-env-scrub-fixture', scripts: { 'test:fast': 'node dump-env.js', 'test:integration': 'node dump-env.js' } })
  );
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({}));
  return dir;
}

/**
 * A real git repo. `materializeTrailerHooks` resolves the pre-existing hooks dir from the repo
 * itself; a bare mkdtemp dir resolves only when the launching process happens to export
 * GIT_CONFIG_KEY_0=core.hooksPath, so the AC-3/AC-4 fixtures were green under a contaminated
 * parent and red under a clean one (ticket 5ceb9399, AC-6 clean-env measurement).
 */
function makeGitRepoFixture(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const init = spawnSync('git', ['init', '-q', dir], { timeout: 30_000, encoding: 'utf-8' });
  assert.equal(init.status, 0, `git init fixture failed: ${init.stderr ?? init.error?.message ?? ''}`);
  return dir;
}

/** Runs `fn` with every gate-scrubbed key deleted from the ambient env, then restores it. */
function withScrubbedAmbientEnv(fn) {
  const keys = [
    ...PICKLE_GATE_SCRUBBED_ENV_KEYS,
    ...Object.keys(process.env).filter(k => /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)),
  ];
  const prior = {};
  for (const k of keys) {
    prior[k] = process.env[k];
    delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
  }
}

function withContaminatedEnv(extra, fn) {
  const dumpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-env-scrub-out-')) + '/env.json';
  const prior = {};
  const keys = [...Object.keys(CONTAMINATION), ...KEEP_SET, 'DUMP_OUT'];
  for (const k of keys) prior[k] = process.env[k];
  Object.assign(process.env, CONTAMINATION, extra, { DUMP_OUT: dumpOut, PICKLE_BACKEND: 'claude', PICKLE_TEST_MODE: '1' });
  return Promise.resolve()
    .then(() => fn(dumpOut))
    .finally(() => {
      for (const k of keys) {
        if (prior[k] === undefined) delete process.env[k];
        else process.env[k] = prior[k];
      }
    });
}

function readDumpedEnv(dumpOut) {
  return JSON.parse(fs.readFileSync(dumpOut, 'utf-8'));
}

test('AC-1/AC-2: runWorkerGateTestCommand (spawn-morty test-gate spawn) scrubs the gate-env keys', async () => {
  const fixtureDir = makeGateFixture();
  await withContaminatedEnv({}, async (dumpOut) => {
    const result = await runWorkerGateTestCommand('test:fast', fixtureDir, 600_000);
    assert.equal(result.ok, true);
    const childEnv = readDumpedEnv(dumpOut);
    for (const key of PICKLE_GATE_SCRUBBED_ENV_KEYS) assert.ok(!(key in childEnv), `${key} must be absent`);
    assert.ok(!('GIT_CONFIG_KEY_0' in childEnv));
    assert.ok(!('GIT_CONFIG_VALUE_0' in childEnv));
    assert.ok(!('GIT_CONFIG_KEY_1' in childEnv));
    assert.ok(!('GIT_CONFIG_VALUE_1' in childEnv));
    for (const key of KEEP_SET) assert.ok(key in childEnv, `${key} must survive`);

    const resolvedTimeout = resolveWorkerTestGateTimeoutMs(undefined, null, childEnv);
    assert.equal(resolvedTimeout, 600_000);
  });
});

test('AC-1: runBetweenTicketFastTests (mux-runner test-gate spawn) scrubs the gate-env keys', async () => {
  const fixtureDir = makeGateFixture();
  await withContaminatedEnv({}, async (dumpOut) => {
    const result = runBetweenTicketFastTests(fixtureDir, fixtureDir);
    assert.equal(result.ok, true);
    const childEnv = readDumpedEnv(dumpOut);
    for (const key of PICKLE_GATE_SCRUBBED_ENV_KEYS) assert.ok(!(key in childEnv), `${key} must be absent`);
    assert.ok(!('GIT_CONFIG_KEY_0' in childEnv));
    assert.ok(!('GIT_CONFIG_VALUE_0' in childEnv));
    for (const key of KEEP_SET) assert.ok(key in childEnv, `${key} must survive`);
  });
});

test('AC-3: the WORKER spawn is NOT scrubbed — backendEnvOverrides still composes GIT_CONFIG_COUNT at n+1 and stamps PICKLE_TICKET_ID', () => {
  const repoRoot = makeGitRepoFixture('gate-env-scrub-worker-');
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-env-scrub-session-'));
  try {
    const env = withScrubbedAmbientEnv(() =>
      backendEnvOverrides('claude', {
        workingDir: repoRoot,
        ticketId: 'worker-ticket-id',
        sessionDir,
        env: { GIT_CONFIG_COUNT: '1' },
      })
    );
    assert.equal(env.GIT_CONFIG_COUNT, '2');
    assert.equal(env.PICKLE_TICKET_ID, 'worker-ticket-id');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-4: every key composed by the trailer fragment is a member of PICKLE_GATE_SCRUBBED_ENV_KEYS', () => {
  const repoRoot = makeGitRepoFixture('gate-env-scrub-worker2-');
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-env-scrub-session2-'));
  try {
    const env = withScrubbedAmbientEnv(() =>
      backendEnvOverrides('claude', {
        workingDir: repoRoot,
        ticketId: 'ticket-id',
        sessionDir,
        env: {},
      })
    );
    // The fragment must actually be composed — an empty env would make the loop below vacuous.
    assert.equal(env.PICKLE_TICKET_ID, 'ticket-id');
    for (const key of Object.keys(env)) {
      if (key === 'PICKLE_BACKEND') continue;
      if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) continue;
      assert.ok(PICKLE_GATE_SCRUBBED_ENV_KEYS.includes(key), `${key} must be a member of PICKLE_GATE_SCRUBBED_ENV_KEYS`);
    }
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('scrubGateEnv deletes keys rather than setting them undefined', () => {
  const result = scrubGateEnv({ ...CONTAMINATION, PATH: '/usr/bin' });
  for (const key of PICKLE_GATE_SCRUBBED_ENV_KEYS) assert.ok(!(key in result));
  assert.ok(!('GIT_CONFIG_KEY_0' in result));
  assert.ok(!('GIT_CONFIG_VALUE_1' in result));
  assert.equal(result.PATH, '/usr/bin');
});

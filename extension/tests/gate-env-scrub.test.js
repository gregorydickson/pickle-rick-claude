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
  GIT_CONFIG_INDEXED_ENV_KEY_RE,
  GIT_CONFIG_COUNT_ENV_VAR,
  PICKLE_TICKET_ID_ENV_VAR,
  scrubGateEnv,
  resolveWorkerTestGateTimeoutMs,
} from '../services/pickle-utils.js';
import { backendEnvOverrides } from '../services/backend-spawn.js';
import { runWorkerGateTestCommand } from '../bin/spawn-morty.js';
import { runBetweenTicketFastTests } from '../bin/mux-runner.js';

// Three indexed pairs, not two: a scrub that hardcodes a `_0`/`_1` list instead of matching
// `GIT_CONFIG_INDEXED_ENV_KEY_RE` over every present key leaks the third pair, and a two-pair
// fixture cannot see that.
const CONTAMINATION = {
  PICKLE_WORKER_TEST_FAST_TIMEOUT_MS: '1800000',
  PICKLE_TICKET_ID: 'contaminated-ticket-id',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/tmp/whatever',
  GIT_CONFIG_KEY_1: 'user.name',
  GIT_CONFIG_VALUE_1: 'contaminated',
  GIT_CONFIG_KEY_2: 'user.email',
  GIT_CONFIG_VALUE_2: 'contaminated@example.invalid',
};

/** Every indexed `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` the fixture carries. */
const CONTAMINATION_INDEXED_KEYS = Object.keys(CONTAMINATION).filter(k =>
  GIT_CONFIG_INDEXED_ENV_KEY_RE.test(k)
);

/**
 * Asserts `env` carries no scrubbed key.
 *
 * The authority for "which keys must be gone" is the FIXTURE (`CONTAMINATION`), not
 * `PICKLE_GATE_SCRUBBED_ENV_KEYS`. AC-5's mutation oracle empties that constant, so a loop driven by
 * it iterates nothing and passes vacuously for exactly the keys the bundle exists to remove — the
 * indexed half was mutation-sensitive only because it already read the fixture. The constant is still
 * asserted afterwards, which is a strictly additional claim: the child must also be free of any
 * production-listed key the fixture happens not to carry.
 *
 * Both length checks are non-vacuity guards: without them a fixture edit that dropped keys would make
 * the loops iterate nothing and pass.
 */
function assertScrubbedKeysAbsent(env, label) {
  const contaminatedKeys = Object.keys(CONTAMINATION);
  assert.equal(contaminatedKeys.length, 12, 'fixture must carry the full contamination set');
  assert.equal(CONTAMINATION_INDEXED_KEYS.length, 6, 'fixture must carry three indexed pairs');
  for (const key of contaminatedKeys) {
    assert.ok(!(key in env), `${key} must be absent from ${label}`);
  }
  for (const key of PICKLE_GATE_SCRUBBED_ENV_KEYS) {
    assert.ok(!(key in env), `${key} must be absent from ${label}`);
  }
}

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
    ...Object.keys(process.env).filter(k => GIT_CONFIG_INDEXED_ENV_KEY_RE.test(k)),
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
    assertScrubbedKeysAbsent(childEnv, 'the gate child env');
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
    assertScrubbedKeysAbsent(childEnv, 'the gate child env');
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
    // Index n, not a hardcoded 0: appending at 0 here would silently overwrite the inherited
    // config's own first entry, and COUNT alone cannot see that.
    assert.equal(env.GIT_CONFIG_KEY_1, 'core.hooksPath');
    assert.ok(!('GIT_CONFIG_KEY_0' in env), 'the pair must be appended at index n, not 0');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// The n=1 case above pins the increment but not the BASE: `String(n + 2)` with an inherited count of
// 1 and `String(n + 1)` with an inherited count of 2 are indistinguishable from a single row. These
// two rows pin the absent-count default (`?? 0` at backend-spawn.ts) and the explicit '0' spelling of
// the same value, and assert the appended pair sits at index n — not n+1, which would collide with
// the inherited config's own last entry.
for (const [label, inherited] of [
  ['GIT_CONFIG_COUNT absent', {}],
  ['GIT_CONFIG_COUNT explicitly "0"', { GIT_CONFIG_COUNT: '0' }],
]) {
  test(`AC-3: the trailer fragment composes n+1 = 1 and appends at index 0 when ${label}`, () => {
    const repoRoot = makeGitRepoFixture('gate-env-scrub-compose0-');
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-env-scrub-session0-'));
    try {
      const env = withScrubbedAmbientEnv(() =>
        backendEnvOverrides('claude', {
          workingDir: repoRoot,
          ticketId: 'compose-zero-ticket-id',
          sessionDir,
          env: inherited,
        })
      );
      // Guards every assertion below: an all-or-nothing `{}` fragment would satisfy the absence
      // checks vacuously.
      assert.equal(env.PICKLE_TICKET_ID, 'compose-zero-ticket-id');
      assert.equal(env.GIT_CONFIG_COUNT, '1');
      assert.equal(env.GIT_CONFIG_KEY_0, 'core.hooksPath');
      assert.equal(typeof env.GIT_CONFIG_VALUE_0, 'string');
      assert.ok(env.GIT_CONFIG_VALUE_0.length > 0, 'GIT_CONFIG_VALUE_0 must name the managed hooks dir');
      assert.ok(!('GIT_CONFIG_KEY_1' in env), 'the pair must be appended at index n, not n+1');
      assert.ok(!('GIT_CONFIG_VALUE_1' in env), 'the pair must be appended at index n, not n+1');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
}

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
      if (GIT_CONFIG_INDEXED_ENV_KEY_RE.test(key)) continue;
      assert.ok(PICKLE_GATE_SCRUBBED_ENV_KEYS.includes(key), `${key} must be a member of PICKLE_GATE_SCRUBBED_ENV_KEYS`);
    }
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// The trailer fragment composes two of its keys from names that must also be scrubbed. When those
// names were derived by a runtime `PICKLE_GATE_SCRUBBED_ENV_KEYS.find(...)!` lookup, dropping either
// key from the array left the derived name `undefined` — still compiling, but composing a computed
// env key that stringifies to the literal "undefined". They are imported bindings now, so that
// removal is a tsc error; these assertions pin the property the import is there to guarantee.
test('the trailer-compose env key names are scrub-list members and never undefined', () => {
  for (const [label, value] of [
    ['PICKLE_TICKET_ID_ENV_VAR', PICKLE_TICKET_ID_ENV_VAR],
    ['GIT_CONFIG_COUNT_ENV_VAR', GIT_CONFIG_COUNT_ENV_VAR],
  ]) {
    assert.equal(typeof value, 'string', `${label} must be a string, got ${typeof value}`);
    assert.ok(value.length > 0, `${label} must be non-empty`);
    assert.ok(
      PICKLE_GATE_SCRUBBED_ENV_KEYS.includes(value),
      `${label} (${value}) must be a member of PICKLE_GATE_SCRUBBED_ENV_KEYS`
    );
  }

  const repoRoot = makeGitRepoFixture('gate-env-scrub-keynames-');
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-env-scrub-session3-'));
  try {
    const env = withScrubbedAmbientEnv(() =>
      backendEnvOverrides('claude', {
        workingDir: repoRoot,
        ticketId: 'keyname-ticket-id',
        sessionDir,
        env: {},
      })
    );
    // Guards the loop below against a `{}` fragment, which would make it vacuous.
    assert.equal(env[PICKLE_TICKET_ID_ENV_VAR], 'keyname-ticket-id');
    for (const key of Object.keys(env)) {
      assert.notEqual(key, 'undefined', 'composed fragment must not carry a key named "undefined"');
    }
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('scrubGateEnv deletes keys rather than setting them undefined', () => {
  const result = scrubGateEnv({ ...CONTAMINATION, PATH: '/usr/bin' });
  assertScrubbedKeysAbsent(result, 'the scrubbed copy');
  assert.equal(result.PATH, '/usr/bin');
});

// GIT_CONFIG_COUNT governs how many indexed pairs the compose site wrote, so it is the field most
// likely to drive a scrub implementation that reads the count instead of matching every present key.
// Three shapes, each built from its own literal (no shared mutable fixture): the count absent
// entirely, the count at '0' with no pairs, and the count at '3' with all three pairs.
for (const [label, input] of [
  [
    'GIT_CONFIG_COUNT absent',
    {
      PICKLE_WORKER_TEST_FAST_TIMEOUT_MS: '1800000',
      PICKLE_TICKET_ID: 'edge-absent',
      GIT_CONFIG_GLOBAL: '/dev/null',
      PATH: '/usr/bin',
    },
  ],
  [
    'GIT_CONFIG_COUNT "0" with no indexed pairs',
    {
      PICKLE_WORKER_TEST_FAST_TIMEOUT_MS: '1800000',
      PICKLE_TICKET_ID: 'edge-zero',
      GIT_CONFIG_COUNT: '0',
      PATH: '/usr/bin',
    },
  ],
  [
    'GIT_CONFIG_COUNT "3" with three indexed pairs',
    {
      PICKLE_TICKET_ID: 'edge-three',
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/tmp/whatever',
      GIT_CONFIG_KEY_1: 'user.name',
      GIT_CONFIG_VALUE_1: 'contaminated',
      GIT_CONFIG_KEY_2: 'user.email',
      GIT_CONFIG_VALUE_2: 'contaminated@example.invalid',
      PATH: '/usr/bin',
    },
  ],
]) {
  test(`scrubGateEnv removes the right key set and never throws: ${label}`, () => {
    const inputKeys = Object.keys(input);
    const doomed = inputKeys.filter(
      k => PICKLE_GATE_SCRUBBED_ENV_KEYS.includes(k) || GIT_CONFIG_INDEXED_ENV_KEY_RE.test(k)
    );
    const survivors = inputKeys.filter(k => !doomed.includes(k));
    // Non-vacuity: both halves of the claim must have something to say.
    assert.ok(doomed.length > 0, 'case must contaminate with at least one scrubbed key');
    assert.deepEqual(survivors, ['PATH'], 'case must carry exactly one surviving key');

    const result = scrubGateEnv(input);

    for (const key of doomed) assert.ok(!(key in result), `${key} must be absent from the scrubbed copy`);
    assert.equal(result.PATH, '/usr/bin', 'a non-pickle key must survive with its exact value');
    // The scrub is a copy: the caller's object is untouched whatever the count says.
    for (const key of inputKeys) assert.ok(key in input, `${key} must still be present on the input`);
    assert.equal(Object.keys(input).length, inputKeys.length, 'input must gain no keys either');
  });
}

// The caller's env object is shared — `mux-runner.ts:649` and `spawn-morty.ts:1330` both call
// `scrubGateEnv()` with the default `process.env`, so a `delete env[k]` implementation would strip
// the launching process's OWN trailer fragment and silently un-attribute every later worker commit.
// The oracle must therefore read the INPUT after the call; asserting on the returned object cannot
// distinguish copy-then-delete from delete-in-place.
test('scrubGateEnv does not mutate its input', () => {
  const fixture = { ...CONTAMINATION, PATH: '/usr/bin' };
  const before = Object.entries(fixture);
  assert.ok(before.length > 0, 'fixture must be non-empty');

  const result = scrubGateEnv(fixture);

  assert.notEqual(result, fixture, 'scrubGateEnv must return a copy, not the caller\'s object');
  for (const [key, value] of before) {
    assert.ok(key in fixture, `${key} must still be present on the input`);
    assert.equal(fixture[key], value, `${key} must keep its original value on the input`);
  }
  assert.equal(Object.keys(fixture).length, before.length, 'input must gain no keys either');
});

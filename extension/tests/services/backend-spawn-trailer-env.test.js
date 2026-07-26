// @tier: fast
//
// B-GITATTR WS-1 (ticket cb36a189, §4b "Producer — env injection at spawn"): proves
// `backendEnvOverrides` extends the existing spawn-env seam (does not add a parallel one) to
// emit the `core.hooksPath` + `PICKLE_TICKET_ID` env fragment, all-or-nothing, composing with
// any inherited `GIT_CONFIG_COUNT` without ever hardcoding index 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { backendEnvOverrides, __resetBackendWarnings } from '../../services/backend-spawn.js';
import { buildWorkerSpawnEnv } from '../../bin/spawn-morty.js';
import { createIterationSpawnEnv } from '../../bin/mux-runner.js';

const GIT_TIMEOUT_MS = 10_000;

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitRepo(dir) {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, timeout: GIT_TIMEOUT_MS });
}

function cleanDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- Both keys injected (worker invocation with a ticket) ---

test('backendEnvOverrides: worker invocation with a ticket injects core.hooksPath + PICKLE_TICKET_ID', () => {
  const workingDir = mkTmpDir('trailer-env-worker-');
  const sessionDir = mkTmpDir('trailer-env-session-');
  try {
    initGitRepo(workingDir);

    const env = backendEnvOverrides('claude', {
      workingDir,
      ticketId: 'abc12345',
      sessionDir,
      env: {},
    });

    assert.equal(env.PICKLE_BACKEND, 'claude');
    assert.equal(env.GIT_CONFIG_COUNT, '1');
    assert.equal(env.GIT_CONFIG_KEY_0, 'core.hooksPath');
    assert.equal(typeof env.GIT_CONFIG_VALUE_0, 'string');
    assert.equal(env.GIT_CONFIG_VALUE_0.startsWith(sessionDir), true);
    assert.equal(env.PICKLE_TICKET_ID, 'abc12345');
  } finally {
    cleanDir(workingDir);
    cleanDir(sessionDir);
  }
});

// --- Count composition ---

test('backendEnvOverrides: inherited GIT_CONFIG_COUNT=2 composes at index 2, leaving 0/1 untouched', () => {
  const workingDir = mkTmpDir('trailer-env-count-');
  const sessionDir = mkTmpDir('trailer-env-count-session-');
  try {
    initGitRepo(workingDir);

    const inherited = {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'Foo',
      GIT_CONFIG_KEY_1: 'user.email',
      GIT_CONFIG_VALUE_1: 'foo@bar.com',
    };

    const env = backendEnvOverrides('claude', {
      workingDir,
      ticketId: 'count0002',
      sessionDir,
      env: inherited,
    });

    assert.equal(env.GIT_CONFIG_COUNT, '3');
    assert.equal(env.GIT_CONFIG_KEY_2, 'core.hooksPath');
    assert.equal(typeof env.GIT_CONFIG_VALUE_2, 'string');
    // The fragment must NOT emit indices 0/1 — merging it over the inherited env leaves
    // those entries byte-identical.
    assert.equal('GIT_CONFIG_KEY_0' in env, false);
    assert.equal('GIT_CONFIG_VALUE_0' in env, false);
    assert.equal('GIT_CONFIG_KEY_1' in env, false);
    assert.equal('GIT_CONFIG_VALUE_1' in env, false);
  } finally {
    cleanDir(workingDir);
    cleanDir(sessionDir);
  }
});

// --- No hardcoded index 0 ---

test('backendEnvOverrides: never hardcodes GIT_CONFIG_KEY_0 when an inherited entry already occupies it', () => {
  const workingDir = mkTmpDir('trailer-env-idx0-');
  const sessionDir = mkTmpDir('trailer-env-idx0-session-');
  try {
    initGitRepo(workingDir);

    const inherited = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name' };

    const env = backendEnvOverrides('claude', {
      workingDir,
      ticketId: 'idx00001',
      sessionDir,
      env: inherited,
    });

    // GIT_CONFIG_KEY_0 must still resolve to the inherited value after merge — the fragment
    // itself carries no key at index 0.
    assert.equal('GIT_CONFIG_KEY_0' in env, false);
    assert.equal(env.GIT_CONFIG_KEY_1, 'core.hooksPath');
    assert.equal(env.GIT_CONFIG_COUNT, '2');
  } finally {
    cleanDir(workingDir);
    cleanDir(sessionDir);
  }
});

// --- All-or-nothing ---

test('backendEnvOverrides: materialization failure emits neither key and logs once', () => {
  const notARepo = mkTmpDir('trailer-env-norepo-');
  const sessionDir = mkTmpDir('trailer-env-norepo-session-');
  const originalWrite = process.stderr.write;
  let writeCount = 0;
  process.stderr.write = (chunk, ...rest) => {
    writeCount += 1;
    return originalWrite.call(process.stderr, chunk, ...rest);
  };
  __resetBackendWarnings();
  try {
    const env1 = backendEnvOverrides('claude', {
      workingDir: notARepo,
      ticketId: 'noop0001',
      sessionDir,
      env: {},
    });

    assert.equal(env1.PICKLE_BACKEND, 'claude');
    assert.equal('PICKLE_TICKET_ID' in env1, false);
    assert.equal('GIT_CONFIG_COUNT' in env1, false);
    assert.equal('GIT_CONFIG_KEY_0' in env1, false);
    assert.equal(writeCount, 1);

    // Same failure reason again — dedupe suppresses a second log line.
    backendEnvOverrides('claude', { workingDir: notARepo, ticketId: 'noop0002', sessionDir, env: {} });
    assert.equal(writeCount, 1);
  } finally {
    process.stderr.write = originalWrite;
    __resetBackendWarnings();
    cleanDir(notARepo);
    cleanDir(sessionDir);
  }
});

// --- Null ticket ---

test('backendEnvOverrides: null ticketId omits PICKLE_TICKET_ID and skips materialization entirely', () => {
  const workingDir = mkTmpDir('trailer-env-nullticket-');
  const sessionDir = mkTmpDir('trailer-env-nullticket-session-');
  try {
    initGitRepo(workingDir);

    const env = backendEnvOverrides('claude', {
      workingDir,
      ticketId: null,
      sessionDir,
      env: {},
    });

    assert.equal(env.PICKLE_BACKEND, 'claude');
    assert.equal('PICKLE_TICKET_ID' in env, false);
    assert.equal('GIT_CONFIG_COUNT' in env, false);
    assert.equal('GIT_CONFIG_KEY_0' in env, false);
    // Short-circuit happens before touching the filesystem.
    assert.equal(fs.existsSync(path.join(sessionDir, 'git-trailer-hooks')), false);
  } finally {
    cleanDir(workingDir);
    cleanDir(sessionDir);
  }
});

// --- Real worker + manager spawn-env construction (ticket cb36a189 DEFECT 2 fix) ---
//
// The prior "manager parity" case called `backendEnvOverrides('claude', opts)` twice with the
// identical `opts` object and asserted the two results equal each other — a tautology that would
// pass even if neither real spawn site ever wired `trailerOpts` through. These cases instead
// exercise the ACTUAL env-construction functions used at the real worker spawn
// (`spawn-morty.ts:runWorkerProcess` via the exported `buildWorkerSpawnEnv` seam) and the real
// manager iteration spawn (`mux-runner.ts:runIteration` via the exported `createIterationSpawnEnv`
// seam), proving the wiring at cb36a189's two call sites is live.

test('buildWorkerSpawnEnv (real worker spawn path): ticket in flight injects core.hooksPath + PICKLE_TICKET_ID', () => {
  const workingDir = mkTmpDir('trailer-env-realworker-');
  const sessionDir = mkTmpDir('trailer-env-realworker-session-');
  try {
    initGitRepo(workingDir);

    const ctx = {
      args: { backend: 'claude' },
      sessionRoot: sessionDir,
      sessionWorkingDir: workingDir,
      ticketId: 'realworker1',
      timeoutStatePath: null,
      workerStatePath: path.join(sessionDir, 'worker-state.json'),
    };
    const env = buildWorkerSpawnEnv(ctx, { cmd: 'claude', args: [], backend: 'claude' });

    assert.equal(env.GIT_CONFIG_KEY_0, 'core.hooksPath');
    assert.equal(typeof env.GIT_CONFIG_VALUE_0, 'string');
    assert.equal(env.GIT_CONFIG_COUNT, '1');
    assert.equal(env.PICKLE_TICKET_ID, 'realworker1');
  } finally {
    cleanDir(workingDir);
    cleanDir(sessionDir);
  }
});

test('buildWorkerSpawnEnv (real worker spawn path): no ticket in flight injects neither key', () => {
  const workingDir = mkTmpDir('trailer-env-realworker-null-');
  const sessionDir = mkTmpDir('trailer-env-realworker-null-session-');
  try {
    initGitRepo(workingDir);

    const ctx = {
      args: { backend: 'claude' },
      sessionRoot: sessionDir,
      sessionWorkingDir: workingDir,
      ticketId: null,
      timeoutStatePath: null,
      workerStatePath: path.join(sessionDir, 'worker-state.json'),
    };
    const env = buildWorkerSpawnEnv(ctx, { cmd: 'claude', args: [], backend: 'claude' });

    assert.equal('PICKLE_TICKET_ID' in env, false);
    assert.equal('GIT_CONFIG_COUNT' in env, false);
    assert.equal('GIT_CONFIG_KEY_0' in env, false);
  } finally {
    cleanDir(workingDir);
    cleanDir(sessionDir);
  }
});

test('createIterationSpawnEnv (real manager spawn path): ticket in flight injects core.hooksPath + PICKLE_TICKET_ID', () => {
  const workingDir = mkTmpDir('trailer-env-realmanager-');
  const sessionDir = mkTmpDir('trailer-env-realmanager-session-');
  try {
    initGitRepo(workingDir);

    const state = { working_dir: workingDir, current_ticket: 'realmanager1' };
    const invocation = { cmd: 'claude', args: [], backend: 'claude' };
    const statePath = path.join(sessionDir, 'state.json');
    const env = createIterationSpawnEnv(state, 'claude', invocation, statePath, {}, sessionDir);

    assert.equal(env.GIT_CONFIG_KEY_0, 'core.hooksPath');
    assert.equal(typeof env.GIT_CONFIG_VALUE_0, 'string');
    assert.equal(env.GIT_CONFIG_COUNT, '1');
    assert.equal(env.PICKLE_TICKET_ID, 'realmanager1');
  } finally {
    cleanDir(workingDir);
    cleanDir(sessionDir);
  }
});

test('createIterationSpawnEnv (real manager spawn path): no ticket in flight injects neither key', () => {
  const workingDir = mkTmpDir('trailer-env-realmanager-null-');
  const sessionDir = mkTmpDir('trailer-env-realmanager-null-session-');
  try {
    initGitRepo(workingDir);

    const state = { working_dir: workingDir, current_ticket: null };
    const invocation = { cmd: 'claude', args: [], backend: 'claude' };
    const statePath = path.join(sessionDir, 'state.json');
    const env = createIterationSpawnEnv(state, 'claude', invocation, statePath, {}, sessionDir);

    assert.equal('PICKLE_TICKET_ID' in env, false);
    assert.equal('GIT_CONFIG_COUNT' in env, false);
    assert.equal('GIT_CONFIG_KEY_0' in env, false);
  } finally {
    cleanDir(workingDir);
    cleanDir(sessionDir);
  }
});

// --- Regression: existing single-arg call sites are unaffected ---

test('backendEnvOverrides: no trailerOpts arg preserves existing PICKLE_BACKEND-only behavior', () => {
  const env = backendEnvOverrides('codex');
  assert.deepEqual(env, { PICKLE_BACKEND: 'codex' });
});

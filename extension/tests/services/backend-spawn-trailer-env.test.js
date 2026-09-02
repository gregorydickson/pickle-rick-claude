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
import {
  backendEnvOverrides,
  buildWorkerInvocation,
  buildManagerInvocation,
  AddDirOutsideSandboxError,
  __resetBackendWarnings,
} from '../../services/backend-spawn.js';
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

/**
 * Runs `fn` with our OWN spawn fragment stripped from `process.env`.
 *
 * The cases below that exercise the real spawn seams pass no explicit `env`, so they read
 * ambient `process.env` — and `buildWorkerSpawnEnv`/`createIterationSpawnEnv` additionally
 * spread `...process.env` into their result. Once this bundle is deployed, every worker's
 * ambient env carries `GIT_CONFIG_COUNT=1` + `PICKLE_TICKET_ID`, so those cases would assert
 * `KEY_0`/`COUNT === '1'` and get `KEY_1`/`'2'`, and the null-ticket cases would see the
 * inherited keys present. That is a `@tier: fast` file false-REDing the worker lint gate on
 * unrelated tickets (recorded as BLOCKER 4 in docs/gitattr-live-run-evidence.md §9).
 *
 * Safe: `node --test` runs one process per FILE, so this mutation cannot reach a sibling file.
 */
function withCleanTrailerEnv(fn) {
  const stripped = Object.keys(process.env).filter(
    (k) => k === 'PICKLE_TICKET_ID' || /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k),
  );
  const saved = new Map(stripped.map((k) => [k, process.env[k]]));
  for (const k of stripped) delete process.env[k];
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) process.env[k] = v;
  }
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
    const env = withCleanTrailerEnv(() =>
      buildWorkerSpawnEnv(ctx, { cmd: 'claude', args: [], backend: 'claude' }),
    );

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
    const env = withCleanTrailerEnv(() =>
      buildWorkerSpawnEnv(ctx, { cmd: 'claude', args: [], backend: 'claude' }),
    );

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
    const env = withCleanTrailerEnv(() =>
      createIterationSpawnEnv(state, 'claude', invocation, statePath, {}, sessionDir),
    );

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
    const env = withCleanTrailerEnv(() =>
      createIterationSpawnEnv(state, 'claude', invocation, statePath, {}, sessionDir),
    );

    assert.equal('PICKLE_TICKET_ID' in env, false);
    assert.equal('GIT_CONFIG_COUNT' in env, false);
    assert.equal('GIT_CONFIG_KEY_0' in env, false);
  } finally {
    cleanDir(workingDir);
    cleanDir(sessionDir);
  }
});

// --- The nested-spawn shape the four cases above deliberately strip ---
//
// Stripping the ambient fragment keeps those cases honest, but the stripped state is not the
// state a deployed worker runs in. This case asserts the real nested shape instead of leaving
// it untested: a worker spawned from a manager that already exported the fragment must compose
// at the NEXT index and re-key PICKLE_TICKET_ID to the ticket actually in flight.

test('buildWorkerSpawnEnv: a spawn nested under an inherited fragment composes at the next index', () => {
  const workingDir = mkTmpDir('trailer-env-nested-');
  const sessionDir = mkTmpDir('trailer-env-nested-session-');
  const saved = {
    GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
    GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
    GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
    PICKLE_TICKET_ID: process.env.PICKLE_TICKET_ID,
  };
  try {
    initGitRepo(workingDir);

    // What the manager exported on the outer spawn.
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
    process.env.GIT_CONFIG_VALUE_0 = path.join(sessionDir, 'git-trailer-hooks');
    process.env.PICKLE_TICKET_ID = 'outerticket';

    const ctx = {
      args: { backend: 'claude' },
      sessionRoot: sessionDir,
      sessionWorkingDir: workingDir,
      ticketId: 'innerticket',
      timeoutStatePath: null,
      workerStatePath: path.join(sessionDir, 'worker-state.json'),
    };
    const env = buildWorkerSpawnEnv(ctx, { cmd: 'claude', args: [], backend: 'claude' });

    assert.equal(env.GIT_CONFIG_COUNT, '2');
    assert.equal(env.GIT_CONFIG_KEY_1, 'core.hooksPath');
    assert.equal(env.GIT_CONFIG_KEY_0, 'core.hooksPath', 'inherited index 0 is left untouched');
    // The ticket in flight wins over whatever the parent was working on.
    assert.equal(env.PICKLE_TICKET_ID, 'innerticket');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    cleanDir(workingDir);
    cleanDir(sessionDir);
  }
});

// --- Regression: existing single-arg call sites are unaffected ---

test('backendEnvOverrides: no trailerOpts arg preserves existing PICKLE_BACKEND-only behavior', () => {
  const env = backendEnvOverrides('codex');
  assert.deepEqual(env, { PICKLE_BACKEND: 'codex' });
});

// --- AP-EXT-ITER9-01: the R-WSRC-4 sandbox assertion covers EVERY worker arm ---
//
// It used to live inside `buildClaudeWorkerInvocation`, so the codex arm — which
// appends the same `--add-dir` list to `codex exec
// --dangerously-bypass-approvals-and-sandbox` — built an argv pointed at the
// operator's real repo with no complaint. Assert the ARGV, not just "did it
// throw": the pre-fix codex arm returned successfully AND carried the repo path,
// so a throw-only oracle on the claude arm greens over the whole defect.
//
// These cases live in this file because it is the only in-fence backend-spawn
// test file for this session's scope.json; move them beside the other R-WSRC-4
// cases in `tests/backend-spawn-add-dir-sandbox.test.js` when a fence carries it.

function withTestMode(fn) {
  const prev = process.env.PICKLE_TEST_MODE;
  process.env.PICKLE_TEST_MODE = '1';
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.PICKLE_TEST_MODE;
    else process.env.PICKLE_TEST_MODE = prev;
  }
}

const ADD_DIR_ARMS = ['claude', 'codex', 'deepseek'];

for (const backend of ADD_DIR_ARMS) {
  test(`AP-EXT-ITER9-01: ${backend} worker arm refuses an out-of-tmpdir --add-dir under PICKLE_TEST_MODE`, () => {
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
    const saved = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'test-key';
    try {
      withTestMode(() => {
        let invocation = null;
        assert.throws(
          () => { invocation = buildWorkerInvocation(backend, { prompt: 'p', addDirs: [repoRoot] }); },
          AddDirOutsideSandboxError,
        );
        assert.equal(invocation, null, 'no argv may be built for an out-of-sandbox addDir');
      });
    } finally {
      if (saved === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = saved;
    }
  });
}

test('AP-EXT-ITER9-01: a tmpdir-rooted --add-dir still builds on the codex arm', () => {
  const sandbox = mkTmpDir('ap-iter9-sandbox-');
  try {
    withTestMode(() => {
      const invocation = buildWorkerInvocation('codex', { prompt: 'p', addDirs: [sandbox] });
      assert.equal(invocation.backend, 'codex');
      assert.ok(invocation.args.includes('--add-dir'));
      assert.ok(invocation.args.includes(sandbox));
    });
  } finally {
    cleanDir(sandbox);
  }
});

// Phase 2.5 replay: `buildManagerInvocation` carries the same `--add-dir
// <workingDir>` under the same bypass-permissions flags and is still UNGUARDED.
// The guard was built and reverted this pass — it reddens a fence-blocked
// fixture; this case pins the CURRENT (defective) behavior so the gap is visible
// rather than silent, and flips to a refusal assertion when the fix lands.
test('AP-EXT-ITER9-01 (replay, OPEN GAP): the manager dispatcher does NOT yet assert', () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
  withTestMode(() => {
    const invocation = buildManagerInvocation('claude', { prompt: 'p', addDirs: [repoRoot] });
    assert.ok(
      invocation.args.includes(repoRoot),
      'OPEN GAP: the manager argv still carries an out-of-sandbox --add-dir',
    );
  });
});

test('AP-EXT-ITER9-01: PICKLE_TEST_MODE unset is a production passthrough on the codex arm', () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
  const prev = process.env.PICKLE_TEST_MODE;
  delete process.env.PICKLE_TEST_MODE;
  try {
    const invocation = buildWorkerInvocation('codex', { prompt: 'p', addDirs: [repoRoot] });
    assert.ok(invocation.args.includes(repoRoot));
  } finally {
    if (prev !== undefined) process.env.PICKLE_TEST_MODE = prev;
  }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER147-01 — the R-CSI session stamp is DIAGNOSTIC ONLY, and its own
// prose has to say so.
//
// `sessionStampEnv` writes PICKLE_SESSION / PICKLE_WORKING_DIR at two spawn
// sites; its docstring claimed both were "read back by kill/reaping paths to
// scope targets to this session only". No such reader exists, and `git log -S`
// finds none in the whole history — the claim was false at birth (`45d9659d`).
// Real scoping is `shouldIsolateSessionGroup()` + `orphan-reaper.ts`'s argv
// `--add-dir` attribution.
//
// Two-sided on purpose, so it can never become a brake on a real feature: while
// the stamp has zero readers the prose MUST mark it diagnostic-only, and the
// moment a reader lands the prose MUST stop saying that. Either way the code and
// the sentence move together.
// ---------------------------------------------------------------------------

const STAMP_KEYS = ['PICKLE_SESSION', 'PICKLE_WORKING_DIR'];
/** `PICKLE_SESSION` must not match `PICKLE_SESSION_ROOT` (a live, unrelated var). */
const stampKeyRe = (key) => new RegExp(`${key}(?![A-Z0-9_])`);
/**
 * The two lines that WRITE the stamp — the producer, never a reader. Anchored on
 * the assignment, not the surrounding `if`, so reformatting the guard does not
 * red this file; a RENAME of either key still does.
 */
const STAMP_WRITE_RE = /\benv\.(PICKLE_SESSION|PICKLE_WORKING_DIR)(?![A-Z0-9_])\s*=[^=]/;

function extensionRootDir() {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
}

/** Tracked `.ts` under extension/src, the way git owns them. */
function trackedSrcTsFiles() {
  const extensionDir = extensionRootDir();
  const out = execFileSync('git', ['ls-files', '--', 'src'], {
    cwd: extensionDir,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
  });
  return out.split('\n').filter(f => f.endsWith('.ts')).map(f => path.join(extensionDir, f));
}

/**
 * Every non-comment line under extension/src that mentions a stamp key and is not
 * the write itself. Comment stripping is line-shaped (`//`, `*`, `/*`), which is
 * why the docstring above — which names both keys — does not count as a reader.
 */
function stampReaderLines() {
  const hits = [];
  for (const file of trackedSrcTsFiles()) {
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      if (!STAMP_KEYS.some(k => stampKeyRe(k).test(line))) return;
      if (STAMP_WRITE_RE.test(line)) return;
      hits.push(`${path.basename(file)}:${i + 1}: ${trimmed}`);
    });
  }
  return hits;
}

test('AP-EXT-ITER147-01: the session stamp has no runtime reader, and its prose matches', () => {
  const source = fs.readFileSync(
    path.join(extensionRootDir(), 'src/services/backend-spawn.ts'),
    'utf-8',
  );

  // Non-vacuity: a rename that moved the producer would make `readers` empty for
  // the wrong reason, so prove the write site is still where we think it is.
  const writeLines = source.split('\n').filter(l => STAMP_WRITE_RE.test(l));
  assert.equal(writeLines.length, 2, 'both stamp writes must still be in backend-spawn.ts');
  assert.ok(trackedSrcTsFiles().length > 50, 'src corpus must be non-empty');

  const readers = stampReaderLines();
  if (readers.length === 0) {
    assert.ok(
      /DIAGNOSTIC ONLY/.test(source),
      'stamp has zero readers — sessionStampEnv must be documented DIAGNOSTIC ONLY',
    );
    assert.ok(
      !/read back\s*\n?\s*\*?\s*by kill\/reaping paths/.test(source),
      'stamp has zero readers — the docstring must not claim kill/reap paths read it',
    );
  } else {
    assert.ok(
      !/DIAGNOSTIC ONLY/.test(source),
      `stamp now has ${readers.length} reader(s) — drop the DIAGNOSTIC ONLY wording and `
        + `describe what reads it:\n${readers.join('\n')}`,
    );
  }
});

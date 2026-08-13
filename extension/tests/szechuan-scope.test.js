// @tier: fast
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setupSzechuanSauce } from '../bin/pipeline-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '..', 'bin', 'init-microverse.js');
const SZECHUAN_MD = path.resolve(__dirname, '../../.claude/commands/szechuan-sauce.md');
// R-CIFB: resolve the extension root from the REPO (not the deployed
// ~/.claude/pickle-rick), so setupSzechuanSauce spawns extension/bin/init-microverse.js
// from the repo. CI never runs install.sh, so the deployed path is absent there
// (was the dominant chronic-CI-red failure: init-microverse.js MODULE_NOT_FOUND).
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');
const CHECK_SCOPE_DIFF = path.resolve(__dirname, '..', 'bin', 'check-scope-diff.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'szechuan-scope-'));
}

function run(args, expectError = false) {
  // 10s → 30s: budget for system load when run alongside concurrent
  // codex/tmux work. Tests validate CLI behavior, not wall-clock.
  const opts = { stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 };
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], opts);
    return { code: 0, stdout: stdout.toString(), stderr: '' };
  } catch (err) {
    if (!expectError) throw err;
    return {
      code: err.status,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

function readMicroverse(sessionDir) {
  return JSON.parse(fs.readFileSync(path.join(sessionDir, 'microverse.json'), 'utf-8'));
}

// ---------------------------------------------------------------------------
// Injection: scope.json present → microverse.json.allowed_paths present
// ---------------------------------------------------------------------------

describe('szechuan scope injection', () => {
  test('scope.json present → microverse.json has allowed_paths', () => {
    const dir = makeTempDir();
    try {
      const scopeJson = {
        allowed_paths: ['src/foo.ts', 'src/bar.ts'],
        mode: 'diff',
        strategy: 'changed-files',
        head_sha: 'abc123',
      };
      fs.writeFileSync(path.join(dir, 'scope.json'), JSON.stringify(scopeJson));
      run([dir, '/some/target', '--allowed-paths-file', path.join(dir, 'scope.json')]);
      const state = readMicroverse(dir);
      assert.deepStrictEqual(state.allowed_paths, ['src/foo.ts', 'src/bar.ts']);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Backcompat: no scope.json → no allowed_paths in microverse.json
  // ---------------------------------------------------------------------------

  test('no --allowed-paths-file → microverse.json has no allowed_paths', () => {
    const dir = makeTempDir();
    try {
      run([dir, '/some/target']);
      const state = readMicroverse(dir);
      assert.equal(state.allowed_paths, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Empty allowed_paths → not injected (backcompat: avoids confusing worker)
  // ---------------------------------------------------------------------------

  test('scope.json with empty allowed_paths → microverse.json has no allowed_paths', () => {
    const dir = makeTempDir();
    try {
      const scopeJson = { allowed_paths: [], mode: 'diff', strategy: 'changed-files', head_sha: 'abc123' };
      fs.writeFileSync(path.join(dir, 'scope.json'), JSON.stringify(scopeJson));
      run([dir, '/some/target', '--allowed-paths-file', path.join(dir, 'scope.json')]);
      const state = readMicroverse(dir);
      assert.equal(state.allowed_paths, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test('resume: persisted scope.json still injects allowed_paths when phase setup reruns without an explicit scope arg', () => {
    const dir = makeTempDir();
    try {
      fs.writeFileSync(
        path.join(dir, 'scope.json'),
        JSON.stringify({ allowed_paths: ['src/foo.ts'], mode: 'diff', strategy: 'strict', head_sha: 'abc123' }),
      );

      const ok = setupSzechuanSauce(dir, '/some/target', 5, EXTENSION_ROOT, undefined, undefined, () => {});
      assert.equal(ok, true, 'setup should succeed');

      const state = readMicroverse(dir);
      assert.deepStrictEqual(state.allowed_paths, ['src/foo.ts']);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test('resume: persisted scope.json promotes newer dead tmp before injecting allowed_paths', () => {
    const dir = makeTempDir();
    try {
      const scopePath = path.join(dir, 'scope.json');
      fs.writeFileSync(
        scopePath,
        JSON.stringify({ allowed_paths: ['src/stale.ts'], mode: 'diff', strategy: 'strict', head_sha: 'old' }),
      );
      fs.writeFileSync(
        `${scopePath}.tmp.99999999`,
        JSON.stringify({ allowed_paths: ['src/live.ts'], mode: 'diff', strategy: 'strict', head_sha: 'new' }),
      );
      fs.utimesSync(`${scopePath}.tmp.99999999`, new Date(Date.now() + 1_000), new Date(Date.now() + 1_000));

      const ok = setupSzechuanSauce(dir, '/some/target', 5, EXTENSION_ROOT, undefined, undefined, () => {});
      assert.equal(ok, true, 'setup should succeed');

      const state = readMicroverse(dir);
      assert.deepStrictEqual(state.allowed_paths, ['src/live.ts']);
      assert.equal(fs.existsSync(`${scopePath}.tmp.99999999`), false);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Override 3 marker: scope-hook present in szechuan-sauce.md
  // ---------------------------------------------------------------------------

  test('Override 3 scope-hook marker present in szechuan-sauce.md', () => {
    const content = fs.readFileSync(SZECHUAN_MD, 'utf-8');
    assert.ok(
      content.includes('<!-- scope-hook: override-3-allowed-paths -->'),
      'szechuan-sauce.md must contain Override 3 scope-hook marker',
    );
  });

  // ---------------------------------------------------------------------------
  // Override 2 marker: scope-invariant present in szechuan-sauce.md
  // ---------------------------------------------------------------------------

  test('Override 2 scope-invariant marker present in szechuan-sauce.md', () => {
    const content = fs.readFileSync(SZECHUAN_MD, 'utf-8');
    assert.ok(
      content.includes('<!-- scope-invariant: override-2-grep-spans-full-repo -->'),
      'szechuan-sauce.md must contain Override 2 scope-invariant marker',
    );
  });

  // ---------------------------------------------------------------------------
  // Step 8 wiring: --allowed-paths-file referenced after Step 7 in szechuan-sauce.md
  // ---------------------------------------------------------------------------

  test('R-FGNC-5: szechuan-sauce iteration loop runs lint autofix before commit', () => {
    const content = fs.readFileSync(SZECHUAN_MD, 'utf-8');
    const iterIdx = content.indexOf('### Each subsequent iteration');
    assert.ok(iterIdx > 0, '"Each subsequent iteration" section must exist');
    const section = content.slice(iterIdx, iterIdx + 1200);
    assert.match(section, /R-FGNC-5/, 'the iteration loop must carry the R-FGNC-5 lint-autofix step');
    assert.match(section, /lint autofix|lint:fix|--fix/i, 'the step must instruct a lint-autofix run');
    const fixIdx = section.search(/lint autofix/i);
    const commitIdx = section.indexOf('. Commit');
    assert.ok(fixIdx > 0 && commitIdx > fixIdx, 'the lint-autofix step must come BEFORE the commit step');
  });

  test('Step 8 references --allowed-paths-file after Step 7 (scope wiring for standalone mode)', () => {
    const content = fs.readFileSync(SZECHUAN_MD, 'utf-8');
    const step7Idx = content.indexOf('### Step 7: Resolve Scope');
    const step8Idx = content.indexOf('### Step 8: Create microverse.json');
    const flagIdx = content.indexOf('--allowed-paths-file');
    assert.ok(step7Idx > 0, 'Step 7 heading must exist in szechuan-sauce.md');
    assert.ok(step8Idx > step7Idx, 'Step 8 must come after Step 7');
    assert.ok(
      flagIdx > step7Idx,
      '--allowed-paths-file must appear after Step 7 so scope.json has been written before init-microverse is invoked',
    );
  });

  // ---------------------------------------------------------------------------
  // R-PSSS-2: code-free (doc-only) scope is skipped with an operator-visible WARN
  // ---------------------------------------------------------------------------

  test('R-PSSS-2: szechuan-sauce skips a code-free (doc-only) scope with a WARN', () => {
    const dir = makeTempDir();
    try {
      fs.writeFileSync(
        path.join(dir, 'scope.json'),
        JSON.stringify({ allowed_paths: ['docs/guide.md', 'CHANGELOG.md'], mode: 'diff', strategy: 'strict', head_sha: 'abc' }),
      );
      const logs = [];
      const ok = setupSzechuanSauce(dir, '/some/target', 5, EXTENSION_ROOT, undefined, undefined, (m) => logs.push(m));
      assert.deepStrictEqual(ok, { skipReason: 'empty_scope' }, 'szechuan must skip a code-free scope');
      const warn = logs.join('\n');
      assert.match(warn, /⚠ szechuan-sauce did not run/);
      assert.match(warn, /no code files/);
      assert.equal(
        fs.existsSync(path.join(dir, 'microverse.json')), false,
        'init-microverse must NOT be spawned on an empty-scope skip',
      );
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test('R-PSSS-2: szechuan-sauce proceeds when the scope has at least one code file', () => {
    const dir = makeTempDir();
    try {
      fs.writeFileSync(
        path.join(dir, 'scope.json'),
        JSON.stringify({ allowed_paths: ['docs/guide.md', 'src/real.ts'], mode: 'diff', strategy: 'strict', head_sha: 'abc' }),
      );
      const ok = setupSzechuanSauce(dir, '/some/target', 5, EXTENSION_ROOT, undefined, undefined, () => {});
      assert.equal(ok, true, 'a scope with >=1 code file must NOT skip');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC-BUNDLE-APWS-02: worker-simulation — check-scope-diff rejects out-of-scope staged paths
// ---------------------------------------------------------------------------

test('AC-BUNDLE-APWS-02: check-scope-diff rejects out-of-scope staged paths in worker simulation', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'szws-scope-sim-')));
  const dataRoot = path.join(tmp, 'data');
  const ticketId = 'test-ticket-apws8';

  try {
    // Init temp git repo
    spawnSync('git', ['init', '-q'], { cwd: tmp, timeout: 5_000 });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp, timeout: 5_000 });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmp, timeout: 5_000 });

    // Write scope.json with three allowed prefixes
    const scopePath = path.join(tmp, 'scope.json');
    fs.writeFileSync(scopePath, JSON.stringify({ allowed_paths: ['alpha/', 'beta/', 'gamma/'] }));

    // Stage in-scope file
    fs.mkdirSync(path.join(tmp, 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'alpha', 'x.ts'), 'export const x = 1;\n');
    spawnSync('git', ['add', 'alpha/x.ts'], { cwd: tmp, timeout: 5_000 });

    // Stage out-of-scope file
    fs.mkdirSync(path.join(tmp, 'outside'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'outside', 'leaked.ts'), 'export const leaked = true;\n');
    spawnSync('git', ['add', 'outside/leaked.ts'], { cwd: tmp, timeout: 5_000 });

    // Spawn check-scope-diff.js against the temp repo with isolated PICKLE_DATA_ROOT
    const result = spawnSync(
      process.execPath,
      [CHECK_SCOPE_DIFF, '--scope-json', scopePath, '--ticket-id', ticketId],
      {
        encoding: 'utf-8',
        timeout: 10_000,
        cwd: tmp,
        env: { ...process.env, PICKLE_DATA_ROOT: dataRoot },
      },
    );

    // Assert 1: exit status 1 (outside_scope)
    assert.equal(result.status, 1, `expected exit 1; stderr: ${result.stderr}`);

    // Assert 2: stdout parses to outside_scope shape with outside/leaked.ts
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.status, 'outside_scope');
    assert.ok(
      Array.isArray(parsed.staged_paths_outside_scope) &&
        parsed.staged_paths_outside_scope.includes('outside/leaked.ts'),
      `staged_paths_outside_scope must include 'outside/leaked.ts'; got ${JSON.stringify(parsed.staged_paths_outside_scope)}`,
    );

    // Assert 3+4+5: worker_edit_outside_scope activity event in isolated data root
    const activityDir = path.join(dataRoot, 'activity');
    const jsonlFiles = fs.existsSync(activityDir)
      ? fs.readdirSync(activityDir).filter((f) => f.endsWith('.jsonl'))
      : [];
    const events = [];
    for (const f of jsonlFiles) {
      const content = fs.readFileSync(path.join(activityDir, f), 'utf-8');
      for (const line of content.split('\n').filter(Boolean)) {
        try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
    }
    const scopeEvents = events.filter((e) => e.event === 'worker_edit_outside_scope');
    assert.equal(scopeEvents.length, 1, `expected 1 worker_edit_outside_scope event; got ${scopeEvents.length}`);

    const ev = scopeEvents[0];
    assert.equal(ev.ticket_id, ticketId, 'ticket_id must round-trip into the event');
    assert.ok(
      Array.isArray(ev.gate_payload?.staged_paths_outside_scope) &&
        ev.gate_payload.staged_paths_outside_scope.includes('outside/leaked.ts'),
      `gate_payload.staged_paths_outside_scope must include 'outside/leaked.ts'`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// WS-B (AC-B1 / AC-B2): an empty BRANCH DIFF ends the phase with its own reason;
// an unscoped run with a real branch diff still runs.
// ---------------------------------------------------------------------------

function initEmptyDiffRepo() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'szechuan-emptydiff-')));
  const git = (args) => spawnSync('git', args, { cwd: repo, timeout: 10_000 });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@test.local']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'seed.ts'), 'export const seed = 1;\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'seed']);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8', timeout: 10_000 })
    .stdout.trim();
  return { repo, git, head };
}

/**
 * The emptiness fact is measured against the SESSION baseline (`start_commit`),
 * so the phase setup needs a state.json to read it from.
 */
function writeSessionState(sessionDir, repo, startCommit) {
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    active: false,
    working_dir: repo,
    step: 'implement',
    iteration: 0,
    max_iterations: 100,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 'ws-b szechuan scope test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 3,
    tmux_mode: false,
    chain_meeseeks: false,
    backend: 'claude',
    start_commit: startCommit,
  }, null, 2));
}

function readSkipEvents(dataRoot) {
  const activityDir = path.join(dataRoot, 'activity');
  if (!fs.existsSync(activityDir)) return [];
  const events = [];
  for (const f of fs.readdirSync(activityDir).filter((n) => n.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(activityDir, f), 'utf-8').split('\n').filter(Boolean)) {
      try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
  }
  return events.filter((e) => e.event === 'szechuan_sauce_empty_scope_skip');
}

function withDataRoot(dataRoot, fn) {
  const prior = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prior;
  }
}

test('AC-B1: an empty branch diff skips szechuan-sauce with empty_branch_diff + a WARN naming the diff', () => {
  const { repo, head } = initEmptyDiffRepo();
  const dir = makeTempDir();
  const dataRoot = path.join(dir, 'data');
  try {
    writeSessionState(dir, repo, head); // nothing authored since the session baseline
    const logs = [];
    const result = withDataRoot(dataRoot, () =>
      setupSzechuanSauce(dir, repo, 5, EXTENSION_ROOT, undefined, undefined, (m) => logs.push(m)));

    assert.deepStrictEqual(
      result, { skipReason: 'empty_branch_diff' },
      'an empty branch diff must skip with its OWN reason, not empty_scope',
    );
    const warn = logs.join('\n');
    assert.match(warn, /⚠ szechuan-sauce did not run/);
    assert.match(warn, /branch diff is empty/);
    assert.equal(
      fs.existsSync(path.join(dir, 'microverse.json')), false,
      'init-microverse must NOT be spawned on an empty-branch-diff skip',
    );

    const events = readSkipEvents(dataRoot);
    assert.equal(events.length, 1, `expected 1 skip event; got ${events.length}`);
    assert.equal(events[0].gate_payload.branch_diff_empty, true);
    assert.deepStrictEqual(events[0].gate_payload.in_scope_paths, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('AC-B2: an unscoped run with a NON-empty branch diff still runs szechuan-sauce', () => {
  const { repo, git, head } = initEmptyDiffRepo();
  const dir = makeTempDir();
  const dataRoot = path.join(dir, 'data');
  try {
    writeSessionState(dir, repo, head);
    git(['checkout', '-q', '-b', 'feature']);
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'real.ts'), 'export const real = 2;\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'branch work']);

    const result = withDataRoot(dataRoot, () =>
      setupSzechuanSauce(dir, repo, 5, EXTENSION_ROOT, undefined, undefined, () => {}));

    assert.equal(result, true, 'an unscoped run with a real branch diff must NOT skip');
    assert.deepStrictEqual(readSkipEvents(dataRoot), [], 'no skip event may be emitted when the phase runs');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

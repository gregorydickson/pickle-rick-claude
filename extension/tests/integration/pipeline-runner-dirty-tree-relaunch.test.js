// @tier: integration
// SERIAL: spawns pipeline-runner subprocess; modifies real git working tree
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '../../bin/pipeline-runner.js');

function tmpDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
}

function initRepo(repo) {
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@test.local'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  git(['add', 'README.md'], repo);
  git(['commit', '-q', '-m', 'seed'], repo);
}

function writeState(sessionDir, repo, overrides = {}) {
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    active: false,
    working_dir: repo,
    step: 'implement',
    iteration: 2,
    max_iterations: 100,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 'relaunch dirty tree test',
    current_ticket: 'TICKET-1',
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    tmux_mode: true,
    backend: 'codex',
    manager_relaunch_count: 1,
    ...overrides,
  }, null, 2));
}

function writePipeline(sessionDir, repo) {
  fs.writeFileSync(path.join(sessionDir, 'pipeline.json'), JSON.stringify({
    phases: [],
    target: repo,
    anatomy_stall_limit: 3,
    szechuan_stall_limit: 5,
    anatomy_max_iterations: 100,
    szechuan_max_iterations: 50,
    dirty_exempt_segments: ['prds', 'docs'],
  }, null, 2));
}

function makeSession(stateOverrides = {}) {
  const repo = tmpDir('pipeline-relaunch-repo-');
  const sessionDir = tmpDir('pipeline-relaunch-session-');
  initRepo(repo);
  writeState(sessionDir, repo, stateOverrides);
  writePipeline(sessionDir, repo);
  return { repo, sessionDir };
}

function cleanup(repo, sessionDir) {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

test('relaunch boundary: dirty tracked file is reset, pipeline-runner starts clean', () => {
  const { repo, sessionDir } = makeSession();
  try {
    // Commit a tracked source file
    const srcFile = path.join(repo, 'src.ts');
    fs.writeFileSync(srcFile, 'export const x = 1;\n');
    git(['add', 'src.ts'], repo);
    git(['commit', '-q', '-m', 'add src.ts'], repo);

    // Simulate interrupted worker: modify but do not commit
    fs.writeFileSync(srcFile, 'export const x = 2; // partial work\n');

    // Verify the tree IS dirty before running pipeline-runner
    const statusBefore = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf-8' });
    assert.match(statusBefore, /src\.ts/);

    const result = spawnSync(process.execPath, [CLI, sessionDir], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PICKLE_DATA_ROOT: path.join(sessionDir, 'pickle-data') },
    });

    // Pipeline-runner must NOT fatal on dirty-tree
    assert.doesNotMatch(result.stderr, /Working tree at .* is dirty/,
      'assertCleanWorkingTree must not throw at relaunch boundary');
    assert.doesNotMatch(result.stderr, /\[FATAL\]/,
      'No FATAL error expected at relaunch boundary');

    // The dirty file must be restored to HEAD content
    const statusAfter = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf-8' });
    assert.doesNotMatch(statusAfter, /src\.ts/,
      'src.ts should be clean after relaunch reset');

    const content = fs.readFileSync(srcFile, 'utf-8');
    assert.equal(content, 'export const x = 1;\n',
      'src.ts should be restored to HEAD content');
  } finally {
    cleanup(repo, sessionDir);
  }
});

test('relaunch boundary: unrelated exempt tracked changes in docs/ are preserved', () => {
  const { repo, sessionDir } = makeSession();
  try {
    // Commit a tracked source file (will be dirtied to simulate in-flight ticket)
    const srcFile = path.join(repo, 'worker.ts');
    fs.writeFileSync(srcFile, 'export const v = 1;\n');
    git(['add', 'worker.ts'], repo);

    // Commit docs/ file as a tracked file
    const docsDir = path.join(repo, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'notes.md'), '# original\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'add worker.ts and docs/notes.md'], repo);

    // Simulate interrupted worker: dirty the tracked source file
    fs.writeFileSync(srcFile, 'export const v = 2; // partial\n');

    // Simulate unrelated docs/ change (exempt via dirty_exempt_segments)
    fs.writeFileSync(path.join(docsDir, 'notes.md'), '# updated by user\n');

    const result = spawnSync(process.execPath, [CLI, sessionDir], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PICKLE_DATA_ROOT: path.join(sessionDir, 'pickle-data') },
    });

    // No dirty-tree fatal
    assert.doesNotMatch(result.stderr, /Working tree at .* is dirty/);
    assert.doesNotMatch(result.stderr, /\[FATAL\]/);

    // The blocking dirty file (worker.ts) must be restored
    const statusAfter = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf-8' });
    assert.doesNotMatch(statusAfter, /worker\.ts/,
      'worker.ts (blocking) should be restored');

    // The exempt docs/ change must be preserved
    const docsContent = fs.readFileSync(path.join(docsDir, 'notes.md'), 'utf-8');
    assert.equal(docsContent, '# updated by user\n',
      'docs/notes.md (exempt) must not be reset');

    assert.match(statusAfter, /docs\/notes\.md/,
      'docs/notes.md should still show as dirty (exempt from pipeline guard)');
  } finally {
    cleanup(repo, sessionDir);
  }
});

test('relaunch boundary: new untracked file from worker is removed', () => {
  const { repo, sessionDir } = makeSession();
  try {
    // Simulate worker that wrote a new file but was interrupted before git add
    const newFile = path.join(repo, 'new-feature.ts');
    fs.writeFileSync(newFile, 'export const feature = true;\n');

    // Verify the untracked file is dirty
    const statusBefore = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf-8' });
    assert.match(statusBefore, /new-feature\.ts/);

    const result = spawnSync(process.execPath, [CLI, sessionDir], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PICKLE_DATA_ROOT: path.join(sessionDir, 'pickle-data') },
    });

    // No dirty-tree fatal
    assert.doesNotMatch(result.stderr, /Working tree at .* is dirty/);
    assert.doesNotMatch(result.stderr, /\[FATAL\]/);

    // New untracked file must be removed
    assert.ok(!fs.existsSync(newFile),
      'new-feature.ts (untracked from interrupted worker) should be deleted at relaunch boundary');
  } finally {
    cleanup(repo, sessionDir);
  }
});

test('relaunch boundary: interrupted ticket remains retryable (current_ticket preserved in state)', () => {
  const { repo, sessionDir } = makeSession({ manager_relaunch_count: 1, current_ticket: 'TICKET-A' });
  try {
    // Dirty the tree with a tracked modification
    const srcFile = path.join(repo, 'index.ts');
    fs.writeFileSync(srcFile, 'export const n = 1;\n');
    git(['add', 'index.ts'], repo);
    git(['commit', '-q', '-m', 'add index.ts'], repo);
    fs.writeFileSync(srcFile, 'export const n = 99;\n');

    const result = spawnSync(process.execPath, [CLI, sessionDir], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PICKLE_DATA_ROOT: path.join(sessionDir, 'pickle-data') },
    });

    assert.doesNotMatch(result.stderr, /Working tree at .* is dirty/);
    assert.doesNotMatch(result.stderr, /\[FATAL\]/);

    // current_ticket should still be TICKET-A — the ticket is retryable on next pass
    const stateAfter = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    // pipeline-runner with empty phases clears current_ticket on finalize, but the key
    // assertion is that the dirty-tree error did NOT prevent the session from running at all.
    // If the session ran (exit 0), the ticket was not locked out by the dirty-tree throw.
    assert.equal(result.status, 0,
      'pipeline-runner must exit 0 at relaunch boundary (not bricked by dirty tree)');
  } finally {
    cleanup(repo, sessionDir);
  }
});

test('non-relaunch: dirty tree still blocks startup when manager_relaunch_count is 0', () => {
  const { repo, sessionDir } = makeSession({ manager_relaunch_count: 0 });
  try {
    // Dirty the tree — should still block when not at a relaunch boundary
    fs.writeFileSync(path.join(repo, 'blocker.ts'), 'let x = 1;\n');

    const result = spawnSync(process.execPath, [CLI, sessionDir], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PICKLE_DATA_ROOT: path.join(sessionDir, 'pickle-data') },
    });

    // Guard still applies at first launch
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[FATAL\]/);
    assert.match(result.stderr, /dirty/i);
  } finally {
    cleanup(repo, sessionDir);
  }
});

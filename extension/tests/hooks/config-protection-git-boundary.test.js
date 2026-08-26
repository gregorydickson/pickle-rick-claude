// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execAnchorIndex, isShellWrapper, splitShellSegments, tokenizeShellTokens } from '../../hooks/shell-exec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HANDLER = path.resolve(__dirname, '../../hooks/handlers/config-protection.js');

function writeExtensionSentinel(extensionDir) {
  const sentinelDir = path.join(extensionDir, 'extension', 'bin');
  fs.mkdirSync(sentinelDir, { recursive: true });
  fs.writeFileSync(path.join(sentinelDir, 'log-watcher.js'), '');
}

function baseState(overrides = {}) {
  return {
    active: true,
    working_dir: process.cwd(),
    step: 'implement',
    iteration: 1,
    max_iterations: 5,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000) - 30,
    completion_promise: null,
    original_prompt: 'test task',
    current_ticket: 'test-ticket-01',
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/pickle-test',
    tmux_mode: false,
    ...overrides,
  };
}

function bootstrapSession({ flags } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-git-'));
  writeExtensionSentinel(tmpDir);
  const sessionDir = path.join(tmpDir, 'sessions', 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  const stateFile = path.join(sessionDir, 'state.json');
  const state = baseState({ session_dir: sessionDir });
  if (flags) state.flags = flags;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fs.writeFileSync(
    path.join(tmpDir, 'current_sessions.json'),
    JSON.stringify({ [process.cwd()]: sessionDir }),
  );
  return { tmpDir, sessionDir, stateFile, dataRoot: tmpDir };
}

function runHandler({ tmpDir, stateFile, toolName, toolInput, extraEnv = {} }) {
  const env = {
    ...process.env,
    EXTENSION_DIR: tmpDir,
    PICKLE_DATA_ROOT: tmpDir,
    PICKLE_STATE_FILE: stateFile,
    FORCE_COLOR: '0',
    ...extraEnv,
  };
  const input = JSON.stringify({ tool_name: toolName, tool_input: toolInput });
  const stdout = execFileSync(process.execPath, [HANDLER], {
    input,
    encoding: 'utf-8',
    env,
  });
  return JSON.parse(stdout.trim());
}

function readActivityEvents(dataRoot) {
  const activityDir = path.join(dataRoot, 'activity');
  if (!fs.existsSync(activityDir)) return [];
  const events = [];
  for (const file of fs.readdirSync(activityDir)) {
    if (!file.endsWith('.jsonl')) continue;
    const content = fs.readFileSync(path.join(activityDir, file), 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Block cases — worker context (PICKLE_ROLE=worker)
// ---------------------------------------------------------------------------

test('R-WSRC-GR: worker blocks git reset --hard HEAD~1', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git reset --hard HEAD~1' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-WSRC-GR/);
  assert.match(result.reason, /reset/);
});

test('R-WSRC-GR: worker blocks git reset (bare)', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git reset HEAD file.ts' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-WSRC-GR/);
});

test('R-WSRC-GR: worker blocks git reset --soft HEAD~1', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git reset --soft HEAD~1' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-GR: worker blocks git checkout feature-branch (ref)', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git checkout feature-branch' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /checkout/);
});

test('R-WSRC-GR: worker blocks git checkout -b new-branch (ref after flag)', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git checkout -b new-branch' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-GR: worker blocks git checkout HEAD~1 (ref)', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git checkout HEAD~1' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-GR: worker blocks git switch main', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git switch main' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /switch/);
});

test('R-WSRC-GR: worker blocks git stash (bare)', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git stash' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /stash/);
});

test('R-WSRC-GR: worker blocks git stash push', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git stash push' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-GR: worker blocks git stash pop', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git stash pop' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-GR: worker blocks git rebase main', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git rebase main' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /rebase/);
});

test('R-WSRC-GR: worker blocks git commit --amend', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: "git commit --amend -m 'fix: update message'" },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /commit --amend/);
});

test('R-WSRC-GR: worker blocks git commit --amend --no-edit', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git commit --amend --no-edit' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-GR: worker blocks git pull origin main', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git pull origin main' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /pull/);
});

test('R-WSRC-GR: worker blocks git push origin main', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git push origin main' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /push/);
});

test('R-WSRC-GR: worker blocks git push (bare)', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git push' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-GR: worker blocks git fetch --prune', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git fetch --prune' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /fetch --prune/);
});

test('R-WSRC-GR: worker blocks git fetch origin --prune', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git fetch origin --prune' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
});

// ---------------------------------------------------------------------------
// Allowed variants — worker context (PICKLE_ROLE=worker)
// ---------------------------------------------------------------------------

test('R-WSRC-GR: worker approves git add <path>', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git add src/foo.ts' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR: worker approves git commit -m without --amend', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: "git commit -m 'feat: add new thing'" },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR: worker approves git restore <path>', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git restore src/foo.ts' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR: worker approves git restore --source HEAD~1 --staged --worktree <path>', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git restore --source HEAD~1 --staged --worktree src/foo.ts' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR: worker approves git fetch without --prune', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git fetch' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR: worker approves git fetch origin (no --prune)', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git fetch origin' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR: worker approves git checkout -- src/foo.ts (path-mode)', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git checkout -- src/foo.ts' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR: worker approves git checkout . (whole-tree restore)', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git checkout .' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR: worker approves git log --oneline', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git log --oneline' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR: worker approves git status', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git status' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR: worker approves git diff', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git diff' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

// ---------------------------------------------------------------------------
// Manager context (PICKLE_ROLE not set) — NOT blocked
// ---------------------------------------------------------------------------

test('R-WSRC-GR: manager context approves git reset --hard HEAD~1', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  // Manager: PICKLE_ROLE is deleted from env (not set to 'worker')
  const env = {
    ...process.env,
    EXTENSION_DIR: tmpDir,
    PICKLE_DATA_ROOT: tmpDir,
    PICKLE_STATE_FILE: stateFile,
    FORCE_COLOR: '0',
  };
  delete env.PICKLE_ROLE;
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git reset --hard HEAD~1' } });
  const stdout = execFileSync(process.execPath, [HANDLER], {
    input, encoding: 'utf-8', env,
  });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR: manager context approves git push origin main', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const env = {
    ...process.env,
    EXTENSION_DIR: tmpDir,
    PICKLE_DATA_ROOT: tmpDir,
    PICKLE_STATE_FILE: stateFile,
    FORCE_COLOR: '0',
  };
  delete env.PICKLE_ROLE;
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin main' } });
  const stdout = execFileSync(process.execPath, [HANDLER], {
    input, encoding: 'utf-8', env,
  });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.decision, 'approve');
});

// ---------------------------------------------------------------------------
// Operator override path (AC-WSRC-GR-05)
// ---------------------------------------------------------------------------

test('R-WSRC-GR: allow_git_reset_reason bypasses git reset block and emits worker_git_reset_bypass', () => {
  const { tmpDir, stateFile, dataRoot } = bootstrapSession({
    flags: { allow_git_reset_reason: 'schema migration' },
  });
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git reset --hard HEAD~1' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');

  const events = readActivityEvents(dataRoot).filter((e) => e.event === 'worker_git_reset_bypass');
  assert.equal(events.length, 1, 'expected exactly one worker_git_reset_bypass event');
  assert.equal(events[0].gate_payload.reason, 'schema migration');
  assert.equal(typeof events[0].gate_payload.command, 'string');
});

test('R-WSRC-GR: empty allow_git_reset_reason does NOT bypass', () => {
  const { tmpDir, stateFile } = bootstrapSession({
    flags: { allow_git_reset_reason: '   ' },
  });
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git reset --hard HEAD~1' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-GR: allow_git_push_reason bypasses git push block', () => {
  const { tmpDir, stateFile } = bootstrapSession({
    flags: { allow_git_push_reason: 'emergency hotfix deploy' },
  });
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git push origin main' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR: allow_git_commit_amend_reason bypasses git commit --amend block', () => {
  const { tmpDir, stateFile } = bootstrapSession({
    flags: { allow_git_commit_amend_reason: 'fix author' },
  });
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git commit --amend --no-edit' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR: allow_git_fetch_prune_reason bypasses git fetch --prune block', () => {
  const { tmpDir, stateFile } = bootstrapSession({
    flags: { allow_git_fetch_prune_reason: 'cleanup stale refs' },
  });
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git fetch --prune' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

// ---------------------------------------------------------------------------
// Non-Bash tools — always approve (not affected by git boundary rules)
// ---------------------------------------------------------------------------

test('R-WSRC-GR: Write tool with git-like path is not affected', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Write',
    toolInput: { file_path: '/project/src/reset.ts' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

// ---------------------------------------------------------------------------
// R-WSRC-GR-LEAK (#76) regression — refinement-worker MUST also be blocked
// ---------------------------------------------------------------------------

test('R-WSRC-GR-LEAK: refinement-worker blocks git reset --hard HEAD~1', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git reset --hard HEAD~1' },
    extraEnv: { PICKLE_ROLE: 'refinement-worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-WSRC-GR/);
  assert.match(result.reason, /reset/);
});

test('R-WSRC-GR-LEAK: refinement-worker blocks git push', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git push origin main' },
    extraEnv: { PICKLE_ROLE: 'refinement-worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-WSRC-GR/);
});

test('R-WSRC-GR-LEAK: unknown role passes through (no over-blocking)', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git reset --hard HEAD~1' },
    extraEnv: { PICKLE_ROLE: 'auditor-readonly' },
  });
  assert.equal(result.decision, 'approve');
});

// ---------------------------------------------------------------------------
// Chained-command bypass (cfgprot-chained-command-forbidden-op-bypass)
// The CLAUDE.md-mandated `cd <subdir> && git <verb>` pattern must NOT bypass
// the worker-forbidden-op guards. Prohibited verbs in ANY chained segment block.
// ---------------------------------------------------------------------------

test('R-WSRC-GR chained: worker blocks `cd extension && git reset --hard HEAD~1`', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'cd extension && git reset --hard HEAD~1' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-WSRC-GR/);
  assert.match(result.reason, /reset/);
});

test('R-WSRC-GR chained: worker blocks `git status && git push origin main`', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git status && git push origin main' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /push/);
});

test('R-WSRC-GR chained: worker blocks `cd sub ; git rebase main`', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'cd sub ; git rebase main' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /rebase/);
});

test('R-WSRC-GR chained: refinement-worker blocks `cd x && git stash`', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'cd x && git stash' },
    extraEnv: { PICKLE_ROLE: 'refinement-worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /stash/);
});

test('R-WSRC-GR chained: quoted commit message with `&& git reset` is NOT a bypass trigger (approve)', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: "git commit -m 'fix && git reset bug'" },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR chained: legitimate `cd extension && git add src/foo.ts` still approves', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'cd extension && git add src/foo.ts' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

// R-PIPE-3 / R-WSRC: install.sh chaining (Phase 2.5 replay match of the same
// first-segment-only detection shape).
test('R-WSRC install.sh chained: worker blocks `cd x && bash install.sh`', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'cd x && bash install.sh' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /install\.sh/);
});

// R-CSIS-B1: expensive-tier `node --test <file>` chaining (Phase 2.5 replay
// match — same leading-command-only detection shape). `cd x && node --test
// <expensive>` must still be blocked, else the RUN_EXPENSIVE_TESTS skip guard
// is bypassed and the soak re-runs unconditionally (timeout→relaunch loop).
test('R-CSIS-B1 chained: worker blocks `cd extension && node --test <expensive>`', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  fs.writeFileSync(path.join(tmpDir, 'soak.test.js'), '// @tier: expensive\n');
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'cd extension && node --test soak.test.js' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-CSIS-B1/);
});

// AP-EXT-EXECFOLD replay: the expensive-test guard read a RAW `tokens[idx] !==
// 'node'`, so a case- or path-varied interpreter slipped it while the identical
// lowercase bare-name form blocked. Same fold as every other exec-token compare.
test('AP-EXT-EXECFOLD replay: worker blocks case/path-varied `node --test <expensive>`', () => {
  for (const command of [
    'NODE --test soak.test.js',
    '/usr/bin/node --test soak.test.js',
    'cd extension && NODE --test soak.test.js',
    'PICKLE_ROLE=worker /usr/local/bin/node --test soak.test.js',
  ]) {
    const { tmpDir, stateFile } = bootstrapSession();
    fs.writeFileSync(path.join(tmpDir, 'soak.test.js'), '// @tier: expensive\n');
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', JSON.stringify(command));
    assert.match(result.reason, /R-CSIS-B1/);
  }
});

// AP-EXT-ITER46-01: the expensive-test guard was the LAST detector in the file
// still tokenizing with a bare `split(/\s+/)`, the residual the AP-EXT-EXECFOLD
// trap door left open. A quoted token keeps its quotes under a bare split, so the
// extracted destination (`"soak.test.js"`) does not exist on disk,
// `isExpensiveTestFile` fails its read, and the guard APPROVES the soak — while
// the byte-identical unquoted twin BLOCKS. Measured pre-fix: 4 of 7 forms
// approved. Each form below is one the shell runs exactly as `node --test
// soak.test.js`, so every one must block.
test('AP-EXT-ITER46-01: worker blocks quoted `node --test <expensive>` in every shell-equivalent form', () => {
  for (const command of [
    'node --test "soak.test.js"',
    "node --test 'soak.test.js'",
    'node "--test" soak.test.js',
    '"node" --test soak.test.js',
    "'node' --test 'soak.test.js'",
    'cd extension && node --test "soak.test.js"',
    'PICKLE_ROLE=worker "/usr/bin/node" --test "soak.test.js"',
  ]) {
    const { tmpDir, stateFile } = bootstrapSession();
    fs.writeFileSync(path.join(tmpDir, 'soak.test.js'), '// @tier: expensive\n');
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', JSON.stringify(command));
    assert.match(result.reason, /R-CSIS-B1/);
  }
});

// The quote-aware tokenizer must not invent a block: a quoted string that merely
// CONTAINS the invocation is data, never an exec, so it stays approved.
test('AP-EXT-ITER46-01: a quoted `node --test <expensive>` that is an ARGUMENT stays approved', () => {
  for (const command of [
    'echo "node --test soak.test.js"',
    "git commit -m 'node --test soak.test.js'",
  ]) {
    const { tmpDir, stateFile } = bootstrapSession();
    fs.writeFileSync(path.join(tmpDir, 'soak.test.js'), '// @tier: expensive\n');
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'approve', JSON.stringify(command));
  }
});

// AP-EXT-ITER54-02: the replay of AP-EXT-ITER54-01 into this file's expensive-test
// guard. `extractNodeTestPathFromSegment` returned the FIRST bare word after
// `--test`, but node options take OPERANDS and an operand is a bare word standing
// before the positional paths — so the scan stopped on `spec`/`smoke`/`4`,
// `isExpensiveTestFile` failed its read on that non-path, and the guard APPROVED
// the soak while the operand-free twin blocked. Measured pre-fix: 8 of 12 forms
// approved. Every form below runs the expensive soak, so every one must block.
test('AP-EXT-ITER54-02: worker blocks `node --test <expensive>` when an option OPERAND precedes the path', () => {
  for (const command of [
    'node --test --test-reporter spec soak.test.js',
    'node --test --test-name-pattern smoke soak.test.js',
    'node --test --test-concurrency 4 soak.test.js',
    'node --test --test-shard 1/2 soak.test.js',
    'node --test --test-timeout 60000 soak.test.js',
    'node --test --test-reporter tap --test-concurrency 2 soak.test.js',
    'cd extension && node --test --test-reporter spec soak.test.js',
    'PICKLE_ROLE=worker /usr/bin/node --test --test-reporter spec "soak.test.js"',
  ]) {
    const { tmpDir, stateFile } = bootstrapSession();
    fs.writeFileSync(path.join(tmpDir, 'soak.test.js'), '// @tier: expensive\n');
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', JSON.stringify(command));
    assert.match(result.reason, /R-CSIS-B1/);
  }
});

// AP-EXT-ITER54-02, second axis: returning the FIRST bare word also lost the
// expensive path when an earlier POSITIONAL was benign. `node --test <ok> <soak>`
// runs both files, so the soak must still block.
test('AP-EXT-ITER54-02: worker blocks a multi-path `node --test` where only a LATER path is expensive', () => {
  for (const command of [
    'node --test benign.test.js soak.test.js',
    'node --test --test-reporter spec benign.test.js soak.test.js',
  ]) {
    const { tmpDir, stateFile } = bootstrapSession();
    fs.writeFileSync(path.join(tmpDir, 'benign.test.js'), '// @tier: fast\n');
    fs.writeFileSync(path.join(tmpDir, 'soak.test.js'), '// @tier: expensive\n');
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', JSON.stringify(command));
    assert.match(result.reason, /R-CSIS-B1/);
  }
});

// The widened candidate scan must not invent a block: an option operand is only
// a candidate, and a candidate only blocks when it names a real expensive-tier
// file. Non-expensive test runs stay approved in every operand form.
test('AP-EXT-ITER54-02: `node --test` over non-expensive files stays approved with operands present', () => {
  for (const command of [
    'node --test benign.test.js',
    'node --test --test-reporter spec benign.test.js',
    'node --test --test-concurrency 4 benign.test.js',
    'node --test --test-name-pattern soak benign.test.js',
  ]) {
    const { tmpDir, stateFile } = bootstrapSession();
    fs.writeFileSync(path.join(tmpDir, 'benign.test.js'), '// @tier: fast\n');
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'approve', JSON.stringify(command));
  }
});

// Shape pin: the extractor must collect EVERY bare word after `--test` and hand
// the whole list to the caller. A `return t` inside that scan — or an enumerated
// operand-taking-option table, the AP-EXT-ITER18-01/ITER19-01 incomplete-set
// shape — reintroduces AP-EXT-ITER54-02 one option name at a time.
test('AP-EXT-ITER54-02: extractNodeTestPathsFromSegment collects all candidates, no operand table', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../src/hooks/handlers/config-protection.ts'),
    'utf-8',
  );
  const body = source.slice(
    source.indexOf('function extractNodeTestPathsFromSegment'),
    source.indexOf('function extractNodeTestPaths('),
  );
  assert.ok(body.length > 0, 'extractNodeTestPathsFromSegment must exist');
  assert.ok(
    body.includes('candidates.push(t)'),
    'extractor must accumulate every bare word after --test, not return the first',
  );
  assert.ok(
    !/\breturn t\b/.test(body) && !/\bbreak\b/.test(body),
    'extractor must not return or break out of the scan on the first bare word',
  );
  assert.match(
    body,
    /'--test'/,
    'extractor keys on the --test flag itself',
  );
  // File-wide, not body-scoped: an operand table hoisted to module scope is the
  // same incomplete-set shape, just parked one indent out of the extractor.
  assert.equal(
    (source.match(/'--test[a-z-]+'/g) || []).length,
    0,
    'config-protection.ts must not enumerate operand-taking node options (incomplete-set shape)',
  );
});

test('R-CSIS-B1: recommended `RUN_EXPENSIVE_TESTS=1 npm run test:expensive` is NOT blocked', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'RUN_EXPENSIVE_TESTS=1 npm run test:expensive' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

// ---------------------------------------------------------------------------
// Newline-separated bypass (cfgprot-newline-segment-bypass)
// An unquoted newline is a top-level shell command terminator (identical to
// `;`). A worker naturally emits sequential commands one per line, so a
// prohibited verb on ANY line must block — not just the first. Pre-fix the
// tokenizer swallowed newlines as whitespace, collapsing every line into one
// segment whose first git verb was benign, hiding `git reset --hard`.
// ---------------------------------------------------------------------------

test('R-WSRC-GR newline: worker blocks `git status\\ngit reset --hard HEAD~1`', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git status\ngit reset --hard HEAD~1' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-WSRC-GR/);
  assert.match(result.reason, /reset/);
});

test('R-WSRC-GR newline: worker blocks multi-line `git add\\ngit commit\\ngit reset --hard`', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git add -A\ngit commit -m wip\ngit reset --hard HEAD~2' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /reset/);
});

test('R-WSRC-GR newline: worker blocks `git status\\ngit push origin main`', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git status\ngit push origin main' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /push/);
});

// Quote-aware: a real newline INSIDE a quoted commit message must NOT split,
// so a commit body that mentions "reset" is not mis-flagged as a reset op.
test('R-WSRC-GR newline: quoted multi-line commit message with "reset" is NOT a bypass trigger (approve)', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git commit -m "line one\nline two does a reset of state"' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR newline: legitimate `git add src/foo.ts\\ngit commit -m ok` still approves', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git add src/foo.ts\ngit commit -m ok' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

// Replay consumers of splitShellSegments: install.sh + expensive node --test
test('R-WSRC install.sh newline: worker blocks `cd x\\nbash install.sh`', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'cd x\nbash install.sh' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /install\.sh/);
});

test('R-CSIS-B1 newline: worker blocks `cd extension\\nnode --test <expensive>`', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  fs.writeFileSync(path.join(tmpDir, 'soak.test.js'), '// @tier: expensive\n');
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'cd extension\nnode --test soak.test.js' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-CSIS-B1/);
});

// R-WSRC-GR option-arg: `findGitVerb` must skip git global options that consume
// the following token (`git -C <path> reset`), else the value is mistaken for
// the verb and the destructive op slips the guard (proven null pre-fix).
test('R-WSRC-GR -C: worker blocks `git -C extension reset --hard HEAD~1`', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git -C extension reset --hard HEAD~1' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-WSRC-GR/);
  assert.match(result.reason, /reset/);
});

test('R-WSRC-GR -c: worker blocks `git -c x=y push origin main`', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git -c x=y push origin main' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /push/);
});

test('R-WSRC-GR -C chained: worker blocks `cd extension && git -C . reset --hard`', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'cd extension && git -C . reset --hard HEAD~1' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /reset/);
});

test('R-WSRC-GR -C: worker approves `git -C extension checkout -- src/foo.ts` (path-mode preserved)', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git -C extension checkout -- src/foo.ts' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR -C: worker approves `git -C extension commit -m wip` (non-prohibited verb preserved)', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: "git -C extension commit -m 'wip'" },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

// The shell strips quotes around a verb, so `git "reset" --hard` runs as
// `git reset --hard`. findGitVerb's bare split(/\s+/) read the token `"reset"`
// (quotes attached) → not in PROHIBITED_GIT_VERBS_SIMPLE → the destructive
// reset slipped the guard. tokenizeGitCommand now strips matching quotes,
// mirroring tsc-gate.ts:segmentIsGitCommit (which already strips them).
test('R-WSRC-GR quoted-verb: worker blocks `git "reset" --hard HEAD~1`', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git "reset" --hard HEAD~1' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-WSRC-GR/);
  assert.match(result.reason, /reset/);
});

test("R-WSRC-GR quoted-verb: worker blocks `git 'push' origin main`", () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: "git 'push' origin main" },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /push/);
});

test('R-WSRC-GR quoted-verb chained: worker blocks `cd extension && git "reset" --hard`', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'cd extension && git "reset" --hard HEAD~1' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /reset/);
});

// The shell also strips quotes around the EXECUTABLE, so `"git" reset` runs as
// `git reset`. The then-current gate's bare split read the token `"git"`, so
// detectProhibitedGitVerb skipped the segment (`"git"` !== 'git') and the reset
// slipped the guard — the quoted-executable twin of the quoted-verb bypass.
// That gate is gone (AP-EXT-ITER63-02); the exec-anchor read carries the case.
test('R-WSRC-GR quoted-exec: worker blocks `"git" reset --hard HEAD~1`', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: '"git" reset --hard HEAD~1' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /reset/);
});

test("R-WSRC-GR quoted-exec: worker blocks `'git' push origin main`", () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: "'git' push origin main" },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /push/);
});

test('R-WSRC-GR quoted-verb: worker still approves quoted commit message containing reset', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: "git commit -m 'fix reset bug'" },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER10-01 — `bash -c '<cmd>'` command-string unwrap
//
// The segment tokenizer preserves a quoted span as ONE token, so for
// `bash -c "git reset --hard"` the only executable the leading-command
// detectors ever saw was the `-c` FLAG: execTokenIndex skipped the `bash`
// wrapper and landed on `-c`, `execName('-c') !== 'git'`, and the destructive
// reset was APPROVED while the bare `git reset --hard` blocked. The sibling
// state-write gate never had this gap — its tokenizer splits ON quotes, so
// `bash -c "echo x > state.json"` always blocked. A one-sided parity gap.
//
// Each block case is paired with its bare-form twin (already covered above) and
// with a benign `bash -c` case, so these cannot pass by blanket-blocking any
// command containing `bash -c`.
// ---------------------------------------------------------------------------

for (const { label, command, expect: expected } of [
  { label: 'git reset --hard (double-quoted)', command: 'bash -c "git reset --hard"', expect: /reset/ },
  { label: 'git reset --hard (single-quoted)', command: "bash -c 'git reset --hard'", expect: /reset/ },
  { label: 'sh -c git push', command: 'sh -c "git push origin main"', expect: /push/ },
  { label: 'bash -lc git stash', command: 'bash -lc "git stash"', expect: /stash/ },
  { label: 'absolute-path bash -c', command: '/bin/bash -c "git reset --hard"', expect: /reset/ },
  { label: 'env-prefixed bash -c', command: 'PICKLE_ROLE=x bash -c "git rebase main"', expect: /rebase/ },
  { label: 'chained inside the payload', command: 'bash -c "cd sub && git push origin main"', expect: /push/ },
]) {
  test(`AP-EXT-ITER10-01: worker blocks prohibited git verb via ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block');
    assert.match(result.reason, /R-WSRC-GR/);
    assert.match(result.reason, expected);
  });
}

// The unwrap lands at the shared `splitShellSegments` seam, so the install.sh
// detector inherits it too — pinned here so a future per-detector "fix" that
// unwraps only the git chain is caught.
test('AP-EXT-ITER10-01: worker blocks `bash -c "bash install.sh"`', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'bash -c "bash install.sh"' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-WSRC/);
});

// Non-tautology guards: the unwrap must not blanket-block `bash -c`, and must
// stay scoped to worker-class roles.
for (const { label, command } of [
  { label: 'a benign build command', command: 'bash -c "npm run test:fast"' },
  { label: 'a chained benign payload', command: 'bash -c "cd extension && npx tsc --noEmit"' },
  { label: 'an allowed path-mode checkout', command: 'bash -c "git checkout -- src/foo.ts"' },
  { label: 'a plain commit', command: 'bash -c "git commit -m fix"' },
]) {
  test(`AP-EXT-ITER10-01: worker still approves ${label} under bash -c`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'approve');
  });
}

test('AP-EXT-ITER10-01: manager context is unaffected by the unwrap', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'bash -c "git reset --hard"' },
    extraEnv: { PICKLE_ROLE: 'manager' },
  });
  assert.equal(result.decision, 'approve');
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// AP-EXT-ITER63-01 — a NON-bash POSIX shell is still a shell wrapper
//
// `isShellWrapper` tested `name === 'bash' || name === 'sh'` — a two-member
// enumeration, which is the same incomplete-declaration shape AP-EXT-ITER54-01
// removed one level down when it stopped enumerating operand-taking bash
// options. It reached the predicted bypass. `shellCommandStringPayload` returns
// null for a token the predicate rejects, and the `-c` payload is ONE quoted
// token, so for `zsh -c 'git reset --hard'` the ONLY executable any detector
// ever saw was `zsh` — approved, while the byte-identical `bash`/`sh` twins
// blocked. `/bin/zsh`, `/bin/dash` and `/bin/ksh` are all present on a stock
// macOS box and `zsh -c 'git …'` really does execute git, so this was a live
// bypass of every worker-forbidden-op guard, not a parsing curiosity.
//
// The fix is the naming SHAPE (`/^[a-z]*sh$/`) rather than a third member, so
// the whole shell family closes at once and no list is left to maintain.
// Each block case is paired below with its benign twin, so none of these can
// pass by blanket-blocking any command that merely mentions a shell.
// ---------------------------------------------------------------------------

for (const { label, command, expect: expected } of [
  { label: 'zsh -c (single-quoted)', command: "zsh -c 'git reset --hard'", expect: /reset/ },
  { label: 'zsh -c (double-quoted)', command: 'zsh -c "git reset --hard"', expect: /reset/ },
  { label: 'absolute-path zsh -c', command: '/bin/zsh -c "git reset --hard"', expect: /reset/ },
  { label: 'zsh -lc combined flag', command: 'zsh -lc "git stash"', expect: /stash/ },
  { label: 'dash -c', command: 'dash -c "git push origin main"', expect: /push/ },
  { label: 'ksh -c', command: 'ksh -c "git rebase main"', expect: /rebase/ },
  { label: 'env-prefixed zsh -c', command: 'PICKLE_ROLE=x zsh -c "git pull"', expect: /pull/ },
  { label: 'zsh -c wrapping a bash -c', command: 'zsh -c "bash -c \'git reset --hard\'"', expect: /reset/ },
]) {
  test(`AP-EXT-ITER63-01: worker blocks prohibited git verb via ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block');
    assert.match(result.reason, /R-WSRC-GR/);
    assert.match(result.reason, expected);
  });
}

// The wrapper fold is shared, so the install.sh detector inherits the fix at
// both of its arms: the `-c` unwrap AND the bare `execTokenIndex` skip. Pinned
// so a future per-detector narrowing is caught.
for (const { label, command } of [
  { label: 'zsh -c "bash install.sh"', command: 'zsh -c "bash install.sh"' },
  { label: 'zsh install.sh', command: 'zsh install.sh' },
]) {
  test(`AP-EXT-ITER63-01: worker blocks ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block');
    assert.match(result.reason, /R-WSRC/);
  });
}

// `install.sh` carries a DOT, so the shape can never fold it to a wrapper —
// it must stay the EXEC token of `bash install.sh` rather than a skipped
// prefix, or the detector reads past it onto its argument.
test('AP-EXT-ITER63-01: a dot-bearing script name is never a wrapper', () => {
  assert.equal(isShellWrapper('install.sh'), false);
  assert.equal(isShellWrapper('/repo/install.sh'), false);
  assert.equal(isShellWrapper('pre-install.sh'), false);
  assert.equal(isShellWrapper('bash'), true);
  assert.equal(isShellWrapper('zsh'), true);
  assert.equal(isShellWrapper('/bin/ZSH'), true);
  assert.equal(isShellWrapper(undefined), false);
  assert.equal(isShellWrapper(''), false);
});

// Non-tautology guards: widening the wrapper fold must not blanket-block a
// non-bash shell, and must stay scoped to worker-class roles.
for (const { label, command } of [
  { label: 'a benign build command', command: 'zsh -c "npm run test:fast"' },
  { label: 'a chained benign payload', command: 'zsh -c "cd extension && npx tsc --noEmit"' },
  { label: 'an allowed path-mode checkout', command: 'dash -c "git checkout -- src/foo.ts"' },
  { label: 'a plain commit', command: 'ksh -c "git commit -m fix"' },
]) {
  test(`AP-EXT-ITER63-01: worker still approves ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'approve');
  });
}

test('AP-EXT-ITER63-01: manager context is unaffected by the wider wrapper fold', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: "zsh -c 'git reset --hard'" },
    extraEnv: { PICKLE_ROLE: 'manager' },
  });
  assert.equal(result.decision, 'approve');
});

// AP-EXT-ITER14-01 — ESCAPED-quote nesting closes the ITER10/ITER12 residual
//
// Both prior passes cataloged this as an open RESIDUAL: `tokenizeShellCommand`
// matched a double-quoted span with `"[^"]*"`, which STOPS at the first escaped
// quote. So `bash -c "bash -c \"git reset --hard\""` desynchronized — the
// payload token came back as `bash -c \`, the inner `git` never led a segment,
// and the reset was APPROVED while both its bare twin and its alternate-quoted
// twin (`bash -c 'bash -c "…"'`) blocked. Verified against a `git` shim that the
// shell really does execute the reset, so this was a live bypass of every
// worker-forbidden-op guard, not a parsing curiosity.
//
// The fix is escape-aware quoted spans plus unescaping of a double-quoted token,
// shared by BOTH scanners in shell-exec.ts — not a third special case.
//
// Only the DOUBLE-quoted span is escape-aware: inside `'…'` bash treats a
// backslash literally, so single-quote spans must stay as they were.
// ---------------------------------------------------------------------------

for (const { label, command, expect: expected } of [
  { label: 'nested bash -c', command: 'bash -c "bash -c \\"git reset --hard\\""', expect: /reset/ },
  { label: 'nested sh -lc outer', command: 'sh -lc "bash -c \\"git push origin main\\""', expect: /push/ },
  { label: 'nested with --amend', command: 'bash -c "bash -c \\"git commit --amend\\""', expect: /commit --amend/ },
  { label: 'nested behind a cd', command: 'bash -c "cd extension && bash -c \\"git stash\\""', expect: /stash/ },
]) {
  test(`AP-EXT-ITER14-01: worker blocks prohibited git verb via ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block');
    assert.match(result.reason, /R-WSRC-GR/);
    assert.match(result.reason, expected);
  });
}

// Inherited at the shared seam, so install.sh detection gets it for free.
test('AP-EXT-ITER14-01: worker blocks `bash -c "bash -c \\"bash install.sh\\""`', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'bash -c "bash -c \\"bash install.sh\\""' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-WSRC/);
});

// Non-tautology guards. The middle case is the one that matters: a prohibited
// verb inside a QUOTED ARGUMENT is not a command, and the pre-fix desync used
// to over-block it by accident. Unescaping correctly keeps it one token, so a
// blanket "contains git reset" implementation fails here.
for (const { label, command } of [
  { label: 'a nested benign payload', command: 'bash -c "bash -c \\"npm run test:fast\\""' },
  { label: 'a prohibited verb inside a quoted echo argument', command: 'bash -c "echo \\"x && git reset --hard\\""' },
  { label: 'an escaped-quote commit message', command: 'bash -c "git commit -m \\"feat: x\\""' },
  { label: 'a bare escaped-quote verb git itself rejects', command: 'git \\"reset\\" --hard' },
]) {
  test(`AP-EXT-ITER14-01: worker still approves ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'approve');
  });
}

// Single-quoted spans must NOT become escape-aware: bash keeps a backslash
// literal inside `'…'`, so this stays exactly one token and the payload the
// wrapper runs is `git status`, not a reset.
test('AP-EXT-ITER14-01: single-quoted span keeps backslashes literal', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: "bash -c 'git status'" },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER18-01 — a GLUED control operator is still a segment boundary
//
// Whitespace around a control operator is not required by bash: a `git` shim
// confirms `git status&&git reset --hard` really executes the reset, exactly as
// its spaced twin does. But the tokenizer split glued `;` and NOTHING else, so
// `&&`, `||`, `|`, and `&` survived inside one `\S+` token. The segment's
// leading command read `git status`, no detector ever saw the second command,
// and every worker-forbidden-op guard APPROVED it while the spaced twin blocked
// — a live `git reset --hard` bypass, the destruction class this repo's
// recovery recipes exist for.
//
// Same shape as ITER12-01 one level down: the separator set declared six
// operators, the tokenizer honored two. The fix derives the split FROM the set
// so declaring an operator is what makes it a boundary.
// ---------------------------------------------------------------------------

for (const { label, command, expect: expected } of [
  { label: 'glued &&', command: 'git status&&git reset --hard', expect: /reset/ },
  { label: 'glued && behind a cd', command: 'cd extension&&git reset --hard', expect: /reset/ },
  { label: 'glued ||', command: 'git status||git push origin main', expect: /push/ },
  { label: 'glued |', command: 'echo hi|git stash', expect: /stash/ },
  { label: 'glued &', command: 'git log&git rebase -i', expect: /rebase/ },
  { label: 'glued && with --amend', command: 'git add -A&&git commit --amend', expect: /commit --amend/ },
]) {
  test(`AP-EXT-ITER18-01: worker blocks prohibited git verb via ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block');
    assert.match(result.reason, /R-WSRC-GR/);
    assert.match(result.reason, expected);
  });
}

// Inherited at the shared seam, so install.sh detection gets it for free.
test('AP-EXT-ITER18-01: worker blocks `cd extension&&bash install.sh`', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'cd extension&&bash install.sh' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-WSRC/);
});

// Non-tautology guards. Splitting on `&` must not reach an fd-dup (`2>&1` is a
// redirection, not a background operator) and a quoted operator is an argument,
// so a blanket "contains `git reset`" implementation fails both.
for (const { label, command } of [
  { label: 'a quoted glued operator in a commit message', command: 'git commit -m "fix&&reset bug"' },
  { label: 'an fd-dup redirection', command: 'git status 2>&1' },
  { label: 'an fd-dup after a glued chain', command: 'npm test&&git status 2>&1' },
  { label: 'a benign glued chain', command: 'npm run lint&&npm run test:fast' },
]) {
  test(`AP-EXT-ITER18-01: worker still approves ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'approve');
  });
}

// ---------------------------------------------------------------------------
// AP-EXT-ITER19-01 — a GROUPED command is still a command
//
// `(`, `)`, `{`, `}` and a backtick begin a command in bash exactly as `&&` and
// `;` do: a `git` shim confirms `(git reset --hard)`, `{ git reset --hard; }`,
// `$(git reset --hard)` and a backtick substitution all really execute the
// reset. But `SHELL_SEGMENT_SEPARATORS` declared only the six control
// operators, so the grouped form stayed one segment whose leading token was
// `(git` — which `execName` folds to `(git`, matching no detector. Every
// prohibited verb slipped by being wrapped in parens while its bare twin
// blocked, and `(git commit …)` skipped the R-WACT tsc gate.
//
// Third instance of the ITER12/ITER18 shape: the machinery derives boundaries
// from one declarative set, and the set was missing members bash honors.
// ---------------------------------------------------------------------------

for (const { label, command, expect: expected } of [
  { label: 'a subshell', command: '(git reset --hard)', expect: /reset/ },
  { label: 'a subshell behind a cd', command: 'cd extension && (git reset --hard)', expect: /reset/ },
  { label: 'a subshell after a benign verb', command: 'git status; (git push origin main)', expect: /push/ },
  { label: 'a brace group', command: '{ git stash; }', expect: /stash/ },
  { label: 'a command substitution', command: '$(git rebase -i)', expect: /rebase/ },
  { label: 'a command substitution as an argument', command: 'echo $(git pull)', expect: /pull/ },
  { label: 'a backtick substitution', command: '`git reset --hard`', expect: /reset/ },
  { label: 'a subshell inside a bash -c payload', command: 'bash -c "(git reset --hard)"', expect: /reset/ },
]) {
  test(`AP-EXT-ITER19-01: worker blocks prohibited git verb via ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block');
    assert.match(result.reason, /R-WSRC-GR/);
    assert.match(result.reason, expected);
  });
}

// Inherited at the shared seam, so install.sh detection gets it for free.
test('AP-EXT-ITER19-01: worker blocks `(bash install.sh)`', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: '(cd extension && bash install.sh)' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-WSRC/);
});

// Non-tautology guards. Over-segmentation is only fail-safe while it does not
// invent a leading `git <prohibited verb>` where none executes: parens inside
// quotes are argument text, and an unquoted `%(refname)` is a format string
// whose segments must not read as a command. A blanket "contains `git reset`"
// or a naive strip-all-parens implementation fails these.
for (const { label, command } of [
  { label: 'parens inside a commit message', command: 'git commit -m "fix (reset bug) here"' },
  { label: 'an unquoted git format string', command: 'git log --format=%(refname)' },
  { label: 'a brace expansion argument', command: 'cp {a,b} dst' },
  { label: 'a benign substitution', command: 'echo $(git rev-parse HEAD)' },
  { label: 'a path-mode checkout in a subshell', command: '(git checkout -- src/foo.ts)' },
]) {
  test(`AP-EXT-ITER19-01: worker still approves ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'approve');
  });
}

// ---------------------------------------------------------------------------
// AP-EXT-ITER53-01 — ADJACENT quoting inside one word is still one word
//
// Bash concatenates the parts of a word that carry no whitespace between them:
// `ba"sh" install.sh` really executes bash on install.sh, `git rese"t" --hard`
// really resets, and `t"ee" f` really writes f (all shim-verified). But the
// tokenizer unquoted a word only when the ENTIRE `\S+` run was a single quoted
// span, so any PARTIALLY quoted word kept its quote characters in the token and
// every `execName` / verb / write-anchor comparison downstream missed.
//
// Same failure shape as the AP-EXT-ITER51-01/02 pair one level down — the
// scanner's model of a bash word disagreed with bash — and it re-opened three
// guards at once: the R-WSRC `install.sh` ban, R-WSRC-GR, and the R-WSRC-3
// state-write gate. Fixed at the ONE seam (`tokenizeShellTokens` folds a word's
// parts), so all three detectors inherit it.
// ---------------------------------------------------------------------------

for (const { label, command, expect: expected } of [
  { label: 'a split exec token', command: 'git rese"t" --hard', expect: /reset/ },
  { label: 'a single-quoted exec fragment', command: "git re'set' --hard", expect: /reset/ },
  { label: 'two adjacent quoted fragments', command: 'git "res""et" --hard', expect: /reset/ },
  { label: 'a leading quoted fragment', command: 'git "re"set --hard', expect: /reset/ },
  { label: 'a quoted exec beyond a glued operator', command: 'echo x&&"git" reset --hard', expect: /reset/ },
  { label: 'a glued operator between two quoted words', command: '"echo x"&&"git" reset --hard', expect: /reset/ },
  { label: 'a split verb behind a cd', command: 'cd extension && git pu"sh" origin main', expect: /push/ },
  { label: 'a split flag on commit', command: 'git commit --am"end"', expect: /commit --amend/ },
  { label: 'a split git executable', command: 'gi"t" stash', expect: /stash/ },
]) {
  test(`AP-EXT-ITER53-01: worker blocks prohibited git verb via ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block');
    assert.match(result.reason, /R-WSRC-GR/);
    assert.match(result.reason, expected);
  });
}

// The same seam feeds the install.sh ban and the state-write gate, so both
// inherit the fold. Pinning all three is what proves the fix is at the seam and
// not a per-detector patch.
for (const { label, command } of [
  { label: 'a split interpreter', command: 'ba"sh" install.sh' },
  { label: 'a split script name', command: 'bash insta"ll".sh' },
  { label: 'an empty quoted span inside the script name', command: 'bash install"".sh' },
]) {
  test(`AP-EXT-ITER53-01: worker blocks bash install.sh via ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block');
    assert.match(result.reason, /R-WSRC/);
  });
}

for (const { label, command } of [
  { label: 'a split tee', command: 't"ee" SESSION_STATE' },
  { label: 'a split in-place sed', command: 's"ed" -i "" s/a/b/ SESSION_STATE' },
]) {
  test(`AP-EXT-ITER53-01: worker blocks a state write via ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command: command.replace('SESSION_STATE', stateFile) },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block');
    assert.match(result.reason, /Runtime state file protected/);
  });
}

// Non-tautology guards. Folding the parts must reproduce the word bash builds,
// not merely delete quote characters wherever they appear: an adjacency-quoted
// BENIGN verb stays benign, a prohibited verb sitting in an argument is still
// an argument, and the escaped form is a word git rejects, so nothing resets.
for (const { label, command } of [
  { label: 'a split benign verb', command: 'git rev-p"arse" --short HEAD' },
  { label: 'a split verb name inside a flag value', command: 'git log --format=re"set"' },
  { label: 'a split verb name inside a commit message', command: 'git commit -m "rese""t the parser"' },
  { label: 'a bare escaped-quote verb git itself rejects', command: 'git \\"reset\\" --hard' },
]) {
  test(`AP-EXT-ITER53-01: worker still approves ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'approve');
  });
}

// ---------------------------------------------------------------------------
// AP-EXT-ITER54-01 — an option OPERAND stood between the wrapper and `-c`
//
// `shellCommandStringPayload` walked the wrapper's options for the first word
// that did not start with `-`. Bash options take OPERANDS, and an operand is a
// bare word: `bash -o pipefail -c "git reset --hard"` stopped the scan at
// `pipefail`, so the `-c` flag was never reached, the payload was never
// unwrapped, and the destructive reset was APPROVED for a worker while its
// bare twin blocked. Fifth instance of the AP-EXT-ITER10-01/12-01/18-01/19-01
// shape: the machinery reads one declarative thing and the reading was partial.
//
// Every block case is paired below with a benign twin under the same wrapper,
// so these cannot pass by blanket-blocking any command containing `-o`.
// ---------------------------------------------------------------------------

for (const { label, command, expect: expected } of [
  { label: '-o pipefail before -c', command: 'bash -o pipefail -c "git reset --hard"', expect: /reset/ },
  { label: 'two -o operands before -c', command: 'bash -o errexit -o pipefail -c "git reset --hard"', expect: /reset/ },
  { label: 'sh -o pipefail', command: 'sh -o pipefail -c "git stash"', expect: /stash/ },
  { label: '+o operand form', command: 'bash +o histexpand -c "git push origin main"', expect: /push/ },
  { label: '-O shopt operand', command: 'bash -O extglob -c "git rebase main"', expect: /rebase/ },
  { label: '--rcfile operand', command: 'bash --rcfile /dev/null -c "git reset --hard"', expect: /reset/ },
  { label: '--init-file operand', command: 'bash --init-file /dev/null -c "git checkout main"', expect: /checkout/ },
  { label: 'env-prefixed with operand', command: 'PICKLE_ROLE=x bash -o pipefail -c "git reset --hard"', expect: /reset/ },
  { label: 'absolute-path with operand', command: '/bin/bash -o pipefail -c "cd sub && git push origin main"', expect: /push/ },
]) {
  test(`AP-EXT-ITER54-01: worker blocks prohibited git verb via ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block');
    assert.match(result.reason, /R-WSRC-GR/);
    assert.match(result.reason, expected);
  });
}

// The unwrap lands at the shared seam, so the install.sh detector inherits the
// widened read too.
test('AP-EXT-ITER54-01: worker blocks `bash -o pipefail -c "bash install.sh"`', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'bash -o pipefail -c "bash install.sh"' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-WSRC/);
});

// Non-tautology guards: reading forward from the flag must not blanket-block a
// wrapper that carries options, and a `-c`-less wrapper must gain no payload.
for (const { label, command } of [
  { label: 'a benign build command under -o pipefail', command: 'bash -o pipefail -c "npm run test:fast"' },
  { label: 'a benign chained payload under -o pipefail', command: 'bash -o pipefail -c "cd extension && npx tsc --noEmit"' },
  { label: 'an allowed path-mode checkout under -o pipefail', command: 'bash -o pipefail -c "git checkout -- src/foo.ts"' },
  { label: 'a plain commit under -o pipefail', command: 'bash -o pipefail -c "git commit -m fix"' },
  { label: 'a wrapper with options and no -c', command: 'bash -o pipefail scripts/run-tests.sh' },
]) {
  test(`AP-EXT-ITER54-01: worker still approves ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'approve');
  });
}

// AP-EXT-ITER55-01: reading the verb PAST an enumerated table of git global
// options that take an operand fails OPEN on any option the table lacks.
// `--config-env` was absent, and git really does accept its separate-operand
// form (verified on git 2.39.5: `MYVAL=false git --config-env core.bare=MYVAL
// reset --hard` resets the working tree). Pre-fix, findGitVerb read the operand
// `core.bare=MYVAL` as the verb and APPROVED all six prohibited verbs, chained
// forms included — measured 12/12 bypass against the shipped compiled handler.
// The fix reads the verb by MATCHING it (GATED_GIT_VERBS), which needs no
// knowledge of git's operand-taking options at all.
for (const [verb, command] of [
  ['reset', 'git --config-env core.bare=MYVAL reset --hard'],
  ['push', 'git --config-env core.bare=MYVAL push origin main'],
  ['rebase', 'git --config-env core.bare=MYVAL rebase -i main'],
  ['stash', 'git --config-env core.bare=MYVAL stash push'],
  ['pull', 'git --config-env core.bare=MYVAL pull'],
  ['switch', 'git --config-env core.bare=MYVAL switch main'],
  ['checkout', 'git --config-env core.bare=MYVAL checkout main'],
  ['commit --amend', 'git --config-env core.bare=MYVAL commit --amend'],
  ['fetch --prune', 'git --config-env core.bare=MYVAL fetch --prune'],
]) {
  test(`AP-EXT-ITER55-01: worker blocks \`${command}\``, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block');
    assert.match(result.reason, /R-WSRC-GR/);
    assert.ok(
      result.reason.includes(verb),
      `expected block reason to name \`${verb}\`, got: ${result.reason}`,
    );
  });
}

test('AP-EXT-ITER55-01 chained: worker blocks `cd extension && git --config-env x=V reset --hard`', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'cd extension && git --config-env core.bare=MYVAL reset --hard' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /reset/);
});

test('AP-EXT-ITER55-01 chained after benign: worker blocks `git status && git --config-env x=V reset --hard`', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git status && git --config-env core.bare=MYVAL reset --hard' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /reset/);
});

// The invariant is that the verb read never depends on knowing which options
// take an operand — so an option NOBODY has enumerated must be caught too.
// This is the case a table-shaped fix ("just add --config-env") would still miss.
test('AP-EXT-ITER55-01: worker blocks a prohibited verb behind an UNKNOWN operand-taking option', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git --some-future-option some-operand reset --hard' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /reset/);
});

// Guard the other direction: the allowed forms must still be allowed after the
// scan widened from "first bare word" to "first gated verb".
for (const command of [
  'git status --short',
  'git add -u',
  "git commit -m 'wip'",
  'git checkout -- src/foo.ts',
  'git checkout .',
  'git fetch',
  'git log --oneline --all -- src/foo.ts',
  'git -C extension status',
  'git diff HEAD',
  'git restore src/foo.ts',
  'git show HEAD:src/foo.ts',
]) {
  test(`AP-EXT-ITER55-01 no over-block: worker approves \`${command}\``, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'approve');
  });
}

// ---------------------------------------------------------------------------
// AP-EXT-ITER63-02 — a POSIX command PREFIX hides the real exec
//
// The RESIDUAL AP-EXT-ITER63-01 left open, and the seventh instance of the
// AP-EXT-ITER10-01/12-01/18-01/19-01/54-01/63-01 shape. `execTokenIndex` answers
// "which token does the shell exec" POSITIONALLY, skipping env assignments and
// one shell wrapper. But a POSIX command PREFIX is an ordinary program that
// takes a command as its argument and execs it, so it stands in exec position
// with the real executable behind it. `parseFirstShellWord` read `env`, the
// `!== 'git'` gate skipped the segment, and `env git reset --hard` APPROVED for
// a worker while its byte-identical bare twin blocked.
//
// Measured against the shipped export before the fix: 16 of 17 prefixed forms
// bypassed. `env`, `command`, `nohup`, `nice`, `exec` and `time` were each
// verified to really exec git on this box (each ran `git rev-parse` in a scratch
// repo and printed the branch), so this was a live bypass of the R-WSRC-GR
// data-loss guard, not a parsing curiosity.
//
// The fix needs NO prefix table — enumerating them is the incomplete-declaration
// shape that has now failed six times here, one member from the next bypass.
// `findGitVerb` scans for the `git` ANCHOR wherever it sits, exactly as it
// already scans for the VERB wherever it sits (AP-EXT-ITER55-01) rather than
// carrying a git-global-option table. `parseFirstShellWord` is DELETED: the
// anchor read subsumes its gate.
//
// Each block case is paired with a benign twin below, so none of these can pass
// by blanket-blocking any command that merely mentions a prefix or `git`.
// ---------------------------------------------------------------------------

for (const { label, command, expect: expected } of [
  { label: 'env', command: 'env git reset --hard', expect: /reset/ },
  { label: 'env with an assignment operand', command: 'env FOO=1 git reset --hard', expect: /reset/ },
  { label: 'env -i', command: 'env -i git reset --hard', expect: /reset/ },
  { label: 'command', command: 'command git push origin main', expect: /push/ },
  { label: 'nohup', command: 'nohup git push origin main', expect: /push/ },
  { label: 'nice', command: 'nice git stash', expect: /stash/ },
  { label: 'nice with an operand', command: 'nice -n 10 git stash', expect: /stash/ },
  { label: 'exec', command: 'exec git reset --hard', expect: /reset/ },
  { label: 'time', command: 'time git push origin main', expect: /push/ },
  { label: 'sudo', command: 'sudo git reset --hard', expect: /reset/ },
  { label: 'timeout with an operand', command: 'timeout 5 git rebase main', expect: /rebase/ },
  { label: 'setsid', command: 'setsid git pull', expect: /pull/ },
  { label: 'an absolute-path prefix', command: '/usr/bin/env git reset --hard', expect: /reset/ },
  { label: 'a prefix behind an env assignment', command: 'PICKLE_ROLE=x env git reset --hard', expect: /reset/ },
  { label: 'a prefix behind a shell wrapper', command: 'bash -c "env git reset --hard"', expect: /reset/ },
  { label: 'a prefix in a chained segment', command: 'cd extension && env git reset --hard', expect: /reset/ },
  { label: 'a prefix in a grouped segment', command: '(nohup git reset --hard)', expect: /reset/ },
  { label: 'a quoted prefix', command: '"env" git reset --hard', expect: /reset/ },
  { label: 'two stacked prefixes', command: 'nohup nice git push origin main', expect: /push/ },
]) {
  test(`AP-EXT-ITER63-02: worker blocks a prohibited git verb behind ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block');
    assert.match(result.reason, /R-WSRC-GR/);
    assert.match(result.reason, expected);
  });
}

// Non-tautology guards. The anchor read must not blanket-block: a prefixed
// command that runs no gated verb, and an allowed git operation behind a
// prefix, both still approve. Without these a `return block()` would pass the
// block cases above.
for (const { label, command } of [
  { label: 'a prefixed benign git verb', command: 'env git status' },
  { label: 'a prefixed benign build command', command: 'nohup npm run test:fast' },
  { label: 'a prefixed plain commit', command: 'env git commit -m fix' },
  { label: 'a prefixed path-mode checkout', command: 'nice git checkout -- src/foo.ts' },
  { label: 'a prefixed plain fetch', command: 'command git fetch origin' },
  { label: 'a prefix with no git at all', command: 'env FOO=1 npm ci' },
  { label: 'a directory that merely starts with git', command: 'cd git-repo && npm test' },
  { label: 'a bare cd into a dir named git', command: 'cd git' },
  { label: 'a gated verb inside a quoted commit message', command: 'git commit -m "env git reset --hard is blocked"' },
]) {
  test(`AP-EXT-ITER63-02: worker still approves ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'approve');
  });
}

test('AP-EXT-ITER63-02: manager context is unaffected by the anchor read', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'env git reset --hard' },
    extraEnv: { PICKLE_ROLE: 'manager' },
  });
  assert.equal(result.decision, 'approve');
});

// A quoted `git` in EXEC position is an exec like any other and must anchor.
// AP-EXT-ITER64-01 removed the CONVERSE half of this pin (a quoted word in
// ARGUMENT position used to be spared): that exception was gated on
// `execTokenIndex`, so a command prefix standing at the exec index demoted the
// real exec behind it to "data". See the ITER64-01 block below.
test('AP-EXT-ITER63-02: a quoted git in EXEC position still anchors', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: "'git' reset --hard" },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-WSRC-GR/);
});

// The prefix set is deliberately UNENUMERATED. This is the guard against a
// future fix regressing to a table: an invented prefix that no table would ever
// carry must block exactly like the real ones.
test('AP-EXT-ITER63-02: an unenumerated prefix blocks too — no prefix table exists', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'zzz-unknown-prefix-9f2a git reset --hard' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-WSRC-GR/);
});

// Structural pin: the deleted gate must not come back. `parseFirstShellWord`
// re-introduced anywhere in the hooks tree means the positional read is back in
// the git chain and the whole prefix family re-opens.
test('AP-EXT-ITER63-02: parseFirstShellWord stays deleted from the hooks tree', () => {
  const hooksSrc = path.resolve(__dirname, '../../src/hooks');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      if (fs.readFileSync(full, 'utf8').includes('parseFirstShellWord')) offenders.push(full);
    }
  };
  walk(hooksSrc);
  assert.deepEqual(offenders, []);
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER63-06 — a POSIX command prefix hid the whole -c payload
//
// `shellCommandStringPayload` gated the `-c` unwrap on a POSITIONAL read:
// `isShellWrapper(tokens[skipEnvAssignments(tokens)])`. A command PREFIX (`env`,
// `nohup`, `command`, `timeout`, …) is an ordinary program that stands in exec
// position while the shell stands behind it, so the env prelude walked past
// nothing and the wrapper test failed on the PREFIX. The payload is ONE quoted
// token, so a failed test hid the ENTIRE command string from every detector at
// once — this was the SHARED ROOT of the positional-exec-read family, re-opening
// the git-verb, install.sh, expensive-test and R-WSRC-3 state-write guards in a
// single stroke. Measured before the fix: `env bash -c "git reset --hard"`,
// `nohup sh -c "git push origin main"` and `env bash -c "bash install.sh"` all
// APPROVED for a worker while their byte-identical unprefixed twins blocked.
//
// The fix anchors the WRAPPER wherever it sits — the same move execAnchorIndex
// made for the EXEC one level up — so no prefix table exists to fall behind.
// Each case is paired with the unprefixed twin that already blocked, so none can
// pass by blanket-blocking anything that merely mentions a shell.
// ---------------------------------------------------------------------------

for (const { label, command, expect: expected } of [
  { label: 'env bash -c', command: 'env bash -c "git reset --hard"', expect: /reset/ },
  { label: 'nohup sh -c', command: 'nohup sh -c "git push origin main"', expect: /push/ },
  { label: 'command zsh -c', command: 'command zsh -c "git reset --hard"', expect: /reset/ },
  { label: 'timeout with operand', command: 'timeout 5 bash -c "git rebase main"', expect: /rebase/ },
  { label: 'prefixed absolute-path shell', command: 'env /bin/bash -lc "git stash"', expect: /stash/ },
  { label: 'env assignment AND prefix', command: 'PICKLE_ROLE=x env bash -c "git pull"', expect: /pull/ },
  { label: 'unenumerated prefix', command: 'zzz-unknown-prefix-9f2a bash -c "git reset --hard"', expect: /reset/ },
]) {
  test(`AP-EXT-ITER63-06: worker blocks prohibited git verb via ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block');
    assert.match(result.reason, /R-WSRC-GR/);
    assert.match(result.reason, expected);
  });
}

// The unwrap is shared, so the install.sh detector inherits the fix through the
// payload rather than through a second copy of it.
test('AP-EXT-ITER63-06: worker blocks a prefixed shell wrapping bash install.sh', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'env bash -c "bash install.sh"' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-WSRC/);
});

// Benign twins: the widened anchor must not turn ordinary prefixed commands
// into blocks. A fix that blanket-blocks every `env`/`nohup` line would satisfy
// the cases above and break every worker.
for (const { label, command } of [
  { label: 'prefixed benign shell', command: 'env bash -c "npm test"' },
  { label: 'prefixed read-only git', command: 'nohup bash -c "git status"' },
  { label: 'prefixed echo', command: 'command echo hello' },
  { label: 'bare benign shell', command: 'bash -c "ls -la"' },
]) {
  test(`AP-EXT-ITER63-06: worker still approves ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'approve');
  });
}

// Structural pin, in the module's own terms: the unwrap must be a strict
// SUPERSET of the old positional read. The post-env index is still scanned — it
// is simply no longer the only one — so a future narrowing that reinstates a
// positional gate is caught here rather than at the next bypass.
test('AP-EXT-ITER63-06: the -c payload resolves at, before and after the post-env index', () => {
  const at = splitShellSegments('bash -c "git reset --hard"');
  const envPrelude = splitShellSegments('PICKLE_ROLE=x /bin/bash -lc "git reset --hard"');
  const prefixed = splitShellSegments('env bash -c "git reset --hard"');
  for (const [label, segments] of [['bare', at], ['env-assignment', envPrelude], ['prefixed', prefixed]]) {
    assert.ok(
      segments.includes('git reset --hard'),
      `${label} form must expand its -c payload into its own segment, got ${JSON.stringify(segments)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER64-01 — a QUOTED exec behind a command prefix vanished entirely
//
// `execAnchorIndex` exists to retire the positional exec read, but it re-admitted
// it through the back door: its quoting exception spared a quoted token unless
// that token sat AT `execTokenIndex`. A POSIX command PREFIX stands at exactly
// that index, so the real exec one token later was demoted to "data" and the
// scan returned -1 — `findGitVerb` saw no git at all and the whole R-WSRC-GR
// chain skipped the segment.
//
// Measured against the shipped handler before the fix: 8 of 8 quoted-behind-
// prefix forms APPROVED for a worker while their byte-identical unquoted twins
// blocked, and a `git` shim confirmed every one really executes git (quote
// removal happens in the shell, before `env`/`nohup`/`command` ever see argv).
//
// The exception suppressed no false positive, which is why removing it is a
// subtraction rather than a widening: the case it existed for — an argument-
// position `echo 'git' reset` — has an unquoted twin `echo git reset` that
// over-blocks anyway (both measured). It only taught the bypass to add quotes.
//
// Each case is PAIRED with the unquoted twin that already blocked, so no case
// can pass by blanket-blocking anything containing the word `git`.
// ---------------------------------------------------------------------------

for (const { label, quoted, twin, expect: expected } of [
  { label: "env 'git'", quoted: "env 'git' reset --hard", twin: 'env git reset --hard', expect: /reset/ },
  { label: 'env "git"', quoted: 'env "git" reset --hard', twin: 'env git reset --hard', expect: /reset/ },
  { label: "nohup 'git'", quoted: "nohup 'git' push origin main", twin: 'nohup git push origin main', expect: /push/ },
  { label: "command 'git'", quoted: "command 'git' stash", twin: 'command git stash', expect: /stash/ },
  { label: "nice 'git'", quoted: "nice 'git' rebase main", twin: 'nice git rebase main', expect: /rebase/ },
  { label: "exec 'git'", quoted: "exec 'git' reset --hard", twin: 'exec git reset --hard', expect: /reset/ },
  { label: 'sudo "git"', quoted: 'sudo "git" push', twin: 'sudo git push', expect: /push/ },
  { label: "env-assignment + prefix + 'git'", quoted: "PICKLE_ROLE=x env 'git' push origin main", twin: 'PICKLE_ROLE=x env git push origin main', expect: /push/ },
  // An INVENTED prefix no table would ever carry, to pin that the fix stayed
  // list-free rather than growing a prefix set with a quoting arm bolted on.
  { label: "invented prefix + 'git'", quoted: "zzz-unknown-prefix-9f2a 'git' reset --hard", twin: 'zzz-unknown-prefix-9f2a git reset --hard', expect: /reset/ },
]) {
  test(`AP-EXT-ITER64-01: worker blocks ${label} (quoted exec behind a prefix)`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command: quoted },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', quoted);
    assert.match(result.reason, /R-WSRC-GR/);
    assert.match(result.reason, expected);
  });

  test(`AP-EXT-ITER64-01: ${label} matches its unquoted twin (non-tautology)`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command: twin },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', twin);
    assert.match(result.reason, expected);
  });
}

// The quoted and unquoted forms must now be INDISTINGUISHABLE to the anchor.
// This is the invariant the removed exception violated, stated directly: quoting
// is not a signal the guard may key on, because the shell strips it before the
// program ever runs.
test('AP-EXT-ITER64-01: quoting a token never changes the anchor decision', () => {
  for (const [bare, ...quotedForms] of [
    ['git reset --hard', "'git' reset --hard", '"git" reset --hard'],
    ['env git reset --hard', "env 'git' reset --hard", 'env "git" reset --hard'],
    ['echo git reset', "echo 'git' reset", 'echo "git" reset'],
    ['echo hello', "echo 'hello'", 'echo "hello"'],
  ]) {
    const expectedIndex = execAnchorIndex(tokenizeShellTokens(bare), 'git');
    for (const form of quotedForms) {
      assert.equal(
        execAnchorIndex(tokenizeShellTokens(form), 'git'),
        expectedIndex,
        `${JSON.stringify(form)} must anchor exactly like ${JSON.stringify(bare)}`,
      );
    }
  }
});

// Structural pin: the exec-position exception must not come back. Reading
// `execTokenIndex` inside execAnchorIndex is what made a command prefix able to
// demote the real exec, so its ABSENCE from that function body is the invariant
// — not the behavior alone, which a re-typed variant would satisfy on the day it
// is written and drift from afterwards.
test('AP-EXT-ITER64-01: execAnchorIndex reads no positional exec index', () => {
  const shellExec = fs.readFileSync(
    path.resolve(__dirname, '../../src/hooks/shell-exec.ts'),
    'utf8',
  );
  const body = shellExec.match(
    /export function execAnchorIndex\([\s\S]*?\n\}/,
  );
  assert.ok(body, 'execAnchorIndex must remain a single top-level function');
  assert.equal(
    /execTokenIndex|skipEnvAssignments|\.quoted/.test(body[0]),
    false,
    'execAnchorIndex must not gate on a positional exec index or on quoting — ' +
      `a command prefix defeats both. Body was:\n${body[0]}`,
  );
  // AP-EXT-ITER64-02 CORRECTED the claim this pin used to make. It asserted the
  // sibling `tokens[i].quoted && i !== execIndex` arm in findWriteTargetInScope's
  // Pass 2 "must survive untouched", on the theory that removing it re-opens the
  // R-WSRC-3 write guards. The replay measured the exact opposite: KEEPING it was
  // the bypass, because `i !== execIndex` is true OF THE REAL EXEC whenever a
  // POSIX command prefix stands at the positional exec index. The pin now runs in
  // the direction the measurement supports — Pass 2 carries NO quoting arm and
  // reads NO exec index, exactly like execAnchorIndex above.
  const configProtection = fs.readFileSync(
    path.resolve(__dirname, '../../src/hooks/handlers/config-protection.ts'),
    'utf8',
  );
  const pass2 = configProtection.match(
    /function findWriteTargetInScope<T>\([\s\S]*?\n\}/,
  );
  assert.ok(pass2, 'findWriteTargetInScope must remain a single top-level function');
  assert.equal(
    /execTokenIndex|execIndex/.test(pass2[0]),
    false,
    'findWriteTargetInScope must not read a positional exec index — a command ' +
      `prefix stands at it. Body was:\n${pass2[0]}`,
  );
  // Pass 1's REDIRECT anchor keeps its unquoted test (AP-EXT-ITER51-01: quoting a
  // `>` really does turn it back into data). Only the EXEC anchor is quote-blind.
  assert.match(pass2[0], /!tokens\[i\]\.quoted && \(tokens\[i\]\.value === '>'/);
  assert.equal(
    (pass2[0].match(/\.quoted/g) || []).length,
    1,
    'exactly one `.quoted` read may remain in findWriteTargetInScope: Pass 1 ' +
      "redirect anchor. Pass 2's exec anchor must be quoting-blind.",
  );
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER63-05 — a POSIX command PREFIX hid node from the expensive-test guard
//
// The third and last of the residuals AP-EXT-ITER63-02 left open, and the
// eleventh instance of the AP-EXT-ITER10-01/12-01/18-01/19-01/54-01/63-01/63-02/
// 63-06/64-01/64-02 shape. `extractNodeTestPathsFromSegment` read the executable
// POSITIONALLY — `execName(tokens[skipEnvAssignments(tokens)]) !== 'node'` — and a
// POSIX command prefix is an ordinary program that stands in exec position and
// execs the real command behind it. It is not an env assignment, so the prelude
// walked past nothing, the `!== 'node'` gate matched the PREFIX, the segment
// yielded NO candidates, `isExpensiveTestFile` was never consulted, and the
// R-CSIS-B1 soak guard APPROVED.
//
// Measured 2026-08-26 against the shipped hook: 12 of 12 prefixed forms APPROVED
// while their byte-identical bare twins BLOCKED. That is a live bypass of the
// guard that keeps a worker from starting a 30-minute soak inside its turn.
//
// The fix needs NO prefix table — that is the incomplete-declaration shape this
// module has now been bitten by ten times. It scans for the `node` ANCHOR
// wherever it sits (`execAnchorIndex`), exactly as `findGitVerb` does for `git`.
// Every block case below is paired with a benign twin, so none can pass by
// blanket-blocking any command that merely mentions a prefix or `node`.
// ---------------------------------------------------------------------------

const ITER63_05_PREFIXES = [
  ['env', 'env node --test soak.test.js'],
  ['env with an assignment operand', 'env FOO=1 node --test soak.test.js'],
  ['command', 'command node --test soak.test.js'],
  ['nohup', 'nohup node --test soak.test.js'],
  ['nice', 'nice node --test soak.test.js'],
  ['nice with an operand', 'nice -n 10 node --test soak.test.js'],
  ['exec', 'exec node --test soak.test.js'],
  ['time', 'time node --test soak.test.js'],
  ['sudo', 'sudo node --test soak.test.js'],
  ['timeout with an operand', 'timeout 600 node --test soak.test.js'],
  ['setsid', 'setsid node --test soak.test.js'],
  ['stdbuf with an operand', 'stdbuf -o0 node --test soak.test.js'],
  ['npx', 'npx node --test soak.test.js'],
  ['an absolute-path prefix', '/usr/bin/env node --test soak.test.js'],
  ['a prefix behind an env assignment', 'PICKLE_ROLE=x env node --test soak.test.js'],
  ['a prefix behind a shell wrapper', 'bash -c "env node --test soak.test.js"'],
  ['a prefix in a chained segment', 'cd extension && env node --test soak.test.js'],
  ['a prefix in a grouped segment', '(nohup node --test soak.test.js)'],
  ['a quoted prefix', '"env" node --test soak.test.js'],
  ['two stacked prefixes', 'nohup nice node --test soak.test.js'],
  ['a prefix before an option operand', 'env node --test --test-reporter spec soak.test.js'],
  // No table carries this one. An enumerated prefix set would approve it; an
  // anchor read cannot tell it from `env`, which is the entire point.
  ['an INVENTED prefix no table would carry', 'frobnicate node --test soak.test.js'],
];

for (const [label, command] of ITER63_05_PREFIXES) {
  test(`AP-EXT-ITER63-05: worker blocks an expensive soak behind ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    fs.writeFileSync(path.join(tmpDir, 'soak.test.js'), '// @tier: expensive\n');
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', JSON.stringify(command));
    assert.match(result.reason, /R-CSIS-B1/);
  });
}

// Non-tautology twins: the SAME prefixes over a non-expensive file must still
// approve. Without these, a blanket "block anything with a prefix" would pass
// every case above.
test('AP-EXT-ITER63-05: the same prefixes over a NON-expensive test stay approved', () => {
  for (const [, command] of ITER63_05_PREFIXES) {
    const benign = command.replace(/soak\.test\.js/g, 'benign.test.js');
    const { tmpDir, stateFile } = bootstrapSession();
    fs.writeFileSync(path.join(tmpDir, 'benign.test.js'), '// @tier: fast\n');
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command: benign },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'approve', JSON.stringify(benign));
  }
});

// Quoting invariance, in parity with AP-EXT-ITER64-01: the shell strips the
// quotes before node runs, so a quoted exec behind a prefix is still an exec.
test('AP-EXT-ITER63-05: a quoted node behind a prefix still anchors', () => {
  for (const command of [
    "env 'node' --test soak.test.js",
    'nohup "node" --test soak.test.js',
    "command 'node' --test 'soak.test.js'",
    'PICKLE_ROLE=worker env "/usr/bin/node" --test "soak.test.js"',
  ]) {
    const { tmpDir, stateFile } = bootstrapSession();
    fs.writeFileSync(path.join(tmpDir, 'soak.test.js'), '// @tier: expensive\n');
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', JSON.stringify(command));
    assert.match(result.reason, /R-CSIS-B1/);
  }
});

// The anchor must not invent a block out of DATA. A quoted span that merely
// contains the invocation is one token whose `execName` fold is not `node`, and
// the recommended expensive-test entry point runs through npm, not node.
test('AP-EXT-ITER63-05: node inside a quoted argument, and npm entry points, stay approved', () => {
  for (const command of [
    'env echo "node --test soak.test.js"',
    "nohup git commit -m 'node --test soak.test.js'",
    'env RUN_EXPENSIVE_TESTS=1 npm run test:expensive',
    'env node --version',
    'env node --test',
  ]) {
    const { tmpDir, stateFile } = bootstrapSession();
    fs.writeFileSync(path.join(tmpDir, 'soak.test.js'), '// @tier: expensive\n');
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'approve', JSON.stringify(command));
  }
});

// Structural pin: the positional read must not come back. The behavior cases
// above pass on the day a re-typed positional variant is written and drift from
// it afterwards; the ABSENCE of the prelude call from this body is the invariant.
test('AP-EXT-ITER63-05: extractNodeTestPathsFromSegment reads no positional exec index', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../src/hooks/handlers/config-protection.ts'),
    'utf8',
  );
  const body = source.slice(
    source.indexOf('function extractNodeTestPathsFromSegment'),
    source.indexOf('function extractNodeTestPaths('),
  );
  assert.ok(body.length > 0, 'extractNodeTestPathsFromSegment must exist');
  assert.match(
    body,
    /execAnchorIndex\(tokens, 'node'\)/,
    'the node exec must be located by anchor, not by position',
  );
  assert.equal(
    /skipEnvAssignments|execTokenIndex|\.quoted/.test(body),
    false,
    `extractNodeTestPathsFromSegment must not gate on a positional exec index or ` +
      `on quoting — a command prefix defeats both. Body was:\n${body}`,
  );
  // File-wide: an enumerated prefix table parked at module scope is the same
  // incomplete-set shape, one indent out of the extractor.
  assert.equal(
    /'(env|nohup|nice|command|timeout|setsid|stdbuf|npx)'/.test(source),
    false,
    'config-protection.ts must not enumerate POSIX command prefixes',
  );
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER63-04 — a POSIX command PREFIX hid the deploy script from R-WSRC
//
// The LAST detector in this module still reading the exec POSITIONALLY, and the
// residual AP-EXT-ITER63-02/63-03/63-05/64-02 each left open by name.
// `segmentInvokesInstallSh` read `tokens[execTokenIndex(tokens)]`; a POSIX
// command prefix is an ordinary program that stands in exec position and execs
// the real command behind it, so the read folded to the PREFIX and the
// deploy-script test failed.
//
// Measured 2026-08-26 against the shipped compiled hook: 13 of 13 prefixed forms
// APPROVED for a worker while both controls (bare and quoted) BLOCKED — a live
// bypass of the R-PIPE-3 / R-WSRC hard-forbidden worker deploy op.
//
// The fix does NOT transfer verbatim from the four siblings, and the asymmetry
// is the whole content of this entry. They anchor on an EXECUTABLE (`git`,
// `node`) that no read-only command takes as an argument. This one anchors on a
// SCRIPT that read-only commands routinely do, and `install.sh` as an argument is
// pinned APPROVE four times over. So it anchors the WRAPPER instead — the same
// list-free shape `shellCommandStringPayload` took in AP-EXT-ITER63-06 — and
// keeps the old exec-token read as a first arm, which makes the guard a strict
// SUPERSET of what blocked before.
//
// Every block case below is paired with a read-only twin behind the SAME prefix,
// so none can pass by blanket-blocking any command that mentions the script.
//
// RESIDUAL OPEN, deliberately NOT pinned as a test: a prefixed DIRECT exec with
// no wrapper (`env ./install.sh`, `nohup ./install.sh`) still APPROVES. There is no wrapper
// to anchor on, and separating it from `cat ./install.sh` provably requires the prefix
// enumeration this family exists to refuse. Asserting it `approve` here would
// turn a known hole into a contract, so it is reported in the catalog instead.
// ---------------------------------------------------------------------------

const ITER63_04_PREFIXED = [
  ['env', 'env bash install.sh'],
  ['env with an assignment operand', 'env FOO=1 bash install.sh'],
  ['command', 'command bash install.sh'],
  ['nohup', 'nohup bash install.sh'],
  ['nice', 'nice bash install.sh'],
  ['nice with an operand', 'nice -n 10 bash install.sh'],
  ['exec', 'exec bash install.sh'],
  ['time', 'time bash install.sh'],
  ['sudo', 'sudo bash install.sh'],
  ['timeout with an operand', 'timeout 600 bash install.sh'],
  ['setsid', 'setsid bash install.sh'],
  ['stdbuf with an operand', 'stdbuf -o0 bash install.sh'],
  ['an absolute-path prefix', '/usr/bin/env bash install.sh'],
  ['an absolute-path wrapper behind a prefix', 'env /bin/bash install.sh'],
  ['a prefix behind an env assignment', 'PICKLE_ROLE=x env bash install.sh'],
  ['a prefix in a chained segment', 'cd extension && env bash ../install.sh'],
  ['a prefix in a grouped segment', '(nohup bash install.sh)'],
  ['a quoted prefix', '"env" bash install.sh'],
  ['a quoted script behind a prefix', 'env bash "install.sh"'],
  ['a case-variant script behind a prefix', 'env bash INSTALL.SH'],
  ['a non-bash shell behind a prefix', 'env zsh install.sh'],
  ['two stacked prefixes', 'nohup nice bash install.sh'],
  ['a wrapper option before the script', 'env bash -x install.sh'],
  ['a prefix inside a -c payload', 'bash -c "env bash install.sh"'],
  // No table carries this one. An enumerated prefix set would approve it; the
  // wrapper anchor cannot tell it from `env`, which is the entire point.
  ['an INVENTED prefix no table would carry', 'frobnicate bash install.sh'],
];

for (const [label, command] of ITER63_04_PREFIXED) {
  test(`AP-EXT-ITER63-04: worker blocks the deploy script behind ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', JSON.stringify(command));
    assert.match(result.reason, /R-WSRC/);
  });
}

// Non-tautology twins: the SAME prefixes over a read-only reference, and over a
// differently-named script, must still approve. Without these the block cases
// above would pass under a guard that blocks anything naming the script at all.
const ITER63_04_APPROVED = [
  ['a prefixed read-only cat', 'env cat install.sh'],
  ['a prefixed read-only vim', 'nohup vim install.sh'],
  ['a prefixed read-only git log', 'env git log install.sh'],
  ['a prefixed read-only head', 'timeout 600 head -20 install.sh'],
  ['a bare read-only cat', 'cat install.sh'],
  ['a prefixed differently-named script', 'env bash pre-install.sh'],
  ['a bare differently-named script', 'bash my-install.sh'],
  ['a prefixed read-only reference in a chain', 'cd extension && env cat ../install.sh'],
];

for (const [label, command] of ITER63_04_APPROVED) {
  test(`AP-EXT-ITER63-04: ${label} stays approved`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'approve', JSON.stringify(command));
  });
}

test('AP-EXT-ITER63-04: segmentInvokesInstallSh anchors the wrapper, not a position', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../src/hooks/handlers/config-protection.ts'),
    'utf8',
  );
  const body = source.slice(
    source.indexOf('function segmentInvokesInstallSh'),
    source.indexOf('function isBashInvokingInstallSh'),
  );
  assert.ok(body.length > 0, 'segmentInvokesInstallSh must exist');
  assert.match(
    body,
    /findIndex\(\(token\) => isShellWrapper\(token\)\)/,
    'the shell wrapper must be located by anchor scan, not by position',
  );
  // The exec-token read is RETAINED here on purpose — it is the first arm that
  // keeps `./<script>` (no wrapper at all) blocking, and it makes the guard a
  // strict superset of its previous behavior. This asserts it is not the ONLY
  // read, which is what the bypass depended on.
  assert.equal(
    /execTokenIndex/.test(body) && !/isShellWrapper/.test(body),
    false,
    `segmentInvokesInstallSh must not locate the exec by position ALONE — a ` +
      `command prefix stands at that index. Body was:\n${body}`,
  );
  // File-wide: an enumerated prefix table parked at module scope is the same
  // incomplete-set shape, one indent out of the detector.
  assert.equal(
    /'(env|nohup|nice|command|timeout|setsid|stdbuf|npx)'/.test(source),
    false,
    'config-protection.ts must not enumerate POSIX command prefixes',
  );
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER66-01 — bash has FOUR word-quoting forms and the scanner declared TWO
//
// `WORD_PART_SOURCE` offered `'…'` and `"…"`. bash also takes the `$`-introduced
// spans `$'…'` (ANSI-C) and `$"…"` (locale), and in BOTH the `$` is syntax that
// bash discards — `$'git'` IS the word `git`. Undeclared, the `$` fell through to
// the ordinary-character run and glued to the span, so the fold produced `$git`
// and every `execName` compare missed.
//
// Measured against the shipped handler before the fix: 10 of 10 forms APPROVED
// for a worker while their byte-identical bare twins blocked, across FOUR guard
// families at once — R-WSRC-GR git verbs, the R-WSRC `install.sh` ban, and the
// R-WSRC-3 state and settings write gates. A `git`/`tee` shim confirmed each one
// really execs (quote removal happens in the shell, before argv exists).
//
// `$'…'` additionally processes backslash escapes, so stripping delimiters alone
// is not enough to recover the word: bash runs `$'\x67it'` and `$'\147it'` as
// `git` (shim-verified). The numeric escapes are decoded for that reason.
//
// Every case is PAIRED with the twin that already blocked, so none can pass by
// blanket-blocking anything containing a `$`.
// ---------------------------------------------------------------------------

for (const { label, dollar, twin, guard, expected } of [
  // R-WSRC-GR — the git verb chain
  { label: "$'git' reset", dollar: "$'git' reset --hard HEAD~1", twin: 'git reset --hard HEAD~1', guard: /R-WSRC-GR/, expected: /reset/ },
  { label: '$"git" reset', dollar: '$"git" reset --hard HEAD~1', twin: 'git reset --hard HEAD~1', guard: /R-WSRC-GR/, expected: /reset/ },
  { label: "$'git' push", dollar: "$'git' push origin main", twin: 'git push origin main', guard: /R-WSRC-GR/, expected: /push/ },
  { label: "$'git' stash", dollar: "$'git' stash", twin: 'git stash', guard: /R-WSRC-GR/, expected: /stash/ },
  // The VERB, not just the exec — `git $'reset'` runs a reset too.
  { label: "git $'reset'", dollar: "git $'reset' --hard HEAD~1", twin: 'git reset --hard HEAD~1', guard: /R-WSRC-GR/, expected: /reset/ },
  // Inside a `-c` payload, where the whole command string is ONE token.
  { label: "bash -c $'git reset'", dollar: "bash -c $'git reset --hard HEAD~1'", twin: "bash -c 'git reset --hard HEAD~1'", guard: /R-WSRC-GR/, expected: /reset/ },
  // Mid-word after a path separator: bash builds `/usr/bin/git`.
  { label: "/usr/bin/$'git'", dollar: "/usr/bin/$'git' reset --hard", twin: '/usr/bin/git reset --hard', guard: /R-WSRC-GR/, expected: /reset/ },
  // Composed with the AP-EXT-ITER64-01 command-prefix family.
  { label: "env $'git'", dollar: "env $'git' reset --hard", twin: 'env git reset --hard', guard: /R-WSRC-GR/, expected: /reset/ },
  // ANSI-C escapes really do spell the name — delimiter stripping alone misses these.
  { label: "$'\\x67it' (hex escape)", dollar: "$'\\x67it' reset --hard", twin: 'git reset --hard', guard: /R-WSRC-GR/, expected: /reset/ },
  { label: "$'\\147it' (octal escape)", dollar: "$'\\147it' reset --hard", twin: 'git reset --hard', guard: /R-WSRC-GR/, expected: /reset/ },
  // R-WSRC — the deploy-script ban, on both the wrapper and the script token
  { label: "$'bash' install.sh", dollar: "$'bash' install.sh", twin: 'bash install.sh', guard: /R-WSRC/, expected: /install\.sh/ },
  { label: "bash $'install.sh'", dollar: "bash $'install.sh'", twin: 'bash install.sh', guard: /R-WSRC/, expected: /install\.sh/ },
]) {
  test(`AP-EXT-ITER66-01: worker blocks ${label} ($-introduced quoting)`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command: dollar },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', dollar);
    assert.match(result.reason, guard);
    assert.match(result.reason, expected);
  });

  test(`AP-EXT-ITER66-01: ${label} matches its bare twin (non-tautology)`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command: twin },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', twin);
    assert.match(result.reason, expected);
  });
}

// R-WSRC-3 — the same one character re-opened the protected-write gates. These
// take the session's REAL state.json path, so the block is the shipped guard
// answering about a live runtime file, not a basename coincidence.
for (const { label, build, twinBuild, expected } of [
  {
    label: "$'tee' <session>/state.json",
    build: (sf) => `$'tee' ${sf}`,
    twinBuild: (sf) => `tee ${sf}`,
    expected: /state file protected/i,
  },
  {
    label: "$'sed' -i <session>/state.json",
    build: (sf) => `$'sed' -i '' s/a/b/ ${sf}`,
    twinBuild: (sf) => `sed -i '' s/a/b/ ${sf}`,
    expected: /state file protected/i,
  },
  {
    label: "$'cp' over <session>/state.json",
    build: (sf) => `$'cp' /tmp/x ${sf}`,
    twinBuild: (sf) => `cp /tmp/x ${sf}`,
    expected: /state file protected/i,
  },
  {
    label: "$'sed' -i pickle_settings.json",
    build: () => "$'sed' -i '' s/a/b/ pickle_settings.json",
    twinBuild: () => "sed -i '' s/a/b/ pickle_settings.json",
    expected: /settings file protected/i,
  },
]) {
  test(`AP-EXT-ITER66-01: worker blocks ${label} ($-introduced quoting)`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const command = build(stateFile);
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', command);
    assert.match(result.reason, expected);
  });

  test(`AP-EXT-ITER66-01: ${label} matches its bare twin (non-tautology)`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const command = twinBuild(stateFile);
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', command);
    assert.match(result.reason, expected);
  });
}

// The fix widens what the scanner UNQUOTES, which is exactly the direction that
// can invent a false block. These pin that it did not: a `$` that introduces no
// span stays an ordinary character, and a write command named inside a commit
// MESSAGE is still data.
for (const approved of [
  'git status',
  'echo $HOME',
  'echo "cost is $5"',
  "git commit -m $'first line\\nsecond line'",
  'git commit -m "worker -> state.json write ordering"',
  "sed -n '1,20p' pickle_settings.json",
  'cat install.sh',
  "echo 'a'$'b'",
]) {
  test(`AP-EXT-ITER66-01: worker still approves ${JSON.stringify(approved)}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command: approved },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'approve', `${approved} → ${result.reason ?? ''}`);
  });
}

// The fold must agree with bash about the WORD, which is the property every
// detector above rests on. Every quoting expectation below was confirmed against
// a real bash (`printf '%s\n' <form>`) rather than derived from the
// implementation. `$notaspan` is the ONE deliberate divergence and is listed to
// bound the fix: bash expands it as a variable, the scanner performs no
// expansion, and that pre-existing limit (recorded in the `WRITE_COMMANDS` is a
// speed bump trap door) is unchanged here — the `$` must simply stay an ordinary
// character when it introduces no span.
test('AP-EXT-ITER66-01: the fold reproduces bash word-splitting for all four quoting forms', () => {
  for (const [form, value] of [
    ["$'git'", 'git'],
    ['$"git"', 'git'],
    ["'git'", 'git'],
    ['"git"', 'git'],
    ["$'\\x67it'", 'git'],
    ["$'\\147it'", 'git'],
    ["/usr/bin/$'git'", '/usr/bin/git'],
    ["$'a\\'b'", "a'b"],
    ["a$'b'c", 'abc'],
    ['$notaspan', '$notaspan'],
    ['$', '$'],
  ]) {
    const tokens = tokenizeShellTokens(form);
    assert.equal(tokens.length, 1, `${JSON.stringify(form)} must fold to ONE word`);
    assert.equal(tokens[0].value, value, JSON.stringify(form));
  }
});

// A `$`-introduced span is QUOTED, so the character it carries is data. Without
// this, `$'>'` would read as a redirect operator and the AP-EXT-ITER51-01
// refused-commit class returns through the new forms.
test('AP-EXT-ITER66-01: a $-introduced span is quoted, so its content is data', () => {
  for (const form of ["$'>'", '$">"', "'>'", '">"']) {
    assert.equal(tokenizeShellTokens(form)[0].quoted, true, form);
  }
  for (const form of ['>', "x$'>'"]) {
    assert.equal(tokenizeShellTokens(form)[0].quoted, false, form);
  }
});

// Structural pin: the grammar must DECLARE all four forms. Behavior alone would
// be satisfied by a special case bolted onto one detector, which is the shape
// this module has had to remove nine times.
test('AP-EXT-ITER66-01: the word grammar declares all four bash quoting forms', () => {
  const shellExec = fs.readFileSync(
    path.resolve(__dirname, '../../src/hooks/shell-exec.ts'),
    'utf8',
  );
  const alternation = shellExec.match(/const WORD_PART_SOURCE =[\s\S]*?;\n/);
  assert.ok(alternation, 'WORD_PART_SOURCE must remain a single declaration');
  for (const span of [
    'ANSI_C_QUOTED_SPAN',
    'LOCALE_QUOTED_SPAN',
    'DOUBLE_QUOTED_SPAN',
    'SINGLE_QUOTED_SPAN',
  ]) {
    assert.ok(
      alternation[0].includes(span),
      `WORD_PART_SOURCE must offer ${span} — an undeclared quoting form is ` +
        `scanned as ordinary characters and silently changes the folded word`,
    );
  }
  // The ordinary-character run must yield the `$` back to the span it belongs
  // to; a bare `[^\s'"]+` swallows it and re-opens the mid-word path case.
  assert.ok(
    /const UNQUOTED_RUN = '\(\?:\(\?!\\\\\$\[\\'"\]\)/.test(shellExec),
    'UNQUOTED_RUN must stop before a $ that introduces a quoted span',
  );
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER66-02 — a THROW in the scanner is a blanket approve, not a crash
//
// The AP-EXT-ITER66-01 decoder resolved every numeric ANSI-C escape through
// `String.fromCodePoint`, which raises RangeError past U+10FFFF. `dispatch.ts`
// fails OPEN, so the throw did not surface as a crash — the handler answered
// `approve` for the WHOLE command. `$'\UFFFFFFFF' ; git reset --hard` therefore
// disarmed every guard in config-protection at once, and a `git` shim confirmed
// the reset really runs. That is strictly worse than the bypass ITER66-01 closed:
// one token, any forbidden op.
//
// The fix needs no per-escape table — an escape that names NO character stands
// as written, which is both non-throwing and what bash 3.2 actually does
// (`printf '%q' $'\UFFFFFFFF'` prints the literal text back).
// ---------------------------------------------------------------------------

for (const { label, command, expected } of [
  { label: 'out-of-range \\U in an argument', command: String.raw`git $'\UFFFFFFFF' reset --hard`, expected: /reset/ },
  { label: 'out-of-range \\U as its own segment', command: String.raw`$'\UFFFFFFFF' ; git reset --hard`, expected: /reset/ },
  { label: 'just-past-max \\U', command: String.raw`$'\U00110000' ; git push origin main`, expected: /push/ },
]) {
  test(`AP-EXT-ITER66-02: worker still blocks with ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', command);
    assert.match(result.reason, /R-WSRC-GR/);
    assert.match(result.reason, expected);
  });
}

// The general invariant, stated where it can be checked: this scanner runs inside
// a fail-open hook, so ANY input it throws on is an approve. Behavior cases pin
// the forms already measured; this pins the property they are instances of.
test('AP-EXT-ITER66-02: the tokenizer never throws, whatever the escape names', () => {
  const hostile = [
    String.raw`$'\UFFFFFFFF'`,
    String.raw`$'\U00110000'`,
    String.raw`$'\Uffffffff'`,
    String.raw`$'￿'`,
    String.raw`$'\xFF'`,
    String.raw`$'\777'`,
    String.raw`$'\0'`,
    String.raw`$'\'`,
    String.raw`$'\\'`,
    String.raw`$'`,
    '$"',
    '$',
    "$'\\UFFFFFFFF' && bash install.sh",
  ];
  for (const form of hostile) {
    assert.doesNotThrow(() => tokenizeShellTokens(form), `tokenizeShellTokens(${JSON.stringify(form)})`);
    assert.doesNotThrow(() => splitShellSegments(form), `splitShellSegments(${JSON.stringify(form)})`);
  }
});

// bash leaves an unresolvable escape as literal text; so must the fold, or the
// two disagree about the word and the disagreement is a bypass in one direction
// or a false block in the other.
test('AP-EXT-ITER66-02: an escape naming no character stands as written', () => {
  for (const [form, value] of [
    [String.raw`$'\UFFFFFFFF'`, String.raw`\UFFFFFFFF`],
    [String.raw`$'\U00110000'`, String.raw`\U00110000`],
    [String.raw`$'\U0010FFFF'`, String.fromCodePoint(0x10FFFF)],
  ]) {
    assert.equal(tokenizeShellTokens(form)[0].value, value, form);
  }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER69-01 — the module is IMPORTABLE, so it must not run on import.
//
// The handler exports `detectProhibitedGitVerb` and `PROTECTED_WRITE_GLOBS`
// ("for downstream tools that import the handler for auditing"). Without a CLI
// entry guard the top-level `main()` ran on every import: it read fd 0 and
// printed a hook decision into the importer's stdout. Measured pre-fix — with
// stdin ignored the import emitted `{"decision":"approve"}` ahead of the
// importer's own output; with stdin an open, never-written pipe (the stdio
// shape `node --test` and any spawn-based tool harness give a child) the
// import NEVER RETURNED. Both sibling handlers already carry the guard; only
// this one never had it.
//
// The pin is the emitted-decision half because it is decided by CONTENT, not
// by elapsed time. The stdin block is the same one line and needs no second,
// timing-shaped case.
// ---------------------------------------------------------------------------

function importHandlerInChild() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-import-'));
  try {
    const probe = path.join(tmpDir, 'import-probe.mjs');
    fs.writeFileSync(
      probe,
      `await import(${JSON.stringify(pathToFileURL(HANDLER).href)});\n`
        + `process.stdout.write('IMPORTED');\n`,
    );
    // stdin is 'ignore', so a pre-fix handler still terminates and the failure
    // surfaces as the decision it printed rather than as a hung test.
    return execFileSync(process.execPath, [probe], {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('AP-EXT-ITER69-01: importing the handler emits no hook decision', () => {
  const stdout = importHandlerInChild();
  assert.equal(
    stdout,
    'IMPORTED',
    'importing config-protection.js must not run main(); it wrote a hook decision into the importer stdout',
  );
  assert.doesNotMatch(stdout, /"decision"/);
});

// The anti-disarm control. A guard that does not fire for dispatch's own argv
// shape is strictly worse than no guard: the hook emits nothing and dispatch's
// "no valid decision JSON" arm approves every worker-forbidden op. dispatch.ts
// spawns `node <handlers>/config-protection.js`, so argv[1]'s BASENAME is what
// the guard may key on — never a realpath-exact form (AP-EXT-ITER4-01).
test('AP-EXT-ITER69-01 control: the entry guard still fires for dispatch argv, so the block lands', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git reset --hard HEAD~1' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-WSRC-GR/);
});

// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
// `git reset`. parseFirstShellWord's bare split read the token `"git"`, so
// detectProhibitedGitVerb skipped the segment (`"git"` !== 'git') and the reset
// slipped the guard — the quoted-executable twin of the quoted-verb bypass.
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

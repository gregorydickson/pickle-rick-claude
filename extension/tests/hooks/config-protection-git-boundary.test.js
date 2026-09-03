// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as ts from 'typescript';
import { execAnchorIndex, execName, execNameIs, isShellWrapper, splitShellSegments, tokenizeShellTokens } from '../../hooks/shell-exec.js';
import { mkFixtureTmpDir } from '../helpers/fixture-tmpdir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HANDLER = path.resolve(__dirname, '../../hooks/handlers/config-protection.js');
const CONFIG_PROTECTION_TS = path.resolve(__dirname, '../../src/hooks/handlers/config-protection.ts');
const SHELL_EXEC_TS = path.resolve(__dirname, '../../src/hooks/shell-exec.ts');

/**
 * The file's code with every comment blanked out - by the parser, and without
 * moving a character, so an index taken from this text addresses the same byte
 * in the file and every slice delimiter below still resolves.
 *
 * Every source-text pin in this file asks a question about CODE, and each one
 * was answerable by PROSE in BOTH directions. Measured on the shipped tree
 * (AP-EXT-ITER180-01): the `break` that AP-EXT-ITER54-02's shape pin exists to
 * forbid read GREEN with one comment naming the slice's end delimiter, and a
 * correct file RED behind one documentation comment quoting an operand-taking
 * node option.
 *
 * Keeping exactly the leaf-token spans needs no enumeration of the lexical
 * contexts a marker can hide inside - a hand-rolled comment regex reads a
 * marker inside a string, template or regex literal as a real one. JSDoc is the
 * one comment the parser returns as a node rather than as trivia, so it is
 * skipped explicitly.
 *
 * DELIBERATE duplication: fourth copy. A shared home under `extension/tests`
 * would be a NEW file and `scope.json` allowed_paths is a strict snapshot with
 * no directory entries, so no importable home exists. See AP-EXT-ITER174-01.
 */
function codeMask(source, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const isJsDoc = (node) => node.kind >= ts.SyntaxKind.FirstJSDocNode
    && node.kind <= ts.SyntaxKind.LastJSDocNode;
  // Indexed by UTF-16 code UNIT, which is what `getStart`/`getEnd` count.
  const out = new Array(source.length);
  for (let i = 0; i < source.length; i += 1) out[i] = source[i] === '\n' ? '\n' : ' ';

  const keep = (node) => {
    if (isJsDoc(node)) return;
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      for (let i = node.getStart(sourceFile); i < node.getEnd(); i += 1) out[i] = source[i];
      return;
    }
    children.forEach(keep);
  };
  keep(sourceFile);

  return out.join('');
}

/**
 * The ONE way a pin asks a question about DOCUMENTATION rather than about code.
 * `readCode` blanks every comment, so a pin that asserts a docblock SURVIVED
 * cannot use it - and reaching for raw bytes here would re-open exactly what
 * `readCode` closes. This reader is structurally incapable of answering a code
 * question: it returns the JSDoc span and nothing else, so it can never become
 * the escape hatch a second raw read would be.
 */
function docCommentOf(file, name) {
  const source = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let text = null;
  sourceFile.forEachChild((node) => {
    if (node.name?.text !== name) return;
    const docs = node.jsDoc ?? [];
    if (docs.length > 0) text = docs.map((d) => source.slice(d.getStart(sourceFile), d.getEnd())).join('\n');
  });
  return text;
}

const CODE_CACHE = new Map();

/**
 * The ONE way a pin in this file reads a source file. Routing every read here
 * is what stops the next pin being born comment-blind; a correct reader nobody
 * is obliged to use guarantees nothing (AP-EXT-ITER178-01). Cached because this
 * is a fast-tier file with 19 read sites over 5 source files.
 */
function readCode(file) {
  let masked = CODE_CACHE.get(file);
  if (masked === undefined) {
    masked = codeMask(fs.readFileSync(file, 'utf8'), file);
    CODE_CACHE.set(file, masked);
  }
  return masked;
}

/**
 * This file's own bytes, for the pin below that parses this file. Argument-less
 * by construction, so it can never become a second reader of anything else.
 */
function readSelf() {
  return fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
}

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
  const tmpDir = mkFixtureTmpDir('cp-git-');
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
  const source = readCode(CONFIG_PROTECTION_TS);
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
      if (readCode(full).includes('parseFirstShellWord')) offenders.push(full);
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
  const shellExec = readCode(SHELL_EXEC_TS);
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
  const configProtection = readCode(CONFIG_PROTECTION_TS);
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
// AP-EXT-ITER74-01 — the collapse landed; the SIBLING's prose said it had not
//
// ITER64-01 (shell-exec.ts) and ITER64-02 (config-protection.ts) shipped the same
// collapse on 2026-08-26. ITER64-02 corrected CLAUDE.md and the comment on the pin
// above, but MISSED the `execAnchorIndex` docblock in shell-exec.ts, which went on
// asserting in the present tense that Pass 2 "still reads" the quoting-plus-exec-
// index arm, that it was "left untouched ... NOT because it is safe", and that
// `env 'tee' <session>/state.json` still APPROVES for a worker — re-opening "every
// R-WSRC-3 protected-state-file write guard". All false the day it was written.
//
// The pin above grades the CODE and stayed green through all of it, because prose
// in a sibling file is invisible to it. That asymmetry is the defect: a reviewer
// opening `execAnchorIndex` — the canonical home of the quoting-blind exec-anchor
// rule — was told by the same docblock that its sibling guard was bypassable, and
// the text NAMED the deleted arm as current. Acting on it means re-adding an arm
// that mutation-tests at 19 RED. CI catches the code change; nothing caught the
// prose inviting it.
//
// So grade the prose with the same token test that grades the code, and grade it
// in the file that made the claim. `execIndex` is config-protection's deleted
// LOCAL — shell-exec.ts never had one and has no business naming it. Saying a
// corpse is gone, in backticks, is indistinguishable from referencing a live
// symbol under a grep-based grader (the same reason the trap-door catalogs forbid
// naming removed symbols in prose), so the assertion is zero occurrences, not
// zero live uses.
// ---------------------------------------------------------------------------

test('AP-EXT-ITER74-01: shell-exec.ts names no exec-index arm, live or quoted', () => {
  const shellExecSrc = readCode(SHELL_EXEC_TS);

  assert.equal(
    (shellExecSrc.match(/execIndex/g) || []).length,
    0,
    'shell-exec.ts must not contain `execIndex` anywhere — it is the deleted ' +
      'local from findWriteTargetInScope Pass 2 (AP-EXT-ITER64-02). In code it ' +
      'would re-admit the positional exec read; in prose it re-creates the ' +
      'phantom this pin exists to keep dead.',
  );
  assert.equal(
    (shellExecSrc.match(/tokens\[i\]\.quoted/g) || []).length,
    0,
    'shell-exec.ts must not contain `tokens[i].quoted` — the exact index form ' +
      'of the arm ITER64-02 deleted. shell-exec.ts owns no token loop that ' +
      'gates on quoting; `hereStringPayload` reads `token.quoted` on a single ' +
      'token, which is a different and legitimate shape.',
  );

  // The load-bearing knowledge must SURVIVE the correction: the two anchors are
  // asymmetric, and only the exec one is safe to make quoting-blind. A rewrite
  // that deleted the false claim AND this rationale would invite the opposite
  // error — collapsing Pass 1 too, which re-opens AP-EXT-ITER51-01.
  const anchorDoc = docCommentOf(SHELL_EXEC_TS, 'execAnchorIndex');
  assert.ok(anchorDoc, 'execAnchorIndex must keep its docblock');
  assert.match(anchorDoc, /AP-EXT-ITER64-02/);
  assert.match(anchorDoc, /AP-EXT-ITER51-01/);
  assert.match(anchorDoc, /asymmetric/);
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
  const source = readCode(CONFIG_PROTECTION_TS);
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
  const source = readCode(CONFIG_PROTECTION_TS);
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
  const shellExec = readCode(SHELL_EXEC_TS);
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

// ---------------------------------------------------------------------------
// AP-EXT-ITER70-01 — `eval` is bash's OTHER word-to-code construct
//
// `expandShellCommandStrings` unwrapped exactly one thing: the `-c` operand of a
// shell wrapper. `eval` is the shell's other way of turning a WORD back into
// CODE, and it is a BUILTIN — no binary, no PATH entry — so `isShellWrapper`'s
// naming shape can never reach it and `shellCommandStringPayloads` is empty
// for every `eval` form. The payload is then ONE quoted token, which is the
// AP-EXT-ITER63-06 failure mode exactly: a single missed unwrap hides the WHOLE
// command from every detector at once.
//
// Measured 2026-08-26 against the shipped compiled hook: all 9 gated git verbs,
// the `bash install.sh` ban, and BOTH R-WSRC-3 write gates (state.json and
// pickle_settings.json, via `tee` and via a `>` redirect) APPROVED for a worker
// behind `eval` while every byte-identical bare twin BLOCKED. Shim-verified on
// this box: `eval "git reset --hard"`, `eval 'git stash'` and `eval "tee <f>"`
// really do exec git / tee.
//
// The fix DECLARES the grammar rather than cataloguing carriers, which is the
// AP-EXT-ITER66-01 move and not the AP-EXT-ITER10-01/12-01/18-01/19-01/54-01/
// 63-01 incomplete-set shape: bash's word-to-code constructs are CLOSED by the
// language — the `-c` operand and `eval`'s arguments. `source`/`.` take a FILE,
// not a command string, and nothing can add a builtin to bash.
//
// RESIDUAL OPEN, deliberately NOT pinned as a test (the AP-EXT-ITER63-04
// precedent — asserting a known hole `approve` would turn it into a contract):
// a shell that reads its code from a FILE DESCRIPTOR rather than from a word —
// `bash <<< '<cmd>'`, `echo '<cmd>' | sh`, `bash -s <<< '<cmd>'` — is a
// different class and still approves. Reported in the catalog instead.
//
// Over-block cost, measured before shipping: 0 new blocks across 6216 unique
// real worker Bash commands drawn from 11 prior sessions. The universal
// alternative (expand EVERY quoted word) was measured at +111 of those 6216 —
// mostly workers writing their own TASK_NOTES prose — and rejected for it.
// ---------------------------------------------------------------------------

const ITER70_01_EVAL_GIT = [
  ['a double-quoted reset', 'eval "git reset --hard HEAD~1"'],
  ['a single-quoted reset', "eval 'git reset --hard'"],
  ['a push', 'eval "git push origin main"'],
  ['a stash', 'eval "git stash"'],
  ['a rebase', 'eval "git rebase main"'],
  ['a checkout with a ref', 'eval "git checkout main"'],
  ['a switch', 'eval "git switch main"'],
  ['a commit --amend', 'eval "git commit --amend"'],
  ['a pull', 'eval "git pull"'],
  ['a fetch --prune', 'eval "git fetch --prune"'],
  ['unquoted eval arguments joined by the builtin', 'eval git reset --hard'],
  ['a command prefix before eval', 'env eval "git reset --hard"'],
  ['a case-variant builtin name', 'EVAL "git reset --hard"'],
  ['a quoted builtin name', '"eval" "git reset --hard"'],
  ['eval in a chained segment', 'cd extension && eval "git reset --hard"'],
  ['eval in a grouped segment', '(eval "git reset --hard")'],
  ['eval inside a -c payload', 'bash -c \'eval "git reset --hard"\''],
  ['a -c payload inside eval', 'eval "bash -c \'git reset --hard\'"'],
  ['a chained payload whose reset is not the first word', 'eval "cd sub && git reset --hard"'],
];

for (const [label, command] of ITER70_01_EVAL_GIT) {
  test(`AP-EXT-ITER70-01: worker blocks a prohibited git verb behind ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', JSON.stringify(command));
    assert.match(result.reason, /R-WSRC-GR/);
  });
}

test('AP-EXT-ITER70-01: worker blocks the deploy script behind eval', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'eval "bash install.sh"' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-WSRC/);
});

// Both R-WSRC-3 write gates, through both write constructs the walker knows:
// the Pass 2 command anchor (`tee`) and the Pass 1 `>` redirect.
for (const [label, build] of [
  ['a tee destination', (dir) => `eval "tee ${path.join(dir, 'state.json')}"`],
  ['a > redirect', (dir) => `eval 'echo x > ${path.join(dir, 'state.json')}'`],
]) {
  test(`AP-EXT-ITER70-01: worker blocks a state-file write behind eval via ${label}`, () => {
    const { tmpDir, sessionDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command: build(sessionDir) },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', build(sessionDir));
    assert.match(result.reason, /state file protected/i);
  });
}

test('AP-EXT-ITER70-01: worker blocks a settings write behind eval', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: `eval "tee ${path.join(tmpDir, 'pickle_settings.json')}"` },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
});

// Non-tautology twins. Without these the block cases above would pass under a
// guard that blocks any command containing the four letters `eval`.
const ITER70_01_APPROVED = [
  ['a non-gated verb behind eval', 'eval "git status"'],
  ['a read-only reference behind eval', 'eval "cat install.sh"'],
  ['a read-only git log behind eval', 'eval "git log --oneline"'],
  ['a benign payload behind eval', 'eval "echo hi"'],
  ['eval standing in argument position', 'grep -rn eval src/'],
  ['eval named inside a commit message', 'git commit -m "eval the reset later"'],
  ['a bare eval with no arguments', 'eval'],
  // The anchor is the WORD `eval`, folded through `execName` — not a substring
  // scan. A JS `eval(...)` call inside a `-e` payload is a different word.
  ['a javascript eval call in a -e payload', 'node -e "eval(\'1+1\')"'],
];

for (const [label, command] of ITER70_01_APPROVED) {
  test(`AP-EXT-ITER70-01: ${label} stays approved`, () => {
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

// The seam itself, so a detector-level regression cannot be mistaken for a
// segmentation one: `splitShellSegments` must surface the eval payload as its
// own segment, wherever the builtin sits and however the payload is quoted.
test('AP-EXT-ITER70-01: splitShellSegments surfaces the eval payload as its own segment', () => {
  for (const command of [
    'eval "git reset --hard"',
    "eval 'git reset --hard'",
    'eval git reset --hard',
    'env eval "git reset --hard"',
  ]) {
    assert.ok(
      splitShellSegments(command).includes('git reset --hard'),
      `${command} -> ${JSON.stringify(splitShellSegments(command))}`,
    );
  }
});

// Shape pin (the catalog PATTERN_SHAPE): the builtin is located by the shared
// ANCHOR and its payload is EVERY following token joined — never a positional
// read and never "the first quoted token". `eval` concatenates its arguments
// before re-parsing, so anything narrower splits `eval git reset --hard`.
//
// Retargeted by AP-EXT-ITER71-01 from `evalBuiltinPayload` onto the generalized
// `wordToCodeBuiltinPayload`: `trap` shares both halves of this shape, so it was
// absorbed by widening the DECLARATION, not by forking a second extractor. The
// no-positional-read assertions are unchanged — they are what the ITER70-01
// invariant actually said.
test('AP-EXT-ITER70-01: wordToCodeBuiltinPayload anchors and joins, with no positional read', () => {
  const source = readCode(SHELL_EXEC_TS);
  const body = source.match(/function wordToCodeBuiltinPayload\(segment: string\): string \| null \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, 'wordToCodeBuiltinPayload must remain a single named function');
  assert.match(body, /execAnchorIndex\(tokens, builtin\)/);
  assert.match(body, /tokens\.slice\(anchor \+ 1\)[\s\S]*\.join\(' '\)/);
  assert.doesNotMatch(body, /execTokenIndex|skipEnvAssignments|\.quoted/);
});


// ---------------------------------------------------------------------------
// AP-EXT-ITER70-02 — a here-string's operand is a WORD, not fd data
//
// AP-EXT-ITER70-01 declared bash's word-to-code set as the `-c` operand plus
// `eval`'s arguments, and filed everything else as a fd family whose code
// "arrives as DATA on stdin, never as a word". The boundary was drawn in the
// wrong place. A here-string's operand stands on the command line as an
// ordinary word — bash only spools it to fd 0 before the shell parses it — so
// it is recoverable by exactly the unwrap the other two constructs get.
//
// Measured against the post-ITER70-01 shipped mirror: every form below APPROVED
// for a worker while its bare twin blocked, across all three gates (git verbs,
// the install.sh ban, the R-WSRC-3 write gates). Shim-verified on this box: the
// spaced, glued, fd-prefixed, `-s`, `source /dev/stdin` and `. /dev/stdin`
// forms all really exec git.
//
// A here-DOCUMENT was never in this family — its body is newline-separated and
// the segmenter already boundaries on newlines — which is why the heredoc
// control below is a PRE-EXISTING pass, not a claim about this fix.
//
// The consumer is deliberately untested: `source`, `.` and `/dev/stdin` are not
// shell-interpreter names, so asking "is the reader a shell?" needs a LIST.
// Bash's one here-string operator is a closed grammar fact; the consumer set is
// not.
// ---------------------------------------------------------------------------

const ITER70_02_HERESTRING_GIT = [
  ['a spaced here-string', `bash <<< 'git reset --hard'`],
  ['a glued here-string', `bash <<<'git reset --hard'`],
  ['a double-quoted glued here-string', `bash <<<"git reset --hard"`],
  ['an fd-prefixed here-string', `bash 0<<< 'git push origin main'`],
  ['a non-bash shell', `zsh <<< 'git stash'`],
  ['a stdin-reading -s shell', `bash -s <<< 'git rebase main'`],
  ['the source builtin over /dev/stdin', `source /dev/stdin <<< 'git checkout main'`],
  ['the dot builtin over /dev/stdin', `. /dev/stdin <<< 'git switch main'`],
  ['a command prefix before the shell', `env bash <<< 'git commit --amend'`],
  ['a here-string in a chained segment', `cd extension && bash <<< 'git pull'`],
  ['a here-string in a grouped segment', `(bash <<< 'git fetch --prune')`],
  ['a here-string inside a -c payload', `bash -c "bash <<< 'git reset --hard'"`],
  ['a here-string inside eval', `eval "bash <<< 'git reset --hard'"`],
  ['a chained payload whose verb is not the first word', `bash <<< 'cd sub && git reset --hard'`],
];

for (const [label, command] of ITER70_02_HERESTRING_GIT) {
  test(`AP-EXT-ITER70-02: worker blocks a prohibited git verb behind ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', JSON.stringify(command));
    assert.match(result.reason, /R-WSRC-GR/);
  });
}

test('AP-EXT-ITER70-02: worker blocks the deploy script behind a here-string', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: `bash <<< 'bash install.sh'` },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-WSRC/);
});

// Both R-WSRC-3 write gates, through both write constructs the walker knows.
for (const [label, build] of [
  ['a tee destination', (dir) => `bash <<< 'tee ${path.join(dir, 'state.json')}'`],
  ['a > redirect', (dir) => `bash <<< 'echo x > ${path.join(dir, 'state.json')}'`],
]) {
  test(`AP-EXT-ITER70-02: worker blocks a state-file write behind a here-string via ${label}`, () => {
    const { tmpDir, sessionDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command: build(sessionDir) },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', build(sessionDir));
    assert.match(result.reason, /state file protected/i);
  });
}

test('AP-EXT-ITER70-02: worker blocks a settings write behind a here-string', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: `bash <<< "tee ${path.join(tmpDir, 'pickle_settings.json')}"` },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
});

// Pre-existing control, NOT a claim about this fix: a here-DOCUMENT body is
// newline-separated, so the segmenter surfaced it before this pass and must
// keep doing so. If this ever reds, the newline boundary broke, not the
// here-string unwrap.
test('AP-EXT-ITER70-02: a here-document body still blocks (pre-existing, newline boundary)', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: "bash <<'XEOF'\ngit reset --hard\nXEOF" },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
});

// Non-tautology twins. Without these the block cases above would pass under a
// guard that blocks any command containing the three characters `<<<`.
const ITER70_02_APPROVED = [
  ['a non-gated verb behind a here-string', `bash <<< 'git status'`],
  ['a read-only git log behind a here-string', `bash <<< 'git log --oneline'`],
  ['a benign payload behind a here-string', `bash <<< 'echo hi'`],
  ['a here-string into a non-shell reader', 'cat <<< hello'],
  ['a here-string feeding grep a variable', 'grep -c foo <<< "$body"'],
  // A quoted `<<<` is DATA, never the operator — the same asymmetry
  // `foldShellWord` documents for a quoted `>`. These two are the cases that
  // RED when the `token.quoted` test is dropped: the operator characters lead a
  // FULLY quoted word, which bash prints and never spools to a fd.
  ['a wholly quoted here-string operator', 'echo "<<<git reset --hard"'],
  ['a wholly single-quoted here-string operator', "echo '<<<git reset --hard'"],
  ['a quoted here-string operator inside a commit message', 'git commit -m "diff marker <<< here"'],
  ['a bare here-string with no operand', 'bash <<<'],
];

for (const [label, command] of ITER70_02_APPROVED) {
  test(`AP-EXT-ITER70-02: ${label} stays approved`, () => {
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

// The seam itself, so a detector-level regression cannot be mistaken for a
// segmentation one. The glued and fd-prefixed forms are the two the tokenizer
// folds into ONE word, which a `token.value === '<<<'` test would miss.
test('AP-EXT-ITER70-02: splitShellSegments surfaces the here-string operand as its own segment', () => {
  for (const command of [
    `bash <<< 'git reset --hard'`,
    `bash <<<'git reset --hard'`,
    `bash <<<"git reset --hard"`,
    `bash 0<<< 'git reset --hard'`,
    `source /dev/stdin <<< 'git reset --hard'`,
  ]) {
    assert.ok(
      splitShellSegments(command).includes('git reset --hard'),
      `${command} -> ${JSON.stringify(splitShellSegments(command))}`,
    );
  }
  // Monotone: the carrying segment is kept, never replaced.
  assert.ok(splitShellSegments(`bash <<< 'git reset --hard'`).includes(`bash <<< 'git reset --hard'`));
});

// Shape pin (the catalog PATTERN_SHAPE): the operator is matched on the folded
// token VALUE with an fd-prefix-tolerant regex and an unquoted test — never an
// equality compare against the literal `<<<` (which loses the glued form) and
// never a consumer/name test (which needs a list).
test('AP-EXT-ITER70-02: hereStringPayload matches the operator by shape, not by equality', () => {
  const source = readCode(SHELL_EXEC_TS);
  const body = source.match(/function hereStringPayload\(segment: string\): string \| null \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, 'hereStringPayload must remain a single named function');
  assert.match(body, /HERE_STRING_OPERATOR_RE\.test\(token\.value\)/);
  assert.match(body, /token\.quoted/);
  assert.doesNotMatch(body, /isShellWrapper|execTokenIndex|=== '<<<'/);
  assert.match(source, /const HERE_STRING_OPERATOR_RE = \/\^\\d\*<<</);
});


// ---------------------------------------------------------------------------
// AP-EXT-ITER71-01 — `trap` is bash's OTHER word-to-code builtin
//
// AP-EXT-ITER70-01 named `eval` "the shell's other one" and stopped there. It is
// not the only one: `trap '<cmd>' EXIT` hands bash a WORD that the shell
// re-parses and runs when the signal fires, and a builtin has no binary to name,
// so `isShellWrapper` cannot reach it and `shellCommandStringPayloads` is
// empty for every form. The payload stayed ONE opaque token — the AP-EXT-ITER63-06
// failure mode, where a single missed unwrap hides the whole command from every
// detector at once.
//
// Measured against the pre-fix compiled tree: all 8 forms below APPROVED for a
// worker while their byte-identical bare twins blocked, across all three gates
// (git verbs, the install.sh ban, the R-WSRC-3 write gates). Shim-verified on
// this box: `bash -c "trap 'git reset --hard' EXIT; true"` really runs git.
//
// The fix GENERALIZED `evalBuiltinPayload` into `wordToCodeBuiltinPayload` over a
// two-member declaration rather than adding a fourth extractor: the two builtins
// share the same anchor and the same take, so a second function would have been
// the same check written twice — the guard-family fork AP-EXT-ITER12-01 already
// paid for.
//
// Over-block cost, measured over 7011 unique real worker Bash commands from 13
// sessions' tmux_iteration logs: 92 change segment sets, of which the real A/B
// showed +2 new blocks and 0 lost blocks — both new blocks reviewer probe
// scripts whose text really does exec `git reset` from a trap handler, i.e. true
// positives. 0 of 7011 lost a segment, so the unwrap stayed monotone.
// ---------------------------------------------------------------------------

const ITER71_01_TRAP_GIT = [
  ['a single-quoted trap handler', `trap 'git reset --hard' EXIT`],
  ['a double-quoted trap handler', `trap "git push origin main" EXIT`],
  ['a non-EXIT signal', `trap 'git stash' DEBUG`],
  ['an ERR trap', `trap 'git rebase -i HEAD~2' ERR`],
  ['a \`--\`-separated handler', `trap -- 'git checkout main' EXIT`],
  ['a command prefix before the builtin', `env trap 'git switch main' EXIT`],
  ['a multi-word amend handler', `trap 'git commit --amend -m x' EXIT`],
  ['a trap in a chained segment', `cd extension && trap 'git pull' EXIT`],
  ['a trap in a grouped segment', `(trap 'git fetch --prune' EXIT)`],
  ['a trap inside a -c payload', `bash -c "trap 'git reset --hard' EXIT"`],
  ['a trap inside eval', `eval "trap 'git reset --hard' EXIT"`],
  ['eval inside a trap', `trap 'eval "git switch main"' EXIT`],
  ['a chained handler whose verb is not the first word', `trap 'cd sub && git reset --hard' EXIT`],
];

for (const [label, command] of ITER71_01_TRAP_GIT) {
  test(`AP-EXT-ITER71-01: worker blocks a prohibited git verb behind ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', JSON.stringify(command));
    assert.match(result.reason, /R-WSRC-GR/);
  });
}

test('AP-EXT-ITER71-01: worker blocks the deploy script behind a trap handler', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: `trap 'bash install.sh' EXIT` },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-WSRC/);
});

// Both R-WSRC-3 write gates, through both write constructs the walker knows.
for (const [label, build] of [
  ['a tee destination', (dir) => `trap 'tee ${path.join(dir, 'state.json')}' EXIT`],
  ['a > redirect', (dir) => `trap 'echo x > ${path.join(dir, 'state.json')}' EXIT`],
]) {
  test(`AP-EXT-ITER71-01: worker blocks a state-file write behind a trap handler via ${label}`, () => {
    const { tmpDir, sessionDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command: build(sessionDir) },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', build(sessionDir));
    assert.match(result.reason, /state file protected/i);
  });
}

test('AP-EXT-ITER71-01: worker blocks a settings write behind a trap handler', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: `trap "tee ${path.join(tmpDir, 'pickle_settings.json')}" EXIT` },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
});

// Non-tautology twins. Without these the block cases above would pass under a
// guard that blocks any command containing the four characters `trap`. The
// prose cases are the ones that matter here: this repo's own commit messages and
// CLAUDE.md catalogs are full of the words "trap door", and the +2 over-block
// measurement says those must stay approved.
const ITER71_01_APPROVED = [
  ['a non-gated verb in a trap handler', `trap 'git status' EXIT`],
  ['a read-only git log in a trap handler', `trap 'git log --oneline' EXIT`],
  ['a benign cleanup trap', `trap 'rm -f "$tmp"' EXIT`],
  ['a trap reset', 'trap - EXIT'],
  ['a trap listing', 'trap -p'],
  ['a bare trap with no operand', 'trap'],
  ['the word trap as a grep pattern', 'grep -rn trap extension/src'],
  ['the phrase trap door in a commit message', `git commit -m "anatomy-park: catalog 3 trap doors"`],
  ['the phrase trap door in an echo', `echo 'this trap door claims to hold shut'`],
  ['a filename containing trap', 'cat docs/trap-doors.md'],
];

for (const [label, command] of ITER71_01_APPROVED) {
  test(`AP-EXT-ITER71-01: ${label} stays approved`, () => {
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

// The seam itself, so a detector-level regression cannot be mistaken for a
// segmentation one.
test('AP-EXT-ITER71-01: splitShellSegments surfaces a trap handler as its own segment', () => {
  for (const command of [
    `trap 'git reset --hard' EXIT`,
    `trap "git reset --hard" EXIT`,
    `trap -- 'git reset --hard' EXIT`,
    `env trap 'git reset --hard' EXIT`,
  ]) {
    const segments = splitShellSegments(command);
    assert.ok(
      segments.some((segment) => segment.includes('git reset --hard')),
      `${command} -> ${JSON.stringify(segments)}`,
    );
  }
  // Monotone: the carrying segment is kept, never replaced.
  assert.ok(splitShellSegments(`trap 'git reset --hard' EXIT`).includes(`trap 'git reset --hard' EXIT`));
});

// Declaration pin: the family is a two-member GRAMMAR set consumed by one
// extractor. If a future pass adds a third word-to-code builtin it belongs in
// this array — not in a fourth function beside it, which is the fork this fix
// exists to prevent.
test('AP-EXT-ITER71-01: the word-to-code builtins are one declared set, not two extractors', () => {
  const source = readCode(SHELL_EXEC_TS);
  assert.match(source, /const WORD_TO_CODE_BUILTINS = \['eval', 'trap'\] as const;/);
  assert.doesNotMatch(source, /function evalBuiltinPayload|function trapBuiltinPayload/);
  // expandShellCommandStrings declares exactly the three word-to-code CONSTRUCTS.
  const body = source.match(/function expandShellCommandStrings\([\s\S]*?\n\}/)?.[0];
  assert.ok(body, 'expandShellCommandStrings must remain a single named function');
  for (const extractor of ['wordToCodeBuiltinPayload', 'shellCommandStringPayloads', 'hereStringPayload']) {
    assert.ok(body.includes(`${extractor}(segment)`), `${extractor} must stay in the payload array`);
  }
});


// ---------------------------------------------------------------------------
// AP-EXT-ITER72-01 — a BACKSLASH is bash's cheapest quoting mechanism
//
// The grammar declared FOUR word-quoting forms after AP-EXT-ITER66-01 (`'…'`,
// `"…"`, `$'…'`, `$"…"`) and missed the fifth, which needs no delimiter at all:
// outside quotes, `\<char>` quotes exactly that character. For every character
// that is NOT special that is a pure no-op on execution — it only suppresses
// alias lookup — so `\git`, `g\it` and `gi\t` all really exec git.
//
// Measured against the shipped mirror before the fix: the backslash fell into
// `UNQUOTED_RUN` as an ordinary character, so `execName` folded `\git` to
// `\git`. Because `execName` is the hooks subsystem's single exec-token seam,
// ONE backslash defeated every detector built on it at once — 5/5 gated verbs
// that block bare APPROVED as `\git <verb>`, `isGitCommitCommand` missed
// `\git commit` (skipping the R-WACT tsc gate), `execName('\tee')` missed every
// `WRITE_COMMANDS` member (re-opening the R-WSRC-3 write gates), and
// `isShellWrapper('\bash')` was false, so an escaped wrapper's `-c` payload was
// never even unwrapped. Shim-verified on this box: `bash -c '\git reset --hard'`,
// `bash -c 'g\it reset --hard'` and `bash -c 'gi\t push --force'` ALL really
// exec git.
//
// The module already decoded the HARDER escape grammar correctly — `$'\x67it'`
// blocked, because `decodeAnsiCEscapes` runs on ANSI-C spans — so this was an
// inconsistency inside the module's own decoding, not an unknown.
//
// The fix declares the grammar (one `UNQUOTED_ESCAPE` word part), it does NOT
// add a case: there is deliberately no table of escaped command names, because
// quoting a non-special character is a no-op for EVERY character and an
// enumerated list is the incomplete-set shape this module has paid for eleven
// times.
//
// The escaped NEWLINE is the same bypass wearing a different escape: bash
// splices a line continuation out, so `gi\<newline>t reset --hard` really runs
// git. The fold must DELETE it, not treat it as an ordinary character.
// ---------------------------------------------------------------------------

const BS = String.fromCharCode(92);

// Every one of the 9 GATED_GIT_VERBS in escaped form, plus the escape in each
// of the three positions within the word, plus the escape landing on the VERB
// instead of the executable, plus each construct the segmenter unwraps. The
// per-position spread matters: a fix that special-cased a LEADING backslash
// would pass the first row and fail the next two.
const ITER72_01_ESCAPED_GIT = [
  ['a leading backslash', BS + 'git reset --hard', 'reset'],
  ['a mid-word backslash', 'g' + BS + 'it switch main', 'switch'],
  ['a trailing backslash', 'gi' + BS + 't stash', 'stash'],
  ['an escaped rebase', BS + 'git rebase -i', 'rebase'],
  ['an escaped pull', BS + 'git pull', 'pull'],
  ['an escaped push', BS + 'git push origin main', 'push'],
  ['an escaped checkout-with-ref', BS + 'git checkout main', 'checkout'],
  ['an escaped commit --amend', BS + 'git commit --amend', 'commit'],
  ['an escaped fetch --prune', BS + 'git fetch --prune', 'fetch'],
  ['an escape on the VERB, not the exec', 'git re' + BS + 'set --hard', 'reset'],
  ['a LINE CONTINUATION inside the exec', 'gi' + BS + '\nt reset --hard', 'reset'],
  ['an escaped exec in a chained segment', 'cd extension && ' + BS + 'git reset --hard', 'reset'],
  ['an escaped exec in a grouped segment', '(' + BS + 'git reset --hard)', 'reset'],
  ['an escaped exec inside a -c payload', `bash -c "${BS}${BS}git reset --hard"`, 'reset'],
  ['an escaped WRAPPER whose payload must still unwrap', `${BS}bash -c "git reset --hard"`, 'reset'],
  ['an escaped exec inside eval', `eval "${BS}${BS}git reset --hard"`, 'reset'],
  ['an escaped exec behind a command prefix', 'env ' + BS + 'git push origin main', 'push'],
];

for (const [label, command, verb] of ITER72_01_ESCAPED_GIT) {
  test(`AP-EXT-ITER72-01: worker blocks a prohibited git verb behind ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', JSON.stringify(command));
    assert.match(result.reason, /R-WSRC-GR/);
    // The block must name the verb the shell would really have run — a guard
    // that blocked on the backslash alone would pass the line above.
    assert.match(result.reason, new RegExp('`git ' + verb), JSON.stringify(command));
  });
}

test('AP-EXT-ITER72-01: worker blocks the deploy script behind an escaped wrapper', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: `${BS}bash install.sh` },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-WSRC/);
});

// Both R-WSRC-3 write gates, through both write constructs the walker knows.
// The escaped `tee` is the one that proves the fold reaches `WRITE_COMMANDS`;
// the escaped `>` proves the redirect anchor is not demoted by the escape.
for (const [label, build] of [
  ['an escaped tee destination', (dir) => `${BS}tee ${path.join(dir, 'state.json')}`],
  ['an escaped in-place editor', (dir) => `${BS}sed -i '' s/a/b/ ${path.join(dir, 'state.json')}`],
  ['an escaped exec before a > redirect', (dir) => `${BS}echo x > ${path.join(dir, 'state.json')}`],
]) {
  test(`AP-EXT-ITER72-01: worker blocks a state-file write via ${label}`, () => {
    const { tmpDir, sessionDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command: build(sessionDir) },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', build(sessionDir));
    assert.match(result.reason, /state file protected/i);
  });
}

test('AP-EXT-ITER72-01: worker blocks a settings write behind an escaped tee', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: `${BS}tee ${path.join(tmpDir, 'pickle_settings.json')}` },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
});

// Non-tautology twins. Without these the block cases above would pass under a
// guard that blocks any command containing a backslash — which would be a
// catastrophic over-block, since `find -exec … \;` and escaped quotes in commit
// prose are everyday worker commands. These are the READ-PATH approvals the
// fix had to preserve: an escape must fold the word, never arm a detector that
// the bare twin would not arm.
const ITER72_01_APPROVED = [
  ['an escaped non-gated verb', BS + 'git status'],
  ['an escaped read-only git log', BS + 'git log --oneline'],
  ['an escaped git checkout -- path', BS + 'git checkout -- src/foo.ts'],
  ['an escaped plain commit (no --amend)', BS + 'git commit -m x'],
  ['an escaped plain fetch (no --prune)', BS + 'git fetch'],
  ['an escaped ordinary command', BS + 'ls -la'],
  ['a find -exec terminator', `find . -name "*.ts" -exec grep -l x {} ${BS};`],
  ['an escaped quote in commit prose', `git commit -m "a ${BS}${BS}" b"`],
  ['a read-only sed on a protected path', `sed -n '1,20p' state.json`],
];

for (const [label, command] of ITER72_01_APPROVED) {
  test(`AP-EXT-ITER72-01: ${label} stays approved`, () => {
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

// Quoting invariance: the escape must fold to EXACTLY what the bare and the
// already-supported quoted forms fold to. A fix that produced a third answer
// would satisfy the block cases while leaving the seam inconsistent.
test('AP-EXT-ITER72-01: an escaped exec folds identically to its bare and quoted twins', () => {
  for (const [escaped, bare] of [
    [BS + 'git', 'git'],
    ['g' + BS + 'it', 'git'],
    ['gi' + BS + 't', 'git'],
    [BS + 'bash', 'bash'],
    [BS + 'tee', 'tee'],
    ['/usr/bin/' + BS + 'git', 'git'],
  ]) {
    const [token] = tokenizeShellTokens(escaped);
    assert.equal(execName(token.value), bare, escaped);
    assert.equal(execName(tokenizeShellTokens(`'${bare}'`)[0].value), bare, bare);
  }
  // A line continuation is spliced OUT, not folded to a newline character.
  assert.equal(execName(tokenizeShellTokens('gi' + BS + '\nt')[0].value), 'git');
  // An escaped WRAPPER is still a wrapper, so its -c payload still unwraps.
  assert.equal(isShellWrapper(tokenizeShellTokens(BS + 'bash')[0].value), true);
});

// An ESCAPED separator is data, exactly like a quoted one: bash runs
// `echo A \; echo B` as ONE command printing `A ; echo B` (verified on this
// box), so the segmenter must not break there.
test('AP-EXT-ITER72-01: an escaped separator is data, not a segment boundary', () => {
  assert.deepEqual(splitShellSegments(`echo A ${BS}; echo B`), [`echo A ${BS}; echo B`]);
  // BOTH `&` must be escaped to stay one command: in `\&&` the second `&` is a
  // real background operator, so bash runs `echo A '&'` then `echo B`
  // (verified). Splitting there is CORRECT, and the case below pins that too.
  assert.deepEqual(
    splitShellSegments(`echo A ${BS}&${BS}& echo B`),
    [`echo A ${BS}&${BS}& echo B`],
  );
  assert.equal(splitShellSegments(`echo A ${BS}&& echo B`).length, 2);
  // The unescaped twins still split, so the rule above is not a blanket
  // suppression of the separator set.
  assert.equal(splitShellSegments('echo A ; echo B').length, 2);
  assert.equal(splitShellSegments('echo A && echo B').length, 2);
});

// The grammar itself, so a detector-level regression cannot be mistaken for a
// tokenizer one — and so the fix stays list-free.
test('AP-EXT-ITER72-01: the escape is declared in the word grammar, with no command table', () => {
  const source = readCode(SHELL_EXEC_TS);
  // The escape is a first-class word part, tried BEFORE every quoted span so
  // `\"` cannot be read as a span opener.
  assert.match(source, /const UNQUOTED_ESCAPE = /);
  assert.match(source, /const WORD_PART_SOURCE =\s*\n\s*`\$\{UNQUOTED_ESCAPE\}`/);
  // The run must not be able to swallow a backslash, or the escape part never
  // gets a turn. Asserted through the exported tokenizer rather than by pinning
  // the literal's exact escaping: a source-text pin on a regex constant reddens
  // on a reformat with no behavior change, which is a phantom violation.
  assert.equal(tokenizeShellTokens('a' + BS + 'b')[0].value, 'ab');
  // One decoder, shared by the fold and the boundary splitter.
  const body = source.match(/function unquotedEscapeChar\(part: string\): string \| null \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, 'unquotedEscapeChar must remain a single named function');
  assert.match(body, /part\[1\] === '\\n' \? '' : part\[1\]/);
  // List-free: no table of escaped command names anywhere in the module.
  assert.doesNotMatch(source, /'\\\\(git|bash|sh|tee|cp|mv|sed|node)'/);
});


// ---------------------------------------------------------------------------
// AP-EXT-ITER73-01: bash EXPANDS the command word, so a glob names the command
//
// Pathname expansion applies to the command word like any other word, so
// `/usr/bin/gi?` really execs git and `bash instal?.sh` really runs the deploy
// script (shim-verified on this box: `/usr/bin/gi? --version` prints the git
// version). `execName` folds those to `gi?` / `instal?.sh` — expansion is not
// quoting, so the fold cannot undo it — and every `=== name` compare missed:
// all nine gated verbs, both `bash -c` and bare, APPROVED for a worker while
// their literal twins blocked (measured against the shipped handler).
// ---------------------------------------------------------------------------

test('AP-EXT-ITER73-01: a globbed git exec token blocks every gated verb', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  for (const command of [
    '/usr/bin/gi? reset --hard',
    '/usr/bin/gi* reset --hard HEAD~1',
    '/usr/bin/gi[t] reset --hard',
    '/usr/bin/g?t push origin main',
    '/usr/bin/gi? pull',
    '/usr/bin/gi? stash',
    '/usr/bin/gi? rebase -i HEAD~2',
    '/usr/bin/gi? switch main',
    '/usr/bin/gi? checkout main',
    '/usr/bin/gi? commit --amend',
    '/usr/bin/gi? fetch --prune',
    // The glob survives every carrier the module already unwraps.
    'cd sub && /usr/bin/gi? reset --hard',
    'bash -c "/usr/bin/gi? reset --hard"',
    '(/usr/bin/gi? reset --hard)',
    'env /usr/bin/gi? reset --hard',
  ]) {
    const result = runHandler({
      tmpDir, stateFile, toolName: 'Bash', toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', command);
  }
});

test('AP-EXT-ITER73-01: a globbed install.sh invocation is still the deploy script', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  for (const command of ['bash instal?.sh', 'bash install.s?', 'sh instal*.sh']) {
    const result = runHandler({
      tmpDir, stateFile, toolName: 'Bash', toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', command);
  }
});

// Non-tautology controls: the pattern read must not turn every glob-bearing
// command into a block. Measured on 8778 real worker Bash commands from the
// live session logs, these are the shapes that dominate the corpus.
test('AP-EXT-ITER73-01: ordinary argument globs still approve', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  for (const command of [
    'ls *.ts',
    'rm -rf dist/*',
    'grep -rn "reset" src/**/*.ts',
    'git status',
    'git log --oneline -5',
  ]) {
    const result = runHandler({
      tmpDir, stateFile, toolName: 'Bash', toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'approve', command);
  }
});

// The predicate itself, so a detector-level regression cannot be mistaken for a
// compare-level one — and so the wildcard bound stays measurable.
test('AP-EXT-ITER73-01: execNameIs reads a pattern, and an all-wildcard word names nothing', () => {
  // Literal identity is unchanged.
  assert.equal(execNameIs('git', 'git'), true);
  assert.equal(execNameIs('/usr/bin/GIT;', 'git'), true);
  assert.equal(execNameIs('node', 'git'), false);
  assert.equal(execNameIs(undefined, 'git'), false);
  // A pattern that CAN expand to the name counts as the name.
  assert.equal(execNameIs('/usr/bin/gi?', 'git'), true);
  assert.equal(execNameIs('gi*', 'git'), true);
  assert.equal(execNameIs('gi[t]', 'git'), true);
  assert.equal(execNameIs('instal?.sh', 'install.sh'), true);
  // A pattern that cannot does not.
  assert.equal(execNameIs('gi?', 'node'), false);
  assert.equal(execNameIs('*.ts', 'git'), false);
  // An all-wildcard word matches every name equally, so it names none. This is
  // the bound that keeps the read from anchoring on the `*` inside a heredoc
  // body: without it the config guard's block count over the 3815 glob-bearing
  // live commands rose from 94 to 217, 519 of the anchors being a bare `*`.
  for (const wildcard of ['*', '**', '/**', '?', '???', '[A-Za-z_$][w$]*', '[sS]*?']) {
    for (const name of ['git', 'node', 'install.sh']) {
      assert.equal(execNameIs(wildcard, name), false, `${wildcard} vs ${name}`);
    }
  }
});

// ONE translator for both readers. `isProtectedShellPattern` (config-protection)
// and the exec seam ask the same question of a word — "could this glob name X?" —
// and a private second copy is the drift shape this module has collapsed
// repeatedly. The bracket arm's fixed `[^/]` is load-bearing: a copied class body
// can throw `Range out of order`, and that SyntaxError reaches the entrypoint
// catch, which approves (AP-EXT-ITER5-01).
test('AP-EXT-ITER73-01: one glob translator, and its bracket arm stays constructible', () => {
  const shellExec = readCode(SHELL_EXEC_TS);
  const handler = readCode(CONFIG_PROTECTION_TS);
  assert.match(shellExec, /export function shellPatternToRegex\(/);
  assert.doesNotMatch(handler, /function shellPatternToRegex\(/);
  assert.match(handler, /shellPatternToRegex,/);
  // A descending range inside a bracket expression must not reach `new RegExp`.
  assert.doesNotThrow(() => execNameIs('[anatomy-park]git', 'git'));
  assert.doesNotThrow(() => execNameIs('gi[x-a]', 'git'));
});


// ---------------------------------------------------------------------------
// AP-EXT-ITER93-01: the WRAPPER is a shape, and bash expands the command word
//
// `isShellWrapper` tested `/^[a-z]*sh$/` over the raw `execName` fold, so a
// globbed spelling of the interpreter matched nothing over letters:
// `/bin/ba?h -c '<cmd>'` really execs bash (shim-verified on this box) while
// the fold `ba?h` was rejected, `shellCommandStringPayload` returned null, and
// the `-c` payload — ONE quoted token — stayed opaque to every detector at
// once. That is the AP-EXT-ITER63-06 blast radius reached through the
// AP-EXT-ITER73-01 seam: expansion is not quoting, so the fold cannot undo it
// and the TEST has to. Measured against the shipped handler: the git chain,
// the install.sh ban and both R-WSRC-3 write gates all APPROVED behind a
// globbed wrapper while their literal twins blocked.
//
// The fix asks the shape of a WITNESS — each single-position wildcard filled
// with the character the shape wants there — which is ONE uniform test rather
// than a literal arm plus a pattern arm.
// ---------------------------------------------------------------------------

test('AP-EXT-ITER93-01: a globbed shell wrapper still unwraps its -c payload', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  for (const command of [
    "/bin/ba?h -c 'git reset --hard'",
    '/bin/ba?h -c "git push origin main"',
    "/bin/b?sh -c 'git stash'",
    "/bin/zs? -c 'git rebase main'",
    "/bin/[b]ash -c 'git pull'",
    "/bin/{b,z}ash -c 'git reset --hard'",
    "/usr/bin/en? /bin/ba?h -c 'git reset --hard'",
    "PICKLE_ROLE=x /bin/ba?h -lc 'git switch main'",
    "cd sub && /bin/ba?h -c 'git reset --hard'",
    "/bin/ba?h -o pipefail -c 'git reset --hard'",
  ]) {
    const result = runHandler({
      tmpDir, stateFile, toolName: 'Bash', toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', command);
    assert.match(result.reason, /R-WSRC/);
  }
});

// The wrapper seam is shared, so the other two guards it fronts inherit the fix.
test('AP-EXT-ITER93-01: a globbed wrapper hides neither the deploy script nor a state write', () => {
  const { tmpDir, stateFile, sessionDir } = bootstrapSession();
  for (const command of [
    '/bin/ba?h install.sh',
    '/bin/zs? install.sh',
    '/bin/ba?h -c "bash install.sh"',
    `/bin/ba?h -c "echo x > ${sessionDir}/state.json"`,
    `/bin/ba?h -c "tee ${sessionDir}/state.json"`,
  ]) {
    const result = runHandler({
      tmpDir, stateFile, toolName: 'Bash', toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', command);
  }
});

// Non-tautology controls. The first three are the shapes that DOMINATE the
// live corpus (10126 unique worker Bash commands from the session logs): an
// artifact write whose heredoc body carries markdown emphasis and names the
// deploy script in prose. Reading `*` as a fillable position made `**` a
// wrapper and flipped exactly these three from approve to BLOCK — a blocked
// artifact write stalls a ticket, so the bound below is measured, not taste.
test('AP-EXT-ITER93-01: an expanded-word wrapper read does not block worker artifact writes', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  for (const command of [
    "cat > /tmp/research.md <<'EOF'\n- **PASS** — install.sh is manager-only\nEOF",
    "cat > /tmp/notes.md <<'EOF'\n**Necessary?** yes — see install.sh MANAGED_KEYS\nEOF",
    "cat > /tmp/plan.md <<'EOF'\nnote ** install.sh stays manager-only **\nEOF",
    "cat > /tmp/plan.md <<'EOF'\nsee release/** and install.sh\nEOF",
    'grep -rn "install.sh" extension/**/*.ts',
    'ls *.sh',
    'rm -rf dist/*',
    'git status',
  ]) {
    const result = runHandler({
      tmpDir, stateFile, toolName: 'Bash', toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'approve', command);
  }
});

// The predicate itself, so a detector-level regression cannot be mistaken for a
// wrapper-level one — and so the single-position bound stays measurable.
test('AP-EXT-ITER93-01: isShellWrapper reads an expanded command word, bounded to one position', () => {
  // Literal identity is unchanged: a word with no wildcards is its own witness.
  assert.equal(isShellWrapper('bash'), true);
  assert.equal(isShellWrapper('/bin/ZSH'), true);
  assert.equal(isShellWrapper('sh'), true);
  assert.equal(isShellWrapper('git'), false);
  assert.equal(isShellWrapper(undefined), false);
  assert.equal(isShellWrapper(''), false);
  // A dot or a hyphen is a literal no fill can move, which is what keeps a
  // script from folding to a wrapper.
  assert.equal(isShellWrapper('install.sh'), false);
  assert.equal(isShellWrapper('pre-install.sh'), false);
  assert.equal(isShellWrapper('instal?.sh'), false);
  // A single-position wildcard stands for the character the shape wants there,
  // wherever it sits in the word.
  assert.equal(isShellWrapper('/bin/ba?h'), true);
  assert.equal(isShellWrapper('zs?'), true);
  assert.equal(isShellWrapper('?sh'), true);
  assert.equal(isShellWrapper('[b]ash'), true);
  assert.equal(isShellWrapper('{b,z}ash'), true);
  // The bound: `*` absorbs a RUN, so it is left unfilled and fails the shape.
  assert.equal(isShellWrapper('ba*'), false);
  assert.equal(isShellWrapper('*sh'), false);
  assert.equal(isShellWrapper('**'), false);
  assert.equal(isShellWrapper('**pass**'), false);
  // A word too short to carry the shape's tail names nothing.
  assert.equal(isShellWrapper('?'), false);
});

// One word can now be BOTH readings, so the wrapper SKIP must not be able to
// hide the script from the deploy-script arm.
test('AP-EXT-ITER93-01: a word that is both wrapper-shaped and script-shaped still blocks', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  for (const command of ['./install?sh', './*sh', '*sh', './ins?all.sh', './install.sh']) {
    const result = runHandler({
      tmpDir, stateFile, toolName: 'Bash', toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', command);
  }
});

test('AP-EXT-ITER93-01: the shape has one declaration and the fill is bounded', () => {
  const source = readCode(SHELL_EXEC_TS);
  // ONE uniform test: the predicate asks the shape of the witness, with no
  // separate literal arm to drift from the pattern arm.
  const body = source.slice(
    source.indexOf('export function isShellWrapper('),
    source.indexOf('export function skipEnvAssignments('),
  );
  assert.ok(body.length > 0, 'isShellWrapper must remain a single named export');
  assert.match(body, /SHELL_INTERPRETER_NAME_RE\.test\(shellShapeWitness\(execName\(token\)\)\)/);
  // The tail is the shape's one declaration — the regex is built from it and so
  // is the fill, so the two readings cannot drift.
  assert.match(source, /const SHELL_INTERPRETER_NAME_RE = new RegExp\(`\^\[a-z\]\*\$\{SHELL_INTERPRETER_NAME_TAIL\}\$`\)/);
  // The bound lives in the fill, not in an arm of its own. AP-EXT-ITER93-07
  // extracted the fill machinery into the shared `shellWordWitness` so `sed`'s
  // in-place SHAPE could ask the same question; the bound moved WITH it, so this
  // pin follows the rule to its new home rather than scoping to the caller that
  // used to inline it (a name-scoped anchor outliving its symbol is how this
  // catalog ships green over a violated invariant).
  const witness = source.slice(
    source.indexOf('export function shellWordWitness('),
    source.indexOf('export function isShellWrapper('),
  );
  assert.match(witness, /SINGLE_POSITION_WILDCARD_RE\.test\(position\)/);
  assert.doesNotMatch(witness, /includes\('\*'\)/);
  // `shellShapeWitness` supplies only the interpreter shape's per-position fill;
  // it must not re-acquire a private positions walk, or the two witnesses can
  // once again disagree about which construct stands for one position.
  const shapeWitness = source.slice(
    source.indexOf('function shellShapeWitness('),
    source.indexOf('export function isShellWrapper('),
  );
  assert.match(shapeWitness, /return shellWordWitness\(folded, /);
  assert.doesNotMatch(shapeWitness, /SHELL_WORD_POSITION_RE/);
  // List-free: no shell NAME literals anywhere in the wrapper seam.
  assert.doesNotMatch(body + witness, /'(bash|zsh|dash|ksh|csh|tcsh|fish)'/);
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER93-02: bash expands EVERY word, so the VERB is a pattern too
//
// AP-EXT-ITER73-01/93-01 taught the command word and the wrapper word to read a
// glob as the pattern it is; the verb one word to the right stayed a literal
// `.has()` read of the gated set. Pathname expansion does not care which word it
// is: with a file named `reset` in cwd, `git rese? --hard` really hard-resets
// (shim-verified 2026-08-29 in a scratch repo — staged work destroyed, `HEAD is
// now at ...`), and the shipped handler APPROVED it for a worker while the
// byte-equivalent literal twin blocked. Nine forms measured, one per gated verb.
// ---------------------------------------------------------------------------

test('AP-EXT-ITER93-02: a globbed git VERB blocks like its literal twin', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  for (const command of [
    'git rese? --hard',
    'git res[e]t --hard',
    'git pus? origin main',
    'git stas?',
    'git rebas? -i HEAD~2',
    'git pul?',
    'git swit?h main',
    'git checkou? main',
    'git commi? --amend',
    'git fetc? --prune',
    // The globbed verb survives every carrier the module already unwraps.
    'cd sub && git rese? --hard',
    'git status && git rese? --hard',
    'bash -c "git rese? --hard"',
    'env git rese? --hard',
    // Both words globbed at once.
    '/usr/bin/gi? rese? --hard',
  ]) {
    const result = runHandler({
      tmpDir, stateFile, toolName: 'Bash', toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', command);
  }
});

// The declaration ORDER of GATED_GIT_VERBS is load-bearing, not cosmetic:
// `execNamesIn` filters in that order, so a word spelling several gated verbs at
// once must yield the unconditionally prohibited one. `????h` names `stash` and
// `fetch`; picking `fetch` (whose check needs `--prune`) would APPROVE.
test('AP-EXT-ITER93-02: a word naming several gated verbs yields the prohibited one', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile, toolName: 'Bash', toolInput: { command: 'git ????h' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block', 'git ????h names stash before fetch');
});

// Non-tautology controls. Measured on 10129 real worker Bash commands from the
// live session logs: this change moves ZERO of them, in either direction — the
// git-verb verdict is identical for all 10129 before and after.
test('AP-EXT-ITER93-02: the verb pattern read does not over-block real git usage', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  for (const command of [
    'git status',
    'git add -u',
    'git commit -m "fix"',
    'git log --oneline -5',
    'git diff HEAD~1 -- src/*.ts',
    'git add src/*.ts',
    'git checkout -- src/f.ts',
    'git fetch',
    'git show HEAD:extension/src/hooks/shell-exec.ts',
    // An all-wildcard word names every verb equally well, so it names none.
    'git ??????',
    'git *',
  ]) {
    const result = runHandler({
      tmpDir, stateFile, toolName: 'Bash', toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'approve', command);
  }
});

// The seam itself, so a detector-level regression cannot be mistaken for a
// compare-level one, and so the ordering invariant stays mechanically pinned.
test('AP-EXT-ITER93-02: the verb read is one pattern-aware set read, prohibited-first', () => {
  const source = readCode(CONFIG_PROTECTION_TS);
  const body = source.slice(
    source.indexOf('function findGitVerb('),
    source.indexOf('export function detectProhibitedGitVerb('),
  );
  assert.ok(body.length > 0, 'findGitVerb must remain a single named function');
  // ONE uniform read, shared with the write-command seam — no literal `.has()`
  // arm beside it, and no per-verb compare.
  assert.match(body, /execNamesIn\(rest\[i\], GATED_GIT_VERBS\)/);
  assert.doesNotMatch(body, /GATED_GIT_VERBS\.has\(/);
  // The prohibited verbs are spread FIRST, which is what makes `named[0]` the
  // safe reading of a multi-naming word.
  assert.match(
    source,
    /const GATED_GIT_VERBS = \[\s*\.\.\.PROHIBITED_GIT_VERBS_SIMPLE, 'checkout', 'commit', 'fetch',/,
  );
});

// AP-EXT-ITER93-05: the option VALUE is a word too, so it is a pattern too
//
// AP-EXT-ITER73-01/93-01/93-02 taught the command word, the wrapper word and the
// git VERB to read a glob as the pattern it is. The GATING FLAG one token
// further right stayed a literal `=== '--amend'` / `=== '--prune'` /
// `=== '--test'` compare, and pathname expansion does not care which word it is:
// with a file named `--amend` in cwd, `git commit --amen? -m x` really AMENDS
// (shim-verified 2026-08-29 in a scratch repo: still ONE commit, HEAD sha
// replaced, subject overwritten) while the shipped handler APPROVED the history
// rewrite for a worker and its literal twin blocked. Measured pre-fix: 6 of 6
// globbed git-flag forms and 3 of 3 globbed node-flag forms APPROVED.
// ---------------------------------------------------------------------------

test('AP-EXT-ITER93-05: a globbed git gating FLAG blocks like its literal twin', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  for (const command of [
    'git commit --amen? -m x',
    'git commit --amen[d] -m x',
    'git commit -m x --amen?',
    'git fetch --prun?',
    'git fetch --prun[e]',
    'git fetch origin --prun?',
    // The globbed flag survives every carrier the module already unwraps.
    'cd sub && git commit --amen? -m x',
    'git status && git fetch --prun?',
    'bash -c "git commit --amen? -m x"',
    'env git commit --amen? -m x',
    // Verb and flag globbed at once, the AP-EXT-ITER93-02 seam plus this one.
    'git commi? --amen? -m x',
  ]) {
    const result = runHandler({
      tmpDir, stateFile, toolName: 'Bash', toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', command);
  }
});

test('AP-EXT-ITER93-05: a globbed `node --test` flag blocks the expensive soak', () => {
  for (const command of [
    'node --tes? soak.test.js',
    'node --tes[t] soak.test.js',
    'cd extension && node --tes? soak.test.js',
    'node --TES? soak.test.js',
  ]) {
    const { tmpDir, stateFile } = bootstrapSession();
    fs.writeFileSync(path.join(tmpDir, 'soak.test.js'), '// @tier: expensive\n');
    const result = runHandler({
      tmpDir, stateFile, toolName: 'Bash', toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', command);
    assert.match(result.reason, /R-CSIS-B1/);
  }
});

// Non-tautology controls, the two real `git commit` forms the live corpus
// carries plus the plain-verb allowances this gate exists to preserve. Measured
// on 10135 real worker Bash commands from 557 live session logs: the flag
// pattern read moves ZERO of them, in either direction.
test('AP-EXT-ITER93-05: the flag pattern read does not over-block real usage', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  for (const command of [
    'git commit -m "Complete ticket 3646c20a: Worker node_modules reuse validation"',
    'git add session/3646c20a/rick_ticket_3646c20a.md && git commit -m "Mark ticket 3646c20a as Done with completion commit reference"',
    'git commit -m "fix"',
    'git commit -a -m "wip"',
    'git fetch',
    'git fetch origin',
    // A pure-wildcard word names every flag equally well, so it names none.
    'git commit -m x -- *',
    'git commit ???????',
  ]) {
    const result = runHandler({
      tmpDir, stateFile, toolName: 'Bash', toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'approve', command);
  }
});

// A real `node --test` run of a fast-tier file must still approve: the widened
// flag read must not turn every node invocation into a soak candidate.
test('AP-EXT-ITER93-05: the node flag pattern read does not over-block a fast-tier run', () => {
  for (const command of [
    'node --test tests/trap-door-conformance.test.js 2>&1 | tail -40',
    'cd extension && node --test tests/salvage-ticket-matrix.test.js 2>&1 | tail -20',
    'node --test soak.test.js.bak',
  ]) {
    const { tmpDir, stateFile } = bootstrapSession();
    fs.writeFileSync(path.join(tmpDir, 'soak.test.js'), '// @tier: expensive\n');
    const result = runHandler({
      tmpDir, stateFile, toolName: 'Bash', toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'approve', command);
  }
});

// The seam itself. Both flag families read through the ONE shared `execNameIs`,
// and the `--` of `isCheckoutRefOperation` deliberately does NOT: that arm
// returns FALSE (path-mode is ALLOWED), so widening it is the under-block
// direction — the same reason `NEGATIVE_GIT_SUBCOMMANDS` stays literal.
test('AP-EXT-ITER93-05: gating flags read through execNameIs, the FALSE arm stays literal', () => {
  const source = readCode(CONFIG_PROTECTION_TS);
  assert.match(source, /afterVerb\.some\(t => execNameIs\(t, '--amend'\)\)/);
  assert.match(source, /afterVerb\.some\(t => execNameIs\(t, '--prune'\)\)/);
  assert.match(source, /if \(execNameIs\(t, '--test'\)\) \{ foundTestFlag = true; continue; \}/);
  assert.doesNotMatch(source, /t === '--amend'/);
  assert.doesNotMatch(source, /t === '--prune'/);
  assert.doesNotMatch(source, /t === '--test'/);
  const checkout = source.slice(
    source.indexOf('function isCheckoutRefOperation('),
    source.indexOf('function findGitVerb('),
  );
  assert.ok(checkout.length > 0, 'isCheckoutRefOperation must remain a single named function');
  assert.match(checkout, /t === '--'/);
  assert.doesNotMatch(checkout, /execNameIs\(/);
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER93-06: a BRACE EXPANSION is a word, not a command group.
//
// `{` and `}` were declared segment separators for the brace GROUP form
// (`{ git reset --hard; }`, AP-EXT-ITER19-01) and the glued split honored them
// mid-word, so `git {reset,--hard}` was shredded into segments `git` and
// `reset,--hard` — the verb and every flag destroyed before any detector ran.
// Unlike every pathname-expansion sibling in this family this needs NO crafted
// filename: bash expands braces unconditionally.
// ---------------------------------------------------------------------------

const ITER93_06_BRACE_BLOCKED = [
  ['git {reset,--hard}', 'git reset --hard'],
  ['git {reset,x} --hard', 'git reset --hard'],
  ['git re{set,} --hard', 'git reset --hard'],
  ['git {r..r}eset --hard', 'git reset --hard'],
  ['git re{s..s}et --hard', 'git reset --hard'],
  ['git commit --{amend,amend} -m x', 'git commit --amend -m x'],
  ['git commit --amen{d,d} -m x', 'git commit --amend -m x'],
  ['git {push,origin} main', 'git push origin main'],
  ['git {stash,}', 'git stash'],
  ['git {pull,}', 'git pull'],
  ['git {rebase,-i} main', 'git rebase -i main'],
  ['git {checkout,main}', 'git checkout main'],
  ['git {fetch,--prune}', 'git fetch --prune'],
  ['git {switch,main}', 'git switch main'],
  ['cd extension && git {reset,--hard}', 'cd extension && git reset --hard'],
  ['git status\ngit {reset,--hard}', 'git status\ngit reset --hard'],
  ['(git {reset,--hard})', '(git reset --hard)'],
  ["bash -c 'git {reset,--hard}'", "bash -c 'git reset --hard'"],
  ["eval 'git {reset,--hard}'", "eval 'git reset --hard'"],
  ['env git {reset,--hard}', 'env git reset --hard'],
];
test('AP-EXT-ITER93-06: a braced git verb is blocked, and its literal twin still is', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  for (const [command, twin] of ITER93_06_BRACE_BLOCKED) {
    for (const form of [command, twin]) {
      const result = runHandler({
        tmpDir, stateFile, toolName: 'Bash', toolInput: { command: form },
        extraEnv: { PICKLE_ROLE: 'worker' },
      });
      assert.equal(result.decision, 'block', form);
    }
  }
});

// Non-tautology controls: the brace GROUP form (`{` as a whole word) must keep
// segmenting exactly as AP-EXT-ITER19-01 left it, or this fix would have traded
// one bypass for another.
test('AP-EXT-ITER93-06: a brace GROUP is still a segment boundary', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  for (const command of [
    '{ git reset --hard; }',
    '{ git reset --hard;}',
    '{ cd extension; git push origin main; }',
    '{\ngit stash\n}',
  ]) {
    const result = runHandler({
      tmpDir, stateFile, toolName: 'Bash', toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', `brace GROUP must still block: ${command}`);
  }
  // A glued `{` is NOT a group opener — bash rejects `{git status;}` as a
  // syntax error — so the whole word stays one word.
  assert.deepEqual(splitShellSegments('{ git status; }'), ['git status']);
  assert.deepEqual(splitShellSegments('(git status)'), ['git status']);
});

// The expansion must not fire where bash does not expand: quoting and escaping
// both make a brace literal, and a group with no comma and no range is literal.
test('AP-EXT-ITER93-06: quoted, escaped and non-expanding braces are left alone', () => {
  assert.deepEqual(splitShellSegments('git "{reset,--hard}"'), ['git "{reset,--hard}"']);
  assert.deepEqual(splitShellSegments("git '{reset,--hard}'"), ["git '{reset,--hard}'"]);
  assert.deepEqual(splitShellSegments('git \\{reset,--hard\\}'), ['git \\{reset,--hard\\}']);
  // `{a}` and `{}` are literal to bash (`echo {a}` prints `{a}`), so a word
  // carrying one must survive whole — `find . -exec rm {} \;` is the live shape.
  assert.deepEqual(splitShellSegments('echo {a}'), ['echo {a}']);
  assert.deepEqual(splitShellSegments('find . -name x -exec rm {} \\;'), ['find . -name x -exec rm {} \\;']);
});

// The expansion itself, measured against the words bash really produces
// (shim-verified via a `git` argv shim on this box, 2026-08-29).
test('AP-EXT-ITER93-06: expansion produces the words bash produces', () => {
  assert.deepEqual(splitShellSegments('git {reset,--hard}'), ['git reset --hard']);
  assert.deepEqual(splitShellSegments('git a{b,c}d'), ['git abd acd']);
  assert.deepEqual(splitShellSegments('git {reset,{--hard,x}}'), ['git reset --hard x']);
  assert.deepEqual(splitShellSegments('git {a..c}'), ['git a b c']);
  assert.deepEqual(splitShellSegments('git {1..3}'), ['git 1 2 3']);
  // An unquoted EMPTY word is dropped, exactly as bash drops it: `git {stash,}`
  // passes git exactly one argument.
  assert.deepEqual(splitShellSegments('git {stash,}'), ['git stash']);
  // A pathological word cannot spin the hook, and overflow falls back to the
  // pre-fix reading rather than to a lost block.
  const huge = `git {${Array.from({ length: 40 }, (_, i) => `a${i}`).join(',')}}`.repeat(1);
  assert.ok(splitShellSegments(huge).length >= 1);
});

// The seam: `{`/`}` stay DECLARED separators (a standalone one is still a
// boundary) but are excluded from the GLUED split, because bash recognizes them
// only as whole words. Pinning both halves keeps a future edit from collapsing
// the distinction back.
test('AP-EXT-ITER93-06: braces are declared separators but not GLUED ones', () => {
  const source = readCode(SHELL_EXEC_TS);
  assert.match(source, /op !== '\\n' && op !== '\{' && op !== '\}'/);
  assert.match(source, /'\(', '\)', '\{', '\}', '`',/);
  // AP-EXT-ITER143-01 renamed the flush seam to `expandWord` (brace expansion,
  // then parameter expansion). Both halves are pinned, so the flush-time brace
  // expansion cannot be dropped by editing either one alone.
  assert.match(source, /tokens\.push\(\.\.\.expandWord\(buffer\)\)/);
  assert.match(source, /return braced\.flatMap\(\(w\) => \[w, \.\.\.parameterExpansionWords\(w\)\]\);/);
  assert.match(source, /const braced = expandBraceWord\(word\);/);
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER93-08 — bash does not stop parsing options at `-c`
//
// `shellCommandStringPayload` returned the token immediately AFTER the first
// command-string flag. Bash sets a mode flag at `-c` and KEEPS parsing options,
// then takes the first NON-OPTION argument as the command string — so the flag's
// neighbour is the payload only when nothing follows the flag in the option run.
// A repeated or trailing option walks the single-token read one word too early:
// the hook saw `-c` / `-x` / `pipefail` and APPROVED while bash really ran the
// payload (shim-verified on this box 2026-08-29; the `-x` trace printed
// `+ git reset --hard` before executing it, and `bash -c -o pipefail "git stash"`
// really stashed).
//
// The payload is ONE quoted token, so a missed read hides the WHOLE command
// string from every detector at once — the AP-EXT-ITER63-06 blast radius,
// re-opened for the git-verb, `install.sh`, expensive-test and R-WSRC-3 write
// gates alike. Unlike the pathname-expansion siblings it needs NO crafted
// filename.
//
// The fix takes every word after the flag as a candidate, each scanned as its
// own segment. "Skip options, take the first non-option" is unwritable without
// knowing which options consume an operand — the enumerated-declaration shape
// this module refuses, and `bash -c -o pipefail "…"` proves any such list
// incomplete.
// ---------------------------------------------------------------------------

for (const { label, command, expect: expected } of [
  { label: 'repeated -c', command: 'bash -c -c "git reset --hard"', expect: /reset/ },
  { label: 'three -c', command: 'bash -c -c -c "git push origin main"', expect: /push/ },
  { label: 'trailing -x after -c', command: 'bash -c -x "git reset --hard"', expect: /reset/ },
  { label: 'combined -lc then -c', command: 'bash -lc -c "git stash"', expect: /stash/ },
  { label: 'operand-taking -o after -c', command: 'bash -c -o pipefail "git rebase main"', expect: /rebase/ },
  { label: 'sh with repeated -c', command: 'sh -c -c "git checkout other-branch"', expect: /checkout/ },
  { label: '-e after -c', command: 'bash -c -e "git commit --amend -m x"', expect: /amend/i },
  { label: 'prefixed wrapper with trailing option', command: 'env bash -c -x "git reset --hard"', expect: /reset/ },
  { label: 'absolute path wrapper', command: '/bin/bash -c -x "git push --force"', expect: /push/ },
  { label: 'chained after a cd', command: 'cd extension && bash -c -x "git reset --hard"', expect: /reset/ },
]) {
  test(`AP-EXT-ITER93-08: worker blocks prohibited git verb via ${label}`, () => {
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

// The unwrap is one shared seam, so every gate built on it inherits the widened
// read — not just the git chain that surfaced the finding.
test('AP-EXT-ITER93-08: worker blocks the deploy script behind a trailing option', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'bash -c -x "bash install.sh"' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-WSRC/);
});

test('AP-EXT-ITER93-08: worker blocks a state write behind a trailing option', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: `bash -c -x "echo {} > ${path.join(sessionDir, 'state.json')}"` },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /state file protected/i);
});

test('AP-EXT-ITER93-08: worker blocks an expensive-tier soak behind a trailing option', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const soak = path.join(tmpDir, 'soak.test.js');
  fs.writeFileSync(soak, '// @tier: expensive\n');
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: `bash -c -x "node --test ${soak}"` },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-CSIS-B1/);
});

// Non-tautology guards: reading the whole tail must not turn every wrapper
// carrying options into a block, and a wrapper with no command-string flag must
// still gain no payload.
for (const { label, command } of [
  { label: 'a benign payload behind a trailing option', command: 'bash -c -x "npm run test:fast"' },
  { label: 'a benign payload behind a repeated -c', command: 'bash -c -c "cd extension && npx tsc --noEmit"' },
  { label: 'an allowed path-mode checkout behind -x', command: 'bash -c -x "git checkout -- src/foo.ts"' },
  { label: 'a plain commit behind -x', command: 'bash -c -x "git commit -m fix"' },
  { label: 'positional arguments after the payload', command: 'bash -c "echo $0" npm test' },
  { label: 'a wrapper with options and no -c', command: 'bash -o pipefail -x scripts/run-tests.sh' },
  { label: 'a bare -c with nothing after it', command: 'bash -c' },
]) {
  test(`AP-EXT-ITER93-08: worker still approves ${label}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir, stateFile,
      toolName: 'Bash',
      toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'approve', command);
  });
}

// The seam itself: every word after the flag becomes its own segment, and the
// old single-token read is still a member — the widening is monotone, so no
// command that unwrapped before can stop unwrapping now.
test('AP-EXT-ITER93-08: the whole option-run tail is unwrapped, not just the flag neighbour', () => {
  assert.ok(splitShellSegments('bash -c -x "git reset --hard"').includes('git reset --hard'));
  assert.ok(splitShellSegments('bash -c -c "git reset --hard"').includes('git reset --hard'));
  assert.ok(splitShellSegments('bash -c -o pipefail "git stash"').includes('git stash'));
  // Monotone: the pre-fix reading is preserved, carrying segment included.
  const plain = splitShellSegments('bash -c "git reset --hard"');
  assert.ok(plain.includes('git reset --hard'));
  assert.ok(plain.includes('bash -c "git reset --hard"'));
  // A wrapper with no command-string flag still yields no payload.
  assert.deepEqual(splitShellSegments('bash install.sh'), ['bash install.sh']);
});

// AP-EXT-ITER93-03: an option FLAG is a SHAPE, and bash expands it too
//
// `SHELL_COMMAND_STRING_FLAG_RE` was tested against the RAW token, so a globbed
// spelling of `-c` matched nothing over letters. With a file named `-c` in cwd,
// `bash -? '<cmd>'` really runs the payload (shim-verified on this box:
// `bash -?`, `bash -[c]` and `bash -l?` each printed the payload's output),
// while `shellCommandStringPayloads` came back empty and the command string
// stayed ONE opaque token — the AP-EXT-ITER63-06 blast radius, hiding the whole
// payload from the git-verb chain, the install.sh ban and both R-WSRC-3 write
// gates at once. Measured against the shipped handler before the fix: all three
// forms APPROVED for a worker while their literal twins blocked.
//
// AP-EXT-ITER93-01 taught the WRAPPER to read an expanded word and
// AP-EXT-ITER93-07 extracted the fill into `shellWordWitness`; this is the last
// expansion-blind shape test on a shell word in the module, and it asks the
// same one machine rather than growing a second reader.
// ---------------------------------------------------------------------------

test('AP-EXT-ITER93-03: a globbed command-string flag still unwraps its payload', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  for (const command of [
    "bash -? 'git reset --hard'",
    "bash -[c] 'git reset --hard'",
    "bash -l? 'git push origin main'",
    "/bin/bash -{c,c} 'git stash'",
    "bash -o pipefail -? 'git rebase main'",
    "/bin/ba?h -? 'git pull'",
  ]) {
    const result = runHandler({
      tmpDir, stateFile, toolName: 'Bash', toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', command);
    assert.match(result.reason, /R-WSRC/);
  }
});

// The flag seam is shared, so the other two guards behind it inherit the fix.
test('AP-EXT-ITER93-03: a globbed flag hides neither the deploy script nor a state write', () => {
  const { tmpDir, stateFile, sessionDir } = bootstrapSession();
  for (const command of [
    'bash -? "bash install.sh"',
    'bash -[c] "bash install.sh"',
    `bash -? "echo x > ${sessionDir}/state.json"`,
    `bash -l? "tee ${sessionDir}/state.json"`,
  ]) {
    const result = runHandler({
      tmpDir, stateFile, toolName: 'Bash', toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'block', command);
  }
});

// Non-tautology controls. Reading a flag shape off a witness widens what counts
// as a payload carrier, and the widening's whole cost must land on commands a
// worker really runs. Measured across 9167 unique worker Bash commands from 163
// live session logs: 35 word-level predicate flips over 330875 words, 4 commands
// whose SEGMENT SET changed — every one of them a prior anatomy-park pass's own
// measurement script — and ZERO handler decision flips in either direction.
test('AP-EXT-ITER93-03: an expanded flag read does not block ordinary worker commands', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  for (const command of [
    // The corpus's real flipped words: an xargs replace-string, an awk field
    // separator and a bracket-bearing option value are option SHAPES that fill
    // to `-c`, and none of them stands behind a shell wrapper.
    'find . -name "*.ts" | xargs -I{} echo {}',
    'awk -F[ ,+] \'{print $1}\' notes.txt',
    "cat > /tmp/research.md <<'EOF'\n- **PASS** — install.sh is manager-only\nEOF",
    'grep -rn "install.sh" extension/**/*.ts',
    'bash -c "npm test"',
    'git status',
  ]) {
    const result = runHandler({
      tmpDir, stateFile, toolName: 'Bash', toolInput: { command },
      extraEnv: { PICKLE_ROLE: 'worker' },
    });
    assert.equal(result.decision, 'approve', command);
  }
});

// The seam itself, so a detector-level regression cannot be mistaken for a
// flag-level one — and so the single-position bound stays measurable here too.
test('AP-EXT-ITER93-03: the command-string flag is read as a shape, bounded to one position', () => {
  const PAYLOAD = 'git reset --hard';
  // Literal identity is unchanged: a word with no wildcards is its own witness.
  assert.ok(splitShellSegments(`bash -c '${PAYLOAD}'`).includes(PAYLOAD));
  assert.ok(splitShellSegments(`bash -lc '${PAYLOAD}'`).includes(PAYLOAD));
  // A single-position wildcard stands for the flag character wherever it sits.
  assert.ok(splitShellSegments(`bash -? '${PAYLOAD}'`).includes(PAYLOAD));
  assert.ok(splitShellSegments(`bash -[c] '${PAYLOAD}'`).includes(PAYLOAD));
  assert.ok(splitShellSegments(`bash -l? '${PAYLOAD}'`).includes(PAYLOAD));
  assert.ok(splitShellSegments(`bash -?c '${PAYLOAD}'`).includes(PAYLOAD));
  // The bound: `*` absorbs a RUN, so it is left unfilled and fails the shape.
  assert.deepEqual(splitShellSegments(`bash -* '${PAYLOAD}'`), [`bash -* '${PAYLOAD}'`]);
  // The leading `-` is a literal no fill can move, which is what keeps a
  // wildcard-bearing positional FILE argument from reading as the flag.
  assert.deepEqual(splitShellSegments(`bash ?? '${PAYLOAD}'`), [`bash ?? '${PAYLOAD}'`]);
  // A word that is not an option at all is still not the flag.
  assert.deepEqual(splitShellSegments('bash script.sh'), ['bash script.sh']);
});

test('AP-EXT-ITER93-03: the flag shape has one declaration and asks the shared witness', () => {
  const source = readCode(SHELL_EXEC_TS);
  // ONE declaration: the regex is BUILT from the character the witness fills
  // with, so the shape and the fill cannot drift into disagreeing.
  assert.match(
    source,
    /const SHELL_COMMAND_STRING_FLAG_RE = new RegExp\(`\^-\[A-Za-z\]\*\$\{SHELL_COMMAND_STRING_FLAG_CHAR\}`\)/,
  );
  // The predicate asks the SHARED fill machine, not a private positions walk —
  // two position-splitters could disagree about `*` and only one is measured.
  const body = source.slice(
    source.indexOf('function isShellCommandStringFlag('),
    source.indexOf('\n}', source.indexOf('function isShellCommandStringFlag(')),
  );
  assert.ok(body.length > 0, 'isShellCommandStringFlag must remain a single named function');
  assert.match(body, /shellWordWitness\(/);
  assert.doesNotMatch(body, /SHELL_WORD_POSITION_RE/);
  assert.doesNotMatch(body, /SINGLE_POSITION_WILDCARD_RE/);
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER110-01 — the seam's audit events must be REGISTERED event names.
//
// Pre-fix the emitter built the name (`worker_git_${verb}_${suffix}`) and cast it
// through `as unknown as ActivityEventType`, so all 18 names it can spell were
// absent from VALID_ACTIVITY_EVENTS. Measured on the host ledger: 9 distinct
// `worker_git_*_blocked` names live, ZERO registered — every registry consumer
// therefore read a real event as a fabrication.
// ---------------------------------------------------------------------------

test('AP-EXT-ITER110-01: the event a blocked git verb actually emits is in VALID_ACTIVITY_EVENTS', async () => {
  const { VALID_ACTIVITY_EVENTS } = await import('../../types/index.js');
  const { tmpDir, stateFile, dataRoot } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git reset --hard HEAD~1' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');

  const emitted = readActivityEvents(dataRoot).filter(e => String(e.event).startsWith('worker_git_'));
  assert.equal(emitted.length, 1, 'the blocked verb must leave exactly one audit event');
  assert.equal(emitted[0].event, 'worker_git_reset_blocked');
  assert.ok(
    VALID_ACTIVITY_EVENTS.includes(emitted[0].event),
    `emitted event ${emitted[0].event} must be registered in VALID_ACTIVITY_EVENTS`,
  );
});

test('AP-EXT-ITER110-01: the bypass arm emits a registered name too', async () => {
  const { VALID_ACTIVITY_EVENTS } = await import('../../types/index.js');
  const { tmpDir, stateFile, dataRoot } = bootstrapSession({
    flags: { allow_git_commit_amend_reason: 'operator closer step' },
  });
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git commit --amend -m x' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');

  const emitted = readActivityEvents(dataRoot).filter(e => String(e.event).startsWith('worker_git_'));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'worker_git_commit__amend_bypass');
  assert.ok(VALID_ACTIVITY_EVENTS.includes(emitted[0].event));
});

test('AP-EXT-ITER110-01: EVERY name the gate can emit is registered (no per-verb list here)', async () => {
  const { VALID_ACTIVITY_EVENTS } = await import('../../types/index.js');
  const { gitVerbGateEventNames } = await import('../../hooks/handlers/config-protection.js');
  const names = gitVerbGateEventNames();
  // Derived from the gate itself, so a 10th verb is covered without touching this test.
  assert.ok(names.length >= 18, `expected the 9 gated verbs x 2 suffixes, got ${names.length}`);
  const unregistered = names.filter(n => !VALID_ACTIVITY_EVENTS.includes(n));
  assert.deepEqual(unregistered, [], `unregistered gate events: ${unregistered.join(', ')}`);
});

test('AP-EXT-ITER110-01: a PRD citing a real gate event is no longer audited as a phantom', async () => {
  const { gitVerbGateEventNames } = await import('../../hooks/handlers/config-protection.js');
  const { evaluateSymbolAudit } = await import('../../bin/spawn-refinement-team.js');
  const prd = [
    '# PRD',
    '',
    '## Acceptance Criteria',
    '',
    ...gitVerbGateEventNames().map((n, i) => `- AC-${i}: the hook emits \`${n}\` as an activity event.`),
    '',
  ].join('\n');
  const audit = evaluateSymbolAudit(prd, process.cwd(), { tickets: [] });
  const phantoms = audit.activityEvents.filter(ref => ref.status === 'phantom');
  assert.deepEqual(
    phantoms.map(p => p.symbol),
    [],
    'the refinement symbol audit must not report a live gate event as a fabricated citation',
  );
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER143-01 — a PARAMETER EXPANSION writes its word in plain sight
//
// `${x:-git}` is not `$VAR` indirection: bash substitutes a word that is
// WRITTEN IN THE COMMAND, so it is recoverable by a grammar read exactly as a
// brace expansion is (AP-EXT-ITER93-06), and it needs no assignment, no
// environment and no crafted filename. The grammar declared no parameter part,
// so the fold produced `${x:-git}` — matching no detector — and the bypass hit
// every R-WSRC gate at once, the AP-EXT-ITER63-06 blast radius:
//
//   `${x:-git} reset --hard`        APPROVED (R-WSRC-GR)
//   `${x:-git} push origin main`    APPROVED (R-WSRC-GR)
//   `git ${x:-reset} --hard`        APPROVED (R-WSRC-GR, verb position)
//   `${x:-bash} install.sh`         APPROVED (R-WSRC install.sh ban)
//   `bash ${x:-install.sh}`         APPROVED (R-WSRC install.sh ban)
//   `${x:-tee} <session>/state.json` APPROVED (R-WSRC-3 state write)
//   `${x:-sed} -i "" s/a/b/ pickle_settings.json` APPROVED (R-WSRC-3 settings)
//
// All shim-verified on this box (2026-09-01) to really exec, and all measured
// APPROVE against the shipped mirror before the fix while every literal twin
// blocked. Cost measured over 10516 unique real worker Bash commands from 204
// prior-session logs: ZERO verdict flips in either direction on the git-verb
// gate, and ZERO across all four gates on the 486 commands whose segmentation
// reshaped. 84.7 -> 85.7 microseconds per command.
// ---------------------------------------------------------------------------

test('AP-EXT-ITER143-01: a parameter-expanded git verb is blocked, and its literal twin still is', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const run = (command) => runHandler({
    tmpDir, stateFile, toolName: 'Bash', toolInput: { command },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  // The exec word, the verb word, and the flag word — all three positions.
  for (const command of [
    '${x:-git} reset --hard',
    '${x-git} reset --hard',
    '${x:=git} reset --hard',
    '${x:+git} reset --hard',
    'git ${x:-reset} --hard',
    'git ${x:-push} origin main',
    '${x:-git} stash',
    '/usr/bin/${x:-git} rebase -i',
    'git commit ${x:---amend} -m x',
  ]) {
    const result = run(command);
    assert.equal(result.decision, 'block', `must block: ${command}`);
    assert.match(result.reason, /R-WSRC-GR/);
  }
  // Non-tautology: the literal twins still block, and a benign parameter
  // expansion still approves — the fix must not have made everything a block.
  assert.equal(run('git reset --hard').decision, 'block');
  assert.equal(run('git status --short').decision, 'approve');
  assert.equal(run('echo "${HOME}/bin"').decision, 'approve');
  assert.equal(run('cd ${DIR:-extension} && npm test').decision, 'approve');
});

test('AP-EXT-ITER143-01: the install.sh ban and both write gates see the substituted word', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const run = (command) => runHandler({
    tmpDir, stateFile, toolName: 'Bash', toolInput: { command },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.match(run('${x:-bash} install.sh').reason ?? '', /R-WSRC/);
  assert.equal(run('${x:-bash} install.sh').decision, 'block');
  assert.equal(run('bash ${x:-install.sh}').decision, 'block');
  assert.equal(run('${x:-tee} /tmp/pickle-test/state.json').decision, 'block');
  assert.equal(run('${x:-sed} -i "" s/a/b/ pickle_settings.json').decision, 'block');
});

test('AP-EXT-ITER143-01: expansion offers the word bash substitutes, and keeps the original', () => {
  // The candidates are extra TOKENS in the same segment — every detector reads
  // its anchor position-free — and the ORIGINAL word is always kept, so the
  // expansion is a strict widening and cannot lose a pre-fix block.
  // The trailing `reset` is the AP-EXT-ITER187-01 empty-expansion twin: a
  // word-carrying body is read as empty too, because telling the forms that
  // can be empty from the one that cannot means naming bash's operators.
  assert.deepEqual(splitShellSegments('${x:-git} reset'), ['${x:-git} x:-git -git git reset', 'reset']);
  // A body of pure name characters carries no substitutable word beyond itself;
  // the bare `echo` is the AP-EXT-ITER187-01 reading in which `${HOME}` — which
  // really can be empty — contributes nothing.
  assert.deepEqual(splitShellSegments('echo ${HOME}'), ['echo ${HOME} HOME', 'echo']);
  // No `${` at all: byte-identical to the pre-fix reading.
  assert.deepEqual(splitShellSegments('git status && ls'), ['git status', 'ls']);
  assert.deepEqual(splitShellSegments('git {reset,--hard}'), ['git reset --hard']);
  // Nested and unterminated bodies still surface the literal word.
  assert.ok(splitShellSegments('${a:-${b:-git}} reset')[0].split(' ').includes('git'));
  assert.ok(splitShellSegments('${x:-git reset --hard')[0].split(' ').includes('git'));
});

test('AP-EXT-ITER143-01: the expansion budget is spent in CHARACTERS, so a padded word cannot spin the hook', () => {
  // A candidate is nearly as long as the body it comes from, so a per-candidate
  // cap is quadratic in the word: the character budget is what keeps the
  // emitted text linear. Measured before the budget: a 20 KB punctuation body
  // cost 3035 ms against the pre-fix 9 ms, and a 40 KB one drove
  // `shellPatternToRegex` past the engine's regex-size limit, whose SyntaxError
  // unwinds into dispatch's catch and APPROVES the whole command.
  const padded = `\${${'x:'.repeat(10000)}}`;
  const started = Date.now();
  const segments = splitShellSegments(padded);
  const elapsed = Date.now() - started;
  assert.ok(segments.length >= 1);
  assert.ok(elapsed < 1000, `padded parameter body must stay cheap, took ${elapsed}ms`);
  // Overflow falls back to the surviving candidates; nothing is ever REMOVED,
  // so an overflow cannot lose a block a non-expanding scanner already had.
  assert.ok(segments[0].startsWith(padded));
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER187-01 — an expansion GLUED to a literal hid the literal
//
// `$(true)`, `` `true` ``, `$UNSET` and `${UNSET}` all expand to NOTHING, so
// `git reset$(true) --hard` is the command `git reset --hard` — shim-verified in
// a scratch repo, the staged file was really destroyed. The shipped handler
// APPROVED 36 of 36 glued forms across all six PROHIBITED_GIT_VERBS_SIMPLE
// verbs (plus `--amend` / `--prune`) while every bare twin blocked.
//
// Two routes, one cause: `$(` and a backtick are SEGMENT SEPARATORS, so the
// split ran through the middle of the word and left `reset$` (or an orphan
// `set`) behind; `$NAME` is no separator at all and simply stayed glued.
// ---------------------------------------------------------------------------

test('AP-EXT-ITER187-01: an expansion glued to a git verb blocks like its literal twin', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const run = (command) => runHandler({
    tmpDir, stateFile, toolName: 'Bash', toolInput: { command },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  const tails = {
    reset: ' --hard', switch: ' main', stash: '', rebase: ' -i main', pull: '', push: ' origin main',
  };
  // Every prohibited verb x every glue position x every empty-expansion form.
  // Derived, not enumerated: the verb list is the gate's own, so a verb added
  // to the Git Boundary Rules is covered here the day it lands.
  for (const verb of ['reset', 'switch', 'stash', 'rebase', 'pull', 'push']) {
    for (const glue of [
      (v) => `${v}$(true)`,
      (v) => `$(true)${v}`,
      (v) => `${v.slice(0, 2)}$(true)${v.slice(2)}`,
      (v) => `${v.slice(0, 2)}\`true\`${v.slice(2)}`,
      (v) => `${v}$EMPTY`,
      (v) => `${v}\${EMPTY}`,
      (v) => `${v.slice(0, 2)}$(echo $(true))${v.slice(2)}`,
    ]) {
      const command = `git ${glue(verb)}${tails[verb]}`;
      const result = run(command);
      assert.equal(result.decision, 'block', `must block: ${command}`);
      assert.match(result.reason, /R-WSRC-GR/);
    }
  }
  // The two gating FLAGS are the same word question one position to the right.
  assert.equal(run('git commit --amend$(true) -m x').decision, 'block');
  assert.equal(run('git $(true)commit --amend -m x').decision, 'block');
  assert.equal(run('git fetch --prune`true`').decision, 'block');
  // A command string re-parsed as code is elided one level down, quoted or not.
  assert.equal(run('bash -c "git re$(true)set --hard"').decision, 'block');
  assert.equal(run("bash -c 'git re$(true)set --hard'").decision, 'block');
  assert.equal(run('eval "git reset$(true) --hard"').decision, 'block');
  // Same reading, so the sibling gates that share `splitShellSegments` see the
  // glued word too — the elision is taken once, before any detector runs.
  assert.equal(run('bash install$(true).sh').decision, 'block');
  assert.equal(run('bas`x`h install.sh').decision, 'block');
  assert.equal(run('tee$(true) /tmp/pickle-test/state.json').decision, 'block');
  assert.equal(run('sed -i$EMPTY "" s/a/b/ pickle_settings.json').decision, 'block');
});

test('AP-EXT-ITER187-01: the empty-expansion reading does not over-block real worker commands', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const run = (command) => runHandler({
    tmpDir, stateFile, toolName: 'Bash', toolInput: { command },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  // Non-tautology: the literal twins still block AND ordinary commands that
  // carry expansions still approve — a fix that blocked everything would pass
  // the test above and fail here.
  assert.equal(run('git reset --hard').decision, 'block');
  for (const command of [
    'git status --short',
    'git add -u',
    'git commit -m "$(cat msg.txt)"',
    'git log --oneline -n $COUNT',
    'echo "${HOME}/bin"',
    'cd ${DIR:-extension} && npm test',
    'git diff --cached > /tmp/$$.patch',
    // A `$` naming nothing is a LITERAL dollar to bash — `git rese$ t --hard`
    // really runs the subcommand `rese$`. Whitespace is the only character
    // whose removal could JOIN two words into a gated verb, so the elision
    // refuses it; without that refusal this line blocks.
    'git rese$ t --hard',
    'git reset$ --hard',
    'echo cost $ 5',
  ]) {
    assert.equal(run(command).decision, 'approve', `must approve: ${command}`);
  }
});

test('AP-EXT-ITER187-01: elision is additive, quote-faithful and cheap', () => {
  // ADDITIVE: the un-elided segments are still there, so no command that
  // blocked before this reading existed can stop blocking now.
  assert.deepEqual(
    splitShellSegments('git reset$(true) --hard'),
    ['git reset$', 'true', '--hard', 'git reset --hard'],
  );
  assert.deepEqual(
    splitShellSegments('git re$(true)set --hard'),
    ['git re$', 'true', 'set --hard', 'git reset --hard'],
  );
  assert.deepEqual(
    splitShellSegments('git reset$EMPTY --hard'),
    ['git reset$EMPTY --hard', 'git reset --hard'],
  );
  // No expansion at all: byte-identical to the pre-fix reading, no extra pass.
  assert.deepEqual(splitShellSegments('git status && ls'), ['git status', 'ls']);
  // QUOTE-FAITHFUL: bash expands nothing inside single quotes and nothing after
  // a backslash, so neither yields a second reading — this never manufactures a
  // command bash cannot produce. `$'…'` is ANSI-C QUOTING, not an expansion, so
  // consuming its opening quote (and unbalancing the rest) is refused too.
  for (const command of ["echo 'a $(b) c'", 'echo \\$HOME', "git $'\\x72eset' --hard", 'git rese$ t --hard']) {
    assert.deepEqual(splitShellSegments(command), [command], `no second reading: ${command}`);
  }
  // A special parameter takes exactly the one character that names it — no
  // table of `$?`/`$@`/`$*`/`$$`/`$!`/`$-`, which is the enumerated-set shape.
  assert.deepEqual(splitShellSegments('echo $?'), ['echo $?', 'echo']);
  // CHEAP: elision is one linear pass and its output carries no `$` and no
  // backtick, so the recursion terminates after exactly one step.
  const started = Date.now();
  const segments = splitShellSegments(`git ${'$(x)'.repeat(20000)}reset --hard`);
  const elapsed = Date.now() - started;
  assert.ok(segments.includes('git reset --hard'));
  assert.ok(elapsed < 2000, `pathological expansion run must stay cheap, took ${elapsed}ms`);
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER188-01 — a LITERAL apostrophe switched the ITER187-01 reading off
//
// `elideExpansions` shipped with its OWN quote reader that knew `'` and `\` and
// not `"`. Inside `"…"` a `'` is an ordinary literal to bash — the apostrophe in
// `git commit -m "don't"` — but that reader took it as a span opener and copied
// verbatim to the next `'`, or, when there is none, to the END of the command.
// `elided === command` then held and the second reading was never taken.
//
// Measured against the shipped handler: 8 of 9 gates re-opened behind ONE
// apostrophe, and the R-WACT commit classification with them. Not adversarial —
// 4549 of 13073 real worker commands carry a literal apostrophe inside `"…"`,
// and 311 of the 4681 expansion-carrying ones had their elision suppressed.
// ---------------------------------------------------------------------------

test('AP-EXT-ITER188-01: a literal apostrophe does not switch the elision off', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const run = (command) => runHandler({
    tmpDir, stateFile, toolName: 'Bash', toolInput: { command },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  // Each prefix puts a `'` bash reads as a LITERAL in front of the glued verb.
  // The third has NO closing apostrophe at all, which is what let the private
  // reader swallow the whole rest of the command.
  const prefixes = [
    'git commit -m "don\'t" && ',
    'echo "worker\'s log" && ',
    'echo "unclosed \' quote" && ',
    'echo "a\'b" | cat && ',
  ];
  for (const prefix of prefixes) {
    for (const glued of [
      'git reset$(true) --hard',
      'git re$(true)set --hard',
      'git reset$EMPTY --hard',
      'git push${EMPTY} origin main',
      'git re$(echo $(true))set --hard',
      'git commit$(true) --amend -m x',
    ]) {
      const result = run(prefix + glued);
      assert.equal(result.decision, 'block', `must block: ${prefix + glued}`);
    }
    // The sibling gates share the same reading, so they recover together.
    assert.equal(run(`${prefix}bash install$(true).sh`).decision, 'block');
    assert.equal(run(`${prefix}tee$(true) /tmp/pickle-test/state.json`).decision, 'block');
  }
});

test('AP-EXT-ITER188-01: bash expands inside "…" and not inside \'…\'', () => {
  // A DOUBLE-quoted span is consumed whole — so a `'` inside it is a literal and
  // opens nothing — and its contents are still elided, because bash expands
  // there. Both halves in one assertion: the apostrophe survives, the expansion
  // does not.
  // The `(` is inside quotes, so it is no separator: one segment each reading.
  assert.deepEqual(
    splitShellSegments('echo "don\'t $(x) stop"'),
    ['echo "don\'t $(x) stop"', 'echo "don\'t  stop"'],
  );
  // A real single-quoted span still suppresses elision, and so does a backslash
  // escape and an ANSI-C span — this is what stops the reading manufacturing a
  // command bash cannot produce. Regression direction: a fix that simply
  // deleted the private single-quote arm would red every line here.
  for (const command of [
    "echo 'a $(b) c'",
    'echo \\$HOME',
    "git $'\\x72eset' --hard",
    "echo 'don\\'\\''t $(x)'",
  ]) {
    assert.deepEqual(splitShellSegments(command), [command], `no second reading: ${command}`);
  }
  // An expansion may SPAN whitespace, so the walk cannot be per-word: cutting
  // `$(echo $(true))` at the blank leaves an unbalanced `$(echo` that elides to
  // end-of-part and destroys the verb (measured — this exact shape reddened the
  // ITER187-01 matrix during the fix).
  assert.ok(splitShellSegments('git re$(echo $(true))set --hard').includes('git reset --hard'));
  assert.ok(splitShellSegments('git reset$(a "b c")  --hard').includes('git reset --hard'));
});

test('AP-EXT-ITER188-01: one grammar feeds every reader of bash\'s quoting forms', () => {
  const code = readCode(SHELL_EXEC_TS);
  // The two elision readers are BUILT from the same declared span constants as
  // WORD_PART_SOURCE, so a fifth quoting form cannot be declared in one reader
  // and missed by the other — the private-copy drift ITER12-01 and ITER66-01
  // each collapsed. Pinning the DERIVATION, not a spelling of the forms.
  const literal = code.match(/const LITERAL_PART_RE = new RegExp\(\s*`([^`]*)`,\s*'y',?\s*\)/);
  assert.ok(literal, 'LITERAL_PART_RE must stay one derived RegExp');
  assert.deepEqual(
    literal[1].match(/\$\{[A-Z_]+\}/g),
    ['${UNQUOTED_ESCAPE}', '${ANSI_C_QUOTED_SPAN}', '${SINGLE_QUOTED_SPAN}'],
  );
  const expanding = code.match(/const EXPANDING_QUOTED_SPAN_RE = new RegExp\(\s*`([^`]*)`,\s*'y',?\s*\)/);
  assert.ok(expanding, 'EXPANDING_QUOTED_SPAN_RE must stay one derived RegExp');
  assert.deepEqual(
    expanding[1].match(/\$\{[A-Z_]+\}/g),
    ['${LOCALE_QUOTED_SPAN}', '${DOUBLE_QUOTED_SPAN}'],
  );
  // Together they must name every span WORD_PART_SOURCE does, so no form is
  // declared in the grammar and unreachable from the elision walk.
  const grammar = code.match(/const WORD_PART_SOURCE =\s*([\s\S]*?);\n/);
  assert.ok(grammar, 'WORD_PART_SOURCE must stay one declaration');
  const named = new Set([...literal[1].match(/\$\{[A-Z_]+\}/g), ...expanding[1].match(/\$\{[A-Z_]+\}/g)]);
  for (const form of grammar[1].match(/\$\{[A-Z_]+\}/g)) {
    if (form === '${UNQUOTED_RUN}') continue; // not a span: the ordinary run
    assert.ok(named.has(form), `${form} is declared in the grammar but no elision reader consumes it`);
  }
  // And the private reader is GONE: elideExpansions must not test a quote
  // character itself, which is the shape that made `'` a phantom span opener.
  const walk = code.slice(code.indexOf('function elideExpansions('), code.indexOf('function elideExpansionsInText('));
  assert.equal(walk.match(/'\\\\''|=== *'\\''/g), null, 'elideExpansions must not re-read quotes itself');
  assert.ok(walk.includes('LITERAL_PART_RE') && walk.includes('EXPANDING_QUOTED_SPAN_RE'));
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER180-01 — every source-text pin in this file read RAW BYTES
//
// Nineteen read sites, and each one asked a question about CODE of a string
// that still held every comment. MEASURED on the shipped tree, both directions,
// against the AP-EXT-ITER54-02 shape pin: the `break` it exists to forbid read
// GREEN (555 pass / 0 fail) behind ONE comment naming the slice's end
// delimiter, and a CORRECT file read RED behind ONE documentation comment
// quoting `'--test-concurrency'`. A pin answerable by prose is not a pin.
//
// The fix is not "add a reader" — a correct reader nobody is obliged to use
// guarantees nothing (AP-EXT-ITER178-01). It is `readCode`, the ONE masked
// reader, plus `docCommentOf` for the one question that is genuinely ABOUT a
// comment, plus the anchor below that forbids reaching past either.
// ---------------------------------------------------------------------------

test('AP-EXT-ITER180-01 codeMask blanks comments by grammar, and moves nothing', () => {
  // Regress codeMask in EITHER direction and this reds: under-blank hides a
  // violation from the pins above, over-blank lets this file's own trap-door
  // prose answer them.
  for (const [name, source, mustBeVisible] of [
    ['line marker inside a string', "const u = 'https://x.dev'; const bad = t.quoted;", true],
    ['block opener inside a string', "const u = '/* not a comment'; const bad = t.quoted;", true],
    ['block opener inside a regex literal', 'const re = /[/*]/; const bad = t.quoted;', true],
    ['marker inside a template', 'const s = `see // here`; const bad = t.quoted;', true],
    ['a REAL line comment', '// never read t.quoted here', false],
    ['a REAL block comment', '/* never read t.quoted here */', false],
    ['a REAL JSDoc block', '/** never read t.quoted here */', false],
  ]) {
    const masked = codeMask(source, 'probe.ts');
    assert.equal(
      masked.includes('t.quoted'), mustBeVisible,
      `${name}: expected ${mustBeVisible ? 'VISIBLE' : 'BLANKED'} in ${JSON.stringify(masked)}`,
    );
    assert.equal(masked.length, source.length, `${name}: codeMask must not move a character`);
  }
  // Position-preserving is load-bearing: every `source.indexOf('function …')`
  // delimiter above takes an offset from the masked text and slices the same
  // text, so a shifted index silently re-cuts every span. An astral character
  // is two UTF-16 code units but one code point, so a code-POINT walk moves the
  // newline and everything after it.
  const astral = "const e = '\u{1F600}'; // c\nconst bad = t.quoted;";
  assert.equal(
    codeMask(astral, 'probe.ts'),
    "const e = '\u{1F600}';     \nconst bad = t.quoted;",
    'must index by UTF-16 code unit',
  );
});

/**
 * The routing half, and the half a reader test cannot cover: `readCode` being
 * correct says nothing about whether the next pin USES it. Read as grammar, not
 * as a grep — the offender is a `readFileSync` whose path argument names a repo
 * source file, and only its position relative to the two named readers decides.
 *
 * Two readers, because there are two kinds of question. `readCode` answers
 * questions about CODE and blanks every comment; `docCommentOf` answers the one
 * question about DOCUMENTATION and can return nothing BUT a JSDoc span, so it
 * is structurally incapable of becoming the escape hatch a third raw read would
 * be. Anything else reading a repo source is reaching past both.
 *
 * Honest limit: a read whose argument is a VARIABLE (the ITER63-02 hooks-tree
 * walk holds one) is invisible to the first clause, because a name says nothing
 * about what it holds. The second clause is what covers that direction — such a
 * read can only route around `readCode` while still looking masked by forking a
 * second `codeMask` call site, and there is exactly one place such a call may
 * live. Positional, not a count: a hand-kept caller count admits the N+1th
 * caller by construction.
 */
test('AP-EXT-ITER180-01 no pin reads a source file outside the declared readers', () => {
  const selfPath = fileURLToPath(import.meta.url);
  const selfSource = readSelf();
  const self = ts.createSourceFile(selfPath, selfSource, ts.ScriptTarget.Latest, true);
  const spanOf = (name) => {
    let span = null;
    const find = (node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
        span = { start: node.getStart(self), end: node.getEnd() };
      }
      ts.forEachChild(node, find);
    };
    find(self);
    assert.ok(span, `${name} must remain a single named function`);
    return span;
  };
  // The declared readers. Every `readFileSync` in this file must sit inside one
  // of them, so the rule needs no test of what the path ARGUMENT looks like.
  // The two name/text tests this replaces asked whether the argument read `_TS`
  // or `__dirname`, and so could only see a path written literally at the read
  // site: `full` in the hooks-tree walk is built at runtime
  // (`hooksSrc` -> `walk(dir)` -> `path.join(dir, entry.name)`) and matched
  // neither. Measured (AP-EXT-ITER181-01): raw bytes there read GREEN while a
  // `_TS` control RED, and one comment naming the forbidden symbol then falsely
  // REDDENED AP-EXT-ITER63-02. Membership of a span cannot be spelled around.
  //
  // `spanOf` throws on a missing name, so deleting a reader reds this rather
  // than quietly shrinking the set it checks.
  const readerSpans = ['readCode', 'docCommentOf', 'readActivityEvents', 'readSelf'].map(spanOf);
  const inAReader = (node) => readerSpans.some(
    (s) => node.getStart(self) >= s.start && node.getEnd() <= s.end,
  );
  const lineOf = (node) => self.getLineAndCharacterOfPosition(node.getStart(self)).line + 1;

  const rawSourceReads = [];
  const maskCallers = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(self);
      if (callee.endsWith('readFileSync') && !inAReader(node)) {
        const target = node.arguments[0]?.getText(self) ?? '';
        rawSourceReads.push(`${lineOf(node)}: readFileSync(${target})`);
      }
      if (callee === 'codeMask' && !inAReader(node)) maskCallers.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(self);

  assert.deepEqual(
    rawSourceReads, [],
    'every readFileSync must sit inside a declared reader (readCode, docCommentOf, readActivityEvents, readSelf)',
  );
  // Second clause, and the one that covers a read the first cannot see: the
  // only other place allowed to call `codeMask` is its own anchor test, which
  // feeds it hand-built probe strings and never a file.
  const anchorSpan = (() => {
    let span = null;
    self.forEachChild((node) => {
      // The test's own TITLE, not its text: a node's text includes its
      // comments, so matching the phrase anywhere would let a comment in some
      // other test claim to be the anchor and empty this clause out.
      if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return;
      const [title] = node.expression.arguments;
      if (!title || !ts.isStringLiteral(title)) return;
      if (title.text.includes('codeMask blanks comments by grammar')) {
        span = { start: node.getStart(self), end: node.getEnd() };
      }
    });
    assert.ok(span, 'the codeMask anchor test must remain in this file');
    return span;
  })();
  const strayMaskCallers = maskCallers
    .filter((node) => node.getStart(self) < anchorSpan.start || node.getEnd() > anchorSpan.end)
    .map((node) => `${lineOf(node)}: ${node.getText(self).split('\n')[0]}`);
  assert.deepEqual(
    strayMaskCallers, [],
    'codeMask has exactly two callers: readCode, and the anchor test that proves it',
  );
  assert.ok(maskCallers.length > 0, 'the anchor test must still exercise codeMask');
});

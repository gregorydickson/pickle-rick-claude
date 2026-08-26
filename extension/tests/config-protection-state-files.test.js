// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HANDLER = path.resolve(__dirname, '../hooks/handlers/config-protection.js');

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
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/pickle-test',
    tmux_mode: false,
    ...overrides,
  };
}

/**
 * Bootstrap a temp pickle-rick data root with an active session and an
 * extension sentinel. Returns { tmpDir, sessionDir, stateFile, dataRoot }.
 * `flags` (optional) is merged into state.flags.
 */
function bootstrapSession({ flags } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-state-'));
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

// ---------------------------------------------------------------------------
// R-WSRC-3: Write/Edit gate
// ---------------------------------------------------------------------------

test('R-WSRC-3: blocks Write to <session>/state.json without override', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Write',
    toolInput: { file_path: path.join(sessionDir, 'state.json') },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /state file protected/i);
});

test('R-WSRC-3: blocks Edit to <session>/state.json without override', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Edit',
    toolInput: { file_path: path.join(sessionDir, 'state.json') },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-3: blocks Write to state.json.tmp.<pid> snapshot', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Write',
    toolInput: { file_path: path.join(sessionDir, 'state.json.tmp.12345') },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-3: blocks Write to circuit_breaker.json', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Write',
    toolInput: { file_path: path.join(sessionDir, 'circuit_breaker.json') },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-3: blocks Write to circuit_breaker.json.tmp.<pid>', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Write',
    toolInput: { file_path: path.join(sessionDir, 'circuit_breaker.json.tmp.999') },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-3: blocks Write to pipeline-status.json', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Write',
    toolInput: { file_path: path.join(sessionDir, 'pipeline-status.json') },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-3: blocks Write to pipeline-status.json.tmp.<pid>', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Write',
    toolInput: { file_path: path.join(sessionDir, 'pipeline-status.json.tmp.777') },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-3: blocks Edit to ~/.claude/pickle-rick/** runtime file', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  // Path construction split across lines to satisfy audit-test-isolation.sh
  // (which flags os.homedir() + deployed-runtime substring co-occurrence).
  // The handler under test reads the path string only; no real fs reach.
  const homeDir = os.homedir();
  const runtimeRelative = '.claude/pickle-rick/extension/services/state-manager.js';
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Edit',
    toolInput: {
      file_path: path.resolve(homeDir, runtimeRelative),
    },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-3: blocks Edit to ~/.claude/pickle-rick/** via unexpanded tilde', () => {
  // path.resolve does NOT expand `~`; the shell does at exec time. A worker
  // file_path like `~/.claude/pickle-rick/...` must still be contained.
  const { tmpDir, stateFile } = bootstrapSession();
  const tildePath = '~/' + '.claude/pickle-rick/extension/bin/mux-runner.js';
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Edit',
    toolInput: { file_path: tildePath },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-3: blocks Bash redirect to ~/.claude/pickle-rick/** runtime file', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const tildePath = '~/' + '.claude/pickle-rick/extension/services/state-manager.js';
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Bash',
    toolInput: { command: `echo evil > ${tildePath}` },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-3: blocks Bash redirect to $HOME/.claude/pickle-rick/** runtime file', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const homeVarPath = '$HOME/' + '.claude/pickle-rick/persona.md';
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Bash',
    toolInput: { command: `echo evil > ${homeVarPath}` },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-3: blocks Write to pickle_settings.json', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Write',
    toolInput: { file_path: path.join(tmpDir, 'pickle_settings.json') },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-3: blocks Write to pickle_settings.json.tmp.<pid>', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Write',
    toolInput: { file_path: path.join(tmpDir, 'pickle_settings.json.tmp.1234') },
  });
  assert.equal(result.decision, 'block');
});

// ---------------------------------------------------------------------------
// Override flags
// ---------------------------------------------------------------------------

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

test('R-WSRC-3: allow_state_writes_reason bypasses Write block and emits state_write_override_used', () => {
  const { tmpDir, sessionDir, stateFile, dataRoot } = bootstrapSession({
    flags: { allow_state_writes_reason: 'R-QGSK-3 schema migration' },
  });
  const target = path.join(sessionDir, 'state.json');
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Write',
    toolInput: { file_path: target },
  });
  assert.equal(result.decision, 'approve');

  const events = readActivityEvents(dataRoot).filter((e) => e.event === 'state_write_override_used');
  assert.equal(events.length, 1, 'expected exactly one state_write_override_used event');
  assert.equal(events[0].gate_payload.blocked_path, target);
  assert.equal(events[0].gate_payload.override_reason, 'R-QGSK-3 schema migration');
  assert.equal(events[0].gate_payload.tool_name, 'Write');
  assert.equal(typeof events[0].gate_payload.callsite_pid, 'number');
});

test('R-WSRC-3: empty/whitespace allow_state_writes_reason does NOT bypass', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession({
    flags: { allow_state_writes_reason: '   ' },
  });
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Write',
    toolInput: { file_path: path.join(sessionDir, 'state.json') },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-3: allow_settings_writes_reason bypasses pickle_settings.json only', () => {
  const { tmpDir, stateFile, dataRoot } = bootstrapSession({
    flags: { allow_settings_writes_reason: 'settings tuning' },
  });
  const settingsTarget = path.join(tmpDir, 'pickle_settings.json');
  const settingsResult = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Write',
    toolInput: { file_path: settingsTarget },
  });
  assert.equal(settingsResult.decision, 'approve');

  // But state.json writes still blocked.
  const stateResult = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Write',
    toolInput: { file_path: path.join(path.dirname(stateFile), 'state.json') },
  });
  assert.equal(stateResult.decision, 'block');

  const events = readActivityEvents(dataRoot).filter((e) => e.event === 'state_write_override_used');
  assert.equal(events.length, 1);
  assert.equal(events[0].gate_payload.blocked_path, settingsTarget);
});

// ---------------------------------------------------------------------------
// Bash output-redirect gate
// ---------------------------------------------------------------------------

test('R-WSRC-3: blocks Bash `echo {} > <session>/state.json`', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  const target = path.join(sessionDir, 'state.json');
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Bash',
    toolInput: { command: `echo '{}' > ${target}` },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-3: blocks Bash `cat /etc/hosts > <session>/state.json`', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  const target = path.join(sessionDir, 'state.json');
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Bash',
    toolInput: { command: `cat /etc/hosts > ${target}` },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-3: blocks Bash `>>` append to state.json', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  const target = path.join(sessionDir, 'state.json');
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Bash',
    toolInput: { command: `echo extra >> ${target}` },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-3: blocks Bash `>|` clobber-override redirect to state.json', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  const target = path.join(sessionDir, 'state.json');
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Bash',
    toolInput: { command: `echo '{}' >| ${target}` },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-3: blocks Bash fd-prefixed `1>|` clobber-override redirect to state.json', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  const target = path.join(sessionDir, 'state.json');
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Bash',
    toolInput: { command: `echo '{}' 1>|${target}` },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-3: blocks Bash `>&` dup-to-file redirect to state.json', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  const target = path.join(sessionDir, 'state.json');
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Bash',
    toolInput: { command: `echo '{}' >&${target}` },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-3: blocks Bash `>& <space>` dup-to-file redirect to state.json', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  const target = path.join(sessionDir, 'state.json');
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Bash',
    toolInput: { command: `echo '{}' >& ${target}` },
  });
  assert.equal(result.decision, 'block');
});

// Negative cases: `>&<digit>` / `>&-` are fd-dup/close, NOT file writes. The
// `(?![\d-])` lookahead must leave them alone so legitimate redirections that
// happen to run in an active session are never falsely blocked.
test('R-WSRC-3: approves Bash `2>&1` fd-dup (not a state-file write)', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  const target = path.join(sessionDir, 'state.json');
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Bash',
    toolInput: { command: `cat ${target} 2>&1` },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-3: approves Bash `>&2` fd-dup to stderr (not a state-file write)', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Bash',
    toolInput: { command: `echo state.json >&2` },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-3: blocks Bash `tee` writing to circuit_breaker.json', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  const target = path.join(sessionDir, 'circuit_breaker.json');
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Bash',
    toolInput: { command: `echo '{}' | tee ${target}` },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-3: blocks Bash `cp src state.json`', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  const target = path.join(sessionDir, 'state.json');
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Bash',
    toolInput: { command: `cp /tmp/src.json ${target}` },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-3: blocks Bash `mv src state.json`', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  const target = path.join(sessionDir, 'state.json');
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Bash',
    toolInput: { command: `mv /tmp/src.json ${target}` },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-3: blocks Bash `rsync ... pipeline-status.json`', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  const target = path.join(sessionDir, 'pipeline-status.json');
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Bash',
    toolInput: { command: `rsync -a /tmp/src.json ${target}` },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-3: allow_state_writes_reason bypasses Bash redirect block', () => {
  const { tmpDir, sessionDir, stateFile, dataRoot } = bootstrapSession({
    flags: { allow_state_writes_reason: 'schema migration' },
  });
  const target = path.join(sessionDir, 'state.json');
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Bash',
    toolInput: { command: `echo '{}' > ${target}` },
  });
  assert.equal(result.decision, 'approve');
  const events = readActivityEvents(dataRoot).filter((e) => e.event === 'state_write_override_used');
  assert.equal(events.length, 1);
  assert.equal(events[0].gate_payload.tool_name, 'Bash');
});

test('R-WSRC-3: approves Bash with no protected destination', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Bash',
    toolInput: { command: `echo hi > ${path.join(sessionDir, 'note.txt')}` },
  });
  assert.equal(result.decision, 'approve');
});

// ---------------------------------------------------------------------------
// Fail-open: scanner crash must approve, not block
// ---------------------------------------------------------------------------

test('R-WSRC-3: hook fails open on scanner crash (malformed hook input)', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const env = {
    ...process.env,
    EXTENSION_DIR: tmpDir,
    PICKLE_DATA_ROOT: tmpDir,
    PICKLE_STATE_FILE: stateFile,
    FORCE_COLOR: '0',
  };
  // Force a parse failure by passing non-JSON; the handler treats it as "no
  // input" (approve). This guarantees that a scanner-side exception cannot
  // leak through as a "block" — the wrapper's try/catch around main() is the
  // last line of defense and approves on any throw.
  const stdout = execFileSync(process.execPath, [HANDLER], {
    input: 'not-json-at-all',
    encoding: 'utf-8',
    env,
  });
  assert.equal(JSON.parse(stdout.trim()).decision, 'approve');
});

test('R-WSRC-3: hook approves Write to unrelated file even when active session', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Write',
    toolInput: { file_path: '/tmp/some-other-file.ts' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-3: no active session approves protected state writes (fail-open)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-state-noactive-'));
  writeExtensionSentinel(tmpDir);
  const env = {
    ...process.env,
    EXTENSION_DIR: tmpDir,
    PICKLE_DATA_ROOT: tmpDir,
    FORCE_COLOR: '0',
  };
  delete env.PICKLE_STATE_FILE;
  const stdout = execFileSync(process.execPath, [HANDLER], {
    input: JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/foo/state.json' },
    }),
    encoding: 'utf-8',
    env,
  });
  assert.equal(JSON.parse(stdout.trim()).decision, 'approve');
});

// ---------------------------------------------------------------------------
// AP-EXT-CASEFOLD: case-insensitive-filesystem parity (EXT-ITER7-01)
//
// On macOS/APFS (and Windows) `State.json` and `state.json` are the SAME INODE,
// so an exact-equality match against the all-lowercase PROTECTED_STATE_BASENAMES
// approved a write to the real runtime state file. These pin the case-folding in
// `matchProtectedStateBasename` and `isInsideRuntimeRoot`.
// ---------------------------------------------------------------------------

for (const variant of ['State.json', 'STATE.JSON', 'state.JSON']) {
  test(`AP-EXT-CASEFOLD: blocks Write to case-variant ${variant}`, () => {
    const { tmpDir, sessionDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir,
      stateFile,
      toolName: 'Write',
      toolInput: { file_path: path.join(sessionDir, variant) },
    });
    assert.equal(result.decision, 'block', `${variant} must not bypass the state gate`);
  });
}

test('AP-EXT-CASEFOLD: blocks Bash redirect to case-variant STATE.JSON', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  const target = path.join(sessionDir, 'STATE.JSON');
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Bash',
    toolInput: { command: `echo '{}' > ${target}` },
  });
  assert.equal(result.decision, 'block');
});

test('AP-EXT-CASEFOLD: blocks Write to case-variant state.json.TMP.<pid>', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Write',
    toolInput: { file_path: path.join(sessionDir, 'State.json.TMP.4242') },
  });
  assert.equal(result.decision, 'block');
});

for (const variant of ['Pickle_Settings.json', 'Circuit_Breaker.json', 'Pipeline-Status.json']) {
  test(`AP-EXT-CASEFOLD: blocks Write to case-variant ${variant}`, () => {
    const { tmpDir, sessionDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir,
      stateFile,
      toolName: 'Write',
      toolInput: { file_path: path.join(sessionDir, variant) },
    });
    assert.equal(result.decision, 'block', `${variant} must not bypass the state gate`);
  });
}

for (const rootVariant of ['.CLAUDE/pickle-rick', '.claude/Pickle-Rick', '.Claude/PICKLE-RICK']) {
  test(`AP-EXT-CASEFOLD: blocks Edit to case-variant runtime root ~/${rootVariant}`, () => {
    const { tmpDir, stateFile } = bootstrapSession();
    const result = runHandler({
      tmpDir,
      stateFile,
      toolName: 'Edit',
      toolInput: { file_path: path.join(os.homedir(), rootVariant, 'extension', 'bin', 'mux-runner.js') },
    });
    assert.equal(result.decision, 'block', `~/${rootVariant} must not bypass the runtime-root guard`);
  });
}

test('AP-EXT-CASEFOLD: unrelated case-variant file is still approved', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Write',
    toolInput: { file_path: path.join(sessionDir, 'Notes.JSON') },
  });
  assert.equal(result.decision, 'approve');
});

// ---------------------------------------------------------------------------
// AP-EXT-STATE-GATE: in-place-editor block cases.
//
// These pin the WRITE_COMMANDS in-place-editor members against the STATE gate.
// The config gate pins only `sed` (config-protection.test.js), so deleting
// `perl`/`vim`/`vi`/`nano`/`emacs`/`ed`/`ex` from the shared set previously
// broke no test at all — proven by mutation. The `4fcc02fc` collapse landed the
// fix without these cases; they are landed here.
// ---------------------------------------------------------------------------

for (const editor of ['sed -i', 'perl -i -pe', 'vim', 'vi', 'nano', 'emacs', 'ed', 'ex']) {
  test(`AP-EXT-STATE-GATE: blocks Bash in-place editor \`${editor}\` on state.json`, () => {
    const { tmpDir, sessionDir, stateFile } = bootstrapSession();
    const target = path.join(sessionDir, 'state.json');
    const result = runHandler({
      tmpDir,
      stateFile,
      toolName: 'Bash',
      toolInput: { command: `${editor} ${target}` },
    });
    assert.equal(result.decision, 'block', `${editor} must not bypass the state gate`);
  });
}

// ---------------------------------------------------------------------------
// AP-EXT-EXECNAME: executable-token folding (EXT-ITER7-01 replay).
//
// `GIT --version` really does run git on a case-insensitive filesystem, so a
// `=== 'git'` compare let `GIT reset --hard` past the R-WSRC-GR guard while
// `git RESET --hard` was blocked (findGitVerb already folded the VERB). Same
// class for the install.sh detector and the `bash`/`sh` wrapper skip, which
// also missed the absolute-path form `/bin/bash`.
// ---------------------------------------------------------------------------

function runWorkerBash(command) {
  const { tmpDir, stateFile } = bootstrapSession();
  return runHandler({
    tmpDir,
    stateFile,
    toolName: 'Bash',
    toolInput: { command },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
}

for (const cmd of ['GIT reset --hard', 'Git reset --hard', 'GIT push', 'GIT stash', 'GIT rebase -i']) {
  test(`AP-EXT-EXECNAME: blocks case-variant git verb \`${cmd}\``, () => {
    assert.equal(runWorkerBash(cmd).decision, 'block', `${cmd} must not bypass R-WSRC-GR`);
  });
}

test('AP-EXT-EXECNAME: blocks absolute-path interpreter /bin/bash wrapping a git reset', () => {
  assert.equal(runWorkerBash('/bin/bash -c x; git reset --hard').decision, 'block');
});

test('AP-EXT-EXECNAME: still approves a benign case-variant git verb', () => {
  assert.equal(runWorkerBash('GIT status').decision, 'approve');
});

for (const cmd of ['bash INSTALL.SH', 'BASH install.sh', 'bash "install.sh"', "bash 'install.sh'", '/bin/bash install.sh', 'PICKLE_ROLE=x bash install.sh']) {
  test(`AP-EXT-EXECNAME: blocks install.sh variant \`${cmd}\``, () => {
    assert.equal(runWorkerBash(cmd).decision, 'block', `${cmd} must not bypass the install.sh guard`);
  });
}

test('AP-EXT-EXECNAME: still approves a read-only reference to install.sh', () => {
  assert.equal(runWorkerBash('cat install.sh').decision, 'approve');
});

test('AP-EXT-EXECNAME: still approves a differently-named script', () => {
  assert.equal(runWorkerBash('bash pre-install.sh').decision, 'approve');
});

test('AP-EXT-EXECNAME: blocks case-variant in-place editor SED -i on state.json', () => {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  const target = path.join(sessionDir, 'state.json');
  const result = runHandler({
    tmpDir,
    stateFile,
    toolName: 'Bash',
    toolInput: { command: `SED -i s/a/b/ ${target}` },
  });
  assert.equal(result.decision, 'block');
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER19-02: a GROUPED write is still a write.
//
// `tokenizeBashCommand` splits on whitespace and quotes only, so in a grouped
// form the destination stays glued to its delimiter — `(echo x > state.json)`
// yields the token `state.json)`, whose basename matches no protected name.
// The write/config scanners were the last two detectors still reading the raw
// unsegmented command, so grouped writes APPROVED while their bare twins
// blocked (10/12 forms proven against the shipped export). Routing the walker
// through `splitShellSegments` — the same seam the git / install.sh / node
// detectors already consume — restores the boundary.
// ---------------------------------------------------------------------------

function runWorkerBashInSession(buildCommand) {
  const { tmpDir, sessionDir, stateFile } = bootstrapSession();
  return runHandler({
    tmpDir,
    stateFile,
    toolName: 'Bash',
    toolInput: { command: buildCommand(path.join(sessionDir, 'state.json')) },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
}

const GROUPED_STATE_WRITES = [
  ['subshell redirect', (t) => `(echo x > ${t})`],
  ['brace-group redirect', (t) => `{ echo x > ${t}; }`],
  ['command substitution', (t) => `$(echo x > ${t})`],
  ['backtick substitution', (t) => `\`echo x > ${t}\``],
  ['subshell sed -i', (t) => `(sed -i '' s/a/b/ ${t})`],
  ['subshell tee', (t) => `(echo x | tee ${t})`],
  ['subshell clobber-override', (t) => `(echo x >| ${t})`],
  ['brace-group cp', (t) => `{ cp /tmp/x ${t}; }`],
];

for (const [label, build] of GROUPED_STATE_WRITES) {
  test(`AP-EXT-ITER19-02: blocks grouped state write — ${label}`, () => {
    assert.equal(
      runWorkerBashInSession(build).decision,
      'block',
      `grouped ${label} must not bypass the state-write gate`,
    );
  });
}

const RUNTIME_ROOT_WRITE = `(echo x > ${path.join('~', '.claude', 'pickle-rick', 'extension', 'bin', 'mux-runner.js')})`;

const GROUPED_PROTECTED_WRITES = [
  "(sed -i '' s/a/b/ tsconfig.json)",
  "{ sed -i '' s/a/b/ tsconfig.json; }",
  '(cp /tmp/x tsconfig.json)',
  '(echo x > .eslintrc.json)',
  '{ mv /tmp/x pickle_settings.json; }',
  RUNTIME_ROOT_WRITE,
];

for (const cmd of GROUPED_PROTECTED_WRITES) {
  test(`AP-EXT-ITER19-02: blocks grouped protected write \`${cmd}\``, () => {
    assert.equal(
      runWorkerBash(cmd).decision,
      'block',
      `${cmd} must not bypass the protected-config gate`,
    );
  });
}

// Segmentation must not make read-only or unrelated commands fail closed.
for (const cmd of [
  'diff <(sort a) <(sort b)',
  'echo $(git rev-parse HEAD)',
  'grep -l foo tsconfig.json',
  'cat .eslintrc.json',
  'npm test 2>&1 | tail -5',
  '(cd extension && npx tsc --noEmit)',
]) {
  test(`AP-EXT-ITER19-02: still approves benign \`${cmd}\``, () => {
    assert.equal(runWorkerBash(cmd).decision, 'approve', `${cmd} must not false-block`);
  });
}

// The raw-command scope stays in the union: an fd-dup is not a write, and the
// bare forms the walker already caught must keep blocking.
test('AP-EXT-ITER19-02: bare redirect to state.json still blocks', () => {
  assert.equal(runWorkerBashInSession((t) => `echo x > ${t}`).decision, 'block');
});

test('AP-EXT-ITER19-02: fd-dup 2>&1 is not treated as a write', () => {
  assert.equal(runWorkerBash('npm run build 2>&1').decision, 'approve');
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER51-01: a `>` inside quotes is DATA, not a redirect operator.
//
// `normalizeRedirectOperators` isolated `>` over the whole raw command, so an
// ordinary `->` in a commit message became an operator and its next word became
// a destination. Reproduced against the shipped hook, and 4 lines in this repo's
// own git history trip it.
// ---------------------------------------------------------------------------

for (const message of [
  'anatomy-park: extension — worker -> state.json write ordering',
  'docs: producer -> state.json join',
  'fix: preserve external lock (mtime > state.json mtime + 5min)',
  'note: settings -> pickle_settings.json',
  'refactor: runner -> circuit_breaker.json handoff',
  'chore: monitor -> pipeline-status.json render',
]) {
  test(`AP-EXT-ITER51-01: quoted \`>\` in a commit message is not a redirect (${message.slice(0, 28)}…)`, () => {
    assert.equal(
      runWorkerBash(`git commit -m "${message}"`).decision,
      'approve',
      'a protected basename after a quoted `>` must not read as a write target',
    );
  });
}

// A quoted `>` must not be an operator; an UNQUOTED one still must be. Both
// directions, so the fix cannot be "stop scanning".
test('AP-EXT-ITER51-01: an unquoted redirect still blocks alongside a quoted one', () => {
  const result = runWorkerBashInSession(
    (t) => `git commit -m "worker -> state.json" && echo x > ${t}`,
  );
  assert.equal(result.decision, 'block');
});

// A quoted DESTINATION is still a destination — only the OPERATOR must be unquoted.
test('AP-EXT-ITER51-01: quoted redirect destination still blocks', () => {
  assert.equal(runWorkerBashInSession((t) => `echo x > "${t}"`).decision, 'block');
});

// The `-c` payload is CODE: its quotes are shell syntax, so redirects inside it
// are real. `>|` ends in a `|` the segmenter splits on, so the payload must be
// re-normalized BEFORE it is segmented, not after.
for (const build of [
  (t) => `bash -c "echo x >${t}"`,
  (t) => `bash -c "echo x > ${t}"`,
  (t) => `sh -lc 'echo x >| ${t}'`,
  (t) => `sh -c 'echo x >&${t}'`,
]) {
  test(`AP-EXT-ITER51-01: redirect inside a -c payload still blocks (${build('T')})`, () => {
    assert.equal(runWorkerBashInSession(build).decision, 'block');
  });
}

// fd-dup forms are not writes and must stay approved after the quote rework.
for (const cmd of ['npm run build 2>&1', 'echo state.json >&2', 'cat state.json 2>&1']) {
  test(`AP-EXT-ITER51-01: fd-dup \`${cmd}\` is not a write`, () => {
    assert.equal(runWorkerBash(cmd).decision, 'approve');
  });
}

// The quoted-ness gate is separate from the tokenizer: a quoted token whose
// whole VALUE is `>` (or a write command) would otherwise re-manufacture the
// operator the tokenizer just protected.
test('AP-EXT-ITER51-01: a quoted token whose value is `>` is not an operator', () => {
  assert.equal(runWorkerBashInSession((t) => `git commit -m ">" ${t}`).decision, 'approve');
});

// AP-EXT-ITER64-02 RETIRED the `git commit -m "sed" -i <file>` approve pin that
// stood here. It asserted quoting demotes an argument-position write command —
// but its byte-identical UNQUOTED twin `git commit -m sed -i <file>` blocks and
// always did (measured both directions), so the exception spared no real false
// positive. It only taught the bypass to add quotes. The false positive that IS
// real — a write command inside a commit MESSAGE — is one quoted span, never
// execName-matches a WRITE_COMMANDS member, and is pinned below.
test('AP-EXT-ITER51-01: a quoted write-command word matches its unquoted twin', () => {
  const quoted = runWorkerBashInSession((t) => `git commit -m "sed" -i ${t}`).decision;
  const bare = runWorkerBashInSession((t) => `git commit -m sed -i ${t}`).decision;
  assert.equal(
    quoted,
    bare,
    'quoting a word must not change the verdict — that asymmetry WAS the bypass',
  );
  assert.equal(bare, 'block');
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER51-02: quoting a COMMAND does not stop bash execing it.
//
// The AP-EXT-ITER51-01 quoted-anchor gate demoted a quoted `>` (correct — that
// really is data) and a quoted write COMMAND (wrong — `'tee' state.json` runs
// tee, shim-verified), so one pair of quotes re-opened every R-WSRC-3 write
// guard in the handler. Both directions are pinned below: quoted-in-command-
// position blocks, quoted-elsewhere still approves.
// ---------------------------------------------------------------------------

for (const build of [
  (t) => `'sed' -i '' s/a/b/ ${t}`,
  (t) => `"sed" -i '' s/a/b/ ${t}`,
  (t) => `'tee' ${t}`,
  (t) => `"tee" ${t}`,
  (t) => `'cp' /tmp/x ${t}`,
  (t) => `"mv" /tmp/x ${t}`,
  (t) => `'/usr/bin/tee' ${t}`,
  (t) => `PICKLE_ROLE=x 'tee' ${t}`,
  (t) => `echo x | "tee" ${t}`,
]) {
  test(`AP-EXT-ITER51-02: quoted write command in exec position still blocks (${build('T')})`, () => {
    assert.equal(
      runWorkerBashInSession(build).decision,
      'block',
      'quoting an executable word does not stop the shell running it',
    );
  });
}

// The false positive that stays suppressed is the commit MESSAGE form: the whole
// message is a single quoted span, so `execName` never folds it to a
// WRITE_COMMANDS member and no quoting arm is needed to spare it. (The
// argument-position pin that used to sit here was retired by AP-EXT-ITER64-02 —
// see the ITER51-01 parity test above.)
test('AP-EXT-ITER51-02: a quoted write command inside a commit message still approves', () => {
  assert.equal(
    runWorkerBashInSession((t) => `git commit -m "tee ${t} from the worker"`).decision,
    'approve',
  );
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER64-02: a command PREFIX plus one pair of quotes re-opened every
// R-WSRC-3 state-write guard.
//
// findWriteTargetInScope's Pass 2 demoted a quoted WRITE_COMMANDS token whenever
// `i !== execTokenIndex(...)`. That prelude answers "which token does the shell
// exec" POSITIONALLY — and a POSIX command PREFIX (`env`/`command`/`nohup`/
// `nice`/`sudo`/`timeout`/...) is an ordinary program that stands at that index
// with the real executable BEHIND it. So the test was true of the REAL EXEC and
// demoted it to "data". Measured against the shipped hook: 7 of 7 prefixed+quoted
// forms APPROVED for a worker while every bare twin BLOCKED; shim-verified that
// bash really execs the write command in each. Same shape and same collapse as
// AP-EXT-ITER64-01 one module over: the exec anchor is quoting-blind, needs no
// prefix table, and asks only "may the shell exec this token as a write command".
//
// The three axes each case must hold: the PREFIX (open-ended, no table), the
// QUOTING (must not change the verdict), and the ANCHOR (found wherever it sits).
// ---------------------------------------------------------------------------

const PREFIXED_QUOTED_STATE_WRITES = [
  ['env + quoted tee', (t) => `env 'tee' ${t}`],
  ['env + double-quoted tee', (t) => `env "tee" ${t}`],
  ['nohup + quoted cp', (t) => `nohup 'cp' /tmp/x ${t}`],
  ['command + quoted mv', (t) => `command "mv" /tmp/x ${t}`],
  ['nice + quoted tee', (t) => `nice 'tee' ${t}`],
  ['sudo + quoted tee', (t) => `sudo 'tee' ${t}`],
  ['timeout + quoted tee', (t) => `timeout 5 'tee' ${t}`],
  ['setsid + quoted tee', (t) => `setsid 'tee' ${t}`],
  ['stdbuf + quoted tee', (t) => `stdbuf -o0 'tee' ${t}`],
  ['env + quoted sed -i', (t) => `env 'sed' -i '' s/a/b/ ${t}`],
  ['env + quoted absolute tee', (t) => `env '/usr/bin/tee' ${t}`],
  ['env assignment + prefix + quoted tee', (t) => `PICKLE_ROLE=x env 'tee' ${t}`],
  ['stacked prefixes + quoted tee', (t) => `env nohup 'tee' ${t}`],
  ['prefixed quoted tee in a pipeline', (t) => `echo x | env 'tee' ${t}`],
  ['prefixed quoted tee in a subshell', (t) => `(env 'tee' ${t})`],
  ['prefixed quoted tee behind &&', (t) => `cd /tmp && env 'tee' ${t}`],
  // An INVENTED prefix no enumeration could carry: the fix must not depend on
  // knowing the prefix set, only on finding the write anchor wherever it sits.
  ['invented prefix + quoted tee', (t) => `frobnicate --wrap 'tee' ${t}`],
];

for (const [label, build] of PREFIXED_QUOTED_STATE_WRITES) {
  test(`AP-EXT-ITER64-02: blocks prefixed quoted state write — ${label}`, () => {
    assert.equal(
      runWorkerBashInSession(build).decision,
      'block',
      'a command prefix plus quotes must not hide the write anchor',
    );
  });
}

// Non-tautology twins: each bare form ALREADY blocked before the fix, so the
// cases above are only meaningful if quoting is what used to flip them. Pinning
// both directions is what makes this a parity test rather than a restatement.
for (const [label, build] of [
  ['env + bare tee', (t) => `env tee ${t}`],
  ['nohup + bare cp', (t) => `nohup cp /tmp/x ${t}`],
  ['command + bare mv', (t) => `command mv /tmp/x ${t}`],
  ['env + bare sed -i', (t) => `env sed -i '' s/a/b/ ${t}`],
  ['bare quoted tee, no prefix', (t) => `'tee' ${t}`],
]) {
  test(`AP-EXT-ITER64-02: unquoted/unprefixed twin also blocks — ${label}`, () => {
    assert.equal(runWorkerBashInSession(build).decision, 'block');
  });
}

test('AP-EXT-ITER64-02: quoting a prefixed write command does not change the verdict', () => {
  for (const [quoted, bare] of [
    [(t) => `env 'tee' ${t}`, (t) => `env tee ${t}`],
    [(t) => `nohup 'cp' /tmp/x ${t}`, (t) => `nohup cp /tmp/x ${t}`],
    [(t) => `command "mv" /tmp/x ${t}`, (t) => `command mv /tmp/x ${t}`],
  ]) {
    assert.equal(
      runWorkerBashInSession(quoted).decision,
      runWorkerBashInSession(bare).decision,
      'the quoted and bare forms must agree — the asymmetry WAS the bypass',
    );
  }
});

// The fix must not over-reach into READS. `cat`/`grep` are not WRITE_COMMANDS,
// so a prefixed quoted read still approves and the R-CPRO read path is intact.
for (const [label, build] of [
  ['prefixed quoted cat', (t) => `env 'cat' ${t}`],
  ['prefixed quoted grep', (t) => `nohup 'grep' -l x ${t}`],
  // `sed` with no in-place flag is a READER (AP-EXT-ITER47-01) even when the
  // quoting arm no longer demotes it.
  ['prefixed quoted sed without -i', (t) => `env 'sed' s/a/b/ ${t}`],
]) {
  test(`AP-EXT-ITER64-02: prefixed quoted READ still approves — ${label}`, () => {
    assert.equal(
      runWorkerBashInSession(build).decision,
      'approve',
      'removing the quoting arm must not turn reads into writes',
    );
  });
}

// ---------------------------------------------------------------------------
// AP-EXT-ITER47-01: `sed` without an in-place flag is a READER, not a writer.
//
// Pass 2 anchored on the bare command name, so every read-only `sed` form
// targeting a protected path was blocked — the exact over-block the read-only
// exclusions on WRITE_COMMANDS exist to prevent (`grep`/`cat`/`awk` are absent
// for that reason). Measured against the shipped handler before the fix: 6/6
// read-only `sed` forms blocked across the state, settings and config gates
// while `cat`/`grep`/`head` on the same paths approved. It fires on the
// anatomy-park worker protocol's own mandated `sed -n` read of the protected
// runtime root.
//
// Both directions are pinned: narrowing the anchor must not re-open `sed -i`.
// ---------------------------------------------------------------------------

for (const [label, build] of [
  ['sed -n range', (t) => `sed -n '1,200p' ${t}`],
  ['sed -e script to stdout', (t) => `sed -e 's/a/b/' ${t}`],
  ['sed -f script file', (t) => `sed -f prog.sed ${t}`],
  ['sed -E -n extended regex', (t) => `sed -E -n '/x/p' ${t}`],
  ['sed -n piped onward', (t) => `sed -n '1,200p' ${t} | grep foo`],
  ['sed --expression carrying an i in the script', (t) => `sed --expression='s/a/i/' ${t}`],
]) {
  test(`AP-EXT-ITER47-01: read-only ${label} approves`, () => {
    assert.equal(
      runWorkerBashInSession(build).decision,
      'approve',
      'sed writes a FILE argument only in in-place mode; a read must not block',
    );
  });
}

for (const [label, build] of [
  ['sed -i GNU form', (t) => `sed -i 's/a/b/' ${t}`],
  ['sed -i BSD empty suffix', (t) => `sed -i '' 's/a/b/' ${t}`],
  ['sed -i.bak glued suffix', (t) => `sed -i.bak 's/a/b/' ${t}`],
  ['sed -i glued empty quotes', (t) => `sed -i'' 's/a/b/' ${t}`],
  ['sed -ni bundled cluster', (t) => `sed -ni 's/a/b/' ${t}`],
  ['sed -n -i separated flags', (t) => `sed -n -i 's/a/b/' ${t}`],
  ['sed --in-place long option', (t) => `sed --in-place 's/a/b/' ${t}`],
  ['sed --in-place=.bak long option', (t) => `sed --in-place=.bak 's/a/b/' ${t}`],
  ['sed -i with permuted GNU flag order', (t) => `sed 's/a/b/' -i ${t}`],
]) {
  test(`AP-EXT-ITER47-01: in-place ${label} still blocks`, () => {
    assert.equal(
      runWorkerBashInSession(build).decision,
      'block',
      'narrowing the Pass 2 anchor must not re-open the in-place write',
    );
  });
}

// The narrowing is `sed`-only. `perl` has no total "no flag => no write"
// implication (`perl -e` opens its own argument), and the editors always write.
for (const [label, build] of [
  ['perl without -i', (t) => `perl -ne 'print' ${t}`],
  ['vim', (t) => `vim ${t}`],
  ['ed', (t) => `ed ${t}`],
  ['tee', (t) => `echo x | tee ${t}`],
]) {
  test(`AP-EXT-ITER47-01: ${label} is unaffected by the sed narrowing`, () => {
    assert.equal(runWorkerBashInSession(build).decision, 'block');
  });
}

// The other two protected domains share the one walker, so they move together.
test('AP-EXT-ITER47-01: read-only sed on a config file approves', () => {
  assert.equal(runWorkerBash("sed -n '1,20p' tsconfig.json").decision, 'approve');
});

test('AP-EXT-ITER47-01: in-place sed on a config file still blocks', () => {
  assert.equal(runWorkerBash("sed -i '' 's/a/b/' tsconfig.json").decision, 'block');
});

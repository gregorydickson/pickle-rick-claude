// @tier: fast
// R-CXOR-3: codex-spawn-shaped git reset --hard is detected+recovered by post-iteration audit;
// claude-backend PreToolUse hook stays authoritative.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { detectAndRecoverHeadRegression } from '../bin/mux-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PROTECTION_HANDLER = path.resolve(__dirname, '../hooks/handlers/config-protection.js');

function initGitRepo(repoDir) {
  execFileSync('git', ['init', '--quiet'], { cwd: repoDir, timeout: 8000 });
  execFileSync('git', ['config', 'user.email', 'test@example.local'], { cwd: repoDir, timeout: 5000 });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, timeout: 5000 });
}

function gitCommit(repoDir, message) {
  fs.writeFileSync(path.join(repoDir, `file-${Date.now()}.txt`), message);
  execFileSync('git', ['add', '-A'], { cwd: repoDir, timeout: 8000 });
  execFileSync('git', ['commit', '--no-gpg-sign', '-m', message], { cwd: repoDir, timeout: 8000 });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8', timeout: 5000 }).trim();
}

function headSha(repoDir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8', timeout: 5000 }).trim();
}

function makeTicketFile(sessionDir, ticketId, status, completionCommit) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const lines = [
    '---',
    `id: ${ticketId}`,
    `title: Test ticket`,
    `status: "${status}"`,
    completionCommit ? `completion_commit: ${completionCommit}` : '',
    '---',
    '# Test',
  ].filter(Boolean);
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), lines.join('\n'));
}

function makeStatePath(sessionDir) {
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({ active: true, schema_version: 5, iteration: 1 }));
  return statePath;
}

/**
 * Run config-protection handler as a subprocess (the correct test pattern — the handler
 * calls main() at module top-level and reads stdin, so it cannot be imported directly).
 * Returns the parsed JSON decision from stdout.
 *
 * Mirrors the pattern from extension/tests/config-protection.test.js:runHandler().
 */
function runConfigProtectionHandler(opts) {
  const { command, role } = opts;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-cxor3-hook-'));
  const sessionDir = path.join(tmpDir, 'sessions', 'session');
  fs.mkdirSync(sessionDir, { recursive: true });

  // Extension sentinel so getExtensionRoot() resolves
  const binDir = path.join(tmpDir, 'extension', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'log-watcher.js'), '');

  const stateFile = path.join(sessionDir, 'state.json');
  const resolvedState = {
    active: true,
    schema_version: 5,
    iteration: 1,
    // working_dir must match the subprocess's cwd (process.cwd()) for hook resolution
    working_dir: process.cwd(),
    step: 'implement',
    max_iterations: 5,
    max_time_minutes: 60,
    worker_timeout_seconds: 3600,
    start_time_epoch: Math.floor(Date.now() / 1000) - 30,
    completion_promise: null,
    original_prompt: 'test',
    session_dir: sessionDir,
    current_ticket: 'test-ticket',
  };
  fs.writeFileSync(stateFile, JSON.stringify(resolvedState));
  fs.writeFileSync(
    path.join(tmpDir, 'current_sessions.json'),
    JSON.stringify({ [process.cwd()]: sessionDir }),
  );

  const hookInput = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
  });

  const env = {
    ...process.env,
    EXTENSION_DIR: tmpDir,
    PICKLE_STATE_FILE: stateFile,
    FORCE_COLOR: '0',
  };
  if (role) {
    env.PICKLE_ROLE = role;
  } else {
    delete env.PICKLE_ROLE;
  }

  let stdout;
  try {
    stdout = execFileSync(process.execPath, [CONFIG_PROTECTION_HANDLER], {
      input: hookInput,
      env,
      encoding: 'utf-8',
      timeout: 10000,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return JSON.parse(stdout.trim());
}

// AC-CXOR-3-1 (codex path): A codex-spawn-shaped git reset --hard <baseline> is detected+recovered.
//
// Codex workers run as `codex exec` subprocesses. Their bash calls never route through
// the Claude Code PreToolUse hook. Therefore `isGitVerbBlockedByRWSRCGR` (which checks PICKLE_ROLE
// and only fires for claude-backend workers) CANNOT intercept a codex worker's git reset --hard.
//
// The authoritative recovery path is the post-iteration `detectAndRecoverHeadRegression` audit
// in `mux-runner.ts`, which fires after every worker iteration regardless of backend.
// This test verifies that a direct `git reset --hard` (codex-spawn-shaped: no Claude Code hook)
// is caught and resolved without a silent orphan.
test('R-CXOR-3: codex-spawn-shaped git reset --hard is detected and recovered — no silent orphan', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-cxor3a-')));
  const repoDir = path.join(tmp, 'repo');
  const sessionDir = path.join(tmp, 'session');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  initGitRepo(repoDir);
  const startCommit = gitCommit(repoDir, 'baseline: pre-ticket commit');
  const completionCommit = gitCommit(repoDir, 'test(R-CXOR-3): codex worker real work');

  // Simulate what a codex worker does: git reset --hard <baseline>
  // This runs git directly — no Claude Code PreToolUse hook fires because codex exec
  // subprocesses are not Claude Code tool calls.
  execFileSync('git', ['reset', '--hard', startCommit], { cwd: repoDir, timeout: 8000 });
  assert.equal(headSha(repoDir), startCommit, 'HEAD should be at baseline after codex-style git reset --hard');

  const ticketId = 'cxor3-test-ticket';
  makeTicketFile(sessionDir, ticketId, 'Done', completionCommit);
  const statePath = makeStatePath(sessionDir);

  // e56ed23f: capture the reachable-object count before recovery. ff-only and
  // the hold path may only ADVANCE HEAD or no-op — neither may rewrite history,
  // so the count of all commit objects must never decrease.
  const objCountBefore = execFileSync('git', ['rev-list', '--all', '--count'], { cwd: repoDir, encoding: 'utf-8' }).trim();

  // The post-iteration audit (R-CXOR-1) is the authoritative guard for codex workers
  const result = detectAndRecoverHeadRegression({
    ticketId,
    workingDir: repoDir,
    startCommit,
    completionCommitSha: completionCommit,
    sessionDir,
    statePath,
    iteration: 1,
    log: () => {},
  });

  // Must detect the regression
  assert.equal(result.detected, true, 'post-iteration audit must detect the HEAD regression');

  // No silent orphan: reattached OR held (e56ed23f added flip_suppressed /
  // suppression_cap_escalate as hold outcomes; marked_failed survives only on
  // the evidence-absent branch).
  assert.ok(
    result.action === 'ff_reattached'
      || result.action === 'flip_suppressed'
      || result.action === 'suppression_cap_escalate'
      || result.action === 'marked_failed',
    `action must be ff_reattached or a hold variant, got: ${result.action}`,
  );

  // History is NEVER rewritten — the reachable-object count must not decrease.
  const objCountAfter = execFileSync('git', ['rev-list', '--all', '--count'], { cwd: repoDir, encoding: 'utf-8' }).trim();
  assert.ok(
    Number(objCountAfter) >= Number(objCountBefore),
    `history must not be rewritten: object count ${objCountBefore} -> ${objCountAfter}`,
  );

  if (result.action === 'ff_reattached') {
    assert.equal(result.recovered, true, 'ff-reattach must succeed when SHA is valid');
    assert.equal(headSha(repoDir), completionCommit, 'HEAD must advance to completion commit after reattach');
  } else {
    // Held — ticket must not be Done-at-baseline; status preserved or Failed
    const ticketPath = path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`);
    const content = fs.readFileSync(ticketPath, 'utf-8');
    assert.ok(
      !content.includes('status: "Done"') && !content.includes("status: 'Done'"),
      'ticket must not remain Done-at-baseline when reattach not possible',
    );
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

// AC-CXOR-3-1 (claude path): claude-backend PreToolUse hook still authoritative.
//
// The config-protection handler is invoked as a subprocess (the correct pattern — the handler
// reads stdin at module load time and cannot be imported directly).
// When PICKLE_ROLE=worker is set, the hook MUST block `git reset --hard` for claude workers.
// This verifies that adding the codex post-iteration guard does NOT change claude behavior.
test('R-CXOR-3: claude-backend hook still authoritative — blocks git reset for PICKLE_ROLE=worker', () => {
  const decision = runConfigProtectionHandler({
    command: 'git reset --hard HEAD~1',
    role: 'worker',
  });

  assert.equal(decision.decision, 'block', 'claude PreToolUse hook must block git reset for PICKLE_ROLE=worker');
  assert.ok(
    typeof decision.reason === 'string' && decision.reason.includes('R-WSRC-GR'),
    'block reason must reference R-WSRC-GR',
  );
});

test('R-CXOR-3: claude-backend hook still authoritative — blocks git reset --hard <sha> for PICKLE_ROLE=worker', () => {
  const decision = runConfigProtectionHandler({
    command: 'git reset --hard deadbeefdeadbeef',
    role: 'worker',
  });

  assert.equal(decision.decision, 'block', 'must block git reset --hard <sha> for claude workers');
});

test('R-CXOR-3: claude-backend hook does NOT block git commands for non-worker roles', () => {
  // Without PICKLE_ROLE=worker, the hook should not block git operations
  const decision = runConfigProtectionHandler({
    command: 'git reset --hard HEAD~1',
    role: null, // no role set — simulates manager/operator context
  });

  assert.equal(decision.decision, 'approve', 'hook must not block git for non-worker roles (manager/operator)');
});

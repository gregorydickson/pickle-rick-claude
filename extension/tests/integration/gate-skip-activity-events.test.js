// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const CHECK_READINESS_BIN = path.resolve(__dirname, '../../bin/check-readiness.js');
const TMUX_RUNNER_BIN = path.resolve(__dirname, '../../bin/mux-runner.js');

function assertIsoTimestamp(value, label) {
  assert.match(value ?? '', /^\d{4}-\d{2}-\d{2}T/, `${label} should be an ISO timestamp`);
}

function tmpDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// Isolation-critical: mux-runner's gate-passing exit path (commitGatePassingDeliverableOnExitPath
// -> commitAndContinueDoneFlip) runs `git -C <working_dir> add -A && commit` (+ resetToSha).
// working_dir MUST be a throwaway tmp git repo — NEVER REPO_ROOT/process.cwd(), or the runner
// commits the operator's uncommitted tree into the real repo (the R-WTIV incident).
function makeWorkingDir(prefix) {
  const dir = tmpDir(prefix);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Pickle Tests'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'extension'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'init', '--no-gpg-sign'], { cwd: dir });
  return dir;
}

function readActivityLines(dataRoot) {
  const activityDir = path.join(dataRoot, 'activity');
  if (!fs.existsSync(activityDir)) return [];
  const files = fs.readdirSync(activityDir).filter((file) => file.endsWith('.jsonl'));
  return files.flatMap((file) =>
    fs.readFileSync(path.join(activityDir, file), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)));
}

function writeTicket(sessionDir, id, status = 'Done') {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${id}.md`), [
    '---',
    `id: ${id}`,
    `key: ${id.toUpperCase()}`,
    `status: ${status}`,
    'ac_ids: [REQ-1]',
    '---',
    '',
    '# Ticket',
    '',
    '## Acceptance Criteria',
    '- [ ] The workflow should feel intuitive.',
    '',
  ].join('\n'));
}

function writeAlignedSession(sessionDir, workingDir, flags) {
  writeTicket(sessionDir, 'ok0001');
  fs.writeFileSync(path.join(sessionDir, 'decomposition_manifest.json'), JSON.stringify({
    requirements: ['REQ-1'],
    tickets: [{ id: 'ok0001', key: 'OK-1', ac_ids: ['REQ-1'] }],
  }, null, 2));
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    active: true,
    step: 'research',
    iteration: 0,
    max_iterations: 1,
    worker_timeout_seconds: 1200,
    original_prompt: 'gate skip activity integration',
    working_dir: workingDir,
    command_template: 'pickle.md',
    flags,
  }, null, 2));
}

function writeClaudeStub(binDir) {
  const claudePath = path.join(binDir, 'claude');
  fs.writeFileSync(claudePath, [
    '#!/bin/sh',
    'echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"<promise>EPIC_COMPLETED</promise>"}]}}\'',
    '',
  ].join('\n'));
  fs.chmodSync(claudePath, 0o755);
}

function runMuxRunner(sessionDir, dataRoot, pathPrefixDir) {
  const env = {
    ...process.env,
    EXTENSION_DIR: REPO_ROOT,
    PICKLE_BACKEND: 'claude',
    PICKLE_DATA_ROOT: dataRoot,
    PATH: `${pathPrefixDir}:${process.env.PATH || ''}`,
  };
  delete env.PICKLE_ROLE;
  return spawnSync(process.execPath, [TMUX_RUNNER_BIN, sessionDir], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

test('readiness skip path emits readiness_skipped with matching reason', () => {
  const sessionDir = tmpDir('pickle-gate-skip-readiness-session-');
  const dataRoot = tmpDir('pickle-gate-skip-readiness-data-');
  try {
    const reason = 'bundle pre-validated by refinement team';
    const result = spawnSync(process.execPath, [
      CHECK_READINESS_BIN,
      '--session-dir', sessionDir,
      '--skip-readiness', reason,
    ], {
      env: { ...process.env, PICKLE_DATA_ROOT: dataRoot },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const events = readActivityLines(dataRoot);
    const event = events.find((entry) => entry.event === 'readiness_skipped');
    assert.ok(event, `expected readiness_skipped event, got ${JSON.stringify(events)}`);
    assert.equal(event.gate_payload?.reason, reason);
    assertIsoTimestamp(event.ts, 'readiness_skipped.ts');
    assertIsoTimestamp(event.gate_payload?.timestamp, 'readiness_skipped.gate_payload.timestamp');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('mux-runner skip flags emit ticket_audit_bypassed on the audit bypass path', () => {
  const sessionDir = tmpDir('pickle-gate-skip-audit-session-');
  const dataRoot = tmpDir('pickle-gate-skip-audit-data-');
  const stubBinDir = tmpDir('pickle-gate-skip-audit-bin-');
  const workingDir = makeWorkingDir('pickle-gate-skip-audit-wd-');
  try {
    writeClaudeStub(stubBinDir);
    writeAlignedSession(sessionDir, workingDir, {
      skip_quality_gates_reason: 'historical drift acknowledged',
    });

    const result = runMuxRunner(sessionDir, dataRoot, stubBinDir);
    assert.match(result.stderr, /ticket audit gate bypassed via state\.flags\.skip_quality_gates_reason/);

    const events = readActivityLines(dataRoot);
    const readinessEvent = events.find((entry) => entry.event === 'readiness_skipped');
    const auditEvent = events.find((entry) => entry.event === 'ticket_audit_bypassed');
    assert.ok(readinessEvent, `expected readiness_skipped event, got ${JSON.stringify(events)}`);
    assert.ok(auditEvent, `expected ticket_audit_bypassed event, got ${JSON.stringify(events)}`);
    assert.equal(readinessEvent.gate_payload?.reason, 'historical drift acknowledged');
    assert.equal(auditEvent.reason, 'historical drift acknowledged');
    assert.equal(auditEvent.gate_payload, undefined);
    assertIsoTimestamp(auditEvent.ts, 'ticket_audit_bypassed.ts');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(stubBinDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('clean gate pass emits neither readiness_skipped nor ticket_audit_bypassed', () => {
  const sessionDir = tmpDir('pickle-gate-clean-session-');
  const dataRoot = tmpDir('pickle-gate-clean-data-');
  const stubBinDir = tmpDir('pickle-gate-clean-bin-');
  const workingDir = makeWorkingDir('pickle-gate-clean-wd-');
  try {
    writeClaudeStub(stubBinDir);
    writeAlignedSession(sessionDir, workingDir, {});

    const result = runMuxRunner(sessionDir, dataRoot, stubBinDir);
    assert.doesNotMatch(result.stderr, /READINESS HALT|TICKET AUDIT HALT/);

    const events = readActivityLines(dataRoot);
    assert.ok(!events.some((entry) => entry.event === 'readiness_skipped'));
    assert.ok(!events.some((entry) => entry.event === 'ticket_audit_bypassed'));
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(stubBinDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

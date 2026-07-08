// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPAWN_MORTY_BIN = path.resolve(__dirname, '../../bin/spawn-morty.js');
const WORKER_TIMEOUT_MS = 90_000;

function makeTmpRoot(prefix = 'pickle-codex-completion-commit-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeExtensionSentinel(root) {
  const sentinelDir = path.join(root, 'extension', 'bin');
  fs.mkdirSync(sentinelDir, { recursive: true });
  fs.writeFileSync(path.join(sentinelDir, 'log-watcher.js'), '');
}

function initGitRepo(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  writeExtensionSentinel(dir);
  fs.mkdirSync(path.join(dir, 'extension', 'src'), { recursive: true });
  // The worker lint gate runs `npm run test:fast` for non-small tickets
  // (R-PTG contract). This fixture exercises a clean codex worker turn, so the
  // test phase must resolve to a passing no-op script — without it the gate
  // fails on a missing-script error and the ticket is wrongly marked Failed.
  fs.writeFileSync(
    path.join(dir, 'extension', 'package.json'),
    JSON.stringify({
      name: 'fixture',
      private: true,
      type: 'module',
      scripts: { 'test:fast': 'node -e ""', 'test:integration': 'node -e ""' },
    }, null, 2),
  );
  fs.writeFileSync(path.join(dir, 'extension', 'src', 'baseline.ts'), 'export const baseline = 1;\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial fixture', '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
}

function writeCodexShim(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const shimPath = path.join(binDir, 'codex');
  fs.writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const mode = process.env.FAKE_WORKER_MODE || 'auto-fill';
const ticketDir = process.env.FAKE_TICKET_DIR;
const ticketId = process.env.FAKE_TICKET_ID;
const artifact = path.join(ticketDir, 'research_2026-05-06.md');
fs.mkdirSync(ticketDir, { recursive: true });
fs.writeFileSync(artifact, '# research\\n');
fs.writeFileSync(path.join(process.cwd(), 'worker-change.txt'), mode + '\\n');
execFileSync('git', ['add', 'worker-change.txt'], { cwd: process.cwd() });
execFileSync('git', ['commit', '-m', \`fix(\${ticketId}): completion-commit regression \${mode}\`, '--no-gpg-sign'], { cwd: process.cwd(), stdio: 'ignore' });
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
if (mode === 'announce') {
  process.stdout.write('COMPLETION_COMMIT_RECORDED: ' + sha + '\\n');
}
process.stdout.write('worker-log '.repeat(30) + '\\n');
process.stdout.write('<promise>I AM DONE</promise>\\n');
`);
  fs.chmodSync(shimPath, 0o755);
  return shimPath;
}

function writeNpxShim(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const shimPath = path.join(binDir, 'npx');
  fs.writeFileSync(shimPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'tsc') process.exit(0);
if (args[0] === 'eslint') process.exit(0);
process.exit(0);
`);
  fs.chmodSync(shimPath, 0o755);
  return shimPath;
}

function writeSession(root, ticketId) {
  const sessionRoot = path.join(root, 'session');
  const ticketDir = path.join(sessionRoot, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(sessionRoot, 'state.json'), JSON.stringify({
    backend: 'codex',
    active: true,
    working_dir: root,
    step: 'implement',
    iteration: 1,
    max_iterations: 10,
    worker_timeout_seconds: 30,
    start_time_epoch: Math.floor(Date.now() / 1000) - 60,
    completion_promise: null,
    original_prompt: 'integration replay',
    current_ticket: ticketId,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionRoot,
    schema_version: 3,
    activity: [],
  }, null, 2));
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), [
    '---',
    `id: ${ticketId}`,
    'title: R-CCC-5 integration replay',
    'status: "Todo"',
    'order: 1',
    '---',
    '# R-CCC-5 integration replay',
  ].join('\n'));
  return { sessionRoot, ticketDir };
}

function runSpawnMorty(root, sessionRoot, ticketDir, ticketId, mode) {
  const binDir = path.join(root, 'bin');
  writeCodexShim(binDir);
  writeNpxShim(binDir);
  return spawnSync(process.execPath, [
    SPAWN_MORTY_BIN,
    'integration replay',
    '--ticket-id', ticketId,
    '--ticket-path', ticketDir,
    '--timeout', '30',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      EXTENSION_DIR: root,
      PICKLE_DATA_DIR: root,
      FAKE_WORKER_MODE: mode,
      FAKE_TICKET_DIR: ticketDir,
      FAKE_TICKET_ID: ticketId,
    },
    timeout: WORKER_TIMEOUT_MS,
  });
}

function readState(sessionRoot) {
  return JSON.parse(fs.readFileSync(path.join(sessionRoot, 'state.json'), 'utf8'));
}

test('spawn-morty emits worker_completion_commit_announced when codex worker prints ACK token', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    const ticketId = '167fcaf9';
    const { sessionRoot, ticketDir } = writeSession(root, ticketId);
    const result = runSpawnMorty(root, sessionRoot, ticketDir, ticketId, 'announce');
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);

    const state = readState(sessionRoot);
    const event = state.activity.find((entry) => entry.event === 'worker_completion_commit_announced');
    assert.ok(event, `missing worker_completion_commit_announced in ${JSON.stringify(state.activity)}`);
    assert.equal(event.ticket_id, ticketId);
    assert.match(event.sha, /^[0-9a-f]{40}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('spawn-morty auto-fills completion_commit after a successful codex worker turn without ACK', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    const ticketId = '167fcaf9';
    const { sessionRoot, ticketDir } = writeSession(root, ticketId);
    const result = runSpawnMorty(root, sessionRoot, ticketDir, ticketId, 'auto-fill');
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);

    const ticketPath = path.join(ticketDir, `rick_ticket_${ticketId}.md`);
    const ticketContent = fs.readFileSync(ticketPath, 'utf8');
    assert.match(ticketContent, /status: "Done"/);
    assert.match(ticketContent, /completion_commit:\s+"[0-9a-f]{40}"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

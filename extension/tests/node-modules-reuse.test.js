// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPAWN_MORTY_BIN = path.resolve(__dirname, '../bin/spawn-morty.js');
const WORKER_TIMEOUT_MS = 90_000;

function makeTmpRoot(prefix = 'pickle-node-modules-reuse-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
}

function writeExtensionSentinel(root) {
  const sentinelDir = path.join(root, 'extension', 'bin');
  fs.mkdirSync(sentinelDir, { recursive: true });
  fs.writeFileSync(path.join(sentinelDir, 'log-watcher.js'), '');
}

function initWorkerFixtureRepo(root) {
  initGitRepo(root);
  writeExtensionSentinel(root);
  fs.mkdirSync(path.join(root, 'extension', 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'extension', 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'extension', 'package.json'),
    JSON.stringify({ name: 'fixture', private: true, type: 'module' }, null, 2),
  );
  fs.writeFileSync(path.join(root, 'extension', 'src', 'baseline.ts'), 'export const baseline = 1;\n');
  fs.writeFileSync(
    path.join(root, 'extension', 'node_modules', '.package-lock.json'),
    JSON.stringify({ name: 'fixture-lock', lockfileVersion: 3 }, null, 2),
  );
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'initial fixture', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });
}

function writeCommandShim(binDir, commandName, logPath, options = {}) {
  fs.mkdirSync(binDir, { recursive: true });
  const shimPath = path.join(binDir, commandName);
  const exitCode = options.exitCode ?? 0;
  fs.writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('fs');
const logPath = ${JSON.stringify(logPath)};
const existing = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : [];
existing.push([${JSON.stringify(commandName)}, ...process.argv.slice(2)]);
fs.writeFileSync(logPath, JSON.stringify(existing, null, 2));
process.exit(${JSON.stringify(exitCode)});
`);
  fs.chmodSync(shimPath, 0o755);
}

function writeCodexShim(binDir, fixtureName) {
  fs.mkdirSync(binDir, { recursive: true });
  const shimPath = path.join(binDir, 'codex');
  fs.writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ticketDir = process.env.FAKE_TICKET_DIR;
const ticketId = process.env.FAKE_TICKET_ID;
fs.mkdirSync(ticketDir, { recursive: true });
fs.writeFileSync(path.join(ticketDir, 'research_2026-05-06.md'), '# research\\n');
const target = path.join(process.cwd(), 'extension', 'src', ${JSON.stringify(fixtureName)});
// Vary content by ticketId so each stubbed worker run is a real change; identical
// content made the second run's \`git commit\` a no-op ("nothing to commit"), crashing
// the shim before the promise token (real workers always make distinct changes).
fs.writeFileSync(target, 'export const workerGateFixture = ' + JSON.stringify(ticketId) + ';\\n');
execFileSync('git', ['add', ${JSON.stringify(`extension/src/${fixtureName}`)}], { cwd: process.cwd() });
execFileSync('git', ['commit', '-m', \`fix(\${ticketId}): worker gate fixture\`, '--no-gpg-sign'], { cwd: process.cwd(), stdio: 'ignore' });
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
process.stdout.write('COMPLETION_COMMIT_RECORDED: ' + sha + '\\n');
process.stdout.write('<promise>I AM DONE</promise>\\n');
`);
  fs.chmodSync(shimPath, 0o755);
}

function writeSession(root, ticketId) {
  const sessionRoot = path.join(root, 'session');
  const ticketDir = path.join(sessionRoot, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(sessionRoot, 'state.json'), JSON.stringify({
    backend: 'codex',
    active: true,
    working_dir: root,
    worker_timeout_seconds: 30,
    start_time_epoch: Math.floor(Date.now() / 1000) - 60,
    activity: [],
  }, null, 2));
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), [
    '---',
    `id: ${ticketId}`,
    'title: Worker node_modules reuse',
    'status: "Todo"',
    'order: 1',
    '---',
    '# Ticket',
  ].join('\n'));
  return { sessionRoot, ticketDir };
}

function runWorker(root, ticketId, ticketDir, binDir) {
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
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      EXTENSION_DIR: root,
      PICKLE_DATA_DIR: root,
      FAKE_TICKET_DIR: ticketDir,
      FAKE_TICKET_ID: ticketId,
    },
    timeout: WORKER_TIMEOUT_MS,
  });
}

test('node-modules-reuse: stubbed worker runs leave extension node_modules lock mtime unchanged', () => {
  const root = makeTmpRoot();
  try {
    initWorkerFixtureRepo(root);
    const sentinelPath = path.join(root, 'extension', 'node_modules', '.package-lock.json');
    const binDir = path.join(root, 'bin');
    writeCodexShim(binDir, 'fixture-one.ts');
    writeCommandShim(binDir, 'npx', path.join(root, 'npx-calls.json'));
    writeCommandShim(binDir, 'npm', path.join(root, 'npm-calls.json'));

    const before = fs.statSync(sentinelPath).mtimeMs;

    const firstTicket = writeSession(root, '3646c20a');
    const firstResult = runWorker(root, '3646c20a', firstTicket.ticketDir, binDir);
    assert.equal(firstResult.status, 0, `first worker failed: ${firstResult.stderr || firstResult.stdout}`);
    const afterFirst = fs.statSync(sentinelPath).mtimeMs;
    assert.equal(afterFirst, before);

    const secondTicket = writeSession(root, '8a1b2c3d');
    const secondResult = runWorker(root, '8a1b2c3d', secondTicket.ticketDir, binDir);
    assert.equal(secondResult.status, 0, `second worker failed: ${secondResult.stderr || secondResult.stdout}`);
    const afterSecond = fs.statSync(sentinelPath).mtimeMs;
    assert.equal(afterSecond, before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('node-modules-reuse: worker boot sources do not contain npm ci or npm install', () => {
  const spawnMortySource = fs.readFileSync(path.resolve(__dirname, '../src/bin/spawn-morty.ts'), 'utf8');
  const muxRunnerSource = fs.readFileSync(path.resolve(__dirname, '../src/bin/mux-runner.ts'), 'utf8');

  assert.doesNotMatch(spawnMortySource, /\bnpm (?:ci|install)\b/);
  assert.doesNotMatch(muxRunnerSource, /\bnpm (?:ci|install)\b/);
});

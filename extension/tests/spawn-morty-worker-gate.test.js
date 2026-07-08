// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorkerGate } from '../bin/spawn-morty.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPAWN_MORTY_BIN = path.resolve(__dirname, '../bin/spawn-morty.js');
const WORKER_TIMEOUT_MS = 90_000;

function makeTmpRoot(prefix = 'pickle-spawn-morty-worker-gate-') {
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
  fs.writeFileSync(
    path.join(root, 'extension', 'package.json'),
    JSON.stringify({ name: 'fixture', private: true, type: 'module' }, null, 2),
  );
  fs.writeFileSync(path.join(root, 'extension', 'src', 'baseline.ts'), 'export const baseline = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'initial fixture', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });
}

function writeCommandShim(binDir, commandName, logPath, options = {}) {
  fs.mkdirSync(binDir, { recursive: true });
  const shimPath = path.join(binDir, commandName);
  const exitCode = options.exitCode ?? 0;
  const stdout = options.stdout ?? '';
  const stderr = options.stderr ?? '';
  const sleepMs = options.sleepMs ?? 0;
  fs.writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('fs');
const logPath = ${JSON.stringify(logPath)};
const existing = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : [];
existing.push([${JSON.stringify(commandName)}, ...process.argv.slice(2)]);
fs.writeFileSync(logPath, JSON.stringify(existing, null, 2));
const finish = () => {
if (${JSON.stringify(stdout)}.length > 0) process.stdout.write(${JSON.stringify(stdout)});
if (${JSON.stringify(stderr)}.length > 0) process.stderr.write(${JSON.stringify(stderr)});
process.exit(${JSON.stringify(exitCode)});
};
if (${JSON.stringify(sleepMs)} > 0) {
  setTimeout(finish, ${JSON.stringify(sleepMs)});
} else {
  finish();
}
`);
  fs.chmodSync(shimPath, 0o755);
}

function writeCodexShim(binDir, fixtureName, options = {}) {
  const writeArtifact = options.writeArtifact !== false;
  fs.mkdirSync(binDir, { recursive: true });
  const shimPath = path.join(binDir, 'codex');
  fs.writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ticketDir = process.env.FAKE_TICKET_DIR;
const ticketId = process.env.FAKE_TICKET_ID;
fs.mkdirSync(ticketDir, { recursive: true });
${writeArtifact ? "fs.writeFileSync(path.join(ticketDir, 'research_2026-05-06.md'), '# research\\n');" : '// 7eb9fa20 evidence-absent variant: no fresh lifecycle artifact written by the worker'}
const target = path.join(process.cwd(), 'extension', 'src', ${JSON.stringify(fixtureName)});
fs.writeFileSync(target, 'export const workerGateFixture = 2;\\n');
execFileSync('git', ['add', ${JSON.stringify(`extension/src/${fixtureName}`)}], { cwd: process.cwd() });
execFileSync('git', ['commit', '-m', \`fix(\${ticketId}): worker gate fixture\`, '--no-gpg-sign'], { cwd: process.cwd(), stdio: 'ignore' });
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
process.stdout.write('COMPLETION_COMMIT_RECORDED: ' + sha + '\\n');
process.stdout.write('<promise>I AM DONE</promise>\\n');
`);
  fs.chmodSync(shimPath, 0o755);
}

function writeNpxPassShim(binDir, logPath) {
  writeCommandShim(binDir, 'npx', logPath);
}

function writeNpmFailShim(binDir, logPath, stdout) {
  writeCommandShim(binDir, 'npm', logPath, { exitCode: 1, stdout });
}

function writeSession(root, ticketId, options = {}) {
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
    'title: Worker test gate failure',
    'status: "Todo"',
    'order: 1',
    ...(options.complexityTier ? [`complexity_tier: ${options.complexityTier}`] : []),
    '---',
    '# Ticket',
  ].join('\n'));
  return { sessionRoot, ticketDir };
}

function readState(sessionRoot) {
  return JSON.parse(fs.readFileSync(path.join(sessionRoot, 'state.json'), 'utf8'));
}

async function withPathPrefix(prefix, fn) {
  const prev = process.env.PATH;
  process.env.PATH = `${prefix}${path.delimiter}${prev || ''}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = prev;
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function writeNpmTimeoutTreeShim(binDir, logPath, options = {}) {
  fs.mkdirSync(binDir, { recursive: true });
  const shimPath = path.join(binDir, 'npm');
  fs.writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const logPath = ${JSON.stringify(logPath)};
const pidPath = ${JSON.stringify(options.pidPath ?? '')};
const signalPath = ${JSON.stringify(options.signalPath ?? '')};
const readyPath = ${JSON.stringify(options.readyPath ?? '')};
const existing = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : [];
existing.push(['npm', ...process.argv.slice(2)]);
fs.writeFileSync(logPath, JSON.stringify(existing, null, 2));

process.on('SIGTERM', () => {
  if (signalPath) fs.appendFileSync(signalPath, 'npm:SIGTERM\\n');
});

const child = spawn(process.execPath, ['-e', \`
  const fs = require('fs');
  const pidPath = \${JSON.stringify(pidPath)};
  const signalPath = \${JSON.stringify(signalPath)};
  const readyPath = \${JSON.stringify(readyPath)};
  fs.writeFileSync(pidPath, String(process.pid));
  if (readyPath) fs.writeFileSync(readyPath, 'ready\\n');
  process.on('SIGTERM', () => {
    if (signalPath) fs.appendFileSync(signalPath, 'child:SIGTERM\\\\n');
  });
  setInterval(() => {}, 1000);
\`], { stdio: 'ignore' });

if (pidPath && child.pid) fs.writeFileSync(pidPath, String(child.pid));
if (readyPath) fs.writeFileSync(readyPath, 'ready\\n');
if (!pidPath && child.pid) process.stdout.write(String(child.pid));
setInterval(() => {}, 1000);
`);
  fs.chmodSync(shimPath, 0o755);
}

test('runWorkerGate: lints changed extension/src files, runs tsc, then runs test:fast', async () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    fs.mkdirSync(path.join(root, 'extension', 'src', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'extension', 'src', 'demo', 'one.ts'), 'export const one = 1;\n');
    fs.writeFileSync(path.join(root, 'extension', 'src', 'demo', 'two.ts'), 'export const two = 2;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'base', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });
    const preWorkerHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    fs.writeFileSync(path.join(root, 'extension', 'src', 'demo', 'one.ts'), 'export const one = 11;\n');
    fs.writeFileSync(path.join(root, 'extension', 'src', 'demo', 'two.ts'), 'export const two = 22;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'worker change abc12345', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });

    const statePath = path.join(root, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ activity: [] }, null, 2));
    const shimDir = path.join(root, 'bin');
    const logPath = path.join(root, 'npx-log.json');
    writeCommandShim(shimDir, 'npx', logPath);
    writeCommandShim(shimDir, 'npm', logPath);

    const result = await withPathPrefix(shimDir, () => runWorkerGate([
      'extension/src/demo/one.ts',
      'extension/src/demo/two.ts',
    ], {
      workingDir: root,
      ticketId: 'abc12345',
      statePath,
      preWorkerHead,
    }));

    assert.equal(result.ok, true);
    assert.deepEqual(result.testFailures, []);
    const calls = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    assert.deepEqual(calls[0], ['npx', 'eslint', 'src/demo/one.ts', 'src/demo/two.ts', '--max-warnings=-1']);
    assert.deepEqual(calls[1], ['npx', 'tsc', '--noEmit']);
    assert.deepEqual(calls[2], ['npm', 'run', 'test:fast']);
    assert.equal(calls.some((argv) => argv[0] === 'git' && argv[1] === 'commit'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runWorkerGate: narrow tier stops after eslint and tsc and logs the downgrade warning', async () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    fs.writeFileSync(path.join(root, 'pickle_settings.json'), JSON.stringify({
      worker_gate_tier: 'narrow',
    }, null, 2));
    fs.mkdirSync(path.join(root, 'extension', 'src', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'extension', 'src', 'demo', 'one.ts'), 'export const one = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'base', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(path.join(root, 'extension', 'src', 'demo', 'one.ts'), 'export const one = 2;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'worker change abc12345', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });

    const statePath = path.join(root, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ activity: [] }, null, 2));
    const shimDir = path.join(root, 'bin');
    const logPath = path.join(root, 'gate-log.json');
    writeCommandShim(shimDir, 'npx', logPath);
    writeCommandShim(shimDir, 'npm', logPath);

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => {
      warnings.push(String(message));
    };
    let result;
    try {
      result = await withPathPrefix(shimDir, () => runWorkerGate([
        'extension/src/demo/one.ts',
      ], {
        workingDir: root,
        ticketId: 'abc12345',
        statePath,
        preWorkerHead: null,
      }));
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(result.ok, true);
    const calls = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    assert.deepEqual(calls, [
      ['npx', 'eslint', 'src/demo/one.ts', '--max-warnings=-1'],
      ['npx', 'tsc', '--noEmit'],
    ]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /worker gate tier downgraded to "narrow"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runWorkerGate: small tier skips test commands and emits tier_phase_skipped', async () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    fs.mkdirSync(path.join(root, 'extension', 'src', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'extension', 'src', 'demo', 'one.ts'), 'export const one = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'base', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(path.join(root, 'extension', 'src', 'demo', 'one.ts'), 'export const one = 2;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'worker change abc12345', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });

    const statePath = path.join(root, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ activity: [] }, null, 2));
    const shimDir = path.join(root, 'bin');
    const logPath = path.join(root, 'gate-log.json');
    writeCommandShim(shimDir, 'npx', logPath);
    writeCommandShim(shimDir, 'npm', logPath);

    const result = await withPathPrefix(shimDir, () => runWorkerGate([
      'extension/src/demo/one.ts',
    ], {
      workingDir: root,
      ticketId: 'abc12345',
      ticketTier: 'small',
      statePath,
      preWorkerHead: null,
    }));

    assert.equal(result.ok, true);
    assert.deepEqual(result.testFailures, []);
    const calls = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    assert.deepEqual(calls, [
      ['npx', 'eslint', 'src/demo/one.ts', '--max-warnings=-1'],
      ['npx', 'tsc', '--noEmit'],
    ]);
    const state = readState(path.dirname(statePath));
    const skippedEvent = state.activity.find((entry) => entry.event === 'tier_phase_skipped');
    assert.deepEqual(skippedEvent, {
      event: 'tier_phase_skipped',
      ticket_id: 'abc12345',
      tier: 'small',
      skipped_phases: ['test:fast'],
      ts: skippedEvent.ts,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runWorkerGate: returns parsed testFailures when npm run test:fast fails after clean lint and tsc', async () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    fs.mkdirSync(path.join(root, 'extension', 'src', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'extension', 'src', 'demo', 'one.ts'), 'export const one = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'base', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(path.join(root, 'extension', 'src', 'demo', 'one.ts'), 'export const one = 2;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'worker change abc12345', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });

    const statePath = path.join(root, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ activity: [] }, null, 2));
    const shimDir = path.join(root, 'bin');
    const logPath = path.join(root, 'gate-log.json');
    writeCommandShim(shimDir, 'npx', logPath);
    writeCommandShim(shimDir, 'npm', logPath, {
      exitCode: 1,
      stdout: `not ok 1 - fast tier fails\n  ---\n  location: '${path.join(root, 'extension', 'tests', 'demo.test.js')}:12:4'\n  error: 'boom'\n  ...\n`,
    });

    const result = await withPathPrefix(shimDir, () => runWorkerGate([
      'extension/src/demo/one.ts',
    ], {
      workingDir: root,
      ticketId: 'abc12345',
      statePath,
      preWorkerHead: null,
    }));

    assert.equal(result.ok, false);
    assert.equal(result.lintErrors, 0);
    assert.equal(result.tscErrors, 0);
    assert.equal(result.gatePhase, 'test:fast');
    assert.equal(result.retryCount, 0);
    assert.equal(result.autofixApplied, false);
    assert.deepEqual(result.testFailures, [{
      name: 'fast tier fails',
      file: 'tests/demo.test.js',
      message: 'boom',
    }]);
    const calls = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    assert.deepEqual(calls, [
      ['npx', 'eslint', 'src/demo/one.ts', '--max-warnings=-1'],
      ['npx', 'tsc', '--noEmit'],
      ['npm', 'run', 'test:fast'],
    ]);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const failedEvent = state.activity.find((entry) => entry.event === 'worker_gate_failed');
    assert.deepEqual(failedEvent, {
      event: 'worker_gate_failed',
      ts: failedEvent.ts,
      ticket_id: 'abc12345',
      gate_phase: 'test:fast',
      failures: [{
        name: 'fast tier fails',
        file: 'tests/demo.test.js',
        message: 'boom',
      }],
      retry_count: 0,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runWorkerGate: full tier runs test:fast and then test:integration', async () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    fs.writeFileSync(path.join(root, 'pickle_settings.json'), JSON.stringify({
      worker_gate_tier: 'full',
    }, null, 2));
    fs.mkdirSync(path.join(root, 'extension', 'src', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'extension', 'src', 'demo', 'one.ts'), 'export const one = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'base', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(path.join(root, 'extension', 'src', 'demo', 'one.ts'), 'export const one = 2;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'worker change abc12345', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });

    const statePath = path.join(root, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ activity: [] }, null, 2));
    const shimDir = path.join(root, 'bin');
    const logPath = path.join(root, 'gate-log.json');
    writeCommandShim(shimDir, 'npx', logPath);
    writeCommandShim(shimDir, 'npm', logPath);

    const result = await withPathPrefix(shimDir, () => runWorkerGate([
      'extension/src/demo/one.ts',
    ], {
      workingDir: root,
      ticketId: 'abc12345',
      statePath,
      preWorkerHead: null,
    }));

    assert.equal(result.ok, true);
    const calls = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    assert.deepEqual(calls, [
      ['npx', 'eslint', 'src/demo/one.ts', '--max-warnings=-1'],
      ['npx', 'tsc', '--noEmit'],
      ['npm', 'run', 'test:fast'],
      ['npm', 'run', 'test:integration'],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runWorkerGate: full tier integration failure emits worker_gate_failed with test:integration phase', async () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    fs.writeFileSync(path.join(root, 'pickle_settings.json'), JSON.stringify({
      worker_gate_tier: 'full',
    }, null, 2));
    fs.mkdirSync(path.join(root, 'extension', 'src', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'extension', 'src', 'demo', 'one.ts'), 'export const one = 1;\n');
    const statePath = path.join(root, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ activity: [] }, null, 2));
    const shimDir = path.join(root, 'shims');
    const logPath = path.join(root, 'calls.json');
    const npmShim = `#!/bin/sh
set -eu
printf '%s\\n' "$0 $*" >> "${logPath}"
if [ "$1" = "run" ] && [ "$2" = "test:integration" ]; then
  cat <<'EOF'
not ok 1 - integration tier fails
  ---
  location: '${path.join(root, 'extension', 'tests', 'integration-fixture.test.js')}:9:3'
  error: 'integration boom'
  ...
EOF
  exit 1
fi
exit 0
`;
    fs.mkdirSync(shimDir, { recursive: true });
    fs.writeFileSync(path.join(shimDir, 'npx'), `#!/bin/sh\nset -eu\nprintf '%s\\n' "$0 $*" >> "${logPath}"\nexit 0\n`);
    fs.chmodSync(path.join(shimDir, 'npx'), 0o755);
    fs.writeFileSync(path.join(shimDir, 'npm'), npmShim);
    fs.chmodSync(path.join(shimDir, 'npm'), 0o755);

    const result = await withPathPrefix(shimDir, () => runWorkerGate([
      'extension/src/demo/one.ts',
    ], {
      workingDir: root,
      ticketId: 'abc12345',
      statePath,
      preWorkerHead: null,
    }));

    assert.equal(result.ok, false);
    assert.equal(result.gatePhase, 'test:integration');
    assert.deepEqual(result.testFailures, [{
      name: 'integration tier fails',
      file: 'tests/integration-fixture.test.js',
      message: 'integration boom',
    }]);

    const state = readState(path.dirname(statePath));
    const failedEvent = state.activity.find((entry) => entry.event === 'worker_gate_failed');
    assert.deepEqual(failedEvent, {
      event: 'worker_gate_failed',
      ticket_id: 'abc12345',
      gate_phase: 'test:integration',
      failures: [{
        name: 'integration tier fails',
        file: 'tests/integration-fixture.test.js',
        message: 'integration boom',
      }],
      retry_count: 0,
      ts: failedEvent.ts,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 7eb9fa20: a gate-fail whose worker produced fresh ticket artifacts AND a
// ticket-scoped commit is evidence-backed — the Failed flip AND the gate-fail
// reset are suppressed (work preserved; manager-side hold parks the ticket).
test('spawn-morty: test:fast failure with work evidence suppresses the Failed flip and preserves the commit', () => {
  const root = makeTmpRoot();
  try {
    initWorkerFixtureRepo(root);
    const ticketId = '3646c20a';
    const { sessionRoot, ticketDir } = writeSession(root, ticketId);
    const binDir = path.join(root, 'bin');
    writeCodexShim(binDir, 'test-fixture.ts');
    writeNpxPassShim(binDir, path.join(root, 'npx-calls.json'));
    const npmCallsPath = path.join(sessionRoot, 'npm-calls.json');
    writeNpmFailShim(
      binDir,
      npmCallsPath,
      `not ok 1 - worker fast tier fails\n  ---\n  location: '${path.join(root, 'extension', 'tests', 'worker-fixture.test.js')}:7:3'\n  error: 'boom'\n  ...\n`,
    );
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    const result = spawnSync(process.execPath, [
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
        FAKE_TICKET_DIR: ticketDir,
        FAKE_TICKET_ID: ticketId,
      },
      timeout: WORKER_TIMEOUT_MS,
    });

    assert.equal(result.status, 1, `stderr: ${result.stderr}`);
    const state = readState(sessionRoot);
    const failedEvent = state.activity.find((entry) => entry.event === 'worker_gate_failed');
    assert.ok(failedEvent, `missing worker_gate_failed in ${JSON.stringify(state.activity)}`);
    assert.equal(failedEvent.gate_phase, 'test:fast');
    assert.equal(failedEvent.retry_count, 0);
    assert.deepEqual(failedEvent.failures, [{
      name: 'worker fast tier fails',
      file: 'tests/worker-fixture.test.js',
      message: 'boom',
    }]);
    assert.equal(state.activity.some((entry) => entry.event === 'worker_lint_autofix_applied'), false);

    // Suppression evidence: event emitted, ledger entry persisted.
    const suppressedEvent = state.activity.find((entry) => entry.event === 'failed_flip_suppressed');
    assert.ok(suppressedEvent, `missing failed_flip_suppressed in ${JSON.stringify(state.activity)}`);
    assert.equal(suppressedEvent.ticket, ticketId);
    assert.equal(suppressedEvent.suppression_count, 1);
    assert.ok(Array.isArray(state.recovery_attempts)
      && state.recovery_attempts.some((a) => a.strategy === 'failed_flip_suppressed' && a.ticket === ticketId));

    // Frontmatter status preserved — no Failed flip, no completion commit.
    const ticketContent = fs.readFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), 'utf8');
    assert.match(ticketContent, /status: "In Progress"/);
    assert.doesNotMatch(ticketContent, /status: "Failed"/);
    assert.doesNotMatch(ticketContent, /completion_commit:/);
    const npmCalls = JSON.parse(fs.readFileSync(npmCallsPath, 'utf8'));
    assert.deepEqual(npmCalls, [['npm', 'run', 'test:fast']]);

    // The gate-fail reset was suppressed: the worker's commit survives.
    const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    assert.notEqual(headAfter, headBefore, 'worker commit preserved (reset suppressed)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 7eb9fa20 evidence-absent path: stale resume artifact (outside the spawn
// window) + commit outside scope allowed_paths → flip + reset proceed exactly
// as before (legitimate failures still flip, after resetToSha's archival).
test('spawn-morty: evidence-absent test:fast failure still marks ticket Failed and resets HEAD', () => {
  const root = makeTmpRoot();
  try {
    initWorkerFixtureRepo(root);
    const ticketId = '3646c20c';
    const { sessionRoot, ticketDir } = writeSession(root, ticketId);
    // Stale lifecycle artifact from a previous attempt: present (so worker
    // validation passes) but aged outside the [spawn, exit] evidence window.
    const staleArtifact = path.join(ticketDir, 'research_2026-05-06.md');
    fs.writeFileSync(staleArtifact, '# stale research\n');
    const oldSec = (Date.now() - 60 * 60 * 1000) / 1000;
    fs.utimesSync(staleArtifact, oldSec, oldSec);
    // Scoped session: the worker's commit (extension/src/...) is out of scope.
    fs.writeFileSync(path.join(sessionRoot, 'scope.json'), JSON.stringify({ allowed_paths: ['docs/'] }));
    const binDir = path.join(root, 'bin');
    writeCodexShim(binDir, 'test-fixture.ts', { writeArtifact: false });
    writeNpxPassShim(binDir, path.join(root, 'npx-calls.json'));
    const npmCallsPath = path.join(sessionRoot, 'npm-calls.json');
    writeNpmFailShim(
      binDir,
      npmCallsPath,
      `not ok 1 - worker fast tier fails\n  ---\n  location: '${path.join(root, 'extension', 'tests', 'worker-fixture.test.js')}:7:3'\n  error: 'boom'\n  ...\n`,
    );
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    const result = spawnSync(process.execPath, [
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
        FAKE_TICKET_DIR: ticketDir,
        FAKE_TICKET_ID: ticketId,
      },
      timeout: WORKER_TIMEOUT_MS,
    });

    assert.equal(result.status, 1, `stderr: ${result.stderr}`);
    const state = readState(sessionRoot);
    assert.ok(state.activity.some((entry) => entry.event === 'worker_gate_failed'));
    assert.equal(state.activity.some((entry) => entry.event === 'failed_flip_suppressed'), false, 'no suppression without evidence');

    const ticketContent = fs.readFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), 'utf8');
    assert.match(ticketContent, /status: "Failed"/);
    assert.doesNotMatch(ticketContent, /completion_commit:/);

    const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    assert.equal(headAfter, headBefore, 'gate-fail reset restored the pre-worker HEAD');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('spawn-morty: small-tier success skips npm test gate and records tier_phase_skipped', () => {
  const root = makeTmpRoot();
  try {
    initWorkerFixtureRepo(root);
    const ticketId = '3646c20b';
    const { sessionRoot, ticketDir } = writeSession(root, ticketId, { complexityTier: 'small' });
    const binDir = path.join(root, 'bin');
    writeCodexShim(binDir, 'small-tier-fixture.ts');
    writeNpxPassShim(binDir, path.join(root, 'npx-calls.json'));
    writeCommandShim(binDir, 'npm', path.join(sessionRoot, 'npm-calls.json'));

    const result = spawnSync(process.execPath, [
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
        FAKE_TICKET_DIR: ticketDir,
        FAKE_TICKET_ID: ticketId,
      },
      timeout: WORKER_TIMEOUT_MS,
    });

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const state = readState(sessionRoot);
    // R-PIAP-A2 added a second tier_phase_skipped emission for lifecycle-pruned
    // phases; this test asserts the worker-gate skip, so select that event by its
    // skipped_phases payload rather than the first tier_phase_skipped entry.
    const skippedEvent = state.activity.find(
      (entry) => entry.event === 'tier_phase_skipped' && Array.isArray(entry.skipped_phases) && entry.skipped_phases.includes('test:fast'),
    );
    assert.ok(skippedEvent, `missing test:fast tier_phase_skipped in ${JSON.stringify(state.activity)}`);
    assert.equal(skippedEvent.ticket_id, ticketId);
    assert.equal(skippedEvent.tier, 'small');
    assert.deepEqual(skippedEvent.skipped_phases, ['test:fast']);
    const npmCallsPath = path.join(sessionRoot, 'npm-calls.json');
    assert.equal(fs.existsSync(npmCallsPath), false, 'npm test gate should not run for small-tier tickets');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// These contracts stay deferred until the matching production entry conditions land.
test.skip('runWorkerGate: retries once when npm run test:fast fails and the second attempt passes', () => {
  assert.match('pending', /pending/);
});

test.skip('runWorkerGate: skips test:fast when SKIP_WORKER_TEST_GATE=1 and logs the skip marker', () => {
  assert.match('SKIP_WORKER_TEST_GATE', /SKIP_WORKER_TEST_GATE/);
});

test('runWorkerGate: honors worker_test_gate_timeout_ms, reports timeout details, and kills npm descendants', { timeout: 60_000 }, async () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    // 250ms → 6000ms: under 8-way full-suite concurrency the npm-shim chain
    // (npm shim → node grandchild) must spawn and write its readiness file
    // before the gate's own timeout fires; a 250ms budget races the grandchild
    // spawn so `waitFor(readyPath)` could time out (the flaky failure). The
    // shim's grandchild loops forever, so any finite gate budget still proves
    // the timeout fires and the process tree is SIGTERM'd.
    fs.writeFileSync(path.join(root, 'pickle_settings.json'), JSON.stringify({
      worker_test_gate_timeout_ms: 6000,
    }, null, 2));
    fs.mkdirSync(path.join(root, 'extension', 'src', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'extension', 'src', 'demo', 'one.ts'), 'export const one = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'base', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(path.join(root, 'extension', 'src', 'demo', 'one.ts'), 'export const one = 2;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'worker change abc12345', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });

    const statePath = path.join(root, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ activity: [] }, null, 2));
    const shimDir = path.join(root, 'bin');
    const logPath = path.join(root, 'gate-log.json');
    writeCommandShim(shimDir, 'npx', logPath);
    const pidPath = path.join(root, 'timed-out-child.pid');
    const signalPath = path.join(root, 'timed-out-signals.log');
    const readyPath = path.join(root, 'timed-out-child.ready');
    writeNpmTimeoutTreeShim(shimDir, logPath, { pidPath, signalPath, readyPath });

    const resultPromise = withPathPrefix(shimDir, () => runWorkerGate([
      'extension/src/demo/one.ts',
    ], {
      workingDir: root,
      ticketId: 'abc12345',
      statePath,
      preWorkerHead: null,
    }));
    await waitFor(() => fs.existsSync(readyPath), 20_000, 'timed-out child readiness');
    const childPid = Number(fs.readFileSync(pidPath, 'utf8').trim());
    assert.equal(Number.isInteger(childPid), true);

    const result = await resultPromise;

    assert.equal(result.ok, false);
    assert.equal(result.testFailures.length, 1);
    assert.deepEqual({
      name: result.testFailures[0]?.name,
      file: result.testFailures[0]?.file,
    }, {
      name: '__timeout__',
      file: 'npm run test:fast',
    });
    assert.match(
      result.testFailures[0]?.message ?? '',
      /^timed out after 6000ms; sent SIGTERM to process tree(?: and escalated to SIGKILL after 2000ms)?$/,
    );
    assert.equal(isPidAlive(childPid), false, `descendant pid ${childPid} should be dead after timeout cleanup`);
    const signals = fs.readFileSync(signalPath, 'utf8');
    assert.match(signals, /npm:SIGTERM/);
    const calls = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    assert.deepEqual(calls, [
      ['npx', 'eslint', 'src/demo/one.ts', '--max-warnings=-1'],
      ['npx', 'tsc', '--noEmit'],
      ['npm', 'run', 'test:fast'],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

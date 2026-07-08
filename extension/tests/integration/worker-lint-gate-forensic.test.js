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

function writeExtensionSentinel(root) {
  const sentinelDir = path.join(root, 'extension', 'bin');
  fs.mkdirSync(sentinelDir, { recursive: true });
  fs.writeFileSync(path.join(sentinelDir, 'log-watcher.js'), '');
}

function makeTmpRoot(prefix = 'pickle-worker-lint-gate-forensic-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initRepo(root) {
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root });
  writeExtensionSentinel(root);
  fs.mkdirSync(path.join(root, 'extension', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'extension', 'package.json'), JSON.stringify({ name: 'fixture', private: true, type: 'module' }, null, 2));
  fs.writeFileSync(path.join(root, 'extension', 'src', 'baseline.ts'), 'export const baseline = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'initial fixture', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });
}

function writeShims(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'codex'), `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ticketDir = process.env.FAKE_TICKET_DIR;
const ticketId = process.env.FAKE_TICKET_ID;
fs.mkdirSync(ticketDir, { recursive: true });
fs.writeFileSync(path.join(ticketDir, 'research_2026-05-06.md'), '# research\\n');
fs.writeFileSync(path.join(process.cwd(), 'extension', 'src', 'complexity.ts'), 'export function complexity(v) { if (v===1) return 1; if (v===2) return 2; if (v===3) return 3; return 4; }\\n');
execFileSync('git', ['add', 'extension/src/complexity.ts'], { cwd: process.cwd() });
execFileSync('git', ['commit', '-m', \`fix(\${ticketId}): forensic lint violation\`, '--no-gpg-sign'], { cwd: process.cwd(), stdio: 'ignore' });
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
process.stdout.write('COMPLETION_COMMIT_RECORDED: ' + sha + '\\n');
process.stdout.write('worker-log '.repeat(30) + '\\n');
process.stdout.write('<promise>I AM DONE</promise>\\n');
`);
  fs.writeFileSync(path.join(binDir, 'npx'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'eslint' && args.includes('--fix')) process.exit(0);
if (args[0] === 'eslint') {
  process.stderr.write('complexity error\\n');
  process.exit(1);
}
if (args[0] === 'tsc') process.exit(0);
process.exit(0);
`);
  fs.chmodSync(path.join(binDir, 'codex'), 0o755);
  fs.chmodSync(path.join(binDir, 'npx'), 0o755);
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
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), `---\nid: ${ticketId}\ntitle: Forensic\nstatus: "Todo"\norder: 1\n---\n# Ticket\n`);
  return { sessionRoot, ticketDir };
}

// 7eb9fa20: the forensic worker writes a fresh lifecycle artifact AND a
// ticket-scoped commit, so the lint gate failure is evidence-backed — the
// Failed flip and gate-fail reset are suppressed; the worker's commit and
// frontmatter status survive for triage. The worker still exits non-zero and
// the gate telemetry still fires. The evidence-absent flip+reset path is
// pinned by spawn-morty-worker-gate.test.js.
test('worker lint gate forensic: deliberate lint violation with work evidence holds the ticket (no flip, commit preserved)', () => {
  const root = makeTmpRoot();
  try {
    initRepo(root);
    const ticketId = '3646c20a';
    const { sessionRoot, ticketDir } = writeSession(root, ticketId);
    const binDir = path.join(root, 'bin');
    writeShims(binDir);
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    const result = spawnSync(process.execPath, [
      SPAWN_MORTY_BIN,
      'forensic replay',
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
    const state = JSON.parse(fs.readFileSync(path.join(sessionRoot, 'state.json'), 'utf8'));
    // Worker gate telemetry consolidated to a single `worker_gate_failed` event with a
    // `gate_phase` discriminator in commit b4a2a282 (2026-05-11). The lint-specific
    // assertion below tracks the post-consolidation shape.
    assert.ok(
      state.activity.some(
        (entry) => entry.event === 'worker_gate_failed' && entry.gate_phase === 'lint',
      ),
      `expected worker_gate_failed{gate_phase:'lint'} in activity, got: ${JSON.stringify(
        state.activity.filter((e) => /worker_/.test(e.event)).map((e) => e.event),
      )}`,
    );
    assert.ok(
      state.activity.some((entry) => entry.event === 'failed_flip_suppressed' && entry.ticket === ticketId),
      'evidence-backed gate failure emits failed_flip_suppressed',
    );
    const ticketContent = fs.readFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), 'utf8');
    assert.match(ticketContent, /status: "In Progress"/, 'status preserved — no Failed flip with evidence');
    const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    assert.notEqual(headAfter, headBefore, 'worker commit preserved (gate-fail reset suppressed)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

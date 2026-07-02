// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const TMUX_RUNNER_BIN = path.resolve(__dirname, '../bin/mux-runner.js');

function makeTmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mux-halt-copy-')));
}

function run(args, extDir) {
  const env = { ...process.env, EXTENSION_DIR: extDir, PICKLE_BACKEND: 'claude' };
  delete env.PICKLE_ROLE;
  return spawnSync(process.execPath, [TMUX_RUNNER_BIN, ...args], {
    env,
    encoding: 'utf-8',
    timeout: 60_000,
  });
}

test('command docs surface Skip-flag overrides in /pickle-tmux and /pickle-pipeline', () => {
  // R-PNTR-5: pickle.md deleted; skip-flag docs now required only in pickle-tmux and pickle-pipeline.
  // Guard-layer prune (item e): the ONLY documented skip surface is the unified
  // skip_quality_gates_reason — the retired per-gate flags must not be documented.
  for (const relPath of [
    '.claude/commands/pickle-tmux.md',
    '.claude/commands/pickle-pipeline.md',
  ]) {
    const text = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
    assert.match(text, /## Skip-flag overrides/);
    assert.match(text, /state\.flags\.skip_quality_gates_reason/);
    assert.doesNotMatch(text, /skip_readiness_reason/);
    assert.doesNotMatch(text, /skip_ticket_audit_reason/);
  }
});


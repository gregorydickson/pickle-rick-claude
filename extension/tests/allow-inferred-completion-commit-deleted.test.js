// @tier: fast
//
// B-DURA T60 — `allow_inferred_completion_commit` flag fully deleted.
//
// AC-DURA-5: zero references to the flag remain anywhere in extension/src.
// Plus: an explicit pre-deploy live-state check (no active session persists the
// flag `true`) is present and behaves correctly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(EXT_ROOT, 'src');
const SCRIPT = path.join(EXT_ROOT, 'scripts', 'check-no-inferred-completion-flag.sh');
const FLAG = 'allow_inferred_completion_commit';

test('AC-DURA-5: zero references to allow_inferred_completion_commit in extension/src', () => {
  // grep -rn returns non-zero (exit 1) when there are no matches; that is the pass.
  const res = spawnSync('grep', ['-rn', FLAG, SRC_ROOT], { encoding: 'utf8' });
  assert.equal(
    res.stdout.trim(),
    '',
    `flag must be fully deleted from extension/src; found:\n${res.stdout}`,
  );
  assert.equal(res.status, 1, 'grep must report no matches (exit 1)');
});

test('pre-deploy live-state check script exists and is executable', () => {
  const st = fs.statSync(SCRIPT);
  assert.ok(st.isFile(), 'check-no-inferred-completion-flag.sh must exist');
  assert.ok((st.mode & 0o111) !== 0, 'script must be executable');
});

test('pre-deploy check passes (exit 0) when no active session persists the flag', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-t60-clean-'));
  try {
    const sessions = path.join(root, 'sessions');
    const sdir = path.join(sessions, '2026-06-23-abc123');
    fs.mkdirSync(sdir, { recursive: true });
    // Active session with the flag absent → safe to deploy.
    fs.writeFileSync(
      path.join(sdir, 'state.json'),
      JSON.stringify({ active: true, flags: {} }),
    );
    const res = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, INFERRED_FLAG_SCAN_ROOT: sessions },
    });
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr:\n${res.stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pre-deploy check blocks (exit 2) when an active session persists the flag true', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-t60-flagged-'));
  try {
    const sessions = path.join(root, 'sessions');
    const sdir = path.join(sessions, '2026-06-23-def456');
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(
      path.join(sdir, 'state.json'),
      JSON.stringify({ active: true, flags: { [FLAG]: true } }),
    );
    const res = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, INFERRED_FLAG_SCAN_ROOT: sessions },
    });
    assert.equal(res.status, 2, 'an active session with the flag true must block deploy');
    assert.match(res.stderr, new RegExp(FLAG), 'stderr must name the offending flag');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pre-deploy check ignores an INACTIVE session that persists the flag', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-t60-inactive-'));
  try {
    const sessions = path.join(root, 'sessions');
    const sdir = path.join(sessions, '2026-06-23-ghi789');
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(
      path.join(sdir, 'state.json'),
      JSON.stringify({ active: false, flags: { [FLAG]: true } }),
    );
    const res = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, INFERRED_FLAG_SCAN_ROOT: sessions },
    });
    assert.equal(res.status, 0, 'a terminated session is not mid-flight; deploy is safe');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

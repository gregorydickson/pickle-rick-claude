// @tier: fast
//
// WS-2c (R-PFNT): target-toolchain fail-fast. When the TARGET repo declares a Node
// toolchain (package.json) but has no installed node_modules, the runner must detect
// the definite missing-toolchain signal so it can fail fast ONCE (exit_reason
// 'toolchain_unavailable') instead of letting workers churn ~30 Done/Skipped
// iterations of red gates. The probe must be conservative: every AMBIGUOUS case
// (no package.json / node_modules present / no working_dir / FS error) returns false
// so a genuine run is never falsely killed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { targetToolchainMissing, isFailureExit } from '../bin/mux-runner.js';

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('WS-2c: package.json present but node_modules absent → fail-fast (true)', () => {
  const dir = mkTmp('toolchain-missing-');
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'target' }));
    // No node_modules created → the definite missing-toolchain signal.
    assert.equal(targetToolchainMissing(dir), true,
      'a target with package.json and no node_modules must trip the fast-fail path');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('WS-2c: a normal target (package.json + node_modules) does NOT fail-fast (false)', () => {
  const dir = mkTmp('toolchain-normal-');
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'target' }));
    fs.mkdirSync(path.join(dir, 'node_modules'));
    assert.equal(targetToolchainMissing(dir), false,
      'an installed toolchain must never trip the fast-fail path');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('WS-2c: a SYMLINKED node_modules (worktree case) reads as installed (false)', () => {
  const real = mkTmp('toolchain-real-nm-');
  const dir = mkTmp('toolchain-symlink-');
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'target' }));
    fs.mkdirSync(path.join(real, 'node_modules'));
    fs.symlinkSync(path.join(real, 'node_modules'), path.join(dir, 'node_modules'));
    assert.equal(targetToolchainMissing(dir), false,
      'a symlinked node_modules (the worktree case) must read as present');
  } finally {
    fs.rmSync(real, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('WS-2c: a non-Node target (no package.json) is ambiguous → does NOT fail-fast (false)', () => {
  const dir = mkTmp('toolchain-nonnode-');
  try {
    // No package.json → no toolchain claim; never a definite missing-toolchain signal.
    assert.equal(targetToolchainMissing(dir), false,
      'a target without package.json must never trip the fast-fail path');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('WS-2c: a null/empty working_dir is conservative → does NOT fail-fast (false)', () => {
  assert.equal(targetToolchainMissing(null), false, 'null working_dir is not our call');
  assert.equal(targetToolchainMissing(undefined), false, 'undefined working_dir is not our call');
  assert.equal(targetToolchainMissing(''), false, 'empty working_dir is not our call');
});

test('WS-2c: toolchain_unavailable is a member of the ExitReason union and a failure exit', () => {
  // Compile-time proof: isFailureExit is typed over ExitReason, so tsc rejects a
  // non-member literal. Runtime proof: it classifies as a failure exit (stops
  // auto-resume rather than retrying against a still-missing toolchain).
  assert.equal(isFailureExit('toolchain_unavailable'), true);
});

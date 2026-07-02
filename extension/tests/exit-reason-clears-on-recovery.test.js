// @tier: fast
//
// R-PEDC regression: `done_without_commit_evidence` exit_reason MUST clear
// when a later iteration's `guardCompletionCommitBeforeDone` eventually
// classifies `ok: true` (because the auto-promote helper landed the SHA
// during the same iteration). Without this clear, the prior stamp survives
// into `finalizePipeline` and the operator sees `pipeline-status.json:
// status === "failed"` even though 3/3 tickets shipped Done.
//
// Live incident: 2026-05-23 session `2026-05-23-48e6309a` exited iter 6 with
// `done_without_commit_evidence` despite all three tickets reaching Done
// with valid `completion_commit` frontmatter values. See PRD
// `prds/p2-completion-commit-quoted-form-and-exit-reason-2026-05-24.md`.
//
// Mirrors the R-CCR-3 stale-handoff clearance pattern in pipeline-runner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clearStaleDoneWithoutCommitEvidence } from '../bin/mux-runner.js';
import { writeStateFile } from '../services/pickle-utils.js';

function mkTmp(prefix = 'pickle-pedc-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function baseState(overrides = {}) {
  return {
    active: true,
    working_dir: '/tmp/test',
    step: 'implement',
    iteration: 6,
    max_iterations: 20,
    max_time_minutes: 60,
    worker_timeout_seconds: 2400,
    start_time_epoch: Date.now(),
    completion_promise: null,
    original_prompt: 'test prompt',
    current_ticket: 'abc12345',
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/test-session',
    schema_version: 1,
    ...overrides,
  };
}

test('R-PEDC: clearStaleDoneWithoutCommitEvidence clears a stamped done_without_commit_evidence', () => {
  const root = mkTmp();
  try {
    const sp = path.join(root, 'state.json');
    writeStateFile(sp, baseState({ exit_reason: 'done_without_commit_evidence' }));

    clearStaleDoneWithoutCommitEvidence(sp);

    const after = JSON.parse(fs.readFileSync(sp, 'utf8'));
    assert.equal(after.exit_reason, null,
      'stale done_without_commit_evidence must be cleared after guard recovers');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R-PEDC: clearStaleDoneWithoutCommitEvidence leaves UNRELATED exit_reasons untouched', () => {
  // Defensive: a real failure (e.g. circuit_open, rate_limit_exhausted) on a
  // prior iteration must NOT be silently cleared by a later happy-path guard
  // pass on a different ticket. Only `done_without_commit_evidence` is the
  // recovery class we own here.
  const unrelatedReasons = [
    'circuit_open',
    'rate_limit_exhausted',
    'manager_handoff_pending',
    'closer_handoff_terminal',
    'timeout_repeat',
    'state_schema_version_ahead',
    'iteration_cap_exhausted',
  ];
  for (const reason of unrelatedReasons) {
    const root = mkTmp();
    try {
      const sp = path.join(root, 'state.json');
      writeStateFile(sp, baseState({ exit_reason: reason }));

      clearStaleDoneWithoutCommitEvidence(sp);

      const after = JSON.parse(fs.readFileSync(sp, 'utf8'));
      assert.equal(after.exit_reason, reason,
        `unrelated exit_reason '${reason}' must be preserved`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('R-PEDC: clearStaleDoneWithoutCommitEvidence is a no-op when exit_reason is null', () => {
  const root = mkTmp();
  try {
    const sp = path.join(root, 'state.json');
    writeStateFile(sp, baseState({ exit_reason: null }));

    clearStaleDoneWithoutCommitEvidence(sp);

    const after = JSON.parse(fs.readFileSync(sp, 'utf8'));
    assert.equal(after.exit_reason, null);
    // No-op MUST NOT corrupt unrelated fields.
    assert.equal(after.current_ticket, 'abc12345');
    assert.equal(after.iteration, 6);
    assert.equal(after.step, 'implement');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R-PEDC: clearStaleDoneWithoutCommitEvidence is best-effort (no throw) on missing state file', () => {
  const root = mkTmp();
  try {
    const sp = path.join(root, 'nonexistent-state.json');
    // MUST NOT throw — happy-path Done flip must not be blocked by a
    // transient state read failure. The finalize/exit path will resolve
    // terminal state via its own forensic reads.
    assert.doesNotThrow(() => clearStaleDoneWithoutCommitEvidence(sp));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R-PEDC: end-to-end shape — stamp then clear simulates iter5-fatal → iter6-recovery', () => {
  // Simulates the live incident: iter 5 stamped `done_without_commit_evidence`
  // because the gate transiently saw `inferred`. Iter 6 ran auto-promote
  // and the guard re-classified `explicit` (ok:true). The clear MUST happen
  // on the guard-passes path so finalize labels the bundle `completed`,
  // not `failed`.
  const root = mkTmp();
  try {
    const sp = path.join(root, 'state.json');
    writeStateFile(sp, baseState({
      iteration: 5,
      exit_reason: 'done_without_commit_evidence',
    }));

    // iter 6: guard now passes; clear the stale stamp.
    clearStaleDoneWithoutCommitEvidence(sp);

    const after = JSON.parse(fs.readFileSync(sp, 'utf8'));
    assert.equal(after.exit_reason, null);
    // No other field touched.
    assert.equal(after.current_ticket, 'abc12345');
    assert.equal(after.active, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

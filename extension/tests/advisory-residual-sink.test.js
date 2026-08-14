// @tier: fast
/**
 * WS-C: the advisory worker-gate residual (`gate_skipped`, `worker_gate_not_run` /
 * `worker_gate_target_repo_red`) must land in the jsonl sink `/pickle-metrics`
 * actually reads (`getDataRoot()/activity/*.jsonl`), not in `state.json.activity`
 * — a sink `scanSkipFlagEvents` never scans.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { emitWorkerGateNotRunResidual } from '../bin/mux-runner.js';
import { findResiduals } from './__helpers__/activity-sink.js';

function tmpDataRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-advisory-residual-'));
}

test('emitWorkerGateNotRunResidual writes to activity/*.jsonl, not state.json.activity', () => {
  const dataRoot = tmpDataRoot();
  const prevDataRoot = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-advisory-session-'));
    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ activity: [] }));

    emitWorkerGateNotRunResidual(statePath, 'ticket-abc123', {
      computedVia: 'guardCompletionCommitBeforeDone',
      site: 'guardCompletionCommitBeforeDone',
      verdict: 'not_run',
      reason: 'worker_gate_not_run',
    });

    const residuals = findResiduals({ dataRoot, ticketId: 'ticket-abc123', reason: 'worker_gate_not_run' });
    assert.equal(residuals.length, 1, 'expected exactly one gate_skipped event for ticket-abc123 in the jsonl sink');
    assert.equal(residuals[0].gate_payload.source, 'worker_gate');
    assert.equal(residuals[0].gate_payload.computed_via, 'guardCompletionCommitBeforeDone');

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.deepEqual(state.activity, [], 'state.json.activity must NOT receive the residual');
  } finally {
    if (prevDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prevDataRoot;
  }
});

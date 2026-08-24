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
import {
  scanSkipFlagEvents,
  buildSkipFlagBudgetReport,
  SKIP_FLAG_BUDGETS,
} from '../services/metrics-utils.js';
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
    assert.equal(residuals[0].source, 'worker_gate', 'the owning gate is named by the TOP-LEVEL source');
    assert.equal(residuals[0].gate_payload.computed_via, 'guardCompletionCommitBeforeDone');

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.deepEqual(state.activity, [], 'state.json.activity must NOT receive the residual');
  } finally {
    if (prevDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prevDataRoot;
  }
});

function todayKey() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The sink move (40e07bde) put the residual in the file `/pickle-metrics` reads, but the
 * event still named its gate in `gate_payload.source`. `extractSkipFlagUse` reads the
 * TOP-LEVEL `source` and DEFAULTS an absent one to `'pickle'`, so every use was re-filed
 * under a source that does not own the gate — measured live at 334 uses keyed
 * `pickle::worker_gate_not_run`. Asserting the emitted object alone cannot see that: only
 * running it through the real scanner can. The `pickle` arm is the negative control and is
 * what goes RED against the pre-fix producer.
 */
test('the skip-flag scanner credits worker_gate, never pickle, for the advisory residual', () => {
  const dataRoot = tmpDataRoot();
  const prevDataRoot = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-advisory-session-')), 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ activity: [] }));

    emitWorkerGateNotRunResidual(statePath, 'ticket-abc123', {
      computedVia: 'not_applicable',
      site: 'guardCompletionCommitBeforeDone',
      verdict: 'not_run',
      reason: 'worker_gate_not_run',
    });
    emitWorkerGateNotRunResidual(statePath, 'ticket-def456', {
      computedVia: 'target_repo_gate',
      site: 'tryResumeOrphanReattach',
      verdict: 'red',
      reason: 'worker_gate_target_repo_red',
    });

    const day = todayKey();
    const uses = scanSkipFlagEvents(path.join(dataRoot, 'activity'), day, day);
    assert.equal(uses.length, 2, 'the scanner sees both residuals');
    assert.deepEqual(
      [...new Set(uses.map((u) => u.source))],
      ['worker_gate'],
      'every use is credited to the gate that owns it',
    );
    assert.equal(
      uses.filter((u) => u.source === 'pickle').length,
      0,
      'no residual may be re-filed under the pickle source (the extractSkipFlagUse default)',
    );

    const report = buildSkipFlagBudgetReport(uses, SKIP_FLAG_BUDGETS, day, day);
    for (const reason of ['worker_gate_not_run', 'worker_gate_target_repo_red']) {
      const entry = report.entries.find((e) => e.source === 'worker_gate' && e.reason === reason);
      assert.ok(entry, `budget report includes the worker_gate::${reason} entry`);
      assert.equal(entry.uses, 1);
    }
    assert.equal(
      report.entries.some((e) => e.source === 'pickle'),
      false,
      'the pickle source owns no row built from a worker-gate residual',
    );
  } finally {
    if (prevDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prevDataRoot;
  }
});

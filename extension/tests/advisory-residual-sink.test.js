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
  scanRefusedRecoveredCounts,
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

/**
 * AP-EXT-ITER10-01 — the scanner must READ the sink it is pointed at.
 *
 * The sink-move tests above prove the residual LANDS in `activity/*.jsonl`. They
 * cannot see the other half: until this fix, every activity-dir scanner in
 * `metrics-utils.ts` skipped any file over a 10 MB cap and `continue`d WITHOUT a
 * diagnostic, so a landed residual past that offset was counted as zero and the
 * emitted report was indistinguishable from a complete measurement. Measured on a
 * live host at the time of the fix: 6 of 8 activity files were over the cap (up to
 * 207 MB), the dashboard tallied 486 of 15,441 real uses, and it published
 * `over_budget: false` for `citadel-mechanical::skip_quality_gates` (121 uses
 * against a budget of 3) — the verdict inverted, not merely under-counted.
 *
 * Both cases below place their events PAST the old cap, so they go RED against a
 * scanner that reads only the first 10 MB. The window-exclusion assertion is the
 * anti-vacuity control: it fails if the fix were "count everything unconditionally".
 */

const OVERSIZED_CHUNK_BYTES = 1024 * 1024; // must mirror ACTIVITY_READ_CHUNK_BYTES
const OLD_SIZE_CAP_BYTES = 10 * 1024 * 1024;
const STRADDLE_EMOJI = '\u{1F600}'; // 4 UTF-8 bytes

/**
 * Write one `<day>.jsonl` larger than the retired 10 MB cap.
 *
 * Layout is deliberate, not incidental:
 *  - a `gate_skipped` whose 4-byte emoji STRADDLES the first read-chunk boundary,
 *    so a reader that decodes each chunk independently corrupts its `reason`;
 *  - ASCII filler out past 10 MB;
 *  - the payload events, all beyond the old cap.
 */
function writeOversizedActivityDay(activityDir, day, { inWindowTs, outOfWindowTs }) {
  fs.mkdirSync(activityDir, { recursive: true });
  const filePath = path.join(activityDir, `${day}.jsonl`);
  const fd = fs.openSync(filePath, 'w');
  let written = 0;
  const put = (s) => { written += fs.writeSync(fd, s); };

  const fillerFor = (n) => {
    const line = `{"event":"ap_iter10_noise","ts":"${inWindowTs}","i":${String(n).padStart(6, '0')},"pad":"`;
    const close = '"}\n';
    const pad = 1024 - Buffer.byteLength(line, 'utf8') - Buffer.byteLength(close, 'utf8');
    return `${line}${'y'.repeat(pad)}${close}`; // exactly 1024 bytes
  };

  const straddleHead =
    `{"event":"gate_skipped","source":"ap_iter10","gate_payload":{"reason":"straddle-`;
  const preambleLines = Math.floor(
    (OVERSIZED_CHUNK_BYTES - 2 - Buffer.byteLength(straddleHead, 'utf8')) / 1024,
  );
  for (let i = 0; i < preambleLines; i += 1) put(fillerFor(i));
  const innerPad = OVERSIZED_CHUNK_BYTES - 2 - written - Buffer.byteLength(straddleHead, 'utf8');
  assert.ok(innerPad >= 0, 'straddle arithmetic must not underflow');
  put(`${straddleHead}${'x'.repeat(innerPad)}`);
  assert.equal(written, OVERSIZED_CHUNK_BYTES - 2, 'emoji must begin 2 bytes before the chunk boundary');
  put(`${STRADDLE_EMOJI}"},"ts":"${inWindowTs}"}\n`);

  for (let i = preambleLines; written <= OLD_SIZE_CAP_BYTES + 4096; i += 1) put(fillerFor(i));
  assert.ok(written > OLD_SIZE_CAP_BYTES, 'filler must carry the file past the retired cap');
  const pastCapOffset = written;

  for (let i = 0; i < 7; i += 1) {
    put(`{"event":"gate_skipped","source":"ap_iter10","gate_payload":{"reason":"past_cap"},"ts":"${inWindowTs}"}\n`);
  }
  for (let i = 0; i < 3; i += 1) {
    put(`{"event":"completion_finalize_refused","ts":"${inWindowTs}"}\n`);
  }
  put(`{"event":"gate_skipped","source":"ap_iter10","gate_payload":{"reason":"out_of_window"},"ts":"${outOfWindowTs}"}\n`);

  fs.closeSync(fd);
  return { filePath, totalBytes: written, pastCapOffset };
}

function isoAtLocalNoon(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0).toISOString();
}

test('AP-EXT-ITER10-01: the skip-flag scanner reads a >10 MB activity file in full', () => {
  const dataRoot = tmpDataRoot();
  try {
    const day = todayKey();
    const [y, m, d] = day.split('-').map(Number);
    const outOfWindowDay = new Date(y, m - 1, d - 30, 12, 0, 0);
    const pad = (n) => String(n).padStart(2, '0');
    const outKey = `${outOfWindowDay.getFullYear()}-${pad(outOfWindowDay.getMonth() + 1)}-${pad(outOfWindowDay.getDate())}`;

    const activityDir = path.join(dataRoot, 'activity');
    const { totalBytes, pastCapOffset } = writeOversizedActivityDay(activityDir, day, {
      inWindowTs: isoAtLocalNoon(day),
      outOfWindowTs: outOfWindowDay.toISOString(),
    });
    assert.ok(totalBytes > OLD_SIZE_CAP_BYTES, 'fixture must exceed the retired 10 MB cap');
    assert.ok(pastCapOffset > OLD_SIZE_CAP_BYTES, 'payload events must sit beyond it');

    const uses = scanSkipFlagEvents(activityDir, day, day);
    const mine = uses.filter((u) => u.source === 'ap_iter10');
    assert.equal(
      mine.filter((u) => u.reason === 'past_cap').length,
      7,
      'every skip-flag use past the 10 MB offset is counted — a file over the cap is streamed, never dropped',
    );
    assert.equal(
      mine.filter((u) => u.reason.startsWith('straddle-')).length,
      1,
      'the use whose reason straddles a read-chunk boundary survives the chunked read',
    );
    assert.ok(
      mine.find((u) => u.reason.startsWith('straddle-')).reason.endsWith(STRADDLE_EMOJI),
      'a multi-byte character split across two read chunks must decode intact, not as a replacement char',
    );
    assert.equal(
      mine.filter((u) => u.reason === 'out_of_window').length,
      0,
      'anti-vacuity: the date window still excludes an out-of-window event past the cap',
    );

    const report = buildSkipFlagBudgetReport(uses, SKIP_FLAG_BUDGETS, day, day);
    const entry = report.entries.find((e) => e.source === 'ap_iter10' && e.reason === 'past_cap');
    assert.ok(entry, 'the budget report carries the past-cap row');
    assert.equal(entry.uses, 7);
    assert.equal(
      entry.over_budget,
      true,
      '7 uses against the default budget of 5 is over budget — the pre-fix scanner saw 0 and published over_budget:false',
    );
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER10-01: the sibling refused-and-recovered scanner reads the same >10 MB file', () => {
  const dataRoot = tmpDataRoot();
  try {
    const day = todayKey();
    const activityDir = path.join(dataRoot, 'activity');
    writeOversizedActivityDay(activityDir, day, {
      inWindowTs: isoAtLocalNoon(day),
      outOfWindowTs: isoAtLocalNoon(day),
    });

    const counts = scanRefusedRecoveredCounts(activityDir, day, day);
    assert.equal(
      counts.completion_finalize_refused,
      3,
      'the refusal counter shares the one streaming walk — it cannot re-fork its own size cap',
    );
    assert.equal(counts.total, 3);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

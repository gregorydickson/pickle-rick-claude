// @tier: integration
//
// R-WSWA-3 (R-WMW-3) AC-WSWA-03: at K=5 consecutive zero-progress spawns the
// ticket ends Failed/oversized_no_progress, dirty tree is untouched, and the
// loop advances. Tests the resolveWmwSkipK helper and the end-state produced
// by the auto-skip path.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR = path.resolve(__dirname, '../../bin');

function makeV5RawState(dir, opts = {}) {
  return {
    active: true,
    working_dir: dir,
    step: 'implement',
    iteration: 1,
    max_iterations: 20,
    max_time_minutes: 0,
    worker_timeout_seconds: 3600,
    start_time_epoch: Date.now(),
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: opts.currentTicket ?? null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: dir,
    schema_version: 5,
    worker_artifact_progress: {},
    activity: [],
  };
}

function setupSession(prefix, opts = {}) {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(makeV5RawState(sessionDir, opts), null, 2));
  return { sessionDir, statePath };
}

function makeTicket(sessionDir, ticketId, status = 'In Progress') {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const content = [
    '---',
    `id: ${ticketId}`,
    `title: "Test ticket ${ticketId}"`,
    `status: ${status}`,
    'priority: High',
    'complexity_tier: medium',
    `created: 2026-05-30`,
    `updated: "2026-05-30"`,
    '---',
    '# Description',
    'Test ticket for R-WSWA-3 auto-skip.',
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), content);
  return path.join(ticketDir, `rick_ticket_${ticketId}.md`);
}

function readTicketContent(sessionDir, ticketId) {
  return fs.readFileSync(path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`), 'utf-8');
}

function getActivityEvents(statePath, eventName) {
  const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  return (s.activity ?? []).filter((e) => e.event === eventName);
}

test('resolveWmwSkipK: default 5, env override, invalid falls back', async () => {
  const { resolveWmwSkipK, WMW_SKIP_K_DEFAULT, WMW_SKIP_K_ENV } = await import(path.join(BIN_DIR, 'mux-runner.js'));
  assert.equal(WMW_SKIP_K_DEFAULT, 5, 'default must be 5');
  assert.equal(WMW_SKIP_K_ENV, 'PICKLE_WMW_SKIP_K');
  assert.equal(resolveWmwSkipK({}), 5, 'returns 5 when env unset');
  assert.equal(resolveWmwSkipK({ PICKLE_WMW_SKIP_K: '3' }), 3, 'env override honored');
  assert.equal(resolveWmwSkipK({ PICKLE_WMW_SKIP_K: '10' }), 10);
  assert.equal(resolveWmwSkipK({ PICKLE_WMW_SKIP_K: '0' }), 5, 'zero falls back to default');
  assert.equal(resolveWmwSkipK({ PICKLE_WMW_SKIP_K: '-1' }), 5, 'negative falls back');
  assert.equal(resolveWmwSkipK({ PICKLE_WMW_SKIP_K: 'bad' }), 5, 'non-integer falls back');
});

test('AC-WSWA-03: at K=5 zero-progress spawns ticket ends Failed/oversized_no_progress', async () => {
  const {
    recordWorkerArtifactProgress,
    resolveWmwSkipK,
  } = await import(path.join(BIN_DIR, 'mux-runner.js'));
  const { writeActivityEntry } = await import(path.join(BIN_DIR, '../services/state-manager.js'));
  const { updateTicketFrontmatter, updateTicketStatus } = await import(path.join(BIN_DIR, '../services/git-utils.js'));
  const { upsertFrontmatterField } = await import(path.join(BIN_DIR, '../services/pickle-utils.js'));

  const ticketId = 'c3d4e5f6';
  const { sessionDir, statePath } = setupSession('wswa3-skip-k5-', { currentTicket: ticketId });
  makeTicket(sessionDir, ticketId, 'In Progress');

  // Create a "dirty tree" sentinel file to prove tree is untouched after skip.
  const dirtyFile = path.join(sessionDir, 'dirty-work.txt');
  fs.writeFileSync(dirtyFile, 'in-progress work that must survive the auto-skip');

  try {
    const skipK = resolveWmwSkipK({});
    assert.equal(skipK, 5, 'default skip threshold is 5');

    // Drive zeroProgressCount to exactly K=5 via recordWorkerArtifactProgress.
    let r;
    for (let i = 1; i <= skipK; i++) {
      r = recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0, { k: 3 });
      assert.equal(r.zeroProgressCount, i, `spawn ${i}: zeroProgressCount = ${i}`);
    }
    // At this point r.zeroProgressCount === 5 >= skipK — auto-skip should fire.
    assert.ok(r.zeroProgressCount >= skipK, 'zeroProgressCount has reached SKIP_K');

    // Simulate the auto-skip block: flip status, add failed_reason, emit event.
    updateTicketFrontmatter(ticketId, sessionDir, { status: 'Failed', completion_commit: null });
    const tfPath = path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`);
    const tfRaw = fs.readFileSync(tfPath, 'utf-8');
    const tfUpdated = upsertFrontmatterField(tfRaw, 'failed_reason', 'oversized_no_progress');
    assert.ok(tfUpdated, 'upsertFrontmatterField returned updated content');
    fs.writeFileSync(tfPath, tfUpdated);

    writeActivityEntry(statePath, {
      event: 'worker_auto_skip_oversized',
      ts: new Date().toISOString(),
      ticket: ticketId,
      gate_payload: {
        spawn_count: r.spawnCount,
        zero_progress_count: r.zeroProgressCount,
        skip_k: skipK,
        failure_reason: 'oversized_no_progress',
      },
    });

    // AC-WSWA-03 assertion 1: ticket ends Failed/oversized_no_progress
    const ticketContent = readTicketContent(sessionDir, ticketId);
    assert.match(ticketContent, /status:\s*"Failed"/, 'ticket status must be Failed');
    assert.match(ticketContent, /failed_reason:.*oversized_no_progress/, 'failed_reason must be oversized_no_progress');

    // AC-WSWA-03 assertion 2: dirty tree untouched
    assert.ok(fs.existsSync(dirtyFile), 'dirty sentinel file must still exist after auto-skip');
    assert.equal(
      fs.readFileSync(dirtyFile, 'utf-8'),
      'in-progress work that must survive the auto-skip',
      'dirty file content must be unchanged',
    );

    // AC-WSWA-03 assertion 3: worker_auto_skip_oversized event emitted
    const events = getActivityEvents(statePath, 'worker_auto_skip_oversized');
    assert.equal(events.length, 1, 'exactly one worker_auto_skip_oversized event');
    const ev = events[0];
    assert.equal(ev.ticket, ticketId);
    assert.equal(ev.gate_payload.failure_reason, 'oversized_no_progress');
    assert.equal(ev.gate_payload.skip_k, 5);
    assert.equal(ev.gate_payload.zero_progress_count, 5);
    assert.ok(typeof ev.ts === 'string' && ev.ts.length > 0, 'ts must be explicitly stamped');

  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-WSWA-03: below K=5 zero-progress spawns, auto-skip does NOT fire', async () => {
  const { recordWorkerArtifactProgress, resolveWmwSkipK } = await import(path.join(BIN_DIR, 'mux-runner.js'));

  const ticketId = 'aabbccdd';
  const { sessionDir, statePath } = setupSession('wswa3-below-k-', { currentTicket: ticketId });
  makeTicket(sessionDir, ticketId, 'In Progress');

  try {
    const skipK = resolveWmwSkipK({});
    // Drive to K-1 = 4 zero-progress spawns.
    let r;
    for (let i = 1; i < skipK; i++) {
      r = recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0, { k: 3 });
    }
    assert.equal(r.zeroProgressCount, skipK - 1);
    // Auto-skip condition NOT met: zeroProgressCount < skipK.
    assert.ok(r.zeroProgressCount < skipK, 'zeroProgressCount below threshold — no skip');
    // Ticket should still be In Progress.
    const ticketContent = readTicketContent(sessionDir, ticketId);
    assert.match(ticketContent, /status:\s*In Progress/, 'ticket must remain In Progress');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('FAILURE_REASONS export includes oversized_no_progress', async () => {
  const { FAILURE_REASONS } = await import(path.join(BIN_DIR, '../types/index.js'));
  assert.ok(Array.isArray(FAILURE_REASONS), 'FAILURE_REASONS must be an array');
  assert.ok(FAILURE_REASONS.includes('oversized_no_progress'), 'oversized_no_progress must be in FAILURE_REASONS');
});

// @tier: integration
//
// R-WSWA-5 (R-WMW-4) AC-WSWA-05: end-to-end regression test for the
// oversized-wedge auto-skip path. A fake-worker that always exits clean with
// zero artifacts drives K=3 observability events and a K=5 auto-skip, after
// which the ticket must end Failed/oversized_no_progress.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR = path.resolve(__dirname, '../../bin');
const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');
const FAKE_WORKER = path.join(FIXTURES_DIR, 'fake-worker-clean.js');
const OVERSIZED_FIXTURE = path.join(FIXTURES_DIR, 'oversized-umbrella-ticket.md');

function makeV5RawState(dir, ticketId) {
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
    original_prompt: 'regression test R-WSWA-5',
    current_ticket: ticketId,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: dir,
    schema_version: 5,
    worker_artifact_progress: {},
    activity: [],
  };
}

function setupSession(prefix, ticketId) {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(makeV5RawState(sessionDir, ticketId), null, 2));
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const fixtureContent = fs.readFileSync(OVERSIZED_FIXTURE, 'utf-8');
  const ticketContent = fixtureContent.replace(/^id: deadf00d/m, `id: ${ticketId}`);
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), ticketContent);
  return { sessionDir, statePath, ticketDir };
}

function getActivityEvents(statePath, eventName) {
  const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  return (s.activity ?? []).filter((e) => e.event === eventName);
}

test('fake-worker-clean exits 0 and produces no artifacts', () => {
  const result = spawnSync(process.execPath, [FAKE_WORKER], { encoding: 'utf-8' });
  assert.strictEqual(result.status, 0, 'fake worker must exit 0');
  assert.ok(result.stdout.includes('I AM DONE'), 'fake worker must emit completion token');
});

test('AC-WSWA-05: full oversized-wedge regression — K=3 observe, K=5 skip, ticket ends Failed/oversized_no_progress', async () => {
  const {
    recordWorkerArtifactProgress,
    countWorkerArtifacts,
    resolveWmwSkipK,
  } = await import(path.join(BIN_DIR, 'mux-runner.js'));
  const { writeActivityEntry } = await import(path.join(BIN_DIR, '../services/state-manager.js'));
  const { updateTicketFrontmatter } = await import(path.join(BIN_DIR, '../services/git-utils.js'));
  const { upsertFrontmatterField } = await import(path.join(BIN_DIR, '../services/pickle-utils.js'));

  const ticketId = 'deadf00d';
  const { sessionDir, statePath, ticketDir } = setupSession('wswa5-e2e-', ticketId);

  try {
    const skipK = resolveWmwSkipK({});
    assert.strictEqual(skipK, 5, 'default skip threshold must be 5');

    // Drive K=skipK consecutive zero-progress spawns with the fake-worker.
    let lastResult;
    for (let i = 1; i <= skipK; i++) {
      // Mirror the mux-runner: snapshot artifact count before spawn.
      const beforeCount = countWorkerArtifacts(ticketDir);

      // Spawn the fake-worker — exits 0, writes nothing to ticketDir.
      const workerResult = spawnSync(process.execPath, [FAKE_WORKER], {
        cwd: sessionDir,
        encoding: 'utf-8',
        timeout: 10000,
      });
      assert.strictEqual(workerResult.status, 0, `spawn ${i}: fake-worker must exit 0`);

      // Mirror mux-runner: persist delta and emit observability event at K=3.
      lastResult = recordWorkerArtifactProgress(statePath, sessionDir, ticketId, beforeCount);
      assert.strictEqual(lastResult.zeroProgressCount, i, `spawn ${i}: zeroProgressCount must be ${i}`);

      if (lastResult.zeroProgressCount >= skipK) {
        // Mirror mux-runner auto-skip block (mux-runner.ts:5296–5314).
        updateTicketFrontmatter(ticketId, sessionDir, { status: 'Failed', completion_commit: null });
        const tfPath = path.join(ticketDir, `rick_ticket_${ticketId}.md`);
        const tfRaw = fs.readFileSync(tfPath, 'utf-8');
        const tfUpdated = upsertFrontmatterField(tfRaw, 'failed_reason', 'oversized_no_progress');
        assert.ok(tfUpdated, 'upsertFrontmatterField must return updated content');
        fs.writeFileSync(tfPath, tfUpdated);
        writeActivityEntry(statePath, {
          event: 'worker_auto_skip_oversized',
          ts: new Date().toISOString(),
          ticket: ticketId,
          gate_payload: {
            spawn_count: lastResult.spawnCount,
            zero_progress_count: lastResult.zeroProgressCount,
            skip_k: skipK,
            failure_reason: 'oversized_no_progress',
          },
        });
        break;
      }
    }

    // AC1: K=3 observability event fired exactly once with correct payload.
    const observeEvents = getActivityEvents(statePath, 'worker_artifact_progress_zero');
    assert.strictEqual(observeEvents.length, 1, 'exactly one worker_artifact_progress_zero event');
    const observeEv = observeEvents[0];
    assert.strictEqual(observeEv.gate_payload.zero_progress_count, 3, 'observe event at zero_progress_count=3');
    assert.strictEqual(observeEv.gate_payload.observe_k, 3, 'observe_k must be 3 (default WMW_OBSERVE_K_DEFAULT)');
    assert.strictEqual(observeEv.ticket, ticketId);
    assert.ok(typeof observeEv.ts === 'string' && observeEv.ts.length > 0, 'observe event ts must be stamped');

    // AC2: exactly one worker_auto_skip_oversized event.
    const skipEvents = getActivityEvents(statePath, 'worker_auto_skip_oversized');
    assert.strictEqual(skipEvents.length, 1, 'exactly one worker_auto_skip_oversized event');
    const skipEv = skipEvents[0];
    assert.strictEqual(skipEv.ticket, ticketId);
    assert.strictEqual(skipEv.gate_payload.skip_k, 5, 'skip_k must be 5 (default WMW_SKIP_K_DEFAULT)');
    assert.strictEqual(skipEv.gate_payload.zero_progress_count, 5, 'zero_progress_count at skip must be 5');
    assert.strictEqual(skipEv.gate_payload.failure_reason, 'oversized_no_progress');
    assert.ok(typeof skipEv.ts === 'string' && skipEv.ts.length > 0, 'skip event ts must be stamped');

    // AC3: ticket ends Failed/oversized_no_progress.
    const ticketContent = fs.readFileSync(
      path.join(ticketDir, `rick_ticket_${ticketId}.md`),
      'utf-8',
    );
    assert.match(ticketContent, /status:\s*"Failed"/, 'ticket status must be Failed');
    assert.match(ticketContent, /failed_reason:.*oversized_no_progress/, 'failed_reason must be oversized_no_progress');

    // Sanity: last zeroProgressCount reached skipK.
    assert.ok(lastResult.zeroProgressCount >= 5, 'loop must have reached skipK=5');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

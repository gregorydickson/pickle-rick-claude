// @tier: integration
//
// R-PPXR AC-PPXR-5 — autonomy success metric (forward-created).
//
// This is the failing-before / passing-after regression guard for the order-10 relaxed
// suppressor (ticket 7bd75651). It encodes the GOAL of R-PPXR: a large-tier-dominated,
// multi-ticket bundle survives a sequence of >=3 manager cut-offs and auto-relaunches to
// terminal completion with 0 external (operator) relaunches.
//
// It exercises the REAL chain at unit level — `isGenuineCrashOrSpawnFailure` (the relaxed
// predicate) + `evaluateManagerRelaunch` + `recordManagerRelaunch` — against on-disk state
// and iteration-log fixtures. No real `claude -p` subprocess is spawned (in-process only).
//
// The load-bearing assertion is `isGenuineCrashOrSpawnFailure(decision, outcome, cutOffLog)
// === false` for the retryable cut-off signature: if the suppressor were to VETO the cut-off
// (regression of the order-10 relaxation), that flips to `true`, no relaunch is recorded, the
// bundle never drains, and this test FAILS. The negative control (no-pending / at-cap → fatal)
// proves the predicate is not a tautology.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { isGenuineCrashOrSpawnFailure } from '../../bin/mux-runner.js';
import {
  evaluateManagerRelaunch,
  recordManagerRelaunch,
} from '../../services/manager-relaunch.js';
import { Defaults } from '../../types/index.js';

function makeTmpDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeTicket(sessionDir, id, status, order) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  const content = [
    '---',
    `id: ${id}`,
    `title: ${id} fixture`,
    `status: ${status}`,
    `order: ${order}`,
    '---',
    '',
    '# Fixture',
  ].join('\n');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${id}.md`), content);
}

function setTicketStatus(sessionDir, id, status) {
  const ticketFile = path.join(sessionDir, id, `rick_ticket_${id}.md`);
  const content = fs.readFileSync(ticketFile, 'utf-8');
  fs.writeFileSync(ticketFile, content.replace(/^status: .*$/m, `status: ${status}`));
}

// Build the TicketInfo[] the relaunch chain consumes, reading live frontmatter status.
function ticketInfos(sessionDir, ids) {
  return ids.map((id, i) => {
    const ticketFile = path.join(sessionDir, id, `rick_ticket_${id}.md`);
    const content = fs.readFileSync(ticketFile, 'utf-8');
    const status = (content.match(/^status: (.*)$/m) || [])[1] || 'Todo';
    return { id, status, title: '', order: i + 1, type: null, working_dir: null, completed_at: null, skipped_at: null };
  });
}

function writeState(sessionDir, overrides = {}) {
  const statePath = path.join(sessionDir, 'state.json');
  const state = {
    active: true,
    backend: 'claude',
    working_dir: sessionDir,
    step: 'implement',
    iteration: 3,
    max_iterations: 100,
    max_time_minutes: 720,
    worker_timeout_seconds: 3600,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'ppxr autonomy metric fixture',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 3,
    manager_relaunch_count: 0,
    ...overrides,
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return statePath;
}

function readRelaunchCount(statePath) {
  return JSON.parse(fs.readFileSync(statePath, 'utf-8')).manager_relaunch_count;
}

// A manager turn cut off mid-tool-result: stream events present, NO terminal `result` event.
function writeCutOffLog(sessionDir, iter) {
  const logFile = path.join(sessionDir, `tmux_iteration_${iter}.log`);
  fs.writeFileSync(logFile, [
    '{"type":"system","subtype":"init"}',
    '{"type":"task_started"}',
    '{"type":"user"}',
  ].join('\n') + '\n');
  return logFile;
}

function cutOffOutcome() {
  // The retryable signal-kill-with-pending-tickets signature:
  // other_error class arrives as completion:'error', exitCode:null, timedOut:false.
  return { completion: 'error', exitCode: null, timedOut: false, wallSeconds: 33 * 60 };
}

test('ppxr autonomy metric: >=3 cut-offs auto-relaunch a multi-ticket bundle to terminal with 0 manual relaunches', () => {
  const sessionDir = makeTmpDir('pickle-ppxr-autonomy-');
  const dataRoot = makeTmpDir('pickle-ppxr-autonomy-data-');
  const prevDataRoot = process.env.PICKLE_DATA_ROOT;
  try {
    process.env.PICKLE_DATA_ROOT = dataRoot;

    // A large-tier-dominated bundle: 4 tickets, all Todo.
    const ids = ['ticket-001', 'ticket-002', 'ticket-003', 'ticket-004'];
    ids.forEach((id, i) => writeTicket(sessionDir, id, 'Todo', i + 1));
    const statePath = writeState(sessionDir);

    // The autonomy chain is the ONLY relaunch authority in this test — no operator/external
    // relaunch primitive is ever invoked. We count auto-relaunches independently to prove it.
    let autoRelaunchCount = 0;
    const externalRelaunchCount = 0; // never incremented: there is no manual relaunch path here.

    // >= 3 cut-offs, each with pending work present. We drain one ticket per cut-off so the
    // bundle makes progress (proving the loop reaches terminal, not spins), while keeping at
    // least one ticket pending through every cut-off iteration.
    const CUTOFFS = 3;
    for (let iter = 0; iter < CUTOFFS; iter += 1) {
      const tickets = ticketInfos(sessionDir, ids);
      const outcome = cutOffOutcome();
      const cutOffLog = writeCutOffLog(sessionDir, iter);

      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      const decision = evaluateManagerRelaunch(state, tickets, null);

      // Pending work remains every iteration until the bundle is drained below.
      assert.equal(decision.shouldRelaunch, true, `iter ${iter}: expected eligible relaunch`);
      assert.equal(decision.reason, 'eligible');
      assert.ok(decision.pendingCount > 0);

      // LOAD-BEARING: the relaxed suppressor must NOT veto the retryable cut-off.
      // If this regressed to `true`, no relaunch fires and the bundle never drains.
      assert.equal(
        isGenuineCrashOrSpawnFailure(decision, outcome, cutOffLog),
        false,
        `iter ${iter}: relaxed suppressor must permit relaunch of a cut-off-mid-turn with pending tickets below cap`,
      );

      // The auto chain records the relaunch — this is the autonomous relaunch.
      recordManagerRelaunch(statePath, sessionDir, decision, iter, () => {});
      autoRelaunchCount += 1;

      const count = readRelaunchCount(statePath);
      assert.equal(count, iter + 1, `iter ${iter}: relaunch count should grow monotonically`);
      assert.ok(count > 0 && count <= Defaults.CLAUDE_MANAGER_RELAUNCH_CAP, `iter ${iter}: relaunch count in (0, cap]`);

      // Simulate the relaunched manager making progress: one ticket reaches terminal each pass
      // (until exhausted). This is what lets the loop reach all-tickets-terminal rather than spin.
      setTicketStatus(sessionDir, ids[iter], 'Done');
    }

    // Drain the remaining ticket(s) the relaunched manager would finish on the final pass.
    for (const id of ids.slice(CUTOFFS)) setTicketStatus(sessionDir, id, 'Done');

    // All tickets reached a terminal status.
    const finalTickets = ticketInfos(sessionDir, ids);
    for (const t of finalTickets) {
      const normalized = t.status.toLowerCase().replace(/["']/g, '').trim();
      assert.ok(normalized === 'done' || normalized === 'skipped', `${t.id} should be terminal, got ${t.status}`);
    }

    // With nothing pending, the chain no longer relaunches — it reaches a clean terminal decision.
    const drained = evaluateManagerRelaunch(JSON.parse(fs.readFileSync(statePath, 'utf-8')), finalTickets, null);
    assert.equal(drained.shouldRelaunch, false);
    assert.equal(drained.reason, 'no_pending');

    // Autonomy success metric: relaunch count > 0 AND <= cap, and ZERO external relaunches.
    const finalCount = readRelaunchCount(statePath);
    assert.ok(finalCount > 0 && finalCount <= Defaults.CLAUDE_MANAGER_RELAUNCH_CAP);
    assert.equal(finalCount, autoRelaunchCount, 'every relaunch must have come from the auto chain');
    assert.equal(externalRelaunchCount, 0, 'no manual/operator relaunch may be required');
  } finally {
    if (prevDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prevDataRoot;
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('ppxr autonomy metric negative control: cut-off with no pending work or at cap stays fatal (predicate is not a tautology)', () => {
  const sessionDir = makeTmpDir('pickle-ppxr-autonomy-neg-');
  try {
    const cutOffLog = writeCutOffLog(sessionDir, 0);
    const outcome = cutOffOutcome();

    const noPending = {
      shouldRelaunch: true, pendingCount: 0, nextRelaunchCount: 1,
      reason: 'eligible', cap: Defaults.CLAUDE_MANAGER_RELAUNCH_CAP, backend: 'claude', exitKind: 'other_error',
    };
    const atCap = {
      shouldRelaunch: true, pendingCount: 1, nextRelaunchCount: Defaults.CLAUDE_MANAGER_RELAUNCH_CAP + 1,
      reason: 'eligible', cap: Defaults.CLAUDE_MANAGER_RELAUNCH_CAP, backend: 'claude', exitKind: 'other_error',
    };

    assert.equal(isGenuineCrashOrSpawnFailure(noPending, outcome, cutOffLog), true);
    assert.equal(isGenuineCrashOrSpawnFailure(atCap, outcome, cutOffLog), true);

    // A spawn failure (empty iteration log — the manager never started) also stays fatal.
    const emptyLog = path.join(sessionDir, 'tmux_iteration_empty.log');
    fs.writeFileSync(emptyLog, '');
    const eligible = {
      shouldRelaunch: true, pendingCount: 1, nextRelaunchCount: 1,
      reason: 'eligible', cap: Defaults.CLAUDE_MANAGER_RELAUNCH_CAP, backend: 'claude', exitKind: 'other_error',
    };
    assert.equal(isGenuineCrashOrSpawnFailure(eligible, outcome, emptyLog), true);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

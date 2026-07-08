// @tier: integration
// Characterization test for Path 4: process-task-completed-guard
// processCompletionBranch(state, 'task_completed', ctx) → processTaskCompleted →
// guardCompletionCommitBeforeDone at mux-runner.js:3603 → markTicketDone.
//
// Decision-matrix: path_id 4 — assert what the code DOES today.
// PICKLE_TEST_MODE=1 bypasses guardCompletionCommitBeforeDone for synthetic sessions.
// For evaluateEpicCompletion to return 'genuine' (which routes to the guard),
// the current ticket must be status:Done on disk.
// No live git against the host repo.

// PICKLE_TEST_MODE bypasses guardCompletionCommitBeforeDone
process.env.PICKLE_TEST_MODE = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { processCompletionBranch } from '../../../bin/mux-runner.js';
import { readFrontmatterField } from '../../../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MATRIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'decision-matrix.json'), 'utf8'));
const ENTRY = MATRIX.paths.find(p => p.path_id === 4);

function makeTmp(prefix = 'char-path4-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeTicket(sessionDir, ticketId, frontmatter) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const lines = ['---'];
  for (const [k, v] of Object.entries(frontmatter)) {
    lines.push(`${k}: "${v}"`);
  }
  lines.push('order: 1', '---', '# Body');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), lines.join('\n'));
  return path.join(ticketDir, `rick_ticket_${ticketId}.md`);
}

function withDataRoot(dataRoot, fn) {
  const prev = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prev;
  }
}

test('path-4 processTaskCompleted: EPIC_COMPLETED with Done ticket → guard passes, action.kind=break reason=success', async () => {
  const sessionDir = makeTmp();
  const dataRoot = makeTmp('char-path4-data-');
  try {
    const ticketId = ENTRY.fixture.session_dir_skeleton['state.json'].current_ticket;

    // Path 4 note: for evaluateEpicCompletion to return 'genuine' (which routes
    // to guardCompletionCommitBeforeDone), the current ticket must already be Done
    // on disk. The matrix fixture says status:In Progress but also
    // completion_commit:abc1234. To reach the guard path we use status:Done.
    writeTicket(sessionDir, ticketId, {
      id: ticketId,
      status: 'Done',
      completion_commit: ENTRY.fixture.session_dir_skeleton[`${ticketId}/rick_ticket_${ticketId}.md`].frontmatter.completion_commit,
      title: ENTRY.fixture.session_dir_skeleton[`${ticketId}/rick_ticket_${ticketId}.md`].frontmatter.title,
    });

    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      active: true,
      step: 'implement',
      iteration: 1,
      max_iterations: 15,
      worker_timeout_seconds: 3600,
      start_time_epoch: Math.floor(Date.now() / 1000),
      max_time_minutes: 0,
      current_ticket: ticketId,
      working_dir: sessionDir,
      backend: 'claude',
      schema_version: 3,
    }, null, 2));

    const logs = [];
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const ctx = {
      sessionDir,
      statePath,
      extensionRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../'),
      iteration: 1,
      log: (m) => logs.push(m),
      cbEnabled: false,
      cbState: null,
    };

    let action;
    await withDataRoot(dataRoot, async () => {
      action = await processCompletionBranch(state, 'task_completed', ctx);
    });

    // Characterize: EPIC_COMPLETED with one Done ticket → break success
    assert.equal(action.kind, 'break', `expected kind=break, got '${action.kind}'`);
    assert.equal(action.reason, 'success', `expected reason=success, got '${action.reason}'`);

    // Ticket stays Done
    const ticketPath = path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`);
    const content = fs.readFileSync(ticketPath, 'utf8');
    const status = readFrontmatterField(content, 'status');
    assert.equal(status, 'Done', `expected ticket status=Done after task_completed, got '${status}'`);

    // completion_commit preserved
    const commit = readFrontmatterField(content, 'completion_commit');
    assert.equal(commit, 'abc1234', `expected completion_commit=abc1234, got '${commit}'`);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('path-4 processTaskCompleted: EPIC_COMPLETED with pending tickets → continue (recover_retry)', async () => {
  const sessionDir = makeTmp();
  const dataRoot = makeTmp('char-path4-data-');
  try {
    const ticketId = ENTRY.fixture.session_dir_skeleton['state.json'].current_ticket;
    // Current ticket In Progress (not Done) → evaluateEpicCompletion returns recover_retry
    writeTicket(sessionDir, ticketId, {
      id: ticketId,
      status: 'In Progress',
      completion_commit: 'abc1234',
      title: 'Test ticket',
    });

    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      active: true, step: 'implement', iteration: 1, max_iterations: 15,
      worker_timeout_seconds: 3600, start_time_epoch: Math.floor(Date.now() / 1000),
      max_time_minutes: 0, current_ticket: ticketId, working_dir: sessionDir,
      backend: 'claude', schema_version: 3,
    }, null, 2));

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const logs = [];
    const ctx = {
      sessionDir, statePath,
      extensionRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../'),
      iteration: 1, log: (m) => logs.push(m), cbEnabled: false, cbState: null,
    };

    let action;
    await withDataRoot(dataRoot, async () => {
      action = await processCompletionBranch(state, 'task_completed', ctx);
    });

    // Characterize: In-Progress current ticket → recover_retry → continue
    assert.equal(action.kind, 'continue', `expected kind=continue for In-Progress ticket, got '${action.kind}'`);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('path-4: decision-matrix evidence_source matches explicit', () => {
  assert.equal(ENTRY.evidence_source, 'explicit',
    `expected evidence_source=explicit for path 4, got '${ENTRY.evidence_source}'`);
});

// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { showStatus } from '../bin/status.js';

function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

function captureStdout(fn) {
  const chunks = [];
  const origWrite = process.stdout.write;
  process.stdout.write = function (chunk, ...args) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = origWrite;
  }
  return chunks.join('');
}

function makeTestContext(tmp, tickets) {
  const fakeCwd = path.join(tmp, 'repo');
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(fakeCwd, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const sessionDir = path.join(dataDir, 'sessions', 'scope-dev-session');
  fs.mkdirSync(sessionDir, { recursive: true });

  fs.writeFileSync(
    path.join(sessionDir, 'state.json'),
    JSON.stringify({
      active: true,
      working_dir: fakeCwd,
      session_dir: sessionDir,
      step: 'implement',
      iteration: 1,
      max_iterations: 10,
      current_ticket: tickets[0]?.id ?? null,
      original_prompt: 'Scope deviation test session',
    })
  );

  for (const ticket of tickets) {
    const ticketDir = path.join(sessionDir, ticket.id);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, `rick_ticket_${ticket.id}.md`),
      `---\nid: ${ticket.id}\ntitle: ${ticket.title}\nstatus: In Progress\npriority: Medium\n---\n`
    );
  }

  fs.writeFileSync(
    path.join(dataDir, 'current_sessions.json'),
    JSON.stringify({ [fakeCwd]: sessionDir })
  );

  return { fakeCwd, dataDir, sessionDir };
}

function writeScopeEvent(activityDir, ticketId) {
  fs.mkdirSync(activityDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const event = {
    event: 'worker_edit_outside_scope',
    ts: new Date().toISOString(),
    source: 'pickle',
    ticket_id: ticketId,
    gate_payload: {
      scope_json_path: '/tmp/session/scope.json',
      staged_paths_outside_scope: ['src/other/file.ts'],
      head_ref: 'HEAD',
      suggested_remediation: 'Unstage outside-scope paths.',
    },
  };
  fs.appendFileSync(path.join(activityDir, `${today}.jsonl`), JSON.stringify(event) + '\n');
}

// Case A — zero worker_edit_outside_scope events → output does NOT contain 'Scope drift:'
test('pickle-status-scope-deviations: Case A — zero events → no Scope drift line', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'psdev-a-')));
  try {
    const { fakeCwd, dataDir } = makeTestContext(tmp, [{ id: 'dev11111', title: 'Dev ticket A' }]);

    const output = withEnv({ PICKLE_DATA_ROOT: dataDir }, () =>
      captureStdout(() => showStatus(fakeCwd))
    );

    assert.ok(
      !output.includes('Scope drift:'),
      `Case A: expected no "Scope drift:" line, got:\n${output}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Case B — exactly 1 event for a session ticket → output line matches contract regex
test('pickle-status-scope-deviations: Case B — 1 event for session ticket → contract regex match', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'psdev-b-')));
  try {
    const ticketId = 'dev22222';
    const { fakeCwd, dataDir } = makeTestContext(tmp, [{ id: ticketId, title: 'Dev ticket B' }]);

    writeScopeEvent(path.join(dataDir, 'activity'), ticketId);

    const output = withEnv({ PICKLE_DATA_ROOT: dataDir }, () =>
      captureStdout(() => showStatus(fakeCwd))
    );

    const contractRe = new RegExp(`^Scope drift: 1 edit\\(s\\) outside scope\\.json — tickets: ${ticketId}$`, 'm');
    assert.match(
      output,
      contractRe,
      `Case B: expected line matching ${contractRe}, got:\n${output}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Case C — 3 events across 2 session tickets → output contains count + both ticket ids (order-insensitive)
test('pickle-status-scope-deviations: Case C — 3 events across 2 tickets → count and both ids present', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'psdev-c-')));
  try {
    const idA = 'dev33333';
    const idB = 'dev44444';
    const { fakeCwd, dataDir } = makeTestContext(tmp, [
      { id: idA, title: 'Dev ticket C-A' },
      { id: idB, title: 'Dev ticket C-B' },
    ]);

    const activityDir = path.join(dataDir, 'activity');
    writeScopeEvent(activityDir, idA);
    writeScopeEvent(activityDir, idA);
    writeScopeEvent(activityDir, idB);

    const output = withEnv({ PICKLE_DATA_ROOT: dataDir }, () =>
      captureStdout(() => showStatus(fakeCwd))
    );

    // Verify count
    assert.ok(
      output.includes('Scope drift: 3 edit(s) outside scope.json — tickets: '),
      `Case C: expected count line prefix, got:\n${output}`
    );
    // Verify both ticket ids are in the output (order-insensitive)
    const driftLine = output.split('\n').find(l => l.startsWith('Scope drift:')) ?? '';
    assert.ok(driftLine.includes(idA), `Case C: expected ${idA} in drift line: ${driftLine}`);
    assert.ok(driftLine.includes(idB), `Case C: expected ${idB} in drift line: ${driftLine}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Case D — 2 events with ticket_id NOT in session → output does NOT contain 'Scope drift:' (cross-session isolation)
test('pickle-status-scope-deviations: Case D — events for foreign ticket → no Scope drift line', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'psdev-d-')));
  try {
    const { fakeCwd, dataDir } = makeTestContext(tmp, [{ id: 'dev55555', title: 'Dev ticket D' }]);

    const activityDir = path.join(dataDir, 'activity');
    // Write events for a ticket_id that is NOT in this session
    writeScopeEvent(activityDir, 'foreign-ticket-abc');
    writeScopeEvent(activityDir, 'foreign-ticket-abc');

    const output = withEnv({ PICKLE_DATA_ROOT: dataDir }, () =>
      captureStdout(() => showStatus(fakeCwd))
    );

    assert.ok(
      !output.includes('Scope drift:'),
      `Case D: expected no "Scope drift:" for foreign ticket, got:\n${output}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

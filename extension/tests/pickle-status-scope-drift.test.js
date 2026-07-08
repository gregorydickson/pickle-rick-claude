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

function writeActivityEvent(activityDir, event) {
  fs.mkdirSync(activityDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(
    path.join(activityDir, `${today}.jsonl`),
    JSON.stringify(event) + '\n'
  );
}

// current_sessions.json lives in getDataRoot() (PICKLE_DATA_ROOT), not getExtensionRoot()
// Sessions dir and ticket dirs also live under PICKLE_DATA_ROOT/sessions/
function makeTestContext(tmp, tickets) {
  const fakeCwd = path.join(tmp, 'repo');
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(fakeCwd, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const sessionDir = path.join(dataDir, 'sessions', 'scope-drift-session');
  fs.mkdirSync(sessionDir, { recursive: true });

  fs.writeFileSync(
    path.join(sessionDir, 'state.json'),
    JSON.stringify({
      active: true,
      working_dir: fakeCwd,
      session_dir: sessionDir,
      step: 'implement',
      iteration: 2,
      max_iterations: 10,
      current_ticket: tickets[0]?.id ?? null,
      original_prompt: 'Scope drift test session',
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

  // current_sessions.json lives in dataDir
  fs.writeFileSync(
    path.join(dataDir, 'current_sessions.json'),
    JSON.stringify({ [fakeCwd]: sessionDir })
  );

  return { fakeCwd, dataDir, sessionDir };
}

test('pickle-status-scope-drift: no scope drift events → no "Scope drift" line in output', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-status-drift-')));
  try {
    const { fakeCwd, dataDir } = makeTestContext(tmp, [{ id: 'abc12345', title: 'Test ticket' }]);

    const output = withEnv({ PICKLE_DATA_ROOT: dataDir }, () =>
      captureStdout(() => showStatus(fakeCwd))
    );

    assert.ok(!output.includes('Scope drift:'), `Expected no "Scope drift:" line, got: ${output}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('pickle-status-scope-drift: scope drift events for session tickets → "Scope drift" line in output', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-status-drift-')));
  try {
    const { fakeCwd, dataDir } = makeTestContext(tmp, [{ id: 'abc12345', title: 'Test ticket' }]);

    // Write a scope drift activity event for the session's ticket
    writeActivityEvent(path.join(dataDir, 'activity'), {
      event: 'worker_edit_outside_scope',
      ts: new Date().toISOString(),
      ticket_id: 'abc12345',
      gate_payload: {
        scope_json_path: '/tmp/session/scope.json',
        staged_paths_outside_scope: ['src/unrelated/file.ts'],
        head_ref: 'HEAD',
        suggested_remediation: 'Unstage outside-scope paths.',
      },
    });

    const output = withEnv({ PICKLE_DATA_ROOT: dataDir }, () =>
      captureStdout(() => showStatus(fakeCwd))
    );

    assert.ok(output.includes('Scope drift:'), `Expected "Scope drift:" line, got: ${output}`);
    assert.ok(output.includes('abc12345'), `Expected ticket id in scope drift output, got: ${output}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('pickle-status-scope-drift: scope drift events for OTHER session tickets → not surfaced', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-status-drift-')));
  try {
    const { fakeCwd, dataDir } = makeTestContext(tmp, [{ id: 'myticket1', title: 'My ticket' }]);

    // Write a scope drift event for a DIFFERENT session's ticket
    writeActivityEvent(path.join(dataDir, 'activity'), {
      event: 'worker_edit_outside_scope',
      ts: new Date().toISOString(),
      ticket_id: 'unrelated-ticket-999',
      gate_payload: {
        scope_json_path: '/tmp/other-session/scope.json',
        staged_paths_outside_scope: ['some/other/file.ts'],
        head_ref: 'HEAD',
        suggested_remediation: 'Unstage outside-scope paths.',
      },
    });

    const output = withEnv({ PICKLE_DATA_ROOT: dataDir }, () =>
      captureStdout(() => showStatus(fakeCwd))
    );

    assert.ok(!output.includes('Scope drift:'), `Expected no "Scope drift:" for unrelated ticket, got: ${output}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

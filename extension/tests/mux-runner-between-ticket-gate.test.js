// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runBetweenTicketFastGate, runBetweenTicketFastTests } from '../bin/mux-runner.js';

function makeRoot(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function makeSession(root) {
  const sessionDir = path.join(root, 'session');
  mkdirSync(sessionDir, { recursive: true });
  const statePath = path.join(sessionDir, 'state.json');
  writeFileSync(statePath, JSON.stringify({
    schema_version: 3,
    active: true,
    working_dir: root,
    step: 'implement',
    iteration: 1,
    max_iterations: 10,
    worker_timeout_seconds: 1200,
    start_time_epoch: 0,
    completion_promise: null,
    original_prompt: 'between-ticket gate',
    current_ticket: 'bbbb2222',
    history: [],
    started_at: new Date(0).toISOString(),
    session_dir: sessionDir,
    activity: [],
  }, null, 2));
  mkdirSync(path.join(root, 'extension', 'bin'), { recursive: true });
  writeFileSync(path.join(root, 'extension', 'bin', 'log-watcher.js'), '');
  return { sessionDir, statePath };
}

function makeTicket(sessionDir, id, status) {
  const ticketDir = path.join(sessionDir, id);
  mkdirSync(ticketDir, { recursive: true });
  writeFileSync(path.join(ticketDir, `rick_ticket_${id}.md`), [
    '---',
    `id: ${id}`,
    `title: "Ticket ${id}"`,
    `status: "${status}"`,
    'order: 1',
    '---',
    '',
    '# Body',
  ].join('\n'));
}

function readState(statePath) {
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function withPathPrefix(prefix, fn) {
  const original = process.env.PATH;
  process.env.PATH = `${prefix}${path.delimiter}${original ?? ''}`;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
  }
}

test('mux-runner-between-ticket-gate: Done prior ticket emits cross_ticket_regression_detected and persists state', () => {
  const root = makeRoot('pickle-mux-between-done-');
  try {
    const { sessionDir, statePath } = makeSession(root);
    makeTicket(sessionDir, 'aaaa1111', 'Done');
    makeTicket(sessionDir, 'bbbb2222', 'Todo');

    const result = runBetweenTicketFastGate({
      statePath,
      workingDir: root,
      completedTicketId: 'aaaa1111',
      nextTicketId: 'bbbb2222',
      landedStatus: 'Done',
      log: () => {},
      now: () => 1234,
      runTestFast: () => ({
        ok: false,
        timed_out: false,
        timeout_ms: 240000,
        failures: [{
          name: 'boundary detection fires',
          file: 'extension/tests/mux-runner-between-ticket-gate.test.js',
        }],
      }),
    });

    assert.deepEqual(result, {
      ok: false,
      timed_out: false,
      timeout_ms: 240000,
      failures: [{
        name: 'boundary detection fires',
        file: 'extension/tests/mux-runner-between-ticket-gate.test.js',
      }],
    });

    const state = readState(statePath);
    assert.deepEqual(state.last_between_ticket_gate, {
      ts: 1234,
      ok: false,
      timed_out: false,
      timeout_ms: 240000,
      failures: [{
        name: 'boundary detection fires',
        file: 'extension/tests/mux-runner-between-ticket-gate.test.js',
      }],
    });

    const event = state.activity.find((entry) => entry.event === 'cross_ticket_regression_detected');
    assert.deepEqual(event, {
      event: 'cross_ticket_regression_detected',
      ts: new Date(1234).toISOString(),
      ticket_id: 'bbbb2222',
      prior_ticket_id: 'aaaa1111',
      failing_tests: [{
        name: 'boundary detection fires',
        file: 'extension/tests/mux-runner-between-ticket-gate.test.js',
      }],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mux-runner-between-ticket-gate: Failed prior ticket does not emit cross_ticket_regression_detected', () => {
  const root = makeRoot('pickle-mux-between-failed-');
  try {
    const { sessionDir, statePath } = makeSession(root);
    makeTicket(sessionDir, 'aaaa1111', 'Failed');
    makeTicket(sessionDir, 'bbbb2222', 'Todo');

    runBetweenTicketFastGate({
      statePath,
      workingDir: root,
      completedTicketId: 'aaaa1111',
      nextTicketId: 'bbbb2222',
      landedStatus: 'Failed',
      log: () => {},
      now: () => 5678,
      runTestFast: () => ({
        ok: false,
        timed_out: false,
        timeout_ms: 240000,
        failures: [{
          name: 'no false fire when prior Failed',
          file: 'extension/tests/mux-runner-between-ticket-gate.test.js',
        }],
      }),
    });

    const state = readState(statePath);
    assert.deepEqual(state.last_between_ticket_gate, {
      ts: 5678,
      ok: false,
      timed_out: false,
      timeout_ms: 240000,
      failures: [{
        name: 'no false fire when prior Failed',
        file: 'extension/tests/mux-runner-between-ticket-gate.test.js',
      }],
    });
    assert.equal(
      state.activity.some((entry) => entry.event === 'cross_ticket_regression_detected'),
      false,
      `unexpected cross_ticket_regression_detected in ${JSON.stringify(state.activity)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mux-runner-between-ticket-gate: timeout emits dedicated timeout event and persists timeout metadata', () => {
  const root = makeRoot('pickle-mux-between-timeout-');
  const originalExtensionDir = process.env.EXTENSION_DIR;
  try {
    const { sessionDir, statePath } = makeSession(root);
    makeTicket(sessionDir, 'aaaa1111', 'Done');
    makeTicket(sessionDir, 'bbbb2222', 'Todo');

    writeFileSync(path.join(root, 'pickle_settings.json'), JSON.stringify({
      worker_test_gate_timeout_ms: 50,
    }, null, 2));

    const shimDir = path.join(root, 'bin');
    mkdirSync(shimDir, { recursive: true });
    const npmShim = path.join(shimDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    writeFileSync(
      npmShim,
      process.platform === 'win32'
        ? '@echo off\r\nnode -e "setTimeout(() => {}, 1000)"\r\n'
        : '#!/bin/sh\nnode -e "setTimeout(() => {}, 1000)"\n',
    );
    chmodSync(npmShim, 0o755);

    process.env.EXTENSION_DIR = root;
    const result = withPathPrefix(shimDir, () => runBetweenTicketFastGate({
      statePath,
      workingDir: root,
      completedTicketId: 'aaaa1111',
      nextTicketId: 'bbbb2222',
      landedStatus: 'Done',
      log: () => {},
      now: () => 7777,
      runTestFast: undefined,
    }));

    assert.deepEqual(result, {
      ok: false,
      timed_out: true,
      timeout_ms: 50,
      failures: [{
        name: '__timeout__',
        file: 'npm run test:fast',
      }],
    });

    const state = readState(statePath);
    assert.deepEqual(state.last_between_ticket_gate, {
      ts: 7777,
      ok: false,
      timed_out: true,
      timeout_ms: 50,
      failures: [{
        name: '__timeout__',
        file: 'npm run test:fast',
      }],
    });

    const timeoutEvent = state.activity.find((entry) => entry.event === 'between_ticket_gate_timeout');
    assert.deepEqual(timeoutEvent, {
      event: 'between_ticket_gate_timeout',
      ts: new Date(7777).toISOString(),
      ticket_id: 'bbbb2222',
      prior_ticket_id: 'aaaa1111',
      gate_payload: {
        command: 'npm run test:fast',
        timeout_ms: 50,
      },
    });
  } finally {
    if (originalExtensionDir === undefined) delete process.env.EXTENSION_DIR;
    else process.env.EXTENSION_DIR = originalExtensionDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('mux-runner-between-ticket-gate: runBetweenTicketFastTests returns timeout failure for hanging npm shim', () => {
  const root = makeRoot('pickle-mux-between-fast-timeout-');
  const originalExtensionDir = process.env.EXTENSION_DIR;
  try {
    const extensionDir = path.join(root, 'extension');
    mkdirSync(path.join(extensionDir, 'bin'), { recursive: true });
    writeFileSync(path.join(extensionDir, 'bin', 'log-watcher.js'), '');
    writeFileSync(path.join(root, 'pickle_settings.json'), JSON.stringify({
      worker_test_gate_timeout_ms: 50,
    }, null, 2));

    const shimDir = path.join(root, 'bin');
    mkdirSync(shimDir, { recursive: true });
    const npmShim = path.join(shimDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    writeFileSync(
      npmShim,
      process.platform === 'win32'
        ? '@echo off\r\nnode -e "setTimeout(() => {}, 1000)"\r\n'
        : '#!/bin/sh\nnode -e "setTimeout(() => {}, 1000)"\n',
    );
    chmodSync(npmShim, 0o755);

    process.env.EXTENSION_DIR = root;
    const result = withPathPrefix(shimDir, () => runBetweenTicketFastTests(extensionDir));

    assert.deepEqual(result, {
      ok: false,
      timed_out: true,
      timeout_ms: 50,
      failures: [{
        name: '__timeout__',
        file: 'npm run test:fast',
      }],
    });
  } finally {
    if (originalExtensionDir === undefined) delete process.env.EXTENSION_DIR;
    else process.env.EXTENSION_DIR = originalExtensionDir;
    rmSync(root, { recursive: true, force: true });
  }
});

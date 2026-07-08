// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runBetweenTicketFastGate } from '../bin/mux-runner.js';

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
    original_prompt: 'linear comment on cross-ticket regression',
    current_ticket: 'bbbb2222',
    history: [],
    started_at: new Date(0).toISOString(),
    session_dir: sessionDir,
    activity: [],
  }, null, 2));
  mkdirSync(path.join(root, 'extension'), { recursive: true });
  return { sessionDir, statePath };
}

function makeTicket(sessionDir, id, status, extraFrontmatter = '') {
  const ticketDir = path.join(sessionDir, id);
  mkdirSync(ticketDir, { recursive: true });
  writeFileSync(path.join(ticketDir, `rick_ticket_${id}.md`), [
    '---',
    `id: "${id}"`,
    `title: "Ticket ${id}"`,
    `status: "${status}"`,
    extraFrontmatter.trim(),
    'order: 1',
    '---',
    '',
    '# Body',
  ].filter(Boolean).join('\n'));
}

function writeBridgeScript(dir, eventsPath, mode = 'ok') {
  const script = path.join(dir, `linear-bridge-${mode}.mjs`);
  writeFileSync(script, `#!/usr/bin/env node
import fs from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input);
fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(payload) + '\\n');
if (${JSON.stringify(mode)} === 'fail') {
  process.exit(1);
}
`);
  chmodSync(script, 0o755);
  return script;
}

function withLinearCommand(command, fn) {
  const saved = process.env.PICKLE_LINEAR_COMMAND;
  process.env.PICKLE_LINEAR_COMMAND = command;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.PICKLE_LINEAR_COMMAND;
    else process.env.PICKLE_LINEAR_COMMAND = saved;
  }
}

function readEvents(eventsPath) {
  const raw = readFileSync(eventsPath, 'utf8').trim();
  return raw ? raw.split('\n').map((line) => JSON.parse(line)) : [];
}

test('linear-comment-on-regression: posts Linear comment on prior ticket when regression event fires', { concurrency: false }, () => {
  const root = makeRoot('pickle-linear-comment-success-');
  try {
    const { sessionDir, statePath } = makeSession(root);
    const eventsPath = path.join(root, 'events.jsonl');
    const bridge = writeBridgeScript(root, eventsPath);
    makeTicket(sessionDir, 'aaaa1111', 'Done', [
      'linear_issue_id: "lin-aaaa1111"',
      'linear_issue_key: "PR-1111"',
      'linear_issue_url: "https://linear.local/aaaa1111"',
    ].join('\n'));
    makeTicket(sessionDir, 'bbbb2222', 'Todo');

    withLinearCommand(`${JSON.stringify(process.execPath)} ${JSON.stringify(bridge)}`, () => {
      runBetweenTicketFastGate({
        statePath,
        workingDir: root,
        completedTicketId: 'aaaa1111',
        nextTicketId: 'bbbb2222',
        landedStatus: 'Done',
        log: () => {},
        now: () => 1234,
        runTestFast: () => ({
          ok: false,
          failures: Array.from({ length: 12 }, (_, index) => ({
            name: `failure ${index + 1}`,
            file: `tests/failure-${index + 1}.test.js`,
          })),
        }),
      });
    });

    const events = readEvents(eventsPath);
    assert.equal(events.length, 1);
    assert.equal(events[0].action, 'commentTicket');
    assert.equal(events[0].issue.id, 'lin-aaaa1111');
    assert.match(events[0].comment.body, /Cross-ticket regression detected after ticket aaaa1111 landed\./);
    assert.match(events[0].comment.body, /Regressed ticket: bbbb2222/);
    assert.match(events[0].comment.body, /- failure 10 \(tests\/failure-10\.test\.js\)/);
    assert.doesNotMatch(events[0].comment.body, /failure 11/);
    assert.match(events[0].comment.body, /\.\.\.and 2 more/);
    assert.match(events[0].comment.body, /Full detail: state\.json\.last_between_ticket_gate/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('linear-comment-on-regression: skips comment and logs when prior ticket has no Linear id', { concurrency: false }, () => {
  const root = makeRoot('pickle-linear-comment-skip-');
  try {
    const { sessionDir, statePath } = makeSession(root);
    makeTicket(sessionDir, 'aaaa1111', 'Done');
    makeTicket(sessionDir, 'bbbb2222', 'Todo');
    const logs = [];

    runBetweenTicketFastGate({
      statePath,
      workingDir: root,
      completedTicketId: 'aaaa1111',
      nextTicketId: 'bbbb2222',
      landedStatus: 'Done',
      log: (message) => logs.push(message),
      now: () => 5678,
      runTestFast: () => ({
        ok: false,
        failures: [{
          name: 'boundary detection fires',
          file: 'extension/tests/linear-comment-on-regression.test.js',
        }],
      }),
    });

    assert.ok(logs.includes('linear_comment_skipped: no linear_id for ticket aaaa1111'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('linear-comment-on-regression: bridge failure is logged and does not change gate result', { concurrency: false }, () => {
  const root = makeRoot('pickle-linear-comment-fail-');
  try {
    const { sessionDir, statePath } = makeSession(root);
    const eventsPath = path.join(root, 'events.jsonl');
    const bridge = writeBridgeScript(root, eventsPath, 'fail');
    makeTicket(sessionDir, 'aaaa1111', 'Done', 'linear_issue_id: "lin-aaaa1111"');
    makeTicket(sessionDir, 'bbbb2222', 'Todo');
    const logs = [];

    const result = withLinearCommand(`${JSON.stringify(process.execPath)} ${JSON.stringify(bridge)}`, () => (
      runBetweenTicketFastGate({
        statePath,
        workingDir: root,
        completedTicketId: 'aaaa1111',
        nextTicketId: 'bbbb2222',
        landedStatus: 'Done',
        log: (message) => logs.push(message),
        now: () => 91011,
        runTestFast: () => ({
          ok: false,
          failures: [{
            name: 'bridge failure tolerated',
            file: 'extension/tests/linear-comment-on-regression.test.js',
          }],
        }),
      })
    ));

    assert.deepEqual(result, {
      ok: false,
      failures: [{
        name: 'bridge failure tolerated',
        file: 'extension/tests/linear-comment-on-regression.test.js',
      }],
    });
    assert.equal(readEvents(eventsPath).length, 1);
    assert.ok(logs.some((message) => message.startsWith('linear_comment_failed: ticket aaaa1111:')));

    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(
      state.activity.some((entry) => entry.event === 'cross_ticket_regression_detected'),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

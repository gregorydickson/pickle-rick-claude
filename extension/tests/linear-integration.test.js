// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { syncLinearTicketStatus, emitBundleLinearComments } from '../services/linear-integration.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-linear-'));
}

function writeTicket(sessionDir, id, extraFrontmatter = '') {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  const ticketPath = path.join(ticketDir, `rick_ticket_${id}.md`);
  fs.writeFileSync(ticketPath, [
    '---',
    `id: "${id}"`,
    `title: "Ticket ${id}"`,
    'status: "Todo"',
    extraFrontmatter.trim(),
    '---',
    '# Body',
    '',
  ].filter(Boolean).join('\n'));
  return ticketPath;
}

function writeBridgeScript(dir, eventsPath) {
  const script = path.join(dir, 'linear-bridge.mjs');
  fs.writeFileSync(script, `#!/usr/bin/env node
import fs from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input);
fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(payload) + '\\n');
if (payload.action === 'createTicket') {
  process.stdout.write(JSON.stringify({ id: 'lin-' + payload.ticket.id, key: 'PR-' + payload.ticket.id, url: 'https://linear.local/' + payload.ticket.id }));
}
`);
  fs.chmodSync(script, 0o755);
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
  return fs.readFileSync(eventsPath, 'utf-8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('syncLinearTicketStatus creates a Linear ticket once and mirrors transitions', () => {
  const dir = tmpDir();
  const eventsPath = path.join(dir, 'events.jsonl');
  const bridge = writeBridgeScript(dir, eventsPath);
  const ticketPath = writeTicket(dir, 'abc123');

  try {
    withLinearCommand(bridge, () => {
      syncLinearTicketStatus(dir, 'abc123', 'In Progress');
      syncLinearTicketStatus(dir, 'abc123', 'Done');
    });

    const events = readEvents(eventsPath);
    assert.deepEqual(events.map(event => event.action), ['createTicket', 'transitionTicket', 'transitionTicket']);
    assert.equal(events[0].ticket.id, 'abc123');
    assert.equal(events[1].issue.id, 'lin-abc123');
    assert.equal(events[2].ticket.status, 'Done');

    const content = fs.readFileSync(ticketPath, 'utf-8');
    assert.match(content, /^linear_issue_id: "lin-abc123"$/m);
    assert.match(content, /^linear_issue_key: "PR-abc123"$/m);
    assert.match(content, /^linear_issue_url: "https:\/\/linear\.local\/abc123"$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('syncLinearTicketStatus passes payloads through bridge commands with arguments', () => {
  const dir = tmpDir();
  const eventsPath = path.join(dir, 'events.jsonl');
  const bridge = writeBridgeScript(dir, eventsPath);
  const ticketPath = writeTicket(dir, 'arg1');
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(bridge)}`;

  try {
    withLinearCommand(command, () => {
      syncLinearTicketStatus(dir, 'arg1', 'In Progress');
    });

    const events = readEvents(eventsPath);
    assert.deepEqual(events.map(event => event.action), ['createTicket', 'transitionTicket']);
    assert.equal(events[0].ticket.id, 'arg1');
    assert.match(fs.readFileSync(ticketPath, 'utf-8'), /^linear_issue_id: "lin-arg1"$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('syncLinearTicketStatus is a no-op when the local Linear bridge is not configured', () => {
  const dir = tmpDir();
  const ticketPath = writeTicket(dir, 'noop1');
  const saved = process.env.PICKLE_LINEAR_COMMAND;
  delete process.env.PICKLE_LINEAR_COMMAND;

  try {
    assert.doesNotThrow(() => syncLinearTicketStatus(dir, 'noop1', 'In Progress'));
    const content = fs.readFileSync(ticketPath, 'utf-8');
    assert.doesNotMatch(content, /linear_issue_id:/);
  } finally {
    if (saved !== undefined) process.env.PICKLE_LINEAR_COMMAND = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('emitBundleLinearComments comments once per Linear-backed ticket with session log link', () => {
  const dir = tmpDir();
  const eventsPath = path.join(dir, 'events.jsonl');
  const bridge = writeBridgeScript(dir, eventsPath);
  const ticketPath = writeTicket(dir, 'done1', [
    'linear_issue_id: "lin-done1"',
    'linear_issue_key: "PR-done1"',
    'linear_issue_url: "https://linear.local/done1"',
  ].join('\n'));
  writeTicket(dir, 'plain1');
  const sessionLogPath = path.join(dir, 'pipeline-runner.log');
  fs.writeFileSync(sessionLogPath, 'pipeline log');

  try {
    withLinearCommand(bridge, () => {
      emitBundleLinearComments(dir, sessionLogPath);
      emitBundleLinearComments(dir, sessionLogPath);
    });

    const events = readEvents(eventsPath);
    assert.deepEqual(events.map(event => event.action), ['commentTicket']);
    assert.equal(events[0].issue.id, 'lin-done1');
    assert.match(events[0].comment.body, new RegExp(sessionLogPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(fs.readFileSync(ticketPath, 'utf-8'), /^linear_bundle_comment_at: ".+"$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

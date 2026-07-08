// @tier: fast
/**
 * R-AISLOW — auto-skip-already-Done pre-check in mux-runner iteration loop.
 *
 * AC-BPBH-01: when the next pending ticket at iteration_start is already
 * Done/Skipped, mux-runner MUST advance current_ticket + iteration WITHOUT
 * spawning a claude manager turn (0 spawn calls).
 *
 * Tests:
 *   1. findFirstPendingTicket: Done-top fixture → returns null (no pending ticket left)
 *   2. findFirstPendingTicket: Todo-top fixture → returns the Todo ticket
 *   3. findFirstPendingTicket: mixed fixture (Done first, Todo second) → returns Todo
 *   4. Source-code structural: preskip block emits ticket_preskipped_already_terminal
 *   5. Source-code structural: preskip block uses `continue` to skip runIteration
 *   6. Source-code structural: preskip only fires for done/skipped, not todo/in progress
 *   7. VALID_ACTIVITY_EVENTS contains ticket_preskipped_already_terminal
 *   8. Schema definition exists and has required fields
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_RUNNER_SRC = path.resolve(__dirname, '../src/bin/mux-runner.ts');
const SCHEMA_PATH = path.resolve(__dirname, '../src/types/activity-events.schema.json');

const { findFirstPendingTicket } = await import('../bin/mux-runner.js');
const { VALID_ACTIVITY_EVENTS } = await import('../types/index.js');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function mkTmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-aislow-')));
}

function writeTicket(sessionDir, ticketId, status, order = 1) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const content = [
    '---',
    `id: ${ticketId}`,
    `title: "Ticket ${ticketId}"`,
    `status: "${status}"`,
    `order: ${order}`,
    '---',
    '# Description',
    'Test ticket.',
  ].join('\n');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), content);
}

// ---------------------------------------------------------------------------
// 1. findFirstPendingTicket — all-Done session returns null
// ---------------------------------------------------------------------------

test('aislow-preskip: findFirstPendingTicket returns null when only Done ticket exists', () => {
  const sessionDir = mkTmp();
  try {
    writeTicket(sessionDir, 'abc123', 'Done', 1);
    const result = findFirstPendingTicket(sessionDir);
    assert.strictEqual(result, null, 'All-done session should return null — no pending ticket');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. findFirstPendingTicket — Todo-top session returns the ticket
// ---------------------------------------------------------------------------

test('aislow-preskip: findFirstPendingTicket returns Todo ticket when top ticket is Todo', () => {
  const sessionDir = mkTmp();
  try {
    writeTicket(sessionDir, 'abc123', 'Todo', 1);
    const result = findFirstPendingTicket(sessionDir);
    assert.ok(result !== null, 'Todo session must return a ticket');
    assert.strictEqual(result.id, 'abc123', 'Returned ticket id must match the Todo ticket');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. findFirstPendingTicket — mixed (Done first, Todo second) returns Todo
// ---------------------------------------------------------------------------

test('aislow-preskip: findFirstPendingTicket skips Done and returns first non-terminal ticket', () => {
  const sessionDir = mkTmp();
  try {
    writeTicket(sessionDir, 'aaa000', 'Done', 1);      // order=1, already done
    writeTicket(sessionDir, 'bbb111', 'In Progress', 2); // order=2, pending
    writeTicket(sessionDir, 'ccc222', 'Todo', 3);       // order=3, also pending
    const result = findFirstPendingTicket(sessionDir);
    assert.ok(result !== null, 'Mixed session must return a ticket');
    // bbb111 has order=2, so it should be first pending after aaa000 (Done)
    assert.strictEqual(result.id, 'bbb111', 'First pending after Done must be bbb111 (order=2)');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. findFirstPendingTicket — Skipped ticket is also terminal
// ---------------------------------------------------------------------------

test('aislow-preskip: findFirstPendingTicket skips Skipped ticket and returns next Todo', () => {
  const sessionDir = mkTmp();
  try {
    writeTicket(sessionDir, 'zzz999', 'Skipped', 1);
    writeTicket(sessionDir, 'yyy888', 'Todo', 2);
    const result = findFirstPendingTicket(sessionDir);
    assert.ok(result !== null, 'Must return Todo after Skipped');
    assert.strictEqual(result.id, 'yyy888', 'Must return yyy888 (order=2, Todo)');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Source-code structural: preskip block emits the event
// ---------------------------------------------------------------------------

test('aislow-preskip: mux-runner.ts emits ticket_preskipped_already_terminal event', () => {
  const src = fs.readFileSync(MUX_RUNNER_SRC, 'utf-8');
  assert.ok(
    src.includes("event: 'ticket_preskipped_already_terminal'"),
    "mux-runner.ts must emit event: 'ticket_preskipped_already_terminal'",
  );
});

// ---------------------------------------------------------------------------
// 6. Source-code structural: preskip block uses `continue` to skip runIteration
//    (AC-BPBH-01 — 0 manager spawns on preskip)
// ---------------------------------------------------------------------------

test('aislow-preskip: preskip block uses continue to bypass runIteration (0 spawns)', () => {
  const src = fs.readFileSync(MUX_RUNNER_SRC, 'utf-8');
  // The preskip block must contain a `continue` statement to skip runIteration.
  // Structural check: the continue appears inside the preskip guard block.
  const preskipIdx = src.indexOf('ticket_preskipped_already_terminal');
  assert.notStrictEqual(preskipIdx, -1, 'preskip event emission must be present');

  // Find the `continue` that comes after the preskip event emission
  const afterPreskip = src.slice(preskipIdx);
  const continueInBlock = /continue;/.test(afterPreskip.slice(0, 700));
  assert.ok(
    continueInBlock,
    'preskip block must have a `continue` statement within ~700 chars of the event emission to bypass runIteration',
  );
});

// ---------------------------------------------------------------------------
// 7. Source-code structural: preskip only fires for done/skipped statuses
// ---------------------------------------------------------------------------

test('aislow-preskip: preskip guard checks for done or skipped status explicitly', () => {
  const src = fs.readFileSync(MUX_RUNNER_SRC, 'utf-8');
  // The guard must check preskipStatus === 'done' || preskipStatus === 'skipped'
  assert.ok(
    src.includes("preskipStatus === 'done'") && src.includes("preskipStatus === 'skipped'"),
    "preskip guard must explicitly check for 'done' and 'skipped' statuses",
  );
});

// ---------------------------------------------------------------------------
// 8. VALID_ACTIVITY_EVENTS contains the new event
// ---------------------------------------------------------------------------

test('aislow-preskip: VALID_ACTIVITY_EVENTS includes ticket_preskipped_already_terminal', () => {
  assert.ok(
    VALID_ACTIVITY_EVENTS.includes('ticket_preskipped_already_terminal'),
    'VALID_ACTIVITY_EVENTS must include ticket_preskipped_already_terminal',
  );
});

// ---------------------------------------------------------------------------
// 9. Schema definition exists and has correct required fields
// ---------------------------------------------------------------------------

test('aislow-preskip: activity-events schema has ticket_preskipped_already_terminal definition', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
  const def = schema.definitions['ticket_preskipped_already_terminal'];
  assert.ok(def, 'schema.definitions must include ticket_preskipped_already_terminal');
  assert.ok(Array.isArray(def.required), 'definition must have required array');
  assert.ok(def.required.includes('event'), 'required must include event');
  assert.ok(def.required.includes('ts'), 'required must include ts');
  assert.ok(def.required.includes('ticket_id'), 'required must include ticket_id');
  assert.ok(def.required.includes('gate_payload'), 'required must include gate_payload');
});

// ---------------------------------------------------------------------------
// 10. Schema oneOf includes the event reference (R-PDD-oneOf)
// ---------------------------------------------------------------------------

test('aislow-preskip: schema oneOf includes ticket_preskipped_already_terminal ref (R-PDD-oneOf)', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
  const refs = schema.oneOf.map((o) => o.$ref);
  assert.ok(
    refs.includes('#/definitions/ticket_preskipped_already_terminal'),
    'schema oneOf must reference ticket_preskipped_already_terminal',
  );
});

// ---------------------------------------------------------------------------
// 11. Negative case: findFirstPendingTicket with empty session → returns null
// ---------------------------------------------------------------------------

test('aislow-preskip: findFirstPendingTicket returns null for empty session', () => {
  const sessionDir = mkTmp();
  try {
    const result = findFirstPendingTicket(sessionDir);
    assert.strictEqual(result, null, 'Empty session must return null');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 12. findFirstPendingTicket: exported from mux-runner
// ---------------------------------------------------------------------------

test('aislow-preskip: findFirstPendingTicket is exported from mux-runner', () => {
  assert.strictEqual(
    typeof findFirstPendingTicket,
    'function',
    'findFirstPendingTicket must be an exported function',
  );
});

// @tier: fast
//
// Trap-door conformance test for `ticket_audit_failed` activity event.
// Verifies producer (mux-runner.ts), registry (VALID_ACTIVITY_EVENTS),
// schema (activity-events.schema.json), and analyst prompt
// (spawn-refinement-team.ts:ACTIVITY_EVENT_SCHEMA_SECTION) all agree.
//
// Without this test, a future emitter regression that adds or renames
// fields in `ticket_audit_failed` passes silently because no contract
// covers the event end-to-end.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SCHEMA_PATH = path.join(ROOT, 'src/types/activity-events.schema.json');
const TYPES_PATH = path.join(ROOT, 'src/types/index.ts');
const MUX_RUNNER_PATH = path.join(ROOT, 'src/bin/mux-runner.ts');
const REFINEMENT_PATH = path.join(ROOT, 'src/bin/spawn-refinement-team.ts');

describe('ticket_audit_failed schema conformance', () => {
  it('schema has a definition for ticket_audit_failed', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.ticket_audit_failed;
    assert.ok(def, 'activity-events.schema.json must define ticket_audit_failed');
    assert.equal(def.type, 'object');
    assert.deepEqual(def.required.sort(), ['event', 'ts']);
    assert.equal(def.properties.event.const, 'ticket_audit_failed');
    assert.equal(def.properties.ts.type, 'string');
  });

  it('schema oneOf includes ticket_audit_failed', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const refs = schema.oneOf.map((entry) => entry.$ref);
    assert.ok(
      refs.includes('#/definitions/ticket_audit_failed'),
      'oneOf must reference ticket_audit_failed so payload validation covers it',
    );
  });

  it('VALID_ACTIVITY_EVENTS registers ticket_audit_failed', () => {
    const types = readFileSync(TYPES_PATH, 'utf8');
    assert.ok(
      /['"]ticket_audit_failed['"]/.test(types),
      'src/types/index.ts:VALID_ACTIVITY_EVENTS must list ticket_audit_failed',
    );
  });

  // R-GATE-ADVISORY: the ticket-audit gate is now advisory and no longer EMITS
  // `ticket_audit_failed` (it logs + proceeds instead of halting). The event stays
  // REGISTERED (schema + VALID_ACTIVITY_EVENTS) for now, so the schema/registry
  // conformance above still holds; the emission-presence assertion was removed.
  // (Phase 2 of the gate-overreach subtraction removes the dead event entirely.)

  it('analyst prompt catalog documents ticket_audit_failed', () => {
    const prompt = readFileSync(REFINEMENT_PATH, 'utf8');
    // The catalog is a TS template literal, so backticks are escape-prefixed (\`).
    // Match either form so the test stays valid against compiled JS as well.
    assert.ok(
      /\|\s*\\?`ticket_audit_failed\\?`\s*\|/.test(prompt),
      'spawn-refinement-team.ts:ACTIVITY_EVENT_SCHEMA_SECTION must include a row for ticket_audit_failed',
    );
  });

  it('payload missing ts fails required-field check', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.ticket_audit_failed;
    const broken = { event: 'ticket_audit_failed', session: 'session-1' };
    const missing = def.required.filter((field) => !(field in broken));
    assert.deepEqual(missing, ['ts'], 'schema must reject ticket_audit_failed without ts');
  });

  it('payload with valid shape passes required-field check', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.ticket_audit_failed;
    const valid = { event: 'ticket_audit_failed', ts: new Date().toISOString(), session: 'session-1' };
    for (const field of def.required) {
      assert.ok(field in valid, `valid payload must include ${field}`);
    }
  });
});

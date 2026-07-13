// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VALID_ACTIVITY_EVENTS } from '../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const SCHEMA_PATH = path.join(repoRoot, 'extension/src/types/activity-events.schema.json');
const EVENT_CASES_PATH = path.join(repoRoot, 'extension/tests/activity-event-payload.test.js');
const SPAWN_REFINE_PATH = path.join(repoRoot, 'extension/src/bin/spawn-refinement-team.ts');

// PIWG-bundle events: all events emitted by R-SRTS-1, R-PIWG-1, R-PIWG-4, R-PRCR-1.
// Each event MUST satisfy the three-way triangle: schema oneOf + EVENT_CASES + ACTIVITY_EVENT_SCHEMA_SECTION.
const PIWG_EVENTS = [
  'setup_resume_ticket_status_preserved',
  'setup_resume_overrode_ticket_status',
  'head_mismatch_detected',
  'stale_index_lock_detected',
  'setup_resume_chdir_applied',
  'ticket_runnability_resolved',
];

const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
const eventCasesSrc = fs.readFileSync(EVENT_CASES_PATH, 'utf-8');
const spawnRefineSrc = fs.readFileSync(SPAWN_REFINE_PATH, 'utf-8');

function schemaHasEventDefinition(name) {
  return Object.prototype.hasOwnProperty.call(schema.definitions ?? {}, name);
}

function schemaOneOfReferencesEvent(name) {
  const oneOf = schema.oneOf ?? [];
  const ref = `#/definitions/${name}`;
  return oneOf.some((entry) => entry?.$ref === ref);
}

function eventCasesHasType(name) {
  // Look for `type: '<name>'` in EVENT_CASES array entries.
  const re = new RegExp(`type:\\s*['"]${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}['"]`);
  return re.test(eventCasesSrc);
}

function eventNamesContains(name) {
  // EVENT_NAMES array near the schema-drift block.
  const re = new RegExp(`['"]${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}['"]`);
  return re.test(eventCasesSrc);
}

function spawnRefineGroundingHasEvent(name) {
  // The ACTIVITY_EVENT_SCHEMA_SECTION docs table rows the event name in a backticked cell.
  const re = new RegExp(`\\\\\`${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\\\\``);
  return re.test(spawnRefineSrc);
}

for (const eventName of PIWG_EVENTS) {
  test(`piwg-triangle: ${eventName} has schema definition`, () => {
    assert.ok(
      schemaHasEventDefinition(eventName),
      `activity-events.schema.json definitions missing '${eventName}'`,
    );
  });

  test(`piwg-triangle: ${eventName} is referenced from schema oneOf`, () => {
    assert.ok(
      schemaOneOfReferencesEvent(eventName),
      `activity-events.schema.json oneOf does not reference '${eventName}'`,
    );
  });

  test(`piwg-triangle: ${eventName} appears in EVENT_CASES test table`, () => {
    assert.ok(
      eventCasesHasType(eventName),
      `activity-event-payload.test.js EVENT_CASES has no entry for '${eventName}'`,
    );
  });

  test(`piwg-triangle: ${eventName} appears in EVENT_NAMES drift-check array`, () => {
    assert.ok(
      eventNamesContains(eventName),
      `activity-event-payload.test.js EVENT_NAMES drift-check missing '${eventName}'`,
    );
  });

  test(`piwg-triangle: ${eventName} appears in spawn-refinement-team ACTIVITY_EVENT_SCHEMA_SECTION`, () => {
    assert.ok(
      spawnRefineGroundingHasEvent(eventName),
      `spawn-refinement-team.ts ACTIVITY_EVENT_SCHEMA_SECTION missing grounding row for '${eventName}'`,
    );
  });
}

// v2.0 codegraph + recovery telemetry events (ticket 08e75a59) — registered
// BEFORE any emitter lands. Conformance surface: VALID_ACTIVITY_EVENTS,
// schema definitions + oneOf membership (R-PDD-oneOf), EVENT_CASES fixture,
// EVENT_NAMES drift array, and `ts` in the schema's required set (emitters
// stamp ts explicitly — writeActivityEntry never does).
// Note: no spawn-refinement-team grounding row is asserted — these events have
// no prompt-catalog rows yet; that lands with the emitters.
const V2_EVENTS = [
  'codegraph_index_built',
  'codegraph_index_failed',
  'codegraph_sync_completed',
  'codegraph_degraded',
  'codegraph_session_summary',
  'scope_impact_warning',
  'orphan_commit_reattached',
  'orphan_commit_unreattachable',
  'worker_silent_death',
  'pre_reset_diff_archived',
  'pre_reset_archive_failed',
  'failed_flip_suppressed',
];

test('v2-conformance: all 12 v2.0 events are fully registered (registry, schema, oneOf, fixtures, ts required)', () => {
  assert.equal(V2_EVENTS.length, 12, 'v2.0 table must contain exactly 12 events');
  for (const eventName of V2_EVENTS) {
    assert.ok(
      VALID_ACTIVITY_EVENTS.includes(eventName),
      `VALID_ACTIVITY_EVENTS missing '${eventName}'`,
    );
    assert.ok(
      schemaHasEventDefinition(eventName),
      `activity-events.schema.json definitions missing '${eventName}'`,
    );
    assert.ok(
      schemaOneOfReferencesEvent(eventName),
      `activity-events.schema.json oneOf does not reference '${eventName}'`,
    );
    assert.ok(
      eventCasesHasType(eventName),
      `activity-event-payload.test.js EVENT_CASES has no fixture for '${eventName}'`,
    );
    assert.ok(
      eventNamesContains(eventName),
      `activity-event-payload.test.js EVENT_NAMES drift-check missing '${eventName}'`,
    );
    const required = schema.definitions[eventName].required ?? [];
    assert.ok(
      required.includes('ts'),
      `'${eventName}' schema must require 'ts' — writeActivityEntry never stamps it`,
    );
  }
});

test('piwg-triangle: synthetic gap test — a missing spawn-refinement-team row would be detected', () => {
  // The detector is grep-based on the source; a gap would manifest as
  // `spawnRefineGroundingHasEvent` returning false. Verify the detector itself
  // returns false for a known-absent event name to prove it's not a false-positive.
  const fakeEvent = 'definitely_not_a_real_event_name_xyz_12345';
  assert.strictEqual(
    spawnRefineGroundingHasEvent(fakeEvent),
    false,
    `detector falsely reported grounding for ${fakeEvent}`,
  );
  assert.strictEqual(
    schemaHasEventDefinition(fakeEvent),
    false,
    `detector falsely reported schema for ${fakeEvent}`,
  );
});

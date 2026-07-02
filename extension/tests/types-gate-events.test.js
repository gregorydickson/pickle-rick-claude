// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VALID_ACTIVITY_EVENTS } from '../types/index.js';
import { GATE_REMEDIATION_EVENT_NAMES } from '../services/convergence-gate.js';

const GATE_EVENTS = [
  'between_ticket_gate_timeout',
  'gate_baseline_captured',
  'gate_baseline_disk_check',
  'gate_baseline_init_failed',
  'baseline_recapture_failed',
  'gate_run_complete',
  'gate_skipped',
  'gate_unsafe_test_command_blocked',
  'gate_remediation_complete',
  'gate_remediation_aborted_unverified_production_change',
  'gate_autofix_reverted',
  'gate_workingdir_drift_detected',
  'gate_lock_acquired',
  'gate_lock_timeout',
  'gate_diff_scope_fallback',
  'gate_preexisting_tests_baselined',
  'iteration_left_regression',
  'strict_mode_red',
  'gate_regression_threshold_warning',
  'gate_out_of_scope_failures_present',
];

test('gate-events: all gate/iteration event names are in VALID_ACTIVITY_EVENTS', () => {
  const set = new Set(VALID_ACTIVITY_EVENTS);
  for (const name of GATE_EVENTS) {
    assert.ok(set.has(name), `Missing event: ${name}`);
  }
});

test('gate-events: no collisions with pre-existing 25 events', () => {
  const ORIGINAL_EVENTS = [
    'session_start', 'session_end', 'ticket_completed', 'epic_completed',
    'meeseeks_pass', 'commit', 'research', 'bug_fix', 'feature',
    'refactor', 'review', 'jar_start', 'jar_end',
    'circuit_open', 'circuit_recovery',
    'iteration_start', 'iteration_end',
    'rate_limit_wait', 'rate_limit_resume', 'rate_limit_exhausted',
    'multi_repo_warning', 'pending_tickets_on_completion',
    'manager_false_epic_completed', 'manager_persistent_hallucination',
  ];
  for (const name of GATE_EVENTS) {
    assert.ok(!ORIGINAL_EVENTS.includes(name), `Collision: ${name} was already in original set`);
  }
});

test('gate-events: gate_payload is optional on ActivityEvent (runtime construction)', () => {
  // ActivityEvent is a TS interface — no runtime shape. We validate that
  // a plain object with gate_payload round-trips through JSON without loss.
  const event = {
    ts: new Date().toISOString(),
    event: 'gate_run_complete',
    source: 'pickle',
    gate_payload: { status: 'green', elapsed_ms: 42 },
  };
  const json = JSON.stringify(event);
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed.gate_payload, { status: 'green', elapsed_ms: 42 });
  assert.equal(parsed.event, 'gate_run_complete');
});

test('GATE_REMEDIATION_EVENT_NAMES: all 3 remediation events are in VALID_ACTIVITY_EVENTS', () => {
  const set = new Set(VALID_ACTIVITY_EVENTS);
  for (const name of GATE_REMEDIATION_EVENT_NAMES) {
    assert.ok(set.has(name), `Remediation event missing from VALID_ACTIVITY_EVENTS: ${name}`);
  }
});

const BMAD_TXN_TICKET_OPS_EVENTS = [
  'course_corrected',
  'course_correct_apply_failed',
  'course_correct_recovered',
  'current_ticket_redirected_to_new',
  'readiness_delta_requested',
];

const HALT_EVENTS = ['halt'];

const PIPELINE_OBSERVABILITY_EVENTS = [
  'phase_transition',
  'extension_dir_fallback',
  'child_mux_runner_wedge_detected',
];

const MICROVERSE_RUNNER_EVENTS = ['judge_unreachable', 'judge_timeout', 'judge_measurement_attempted', 'baseline_attempt_timeout', 'baseline_unmeasurable', 'judge_cli_missing'];

test('bmad-events: transaction-ticket-ops + correct-course events are in VALID_ACTIVITY_EVENTS', () => {
  // Per prds/citadel.md:1012, every emitted event MUST appear in VALID_ACTIVITY_EVENTS.
  // These are emitted from src/services/transaction-ticket-ops.ts via state.activity[]
  // (bypassing logActivity()) and would otherwise be invisible to the type system.
  const set = new Set(VALID_ACTIVITY_EVENTS);
  for (const name of BMAD_TXN_TICKET_OPS_EVENTS) {
    assert.ok(set.has(name), `BMAD txn event missing from VALID_ACTIVITY_EVENTS: ${name}`);
  }
});

test('bmad-events: halt event is in VALID_ACTIVITY_EVENTS', () => {
  // Emitted from src/bin/mux-runner.ts:executeTimeoutHalt via writeActivityEntry.
  const set = new Set(VALID_ACTIVITY_EVENTS);
  for (const name of HALT_EVENTS) {
    assert.ok(set.has(name), `Halt event missing from VALID_ACTIVITY_EVENTS: ${name}`);
  }
});

test('pipeline-events: lifecycle/fallback observability events are in VALID_ACTIVITY_EVENTS', () => {
  const set = new Set(VALID_ACTIVITY_EVENTS);
  for (const name of PIPELINE_OBSERVABILITY_EVENTS) {
    assert.ok(set.has(name), `Pipeline event missing from VALID_ACTIVITY_EVENTS: ${name}`);
  }
});

test('microverse-runner-events: judge_unreachable event is in VALID_ACTIVITY_EVENTS', () => {
  const set = new Set(VALID_ACTIVITY_EVENTS);
  for (const name of MICROVERSE_RUNNER_EVENTS) {
    assert.ok(set.has(name), `Microverse runner event missing from VALID_ACTIVITY_EVENTS: ${name}`);
  }
});

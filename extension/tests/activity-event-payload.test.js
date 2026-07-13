// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { VALID_ACTIVITY_EVENTS } from '../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '../src/types/activity-events.schema.json');
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

const BACKEND_ENUM = ['claude', 'codex', 'hermes'];
const BACKEND_RESOLUTION_SOURCE_ENUM = ['state', 'env', 'settings', 'default', 'refinement-lock', 'cli-flag-override'];
const WORKER_BACKEND_RESOLUTION_SOURCE_ENUM = ['worker_backend', 'backend', 'env_lock'];

function resolveRef(ref) {
  const name = ref.replace('#/definitions/', '');
  return schema.definitions[name];
}

function resolveSchema(propSchema) {
  if (propSchema.$ref) return resolveRef(propSchema.$ref);
  return propSchema;
}

function validateAgainstDefinition(payload, def) {
  const required = def.required || [];
  for (const field of required) {
    if (!(field in payload)) {
      return { valid: false, error: `missing required field: ${field}` };
    }
  }
  const props = def.properties || {};
  for (const [field, rawPropSchema] of Object.entries(props)) {
    if (!(field in payload)) continue;
    const propSchema = resolveSchema(rawPropSchema);
    const allowedTypes = Array.isArray(propSchema.type) ? propSchema.type : [propSchema.type].filter(Boolean);
    const value = payload[field];
    if (propSchema.enum) {
      if (!propSchema.enum.includes(value)) {
        return { valid: false, error: `${field} value '${value}' not in enum [${propSchema.enum.join(', ')}]` };
      }
    }
    if (Object.prototype.hasOwnProperty.call(propSchema, 'const')) {
      if (value !== propSchema.const) {
        return { valid: false, error: `${field} must equal ${String(propSchema.const)}` };
      }
    }
    if (allowedTypes.includes('object') && propSchema.required) {
      if (typeof value !== 'object' || value === null) {
        return { valid: false, error: `${field} must be an object` };
      }
      const nested = validateAgainstDefinition(value, propSchema);
      if (!nested.valid) return { valid: false, error: `${field}.${nested.error}` };
    }
    if (allowedTypes.includes('integer') && value !== null) {
      if (!Number.isInteger(value)) {
        return { valid: false, error: `${field} must be an integer` };
      }
    }
    if (allowedTypes.includes('boolean')) {
      if (typeof value !== 'boolean') {
        return { valid: false, error: `${field} must be a boolean` };
      }
    }
    if (allowedTypes.includes('string') && value !== null) {
      if (typeof value !== 'string') {
        return { valid: false, error: `${field} must be a string` };
      }
    }
    if (allowedTypes.includes('array')) {
      if (!Array.isArray(value)) {
        return { valid: false, error: `${field} must be an array` };
      }
      if (propSchema.items?.type === 'string' && value.some((item) => typeof item !== 'string')) {
        return { valid: false, error: `${field} items must be strings` };
      }
    }
  }
  return { valid: true };
}

function validate(payload, defName) {
  const def = schema.definitions[defName];
  if (!def) return { valid: false, error: `no schema definition for '${defName}'` };
  return validateAgainstDefinition(payload, def);
}

const TS = new Date().toISOString();

const EVENT_CASES = [
  // WS4 (b7cc6081): refused-and-recovered counters. The `drop` field proves the
  // required gate_payload contract fails when a required field is absent.
  {
    type: 'completion_finalize_refused',
    valid: {
      event: 'completion_finalize_refused',
      ts: TS,
      gate_payload: { pending_count: 3, ticket_count: 5, seam: 'graduation_halt' },
    },
    drop: 'gate_payload',
  },
  {
    type: 'phase_graduation_refused',
    valid: {
      event: 'phase_graduation_refused',
      ts: TS,
      gate_payload: { pending_count: 2, done_count: 1, exit_code: 0 },
    },
    drop: 'gate_payload',
  },
  {
    type: 'gate_parity_divergence',
    valid: {
      event: 'gate_parity_divergence',
      ts: TS,
      gate_payload: { gate_a: '/repo/extension', gate_b: '/repo/sub/extension', ref: 'tests/x.ts' },
    },
    drop: 'gate_payload',
  },
  // 0b9b2319 (WS-3): bounded opt-in build-phase scope auto-extension event.
  {
    type: 'scope_auto_extended',
    valid: {
      event: 'scope_auto_extended',
      ts: TS,
      session: 'session-1',
      gate_payload: {
        added_paths: ['tests/foo.factory.ts'],
        symbols: ['FooService'],
        cap_hit: false,
      },
    },
    drop: 'gate_payload',
  },
  {
    type: 'worker_spawn_backend_resolved',
    valid: { event: 'worker_spawn_backend_resolved', ts: TS, backend: 'claude', source: 'state', pid: 1234 },
    drop: 'backend',
  },
  {
    type: 'worker_spawn_backend_mismatch',
    valid: {
      event: 'worker_spawn_backend_mismatch',
      ts: TS,
      source: 'settings',
      pid: 1234,
      ticket: 'abc123',
      session: 'session-1',
      resolved_backend: 'claude',
      state_backend: 'codex',
    },
    drop: 'resolved_backend',
  },
  {
    type: 'worker_spawn_backend_override',
    valid: { event: 'worker_spawn_backend_override', ts: TS, backend: 'codex' },
    drop: 'backend',
  },
  {
    type: 'subtool_backend_override',
    valid: { event: 'subtool_backend_override', ts: TS, backend: 'codex' },
    drop: 'backend',
  },
  {
    type: 'worker_backend_resolved',
    valid: { event: 'worker_backend_resolved', ts: TS, backend: 'claude', worker_backend: 'codex', source: 'worker_backend' },
    drop: 'source',
  },
  {
    type: 'signal_received',
    valid: {
      event: 'signal_received',
      ts: TS,
      source: 'pickle',
      session: 'session-1',
      signal: 'SIGTERM',
      pid: 4242,
      ppid: 3131,
      is_tty: false,
      pgid: null,
      active_child_pid: 5252,
      active_child_cmd: 'codex exec worker',
      current_phase: 'implement',
      received_at_iso: TS,
      handler_stack: ['at handleShutdown (mux-runner.js:1:1)'],
      gate_payload: {
        signal_sender_pid: 3131,
        signal_sender_cmd: 'codex-manager --session test',
      },
    },
    drop: 'signal',
  },
  {
    type: 'child_mux_runner_wedge_detected',
    valid: {
      event: 'child_mux_runner_wedge_detected',
      ts: TS,
      session: 'session-1',
      gate_payload: {
        child_pid: 4242,
        last_state_mtime_iso: TS,
        elapsed_seconds: 1860,
      },
    },
    drop: 'gate_payload',
  },
  {
    type: 'tier_phase_skipped',
    valid: {
      event: 'tier_phase_skipped',
      ts: TS,
      ticket_id: 'abc12345',
      tier: 'small',
      skipped_phases: ['test:fast'],
    },
    drop: 'skipped_phases',
  },
  {
    type: 'tier_diff_envelope_exceeded',
    valid: {
      event: 'tier_diff_envelope_exceeded',
      ts: TS,
      ticket_id: 'abc12345',
      tier: 'medium',
      changed_loc: 350,
      envelope: 200,
    },
    drop: 'changed_loc',
  },
  {
    type: 'recoverable_phase_failure',
    valid: {
      event: 'recoverable_phase_failure',
      ts: TS,
      phase: 'pickle',
      exit_code: 1,
      fatal: false,
      reason: 'non-fatal pickle exit, commits present',
      downstream_phases_remaining: ['citadel', 'anatomy-park', 'szechuan-sauce'],
      decision: 'continue',
    },
    drop: 'decision',
  },
  {
    type: 'worker_partial_lifecycle_exit',
    valid: {
      event: 'worker_partial_lifecycle_exit',
      ts: TS,
      ticket: 'abc123',
      gate_payload: { artifacts_missing: ['plan.md', 'research.md'], session_log_size: 0 },
    },
    drop: 'ticket',
  },
  {
    type: 'judge_measurement_attempted',
    valid: {
      event: 'judge_measurement_attempted',
      ts: TS,
      session: 'session-1',
      iteration: 3,
      backend: 'codex',
      judge_backend: 'claude',
      model: 'claude-sonnet-4-6',
      fallback_activated: true,
      spawn_context: 'iteration',
      gate_payload: {
        attempt: 1,
        elapsed_ms: 1500,
        outcome: 'success',
        timeout_class: null,
        probe_kind: 'ok',
      },
    },
    drop: 'judge_backend',
  },
  {
    type: 'cap_check_skipped_stale_cache',
    valid: {
      event: 'cap_check_skipped_stale_cache',
      ts: TS,
      gate_payload: {
        current_ticket: null,
        current_ticket_max_iterations: 10,
        current_ticket_budget_start_iteration: 8,
        current_ticket_tier: 'small',
      },
    },
    drop: 'gate_payload',
  },
  {
    type: 'pipeline_auto_resumed',
    valid: {
      event: 'pipeline_auto_resumed',
      ts: TS,
      gate_payload: { retry_index: 1, ticket_id: 'abc123', session_done_count_at_retry: 3 },
    },
    drop: 'gate_payload',
  },
  {
    type: 'bundle_bootstrap_exemption_applied',
    valid: {
      event: 'bundle_bootstrap_exemption_applied',
      ts: TS,
      gate_payload: { bundle_id: '2026-05-08-mega', skip_quality_gates_reason: 'bundle_bootstrap_mode=2026-05-08-mega' },
    },
    drop: 'gate_payload',
  },
  {
    type: 'ticket_audit_bypassed',
    valid: { event: 'ticket_audit_bypassed', ts: TS, reason: 'operator-approved' },
    drop: 'reason',
  },
  {
    type: 'resolver_indeterminate',
    valid: {
      event: 'resolver_indeterminate',
      ts: TS,
      session: 'session-1',
      gate_payload: { wall_ms: 1234, budget_ms: 120000, phase: 'contract' },
    },
    drop: 'gate_payload',
  },
  {
    type: 'readiness_false_positive_suppressed',
    valid: {
      event: 'readiness_false_positive_suppressed',
      ts: TS,
      session: 'session-1',
      gate_payload: { suppressed_count: 2, suppressed: ['file_path:t1:a/b.ts', 'contract:t2:Foo.bar'] },
    },
    drop: 'gate_payload',
  },
  {
    type: 'ticket_audit_manual_edit',
    valid: { event: 'ticket_audit_manual_edit', ts: TS, gate_payload: { edit_count: 2 } },
    drop: 'gate_payload',
  },
  {
    type: 'smoke_gate_bypassed',
    valid: { event: 'smoke_gate_bypassed', ts: TS, reason: 'testing' },
    drop: 'reason',
  },
  {
    type: 'ac_shape_gate_bypassed',
    valid: { event: 'ac_shape_gate_bypassed', ts: TS, gate_payload: { reason: 'operator: analyst tickets verified correct' } },
    drop: 'gate_payload',
  },
  {
    type: 'tsc_gate_failed',
    valid: {
      event: 'tsc_gate_failed',
      ts: TS,
      reason: 'R-WACT: tsc --noEmit failed with compile_error: error TS2305',
      gate_payload: {
        failure_kind: 'compile_error',
        command: 'git commit -m "broken"',
      },
    },
    drop: 'reason',
  },
  {
    type: 'tsc_gate_override_used',
    valid: {
      event: 'tsc_gate_override_used',
      ts: TS,
      gate_payload: {
        override_reason: 'emergency revert',
        failure_kind: 'compile_error',
        command: 'git commit -m "override"',
      },
    },
    drop: 'gate_payload',
  },
  {
    type: 'tsc_gate_override_consumed',
    valid: {
      event: 'tsc_gate_override_consumed',
      ts: TS,
      gate_payload: {
        override_reason: 'emergency revert',
        command: 'git commit -m "clean"',
      },
    },
    drop: 'gate_payload',
  },
  {
    type: 'tsc_gate_crashed',
    valid: {
      event: 'tsc_gate_crashed',
      ts: TS,
      gate_payload: {
        failure_kind: 'crashed',
        error: 'synthetic crash',
        command: 'git commit -m "crash"',
      },
    },
    drop: 'gate_payload',
  },
  {
    type: 'bundle_2026_05_04_closer_done',
    valid: {
      event: 'bundle_2026_05_04_closer_done',
      ts: TS,
      gate_payload: { release_url: 'https://github.com/example/repo/releases/tag/v1.70.0' },
    },
    drop: 'gate_payload',
  },
  {
    type: 'manager_idle_backoff_engaged',
    valid: {
      event: 'manager_idle_backoff_engaged',
      ts: TS,
      session: 'session-1',
      ticket: 'abc123',
      consecutive_wait_turns: 3,
      last_worker_pid: 1234,
    },
    drop: 'last_worker_pid',
  },
  {
    type: 'manager_idle_backoff_released',
    valid: {
      event: 'manager_idle_backoff_released',
      ts: TS,
      session: 'session-1',
      ticket: 'abc123',
      duration_ms: 60000,
      release_reason: 'fallback_timer',
    },
    drop: 'release_reason',
  },
  {
    type: 'worker_edit_outside_scope',
    valid: {
      event: 'worker_edit_outside_scope',
      ts: TS,
      ticket_id: 'abc12345',
      gate_payload: {
        scope_json_path: '/tmp/session/scope.json',
        staged_paths_outside_scope: ['src/unrelated/file.ts'],
        head_ref: 'HEAD',
        suggested_remediation: 'Unstage outside-scope paths or expand scope.json:allowed_paths before committing.',
      },
    },
    drop: 'gate_payload',
  },
  {
    type: 'manager_turn_progress',
    valid: { event: 'manager_turn_progress', ts: TS, session: 'session-1', ticket_id: 'abc12345' },
    drop: 'ts',
  },
  {
    type: 'time_cap_disabled_default',
    valid: { event: 'time_cap_disabled_default', ts: TS, session: 'session-1', backend: 'claude' },
    drop: 'ts',
  },
  {
    type: 'manager_max_turns_relaunch',
    valid: {
      event: 'manager_max_turns_relaunch',
      ts: TS,
      backend: 'claude',
      relaunch_count: 4,
      cap: 20,
      pending_count: 3,
      last_ticket_seen: '620fea14',
      session: 'session-1',
      iteration: 7,
    },
    drop: 'last_ticket_seen',
  },
  {
    type: 'iteration_classified_at_max_turns',
    valid: {
      event: 'iteration_classified_at_max_turns',
      ts: TS,
      session: 'session-1',
      iteration_num: 3,
      num_turns: 400,
      max_turns: 400,
      wall_seconds: 742.5,
    },
    drop: 'wall_seconds',
  },
  {
    type: 'pipeline_judge_timeout_recovery_attempted',
    valid: {
      event: 'pipeline_judge_timeout_recovery_attempted',
      ts: TS,
      phase: 'anatomy-park',
      fall_through_to_finalize_gate: true,
    },
    drop: 'phase',
  },
  {
    type: 'bundle_preflight_failed',
    valid: {
      event: 'bundle_preflight_failed',
      ts: TS,
      gate_payload: { failed_assertion: 'composes_paths_resolve', reason: 'path not found: prds/foo.md' },
    },
    drop: 'gate_payload',
  },
  {
    type: 'judge_violation_ledger_advanced',
    valid: {
      event: 'judge_violation_ledger_advanced',
      ts: TS,
      gate_payload: { resolved_count: 2, new_count: 1, remaining_count: 5, ledger_size: 8 },
    },
    drop: 'gate_payload',
  },
  {
    type: 'judge_legacy_shape_inferred',
    valid: {
      event: 'judge_legacy_shape_inferred',
      ts: TS,
      gate_payload: { score: 7.5, raw_keys: ['violations', 'score'] },
    },
    drop: 'gate_payload',
  },
  {
    type: 'judge_json_parse_failed',
    valid: {
      event: 'judge_json_parse_failed',
      ts: TS,
      gate_payload: { raw_output_truncated_512: 'Here is my assessment: score 8', parse_error_message: 'Unexpected token H' },
    },
    drop: 'gate_payload',
  },
  {
    type: 'consecutive_no_progress_warning',
    valid: {
      event: 'consecutive_no_progress_warning',
      ts: TS,
      gate_payload: { count: 2, stall_limit: 3, metric_type: 'command' },
    },
    drop: 'gate_payload',
  },
  {
    type: 'monitor_respawn_started',
    valid: {
      event: 'monitor_respawn_started',
      ts: TS,
      gate_payload: { from_phase: 'pickle', to_phase: 'anatomy-park', mode: 'microverse' },
    },
    drop: 'gate_payload',
  },
  {
    type: 'monitor_respawn_failed',
    valid: {
      event: 'monitor_respawn_failed',
      ts: TS,
      gate_payload: { phase: 'anatomy-park', error: 'tmux respawn failed: pane 0 not found' },
    },
    drop: 'gate_payload',
  },
  {
    type: 'monitor_mode_swapped',
    valid: { event: 'monitor_mode_swapped', ts: TS, mode: 'microverse' },
    drop: 'mode',
  },
  {
    type: 'monitor_stderr_rotated',
    valid: {
      event: 'monitor_stderr_rotated',
      ts: TS,
      session: 'session-1',
      pid: 1234,
      bytes_dropped: 4096,
      cap: 65536,
    },
    drop: 'bytes_dropped',
  },
  {
    type: 'setup_resume_ticket_status_preserved',
    valid: {
      event: 'setup_resume_ticket_status_preserved',
      ts: TS,
      ticket_id: 'abc123',
      observed_status: 'Skipped',
      expected_status: 'In Progress',
      reason: 'operator_edit',
    },
    drop: 'ticket_id',
  },
  {
    type: 'setup_resume_overrode_ticket_status',
    valid: {
      event: 'setup_resume_overrode_ticket_status',
      ts: TS,
      ticket_id: 'abc123',
      prior_status: 'Skipped',
      new_status: 'In Progress',
      source: 'force_flag',
    },
    drop: 'ticket_id',
  },
  {
    type: 'head_mismatch_detected',
    valid: {
      event: 'head_mismatch_detected',
      ts: TS,
      session: 'session-1',
      gate_payload: {
        pinned_branch: 'main',
        observed_branch: 'feature/external',
        pinned_sha: 'abc1234abc1234',
        observed_sha: 'def5678def5678',
        detected_at_phase: 'implement',
      },
    },
    drop: 'session',
  },
  {
    type: 'stale_index_lock_cleaned',
    valid: {
      event: 'stale_index_lock_cleaned',
      ts: TS,
      session: 'session-1',
      gate_payload: {
        path: '/tmp/repo/.git/index.lock',
        mtime: TS,
        age_seconds: 12,
      },
    },
    drop: 'session',
  },
  {
    type: 'stale_index_lock_held_by_live_process',
    valid: {
      event: 'stale_index_lock_held_by_live_process',
      ts: TS,
      session: 'session-1',
      gate_payload: {
        path: '/tmp/repo/.git/index.lock',
        mtime: TS,
        age_seconds: 12,
        holder_pid: 4242,
        holder_command: 'git',
      },
    },
    drop: 'session',
  },
  {
    type: 'setup_resume_chdir_applied',
    valid: {
      event: 'setup_resume_chdir_applied',
      ts: TS,
      session: 'session-1',
      gate_payload: {
        from: '/home/user',
        to: '/tmp/repo',
      },
    },
    drop: 'gate_payload',
  },
  {
    type: 'ticket_runnability_resolved',
    valid: {
      event: 'ticket_runnability_resolved',
      ts: TS,
      ticket_id: 'abc12345',
      session: 'session-1',
      gate_payload: {
        frontmatter_status: 'Todo',
        runnable: true,
        reason: 'frontmatter_pending',
      },
    },
    drop: 'ticket_id',
  },
  {
    type: 'codex_manager_self_bootstrap_attempted',
    valid: {
      event: 'codex_manager_self_bootstrap_attempted',
      ts: TS,
      ticket: 'abc12345',
      attempted_argv: ['node', 'spawn-morty.js', '--session', '/tmp/sess'],
      iteration: 3,
      action_taken: 'logged',
    },
    drop: 'action_taken',
  },
  {
    type: 'orphan_test_runner_reaped',
    valid: {
      event: 'orphan_test_runner_reaped',
      ts: TS,
      pid: 4242,
      etime_seconds: 901,
      argv_summary: '/usr/local/bin/node --test /tmp/repo/extension/tests/example.test.js',
    },
    drop: 'argv_summary',
  },
  {
    type: 'orphan_manager_reaped',
    valid: {
      event: 'orphan_manager_reaped',
      ts: TS,
      pid: 5678,
      argv_summary: 'claude -p "..." --session-dir /tmp/session',
    },
    drop: 'argv_summary',
  },
  {
    type: 'worker_orphan_reaped',
    valid: {
      event: 'worker_orphan_reaped',
      ts: TS,
      pid: 7801,
      pgid: 7801,
      etime_seconds: 61234,
      owning_session: '2026-07-01-abc123',
      argv_summary: 'codex exec --dangerously-bypass-approvals-and-sandbox --add-dir /sessions/2026-07-01-abc123/t1 -- x',
    },
    drop: 'owning_session',
  },
  {
    type: 'orphan_session_detected',
    valid: {
      event: 'orphan_session_detected',
      ts: TS,
      orphan_session_path: '/tmp/sessions/2026-05-15-abc/2d9f16d7',
      orphan_started_at: 1747350000,
      parent_session_hash: 'abc12345',
      orphan_pid: 9999,
    },
    drop: 'parent_session_hash',
  },
  {
    type: 'session_map_collision_blocked',
    valid: {
      event: 'session_map_collision_blocked',
      ts: TS,
      existing_session_path: '/tmp/sessions/2026-05-15-abc',
      existing_pid: 1234,
      attempted_session_path: '/tmp/sessions/2026-05-15-def',
      attempted_pid: 5678,
      cwd: '/Users/dev/project',
    },
    drop: 'cwd',
  },
  {
    type: 'anatomy_park_empty_scope_skip',
    valid: {
      event: 'anatomy_park_empty_scope_skip',
      ts: TS,
      session: 'session-1',
      gate_payload: { in_scope_paths: ['docs/foo.md'], discovered_subsystems: ['bin'] },
    },
    drop: 'gate_payload',
  },
  {
    type: 'szechuan_sauce_empty_scope_skip',
    valid: {
      event: 'szechuan_sauce_empty_scope_skip',
      ts: TS,
      session: 'session-1',
      gate_payload: { in_scope_paths: ['docs/foo.md'] },
    },
    drop: 'session',
  },
  {
    type: 'ticket_preskipped_already_terminal',
    valid: {
      event: 'ticket_preskipped_already_terminal',
      ts: TS,
      session: 'session-1',
      iteration: 3,
      ticket_id: 'abc123',
      gate_payload: { frontmatter_status: 'done', next_ticket_id: 'def456' },
    },
    drop: 'ticket_id',
  },
  {
    type: 'worker_artifact_progress_zero',
    valid: {
      event: 'worker_artifact_progress_zero',
      ts: TS,
      ticket: 'abc12345',
      gate_payload: {
        spawn_count: 3,
        last_artifact_count: 2,
        zero_progress_count: 3,
        observe_k: 3,
      },
    },
    drop: 'gate_payload',
  },
  {
    type: 'worker_auto_skip_oversized',
    valid: {
      event: 'worker_auto_skip_oversized',
      ts: TS,
      ticket: 'abc12345',
      gate_payload: {
        spawn_count: 5,
        zero_progress_count: 5,
        skip_k: 5,
        failure_reason: 'oversized_no_progress',
      },
    },
    drop: 'gate_payload',
  },
  {
    type: 'worker_gate_verdict_fail_closed',
    valid: {
      event: 'worker_gate_verdict_fail_closed',
      ts: TS,
      ticket_id: 'abc12345',
      gate_payload: { verdict: 'red', computed_via: 'worker_gate' },
    },
    drop: 'gate_payload',
  },
  {
    type: 'orphan_phantom_demoted',
    valid: { event: 'orphan_phantom_demoted', ts: TS },
    drop: 'ts',
  },
  {
    type: 'pickle_command_deprecated',
    valid: { event: 'pickle_command_deprecated', ts: TS },
    drop: 'ts',
  },
  {
    type: 'worker_mcp_config_resolved',
    valid: {
      event: 'worker_mcp_config_resolved',
      ts: TS,
      gate_payload: { mcp_config_path: '/ops/mcp.json', precedence_layer: 'settings_override' },
    },
    drop: 'gate_payload',
  },
  {
    type: 'worker_head_regression_detected',
    valid: {
      event: 'worker_head_regression_detected',
      ts: TS,
      ticket: 'abc12345',
      session: 'session-1',
      gate_payload: {
        start_commit: 'abc1234',
        current_head_sha: 'abc1234',
        orphan_tip_sha: 'def5678',
        action: 'ff_reattached',
      },
    },
    drop: 'gate_payload',
  },
  // v2.0 codegraph + recovery telemetry events. `writeActivityEntry` never
  // stamps `ts`, so every fixture whose payload contract declares `ts`
  // drops it to prove the schema requires it.
  {
    type: 'codegraph_index_built',
    valid: {
      event: 'codegraph_index_built',
      ts: TS,
      session: 'session-1',
      gate_payload: { files_indexed: 412, duration_ms: 1830 },
    },
    drop: 'ts',
  },
  {
    type: 'codegraph_index_failed',
    valid: {
      event: 'codegraph_index_failed',
      ts: TS,
      session: 'session-1',
      error: 'index build crashed: ENOSPC',
      gate_payload: { error: 'index build crashed: ENOSPC', duration_ms: 95 },
    },
    drop: 'ts',
  },
  {
    type: 'codegraph_sync_completed',
    valid: {
      event: 'codegraph_sync_completed',
      ts: TS,
      session: 'session-1',
      gate_payload: { files_changed: 7, duration_ms: 210 },
    },
    drop: 'ts',
  },
  {
    type: 'codegraph_degraded',
    valid: {
      event: 'codegraph_degraded',
      ts: TS,
      session: 'session-1',
      reason: 'index stale beyond threshold',
      gate_payload: { operation: 'impact_analysis', fallback: 'grep' },
    },
    drop: 'ts',
  },
  {
    type: 'codegraph_session_summary',
    valid: {
      event: 'codegraph_session_summary',
      ts: TS,
      session: 'session-1',
      tickets: 12,
      degraded_ops: 2,
      index_status: 'degraded',
      injected: 5,
      skipped: 3,
    },
    drop: 'ts',
  },
  {
    type: 'codegraph_context_injected',
    valid: {
      event: 'codegraph_context_injected',
      ts: TS,
      ticket: 'abc12345',
      tier: 'medium',
      terms_count: 4,
      hits_count: 7,
      bytes: 812,
      build_ms: 13,
    },
    drop: 'ts',
  },
  {
    type: 'codegraph_context_skipped',
    valid: {
      event: 'codegraph_context_skipped',
      ts: TS,
      reason: 'zero_hits',
    },
    drop: 'reason',
  },
  {
    type: 'codegraph_efficacy_sample',
    valid: {
      event: 'codegraph_efficacy_sample',
      ts: TS,
      ticket: 'abc12345',
      with_codegraph: true,
      hallucinated_ref_count: 2,
      consumer_file_jaccard: 0.5,
      gate_pass: true,
    },
    drop: 'ts',
  },
  {
    type: 'scope_impact_warning',
    valid: {
      event: 'scope_impact_warning',
      ts: TS,
      ticket: 'abc12345',
      staged_paths: ['extension/src/services/scope-resolver.ts'],
      transitive_dependents_outside_scope: ['extension/src/bin/check-readiness.ts'],
      radius_depth: 2,
    },
    drop: 'staged_paths',
  },
  {
    type: 'orphan_commit_reattached',
    valid: {
      event: 'orphan_commit_reattached',
      ts: TS,
      ticket: 'abc12345',
      sha: 'def5678def5678',
      prev_head: 'abc1234abc1234',
      chain_length: 2,
    },
    drop: 'ts',
  },
  {
    type: 'orphan_commit_unreattachable',
    valid: {
      event: 'orphan_commit_unreattachable',
      ts: TS,
      ticket: 'abc12345',
      sha: 'def5678def5678',
      prev_head: 'abc1234abc1234',
      reason: 'diverged: ff-only reattach not possible',
    },
    drop: 'sha',
  },
  {
    type: 'worker_silent_death',
    valid: {
      event: 'worker_silent_death',
      ts: TS,
      ticket: 'abc12345',
      pid: null,
      log_path: '/tmp/session/abc12345/worker_session_4242.log',
      sub_class: 'log_empty',
      respawn_attempt: 1,
    },
    drop: 'ts',
  },
  {
    type: 'worker_produced_nothing',
    valid: {
      event: 'worker_produced_nothing',
      ts: TS,
      ticket: 'abc12345',
      gate_payload: { spawn_pid: null, session_log_bytes: 0, artifact_delta: 0 },
    },
    drop: 'gate_payload',
  },
  {
    // AC-WMFF-2C: full discriminator payload — capped paths + explicit ts.
    type: 'worker_produced_everything_but_commit',
    valid: {
      event: 'worker_produced_everything_but_commit',
      ts: TS,
      ticket: 'abc12345',
      gate_payload: {
        tier: 'large',
        prefixes_checked: ['research', 'research_review', 'plan', 'plan_review', 'conformance', 'code_review'],
        session_log_bytes: 4096,
        worker_gate_verdict: 'green',
        dirty_in_scope_paths: ['extension/src/bin/mux-runner.ts'],
        truncated: false,
        total_count: 1,
        window_commit: null,
      },
    },
    drop: 'gate_payload',
  },
  {
    type: 'boundary_commit_resolved',
    valid: {
      event: 'boundary_commit_resolved',
      ts: TS,
      ticket: 'abc12345',
      gate_payload: { outcome: 'committed', pre_iter_sha: 'aaaa1111', post_iter_sha: 'bbbb2222' },
    },
    drop: 'gate_payload',
  },
  {
    type: 'pre_reset_diff_archived',
    valid: {
      event: 'pre_reset_diff_archived',
      ts: TS,
      ticket: 'abc12345',
      patch_path: '/tmp/session/archive/pre-reset-abc12345.patch',
      files: ['extension/src/bin/mux-runner.ts'],
      files_truncated: false,
      reason: 'pre_reset',
    },
    drop: 'ts',
  },
  {
    type: 'pre_reset_archive_failed',
    valid: {
      event: 'pre_reset_archive_failed',
      ts: TS,
      ticket: null,
      patch_path: '/tmp/session/archive/pre-reset-unknown.patch',
      reason: 'silent_death',
      error: 'git diff exited 128',
    },
    drop: 'ts',
  },
  {
    type: 'failed_flip_suppressed',
    valid: {
      event: 'failed_flip_suppressed',
      ts: TS,
      ticket: 'abc12345',
      evidence: 'both',
      suppression_count: 1,
    },
    drop: 'ts',
  },
];

// B-RRH ed840487 (data-flow audit): the C3 signal-teardown arm returns a new
// FailedFlipEvidenceKind 'signal_committed' (mux-runner.ts detectFailedFlipEvidence),
// emitted in the failed_flip_suppressed payload. The schema enum MUST accept it or a
// real C3 suppression writes a schema-non-conformant JSONL line.
test('activity-event-payload: failed_flip_suppressed accepts signal_committed evidence (B-RRH C3)', () => {
  const result = validate(
    { event: 'failed_flip_suppressed', ts: TS, ticket: 'abc12345', evidence: 'signal_committed', suppression_count: 1 },
    'failed_flip_suppressed',
  );
  assert.equal(result.valid, true, `signal_committed must be a valid evidence value: ${result.error}`);
});

test('activity-event-payload: failed_flip_suppressed rejects unknown evidence value', () => {
  const result = validate(
    { event: 'failed_flip_suppressed', ts: TS, ticket: 'abc12345', evidence: 'made_up', suppression_count: 1 },
    'failed_flip_suppressed',
  );
  assert.equal(result.valid, false, 'an evidence value outside the enum must fail');
});

for (const { type, valid, drop } of EVENT_CASES) {
  test(`activity-event-payload: ${type} valid payload passes required-field check`, () => {
    const result = validate(valid, type);
    assert.equal(result.valid, true, `${type}: ${result.error}`);
  });

  test(`activity-event-payload: ${type} payload missing '${drop}' fails required-field check`, () => {
    const broken = { ...valid };
    delete broken[drop];
    const result = validate(broken, type);
    assert.equal(result.valid, false, `${type}: expected failure when '${drop}' is absent`);
  });
}

test('activity-event-payload: recoverable_phase_failure registered in VALID_ACTIVITY_EVENTS', () => {
  assert.ok(
    VALID_ACTIVITY_EVENTS.includes('recoverable_phase_failure'),
    'recoverable_phase_failure must be present in VALID_ACTIVITY_EVENTS',
  );
});

test('activity-event-payload: tier_phase_skipped registered in VALID_ACTIVITY_EVENTS', () => {
  assert.ok(
    VALID_ACTIVITY_EVENTS.includes('tier_phase_skipped'),
    'tier_phase_skipped must be present in VALID_ACTIVITY_EVENTS',
  );
});

test('activity-event-payload: recoverable_phase_failure schema enforces contract fields', () => {
  const good = validate({
    event: 'recoverable_phase_failure',
    ts: TS,
    phase: 'anatomy-park',
    exit_code: 1,
    fatal: false,
    reason: 'non-fatal anatomy-park exit, exit_reason=judge_timeout',
    downstream_phases_remaining: ['szechuan-sauce'],
    decision: 'continue',
  }, 'recoverable_phase_failure');
  assert.equal(good.valid, true, good.error);

  const bad = validate({
    event: 'recoverable_phase_failure',
    ts: TS,
    phase: 'anatomy-park',
    exit_code: '1',
    fatal: true,
    reason: 'bad',
    downstream_phases_remaining: ['szechuan-sauce', 2],
    decision: 'resume',
  }, 'recoverable_phase_failure');
  assert.equal(bad.valid, false, 'invalid exit_code/fatal/downstream_phases_remaining/decision should fail');
});

// worker_spawn_backend_resolved specific: source enum-of-six and backend enum-of-three
test('activity-event-payload: worker_spawn_backend_resolved source must be one of six BackendResolutionSource values', () => {
  const base = { event: 'worker_spawn_backend_resolved', ts: TS, backend: 'claude', pid: 4567 };
  for (const src of BACKEND_RESOLUTION_SOURCE_ENUM) {
    const result = validate({ ...base, source: src }, 'worker_spawn_backend_resolved');
    assert.equal(result.valid, true, `source '${src}' should be valid`);
  }
  const bad = validate({ ...base, source: 'unknown-source' }, 'worker_spawn_backend_resolved');
  assert.equal(bad.valid, false, `source 'unknown-source' should be rejected`);
});

test('activity-event-payload: worker_spawn_backend_resolved backend must be one of three Backend values', () => {
  const base = { event: 'worker_spawn_backend_resolved', ts: TS, source: 'state', pid: 4567 };
  for (const be of BACKEND_ENUM) {
    const result = validate({ ...base, backend: be }, 'worker_spawn_backend_resolved');
    assert.equal(result.valid, true, `backend '${be}' should be valid`);
  }
  const bad = validate({ ...base, backend: 'gpt-5' }, 'worker_spawn_backend_resolved');
  assert.equal(bad.valid, false, `backend 'gpt-5' should be rejected`);
});

test('activity-event-payload: worker_spawn_backend_resolved pid must be an integer', () => {
  const base = { event: 'worker_spawn_backend_resolved', ts: TS, backend: 'claude', source: 'state' };
  const good = validate({ ...base, pid: 9999 }, 'worker_spawn_backend_resolved');
  assert.equal(good.valid, true, 'integer pid should pass');
  const bad = validate({ ...base, pid: 3.14 }, 'worker_spawn_backend_resolved');
  assert.equal(bad.valid, false, 'float pid should fail');
  const bad2 = validate({ ...base, pid: '1234' }, 'worker_spawn_backend_resolved');
  assert.equal(bad2.valid, false, 'string pid should fail');
});

test('activity-event-payload: worker_backend_resolved source must be one of three worker-backend precedence values', () => {
  const base = { event: 'worker_backend_resolved', ts: TS, backend: 'claude', worker_backend: 'codex' };
  for (const src of WORKER_BACKEND_RESOLUTION_SOURCE_ENUM) {
    const result = validate({ ...base, source: src }, 'worker_backend_resolved');
    assert.equal(result.valid, true, `source '${src}' should be valid`);
  }
  const bad = validate({ ...base, source: 'state' }, 'worker_backend_resolved');
  assert.equal(bad.valid, false, `source 'state' should be rejected`);
});

test('activity-event-payload: worker_lint_gate_failed requires integer error counts and file_list', () => {
  const good = validate({
    event: 'worker_lint_gate_failed',
    ts: TS,
    ticket_id: 'abc12345',
    lint_errors: 2,
    tsc_errors: 1,
    file_list: ['extension/src/bin/spawn-morty.ts'],
  }, 'worker_lint_gate_failed');
  assert.equal(good.valid, true, 'valid lint gate failure payload should pass');

  const bad = validate({
    event: 'worker_lint_gate_failed',
    ts: TS,
    ticket_id: 'abc12345',
    lint_errors: '2',
    tsc_errors: 1,
    file_list: ['extension/src/bin/spawn-morty.ts'],
  }, 'worker_lint_gate_failed');
  assert.equal(bad.valid, false, 'string lint_errors should fail');
});

test('activity-event-payload: worker_gate_failed requires structured failures and retry_count', () => {
  const good = validate({
    event: 'worker_gate_failed',
    ts: TS,
    ticket_id: 'abc12345',
    gate_phase: 'test:integration',
    failures: [{
      name: 'worker integration tier fails',
      file: 'tests/integration-fixture.test.js',
      message: 'integration boom',
    }],
    retry_count: 1,
  }, 'worker_gate_failed');
  assert.equal(good.valid, true, 'valid worker gate failure payload should pass');

  const bad = validate({
    event: 'worker_gate_failed',
    ts: TS,
    ticket_id: 'abc12345',
    gate_phase: 'deploy',
    failures: [{
      name: 'worker fast tier fails',
      file: 'tests/worker-fixture.test.js',
      message: 'boom',
    }],
    retry_count: '1',
  }, 'worker_gate_failed');
  assert.equal(bad.valid, false, 'invalid gate_phase and string retry_count should fail');
});

test('activity-event-payload: cross_ticket_regression_detected requires prior_ticket_id and failing_tests', () => {
  const good = validate({
    event: 'cross_ticket_regression_detected',
    ts: TS,
    ticket_id: 'bbbb2222',
    prior_ticket_id: 'aaaa1111',
    failing_tests: [{
      name: 'boundary detection fires',
      file: 'extension/tests/mux-runner-between-ticket-gate.test.js',
    }],
  }, 'cross_ticket_regression_detected');
  assert.equal(good.valid, true, 'valid cross-ticket regression payload should pass');

  const bad = validate({
    event: 'cross_ticket_regression_detected',
    ts: TS,
    ticket_id: 'bbbb2222',
    failing_tests: [{
      name: 'boundary detection fires',
      file: 'extension/tests/mux-runner-between-ticket-gate.test.js',
    }],
  }, 'cross_ticket_regression_detected');
  assert.equal(bad.valid, false, 'missing prior_ticket_id should fail');
});

const SHARED_ENUM_DEFS = new Set([
  'backendEnum',
  'backendResolutionSourceEnum',
  'workerBackendResolutionSourceEnum',
]);

test('activity-event-payload: schema defines all registered event type definitions', () => {
  const EVENT_NAMES = [
    'worker_spawn_backend_resolved',
    'worker_spawn_backend_mismatch',
    'worker_spawn_backend_override',
    'subtool_backend_override',
    'worker_partial_lifecycle_exit',
    'signal_received',
    'judge_measurement_attempted',
    'baseline_attempt_timeout',
    'cap_check_skipped_stale_cache',
    'pipeline_auto_resumed',
    'bundle_bootstrap_exemption_applied',
    'ticket_audit_bypassed',
    'resolver_indeterminate',
    'readiness_false_positive_suppressed',
    'ticket_audit_manual_edit',
    'smoke_gate_bypassed',
    'ac_shape_gate_bypassed',
    'tsc_gate_failed',
    'tsc_gate_override_used',
    'tsc_gate_override_consumed',
    'tsc_gate_crashed',
    'bundle_2026_05_04_closer_done',
    'install_sh_parity_check',
    'install_sh_override_used',
    'worker_backend_resolved',
    'completion_commit_auto_filled',
    'completion_commit_inferred_from_git',
    'phantom_done_detected',
    'worker_lint_gate_passed',
    'tier_phase_skipped',
    'tier_diff_envelope_exceeded',
    'between_ticket_gate_timeout',
    'mux_runner_stall_detected',
    'mux_idle_stall_detected',
    'cross_ticket_regression_detected',
    'worker_gate_failed',
    'worker_gate_verdict_fail_closed',
    'worker_lint_gate_failed',
    'worker_lint_autofix_applied',
    'worker_completion_commit_announced',
    'recoverable_phase_failure',
    'time_cap_disabled_default',
    'manager_turn_progress',
    'manager_max_turns_relaunch',
    'iteration_classified_at_max_turns',
    'manager_idle_backoff_engaged',
    'manager_idle_backoff_released',
    'standup_session_dropped',
    'worker_edit_outside_scope',
    'pkgjson_revert_forensic_captured',
    'pipeline_judge_timeout_recovery_attempted',
    'bundle_preflight_failed',
    'consecutive_no_progress_warning',
    'judge_violation_ledger_advanced',
    'judge_legacy_shape_inferred',
    'judge_json_parse_failed',
    'child_mux_runner_wedge_detected',
    'monitor_respawn_started',
    'monitor_respawn_failed',
    'monitor_mode_swapped',
    'monitor_stderr_rotated',
    'setup_resume_ticket_status_preserved',
    'setup_resume_overrode_ticket_status',
    'head_mismatch_detected',
    'stale_index_lock_cleaned',
    'stale_index_lock_held_by_live_process',
    'setup_resume_chdir_applied',
    'ticket_runnability_resolved',
    'codex_manager_self_bootstrap_attempted',
    'orphan_test_runner_reaped',
    'orphan_manager_reaped',
    'worker_orphan_reaped',
    'orphan_session_detected',
    'session_map_collision_blocked',
    'state_write_override_used',
    'state_write_schema_version_violation',
    'anatomy_park_empty_scope_skip',
    'szechuan_sauce_empty_scope_skip',
    'pipeline_all_backends_exhausted_recovery_attempted',
    'monitor_respawn_session_dir_invalid',
    'spawn_morty_invalid_ticket_path',
    'ticket_preskipped_already_terminal',
    'closer_expensive_node_test_blocked',
    'ticket_timeout_progress_extension',
    'ticket_timeout_halted_no_progress',
    'worker_artifact_progress_zero',
    'worker_auto_skip_oversized',
    'orphan_phantom_demoted',
    'codex_manager_no_progress',
    'pickle_command_deprecated',
    'refinement_over_collapse_detected',
    'concurrent_git_access_detected',
    'worker_mcp_config_resolved',
    'worker_head_regression_detected',
    'codegraph_index_built',
    'codegraph_index_failed',
    'codegraph_sync_completed',
    'codegraph_degraded',
    'codegraph_session_summary',
    'codegraph_context_injected',
    'codegraph_context_skipped',
    'codegraph_efficacy_sample',
    'scope_impact_warning',
    'orphan_commit_reattached',
    'orphan_commit_unreattachable',
    'worker_silent_death',
    'worker_produced_nothing',
    'worker_produced_everything_but_commit',
    'boundary_commit_resolved',
    'pre_reset_diff_archived',
    'pre_reset_archive_failed',
    'failed_flip_suppressed',
    'crashed_ticket_files_quarantined',
    'crashed_ticket_files_quarantine_truncated',
    'rate_limit_park_exhausted',
    'rate_limited_without_reset_at',
    'ticket_ladder_exhausted',
    'pickle_incomplete',
    // WS4 (b7cc6081): refused-and-recovered counters.
    'completion_finalize_refused',
    'phase_graduation_refused',
    'gate_parity_divergence',
    // 0b9b2319 (WS-3): bounded opt-in build-phase scope auto-extension.
    'scope_auto_extended',
  ];
  // Structural drift check — assert set-equality between registered events
  // and asserted EVENT_NAMES rather than a hardcoded count literal.
  const nonSharedDefs = Object.keys(schema.definitions).filter((k) => !SHARED_ENUM_DEFS.has(k));
  const eventNameSet = new Set(EVENT_NAMES);
  const inSchemaNotAsserted = nonSharedDefs.filter((k) => !eventNameSet.has(k));
  const assertedNotInSchema = EVENT_NAMES.filter((n) => !(n in schema.definitions));
  assert.deepStrictEqual(
    inSchemaNotAsserted,
    [],
    `schema defines events absent from EVENT_NAMES: ${inSchemaNotAsserted.join(', ')}`,
  );
  assert.deepStrictEqual(
    assertedNotInSchema,
    [],
    `EVENT_NAMES contains events absent from schema: ${assertedNotInSchema.join(', ')}`,
  );
});

// AC-PIAP-A6-1: tier_phase_skipped accepts trivial tier + lifecycle phase IDs
test('activity-event-payload: tier_phase_skipped accepts trivial tier with lifecycle phase IDs (AC-PIAP-A6-1)', () => {
  const result = validate({
    event: 'tier_phase_skipped',
    ts: TS,
    ticket_id: 'abc12345',
    tier: 'trivial',
    skipped_phases: ['research', 'research_review', 'plan', 'plan_review', 'conformance', 'simplify'],
  }, 'tier_phase_skipped');
  assert.equal(result.valid, true, `tier_phase_skipped trivial+lifecycle: ${result.error}`);
});

test('activity-event-payload: tier_phase_skipped rejects unknown tier value', () => {
  const result = validate({
    event: 'tier_phase_skipped',
    ts: TS,
    ticket_id: 'abc12345',
    tier: 'large',
    skipped_phases: ['test:fast'],
  }, 'tier_phase_skipped');
  assert.equal(result.valid, false, 'tier_phase_skipped: large is not a valid tier');
});

// AC-PIAP-A6: tier_diff_envelope_exceeded validates a well-formed payload
test('activity-event-payload: tier_diff_envelope_exceeded validates well-formed payload', () => {
  const result = validate({
    event: 'tier_diff_envelope_exceeded',
    ts: TS,
    ticket_id: 'abc12345',
    tier: 'medium',
    changed_loc: 420,
    envelope: 300,
  }, 'tier_diff_envelope_exceeded');
  assert.equal(result.valid, true, `tier_diff_envelope_exceeded: ${result.error}`);
});

test('activity-event-payload: tier_diff_envelope_exceeded registered in VALID_ACTIVITY_EVENTS', () => {
  assert.ok(
    VALID_ACTIVITY_EVENTS.includes('tier_diff_envelope_exceeded'),
    'tier_diff_envelope_exceeded must be present in VALID_ACTIVITY_EVENTS',
  );
});

// ───────── AC-WMFF-2C: worker_produced_everything_but_commit registration ─────────

test('activity-event-payload: worker_produced_everything_but_commit registered in VALID_ACTIVITY_EVENTS', () => {
  assert.ok(
    VALID_ACTIVITY_EVENTS.includes('worker_produced_everything_but_commit'),
    'worker_produced_everything_but_commit must be present in VALID_ACTIVITY_EVENTS',
  );
});

test('activity-event-payload: worker_produced_everything_but_commit has BOTH a definition and a top-level oneOf $ref', () => {
  // A definition without the $ref is INERT — validation never reaches it.
  assert.ok(schema.definitions.worker_produced_everything_but_commit, 'definition must exist');
  const refs = schema.oneOf.map((entry) => entry.$ref);
  assert.ok(
    refs.includes('#/definitions/worker_produced_everything_but_commit'),
    'top-level oneOf must $ref the definition (a definition without the $ref is inert)',
  );
});

test('activity-event-payload: worker_produced_everything_but_commit rejects an unknown worker_gate_verdict', () => {
  const result = validate({
    event: 'worker_produced_everything_but_commit',
    ts: TS,
    ticket: 'abc12345',
    gate_payload: {
      tier: 'medium',
      prefixes_checked: ['research'],
      session_log_bytes: 0,
      worker_gate_verdict: 'maybe',
      dirty_in_scope_paths: [],
      truncated: false,
      total_count: 0,
      window_commit: 'deadbeef',
    },
  }, 'worker_produced_everything_but_commit');
  assert.equal(result.valid, false, "worker_gate_verdict must be one of green|red|absent");
});

test('activity-event-payload: worker_produced_everything_but_commit caps dirty_in_scope_paths at 20 (maxItems)', () => {
  // The 20MB-state.json incident precedent: the path list is capped in the SCHEMA too,
  // so an uncapped producer cannot quietly write an unbounded array into state.json.
  const def = schema.definitions.worker_produced_everything_but_commit;
  assert.equal(def.properties.gate_payload.properties.dirty_in_scope_paths.maxItems, 20);
});

// AC-MFW-6: worker_mcp_config_resolved schema tests
test('activity-event-payload: worker_mcp_config_resolved validates well-formed payload (settings_override)', () => {
  const result = validate({
    event: 'worker_mcp_config_resolved',
    ts: TS,
    gate_payload: { mcp_config_path: '/ops/mcp.json', precedence_layer: 'settings_override' },
  }, 'worker_mcp_config_resolved');
  assert.equal(result.valid, true, `worker_mcp_config_resolved: ${result.error}`);
});

test('activity-event-payload: worker_mcp_config_resolved validates omitted case (null path)', () => {
  const result = validate({
    event: 'worker_mcp_config_resolved',
    ts: TS,
    gate_payload: { mcp_config_path: null, precedence_layer: 'omitted' },
  }, 'worker_mcp_config_resolved');
  assert.equal(result.valid, true, `worker_mcp_config_resolved omitted: ${result.error}`);
});

test('activity-event-payload: worker_mcp_config_resolved rejects unknown precedence_layer', () => {
  const result = validate({
    event: 'worker_mcp_config_resolved',
    ts: TS,
    gate_payload: { mcp_config_path: null, precedence_layer: 'explicit_override' },
  }, 'worker_mcp_config_resolved');
  assert.equal(result.valid, false, 'unknown precedence_layer should fail');
});

test('activity-event-payload: worker_mcp_config_resolved registered in VALID_ACTIVITY_EVENTS', () => {
  assert.ok(
    VALID_ACTIVITY_EVENTS.includes('worker_mcp_config_resolved'),
    'worker_mcp_config_resolved must be present in VALID_ACTIVITY_EVENTS',
  );
});

const SPAWN_REFINEMENT_TEAM_SRC = readFileSync(
  path.resolve(__dirname, '../src/bin/spawn-refinement-team.ts'),
  'utf8',
);

// AC-SIGF-6-event (0b9b2319): 7-surface parity check for the bounded
// build-phase scope auto-extension event: 1/7 VALID_ACTIVITY_EVENTS (compiled mirror), 3 schema.definitions,
// 4 schema.oneOf $ref, 5 EVENT_CASES row, 6 ACTIVITY_EVENT_SCHEMA_SECTION.
const SCOPE_AUTOEXTEND_EVENTS = ['scope_auto_extended'];
for (const eventName of SCOPE_AUTOEXTEND_EVENTS) {
  test(`AC-SIGF-6-event: ${eventName} registered at all 7 R-PDD-oneOf touchpoints`, () => {
    assert.ok(
      VALID_ACTIVITY_EVENTS.includes(eventName),
      `surface 1/7: ${eventName} missing from VALID_ACTIVITY_EVENTS`,
    );
    assert.ok(
      eventName in schema.definitions,
      `surface 3: ${eventName} missing from schema.definitions`,
    );
    assert.ok(
      schema.oneOf.some((r) => r.$ref === `#/definitions/${eventName}`),
      `surface 4: ${eventName} missing from schema.oneOf`,
    );
    assert.ok(
      EVENT_CASES.some((c) => c.type === eventName),
      `surface 5: ${eventName} missing from EVENT_CASES`,
    );
    assert.ok(
      SPAWN_REFINEMENT_TEAM_SRC.includes(eventName),
      `surface 6: ${eventName} missing from ACTIVITY_EVENT_SCHEMA_SECTION in spawn-refinement-team.ts`,
    );
  });
}

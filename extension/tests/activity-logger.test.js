// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { VALID_ACTIVITY_EVENTS } from '../types/index.js';
import { _setRetryDelayMs, _getPendingBuffer, _clearPendingBuffer } from '../services/activity-logger.js';
import { formatLocalDateKey } from '../services/pickle-utils.js';
import { readActivityFiles } from '../bin/standup.js';

// Helper: create temp dir that acts as extension root, return activity dir path
function withTempActivityDir(fn) {
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    const activityDir = path.join(extRoot, 'activity');
    const origEnv = process.env.EXTENSION_DIR;
    process.env.EXTENSION_DIR = extRoot;
    try {
        fn(activityDir, extRoot);
    } finally {
        process.env.EXTENSION_DIR = origEnv;
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
}

// Re-import logActivity fresh per test to pick up env changes
async function getLogActivity() {
    // Dynamic import with cache-busting query param won't work in Node ESM,
    // but since EXTENSION_DIR is read at call time (not import time), static import is fine.
    const mod = await import('../services/activity-logger.js');
    return mod.logActivity;
}

function localDateWithOffset(daysOffset, hour = 12) {
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    d.setDate(d.getDate() + daysOffset);
    return d;
}

function withBrokenCanadianDateLocale(fn) {
    const original = Date.prototype.toLocaleDateString;
    Date.prototype.toLocaleDateString = function (locale, ...args) {
        if (locale === 'en-CA') {
            return '04/27/2026';
        }
        return original.call(this, locale, ...args);
    };
    try {
        fn();
    } finally {
        Date.prototype.toLocaleDateString = original;
    }
}

// --- VALID_ACTIVITY_EVENTS ---

test('types.activity-events: VALID_ACTIVITY_EVENTS contains all expected event types', () => {
    const expected = [
        'session_start', 'session_end', 'ticket_completed', 'epic_completed',
        'meeseeks_pass', 'commit', 'research', 'bug_fix', 'feature',
        'refactor', 'review', 'jar_start', 'jar_end',
        'circuit_open', 'circuit_recovery',
        'tool_retry_circuit_open',
        'iteration_start', 'iteration_end', 'wasted_iter',
        'boundary_commit_resolved',
        'rate_limit_wait', 'rate_limit_resume', 'rate_limit_exhausted',
        'judge_unreachable', 'judge_timeout', 'judge_measurement_attempted', 'baseline_attempt_timeout', 'baseline_unmeasurable', 'judge_cli_missing',
        'multi_repo_warning',
        'pending_tickets_on_completion',
        'manager_false_epic_completed', 'manager_persistent_hallucination',
        'gate_baseline_captured', 'gate_baseline_disk_check',
        'gate_baseline_init_failed',
        'baseline_recapture_attempted', 'baseline_recapture_succeeded',
        'gate_run_complete', 'gate_skipped',
        'gate_unsafe_test_command_blocked', 'gate_remediation_complete',
        'gate_remediation_aborted_unverified_production_change',
        'gate_autofix_reverted', 'gate_workingdir_drift_detected',
        'gate_lock_acquired', 'gate_lock_timeout', 'gate_diff_scope_fallback',
        'gate_preexisting_tests_baselined', 'iteration_left_regression', 'coverage_exception',
        'strict_mode_red',
        'gate_regression_threshold_warning', 'gate_out_of_scope_failures_present',
        'commit_pending_probe_fired',
        'codex_manager_relaunch',
        'manager_max_turns_relaunch',
        'iteration_classified_at_max_turns',
        'readiness_failed_post_correction',
        // B-HRP R-HRP-1: citadel fix-forward emits this when the remediation cap is
        // exhausted with findings still open (pipeline continues, never halts).
        'citadel_findings_unremediated',
        // BMAD residual P0.6: check-readiness --skip-readiness emits this when
        // the gate is bypassed via state.flags.skip_quality_gates_reason.
        'readiness_skipped',
        'readiness_skipped_for_manifest',
        'archaeology_complete',
        'archaeology_skipped',
        'phase_personas_disabled_seen',
        'debate_solo_auto',
        'debate_user_declined_auto_promote',
        'debate_invalidated_by_correction',
        'debate_round_truncated',
        // AC-LPB-05: pipeline-runner / setup.ts emit on session reconstruction
        // so monitor/standup can distinguish fresh launches from resumed runs.
        'session_reconstructed_epoch_reset',
        // AC-LPB-04: mux-runner cap-check read swallows SCHEMA_MISMATCH
        // recoverably and surfaces it as an activity event so monitor/standup
        // can flag the deploy-drift class of failures.
        'cap_check_failed_schema_mismatch',
        // BMAD T17: transaction-ticket-ops emits these directly into
        // state.activity[] when applying course corrections.
        'course_corrected',
        'course_correct_apply_failed',
        'course_correct_recovered',
        'current_ticket_redirected_to_new',
        'ticket_auto_skip_no_evidence',
        'ticket_phantom_done_corrected',
        'phantom_done_detected',
        'phantom_done_backfilled',
        'ticket_state_desync_detected',
        'stall_classified',
        'readiness_delta_requested',
        // Pipeline lifecycle and fallback observability events.
        'phase_transition',
        'extension_dir_fallback',
        // mux-runner executeTimeoutHalt emits this to state.activity[] before
        // safeDeactivate so /pickle-status surfaces the timeout-repeat halt.
        'halt',
        'pkgjson_only_revert_detected',
        'pkgjson_full_drift_detected',
        'pkgjson_dep_or_src_missing',
        // GBM-T3: emitted when microverse-runner cannot recapture the
        // per-iteration gate baseline before strict-mode fallback.
        'baseline_recapture_failed',
        // R-PSO-1: state-manager demotes paused orphan sessions (pid=null,
        // active=true, stale mtime) so stop-hook decisions are unblocked.
        'paused_session_orphan_demoted',
        'phantom_session_demoted',
        'worker_spawn_backend_resolved',
        'worker_spawn_backend_override',
        'subtool_backend_override',
        'pipeline_auto_resumed',
        'smoke_gate_bypassed',
        'codex_unhealthy_consecutive_failures',
        'ticket_audit_bypassed',
        'worker_partial_lifecycle_exit',
        'cap_check_skipped_stale_cache',
        'ticket_cache_cleared',
        'orphan_map_entry_pruned',
        'install_sh_parity_check',
        'worker_backend_resolved',
        'tier_phase_skipped',
        'tier_diff_envelope_exceeded',
        'between_ticket_gate_timeout',
        'mux_runner_stall_detected',
        'worker_gate_failed',
        'worker_gate_verdict_fail_closed',
        'worker_lint_gate_passed',
        'worker_lint_gate_failed',
        'worker_lint_autofix_applied',
        'completion_commit_auto_filled',
        'completion_commit_inferred_from_git',
        'worker_completion_commit_announced',
        'recoverable_phase_failure',
        'subprocess_error',
        'time_cap_disabled_default',
        'bundle_bootstrap_exemption_applied',
        'resolver_indeterminate',
        'operator_recovery_transition',
        'signal_received',
        'standup_session_dropped',
        'worker_edit_outside_scope',
        'scope_auto_extended',
        'pkgjson_revert_forensic_captured',
        'pipeline_judge_timeout_recovery_attempted',
        'bundle_preflight_failed',
        'judge_violation_ledger_advanced',
        'judge_legacy_shape_inferred',
        'judge_json_parse_failed',
        'consecutive_no_progress_warning',
        'child_mux_runner_wedge_detected',
        'monitor_respawn_started',
        'monitor_respawn_failed',
        'monitor_respawn_session_dir_invalid',
        'monitor_mode_swapped',
        'monitor_stderr_rotated',
        'worker_spawn_backend_mismatch',
        'cross_ticket_regression_detected',
        'manager_idle_backoff_engaged',
        'manager_idle_backoff_released',
        'setup_resume_ticket_status_preserved',
        'setup_resume_overrode_ticket_status',
        'head_mismatch_detected',
        'stale_index_lock_detected',
        'setup_resume_chdir_applied',
        'ticket_runnability_resolved',
        'codex_manager_self_bootstrap_attempted',
        'orphan_test_runner_reaped',
        'orphan_session_detected',
        'session_map_collision_blocked',
        'state_write_override_used',
        'state_write_schema_version_violation',
        'install_sh_override_used',
        'tsc_gate_failed',
        'tsc_gate_override_used',
        'tsc_gate_override_consumed',
        'tsc_gate_crashed',
        'anatomy_park_empty_scope_skip',
        'anatomy_park_non_convergent_halt',
        'anatomy_park_complexity_regression',
        'szechuan_sauce_empty_scope_skip',
        'pipeline_all_backends_exhausted_recovery_attempted',
        'paused_session_orphan_precleaned',
        'spawn_morty_invalid_ticket_path',
        'ticket_preskipped_already_terminal',
        // B-PIPE-BABYSIT-HARDEN: orphan-manager reaping (R-OMS #80) and
        // manager-turn freshness heartbeat (R-SJLAG #82).
        'orphan_manager_reaped',
        // R-CXHANG: setup-time orphan-worker reaper (session-GC of detached
        // codex/claude worker procs whose owning session is provably not live).
        'worker_orphan_reaped',
        'manager_turn_progress',
        'closer_expensive_node_test_blocked',
        'ticket_timeout_progress_extension',
        'ticket_timeout_halted_no_progress',
        'worker_artifact_progress_zero',
        'worker_auto_skip_oversized',
        // B-PTSB: R-PTSB-3 pid-null phantom-session demotion on read.
        'orphan_phantom_demoted',
        // B-CMWL: R-CMWL-4 manager-level no-progress guard halts infinite
        // codex relaunch after 2 consecutive zero-progress passes.
        'codex_manager_no_progress',
        // B-PNTR: R-PNTR-3 schema-neutral resume remap emits this when a
        // resumed session's command_template was the removed bare `/pickle`
        // (pickle.md) and is remapped to _pickle-manager-prompt.md.
        'pickle_command_deprecated',
        // B-ACSG: R-ACSG-2 emits this when the AC-shape enforcement gate is
        // bypassed via --skip-ac-shape-gate <reason>.
        'ac_shape_gate_bypassed',
        // B-WEDGE: R-RSU-2 emits this from the emission-time over-collapse
        // guard when a bundle-of-bundles PRD is collapsed to <= one ticket
        // per composed source despite atomic-decomposition sections.
        'refinement_over_collapse_detected',
        // R-PIWG-5.2: advisory launch-time probe emits this when another git
        // process is detected touching the repo at session bootstrap.
        'concurrent_git_access_detected',
        // B-MFW: R-MFW-6 emits this once per worker/manager/refinement spawn
        // recording the resolved MCP config path + winning precedence layer.
        'worker_mcp_config_resolved',
        // B-CXOR: R-CXOR-1 emits this when a post-iteration HEAD regression
        // (worker git reset below the pre-iteration commit) is detected + recovered.
        'worker_head_regression_detected',
        // B-MWIS: R-MWIS-2 emits this when the mux main-loop idle-stall watchdog
        // detects a worker that exited without advancing (process-exit primary signal).
        'mux_idle_stall_detected',
        // 08e75a59: v2.0 codegraph + recovery telemetry events, registered
        // before any emitter lands (schema defs + oneOf refs in
        // activity-events.schema.json; payload contracts in types/index.ts).
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
        'pre_reset_diff_archived',
        'pre_reset_archive_failed',
        'failed_flip_suppressed',
        'rate_limit_park_exhausted',
        'rate_limited_without_reset_at',
        'ticket_ladder_exhausted',
        'crashed_ticket_files_quarantined',
        'crashed_ticket_files_quarantine_truncated',
        'pickle_incomplete',
        // B-DSAN2 AC-B4 (e157a44e): non-blocking readiness false-positive counter
        // surfaced on /pickle-metrics; emitted via READINESS_FALSE_POSITIVE_EVENT_NAME.
        'readiness_false_positive_suppressed',
        // B-GROUND2 WS4 (dcf18b3f): refused-and-recovered recurrence-dashboard
        // counters. INVERTED semantics — a rising count is the consolidation guard
        // WORKING (refused an unsafe transition and recovered), NOT a regression.
        'completion_finalize_refused',
        'phase_graduation_refused',
        'gate_parity_divergence',
        // BUG-2026-08-14 ticket 70a67ccb (e4df9cce): per-session spawn-morty lock
        // contention — a second worker spawn waited on the state-manager lock.
        'worker_spawn_lock_contended',
    ];
    assert.equal(VALID_ACTIVITY_EVENTS.length, expected.length);
    for (const e of expected) {
        assert.ok(VALID_ACTIVITY_EVENTS.includes(e), `Missing event type: ${e}`);
    }
});

test('VALID_ACTIVITY_EVENTS has no duplicates', () => {
    const unique = new Set(VALID_ACTIVITY_EVENTS);
    assert.equal(unique.size, VALID_ACTIVITY_EVENTS.length, 'should have no duplicate event types');
});

// --- logActivity ---

test('logActivity: appends valid JSONL to date-named file', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        logActivity({ event: 'commit', source: 'hook', commit_hash: 'abc1234' });
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        assert.ok(fs.existsSync(filepath), 'JSONL file should exist');
        const line = fs.readFileSync(filepath, 'utf8').trim();
        const parsed = JSON.parse(line);
        assert.equal(parsed.event, 'commit');
        assert.equal(parsed.source, 'hook');
        assert.equal(parsed.commit_hash, 'abc1234');
    });
});

test('logActivity: sets ts field automatically', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        const before = new Date().toISOString();
        logActivity({ event: 'session_start', source: 'pickle' });
        const after = new Date().toISOString();
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.ok(parsed.ts >= before, 'ts should be >= test start');
        assert.ok(parsed.ts <= after, 'ts should be <= test end');
    });
});

test('logActivity: preserves caller-provided ts', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        const customDate = localDateWithOffset(-1);
        const customTs = customDate.toISOString();
        logActivity({ event: 'commit', source: 'hook', ts: customTs });
        const date = formatLocalDateKey(customDate);
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.equal(parsed.ts, customTs);
    });
});

test('logActivity: uses strict YYYY-MM-DD partitions even when locale formatting falls back', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        const eventDate = new Date(2026, 3, 27, 12, 0, 0, 0);
        const eventTs = eventDate.toISOString();

        withBrokenCanadianDateLocale(() => {
            logActivity({ event: 'commit', source: 'hook', ts: eventTs, commit_hash: 'locale-bug' });
        });

        const expectedDate = formatLocalDateKey(eventDate);
        const expectedFile = path.join(activityDir, `${expectedDate}.jsonl`);
        assert.ok(fs.existsSync(expectedFile), 'event should be written under an ISO local-day filename');
        assert.equal(fs.existsSync(path.join(activityDir, '04/27/2026.jsonl')), false, 'locale fallback filename should never be used');

        const since = new Date(2026, 3, 27, 0, 0, 0, 0);
        const until = new Date(2026, 3, 28, 0, 0, 0, 0);
        const events = readActivityFiles(activityDir, since, until);
        assert.equal(events.length, 1);
        assert.equal(events[0].commit_hash, 'locale-bug');
    });
});

test('logActivity: creates activity dir if missing', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        assert.ok(!fs.existsSync(activityDir), 'activity dir should not exist yet');
        logActivity({ event: 'feature', source: 'persona', title: 'test' });
        assert.ok(fs.existsSync(activityDir), 'activity dir should be created');
    });
});

test('logActivity: multiple events append to same file', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        logActivity({ event: 'session_start', source: 'pickle' });
        logActivity({ event: 'ticket_completed', source: 'pickle', ticket: 'abc' });
        logActivity({ event: 'session_end', source: 'pickle' });
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const lines = fs.readFileSync(filepath, 'utf8').trim().split('\n');
        assert.equal(lines.length, 3);
        assert.equal(JSON.parse(lines[0]).event, 'session_start');
        assert.equal(JSON.parse(lines[1]).event, 'ticket_completed');
        assert.equal(JSON.parse(lines[2]).event, 'session_end');
    });
});

test('logActivity: silently catches errors on read-only directory', async () => {
    const logActivity = await getLogActivity();
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    const activityDir = path.join(extRoot, 'activity');
    fs.mkdirSync(activityDir);
    fs.chmodSync(activityDir, 0o444);
    const origEnv = process.env.EXTENSION_DIR;
    process.env.EXTENSION_DIR = extRoot;
    try {
        assert.doesNotThrow(() => {
            logActivity({ event: 'commit', source: 'hook' });
        });
    } finally {
        fs.chmodSync(activityDir, 0o755);
        process.env.EXTENSION_DIR = origEnv;
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
});

test('logActivity: file permissions are 0o600', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        logActivity({ event: 'feature', source: 'persona', title: 'test perms' });
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const stats = fs.statSync(filepath);
        const mode = stats.mode & 0o777;
        assert.equal(mode, 0o600, `Expected 0o600, got 0o${mode.toString(8)}`);
    });
});

test('logActivity: includes all provided optional fields', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        logActivity({
            event: 'ticket_completed',
            source: 'pickle',
            session: 'sess-123',
            ticket: 'abc',
            step: 'implement',
            epic: 'my-epic',
        });
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.equal(parsed.session, 'sess-123');
        assert.equal(parsed.ticket, 'abc');
        assert.equal(parsed.step, 'implement');
        assert.equal(parsed.epic, 'my-epic');
    });
});

test('ndjson.hermes-tag: logActivity adds backend from PICKLE_BACKEND when caller omits it', async () => {
    const logActivity = await getLogActivity();
    const originalBackend = process.env.PICKLE_BACKEND;
    process.env.PICKLE_BACKEND = 'hermes';
    try {
        withTempActivityDir((activityDir) => {
            logActivity({ event: 'iteration_start', source: 'pickle', iteration: 1 });
            const date = formatLocalDateKey(new Date());
            const filepath = path.join(activityDir, `${date}.jsonl`);
            const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
            assert.equal(parsed.event, 'iteration_start');
            assert.equal(parsed.backend, 'hermes');
        });
    } finally {
        if (originalBackend === undefined) delete process.env.PICKLE_BACKEND;
        else process.env.PICKLE_BACKEND = originalBackend;
    }
});

// --- Iteration events and new fields ---

test('logActivity: iteration_start event preserves iteration field', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        logActivity({ event: 'iteration_start', source: 'pickle', iteration: 3, session: 'sess-abc' });
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.equal(parsed.event, 'iteration_start');
        assert.equal(parsed.iteration, 3);
        assert.equal(parsed.session, 'sess-abc');
    });
});

test('logActivity: iteration_end event preserves iteration and exit_type fields', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        logActivity({ event: 'iteration_end', source: 'pickle', iteration: 5, exit_type: 'error' });
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.equal(parsed.event, 'iteration_end');
        assert.equal(parsed.iteration, 5);
        assert.equal(parsed.exit_type, 'error');
    });
});

test('logActivity: session_start event preserves original_prompt field', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        logActivity({ event: 'session_start', source: 'pickle', original_prompt: 'Build the portal gun' });
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.equal(parsed.event, 'session_start');
        assert.equal(parsed.original_prompt, 'Build the portal gun');
    });
});

// --- CLI: log-activity.js ---

const CLI_PATH = path.join(import.meta.dirname, '..', 'bin', 'log-activity.js');

function runCli(args, env = {}) {
    // 10s → 30s: budget for system load when run alongside concurrent
    // codex/tmux work. Tests validate CLI behavior, not wall-clock.
    return spawnSync(process.execPath, [CLI_PATH, ...args], {
        encoding: 'utf-8',
        timeout: 30000,
        env: { ...process.env, ...env },
    });
}

test('CLI: rejects unknown event type', () => {
    const result = runCli(['invalid_type', 'some title']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown event type/);
});

test('CLI: rejects missing event type', () => {
    const result = runCli([]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage/);
});

test('CLI: rejects -- prefixed event type', () => {
    const result = runCli(['--commit', 'some title']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage/);
});

test('CLI: rejects missing title', () => {
    const result = runCli(['feature']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Title is required/);
});

test('CLI: rejects -- prefixed title', () => {
    const result = runCli(['feature', '--verbose']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Title is required/);
});

test('CLI: rejects empty title after sanitization', () => {
    const result = runCli(['feature', '\n\r']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /empty/);
});

test('CLI: valid call exits 0 and writes event', () => {
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    try {
        const result = runCli(['bug_fix', 'Fixed the auth race'], { EXTENSION_DIR: extRoot });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const activityDir = path.join(extRoot, 'activity');
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        assert.ok(fs.existsSync(filepath), 'JSONL file should exist');
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.equal(parsed.event, 'bug_fix');
        assert.equal(parsed.source, 'persona');
        assert.equal(parsed.title, 'Fixed the auth race');
    } finally {
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
});

test('CLI: strips newlines from title', () => {
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    try {
        const result = runCli(['feature', 'line1\nline2\rline3'], { EXTENSION_DIR: extRoot });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const activityDir = path.join(extRoot, 'activity');
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.ok(!parsed.title.includes('\n'), 'title should not contain \\n');
        assert.ok(!parsed.title.includes('\r'), 'title should not contain \\r');
    } finally {
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
});

test('CLI: strips ANSI escape codes from title', () => {
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    try {
        const ansiTitle = '\x1b[31mred text\x1b[0m and \x1b[1mbold\x1b[0m';
        const result = runCli(['feature', ansiTitle], { EXTENSION_DIR: extRoot });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const activityDir = path.join(extRoot, 'activity');
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.ok(!parsed.title.includes('\x1b'), 'title should not contain ANSI escape codes');
        assert.match(parsed.title, /red text.*bold/, 'text content should be preserved');
    } finally {
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
});

test('CLI: strips control characters (bell, backspace, vertical tab) from title', () => {
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    try {
        // Use control chars that Node allows in CLI args (no null bytes)
        const controlTitle = 'before\x07bell\x08backspace\x0Bvtab after';
        const result = runCli(['bug_fix', controlTitle], { EXTENSION_DIR: extRoot });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const activityDir = path.join(extRoot, 'activity');
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.ok(!parsed.title.includes('\x07'), 'title should not contain bell char');
        assert.ok(!parsed.title.includes('\x08'), 'title should not contain backspace');
        assert.ok(!parsed.title.includes('\x0B'), 'title should not contain vertical tab');
        assert.ok(parsed.title.includes('before'), 'readable text should be preserved');
        assert.ok(parsed.title.includes('after'), 'readable text should be preserved');
    } finally {
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
});

test('CLI: truncates title at 200 chars', () => {
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    try {
        const longTitle = 'x'.repeat(300);
        const result = runCli(['research', longTitle], { EXTENSION_DIR: extRoot });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const activityDir = path.join(extRoot, 'activity');
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.equal(parsed.title.length, 200);
    } finally {
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
});

test('CLI: accepts representative valid event types', () => {
    const expected = [
        'session_start', 'session_end', 'ticket_completed', 'epic_completed',
        'meeseeks_pass', 'commit', 'research', 'bug_fix', 'feature',
        'refactor', 'review', 'jar_start', 'jar_end',
        'circuit_open', 'circuit_recovery',
        'iteration_start', 'iteration_end', 'wasted_iter',
        'rate_limit_wait', 'rate_limit_resume', 'rate_limit_exhausted',
        'multi_repo_warning',
        'pending_tickets_on_completion',
        'manager_false_epic_completed',
        'manager_persistent_hallucination',
    ];
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    try {
        for (const eventType of expected) {
            const result = runCli([eventType, `test ${eventType}`], { EXTENSION_DIR: extRoot });
            assert.equal(result.status, 0, `Event type "${eventType}" should be accepted, stderr: ${result.stderr}`);
        }
    } finally {
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Retry + buffer (F18)
// ---------------------------------------------------------------------------

test('logActivity: buffers event when write fails on both attempts (ENOSPC simulation)', async () => {
    _setRetryDelayMs(0); // no sleep in tests
    _clearPendingBuffer();
    const logActivity = await getLogActivity();

    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    const activityDir = path.join(extRoot, 'activity');
    const origEnv = process.env.EXTENSION_DIR;
    process.env.EXTENSION_DIR = extRoot;
    try {
        fs.mkdirSync(activityDir);
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        // Create file as read-only so both write attempts fail
        fs.writeFileSync(filepath, '', { mode: 0o444 });

        logActivity({ event: 'commit', source: 'hook', commit_hash: 'abc123' });

        assert.equal(_getPendingBuffer().length, 1, 'failed event should be buffered');
        assert.ok(
            _getPendingBuffer()[0].line.includes('"commit"'),
            'buffered entry should contain the event type'
        );
    } finally {
        fs.chmodSync(path.join(activityDir, formatLocalDateKey(new Date()) + '.jsonl'), 0o644);
        process.env.EXTENSION_DIR = origEnv;
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        fs.rmSync(extRoot, { recursive: true, force: true });
        _clearPendingBuffer();
        _setRetryDelayMs(500);
    }
});

test('logActivity: flushes buffer on next successful write', async () => {
    _setRetryDelayMs(0);
    _clearPendingBuffer();
    const logActivity = await getLogActivity();

    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    const activityDir = path.join(extRoot, 'activity');
    const origEnv = process.env.EXTENSION_DIR;
    process.env.EXTENSION_DIR = extRoot;
    try {
        fs.mkdirSync(activityDir);
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        fs.writeFileSync(filepath, '', { mode: 0o444 });

        // First call fails → buffered
        logActivity({ event: 'commit', source: 'hook', commit_hash: 'aaa' });
        assert.equal(_getPendingBuffer().length, 1);

        // Restore write permission
        fs.chmodSync(filepath, 0o644);

        // Second call succeeds → new event written, then buffer flushed
        logActivity({ event: 'feature', source: 'persona', title: 'flush test' });
        assert.equal(_getPendingBuffer().length, 0, 'buffer should be empty after flush');

        const lines = fs.readFileSync(filepath, 'utf8').trim().split('\n').filter(Boolean);
        assert.equal(lines.length, 2, 'file should have new event + flushed buffered event');
        assert.equal(JSON.parse(lines[0]).event, 'feature', 'new event written first');
        assert.equal(JSON.parse(lines[1]).event, 'commit', 'buffered event flushed second');
    } finally {
        process.env.EXTENSION_DIR = origEnv;
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        fs.rmSync(extRoot, { recursive: true, force: true });
        _clearPendingBuffer();
        _setRetryDelayMs(500);
    }
});

test('logActivity: buffered events flush back to the original day partition and standup reads that day', async () => {
    _setRetryDelayMs(0);
    _clearPendingBuffer();
    const logActivity = await getLogActivity();

    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    const activityDir = path.join(extRoot, 'activity');
    const origEnv = process.env.EXTENSION_DIR;
    process.env.EXTENSION_DIR = extRoot;

    const yesterday = localDateWithOffset(-1);
    const yesterdayStart = new Date(yesterday);
    yesterdayStart.setHours(0, 0, 0, 0);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const yesterdayFile = path.join(activityDir, `${formatLocalDateKey(yesterday)}.jsonl`);
    const todayFile = path.join(activityDir, `${formatLocalDateKey(todayStart)}.jsonl`);

    try {
        fs.mkdirSync(activityDir);
        fs.writeFileSync(yesterdayFile, '', { mode: 0o444 });

        logActivity({ event: 'commit', source: 'hook', commit_hash: 'retro123', ts: yesterday.toISOString() });
        assert.equal(_getPendingBuffer().length, 1, 'failed retro event should be buffered');

        fs.chmodSync(yesterdayFile, 0o644);
        logActivity({ event: 'feature', source: 'persona', title: 'today write succeeds' });

        assert.equal(_getPendingBuffer().length, 0, 'buffer should drain after the successful write');
        assert.equal(JSON.parse(fs.readFileSync(yesterdayFile, 'utf8').trim()).commit_hash, 'retro123');
        assert.equal(JSON.parse(fs.readFileSync(todayFile, 'utf8').trim()).event, 'feature');

        const events = readActivityFiles(activityDir, yesterdayStart, todayStart);
        assert.equal(events.length, 1, 'yesterday range should read the retro event from the restored file');
        assert.equal(events[0].commit_hash, 'retro123');
    } finally {
        if (fs.existsSync(yesterdayFile)) {
            fs.chmodSync(yesterdayFile, 0o644);
        }
        process.env.EXTENSION_DIR = origEnv;
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        fs.rmSync(extRoot, { recursive: true, force: true });
        _clearPendingBuffer();
        _setRetryDelayMs(500);
    }
});

test('logActivity: stale buffered events from a prior data root are dropped on the next success', async () => {
    _setRetryDelayMs(0);
    _clearPendingBuffer();
    const logActivity = await getLogActivity();

    const staleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-stale-'));
    const staleActivityDir = path.join(staleRoot, 'activity');
    const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-fresh-'));
    const freshActivityDir = path.join(freshRoot, 'activity');
    const originalExtDir = process.env.EXTENSION_DIR;

    try {
        process.env.EXTENSION_DIR = staleRoot;
        fs.mkdirSync(staleActivityDir);
        const staleFile = path.join(staleActivityDir, `${formatLocalDateKey(new Date())}.jsonl`);
        fs.writeFileSync(staleFile, '', { mode: 0o444 });

        logActivity({ event: 'commit', source: 'hook', commit_hash: 'stale-root-event' });
        assert.equal(_getPendingBuffer().length, 1, 'failed stale-root event should be buffered');

        fs.chmodSync(staleFile, 0o644);
        fs.rmSync(staleRoot, { recursive: true, force: true });

        process.env.EXTENSION_DIR = freshRoot;
        logActivity({ event: 'feature', source: 'persona', title: 'fresh root write' });

        const freshFile = path.join(freshActivityDir, `${formatLocalDateKey(new Date())}.jsonl`);
        assert.equal(_getPendingBuffer().length, 0, 'stale-root buffer entries should be dropped after the root changes');
        assert.equal(JSON.parse(fs.readFileSync(freshFile, 'utf8').trim()).event, 'feature');
        assert.equal(fs.existsSync(staleFile), false, 'stale root should not be recreated during flush');
    } finally {
        process.env.EXTENSION_DIR = originalExtDir;
        if (originalExtDir === undefined) delete process.env.EXTENSION_DIR;
        fs.rmSync(staleRoot, { recursive: true, force: true });
        fs.rmSync(freshRoot, { recursive: true, force: true });
        _clearPendingBuffer();
        _setRetryDelayMs(500);
    }
});

test('logActivity: buffer capped at 100 events — excess events dropped', async () => {
    _setRetryDelayMs(0);
    _clearPendingBuffer();
    const logActivity = await getLogActivity();

    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    const activityDir = path.join(extRoot, 'activity');
    const date = formatLocalDateKey(new Date());
    const filepath = path.join(activityDir, `${date}.jsonl`);
    const origEnv = process.env.EXTENSION_DIR;
    process.env.EXTENSION_DIR = extRoot;
    try {
        fs.mkdirSync(activityDir);
        fs.writeFileSync(filepath, '', { mode: 0o444 });

        // Write 150 events — only first 100 should be buffered
        for (let i = 0; i < 150; i++) {
            logActivity({ event: 'commit', source: 'hook', commit_hash: `hash${i}` });
        }

        assert.equal(_getPendingBuffer().length, 100, 'buffer must be capped at 100 events');
    } finally {
        fs.chmodSync(filepath, 0o644);
        process.env.EXTENSION_DIR = origEnv;
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        fs.rmSync(extRoot, { recursive: true, force: true });
        _clearPendingBuffer();
        _setRetryDelayMs(500);
    }
});

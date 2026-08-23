/**
 * Threshold for consecutive false EPIC_COMPLETED emissions on the same ticket
 * before mux-runner gives up and exits with MANAGER_PERSISTENT_HALLUCINATION.
 * Recovery is the default; this guards against a manager stuck in a permanent
 * hallucination loop.
 */
export const FALSE_EPIC_THRESHOLD = 3;
/**
 * AP-EXT-ITER8-01: the single ceiling every unbounded read declares instead of
 * inheriting Node's 1 MB `spawnSync`/`execFileSync` default. Applies to whole-repo
 * enumerations (`ls-files`, `status --porcelain`, importer greps), branch-wide
 * patches (`diff --cached --binary`, `diff <base>..HEAD`), and the shared `runCmd`
 * primitive. On overflow Node SIGTERMs the child but still returns the first
 * megabyte, so a truncated read is a WRONG ANSWER a caller cannot distinguish
 * from a complete one — it reads as "file not tracked", "no changes", or a
 * partial patch. The ceiling is deliberately far above the largest observed
 * payload (6.28 MB for a `blame --line-porcelain` of this repo's own
 * `mux-runner.ts`) and is declared ONCE so a future change edits one site.
 */
export const UNBOUNDED_READ_MAX_BUFFER = 64 * 1024 * 1024;
/**
 * Runtime-iterable membership list for `Backend`, and the SINGLE source of truth for it:
 * `Backend` derives from this array (`typeof BACKENDS[number]`), mirroring the
 * `VALID_STEPS`/`FAILURE_REASONS`/`EXIT_REASONS` shape used everywhere else in this file.
 * It was previously the reverse (`BACKENDS: readonly Backend[]` alongside a hand-maintained
 * literal union), which made the two parallel copies: a backend added to the union alone
 * still typechecked, so every runtime validator built on `BACKENDS`
 * (`setup.ts`, `backend-spawn.ts`, `spawn-morty.ts`, `metrics-utils.ts`) silently rejected it
 * and fell back to 'claude'. Adding a backend here is now the single edit — the type follows
 * by construction.
 */
export const BACKENDS = ['claude', 'codex', 'hermes', 'deepseek', 'grok', 'kimi', 'gemini'];
export const STATE_MANAGER_DEFAULTS = {
    maxLockRetries: 10,
    baseLockDelayMs: 100,
    lockJitter: true,
    staleLockTimeoutMs: 30_000,
    schemaVersion: 5,
};
/** Latest schema_version that this code knows how to write/read. Must match the latest migration target in state-manager.ts. */
export const LATEST_SCHEMA_VERSION = 5;
export class StateError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'StateError';
        this.code = code;
    }
}
export class LockError extends StateError {
    kind;
    key;
    timeout_ms;
    waited_ms;
    constructor(message) {
        super('LOCK_FAILED', message);
        this.name = 'LockError';
    }
}
export class TransactionError extends StateError {
    rollbackErrors;
    constructor(message, rollbackErrors = []) {
        super('WRITE_FAILED', message);
        this.name = 'TransactionError';
        this.rollbackErrors = rollbackErrors;
    }
}
export class SchemaVersionMismatchError extends StateError {
    statePath;
    onDiskVersion;
    cachedVersion;
    constructor(statePath, onDiskVersion, cachedVersion) {
        super('SCHEMA_MISMATCH', `State file ${statePath} schema_version ${onDiskVersion} is newer than transaction snapshot schema_version ${cachedVersion}`);
        this.name = 'SchemaVersionMismatchError';
        this.statePath = statePath;
        this.onDiskVersion = onDiskVersion;
        this.cachedVersion = cachedVersion;
    }
}
// ---------------------------------------------------------------------------
// Default Configuration Values
// ---------------------------------------------------------------------------
export const Defaults = {
    WORKER_TIMEOUT_SECONDS: 1200,
    /** Worker-convergence-mode: bail after N consecutive subprocess errors. */
    WORKER_CONSECUTIVE_ERROR_CAP: 3,
    /** Absolute ceiling for a single iteration when per-iteration timeout is disabled (4h). */
    MAX_ITERATION_SECONDS: 14_400,
    /** Separate guard for subprocesses that stop producing stdout/stderr progress (30m). */
    OUTPUT_STALL_SECONDS: 1800,
    /** Startup stale-state guard for wedged mux-runner sessions (30m). */
    MUX_RUNNER_STALL_SECONDS: 1800,
    MANAGER_MAX_TURNS: 50,
    RATE_LIMIT_POLL_MS: 10_000,
    /**
     * Maximum number of times mux-runner will relaunch the codex or hermes manager
     * subprocess after a per-iteration error while pending tickets remain.
     * Codex and hermes tmux_mode runs ONE long-lived manager that loops across many
     * tickets internally; the 4h `MAX_ITERATION_SECONDS` hang-guard SIGTERMs
     * that subprocess and resolves `{ completion: 'error', timedOut: true }`,
     * which the loop would otherwise treat as terminal. Past this cap, fall
     * back to the legacy exit-on-error so a genuinely broken backend cannot
     * loop forever.
     */
    CODEX_MANAGER_RELAUNCH_CAP: 10,
    /** Claude manager relaunch cap, primarily for `--max-turns` exhaustion recovery. */
    CLAUDE_MANAGER_RELAUNCH_CAP: 20,
};
// ---------------------------------------------------------------------------
// Lifecycle Steps
// ---------------------------------------------------------------------------
export const VALID_STEPS = [
    'prd', 'breakdown', 'research', 'plan', 'implement', 'refactor', 'review', 'completed',
    'pickle', 'citadel', 'anatomy-park', 'szechuan-sauce',
];
// ---------------------------------------------------------------------------
// Promise Tokens
// ---------------------------------------------------------------------------
export { PROMISE_TOKENS } from '../services/promise-tokens.js';
export const PromiseTokens = {
    EPIC_COMPLETED: 'EPIC_COMPLETED',
    TASK_COMPLETED: 'TASK_COMPLETED',
    WORKER_DONE: 'I AM DONE',
    PRD_COMPLETE: 'PRD_COMPLETE',
    TICKET_SELECTED: 'TICKET_SELECTED',
    ANALYSIS_DONE: 'ANALYSIS_DONE',
    EXISTENCE_IS_PAIN: 'EXISTENCE_IS_PAIN',
    THE_CITADEL_APPROVES: 'THE_CITADEL_APPROVES',
};
/** Returns true if `text` contains `<promise>TOKEN</promise>`, tolerating whitespace inside tags. */
export function hasToken(text, token) {
    if (!text || !token)
        return false;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`<promise>\\s*${escaped}\\s*</promise>`).test(text);
}
/** Wraps `token` in promise XML tags. */
export function wrapToken(token) {
    return `<promise>${token}</promise>`;
}
// Prefixes written by the Morty worker prompts (send-to-morty.md and
// send-to-morty-review.md). A ticket with at least one matching `.md` file in
// its directory is evidence the lifecycle actually ran.
export const ARTIFACT_PREFIXES = {
    implementation: ['research', 'plan', 'conformance', 'code_review'],
    review: ['review_scope', 'review_findings', 'spec_conformance'],
};
/**
 * True when `files` contains at least one lifecycle artifact for `role`.
 * Matches exact `${prefix}.md` (e.g. `review_scope.md`) or `${prefix}_*.md`
 * (e.g. `research_2026-04-18.md`, `plan_review.md`). Pure — caller does readdir.
 */
export function hasLifecycleArtifact(files, role) {
    const prefixes = ARTIFACT_PREFIXES[role];
    return files.some(f => prefixes.some(p => f === `${p}.md` || f.startsWith(`${p}_`)));
}
// ---------------------------------------------------------------------------
// Activity Events
// ---------------------------------------------------------------------------
export const VALID_ACTIVITY_EVENTS = [
    'session_start', 'session_end', 'ticket_completed', 'epic_completed',
    'meeseeks_pass', 'commit', 'research', 'bug_fix', 'feature',
    'refactor', 'review', 'jar_start', 'jar_end',
    'circuit_open', 'circuit_recovery',
    'tool_retry_circuit_open',
    'iteration_start', 'iteration_end', 'wasted_iter',
    'manager_turn_progress',
    'rate_limit_wait', 'rate_limit_resume', 'rate_limit_exhausted',
    'judge_unreachable',
    'judge_timeout',
    'judge_measurement_attempted',
    'baseline_attempt_timeout',
    'baseline_unmeasurable',
    'judge_cli_missing',
    'multi_repo_warning',
    'pending_tickets_on_completion',
    'manager_false_epic_completed',
    'manager_persistent_hallucination',
    'gate_baseline_captured',
    'gate_baseline_disk_check',
    'gate_baseline_init_failed',
    'baseline_recapture_attempted',
    'baseline_recapture_succeeded',
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
    'coverage_exception',
    'strict_mode_red',
    'gate_regression_threshold_warning',
    'gate_out_of_scope_failures_present',
    'commit_pending_probe_fired',
    'codex_manager_relaunch',
    'readiness_failed_post_correction',
    'readiness_skipped',
    'readiness_skipped_for_manifest',
    'readiness_false_positive_suppressed',
    'archaeology_complete',
    'archaeology_skipped',
    'phase_personas_disabled_seen',
    'debate_solo_auto',
    'debate_user_declined_auto_promote',
    'debate_invalidated_by_correction',
    'debate_round_truncated',
    'session_reconstructed_epoch_reset',
    'cap_check_failed_schema_mismatch',
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
    'mux_runner_stall_detected',
    'mux_idle_stall_detected',
    'child_mux_runner_wedge_detected',
    'readiness_delta_requested',
    'phase_transition',
    'extension_dir_fallback',
    'halt',
    'pkgjson_only_revert_detected',
    'pkgjson_full_drift_detected',
    'pkgjson_dep_or_src_missing',
    'paused_session_orphan_demoted',
    'paused_session_orphan_precleaned',
    'phantom_session_demoted',
    'orphan_phantom_demoted',
    'worker_spawn_backend_resolved',
    'worker_spawn_backend_override',
    'worker_spawn_backend_mismatch',
    'worker_spawn_lock_contended',
    'subtool_backend_override',
    'pipeline_auto_resumed',
    'smoke_gate_bypassed',
    'ac_shape_gate_bypassed',
    'tsc_gate_failed',
    'tsc_gate_override_used',
    'tsc_gate_override_consumed',
    'tsc_gate_crashed',
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
    'cross_ticket_regression_detected',
    'worker_gate_failed',
    'worker_gate_verdict_fail_closed',
    'worker_lint_gate_passed',
    'worker_lint_gate_failed',
    'worker_lint_autofix_applied',
    'completion_commit_auto_filled',
    'completion_commit_inferred_from_git',
    'worker_completion_commit_announced',
    'recoverable_phase_failure',
    'citadel_findings_unremediated',
    'subprocess_error',
    'time_cap_disabled_default',
    'manager_max_turns_relaunch',
    'iteration_classified_at_max_turns',
    'bundle_bootstrap_exemption_applied',
    'signal_received',
    'manager_idle_backoff_engaged',
    'manager_idle_backoff_released',
    'standup_session_dropped',
    'worker_edit_outside_scope',
    'pkgjson_revert_forensic_captured',
    'pipeline_judge_timeout_recovery_attempted',
    'pipeline_all_backends_exhausted_recovery_attempted',
    'bundle_preflight_failed',
    'judge_violation_ledger_advanced',
    'judge_legacy_shape_inferred',
    'judge_json_parse_failed',
    'consecutive_no_progress_warning',
    'monitor_respawn_started',
    'monitor_respawn_failed',
    'monitor_mode_swapped',
    'monitor_stderr_rotated',
    'setup_resume_ticket_status_preserved',
    'setup_resume_overrode_ticket_status',
    'head_mismatch_detected',
    'stale_index_lock_detected',
    'concurrent_git_access_detected',
    'setup_resume_chdir_applied',
    'ticket_runnability_resolved',
    'codex_manager_self_bootstrap_attempted',
    'orphan_test_runner_reaped',
    'orphan_manager_reaped',
    // R-CXHANG: setup-time orphan-worker reaper collected a detached codex/claude
    // worker proc whose owning session is provably not live (session-GC).
    'worker_orphan_reaped',
    // WS-2: setup-time orphan-worker reaper could NOT verify a candidate is
    // dead (SIGKILL-survivor or budget-exceeded) — informational, never counted
    // as reaped.
    'worker_orphan_reap_unverified',
    // AC5: emitted at a pipeline-scoped reap call site (setup, mux-runner
    // startup/iteration-start) ONLY when the sweep collected something —
    // makes a non-zero reap auditable on state.json without logging noise
    // on a zero-reap sweep.
    'worker_orphan_reap_summary',
    'orphan_session_detected',
    'session_map_collision_blocked',
    'state_write_override_used',
    'state_write_schema_version_violation',
    'install_sh_override_used',
    'anatomy_park_empty_scope_skip',
    'szechuan_sauce_empty_scope_skip',
    // B-APNC WS-1: a subsystem ran N passes (default 8, env
    // PICKLE_APNC_MAX_PASSES_WITHOUT_CLEAN) without a single clean pass — the runner
    // halts-and-reports it as non-convergent instead of grinding to the iteration cap.
    // Routes to a NON-FATAL phase end (pipeline continues to szechuan per R-PHC-6).
    'anatomy_park_non_convergent_halt',
    // B-APNC WS-2: a worker pass whose committed fix RAISED the subsystem's lint
    // complexity-rule count (eslint complexity / max-lines-per-function) over the
    // pass-start baseline — counted as a non-clean (regressing) pass, breadcrumb only.
    'anatomy_park_complexity_regression',
    'monitor_respawn_session_dir_invalid',
    'spawn_morty_invalid_ticket_path',
    'ticket_preskipped_already_terminal',
    'closer_expensive_node_test_blocked',
    'ticket_timeout_progress_extension',
    'ticket_timeout_halted_no_progress',
    'worker_artifact_progress_zero',
    'worker_auto_skip_oversized',
    'codex_manager_no_progress',
    'pickle_command_deprecated',
    'refinement_over_collapse_detected',
    'worker_mcp_config_resolved',
    'worker_head_regression_detected',
    // v2.0 codegraph + recovery telemetry (registered before any emitter lands)
    'codegraph_index_built',
    'codegraph_index_failed',
    'codegraph_sync_completed',
    'codegraph_degraded',
    'codegraph_session_summary',
    // b1089e97 (CGH-2): efficacy telemetry from buildCodegraphContextSection.
    // injected on the success path, skipped on productive-skip branches
    // (no_service / non_graph_tier / no_terms / zero_hits / query_timeout / query_failed;
    // the last two are AC-CGH-A1 killable-subprocess degrade outcomes). The steady-state
    // `disabled` branch is suppressed to avoid per-spawn flooding while default is OFF.
    'codegraph_context_injected',
    'codegraph_context_skipped',
    // CGH-3 (61d02c4e): one efficacy sample per probed ticket — scores a worker diff
    // WITH vs WITHOUT the `## Code Graph Context` section over a fixed corpus.
    'codegraph_efficacy_sample',
    'scope_impact_warning',
    'orphan_commit_reattached',
    'orphan_commit_unreattachable',
    'worker_silent_death',
    // R-WSDO (30aa2e0d): worker ran but produced nothing — no research_review.md +
    // log_empty + zero artifact-count delta. Mutually exclusive with worker_silent_death.
    'worker_produced_nothing',
    // AC-WMFF-2B: the worker-process budget-death flip left a ticket Failed even though it
    // produced EVERY gated artifact for its tier and its work is still recoverable (dirty
    // tree, or an unclaimed commit in the iteration window). Structural `else if` BELOW
    // worker_produced_nothing — R-WSDO wins any overlap. Observability only.
    'worker_produced_everything_but_commit',
    // B-DURA T10 (AC-DURA-1/2/8): the normal iteration boundary committed/attributed/
    // honest-failed the ticket's gate-passing deliverable before context clear.
    'boundary_commit_resolved',
    'pre_reset_diff_archived',
    'pre_reset_archive_failed',
    'failed_flip_suppressed',
    'rate_limit_park_exhausted',
    'rate_limited_without_reset_at',
    'ticket_ladder_exhausted',
    'crashed_ticket_files_quarantined',
    'crashed_ticket_files_quarantine_truncated',
    'pickle_incomplete',
    // W2.R0: the single operator recovery command (pickle-recover) emits exactly
    // one of these per real (non-plan) invocation — records the chosen subcommand,
    // ticket, and resulting disposition.
    'operator_recovery_transition',
    // W1c: readiness contract/symbol resolver exhausted its wall budget — a warn-class
    // indeterminate signal (the checker couldn't finish), NOT a ticket defect. Emitted by
    // check-readiness.ts:runReadiness; the gate still exits 0 (non-blocking).
    'resolver_indeterminate',
    // WS4 (b7cc6081): recurrence-dashboard refused-and-recovered counters. INVERTED
    // semantics vs skip-flag events — a rising count is the consolidation guard WORKING
    // (refused an unsafe transition and recovered), NOT a regression. The genuine
    // regress signal is the WS1 4th-audit-proxy BUILD failure, not these runtime counts.
    'completion_finalize_refused',
    'phase_graduation_refused',
    'gate_parity_divergence',
    // 0b9b2319 (WS-3): bounded, opt-in build-phase scope auto-extension. Emitted by
    // pipeline-runner setupScope when the flag is on, scope is paths-mode, and the
    // shared signature-caller-gap detector named out-of-fence callers. Over-cap
    // (> SCOPE_AUTO_EXTEND_MAX) extends nothing (allowed_paths unchanged, cap_hit:true).
    'scope_auto_extended',
];
/**
 * Recoverable reasons a ticket can be flipped to Failed by the auto-skip guard (R-WSWA-3).
 *
 * WS-2d (R-PFNT): the legacy single `oversized_no_progress` label conflated three
 * distinct stall causes (truly-oversized, scope-fence ambiguity, and legitimate-long
 * work) under one misleading literal — masking the real cause (often an out-of-fence
 * compile-RED). It is now split:
 *  - `scope_unresolvable`   — the stall correlates with an unresolved/empty scope
 *                             (the ticket cannot resolve a fence to edit within).
 *  - `no_progress_timeout`  — genuine no-progress within the spawn/poll budget.
 * `oversized_no_progress` is retained as a recognized RETRY-equivalent reason (no
 * behavior regression on retry / selection); the emission sites now pick the finer
 * reason via `classifyNoProgressFailureReason`.
 */
export const FAILURE_REASONS = [
    'oversized_no_progress',
    'scope_unresolvable',
    'no_progress_timeout',
];
/**
 * WS-2d (R-PFNT): the no-progress Failed reasons that share the legacy
 * `oversized_no_progress` selection / retry-exemption semantics. A reader that
 * treated only the old literal as a terminal no-progress flip MUST treat all three
 * equivalently so the split introduces no behavior regression.
 */
export const NO_PROGRESS_FAILURE_REASONS = [
    'oversized_no_progress',
    'scope_unresolvable',
    'no_progress_timeout',
];
/**
 * B-CWGE WS-2 (R-CWGE): the ticket-frontmatter field into which spawn-morty's
 * worker gate persists its overall verdict — the combined eslint + tsc + test
 * outcome of `runWorkerGate`. Value is one of `"green"` (every gate phase
 * passed) / `"red"` (at least one phase failed); an absent/unknown value reads
 * as `"absent"`, meaning the gate never ran for this commit. Read back in
 * `guardCompletionCommitBeforeDone` to make the recorded verdict authoritative
 * on EVERY Done-flip path: a red OR absent/unverifiable verdict is fail-closed
 * (Done requires a GREEN verdict). Sharing one literal between the producer
 * (spawn-morty) and consumer (mux-runner guard) keeps the storage key in
 * lockstep (WS-2 ordering hazard).
 */
export const WORKER_GATE_VERDICT_FIELD = 'worker_gate_verdict';
export var PipelineRunnerExitCode;
(function (PipelineRunnerExitCode) {
    PipelineRunnerExitCode[PipelineRunnerExitCode["Success"] = 0] = "Success";
    PipelineRunnerExitCode[PipelineRunnerExitCode["Failure"] = 1] = "Failure";
    PipelineRunnerExitCode[PipelineRunnerExitCode["AuditFailure"] = 2] = "AuditFailure";
    PipelineRunnerExitCode[PipelineRunnerExitCode["PhaseIncomplete"] = 3] = "PhaseIncomplete";
})(PipelineRunnerExitCode || (PipelineRunnerExitCode = {}));
/**
 * Ticket 7addedbf: the CLOSED disposition vocabulary for a mux iteration's
 * `wasted_iter` event. Declared here, once — `mux-runner.ts:classifyMuxIteration`
 * is the only producer and a second declaration is the defect this list exists to
 * prevent. Const-list first, union derived: a list annotated as its own union
 * would let a member typecheck while missing from the runtime array.
 *
 * - `committed`      — HEAD moved; the iteration shipped work.
 * - `worker_handoff` — no commit, but the worker wrote lifecycle artifacts the next
 *                      spawn resumes from. The designed handoff, not a defect.
 * - `clean_pass`     — the manager turn completed with nothing to do.
 * - `revert`         — the iteration's work was rolled back.
 * - `no_progress`    — genuinely unproductive; also the conservative verdict for an
 *                      action outside the mapped set.
 */
export const MUX_ITERATION_REASONS = [
    'committed',
    'worker_handoff',
    'clean_pass',
    'revert',
    'no_progress',
];
// ---------------------------------------------------------------------------
// Microverse Types
// ---------------------------------------------------------------------------
/**
 * THE membership list for `MicroverseExitReason`. Declared as a runtime `as const` array and the
 * type derived from it (same shape as `MICROVERSE_FATAL_REASONS` below), so the compiled
 * `types/index.js` genuinely reflects the membership instead of a hand-synced doc comment
 * claiming to. Adding a reason here is the single edit — the type follows by construction.
 */
export const MICROVERSE_EXIT_REASONS = [
    'converged', 'limit_reached', 'stopped', 'error',
    'rate_limit_exhausted', 'approach_exhaustion', 'no_progress',
    'judge_unreachable', 'judge_timeout', 'baseline_unmeasurable', 'judge_cli_missing',
    'baseline_unmeasurable_transient', 'baseline_unmeasurable_unrecoverable',
    'all_judge_backends_exhausted', 'anatomy_non_convergent',
    'stalled_below_target', 'iteration_budget_exhausted', 'time_budget_exhausted',
];
export const MICROVERSE_FATAL_REASONS = [
    'judge_cli_missing',
    'session_state_corrupted',
    'baseline_unmeasurable_unrecoverable',
];
/**
 * Runtime-iterable membership list for the pickle-phase `ExitReason`, declared `as const` to mirror
 * the `MICROVERSE_EXIT_REASONS` pattern above. It exists so `CRASH_FLOOR_EXIT_REASONS` can be swept
 * against its complement at runtime (pipeline-runner's AC-CF-02/03 sweeps) instead of hardcoding
 * literals.
 *
 * It IS the single source of truth: `mux-runner.ts` derives `export type ExitReason =
 * typeof EXIT_REASONS[number]` from this array, so the runtime's exit-reason plumbing
 * (`FAILURE_EXIT_REASONS`, `isFailureExit`) is typed against these members and cannot drift from
 * them. Adding a reason here is the ONE edit; the union follows. The dependency is one-way by
 * necessity — `types/index.ts` cannot import from `mux-runner.ts` without a cycle — so the array
 * must stay here and the type must stay derived there. Restating the members as a literal union in
 * mux-runner re-opens the drift this collapse closed (a reason present only in the union is never
 * swept by pipeline-runner's AC-CF-02/03 crash-floor sweeps, which iterate this array).
 */
export const EXIT_REASONS = [
    'success', 'cancelled', 'error', 'limit', 'iteration_cap_exhausted', 'stall', 'circuit_open',
    'rate_limit_exhausted', 'timeout_repeat', 'manager_persistent_hallucination',
    'codex_unhealthy_consecutive_failures', 'working_tree_modified_externally',
    'state_schema_version_ahead', 'closer_handoff_terminal', 'manager_handoff_pending',
    'done_without_commit_evidence', 'codex_manager_no_progress', 'recovery_exhausted',
    'idle_stall_unrecoverable', 'state_working_dir_missing', 'toolchain_unavailable',
];
/**
 * B-CRASHFLOOR: the pickle-phase crash floor — exit reasons meaning the runner cannot physically
 * continue. Consulted by `isFatalPhaseFailure`'s pickle arm in pipeline-runner.ts, mirroring how the
 * microverse arm consults `MICROVERSE_FATAL_REASONS`. MUST NOT be `FAILURE_EXIT_REASONS`
 * (mux-runner.ts) — that set includes quality/measurement verdicts (error, stall, circuit_open,
 * rate_limit_exhausted, timeout_repeat, ...) which CLAUDE.md's park-and-flag rule forbids halting on.
 */
export const CRASH_FLOOR_EXIT_REASONS = [
    'toolchain_unavailable', 'state_working_dir_missing', 'state_schema_version_ahead',
];
const MICROVERSE_FAILURE_REASONS = new Set([
    'error', 'rate_limit_exhausted', 'judge_unreachable',
    'baseline_unmeasurable_unrecoverable', 'judge_cli_missing',
]);
export function isMicroverseFailureExit(reason) {
    return MICROVERSE_FAILURE_REASONS.has(reason);
}
/**
 * R-WSRC-2 — Forward-schema state.json exit reason consumed by mux-runner.
 * Written by `recordExitReason(statePath, STATE_SCHEMA_VERSION_AHEAD_EXIT_REASON)`
 * when `sm.read()` throws `SchemaVersionAheadError`/`SCHEMA_MISMATCH`. Listed
 * in the mux-runner `ExitReason` union and `isFailureExit` set, but
 * intentionally NOT in `MICROVERSE_FAILURE_REASONS` above (it is a fatal-but-
 * operator-recoverable state, not a microverse-class failure). auto-resume.sh
 * R-CNAR-4(c) stops on this exit reason because it is in `isFailureExit`.
 */
export const STATE_SCHEMA_VERSION_AHEAD_EXIT_REASON = 'state_schema_version_ahead';
// ---------------------------------------------------------------------------
// DOT Builder Types
// ---------------------------------------------------------------------------
export { ATTRACTOR_SCHEMA_FALLBACK, ALL_ATTRS, lookupAttr, validateAttrType, validateAttrs, } from './attractor-schema.fallback.js';
export class BuildError extends Error {
    code;
    diagnostics;
    constructor(code, message, diagnostics = []) {
        super(message);
        this.name = 'BuildError';
        this.code = code;
        this.diagnostics = diagnostics;
    }
}

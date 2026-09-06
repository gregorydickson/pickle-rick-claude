/**
 * R-NOPOSTTIER: classification of the fast-tier gate verdict AFTER the bundle's final commit.
 * See classifyPostFinalVerdict (bin/mux-runner.ts) for the precedence rules that produce it.
 */
export type PostFinalVerdictState =
  | 'green'
  | 'red'
  | 'inconclusive'
  | 'absent'
  | 'not_applicable';

export interface State {
  active: boolean;
  working_dir: string;
  step: Step;
  iteration: number;
  max_iterations: number;
  max_time_minutes?: number;
  worker_timeout_seconds: number;
  start_time_epoch: number;
  completion_promise: string | null;
  original_prompt: string;
  current_ticket: string | null;
  current_ticket_tier?: string;
  current_ticket_budget?: number;
  current_ticket_max_iterations?: number;
  current_ticket_worker_timeout_seconds?: number;
  current_ticket_budget_start_iteration?: number;
  history: Array<{ step: Step; ticket?: string; timestamp: string }>;
  started_at: string;
  session_dir: string;
  tmux_mode?: boolean;
  min_iterations?: number;
  command_template?: string;
  chain_meeseeks?: boolean;
  schema_version?: number;
  prd_path?: string;
  start_commit?: string;
  pid?: number;
  /** Optional launch-shell PID breadcrumb written by per-session launch.sh at startup. */
  launch_shell_pid?: number | null;
  /** Count of consecutive short manager responses (≤ DEGENERATE_MAX_LENGTH). Reset on substantive response. */
  consecutive_short_responses?: number;
  /** Pipeline phases that have invoked refreshScope. Monotonically extends; guards against duplicate refresh. */
  phases_entered?: string[];
  /** Per-session activity log entries (e.g. halt records). Append-only. */
  activity?: ActivityLogEntry[];
  /** Implementation backend for manager spawns and worker fallback. Defaults to 'claude' when absent. */
  backend?: Backend;
  /** Optional per-session worker backend override. Worker spawns prefer this over `backend` when present. */
  worker_backend?: Backend;
  /** Worker-iteration fallback breadcrumb written after a typed judge failure; judge spawn itself stays claude-only. */
  judge_backend_resolved?: Extract<Backend, 'claude' | 'codex'>;
  /** When false, pipeline-runner halts on any non-zero non-citadel phase exit instead of continuing on recoverable failures. */
  pipeline_continue_on_phase_fail?: boolean;
  /** When true, /pickle Phase 3 spawns workers via harness team primitives (TeamCreate + Agent + TaskUpdate) instead of `claude -p` subprocesses. claude backend only. */
  teams_mode?: boolean;
  /** Concurrency cap for parallel `morty-implementer` teammates when teams_mode is true. Default 5. v1 ships sequential; this field is plumbed for the parallel-fan-out follow-up. */
  max_parallel?: number;
  /**
   * Count of consecutive false EPIC_COMPLETED emissions on the same `current_ticket`.
   * Reset to 0 whenever the manager genuinely advances to a new ticket OR succeeds.
   * When this exceeds FALSE_EPIC_THRESHOLD on the same ticket, mux-runner exits with
   * `MANAGER_PERSISTENT_HALLUCINATION` rather than continuing to retry.
   */
  false_epic_completed_count?: number;
  /** Ticket ID associated with the current `false_epic_completed_count`. Resets the counter when current_ticket diverges. */
  false_epic_completed_ticket?: string | null;
  /**
   * Reasoning effort for worker spawns. Currently honored only by the codex
   * backend (`-c reasoning.effort=<value>`); claude has no public flag and
   * silently ignores. When unset, workers inherit the CLI default.
   */
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  /**
   * Manager tmux_mode: count of times the runner has relaunched the backend
   * manager subprocess after a per-iteration error while tickets remained
   * Todo/In Progress. Claimed against the active backend cap.
   */
  manager_relaunch_count?: number;
  /**
   * Legacy alias for `manager_relaunch_count`. StateManager migrates this to
   * the canonical field on read for one-version backwards compatibility.
   */
  codex_manager_relaunch_count?: number;
  /** R-CMWL-4 (schema-neutral v5): consecutive zero-progress codex manager relaunch passes. Reset to 0 on any pass with ticket progress. Halt at 2. */
  codex_manager_consecutive_no_progress?: number;
  /** R-CMWL-4 (schema-neutral v5): pending ticket count at last codex relaunch — baseline for zero-progress detection. */
  codex_manager_relaunch_pending_baseline?: number;
  /** Hermes CLI toolsets persisted at setup time and passed to worker/manager spawns. */
  hermes_toolsets?: string[];
  /** Optional Hermes provider override persisted at setup time. */
  hermes_provider?: string;
  /** Optional Hermes model override persisted at setup time. */
  hermes_model?: string;
  /** Optional Grok model override (e.g. `grok-build`). Resolution: `state.grok_model` → undefined (grok CLI default). */
  grok_model?: string;
  /** Optional kimi model override. Resolution: `state.kimi_model` → undefined (kimi CLI default). */
  kimi_model?: string;
  /** Optional gemini model override (e.g. `gemini-2.5-pro`). Resolution: `state.gemini_model` → undefined (gemini CLI default). */
  gemini_model?: string;
  /**
   * Optional codex model override (e.g. `gpt-5.3-codex-spark`).
   * Resolution precedence (see `resolveCodexModel` in `bin/spawn-morty.ts`):
   *   1. `state.codex_model` (trimmed, non-empty) — per-session override.
   *   2. `pickle_settings.default_codex_model` — global default.
   *   3. undefined — codex CLI uses its compiled-in default.
   * Combined with `--ignore-user-config` on codex spawn, absent values mean
   * codex never sees a `-m` flag.
   */
  codex_model?: string;
  /** Optional Hermes max-turns override persisted at setup time. */
  hermes_max_turns?: number;
  archaeology?: ProjectContext | null;
  tickets_version?: number;
  last_course_correction?: CourseCorrectionRecord | null;
  phase_personas_active?: boolean;
  flags?: StateFlags;
  readiness?: ReadinessState;
  codex_version_seen?: string | null;
  /**
   * The `claude` CLI version string resolved at setup, or `null` when it could not
   * be resolved. PURE OBSERVABILITY — it exists so a run record answers "which CLI
   * executed this?" in the first log rather than after a multi-session bisect.
   *
   * It is NEVER a gate: unlike `codex_version_seen`, whose producer dies on a
   * version mismatch, an unresolvable claude version records `null` and setup
   * proceeds. `null` therefore means "could not measure", not "no claude here".
   */
  claude_version_seen?: string | null;
  /**
   * Terminal-exit forensic marker. Set by finalize/forensic helpers in the
   * runners (mux/microverse/pipeline/jar). Values: 'success', 'limit',
   * 'circuit_open', 'stall', 'fatal', 'signal', plus microverse-specific
   * reasons ('converged', 'rate_limit_exhausted', etc.). Outside observers
   * use this to distinguish a clean exit from a forensic halt.
   */
  exit_reason?: string | null;
  pinned_branch?: string | null;
  pinned_sha?: string;
  /** Mismatch context written by mux-runner; read by pipeline-runner to surface to stderr. */
  head_pin_mismatch_detail?: { pinned_branch: string | null; observed_branch: string | null; pinned_sha: string; observed_sha: string } | null;
  /**
   * Per-pane producer liveness flags. Length 4 (pane indices 0..3). Written
   * exclusively by pipeline-runner.ts at non-citadel phase boundaries.
   * Pane 2 is the producer pane (morty-watcher in pickle, subsystem-watcher
   * in microverse). Absent or false → show the normal no-data message.
   * True → show "Producer complete" instead. Crash-recovery default: false.
   */
  monitor_panes?: { producer_done: boolean }[];
  last_error?: ErrorRecord | null;
  last_subprocess_error?: ErrorRecord | null;
  last_between_ticket_gate?: {
    ts: number;
    ok: boolean;
    timed_out?: boolean;
    timeout_ms?: number | null;
    failures: Array<{
      name: string;
      file: string;
      /** AC-3: explicit script-vs-TAP-failure discriminator — see BetweenTicketGateFailure. */
      script_failure?: boolean;
      message?: string;
    }>;
  };
  /**
   * R-NOPOSTTIER: classification of the fast-tier gate verdict AFTER the bundle's final commit.
   * Written by ticket 4dd2d658 (not this ticket) via classifyPostFinalVerdict.
   */
  post_final_verdict?: {
    state: PostFinalVerdictState;
    degraded: boolean;
    dimensions: string[];
  };
  /** Forward-created by R-CCPM-3: orphan session paths detected at session-map read time. */
  orphans_detected?: string[];
  /** Forward-created by R-CCPM-3: hash of the owning parent session for manager-subprocess validation. */
  parent_session_hash?: string | null;
  /** Forward-created by R-CCPM-4: how the current session was invoked. */
  invocation_source?: 'operator' | 'manager_subprocess';
  /** Forward-created by R-WSWA-1 (schema v5): per-ticket worker artifact-progress tracking for the R-WMW fix. */
  worker_artifact_progress?: {
    [ticketId: string]: {
      spawn_count: number;
      last_artifact_count: number;
      zero_progress_count: number;
      /**
       * AC-R-WMNP-1 (schema-neutral): digest of the working-tree source state
       * (git `status --porcelain` + `diff --numstat`) captured at the prior spawn.
       * OR'd with the artifact-count delta so a worker landing real source work
       * but no new lifecycle artifact files does NOT accrue zero_progress_count.
       * An explicit `null` sentinel (M3) records a spawn whose git probe failed so
       * a later successful probe is detected as gap-recovery progress; `undefined`
       * means no spawn has captured a signature yet.
       */
      last_source_signature?: string | null;
    };
  };
  /** R-ORSR-1 (schema-neutral v5): recovery controller attempt ledger. Defaulted to [] via normalizeV5StateDefaults. */
  recovery_attempts?: RecoveryAttempt[];
  /**
   * Ticket e9bdac75 (Workstream B, additive/schema-neutral): persisted rate-limit
   * park arm. Written on park entry, cleared on resume. Re-armed on `--resume` so a
   * relaunch does not spawn-burn into the wall. Absent/null when not parked.
   */
  rate_limit_park?: RateLimitPark | null;
}

/** Persisted rate-limit park arm (ticket e9bdac75). */
export interface RateLimitPark {
  /** API-provided reset time (epoch seconds); null when the 429 carried no reset_at. */
  reset_at_epoch_sec: number | null;
  /** Epoch-ms when this park episode started (for cumulative-park accounting). */
  parked_started_epoch_ms: number;
  /** Cumulative parked wall-clock (ms) across this episode — compared to max_park_minutes. */
  cumulative_parked_ms: number;
  /** Consecutive rate-limit waits in this episode (carries the counter across relaunch). */
  consecutive_waits: number;
}

/** Per-entry shape for the recovery controller attempt ledger (R-ORSR-1). */
export interface RecoveryAttempt {
  strategy: string;
  outcome: 'success' | 'failed';
  reason: string;
  iteration: number;
  /**
   * Ticket 90574654 (additive, schema-neutral): the ticket the attempt was made
   * for. Stamped by the silent-death respawn policy so its per-ticket cap can be
   * counted from the persisted ledger; absent on pre-existing ladder entries.
   */
  ticket?: string;
}

/**
 * Ticket 90574654 — runtime-recovery hardening knobs resolved from the additive
 * `hardening:` block in `pickle_settings.json` (DISTINCT from `bmad_hardening`).
 * Resolver: `resolveHardeningSettings(bag)` in `services/pickle-utils.ts` —
 * absent/partial/malformed input falls back to compiled defaults per field.
 */
export interface HardeningSettings {
  /**
   * ONE shared respawn budget across both silent-death sub-classes
   * (`log_empty` and `log_truncated`). Drawn down via the persistent
   * `state.recovery_attempts` ledger (strategy `silent_death_respawn`) so the
   * cap survives relaunch and `setup.js --resume`. `0` disables respawns.
   * Compiled default: 1.
   */
  silent_death_respawn_cap: number;
  /**
   * Ticket 7eb9fa20 (H4): max evidence-backed Failed-flip suppressions per
   * ticket, persisted in `state.recovery_attempts` (strategy
   * `failed_flip_suppressed`) so the budget survives relaunch and
   * `setup.js --resume`. Reaching the cap escalates to the existing
   * no-progress halt instead of suppressing again. `0` disables suppression
   * (an evidence-backed flip-intent escalates immediately).
   * Compiled default: 2.
   */
  failed_flip_suppression_cap: number;
  /**
   * AC-A5 (B-RRH): seconds of grace after a circuit-breaker recovery during
   * which a spawn's zero-progress increment is suppressed. Compiled default: 30.
   */
  breaker_recovery_grace_seconds: number;
  /**
   * AC-A4 (f8000435): consecutive no-progress relaunches on the same In
   * Progress ticket before the bounded escape forces it terminal
   * (salvage-then-Skipped). Compiled default: 3.
   */
  bounded_terminal_escape_cap: number;
}

/**
 * Ticket e9bdac75 (Workstream B) — rate-limit park controls resolved from the
 * additive `rate_limit:` block in `pickle_settings.json`.
 * Resolver: `resolveRateLimitSettings(bag)` in `services/pickle-utils.ts` —
 * absent/partial/malformed input falls back to the compiled default per field.
 */
export interface RateLimitSettings {
  /**
   * Cumulative wall-clock ceiling (minutes) the runner will park across a single
   * rate-limit episode before giving up cleanly (emits `rate_limit_park_exhausted`
   * + reuses the existing `rate_limit_exhausted` exit-for-recovery). Also the clamp
   * applied to any single `reset_at`-driven park window. Compiled default: 360 (6h).
   * Min floor: 1.
   */
  max_park_minutes: number;
}

export interface CodegraphSettings {
  enabled: boolean;
  index_at_setup: boolean;
  staleness_max_age_minutes: number;
  context_max_bytes: number;
  expose_mcp_to_workers: boolean;
  index_timeout_ms: number;
  sync_timeout_ms: number;
  query_timeout_ms: number;
}

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
 * The completion predicate for a `UNBOUNDED_READ_MAX_BUFFER` enumeration — the sibling
 * of the ceiling above, and declared beside it because the two are ONE piece of
 * knowledge: the ceiling bounds the read, this reads its overflow.
 *
 * TWO failure shapes, ONE check. A non-zero/`null` `status` covers a git that could not
 * run, a timeout, and the SIGTERM Node sends when it out-reads `maxBuffer` on a child
 * still writing. `result.error` covers the OTHER `maxBuffer` shape: a child that EXITS
 * before that kill lands returns `status: 0`, `signal: null`, `error.code === 'ENOBUFS'`
 * and TRUNCATED stdout (measured on node v24.19.0 against this repo, 25/25) — a
 * status-ONLY guard reads that as a COMPLETE enumeration.
 *
 * That status-only half is not hypothetical: it is how all four members of this family
 * regressed (AP-EXT-ITER47-01, -48-01, -38-01, -38-03), each closed one site at a time
 * while the copies at the other sites stayed blind. Callers now share this one predicate
 * so the shapes cannot drift apart again — a member of the family that hand-writes its
 * own guard instead of calling this is the regression.
 *
 * Returns `true` only when the enumeration COMPLETED. Callers map `false` to `null`
 * (or a throw) — never to `[]`/empty `Set`, which is a POSITIVE finding a consumer reads
 * as a clean verdict over a read that never ran.
 */
export function enumerationCompleted(result: { status: number | null; error?: Error }): boolean {
  return (result.status ?? 1) === 0 && !result.error;
}

// Both built-in node:test reporters close a run with the same summary line and differ only in
// the leading sigil — spec `ℹ tests 16`, TAP `# tests 16` (measured on node 22 and 24) — so the
// pair is node's whole reporter set, not a list one member from the next hole.
const TEST_SUMMARY_COUNT_RE = /^(?:ℹ|#)[ \t]+tests[ \t]+(\d+)[ \t]*$/m;
const TEST_FAILURE_MARKER_RE = /(^✖\s)|(^not ok\s)/m;

/** How many tests a run PROVED it executed; 0 when it emitted no node:test summary at all. */
export function measuredTestCount(stdout: string, stderr: string): number {
  const match = TEST_SUMMARY_COUNT_RE.exec(`${stdout}\n${stderr}`);
  return match ? Number.parseInt(match[1], 10) : 0;
}

/**
 * Did this run prove it executed tests? The did-it-RUN axis for a test-tier spawn, and the
 * sibling of `enumerationCompleted` above: that one reads a truncated enumeration, this one
 * reads an EMPTY one. Either proof is accepted: a summary counting at least one test, or a
 * failure marker (a REPORTED failure is a test that ran, and a run can crash after printing
 * failures but before printing its summary).
 *
 * `tests 0` — and a run that printed no summary at all — is NOT proof. That is the
 * "reached nothing" case `scripts/audit-did-we-count.sh:requireCounted` already refuses by
 * name, and it is reachable from every tier spawn in this repo: `bin/test-runner.js --tier
 * fast …` exits 0 on an empty selection, printing only `[no files for tier fast]` (measured),
 * and `npm run test:fast` then reports `parallel_exit=0 serial_exit=0` and exits 0 too.
 *
 * Declared HERE rather than beside any one caller because the family has already regressed
 * once per site: `bin/check-flake-budget.ts` closed the release gate's only fast-tier run
 * (AP-EXT-ITER157-01) while the two per-ticket gates that spawn the SAME command
 * (`spawn-morty.ts:runWorkerGateTestCommand`, `mux-runner.ts:runBetweenTicketFastTests`)
 * stayed blind. A caller that hand-writes its own summary scrape instead of calling this is
 * the regression.
 */
export function reportedTestResults(stdout: string, stderr: string): boolean {
  return measuredTestCount(stdout, stderr) > 0 || TEST_FAILURE_MARKER_RE.test(`${stdout}\n${stderr}`);
}

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
export const BACKENDS = ['claude', 'codex', 'hermes', 'deepseek', 'grok', 'kimi', 'gemini'] as const;

export type Backend = typeof BACKENDS[number];
export type BackendResolutionSource = 'state' | 'env' | 'settings' | 'default' | 'refinement-lock' | 'cli-flag-override';
export type WorkerBackendResolutionSource = 'worker_backend' | 'backend' | 'env_lock';

export interface ProjectContext {
  project_context_path: string;
  last_run_iso: string;
  file_count: number;
  project_type: string;
}

export interface CourseCorrectionRecord {
  proposal_path: string;
  applied_iso: string;
  restart_ticket_id: string | null;
  before_count: number;
  after_count: number;
}

export interface StateFlags {
  strict_teams?: boolean;
  /**
   * The SINGLE quality-gate bypass reason shared by the readiness and
   * ticket-audit gates (both advisory post-R-GATE-ADVISORY). When set to a
   * non-empty trimmed string, mux-runner forwards `--skip-readiness <reason>`
   * to check-readiness and bypasses the ticket-audit gate on iter 0, emitting
   * `readiness_skipped` / `ticket_audit_bypassed` activity events for audit.
   */
  skip_quality_gates_reason?: string;
  /**
   * If set to a recognized bundle ID (e.g. "2026-05-08-mega"), and the current
   * session hash is in BUNDLE_BOOTSTRAP_ALLOWLIST for that bundle ID, mux-runner
   * auto-applies skip_quality_gates_reason on iter 0 and emits a
   * `bundle_bootstrap_exemption_applied` activity event.
   */
  bundle_bootstrap_mode?: string;
  /**
   * Manager-only emergency-revert escape hatch for the R-WACT tsc-gate.
   * Trimmed non-empty string approves a single subsequent commit despite
   * tsc errors; auto-cleared after consumption. Set via documented
   * StateManager.update chain (manager context only).
   * Emits activity events tsc_gate_override_used (on bypass) and
   * tsc_gate_override_consumed (on auto-clear).
   */
  allow_tsc_failed_reason?: string;
  [key: string]: unknown;
}

export interface ReadinessCycleHistoryEntry {
  cycle: number;
  status: string;
  suggested_analyst: string | null;
  user_action: string | null;
  timestamp: string;
}

export interface ReadinessState {
  cycle_history: ReadinessCycleHistoryEntry[];
  [key: string]: unknown;
}

export interface PhasePersona {
  phase: string;
  subagent_type: string;
  model?: string;
  [key: string]: unknown;
}

export interface ChangeProposal {
  proposal_path: string;
  restart_ticket_id: string | null;
  before_count: number;
  after_count: number;
  [key: string]: unknown;
}

export interface ErrorRecord {
  iteration: number;
  timestamp: string;
  completion: IterationOutcome['completion'];
  timedOut: boolean;
  wallSeconds: number;
}

export interface DebateRound {
  round: number;
  participants: string[];
  result_path?: string;
  [key: string]: unknown;
}

export interface ActivityLogEntry {
  event: string;
  [key: string]: unknown;
}

export interface ActivityGatePayload {
  signal_sender_pid?: number | null;
  signal_sender_cmd?: string | null;
  /** R-SJET-3: env key names (never values) in the built judge spawn env. */
  pre_spawn_env_key_names?: string[];
  /** R-SJET-3: true when the judge was spawned inside a nested Claude Code session. */
  nested_claude_detected?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// StateManager Types & Errors
// ---------------------------------------------------------------------------

export interface StateManagerOptions {
  maxLockRetries: number;
  baseLockDelayMs: number;
  lockJitter: boolean;
  staleLockTimeoutMs: number;
  schemaVersion: number;
}

export const STATE_MANAGER_DEFAULTS: StateManagerOptions = {
  maxLockRetries: 10,
  baseLockDelayMs: 100,
  lockJitter: true,
  staleLockTimeoutMs: 30_000,
  schemaVersion: 5,
};

/** Latest schema_version that this code knows how to write/read. Must match the latest migration target in state-manager.ts. */
export const LATEST_SCHEMA_VERSION = 5;

export type StateErrorCode = 'MISSING' | 'CORRUPT' | 'SCHEMA_MISMATCH' | 'SCHEMA_DEPLOY_DRIFT' | 'LOCK_FAILED' | 'WRITE_FAILED';

export class StateError extends Error {
  readonly code: StateErrorCode;
  constructor(code: StateErrorCode, message: string) {
    super(message);
    this.name = 'StateError';
    this.code = code;
  }
}

export class LockError extends StateError {
  kind?: 'LockError';
  key?: string;
  timeout_ms?: number;
  waited_ms?: number;
  constructor(message: string) {
    super('LOCK_FAILED', message);
    this.name = 'LockError';
  }
}

export class TransactionError extends StateError {
  readonly rollbackErrors: Error[];
  constructor(message: string, rollbackErrors: Error[] = []) {
    super('WRITE_FAILED', message);
    this.name = 'TransactionError';
    this.rollbackErrors = rollbackErrors;
  }
}

export class SchemaVersionMismatchError extends StateError {
  readonly statePath: string;
  readonly onDiskVersion: number;
  readonly cachedVersion: number;

  constructor(statePath: string, onDiskVersion: number, cachedVersion: number) {
    super(
      'SCHEMA_MISMATCH',
      `State file ${statePath} schema_version ${onDiskVersion} is newer than transaction snapshot schema_version ${cachedVersion}`,
    );
    this.name = 'SchemaVersionMismatchError';
    this.statePath = statePath;
    this.onDiskVersion = onDiskVersion;
    this.cachedVersion = cachedVersion;
  }
}

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  /** @deprecated Claude Code uses last_assistant_message instead */
  prompt_response?: string;
}

export interface PostToolUseFailureInput {
  session_id?: string;
  hook_event_name?: 'PostToolUseFailure' | string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  error?: string;
  is_interrupt?: boolean;
  tool_use_id?: string;
  cwd?: string;
  transcript_path?: string;
}

export interface LastToolErrorState {
  ts: string;
  tool: string;
  error_signature: string;
  retry_count: number;
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
} as const;

// ---------------------------------------------------------------------------
// Lifecycle Steps
// ---------------------------------------------------------------------------

export const VALID_STEPS = [
  'prd', 'breakdown', 'research', 'plan', 'implement', 'refactor', 'review', 'completed',
  'pickle', 'citadel', 'anatomy-park', 'szechuan-sauce',
] as const;
export type Step = typeof VALID_STEPS[number];

// ---------------------------------------------------------------------------
// Promise Tokens
// ---------------------------------------------------------------------------

export { PROMISE_TOKENS, type PromiseToken } from '../services/promise-tokens.js';

export const PromiseTokens = {
  EPIC_COMPLETED: 'EPIC_COMPLETED',
  TASK_COMPLETED: 'TASK_COMPLETED',
  WORKER_DONE: 'I AM DONE',
  PRD_COMPLETE: 'PRD_COMPLETE',
  TICKET_SELECTED: 'TICKET_SELECTED',
  ANALYSIS_DONE: 'ANALYSIS_DONE',
  EXISTENCE_IS_PAIN: 'EXISTENCE_IS_PAIN',
  THE_CITADEL_APPROVES: 'THE_CITADEL_APPROVES',
} as const;

/** Returns true if `text` contains `<promise>TOKEN</promise>`, tolerating whitespace inside tags. */
export function hasToken(text: string, token: string): boolean {
  if (!text || !token) return false;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<promise>\\s*${escaped}\\s*</promise>`).test(text);
}

/** Wraps `token` in promise XML tags. */
export function wrapToken(token: string): string {
  return `<promise>${token}</promise>`;
}

// ---------------------------------------------------------------------------
// Lifecycle Artifacts
// ---------------------------------------------------------------------------

export type WorkerRole = 'implementation' | 'review';

// Prefixes written by the Morty worker prompts (send-to-morty.md and
// send-to-morty-review.md). A ticket with at least one matching `.md` file in
// its directory is evidence the lifecycle actually ran.
export const ARTIFACT_PREFIXES: Record<WorkerRole, readonly string[]> = {
  implementation: ['research', 'plan', 'conformance', 'code_review'],
  review: ['review_scope', 'review_findings', 'spec_conformance'],
};

/**
 * AP-EXT-ITER199-01: THE artifact-name contract rule, in one place. A gated lifecycle
 * artifact for `prefix` is the bare `${prefix}.md` OR any `${prefix}_*` sibling
 * (`research_2026-04-18.md`, `plan_review_2026-08-29.md`) — the same rule
 * `findMissingPrefixes` counts a prefix PRESENT by. Every reader that must answer
 * "is this file the <prefix> artifact?" asks HERE, so a gate and the reader it gates
 * cannot answer it differently. Hand-written exact-name literals are the failure mode
 * this exists to delete.
 */
export function matchesArtifactPrefix(file: string, prefix: string): boolean {
  return file === `${prefix}.md` || file.startsWith(`${prefix}_`);
}

/**
 * The newest artifact matching `prefix` under that same rule, or null when `files`
 * holds none. Lexicographic-last is the tie-break the other readers of these artifacts
 * use, and a dated `${prefix}_<date>.md` sorts after the bare `${prefix}.md` (`_` > `.`),
 * so the suffixed artifact wins. Pure — caller does readdir.
 */
export function newestArtifactFile(files: readonly string[], prefix: string): string | null {
  return files.filter(f => matchesArtifactPrefix(f, prefix)).sort().at(-1) ?? null;
}

/**
 * True when `files` contains at least one lifecycle artifact for `role`.
 * Pure — caller does readdir.
 */
export function hasLifecycleArtifact(files: readonly string[], role: WorkerRole): boolean {
  const prefixes = ARTIFACT_PREFIXES[role];
  return files.some(f => prefixes.some(p => matchesArtifactPrefix(f, p)));
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
  'ticket_audit_manual_edit',
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
  'bundle_2026_05_04_closer_done',
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
  // AC-V4 (dc205237): the pickle phase exhausted its iteration cap with tickets
  // still unbuilt. Distinct from the generic `pipeline_phase_incomplete` report —
  // it NAMES the cap and carries the dropped ticket ids. A disposition + a report,
  // never a gate: the phase still advances (`action: 'continue'`).
  'phase_cap_dropped_tickets',
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
  // R-WSRC-GR: the git-boundary seam's per-verb audit trail, emitted by
  // `hooks/handlers/config-protection.ts` on every blocked prohibited git verb and on
  // every operator-flag bypass of one. Listed here as literals so `ActivityEventType`
  // stays the literal union; `GIT_VERB_GATE` in that file is annotated with
  // `ActivityEventType`, so a verb added to the gate without its two names landing here
  // is a COMPILE error, not a silently unregistered event (AP-EXT-ITER110-01).
  'worker_git_reset_blocked',
  'worker_git_reset_bypass',
  'worker_git_switch_blocked',
  'worker_git_switch_bypass',
  'worker_git_stash_blocked',
  'worker_git_stash_bypass',
  'worker_git_rebase_blocked',
  'worker_git_rebase_bypass',
  'worker_git_pull_blocked',
  'worker_git_pull_bypass',
  'worker_git_push_blocked',
  'worker_git_push_bypass',
  'worker_git_checkout_blocked',
  'worker_git_checkout_bypass',
  'worker_git_commit__amend_blocked',
  'worker_git_commit__amend_bypass',
  'worker_git_fetch__prune_blocked',
  'worker_git_fetch__prune_bypass',
] as const;

export type ActivityEventType = typeof VALID_ACTIVITY_EVENTS[number];
export type ActivityEventSource = 'pickle' | 'hook' | 'persona' | 'force_flag' | 'citadel-mechanical' | 'worker_gate' | BackendResolutionSource | WorkerBackendResolutionSource;

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
] as const;
export type TicketFailureReason = typeof FAILURE_REASONS[number];

/**
 * WS-2d (R-PFNT): which Failed reasons share the legacy `oversized_no_progress`
 * selection / retry-exemption semantics. A reader that treated only the old literal
 * as a terminal no-progress flip MUST treat all three equivalently so the split
 * introduces no behavior regression.
 *
 * AP-EXT-ITER77-01: the classification is a TOTAL `Record<TicketFailureReason, …>`
 * and `NO_PROGRESS_FAILURE_REASONS` is DERIVED from it — never a second
 * hand-maintained array. The prior shape (`export const NO_PROGRESS_FAILURE_REASONS:
 * readonly TicketFailureReason[] = [...]`) is what this file's own const-list trap
 * door forbids: annotating a membership list AS its union lets a reason added to
 * `FAILURE_REASONS` be omitted here and still typecheck, and
 * `mux-runner.ts:isOversizedNoProgressFailed` then silently answers false for it —
 * the ticket loses its retry-exemption / selection semantics with no compiler signal.
 * Mutation-probed: a 4th `FAILURE_REASONS` member omitted from the old array compiled
 * CLEAN; omitted from this map it is a tsc error, because the Record is total.
 */
const FAILURE_REASON_IS_NO_PROGRESS: Record<TicketFailureReason, boolean> = {
  oversized_no_progress: true,
  scope_unresolvable: true,
  no_progress_timeout: true,
};

export const NO_PROGRESS_FAILURE_REASONS = FAILURE_REASONS.filter(
  (reason) => FAILURE_REASON_IS_NO_PROGRESS[reason],
);

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

export enum PipelineRunnerExitCode {
  Success = 0,
  Failure = 1,
  AuditFailure = 2,
  PhaseIncomplete = 3,
}

export type IterationExitType = 'success' | 'error' | 'api_limit' | 'inactive' | 'timeout';

export interface RateLimitInfo {
  limited: boolean;
  sawEvents?: boolean;     // true if structured rate_limit_event lines were found (even if not rejected)
  resetsAt?: number;       // Unix epoch seconds from API
  rateLimitType?: string;  // 'five_hour' | 'seven_day' etc.
}

export type IterationExitResult =
  | { type: 'inactive' }
  | { type: 'error' }
  | { type: 'success' }
  | { type: 'api_limit'; rateLimitInfo?: RateLimitInfo }
  | { type: 'timeout'; exitCode: number | null; wallSeconds: number };

export interface IterationOutcome {
  completion: 'task_completed' | 'review_clean' | 'continue' | 'error' | 'inactive';
  timedOut: boolean;
  exitCode: number | null;
  wallSeconds: number;
  stallReason?: 'wall_clock' | 'output_stall';
}

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
] as const;

export type MuxIterationReason = typeof MUX_ITERATION_REASONS[number];

export interface RateLimitAction {
  action: 'wait' | 'bail';
  waitMs: number;
  waitSource: 'api' | 'config';
  resetCounter: boolean;
  hasResetsAt: boolean;
  /**
   * Ticket e9bdac75 (Workstream B): when `waitSource === 'api'`, the full
   * `reset_at`-driven park window (clamped to `max_park_minutes`), expressed as an
   * absolute epoch-ms wake target. Park is encoded as `action: 'wait'` —
   * schema-neutral, no new action value. Absent for config-default waits.
   */
  parkUntilEpochMs?: number;
  /** The API-provided `reset_at` (epoch seconds) persisted for `--resume` re-arm; null when absent. */
  resetAtEpochSec?: number | null;
}

export interface ActivityEvent {
  ts: string;
  event: ActivityEventType;
  source: ActivityEventSource;
  session?: string;
  epic?: string;
  ticket?: string | null;
  title?: string;
  step?: string;
  mode?: string;
  pass?: number;
  commit_hash?: string;
  commit_message?: string;
  duration_min?: number;
  duration_ms?: number;
  error?: string;
  iteration?: number;
  completion?: IterationOutcome['completion'];
  timedOut?: boolean;
  wallSeconds?: number;
  exit_type?: IterationExitType;
  runner?: 'microverse' | 'mux' | string;
  action?: string;
  wasted?: boolean;
  pre_iter_sha?: string | null;
  post_iter_sha?: string | null;
  /**
   * Ticket 7addedbf: the lifecycle-artifact delta `classifyMuxIteration` decided the
   * `wasted_iter` verdict on. Recorded, not just consumed — a verdict published without
   * the observable that produced it cannot be recounted, and the recount
   * (`bin/wasted-iter-replay.ts`) is the only check that the claimed rate drop is real.
   * Absent means the record predates this field, NOT `null`.
   */
  artifact_delta?: number | null;
  original_prompt?: string;
  model?: string;
  backend?: Backend;
  judge_backend?: Backend;
  worker_backend?: Backend | null;
  fallback_activated?: boolean;
  spawn_context?: string;
  ticket_id?: string;
  project_type?: string;
  bytes_out_utf8?: number;
  tokens_in_estimated?: number;
  tokens_out_estimated?: number;
  round?: number;
  expected_tickets_version?: number;
  actual_tickets_version?: number;
  bytes_dropped?: number;
  relaunch_count?: number;
  pending_count?: number;
  consecutive_count?: number;
  cap?: number;
  last_ticket_seen?: string | null;
  gate_payload?: ActivityGatePayload;
  // AC-LPB-05: emitted by setup.ts/pipeline-runner.ts on session reconstruction
  // (resume) so monitor/standup consumers can distinguish a fresh launch from a
  // resumed run and reason about wall-clock budgets correctly.
  original_epoch?: number;
  new_epoch?: number;
  previous_phase?: string | null;
  next_phase?: string;
  previous_exit_reason?: string | null;
  exit_reason?: string;
  requested_path?: string;
  fallback_path?: string;
  session_path?: string;
  reason?: string;
  stall_category?: StallCategory;
  stall_recovery_action?: StallRecoveryAction;
  signal?: string;
  pid?: number;
  ppid?: number;
  is_tty?: boolean;
  pgid?: number | null;
  active_child_pid?: number | null;
  active_child_cmd?: string | null;
  current_phase?: string | null;
  received_at_iso?: string;
  handler_stack?: string[];
  signal_sender_pid?: number | null;
  signal_sender_cmd?: string | null;
  phase?: string;
  exit_code?: number;
  fatal?: boolean;
  downstream_phases_remaining?: string[];
  decision?: 'continue' | 'abort';
  attempts?: number;
  fall_through_to_finalize_gate?: boolean;
  iteration_num?: number;
  num_turns?: number;
  max_turns?: number;
  wall_seconds?: number;
  // setup_resume_ticket_status_preserved / setup_resume_overrode_ticket_status
  observed_status?: string;
  expected_status?: string;
  prior_status?: string;
  new_status?: string;
  // R-CCPM-2: codex_manager_self_bootstrap_attempted payload fields
  attempted_argv?: string[];
  action_taken?: string;
  etime_seconds?: number;
  argv_summary?: string;
  // R-CCPM-3: orphan_session_detected payload fields
  orphan_session_path?: string;
  orphan_started_at?: number;
  orphan_pid?: number;
  parent_session_hash?: string;
  // R-CCPM-4: session_map_collision_blocked payload fields
  existing_session_path?: string;
  existing_pid?: number;
  attempted_session_path?: string;
  attempted_pid?: number;
  cwd?: string;
  // v2.0: scope_impact_warning payload fields (ImpactAnalysisPayload)
  staged_paths?: string[];
  transitive_dependents_outside_scope?: string[];
  radius_depth?: number;
  // v2.0: worker_silent_death payload fields (SilentDeathPayload)
  log_path?: string;
  sub_class?: SilentDeathPayload['sub_class'];
  respawn_attempt?: number;
  // v2.0: pre_reset_diff_archived / pre_reset_archive_failed payload fields (PreResetPayload)
  patch_path?: string;
  files?: string[];
  files_truncated?: boolean;
  // v2.0: orphan_commit_reattached / orphan_commit_unreattachable payload fields (OrphanReattachPayload)
  sha?: string;
  prev_head?: string;
  chain_length?: number;
  // v2.0: failed_flip_suppressed payload fields (FailedFlipSuppressedPayload)
  evidence?: FailedFlipSuppressedPayload['evidence'];
  suppression_count?: number;
  // v2.0: codegraph_session_summary payload fields (CodegraphSessionSummaryPayload)
  tickets?: number;
  degraded_ops?: number;
  index_status?: CodegraphSessionSummaryPayload['index_status'];
  injected?: number;
  skipped?: number;
  // b1089e97: codegraph_context_injected / _skipped payload fields.
  tier?: string;
  terms_count?: number;
  hits_count?: number;
  bytes?: number;
  build_ms?: number;
  /** 2e632f9a: nodes dropped by node-level staleness verification (both event branches). */
  dropped_stale?: number;
  // Ticket e9bdac75 (Workstream B): rate-limit park payload fields.
  // rate_limit_wait carries the API reset_at (epoch seconds, null when absent);
  // rate_limit_resume carries the actual parked wall-clock in minutes.
  reset_at?: number | null;
  parked_minutes?: number;
}

// ---------------------------------------------------------------------------
// v2.0 Activity Event Payload Contracts (PRD Type Contracts)
// Event → payload mapping:
//   scope_impact_warning            → ImpactAnalysisPayload
//   worker_silent_death             → SilentDeathPayload
//   pre_reset_diff_archived         → PreResetPayload
//   pre_reset_archive_failed        → PreResetPayload (archive failure variant)
//   orphan_commit_reattached        → OrphanReattachPayload
//   orphan_commit_unreattachable    → OrphanReattachPayload (no reattach evidence)
//   failed_flip_suppressed          → FailedFlipSuppressedPayload
//   codegraph_session_summary       → CodegraphSessionSummaryPayload
//   codegraph_index_built           → gate_payload.{files_indexed?, duration_ms?} (see activity-events.schema.json)
//   codegraph_index_failed / codegraph_sync_completed / codegraph_degraded → optional telemetry only
// `writeActivityEntry` never stamps `ts` — emitters pass it explicitly, so `ts`
// is required wherever the payload declares it.
// ---------------------------------------------------------------------------

/** Payload for `scope_impact_warning`. */
export interface ImpactAnalysisPayload {
  staged_paths: string[];
  transitive_dependents_outside_scope: string[];
  radius_depth: number;
}

/** Payload for `worker_silent_death`. */
export interface SilentDeathPayload {
  ticket: string;
  pid: number | null;
  log_path: string;
  sub_class: 'log_empty';
  respawn_attempt: number;
  ts: string;
}

/** Payload for `pre_reset_diff_archived` / `pre_reset_archive_failed`. */
export interface PreResetPayload {
  ticket: string | null;
  patch_path: string;
  files: string[];
  files_truncated: boolean;
  reason: 'pre_reset' | 'silent_death' | 'microverse_rollback';
  ts: string;
}

/** Payload for `orphan_commit_reattached` / `orphan_commit_unreattachable`. */
export interface OrphanReattachPayload {
  ticket: string;
  sha: string;
  prev_head: string;
  chain_length: number;
  ts: string;
}

/** Payload for `failed_flip_suppressed`. */
export interface FailedFlipSuppressedPayload {
  ticket: string;
  evidence: 'fresh_artifacts' | 'ticket_commit' | 'both';
  suppression_count: number;
  ts: string;
}

/** Payload for `codegraph_session_summary`. */
export interface CodegraphSessionSummaryPayload {
  tickets: number;
  degraded_ops: number;
  index_status: 'healthy' | 'degraded' | 'latched' | 'disabled';
  /** b1089e97: per-session count of `codegraph_context_injected` emissions. */
  injected?: number;
  /** b1089e97: per-session count of `codegraph_context_skipped` emissions. */
  skipped?: number;
  ts: string;
}

/**
 * b1089e97: reasons a productive `codegraph_context_skipped` is emitted (NOT `disabled`/`degraded`).
 * AC-CGH-A1: `query_timeout` (batch runner group-killed on timeout) and `query_failed`
 * (child crash / ENOENT / unparseable stdout) join the productive-skip set — the section
 * build returns '' and never throws when the killable subprocess boundary degrades.
 * 2e632f9a: `stale_refs` fires when `ranked.length > 0` but node-level fs verification
 * (existence + line-range) drops every located node before `nodeLocation` renders —
 * distinct from `zero_hits` (genuinely empty `ranked`, or the render-empty PATTERN_SHAPE
 * branch after byte-cap truncation).
 */
export type CodegraphContextSkipReason =
  | 'no_service'
  | 'non_graph_tier'
  | 'no_terms'
  | 'zero_hits'
  | 'query_timeout'
  | 'query_failed'
  | 'stale_refs';

/** Payload for `codegraph_context_injected` (buildCodegraphContextSection success path). */
export interface CodegraphContextInjectedPayload {
  event: 'codegraph_context_injected';
  ts: string;
  ticket: string;
  tier: string;
  terms_count: number;
  hits_count: number;
  /** Post-cap length (bytes) of the rendered section. */
  bytes: number;
  /** Finite non-negative duration wrapping the build body. */
  build_ms: number;
  /** 2e632f9a: nodes dropped by node-level staleness verification, even though injection still fired. */
  dropped_stale?: number;
}

/** Payload for `codegraph_context_skipped` (productive-skip branches only). */
export interface CodegraphContextSkippedPayload {
  event: 'codegraph_context_skipped';
  ts: string;
  reason: CodegraphContextSkipReason;
  /** 2e632f9a: full staleness-dropped count on the `stale_refs` reason. */
  dropped_stale?: number;
  /** 2e632f9a: per-rep ticket attribution on the `stale_refs` reason. */
  ticket?: string;
}

/**
 * CGH-3 (61d02c4e): one deterministic efficacy sample per probed ticket. The probe scores
 * a worker diff produced WITH vs WITHOUT the `## Code Graph Context` section.
 */
export interface CodegraphEfficacySamplePayload {
  event: 'codegraph_efficacy_sample';
  ts: string;
  ticket: string;
  /** Whether the worker prompt for this sample carried the `## Code Graph Context` section. */
  with_codegraph: boolean;
  /** Backticked refs in the diff that fail the `path_not_verified` resolver (check-readiness). */
  hallucinated_ref_count: number;
  /** Jaccard overlap of the diff's touched files vs the fixture's `expected_consumer_files`. */
  consumer_file_jaccard: number;
  /** Result of the full worker conformance gate (`runWorkerGate(...).ok`), NOT tsc-only. */
  gate_pass: boolean;
}

// ---------------------------------------------------------------------------
// Auto-Update Types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Session Map Types
// ---------------------------------------------------------------------------

/** A session map entry in current_sessions.json. Stores the session path and PID of the process that created it. */
export interface SessionMapEntry {
  sessionPath: string;
  pid: number;
}

export interface UpdateCheckCache {
  last_check_epoch: number;
  latest_version: string;
  current_version: string;
}

export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface ReleaseInfo {
  tagName: string;
  assets: ReleaseAsset[];
}

export interface UpdateSettings {
  auto_update_enabled: boolean;
  update_check_interval_hours: number;
}

export interface PickleSettings {
  default_codex_model?: string;
  enable_complexity_tiers?: boolean;
  pipeline_continue_on_phase_fail?: boolean;
  worker_gate_tier?: 'narrow' | 'fast' | 'full';
  worker_test_gate_timeout_ms?: number;
  worker_mcp_config_path?: string | null;
  worker_mcp_snapshot_servers?: string[];
  /** Ticket 90574654: additive runtime-recovery hardening block (see HardeningSettings). */
  hardening?: { silent_death_respawn_cap?: number } | null;
  /** C2: codegraph integration settings block (see CodegraphSettings). */
  codegraph?: CodegraphSettings;
  /** Ticket e9bdac75: rate-limit park controls block (see RateLimitSettings). */
  rate_limit?: RateLimitSettings;
  [key: string]: unknown;
}

export type UpdateStatus = 'up-to-date' | 'update-available' | 'error';

export interface UpdateResult {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion?: string;
  error?: string;
}

export interface UpgradeResult {
  success: boolean;
  error?: string;
  exitCode?: number;
  aborted?: boolean;
}

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
] as const;

export type MicroverseExitReason = typeof MICROVERSE_EXIT_REASONS[number];

export const MICROVERSE_FATAL_REASONS = [
  'session_state_corrupted',
] as const;

export type MicroverseFatalReason = typeof MICROVERSE_FATAL_REASONS[number];

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
  'state_schema_version_ahead', 'closer_handoff_terminal',
  'done_without_commit_evidence', 'codex_manager_no_progress', 'recovery_exhausted',
  'idle_stall_unrecoverable', 'state_working_dir_missing', 'toolchain_unavailable',
] as const;

/**
 * B-CRASHFLOOR: the pickle-phase crash floor — exit reasons meaning the runner cannot physically
 * continue. Consulted by `isFatalPhaseFailure`'s pickle arm in pipeline-runner.ts, mirroring how the
 * microverse arm consults `MICROVERSE_FATAL_REASONS`. MUST NOT be `FAILURE_EXIT_REASONS`
 * (mux-runner.ts) — that set includes quality/measurement verdicts (error, stall, circuit_open,
 * rate_limit_exhausted, timeout_repeat, ...) which CLAUDE.md's park-and-flag rule forbids halting on.
 */
export const CRASH_FLOOR_EXIT_REASONS = [
  'toolchain_unavailable', 'state_working_dir_missing', 'state_schema_version_ahead',
] as const;

/**
 * R-WSRC-2 — Forward-schema state.json exit reason consumed by mux-runner.
 * Written by `recordExitReason(statePath, STATE_SCHEMA_VERSION_AHEAD_EXIT_REASON)`
 * when `sm.read()` throws `SchemaVersionAheadError`/`SCHEMA_MISMATCH`. Listed
 * in the mux-runner `ExitReason` union and `isFailureExit` set. It is a
 * fatal-but-operator-recoverable state, not a microverse-class failure — it is
 * not a `MicroverseExitReason` at all, so it carries no microverse disposition.
 * auto-resume.sh
 * R-CNAR-4(c) stops on this exit reason because it is in `isFailureExit`.
 */
export const STATE_SCHEMA_VERSION_AHEAD_EXIT_REASON = 'state_schema_version_ahead' as const;
export type StateSchemaVersionAheadExitReason = typeof STATE_SCHEMA_VERSION_AHEAD_EXIT_REASON;

export interface MicroverseMetric {
  description: string;
  validation: string;
  type: 'command' | 'llm' | 'none';
  timeout_seconds: number;
  tolerance: number;
  direction?: 'higher' | 'lower';
  judge_model?: string;
}

export type FailureClass = 'tool_failure' | 'approach_exhaustion' | 'regression' | 'metric_unstable' | 'no_progress';

export type StallCategory = 'worker_timeout' | 'tests_red_no_progress' | 'circular_revert' | 'external_blocker';

export type StallRecoveryAction = 'escalate_timeout' | 'prompt_guidance' | 'reset_to_baseline' | 'halt';

export interface StallClassification {
  category: StallCategory;
  recovery_action: StallRecoveryAction;
}

export interface ClassifiedFailure {
  iteration: number;
  failure_class: FailureClass;
  description: string;
  timestamp: string;
}

export interface MicroverseHistoryEntry {
  iteration: number;
  metric_value: string;
  score: number;
  action: 'accept' | 'revert';
  description: string;
  pre_iteration_sha: string;
  timestamp: string;
  judge_backend_used?: Extract<Backend, 'claude' | 'codex'>;
  classification?: 'improved' | 'held' | 'regressed';
  failure_class?: FailureClass;
}

/** Stable violation record passed to buildJudgePrompt to suppress re-reporting of known issues. */
export interface ViolationLedger {
  id: string;
  path?: string;
  line?: number;
  rule?: string;
  first_seen_iter: number;
  last_seen_iter: number;
  severity: 'high' | 'med' | 'low';
  description: string;
}

/** Single violation item returned by the LLM judge in structured output mode. */
export interface Violation {
  id: string;
  path?: string;
  line?: number;
  rule?: string;
  severity: 'high' | 'med' | 'low';
  description: string;
}

/** Return type of parseLlmJudgeOutput — discriminated by shape. */
export interface JudgeResult {
  score: number | null;
  violations: Violation[];
  resolved: string[];
  new: string[];
  remaining: string[];
  shape: 'full' | 'legacy' | 'malformed' | 'partial';
  /**
   * Why the parse degraded, set on 'malformed'/'partial' only. Carried out of the
   * parser so the runtime caller can emit `judge_json_parse_failed` without
   * re-parsing; the parser itself stays free of activity-log I/O.
   */
  parse_error_message?: string;
  /**
   * Keys of the raw judge object, set on 'legacy' only. Carried out of the parser
   * for the same reason as `parse_error_message`: the runtime caller emits
   * `judge_legacy_shape_inferred` without re-parsing the raw output, and the parser
   * stays free of activity-log I/O.
   */
  legacy_raw_keys?: string[];
}

export interface MicroverseSessionState {
  status: 'gap_analysis' | 'iterating' | 'converged' | 'stopped';
  prd_path: string;
  key_metric: MicroverseMetric;
  convergence: {
    stall_limit: number;
    stall_counter: number;
    history: MicroverseHistoryEntry[];
  };
  gap_analysis_path: string;
  judge_context_path?: string;
  failed_approaches: string[];
  baseline_score: number;
  convergence_target?: number;
  convergence_mode?: 'metric' | 'worker';
  convergence_file?: string;
  allowed_paths?: string[];
  exit_reason?: string;
  stash_ref?: string;
  failure_history: ClassifiedFailure[];
  approach_exhaustion_fired: boolean;
  iteration_regressions?: number;
  gate_regression_threshold_warning_emitted?: boolean;
  consecutive_amnesiac_exits?: number;
  consecutive_subprocess_errors?: number;
  violation_ledger?: ViolationLedger[];
  current_subsystem?: string;
}

// ---------------------------------------------------------------------------
// Gate Types
// ---------------------------------------------------------------------------

export interface GateFailure {
  check: 'typecheck' | 'lint' | 'tests';
  file: string;
  line: number;
  ruleOrCode: string;
  message: string;
  severity: 'error' | 'warning';
  occurrence_index: number;
}

export type GateMode = 'baseline' | 'strict';

export interface GateResult {
  status: 'green' | 'red' | 'green-with-known-flake-warnings';
  failures: GateFailure[];
  baseline_used: boolean;
  allowed_paths_used: boolean;
  elapsed_ms: number;
  total_raw_failure_count: number;
  new_failures_vs_baseline: number;
  /**
   * AP-EXT-ITER7-01: per-check `ran`/`skipped`/`failed`, the SAME map
   * `GateBaselineFile.check_status` persists — surfaced in-memory so a caller can ask whether a
   * check produced a real measurement instead of inferring it from the ABSENCE of failures, which
   * a `<timeout>` pseudo-failure makes a lie. Read it through a shared predicate owned by
   * `convergence-gate.ts` — `hasUnmeasuredCheck` (did a check FAIL to measure?) or
   * `isCheckUnmeasured` (do I hold positive evidence THIS check ran?) — never a locally-derived
   * second one in a consumer.
   *
   * AP-EXT-ITER7-02: it is now TOTAL over `runGate`'s exits. The skip family (off-repo
   * `earlyResult`, `no_project_type_detected`, `project_type_low_confidence`,
   * `workerModeSkipResult`, `gitDriftResult`) attempts no check, so it declares every requested
   * check `'skipped'` rather than returning green with no record at all. OPTIONAL only because a
   * TEST DOUBLE standing in for `runGate` may omit it; absent therefore means "not produced by
   * runGate", and no real gate result can read as "everything ran" without saying so.
   */
  check_status?: Partial<Record<'typecheck' | 'lint' | 'tests', 'ran' | 'skipped' | 'failed'>>;
}

export interface GateBaselineFile {
  schema_version: 1;
  captured_at: string;
  captured_iteration?: number;
  working_dir: string;
  project_type: 'pnpm' | 'npm' | 'yarn' | 'cargo' | 'go' | 'bun' | null;
  checks: ('typecheck' | 'lint' | 'tests')[];
  failures: GateFailure[];
  check_status?: Partial<Record<'typecheck' | 'lint' | 'tests', 'ran' | 'skipped' | 'failed'>>;
}

export interface RemediationResult {
  iso: string;
  failures_in: number;
  failures_out: number;
  auto_fixes_applied: number;
  hand_fixes_applied: number;
  aborted: boolean;
  abort_reason: string | null;
  production_coverage_test_path: string | null;
  elapsed_ms: number;
}

export interface CreateMicroverseOpts {
  prdPath: string;
  metric: MicroverseMetric;
  stallLimit: number;
  convergenceTarget?: number;
  convergenceMode?: 'metric' | 'worker';
  convergenceFile?: string;
  allowedPaths?: string[];
}

// ---------------------------------------------------------------------------
// DOT Builder Types
// ---------------------------------------------------------------------------

export {
  AttrType,
  AttrScope,
  AttrDef,
  ATTRACTOR_SCHEMA_FALLBACK,
  ALL_ATTRS,
  AttrValidation,
  lookupAttr,
  validateAttrType,
  validateAttrs,
} from './attractor-schema.fallback.js';

export type BuildErrorCode =
  | 'EMPTY_SLUG'
  | 'EMPTY_GOAL'
  | 'DUPLICATE_PHASE'
  | 'INVALID_RATCHET'
  | 'NON_NUMERIC_TARGET'
  | 'ALREADY_BUILT'
  | 'INVALID_STRUCTURE'
  | 'START_HAS_INCOMING'
  | 'UNREACHABLE_NODE'
  | 'DIAMOND_MISSING_EDGES'
  | 'GOAL_GATE_NO_MAX_VISITS'
  | 'MISSING_AC_MAPPING'
  | 'MISSING_TIMEOUT'
  | 'PROMPT_PATH_MISMATCH'
  | 'REVIEW_MISSING_READONLY'
  | 'COMPONENT_NO_MERGE'
  | 'FAN_OUT_SCOPE_LEAK'
  | 'WORKSPACE_NO_HTTPS'
  | 'WORKSPACE_NO_PUSH'
  | 'PLAN_MODE_DEADLOCK'
  | 'MISSING_ALLOWED_PATHS'
  | 'INVALID_SPEC'
  | 'INVALID_TIMEOUT'
  | 'INVALID_ALLOWED_PATHS'
  | 'DUPLICATE_MODEL'
  | 'INVALID_CONVERGENCE_SPEC';

export interface Diagnostic {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  nodeId?: string;
  edge?: [string, string];
  fix?: string;
}

export interface ValidationResult {
  valid: boolean;
  diagnostics: Diagnostic[];
}

export class BuildError extends Error {
  readonly code: BuildErrorCode;
  readonly diagnostics: Diagnostic[];
  constructor(code: BuildErrorCode, message: string, diagnostics: Diagnostic[] = []) {
    super(message);
    this.name = 'BuildError';
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export interface MicroverseOpts {
  prompt: string;
  measureCommand: string;
  target: number;
  direction: 'reduce' | 'improve';
  allowedPaths: string[];
  timeout?: string;
  maxVisits?: number;
}

export interface WorkspaceOpts {
  repoUrl?: string;
  repoBranch?: string;
  cleanup?: 'delete' | 'preserve';
}

export interface StylesheetOverride {
  selector: string;
  model: string;
  effort?: string;
}

export interface StylesheetConfig {
  defaultModel: string;
  defaultEffort?: string;
  overrides?: StylesheetOverride[];
  defaultProvider?: string;
  criticalModel?: string;
  criticalProvider?: string;
  reviewModel?: string;
  reviewProvider?: string;
  reasoningEffort?: string;
}

export interface ConvergenceSpec {
  until: 'V_total == 0' | 'V_total == 0 && fixed_point' | 'V_total == 0 && fixed_point && reproducibility';
  maxVisits?: number;
  timeout?: string;
  impl: {
    harness: 'hermes' | 'claude-code';
    prompt: string;
  };
  sealedFromSource?: string;
  fixBackend?: {
    model: string;
    harness: 'hermes' | 'claude-code';
    prompt: string;
    timeout?: string;
    maxVisits?: number;
  };
  fixFrontend?: {
    model: string;
    harness: 'hermes' | 'claude-code';
    prompt: string;
    timeout?: string;
    maxVisits?: number;
  };
  mechanicalGates?: {
    buildApi?: string;
    testsApi?: string;
    buildUi?: string;
    lint?: string;
  };
  reviewers?: {
    be?: { model: string; harness: 'hermes' | 'claude-code'; prompt: string; timeout?: string; maxVisits?: number };
    fe?: { model: string; harness: 'hermes' | 'claude-code'; prompt: string; timeout?: string; maxVisits?: number };
    int?: { model: string; harness: 'hermes' | 'claude-code'; prompt: string; timeout?: string; maxVisits?: number };
  };
  adversary?: {
    model: string;
    harness: 'hermes' | 'claude-code';
    prompt: string;
    sealedFromSource?: string;
    timeout?: string;
    maxVisits?: number;
  };
  fpVerify?: {
    command: string;
    timeout?: string;
    maxVisits?: number;
  };
  reproVerify?: {
    command: string;
    timeout?: string;
    maxVisits?: number;
  };
  convergenceEpsilon?: number;
  maxIterations?: number;
}

export interface PhaseSpec {
  name: string;
  prompt: string;
  allowedPaths: string[];
  severity?: 'error' | 'warning' | 'info';
  dependsOn?: string[];
  contextOnSuccess?: Record<string, string>;
  escalateOn?: string[];
  specFirst?: boolean;
  goalGate?: boolean;
  retryTarget?: string;
  timeout?: string;
  threadId?: string;
  securityScan?: boolean;
  coverageTarget?: number;
  competing?: boolean;
  redTeam?: boolean;
  bddScenarios?: boolean;
  deliverables?: string[];
  docOnly?: boolean;
  maxVisits?: number;
  verifyCommand?: string;
  permissionMode?: string;
  requirements?: string[];
  testExpectations?: { count: number; isolation: boolean };
  uiType?: 'crud' | 'dashboard' | 'form' | 'wizard';
}

export interface DefenseMatrix {
  competitive: boolean;
  guardrails: string[];
  specDriven: 'NONE' | 'conformance' | 'BDD + conformance' | 'spec_file + conformance' | 'spec_file + BDD + conformance';
  permissions: string[];
  adversarial: boolean;
}

export interface BuildResult {
  dot: string;
  slug: string;
  patternsApplied: string[];
  defenseMatrix: DefenseMatrix;
  diagnostics: Diagnostic[];
}

export interface BuilderSpec {
  slug: string;
  goal: string;
  phases: PhaseSpec[];
  acceptanceCriteria: Record<string, string>;
  workingDir?: string;
  label?: string;
  defaultMaxRetry?: number;
  workspace?: 'isolated';
  workspaceOpts?: WorkspaceOpts;
  microverse?: { name: string; opts: MicroverseOpts };
  reviewRatchet?: number;
  modelStylesheet?: StylesheetConfig;
  specFile?: string;
  endgame?: { broadPass?: boolean };
  convergence?: ConvergenceSpec;
}

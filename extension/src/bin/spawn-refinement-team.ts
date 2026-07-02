#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, spawn, spawnSync } from 'child_process';
import {
  printMinimalPanel,
  Style,
  formatTime,
  getExtensionRoot,
  getDataRoot,
  safeErrorMessage,
  classifyTicketTier,
  loadPickleSettingsBag,
  type TicketClassifierInfo,
  type TicketComplexityTier,
  VALID_TICKET_COMPLEXITY_TIERS,
} from '../services/pickle-utils.js';
import { StateManager, writeActivityEntry } from '../services/state-manager.js';
import { buildWorkerInvocation, isBackend, SpawnInvocation } from '../services/backend-spawn.js';
import { Backend, PromiseTokens, hasToken, Defaults, VALID_ACTIVITY_EVENTS, PipelineRunnerExitCode } from '../types/index.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';
import { runAcPhaseGate } from '../services/ac-phase-gate.js';
import { recoveryConsolidationEnabled } from './mux-runner.js';

// PRD refinement is planning, not implementation. Codex is reserved for
// implementation loops only — if the parent session opted into codex, we
// still force claude here so analysis stays on the Claude model family.
const REFINEMENT_BACKEND: Backend = 'claude';
const sm = new StateManager();

// Emit the codex-override warning at most once per process.
let _codexOverrideWarned = false;
export function __resetRefinementBackendWarning(): void {
  _codexOverrideWarned = false;
}

/**
 * Log a one-shot stderr warning if the parent session or env opted into codex.
 * Refinement always downgrades to claude regardless.
 *
 * Exported for tests; callers pass an explicit stateBackend (e.g. read from
 * state.json) so the check is deterministic and doesn't depend on test-run env.
 */
export function warnIfCodexRequested(stateBackend: unknown, envBackend: string | undefined): void {
  if (_codexOverrideWarned) return;
  if (stateBackend === 'codex' || envBackend === 'codex') {
    _codexOverrideWarned = true;
    process.stderr.write(
      '[pickle-rick] PRD refinement forces backend=claude (ignoring session/env preference "codex"). Refinement is planning, not implementation.\n'
    );
  }
}

/**
 * Build the spawn invocation for a single refinement worker. Hardcoded to
 * claude — NEVER resolveBackend — because refinement is planning, not
 * implementation.
 *
 * Exported for tests.
 */
export function buildRefinementWorkerInvocation(opts: {
  prompt: string;
  addDirs: string[];
  maxTurns: number;
  backend?: Backend;
  settingsBag?: { worker_mcp_config_path?: string | null };
}): SpawnInvocation {
  const invocation = buildWorkerInvocation(opts.backend ?? REFINEMENT_BACKEND, {
    prompt: opts.prompt,
    addDirs: opts.addDirs,
    settingsBag: opts.settingsBag,
  });
  // buildWorkerInvocation doesn't take max-turns for workers; splice it in
  // before the `-p <prompt>` trailer so the flag applies to the claude CLI.
  if (opts.maxTurns > 0) {
    const promptIdx = invocation.args.lastIndexOf('-p');
    const insertAt = promptIdx === -1 ? invocation.args.length : promptIdx;
    invocation.args.splice(insertAt, 0, '--max-turns', String(opts.maxTurns));
  }
  return invocation;
}

/**
 * Build the child-process env for a refinement worker. Explicitly sets
 * PICKLE_BACKEND=claude so any grandchild spawn also stays on claude even if
 * the parent session opted into codex. Do NOT spread backendEnvOverrides —
 * this helper is the single source of truth for the refinement env.
 *
 * Exported for tests.
 */
export function buildRefinementEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    PICKLE_BACKEND: REFINEMENT_BACKEND,
    // Sentinel lock: short-circuits resolveBackend / resolveBackendFromStateFile
    // in every grandchild to 'claude', even if state.json says codex. Prevents
    // a downstream loadBackendFromSession(sessionDir) read from bypassing the
    // env lock. See services/backend-spawn.ts resolveBackend() for details.
    PICKLE_REFINEMENT_LOCK: '1',
    PICKLE_ROLE: 'refinement-worker',
    PYTHONUNBUFFERED: '1',
  };
  delete env['CLAUDECODE'];
  return env;
}

// Tracks all active worker subprocesses so the signal handler can kill them.
const activeWorkerProcs = new Set<import('child_process').ChildProcess>();

const AC_SHAPE_PROMPT_SECTION = `## AC-Shape Smell Pass

Before finalizing your analysis, inspect every acceptance criterion for endpoint-enumeration shape:
- The AC headline lacks a universal quantifier: "all", "every", or "for any".
- The AC body has 3 or more bullets naming distinct endpoints, handlers, or methods.
- Those bullets repeat the same predicate.

For every matching AC, either collapse the decomposition to one parametrized ticket or justify why multiple tickets are necessary.

Emit a machine-readable section exactly named \`## ac_shape_smells\`. If no smells exist, emit empty arrays. The JSON shape is:
\`\`\`json
{
  "ac_shape_smells": [
    {
      "ac_id": "AC-EXAMPLE-01",
      "headline": "Original AC headline",
      "evidence": ["bullet or PRD reference"],
      "targets": ["endpointOrHandlerA", "endpointOrHandlerB", "endpointOrHandlerC"],
      "repeated_predicate": "same predicate repeated across targets",
      "ticket_ids": ["ticket-id-if-known"]
    }
  ],
  "tickets": [
    {
      "id": "ticket-id",
      "title": "All handlers enforce the shared invariant",
      "source_ac_ids": ["AC-EXAMPLE-01"],
      "acceptance_test": "describe.each([...]) covers every enumerated target",
      "justification": "// JUSTIFICATION: Required only when this smelly AC intentionally fans out into multiple tickets."
    }
  ]
}
\`\`\``;

const TICKET_COMPLEXITY_PROMPT_SECTION = `## Ticket Complexity Classification

For each ticket, assign a complexity_tier in the frontmatter:
- trivial: Single-file text change, no logic, no tests needed (prompt edits, config tweaks)
- small: 1-2 files, straightforward logic, type-only or minimal tests
- medium: 2-4 files, moderate logic, requires unit tests
- large: 4+ files, complex integration, multiple test files, cross-cutting concerns
`;

export function buildTierClassificationSection(): string {
  return TICKET_COMPLEXITY_PROMPT_SECTION;
}

// Activity event schema catalog injected into the codebase-analyst prompt so
// codex workers consuming claude-authored tickets know the canonical event names
// and required payload fields (AC-EVENT-PAYLOAD-01 / R-XBL-9).
export const ACTIVITY_EVENT_SCHEMA_SECTION = `## Activity Event Schema Reference

When writing acceptance criteria or analyzing PRD sections that reference activity events, use EXACT event names from this catalog. Codex workers implementing tickets need precise names to wire up correctly. All events validate against \`extension/src/types/activity-events.schema.json\` (AC-EVENT-PAYLOAD-01).

| Event | Key Payload Fields | Primary Emitter |
|-------|-------------------|-----------------|
| \`worker_spawn_backend_resolved\` | \`backend\`, \`source\`, \`pid\` | spawn-morty, spawn-refinement-team, microverse-runner, mux-runner |
| \`signal_received\` | \`source\`, \`session\`, \`signal\`, \`pid\`, \`ppid\`, \`is_tty\`, \`received_at_iso\`, \`handler_stack\`, \`gate_payload.signal_sender_pid\`, \`gate_payload.signal_sender_cmd\` | mux-runner, pipeline-runner shutdown path |
| \`worker_partial_lifecycle_exit\` | \`ticket\`, \`gate_payload.artifacts_missing\`, \`gate_payload.session_log_size\` | spawn-morty worker exit path |
| \`worker_gate_verdict_fail_closed\` | \`ticket_id\`, \`gate_payload.verdict\`, \`gate_payload.computed_via\` | mux-runner guardCompletionCommitBeforeDone fail-closed Done-flip path |
| \`judge_measurement_attempted\` | \`session\`, \`iteration\`, \`backend\`, \`judge_backend\`, \`model\`, \`fallback_activated\`, \`spawn_context\`, \`gate_payload.attempt\`, \`gate_payload.elapsed_ms\`, \`gate_payload.outcome\`, \`gate_payload.timeout_class\`, \`gate_payload.probe_kind\` | microverse-runner LLM judge retry loop |
| \`baseline_attempt_timeout\` | \`session\`, \`gate_payload.attempt\`, \`gate_payload.elapsed_ms\`, \`gate_payload.classifier\` | microverse-runner LLM timeout retry loop |
| \`pipeline_auto_resumed\` | \`gate_payload.retry_index\`, \`gate_payload.ticket_id\`, \`gate_payload.session_done_count_at_retry\` | mux-runner auto-resume path |
| \`bundle_bootstrap_exemption_applied\` | \`gate_payload.skip_readiness_reason\`, \`gate_payload.skip_ticket_audit_reason\` | mux-runner bootstrap-mode path |
| \`ticket_audit_bypassed\` | \`reason\` | audit-ticket-bundle.js, readiness gate |
| \`ticket_audit_failed\` | \`session\` (optional) | mux-runner ticket-audit halt path |
| \`ticket_audit_manual_edit\` | \`gate_payload.edit_count\` | mux-runner audit loop |
| \`smoke_gate_bypassed\` | \`reason\` | mux-runner smoke-gate path |
| \`tsc_gate_failed\` | \`reason\`, \`gate_payload.failure_kind\`, \`gate_payload.command\` | tsc-gate PreToolUse hook block path |
| \`tsc_gate_override_used\` | \`gate_payload.override_reason\`, \`gate_payload.failure_kind\`, \`gate_payload.command\` | tsc-gate PreToolUse hook override path |
| \`tsc_gate_override_consumed\` | \`gate_payload.override_reason\`, \`gate_payload.command\` | tsc-gate PreToolUse hook clean-pass auto-clear path |
| \`tsc_gate_crashed\` | \`gate_payload.failure_kind\`, \`gate_payload.error\`, \`gate_payload.command\` | tsc-gate PreToolUse hook fail-open crash path |
| \`manager_turn_progress\` | \`session\`, \`ticket_id\` | mux-runner manager-turn freshness heartbeat (R-SJLAG) |
| \`manager_max_turns_relaunch\` | \`backend\`, \`relaunch_count\`, \`cap\`, \`pending_count\`, \`last_ticket_seen\` | manager-relaunch Claude max-turn relaunch path |
| \`anatomy_park_empty_scope_skip\` | \`session\`, \`gate_payload.in_scope_paths\`, \`gate_payload.discovered_subsystems\` | pipeline-runner resolveAnatomySubsystems empty-scope skip |
| \`szechuan_sauce_empty_scope_skip\` | \`session\`, \`gate_payload.in_scope_paths\` | pipeline-runner setupSzechuanSauce code-free-scope skip |
| \`resolver_indeterminate\` | \`session\`, \`gate_payload.wall_ms\`, \`gate_payload.budget_ms\`, \`gate_payload.phase\` | check-readiness runReadiness over-wall-budget resolver path (warn, non-blocking) |
| \`readiness_false_positive_suppressed\` | \`session\`, \`gate_payload.suppressed_count\`, \`gate_payload.suppressed\` | check-readiness runReadiness — a prior blocking finding absent on re-run (observability, non-blocking) |

| \`setup_resume_ticket_status_preserved\` | \`ticket_id\`, \`observed_status\`, \`expected_status\`, \`reason\` | setup.ts resume path (default, preserves operator edit) |
| \`setup_resume_overrode_ticket_status\` | \`ticket_id\`, \`prior_status\`, \`new_status\`, \`source\` | setup.ts --force-ticket-status-sync path |
| \`head_mismatch_detected\` | \`gate_payload.pinned_branch\`, \`gate_payload.observed_branch\`, \`gate_payload.pinned_sha\`, \`gate_payload.observed_sha\`, \`gate_payload.detected_at_phase\` | mux-runner checkHeadPinMismatch path |
| \`stale_index_lock_cleaned\` | \`gate_payload.path\`, \`gate_payload.mtime\`, \`gate_payload.age_seconds\` | cancel.ts cleanupStaleIndexLock |
| \`stale_index_lock_held_by_live_process\` | \`gate_payload.path\`, \`gate_payload.mtime\`, \`gate_payload.age_seconds\`, \`gate_payload.holder_pid\`, \`gate_payload.holder_command\` | cancel.ts cleanupStaleIndexLock |
| \`concurrent_git_access_detected\` | \`gate_payload.repo_root\`, \`gate_payload.holder_pid\`, \`gate_payload.holder_command\` | setup.ts new-session bootstrap advisory probe |
| \`setup_resume_chdir_applied\` | \`gate_payload.from\`, \`gate_payload.to\` | setup.ts validateResumeCompatibility cross-cwd path |
| \`ticket_runnability_resolved\` | \`ticket_id\`, \`gate_payload.frontmatter_status\`, \`gate_payload.runnable\`, \`gate_payload.reason\` | mux-runner per-iteration ticket-selection path |
| \`codex_manager_self_bootstrap_attempted\` | \`ticket\`, \`attempted_argv\`, \`iteration\`, \`action_taken\` | codex-manager self-bootstrap guard (R-CCPM-1) |
| \`orphan_test_runner_reaped\` | \`pid\`, \`etime_seconds\`, \`argv_summary\` | mux-runner startup orphan fast-test reaper |
| \`worker_orphan_reaped\` | \`pid\`, \`pgid\`, \`etime_seconds\`, \`owning_session\`, \`argv_summary\` | setup-time orphan-worker reaper (R-CXHANG session-GC) |
| \`child_mux_runner_wedge_detected\` | \`session\`, \`gate_payload.child_pid\`, \`gate_payload.last_state_mtime_iso\`, \`gate_payload.elapsed_seconds\` | pipeline-runner child-stall heartbeat |
| \`orphan_session_detected\` | \`orphan_session_path\`, \`orphan_started_at\`, \`parent_session_hash\`, \`orphan_pid\` | session-map orphan detection (R-CCPM-3) |
| \`session_map_collision_blocked\` | \`existing_session_path\`, \`existing_pid\`, \`attempted_session_path\`, \`attempted_pid\`, \`cwd\` | session-map collision guard (R-CCPM-4) |
| \`pickle_command_deprecated\` | (none beyond event+ts) | pickle-deprecated.js bare-/pickle invocation |
| \`ac_shape_gate_bypassed\` | \`gate_payload.reason\` | spawn-refinement-team AC-shape gate bypass path |
| \`refinement_over_collapse_detected\` | \`gate_payload.composed_count\`, \`gate_payload.ticket_count\`, \`gate_payload.sources_with_atomic_section\` | spawn-refinement-team post-decomp bundle-of-bundles over-collapse guard |

| \`completion_finalize_refused\` | \`gate_payload.pending_count\`, \`gate_payload.ticket_count\`, \`gate_payload.seam\` | state-manager finalizeIfTrulyComplete — completion authority refused a finalize while work is pending (refused-and-recovered, informational) (forward-created) |
| \`phase_graduation_refused\` | \`gate_payload.pending_count\`, \`gate_payload.done_count\`, \`gate_payload.exit_code\` | pipeline-runner maybeStampPhaseGraduation — proportional gate refused phase graduation (refused-and-recovered, informational) (forward-created) |
| \`gate_parity_divergence\` | \`gate_payload.gate_a\`, \`gate_payload.gate_b\`, \`gate_payload.ref\` | forward-ref-annotation resolveExtensionRelativePath — the two extension-dir gates would have disagreed (refused-and-recovered, informational) (forward-created) |
| \`scope_auto_extended\` | \`gate_payload.added_paths\`, \`gate_payload.symbols\`, \`gate_payload.cap_hit\` | pipeline-runner setupScope build-phase bounded scope auto-extension (paths-mode; over-cap extends nothing) |

When writing ACs that assert event emission, include the full event name and required payload fields. Do NOT invent event names — use only the names listed here or already present in \`extension/src/types/index.ts:VALID_ACTIVITY_EVENTS\`.`;

export const BUNDLE_OF_BUNDLES_FANOUT_SECTION = `## Bundle-of-bundles fan-out

When the PRD frontmatter declares a \`composes:\` field, this PRD is a **bundle-of-bundles**: it composes one or more source PRDs, each of which may already carry its own atomic ticket decomposition.

**If a composed source PRD contains a \`## Atomic decomposition\` or \`## Atomic tickets\` section**, you MUST emit **one ticket per R-code** listed in that section — do NOT collapse multiple R-codes from one source into a single umbrella ticket, and do NOT invent R-codes that are not explicitly listed in the source.

Rules:
1. Scan every source PRD listed under \`composes:\`.
2. For each source that has a \`## Atomic decomposition\` or \`## Atomic tickets\` section, read the R-code list (e.g., \`R-FOO-1\`, \`R-FOO-2\`, …).
3. Emit one ticket per atomic R-code. The ticket title must reference the R-code directly.
4. If a source PRD has no atomic section, treat it as a single work item (one ticket for that source).
5. Never merge R-codes from the same source into one ticket.
6. Never create tickets for R-codes that do not appear in any source PRD.`;

const WORKER_ROLES = [
  { id: 'requirements' },
  { id: 'codebase' },
  { id: 'risk-scope' },
] as const;

type RoleId = (typeof WORKER_ROLES)[number]['id'];

export interface PortalContext {
  portalDir: string;
  patternSummaryLines: number;
}

export interface RefinementArgs {
  prdPath: string;
  sessionDir: string;
  timeout?: number;
  cycles?: number;
  maxTurns?: number;
  skipAcShapeGate?: string;
}

export interface RefinementSettings {
  defaultCycles: number;
  defaultMaxTurns: number;
  defaultWorkerTimeout: number;
}

export interface CycleResults {
  refinementDir: string;
  cyclesRequested: number;
  maxTurns: number;
  allCycleResults: WorkerResult[][];
  finalResults: WorkerResult[];
  allSuccess: boolean;
}

export interface AcShapeSmell {
  ac_id: string;
  headline?: string;
  evidence?: string[];
  targets?: string[];
  repeated_predicate?: string;
  ticket_ids?: string[];
  source_worker?: RoleId;
  source_file?: string;
}

export interface RefinementTicketManifestEntry {
  id: string;
  title: string;
  source_ac_ids: string[];
  source_prd?: string;
  source_section?: string;
  mapped_requirements?: string[];
  acceptance_test?: string;
  justification?: string;
  source_worker?: RoleId;
  source_file?: string;
  /** Authoritative complexity tier set by classifier (analyst hint may be overridden). */
  complexity_tier?: TicketComplexityTier;
}

export interface TicketQualityWarning {
  ticket_id: string;
  defect_class: string;
  evidence: string;
  source?: 'analyst' | 'post-decomp';
  file_line?: string | null;
}

export interface DecompositionQualityFlag {
  ticket_id: string;
  reason: 'large_tier' | 'open_ended_derivation';
  evidence: string;
  action: 'bounded_reframe' | 'pre_split';
  suggested_reframe: string;
}

export interface RefinementManifest {
  prd_path: string;
  refinement_dir: string;
  all_success: boolean;
  cycles_requested: number;
  cycles_completed: number;
  max_turns_per_worker: number;
  ac_shape_smells: AcShapeSmell[];
  tickets: RefinementTicketManifestEntry[];
  ticket_quality_warnings?: TicketQualityWarning[];
  decomposition_quality_flags?: DecompositionQualityFlag[];
  prd_advisory_shape_concerns?: string[];
  workers: {
    role: RoleId;
    success: boolean;
    output_file: string;
    exists: boolean;
    log_file: string;
    cycle: number;
  }[];
  completed_at: string;
}

export type SymbolAuditCategory = 'activity_event' | 'exit_code' | 'new_file' | 'helper_sentinel';

export interface SymbolAuditFinding {
  category: SymbolAuditCategory;
  symbol: string;
  sourceLine: number;
  reason: string;
}

export interface SymbolAuditReference {
  symbol: string;
  sourceLine: number;
  evidence: string;
  status: 'pass' | 'fail' | 'valid' | 'phantom';
  reason?: string;
}

export interface SymbolAuditReport {
  ok: boolean;
  activityEvents: SymbolAuditReference[];
  exitCodes: SymbolAuditReference[];
  newFiles: SymbolAuditReference[];
  helperSentinels: SymbolAuditReference[];
  findings: SymbolAuditFinding[];
}

export function runReadinessGate(sessionDir: string, workingDir: string, manifestPath: string): number {
  const binPath = path.join(getExtensionRoot(), 'extension', 'bin', 'check-readiness.js');
  if (!fs.existsSync(binPath)) return 0;
  const result = spawnSync(process.execPath, [
    binPath,
    '--session-dir', sessionDir,
    '--repo-root', workingDir,
    '--manifest', manifestPath,
    '--machinability-only',
    '--contract-only',
  ], {
    cwd: workingDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status ?? 1;
}

export interface AnchorCitation {
  sourceLine: number;
  filePath: string;
  lineNumber: number;
  raw: string;
}

export interface StaleAnchorWarning {
  citation: AnchorCitation;
  reason: 'missing-file' | 'line-out-of-range';
  detail: string;
}

const CITATION_RE = /(?<![\w./-])((?:\.{1,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|sh|py|css|scss|html)):(\d+)\b/g;

export function extractAnchorCitations(prdContent: string): AnchorCitation[] {
  const citations: AnchorCitation[] = [];
  const seen = new Set<string>();
  const lines = prdContent.split(/\r?\n/);
  lines.forEach((line, index) => {
    CITATION_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CITATION_RE.exec(line)) !== null) {
      const filePath = normalizeCitationPath(match[1]);
      const rawLineNumber = Number(match[2]);
      const lineNumber = Number.isFinite(rawLineNumber) ? rawLineNumber : 0;
      if (!Number.isSafeInteger(lineNumber) || lineNumber <= 0) continue;
      const key = `${filePath}:${lineNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      citations.push({
        sourceLine: index + 1,
        filePath,
        lineNumber,
        raw: match[0],
      });
    }
  });
  return citations;
}

function normalizeCitationPath(filePath: string): string {
  return filePath.replace(/^\.\//, '').replace(/\\/g, '/');
}

function readHeadFile(workingDir: string, filePath: string): string | undefined {
  try {
    return execFileSync('git', ['show', `HEAD:${filePath}`], {
      cwd: workingDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

export function findStaleAnchorWarnings(prdContent: string, workingDir: string): StaleAnchorWarning[] {
  return extractAnchorCitations(prdContent).flatMap((citation): StaleAnchorWarning[] => {
    const headContent = readHeadFile(workingDir, citation.filePath);
    if (headContent === undefined) {
      return [{
        citation,
        reason: 'missing-file' as const,
        detail: `not found at HEAD:${citation.filePath}`,
      }];
    }

    const lineCount = headContent === '' ? 0 : headContent.split(/\r?\n/).length;
    if (citation.lineNumber > lineCount) {
      return [{
        citation,
        reason: 'line-out-of-range' as const,
        detail: `line ${citation.lineNumber} exceeds HEAD line count ${lineCount}`,
      }];
    }

    return [];
  });
}

export function emitStaleAnchorWarnings(warnings: StaleAnchorWarning[]): void {
  if (warnings.length === 0) return;
  process.stderr.write(`[pickle-rick] stale-anchor warning: ${warnings.length} PRD citation(s) no longer resolve against HEAD.\n`);
  for (const warning of warnings) {
    const { citation } = warning;
    process.stderr.write(
      `[pickle-rick] stale-anchor ${citation.raw} (PRD line ${citation.sourceLine}): ${warning.detail}\n`
    );
  }
}

export interface PathVerificationWarning {
  type: 'path_not_verified';
  path: string;
}

// Parses analyst output for backtick file paths, checks each via git ls-files,
// and emits path_not_verified breadcrumbs for unclaimed non-existent paths.
// Section I will land these in refinement_manifest.json.ticket_quality_warnings[].
export function checkAnalystOutputPaths(
  content: string,
  workingDir: string
): PathVerificationWarning[] {
  const warnings: PathVerificationWarning[] = [];
  const backtickPathRe = /`([a-zA-Z][a-zA-Z0-9/_.-]*\/[a-zA-Z0-9/_.-]+)`/g;
  let match: RegExpExecArray | null;

  while ((match = backtickPathRe.exec(content)) !== null) {
    const citedPath = match[1];
    const result = spawnSync('git', ['ls-files', citedPath], {
      cwd: workingDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0 || result.stdout.trim() === '') {
      warnings.push({ type: 'path_not_verified', path: citedPath });
      process.stderr.write(`[pickle-rick] path_not_verified: ${citedPath}\n`);
    }
  }
  return warnings;
}

// R-DPMC-1 registration co-location: one general coupling rule (NOT a per-framework
// enumeration) that stops decomposition from cutting an unsatisfiable ticket — one
// that forward-creates a registerable symbol its same-ticket consumer needs, but omits
// the owning registry file the scope fence then (correctly) blocks. The decidable
// predicate keeps two analysts classifying the same ticket identically.
export const DECOMPOSITION_COLOCATION_PROMPT_SECTION = `## Registration co-location (decomposition coupling rule)

When a ticket forward-creates a **registerable symbol** AND a **same-ticket** file consumes it, the ticket's file allowlist MUST include the **registration site**. This is ONE general coupling rule — not a per-framework list.

**Decidable predicate** — a symbol is "registerable" when it is imported or instantiated by a same-ticket file whose usability requires enrollment in a separate container/registry file. If that registry file is omitted, the per-file scope fence will (correctly) block the registration edit and the ticket becomes unsatisfiable — a deadlock with zero commits.

**Worked examples of the one rule** (illustrative, not exhaustive):
- A NestJS \`@Injectable()\` provider consumed by a same-ticket controller → co-scope the owning \`*.module.ts\` (its \`providers\` array).
- A Drizzle schema table whose relations a same-ticket query needs → co-scope the \`relations.ts\` entry.
- A route handler a same-ticket file mounts → co-scope the router registration.

Do NOT defer the registration edit to a later "wiring" ticket — that strands every intermediate per-symbol ticket behind the scope fence. Do NOT loosen the fence; co-scope at decomposition time instead.`;

/**
 * Assemble the shared analyst prompt-guidance sections in their canonical order.
 * Extracted from buildWorkerPrompt to keep that function under the line ceiling;
 * the `\n` join reproduces the original inline template byte-for-byte.
 */
function buildPromptGuidanceSections(): string {
  return [
    buildTierClassificationSection(),
    AC_SHAPE_PROMPT_SECTION,
    DECOMPOSITION_COLOCATION_PROMPT_SECTION,
    BUNDLE_OF_BUNDLES_FANOUT_SECTION,
  ].join('\n');
}

export function buildWorkerPrompt(
  roleId: RoleId,
  prdContent: string,
  outputFile: string,
  workingDir: string,
  cycle: number,
  previousAnalyses?: Map<RoleId, string>,
  portalContext?: PortalContext,
): string {
  const persona = `You are Pickle Rick — hyper-competent, arrogant, ruthlessly thorough.
*Belch.* You are FORBIDDEN from being a Jerry. Jerries write vague analysis. You write SPECIFIC, ACTIONABLE findings with evidence.
CRITICAL RULE: You MUST output a text explanation ("brain dump") before every single tool call.`;

  const roleInstructions: Record<RoleId, string> = {
    requirements: `## Your Role: Requirements Analyst Morty

Analyze the PRD EXCLUSIVELY for requirements completeness:
1. **Critical User Journeys (CUJs)**: Are all major user flows documented? Are they step-by-step enough for engineering to implement without guessing?
2. **Functional Requirements Table**: Are P0/P1/P2 requirements complete? Are there obvious missing use cases, alternate flows, or error scenarios?
3. **Acceptance Criteria**: Can each requirement be tested? Are success states and failure states defined?
4. **Edge Cases & Boundary Conditions**: What empty states, error states, race conditions, or limits are missing?
5. **User Stories**: Are "As a user, I want..." stories specific enough to code against, or are they vague aspirations?

DO NOT analyze risks, scope, technical architecture, or codebase. That's other Mortys' territory.`,

    codebase: `## Your Role: Codebase Context Analyst Morty

Analyze alignment between the PRD and the actual codebase at: \`${workingDir}\`

1. **Research the codebase** — use Glob/Grep/Read to find relevant files. Map existing patterns.
2. **PRD Assumptions**: Does the PRD assume components that don't exist? Does it ignore existing patterns it should follow?
3. **Technical Constraints**: What existing APIs, data models, or architectural decisions affect this PRD? Are they documented in the PRD?
4. **Integration Points**: What existing components will this feature touch? Are those interactions specified?
5. **Missing Technical Context**: What technical decisions does the PRD leave unspecified that engineering will have to guess at?

Use file:line references for every codebase claim. If the codebase is empty/irrelevant, say so explicitly and note what the PRD should specify instead.`
      + (portalContext && roleId === 'codebase' ? `

## Portal Artifacts

This PRD was generated by portal-gun from a donor codebase. The following portal artifacts are available for cross-reference:
- Pattern analysis: \`${portalContext.portalDir}/pattern_analysis.md\`
- Target analysis: \`${portalContext.portalDir}/target_analysis.md\`
- Donor source: \`${portalContext.portalDir}/donor/\`

Read these artifacts to validate PRD claims against the actual donor code and target analysis.` : '')
      + `\n\n${ACTIVITY_EVENT_SCHEMA_SECTION}`,

    'risk-scope': `## Your Role: Risk & Scope Auditor Morty

Analyze the PRD EXCLUSIVELY for risks, scope, and assumptions:
1. **Scope Clarity**: Is "In-scope" specific enough? Can you tell exactly what will and won't be built? Grade each item on specificity (vague/clear/precise).
2. **Non-Goals / Scope Creep**: Are non-goals clearly stated? Is there scope creep hiding in vague requirements?
3. **Risk Completeness**: Are all major technical, product, and operational risks identified? Is "Risks: None" a lie?
4. **Mitigation Quality**: For each risk, is the mitigation concrete or hand-wavy ("we'll monitor it")?
5. **Assumptions**: Are all key assumptions documented? What hidden assumptions are baked into the PRD that could blow up if wrong?
6. **External Dependencies**: What APIs, third-party services, or other teams are mentioned but under-specified?

DO NOT analyze feature completeness or codebase patterns. That's other Mortys' jobs.`,
  };

  // Build the cross-reference section for cycle 2+
  let crossRefSection = '';
  if (cycle > 1 && previousAnalyses && previousAnalyses.size > 0) {
    const roleLabels: Record<RoleId, string> = {
      requirements: 'Requirements Analyst',
      codebase: 'Codebase Context Analyst',
      'risk-scope': 'Risk & Scope Auditor',
    };

    crossRefSection = `\n## Previous Cycle Analyses (Cycle ${cycle - 1} — Cross-Reference These)

Your team already ran a previous analysis pass. You have access to ALL analysts' findings below.

**Your mission for this deeper pass:**
1. **Go DEEPER** on issues that were identified but under-explored — add specifics, evidence, examples
2. **CROSS-REFERENCE** findings from other analysts that affect your domain
3. **CHALLENGE** your own previous analysis — did you miss anything? Were severity ratings accurate?
4. **ELIMINATE DUPLICATES** — if another analyst covered something in your domain, acknowledge it rather than repeating
5. **RAISE NEW ISSUES** discovered only by seeing the full picture across all analyses

`;

    for (const [id, content] of previousAnalyses) {
      const label = roleLabels[id] || id;
      const isOwn = id === roleId;
      crossRefSection += `### ${label}'s Previous Findings${isOwn ? ' (YOUR OWN — improve on this)' : ''}:
\`\`\`markdown
${content}
\`\`\`

`;
    }
  }

  const cycleNote = cycle > 1
    ? `\n**THIS IS CYCLE ${cycle}** — you are deepening a previous analysis. Your output should be MORE SPECIFIC, MORE EVIDENCE-BACKED, and CROSS-REFERENCED with other analysts' findings.\n`
    : '';

  const outputInstructions = `${buildPromptGuidanceSections()}

## Your Output

Write ALL findings to this file: ${outputFile}
${cycleNote}
Use this EXACT structure:

\`\`\`markdown
# PRD Analysis: [Your Role Name]${cycle > 1 ? ` (Cycle ${cycle})` : ''}

**Date**: [Today's date]
**Analyst**: [Your Role Name]
**Cycle**: ${cycle}

## Executive Summary
[2-3 sentence overview of the PRD's quality in your domain. Be specific — not "needs improvement" but "missing 3 P0 CUJs and acceptance criteria for all requirements".]

## Critical Gaps (P0 — Must Fix)
- **[Gap Title]**: [Specific description with PRD section reference]. [Why this is critical.]

## Important Gaps (P1 — Should Fix)
- **[Gap Title]**: [Specific description]. [Impact if ignored.]

## Minor Issues (P2 — Nice to Fix)
- [Brief description]

## ac_shape_smells
\`\`\`json
{ "ac_shape_smells": [], "tickets": [] }
\`\`\`

## Specific Recommendations
[Concrete, actionable suggestions. For P0 gaps, provide example language the PRD author can paste in.]${cycle > 1 ? `

## Cross-Reference Notes
[What you found by reading other analysts' work that affects your domain]` : ''}
\`\`\`

After writing the file, output: <promise>${PromiseTokens.ANALYSIS_DONE}</promise>
Then STOP IMMEDIATELY. Do not attempt to rewrite the PRD.`;

  return `${persona}

${roleInstructions[roleId]}
${crossRefSection}
---

## The PRD You Are Analyzing

\`\`\`markdown
${prdContent}
\`\`\`

---

${outputInstructions}`;
}

interface WorkerResult {
  roleId: RoleId;
  success: boolean;
  logPath: string;
  cycle: number;
  exitCode: number | null;
}

function spawnWorker(
  roleId: RoleId,
  prompt: string,
  refinementDir: string,
  extensionRoot: string,
  timeout: number,
  workingDir: string,
  maxTurns: number,
  cycle: number,
  onComplete: (result: WorkerResult) => void,
  sessionDir?: string
): Promise<WorkerResult> {
  const logPath = path.join(refinementDir, `worker_${roleId}_c${cycle}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'w' });
  logStream.on('error', (err) => {
    const msg = safeErrorMessage(err);
    console.error(`${Style.RED}❌ Log stream error (${roleId}): ${msg}${Style.RESET}`);
  });

  // Mirror spawn-morty.ts: include extensionRoot, data root, and workingDir.
  // buildRefinementWorkerInvocation filters out non-existent dirs internally.
  const includes = [extensionRoot, getDataRoot(), workingDir];
  if (sessionDir) includes.push(sessionDir);
  const statePath = sessionDir ? path.join(sessionDir, 'state.json') : null;
  if (statePath) {
    let managerBackend: Backend = REFINEMENT_BACKEND;
    try {
      const state = sm.read(statePath) as { backend?: unknown; worker_backend?: unknown } | null;
      if (isBackend(state?.backend)) managerBackend = state.backend;
    } catch {
      /* keep claude fallback */
    }
    try {
      writeActivityEntry(statePath, {
        event: 'worker_backend_resolved',
        ts: new Date().toISOString(),
        backend: managerBackend,
        worker_backend: null,
        source: 'env_lock',
      });
    } catch {
      /* best-effort telemetry */
    }
  }
  const invocation = buildRefinementWorkerInvocation({
    prompt,
    addDirs: includes,
    maxTurns,
    backend: REFINEMENT_BACKEND,
    settingsBag: loadPickleSettingsBag() ?? undefined,
  });

  const env = buildRefinementEnv(process.env);

  const proc = spawn(invocation.cmd, invocation.args, {
    cwd: workingDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeWorkerProcs.add(proc);

  // Use { end: false } so that when stdout ends first it doesn't call
  // logStream.end(), which would discard any stderr data still in-flight.
  // logStream.end() is called explicitly in the 'close' and 'error' handlers.
  proc.stdout?.pipe(logStream, { end: false });
  proc.stderr?.pipe(logStream, { end: false });

  // SIGTERM first, escalate to SIGKILL after 2s if still alive
  let workerTimedOut = false;
  let killEscalation: ReturnType<typeof setTimeout> | null = null;
  const timeoutHandle = setTimeout(() => {
    workerTimedOut = true;
    try { proc.kill('SIGTERM'); } catch { /* already dead */ }
    killEscalation = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already dead */ }
    }, 2000);
  }, timeout * 1000);

  return new Promise<WorkerResult>((resolve) => {
    let settled = false;
    let workerExitCode: number | null = null;

    function settleWith(result: WorkerResult) {
      if (settled) return;
      settled = true;
      activeWorkerProcs.delete(proc);
      clearTimeout(timeoutHandle);
      if (killEscalation) clearTimeout(killEscalation);
      clearTimeout(hangGuard);
      onComplete(result);
      resolve(result);
    }

    // Safety net: force-resolve if the process hangs (mirrors spawn-morty.ts)
    const hangGuard = setTimeout(() => {
      settleWith({ roleId, success: false, logPath, cycle, exitCode: null });
    }, (timeout + 30) * 1000);
    hangGuard.unref();

    proc.on('error', (err) => {
      const msg = safeErrorMessage(err);
      console.error(`${Style.RED}Failed to spawn ${invocation.cmd} (${roleId}): ${msg}${Style.RESET}`);
      logStream.end();
      settleWith({ roleId, success: false, logPath, cycle, exitCode: null });
    });

    proc.on('close', (code) => {
      workerExitCode = code ?? null;
      if (settled) return; // error handler already resolved
      clearTimeout(timeoutHandle);
      if (killEscalation) clearTimeout(killEscalation);
      clearTimeout(hangGuard);

      // Register finish listener BEFORE calling end() to avoid missing synchronous completion.
      // Guard against logStream.finish never firing (e.g., disk I/O failure)
      const flushTimeout = setTimeout(() => finalize(), 5000);

      logStream.on('finish', () => {
        clearTimeout(flushTimeout);
        finalize();
      });

      logStream.end();

      function finalize() {
        let logContent = '';
        try { logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : ''; } catch { /* */ }
        const success = !workerTimedOut && hasToken(logContent, PromiseTokens.ANALYSIS_DONE);
        settleWith({ roleId, success, logPath, cycle, exitCode: workerExitCode });
      }
    });
  });
}

function usageAndExit(): never {
  console.error(
    `${Style.RED}❌ Usage: node spawn-refinement-team.js --prd <path> --session-dir <dir> [--timeout <sec>] [--cycles <n>] [--max-turns <n>]${Style.RESET}`
  );
  process.exit(1);
}

function parsePositiveIntegerValue(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw > 0 ? raw : undefined;
  }
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

function parsePositiveFlag(argv: string[], index: number, flag: string): number | undefined {
  if (index === -1) return undefined;
  const raw = argv[index + 1];
  const value = parsePositiveIntegerValue(raw);
  if (value === undefined) {
    console.error(`${Style.RED}❌ ${flag} requires a positive integer, got: ${raw}${Style.RESET}`);
    process.exit(1);
  }
  return value;
}

function parseTimeoutFlag(argv: string[]): number | undefined {
  const timeoutIndex = argv.indexOf('--timeout');
  return parsePositiveFlag(argv, timeoutIndex, '--timeout');
}

const SKIP_AC_SHAPE_GATE_USAGE_MSG =
  '--skip-ac-shape-gate requires a non-empty reason argument (e.g. --skip-ac-shape-gate "operator: analyst tickets verified correct")';
const SKIP_AC_SHAPE_GATE_EXIT_CODE = 64;

function parseSkipAcShapeGate(argv: string[]): string | undefined {
  const idx = argv.indexOf('--skip-ac-shape-gate');
  if (idx < 0) return undefined;
  const raw = argv[idx + 1];
  if (raw === undefined || raw.startsWith('--') || raw.trim() === '') {
    process.stderr.write(`${SKIP_AC_SHAPE_GATE_USAGE_MSG}\n`);
    process.exit(SKIP_AC_SHAPE_GATE_EXIT_CODE);
  }
  return raw;
}

export function parseAndValidateArgs(argv: string[]): RefinementArgs {
  const skipAcShapeGate = parseSkipAcShapeGate(argv);

  const prdIndex = argv.indexOf('--prd');
  const sessionIndex = argv.indexOf('--session-dir');
  const prdPath = prdIndex !== -1 ? argv[prdIndex + 1] : undefined;
  const sessionDir = sessionIndex !== -1 ? argv[sessionIndex + 1] : undefined;

  if (!prdPath || !sessionDir || prdPath.startsWith('--') || sessionDir.startsWith('--')) {
    usageAndExit();
  }

  if (!fs.existsSync(prdPath)) {
    console.error(`${Style.RED}❌ PRD not found: ${prdPath}${Style.RESET}`);
    process.exit(1);
  }

  return {
    prdPath,
    sessionDir,
    timeout: parseTimeoutFlag(argv),
    cycles: parsePositiveFlag(argv, argv.indexOf('--cycles'), '--cycles'),
    maxTurns: parsePositiveFlag(argv, argv.indexOf('--max-turns'), '--max-turns'),
    skipAcShapeGate,
  };
}

export function loadRefinementSettings(settingsPath = path.join(getExtensionRoot(), 'pickle_settings.json')): RefinementSettings {
  const settings: RefinementSettings = {
    defaultCycles: 3,
    defaultMaxTurns: 100,
    defaultWorkerTimeout: Defaults.WORKER_TIMEOUT_SECONDS,
  };

  if (!fs.existsSync(settingsPath)) return settings;

  try {
    const loaded = readRecoverableJsonObject(settingsPath) as Record<string, unknown> | null;
    if (!loaded) return settings;
    const cycles = parsePositiveIntegerValue(loaded.default_refinement_cycles);
    const maxTurns = parsePositiveIntegerValue(loaded.default_refinement_max_turns);
    const workerTimeout = parsePositiveIntegerValue(loaded.default_worker_timeout_seconds);
    if (cycles !== undefined) settings.defaultCycles = cycles;
    if (maxTurns !== undefined) settings.defaultMaxTurns = maxTurns;
    if (workerTimeout !== undefined) settings.defaultWorkerTimeout = workerTimeout;
  } catch { /* use hardcoded defaults */ }

  return settings;
}

function resolveRuntime(args: RefinementArgs, settings: RefinementSettings) {
  let timeout = args.timeout ?? settings.defaultWorkerTimeout;
  let workingDir = process.cwd();
  let stateBackend: unknown = undefined;
  let sessionEffort: 'low' | 'medium' | 'high' | undefined;
  const statePath = path.join(args.sessionDir, 'state.json');

  if (fs.existsSync(statePath)) {
    try {
      const state = sm.read(statePath);
      stateBackend = state.backend;
      if (typeof state.working_dir === 'string' && state.working_dir.trim()) workingDir = state.working_dir;
      if (state.effort === 'low' || state.effort === 'medium' || state.effort === 'high') sessionEffort = state.effort;
      if (args.timeout === undefined) {
        const stateTimeout = parsePositiveIntegerValue(state.worker_timeout_seconds);
        if (stateTimeout !== undefined) timeout = stateTimeout;
      }
      timeout = clampTimeoutToSession(timeout, state);
    } catch {
      // Ignore — use parsed/default timeout.
    }
  }

  warnIfCodexRequested(stateBackend, process.env.PICKLE_BACKEND);
  return {
    cycles: args.cycles ?? settings.defaultCycles,
    maxTurns: args.maxTurns ?? settings.defaultMaxTurns,
    timeout,
    workingDir,
    sessionEffort,
  };
}

function clampTimeoutToSession(timeout: number, state: { max_time_minutes?: unknown; start_time_epoch?: unknown }): number {
  const maxMins = Number(state.max_time_minutes);
  const startEpoch = Number(state.start_time_epoch);
  if (!Number.isFinite(maxMins) || maxMins <= 0 || !Number.isFinite(startEpoch) || startEpoch <= 0) {
    return timeout;
  }

  const remaining = Math.floor(maxMins * 60 - (Math.floor(Date.now() / 1000) - startEpoch));
  if (remaining <= 0) {
    console.log(`${Style.YELLOW}⚠️  Session time already elapsed; running with requested timeout.${Style.RESET}`);
  } else if (remaining < timeout) {
    console.log(`${Style.YELLOW}⚠️  Worker timeout clamped to ${remaining}s (session wall-clock)${Style.RESET}`);
    return remaining;
  }
  return timeout;
}

function registerShutdownHandlers(): void {
  const handleShutdownSignal = (signal: string) => {
    console.error(`\n${Style.YELLOW}⚠️  Received ${signal} — killing ${activeWorkerProcs.size} active worker(s)${Style.RESET}`);
    for (const wp of activeWorkerProcs) {
      try { wp.kill('SIGTERM'); } catch { /* already dead */ }
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
  process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
}

function ensureRefinementDir(refinementDir: string): void {
  try {
    fs.mkdirSync(refinementDir, { recursive: true });
  } catch (err) {
    const msg = safeErrorMessage(err);
    console.error(`${Style.RED}❌ Failed to create ${refinementDir}: ${msg}${Style.RESET}`);
    process.exit(1);
  }
}

function detectPortalContext(sessionDir: string): PortalContext | undefined {
  const portalDir = path.join(sessionDir, 'portal');
  return fs.existsSync(portalDir) ? { portalDir, patternSummaryLines: 50 } : undefined;
}

function printDeploymentPanel(
  args: RefinementArgs,
  refinementDir: string,
  cycles: number,
  maxTurns: number,
  timeout: number,
  sessionEffort: 'low' | 'medium' | 'high' | undefined
): void {
  printMinimalPanel(
    'PRD Refinement Team Deploying',
    {
      PRD: path.basename(args.prdPath),
      Workers: WORKER_ROLES.map((r) => r.id).join(' | '),
      Cycles: cycles,
      'Max Turns': `${maxTurns}/worker`,
      Timeout: `${timeout}s each`,
      Output: refinementDir,
      ...(sessionEffort ? { Effort: `${sessionEffort} (claude no-op)` } : {}),
    },
    'MAGENTA',
    '🥒'
  );
}

function loadPreviousAnalyses(refinementDir: string, cycle: number): Map<RoleId, string> | undefined {
  if (cycle <= 1) return undefined;
  const previousAnalyses = new Map<RoleId, string>();
  for (const { id } of WORKER_ROLES) {
    const prevFile = path.join(refinementDir, `analysis_${id}.md`);
    if (fs.existsSync(prevFile)) {
      try { previousAnalyses.set(id, fs.readFileSync(prevFile, 'utf-8')); } catch { /* skip unreadable */ }
    }
  }
  if (previousAnalyses.size === 0) {
    console.log(`${Style.YELLOW}⚠️  No previous analyses found — cycle ${cycle} will run as independent analysis.${Style.RESET}`);
  }
  return previousAnalyses;
}

function startCycleSpinner(statuses: Map<RoleId, '⏳' | '✅' | '❌'>, cycles: number, cycle: number): NodeJS.Timeout {
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinIdx = 0;
  const startTime = Date.now();
  return setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const spinChar = spinner[spinIdx % spinner.length];
    const statusParts = WORKER_ROLES.map((r) => `${statuses.get(r.id)} ${r.id}`).join(' | ');
    const cycleLabel = cycles > 1 ? ` C${cycle}` : '';
    process.stdout.write(
      `\r   ${Style.CYAN}${spinChar}${Style.RESET} ${statusParts} ${Style.DIM}[${formatTime(elapsed)}${cycleLabel}]${Style.RESET}\x1b[K`
    );
    spinIdx++;
  }, 200);
}

async function runCycle(opts: {
  cycle: number;
  cycles: number;
  prd: string;
  refinementDir: string;
  extensionRoot: string;
  timeout: number;
  workingDir: string;
  maxTurns: number;
  previousAnalyses?: Map<RoleId, string>;
  portalContext?: PortalContext;
  sessionDir: string;
}): Promise<WorkerResult[]> {
  const statuses = new Map<RoleId, '⏳' | '✅' | '❌'>(WORKER_ROLES.map((r) => [r.id, '⏳' as const]));
  const interval = startCycleSpinner(statuses, opts.cycles, opts.cycle);
  try {
    const workerPromises = WORKER_ROLES.map(({ id }) => {
      const outputFile = path.join(opts.refinementDir, `analysis_${id}.md`);
      const prompt = buildWorkerPrompt(id, opts.prd, outputFile, opts.workingDir, opts.cycle, opts.previousAnalyses, opts.portalContext);
      return spawnWorker(id, prompt, opts.refinementDir, opts.extensionRoot, opts.timeout, opts.workingDir, opts.maxTurns, opts.cycle, (result) => {
        statuses.set(id, result.success ? '✅' : '❌');
        if (result.exitCode !== null && result.exitCode !== 0) killSiblingWorkers(result);
      }, opts.sessionDir);
    });
    return await Promise.all(workerPromises);
  } finally {
    clearInterval(interval);
    process.stdout.write('\r\x1b[K\n');
  }
}

function killSiblingWorkers(result: WorkerResult): void {
  const siblings = [...activeWorkerProcs];
  if (siblings.length === 0) return;
  console.error(`\n${Style.RED}⚠️  Worker ${result.roleId} crashed (exit ${result.exitCode}) — killing ${siblings.length} sibling(s)${Style.RESET}`);
  for (const sibling of siblings) {
    try { sibling.kill('SIGTERM'); } catch { /* already dead */ }
  }
}

function archiveCycleResults(refinementDir: string, cycles: number, cycle: number): void {
  if (cycles <= 1) return;
  for (const { id } of WORKER_ROLES) {
    const canonical = path.join(refinementDir, `analysis_${id}.md`);
    const cycleArchive = path.join(refinementDir, `analysis_${id}_c${cycle}.md`);
    if (fs.existsSync(canonical)) {
      try { fs.copyFileSync(canonical, cycleArchive); } catch { /* best-effort */ }
    }
  }
}

export async function orchestrateCycles(
  args: RefinementArgs,
  settings: RefinementSettings,
  prd: string,
): Promise<CycleResults> {
  const runtime = resolveRuntime(args, settings);
  const refinementDir = path.join(args.sessionDir, 'refinement');
  const extensionRoot = getExtensionRoot();
  ensureRefinementDir(refinementDir);
  registerShutdownHandlers();
  printDeploymentPanel(args, refinementDir, runtime.cycles, runtime.maxTurns, runtime.timeout, runtime.sessionEffort);
  const preRefinementGate = runAcPhaseGate({
    sessionDir: args.sessionDir,
    evaluationPhase: 'pre-refinement',
    cwd: runtime.workingDir,
    stdout: (msg) => console.log(msg),
    stderr: (msg) => console.error(msg),
  });
  if (preRefinementGate.status !== 'pass') {
    throw new Error('pre-refinement AC phase gate failed');
  }
  emitStaleAnchorWarnings(findStaleAnchorWarnings(prd, runtime.workingDir));

  const allCycleResults: WorkerResult[][] = [];
  const portalContext = detectPortalContext(args.sessionDir);
  for (let cycle = 1; cycle <= runtime.cycles; cycle++) {
    if (runtime.cycles > 1) printCyclePanel(cycle, runtime.cycles);
    const results = await runCycle({
      cycle,
      cycles: runtime.cycles,
      prd,
      refinementDir,
      extensionRoot,
      timeout: runtime.timeout,
      workingDir: runtime.workingDir,
      maxTurns: runtime.maxTurns,
      previousAnalyses: loadPreviousAnalyses(refinementDir, cycle),
      portalContext,
      sessionDir: args.sessionDir,
    });
    archiveCycleResults(refinementDir, runtime.cycles, cycle);
    allCycleResults.push(results);
    printCycleSummary(results, runtime.cycles, cycle);
    if (results.every((r) => !r.success)) break;
  }

  if (allCycleResults.length === 0) {
    console.error(`${Style.RED}❌ No cycles completed${Style.RESET}`);
    process.exit(1);
  }

  const finalResults = allCycleResults[allCycleResults.length - 1];
  const allSuccess = finalResults.every((r) => r.success);
  printCompletionPanel(finalResults, allSuccess);
  return { refinementDir, cyclesRequested: runtime.cycles, maxTurns: runtime.maxTurns, allCycleResults, finalResults, allSuccess };
}

function printCyclePanel(cycle: number, cycles: number): void {
  printMinimalPanel(
    `Cycle ${cycle} of ${cycles}`,
    {
      Phase: cycle === 1 ? 'Initial Analysis' : 'Deep-Dive (cross-referencing previous findings)',
      Workers: WORKER_ROLES.map((r) => r.id).join(' | '),
    },
    'CYAN',
    '🔄'
  );
}

function printCycleSummary(results: WorkerResult[], cycles: number, cycle: number): void {
  if (cycles > 1) {
    const statusLine = results.map((r) => `${r.roleId}: ${r.success ? '✅' : '❌'}`).join(' | ');
    console.log(`   ${Style.DIM}Cycle ${cycle}: ${statusLine}${Style.RESET}`);
  }
  if (results.every((r) => !r.success)) {
    console.log(`${Style.YELLOW}⚠️  All workers failed in cycle ${cycle} — skipping remaining cycles.${Style.RESET}`);
  }
}

function printCompletionPanel(finalResults: WorkerResult[], allSuccess: boolean): void {
  printMinimalPanel(
    'Refinement Team Complete',
    Object.fromEntries(finalResults.map((r) => [r.roleId, r.success ? '✅ analysis written' : '❌ failed — check log'])),
    allSuccess ? 'GREEN' : 'YELLOW',
    '🥒'
  );
}

interface ParsedShapeSection {
  acShapeSmells: AcShapeSmell[];
  tickets: RefinementTicketManifestEntry[];
}

export interface AcShapeViolation {
  ac_id: string;
  reason: string;
  ticket_ids: string[];
}

const AC_SHAPE_SECTION_RE = /^##+\s+ac_shape_smells\s*$/im;
const UNIVERSAL_QUANTIFIER_RE = /\b(?:all|every|for any|each)\b/i;
const JUSTIFICATION_RE = /\/\/\s*JUSTIFICATION:/i;
const DESCRIBE_EACH_RE = /describe\.each\s*\(\s*\[/s;
// PICKLE_AC_GATE_DEBUG=1 enables per-matcher stderr tracing for smell→ticket evaluation

function ticketShapeText(ticket: RefinementTicketManifestEntry): string {
  return [ticket.title, ticket.acceptance_test, ticket.justification]
    .filter((s): s is string => Boolean(s))
    .join(' ');
}

function acDebugMatcher(regex: RegExp, field: string, value: string, matched: boolean): void {
  if (process.env.PICKLE_AC_GATE_DEBUG !== '1') return;
  process.stderr.write(`matcher: regex=${regex.source}, field=${field}, value=${value}, result=${matched ? 'match' : 'no-match'}\n`);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

function normalizeAcShapeSmell(value: unknown, source_worker: RoleId, source_file: string): AcShapeSmell | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const ac_id = asString(record.ac_id);
  if (!ac_id) return undefined;
  return {
    ac_id,
    headline: asString(record.headline),
    evidence: asStringArray(record.evidence),
    targets: asStringArray(record.targets),
    repeated_predicate: asString(record.repeated_predicate),
    ticket_ids: asStringArray(record.ticket_ids),
    source_worker,
    source_file,
  };
}

function normalizeTicketEntry(value: unknown, source_worker: RoleId, source_file: string): RefinementTicketManifestEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const id = asString(record.id);
  const title = asString(record.title);
  if (!id || !title) return undefined;
  // Capture analyst's complexity_tier hint (overridden by classifier in buildRefinementManifest)
  const rawTier = asString(record.complexity_tier)?.trim().toLowerCase();
  const complexity_tier = rawTier && (VALID_TICKET_COMPLEXITY_TIERS as readonly string[]).includes(rawTier)
    ? rawTier as TicketComplexityTier
    : undefined;
  return {
    id,
    title,
    source_ac_ids: asStringArray(record.source_ac_ids),
    source_prd: asString(record.source_prd),
    source_section: asString(record.source_section),
    mapped_requirements: asStringArray(record.mapped_requirements),
    acceptance_test: asString(record.acceptance_test),
    justification: asString(record.justification),
    source_worker,
    source_file,
    complexity_tier,
  };
}

/** Build classifier inputs from a manifest entry's available text signals. */
function buildClassifierInfoForEntry(entry: RefinementTicketManifestEntry): TicketClassifierInfo {
  const text = [entry.title, entry.acceptance_test, entry.justification]
    .filter((s): s is string => Boolean(s))
    .join(' ');
  // Count distinct backtick-enclosed file references (path-like: contains / or has file extension)
  const fileRefs = new Set<string>();
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const t = m[1];
    if (/\//.test(t) || /\.[a-zA-Z]{1,8}$/.test(t)) fileRefs.add(t);
  }
  return {
    fileCount: fileRefs.size,
    acCount: (entry.source_ac_ids ?? []).length,
    locEstimate: 0, // not known at refinement time
    text,
  };
}

function extractAcShapeJson(content: string): unknown {
  const sectionMatch = AC_SHAPE_SECTION_RE.exec(content);
  if (!sectionMatch) return undefined;
  const afterHeading = content.slice(sectionMatch.index + sectionMatch[0].length);
  const nextHeading = afterHeading.search(/\n##+\s+/);
  const section = nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(section);
  const jsonText = fenced ? fenced[1] : section.trim();
  if (!jsonText) return undefined;
  try {
    return JSON.parse(jsonText);
  } catch {
    return undefined;
  }
}

export function parseAcShapeSection(content: string, source_worker: RoleId, source_file: string): ParsedShapeSection {
  const parsed = extractAcShapeJson(content);
  if (typeof parsed !== 'object' || parsed === null) return { acShapeSmells: [], tickets: [] };
  const record = parsed as Record<string, unknown>;
  return {
    acShapeSmells: Array.isArray(record.ac_shape_smells)
      ? record.ac_shape_smells
        .map((item) => normalizeAcShapeSmell(item, source_worker, source_file))
        .filter((item): item is AcShapeSmell => item !== undefined)
      : [],
    tickets: Array.isArray(record.tickets)
      ? record.tickets
        .map((item) => normalizeTicketEntry(item, source_worker, source_file))
        .filter((item): item is RefinementTicketManifestEntry => item !== undefined)
      : [],
  };
}

function collectAcShapeData(results: CycleResults): ParsedShapeSection {
  const acShapeSmells: AcShapeSmell[] = [];
  const tickets: RefinementTicketManifestEntry[] = [];
  for (const result of results.finalResults) {
    const outputFile = path.join(results.refinementDir, `analysis_${result.roleId}.md`);
    if (!fs.existsSync(outputFile)) continue;
    const parsed = parseAcShapeSection(fs.readFileSync(outputFile, 'utf-8'), result.roleId, outputFile);
    acShapeSmells.push(...parsed.acShapeSmells);
    tickets.push(...parsed.tickets);
  }
  return { acShapeSmells, tickets };
}

function ticketsForSmell(smell: AcShapeSmell, tickets: RefinementTicketManifestEntry[]): RefinementTicketManifestEntry[] {
  const explicitIds = new Set((smell.ticket_ids ?? []).filter((id) => id.trim() !== ''));
  return tickets.filter((ticket) => {
    if (explicitIds.size > 0 && explicitIds.has(ticket.id)) return true;
    return ticket.source_ac_ids.includes(smell.ac_id);
  });
}

function parseFrontmatter(content: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  return match ? match[1] : '';
}

function unquoteYamlish(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

function peerPrdDeferredPaths(frontmatter: string): string[] {
  const lines = frontmatter.split(/\r?\n/);
  const peerIndex = lines.findIndex((line) => /^peer_prds:\s*$/.test(line));
  if (peerIndex < 0) return [];
  const paths: string[] = [];
  for (let i = peerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) break;
    if (!/^\s+deferred:\s*$/.test(line)) continue;
    for (let j = i + 1; j < lines.length; j += 1) {
      const item = lines[j];
      if (/^\s{2}\S/.test(item) && !/^\s{4,}-\s+/.test(item)) break;
      const match = /^\s+-\s+(.+?)\s*(?:#.*)?$/.exec(item);
      if (match) paths.push(unquoteYamlish(match[1]));
    }
    break;
  }
  return paths;
}

function composedPrdPaths(frontmatter: string): string[] {
  const lines = frontmatter.split(/\r?\n/);
  const composeIndex = lines.findIndex((line) => /^composes:\s*$/.test(line));
  if (composeIndex < 0) return [];
  const paths: string[] = [];
  for (let i = composeIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) break;
    const match = /^\s+-\s+(.+?)\s*(?:#.*)?$/.exec(line);
    if (match) paths.push(unquoteYamlish(match[1]));
  }
  return paths;
}

interface SourceRequirement {
  sourcePrd: string;
  sourceSection: string;
  requirementId: string;
}

function resolvePeerPrdPath(parentPrdPath: string, peerPath: string): string | undefined {
  // A peer/composed PRD reference must resolve to a readable FILE. Guard against
  // directory paths: removal-bundle PRDs legitimately cite directories (e.g.
  // `.claude/skills/some-skill/`, `extension/src/types`) and a composes:/source:
  // entry that resolves to a directory must NOT be readFileSync'd by callers
  // (resolveComposesChain/visit, extractSourceRequirements) — that throws EISDIR
  // and aborts the whole refinement run.
  const isReadableFile = (candidate: string): boolean => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  };
  if (path.isAbsolute(peerPath) && isReadableFile(peerPath)) return peerPath;
  const repoRoot = findRepoRoot(path.dirname(parentPrdPath));
  const candidates = [
    path.resolve(path.dirname(parentPrdPath), peerPath),
    path.resolve(repoRoot, peerPath),
  ];
  return candidates.find(isReadableFile);
}

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function normalizeResolvedPeerPrdPath(parentPrdPath: string, resolvedPath: string): string {
  const repoRoot = findRepoRoot(path.dirname(parentPrdPath));
  const relative = path.relative(repoRoot, resolvedPath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    const fallback = path.basename(resolvedPath);
    process.stderr.write(
      `[pickle-rick] source_prd path ${resolvedPath} is outside repo root ${repoRoot}; using basename ${fallback}.\n`
    );
    return fallback;
  }
  return toPosixPath(relative);
}

function extractSourceRequirements(parentPrdPath: string): SourceRequirement[] {
  if (!fs.existsSync(parentPrdPath)) return [];
  const requirementsById = new Map<string, SourceRequirement>();
  const visited = new Set<string>();
  const visitPrd = (resolvedPath: string): void => {
    const canonicalPath = path.resolve(resolvedPath);
    if (visited.has(canonicalPath) || !fs.existsSync(canonicalPath)) return;
    visited.add(canonicalPath);
    const content = fs.readFileSync(canonicalPath, 'utf-8');
    const frontmatter = parseFrontmatter(content);
    const lines = content.split(/\r?\n/);
    let section = '';
    for (const line of lines) {
      const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
      if (heading) section = heading[1].trim();
      for (const match of line.matchAll(/\bAC-[A-Z0-9-]+\b/g)) {
        if (requirementsById.has(match[0])) continue;
        requirementsById.set(match[0], {
          sourcePrd: normalizeResolvedPeerPrdPath(parentPrdPath, canonicalPath),
          sourceSection: section,
          requirementId: match[0],
        });
      }
    }
    for (const composedPath of composedPrdPaths(frontmatter)) {
      const resolvedCompose = resolvePeerPrdPath(canonicalPath, composedPath);
      if (resolvedCompose) visitPrd(resolvedCompose);
    }
    for (const peerPath of peerPrdDeferredPaths(frontmatter)) {
      const resolvedPeer = resolvePeerPrdPath(canonicalPath, peerPath);
      if (resolvedPeer) visitPrd(resolvedPeer);
    }
  };
  const parentContent = fs.readFileSync(parentPrdPath, 'utf-8');
  const parentFrontmatter = parseFrontmatter(parentContent);
  const sourcePrdPaths = uniqueStrings([
    ...peerPrdDeferredPaths(parentFrontmatter),
    ...composedPrdPaths(parentFrontmatter),
  ]);
  for (const sourcePrdPath of sourcePrdPaths) {
    const resolved = resolvePeerPrdPath(parentPrdPath, sourcePrdPath);
    if (resolved) visitPrd(resolved);
  }
  return [...requirementsById.values()];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))].sort();
}

export function enrichManifestTicketsFromSourcePrds(prdPath: string, tickets: RefinementTicketManifestEntry[]): RefinementTicketManifestEntry[] {
  if (!path.isAbsolute(prdPath)) {
    throw new Error('enrichManifestTicketsFromSourcePrds requires absolute parentPrdPath');
  }
  const byRequirement = new Map<string, SourceRequirement[]>();
  for (const requirement of extractSourceRequirements(prdPath)) {
    const existing = byRequirement.get(requirement.requirementId) ?? [];
    existing.push(requirement);
    byRequirement.set(requirement.requirementId, existing);
  }
  if (byRequirement.size === 0) return tickets;
  return tickets.map((ticket) => {
    const matches = ticket.source_ac_ids.flatMap((id) => byRequirement.get(id) ?? []);
    if (matches.length === 0) return ticket;
    const sourcePrds = uniqueStrings(matches.map((match) => match.sourcePrd));
    const sourceSections = uniqueStrings(matches.map((match) => match.sourceSection));
    const mapped = uniqueStrings([...ticket.source_ac_ids, ...(ticket.mapped_requirements ?? [])]);
    return {
      ...ticket,
      source_prd: sourcePrds.join(', ') || ticket.source_prd,
      source_section: sourceSections.join(', ') || ticket.source_section,
      mapped_requirements: mapped,
    };
  });
}

function hasJustificationBlock(ticket: RefinementTicketManifestEntry): boolean {
  const j = ticket.justification;
  if (j === undefined || j.trim() === '') return false;
  const sigilMatch = JUSTIFICATION_RE.test(j);
  acDebugMatcher(JUSTIFICATION_RE, 'justification', j, sigilMatch);
  if (sigilMatch) return true;
  const NON_EMPTY_RE = /\S/;
  const proseMatch = NON_EMPTY_RE.test(j);
  acDebugMatcher(NON_EMPTY_RE, 'justification', j, proseMatch);
  return proseMatch;
}

export function isParametrizedTicket(ticket: RefinementTicketManifestEntry): boolean {
  const text = ticketShapeText(ticket);
  const hasQuantifier = UNIVERSAL_QUANTIFIER_RE.test(text);
  acDebugMatcher(UNIVERSAL_QUANTIFIER_RE, 'joined', text, hasQuantifier);
  const hasDescribeEach = DESCRIBE_EACH_RE.test(text);
  acDebugMatcher(DESCRIBE_EACH_RE, 'joined', text, hasDescribeEach);
  return hasQuantifier && hasDescribeEach;
}

export function evaluateAcShapeEnforcement(manifest: Pick<RefinementManifest, 'ac_shape_smells' | 'tickets'>): AcShapeViolation[] {
  const violations: AcShapeViolation[] = [];
  for (const smell of manifest.ac_shape_smells) {
    const matchingTickets = ticketsForSmell(smell, manifest.tickets);
    if (matchingTickets.length === 0) {
      violations.push({
        ac_id: smell.ac_id,
        reason: 'tagged as an AC-shape smell but no matching ticket entries were emitted',
        ticket_ids: [],
      });
      continue;
    }
    if (matchingTickets.length === 1) {
      const [ticket] = matchingTickets;
      if (!isParametrizedTicket(ticket)) {
        violations.push({
          ac_id: smell.ac_id,
          reason: 'single-ticket collapse lacks a universal-quantifier title or describe.each([...]) acceptance test',
          ticket_ids: [ticket.id],
        });
      }
      continue;
    }
    const unjustified = matchingTickets.filter((ticket) => !hasJustificationBlock(ticket));
    if (unjustified.length > 0) {
      violations.push({
        ac_id: smell.ac_id,
        reason: 'multi-ticket decomposition lacks // JUSTIFICATION: blocks on every matching ticket',
        ticket_ids: unjustified.map((ticket) => ticket.id),
      });
    }
  }
  return violations;
}

export function evaluateAcShapeAdvisory(manifest: Pick<RefinementManifest, 'prd_advisory_shape_concerns'>): string[] {
  return manifest.prd_advisory_shape_concerns ?? [];
}

/**
 * Reads the unified `state.flags.skip_quality_gates_reason` from the session
 * state.json (best-effort). W1a: the AC-shape gate is folded into the single
 * quality-gate bypass surface, so a session carrying the unified flag bypasses
 * the AC-shape gate just as it bypasses the readiness/ticket-audit gates. The
 * explicit `--skip-ac-shape-gate <reason>` CLI flag takes precedence over this.
 * Behind `PICKLE_RECOVERY_CONSOLIDATION=off` the fold-in is inert (CLI flag only).
 */
function readUnifiedQualityGateSkipReason(sessionDir?: string): string | undefined {
  if (!recoveryConsolidationEnabled() || !sessionDir) return undefined;
  try {
    const statePath = path.join(sessionDir, 'state.json');
    const state = readRecoverableJsonObject(statePath) as { flags?: Record<string, unknown> } | null;
    const raw = state?.flags?.skip_quality_gates_reason;
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  } catch (err) {
    // Fail closed: a state-read failure leaves the gate ARMED (runs normally).
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[pickle-rick] ac-shape gate: could not read skip_quality_gates_reason (${msg}); gate stays armed\n`);
  }
  return undefined;
}

/**
 * Resolves the AC-shape bypass surface and, on a hit, emits the
 * `ac_shape_gate_bypassed` telemetry. Conflict-resolution rule: an explicit
 * `--skip-ac-shape-gate <reason>` CLI override wins over the persisted unified
 * `state.flags.skip_quality_gates_reason` (W1a fold-in). Returns true when the
 * gate is bypassed.
 */
function maybeBypassAcShapeGate(opts?: { sessionDir?: string; skipAcShapeGate?: string }): boolean {
  const bypassReason = opts?.skipAcShapeGate ?? readUnifiedQualityGateSkipReason(opts?.sessionDir);
  if (bypassReason === undefined) return false;
  const surface = opts?.skipAcShapeGate === undefined
    ? 'state.flags.skip_quality_gates_reason'
    : '--skip-ac-shape-gate';
  process.stderr.write(`[pickle-rick] ac-shape gate bypassed via ${surface}: ${bypassReason}\n`);
  if (opts?.sessionDir) {
    try {
      writeActivityEntry(path.join(opts.sessionDir, 'state.json'), {
        event: 'ac_shape_gate_bypassed',
        ts: new Date().toISOString(),
        gate_payload: { reason: bypassReason },
      });
    } catch { /* best-effort telemetry */ }
  }
  return true;
}

export function runAcShapeEnforcement(
  manifest: RefinementManifest,
  opts?: { sessionDir?: string; skipAcShapeGate?: string },
): number {
  if (maybeBypassAcShapeGate(opts)) return 0;

  const advisoryWarnings = evaluateAcShapeAdvisory(manifest);
  for (const warning of advisoryWarnings) {
    process.stderr.write(`[pickle-rick] [advisory] ac-shape: ${warning}\n`);
  }

  const violations = evaluateAcShapeEnforcement(manifest);
  if (violations.length === 0) return 0;

  process.stderr.write('[pickle-rick] AC shape gate FAILED — the following ac_ids have ticket shape violations:\n');
  for (const violation of violations) {
    const ticketList = violation.ticket_ids.length > 0 ? violation.ticket_ids.join(', ') : '(none)';
    process.stderr.write(`[pickle-rick] ${violation.ac_id} ticket=${ticketList}: ${violation.reason}\n`);
    if (violation.ticket_ids.length !== 1) {
      process.stderr.write('[pickle-rick]   Fix: add // JUSTIFICATION: to each split ticket explaining the split rationale\n');
    } else {
      process.stderr.write('[pickle-rick]   Fix: rewrite ticket to use universal quantifier title AND describe.each([\n');
      process.stderr.write('[pickle-rick]     title: "All <entities> <condition>"\n');
      process.stderr.write("[pickle-rick]     acceptance_test: \"describe.each([['input1'], ['input2']])(...)\"\n");
    }
    process.stderr.write(`[pickle-rick]   Override: --skip-ac-shape-gate "<reason>"\n`);
  }
  return 2;
}

const QUOTED_SYMBOL_RE = /[`'"]([A-Za-z][A-Za-z0-9_.-]*)[`'"]/g;
const ACTIVITY_EVENT_TRIGGER_RE = /\b(?:activity[-_\s]?events?|event_type|logActivity|VALID_ACTIVITY_EVENTS)\b/i;
const NON_EVENT_ACTIVITY_CONTEXT_RE = /\b(?:enum value|state field|phase outcome|gate outcome)\b/i;
const SOURCE_FILE_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|sh|py|css|scss|html)$/;
const SKIP_SOURCE_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.turbo', '.next']);

function lineRefs(content: string): { line: string; sourceLine: number }[] {
  return content.split(/\r?\n/).map((line, index) => ({ line, sourceLine: index + 1 }));
}

function sectionByHeading(content: string, headingPattern: RegExp): { content: string; startLine: number } | undefined {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{1,6}\s+/.test(line) && headingPattern.test(line));
  if (start === -1) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { content: lines.slice(start + 1, end).join('\n'), startLine: start + 2 };
}

function quotedSymbols(line: string): string[] {
  const symbols: string[] = [];
  QUOTED_SYMBOL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = QUOTED_SYMBOL_RE.exec(line)) !== null) {
    symbols.push(match[1]);
  }
  return symbols;
}

function declaredActivityEventSymbols(prdContent: string): Set<string> {
  const symbols = new Set<string>();
  for (const { line } of lineRefs(prdContent)) {
    if (!ACTIVITY_EVENT_TRIGGER_RE.test(line)) continue;
    for (const symbol of quotedSymbols(line)) {
      if (/^[a-z][a-z0-9_]*$/.test(symbol)) symbols.add(symbol);
    }
  }
  return symbols;
}

function declaredHelperSentinelSymbols(prdContent: string): Set<string> {
  const symbols = new Set<string>();
  for (const { line } of lineRefs(prdContent)) {
    if (!/\b(?:helpers?|sentinels?)\b/i.test(line)) continue;
    for (const symbol of quotedSymbols(line)) {
      if (/^[A-Za-z_$][A-Za-z0-9_$.-]*$/.test(symbol)) symbols.add(symbol);
    }
  }
  return symbols;
}

export function resolveComposesChain(prdPath: string): { events: Set<string>; helpers: Set<string> } {
  const resolved = { events: new Set<string>(), helpers: new Set<string>() };
  if (!prdPath || !fs.existsSync(prdPath)) return resolved;

  const visited = new Set<string>();
  const visit = (currentPrdPath: string): void => {
    const canonicalPrdPath = path.resolve(currentPrdPath);
    if (visited.has(canonicalPrdPath) || !fs.existsSync(canonicalPrdPath)) return;
    visited.add(canonicalPrdPath);
    const frontmatter = parseFrontmatter(fs.readFileSync(canonicalPrdPath, 'utf-8'));
    for (const composePath of composedPrdPaths(frontmatter)) {
      const composedPrdPath = resolvePeerPrdPath(canonicalPrdPath, composePath);
      if (!composedPrdPath) {
        process.stderr.write(`[pickle-rick] warning: composed PRD not found: ${composePath}\n`);
        continue;
      }
      const composedContent = fs.readFileSync(composedPrdPath, 'utf-8');
      for (const symbol of declaredActivityEventSymbols(composedContent)) resolved.events.add(symbol);
      for (const symbol of declaredHelperSentinelSymbols(composedContent)) resolved.helpers.add(symbol);
      visit(composedPrdPath);
    }
  };

  visit(prdPath);
  return resolved;
}

function uniqueReferences(refs: SymbolAuditReference[]): SymbolAuditReference[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.symbol}:${ref.sourceLine}:${ref.evidence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// enum-value heuristic:
// Trigger-phrase lines are still the entrypoint for activity-event auditing.
// When the same line also advertises enum/state prose, quoted snake_case values
// are ignored unless the token itself sits next to explicit event wording.
// This keeps `gate outcome G ∈ { ... }` values out of the audit while still
// preserving true positives such as `logged as \`token\`` or emitted-event text.
function shouldAuditActivityEventToken(line: string, matchIndex: number, raw: string): boolean {
  if (!NON_EVENT_ACTIVITY_CONTEXT_RE.test(line)) return true;
  const before = line.slice(Math.max(0, matchIndex - 24), matchIndex);
  const after = line.slice(matchIndex + raw.length, Math.min(line.length, matchIndex + raw.length + 24));
  return (
    /\b(?:activity[-_\s]?events?|activity[-_\s]?event|event_type|activity_event|logged as)\s*[:=]?\s*$/i.test(before) ||
    /\b(?:emit|emits|emitted)\s*$/i.test(before) ||
    /^\s*(?:is\s+)?(?:emit|emits|emitted)\b/i.test(after) ||
    /^\s*(?:as\s+)?(?:an?\s+)?activity[-_\s]?event\b/i.test(after) ||
    /^\s*(?:event_type|activity_event)\b\s*[:=]/i.test(after)
  );
}

function collectActivityEventReferences(prdContent: string, declaredSymbols: Iterable<string> = []): SymbolAuditReference[] {
  const valid = new Set<string>([...VALID_ACTIVITY_EVENTS, ...declaredSymbols]);
  const refs: SymbolAuditReference[] = [];
  for (const { line, sourceLine } of lineRefs(prdContent)) {
    if (!ACTIVITY_EVENT_TRIGGER_RE.test(line)) continue;
    QUOTED_SYMBOL_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = QUOTED_SYMBOL_RE.exec(line)) !== null) {
      const [raw, symbol] = match;
      if (!/^[a-z][a-z0-9_]*$/.test(symbol)) continue;
      if (!shouldAuditActivityEventToken(line, match.index, raw)) continue;
      const status = valid.has(symbol) ? 'valid' : 'phantom';
      refs.push({
        symbol,
        sourceLine,
        evidence: line.trim(),
        status,
        ...(status === 'phantom' ? { reason: 'not present in VALID_ACTIVITY_EVENTS' } : {}),
      });
    }
  }
  return uniqueReferences(refs);
}

function pipelineExitCodeMembers(): { names: Set<string>; values: Set<string> } {
  const names = new Set<string>();
  const values = new Set<string>();
  for (const [key, value] of Object.entries(PipelineRunnerExitCode)) {
    if (/^\d+$/.test(key)) continue;
    names.add(key);
    if (typeof value === 'number') values.add(String(value));
  }
  return { names, values };
}

function collectExitCodeReferences(prdContent: string): SymbolAuditReference[] {
  const { names, values } = pipelineExitCodeMembers();
  const refs: SymbolAuditReference[] = [];
  for (const { line, sourceLine } of lineRefs(prdContent)) {
    if (!/\b(?:exit[-_\s]?codes?|PipelineRunnerExitCode|process\.exit)\b/i.test(line)) continue;
    const symbols = new Set<string>();
    for (const symbol of quotedSymbols(line)) symbols.add(symbol.replace(/^PipelineRunnerExitCode\./, ''));
    for (const match of line.matchAll(/\bPipelineRunnerExitCode\.([A-Za-z][A-Za-z0-9_]*)\b/g)) symbols.add(match[1]);
    for (const match of line.matchAll(/\bexit[-_\s]?codes?\s*[:=]?\s*(\d+)\b/gi)) symbols.add(match[1]);
    for (const symbol of symbols) {
      if (!/^(?:[A-Za-z][A-Za-z0-9_]*|\d+)$/.test(symbol)) continue;
      const status = names.has(symbol) || values.has(symbol) ? 'pass' : 'fail';
      refs.push({
        symbol,
        sourceLine,
        evidence: line.trim(),
        status,
        ...(status === 'fail' ? { reason: 'not present in PipelineRunnerExitCode' } : {}),
      });
    }
  }
  return uniqueReferences(refs);
}

function collectNewFileReferences(prdContent: string, manifest: Pick<RefinementManifest, 'tickets'>): SymbolAuditReference[] {
  const filesSection = sectionByHeading(prdContent, /\bfiles\s+touched\b/i);
  if (!filesSection) return [];
  const manifestText = JSON.stringify(manifest.tickets);
  const refs: SymbolAuditReference[] = [];
  for (const { line, sourceLine } of lineRefs(filesSection.content)) {
    if (!/\bNEW\b/i.test(line)) continue;
    for (const match of line.matchAll(/(?:^|[\s`'":])((?:\.{1,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+)\b/g)) {
      const filePath = normalizeCitationPath(match[1]);
      const escaped = filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pathMentions = prdContent.match(new RegExp(escaped, 'g'))?.length ?? 0;
      const hasTicket = pathMentions > 1 || manifestText.includes(filePath);
      refs.push({
        symbol: filePath,
        sourceLine: filesSection.startLine + sourceLine - 1,
        evidence: line.trim(),
        status: hasTicket ? 'pass' : 'fail',
        ...(hasTicket ? {} : { reason: 'NEW file path is not referenced by any decomposition ticket' }),
      });
    }
  }
  return uniqueReferences(refs);
}

function sourceRoots(workingDir: string): string[] {
  const roots = [path.join(workingDir, 'src'), path.join(workingDir, 'extension', 'src')]
    .filter((root) => fs.existsSync(root) && fs.statSync(root).isDirectory());
  return roots.length > 0 ? roots : [workingDir];
}

function hasSourceHit(symbol: string, workingDir: string): boolean {
  const stack = sourceRoots(workingDir);
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_SOURCE_DIRS.has(entry.name)) stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !SOURCE_FILE_RE.test(entry.name)) continue;
      try {
        if (fs.readFileSync(fullPath, 'utf-8').includes(symbol)) return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}

function collectHelperSentinelReferences(
  prdContent: string,
  workingDir: string,
  declaredSymbols: Iterable<string> = []
): SymbolAuditReference[] {
  const valid = new Set<string>(declaredSymbols);
  const refs: SymbolAuditReference[] = [];
  for (const { line, sourceLine } of lineRefs(prdContent)) {
    if (!/\b(?:helpers?|sentinels?)\b/i.test(line)) continue;
    QUOTED_SYMBOL_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = QUOTED_SYMBOL_RE.exec(line)) !== null) {
      const [, symbol] = match;
      if (!/^[A-Za-z_$][A-Za-z0-9_$.-]*$/.test(symbol)) continue;
      const grounded = valid.has(symbol) || hasSourceHit(symbol, workingDir);
      const status = grounded ? 'valid' : 'phantom';
      refs.push({
        symbol,
        sourceLine,
        evidence: line.trim(),
        status,
        ...(status === 'phantom' ? { reason: 'no source-tree hit found' } : {}),
      });
    }
  }
  return uniqueReferences(refs);
}

function findingsFrom(category: SymbolAuditCategory, refs: SymbolAuditReference[]): SymbolAuditFinding[] {
  return refs
    .filter((ref) => ref.status === 'fail' || ref.status === 'phantom')
    .map((ref) => ({
      category,
      symbol: ref.symbol,
      sourceLine: ref.sourceLine,
      reason: ref.reason ?? 'symbol audit failed',
    }));
}

export function evaluateSymbolAudit(
  prdContent: string,
  workingDir: string,
  manifest: Pick<RefinementManifest, 'tickets'>,
  prdPath?: string
): SymbolAuditReport {
  const composedSymbols = prdPath ? resolveComposesChain(prdPath) : { events: new Set<string>(), helpers: new Set<string>() };
  const activityEvents = collectActivityEventReferences(prdContent, composedSymbols.events);
  const exitCodes = collectExitCodeReferences(prdContent);
  const newFiles = collectNewFileReferences(prdContent, manifest);
  const helperSentinels = collectHelperSentinelReferences(prdContent, workingDir, composedSymbols.helpers);
  const findings = [
    ...findingsFrom('activity_event', activityEvents),
    ...findingsFrom('exit_code', exitCodes),
    ...findingsFrom('new_file', newFiles),
    ...findingsFrom('helper_sentinel', helperSentinels),
  ];
  return {
    ok: findings.length === 0,
    activityEvents,
    exitCodes,
    newFiles,
    helperSentinels,
    findings,
  };
}

function renderSymbolRows(refs: SymbolAuditReference[]): string[] {
  if (refs.length === 0) return ['| _none_ | - | - | - |'];
  return refs.map((ref) => `| \`${ref.symbol}\` | ${ref.status.toUpperCase()} | ${ref.sourceLine} | ${ref.reason ?? 'grounded'} |`);
}

export function renderSymbolAuditMarkdown(report: SymbolAuditReport): string {
  const lines = [
    '# Symbol Audit',
    '',
    `Status: ${report.ok ? 'PASS' : 'FAIL'}`,
    '',
    '## Activity Events',
    '| Symbol | Status | PRD Line | Detail |',
    '|---|---:|---:|---|',
    ...renderSymbolRows(report.activityEvents),
    '',
    '## Exit Codes',
    '| Symbol | Status | PRD Line | Detail |',
    '|---|---:|---:|---|',
    ...renderSymbolRows(report.exitCodes),
    '',
    '## NEW Files',
    '| Symbol | Status | PRD Line | Detail |',
    '|---|---:|---:|---|',
    ...renderSymbolRows(report.newFiles),
    '',
    '## Helpers And Sentinels',
    '| Symbol | Status | PRD Line | Detail |',
    '|---|---:|---:|---|',
    ...renderSymbolRows(report.helperSentinels),
    '',
  ];
  if (report.findings.length > 0) {
    lines.push('## Findings', '');
    for (const finding of report.findings) {
      lines.push(`- ${finding.category}: \`${finding.symbol}\` at PRD line ${finding.sourceLine} - ${finding.reason}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export async function writeSymbolAudit(
  refinementDir: string,
  prdContent: string,
  workingDir: string,
  manifest: Pick<RefinementManifest, 'tickets'>,
  prdPath?: string
): Promise<SymbolAuditReport> {
  const report = evaluateSymbolAudit(prdContent, workingDir, manifest, prdPath);
  const auditPath = path.join(refinementDir, 'symbol_audit.md');
  await fs.promises.writeFile(auditPath, renderSymbolAuditMarkdown(report));
  return report;
}

export function runSymbolAuditEnforcement(report: SymbolAuditReport): number {
  if (report.ok) return PipelineRunnerExitCode.Success;
  process.stderr.write(`[pickle-rick] symbol audit failed: ${report.findings.length} phantom symbol(s).\n`);
  process.stderr.write(
    "[pickle-rick] Ensure each cited symbol is declared at HEAD or in a PRD listed in this bundle's `composes:` frontmatter.\n"
  );
  for (const finding of report.findings) {
    process.stderr.write(`[pickle-rick] ${finding.category} ${finding.symbol} (PRD line ${finding.sourceLine}): ${finding.reason}\n`);
  }
  return PipelineRunnerExitCode.AuditFailure;
}

export function buildRefinementManifest(args: RefinementArgs, results: CycleResults, ticketQualityWarnings?: TicketQualityWarning[]): RefinementManifest {
  const shapeData = collectAcShapeData(results);
  const enrichedTickets = enrichManifestTicketsFromSourcePrds(args.prdPath, shapeData.tickets);
  // R-PIAP-A5: run deterministic classifier after tickets drafted; result is
  // authoritative — analyst judgment captured in normalizeTicketEntry is a hint
  // that the classifier may override.
  const classifiedTickets = enrichedTickets.map((t) => ({
    ...t,
    complexity_tier: classifyTicketTier(buildClassifierInfoForEntry(t)),
  }));
  const decompQualityFlags = detectDecompositionQualityFlags(classifiedTickets);
  const manifest: RefinementManifest = {
    prd_path: args.prdPath,
    refinement_dir: results.refinementDir,
    all_success: results.allSuccess,
    cycles_requested: results.cyclesRequested,
    cycles_completed: results.allCycleResults.length,
    max_turns_per_worker: results.maxTurns,
    ac_shape_smells: shapeData.acShapeSmells,
    tickets: classifiedTickets,
    decomposition_quality_flags: decompQualityFlags,
    workers: results.finalResults.map((r) => {
      const outputFile = path.join(results.refinementDir, `analysis_${r.roleId}.md`);
      return {
        role: r.roleId,
        success: r.success,
        output_file: outputFile,
        exists: fs.existsSync(outputFile),
        log_file: r.logPath,
        cycle: r.cycle,
      };
    }),
    completed_at: new Date().toISOString(),
  };
  if (ticketQualityWarnings !== undefined) {
    manifest.ticket_quality_warnings = ticketQualityWarnings;
  }
  if (decompQualityFlags.length > 0) {
    process.stderr.write(
      `[pickle-rick] decomposition_quality_flags: ${decompQualityFlags.length} ticket(s) flagged (large_tier or open-ended derivation) — see refinement_manifest.json\n`,
    );
  }
  return manifest;
}

export async function writeManifestAtomic(manifestPath: string, manifest: RefinementManifest): Promise<void> {
  const manifestTmp = `${manifestPath}.tmp.${process.pid}`;
  try {
    await fs.promises.writeFile(manifestTmp, JSON.stringify(manifest, null, 2));
    await fs.promises.rename(manifestTmp, manifestPath);
  } catch (err) {
    try { await fs.promises.unlink(manifestTmp); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

function readCrossDocDriftWarnings(sessionDir: string): TicketQualityWarning[] {
  const bundlePath = path.join(sessionDir, 'audit-ticket-bundle.json');
  const raw = readRecoverableJsonObject(bundlePath) as {
    findings?: Array<{ ticket_id?: string; defect_class?: string; evidence?: string }>;
  } | null;
  if (raw === null) {
    process.stderr.write(
      `[spawn-refinement-team] audit-ticket-bundle.json not found at ${bundlePath}; skipping cross-doc drift warnings\n`,
    );
    return [];
  }
  const findings = Array.isArray(raw.findings) ? raw.findings : [];
  return findings
    .filter(
      (f) =>
        f.defect_class === 'cross-doc-naming-drift' &&
        typeof f.ticket_id === 'string' &&
        typeof f.evidence === 'string',
    )
    .map((f) => ({
      ticket_id: f.ticket_id as string,
      defect_class: 'cross-doc-naming-drift',
      evidence: f.evidence as string,
      source: 'post-decomp' as const,
      file_line: null,
    }));
}

/**
 * F5 / R-APV-1: scan analyst output files for backticked paths that do not
 * resolve at HEAD and are not forward-ref-annotated. Surfaces unverified
 * citations in the manifest BEFORE readiness gate fires; analyst-level
 * provenance helps operators discover which cycle/role introduced a phantom
 * path so refinement can re-run with corrective guidance instead of halting
 * downstream.
 */
export function scanAnalystOutputsForUnverifiedPaths(refinementDir: string, workingDir: string): TicketQualityWarning[] {
  const warnings: TicketQualityWarning[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(refinementDir);
  } catch {
    return warnings;
  }
  // Prefer canonical cycle-final outputs (analysis_<role>.md) over per-cycle
  // copies; canonical files are what synthesis consumes.
  const canonicalRe = /^analysis_([a-z-]+)\.md$/;
  for (const entry of entries) {
    const m = canonicalRe.exec(entry);
    if (!m) continue;
    const filePath = path.join(refinementDir, entry);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    const pathWarnings = checkAnalystOutputPaths(content, workingDir);
    for (const w of pathWarnings) {
      warnings.push({
        ticket_id: '',
        defect_class: 'analyst_path_not_verified',
        evidence: `analyst=${m[1]} path=${w.path}`,
        source: 'analyst',
        file_line: `${entry}`,
      });
    }
  }
  return warnings;
}

export type OverCollapseDetectionResult =
  | { detected: false }
  | { detected: true; composedCount: number; ticketCount: number; sourcesWithAtomicSection: string[] };

export function detectBundleOfBundlesOverCollapse(
  prdPath: string,
  manifest: RefinementManifest,
): OverCollapseDetectionResult {
  try {
    if (!fs.existsSync(prdPath)) return { detected: false };
    const content = fs.readFileSync(prdPath, 'utf-8');
    const frontmatter = parseFrontmatter(content);
    const composedPaths = composedPrdPaths(frontmatter);
    // (a) parent PRD must declare composes: with >= 2 entries
    if (composedPaths.length < 2) return { detected: false };
    // (b) >= 1 composed source must carry ## Atomic decomposition or ## Atomic tickets
    const sourcesWithAtomicSection: string[] = [];
    for (const composedPath of composedPaths) {
      const resolved = resolvePeerPrdPath(prdPath, composedPath);
      if (!resolved) continue;
      try {
        const sourceContent = fs.readFileSync(resolved, 'utf-8');
        if (/^##\s+(Atomic decomposition|Atomic tickets)\s*$/im.test(sourceContent)) {
          sourcesWithAtomicSection.push(composedPath);
        }
      } catch { /* skip unreadable source */ }
    }
    if (sourcesWithAtomicSection.length === 0) return { detected: false };
    // (c) manifest collapsed to <= one ticket per composed source
    if (manifest.tickets.length > composedPaths.length) return { detected: false };
    return {
      detected: true,
      composedCount: composedPaths.length,
      ticketCount: manifest.tickets.length,
      sourcesWithAtomicSection,
    };
  } catch {
    return { detected: false };
  }
}

const OPEN_ENDED_DERIVATION_RE = /author\s+\d+|review\s+(the\s+)?whole|against\s+\d+\s+principles|all\s+\w+\s+rows/i;

export function detectDecompositionQualityFlags(
  tickets: RefinementTicketManifestEntry[],
): DecompositionQualityFlag[] {
  const flags: DecompositionQualityFlag[] = [];
  for (const ticket of tickets) {
    const text = [ticket.title, ticket.acceptance_test, ticket.justification]
      .filter((s): s is string => Boolean(s))
      .join(' ');
    if (ticket.complexity_tier === 'large') {
      flags.push({
        ticket_id: ticket.id,
        reason: 'large_tier',
        evidence: 'complexity_tier=large',
        action: 'pre_split',
        suggested_reframe: `Split "${ticket.title}" into two bounded sub-tickets, each targeting a distinct bounded scope`,
      });
    } else {
      const match = text.match(OPEN_ENDED_DERIVATION_RE);
      if (match) {
        flags.push({
          ticket_id: ticket.id,
          reason: 'open_ended_derivation',
          evidence: match[0],
          action: 'bounded_reframe',
          suggested_reframe: `Re-frame "${ticket.title}" to target a fixed, enumerable artifact (e.g. "transcribe X" instead of "derive X")`,
        });
      }
    }
  }
  return flags;
}

async function main() {
  const args = parseAndValidateArgs(process.argv.slice(2));
  const settings = loadRefinementSettings();
  const runtime = resolveRuntime(args, settings);
  const prdContent = await fs.promises.readFile(args.prdPath, 'utf-8');
  const cycleResults = await orchestrateCycles(args, settings, prdContent);
  const manifestPath = path.join(args.sessionDir, 'refinement_manifest.json');
  const crossDocWarnings = readCrossDocDriftWarnings(args.sessionDir);
  const analystPathWarnings = scanAnalystOutputsForUnverifiedPaths(cycleResults.refinementDir, runtime.workingDir);
  const combinedWarnings = [...crossDocWarnings, ...analystPathWarnings];
  if (analystPathWarnings.length > 0) {
    process.stderr.write(`[pickle-rick] analyst_path_not_verified count=${analystPathWarnings.length} (see refinement_manifest.json ticket_quality_warnings)\n`);
  }
  const manifest = buildRefinementManifest(args, cycleResults, combinedWarnings.length > 0 ? combinedWarnings : undefined);
  try {
    const overCollapseResult = detectBundleOfBundlesOverCollapse(args.prdPath, manifest);
    if (overCollapseResult.detected) {
      const overCollapseWarning: TicketQualityWarning = {
        ticket_id: '',
        defect_class: 'bundle_of_bundles_over_collapse',
        evidence: `composed_sources=${overCollapseResult.composedCount} tickets=${overCollapseResult.ticketCount} atomic_sources=${overCollapseResult.sourcesWithAtomicSection.join(',')}`,
        source: 'post-decomp',
        file_line: null,
      };
      manifest.ticket_quality_warnings = [...(manifest.ticket_quality_warnings ?? []), overCollapseWarning];
      process.stderr.write(
        `[pickle-rick] refinement_over_collapse_detected: ${overCollapseResult.ticketCount} tickets <= ${overCollapseResult.composedCount} composed sources (${overCollapseResult.sourcesWithAtomicSection.join(', ')} have atomic sections)\n`,
      );
      const statePath = path.join(args.sessionDir, 'state.json');
      try {
        writeActivityEntry(statePath, {
          event: 'refinement_over_collapse_detected',
          ts: new Date().toISOString(),
          gate_payload: {
            composed_count: overCollapseResult.composedCount,
            ticket_count: overCollapseResult.ticketCount,
            sources_with_atomic_section: overCollapseResult.sourcesWithAtomicSection,
          },
        });
      } catch { /* best-effort telemetry */ }
    }
  } catch { /* guard must never throw or change exit code */ }
  await writeManifestAtomic(manifestPath, manifest);
  const symbolAudit = await writeSymbolAudit(cycleResults.refinementDir, prdContent, runtime.workingDir, manifest, args.prdPath);
  const symbolAuditStatus = runSymbolAuditEnforcement(symbolAudit);
  if (symbolAuditStatus !== 0) process.exit(symbolAuditStatus);
  const acShapeStatus = runAcShapeEnforcement(manifest, { sessionDir: args.sessionDir, skipAcShapeGate: args.skipAcShapeGate });
  if (acShapeStatus !== 0) process.exit(acShapeStatus);
  const postRefinementGate = runAcPhaseGate({
    sessionDir: args.sessionDir,
    evaluationPhase: 'post-refinement',
    cwd: runtime.workingDir,
    stdout: (msg) => console.log(msg),
    stderr: (msg) => console.error(msg),
  });
  if (postRefinementGate.status !== 'pass') process.exit(2);
  const readinessStatus = runReadinessGate(args.sessionDir, runtime.workingDir, manifestPath);
  if (readinessStatus !== 0) process.exit(readinessStatus);

  if (!cycleResults.allSuccess) {
    const failed = cycleResults.finalResults.filter((r) => !r.success).map((r) => r.roleId);
    console.log(
      `${Style.YELLOW}⚠️  Workers failed: ${failed.join(', ')}. Synthesis will proceed with available analyses.${Style.RESET}`
    );
  }

  process.stdout.write(`REFINEMENT_DIR=${cycleResults.refinementDir}\n`);
  process.stdout.write(`MANIFEST=${manifestPath}\n`);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'spawn-refinement-team.js') {
  main().catch((err) => {
    const msg = safeErrorMessage(err);
    const e = err as NodeJS.ErrnoException;
    const detail = e && typeof e === 'object' ? ` [syscall=${e.syscall ?? '?'} path=${e.path ?? '?'}]` : '';
    console.error(`${Style.RED}❌ Fatal: ${msg}${detail}${Style.RESET}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  });
}

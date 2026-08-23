#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, spawnSync, execFileSync } from 'child_process';
import { printMinimalPanel, Style, formatTime, getExtensionRoot, getDataRoot, formatLocalDateKey, buildHandoffSummary, sleep, writeStateFile, markTicketDone, markTicketSkipped, markTicketWithStatus as writeTicketStatus, collectTickets, getTicketStatus, runCmd, safeErrorMessage, ensureMonitorWindow, displayMacNotification, parseTicketFrontmatter, getTicketTierBudgetWithOverrides, readFrontmatterField, upsertFrontmatterField, ticketFilePath, VALID_TICKET_COMPLEXITY_TIERS, TIER_LIFECYCLE, composeManagerPromptFromSkill, resolveWorkerTestGateTimeoutMs, scrubGateEnv, resolveCommandTemplate, loadPickleSettingsBag, resolveHardeningSettings, resolveCodegraphSettings, resolveRateLimitSettings, DEFAULT_MAX_PARK_MINUTES, type CompletionCommitEvidence, type TicketComplexityTier, type TicketInfo, type TicketStatus, type TicketTierBudget } from '../services/pickle-utils.js';
import { findMissingPrefixes, requiredTierArtifactPrefixes } from '../services/artifact-validation.js';
import { State, PromiseTokens, hasToken, VALID_STEPS, Defaults, EXIT_REASONS, FALSE_EPIC_THRESHOLD, hasLifecycleArtifact, NO_PROGRESS_FAILURE_REASONS, WORKER_GATE_VERDICT_FIELD, type ActivityLogEntry, type Backend, type RateLimitInfo, type IterationExitResult, type IterationOutcome, type MuxIterationReason, type RateLimitAction, type RateLimitPark, type WorkerRole, type Step, type RecoveryAttempt, type HardeningSettings, type OrphanReattachPayload, type TicketFailureReason, type PostFinalVerdictState } from '../types/index.js';
import { StateManager, safeDeactivate, finalizeTerminalState, finalizeIfTrulyComplete, recordExitReason, clearExitReason, writeActivityEntry, writeTimeoutStub, assertSchemaVersionDeployParity, SchemaVersionDeployDriftError, isProcessAlive, type GraduationCounts } from '../services/state-manager.js';
import { logActivity } from '../services/activity-logger.js';
import { loadSettings, initCircuitBreaker, canExecute, detectProgress, extractErrorSignature, recordIterationResult, resetCircuitBreaker, type CircuitBreakerConfig, type CircuitBreakerState } from '../services/circuit-breaker.js';
import { buildManagerInvocation, resolveBackend, resolveBackendFromStateFileWithSource, backendEnvOverrides, sessionStampEnv } from '../services/backend-spawn.js';
import { resolveCodexModel, resolvePackageManagerBin } from './spawn-morty.js';
import { readTicketWorkerGateTestsVerdict } from './setup.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';
import { reapOrphanedWorkerProcs, type ReapOrphanedWorkerProcsOpts, type ReapSweepResult } from '../services/orphan-reaper.js';
import { extractAssistantContent, detectOutputFormat, observeCodexToolCallStream, CODEX_DELIMITER_RE } from '../services/classifier-utils.js';
import { emitCrossTicketRegressionLinearComment } from '../lib/linear-comment.js';
import {
  evaluateManagerRelaunch,
  recordManagerRelaunch,
  type ManagerRelaunchExitKind,
  type ManagerRelaunchDecision,
} from '../services/manager-relaunch.js';
import { runGit, getHeadBranch, updateTicketFrontmatter, isWorkingTreeDirty, listWorkingTreeDirtyPaths, archiveBeforeDestructive, ArchiveAbortError, isCodegraphArtifact, CODEGRAPH_PATHSPEC_EXCLUDES, type ArchiveContext, type ArchiveResult } from '../services/git-utils.js';
import { runRecoveryLadder, parsePlanPhases, executePhaseLoop, isConvergedPlanEligible, type PlanPhase, type RecoveryDeps, type RecoveryEvidence, type RecoveryOutcome, type ReExecutionSeam } from '../services/recovery-controller.js';
import { detectArtifactProgress, resolveNoProgressWindowSeconds, type ArtifactProgressSnapshot } from '../services/artifact-progress-detector.js';
import { persistEvidence, gateForPhantomDoneRevert, evaluateCompletionEvidence, type EvidenceCtx, type RevertDecision, type CompletionDecisionCtx, type CompletionDecisionKind } from '../services/ticket-completion-evidence.js';
import { readDeclaredFiles } from '../services/ticket-declared-files.js';
import { CodegraphService } from '../services/codegraph-service.js';
import { salvageTicket, type SalvageDeps } from '../lib/salvage-ticket.js';
import { reconcileTicketTruth } from '../lib/reconcile-ticket-truth.js';
import { salvageDirtyTree, stashUnattributableRemainder } from '../services/dirty-tree-salvage.js';
import { checkScopeDiff } from './check-scope-diff.js';
export { extractAssistantContent, detectOutputFormat, observeCodexToolCallStream } from '../services/classifier-utils.js';
export { stripSetupSection } from '../services/pickle-utils.js';
export {
  evaluateManagerRelaunch,
  recordManagerRelaunch,
} from '../services/manager-relaunch.js';

const sm = new StateManager();

let currentChildProc: import('child_process').ChildProcess | null = null;

export interface OrphanDetectionResult {
  orphan_session_path: string;
  orphan_started_at: number;
  parent_session_hash: string;
  orphan_pid: number;
}

function readSiblingState(siblingStatePath: string): Record<string, unknown> | null {
  try {
    const recovered = readRecoverableJsonObject(siblingStatePath);
    if (!recovered || typeof recovered !== 'object' || Array.isArray(recovered)) return null;
    return recovered as Record<string, unknown>;
  } catch { return null; }
}

function siblingQualifiesAsOrphan(
  sibling: Record<string, unknown>,
  parentWorkingDir: string | undefined,
): { qualifies: boolean; parentHash: string | null } {
  const parentHash = typeof sibling.parent_session_hash === 'string' && sibling.parent_session_hash
    ? sibling.parent_session_hash : null;
  const isManagerSubprocess = sibling.invocation_source === 'manager_subprocess';
  if (!parentHash && !isManagerSubprocess) return { qualifies: false, parentHash };
  if (sibling.working_dir !== parentWorkingDir) return { qualifies: false, parentHash };
  return { qualifies: true, parentHash };
}

/** Scans session directories for orphaned pickle-rick processes. */
export function detectOrphanSessions(
  state: State,
  dataRoot: string,
  sessionDir: string,
): OrphanDetectionResult[] {
  const sessionsRoot = path.join(dataRoot, 'sessions');
  const parentWorkingDir = state.working_dir;
  const results: OrphanDetectionResult[] = [];
  const alreadyDetected = new Set(Array.isArray(state.orphans_detected) ? state.orphans_detected : []);
  let entries: string[];
  try { entries = fs.readdirSync(sessionsRoot); } catch { return results; }
  for (const entry of entries) {
    if (path.join(sessionsRoot, entry) === sessionDir) continue;
    if (alreadyDetected.has(entry)) continue;
    const sibling = readSiblingState(path.join(sessionsRoot, entry, 'state.json'));
    if (!sibling) continue;
    const { qualifies, parentHash } = siblingQualifiesAsOrphan(sibling, parentWorkingDir);
    if (!qualifies) continue;
    results.push({
      orphan_session_path: path.join(sessionsRoot, entry),
      orphan_started_at: typeof sibling.start_time_epoch === 'number' ? sibling.start_time_epoch : 0,
      parent_session_hash: parentHash ?? 'unknown',
      orphan_pid: typeof sibling.pid === 'number' ? sibling.pid : 0,
    });
  }
  return results;
}

/**
 * R-WSRC-2: schema-ahead graceful exit at the top-of-loop state read.
 *
 * `sm.read()` throws `SchemaVersionAheadError` (R-WSRC-1) or a raw
 * `SCHEMA_MISMATCH` `StateError` when `state.json` carries a `schema_version`
 * newer than the currently-deployed runtime supports (e.g., a worker writes a
 * forward-schema state in violation of `send-to-morty.md:61`, or a mid-deploy
 * schema bump leaves the on-disk file ahead of the running binary). Before
 * R-WSRC-2, only the cap-check site routed SCHEMA_MISMATCH to `'continue'`;
 * every other read site threw upward, the outer loop retried, and the runner
 * wedged at 1 warn/sec indefinitely (R-QGSK-3 incident class).
 *
 * The wrapper catches both error shapes and forces a graceful, attributable
 * exit: stamp `exit_reason = 'state_schema_version_ahead'`, deactivate, then
 * `process.exit(3)` (PipelineRunnerExitCode.PhaseIncomplete) so auto-resume.sh
 * R-CNAR-4(c) stops the loop instead of running the operator's budget down.
 */
export function readRunnerState(statePath: string): State {
  try {
    return sm.read(statePath);
  } catch (err) {
    if (isSchemaVersionAheadError(err)) {
      handleSchemaVersionAhead(statePath, err);
    }
    throw err;
  }
}

export function isSchemaVersionAheadError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; name?: string };
  return e.code === 'SCHEMA_MISMATCH' || e.name === 'SchemaVersionAheadError';
}

function handleSchemaVersionAhead(statePath: string, err: unknown): never {
  const msg = safeErrorMessage(err);
  try {
    process.stderr.write(
      `[FATAL] state.json schema is ahead of this runtime: ${msg}. ` +
      `Exiting with state_schema_version_ahead (code 3).\n`,
    );
  } catch { /* stderr write must not crash the exit path */ }
  // recordExitReason + safeDeactivate go through forceWriteMutate, which itself
  // calls sm.read(); on a schema-ahead state.json those reads also fail and the
  // forensic stamp is dropped. Bypass via a direct forceWrite of the minimal
  // forensic envelope. The on-disk forward-schema state is sacrificed (it was
  // unreadable anyway) in favor of a parseable {active:false, exit_reason:...}
  // record so dead-pid recovery, stop-hook, and auto-resume.sh R-CNAR-4(c) all
  // see the exit attribution.
  try {
    // R-WSRC-2: lock cannot be acquired because the lock-protected path
    // (StateManager.update → sm.read) fails on SCHEMA_MISMATCH; the whole
    // point of this handler is to replace the unreadable state with a
    // minimal forensic envelope so subsequent reads work.
    // eslint-disable-next-line pickle/no-raw-state-write
    sm.forceWrite(statePath, { active: false, exit_reason: 'state_schema_version_ahead' });
  } catch { /* never throw on forensic stamp */ }
  try { recordExitReason(statePath, 'state_schema_version_ahead'); } catch { /* never throw on forensic stamp */ }
  try { safeDeactivate(statePath); } catch { /* never throw on deactivate */ }
  process.exit(3);
}

function removeRunnerSessionMapEntry(statePath: string, log: (msg: string) => void): void {
  const sessionsMapPath = path.join(getDataRoot(), 'current_sessions.json');
  const sessionDir = path.dirname(statePath);
  const cwd = (() => {
    try {
      const state = readRunnerState(statePath);
      return typeof state.working_dir === 'string' ? state.working_dir : '';
    } catch {
      return '';
    }
  })();
  if (!cwd) return;
  try {
    const map = (readRecoverableJsonObject(sessionsMapPath) || {}) as Record<string, unknown>;
    let removed = false;
    for (const [entryCwd, entryValue] of Object.entries(map)) {
      const mappedSessionPath =
        typeof entryValue === 'string'
          ? entryValue
          : (entryValue && typeof entryValue === 'object' && typeof (entryValue as Record<string, unknown>).sessionPath === 'string')
              ? String((entryValue as Record<string, unknown>).sessionPath)
              : '';
      if (entryCwd === cwd || (mappedSessionPath && path.resolve(mappedSessionPath) === path.resolve(sessionDir))) {
        delete map[entryCwd];
        removed = true;
      }
    }
    if (!removed) return;
    const tmpMap = `${sessionsMapPath}.tmp.${process.pid}.${Date.now()}`;
    try {
      fs.writeFileSync(tmpMap, JSON.stringify(map, null, 2));
      fs.renameSync(tmpMap, sessionsMapPath);
    } catch (err) {
      try { fs.unlinkSync(tmpMap); } catch { /* ignore cleanup failure */ }
      throw err;
    }
  } catch (err) {
    log(`WARNING: failed to remove current_sessions.json entry for forensic exit: ${safeErrorMessage(err)}`);
  }
}

export function killCurrentChild(): void {
  if (currentChildProc && !currentChildProc.killed) {
    currentChildProc.kill('SIGTERM');
  }
}

interface IterationRuntimeOverrides {
  envOverrides?: NodeJS.ProcessEnv;
  maxIterationSeconds?: number;
  outputStallSeconds?: number;
}

const TASK_NOTE_PRIORITY: Record<string, number> = {
  'Next': 0,
  'Dead Ends': 1,
  'Key Discoveries': 2,
  'Progress': 3,
};

const TASK_NOTE_TRUNC_MARKER = '[truncated]';
/** Default character budget for {@link truncateTaskNotes}; caps TASK_NOTES.md injected into the manager prompt. */
const TASK_NOTES_MAX_CHARS = 2000;

const MANAGER_TURN_HEARTBEAT_POLL_MS = 20_000;
const HEARTBEAT_ARTIFACT_PREFIXES = ['research_', 'plan_', 'conformance_'] as const;

// R-MWIS-1 / AC-R-WPEXA-9: bounded stdio-drain window after the child's 'exit'
// event. Node's 'close' event (the PRIMARY completion signal) is gated on
// stdio-pipe closure, which can lag indefinitely on a silent 0-byte worker exit
// (render-lag or an inherited fd) and hang the mux loop at 0% CPU. After 'exit'
// fires we give the pipes this window to flush any imminent 'close' (avoids
// truncating buffered worker output) before finalizing. The healthy path
// finalizes via 'close' (which fires promptly), so this window only bounds the
// genuinely silent exit; 250ms was too short and truncated healthy
// small/medium worker output on the foreground exit path. Tunable per-machine
// via PICKLE_EXIT_DRAIN_FALLBACK_MS (strict positive integer); invalid / absent
// / non-positive falls back to this 30_000 ms default.
const EXIT_DRAIN_FALLBACK_MS = 30_000;
export const EXIT_DRAIN_FALLBACK_ENV_VAR = 'PICKLE_EXIT_DRAIN_FALLBACK_MS';

// Resolve the exit-drain fallback window. Env override wins when it parses as a
// strict positive integer; everything else (absent / blank / non-numeric /
// zero / negative / fractional) falls back to EXIT_DRAIN_FALLBACK_MS. Mirrors
// resolveWorkerTestGateTimeoutMs in services/pickle-utils.ts, minus the floor
// clamp (here the contract is default-on-invalid with no minimum beyond > 0).
export function resolveExitDrainFallbackMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[EXIT_DRAIN_FALLBACK_ENV_VAR];
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return EXIT_DRAIN_FALLBACK_MS;
}

// B-APNC WS-1: max passes a subsystem may run WITHOUT a clean pass before anatomy-park's
// worker-mode loop halts-and-reports it as non-convergent (rather than grinding to the
// iteration cap). Tunable per-machine via PICKLE_APNC_MAX_PASSES_WITHOUT_CLEAN (strict
// positive integer); invalid / absent / non-positive falls back to this 8 default.
const APNC_MAX_PASSES_WITHOUT_CLEAN = 8;
export const APNC_MAX_PASSES_ENV_VAR = 'PICKLE_APNC_MAX_PASSES_WITHOUT_CLEAN';

// Resolve the anatomy-park non-convergence pass ceiling. Env override wins when it parses
// as a strict positive integer; everything else (absent / blank / non-numeric / zero /
// negative / fractional) falls back to APNC_MAX_PASSES_WITHOUT_CLEAN. Mirrors
// resolveExitDrainFallbackMs (default-on-invalid, no floor beyond > 0).
export function resolveApncMaxPassesWithoutClean(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[APNC_MAX_PASSES_ENV_VAR];
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return APNC_MAX_PASSES_WITHOUT_CLEAN;
}

export function maybeEmitManagerTurnProgress(opts: {
  sessionDir: string;
  statePath: string;
  ticketId: string | null | undefined;
  lastSeenMtimeMs: number;
}): number {
  const { sessionDir, statePath, ticketId, lastSeenMtimeMs } = opts;
  if (!ticketId) return lastSeenMtimeMs;
  const ticketDir = path.join(sessionDir, ticketId);
  let files: string[];
  try {
    files = fs.readdirSync(ticketDir);
  } catch {
    return lastSeenMtimeMs;
  }
  let maxMtimeMs = lastSeenMtimeMs;
  for (const f of files) {
    if (!HEARTBEAT_ARTIFACT_PREFIXES.some(p => f.startsWith(p)) || !f.endsWith('.md')) continue;
    try {
      const { mtimeMs } = fs.statSync(path.join(ticketDir, f));
      if (mtimeMs > maxMtimeMs) maxMtimeMs = mtimeMs;
    } catch { /* skip unreadable */ }
  }
  if (maxMtimeMs > lastSeenMtimeMs) {
    const now = new Date();
    // fs.utimesSync truncates the Date to integer-ms precision, but the OS may have
    // recorded the prior state.json write with sub-ms precision. Bumping "to now" can
    // therefore REGRESS the mtime when <1ms has elapsed since that write. The babysitter
    // freshness signal must be monotonic, so floor the current mtime and add 1ms to
    // guarantee a strict advance regardless of how fast the heartbeat fires.
    const currentMtimeMs = fs.statSync(statePath).mtimeMs;
    const bumpMtime = new Date(Math.max(now.getTime(), Math.floor(currentMtimeMs) + 1));
    fs.utimesSync(statePath, bumpMtime, bumpMtime);
    logActivity({
      event: 'manager_turn_progress',
      source: 'pickle',
      session: path.basename(sessionDir),
      ticket_id: ticketId,
      ts: now.toISOString(),
    });
    return maxMtimeMs;
  }
  return lastSeenMtimeMs;
}

interface TaskNoteSection { name: string; body: string; }

function parseTaskNoteSections(content: string): { preamble: string; sections: TaskNoteSection[] } {
  const sectionRegex = /^## .+$/gm;
  const sections: TaskNoteSection[] = [];
  let preamble = '';
  let lastIndex = 0;
  let lastHeader = '';
  let match: RegExpExecArray | null;

  while ((match = sectionRegex.exec(content)) !== null) {
    if (lastIndex === 0 && match.index > 0) {
      preamble = content.slice(0, match.index);
    } else if (lastHeader) {
      sections.push({ name: lastHeader, body: content.slice(lastIndex, match.index) });
    }
    lastHeader = match[0].replace(/^## /, '').trim();
    lastIndex = match.index;
  }
  if (lastHeader) {
    sections.push({ name: lastHeader, body: content.slice(lastIndex) });
  }
  return { preamble, sections };
}

function priorityFor(name: string): number {
  return TASK_NOTE_PRIORITY[name] ?? 3;
}

type WorkerGateFailureSummaryEvent = {
  event: 'worker_gate_failed';
  ticket_id?: string;
  gate_phase?: string;
  retry_count?: number;
  failures?: Array<{
    name?: string;
    file?: string;
    message?: string;
  }>;
  ts?: string;
};

export type BetweenTicketGateFailure = {
  name: string;
  file: string;
  /**
   * AC-3: explicit marker distinguishing a script/lifecycle failure (the gate died before
   * emitting any TAP output, e.g. in `pretest:fast`) from a real TAP `not ok` failure. A real
   * TAP failure never sets this — `file === ''` alone is NOT a reliable discriminator, since a
   * TAP failure can also lack a `location:` line.
   */
  script_failure?: boolean;
  /** Diagnostic text for a script failure: the tail of the gate's stdout/stderr. */
  message?: string;
};

export type BetweenTicketGateResult = {
  ok: boolean;
  failures: BetweenTicketGateFailure[];
  timed_out: boolean;
  timeout_ms: number | null;
};

export interface OrphanedFastTestRunner {
  pid: number;
  ppid: number;
  etime_seconds: number;
  argv_summary: string;
}

type RunBetweenTicketFastGateInput = {
  statePath: string;
  workingDir: string;
  completedTicketId: string;
  nextTicketId: string | null;
  landedStatus: string | null | undefined;
  log: (msg: string) => void;
  now?: () => number;
  /**
   * Explicit spawn timeout for this call site. Omitted by the between-ticket callers, which keep
   * inheriting `resolveWorkerTestGateTimeoutMs`. R-NOPOSTTIER's post-final call passes one because
   * the resolver's 600000 ms default sits BELOW this repo's measured fast tier (835042 ms).
   */
  timeoutMs?: number;
  runTestFast?: (extensionDir: string, timeoutMs?: number) => BetweenTicketGateResult;
};

function parsePsElapsedSeconds(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  const [dayPart, clockPart] = value.includes('-') ? value.split('-', 2) : [null, value];
  const segments = clockPart.split(':').map(segment => Number(segment));
  if (segments.some(segment => !Number.isFinite(segment) || segment < 0)) return null;
  const days = dayPart === null ? 0 : Number(dayPart);
  if (!Number.isFinite(days) || days < 0) return null;
  if (segments.length === 2) {
    const [minutes, seconds] = segments;
    return (days * 86400) + (minutes * 60) + seconds;
  }
  if (segments.length === 3) {
    const [hours, minutes, seconds] = segments;
    return (days * 86400) + (hours * 3600) + (minutes * 60) + seconds;
  }
  return null;
}

function isFastTestRunnerCommand(command: string, extensionDir: string): boolean {
  if (!command.includes(extensionDir)) return false;
  const normalized = command.replace(/\s+/g, ' ').trim();
  const isNpmFastTest = /\bnpm(?:\s|$)/.test(normalized) && normalized.includes('run test:fast');
  const isNodeTestChild = /\bnode(?:\s|$)/.test(normalized) && normalized.includes('--test');
  return isNpmFastTest || isNodeTestChild;
}

export function parseOrphanedFastTestRunnersFromPs(
  psOutput: string,
  extensionDir: string,
  minAgeSeconds = 600,
): OrphanedFastTestRunner[] {
  const results: OrphanedFastTestRunner[] = [];
  for (const rawLine of psOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const rawPid = Number(match[1]);
    const rawPpid = Number(match[2]);
    const pid = Number.isFinite(rawPid) ? rawPid : 0;
    const ppid = Number.isFinite(rawPpid) ? rawPpid : 0;
    const etimeSeconds = parsePsElapsedSeconds(match[3]);
    const command = match[4].trim();
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || etimeSeconds === null) continue;
    if (ppid !== 1) continue;
    if (etimeSeconds <= minAgeSeconds) continue;
    if (!isFastTestRunnerCommand(command, extensionDir)) continue;
    results.push({
      pid,
      ppid,
      etime_seconds: etimeSeconds,
      argv_summary: command,
    });
  }
  return results;
}

export function reapOrphanedFastTestRunnersOnStartup(
  statePath: string,
  extensionDir: string,
  log: (msg: string) => void,
  opts: {
    psOutput?: string;
    scan?: (extensionDir: string) => string;
    kill?: (pid: number) => void;
  } = {},
): OrphanedFastTestRunner[] {
  const scan = opts.scan ?? (() => execFileSync('ps', ['-axo', 'pid=,ppid=,etime=,command='], {
    encoding: 'utf-8',
    timeout: 5000,
    maxBuffer: 1024 * 1024 * 8,
  }));
  const kill = opts.kill ?? ((pid: number) => {
    process.kill(pid, 'SIGKILL');
  });
  const psOutput = opts.psOutput ?? scan(extensionDir);
  const orphans = parseOrphanedFastTestRunnersFromPs(psOutput, extensionDir);
  for (const orphan of orphans) {
    kill(orphan.pid);
    writeActivityEntry(statePath, {
      event: 'orphan_test_runner_reaped',
      ts: new Date().toISOString(),
      pid: orphan.pid,
      etime_seconds: orphan.etime_seconds,
      argv_summary: orphan.argv_summary,
    });
    log(`reaped orphan fast-test runner pid=${orphan.pid} etime_seconds=${orphan.etime_seconds}`);
  }
  return orphans;
}

/**
 * AC5: record a non-zero R-CXHANG worker-proc reap sweep as an activity
 * event so a pipeline run's reap is auditable after the fact; a zero-reap
 * sweep stays quiet (no event, no log line).
 *
 * The third consumer of `reapOrphanedWorkerProcs` (AP-EXT-ITER45-01), and the only one
 * that fires per-iteration rather than once per run. That cadence is why it does NOT
 * report every `skipped` reason the way `setup.ts:runSetupOrphanReap` and
 * `reap-orphans.ts:runStandaloneOrphanReap` do: `kill_switch` and `unsupported_platform`
 * are operator/platform constants for the whole run, so restating them each iteration is
 * pure noise. A `sweep_failed` is the one reason that is NEWS — it says this iteration
 * has no census at all, so leaked worker procs are not ruled out. Its two sibling reapers
 * in the same call-site `try` blocks get this for free by throwing; this one cannot,
 * because `reapOrphanedWorkerProcs` is contractually best-effort and never throws, which
 * leaves the callers' `catch` unreachable for every real scan failure.
 */
export function runPipelineOrphanWorkerReap(
  statePath: string,
  sessionsRoot: string,
  log: (msg: string) => void,
  deps: { reap?: (opts: ReapOrphanedWorkerProcsOpts) => ReapSweepResult } = {},
): void {
  const reap = deps.reap ?? reapOrphanedWorkerProcs;
  const result = reap({ sessionsRoot, statePath });
  // Did the sweep RUN? Only then are its zero counts a reading.
  if (result.skipped === 'sweep_failed') {
    log('orphan-worker reap: sweep FAILED — no census this iteration; leaked worker procs are NOT ruled out');
    return;
  }
  // Did it FIND anything? A genuinely empty census stays quiet.
  if (result.reaped <= 0) return;
  log(`orphan-worker reap: scanned=${result.scanned} reaped=${result.reaped} unverified=${result.unverified}`);
  try {
    writeActivityEntry(statePath, {
      event: 'worker_orphan_reap_summary',
      ts: new Date().toISOString(),
      scanned: result.scanned,
      reaped: result.reaped,
      unverified: result.unverified,
      session_owned: result.by_match_class.session_owned,
      tmp_prefix_fixture: result.by_match_class.tmp_prefix_fixture,
      repo_fixture_path: result.by_match_class.repo_fixture_path,
    });
  } catch { /* best-effort telemetry — never block the runner */ }
}

// ---------------------------------------------------------------------------
// R-OMS: orphan manager reaping at iteration boundaries
// ---------------------------------------------------------------------------

/** R-OMS-1: Write the active manager pid sidecar. */
export function writeActivePidFile(sessionDir: string, pid: number): void {
  fs.writeFileSync(path.join(sessionDir, '.active_manager.pid'), String(pid));
}

/** R-OMS-1: Clear the active manager pid sidecar (ENOENT-safe). */
export function clearActivePidFile(sessionDir: string): void {
  try {
    fs.unlinkSync(path.join(sessionDir, '.active_manager.pid'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** R-OMS-2: Parse orphaned claude manager processes from ps output. */
export function parseOrphanedManagersFromPs(
  psOutput: string,
  sessionDir: string,
): Array<{ pid: number; argv_summary: string }> {
  const results: Array<{ pid: number; argv_summary: string }> = [];
  for (const rawLine of psOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const rawPid = Number(match[1]);
    if (!Number.isInteger(rawPid) || rawPid <= 0) continue;
    const command = match[4].trim();
    // Must be the claude binary
    const binaryPart = command.split(/\s+/)[0] ?? '';
    if (path.basename(binaryPart) !== 'claude') continue;
    // Must have --dangerously-skip-permissions
    if (!command.includes('--dangerously-skip-permissions')) continue;
    // Must reference this sessionDir
    if (!command.includes(sessionDir)) continue;
    results.push({ pid: rawPid, argv_summary: command });
  }
  return results;
}

/** R-OMS-2: Reap stray manager processes at iteration_start before spawning a new one. */
export function reapOrphanedManagersAtIterationStart(
  statePath: string,
  sessionDir: string,
  log: (msg: string) => void,
  opts: {
    psOutput?: string;
    kill?: (pid: number) => void;
  } = {},
): Array<{ pid: number; argv_summary: string }> {
  const kill = opts.kill ?? ((pid: number) => { process.kill(pid, 'SIGTERM'); });
  const psOutput = opts.psOutput ?? execFileSync('ps', ['-axo', 'pid=,ppid=,etime=,command='], {
    encoding: 'utf-8',
    timeout: 5000,
    maxBuffer: 1024 * 1024 * 8,
  });

  // Build suspect set: ps-scan first, then pidfile
  const suspects = new Map<number, string>();
  for (const orphan of parseOrphanedManagersFromPs(psOutput, sessionDir)) {
    suspects.set(orphan.pid, orphan.argv_summary);
  }

  // Add pid from sidecar pidfile (covers processes that exited but left the pidfile)
  const pidfilePath = path.join(sessionDir, '.active_manager.pid');
  try {
    const raw = fs.readFileSync(pidfilePath, 'utf-8').trim();
    const pidFromFile = Number(raw);
    if (Number.isInteger(pidFromFile) && pidFromFile > 0 && !suspects.has(pidFromFile)) {
      suspects.set(pidFromFile, 'from-pidfile');
    }
  } catch {
    // ENOENT or unreadable — no pidfile, skip
  }

  const reaped: Array<{ pid: number; argv_summary: string }> = [];
  for (const [pid, argv_summary] of suspects) {
    if (pid === process.pid) continue; // never kill self
    try { kill(pid); } catch { /* best effort — process may have already exited */ }
    writeActivityEntry(statePath, {
      event: 'orphan_manager_reaped',
      ts: new Date().toISOString(),
      pid,
      argv_summary,
    });
    log(`reaped orphan manager pid=${pid}`);
    reaped.push({ pid, argv_summary });
  }
  return reaped;
}

/** npm's own lifecycle banner shape (e.g. `> pickle-rick-scripts@2.1.0-beta.9 pretest:fast`). */
const NPM_LIFECYCLE_BANNER_RE = /^> \S+@\S+ \S+$/;
const NPM_LIFECYCLE_BANNER_PHASE_RE = /^>\s+\S+@\S+\s+(\S+)$/;
const SCRIPT_FAILURE_FALLBACK_NAME = 'script failure: npm run test:fast';

/**
 * AC-1/AC-3: when the gate dies before any TAP output (e.g. in `pretest:fast`), the npm
 * lifecycle banner is always the first non-empty line — never a real test name. This parses the
 * banner to name the actual npm script phase that failed instead of scraping that banner line.
 */
function extractFailingNpmScriptPhase(lines: string[]): string | null {
  let phase: string | null = null;
  for (const line of lines) {
    const match = line.trim().match(NPM_LIFECYCLE_BANNER_PHASE_RE);
    if (match) phase = match[1];
  }
  return phase;
}

/** AC-2: the tail of the gate's output, carrying the failing audit script's own error text. */
function buildScriptFailureMessage(lines: string[]): string {
  const nonEmpty = lines.map(line => line.trim()).filter(Boolean);
  const tail = nonEmpty.slice(-20).join('\n');
  return tail || 'npm run test:fast failed';
}

function normalizeBetweenTicketFailureFile(rawFile: string, workingDir: string): string {
  const trimmed = rawFile.trim();
  if (!trimmed) return '';
  const normalized = trimmed.replace(/\\/g, '/');
  if (!path.isAbsolute(normalized)) return normalized;
  const relative = path.relative(workingDir, normalized).replace(/\\/g, '/');
  return relative.startsWith('..') ? normalized : relative;
}

export function parseBetweenTicketFastGateFailures(output: string, workingDir: string): BetweenTicketGateFailure[] {
  const failures: BetweenTicketGateFailure[] = [];
  const lines = output.split(/\r?\n/);
  let activeFailure: BetweenTicketGateFailure | null = null;

  const flushFailure = () => {
    if (!activeFailure) return;
    failures.push({
      name: activeFailure.name,
      file: activeFailure.file,
    });
    activeFailure = null;
  };

  for (const line of lines) {
    const failureStart = line.match(/^not ok(?:\s+\d+)?\s+-\s+(.+)$/);
    if (failureStart) {
      flushFailure();
      activeFailure = { name: failureStart[1].trim(), file: '' };
      continue;
    }
    if (!activeFailure) continue;
    if (line.trim() === '...') {
      flushFailure();
      continue;
    }
    const locationMatch = line.match(/location:\s*'([^']+)'/) ?? line.match(/location:\s*"([^"]+)"/);
    if (locationMatch && !activeFailure.file) {
      activeFailure.file = normalizeBetweenTicketFailureFile(locationMatch[1], workingDir);
    }
  }

  flushFailure();
  if (failures.length > 0) return failures;

  // No TAP failures parsed: the gate died before emitting any TAP output (e.g. in
  // `pretest:fast`). Never scrape the first non-empty line — it is always npm's own lifecycle
  // banner, never a real test name. Attribute the script phase instead.
  const phase = extractFailingNpmScriptPhase(lines);
  let name = phase ? `script failure: ${phase}` : SCRIPT_FAILURE_FALLBACK_NAME;
  // Defensive assertion (not just a test pin): never emit a name shaped like npm's own banner.
  if (NPM_LIFECYCLE_BANNER_RE.test(name)) name = SCRIPT_FAILURE_FALLBACK_NAME;

  return [{
    name,
    file: '',
    script_failure: true,
    message: buildScriptFailureMessage(lines),
  }];
}

export function runBetweenTicketFastTests(
  extensionDir: string,
  extensionRoot = getExtensionRoot(),
  timeoutOverrideMs?: number,
): BetweenTicketGateResult {
  const timeoutMs = timeoutOverrideMs ?? resolveWorkerTestGateTimeoutMs(extensionRoot);
  // B-OFFREPO (AC-OFFREPO-2d): resolve the package manager from the detected
  // project type rather than hardcoding `'npm'`. Shares spawn-morty's single
  // resolver (which reads the same `gate-commands.json` map) instead of growing a
  // second package-manager table here. Resolves to `npm` for this repo, so the
  // between-ticket gate keeps executing exactly what it executes today.
  const packageManager = resolvePackageManagerBin(extensionDir, 'npm');
  const result = spawnSync(packageManager, ['run', 'test:fast'], {
    cwd: extensionDir,
    encoding: 'utf-8',
    timeout: timeoutMs,
    env: scrubGateEnv(),
  });
  const timedOut =
    (result.error?.name === 'Error' && result.error.message.includes('ETIMEDOUT')) ||
    (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  if (timedOut) {
    return {
      ok: false,
      failures: [{
        name: '__timeout__',
        file: 'npm run test:fast',
      }],
      timed_out: true,
      timeout_ms: timeoutMs,
    };
  }
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return {
    ok: result.status === 0,
    failures: result.status === 0
      ? []
      : parseBetweenTicketFastGateFailures(output, path.dirname(extensionDir)),
    timed_out: false,
    timeout_ms: timeoutMs,
  };
}

/**
 * R-NOPOSTTIER (ticket 15db9049): the production default both post-final seams
 * (`runManagerTokenPostFinalMeasurement`, `applyAllTicketsDoneCompletion`) resolve to when no
 * `runTestFast` dep is injected. Named and exported (rather than left as an inline arrow) so a test
 * can assert its identity/binding directly instead of only observing it indirectly through a spawn.
 * Arity-2 adapter, NOT a bare `runBetweenTicketFastTests` reference: the seam's second parameter is
 * a timeout, the function's second parameter is `extensionRoot`. Binding them directly would hand a
 * number to a string parameter.
 */
export function defaultRunBetweenTicketFastTestsAdapter(
  extensionDir: string,
  timeoutMs?: number,
): BetweenTicketGateResult {
  return runBetweenTicketFastTests(extensionDir, getExtensionRoot(), timeoutMs);
}

/** R-NOPOSTTIER (ticket 15db9049): the single resolver both post-final seams route through. */
export function resolvePostFinalRunTestFastAdapter(
  runTestFast?: (extensionDir: string, timeoutMs?: number) => BetweenTicketGateResult,
): (extensionDir: string, timeoutMs?: number) => BetweenTicketGateResult {
  return runTestFast ?? defaultRunBetweenTicketFastTestsAdapter;
}

export function runBetweenTicketFastGate(input: RunBetweenTicketFastGateInput): BetweenTicketGateResult | null {
  const extensionDir = path.join(input.workingDir, 'extension');
  if (!fs.existsSync(extensionDir)) return null;

  const runTestFast = resolvePostFinalRunTestFastAdapter(input.runTestFast);
  const ts = (input.now ?? Date.now)();
  const result = runTestFast(extensionDir, input.timeoutMs);

  sm.update(input.statePath, state => {
    state.last_between_ticket_gate = {
      ts,
      ok: result.ok,
      failures: result.failures.map(failure => ({
        name: failure.name,
        file: failure.file,
        ...(failure.script_failure ? { script_failure: failure.script_failure } : {}),
        ...(failure.message ? { message: failure.message } : {}),
      })),
      timed_out: result.timed_out,
      timeout_ms: result.timeout_ms,
    };
  });

  if (result.timed_out) {
    writeActivityEntry(input.statePath, {
      event: 'between_ticket_gate_timeout',
      ts: new Date(ts).toISOString(),
      ticket_id: input.nextTicketId || input.completedTicketId,
      prior_ticket_id: input.completedTicketId,
      gate_payload: {
        command: 'npm run test:fast',
        timeout_ms: result.timeout_ms,
      },
    });
  }

  if (!result.ok && normalizedStatus(input.landedStatus) === 'done') {
    writeActivityEntry(input.statePath, {
      event: 'cross_ticket_regression_detected',
      ts: new Date(ts).toISOString(),
      ticket_id: input.nextTicketId || input.completedTicketId,
      prior_ticket_id: input.completedTicketId,
      failing_tests: result.failures.map(failure => ({
        name: failure.name,
        file: failure.file,
      })),
    });
    emitCrossTicketRegressionLinearComment({
      sessionDir: path.dirname(input.statePath),
      priorTicketId: input.completedTicketId,
      regressedTicketId: input.nextTicketId || input.completedTicketId,
      failingTests: result.failures.map(failure => ({
        name: failure.name,
        file: failure.file,
      })),
      log: input.log,
    });
  }

  input.log(
    `between-ticket fast gate for ${input.completedTicketId}: ${result.ok ? 'passed' : `failed (${result.failures.length} failure(s))`}`,
  );
  return result;
}

export type ClassifyPostFinalVerdictInput = {
  gate: BetweenTicketGateResult | null;
  applicable: boolean;
  verdictTs: number | null;
  finalCommitTs: number | null;
  baselineFailures: string[];
};

export type ClassifyPostFinalVerdictOutput = {
  state: PostFinalVerdictState;
  degraded: boolean;
  dimensions: string[];
};

function isMalformedGate(gate: BetweenTicketGateResult | null): boolean {
  if (gate === null) return false;
  return typeof gate !== 'object' || typeof gate.ok !== 'boolean' || !Array.isArray(gate.failures);
}

function isStaleVerdict(input: ClassifyPostFinalVerdictInput): boolean {
  return (
    input.finalCommitTs !== null &&
    input.verdictTs !== null &&
    input.verdictTs < input.finalCommitTs
  );
}

function isBaselineOnlyFailureSet(failureNames: string[], baselineFailures: string[]): boolean {
  const baselineSet = new Set(baselineFailures);
  return failureNames.length > 0 && failureNames.every(name => baselineSet.has(name));
}

/**
 * R-NOPOSTTIER: pure classification of the fast-tier gate verdict AFTER the bundle's final
 * commit. Total function — never throws; unknown/garbage input classifies 'absent', never
 * 'green'. Wired by `runPostFinalMeasurement` below, at both promise-synthesis seams.
 */
export function classifyPostFinalVerdict(
  input: ClassifyPostFinalVerdictInput,
): ClassifyPostFinalVerdictOutput {
  const finalize = (
    state: PostFinalVerdictState,
    dimensions: string[],
  ): ClassifyPostFinalVerdictOutput => ({
    state,
    degraded: state === 'red' || state === 'inconclusive' || state === 'absent',
    dimensions,
  });

  if (!input.applicable) return finalize('not_applicable', []);

  const gate = input.gate;
  if (isMalformedGate(gate)) return finalize('absent', []);
  if (gate !== null && gate.timed_out === true) return finalize('inconclusive', []);
  if (gate === null) return finalize('absent', []);
  if (isStaleVerdict(input)) return finalize('absent', []);
  if (input.verdictTs === null) return finalize('absent', []);

  // The GATE RESULT is read before anything derived from `finalCommitTs`. That timestamp is a
  // staleness-check input only (`isStaleVerdict` above) and it must never decide the tier verdict:
  // `gitCommitEpoch`/`readHeadCommit` collapse EVERY git-probe failure to null — unreadable HEAD,
  // `git show` timeout, a non-repo working dir — so a `finalCommitTs === null` arm placed here
  // would classify a genuinely RED tier as 'green' whenever the probe failed. A red gate stays red
  // no matter how little we know about the commit it followed.
  if (gate.ok) return finalize('green', []);

  const failureNames = gate.failures.map(f => f.name);
  if (isBaselineOnlyFailureSet(failureNames, input.baselineFailures)) return finalize('green', []);

  return finalize('red', failureNames);
}

/**
 * R-NOPOSTTIER: the post-final fast tier measured 835042 ms in this repo, well above
 * `DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS` (600_000, `services/pickle-utils.ts`). Inheriting that
 * default would time the measurement out on every pickle-rick bundle and make `inconclusive` the
 * steady state. This is a CALL-SITE argument, not a settings key — no new operator surface.
 */
export const POST_FINAL_FAST_GATE_TIMEOUT_MS = 1_800_000;

export type RunPostFinalMeasurementInput = {
  statePath: string;
  workingDir: string;
  completedTicketId: string;
  log: (msg: string) => void;
  now?: () => number;
  runTestFast?: (extensionDir: string, timeoutMs?: number) => BetweenTicketGateResult;
  /** Test seam. When omitted the committer time of the working dir's HEAD is used. */
  finalCommitTs?: number | null;
};

/**
 * R-NOPOSTTIER: measures the fast tier AFTER the bundle's final commit and BEFORE the completion
 * promise is synthesized, classifies it with `classifyPostFinalVerdict`, and records the result on
 * `state.post_final_verdict`.
 *
 * Total function — it never throws. A measurement that explodes (or a state file that will not
 * take the write) is caught and classified `absent`/degraded, never `green`. It measures and
 * reports only: no ticket is demoted, no work discarded, `exit_reason` is untouched. Acting on the
 * verdict belongs to ticket `fa3d0f5a`.
 */
function persistAndLogPostFinalVerdict(
  input: Pick<RunPostFinalMeasurementInput, 'statePath' | 'log'>,
  verdict: ClassifyPostFinalVerdictOutput,
  suffix: string,
): ClassifyPostFinalVerdictOutput {
  try {
    sm.update(input.statePath, state => {
      state.post_final_verdict = {
        state: verdict.state,
        degraded: verdict.degraded,
        dimensions: verdict.dimensions,
      };
    });
  } catch (err) {
    input.log(`post-final verdict not persisted (ignored): ${safeErrorMessage(err)}`);
  }

  const dimensionSuffix = verdict.dimensions.length > 0 ? ` — ${verdict.dimensions.join(', ')}` : '';
  input.log(
    `post-final tier measurement: ${verdict.state}${verdict.degraded ? ' (degraded)' : ''}${dimensionSuffix}${suffix}`,
  );
  return verdict;
}

export function runPostFinalMeasurement(
  input: RunPostFinalMeasurementInput,
): ClassifyPostFinalVerdictOutput {
  // R-NOPOSTTIER (AC-2): under PICKLE_TEST_MODE with NO injected `runTestFast`, this seam MUST
  // NOT spawn a real fast-tier measurement — `extension/tests/mux-runner.test.js` spawns the
  // compiled binary as a subprocess and builds its own deps in-process, so a tier run nested
  // inside a running tier never returns. Gating on `!input.runTestFast` (rather than a bare
  // `PICKLE_TEST_MODE` check) keeps `extension/tests/post-final-measurement.test.js` — which sets
  // `PICKLE_TEST_MODE=1` for an unrelated reason (bypassing `guardCompletionCommitBeforeDone`) but
  // injects its own stub `runTestFast` to drive this exact function in-process — reaching its
  // injected stub instead of being silently short-circuited. Both promise-synthesis callers
  // (`runManagerTokenPostFinalMeasurement`, `applyAllTicketsDoneCompletion`) route through this
  // one function, so the short-circuit here covers both seams. `gate: null` with
  // `applicable: true` classifies 'absent' (the classifier's "could not look" claim) — never
  // `not_applicable` (a positive "no tier owed" claim this is not) and never `green`.
  if (process.env.PICKLE_TEST_MODE === '1' && !input.runTestFast) {
    const verdict = classifyPostFinalVerdict({
      gate: null,
      applicable: true,
      verdictTs: (input.now ?? Date.now)(),
      finalCommitTs: null,
      baselineFailures: [],
    });
    return persistAndLogPostFinalVerdict(input, verdict, ' — test-mode short-circuit, no tier spawned');
  }

  // Two facts, not one, because `not_applicable` and `absent` are not the same claim.
  // `not_applicable` is POSITIVE — we looked at the working dir and it ships no `extension/` tier,
  // so no verdict is owed and the off-repo bundle stays green (the repo-agnostic invariant).
  // `absent` is the UNKNOWN — we could not look. `pipeline-runner.ts:readDegradedPostFinalVerdict`
  // keys only on `degraded`, so the non-degraded state is reported as success; anything we failed
  // to establish must therefore land on `absent`, never borrow the positive fact's exit.
  // `workingDirKnown` carries no initializer: the try and the catch both assign it, so one would
  // be dead (`no-useless-assignment`).
  let workingDirKnown: boolean;
  let applicable = false;
  let gate: BetweenTicketGateResult | null = null;
  let verdictTs: number | null = null;
  let finalCommitTs: number | null = null;

  // ONE try over the WHOLE measurement, not just the gate call. The applicability probe, the clock
  // read and the git probe used to sit above a narrower try, so a throw in any of them escaped this
  // function and left `state.post_final_verdict` unwritten — which the consumer reads as null, i.e.
  // non-degraded, i.e. success. An unwritten verdict is the same fake-green as a green one.
  try {
    workingDirKnown = input.workingDir.trim() !== '';
    applicable = workingDirKnown
      && fs.existsSync(path.join(input.workingDir, 'extension'));

    if (applicable) {
      // Stamped once and injected into the gate so `last_between_ticket_gate.ts` and the
      // classifier's `verdictTs` are the same number — `post_final_verdict` carries no `ts` of its
      // own, so the gate's stamp IS the verdict's timestamp.
      const ts = (input.now ?? Date.now)();
      verdictTs = ts;
      if (input.finalCommitTs !== undefined) {
        finalCommitTs = input.finalCommitTs;
      } else {
        const epochSeconds = gitCommitEpoch(input.workingDir, readHeadCommit(input.workingDir));
        finalCommitTs = epochSeconds === null ? null : epochSeconds * 1000;
      }
      gate = runBetweenTicketFastGate({
        statePath: input.statePath,
        workingDir: input.workingDir,
        completedTicketId: input.completedTicketId,
        nextTicketId: null,
        landedStatus: 'done',
        log: input.log,
        now: () => ts,
        timeoutMs: POST_FINAL_FAST_GATE_TIMEOUT_MS,
        runTestFast: input.runTestFast,
      });
    }
  } catch (err) {
    gate = null;
    // Clearing this makes "any throw lands on `absent`" structural rather than a property of WHICH
    // statement threw: a throw between the two assignments below would otherwise leave the pair
    // `true`/`false`, which the classifier arm reads as `not_applicable` — the non-degraded state.
    workingDirKnown = false;
    input.log(`post-final tier measurement threw (classified absent): ${safeErrorMessage(err)}`);
  }

  const verdict = classifyPostFinalVerdict({
    gate,
    // An unknown working dir CLAIMS applicability so it skips the `not_applicable` arm. The
    // `if (applicable)` block did not run, so `gate` is null and the classifier's existing
    // `gate === null` arm answers `absent`/degraded — no new arm, state, or interface field.
    applicable: applicable || !workingDirKnown,
    verdictTs,
    finalCommitTs,
    // No baseline failure set exists in state, so nothing can launder a real failure into green.
    baselineFailures: [],
  });

  return persistAndLogPostFinalVerdict(input, verdict, '');
}

/**
 * R-NOPOSTTIER (AC-13): the manager-token completion seam's call into `runPostFinalMeasurement`.
 * The model itself emitted EPIC_COMPLETED/TASK_COMPLETED and `evaluateEpicCompletion` verified it
 * genuine — a second promise-synthesis path distinct from the proactive all-tickets-done scan in
 * `applyAllTicketsDoneCompletion`, which owes the same verdict for the same reason. Extracted to
 * its own exported function (rather than left inline in `runMuxRunnerMain`) so a test can drive
 * this exact seam directly — the ticket 6f0e349f wiring-proof requirement — without needing to run
 * the whole manager loop. `runPostFinalMeasurement` is itself total (never throws); the wrap here
 * is belt-and-braces for the same reason `applyAllTicketsDoneCompletion` wraps its own call.
 */
export function runManagerTokenPostFinalMeasurement(
  statePath: string,
  workingDir: string,
  completedTicketId: string,
  log: (msg: string) => void,
  deps: Pick<RunPostFinalMeasurementInput, 'now' | 'runTestFast' | 'finalCommitTs'> = {},
): void {
  try {
    runPostFinalMeasurement({
      statePath,
      workingDir,
      completedTicketId,
      log,
      now: deps.now,
      runTestFast: deps.runTestFast,
      finalCommitTs: deps.finalCommitTs,
    });
  } catch (err) {
    log(`post-final tier measurement failed at the completion seam (ignored): ${safeErrorMessage(err)}`);
  }
}

function formatWorkerGateFailureLine(failure: { name?: string; file?: string; message?: string }): string {
  const label = failure.file || failure.name || 'unknown';
  const message = failure.message || failure.name || 'unknown failure';
  return `  - ${label}: ${message}`;
}

export function buildWorkerGateFailureSummary(state: Partial<State>): string {
  const events = (Array.isArray(state.activity) ? state.activity : [])
    .filter((entry): entry is WorkerGateFailureSummaryEvent => entry?.event === 'worker_gate_failed')
    .slice(-3);
  if (events.length === 0) return '';

  const lines = ['=== RECENT WORKER GATE FAILURES ==='];
  for (const entry of events) {
    lines.push(
      `worker_gate_failed ticket_id=${entry.ticket_id || 'unknown'} gate_phase=${entry.gate_phase || 'unknown'} retry_count=${Number.isInteger(entry.retry_count) ? entry.retry_count : 0}`,
    );
    const failures = Array.isArray(entry.failures) ? entry.failures.slice(0, 3) : [];
    if (failures.length === 0) {
      lines.push('  - unknown: no structured failures recorded');
      continue;
    }
    for (const failure of failures) {
      lines.push(formatWorkerGateFailureLine(failure));
    }
  }
  return lines.join('\n');
}

function buildIterationHandoffSummary(state: Partial<State>, sessionDir: string, iterationNum?: number): string {
  const handoffSummary = buildHandoffSummary(state, sessionDir, iterationNum);
  const workerGateFailureSummary = buildWorkerGateFailureSummary(state);
  return workerGateFailureSummary ? `${handoffSummary}\n\n${workerGateFailureSummary}` : handoffSummary;
}

/**
 * Truncate TASK_NOTES.md content with section-aware priority.
 * Preserves ## Next and ## Dead Ends fully, trims ## Progress from oldest.
 * Sections without recognized headers are treated as Progress.
 */
export function truncateTaskNotes(content: string, maxChars: number = TASK_NOTES_MAX_CHARS): string {
  if (!content || !content.trim()) return '';
  if (content.length <= maxChars) return content;

  const { preamble, sections } = parseTaskNoteSections(content);

  // No recognized sections — treat entire content as trimmable from top
  if (sections.length === 0) {
    const marker = `${TASK_NOTE_TRUNC_MARKER}\n`;
    return marker + content.slice(content.length - (maxChars - marker.length));
  }

  // Phase 1: Drop Progress/unrecognized sections; add back the tail of the
  // most recent Progress section if any budget remains.
  const withoutProgress = sections.filter(s => priorityFor(s.name) < 3);
  let result = preamble + withoutProgress.map(s => s.body).join('');
  if (result.length <= maxChars) {
    const progress = sections.filter(s => priorityFor(s.name) === 3);
    const remaining = maxChars - result.length;
    if (remaining > 20 && progress.length > 0) {
      const tail = progress[progress.length - 1].body;
      result += `\n${TASK_NOTE_TRUNC_MARKER}\n` + tail.slice(tail.length - remaining);
    }
    return result.length <= maxChars ? result : result.slice(0, maxChars);
  }

  // Phase 2: Drop Key Discoveries too.
  const highPriority = sections.filter(s => priorityFor(s.name) <= 1);
  result = preamble + highPriority.map(s => s.body).join('');
  if (result.length <= maxChars) return `${result}\n${TASK_NOTE_TRUNC_MARKER}`;

  // Phase 3: Hard truncate from end.
  return result.slice(0, maxChars - (TASK_NOTE_TRUNC_MARKER.length + 2)) + `\n${TASK_NOTE_TRUNC_MARKER}`;
}

/**
 * R-MRFP: resolves a directory to its enclosing git repository root. Falls
 * back to the absolute directory path when it is not inside a git repo (or
 * does not exist), so forward-created dirs still get a stable identity.
 */
function resolveRepoRoot(dir: string, stableBase: string): string {
  const absDir = path.isAbsolute(dir) ? dir : path.resolve(stableBase, dir);
  try {
    const out = execFileSync('git', ['-C', absDir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return out;
  } catch { /* not a git repo / missing dir — fall back to the path itself */ }
  return absDir;
}

/**
 * Count persisted `codegraph_context_injected` / `codegraph_context_skipped`
 * events from a session's `state.activity` log.
 *
 * These events are produced by `buildCodegraphContextSection` in the per-spawn
 * spawn-morty PROCESS, so mux-runner's own in-memory `CodegraphService` counters
 * never observe them — reading `getSessionCounters().injected/.skipped` here would
 * always report 0 (b1089e97 cross-process aggregation gap). Both processes append
 * to the same `state.json`, so the persisted events are the ground truth for the
 * `codegraph_session_summary` aggregate.
 */
export function countCodegraphContextEvents(
  activity: readonly ActivityLogEntry[] | undefined,
): { injected: number; skipped: number } {
  let injected = 0;
  let skipped = 0;
  for (const entry of activity ?? []) {
    if (entry?.event === 'codegraph_context_injected') injected += 1;
    else if (entry?.event === 'codegraph_context_skipped') skipped += 1;
  }
  return { injected, skipped };
}

/**
 * Count persisted `codegraph_degraded` events from a session's `state.activity` log,
 * excluding the terminal `latch` emission.
 *
 * Same cross-process rationale as `countCodegraphContextEvents`: every codegraph query
 * (`searchNodes`/`getCallers`) and the `buildContext` summary run in the per-spawn
 * spawn-morty PROCESS behind the A1 subprocess boundary, so their `degradeOpen` degrades
 * increment the spawn-morty service's counter — mux-runner's in-memory
 * `getSessionCounters().degraded` never observes them and only ever sees its own `sync()`
 * degrades. Both processes append `codegraph_degraded` to the shared `state.json`, so the
 * persisted events are the ground truth for the `codegraph_session_summary.degraded_ops`
 * aggregate. `latch` emissions are excluded because `CodegraphService.latch()` bumps
 * `counters.latched` (surfaced separately via `index_status: 'latched'`) and never bumps
 * `counters.degraded`; excluding op=`latch` here preserves that exact prior semantic.
 */
export function countCodegraphDegradedEvents(
  activity: readonly ActivityLogEntry[] | undefined,
): number {
  let degraded = 0;
  for (const entry of activity ?? []) {
    if (entry?.event !== 'codegraph_degraded') { continue; }
    const op = (entry.gate_payload as { operation?: unknown } | undefined)?.operation;
    if (op === 'latch') { continue; }
    degraded += 1;
  }
  return degraded;
}

/**
 * Detects whether tickets in a session span multiple repositories.
 * Returns an array of distinct repo roots if 2+, null otherwise.
 * Tickets with working_dir: null are excluded (they use session default).
 *
 * R-MRFP: dedupe by the enclosing git repo root, not the raw working_dir
 * string. A monorepo with per-workspace working_dirs (`packages/api`,
 * `packages/app`, repo root) is ONE repo — flagging it as multi-repo is a
 * false positive that spams the iteration-1 log on every relaunch.
 */
export function detectMultiRepo(sessionDir: string, stableBase: string): string[] | null {
  const tickets = collectTickets(sessionDir);
  const dirs = new Set(
    tickets
      .map(t => t.working_dir)
      .filter((d): d is string => d !== null && d !== undefined)
  );
  const roots = new Set([...dirs].map(d => resolveRepoRoot(d, stableBase)));
  return roots.size >= 2 ? [...roots] : null;
}

type MuxLifecycleStep = Extract<Step, 'research' | 'plan' | 'implement' | 'review'>;

const MUX_LIFECYCLE_ORDER: Record<MuxLifecycleStep, number> = {
  research: 0,
  plan: 1,
  implement: 2,
  review: 3,
};

function normalizeTicketStatus(status: string | null): string {
  return (status || '').toLowerCase().replace(/["']/g, '').trim();
}

function chooseInProgressWinner(inProgress: readonly { id: string | null }[], currentTicket: string | null): string | null {
  if (currentTicket && inProgress.some(ticket => ticket.id === currentTicket)) return currentTicket;
  return inProgress.find(ticket => !!ticket.id)?.id ?? currentTicket;
}

export interface TicketDesyncResolution {
  winner: string | null;
  action: 'sync' | 'noop';
}

function collectFrontmatterInProgress(frontmatterStatuses: Map<string, TicketStatus>): { id: string }[] {
  const inProgress: { id: string }[] = [];
  for (const [ticketId, status] of frontmatterStatuses.entries()) {
    if (normalizedStatus(status) === 'in progress') {
      inProgress.push({ id: ticketId });
    }
  }
  return inProgress;
}

function hasManagerHandoffSnapshot(sessionDir: string, currentTicket: string | null): boolean {
  if (!currentTicket) return false;
  if (typeof sessionDir !== 'string' || !sessionDir) return false;
  return readLatestTicketConformanceSnapshot(path.join(sessionDir, currentTicket)).hasManagerHandoff;
}

function frontmatterStatusForCurrentTicket(state: State, frontmatterStatuses: Map<string, TicketStatus>): string {
  const currentTicket = typeof state.current_ticket === 'string' ? state.current_ticket : null;
  if (!currentTicket) return '';
  return normalizedStatus(frontmatterStatuses.get(currentTicket) ?? '');
}

function alreadyInSync(state: State, inProgress: readonly { id: string }[]): boolean {
  if (inProgress.length !== 1) return false;
  const currentTicket = typeof state.current_ticket === 'string' && state.current_ticket.length > 0
    ? state.current_ticket
    : null;
  return !!currentTicket && inProgress.some(ticket => ticket.id === currentTicket);
}

function shouldSkipDesyncSync(state: State, sessionDir: string, inProgress: readonly { id: string }[], frontmatterStatuses: Map<string, TicketStatus>): boolean {
  if (inProgress.length !== 0) return false;
  const currentStatus = frontmatterStatusForCurrentTicket(state, frontmatterStatuses);
  if (currentStatus !== 'failed' && currentStatus !== 'done') return false;
  if (currentStatus === 'failed') return true;
  return hasManagerHandoffSnapshot(sessionDir, typeof state.current_ticket === 'string' ? state.current_ticket : null);
}

export function resolveTicketDesyncWinner(state: State, frontmatterStatuses: Map<string, TicketStatus>, sessionDir = ''): TicketDesyncResolution {
  const currentTicket = typeof state.current_ticket === 'string' && state.current_ticket.length > 0
    ? state.current_ticket
    : null;
  const inProgress = collectFrontmatterInProgress(frontmatterStatuses);
  const winner = chooseInProgressWinner(inProgress, currentTicket);
  if (frontmatterStatuses.size === 0) {
    return { winner: null, action: 'noop' };
  }
  if (alreadyInSync(state, inProgress)) {
    return { winner, action: 'noop' };
  }
  // Prefer the explicit sessionDir argument when callers pass it; fall back to
  // state.session_dir for legacy callers (tests built around the typed signature).
  const effectiveSessionDir = sessionDir || (typeof state.session_dir === 'string' ? state.session_dir : '');
  if (shouldSkipDesyncSync(state, effectiveSessionDir, inProgress, frontmatterStatuses)) {
    return { winner, action: 'noop' };
  }
  return { winner, action: 'sync' };
}

function reconcileInProgressSet(
  tickets: readonly { id: string | null }[],
  frontmatterStatuses: Map<string, TicketStatus>,
): { id: string; status: string }[] {
  const inProgress: { id: string; status: string }[] = [];
  for (const ticket of tickets) {
    if (!ticket.id) continue;
    const status = normalizedStatus(frontmatterStatuses.get(ticket.id) ?? '');
    if (status === 'in progress') {
      inProgress.push({ id: ticket.id, status });
    }
  }

  return inProgress;
}

function applyTicketDesyncWrites(sessionDir: string, winner: string, inProgress: readonly { id: string }[]) {
  if (!inProgress.some((ticket) => ticket.id === winner)) {
    writeTicketStatus(sessionDir, winner, 'In Progress');
  }
  for (const ticket of inProgress) {
    if (ticket.id === winner) continue;
    writeTicketStatus(sessionDir, ticket.id, 'Todo');
  }
}

function reconcileTicketStateDesync(
  statePath: string,
  sessionDir: string,
  currentTicket: string | null,
  iteration: number | undefined,
  log: (msg: string) => void,
): State {
  const tickets = collectTickets(sessionDir);
  if (tickets.length === 0) {
    log('WARN: ticket_state_desync check found no ticket directories');
    return readRunnerState(statePath);
  }
  const state = readRunnerState(statePath);
  const frontmatterStatuses = new Map<string, TicketStatus>();
  for (const ticket of tickets) {
    if (!ticket.id) continue;
    try {
      frontmatterStatuses.set(ticket.id, getTicketStatus(sessionDir, ticket.id));
    } catch {
      frontmatterStatuses.set(ticket.id, '');
    }
  }
  const resolution = resolveTicketDesyncWinner(state, frontmatterStatuses, sessionDir);
  if (resolution.action === 'noop') return state;

  const winner = resolution.winner;
  if (!winner) return readRunnerState(statePath);
  const inProgress = reconcileInProgressSet(tickets, frontmatterStatuses);

  logActivity({
    event: 'ticket_state_desync_detected',
    source: 'pickle',
    session: path.basename(sessionDir),
    iteration,
    ticket: winner ?? currentTicket ?? undefined,
    reason: `current_ticket=${currentTicket ?? 'none'} in_progress=${inProgress.map(t => t.id || '?').join(',') || 'none'}`,
  });
  applyTicketDesyncWrites(sessionDir, winner, inProgress);

  if (winner && winner !== currentTicket) {
    return updateMuxLifecycleState(statePath, {
      currentTicket: winner,
      step: inferTicketLifecycleStep(sessionDir, winner, state.step),
    });
  }
  return readRunnerState(statePath);
}

function isPendingMuxTicket(sessionDir: string, ticket: TicketInfo): boolean {
  if (!ticket.id) return false;
  let status: string;
  try {
    status = normalizeTicketStatus(getTicketStatus(sessionDir, ticket.id));
  } catch {
    return false;
  }
  return !!ticket.id && status !== 'done' && status !== 'skipped';
}

/**
 * AC-R-WMNP-3: true iff the ticket's frontmatter is a TERMINAL no-progress flip
 * (status Failed + a no-progress `failed_reason`). Such a ticket is NOT selectable
 * for work — it must neither be respawned in-phase forever nor re-engaged via a stale
 * `state.current_ticket` after a relaunch. It stays Failed and visible; the operator
 * re-queues by setting `status: Todo`. Scoped to the no-progress reason set so a
 * generic Failed ticket retains its retry semantics — this is selection-layer
 * filtering, NOT a change to the canonical `isPendingMuxTicket` pendingness contract
 * (R-RMBS-1).
 *
 * WS-2d (R-PFNT): the no-progress reason was split out of the single misleading
 * `oversized_no_progress` literal into the finer `scope_unresolvable` /
 * `no_progress_timeout` (see `NO_PROGRESS_FAILURE_REASONS`). All three are treated
 * EQUIVALENTLY here so the split introduces no selection / retry-exemption regression.
 */
function isOversizedNoProgressFailed(sessionDir: string, ticketId: string | null | undefined): boolean {
  if (!ticketId) return false;
  try {
    const raw = fs.readFileSync(ticketFilePath(sessionDir, ticketId), 'utf-8');
    if (normalizeTicketStatus(readFrontmatterField(raw, 'status')) !== 'failed') return false;
    const reason = (readFrontmatterField(raw, 'failed_reason') ?? '').trim();
    return (NO_PROGRESS_FAILURE_REASONS as readonly string[]).includes(reason);
  } catch (err) {
    // M4: a missing/unreadable/corrupt ticket file is no longer silently
    // swallowed. We still return false (conservative — an unreadable ticket is
    // NOT treated as a terminal no-progress flip, so selection behavior is
    // unchanged), but surface the read failure so corrupt/missing tickets are
    // observable instead of vanishing into a blanket catch.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[warn] [${new Date().toISOString()}] ⚠ isOversizedNoProgressFailed: could not read ticket ${ticketId} — ${msg}\n`,
    );
    return false;
  }
}

/**
 * WS-2d (R-PFNT): pick the finer no-progress `failed_reason` for a wmw-auto-skip /
 * ladder-exhaustion flip, replacing the single misleading `oversized_no_progress`
 * literal. Branches on the available in-runtime signal:
 *
 *  - `scope_unresolvable` when a scope.json exists but resolves to an EMPTY
 *    allowed-paths fence (the ticket has no resolvable region to edit, so the stall
 *    is a scope-fence ambiguity, NOT genuine oversize). This is the case that most
 *    often masks an out-of-fence compile-RED behind the legacy label.
 *  - `no_progress_timeout` otherwise — genuine no-progress within the spawn/poll
 *    budget (the honest default; preserves prior semantics for unscoped sessions and
 *    well-fenced tickets that simply ran out of progress).
 *
 * Conservative + best-effort: any read error falls back to `no_progress_timeout`
 * (the honest no-progress default) so a transient FS hiccup never mislabels a flip.
 * Both reasons are members of `NO_PROGRESS_FAILURE_REASONS`, so selection / retry
 * semantics are identical to the old single literal (no regression).
 */
export function classifyNoProgressFailureReason(sessionDir: string): TicketFailureReason {
  try {
    const scopePath = path.join(sessionDir, 'scope.json');
    if (fs.existsSync(scopePath)) {
      const allowed = readScopeAllowedPaths(sessionDir);
      // scope.json present but unresolvable/empty fence → scope-fence ambiguity.
      if (allowed !== null && allowed.length === 0) return 'scope_unresolvable';
    }
  } catch { /* fall through to the honest no-progress default */ }
  return 'no_progress_timeout';
}

function findNextPendingTicketId(sessionDir: string): string | null {
  // 7eb9fa20: a ticket with an active failed-flip suppression hold is
  // non-runnable — never auto-reselected with stale evidence. Selection-layer
  // filtering only (same pattern as isOversizedNoProgressFailed).
  const held = readActiveFailedFlipHolds(sessionDir);
  return collectTickets(sessionDir).find(ticket =>
    isPendingMuxTicket(sessionDir, ticket)
    && !isOversizedNoProgressFailed(sessionDir, ticket.id)
    && !(ticket.id && held.has(ticket.id)),
  )?.id ?? null;
}

/**
 * AC-R-WMNP-3: resolve the ticket to work this iteration. Preserves the legacy
 * `state.current_ticket || findNextPendingTicketId(...)` behavior — a SET
 * current_ticket is honored (including a Done closer ticket, whose manager-handoff
 * work is still detected downstream) — with ONE new exclusion: a terminal
 * no-progress Failed flip (oversized_no_progress) is never re-engaged, breaking
 * the order-deadlock where the manager re-spawned the flipped ticket forever.
 * When current_ticket is the flipped ticket (or null), fall through to the next
 * selectable pending ticket.
 *
 * B-PXBO WS-3-FacetB: a crash-resume relaunch can inherit a `state.current_ticket`
 * that is ALREADY Done with a durable git commit (the large-tier worker committed
 * green, then the process died before the ticket pointer advanced). Re-selecting it
 * here lets the inherited spent budget reach the per-ticket cap-check and flip
 * Done->Failed (AC-CRSR-3 violation). When `workingDir` is supplied AND the current
 * ticket is terminal (Done/Skipped) AND its completion is oracle-committed, re-route
 * through the EXISTING `findNextPendingTicketId` selection (subtract, don't add a new
 * Done-detection guard layer). A Done closer ticket WITHOUT committed evidence
 * (manager-handoff residual) is still honored, preserving that downstream path.
 */
export function resolvePreTicket(
  sessionDir: string,
  currentTicket: string | null | undefined,
  workingDir?: string | null,
): string | null {
  if (
    currentTicket
    && !isOversizedNoProgressFailed(sessionDir, currentTicket)
    // 7eb9fa20: a held (failed-flip-suppressed) current_ticket is never
    // re-engaged — fall through to the next selectable pending ticket.
    && !readActiveFailedFlipHolds(sessionDir).has(currentTicket)
    // B-PXBO WS-3-FacetB: skip an already-Done ticket whose completion is durably
    // committed (oracle-committed). AC-CRSR-3: such a ticket must NEVER be re-routed
    // back through the cap-check that could flip Done->Failed/Todo.
    && !isResumedDoneWithDurableCommit(sessionDir, currentTicket, workingDir)
  ) {
    return currentTicket;
  }
  return findNextPendingTicketId(sessionDir);
}

/**
 * B-PXBO WS-3-FacetB: true when `ticketId` is terminal (Done/Skipped) AND its
 * completion evidence is oracle-committed. Reuses `getTicketStatus` +
 * `isTerminalTicketStatus` for the status read and the shared
 * `isTicketOracleCommitted` helper for the committed-evidence check. A workingDir
 * is required for the git probe; absent → conservative false (preserve the legacy
 * honored-current_ticket path). Best-effort: any read error reads as not-skippable.
 */
function isResumedDoneWithDurableCommit(
  sessionDir: string,
  ticketId: string,
  workingDir?: string | null,
): boolean {
  if (!workingDir) return false;
  try {
    if (!isTerminalTicketStatus(getTicketStatus(sessionDir, ticketId))) return false;
    return isTicketOracleCommitted({ sessionDir, ticketId, workingDir });
  } catch {
    return false;
  }
}

/**
 * R-AISLOW: Find the topologically-first pending (non-terminal) ticket.
 * Reuses collectTickets (already topo-sorted via topoSortTickets) +
 * getTicketStatus + isTerminalTicketStatus. Returns null when all tickets
 * are terminal or the session has no tickets.
 *
 * Used at iteration_start to detect when state.current_ticket is already
 * Done/Skipped, enabling the preskip path that avoids a wasted manager spawn.
 */
export function findFirstPendingTicket(sessionDir: string): TicketInfo | null {
  const tickets = collectTickets(sessionDir); // already topo-sorted by dependency/order
  for (const ticket of tickets) {
    if (!ticket.id) continue;
    try {
      if (!isTerminalTicketStatus(getTicketStatus(sessionDir, ticket.id))) {
        return ticket;
      }
    } catch {
      continue; // unreadable ticket — treat as not-pending
    }
  }
  return null;
}

/**
 * L5: true when the session HAS tickets but NONE are SELECTABLE for work — i.e.
 * `findNextPendingTicketId` (the same selection predicate `resolvePreTicket` uses:
 * `isPendingMuxTicket && !isOversizedNoProgressFailed`) finds nothing. This is the
 * all-terminal case the model can reach when every pending ticket flipped
 * `oversized_no_progress` Failed. Distinct from `applyAllTicketsDoneCompletion`
 * (which fires only when ALL are Done): this catches the all-terminal-Failed case
 * where the loop would otherwise enter `runIteration` with a null ticket. Returns
 * false for an empty session (no tickets) so a not-yet-populated session is never
 * misclassified as terminal.
 */
export function noRunnableTicketsRemain(sessionDir: string): boolean {
  const tickets = collectTickets(sessionDir);
  if (tickets.length === 0) return false;
  return findNextPendingTicketId(sessionDir) === null;
}

function withFreshTicketStatuses(sessionDir: string, tickets: readonly TicketInfo[]): TicketInfo[] {
  return tickets.map(ticket => {
    if (!ticket.id) return { ...ticket };
    try {
      return { ...ticket, status: getTicketStatus(sessionDir, ticket.id) };
    } catch {
      return { ...ticket, status: null };
    }
  });
}

export interface CorrectPhantomDoneTicketsInput {
  sessionDir: string;
  workingDir: string;
  startCommit: string | null;
  iteration: number;
  /** Persisted state flags (R-PDWR). */
  flags?: Record<string, unknown> | null;
  log?: (msg: string) => void;
}


/**
 * R-CCR-1: probe whether `sha` is an ancestor of HEAD in `dir`. Distinguishes a
 * clean not-an-ancestor result (exit 1) from git being unable to run at all
 * (exit 128 / ENOENT) — only the latter justifies a fallback-dir retry.
 */
/**
 * Classify a thrown `git merge-base --is-ancestor` error. A clean exit 1 is a
 * definitive "not an ancestor". Exit 128, ENOENT, and timeouts (the child was
 * SIGTERM-killed before it could answer) all mean git produced no answer —
 * return 'git-could-not-run' so the R-CCR-1 fallback-dir retry fires. A timeout
 * misclassified as 'not-reachable' dead-ends the fallback and reverts a
 * genuinely-Done ticket to Todo.
 */
export function classifyGitProbeError(err: unknown): 'not-reachable' | 'git-could-not-run' {
  const e = err as { status?: number | null; code?: string; signal?: string | null };
  if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM') return 'git-could-not-run';
  return e.status === 128 || e.code === 'ENOENT' ? 'git-could-not-run' : 'not-reachable';
}

/**
 * R-CCR-1: emit the phantom-Done "kept" log lines, including the fallback-probe
 * note. Extracted from `correctPhantomDoneTickets` to keep that loop under the
 * eslint complexity ceiling.
 */
function logPhantomDoneKept(
  input: CorrectPhantomDoneTicketsInput,
  ticketId: string,
  workingDir: string,
  fallbackFired: boolean,
): void {
  if (fallbackFired) {
    input.log?.(`Phantom-Done watcher: per-ticket working_dir '${workingDir}' unusable for git; retried in session dir '${input.workingDir}'. Ticket ${ticketId} kept Done.`);
  }
  input.log?.(`Phantom-Done watcher kept ticket ${ticketId} Done — valid completion_commit evidence`);
}

/**
 * D1 (84c209ae) promote-once: promote a git-verified inferred SHA to the EXPLICIT
 * `completion_commit` field AND delete `completion_commit_inferred` in one pass.
 *
 * Idempotency-by-state: once `completion_commit` is explicit, `readEvidence`
 * returns `explicit` → `gateForPhantomDoneRevert` returns `keep`, so the next
 * phantom-Done re-scan is a no-op (no growing `phantom_done_backfilled` count).
 * This is the inverse of the git-utils.ts Failed-flip idiom that clears
 * `completion_commit_inferred` on `completion_commit: null` — here we clear it on
 * EXPLICIT promotion. Returns null when the frontmatter cannot be parsed.
 */
function promoteInferredToExplicit(content: string, sha: string): string | null {
  const withExplicit = upsertFrontmatterField(content, 'completion_commit', sha);
  if (!withExplicit) return null;
  // Mirror git-utils.ts setFrontmatterField(..., null): delete the inferred line.
  return withExplicit.replace(/^completion_commit_inferred:.*$(\r?\n)?/m, '');
}

/**
 * R-AFCC-DEEP-3B/3C: classify a Done ticket for the batch phantom-Done loop and
 * apply side-effects (promote a scan/inferred SHA to the explicit field).
 * Extracted to keep the loop under the ESLint complexity ceiling.
 *
 * Decision matrix (B-DURA T70 two-state):
 *   committed + explicit field present → keep Done           → 'explicit-reachable'
 *   committed + SHA from scan/inferred → promote + keep Done → 'inferred'
 *   absent                             → revert (no evidence) → 'absent'
 *
 * R-RIC-EXPLICIT-4: the keep decision short-circuits to keep; only a `committed`
 * SHA that is not yet the explicit frontmatter field is promoted once. R-CCR-1
 * fallback-dir is passed into the oracle via fallbackDir.
 */
function batchLoopPhantomDoneKind(
  input: CorrectPhantomDoneTicketsInput,
  ticketId: string,
  workingDir: string,
): PhantomDoneKind {
  // R-AFCC-DEEP-4A: migrated from hasCompletionCommit to gateForPhantomDoneRevert.
  // B-1SEAM WS-1: ctx built by buildCompletionCtx (resolveSessionBaselineShas
  // baseline SHAs per B-DURA T30/AC-DURA-6, plus the announcement reader) so
  // the watcher evaluates the SAME predicate policy as the flip-gate — no
  // accept-here-fatal-there split (R-CXOR-2 parity, R-AICF).
  const ctx = buildCompletionCtx(
    { sessionDir: input.sessionDir, ticketId, workingDir, fallbackDir: input.workingDir },
    'phantom-watch',
  );
  const decision: RevertDecision = gateForPhantomDoneRevert(ctx, { flags: input.flags });

  if (decision.action === 'keep') {
    // D1 (84c209ae) promote-once: when the committed SHA came from the inferred
    // field or git-log scan (no explicit completion_commit yet), write EXPLICIT
    // completion_commit and DELETE the inferred field so the next phantom-Done
    // re-scan reads the explicit field → keep (no re-backfill loop).
    const fp = ticketFilePath(input.sessionDir, ticketId);
    let promoted = false;
    try {
      const raw = fs.readFileSync(fp, 'utf8');
      if (!readFrontmatterField(raw, 'completion_commit') && decision.sha) {
        const upd = promoteInferredToExplicit(raw, decision.sha);
        if (upd) {
          fs.writeFileSync(fp, upd);
          promoted = true;
        }
      }
    } catch { /* best-effort: persist failure must not block keep-Done */ }
    if (promoted) return 'inferred';
    logPhantomDoneKept(input, ticketId, workingDir, decision.fallbackFired ?? false);
    return 'explicit-reachable';
  }
  // decision.action === 'revert'
  return 'absent';
}

/**
 * R-PDUP auto-close: detect twin tickets for a split original.
 *
 * A ticket whose title is e.g. "R-FOO-1" may have been split into
 * "R-FOO-1-i" and "R-FOO-1-ii". We identify twins by looking for any
 * ticket in the session whose title starts with `<originalTitle>-` followed
 * by one or more lowercase roman-numeral characters (i, ii, iii, iv, v).
 *
 * Returns the set of twin ticket IDs (may be empty if none found).
 */
function findSplitTwins(
  originalTitle: string | null,
  allTickets: TicketInfo[],
  selfId: string,
): TicketInfo[] {
  if (!originalTitle) return [];
  // Match titles like "R-FOO-1-i", "R-FOO-1-ii", "R-FOO-1-iii" etc.
  // The original title must not itself end in a roman-numeral suffix.
  const TWIN_SUFFIX_RE = /^[ivx]+$/i;
  const stemWithDash = originalTitle + '-';
  return allTickets.filter((t) => {
    if (!t.id || t.id === selfId || !t.title) return false;
    if (!t.title.startsWith(stemWithDash)) return false;
    const suffix = t.title.slice(stemWithDash.length);
    return TWIN_SUFFIX_RE.test(suffix);
  });
}

/**
 * R-PDUP: collect Done-twin evidence records. Returns null if any twin is
 * not Done or lacks a usable delivery SHA (caller should hold the original).
 *
 * Uses readEvidence as the oracle (per R-RIC-EXPLICIT-4 contract) to classify
 * the twin's evidence kind. Accepts `committed` evidence (an attributable git
 * commit exists); only `absent` blocks the auto-close.
 */
function collectTwinEvidence(
  input: CorrectPhantomDoneTicketsInput,
  ticketId: string,
  twins: TicketInfo[],
  fallbackWorkingDir: string,
): Array<{ twinId: string; sha: string }> | null {
  const evidence: Array<{ twinId: string; sha: string }> = [];
  for (const twin of twins) {
    if (!twin.id) return null; // defensive
    let twinStatus: string;
    try {
      twinStatus = normalizedStatus(getTicketStatus(input.sessionDir, twin.id));
    } catch {
      return null;
    }
    // Any twin not Done → hold the original until all twins complete.
    if (twinStatus !== 'done') {
      input.log?.(
        `R-PDUP: holding split original ${ticketId} — twin ${twin.id} not yet Done (${twinStatus})`,
      );
      return null;
    }
    // B-1SEAM WS-1: classify the twin's completion evidence through the ONE
    // predicate ({ decision: 'attribution' } — keep-decision, no R-CWGE verdict).
    // B-DURA T70: only `committed` evidence (a git-verified SHA) lets the
    // auto-close proceed; `absent` blocks it.
    const twinDecision = evaluateCompletionEvidence(buildCompletionCtx({
      sessionDir: input.sessionDir,
      ticketId: twin.id,
      workingDir: twin.working_dir || fallbackWorkingDir,
      fallbackDir: input.workingDir,
      rereadBackoffMs: 0,
    }, 'attribution'));
    if (!twinDecision.ok) {
      input.log?.(
        `R-PDUP: holding split original ${ticketId} — twin ${twin.id} Done but no usable delivery SHA`,
      );
      return null;
    }
    evidence.push({ twinId: twin.id, sha: twinDecision.sha });
  }
  return evidence;
}

/**
 * R-PDUP roster-scanner auto-close branch, called from correctPhantomDoneTickets.
 *
 * For a Todo/Failed ticket that is a split original:
 *   - ALL twins Done + delivery SHA available → auto-close with twin's EXPLICIT SHA.
 *   - Only some twins Done → HOLD (not closed); original waits until every twin
 *     completes so the delivering commit is unambiguous.
 *   - No twins found → not a split original; skip (leave for normal roster run).
 *
 * We write an EXPLICIT completion_commit (NEVER _inferred) to prevent the
 * phantom-done-backfill infinite-loop (20MB-state incident in project memory).
 */
function maybeAutoCloseSplitOriginal(
  input: CorrectPhantomDoneTicketsInput,
  ticket: TicketInfo,
  allTickets: TicketInfo[],
): boolean {
  if (!ticket.id || !ticket.title) return false;

  const twins = findSplitTwins(ticket.title, allTickets, ticket.id);
  if (twins.length === 0) return false;

  const workingDir = ticket.working_dir || input.workingDir || process.cwd();
  const twinEvidence = collectTwinEvidence(input, ticket.id, twins, workingDir);
  if (!twinEvidence) return false; // hold: at least one twin not yet Done/provable

  // All twins Done with delivery SHAs — first twin's SHA is canonical.
  // (Any twin SHA proves the split work landed; first-found is stable across calls.)
  const canonicalSha = twinEvidence[0]!.sha;

  const origCtx: EvidenceCtx = {
    sessionDir: input.sessionDir,
    ticketId: ticket.id,
    workingDir,
    fallbackDir: input.workingDir,
  };

  // Write EXPLICIT completion_commit — twin evidence is authoritative.
  // The original was superseded before doing its own work, so readEvidence on
  // the original may return 'absent'; that is expected and must not block close.
  const persisted = persistEvidence(origCtx, canonicalSha, { stage: 'best-effort' });
  if (persisted.action === 'no_file' || persisted.action === 'unwritable') {
    input.log?.(
      `R-PDUP: could not write completion_commit for split original ${ticket.id} (persist failed: ${persisted.action})`,
    );
    return false;
  }

  // B-1SEAM WS-1: flip Done through the standard guard idiom instead of a bare
  // writeTicketStatus — the 7th guardCompletionCommitBeforeDone +
  // clearStaleDoneWithoutCommitEvidence pair (R-PEDC parity 6→7). The twins'
  // evidence, not the original's own gate, proves greenness: persist a
  // runner-authored GREEN verdict first (same idiom as commitAndContinueDoneFlip)
  // so the R-CWGE fail-closed check honors it.
  persistRunnerAuthoredGreenVerdict(input.sessionDir, ticket.id);
  const guard = guardCompletionCommitBeforeDone({
    sessionDir: input.sessionDir,
    ticketId: ticket.id,
    workingDir,
    flags: input.flags ?? {},
    // R-PDUP twin-borrow: the canonical sha's commit message names the TWIN
    // (production convention `fix(<twinId>): ...`), a sibling dir of the
    // original — without this sanction R-OMA reads it as foreign_attribution
    // and the original stays Todo forever (phantom-rebuild class).
    ownAttributionTokens: twinEvidence.map((e) => e.twinId),
  });
  if (!guard.ok) {
    input.log?.(
      `R-PDUP: auto-close guard refused split original ${ticket.id}: ${guard.reason}`,
    );
    return false;
  }
  clearStaleDoneWithoutCommitEvidence(path.join(input.sessionDir, 'state.json'));
  if (!markTicketDone(input.sessionDir, ticket.id)) return false;

  input.log?.(
    `R-PDUP: auto-closed split original ${ticket.id} — twins [${twinEvidence.map((e) => e.twinId).join(', ')}] Done, completion_commit=${canonicalSha}`,
  );
  logActivity({
    event: 'ticket_phantom_done_corrected',
    source: 'pickle',
    session: path.basename(input.sessionDir),
    ticket: ticket.id,
    iteration: input.iteration,
    reason: 'split_original_auto_closed_by_twin_evidence',
  });
  return true;
}

// eslint-disable-next-line -- R-PDUP adds the todo/failed auto-close branch; R-AFCC-DEEP-3B requires batchLoopPhantomDoneKind to stay in this function body (audit-phantom-done-call-sites.sh invariant)
export function correctPhantomDoneTickets(input: CorrectPhantomDoneTicketsInput): number {
  const allTickets = collectTickets(input.sessionDir);
  let corrected = 0;
  for (const ticket of allTickets) {
    let status: string;
    try {
      status = ticket.id ? normalizedStatus(getTicketStatus(input.sessionDir, ticket.id)) : '';
    } catch {
      continue;
    }
    if (!ticket.id) continue;

    // --- Existing branch: revert phantom-Done tickets with absent evidence ---
    if (status === 'done') {
      const workingDir = ticket.working_dir || input.workingDir || process.cwd();
      const conformance = readLatestTicketConformanceSnapshot(path.join(input.sessionDir, ticket.id));
      if (conformance.hasManagerHandoff) continue;
      // R-AFCC-DEEP-3B: decision matrix delegated to batchLoopPhantomDoneKind (complexity ceiling).
      const kind = batchLoopPhantomDoneKind(input, ticket.id, workingDir);
      if (kind === 'explicit-reachable' || kind === 'inferred') continue;
      // kind is 'absent' → revert
      if (!writeTicketStatus(input.sessionDir, ticket.id, 'Todo')) continue;

      corrected++;
      input.log?.(`Corrected phantom Done ticket ${ticket.id} back to Todo (no completion commit found)`);
      logActivity({
        event: 'ticket_phantom_done_corrected',
        source: 'pickle',
        session: path.basename(input.sessionDir),
        ticket: ticket.id,
        iteration: input.iteration,
        reason: 'done_frontmatter_without_completion_commit',
      });
      continue;
    }

    // --- R-PDUP auto-close branch: auto-close Todo/Failed split originals ---
    // A split original is a ticket whose title has no roman-numeral suffix but
    // whose children (with -i/-ii suffix) have all been Done. We auto-close it
    // with the twin's delivery SHA so the roster scanner cannot re-run it.
    if (status === 'todo' || status === 'failed') {
      if (maybeAutoCloseSplitOriginal(input, ticket, allTickets)) corrected++;
    }
  }
  return corrected;
}

export interface PhantomDoneInspectResult {
  /** True when the ticket file was mutated (either reverted to prior status or backfilled with a commit SHA). */
  changed: boolean;
  /**
   * - 'reverted': status flipped back to prior value (no commit found / git lookup failed)
   * - 'backfilled': real commit found; completion_commit field inserted
   * - 'has_completion_commit': frontmatter already had completion_commit; nothing to do
   * - 'not_done': status is not Done; nothing to do
   * - 'unparseable': read or write failed
   * - 'missing_id': frontmatter has no `id:` field
   */
  reason:
    | 'reverted'
    | 'backfilled'
    | 'has_completion_commit'
    | 'not_done'
    | 'unparseable'
    | 'missing_id';
  /** When 'reverted', the prior status that was restored ('Todo' | 'In Progress'). */
  priorStatus?: string;
  /** When 'reverted' and git lookup failed (vs. clean "no matches"), the failure reason. */
  gitFailureReason?: string;
  /** When 'backfilled', the commit SHA written into completion_commit. */
  commit?: string;
}

/**
 * R-AFCC-DEEP-3B: explicit decision-matrix kinds for phantom-Done reconciliation.
 * - explicit-reachable: completion_commit present and HEAD-reachable (or watcher path sees field at all)
 * - inferred: committed SHA from inferred field / git-log scan, promoted to the explicit field
 * - absent: no usable evidence (no field/scan match, unreachable SHA, baseline, or stale inferred) — revert
 */
export type PhantomDoneKind = 'explicit-reachable' | 'inferred' | 'absent';

/**
 * R-AFCC-DEEP-3B: apply the phantom-Done decision for a single file after
 * pre-checks have already passed (status=Done, id present). Extracted to keep
 * inspectPhantomDoneTicketFile under the ESLint complexity ceiling.
 *
 * Watcher path (B-1SEAM): stamped shas are git-probed via the single
 * completion predicate — resolvable → keep, scan-recoverable → backfill,
 * else revert. The pre-B-1SEAM bare field-presence keep is gone.
 */
function applyInspectPhantomDoneDecision(
  content: string,
  filePath: string,
  sessionDir: string,
  ticketId: string,
  workingDir: string,
  priorStatus: string,
): PhantomDoneInspectResult {
  // B-1SEAM WS-1: the bare field-presence keep is GONE — a stamped
  // completion_commit is now git-probed through the same predicate as every
  // other decision site (the hallucinated-sha stamp that caused the R-AICF
  // live accept/revert/fatal 3-way split was kept here on field presence
  // alone). The field-presence read only classifies the keep result below.
  const hadExplicit = !!readFrontmatterField(content, 'completion_commit');

  // R-AFCC-DEEP-4A: delegate to gateForPhantomDoneRevert (predicate-backed),
  // with session baseline SHAs wired via buildCompletionCtx (R-CXOR-2).
  const ctx = buildCompletionCtx({ sessionDir, ticketId, ticketPath: filePath, workingDir }, 'phantom-watch');
  let decision: RevertDecision;
  try {
    decision = gateForPhantomDoneRevert(ctx);
  } catch (err) {
    return { changed: false, reason: 'unparseable', gitFailureReason: safeErrorMessage(err) };
  }

  switch (decision.action) {
    case 'keep': {
      // Explicit field was already present and the predicate resolved it → keep as-is.
      if (hadExplicit || !decision.sha) return { changed: false, reason: 'has_completion_commit' };
      // No explicit field yet: the keep carries a committed SHA from the inferred
      // field or a git-log scan. D1 (84c209ae) promote-once: write EXPLICIT
      // completion_commit and DELETE the inferred field so the first pass returns
      // 'backfilled' (caller emits ONE backfill event) and subsequent passes see
      // the explicit field → 'has_completion_commit' → no further event (stable
      // backfill count).
      const updated = promoteInferredToExplicit(content, decision.sha);
      if (!updated) return { changed: false, reason: 'unparseable' };
      try { fs.writeFileSync(filePath, updated); } catch { return { changed: false, reason: 'unparseable' }; }
      return { changed: true, reason: 'backfilled', commit: decision.sha };
    }
    case 'revert': {
      const wrote = writeTicketStatus(sessionDir, ticketId, priorStatus);
      if (!wrote) return { changed: false, reason: 'unparseable' };
      return { changed: true, reason: 'reverted', priorStatus };
    }
  }
}

/**
 * R-ICP-5 / R-AFCC-DEEP-3B: Inspect a single rick_ticket_*.md file using the
 * explicit PhantomDoneKind decision matrix (via applyInspectPhantomDoneDecision).
 *
 * `priorStatus` defaults to 'Todo' but the watcher caller passes the last
 * known good status. Pure side-effect on the ticket file plus a structured result
 * — caller owns activity-event + stderr log writes.
 */
export function inspectPhantomDoneTicketFile(
  filePath: string,
  sessionDir: string,
  workingDir: string,
  priorStatus: string = 'Todo',
): PhantomDoneInspectResult {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { changed: false, reason: 'unparseable' };
  }
  const status = readFrontmatterField(content, 'status');
  if (!status || status.toLowerCase() !== 'done') {
    return { changed: false, reason: 'not_done' };
  }
  const ticketId = readFrontmatterField(content, 'id');
  if (!ticketId) {
    return { changed: false, reason: 'missing_id' };
  }
  return applyInspectPhantomDoneDecision(content, filePath, sessionDir, ticketId, workingDir, priorStatus);
}

function hasArtifact(files: readonly string[], prefix: string): boolean {
  return files.some(file => file.startsWith(prefix) && file.endsWith('.md'));
}

function inferTicketLifecycleStep(sessionDir: string, ticketId: string | null, fallback: Step): MuxLifecycleStep {
  if (!ticketId) return fallback === 'review' ? 'review' : 'research';

  let files: string[];
  try {
    files = fs.readdirSync(path.join(sessionDir, ticketId));
  } catch {
    return 'research';
  }

  if (hasArtifact(files, 'conformance_') || hasArtifact(files, 'code_review_')) return 'review';
  if (hasArtifact(files, 'plan_')) return 'implement';
  if (hasArtifact(files, 'research_')) return 'plan';
  return 'research';
}

function maxLifecycleStep(current: Step, next: MuxLifecycleStep): MuxLifecycleStep {
  if (current in MUX_LIFECYCLE_ORDER) {
    const currentLifecycle = current as MuxLifecycleStep;
    return MUX_LIFECYCLE_ORDER[currentLifecycle] > MUX_LIFECYCLE_ORDER[next] ? currentLifecycle : next;
  }
  return next;
}

function updateMuxLifecycleState(
  statePath: string,
  patch: { iteration?: number; currentTicket?: string | null; step?: MuxLifecycleStep },
): State {
  return sm.update(statePath, s => {
    if (patch.iteration !== undefined) s.iteration = patch.iteration;
    const ticketChanged = patch.currentTicket !== undefined && s.current_ticket !== patch.currentTicket;
    if (patch.currentTicket !== undefined && s.current_ticket !== patch.currentTicket) {
      s.current_ticket = patch.currentTicket;
      delete s.current_ticket_tier;
      delete s.current_ticket_budget;
      delete s.current_ticket_max_iterations;
      delete s.current_ticket_worker_timeout_seconds;
      delete s.current_ticket_budget_start_iteration;
    }
    if (patch.step !== undefined) {
      s.step = ticketChanged ? patch.step : maxLifecycleStep(s.step, patch.step);
    }
  });
}

function readTicketBudgetForState(state: State, sessionDir: string): TicketTierBudget {
  const ticketId = typeof state.current_ticket === 'string' && state.current_ticket.length > 0
    ? state.current_ticket
    : null;
  if (!ticketId) return sessionRunnerBudget(state);

  const ticketPath = path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`);
  if (!fs.existsSync(ticketPath)) return sessionRunnerBudget(state);

  const cachedTier = typeof state.current_ticket_tier === 'string' ? state.current_ticket_tier : undefined;
  if (cachedTier) return getTicketTierBudgetWithOverrides(state, cachedTier);
  return ticketInfoBudgetFromPath(state, ticketPath);
}

function ticketInfoBudgetFromPath(state: State, ticketPath: string): TicketTierBudget {
  return getTicketTierBudgetWithOverrides(state, parseTicketFrontmatter(ticketPath)?.complexity_tier);
}

function sessionRunnerBudget(state: State): TicketTierBudget {
  const max_iterations = Number(state.max_iterations);
  const worker_timeout_seconds = Number(state.worker_timeout_seconds);
  const fallback = getTicketTierBudgetWithOverrides(state, undefined);
  return {
    tier: 'medium',
    max_iterations: Number.isFinite(max_iterations) && max_iterations > 0 ? max_iterations : fallback.max_iterations,
    worker_timeout_seconds: Number.isFinite(worker_timeout_seconds) && worker_timeout_seconds > 0
      ? worker_timeout_seconds
      : fallback.worker_timeout_seconds,
  };
}

/**
 * B-PXBO WS-3-FacetB: per-PROCESS set of tickets whose per-ticket budget baseline
 * has been (re-)established in THIS process. A crash-resume relaunch inherits a
 * persisted `current_ticket_budget_start_iteration` from a PRIOR process; if it is
 * stale (e.g. baseline 0 against a resumed iteration N) `ticketBudgetIterationCount`
 * returns an iteration-N delta that instantly trips the per-ticket cap-check and
 * flips a still-runnable ticket Done->Failed. The first time this process applies
 * the budget for a ticket, we re-baseline to the current iteration; every later
 * same-process call leaves the (now process-fresh) baseline untouched so genuine
 * no-progress within this process still accrues against the cap.
 */
const ticketBudgetProcessBaselined = new Set<string>();

/** Test-only: reset the per-process budget-baseline ledger (B-PXBO WS-3-FacetB). */
export function _resetTicketBudgetProcessBaseline(): void {
  ticketBudgetProcessBaselined.clear();
}

export function applyTicketTierBudget(state: State, sessionDir: string): TicketTierBudget {
  const budget = readTicketBudgetForState(state, sessionDir);
  const ticketId = typeof state.current_ticket === 'string' && state.current_ticket.length > 0
    ? state.current_ticket
    : null;
  // Re-baseline once per process for an INHERITED (prior-process) baseline; or set
  // the baseline for the first time when absent (the legacy `=== undefined` gate).
  const inheritedFromPriorProcess = ticketId !== null
    && state.current_ticket_budget_start_iteration !== undefined
    && !ticketBudgetProcessBaselined.has(ticketId);
  if (state.current_ticket_budget_start_iteration === undefined || inheritedFromPriorProcess) {
    state.current_ticket_budget_start_iteration = Math.max(0, (Number(state.iteration) || 0) - 1);
  }
  if (ticketId !== null) ticketBudgetProcessBaselined.add(ticketId);
  state.current_ticket_tier = budget.tier;
  state.current_ticket_max_iterations = budget.max_iterations;
  state.current_ticket_worker_timeout_seconds = budget.worker_timeout_seconds;
  // R-CNAR-1 part 2: do NOT overwrite state.max_iterations here. Per the
  // trap-door invariant in extension/CLAUDE.md, state.max_iterations is the
  // GLOBAL manager-loop cap (operator-set at session start). The per-ticket
  // tier ceiling lives in state.current_ticket_max_iterations (set above).
  // The cap-check at runMuxLoop reads BOTH and exits whichever fires first.
  // worker_timeout_seconds is documented as the per-spawn worker budget so it
  // remains overwritten here — workers want the per-ticket timeout.
  state.worker_timeout_seconds = budget.worker_timeout_seconds;
  return budget;
}

function ticketBudgetIterationCount(state: State, currentIteration: number): number {
  if (!state.current_ticket || typeof state.current_ticket_tier !== 'string') return currentIteration;
  const start = Number(state.current_ticket_budget_start_iteration);
  if (!Number.isFinite(start) || start < 0) return currentIteration;
  return Math.max(0, currentIteration - start);
}

/**
 * R-CNAR-7: Atomic clear of all five `current_ticket_*` cache fields.
 * Called when `state.current_ticket` is null/undefined and the per-ticket
 * cap-check sees a stale, non-zero `current_ticket_max_iterations` left over
 * from a previously-completed ticket. Without this, --resume of a
 * clean-success exit (which leaves the cache populated) trips
 * `iteration_cap_exhausted` on iteration 1 before any new ticket starts.
 *
 * Returns the count of fields cleared (0 = state was already clean).
 */
export function clearStaleTicketCacheFields(state: State): number {
  let cleared = 0;
  if (state.current_ticket_tier !== undefined) { delete state.current_ticket_tier; cleared++; }
  if (state.current_ticket_budget !== undefined) { delete state.current_ticket_budget; cleared++; }
  if (state.current_ticket_max_iterations !== undefined) { delete state.current_ticket_max_iterations; cleared++; }
  if (state.current_ticket_worker_timeout_seconds !== undefined) { delete state.current_ticket_worker_timeout_seconds; cleared++; }
  if (state.current_ticket_budget_start_iteration !== undefined) { delete state.current_ticket_budget_start_iteration; cleared++; }
  return cleared;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function hasStalePerTicketCacheFields(state: Pick<State,
  'current_ticket_tier'
  | 'current_ticket_budget'
  | 'current_ticket_max_iterations'
  | 'current_ticket_worker_timeout_seconds'
  | 'current_ticket_budget_start_iteration'>): boolean {
  return state.current_ticket_tier !== undefined
    || state.current_ticket_budget !== undefined
    || state.current_ticket_max_iterations !== undefined
    || state.current_ticket_worker_timeout_seconds !== undefined
    || state.current_ticket_budget_start_iteration !== undefined;
}

export function isValidPerTicketCapCache(state: Pick<State,
  'current_ticket'
  | 'current_ticket_tier'
  | 'current_ticket_max_iterations'
  | 'current_ticket_budget_start_iteration'>): boolean {
  if (state.current_ticket === null || state.current_ticket === undefined) return false;
  if (!isPositiveInteger(state.current_ticket_max_iterations)) return false;
  if (!isNonNegativeInteger(state.current_ticket_budget_start_iteration)) return false;
  if (typeof state.current_ticket_tier !== 'string') return false;
  return (VALID_TICKET_COMPLEXITY_TIERS as readonly string[]).includes(state.current_ticket_tier.toLowerCase());
}

export function stalePerTicketCacheDiagnostic(state: Pick<State,
  'current_ticket'
  | 'current_ticket_tier'
  | 'current_ticket_max_iterations'
  | 'current_ticket_budget_start_iteration'>): string {
  return `per-ticket cap-check skipped: stale cache (current_ticket=${String(state.current_ticket)}, max_iter=${String(state.current_ticket_max_iterations)}, budget_start=${String(state.current_ticket_budget_start_iteration)}, tier=${String(state.current_ticket_tier)})`;
}

function shouldEmitStalePerTicketCapSkip(state: Pick<State,
  'current_ticket'
  | 'current_ticket_tier'
  | 'current_ticket_budget'
  | 'current_ticket_max_iterations'
  | 'current_ticket_worker_timeout_seconds'
  | 'current_ticket_budget_start_iteration'>): boolean {
  return hasStalePerTicketCacheFields(state) && !isValidPerTicketCapCache(state);
}

export function clearStalePerTicketCacheAtIterationStart(
  statePath: string,
  state: State,
  log: (msg: string) => void,
  sessionDir: string,
): State {
  const hasTicket = typeof state.current_ticket === 'string' && state.current_ticket.length > 0;
  if (!hasTicket) {
    // Clear-on-null: stale per-ticket cache left over from a completed ticket.
    if (!hasStalePerTicketCacheFields(state)) return state;
    log('clearing stale per-ticket cache fields (current_ticket=null)');
    return sm.update(statePath, s => {
      clearStaleTicketCacheFields(s);
    });
  }
  // AC-R-WMNP-2: a SET current_ticket whose per-ticket cap cache is missing or
  // invalid MUST be REPOPULATED from the ticket's complexity tier — not left
  // perpetually skipped. Without this, the per-ticket cap-check at runMuxLoop is
  // skipped every iteration and nothing bounds a wedged respawn loop (the
  // `cap-check skipped: stale cache (... max_iter=undefined ...)` incident).
  if (!isValidPerTicketCapCache(state)) {
    log(`repopulating per-ticket cap cache from ticket tier (current_ticket=${state.current_ticket})`);
    return sm.update(statePath, s => {
      clearStaleTicketCacheFields(s);
      applyTicketTierBudget(s, sessionDir);
    });
  }
  return state;
}

/**
 * W4c (AC-W4c-1): guarantee the per-ticket no-progress cap is ALWAYS bounded
 * from frontmatter at decision time. The R-WMNP root cause was a SET
 * `current_ticket` whose per-ticket cap cache was invalid/undefined: the
 * cap-check then reads `ticketMaxIter = 0`, the `ticketMaxIter > 0` guard
 * skips the cap, and the ticket respawns in-phase forever (unbounded loop
 * because the cap silently disabled itself).
 *
 * This is a belt-and-suspenders re-assertion of the R-CNAR-1 self-heal
 * (`clearStalePerTicketCacheAtIterationStart`): for a SET ticket with an
 * invalid cap cache it re-derives the cap via `applyTicketTierBudget` (reading
 * the ticket's `complexity_tier` frontmatter → tier budget), so any code path
 * that left `current_ticket_max_iterations` undefined/0 cannot disable the cap.
 * It NEVER touches the no-ticket case (owned by `shouldEmitStalePerTicketCapSkip`)
 * and NEVER overwrites `state.max_iterations` (R-CNAR-1 part-2 trap door —
 * `applyTicketTierBudget` is the part-2-compliant deriver).
 *
 * Best-effort: a state write failure falls open to the existing
 * `ticketMaxIter=0` skip — never worse than the pre-W4c behavior.
 */
export function repopulateNoProgressCapFromFrontmatter(
  statePath: string,
  state: State,
  log: (msg: string) => void,
  sessionDir: string,
): State {
  const hasTicket = typeof state.current_ticket === 'string' && state.current_ticket.length > 0;
  if (!hasTicket || isValidPerTicketCapCache(state)) return state;
  try {
    log(`W4c: repopulating no-progress cap from frontmatter (current_ticket=${state.current_ticket})`);
    return sm.update(statePath, s => {
      clearStaleTicketCacheFields(s);
      applyTicketTierBudget(s, sessionDir);
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`W4c: cap repopulation failed: ${msg}`);
    return state;
  }
}

/**
 * Proactive empty-queue completion check, run at iteration_start before any
 * manager spawn. If all `rick_ticket_*.md` files in the session report
 * `status: Done` (and there is at least one ticket), synthesizes an
 * EPIC_COMPLETED terminal state atomically and returns true so the caller
 * can break the outer loop.
 *
 * Guard conditions (bias: don't fire):
 *   - N=0 tickets — ambiguous; could be a setup error
 *   - Any ticket file unparseable — cannot confirm all Done
 *   - Not all statuses normalize to 'done'
 *
 * On success mutates state.json twice:
 *   1. sm.update  — sets completion_promise (JSON) + appends activity entry
 *   2. finalizeTerminalState — sets active=false, step='completed', exit_reason='completed'
 */
/**
 * B-GROUND2 WS1: the mux-seam ground-truth scan fed to `finalizeIfTrulyComplete`
 * at every EPIC-terminal finalize. Re-scans frontmatter via `reconcileTicketTruth`
 * and reduces to `GraduationCounts`. The mux seam has no commit count in hand at
 * the finalize site, so `commitCount` is 0 — graduation then keys on the
 * Done/Skipped roster alone (a fully-Done bundle has `pendingCount === 0`).
 *
 * `reconcileTicketTruth` is by-design best-effort (every probe try/catch'd to a
 * conservative default), so an empty / unreadable roster reduces to a 0-count
 * snapshot, which `graduationDecision` GRADUATES via its `ticketCount <= 0`
 * never-decomposed carve-out. That carve-out is safe at THIS seam only because
 * every caller is gated upstream: `applyAllTicketsDoneCompletion` returns false
 * on a 0-ticket roster BEFORE reaching this finalize, and the EPIC_COMPLETED
 * paths fire only after the bundle's tickets are established as terminal. The
 * primary fail-closed line is the pipeline seam (`pipelineBundleScan` returns
 * `null` on a throwing reader); this adapter returns counts, never `null`, and is
 * pinned by `completion-scan-adapter-edge.test.js`.
 */
/** Git context needed to apply the B-DURA T40 Failed-terminal conjunctive guard. */
export interface FailedTerminalGitContext {
  sessionDir: string;
  workingDir: string;
  /** Session baseline (state.start_commit); null when unavailable → guard refuses to exclude. */
  startCommit: string | null;
}

/**
 * B-DURA T40 (AC-DURA-6/7): the ONE guarded predicate shared by all 4 advance/
 * finalize count sites. A `Failed` ticket is terminal-EXCLUDABLE from the
 * advance/pending count ONLY when the conjunctive false-green guard holds:
 *   - its `start_commit..HEAD` declared-file window is EMPTY (no commit
 *     attributable to the ticket landed since the session baseline; because
 *     `preIterSha..HEAD ⊆ start_commit..HEAD`, an empty start_commit window
 *     implies an empty preIterSha window — both windows empty), AND
 *   - the working tree is CLEAN.
 * A spuriously-Failed BUILD ticket with a NON-empty window OR a dirty tree is NOT
 * excludable → it BLOCKS advance (prevents both the 0/4 false-negative AND the
 * silent-drop false-green). Missing git context (no start_commit / no HEAD) is
 * conservative: NOT excludable (blocks advance). This is the ONLY place the
 * exclusion is decided; the 4 count sites call it identically.
 */
export function isFailedTicketTerminalExcludable(
  ctx: FailedTerminalGitContext,
  ticketId: string,
): boolean {
  if (!ctx.startCommit) return false; // no baseline → cannot prove the window empty
  const head = silentDeathGit(['rev-parse', 'HEAD'], ctx.workingDir);
  if (!head) return false;
  // Tree must be clean (no uncommitted deliverable for this/any ticket).
  try {
    if (isWorkingTreeDirty(ctx.workingDir)) return false;
  } catch {
    return false;
  }
  // start_commit..HEAD declared-file window must be empty for this ticket.
  let declared: string[];
  try {
    declared = readDeclaredFiles(fs.readFileSync(ticketFilePath(ctx.sessionDir, ticketId), 'utf8'));
  } catch {
    // Cannot read declared files → cannot prove the window empty → block advance.
    return false;
  }
  if (declared.length === 0) {
    // No declared files: fall back to "any commit in the window" — if HEAD moved
    // off the baseline at all there may be ticket work, so block; if HEAD === baseline
    // the window is trivially empty.
    return head === ctx.startCommit;
  }
  const diffOut = silentDeathGit(['diff', '--name-only', `${ctx.startCommit}..HEAD`], ctx.workingDir);
  if (diffOut === null) return false; // git could not answer → conservative block
  const touched = new Set(diffOut.split('\n').map((s) => s.trim()).filter(Boolean));
  // The window is "empty for this ticket" iff none of its declared files were touched.
  const norm = (p: string): string => p.replace(/^\.\//, '');
  const touchedNorm = new Set([...touched].map(norm));
  const anyDeclaredTouched = declared.some((f) => touchedNorm.has(norm(f)));
  return !anyDeclaredTouched;
}

/**
 * T40 helper: is this ticket pending FOR ADVANCE purposes? Done/Skipped are never
 * pending. A `Failed` ticket is pending UNLESS the conjunctive guard proves it
 * terminal-excludable. All other non-terminal statuses (Todo/In Progress) are
 * pending. `gitCtx` absent → Failed is treated as pending (conservative block).
 */
function isPendingForAdvance(status: string, ticketId: string | null, gitCtx: FailedTerminalGitContext | null): boolean {
  const n = normalizeTicketStatus(status);
  if (n === 'done' || n === 'skipped') return false;
  if (n === 'failed') {
    if (!gitCtx || !ticketId) return true; // no context → block advance (false-green guard)
    return !isFailedTicketTerminalExcludable(gitCtx, ticketId);
  }
  return true; // todo / in progress / unknown non-terminal → pending
}

function muxBundleScan(sessionDir: string, workingDir: string): GraduationCounts | null {
  const truth = reconcileTicketTruth({ sessionDir, workingDir });
  const entries = Object.entries(truth.ticketStatuses);
  const doneCount = entries.filter(([, st]) => normalizeTicketStatus(st) === 'done').length;
  // B-DURA T40: a Failed ticket is excluded from pendingCount ONLY under the
  // conjunctive false-green guard (windows empty + tree clean), applied identically
  // at all 4 count sites via isPendingForAdvance.
  const gitCtx: FailedTerminalGitContext = { sessionDir, workingDir, startCommit: resolveSessionBaselineShas(sessionDir).startCommit };
  const pendingCount = entries.filter(([id, st]) => isPendingForAdvance(st ?? '', id, gitCtx)).length;
  return { doneCount, commitCount: 0, pendingCount, ticketCount: entries.length };
}

/** Collect all `rick_ticket_*.md` paths under a session dir; null when the dir is unreadable. */
function collectRickTicketPaths(sessionDir: string): string[] | null {
  let dirEntries: fs.Dirent[];
  try {
    dirEntries = fs.readdirSync(sessionDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const ticketPaths: string[] = [];
  for (const entry of dirEntries) {
    if (!entry.isDirectory()) continue;
    const subDir = path.join(sessionDir, entry.name);
    try {
      for (const file of fs.readdirSync(subDir)) {
        if (file.startsWith('rick_ticket_') && file.endsWith('.md')) {
          ticketPaths.push(path.join(subDir, file));
        }
      }
    } catch { /* subdir unreadable — skip */ }
  }
  return ticketPaths;
}

export type AllTicketsDoneCompletionDeps = {
  runTestFast?: (extensionDir: string, timeoutMs?: number) => BetweenTicketGateResult;
  now?: () => number;
  finalCommitTs?: number | null;
};

export function applyAllTicketsDoneCompletion(
  statePath: string,
  sessionDir: string,
  iteration: number,
  log: (msg: string) => void,
  workingDir: string = '',
  deps: AllTicketsDoneCompletionDeps = {},
): boolean {
  const ticketPaths = collectRickTicketPaths(sessionDir);
  if (ticketPaths === null) return false;
  if (ticketPaths.length === 0) return false;

  // B-DURA T40: shared git context for the Failed-terminal conjunctive guard,
  // applied identically here (the `every` pre-check) and in the reconcile re-scan.
  const t40GitCtx: FailedTerminalGitContext = { sessionDir, workingDir, startCommit: resolveSessionBaselineShas(sessionDir).startCommit };

  const idStatuses: Array<{ id: string | null; status: string }> = [];
  for (const ticketPath of ticketPaths) {
    const parsed = parseTicketFrontmatter(ticketPath);
    if (!parsed) {
      log(`all-tickets-done-check: cannot parse ${path.basename(path.dirname(ticketPath))} — skipping completion synthesis`);
      return false;
    }
    const id = parsed.id ?? path.basename(path.dirname(ticketPath));
    idStatuses.push({ id, status: normalizeTicketStatus(parsed.status || '') });
  }

  // A Failed ticket that satisfies the conjunctive guard is terminal-excludable
  // here too (it does not block the all-done synthesis); otherwise it blocks.
  if (idStatuses.some(({ id, status }) => isPendingForAdvance(status, id, t40GitCtx))) return false;

  // False-completion guard: re-scan via reconcileTicketTruth before committing to finalize.
  const truth = reconcileTicketTruth({ sessionDir, workingDir });
  const nonTerminal = Object.entries(truth.ticketStatuses)
    .filter(([id, st]) => isPendingForAdvance(st ?? '', id, t40GitCtx));
  if (nonTerminal.length > 0) {
    log(`false-completion guard: ${nonTerminal.length} non-terminal ticket(s) detected — refusing all-done finalize`);
    return false;
  }

  // R-NOPOSTTIER: the bundle's final commit has landed and every ticket is terminal, so THIS is
  // the last moment before the promise exists. Measure the fast tier here and record a classified
  // verdict. Deliberately placed after the guards above: their `return false` branches synthesize
  // no promise, so they owe no verdict and must not pay for a tier run. The measurement is total —
  // it cannot abort the run — and it does not change the disposition (see `fa3d0f5a`).
  // The wrap is belt-and-braces, not redundancy: `runPostFinalMeasurement` is written as a total
  // function, and this keeps that true at the SEAM even if a future edit inside it grows a throwing
  // path. A measurement must never be able to break the completion synthesis.
  try {
    runPostFinalMeasurement({
      statePath,
      workingDir,
      completedTicketId: idStatuses[idStatuses.length - 1]?.id ?? 'all-tickets-done',
      log,
      now: deps.now,
      runTestFast: deps.runTestFast,
      finalCommitTs: deps.finalCommitTs,
    });
  } catch (err) {
    log(`post-final tier measurement failed at the completion seam (ignored): ${safeErrorMessage(err)}`);
  }

  const ts = new Date().toISOString();
  sm.update(statePath, s => {
    s.completion_promise = JSON.stringify({ kind: PromiseTokens.EPIC_COMPLETED, reason: 'all-tickets-done', ts });
    if (!Array.isArray(s.activity)) s.activity = [];
    s.activity.push({ event: 'epic_completed', kind: PromiseTokens.EPIC_COMPLETED, ts });
  });
  // B-GROUND2 WS1: the all-done synthesis routes through the single authority.
  // The reconcileTicketTruth false-completion guard above already re-scanned, but
  // routing here makes this the canonical ticket-bundle completion seam (no raw
  // `exitReason: 'completed'` finalize survives the 4th audit proxy).
  finalizeIfTrulyComplete(
    statePath,
    () => muxBundleScan(sessionDir, workingDir),
    { step: 'completed', runnerIteration: iteration, exitReason: 'completed' },
  );
  log(`all-tickets-done (${ticketPaths.length}/${ticketPaths.length}): synthesizing ${PromiseTokens.EPIC_COMPLETED} completion`);
  return true;
}

/**
 * Returns tickets that are still pending (not Done, not Skipped) excluding
 * `currentTicket`. Used to fail-loud when the model emits EPIC_COMPLETED but
 * the ticket queue is not actually drained — silent loop-termination on a
 * partial epic is the most expensive class of bug for autonomous agents.
 *
 * Status comparison is case-insensitive and strips quotes (matches the
 * normalisation already used at line ~1017 and in monitor.ts).
 */
export function findPendingNonCurrentTickets(
  tickets: readonly TicketInfo[],
  currentTicket: string | null,
  gitCtx: FailedTerminalGitContext | null = null,
): TicketInfo[] {
  // B-DURA T40: a Failed ticket is excluded from the pending set ONLY under the
  // conjunctive false-green guard (identical predicate to the other 3 count sites
  // via isPendingForAdvance); absent gitCtx → Failed counts as pending (block).
  return tickets.filter(t => {
    if (!t.id) return false;
    if (t.id === currentTicket) return false;
    return isPendingForAdvance(t.status ?? '', t.id, gitCtx);
  });
}

/**
 * Decision returned by `evaluateEpicCompletion`. Replaces the prior fail-loud
 * "exit 1 on any false EPIC_COMPLETED" behaviour with structural recovery.
 *
 * - `genuine` — every ticket reports `status: Done` (case/quote-insensitive).
 *   Behave as today: mark current Done, exit success.
 * - `recover_advance` — manager lied about epic completion BUT current_ticket
 *   really is Done. Treat as a single TASK_COMPLETED; advance to next ticket,
 *   keep iterating. Increment false-epic counter for telemetry.
 * - `recover_retry` — manager lied AND current_ticket is not Done either.
 *   Force another iteration on the same ticket with a stricter retry brief.
 *   Increment counter; reset on next genuine advance.
 * - `persistent_hallucination` — counter has crossed the threshold for the
 *   same ticket. Bail with a distinct exit class so a human can intervene.
 *
 * Pure function — no I/O. Caller owns ticket collection, state mutation, and
 * iteration handoff. Behaviour is fully deterministic from inputs.
 */
export type EpicCompletionDecision =
  | { kind: 'genuine'; doneCount: number; totalCount: number }
  | { kind: 'recover_advance'; doneCount: number; totalCount: number; pendingIds: string[]; nextCount: number }
  | { kind: 'recover_retry'; doneCount: number; totalCount: number; pendingIds: string[]; nextCount: number }
  | { kind: 'persistent_hallucination'; doneCount: number; totalCount: number; ticket: string; nextCount: number };

export interface EvaluateEpicCompletionInput {
  tickets: readonly TicketInfo[];
  currentTicket: string | null;
  /** Prior counter value from `state.false_epic_completed_count` (0 if absent). */
  priorFalseCount: number;
  /** Ticket the prior counter is associated with. Counter resets when this differs from `currentTicket`. */
  priorFalseTicket: string | null;
  /** Threshold beyond which we exit with MANAGER_PERSISTENT_HALLUCINATION. Defaults to FALSE_EPIC_THRESHOLD. */
  threshold?: number;
  /**
   * B-DURA T40: git context for the Failed-terminal conjunctive guard. When
   * provided, a Failed ticket is excluded from the pending set ONLY when its
   * windows are empty AND the tree is clean (identical predicate to the other 3
   * count sites). Absent → Failed counts as pending (conservative false-green block).
   */
  failedTerminalGitContext?: FailedTerminalGitContext | null;
}

/**
 * Decide what to do when the manager emits EPIC_COMPLETED. This is the
 * single source of truth for the recovery state machine — the main loop just
 * acts on the returned decision.
 */
export function evaluateEpicCompletion(input: EvaluateEpicCompletionInput): EpicCompletionDecision {
  const { tickets, currentTicket, priorFalseCount, priorFalseTicket } = input;
  const threshold = input.threshold ?? FALSE_EPIC_THRESHOLD;

  const norm = (s: string | null): string =>
    (s || '').toLowerCase().replace(/["']/g, '').trim();

  const gitCtx = input.failedTerminalGitContext ?? null;
  const totalCount = tickets.filter(t => !!t.id).length;
  const doneCount = tickets.filter(t => !!t.id && norm(t.status) === 'done').length;
  // B-DURA T40: a Failed ticket is excluded from pendingIds ONLY under the
  // conjunctive false-green guard (identical predicate via isPendingForAdvance).
  const pendingIds = tickets
    .filter(t => !!t.id && t.id !== currentTicket && isPendingForAdvance(t.status ?? '', t.id, gitCtx))
    .map(t => t.id!)
    .filter((s): s is string => typeof s === 'string');

  const currentInfo = currentTicket ? tickets.find(t => t.id === currentTicket) : null;
  const currentIsDone = !!currentInfo && norm(currentInfo.status) === 'done';

  // The current ticket is allowed to count as "about to be Done" because the
  // manager normally marks it Done in the same iteration as EPIC_COMPLETED.
  // We treat it as Done iff it is BOTH actually Done AND no other tickets are
  // pending. This keeps the genuine path identical to the prior guard.
  if (pendingIds.length === 0 && (currentTicket == null || currentIsDone)) {
    return { kind: 'genuine', doneCount, totalCount };
  }

  // From here on the manager lied. Bump the counter (resetting when ticket
  // changes — different ticket means we're not stuck in the same loop).
  const sameTicket = currentTicket != null && priorFalseTicket === currentTicket;
  const nextCount = (sameTicket ? priorFalseCount : 0) + 1;

  if (currentTicket != null && nextCount > threshold) {
    return { kind: 'persistent_hallucination', doneCount, totalCount, ticket: currentTicket, nextCount };
  }

  if (currentIsDone) {
    return { kind: 'recover_advance', doneCount, totalCount, pendingIds, nextCount };
  }
  return { kind: 'recover_retry', doneCount, totalCount, pendingIds, nextCount };
}

/**
 * Classifies iteration output into a completion result.
 * EPIC_COMPLETED → 'task_completed' (exits the loop — all tickets done)
 * EXISTENCE_IS_PAIN / THE_CITADEL_APPROVES → 'review_clean' (subject to min_iterations gate)
 * TASK_COMPLETED / anything else → 'continue' (single ticket done, loop continues)
 *
 * Only checks assistant message content (via extractAssistantContent) to avoid
 * false positives from promise tokens in reviewed source code.
 */
export function classifyCompletion(output: string): 'task_completed' | 'review_clean' | 'continue' {
  const content = extractAssistantContent(output);
  if (hasToken(content, PromiseTokens.EPIC_COMPLETED)) {
    return 'task_completed';
  }
  if (hasToken(content, PromiseTokens.EXISTENCE_IS_PAIN) || hasToken(content, PromiseTokens.THE_CITADEL_APPROVES)) {
    return 'review_clean';
  }
  return 'continue';
}

/** Scans a full iteration log for codex Bash tool-calls invoking setup.js. */
export function checkIterationLogForCodexSelfBootstrap(
  output: string,
  backend: Backend,
  currentTicket: string | null | undefined,
  iterationNum: number,
): Array<{ attempted_argv: string[]; ticket: string | null; iteration: number }> {
  if (backend !== 'codex') return [];
  const fmt = detectOutputFormat(output);
  if (fmt === 'plain-text') return [];
  const results: Array<{ attempted_argv: string[]; ticket: string | null; iteration: number }> = [];
  const lines = output.split('\n');
  let inToolCallBlock = false;
  for (const line of lines) {
    if (fmt === 'codex-block') {
      if (CODEX_DELIMITER_RE.test(line)) {
        inToolCallBlock = /^tool_call\s*$/.test(line);
        continue;
      }
      if (!inToolCallBlock) continue;
    }
    const obs = observeCodexToolCallStream(line, fmt === 'stream-json' ? 'stream-json' : 'codex-block');
    if (obs?.isSetupInvocation) {
      results.push({ attempted_argv: obs.argv, ticket: currentTicket ?? null, iteration: iterationNum });
    }
  }
  return results;
}

/**
 * Post-hoc safety net: validates whether a ticket was actually completed
 * before marking it Done. TASK_COMPLETED token is strong evidence. Otherwise
 * require a ticket-scoped lifecycle artifact — unscoped git diff alone is a
 * ghost source (changes from any other ticket in the tree pass). Never throws.
 */
export function classifyTicketCompletion(
  iterLogFile: string,
  workingDir: string,
  ticketDir?: string,
  role: WorkerRole = 'implementation'
): 'completed' | 'skipped' {
  try {
    const logContent = fs.readFileSync(iterLogFile, 'utf-8');
    const assistantContent = extractAssistantContent(logContent);
    if (hasToken(assistantContent, PromiseTokens.TASK_COMPLETED)) return 'completed';
  } catch (err) { process.stderr.write(`[mux-runner:classify-ticket:log-read] ${safeErrorMessage(err)}\n`); /* fall through to artifact check */ }

  if (!ticketDir) return 'skipped';
  let files: string[];
  try { files = fs.readdirSync(ticketDir); } catch { return 'skipped'; }
  if (!hasLifecycleArtifact(files, role)) return 'skipped';

  // Artifact exists — corroborate with git diff. Artifacts alone are
  // sufficient because the worker wrote them during its lifecycle, but a
  // dirty tree is a stronger signal that code actually changed.
  try {
    const uncommitted = runCmd(['git', 'diff', '--stat'], { cwd: workingDir, check: false });
    if (uncommitted.length > 0) return 'completed';
    const staged = runCmd(['git', 'diff', '--stat', '--cached'], { cwd: workingDir, check: false });
    if (staged.length > 0) return 'completed';
  } catch (err) { process.stderr.write(`[mux-runner:classify-ticket:git-probe] ${safeErrorMessage(err)}\n`); /* artifact alone suffices */ }

  return 'completed';
}

export type AutoTicketCompletionValidation =
  | { action: 'done'; reason: 'commit_and_acceptance_checked' }
  | { action: 'skip'; reason: string }
  | { action: 'leave'; reason: string };

function normalizedStatus(status: string | null | undefined): string {
  return (status || '').toLowerCase().replace(/^["']|["']$/g, '').trim();
}

function isTerminalTicketStatus(status: string | null | undefined): boolean {
  const normalized = normalizedStatus(status);
  return normalized === 'done' || normalized === 'skipped';
}

function acceptanceCriteriaSection(content: string): string {
  const match = /^## Acceptance Criteria\s*$/m.exec(content);
  if (!match) return '';
  const rest = content.slice(match.index + match[0].length);
  const next = /^## \S.*$/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

type AcceptanceCriteriaOwner = 'worker' | 'manager' | 'unassigned';

interface AcceptanceCriteriaCheckbox {
  checked: boolean;
  owner: AcceptanceCriteriaOwner;
}

function acceptanceCriteriaCheckboxes(content: string): AcceptanceCriteriaCheckbox[] {
  const section = acceptanceCriteriaSection(content);
  const checkboxes: AcceptanceCriteriaCheckbox[] = [];
  for (const match of section.matchAll(/^\s*-\s*\[([ xX])\]\s*(.+?)\s*$/gm)) {
    const criterion = match[2].trim();
    const owner: AcceptanceCriteriaOwner = /^\[manager\](?:\s|$)/i.test(criterion)
      ? 'manager'
      : /^\[worker\](?:\s|$)/i.test(criterion)
        ? 'worker'
        : 'unassigned';
    checkboxes.push({
      checked: match[1].toLowerCase() === 'x',
      owner,
    });
  }
  return checkboxes;
}

function hasCheckedAcceptanceCriteria(content: string): boolean {
  const boxes = acceptanceCriteriaCheckboxes(content);
  if (boxes.length === 0) return false;
  return boxes
    .filter((box) => box.owner !== 'manager')
    .every((box) => box.checked);
}

function readHeadCommit(workingDir: string): string | null {
  try {
    const head = runCmd(['git', 'rev-parse', 'HEAD'], { cwd: workingDir, check: false }).trim();
    return head.length > 0 ? head : null;
  } catch {
    return null;
  }
}

/** Returns true when headSha is the same as refSha or is an ancestor of refSha (HEAD regressed). */
function isHeadAtOrBelowCommit(headSha: string, refSha: string, workingDir: string): boolean {
  if (headSha === refSha) return true;
  const r = spawnSync('git', ['-C', workingDir, 'merge-base', '--is-ancestor', headSha, refSha], { encoding: 'utf-8', timeout: 5000 });
  return r.status === 0;
}

/**
 * R-RRH C4 ff-reattach guard for HEAD-reset call sites (anatomy/microverse
 * auto-commit-then-reset). Returns true when resetting to `target` WOULD orphan
 * `protectedSha` — i.e. `protectedSha` ff-descends from `target` (target is a
 * strict ancestor of protectedSha). Reuses the H1 is-ancestor mechanism
 * (`isHeadAtOrBelowCommit`); does NOT duplicate the merge-base probe.
 *
 * `protectedSha` is the in-flight ticket commit (current HEAD); `target` is the
 * reset destination. Equal/empty SHAs or a non-ancestor target → false (the
 * reset orphans nothing, so it may proceed). Callers that get true MUST preserve
 * HEAD instead of rewinding (no reset path rewinds off a commit that ff-descends
 * from HEAD).
 */
export function wouldResetOrphanCommit(input: {
  workingDir: string;
  target: string;
  protectedSha: string | null | undefined;
  log?: (msg: string) => void;
}): boolean {
  const { workingDir, target, protectedSha, log } = input;
  if (!protectedSha || !target || protectedSha === target) return false;
  // target is a strict ancestor of protectedSha ⇒ protectedSha ff-descends from
  // target ⇒ resetting HEAD back to target would strand the descendant work.
  const orphans = isHeadAtOrBelowCommit(target, protectedSha, workingDir);
  if (orphans) {
    log?.(`[reset-guard] reset to ${target} would orphan ff-descendant ${protectedSha} — preserving HEAD`);
  }
  return orphans;
}

/**
 * Returns dangling commit SHAs from `git fsck --no-reflogs --lost-found`.
 * Only chain tips are reported dangling (interior commits stay reachable from
 * the descendant that points at them). `--no-reflogs` is REQUIRED — without it a
 * reset-orphaned commit stays reflog-reachable and is never reported dangling.
 */
function resolveFsckDanglingTips(workingDir: string): string[] {
  const out = silentDeathGit(['fsck', '--no-reflogs', '--lost-found'], workingDir);
  if (!out) return [];
  return out.split('\n')
    .filter((l) => l.startsWith('dangling commit '))
    .map((l) => l.slice('dangling commit '.length).trim())
    .filter(Boolean);
}

/**
 * Resolve the TIP of the orphaned chain that `candidate` belongs to:
 *   - candidate is its own tip when no fsck tip has it as an ancestor (single-commit orphan)
 *   - exactly one dangling tip with `candidate` as an ancestor → that tip
 *   - >1 such tips → 'ambiguous' (operator must resolve; runner holds)
 */
function resolveChainTip(candidate: string, tips: string[], workingDir: string): string | 'ambiguous' {
  const matching = tips.filter((tip) => {
    if (tip === candidate) return true;
    const r = spawnSync('git', ['-C', workingDir, 'merge-base', '--is-ancestor', candidate, tip], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return r.status === 0;
  });
  if (matching.length === 0) return candidate; // single-commit orphan: candidate IS the tip
  if (matching.length === 1) return matching[0];
  return 'ambiguous'; // >1 tips contain candidate as ancestor → operator territory
}

/**
 * SHA precedence for orphan tip resolution:
 *   1. Explicit completionCommitSha (authoritative, never window/scope-filtered)
 *   2. `git fsck --no-reflogs` discovery scoped to the iteration window + allowed_paths
 *
 * Returns `{ sha, discovered }` or null when nothing recoverable is found.
 */
function resolveOrphanSha(input: {
  completionCommitSha: string | null;
  workingDir: string;
  sessionDir: string;
  iterationStartMs: number | null | undefined;
  log: (msg: string) => void;
}): { sha: string; discovered: boolean } | null {
  const { completionCommitSha, workingDir, sessionDir, iterationStartMs, log } = input;
  const SKEW_MS = 30_000; // ±30s clock-skew tolerance for fsck discovery

  // Priority 1: explicit SHA — never window/scope-filtered.
  if (completionCommitSha) return { sha: completionCommitSha, discovered: false };

  // Priority 2: fsck discovery — only when no explicit SHA.
  const tips = resolveFsckDanglingTips(workingDir);
  if (tips.length === 0) return null;

  const allowed = readScopeAllowedPaths(sessionDir);
  const nowMs = Date.now();

  const filtered = tips.filter((tip) => {
    // Window filter: commit timestamp within [iterationStartMs - skew, now + skew].
    if (iterationStartMs !== null && iterationStartMs !== undefined) {
      const epochSec = gitCommitEpoch(workingDir, tip);
      if (epochSec !== null) {
        const commitMs = epochSec * 1000;
        if (commitMs < iterationStartMs - SKEW_MS || commitMs > nowMs + SKEW_MS) {
          log(`[head-regression] fsck tip ${tip.slice(0, 8)} outside iteration window — skipping`);
          return false;
        }
      }
    }
    // Scope filter: touched paths ⊆ allowed_paths (unscoped session → all pass).
    if (allowed && allowed.length > 0) {
      const diff = silentDeathGit(['diff', '--name-only', `HEAD..${tip}`], workingDir);
      if (diff === null) return false;
      const touched = diff.split('\n').map((s) => s.trim()).filter(Boolean);
      if (touched.some((f) => !isWithinAllowedPaths(f, allowed))) {
        log(`[head-regression] fsck tip ${tip.slice(0, 8)} touches out-of-scope paths — skipping`);
        return false;
      }
    }
    return true;
  });

  if (filtered.length === 0) return null;
  if (filtered.length === 1) return { sha: filtered[0], discovered: true };

  // Multiple in-window tips: prefer the most recent commit time.
  const ranked = filtered
    .map((tip) => ({ tip, epoch: gitCommitEpoch(workingDir, tip) ?? 0 }))
    .sort((a, b) => b.epoch - a.epoch);
  log(`[head-regression] multiple fsck tips found, using most recent: ${ranked[0].tip.slice(0, 8)}`);
  return { sha: ranked[0].tip, discovered: true };
}

/**
 * e56ed23f: resolve an orphan SHA (explicit → fsck-discovered), walk to the
 * chain TIP, and `git merge --ff-only` HEAD up to it. Pure reattach — NEVER
 * resets or rewrites history; an ambiguous chain or a divergent HEAD (ff-only
 * refusal) returns `recovered: false` and the caller routes to the hold path.
 * `candidateSha` is the reattached tip on success, or the best-known unverified
 * candidate otherwise (drives the `orphan_commit_unreattachable` emit), `null`
 * when nothing was discoverable.
 */
function attemptOrphanChainReattach(input: {
  ticketId: string;
  workingDir: string;
  sessionDir: string;
  statePath: string;
  completionCommitSha: string | null;
  prevHead: string;
  iterationStartMs: number | null | undefined;
  log: (msg: string) => void;
}): { recovered: boolean; candidateSha: string | null } {
  const { ticketId, workingDir, sessionDir, statePath, completionCommitSha, prevHead, iterationStartMs, log } = input;
  const resolved = resolveOrphanSha({ completionCommitSha, workingDir, sessionDir, iterationStartMs, log });
  if (!resolved) return { recovered: false, candidateSha: null };

  const verifyR = spawnSync('git', ['-C', workingDir, 'cat-file', '-t', resolved.sha], { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (verifyR.status !== 0 || ((verifyR.stdout as string) || '').trim() !== 'commit') {
    log(`[head-regression] resolved orphan SHA ${resolved.sha.slice(0, 8)} not accessible as commit — holding`);
    return { recovered: false, candidateSha: resolved.sha };
  }

  // The candidate may be an interior commit of a multi-commit orphan chain;
  // resolve the descendant-most tip so ff-only lands HEAD at the chain TIP.
  const tip = resolveChainTip(resolved.sha, resolveFsckDanglingTips(workingDir), workingDir);
  if (tip === 'ambiguous') {
    log(`[head-regression] ambiguous orphan chain (multiple dangling tips contain ${resolved.sha.slice(0, 8)}) — holding for operator`);
    return { recovered: false, candidateSha: resolved.sha };
  }

  // Archive a dirty tree BEFORE ff-only (self-no-ops on a clean tree). ff-only
  // refuses a dirty tree, so a still-dirty tree after archive falls to the hold.
  archiveDirtyTreeBeforeFlip({ workingDir, sessionDir, ticketId, log });
  const statusR = spawnSync('git', ['-C', workingDir, 'status', '--porcelain'], { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (statusR.status === 0 && ((statusR.stdout as string) || '').trim().length > 0) {
    log(`[head-regression] working tree still dirty after archive — cannot ff-only to ${tip.slice(0, 8)}; holding`);
    return { recovered: false, candidateSha: tip };
  }

  const chainLenR = spawnSync('git', ['-C', workingDir, 'rev-list', '--count', `${prevHead}..${tip}`], { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  const chainLength = chainLenR.status === 0 ? (parseInt(((chainLenR.stdout as string) || '').trim(), 10) || 1) : 1;
  const mergeR = spawnSync('git', ['-C', workingDir, 'merge', '--ff-only', tip], { encoding: 'utf-8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (mergeR.status !== 0) {
    // ff-only refused → divergent HEAD. NEVER reset/rewrite — hold.
    log(`[head-regression] ff-only to ${tip.slice(0, 8)} failed (divergent HEAD): ${((mergeR.stderr as string) || '').trim()} — holding`);
    return { recovered: false, candidateSha: tip };
  }

  log(`[head-regression] ff-only reattach to chain tip ${tip.slice(0, 8)} succeeded (chain_length=${chainLength})`);
  try {
    const reattachPayload: OrphanReattachPayload = { ticket: ticketId, sha: tip, prev_head: prevHead, chain_length: chainLength, ts: new Date().toISOString() };
    writeActivityEntry(statePath, { event: 'orphan_commit_reattached', ...reattachPayload });
  } catch { /* best-effort telemetry */ }
  return { recovered: true, candidateSha: tip };
}

/**
 * R-CXOR-1 / e56ed23f: detect and recover from a worker HEAD regression.
 *
 * A codex worker may commit real work then `git reset --hard` to the pre-ticket
 * baseline on gate failure, leaving the ticket frontmatter Done but HEAD frozen.
 * This function detects that case and resolves the orphan chain TIP via:
 *   1. Ticket frontmatter completion_commit (authoritative, not window-filtered)
 *   2. `git fsck --no-reflogs` discovery scoped to the iteration window + allowed_paths
 * Then `git merge --ff-only` reattaches HEAD to the chain tip. On divergence or
 * ambiguity it emits `orphan_commit_unreattachable` and routes through the
 * 7eb9fa20 hold path (operator-hold) — it NEVER rewrites history (no `git reset`,
 * no `--force`). The hold path SUPPRESSES the Failed flip whenever there is
 * salvage evidence (fresh artifacts or a ticket-scoped commit) → `flip_suppressed`
 * / `suppression_cap_escalate`; only an evidence-absent, undiscoverable orphan
 * falls through to `marked_failed` (a non-destructive frontmatter write).
 * Success → `orphan_commit_reattached` with chain_length.
 * Divergent/ambiguous/undiscovered → `orphan_commit_unreattachable`, then hold.
 */
export function detectAndRecoverHeadRegression(input: {
  ticketId: string;
  workingDir: string;
  startCommit: string;
  completionCommitSha: string | null;
  sessionDir: string;
  statePath: string;
  iteration: number;
  /** 7eb9fa20: epoch ms when the iteration began — opens the artifact-evidence window for flip suppression. */
  iterationStartMs?: number | null;
  log: (msg: string) => void;
}): { detected: boolean; recovered: boolean; action: 'ff_reattached' | 'marked_failed' | 'flip_suppressed' | 'suppression_cap_escalate' | 'none' } {
  const { ticketId, workingDir, startCommit, completionCommitSha, sessionDir, statePath, iteration, log } = input;
  const currentHead = readHeadCommit(workingDir);
  if (!currentHead) return { detected: false, recovered: false, action: 'none' };
  if (!isHeadAtOrBelowCommit(currentHead, startCommit, workingDir)) {
    return { detected: false, recovered: false, action: 'none' };
  }

  log(`[head-regression] ticket ${ticketId} iter=${iteration}: HEAD=${currentHead} at/below start_commit=${startCommit}`);

  // The regressed HEAD before any recovery — base for chain_length and the
  // prev_head field of both orphan events.
  const prevHead = currentHead;

  let action: 'ff_reattached' | 'marked_failed' | 'flip_suppressed' | 'suppression_cap_escalate' = 'marked_failed';

  // --- e56ed23f: SHA precedence + chain-tip resolution + ff-only reattach ---
  const reattach = attemptOrphanChainReattach({ ticketId, workingDir, sessionDir, statePath, completionCommitSha, prevHead, iterationStartMs: input.iterationStartMs, log });
  const recovered = reattach.recovered;
  // Best-known SHA (reattached tip or unverifiable candidate) for telemetry.
  const candidateSha = reattach.candidateSha;
  if (recovered) action = 'ff_reattached';

  // Divergent / ambiguous / undiscovered non-reattach with a known candidate →
  // emit orphan_commit_unreattachable BEFORE routing to the hold path.
  if (!recovered && candidateSha) {
    try {
      writeActivityEntry(statePath, {
        event: 'orphan_commit_unreattachable',
        ts: new Date().toISOString(),
        ticket: ticketId,
        sha: candidateSha,
        prev_head: prevHead,
        reason: 'divergent_or_ambiguous',
      });
    } catch { /* best-effort telemetry */ }
  }

  if (!recovered) {
    // 7eb9fa20: evidence-backed flip-intents are suppressed (held) instead of
    // flipped — an unreattachable-but-real orphan commit is salvageable work,
    // not a failure. Evidence absent → archive a dirty tree, then flip.
    const decision = evaluateFailedFlipSuppression({
      sessionDir,
      statePath,
      ticketId,
      workingDir,
      iteration,
      callsite: 'head_regression',
      windowStartMs: input.iterationStartMs ?? null,
      windowEndMs: Date.now(),
      preSha: startCommit,
      log,
    });
    if (decision.action === 'suppress') {
      action = 'flip_suppressed';
      log(`[head-regression] ticket ${ticketId} Failed flip suppressed (${decision.evidence}) — status preserved, ticket held`);
    } else if (decision.action === 'escalate') {
      action = 'suppression_cap_escalate';
      log(`[head-regression] ticket ${ticketId} suppression cap ${decision.cap} reached — escalating to no-progress halt (no flip)`);
    } else {
      archiveDirtyTreeBeforeFlip({ workingDir, sessionDir, ticketId, log });
      try {
        updateTicketFrontmatter(ticketId, sessionDir, { status: 'Failed', completion_commit: null });
        log(`[head-regression] ticket ${ticketId} marked Failed — HEAD at baseline, orphan unrecoverable`);
      } catch (err) {
        log(`[head-regression] ticket Failed flip error: ${safeErrorMessage(err)}`);
      }
    }
  }

  try {
    writeActivityEntry(statePath, {
      event: 'worker_head_regression_detected',
      ts: new Date().toISOString(),
      ticket: ticketId,
      session: path.basename(sessionDir),
      gate_payload: {
        start_commit: startCommit,
        current_head_sha: currentHead,
        orphan_tip_sha: candidateSha ?? completionCommitSha,
        action,
      },
    });
  } catch { /* best-effort */ }

  return { detected: true, recovered, action };
}

/**
 * Ticket 7addedbf: classify one mux iteration into the closed `MUX_ITERATION_REASONS`
 * vocabulary. `action` is `outcome.completion`, a five-member union
 * (`task_completed | review_clean | continue | error | inactive`); the mapping is TOTAL
 * over it and over anything else, so the vocabulary cannot leak.
 *
 * `artifactDelta` is the worker's lifecycle-artifact count gained across the iteration
 * (the same before/after difference the production breadcrumb consumes). It is the
 * observable that identifies the DESIGNED worker handoff: the handoff is defined by the
 * next spawn resuming from the worker's on-disk artifacts, so the artifacts appearing IS
 * the disposition — not a proxy for it. `null` means no ticket was in flight (nothing to
 * hand off).
 *
 * Rule order matters. A commit is checked before the unproductive arms, so every
 * reachable `wasted: true` verdict has an unmoved (or unreadable) HEAD — the ticket's
 * invariant. Both SHAs must be non-null to claim `committed`: a failed HEAD read is not
 * evidence of a commit, so it falls through to the conservative arms.
 */
export function classifyMuxIteration(input: {
  action: string;
  preIterSha: string | null;
  postIterSha: string | null;
  artifactDelta: number | null;
}): { wasted: boolean; reason: MuxIterationReason } {
  // Legacy term, retained verbatim. Unreachable on the mux path (`outcome.completion`
  // has no 'revert' member) — kept so the vocabulary is complete and the prior
  // predicate is not silently dropped.
  if (input.action === 'revert') return { wasted: true, reason: 'revert' };

  const moved = input.preIterSha !== null
    && input.postIterSha !== null
    && input.preIterSha !== input.postIterSha;
  if (moved) return { wasted: false, reason: 'committed' };

  if (input.artifactDelta !== null && input.artifactDelta > 0) {
    return { wasted: false, reason: 'worker_handoff' };
  }

  if (input.action === 'task_completed' || input.action === 'review_clean') {
    return { wasted: false, reason: 'clean_pass' };
  }

  // 'continue' | 'error' | 'inactive', and any unmapped action — the conservative direction.
  return { wasted: true, reason: 'no_progress' };
}

export interface MuxWastedIterInput {
  sessionDir: string;
  iteration: number;
  action: string;
  preIterSha: string | null;
  postIterSha: string | null;
  artifactDelta: number | null;
}

export function emitMuxWastedIter(input: MuxWastedIterInput): void {
  const { wasted, reason } = classifyMuxIteration(input);
  logActivity({
    event: 'wasted_iter',
    source: 'pickle',
    session: path.basename(input.sessionDir),
    iteration: input.iteration,
    runner: 'mux',
    action: input.action,
    wasted,
    reason,
    pre_iter_sha: input.preIterSha,
    post_iter_sha: input.postIterSha,
  });
}

/**
 * Ticket 2ed9a852 (C1): the main loop's `wasted_iter` emit sits ~460 lines below the
 * `runIteration` call, and six post-iteration `continue` statements exit ahead of it —
 * the done-guard, the recovery-ladder advance, the two ladder-exhaustion advances, the
 * suppressed Failed flip, and the terminal no-progress flip. Every one of them is reached
 * only through the zero-artifact-delta bookkeeping, so the iterations that went unemitted
 * were exactly the ones the classifier scores `no_progress`. The population the rate is
 * read over excluded the cases it exists to measure, and the reported waste rate was
 * biased low.
 *
 * The emit predates all six early exits by five to eight weeks (`ff7ebdbc` 2026-05-03 vs
 * `33a9c08a` 2026-06-12 / `f2e795e6` 2026-06-30): the recovery work inserted exits above a
 * call site it had no reason to look at. So the fix is not "remember to emit" — it is a
 * thunk each exit calls, which emits at most once per binding. A seventh early exit that
 * forgets the call is caught by the source-parity assertion in
 * `tests/wasted-iter-classification.test.js`; a seventh that calls it twice is caught here.
 *
 * `buildInput` is a thunk, not a value: `postIterSha` must be read at emit time. The
 * fall-through path emits after the ticket-boundary block, where a salvage commit may have
 * landed, and that commit belongs to the iteration that produced it.
 */
export function createWastedIterEmitter(buildInput: () => MuxWastedIterInput): () => void {
  let emitted = false;
  return () => {
    if (emitted) return;
    emitted = true;
    emitMuxWastedIter(buildInput());
  };
}

function gitCommitEpoch(workingDir: string, sha: string | null): number | null {
  if (!sha) return null;
  try {
    const raw = execFileSync('git', ['-C', workingDir, 'show', '-s', '--format=%ct', sha], {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function validateAutoTicketCompletion(
  sessionDir: string,
  ticketId: string,
  workingDir: string,
  startCommit: string | null
): AutoTicketCompletionValidation {
  const filePath = ticketFilePath(sessionDir, ticketId);
  try {
    if (isTerminalTicketStatus(getTicketStatus(sessionDir, ticketId))) return { action: 'leave', reason: 'ticket_already_terminal' };
  } catch {
    return { action: 'leave', reason: 'malformed_or_missing_ticket_frontmatter' };
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { action: 'leave', reason: 'ticket_file_unreadable' };
  }

  if (!hasCheckedAcceptanceCriteria(content)) {
    return { action: 'skip', reason: 'acceptance_criteria_not_checked' };
  }
  // B-1SEAM WS-1: the ONE completion predicate replaces the bare readEvidence
  // call — this site now gets baseline rejection (R-CXOR-2), the R-AICF
  // unreachable-explicit scan fallback, and announcement recovery for free.
  // decision:'attribution' — the R-CWGE verdict stays with the guard at the
  // applyAutoTicketCompletionValidation callsite (unchanged double-check).
  const decision = evaluateCompletionEvidence(buildCompletionCtx({
    sessionDir,
    ticketId,
    workingDir,
    startTimeEpoch: gitCommitEpoch(workingDir, startCommit),
    rereadBackoffMs: 0,
  }, 'attribution'));
  if (!decision.ok) {
    return { action: 'skip', reason: 'no_commit_referencing_ticket_since_current_set' };
  }

  return { action: 'done', reason: 'commit_and_acceptance_checked' };
}

export interface ApplyAutoTicketCompletionInput {
  sessionDir: string;
  ticketId: string;
  workingDir: string;
  startCommit: string | null;
  iteration: number;
  log?: (msg: string) => void;
  statePath: string;
  flags: Record<string, unknown> | null;
}

export function applyAutoTicketCompletionValidation(input: ApplyAutoTicketCompletionInput): AutoTicketCompletionValidation {
  const verdict = validateAutoTicketCompletion(input.sessionDir, input.ticketId, input.workingDir, input.startCommit);
  if (verdict.action === 'done') {
    // R-CCRC-2: route Done-flip through guard so the R-WUWC SOFT-variant
    // auto-fill runs and completion_commit is persisted to the frontmatter.
    // Manager drift path: ticket starts 'In Progress', so the guard's inline
    // upsert (which requires status=Done) cannot run yet; the guard's
    // committed-evidence auto-promote attributes the durable boundary commit
    // (B-DURA T10) and the post-markTicketDone upsert runs below.
    const guard = guardCompletionCommitBeforeDone({
      sessionDir: input.sessionDir,
      ticketId: input.ticketId,
      workingDir: input.workingDir,
      flags: input.flags ?? {},
    });
    if (!guard.ok) {
      const msg = `[fatal] ${new Date().toISOString()} ${guard.reason}`;
      input.log?.(msg);
      process.stderr.write(`${msg}\n`);
      // B-GTRUTH WS-A2 / ticket 96444430: done_without_commit_evidence is a
      // per-ticket verdict, not a session halt — record the residual and let
      // the caller park this ticket and continue the phase loop. Do NOT
      // safeDeactivate here (single caller — see mux-runner.ts main loop).
      recordExitReason(input.statePath, 'done_without_commit_evidence');
      return { action: 'leave', reason: 'guard_failed_no_commit_evidence' };
    }
    // R-PEDC: clear any stale done_without_commit_evidence before marking Done.
    clearStaleDoneWithoutCommitEvidence(input.statePath);
    if (markTicketDone(input.sessionDir, input.ticketId)) {
      input.log?.(`Marked ticket ${input.ticketId} as Done (validated: evidence found, completion_commit: ${formatCompletionCommitForLog(guard.sha)})`);
    }
    // R-WUWC SOFT-variant (manager path): ticket was 'In Progress' at guard
    // time so the inline upsert inside guardCompletionCommitBeforeDone couldn't
    // write completion_commit (requires status=Done).
    // Now that markTicketDone has flipped the status, persist the SHA.
    // Best-effort: failure must not block the Done flip.
    try {
      const _fp = ticketFilePath(input.sessionDir, input.ticketId);
      const _raw = fs.readFileSync(_fp, 'utf8');
      if (!readFrontmatterField(_raw, 'completion_commit') && guard.sha) {
        const _upd = upsertFrontmatterField(_raw, 'completion_commit', guard.sha);
        if (_upd) fs.writeFileSync(_fp, _upd);
      }
    } catch { /* best-effort */ }
    return verdict;
  }
  if (verdict.action === 'skip') {
    if (markTicketSkipped(input.sessionDir, input.ticketId)) {
      input.log?.(`Marked ticket ${input.ticketId} as Skipped (${verdict.reason})`);
      logActivity({
        event: 'ticket_auto_skip_no_evidence',
        source: 'pickle',
        session: path.basename(input.sessionDir),
        ticket: input.ticketId,
        iteration: input.iteration,
        reason: verdict.reason,
      });
    }
    return verdict;
  }
  input.log?.(`Warning: leaving ticket ${input.ticketId} unchanged (${verdict.reason})`);
  return verdict;
}

/**
 * Reads `pickle_settings.json` as an untyped bag, returning `{}` on any
 * read/parse failure. Emits a labeled stderr breadcrumb keyed by the caller
 * site so a missing/corrupt settings file never silently yields defaults.
 * Every call site in this module consumes its own subset of keys with its
 * own defaults; this helper owns only the file I/O + JSON decode step.
 */
function loadSettingsBag(extensionRoot: string, site: string): Record<string, unknown> {
  const settingsPath = path.join(extensionRoot, 'pickle_settings.json');
  const raw = readRecoverableJsonObject(settingsPath);
  if (raw) return raw as Record<string, unknown>;
  if (!fs.existsSync(settingsPath)) return {};
  try {
    fs.readFileSync(settingsPath, 'utf-8');
  } catch (err) {
    process.stderr.write(`[${site}] ${safeErrorMessage(err)}\n`);
  }
  return {};
}

function positiveIntegerOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function loadRateLimitSettings(extensionRoot: string): { waitMinutes: number; maxRetries: number } {
  let waitMinutes = 5;
  let maxRetries = 3;
  const raw = loadSettingsBag(extensionRoot, 'mux-runner:load-rate-limit-settings');
  const rawWait = raw.default_rate_limit_wait_minutes;
  if (typeof rawWait === 'number' && rawWait >= 1) waitMinutes = rawWait;
  const rawRetries = raw.default_max_rate_limit_retries;
  if (typeof rawRetries === 'number' && rawRetries >= 1) maxRetries = rawRetries;
  return { waitMinutes, maxRetries };
}

export function detectRateLimitInLog(logFile: string): RateLimitInfo {
  const result: RateLimitInfo = { limited: false, sawEvents: false };
  try {
    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.split('\n');
    const tail = lines.slice(-100);
    for (const line of tail) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type !== 'rate_limit_event') continue;
        result.sawEvents = true;
        // Real API nests under rate_limit_info; check both paths for robustness
        const info = parsed.rate_limit_info ?? parsed;
        const status = info.status;
        if (status === 'rejected') {
          result.limited = true;
          if (typeof info.resetsAt === 'number') result.resetsAt = info.resetsAt;
          if (typeof info.rateLimitType === 'string') result.rateLimitType = info.rateLimitType;
        }
      } catch { /* not JSON */ }
    }
  } catch { /* file missing */ }
  return result;
}

export function detectRateLimitInText(logFile: string): boolean {
  try {
    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.split('\n');
    // Only check the very tail — rate limit messages appear at the end when
    // the process is killed. 20 lines is plenty; 100 was catching assistant
    // text *about* rate limits as false positives.
    const tail = lines.slice(-20);
    // Filter out JSON content fields (assistant text, user messages, tool results)
    // to avoid matching on *discussion about* rate limits
    const filtered = tail.filter(l =>
      !l.includes('"type":"user"') &&
      !l.includes('"type":"tool_result"') &&
      !l.includes('"type":"assistant"') &&
      !l.includes('"type":"text"') &&
      !l.includes('"content":[') &&
      !l.includes('"content":"')
    );
    const text = filtered.join('\n');
    // Tightened patterns — require more specific phrasing to avoid matching
    // code comments or discussions about rate limiting
    const patterns = [
      /your .* usage limit has been reached/i,
      /usage is limited.*try again/i,
      /out of (extra )?usage/i,
      /rate limited.*try again/i,
    ];
    return patterns.some(p => p.test(text));
  } catch { /* file missing */ }
  return false;
}

function readLastResultEventFromLog(logFile: string): Record<string, unknown> | null {
  let content: string;
  try {
    content = fs.readFileSync(logFile, 'utf-8');
  } catch {
    return null;
  }
  const lines = content.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line || !line.startsWith('{')) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return null; }
    if (!parsed || typeof parsed !== 'object') continue;
    const ev = parsed as Record<string, unknown>;
    if (ev.type === 'result') return ev;
  }
  return null;
}

/**
 * R-PPXR AC-PPXR-2: distinguishes a manager turn CUT OFF mid-tool-result (relaunchable) from a genuine
 * spawn failure (fatal). A cut-off turn started working — the iteration log carries at least one JSON
 * stream event (e.g. `system`/`task_started`/`user`) — but produced NO terminal `result` event. A spawn
 * failure (`proc.on('error')`, e.g. ENOENT) leaves the iteration log empty/unreadable, so this returns
 * false and the suppressor stays fatal. Confirmed against the B-GA cut-off logs in
 * tests/fixtures/ppxr-rootcause.md (cut-off iterations had stream events, 0 `result` events).
 */
function managerTurnStartedWithoutResult(logFile: string): boolean {
  let content: string;
  try {
    content = fs.readFileSync(logFile, 'utf-8');
  } catch {
    return false;
  }
  let sawStreamEvent = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !line.startsWith('{')) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== 'object') continue;
    const ev = parsed as Record<string, unknown>;
    if (ev.type === 'result') return false; // a terminal result means it was NOT cut off
    sawStreamEvent = true;
  }
  return sawStreamEvent;
}

export function detectManagerMaxTurnsExit(managerResult: IterationOutcome, logFile: string, maxTurns: number | null): boolean {
  if (managerResult.completion !== 'error') return false;
  if (managerResult.timedOut || managerResult.exitCode !== 0) {
    return false;
  }
  if (!Number.isFinite(maxTurns) || maxTurns === null || maxTurns <= 0) return false;
  const event = readLastResultEventFromLog(logFile);
  if (!event) return false;
  if (event.stop_reason !== 'end_turn') return false;
  if (event.terminal_reason !== 'completed') return false;
  if (event.is_error !== false) return false;
  const eventTurns = typeof event.num_turns === 'number'
    ? event.num_turns
    : (typeof event.turn_count === 'number' ? event.turn_count : null);
  if (!Number.isFinite(eventTurns) || eventTurns === null) return false;
  return eventTurns >= maxTurns;
}

export function detectManagerInactiveExit(outcome: IterationOutcome | undefined): boolean {
  return (
    outcome !== undefined &&
    outcome.completion === 'inactive' &&
    outcome.timedOut === false &&
    outcome.exitCode === null
  );
}

function emitMaxTurnsClassifiedEvent(
  sessionDir: string,
  iterationNum: number,
  logFile: string,
  maxTurns: number | null,
  wallSeconds: number,
): void {
  const resultEvent = readLastResultEventFromLog(logFile);
  const numTurns: number =
    (typeof resultEvent?.num_turns === 'number' ? resultEvent.num_turns
      : typeof resultEvent?.turn_count === 'number' ? resultEvent.turn_count
      : maxTurns) ?? 0;
  logActivity({
    event: 'iteration_classified_at_max_turns',
    source: 'pickle',
    session: path.basename(sessionDir),
    iteration_num: iterationNum,
    num_turns: numTurns,
    max_turns: maxTurns ?? 0,
    wall_seconds: wallSeconds,
  });
}

export function classifyManagerRelaunchExit(
  state: State,
  outcome: IterationOutcome | undefined,
  logFile: string,
  maxTurns: number | null,
): ManagerRelaunchExitKind {
  const backend = resolveBackend(state);
  if (backend === 'claude' && outcome && detectManagerMaxTurnsExit(outcome, logFile, maxTurns)) {
    return 'claude_max_turns';
  }
  if (backend === 'codex' && outcome?.timedOut === true) {
    return 'codex_4h_hang_guard';
  }
  if (backend === 'codex' && detectManagerInactiveExit(outcome)) {
    return 'codex_session_inactive';
  }
  return 'other_error';
}

export function classifyIterationExit(
  completionResult: string,
  logFile: string,
  timing?: { didTimeout: boolean; exitCode: number | null; wallSeconds: number },
): IterationExitResult {
  if (completionResult === 'inactive') return { type: 'inactive' };
  if (completionResult === 'error') return { type: 'error' };
  if (completionResult === 'task_completed' || completionResult === 'review_clean') return { type: 'success' };
  const rlInfo = detectRateLimitInLog(logFile);
  if (rlInfo.limited) return { type: 'api_limit', rateLimitInfo: rlInfo };
  // Only fall back to text detection if we found NO structured rate_limit_event
  // entries at all. If structured events exist but none say 'rejected', trust
  // that — don't let fuzzy text matching override structured signals.
  if (!rlInfo.sawEvents && detectRateLimitInText(logFile)) return { type: 'api_limit' };
  if (timing?.didTimeout) {
    return { type: 'timeout', exitCode: timing.exitCode, wallSeconds: timing.wallSeconds };
  }
  return { type: 'success' };
}

/** Buffer (ms) added past `reset_at` before probing for a healthy resume. */
const RATE_LIMIT_RESET_BUFFER_MS = 30_000;
/** Resume-jitter bounds (ms) past `reset_at` — avoids thundering-herd reconnects. */
export const PARK_RESUME_JITTER_MIN_MS = 60_000;
export const PARK_RESUME_JITTER_MAX_MS = 120_000;

/**
 * Pure decision function: given rate limit context, returns the park/wait/bail
 * decision. Extracted from main() for testability. No side effects.
 *
 * Ticket e9bdac75 (Workstream B): the old `3×` config cap is GONE. When the API
 * provides `reset_at`, the full reset window is honored (clamped only to
 * `maxParkMinutes`) — a 5h reset now parks ≈5h instead of spawn-burning into the
 * wall under a 15-min ceiling. Park is encoded as `action: 'wait'` with
 * `waitSource: 'api'` (schema-neutral: no new action/exit_reason). When no
 * `reset_at` is present, we fall back to `now + configured_min_wait` and never
 * spawn-burn; we bail only when blind AND retries are exhausted.
 */
export function computeRateLimitAction(
  exitResult: IterationExitResult,
  consecutiveRateLimits: number,
  maxRetries: number,
  configWaitMinutes: number,
  maxParkMinutes: number = DEFAULT_MAX_PARK_MINUTES,
): RateLimitAction {
  const configWaitMs = configWaitMinutes * 60 * 1000;
  const maxParkMs = maxParkMinutes * 60 * 1000;
  let waitMs = configWaitMs;
  let waitSource: 'api' | 'config' = 'config';
  let parkUntilEpochMs: number | undefined;
  let resetAtEpochSec: number | null = null;
  const rlResetsAt = exitResult.type === 'api_limit' ? exitResult.rateLimitInfo?.resetsAt : undefined;
  const hasResetsAt = typeof rlResetsAt === 'number' && rlResetsAt > 0;

  if (hasResetsAt) {
    const apiWaitMs = (rlResetsAt * 1000) - Date.now();
    if (apiWaitMs > 0) {
      // Honor the FULL reset window, clamped only to the park ceiling. No 3× cap.
      waitMs = Math.min(apiWaitMs + RATE_LIMIT_RESET_BUFFER_MS, maxParkMs);
      waitSource = 'api';
      resetAtEpochSec = rlResetsAt;
      parkUntilEpochMs = Date.now() + waitMs;
    }
    // apiWaitMs <= 0 → resetsAt in the past, fall back to config default.
  }

  // Bail only when blind (no resetsAt) AND retries exhausted.
  if (!hasResetsAt && consecutiveRateLimits >= maxRetries) {
    return { action: 'bail', waitMs: 0, waitSource: 'config', resetCounter: false, hasResetsAt };
  }

  return {
    action: 'wait',
    waitMs,
    waitSource,
    resetCounter: waitSource === 'api',
    hasResetsAt,
    parkUntilEpochMs,
    resetAtEpochSec,
  };
}

/**
 * Pure: resolve the wake target for a parked rate-limit episode (ticket e9bdac75).
 * Resume at `max(reset_at + jitter, now + min_wait)` so we never probe before the
 * API window closes, and never sooner than the configured minimum wait. `jitterMs`
 * is injected (60–120s in production) to keep the decision deterministic in tests.
 */
export function resolveParkResumeTime(
  resetAtEpochSec: number | null,
  nowMs: number,
  minWaitMs: number,
  jitterMs: number,
): number {
  const minTarget = nowMs + minWaitMs;
  if (resetAtEpochSec === null || resetAtEpochSec <= 0) return minTarget;
  const resetTarget = resetAtEpochSec * 1000 + jitterMs;
  return Math.max(resetTarget, minTarget);
}

/** Pure: jitter draw in [PARK_RESUME_JITTER_MIN_MS, PARK_RESUME_JITTER_MAX_MS]. */
export function drawParkResumeJitterMs(rand: () => number = Math.random): number {
  const span = PARK_RESUME_JITTER_MAX_MS - PARK_RESUME_JITTER_MIN_MS;
  return PARK_RESUME_JITTER_MIN_MS + Math.floor(rand() * (span + 1));
}

/** Pure: cumulative parked wall-clock exceeds the max-park ceiling (ticket e9bdac75, B5). */
export function isParkExhausted(cumulativeParkedMs: number, maxParkMinutes: number): boolean {
  return cumulativeParkedMs > maxParkMinutes * 60 * 1000;
}

/**
 * Pure: fold a completed park into the episode ledger (ticket e9bdac75, B5).
 *
 * `cumulative_parked_ms` is the term `isParkExhausted` weighs against the
 * `max_park_minutes` ceiling, so a resume MUST add the wall it just burned.
 * Discarding the arm here made the ceiling UNREACHABLE: `computeRateLimitAction`
 * already clamps a single wait to `maxParkMs`, so with the accumulator pinned at
 * 0 the predicate reduces to `waitMs > maxParkMs` — never true. Parked wall is
 * also excluded from `max_time_minutes` (B3), so nothing else bounded the loop.
 *
 * `reset_at_epoch_sec` drops to null because the window has been consumed — a
 * persisted FUTURE reset_at is exactly what re-arms a park on `--resume`, and
 * keeping a spent one would re-park a healthy relaunch.
 */
export function foldParkIntoEpisode(
  priorPark: RateLimitPark | null,
  parkedMs: number,
  consecutiveWaits: number,
  nowMs: number,
): RateLimitPark {
  return {
    reset_at_epoch_sec: null,
    parked_started_epoch_ms: priorPark?.parked_started_epoch_ms ?? nowMs,
    cumulative_parked_ms: (priorPark?.cumulative_parked_ms ?? 0) + Math.max(0, parkedMs),
    consecutive_waits: consecutiveWaits,
  };
}

/** The park-entry verdict shared by the two rate-limit cycle callers. */
type RateLimitCycleDecision =
  | { kind: 'bail'; rlAction: RateLimitAction }
  | { kind: 'park_exhausted'; rlAction: RateLimitAction; priorPark: RateLimitPark | null }
  | { kind: 'park'; rlAction: RateLimitAction; priorPark: RateLimitPark | null };

/**
 * Pure: decide whether a rate-limited iteration bails, trips the cumulative park
 * ceiling, or parks.
 *
 * `processRateLimitCycle` and the inline cycle in `runMuxRunnerMain` each
 * re-derived this sequence, and a divergence in exactly this area is how the B5
 * ceiling ended up fixed in one copy and broken in the other. The verdict now has
 * one home; each caller keeps its own logging, exit-reason recording and
 * deactivation policy.
 *
 * `readPriorPark` is a thunk, not a value: a bail never reached the persisted park
 * record, so each caller passes its own state accessor and it stays unread on that
 * path.
 */
function decideRateLimitCycle(
  exitResult: IterationExitResult,
  consecutiveRateLimits: number,
  maxRetries: number,
  configWaitMinutes: number,
  maxParkMinutes: number,
  readPriorPark: () => RateLimitPark | null,
): RateLimitCycleDecision {
  const rlAction = computeRateLimitAction(exitResult, consecutiveRateLimits, maxRetries, configWaitMinutes, maxParkMinutes);
  if (rlAction.action === 'bail') return { kind: 'bail', rlAction };
  const priorPark = readPriorPark();
  const priorCumulativeMs = priorPark?.cumulative_parked_ms ?? 0;
  if (isParkExhausted(priorCumulativeMs + rlAction.waitMs, maxParkMinutes)) {
    return { kind: 'park_exhausted', rlAction, priorPark };
  }
  return { kind: 'park', rlAction, priorPark };
}

interface IterationPromptContext {
  handoffText?: string;
  iterationSummary?: string;
  taskNotes?: string;
}

interface PreparedIterationRun {
  backend: Backend;
  env: NodeJS.ProcessEnv;
  exitDrainFallbackMs: number;
  invocation: ReturnType<typeof buildManagerInvocation>;
  logFile: string;
  maxTurns: number;
  state: State;
  statePath: string;
}

function readIterationStateOrThrow(sessionDir: string, iterationNum: number): { state: State; statePath: string } {
  const statePath = path.join(sessionDir, 'state.json');
  try {
    return { state: readRunnerState(statePath), statePath };
  } catch (err) {
    const msg = safeErrorMessage(err);
    throw new Error(`Failed to read state.json for iteration ${iterationNum}: ${msg}`);
  }
}

function resolveIterationPromptPath(extensionRoot: string, templateName: string): string {
  if (templateName.includes('/') || templateName.includes('\\') || templateName.includes('..')) {
    throw new Error(`Invalid command_template in state.json: "${templateName}" — must be a plain filename`);
  }
  const templatesDir = path.join(extensionRoot, 'templates');
  const commandsDir = path.join(os.homedir(), '.claude/commands');
  const promptPath = fs.existsSync(path.join(templatesDir, templateName))
    ? path.join(templatesDir, templateName)
    : path.join(commandsDir, templateName);
  if (!fs.existsSync(promptPath)) {
    throw new Error(`${templateName} not found in ${templatesDir} or ${commandsDir}. Run install.sh first.`);
  }
  return promptPath;
}

function consumeIterationHandoff(
  state: State,
  sessionDir: string,
  iterationNum: number,
): Pick<IterationPromptContext, 'handoffText' | 'iterationSummary'> {
  const handoffPath = path.join(sessionDir, 'handoff.txt');
  if (!fs.existsSync(handoffPath)) {
    return { iterationSummary: buildIterationHandoffSummary(state, sessionDir, iterationNum) };
  }
  const handoffText = fs.readFileSync(handoffPath, 'utf-8');
  try { fs.unlinkSync(handoffPath); } catch (unlinkErr) {
    const code = (unlinkErr as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'ENOENT') {
      console.warn(`[mux-runner] WARNING: Cannot remove handoff.txt (${code})`);
    }
  }
  return { handoffText };
}

function readIterationTaskNotes(sessionDir: string, enabled: boolean): string | undefined {
  if (!enabled) return undefined;
  const taskNotesPath = path.join(sessionDir, 'TASK_NOTES.md');
  try {
    if (!fs.existsSync(taskNotesPath)) return undefined;
    const raw = fs.readFileSync(taskNotesPath, 'utf-8');
    const truncated = truncateTaskNotes(raw);
    return truncated.trim() ? truncated : undefined;
  } catch (readErr) {
    const msg = readErr instanceof Error ? readErr.message : String(readErr);
    console.warn(`[mux-runner] WARNING: task notes subsystem failed: ${msg}`);
    return undefined;
  }
}

function buildIterationPromptContext(
  state: State,
  sessionDir: string,
  iterationNum: number,
  extensionRoot: string,
): { promptContext: IterationPromptContext; promptPath: string; settings: Record<string, unknown> } {
  const templateName = resolveCommandTemplate(state.command_template);
  const promptPath = resolveIterationPromptPath(extensionRoot, templateName);
  const settings = loadSettingsBag(extensionRoot, 'mux-runner:run-iteration:settings');
  return {
    promptContext: {
      ...consumeIterationHandoff(state, sessionDir, iterationNum),
      taskNotes: readIterationTaskNotes(sessionDir, settings.enable_task_notes !== false),
    },
    promptPath,
    settings,
  };
}

/**
 * Builds the manager iteration subprocess env, including the `core.hooksPath` +
 * `PICKLE_TICKET_ID` trailer-hooks fragment (B-GITATTR WS-1, ticket cb36a189) keyed off
 * `state.current_ticket`. Exported so tests can assert on the real construction path
 * without spawning a process.
 */
export function createIterationSpawnEnv(
  state: State,
  backend: Backend,
  invocation: ReturnType<typeof buildManagerInvocation>,
  statePath: string,
  runtimeOverrides: IterationRuntimeOverrides,
  sessionDir: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...runtimeOverrides.envOverrides,
    ...backendEnvOverrides(backend, { workingDir: state.working_dir || process.cwd(), ticketId: state.current_ticket, sessionDir }),
    ...(invocation.env ?? {}),
    ...sessionStampEnv(path.basename(sessionDir), state.working_dir || process.cwd()),
    PICKLE_STATE_FILE: statePath,
    PYTHONUNBUFFERED: '1',
  };
  delete env['CLAUDECODE'];
  delete env['PICKLE_ROLE'];
  return env;
}

function prepareIterationRun(
  sessionDir: string,
  iterationNum: number,
  extensionRoot: string,
  qualityPassModel: string,
  runtimeOverrides: IterationRuntimeOverrides,
): PreparedIterationRun | { completion: 'inactive'; timedOut: false; exitCode: null; wallSeconds: 0 } {
  const { state, statePath } = readIterationStateOrThrow(sessionDir, iterationNum);
  if (state.active !== true) return { completion: 'inactive', timedOut: false, exitCode: null, wallSeconds: 0 };
  const { promptContext, promptPath, settings } = buildIterationPromptContext(state, sessionDir, iterationNum, extensionRoot);
  const backend = resolveBackend(state);
  const templateName = resolveCommandTemplate(state.command_template);
  const managerPrompt = composeManagerPromptFromSkill(promptPath, backend, {
    argumentSubstitution: `--resume ${sessionDir}`,
    ...promptContext,
  });
  if (backend === 'codex') process.env.PICKLE_PARENT_SESSION_HASH = path.basename(sessionDir);
  const maxTurns = positiveIntegerOrNull(settings.default_tmux_max_turns)
    ?? positiveIntegerOrNull(settings.default_manager_max_turns)
    ?? Defaults.MANAGER_MAX_TURNS;
  const iterationModel = templateName === 'szechuan-sauce.md' && qualityPassModel && backend === 'claude'
    ? qualityPassModel
    : undefined;
  const codexManagerModel = backend === 'codex' ? resolveCodexModel(extensionRoot, state) : undefined;
  const invocation = buildManagerInvocation(backend, {
    prompt: managerPrompt,
    addDirs: [extensionRoot, getDataRoot(), sessionDir],
    model: backend === 'hermes' ? state.hermes_model : (backend === 'codex' ? codexManagerModel : iterationModel),
    maxTurns: backend === 'hermes' ? positiveIntegerOrNull(state.hermes_max_turns) ?? maxTurns : maxTurns,
    streamJson: true,
    noSessionPersistence: true,
    toolsets: backend === 'hermes' ? state.hermes_toolsets : undefined,
    provider: backend === 'hermes' ? state.hermes_provider : undefined,
  });
  const env = createIterationSpawnEnv(state, backend, invocation, statePath, runtimeOverrides, sessionDir);
  return {
    backend,
    env,
    exitDrainFallbackMs: resolveExitDrainFallbackMs(env),
    invocation,
    logFile: path.join(sessionDir, `tmux_iteration_${iterationNum}.log`),
    maxTurns,
    state,
    statePath,
  };
}

class IterationProcessController {
  private currentChild: import('child_process').ChildProcess | null = null;
  private didTimeout = false;
  private heartbeat: NodeJS.Timeout | null = null;
  private lastDataAt: number;
  private logFd = -1;
  private outputStallGuard: NodeJS.Timeout | null = null;
  private resolveOutcome: (outcome: IterationOutcome) => void = () => undefined;
  private settled = false;
  private stallReason: IterationOutcome['stallReason'];
  private timeoutAwaitingDrain = false;
  private timeoutChildClosed = false;
  private timeoutDrainTimer: NodeJS.Timeout | null = null;
  private timeoutEarliestFinishAt = 0;
  private timeoutResolutionFinished = false;
  private timeoutResolveTimer: NodeJS.Timeout | null = null;
  private timeoutStderrClosed = false;
  private timeoutStdoutClosed = false;

  constructor(
    private readonly sessionDir: string,
    private readonly iterationNum: number,
    private readonly prepared: PreparedIterationRun,
    private readonly runtimeOverrides: IterationRuntimeOverrides,
    private readonly start = Date.now(),
    private readonly hangGuardMs = (runtimeOverrides.maxIterationSeconds ?? Defaults.MAX_ITERATION_SECONDS) * 1000,
    private readonly outputStallGuardMs = (runtimeOverrides.outputStallSeconds ?? Defaults.OUTPUT_STALL_SECONDS) * 1000,
    private readonly hangGuard = setTimeout(() => {
      this.resolveTimeout('wall_clock');
    }, (runtimeOverrides.maxIterationSeconds ?? Defaults.MAX_ITERATION_SECONDS) * 1000),
  ) {
    this.lastDataAt = this.start;
    this.hangGuard.unref();
  }

  run(): Promise<IterationOutcome> {
    this.logFd = fs.openSync(this.prepared.logFile, 'w');
    return new Promise((resolve) => {
      this.resolveOutcome = resolve;
      const proc = this.spawnManagerProcess();
      this.currentChild = proc;
      this.timeoutStdoutClosed = proc.stdout === null;
      this.timeoutStderrClosed = proc.stderr === null;
      this.armOutputStallGuard();
      this.startHeartbeat();
      this.attachStreamHandlers(proc);
      this.attachLifecycleHandlers(proc);
    });
  }

  private spawnManagerProcess(): import('child_process').ChildProcess {
    const proc = spawn(this.prepared.invocation.cmd, this.prepared.invocation.args, {
      cwd: this.prepared.state.working_dir || process.cwd(),
      env: this.prepared.env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    currentChildProc = proc;
    if (proc.pid != null) {
      try { writeActivePidFile(this.sessionDir, proc.pid); } catch { /* best effort */ }
    }
    return proc;
  }

  private startHeartbeat(): void {
    let heartbeatLastSeenMtimeMs = 0;
    this.heartbeat = setInterval(() => {
      try {
        heartbeatLastSeenMtimeMs = maybeEmitManagerTurnProgress({
          sessionDir: this.sessionDir,
          statePath: this.prepared.statePath,
          ticketId: this.prepared.state.current_ticket,
          lastSeenMtimeMs: heartbeatLastSeenMtimeMs,
        });
      } catch { /* best effort — never crash the manager turn */ }
    }, MANAGER_TURN_HEARTBEAT_POLL_MS);
    this.heartbeat.unref();
  }

  private attachStreamHandlers(proc: import('child_process').ChildProcess): void {
    const handleData = (chunk: Buffer) => {
      this.lastDataAt = Date.now();
      this.armOutputStallGuard();
      this.writeToLog(chunk);
      process.stderr.write(chunk);
    };
    proc.stdout?.on('data', handleData);
    proc.stderr?.on('data', handleData);
    proc.stdout?.once('close', () => {
      this.timeoutStdoutClosed = true;
      this.scheduleTimeoutResolutionFinish();
    });
    proc.stderr?.once('close', () => {
      this.timeoutStderrClosed = true;
      this.scheduleTimeoutResolutionFinish();
    });
  }

  private attachLifecycleHandlers(proc: import('child_process').ChildProcess): void {
    proc.on('close', (code) => this.finalizeOnChildEnd(code));
    proc.on('exit', (code) => {
      if (this.settled) return;
      const drainTimer = setTimeout(() => {
        if (this.settled) return;
        this.finalizeOnChildEnd(code ?? null);
      }, this.prepared.exitDrainFallbackMs);
      drainTimer.unref();
    });
    proc.on('error', (err) => {
      if (this.settled) return;
      this.settled = true;
      currentChildProc = null;
      this.currentChild = null;
      this.clearIterationGuards();
      console.error(`${Style.RED}Failed to spawn ${this.prepared.invocation.cmd}: ${safeErrorMessage(err)}${Style.RESET}`);
      this.closeLogFd();
      this.resolveOutcome({ completion: 'error', timedOut: false, exitCode: null, wallSeconds: (Date.now() - this.start) / 1000 });
    });
  }

  private writeToLog(chunk: Buffer): void {
    try { fs.writeSync(this.logFd, chunk); } catch { /* fd closed — ignore late writes */ }
  }

  private clearIterationGuards(): void {
    clearTimeout(this.hangGuard);
    if (this.outputStallGuard) {
      clearTimeout(this.outputStallGuard);
      this.outputStallGuard = null;
    }
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private armOutputStallGuard(): void {
    if (this.settled) return;
    if (this.outputStallGuard) clearTimeout(this.outputStallGuard);
    const remainingMs = Math.max(1, (this.lastDataAt + this.outputStallGuardMs) - Date.now());
    this.outputStallGuard = setTimeout(() => {
      if (this.settled) return;
      if ((Date.now() - this.lastDataAt) < this.outputStallGuardMs) {
        this.armOutputStallGuard();
        return;
      }
      this.resolveTimeout('output_stall');
    }, remainingMs);
    this.outputStallGuard.unref();
  }

  private resolveTimeout(reason: NonNullable<IterationOutcome['stallReason']>): void {
    if (this.settled) return;
    this.settled = true;
    this.didTimeout = true;
    this.stallReason = reason;
    this.timeoutResolutionFinished = false;
    this.timeoutAwaitingDrain = true;
    this.timeoutChildClosed = false;
    this.timeoutStdoutClosed = this.currentChild?.stdout === null;
    this.timeoutStderrClosed = this.currentChild?.stderr === null;
    this.timeoutEarliestFinishAt = Date.now() + 150;
    this.clearIterationGuards();
    currentChildProc = null;
    this.currentChild?.once('close', () => {
      this.timeoutChildClosed = true;
      this.scheduleTimeoutResolutionFinish();
    });
    this.timeoutResolveTimer = setTimeout(() => {
      this.scheduleTimeoutResolutionFinish(true);
    }, 1500);
    this.timeoutResolveTimer.unref();
    try { this.currentChild?.kill('SIGTERM'); } catch { /* already dead */ }
  }

  private maybeFinishTimeoutResolution(): void {
    if (!this.timeoutAwaitingDrain || this.timeoutResolutionFinished) return;
    if (!this.timeoutChildClosed || !this.timeoutStdoutClosed || !this.timeoutStderrClosed) return;
    this.finishTimeoutResolution();
  }

  private scheduleTimeoutResolutionFinish(force = false): void {
    if (!this.timeoutAwaitingDrain || this.timeoutResolutionFinished) return;
    if (this.timeoutDrainTimer) {
      clearTimeout(this.timeoutDrainTimer);
      this.timeoutDrainTimer = null;
    }
    const remainingMs = this.timeoutEarliestFinishAt - Date.now();
    if (remainingMs > 0) {
      this.timeoutDrainTimer = setTimeout(() => {
        this.timeoutDrainTimer = null;
        this.scheduleTimeoutResolutionFinish(force);
      }, remainingMs);
      this.timeoutDrainTimer.unref();
      return;
    }
    if (force) {
      this.finishTimeoutResolution();
      return;
    }
    this.maybeFinishTimeoutResolution();
  }

  private finishTimeoutResolution(): void {
    if (this.timeoutResolutionFinished) return;
    this.timeoutResolutionFinished = true;
    this.timeoutAwaitingDrain = false;
    if (this.timeoutDrainTimer) {
      clearTimeout(this.timeoutDrainTimer);
      this.timeoutDrainTimer = null;
    }
    if (this.timeoutResolveTimer) {
      clearTimeout(this.timeoutResolveTimer);
      this.timeoutResolveTimer = null;
    }
    this.closeLogFd();
    const label = this.stallReason === 'output_stall' ? 'output stall detected' : 'hang detected';
    console.error(`${Style.RED}❌ Iteration ${this.iterationNum} ${label} — forcing failure${Style.RESET}`);
    this.resolveOutcome({
      completion: 'error',
      timedOut: true,
      exitCode: null,
      wallSeconds: (Date.now() - this.start) / 1000,
      stallReason: this.stallReason,
    });
  }

  private finalizeOnChildEnd(code: number | null): void {
    if (this.settled) return;
    this.settled = true;
    currentChildProc = null;
    this.currentChild = null;
    try { clearActivePidFile(this.sessionDir); } catch { /* best effort */ }
    this.clearIterationGuards();
    this.closeLogFd();
    this.writeExitCodeFile(code);
    const output = this.readIterationOutput();
    this.emitCodexObservations(output);
    const outcome = this.buildOutcome(code, output);
    if (outcome.completion === 'error') {
      this.resolveOutcome(outcome);
      return;
    }
    this.resolveOutcome(outcome);
  }

  private writeExitCodeFile(code: number | null): void {
    const exitCodeFile = this.prepared.logFile.replace('.log', '.exitcode');
    try { fs.writeFileSync(exitCodeFile, String(code ?? -1)); } catch { /* best effort */ }
  }

  private readIterationOutput(): string {
    try { return fs.readFileSync(this.prepared.logFile, 'utf-8'); } catch { return ''; }
  }

  private emitCodexObservations(output: string): void {
    if (this.prepared.backend === 'codex' && detectOutputFormat(output) === 'plain-text') {
      process.stderr.write(`[classifier] codex delimiter drift: no recognizable codex/user blocks in iteration ${this.iterationNum} output\n`);
    }
    if (this.prepared.state.backend !== 'codex') return;
    const bootstrapObs = checkIterationLogForCodexSelfBootstrap(
      output,
      this.prepared.state.backend,
      this.prepared.state.current_ticket,
      this.iterationNum,
    );
    for (const obs of bootstrapObs) {
      logActivity({
        event: 'codex_manager_self_bootstrap_attempted',
        ts: new Date().toISOString(),
        source: 'pickle',
        session: path.basename(this.sessionDir),
        ticket: obs.ticket,
        attempted_argv: obs.attempted_argv,
        iteration: obs.iteration,
        action_taken: 'logged',
      });
    }
  }

  private buildOutcome(code: number | null, output: string): IterationOutcome {
    const completion = classifyCompletion(output);
    const normalizedOutcome: IterationOutcome = {
      completion,
      timedOut: this.didTimeout,
      exitCode: code ?? null,
      wallSeconds: (Date.now() - this.start) / 1000,
      stallReason: this.stallReason,
    };
    const isMaxTurnsExit = this.prepared.backend === 'claude'
      && detectManagerMaxTurnsExit(normalizedOutcome, this.prepared.logFile, this.prepared.maxTurns);
    if (isMaxTurnsExit) {
      emitMaxTurnsClassifiedEvent(
        this.sessionDir,
        this.iterationNum,
        this.prepared.logFile,
        this.prepared.maxTurns,
        normalizedOutcome.wallSeconds,
      );
    }
    return {
      ...normalizedOutcome,
      completion: isMaxTurnsExit ? 'error' : completion,
    };
  }

  private closeLogFd(): void {
    if (this.logFd < 0) return;
    try { fs.fsyncSync(this.logFd); } catch { /* already closed or error */ }
    try { fs.closeSync(this.logFd); } catch { /* already closed */ }
    this.logFd = -1;
  }
}

export async function runIteration(
  sessionDir: string,
  iterationNum: number,
  extensionRoot: string,
  qualityPassModel: string = '',
  runtimeOverrides: IterationRuntimeOverrides = {},
): Promise<IterationOutcome> {
  const prepared = prepareIterationRun(sessionDir, iterationNum, extensionRoot, qualityPassModel, runtimeOverrides);
  if ('completion' in prepared) return prepared;
  return new IterationProcessController(sessionDir, iterationNum, prepared, runtimeOverrides).run();
}

/**
 * Atomically writes handoff.txt via a tmp file + rename.
 * On rename failure, falls back to a direct (non-atomic) write.
 * On both failures, logs an error but does NOT throw — handoff is non-critical.
 * Warns (does not throw) when tmp cleanup unlinkSync hits EACCES/ENOENT.
 *
 * @param sessionDir  - session directory path
 * @param content     - handoff content to write
 * @param pid         - process id used to make tmp filename unique
 * @param log         - logging function (e.g. the runner's log() closure)
 * @param fsOps       - injectable fs subset (default: real fs — override in tests)
 */
export function writeHandoffAtomic(
  sessionDir: string,
  content: string,
  pid: number,
  log: (msg: string) => void,
  fsOps: { writeFileSync: typeof fs.writeFileSync; renameSync: typeof fs.renameSync; unlinkSync: typeof fs.unlinkSync } = fs
): void {
  const handoffTmp = path.join(sessionDir, `handoff.txt.tmp.${pid}`);
  const handoffPath = path.join(sessionDir, 'handoff.txt');

  // Step 1: write to tmp
  try {
    fsOps.writeFileSync(handoffTmp, content);
  } catch (err) {
    const msg = safeErrorMessage(err);
    log(`ERROR: handoff.txt tmp write failed (non-critical): ${msg}`);
    return;
  }

  // Step 2: atomic rename
  try {
    fsOps.renameSync(handoffTmp, handoffPath);
    return; // success
  } catch {
    log('WARNING: handoff.txt rename failed — falling back to direct write');
  }

  // Step 3: non-atomic fallback
  try {
    fsOps.writeFileSync(handoffPath, content);
  } catch (writeErr) {
    const msg = safeErrorMessage(writeErr);
    log(`ERROR: handoff.txt write failed (non-critical): ${msg}`);
  }

  // Step 4: clean up leftover tmp
  try {
    fsOps.unlinkSync(handoffTmp);
  } catch (unlinkErr) {
    const code = (unlinkErr as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'ENOENT') {
      log(`WARNING: Cannot remove tmp handoff file (${code})`);
    }
  }
}

/**
 * W4b: on `recovery_exhausted` (the SINGLE honest terminal, CUJ-1 entry state),
 * write a `## Recovery Handoff` artifact to the session dir naming the exact
 * `pickle-recover` subcommand the operator should run. The ladder auto-salvaged
 * every recoverable seam; reaching here means recovery is genuinely exhausted and
 * the operator picks up via the named command (PRD order 70 owns the command
 * itself — this only writes the artifact that names it). Best-effort: a write
 * failure never blocks the terminal path. Default subcommand is
 * `--resume-from-todo` (re-queue the lowest runnable Todo); a missing/empty ticket
 * surfaces the same re-queue path.
 */
export function writeRecoveryHandoffArtifact(
  sessionDir: string,
  ticketId: string | null,
  reason: string,
  log: (msg: string) => void,
): void {
  const ticket = (ticketId || '').trim();
  const subcommand = ticket
    ? `pickle-recover --resume-from-todo   # or: pickle-recover --reset-ticket ${ticket}`
    : 'pickle-recover --resume-from-todo';
  const content =
    `## Recovery Handoff\n\n` +
    `The recovery ladder is exhausted (\`recovery_exhausted\`). All auto-salvage ` +
    `strategies were attempted and none advanced the run.\n\n` +
    `- ticket: ${ticket || '(none — empty roster / all-Failed)'}\n` +
    `- reason: ${reason}\n\n` +
    `Operator action — run the named \`pickle-recover\` subcommand from the project root:\n\n` +
    '```\n' + `${subcommand}\n` + '```\n\n' +
    `Then confirm with \`/pickle-status\`. Recovery entry state is \`recovery_exhausted\` ONLY.\n`;
  const target = path.join(sessionDir, 'recovery_handoff.md');
  const tmp = `${target}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, target);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`WARNING: recovery_handoff.md write failed (non-critical): ${msg}`);
    try { fs.unlinkSync(tmp); } catch { /* tmp may not exist */ }
  }
}

// ---------------------------------------------------------------------------
// Commit-pending health probe (codex-only) — RCA: codex-backend "commit-skip"
// failure mode. Codex sometimes produces edits but never `git add` + `git
// commit`, leaving valid work orphaned in the working tree when the breaker
// trips. Pre-spawn we detect uncommitted edits + iteration stagnation and
// nudge the next worker turn to commit and signal Done with a DEFERRED note.
// ---------------------------------------------------------------------------

export interface CommitPendingProbeInput {
  sessionDir: string;
  workingDir: string;
  backend: Backend;
  iteration: number;
  lastProgressIteration: number;
  threshold: number;
  pid: number;
  log: (msg: string) => void;
}

export type CommitPendingProbeResult =
  | 'skipped:not-codex'
  | 'skipped:no-stagnation'
  | 'skipped:no-uncommitted'
  | 'skipped:existing-handoff'
  | 'fired';

export const COMMIT_PENDING_HANDOFF_TEXT = `## CIRCUIT BREAKER HEALTH PROBE — COMMIT PENDING

You have uncommitted edits in the working tree but the iteration counter has not advanced for N iterations. This commonly means you are looping on a contradiction or over-exploring instead of shipping.

REQUIRED THIS TURN:
1. Run \`git add <files>\` and \`git commit -m "<msg>"\` to lock in current edits.
2. If an acceptance criterion is blocked (e.g. fixture mismatch, missing dependency), append a \`# DEFERRED: <reason>\` line to the ticket file and signal Done.
3. Do NOT continue exploring — your unblocked subset is already valuable and must not be orphaned.

After committing, emit \`<promise>${PromiseTokens.WORKER_DONE}</promise>\` as usual.
`;

/**
 * Pre-spawn health probe. Detects the codex "commit-skip" failure mode:
 * uncommitted edits in the working tree combined with iteration counter
 * stagnation. When triggered, writes handoff.txt with a direct nudge so the
 * next worker turn commits + signals Done before the circuit breaker trips.
 *
 * Triggers ONLY when ALL are true:
 *   - backend === 'codex' (claude lacks this failure mode per RCA)
 *   - iteration - lastProgressIteration >= threshold (default 2)
 *   - `git diff --stat` OR `git diff --stat --cached` is non-empty
 *
 * Idempotent: if handoff.txt already exists at probe time (e.g. user-written
 * or rate-limit handoff), the probe defers and skips. Never throws — best
 * effort. Returns a string status for tests/logs.
 */
export function commitPendingProbe(input: CommitPendingProbeInput): CommitPendingProbeResult {
  const { sessionDir, workingDir, backend, iteration, lastProgressIteration, threshold, pid, log } = input;

  if (backend !== 'codex') return 'skipped:not-codex';

  const stagnation = iteration - lastProgressIteration;
  if (stagnation < threshold) return 'skipped:no-stagnation';

  const handoffPath = path.join(sessionDir, 'handoff.txt');
  if (fs.existsSync(handoffPath)) {
    log(`commit-pending probe deferred: existing handoff.txt at ${handoffPath}`);
    return 'skipped:existing-handoff';
  }

  // Detect uncommitted edits using the same git-diff pattern as
  // classifyTicketCompletion (lines ~381-384). Both unstaged and staged
  // diffs count as "pending commit" — codex has been observed leaving
  // either flavor.
  let hasUncommitted = false;
  try {
    const unstaged = runCmd(['git', 'diff', '--stat'], { cwd: workingDir, check: false });
    if (unstaged.length > 0) hasUncommitted = true;
    if (!hasUncommitted) {
      const staged = runCmd(['git', 'diff', '--stat', '--cached'], { cwd: workingDir, check: false });
      if (staged.length > 0) hasUncommitted = true;
    }
  } catch (err) {
    log(`commit-pending probe: git probe failed (${safeErrorMessage(err)}) — skipping`);
    return 'skipped:no-uncommitted';
  }

  if (!hasUncommitted) return 'skipped:no-uncommitted';

  const content = COMMIT_PENDING_HANDOFF_TEXT.replace('N iterations', `${stagnation} iterations`);
  writeHandoffAtomic(sessionDir, content, pid, log);
  log(`commit-pending probe FIRED: stagnation=${stagnation} (>= threshold ${threshold}), uncommitted edits present — handoff.txt written`);
  return 'fired';
}

/**
 * R-MWIS-2 main-loop idle-stall watchdog (the loop-level complement to T1's
 * worker-exit signal). Pure, clock-injectable decision: given the current
 * last-progress timestamp and the existing wait-state predicates, decide whether
 * the mux main loop is wedged with no in-flight progress while NOT in any
 * legitimate wait state. Callers gate the watchdog with the SAME predicates the
 * loop already computes (rate-limit wait, circuit breaker executable, `last_error`,
 * and accumulated subprocess errors via `last_subprocess_error`) so legitimate
 * waits never trip.
 */
export interface MuxIdleStallWatchdogInput {
  /** state.active — only an active session can be idle-stalled. */
  active: boolean;
  /** Current clock (ms). Injectable for tests; production passes Date.now(). */
  nowMs: number;
  /** Epoch (ms) of the last observed forward progress (iteration advance / worker spawn / state write). */
  lastProgressMs: number;
  /** Bounded idle threshold in seconds (PICKLE_MUX_IDLE_STALL_SECONDS override). */
  thresholdSeconds: number;
  /** True when a rate_limit_wait.json artifact is present (legitimate API wait). */
  rateLimitWaiting: boolean;
  /** canExecute(circuitBreaker) — false means the breaker is OPEN/recovering. */
  circuitBreakerExecutable: boolean;
  /** state.last_error snapshot — non-null means the last iteration errored. */
  lastError: unknown;
  /**
   * Accumulated worker subprocess errors — > 0 means worker errors are present and
   * the loop is legitimately in an error/recovery state, not idle. In the mux loop
   * this is derived from `state.last_subprocess_error` presence (1 when set).
   */
  consecutiveSubprocessErrors: number;
}

export type MuxIdleStallReason =
  | 'idle_no_progress'
  | 'inactive'
  | 'in_wait_state'
  | 'within_threshold';

export interface MuxIdleStallWatchdogDecision {
  stalled: boolean;
  idleSeconds: number;
  reason: MuxIdleStallReason;
}

export function evaluateMuxIdleStallWatchdog(input: MuxIdleStallWatchdogInput): MuxIdleStallWatchdogDecision {
  const idleSeconds = Math.max(0, Math.floor((input.nowMs - input.lastProgressMs) / 1000));
  if (!input.active) {
    return { stalled: false, idleSeconds, reason: 'inactive' };
  }
  // Reuse the existing wait-state predicates as the gate: a legitimate wait is
  // never an idle stall.
  if (
    input.rateLimitWaiting ||
    !input.circuitBreakerExecutable ||
    input.lastError != null ||
    input.consecutiveSubprocessErrors > 0
  ) {
    return { stalled: false, idleSeconds, reason: 'in_wait_state' };
  }
  if (idleSeconds >= input.thresholdSeconds) {
    return { stalled: true, idleSeconds, reason: 'idle_no_progress' };
  }
  return { stalled: false, idleSeconds, reason: 'within_threshold' };
}

/**
 * Resolve the idle-stall threshold (seconds). Honors PICKLE_MUX_IDLE_STALL_SECONDS
 * (strict positive integer); falls back to the default when unset/invalid. Mirrors
 * the commit-pending-probe threshold parse convention.
 */
export function resolveIdleStallThresholdSeconds(): number {
  const raw = Number(process.env.PICKLE_MUX_IDLE_STALL_SECONDS);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MUX_IDLE_STALL_SECONDS;
}

const DEFAULT_MUX_IDLE_STALL_SECONDS = 900;

/**
 * C6 (B-MRSW) — CPU/artifact liveness watchdog. The existing
 * `evaluateMuxIdleStallWatchdog` trips only on `lastProgressMs` staleness, which a
 * `/login` re-auth (or any output that keeps streaming) can keep FALSELY fresh — the
 * mux sits at 0% CPU on a worker that already finished its lifecycle, yet the idle
 * watchdog never fires because output recency advanced `lastProgressMs`. This decision
 * is the complement: liveness truth is the worker's CPU-time delta + artifact-mtime
 * advance, NEVER output recency. It deliberately does NOT take `lastProgressMs`.
 *
 * C6a invariant: a rate-limit-parked worker (`rateLimitWaiting === true`) — and every
 * other legitimate wait state — short-circuits to `in_wait_state` BEFORE the CPU branch
 * is reached, so a parked worker is never classified as a CPU stall.
 */
export interface CpuLivenessWatchdogInput {
  /** Only an active session can be CPU-stalled. */
  active: boolean;
  /** Worker process exists (pid alive). A dead worker is not a CPU stall — it is an exit. */
  workerAlive: boolean;
  /** Accumulated worker CPU-seconds over the observation window (sampleAfter - sampleBefore). */
  cpuSecondsDelta: number;
  /** Wall-clock window the delta spans (seconds). Only meaningful once >= the threshold. */
  windowSeconds: number;
  /** CPU-seconds floor: a live, working worker accrues >= this over the window. Default 5. */
  cpuFloorSeconds: number;
  /** True when any required artifact under the ticket dir gained a newer mtime in the window. */
  artifactMtimeAdvanced: boolean;
  /** rate_limit_wait.json present (legitimate API wait — the B park flag, C6a). */
  rateLimitWaiting: boolean;
  /** canExecute(circuitBreaker) — false means the breaker is OPEN/recovering. */
  circuitBreakerExecutable: boolean;
  /** state.last_error snapshot — non-null means the last iteration errored. */
  lastError: unknown;
  /** Accumulated worker subprocess errors (1 when state.last_subprocess_error is set). */
  consecutiveSubprocessErrors: number;
}

export type CpuLivenessReason =
  | 'cpu_stall'
  | 'inactive'
  | 'no_worker'
  | 'in_wait_state'
  | 'cpu_active'
  | 'mtime_advanced';

export interface CpuLivenessWatchdogDecision {
  stalled: boolean;
  reason: CpuLivenessReason;
  cpuSecondsDelta: number;
}

export function evaluateCpuLivenessWatchdog(input: CpuLivenessWatchdogInput): CpuLivenessWatchdogDecision {
  const cpuSecondsDelta = Math.max(0, input.cpuSecondsDelta);
  if (!input.active) {
    return { stalled: false, reason: 'inactive', cpuSecondsDelta };
  }
  // C6a: legitimate wait states gate the CPU branch off. This MUST precede the
  // workerAlive / CPU / mtime checks so a parked worker is never CPU-stalled.
  if (
    input.rateLimitWaiting ||
    !input.circuitBreakerExecutable ||
    input.lastError != null ||
    input.consecutiveSubprocessErrors > 0
  ) {
    return { stalled: false, reason: 'in_wait_state', cpuSecondsDelta };
  }
  if (!input.workerAlive) {
    return { stalled: false, reason: 'no_worker', cpuSecondsDelta };
  }
  // Artifact-mtime advance is forward progress (the worker IS writing), independent of
  // output recency — a real liveness signal that defeats nothing.
  if (input.artifactMtimeAdvanced) {
    return { stalled: false, reason: 'mtime_advanced', cpuSecondsDelta };
  }
  // A live, working worker accrues CPU. A `/login`-hung worker accrues ~0 while ETIME climbs.
  if (cpuSecondsDelta >= input.cpuFloorSeconds) {
    return { stalled: false, reason: 'cpu_active', cpuSecondsDelta };
  }
  return { stalled: true, reason: 'cpu_stall', cpuSecondsDelta };
}

/** C6 default CPU-seconds floor: <5s accrued over the window with no mtime advance is a stall. */
const DEFAULT_CPU_LIVENESS_FLOOR_SECONDS = 5;

/**
 * C6 CPU sampler: read a process's accumulated CPU-time (seconds) via
 * `ps -o time= -p <pid>`. Returns null on a dead/absent pid or any ps error. The
 * `[[DD-]HH:]MM:SS` ps TIME format is parsed to whole seconds. Injectable at the
 * wiring callsite so the pure decision (and its tests) never shell out.
 */
export function sampleWorkerCpuSeconds(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const r = spawnSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf-8', timeout: 5000 });
    if (r.status !== 0 || typeof r.stdout !== 'string') return null;
    const raw = r.stdout.trim();
    if (!raw) return null;
    return parsePsCpuTimeToSeconds(raw);
  } catch {
    return null;
  }
}

/** Parse a `ps -o time=` value (`[[DD-]HH:]MM:SS`) into whole seconds. Returns null on malformed input. */
export function parsePsCpuTimeToSeconds(value: string): number | null {
  const trimmed = value.trim();
  // Optional leading `DD-` day field.
  const dayMatch = /^(\d+)-(.*)$/.exec(trimmed);
  let days = 0;
  let rest = trimmed;
  if (dayMatch) {
    days = Number(dayMatch[1]);
    rest = dayMatch[2];
  }
  const parts = rest.split(':').map((p) => Number(p));
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
    return null;
  }
  let hours = 0;
  let minutes: number;
  let seconds: number;
  if (parts.length === 3) {
    [hours, minutes, seconds] = parts;
  } else {
    [minutes, seconds] = parts;
  }
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

/**
 * C7 graded-lifecycle predicate (invariant #1 — graded level, never a bare boolean
 * elsewhere; here the boolean answers exactly "is the conformance-complete set
 * present?"). The required artifact prefix set is derived from the ticket tier's
 * lifecycle (`requiredTierArtifactPrefixes`), never hardcoded. Returns true ONLY when
 * `findMissingPrefixes` is empty — i.e. the graded level is `=conformance` (complete).
 * An INCOMPLETE set returns false so the CPU-stall salvage never auto-commits it.
 */
export function gradeConformanceComplete(sessionDir: string, ticketId: string): boolean {
  const ticketDir = path.join(sessionDir, ticketId);
  let files: string[];
  try { files = fs.readdirSync(ticketDir); } catch { return false; }
  let tier: TicketComplexityTier = 'medium';
  try {
    tier = parseTicketFrontmatter(ticketFilePath(sessionDir, ticketId))?.complexity_tier ?? 'medium';
  } catch { /* default medium */ }
  const requiredPrefixes = requiredTierArtifactPrefixes(tier);
  return findMissingPrefixes(files, requiredPrefixes).length === 0;
}

/**
 * C6 helper: the in-flight worker pid for a ticket, read from the most-recent
 * `worker_session_<pid>.log` under the ticket dir (the same artifact the silent-death
 * classifier keys on). Returns null when no worker log / pid is resolvable.
 */
export function resolveCurrentWorkerPid(sessionDir: string, ticketId: string): number | null {
  const ticketDir = path.join(sessionDir, ticketId);
  let best: { pid: number; mtimeMs: number; file: string } | null = null;
  let entries: string[];
  try { entries = fs.readdirSync(ticketDir); } catch { return null; }
  for (const file of entries) {
    const m = /^worker_session_(\d+)\.log$/.exec(file);
    if (!m) continue;
    let mtimeMs: number;
    try { mtimeMs = fs.statSync(path.join(ticketDir, file)).mtimeMs; } catch { continue; }
    if (!best || mtimeMs > best.mtimeMs || (mtimeMs === best.mtimeMs && file.localeCompare(best.file) > 0)) {
      best = { pid: Number(m[1]), mtimeMs, file };
    }
  }
  return best ? best.pid : null;
}

/**
 * C6 helper: the newest mtime (ms) among the ticket dir's gated artifacts
 * (research, plan, conformance, code_review markdown). Used as the
 * artifact-mtime-advance liveness signal — independent of any worker output recency.
 * Returns 0 when none.
 */
export function latestTicketArtifactMtimeMs(sessionDir: string, ticketId: string): number {
  const ticketDir = path.join(sessionDir, ticketId);
  let entries: string[];
  try { entries = fs.readdirSync(ticketDir); } catch { return 0; }
  let latest = 0;
  for (const file of entries) {
    if (!/^(research|plan|conformance|code_review)_.*\.md$/.test(file)) continue;
    try {
      const m = fs.statSync(path.join(ticketDir, file)).mtimeMs;
      if (m > latest) latest = m;
    } catch { /* ignore unreadable */ }
  }
  return latest;
}

/** L2 default consecutive idle-stall self-recovery cap before escalation. */
const DEFAULT_MUX_IDLE_STALL_RECOVERY_CAP = 3;

/**
 * L2: resolve the consecutive idle-stall recovery cap. Honors
 * PICKLE_MUX_IDLE_STALL_RECOVERY_CAP (strict positive integer); falls back to the
 * default when unset/invalid. Mirrors resolveIdleStallThresholdSeconds.
 */
export function resolveIdleStallRecoveryCap(): number {
  const raw = Number(process.env.PICKLE_MUX_IDLE_STALL_RECOVERY_CAP);
  return Number.isFinite(raw) && Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MUX_IDLE_STALL_RECOVERY_CAP;
}

/**
 * L2: decide whether a consecutive idle-stall recovery streak has EXCEEDED the cap
 * and must escalate (record idle_stall_unrecoverable + deactivate). The watchdog
 * self-recovery is bounded so a genuinely wedged loop that re-arms the stall every
 * pass cannot spin forever — `recoveryCount` is the count of recoveries attempted
 * THIS streak (including the current one); escalate once it climbs past `cap`.
 * Any real forward progress resets the streak to 0, so a transient stall that the
 * recovery clears never escalates.
 */
export function evaluateIdleStallRecoveryCap(recoveryCount: number, cap: number): boolean {
  return recoveryCount > cap;
}

export interface MuxReadinessGateInput {
  sessionDir: string;
  repoRoot: string;
  extensionRoot: string;
  log: (msg: string) => void;
  /**
   * BMAD residual P0.6: when set, mux-runner forwards `--skip-readiness <reason>`
   * to check-readiness, bypassing validation and emitting a `readiness_skipped`
   * activity event for audit. Wired from `state.flags.skip_quality_gates_reason`.
   */
  skipReason?: string;
}

const QUALITY_GATE_SUBPROCESS_TIMEOUT_MS = 60_000;

export function runMuxReadinessGate(input: MuxReadinessGateInput): number {
  const localBinPath = path.join(input.extensionRoot, 'extension', 'bin', 'check-readiness.js');
  const installedBinPath = path.join(input.extensionRoot, 'bin', 'check-readiness.js');
  const binPath = fs.existsSync(localBinPath) ? localBinPath : installedBinPath;
  if (!fs.existsSync(binPath)) {
    input.log(`readiness gate skipped: ${binPath} not found`);
    return 0;
  }
  const args = [
    binPath,
    '--session-dir', input.sessionDir,
    '--repo-root', input.repoRoot,
  ];
  if (typeof input.skipReason === 'string' && input.skipReason.length > 0) {
    args.push('--skip-readiness', input.skipReason);
    input.log(`readiness gate skipped via state.flags.skip_quality_gates_reason: ${input.skipReason}`);
  }
  const result = spawnSync(process.execPath, args, {
    cwd: input.repoRoot,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: QUALITY_GATE_SUBPROCESS_TIMEOUT_MS,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status ?? 1;
}

// ---------------------------------------------------------------------------
// R-TAQ-3 — ticket audit gate (post-readiness slot)
// ---------------------------------------------------------------------------

export interface TicketAuditGateInput {
  sessionDir: string;
  extensionRoot: string;
  log: (msg: string) => void;
  skipReason?: string;
}

export type TicketAuditGateResult =
  | { status: 'bypassed'; reason: string }
  | { status: 'ok' }
  | { status: 'failed'; exitCode: number };

type QualityGateSkipCallsite = 'readiness_gate' | 'ticket_audit_gate';

interface QualityGateSkipResolution {
  reason?: string;
}

// Single skip surface: `state.flags.skip_quality_gates_reason` is the ONLY
// quality-gate bypass flag. The legacy per-gate skip flags were retired in the
// guard-layer prune — both gates are advisory (R-GATE-ADVISORY), so the bypass
// only silences advisory findings. Old sessions may still carry the retired
// keys in state.flags; they are inert (never read, never migrated).
export function resolveQualityGateSkipReason(
  state: State,
  _log: (msg: string) => void,
  _sessionName: string,
  _callsite: QualityGateSkipCallsite,
): QualityGateSkipResolution {
  const unifiedRaw = state.flags?.skip_quality_gates_reason;
  const unifiedReason = typeof unifiedRaw === 'string' ? unifiedRaw.trim() : '';
  if (unifiedReason.length > 0) {
    return { reason: unifiedReason };
  }
  return {};
}

/**
 * Invokes audit-ticket-bundle.js on the session's ticket files immediately
 * after the (advisory) readiness gate and BEFORE iteration-0 spawn.
 * R-GATE-ADVISORY: a non-zero exit is ADVISORY — the caller logs the findings
 * and PROCEEDS (it does NOT halt and does NOT stamp a failure exit_reason). A
 * genuinely-defective bundle surfaces at the build/review phases instead of
 * being pre-emptively killed by a heuristic pre-flight.
 * skipReason (from state.flags.skip_quality_gates_reason) → bypassed.
 */
export function runTicketAuditGate(input: TicketAuditGateInput): TicketAuditGateResult {
  if (typeof input.skipReason === 'string' && input.skipReason.length > 0) {
    input.log(`ticket audit gate bypassed via state.flags.skip_quality_gates_reason: ${input.skipReason}`);
    return { status: 'bypassed', reason: input.skipReason };
  }
  const localBinPath = path.join(input.extensionRoot, 'extension', 'bin', 'audit-ticket-bundle.js');
  const installedBinPath = path.join(input.extensionRoot, 'bin', 'audit-ticket-bundle.js');
  const binPath = fs.existsSync(localBinPath) ? localBinPath : installedBinPath;
  if (!fs.existsSync(binPath)) {
    input.log(`ticket audit gate skipped: ${binPath} not found`);
    return { status: 'ok' };
  }
  const result = spawnSync(process.execPath, [binPath, input.sessionDir], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: QUALITY_GATE_SUBPROCESS_TIMEOUT_MS,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const exitCode = result.status ?? 1;
  if (exitCode !== 0) {
    return { status: 'failed', exitCode };
  }
  return { status: 'ok' };
}

/**
 * Best-effort append of a one-line marker to `pipeline-runner.log` in the
 * session directory. The pipeline-runner owns that file when it spawns
 * mux-runner; in standalone mux-runner runs the file may not exist (we never
 * create it). Failure is silent — the same marker also lands in mux-runner's
 * own log via the caller's `log()`. This exists so a human reading the
 * pipeline log alone sees the recovery event.
 */
export function appendPipelineRunnerMarker(sessionDir: string, message: string): void {
  const target = path.join(sessionDir, 'pipeline-runner.log');
  if (!fs.existsSync(target)) return; // standalone mux-runner — nothing to annotate
  try {
    fs.appendFileSync(target, `[${new Date().toISOString()}] [mux-runner] ${message}\n`);
  } catch { /* non-critical — the marker is also in mux-runner.log */ }
}

/**
 * The pickle-phase exit reasons, DERIVED from the single runtime-iterable list in
 * `types/index.ts`. It was a hand-maintained literal union until this collapse, which made
 * it a parallel copy of `EXIT_REASONS`: a reason added to the union alone typechecked
 * everywhere while never being swept by pipeline-runner's AC-CF-02/03 crash-floor sweeps,
 * which iterate `EXIT_REASONS`. Only a source-text parity test tied the two.
 *
 * The direction matters. `types/index.ts` cannot import `mux-runner.ts` without a cycle, so
 * the array must live there and the type must derive here — never the reverse, and never
 * both. Restating the members as a literal union re-opens the drift.
 */
export type ExitReason = typeof EXIT_REASONS[number];

/**
 * R-CNAR-4(c): halt exits pause/defer — auto-resume.sh may retry. Does NOT include
 * 'recovery_exhausted' (fatal, non-recoverable).
 *
 * B-GTRUTH WS-A2: 'done_without_commit_evidence' is NOT a member. It is a
 * TICKET-scoped condition ("this ticket produced no attributable commit"), not a
 * session-scoped pause, and it now routes into the PhaseIncomplete contract via
 * exit code 3 (see the exit map in `main`). Demoted in lockstep with
 * FAILURE_EXIT_REASONS below and `isFatalPhaseFailure` in pipeline-runner.ts, so
 * the three classifiers cannot disagree. 'state_schema_version_ahead' is likewise
 * not a member — do not add it.
 */
export const isHaltExit = (r: ExitReason): boolean => r === 'cancelled' || r === 'limit' || r === 'timeout_repeat' || r === 'closer_handoff_terminal' || r === 'manager_handoff_pending';
/**
 * R-CNAR-4(c): failure exits stop auto-resume.sh. Includes 'recovery_exhausted' — a
 * non-recoverable terminal state.
 *
 * B-GTRUTH WS-A2: 'done_without_commit_evidence' removed — a run that reaches it is
 * INCOMPLETE, not failed, so the completion panel must not render RED
 * (`deriveCompletionVerdict`). Removing it here alone would send the run to exit
 * code 0 (a silent fake-green); the exit map in `main` maps it to 3 instead, and
 * `INCOMPLETE_EXIT_REASONS` below keeps the panel from claiming "Complete".
 */
const FAILURE_EXIT_REASONS: ReadonlySet<ExitReason> = new Set<ExitReason>([
  'error', 'stall', 'circuit_open', 'rate_limit_exhausted', 'timeout_repeat',
  'manager_persistent_hallucination', 'iteration_cap_exhausted', 'codex_unhealthy_consecutive_failures',
  'working_tree_modified_externally', 'state_schema_version_ahead',
  'codex_manager_no_progress', 'recovery_exhausted',
  'idle_stall_unrecoverable', 'state_working_dir_missing', 'toolchain_unavailable',
]);
export const isFailureExit = (r: ExitReason): boolean => FAILURE_EXIT_REASONS.has(r);

/**
 * Exits that are NEITHER a failure NOR a completion — the run did not fail, and it
 * did not finish. This is the THIRD class WS-A2 created and the binary verdict could
 * not express.
 *
 * Membership is an explicit declaration, never the absence of failure-membership: a
 * reason demoted out of `FAILURE_EXIT_REASONS` for routing reasons otherwise lands in
 * the success arm by default, which is how `done_without_commit_evidence` came to
 * print a green "mux-runner Complete" panel for a bundle that halted mid-flight. A
 * future reason demoted the same way must be listed here in the same commit.
 *
 * Deliberately disjoint from `isHaltExit`: a halt ('cancelled', 'limit', …) is an
 * operator-or-budget decision to stop, which the panel already reports honestly as
 * "Stopped: <reason>". An incomplete exit is the runner reporting that it could not
 * account for the work it was asked to do.
 */
const INCOMPLETE_EXIT_REASONS: ReadonlySet<ExitReason> = new Set<ExitReason>([
  'done_without_commit_evidence',
]);
/**
 * Shared classification: a reason that is a per-ticket verdict ("this ticket
 * produced no attributable commit"), not a session-scoped halt. mux-runner's
 * own park-and-continue sites and pipeline-runner.ts's phase-incomplete
 * routing both consume this ONE predicate so the two runtimes cannot
 * disagree (ticket 96444430). Loose input type so callers holding a raw
 * `state.exit_reason: string | null` read (e.g. pipeline-runner.ts) don't
 * need to narrow first.
 */
export const isPerTicketVerdictReason = (r: string | null | undefined): boolean =>
  typeof r === 'string' && INCOMPLETE_EXIT_REASONS.has(r as ExitReason);
export const isIncompleteExit = (r: ExitReason): boolean => isPerTicketVerdictReason(r);

/**
 * WS-2c (R-PFNT): cheap, best-effort target-toolchain pre-flight. When the TARGET
 * repo declares a Node toolchain (`package.json`) but has NO installed `node_modules`,
 * every worker spawn churns through ~30 Done/Skipped iterations of red gates before
 * anyone notices — the toolchain is simply absent. Detect that ONE definite
 * missing-toolchain signal so the run can fail fast (once) instead of churning.
 *
 * CONSERVATIVE by construction — returns `false` (toolchain OK / unknown) for every
 * ambiguous case so a genuine run is never falsely killed:
 *  - no `workingDir` given                      → not our call to make
 *  - no `package.json`                          → not a Node project; no toolchain claim
 *  - `node_modules` present (dir OR symlink)    → installed
 *  - any FS error                               → fail-open (treat as OK)
 *
 * Only `package.json present AND node_modules absent` returns `true` (fail fast).
 */
export function targetToolchainMissing(workingDir: string | null | undefined): boolean {
  if (!workingDir) return false;
  try {
    const pkgJson = path.join(workingDir, 'package.json');
    if (!fs.existsSync(pkgJson)) return false; // not a Node project → no definite signal
    const nodeModules = path.join(workingDir, 'node_modules');
    // existsSync follows symlinks, so a symlinked node_modules (the worktree case)
    // correctly reads as present.
    if (fs.existsSync(nodeModules)) return false; // toolchain installed
    return true; // package.json present, node_modules absent → definite missing toolchain
  } catch {
    return false; // fail-open: never fail-fast on an ambiguous FS error
  }
}

interface CloserHandoffTracker {
  ticket_id: string;
  head_sha: string;
  consecutive_failed_iterations: number;
}

type MuxRunnerStateWithCloserTracker = State & {
  closer_handoff_tracker?: CloserHandoffTracker | null;
};

interface TicketConformanceSnapshot {
  file: string | null;
  hasManagerHandoff: boolean;
}

type CloserTerminalDecision =
  | { action: 'continue'; tracker: CloserHandoffTracker | null }
  | { action: 'exit'; reason: Extract<ExitReason, 'closer_handoff_terminal' | 'manager_handoff_pending' | 'recovery_exhausted'>; tracker: CloserHandoffTracker | null; detail: string };

/**
 * Returns true only when the conformance has a `## Manager Handoff` section AND
 * its body is substantive (not "None", "N/A", "Nothing", empty, etc.).
 * Workers commonly write the section header with body "None" as the standard
 * no-handoff-needed boilerplate; treating that as a halt trigger produced a
 * recurring false-positive `manager_handoff_pending` exit on clean tickets
 * (e.g., session 2026-05-17-6ff53ea2/f00097e8).
 */
/**
 * Guards the worker Done-flip transition. Returns true when the ticket's
 * `completion_commit` evidence is `'explicit'` (i.e., worker shipped a real
 * git commit attributable to the ticket). Returns false otherwise — caller
 * should halt mux-runner with `done_without_commit_evidence` exit_reason.
 *
 * Rationale: workers in B-CCPM-1b (2/3 tickets) and B-SJET (1/3 ticket
 * f00097e8) shipped ticket status=Done with prose-only verdict and no
 * attributable commit. mux-runner trusted the prose; the bundle bookkeeping
 * shipped while the actual fix never landed. This is the surgical guard.
 */
/**
 * R-PEDC: clear a stale `done_without_commit_evidence` exit_reason when a
 * later guard pass eventually classifies `ok: true`. The prior iteration's
 * fatal stamp survives a successful auto-promote in the same loop, and
 * `finalizePipeline` would otherwise read the stale value and label a fully
 * Done bundle as `failed`. Mirrors pipeline-runner's R-CCR-3 stale-handoff
 * clearance pattern: only clear when the prior failure reason is precisely
 * the one we just recovered from; leave unrelated exit_reasons untouched.
 *
 * Best-effort: a transient state read/write failure must not block the
 * happy-path Done flip. The next finalize/exit will retry as needed.
 */
export function clearStaleDoneWithoutCommitEvidence(statePath: string): void {
  try {
    const snapshot = readRecoverableJsonObject(statePath) as { exit_reason?: unknown } | null;
    if (snapshot?.exit_reason === 'done_without_commit_evidence') {
      clearExitReason(statePath);
    }
  } catch { /* best-effort — finalize path will resolve terminal state */ }
}

/**
 * R-CCEM (#126): the most-recent worker-announced completion SHA for a ticket,
 * read from `state.activity` (`worker_completion_commit_announced`, emitted by
 * spawn-morty when the worker echoes `COMPLETION_COMMIT_RECORDED: <sha>`).
 * Consulted ONLY by guardCompletionCommitBeforeDone's absent-evidence recovery —
 * it is the worker's OWN declaration of the commit it made, not a guess across
 * HEAD commits, so it cannot mis-attribute (no #94 R-CXOR false-Done risk).
 * Returns null when no valid announcement exists.
 */
export function readAnnouncedCompletionSha(sessionDir: string, ticketId: string): string | null {
  try {
    const statePath = path.join(sessionDir, 'state.json');
    const state = readRecoverableJsonObject(statePath) as { activity?: unknown } | null;
    const activity = Array.isArray(state?.activity) ? state.activity : [];
    let latest: string | null = null;
    for (const e of activity) {
      if (
        e && typeof e === 'object' &&
        (e as { event?: unknown }).event === 'worker_completion_commit_announced' &&
        (e as { ticket_id?: unknown }).ticket_id === ticketId
      ) {
        const sha = (e as { sha?: unknown }).sha;
        if (typeof sha === 'string' && /^[0-9a-f]{7,40}$/i.test(sha)) latest = sha;
      }
    }
    return latest;
  } catch {
    return null;
  }
}

/**
 * R-CXOR-2 activation: reads the session baseline SHAs (`start_commit` /
 * `pinned_sha`) so callers can feed them into `EvidenceCtx` and let
 * `readEvidence`'s `isBaselineSha` rejection fire. Commit 1cbe4078 added the
 * baseline-equal rejection to `readEvidence` but wired the inputs into NO
 * production caller — a worker that stamps `completion_commit === start_commit`
 * (the codex orphan-reset false-Done class) was still accepted as 'explicit'.
 * Best-effort: a missing/unreadable state.json yields both null (no rejection,
 * prior behavior preserved).
 */
function resolveSessionBaselineShas(sessionDir: string): { startCommit: string | null; pinnedSha: string | null } {
  const baseline = readRecoverableJsonObject(
    path.join(sessionDir, 'state.json'),
  ) as { start_commit?: unknown; pinned_sha?: unknown } | null;
  return {
    startCommit: typeof baseline?.start_commit === 'string' ? baseline.start_commit : null,
    pinnedSha: typeof baseline?.pinned_sha === 'string' ? baseline.pinned_sha : null,
  };
}

/**
 * B-PXBO WS-3-FacetB + WS-1 SHARED oracle-recheck helper.
 *
 * Thin wrapper over the shipped `readEvidence` oracle that answers the single
 * committed-vs-absent question both consumers need: "is this ticket's completion
 * attributably committed in git?". It wires the session baseline SHAs
 * (`resolveSessionBaselineShas`) into the `EvidenceCtx` so the R-CXOR-2
 * `isBaselineSha` rejection fires — a ticket whose only "commit" is the session
 * baseline is NOT committed-for-advance.
 *
 * Consumers:
 *   - WS-3-FacetB (this module): the crash-resume Done-skip re-route, so an
 *     already-committed `state.current_ticket` is NOT re-selected (and never
 *     reaches the per-ticket cap-check that could flip Done->Failed, AC-CRSR-3).
 *   - WS-1 (pipeline-runner via this exported helper): `reportPhaseIncomplete`
 *     excludes a non-Done ticket whose oracle result is committed from the
 *     unfinished set — keeping ticket-completion-evidence.ts at exactly 2 oracle
 *     importer files (R-AFCC-CALLER-ENUMERATION). mux-runner.ts is ALREADY a
 *     permitted oracle caller, so re-exporting this wrapper adds no new importer.
 *
 * Best-effort: any oracle error reads as not-committed (conservative — never
 * spuriously excludes a genuinely-unfinished ticket from the incomplete set).
 */
export function isTicketOracleCommitted(args: {
  sessionDir: string;
  ticketId: string;
  workingDir: string;
}): boolean {
  if (!args.ticketId) return false;
  try {
    // B-1SEAM WS-1: mechanical swap onto the ONE predicate (baseline SHAs wired
    // by buildCompletionCtx; { decision: 'attribution' } — no R-CWGE verdict).
    const decision = evaluateCompletionEvidence(buildCompletionCtx({
      sessionDir: args.sessionDir,
      ticketId: args.ticketId,
      workingDir: args.workingDir,
      rereadBackoffMs: 0,
    }, 'attribution'));
    return decision.ok;
  } catch {
    return false;
  }
}

/**
 * B-CWGE WS-2 (R-CWGE): read the worker gate's persisted verdict
 * (`WORKER_GATE_VERDICT_FIELD`, written by spawn-morty's
 * `persistWorkerGateVerdict` — REUSED, never recomputed). Returns the recorded
 * `'green'` / `'red'` as-is; anything else (missing / blank / unknown) returns
 * `'absent'`, meaning the worker gate never ran for this commit. Best-effort: an
 * unreadable ticket reads as `'absent'` (fail-closed — the guard refuses a
 * Done-flip on a non-green verdict).
 *
 * B-OFFREPO (AC-OFFREPO-1) — PERSISTENCE ROUND-TRIP DECISION: `'not_run'` is
 * PRESERVED, not coerced to `'absent'`. The alternative (do not persist it) was
 * rejected for two reasons. First, an absent verdict routes
 * `resolveWorkerGateVerdict` into `recomputeAbsentWorkerGateVerdict`, which runs
 * eslint + tsc only — so a ticket whose TEST dimension never ran would be handed
 * a freshly-synthesised `'green'`, re-minting the very claim this bundle removes,
 * one site downstream. Second, `'absent'` is fail-closed and REFUSES the Done
 * flip; erasing `not_run` into it would turn "we could not check" into "we
 * refuse", which is a gate stopping the pipeline rather than blocking a local
 * action. Preserving the literal is also idempotent: re-reading the ticket yields
 * the same honest disposition without re-running any toolchain.
 */
function readWorkerGateVerdict(sessionDir: string, ticketId: string): 'green' | 'red' | 'absent' | 'not_run' {
  try {
    const raw = fs.readFileSync(ticketFilePath(sessionDir, ticketId), 'utf8');
    const v = (readFrontmatterField(raw, WORKER_GATE_VERDICT_FIELD) ?? '').trim();
    return v === 'green' || v === 'red' || v === 'not_run' ? v : 'absent';
  } catch {
    return 'absent';
  }
}

/** Finite hang-guard for the eslint/tsc recompute spawns (5 min). */
const WORKER_GATE_RECOMPUTE_CHECK_TIMEOUT_MS = 300_000;

function defaultRecomputeCheck(bin: string, cmdArgs: string[], dir: string): boolean {
  const r = spawnSync(bin, cmdArgs, {
    cwd: dir,
    encoding: 'utf-8',
    timeout: WORKER_GATE_RECOMPUTE_CHECK_TIMEOUT_MS,
  });
  // AP-EXT-ITER43-01: `status === null` is "the toolchain produced NO exit code" —
  // spawnSync does NOT throw for ENOENT (npx absent), ETIMEDOUT (the 5-min
  // hang-guard fired), ENOBUFS (>1MB of eslint output on a warning-heavy but
  // EXIT-0 tree), or an external signal kill. Reading that as `false` authors a
  // RED verdict for a gate that never ran, and `resolveWorkerGateVerdict`
  // PERSISTS it into the ticket frontmatter — sticky forever, since the next
  // read is no longer `absent`. Throw instead: the caller's existing catch is
  // the declared home for an errored gate (`absent`/`unavailable`, AC-CWGE-6),
  // it skips the persist, and it stays fail-closed either way. ONE uniform
  // "did we get an exit code?" check, not a second `r.error` guard beside it.
  if (r.status === null) {
    const detail = r.error instanceof Error ? r.error.message : `signal ${r.signal ?? 'unknown'}`;
    throw new Error(`worker-gate recompute could not run '${bin} ${cmdArgs[0] ?? ''}': ${detail}`);
  }
  return r.status === 0;
}

/**
 * B-CWGE (R-CWGE/R-DOTR): recompute an ABSENT worker-gate verdict against the
 * DETERMINISTIC eslint + tsc dimensions. A worker that never persisted
 * `worker_gate_verdict` (notably a codex / detached / salvaged worker that bypasses or
 * dies before spawn-morty's `persistWorkerGateVerdict`) is the population this recompute
 * speaks for; a lint-RED or tsc-RED tree (stale compiled JS hides the tsc-RED entirely)
 * would otherwise recompute 'green' and the Done-flip guard would ship Done-over-red on
 * the lint/tsc dimensions — exactly the 2026-06-27 codex soak class B-CWGE closes.
 * eslint short-circuits tsc, mirroring the worker gate's `!lintOk || !tscOk` ordering.
 *
 * R-WGFR (SUBTRACTION): the `test:fast` dimension is DROPPED here. eslint and tsc are
 * deterministic; only `test:fast` flakes (a single c=8 timeout-flake, R-CIFB, false-red
 * this recompute and killed a GREEN bundle FATAL at 0/N phases — beta.44 codex). That
 * `test:fast` run is redundant with the next ticket's own worker-lint gate and the
 * closer's authoritative full release gate. B-CWGE's protection (a lint/tsc-RED tree
 * hidden behind a passing `test:fast`) is fully preserved by keeping eslint+tsc.
 * `runCheck` is injectable for tests; production wires the real spawns.
 */
export function recomputeAbsentWorkerGateVerdict(
  extensionDir: string,
  runCheck: (bin: string, cmdArgs: string[], dir: string) => boolean = defaultRecomputeCheck,
): 'green' | 'red' {
  if (!runCheck('npx', ['eslint', 'src/', '--max-warnings=-1'], extensionDir)) return 'red';
  if (!runCheck('npx', ['tsc', '--noEmit'], extensionDir)) return 'red';
  return 'green';
}

/**
 * B-CWGE WS-2 (R-CWGE): resolve the authoritative worker-gate verdict for the Done-flip
 * guard. Prefers the persisted `worker_gate_verdict`; on an absent value recomputes one via
 * `recomputeAbsentWorkerGateVerdict` (the deterministic eslint+tsc contract — no new
 * `runWorkerGate` callsite; R-WGFR drops the flaky `test:fast` dimension) and persists
 * the green/red result back so the epic-completion
 * path doesn't recompute. A missing `extension/` dir means the JS worker gate is NOT
 * APPLICABLE to this target repo (non-pickle-rick targets, e.g. loanlight-api) — it yields
 * `verdict:'not_run'`, matching `runWorkerGate`'s own no-extension early return, so
 * Done-flips on those repos are not universally fail-closed. Only an EXISTING-but-errored
 * gate yields `'unavailable'` (→ fail-closed, AC-CWGE-6).
 *
 * B-OFFREPO (AC-OFFREPO-1): the no-extension arm used to return
 * `{ verdict: 'green', computedVia: 'worker_gate' }`. The fear behind it was
 * correct — fail-closing there WOULD refuse every Done flip on a non-pickle-rick
 * target — but the conclusion was not: it asserted AUTHORSHIP, claiming a gate
 * produced a passing verdict when no gate ran. A gate that cannot run reports
 * `not_run`, and the `computedVia` says `not_applicable` rather than naming a
 * gate. The permissiveness is preserved where it belongs — at the Done-flip
 * policy in `guardCompletionCommitBeforeDone` — instead of being smuggled in as a
 * fake measurement.
 */
export function resolveWorkerGateVerdict(
  sessionDir: string,
  ticketId: string,
  workingDir: string,
): { verdict: 'green' | 'red' | 'absent' | 'not_run'; computedVia: 'worker_gate' | 'between_ticket_gate' | 'unavailable' | 'not_applicable' } {
  const persisted = readWorkerGateVerdict(sessionDir, ticketId);
  // B-OFFREPO (AC-OFFREPO-1): a persisted `not_run` is the off-repo early return's OWN
  // record — no gate ever issued a command to produce it — so it must not be attributed
  // to one. Only `green`/`red` were authored by a real gate run. Without this, the same
  // fact reports `not_applicable` when computed fresh but `worker_gate` when read back
  // from the file the off-repo path itself wrote, re-asserting the exact authorship claim
  // this bundle removes. Behaviour-neutral today (no consumer branches on `computedVia`
  // except the `between_ticket_gate` refusal in `bin/setup.ts`), so this closes a latent
  // trap rather than changing a decision.
  if (persisted !== 'absent') {
    return { verdict: persisted, computedVia: persisted === 'not_run' ? 'not_applicable' : 'worker_gate' };
  }
  const ext = path.join(workingDir, 'extension');
  // No extension/ dir → JS worker gate not applicable to this target repo → not_run.
  // NOT green: nothing was measured, so nothing may be reported as passing.
  if (!fs.existsSync(ext)) { return { verdict: 'not_run', computedVia: 'not_applicable' }; }
  let verdict: 'green' | 'red';
  try {
    verdict = recomputeAbsentWorkerGateVerdict(ext);
  } catch {
    return { verdict: 'absent', computedVia: 'unavailable' };   // gate errored -> non-green (AC-CWGE-6)
  }
  // best-effort persist the computed verdict (green|red) back to frontmatter
  try {
    const fp = ticketFilePath(sessionDir, ticketId);
    const raw = fs.readFileSync(fp, 'utf8');
    const upd = upsertFrontmatterField(raw, WORKER_GATE_VERDICT_FIELD, verdict);
    if (upd) { fs.writeFileSync(fp, upd); }
  } catch { /* best-effort */ }
  return { verdict, computedVia: 'between_ticket_gate' };
}

/**
 * B-1SEAM WS-1: build the `CompletionDecisionCtx` every mux-runner decision site
 * feeds into `evaluateCompletionEvidence` (the ONE completion predicate in
 * ticket-completion-evidence.ts). Wires the runtime capabilities the predicate
 * cannot own itself:
 *   - session baseline SHAs (R-CXOR-2 rejection) via resolveSessionBaselineShas;
 *   - the worker-gate verdict resolver (R-CWGE, consulted only on 'done-flip');
 *   - the worker's announced completion SHA (R-CCEM recovery).
 * Every site building its ctx here evaluates the SAME policy — no per-site
 * ladder drift (the R-AICF accept-here-revert-there class).
 */
function buildCompletionCtx<K extends CompletionDecisionKind>(
  args: {
    sessionDir: string;
    ticketId: string;
    workingDir: string;
    ticketPath?: string;
    fallbackDir?: string;
    startTimeEpoch?: number | null;
    rereadBackoffMs?: number;
    /** R-PDUP sanctioned twin-borrow: twin ids counted as own attribution (R-OMA). */
    ownAttributionTokens?: string[];
  },
  decision: K,
): CompletionDecisionCtx & { decision: K } {
  const { startCommit, pinnedSha } = resolveSessionBaselineShas(args.sessionDir);
  return {
    sessionDir: args.sessionDir,
    ticketId: args.ticketId,
    workingDir: args.workingDir,
    ticketPath: args.ticketPath,
    fallbackDir: args.fallbackDir,
    startTimeEpoch: args.startTimeEpoch,
    rereadBackoffMs: args.rereadBackoffMs,
    ownAttributionTokens: args.ownAttributionTokens,
    startCommit,
    pinnedSha,
    decision,
    // B-OFFREPO: the completion predicate's gate vocabulary is three-valued
    // (`green | red | absent`) and lives in `services/ticket-completion-evidence.ts`.
    // `not_run` is narrowed to `absent` HERE, which is fail-closed by construction —
    // it is never narrowed to a pass shape. The permissive policy for an unrun gate
    // is applied one level up, in `guardCompletionCommitBeforeDone`, which routes a
    // `not_run` verdict to the gate-exempt decision kind before this ctx is ever
    // consulted. Any OTHER consumer of this ctx therefore inherits fail-closed
    // behaviour by default rather than a manufactured green.
    workerGateVerdict: () => {
      const resolved = resolveWorkerGateVerdict(args.sessionDir, args.ticketId, args.workingDir);
      return resolved.verdict === 'not_run'
        ? { verdict: 'absent' as const, computedVia: resolved.computedVia }
        : { verdict: resolved.verdict, computedVia: resolved.computedVia };
    },
    announcedSha: () => readAnnouncedCompletionSha(args.sessionDir, args.ticketId),
    zeroDiffIntent: () => readDeclaredZeroDiffIntent(args.sessionDir, args.ticketId),
  };
}

/**
 * B-GTRUTH WS-A1: render a guard's completion SHA for a log line. A declared
 * zero-diff accept legitimately has none, and this is the ONE place that absence is
 * spelled out — keeping the `??` out of the three call sites' cyclomatic budgets.
 */
function formatCompletionCommitForLog(sha: string | null | undefined): string {
  return sha ?? 'none (declared zero-diff)';
}

/**
 * B-GTRUTH WS-A1: read the ticket's DECLARED `zero_diff_intent` frontmatter field,
 * raw. Deliberately does NOT validate the value — membership in the recognized set
 * is the oracle's policy (`ZERO_DIFF_INTENTS` in ticket-completion-evidence.ts), so
 * this stays pure wiring and the single-seam invariant holds. Best-effort: an
 * unreadable ticket yields null (no declaration → no zero-diff arm).
 */
function readDeclaredZeroDiffIntent(sessionDir: string, ticketId: string): string | null {
  try {
    const raw = fs.readFileSync(ticketFilePath(sessionDir, ticketId), 'utf8');
    return readFrontmatterField(raw, 'zero_diff_intent');
  } catch {
    return null;
  }
}

/**
 * B-OFFREPO (AC-OFFREPO-1): the greppable discriminator on the residual event a
 * did-not-run gate emits instead of reporting a pass.
 */
export const WORKER_GATE_NOT_RUN_REASON = 'worker_gate_not_run';

/**
 * B-OFFREPO (AC-OFFREPO-2c): the greppable discriminators on the residual an
 * ADVISORY target-repo `red` emits.
 *
 * A `not_run` gate could not run at all; an advisory `red` RAN and FAILED. Those
 * are different facts, so they file under different reasons — the residual is the
 * only place either one is visible, and recording a red as `not_run` claims a gate
 * never ran when it ran and rejected the code.
 */
export const WORKER_GATE_TARGET_REPO_RED_REASON = 'worker_gate_target_repo_red';
export const WORKER_GATE_TARGET_REPO_COMPUTED_VIA = 'target_repo_gate';

/**
 * B-OFFREPO (AC-OFFREPO-1): record that a gate did not run.
 *
 * A `not_run` gate neither blocks the Done flip nor halts the pipeline, so
 * without this the fact would be invisible — which is how a not-run green
 * survived unnoticed in the first place. It reuses the already-registered
 * `gate_skipped` event rather than inventing a name: `writeActivityEntry`
 * rejects unregistered events, `gate_skipped` already means "a gate did not run",
 * and it already carries heterogeneous payloads from `convergence-gate.ts` and
 * `pipeline-runner.ts`. Best-effort — telemetry never blocks a Done flip.
 */
export function emitWorkerGateNotRunResidual(
  statePath: string,
  ticketId: string,
  detail: { computedVia: string; site: string; verdict?: string; reason?: string },
): void {
  try {
    const ts = new Date();
    const activityDir = path.join(getDataRoot(), 'activity');
    fs.mkdirSync(activityDir, { recursive: true });
    const event = {
      event: 'gate_skipped' as const,
      ts: ts.toISOString(),
      ticket_id: ticketId,
      gate_payload: {
        source: 'worker_gate',
        reason: detail.reason ?? WORKER_GATE_NOT_RUN_REASON,
        verdict: detail.verdict ?? 'not_run',
        computed_via: detail.computedVia,
        site: detail.site,
      },
    };
    fs.appendFileSync(
      path.join(activityDir, `${formatLocalDateKey(ts)}.jsonl`),
      `${JSON.stringify(event)}\n`,
      { mode: 0o600 },
    );
  } catch { /* best-effort — a residual must never block the action it annotates */ }
}

/**
 * B-OFFREPO (AC-OFFREPO-2c): the reason a target-repo gate result is ADVISORY at
 * the Done-flip policy.
 *
 * `resolveWorkerGateVerdict` is persisted-wins, so once the worker gate actually
 * RUNS off-repo (AC-OFFREPO-2a) a genuine `red` from the target's own suite is
 * read back on every Done-flip path — and `red` is fail-closed. Left alone, that
 * means one failing test in a target repo REFUSES the Done flip on every ticket
 * and halts the pipeline: a gate stopping the system, which is exactly what this
 * bundle exists to remove.
 *
 * So the verdict stays HONEST (`red` is persisted and returned as `red`; nothing is
 * laundered into a pass) and the permissiveness lives here, in the Done-flip
 * POLICY — the same split ticket 10 chose for `not_run`, and the same one
 * `resolveWorkerGateVerdict`'s own comment names as the right home for it.
 *
 * Off-repo-ness is DERIVED from the existing `<workingDir>/extension` probe that
 * this file already uses to answer the same question. No new frontmatter field, no
 * fourth verdict value, no schema change.
 *
 * pickle-rick's OWN red keeps fail-closing: its `extension/` exists, so this
 * returns false and the R-CWGE refusal path below is untouched.
 */
export function isAdvisoryWorkerGateVerdict(
  verdict: 'green' | 'red' | 'absent' | 'not_run',
  workingDir: string,
): boolean {
  if (verdict === 'not_run') return true;
  if (verdict !== 'red') return false;
  // A `red` authored by a target repo's own toolchain is a finding to FLAG, not a
  // refusal to issue. `absent` is deliberately excluded — that is "the gate never
  // reported", which stays fail-closed everywhere.
  return !fs.existsSync(path.join(workingDir, 'extension'));
}

/**
 * B-OFFREPO (AC-OFFREPO-2c): the residual detail for a verdict the Done-flip
 * policy treats as ADVISORY — the companion to `isAdvisoryWorkerGateVerdict`,
 * which decides IF a verdict is advisory while this decides WHAT is recorded.
 *
 * Both advisory authorities — `guardCompletionCommitBeforeDone` here and
 * `resumeReattachDoneRefusal` in `setup.ts` — derive the same reason /
 * `computed_via` pair from the same single question, so they derive it ONCE,
 * here. Hand-copying the pair is how the two facts drift: the `not_run` half
 * already earned `WORKER_GATE_NOT_RUN_REASON` for exactly this reason, and its
 * advisory-red sibling is the same contract with the same two consumers.
 */
export function advisoryWorkerGateResidualDetail(
  verdict: string,
  site: string,
): { computedVia: string; site: string; verdict: string; reason: string } {
  const targetRepoRed = verdict === 'red';
  return {
    computedVia: targetRepoRed ? WORKER_GATE_TARGET_REPO_COMPUTED_VIA : 'not_applicable',
    site,
    verdict,
    reason: targetRepoRed ? WORKER_GATE_TARGET_REPO_RED_REASON : WORKER_GATE_NOT_RUN_REASON,
  };
}

export function guardCompletionCommitBeforeDone(args: {
  sessionDir: string;
  ticketId: string;
  workingDir: string;
  flags?: Record<string, unknown> | null;
  /** R-CCGR: backoff (ms) before the single re-read; pass 0 in test fixtures. */
  rereadBackoffMs?: number;
  /**
   * R-PDUP sanctioned twin-borrow: extra ticket ids treated as own attribution
   * by the R-OMA foreign check. ONLY the split-original auto-close passes this
   * (the borrowed twin sha's message names the twin, not the original).
   */
  ownAttributionTokens?: string[];
}): (
  { ok: true; sha: string | null; testsVerdict: 'green' | 'red' | 'not_run' | null }
  | { ok: false; reason: string; source: CompletionCommitEvidence['source']; testsVerdict: 'green' | 'red' | 'not_run' | null }
) {
  // WS-A (2e77f26e): one predicate for the test dimension, consumed by BOTH
  // Done-flip authorities (this guard and setup.ts's resumeReattachDoneRefusal).
  // Recorded on the result for callers; a red verdict never flips `ok` to
  // false here — see the root CLAUDE.md no-stopping-gates rule.
  const testsVerdict = readTicketWorkerGateTestsVerdict(args.sessionDir, args.ticketId);
  // R-WSRC-4 parity: PICKLE_TEST_MODE=1 bypasses for sandboxed test fixtures
  // whose workingDir is a synthetic temp dir without a real git repo.
  // Production sessions never set this env var; production guard is intact.
  if (process.env.PICKLE_TEST_MODE === '1') {
    return { ok: true, sha: 'pickle-test-mode-bypass', testsVerdict };
  }
  // B-1SEAM WS-1: the ladder (readEvidence → R-CCGR backoff re-read → R-CCEM
  // announcement recovery → R-WUWC persistEvidence promote-once → R-CWGE
  // worker-gate verdict fail-closed) lives in evaluateCompletionEvidence; this
  // guard only wires the runtime ctx and maps the decision back to the legacy
  // {ok…}/{ok:false, reason, source} shape callers and tests pin.
  // B-OFFREPO (AC-OFFREPO-1): a gate that COULD NOT RUN is neither a pass nor a
  // refusal. The completion predicate only understands `green | red | absent`, and
  // `absent` is fail-closed — so routing `not_run` through the normal 'done-flip'
  // consult would REFUSE the flip, i.e. a gate stopping the pipeline. Instead the
  // gate consult is skipped by evaluating under the EXISTING gate-exempt decision
  // kind ('phantom-watch' is 'done-flip' minus the verdict check — same evidence
  // ladder, same promote-once, same sha), and the unverified state is recorded as a
  // residual event rather than laundered into a green. The red / absent
  // fail-closed path below is untouched.
  // B-OFFREPO (AC-OFFREPO-2c): the gate-exempt route now also covers a `red`
  // authored by a TARGET repo's own toolchain. Once the gate actually runs
  // off-repo, a raw target-repo red would otherwise fail-close this guard and halt
  // the pipeline on every ticket — see `isAdvisoryWorkerGateVerdict`. pickle-rick's
  // own red still takes the fail-closed path below.
  const resolvedGate = resolveWorkerGateVerdict(args.sessionDir, args.ticketId, args.workingDir);
  const gateAdvisory = isAdvisoryWorkerGateVerdict(resolvedGate.verdict, args.workingDir);
  const decision = evaluateCompletionEvidence(buildCompletionCtx({
    sessionDir: args.sessionDir,
    ticketId: args.ticketId,
    workingDir: args.workingDir,
    rereadBackoffMs: args.rereadBackoffMs,
    ownAttributionTokens: args.ownAttributionTokens,
  }, gateAdvisory ? 'phantom-watch' : 'done-flip'));
  if (gateAdvisory) {
    emitWorkerGateNotRunResidual(
      path.join(args.sessionDir, 'state.json'),
      args.ticketId,
      advisoryWorkerGateResidualDetail(resolvedGate.verdict, 'guardCompletionCommitBeforeDone'),
    );
  }
  if (decision.ok) {
    // B-GTRUTH WS-A1 shape mapping ONLY: a declared zero-diff accept has no SHA, so
    // it maps to `sha: null`. No decision is taken here — the arm and all three of
    // its conditions live in evaluateCompletionEvidence (AC-GTRUTH-A1-5).
    return { ok: true, sha: decision.sha ?? null, testsVerdict };
  }
  if (decision.reason === 'worker_gate_red' || decision.reason === 'worker_gate_unavailable') {
    const gate = decision.gate ?? { verdict: 'absent' as const, computedVia: 'unavailable' };
    // AC-CWGE-4/6: fail-closed. Emit the observability event, then refuse the Done-flip.
    try {
      writeActivityEntry(path.join(args.sessionDir, 'state.json'), {
        event: 'worker_gate_verdict_fail_closed',
        ts: new Date().toISOString(),
        ticket_id: args.ticketId,
        gate_payload: { verdict: gate.verdict, computed_via: gate.computedVia },
      });
    } catch { /* best-effort */ }
    return {
      ok: false,
      // Evidence was committed when the verdict refused — legacy source mapping.
      source: 'explicit-reachable',
      reason: `ticket ${args.ticketId} cannot flip Done: worker_gate_verdict='${gate.verdict}' (computed_via=${gate.computedVia}). ` +
        `Done requires a GREEN worker-gate verdict (eslint+tsc); a red or absent/unverifiable verdict is fail-closed (R-CWGE).`,
      testsVerdict,
    };
  }
  return {
    ok: false,
    source: 'absent',
    reason: `ticket ${args.ticketId} cannot flip Done: readEvidence().kind === 'absent' (expected 'committed'); ` +
      `worker did not produce an attributable git commit. Edit ticket frontmatter to include completion_commit: <sha>.`,
    testsVerdict,
  };
}

export function hasSubstantiveManagerHandoff(content: string): boolean {
  const match = /^##\s+Manager Handoff\b[ \t]*\n?([\s\S]*?)(?=^##\s+|$(?![\s\S]))/m.exec(content);
  if (!match) return false;
  const body = match[1].trim();
  if (!body) return false;
  const firstNonEmptyLine = body
    .split(/\n/)
    .map(l => l.replace(/^[-*+]\s+/, '').trim())
    .find(l => l.length > 0) ?? '';
  // First non-empty line starting with "none", "n/a", "na", "nothing" → no handoff,
  // regardless of any explanatory text on subsequent lines or on the same line.
  if (/^(none|n\/a|na|nothing)\b/i.test(firstNonEmptyLine)) return false;
  // Explicit no-handoff phrasings ("No `[manager]` criteria in this ticket",
  // "No manager items", "No handoff needed") are boilerplate, not a deferred item.
  // Workers write the `## Manager Handoff` header unconditionally; only a real
  // deferred item is a halt trigger. Bounded to the first clause ([^.\n]{0,40}) so a
  // genuine handoff that merely happens to start with "No" cannot be misclassified.
  if (/^no\b[^.\n]{0,40}\b(manager|criteria|handoff|items?|deferred)\b/i.test(firstNonEmptyLine)) return false;
  return true;
}

function readLatestTicketConformanceSnapshot(ticketDir: string): TicketConformanceSnapshot {
  let entries: string[];
  try {
    entries = fs.readdirSync(ticketDir);
  } catch {
    return { file: null, hasManagerHandoff: false };
  }
  const latest = entries
    .filter(file => /^conformance_.*\.md$/.test(file))
    .sort()
    .at(-1);
  if (!latest) return { file: null, hasManagerHandoff: false };
  try {
    const content = fs.readFileSync(path.join(ticketDir, latest), 'utf-8');
    return {
      file: latest,
      hasManagerHandoff: hasSubstantiveManagerHandoff(content),
    };
  } catch {
    return { file: latest, hasManagerHandoff: false };
  }
}

function readCloserHandoffBudget(extensionRoot: string): number {
  const settings = loadSettingsBag(extensionRoot, 'mux-runner:closer-handoff-budget:settings');
  return positiveIntegerOrNull(settings.closer_handoff_iteration_budget) ?? 2;
}

export function evaluateCloserTerminalState(args: {
  state: State;
  sessionDir: string;
  workingDir: string;
  headSha: string | null;
  failedBudget: number;
}): CloserTerminalDecision {
  const ticketId = args.state.current_ticket;
  if (!ticketId) return { action: 'continue', tracker: null };
  let status: string;
  try {
    status = normalizeTicketStatus(getTicketStatus(args.sessionDir, ticketId));
  } catch {
    return { action: 'continue', tracker: null };
  }
  const ticketDir = path.join(args.sessionDir, ticketId);
  const conformance = readLatestTicketConformanceSnapshot(ticketDir);
  if (status === 'done' && conformance.hasManagerHandoff) {
    return {
      action: 'exit',
      reason: 'manager_handoff_pending',
      tracker: null,
      detail: `ticket ${ticketId} is Done and ${conformance.file ?? 'latest conformance artifact'} contains a Manager Handoff section`,
    };
  }
  if (status !== 'failed') return { action: 'continue', tracker: null };

  const headSha = args.headSha ?? observeCurrentHead(args.workingDir)?.sha ?? null;
  if (!headSha) {
    return { action: 'continue', tracker: null };
  }
  const prior = (args.state as MuxRunnerStateWithCloserTracker).closer_handoff_tracker;
  const consecutive = prior && prior.ticket_id === ticketId && prior.head_sha === headSha
    ? prior.consecutive_failed_iterations + 1
    : 1;
  const tracker: CloserHandoffTracker = {
    ticket_id: ticketId,
    head_sha: headSha,
    consecutive_failed_iterations: consecutive,
  };
  if (consecutive >= args.failedBudget) {
    return {
      action: 'exit',
      reason: 'closer_handoff_terminal',
      tracker,
      detail: `ticket ${ticketId} remained Failed on HEAD ${headSha} for ${consecutive}/${args.failedBudget} consecutive iterations`,
    };
  }
  return { action: 'continue', tracker };
}

function persistCloserHandoffTracker(statePath: string, tracker: CloserHandoffTracker | null): void {
  sm.update(statePath, rawState => {
    const state = rawState as MuxRunnerStateWithCloserTracker;
    if (tracker) state.closer_handoff_tracker = tracker;
    else delete state.closer_handoff_tracker;
  });
}

function exitForCloserTerminalState(
  statePath: string,
  sessionDir: string,
  iteration: number,
  decision: Extract<CloserTerminalDecision, { action: 'exit' }>,
  log: (msg: string) => void,
): ExitReason {
  recordExitReason(statePath, decision.reason);
  safeDeactivate(statePath);
  const activityEntry = {
    event: 'session_end',
    source: 'pickle',
    session: path.basename(sessionDir),
    iteration,
    ticket: decision.tracker?.ticket_id,
    reason: decision.detail,
    terminal_exit_reason: decision.reason,
  } as const;
  writeActivityEntry(statePath, activityEntry);
  logActivity(activityEntry);
  log(`${decision.reason}: ${decision.detail}. Exiting at iteration ${iteration}.`);
  return decision.reason;
}

// ---------------------------------------------------------------------------
// R-ORSR-2 — RecoveryController runtime adapters
//
// The controller (services/recovery-controller.ts) is dependency-injected; these
// adapters bind its callbacks to the real runtime. Every no-progress / handoff /
// self-terminate seam routes its decision through the W4a choke point
// `routeRecoveryBeforeTerminal`: the original
// THREE terminal authorities — (1) closer_handoff_terminal, (2) codex
// manager-no-progress, (3) wmw-auto-skip (oversized_no_progress) — plus the W4a
// additions (4) timeout_repeat and (5) idle_stall_unrecoverable. The DECISION (the
// `runRecoveryLadder` invocation) lives ONLY in `attemptRecoveryBeforeTerminal`; new
// halt sites MUST route through `routeRecoveryBeforeTerminal`, never park directly.
// (See mux-runner-fix-b.test.js L6 + halt-or-recover-choke-point.test.js.)
// `commitAndContinueDoneFlip` is one of the `guardCompletionCommitBeforeDone`
// + `clearStaleDoneWithoutCommitEvidence` pairs (R-PEDC parity — one clear per
// guard-pass branch; 7 pairs after B-1SEAM added the R-PDUP auto-close pair).
// ---------------------------------------------------------------------------

export interface CommitAndContinueDoneFlipInput {
  sessionDir: string;
  ticketId: string;
  workingDir: string;
  statePath: string;
  flags: Record<string, unknown> | null;
  log: (msg: string) => void;
  /**
   * Optional ownership-scoped staging (M1). When provided (non-empty), `git add`
   * stages exactly these repo-relative paths. Absent → the committer falls back to
   * a whole-tree `git add -A` carrying `CODEGRAPH_PATHSPEC_EXCLUDES`
   * (AP-EXT-ITER6-01). That fallback performs NO ownership partition — the
   * recovery-ladder rung-1 caller `attemptRecoveryBeforeTerminal` passes no
   * `stagePaths`, so every non-codegraph dirty path lands under this ticket's
   * `completion_commit`. Collapsing the exit-path `salvageDirtyTree` partition
   * into this committer is the open fix (AP-EXT-ITER6-01 OPEN GAP).
   */
  stagePaths?: readonly string[];
  /**
   * Round 2 (92e33eb3, AC-R2-3): separates the COMMIT action from the DONE-FLIP
   * action for the recovery-ladder rung-1 caller. `guardCompletionCommitBeforeDone`
   * legitimately flips Done on a `not_run` verdict for a WORKER's own commit (a
   * target repo with no JS gate to run — AC-3 in
   * worker-gate-not-run-invariant.test.js). But rung 1's commit is a runner-driven
   * recovery action over whatever the tree happens to hold, not a worker's
   * declaration of completion; nobody has verified the diff is done. Defaulting to
   * `true` preserves every other caller's existing behavior. `false` (set only by
   * `attemptRecoveryBeforeTerminal`) withholds `markTicketDone` — and the
   * `completion_commit` stamp that follows it — when the resolved gate verdict is
   * `not_run`, while still returning `ok: true` so the ladder records `advanced`
   * (SITE 4, worker-gate-not-run-invariant.test.js).
   */
  allowDoneWhenGateNotRun?: boolean;
}

/**
 * Rung-1 committer: stage the dirty tree, commit referencing the ticket id, then
 * flip the ticket Done through the R-PEDC guard/clear pair. Atomic by
 * construction — a failed `git commit` (e.g. refused by the
 * R-WSRC config-protection hook) returns `{ ok: false }` with nothing flipped, so
 * the ladder falls through to fix-forward-trivial rather than leaving a half-commit.
 */

function muxRealpathOrSelf(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

/** R-WSRC-4: assert workingDir resolves under os.tmpdir() when PICKLE_TEST_MODE=1. No-op in production. */
function assertWorkingDirUnderTmpdirIfTestMode(workingDir: string): void {
  if (process.env.PICKLE_TEST_MODE !== '1') return;
  const tmpdirRealpath = muxRealpathOrSelf(os.tmpdir());
  const resolved = muxRealpathOrSelf(workingDir);
  const under = resolved === tmpdirRealpath || resolved.startsWith(tmpdirRealpath + path.sep);
  if (!under) throw new Error(
    `R-WSRC-4: PICKLE_TEST_MODE=1 but workingDir is outside os.tmpdir() (${tmpdirRealpath}): ${workingDir}. ` +
    `Test fixtures must root working_dir under os.tmpdir() to prevent git mutations against the real repo.`,
  );
}

/**
 * B-CWGE: record the proven-green worker-gate verdict for a RUNNER-AUTHORED
 * commit (callers gate with the armed #99 gate before reaching the committer).
 * Mirrors spawn-morty's `persistWorkerGateVerdict`; extracted so
 * `commitAndContinueDoneFlip` stays within the complexity budget. Best-effort:
 * the ticket frontmatter lives under the session root (untouched by the
 * gate-fail tree reset); the Done-flip guard treats an absent verdict as
 * fail-closed, so a write hiccup degrades safely.
 *
 * B-OFFREPO (AC-OFFREPO-1): `gateWorkingDir`, when provided, is checked for an
 * `extension/` tree — the armed gate's actual precondition for having run at
 * all. Absent it, no verdict was earned, so this is a no-op (the caller may
 * still commit and let `guardCompletionCommitBeforeDone`'s honest `not_run`
 * route judge the flip on real evidence). Omitting `gateWorkingDir` preserves
 * the unconditional stamp for callers that already gate on `extension/`
 * existing before ever reaching this committer (`commitGatePassingDeliverableOnExitPath`).
 */
function persistRunnerAuthoredGreenVerdict(sessionDir: string, ticketId: string, gateWorkingDir?: string): void {
  if (gateWorkingDir !== undefined && !fs.existsSync(path.join(gateWorkingDir, 'extension'))) return;
  try {
    const fp = ticketFilePath(sessionDir, ticketId);
    const raw = fs.readFileSync(fp, 'utf8');
    const upd = upsertFrontmatterField(raw, WORKER_GATE_VERDICT_FIELD, 'green');
    if (upd) fs.writeFileSync(fp, upd);
  } catch { /* best-effort — guard treats an absent verdict as fail-closed */ }
}

/**
 * Idempotence oracle: does `message` ALREADY carry a parsed `Pickle-Ticket` trailer?
 *
 * KEY-PRESENCE, not value-equality — the same policy the other two producers hold
 * (`git-trailer-hooks.ts`'s `grep -q '^Pickle-Ticket:'` over the parsed view, and
 * spawn-morty's `trailers.length > 0` in `maybeAmendTicketTrailer`). A value-match
 * guard would let a DIFFERENT-id trailer fall through to the writer, and
 * `addIfDifferentNeighbor` ADDS a second value whenever the existing trailer is not
 * the appended one's neighbor — adjacency is the whole test, so identical values
 * duplicate too:
 *
 *   subject                          subject
 *                          ->
 *   Pickle-Ticket: a1           Pickle-Ticket: a1
 *   Co-Authored-By: X           Co-Authored-By: X
 *                               Pickle-Ticket: a1
 *
 * The consumer cannot read that shape as attribution at all: `parseTrailerLog`
 * (`ticket-completion-evidence.ts`) joins every emitted value line into ONE
 * `trailerValue`, and `scanGitLogByTrailer` compares it whole — `'a1\na1' !== 'a1'`.
 * A commit carrying the ticket's trailer twice reads as carrying it zero times, and
 * that scan is `readEvidence`'s only git-log arm.
 *
 * Asked via `interpret-trailers --parse` so producer guard and consumer reader share
 * one view; a whole-message regex is a second, drifting parser (git takes trailers
 * from the LAST paragraph only, so a `Pickle-Ticket:` line in body prose would look
 * like attribution and suppress a stamp that is genuinely needed).
 *
 * When the parse cannot run, DEGRADE TOWARD STAMPING. The hook degrades the other
 * way — it edits the commit-message file in place, where a double stamp is
 * unrecoverable — while this function only renders a string its callers commit, and
 * every caller passes a freshly built message. Opposite failure costs, opposite
 * postures; the divergence is deliberate.
 */
function messageAlreadyCarriesTicketTrailer(workingDir: string, message: string): boolean {
  const parsed = silentDeathGit(['interpret-trailers', '--parse'], workingDir, message);
  if (parsed === null) {
    return false;
  }
  return parsed.split('\n').some((line) => line.startsWith('Pickle-Ticket:'));
}

/**
 * `git interpret-trailers` only reliably recognizes a trailing trailer block when its input
 * ends in a newline; both the `--parse` probe and the `--if-exists` writer in
 * `stampPickleTicketTrailer` need this, so normalize once, here, rather than at each call site.
 * Collapses any run of trailing newlines to exactly one — never adds more than one, never
 * leaves the input unterminated.
 */
function normalizeTrailerInputNewline(message: string): string {
  return message.replace(/\n*$/, '\n');
}

/**
 * Render `message` carrying a parsed `Pickle-Ticket: <ticketId>` trailer.
 *
 * The runner authors some commits IN-PROCESS, so they never see the `prepare-commit-msg`
 * hook that `backend-spawn.ts` wires into worker subprocesses — and `readEvidence`'s only
 * git-log arm is `scanGitLogByTrailer`, an exact match against git's PARSED trailer view.
 * A ticket id in the subject is exactly the signal B-GITATTR WS-3 deleted, so an unstamped
 * runner commit is unattributable.
 *
 * Written with `git interpret-trailers` — git's own trailer WRITER, symmetric with the
 * `%(trailers:...)` READER the consumer uses. A bare appended `\nPickle-Ticket: …` is NOT
 * equivalent: git parses trailers out of the LAST paragraph only, so an unconditional
 * append opens a NEW paragraph and silently demotes every pre-existing trailer
 * (`Co-Authored-By`, `Signed-off-by`) to body prose — still visible in `%B`, invisible to
 * `%(trailers:…)`. That append survives only as the degraded arm: if `interpret-trailers`
 * cannot run, keep attribution rather than dropping it (same posture as the hook's `printf`
 * fallback in `git-trailer-hooks.ts` and spawn-morty's two-`-m` amend fallback).
 *
 * The spawn goes through `silentDeathGit` because that helper already carries the finite
 * timeout bin/ subsystem invariant #3 requires; never throws, so the commit is never blocked.
 *
 * An empty or whitespace-only `ticketId` returns `message` UNCHANGED. Both arms would
 * otherwise write a valueless `Pickle-Ticket:` line into history — `interpret-trailers`
 * emits the bare key for `--trailer 'Pickle-Ticket: '`, and the degraded append does the
 * same by construction. That is why the guard sits above the `trailer` literal rather than
 * around the spawn. This is the sibling of the hook's `_pickle_ticket_id_probe` no-op
 * (`git-trailer-hooks.ts`), which records the same valueless line as a shipped defect; like
 * the hook, the probe is a guard INPUT only — a non-empty id is written verbatim, since the
 * consumer trims its own ends and silently rewriting an operator's id is not ours to do.
 */
export function stampPickleTicketTrailer(workingDir: string, message: string, ticketId: string): string {
  if (ticketId.replace(/\s+/g, '') === '') {
    return message;
  }
  const normalized = normalizeTrailerInputNewline(message);
  if (messageAlreadyCarriesTicketTrailer(workingDir, normalized)) {
    return message;
  }
  const trailer = `Pickle-Ticket: ${ticketId}`;
  const rendered = silentDeathGit(
    ['interpret-trailers', '--if-exists', 'addIfDifferentNeighbor', '--trailer', trailer],
    workingDir,
    normalized,
  );
  return rendered ?? `${message}\n\n${trailer}`;
}

/**
 * AC-R2-3: true when the caller opted out of Done-on-not_run
 * (`allowDoneWhenGateNotRun: false`) AND the gate that would authorize the flip
 * never ran at all. Extracted out of `commitAndContinueDoneFlip` to keep that
 * function under the complexity budget.
 */
function shouldWithholdDoneFlipOnUnrunGate(input: CommitAndContinueDoneFlipInput): boolean {
  if (input.allowDoneWhenGateNotRun !== false) return false;
  return resolveWorkerGateVerdict(input.sessionDir, input.ticketId, input.workingDir).verdict === 'not_run';
}

/**
 * AC-R2-3: the DONE-FLIP half of `commitAndContinueDoneFlip`, split out so the
 * commit action (above) and the flip action (here) are visibly separate — and so
 * neither function trips the complexity budget. `guard.ok` is already true by the
 * time this runs; the only remaining decision is whether to withhold the flip.
 */
function finalizeDoneFlipAfterCommit(
  input: CommitAndContinueDoneFlipInput,
  guard: { sha: string | null },
): { ok: boolean; sha?: string } {
  if (shouldWithholdDoneFlipOnUnrunGate(input)) {
    input.log(`commit-and-continue: committed for ${input.ticketId} but withheld the Done flip — armed gate never ran (completion_commit: ${formatCompletionCommitForLog(guard.sha)})`);
    return { ok: true, sha: guard.sha ?? undefined };
  }
  clearStaleDoneWithoutCommitEvidence(input.statePath);
  if (markTicketDone(input.sessionDir, input.ticketId)) {
    input.log(`commit-and-continue: marked ${input.ticketId} Done (completion_commit: ${formatCompletionCommitForLog(guard.sha)})`);
  }
  // Persist completion_commit now that status is Done (mirrors applyAutoTicketCompletionValidation).
  try {
    const fp = ticketFilePath(input.sessionDir, input.ticketId);
    const raw = fs.readFileSync(fp, 'utf8');
    if (!readFrontmatterField(raw, 'completion_commit') && guard.sha) {
      const upd = upsertFrontmatterField(raw, 'completion_commit', guard.sha);
      if (upd) fs.writeFileSync(fp, upd);
    }
  } catch { /* best-effort — guard already proved evidence */ }
  return { ok: true, sha: guard.sha ?? undefined };
}

export function commitAndContinueDoneFlip(input: CommitAndContinueDoneFlipInput): { ok: boolean; sha?: string } {
  assertWorkingDirUnderTmpdirIfTestMode(input.workingDir);
  // M1: ownership-scoped staging when stagePaths is provided (exit-path commit);
  // otherwise the whole-tree add (Done-flip path).
  //
  // AP-EXT-ITER6-01: that whole-tree add MUST carry `CODEGRAPH_PATHSPEC_EXCLUDES`.
  // `.codegraph/` is the runtime's OWN regenerable index, written into
  // `<workingDir>/.codegraph/` and git-ignored only through the local, unversioned
  // `.git/info/exclude` — plain untracked dirt in any freshly-cloned target repo.
  // Every sibling staging path already excludes it (`archiveBeforeDestructive`,
  // `collectDirtyInScopePaths`, the exit-path committer) via `isCodegraphArtifact`;
  // this one did not, and the recovery-ladder rung-1 caller
  // (`attemptRecoveryBeforeTerminal`) passes no `stagePaths`, so it committed the
  // index into the target repo and stamped THAT commit as the ticket's
  // `completion_commit` on the Done flip. One shared exclusion, not a second guard.
  const addArgs = input.stagePaths && input.stagePaths.length > 0
    ? ['-C', input.workingDir, 'add', '--', ...input.stagePaths]
    : ['-C', input.workingDir, 'add', '-A', ...CODEGRAPH_PATHSPEC_EXCLUDES];
  const add = spawnSync('git', addArgs, { encoding: 'utf-8', timeout: 30000 });
  if (add.status !== 0) {
    input.log(`commit-and-continue: git add failed for ${input.ticketId} (status ${add.status ?? 'null'})`);
    return { ok: false };
  }
  const commitMsg = stampPickleTicketTrailer(
    input.workingDir,
    `fix(${input.ticketId}): commit-and-continue recovery (R-ORSR-2)`,
    input.ticketId,
  );
  const commit = spawnSync('git', ['-C', input.workingDir, 'commit', '-m', commitMsg], { encoding: 'utf-8', timeout: 30000 });
  if (commit.status !== 0) {
    input.log(`commit-and-continue: git commit blocked/failed for ${input.ticketId} (status ${commit.status ?? 'null'})`);
    return { ok: false };
  }
  // B-CWGE: runner-authored commit — when the caller's armed #99 gate actually ran
  // (extension/ present under workingDir) it already proved GREEN, so record that
  // verdict and let the guard honor it instead of re-running the full recompute
  // (which over-reaches on a toolchain-less salvage tree). Genuine worker
  // self-commits don't route here, so their fail-closed absent-verdict recompute
  // stays intact. See CLAUDE.md R-CWGE trap door.
  //
  // B-OFFREPO (AC-OFFREPO-1): a recovery-ladder caller may reach this committer
  // with the gate reported `not_run` (no extension/ — the target repo has no JS
  // worker gate to run at all). Stamping green there would be exactly the
  // fabricated-verdict bug B-OFFREPO fixed. `persistRunnerAuthoredGreenVerdict`
  // itself skips the stamp in that case; `guardCompletionCommitBeforeDone` below
  // already reads the absent verdict, resolves `not_run`, and honors it
  // permissively via its own gate-exempt decision kind — no fabrication needed.
  persistRunnerAuthoredGreenVerdict(input.sessionDir, input.ticketId, input.workingDir);
  const guard = guardCompletionCommitBeforeDone({
    sessionDir: input.sessionDir,
    ticketId: input.ticketId,
    workingDir: input.workingDir,
    flags: input.flags ?? {},
  });
  if (!guard.ok) {
    return { ok: false };
  }
  // AC-R2-3: commit action (above) and Done-flip action (here) are separate
  // functions — see `finalizeDoneFlipAfterCommit`.
  return finalizeDoneFlipAfterCommit(input, guard);
}

// ---------------------------------------------------------------------------
// R-MWIS-3 — commit a gate-passing uncommitted deliverable on the worker-exit /
// idle-stall recovery path.
//
// This is a WIRING module: it REUSES the existing #99 R-WCUC commit-before-failing
// behavior — the armed gate `runBetweenTicketFastTests` (only-passing, ignores
// skip-flags) plus the committer `commitAndContinueDoneFlip` (git add/commit +
// R-PEDC guard/clear + markTicketDone). It does NOT reimplement the gate or the
// commit. A silent (0-byte) worker exit or an idle-stall self-recovery that leaves
// a gate-passing deliverable in the tree no longer strands that work for manual
// recovery: it is committed before the loop advances / relaunches.
//
// Best-effort by construction: any throw → `{ committed:false, reason:'error' }`.
// Only gate-PASSING work is committed; gate-failing/clean/already-terminal cases
// are no-ops so the existing failure/skip/Done paths keep their behavior.
// ---------------------------------------------------------------------------

export interface CommitGatePassingDeliverableInput {
  sessionDir: string;
  statePath: string;
  workingDir: string;
  ticketId: string | null;
  extensionRoot: string;
  flags: Record<string, unknown> | null;
  log: (msg: string) => void;
  /** Test seam: defaults to the production #99 gate `runBetweenTicketFastTests`. */
  runGate?: (extensionDir: string, extensionRoot: string) => BetweenTicketGateResult;
}

export type CommitGatePassingDeliverableReason =
  | 'no-ticket'
  | 'already-terminal'
  | 'clean-tree'
  | 'clean-ticket-tree'
  | 'no-extension-dir'
  | 'gate-failed'
  | 'committed'
  | 'commit-failed'
  | 'error';

/**
 * M1 (R-MWIS-3 / R-WCUC ownership pre-check): partition the working-tree dirty
 * paths into work OWNED by `ticketId` versus work that belongs to a DIFFERENT
 * ticket's session directory.
 *
 * The exit-path committer reuses `commitAndContinueDoneFlip`, whose `git add -A`
 * would otherwise stage the WHOLE dirty tree under `ticketId` — misattributing a
 * lagging sibling ticket's work when the session dir is shared (e.g. pickle-rick
 * self-build, where ticket artifacts under `<sessionDir>/<otherTicketId>/` are
 * tracked in the same repo).
 *
 * A dirty path is FOREIGN iff it resolves under `<sessionDir>/<otherTicketId>/`
 * for some ticket id other than `ticketId`; everything else (source deliverables,
 * the current ticket's own artifacts) is OWNED. This is deliberately conservative:
 * it never strands a source-file deliverable, it only refuses to commit work it
 * can positively attribute to another ticket.
 */
export function partitionExitPathDirtyByOwnership(
  dirtyPaths: readonly string[],
  workingDir: string,
  sessionDir: string,
  ticketId: string,
  allTicketIds: readonly string[],
): { owned: string[]; foreign: string[] } {
  // Absolute prefixes of OTHER tickets' session dirs (with trailing separator).
  const foreignPrefixes = allTicketIds
    .filter(id => id && id !== ticketId)
    .map(id => path.resolve(sessionDir, id) + path.sep);
  const owned: string[] = [];
  const foreign: string[] = [];
  for (const rel of dirtyPaths) {
    const abs = path.resolve(workingDir, rel);
    if (foreignPrefixes.some(prefix => abs.startsWith(prefix))) {
      foreign.push(rel);
    } else {
      owned.push(rel);
    }
  }
  return { owned, foreign };
}

// B-1SEAM WS-3 (R-MACB): `stashUnattributableRemainder` moved verbatim to the
// shared dirty-tree salvage seam (`services/dirty-tree-salvage.ts`) so the
// microverse rescue path shares the exact B-PCOMP (#b736337f) mechanism.
// Re-exported here to preserve the `../bin/mux-runner.js` import surface
// (exit-path-bystander-stash.test.js + Module Export Catalog).
export { stashUnattributableRemainder };

export interface CommitGatePassingDeliverableResult {
  committed: boolean;
  reason: CommitGatePassingDeliverableReason;
  sha?: string;
}

export function commitGatePassingDeliverableOnExitPath(
  input: CommitGatePassingDeliverableInput,
): CommitGatePassingDeliverableResult {
  const { sessionDir, statePath, workingDir, ticketId, extensionRoot, flags, log } = input;
  const gate = input.runGate ?? runBetweenTicketFastTests;
  try {
    if (!ticketId) return { committed: false, reason: 'no-ticket' };
    // The model-driven Done flip (worker self-attested) is handled by the existing
    // guardCompletionCommitBeforeDone callsite — don't double-commit it here.
    if (isTerminalTicketStatus(getTicketStatus(sessionDir, ticketId))) {
      return { committed: false, reason: 'already-terminal' };
    }
    if (!isWorkingTreeDirty(workingDir)) return { committed: false, reason: 'clean-tree' };
    const extensionDir = path.join(workingDir, 'extension');
    if (!fs.existsSync(extensionDir)) return { committed: false, reason: 'no-extension-dir' };
    // M1: ownership pre-check. The shared committer would `git add -A` the whole
    // dirty tree under `ticketId`; on a shared working dir that misattributes a
    // lagging sibling ticket's work. Partition the dirty set and refuse to commit
    // when NOTHING is owned by this ticket; otherwise stage ONLY owned paths.
    let stagePaths: string[] | undefined;
    try {
      const dirtyPaths = listWorkingTreeDirtyPaths(workingDir);
      const allTicketIds = collectTickets(sessionDir).map(t => t.id).filter((id): id is string => Boolean(id));
      const { owned, foreign } = partitionExitPathDirtyByOwnership(dirtyPaths, workingDir, sessionDir, ticketId, allTicketIds);
      if (owned.length === 0) {
        log(`[exit-commit] ticket ${ticketId}: no ticket-owned dirty work (${foreign.length} foreign path(s)) — not committing under this ticket`);
        return { committed: false, reason: 'clean-ticket-tree' };
      }
      // B-PCOMP: when there is an un-attributable dirty remainder, NEVER fall back
      // to the whole-tree add (that would commit a sibling ticket's work under this
      // ticket's completion_commit — a false Done, worse than losing the work).
      // The shared salvage seam (B-1SEAM WS-3) stashes the remainder to a
      // self-describing git ref (recoverable, schema-neutral) and returns ONLY the
      // positively-owned paths as stageable.
      if (foreign.length > 0) {
        const plan = salvageDirtyTree({ workingDir, sessionDir, owned, foreign, log });
        stagePaths = plan.stagePaths;
        log(`[exit-commit] ticket ${ticketId}: staging ${owned.length} owned path(s), stashed ${foreign.length} un-attributable path(s)`);
      }
    } catch (err) {
      // B-PCOMP: the ownership probe failed, so we cannot positively attribute ANY
      // dirty path to this ticket. Refuse the over-staging whole-tree fallback:
      // stash the entire dirty remainder to the recoverable ref and do NOT commit
      // it as this ticket's Done.
      log(`[exit-commit] ownership probe failed for ${ticketId}: ${safeErrorMessage(err)}`);
      stashUnattributableRemainder(workingDir, sessionDir, log);
      return { committed: false, reason: 'clean-ticket-tree' };
    }
    // REUSE the existing #99 armed gate — only commit gate-PASSING work.
    const gateResult = gate(extensionDir, extensionRoot);
    if (!gateResult.ok) {
      log(`[exit-commit] ticket ${ticketId}: gate not green — leaving uncommitted work for the failure/skip path`);
      return { committed: false, reason: 'gate-failed' };
    }
    // REUSE the existing #99 committer (git add/commit + R-PEDC guard + Done flip).
    const r = commitAndContinueDoneFlip({ sessionDir, ticketId, workingDir, statePath, flags, log, stagePaths });
    if (r.ok) {
      log(`[exit-commit] ticket ${ticketId}: committed gate-passing deliverable (completion_commit: ${r.sha})`);
      return { committed: true, reason: 'committed', sha: r.sha };
    }
    return { committed: false, reason: 'commit-failed' };
  } catch (err) {
    log(`[exit-commit] threw (ignored): ${safeErrorMessage(err)}`);
    return { committed: false, reason: 'error' };
  }
}

export interface BoundaryCommitInput {
  sessionDir: string;
  statePath: string;
  workingDir: string;
  ticketId: string | null;
  extensionRoot: string;
  flags: Record<string, unknown> | null;
  /** HEAD sha captured immediately before the worker spawn (iteration baseline). */
  preIterSha: string | null;
  log: (msg: string) => void;
  /** Test seam: defaults to the production #99 gate `runBetweenTicketFastTests`. */
  runGate?: (extensionDir: string, extensionRoot: string) => BetweenTicketGateResult;
}

export type BoundaryCommitOutcome = 'committed' | 'attributed' | 'honest_failure';

export interface BoundaryCommitResult {
  outcome: BoundaryCommitOutcome;
  /** Reason from the underlying exit-path committer when outcome === 'committed'/'honest_failure'. */
  reason?: CommitGatePassingDeliverableReason | 'head-moved-untagged' | 'no-op-head-moved' | 'no-ticket';
  sha?: string;
}

/**
 * B-DURA T10 (AC-DURA-1/2/8): commit the ticket's gate-passing work at the NORMAL
 * iteration boundary — before context is cleared — instead of only on the
 * salvage/cap/fatal exit path.
 *
 * One decidable trichotomy, keyed on HEAD movement (NOT tree dirtiness, so an
 * untracked `research_*.md`/`plan_*.md` artifact that leaves the tree dirty must
 * NOT defeat the no-op):
 *   - HEAD moved off `preIterSha` (the worker already committed):
 *       - if a present, git-reachable `completion_commit:` already attributes the
 *         commit → no-op (outcome 'attributed', already tagged);
 *       - else ATTRIBUTE the existing untagged commit via `readEvidence`'s
 *         declared-file-touch window (back-fills `completion_commit`, never
 *         re-commits) → outcome 'attributed' (AC-DURA-8). If readEvidence cannot
 *         attribute, leave it to the downstream Done-flip guard → 'honest_failure'.
 *   - HEAD static + gate-green dirty tree: commit the gate-green dirty source under
 *     the current ticket via the REUSED exit committer, whose ownership partition
 *     stashes foreign sibling residue (`stashUnattributableRemainder`) and stages
 *     only owned paths. T10 ADDS an allowlist-intersection staging filter: any
 *     owned path NOT within the ticket's `scope.json` allowed_paths is pre-stashed
 *     to the salvage ref so staged ⊆ allowlist (AC-DURA-2) → outcome 'committed'.
 *   - else (HEAD static, nothing committable): honest-failure (no Done, no context
 *     clear) → outcome 'honest_failure'.
 *
 * Idempotent on HEAD movement. Best-effort: any throw degrades to 'honest_failure'
 * (the downstream Done-flip guard remains authoritative). Emits exactly one
 * `boundary_commit_resolved` event recording the branch taken.
 */
/**
 * B-DURA T70: true when the ticket frontmatter already carries an explicit
 * `completion_commit` field (vs. a SHA only resolvable via scan/inferred). Best-
 * effort — any read failure returns false (caller falls through to persist).
 */
function ticketHasExplicitCompletionCommit(sessionDir: string, ticketId: string): boolean {
  try {
    const raw = fs.readFileSync(ticketFilePath(sessionDir, ticketId), 'utf8');
    return !!readFrontmatterField(raw, 'completion_commit');
  } catch {
    return false;
  }
}

/**
 * T10 Branch 1 helper: HEAD moved this iteration → attribute the existing commit
 * (never re-commit). Returns the resolved boundary result.
 */
function attributeBoundaryHeadMoved(
  sessionDir: string,
  ticketId: string,
  workingDir: string,
): BoundaryCommitResult {
  // B-1SEAM WS-1: mechanical swap onto the ONE predicate ({ decision:
  // 'attribution' } — keep-decision, no R-CWGE verdict). The predicate owns the
  // R-WUWC promote-once persist that this function previously duplicated inline,
  // so a scan/inferred SHA is already written to completion_commit on `ok`.
  // Read the explicit-field presence BEFORE the predicate (which may persist it)
  // to distinguish the no-op from the fresh attribution.
  const hadExplicit = ticketHasExplicitCompletionCommit(sessionDir, ticketId);
  const decision = evaluateCompletionEvidence(
    buildCompletionCtx({ sessionDir, ticketId, workingDir, rereadBackoffMs: 0 }, 'attribution'),
  );
  // Already explicitly tagged (present + reachable completion_commit field) → no-op.
  if (decision.ok && hadExplicit) {
    return { outcome: 'attributed', reason: 'no-op-head-moved', sha: decision.sha };
  }
  // Untagged worker commit → attributed via the predicate's scan/inferred branch
  // (completion_commit back-filled by its promote-once; no second commit).
  if (decision.ok) {
    return { outcome: 'attributed', reason: 'head-moved-untagged', sha: decision.sha };
  }
  // HEAD moved but the predicate cannot attribute it (e.g. baseline-only / out of
  // scope). Leave it to the downstream Done-flip guard; do NOT re-commit.
  return { outcome: 'honest_failure', reason: 'head-moved-untagged' };
}

/**
 * T10 allowlist-intersection staging filter: pre-stash any dirty path NOT within
 * the ticket's scope.json allowed_paths to the salvage ref and restore it to HEAD,
 * so the reused exit committer can only stage paths ⊆ the allowlist (AC-DURA-2).
 * Unscoped session (no scope.json) → no-op. Best-effort.
 */
function preStashOutOfAllowlistResidue(
  sessionDir: string,
  workingDir: string,
  ticketId: string,
  log: (msg: string) => void,
): void {
  const allowed = readScopeAllowedPaths(sessionDir);
  if (!allowed || allowed.length === 0) return;
  try {
    const dirty = listWorkingTreeDirtyPaths(workingDir);
    const outOfScope = dirty.filter((f) => !isWithinAllowedPaths(f, allowed));
    // Only owned-but-out-of-scope source residue needs pre-stashing; the exit
    // committer already routes session-dir-foreign residue to the salvage ref.
    if (outOfScope.length === 0) return;
    stashUnattributableRemainder(workingDir, sessionDir, log);
    // Restore the out-of-scope residue to HEAD so it cannot be swept into the
    // ticket-attributed commit; the salvage ref retains a recoverable copy.
    spawnSync('git', ['-C', workingDir, 'checkout', '--', ...outOfScope], {
      encoding: 'utf-8', timeout: 30000,
    });
    log(`[boundary-commit] ticket ${ticketId}: pre-stashed ${outOfScope.length} out-of-allowlist path(s) to salvage ref`);
  } catch (err) {
    log(`[boundary-commit] allowlist pre-stash failed (continuing): ${safeErrorMessage(err)}`);
  }
}

export function commitGatePassingDeliverableAtBoundary(
  input: BoundaryCommitInput,
): BoundaryCommitResult {
  const { sessionDir, statePath, workingDir, ticketId, preIterSha, log } = input;
  const resolve = (
    outcome: BoundaryCommitOutcome,
    postIterSha: string | null,
    rest: Omit<BoundaryCommitResult, 'outcome'>,
  ): BoundaryCommitResult => {
    if (ticketId) {
      try {
        writeActivityEntry(statePath, {
          event: 'boundary_commit_resolved',
          ts: new Date().toISOString(),
          ticket: ticketId,
          gate_payload: { outcome, pre_iter_sha: preIterSha, post_iter_sha: postIterSha },
        });
      } catch { /* best-effort telemetry — never block the boundary on an emit failure */ }
    }
    return { outcome, ...rest };
  };

  try {
    if (!ticketId) return { outcome: 'honest_failure', reason: 'no-ticket' };
    if (isTerminalTicketStatus(getTicketStatus(sessionDir, ticketId))) {
      const post = readHeadCommit(workingDir);
      return resolve('attributed', post, { reason: 'no-op-head-moved', sha: post ?? undefined });
    }

    const postIterSha = readHeadCommit(workingDir);
    const headMoved = !!postIterSha && !!preIterSha && postIterSha !== preIterSha;

    // --- Branch 1: HEAD moved this iteration → attribute, never re-commit. ---
    if (headMoved) {
      const r = attributeBoundaryHeadMoved(sessionDir, ticketId, workingDir);
      return resolve(r.outcome, postIterSha, { reason: r.reason, sha: r.sha });
    }

    // --- Branch 2: HEAD static + gate-green dirty tree → commit the deliverable. ---
    if (!isWorkingTreeDirty(workingDir)) {
      return resolve('honest_failure', postIterSha, { reason: 'clean-tree' });
    }
    preStashOutOfAllowlistResidue(sessionDir, workingDir, ticketId, log);
    const committed = commitGatePassingDeliverableOnExitPath({
      sessionDir,
      statePath,
      workingDir,
      ticketId,
      extensionRoot: input.extensionRoot,
      flags: input.flags,
      log,
      ...(input.runGate ? { runGate: input.runGate } : {}),
    });
    const post = readHeadCommit(workingDir);
    if (committed.committed) {
      return resolve('committed', post, { reason: 'committed', sha: committed.sha });
    }
    return resolve('honest_failure', post, { reason: committed.reason });
  } catch (err) {
    log(`[boundary-commit] threw (ignored): ${safeErrorMessage(err)}`);
    return resolve('honest_failure', readHeadCommit(workingDir), { reason: 'error' });
  }
}

// ---------------------------------------------------------------------------
// W3 salvage-before-fail consolidation routing.
//
// Every fail/cancel/timeout/exit seam routes its salvage through the shared
// `salvageTicket()` primitive. The production `salvageTicket` adapter delegates
// to the existing per-seam function, so the consolidated behavior is identical
// by construction.
// ---------------------------------------------------------------------------

/**
 * Exit-path seam: route the gate-passing-deliverable commit through
 * `salvageTicket()` (which reads `reconcileTicketTruth` for the clean-tree
 * short-circuit). The production adapter delegates to the retained per-seam
 * `commitGatePassingDeliverableOnExitPath`, so committed/Done vs no-op behavior
 * is identical.
 */
export function routeExitPathSalvage(
  input: CommitGatePassingDeliverableInput,
): CommitGatePassingDeliverableResult {
  if (!input.ticketId) {
    return commitGatePassingDeliverableOnExitPath(input);
  }
  let legacy: CommitGatePassingDeliverableResult = { committed: false, reason: 'no-ticket' };
  const deps: SalvageDeps = {
    reconcile: (i) => reconcileTicketTruth(i),
    // The per-seam fn owns its own gate; surface its verdict so salvage's
    // disposition mirrors the legacy outcome.
    gate: () => {
      legacy = commitGatePassingDeliverableOnExitPath(input);
      return legacy.committed ? 'passing' : 'failing';
    },
    commitScoped: () => ({ committed: legacy.committed, sha: legacy.sha }),
    // The per-seam fn already left gate-failing work in place for the failure
    // path; salvage must not re-archive it here (behavior parity — never
    // discard the dirty tree at this seam). It MUST still release status to
    // Todo: this is the ONLY automatic Todo writer reachable from a
    // failed_flip_suppressed hold set at the other flip sites (head
    // regression / wmw-auto-skip / worker-gate-fail), whose release requires
    // the literal frontmatter status `todo` (readActiveFailedFlipHolds).
    // Stubbing this out strands a held-but-runnable ticket forever.
    archive: () => null,
    resetTodo: (i) => {
      updateTicketFrontmatter(i.ticketId, i.sessionDir, { status: 'Todo', completion_commit: null });
    },
    ffReattach: () => ({ recovered: false }),
  };
  const outcome = salvageTicket(
    { sessionDir: input.sessionDir, workingDir: input.workingDir, ticketId: input.ticketId, log: input.log },
    deps,
  );
  // Map the salvage disposition back to the legacy result the callers consume.
  if (outcome.disposition === 'no-op') return { committed: false, reason: 'clean-tree' };
  return legacy;
}

/**
 * Failed-flip seam: route the suppression decision through `salvageTicket()`'s
 * choke point while preserving the EXACT per-seam decision. The production
 * adapter delegates to the retained `evaluateFailedFlipSuppression`.
 */
export function routeFailedFlipSuppression(
  input: FailedFlipSuppressionInput,
): FailedFlipSuppressionDecision {
  // The flip-suppression decision IS the salvage decision for this seam; the
  // shared primitive's role here is the single choke point. The decision always
  // delegates to the retained per-seam evaluator (suppress/proceed/escalate is
  // unchanged) — the only additional effect is the W4a attribution log.
  if ((input.backend || input.mode) && input.log) {
    input.log(`[failed-flip] choke-point routed ${input.ticketId} at ${input.callsite} [backend=${input.backend ?? 'claude'};mode=${input.mode ?? 'worker'}]`);
  }
  return evaluateFailedFlipSuppression(input);
}

/**
 * Measure the working tree, distinguishing a MEASURED clean tree from an ABSENT
 * measurement. `listWorkingTreeDirtyPaths` THROWS on every git failure on purpose
 * (AP-EXT-ITER8-01), so a bare `catch → false` republishes that failure as a
 * measured-clean verdict — the AP-EXT-ITER47-01/48-01 shape. Returns:
 *   `true`  — measured dirty
 *   `false` — measured clean, OR `workingDir` is provably not a git repository
 *             (no tree that could be dirty — a real answer, not a fabricated one)
 *   `null`  — the probe failed inside a real repo (index.lock contention, timeout,
 *             ENOBUFS): unmeasurable, and never to be read as "clean"
 */
function probeTreeDirty(workingDir: string): boolean | null {
  try { return isWorkingTreeDirty(workingDir); } catch { /* fall through to the repo probe */ }
  // Same predicate the two existing non-repo probes use (setup.ts `isInsideGitRepo`,
  // scope-resolver.ts `assertIsRepo`): `rev-parse --git-dir` answers repo-or-not even
  // when `status` cannot run. If it fails too, the answer stays unmeasurable.
  try { return runGit(['rev-parse', '--git-dir'], workingDir, false).trim().length > 0 ? null : false; }
  catch { return null; }
}

/** Probe the recovery evidence the runner already holds: tree state, plan artifacts, output. */
export function assessRecoveryEvidence(sessionDir: string, workingDir: string, ticketId: string): RecoveryEvidence {
  const dirty = probeTreeDirty(workingDir);
  let planArtifactExists = false;
  let planApproved = false;
  try {
    const entries = fs.readdirSync(path.join(sessionDir, ticketId));
    planArtifactExists = entries.some(f => /^plan_.*\.md$/.test(f));
    if (entries.includes('plan_review.md')) {
      const review = fs.readFileSync(path.join(sessionDir, ticketId, 'plan_review.md'), 'utf-8');
      planApproved = /\bAPPROVED\b/.test(review);
    }
  } catch { /* ticket dir unreadable → no plan evidence */ }
  return {
    // An ABSENT tree measurement must not SKIP the salvage rungs: `null` reads as
    // possibly-dirty so rungs 1–2 still ATTEMPT the commit-and-flip on a tree that may
    // hold the whole ticket. Both rungs contain their own adapter throws, so a still-
    // broken probe simply records a failed attempt and falls through.
    treeDirty: dirty !== false,
    // The two DISPOSITION-bearing fields keep the exact readings the fabricated-clean
    // catch produced (`!treeDirty` was `dirty !== true` for every measurable case and
    // for the unmeasurable one). Honesty is a reporting property, halting is a
    // disposition: this fix widens what the ladder ATTEMPTS, never where it lands.
    planConvergedUncommitted: dirty !== true && isConvergedPlanEligible({ planArtifactExists, planReviewApproved: planApproved }),
    noWorkProduced: dirty !== true && !planArtifactExists,
  };
}

/**
 * fix-forward-trivial spawner: run the EXISTING gate remediator bin synchronously
 * (the same path finalize-gate uses), feeding it the armed gate's failures. Returns
 * true iff the remediator exited 0. Bounded to one invocation per ladder call by the
 * controller (INV-FIX-FORWARD-BOUND).
 */
function spawnRecoveryRemediator(
  input: AttemptRecoveryBeforeTerminalInput,
  gateFailures: BetweenTicketGateFailure[],
): boolean {
  try {
    const gateDir = path.join(input.sessionDir, 'gate');
    fs.mkdirSync(gateDir, { recursive: true });
    const gateResultPath = path.join(gateDir, 'recovery_gate_result.json');
    const failures = gateFailures.map((f, i) => ({
      check: 'tests' as const,
      file: f.file || '',
      line: 0,
      ruleOrCode: '',
      message: f.name,
      severity: 'error' as const,
      occurrence_index: i,
    }));
    fs.writeFileSync(gateResultPath, JSON.stringify({
      status: 'red',
      failures,
      baseline_used: false,
      allowed_paths_used: false,
      elapsed_ms: 0,
      total_raw_failure_count: failures.length,
      new_failures_vs_baseline: failures.length,
    }), 'utf-8');
    const remediatorJs = path.join(input.extensionRoot, 'extension', 'bin', 'spawn-gate-remediator.js');
    const r = spawnSync(process.execPath, [
      remediatorJs,
      '--gate-result', gateResultPath,
      '--session-root', input.sessionDir,
      '--reason', 'per-iteration',
    ], { cwd: input.workingDir, encoding: 'utf-8', timeout: resolveWorkerTestGateTimeoutMs(input.extensionRoot) });
    return r.status === 0;
  } catch (err) {
    input.log(`fix-forward-trivial: remediator spawn failed for ${input.ticketId}: ${safeErrorMessage(err)}`);
    return false;
  }
}

/** W4a discriminant: which backend authority + lifecycle mode reached the choke point. */
export type RecoveryBackend = 'claude' | 'codex';
export type RecoveryMode = 'worker' | 'manager';

export interface AttemptRecoveryBeforeTerminalInput {
  sessionDir: string;
  statePath: string;
  extensionRoot: string;
  workingDir: string;
  ticketId: string;
  iteration: number;
  flags: Record<string, unknown> | null;
  log: (msg: string) => void;
  /**
   * W4a discriminant. Optional/additive so the pre-W4a callers compile unchanged.
   * `backend` defaults to `state.backend` then `claude`; `mode` defaults to `worker`.
   * `evidence` is the seam's no-progress / handoff context, recorded into the ladder
   * attempt ledger reason for observability (no schema change).
   */
  backend?: RecoveryBackend;
  mode?: RecoveryMode;
  evidence?: Record<string, unknown>;
}

/** Resolve the W4a discriminant, defaulting backend from persisted state when absent. */
function resolveRecoveryDiscriminant(
  input: AttemptRecoveryBeforeTerminalInput,
): { backend: RecoveryBackend; mode: RecoveryMode } {
  let backend = input.backend ?? null;
  if (!backend) {
    try {
      const s = readRecoverableJsonObject(input.statePath) as State | null;
      backend = s?.backend === 'codex' ? 'codex' : s?.backend === 'claude' ? 'claude' : null;
    } catch { /* best-effort — fall through to claude */ }
  }
  return { backend: backend ?? 'claude', mode: input.mode ?? 'worker' };
}

/** R-ORSR-3 per-Phase verify-command budget (ms). Finite per subsystem invariant #3. */
const CONVERGED_PLAN_VERIFY_TIMEOUT_MS = 600_000;
/** R-ORSR-3 per-Phase git add/commit budget (ms). */
const CONVERGED_PLAN_GIT_TIMEOUT_MS = 30_000;

/**
 * R-ORSR-3 execute-converged-plan executor — the runtime adapter behind the
 * `RecoveryDeps.executeConvergedPlan` seam. Reads the approved plan from the ticket dir,
 * parses its authored Phases, and runs each Phase's verify command as one atomic commit
 * via `executePhaseLoop`. Partial failure (phase k fails) commits phases `0..k-1` and
 * returns `{ ok:false }` so the ladder records the failed attempt and falls through —
 * the ticket is never marked Done. A clean tree (the `planConvergedUncommitted` case)
 * has nothing to commit, so the per-Phase `git commit` fails and the rung honestly
 * reports `ok:false`; that is the documented down-scope, not a bug.
 */
/** Shared input shape for `executeConvergedPlanAdapter` and its clean-tree helpers. */
interface ExecuteConvergedPlanInput {
  sessionDir: string;
  ticketId: string;
  workingDir: string;
  statePath: string;
  log: (msg: string) => void;
  /**
   * AC-GA-REC-1 clean-tree re-execution seam. When present, the adapter re-executes
   * the approved plan against the RAW plan_*.md path before falling through to the
   * verify-only PlanPhase loop. Absent → the legacy verify-only behavior is unchanged.
   */
  reExecutionSeam?: ReExecutionSeam;
  /** Test-only injectable hooks (undefined in production, injected in tests). */
  _testHooks?: {
    isPostImplementDirty?: () => boolean;
    readStateForIdempotency?: () => State | null;
  };
}

/**
 * AC-GA-REC-3 idempotency guard. Returns `{ ok: true }` (no-op) when a prior successful
 * execute-converged-plan entry exists in the recovery_attempts ledger AND the ticket
 * frontmatter carries completion_commit. State/ledger-keyed, NEVER diff-content-keyed —
 * an LLM implement pass produces a different diff each time, so a content-match key never
 * fires. Returns null to fall through to (re-)execution.
 */
function convergedPlanIdempotentNoOp(input: ExecuteConvergedPlanInput): { ok: boolean } | null {
  try {
    const s = input._testHooks?.readStateForIdempotency
      ? input._testHooks.readStateForIdempotency()
      : (readRecoverableJsonObject(input.statePath) as State | null);
    const ledger = Array.isArray(s?.recovery_attempts) ? s!.recovery_attempts : [];
    const priorSuccess = ledger.some(
      (a) => a.strategy === 'execute-converged-plan' && a.outcome === 'success',
    );
    if (!priorSuccess) return null;
    const ticketContent = fs.readFileSync(ticketFilePath(input.sessionDir, input.ticketId), 'utf-8');
    const completionCommit = readFrontmatterField(ticketContent, 'completion_commit');
    if (completionCommit && completionCommit.trim().length > 0) {
      input.log(`recovery: execute-converged-plan idempotent no-op for ${input.ticketId} (prior success + completion_commit set)`);
      return { ok: true };
    }
  } catch { /* best-effort idempotency guard; fall through to re-execute */ }
  return null;
}

/**
 * AC-GA-REC-1 clean-tree converged case: re-execute the approved plan against the RAW
 * plan_*.md path. The parsed PlanPhase[] carries only verify commands (structurally
 * nothing to implement) — this hands the seam the markdown path, NEVER the phases.
 * Returns an early-return result, or `'fallthrough'` when a diff landed and the caller
 * should run the existing verify-and-commit phase loop.
 */
function executeCleanTreeReExecution(
  input: ExecuteConvergedPlanInput & { seam: ReExecutionSeam; ticketDir: string },
): { ok: boolean } | 'fallthrough' {
  let planFile: string | undefined;
  try {
    planFile = fs.readdirSync(input.ticketDir).filter(f => /^plan_.*\.md$/.test(f)).sort().pop();
  } catch { return { ok: false }; }
  if (!planFile) return { ok: false };

  let complexityTier = 'medium';
  try {
    const ticketContent = fs.readFileSync(ticketFilePath(input.sessionDir, input.ticketId), 'utf-8');
    complexityTier = readFrontmatterField(ticketContent, 'complexity_tier') ?? 'medium';
  } catch { /* default to medium on read error */ }

  const spawnResult = input.seam.spawnImplementPass({
    planPath: path.join(input.ticketDir, planFile),
    ticketId: input.ticketId,
    complexityTier,
    sessionDir: input.sessionDir,
    workingDir: input.workingDir,
    statePath: input.statePath,
  });

  if (spawnResult.timedOut) {
    // AC-GA-REC-5: implementer timeout escalates to recovery_exhausted (never silent-loop).
    input.log(`recovery: execute-converged-plan implement pass timed out for ${input.ticketId} — escalating to recovery_exhausted`);
    return { ok: false };
  }
  if (!spawnResult.ok) {
    input.log(`recovery: execute-converged-plan implement pass returned not-ok for ${input.ticketId}`);
    return { ok: false };
  }

  const postDiff = input._testHooks?.isPostImplementDirty
    ? input._testHooks.isPostImplementDirty()
    : isWorkingTreeDirty(input.workingDir);
  if (!postDiff) {
    // AC-GA-REC-4: zero diff (plan already fully realized) → reconcile to terminal,
    // do NOT loop. The reconcile call routes the disposition through ground truth.
    input.log(`recovery: execute-converged-plan zero-diff for ${input.ticketId} — reconciling to terminal via reconcileTicketTruth`);
    reconcileTicketTruth({ sessionDir: input.sessionDir, workingDir: input.workingDir });
    return { ok: false };
  }
  // Diff present — fall through to the existing executePhaseLoop verify-and-commit path.
  return 'fallthrough';
}

export function executeConvergedPlanAdapter(input: ExecuteConvergedPlanInput): { ok: boolean } {
  const ticketDir = path.join(input.sessionDir, input.ticketId);

  const idempotent = convergedPlanIdempotentNoOp(input);
  if (idempotent) return idempotent;

  if (input.reExecutionSeam) {
    const reExec = executeCleanTreeReExecution({ ...input, seam: input.reExecutionSeam, ticketDir });
    if (reExec !== 'fallthrough') return reExec;
  }

  let phases: PlanPhase[];
  try {
    const planFile = fs.readdirSync(ticketDir)
      .filter(f => /^plan_.*\.md$/.test(f))
      .sort()
      .pop();
    if (!planFile) return { ok: false };
    phases = parsePlanPhases(fs.readFileSync(path.join(ticketDir, planFile), 'utf-8'));
  } catch { return { ok: false }; }
  if (phases.length === 0) return { ok: false };

  const result = executePhaseLoop({
    phases,
    executePhase: (phase) => {
      if (!phase.verify) return { ok: false };
      const r = spawnSync(phase.verify, {
        cwd: input.workingDir,
        shell: true,
        encoding: 'utf-8',
        timeout: CONVERGED_PLAN_VERIFY_TIMEOUT_MS,
      });
      return { ok: r.status === 0 };
    },
    commitPhase: (phase) => {
      // AP-EXT-ITER6-01 replay: the sibling whole-tree add. Same shared exclusion —
      // a per-Phase recovery commit must not carry the runtime's own `.codegraph/`
      // index into the target repo.
      const add = spawnSync('git', ['add', '-A', ...CODEGRAPH_PATHSPEC_EXCLUDES], {
        cwd: input.workingDir, encoding: 'utf-8', timeout: CONVERGED_PLAN_GIT_TIMEOUT_MS,
      });
      if (add.status !== 0) {
        return { ok: false };
      }
      const title = phase.title ? ` — ${phase.title}` : '';
      const phaseMsg = stampPickleTicketTrailer(
        input.workingDir,
        `fix(${input.ticketId}): execute-converged-plan phase ${phase.index}${title}`,
        input.ticketId,
      );
      const commit = spawnSync('git', ['commit', '-m', phaseMsg], {
        cwd: input.workingDir, encoding: 'utf-8', timeout: CONVERGED_PLAN_GIT_TIMEOUT_MS,
      });
      return { ok: commit.status === 0 };
    },
  });

  const stoppedAt = result.failedIndex !== null ? ` (stopped at phase ${phases[result.failedIndex].index})` : '';
  input.log(`recovery: execute-converged-plan ran ${result.committed}/${phases.length} phase(s) for ${input.ticketId}${stoppedAt}`);
  return { ok: result.ok };
}

/**
 * Build the RecoveryDeps bound to the runtime and run the ladder. The ARMED gate is
 * `runBetweenTicketFastTests` — it runs the real whole-repo `test:fast` and ignores
 * `flags.skip_quality_gates_reason` by construction (never a skip-flagged green).
 * The execute-converged-plan executor (R-ORSR-3, e8f46d84) reads the approved plan and
 * runs each Phase as one atomic commit; on a clean converged tree it honestly reports
 * not-ok and the ladder falls through.
 */
export function attemptRecoveryBeforeTerminal(input: AttemptRecoveryBeforeTerminalInput): RecoveryOutcome {
  const extensionDir = path.join(input.workingDir, 'extension');
  const discriminant = resolveRecoveryDiscriminant(input);
  const haltSite = typeof input.evidence?.halt_site === 'string' ? `;halt_site=${input.evidence.halt_site}` : '';
  const discriminantTag = `[backend=${discriminant.backend};mode=${discriminant.mode}${haltSite}]`;
  let lastGateFailures: BetweenTicketGateFailure[] = [];
  const deps: RecoveryDeps = {
    iteration: input.iteration,
    ticketId: input.ticketId,
    assessEvidence: () => assessRecoveryEvidence(input.sessionDir, input.workingDir, input.ticketId),
    runArmedGate: () => {
      // B-OFFREPO (AC-OFFREPO-1) narrowed this to `ok:false` on a missing
      // `extension/` so rung 1 could never mint a fabricated green worker-gate
      // verdict for a target repo whose suite never ran. That fix over-reached: it
      // also stopped rung 1 from even ATTEMPTING the commit-and-flip on a
      // genuinely-dirty, genuinely-advancing tree, collapsing every off-repo
      // recovery pass straight to the honest terminal `recovery_exhausted` — a
      // Prime Directive halt on a ladder that made real progress
      // (INV-CODEX-RECOVERY-ADVANCED, R-CHTS-CODEX). The fear behind B-OFFREPO was
      // correct (never assert a gate ran when it didn't); the fix belongs at the
      // VERDICT, not at whether the commit is attempted — exactly the split
      // B-OFFREPO's own `guardCompletionCommitBeforeDone` change already applies
      // one level up (`not_run` routes to the gate-exempt decision kind rather than
      // fail-closed). So this reports `ok: true` (the ladder may proceed) while
      // recording the same not-run residual for observability; the committer below
      // is the one that must not lie about a verdict it didn't earn.
      if (!fs.existsSync(extensionDir)) {
        emitWorkerGateNotRunResidual(input.statePath, input.ticketId, {
          computedVia: 'not_applicable',
          site: 'attemptRecoveryBeforeTerminal.runArmedGate',
        });
        input.log(`recovery: armed gate not applicable for ${input.ticketId} (no extension/) — proceeding without a fabricated green verdict`);
        return { ok: true };
      }
      const r = runBetweenTicketFastTests(extensionDir, input.extensionRoot);
      lastGateFailures = r.failures;
      return { ok: r.ok };
    },
    commitAndFlipDone: () => commitAndContinueDoneFlip({
      sessionDir: input.sessionDir,
      ticketId: input.ticketId,
      workingDir: input.workingDir,
      statePath: input.statePath,
      flags: input.flags,
      log: input.log,
      // AC-R2-3: rung 1 is a runner-driven recovery commit, not a worker's
      // declaration of completion. Never auto-flip Done over a gate that never ran.
      allowDoneWhenGateNotRun: false,
    }),
    spawnRemediator: () => spawnRecoveryRemediator(input, lastGateFailures),
    executeConvergedPlan: () => executeConvergedPlanAdapter({
      sessionDir: input.sessionDir,
      ticketId: input.ticketId,
      workingDir: input.workingDir,
      statePath: input.statePath,
      log: input.log,
      // AC-GA-REC-1 production re-execution seam (B-WSPU WS-1: all tiers spawn
      // an implement pass synchronously — no detached lifecycle).
      reExecutionSeam: {
        spawnImplementPass: (opts) => {
          // B-WSPU WS-1: all tiers spawn an implement pass synchronously via
          // buildManagerInvocation, handing the worker the raw plan path as task
          // context. Bounded to CONVERGED_PLAN_VERIFY_TIMEOUT_MS per subsystem
          // invariant #3 (finite spawn timeout).
          try {
            const { backend } = resolveBackendFromStateFileWithSource(opts.statePath);
            const invocation = buildManagerInvocation(backend, {
              prompt: `Re-execute the approved plan to produce the missing edits. Read the raw plan at ${opts.planPath} and implement its steps for ticket ${opts.ticketId}.`,
              addDirs: [opts.workingDir, opts.sessionDir],
              noSessionPersistence: true,
            });
            const r = spawnSync(invocation.cmd, invocation.args, {
              cwd: opts.workingDir,
              env: { ...process.env, ...backendEnvOverrides(backend, { workingDir: opts.workingDir, ticketId: opts.ticketId, sessionDir: opts.sessionDir }), ...(invocation.env ?? {}), PICKLE_STATE_FILE: opts.statePath },
              encoding: 'utf-8',
              timeout: CONVERGED_PLAN_VERIFY_TIMEOUT_MS,
            });
            if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
              return { ok: false, timedOut: true };
            }
            return { ok: r.status === 0 };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('ETIMEDOUT') || msg.includes('timed out')) {
              return { ok: false, timedOut: true };
            }
            return { ok: false };
          }
        },
      },
    }),
    appendAttempt: (attempt: RecoveryAttempt) => {
      try {
        sm.update(input.statePath, s => {
          if (!Array.isArray(s.recovery_attempts)) s.recovery_attempts = [];
          // W4a: annotate the ledger reason with the backend/mode discriminant so
          // every recovery attempt is attributable to the seam authority that hit
          // the choke point, without a state-schema change.
          s.recovery_attempts.push({ ...attempt, reason: `${attempt.reason} ${discriminantTag}` });
        });
      } catch { /* best-effort ledger append */ }
    },
    log: input.log,
  };
  return runRecoveryLadder(deps);
}

/**
 * W4a single choke point. Every no-progress / handoff / self-terminate seam routes
 * its recovery decision through THIS function (claude + codex, worker + manager),
 * which runs the ladder via `attemptRecoveryBeforeTerminal`. The DECISION (the ladder
 * invocation) lives only here and in `attemptRecoveryBeforeTerminal`; new halt sites
 * MUST route through this wrapper rather than emit a terminal disposition directly.
 */
export function routeRecoveryBeforeTerminal(input: AttemptRecoveryBeforeTerminalInput): RecoveryOutcome {
  return attemptRecoveryBeforeTerminal(input);
}

/** Disposition returned by `haltOrRecoverCodexNoProgress` for the 4 codex no-progress halt sites. */
type CodexNoProgressDisposition =
  | { kind: 'advanced' }
  | { kind: 'recovery_exhausted' }
  | { kind: 'halt' };

export interface HaltOrRecoverCodexNoProgressInput {
  statePath: string;
  sessionDir: string;
  extensionRoot: string;
  workingDir: string;
  iteration: number;
  log: (msg: string) => void;
}

/**
 * Shared codex-authority recovery seam. Invoked at all 4 `codex_manager_no_progress`
 * halt blocks BEFORE the terminal park: runs the recovery ladder and tells the caller
 * whether the queue advanced (relaunch, don't halt), the ladder is exhausted (halt with
 * the honest `recovery_exhausted`), or there is nothing to recover (existing
 * `codex_manager_no_progress` halt). `manager_handoff_pending` is never routed here.
 */
function haltOrRecoverCodexNoProgress(input: HaltOrRecoverCodexNoProgressInput): CodexNoProgressDisposition {
  let flags: Record<string, unknown> | null = null;
  let ticketId = '';
  let workingDir = input.workingDir;
  try {
    const s = readRecoverableJsonObject(input.statePath) as State | null;
    if (s) {
      flags = (s.flags as Record<string, unknown> | undefined) ?? null;
      ticketId = s.current_ticket || '';
      workingDir = s.working_dir || workingDir;
    }
  } catch { /* best-effort — fall through to halt if state is unreadable */ }
  if (!ticketId) return { kind: 'halt' };
  const recovery = routeRecoveryBeforeTerminal({
    sessionDir: input.sessionDir,
    statePath: input.statePath,
    extensionRoot: input.extensionRoot,
    workingDir,
    ticketId,
    iteration: input.iteration,
    flags,
    log: input.log,
    backend: 'codex',
    mode: 'manager',
  });
  if (recovery.kind === 'advanced') {
    input.log(`recovery: ${recovery.strategy} advanced ${ticketId} before codex_manager_no_progress — relaunching.`);
    return { kind: 'advanced' };
  }
  if (recovery.kind === 'exhausted') {
    input.log(`recovery_exhausted: ladder exhausted for ${ticketId} (${recovery.reason}).`);
    return { kind: 'recovery_exhausted' };
  }
  return { kind: 'halt' };
}

// ---------------------------------------------------------------------------
// AC-A4 (f8000435) — bounded terminal escape for an unreclaimable In Progress
// ticket on the non-codex manager-relaunch path.
//
// AC-A1 (pipeline-runner) + AC-A2 (the evaluateManagerRelaunch gate below at the
// two `decision.shouldRelaunch` sites) make a pickle phase with a pending ticket
// REFUSE to complete. The inverse hazard: an In Progress ticket the manager can
// never finish would relaunch up to CLAUDE_MANAGER_RELAUNCH_CAP (20) times — a
// long, sterile twin-wedge — and then exit idle_stall_unrecoverable WITHOUT ever
// forcing the stuck ticket terminal. This escape fires EARLIER: after the
// resolved bounded-escape cap (`hardening.bounded_terminal_escape_cap`,
// compiled default 3) consecutive no-progress relaunches on the same In
// Progress ticket it forces the ticket to a terminal disposition (salvage-then-Skipped),
// so the NEXT evaluateManagerRelaunch sees it no longer pending and the existing
// AC-A2 gate advances/halts deterministically. The pipeline never spins to
// max_iterations on an unreclaimable ticket.
//
// The cap lives in the persisted `state.recovery_attempts` ledger (R-ORSR-1,
// schema-neutral, defaulted to [] by normalizeV5StateDefaults) — NOT a
// process-local counter — so it survives `setup.js --resume`. No new
// `state.flags` skip surface (subtract-before-add governance). This is the
// GENERIC (non-codex) escape; the codex no-progress ladder
// (haltOrRecoverCodexNoProgress) is untouched.
// ---------------------------------------------------------------------------

/** Ledger discriminator for bounded-escape attempts (AC-A4). */
export const BOUNDED_ESCAPE_STRATEGY = 'bounded_terminal_escape';

export interface BoundedEscapeEvaluation {
  /** True when the in-flight ticket is In Progress and has hit the no-progress cap. */
  escape: boolean;
  /** The in-flight ticket id, or null when there is none. */
  ticketId: string | null;
  /** Consecutive no-progress relaunch attempts already recorded for this ticket. */
  priorCount: number;
  /** The cap that was applied. */
  cap: number;
}

function countBoundedEscapeAttempts(
  ledger: readonly RecoveryAttempt[] | undefined,
  ticketId: string,
): number {
  if (!Array.isArray(ledger)) return 0;
  let n = 0;
  for (const a of ledger) {
    if (a.strategy === BOUNDED_ESCAPE_STRATEGY && a.ticket === ticketId && a.outcome === 'failed') n++;
  }
  return n;
}

/**
 * Pure decision: should the bounded escape fire for the in-flight ticket? Only an
 * `In Progress` ticket is eligible — `Todo` never started (the manager simply has
 * not picked it up), and `Done`/`Skipped` are already terminal. The count is read
 * from the persisted ledger so a resumed session honors the same cap.
 */
export function evaluateBoundedEscape(
  state: State,
  sessionDir: string,
  cap: number,
): BoundedEscapeEvaluation {
  const ticketId = typeof state.current_ticket === 'string' && state.current_ticket.length > 0
    ? state.current_ticket
    : null;
  if (!ticketId) return { escape: false, ticketId: null, priorCount: 0, cap };
  let status = '';
  try {
    status = (getTicketStatus(sessionDir, ticketId) ?? '').toLowerCase().replace(/["']/g, '').trim();
  } catch { /* unreadable frontmatter → not escape-eligible */ }
  const priorCount = countBoundedEscapeAttempts(state.recovery_attempts, ticketId);
  const escape = status === 'in progress' && priorCount >= cap;
  return { escape, ticketId, priorCount, cap };
}

/**
 * Record one no-progress relaunch attempt for the in-flight ticket into the
 * persisted ledger. The Nth such entry is what makes `evaluateBoundedEscape`
 * fire on the next pass — the consecutive-no-progress count IS the ledger count.
 */
export function recordBoundedEscapeAttempt(
  statePath: string,
  ticketId: string,
  iteration: number,
  log: (msg: string) => void = () => { /* silent */ },
): void {
  try {
    sm.update(statePath, s => {
      if (!Array.isArray(s.recovery_attempts)) s.recovery_attempts = [];
      s.recovery_attempts.push({
        strategy: BOUNDED_ESCAPE_STRATEGY,
        outcome: 'failed',
        reason: 'no_progress_relaunch',
        iteration,
        ticket: ticketId,
      });
    });
  } catch (err) {
    log(`WARN: failed to record bounded-escape attempt: ${safeErrorMessage(err)}`);
  }
}

/** Result of a per-ticket recovery-budget refund probe (R-REIN). */
export interface RecoveryBudgetRefundResult {
  /** True when stale spent attempts were cleared (an explicit operator reset was honored). */
  refunded: boolean;
  /** Number of pre-reset `bounded_terminal_escape` attempts removed from the ledger. */
  cleared: number;
}

/**
 * R-REIN: refund the per-ticket recovery budget when an operator explicitly resets a
 * ticket's frontmatter `status` back to `Todo`. The documented recovery recipe ("set
 * status: Todo + relaunch") was INERT once a ticket had exhausted its bounded-escape
 * ladder: the spent `bounded_terminal_escape` attempts persisted in the ledger, so the
 * ticket was force-escaped again on its very first no-progress relaunch (re-exiting
 * `recovery_exhausted` in ~2s with no real re-attempt).
 *
 * Conservative: refunds ONLY when frontmatter status reads `todo` AND the ledger holds
 * spent attempts for THIS ticket. A still-Failed/In-Progress ticket (no reset) keeps its
 * spent attempts and exhausts normally. Pre-reset entries are SUPERSEDED (removed) so the
 * subsequent `countBoundedEscapeAttempts` reads zero and the ladder starts fresh. Emits
 * the existing `operator_recovery_transition` activity event for the audit trail. Adds no
 * forbidden state field. Best-effort: any read/write failure is swallowed (no refund).
 */
export function refundRecoveryBudgetOnReset(
  statePath: string,
  sessionDir: string,
  ticketId: string,
  iteration: number,
  log: (msg: string) => void = () => { /* silent */ },
): RecoveryBudgetRefundResult {
  if (!ticketId) return { refunded: false, cleared: 0 };
  let status: string;
  try {
    status = (getTicketStatus(sessionDir, ticketId) ?? '').toLowerCase().replace(/["']/g, '').trim();
  } catch { return { refunded: false, cleared: 0 }; }
  if (status !== 'todo') return { refunded: false, cleared: 0 };

  let cleared = 0;
  try {
    const probe = readRecoverableJsonObject(statePath) as State | null;
    const priorCount = countBoundedEscapeAttempts(probe?.recovery_attempts, ticketId);
    if (priorCount <= 0) return { refunded: false, cleared: 0 };
    sm.update(statePath, s => {
      if (!Array.isArray(s.recovery_attempts)) { s.recovery_attempts = []; return; }
      const before = s.recovery_attempts.length;
      s.recovery_attempts = s.recovery_attempts.filter(
        a => !(a.strategy === BOUNDED_ESCAPE_STRATEGY && a.ticket === ticketId && a.outcome === 'failed'),
      );
      cleared = before - s.recovery_attempts.length;
    });
  } catch (err) {
    log(`WARN: failed to refund recovery budget for ${ticketId}: ${safeErrorMessage(err)}`);
    return { refunded: false, cleared: 0 };
  }
  if (cleared <= 0) return { refunded: false, cleared: 0 };
  log(`recovery: refunded per-ticket recovery budget for ${ticketId} (status reset to Todo) — cleared ${cleared} spent attempt(s).`);
  try {
    logActivity({
      event: 'operator_recovery_transition',
      source: 'pickle',
      session: path.basename(sessionDir),
      iteration,
      gate_payload: {
        subcommand: 'refund-recovery-budget',
        ticket: ticketId,
        disposition: 'recovery_budget_refunded',
        cleared_attempts: cleared,
      },
    });
  } catch { /* best-effort telemetry */ }
  return { refunded: true, cleared };
}

/**
 * Force the unreclaimable In Progress ticket to a terminal disposition. First
 * salvage (archive-before-destructive preserves any uncommitted work), then flip
 * the frontmatter to `Skipped` (terminal per PRD AC-A4 Risks row), then append a
 * success ledger entry as the durable record. Returns true when the ticket is
 * left terminal.
 */
export function executeBoundedEscape(
  statePath: string,
  sessionDir: string,
  workingDir: string,
  ticketId: string,
  iteration: number,
  cap: number,
  log: (msg: string) => void = () => { /* silent */ },
): boolean {
  const deps: SalvageDeps = {
    reconcile: (i) => reconcileTicketTruth(i),
    gate: () => 'failing',
    commitScoped: () => ({ committed: false }),
    archive: (i) => {
      try {
        return archiveBeforeDestructive({
          cwd: i.workingDir,
          sessionDir: i.sessionDir,
          ticketDir: `${i.sessionDir}/${i.ticketId}`,
          reason: 'pre_reset',
        });
      } catch {
        return null;
      }
    },
    resetTodo: () => { /* escape forces Skipped below, not Todo */ },
    ffReattach: () => ({ recovered: false }),
  };
  try {
    salvageTicket({ sessionDir, workingDir, ticketId, log }, deps);
  } catch (err) {
    log(`WARN: bounded-escape salvage threw (continuing to force terminal): ${safeErrorMessage(err)}`);
  }
  const flipped = markTicketSkipped(sessionDir, ticketId);
  try {
    sm.update(statePath, s => {
      if (!Array.isArray(s.recovery_attempts)) s.recovery_attempts = [];
      s.recovery_attempts.push({
        strategy: BOUNDED_ESCAPE_STRATEGY,
        outcome: 'success',
        reason: 'forced_skipped_unreclaimable_in_progress',
        iteration,
        ticket: ticketId,
      });
    });
  } catch (err) {
    log(`WARN: failed to record bounded-escape success: ${safeErrorMessage(err)}`);
  }
  log(`bounded escape: ${ticketId} held In Progress across ${cap} no-progress relaunches — forced terminal (Skipped) so the phase advances/halts deterministically.`);
  return flipped;
}

// ---------------------------------------------------------------------------
// R-CNAR-6 — Spark codex smoke-run gate
// ---------------------------------------------------------------------------

/** Codex CLI surfaces transport, auth, and rate-limit failures with these markers. */
const CODEX_CLI_ERROR_PATTERNS: readonly RegExp[] = [
  /\b(?:ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|EPIPE)\b/,
  /\bHTTP\s*(?:429|5\d\d)\b/,
  /\b429\s+Too\s+Many\s+Requests\b/i,
  /\b5\d\d\s+(?:Bad\s+Gateway|Internal\s+Server\s+Error|Service\s+Unavailable)\b/i,
  /\bcodex(?:\s+CLI)?[:\s]+(?:error|exited|failed|crashed)\b/i,
  /\bstream\s+(?:error|disconnected)\b/i,
  /\brate[_\s-]?limit(?:\s+exceeded|_exceeded)\b/i,
  /\b401\s+Unauthorized\b/i,
];

// R-BUNDLE-1: session-hash allowlist for bundle_bootstrap_mode auto-skip.
// Extend this table when a new bundle needs both gates bypassed at launch.
const BUNDLE_BOOTSTRAP_ALLOWLIST: Record<string, Set<string>> = {
  '2026-05-07-deferred-slots': new Set(['2026-05-07-488e6e1f']),
  '2026-05-08-mega': new Set(['2026-05-09-7ff82595']),
};

export type SparkSmokeGateAction = 'allow' | 'bypass' | 'halt';
export type SparkSmokeGateRule =
  | 'gate_inactive'
  | 'bypassed'
  | 'first_two_failed'
  | 'three_consecutive_failed'
  | 'allow';

export interface SparkSmokeGateDecision {
  action: SparkSmokeGateAction;
  reason: string;
  rule: SparkSmokeGateRule;
}

const SPARK_MODEL_PATTERN = /^gpt-5\.3-codex-spark/;

function ticketHasCodexCliError(ticketDir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(ticketDir);
  } catch {
    return false;
  }
  for (const file of entries) {
    if (!/^worker_session_\d+\.log$/.test(file)) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(ticketDir, file), 'utf-8');
    } catch {
      continue;
    }
    if (CODEX_CLI_ERROR_PATTERNS.some(re => re.test(content))) return true;
  }
  return false;
}

function isSparkGateActive(state: State): boolean {
  if (state.backend !== 'codex') return false;
  const codexModel = typeof state.codex_model === 'string' ? state.codex_model : '';
  return SPARK_MODEL_PATTERN.test(codexModel);
}

function isFailedWithCodexError(sessionDir: string, ticket: TicketInfo): boolean {
  if (!ticket.id) return false;
  const status = (ticket.status ?? '').trim().toLowerCase();
  if (status !== 'failed') return false;
  return ticketHasCodexCliError(path.join(sessionDir, ticket.id));
}

/**
 * Pure decision helper for the R-CNAR-6 spark codex smoke-run gate.
 *
 * Active iff `state.backend === 'codex'` AND `state.codex_model` matches
 * `^gpt-5\.3-codex-spark`. When inactive, returns `allow / gate_inactive`.
 *
 * Halt criteria:
 *   (i) tickets[0] or tickets[1] has `status: Failed` AND a codex-CLI-error
 *       breadcrumb in any `worker_session_<pid>.log` under that ticket dir.
 *  (ii) any 3 consecutive tickets in canonical (collectTickets) order are
 *       Failed-with-codex-CLI-error breadcrumb.
 *
 * Bypass: `state.flags.skip_smoke_gate_reason='<reason>'` short-circuits to
 * `bypass`. Caller is responsible for emitting the `smoke_gate_bypassed`
 * activity event exactly once per session.
 */
export function evaluateSparkSmokeGate(state: State, sessionDir: string): SparkSmokeGateDecision {
  if (!isSparkGateActive(state)) {
    return { action: 'allow', reason: 'gate_inactive', rule: 'gate_inactive' };
  }

  const skipReasonRaw = state.flags?.skip_smoke_gate_reason;
  const skipReason = typeof skipReasonRaw === 'string' ? skipReasonRaw.trim() : '';
  if (skipReason.length > 0) {
    return { action: 'bypass', reason: skipReason, rule: 'bypassed' };
  }

  const tickets = collectTickets(sessionDir);
  let consecutive = 0;
  for (let i = 0; i < tickets.length; i++) {
    const ticket = tickets[i];
    const failedWithErr = isFailedWithCodexError(sessionDir, ticket);

    if (i < 2 && failedWithErr) {
      return {
        action: 'halt',
        reason: `first 2 tickets must complete: ticket[${i}]=${ticket.id} failed with codex-CLI error`,
        rule: 'first_two_failed',
      };
    }

    consecutive = failedWithErr ? consecutive + 1 : 0;
    if (consecutive >= 3) {
      return {
        action: 'halt',
        reason: `3 consecutive ticket failures with codex-CLI errors (last: ${ticket.id})`,
        rule: 'three_consecutive_failed',
      };
    }
  }

  return { action: 'allow', reason: 'ok', rule: 'allow' };
}

const CIRCUIT_BREAKER_TIER_BUDGETS = {
  trivial: 3,
  small: 4,
  medium: 5,
  large: 12,
} as const;

type CircuitBreakerTier = keyof typeof CIRCUIT_BREAKER_TIER_BUDGETS;

export interface CircuitBreakerBudget {
  tier: string;
  budget: number;
}

function isCircuitBreakerTier(value: string): value is CircuitBreakerTier {
  return Object.prototype.hasOwnProperty.call(CIRCUIT_BREAKER_TIER_BUDGETS, value);
}

function defaultCircuitBreakerBudget(): CircuitBreakerBudget {
  return { tier: 'medium', budget: CIRCUIT_BREAKER_TIER_BUDGETS.medium };
}

function parseTicketComplexityTier(content: string): CircuitBreakerTier | null {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '---') return null;
    const match = /^complexity_tier:\s*["']?([A-Za-z_-]+)["']?\s*$/.exec(line);
    if (!match) continue;
    const tier = match[1].toLowerCase();
    return isCircuitBreakerTier(tier) ? tier : null;
  }
  return null;
}

export function getCircuitBreakerBudget(state: State, sessionDir: string): CircuitBreakerBudget {
  const cachedTier = typeof state.current_ticket_tier === 'string'
    ? state.current_ticket_tier.toLowerCase()
    : '';
  const rawCachedBudget = Number(state.current_ticket_budget);
  const cachedBudget = Number.isFinite(rawCachedBudget) ? rawCachedBudget : 0;
  if (isCircuitBreakerTier(cachedTier) && cachedBudget === CIRCUIT_BREAKER_TIER_BUDGETS[cachedTier]) {
    return { tier: cachedTier, budget: cachedBudget };
  }

  const ticket = typeof state.current_ticket === 'string' && state.current_ticket.length > 0
    ? state.current_ticket
    : null;
  if (!ticket) {
    const fallback = defaultCircuitBreakerBudget();
    state.current_ticket_tier = fallback.tier;
    state.current_ticket_budget = fallback.budget;
    return fallback;
  }

  const ticketPath = path.join(sessionDir, ticket, `rick_ticket_${ticket}.md`);
  let budget = defaultCircuitBreakerBudget();
  try {
    const tier = parseTicketComplexityTier(fs.readFileSync(ticketPath, 'utf-8'));
    if (tier) budget = { tier, budget: CIRCUIT_BREAKER_TIER_BUDGETS[tier] };
  } catch {
    budget = defaultCircuitBreakerBudget();
  }

  state.current_ticket_tier = budget.tier;
  state.current_ticket_budget = budget.budget;
  return budget;
}

function settingsWithCircuitBreakerBudget(settings: CircuitBreakerConfig, budget: number): CircuitBreakerConfig {
  return {
    ...settings,
    noProgressThreshold: budget,
    halfOpenAfter: Math.min(settings.halfOpenAfter, Math.max(1, budget - 1)),
  };
}

function formatCircuitBreakerTripReason(reason: string, budget: CircuitBreakerBudget): string {
  const match = /^No progress in (\d+) iterations(?:\..*)?$/.exec(reason);
  if (!match) return reason;
  return `No progress in ${match[1]} iterations (tier: ${budget.tier}, budget: ${budget.budget})`;
}

function clearCircuitBreakerBudgetCacheOnTicketChange(state: State, previousTicket: string | null): void {
  if (previousTicket !== null && previousTicket !== state.current_ticket) {
    delete state.current_ticket_tier;
    delete state.current_ticket_budget;
  }
}

// ---------------------------------------------------------------------------
// Per-ticket timeout counter (FR-B3/B4/B12/B14) — non-persisted loop state
// ---------------------------------------------------------------------------

export interface TimeoutCounterState {
  count: number;
  ticket: string | null;
}

export interface TimeoutCounterInput {
  prev: TimeoutCounterState;
  ticketNow: string | null;
  timedOut: boolean;
  completedClean: boolean;
}

/**
 * Pure counter update: increment on same-ticket timeout, reset to 1 on
 * different-ticket timeout, zero on clean completion, pass-through otherwise.
 * `halt: true` when count reaches 2 on the same ticket.
 */
export function applyTimeoutCounter(input: TimeoutCounterInput): TimeoutCounterState & { halt: boolean } {
  const { prev, ticketNow, timedOut, completedClean } = input;
  if (timedOut) {
    if (ticketNow !== null && ticketNow === prev.ticket) {
      const count = prev.count + 1;
      return { count, ticket: ticketNow, halt: count >= 2 };
    }
    return { count: 1, ticket: ticketNow, halt: false };
  }
  if (completedClean) {
    return { count: 0, ticket: null, halt: false };
  }
  return { count: prev.count, ticket: prev.ticket, halt: false };
}

/**
 * Returns true when the codegraph db mtime is older than the staleness threshold.
 * Returns false when the db is absent — full index is setup's responsibility.
 * Injectable `now` and `statSync` seams enable fast-tier unit tests.
 */
export function shouldSyncCodegraph(
  dbPath: string,
  stalenessMaxAgeMinutes: number,
  now: () => number = Date.now,
  statSync: (p: string) => { mtimeMs: number } = fs.statSync,
): boolean {
  try {
    const ageMs = now() - statSync(dbPath).mtimeMs;
    return ageMs >= stalenessMaxAgeMinutes * 60 * 1000;
  } catch {
    return false;
  }
}

export interface TimeoutHaltContext {
  statePath: string;
  sessionDir: string;
  ticketNow: string | null;
  timeoutCount: number;
}

/**
 * Halt side-effects for FR-B12/B14: reset CB (prevent orphan streak),
 * write state.json.activity entry, emit structured stderr JSON with
 * remediation_code=RAISE_TIMEOUT, safeDeactivate. Caller sets exitReason
 * and breaks the loop.
 */
export function executeTimeoutHalt(ctx: TimeoutHaltContext): void {
  const { statePath, sessionDir, ticketNow, timeoutCount } = ctx;
  resetCircuitBreaker(sessionDir, 'timeout_repeat halt');
  writeActivityEntry(statePath, {
    event: 'halt',
    halt_reason: 'timeout_repeat',
    halted_ticket: ticketNow,
    halted_at: new Date().toISOString(),
    timeout_count: timeoutCount,
    remediation: `Re-run via /pickle-pipeline --worker-timeout <N> for fresh session, or edit worker_timeout_seconds in ${statePath} and run /pickle-retry for this session.`,
  });
  console.error(JSON.stringify({
    exit_reason: 'timeout_repeat',
    remediation_code: 'RAISE_TIMEOUT',
    ticket_id: ticketNow,
    timeout_count: timeoutCount,
    message: 'Ticket timed out on 2 consecutive attempts.',
    state_path: statePath,
  }));
  recordExitReason(statePath, 'timeout_repeat');
  safeDeactivate(statePath);
}

export type LoopAction =
  | ({ kind: 'continue' } & LoopActionEffects)
  | ({ kind: 'break'; reason: ExitReason } & LoopActionEffects)
  | ({ kind: 'noop' } & LoopActionEffects)
  | ({ kind: 'relaunch'; relaunchCount: number; pendingTickets: number } & LoopActionEffects);

interface LoopActionEffects {
  consecutiveRateLimits?: number;
  timeoutCount?: number;
  lastTimeoutTicket?: string | null;
  cbState?: CircuitBreakerState | null;
  resetStall?: boolean;
}

export interface LoopContext {
  sessionDir: string;
  statePath: string;
  extensionRoot: string;
  iteration: number;
  log: (msg: string) => void;
  exitResult?: IterationExitResult;
  outcome?: IterationOutcome;
  iterLogFile?: string;
  consecutiveRateLimits?: number;
  maxRateLimitRetries?: number;
  rateLimitWaitMinutes?: number;
  /** Ticket e9bdac75: park ceiling (minutes). Defaults to DEFAULT_MAX_PARK_MINUTES. */
  maxParkMinutes?: number;
  /** Injectable resume-jitter (ms) for deterministic tests; production draws 60–120s. */
  parkJitterMs?: number;
  cbEnabled?: boolean;
  cbState?: CircuitBreakerState | null;
  cbSettings?: CircuitBreakerConfig;
  cbPath?: string;
  maxTurns?: number | null;
  timeoutCount?: number;
  lastTimeoutTicket?: string | null;
  lastStateIteration?: number;
  stallCount?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readState?: (statePath: string) => State;
  deactivate?: (statePath: string) => void;
  writeState?: (targetPath: string, value: unknown) => void;
  unlink?: (targetPath: string) => void;
  writeHandoff?: (sessionDir: string, content: string, pid: number, log: (msg: string) => void) => void;
  writeTimeout?: typeof writeTimeoutStub;
  updateState?: (mutator: (state: State) => void) => void;
}

function ctxNow(ctx: LoopContext): number {
  return ctx.now ? ctx.now() : Date.now();
}

function ctxReadState(ctx: LoopContext): State {
  return (ctx.readState || readRunnerState)(ctx.statePath);
}

/** Best-effort current-ticket read for the LoopContext recovery-exhausted handoff. */
function ctxCurrentTicket(ctx: LoopContext): string | null {
  try { return ctxReadState(ctx).current_ticket ?? null; } catch { return null; }
}

function ctxDeactivate(ctx: LoopContext): void {
  (ctx.deactivate || safeDeactivate)(ctx.statePath);
}

function ctxUpdateState(ctx: LoopContext, mutator: (state: State) => void): void {
  if (ctx.updateState) { ctx.updateState(mutator); return; }
  try { sm.update(ctx.statePath, mutator); } catch { /* best-effort persistence */ }
}

function ctxFinalize(ctx: LoopContext, exitReason: string): void {
  if (ctx.deactivate) {
    // Test seam: caller injected a deactivate hook — preserve old contract.
    ctx.deactivate(ctx.statePath);
    return;
  }
  finalizeTerminalState(ctx.statePath, {
    step: 'completed',
    runnerIteration: ctx.iteration,
    exitReason,
  });
}

function writeLoopState(ctx: LoopContext, targetPath: string, value: unknown): void {
  (ctx.writeState || writeStateFile)(targetPath, value as object);
}

function applyTimeoutCounterForLoop(input: TimeoutCounterInput): TimeoutCounterState & { halt: boolean } {
  return applyTimeoutCounter({ ...input });
}

function unlinkLoopPath(ctx: LoopContext, targetPath: string): void {
  if (ctx.unlink) {
    ctx.unlink(targetPath);
    return;
  }
  try { fs.unlinkSync(targetPath); } catch { /* ok */ }
}

/**
 * R-WTZ: a zeroed `worker_timeout_seconds` (microverse's own sentinel value, or
 * a resume-path bug landing 0) bricks every pickle-phase mux-runner launch with
 * exit 2 in milliseconds — masquerading as a "Session inactive" fast-exit.
 * Repair it in place at load instead of fatally exiting: recover the explicit
 * operator override from `state.flags.tier_cap_override.medium` (R-ICP-3),
 * otherwise fall back to the default worker budget. Only the exact value `0` is
 * repaired — negative / NaN / missing remain genuine corruption and stay fatal.
 */
export function repairZeroWorkerTimeout(state: State): { repaired: boolean; value: number } {
  const raw = (state as unknown as Record<string, unknown>).worker_timeout_seconds;
  if (raw !== 0) {
    const rawNum = Number(raw);
    const value = Number.isFinite(rawNum) && rawNum > 0
      ? rawNum
      : Defaults.WORKER_TIMEOUT_SECONDS;
    return { repaired: false, value };
  }
  const override = state.flags?.tier_cap_override as
    | { medium?: { worker_timeout_seconds?: unknown } }
    | undefined;
  const mediumOverride = Number(override?.medium?.worker_timeout_seconds);
  const recovered = Number.isInteger(mediumOverride) && mediumOverride > 0
    ? mediumOverride
    : Defaults.WORKER_TIMEOUT_SECONDS;
  state.worker_timeout_seconds = recovered;
  return { repaired: true, value: recovered };
}

export function validateStartupState(state: State, statePath: string): void {
  const repair = repairZeroWorkerTimeout(state);
  if (repair.repaired) {
    sm.update(statePath, s => { s.worker_timeout_seconds = repair.value; });
  }
  const rawObj = state as unknown as Record<string, unknown>;
  const issues: string[] = [];
  const maxIterField = rawObj.max_iterations;
  const rawMaxIter = Number(maxIterField);
  if (maxIterField == null || !Number.isFinite(rawMaxIter) || rawMaxIter < 0) {
    issues.push(`max_iterations must be >= 0 (got ${maxIterField})`);
  }
  const rawTimeout = Number(rawObj.worker_timeout_seconds);
  if (!Number.isFinite(rawTimeout) || rawTimeout <= 0) issues.push(`worker_timeout_seconds must be > 0 (got ${rawObj.worker_timeout_seconds})`);
  else if (rawTimeout > 86400) issues.push(`worker_timeout_seconds > 86400s implausible (got ${rawTimeout}); edit state.json`);
  const iterField = rawObj.iteration;
  const rawIter = Number(iterField);
  if (iterField == null || !Number.isFinite(rawIter) || rawIter < 0) issues.push(`iteration must be >= 0 (got ${iterField})`);
  if (issues.length > 0) throw new Error(`Invalid state at ${statePath}:\n  - ${issues.join('\n  - ')}`);
}

/**
 * Sentinel file written into SESSION_ROOT on signal teardown when ≥1 ticket is
 * still remaining (any status other than Done). pipeline-runner reads its
 * presence as an authoritative "pickle phase did NOT complete" signal that
 * forces incomplete regardless of the mux exit code (which a SIGTERM-killed mux
 * sets to 0). Primary signal of B-RRH C2; consumed by pipeline-runner C1.
 */
export const PICKLE_INCOMPLETE_SENTINEL = 'pickle_incomplete.json';

/**
 * B-RRH C2: on signal teardown, if ≥1 ticket is still remaining (status !==
 * Done — Todo/In-Progress/Failed/Skipped all count), write the
 * `pickle_incomplete.json` sentinel into SESSION_ROOT and emit the
 * `pickle_incomplete` activity event. When all tickets are Done (or none exist),
 * write NO sentinel. Returns true iff the sentinel was written. Fully
 * best-effort: never throws (a signal handler must always reach process.exit).
 */
export function writePickleIncompleteSentinelIfRemaining(
  sessionDir: string,
  statePath: string,
  log: (msg: string) => void,
): boolean {
  try {
    const tickets = collectTickets(sessionDir);
    const remaining = tickets.filter(
      t => (t.status || '').toLowerCase().replace(/["']/g, '').trim() !== 'done',
    );
    if (tickets.length === 0 || remaining.length === 0) return false;
    const ts = new Date().toISOString();
    const sentinelPath = path.join(sessionDir, PICKLE_INCOMPLETE_SENTINEL);
    try {
      fs.writeFileSync(sentinelPath, JSON.stringify({
        reason: 'signal_teardown',
        remaining_count: remaining.length,
        total: tickets.length,
        ts,
      }, null, 2));
    } catch (err) {
      log(`WARNING: failed to write pickle_incomplete sentinel: ${safeErrorMessage(err)}`);
    }
    const incompleteEvent = { event: 'pickle_incomplete' as const, source: 'pickle' as const, ts };
    try { writeActivityEntry(statePath, incompleteEvent); } catch { /* telemetry best effort */ }
    try { logActivity(incompleteEvent); } catch { /* telemetry best effort */ }
    log(`pickle_incomplete: ${remaining.length}/${tickets.length} tickets remaining at signal teardown`);
    return true;
  } catch (err) {
    log(`WARNING: pickle_incomplete sentinel check failed: ${safeErrorMessage(err)}`);
    return false;
  }
}

/**
 * Graceful shutdown: deactivate the session on SIGTERM/SIGINT/SIGHUP so it does
 * not remain orphaned with `active: true` when the tmux pane is closed.
 *
 * This is the ONE shutdown handler. It used to have an inline twin inside
 * `runMuxRunnerMain`, and the twins diverged: only this copy stamped the B-RRH
 * C2 sentinel, and only the inline copy was actually registered — so
 * `pickle_incomplete.json` was never written and pipeline-runner's C1 robustness
 * gate (`maybeStampPickleIncompleteRobust`) read a file no producer created.
 *
 * `releaseSessionResources` is the caller's own teardown (phantom-Done watchers,
 * codegraph session) — session-scoped handles the signal path must close but
 * this function must not know about.
 *
 * Returns the handler so a test can drive the real teardown; registration is a
 * side effect.
 */
export function installShutdownSignalHandlers(opts: {
  statePath: string;
  sessionDir: string;
  log: (msg: string) => void;
  releaseSessionResources: () => void;
}): (signal: string) => void {
  const { statePath, sessionDir, log, releaseSessionResources } = opts;
  const handleShutdownSignal = (signal: string): void => {
    const backend = readBackendForActivity(statePath);
    const signalEvent = buildSignalReceivedEvent(statePath, sessionDir, signal);
    writeActivityEntry(statePath, signalEvent);
    try {
      logActivity(signalEvent);
    } catch { /* telemetry best effort */ }
    log(`Received ${signal} — deactivating session`);
    log(`signal_received ${JSON.stringify(signalEvent)}`);
    // B-RRH C2: stamp the pickle_incomplete sentinel BEFORE deactivation so a
    // SIGTERM-killed mux (which exits 0) cannot be read as a clean completion.
    writePickleIncompleteSentinelIfRemaining(sessionDir, statePath, log);
    recordExitReason(statePath, 'signal');
    safeDeactivate(statePath);
    removeRunnerSessionMapEntry(statePath, log);
    if (currentChildProc && !currentChildProc.killed) currentChildProc.kill('SIGTERM');
    releaseSessionResources();
    logActivity({ event: 'session_end', source: 'pickle', session: path.basename(sessionDir), mode: 'tmux', backend });
    process.exit(0);
  };
  process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
  process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
  process.on('SIGHUP', () => handleShutdownSignal('SIGHUP'));
  return handleShutdownSignal;
}

function readBackendForActivity(statePath: string): Backend {
  try {
    return resolveBackend(readRunnerState(statePath));
  } catch {
    return resolveBackend(null);
  }
}

function getProcessGroupId(pid: number): number | null {
  const pgidFn = (process as NodeJS.Process & { getpgid?: (targetPid: number) => number }).getpgid;
  if (typeof pgidFn !== 'function') return null;
  try {
    return pgidFn(pid);
  } catch {
    return null;
  }
}

function getHandlerStackFrames(): string[] {
  return new Error('signal received').stack
    ?.split('\n')
    .slice(1, 6)
    .map((line) => line.trim()) ?? [];
}

function lookupCommandForPid(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf-8',
      timeout: 5_000,
    });
    const command = out.trim();
    return command.length > 0 ? command : null;
  } catch {
    return null;
  }
}

function resolveSignalSenderAttribution(): { signal_sender_pid: number | null; signal_sender_cmd: string | null } {
  if (!Number.isInteger(process.ppid) || process.ppid <= 1) {
    return { signal_sender_pid: null, signal_sender_cmd: null };
  }
  return {
    signal_sender_pid: process.ppid,
    signal_sender_cmd: lookupCommandForPid(process.ppid),
  };
}

function buildSignalReceivedEvent(statePath: string, sessionDir: string, signal: string) {
  const sender = resolveSignalSenderAttribution();
  const receivedAt = new Date().toISOString();
  let currentPhase: string | null = null;
  try {
    const state = readRunnerState(statePath);
    currentPhase = typeof state.step === 'string' ? state.step : null;
  } catch {
  }
  return {
    event: 'signal_received' as const,
    ts: receivedAt,
    source: 'pickle' as const,
    session: path.basename(sessionDir),
    signal,
    pid: process.pid,
    ppid: process.ppid,
    is_tty: Boolean(process.stdin.isTTY || process.stdout.isTTY),
    pgid: getProcessGroupId(process.pid),
    active_child_pid: currentChildProc?.pid ?? null,
    active_child_cmd: currentChildProc?.spawnargs?.join(' ') ?? null,
    current_phase: currentPhase,
    received_at_iso: receivedAt,
    handler_stack: getHandlerStackFrames(),
    gate_payload: sender,
  };
}

/**
 * AC-LPB-04: classify a `StateManager.read()` failure on the per-iteration
 * cap-check read.
 *
 * `SCHEMA_MISMATCH` is a recoverable concurrent-writer race — a fresh read
 * on the next outer-loop turn will see the migrated state. Emit an
 * escalation activity event so the user can act if it persists, surface the
 * failure to `mux-runner.log` for visibility, then signal `'continue'` so
 * the caller retries instead of exiting (which would strand pending work).
 *
 * Every other StateError code (MISSING, CORRUPT, LOCK_FAILED, …) is
 * terminal — return `'exit_error'` so the legacy code path runs.
 */
export type CapCheckReadDecision = 'continue' | 'exit_error';
export function classifyCapCheckReadError(
  err: unknown,
  sessionDir: string,
  log: (msg: string) => void,
): CapCheckReadDecision {
  const msg = safeErrorMessage(err);
  const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined;
  if (code === 'SCHEMA_MISMATCH') {
    log(`WARN: state.json schema mismatch on cap-check read: ${msg}. Retrying next iteration.`);
    logActivity({
      event: 'cap_check_failed_schema_mismatch',
      source: 'pickle',
      session: path.basename(sessionDir),
      error: msg,
    });
    return 'continue';
  }
  log(`ERROR: Cannot read state.json: ${msg}. Exiting loop.`);
  return 'exit_error';
}

export async function processRateLimitCycle(state: State, ctx: LoopContext): Promise<LoopAction> {
  const exitResult = ctx.exitResult;
  if (exitResult?.type !== 'api_limit') return { kind: 'noop' };
  const consecutiveRateLimits = (ctx.consecutiveRateLimits || 0) + 1;
  const maxRetries = ctx.maxRateLimitRetries || 3;
  const waitMinutes = ctx.rateLimitWaitMinutes || 5;
  const maxParkMinutes = ctx.maxParkMinutes ?? DEFAULT_MAX_PARK_MINUTES;
  ctx.log(`API rate limit detected (consecutive: ${consecutiveRateLimits}/${maxRetries})`);
  const decision = decideRateLimitCycle(exitResult, consecutiveRateLimits, maxRetries, waitMinutes, maxParkMinutes,
    () => ctxReadState(ctx).rate_limit_park ?? null);
  if (decision.kind === 'bail') {
    logActivity({ event: 'rate_limit_exhausted', source: 'pickle', session: path.basename(ctx.sessionDir), error: `max retries (${maxRetries}) exceeded, no resetsAt available` });
    ctxDeactivate(ctx);
    return { kind: 'break', reason: 'rate_limit_exhausted', consecutiveRateLimits };
  }
  // B5: no reset_at → never spawn-burn; fall back to now + configured min wait.
  if (!decision.rlAction.hasResetsAt) {
    logActivity({ event: 'rate_limited_without_reset_at', source: 'pickle', session: path.basename(ctx.sessionDir) });
  }
  // B5: cumulative park ceiling → clean exit via the EXISTING rate_limit_exhausted path.
  if (decision.kind === 'park_exhausted') {
    logActivity({ event: 'rate_limit_park_exhausted', source: 'pickle', session: path.basename(ctx.sessionDir) });
    ctxDeactivate(ctx);
    return { kind: 'break', reason: 'rate_limit_exhausted', consecutiveRateLimits };
  }
  return processRateLimitWait(state, ctx, exitResult, decision.rlAction, consecutiveRateLimits, decision.priorPark);
}

async function processRateLimitWait(
  state: State,
  ctx: LoopContext,
  exitResult: Extract<IterationExitResult, { type: 'api_limit' }>,
  rlAction: RateLimitAction,
  consecutiveRateLimits: number,
  priorPark: RateLimitPark | null,
): Promise<LoopAction> {
  const waitSource = rlAction.waitSource;
  const waitPath = path.join(ctx.sessionDir, 'rate_limit_wait.json');
  const resetAtSec = rlAction.resetAtEpochSec ?? null;
  const waitUntil = new Date(ctxNow(ctx) + rlAction.waitMs).toISOString();
  const parkEpisodeStartMs = priorPark?.parked_started_epoch_ms ?? ctxNow(ctx);
  const priorCumulativeMs = priorPark?.cumulative_parked_ms ?? 0;
  logActivity({ event: 'rate_limit_wait', source: 'pickle', session: path.basename(ctx.sessionDir), duration_min: Math.ceil(rlAction.waitMs / 60_000), reset_at: resetAtSec });
  // Park flag (C6a): present while parked so the watchdogs short-circuit to in_wait_state.
  writeLoopState(ctx, waitPath, {
    waiting: true, reason: 'API rate limit', started_at: new Date(ctxNow(ctx)).toISOString(), wait_until: waitUntil,
    consecutive_waits: consecutiveRateLimits, rate_limit_type: exitResult.rateLimitInfo?.rateLimitType || null,
    resets_at_epoch: resetAtSec, wait_source: waitSource,
  });
  // B4: persist the park-arm so a --resume relaunch re-arms instead of spawn-burning.
  ctxUpdateState(ctx, (s) => {
    s.rate_limit_park = {
      reset_at_epoch_sec: resetAtSec,
      parked_started_epoch_ms: parkEpisodeStartMs,
      cumulative_parked_ms: priorCumulativeMs,
      consecutive_waits: consecutiveRateLimits,
    };
  });
  const parkStartMs = ctxNow(ctx);
  const limitedWait = await waitThroughRateLimit(ctx, resetAtSec, (ctx.rateLimitWaitMinutes || 5) * 60 * 1000);
  if (limitedWait.exit) return { kind: 'break', reason: limitedWait.reason, consecutiveRateLimits };
  unlinkLoopPath(ctx, waitPath);
  // B3: exclude parked wall from max_time_minutes by advancing start_time_epoch.
  const parkedMs = ctxNow(ctx) - parkStartMs;
  const parkedSeconds = Math.floor(parkedMs / 1000);
  ctxUpdateState(ctx, (s) => {
    if (typeof s.start_time_epoch === 'number' && Number.isFinite(s.start_time_epoch)) {
      s.start_time_epoch += parkedSeconds;
    }
    s.rate_limit_park = null;
  });
  const nextConsecutive = rlAction.resetCounter ? 0 : consecutiveRateLimits;
  const parkedMinutes = Math.ceil(parkedMs / 60_000);
  logActivity({ event: 'rate_limit_resume', source: 'pickle', session: path.basename(ctx.sessionDir), parked_minutes: parkedMinutes });
  const handoffContent = [
    buildIterationHandoffSummary(state, ctx.sessionDir, ctx.iteration + 1), '',
    `NOTE: Resumed after ${parkedMinutes}-minute API rate limit park (source: ${waitSource}).`,
    'Resume from current phase — do not repeat the rate-limited iteration.',
  ].join('\n');
  (ctx.writeHandoff || writeHandoffAtomic)(ctx.sessionDir, handoffContent, process.pid, ctx.log);
  return { kind: 'continue', consecutiveRateLimits: nextConsecutive };
}

/**
 * Sleep through a rate-limit park until the jittered resume target. Parked wall is
 * EXCLUDED from max_time_minutes (the caller advances start_time_epoch on wake), so
 * this loop is cancellable but NOT budget-clamped. Resume at
 * max(reset_at + jitter, now + min_wait) (ticket e9bdac75, B2/B3).
 */
async function waitThroughRateLimit(
  ctx: LoopContext,
  resetAtSec: number | null,
  minWaitMs: number,
): Promise<{ exit: false } | { exit: true; reason: ExitReason }> {
  const jitterMs = ctx.parkJitterMs ?? drawParkResumeJitterMs();
  const resumeTargetMs = resolveParkResumeTime(resetAtSec, ctxNow(ctx), minWaitMs, jitterMs);
  while (ctxNow(ctx) < resumeTargetMs) {
    await (ctx.sleep || sleep)(Defaults.RATE_LIMIT_POLL_MS);
    try {
      if (ctxReadState(ctx).active !== true) return { exit: true, reason: 'cancelled' };
    } catch { /* proceed */ }
  }
  return { exit: false };
}

export interface MainLoopRateLimitParkInput {
  exitResult: Extract<IterationExitResult, { type: 'api_limit' }>;
  /** Already incremented for THIS park by the caller. */
  consecutiveRateLimits: number;
  maxRateLimitRetries: number;
  rateLimitWaitMinutes: number;
  maxParkMinutes: number;
  statePath: string;
  sessionDir: string;
  state: State;
  iteration: number;
  log: (msg: string) => void;
  /** Seams: a test drives a multi-hour park without a multi-hour sleep. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  jitterMs?: number;
}

export type MainLoopRateLimitParkOutcome =
  | { kind: 'exit'; exitReason: ExitReason }
  | { kind: 'resume'; consecutiveRateLimits: number; handoffContent: string };

/**
 * The main loop's rate-limit park: decide, persist the arm, sleep through the
 * reset, then FOLD the burned wall into the episode ledger.
 *
 * Extracted out of `runMuxRunnerMain` so the B5 ledger invariant has a callable
 * seam. Inline, its only regression pin was a regex over this file's own source
 * text — the test said so itself ("no callable seam"). That pin cannot fail for
 * the reason that matters: it greps the mechanism, never runs it, so it stays
 * green if the fold is correct but unreachable, and goes red on a reformat that
 * changes nothing.
 *
 * NOT to be confused with the dead `processRateLimitWait` twin above, which
 * NULLS the arm on wake — pre-B-RRH behavior its (out-of-scope, fence-pinned)
 * tests still assert. This one folds. See the B5 park-ledger trap door in
 * `extension/CLAUDE.md`.
 */
export async function runMainLoopRateLimitPark(
  input: MainLoopRateLimitParkInput,
): Promise<MainLoopRateLimitParkOutcome> {
  const {
    exitResult, consecutiveRateLimits, maxRateLimitRetries, rateLimitWaitMinutes,
    maxParkMinutes, statePath, sessionDir, state, iteration, log,
  } = input;
  const now = input.now ?? Date.now;
  const sleepFn = input.sleep ?? sleep;
  const session = path.basename(sessionDir);

  logRateLimitDetected(log, exitResult, consecutiveRateLimits, maxRateLimitRetries);

  // B5: cumulative park ceiling. Accumulate parked wall across this episode via
  // the persisted park record; on exceed, emit (activity-only)
  // rate_limit_park_exhausted and clean-exit via the EXISTING rate_limit_exhausted
  // exit path (NEVER a new exit_reason).
  const decision = decideRateLimitCycle(exitResult, consecutiveRateLimits, maxRateLimitRetries, rateLimitWaitMinutes, maxParkMinutes,
    () => readRunnerState(statePath).rate_limit_park ?? null);
  const rlAction = decision.rlAction;

  if (decision.kind === 'bail') {
    logActivity({ event: 'rate_limit_exhausted', source: 'pickle',
      session, error: `max retries (${maxRateLimitRetries}) exceeded, no resetsAt available` });
    recordExitReason(statePath, 'rate_limit_exhausted');
    safeDeactivate(statePath);
    return { kind: 'exit', exitReason: 'rate_limit_exhausted' };
  }

  const { waitMs: computedWaitMs, waitSource } = rlAction;
  if (waitSource === 'api') {
    log(`Parking on API reset: ${Math.ceil(computedWaitMs / 60_000)}min until reset (vs ${rateLimitWaitMinutes}min config default, clamped to ${maxParkMinutes}min ceiling).`);
  }

  // B5: no reset_at → never spawn-burn; fall back to now + configured min wait.
  if (!rlAction.hasResetsAt) {
    logActivity({ event: 'rate_limited_without_reset_at', source: 'pickle', session });
  }

  if (decision.kind === 'park_exhausted') {
    logActivity({ event: 'rate_limit_park_exhausted', source: 'pickle', session });
    log(`Cumulative rate-limit park exceeded ${maxParkMinutes}min ceiling — giving up cleanly for recovery.`);
    recordExitReason(statePath, 'rate_limit_exhausted');
    safeDeactivate(statePath);
    return { kind: 'exit', exitReason: 'rate_limit_exhausted' };
  }

  const priorPark = decision.priorPark;
  const resetAtSec = rlAction.resetAtEpochSec ?? null;
  const parkStartMs = now();
  armRateLimitPark({
    statePath, sessionDir, session, priorPark, resetAtSec, rlAction,
    consecutiveRateLimits, nowMs: parkStartMs,
    rateLimitType: exitResult.rateLimitInfo?.rateLimitType || null,
  });

  // B2: resume at max(reset_at + jitter, now + min_wait). B3: parked wall is
  // EXCLUDED from max_time_minutes — we do NOT clamp the wait by the remaining
  // budget; instead we advance start_time_epoch by the parked seconds on resume so
  // the wall-clock cap never counts parked time. The sleep loop stays cancellable.
  const resumeTargetMs = resolveParkResumeTime(
    resetAtSec, parkStartMs, rateLimitWaitMinutes * 60 * 1000, input.jitterMs ?? drawParkResumeJitterMs(),
  );
  while (now() < resumeTargetMs) {
    await sleepFn(Defaults.RATE_LIMIT_POLL_MS);
    try {
      if (readRunnerState(statePath).active !== true) {
        recordExitReason(statePath, 'cancelled');
        safeDeactivate(statePath);
        return { kind: 'exit', exitReason: 'cancelled' };
      }
    } catch { /* proceed */ }
  }

  const parkedMinutes = foldRateLimitParkOnWake({
    statePath, sessionDir, session, priorPark,
    parkedMs: now() - parkStartMs, consecutiveRateLimits, nowMs: now(),
  });
  return {
    kind: 'resume',
    consecutiveRateLimits: rlAction.resetCounter ? 0 : consecutiveRateLimits,
    handoffContent: [
      buildIterationHandoffSummary(state, sessionDir, iteration + 1), '',
      `NOTE: Resumed after ${parkedMinutes}-minute API rate limit park (source: ${waitSource}).`,
      'Resume from current phase — do not repeat the rate-limited iteration.',
    ].join('\n'),
  };
}

/** Operator breadcrumb for a detected rate limit, plus the API's own reset report. */
function logRateLimitDetected(
  log: (msg: string) => void,
  exitResult: Extract<IterationExitResult, { type: 'api_limit' }>,
  consecutiveRateLimits: number,
  maxRateLimitRetries: number,
): void {
  log(`API rate limit detected (consecutive: ${consecutiveRateLimits}/${maxRateLimitRetries})`);
  const resetsAt = exitResult.rateLimitInfo?.resetsAt;
  if (!resetsAt) return;
  const kind = exitResult.rateLimitInfo?.rateLimitType || 'unknown';
  log(`API reports reset at ${new Date(resetsAt * 1000).toISOString()} (type: ${kind})`);
}

/**
 * Park entry: raise the watchdog park flag and persist the B4 arm so a `--resume`
 * relaunch re-arms instead of spawn-burning into the wall.
 */
function armRateLimitPark(args: {
  statePath: string; sessionDir: string; session: string;
  priorPark: RateLimitPark | null; resetAtSec: number | null; rlAction: RateLimitAction;
  consecutiveRateLimits: number; nowMs: number; rateLimitType: string | null;
}): void {
  const { statePath, sessionDir, session, priorPark, resetAtSec, rlAction, consecutiveRateLimits, nowMs } = args;
  logActivity({ event: 'rate_limit_wait', source: 'pickle',
    session, duration_min: Math.ceil(rlAction.waitMs / 60_000), reset_at: resetAtSec });
  // Park flag (C6a): present while parked so the idle + CPU watchdogs short-circuit
  // to in_wait_state and never salvage a parked worker.
  writeStateFile(path.join(sessionDir, 'rate_limit_wait.json'), {
    waiting: true, reason: 'API rate limit',
    started_at: new Date(nowMs).toISOString(),
    wait_until: new Date(nowMs + rlAction.waitMs).toISOString(),
    consecutive_waits: consecutiveRateLimits,
    rate_limit_type: args.rateLimitType,
    resets_at_epoch: resetAtSec,
    wait_source: rlAction.waitSource,
  });
  // B4: persist the park-arm so a --resume relaunch re-arms instead of spawn-burning.
  try {
    sm.update(statePath, (s) => {
      s.rate_limit_park = {
        reset_at_epoch_sec: resetAtSec,
        parked_started_epoch_ms: priorPark?.parked_started_epoch_ms ?? nowMs,
        cumulative_parked_ms: priorPark?.cumulative_parked_ms ?? 0,
        consecutive_waits: consecutiveRateLimits,
      };
    });
  } catch { /* best-effort persistence */ }
}

/**
 * Park wake: advance `start_time_epoch` past the parked wall (B3) and FOLD the
 * burned time into the episode ledger (B5). Returns the parked minutes.
 *
 * The fold is the whole point: `s.rate_limit_park = null` here pinned
 * `cumulative_parked_ms` at 0, which made `rate_limit_park_exhausted` unreachable
 * and left a 429 storm unbounded.
 */
function foldRateLimitParkOnWake(args: {
  statePath: string; sessionDir: string; session: string;
  priorPark: RateLimitPark | null; parkedMs: number; consecutiveRateLimits: number; nowMs: number;
}): number {
  const { statePath, sessionDir, session, priorPark, parkedMs, consecutiveRateLimits, nowMs } = args;
  // Wake: B3 exclude parked wall from max_time_minutes by advancing start_time_epoch.
  const parkedSeconds = Math.floor(parkedMs / 1000);
  try {
    sm.update(statePath, (s) => {
      if (typeof s.start_time_epoch === 'number' && Number.isFinite(s.start_time_epoch)) {
        s.start_time_epoch += parkedSeconds;
      }
      // B5: fold the burned wall into the episode ledger — nulling it here
      // pinned cumulative_parked_ms at 0 and made the ceiling unreachable.
      s.rate_limit_park = foldParkIntoEpisode(priorPark, parkedMs, consecutiveRateLimits, nowMs);
    });
  } catch { /* best-effort */ }

  try { fs.unlinkSync(path.join(sessionDir, 'rate_limit_wait.json')); } catch { /* ok */ }
  const parkedMinutes = Math.ceil(parkedMs / 60_000);
  logActivity({ event: 'rate_limit_resume', source: 'pickle', session, parked_minutes: parkedMinutes });
  return parkedMinutes;
}

export async function processIterationOutcome(state: State, outcome: IterationOutcome, ctx: LoopContext): Promise<LoopAction> {
  const result = outcome.completion;
  const timeoutAction = processTimeoutOutcome(state, outcome, ctx);
  if (timeoutAction.kind === 'break') return timeoutAction;
  const cbAction = recordCircuitBreakerOutcome(state, result, ctx);
  if (cbAction.kind === 'break') return { ...timeoutAction, ...cbAction };
  const branchAction = await processCompletionBranch(state, result, ctx);
  return { ...timeoutAction, ...branchAction, cbState: cbAction.cbState };
}

function processTimeoutOutcome(state: State, outcome: IterationOutcome, ctx: LoopContext): LoopAction {
  let ticketForTimeout: string | null = state.current_ticket || null;
  try { ticketForTimeout = ctxReadState(ctx).current_ticket || null; } catch { /* keep pre-iteration ticket */ }
  const counterNext = applyTimeoutCounterForLoop({
    prev: { count: ctx.timeoutCount || 0, ticket: ctx.lastTimeoutTicket || null },
    ticketNow: ticketForTimeout,
    timedOut: outcome.timedOut === true,
    completedClean: outcome.completion === 'task_completed',
  });
  if (outcome.timedOut) {
    (ctx.writeTimeout || writeTimeoutStub)(ctx.sessionDir, {
      ticketId: ticketForTimeout, iteration: ctx.iteration, wallSeconds: outcome.wallSeconds,
      workerTimeoutSeconds: Number(state.worker_timeout_seconds) || 0, timeoutCount: counterNext.count,
      logFile: ctx.iterLogFile || path.join(ctx.sessionDir, `tmux_iteration_${ctx.iteration}.log`),
    });
  }
  if (!counterNext.halt) return { kind: 'noop', timeoutCount: counterNext.count, lastTimeoutTicket: counterNext.ticket };
  // W4a: route the timeout-repeat halt through the single choke point BEFORE parking.
  // A near-green diff recovered by the ladder continues the loop (counter reset); the
  // bare `executeTimeoutHalt` park survives only on fall_through / exhausted.
  // AC-2 fail-safe: the git-mutating recovery call MUST have an explicit working_dir
  // (never process.cwd() / the real repo); when absent, park without recovering.
  const timeoutWorkingDir = (() => {
    try { return ctxReadState(ctx).working_dir || null; } catch { return null; }
  })();
  if (ticketForTimeout && timeoutWorkingDir) {
    const recovery = routeRecoveryBeforeTerminal({
      sessionDir: ctx.sessionDir,
      statePath: ctx.statePath,
      extensionRoot: ctx.extensionRoot,
      workingDir: timeoutWorkingDir,
      ticketId: ticketForTimeout,
      iteration: ctx.iteration,
      flags: (state.flags as Record<string, unknown> | undefined) ?? null,
      log: ctx.log,
      mode: 'worker',
      evidence: { halt_site: 'timeout_repeat', timeout_count: counterNext.count },
    });
    if (recovery.kind === 'advanced') {
      ctx.log(`recovery: ${recovery.strategy} advanced ${ticketForTimeout} before timeout_repeat halt — continuing.`);
      return { kind: 'continue', resetStall: true, timeoutCount: 0, lastTimeoutTicket: null };
    }
  }
  ctx.log(`Timeout halt: ticket ${ticketForTimeout} timed out ${counterNext.count} consecutive iterations`);
  executeTimeoutHalt({ statePath: ctx.statePath, sessionDir: ctx.sessionDir, ticketNow: ticketForTimeout, timeoutCount: counterNext.count });
  // Preserves the legacy source-order invariant: exitReason = 'timeout_repeat' before break.
  return { kind: 'break', reason: 'timeout_repeat', timeoutCount: counterNext.count, lastTimeoutTicket: counterNext.ticket };
}

function recordCircuitBreakerOutcome(state: State, result: IterationOutcome['completion'], ctx: LoopContext): LoopAction {
  if (!ctx.cbEnabled || !ctx.cbState || !ctx.cbSettings || result === 'error' || result === 'inactive') return { kind: 'noop', cbState: ctx.cbState };
  const errorSig = readCircuitBreakerErrorSignature(ctx);
  const postIterState = readPostIterationState(state, ctx);
  clearCircuitBreakerBudgetCacheOnTicketChange(postIterState, ctx.cbState.last_known_ticket);
  const progress = detectProgress(
    postIterState.working_dir || process.cwd(), ctx.cbState.last_known_head, ctx.cbState.last_known_step,
    postIterState.step, ctx.cbState.last_known_ticket, postIterState.current_ticket,
  );
  const budget = getCircuitBreakerBudget(postIterState, ctx.sessionDir);
  const cbSettings = settingsWithCircuitBreakerBudget(ctx.cbSettings, budget.budget);
  const prevCBState = ctx.cbState.state;
  const cbState = recordIterationResult(ctx.cbState, { hasProgress: progress.hasProgress, errorSignature: errorSig }, ctx.iteration, cbSettings);
  cbState.last_known_head = progress.currentHead;
  cbState.last_known_step = postIterState.step;
  cbState.last_known_ticket = postIterState.current_ticket;
  if (prevCBState !== 'OPEN' && cbState.state === 'OPEN') {
    cbState.reason = formatCircuitBreakerTripReason(cbState.reason, budget);
  }
  if (ctx.cbPath) writeLoopState(ctx, ctx.cbPath, cbState);
  if (prevCBState !== 'OPEN' && cbState.state === 'OPEN') {
    logActivity({ event: 'circuit_open', source: 'pickle', session: path.basename(ctx.sessionDir), error: cbState.reason });
    ctx.log(`Circuit breaker tripped: ${cbState.reason}`);
    ctxDeactivate(ctx);
    return { kind: 'break', reason: 'circuit_open', cbState };
  }
  if (prevCBState === 'HALF_OPEN' && cbState.state === 'CLOSED') {
    logActivity({ event: 'circuit_recovery', source: 'pickle', session: path.basename(ctx.sessionDir) });
    ctx.log('Circuit breaker recovered (HALF_OPEN → CLOSED)');
  }
  return { kind: 'noop', cbState };
}

function readCircuitBreakerErrorSignature(ctx: LoopContext): string | null {
  try {
    const logContent = fs.readFileSync(ctx.iterLogFile || '', 'utf-8');
    return logContent ? extractErrorSignature(logContent) : null;
  } catch {
    return null;
  }
}

function readPostIterationState(state: State, ctx: LoopContext): State {
  try {
    return ctxReadState(ctx);
  } catch {
    return state;
  }
}

/**
 * R-CMWL-4: Tracks consecutive zero-progress codex manager relaunch passes.
 * A pass is zero-progress when the pending ticket count did not decrease since
 * the last relaunch. Resets to 0 on any pass with progress.
 * Returns `{ halt: true }` when 2 consecutive zero-progress passes occurred.
 */
function checkAndUpdateCodexManagerNoProgress(
  statePath: string,
  pendingCount: number,
  log: (msg: string) => void,
): { halt: boolean; consecutiveCount: number } {
  let halt = false;
  let consecutiveCount = 0;
  try {
    sm.update(statePath, (s) => {
      const baseline = typeof s.codex_manager_relaunch_pending_baseline === 'number'
        ? s.codex_manager_relaunch_pending_baseline : null;
      const prior = typeof s.codex_manager_consecutive_no_progress === 'number'
        ? s.codex_manager_consecutive_no_progress : 0;
      if (baseline === null) {
        s.codex_manager_consecutive_no_progress = 0;
        s.codex_manager_relaunch_pending_baseline = pendingCount;
      } else if (pendingCount >= baseline) {
        consecutiveCount = prior + 1;
        s.codex_manager_consecutive_no_progress = consecutiveCount;
        s.codex_manager_relaunch_pending_baseline = pendingCount;
      } else {
        consecutiveCount = 0;
        s.codex_manager_consecutive_no_progress = 0;
        s.codex_manager_relaunch_pending_baseline = pendingCount;
      }
      halt = consecutiveCount >= 2;
    });
  } catch (err) {
    log(`WARN: failed to update codex no-progress counter: ${safeErrorMessage(err)}`);
  }
  return { halt, consecutiveCount };
}

/**
 * Single suppressor predicate consulted by both manager-relaunch guards (R-PPXR AC-PPXR-2; was
 * duplicated character-for-character at two sites). Returns `true` to SUPPRESS the relaunch (a genuinely
 * fatal subprocess crash / spawn failure that tears down) and `false` to ALLOW the existing
 * `evaluateManagerRelaunch` chain to relaunch.
 *
 * Fatal (return `true`): a deterministic non-zero exit code; a null-exit SPAWN FAILURE (empty iteration
 * log — the manager never started); OR a null-exit cut-off with nothing left to recover (no pending
 * tickets OR the relaunch cap already reached).
 * Retryable (return `false`): a manager turn cut off mid-tool-result — `other_error`, `outcome` defined,
 * `exitCode === null`, NOT timed out, the iteration log shows the turn STARTED (stream events) but
 * produced no `result` event — while pending tickets remain AND the relaunch count is below
 * `Defaults.CLAUDE_MANAGER_RELAUNCH_CAP` (decision.nextRelaunchCount <= decision.cap; nextRelaunchCount
 * is prior+1, so this holds exactly when prior < cap). No `signal_received` / external-SIGTERM marker is
 * present on the cut-off signature (confirmed in tests/fixtures/ppxr-rootcause.md), so a deterministic
 * non-zero exit code is the only fatal exit-code shape, and an empty log is the spawn-failure tell that
 * keeps a missing-binary ENOENT terminal rather than relaunch-looping on the same failure.
 */
export function isGenuineCrashOrSpawnFailure(
  decision: ManagerRelaunchDecision,
  outcome: IterationOutcome | undefined,
  iterLogFile?: string,
): boolean {
  if (decision.exitKind !== 'other_error' || outcome === undefined || outcome.timedOut === true) {
    return false;
  }
  // Deterministic non-zero exit code: explicit crash — always fatal.
  if (typeof outcome.exitCode === 'number' && outcome.exitCode !== 0) {
    return true;
  }
  // Null exit code: either a manager turn cut off mid-tool-result (the turn started — relaunchable) or a
  // spawn failure (the manager never started — fatal). Only relax when the iteration log proves the turn
  // started but produced no terminal `result`, AND there is pending work below the relaunch cap.
  if (outcome.exitCode === null) {
    const cutOffMidTurn = iterLogFile !== undefined && managerTurnStartedWithoutResult(iterLogFile);
    const retryable = cutOffMidTurn && decision.pendingCount > 0 && decision.nextRelaunchCount <= decision.cap;
    return !retryable;
  }
  return false;
}

function breakForLimit(ctx: LoopContext): LoopAction {
  ctx.log('Time limit reached. Exiting.');
  finalizeTerminalState(ctx.statePath, { step: 'completed', runnerIteration: ctx.iteration, exitReason: 'limit' });
  return { kind: 'break', reason: 'limit' };
}

function breakWithExitReason(ctx: LoopContext, reason: ExitReason): LoopAction {
  recordExitReason(ctx.statePath, reason);
  ctxDeactivate(ctx);
  return { kind: 'break', reason };
}

function recordAndReturnRelaunch(
  ctx: LoopContext,
  decision: ManagerRelaunchDecision,
  pendingTickets: number,
  message: string,
): LoopAction {
  ctx.log(message);
  recordManagerRelaunch(ctx.statePath, ctx.sessionDir, decision, ctx.iteration, ctx.log);
  return { kind: 'relaunch', relaunchCount: decision.nextRelaunchCount, pendingTickets, resetStall: true };
}

function handleCodexNoProgressRecovery(
  state: State,
  postState: State,
  ctx: LoopContext,
  decision: ManagerRelaunchDecision,
): LoopAction | null {
  const noProgress = checkAndUpdateCodexManagerNoProgress(ctx.statePath, decision.pendingCount, ctx.log);
  if (!noProgress.halt) return null;
  const workingDir = postState.working_dir || state.working_dir;
  if (!workingDir) return breakWithExitReason(ctx, 'state_working_dir_missing');
  const codexRecovery = haltOrRecoverCodexNoProgress({
    statePath: ctx.statePath,
    sessionDir: ctx.sessionDir,
    extensionRoot: ctx.extensionRoot,
    workingDir,
    iteration: ctx.iteration,
    log: ctx.log,
  });
  if (codexRecovery.kind === 'advanced') {
    return { kind: 'relaunch', relaunchCount: decision.nextRelaunchCount, pendingTickets: decision.pendingCount, resetStall: true };
  }
  if (codexRecovery.kind === 'recovery_exhausted') {
    writeRecoveryHandoffArtifact(ctx.sessionDir, ctxCurrentTicket(ctx), 'codex_manager_no_progress: ladder_exhausted', ctx.log);
    return breakWithExitReason(ctx, 'recovery_exhausted');
  }
  ctx.log(`Codex manager made no progress for ${noProgress.consecutiveCount} consecutive relaunch passes — halting with codex_manager_no_progress.`);
  logActivity({ event: 'codex_manager_no_progress', source: 'pickle', session: path.basename(ctx.sessionDir), iteration: ctx.iteration, backend: resolveBackendFromStateFileWithSource(ctx.statePath).backend, consecutive_count: noProgress.consecutiveCount, pending_count: decision.pendingCount });
  return breakWithExitReason(ctx, 'codex_manager_no_progress');
}

function handleCodexInactiveCompletion(
  state: State,
  postState: State,
  ctx: LoopContext,
  decision: ManagerRelaunchDecision,
  exitKind: ManagerRelaunchExitKind,
): LoopAction | null {
  if (decision.reason === 'time_limit') return breakForLimit(ctx);
  if (!decision.shouldRelaunch) return null;
  const noProgressAction = handleCodexNoProgressRecovery(state, postState, ctx, decision);
  if (noProgressAction) return noProgressAction;
  const backend = resolveBackendFromStateFileWithSource(ctx.statePath).backend;
  return recordAndReturnRelaunch(
    ctx,
    decision,
    decision.pendingCount,
    `${backend} manager subprocess exited via ${exitKind} with ${decision.pendingCount} ticket(s) still pending — relaunching (count ${decision.nextRelaunchCount}/${decision.cap}).`,
  );
}

function handlePendingInactiveCompletion(
  state: State,
  postState: State,
  ctx: LoopContext,
  exitKind: ManagerRelaunchExitKind,
): LoopAction | null {
  const decision = evaluateManagerRelaunch(
    postState,
    withFreshTicketStatuses(ctx.sessionDir, collectTickets(ctx.sessionDir)),
    ctx.cbState ?? null,
    exitKind,
  );
  if (decision.reason === 'time_limit') return breakForLimit(ctx);
  if (!decision.shouldRelaunch) {
    return decision.pendingCount > 0 ? breakWithExitReason(ctx, 'idle_stall_unrecoverable') : null;
  }
  const boundedEscapeCap = resolveHardeningSettings(loadPickleSettingsBag(ctx.extensionRoot)).bounded_terminal_escape_cap;
  const esc = evaluateBoundedEscape(postState, ctx.sessionDir, boundedEscapeCap);
  if (esc.escape && esc.ticketId) {
    executeBoundedEscape(ctx.statePath, ctx.sessionDir, postState.working_dir || state.working_dir || '', esc.ticketId, ctx.iteration, boundedEscapeCap, ctx.log);
    return { kind: 'relaunch', relaunchCount: decision.nextRelaunchCount, pendingTickets: Math.max(0, decision.pendingCount - 1), resetStall: true };
  }
  if (esc.ticketId) recordBoundedEscapeAttempt(ctx.statePath, esc.ticketId, ctx.iteration, ctx.log);
  const backend = resolveBackendFromStateFileWithSource(ctx.statePath).backend;
  return recordAndReturnRelaunch(
    ctx,
    decision,
    decision.pendingCount,
    `${backend} manager exited via ${exitKind} with ${decision.pendingCount} pending — relaunching (count ${decision.nextRelaunchCount}/${decision.cap}).`,
  );
}

function handleInactiveCompletion(state: State, ctx: LoopContext): LoopAction {
  if (!detectManagerInactiveExit(ctx.outcome)) {
    ctx.log('Session deactivated. Exiting loop.');
    return { kind: 'break', reason: 'cancelled' };
  }
  const postState = readPostIterationState(state, ctx);
  const exitKind = classifyManagerRelaunchExit(
    postState,
    ctx.outcome,
    ctx.iterLogFile || path.join(ctx.sessionDir, `tmux_iteration_${ctx.iteration}.log`),
    ctx.maxTurns ?? null,
  );
  const action = exitKind === 'codex_session_inactive'
    ? handleCodexInactiveCompletion(state, postState, ctx, evaluateManagerRelaunch(postState, collectTickets(ctx.sessionDir), ctx.cbState ?? null, exitKind), exitKind)
    : handlePendingInactiveCompletion(state, postState, ctx, exitKind);
  if (action) return action;
  ctx.log('Session deactivated. Exiting loop.');
  return { kind: 'break', reason: 'cancelled' };
}

function handleErrorCompletion(state: State, ctx: LoopContext): LoopAction {
  const postState = readPostIterationState(state, ctx);
  const exitKind = classifyManagerRelaunchExit(
    postState,
    ctx.outcome,
    ctx.iterLogFile || path.join(ctx.sessionDir, `tmux_iteration_${ctx.iteration}.log`),
    ctx.maxTurns ?? null,
  );
  const decision = evaluateManagerRelaunch(postState, collectTickets(ctx.sessionDir), ctx.cbState ?? null, exitKind);
  if (decision.reason === 'time_limit') return breakForLimit(ctx);
  if (decision.shouldRelaunch && !isGenuineCrashOrSpawnFailure(decision, ctx.outcome, ctx.iterLogFile || path.join(ctx.sessionDir, `tmux_iteration_${ctx.iteration}.log`))) {
    const noProgressAction = handleCodexNoProgressRecovery(state, postState, ctx, decision);
    if (noProgressAction) return noProgressAction;
    const backend = resolveBackendFromStateFileWithSource(ctx.statePath).backend;
    const detail = decision.exitKind === 'other_error' ? 'errored' : `exited via ${decision.exitKind}`;
    return recordAndReturnRelaunch(
      ctx,
      decision,
      decision.pendingCount,
      `${backend} manager subprocess ${detail} with ${decision.pendingCount} ticket(s) still pending — relaunching (count ${decision.nextRelaunchCount}/${decision.cap}).`,
    );
  }
  ctx.log('Subprocess error. Exiting loop.');
  ctxDeactivate(ctx);
  return { kind: 'break', reason: 'error' };
}

export async function processCompletionBranch(state: State, result: IterationOutcome['completion'], ctx: LoopContext): Promise<LoopAction> {
  if (result === 'task_completed') return processTaskCompleted(state, ctx);
  if (result === 'review_clean') return processReviewClean(ctx);
  if (result === 'inactive') return handleInactiveCompletion(state, ctx);
  if (result === 'error') return handleErrorCompletion(state, ctx);
  await (ctx.sleep || sleep)(1000);
  return { kind: 'noop' };
}

// eslint-disable-next-line complexity -- HT-1 reviewed: F3 R-DWC completion_commit guard adds branches to an already-large completion handler; surrounding-flow refactor out of scope for the surgical sweep.
function processTaskCompleted(state: State, ctx: LoopContext): LoopAction {
  let curState: State;
  try { curState = ctxReadState(ctx); } catch (err) {
    ctx.log(`ERROR: Cannot read state.json after task_completed: ${safeErrorMessage(err)}. Exiting.`);
    return { kind: 'break', reason: 'success' };
  }
  const decision = evaluateEpicCompletion({
    tickets: withFreshTicketStatuses(ctx.sessionDir, collectTickets(ctx.sessionDir)), currentTicket: curState.current_ticket || null,
    priorFalseCount: Number(curState.false_epic_completed_count) || 0,
    priorFalseTicket: curState.false_epic_completed_ticket ?? null,
    // B-DURA T40: supply git context so a genuinely-Failed ticket is excluded from
    // the pending set only under the conjunctive false-green guard.
    failedTerminalGitContext: {
      sessionDir: ctx.sessionDir,
      workingDir: curState.working_dir || process.cwd(),
      startCommit: typeof curState.start_commit === 'string' ? curState.start_commit : null,
    },
  });
  if (decision.kind === 'persistent_hallucination') {
    ctxDeactivate(ctx);
    return { kind: 'break', reason: 'manager_persistent_hallucination' };
  }
  if (decision.kind === 'recover_advance' || decision.kind === 'recover_retry') {
    const handoffSummary = buildIterationHandoffSummary(state, ctx.sessionDir, ctx.iteration + 1);
    (ctx.writeHandoff || writeHandoffAtomic)(ctx.sessionDir, handoffSummary, process.pid, ctx.log);
    return { kind: 'continue', resetStall: true };
  }
  const closerDecision = evaluateCloserTerminalState({
    state: curState,
    sessionDir: ctx.sessionDir,
    workingDir: curState.working_dir || state.working_dir || process.cwd(),
    headSha: observeCurrentHead(curState.working_dir || state.working_dir || process.cwd())?.sha ?? null,
    failedBudget: readCloserHandoffBudget(ctx.extensionRoot),
  });
  if (closerDecision.action === 'exit' && closerDecision.reason === 'manager_handoff_pending') {
    exitForCloserTerminalState(ctx.statePath, ctx.sessionDir, ctx.iteration, closerDecision, ctx.log);
    return { kind: 'break', reason: closerDecision.reason };
  }
  if (curState.current_ticket) {
    const guard = guardCompletionCommitBeforeDone({
      sessionDir: ctx.sessionDir,
      ticketId: curState.current_ticket,
      workingDir: curState.working_dir || state.working_dir || process.cwd(),
      flags: (curState.flags as Record<string, unknown> | undefined) ?? null,
    });
    if (!guard.ok) {
      const msg = `[fatal] ${new Date().toISOString()} ${guard.reason}`;
      ctx.log(msg);
      process.stderr.write(`${msg}\n`);
      // B-GTRUTH WS-A2 / ticket 96444430: per-ticket verdict, not a
      // cannot-continue halt — record the residual, park this ticket
      // (leave it un-Done), and let the phase loop continue.
      recordExitReason(ctx.statePath, 'done_without_commit_evidence');
      return { kind: 'continue', resetStall: true };
    }
    // R-PEDC: guard recovered — clear any stale `done_without_commit_evidence`
    // exit_reason stamped by a prior iteration so finalize doesn't mislabel a
    // fully-shipped bundle as failed.
    clearStaleDoneWithoutCommitEvidence(ctx.statePath);
    markTicketDone(ctx.sessionDir, curState.current_ticket);
    try {
      runBetweenTicketFastGate({
        statePath: ctx.statePath,
        workingDir: curState.working_dir || state.working_dir || process.cwd(),
        completedTicketId: curState.current_ticket,
        nextTicketId: null,
        landedStatus: 'done',
        log: ctx.log,
        now: ctx.now,
      });
    } catch (err) {
      ctx.log(`between-ticket fast gate failed after final completion (ignored): ${safeErrorMessage(err)}`);
    }
  }
  // False-completion guard + B-DURA T50 no-premature-drain: re-scan ticket
  // frontmatter via reconcileTicketTruth before finalizing EPIC as completed.
  // The pickle phase MUST NOT exit while any non-`Failed` ticket is Todo / In
  // Progress (real unattempted work). Advance only when every ticket is TERMINAL
  // (Done | Skipped | Failed). A `Failed` ticket is terminal-for-advance (it does
  // NOT force a re-drain — that is T40's domain); an UNATTEMPTED Todo / In Progress
  // ticket keeps the phase draining rather than reporting a premature completion
  // (R-CECX run-3 / LOA-1488: codex drained at iter 49/500 with 4 Todo tickets).
  {
    const workingDir4Guard = curState.working_dir || state.working_dir || '';
    const guardTruth = reconcileTicketTruth({ sessionDir: ctx.sessionDir, workingDir: workingDir4Guard });
    const nonFailedPending = Object.entries(guardTruth.ticketStatuses)
      .filter(([, st]) => {
        const n = normalizeTicketStatus(st);
        // Terminal-for-advance: Done, Skipped, AND Failed. Only Todo / In Progress
        // (genuine non-terminal, unattempted-or-in-flight) keeps the phase draining.
        return n !== 'done' && n !== 'skipped' && n !== 'failed';
      });
    if (nonFailedPending.length > 0) {
      ctx.log(`no-premature-drain: ${nonFailedPending.length} non-Failed Todo/In-Progress ticket(s) remain — refusing EPIC finalize, keep draining`);
      const handoffSummary = buildIterationHandoffSummary(state, ctx.sessionDir, ctx.iteration + 1);
      (ctx.writeHandoff || writeHandoffAtomic)(ctx.sessionDir, handoffSummary, process.pid, ctx.log);
      return { kind: 'continue', resetStall: true };
    }
  }
  ctx.log('Task completed. Exiting loop.');
  ctxFinalize(ctx, 'success');
  return { kind: 'break', reason: 'success' };
}

function processReviewClean(ctx: LoopContext): LoopAction {
  let curState: State;
  try { curState = ctxReadState(ctx); } catch (err) {
    ctx.log(`ERROR: Cannot read state.json after review_clean: ${safeErrorMessage(err)}. Treating as completed.`);
    ctxFinalize(ctx, 'success');
    return { kind: 'break', reason: 'success' };
  }
  const minIter = Number.isFinite(Number(curState.min_iterations)) ? Number(curState.min_iterations) : 0;
  const curIterNow = Number.isFinite(Number(curState.iteration)) ? Number(curState.iteration) : 0;
  if (minIter > 0 && curIterNow < minIter) {
    ctx.log(`Clean pass at iteration ${curIterNow}, but min_iterations=${minIter}. Continuing.`);
    return { kind: 'noop' };
  }
  ctx.log('Review clean. Exiting loop.');
  ctxFinalize(ctx, 'success');
  return { kind: 'break', reason: 'success' };
}

/** Observe current HEAD: returns { branch, sha } or null on git failure. */
function observeCurrentHead(workingDir: string): { branch: string | null; sha: string } | null {
  const r = spawnSync('git', ['-C', workingDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8', timeout: 5000 });
  if (r.status !== 0) return null;
  const sha = ((r.stdout as string) || '').trim();
  return sha ? { branch: getHeadBranch(workingDir), sha } : null;
}

/** Returns true if the HEAD has drifted externally relative to the pinned state. */
function hasHeadDrifted(
  pinnedBranch: string | null,
  pinnedSha: string,
  observed: { branch: string | null; sha: string },
  workingDir: string,
): boolean {
  if (pinnedBranch !== null) return observed.branch !== pinnedBranch;
  if (observed.sha === pinnedSha) return false;
  const r = spawnSync('git', ['-C', workingDir, 'merge-base', '--is-ancestor', pinnedSha, observed.sha], { encoding: 'utf-8', timeout: 5000 });
  return r.status !== 0;
}

/**
 * R-PIWG-1: Before each ticket selection, verify HEAD hasn't been switched externally.
 * Returns true if a mismatch was detected (caller should break the loop).
 */
export function checkHeadPinMismatch(
  state: State,
  workingDir: string,
  sessionDir: string,
  statePath: string,
  log: (msg: string) => void,
): boolean {
  if (state.pinned_sha === undefined) return false;
  const pinnedBranch = state.pinned_branch ?? null;
  const pinnedSha = state.pinned_sha;
  try {
    const observed = observeCurrentHead(workingDir);
    if (!observed) return false;
    if (!hasHeadDrifted(pinnedBranch, pinnedSha, observed, workingDir)) return false;

    const detectedAtPhase = state.step || 'unknown';
    log(`HEAD mismatch detected: pinned_branch=${pinnedBranch ?? 'null'} observed_branch=${observed.branch ?? 'null'} pinned_sha=${pinnedSha} observed_sha=${observed.sha}`);

    try {
      writeActivityEntry(statePath, {
        event: 'head_mismatch_detected',
        source: 'pickle',
        ts: new Date().toISOString(),
        session: path.basename(sessionDir),
        gate_payload: {
          pinned_branch: pinnedBranch,
          observed_branch: observed.branch,
          pinned_sha: pinnedSha,
          observed_sha: observed.sha,
          detected_at_phase: detectedAtPhase,
        },
      });
    } catch (err) {
      log(`head_mismatch_detected activity write failed: ${safeErrorMessage(err)}`);
    }

    try {
      sm.update(statePath, s => {
        s.head_pin_mismatch_detail = {
          pinned_branch: pinnedBranch,
          observed_branch: observed.branch,
          pinned_sha: pinnedSha,
          observed_sha: observed.sha,
        };
      });
    } catch (err) {
      log(`head_pin_mismatch_detail write failed: ${safeErrorMessage(err)}`);
    }

    recordExitReason(statePath, 'working_tree_modified_externally');
    safeDeactivate(statePath);
    return true;
  } catch (err) {
    log(`checkHeadPinMismatch: threw (ignored): ${safeErrorMessage(err)}`);
    return false;
  }
}

/**
 * R-WSWA-2 (R-WMW-2): per-ticket artifact-progress tracking + K=3 observability.
 *
 * The manager-turn-budget wedge (research→plan loop that never delegates
 * completion) is silent for ~60+ min because no signal counts how many spawns
 * produced no new review/conformance artifacts. These helpers snapshot the count
 * of `code_review_*.md` + `conformance_*.md` around each worker spawn, persist the
 * delta into `state.worker_artifact_progress[ticketId]` (schema v5, landed in
 * R-WSWA-1) so it survives a manager relaunch (R-MMTR boundary), and emit
 * `worker_artifact_progress_zero` once after K consecutive zero-delta spawns.
 * Observability ONLY — no halt, no action.
 */
export const WMW_OBSERVE_K_ENV = 'PICKLE_WMW_OBSERVE_K';
export const WMW_OBSERVE_K_DEFAULT = 3;

export function resolveWmwObserveK(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[WMW_OBSERVE_K_ENV];
  if (!raw) return WMW_OBSERVE_K_DEFAULT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : WMW_OBSERVE_K_DEFAULT;
}

export const WMW_SKIP_K_ENV = 'PICKLE_WMW_SKIP_K';
export const WMW_SKIP_K_DEFAULT = 5;

export function resolveWmwSkipK(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[WMW_SKIP_K_ENV];
  if (!raw) return WMW_SKIP_K_DEFAULT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : WMW_SKIP_K_DEFAULT;
}

// AC-A4 (B-RRH): the early-phase credit window — for a `large`-tier ticket's
// first N spawns, research/plan artifacts credit progress. N defaults to 4, kept
// strictly below the default skip threshold (WMW_SKIP_K_DEFAULT = 5) so phase
// churn PAST the window still reaches worker_auto_skip_oversized.
export const WMW_EARLY_PHASE_K_ENV = 'PICKLE_WMW_EARLY_PHASE_K';
export const WMW_EARLY_PHASE_K_DEFAULT = 4;

export function resolveWmwEarlyPhaseK(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[WMW_EARLY_PHASE_K_ENV];
  if (!raw) return WMW_EARLY_PHASE_K_DEFAULT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : WMW_EARLY_PHASE_K_DEFAULT;
}

/**
 * Count the artifact files whose progress R-WMW tracks: code_review_* +
 * conformance_* markdown. AC-A4 (B-RRH): when `opts.creditEarlyPhases` is set,
 * ALSO count the graded early-phase artifacts `research*` + `plan*` so a large-tier
 * worker grinding through the early lifecycle (research → plan) during its first
 * N spawns credits forward progress instead of charging zero-progress. The default
 * (no opts) stays code_review_* + conformance_* only — existing callers and the
 * past-N phase-churn path are unchanged, so an oversized ticket still auto-skips.
 */
export function countWorkerArtifacts(
  ticketDir: string,
  opts: { creditEarlyPhases?: boolean } = {},
): number {
  let n = 0;
  try {
    for (const e of fs.readdirSync(ticketDir)) {
      if (!e.endsWith('.md')) continue;
      if (e.startsWith('code_review') || e.startsWith('conformance')) n++;
      else if (opts.creditEarlyPhases && (e.startsWith('research') || e.startsWith('plan'))) n++;
    }
  } catch { /* dir missing/unreadable → 0 */ }
  return n;
}

/**
 * AC-R-WMNP-1: digest of the working-tree source state so a worker that lands real
 * source work (new/grown files, changed diff) but writes no new lifecycle artifact
 * file still counts as progress. Combines `git status --porcelain` (covers untracked
 * + staged + unstaged path set) with `git diff --numstat` (covers per-file line
 * churn on tracked files) into one comparable string. Returns `null` when git is
 * unavailable or EITHER probe fails (L1) -- a half-signature from one successful
 * probe would silently drop the other probe's signal and could read as a spurious
 * change/no-change against a prior COMPLETE signature. The caller's `?? prev`
 * fallback then preserves the prior complete signature instead of corrupting it.
 * `spawnSync` reports a timeout as `status === null` plus `error.code === 'ETIMEDOUT'`
 * (no thrown error), so an OR-in on the ETIMEDOUT codes catches a timed-out probe.
 */
export function computeSourceTreeSignature(workingDir: string): string | null {
  try {
    const status = spawnSync('git', ['-C', workingDir, 'status', '--porcelain'], { encoding: 'utf-8', timeout: 10_000 });
    const numstat = spawnSync('git', ['-C', workingDir, 'diff', '--numstat'], { encoding: 'utf-8', timeout: 10_000 });
    const statusErr = (status.error as NodeJS.ErrnoException | undefined)?.code;
    const numstatErr = (numstat.error as NodeJS.ErrnoException | undefined)?.code;
    if (
      status.status !== 0
      || numstat.status !== 0
      || statusErr === 'ETIMEDOUT'
      || numstatErr === 'ETIMEDOUT'
    ) {
      return null;
    }
    return `${status.stdout ?? ''} ${numstat.stdout ?? ''}`;
  } catch {
    return null;
  }
}

/**
 * AC-A3 (B-RRH): scoped working-tree signature. Identical contract to
 * `computeSourceTreeSignature` (null on git-unavailable / non-zero / ETIMEDOUT
 * EITHER probe, so the caller's `?? prev` preserves a prior COMPLETE signature)
 * but bounded to `scope.json:allowed_paths` (reusing the `getLatestCommitInScope`
 * convention from `services/artifact-progress-detector.ts`). A peer session's
 * dirty `prds/` file is OUTSIDE allowed_paths and so is absent from the signature
 * — closing the B-HRPW cross-session signature pollution. When scope.json is
 * absent / malformed / has no `allowed_paths`, it delegates to the whole-tree
 * `computeSourceTreeSignature` (unscoped fallback, never crashes the runner).
 */
/** Read `allowed_paths` git-pathspecs from a scope.json FILE path; absent/malformed → []. Fail-open. */
function readScopeAllowedPathSpecsFromFile(scopeJsonPath?: string): string[] {
  const pathSpecs: string[] = [];
  if (!scopeJsonPath) return pathSpecs;
  try {
    const raw = JSON.parse(fs.readFileSync(scopeJsonPath, 'utf-8'));
    if (Array.isArray(raw?.allowed_paths)) {
      for (const p of raw.allowed_paths) {
        if (typeof p === 'string') pathSpecs.push(p);
      }
    }
  } catch { /* scope.json absent or malformed — fall through to unscoped */ }
  return pathSpecs;
}

/** Combine a status+numstat probe pair into a signature; null on non-zero/ETIMEDOUT either probe. */
function gitProbesToSignature(
  status: ReturnType<typeof spawnSync>,
  numstat: ReturnType<typeof spawnSync>,
): string | null {
  const statusErr = (status.error as NodeJS.ErrnoException | undefined)?.code;
  const numstatErr = (numstat.error as NodeJS.ErrnoException | undefined)?.code;
  if (status.status !== 0 || numstat.status !== 0 || statusErr === 'ETIMEDOUT' || numstatErr === 'ETIMEDOUT') {
    return null;
  }
  return `${String(status.stdout ?? '')} ${String(numstat.stdout ?? '')}`;
}

export function computeScopedSourceTreeSignature(
  workingDir: string,
  scopeJsonPath?: string,
): string | null {
  const pathSpecs = readScopeAllowedPathSpecsFromFile(scopeJsonPath);
  if (pathSpecs.length === 0) return computeSourceTreeSignature(workingDir);
  try {
    const status = spawnSync('git', ['-C', workingDir, 'status', '--porcelain', '--', ...pathSpecs], { encoding: 'utf-8', timeout: 10_000 });
    const numstat = spawnSync('git', ['-C', workingDir, 'diff', '--numstat', '--', ...pathSpecs], { encoding: 'utf-8', timeout: 10_000 });
    return gitProbesToSignature(status, numstat);
  } catch {
    return null;
  }
}

/**
 * AC-A5 (B-RRH): true when the circuit breaker recently recovered (transitioned
 * out of OPEN) and `nowMs` is within `graceSeconds` of that recovery. A still-OPEN
 * breaker is NOT a recovery (the loop exits on OPEN elsewhere); HALF_OPEN is
 * actively probing recovery; a CLOSED breaker that has tripped at least once
 * (`total_opens > 0`) is within grace while its last transition is recent.
 * Fail-open: an unparseable `last_change` yields false.
 */
export function isWithinBreakerRecoveryGrace(
  cbState: CircuitBreakerState | null | undefined,
  graceSeconds: number,
  nowMs: number,
): boolean {
  if (!cbState) return false;
  if (cbState.state === 'OPEN') return false;
  if (cbState.state === 'HALF_OPEN') return true;
  if (cbState.total_opens > 0 && typeof cbState.last_change === 'string') {
    const changedMs = Date.parse(cbState.last_change);
    if (!Number.isFinite(changedMs)) return false;
    const elapsed = nowMs - changedMs;
    return elapsed >= 0 && elapsed <= graceSeconds * 1000;
  }
  return false;
}

/**
 * AC-A1 (B-RRH) default done-guard: a ticket is "fine" (never charged) when its
 * frontmatter status is Done AND its completion evidence is accepted by the ONE
 * completion predicate (B-1SEAM WS-1 — the prior bare non-empty-field read
 * accepted a hallucinated/unreachable stamp here that the batch watcher then
 * reverted seconds later: the live accept-here-revert-there split). Evaluated
 * as a keep-decision ({ decision: 'phantom-watch' }) so its verdict matches the
 * watcher's. Fail-open — a missing/unreadable ticket file or an absent
 * workingDir yields false so the normal charge path runs.
 */
function defaultDoneGuard(sessionDir: string, ticketId: string, workingDir?: string): boolean {
  try {
    if (normalizeTicketStatus(getTicketStatus(sessionDir, ticketId)) !== 'done') return false;
    if (!workingDir) return false;
    const decision = evaluateCompletionEvidence(
      buildCompletionCtx({ sessionDir, ticketId, workingDir, rereadBackoffMs: 0 }, 'phantom-watch'),
    );
    return decision.ok;
  } catch {
    return false;
  }
}

/**
 * AC-A4 (B-RRH): true when the ticket is `large`-tier AND still inside its early
 * phase-credit window (`priorSpawnCount < n`). Outside the window — or for any
 * non-large tier — research/plan artifacts no longer credit progress, so a ticket
 * that only churns phases past the window still reaches worker_auto_skip_oversized.
 * Fail-open: a missing/unreadable ticket file yields false.
 */
export function resolveCreditEarlyPhases(
  sessionDir: string,
  ticketId: string,
  priorSpawnCount: number,
  n: number,
): boolean {
  if (priorSpawnCount >= n) return false;
  try {
    const raw = fs.readFileSync(ticketFilePath(sessionDir, ticketId), 'utf-8');
    const tier = (readFrontmatterField(raw, 'complexity_tier') ?? '').trim().toLowerCase();
    return tier === 'large';
  } catch {
    return false;
  }
}

/**
 * AC-A2 (B-RRH): per-ticket ladder exhaustion is an ADVANCE while ≥1 runnable Todo
 * remains; only when none remains does the run EXIT (B-LERD: run-exit on a still-
 * progressable bundle). Flips the exhausted ticket Failed/oversized so it leaves
 * the runnable set, emits the (A0-frozen) `ticket_ladder_exhausted` literal, clears
 * current_ticket, then returns `'advance'` (a runnable ticket remains) or `'exit'`
 * (none remains — the caller performs the recovery_exhausted run-exit). The global
 * iteration cap is enforced separately at the loop top.
 *
 * AC-WMFF-2A: this was the ONE Failed-flip site that never archived. The two siblings
 * (head-regression, wmw-auto-skip) both call `archiveDirtyTreeBeforeFlip` before their
 * frontmatter write; the B-DURA T10 boundary committer is `!isTerminalTicketStatus`-guarded
 * and skips an already-Failed ticket, so a verified dirty diff on this path had NO commit
 * AND no archive. `workingDir` is threaded in for exactly that call.
 */
export function advanceOrExitOnLadderExhaustion(input: {
  sessionDir: string;
  statePath: string;
  workingDir: string;
  ticketId: string;
  reason: string;
  log: (m: string) => void;
}): 'advance' | 'exit' {
  const { sessionDir, statePath, workingDir, ticketId, reason, log } = input;
  archiveDirtyTreeBeforeFlip({ workingDir, sessionDir, ticketId, log });
  try {
    updateTicketFrontmatter(ticketId, sessionDir, { status: 'Failed', completion_commit: null });
    const tfPath = ticketFilePath(sessionDir, ticketId);
    const tfRaw = fs.readFileSync(tfPath, 'utf-8');
    // WS-2d (R-PFNT): finer no-progress reason in place of the misleading single literal.
    const tfUpdated = upsertFrontmatterField(tfRaw, 'failed_reason', classifyNoProgressFailureReason(sessionDir));
    if (tfUpdated) fs.writeFileSync(tfPath, tfUpdated);
  } catch (err) { log(`[ticket-ladder] frontmatter flip failed (ignored): ${safeErrorMessage(err)}`); }
  try {
    writeActivityEntry(statePath, {
      event: 'ticket_ladder_exhausted',
      ts: new Date().toISOString(),
      ticket: ticketId,
      gate_payload: { reason },
    });
  } catch { /* best-effort */ }
  updateMuxLifecycleState(statePath, { currentTicket: null });
  return noRunnableTicketsRemain(sessionDir) ? 'exit' : 'advance';
}

/**
 * Persist the post-spawn progress delta for one ticket and, on exactly the
 * K-th consecutive zero-PROGRESS spawn, emit `worker_artifact_progress_zero`.
 * `beforeCount` is the snapshot taken BEFORE the spawn; the AFTER snapshot is read
 * here. Progress = artifact-count grew (`delta > 0`) OR the working-tree source
 * signature changed since the prior spawn (AC-R-WMNP-1). Only a spawn that produced
 * NEITHER a new artifact NOR a source-tree change increments `zero_progress_count`;
 * any forward progress resets it to 0. Firing uses `=== k` so it emits once at the
 * threshold (not re-spamming at k+1) and re-arms after a reset.
 */
export function recordWorkerArtifactProgress(
  statePath: string,
  sessionDir: string,
  ticketId: string,
  beforeCount: number,
  opts: {
    k?: number;
    iteration?: number;
    log?: (m: string) => void;
    workingDir?: string;
    sourceSignatureFn?: (workingDir: string) => string | null;
    // AC-A4 (B-RRH): credit research/plan artifacts as progress (early iters of a
    // large-tier ticket). Threaded into countWorkerArtifacts for the AFTER snapshot;
    // the charge site MUST pass the SAME flag into the BEFORE snapshot so the delta
    // is consistent.
    creditEarlyPhases?: boolean;
    // AC-A5 (B-RRH): rate-limited / within-breaker-recovery-grace spawn — the
    // zero-progress counter is HELD (never incremented) so a 429 or breaker-recovery
    // race does not poison the no-progress ladder.
    suppressIncrement?: boolean;
    // AC-A1 (B-RRH): done-guard predicate — a Done ticket with predicate-accepted
    // completion evidence is never charged. Defaults to the fail-open
    // evaluateCompletionEvidence-backed read (B-1SEAM WS-1).
    doneGuardFn?: (sessionDir: string, ticketId: string, workingDir?: string) => boolean;
  } = {},
): { spawnCount: number; lastArtifactCount: number; zeroProgressCount: number; fired: boolean; doneGuard: boolean; incrementSuppressed: boolean } {
  const k = opts.k ?? resolveWmwObserveK();
  const afterCount = countWorkerArtifacts(path.join(sessionDir, ticketId), { creditEarlyPhases: opts.creditEarlyPhases });
  const delta = afterCount - beforeCount;

  // AC-A1 (B-RRH): a Done ticket with completion evidence is fine — never charge it
  // (B-LERD: run-exit on a Done ticket). Fail-open: any read error → not guarded.
  const doneGuardFn = opts.doneGuardFn ?? defaultDoneGuard;
  let doneGuard = false;
  try { doneGuard = doneGuardFn(sessionDir, ticketId, opts.workingDir); } catch { doneGuard = false; }

  // AC-R-WMNP-1: capture the current source-tree signature. A non-null signature
  // that differs from the prior spawn's stored signature counts as progress even
  // when no new artifact file appeared.
  const sigFn = opts.sourceSignatureFn ?? computeSourceTreeSignature;
  const sourceSignature = opts.workingDir ? sigFn(opts.workingDir) : null;

  let incremented = false;
  const updated = sm.update(statePath, s => {
    const map = (s.worker_artifact_progress && typeof s.worker_artifact_progress === 'object')
      ? s.worker_artifact_progress
      : (s.worker_artifact_progress = {});
    const prev = map[ticketId] ?? { spawn_count: 0, last_artifact_count: 0, zero_progress_count: 0 };
    const artifactProgressed = delta > 0;
    // AC-R-WMNP-1 (M2/M3): a non-null signature counts as forward progress when
    // (a) no prior signature was ever captured (FIRST capture — spawn 1 that lands
    // only source work must seed the baseline, not be scored zero-progress), or
    // (b) a prior null sentinel recorded a git-unavailable spawn and this probe
    // finally succeeded (gap recovery — the prior `undefined` guard hid this until
    // spawn 3), or (c) the signature actually changed since the prior spawn.
    const sourceProgressed = sourceSignature !== null
      && (prev.last_source_signature === undefined
        || prev.last_source_signature === null
        || sourceSignature !== prev.last_source_signature);
    const progressed = artifactProgressed || sourceProgressed;
    // Charge precedence: A1 done-guard resets (ticket is fine) → A any forward
    // progress resets → A5 suppression HOLDS (no increment) → otherwise increment.
    let nextZero: number;
    if (doneGuard || progressed) {
      nextZero = 0;
    } else if (opts.suppressIncrement) {
      nextZero = prev.zero_progress_count;
    } else {
      nextZero = prev.zero_progress_count + 1;
      incremented = true;
    }
    map[ticketId] = {
      spawn_count: prev.spawn_count + 1,
      last_artifact_count: afterCount,
      zero_progress_count: nextZero,
      // Carry the freshest signature forward. On a probe failure persist an
      // explicit `null` sentinel (M3) — not the prior value, and not `undefined` —
      // so a later successful probe is detected as gap-recovery progress rather
      // than staying invisible behind a missing-baseline guard. Only preserve a
      // prior COMPLETE (non-null) signature when there was no prior at all.
      last_source_signature: sourceSignature !== null
        ? sourceSignature
        : (prev.last_source_signature ?? null),
    };
  });

  const entry = updated.worker_artifact_progress?.[ticketId]
    ?? { spawn_count: 1, last_artifact_count: afterCount, zero_progress_count: 0 };
  // Fire only when THIS spawn incremented to the threshold — a held (suppressed)
  // or done-guarded spawn that merely sits at k must not re-fire.
  const fired = incremented && entry.zero_progress_count === k;
  if (fired) {
    writeActivityEntry(statePath, {
      event: 'worker_artifact_progress_zero',
      ts: new Date().toISOString(),
      ticket: ticketId,
      gate_payload: {
        spawn_count: entry.spawn_count,
        last_artifact_count: entry.last_artifact_count,
        zero_progress_count: entry.zero_progress_count,
        observe_k: k,
      },
    });
    opts.log?.(`[observe] worker_artifact_progress_zero: ticket ${ticketId} produced no new review/conformance artifacts for ${k} consecutive spawns`);
  }
  return {
    spawnCount: entry.spawn_count,
    lastArtifactCount: entry.last_artifact_count,
    zeroProgressCount: entry.zero_progress_count,
    fired,
    doneGuard,
    incrementSuppressed: !!opts.suppressIncrement && !incremented && !doneGuard,
  };
}

// ─── Ticket 90574654: silent-death sub-classification + salvage-first recovery ───

/** Silent-death sub-classes (90574654). `log_empty` → `worker_silent_death`; `log_truncated` → existing `worker_partial_lifecycle_exit`. */
export type SilentDeathSubClass = 'log_empty' | 'log_truncated';

export interface PartialLifecycleExitClassification {
  /** `null` → graceful exit (terminal promise token present); not a silent-death shape, no recovery policy. */
  subClass: SilentDeathSubClass | null;
  artifactsMissing: string[];
  sessionLogSize: number;
  logPath: string;
  pid: number | null;
}

/** Worker terminal completion signal (promise-tokens.ts WORKER_DONE). */
const WORKER_TERMINAL_PROMISE_RE = /<promise>\s*I AM DONE\s*<\/promise>/;
const SILENT_DEATH_GIT_TIMEOUT_MS = 10_000;
const LIFECYCLE_ARTIFACT_RE = /^(research|plan|conformance|code_review).*\.md$/;
const SILENT_DEATH_RESPAWN_STRATEGY = 'silent_death_respawn';

/**
 * Sub-classify the worker exit by its session log(s). The LATEST
 * `worker_session_<pid>.log` (mtime, filename tiebreak) decides the sub-class:
 * absent or 0-byte → `log_empty`; nonzero without the terminal promise token →
 * `log_truncated`; nonzero WITH the token → graceful (`null`).
 * `sessionLogSize` stays the SUM across all logs (existing payload semantics).
 */
function classifyWorkerSessionLogs(ticketDir: string, files: string[]): {
  subClass: SilentDeathSubClass | null;
  sessionLogSize: number;
  logPath: string;
  pid: number | null;
} {
  const logs: Array<{ file: string; size: number; mtimeMs: number }> = [];
  let sessionLogSize = 0;
  for (const file of files) {
    if (!/^worker_session_\d+\.log$/.test(file)) continue;
    try {
      const st = fs.statSync(path.join(ticketDir, file));
      sessionLogSize += st.size;
      logs.push({ file, size: st.size, mtimeMs: st.mtimeMs });
    } catch { /* ignore unreadable log */ }
  }
  logs.sort((a, b) => (a.mtimeMs - b.mtimeMs) || a.file.localeCompare(b.file));
  const latest = logs.length > 0 ? logs[logs.length - 1] : null;
  if (!latest) {
    return { subClass: 'log_empty', sessionLogSize, logPath: path.join(ticketDir, 'worker_session_absent.log'), pid: null };
  }
  const pidMatch = latest.file.match(/^worker_session_(\d+)\.log$/);
  const pid = pidMatch ? Number(pidMatch[1]) : null;
  const logPath = path.join(ticketDir, latest.file);
  if (latest.size === 0) return { subClass: 'log_empty', sessionLogSize, logPath, pid };
  let content = '';
  try { content = fs.readFileSync(logPath, 'utf-8'); } catch { /* unreadable nonzero log → treat as truncated */ }
  return { subClass: WORKER_TERMINAL_PROMISE_RE.test(content) ? null : 'log_truncated', sessionLogSize, logPath, pid };
}

/**
 * Count successful silent-death respawns already drawn from the shared cap for
 * THIS ticket (persisted ledger — survives relaunch and `setup.js --resume`).
 * The cap is shared across both sub-classes (log_empty + log_truncated) but
 * scoped per ticket, mirroring `worker_artifact_progress` keying: ticket B's
 * silent death must not be charged against ticket A's budget.
 */
function countSilentDeathRespawns(statePath: string, ticketId: string): number {
  return countLedgerSuccesses(statePath, ticketId, SILENT_DEATH_RESPAWN_STRATEGY);
}

/** Count `outcome: 'success'` entries in `state.recovery_attempts` for one ticket + strategy (persisted ledger — survives relaunch and `setup.js --resume`). */
function countLedgerSuccesses(statePath: string, ticketId: string, strategy: string): number {
  try {
    const s = readRecoverableJsonObject(statePath) as State | null;
    if (!s || !Array.isArray(s.recovery_attempts)) return 0;
    return s.recovery_attempts.filter(
      (a) => a && a.strategy === strategy && a.outcome === 'success' && a.ticket === ticketId,
    ).length;
  } catch { return 0; }
}

/**
 * R-WSE-2 / R-PIAP-A4: Emit worker_partial_lifecycle_exit when a worker exits
 * mid-lifecycle leaving required artifacts missing. The required set is derived
 * from TIER_LIFECYCLE[tier] (R-PIAP-A1) via requiredTierArtifactPrefixes — never
 * a hardcoded list — so a trivial ticket (implement + code_review only) is not
 * penalized for absent research_*.md / plan_*.md.
 *
 * Progress gate: tiers whose lifecycle includes research_review keep the R-WSE-2
 * "research APPROVED" precondition (don't flag a worker still iterating on
 * research). Tiers without research (trivial/small) instead require at least one
 * gated artifact to be present so a not-started worker is never flagged.
 *
 * 90574654 delta: the exit is sub-classified by worker session log. `log_empty`
 * (0-byte/absent log) emits the NEW `worker_silent_death` event instead;
 * `log_truncated` and graceful exits keep the EXISTING event. Exactly ONE event
 * fires per exit — the two events are mutually exclusive by construction. The
 * classification is returned so the caller can route silent-death shapes into
 * `applySilentDeathRecoveryPolicy`. Returns `null` when no partial-lifecycle
 * exit was detected (no event emitted).
 */
export function checkPartialLifecycleExit(sessionDir: string, statePath: string, ticketId: string): PartialLifecycleExitClassification | null {
  const ticketDir = path.join(sessionDir, ticketId);
  let files: string[];
  try { files = fs.readdirSync(ticketDir); } catch { return null; }

  let tier: TicketComplexityTier = 'medium';
  try {
    tier = parseTicketFrontmatter(ticketFilePath(sessionDir, ticketId))?.complexity_tier ?? 'medium';
  } catch { /* default medium */ }

  const requiredPrefixes = requiredTierArtifactPrefixes(tier);
  const artifactsMissing = findMissingPrefixes(files, requiredPrefixes);

  if (TIER_LIFECYCLE[tier].includes('research_review')) {
    if (!files.includes('research_review.md')) return null;
    let reviewContent: string;
    try { reviewContent = fs.readFileSync(path.join(ticketDir, 'research_review.md'), 'utf-8'); } catch { return null; }
    if (!reviewContent.trimEnd().endsWith('APPROVED')) return null;
  } else if (artifactsMissing.length === requiredPrefixes.length) {
    // No research gate (trivial/small): require ≥1 gated artifact present as
    // progress evidence so a not-started worker is never flagged.
    return null;
  }

  if (artifactsMissing.length === 0) return null;

  const { subClass, sessionLogSize, logPath, pid } = classifyWorkerSessionLogs(ticketDir, files);

  if (subClass === 'log_empty') {
    // 90574654: silent death — NEVER also the worker_partial_lifecycle_exit event.
    writeActivityEntry(statePath, {
      event: 'worker_silent_death',
      ts: new Date().toISOString(),
      ticket: ticketId,
      pid,
      log_path: logPath,
      sub_class: 'log_empty',
      respawn_attempt: countSilentDeathRespawns(statePath, ticketId),
    });
  } else {
    writeActivityEntry(statePath, {
      event: 'worker_partial_lifecycle_exit',
      ts: new Date().toISOString(),
      source: 'pickle',
      ticket: ticketId,
      gate_payload: { artifacts_missing: artifactsMissing, session_log_size: sessionLogSize },
    });
  }

  return { subClass, artifactsMissing, sessionLogSize, logPath, pid };
}

export interface SilentDeathRecoveryInput {
  sessionDir: string;
  statePath: string;
  ticketId: string;
  workingDir: string;
  iteration: number;
  classification: PartialLifecycleExitClassification | null;
  /** HEAD sha captured before the iteration — base of the iteration commit window. */
  preIterSha?: string | null;
  /** Epoch ms when the iteration began — freshness window for lifecycle artifacts. */
  iterationStartMs?: number;
  /** Injectable for tests; defaults to `resolveHardeningSettings(loadPickleSettingsBag())`. */
  settings?: HardeningSettings | null;
  /** Injectable for tests; defaults to `archiveBeforeDestructive` (0780b805). */
  archive?: (ctx: ArchiveContext) => ArchiveResult | null;
  log?: (msg: string) => void;
}

export type SilentDeathRecoveryDecision =
  | { action: 'none' }
  | { action: 'hold'; subClass: SilentDeathSubClass; evidence: 'completion_commit' | 'scoped_commit' | 'fresh_artifacts' | 'archive_failed' }
  | { action: 'respawn'; subClass: SilentDeathSubClass; attempt: number; cap: number }
  | { action: 'halt'; subClass: SilentDeathSubClass; exitReason: 'recovery_exhausted'; cap: number };

/**
 * Best-effort git probe with a finite timeout (bin/ subsystem invariant #3). Returns null on
 * any failure. `input`, when supplied, is fed on stdin (git commands that read a message);
 * absent, stdin stays closed exactly as before.
 */
function silentDeathGit(args: string[], cwd: string, input?: string): string | null {
  try {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf-8',
      input,
      timeout: SILENT_DEATH_GIT_TIMEOUT_MS,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (r.error || r.status !== 0) return null;
    return (r.stdout || '').trim();
  } catch { return null; }
}

/** Read `allowed_paths` from the session-root scope.json; null when unscoped/unreadable. */
function readScopeAllowedPaths(sessionDir: string): string[] | null {
  try {
    const scope = readRecoverableJsonObject(path.join(sessionDir, 'scope.json')) as Record<string, unknown> | null;
    if (!scope || !Array.isArray(scope.allowed_paths)) return null;
    return scope.allowed_paths.filter((p): p is string => typeof p === 'string' && p.length > 0);
  } catch { return null; }
}

function isWithinAllowedPaths(file: string, allowed: string[]): boolean {
  return allowed.some((a) => {
    const prefix = a.endsWith('/') ? a : `${a}/`;
    return file === a || file.startsWith(prefix);
  });
}

/**
 * B-RASO — the ONE frontmatter-SHA-verifying helper for BOTH recovery detectors
 * (silent-death salvage + Failed-flip suppression). Resolves a ticket's
 * frontmatter completion sha, git-VERIFIED: iterates both fields with `continue`
 * semantics (a bad `completion_commit` does NOT suppress a good
 * `completion_commit_inferred`), R-CCQF-normalizes quoted forms, shape-checks,
 * and returns the FIRST sha that `git cat-file -t` resolves to a commit object in
 * `workingDir` — else null. A regex-valid but nonexistent sha yields null, so a
 * garbage stamp can neither hold a silent-death ticket nor suppress a Failed-flip.
 * Fails toward null on unreadable file / bad shape / git error / timeout (the
 * fresh-artifacts + scoped-commit backstop arms remain the independent evidence).
 */
function resolveAttributableFrontmatterSha(sessionDir: string, ticketId: string, workingDir: string): string | null {
  let raw: string;
  try { raw = fs.readFileSync(ticketFilePath(sessionDir, ticketId), 'utf-8'); } catch { return null; }
  for (const field of ['completion_commit', 'completion_commit_inferred'] as const) {
    const value = (readFrontmatterField(raw, field) ?? '').trim().replace(/^['"]+|['"]+$/g, '');
    if (!/^[0-9a-f]{7,40}$/i.test(value)) { continue; }
    if (silentDeathGit(['cat-file', '-t', value], workingDir) === 'commit') { return value; }
  }
  return null;
}

/** Salvage probe 2: a commit landed in the iteration window touching only `allowed_paths` (unscoped session → any commit counts). */
function hasScopedIterationWindowCommit(input: SilentDeathRecoveryInput): boolean {
  if (!input.preIterSha) return false;
  const head = silentDeathGit(['rev-parse', 'HEAD'], input.workingDir);
  if (!head || head === input.preIterSha) return false;
  const diffOut = silentDeathGit(['diff', '--name-only', `${input.preIterSha}..HEAD`], input.workingDir);
  if (diffOut === null) return false;
  const touched = diffOut.split('\n').map((s) => s.trim()).filter(Boolean);
  if (touched.length === 0) return false;
  const allowed = readScopeAllowedPaths(input.sessionDir);
  if (!allowed || allowed.length === 0) return true;
  return touched.every((f) => isWithinAllowedPaths(f, allowed));
}

/** Salvage probe 3: a lifecycle artifact was written inside the iteration window. */
function hasFreshLifecycleArtifacts(input: SilentDeathRecoveryInput): boolean {
  if (typeof input.iterationStartMs !== 'number') return false;
  try {
    const ticketDir = path.join(input.sessionDir, input.ticketId);
    for (const file of fs.readdirSync(ticketDir)) {
      if (!LIFECYCLE_ARTIFACT_RE.test(file)) continue;
      try {
        if (fs.statSync(path.join(ticketDir, file)).mtimeMs >= input.iterationStartMs) return true;
      } catch { /* ignore unstattable artifact */ }
    }
  } catch { /* ticket dir unreadable → no evidence */ }
  return false;
}

/** Append one entry to `state.recovery_attempts` (R-WMW-5 persistence pattern: state-backed, survives relaunch/--resume). */
function appendRecoveryLedgerEntry(statePath: string, attempt: RecoveryAttempt): void {
  try {
    sm.update(statePath, (s) => {
      if (!Array.isArray(s.recovery_attempts)) s.recovery_attempts = [];
      s.recovery_attempts.push(attempt);
    });
  } catch { /* best-effort ledger append — never block recovery */ }
}

function detectSilentDeathAttributableWork(
  input: SilentDeathRecoveryInput,
): 'completion_commit' | 'scoped_commit' | 'fresh_artifacts' | null {
  if (resolveAttributableFrontmatterSha(input.sessionDir, input.ticketId, input.workingDir) !== null) { return 'completion_commit'; }
  if (hasScopedIterationWindowCommit(input)) return 'scoped_commit';
  if (hasFreshLifecycleArtifacts(input)) return 'fresh_artifacts';
  return null;
}

/**
 * 90574654 — ONE shared recovery policy for both silent-death sub-classes,
 * salvage FIRST:
 *  (a) attributable work (frontmatter completion sha | iteration-window commit
 *      touching only allowed_paths | fresh lifecycle artifacts) → `hold`: NO
 *      respawn, no cap drawdown, ticket status untouched (H4 hold path —
 *      ticket 7eb9fa20; until it lands, hold = suppress respawn only).
 *  (b) dirty tree → `archiveBeforeDestructive` (reason `silent_death`,
 *      `.codegraph/**` excluded via isCodegraphArtifact inside the helper).
 *      `ArchiveAbortError` is fail-closed: respawn suppressed. Other archive
 *      errors (e.g. non-repo workingDir) are fail-open per ticket contract.
 *  (c) no attributable work → `respawn`, drawing down the ONE shared
 *      `silent_death_respawn_cap` persisted in `state.recovery_attempts`
 *      (strategy `silent_death_respawn`) so the budget survives relaunch and
 *      `setup.js --resume`.
 *  (d) cap exhausted → `halt` with the existing HALT-class `recovery_exhausted`.
 *
 * Never writes `worker_artifact_progress` (R-WMW-5 precedence) and never flips
 * ticket status.
 */
export function applySilentDeathRecoveryPolicy(input: SilentDeathRecoveryInput): SilentDeathRecoveryDecision {
  const cls = input.classification;
  if (!cls || cls.subClass === null) return { action: 'none' };
  const subClass = cls.subClass;
  const log = input.log ?? (() => { /* silent default */ });

  const evidence = detectSilentDeathAttributableWork(input);
  if (evidence) {
    log(`[silent-death] ${subClass} for ${input.ticketId}: attributable work (${evidence}) — hold, no respawn`);
    return { action: 'hold', subClass, evidence };
  }

  try {
    const archive = input.archive ?? archiveBeforeDestructive;
    archive({
      cwd: input.workingDir,
      sessionDir: input.sessionDir,
      ticketDir: path.join(input.sessionDir, input.ticketId),
      reason: 'silent_death',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof ArchiveAbortError || (err instanceof Error && err.name === 'ArchiveAbortError')) {
      log(`[silent-death] ${subClass} for ${input.ticketId}: pre-respawn archive failed (${msg}) — suppressing respawn (fail-closed)`);
      return { action: 'hold', subClass, evidence: 'archive_failed' };
    }
    log(`[silent-death] dirty-tree archive probe failed for ${input.ticketId} (ignored): ${msg}`);
  }

  const settings = input.settings ?? resolveHardeningSettings(loadPickleSettingsBag());
  const cap = settings.silent_death_respawn_cap;
  const prior = countSilentDeathRespawns(input.statePath, input.ticketId);
  if (prior < cap) {
    const attempt = prior + 1;
    appendRecoveryLedgerEntry(input.statePath, {
      strategy: SILENT_DEATH_RESPAWN_STRATEGY,
      outcome: 'success',
      reason: `${subClass} respawn ${attempt}/${cap} for ${input.ticketId}`,
      iteration: input.iteration,
      ticket: input.ticketId,
    });
    log(`[silent-death] ${subClass} for ${input.ticketId}: no attributable work — respawn ${attempt}/${cap}`);
    return { action: 'respawn', subClass, attempt, cap };
  }

  appendRecoveryLedgerEntry(input.statePath, {
    strategy: SILENT_DEATH_RESPAWN_STRATEGY,
    outcome: 'failed',
    reason: `cap_exhausted (${prior}/${cap}) for ${input.ticketId} — falling through to no-progress halt`,
    iteration: input.iteration,
    ticket: input.ticketId,
  });
  log(`[silent-death] ${subClass} for ${input.ticketId}: respawn cap ${cap} exhausted — halting`);
  return { action: 'halt', subClass, exitReason: 'recovery_exhausted', cap };
}

// ---------------------------------------------------------------------------
// Ticket 7eb9fa20 (H4) — Failed-flip evidence suppression with bounded
// non-runnable hold. ONE shared policy guards the three real Failed-flip
// callsites: (1) detectAndRecoverHeadRegression's evidence-absent fallback
// (e56ed23f: the head-regression DIVERGENCE/ambiguous/undiscovered path now
// first emits `orphan_commit_unreattachable` and routes here to the hold path;
// it NEVER rewrites history — no `git reset`, no `--force`; `marked_failed` is
// reachable only when this shared policy returns `proceed` with NO evidence),
// (2) the R-WMW-5 wmw-auto-skip flip, (3) spawn-morty's gate-fail reset+flip
// (spawn-morty imports `evaluateFailedFlipSuppression` from this module —
// runtime-only usage, so the existing mux-runner→spawn-morty import of
// `resolveCodexModel` does not create an ESM evaluation-order hazard).
//
// Evidence is an OR-predicate, not AND: fresh lifecycle artifacts in the
// [spawn, exit] window (skew-tolerant, `.codegraph/**` excluded) OR a
// ticket-scoped commit (frontmatter completion sha authoritative — but only
// when it resolves to a real commit object, so a garbage sha can never hold a
// ticket; else a window commit whose touched paths ⊆ scope allowed_paths).
// Evidence-check errors fail OPEN (existing flip behavior proceeds).
// Suppressions persist as `state.recovery_attempts` entries (strategy
// `failed_flip_suppressed`) — NO new state.json top-level field (R-RMBS-1) —
// and emit the `failed_flip_suppressed` activity event. At
// `hardening.failed_flip_suppression_cap` (default 2) the decision escalates
// to the existing no-progress halt instead of suppressing again.
// ---------------------------------------------------------------------------

export const FAILED_FLIP_SUPPRESSED_STRATEGY = 'failed_flip_suppressed';
/** Mtime skew tolerance for the artifact-evidence window (filesystem timestamp granularity). */
const FAILED_FLIP_SKEW_MS = 2_000;

export type FailedFlipCallsite = 'head_regression' | 'wmw_auto_skip' | 'worker_gate_fail';
export type FailedFlipEvidenceKind = 'fresh_artifacts' | 'ticket_commit' | 'signal_committed' | 'both';

export interface FailedFlipSuppressionInput {
  sessionDir: string;
  statePath: string;
  ticketId: string;
  workingDir: string;
  iteration: number;
  callsite: FailedFlipCallsite;
  /** Spawn timestamp (epoch ms) opening the evidence window; null/absent disables the artifact arm. */
  windowStartMs?: number | null;
  /** Exit timestamp (epoch ms) closing the evidence window; defaults to now. */
  windowEndMs?: number | null;
  /** HEAD sha captured before the window — base of the scoped-commit probe. */
  preSha?: string | null;
  /**
   * B-RRH C3: interruption cause for the flip intent. A signal teardown
   * (`/^signal/i`) over a COMMITTED ticket is evidence-present. Absent → read
   * `state.exit_reason` (the signal handler stamps `'signal'`). Read errors fall
   * back conservatively (arm inert; never a false-Fail).
   */
  interruptionCause?: string | null;
  /** Injectable for tests; defaults to `resolveHardeningSettings(loadPickleSettingsBag())`. */
  settings?: HardeningSettings | null;
  log?: (msg: string) => void;
  /** W4a discriminant (observability only — the suppression decision is unchanged). */
  backend?: RecoveryBackend;
  mode?: RecoveryMode;
}

export type FailedFlipSuppressionDecision =
  | { action: 'suppress'; evidence: FailedFlipEvidenceKind; suppressionCount: number }
  | { action: 'proceed'; reason: 'no_evidence' | 'evidence_check_error' }
  | { action: 'escalate'; cap: number };

/** Evidence arm (a): a lifecycle artifact mtime inside [spawn, exit] + skew; `.codegraph/**` excluded via isCodegraphArtifact. */
function hasFreshTicketArtifactEvidence(input: FailedFlipSuppressionInput): boolean {
  if (typeof input.windowStartMs !== 'number') return false;
  const windowEnd = typeof input.windowEndMs === 'number' ? input.windowEndMs : Date.now();
  const ticketDir = path.join(input.sessionDir, input.ticketId);
  for (const file of fs.readdirSync(ticketDir)) {
    if (isCodegraphArtifact(file)) continue;
    if (!LIFECYCLE_ARTIFACT_RE.test(file)) continue;
    let mtimeMs: number;
    try { mtimeMs = fs.statSync(path.join(ticketDir, file)).mtimeMs; } catch { continue; }
    if (mtimeMs >= input.windowStartMs - FAILED_FLIP_SKEW_MS && mtimeMs <= windowEnd + FAILED_FLIP_SKEW_MS) {
      return true;
    }
  }
  return false;
}

/** Evidence arm (b): frontmatter completion sha (verified via the shared B-RASO oracle) OR a window commit whose touched paths ⊆ allowed_paths. */
function hasTicketScopedCommitEvidence(input: FailedFlipSuppressionInput): boolean {
  if (resolveAttributableFrontmatterSha(input.sessionDir, input.ticketId, input.workingDir) !== null) { return true; }
  if (!input.preSha) return false;
  const head = silentDeathGit(['rev-parse', 'HEAD'], input.workingDir);
  if (!head || head === input.preSha) return false;
  const diffOut = silentDeathGit(['diff', '--name-only', `${input.preSha}..HEAD`], input.workingDir);
  if (diffOut === null) return false;
  const touched = diffOut.split('\n').map((s) => s.trim()).filter(Boolean);
  if (touched.length === 0) return false;
  const allowed = readScopeAllowedPaths(input.sessionDir);
  if (!allowed || allowed.length === 0) return true;
  return touched.every((f) => isWithinAllowedPaths(f, allowed));
}

/**
 * B-RRH C3 evidence arm (c): a SIGTERM-interrupted-but-COMMITTED ticket.
 * "Committed" per the git-utils invariant #2 = a present `completion_commit`
 * (explicit) OR `completion_commit_inferred` frontmatter field — NOT requiring
 * git resolution, because a signal teardown can move HEAD out from under the
 * committed work while the durable frontmatter field is the evidence. Read
 * failure → false (the other arms still apply; never a false-Fail).
 */
function hasPresentCompletionCommitField(sessionDir: string, ticketId: string): boolean {
  let raw: string;
  try { raw = fs.readFileSync(ticketFilePath(sessionDir, ticketId), 'utf-8'); } catch { return false; }
  for (const field of ['completion_commit', 'completion_commit_inferred'] as const) {
    const value = (readFrontmatterField(raw, field) ?? '').trim().replace(/^['"]+|['"]+$/g, '');
    if (value.length > 0) return true;
  }
  return false;
}

/**
 * Resolve whether this flip intent is a signal teardown. Prefers the explicit
 * `interruptionCause` input; falls back to the recoverable `state.exit_reason`
 * (the signal handler stamps `'signal'` before deactivation). Matches `/^signal/i`
 * so future `signal:SIGTERM`-style stamps are covered. Any error → false.
 */
function resolveInterruptionIsSignal(input: FailedFlipSuppressionInput): boolean {
  let cause = typeof input.interruptionCause === 'string' ? input.interruptionCause : null;
  if (cause === null) {
    try {
      const s = readRecoverableJsonObject(input.statePath) as State | null;
      cause = typeof s?.exit_reason === 'string' ? s.exit_reason : null;
    } catch { return false; }
  }
  return cause !== null && /^signal/i.test(cause.trim());
}

/** OR-combine the evidence arms. Returns null when none holds. */
function detectFailedFlipEvidence(input: FailedFlipSuppressionInput): FailedFlipEvidenceKind | null {
  const artifacts = hasFreshTicketArtifactEvidence(input);
  const commit = hasTicketScopedCommitEvidence(input);
  if (artifacts && commit) return 'both';
  if (artifacts) return 'fresh_artifacts';
  if (commit) return 'ticket_commit';
  // C3: a signal teardown over a committed ticket is evidence-present even when
  // the window/scope arms stay silent (e.g. HEAD moved under the commit).
  if (resolveInterruptionIsSignal(input) && hasPresentCompletionCommitField(input.sessionDir, input.ticketId)) {
    return 'signal_committed';
  }
  return null;
}

/**
 * Decide suppress / proceed / escalate for one Failed-flip intent.
 * - suppress: evidence present, under cap — ledger entry appended (strategy
 *   `failed_flip_suppressed`, outcome success), `failed_flip_suppressed`
 *   activity event emitted, frontmatter status preserved by the caller.
 * - proceed: no evidence (caller archives a dirty tree, then flips) or the
 *   evidence check itself errored (fail-open: existing flip behavior).
 * - escalate: evidence present but cap reached — caller routes to the
 *   existing no-progress halt; the flip is still skipped (a ticket is only
 *   ever flipped Failed with evidence absent).
 */
export function evaluateFailedFlipSuppression(input: FailedFlipSuppressionInput): FailedFlipSuppressionDecision {
  const log = input.log ?? (() => { /* silent default */ });
  let evidence: FailedFlipEvidenceKind | null;
  try {
    evidence = detectFailedFlipEvidence(input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[failed-flip] evidence check failed for ${input.ticketId} at ${input.callsite} (fail-open, flip proceeds): ${msg}`);
    return { action: 'proceed', reason: 'evidence_check_error' };
  }
  if (!evidence) return { action: 'proceed', reason: 'no_evidence' };

  const settings = input.settings ?? resolveHardeningSettings(loadPickleSettingsBag());
  const cap = settings.failed_flip_suppression_cap;
  const prior = countLedgerSuccesses(input.statePath, input.ticketId, FAILED_FLIP_SUPPRESSED_STRATEGY);
  if (prior >= cap) {
    appendRecoveryLedgerEntry(input.statePath, {
      strategy: FAILED_FLIP_SUPPRESSED_STRATEGY,
      outcome: 'failed',
      reason: `cap_exhausted (${prior}/${cap}) at ${input.callsite} for ${input.ticketId} — escalating to no-progress halt`,
      iteration: input.iteration,
      ticket: input.ticketId,
    });
    log(`[failed-flip] ${input.callsite} for ${input.ticketId}: evidence (${evidence}) but suppression cap ${cap} reached — escalating`);
    return { action: 'escalate', cap };
  }

  const suppressionCount = prior + 1;
  appendRecoveryLedgerEntry(input.statePath, {
    strategy: FAILED_FLIP_SUPPRESSED_STRATEGY,
    outcome: 'success',
    reason: `${input.callsite} flip suppressed ${suppressionCount}/${cap} (${evidence}) for ${input.ticketId}`,
    iteration: input.iteration,
    ticket: input.ticketId,
  });
  try {
    writeActivityEntry(input.statePath, {
      event: 'failed_flip_suppressed',
      ts: new Date().toISOString(),
      ticket: input.ticketId,
      evidence,
      suppression_count: suppressionCount,
    });
  } catch { /* best-effort telemetry — never block the suppression */ }
  log(`[failed-flip] ${input.callsite} for ${input.ticketId}: flip suppressed ${suppressionCount}/${cap} (${evidence}) — ticket held, status preserved`);
  return { action: 'suppress', evidence, suppressionCount };
}

/**
 * Ticket ids with an ACTIVE failed-flip suppression hold: a success ledger
 * entry exists AND the operator has not re-queued the ticket (frontmatter
 * `status: Todo` releases the hold — same heal flow as oversized_no_progress).
 * Selection-layer only (R-RMBS-1: `isPendingMuxTicket` stays canonical and
 * untouched). Any read error → empty set (fail-open: never blocks scheduling).
 */
export function readActiveFailedFlipHolds(sessionDir: string): Set<string> {
  const held = new Set<string>();
  try {
    const s = readRecoverableJsonObject(path.join(sessionDir, 'state.json')) as State | null;
    if (!s || !Array.isArray(s.recovery_attempts)) return held;
    for (const a of s.recovery_attempts) {
      if (a && a.strategy === FAILED_FLIP_SUPPRESSED_STRATEGY && a.outcome === 'success' && typeof a.ticket === 'string') {
        held.add(a.ticket);
      }
    }
    for (const id of [...held]) {
      try {
        if (normalizeTicketStatus(getTicketStatus(sessionDir, id)) === 'todo') held.delete(id);
      } catch { /* unreadable status → stay held (conservative) */ }
    }
  } catch { return held; }
  return held;
}

/**
 * Evidence-absent flip path: archive a dirty tree BEFORE the flip so the
 * runner's downstream reset path can never destroy unexamined work.
 * `archiveBeforeDestructive` self-no-ops on a clean tree. Best-effort: the
 * flip itself is a non-destructive frontmatter write, so archive failure
 * (including ArchiveAbortError) logs loudly but does not block the flip.
 */
function archiveDirtyTreeBeforeFlip(input: { workingDir: string; sessionDir: string; ticketId: string; log: (msg: string) => void }): void {
  try {
    archiveBeforeDestructive({
      cwd: input.workingDir,
      sessionDir: input.sessionDir,
      ticketDir: path.join(input.sessionDir, input.ticketId),
      reason: 'pre_reset',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    input.log(`[failed-flip] pre-flip archive failed for ${input.ticketId} (flip proceeds; tree untouched): ${msg}`);
  }
}

// ───────────── AC-WMFF-2B: worker_produced_everything_but_commit breadcrumb ─────────────

/** Cap on `gate_payload.dirty_in_scope_paths` — the 20MB-state.json incident precedent. */
const EVERYTHING_BUT_COMMIT_PATH_CAP = 20;

/** Bounded git probe for the `preIterSha..HEAD` window walk. */
const EVERYTHING_BUT_COMMIT_GIT_TIMEOUT_MS = 5000;

/**
 * B-OFFREPO: narrow a four-valued verdict down to the frozen
 * `worker_produced_everything_but_commit` payload enum. `not_run` collapses to
 * `absent` — the fail-closed direction. It is NEVER collapsed to `green`.
 */
function narrowVerdictForFrozenPayload(v: 'green' | 'red' | 'absent' | 'not_run'): 'green' | 'red' | 'absent' {
  return v === 'not_run' ? 'absent' : v;
}

/** Frozen `gate_payload` shape for `worker_produced_everything_but_commit` (AC-WMFF-2C). */
export interface WorkerProducedEverythingButCommitPayload {
  tier: TicketComplexityTier;
  prefixes_checked: string[];
  session_log_bytes: number;
  worker_gate_verdict: 'green' | 'red' | 'absent';
  dirty_in_scope_paths: string[];
  truncated: boolean;
  total_count: number;
  window_commit: string | null;
}

/**
 * In-process claim ledger keyed `${ticketId}:${iteration}` — the frozen payload carries no
 * iteration field, so `state.activity` cannot reconstruct the key. One mux-runner process
 * drives one loop, so this is the correct scope: a re-check for the SAME iteration (and a
 * bounded-terminal-escape revisit) must not re-emit.
 */
const everythingButCommitClaimed = new Set<string>();

/**
 * Dirty working-tree paths, scope-filtered when the session has a `scope.json`.
 *
 * REUSES the exported `checkScopeDiff` (never re-implements scope matching) so the #128
 * `CLAUDE.md` trap-door-catalog carve-out flows through. `checkScopeDiff` reads the INDEX,
 * so the working-tree paths are fed through its documented `_getStagedPaths` seam. No
 * `scope.json` (or a malformed one) → scope-unfiltered.
 *
 * Codegraph artifacts are dropped FIRST (before the early return, so a codegraph-only tree
 * collapses to `[]` and the predicate declines), via the same exported `isCodegraphArtifact`
 * that `archiveBeforeDestructive` uses. This set MUST equal the set the archive would save:
 * the payload claims "this work is still on the floor" and the archive is what makes it
 * recoverable, so a disagreement sends the operator after a `pre_reset_*.patch` that was never
 * written. Codegraph writes its index INTO the working dir (`<workingDir>/.codegraph/`), and
 * `.codegraph/` is git-ignored only through the local, unversioned `.git/info/exclude` — on a
 * fresh clone it is plain untracked dirt.
 */
function collectDirtyInScopePaths(workingDir: string, sessionDir: string): string[] {
  const dirty = listWorkingTreeDirtyPaths(workingDir).filter((p) => !isCodegraphArtifact(p));
  if (dirty.length === 0) {
    return [];
  }

  const scopeJsonPath = path.join(sessionDir, 'scope.json');
  if (!fs.existsSync(scopeJsonPath)) {
    return dirty;
  }

  const result = checkScopeDiff({ scopeJsonPath, _getStagedPaths: () => dirty });
  if (result.status !== 'outside_scope') {
    return dirty;
  }

  const outside = new Set(result.staged_paths_outside_scope ?? []);
  return dirty.filter((p) => !outside.has(p));
}

/** Every ticket's frontmatter completion sha (explicit + inferred), lowercased. */
function collectReferencedCompletionShas(sessionDir: string): string[] {
  const shas: string[] = [];
  for (const ticket of collectTickets(sessionDir)) {
    if (!ticket.id) {
      continue;
    }
    let raw: string;
    try { raw = fs.readFileSync(ticketFilePath(sessionDir, ticket.id), 'utf-8'); } catch { continue; }
    for (const field of ['completion_commit', 'completion_commit_inferred']) {
      const v = (readFrontmatterField(raw, field) ?? '').trim().replace(/["']/g, '').toLowerCase();
      if (/^[0-9a-f]{7,40}$/.test(v)) {
        shas.push(v);
      }
    }
  }
  return shas;
}

/**
 * First commit in `preIterSha..HEAD` that is not any ticket's `completion_commit` — the
 * "worker committed but nobody claimed it" arm. `preIterSha` is already in scope at the
 * emit site, so this is ONE bounded `rev-list` over an existing window — no new git walker.
 */
function findUnreferencedWindowCommit(workingDir: string, sessionDir: string, preIterSha: string | null): string | null {
  if (!preIterSha) {
    return null;
  }
  const r = spawnSync('git', ['-C', workingDir, 'rev-list', `${preIterSha}..HEAD`], {
    encoding: 'utf-8', timeout: EVERYTHING_BUT_COMMIT_GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) {
    return null;
  }
  const shas = ((r.stdout as string) || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (shas.length === 0) {
    return null;
  }

  const referenced = collectReferencedCompletionShas(sessionDir);
  // `sha` is a full 40-char sha from `rev-list`; `ref` is `^[0-9a-f]{7,40}$` — never longer. So a
  // stored ref can only ever be a PREFIX of a window sha, never the reverse.
  const isReferenced = (sha: string): boolean => {
    const lower = sha.toLowerCase();
    return referenced.some((ref) => lower.startsWith(ref));
  };
  return shas.find((sha) => !isReferenced(sha)) ?? null;
}

/**
 * AC-WMFF-2B: claim-once evaluation of the `worker_produced_everything_but_commit` predicate.
 *
 * Fires when the worker-process budget-death flip left a ticket Failed even though it produced
 * EVERY gated artifact for its tier and its work is still recoverable — either an uncommitted
 * dirty tree or an unclaimed commit inside the iteration window. Returns the frozen
 * `gate_payload` on the first claim of a `(ticket, iteration)` pair, `null` otherwise.
 *
 * OBSERVABILITY ONLY: this performs no reap, no salvage, no status write, and no frontmatter
 * write. The caller's sole action is `writeActivityEntry`. Best-effort — any throw reads null.
 */
export function claimWorkerProducedEverythingButCommit(input: {
  sessionDir: string;
  workingDir: string;
  ticketId: string;
  iteration: number;
  sessionLogBytes: number;
  preIterSha: string | null;
}): WorkerProducedEverythingButCommitPayload | null {
  const { sessionDir, workingDir, ticketId, iteration, sessionLogBytes, preIterSha } = input;
  try {
    // (1) the worker-flip class: the ticket reads Failed.
    if (normalizeTicketStatus(getTicketStatus(sessionDir, ticketId)) !== 'failed') {
      return null;
    }

    // (2) idempotent once per (ticket, iteration).
    const claimKey = `${ticketId}:${iteration}`;
    if (everythingButCommitClaimed.has(claimKey)) {
      return null;
    }

    // (3) every gated artifact for the tier is present. Tier is read from the TICKET
    // FRONTMATTER, never `state.current_ticket_tier` — that cache is the R-CNAR-1
    // staleness trap and can describe a previously-selected ticket.
    const tier: TicketComplexityTier =
      parseTicketFrontmatter(ticketFilePath(sessionDir, ticketId))?.complexity_tier ?? 'medium';
    const prefixes = requiredTierArtifactPrefixes(tier);
    const ticketDir = path.join(sessionDir, ticketId);
    if (findMissingPrefixes(fs.readdirSync(ticketDir), prefixes).length > 0) {
      return null;
    }

    // (4) the work is still on the floor: an uncommitted dirty tree OR an unclaimed commit.
    const dirty = collectDirtyInScopePaths(workingDir, sessionDir);
    const windowCommit = findUnreferencedWindowCommit(workingDir, sessionDir, preIterSha);
    if (dirty.length === 0 && windowCommit === null) {
      return null;
    }

    everythingButCommitClaimed.add(claimKey);
    return {
      tier,
      prefixes_checked: prefixes,
      session_log_bytes: sessionLogBytes,
      // B-OFFREPO: this payload is FROZEN (AC-WMFF-2C) and its schema enum
      // (`activity-events.schema.json`) is `green|red|absent`, outside this
      // ticket's scope — so `not_run` is narrowed to `absent` here rather than
      // emitted non-conformantly. The narrowing is fail-closed and never reports
      // a pass; it under-reports (the ticket frontmatter still carries the
      // literal `not_run`). Widening the frozen enum is deferred.
      worker_gate_verdict: narrowVerdictForFrozenPayload(readWorkerGateVerdict(sessionDir, ticketId)),
      dirty_in_scope_paths: dirty.slice(0, EVERYTHING_BUT_COMMIT_PATH_CAP),
      truncated: dirty.length > EVERYTHING_BUT_COMMIT_PATH_CAP,
      total_count: dirty.length,
      window_commit: windowCommit,
    };
  } catch {
    return null; // best-effort — a breadcrumb never alters the iteration outcome
  }
}

/**
 * R-WSE-3: Emit a stderr breadcrumb when a ticket has status Failed
 * but its research_review.md ends in APPROVED.
 */
export function checkFailedAfterResearchApproved(sessionDir: string, ticketId: string): void {
  let status: string | null;
  try { status = getTicketStatus(sessionDir, ticketId); } catch { return; }
  if (normalizeTicketStatus(status) !== 'failed') return;

  const ticketDir = path.join(sessionDir, ticketId);
  let reviewContent: string;
  try { reviewContent = fs.readFileSync(path.join(ticketDir, 'research_review.md'), 'utf-8'); } catch { return; }
  if (!reviewContent.trimEnd().endsWith('APPROVED')) return;

  process.stderr.write(
    `[warn] [${new Date().toISOString()}] ⚠ ticket ${ticketId} failed AFTER research APPROVED — see ${sessionDir}/${ticketId}/\n`,
  );
}

export interface WorkerProductionBreadcrumbInput {
  sessionDir: string;
  statePath: string;
  workingDir: string;
  ticketId: string;
  iteration: number;
  /** `checkPartialLifecycleExit`'s verdict this iteration; `null` = no partial/silent classification. */
  partialLifecycleExit: PartialLifecycleExitClassification | null;
  /** Raw artifact-count delta across the iteration; `null` when no progress record was taken. */
  artifactDelta: number | null;
  preIterSha: string | null;
}

export type WorkerProductionBreadcrumb =
  | 'worker_produced_nothing'
  | 'worker_produced_everything_but_commit'
  | null;

/**
 * Emit AT MOST ONE post-iteration worker-production breadcrumb, and return which one fired.
 *
 * R-WSDO wins the overlap: both predicates are individually satisfiable on the same iteration
 * (a complete prefix set forces `plExit === null`, and R-WSDO's middle term is an iteration
 * DELTA — so a respawned worker carrying prior-iteration artifacts + zero delta + 0-byte log +
 * a dirty tree satisfies BOTH). Mutual exclusion therefore lives in CONTROL FLOW, never in a
 * "disjoint by construction" claim. The second arm is evaluated LAZILY so a winning R-WSDO
 * branch never spends a git call.
 *
 * Observability-only: no reap, salvage, status, or frontmatter write happens on this path.
 */
export function emitWorkerProductionBreadcrumb(
  input: WorkerProductionBreadcrumbInput,
): WorkerProductionBreadcrumb {
  const ticketDir = path.join(input.sessionDir, input.ticketId);
  const { subClass, sessionLogSize, pid } = classifyWorkerSessionLogs(ticketDir, fs.readdirSync(ticketDir));

  const wsdoFires =
    input.partialLifecycleExit === null &&
    input.artifactDelta === 0 &&
    subClass === 'log_empty';

  const everythingButCommit = wsdoFires
    ? null
    : claimWorkerProducedEverythingButCommit({
      sessionDir: input.sessionDir,
      workingDir: input.workingDir,
      ticketId: input.ticketId,
      iteration: input.iteration,
      sessionLogBytes: sessionLogSize,
      preIterSha: input.preIterSha,
    });

  // ts is explicit because writeActivityEntry does NOT auto-stamp it (mirrors :8094).
  if (wsdoFires) {
    writeActivityEntry(input.statePath, {
      event: 'worker_produced_nothing',
      ts: new Date().toISOString(),
      ticket: input.ticketId,
      gate_payload: { spawn_pid: pid, session_log_bytes: sessionLogSize, artifact_delta: 0 },
    });
    return 'worker_produced_nothing';
  } else if (everythingButCommit) {
    writeActivityEntry(input.statePath, {
      event: 'worker_produced_everything_but_commit',
      ts: new Date().toISOString(),
      ticket: input.ticketId,
      gate_payload: everythingButCommit,
    });
    return 'worker_produced_everything_but_commit';
  }
  return null;
}

export function detectPkgJsonVersionDrift(
  srcPath: string,
  depPath: string,
  statePath: string,
): void {
  const ts = new Date().toISOString();
  let srcPkg: Record<string, unknown>;
  let depPkg: Record<string, unknown>;

  try {
    srcPkg = JSON.parse(fs.readFileSync(srcPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    writeActivityEntry(statePath, { event: 'pkgjson_dep_or_src_missing', src_path: srcPath, dep_path: depPath, ts });
    return;
  }
  try {
    depPkg = JSON.parse(fs.readFileSync(depPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    writeActivityEntry(statePath, { event: 'pkgjson_dep_or_src_missing', src_path: srcPath, dep_path: depPath, ts });
    return;
  }

  const srcVersion = String(srcPkg.version ?? '');
  const depVersion = String(depPkg.version ?? '');

  if (srcVersion === depVersion) return;

  const srcOther = Object.fromEntries(Object.entries(srcPkg).filter(([k]) => k !== 'version'));
  const depOther = Object.fromEntries(Object.entries(depPkg).filter(([k]) => k !== 'version'));
  const onlyVersionDiffers = JSON.stringify(srcOther) === JSON.stringify(depOther);

  const eventKind = onlyVersionDiffers ? 'pkgjson_only_revert_detected' : 'pkgjson_full_drift_detected';

  if (onlyVersionDiffers) {
    process.stderr.write(`[pickle-rick] pkgjson revert detected: src=${srcVersion} dep=${depVersion}\n`);
  }

  writeActivityEntry(statePath, {
    event: eventKind,
    src_version: srcVersion,
    dep_version: depVersion,
    src_path: srcPath,
    dep_path: depPath,
    ts,
  });
}

async function main() {
  try {
    assertSchemaVersionDeployParity();
  } catch (err) {
    if (err instanceof SchemaVersionDeployDriftError) {
      process.stderr.write(`${safeErrorMessage(err)}\n`);
      process.exit(1);
    }
    throw err;
  }
  await runMuxRunnerMain();
}

/** Telemetry context shared by the phantom-Done emitters. */
interface PhantomDoneEmitCtx {
  sessionDir: string;
  statePath: string;
  log: (msg: string) => void;
}

/**
 * Re-seeds the prior-status map after an inspect so a later revert restores the
 * value the ticket actually held (Todo vs. In Progress) instead of defaulting.
 */
const refreshPriorStatusAfterInspect = (
  priorStatusMap: Map<string, string>,
  ticketId: string,
  ticketFile: string,
  result: PhantomDoneInspectResult,
): void => {
  if (result.reason === 'reverted' && result.priorStatus) {
    priorStatusMap.set(ticketId, result.priorStatus);
    return;
  }
  if (result.reason !== 'not_done' && result.reason !== 'has_completion_commit') return;
  try {
    const live = readFrontmatterField(fs.readFileSync(ticketFile, 'utf8'), 'status');
    if (live) priorStatusMap.set(ticketId, live);
  } catch { /* best-effort */ }
};

/** Reports a phantom-Done whose completion commit was inferred from git. */
const emitBackfillEvent = (
  ctx: PhantomDoneEmitCtx,
  ticketId: string,
  commit: string,
  ts: string,
): void => {
  const shortSha = commit.slice(0, 7);
  process.stderr.write(
    `phantom-Done inferred completion commit for ticket ${ticketId} with commit ${shortSha} (work was done, explicit field was missing)\n`,
  );
  try {
    writeActivityEntry(ctx.statePath, {
      event: 'phantom_done_backfilled',
      source: 'pickle',
      session: path.basename(ctx.sessionDir),
      ticket: ticketId,
      commit_hash: commit,
      ts,
    });
    writeActivityEntry(ctx.statePath, {
      event: 'completion_commit_inferred_from_git',
      source: 'pickle',
      session: path.basename(ctx.sessionDir),
      ticket_id: ticketId,
      sha: commit,
      ts,
    });
  } catch (err) {
    ctx.log(`phantom-Done watcher: writeActivityEntry threw (ignored): ${safeErrorMessage(err)}`);
  }
};

/**
 * Reports a phantom-Done that was reverted for lack of completion evidence.
 *
 * Declared as a `const` arrow deliberately: the R-WSE-2 conformance test
 * (`tests/phantom-done-detected-schema-conformance.test.js`) locates this body by
 * matching `const emitRevertEvent = (...)` to assert the schema-required quartet
 * is passed explicitly. Keep the declaration shape when editing.
 */
const emitRevertEvent = (
  ctx: PhantomDoneEmitCtx,
  ticketId: string,
  result: PhantomDoneInspectResult,
  ts: string,
): void => {
  const priorMsg = result.priorStatus ?? 'Todo';
  if (result.gitFailureReason) {
    process.stderr.write(
      `phantom-Done detected for ticket ${ticketId} — reverted (git lookup failed: ${result.gitFailureReason})\n`,
    );
  } else {
    process.stderr.write(
      `phantom-Done detected for ticket ${ticketId} — reverted to ${priorMsg} (no completion_commit field, no matching commit in HEAD~10)\n`,
    );
  }
  try {
    writeActivityEntry(ctx.statePath, {
      event: 'phantom_done_detected',
      source: 'pickle',
      session: path.basename(ctx.sessionDir),
      ticket: ticketId,
      completion_commit_present: false,
      ts,
    });
  } catch (err) {
    ctx.log(`phantom-Done watcher: writeActivityEntry threw (ignored): ${safeErrorMessage(err)}`);
  }
};

/** Resolved codegraph settings as `createCodegraphSession` consumes them. */
export type CodegraphSessionSettings = ReturnType<typeof resolveCodegraphSettings>;

/**
 * Substitutable halves of `createCodegraphSession`'s environment. Both default to
 * the production implementations; a caller supplies them to drive the session's
 * verbs without a real settings file or a real native index.
 */
export interface CodegraphSessionDeps {
  resolveSettings?: () => CodegraphSessionSettings;
  createService?: (settings: CodegraphSessionSettings) => CodegraphService | Promise<CodegraphService>;
}

/**
 * b1089e97: session-scoped codegraph lifecycle.
 *
 * Owns the `CodegraphService` handle, its resolved settings, the on-disk db path,
 * and the Done-ticket count that rides in the session summary — so it is a module,
 * not a phase of the run loop. Callers get four verbs: `init`, `syncIfStale`,
 * `emitSummary`, `close`. Every one is fail-open: codegraph is an optimization, so
 * a failure anywhere in here must never block the session it annotates.
 *
 * The handle is built BEFORE signal-handler registration so those handlers can close
 * over it, but `init()` runs after — the service stays null until then, and settings
 * are read at `init()` time, preserving the original inline sequencing exactly.
 *
 * `deps` is the test seam. Production omits it and gets the two defaults below;
 * a caller that substitutes them can drive the real `emitSummary` — which is the
 * only way to prove the b1089e97 payload derives from PERSISTED activity rather
 * than the always-zero in-memory counters. Without the seam that wiring was
 * pinned by prose alone: the counter helpers are pure and stay green under a
 * revert of the emit site.
 */
export function createCodegraphSession(opts: {
  statePath: string;
  sessionDir: string;
  workingDir: string;
  log: (msg: string) => void;
  deps?: CodegraphSessionDeps;
}): {
  init: () => Promise<void>;
  syncIfStale: () => Promise<void>;
  emitSummary: () => void;
  close: () => void;
} {
  const { statePath, sessionDir, workingDir, log } = opts;
  const dbPath = path.join(workingDir, '.codegraph', 'codegraph.db');
  const resolveSettings = opts.deps?.resolveSettings
    ?? ((): CodegraphSessionSettings => resolveCodegraphSettings(loadPickleSettingsBag()));
  const createService = opts.deps?.createService
    ?? ((s: CodegraphSessionSettings): CodegraphService => CodegraphService.create(
      workingDir,
      s,
      { emit: (ev) => writeActivityEntry(statePath, ev as unknown as ActivityLogEntry) },
    ));
  let settings: CodegraphSessionSettings | null = null;
  let service: CodegraphService | null = null;
  let ticketCount = 0;

  return {
    // Gated on settings.enabled: with codegraph disabled, a leftover
    // .codegraph/codegraph.db (prior enabled run, or direct CLI use) must not
    // keep the native library loading and re-syncing every staleness window.
    init: async (): Promise<void> => {
      settings = resolveSettings();
      if (!settings.enabled) return;
      try {
        service = await createService(settings);
      } catch (err) {
        log(`codegraph service init failed (ignored): ${safeErrorMessage(err)}`);
      }
    },

    // Per-spawn staleness sync (bounded by sync_timeout_ms inside the service).
    syncIfStale: async (): Promise<void> => {
      if (service === null || settings === null) return;
      if (shouldSyncCodegraph(dbPath, settings.staleness_max_age_minutes)) {
        try { await service.sync(); } catch { /* degrade already emitted by the service */ }
      }
      ticketCount = collectTickets(sessionDir).filter((t) => t.status === 'Done').length;
    },

    emitSummary: (): void => {
      try {
        if (service === null) return;
        const ctrs = service.getSessionCounters();
        const index_status: 'healthy' | 'degraded' | 'latched' | 'disabled' =
          ctrs.latched > 0 ? 'latched' : ctrs.degraded > 0 ? 'degraded' : 'healthy';
        // injected/skipped/degraded_ops are produced/degraded in the per-spawn spawn-morty
        // process, so mux-runner's in-memory counters never see them — count the persisted
        // events from the shared state.json instead (b1089e97 cross-process aggregation gap).
        // `ctrs.degraded` alone captured only mux-runner's own sync() degrades and missed every
        // spawn-path query/buildContext degrade; index_status stays on the in-memory counter as
        // the long-lived mux-service health enum.
        const persisted = readRecoverableJsonObject(statePath) as State | null;
        const { injected, skipped } = countCodegraphContextEvents(persisted?.activity);
        const degraded_ops = countCodegraphDegradedEvents(persisted?.activity);
        writeActivityEntry(statePath, {
          event: 'codegraph_session_summary',
          ts: new Date().toISOString(),
          tickets: ticketCount,
          degraded_ops,
          index_status,
          injected,
          skipped,
        });
      } catch { /* best-effort */ }
    },

    close: (): void => {
      if (service === null) return;
      try { service.close(); } catch { /* best-effort */ }
    },
  };
}

/**
 * R-ICP-5: phantom-Done filesystem watcher. Catches Todo→Done flips that happen
 * mid-iteration (between the iteration-boundary backstop in
 * correctPhantomDoneTickets). One fs.watch per rick_ticket_*.md file.
 *
 * Owns its own state — watchers, debounce timers, prior-status map, re-check
 * budget — so it is a module, not a phase of the run loop. Callers get two
 * verbs: install (this call) and `close()` on the returned handle, which the
 * loop wires to the exit and signal paths so we don't leak file descriptors.
 */
function startPhantomDoneWatchers(opts: {
  sessionDir: string;
  statePath: string;
  defaultWorkingDir: string;
  log: (msg: string) => void;
}): { close: () => void } {
  const { sessionDir, statePath, defaultWorkingDir, log } = opts;
  const emitCtx: PhantomDoneEmitCtx = { sessionDir, statePath, log };
  const watchers: fs.FSWatcher[] = [];
  let closed = false;
  // Per-ticket debounce timers, last-known prior status (the value before a
  // possible Done flip), and re-check counters. Re-checks are capped at 2 per
  // ticket per minute to bound the cost of pathological re-flip loops.
  const phantomDoneDebounceMs = 150;
  const phantomDoneRecheckMs = 300;
  const phantomDoneRecheckWindowMs = 60_000;
  const phantomDoneRecheckCap = 2;
  const debounceTimers = new Map<string, NodeJS.Timeout>();
  const priorStatusMap = new Map<string, string>();
  const recheckTimestamps = new Map<string, number[]>();

  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const watcher of watchers) {
      try { watcher.close(); } catch { /* best-effort */ }
    }
    watchers.length = 0;
    for (const timer of debounceTimers.values()) {
      try { clearTimeout(timer); } catch { /* best-effort */ }
    }
    debounceTimers.clear();
  };

  const scheduleRecheckIfBudget = (
    ticketId: string,
    ticketFile: string,
    workingDir: string,
  ): void => {
    const now = Date.now();
    const stamps = (recheckTimestamps.get(ticketId) ?? []).filter(
      (t) => now - t < phantomDoneRecheckWindowMs,
    );
    if (stamps.length >= phantomDoneRecheckCap) {
      recheckTimestamps.set(ticketId, stamps);
      log(`phantom-Done watcher: re-check cap reached for ${ticketId} — skipping further re-checks this minute`);
      return;
    }
    stamps.push(now);
    recheckTimestamps.set(ticketId, stamps);
    setTimeout(() => {
      if (closed) return;
      handlePhantomDoneEvent(ticketId, ticketFile, workingDir, true);
    }, phantomDoneRecheckMs);
  };

  const handlePhantomDoneEvent = (
    ticketId: string,
    ticketFile: string,
    workingDir: string,
    isRecheck: boolean,
  ): void => {
    const prior = priorStatusMap.get(ticketId) ?? 'Todo';
    let result: PhantomDoneInspectResult;
    try {
      result = inspectPhantomDoneTicketFile(ticketFile, sessionDir, workingDir, prior);
    } catch (err) {
      log(`phantom-Done watcher: inspect threw for ${ticketId} (ignored): ${safeErrorMessage(err)}`);
      return;
    }

    refreshPriorStatusAfterInspect(priorStatusMap, ticketId, ticketFile, result);
    if (!result.changed) return;

    const ts = new Date().toISOString();
    if (result.reason === 'backfilled' && result.commit) {
      emitBackfillEvent(emitCtx, ticketId, result.commit, ts);
      return;
    }
    if (result.reason !== 'reverted') return;

    emitRevertEvent(emitCtx, ticketId, result, ts);
    if (!isRecheck) scheduleRecheckIfBudget(ticketId, ticketFile, workingDir);
  };

  let installed = 0;
  let skipped = 0;
  for (const ticket of collectTickets(sessionDir)) {
    if (!ticket.id) { skipped++; continue; }
    const ticketFile = path.join(sessionDir, ticket.id, `rick_ticket_${ticket.id}.md`);
    if (!fs.existsSync(ticketFile)) { skipped++; continue; }
    const ticketId = ticket.id;
    const ticketWorkingDir = ticket.working_dir || defaultWorkingDir;
    // Seed prior status from disk so the first revert restores the right
    // value (Todo vs. In Progress) instead of defaulting to Todo.
    try {
      const seed = readFrontmatterField(fs.readFileSync(ticketFile, 'utf8'), 'status');
      if (seed && seed.toLowerCase() !== 'done') {
        priorStatusMap.set(ticketId, seed);
      }
    } catch { /* best-effort */ }
    try {
      const watcher = fs.watch(ticketFile, { persistent: false }, (event) => {
        if (event !== 'change') return;
        // Debounce: coalesce rapid-fire change events into a single read.
        const existing = debounceTimers.get(ticketId);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          debounceTimers.delete(ticketId);
          if (closed) return;
          handlePhantomDoneEvent(ticketId, ticketFile, ticketWorkingDir, false);
        }, phantomDoneDebounceMs);
        debounceTimers.set(ticketId, timer);
      });
      watchers.push(watcher);
      installed++;
    } catch (err) {
      log(`phantom-Done watcher: fs.watch threw for ${ticket.id} (ignored): ${safeErrorMessage(err)}`);
      skipped++;
    }
  }
  log(`phantom-Done watcher: installed=${installed} skipped=${skipped}`);

  return { close };
}

/** What `runTerminalReport` needs to render a finished run's operator-facing report. */
export interface RunTerminalReportInput {
  /** Only the teardown half of the session; the reporter never re-initialises codegraph. */
  codegraph: Pick<ReturnType<typeof createCodegraphSession>, 'emitSummary' | 'close'>;
  sessionDir: string;
  statePath: string;
  exitReason: ExitReason;
  iteration: number;
  /** Whole seconds, supplied by the caller so this seam stays clock-free and testable. */
  totalElapsed: number;
  log: (msg: string) => void;
}

/**
 * The terminal report: codegraph teardown, `session_end`, the completion panel and
 * the tmux notification. Extracted from `runMuxRunnerMain`'s epilogue — the sanctioned
 * one-seam-at-a-time direction for that function, alongside `runMainLoopRateLimitPark`
 * and `runPostFinalMeasurement`.
 *
 * RETURNS the `CompletionVerdict` rather than deriving it and discarding it, because the
 * exit-code map below needs the same failure fact. Inline, the epilogue derived it TWICE —
 * once as a local `isFailureExit(exitReason)` for the `session_end` `error` field and the
 * exit code, and again inside `deriveCompletionVerdict` for the two renderers. Returning
 * the verdict makes WS-1c's "never re-derive `isFailureExit(exitReason)` independently"
 * structural instead of prose-enforced: there is now exactly one derivation feeding the
 * activity record, both renderers, AND the process exit code.
 *
 * Deliberately STOPS before the exit-code map. That map stays inline in
 * `runMuxRunnerMain` because `mux-runner-iteration-cap-exit.test.js` locates its three
 * branches by `indexOf` over the compiled file, and `printMinimalPanel` moves WITH this
 * seam so its exactly-one-call-site pin
 * (`mux-runner-done-without-commit-evidence-exit.test.js`) still sees one site passing
 * `completionVerdict.colorName`.
 */
export function runTerminalReport(input: RunTerminalReportInput): CompletionVerdict {
  const { codegraph, sessionDir, statePath, exitReason, iteration, totalElapsed, log } = input;

  codegraph.emitSummary();
  codegraph.close();

  const completionVerdict = deriveCompletionVerdict(exitReason);

  logActivity({
    event: 'session_end',
    source: 'pickle',
    session: path.basename(sessionDir),
    duration_min: Math.round(totalElapsed / 60),
    mode: 'tmux',
    backend: readBackendForActivity(statePath),
    ...(completionVerdict.isFailure ? { error: exitReason } : {}),
  });

  let finalStep = 'unknown';
  let finalActive = 'unknown';
  let finalMinIter = 0;
  try {
    const finalState = readRunnerState(statePath);
    const rawStep = finalState.step || 'unknown';
    finalStep = (VALID_STEPS as readonly string[]).includes(rawStep) ? rawStep : 'unknown';
    finalActive = String(finalState.active);
    const rawFinalMinIter = Number(finalState.min_iterations);
    finalMinIter = Number.isFinite(rawFinalMinIter) ? rawFinalMinIter : 0;
  } catch { /* use fallback values */ }

  printMinimalPanel(completionVerdict.panelTitle, {
    Iterations: iteration,
    Elapsed: formatTime(totalElapsed),
    FinalPhase: finalStep,
    Active: finalActive,
    ...(finalMinIter > 0 ? { 'Min Passes': finalMinIter } : {}),
  }, completionVerdict.colorName, '🥒');

  log(`mux-runner finished. ${iteration} iterations, ${formatTime(totalElapsed)}`);

  const notif = buildTmuxNotification(exitReason, finalStep, iteration, totalElapsed);
  displayMacNotification(notif.title, notif.body, notif.subtitle);

  return completionVerdict;
}

// eslint-disable-next-line -- legacy mux runner loop retained behavior-preserving for global bin acceptance
async function runMuxRunnerMain() {
  const sessionDir = process.argv[2];
  const statePath = sessionDir ? path.join(sessionDir, 'state.json') : '';
  if (
    !sessionDir
    || sessionDir.startsWith('--')
    || readRecoverableJsonObject(statePath) === null
  ) {
    console.error('Usage: node mux-runner.js <session-dir>');
    process.exit(1);
  }

  const extensionRoot = getExtensionRoot();
  const runnerLog = path.join(sessionDir, 'mux-runner.log');

  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(runnerLog, line);
    process.stderr.write(line);
  };

  log('mux-runner started');

  // Take ownership: setup.js writes active: false in tmux mode so the main
  // Claude window's stop hook is released immediately. We set active: true here
  // before monitor recovery and before entering the loop so workers and state
  // readers see a live session.
  let ownerState: State;
  try {
    ownerState = readRunnerState(statePath);
  } catch (err) {
    const msg = safeErrorMessage(err);
    throw new Error(`Cannot read initial state.json: ${msg}`);
  }
  // Startup validation — mux-runner only. microverse-runner owns its own sentinels
  // (worker_timeout_seconds=0 disables per-iteration timeout there; max_iterations=0
  // means unlimited iterations there). These rules must NOT be shared.
  {
    // R-WTZ: repair a zeroed worker_timeout_seconds before validation so a
    // poisoned sentinel value does not brick the phase with exit 2. Logged here
    // for observability; validateStartupState performs the same (idempotent)
    // repair silently as part of the single authoritative validation path.
    const timeoutRepair = repairZeroWorkerTimeout(ownerState);
    if (timeoutRepair.repaired) {
      sm.update(statePath, s => { s.worker_timeout_seconds = timeoutRepair.value; });
      log(`[mux-runner] R-WTZ: repaired worker_timeout_seconds 0 → ${timeoutRepair.value}s at load`);
    }
    // Single source of truth for startup-state validation — the same rules used
    // by validateStartupState (covered by mux-runner-startup-validation.test.js).
    // Convert its thrown Error into the runner's exit-2 contract.
    try {
      validateStartupState(ownerState, statePath);
    } catch (err) {
      console.error(safeErrorMessage(err));
      process.exit(2);
    }
  }

  try {
    const extensionDir = path.join(extensionRoot, 'extension');
    reapOrphanedFastTestRunnersOnStartup(statePath, extensionDir, log);
  } catch (err) {
    log(`startup orphan fast-test reaper failed (ignored): ${safeErrorMessage(err)}`);
  }

  try {
    runPipelineOrphanWorkerReap(statePath, path.join(getDataRoot(), 'sessions'), log);
  } catch (err) {
    log(`startup orphan worker-proc reaper failed (ignored): ${safeErrorMessage(err)}`);
  }

  if (
    ownerState.tmux_mode === true &&
    (ownerState.active !== true || ownerState.pid !== process.pid)
  ) {
    sm.update(statePath, s => {
      s.active = true;
      s.pid = process.pid;
    });
    clearExitReason(statePath);
    log(
      ownerState.active === true
        ? 'Session ownership refreshed (pid updated)'
        : 'Session ownership taken (active: false → true)',
    );
  }

  // Auto-spawn the 4-pane monitor window. Previously each pickle skill prompt
  // (pickle-tmux, pickle-pipeline, pickle-refine-prd, …) ended with a manual
  // `bash tmux-monitor.sh …` step that the agent sometimes dropped silently.
  // Owning it here makes it unskippable. No-op when not inside tmux.
  try {
    const result = ensureMonitorWindow({ sessionDir, extensionRoot, log });
    log(`ensureMonitorWindow: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
  } catch (err) {
    log(`ensureMonitorWindow: threw (ignored): ${safeErrorMessage(err)}`);
  }

  // R-PJV-2: one-shot package.json version drift detector.
  try {
    const srcPkgPath = path.join(ownerState.working_dir ?? '', 'extension', 'package.json');
    const depPkgPath = path.join(extensionRoot, 'extension', 'package.json');
    detectPkgJsonVersionDrift(srcPkgPath, depPkgPath, statePath);
  } catch (err) {
    log(`detectPkgJsonVersionDrift: threw (ignored): ${safeErrorMessage(err)}`);
  }

  // R-ICP-5: phantom-Done filesystem watcher (see startPhantomDoneWatchers).
  // Closed on SIGTERM/SIGINT/SIGHUP/exit so we don't leak file descriptors.
  const phantomDoneWatcher = startPhantomDoneWatchers({
    sessionDir,
    statePath,
    defaultWorkingDir: ownerState.working_dir || process.cwd(),
    log,
  });
  const closePhantomDoneWatchers = (): void => { phantomDoneWatcher.close(); };
  process.on('exit', closePhantomDoneWatchers);

  // Session-scoped codegraph (see createCodegraphSession). Built before signal handlers
  // so those closures can reference it; `init()` runs below, after registration.
  const codegraph = createCodegraphSession({
    statePath,
    sessionDir,
    workingDir: ownerState.working_dir || process.cwd(),
    log,
  });

  // Graceful shutdown (see installShutdownSignalHandlers) — deactivates the
  // session, stamps the B-RRH C2 sentinel, and closes the session-scoped handles
  // built above.
  installShutdownSignalHandlers({
    statePath,
    sessionDir,
    log,
    releaseSessionResources: () => {
      closePhantomDoneWatchers();
      codegraph.emitSummary();
      codegraph.close();
    },
  });

  // B4 (ticket e9bdac75): park survives --resume. If a persisted park-arm exists
  // with a still-future reset_at, RE-ARM the park (re-write rate_limit_wait.json so
  // the watchdogs see in_wait_state and no worker spawns) instead of clearing it.
  // Otherwise clean up a stale rate_limit_wait.json from a previous crashed session.
  const persistedPark = ownerState.rate_limit_park ?? null;
  const persistedReset = persistedPark?.reset_at_epoch_sec ?? null;
  const parkArmStillFuture = typeof persistedReset === 'number' && persistedReset > 0
    && persistedReset * 1000 > Date.now();
  if (parkArmStillFuture && persistedPark) {
    writeStateFile(path.join(sessionDir, 'rate_limit_wait.json'), {
      waiting: true, reason: 'API rate limit (re-armed on resume)',
      started_at: new Date().toISOString(),
      wait_until: new Date(persistedReset * 1000).toISOString(),
      consecutive_waits: persistedPark.consecutive_waits,
      rate_limit_type: null,
      resets_at_epoch: persistedReset,
      wait_source: 'api',
    });
    log(`Re-armed rate-limit park from persisted state (reset_at ${new Date(persistedReset * 1000).toISOString()}) — not spawn-burning.`);
  } else {
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    try { fs.unlinkSync(path.join(sessionDir, 'rate_limit_wait.json')); } catch { /* not present */ }
    if (persistedPark) {
      try { sm.update(statePath, (s) => { s.rate_limit_park = null; }); } catch { /* best-effort */ }
    }
  }

  const cbSettings = loadSettings(extensionRoot);
  const cbEnabled = cbSettings.enabled;
  let cbState: CircuitBreakerState | null = cbEnabled ? initCircuitBreaker(sessionDir, cbSettings) : null;
  const cbPath = path.join(sessionDir, 'circuit_breaker.json');
  const runnerSettingsBag = loadSettingsBag(extensionRoot, 'mux-runner:main:maxTurns');
  const runnerMaxTurns: number = positiveIntegerOrNull(runnerSettingsBag.default_tmux_max_turns)
    ?? positiveIntegerOrNull(runnerSettingsBag.default_manager_max_turns)
    ?? Defaults.MANAGER_MAX_TURNS;

  const { waitMinutes: rateLimitWaitMinutes, maxRetries: maxRateLimitRetries } = loadRateLimitSettings(extensionRoot);
  const { max_park_minutes: maxParkMinutes } = resolveRateLimitSettings(loadPickleSettingsBag(extensionRoot));

  const startTime = Date.now();
  let iteration = 0;
  let lastStateIteration = -1;
  let stallCount = 0;
  let consecutiveRateLimits = 0;
  let previousTicket: string | null = null;
  let previousTicketStartCommit: string | null = null;
  let exitReason: ExitReason;
  // Non-persisted per-ticket timeout counter (FR-B3/B4) — resets on runner restart.
  let timeoutCount = 0;
  let lastTimeoutTicket: string | null = null;
  // Artifact-progress snapshot for R-WTB-A1 no-progress window check.
  let lastArtifactProgressSnapshot: ArtifactProgressSnapshot = { latestMtimeEpoch: 0, latestCommitSha: null };
  // Commit-pending probe: track the last outer-loop iteration where state.iteration
  // advanced. Used to detect stagnation independently of the circuit breaker (the
  // probe runs whether CB is enabled or not).
  let lastProgressOuterIteration = 0;
  let lastObservedStateIteration = -1;
  // Settings bag for the commit-pending probe threshold (default 2). Read once
  // at startup; the loop is short-lived enough that hot-reloading isn't worth
  // the disk traffic.
  const probeSettings = loadSettingsBag(extensionRoot, 'mux-runner:commit-pending-probe:settings');
  const rawProbeThreshold = Number(probeSettings.commit_pending_probe_threshold);
  const commitPendingProbeThreshold =
    Number.isFinite(rawProbeThreshold) && rawProbeThreshold > 0 ? rawProbeThreshold : 2;
  // R-MWIS-2: main-loop idle-stall watchdog. lastProgressEpoch is bumped on every
  // forward-progress marker (iteration advance / state write, worker spawn). The
  // gated watchdog check before each worker spawn detects a wedged loop that is NOT
  // in any legitimate wait state and self-recovers instead of sitting at 0% CPU.
  const muxNow = (): number => Date.now();
  const idleStallThresholdSeconds = resolveIdleStallThresholdSeconds();
  // L2: bound consecutive idle-stall self-recoveries. A genuinely wedged loop that
  // re-arms the stall every pass must escalate instead of spinning forever; any
  // real forward progress resets the streak.
  const idleStallRecoveryCap = resolveIdleStallRecoveryCap();
  let idleStallRecoveryCount = 0;
  // Seeded so the watchdog never trips on a fresh loop; the iteration-advance write
  // (below) always refreshes it before the watchdog reads it each pass.
  // eslint-disable-next-line no-useless-assignment -- declaration-required seed; refreshed at iteration_start before any read
  let lastProgressEpoch = muxNow();
  // C6 (B-MRSW) CPU/artifact-liveness watchdog window anchors. Seeded per-ticket on
  // first observation; the delta is only evaluated once the window reaches the
  // idle-stall threshold. NOT persisted to state.json — pure loop-local liveness truth.
  let cpuLivenessTicketId: string | null = null;
  let cpuLivenessAnchorEpoch = 0;
  let cpuLivenessAnchorCpuSeconds: number | null = null;
  let cpuLivenessAnchorMtimeMs = 0;
  let readinessGateChecked = false;
  let ticketAuditGateChecked = false;
  let smokeGateBypassEmitted = false;
  let bundleBootstrapApplied = false;
  // WS-2c (R-PFNT): one-time target-toolchain pre-flight latch. Set after the first
  // pass so the cheap missing-node_modules probe runs ONCE per run, not per-iteration.
  let toolchainPreflightChecked = false;

  // Initialize the session-scoped codegraph (fail-open — never blocks session start).
  await codegraph.init();

  while (true) {
    let state: State;
    try {
      state = readRunnerState(statePath);
    } catch (err) {
      const decision = classifyCapCheckReadError(err, sessionDir, log);
      if (decision === 'continue') {
        await sleep(1000);
        continue;
      }
      exitReason = 'error';
      break;
    }

    if (state.active !== true) {
      log('Session inactive. Exiting.');
      exitReason = 'cancelled';
      break;
    }

    // WS-2c (R-PFNT): one-time target-toolchain pre-flight. If the target repo
    // declares a Node toolchain (package.json) but has NO node_modules, every worker
    // spawn churns ~30 Done/Skipped iterations of red gates before anyone notices.
    // Fail fast ONCE here with a distinct exit_reason instead. Conservative: only the
    // definite missing-toolchain signal trips this (see targetToolchainMissing).
    if (!toolchainPreflightChecked) {
      toolchainPreflightChecked = true;
      try {
        if (targetToolchainMissing(state.working_dir)) {
          const msg = `toolchain_unavailable: target repo '${state.working_dir}' has package.json but no installed node_modules — `
            + 'failing fast instead of churning iterations against a missing toolchain.';
          log(msg);
          process.stderr.write(`${msg}\n`);
          try {
            writeActivityEntry(statePath, {
              event: 'session_end',
              ts: new Date().toISOString(),
              reason: 'toolchain_unavailable',
              terminal_exit_reason: 'toolchain_unavailable',
              gate_payload: { working_dir: state.working_dir ?? null },
            } as unknown as ActivityLogEntry);
          } catch { /* best-effort */ }
          recordExitReason(statePath, 'toolchain_unavailable');
          safeDeactivate(statePath);
          exitReason = 'toolchain_unavailable';
          break;
        }
      } catch (err) {
        // Pre-flight is best-effort — never let a probe error abort a real run.
        log(`toolchain pre-flight skipped (ignored): ${safeErrorMessage(err)}`);
      }
    }

    state = clearStalePerTicketCacheAtIterationStart(statePath, state, log, sessionDir);
    // W4c (AC-W4c-1): re-assert the per-ticket no-progress cap from frontmatter
    // ground truth so a SET ticket can never reach the cap-check below with an
    // invalid cache (ticketMaxIter=0 → cap silently disabled → R-WMNP unbounded
    // respawn).
    state = repopulateNoProgressCapFromFrontmatter(statePath, state, log, sessionDir);

    // B-PXBO WS-3-FacetB: a crash-resume relaunch can inherit a `state.current_ticket`
    // that is ALREADY Done with a durable git commit. The per-ticket cap-check below
    // reads the inherited (spent) per-ticket cache keyed to that ticket and would flip
    // it Done->Failed (AC-CRSR-3 violation). Skip it BEFORE the cap-check reads the
    // stale persisted cache: clear the per-ticket cache via the EXISTING reset helper
    // (subtract — reuse `clearStaleTicketCacheFields`, do not add a new clearer) so the
    // cap-check sees no live ticket and `resolvePreTicket` re-routes to the next pending
    // ticket via `findNextPendingTicketId`. This does NOT widen `updateMuxLifecycleState`'s
    // ticketChanged trigger; the same-Done-ticket resume path clears here.
    if (
      typeof state.current_ticket === 'string'
      && state.current_ticket.length > 0
      && isResumedDoneWithDurableCommit(sessionDir, state.current_ticket, state.working_dir || process.cwd())
    ) {
      const skipTicket = state.current_ticket;
      log(`B-PXBO WS-3-FacetB: resumed current_ticket ${skipTicket} is Done with durable commit — skipping before per-ticket cap-check`);
      try {
        state = sm.update(statePath, s => {
          clearStaleTicketCacheFields(s);
        });
      } catch (err) {
        log(`B-PXBO WS-3-FacetB: cap-cache clear failed (ignored): ${safeErrorMessage(err)}`);
      }
    }

    const rawGlobalMaxIter = Number(state.max_iterations);
    const globalMaxIter = Number.isFinite(rawGlobalMaxIter) ? rawGlobalMaxIter : 0;
    const ticketCacheValid = isValidPerTicketCapCache(state);
    const ticketMaxIter = ticketCacheValid
      ? Number(state.current_ticket_max_iterations)
      : 0;
    const rawCurIter = Number(state.iteration);
    const curIter = Number.isFinite(rawCurIter) ? rawCurIter : 0;
    iteration = curIter;
    const budgetIter = ticketBudgetIterationCount(state, curIter);

    // R-ICP-1 + R-CNAR-1 part 2: two independent cap exits.
    //   (a) PER-TICKET budget exhaustion — current ticket isn't progressing
    //       within its tier ceiling (current_ticket_max_iterations).
    //   (b) GLOBAL manager-loop cap exhaustion — total iterations across all
    //       tickets reached operator-set state.max_iterations.
    // Both exit_reason='iteration_cap_exhausted' so pipeline-runner halts
    // (exit code 3, R-ICP-1 contract). Forensic-style deactivation preserves
    // step/current_ticket so postmortem can show the unfinished queue. The
    // `Max iterations reached ...` log line is retained as a stable marker
    // for grep-based forensics.
    //
    // R-CNAR-7 stale-cache guard: when state.current_ticket is null/undefined
    // but state.current_ticket_max_iterations carries a stale value from the
    // previously-completed ticket, the per-ticket cap-check would fire with
    // no ticket to attribute the exit to. This is the run-#6 attempt-1 trip:
    // a clean-success exit via finalizeTerminalState left max_iterations
    // populated; --resume re-entered the loop and the very first cap-check
    // tripped before any ticket started. Self-heal: emit
    // cap_check_skipped_stale_cache + clear the stale fields, continue.
    if (shouldEmitStalePerTicketCapSkip(state)) {
      log(stalePerTicketCacheDiagnostic(state));
      logActivity({
        event: 'cap_check_skipped_stale_cache',
        source: 'pickle',
        session: path.basename(sessionDir),
        iteration: curIter,
        gate_payload: {
          current_ticket: state.current_ticket,
          current_ticket_max_iterations: state.current_ticket_max_iterations,
          current_ticket_budget_start_iteration: state.current_ticket_budget_start_iteration,
          current_ticket_tier: state.current_ticket_tier,
        },
      });
    } else if (ticketMaxIter > 0 && budgetIter >= ticketMaxIter) {
      const tier = typeof state.current_ticket_tier === 'string' ? state.current_ticket_tier : 'unknown';
      const ticketId = state.current_ticket ?? 'unknown';
      log(`mux-runner exiting with code 3: per-ticket budget (${budgetIter}/${ticketMaxIter}, tier=${tier}) exhausted on ticket ${ticketId} without ${PromiseTokens.EPIC_COMPLETED} promise`);
      log(`Max iterations reached (${budgetIter}/${ticketMaxIter}). Exiting.`);
      recordExitReason(statePath, 'iteration_cap_exhausted');
      safeDeactivate(statePath);
      exitReason = 'iteration_cap_exhausted';
      break;
    }
    if (globalMaxIter > 0 && curIter >= globalMaxIter) {
      log(`mux-runner exiting with code 3: global iteration cap (${curIter}/${globalMaxIter}) exhausted without ${PromiseTokens.EPIC_COMPLETED} promise`);
      log(`Max iterations reached (${curIter}/${globalMaxIter}). Exiting.`);
      recordExitReason(statePath, 'iteration_cap_exhausted');
      safeDeactivate(statePath);
      exitReason = 'iteration_cap_exhausted';
      break;
    }

    const rawStartEpoch = Number(state.start_time_epoch);
    const startEpoch = Number.isFinite(rawStartEpoch) ? rawStartEpoch : 0;
    const rawMaxTimeMins = Number(state.max_time_minutes);
    const maxTimeMins = Number.isFinite(rawMaxTimeMins) ? rawMaxTimeMins : 0;
    const elapsed = startEpoch > 0 ? Math.max(0, Math.floor(Date.now() / 1000) - startEpoch) : 0;
    if (maxTimeMins > 0 && startEpoch > 0 && elapsed >= maxTimeMins * 60) {
      log(`Time limit reached (${elapsed}s). Exiting.`);
      finalizeTerminalState(statePath, { step: 'completed', runnerIteration: iteration, exitReason: 'limit' });
      exitReason = 'limit';
      break;
    }

    // Circuit breaker gate: if CB is OPEN, exit immediately
    if (cbEnabled && cbState && !canExecute(cbState)) {
      log(`Circuit breaker OPEN: ${cbState.reason}. Exiting.`);
      recordExitReason(statePath, 'circuit_open');
      safeDeactivate(statePath);
      exitReason = 'circuit_open';
      break;
    }

    // Stall detection fallback (only when CB is disabled)
    if (!cbEnabled) {
      if (curIter === lastStateIteration) {
        stallCount++;
        if (stallCount >= 2) { // Stall threshold only consulted when !cbEnabled; CB-enabled sessions use CB's own progress threshold
          log(`WARNING: state.iteration has not advanced in 2 outer-loop iterations (stuck at ${state.iteration}). Exiting to avoid wasted API calls.`);
          recordExitReason(statePath, 'stall');
          safeDeactivate(statePath);
          exitReason = 'stall';
          break;
        }
      } else {
        stallCount = 0;
      }
      lastStateIteration = curIter;
    }

    iteration = curIter + 1;
    {
      const checkState = readRunnerState(statePath);
      const checkDir = checkState.working_dir || process.cwd();
      if (checkHeadPinMismatch(checkState, checkDir, sessionDir, statePath, log)) {
        exitReason = 'working_tree_modified_externally';
        break;
      }
    }
    correctPhantomDoneTickets({
      sessionDir,
      workingDir: state.working_dir || process.cwd(),
      startCommit: state.start_commit || null,
      iteration,
      flags: state.flags,
      log,
    });
    const preTicket = resolvePreTicket(sessionDir, state.current_ticket, state.working_dir || process.cwd());
    const preStep = inferTicketLifecycleStep(sessionDir, preTicket, state.step);
    if (preTicket) {
      // R-RMBS-3: emit per-iteration runnability decision for observability.
      // Frontmatter status is the authoritative source — runnable means status is
      // Todo or In Progress (per isPendingMuxTicket).
      try {
        const frontmatterStatus = getTicketStatus(sessionDir, preTicket);
        const normalized = normalizeTicketStatus(frontmatterStatus);
        const runnable = normalized !== 'done' && normalized !== 'skipped';
        const reasonSource = state.current_ticket === preTicket ? 'state_current_ticket' : 'frontmatter_pending';
        logActivity({
          event: 'ticket_runnability_resolved',
          source: 'pickle',
          session: path.basename(sessionDir),
          ticket_id: preTicket,
          gate_payload: {
            frontmatter_status: frontmatterStatus ?? null,
            runnable,
            reason: reasonSource,
          },
        });
      } catch { /* best-effort */ }
      // R-REIN: refund the per-ticket recovery budget when the operator has explicitly
      // reset this ticket's frontmatter status back to Todo. Without this, the spent
      // `bounded_terminal_escape` ledger entries survive the reset and force the ticket
      // terminal again on its first no-progress relaunch — re-exiting `recovery_exhausted`
      // in ~2s and making the documented "reset to Todo + relaunch" recovery INERT. The
      // helper is conservative (no-op unless frontmatter is Todo AND spent attempts exist).
      refundRecoveryBudgetOnReset(statePath, sessionDir, preTicket, iteration, log);
    }
    state = updateMuxLifecycleState(statePath, { iteration, currentTicket: preTicket, step: preStep });
    // R-MWIS-2: iteration advance + state write is a forward-progress marker.
    lastProgressEpoch = muxNow();
    state = reconcileTicketStateDesync(statePath, sessionDir, state.current_ticket || null, iteration, log);
    state = sm.update(statePath, s => {
      applyTicketTierBudget(s, sessionDir);
    });
    {
      const closerDecision = evaluateCloserTerminalState({
        state,
        sessionDir,
        workingDir: state.working_dir || process.cwd(),
        headSha: observeCurrentHead(state.working_dir || process.cwd())?.sha ?? null,
        failedBudget: readCloserHandoffBudget(extensionRoot),
      });
      if (closerDecision.action === 'exit') {
        // R-ORSR-2: intercept the closer_handoff_terminal park with the recovery
        // ladder. manager_handoff_pending is operator-gated and never recovered.
        if (closerDecision.reason === 'closer_handoff_terminal') {
          // AC-2 fail-safe: missing working_dir must halt this git-mutating
          // recovery call, never fall back to process.cwd() (the real repo).
          if (!state.working_dir) {
            recordExitReason(statePath, 'state_working_dir_missing');
            safeDeactivate(statePath);
            exitReason = 'state_working_dir_missing';
            break;
          }
          const recovery = routeRecoveryBeforeTerminal({
            sessionDir,
            statePath,
            extensionRoot,
            workingDir: state.working_dir,
            ticketId: state.current_ticket || '',
            iteration,
            flags: (state.flags as Record<string, unknown> | undefined) ?? null,
            log,
            mode: 'manager',
          });
          if (recovery.kind === 'advanced') {
            log(`recovery: ${recovery.strategy} advanced ${state.current_ticket} before closer_handoff_terminal — continuing.`);
            persistCloserHandoffTracker(statePath, null);
            lastStateIteration = -1;
            stallCount = 0;
            state = readRunnerState(statePath);
            continue;
          }
          if (recovery.kind === 'exhausted') {
            log(`recovery_exhausted: ladder exhausted for ${state.current_ticket} (${recovery.reason}). Exiting at iteration ${iteration}.`);
            writeRecoveryHandoffArtifact(sessionDir, state.current_ticket ?? null, `closer_handoff_terminal: ${recovery.reason}`, log);
            recordExitReason(statePath, 'recovery_exhausted');
            safeDeactivate(statePath);
            removeRunnerSessionMapEntry(statePath, log);
            exitReason = 'recovery_exhausted';
            break;
          }
          // fall_through → existing closer terminal park.
        }
        exitReason = exitForCloserTerminalState(statePath, sessionDir, iteration, closerDecision, log);
        break;
      }
      persistCloserHandoffTracker(statePath, closerDecision.tracker);
      state = readRunnerState(statePath);
    }
    if (previousTicket === null) {
      previousTicket = state.current_ticket || null;
      if (previousTicket) {
        const ticketInfo = collectTickets(sessionDir).find(t => t.id === previousTicket);
        previousTicketStartCommit = readHeadCommit(ticketInfo?.working_dir || state.working_dir || process.cwd());
      }
    }
    // R-CCPM-3: orphan-session detection at iteration boundary
    try {
      const dataRoot = getDataRoot();
      const orphans = detectOrphanSessions(state, dataRoot, sessionDir);
      if (orphans.length > 0) {
        state = sm.update(statePath, s => {
          if (!Array.isArray(s.orphans_detected)) s.orphans_detected = [];
          for (const orphan of orphans) {
            const basename = path.basename(orphan.orphan_session_path);
            if (!s.orphans_detected.includes(basename)) {
              s.orphans_detected.push(basename);
            }
          }
        });
        for (const orphan of orphans) {
          logActivity({
            event: 'orphan_session_detected',
            source: 'pickle',
            session: path.basename(sessionDir),
            orphan_session_path: orphan.orphan_session_path,
            orphan_started_at: orphan.orphan_started_at,
            parent_session_hash: orphan.parent_session_hash,
            orphan_pid: orphan.orphan_pid,
          });
        }
      }
    } catch (err) {
      log(`orphan detection error (ignored): ${safeErrorMessage(err)}`);
    }

    log(`--- Iteration ${iteration} (state.iteration=${state.iteration}) ---`);
    logActivity({ event: 'iteration_start', source: 'pickle', session: path.basename(sessionDir), iteration, backend: resolveBackend(state) });

    try {
      reapOrphanedManagersAtIterationStart(statePath, sessionDir, log);
    } catch (err) {
      log(`orphan manager reaper failed (ignored): ${safeErrorMessage(err)}`);
    }

    try {
      runPipelineOrphanWorkerReap(statePath, path.join(getDataRoot(), 'sessions'), log);
    } catch (err) {
      log(`iteration-start orphan worker-proc reaper failed (ignored): ${safeErrorMessage(err)}`);
    }

    if (applyAllTicketsDoneCompletion(statePath, sessionDir, iteration, log, state.working_dir || '')) {
      exitReason = 'success';
      break;
    }

    // L5: all-terminal short-circuit. `applyAllTicketsDoneCompletion` only fires
    // when every ticket is Done; it does NOT catch the all-terminal-Failed case
    // (e.g. every pending ticket flipped oversized_no_progress). When `preTicket`
    // resolved to null AND no runnable ticket remains, exit CLEANLY here rather
    // than entering `runIteration` with a null ticket (which spawns a manager with
    // no work and re-arms the idle-stall watchdog every pass). Matches the all-Done
    // clean-deactivation pattern but with a distinct, non-failure exit reason.
    if (!preTicket && noRunnableTicketsRemain(sessionDir)) {
      // W4b empty-roster resolution: all-Done already exited above via
      // applyAllTicketsDoneCompletion (→ completion). Reaching here means the
      // roster is all-Failed with no runnable Todo — the honest ladder terminal
      // `recovery_exhausted` (single CUJ-1 entry state, ∈ isFailureExit so
      // auto-resume.sh stops).
      log('empty roster (all-Failed, no runnable ticket) — honest terminal recovery_exhausted before runIteration.');
      writeRecoveryHandoffArtifact(sessionDir, null, 'empty_roster_all_failed_no_runnable', log);
      recordExitReason(statePath, 'recovery_exhausted');
      safeDeactivate(statePath);
      removeRunnerSessionMapEntry(statePath, log);
      exitReason = 'recovery_exhausted';
      break;
    }

    // R-BUNDLE-1 / W1a: bundle bootstrap mode — auto-apply the quality-gate skip
    // exemption for allowlisted sessions. Updates local state.flags so the
    // readiness + ticket-audit gate checks below read the derived skip reason.
    // W1a: writes ONLY the unified `skip_quality_gates_reason` (the single
    // operator-facing quality-gate bypass surface). Conflict-resolution rule: an
    // existing non-empty `skip_quality_gates_reason` WINS over the derived
    // reason (operator intent preserved).
    if (!bundleBootstrapApplied && curIter === 0) {
      bundleBootstrapApplied = true;
      const bootstrapMode = typeof state.flags?.bundle_bootstrap_mode === 'string'
        ? (state.flags.bundle_bootstrap_mode as string)
        : null;
      if (bootstrapMode !== null && BUNDLE_BOOTSTRAP_ALLOWLIST[bootstrapMode]?.has(path.basename(sessionDir))) {
        const derivedReason = `bundle_bootstrap_mode=${bootstrapMode}`;
        const existingFlags = state.flags ?? {};
        const existingUnified = typeof existingFlags.skip_quality_gates_reason === 'string'
          ? existingFlags.skip_quality_gates_reason.trim()
          : '';
        const skipQualityGatesReason = existingUnified.length > 0 ? existingUnified : derivedReason;
        state = { ...state, flags: { ...existingFlags, skip_quality_gates_reason: skipQualityGatesReason } };
        logActivity({
          event: 'bundle_bootstrap_exemption_applied',
          source: 'pickle',
          session: path.basename(sessionDir),
          gate_payload: {
            bundle_id: bootstrapMode,
            skip_quality_gates_reason: skipQualityGatesReason,
          },
        });
        log(`bundle bootstrap mode applied: ${bootstrapMode} — quality gates auto-skipped via skip_quality_gates_reason for session ${path.basename(sessionDir)}`);
      }
    }

    if (!readinessGateChecked && curIter === 0) {
      readinessGateChecked = true;
      const skipReason = resolveQualityGateSkipReason(
        state,
        log,
        path.basename(sessionDir),
        'readiness_gate',
      ).reason;
      const readinessStatus = runMuxReadinessGate({
        sessionDir,
        repoRoot: state.working_dir || process.cwd(),
        extensionRoot,
        log,
        skipReason,
      });
      if (readinessStatus !== 0) {
        // R-GATE-ADVISORY: the readiness gate is ADVISORY, not blocking. Its
        // contract/path/symbol checks are heuristic pre-build validations that
        // historically false-blocked legitimate bundles (R-RTRC reached a 5th
        // recurrence; R-ATBG is the "guard around a brittle guard" archetype) and
        // forced a large band-aid surface (forward-ref annotation grammar,
        // allowlists, carve-outs, the skip flag). A genuinely-bad path fails the
        // BUILD itself, and the review phases catch the rest — so log + proceed,
        // never halt an autonomous run on a heuristic pre-flight.
        log(`readiness advisory: check-readiness exited ${readinessStatus} — findings logged, NOT halting (advisory gate)`);
      }
    }

    // R-TAQ-3: ticket audit gate (slot: readiness → ticket-audit → spawn).
    // Runs once on iteration-0 after readiness gate exits 0.
    if (!ticketAuditGateChecked && curIter === 0) {
      ticketAuditGateChecked = true;
      const skipAuditReason = resolveQualityGateSkipReason(
        state,
        log,
        path.basename(sessionDir),
        'ticket_audit_gate',
      ).reason;
      const auditResult = runTicketAuditGate({
        sessionDir,
        extensionRoot,
        log,
        skipReason: skipAuditReason,
      });
      if (auditResult.status === 'bypassed') {
        logActivity({
          event: 'ticket_audit_bypassed',
          source: 'pickle',
          session: path.basename(sessionDir),
          reason: auditResult.reason,
        });
      } else if (auditResult.status === 'failed') {
        // R-GATE-ADVISORY: ticket-audit is ADVISORY, not blocking (see the readiness
        // gate above). Its path-drift/cross-doc-naming heuristics false-blocked
        // legitimate bundles at iteration 0 (e.g. a `file.ts:symbol` token mis-read
        // as a missing path → fatal). The findings stay logged for the operator, but
        // a defective bundle surfaces at the build/review phases — not by silently
        // killing the run before any work. Log + proceed, never halt.
        log(`ticket audit advisory: audit-ticket-bundle exited ${auditResult.exitCode} — findings logged, NOT halting (advisory gate)`);
      }
    }

    // Multi-repo advisory check (once, on first iteration)
    if (iteration === 1) {
      const multiRepoDirs = detectMultiRepo(sessionDir, state.working_dir || process.cwd());
      if (multiRepoDirs) {
        log(`⚠️  MULTI-REPO DETECTED: Tickets span [${multiRepoDirs.join(', ')}]. Pickle Rick works best with single-repo sessions.`);
        logActivity({ event: 'multi_repo_warning', source: 'pickle', session: path.basename(sessionDir) });
      }
    }

    // Update outer-loop progress tracker for the commit-pending probe.
    // First observation seeds both fields so a fresh session never trips
    // the probe at iteration 1 from the default zero-init.
    if (lastObservedStateIteration < 0) {
      lastObservedStateIteration = curIter;
      lastProgressOuterIteration = iteration;
    } else if (curIter > lastObservedStateIteration) {
      lastObservedStateIteration = curIter;
      lastProgressOuterIteration = iteration;
    }

    // Pre-spawn commit-pending health probe (codex-only). RCA: codex
    // sometimes produces edits but never `git add` + `git commit`; if
    // stagnation persists past the threshold, nudge the next worker turn
    // to commit + signal Done so the breaker doesn't strand orphan work.
    try {
      const probeBackend = resolveBackend(state);
      const probeWorkingDir = state.working_dir || process.cwd();
      const probeResult = commitPendingProbe({
        sessionDir,
        workingDir: probeWorkingDir,
        backend: probeBackend,
        iteration,
        lastProgressIteration: lastProgressOuterIteration,
        threshold: commitPendingProbeThreshold,
        pid: process.pid,
        log,
      });
      if (probeResult === 'fired') {
        logActivity({
          event: 'commit_pending_probe_fired',
          source: 'pickle',
          session: path.basename(sessionDir),
          iteration,
        });
      }
    } catch (err) {
      // Probe is best-effort — never block the iteration on probe failure.
      log(`commit-pending probe threw (ignored): ${safeErrorMessage(err)}`);
    }

    // R-CNAR-6: spark codex smoke-run gate. Active only when state.backend='codex'
    // AND state.codex_model matches /^gpt-5\.3-codex-spark/. Halt exits with
    // exit_reason='codex_unhealthy_consecutive_failures'; auto-resume.sh STOPS per
    // R-CNAR-4(c) (any non-pipeline_phase_incomplete exit halts the resume loop).
    {
      const smokeDecision = evaluateSparkSmokeGate(state, sessionDir);
      if (smokeDecision.action === 'bypass' && !smokeGateBypassEmitted) {
        smokeGateBypassEmitted = true;
        log(`spark smoke gate bypassed: ${smokeDecision.reason}`);
        logActivity({
          event: 'smoke_gate_bypassed',
          source: 'pickle',
          session: path.basename(sessionDir),
          reason: smokeDecision.reason,
        });
      }
      if (smokeDecision.action === 'halt') {
        log(`SMOKE GATE HALT: ${smokeDecision.reason} (rule=${smokeDecision.rule})`);
        logActivity({
          event: 'codex_unhealthy_consecutive_failures',
          source: 'pickle',
          session: path.basename(sessionDir),
          reason: smokeDecision.reason,
        });
        recordExitReason(statePath, 'codex_unhealthy_consecutive_failures');
        safeDeactivate(statePath);
        exitReason = 'codex_unhealthy_consecutive_failures';
        break;
      }
    }

    // R-AISLOW: pre-spawn already-terminal check. If state.current_ticket is
    // already Done/Skipped (can happen when a prior iteration or manager turn
    // completed the ticket but state.current_ticket wasn't cleared yet), skip
    // the manager spawn and advance current_ticket to the next pending ticket.
    // This avoids wasted 1h+ manager turns that just log "already Done, skipping".
    {
      const preskipTicket = state.current_ticket;
      if (preskipTicket) {
        let preskipStatus: string | null = null;
        try {
          preskipStatus = normalizeTicketStatus(getTicketStatus(sessionDir, preskipTicket));
        } catch { /* unreadable frontmatter — fall through to normal spawn path */ }
        if (preskipStatus === 'done' || preskipStatus === 'skipped') {
          const nextPending = findNextPendingTicketId(sessionDir);
          log(`[preskip] ${preskipTicket} already ${preskipStatus} — advancing to ${nextPending ?? 'none'} without manager spawn`);
          logActivity({
            event: 'ticket_preskipped_already_terminal',
            source: 'pickle',
            session: path.basename(sessionDir),
            iteration,
            ticket_id: preskipTicket,
            gate_payload: {
              frontmatter_status: preskipStatus,
              next_ticket_id: nextPending ?? null,
            },
          });
          // Advance via sanctioned state-write path; state re-read at top of next loop iteration
          updateMuxLifecycleState(statePath, { currentTicket: nextPending ?? null });
          continue; // skip runIteration — no manager spawn
        }
      }
    }

    // R-MWIS-2: main-loop idle-stall watchdog. Before each worker spawn, check whether
    // the loop has made no forward progress for longer than the bounded threshold while
    // in NO legitimate wait state (rate-limit wait, breaker OPEN, last_error, subprocess
    // errors). If wedged, emit a diagnostic event and self-recover (re-evaluate the
    // current ticket / re-spawn) rather than sit silently at 0% CPU.
    try {
      const idleDecision = evaluateMuxIdleStallWatchdog({
        active: state.active === true,
        nowMs: muxNow(),
        lastProgressMs: lastProgressEpoch,
        thresholdSeconds: idleStallThresholdSeconds,
        // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
        rateLimitWaiting: fs.existsSync(path.join(sessionDir, 'rate_limit_wait.json')),
        circuitBreakerExecutable: !cbEnabled || !cbState || canExecute(cbState),
        lastError: state.last_error ?? null,
        // mux state.json carries last_subprocess_error (ErrorRecord|null), the
        // worker-error wait-state signal; treat a present record as 1 accumulated error.
        consecutiveSubprocessErrors: state.last_subprocess_error != null ? 1 : 0,
      });
      if (idleDecision.stalled) {
        // L2: bound consecutive self-recoveries. The streak increments per stall;
        // a single recovery that clears the wedge advances the loop (resetting the
        // streak), but a loop that re-arms the stall every pass climbs the streak
        // and escalates once it exceeds the cap rather than spinning forever.
        idleStallRecoveryCount += 1;
        if (evaluateIdleStallRecoveryCap(idleStallRecoveryCount, idleStallRecoveryCap)) {
          // W4a: route the idle-stall escalation through the single choke point before
          // the terminal `idle_stall_unrecoverable` park. A ladder-advanced ticket
          // resets the streak and continues; only fall_through / exhausted parks.
          // AC-2 fail-safe: never run the git-mutating recovery against process.cwd().
          if (state.current_ticket && state.working_dir) {
            const recovery = routeRecoveryBeforeTerminal({
              sessionDir,
              statePath,
              extensionRoot,
              workingDir: state.working_dir,
              ticketId: state.current_ticket,
              iteration,
              flags: (state.flags as Record<string, unknown> | undefined) ?? null,
              log,
              mode: 'worker',
              evidence: { halt_site: 'idle_stall_unrecoverable', idle_seconds: idleDecision.idleSeconds },
            });
            if (recovery.kind === 'advanced') {
              log(`recovery: ${recovery.strategy} advanced ${state.current_ticket} before idle_stall_unrecoverable — continuing.`);
              idleStallRecoveryCount = 0;
              lastStateIteration = -1;
              stallCount = 0;
              lastProgressEpoch = muxNow();
              continue;
            }
          }
          const msg = `[idle-stall] self-recovery exceeded cap (${idleStallRecoveryCount} > ${idleStallRecoveryCap}) — escalating idle_stall_unrecoverable at iteration ${iteration}`;
          log(msg);
          process.stderr.write(`[mux-runner] ${msg}\n`);
          recordExitReason(statePath, 'idle_stall_unrecoverable');
          safeDeactivate(statePath);
          removeRunnerSessionMapEntry(statePath, log);
          exitReason = 'idle_stall_unrecoverable';
          break;
        }
        log(`[idle-stall] no forward progress for ${idleDecision.idleSeconds}s (>= ${idleStallThresholdSeconds}s) with clean wait-state — emitting mux_idle_stall_detected and self-recovering (attempt ${idleStallRecoveryCount}/${idleStallRecoveryCap})`);
        process.stderr.write(`[mux-runner] idle-stall watchdog: ${idleDecision.idleSeconds}s idle, re-evaluating current ticket\n`);
        logActivity({
          event: 'mux_idle_stall_detected',
          source: 'pickle',
          session: path.basename(sessionDir),
          iteration,
          gate_payload: {
            threshold_seconds: idleStallThresholdSeconds,
            idle_seconds: idleDecision.idleSeconds,
            observed_iteration: curIter,
            current_ticket: state.current_ticket ?? null,
            step: typeof state.step === 'string' ? state.step : 'unknown',
          },
        });
        // R-MWIS-3: before self-recovering past the current ticket, commit any
        // gate-passing uncommitted deliverable via the existing #99 R-WCUC path so
        // the re-select/relaunch below cannot strand completed work.
        // AC-2 fail-safe: missing working_dir must halt this git-mutating commit,
        // never fall back to process.cwd() (the real repo).
        if (!state.working_dir) {
          recordExitReason(statePath, 'state_working_dir_missing');
          safeDeactivate(statePath);
          exitReason = 'state_working_dir_missing';
          break;
        }
        routeExitPathSalvage({
          sessionDir,
          statePath,
          workingDir: state.working_dir,
          ticketId: state.current_ticket ?? null,
          extensionRoot,
          flags: (state.flags as Record<string, unknown> | undefined) ?? null,
          log,
        });
        // Self-recovery: re-evaluate the current ticket so the next pass re-selects a
        // pending ticket and re-spawns a worker. Reset the stall trackers + progress
        // epoch so the watchdog re-arms cleanly. Mirrors the recovery-advanced reset.
        const nextPending = findNextPendingTicketId(sessionDir);
        updateMuxLifecycleState(statePath, { currentTicket: nextPending ?? null });
        lastStateIteration = -1;
        stallCount = 0;
        lastProgressEpoch = muxNow();
        continue;
      }
    } catch (err) {
      // Watchdog is best-effort — never crash the loop on a watchdog failure.
      log(`idle-stall watchdog threw (ignored): ${safeErrorMessage(err)}`);
    }

    // C6 (B-MRSW): CPU/artifact liveness watchdog. The idle-stall watchdog above keys on
    // `lastProgressMs`, which a `/login` re-auth keeps falsely fresh; this complement keys
    // on the worker's CPU-time delta + artifact-mtime advance (output recency is irrelevant).
    // A worker alive but accruing <5s CPU over the window with no new artifact mtime is wedged
    // — route to the C7 conformance-present salvage. Best-effort; never crash the loop.
    try {
      const cpuTicket = state.current_ticket ?? null;
      // Re-anchor the window whenever the active ticket changes (per-ticket liveness).
      if (cpuTicket !== cpuLivenessTicketId) {
        cpuLivenessTicketId = cpuTicket;
        cpuLivenessAnchorEpoch = cpuTicket ? muxNow() : 0;
        cpuLivenessAnchorCpuSeconds = cpuTicket ? sampleWorkerCpuSeconds(resolveCurrentWorkerPid(sessionDir, cpuTicket) ?? -1) : null;
        cpuLivenessAnchorMtimeMs = cpuTicket ? latestTicketArtifactMtimeMs(sessionDir, cpuTicket) : 0;
      } else if (cpuTicket) {
        const windowSeconds = Math.floor((muxNow() - cpuLivenessAnchorEpoch) / 1000);
        const workerPid = resolveCurrentWorkerPid(sessionDir, cpuTicket);
        const nowCpuSeconds = workerPid != null ? sampleWorkerCpuSeconds(workerPid) : null;
        const nowMtimeMs = latestTicketArtifactMtimeMs(sessionDir, cpuTicket);
        // Only evaluate a full window; seed the CPU anchor lazily if the first sample failed.
        if (cpuLivenessAnchorCpuSeconds == null && nowCpuSeconds != null) {
          cpuLivenessAnchorCpuSeconds = nowCpuSeconds;
          cpuLivenessAnchorEpoch = muxNow();
          cpuLivenessAnchorMtimeMs = nowMtimeMs;
        } else if (windowSeconds >= idleStallThresholdSeconds && cpuLivenessAnchorCpuSeconds != null && nowCpuSeconds != null) {
          const cpuDecision = evaluateCpuLivenessWatchdog({
            active: state.active === true,
            workerAlive: workerPid != null && isProcessAlive(workerPid),
            cpuSecondsDelta: nowCpuSeconds - cpuLivenessAnchorCpuSeconds,
            windowSeconds,
            cpuFloorSeconds: DEFAULT_CPU_LIVENESS_FLOOR_SECONDS,
            artifactMtimeAdvanced: nowMtimeMs > cpuLivenessAnchorMtimeMs,
            // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
            rateLimitWaiting: fs.existsSync(path.join(sessionDir, 'rate_limit_wait.json')),
            circuitBreakerExecutable: !cbEnabled || !cbState || canExecute(cbState),
            lastError: state.last_error ?? null,
            consecutiveSubprocessErrors: state.last_subprocess_error != null ? 1 : 0,
          });
          if (cpuDecision.stalled) {
            log(`[cpu-liveness] worker ${workerPid} alive but accrued ${cpuDecision.cpuSecondsDelta}s CPU over ${windowSeconds}s (< ${DEFAULT_CPU_LIVENESS_FLOOR_SECONDS}s) with no artifact-mtime advance — wedged at 0% CPU despite fresh output`);
            process.stderr.write(`[mux-runner] cpu-liveness watchdog: worker ${workerPid} wedged (CPU stall) on ${cpuTicket}\n`);
            logActivity({
              event: 'mux_idle_stall_detected',
              source: 'pickle',
              session: path.basename(sessionDir),
              iteration,
              gate_payload: {
                threshold_seconds: idleStallThresholdSeconds,
                idle_seconds: windowSeconds,
                observed_iteration: curIter,
                current_ticket: cpuTicket,
                step: typeof state.step === 'string' ? state.step : 'unknown',
                liveness: 'cpu',
                cpu_seconds_delta: cpuDecision.cpuSecondsDelta,
                cpu_floor_seconds: DEFAULT_CPU_LIVENESS_FLOOR_SECONDS,
              },
            });
            // AC-2 fail-safe: a git-mutating commit MUST have an explicit working_dir,
            // never fall back to process.cwd() (the real repo).
            if (!state.working_dir) {
              recordExitReason(statePath, 'state_working_dir_missing');
              safeDeactivate(statePath);
              exitReason = 'state_working_dir_missing';
              break;
            }
            // C7: salvage ONLY when the conformance-complete set is present (graded
            // =conformance). The committer runs the armed gate TO COMPLETION (never
            // infers from a stale artifact mtime) and commits reset-proof with an
            // explicit completion_commit. INCOMPLETE set → DO NOT auto-commit; wait.
            if (gradeConformanceComplete(sessionDir, cpuTicket)) {
              routeExitPathSalvage({
                sessionDir,
                statePath,
                workingDir: state.working_dir,
                ticketId: cpuTicket,
                extensionRoot,
                flags: (state.flags as Record<string, unknown> | undefined) ?? null,
                log,
              });
            } else {
              log(`[cpu-liveness] ticket ${cpuTicket}: conformance set INCOMPLETE — not auto-committing (waiting/escalating instead)`);
            }
            // Self-recover identically to the idle-stall path: re-select a pending ticket,
            // reset the stall + progress trackers, and re-anchor the CPU window.
            const nextPending = findNextPendingTicketId(sessionDir);
            updateMuxLifecycleState(statePath, { currentTicket: nextPending ?? null });
            lastStateIteration = -1;
            stallCount = 0;
            lastProgressEpoch = muxNow();
            cpuLivenessTicketId = null;
            cpuLivenessAnchorCpuSeconds = null;
            continue;
          }
        }
      }
    } catch (err) {
      log(`cpu-liveness watchdog threw (ignored): ${safeErrorMessage(err)}`);
    }

    // Per-spawn codegraph staleness sync (fail-open — bounded by sync_timeout_ms in the service).
    await codegraph.syncIfStale();

    const iterWorkingDir = state.working_dir || process.cwd();
    const preIterSha = readHeadCommit(iterWorkingDir);
    // 90574654: iteration-window start — freshness base for silent-death salvage probes.
    const iterStartMs = Date.now();
    // R-WSWA-2: snapshot the per-ticket review/conformance artifact count BEFORE the
    // worker spawn; the AFTER snapshot + delta persistence happen once it exits.
    const apTicketId = state.current_ticket || null;
    // AC-A4 (B-RRH): a large-tier ticket's first N spawns credit early-phase
    // (research/plan) artifacts as progress. Compute the flag from the PRIOR
    // per-ticket spawn_count so the BEFORE/AFTER counts use the same prefix set.
    const apPriorSpawnCount = (apTicketId && state.worker_artifact_progress?.[apTicketId]?.spawn_count) || 0;
    const apCreditEarlyPhases = apTicketId
      ? resolveCreditEarlyPhases(sessionDir, apTicketId, apPriorSpawnCount, resolveWmwEarlyPhaseK())
      : false;
    const apBeforeCount = apTicketId ? countWorkerArtifacts(path.join(sessionDir, apTicketId), { creditEarlyPhases: apCreditEarlyPhases }) : 0;

    // B-WSPU WS-1: all tiers route through the single synchronous spawn path.
    const outcome: Awaited<ReturnType<typeof runIteration>> =
      await runIteration(sessionDir, iteration, extensionRoot).catch(
        (err: unknown): Awaited<ReturnType<typeof runIteration>> => {
          const msg = err instanceof Error ? err.message : String(err);
          log(`runIteration threw (treating as spawn error): ${msg}`);
          process.stderr.write(`[mux-runner] runIteration threw: ${msg}\n`);
          return { completion: 'error', timedOut: false, exitCode: null, wallSeconds: 0 } as Awaited<ReturnType<typeof runIteration>>;
        }
      );
    const result = outcome.completion;

    // R-MWIS-3: worker-exit path. A silent/0-byte worker exit may leave a
    // gate-passing deliverable uncommitted in the tree; route it through the
    // existing #99 R-WCUC commit path BEFORE the loop advances (a clean-tree
    // relaunch would otherwise discard it). No-op when the tree is clean, the gate
    // is red, or the model already flipped the ticket terminal.
    // AC-2 fail-safe: missing working_dir must halt this git-mutating commit,
    // never fall back to process.cwd() (the real repo). The guard sits OUTSIDE
    // the best-effort try so the break targets the main loop (a break inside the
    // try would still target the loop, but the catch must not swallow the halt).
    if (!state.working_dir) {
      recordExitReason(statePath, 'state_working_dir_missing');
      safeDeactivate(statePath);
      exitReason = 'state_working_dir_missing';
      break;
    }
    try {
      const exitCommit = routeExitPathSalvage({
        sessionDir,
        statePath,
        workingDir: state.working_dir,
        ticketId: previousTicket,
        extensionRoot,
        flags: (state.flags as Record<string, unknown> | undefined) ?? null,
        log,
      });
      if (exitCommit.committed) {
        lastProgressEpoch = muxNow();
        // L2: a committed deliverable is genuine forward progress — reset the streak.
        idleStallRecoveryCount = 0;
      }
    } catch { /* best-effort — never block iteration on exit-path commit */ }

    // AC-A5 (B-RRH): a rate-limited spawn (rate_limit_wait.json present OR the
    // iteration log shows a 429) OR a spawn within breaker-recovery grace must NOT
    // increment the no-progress counter (B-RLAR-D2 429-spawn counter poisoning).
    // Fail-open: any probe error → not suppressed.
    let apSuppressIncrement = false;
    try {
      const apRateLimited =
        // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking probe (mirrors the rate_limit_wait check above)
        fs.existsSync(path.join(sessionDir, 'rate_limit_wait.json'))
        || detectRateLimitInLog(path.join(sessionDir, `tmux_iteration_${iteration}.log`)).limited;
      const apBreakerGrace = isWithinBreakerRecoveryGrace(
        cbState,
        resolveHardeningSettings(loadPickleSettingsBag(extensionRoot)).breaker_recovery_grace_seconds,
        Date.now(),
      );
      apSuppressIncrement = apRateLimited || apBreakerGrace;
    } catch { /* best-effort — never block iteration on rate-limit/breaker probing */ }

    // R-WSWA-2: persist the post-spawn artifact-count delta and emit
    // worker_artifact_progress_zero at exactly K consecutive zero-delta spawns.
    // AC-A3 (B-RRH): scope the source-tree signature to scope.json:allowed_paths so a
    // peer session's dirty prds/ file is absent from the signature (B-HRPW).
    let apProgressResult: { spawnCount: number; lastArtifactCount: number; zeroProgressCount: number; fired: boolean; doneGuard: boolean; incrementSuppressed: boolean } | null = null;
    try {
      if (apTicketId) apProgressResult = recordWorkerArtifactProgress(statePath, sessionDir, apTicketId, apBeforeCount, {
        iteration,
        log,
        workingDir: state.working_dir || process.cwd(),
        sourceSignatureFn: (wd) => computeScopedSourceTreeSignature(wd, path.join(sessionDir, 'scope.json')),
        creditEarlyPhases: apCreditEarlyPhases,
        suppressIncrement: apSuppressIncrement,
      });
    } catch { /* best-effort observability — never block iteration on progress tracking */ }
    // L2: a worker that produced NEW artifacts (non-zero delta) made genuine
    // progress — reset the consecutive idle-stall recovery streak.
    if (apProgressResult && apProgressResult.zeroProgressCount === 0) idleStallRecoveryCount = 0;

    // 2ed9a852 (C1): bound above the first post-iteration `continue` so every early exit
    // below can record its verdict. Emits at most once per iteration; HEAD is read inside
    // the thunk, at emit time.
    const emitWastedIterOnce = createWastedIterEmitter(() => ({
      sessionDir,
      iteration,
      action: result,
      preIterSha,
      postIterSha: readHeadCommit(iterWorkingDir),
      // 7addedbf: the worker-handoff observable — same before/after difference the
      // production breadcrumb consumes above. null when no ticket was in flight.
      artifactDelta: apProgressResult ? apProgressResult.lastArtifactCount - apBeforeCount : null,
    }));

    // AC-A1 (B-RRH): a Done ticket with completion evidence that produced no new
    // artifacts is NOT stuck — reset (handled in recordWorkerArtifactProgress), clear
    // current_ticket, advance, no increment (B-LERD: run-exit on a Done ticket).
    if (apTicketId && apProgressResult?.doneGuard) {
      log(`[done-guard] ticket ${apTicketId} is Done with completion evidence — counter reset, advancing without charge`);
      updateMuxLifecycleState(statePath, { currentTicket: null });
      emitWastedIterOnce();
      continue;
    }

    // R-WSWA-3: at PICKLE_WMW_SKIP_K (default 5) consecutive zero-progress spawns, flip the
    // ticket to Failed/oversized_no_progress (dirty tree preserved) and advance the loop.
    const skipK = resolveWmwSkipK();
    if (apTicketId && apProgressResult && apProgressResult.zeroProgressCount >= skipK) {
      // AC-R-WMNP-4: route the terminal no-progress trigger through the SAME
      // RecoveryController ladder as closer_handoff_terminal BEFORE the bare Failed
      // flip / respawn. A near-green diff (fix-forward-trivial / execute-converged-plan
      // / auto-split) advances the ticket instead of being respawned indefinitely;
      // only a genuinely exhausted ladder escalates to recovery_exhausted. A
      // fall_through (nothing to recover) proceeds to the existing terminal flip.
      {
        // AC-2 fail-safe: missing working_dir must halt this git-mutating
        // recovery call, never fall back to process.cwd() (the real repo).
        if (!state.working_dir) {
          recordExitReason(statePath, 'state_working_dir_missing');
          safeDeactivate(statePath);
          exitReason = 'state_working_dir_missing';
          break;
        }
        const wmwRecovery = routeRecoveryBeforeTerminal({
          sessionDir,
          statePath,
          extensionRoot,
          workingDir: state.working_dir,
          ticketId: apTicketId,
          iteration,
          flags: (state.flags as Record<string, unknown> | undefined) ?? null,
          log,
          mode: 'worker',
        });
        if (wmwRecovery.kind === 'advanced') {
          log(`recovery: ${wmwRecovery.strategy} advanced ${apTicketId} before wmw-auto-skip Failed flip — continuing.`);
          // Reset the zero-progress counter so a recovered ticket is not re-skipped on the next spawn.
          try {
            sm.update(statePath, s => {
              const entry = s.worker_artifact_progress?.[apTicketId];
              if (entry) entry.zero_progress_count = 0;
            });
          } catch { /* best-effort */ }
          lastStateIteration = -1;
          stallCount = 0;
          emitWastedIterOnce();
          continue;
        }
        if (wmwRecovery.kind === 'exhausted') {
          // AC-A2 (B-RRH): per-ticket ladder exhaustion advances to the next runnable
          // Todo (emitting ticket_ladder_exhausted) instead of killing the whole run;
          // run-exit only when no runnable ticket remains.
          const ladderAction = advanceOrExitOnLadderExhaustion({
            sessionDir,
            statePath,
            workingDir: state.working_dir || process.cwd(),
            ticketId: apTicketId,
            reason: `recovery_exhausted: ${wmwRecovery.reason}`,
            log,
          });
          if (ladderAction === 'advance') {
            log(`ticket_ladder_exhausted: ${apTicketId} (${wmwRecovery.reason}) — advancing to next runnable ticket at iteration ${iteration}.`);
            lastStateIteration = -1;
            stallCount = 0;
            emitWastedIterOnce();
            continue;
          }
          log(`recovery_exhausted: ladder exhausted for ${apTicketId} (${wmwRecovery.reason}) and no runnable ticket remains — exiting at iteration ${iteration}.`);
          writeRecoveryHandoffArtifact(sessionDir, apTicketId, `wmw_oversized: ${wmwRecovery.reason}`, log);
          recordExitReason(statePath, 'recovery_exhausted');
          safeDeactivate(statePath);
          removeRunnerSessionMapEntry(statePath, log);
          exitReason = 'recovery_exhausted';
          break;
        }
        // fall_through → proceed to the existing terminal Failed flip below.
      }
      // 7eb9fa20: evidence-backed flip-intents are suppressed (held) instead of
      // flipped. Evidence absent → archive a dirty tree first, then flip (the
      // wmw flip itself preserves the dirty tree; archival guards the runner's
      // downstream reset paths). Cap reached → existing no-progress halt.
      {
        const wmwWorkingDir = state.working_dir || process.cwd();
        const ffDecision = routeFailedFlipSuppression({
          sessionDir,
          statePath,
          ticketId: apTicketId,
          workingDir: wmwWorkingDir,
          iteration,
          callsite: 'wmw_auto_skip',
          windowStartMs: iterStartMs,
          windowEndMs: Date.now(),
          preSha: preIterSha,
          log,
          mode: 'worker',
        });
        if (ffDecision.action === 'suppress') {
          const holdMsg = `[wmw-auto-skip] ticket ${apTicketId}: Failed flip suppressed (${ffDecision.evidence}) — ticket held, status preserved`;
          log(holdMsg);
          process.stderr.write(`${holdMsg}\n`);
          // Clear current_ticket so the next iteration selects past the held
          // ticket (resolvePreTicket also refuses to re-engage a held ticket).
          updateMuxLifecycleState(statePath, { currentTicket: null });
          emitWastedIterOnce();
          continue;
        }
        if (ffDecision.action === 'escalate') {
          const capMsg = `[wmw-auto-skip] ticket ${apTicketId}: suppression cap ${ffDecision.cap} reached.`;
          log(capMsg);
          process.stderr.write(`${capMsg}\n`);
          // AC-A2 (B-RRH): suppression-cap exhaustion advances while a runnable Todo
          // remains; run-exit only when none remains.
          const ladderAction = advanceOrExitOnLadderExhaustion({
            sessionDir,
            statePath,
            workingDir: wmwWorkingDir,
            ticketId: apTicketId,
            reason: `suppression_cap_reached: ${ffDecision.cap}`,
            log,
          });
          if (ladderAction === 'advance') {
            log(`ticket_ladder_exhausted: ${apTicketId} (suppression cap ${ffDecision.cap}) — advancing to next runnable ticket at iteration ${iteration}.`);
            lastStateIteration = -1;
            stallCount = 0;
            emitWastedIterOnce();
            continue;
          }
          log(`recovery_exhausted: suppression cap reached for ${apTicketId} and no runnable ticket remains — halting.`);
          writeRecoveryHandoffArtifact(sessionDir, apTicketId, `wmw_suppression_cap: ${ffDecision.cap}`, log);
          recordExitReason(statePath, 'recovery_exhausted');
          safeDeactivate(statePath);
          removeRunnerSessionMapEntry(statePath, log);
          exitReason = 'recovery_exhausted';
          break;
        }
        archiveDirtyTreeBeforeFlip({ workingDir: wmwWorkingDir, sessionDir, ticketId: apTicketId, log });
      }
      // WS-2d (R-PFNT): finer no-progress reason in place of the misleading single literal.
      const apFailureReason = classifyNoProgressFailureReason(sessionDir);
      const skipMsg = `[wmw-auto-skip] ticket ${apTicketId}: ${apProgressResult.zeroProgressCount}/${skipK} consecutive zero-progress spawns — flipping to Failed/${apFailureReason}`;
      log(skipMsg);
      process.stderr.write(`${skipMsg}\n`);
      try {
        updateTicketFrontmatter(apTicketId, sessionDir, { status: 'Failed', completion_commit: null });
        const tfPath = ticketFilePath(sessionDir, apTicketId);
        // eslint-disable-next-line pickle/no-sync-in-async
        const tfRaw = fs.readFileSync(tfPath, 'utf-8');
        const tfUpdated = upsertFrontmatterField(tfRaw, 'failed_reason', apFailureReason);
        // eslint-disable-next-line pickle/no-sync-in-async
        if (tfUpdated) fs.writeFileSync(tfPath, tfUpdated);
      } catch (err) { log(`[wmw-auto-skip] frontmatter flip failed (ignored): ${safeErrorMessage(err)}`); }
      try {
        writeActivityEntry(statePath, {
          event: 'worker_auto_skip_oversized',
          ts: new Date().toISOString(),
          ticket: apTicketId,
          gate_payload: {
            spawn_count: apProgressResult.spawnCount,
            zero_progress_count: apProgressResult.zeroProgressCount,
            skip_k: skipK,
            failure_reason: apFailureReason,
          },
        });
      } catch { /* best-effort */ }
      // AC-R-WMNP-3: a terminal no-progress flip clears current_ticket (+ the
      // per-ticket cache, via updateMuxLifecycleState's ticket-change path) so the
      // next iteration's resolvePreTicket selects the next pending ticket rather
      // than re-engaging the just-flipped Failed ticket (order-deadlock).
      updateMuxLifecycleState(statePath, { currentTicket: null });
      emitWastedIterOnce();
      continue;
    }

    // R-WSE-2: detect partial lifecycle exit (research-review APPROVED, downstream artifacts missing)
    // 90574654: sub-classify the exit (log_empty → worker_silent_death |
    // log_truncated → worker_partial_lifecycle_exit) and route BOTH sub-classes
    // into the ONE salvage-first recovery policy. hold/respawn both continue the
    // loop (hold drew no cap and left the ticket untouched — H4 lands the real
    // hold semantics in 7eb9fa20; respawn lets the manager re-spawn under the
    // drawn-down persistent cap). Cap exhausted falls through to the existing
    // no-progress halt shape. Fail-open: any error → log + existing behavior.
    // R-WSE-3: emit stderr breadcrumb when ticket Failed after research APPROVED
    try {
      const iterTicket = state.current_ticket;
      // Hoisted so the R-WSDO breadcrumb below can gate on its null result.
      let plExit: PartialLifecycleExitClassification | null = null;
      if (iterTicket) {
        plExit = checkPartialLifecycleExit(sessionDir, statePath, iterTicket);
        if (plExit && plExit.subClass) {
          const sdDecision = applySilentDeathRecoveryPolicy({
            sessionDir,
            statePath,
            ticketId: iterTicket,
            workingDir: iterWorkingDir,
            iteration,
            classification: plExit,
            preIterSha,
            iterationStartMs: iterStartMs,
            log,
          });
          if (sdDecision.action === 'halt') {
            log(`[silent-death] halting loop at iteration ${iteration}: respawn cap exhausted for ${iterTicket}.`);
            recordExitReason(statePath, sdDecision.exitReason);
            safeDeactivate(statePath);
            removeRunnerSessionMapEntry(statePath, log);
            exitReason = sdDecision.exitReason;
            break;
          }
        }
      }
      if (iterTicket) {
        checkFailedAfterResearchApproved(sessionDir, iterTicket);
      }

      // R-WSDO (30aa2e0d) + AC-WMFF-2B: at most one post-iteration production breadcrumb.
      // The predicates, their overlap, and the R-WSDO-first control flow live in
      // emitWorkerProductionBreadcrumb — the one seam a test can cross to reach them.
      if (iterTicket) {
        emitWorkerProductionBreadcrumb({
          sessionDir,
          statePath,
          workingDir: iterWorkingDir,
          ticketId: iterTicket,
          iteration,
          partialLifecycleExit: plExit,
          artifactDelta: apProgressResult ? apProgressResult.lastArtifactCount - apBeforeCount : null,
          preIterSha,
        });
      }
    } catch { /* best-effort — never block iteration on partial-lifecycle check failure */ }

    // B-DURA T10: commit the current ticket's gate-passing deliverable at the NORMAL
    // iteration boundary (or attribute an existing untagged commit, or honest-fail)
    // BEFORE the Done-detection / context-clear block below. Best-effort, idempotent
    // on HEAD movement — an already-tagged commit or a clean tree is a no-op. The
    // downstream Done-flip guard remains authoritative; this only ensures verified
    // work is a durable commit on the branch before context is cleared.
    try {
      const boundaryTicket = state.current_ticket || null;
      if (boundaryTicket && !isTerminalTicketStatus(getTicketStatus(sessionDir, boundaryTicket))) {
        commitGatePassingDeliverableAtBoundary({
          sessionDir,
          statePath,
          workingDir: iterWorkingDir,
          ticketId: boundaryTicket,
          extensionRoot,
          flags: (state.flags as Record<string, unknown> | undefined) ?? null,
          preIterSha,
          log,
        });
      }
    } catch (err) {
      log(`[boundary-commit] iteration-boundary commit threw (ignored): ${safeErrorMessage(err)}`);
    }

    // Move iterLogFile computation BEFORE transition block (needed by classifyTicketCompletion)
    const iterLogFile = path.join(sessionDir, `tmux_iteration_${iteration}.log`);

    // Detect ticket transitions: validate completion before marking Done
    try {
      const postState = readRunnerState(statePath);
      const postTicket = postState.current_ticket || null;
      let completedBoundary: { ticketId: string; landedStatus: string | null; workingDir: string; nextTicketId: string | null } | null = null;
      if (previousTicket && postTicket !== previousTicket) {
        // Check if the model already marked it Done via prompt-driven validation
        const tickets = collectTickets(sessionDir);
        const prevTicketInfo = tickets.find(t => t.id === previousTicket);
        if (prevTicketInfo?.id && normalizedStatus(getTicketStatus(sessionDir, prevTicketInfo.id)) === 'done') {
          // F3 / R-DWC: worker-self-attested Done must have explicit completion_commit.
          // Recurring failure class — Finding #2 (codex Done-without-commit).
          const guard = guardCompletionCommitBeforeDone({
            sessionDir,
            ticketId: prevTicketInfo.id,
            workingDir: prevTicketInfo.working_dir || state.working_dir || process.cwd(),
            flags: (state.flags as Record<string, unknown> | undefined) ?? null,
          });
          if (!guard.ok) {
            const msg = `[fatal] ${new Date().toISOString()} ${guard.reason}`;
            log(msg);
            process.stderr.write(`${msg}\n`);
            // B-GTRUTH WS-A2 / ticket 96444430: per-ticket verdict — record
            // the residual, park this ticket (leave it un-Done), and
            // continue the phase loop instead of halting the session.
            recordExitReason(statePath, 'done_without_commit_evidence');
            emitWastedIterOnce();
            continue;
          }
          // R-PEDC: clear stale prior-iteration stamp on recovery.
          clearStaleDoneWithoutCommitEvidence(statePath);
          log(`Ticket ${previousTicket} already marked Done by model — skipping validation (completion_commit: ${formatCompletionCommitForLog(guard.sha)})`);
          // R-CXOR-1: detect HEAD regression — worker may have committed then git-reset to baseline.
          if (previousTicketStartCommit) {
            try {
              const hrResult = detectAndRecoverHeadRegression({
                ticketId: prevTicketInfo.id,
                workingDir: prevTicketInfo.working_dir || state.working_dir || process.cwd(),
                startCommit: previousTicketStartCommit,
                completionCommitSha: guard.sha || null,
                sessionDir,
                statePath,
                iteration,
                iterationStartMs: iterStartMs,
                log,
              });
              if (hrResult.action === 'suppression_cap_escalate') {
                // 7eb9fa20: cap reached with evidence — existing no-progress halt.
                const msg = `[failed-flip] suppression cap exhausted for ${prevTicketInfo.id} at head-regression — halting (recovery_exhausted).`;
                log(msg);
                process.stderr.write(`${msg}\n`);
                writeRecoveryHandoffArtifact(sessionDir, prevTicketInfo.id ?? null, 'head_regression_suppression_cap', log);
                recordExitReason(statePath, 'recovery_exhausted');
                safeDeactivate(statePath);
                removeRunnerSessionMapEntry(statePath, log);
                return;
              }
            } catch (err) { log(`head-regression check failed (ignored): ${safeErrorMessage(err)}`); }
          }
        } else {
          // Drift scenario: model changed current_ticket without following protocol
          const ticketWorkingDir = prevTicketInfo?.working_dir || state.working_dir || process.cwd();
          const autoValidation = applyAutoTicketCompletionValidation({
            sessionDir,
            ticketId: previousTicket,
            workingDir: ticketWorkingDir,
            startCommit: previousTicketStartCommit,
            iteration,
            log,
            statePath,
            flags: (state.flags as Record<string, unknown> | undefined) ?? null,
          });
          // B-GTRUTH WS-A2 / ticket 96444430: per-ticket verdict — the callee
          // already recorded the residual exit_reason and no longer
          // deactivates the session, so park this ticket (leave it un-Done)
          // and continue the phase loop.
          if (autoValidation.action === 'leave' && autoValidation.reason === 'guard_failed_no_commit_evidence') {
            emitWastedIterOnce();
            continue;
          }
        }
        completedBoundary = {
          ticketId: previousTicket,
          landedStatus: prevTicketInfo?.id ? getTicketStatus(sessionDir, prevTicketInfo.id) : null,
          workingDir: prevTicketInfo?.working_dir || postState.working_dir || state.working_dir || process.cwd(),
          nextTicketId: postTicket,
        };
      }
      const postStep = inferTicketLifecycleStep(sessionDir, postTicket, postState.step);
      const lifecycleState = updateMuxLifecycleState(statePath, { currentTicket: postTicket, step: postStep });
      const nextTicket = lifecycleState.current_ticket || null;
      if (completedBoundary) {
        completedBoundary.nextTicketId = nextTicket;
        try {
          runBetweenTicketFastGate({
            statePath,
            workingDir: completedBoundary.workingDir,
            completedTicketId: completedBoundary.ticketId,
            nextTicketId: completedBoundary.nextTicketId,
            landedStatus: completedBoundary.landedStatus,
            log,
          });
        } catch (err) {
          log(`between-ticket fast gate failed at ticket boundary (ignored): ${safeErrorMessage(err)}`);
        }
      }
      if (nextTicket !== previousTicket) {
        const nextTicketInfo = nextTicket ? collectTickets(sessionDir).find(t => t.id === nextTicket) : null;
        previousTicketStartCommit = nextTicket
          ? readHeadCommit(nextTicketInfo?.working_dir || lifecycleState.working_dir || process.cwd())
          : null;
      }
      previousTicket = nextTicket;
    } catch { /* state read failed — skip transition check */ }

    // --- Rate limit classification (MUST run before CB to prevent CB poisoning) ---
    const exitResult = classifyIterationExit(outcome.completion, iterLogFile, {
      didTimeout: outcome.timedOut,
      exitCode: outcome.exitCode,
      wallSeconds: outcome.wallSeconds,
    });
    const exitType = exitResult.type;
    logActivity({ event: 'iteration_end', source: 'pickle', session: path.basename(sessionDir), iteration, exit_type: exitType, backend: resolveBackend(state) });
    emitWastedIterOnce();

    if (exitType === 'api_limit') {
      consecutiveRateLimits++;
      const park = await runMainLoopRateLimitPark({
        exitResult, consecutiveRateLimits, maxRateLimitRetries, rateLimitWaitMinutes,
        maxParkMinutes, statePath, sessionDir, state, iteration, log,
      });
      if (park.kind === 'exit') {
        exitReason = park.exitReason;
        break;
      }
      consecutiveRateLimits = park.consecutiveRateLimits;
      writeHandoffAtomic(sessionDir, park.handoffContent, process.pid, log);
      continue;  // Skip CB recording + result branching entirely
    }
    if (exitType === 'success') {
      consecutiveRateLimits = 0;
      // B5: a clean iteration ENDS the rate-limit episode — drop the park ledger so
      // max_park_minutes measures one episode, not cumulative wall across the session.
      // Stateless (survives --resume): clear only when an arm is actually present.
      try {
        if (readRunnerState(statePath).rate_limit_park) {
          sm.update(statePath, (s) => { s.rate_limit_park = null; });
        }
      } catch { /* best-effort */ }
    }

    // --- Per-ticket timeout halt (FR-B3/B4/B12/B14) — MUST run BEFORE CB recording ---
    let ticketForTimeout: string | null = state.current_ticket || null;
    try {
      const postState = readRunnerState(statePath);
      ticketForTimeout = postState.current_ticket || null;
    } catch { /* keep pre-iteration ticket as fallback */ }

    const counterNext = applyTimeoutCounterForLoop({
      prev: { count: timeoutCount, ticket: lastTimeoutTicket },
      ticketNow: ticketForTimeout,
      timedOut: outcome.timedOut === true,
      completedClean: result === 'task_completed',
    });
    timeoutCount = counterNext.count;
    lastTimeoutTicket = counterNext.ticket;

    if (outcome.timedOut) {
      writeTimeoutStub(sessionDir, {
        ticketId: ticketForTimeout,
        iteration,
        wallSeconds: outcome.wallSeconds,
        workerTimeoutSeconds: Number(state.worker_timeout_seconds) || 0,
        timeoutCount,
        logFile: iterLogFile,
      });
    }

    if (counterNext.halt) {
      // R-WTB-A1: check artifact progress before halting — if the worker produced new
      // artifacts or commits within the no-progress window, reset the counter and continue.
      const noProgressWindowS = resolveNoProgressWindowSeconds();
      const ticketDir = ticketForTimeout ? path.join(sessionDir, ticketForTimeout) : null;
      const scopeJsonPath = path.join(sessionDir, 'scope.json');
      let progressDetected = false;
      // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
      if (ticketDir && fs.existsSync(ticketDir)) {
        const pResult = detectArtifactProgress(ticketDir, lastArtifactProgressSnapshot, {
          workingDir: state.working_dir || sessionDir,
          scopeJsonPath,
        });
        lastArtifactProgressSnapshot = { latestMtimeEpoch: pResult.latestMtimeEpoch, latestCommitSha: pResult.latestCommitSha };
        if (pResult.progressed) {
          progressDetected = true;
          writeActivityEntry(statePath, {
            event: 'ticket_timeout_progress_extension',
            ts: new Date().toISOString(),
            ticket: ticketForTimeout,
            gate_payload: {
              latest_mtime_epoch: pResult.latestMtimeEpoch,
              latest_commit_sha: pResult.latestCommitSha,
              timeout_count: timeoutCount,
              no_progress_window_seconds: noProgressWindowS,
            },
          });
          timeoutCount = 1;
          lastTimeoutTicket = ticketForTimeout;
          log(`[info] Artifact progress detected for ticket ${ticketForTimeout} — timeout counter reset (window: ${noProgressWindowS}s)`);
        }
      }
      if (!progressDetected) {
        writeActivityEntry(statePath, {
          event: 'ticket_timeout_halted_no_progress',
          ts: new Date().toISOString(),
          ticket: ticketForTimeout,
          gate_payload: {
            timeout_count: timeoutCount,
            no_progress_window_seconds: noProgressWindowS,
            latest_mtime_epoch: lastArtifactProgressSnapshot.latestMtimeEpoch,
            latest_commit_sha: lastArtifactProgressSnapshot.latestCommitSha,
          },
        });
        // W4a: route through the single choke point before the bare timeout park.
        // AC-2 fail-safe: a git-mutating recovery call MUST have an explicit
        // working_dir (never process.cwd() / the real repo).
        if (ticketForTimeout && state.working_dir) {
          const recovery = routeRecoveryBeforeTerminal({
            sessionDir,
            statePath,
            extensionRoot,
            workingDir: state.working_dir,
            ticketId: ticketForTimeout,
            iteration,
            flags: (state.flags as Record<string, unknown> | undefined) ?? null,
            log,
            mode: 'worker',
            evidence: { halt_site: 'timeout_repeat', timeout_count: timeoutCount },
          });
          if (recovery.kind === 'advanced') {
            log(`recovery: ${recovery.strategy} advanced ${ticketForTimeout} before timeout_repeat halt — continuing.`);
            timeoutCount = 0;
            lastTimeoutTicket = null;
            lastStateIteration = -1;
            stallCount = 0;
            continue;
          }
        }
        log(`Timeout halt: ticket ${ticketForTimeout} timed out ${timeoutCount} consecutive iterations`);
        executeTimeoutHalt({ statePath, sessionDir, ticketNow: ticketForTimeout, timeoutCount });
        exitReason = 'timeout_repeat';
        break;
      }
    }

    // === Existing CB recording — only reached for non-rate-limit ===

    // Circuit breaker: record iteration outcome (skip for subprocess failures)
    if (cbEnabled && cbState && result !== 'error' && result !== 'inactive') {
      let errorSig: string | null = null;
      try {
        // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
        const logContent = fs.readFileSync(iterLogFile, 'utf-8');
        errorSig = extractErrorSignature(logContent);
      } catch { /* log may not exist */ }

      let prevCBState = cbState.state;
      // Write CB state inside sm.update to keep circuit_breaker.json in sync with state.json iteration
      try {
        sm.update(statePath, s => {
          clearCircuitBreakerBudgetCacheOnTicketChange(s, cbState!.last_known_ticket);
          const progress = detectProgress(
            s.working_dir || process.cwd(),
            cbState!.last_known_head,
            cbState!.last_known_step,
            s.step,
            cbState!.last_known_ticket,
            s.current_ticket
          );
          const budget = getCircuitBreakerBudget(s, sessionDir);
          const dynamicCbSettings = settingsWithCircuitBreakerBudget(cbSettings, budget.budget);
          prevCBState = cbState!.state;
          cbState = recordIterationResult(
            cbState!,
            { hasProgress: progress.hasProgress, errorSignature: errorSig },
            iteration,
            dynamicCbSettings
          );
          cbState.last_known_head = progress.currentHead;
          cbState.last_known_step = s.step;
          cbState.last_known_ticket = s.current_ticket;
          if (prevCBState !== 'OPEN' && cbState.state === 'OPEN') {
            cbState.reason = formatCircuitBreakerTripReason(cbState.reason, budget);
          }
          writeStateFile(cbPath, cbState);
        });
      } catch {
        // sm.update failed — fall back to direct reads/writes (iteration desync possible but non-fatal)
        let postIterState: State = state;
        try {
          postIterState = readRunnerState(statePath);
        } catch { /* use last known state */ }
        clearCircuitBreakerBudgetCacheOnTicketChange(postIterState, cbState.last_known_ticket);
        const progress = detectProgress(
          postIterState.working_dir || process.cwd(),
          cbState.last_known_head, cbState.last_known_step, postIterState.step,
          cbState.last_known_ticket, postIterState.current_ticket
        );
        const budget = getCircuitBreakerBudget(postIterState, sessionDir);
        const dynamicCbSettings = settingsWithCircuitBreakerBudget(cbSettings, budget.budget);
        prevCBState = cbState.state;
        cbState = recordIterationResult(
          cbState,
          { hasProgress: progress.hasProgress, errorSignature: errorSig },
          iteration,
          dynamicCbSettings
        );
        cbState.last_known_head = progress.currentHead;
        cbState.last_known_step = postIterState.step;
        cbState.last_known_ticket = postIterState.current_ticket;
        if (prevCBState !== 'OPEN' && cbState.state === 'OPEN') {
          cbState.reason = formatCircuitBreakerTripReason(cbState.reason, budget);
        }
        writeStateFile(cbPath, cbState);
      }

      if (prevCBState !== 'OPEN' && cbState.state === 'OPEN') {
        logActivity({ event: 'circuit_open', source: 'pickle', session: path.basename(sessionDir), error: cbState.reason });
        log(`Circuit breaker tripped: ${cbState.reason}`);
        recordExitReason(statePath, 'circuit_open');
        safeDeactivate(statePath);
        exitReason = 'circuit_open';
        break;
      }

      if (prevCBState === 'HALF_OPEN' && cbState.state === 'CLOSED') {
        logActivity({ event: 'circuit_recovery', source: 'pickle', session: path.basename(sessionDir) });
        log('Circuit breaker recovered (HALF_OPEN → CLOSED)');
      }
    }

    if (result === 'task_completed') {
      // EPIC_COMPLETED / TASK_COMPLETED
      let curState: State;
      try {
        curState = readRunnerState(statePath);
      } catch (err) {
        const msg = safeErrorMessage(err);
        log(`ERROR: Cannot read state.json after task_completed: ${msg}. Exiting.`);
        exitReason = 'success';
        break;
      }
      // Verify EPIC_COMPLETED against ticket frontmatter. The pure helper
      // below is the only place that decides genuine vs. recoverable vs.
      // pathological — a single false EPIC_COMPLETED no longer kills the
      // pipeline. See `evaluateEpicCompletion` for the full state machine.
      const allTickets = withFreshTicketStatuses(sessionDir, collectTickets(sessionDir));
      const decision = evaluateEpicCompletion({
        tickets: allTickets,
        currentTicket: curState.current_ticket || null,
        priorFalseCount: Number(curState.false_epic_completed_count) || 0,
        priorFalseTicket: curState.false_epic_completed_ticket ?? null,
        // B-DURA T40: conjunctive Failed-terminal guard git context.
        failedTerminalGitContext: {
          sessionDir,
          workingDir: curState.working_dir || process.cwd(),
          startCommit: typeof curState.start_commit === 'string' ? curState.start_commit : null,
        },
      });

      if (decision.kind === 'persistent_hallucination') {
        log(`MANAGER_PERSISTENT_HALLUCINATION: ticket ${decision.ticket} emitted ${PromiseTokens.EPIC_COMPLETED} ${decision.nextCount} times without finishing (threshold ${FALSE_EPIC_THRESHOLD}). Done=${decision.doneCount}/${decision.totalCount}. Bailing for human review.\n       Iteration log: ${iterLogFile}`);
        appendPipelineRunnerMarker(sessionDir, `MANAGER_PERSISTENT_HALLUCINATION ticket=${decision.ticket} count=${decision.nextCount} done=${decision.doneCount}/${decision.totalCount}`);
        try {
          sm.update(statePath, s => {
            s.false_epic_completed_count = decision.nextCount;
            s.false_epic_completed_ticket = decision.ticket;
          });
        } catch (err) { log(`WARN: failed to persist false_epic counter: ${safeErrorMessage(err)}`); }
        logActivity({
          event: 'manager_persistent_hallucination',
          source: 'pickle',
          session: path.basename(sessionDir),
          ticket: decision.ticket,
          error: `${PromiseTokens.EPIC_COMPLETED} hallucinated ${decision.nextCount}× on ticket ${decision.ticket} (done ${decision.doneCount}/${decision.totalCount})`,
        });
        recordExitReason(statePath, 'manager_persistent_hallucination');
        safeDeactivate(statePath);
        exitReason = 'manager_persistent_hallucination';
        break;
      }

      if (decision.kind === 'recover_advance' || decision.kind === 'recover_retry') {
        const tag = decision.kind === 'recover_advance' ? 'advancing' : 'retrying same ticket';
        const currentId = curState.current_ticket || '(none)';
        log(`MANAGER_FALSE_${PromiseTokens.EPIC_COMPLETED}: ${PromiseTokens.EPIC_COMPLETED} claimed but ${decision.doneCount} of ${decision.totalCount} tickets Done (pending: ${decision.pendingIds.join(', ') || '(none)'}). Treating as ${PromiseTokens.TASK_COMPLETED} — ${tag}. count=${decision.nextCount}/${FALSE_EPIC_THRESHOLD}.\n       Iteration log: ${iterLogFile}`);
        appendPipelineRunnerMarker(sessionDir, `MANAGER_FALSE_${PromiseTokens.EPIC_COMPLETED} ticket=${currentId} mode=${tag} count=${decision.nextCount}/${FALSE_EPIC_THRESHOLD} done=${decision.doneCount}/${decision.totalCount} pending=${decision.pendingIds.join(',')}`);
        logActivity({
          event: 'manager_false_epic_completed',
          source: 'pickle',
          session: path.basename(sessionDir),
          ticket: curState.current_ticket || undefined,
          error: `${PromiseTokens.EPIC_COMPLETED} with ${decision.totalCount - decision.doneCount} pending — ${tag}`,
        });

        let recoveredCurrentTicket = curState.current_ticket || null;
        if (decision.kind === 'recover_advance' && curState.current_ticket) {
          // current_ticket is already Done — close it out so the next
          // iteration picks the next non-Done ticket. Counter persists at the
          // CURRENT ticket so a subsequent false epic on the SAME current
          // ticket doesn't get a fresh budget.
          const guard = guardCompletionCommitBeforeDone({
            sessionDir,
            ticketId: curState.current_ticket,
            workingDir: curState.working_dir || process.cwd(),
            flags: (curState.flags as Record<string, unknown> | undefined) ?? null,
          });
          if (!guard.ok) {
            const msg = `[fatal] ${new Date().toISOString()} ${guard.reason}`;
            log(msg);
            process.stderr.write(`${msg}\n`);
            // B-GTRUTH WS-A2 / ticket 96444430: per-ticket verdict — record
            // the residual, park this ticket (leave it un-Done), and
            // continue the phase loop instead of halting the session.
            recordExitReason(statePath, 'done_without_commit_evidence');
            continue;
          }
          // R-PEDC: clear stale prior-iteration stamp on recovery.
          clearStaleDoneWithoutCommitEvidence(statePath);
          if (markTicketDone(sessionDir, curState.current_ticket)) {
            log(`Marked ticket ${curState.current_ticket} as Done (recover_advance)`);
          }
          recoveredCurrentTicket = findNextPendingTicketId(sessionDir);
        }

        try {
          sm.update(statePath, s => {
            s.false_epic_completed_count = decision.nextCount;
            s.false_epic_completed_ticket = curState.current_ticket || null;
            const priorTicket = s.current_ticket;
            if (s.current_ticket !== recoveredCurrentTicket) {
              s.current_ticket = recoveredCurrentTicket;
              delete s.current_ticket_tier;
              delete s.current_ticket_budget;
              delete s.current_ticket_max_iterations;
              delete s.current_ticket_worker_timeout_seconds;
              delete s.current_ticket_budget_start_iteration;
            }
            const recoveredStep = inferTicketLifecycleStep(sessionDir, recoveredCurrentTicket, s.step);
            s.step = priorTicket !== recoveredCurrentTicket ? recoveredStep : maxLifecycleStep(s.step, recoveredStep);
          });
        } catch (err) { log(`WARN: failed to persist false_epic counter: ${safeErrorMessage(err)}`); }

        // Stricter retry brief — handed to the next iteration via handoff.txt.
        const retryBrief = [
          `=== MANAGER FALSE EPIC RECOVERY (count ${decision.nextCount}/${FALSE_EPIC_THRESHOLD}) ===`,
          `You emitted <promise>${PromiseTokens.EPIC_COMPLETED}</promise> but only ${decision.doneCount} of ${decision.totalCount} tickets are status: Done.`,
          decision.pendingIds.length > 0 ? `Pending tickets: ${decision.pendingIds.join(', ')}.` : '',
          decision.kind === 'recover_advance'
            ? `Continue with the next non-Done ticket. Do NOT emit ${PromiseTokens.EPIC_COMPLETED} again until every rick_ticket_*.md file in the session root reports status: Done.`
            : `Resume work on current_ticket=${curState.current_ticket}. It is NOT yet Done. Do NOT emit ${PromiseTokens.EPIC_COMPLETED} again until every rick_ticket_*.md file in the session root reports status: Done.`,
          `Use ${PromiseTokens.TASK_COMPLETED} for single-ticket completions; reserve ${PromiseTokens.EPIC_COMPLETED} for the moment all tickets are Done.`,
        ].filter(Boolean).join('\n');
        const handoffSummary = buildIterationHandoffSummary(state, sessionDir, iteration + 1);
        writeHandoffAtomic(sessionDir, `${handoffSummary}\n\n${retryBrief}`, process.pid, log);

        // Reset stall counter so the recovery iteration isn't immediately
        // killed by the no-progress detector — the manager IS making progress
        // (we just disagree about whether it's done).
        lastStateIteration = -1;
        stallCount = 0;
        await sleep(1000);
        continue;
      }

      // Genuine epic completion — clear any lingering false-epic counter and
      // proceed as before.
      if (Number(curState.false_epic_completed_count) > 0) {
        try {
          sm.update(statePath, s => {
            s.false_epic_completed_count = 0;
            s.false_epic_completed_ticket = null;
          });
        } catch (err) { log(`WARN: failed to clear false_epic counter: ${safeErrorMessage(err)}`); }
      }

      // Mark final ticket as Done before exiting or chaining
      if (curState.current_ticket) {
        const guard = guardCompletionCommitBeforeDone({
          sessionDir,
          ticketId: curState.current_ticket,
          workingDir: curState.working_dir || state.working_dir || process.cwd(),
          flags: (curState.flags as Record<string, unknown> | undefined) ?? null,
        });
        if (!guard.ok) {
          const msg = `[fatal] ${new Date().toISOString()} ${guard.reason}`;
          log(msg);
          process.stderr.write(`${msg}\n`);
          // B-GTRUTH WS-A2 / ticket 96444430: per-ticket verdict — record
          // the residual, park this ticket (leave it un-Done), and continue
          // the phase loop instead of halting on the EPIC_COMPLETED claim.
          recordExitReason(statePath, 'done_without_commit_evidence');
          continue;
        }
        // R-PEDC: clear stale prior-iteration stamp on recovery so a
        // fully-shipped bundle finalizes as 'completed', not 'failed'.
        clearStaleDoneWithoutCommitEvidence(statePath);
        if (markTicketDone(sessionDir, curState.current_ticket)) {
          log(`Marked final ticket ${curState.current_ticket} as Done`);
        }
      }
      const closerDecision = evaluateCloserTerminalState({
        state: curState,
        sessionDir,
        workingDir: curState.working_dir || state.working_dir || process.cwd(),
        headSha: observeCurrentHead(curState.working_dir || state.working_dir || process.cwd())?.sha ?? null,
        failedBudget: readCloserHandoffBudget(extensionRoot),
      });
      if (closerDecision.action === 'exit' && closerDecision.reason === 'manager_handoff_pending') {
        exitReason = exitForCloserTerminalState(statePath, sessionDir, iteration, closerDecision, log);
        break;
      }
      // R-NOPOSTTIER (AC-13): this is the manager-token completion seam (the model
      // itself emitted EPIC_COMPLETED/TASK_COMPLETED and evaluateEpicCompletion
      // verified it genuine) — a second promise-synthesis path distinct from the
      // proactive all-tickets-done scan in applyAllTicketsDoneCompletion. It owes
      // the same verdict for the same reason: the bundle's final commit has
      // landed and this is the last moment before finalizeIfTrulyComplete can
      // turn it into a promise.
      runManagerTokenPostFinalMeasurement(
        statePath,
        curState.working_dir || state.working_dir || '',
        curState.current_ticket || 'all-tickets-done',
        log,
      );
      log('Task completed. Exiting loop.');
      // B-GROUND2 WS1: the EPIC-success finalize routes through the single
      // ground-truth authority — a residual pending ticket refuses the
      // `success` stamp and stamps the incomplete reason instead (fail-closed).
      finalizeIfTrulyComplete(
        statePath,
        () => muxBundleScan(sessionDir, state.working_dir || ''),
        { step: 'completed', runnerIteration: iteration, exitReason: 'success' },
      );
      exitReason = 'success';
      break;
    } else if (result === 'review_clean') {
      // review_clean (EXISTENCE_IS_PAIN / THE_CITADEL_APPROVES) — apply min_iterations gate
      let curState: State;
      try {
        curState = readRunnerState(statePath);
      } catch (err) {
        const msg = safeErrorMessage(err);
        log(`ERROR: Cannot read state.json after review_clean: ${msg}. Treating as completed.`);
        // B-GROUND2 WS1: even on a state-read failure the EPIC-success finalize
        // routes through the authority; `muxBundleScan` reads frontmatter
        // independently of state.json, so the pending-scan still fail-closes.
        finalizeIfTrulyComplete(
          statePath,
          () => muxBundleScan(sessionDir, state.working_dir || ''),
          { step: 'completed', runnerIteration: iteration, exitReason: 'success' },
        );
        exitReason = 'success';
        break;
      }
      const rawMinIter = Number(curState.min_iterations);
      const minIter = Number.isFinite(rawMinIter) ? rawMinIter : 0;
      const rawCurIter2 = Number(curState.iteration);
      const curIterNow = Number.isFinite(rawCurIter2) ? rawCurIter2 : 0;
      if (minIter > 0 && curIterNow < minIter) {
        log(`Clean pass at iteration ${curIterNow}, but min_iterations=${minIter}. Continuing.`);
      } else {
        log('Review clean. Exiting loop.');
        // B-GROUND2 WS1: EPIC-success finalize through the single authority.
        finalizeIfTrulyComplete(
          statePath,
          () => muxBundleScan(sessionDir, curState.working_dir || state.working_dir || ''),
          { step: 'completed', runnerIteration: iteration, exitReason: 'success' },
        );
        exitReason = 'success';
        break;
      }
    } else if (result === 'inactive') {
      if (detectManagerInactiveExit(outcome)) {
        let postState: State = state;
        try { postState = readRunnerState(statePath); } catch { /* fall back */ }
        const inactiveExitKind = classifyManagerRelaunchExit(postState, outcome, iterLogFile, runnerMaxTurns);
        if (inactiveExitKind === 'codex_session_inactive') {
          const inactiveDecision = evaluateManagerRelaunch(postState, collectTickets(sessionDir), cbState, inactiveExitKind);
          if (inactiveDecision.reason === 'time_limit') {
            log('Time limit reached. Exiting.');
            finalizeTerminalState(statePath, { step: 'completed', runnerIteration: iteration, exitReason: 'limit' });
            exitReason = 'limit';
            break;
          }
          if (inactiveDecision.shouldRelaunch) {
            const noProgress = checkAndUpdateCodexManagerNoProgress(statePath, inactiveDecision.pendingCount, log);
            if (noProgress.halt) {
              // AC-2 fail-safe: missing working_dir must halt this git-mutating
              // recovery seam, never fall back to process.cwd() (the real repo).
              if (!postState.working_dir && !state.working_dir) {
                recordExitReason(statePath, 'state_working_dir_missing');
                safeDeactivate(statePath);
                exitReason = 'state_working_dir_missing';
                break;
              }
              // R-CHTS-CODEX: route through recovery seam before parking.
              const codexRecovery = haltOrRecoverCodexNoProgress({
                statePath,
                sessionDir,
                extensionRoot,
                workingDir: postState.working_dir || state.working_dir,
                iteration,
                log,
              });
              if (codexRecovery.kind === 'advanced') {
                lastStateIteration = -1;
                stallCount = 0;
                await sleep(1000);
                continue;
              }
              if (codexRecovery.kind === 'recovery_exhausted') {
                writeRecoveryHandoffArtifact(sessionDir, state.current_ticket ?? null, 'codex_manager_no_progress: ladder_exhausted', log);
                recordExitReason(statePath, 'recovery_exhausted');
                safeDeactivate(statePath);
                removeRunnerSessionMapEntry(statePath, log);
                exitReason = 'recovery_exhausted';
                break;
              }
              // kind === 'halt' → fall through to existing park.
              log(`Codex manager made no progress for ${noProgress.consecutiveCount} consecutive relaunch passes — halting with codex_manager_no_progress.`);
              logActivity({ event: 'codex_manager_no_progress', source: 'pickle', session: path.basename(sessionDir), iteration, backend: resolveBackendFromStateFileWithSource(statePath).backend, consecutive_count: noProgress.consecutiveCount, pending_count: inactiveDecision.pendingCount });
              recordExitReason(statePath, 'codex_manager_no_progress');
              safeDeactivate(statePath);
              removeRunnerSessionMapEntry(statePath, log);
              exitReason = 'codex_manager_no_progress';
              break;
            }
            const relaunchBackend = resolveBackendFromStateFileWithSource(statePath).backend;
            log(`${relaunchBackend} manager subprocess exited via ${inactiveExitKind} with ${inactiveDecision.pendingCount} ticket(s) still pending — relaunching (count ${inactiveDecision.nextRelaunchCount}/${inactiveDecision.cap}).`);
            recordManagerRelaunch(statePath, sessionDir, inactiveDecision, iteration, log);
            lastStateIteration = -1;
            stallCount = 0;
            await sleep(1000);
            continue;
          }
        }
        // AC-A2 (B-DSAN2 WS-A): a clean manager exit (end_turn / max-turns) must NOT exit 0
        // while tickets remain non-terminal. Reuse evaluateManagerRelaunch (the existing
        // completion authority) to relaunch on a pending bundle; only an all-terminal queue
        // may fall through to the clean exit. No new parallel guard.
        if (inactiveExitKind !== 'codex_session_inactive') {
          const relaunchTickets = withFreshTicketStatuses(sessionDir, collectTickets(sessionDir));
          const decision = evaluateManagerRelaunch(postState, relaunchTickets, cbState, inactiveExitKind);
          if (decision.reason === 'time_limit') {
            log('Time limit reached. Exiting.');
            finalizeTerminalState(statePath, { step: 'completed', runnerIteration: iteration, exitReason: 'limit' });
            exitReason = 'limit';
            break;
          }
          if (decision.shouldRelaunch) {
            // AC-A4 (f8000435): bounded terminal escape. An In Progress ticket held
            // across the resolved bounded-escape cap (`hardening.bounded_terminal_escape_cap`,
            // compiled default 3) consecutive no-progress relaunches is forced
            // terminal (salvage → Skipped); the next loop's evaluateManagerRelaunch
            // sees it no longer pending and advances/halts deterministically — the
            // pipeline never spins to max_iterations on an unreclaimable ticket.
            const boundedEscapeCap = resolveHardeningSettings(loadPickleSettingsBag(extensionRoot)).bounded_terminal_escape_cap;
            const esc = evaluateBoundedEscape(postState, sessionDir, boundedEscapeCap);
            if (esc.escape && esc.ticketId) {
              executeBoundedEscape(statePath, sessionDir, postState.working_dir || state.working_dir || '', esc.ticketId, iteration, boundedEscapeCap, log);
              lastStateIteration = -1;
              stallCount = 0;
              await sleep(1000);
              continue;
            }
            if (esc.ticketId) recordBoundedEscapeAttempt(statePath, esc.ticketId, iteration, log);
            const relaunchBackend = resolveBackendFromStateFileWithSource(statePath).backend;
            log(`${relaunchBackend} manager exited via ${inactiveExitKind} with ${decision.pendingCount} pending — relaunching (count ${decision.nextRelaunchCount}/${decision.cap}).`);
            recordManagerRelaunch(statePath, sessionDir, decision, iteration, log);
            lastStateIteration = -1;
            stallCount = 0;
            await sleep(1000);
            continue;
          }
          if (decision.pendingCount > 0) {
            // cap_exceeded / circuit_open WITH pending tickets — terminal, but NEVER exit-0.
            recordExitReason(statePath, 'idle_stall_unrecoverable');
            safeDeactivate(statePath);
            exitReason = 'idle_stall_unrecoverable';
            break;
          }
          // decision.pendingCount === 0 → all terminal → legitimate clean exit, fall through.
        }
      }
      log('Session deactivated. Exiting loop.'); exitReason = 'cancelled'; break;
    } else if (result === 'error') {
      // Codex tmux_mode runs ONE long-lived manager subprocess that loops
      // across many tickets internally. The 4h hang-guard SIGTERMs it with
      // `{ completion: 'error', timedOut: true }`. Treating that as terminal
      // strands every Todo ticket the manager hadn't picked up yet. Bounded
      // relaunch path keeps the queue draining; CB-OPEN and the cap still
      // fall through to the legacy exit-on-error.
      let postState: State = state;
      try { postState = readRunnerState(statePath); } catch { /* fall back */ }
      const exitKind = classifyManagerRelaunchExit(postState, outcome, iterLogFile, runnerMaxTurns);
      const relaunchDecision = evaluateManagerRelaunch(
        postState,
        collectTickets(sessionDir),
        cbState,
        exitKind,
      );
      if (relaunchDecision.reason === 'time_limit') {
        log('Time limit reached. Exiting.');
        finalizeTerminalState(statePath, { step: 'completed', runnerIteration: iteration, exitReason: 'limit' });
        exitReason = 'limit';
        break;
      }
      if (relaunchDecision.shouldRelaunch && !isGenuineCrashOrSpawnFailure(relaunchDecision, outcome, iterLogFile)) {
        const noProgress = checkAndUpdateCodexManagerNoProgress(statePath, relaunchDecision.pendingCount, log);
        if (noProgress.halt) {
          // AC-2 fail-safe: missing working_dir must halt this git-mutating
          // recovery seam, never fall back to process.cwd() (the real repo).
          if (!postState.working_dir && !state.working_dir) {
            recordExitReason(statePath, 'state_working_dir_missing');
            safeDeactivate(statePath);
            exitReason = 'state_working_dir_missing';
            break;
          }
          // R-CHTS-CODEX: route through recovery seam before parking.
          const codexRecovery = haltOrRecoverCodexNoProgress({
            statePath,
            sessionDir,
            extensionRoot,
            workingDir: postState.working_dir || state.working_dir,
            iteration,
            log,
          });
          if (codexRecovery.kind === 'advanced') {
            lastStateIteration = -1;
            stallCount = 0;
            await sleep(1000);
            continue;
          }
          if (codexRecovery.kind === 'recovery_exhausted') {
            writeRecoveryHandoffArtifact(sessionDir, state.current_ticket ?? null, 'codex_manager_no_progress: ladder_exhausted', log);
            recordExitReason(statePath, 'recovery_exhausted');
            safeDeactivate(statePath);
            removeRunnerSessionMapEntry(statePath, log);
            exitReason = 'recovery_exhausted';
            break;
          }
          // kind === 'halt' → fall through to existing park.
          log(`Codex manager made no progress for ${noProgress.consecutiveCount} consecutive relaunch passes — halting with codex_manager_no_progress.`);
          logActivity({ event: 'codex_manager_no_progress', source: 'pickle', session: path.basename(sessionDir), iteration, backend: resolveBackendFromStateFileWithSource(statePath).backend, consecutive_count: noProgress.consecutiveCount, pending_count: relaunchDecision.pendingCount });
          recordExitReason(statePath, 'codex_manager_no_progress');
          safeDeactivate(statePath);
          removeRunnerSessionMapEntry(statePath, log);
          exitReason = 'codex_manager_no_progress';
          break;
        }
        const relaunchBackend = resolveBackendFromStateFileWithSource(statePath).backend;
        const detail = relaunchDecision.exitKind === 'other_error'
          ? 'errored'
          : `exited via ${relaunchDecision.exitKind}`;
        log(
          `${relaunchBackend} manager subprocess ${detail} with ${relaunchDecision.pendingCount} ticket(s) still pending — ` +
          `relaunching (count ${relaunchDecision.nextRelaunchCount}/${relaunchDecision.cap}).`,
        );
        recordManagerRelaunch(statePath, sessionDir, relaunchDecision, iteration, log);
        // Relaunch IS progress for outer-loop stall detection — reset stall.
        // Do NOT clear the circuit breaker: a 4h hang-guard timeout is the
        // exact event the CB should observe across relaunches.
        lastStateIteration = -1;
        stallCount = 0;
        await sleep(1000);
        continue;
      }
      log('Subprocess error. Exiting loop.');
      recordExitReason(statePath, 'error');
      safeDeactivate(statePath);
      removeRunnerSessionMapEntry(statePath, log);
      exitReason = 'error';
      break;
    }

    await sleep(1000);
  }

  const completionVerdict = runTerminalReport({
    codegraph,
    sessionDir,
    statePath,
    exitReason,
    iteration,
    totalElapsed: Math.floor((Date.now() - startTime) / 1000),
    log,
  });
  // Bound to the verdict `runTerminalReport` already derived — NOT a second
  // `isFailureExit(exitReason)` call. The NAME is load-bearing: the exit map is parsed
  // out of this source by `deriveExitCodeMapFromSource`
  // (`mux-runner-done-without-commit-evidence-exit.test.js`), which anchors the failure
  // branch on the literal identifier `isFailedExit`.
  const isFailedExit = completionVerdict.isFailure;

  // Explicit exit code so parent processes (pipeline-runner) can detect failure.
  // Matches microverse-runner.ts pattern.
  // R-ICP-1: 'iteration_cap_exhausted' is a distinct exit code (3) so
  // pipeline-runner can halt the pipeline instead of treating cap-without-
  // EPIC_COMPLETED as either silent success (0) or a generic failure (1).
  // B-GTRUTH WS-A2: 'done_without_commit_evidence' joins the cap exit on code 3 so
  // pipeline-runner routes it through `reportPhaseIncomplete` (which consults the
  // completion oracle to separate committed-but-unflipped from genuinely-unfinished)
  // instead of fataling the whole pipeline over one ticket. Its own branch is
  // REQUIRED: having been demoted out of FAILURE_EXIT_REASONS it would otherwise
  // reach the trailing success default and graduate the phase silently.
  // (Deliberately phrased without the literal assignment text — the exit-map
  // ordering pin in mux-runner-iteration-cap-exit.test.js locates the branches by
  // `indexOf`, so restating them in prose here would shadow the real code sites.)
  let exitCode: number;
  if (exitReason === 'iteration_cap_exhausted') exitCode = 3;
  else if (exitReason === 'done_without_commit_evidence') exitCode = 3;
  else if (isFailedExit) exitCode = 1;
  else exitCode = 0;
  closePhantomDoneWatchers();
  process.exit(exitCode);
}

/**
 * WS-1c: the ONE verdict derivation for a terminal ExitReason. Both the console
 * completion panel (`printMinimalPanel`) and `buildTmuxNotification` consume this
 * — never re-derive `isFailureExit(exitReason)` independently at either call
 * site — so the two renderers cannot disagree about whether a run succeeded.
 */
export type CompletionVerdict = {
  isFailure: boolean;
  /** WS-A2's third class: the run neither failed nor finished. See `isIncompleteExit`. */
  isIncomplete: boolean;
  colorName: 'GREEN' | 'RED' | 'YELLOW';
  panelTitle: string;
};

export function deriveCompletionVerdict(exitReason: ExitReason): CompletionVerdict {
  const isFailure = isFailureExit(exitReason);
  // Failure wins on overlap, so a reason listed in both sets can never soften a RED.
  if (!isFailure && isIncompleteExit(exitReason)) {
    return { isFailure: false, isIncomplete: true, colorName: 'YELLOW', panelTitle: 'mux-runner Incomplete' };
  }
  return {
    isFailure,
    isIncomplete: false,
    colorName: isFailure ? 'RED' : 'GREEN',
    panelTitle: isFailure ? 'mux-runner Failed' : 'mux-runner Complete',
  };
}

export function buildTmuxNotification(exitReason: ExitReason, finalStep: string, iteration: number, totalElapsed: number) {
  const { isFailure, isIncomplete } = deriveCompletionVerdict(exitReason);
  // 'Incomplete' does NOT contain 'Complete' (capital C), so the three titles stay
  // mutually exclusive under the substring checks every consumer and test uses.
  const title = isFailure
    ? '🥒 Pickle Run Failed'
    : isIncomplete
      ? '🥒 Pickle Run Incomplete'
      : '🥒 Pickle Run Complete';
  const subtitle = isFailure
    ? `Exit: ${exitReason} (phase: ${finalStep})`
    : isIncomplete
      ? `Incomplete: ${exitReason} (phase: ${finalStep})`
      : exitReason === 'success'
        ? `Finished in ${formatTime(totalElapsed)}`
        : `Stopped: ${exitReason} (${formatTime(totalElapsed)})`;
  const body = `${iteration} iterations, ${formatTime(totalElapsed)}`;
  return { title, subtitle, body };
}

if (process.argv[1] && path.basename(process.argv[1]) === 'mux-runner.js') {
  main().catch((err) => {
    const msg = safeErrorMessage(err);
    console.error(`${Style.RED}[FATAL] ${msg}${Style.RESET}`);
    const sessionDir = process.argv[2];
    if (sessionDir && !sessionDir.startsWith('--')) {
      const statePath = path.join(sessionDir, 'state.json');
      try { recordExitReason(statePath, 'error'); } catch { /* best-effort forensic stamp */ }
      try { safeDeactivate(statePath); } catch { /* never throw on deactivate */ }
    }
    process.exit(1);
  });
}

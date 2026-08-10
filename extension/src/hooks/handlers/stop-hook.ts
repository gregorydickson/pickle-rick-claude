import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { State, HookInput, PromiseTokens, hasToken } from '../../types/index.js';
import { PROMISE_TOKENS } from '../../services/promise-tokens.js';
import { resolveStateFile, approve, sameWorkingDir } from '../resolve-state.js';
import { getExtensionRoot, getDataRoot, safeErrorMessage } from '../../services/pickle-utils.js';
import { StateManager, writeActivityEntry } from '../../services/state-manager.js';
import { logActivity } from '../../services/activity-logger.js';
import { readRecoverableJsonObject } from '../../services/microverse-state.js';
import { isProcessAlive } from '../../lib/process-liveness.js';

const sm = new StateManager();

export const DEFAULT_MANAGER_IDLE_BACKOFF_FALLBACK_MS = 60_000;
export const MANAGER_IDLE_BACKOFF_THRESHOLD = 3;
const IDLE_BACKOFF_STATE_FILE = '.manager-idle-backoff.json';
const WORKER_ARTIFACT_PREFIXES = ['research_', 'plan_', 'conformance_', 'code_review_'] as const;
export const WAIT_PATTERN_REGEXES = [
  /waiting for monitor signal\.?$/i,
  /worker still/i,
  /continuing to wait/i,
];

const RATE_LIMIT_PATTERNS = [
  /out of (extra )?usage/i,
  /rate limit/i,
  /usage.*limit.*reached/i,
  /limit.*reached.*try.*back/i,
  /hour.*limit/i,
];

const DEGENERATE_MAX_LENGTH = 10;
const NO_OP_MAX_LENGTH = 100;
const NO_OP_PATTERNS = [
  /^acknowledged\.?$/i,
  /^ok\.?$/i,
  /^done\.?$/i,
  /^understood\.?$/i,
  /^noted\.?$/i,
  /^continuing\.?$/i,
  /^ready\.?$/i,
  /^got it\.?$/i,
  /^will do\.?$/i,
  /^roger\.?$/i,
];

export type TokenKind =
  | { kind: 'completion-promise'; promise: string }
  | { kind: 'epic-completed' }
  | { kind: 'task-completed' }
  | { kind: 'analysis-done' }
  | { kind: 'review-clean' }
  | { kind: 'worker-done' }
  | { kind: 'prd-complete' }
  | { kind: 'ticket-selected' }
  | { kind: 'none' };

export type Decision = 'approve' | 'block';
export type HelperResult = { decision: Decision };
type IdleBackoffReleaseReason = 'state_mtime' | 'worker_exit' | 'artifact_landed' | 'fallback_timer';
interface IdleBackoffSnapshot {
  consecutive_wait_turns: number;
  engaged_at_ms?: number;
  state_mtime_ms?: number;
  artifact_mtime_ms?: number;
  worker_pid?: number | null;
  ticket?: string | null;
}
type StateActivityEntry = Record<string, unknown> & { event: string };

type ActivityKind = 'review-clean' | 'epic-completed' | 'ticket-completed';
type ClassifiedResult = HelperResult & {
  reason?: string;
  logMessage: string;
  token: TokenKind;
  activity?: ActivityKind;
  stateActivityEntries?: StateActivityEntry[];
};

function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function finiteIntegerOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed) ? parsed : null;
}

function roleAllowsToken(token: TokenKind, role: string): boolean {
  if (token.kind === 'worker-done') return role === 'worker';
  if (token.kind === 'analysis-done') return role === 'refinement-worker';
  if (token.kind === 'prd-complete' || token.kind === 'ticket-selected') return role !== 'worker';
  return true;
}

function isWhitespaceOnlyResponse(transcript: string, trimmed: string): boolean {
  return transcript.length > 0 && trimmed.length === 0;
}

function isNoOpResponse(trimmed: string): boolean {
  return trimmed.length > 0 && trimmed.length <= NO_OP_MAX_LENGTH &&
    NO_OP_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function isShortResponse(trimmed: string): boolean {
  return trimmed.length > 0 && trimmed.length <= DEGENERATE_MAX_LENGTH;
}

function isManagerRole(role: string): boolean {
  return role !== 'worker' && role !== 'refinement-worker';
}

function isWaitPatternResponse(trimmed: string): boolean {
  return trimmed.length > 0 && WAIT_PATTERN_REGEXES.some((pattern) => pattern.test(trimmed));
}

function getIdleBackoffStatePath(state: State): string | null {
  return state.session_dir ? path.join(state.session_dir, IDLE_BACKOFF_STATE_FILE) : null;
}

function readIdleBackoffSnapshot(state: State): IdleBackoffSnapshot | null {
  const snapshotPath = getIdleBackoffStatePath(state);
  if (!snapshotPath || !fs.existsSync(snapshotPath)) return null;
  const parsed = readRecoverableJsonObject(snapshotPath) as Record<string, unknown> | null;
  if (!parsed) return null;
  const consecutiveWaitTurns = finiteIntegerOrNull(parsed.consecutive_wait_turns);
  if (consecutiveWaitTurns === null || consecutiveWaitTurns < 0) return null;
  const engagedAtMs = finiteNumber(parsed.engaged_at_ms, Number.NaN);
  const stateMtimeMs = finiteNumber(parsed.state_mtime_ms, Number.NaN);
  const artifactMtimeMs = finiteNumber(parsed.artifact_mtime_ms, Number.NaN);
  const workerPid = parsed.worker_pid === null ? null : finiteIntegerOrNull(parsed.worker_pid);
  return {
    consecutive_wait_turns: consecutiveWaitTurns,
    engaged_at_ms: Number.isFinite(engagedAtMs) ? engagedAtMs : undefined,
    state_mtime_ms: Number.isFinite(stateMtimeMs) ? stateMtimeMs : undefined,
    artifact_mtime_ms: Number.isFinite(artifactMtimeMs) ? artifactMtimeMs : undefined,
    worker_pid: workerPid,
    ticket: typeof parsed.ticket === 'string' ? parsed.ticket : null,
  };
}

function writeIdleBackoffSnapshot(state: State, snapshot: IdleBackoffSnapshot | null): void {
  const snapshotPath = getIdleBackoffStatePath(state);
  if (!snapshotPath) return;
  if (!snapshot) {
    try { fs.unlinkSync(snapshotPath); } catch { /* ignore */ }
    return;
  }
  const tmpPath = `${snapshotPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2));
    fs.renameSync(tmpPath, snapshotPath);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

function readFileMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function getTicketDir(state: State): string | null {
  if (!state.session_dir || !state.current_ticket) return null;
  return path.join(state.session_dir, state.current_ticket);
}

function getWorkerArtifactMtimeMs(state: State): number {
  const ticketDir = getTicketDir(state);
  if (!ticketDir) return 0;
  try {
    const entries = fs.readdirSync(ticketDir);
    let maxMtime = 0;
    for (const entry of entries) {
      if (!WORKER_ARTIFACT_PREFIXES.some((prefix) => entry.startsWith(prefix)) || !entry.endsWith('.md')) continue;
      const mtime = readFileMtimeMs(path.join(ticketDir, entry));
      if (mtime > maxMtime) maxMtime = mtime;
    }
    return maxMtime;
  } catch {
    return 0;
  }
}

function getLatestWorkerPid(state: State): number | null {
  const ticketDir = getTicketDir(state);
  if (!ticketDir) return null;
  try {
    const logCandidates = fs.readdirSync(ticketDir)
      .filter((entry) => /^worker_session_\d+\.log$/.test(entry))
      .map((entry) => ({ entry, mtimeMs: readFileMtimeMs(path.join(ticketDir, entry)) }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    const latest = logCandidates[0];
    if (!latest) return null;
    const match = latest.entry.match(/^worker_session_(\d+)\.log$/);
    if (!match) return null;
    return finiteIntegerOrNull(match[1]);
  } catch {
    return null;
  }
}

const MANAGER_IDLE_BACKOFF_FALLBACK_MIN_MS = 1_000;
const MANAGER_IDLE_BACKOFF_FALLBACK_MAX_MS = 600_000;

/** Single source of truth for the accepted `manager_idle_backoff_fallback_ms` range. */
function isValidManagerIdleBackoffFallbackMs(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= MANAGER_IDLE_BACKOFF_FALLBACK_MIN_MS
    && value <= MANAGER_IDLE_BACKOFF_FALLBACK_MAX_MS;
}

export function resolveManagerIdleBackoffFallbackMs(
  settings: Record<string, unknown> | null,
  fallback = DEFAULT_MANAGER_IDLE_BACKOFF_FALLBACK_MS,
): number {
  const value = settings?.manager_idle_backoff_fallback_ms;
  return isValidManagerIdleBackoffFallbackMs(value) ? value : fallback;
}

function readManagerIdleBackoffFallbackMs(log: (msg: string) => void): number {
  try {
    const settingsPath = path.join(getExtensionRoot(), 'pickle_settings.json');
    const settings = readRecoverableJsonObject(settingsPath) as Record<string, unknown> | null;
    const raw = settings?.manager_idle_backoff_fallback_ms;
    if (settings && raw !== undefined && !isValidManagerIdleBackoffFallbackMs(raw)) {
      log(`WARN: invalid manager_idle_backoff_fallback_ms in settings; using default ${DEFAULT_MANAGER_IDLE_BACKOFF_FALLBACK_MS}ms`);
    }
    return resolveManagerIdleBackoffFallbackMs(settings);
  } catch (err) {
    log(`WARN: failed to read manager_idle_backoff_fallback_ms; using default ${DEFAULT_MANAGER_IDLE_BACKOFF_FALLBACK_MS}ms (${safeErrorMessage(err)})`);
    return DEFAULT_MANAGER_IDLE_BACKOFF_FALLBACK_MS;
  }
}

function buildIdleBackoffEventBase(state: State, stateFile: string): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    session: path.basename(path.dirname(stateFile)),
    ticket: state.current_ticket,
  };
}

function emitStateActivityEntries(stateFile: string, entries: StateActivityEntry[] | undefined): void {
  if (!entries || entries.length === 0) return;
  for (const entry of entries) {
    try {
      writeActivityEntry(stateFile, entry);
    } catch {
      /* fail open */
    }
  }
}

function refreshIdleBackoffStateBaseline(
  state: State,
  stateFile: string,
  entries: StateActivityEntry[] | undefined,
): void {
  if (!entries?.some((entry) => entry.event === 'manager_idle_backoff_engaged')) return;
  const snapshot = readIdleBackoffSnapshot(state);
  if (!snapshot?.engaged_at_ms) return;
  snapshot.state_mtime_ms = readFileMtimeMs(stateFile);
  writeIdleBackoffSnapshot(state, snapshot);
}

function idleBackoffReleaseReason(
  state: State,
  stateFile: string,
  snapshot: IdleBackoffSnapshot,
  nowMs: number,
  fallbackMs: number,
): IdleBackoffReleaseReason | null {
  const currentTicket = state.current_ticket ?? null;
  const stateMtimeMs = readFileMtimeMs(stateFile);
  const artifactMtimeMs = getWorkerArtifactMtimeMs(state);
  const workerPid = snapshot.worker_pid ?? getLatestWorkerPid(state);
  if (snapshot.ticket !== undefined && snapshot.ticket !== currentTicket) return 'state_mtime';
  if (snapshot.state_mtime_ms !== undefined && stateMtimeMs > snapshot.state_mtime_ms) return 'state_mtime';
  if (snapshot.artifact_mtime_ms !== undefined && artifactMtimeMs > snapshot.artifact_mtime_ms) return 'artifact_landed';
  if (!isProcessAlive(workerPid)) return 'worker_exit';
  if (snapshot.engaged_at_ms !== undefined && nowMs - snapshot.engaged_at_ms >= fallbackMs) return 'fallback_timer';
  return null;
}

function releaseIdleBackoffDecision(
  state: State,
  stateFile: string,
  snapshot: IdleBackoffSnapshot,
  releaseReason: IdleBackoffReleaseReason,
  nowMs: number,
): ClassifiedResult {
  writeIdleBackoffSnapshot(
    state,
    releaseReason === 'fallback_timer'
      ? { consecutive_wait_turns: MANAGER_IDLE_BACKOFF_THRESHOLD - 1 }
      : null,
  );
  return {
    decision: 'approve',
    logMessage: `Decision: APPROVE (Idle backoff released: ${releaseReason})`,
    token: { kind: 'none' },
    stateActivityEntries: [{
      event: 'manager_idle_backoff_released',
      ...buildIdleBackoffEventBase(state, stateFile),
      duration_ms: Math.max(0, nowMs - (snapshot.engaged_at_ms ?? nowMs)),
      release_reason: releaseReason,
    }],
  };
}

function engageIdleBackoffDecision(
  state: State,
  stateFile: string,
  nextCount: number,
  nowMs: number,
): ClassifiedResult {
  const engagedSnapshot: IdleBackoffSnapshot = {
    consecutive_wait_turns: nextCount,
    engaged_at_ms: nowMs,
    state_mtime_ms: readFileMtimeMs(stateFile),
    artifact_mtime_ms: getWorkerArtifactMtimeMs(state),
    worker_pid: getLatestWorkerPid(state),
    ticket: state.current_ticket,
  };
  writeIdleBackoffSnapshot(state, engagedSnapshot);
  return {
    decision: 'block',
    reason: `🥒 Idle backoff engaged for ${state.current_ticket} — suppressing stop-hook nudges`,
    logMessage: `Decision: BLOCK (Idle backoff engaged after ${nextCount} wait turns)`,
    token: { kind: 'none' },
    stateActivityEntries: [{
      event: 'manager_idle_backoff_engaged',
      ...buildIdleBackoffEventBase(state, stateFile),
      consecutive_wait_turns: nextCount,
      last_worker_pid: engagedSnapshot.worker_pid ?? null,
    }],
  };
}

export function evaluateManagerIdleBackoff(
  state: State,
  stateFile: string,
  transcript: string,
  role: string,
  log: (msg: string) => void = () => {},
  nowMs = Date.now(),
): ClassifiedResult | null {
  if (!isManagerRole(role) || !state.current_ticket || !state.session_dir) return null;

  const trimmed = transcript.trim();
  const snapshot = readIdleBackoffSnapshot(state);
  if (!isWaitPatternResponse(trimmed)) {
    if (snapshot) writeIdleBackoffSnapshot(state, null);
    return null;
  }

  const fallbackMs = readManagerIdleBackoffFallbackMs(log);
  if (snapshot?.engaged_at_ms) {
    const releaseReason = idleBackoffReleaseReason(state, stateFile, snapshot, nowMs, fallbackMs);
    if (!releaseReason) {
      return {
        decision: 'block',
        reason: `🥒 Idle backoff active for ${state.current_ticket} — waiting for worker signal`,
        logMessage: `Decision: BLOCK (Idle backoff active for ticket ${state.current_ticket})`,
        token: { kind: 'none' },
      };
    }
    return releaseIdleBackoffDecision(state, stateFile, snapshot, releaseReason, nowMs);
  }

  const nextCount = Math.min((snapshot?.consecutive_wait_turns ?? 0) + 1, MANAGER_IDLE_BACKOFF_THRESHOLD);
  if (nextCount < MANAGER_IDLE_BACKOFF_THRESHOLD) {
    writeIdleBackoffSnapshot(state, { consecutive_wait_turns: nextCount });
    return {
      decision: 'block',
      reason: `🥒 Wait-pattern response (${nextCount}/${MANAGER_IDLE_BACKOFF_THRESHOLD}) — continuing`,
      logMessage: `Decision: BLOCK (Wait-pattern response: "${trimmed}" — ${nextCount}/${MANAGER_IDLE_BACKOFF_THRESHOLD})`,
      token: { kind: 'none' },
    };
  }

  return engageIdleBackoffDecision(state, stateFile, nextCount, nowMs);
}

export function detectCompletionTokens(transcript: string, state: State): TokenKind {
  if (state.completion_promise && hasToken(transcript, state.completion_promise)) {
    return { kind: 'completion-promise', promise: state.completion_promise };
  }
  if (hasToken(transcript, PromiseTokens.EPIC_COMPLETED)) return { kind: 'epic-completed' };
  if (hasToken(transcript, PromiseTokens.TASK_COMPLETED)) return { kind: 'task-completed' };
  if (hasToken(transcript, PromiseTokens.ANALYSIS_DONE)) return { kind: 'analysis-done' };
  if (
    hasToken(transcript, PromiseTokens.EXISTENCE_IS_PAIN) ||
    hasToken(transcript, PromiseTokens.THE_CITADEL_APPROVES)
  ) return { kind: 'review-clean' };
  if (hasToken(transcript, PromiseTokens.WORKER_DONE)) return { kind: 'worker-done' };
  if (hasToken(transcript, PromiseTokens.PRD_COMPLETE)) return { kind: 'prd-complete' };
  if (hasToken(transcript, PromiseTokens.TICKET_SELECTED)) return { kind: 'ticket-selected' };
  return { kind: 'none' };
}

export function enforceRateLimitGate(_state: State, transcript: string): HelperResult | null {
  if (
    transcript.length > 0 &&
    transcript.length < 500 &&
    RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(transcript))
  ) {
    return { decision: 'approve' };
  }
  return null;
}

interface LimitMetrics {
  startEpoch: number;
  maxTimeMins: number;
  maxIter: number;
  curIter: number;
  elapsedSeconds: number;
}

/** Single source of truth for the time/iteration limit metrics derived from state. */
function computeLimitMetrics(state: State): LimitMetrics {
  const now = Math.floor(Date.now() / 1000);
  const startEpoch = finiteNumber(state.start_time_epoch);
  const maxTimeMins = finiteNumber(state.max_time_minutes);
  const maxIter = finiteNumber(state.max_iterations);
  const curIter = finiteNumber(state.iteration);
  const elapsedSeconds = startEpoch > 0 ? Math.max(0, now - startEpoch) : 0;
  return { startEpoch, maxTimeMins, maxIter, curIter, elapsedSeconds };
}

export function enforceLimits(state: State): HelperResult | null {
  const { startEpoch, maxTimeMins, maxIter, curIter, elapsedSeconds } = computeLimitMetrics(state);

  if (maxIter > 0 && curIter >= maxIter) {
    return { decision: 'approve' };
  }
  if (maxTimeMins > 0 && startEpoch > 0 && elapsedSeconds >= maxTimeMins * 60) {
    return { decision: 'approve' };
  }
  return null;
}

/**
 * B-RSHM WS-1: the consecutive-short-response BLOCK-nudge counter was retired with the
 * interactive (non-tmux) loop. Degenerate output (whitespace-only, no-op ack, or short
 * response) now APPROVES unconditionally — under tmux the manager exits and mux-runner
 * owns the respawn. The old State counter field is retained as optional with no runtime
 * writer (no schema bump).
 */
export function detectDegenerateResponse(_state: State, transcript: string, _role = ''): HelperResult | null {
  const trimmed = transcript.trim();
  if (isWhitespaceOnlyResponse(transcript, trimmed) || isNoOpResponse(trimmed) || isShortResponse(trimmed)) {
    return { decision: 'approve' };
  }
  return null;
}

export function classifyDecision(state: State, transcript: string, role: string): HelperResult {
  return classifyDecisionInternal(state, transcript, role);
}

function classifyDecisionInternal(state: State, transcript: string, role: string): ClassifiedResult {
  const token = detectCompletionTokens(transcript, state);
  const isWorkerRole = role === 'worker' || role === 'refinement-worker';
  if (roleAllowsToken(token, role) && token.kind !== 'none') {
    const tokenDecision = classifyTokenDecision(state, token, isWorkerRole);
    if (tokenDecision) return tokenDecision;
  }

  const rateLimit = enforceRateLimitGate(state, transcript);
  if (rateLimit) {
    return { ...rateLimit, logMessage: 'Decision: APPROVE (Rate limit detected — handing off to runner for backoff)', token };
  }

  const limitDecision = classifyLimitDecision(state);
  if (limitDecision) return limitDecision;

  const degenerateDecision = classifyDegenerateDecision(state, transcript, role);
  if (degenerateDecision) return degenerateDecision;

  if (state.tmux_mode === true) {
    return {
      decision: 'approve',
      logMessage: 'Decision: APPROVE (tmux owns this loop, launcher may stop)',
      token,
    };
  }
  // B-RSHM WS-1: interactive /pickle is gone and tmux is the sole launch path, so the
  // non-tmux default-continuation BLOCK is dead machinery — approve unconditionally.
  const maxIter = finiteNumber(state.max_iterations);
  const curIter = finiteNumber(state.iteration);
  const iterSuffix = maxIter > 0 ? ` of ${maxIter}` : '';
  return {
    decision: 'approve',
    logMessage: `Decision: APPROVE (Interactive loop retired — non-tmux default approve, iteration ${curIter}${iterSuffix})`,
    token,
  };
}

function classifyTokenDecision(state: State, token: TokenKind, isWorkerRole: boolean): ClassifiedResult | null {
  if (token.kind === 'review-clean') {
    const minIter = finiteNumber(state.min_iterations);
    const curIter = finiteNumber(state.iteration);
    if (minIter > 0 && curIter < minIter) {
      return {
        decision: 'approve',
        logMessage: `Decision: APPROVE (review_clean at ${curIter}/${minIter} — below min, runner continues)`,
        token,
      };
    }
  }
  if (token.kind === 'prd-complete' || token.kind === 'ticket-selected') {
    return { decision: 'approve', logMessage: 'Decision: APPROVE (checkpoint — runner will respawn for next phase)', token };
  }

  return {
    decision: 'approve',
    logMessage: 'Decision: APPROVE (Task/Worker complete)',
    token,
    activity: tokenActivity(token, isWorkerRole),
  };
}

function tokenActivity(token: TokenKind, isWorkerRole: boolean): ActivityKind | undefined {
  if (token.kind === 'review-clean') return 'review-clean';
  if (token.kind === 'epic-completed') return 'epic-completed';
  if (token.kind === 'task-completed' && !isWorkerRole) return 'ticket-completed';
  return undefined;
}

function classifyLimitDecision(state: State): ClassifiedResult | null {
  const { maxTimeMins, maxIter, curIter, elapsedSeconds } = computeLimitMetrics(state);
  const limitResult = enforceLimits(state);
  if (!limitResult) return null;

  if (maxIter > 0 && curIter >= maxIter) {
    return {
      ...limitResult,
      logMessage: `Decision: APPROVE (Max iterations reached: ${curIter}/${maxIter})`,
      token: { kind: 'none' },
    };
  }
  return {
    ...limitResult,
    logMessage: `Decision: APPROVE (Time limit reached: ${elapsedSeconds}/${maxTimeMins * 60}s)`,
    token: { kind: 'none' },
  };
}

function classifyDegenerateDecision(state: State, transcript: string, role: string): ClassifiedResult | null {
  const result = detectDegenerateResponse(state, transcript, role);
  if (!result) return null;

  const trimmed = transcript.trim();
  const whitespaceOnly = isWhitespaceOnlyResponse(transcript, trimmed);
  if (whitespaceOnly || isNoOpResponse(trimmed)) {
    const reason = whitespaceOnly
      ? `Whitespace-only response — ${transcript.length} raw chars`
      : `No-op response detected: "${trimmed}" — breaking ack loop`;
    return { ...result, logMessage: `Decision: APPROVE (${reason})`, token: { kind: 'none' } };
  }
  return {
    ...result,
    logMessage: `Decision: APPROVE (Degenerate short response: "${trimmed}" — ${trimmed.length} chars)`,
    token: { kind: 'none' },
  };
}

function isCompletionToken(token: TokenKind): boolean {
  return [
    'completion-promise',
    'epic-completed',
    'task-completed',
    'analysis-done',
    'review-clean',
    'worker-done',
  ].includes(token.kind);
}

function emitActivity(decision: ClassifiedResult, state: State, stateFile: string, isWorker: boolean): void {
  if (!decision.activity) return;
  const sessionId = path.basename(path.dirname(stateFile));
  if (decision.activity === 'review-clean') {
    logActivity({ event: 'meeseeks_pass', source: 'pickle', session: sessionId, pass: Number(state.iteration) || undefined });
  } else if (decision.activity === 'epic-completed') {
    logActivity({ event: 'epic_completed', source: 'pickle', session: sessionId, epic: state.original_prompt || undefined });
  } else if (decision.activity === 'ticket-completed' && !isWorker) {
    logActivity({ event: 'ticket_completed', source: 'pickle', session: sessionId, ticket: state.current_ticket || undefined, step: state.step });
  }
}

function promiseSummary(transcript: string, state: State, role: string): string {
  const isWorker = role === 'worker';
  const isRefinementWorker = role === 'refinement-worker';
  const hasPromise = !!state.completion_promise && hasToken(transcript, state.completion_promise);
  const isEpicDone = hasToken(transcript, PromiseTokens.EPIC_COMPLETED);
  const isTaskFinished = hasToken(transcript, PromiseTokens.TASK_COMPLETED);
  const isAnalysisDone = isRefinementWorker && hasToken(transcript, PromiseTokens.ANALYSIS_DONE);
  const isExistenceIsPain = hasToken(transcript, PromiseTokens.EXISTENCE_IS_PAIN) ||
    hasToken(transcript, PromiseTokens.THE_CITADEL_APPROVES);
  const isWorkerDone = isWorker && hasToken(transcript, PromiseTokens.WORKER_DONE);
  const isPrdDone = !isWorker && hasToken(transcript, PromiseTokens.PRD_COMPLETE);
  const isTicketSelected = !isWorker && hasToken(transcript, PromiseTokens.TICKET_SELECTED);
  return `Promises(${PROMISE_TOKENS.length}): hasPromise=${hasPromise}, isEpicDone=${isEpicDone}, isTaskFinished=${isTaskFinished}, isWorkerDone=${isWorkerDone}, isAnalysisDone=${isAnalysisDone}, isExistenceIsPain=${isExistenceIsPain}, isPrdDone=${isPrdDone}, isTicketSelected=${isTicketSelected}`;
}

function maybeSpawnUpdateCheck(extensionDir: string, log: (msg: string) => void): void {
  const checkUpdatePath = path.join(extensionDir, 'extension', 'bin', 'check-update.js');
  if (!fs.existsSync(checkUpdatePath)) {
    log('check-update.js not found, skipping update check');
    return;
  }
  let settings: Record<string, unknown> | null = null;
  try {
    const settingsPath = path.join(extensionDir, 'pickle_settings.json');
    settings = readRecoverableJsonObject(settingsPath) as Record<string, unknown> | null;
    if (settings?.auto_update_enabled === false) {
      log('Auto-update disabled in settings, skipping');
      return;
    }
  } catch {
    // Settings missing/corrupted — default to enabled
  }
  const intervalHours = settings?.update_check_interval_hours;
  const configuredSeconds = typeof intervalHours === 'number' && Number.isFinite(intervalHours) && intervalHours > 0
    ? intervalHours * 3_600
    : 60;
  const spawnIntervalSeconds = Math.max(60, configuredSeconds);
  const spawnEpochPath = path.join(extensionDir, 'last-check-spawn.epoch');
  const nowEpoch = Math.floor(Date.now() / 1000);
  try {
    const lastSpawnEpoch = Number(fs.readFileSync(spawnEpochPath, 'utf8').trim());
    if (Number.isFinite(lastSpawnEpoch) && lastSpawnEpoch > 0 && nowEpoch - lastSpawnEpoch < spawnIntervalSeconds) {
      log('check-update spawn skipped: rate-limited');
      return;
    }
  } catch {
    // Missing/unreadable spawn marker — allow this spawn.
  }
  try { fs.writeFileSync(spawnEpochPath, `${nowEpoch}\n`); } catch { /* ignore marker write failure */ }
  log('Spawning detached check-update process');
  const child = spawn('node', [checkUpdatePath], { detached: true, stdio: 'ignore' });
  child.on('error', (err) => {
    log(`check-update spawn error: ${safeErrorMessage(err)}`);
  });
  child.unref();
}

function createHookLogger(extensionDir: string): {
  log: (msg: string) => void;
  setSessionHooksLog: (file: string) => void;
} {
  const globalDebugLog = path.join(extensionDir, 'debug.log');
  let sessionHooksLog: string | null = null;
  const log = (msg: string) => {
    const ts = new Date().toISOString();
    const formatted = `[${ts}] [StopHookJS] ${msg}\n`;
    try { fs.appendFileSync(globalDebugLog, formatted); } catch { /* ignore */ }
    if (sessionHooksLog) {
      try { fs.appendFileSync(sessionHooksLog, formatted); } catch { /* ignore */ }
    }
  };
  return { log, setSessionHooksLog: (file: string) => { sessionHooksLog = file; } };
}

function approveIfDisabled(extensionDir: string, log: (msg: string) => void): boolean {
  const disabledMarker = path.join(extensionDir, 'disabled');
  try {
    if (fs.existsSync(disabledMarker)) {
      approve();
      return true;
    }
  } catch {
    log('Disabled marker check failed; continuing fail-open path');
  }
  return false;
}

function readHookInput(log: (msg: string) => void): { input: HookInput; inputData: string } | null {
  let inputData: string;
  try {
    inputData = fs.readFileSync(0, 'utf8');
  } catch {
    log('Failed to read stdin');
    approve();
    return null;
  }

  if (!inputData.trim()) {
    approve();
    return null;
  }

  try {
    return { input: JSON.parse(inputData) as HookInput, inputData };
  } catch {
    const preview = inputData.slice(0, 100);
    const ellipsis = inputData.length > 100 ? '...' : '';
    log(`WARN: corrupted hook input, approving fail-open. First 100 chars: "${preview}"${ellipsis}`);
    approve();
    return null;
  }
}

function readHookState(
  log: (msg: string) => void,
  setSessionHooksLog: (file: string) => void,
): { stateFile: string; state: State } | null {
  const stateFile = resolveStateFile(getDataRoot());
  if (!stateFile) {
    log(`No state file found.`);
    approve();
    return null;
  }

  setSessionHooksLog(path.join(path.dirname(stateFile), 'hooks.log'));
  log(`State file found: ${stateFile}`);
  try {
    return { stateFile, state: sm.read(stateFile) };
  } catch {
    log('Failed to parse state.json');
    approve();
    return null;
  }
}

function approveEarlyIfNeeded(state: State, log: (msg: string) => void): boolean {
  if (state.working_dir && !sameWorkingDir(state.working_dir, process.cwd())) {
    log(`CWD Mismatch: ${process.cwd()} !== ${state.working_dir}`);
    approve();
    return true;
  }
  if (state.active !== true) {
    log('Decision: APPROVE (Session inactive)');
    approve();
    return true;
  }
  if (state.tmux_mode === true && !process.env.PICKLE_STATE_FILE) {
    log('Decision: APPROVE (tmux mode — main window defers to tmux-runner)');
    approve();
    return true;
  }
  return false;
}

function finalizeHookDecision(
  decision: ClassifiedResult,
  state: State,
  stateFile: string,
  extensionDir: string,
  isWorker: boolean,
  log: (msg: string) => void,
): void {
  emitStateActivityEntries(stateFile, decision.stateActivityEntries);
  refreshIdleBackoffStateBaseline(state, stateFile, decision.stateActivityEntries);

  if (decision.decision === 'approve') {
    if (isCompletionToken(decision.token)) maybeSpawnUpdateCheck(extensionDir, log);
    emitActivity(decision, state, stateFile, isWorker);
    approve();
    return;
  }

  console.log(JSON.stringify({ decision: 'block', reason: decision.reason }));
}

async function main() {
  const extensionDir = getExtensionRoot();
  const { log, setSessionHooksLog } = createHookLogger(extensionDir);
  if (approveIfDisabled(extensionDir, log)) return;

  const hookInput = readHookInput(log);
  if (!hookInput) return;
  const { input, inputData } = hookInput;
  log(`Processing Stop hook. Input size: ${inputData.length}`);

  const hookState = readHookState(log, setSessionHooksLog);
  if (!hookState) return;
  const { stateFile, state } = hookState;
  const role = process.env.PICKLE_ROLE;
  const isWorker = role === 'worker';
  log(`State: active=${state.active}, iteration=${state.iteration}/${state.max_iterations}`);
  log(`Context: role=${role}, isWorker=${isWorker}, cwd=${process.cwd()}`);
  if (approveEarlyIfNeeded(state, log)) return;

  const responseText = input.last_assistant_message || input.prompt_response || '';
  log(`Agent response received (${responseText.length} chars)`);
  const decision = evaluateManagerIdleBackoff(state, stateFile, responseText, role || '', log)
    ?? classifyDecisionInternal(state, responseText, role || '');
  log(promiseSummary(responseText, state, role || ''));
  log(decision.logMessage);
  finalizeHookDecision(decision, state, stateFile, extensionDir, isWorker, log);
}

function handleFatalStopHookError(err: unknown): void {
  try {
    const extensionDir = getExtensionRoot();
    const debugLog = path.join(extensionDir, 'debug.log');
    const detail = err instanceof Error ? err.stack || err.message : String(err);
    fs.appendFileSync(debugLog, `[FATAL] ${detail}\n`);
  } catch {
    /* ignore */
  }
  approve();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(handleFatalStopHookError);
}

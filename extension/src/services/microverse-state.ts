import * as path from 'path';
import * as crypto from 'node:crypto';
import type { MicroverseSessionState, MicroverseHistoryEntry, CreateMicroverseOpts, FailureClass, Violation, JudgeResult } from '../types/index.js';
import { isRecord } from '../lib/is-record.js';
import { StateManager } from './state-manager.js';
import { safeErrorMessage } from './pickle-utils.js';
import { readRecoverableJsonObject } from './recoverable-json.js';
export { readRecoverableJsonObject } from './recoverable-json.js';

const sm = new StateManager();

const MICROVERSE_FILE = 'microverse.json';

const MICROVERSE_STATUSES = new Set(['gap_analysis', 'iterating', 'converged', 'stopped']);
const METRIC_TYPES = new Set(['command', 'llm', 'none']);
const METRIC_DIRECTIONS = new Set(['higher', 'lower']);
const CONVERGENCE_MODES = new Set(['metric', 'worker']);

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid microverse state: ${field} must be a string`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid microverse state: ${field} must be a finite number`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Invalid microverse state: ${field} must be an array of strings`);
  }
  return value;
}

function requireRecordArray(value: unknown, field: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((entry) => !isRecord(entry))) {
    throw new Error(`Invalid microverse state: ${field} must be an array of objects`);
  }
  return value;
}

function assertOptionalBoolean(state: Record<string, unknown>, field: string): void {
  if (state[field] !== undefined && typeof state[field] !== 'boolean') {
    throw new Error(`Invalid microverse state: ${field} must be a boolean when present`);
  }
}

function assertOptionalFiniteNumber(state: Record<string, unknown>, field: string): void {
  if (state[field] !== undefined) requireFiniteNumber(state[field], field);
}

function assertOptionalString(state: Record<string, unknown>, field: string): void {
  if (state[field] !== undefined) requireString(state[field], field);
}

function assertMicroverseMetricShape(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error('Invalid microverse state: key_metric must be an object for microverse mode');
  }
  requireString(value.description, 'key_metric.description');
  requireString(value.validation, 'key_metric.validation');
  if (typeof value.type !== 'string' || !METRIC_TYPES.has(value.type)) {
    throw new Error('Invalid microverse state: key_metric.type must be one of command, llm, or none');
  }
  requireFiniteNumber(value.timeout_seconds, 'key_metric.timeout_seconds');
  requireFiniteNumber(value.tolerance, 'key_metric.tolerance');
  if (value.direction !== undefined && (typeof value.direction !== 'string' || !METRIC_DIRECTIONS.has(value.direction))) {
    throw new Error('Invalid microverse state: key_metric.direction must be higher or lower when present');
  }
  if (value.judge_model !== undefined && typeof value.judge_model !== 'string') {
    throw new Error('Invalid microverse state: key_metric.judge_model must be a string when present');
  }
}

function readCommandTemplate(sessionDir: string): string | undefined {
  try {
    const state = readRecoverableJsonObject(path.join(sessionDir, 'state.json')) as Record<string, unknown> | null;
    return typeof state?.command_template === 'string' ? state.command_template : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export function assertMicroverseStateShape(
  parsed: unknown,
  commandTemplate?: string
): MicroverseSessionState {
  if (!isRecord(parsed)) {
    throw new Error('Invalid microverse state: root must be an object');
  }

  if (typeof parsed.status !== 'string' || !MICROVERSE_STATUSES.has(parsed.status)) {
    throw new Error('Invalid microverse state: status must be gap_analysis, iterating, converged, or stopped');
  }
  requireString(parsed.prd_path, 'prd_path');

  const convergence = parsed.convergence;
  if (!isRecord(convergence)) {
    throw new Error('Invalid microverse state: convergence must be an object');
  }
  requireFiniteNumber(convergence.stall_limit, 'convergence.stall_limit');
  requireFiniteNumber(convergence.stall_counter, 'convergence.stall_counter');
  requireRecordArray(convergence.history, 'convergence.history');

  requireString(parsed.gap_analysis_path, 'gap_analysis_path');
  requireStringArray(parsed.failed_approaches, 'failed_approaches');
  requireFiniteNumber(parsed.baseline_score, 'baseline_score');
  requireRecordArray(parsed.failure_history, 'failure_history');
  if (typeof parsed.approach_exhaustion_fired !== 'boolean') {
    throw new Error('Invalid microverse state: approach_exhaustion_fired must be a boolean');
  }

  if (parsed.convergence_mode !== undefined && (typeof parsed.convergence_mode !== 'string' || !CONVERGENCE_MODES.has(parsed.convergence_mode))) {
    throw new Error('Invalid microverse state: convergence_mode must be metric or worker when present');
  }
  assertOptionalString(parsed, 'convergence_file');
  assertOptionalString(parsed, 'judge_context_path');
  assertOptionalString(parsed, 'exit_reason');
  assertOptionalString(parsed, 'stash_ref');
  assertOptionalFiniteNumber(parsed, 'convergence_target');
  assertOptionalFiniteNumber(parsed, 'iteration_regressions');
  assertOptionalFiniteNumber(parsed, 'consecutive_amnesiac_exits');
  assertOptionalFiniteNumber(parsed, 'consecutive_subprocess_errors');
  assertOptionalBoolean(parsed, 'gate_regression_threshold_warning_emitted');
  if (parsed.allowed_paths !== undefined) requireStringArray(parsed.allowed_paths, 'allowed_paths');

  const anatomyParkWorkerMode = commandTemplate === 'anatomy-park.md' && parsed.convergence_mode === 'worker';
  if (parsed.key_metric === undefined) {
    if (!anatomyParkWorkerMode) {
      throw new Error('Invalid microverse state: key_metric is required for microverse mode');
    }
  } else {
    assertMicroverseMetricShape(parsed.key_metric);
  }

  return parsed as unknown as MicroverseSessionState;
}

export type LedgerSnapshot = { resolved: string[]; new: string[]; remaining: string[] };

function compareMetricSetOps(ledger: LedgerSnapshot): 'improved' | 'held' | 'regressed' {
  const resolvedSet = new Set(ledger.resolved);
  const remainingSet = new Set(ledger.remaining);
  const newSet = new Set(ledger.new);
  const intersectionSize = ledger.new.filter(id => remainingSet.has(id)).length;
  if (newSet.size > resolvedSet.size) return 'regressed';
  if (resolvedSet.size > 0 && intersectionSize === 0) return 'improved';
  return 'held';
}

function compareMetricNumeric(
  current: number, previous: number, tolerance: number, direction?: 'higher' | 'lower'
): 'improved' | 'held' | 'regressed' {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || !Number.isFinite(tolerance)) {
    return 'held';
  }
  if ((direction ?? 'higher') === 'lower') {
    if (current < previous - tolerance) return 'improved';
    if (current > previous + tolerance) return 'regressed';
    return 'held';
  }
  if (current > previous + tolerance) return 'improved';
  if (current < previous - tolerance) return 'regressed';
  return 'held';
}

/**
 * A ledger snapshot is usable comparison context only when it actually holds ids.
 *
 * PRESENCE IS NOT POPULATION. `microverse-runner.ts` builds `previousLedger` from
 * `state.violation_ledger`, which is empty until the first `updateViolationLedger` call — so on the
 * first scored iteration it is `{resolved:[],new:[],remaining:[]}`: defined, and carrying nothing.
 * The judge's own contract (`buildJudgePrompt`: "when there is no such list, `resolved` and
 * `remaining` are `[]` and every id goes in `new`") then makes the set-ops branch read that first
 * pass as `new > resolved` -> 'regressed' no matter how much the score improved.
 *
 * Total by construction (non-array fields answer false, never throw), which is what lets both
 * callers below share it in place of the two try/catch fall-throughs they used to carry.
 */
function hasLedgerContext(ledger?: LedgerSnapshot): ledger is LedgerSnapshot {
  if (ledger === undefined) return false;
  const { resolved, new: added, remaining } = ledger;
  if (!Array.isArray(resolved) || !Array.isArray(added) || !Array.isArray(remaining)) return false;
  return resolved.length + added.length + remaining.length > 0;
}

export function compareMetric(
  current: number,
  previous: number,
  tolerance: number,
  direction?: 'higher' | 'lower',
  currentLedger?: LedgerSnapshot,
  previousLedger?: LedgerSnapshot,
): 'improved' | 'held' | 'regressed' {
  if (hasLedgerContext(currentLedger)) {
    if (hasLedgerContext(previousLedger)) return compareMetricSetOps(currentLedger);
    // No prior ledger to diff against: compare this pass's violation count to the numeric score.
    const violationCount = currentLedger.remaining.length + currentLedger.new.length;
    if (violationCount < previous) return 'improved';
  }
  return compareMetricNumeric(current, previous, tolerance, direction);
}

function assertCreateMicroverseOpts(opts: CreateMicroverseOpts): void {
  const { metric, stallLimit, convergenceTarget } = opts;
  if (!Number.isInteger(stallLimit) || stallLimit < 1) {
    throw new Error(`stall_limit must be a positive integer, got ${stallLimit}`);
  }
  if (!Number.isFinite(metric.tolerance) || metric.tolerance < 0) {
    throw new Error(`tolerance must be a non-negative number, got ${metric.tolerance}`);
  }
  if (metricRequiresTimeout(metric.type) && (!Number.isFinite(metric.timeout_seconds) || metric.timeout_seconds <= 0)) {
    throw new Error(`timeout_seconds must be a positive finite number for ${metric.type} metrics, got ${metric.timeout_seconds}`);
  }
  if (convergenceTarget != null && !Number.isFinite(convergenceTarget)) {
    throw new Error(`convergence_target must be a finite number, got ${convergenceTarget}`);
  }
}

function metricRequiresTimeout(type: string): boolean {
  return type === 'command' || type === 'llm';
}

function withOptionalMicroverseStateFields(
  state: MicroverseSessionState,
  opts: CreateMicroverseOpts
): MicroverseSessionState {
  const { convergenceTarget, convergenceMode, convergenceFile, allowedPaths } = opts;
  if (convergenceTarget != null) state.convergence_target = convergenceTarget;
  if (convergenceMode != null) state.convergence_mode = convergenceMode;
  if (convergenceFile != null) state.convergence_file = convergenceFile;
  if (allowedPaths != null && allowedPaths.length > 0) state.allowed_paths = allowedPaths;
  return state;
}

export function createMicroverseState(opts: CreateMicroverseOpts): MicroverseSessionState {
  assertCreateMicroverseOpts(opts);
  const { prdPath, metric, stallLimit } = opts;
  const state: MicroverseSessionState = {
    status: 'gap_analysis',
    prd_path: prdPath,
    key_metric: { ...metric, direction: metric.direction ?? 'higher' },
    convergence: {
      stall_limit: stallLimit,
      stall_counter: 0,
      history: [],
    },
    gap_analysis_path: '',
    failed_approaches: [],
    baseline_score: 0,
    failure_history: [],
    approach_exhaustion_fired: false,
    iteration_regressions: 0,
    gate_regression_threshold_warning_emitted: false,
    consecutive_subprocess_errors: 0,
    violation_ledger: [],
  };
  return withOptionalMicroverseStateFields(state, opts);
}

/**
 * Record a scored iteration (agent made commits and metric was measured).
 * Stall counter resets on accepted improvements, increments otherwise.
 *
 * The optional `classification` parameter allows the caller to pass the
 * already-computed compareMetric result, avoiding a redundant (and
 * potentially inconsistent) re-classification inside this function.
 */
export function recordIteration(
  state: MicroverseSessionState,
  entry: MicroverseHistoryEntry,
  classification?: 'improved' | 'held' | 'regressed'
): MicroverseSessionState {
  const history = [...(state.convergence?.history ?? []), entry];
  if (!classification) {
    const previousScore = getLastAcceptedScore(state);
    classification = compareMetric(entry.score, previousScore, state.key_metric.tolerance, state.key_metric.direction);
  }
  entry.classification = classification;
  const stallCounter = entry.action === 'accept' && classification === 'improved'
    ? 0
    : state.convergence.stall_counter + 1;

  return {
    ...state,
    consecutive_amnesiac_exits: 0,
    convergence: {
      ...state.convergence,
      history,
      stall_counter: stallCounter,
    },
  };
}

/**
 * Record a stall (no commits or metric unmeasurable). Increments stall_counter
 * without adding a history entry. This is the ONLY place stall_counter is
 * incremented outside of recordIteration — centralizing stall logic.
 */
export function recordStall(state: MicroverseSessionState): MicroverseSessionState {
  return {
    ...state,
    consecutive_amnesiac_exits: 0,
    convergence: {
      ...state.convergence,
      stall_counter: state.convergence.stall_counter + 1,
    },
  };
}

export function recordAmnesiacExit(state: MicroverseSessionState): MicroverseSessionState {
  return {
    ...state,
    consecutive_amnesiac_exits: (state.consecutive_amnesiac_exits ?? 0) + 1,
  };
}

export function clearAmnesiacExits(state: MicroverseSessionState): MicroverseSessionState {
  if ((state.consecutive_amnesiac_exits ?? 0) === 0) return state;
  return {
    ...state,
    consecutive_amnesiac_exits: 0,
  };
}

export function recordFailedApproach(
  state: MicroverseSessionState,
  description: string
): MicroverseSessionState {
  const approaches = [...state.failed_approaches, description];
  if (approaches.length > 100) approaches.shift();
  return {
    ...state,
    failed_approaches: approaches,
  };
}

export function findLastAcceptedEntry(
  history: MicroverseHistoryEntry[],
): MicroverseHistoryEntry | undefined {
  return [...history].reverse().find(h => h.action === 'accept');
}

export function getLastAcceptedScore(state: MicroverseSessionState): number {
  const lastAccepted = findLastAcceptedEntry(state.convergence?.history ?? []);
  return lastAccepted ? lastAccepted.score : state.baseline_score;
}

function hasOscillatingClassifications(history: MicroverseHistoryEntry[]): boolean {
  if (history.length < 3) return false;
  const last3 = history.slice(-3).map(h => h.classification);
  return (
    (last3[0] === 'improved' && last3[1] === 'regressed' && last3[2] === 'improved') ||
    (last3[0] === 'regressed' && last3[1] === 'improved' && last3[2] === 'regressed')
  );
}

function hasHeldStreak(history: MicroverseHistoryEntry[]): boolean {
  if (history.length < 3) return false;
  return history.slice(-3).map(h => h.classification).every(c => c === 'held');
}

function hasApproachExhaustion(mvState: MicroverseSessionState): boolean {
  return mvState.failed_approaches.length >= 3 &&
    mvState.convergence.stall_counter >= mvState.convergence.stall_limit / 2;
}

export function classifyFailure(
  mvState: MicroverseSessionState,
  metricResult: { raw: string; score: number } | null,
  preIterSha: string,
  postIterSha: string,
): FailureClass | null {
  // 1. tool_failure — metric measurement itself failed
  if (metricResult === null) return 'tool_failure';

  // Check if this iteration improved
  const history = mvState.convergence?.history ?? [];
  const classification = compareMetric(
    metricResult.score, getLastAcceptedScore(mvState),
    mvState.key_metric.tolerance, mvState.key_metric.direction,
  );
  if (classification === 'improved') return null;

  // 2. metric_unstable — alternating improve/regress in last 3 entries
  if (hasOscillatingClassifications(history)) return 'metric_unstable';

  // 3. regression — score went backwards
  if (classification === 'regressed') return 'regression';

  // 4. approach_exhaustion — tried many things, none stick
  if (hasApproachExhaustion(mvState)) return 'approach_exhaustion';

  // 5. no_progress — no commits or 3+ consecutive 'held'
  if (preIterSha === postIterSha) return 'no_progress';
  if (hasHeldStreak(history)) return 'no_progress';

  return null;
}

export function isConverged(state: MicroverseSessionState): 'target' | 'stall' | null {
  if (state.convergence.stall_counter >= state.convergence.stall_limit) return 'stall';
  // Early exit: if a convergence_target is set and score has reached (or passed) it, we're done.
  // Direction-aware: for 'lower', score <= target; for 'higher', score >= target.
  if (state.convergence_target != null) {
    const currentScore = getLastAcceptedScore(state);
    const direction = state.key_metric.direction ?? 'higher';
    if (direction === 'lower'
      ? currentScore <= state.convergence_target
      : currentScore >= state.convergence_target) return 'target';
  }
  return null;
}

export function writeMicroverseState(
  sessionDir: string,
  state: MicroverseSessionState
): void {
  // microverse.json is not a State file but uses atomic writes for consistency.
  // Uses forceWrite to avoid lock overhead — microverse state is single-writer.
  sm.forceWrite(path.join(sessionDir, MICROVERSE_FILE), state);
}

export function readMicroverseState(
  sessionDir: string
): MicroverseSessionState | null {
  const filePath = path.join(sessionDir, MICROVERSE_FILE);
  try {
    const parsed = readRecoverableJsonObject(filePath) as Record<string, unknown> | null;
    if (!parsed) return null;
    parsed.failure_history ??= [];
    parsed.approach_exhaustion_fired ??= false;
    parsed.iteration_regressions ??= 0;
    parsed.gate_regression_threshold_warning_emitted ??= false;
    parsed.consecutive_subprocess_errors ??= 0;
    parsed.violation_ledger ??= [];
    return assertMicroverseStateShape(parsed, readCommandTemplate(sessionDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    const msg = safeErrorMessage(err);
    console.error(`[microverse-state] Failed to read ${filePath}: ${msg}`);
    return null;
  }
}

export function generateViolationId(violation: Violation): string {
  const { id, path: vPath = '', line = 0, rule = '' } = violation;
  const isArch = vPath === '<arch>' || rule.startsWith('arch:');
  if (isArch) {
    const ruleId = rule.startsWith('arch:') ? rule.slice(5) : rule;
    return `module:${id}:rule:${ruleId}`;
  }
  return crypto.createHash('sha1').update(`${vPath}:${line}:${rule}`).digest('hex').slice(0, 8);
}

export function updateViolationLedger(
  state: MicroverseSessionState,
  judgeResult: JudgeResult,
  iter: number
): void {
  if (!Array.isArray(judgeResult.violations)) {
    throw new Error('updateViolationLedger: judgeResult.violations must be an array');
  }
  const priorLedger = state.violation_ledger ?? [];
  const nextLedger: MicroverseSessionState['violation_ledger'] = [];
  for (const violation of judgeResult.violations) {
    const generatedId = generateViolationId(violation);
    const vLine = violation.line ?? 0;
    const existing = priorLedger.find(
      (e) => e.path === (violation.path ?? '') && e.rule === (violation.rule ?? '') &&
        Math.abs((e.line ?? 0) - vLine) <= 5
    );
    if (existing) {
      nextLedger.push({
        ...existing,
        path: violation.path,
        line: violation.line,
        rule: violation.rule,
        severity: violation.severity,
        description: violation.description,
        last_seen_iter: iter,
      });
    } else {
      nextLedger.push({
        id: generatedId,
        path: violation.path,
        line: violation.line,
        rule: violation.rule,
        first_seen_iter: iter,
        last_seen_iter: iter,
        severity: violation.severity,
        description: violation.description,
      });
    }
  }
  state.violation_ledger = nextLedger;
}

export function resolveStallLimit(metricType: string, settings: Record<string, unknown> | null): number {
  if (metricType !== 'llm') return 5;
  if (settings !== null &&
      typeof settings.stall_limit_llm === 'number' &&
      Number.isInteger(settings.stall_limit_llm) &&
      settings.stall_limit_llm > 0) {
    return settings.stall_limit_llm;
  }
  return 15;
}

import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StringDecoder } from 'string_decoder';
import { State, VALID_STEPS, LockError, SessionMapEntry, UNBOUNDED_READ_MAX_BUFFER, type ActivityEvent, type PickleSettings, type Backend, type HardeningSettings, type CodegraphSettings, type RateLimitSettings } from '../types/index.js';
import { StateManager, isProcessAlive, inspectLockFile, stealLockFile, acquireLockFile, releaseLockFile, isDeadPidPayload, withStealRight } from './state-manager.js';
import { readRecoverableJsonObject } from './recoverable-json.js';
import { updateTicketStatusInTransaction } from './transaction-ticket-ops.js';
import { isRecord } from '../lib/is-record.js';

let stateWriteSeq = 0;

type JudgeBackendChoice = 'claude' | 'codex' | 'auto';
type BackendFallback = 'claude' | 'codex' | null;

interface JudgeMeasurementError {
  failureKind?: string;
  cause_code?: string | null;
  elapsed_ms?: number;
}

const DEFAULT_MICROVERSE_SETTINGS = {
  judge_backend: 'claude' as const,
  judge_backend_fallback: 'codex' as const,
  judge_model_claude: 'claude-sonnet-4-6',
  judge_model_codex: 'gpt-5.4',
} as const;

function isJudgeBackendValue(value: unknown): value is JudgeBackendChoice {
  return value === 'claude' || value === 'codex' || value === 'auto';
}

function isBackendFallbackValue(value: unknown): value is Exclude<JudgeBackendChoice, 'auto'> {
  return value === 'claude' || value === 'codex';
}

function resolveJudgeBackendChoice(value: unknown): JudgeBackendChoice | null {
  return isJudgeBackendValue(value) ? value : null;
}

function resolveBackendFallback(value: unknown): BackendFallback {
  return isBackendFallbackValue(value) ? value : null;
}

function isTypedFailure(failure?: JudgeMeasurementError): boolean {
  return !!failure && isRecord(failure) && typeof failure.failureKind === 'string';
}

/**
 * Reads the `microverse` block out of a settings bag, substituting
 * `DEFAULT_MICROVERSE_SETTINGS` for every field that is absent, mistyped, or
 * blank. A null/malformed bag yields the full defaults.
 */
export function getMicroverseSettings(
  settings: PickleSettings | null,
): {
  judge_backend: JudgeBackendChoice;
  judge_backend_fallback: BackendFallback;
  judge_model_claude: string;
  judge_model_codex: string;
} {
  const microverse = isRecord(settings) && isRecord((settings as Record<string, unknown>).microverse)
    ? (settings as Record<string, unknown>).microverse as Record<string, unknown>
    : {};

  const configuredBackend = resolveJudgeBackendChoice(microverse['judge_backend']) ?? DEFAULT_MICROVERSE_SETTINGS.judge_backend;
  const configuredFallback = resolveBackendFallback(microverse['judge_backend_fallback']);
  const codexModel = microverse['judge_model_codex'];
  const claudeModel = microverse['judge_model_claude'];

  return {
    judge_backend: configuredBackend,
    judge_backend_fallback: configuredFallback ?? DEFAULT_MICROVERSE_SETTINGS.judge_backend_fallback,
    judge_model_claude: typeof claudeModel === 'string' && claudeModel.trim() ? claudeModel : DEFAULT_MICROVERSE_SETTINGS.judge_model_claude,
    judge_model_codex: typeof codexModel === 'string' && codexModel.trim() ? codexModel : DEFAULT_MICROVERSE_SETTINGS.judge_model_codex,
  };
}

/**
 * R-CNAR-8: Atomic clear of all five `current_ticket_*` per-ticket cache fields.
 * Call this at any site that writes `current_ticket = null` OR transitions
 * `current_ticket` to a new value. Without it, stale tier/budget/max-iter values
 * survive into the next ticket's run, and on `--resume` after a clean-success
 * exit (when the cache survives in state.json) the per-ticket cap-check trips
 * before any new ticket starts. R-CNAR-7 self-heals at iteration_start as a
 * safety net for state authored before this fix; this helper closes the leak
 * at every upstream site.
 *
 * Returns the count of fields cleared (0 = state was already clean). Idempotent.
 */
export function clearTicketCacheFields(state: { [k: string]: unknown }): number {
  let cleared = 0;
  for (const key of [
    'current_ticket_tier',
    'current_ticket_budget',
    'current_ticket_max_iterations',
    'current_ticket_worker_timeout_seconds',
    'current_ticket_budget_start_iteration',
  ]) {
    if (state[key] !== undefined) {
      delete state[key];
      cleared++;
    }
  }
  return cleared;
}

/** Extracts a string message from any thrown value. Never throws. */
export function safeErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const Style = {
  GREEN: '\x1b[32m',
  RED: '\x1b[31m',
  BLUE: '\x1b[34m',
  CYAN: '\x1b[36m',
  YELLOW: '\x1b[33m',
  MAGENTA: '\x1b[35m',
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',
  RESET: '\x1b[0m',
} as const;

type StyleColor = keyof typeof Style;

export function getWidth(maxW: number = 90): number {
  const cols = process.stdout.columns || 80;
  return Math.min(cols - 4, maxW);
}

export function getHeight(fallback: number = 24): number {
  const rows = process.stdout.rows;
  return rows && rows > 0 ? rows : fallback;
}

export function wrapText(text: string, width: number): string[] {
  if (!Number.isFinite(width) || width <= 0) return [text];
  const lines: string[] = [];
  const words = text.split(' ');
  let currentLine = '';

  for (const word of words) {
    if ((currentLine === '' ? word : currentLine + ' ' + word).length <= width) {
      currentLine += (currentLine === '' ? '' : ' ') + word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
      while (currentLine.length > width) {
        lines.push(currentLine.slice(0, width));
        currentLine = currentLine.slice(width);
      }
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines.length > 0 ? lines : [''];
}

// R-WTFT: per-gate-phase cap for `npm run test:fast` (and `test:integration`) inside
// the worker lint gate. Distinct from the per-ticket umbrella `WORKER_TIMEOUT_SECONDS`
// (R-WTB). 600_000 ms = 10 min gives ~3x headroom for the current ~4994-test fast
// suite on slow hardware while keeping real hangs bounded.
// Floor for operator override: 60_000 ms.
export const DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS = 600_000;
export const WORKER_TEST_GATE_TIMEOUT_FLOOR_MS = 60_000;
export const WORKER_TEST_GATE_TIMEOUT_ENV_VAR = 'PICKLE_WORKER_TEST_FAST_TIMEOUT_MS';

// The two scrubbed keys the trailer compose site (`backend-spawn.ts`) also WRITES.
// Named here so that file can import the binding instead of restating the literal:
// dropping either from the array below is then a compile error at the compose site,
// not a silently-`undefined` key name at runtime.
export const PICKLE_TICKET_ID_ENV_VAR = 'PICKLE_TICKET_ID';
export const GIT_CONFIG_COUNT_ENV_VAR = 'GIT_CONFIG_COUNT';

// R-WGTORPH: the fixed keys a test-gate spawn must never inherit from the launching
// process — they make the gate measure the environment instead of the tree. Indexed
// `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` pairs (for whatever `n` the parent has
// composed) are scrubbed separately in `scrubGateEnv` since their count is dynamic.
// This is the only enumeration of these keys; the trailer compose site imports the two
// it writes, so the compose list and the scrub list cannot drift apart.
export const PICKLE_GATE_SCRUBBED_ENV_KEYS = [
  WORKER_TEST_GATE_TIMEOUT_ENV_VAR,
  PICKLE_TICKET_ID_ENV_VAR,
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  GIT_CONFIG_COUNT_ENV_VAR,
  'PICKLE_DATA_ROOT',
  'PICKLE_DATA_DIR',
  'TMUX',
] as const;

/** The dynamic half of the scrub set: `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`. */
export const GIT_CONFIG_INDEXED_ENV_KEY_RE = /^GIT_CONFIG_(KEY|VALUE)_\d+$/;

/**
 * Returns a shallow copy of `env` with every `PICKLE_GATE_SCRUBBED_ENV_KEYS` entry
 * (plus every indexed `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` present) deleted —
 * absent, not present-with-`undefined`. Never throws.
 */
export function scrubGateEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env };
  for (const key of PICKLE_GATE_SCRUBBED_ENV_KEYS) delete result[key];
  for (const key of Object.keys(result)) {
    if (GIT_CONFIG_INDEXED_ENV_KEY_RE.test(key)) delete result[key];
  }
  return result;
}

export function printMinimalPanel(
  title: string,
  fields: Record<string, string | number | boolean | null | undefined>,
  colorName: StyleColor = 'GREEN',
  icon: string = '🥒'
) {
  const width = getWidth();
  const c = Style[colorName] || Style.GREEN;
  const r = Style.RESET;
  const b = Style.BOLD;
  const d = Style.DIM;

  if (title) {
    process.stdout.write(`\n${c}${icon} ${b}${title}${r}\n`);
  }

  const fieldKeys = Object.keys(fields);
  if (fieldKeys.length === 0) {
    process.stdout.write('\n');
    return;
  }

  const maxKeyLen = Math.max(...fieldKeys.map((k) => k.length)) + 1;

  for (const [key, value] of Object.entries(fields)) {
    const valWidth = width - maxKeyLen - 5;
    const wrappedVal = wrapText(String(value), valWidth);

    process.stdout.write(
      `  ${d}${key + ':'}${' '.repeat(maxKeyLen - key.length - 1)}${r} ${wrappedVal[0]}\n`
    );
    for (let i = 1; i < wrappedVal.length; i++) {
      process.stdout.write(`  ${' '.repeat(maxKeyLen)} ${wrappedVal[i]}\n`);
    }
  }
  process.stdout.write('\n');
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s}s`;
}

/** Compact ISO stamp safe for use in file/dir names: `2026-04-27T20-15-30Z`. */
export function isoCompactStamp(d: Date = new Date()): string {
  return d.toISOString().replace(/:/g, '-').replace(/\..+/, 'Z');
}

/** Local calendar day key used for filenames/report buckets: `YYYY-MM-DD`. */
export function formatLocalDateKey(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const CANONICAL_EXTENSION_ROOT = path.join(os.homedir(), '.claude/pickle-rick');
const EXTENSION_ROOT_SENTINEL = path.join('extension', 'bin', 'log-watcher.js');
const INSTALL_ROOT_SENTINEL = '.pickle-install-root';
const EXTENSION_DIR_TEST = 'EXTENSION_DIR_TEST';

let extensionDirFallbackEmitted = false;

interface ShellError extends Error {
  stderr?: Buffer | string;
  stdout?: Buffer | string;
  code?: string;
}

/**
 * A truncated read is a WRONG ANSWER, never a soft failure — so it throws for
 * every caller, including `check: false` ones whose contract is otherwise
 * "degrade to empty". Those callers degrade on a command that FAILED; ENOBUFS
 * is the harness losing bytes from a command that SUCCEEDED, and returning its
 * prefix silently hands a partial repo enumeration to the scope fence.
 * Deliberately narrow: ETIMEDOUT still degrades as before, because its partial
 * output is empty-or-tiny and the `check: false` probes are written to expect it.
 */
function assertNotTruncated(cmd: string, error: unknown): void {
  if ((error as ShellError | undefined)?.code !== 'ENOBUFS') return;
  throw new Error(
    `Command output exceeded ${UNBOUNDED_READ_MAX_BUFFER} bytes and was truncated: ${cmd}`,
  );
}

function runArgvCmd(
  cmd: string[],
  options: { cwd?: string; check: boolean; capture: boolean }
): string {
  const result = spawnSync(cmd[0], cmd.slice(1), {
    cwd: options.cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    maxBuffer: UNBOUNDED_READ_MAX_BUFFER,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  assertNotTruncated(cmd.join(' '), result.error);
  if (options.check && (result.status ?? 1) !== 0) {
    // `result.error` carries the harness-level cause (ETIMEDOUT, ENOENT); without
    // it a spawn that produced no stderr throws a bare, unattributable `Error: `.
    const cause = result.stderr || result.error?.message || '';
    throw new Error(`Command failed: ${cmd.join(' ')}\nError: ${cause}`);
  }
  return (result.stdout || '').trim();
}

function shellErrorOutput(error: unknown, stream: 'stderr' | 'stdout'): string {
  return error instanceof Error && stream in error
    ? String((error as ShellError)[stream] || '')
    : '';
}

function runShellCmd(
  cmd: string,
  options: { cwd?: string; check: boolean; capture: boolean }
): string {
  try {
    const stdout = execSync(cmd, {
      cwd: options.cwd,
      encoding: 'utf-8',
      timeout: 30_000,
      maxBuffer: UNBOUNDED_READ_MAX_BUFFER,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    return (stdout || '').trim();
  } catch (error) {
    assertNotTruncated(cmd, error);
    if (options.check) {
      const msg = shellErrorOutput(error, 'stderr') || safeErrorMessage(error);
      throw new Error(`Command failed: ${cmd}\nError: ${msg}`);
    }
    return shellErrorOutput(error, 'stdout').trim();
  }
}

export function runCmd(
  cmd: string | string[],
  options: { cwd?: string; check?: boolean; capture?: boolean } = {}
): string {
  const { cwd, check = true, capture = true } = options;

  // Array form: use spawnSync so each argument is passed verbatim (no shell splitting).
  // String form: use execSync via the shell (supports pipes, globs, etc.).
  if (Array.isArray(cmd)) {
    return runArgvCmd(cmd, { cwd, check, capture });
  }

  return runShellCmd(cmd, { cwd, check, capture });
}

/**
 * Returns the pickle-rick **package root** — `~/.claude/pickle-rick` — which
 * holds `pickle_settings.json`, `persona.md`, `szechuan-sauce-*-principles.md`,
 * `debug.log`, `templates/`, and the `extension/` code tree as a subdirectory.
 *
 * To reach the compiled JS (hooks/, services/, bin/), callers must join
 * `'extension'` themselves: `path.join(getExtensionRoot(), 'extension', 'bin', 'xxx.js')`.
 * The name is historical — it predates the `extension/` subdirectory layout.
 */
export function getExtensionRoot(): string {
  return resolveExtensionRoot(process.env.EXTENSION_DIR);
}

function resolveExtensionRoot(requestedRoot: string | undefined): string {
  if (!requestedRoot) return CANONICAL_EXTENSION_ROOT;
  if (extensionRootSentinelExists(requestedRoot)) return requestedRoot;
  if (allowsMissingExtensionSentinelForTests()) return requestedRoot;

  emitExtensionDirFallbackOnce(
    requestedRoot,
    CANONICAL_EXTENSION_ROOT,
    `missing sentinel ${path.join(requestedRoot, EXTENSION_ROOT_SENTINEL)}`,
  );
  return CANONICAL_EXTENSION_ROOT;
}

function extensionRootSentinelExists(extensionRoot: string): boolean {
  return fs.existsSync(path.join(extensionRoot, EXTENSION_ROOT_SENTINEL)) ||
         fs.existsSync(path.join(extensionRoot, INSTALL_ROOT_SENTINEL));
}

function allowsMissingExtensionSentinelForTests(): boolean {
  return process.env.NODE_ENV === 'test' && process.env[EXTENSION_DIR_TEST] === '1';
}

function emitExtensionDirFallbackOnce(requestedPath: string, fallbackPath: string, reason: string): void {
  if (extensionDirFallbackEmitted) return;
  extensionDirFallbackEmitted = true;

  process.stderr.write(
    `[pickle-rick] EXTENSION_DIR fallback: requested=${requestedPath} fallback=${fallbackPath} reason=${reason}\n`,
  );
  writeExtensionDirFallbackActivity(requestedPath, fallbackPath, reason);
}

function writeExtensionDirFallbackActivity(requestedPath: string, fallbackPath: string, reason: string): void {
  try {
    const ts = new Date();
    const activityDir = path.join(getCanonicalActivityDataRoot(), 'activity');
    fs.mkdirSync(activityDir, { recursive: true });
    const event: ActivityEvent = {
      ts: ts.toISOString(),
      event: 'extension_dir_fallback',
      source: 'pickle',
      requested_path: requestedPath,
      fallback_path: fallbackPath,
      reason,
    };
    fs.appendFileSync(path.join(activityDir, `${formatLocalDateKey(ts)}.jsonl`), `${JSON.stringify(event)}\n`, {
      mode: 0o600,
    });
  } catch (err) {
    process.stderr.write(`[pickle-rick] Failed to log extension_dir_fallback: ${safeErrorMessage(err)}\n`);
  }
}

function writePhantomSessionDemotedActivity(cwd: string, sessionPath: string): void {
  try {
    const ts = new Date();
    const activityDir = path.join(getCanonicalActivityDataRoot(), 'activity');
    fs.mkdirSync(activityDir, { recursive: true });
    const event: ActivityEvent = {
      ts: ts.toISOString(),
      event: 'phantom_session_demoted',
      source: 'pickle',
      requested_path: cwd,
      session_path: sessionPath,
      exit_reason: 'orphan-session-dir-missing',
    };
    fs.appendFileSync(path.join(activityDir, `${formatLocalDateKey(ts)}.jsonl`), `${JSON.stringify(event)}\n`, {
      mode: 0o600,
    });
  } catch (err) {
    process.stderr.write(`[pickle-rick] Failed to log phantom_session_demoted: ${safeErrorMessage(err)}\n`);
  }
}

function getCanonicalActivityDataRoot(): string {
  if (process.env.PICKLE_DATA_ROOT) return process.env.PICKLE_DATA_ROOT;
  if (process.env.PICKLE_DATA_DIR) return process.env.PICKLE_DATA_DIR;
  return path.join(os.homedir(), '.local/share/pickle-rick');
}

/** Test helper: resets process-level fallback emission guard. */
export function _resetExtensionDirFallbackForTests(): void {
  extensionDirFallbackEmitted = false;
}

/**
 * Root directory for pickle data that must NOT live under ~/.claude (Claude Code
 * gates ~/.claude writes with permission prompts). Session dirs, the jar queue,
 * worktrees, activity logs, metrics cache, and the session map all live here.
 *
 * Resolution order:
 *   1. PICKLE_DATA_ROOT (canonical explicit override)
 *   2. PICKLE_DATA_DIR (legacy explicit override — production or test)
 *   3. EXTENSION_DIR — ONLY when it's been pinned to a non-canonical path
 *      (test-harness convenience: tests redirect data into the same tmp dir
 *      they pin the extension root to). The hook dispatcher sets EXTENSION_DIR
 *      to the canonical install path (~/.claude/pickle-rick) in production,
 *      which would otherwise poison data resolution — every hook subprocess
 *      would read sessions from the install dir instead of the XDG data dir.
 *   4. ~/.local/share/pickle-rick (production default)
 */
export function getDataRoot(): string {
  if (process.env.PICKLE_DATA_ROOT) return process.env.PICKLE_DATA_ROOT;
  if (process.env.PICKLE_DATA_DIR) return process.env.PICKLE_DATA_DIR;
  const extDir = process.env.EXTENSION_DIR;
  if (extDir) {
    const canonicalExtDir = path.join(os.homedir(), '.claude/pickle-rick');
    if (path.resolve(extDir) !== path.resolve(canonicalExtDir)) return extDir;
  }
  return path.join(os.homedir(), '.local/share/pickle-rick');
}

export function statusSymbol(status: string | null): string {
  const s = (status || '').toLowerCase().replace(/^["']|["']$/g, '');
  if (s === 'done') return '[x]';
  if (s === 'in progress') return '[~]';
  if (s === 'skipped') return '[!]';
  return '[ ]';
}

/**
 * Safely extracts YAML frontmatter from a string without catastrophic regex backtracking.
 * Uses indexOf for delimiter search — O(n) regardless of content shape.
 * Returns the frontmatter body and byte offsets, or null if no valid block found.
 */
export function extractFrontmatter(content: string): { body: string; start: number; end: number } | null {
  // Support both Unix (\n) and Windows (\r\n) line endings
  const openLen = content.startsWith('---\r\n') ? 5 : content.startsWith('---\n') ? 4 : 0;
  if (openLen === 0) return null;
  const closeIdx = content.indexOf('\n---', openLen);
  if (closeIdx === -1) return null;
  // +4 for '\n---', +1 more if followed by a newline to consume the full delimiter line
  const rawEnd = closeIdx + 4;
  const end = content[rawEnd] === '\n' ? rawEnd + 1 : content[rawEnd] === '\r' && content[rawEnd + 1] === '\n' ? rawEnd + 2 : rawEnd;
  return { body: content.slice(openLen, closeIdx), start: 0, end };
}

export function readFrontmatterField(content: string, field: string): string | null {
  const fm = extractFrontmatter(content);
  if (!fm) return null;
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = fm.body.match(new RegExp(`^${escaped}:\\s*(.+)$`, 'm'));
  if (!match) return null;
  const raw = match[1].trim().replace(/^["']|["']$/g, '');
  return raw.length > 0 ? raw : null;
}

export function upsertFrontmatterField(content: string, field: string, value: string): string | null {
  const fm = extractFrontmatter(content);
  if (!fm) return null;
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = `${field}: "${value}"`;
  if (new RegExp(`^${escaped}:\\s*(.+)$`, 'm').test(fm.body)) {
    const nextBody = fm.body.replace(new RegExp(`^${escaped}:\\s*(.+)$`, 'm'), line);
    return content.slice(0, fm.start) + `---\n${nextBody}\n---\n` + content.slice(fm.end);
  }
  const closingNewline = content.lastIndexOf('\n---', fm.end - 1);
  if (closingNewline === -1) return null;
  const insertPoint = closingNewline + 1;
  return content.slice(0, insertPoint) + `${line}\n` + content.slice(insertPoint);
}

export function ticketFilePath(sessionDir: string, ticketId: string): string {
  return path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`);
}

export function clearTicketResolutionTimestamps(content: string): string {
  const fm = extractFrontmatter(content);
  if (!fm) return content;
  const filteredBody = fm.body
    .split(/\r?\n/)
    .filter((line) => !/^(completed_at|skipped_at):\s*/.test(line))
    .join('\n');
  return content.slice(0, fm.start) + `---\n${filteredBody}\n---\n` + content.slice(fm.end);
}

export interface TicketInfo {
  id: string | null;
  title: string | null;
  status: string | null;
  order: number;
  type: string | null;
  working_dir: string | null;
  completed_at: string | null;
  skipped_at: string | null;
  complexity_tier?: 'trivial' | 'small' | 'medium' | 'large';
  /** IDs of tickets this ticket depends on (must run before this one). */
  depends_on: string[];
}

export type TicketStatus = TicketInfo['status'];
export type TicketComplexityTier = NonNullable<TicketInfo['complexity_tier']>;

export interface TicketTierBudget {
  tier: TicketComplexityTier;
  max_iterations: number;
  worker_timeout_seconds: number;
}

export const VALID_TICKET_COMPLEXITY_TIERS = ['trivial', 'small', 'medium', 'large'] as const;

export const TICKET_TIER_BUDGETS: Record<TicketComplexityTier, Omit<TicketTierBudget, 'tier'>> = {
  trivial: { max_iterations: 5, worker_timeout_seconds: 5 * 60 },
  small: { max_iterations: 10, worker_timeout_seconds: 10 * 60 },
  medium: { max_iterations: 30, worker_timeout_seconds: 60 * 60 },
  large: { max_iterations: 60, worker_timeout_seconds: 80 * 60 },
} as const;

export type LifecyclePhase =
  | 'research'
  | 'research_review'
  | 'plan'
  | 'plan_review'
  | 'implement'
  | 'conformance'
  | 'code_review'
  | 'simplify';

export const TIER_LIFECYCLE: Record<TicketComplexityTier, LifecyclePhase[]> = {
  trivial: ['implement', 'code_review'],
  small: ['plan', 'implement', 'code_review'],
  medium: ['research', 'research_review', 'plan', 'plan_review', 'implement', 'conformance', 'code_review', 'simplify'],
  large: ['research', 'research_review', 'plan', 'plan_review', 'implement', 'conformance', 'code_review', 'simplify'],
} as const;

/** R-PIAP-A3: max changed LOC (additions + deletions) for each compact tier. Tunable. */
export const TIER_DIFF_ENVELOPE: Partial<Record<TicketComplexityTier, number>> = {
  trivial: 20,
  small: 80,
} as const;

export interface TierCapPartial {
  max_iterations?: number;
  worker_timeout_seconds?: number;
}

export type TierCapsConfig = Partial<Record<TicketComplexityTier, TierCapPartial>>;

export function normalizeTicketComplexityTier(value: unknown): TicketComplexityTier {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if ((VALID_TICKET_COMPLEXITY_TIERS as readonly string[]).includes(normalized)) {
      return normalized as TicketComplexityTier;
    }
  }
  return 'medium';
}

/**
 * Input shape for the deterministic tier classifier.
 * All fields are pure data — no I/O, no clock, no randomness needed.
 */
export interface TicketClassifierInfo {
  /** Number of distinct in-scope source files */
  fileCount: number;
  /** Number of acceptance criteria */
  acCount: number;
  /** LOC/diff estimate (0 when unknown) */
  locEstimate: number;
  /** Full ticket text for keyword scanning */
  text: string;
}

const CLASSIFIER_SMALLER_KEYWORDS = ['padding', 'typo', 'rename', 'delete', 'copy', 'label', 'color'] as const;
const CLASSIFIER_LARGER_KEYWORDS = ['integrate', 'migrate', 'schema', 'cross-cutting', 'refactor'] as const;
/**
 * R-TCVC: verify-command shapes that signal an expensive acceptance-criteria
 * verification cost (container/e2e suites, not a plain unit-test grep). Folded
 * into the SAME ±1 keyword delta as CLASSIFIER_LARGER_KEYWORDS — one list, no
 * separate classifier — so a ticket whose AC names one of these bumps one tier,
 * capped at 'large' by the existing delta clamp.
 *
 * Matched by `countKeywordHits`, i.e. the SAME word-boundary rule as every other
 * classifier list. A colon is interior to these literals, not at a boundary, so
 * `\btest:migration\b` matches `pnpm run test:migration` exactly as intended.
 */
export const CLASSIFIER_EXPENSIVE_VERIFY_KEYWORDS = [
  'test:migration',
  'docker',
  'compose',
  'e2e',
  'playwright',
  'run_expensive_tests',
  'test:integration',
] as const;

/**
 * AP-EXT-ITER2-01: the ONE keyword-matching rule for every classifier list.
 * Word-boundary anchored so a keyword only counts as its own word — `compose`
 * must not fire on `composes:`/`decomposed`, and `e2e` must not fire inside a
 * commit SHA like `1e2e14d8`. Keywords are regex-escaped; a colon or hyphen is
 * interior to the literal, so `\b` still anchors both ends correctly.
 */
function countKeywordHits(textLower: string, keywords: readonly string[]): number {
  let hits = 0;
  for (const kw of keywords) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`).test(textLower)) hits++;
  }
  return hits;
}

function classifyDimension(val: number, thresholds: readonly [number, number, number]): number {
  if (val < thresholds[0]) return 0; // trivial
  if (val < thresholds[1]) return 1; // small
  if (val < thresholds[2]) return 2; // medium
  return 3; // large
}

/**
 * Pure, deterministic ticket complexity classifier.
 * No I/O, no clock, no randomness. Ties round UP to the larger tier.
 *
 * Tier thresholds:
 *   trivial: ≤1 file, ≤1 AC, ≤20 LOC
 *   small:    2 files, 2-3 ACs, 21-80 LOC
 *   medium:  3-4 files, 4-6 ACs, 81-250 LOC
 *   large:   ≥5 files, ≥7 ACs, ≥251 LOC
 *
 * Conservative tie-breaking: max() over dimension scores so any single
 * dimension that signals "large" produces at least "large" output.
 * Keyword delta (±1) is applied after the dimension max.
 */
export function classifyTicketTier(info: TicketClassifierInfo): TicketComplexityTier {
  const fileScore = classifyDimension(info.fileCount, [2, 3, 5]);
  const acScore = classifyDimension(info.acCount, [2, 4, 7]);
  const locScore = classifyDimension(info.locEstimate, [21, 81, 251]);

  // Conservative: ties round UP (take the maximum across dimensions)
  let score = Math.max(fileScore, acScore, locScore);

  // Keyword adjustment — clamped to [-1, 1] so keywords can't overwhelm signals
  const textLower = info.text.toLowerCase();
  const rawDelta =
    countKeywordHits(textLower, CLASSIFIER_LARGER_KEYWORDS) +
    countKeywordHits(textLower, CLASSIFIER_EXPENSIVE_VERIFY_KEYWORDS) -
    countKeywordHits(textLower, CLASSIFIER_SMALLER_KEYWORDS);
  const delta = Math.max(-1, Math.min(1, rawDelta));
  score = Math.max(0, Math.min(3, score + delta));

  return VALID_TICKET_COMPLEXITY_TIERS[score];
}

/**
 * R-PIAP-B1: tunable threshold for "UI-primary" diffs. A diff is UI-primary when
 * the share of changed lines that are visual STRICTLY EXCEEDS this value.
 * Default 0.60. Tunable via the optional `threshold` arg of
 * `classifyDiffVisualDominance`.
 */
export const VISUAL_DOMINANCE_THRESHOLD = 0.6;

/** Whole-file visual stylesheets: every changed line counts as visual. */
const VISUAL_FILE_EXT_RE = /\.(css|scss|sass|less)$/i;
/** JS/TS sources where visual lines are classified per-line. */
const SOURCE_FILE_EXT_RE = /\.(jsx|tsx|js|ts|mjs|cjs)$/i;
/** Opening of a styled-component template (`styled.button\`` / `styled(Foo)\``). */
const STYLED_TEMPLATE_OPENER_RE = /\bstyled(?:\.[A-Za-z]\w*|\([^)]*\))\s*`/;
/**
 * A single changed source line that is visual: JSX/TSX markup (`<Tag`, `</Tag`,
 * self-closing `/>`, fragment `<>`/`</>`), or a `className=` / `style=` / `class=`
 * edit.
 */
const VISUAL_SOURCE_LINE_RE = /<\/?[A-Za-z][\w.]*[\s/>]|\/>|<>|<\/>|\bclassName\s*=|\bstyle\s*=|\bclass\s*=/;

/**
 * Input shape for {@link classifyDiffVisualDominance}. One entry per changed file.
 * `changedLines` is the list of added/modified line texts in that file's diff —
 * its length is the per-file changed-line count, and its contents carry the
 * signal needed to classify visual lines inside mixed source files. Pure data:
 * no I/O is performed to obtain or interpret it.
 */
export interface DiffFileVisualStat {
  /** Repo-relative path; its extension drives whole-file visual classification. */
  path: string;
  /** Added/modified line texts for this file (one entry per changed line). */
  changedLines: string[];
}

export type DiffVisualStat = DiffFileVisualStat[];

/**
 * Count the visual changed lines in one file:
 *   - stylesheet extension  → all changed lines are visual;
 *   - non-source extension  → none are visual;
 *   - JS/TS source          → lines inside/opening a styled-component template,
 *                             or matching JSX/className/style markup, are visual.
 */
function countVisualChangedLines(filePath: string, changedLines: string[]): number {
  if (VISUAL_FILE_EXT_RE.test(filePath)) return changedLines.length;
  if (!SOURCE_FILE_EXT_RE.test(filePath)) return 0;

  let count = 0;
  let inStyledTemplate = false;
  for (const line of changedLines) {
    if (inStyledTemplate) {
      count++;
      if (line.includes('`')) inStyledTemplate = false;
      continue;
    }
    if (STYLED_TEMPLATE_OPENER_RE.test(line)) {
      count++;
      // Stay inside the template only if it does not also close on this line.
      if (!line.slice(line.indexOf('`') + 1).includes('`')) inStyledTemplate = true;
      continue;
    }
    if (VISUAL_SOURCE_LINE_RE.test(line)) count++;
  }
  return count;
}

/**
 * R-PIAP-B1: pure, deterministic predicate — is this diff UI-primary?
 *
 * Returns `true` when the share of changed lines that are visual strictly exceeds
 * `threshold` (default {@link VISUAL_DOMINANCE_THRESHOLD} = 0.60). "Visual" =
 * stylesheet files (`.css`/`.scss`/`.sass`/`.less`), styled-component template
 * blocks, and JSX/TSX markup or `className`/`style` edits (see
 * {@link countVisualChangedLines}).
 *
 * No I/O, no clock, no randomness. An empty diff (zero changed lines) returns
 * `false`. This is the RAW boolean only — the "err toward design-safe near the
 * threshold" policy is applied by the B2 caller, not here.
 */
export function classifyDiffVisualDominance(
  diffStat: DiffVisualStat,
  threshold: number = VISUAL_DOMINANCE_THRESHOLD,
): boolean {
  let totalChanged = 0;
  let totalVisual = 0;
  for (const file of diffStat) {
    const changed = file.changedLines.length;
    if (changed === 0) continue;
    totalChanged += changed;
    totalVisual += countVisualChangedLines(file.path, file.changedLines);
  }
  if (totalChanged === 0) return false;
  return totalVisual / totalChanged > threshold;
}

function readTierCapsBlock(block: unknown): TierCapsConfig {
  if (!block || typeof block !== 'object') return {};
  const result: TierCapsConfig = {};
  for (const tier of VALID_TICKET_COMPLEXITY_TIERS) {
    const entry = (block as Record<string, unknown>)[tier];
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const partial: TierCapPartial = {};
    const maxIter = Number(e.max_iterations);
    if (Number.isFinite(maxIter) && Number.isInteger(maxIter) && maxIter > 0) {
      partial.max_iterations = maxIter;
    }
    const tmout = Number(e.worker_timeout_seconds);
    if (Number.isFinite(tmout) && Number.isInteger(tmout) && tmout > 0) {
      partial.worker_timeout_seconds = tmout;
    }
    if (partial.max_iterations !== undefined || partial.worker_timeout_seconds !== undefined) {
      result[tier] = partial;
    }
  }
  return result;
}

export function loadPickleSettingsBag(extensionRoot = getExtensionRoot()): PickleSettings | null {
  try {
    const settingsPath = path.join(extensionRoot, 'pickle_settings.json');
    return readRecoverableJsonObject(settingsPath) as PickleSettings | null;
  } catch {
    return null;
  }
}

/** Compiled default for `hardening.silent_death_respawn_cap` (ticket 90574654). */
export const DEFAULT_SILENT_DEATH_RESPAWN_CAP = 1;

/** Compiled default for `hardening.failed_flip_suppression_cap` (ticket 7eb9fa20). */
export const DEFAULT_FAILED_FLIP_SUPPRESSION_CAP = 2;

/** Compiled default for `hardening.breaker_recovery_grace_seconds` (AC-A5, B-RRH). */
export const DEFAULT_BREAKER_RECOVERY_GRACE_SECONDS = 30;

/** Compiled default for `hardening.bounded_terminal_escape_cap` (AC-A4, f8000435). */
export const DEFAULT_BOUNDED_TERMINAL_ESCAPE_CAP = 3;

/** Non-negative-integer-or-fallback field resolver shared by every `hardening.*` field. */
function resolveNonNegativeIntField(block: Record<string, unknown>, key: string, fallback: number): number {
  const v = block[key];
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : fallback;
}

/**
 * Ticket 90574654 — resolve the additive `hardening:` settings block (DISTINCT
 * from `bmad_hardening`). Doctrine mirrors `loadRefinementSettings`
 * (spawn-refinement-team.ts): start from compiled defaults; an absent, partial,
 * or malformed bag/block/field never throws and falls back per field.
 * `silent_death_respawn_cap` accepts non-negative integers only — `0` disables
 * silent-death respawns entirely. `failed_flip_suppression_cap` (ticket
 * 7eb9fa20) follows the same rule — `0` disables evidence-backed Failed-flip
 * suppression (flip-intents with evidence escalate immediately).
 * `breaker_recovery_grace_seconds` (AC-A5) and `bounded_terminal_escape_cap`
 * (AC-A4) follow the same non-negative-integer-or-default doctrine.
 */
export function resolveHardeningSettings(bag: PickleSettings | null | undefined): HardeningSettings {
  const settings: HardeningSettings = {
    silent_death_respawn_cap: DEFAULT_SILENT_DEATH_RESPAWN_CAP,
    failed_flip_suppression_cap: DEFAULT_FAILED_FLIP_SUPPRESSION_CAP,
    breaker_recovery_grace_seconds: DEFAULT_BREAKER_RECOVERY_GRACE_SECONDS,
    bounded_terminal_escape_cap: DEFAULT_BOUNDED_TERMINAL_ESCAPE_CAP,
  };
  if (!bag || typeof bag !== 'object') return settings;
  const block = (bag as Record<string, unknown>).hardening;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return settings;
  const b = block as Record<string, unknown>;
  settings.silent_death_respawn_cap = resolveNonNegativeIntField(b, 'silent_death_respawn_cap', settings.silent_death_respawn_cap);
  settings.failed_flip_suppression_cap = resolveNonNegativeIntField(b, 'failed_flip_suppression_cap', settings.failed_flip_suppression_cap);
  settings.breaker_recovery_grace_seconds = resolveNonNegativeIntField(b, 'breaker_recovery_grace_seconds', settings.breaker_recovery_grace_seconds);
  settings.bounded_terminal_escape_cap = resolveNonNegativeIntField(b, 'bounded_terminal_escape_cap', settings.bounded_terminal_escape_cap);
  return settings;
}

function parseSettingBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function parseSettingIntFloor(v: unknown, floor: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return undefined;
  return Math.max(floor, v);
}

function parseSettingIntClamp(v: unknown, floor: number, ceiling: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return undefined;
  return Math.max(floor, Math.min(ceiling, v));
}

export function resolveCodegraphSettings(bag: unknown): CodegraphSettings {
  // Compiled defaults are OFF (aligned with the shipped pickle_settings.json
  // opt-in stance, de3c5959): a missing/malformed settings file must NOT
  // silently activate codegraph — sandboxed test runs without a settings file
  // were indexing fixture dirs through the old enabled:true fallback (97
  // leaked codegraph_index_built events, 2026-06-12..07-08).
  const settings: CodegraphSettings = {
    enabled: false,
    index_at_setup: false,
    staleness_max_age_minutes: 30,
    context_max_bytes: 8192,
    expose_mcp_to_workers: false,
    index_timeout_ms: 120000,
    sync_timeout_ms: 30000,
    query_timeout_ms: 5000,
  };
  if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return settings;
  const block = (bag as Record<string, unknown>).codegraph;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return settings;
  const b = block as Record<string, unknown>;
  const enabled = parseSettingBool(b.enabled);
  if (enabled !== undefined) settings.enabled = enabled;
  const indexAtSetup = parseSettingBool(b.index_at_setup);
  if (indexAtSetup !== undefined) settings.index_at_setup = indexAtSetup;
  const exposeMcp = parseSettingBool(b.expose_mcp_to_workers);
  if (exposeMcp !== undefined) settings.expose_mcp_to_workers = exposeMcp;
  const staleness = parseSettingIntFloor(b.staleness_max_age_minutes, 1);
  if (staleness !== undefined) settings.staleness_max_age_minutes = staleness;
  const ctxBytes = parseSettingIntClamp(b.context_max_bytes, 1024, 65536);
  if (ctxBytes !== undefined) settings.context_max_bytes = ctxBytes;
  const indexMs = parseSettingIntFloor(b.index_timeout_ms, 5000);
  if (indexMs !== undefined) settings.index_timeout_ms = indexMs;
  const syncMs = parseSettingIntFloor(b.sync_timeout_ms, 1000);
  if (syncMs !== undefined) settings.sync_timeout_ms = syncMs;
  const queryMs = parseSettingIntFloor(b.query_timeout_ms, 500);
  if (queryMs !== undefined) settings.query_timeout_ms = queryMs;
  return settings;
}

export const DEFAULT_MAX_PARK_MINUTES = 360;

/**
 * Ticket e9bdac75 (Workstream B): resolve the rate-limit park controls from the
 * additive `rate_limit:` block in `pickle_settings.json`. Per-field fallback —
 * absent/partial/malformed input yields the compiled default. Mirrors
 * `resolveHardeningSettings` / `resolveCodegraphSettings`.
 */
export function resolveRateLimitSettings(bag: PickleSettings | null | undefined): RateLimitSettings {
  const settings: RateLimitSettings = { max_park_minutes: DEFAULT_MAX_PARK_MINUTES };
  if (!bag || typeof bag !== 'object') return settings;
  const block = (bag as Record<string, unknown>).rate_limit;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return settings;
  const maxPark = parseSettingIntFloor((block as Record<string, unknown>).max_park_minutes, 1);
  if (maxPark !== undefined) settings.max_park_minutes = maxPark;
  return settings;
}

export interface ScopeSettings {
  autoExtendSignatureCallers: boolean;
}

/**
 * Ticket 0b9b2319 (WS-3): resolve the additive `scope:` block in
 * `pickle_settings.json`. Mirrors `resolveHardeningSettings` robustness —
 * an absent, partial, or malformed bag/block/field never throws and falls
 * back to the default-OFF compiled default. The single field
 * `auto_extend_signature_callers` (default `false`) gates the bounded,
 * opt-in build-phase scope auto-extension in `setupScope`.
 */
export function resolveScopeSettings(bag: PickleSettings | null | undefined): ScopeSettings {
  const settings: ScopeSettings = { autoExtendSignatureCallers: false };
  if (!bag || typeof bag !== 'object') return settings;
  const block = (bag as Record<string, unknown>).scope;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return settings;
  const autoExtend = parseSettingBool((block as Record<string, unknown>).auto_extend_signature_callers);
  if (autoExtend !== undefined) settings.autoExtendSignatureCallers = autoExtend;
  return settings;
}

export function resolveWorkerTestGateTimeoutMs(
  extensionRoot = getExtensionRoot(),
  settings?: PickleSettings | null,
  env: NodeJS.ProcessEnv = process.env,
): number {
  // Env override wins. Parse strict int, clamp to >= WORKER_TEST_GATE_TIMEOUT_FLOOR_MS,
  // fall back to settings/default on parse failure or sub-floor value.
  const rawEnv = env[WORKER_TEST_GATE_TIMEOUT_ENV_VAR];
  if (typeof rawEnv === 'string' && rawEnv.trim().length > 0) {
    const parsed = Number(rawEnv);
    if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0) {
      return Math.max(parsed, WORKER_TEST_GATE_TIMEOUT_FLOOR_MS);
    }
  }
  const settingsBag = settings === undefined ? loadPickleSettingsBag(extensionRoot) : settings;
  const timeoutMs = Number(settingsBag?.worker_test_gate_timeout_ms);
  if (Number.isFinite(timeoutMs) && Number.isInteger(timeoutMs) && timeoutMs > 0) {
    return timeoutMs;
  }
  return DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS;
}

export function resolveJudgeBackend(
  state: State,
  settings?: PickleSettings | null,
  attempt: number = 0,
  lastFailure?: JudgeMeasurementError,
): 'claude' | 'codex' {
  const microverseSettings = settings === undefined
    ? getMicroverseSettings(loadPickleSettingsBag())
    : getMicroverseSettings(settings);
  const flags = isRecord(state?.flags) ? state.flags : {};
  const chosen = resolveJudgeBackendChoice(flags['judge_backend_override']) ?? microverseSettings.judge_backend;
  if (chosen !== 'auto') return chosen;
  if (!isTypedFailure(lastFailure) && attempt === 0) return 'claude';

  const resolved = isRecord(state) ? (state as { judge_backend_resolved?: unknown }).judge_backend_resolved : undefined;
  const fromState = resolveJudgeBackendChoice(resolved);
  if (fromState && fromState !== 'auto') {
    return fromState;
  }

  return microverseSettings.judge_backend_fallback ?? DEFAULT_MICROVERSE_SETTINGS.judge_backend_fallback;
}

export function readPickleSettingsTierCaps(
  settings: Record<string, unknown> | null | undefined,
): TierCapsConfig {
  if (!settings) return {};
  return readTierCapsBlock((settings as { tier_caps?: unknown }).tier_caps);
}

export function readStateTierCapOverrides(
  state: State | null | undefined,
): TierCapsConfig {
  const flags = state?.flags;
  if (!flags || typeof flags !== 'object') return {};
  return readTierCapsBlock((flags as Record<string, unknown>).tier_cap_override);
}

/**
 * Canonical ticket-tier budget accessor. Resolution order, applied
 * independently per field (max_iterations, worker_timeout_seconds):
 *
 *   1. state.flags.tier_cap_override.<tier>.<field>
 *   2. pickle_settings.tier_caps.<tier>.<field>
 *   3. TICKET_TIER_BUDGETS[<tier>].<field>  (compiled-in default)
 *
 * Invalid (non-positive-integer) values fall through to the next tier of
 * precedence rather than throwing. Reader honors both pickle_settings v1
 * (schema_version absent) and v2 (schema_version === 2) — only the
 * `tier_caps` block is inspected, so older or newer settings files are safe.
 *
 * If `settings` is `undefined`, the on-disk pickle_settings.json is read via
 * `readRecoverableJsonObject(path.join(getExtensionRoot(), 'pickle_settings.json'))`.
 * Pass `null` to bypass disk I/O (compiled defaults only) — useful in tests.
 */
export function getTicketTierBudgetWithOverrides(
  state: State | null | undefined,
  tier: unknown,
  settings?: Record<string, unknown> | null,
): TicketTierBudget {
  const normalizedTier = normalizeTicketComplexityTier(tier);
  const defaults = TICKET_TIER_BUDGETS[normalizedTier];
  const settingsBag = settings === undefined ? loadPickleSettingsBag() : settings;
  const settingsCap = readPickleSettingsTierCaps(settingsBag)[normalizedTier] ?? {};
  const stateCap = readStateTierCapOverrides(state)[normalizedTier] ?? {};
  return {
    tier: normalizedTier,
    max_iterations: stateCap.max_iterations ?? settingsCap.max_iterations ?? defaults.max_iterations,
    worker_timeout_seconds: stateCap.worker_timeout_seconds ?? settingsCap.worker_timeout_seconds ?? defaults.worker_timeout_seconds,
  };
}

export function ticketTierBudget(tier: unknown): TicketTierBudget {
  return getTicketTierBudgetWithOverrides(null, tier, null);
}

export function ticketInfoBudget(ticketInfo: Pick<TicketInfo, 'complexity_tier'> | null | undefined): TicketTierBudget {
  return getTicketTierBudgetWithOverrides(null, ticketInfo?.complexity_tier, null);
}

export class MissingTicketError extends Error {
  constructor(
    public readonly sessionRoot: string,
    public readonly ticketId: string,
    public readonly ticketPath: string
  ) {
    super(`Ticket ${ticketId} not found in session ${sessionRoot}`);
    this.name = 'MissingTicketError';
  }
}

/**
 * Read a string-array field from a YAML-ish frontmatter body. Supports both
 * inline `field: [a, b]` and block list:
 *   field:
 *     - a
 *     - b
 * Mirrors the extractor in `check-readiness.ts:dependencyRefs`.
 */
function readFrontmatterStringArray(body: string, key: string): string[] {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inline = new RegExp(`^${escaped}:\\s*\\[(.*?)\\]\\s*$`, 'm').exec(body);
  if (inline) {
    return inline[1]
      .split(',')
      .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  const lines = body.split(/\r?\n/);
  const index = lines.findIndex((line) => new RegExp(`^${escaped}:\\s*$`).test(line));
  if (index < 0) return [];
  const values: string[] = [];
  for (let i = index + 1; i < lines.length; i += 1) {
    const match = /^\s+-\s+(.+?)\s*$/.exec(lines[i]);
    if (!match) break;
    values.push(match[1].replace(/^['"]|['"]$/g, ''));
  }
  return values;
}

export function parseTicketFrontmatter(filePath: string): TicketInfo | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const fm = extractFrontmatter(content);
    if (!fm) return null;
    const get = (field: string): string | null => {
      const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = fm.body.match(new RegExp(`^${escaped}:\\s*(.+)$`, 'm'));
      return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
    };
    const complexity_tier = normalizeTicketComplexityTier(get('complexity_tier'));
    // AC-SSV-05: collect both `depends_on` and the legacy `dependencies` alias,
    // strip optional `external:` prefix, dedupe. These edges feed topoSortTickets.
    const rawDeps = [
      ...readFrontmatterStringArray(fm.body, 'depends_on'),
      ...readFrontmatterStringArray(fm.body, 'dependencies'),
    ];
    const seen = new Set<string>();
    const depends_on: string[] = [];
    for (const dep of rawDeps) {
      const cleaned = dep.replace(/^external:\s*/i, '').trim();
      if (!cleaned || seen.has(cleaned)) continue;
      seen.add(cleaned);
      depends_on.push(cleaned);
    }
    return {
      id: get('id'),
      title: get('title'),
      status: get('status'),
      order: parseInt(get('order') || '0', 10) || 0,
      type: get('type'),
      working_dir: get('working_dir'),
      completed_at: get('completed_at'),
      skipped_at: get('skipped_at'),
      complexity_tier,
      depends_on,
    };
  } catch {
    return null;
  }
}

export function getTicketStatus(sessionRoot: string, ticketId: string): TicketStatus {
  const ticketPath = path.join(sessionRoot, ticketId, `rick_ticket_${ticketId}.md`);
  if (!fs.existsSync(ticketPath)) {
    throw new MissingTicketError(sessionRoot, ticketId, ticketPath);
  }
  const parsed = parseTicketFrontmatter(ticketPath);
  if (!parsed) {
    throw new MissingTicketError(sessionRoot, ticketId, ticketPath);
  }
  return parsed.status;
}

export interface CompletionCommitEvidence {
  sha: string | null;
  source: 'explicit-reachable' | 'inferred' | 'absent';
  /** R-CCR-1: true when per-ticket workingDir was unusable and fallbackDir succeeded. */
  usedFallback?: boolean;
}

/**
 * R-CCQF: Normalize a frontmatter `completion_commit*` field value into a bare
 * SHA hex string suitable for `git cat-file` validation, or `null` if the
 * value cannot be coerced into 7–40 hex chars. Accepts ALL three documented
 * serializations the gate must tolerate:
 *   1. Unquoted short SHA   (e.g. `completion_commit: 4b38893c`)
 *   2. Unquoted full SHA    (e.g. `completion_commit: 724f69d4db8aae9b5f8e4ab7f3abfa0a72c5f6c8`)
 *   3. Quoted (single OR double), short OR full
 *      (e.g. `completion_commit: "724f69d4db8aae9b5f8e4ab7f3abfa0a72c5f6c8"`)
 *
 * The auto-promote helper writes shape #1; codex/human edits naturally write
 * shape #3. Tightening the writer was rejected (see PRD
 * `p2-completion-commit-quoted-form-and-exit-reason-2026-05-24.md`) — the gate
 * is the right place to accept all three. Anything else returns `null` and the
 * caller MUST classify as `absent` rather than `inferred` (parsing failure is
 * not the same as a git-log scan miss).
 */
export function normalizeCompletionCommitField(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  // `readFrontmatterField` already strips one symmetric quote pair via the
  // `g` flag, but defend-in-depth here: re-strip leading/trailing single OR
  // double quotes (paired or unpaired) and trim residual whitespace before
  // validating SHA hex. Belt + suspenders prevents future drift where a
  // caller invokes this with a raw frontmatter line.
  const stripped = raw.trim().replace(/^["']+|["']+$/g, '').trim();
  if (!stripped) return null;
  return /^[0-9a-f]{7,40}$/i.test(stripped) ? stripped : null;
}

/**
 * Rewrites a ticket's frontmatter `status:` line to `status`, transactionally.
 * Returns false (never throws) if the ticket dir/file doesn't exist or the
 * write fails — every caller treats the boolean as "did the status land?".
 *
 * This is the ONE ticket-status writer. `setup.ts` and `mux-runner.ts` import
 * it as `writeTicketStatus`; the two terminal-status bindings below are the
 * named completion-authority surface (AC-D4) and delegate here.
 */
export function markTicketWithStatus(sessionDir: string, ticketId: string, status: string): boolean {
  try {
    const planned = updateTicketStatusInTransaction(ticketId, status, sessionDir);
    fs.writeFileSync(planned.path, planned.content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Marks a ticket's frontmatter status as "Done" by rewriting the status line.
 * No-op if ticket dir or file doesn't exist, or status is already Done.
 */
export function markTicketDone(sessionDir: string, ticketId: string): boolean {
  return markTicketWithStatus(sessionDir, ticketId, 'Done');
}

export function markTicketSkipped(sessionDir: string, ticketId: string): boolean {
  return markTicketWithStatus(sessionDir, ticketId, 'Skipped');
}

/**
 * Build the dependency graph (indegree + reverse edges) for topoSortTickets.
 * Extracted purely to keep the main function under cyclomatic-complexity 15.
 */
function buildTicketDepGraph(tickets: TicketInfo[]): {
  indegree: Map<number, number>;
  edges: Map<number, number[]>;
} {
  const byId = new Map<string, number>();
  tickets.forEach((t, index) => {
    if (t.id) byId.set(t.id, index);
  });
  const indegree = new Map<number, number>();
  const edges = new Map<number, number[]>();
  for (let i = 0; i < tickets.length; i++) {
    indegree.set(i, 0);
    edges.set(i, []);
  }
  for (let i = 0; i < tickets.length; i++) {
    for (const depId of tickets[i].depends_on) {
      const depIdx = byId.get(depId);
      if (depIdx === undefined) continue; // external/unknown dep — ignore for ordering
      edges.get(depIdx)!.push(i);
      indegree.set(i, (indegree.get(i) || 0) + 1);
    }
  }
  return { indegree, edges };
}

/**
 * Topologically sort tickets so that any ticket whose ID appears in another
 * ticket's `depends_on` list comes BEFORE the dependent ticket. Ties (no
 * incoming-edge difference) break on the numeric `order` field, then on
 * stable insertion index. Throws on cycle detection with both/all member IDs
 * in the message.
 *
 * Implementation: Kahn's algorithm with a ready-queue re-sorted by
 * `(order, originalIndex)` for deterministic output.
 *
 * AC-SSV-05: replaces the prior pure-numeric sort that allowed C-T0 (order 200)
 * to run before NEW-T2 (order 300) when NEW-T2 depended on C-T0, even when the
 * caller supplied them in dependent-first form.
 */
export function topoSortTickets(tickets: TicketInfo[]): TicketInfo[] {
  if (tickets.length <= 1) return [...tickets];
  const { indegree, edges } = buildTicketDepGraph(tickets);
  const compare = (a: number, b: number): number => {
    const oa = tickets[a].order;
    const ob = tickets[b].order;
    return oa !== ob ? oa - ob : a - b;
  };
  const ready: number[] = [];
  for (let i = 0; i < tickets.length; i++) {
    if ((indegree.get(i) || 0) === 0) ready.push(i);
  }
  ready.sort(compare);
  const out: TicketInfo[] = [];
  while (ready.length > 0) {
    const i = ready.shift()!;
    out.push(tickets[i]);
    for (const next of edges.get(i)!) {
      const nextDeg = (indegree.get(next) || 0) - 1;
      indegree.set(next, nextDeg);
      if (nextDeg === 0) {
        ready.push(next);
        ready.sort(compare);
      }
    }
  }
  if (out.length !== tickets.length) {
    const stuck = tickets.filter((_, i) => (indegree.get(i) || 0) > 0).map((t) => t.id || '<unknown>');
    throw new Error(`Ticket dependency cycle detected: ${stuck.join(' → ')} → ${stuck[0] || '<unknown>'}`);
  }
  return out;
}

export function collectTickets(sessionDir: string): TicketInfo[] {
  try {
    const entries = fs.readdirSync(sessionDir, { withFileTypes: true });
    const tickets: TicketInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = path.join(sessionDir, entry.name);
      try {
        const files = fs.readdirSync(subDir);
        for (const file of files) {
          if (!file.startsWith('rick_ticket_') || !file.endsWith('.md')) continue;
          const parsed = parseTicketFrontmatter(path.join(subDir, file));
          if (parsed) tickets.push(parsed);
        }
      } catch {
        /* skip */
      }
    }
    return topoSortTickets(tickets);
  } catch {
    return [];
  }
}

function formatIterationLine(state: Partial<State>): string {
  const iter = Number(state.iteration) || 0;
  const maxIter = Number(state.max_iterations) || 0;
  return maxIter > 0 ? `${iter} of ${maxIter}` : `${iter}`;
}

function appendTicketSummaryLines(lines: string[], tickets: TicketInfo[], state: Partial<State>): void {
  if (tickets.length === 0) return;
  lines.push('Tickets:');
  for (const ticket of tickets) {
    lines.push(formatTicketSummaryLine(ticket, state));
  }
}

function formatTicketSummaryLine(t: TicketInfo, state: Partial<State>): string {
  const sym = statusSymbol(t.status || '');
  const title = (t.title || '').length > 60
    ? (t.title || '').slice(0, 60) + '...'
    : (t.title || '');
  const typeTag = t.type === 'review' ? ' [REVIEW]' : '';
  const dirTag = t.working_dir && t.working_dir !== state.working_dir ? ` (${t.working_dir})` : '';
  const tierTag = t.complexity_tier && t.complexity_tier !== 'medium'
    ? ` [${t.complexity_tier}]`
    : '';
  const skippedNote = (t.status || '').toLowerCase().replace(/["']/g, '') === 'skipped'
    ? ' (no verified completion — re-attempt)'
    : '';
  return `  ${sym} ${t.id || '?'}: ${title}${typeTag}${tierTag}${dirTag}${skippedNote}`;
}

function appendResumeActionLines(lines: string[], state: Partial<State>, iterationNum?: number): void {
  const isFirstIteration = (iterationNum === 1 || iterationNum === undefined)
    && (Number(state.iteration) || 0) === 0
    && (state.history || []).length === 0;
  lines.push('');
  if (isFirstIteration) {
    lines.push(
      'THIS IS A NEW SESSION. Begin the lifecycle from the current phase.',
      'Read state.json for full context, then start working on the task.',
    );
    return;
  }
  lines.push(
    'NEXT ACTION: Resume from current phase. Read state.json for context.',
    'Do NOT restart from scratch. Continue where you left off.',
  );
}

export function buildHandoffSummary(state: Partial<State>, sessionDir: string, iterationNum?: number): string {
  const task = state.original_prompt || '';
  const truncatedTask = task.length > 300 ? task.slice(0, 300) + ' [truncated]' : task;
  const prdPath = path.join(sessionDir, 'prd.md');
  const prdExists = fs.existsSync(prdPath);
  const tickets = collectTickets(sessionDir);
  const lines = [
    '=== PICKLE RICK LOOP CONTEXT ===',
    `Phase: ${state.step || 'unknown'}`,
    `Iteration: ${formatIterationLine(state)}`,
    `Session: ${sessionDir}`,
    `Ticket: ${state.current_ticket || 'none'}`,
    `Task: ${truncatedTask}`,
    `PRD: ${prdExists ? 'exists' : 'not yet created'}`,
  ];
  const rawMinIter = Number(state.min_iterations);
  const minIter = Number.isFinite(rawMinIter) ? rawMinIter : 0;
  if (minIter > 0) {
    lines.push(`Min Passes: ${minIter}`);
  }
  if (state.command_template) {
    lines.push(`Template: ${state.command_template}`);
  }
  appendTicketSummaryLines(lines, tickets, state);
  const workingDirs = new Set(tickets.map(t => t.working_dir).filter(Boolean));
  if (workingDirs.size >= 2) {
    lines.push('');
    lines.push(`⚠️  MULTI-REPO: Tickets span ${[...workingDirs].join(', ')}. Consider separate sessions per repo.`);
  }
  appendResumeActionLines(lines, state, iterationNum);
  return lines.join('\n');
}

// Shared buffer for Atomics.wait()-based synchronous sleep (no CPU spin).
const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));

/**
 * Synchronous sleep that yields to the OS scheduler instead of busy-waiting.
 * Contrast the async `sleep()` below — the `Sync` suffix is what matters at a
 * call site, not the unit.
 */
export function sleepSync(ms: number): void {
  Atomics.wait(_sleepBuf, 0, 0, ms);
}

export interface RetryLockOptions {
  /** Maximum number of retry attempts before throwing LockError. Default: 10. */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default: 100. */
  baseLockDelayMs?: number;
  /** Age threshold in ms after which a lock file is considered stale and stolen. Default: 30000. */
  staleLockTimeoutMs?: number;
  /** Whether to add random jitter to backoff delays. Default: true. */
  lockJitter?: boolean;
}

const RETRY_LOCK_DEFAULTS = {
  maxRetries: 10,
  baseLockDelayMs: 100,
  staleLockTimeoutMs: 30_000,
  lockJitter: true,
} as const;

/**
 * The lock payload is the holder's pid (see `tryRunWithExclusiveLock`). Recovery runs under
 * `withStealRight`, so the lock inspected here is the lock removed here — no other stealer can be
 * mid-removal, and the dead holder this judges cannot release its own file.
 */
function stealStaleLock(lockPath: string, staleLockTimeoutMs: number): void {
  withStealRight(lockPath, () => {
    const snapshot = inspectLockFile(lockPath);
    if (!snapshot) return false; // lock file doesn't exist — expected

    // A dead holder is stolen at once. Waiting out staleLockTimeoutMs is not merely slow, it is
    // unreachable: the retry budget (~26.3s over 10 attempts) expires before the 30s window opens.
    const stale = isDeadPidPayload(snapshot.payload)
      || Date.now() - snapshot.mtimeMs > staleLockTimeoutMs;

    return stale ? stealLockFile(lockPath, snapshot) : false;
  });
}

function tryRunWithExclusiveLock<T>(lockPath: string, fn: () => T): { acquired: true; value: T } | { acquired: false } {
  const held = acquireLockFile(lockPath, String(process.pid));
  if (held === null) return { acquired: false };

  try {
    return { acquired: true, value: fn() };
  } finally {
    // Release only our own acquisition: a blind unlink would drop a successor's lock if ours was stolen.
    releaseLockFile(lockPath, held);
  }
}

function sleepBeforeRetry(attempt: number, baseLockDelayMs: number, lockJitter: boolean): void {
  const backoff = baseLockDelayMs * Math.pow(2, attempt);
  const jitter = lockJitter ? Math.random() * baseLockDelayMs : 0;
  sleepSync(Math.min(backoff + jitter, 5000));
}

/**
 * Acquires an exclusive file lock before executing fn, then releases it.
 * Uses O_EXCL atomic create for lock acquisition. Retries with exponential
 * backoff and optional jitter, stealing locks older than staleLockTimeoutMs.
 * Writes PID to lock file for stale detection. NEVER silently falls through —
 * throws LockError if maxRetries is exhausted.
 */
export function withRetryLock<T>(lockPath: string, fn: () => T, opts: RetryLockOptions = {}): T {
  const maxRetries = opts.maxRetries ?? RETRY_LOCK_DEFAULTS.maxRetries;
  const baseLockDelayMs = opts.baseLockDelayMs ?? RETRY_LOCK_DEFAULTS.baseLockDelayMs;
  const staleLockTimeoutMs = opts.staleLockTimeoutMs ?? RETRY_LOCK_DEFAULTS.staleLockTimeoutMs;
  const lockJitter = opts.lockJitter ?? RETRY_LOCK_DEFAULTS.lockJitter;

  let attempt = 0;

  while (true) {
    // Steal stale lock if present — unlink + create in tight sequence to minimize TOCTOU window
    stealStaleLock(lockPath, staleLockTimeoutMs);

    // Atomic exclusive create; write PID for stale-detection by other processes
    const locked = tryRunWithExclusiveLock(lockPath, fn);
    if (locked.acquired) return locked.value;

    if (attempt >= maxRetries) {
      throw new LockError(
        `[pickle] Lock acquisition failed after ${maxRetries} retries (${lockPath})`
      );
    }
    sleepBeforeRetry(attempt, baseLockDelayMs, lockJitter);
    attempt++;
  }
}

/**
 * R-SHB-5/6: Atomically prune `current_sessions.json` entries whose session
 * directory has been deleted or whose `state.json` is unreadable. This is the
 * janitor for the run-#6 forensic operator workaround — pre-fix, 13 phantom
 * map entries pointed at removed session dirs and shadowed live same-cwd
 * lookups in stop-hook + resolver paths.
 *
 * Atomic write via `.tmp.<pid>` rename so concurrent readers never see a
 * truncated map. Returns `{ pruned, total }` so callers can log + decide.
 * Idempotent: missing map file is a no-op; map with all-valid entries is
 * a no-op (no write).
 *
 * Best-effort throughout — never throws on filesystem races, locked files,
 * or malformed map content. The cwd-resolve path calls this BEFORE reading
 * the map, so even a corrupted prune result fails-safe to "no entries
 * pruned + read original map".
 */
export function pruneOrphanedMapEntries(dataRoot: string): { pruned: number; total: number } {
  const sessionsMapPath = path.join(dataRoot, 'current_sessions.json');
  let map: Record<string, unknown> | null;
  try {
    map = readRecoverableJsonObject(sessionsMapPath) as Record<string, unknown> | null;
  } catch {
    return { pruned: 0, total: 0 };
  }
  if (!map || typeof map !== 'object') return { pruned: 0, total: 0 };

  const entries = Object.entries(map);
  const total = entries.length;
  if (total === 0) return { pruned: 0, total: 0 };

  const survivors: Record<string, unknown> = {};
  let pruned = 0;
  for (const [cwd, entry] of entries) {
    const verdict = classifyMapEntry(entry);
    if (verdict.live) {
      survivors[cwd] = entry;
      continue;
    }
    writePhantomSessionDemotedActivity(cwd, verdict.sessionPath);
    pruned++;
  }

  if (pruned === 0) return { pruned: 0, total };
  return commitPrunedSessionMap(sessionsMapPath, survivors) ? { pruned, total } : { pruned: 0, total };
}

/**
 * Verdict for one `current_sessions.json` entry. `sessionPath` is the entry's
 * resolved path (`''` when the entry shape yields none) and is reported as-is
 * in the phantom-demotion activity event, live or not.
 *
 * The `state.json` read stays unconditional: `readRecoverableJsonObject` is the
 * orphan-tmp promotion seam, so short-circuiting it when the base file exists
 * would silently skip promoting a newer `.tmp.<pid>` sibling.
 */
function classifyMapEntry(entry: unknown): { live: boolean; sessionPath: string } {
  const sessionPath = resolveSessionPath(entry);
  if (!sessionPath) return { live: false, sessionPath: '' };

  let dirExists = false;
  try {
    dirExists = fs.statSync(sessionPath).isDirectory();
  } catch {
    // dirExists already false
  }
  if (!dirExists) return { live: false, sessionPath };

  const statePath = path.join(sessionPath, 'state.json');
  const recoveredState = readRecoverableJsonObject(statePath);
  if (!fs.existsSync(statePath) && !recoveredState) return { live: false, sessionPath };

  return { live: true, sessionPath };
}

/**
 * Atomic `.tmp.<pid>`-then-rename publish of the surviving map, so concurrent
 * readers never observe a truncated file. Returns false (and removes the tmp)
 * when the write or rename fails — the caller then reports zero pruned, since
 * the on-disk map is unchanged.
 */
function commitPrunedSessionMap(sessionsMapPath: string, survivors: Record<string, unknown>): boolean {
  const tmpPath = `${sessionsMapPath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(survivors, null, 2));
    fs.renameSync(tmpPath, sessionsMapPath);
    return true;
  } catch {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    return false;
  }
}

/**
 * Extracts the session path from a session map entry.
 * Handles both the legacy string format and the current object format ({ sessionPath, pid })
 * for backward compatibility with existing current_sessions.json files.
 */
export function resolveSessionPath(entry: string | SessionMapEntry | unknown): string {
  if (typeof entry === 'string') return entry;
  if (entry !== null && typeof entry === 'object' && typeof (entry as SessionMapEntry).sessionPath === 'string') {
    return (entry as SessionMapEntry).sessionPath;
  }
  return '';
}

function sameWorkingDir(a: unknown, b: string): boolean {
  return typeof a === 'string' && path.resolve(a) === path.resolve(b);
}

interface SessionLookupState {
  active?: unknown;
  working_dir?: unknown;
  started_at?: unknown;
  pid?: unknown;
  state_mtime_ms?: number;
}

interface SessionLookupCandidate {
  sessionPath: string;
  recencyMs: number;
  hasStartedAt: boolean;
}

const MAX_FUTURE_RECENCY_DRIFT_MS = 5 * 60 * 1000;

function readSessionLookupState(sessionPath: string): SessionLookupState | null {
  try {
    const statePath = path.join(sessionPath, 'state.json');
    const recovered = readRecoverableJsonObject(statePath) as Record<string, unknown> | null;
    if (!recovered || typeof recovered !== 'object' || Array.isArray(recovered)) return null;
    let stateMtimeMs = 0;
    try { stateMtimeMs = fs.statSync(statePath).mtimeMs; } catch { /* state may still be absent after failed promotion */ }
    return {
      active: recovered.active,
      working_dir: recovered.working_dir,
      started_at: recovered.started_at,
      pid: recovered.pid,
      state_mtime_ms: stateMtimeMs,
    };
  } catch {
    return null;
  }
}

function hasParseableStartedAt(state: SessionLookupState): boolean {
  return typeof state.started_at === 'string'
    && Number.isFinite(new Date(state.started_at).getTime());
}

function getSessionRecencyMs(state: SessionLookupState): number {
  if (typeof state.started_at === 'string') {
    const startedAtMs = new Date(state.started_at).getTime();
    const maxTrustedFutureMs = Date.now() + MAX_FUTURE_RECENCY_DRIFT_MS;
    if (Number.isFinite(startedAtMs) && startedAtMs <= maxTrustedFutureMs) {
      return startedAtMs;
    }
  }
  return state.state_mtime_ms ?? 0;
}

/** True when state has a finite-integer pid whose process is provably dead. */
function isDeadPidState(state: SessionLookupState): boolean {
  const pidNum = typeof state.pid === 'number' ? state.pid : Number(state.pid);
  return Number.isInteger(pidNum) && !isProcessAlive(pidNum);
}

function preferNewerSession(
  best: SessionLookupCandidate | null,
  candidate: SessionLookupCandidate,
): SessionLookupCandidate {
  if (!best) return candidate;
  if (candidate.recencyMs !== best.recencyMs) {
    return candidate.recencyMs > best.recencyMs ? candidate : best;
  }
  // Recency tie: a stamped started_at is stronger evidence than coarse mtime.
  if (candidate.hasStartedAt !== best.hasStartedAt) {
    return candidate.hasStartedAt ? candidate : best;
  }
  // Both/neither stamped and recency still ties: keep the incumbent (stable,
  // first-seen-wins on iteration order). No lexical path tie-break.
  return best;
}

function selectScannedSessionPath(
  sessionPaths: string[],
  cwd: string,
  requireActive: boolean,
): string {
  let activeMatch: SessionLookupCandidate | null = null;
  let inactiveMatch: SessionLookupCandidate | null = null;

  for (const sessionPath of sessionPaths) {
    const state = readSessionLookupState(sessionPath);
    if (!state) continue;
    if (!sameWorkingDir(state.working_dir, cwd)) continue;
    const candidate = {
      sessionPath,
      recencyMs: getSessionRecencyMs(state),
      hasStartedAt: hasParseableStartedAt(state),
    };
    // A dead-pid (finite pid && !isProcessAlive) active session is demoted out
    // of activeMatch — a no-pid / non-finite-pid active session stays a live
    // candidate because we cannot prove it dead.
    if (state.active === true && !isDeadPidState(state)) {
      activeMatch = preferNewerSession(activeMatch, candidate);
      continue;
    }
    if (!requireActive) {
      inactiveMatch = preferNewerSession(inactiveMatch, candidate);
    }
  }

  return activeMatch?.sessionPath ?? inactiveMatch?.sessionPath ?? '';
}

function resolveMappedSessionForCwd(
  map: Record<string, unknown>,
  cwd: string,
  requireActive: boolean,
): string | null {
  const mappedPath = resolveSessionPath(map[cwd]);
  if (!mappedPath || !fs.existsSync(mappedPath)) return '';
  const state = readSessionLookupState(mappedPath);
  if (!state) {
    return requireActive ? '' : mappedPath;
  }
  if (sameWorkingDir(state.working_dir, cwd)) {
    if (state.active === true) return mappedPath;
    return requireActive ? '' : mappedPath;
  }
  if (!requireActive && (state.working_dir == null || state.working_dir === '')) {
    return mappedPath;
  }
  return '';
}

function readSessionsMapFallback(sessionsMapPath: string, cwd: string, requireActive: boolean): string {
  try {
    const map = readRecoverableJsonObject(sessionsMapPath) as Record<string, unknown> | null;
    return map ? resolveMappedSessionForCwd(map, cwd, requireActive) ?? '' : '';
  } catch {
    return '';
  }
}

/**
 * Resolves the session for a cwd from the session map first, then falls back
 * to scanning session state by working_dir when the map is missing or stale.
 */
export function findSessionPathForCwd(
  cwd: string,
  options: { requireActive?: boolean } = {},
): string {
  const { requireActive = false } = options;
  const dataRoot = getDataRoot();
  // R-SHB-6: prune phantom map entries before reading. Pre-fix, removed
  // session dirs left stale entries that shadowed live same-cwd lookups.
  pruneOrphanedMapEntries(dataRoot);
  const sessionsMapPath = path.join(dataRoot, 'current_sessions.json');
  const mappedFallback = readSessionsMapFallback(sessionsMapPath, cwd, requireActive);
  if (mappedFallback && requireActive) return mappedFallback;

  const sessionsDir = path.join(dataRoot, 'sessions');
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsDir);
  } catch {
    return mappedFallback;
  }

  const scannedMatch = selectScannedSessionPath(
    entries.map((entry) => path.join(sessionsDir, entry)),
    cwd,
    requireActive,
  );
  if (scannedMatch) {
    return scannedMatch;
  }

  return mappedFallback;
}

/** Matrix palette shared across all monitor panes. */
export const MatrixStyle = {
  BRIGHT: '\x1b[1;32m',    // bold green
  GREEN: '\x1b[32m',       // normal green
  DIM: '\x1b[2;32m',       // dim green
  CYAN: '\x1b[36m',        // cyan accent
  ERR: '\x1b[1;31m',       // bold red
  WARN: '\x1b[33m',        // yellow
  R: '\x1b[0m',            // reset
} as const;

export const RAIN_CHARS = 'ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾍ012345789Z:."=*+-<>¦╌╎';

/** Generates a Matrix-styled separator line with random rain characters. */
export function matrixSeparator(width: number): string {
  const line: string[] = [];
  for (let i = 0; i < width; i++) {
    line.push(Math.random() < 0.2
      ? RAIN_CHARS[Math.floor(Math.random() * RAIN_CHARS.length)]
      : '─');
  }
  return `${MatrixStyle.DIM}${line.join('')}${MatrixStyle.R}`;
}

/**
 * Ranks one `tmux_iteration_N.log` as `[mtimeMs, iterationNumber]`.
 *
 * mtime is PRIMARY because the iteration-number namespace RESETS at every
 * pipeline phase boundary: `mux-runner.ts` (pickle) and `microverse-runner.ts`
 * (anatomy-park, szechuan-sauce) both write `tmux_iteration_<n>.log` into the
 * SAME session dir, each numbering from 1. A max-by-number pick therefore
 * returns the highest-numbered log of whichever phase ran LONGEST, not the live
 * one. The number stays as a deterministic tiebreak for same-millisecond writes.
 * An unstattable entry ranks last so it is picked only when nothing else exists.
 */
function iterationLogRank(sessionDir: string, name: string): [number, number] {
  const num = parseInt(name.replace('tmux_iteration_', '').replace('.log', ''), 10) || 0;
  try {
    return [fs.statSync(path.join(sessionDir, name)).mtimeMs, num];
  } catch {
    return [-Infinity, num];
  }
}

/** Finds the most recent tmux_iteration_N.log in a session directory. */
export function latestIterationLog(sessionDir: string): string | null {
  try {
    const logs = fs
      .readdirSync(sessionDir)
      .filter((f) => f.startsWith('tmux_iteration_') && f.endsWith('.log'))
      .map((name) => ({ name, rank: iterationLogRank(sessionDir, name) }))
      .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1]);
    return logs.length > 0 ? path.join(sessionDir, logs[logs.length - 1].name) : null;
  } catch {
    return null;
  }
}

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;
const DRAIN_CHUNK = 65536; // 64 KiB

/**
 * Reads stream-json log from `offset`, processes complete lines via the
 * provided `processor`, and emits output. Returns new offset and partial
 * trailing line buffer.
 *
 * AP-EXT-ITER7-01 replay: the read is chunked on a BYTE axis, so decoding must
 * run on the STREAM, never per chunk. A `StringDecoder` holds the incomplete
 * multi-byte sequence that straddles a `DRAIN_CHUNK` boundary until the next
 * chunk supplies its remaining bytes -- a per-chunk `.toString('utf-8')` renders
 * each half as U+FFFD instead. `drainLog` below decodes the same way.
 */
export function drainStreamJsonLines(
  logPath: string,
  offset: number,
  lineBuf: string,
  processor: (line: string) => string | null,
  emit: (text: string) => void,
): { offset: number; lineBuf: string } {
  let fd: number | null = null;
  try {
    const { size } = fs.statSync(logPath);
    if (size <= offset) return { offset, lineBuf };
    fd = fs.openSync(logPath, 'r');
    const decoder = new StringDecoder('utf-8');
    let pos = offset;
    let buf = lineBuf;
    while (pos < size) {
      const toRead = Math.min(DRAIN_CHUNK, size - pos);
      const raw = Buffer.allocUnsafe(toRead);
      const bytesRead = fs.readSync(fd, raw, 0, toRead, pos);
      if (bytesRead === 0) break;
      buf += decoder.write(raw.subarray(0, bytesRead));
      pos += bytesRead;
    }
    buf += decoder.end();
    fs.closeSync(fd);
    fd = null;
    const lines = buf.split('\n');
    const trailing = lines.pop() ?? '';
    for (const line of lines) {
      const result = processor(line);
      if (result !== null) emit(result);
    }
    return { offset: pos, lineBuf: trailing };
  } catch {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    return { offset, lineBuf };
  }
}

/**
 * R-MWR-4: detect truncation of a file-tail watcher's current log.
 *
 * When the file at `logPath` is truncated (size shrinks below the
 * caller's recorded `offset`), tail-style watchers must reset their
 * offset and partial-line buffer so post-truncate content is consumed
 * instead of skipped. Without this hook, `drainStreamJsonLines` and
 * `drainLog` early-return on `size <= offset` and the watcher feeds a
 * dead chunk forever.
 *
 * Returns the post-check offset and lineBuf, plus a `truncated` flag
 * the caller uses to print exactly one dim `(reconnecting...)` line
 * per disconnect (R-MWR-6: banner stays reserved for liveness-probe
 * inactive exits, NOT for EOF).
 *
 * Returns the inputs unchanged if the file is missing or unreadable —
 * those cases are owned by the caller's own `latestIterationLog` /
 * worker-log discovery loop.
 */
export function detectLogTruncation(
  logPath: string,
  offset: number,
  lineBuf: string,
): { offset: number; lineBuf: string; truncated: boolean } {
  try {
    const { size } = fs.statSync(logPath);
    if (size < offset) {
      return { offset: 0, lineBuf: '', truncated: true };
    }
  } catch {
    // Missing or unreadable — caller will pick this up on its next
    // discovery iteration. Do not mutate offset.
  }
  return { offset, lineBuf, truncated: false };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Emits log content to stdout, stripping ANSI codes and truncating long lines. */
function emitLog(content: string): void {
  const width = Math.min((process.stdout.columns || 80) - 2, 120);
  const lines = content.replace(ANSI_REGEX, '').split('\n').filter((l) => l.trim());
  for (const line of lines) {
    process.stdout.write((line.length > width ? line.slice(0, width - 1) + '…' : line) + '\n');
  }
}

/**
 * Reads new bytes from a log file starting at `offset`, emits them to stdout,
 * and returns the new offset. Reads in 64 KiB chunks to limit memory usage.
 */
export function drainLog(logPath: string, offset: number): number {
  let fd: number | null = null;
  try {
    const { size } = fs.statSync(logPath);
    if (size <= offset) return offset;
    fd = fs.openSync(logPath, 'r');
    const decoder = new StringDecoder('utf-8');
    let pos = offset;
    while (pos < size) {
      const toRead = Math.min(DRAIN_CHUNK, size - pos);
      const buf = Buffer.allocUnsafe(toRead);
      const bytesRead = fs.readSync(fd, buf, 0, toRead, pos);
      if (bytesRead === 0) break; // EOF — file was truncated
      emitLog(decoder.write(buf.subarray(0, bytesRead)));
      pos += bytesRead;
    }
    const trailing = decoder.end();
    if (trailing) emitLog(trailing);
    fs.closeSync(fd);
    return pos;
  } catch {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore double-close */ }
    }
    return offset;
  }
}

/**
 * Atomically writes `state` as pretty-printed JSON to `filePath`.
 * Writes to a `.tmp` sibling first, then renames — prevents partial reads.
 */
export function writeStateFile(filePath: string, state: State | object): void {
  stateWriteSeq = (stateWriteSeq + 1) % Number.MAX_SAFE_INTEGER;
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${stateWriteSeq}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

const NUMERIC_STATE_KEYS = new Set([
  'iteration', 'max_iterations', 'max_time_minutes', 'worker_timeout_seconds', 'start_time_epoch', 'min_iterations',
]);
const BOOLEAN_STATE_KEYS = new Set(['tmux_mode']);
// active and completion_promise are owned by tmux-runner/cancel.js — never via CLI
const ALLOWED_STATE_KEYS = new Set([
  ...NUMERIC_STATE_KEYS, ...BOOLEAN_STATE_KEYS, 'step', 'working_dir',
  'original_prompt', 'current_ticket', 'started_at', 'session_dir', 'command_template',
]);

/** Throws if `key` is not CLI-writable or `value` is the wrong shape for it. */
function assertValidStateUpdate(key: string, value: string): void {
  if (key === 'step' && !(VALID_STEPS as readonly string[]).includes(value)) {
    throw new Error(`Invalid step "${value}". Must be one of: ${VALID_STEPS.join(', ')}`);
  }

  if (!ALLOWED_STATE_KEYS.has(key)) {
    throw new Error(`Unknown state key "${key}". Allowed: ${[...ALLOWED_STATE_KEYS].join(', ')}`);
  }

  if (NUMERIC_STATE_KEYS.has(key)) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      throw new Error(`Key "${key}" requires a finite number, got "${value}"`);
    }
    if (!Number.isInteger(num)) {
      throw new Error(`Key "${key}" requires an integer, got "${value}"`);
    }
    // worker_timeout_seconds is the only numeric key a zero would break.
    const floor = key === 'worker_timeout_seconds' ? 1 : 0;
    if (num < floor) {
      const bound = floor === 1 ? 'positive' : 'non-negative';
      throw new Error(`Key "${key}" requires a ${bound} integer, got "${value}"`);
    }
  } else if (BOOLEAN_STATE_KEYS.has(key)) {
    if (value !== 'true' && value !== 'false') {
      throw new Error(`Key "${key}" requires "true" or "false", got "${value}"`);
    }
  }
}

function coerceStateValue(key: string, value: string): string | number | boolean {
  if (NUMERIC_STATE_KEYS.has(key)) return Number(value);
  if (BOOLEAN_STATE_KEYS.has(key)) return value === 'true';
  return value;
}

/**
 * Updates a single key in a session's state.json with validation.
 * Numeric, boolean, and step keys are type-checked before writing.
 */
export function updateState(key: string, value: string, sessionDir: string): void {
  const statePath = path.join(sessionDir, 'state.json');

  if (!fs.existsSync(statePath)) {
    throw new Error(`state.json not found at ${statePath}`);
  }

  // Validate BEFORE acquiring the lock to fail fast.
  assertValidStateUpdate(key, value);

  const sm = new StateManager();
  sm.update(statePath, state => {
    (state as unknown as Record<string, unknown>)[key] = coerceStateValue(key, value);
    if (key === 'current_ticket') {
      // R-CNAR-8: retargeting current_ticket must clear all 5 per-ticket cache
      // fields together, or stale tier/budget values skew the next iteration.
      clearTicketCacheFields(state as unknown as { [k: string]: unknown });
    }
  });
  console.log(`Successfully updated ${key} to ${value} in ${statePath}`);
}

/**
 * Monitor-window modes — map to the layout selector inside tmux-monitor.sh.
 * `pickle` is the default (2×2 grid with morty-watcher in the bottom-left);
 * `council` swaps morty-watcher for mux-runner.log tail;
 * `refinement` swaps in refinement-watcher;
 * `szechuan-sauce` / `anatomy-park` preserve the default watcher layout.
 */
export type MonitorMode = 'pickle' | 'council' | 'refinement' | 'szechuan-sauce' | 'anatomy-park';

type MonitorPane = 0 | 1 | 2 | 3;

export interface WatcherPaneCommand {
  pane: MonitorPane;
  name: string;
  command: string;
  /**
   * The value `#{pane_current_command}` reports while this pane is healthy —
   * DERIVED from `command`'s own program, never a separate literal. See
   * `watcherPane`.
   */
  process: string;
}

interface MissingPaneSplitSpec {
  target: string;
  args: string[];
}

export interface EnsureMonitorWindowResult {
  status: 'skipped' | 'created' | 'exists' | 'recreated' | 'error';
  reason?: string;
}

export interface EnsureMonitorWindowOptions {
  sessionDir: string;
  extensionRoot?: string;
  /** Force a specific mode; if omitted, inferred from state.json.command_template. */
  mode?: MonitorMode;
  /** Test override: inject process spawns for tmux/bash calls. */
  spawnSyncFn?: typeof spawnSync;
  /** Test override: if false, skip even when process.env.TMUX is set. */
  inTmux?: boolean;
  /** Test override: tmux binary name (default: "tmux"). */
  tmuxBin?: string;
  /** Test override: bash binary name (default: "bash"). */
  bashBin?: string;
  /** Optional logger — called with human-readable status lines. */
  log?: (msg: string) => void;
}

/**
 * Infers monitor mode from state.json's command_template. Defaults to 'pickle'.
 * Glob mapping: pickle*→pickle, council*→council.
 * Exact mapping: anatomy-park.md→anatomy-park, szechuan-sauce.md→szechuan-sauce, refinement.md→refinement.
 * Missing or unrecognized template defaults to 'pickle' and emits a WARN via optional log.
 */
export function inferMonitorMode(sessionDir: string, log?: (msg: string) => void): MonitorMode {
  try {
    const state = new StateManager().read(path.join(sessionDir, 'state.json')) as { command_template?: string };
    const tpl = (state.command_template || '').toLowerCase();
    if (!tpl) {
      log?.('[ensureMonitorWindow] command_template missing; defaulting to pickle');
      return 'pickle';
    }
    if (tpl.startsWith('pickle')) return 'pickle';
    if (tpl === 'anatomy-park.md') return 'anatomy-park';
    if (tpl === 'szechuan-sauce.md') return 'szechuan-sauce';
    if (tpl.startsWith('council')) return 'council';
    if (tpl === 'refinement.md') return 'refinement';
    log?.(`[ensureMonitorWindow] unrecognized command_template '${state.command_template}'; defaulting to pickle`);
    return 'pickle';
  } catch {
    log?.('[ensureMonitorWindow] command_template missing; defaulting to pickle');
    return 'pickle';
  }
}

export function restartDeadWatcherPanes(
  sessionDir: string,
  extensionRoot: string,
  mode: MonitorMode,
  spawnSyncFn: typeof spawnSync = spawnSync,
  /**
   * R-MWR-3: log-line prefix for respawn decisions. Defaults to
   * `restartDeadWatcherPanes` for boundary-driven invocations
   * (`ensureMonitorWindow` re-attach). The continuous in-monitor
   * watchdog (`startRespawnWatchdog`) passes `monitor-watchdog` so
   * AC-MWR-05 grep can distinguish the two callers in `mux-runner.log`.
   */
  logTag: string = 'restartDeadWatcherPanes',
  // R-MWCL-3: injectable for testing window-missing escalation.
  ensureMonitorWindowFn: (opts: EnsureMonitorWindowOptions) => EnsureMonitorWindowResult = ensureMonitorWindow,
): void {
  const callerName = logTag === 'monitor-watchdog' ? 'startRespawnWatchdog' : 'restartDeadWatcherPanes';
  if (!validateSessionDirOrSkip(sessionDir, callerName as 'restartDeadWatcherPanes' | 'startRespawnWatchdog')) return;
  if (isSessionInactive(sessionDir)) return;

  const sessionName = readCurrentTmuxSessionName(spawnSyncFn);
  if (!sessionName) {
    appendWatcherRestartLog(sessionDir, `${logTag} WARN: unable to resolve tmux session name`);
    return;
  }
  if (isForeignTmuxSession(sessionName, sessionDir)) {
    appendWatcherRestartLog(
      sessionDir,
      `${logTag} WARN: tmux session '${sessionName}' does not host this session's monitor window — skipping respawn`,
    );
    return;
  }

  for (const watcher of watcherPaneCommands(sessionDir, extensionRoot, mode)) {
    if (processWatcherPane(sessionDir, extensionRoot, mode, sessionName, watcher, spawnSyncFn, logTag, ensureMonitorWindowFn)) return;
  }
}

function isSessionInactive(sessionDir: string): boolean {
  try {
    const state = new StateManager().read(path.join(sessionDir, 'state.json')) as { active?: unknown };
    return state.active === false;
  } catch {
    return false;
  }
}

/** Trailing `-`-delimited segment: the session hash both names are keyed by. */
function sessionHashOf(name: string): string {
  return name.slice(name.lastIndexOf('-') + 1);
}

/**
 * We may only drive the tmux session that hosts THIS session's monitor window.
 * `#S` answers "which tmux session is this PROCESS in" — the right answer only
 * when the runner was launched inside the session it manages. A runner that
 * inherits `$TMUX` from somewhere else (a test child, an operator's own window)
 * would otherwise send-keys its pane commands, with Enter, into a stranger's
 * live pane.
 *
 * Launchers name the tmux session `<prefix>-<session-hash>` for the session dir
 * they manage, so the two hashes agree exactly when the window is ours. Fail
 * CLOSED: a name we cannot tie to our own session dir is not ours to drive.
 * Deriving ownership from the pair alone — rather than resolving the name
 * against the data root — is what makes this hold for a runner whose data root
 * does not contain the ambient session.
 */
function isForeignTmuxSession(sessionName: string, sessionDir: string): boolean {
  return sessionHashOf(sessionName) !== sessionHashOf(path.basename(sessionDir));
}

function readCurrentTmuxSessionName(spawnSyncFn: typeof spawnSync): string | null {
  const result = spawnSyncFn('tmux', ['display-message', '-p', '#S'], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (result.status !== 0) return null;
  const sessionName = (result.stdout || '').trim();
  return sessionName || null;
}

function readPaneCurrentCommand(target: string, spawnSyncFn: typeof spawnSync): string | null {
  const result = spawnSyncFn('tmux', ['display-message', '-p', '-t', target, '#{pane_current_command}'], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (result.status !== 0) return null;
  return (result.stdout || '').trim();
}

function withSerializedPath<T>(fn: () => T): T {
  // R-TSPF-4 trap door: tests serialize PATH shim mutations around this
  // helper. Runtime tmux calls stay synchronous; the helper marks the call
  // sites that must stay on the shared serialized path in test fixtures.
  return fn();
}

// Processes one watcher pane entry in the restartDeadWatcherPanes loop.
// Returns true when the outer function should exit immediately (monitor window gone, escalated).
function processWatcherPane(
  sessionDir: string,
  extensionRoot: string,
  mode: MonitorMode,
  sessionName: string,
  watcher: WatcherPaneCommand,
  spawnSyncFn: typeof spawnSync,
  logTag: string,
  ensureMonitorWindowFn: (opts: EnsureMonitorWindowOptions) => EnsureMonitorWindowResult,
): boolean {
  const target = `${sessionName}:monitor.${watcher.pane}`;
  const currentCommand = readPaneCurrentCommand(target, spawnSyncFn);
  if (currentCommand === null) {
    return handleNullPaneCommand(sessionDir, extensionRoot, mode, sessionName, watcher, spawnSyncFn, logTag, ensureMonitorWindowFn) === 'return';
  }
  if (currentCommand === watcher.process) return false;

  appendWatcherRestartLog(
    sessionDir,
    `${logTag} WARN: pane ${watcher.pane} command '${currentCommand || '(empty)'}' is not ${watcher.process}`,
  );
  const result = spawnSyncFn('tmux', ['send-keys', '-t', target, watcher.command, 'Enter'], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (result.status === 0) {
    appendWatcherRestartLog(sessionDir, `${logTag}: respawned ${watcher.name} in pane ${watcher.pane}`);
  } else {
    const err = (result.stderr || result.stdout || '').toString().trim();
    appendWatcherRestartLog(sessionDir, `${logTag} WARN: failed to respawn ${watcher.name} in pane ${watcher.pane}: ${err || 'non-zero exit'}`);
  }
  return false;
}

// R-MWCL-3: extracted from restartDeadWatcherPanes to reduce complexity.
// Probes the monitor window and either escalates to ensureMonitorWindow (returns 'return')
// or delegates to recreateMissingWatcherPane (returns 'continue').
function handleNullPaneCommand(
  sessionDir: string,
  extensionRoot: string,
  mode: MonitorMode,
  sessionName: string,
  watcher: WatcherPaneCommand,
  spawnSyncFn: typeof spawnSync,
  logTag: string,
  ensureMonitorWindowFn: (opts: EnsureMonitorWindowOptions) => EnsureMonitorWindowResult,
): 'return' | 'continue' {
  const listResult = spawnSyncFn('tmux', ['list-panes', '-t', `${sessionName}:monitor`], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (listResult.status !== 0) {
    appendWatcherRestartLog(
      sessionDir,
      `${logTag} collapsed-layout-repair: monitor window missing — escalating to ensureMonitorWindow`,
    );
    ensureMonitorWindowFn({ sessionDir, extensionRoot, mode, spawnSyncFn, inTmux: true });
    return 'return';
  }
  recreateMissingWatcherPane(sessionDir, sessionName, watcher, spawnSyncFn, logTag);
  return 'continue';
}

function recreateMissingWatcherPane(
  sessionDir: string,
  sessionName: string,
  watcher: WatcherPaneCommand,
  spawnSyncFn: typeof spawnSync,
  logTag: string,
): boolean {
  const splitSpec = missingWatcherPaneSplitSpec(sessionName, watcher.pane);
  const split = withSerializedPath(() => spawnSyncFn('tmux', splitSpec.args, {
    encoding: 'utf-8',
    timeout: 5_000,
  }));
  if (split.status !== 0) {
    const err = (split.stderr || split.stdout || '').toString().trim();
    appendWatcherRestartLog(
      sessionDir,
      `${logTag} WARN: failed to recreate missing pane ${watcher.pane} via ${splitSpec.target}: ${err || 'non-zero exit'}`,
    );
    return false;
  }

  appendWatcherRestartLog(
    sessionDir,
    `${logTag} WARN: pane ${watcher.pane} missing; recreated via ${splitSpec.target} [collapsed-layout-repair]`,
  );

  const send = withSerializedPath(() => spawnSyncFn('tmux', ['send-keys', '-t', `${sessionName}:monitor.${watcher.pane}`, watcher.command, 'Enter'], {
    encoding: 'utf-8',
    timeout: 5_000,
  }));
  if (send.status === 0) {
    appendWatcherRestartLog(
      sessionDir,
      `${logTag}: respawned ${watcher.name} in pane ${watcher.pane}`,
    );
    // R-MWCL-3: re-tile after inserting a new pane so the layout lands in a
    // reasonable position rather than inheriting tmux's default stacking.
    withSerializedPath(() => spawnSyncFn('tmux', ['select-layout', '-t', `${sessionName}:monitor`, 'tiled'], {
      encoding: 'utf-8',
      timeout: 5_000,
    }));
    appendWatcherRestartLog(
      sessionDir,
      `${logTag} collapsed-layout-repair: select-layout tiled applied to ${sessionName}:monitor`,
    );
    return true;
  }

  const err = (send.stderr || send.stdout || '').toString().trim();
  appendWatcherRestartLog(
    sessionDir,
    `${logTag} WARN: failed to respawn ${watcher.name} in recreated pane ${watcher.pane}: ${err || 'non-zero exit'}`,
  );
  return false;
}

function missingWatcherPaneSplitSpec(sessionName: string, pane: MonitorPane): MissingPaneSplitSpec {
  const windowTarget = `${sessionName}:monitor`;
  switch (pane) {
    case 0:
      return {
        target: `${windowTarget}.1`,
        args: ['split-window', '-h', '-b', '-t', `${windowTarget}.1`],
      };
    case 1:
      return {
        target: `${windowTarget}.0`,
        args: ['split-window', '-h', '-t', `${windowTarget}.0`],
      };
    case 2:
      return {
        target: `${windowTarget}.0`,
        args: ['split-window', '-v', '-l', '40%', '-t', `${windowTarget}.0`],
      };
    case 3:
      return {
        target: `${windowTarget}.2`,
        args: ['split-window', '-h', '-t', `${windowTarget}.2`],
      };
  }
}

/** Wrap a pane command so its stderr is appended to the per-pane log file. */
function wrapWithStderrRedirect(cmd: string, sessionDir: string, pane: MonitorPane): string {
  const logPath = path.join(sessionDir, `monitor-${pane}.log`);
  // `exec` is load-bearing, not style: without it bash FORKS the program and
  // remains the pane's foreground process, so `#{pane_current_command}` reports
  // `bash` for a perfectly healthy watcher. Measured on tmux 3.7c / bash 3.2:
  // `bash -c 'node x 2>>log'` -> `bash`; `bash -c 'exec node x 2>>log'` -> `node`.
  // The redirect survives the exec either way.
  return `bash -c 'exec ${cmd} 2>>"${logPath}"'`;
}

/**
 * Builds one pane entry from its raw (unwrapped) command. `command` and
 * `process` are derived from the SAME string, so the launcher and the
 * health predicate cannot drift apart — which is exactly what happened while
 * the predicate was a hardcoded `'node'` literal and council's pane 2 ran
 * `tail -F`.
 */
function watcherPane(
  pane: MonitorPane,
  name: string,
  rawCommand: string,
  sessionDir: string,
): WatcherPaneCommand {
  return {
    pane,
    name,
    command: wrapWithStderrRedirect(rawCommand, sessionDir, pane),
    process: path.basename(rawCommand.split(' ')[0]),
  };
}

export function watcherPaneCommands(sessionDir: string, extensionRoot: string, mode: MonitorMode): WatcherPaneCommand[] {
  const binRoot = path.join(extensionRoot, 'extension', 'bin');
  let paneTwo: WatcherPaneCommand;
  switch (mode) {
    case 'pickle':
    case 'council':
    case 'refinement':
    case 'szechuan-sauce':
    case 'anatomy-park':
      paneTwo = watcherPaneTwoCommand(sessionDir, binRoot, mode);
      break;
  }

  return [
    watcherPane(0, 'monitor.js', `node ${path.join(binRoot, 'monitor.js')} ${sessionDir}`, sessionDir),
    watcherPane(1, 'log-watcher.js', `node ${path.join(binRoot, 'log-watcher.js')} ${sessionDir}`, sessionDir),
    paneTwo,
    watcherPane(3, 'raw-morty.js', `node ${path.join(binRoot, 'raw-morty.js')} ${sessionDir}`, sessionDir),
  ];
}

function watcherPaneTwoCommand(sessionDir: string, binRoot: string, mode: MonitorMode): WatcherPaneCommand {
  switch (mode) {
    case 'refinement':
      return watcherPane(2, 'refinement-watcher.js', `node ${path.join(binRoot, 'refinement-watcher.js')} ${sessionDir}`, sessionDir);
    case 'council':
      return watcherPane(2, 'mux-runner.log tail', `tail -F ${path.join(sessionDir, 'mux-runner.log')}`, sessionDir);
    case 'pickle':
      return watcherPane(2, 'morty-watcher.js', `node ${path.join(binRoot, 'morty-watcher.js')} ${sessionDir}`, sessionDir);
    case 'szechuan-sauce':
    case 'anatomy-park':
      return watcherPane(2, 'pane-1-2-pointer.js', `node ${path.join(binRoot, 'pane-1-2-pointer.js')} ${sessionDir}`, sessionDir);
  }
}

function appendWatcherRestartLog(sessionDir: string, line: string): void {
  try {
    fs.appendFileSync(path.join(sessionDir, 'mux-runner.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Best-effort diagnostic logging must not break pane recovery.
  }
}

/** Dedup guard: emit only one activity event per (caller, sessionDir, reason) tuple per process. */
const _sessionDirInvalidEmitted = new Map<string, boolean>();

/**
 * Validates sessionDir before tmux-watcher invocation. Returns true when valid; returns false
 * and emits a monitor_respawn_session_dir_invalid activity event (once per tuple) when invalid.
 *
 * Checks (in order): non-empty string → path exists → state.json present → resolved path matches state
 */
export function validateSessionDirOrSkip(
  sessionDir: string,
  caller: 'restartDeadWatcherPanes' | 'respawnMonitorWindowForMode' | 'startRespawnWatchdog',
): boolean {
  let reason: 'empty' | 'enoent' | 'no_state_json' | 'session_dir_mismatch' | null = null;

  if (!sessionDir || typeof sessionDir !== 'string') {
    reason = 'empty';
  } else if (!fs.existsSync(sessionDir)) {
    reason = 'enoent';
  } else if (!fs.existsSync(path.join(sessionDir, 'state.json'))) {
    reason = 'no_state_json';
  } else {
    try {
      const sm = new StateManager();
      const state = sm.read(path.join(sessionDir, 'state.json')) as { session_dir?: string };
      if (state.session_dir && path.resolve(state.session_dir) !== path.resolve(sessionDir)) {
        reason = 'session_dir_mismatch';
      }
    } catch {
      reason = 'session_dir_mismatch';
    }
  }

  if (reason === null) return true;

  const dedupeKey = `${caller}:${sessionDir}:${reason}`;
  if (_sessionDirInvalidEmitted.has(dedupeKey)) return false;
  _sessionDirInvalidEmitted.set(dedupeKey, true);

  appendWatcherRestartLog(sessionDir, `validateSessionDirOrSkip WARN: ${caller} skipped — sessionDir ${reason} (${sessionDir})`);

  try {
    const ts = new Date();
    const activityDir = path.join(getCanonicalActivityDataRoot(), 'activity');
    fs.mkdirSync(activityDir, { recursive: true });
    const event: ActivityEvent = {
      ts: ts.toISOString(),
      event: 'monitor_respawn_session_dir_invalid',
      source: 'pickle',
      gate_payload: { caller, sessionDir, reason },
    } as unknown as ActivityEvent;
    fs.appendFileSync(
      path.join(activityDir, `${formatLocalDateKey(ts)}.jsonl`),
      `${JSON.stringify(event)}\n`,
      { mode: 0o600 },
    );
  } catch (err) {
    process.stderr.write(`[pickle-rick] Failed to log monitor_respawn_session_dir_invalid: ${safeErrorMessage(err)}\n`);
  }

  return false;
}

/** Test helper: resets the session-dir-invalid dedup map. */
export function _resetSessionDirInvalidEmittedForTests(): void {
  _sessionDirInvalidEmitted.clear();
}

/**
 * Idempotently creates the 4-pane monitor window in the current tmux session.
 *
 * Called at the start of every long-running pickle tmux runner (mux-runner,
 * pipeline-runner) so agents never have to invoke tmux-monitor.sh explicitly —
 * previously Step 11e of several skill prompts, silently dropped when the
 * agent's context was tight.
 *
 * Never throws. Returns a status so callers can log the outcome:
 *   - `skipped`    → not inside tmux (headless or direct invocation), or the
 *                    ambient tmux session is not the one hosting our monitor
 *                    window (`isForeignTmuxSession`) — we do not kill or create
 *                    windows in a session we do not own
 *   - `exists`     → monitor window already present for this mode, no-op
 *   - `created`    → monitor window spawned
 *   - `recreated`  → stale monitor (different mode) killed and respawned
 *   - `error`      → tmux/bash call failed; check `reason`
 *
 * Mode compatibility: the monitor window's layout is mode-specific
 * (pickle/council/refinement). We persist the mode it was built for
 * via a tmux user-option (`@pickle_monitor_mode`) on the window itself, then
 * on re-entry compare against the mode this invocation wants. Mismatch =>
 * kill + recreate. Silent reuse would leave the wrong layout in place.
 */
export function ensureMonitorWindow(opts: EnsureMonitorWindowOptions): EnsureMonitorWindowResult {
  const log = opts.log || (() => { /* no-op */ });
  const inTmux = opts.inTmux !== undefined ? opts.inTmux : !!process.env.TMUX;

  if (!inTmux) {
    log('ensureMonitorWindow: not inside tmux, skipping');
    return { status: 'skipped', reason: 'not in tmux' };
  }

  activeMonitorWindowContext = {
    opts,
    log,
    tmuxBin: opts.tmuxBin || 'tmux',
    bashBin: opts.bashBin || 'bash',
    spawnSyncFn: opts.spawnSyncFn || spawnSync,
    mode: opts.mode || inferMonitorMode(opts.sessionDir, log),
  };
  try {
    const sessionName = getSessionName();
    if (!sessionName) return activeMonitorWindowContext.outcome || { status: 'error', reason: 'empty session name' };
    if (isForeignTmuxSession(sessionName, opts.sessionDir)) {
      log(`ensureMonitorWindow: tmux session '${sessionName}' does not host this session's monitor window — skipping`);
      return { status: 'skipped', reason: `foreign tmux session: ${sessionName}` };
    }
    const { recreate } = checkAndRecreateWindow(sessionName);
    if (activeMonitorWindowContext.outcome) return activeMonitorWindowContext.outcome;
    createMonitorWindow(sessionName);
    if (activeMonitorWindowContext.outcome) return activeMonitorWindowContext.outcome;
    if (recreate) {
      log(`ensureMonitorWindow: recreated 4-pane monitor (mode=${activeMonitorWindowContext.mode}) on ${sessionName}`);
      return { status: 'recreated' };
    }
    log(`ensureMonitorWindow: created 4-pane monitor (mode=${activeMonitorWindowContext.mode}) on ${sessionName}`);
    return { status: 'created' };
  } finally {
    activeMonitorWindowContext = null;
  }
}

interface MonitorWindowContext {
  opts: EnsureMonitorWindowOptions;
  log: (msg: string) => void;
  tmuxBin: string;
  bashBin: string;
  spawnSyncFn: typeof spawnSync;
  mode: MonitorMode;
  outcome?: EnsureMonitorWindowResult;
}

let activeMonitorWindowContext: MonitorWindowContext | null = null;

function currentMonitorWindowContext(): MonitorWindowContext {
  if (!activeMonitorWindowContext) throw new Error('ensureMonitorWindow context not initialized');
  return activeMonitorWindowContext;
}

function getSessionName(): string | null {
  const { log, spawnSyncFn, tmuxBin } = currentMonitorWindowContext();
  // Resolve session name via tmux itself — the TMUX env var alone only proves
  // we're inside *some* tmux, not which session owns this pane.
  const displayName = spawnSyncFn(tmuxBin, ['display-message', '-p', '#S'], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (displayName.status !== 0) {
    const err = (displayName.stderr || '').toString().trim();
    log(`ensureMonitorWindow: tmux display-message failed: ${err}`);
    activeMonitorWindowContext!.outcome = { status: 'error', reason: `display-message: ${err || 'non-zero exit'}` };
    return null;
  }
  const sessionName = (displayName.stdout || '').trim();
  if (!sessionName) {
    log('ensureMonitorWindow: empty tmux session name');
    activeMonitorWindowContext!.outcome = { status: 'error', reason: 'empty session name' };
    return null;
  }
  return sessionName;
}

function checkAndRecreateWindow(sessionName: string): { recreate: boolean } {
  const { log, mode, opts, spawnSyncFn, tmuxBin } = currentMonitorWindowContext();
  const target = `${sessionName}:monitor`;

  // Compatibility guard — a "monitor" window from a previous command (e.g.
  // anatomy-park then council) has the wrong layout. Check the window's
  // `@pickle_monitor_mode` user-option and recreate on mismatch.
  const listWindows = spawnSyncFn(tmuxBin, ['list-windows', '-t', sessionName, '-F', '#W'], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (listWindows.status !== 0) return { recreate: false };
  const names = (listWindows.stdout || '').split('\n').map(s => s.trim());
  if (!names.includes('monitor')) return { recreate: false };

  const existingMode = readWindowMode(tmuxBin, target, spawnSyncFn);
  if (monitorModesCompatible(existingMode, mode)) {
    log(`ensureMonitorWindow: monitor window already exists on ${sessionName} (mode=${mode})`);
    restartDeadWatcherPanes(opts.sessionDir, resolveMonitorExtensionRoot(opts), mode, spawnSyncFn);
    activeMonitorWindowContext!.outcome = { status: 'exists' };
    return { recreate: false };
  }

  log(
    `ensureMonitorWindow: mode mismatch on ${sessionName} ` +
    `(existing=${existingMode || 'unset'}, want=${mode}) — killing stale window`,
  );
  const kill = spawnSyncFn(tmuxBin, ['kill-window', '-t', target], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (kill.status !== 0) {
    const err = (kill.stderr || '').toString().trim();
    log(`ensureMonitorWindow: kill-window failed: ${err}`);
    activeMonitorWindowContext!.outcome = { status: 'error', reason: `kill-window: ${err || 'non-zero exit'}` };
    return { recreate: false };
  }
  return { recreate: true };
}

function createMonitorWindow(sessionName: string): void {
  const { bashBin, log, mode, opts, spawnSyncFn, tmuxBin } = currentMonitorWindowContext();
  const target = `${sessionName}:monitor`;
  const extensionRoot = resolveMonitorExtensionRoot(opts);
  const script = path.join(extensionRoot, 'extension', 'scripts', 'tmux-monitor.sh');
  if (!fs.existsSync(script)) {
    log(`ensureMonitorWindow: tmux-monitor.sh missing at ${script}`);
    activeMonitorWindowContext!.outcome = { status: 'error', reason: `script missing: ${script}` };
    return;
  }

  const result = spawnSyncFn(bashBin, [script, sessionName, opts.sessionDir, mode], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || '').toString().trim();
    log(`ensureMonitorWindow: tmux-monitor.sh failed (exit ${result.status}): ${err}`);
    activeMonitorWindowContext!.outcome = { status: 'error', reason: `script exit ${result.status}: ${err || 'no stderr'}` };
    return;
  }

  // Stamp the mode on the freshly-created window so the next invocation can
  // detect compatibility. Non-fatal if it fails — we log and move on.
  const setOpt = spawnSyncFn(
    tmuxBin,
    ['set-option', '-w', '-t', target, '@pickle_monitor_mode', mode],
    { encoding: 'utf-8', timeout: 5_000 },
  );
  if (setOpt.status !== 0) {
    const err = (setOpt.stderr || '').toString().trim();
    log(`ensureMonitorWindow: set-option @pickle_monitor_mode failed (non-fatal): ${err}`);
  }
}

function resolveMonitorExtensionRoot(opts: EnsureMonitorWindowOptions): string {
  return opts.extensionRoot ? resolveExtensionRoot(opts.extensionRoot) : getExtensionRoot();
}

/** Reads the monitor window's stamped mode via tmux user-option, or null. */
function readWindowMode(tmuxBin: string, target: string, spawnSyncFn: typeof spawnSync): string | null {
  const show = spawnSyncFn(
    tmuxBin,
    ['show-option', '-w', '-qv', '-t', target, '@pickle_monitor_mode'],
    { encoding: 'utf-8', timeout: 5_000 },
  );
  if (show.status !== 0) return null;
  const val = (show.stdout || '').trim();
  return val || null;
}

/**
 * Returns true iff we can reuse an existing monitor window without recreating.
 * Unset existing mode counts as incompatible — we can't prove the layout matches
 * what this mode needs, so play it safe and rebuild.
 */
export function monitorModesCompatible(existing: string | null, want: MonitorMode): boolean {
  if (!existing) return false;
  switch (want) {
    case 'pickle':
      return existing === 'pickle';
    case 'council':
      return existing === 'council';
    case 'refinement':
      return existing === 'refinement';
    case 'szechuan-sauce':
      return existing === 'szechuan-sauce';
    case 'anatomy-park':
      return existing === 'anatomy-park';
  }
}

export interface RespawnMonitorWindowForModeOpts {
  /** Test seam: inject process spawns for tmux calls. */
  spawnSyncFn?: typeof spawnSync;
  /** Test seam: force tmux-available/unavailable. Defaults to !!process.env.TMUX. */
  inTmux?: boolean;
  /** Optional logger written to pipeline-runner.log via the caller's log function. */
  log?: (msg: string) => void;
}

async function _killPidGracefully(pid: number): Promise<void> {
  try {
    process.kill(pid, 0);
    process.kill(pid, 'SIGTERM');
    await new Promise<void>(resolve => setTimeout(resolve, 1000));
    try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  } catch { /* pid already dead — nothing to do */ }
}

async function _killOldMonitorPid(smLocal: StateManager, statePath: string): Promise<void> {
  try {
    const s = smLocal.read(statePath) as unknown as Record<string, unknown>;
    const oldPid = s.monitor_pid;
    if (typeof oldPid === 'number' && oldPid > 0) await _killPidGracefully(oldPid);
  } catch { /* best-effort */ }
}

function _resolveTmuxSessionName(
  spawnSyncFn: typeof spawnSync,
  log: (msg: string) => void,
  mode: string,
): string | null {
  const r = spawnSyncFn('tmux', ['display-message', '-p', '#S'], { encoding: 'utf-8', timeout: 5_000 });
  if (r.status !== 0) { log(`monitor: tmux display-message failed for mode ${mode}`); return null; }
  const name = ((r.stdout as string) || '').trim();
  if (!name) { log(`monitor: empty tmux session name for mode ${mode}`); return null; }
  return name;
}

function _tmuxRespawnPane(
  spawnSyncFn: typeof spawnSync,
  target: string,
  command: string,
  log: (msg: string) => void,
  mode: string,
): boolean {
  const r = spawnSyncFn('tmux', ['respawn-pane', '-k', '-t', target, command], { encoding: 'utf-8', timeout: 5_000 });
  if (r.status !== 0) {
    const err = ((r.stderr as string) || '').trim() || 'non-zero exit';
    log(`monitor: respawn-pane failed for mode ${mode}: ${err}`);
    return false;
  }
  return true;
}

function _tmuxGetPanePid(spawnSyncFn: typeof spawnSync, target: string): number | null {
  try {
    const r = spawnSyncFn('tmux', ['display-message', '-p', '-t', target, '#{pane_pid}'], { encoding: 'utf-8', timeout: 5_000 });
    if (r.status === 0) {
      const parsed = parseInt(((r.stdout as string) || '').trim(), 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
  } catch { /* best-effort */ }
  return null;
}

function _updateMonitorState(smLocal: StateManager, statePath: string, newPid: number | null, mode: string): void {
  try {
    smLocal.update(statePath, s => {
      const ext = s as unknown as Record<string, unknown>;
      ext.monitor_pid = newPid;
      ext.monitor_mode = mode;
    });
  } catch { /* best-effort */ }
}

/**
 * Respawns the monitor dashboard pane (pane 0) with --mode set to `mode`.
 *
 * Returns 'no-op' when:
 *   - sessionDir is invalid (validateSessionDirOrSkip)
 *   - state.monitor_mode already equals `mode`
 *   - not inside tmux
 *   - the ambient tmux session is not ours (isForeignTmuxSession)
 *   - tmux respawn-pane fails
 * Returns 'respawned' on success; updates state.monitor_pid and state.monitor_mode.
 * Logs `monitor: respawned for mode <mode>` via opts.log so the line appears in
 * pipeline-runner.log (AC-MDS-01).
 */
export async function respawnMonitorWindowForMode(
  sessionDir: string,
  mode: string,
  opts?: RespawnMonitorWindowForModeOpts,
): Promise<'respawned' | 'no-op'> {
  if (!validateSessionDirOrSkip(sessionDir, 'respawnMonitorWindowForMode')) return 'no-op';

  const statePath = path.join(sessionDir, 'state.json');
  const smLocal = new StateManager();
  const log = opts?.log ?? (() => undefined);

  try {
    const s = smLocal.read(statePath) as unknown as Record<string, unknown>;
    if (s.monitor_mode === mode) return 'no-op';
  } catch { /* tolerate read failure — proceed */ }

  await _killOldMonitorPid(smLocal, statePath);

  const inTmux = opts?.inTmux !== undefined ? opts.inTmux : !!process.env.TMUX;
  if (!inTmux) { log(`monitor: tmux unavailable, skipping respawn for mode ${mode}`); return 'no-op'; }

  const spawnSyncFn = opts?.spawnSyncFn ?? spawnSync;
  const sessionName = _resolveTmuxSessionName(spawnSyncFn, log, mode);
  if (!sessionName) return 'no-op';
  // `respawn-pane -k` KILLS the target pane. `validateSessionDirOrSkip` above proves
  // our sessionDir is coherent — it says nothing about whose tmux session `#S` named.
  if (isForeignTmuxSession(sessionName, sessionDir)) {
    log(`monitor: tmux session '${sessionName}' does not host this session's monitor window — skipping respawn for mode ${mode}`);
    return 'no-op';
  }

  const extensionRoot = getExtensionRoot();
  const monitorBin = path.join(extensionRoot, 'extension', 'bin', 'monitor.js');
  const target = `${sessionName}:monitor.0`;
  const ok = _tmuxRespawnPane(spawnSyncFn, target, `node ${monitorBin} --mode ${mode} ${sessionDir}`, log, mode);
  if (!ok) return 'no-op';

  const newPid = _tmuxGetPanePid(spawnSyncFn, target);
  _updateMonitorState(smLocal, statePath, newPid, mode);
  log(`monitor: respawned for mode ${mode}`);
  return 'respawned';
}

/** Default timeout for macOS notification shell-outs (`osascript`). Kept short
 *  because notifications run on the exit path — a wedged Notification Center /
 *  AppleEvent daemon must NOT block `process.exit` on the runner. Four prior
 *  "improve notification" passes (8db2771, 2f19356, f9f37ef, 2da7fe5, 8cc31a6)
 *  added features and fixed content but none passed a `timeout`; see trap door
 *  in extension/CLAUDE.md and anatomy-park iteration 4 commit. */
export const NOTIFICATION_TIMEOUT_MS = 5_000;

export interface DisplayMacNotificationOptions {
  /** @internal test seam — override `spawnSync` to capture invocations / inject hangs */
  spawnSyncFn?: typeof spawnSync;
  /** @internal test seam — force the darwin code path on any platform */
  forceDarwin?: boolean;
  /** Override the default NOTIFICATION_TIMEOUT_MS (primarily for tests) */
  timeoutMs?: number;
}

/** Display a macOS notification via `osascript`. No-op on non-darwin platforms.
 *  Every invocation passes an explicit `timeout` so a wedged UI server cannot
 *  block the caller indefinitely. Any error (ENOENT, SIGTERM on timeout,
 *  non-zero exit) is swallowed — notifications are best-effort at program exit. */
export function displayMacNotification(
  title: string,
  body: string,
  subtitle?: string,
  opts: DisplayMacNotificationOptions = {},
): void {
  const isDarwin = opts.forceDarwin ?? process.platform === 'darwin';
  if (!isDarwin) return;
  const timeoutMs = opts.timeoutMs ?? NOTIFICATION_TIMEOUT_MS;
  const spawnSyncFn = opts.spawnSyncFn ?? spawnSync;
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = subtitle
    ? `display notification "${esc(body)}" with title "${esc(title)}" subtitle "${esc(subtitle)}"`
    : `display notification "${esc(body)}" with title "${esc(title)}"`;
  try {
    spawnSyncFn('osascript', ['-e', script], { timeout: timeoutMs, encoding: 'utf-8' });
  } catch { /* best-effort: ENOENT / timeout / non-zero exit are all non-fatal */ }
}

/**
 * Removes inactive session directories older than maxAgeDays from sessionsRoot.
 * A directory with no state.json (e.g. the in-tree scaffold, which holds only
 * TASK_NOTES.md) has no liveness signal to check, so it ages off its own
 * directory mtime instead of being skipped.
 *
 * "Has a state.json" is decided through the recovery layer, never a bare
 * `existsSync`: `state.json` is written tmp-rename, so a crash in that window
 * leaves the only copy in a sibling `state.json.tmp.<pid>`. An existsSync-only
 * read of that session sees no liveness signal and `rmSync`s a recoverable
 * snapshot — the orphan-tmp delete-authority invariant (a tmp may be unlinked
 * only when positively proven garbage) inverted into a whole-directory delete.
 */
export function pruneOldSessions(sessionsRoot: string, maxAgeDays = 7): void {
  if (!fs.existsSync(sessionsRoot)) return;
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const maxTrustedFutureMs = Date.now() + MAX_FUTURE_RECENCY_DRIFT_MS;
  const sm = new StateManager();
  for (const entry of fs.readdirSync(sessionsRoot)) {
    const sessionDir = path.join(sessionsRoot, entry);
    const statePath = path.join(sessionDir, 'state.json');
    try {
      const sessionDirMtimeMs = fs.statSync(sessionDir).mtimeMs;
      let startedMs = sessionDirMtimeMs;
      // Short-circuits on a present base (sm.read owns corrupt-base recovery);
      // otherwise the recovering read promotes a dead-writer orphan tmp so the
      // session is judged on its own state, not on the scaffold rule.
      const carriesState = fs.existsSync(statePath) || readRecoverableJsonObject(statePath) !== null;
      if (carriesState) {
        const state = sm.read(statePath);
        if (state.active === true) { continue; }
        const rawMs = state.started_at
          ? new Date(state.started_at).getTime()
          : NaN;
        startedMs = Number.isFinite(rawMs) && rawMs <= maxTrustedFutureMs
          ? rawMs
          : sessionDirMtimeMs;
      }
      if (startedMs < cutoffMs) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    } catch { /* skip unreadable or already-deleted sessions */ }
  }
}

// --- Manager prompt composition helpers ---

/**
 * Strips the Setup section from dual-mode templates (e.g. szechuan-sauce.md).
 * The mux-runner always invokes with --resume, so Setup instructions are dead weight
 * that confuse the model. Strips from "## SETUP" (with or without " MODE" suffix) to
 * the next ##-level heading, regardless of its name. This avoids coupling to a specific
 * end-marker like "## REVIEW PASS MODE" — any template layout works.
 */
export function stripSetupSection(prompt: string): string {
  const setupRe = /^## SETUP(?: MODE)?$/m;
  const setupMatch = setupRe.exec(prompt);
  if (!setupMatch) return prompt;

  const afterSetup = prompt.slice(setupMatch.index + setupMatch[0].length);
  const nextHeadingRe = /^## \S/m;
  const nextMatch = nextHeadingRe.exec(afterSetup);
  if (!nextMatch) return prompt;

  const endIndex = setupMatch.index + setupMatch[0].length + nextMatch.index;
  return prompt.slice(0, setupMatch.index) + prompt.slice(endIndex);
}

/**
 * Strips the "# Step 1: Initialization" block from a manager skill prompt.
 * The block contains setup.js --task examples that codex executes verbatim when
 * present in manager payloads. Strips from the heading through the start of
 * "# Step 2:", exclusive (the Step 2 heading is preserved).
 */
export function stripStepOneBlock(prompt: string): string {
  const step1Re = /^# Step 1: Initialization\s*$/m;
  const step1Match = step1Re.exec(prompt);
  if (!step1Match) return prompt;

  const afterStep1 = prompt.slice(step1Match.index);
  const step2Re = /^# Step 2:/m;
  const step2Match = step2Re.exec(afterStep1);
  if (!step2Match) return prompt;

  const endIndex = step1Match.index + step2Match.index;
  return prompt.slice(0, step1Match.index) + prompt.slice(endIndex);
}

/**
 * Read-time remap for legacy command_template values. Treats 'pickle.md' as an
 * alias for '_pickle-manager-prompt.md' so sessions persisted before B-PNTR
 * resume without FATAL once pickle.md is removed (R-PNTR-5). Value-only — no
 * schema version change. 'pickle.md' literal is allowed here per R-PNTR-3 + R-PNTR-5.
 */
export function resolveCommandTemplate(raw: string | undefined): string {
  if (!raw || raw === 'pickle.md') return '_pickle-manager-prompt.md'; // R-PNTR-3 legacy remap
  return raw;
}

/**
 * AP-EXT-ITER109-01: the ONE resolver for a `command_template` name -> manager
 * prompt path. Every loop runner that launches a manager routes through it.
 *
 * It THROWS on both refusals — an unresolvable template is a per-LAUNCH fact, so
 * the disposition belongs to the caller that knows what one launch is worth. The
 * jar batch turns it into a failed task and runs the next one; mux-runner turns it
 * into a failed iteration. `process.exit` here would decide that for both, and it
 * decided wrong: it ended an unattended Night Shift after task 1 of N and left that
 * task's `state.json` at `active: true` with no `exit_reason`, because exiting skips
 * every deactivate path the runner has.
 *
 * The plain-filename refusal is not separable from the lookup. `path.join` resolves
 * `..` before `existsSync` sees it, so a traversing spelling reads a file from
 * neither search directory and hands it to the manager as its prompt.
 */
export function resolveManagerPromptPath(extensionRoot: string, templateName: string): string {
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

/**
 * HTML-comment framing block injected at the top of codex manager prompts.
 * Mirrors the GIT_BOUNDARY_RULES pattern that codex demonstrably respects.
 */
export const MANAGER_ROLE_FRAMING_BLOCK = `<!-- BEGIN MANAGER_ROLE_FRAMING -->
You are the Pickle Rick manager process. Your role is to read state.json and orchestrate Morty worker agents via spawn-morty.js.

PROHIBITED in this manager session:
- DO NOT send SIGTERM/SIGINT/SIGKILL to the mux-runner subprocess.
- DO NOT decide that mux-runner is wedged based on session-directory observation.
- DO NOT attempt to bypass mux-runner by spawning spawn-morty.js directly.
- Running \`node <path>/setup.js --task\` or \`node <path>/setup.js --resume\` as a Bash command
- Treating setup.js usage examples from documentation sections as executable instructions
- Executing any \`setup.js\` invocation shown in template text — those are documentation examples
- Worker proliferation (multiple \`worker_session_*.log\` files per ticket) is normal lifecycle evidence, not proof of a wedge.
- Real wedge detection is owned by runtime state such as \`circuit_breaker.json\` and \`state.exit_reason\`, not by self-appointed manager diagnosis from session artifacts.

Your ONLY valid setup.js invocation is the one already completed to initialize this session. Proceed directly to Step 2: Execution.
<!-- END MANAGER_ROLE_FRAMING -->`;

export interface ComposeManagerPromptOpts {
  argumentSubstitution: string;
  handoffText?: string;
  iterationSummary?: string;
  taskNotes?: string;
}

/**
 * Composes the full manager prompt from a skill file path, applying all
 * standard transforms and optionally prepending Role Framing for codex.
 * Call sites pre-resolve handoffText/iterationSummary/taskNotes strings.
 */
export function composeManagerPromptFromSkill(
  skillPath: string,
  backend: Backend,
  opts: ComposeManagerPromptOpts,
): string {
  let content = fs.readFileSync(skillPath, 'utf-8');
  content = content.replace(/\$ARGUMENTS/g, opts.argumentSubstitution);
  content = content.replace(/\$\{EXTENSION_ROOT\}/g, getExtensionRoot());
  content = stripSetupSection(content);
  content = stripStepOneBlock(content);
  if (opts.handoffText) content += '\n\n' + opts.handoffText;
  if (opts.iterationSummary) content += '\n\n' + opts.iterationSummary;
  if (opts.taskNotes) content += '\n\n=== TASK NOTES (from previous iterations) ===\n' + opts.taskNotes;
  if (backend === 'codex') content = MANAGER_ROLE_FRAMING_BLOCK + '\n\n' + content;
  return content;
}

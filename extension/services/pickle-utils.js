import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { VALID_STEPS, UNBOUNDED_READ_MAX_BUFFER } from '../types/index.js';
import { StateManager } from './state-manager.js';
import { readRecoverableJsonObject } from './recoverable-json.js';
import { MAX_FUTURE_RECENCY_DRIFT_MS, readSessionsMapFallback, resolveSessionPath, selectScannedSessionPath } from './session-resolution.js';
import { MANAGER_ROLE_FRAMING_BLOCK, stripSetupSection, stripStepOneBlock } from './manager-prompt.js';
import { updateTicketStatusInTransaction } from './transaction-ticket-ops.js';
import { isRecord } from '../lib/is-record.js';
import { normalizeTicketComplexityTier } from './ticket-tier.js';
let stateWriteSeq = 0;
const DEFAULT_MICROVERSE_SETTINGS = {
    judge_backend: 'claude',
    judge_backend_fallback: 'codex',
    judge_model_claude: 'claude-sonnet-4-6',
    judge_model_codex: 'gpt-5.4',
};
function isJudgeBackendValue(value) {
    return value === 'claude' || value === 'codex' || value === 'auto';
}
function isBackendFallbackValue(value) {
    return value === 'claude' || value === 'codex';
}
function resolveJudgeBackendChoice(value) {
    return isJudgeBackendValue(value) ? value : null;
}
function resolveBackendFallback(value) {
    return isBackendFallbackValue(value) ? value : null;
}
function isTypedFailure(failure) {
    return !!failure && isRecord(failure) && typeof failure.failureKind === 'string';
}
/**
 * Reads the `microverse` block out of a settings bag, substituting
 * `DEFAULT_MICROVERSE_SETTINGS` for every field that is absent, mistyped, or
 * blank. A null/malformed bag yields the full defaults.
 */
export function getMicroverseSettings(settings) {
    const microverse = isRecord(settings) && isRecord(settings.microverse)
        ? settings.microverse
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
export function clearTicketCacheFields(state) {
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
export function safeErrorMessage(err) {
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
};
export function getWidth(maxW = 90) {
    const cols = process.stdout.columns || 80;
    return Math.min(cols - 4, maxW);
}
export function getHeight(fallback = 24) {
    const rows = process.stdout.rows;
    return rows && rows > 0 ? rows : fallback;
}
export function wrapText(text, width) {
    if (!Number.isFinite(width) || width <= 0)
        return [text];
    const lines = [];
    const words = text.split(' ');
    let currentLine = '';
    for (const word of words) {
        if ((currentLine === '' ? word : currentLine + ' ' + word).length <= width) {
            currentLine += (currentLine === '' ? '' : ' ') + word;
        }
        else {
            if (currentLine)
                lines.push(currentLine);
            currentLine = word;
            while (currentLine.length > width) {
                lines.push(currentLine.slice(0, width));
                currentLine = currentLine.slice(width);
            }
        }
    }
    if (currentLine)
        lines.push(currentLine);
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
];
/** The dynamic half of the scrub set: `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`. */
export const GIT_CONFIG_INDEXED_ENV_KEY_RE = /^GIT_CONFIG_(KEY|VALUE)_\d+$/;
/**
 * Returns a shallow copy of `env` with every `PICKLE_GATE_SCRUBBED_ENV_KEYS` entry
 * (plus every indexed `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` present) deleted —
 * absent, not present-with-`undefined`. Never throws.
 */
export function scrubGateEnv(env = process.env) {
    const result = { ...env };
    for (const key of PICKLE_GATE_SCRUBBED_ENV_KEYS)
        delete result[key];
    for (const key of Object.keys(result)) {
        if (GIT_CONFIG_INDEXED_ENV_KEY_RE.test(key))
            delete result[key];
    }
    return result;
}
export function printMinimalPanel(title, fields, colorName = 'GREEN', icon = '🥒') {
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
        process.stdout.write(`  ${d}${key + ':'}${' '.repeat(maxKeyLen - key.length - 1)}${r} ${wrappedVal[0]}\n`);
        for (let i = 1; i < wrappedVal.length; i++) {
            process.stdout.write(`  ${' '.repeat(maxKeyLen)} ${wrappedVal[i]}\n`);
        }
    }
    process.stdout.write('\n');
}
export function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}m ${s}s`;
}
/** Compact ISO stamp safe for use in file/dir names: `2026-04-27T20-15-30Z`. */
export function isoCompactStamp(d = new Date()) {
    return d.toISOString().replace(/:/g, '-').replace(/\..+/, 'Z');
}
/** Local calendar day key used for filenames/report buckets: `YYYY-MM-DD`. */
export function formatLocalDateKey(d) {
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
/**
 * A truncated read is a WRONG ANSWER, never a soft failure — so it throws for
 * every caller, including `check: false` ones whose contract is otherwise
 * "degrade to empty". Those callers degrade on a command that FAILED; ENOBUFS
 * is the harness losing bytes from a command that SUCCEEDED, and returning its
 * prefix silently hands a partial repo enumeration to the scope fence.
 * Deliberately narrow: ETIMEDOUT still degrades as before, because its partial
 * output is empty-or-tiny and the `check: false` probes are written to expect it.
 */
function assertNotTruncated(cmd, error) {
    if (error?.code !== 'ENOBUFS')
        return;
    throw new Error(`Command output exceeded ${UNBOUNDED_READ_MAX_BUFFER} bytes and was truncated: ${cmd}`);
}
function runArgvCmd(cmd, options) {
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
function shellErrorOutput(error, stream) {
    return error instanceof Error && stream in error
        ? String(error[stream] || '')
        : '';
}
function runShellCmd(cmd, options) {
    try {
        const stdout = execSync(cmd, {
            cwd: options.cwd,
            encoding: 'utf-8',
            timeout: 30_000,
            maxBuffer: UNBOUNDED_READ_MAX_BUFFER,
            stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        });
        return (stdout || '').trim();
    }
    catch (error) {
        assertNotTruncated(cmd, error);
        if (options.check) {
            const msg = shellErrorOutput(error, 'stderr') || safeErrorMessage(error);
            throw new Error(`Command failed: ${cmd}\nError: ${msg}`);
        }
        return shellErrorOutput(error, 'stdout').trim();
    }
}
export function runCmd(cmd, options = {}) {
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
export function getExtensionRoot() {
    return resolveExtensionRoot(process.env.EXTENSION_DIR);
}
export function resolveExtensionRoot(requestedRoot) {
    if (!requestedRoot)
        return CANONICAL_EXTENSION_ROOT;
    if (extensionRootSentinelExists(requestedRoot))
        return requestedRoot;
    if (allowsMissingExtensionSentinelForTests())
        return requestedRoot;
    emitExtensionDirFallbackOnce(requestedRoot, CANONICAL_EXTENSION_ROOT, `missing sentinel ${path.join(requestedRoot, EXTENSION_ROOT_SENTINEL)}`);
    return CANONICAL_EXTENSION_ROOT;
}
function extensionRootSentinelExists(extensionRoot) {
    return fs.existsSync(path.join(extensionRoot, EXTENSION_ROOT_SENTINEL)) ||
        fs.existsSync(path.join(extensionRoot, INSTALL_ROOT_SENTINEL));
}
function allowsMissingExtensionSentinelForTests() {
    return process.env.NODE_ENV === 'test' && process.env[EXTENSION_DIR_TEST] === '1';
}
function emitExtensionDirFallbackOnce(requestedPath, fallbackPath, reason) {
    if (extensionDirFallbackEmitted)
        return;
    extensionDirFallbackEmitted = true;
    process.stderr.write(`[pickle-rick] EXTENSION_DIR fallback: requested=${requestedPath} fallback=${fallbackPath} reason=${reason}\n`);
    writeExtensionDirFallbackActivity(requestedPath, fallbackPath, reason);
}
function writeExtensionDirFallbackActivity(requestedPath, fallbackPath, reason) {
    try {
        const ts = new Date();
        const activityDir = path.join(getCanonicalActivityDataRoot(), 'activity');
        fs.mkdirSync(activityDir, { recursive: true });
        const event = {
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
    }
    catch (err) {
        process.stderr.write(`[pickle-rick] Failed to log extension_dir_fallback: ${safeErrorMessage(err)}\n`);
    }
}
function writePhantomSessionDemotedActivity(cwd, sessionPath) {
    try {
        const ts = new Date();
        const activityDir = path.join(getDataRoot(), 'activity');
        fs.mkdirSync(activityDir, { recursive: true });
        const event = {
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
    }
    catch (err) {
        process.stderr.write(`[pickle-rick] Failed to log phantom_session_demoted: ${safeErrorMessage(err)}\n`);
    }
}
/**
 * The data root resolved WITHOUT `getDataRoot()`'s `EXTENSION_DIR` arm. Exactly ONE caller may
 * use this: `writeExtensionDirFallbackActivity`, whose whole subject is that `EXTENSION_DIR` was
 * just REJECTED — resolving its own diagnostic through the value it is reporting as bad would
 * file the record under the broken root. Every other activity write goes through `getDataRoot()`,
 * the same resolver `activity-logger.ts` uses, so it honours the `EXTENSION_DIR` isolation
 * dialect. Do NOT add callers: an emitter that is not ABOUT `EXTENSION_DIR` has no reason to
 * ignore it, and each one that does writes into the operator's real `~/.local/share/pickle-rick`
 * from any test that isolates via `EXTENSION_DIR`.
 */
function getCanonicalActivityDataRoot() {
    if (process.env.PICKLE_DATA_ROOT)
        return process.env.PICKLE_DATA_ROOT;
    if (process.env.PICKLE_DATA_DIR)
        return process.env.PICKLE_DATA_DIR;
    return path.join(os.homedir(), '.local/share/pickle-rick');
}
/** Test helper: resets process-level fallback emission guard. */
export function _resetExtensionDirFallbackForTests() {
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
export function getDataRoot() {
    if (process.env.PICKLE_DATA_ROOT)
        return process.env.PICKLE_DATA_ROOT;
    if (process.env.PICKLE_DATA_DIR)
        return process.env.PICKLE_DATA_DIR;
    const extDir = process.env.EXTENSION_DIR;
    if (extDir) {
        const canonicalExtDir = path.join(os.homedir(), '.claude/pickle-rick');
        if (path.resolve(extDir) !== path.resolve(canonicalExtDir))
            return extDir;
    }
    return path.join(os.homedir(), '.local/share/pickle-rick');
}
export function statusSymbol(status) {
    const s = (status || '').toLowerCase().replace(/^["']|["']$/g, '');
    if (s === 'done')
        return '[x]';
    if (s === 'in progress')
        return '[~]';
    if (s === 'skipped')
        return '[!]';
    return '[ ]';
}
/**
 * Safely extracts YAML frontmatter from a string without catastrophic regex backtracking.
 * Uses indexOf for delimiter search — O(n) regardless of content shape.
 * Returns the frontmatter body and byte offsets, or null if no valid block found.
 */
export function extractFrontmatter(content) {
    // Support both Unix (\n) and Windows (\r\n) line endings
    const openLen = content.startsWith('---\r\n') ? 5 : content.startsWith('---\n') ? 4 : 0;
    if (openLen === 0)
        return null;
    const closeIdx = content.indexOf('\n---', openLen);
    if (closeIdx === -1)
        return null;
    // +4 for '\n---', +1 more if followed by a newline to consume the full delimiter line
    const rawEnd = closeIdx + 4;
    const end = content[rawEnd] === '\n' ? rawEnd + 1 : content[rawEnd] === '\r' && content[rawEnd + 1] === '\n' ? rawEnd + 2 : rawEnd;
    return { body: content.slice(openLen, closeIdx), start: 0, end };
}
export function readFrontmatterField(content, field) {
    const fm = extractFrontmatter(content);
    if (!fm)
        return null;
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = fm.body.match(new RegExp(`^${escaped}:\\s*(.+)$`, 'm'));
    if (!match)
        return null;
    const raw = match[1].trim().replace(/^["']|["']$/g, '');
    return raw.length > 0 ? raw : null;
}
export function upsertFrontmatterField(content, field, value) {
    const fm = extractFrontmatter(content);
    if (!fm)
        return null;
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const line = `${field}: "${value}"`;
    if (new RegExp(`^${escaped}:\\s*(.+)$`, 'm').test(fm.body)) {
        const nextBody = fm.body.replace(new RegExp(`^${escaped}:\\s*(.+)$`, 'm'), line);
        return content.slice(0, fm.start) + `---\n${nextBody}\n---\n` + content.slice(fm.end);
    }
    const closingNewline = content.lastIndexOf('\n---', fm.end - 1);
    if (closingNewline === -1)
        return null;
    const insertPoint = closingNewline + 1;
    return content.slice(0, insertPoint) + `${line}\n` + content.slice(insertPoint);
}
export function ticketFilePath(sessionDir, ticketId) {
    return path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`);
}
export function clearTicketResolutionTimestamps(content) {
    const fm = extractFrontmatter(content);
    if (!fm)
        return content;
    const filteredBody = fm.body
        .split(/\r?\n/)
        .filter((line) => !/^(completed_at|skipped_at):\s*/.test(line))
        .join('\n');
    return content.slice(0, fm.start) + `---\n${filteredBody}\n---\n` + content.slice(fm.end);
}
export { CLASSIFIER_EXPENSIVE_VERIFY_KEYWORDS, TICKET_TIER_BUDGETS, TIER_DIFF_ENVELOPE, TIER_LIFECYCLE, VALID_TICKET_COMPLEXITY_TIERS, VISUAL_DOMINANCE_THRESHOLD, classifyDiffVisualDominance, classifyTicketTier, getTicketTierBudgetWithOverrides, normalizeTicketComplexityTier, readPickleSettingsTierCaps, readStateTierCapOverrides, ticketInfoBudget, ticketTierBudget, } from './ticket-tier.js';
export { DEFAULT_BOUNDED_TERMINAL_ESCAPE_CAP, DEFAULT_BREAKER_RECOVERY_GRACE_SECONDS, DEFAULT_FAILED_FLIP_SUPPRESSION_CAP, DEFAULT_MAX_PARK_MINUTES, DEFAULT_RATE_LIMIT_PROBE_INTERVAL_MS, DEFAULT_SILENT_DEATH_RESPAWN_CAP, DEFAULT_TIER_STALL_THRESHOLD_MS, MIN_RATE_LIMIT_PROBE_INTERVAL_MS, RATE_LIMIT_PROBE_INTERVAL_ENV_VAR, RATE_LIMIT_PROBE_LOG_FILENAME, RATE_LIMIT_PROBE_PROMPT, RATE_LIMIT_PROBE_TIMEOUT_MS, TIER_STALL_THRESHOLD_ENV_VAR, TIER_STALL_THRESHOLD_FLOOR_MS, resolveCodegraphSettings, resolveHardeningSettings, resolveRateLimitProbeIntervalMs, resolveRateLimitSettings, resolveScopeSettings, resolveTierStallThresholdMs, } from './pickle-settings.js';
// AC-P3: extracted concerns re-exported so every import path is preserved.
export { resolveSessionPath } from './session-resolution.js';
export { MatrixStyle, RAIN_CHARS, detectLogTruncation, drainLog, drainStreamJsonLines, latestIterationLog, matrixSeparator, } from './log-tail.js';
export { sleepSync, withRetryLock } from './retry-lock.js';
export { MANAGER_ROLE_FRAMING_BLOCK, resolveCommandTemplate, resolveManagerPromptPath, stripSetupSection, stripStepOneBlock, } from './manager-prompt.js';
export function loadPickleSettingsBag(extensionRoot = getExtensionRoot()) {
    try {
        const settingsPath = path.join(extensionRoot, 'pickle_settings.json');
        return readRecoverableJsonObject(settingsPath);
    }
    catch {
        return null;
    }
}
export function resolveWorkerTestGateTimeoutMs(extensionRoot = getExtensionRoot(), settings, env = process.env) {
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
export function resolveJudgeBackend(state, settings, attempt = 0, lastFailure) {
    const microverseSettings = settings === undefined
        ? getMicroverseSettings(loadPickleSettingsBag())
        : getMicroverseSettings(settings);
    const flags = isRecord(state?.flags) ? state.flags : {};
    const chosen = resolveJudgeBackendChoice(flags['judge_backend_override']) ?? microverseSettings.judge_backend;
    if (chosen !== 'auto')
        return chosen;
    if (!isTypedFailure(lastFailure) && attempt === 0)
        return 'claude';
    const resolved = isRecord(state) ? state.judge_backend_resolved : undefined;
    const fromState = resolveJudgeBackendChoice(resolved);
    if (fromState && fromState !== 'auto') {
        return fromState;
    }
    return microverseSettings.judge_backend_fallback ?? DEFAULT_MICROVERSE_SETTINGS.judge_backend_fallback;
}
export class MissingTicketError extends Error {
    sessionRoot;
    ticketId;
    ticketPath;
    constructor(sessionRoot, ticketId, ticketPath) {
        super(`Ticket ${ticketId} not found in session ${sessionRoot}`);
        this.sessionRoot = sessionRoot;
        this.ticketId = ticketId;
        this.ticketPath = ticketPath;
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
function readFrontmatterStringArray(body, key) {
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
    if (index < 0)
        return [];
    const values = [];
    for (let i = index + 1; i < lines.length; i += 1) {
        const match = /^\s+-\s+(.+?)\s*$/.exec(lines[i]);
        if (!match)
            break;
        values.push(match[1].replace(/^['"]|['"]$/g, ''));
    }
    return values;
}
export function parseTicketFrontmatter(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const fm = extractFrontmatter(content);
        if (!fm)
            return null;
        const get = (field) => {
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
        const seen = new Set();
        const depends_on = [];
        for (const dep of rawDeps) {
            const cleaned = dep.replace(/^external:\s*/i, '').trim();
            if (!cleaned || seen.has(cleaned))
                continue;
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
    }
    catch {
        return null;
    }
}
export function getTicketStatus(sessionRoot, ticketId) {
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
export function normalizeCompletionCommitField(raw) {
    if (typeof raw !== 'string')
        return null;
    // `readFrontmatterField` already strips one symmetric quote pair via the
    // `g` flag, but defend-in-depth here: re-strip leading/trailing single OR
    // double quotes (paired or unpaired) and trim residual whitespace before
    // validating SHA hex. Belt + suspenders prevents future drift where a
    // caller invokes this with a raw frontmatter line.
    const stripped = raw.trim().replace(/^["']+|["']+$/g, '').trim();
    if (!stripped)
        return null;
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
export function markTicketWithStatus(sessionDir, ticketId, status) {
    try {
        const planned = updateTicketStatusInTransaction(ticketId, status, sessionDir);
        fs.writeFileSync(planned.path, planned.content);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Marks a ticket's frontmatter status as "Done" by rewriting the status line.
 * No-op if ticket dir or file doesn't exist, or status is already Done.
 */
export function markTicketDone(sessionDir, ticketId) {
    return markTicketWithStatus(sessionDir, ticketId, 'Done');
}
export function markTicketSkipped(sessionDir, ticketId) {
    return markTicketWithStatus(sessionDir, ticketId, 'Skipped');
}
/**
 * Build the dependency graph (indegree + reverse edges) for topoSortTickets.
 * Extracted purely to keep the main function under cyclomatic-complexity 15.
 */
function buildTicketDepGraph(tickets) {
    const byId = new Map();
    tickets.forEach((t, index) => {
        if (t.id)
            byId.set(t.id, index);
    });
    const indegree = new Map();
    const edges = new Map();
    for (let i = 0; i < tickets.length; i++) {
        indegree.set(i, 0);
        edges.set(i, []);
    }
    for (let i = 0; i < tickets.length; i++) {
        for (const depId of tickets[i].depends_on) {
            const depIdx = byId.get(depId);
            if (depIdx === undefined)
                continue; // external/unknown dep — ignore for ordering
            edges.get(depIdx).push(i);
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
export function topoSortTickets(tickets) {
    if (tickets.length <= 1)
        return [...tickets];
    const { indegree, edges } = buildTicketDepGraph(tickets);
    const compare = (a, b) => {
        const oa = tickets[a].order;
        const ob = tickets[b].order;
        return oa !== ob ? oa - ob : a - b;
    };
    const ready = [];
    for (let i = 0; i < tickets.length; i++) {
        if ((indegree.get(i) || 0) === 0)
            ready.push(i);
    }
    ready.sort(compare);
    const out = [];
    while (ready.length > 0) {
        const i = ready.shift();
        out.push(tickets[i]);
        for (const next of edges.get(i)) {
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
export function collectTickets(sessionDir) {
    try {
        const entries = fs.readdirSync(sessionDir, { withFileTypes: true });
        const tickets = [];
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const subDir = path.join(sessionDir, entry.name);
            try {
                const files = fs.readdirSync(subDir);
                for (const file of files) {
                    if (!file.startsWith('rick_ticket_') || !file.endsWith('.md'))
                        continue;
                    const parsed = parseTicketFrontmatter(path.join(subDir, file));
                    if (!parsed)
                        continue;
                    // R-TIDNULL: `id` is LLM-authored frontmatter, so it can be absent; the id
                    // is ALSO structurally encoded in the canonical path this walk just took
                    // (`<sessionDir>/<id>/rick_ticket_<id>.md`, the same path `ticketFilePath`
                    // builds). Resolve it HERE, once, rather than leaving a null for every
                    // downstream reader to re-derive a policy for: their shared `!t.id` skip
                    // idiom inverts under a universal quantifier, so the same "ignore it" that
                    // means "don't select this ticket" in a selector means "the roster is
                    // finished" in `evaluateEpicCompletion`/`noRunnableTicketsRemain` — and an
                    // unrun ticket then exits the epic `success`. Derive ONLY on an exact
                    // canonical-name match, which proves `ticketFilePath(sessionDir, id)`
                    // resolves back to the file just parsed; a non-canonical file (an archived
                    // or misfiled copy) keeps `id: null` and stays out of the roster's reach.
                    const canonical = file === `rick_ticket_${entry.name}.md`;
                    tickets.push(parsed.id || !canonical ? parsed : { ...parsed, id: entry.name });
                }
            }
            catch {
                /* skip */
            }
        }
        return topoSortTickets(tickets);
    }
    catch {
        return [];
    }
}
function formatIterationLine(state) {
    const iter = Number(state.iteration) || 0;
    const maxIter = Number(state.max_iterations) || 0;
    return maxIter > 0 ? `${iter} of ${maxIter}` : `${iter}`;
}
function appendTicketSummaryLines(lines, tickets, state) {
    if (tickets.length === 0)
        return;
    lines.push('Tickets:');
    for (const ticket of tickets) {
        lines.push(formatTicketSummaryLine(ticket, state));
    }
}
function formatTicketSummaryLine(t, state) {
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
function appendResumeActionLines(lines, state, iterationNum) {
    const isFirstIteration = (iterationNum === 1 || iterationNum === undefined)
        && (Number(state.iteration) || 0) === 0
        && (state.history || []).length === 0;
    lines.push('');
    if (isFirstIteration) {
        lines.push('THIS IS A NEW SESSION. Begin the lifecycle from the current phase.', 'Read state.json for full context, then start working on the task.');
        return;
    }
    lines.push('NEXT ACTION: Resume from current phase. Read state.json for context.', 'Do NOT restart from scratch. Continue where you left off.');
}
export function buildHandoffSummary(state, sessionDir, iterationNum) {
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
export function pruneOrphanedMapEntries(dataRoot) {
    const sessionsMapPath = path.join(dataRoot, 'current_sessions.json');
    let map;
    try {
        map = readRecoverableJsonObject(sessionsMapPath);
    }
    catch {
        return { pruned: 0, total: 0 };
    }
    if (!map || typeof map !== 'object')
        return { pruned: 0, total: 0 };
    const entries = Object.entries(map);
    const total = entries.length;
    if (total === 0)
        return { pruned: 0, total: 0 };
    const survivors = {};
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
    if (pruned === 0)
        return { pruned: 0, total };
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
function classifyMapEntry(entry) {
    const sessionPath = resolveSessionPath(entry);
    if (!sessionPath)
        return { live: false, sessionPath: '' };
    let dirExists = false;
    try {
        dirExists = fs.statSync(sessionPath).isDirectory();
    }
    catch {
        // dirExists already false
    }
    if (!dirExists)
        return { live: false, sessionPath };
    const statePath = path.join(sessionPath, 'state.json');
    const recoveredState = readRecoverableJsonObject(statePath);
    if (!fs.existsSync(statePath) && !recoveredState)
        return { live: false, sessionPath };
    return { live: true, sessionPath };
}
/**
 * Atomic `.tmp.<pid>`-then-rename publish of the surviving map, so concurrent
 * readers never observe a truncated file. Returns false (and removes the tmp)
 * when the write or rename fails — the caller then reports zero pruned, since
 * the on-disk map is unchanged.
 */
function commitPrunedSessionMap(sessionsMapPath, survivors) {
    const tmpPath = `${sessionsMapPath}.tmp.${process.pid}`;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(survivors, null, 2));
        fs.renameSync(tmpPath, sessionsMapPath);
        return true;
    }
    catch {
        try {
            fs.unlinkSync(tmpPath);
        }
        catch { /* ignore */ }
        return false;
    }
}
/**
 * Resolves the session for a cwd from the session map first, then falls back
 * to scanning session state by working_dir when the map is missing or stale.
 */
export function findSessionPathForCwd(cwd, options = {}) {
    const { requireActive = false } = options;
    const dataRoot = getDataRoot();
    // R-SHB-6: prune phantom map entries before reading. Pre-fix, removed
    // session dirs left stale entries that shadowed live same-cwd lookups.
    pruneOrphanedMapEntries(dataRoot);
    const sessionsMapPath = path.join(dataRoot, 'current_sessions.json');
    const mappedFallback = readSessionsMapFallback(sessionsMapPath, cwd, requireActive);
    if (mappedFallback && requireActive)
        return mappedFallback;
    const sessionsDir = path.join(dataRoot, 'sessions');
    let entries;
    try {
        entries = fs.readdirSync(sessionsDir);
    }
    catch {
        return mappedFallback;
    }
    const scannedMatch = selectScannedSessionPath(entries.map((entry) => path.join(sessionsDir, entry)), cwd, requireActive);
    if (scannedMatch) {
        return scannedMatch;
    }
    return mappedFallback;
}
export function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
/**
 * Atomically writes `state` as pretty-printed JSON to `filePath`.
 * Writes to a `.tmp` sibling first, then renames — prevents partial reads.
 */
export function writeStateFile(filePath, state) {
    stateWriteSeq = (stateWriteSeq + 1) % Number.MAX_SAFE_INTEGER;
    const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${stateWriteSeq}`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
        fs.renameSync(tmp, filePath);
    }
    catch (err) {
        try {
            fs.unlinkSync(tmp);
        }
        catch { /* ignore cleanup failure */ }
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
function assertValidStateUpdate(key, value) {
    if (key === 'step' && !VALID_STEPS.includes(value)) {
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
    }
    else if (BOOLEAN_STATE_KEYS.has(key)) {
        if (value !== 'true' && value !== 'false') {
            throw new Error(`Key "${key}" requires "true" or "false", got "${value}"`);
        }
    }
}
function coerceStateValue(key, value) {
    if (NUMERIC_STATE_KEYS.has(key))
        return Number(value);
    if (BOOLEAN_STATE_KEYS.has(key))
        return value === 'true';
    return value;
}
/**
 * Updates a single key in a session's state.json with validation.
 * Numeric, boolean, and step keys are type-checked before writing.
 */
export function updateState(key, value, sessionDir) {
    const statePath = path.join(sessionDir, 'state.json');
    if (!fs.existsSync(statePath)) {
        throw new Error(`state.json not found at ${statePath}`);
    }
    // Validate BEFORE acquiring the lock to fail fast.
    assertValidStateUpdate(key, value);
    const sm = new StateManager();
    sm.update(statePath, state => {
        state[key] = coerceStateValue(key, value);
        if (key === 'current_ticket') {
            // R-CNAR-8: retargeting current_ticket must clear all 5 per-ticket cache
            // fields together, or stale tier/budget values skew the next iteration.
            clearTicketCacheFields(state);
        }
    });
    console.log(`Successfully updated ${key} to ${value} in ${statePath}`);
}
export { _resetSessionDirInvalidEmittedForTests, ensureMonitorWindow, inferMonitorMode, monitorModesCompatible, respawnMonitorWindowForMode, restartDeadWatcherPanes, validateSessionDirOrSkip, watcherPaneCommands, } from './monitor-window.js';
/** Wrap a pane command so its stderr is appended to the per-pane log file. */
export function wrapWithStderrRedirect(cmd, sessionDir, pane) {
    const logPath = path.join(sessionDir, `monitor-${pane}.log`);
    // `exec` is load-bearing, not style: without it bash FORKS the program and
    // remains the pane's foreground process, so `#{pane_current_command}` reports
    // `bash` for a perfectly healthy watcher. Measured on tmux 3.7c / bash 3.2:
    // `bash -c 'node x 2>>log'` -> `bash`; `bash -c 'exec node x 2>>log'` -> `node`.
    // The redirect survives the exec either way.
    return `bash -c 'exec ${cmd} 2>>"${logPath}"'`;
}
async function _killPidGracefully(pid) {
    try {
        process.kill(pid, 0);
        process.kill(pid, 'SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 1000));
        try {
            process.kill(pid, 0);
            process.kill(pid, 'SIGKILL');
        }
        catch { /* already gone */ }
    }
    catch { /* pid already dead — nothing to do */ }
}
export async function _killOldMonitorPid(smLocal, statePath) {
    try {
        const s = smLocal.read(statePath);
        const oldPid = s.monitor_pid;
        if (typeof oldPid === 'number' && oldPid > 0)
            await _killPidGracefully(oldPid);
    }
    catch { /* best-effort */ }
}
/** Default timeout for macOS notification shell-outs (`osascript`). Kept short
 *  because notifications run on the exit path — a wedged Notification Center /
 *  AppleEvent daemon must NOT block `process.exit` on the runner. Four prior
 *  "improve notification" passes (8db2771, 2f19356, f9f37ef, 2da7fe5, 8cc31a6)
 *  added features and fixed content but none passed a `timeout`; see trap door
 *  in extension/CLAUDE.md and anatomy-park iteration 4 commit. */
export const NOTIFICATION_TIMEOUT_MS = 5_000;
/** Display a macOS notification via `osascript`. No-op on non-darwin platforms.
 *  Every invocation passes an explicit `timeout` so a wedged UI server cannot
 *  block the caller indefinitely. Any error (ENOENT, SIGTERM on timeout,
 *  non-zero exit) is swallowed — notifications are best-effort at program exit. */
export function displayMacNotification(title, body, subtitle, opts = {}) {
    const isDarwin = opts.forceDarwin ?? process.platform === 'darwin';
    if (!isDarwin)
        return;
    const timeoutMs = opts.timeoutMs ?? NOTIFICATION_TIMEOUT_MS;
    const spawnSyncFn = opts.spawnSyncFn ?? spawnSync;
    const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = subtitle
        ? `display notification "${esc(body)}" with title "${esc(title)}" subtitle "${esc(subtitle)}"`
        : `display notification "${esc(body)}" with title "${esc(title)}"`;
    try {
        spawnSyncFn('osascript', ['-e', script], { timeout: timeoutMs, encoding: 'utf-8' });
    }
    catch { /* best-effort: ENOENT / timeout / non-zero exit are all non-fatal */ }
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
export function pruneOldSessions(sessionsRoot, maxAgeDays = 7) {
    if (!fs.existsSync(sessionsRoot))
        return;
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
                if (state.active === true) {
                    continue;
                }
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
        }
        catch { /* skip unreadable or already-deleted sessions */ }
    }
}
/**
 * Composes the full manager prompt from a skill file path, applying all
 * standard transforms and optionally prepending Role Framing for codex.
 * Call sites pre-resolve handoffText/iterationSummary/taskNotes strings.
 */
export function composeManagerPromptFromSkill(skillPath, backend, opts) {
    let content = fs.readFileSync(skillPath, 'utf-8');
    content = content.replace(/\$ARGUMENTS/g, opts.argumentSubstitution);
    content = content.replace(/\$\{EXTENSION_ROOT\}/g, getExtensionRoot());
    content = stripSetupSection(content);
    content = stripStepOneBlock(content);
    if (opts.handoffText)
        content += '\n\n' + opts.handoffText;
    if (opts.iterationSummary)
        content += '\n\n' + opts.iterationSummary;
    if (opts.taskNotes)
        content += '\n\n=== TASK NOTES (from previous iterations) ===\n' + opts.taskNotes;
    if (backend === 'codex')
        content = MANAGER_ROLE_FRAMING_BLOCK + '\n\n' + content;
    return content;
}

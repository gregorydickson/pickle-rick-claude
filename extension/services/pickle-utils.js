import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StringDecoder } from 'string_decoder';
import { VALID_STEPS, LockError } from '../types/index.js';
import { StateManager, isProcessAlive } from './state-manager.js';
import { readRecoverableJsonObject } from './recoverable-json.js';
import { updateTicketStatusInTransaction } from './transaction-ticket-ops.js';
import { isRecord } from '../lib/is-record.js';
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
function getMicroverseSettingsWithDefaults(settings) {
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
/** Extracts a string message from any thrown value. Never throws. */
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
function runArgvCmd(cmd, options) {
    const result = spawnSync(cmd[0], cmd.slice(1), {
        cwd: options.cwd,
        encoding: 'utf-8',
        timeout: 30_000,
        stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    if (options.check && (result.status ?? 1) !== 0) {
        throw new Error(`Command failed: ${cmd.join(' ')}\nError: ${result.stderr || ''}`);
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
            stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        });
        return (stdout || '').trim();
    }
    catch (error) {
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
function resolveExtensionRoot(requestedRoot) {
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
        const activityDir = path.join(getCanonicalActivityDataRoot(), 'activity');
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
    return path.join(sessionDir, ticketId, `linear_ticket_${ticketId}.md`);
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
export const VALID_TICKET_COMPLEXITY_TIERS = ['trivial', 'small', 'medium', 'large'];
export const TICKET_TIER_BUDGETS = {
    trivial: { max_iterations: 5, worker_timeout_seconds: 5 * 60 },
    small: { max_iterations: 10, worker_timeout_seconds: 10 * 60 },
    medium: { max_iterations: 30, worker_timeout_seconds: 60 * 60 },
    large: { max_iterations: 60, worker_timeout_seconds: 80 * 60 },
};
export const TIER_LIFECYCLE = {
    trivial: ['implement', 'code_review'],
    small: ['plan', 'implement', 'code_review'],
    medium: ['research', 'research_review', 'plan', 'plan_review', 'implement', 'conformance', 'code_review', 'simplify'],
    large: ['research', 'research_review', 'plan', 'plan_review', 'implement', 'conformance', 'code_review', 'simplify'],
};
/** R-PIAP-A3: max changed LOC (additions + deletions) for each compact tier. Tunable. */
export const TIER_DIFF_ENVELOPE = {
    trivial: 20,
    small: 80,
};
export function normalizeTicketComplexityTier(value) {
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (VALID_TICKET_COMPLEXITY_TIERS.includes(normalized)) {
            return normalized;
        }
    }
    return 'medium';
}
const CLASSIFIER_SMALLER_KEYWORDS = ['padding', 'typo', 'rename', 'delete', 'copy', 'label', 'color'];
const CLASSIFIER_LARGER_KEYWORDS = ['integrate', 'migrate', 'schema', 'cross-cutting', 'refactor'];
function classifyDimension(val, thresholds) {
    if (val < thresholds[0])
        return 0; // trivial
    if (val < thresholds[1])
        return 1; // small
    if (val < thresholds[2])
        return 2; // medium
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
export function classifyTicketTier(info) {
    const fileScore = classifyDimension(info.fileCount, [2, 3, 5]);
    const acScore = classifyDimension(info.acCount, [2, 4, 7]);
    const locScore = classifyDimension(info.locEstimate, [21, 81, 251]);
    // Conservative: ties round UP (take the maximum across dimensions)
    let score = Math.max(fileScore, acScore, locScore);
    // Keyword adjustment — clamped to [-1, 1] so keywords can't overwhelm signals
    const textLower = info.text.toLowerCase();
    let delta = 0;
    for (const kw of CLASSIFIER_LARGER_KEYWORDS) {
        if (new RegExp(`\\b${kw}\\b`).test(textLower))
            delta++;
    }
    for (const kw of CLASSIFIER_SMALLER_KEYWORDS) {
        if (new RegExp(`\\b${kw}\\b`).test(textLower))
            delta--;
    }
    delta = Math.max(-1, Math.min(1, delta));
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
 * Count the visual changed lines in one file:
 *   - stylesheet extension  → all changed lines are visual;
 *   - non-source extension  → none are visual;
 *   - JS/TS source          → lines inside/opening a styled-component template,
 *                             or matching JSX/className/style markup, are visual.
 */
function countVisualChangedLines(filePath, changedLines) {
    if (VISUAL_FILE_EXT_RE.test(filePath))
        return changedLines.length;
    if (!SOURCE_FILE_EXT_RE.test(filePath))
        return 0;
    let count = 0;
    let inStyledTemplate = false;
    for (const line of changedLines) {
        if (inStyledTemplate) {
            count++;
            if (line.includes('`'))
                inStyledTemplate = false;
            continue;
        }
        if (STYLED_TEMPLATE_OPENER_RE.test(line)) {
            count++;
            // Stay inside the template only if it does not also close on this line.
            if (!line.slice(line.indexOf('`') + 1).includes('`'))
                inStyledTemplate = true;
            continue;
        }
        if (VISUAL_SOURCE_LINE_RE.test(line))
            count++;
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
export function classifyDiffVisualDominance(diffStat, threshold = VISUAL_DOMINANCE_THRESHOLD) {
    let totalChanged = 0;
    let totalVisual = 0;
    for (const file of diffStat) {
        const changed = file.changedLines.length;
        if (changed === 0)
            continue;
        totalChanged += changed;
        totalVisual += countVisualChangedLines(file.path, file.changedLines);
    }
    if (totalChanged === 0)
        return false;
    return totalVisual / totalChanged > threshold;
}
function readTierCapsBlock(block) {
    if (!block || typeof block !== 'object')
        return {};
    const result = {};
    for (const tier of VALID_TICKET_COMPLEXITY_TIERS) {
        const entry = block[tier];
        if (!entry || typeof entry !== 'object')
            continue;
        const e = entry;
        const partial = {};
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
export function loadPickleSettingsBag(extensionRoot = getExtensionRoot()) {
    try {
        const settingsPath = path.join(extensionRoot, 'pickle_settings.json');
        return readRecoverableJsonObject(settingsPath);
    }
    catch {
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
function resolveNonNegativeIntField(block, key, fallback) {
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
export function resolveHardeningSettings(bag) {
    const settings = {
        silent_death_respawn_cap: DEFAULT_SILENT_DEATH_RESPAWN_CAP,
        failed_flip_suppression_cap: DEFAULT_FAILED_FLIP_SUPPRESSION_CAP,
        breaker_recovery_grace_seconds: DEFAULT_BREAKER_RECOVERY_GRACE_SECONDS,
        bounded_terminal_escape_cap: DEFAULT_BOUNDED_TERMINAL_ESCAPE_CAP,
    };
    if (!bag || typeof bag !== 'object')
        return settings;
    const block = bag.hardening;
    if (!block || typeof block !== 'object' || Array.isArray(block))
        return settings;
    const b = block;
    settings.silent_death_respawn_cap = resolveNonNegativeIntField(b, 'silent_death_respawn_cap', settings.silent_death_respawn_cap);
    settings.failed_flip_suppression_cap = resolveNonNegativeIntField(b, 'failed_flip_suppression_cap', settings.failed_flip_suppression_cap);
    settings.breaker_recovery_grace_seconds = resolveNonNegativeIntField(b, 'breaker_recovery_grace_seconds', settings.breaker_recovery_grace_seconds);
    settings.bounded_terminal_escape_cap = resolveNonNegativeIntField(b, 'bounded_terminal_escape_cap', settings.bounded_terminal_escape_cap);
    return settings;
}
function parseSettingBool(v) {
    return typeof v === 'boolean' ? v : undefined;
}
function parseSettingIntFloor(v, floor) {
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v))
        return undefined;
    return Math.max(floor, v);
}
function parseSettingIntClamp(v, floor, ceiling) {
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v))
        return undefined;
    return Math.max(floor, Math.min(ceiling, v));
}
export function resolveCodegraphSettings(bag) {
    const settings = {
        enabled: true,
        index_at_setup: true,
        staleness_max_age_minutes: 30,
        context_max_bytes: 8192,
        expose_mcp_to_workers: false,
        index_timeout_ms: 120000,
        sync_timeout_ms: 30000,
        query_timeout_ms: 5000,
    };
    if (!bag || typeof bag !== 'object' || Array.isArray(bag))
        return settings;
    const block = bag.codegraph;
    if (!block || typeof block !== 'object' || Array.isArray(block))
        return settings;
    const b = block;
    const enabled = parseSettingBool(b.enabled);
    if (enabled !== undefined)
        settings.enabled = enabled;
    const indexAtSetup = parseSettingBool(b.index_at_setup);
    if (indexAtSetup !== undefined)
        settings.index_at_setup = indexAtSetup;
    const exposeMcp = parseSettingBool(b.expose_mcp_to_workers);
    if (exposeMcp !== undefined)
        settings.expose_mcp_to_workers = exposeMcp;
    const staleness = parseSettingIntFloor(b.staleness_max_age_minutes, 1);
    if (staleness !== undefined)
        settings.staleness_max_age_minutes = staleness;
    const ctxBytes = parseSettingIntClamp(b.context_max_bytes, 1024, 65536);
    if (ctxBytes !== undefined)
        settings.context_max_bytes = ctxBytes;
    const indexMs = parseSettingIntFloor(b.index_timeout_ms, 5000);
    if (indexMs !== undefined)
        settings.index_timeout_ms = indexMs;
    const syncMs = parseSettingIntFloor(b.sync_timeout_ms, 1000);
    if (syncMs !== undefined)
        settings.sync_timeout_ms = syncMs;
    const queryMs = parseSettingIntFloor(b.query_timeout_ms, 500);
    if (queryMs !== undefined)
        settings.query_timeout_ms = queryMs;
    return settings;
}
export const DEFAULT_MAX_PARK_MINUTES = 360;
/**
 * Ticket e9bdac75 (Workstream B): resolve the rate-limit park controls from the
 * additive `rate_limit:` block in `pickle_settings.json`. Per-field fallback —
 * absent/partial/malformed input yields the compiled default. Mirrors
 * `resolveHardeningSettings` / `resolveCodegraphSettings`.
 */
export function resolveRateLimitSettings(bag) {
    const settings = { max_park_minutes: DEFAULT_MAX_PARK_MINUTES };
    if (!bag || typeof bag !== 'object')
        return settings;
    const block = bag.rate_limit;
    if (!block || typeof block !== 'object' || Array.isArray(block))
        return settings;
    const maxPark = parseSettingIntFloor(block.max_park_minutes, 1);
    if (maxPark !== undefined)
        settings.max_park_minutes = maxPark;
    return settings;
}
/**
 * Ticket 0b9b2319 (WS-3): resolve the additive `scope:` block in
 * `pickle_settings.json`. Mirrors `resolveHardeningSettings` robustness —
 * an absent, partial, or malformed bag/block/field never throws and falls
 * back to the default-OFF compiled default. The single field
 * `auto_extend_signature_callers` (default `false`) gates the bounded,
 * opt-in build-phase scope auto-extension in `setupScope`.
 */
export function resolveScopeSettings(bag) {
    const settings = { autoExtendSignatureCallers: false };
    if (!bag || typeof bag !== 'object')
        return settings;
    const block = bag.scope;
    if (!block || typeof block !== 'object' || Array.isArray(block))
        return settings;
    const autoExtend = parseSettingBool(block.auto_extend_signature_callers);
    if (autoExtend !== undefined)
        settings.autoExtendSignatureCallers = autoExtend;
    return settings;
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
export function getMicroverseSettings(settings) {
    return getMicroverseSettingsWithDefaults(settings);
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
export function readPickleSettingsTierCaps(settings) {
    if (!settings)
        return {};
    return readTierCapsBlock(settings.tier_caps);
}
export function readStateTierCapOverrides(state) {
    const flags = state?.flags;
    if (!flags || typeof flags !== 'object')
        return {};
    return readTierCapsBlock(flags.tier_cap_override);
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
export function getTicketTierBudgetWithOverrides(state, tier, settings) {
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
export function ticketTierBudget(tier) {
    return getTicketTierBudgetWithOverrides(null, tier, null);
}
export function ticketInfoBudget(ticketInfo) {
    return getTicketTierBudgetWithOverrides(null, ticketInfo?.complexity_tier, null);
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
    const ticketPath = path.join(sessionRoot, ticketId, `linear_ticket_${ticketId}.md`);
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
 * Marks a ticket's frontmatter status as "Done" by rewriting the status line.
 * No-op if ticket dir or file doesn't exist, or status is already Done.
 */
export function markTicketDone(sessionDir, ticketId) {
    try {
        const planned = updateTicketStatusInTransaction(ticketId, 'Done', sessionDir);
        fs.writeFileSync(planned.path, planned.content);
        return true;
    }
    catch {
        return false;
    }
}
export function markTicketSkipped(sessionDir, ticketId) {
    try {
        const planned = updateTicketStatusInTransaction(ticketId, 'Skipped', sessionDir);
        fs.writeFileSync(planned.path, planned.content);
        return true;
    }
    catch {
        return false;
    }
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
                    if (!file.startsWith('linear_ticket_') || !file.endsWith('.md'))
                        continue;
                    const parsed = parseTicketFrontmatter(path.join(subDir, file));
                    if (parsed)
                        tickets.push(parsed);
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
// Shared buffer for Atomics.wait()-based synchronous sleep (no CPU spin).
const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));
/** Synchronous sleep that yields to the OS scheduler instead of busy-waiting. */
function sleepMs(ms) {
    Atomics.wait(_sleepBuf, 0, 0, ms);
}
const RETRY_LOCK_DEFAULTS = {
    maxRetries: 10,
    baseLockDelayMs: 100,
    staleLockTimeoutMs: 30_000,
    lockJitter: true,
};
function stealStaleLock(lockPath, staleLockTimeoutMs) {
    try {
        const stats = fs.statSync(lockPath);
        if (Date.now() - stats.mtimeMs > staleLockTimeoutMs) {
            try {
                fs.unlinkSync(lockPath);
            }
            catch { /* already gone — race is fine */ }
        }
    }
    catch {
        // lock file doesn't exist — expected
    }
}
function tryRunWithExclusiveLock(lockPath, fn) {
    try {
        const fd = fs.openSync(lockPath, 'wx');
        try {
            fs.writeSync(fd, String(process.pid));
        }
        finally {
            fs.closeSync(fd);
        }
        try {
            return { acquired: true, value: fn() };
        }
        finally {
            try {
                fs.unlinkSync(lockPath);
            }
            catch { /* ignore cleanup failure */ }
        }
    }
    catch (e) {
        const code = e instanceof Error ? e.code : undefined;
        if (code !== 'EEXIST')
            throw e;
        return { acquired: false };
    }
}
function sleepBeforeRetry(attempt, baseLockDelayMs, lockJitter) {
    const backoff = baseLockDelayMs * Math.pow(2, attempt);
    const jitter = lockJitter ? Math.random() * baseLockDelayMs : 0;
    sleepMs(Math.min(backoff + jitter, 5000));
}
/**
 * Acquires an exclusive file lock before executing fn, then releases it.
 * Uses O_EXCL atomic create for lock acquisition. Retries with exponential
 * backoff and optional jitter, stealing locks older than staleLockTimeoutMs.
 * Writes PID to lock file for stale detection. NEVER silently falls through —
 * throws LockError if maxRetries is exhausted.
 */
export function withRetryLock(lockPath, fn, opts = {}) {
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
        if (locked.acquired)
            return locked.value;
        if (attempt >= maxRetries) {
            throw new LockError(`[pickle] Lock acquisition failed after ${maxRetries} retries (${lockPath})`);
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
        const sessionPath = resolveSessionPath(entry);
        if (!sessionPath) {
            writePhantomSessionDemotedActivity(cwd, '');
            pruned++;
            continue;
        }
        let dirExists = false;
        try {
            dirExists = fs.statSync(sessionPath).isDirectory();
        }
        catch {
            // dirExists already false
        }
        if (!dirExists) {
            writePhantomSessionDemotedActivity(cwd, sessionPath);
            pruned++;
            continue;
        }
        const statePath = path.join(sessionPath, 'state.json');
        const recoveredState = readRecoverableJsonObject(statePath);
        if (!fs.existsSync(statePath) && !recoveredState) {
            writePhantomSessionDemotedActivity(cwd, sessionPath);
            pruned++;
            continue;
        }
        survivors[cwd] = entry;
    }
    if (pruned === 0)
        return { pruned: 0, total };
    const tmpPath = `${sessionsMapPath}.tmp.${process.pid}`;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(survivors, null, 2));
        fs.renameSync(tmpPath, sessionsMapPath);
    }
    catch {
        try {
            fs.unlinkSync(tmpPath);
        }
        catch { /* ignore */ }
        return { pruned: 0, total };
    }
    return { pruned, total };
}
/**
 * Extracts the session path from a session map entry.
 * Handles both the legacy string format and the current object format ({ sessionPath, pid })
 * for backward compatibility with existing current_sessions.json files.
 */
export function resolveSessionPath(entry) {
    if (typeof entry === 'string')
        return entry;
    if (entry !== null && typeof entry === 'object' && typeof entry.sessionPath === 'string') {
        return entry.sessionPath;
    }
    return '';
}
function sameWorkingDir(a, b) {
    return typeof a === 'string' && path.resolve(a) === path.resolve(b);
}
const MAX_FUTURE_RECENCY_DRIFT_MS = 5 * 60 * 1000;
function readSessionLookupState(sessionPath) {
    try {
        const statePath = path.join(sessionPath, 'state.json');
        const recovered = readRecoverableJsonObject(statePath);
        if (!recovered || typeof recovered !== 'object' || Array.isArray(recovered))
            return null;
        let stateMtimeMs = 0;
        try {
            stateMtimeMs = fs.statSync(statePath).mtimeMs;
        }
        catch { /* state may still be absent after failed promotion */ }
        return {
            active: recovered.active,
            working_dir: recovered.working_dir,
            started_at: recovered.started_at,
            pid: recovered.pid,
            state_mtime_ms: stateMtimeMs,
        };
    }
    catch {
        return null;
    }
}
function hasParseableStartedAt(state) {
    return typeof state.started_at === 'string'
        && Number.isFinite(new Date(state.started_at).getTime());
}
function getSessionRecencyMs(state) {
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
function isDeadPidState(state) {
    const pidNum = typeof state.pid === 'number' ? state.pid : Number(state.pid);
    return Number.isInteger(pidNum) && !isProcessAlive(pidNum);
}
function preferNewerSession(best, candidate) {
    if (!best)
        return candidate;
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
function selectScannedSessionPath(sessionPaths, cwd, requireActive) {
    let activeMatch = null;
    let inactiveMatch = null;
    for (const sessionPath of sessionPaths) {
        const state = readSessionLookupState(sessionPath);
        if (!state)
            continue;
        if (!sameWorkingDir(state.working_dir, cwd))
            continue;
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
function resolveMappedSessionForCwd(map, cwd, requireActive) {
    const mappedPath = resolveSessionPath(map[cwd]);
    if (!mappedPath || !fs.existsSync(mappedPath))
        return '';
    const state = readSessionLookupState(mappedPath);
    if (!state) {
        return requireActive ? '' : mappedPath;
    }
    if (sameWorkingDir(state.working_dir, cwd)) {
        if (state.active === true)
            return mappedPath;
        return requireActive ? '' : mappedPath;
    }
    if (!requireActive && (state.working_dir == null || state.working_dir === '')) {
        return mappedPath;
    }
    return '';
}
function readSessionsMapFallback(sessionsMapPath, cwd, requireActive) {
    try {
        const map = readRecoverableJsonObject(sessionsMapPath);
        return map ? resolveMappedSessionForCwd(map, cwd, requireActive) ?? '' : '';
    }
    catch {
        return '';
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
/** Matrix palette shared across all monitor panes. */
export const MatrixStyle = {
    BRIGHT: '\x1b[1;32m', // bold green
    GREEN: '\x1b[32m', // normal green
    DIM: '\x1b[2;32m', // dim green
    CYAN: '\x1b[36m', // cyan accent
    ERR: '\x1b[1;31m', // bold red
    WARN: '\x1b[33m', // yellow
    R: '\x1b[0m', // reset
};
export const RAIN_CHARS = 'ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾍ012345789Z:."=*+-<>¦╌╎';
/** Generates a Matrix-styled separator line with random rain characters. */
export function matrixSeparator(width) {
    const line = [];
    for (let i = 0; i < width; i++) {
        line.push(Math.random() < 0.2
            ? RAIN_CHARS[Math.floor(Math.random() * RAIN_CHARS.length)]
            : '─');
    }
    return `${MatrixStyle.DIM}${line.join('')}${MatrixStyle.R}`;
}
/** Finds the most recent tmux_iteration_N.log in a session directory. */
export function latestIterationLog(sessionDir) {
    try {
        const logs = fs
            .readdirSync(sessionDir)
            .filter((f) => f.startsWith('tmux_iteration_') && f.endsWith('.log'))
            .sort((a, b) => {
            const numA = parseInt(a.replace('tmux_iteration_', '').replace('.log', ''), 10);
            const numB = parseInt(b.replace('tmux_iteration_', '').replace('.log', ''), 10);
            return (numA || 0) - (numB || 0);
        });
        return logs.length > 0 ? path.join(sessionDir, logs[logs.length - 1]) : null;
    }
    catch {
        return null;
    }
}
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;
const DRAIN_CHUNK = 65536; // 64 KiB
/**
 * Reads stream-json log from `offset`, processes complete lines via the
 * provided `processor`, and emits output. Returns new offset and partial
 * trailing line buffer.
 */
export function drainStreamJsonLines(logPath, offset, lineBuf, processor, emit) {
    let fd = null;
    try {
        const { size } = fs.statSync(logPath);
        if (size <= offset)
            return { offset, lineBuf };
        fd = fs.openSync(logPath, 'r');
        let pos = offset;
        let buf = lineBuf;
        while (pos < size) {
            const toRead = Math.min(DRAIN_CHUNK, size - pos);
            const raw = Buffer.allocUnsafe(toRead);
            const bytesRead = fs.readSync(fd, raw, 0, toRead, pos);
            if (bytesRead === 0)
                break;
            buf += raw.subarray(0, bytesRead).toString('utf-8');
            pos += bytesRead;
        }
        fs.closeSync(fd);
        fd = null;
        const lines = buf.split('\n');
        const trailing = lines.pop() ?? '';
        for (const line of lines) {
            const result = processor(line);
            if (result !== null)
                emit(result);
        }
        return { offset: pos, lineBuf: trailing };
    }
    catch {
        if (fd !== null) {
            try {
                fs.closeSync(fd);
            }
            catch { /* ignore */ }
        }
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
export function detectLogTruncation(logPath, offset, lineBuf) {
    try {
        const { size } = fs.statSync(logPath);
        if (size < offset) {
            return { offset: 0, lineBuf: '', truncated: true };
        }
    }
    catch {
        // Missing or unreadable — caller will pick this up on its next
        // discovery iteration. Do not mutate offset.
    }
    return { offset, lineBuf, truncated: false };
}
export function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
/** Emits log content to stdout, stripping ANSI codes and truncating long lines. */
function emitLog(content) {
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
export function drainLog(logPath, offset) {
    let fd = null;
    try {
        const { size } = fs.statSync(logPath);
        if (size <= offset)
            return offset;
        fd = fs.openSync(logPath, 'r');
        const decoder = new StringDecoder('utf-8');
        let pos = offset;
        while (pos < size) {
            const toRead = Math.min(DRAIN_CHUNK, size - pos);
            const buf = Buffer.allocUnsafe(toRead);
            const bytesRead = fs.readSync(fd, buf, 0, toRead, pos);
            if (bytesRead === 0)
                break; // EOF — file was truncated
            emitLog(decoder.write(buf.subarray(0, bytesRead)));
            pos += bytesRead;
        }
        const trailing = decoder.end();
        if (trailing)
            emitLog(trailing);
        fs.closeSync(fd);
        return pos;
    }
    catch {
        if (fd !== null) {
            try {
                fs.closeSync(fd);
            }
            catch { /* ignore double-close */ }
        }
        return offset;
    }
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
/**
 * Updates a single key in a session's state.json with validation.
 * Numeric, boolean, and step keys are type-checked before writing.
 */
export function updateState(key, value, sessionDir) {
    const statePath = path.join(sessionDir, 'state.json');
    if (!fs.existsSync(statePath)) {
        throw new Error(`state.json not found at ${statePath}`);
    }
    if (key === 'step' && !VALID_STEPS.includes(value)) {
        throw new Error(`Invalid step "${value}". Must be one of: ${VALID_STEPS.join(', ')}`);
    }
    const NUMERIC_KEYS = new Set(['iteration', 'max_iterations', 'max_time_minutes', 'worker_timeout_seconds', 'start_time_epoch', 'min_iterations']);
    const BOOLEAN_KEYS = new Set(['tmux_mode']);
    // active and completion_promise are owned by tmux-runner/cancel.js — never via CLI
    const ALLOWED_KEYS = new Set([
        ...NUMERIC_KEYS, ...BOOLEAN_KEYS, 'step', 'working_dir',
        'original_prompt', 'current_ticket', 'started_at', 'session_dir', 'command_template',
    ]);
    if (!ALLOWED_KEYS.has(key)) {
        throw new Error(`Unknown state key "${key}". Allowed: ${[...ALLOWED_KEYS].join(', ')}`);
    }
    // Validate value BEFORE acquiring lock to fail fast
    if (NUMERIC_KEYS.has(key)) {
        const num = Number(value);
        if (!Number.isFinite(num)) {
            throw new Error(`Key "${key}" requires a finite number, got "${value}"`);
        }
        if (!Number.isInteger(num)) {
            throw new Error(`Key "${key}" requires an integer, got "${value}"`);
        }
        if (['iteration', 'max_iterations', 'max_time_minutes', 'start_time_epoch', 'min_iterations'].includes(key) && num < 0) {
            throw new Error(`Key "${key}" requires a non-negative integer, got "${value}"`);
        }
        if (key === 'worker_timeout_seconds' && num <= 0) {
            throw new Error(`Key "${key}" requires a positive integer, got "${value}"`);
        }
    }
    else if (BOOLEAN_KEYS.has(key)) {
        if (value !== 'true' && value !== 'false') {
            throw new Error(`Key "${key}" requires "true" or "false", got "${value}"`);
        }
    }
    const sm = new StateManager();
    sm.update(statePath, state => {
        if (NUMERIC_KEYS.has(key)) {
            state[key] = Number(value);
        }
        else if (BOOLEAN_KEYS.has(key)) {
            state[key] = value === 'true';
        }
        else {
            state[key] = value;
        }
        if (key === 'current_ticket') {
            // R-CNAR-8: when an operator manually retargets current_ticket, ALL 5
            // cache fields must clear together. Pre-fix the missing 3 fields skewed
            // ticketBudgetIterationCount on the next iteration.
            delete state.current_ticket_tier;
            delete state.current_ticket_budget;
            delete state.current_ticket_max_iterations;
            delete state.current_ticket_worker_timeout_seconds;
            delete state.current_ticket_budget_start_iteration;
        }
    });
    console.log(`Successfully updated ${key} to ${value} in ${statePath}`);
}
/**
 * Infers monitor mode from state.json's command_template. Defaults to 'pickle'.
 * Glob mapping: pickle*→pickle, council*→council.
 * Exact mapping: anatomy-park.md→anatomy-park, szechuan-sauce.md→szechuan-sauce, refinement.md→refinement.
 * Missing or unrecognized template defaults to 'pickle' and emits a WARN via optional log.
 */
export function inferMonitorMode(sessionDir, log) {
    try {
        const state = new StateManager().read(path.join(sessionDir, 'state.json'));
        const tpl = (state.command_template || '').toLowerCase();
        if (!tpl) {
            log?.('[ensureMonitorWindow] command_template missing; defaulting to pickle');
            return 'pickle';
        }
        if (tpl.startsWith('pickle'))
            return 'pickle';
        if (tpl === 'anatomy-park.md')
            return 'anatomy-park';
        if (tpl === 'szechuan-sauce.md')
            return 'szechuan-sauce';
        if (tpl.startsWith('council'))
            return 'council';
        if (tpl === 'refinement.md')
            return 'refinement';
        log?.(`[ensureMonitorWindow] unrecognized command_template '${state.command_template}'; defaulting to pickle`);
        return 'pickle';
    }
    catch {
        log?.('[ensureMonitorWindow] command_template missing; defaulting to pickle');
        return 'pickle';
    }
}
export function restartDeadWatcherPanes(sessionDir, extensionRoot, mode, spawnSyncFn = spawnSync, 
/**
 * R-MWR-3: log-line prefix for respawn decisions. Defaults to
 * `restartDeadWatcherPanes` for boundary-driven invocations
 * (`ensureMonitorWindow` re-attach). The continuous in-monitor
 * watchdog (`startRespawnWatchdog`) passes `monitor-watchdog` so
 * AC-MWR-05 grep can distinguish the two callers in `mux-runner.log`.
 */
logTag = 'restartDeadWatcherPanes', 
// R-MWCL-3: injectable for testing window-missing escalation.
ensureMonitorWindowFn = ensureMonitorWindow) {
    const callerName = logTag === 'monitor-watchdog' ? 'startRespawnWatchdog' : 'restartDeadWatcherPanes';
    if (!validateSessionDirOrSkip(sessionDir, callerName))
        return;
    if (isSessionInactive(sessionDir))
        return;
    const sessionName = readCurrentTmuxSessionName(spawnSyncFn);
    if (!sessionName) {
        appendWatcherRestartLog(sessionDir, `${logTag} WARN: unable to resolve tmux session name`);
        return;
    }
    for (const watcher of watcherPaneCommands(sessionDir, extensionRoot, mode)) {
        if (processWatcherPane(sessionDir, extensionRoot, mode, sessionName, watcher, spawnSyncFn, logTag, ensureMonitorWindowFn))
            return;
    }
}
function isSessionInactive(sessionDir) {
    try {
        const state = new StateManager().read(path.join(sessionDir, 'state.json'));
        return state.active === false;
    }
    catch {
        return false;
    }
}
function readCurrentTmuxSessionName(spawnSyncFn) {
    const result = spawnSyncFn('tmux', ['display-message', '-p', '#S'], {
        encoding: 'utf-8',
        timeout: 5_000,
    });
    if (result.status !== 0)
        return null;
    const sessionName = (result.stdout || '').trim();
    return sessionName || null;
}
function readPaneCurrentCommand(target, spawnSyncFn) {
    const result = spawnSyncFn('tmux', ['display-message', '-p', '-t', target, '#{pane_current_command}'], {
        encoding: 'utf-8',
        timeout: 5_000,
    });
    if (result.status !== 0)
        return null;
    return (result.stdout || '').trim();
}
function withSerializedPath(fn) {
    // R-TSPF-4 trap door: tests serialize PATH shim mutations around this
    // helper. Runtime tmux calls stay synchronous; the helper marks the call
    // sites that must stay on the shared serialized path in test fixtures.
    return fn();
}
// Processes one watcher pane entry in the restartDeadWatcherPanes loop.
// Returns true when the outer function should exit immediately (monitor window gone, escalated).
function processWatcherPane(sessionDir, extensionRoot, mode, sessionName, watcher, spawnSyncFn, logTag, ensureMonitorWindowFn) {
    const target = `${sessionName}:monitor.${watcher.pane}`;
    const currentCommand = readPaneCurrentCommand(target, spawnSyncFn);
    if (currentCommand === null) {
        return handleNullPaneCommand(sessionDir, extensionRoot, mode, sessionName, watcher, spawnSyncFn, logTag, ensureMonitorWindowFn) === 'return';
    }
    if (currentCommand === 'node')
        return false;
    appendWatcherRestartLog(sessionDir, `${logTag} WARN: pane ${watcher.pane} command '${currentCommand || '(empty)'}' is not node`);
    const result = spawnSyncFn('tmux', ['send-keys', '-t', target, watcher.command, 'Enter'], {
        encoding: 'utf-8',
        timeout: 5_000,
    });
    if (result.status === 0) {
        appendWatcherRestartLog(sessionDir, `${logTag}: respawned ${watcher.name} in pane ${watcher.pane}`);
    }
    else {
        const err = (result.stderr || result.stdout || '').toString().trim();
        appendWatcherRestartLog(sessionDir, `${logTag} WARN: failed to respawn ${watcher.name} in pane ${watcher.pane}: ${err || 'non-zero exit'}`);
    }
    return false;
}
// R-MWCL-3: extracted from restartDeadWatcherPanes to reduce complexity.
// Probes the monitor window and either escalates to ensureMonitorWindow (returns 'return')
// or delegates to recreateMissingWatcherPane (returns 'continue').
function handleNullPaneCommand(sessionDir, extensionRoot, mode, sessionName, watcher, spawnSyncFn, logTag, ensureMonitorWindowFn) {
    const listResult = spawnSyncFn('tmux', ['list-panes', '-t', `${sessionName}:monitor`], {
        encoding: 'utf-8',
        timeout: 5_000,
    });
    if (listResult.status !== 0) {
        appendWatcherRestartLog(sessionDir, `${logTag} collapsed-layout-repair: monitor window missing — escalating to ensureMonitorWindow`);
        ensureMonitorWindowFn({ sessionDir, extensionRoot, mode, spawnSyncFn, inTmux: true });
        return 'return';
    }
    recreateMissingWatcherPane(sessionDir, sessionName, watcher, spawnSyncFn, logTag);
    return 'continue';
}
function recreateMissingWatcherPane(sessionDir, sessionName, watcher, spawnSyncFn, logTag) {
    const splitSpec = missingWatcherPaneSplitSpec(sessionName, watcher.pane);
    const split = withSerializedPath(() => spawnSyncFn('tmux', splitSpec.args, {
        encoding: 'utf-8',
        timeout: 5_000,
    }));
    if (split.status !== 0) {
        const err = (split.stderr || split.stdout || '').toString().trim();
        appendWatcherRestartLog(sessionDir, `${logTag} WARN: failed to recreate missing pane ${watcher.pane} via ${splitSpec.target}: ${err || 'non-zero exit'}`);
        return false;
    }
    appendWatcherRestartLog(sessionDir, `${logTag} WARN: pane ${watcher.pane} missing; recreated via ${splitSpec.target} [collapsed-layout-repair]`);
    const send = withSerializedPath(() => spawnSyncFn('tmux', ['send-keys', '-t', `${sessionName}:monitor.${watcher.pane}`, watcher.command, 'Enter'], {
        encoding: 'utf-8',
        timeout: 5_000,
    }));
    if (send.status === 0) {
        appendWatcherRestartLog(sessionDir, `${logTag}: respawned ${watcher.name} in pane ${watcher.pane}`);
        // R-MWCL-3: re-tile after inserting a new pane so the layout lands in a
        // reasonable position rather than inheriting tmux's default stacking.
        withSerializedPath(() => spawnSyncFn('tmux', ['select-layout', '-t', `${sessionName}:monitor`, 'tiled'], {
            encoding: 'utf-8',
            timeout: 5_000,
        }));
        appendWatcherRestartLog(sessionDir, `${logTag} collapsed-layout-repair: select-layout tiled applied to ${sessionName}:monitor`);
        return true;
    }
    const err = (send.stderr || send.stdout || '').toString().trim();
    appendWatcherRestartLog(sessionDir, `${logTag} WARN: failed to respawn ${watcher.name} in recreated pane ${watcher.pane}: ${err || 'non-zero exit'}`);
    return false;
}
function missingWatcherPaneSplitSpec(sessionName, pane) {
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
function wrapWithStderrRedirect(cmd, sessionDir, pane) {
    const logPath = path.join(sessionDir, `monitor-${pane}.log`);
    return `bash -c '${cmd} 2>>"${logPath}"'`;
}
export function watcherPaneCommands(sessionDir, extensionRoot, mode) {
    const binRoot = path.join(extensionRoot, 'extension', 'bin');
    let paneTwo;
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
        {
            pane: 0,
            name: 'monitor.js',
            command: wrapWithStderrRedirect(`node ${path.join(binRoot, 'monitor.js')} ${sessionDir}`, sessionDir, 0),
        },
        {
            pane: 1,
            name: 'log-watcher.js',
            command: wrapWithStderrRedirect(`node ${path.join(binRoot, 'log-watcher.js')} ${sessionDir}`, sessionDir, 1),
        },
        paneTwo,
        {
            pane: 3,
            name: 'raw-morty.js',
            command: wrapWithStderrRedirect(`node ${path.join(binRoot, 'raw-morty.js')} ${sessionDir}`, sessionDir, 3),
        },
    ];
}
function watcherPaneTwoCommand(sessionDir, binRoot, mode) {
    switch (mode) {
        case 'refinement':
            return {
                pane: 2,
                name: 'refinement-watcher.js',
                command: wrapWithStderrRedirect(`node ${path.join(binRoot, 'refinement-watcher.js')} ${sessionDir}`, sessionDir, 2),
            };
        case 'council':
            return {
                pane: 2,
                name: 'mux-runner.log tail',
                command: wrapWithStderrRedirect(`tail -F ${path.join(sessionDir, 'mux-runner.log')}`, sessionDir, 2),
            };
        case 'pickle':
            return {
                pane: 2,
                name: 'morty-watcher.js',
                command: wrapWithStderrRedirect(`node ${path.join(binRoot, 'morty-watcher.js')} ${sessionDir}`, sessionDir, 2),
            };
        case 'szechuan-sauce':
        case 'anatomy-park':
            return {
                pane: 2,
                name: 'pane-1-2-pointer.js',
                command: wrapWithStderrRedirect(`node ${path.join(binRoot, 'pane-1-2-pointer.js')} ${sessionDir}`, sessionDir, 2),
            };
    }
}
function appendWatcherRestartLog(sessionDir, line) {
    try {
        fs.appendFileSync(path.join(sessionDir, 'mux-runner.log'), `${new Date().toISOString()} ${line}\n`);
    }
    catch {
        // Best-effort diagnostic logging must not break pane recovery.
    }
}
/** Dedup guard: emit only one activity event per (caller, sessionDir, reason) tuple per process. */
const _sessionDirInvalidEmitted = new Map();
/**
 * Validates sessionDir before tmux-watcher invocation. Returns true when valid; returns false
 * and emits a monitor_respawn_session_dir_invalid activity event (once per tuple) when invalid.
 *
 * Checks (in order): non-empty string → path exists → state.json present → resolved path matches state
 */
export function validateSessionDirOrSkip(sessionDir, caller) {
    let reason = null;
    if (!sessionDir || typeof sessionDir !== 'string') {
        reason = 'empty';
    }
    else if (!fs.existsSync(sessionDir)) {
        reason = 'enoent';
    }
    else if (!fs.existsSync(path.join(sessionDir, 'state.json'))) {
        reason = 'no_state_json';
    }
    else {
        try {
            const sm = new StateManager();
            const state = sm.read(path.join(sessionDir, 'state.json'));
            if (state.session_dir && path.resolve(state.session_dir) !== path.resolve(sessionDir)) {
                reason = 'session_dir_mismatch';
            }
        }
        catch {
            reason = 'session_dir_mismatch';
        }
    }
    if (reason === null)
        return true;
    const dedupeKey = `${caller}:${sessionDir}:${reason}`;
    if (_sessionDirInvalidEmitted.has(dedupeKey))
        return false;
    _sessionDirInvalidEmitted.set(dedupeKey, true);
    appendWatcherRestartLog(sessionDir, `validateSessionDirOrSkip WARN: ${caller} skipped — sessionDir ${reason} (${sessionDir})`);
    try {
        const ts = new Date();
        const activityDir = path.join(getCanonicalActivityDataRoot(), 'activity');
        fs.mkdirSync(activityDir, { recursive: true });
        const event = {
            ts: ts.toISOString(),
            event: 'monitor_respawn_session_dir_invalid',
            source: 'pickle',
            gate_payload: { caller, sessionDir, reason },
        };
        fs.appendFileSync(path.join(activityDir, `${formatLocalDateKey(ts)}.jsonl`), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    }
    catch (err) {
        process.stderr.write(`[pickle-rick] Failed to log monitor_respawn_session_dir_invalid: ${safeErrorMessage(err)}\n`);
    }
    return false;
}
/** Test helper: resets the session-dir-invalid dedup map. */
export function _resetSessionDirInvalidEmittedForTests() {
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
 *   - `skipped`    → not inside tmux (headless or direct invocation)
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
export function ensureMonitorWindow(opts) {
    const log = opts.log || (() => { });
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
        if (!sessionName)
            return activeMonitorWindowContext.outcome || { status: 'error', reason: 'empty session name' };
        const { recreate } = checkAndRecreateWindow(sessionName);
        if (activeMonitorWindowContext.outcome)
            return activeMonitorWindowContext.outcome;
        createMonitorWindow(sessionName);
        if (activeMonitorWindowContext.outcome)
            return activeMonitorWindowContext.outcome;
        if (recreate) {
            log(`ensureMonitorWindow: recreated 4-pane monitor (mode=${activeMonitorWindowContext.mode}) on ${sessionName}`);
            return { status: 'recreated' };
        }
        log(`ensureMonitorWindow: created 4-pane monitor (mode=${activeMonitorWindowContext.mode}) on ${sessionName}`);
        return { status: 'created' };
    }
    finally {
        activeMonitorWindowContext = null;
    }
}
let activeMonitorWindowContext = null;
function currentMonitorWindowContext() {
    if (!activeMonitorWindowContext)
        throw new Error('ensureMonitorWindow context not initialized');
    return activeMonitorWindowContext;
}
function getSessionName() {
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
        activeMonitorWindowContext.outcome = { status: 'error', reason: `display-message: ${err || 'non-zero exit'}` };
        return null;
    }
    const sessionName = (displayName.stdout || '').trim();
    if (!sessionName) {
        log('ensureMonitorWindow: empty tmux session name');
        activeMonitorWindowContext.outcome = { status: 'error', reason: 'empty session name' };
        return null;
    }
    return sessionName;
}
function checkAndRecreateWindow(sessionName) {
    const { log, mode, opts, spawnSyncFn, tmuxBin } = currentMonitorWindowContext();
    const target = `${sessionName}:monitor`;
    // Compatibility guard — a "monitor" window from a previous command (e.g.
    // anatomy-park then council) has the wrong layout. Check the window's
    // `@pickle_monitor_mode` user-option and recreate on mismatch.
    const listWindows = spawnSyncFn(tmuxBin, ['list-windows', '-t', sessionName, '-F', '#W'], {
        encoding: 'utf-8',
        timeout: 5_000,
    });
    if (listWindows.status !== 0)
        return { recreate: false };
    const names = (listWindows.stdout || '').split('\n').map(s => s.trim());
    if (!names.includes('monitor'))
        return { recreate: false };
    const existingMode = readWindowMode(tmuxBin, target, spawnSyncFn);
    if (monitorModesCompatible(existingMode, mode)) {
        log(`ensureMonitorWindow: monitor window already exists on ${sessionName} (mode=${mode})`);
        restartDeadWatcherPanes(opts.sessionDir, resolveMonitorExtensionRoot(opts), mode, spawnSyncFn);
        activeMonitorWindowContext.outcome = { status: 'exists' };
        return { recreate: false };
    }
    log(`ensureMonitorWindow: mode mismatch on ${sessionName} ` +
        `(existing=${existingMode || 'unset'}, want=${mode}) — killing stale window`);
    const kill = spawnSyncFn(tmuxBin, ['kill-window', '-t', target], {
        encoding: 'utf-8',
        timeout: 5_000,
    });
    if (kill.status !== 0) {
        const err = (kill.stderr || '').toString().trim();
        log(`ensureMonitorWindow: kill-window failed: ${err}`);
        activeMonitorWindowContext.outcome = { status: 'error', reason: `kill-window: ${err || 'non-zero exit'}` };
        return { recreate: false };
    }
    return { recreate: true };
}
function createMonitorWindow(sessionName) {
    const { bashBin, log, mode, opts, spawnSyncFn, tmuxBin } = currentMonitorWindowContext();
    const target = `${sessionName}:monitor`;
    const extensionRoot = resolveMonitorExtensionRoot(opts);
    const script = path.join(extensionRoot, 'extension', 'scripts', 'tmux-monitor.sh');
    if (!fs.existsSync(script)) {
        log(`ensureMonitorWindow: tmux-monitor.sh missing at ${script}`);
        activeMonitorWindowContext.outcome = { status: 'error', reason: `script missing: ${script}` };
        return;
    }
    const result = spawnSyncFn(bashBin, [script, sessionName, opts.sessionDir, mode], {
        encoding: 'utf-8',
        timeout: 10_000,
    });
    if (result.status !== 0) {
        const err = (result.stderr || result.stdout || '').toString().trim();
        log(`ensureMonitorWindow: tmux-monitor.sh failed (exit ${result.status}): ${err}`);
        activeMonitorWindowContext.outcome = { status: 'error', reason: `script exit ${result.status}: ${err || 'no stderr'}` };
        return;
    }
    // Stamp the mode on the freshly-created window so the next invocation can
    // detect compatibility. Non-fatal if it fails — we log and move on.
    const setOpt = spawnSyncFn(tmuxBin, ['set-option', '-w', '-t', target, '@pickle_monitor_mode', mode], { encoding: 'utf-8', timeout: 5_000 });
    if (setOpt.status !== 0) {
        const err = (setOpt.stderr || '').toString().trim();
        log(`ensureMonitorWindow: set-option @pickle_monitor_mode failed (non-fatal): ${err}`);
    }
}
function resolveMonitorExtensionRoot(opts) {
    return opts.extensionRoot ? resolveExtensionRoot(opts.extensionRoot) : getExtensionRoot();
}
/** Reads the monitor window's stamped mode via tmux user-option, or null. */
function readWindowMode(tmuxBin, target, spawnSyncFn) {
    const show = spawnSyncFn(tmuxBin, ['show-option', '-w', '-qv', '-t', target, '@pickle_monitor_mode'], { encoding: 'utf-8', timeout: 5_000 });
    if (show.status !== 0)
        return null;
    const val = (show.stdout || '').trim();
    return val || null;
}
/**
 * Returns true iff we can reuse an existing monitor window without recreating.
 * Unset existing mode counts as incompatible — we can't prove the layout matches
 * what this mode needs, so play it safe and rebuild.
 */
export function monitorModesCompatible(existing, want) {
    if (!existing)
        return false;
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
async function _killOldMonitorPid(smLocal, statePath) {
    try {
        const s = smLocal.read(statePath);
        const oldPid = s.monitor_pid;
        if (typeof oldPid === 'number' && oldPid > 0)
            await _killPidGracefully(oldPid);
    }
    catch { /* best-effort */ }
}
function _resolveTmuxSessionName(spawnSyncFn, log, mode) {
    const r = spawnSyncFn('tmux', ['display-message', '-p', '#S'], { encoding: 'utf-8', timeout: 5_000 });
    if (r.status !== 0) {
        log(`monitor: tmux display-message failed for mode ${mode}`);
        return null;
    }
    const name = (r.stdout || '').trim();
    if (!name) {
        log(`monitor: empty tmux session name for mode ${mode}`);
        return null;
    }
    return name;
}
function _tmuxRespawnPane(spawnSyncFn, target, command, log, mode) {
    const r = spawnSyncFn('tmux', ['respawn-pane', '-k', '-t', target, command], { encoding: 'utf-8', timeout: 5_000 });
    if (r.status !== 0) {
        const err = (r.stderr || '').trim() || 'non-zero exit';
        log(`monitor: respawn-pane failed for mode ${mode}: ${err}`);
        return false;
    }
    return true;
}
function _tmuxGetPanePid(spawnSyncFn, target) {
    try {
        const r = spawnSyncFn('tmux', ['display-message', '-p', '-t', target, '#{pane_pid}'], { encoding: 'utf-8', timeout: 5_000 });
        if (r.status === 0) {
            const parsed = parseInt((r.stdout || '').trim(), 10);
            if (!isNaN(parsed) && parsed > 0)
                return parsed;
        }
    }
    catch { /* best-effort */ }
    return null;
}
function _updateMonitorState(smLocal, statePath, newPid, mode) {
    try {
        smLocal.update(statePath, s => {
            const ext = s;
            ext.monitor_pid = newPid;
            ext.monitor_mode = mode;
        });
    }
    catch { /* best-effort */ }
}
/**
 * Respawns the monitor dashboard pane (pane 0) with --mode set to `mode`.
 *
 * Returns 'no-op' when:
 *   - sessionDir is invalid (validateSessionDirOrSkip)
 *   - state.monitor_mode already equals `mode`
 *   - not inside tmux
 *   - tmux respawn-pane fails
 * Returns 'respawned' on success; updates state.monitor_pid and state.monitor_mode.
 * Logs `monitor: respawned for mode <mode>` via opts.log so the line appears in
 * pipeline-runner.log (AC-MDS-01).
 */
export async function respawnMonitorWindowForMode(sessionDir, mode, opts) {
    if (!validateSessionDirOrSkip(sessionDir, 'respawnMonitorWindowForMode'))
        return 'no-op';
    const statePath = path.join(sessionDir, 'state.json');
    const smLocal = new StateManager();
    const log = opts?.log ?? (() => undefined);
    try {
        const s = smLocal.read(statePath);
        if (s.monitor_mode === mode)
            return 'no-op';
    }
    catch { /* tolerate read failure — proceed */ }
    await _killOldMonitorPid(smLocal, statePath);
    const inTmux = opts?.inTmux !== undefined ? opts.inTmux : !!process.env.TMUX;
    if (!inTmux) {
        log(`monitor: tmux unavailable, skipping respawn for mode ${mode}`);
        return 'no-op';
    }
    const spawnSyncFn = opts?.spawnSyncFn ?? spawnSync;
    const sessionName = _resolveTmuxSessionName(spawnSyncFn, log, mode);
    if (!sessionName)
        return 'no-op';
    const extensionRoot = getExtensionRoot();
    const monitorBin = path.join(extensionRoot, 'extension', 'bin', 'monitor.js');
    const target = `${sessionName}:monitor.0`;
    const ok = _tmuxRespawnPane(spawnSyncFn, target, `node ${monitorBin} --mode ${mode} ${sessionDir}`, log, mode);
    if (!ok)
        return 'no-op';
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
/** Removes inactive session directories older than maxAgeDays from sessionsRoot. */
export function pruneOldSessions(sessionsRoot, maxAgeDays = 7) {
    if (!fs.existsSync(sessionsRoot))
        return;
    const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const maxTrustedFutureMs = Date.now() + MAX_FUTURE_RECENCY_DRIFT_MS;
    const sm = new StateManager();
    for (const entry of fs.readdirSync(sessionsRoot)) {
        const sessionDir = path.join(sessionsRoot, entry);
        const statePath = path.join(sessionDir, 'state.json');
        if (!fs.existsSync(statePath))
            continue;
        try {
            const sessionDirMtimeMs = fs.statSync(sessionDir).mtimeMs;
            const state = sm.read(statePath);
            if (state.active === true)
                continue;
            const rawMs = state.started_at
                ? new Date(state.started_at).getTime()
                : NaN;
            const startedMs = Number.isFinite(rawMs) && rawMs <= maxTrustedFutureMs
                ? rawMs
                : sessionDirMtimeMs;
            if (startedMs < cutoffMs) {
                fs.rmSync(sessionDir, { recursive: true, force: true });
            }
        }
        catch { /* skip unreadable or already-deleted sessions */ }
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
export function stripSetupSection(prompt) {
    const setupRe = /^## SETUP(?: MODE)?$/m;
    const setupMatch = setupRe.exec(prompt);
    if (!setupMatch)
        return prompt;
    const afterSetup = prompt.slice(setupMatch.index + setupMatch[0].length);
    const nextHeadingRe = /^## \S/m;
    const nextMatch = nextHeadingRe.exec(afterSetup);
    if (!nextMatch)
        return prompt;
    const endIndex = setupMatch.index + setupMatch[0].length + nextMatch.index;
    return prompt.slice(0, setupMatch.index) + prompt.slice(endIndex);
}
/**
 * Strips the "# Step 1: Initialization" block from a manager skill prompt.
 * The block contains setup.js --task examples that codex executes verbatim when
 * present in manager payloads. Strips from the heading through the start of
 * "# Step 2:", exclusive (the Step 2 heading is preserved).
 */
export function stripStepOneBlock(prompt) {
    const step1Re = /^# Step 1: Initialization\s*$/m;
    const step1Match = step1Re.exec(prompt);
    if (!step1Match)
        return prompt;
    const afterStep1 = prompt.slice(step1Match.index);
    const step2Re = /^# Step 2:/m;
    const step2Match = step2Re.exec(afterStep1);
    if (!step2Match)
        return prompt;
    const endIndex = step1Match.index + step2Match.index;
    return prompt.slice(0, step1Match.index) + prompt.slice(endIndex);
}
/**
 * Read-time remap for legacy command_template values. Treats 'pickle.md' as an
 * alias for '_pickle-manager-prompt.md' so sessions persisted before B-PNTR
 * resume without FATAL once pickle.md is removed (R-PNTR-5). Value-only — no
 * schema version change. 'pickle.md' literal is allowed here per R-PNTR-3 + R-PNTR-5.
 */
export function resolveCommandTemplate(raw) {
    if (!raw || raw === 'pickle.md')
        return '_pickle-manager-prompt.md'; // R-PNTR-3 legacy remap
    return raw;
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
/**
 * Composes the full manager prompt from a skill file path, applying all
 * standard transforms and optionally prepending Role Framing for codex.
 * Call sites pre-resolve handoffText/iterationSummary/taskNotes strings.
 */
export function composeManagerPromptFromSkill(skillPath, backend, opts) {
    let content = fs.readFileSync(skillPath, 'utf-8');
    content = content.replace(/\$ARGUMENTS/g, opts.argumentSubstitution);
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

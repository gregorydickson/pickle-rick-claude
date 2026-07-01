#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { printMinimalPanel, Style, TICKET_TIER_BUDGETS, getExtensionRoot, getDataRoot, withRetryLock, pruneOldSessions, safeErrorMessage, findSessionPathForCwd, formatLocalDateKey, collectTickets, getTicketStatus, readFrontmatterField, loadPickleSettingsBag, resolveCodegraphSettings } from '../services/pickle-utils.js';
import { resolveMcpConfigPath, buildWorkerMcpConfig } from '../services/backend-spawn.js';
import { getHeadSha, getHeadBranch, probeConcurrentGitAccess, updateTicketFrontmatter } from '../services/git-utils.js';
import { detectAndRecoverHeadRegression } from './mux-runner.js';
import { LockError, BACKENDS, STATE_MANAGER_DEFAULTS } from '../types/index.js';
import { StateManager, clearExitReason, assertSchemaVersionDeployParity, SchemaVersionDeployDriftError, isProcessAlive, readMappedPid } from '../services/state-manager.js';
import { logActivity, pruneActivity } from '../services/activity-logger.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';
import { updateTicketStatusInTransaction } from '../services/transaction-ticket-ops.js';
import { CodegraphService } from '../services/codegraph-service.js';
const sm = new StateManager();
const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
export const DEFAULT_MANAGER_IDLE_BACKOFF_FALLBACK_MS = 60_000;
const DEFAULT_WORKER_TIMEOUT_SECONDS = TICKET_TIER_BUDGETS.medium.worker_timeout_seconds;
export function resolveManagerIdleBackoffFallbackMs(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1_000 && value <= 600_000
        ? value
        : DEFAULT_MANAGER_IDLE_BACKOFF_FALLBACK_MS;
}
// AC-LPB-01: hard-coded fallback throughput baselines used when
// pickle_settings.json is missing or doesn't declare `throughput_baselines`.
const DEFAULT_THROUGHPUT_BASELINES = {
    claude: 5.0,
    codex: 3.5,
    deepseek: 4.0,
    hermes: 4.5,
};
function extractTicketIdFromPrompt(prompt) {
    const match = prompt.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
    return match ? match[1] : null;
}
const MCP_SNAPSHOT_REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h
// R-MFW-4 (Option D, FR-4): write mcp-context/<server>.json at session init.
// No-ops when servers is empty or mcpConfigPath is undefined.
export async function runMcpSnapshot(sessionRoot, snapshotServers, mcpConfigPath, originalPrompt, fetchFn, isResume = false) {
    if (snapshotServers.length === 0)
        return;
    if (!mcpConfigPath)
        return;
    const mcpContextDir = path.join(sessionRoot, 'mcp-context');
    for (const server of snapshotServers) {
        if (server !== 'linear')
            continue;
        const ticketId = extractTicketIdFromPrompt(originalPrompt);
        if (!ticketId)
            continue;
        const snapshotPath = path.join(mcpContextDir, 'linear-ticket.json');
        if (fs.existsSync(snapshotPath)) {
            if (!isResume)
                continue;
            const ageMs = Date.now() - fs.statSync(snapshotPath).mtimeMs;
            if (ageMs < MCP_SNAPSHOT_REFRESH_THRESHOLD_MS)
                continue;
        }
        let data;
        try {
            data = await fetchFn(server, ticketId);
        }
        catch {
            continue;
        }
        if (!data)
            continue;
        if (!fs.existsSync(mcpContextDir)) {
            fs.mkdirSync(mcpContextDir, { recursive: true });
        }
        try {
            fs.writeFileSync(snapshotPath, JSON.stringify(data, null, 2));
        }
        catch {
            /* best-effort */
        }
    }
}
function cgApplyGitExclude(workingDir) {
    const gitDir = path.join(workingDir, '.git');
    if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory())
        return;
    const infoDir = path.join(gitDir, 'info');
    const excludePath = path.join(infoDir, 'exclude');
    fs.mkdirSync(infoDir, { recursive: true });
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
    if (existing.split('\n').map((l) => l.trim()).includes('.codegraph/'))
        return;
    const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(excludePath, `${sep}.codegraph/\n`);
}
function cgResolveIndexAction(isResume, dbPath, staleMs) {
    if (!isResume)
        return 'full';
    try {
        const ageMs = Date.now() - fs.statSync(dbPath).mtimeMs;
        return ageMs >= staleMs ? 'sync' : 'noop';
    }
    catch {
        return 'full'; // db absent
    }
}
function cgMakeEmit(injected) {
    if (injected)
        return injected;
    return (evt) => {
        const p = { event: evt.event, source: 'pickle', ts: evt.ts };
        if (evt.reason)
            p.reason = evt.reason;
        if (evt.error)
            p.error = evt.error;
        if (evt.operation || evt.gate_payload) {
            p.gate_payload = {
                ...(evt.operation ? { operation: evt.operation } : {}),
                ...(evt.gate_payload ?? {}),
            };
        }
        logActivity(p);
    };
}
export async function runCodegraphIndexAtSetup(workingDir, settings, isResume, deps = {}, env = process.env) {
    if (env['PICKLE_CODEGRAPH'] === 'off')
        return;
    if (!settings.enabled || !settings.index_at_setup)
        return;
    try {
        cgApplyGitExclude(workingDir);
    }
    catch { /* best-effort */ }
    const dbPath = deps.dbPath ?? path.join(workingDir, '.codegraph', 'codegraph.db');
    const indexAction = cgResolveIndexAction(isResume, dbPath, settings.staleness_max_age_minutes * 60_000);
    if (indexAction === 'noop')
        return;
    const emit = cgMakeEmit(deps.emit);
    const svc = CodegraphService.create(workingDir, settings, { ...deps, emit });
    const start = Date.now();
    try {
        const result = indexAction === 'sync' ? await svc.sync() : await svc.indexAll();
        if (result === null) {
            emit({ event: 'codegraph_index_failed', ts: new Date().toISOString(), reason: 'index_null_result', gate_payload: { duration_ms: Date.now() - start } });
        }
    }
    finally {
        svc.close();
    }
}
function die(message) {
    console.error(`${Style.RED}❌ Error: ${message}${Style.RESET}`);
    process.exit(1);
}
function resolveWorkingDirOrNull(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    if (!trimmed)
        return null;
    return path.resolve(trimmed);
}
function buildSetupPaths() {
    const dataDir = getDataRoot();
    return {
        rootDir: getExtensionRoot(),
        dataDir,
        sessionsRoot: path.join(dataDir, 'sessions'),
        jarRoot: path.join(dataDir, 'jar'),
        worktreesRoot: path.join(dataDir, 'worktrees'),
        sessionsMap: path.join(dataDir, 'current_sessions.json'),
    };
}
function createSetupConfig() {
    return {
        loopLimit: 100,
        timeLimit: 0,
        workerTimeout: DEFAULT_WORKER_TIMEOUT_SECONDS,
        pipelineContinueOnPhaseFail: true,
        promiseToken: null,
        resumeMode: false,
        resumePath: null,
        resetMode: false,
        pausedMode: false,
        tmuxMode: false,
        minIterations: 0,
        commandTemplate: '_pickle-manager-prompt.md',
        chainMeeseeks: false,
        backend: undefined,
        workerBackend: undefined,
        teamsMode: false,
        maxParallel: 5,
        effort: undefined,
        prdPath: undefined,
        task: undefined,
        taskArgs: [],
        explicitFlags: new Set(),
        startEpoch: Math.floor(Date.now() / 1000),
        iterationBudgetPerBackend: null,
        throughputBaselines: null,
        acknowledgeUndersized: false,
        managerIdleBackoffFallbackMs: DEFAULT_MANAGER_IDLE_BACKOFF_FALLBACK_MS,
        forceTicketStatusSync: false,
        repin: false,
    };
}
function applyPositiveIntegerSetting(settings, key, apply) {
    const value = settings[key];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0)
        apply(value);
}
function hasExplicitWorkerTimeoutOverride(config) {
    return config.explicitFlags.has('worker-timeout');
}
function persistMediumWorkerTimeoutOverride(state, workerTimeout) {
    const flags = state.flags && typeof state.flags === 'object'
        ? state.flags
        : {};
    const tierCapOverride = flags.tier_cap_override && typeof flags.tier_cap_override === 'object'
        ? flags.tier_cap_override
        : {};
    const medium = tierCapOverride.medium && typeof tierCapOverride.medium === 'object'
        ? tierCapOverride.medium
        : {};
    medium.worker_timeout_seconds = workerTimeout;
    tierCapOverride.medium = medium;
    flags.tier_cap_override = tierCapOverride;
    state.flags = flags;
}
function readPersistedMediumWorkerTimeoutOverride(state) {
    const flags = state.flags;
    if (!flags || typeof flags !== 'object')
        return null;
    const tierCapOverride = flags.tier_cap_override;
    if (!tierCapOverride || typeof tierCapOverride !== 'object')
        return null;
    const medium = tierCapOverride.medium;
    if (!medium || typeof medium !== 'object')
        return null;
    const rawWorkerTimeout = Number(medium.worker_timeout_seconds);
    const workerTimeout = Number.isFinite(rawWorkerTimeout) ? rawWorkerTimeout : 0;
    return Number.isInteger(workerTimeout) && workerTimeout > 0 ? workerTimeout : null;
}
export function resolvePipelineContinueOnPhaseFailSetting(settings) {
    return settings?.pipeline_continue_on_phase_fail === false ? false : true;
}
function readIterationBudgetPerBackend(settings) {
    const rawPerBackend = settings.iteration_budget_per_backend;
    if (!rawPerBackend || typeof rawPerBackend !== 'object' || Array.isArray(rawPerBackend))
        return null;
    const map = {};
    for (const backend of BACKENDS) {
        const value = rawPerBackend[backend];
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
            map[backend] = value;
        }
    }
    return Object.keys(map).length > 0 ? map : null;
}
/**
 * AC-LPB-02: parse `throughput_baselines` from pickle_settings.json. Values
 * are tickets/hour (positive finite numbers). Backend keys are arbitrary
 * strings (claude/codex/deepseek/…) so this stays open for new backends.
 */
function readThroughputBaselines(settings) {
    const raw = settings.throughput_baselines;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const map = {};
    for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            map[key] = value;
        }
    }
    return Object.keys(map).length > 0 ? map : null;
}
/**
 * AC-LPB-01: count tickets in the session's decomposition_manifest.json. Returns
 * 0 when the manifest is missing or malformed — caller treats 0 as "no sizing
 * data, skip the warning".
 */
export function countManifestTickets(sessionDir) {
    const manifestPath = path.join(sessionDir, 'decomposition_manifest.json');
    if (!fs.existsSync(manifestPath))
        return 0;
    try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tickets)) {
            return parsed.tickets.length;
        }
    }
    catch {
        /* malformed — treat as no data */
    }
    return 0;
}
/**
 * AC-LPB-01: warn when `--max-time` is undersized for the planned ticket count
 * given the backend's throughput baseline. Always returns; never blocks launch.
 *
 *   expected_minutes = (ticket_count / throughput) * 60
 *   warn iff max_time > 0 AND max_time < expected * 0.8
 *
 * --acknowledge-undersized silences the warning (CI use). Both the warning
 * header and the recommended budget are computed here so the message wording
 * stays in sync with the threshold logic.
 */
export function evaluateLaunchSizing(sessionDir, config, emit = (msg) => process.stderr.write(msg)) {
    const ticketCount = countManifestTickets(sessionDir);
    if (ticketCount <= 0)
        return null;
    if (!config.timeLimit || config.timeLimit <= 0)
        return null; // 0/unlimited — no sizing concern
    const baselines = config.throughputBaselines ?? DEFAULT_THROUGHPUT_BASELINES;
    const backend = config.backend || 'claude';
    const throughput = baselines[backend] ?? DEFAULT_THROUGHPUT_BASELINES[backend] ?? DEFAULT_THROUGHPUT_BASELINES.claude;
    const expectedMinutes = Math.ceil((ticketCount / throughput) * 60);
    const recommendedMinutes = Math.ceil(expectedMinutes * 1.25);
    const undersized = config.timeLimit < expectedMinutes * 0.8;
    if (!undersized)
        return null;
    if (config.acknowledgeUndersized) {
        return { warned: false, ticketCount, expectedMinutes, recommendedMinutes, throughput, backend };
    }
    emit(`⚠️  --max-time=${config.timeLimit}m may be undersized for ${ticketCount} tickets at ${throughput} t/h on ${backend}\n` +
        `   Estimated wall: ${expectedMinutes}m. Consider --max-time=${recommendedMinutes}m.\n` +
        `   Pass --acknowledge-undersized to proceed.\n`);
    return { warned: true, ticketCount, expectedMinutes, recommendedMinutes, throughput, backend };
}
function updateSessionMap(sessionsMap, cwd, sessionPath) {
    withRetryLock(sessionsMap + '.lock', () => {
        let map = {};
        try {
            const recovered = readRecoverableJsonObject(sessionsMap);
            if (recovered)
                map = recovered;
        }
        catch {
            /* ignore */
        }
        const existing = map[cwd];
        if (existing) {
            const existingPid = readMappedPid(existing);
            const existingPath = typeof existing === 'string' ? existing : existing.sessionPath;
            if (existingPid && isProcessAlive(existingPid) && existingPath !== sessionPath) {
                try {
                    logActivity({
                        event: 'session_map_collision_blocked',
                        source: 'pickle',
                        existing_session_path: existingPath,
                        existing_pid: existingPid,
                        attempted_session_path: sessionPath,
                        attempted_pid: process.pid,
                        cwd,
                    });
                }
                catch { /* best-effort */ }
                process.stderr.write(`[pickle] session-map collision blocked — cwd=${cwd} held by pid=${existingPid}\n`);
                process.exit(1);
            }
        }
        map[cwd] = { sessionPath, pid: process.pid };
        const tmpMap = sessionsMap + `.tmp.${process.pid}.${Date.now()}`;
        try {
            fs.writeFileSync(tmpMap, JSON.stringify(map, null, 2));
            fs.renameSync(tmpMap, sessionsMap);
        }
        catch (err) {
            try {
                fs.unlinkSync(tmpMap);
            }
            catch { /* cleanup best-effort */ }
            throw err;
        }
    });
}
function ensureCoreDirectories(paths) {
    [paths.sessionsRoot, paths.jarRoot, paths.worktreesRoot].forEach((dir) => {
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
    });
}
function loadSettings(config, rootDir) {
    const settingsFile = path.join(rootDir, 'pickle_settings.json');
    if (!fs.existsSync(settingsFile))
        return;
    try {
        const settings = readRecoverableJsonObject(settingsFile);
        if (!settings)
            return;
        applyPositiveIntegerSetting(settings, 'default_max_iterations', value => { config.loopLimit = value; });
        applyPositiveIntegerSetting(settings, 'default_worker_timeout_seconds', value => { config.workerTimeout = value; });
        config.pipelineContinueOnPhaseFail = resolvePipelineContinueOnPhaseFailSetting(settings);
        config.managerIdleBackoffFallbackMs = resolveManagerIdleBackoffFallbackMs(settings.manager_idle_backoff_fallback_ms);
        config.iterationBudgetPerBackend = readIterationBudgetPerBackend(settings);
        config.throughputBaselines = readThroughputBaselines(settings);
    }
    catch (err) {
        const msg = safeErrorMessage(err);
        console.error(`Warning: could not parse pickle_settings.json — using defaults: ${msg}`);
    }
}
function parseCodexVersion(output) {
    const match = output.match(/\b(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?\b/);
    if (!match)
        return null;
    const rawMajor = Number(match[1]);
    const rawMinor = Number(match[2]);
    const rawPatch = Number(match[3]);
    const major = Number.isFinite(rawMajor) ? rawMajor : -1;
    const minor = Number.isFinite(rawMinor) ? rawMinor : -1;
    const patch = Number.isFinite(rawPatch) ? rawPatch : -1;
    if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch))
        return null;
    return { major, minor, patch, version: `${match[1]}.${match[2]}.${match[3]}` };
}
function compareVersion(left, right) {
    if (left.major !== right.major)
        return left.major - right.major;
    if (left.minor !== right.minor)
        return left.minor - right.minor;
    return left.patch - right.patch;
}
function caretUpperBound(minimum) {
    if (minimum.major > 0)
        return { major: minimum.major + 1, minor: 0, patch: 0, version: `${minimum.major + 1}.0.0` };
    if (minimum.minor > 0)
        return { major: 0, minor: minimum.minor + 1, patch: 0, version: `0.${minimum.minor + 1}.0` };
    return { major: 0, minor: 0, patch: minimum.patch + 1, version: `0.0.${minimum.patch + 1}` };
}
export function codexVersionSatisfiesRange(versionOutput, range) {
    const actual = parseCodexVersion(versionOutput);
    if (!actual)
        return false;
    // Minimum-floor range (">=X.Y.Z"): any codex at or above the floor is accepted. codex ships 0.x
    // with frequent minor bumps (the CLI can auto-update daily), so an exact pin — or even a caret
    // range, which for a 0.x version locks the minor — breaks setup the moment codex advances. A floor
    // enforces the minimum required capability without coupling setup to the newest release.
    const floor = range.match(/^>=\s*(\d+\.\d+\.\d+)$/);
    if (floor) {
        const minimum = parseCodexVersion(floor[1]);
        if (!minimum)
            return false;
        return compareVersion(actual, minimum) >= 0;
    }
    const caret = range.match(/^\^(\d+\.\d+\.\d+)$/);
    if (!caret)
        return actual.version === range;
    const minimum = parseCodexVersion(caret[1]);
    if (!minimum)
        return false;
    return compareVersion(actual, minimum) >= 0 && compareVersion(actual, caretUpperBound(minimum)) < 0;
}
function readCodexEngineRange(extensionRoot) {
    const configuredPath = path.join(extensionRoot, 'extension', 'package.json');
    const packageJsonPath = fs.existsSync(configuredPath)
        ? configuredPath
        : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json');
    let packageJson;
    try {
        packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    }
    catch (err) {
        die(`Could not read extension/package.json for codex backend smoke check: ${safeErrorMessage(err)}`);
    }
    const range = packageJson.engines?.codex;
    if (typeof range !== 'string' || range.trim() === '') {
        die('extension/package.json is missing engines.codex for codex backend smoke check');
    }
    return range.trim();
}
function readCodexVersion() {
    try {
        return execFileSync('codex', ['--version'], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 10_000,
        }).trim();
    }
    catch (err) {
        die(`codex --version failed during codex backend smoke check: ${safeErrorMessage(err)}`);
    }
}
export function resolveCodexVersionForSetup(backend, extensionRoot = getExtensionRoot()) {
    if ((backend || 'claude') !== 'codex')
        return null;
    const versionOutput = readCodexVersion();
    const range = readCodexEngineRange(extensionRoot);
    if (!codexVersionSatisfiesRange(versionOutput, range)) {
        die(`codex version mismatch: codex --version returned "${versionOutput}", expected engines.codex "${range}"`);
    }
    return versionOutput;
}
/**
 * Apply the per-backend iteration budget AFTER CLI parsing, so we know which
 * backend was selected. Resolution order:
 *   1. Explicit --max-iterations CLI flag wins (already in config.loopLimit).
 *   2. iteration_budget_per_backend[backend] if present.
 *   3. default_max_iterations (already in config.loopLimit from loadSettings).
 *   4. Hard-coded 100 fallback (config default).
 *
 * Backend defaults to 'claude' when --backend is not passed (matches the
 * activation panel's `config.backend || 'claude'` rendering).
 */
function applyPerBackendBudget(config) {
    if (config.explicitFlags.has('max-iterations'))
        return;
    if (!config.iterationBudgetPerBackend)
        return;
    const backend = config.backend || 'claude';
    const perBackend = config.iterationBudgetPerBackend[backend];
    if (typeof perBackend === 'number' && Number.isInteger(perBackend) && perBackend >= 0) {
        config.loopLimit = perBackend;
    }
}
function parseIntegerFlag(args, index, flag, validate, errorMessage) {
    const raw = args[index + 1];
    const value = Number(raw);
    if (raw === undefined || raw.startsWith('--') || !Number.isInteger(value) || !validate(value))
        die(errorMessage);
    return value;
}
const ARG_HANDLERS = {
    '--max-iterations': (config, args, index) => {
        config.loopLimit = parseIntegerFlag(args, index, '--max-iterations', value => value >= 0, '--max-iterations requires a non-negative integer');
        config.explicitFlags.add('max-iterations');
        return index + 1;
    },
    '--max-time': (config, args, index) => {
        config.timeLimit = parseIntegerFlag(args, index, '--max-time', value => value >= 0, '--max-time requires a non-negative integer');
        config.explicitFlags.add('max-time');
        return index + 1;
    },
    '--worker-timeout': (config, args, index) => {
        config.workerTimeout = parseIntegerFlag(args, index, '--worker-timeout', value => value > 0, '--worker-timeout requires a positive integer');
        config.explicitFlags.add('worker-timeout');
        return index + 1;
    },
    '--completion-promise': (config, args, index) => {
        const value = args[index + 1];
        if (!value || value.startsWith('--'))
            die('--completion-promise requires a non-empty value');
        config.promiseToken = value;
        return index + 1;
    },
    '--resume': (config, args, index) => {
        config.resumeMode = true;
        if (args[index + 1] && !args[index + 1].startsWith('--')) {
            config.resumePath = args[index + 1];
            return index + 1;
        }
        return index;
    },
    '--reset': (config, _args, index) => {
        config.resetMode = true;
        return index;
    },
    '--paused': (config, _args, index) => {
        config.pausedMode = true;
        return index;
    },
    '--tmux': (config, _args, index) => {
        config.tmuxMode = true;
        return index;
    },
    '--task': (config, args, index) => {
        if (index + 1 < args.length)
            config.taskArgs.push(args[index + 1]);
        return index + 1;
    },
    '--min-iterations': (config, args, index) => {
        config.minIterations = parseIntegerFlag(args, index, '--min-iterations', value => value >= 0, '--min-iterations requires a non-negative integer');
        config.explicitFlags.add('min-iterations');
        return index + 1;
    },
    '--command-template': (config, args, index) => {
        const value = args[index + 1];
        if (!value || value.startsWith('--'))
            die('--command-template requires a non-empty value');
        if (value.includes('/') || value.includes('\\') || value.includes('..'))
            die('--command-template must be a plain filename');
        config.commandTemplate = value;
        config.explicitFlags.add('command-template');
        return index + 1;
    },
    '--chain-meeseeks': (config, _args, index) => {
        config.chainMeeseeks = true;
        return index;
    },
    '--backend': (config, args, index) => {
        const value = args[index + 1];
        if (!value || value.startsWith('--'))
            die(`--backend requires a value (${BACKENDS.join('|')})`);
        if (!BACKENDS.includes(value)) {
            die(`--backend must be one of: ${BACKENDS.join(', ')}`);
        }
        config.backend = value;
        config.explicitFlags.add('backend');
        return index + 1;
    },
    '--worker-backend': (config, args, index) => {
        const value = args[index + 1];
        if (!value || value.startsWith('--'))
            die(`--worker-backend requires a value (${BACKENDS.join('|')})`);
        if (!BACKENDS.includes(value)) {
            die(`--worker-backend must be one of: ${BACKENDS.join(', ')}`);
        }
        config.workerBackend = value;
        config.explicitFlags.add('worker-backend');
        return index + 1;
    },
    '--teams': (config, _args, index) => {
        config.teamsMode = true;
        config.explicitFlags.add('teams');
        return index;
    },
    '--max-parallel': (config, args, index) => {
        const raw = args[index + 1];
        if (!raw || raw.startsWith('--'))
            die('--max-parallel requires a positive integer value (>= 1)');
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1)
            die('--max-parallel requires a positive integer (>= 1)');
        config.maxParallel = value;
        config.explicitFlags.add('max-parallel');
        return index + 1;
    },
    '--effort': (config, args, index) => {
        const value = args[index + 1];
        if (!value || value.startsWith('--'))
            die(`--effort requires a value (${VALID_EFFORTS.join('|')})`);
        if (!VALID_EFFORTS.includes(value)) {
            die(`--effort must be one of: ${VALID_EFFORTS.join(', ')}`);
        }
        config.effort = value;
        config.explicitFlags.add('effort');
        return index + 1;
    },
    '--acknowledge-undersized': (config, _args, index) => {
        config.acknowledgeUndersized = true;
        config.explicitFlags.add('acknowledge-undersized');
        return index;
    },
    '--force-ticket-status-sync': (config, _args, index) => {
        config.forceTicketStatusSync = true;
        config.explicitFlags.add('force-ticket-status-sync');
        return index;
    },
    // R-RSPIN-A: --repin forces re-derivation of pinned_branch/pinned_sha from
    // working-dir HEAD on --resume even when the stored pin already matches. On
    // resume the pin is also re-derived automatically whenever it differs from HEAD.
    '--repin': (config, _args, index) => {
        config.repin = true;
        config.explicitFlags.add('repin');
        return index;
    },
    '-s': (_config, args, index) => (args[index + 1] && !args[index + 1].startsWith('--') ? index + 1 : index),
    '--session-id': (_config, args, index) => (args[index + 1] && !args[index + 1].startsWith('--') ? index + 1 : index),
};
function parseCommandLine(config, args) {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const handler = ARG_HANDLERS[arg];
        if (!handler) {
            config.taskArgs.push(arg);
            continue;
        }
        i = handler(config, args, i);
    }
    config.task = config.taskArgs.join(' ').trim() || undefined;
    config.prdPath = resolvePrdPath(config.taskArgs);
}
function isMarkdownPrd(candidate) {
    const base = path.basename(candidate).toLowerCase();
    return base.endsWith('.md') && (base === 'prd.md' || candidate.toLowerCase().includes('prd'));
}
function resolveExistingPrdPath(candidate) {
    const cleaned = candidate.trim().replace(/^["'`(<]+|[)"'`,>]+$/g, '');
    if (!cleaned || !isMarkdownPrd(cleaned))
        return undefined;
    const resolved = path.resolve(cleaned);
    try {
        return fs.statSync(resolved).isFile() ? resolved : undefined;
    }
    catch {
        return undefined;
    }
}
function resolvePrdPath(taskArgs) {
    for (const arg of taskArgs) {
        const exact = resolveExistingPrdPath(arg);
        if (exact)
            return exact;
    }
    for (const arg of taskArgs) {
        for (const token of arg.split(/\s+/)) {
            const resolved = resolveExistingPrdPath(token);
            if (resolved)
                return resolved;
        }
    }
    return resolveExistingPrdPath('prd.md') ?? resolveExistingPrdPath('PRD.md');
}
/**
 * D3 (B-RRH AC-D3): resolve the refined-or-base PRD that lives under a session
 * dir, preferring `prd_refined.md` over `prd.md`. Used on the `--resume` path to
 * populate `config.prdPath` so the resume stamp in `applyResumeConfig` fires —
 * the new-session stamp in `createInitialState` is never reached on resume.
 */
function resolveSessionPrdPath(sessionDir) {
    for (const name of ['prd_refined.md', 'prd.md']) {
        const candidate = path.join(sessionDir, name);
        try {
            if (fs.statSync(candidate).isFile())
                return candidate;
        }
        catch {
            /* missing — try the next candidate */
        }
    }
    return undefined;
}
function resolveStartCommit() {
    try {
        return getHeadSha(process.cwd());
    }
    catch {
        return undefined;
    }
}
function validateCommandLine(config) {
    if (config.explicitFlags.has('max-parallel') && !config.teamsMode) {
        die('--max-parallel requires --teams');
    }
    const backend = config.backend || 'claude';
    if (config.teamsMode && backend !== 'claude') {
        die(`--teams is incompatible with --backend ${backend} (claude backend only)`);
    }
    if (backend === 'deepseek' && !process.env.DEEPSEEK_API_KEY) {
        console.error('Error: --backend deepseek requires DEEPSEEK_API_KEY environment variable.');
        console.error('Get a key at https://platform.deepseek.com/api_keys.');
        process.exit(1);
    }
}
function validateResumeCompatibility(preState, config, sessionRoot) {
    const resumeWorkingDir = resolveWorkingDirOrNull(preState.working_dir);
    const currentWorkingDir = path.resolve(process.cwd());
    if (resumeWorkingDir && resumeWorkingDir !== currentWorkingDir) {
        // R-PRCR-1: instead of refusing, chdir into the stored working_dir so the
        // operator can resume from any shell location. Only die when the stored
        // working_dir no longer exists or is not a directory.
        let isDir;
        try {
            isDir = fs.statSync(resumeWorkingDir).isDirectory();
        }
        catch {
            isDir = false;
        }
        if (!isDir) {
            die(`--resume session's working_dir (${resumeWorkingDir}) no longer exists or is not a directory. ` +
                `The original checkout was likely moved or removed. Restore it or start a new session.`);
        }
        try {
            process.chdir(resumeWorkingDir);
        }
        catch (err) {
            die(`--resume could not chdir into ${resumeWorkingDir}: ${err instanceof Error ? err.message : String(err)}`);
        }
        try {
            logActivity({
                event: 'setup_resume_chdir_applied',
                source: 'pickle',
                session: sessionRoot ? path.basename(sessionRoot) : undefined,
                gate_payload: {
                    from: currentWorkingDir,
                    to: resumeWorkingDir,
                },
            });
        }
        catch { /* best-effort */ }
    }
    const willHaveTeams = config.explicitFlags.has('teams') ? config.teamsMode : preState.teams_mode === true;
    const willHaveBackend = (config.explicitFlags.has('backend') ? config.backend : preState.backend) || 'claude';
    if (willHaveTeams && willHaveBackend !== 'claude') {
        die(`--teams is incompatible with --backend ${willHaveBackend} (claude backend only). Resume would create a conflicting state — refusing to continue.`);
    }
}
function normalizeTicketStatus(status) {
    return (status || '').toLowerCase().replace(/["']/g, '').trim();
}
function isInProgressTicket(sessionDir, ticket) {
    if (!ticket.id)
        return false;
    try {
        return normalizeTicketStatus(getTicketStatus(sessionDir, ticket.id)) === 'in progress';
    }
    catch {
        return false;
    }
}
function writeTicketStatus(sessionDir, ticketId, status) {
    try {
        const planned = updateTicketStatusInTransaction(ticketId, status, sessionDir);
        fs.writeFileSync(planned.path, planned.content);
        return true;
    }
    catch {
        return false;
    }
}
function chooseInProgressWinner(inProgress, currentTicket) {
    if (currentTicket && inProgress.some(ticket => ticket.id === currentTicket))
        return currentTicket;
    return inProgress.find(ticket => !!ticket.id)?.id ?? currentTicket;
}
// R-SRTS-1: gate the "restore In Progress" write behind --force-ticket-status-sync.
// winner === currentTicket is invariant here (chooseInProgressWinner falls back to
// currentTicket when inProgress is empty, which is the only case where the winner
// is not already in inProgress). Telemetry errors must not block resume.
function applyWinnerStatusSync(sessionDir, winner, forceSync) {
    const observedStatus = (() => {
        try {
            return getTicketStatus(sessionDir, winner) ?? 'Unknown';
        }
        catch {
            return 'Unknown';
        }
    })();
    if (forceSync) {
        writeTicketStatus(sessionDir, winner, 'In Progress');
        try {
            logActivity({
                event: 'setup_resume_overrode_ticket_status',
                source: 'force_flag',
                ticket_id: winner,
                prior_status: observedStatus,
                new_status: 'In Progress',
            });
        }
        catch { /* telemetry must not block resume */ }
    }
    else {
        try {
            logActivity({
                event: 'setup_resume_ticket_status_preserved',
                source: 'pickle',
                ticket_id: winner,
                observed_status: observedStatus,
                expected_status: 'In Progress',
                reason: 'operator_edit',
            });
        }
        catch { /* telemetry must not block resume */ }
    }
}
function reconcileTicketStateDesyncOnResume(sessionDir, statePath, currentTicket, forceSync) {
    const tickets = collectTickets(sessionDir);
    if (tickets.length === 0) {
        process.stderr.write(`WARN: ticket_state_desync check found no ticket directories in ${sessionDir}\n`);
        return sm.read(statePath);
    }
    const inProgress = tickets.filter(ticket => isInProgressTicket(sessionDir, ticket));
    const winner = chooseInProgressWinner(inProgress, currentTicket);
    if (inProgress.length === 1 && winner === currentTicket)
        return sm.read(statePath);
    logActivity({
        event: 'ticket_state_desync_detected',
        source: 'pickle',
        session: path.basename(sessionDir),
        ticket: winner ?? currentTicket ?? undefined,
        reason: `current_ticket=${currentTicket ?? 'none'} in_progress=${inProgress.map(t => t.id || '?').join(',') || 'none'}`,
    });
    if (winner && !inProgress.some(ticket => ticket.id === winner)) {
        applyWinnerStatusSync(sessionDir, winner, forceSync);
    }
    for (const ticket of inProgress) {
        if (!ticket.id || ticket.id === winner)
            continue;
        writeTicketStatus(sessionDir, ticket.id, 'Todo');
    }
    if (winner && winner !== currentTicket) {
        return sm.update(statePath, s => {
            s.current_ticket = winner;
            // R-CNAR-8: transitioning current_ticket REQUIRES atomic clear of all
            // 5 cache fields, not just tier/budget. Pre-fix the other 3 fields
            // survived from the prior ticket and distorted ticketBudgetIterationCount
            // on the new ticket's first iteration.
            delete s.current_ticket_tier;
            delete s.current_ticket_budget;
            delete s.current_ticket_max_iterations;
            delete s.current_ticket_worker_timeout_seconds;
            delete s.current_ticket_budget_start_iteration;
        });
    }
    return sm.read(statePath);
}
function applyResumeConfig(s, config, fullSessionPath, codexVersionSeen) {
    s.active = !config.pausedMode;
    // R-PTSB-3: stamp the live owning pid when reactivating so the dead-pid /
    // pid-null phantom recovery in recoverStaleActiveFlag does not immediately
    // demote the resumed session — its stored pid belongs to the now-dead
    // original setup process. Mirrors createInitialState's active-write pid stamp.
    if (s.active)
        s.pid = process.pid;
    if (config.resetMode) {
        s.iteration = 0;
    }
    // AC-LPB-05: start_time_epoch always resets to the resume time — whether or not
    // --reset was passed — so the wall-clock cap-check doesn't subtract from a stale
    // launch baseline. Resume IS reconstruction, so the reset is intentional even
    // without --reset. The activity event is emitted by the caller (resumeSession)
    // so we can compare original vs new.
    s.start_time_epoch = config.startEpoch;
    applyResumeLimitConfig(s, config);
    applyResumeModeConfig(s, config);
    if (codexVersionSeen)
        s.codex_version_seen = codexVersionSeen;
    s.session_dir = fullSessionPath;
    // D3 (B-RRH AC-D3): the resume-path equivalent of the createInitialState
    // prd_path stamp (NOT a duplicate — createInitialState is never reached on
    // resume). config.prdPath was populated upstream in resumeSession from the
    // session dir, so this fires for paused-refine → --resume.
    if (config.prdPath)
        s.prd_path = config.prdPath;
    repinFromHeadOnResume(s, config);
}
/**
 * R-RSPIN-A: re-derive pinned_branch/pinned_sha from working-dir HEAD on resume.
 * B-RRH repopulated prd_path on resume but not the branch/SHA pin, so a resumed
 * session whose branch moved / SHA advanced reasoned against a dead pin in
 * mux-runner.ts:checkHeadPinMismatch. Reads ONLY working-dir HEAD (process.cwd()
 * is already the resumed working_dir — chdir ran upstream in resumeSession) and
 * mutates ONLY the two pin fields. Re-derives when the stored pin differs from
 * HEAD, or unconditionally under --repin. Mirrors createInitialState's capture:
 * getHeadBranch returns null on detached HEAD; the sha is only overwritten when a
 * real HEAD sha is readable so a non-repo resume never clobbers a good pin.
 */
function repinFromHeadOnResume(s, config) {
    const observedBranch = (() => {
        try {
            return getHeadBranch(process.cwd());
        }
        catch {
            return null;
        }
    })();
    let observedSha;
    try {
        observedSha = getHeadSha(process.cwd());
    }
    catch {
        observedSha = undefined;
    }
    const differs = s.pinned_branch !== observedBranch || s.pinned_sha !== observedSha;
    if (!config.repin && !differs)
        return;
    s.pinned_branch = observedBranch;
    if (observedSha)
        s.pinned_sha = observedSha;
}
/**
 * R-ICP-3 (p1-iteration-cap-and-phantom-done-handshake): on resume, the cap
 * fields obey CLI-wins-then-persisted-state-wins precedence. If a CLI flag was
 * passed, it overrides and is written into state.json. If the flag was NOT
 * passed, the persisted value in state.json is the authoritative cap and we
 * leave it alone. For max_iterations / worker_timeout_seconds, missing or
 * invalid persisted values still fall back to the documented defaults with a
 * warning so display and persisted state stay aligned. For max_time_minutes,
 * the default is now "disabled unless explicitly set", so missing or invalid
 * persisted values cause the field to be removed instead of silently
 * reintroducing a wall-clock cap on resume.
 */
function applyResumeLimitConfig(s, config) {
    if (config.explicitFlags.has('max-iterations')) {
        s.max_iterations = config.loopLimit;
    }
    else if (!Number.isFinite(Number(s.max_iterations))) {
        process.stderr.write(`[setup] WARNING: --resume found no persisted max_iterations and --max-iterations was not passed; ` +
            `falling back to documented default ${config.loopLimit}. Pass --max-iterations to override.\n`);
        s.max_iterations = config.loopLimit;
    }
    if (config.explicitFlags.has('max-time')) {
        s.max_time_minutes = config.timeLimit;
    }
    else {
        const persisted = Number(s.max_time_minutes);
        if (Number.isFinite(persisted) && persisted >= 0) {
            // Preserve explicit persisted opt-in caps, including `0` for unlimited.
        }
        else {
            delete s.max_time_minutes;
        }
    }
    if (hasExplicitWorkerTimeoutOverride(config)) {
        s.worker_timeout_seconds = config.workerTimeout;
        persistMediumWorkerTimeoutOverride(s, config.workerTimeout);
    }
    else {
        const persisted = Number(s.worker_timeout_seconds);
        if (!Number.isFinite(persisted) || persisted <= 0) {
            const persistedOverride = readPersistedMediumWorkerTimeoutOverride(s);
            if (persistedOverride !== null) {
                s.worker_timeout_seconds = persistedOverride;
            }
            else {
                process.stderr.write(`[setup] WARNING: --resume found no persisted worker_timeout_seconds and --worker-timeout was not passed; ` +
                    `falling back to documented default ${config.workerTimeout}. Pass --worker-timeout to override.\n`);
                s.worker_timeout_seconds = config.workerTimeout;
            }
        }
    }
    if (config.promiseToken)
        s.completion_promise = config.promiseToken;
    if (config.explicitFlags.has('min-iterations'))
        s.min_iterations = config.minIterations;
}
function applyResumeModeConfig(s, config) {
    if (config.explicitFlags.has('command-template'))
        s.command_template = config.commandTemplate;
    if (config.tmuxMode)
        s.tmux_mode = true;
    if (config.chainMeeseeks)
        s.chain_meeseeks = true;
    if (config.explicitFlags.has('backend') && config.backend)
        s.backend = config.backend;
    if (config.explicitFlags.has('worker-backend'))
        s.worker_backend = config.workerBackend;
    if (config.explicitFlags.has('teams'))
        s.teams_mode = config.teamsMode;
    if (config.explicitFlags.has('max-parallel'))
        s.max_parallel = config.maxParallel;
    if (config.explicitFlags.has('effort'))
        s.effort = config.effort;
}
function syncConfigFromState(config, state) {
    const rawLoopLimit = Number(state.max_iterations);
    config.loopLimit = Number.isFinite(rawLoopLimit) ? rawLoopLimit : config.loopLimit;
    const rawTimeLimit = Number(state.max_time_minutes);
    config.timeLimit = Number.isFinite(rawTimeLimit) && rawTimeLimit >= 0 ? rawTimeLimit : 0;
    const rawWorkerTimeout = Number(state.worker_timeout_seconds);
    config.workerTimeout = Number.isFinite(rawWorkerTimeout) && rawWorkerTimeout > 0 ? rawWorkerTimeout : config.workerTimeout;
    const rawMinIter = Number(state.min_iterations);
    config.minIterations = Number.isFinite(rawMinIter) ? rawMinIter : 0;
    config.commandTemplate = state.command_template;
    config.chainMeeseeks = state.chain_meeseeks === true;
    if (state.backend && BACKENDS.includes(state.backend))
        config.backend = state.backend;
    config.teamsMode = state.teams_mode === true;
    const rawMaxParallel = Number(state.max_parallel);
    config.maxParallel = Number.isFinite(rawMaxParallel) && Number.isInteger(rawMaxParallel) && rawMaxParallel >= 1
        ? rawMaxParallel
        : config.maxParallel;
    if (typeof state.effort === 'string' && VALID_EFFORTS.includes(state.effort)) {
        config.effort = state.effort;
    }
    config.promiseToken = state.completion_promise;
}
function emitResumeEpochReset(fullSessionPath, originalEpoch, state) {
    if (originalEpoch === null || state.start_time_epoch === originalEpoch)
        return;
    try {
        logActivity({
            event: 'session_reconstructed_epoch_reset',
            source: 'pickle',
            session: path.basename(fullSessionPath),
            original_epoch: originalEpoch,
            new_epoch: state.start_time_epoch,
        });
    }
    catch { /* ignore — telemetry should not block resume */ }
}
/**
 * C5 (B-RRH AC-C5): on `--resume`, self-heal an orphaned ticket commit.
 *
 * When a worker committed real work then the commit was orphaned before this
 * resume (a spurious Failed-flip + HEAD reset, the pre-fix state), the ticket
 * frontmatter still names the orphaned commit in `completion_commit`. If that
 * commit ff-descends from HEAD (`git merge-base --is-ancestor HEAD <sha>` exits
 * 0), reuse the H1 reattach logic (`detectAndRecoverHeadRegression` with
 * startCommit = currentHead) to `merge --ff-only` reattach it, then mark the
 * ticket Done with an explicit completion_commit. A NON-ancestor commit is left
 * untouched — never force-reattached, reset, or cherry-picked — because H1's
 * non-recovery path would clear completion_commit.
 *
 * Best-effort throughout: every external call is wrapped in try/catch and errors
 * go to stderr only. This MUST NOT throw out of the resume path.
 */
/** Read `completion_commit` from the current ticket's frontmatter, or null. */
function readTicketCompletionCommit(sessionRoot, ticketId) {
    let status;
    try {
        status = getTicketStatus(sessionRoot, ticketId);
    }
    catch {
        return null; // ticket missing/unparseable — nothing to heal
    }
    const normalized = (status || '').trim().toLowerCase();
    if (normalized !== 'failed' && normalized !== 'in progress')
        return null;
    try {
        const ticketPath = path.join(sessionRoot, ticketId, `linear_ticket_${ticketId}.md`);
        return readFrontmatterField(fs.readFileSync(ticketPath, 'utf-8'), 'completion_commit');
    }
    catch {
        return null;
    }
}
/** True iff `sha` ff-descends from HEAD (`merge-base --is-ancestor HEAD sha` exit 0). */
function shaDescendsFromHead(workingDir, currentHead, sha) {
    try {
        execFileSync('git', ['merge-base', '--is-ancestor', currentHead, sha], {
            cwd: workingDir,
            stdio: ['ignore', 'ignore', 'ignore'],
            timeout: 5000,
        });
        return true;
    }
    catch {
        return false; // not a descendant — never force-reattach (SAFETY)
    }
}
function tryResumeOrphanReattach(fullSessionPath, statePath, currentTicket, workingDir) {
    if (!currentTicket || !workingDir)
        return;
    try {
        const completionCommitSha = readTicketCompletionCommit(fullSessionPath, currentTicket);
        if (!completionCommitSha)
            return; // skip fsck discovery (out of scope)
        let currentHead = '';
        try {
            currentHead = getHeadSha(workingDir);
        }
        catch {
            return;
        }
        if (!currentHead)
            return;
        // is-ancestor gate: the stamped SHA MUST ff-descend from HEAD, else leaving it
        // to H1 would clear completion_commit via the non-recovery path.
        if (!shaDescendsFromHead(workingDir, currentHead, completionCommitSha))
            return;
        let iteration = 0;
        try {
            const state = sm.read(statePath);
            if (typeof state.iteration === 'number' && Number.isFinite(state.iteration))
                iteration = state.iteration;
        }
        catch { /* iteration is advisory — default to 0 */ }
        const result = detectAndRecoverHeadRegression({
            ticketId: currentTicket,
            workingDir,
            startCommit: currentHead,
            completionCommitSha,
            sessionDir: fullSessionPath,
            statePath,
            iteration,
            log: (m) => process.stderr.write(m + '\n'),
        });
        if (result.recovered) {
            updateTicketFrontmatter(currentTicket, fullSessionPath, { status: 'Done', completion_commit: completionCommitSha });
        }
    }
    catch (err) {
        process.stderr.write(`[resume-reattach] best-effort failure: ${safeErrorMessage(err)}\n`);
    }
}
function resumeSession(config) {
    const fullSessionPath = config.resumePath
        ? resolvePath(config.resumePath)
        : findSessionPathForCwd(process.cwd());
    if (!fullSessionPath || !fs.existsSync(fullSessionPath)) {
        die(`No active session found or path invalid: ${fullSessionPath}`);
    }
    const statePath = path.join(fullSessionPath, 'state.json');
    // D3 (B-RRH AC-D3): on --resume the session dir is authoritative for the PRD —
    // prd_refined.md preferred over prd.md. resolvePrdPath ran against process.cwd()
    // at parse time, so config.prdPath may hold a cwd-relative bare `prd.md` false
    // match; the session PRD must supersede it. Only when the session dir has no PRD
    // do we keep whatever config.prdPath resolved to (e.g. an explicit CLI arg).
    const sessionPrd = resolveSessionPrdPath(fullSessionPath);
    if (sessionPrd)
        config.prdPath = sessionPrd;
    let preState = null;
    try {
        preState = sm.read(statePath);
    }
    catch {
        /* missing/corrupt — sm.update below will surface the right error */
    }
    if (preState)
        validateResumeCompatibility(preState, config, fullSessionPath);
    // Claim the session map entry under the live setup PID BEFORE the locked
    // sm.update read can re-trigger recovery. Otherwise a stale dead-mapped-pid
    // from a previous launcher (e.g. the original setup that created this
    // session) trips paused-orphan demotion inside `recoverStaleActiveFlag` and
    // silently flips active=false back, defeating resume. The cross-repo
    // validateResumeCompatibility above must die FIRST, so we claim the map
    // only after that check passes.
    try {
        const setupPaths = buildSetupPaths();
        updateSessionMap(setupPaths.sessionsMap, process.cwd(), fullSessionPath);
    }
    catch {
        /* map update is best-effort; resume must still proceed */
    }
    let state;
    const resumeBackend = config.explicitFlags.has('backend') ? config.backend : preState?.backend;
    const codexVersionSeen = resolveCodexVersionForSetup(resumeBackend);
    // AC-LPB-05: capture the pre-resume epoch so we can emit the
    // session_reconstructed_epoch_reset activity event with both timestamps.
    const originalEpoch = typeof preState?.start_time_epoch === 'number' ? preState.start_time_epoch : null;
    try {
        state = sm.update(statePath, s => {
            applyResumeConfig(s, config, fullSessionPath, codexVersionSeen);
        });
        if (state.active === true) {
            clearExitReason(statePath);
            state = sm.read(statePath);
        }
        state = reconcileTicketStateDesyncOnResume(fullSessionPath, statePath, state.current_ticket || null, config.forceTicketStatusSync);
    }
    catch {
        die(`state.json is missing or corrupt in ${fullSessionPath}`);
    }
    // C5 (B-RRH AC-C5): self-heal an orphaned ticket commit on resume.
    tryResumeOrphanReattach(fullSessionPath, statePath, state.current_ticket, state.working_dir);
    emitResumeEpochReset(fullSessionPath, originalEpoch, state);
    syncConfigFromState(config, state);
    return {
        sessionRoot: fullSessionPath,
        state,
    };
}
function resolveTask(config) {
    const taskStr = config.taskArgs.join(' ').trim();
    if (config.resumeMode)
        return taskStr;
    if (!taskStr && !config.pausedMode)
        die('No task specified. Run /pickle --help for usage.');
    if (!taskStr)
        return 'PRD Interview (task to be determined via interview)';
    return taskStr;
}
/**
 * R-ICP-4 (p1-iteration-cap-and-phantom-done-handshake): persist the resolved
 * cap/timeout/backend values into state.json AT initial setup time so resumed
 * sessions and downstream consumers (mux-runner, pipeline-runner, monitor) read
 * the same numbers the activation banner displays. config.loopLimit / .timeLimit
 * / .workerTimeout were already reconciled by parseArguments through (in order):
 *   1. createSetupConfig defaults
 *   2. loadSettings (pickle_settings.json)
 *   3. parseCommandLine (CLI flags — explicit-flag wins)
 *   4. applyPerBackendBudget (iteration_budget_per_backend[backend], skipped when
 *      --max-iterations was explicit)
 * The State field names below match the existing schema (max_iterations,
 * max_time_minutes opt-in, worker_timeout_seconds, backend) — do not introduce parallel
 * fields. mux-runner.ts reads state.max_iterations directly to compute the cap.
 */
function createInitialState(config, sessionPath, taskStr) {
    const codexVersionSeen = resolveCodexVersionForSetup(config.backend);
    const state = {
        active: !config.pausedMode && !config.tmuxMode,
        working_dir: process.cwd(),
        step: 'prd',
        iteration: 0,
        max_iterations: config.loopLimit,
        worker_timeout_seconds: config.workerTimeout,
        start_time_epoch: config.startEpoch,
        completion_promise: config.promiseToken,
        original_prompt: taskStr,
        current_ticket: null,
        history: [],
        started_at: new Date().toISOString(),
        session_dir: sessionPath,
        tmux_mode: config.tmuxMode,
        min_iterations: config.minIterations,
        command_template: config.commandTemplate,
        chain_meeseeks: config.chainMeeseeks,
        schema_version: STATE_MANAGER_DEFAULTS.schemaVersion,
        backend: config.backend,
        worker_backend: config.workerBackend,
        pipeline_continue_on_phase_fail: config.pipelineContinueOnPhaseFail,
        teams_mode: config.teamsMode || undefined,
        max_parallel: config.teamsMode ? config.maxParallel : undefined,
        effort: config.effort,
        archaeology: null,
        tickets_version: 0,
        last_course_correction: null,
        phase_personas_active: false,
        flags: {},
        readiness: { cycle_history: [] },
        codex_version_seen: codexVersionSeen,
        orphans_detected: [],
        invocation_source: process.env.PICKLE_PARENT_SESSION_HASH ? 'manager_subprocess' : 'operator',
        parent_session_hash: process.env.PICKLE_PARENT_SESSION_HASH || null,
    };
    if (state.active)
        state.pid = process.pid;
    if (config.explicitFlags.has('max-time')) {
        state.max_time_minutes = config.timeLimit;
    }
    if (hasExplicitWorkerTimeoutOverride(config)) {
        persistMediumWorkerTimeoutOverride(state, config.workerTimeout);
    }
    const startCommit = resolveStartCommit();
    if (config.prdPath)
        state.prd_path = config.prdPath;
    if (startCommit)
        state.start_commit = startCommit;
    const pinnedBranch = (() => {
        try {
            return getHeadBranch(process.cwd());
        }
        catch {
            return null;
        }
    })();
    state.pinned_branch = pinnedBranch;
    if (startCommit)
        state.pinned_sha = startCommit;
    return state;
}
function createSession(config, paths, taskStr) {
    const today = formatLocalDateKey(new Date());
    const hash = crypto.randomBytes(4).toString('hex');
    const sessionId = `${today}-${hash}`;
    const fullSessionPath = path.join(paths.sessionsRoot, sessionId);
    if (!fs.existsSync(fullSessionPath))
        fs.mkdirSync(fullSessionPath, { recursive: true });
    const inTreeSessionDir = path.join(process.cwd(), '.pickle-rick', 'sessions', sessionId);
    if (!fs.existsSync(inTreeSessionDir))
        fs.mkdirSync(inTreeSessionDir, { recursive: true });
    const inTreeNotesPath = path.join(inTreeSessionDir, 'TASK_NOTES.md');
    if (!fs.existsSync(inTreeNotesPath)) {
        fs.writeFileSync(inTreeNotesPath, `# TASK_NOTES\n\nSession: ${sessionId}\n\n## Progress\n\n## Dead Ends\n\n## Key Discoveries\n\n## Next\n`);
    }
    const state = createInitialState(config, fullSessionPath, taskStr);
    // eslint-disable-next-line pickle/no-raw-state-write -- initial creation: no existing state to lock against
    sm.forceWrite(path.join(fullSessionPath, 'state.json'), state);
    try {
        pruneActivity();
    }
    catch { /* must not block session start */ }
    logActivity({
        event: 'session_start',
        source: 'pickle',
        session: sessionId,
        mode: config.tmuxMode ? 'tmux' : 'inline',
        original_prompt: taskStr,
        backend: state.backend || 'claude',
    });
    if (!('max_time_minutes' in state)) {
        logActivity({
            event: 'time_cap_disabled_default',
            source: 'pickle',
            session: sessionId,
            backend: state.backend || 'claude',
        });
    }
    if (!config.pausedMode) {
        try {
            const holder = probeConcurrentGitAccess(process.cwd());
            if (holder) {
                process.stderr.write(`[pickle] WARNING: concurrent git access detected — pid=${holder.pid} command=${holder.command}\n`);
                logActivity({
                    event: 'concurrent_git_access_detected',
                    source: 'pickle',
                    session: sessionId,
                    gate_payload: {
                        repo_root: process.cwd(),
                        holder_pid: holder.pid,
                        holder_command: holder.command,
                    },
                });
            }
        }
        catch { /* advisory — never block launch */ }
    }
    return { sessionRoot: fullSessionPath, state };
}
function printActivationPanel(paths, config, fullSessionPath, currentIteration) {
    printMinimalPanel('Pickle Rick Activated!', {
        Iteration: currentIteration,
        Limit: config.loopLimit > 0 ? config.loopLimit : '∞',
        'Max Time': config.timeLimit > 0 ? `${config.timeLimit}m` : '∞',
        'Worker TO': `${config.workerTimeout}s`,
        Promise: config.promiseToken || 'None',
        ...(config.minIterations > 0 ? { 'Min Passes': config.minIterations } : {}),
        ...(config.commandTemplate ? { Template: config.commandTemplate } : {}),
        ...(config.chainMeeseeks ? { 'Chain Meeseeks': 'Yes' } : {}),
        Backend: config.backend || 'claude',
        ...(config.effort ? { Effort: config.effort } : {}),
        ...(config.teamsMode ? { Teams: `Yes (parallel: ${config.maxParallel})` } : {}),
        Extension: paths.rootDir,
        Data: paths.dataDir,
        Path: fullSessionPath,
    }, 'GREEN', '🥒');
}
export function parseArguments(argv) {
    const paths = buildSetupPaths();
    const config = createSetupConfig();
    loadSettings(config, paths.rootDir);
    parseCommandLine(config, argv);
    validateCommandLine(config);
    applyPerBackendBudget(config);
    return config;
}
export function handleResumeSession(args) {
    const session = resumeSession(args);
    return { sessionRoot: session.sessionRoot, state: session.state };
}
/**
 * R-PNTR-4: the in-session (non-tmux) `/pickle` build loop is removed. It ran the
 * lifecycle INSIDE the parent claude session (stop-hook driven, no true `/clear`
 * between iterations) and degraded on long epics. A NEW build session MUST run
 * under tmux (`/pickle-tmux`, true per-iteration isolation). `--paused` prep
 * sessions (pickle-prd / pickle-refine-prd / portal-gun) and `--resume` are exempt
 * — they are inactive or re-enter an existing session, not a fresh in-session loop.
 * In-session Teams Mode (`/pickle --teams`) migrates to `/pickle-tmux --teams`.
 */
function assertTmuxBuildLoopRequired(config) {
    if (config.tmuxMode || config.pausedMode)
        return;
    if (config.teamsMode) {
        die('/pickle --teams (in-session Teams Mode) was removed. ' +
            'Use /pickle-tmux --teams to run Teams Mode under tmux (morty-phase-* subagents preserved).');
    }
    die('The in-session /pickle build loop was removed (no /clear between iterations). ' +
        'Use /pickle-tmux <args> for the build loop, /pickle-refine-prd for refinement, ' +
        'or /pickle-pipeline for the full pipeline.');
}
export function initializeNewSession(args) {
    assertTmuxBuildLoopRequired(args);
    const paths = buildSetupPaths();
    ensureCoreDirectories(paths);
    const taskStr = resolveTask(args);
    const session = createSession(args, paths, taskStr);
    return { sessionRoot: session.sessionRoot, state: session.state };
}
export function displaySetupSummary(session) {
    const paths = buildSetupPaths();
    const config = createSetupConfig();
    syncConfigFromState(config, session.state);
    printActivationPanel(paths, config, session.sessionRoot, (Number(session.state.iteration) || 0) + 1);
    // Machine-readable line for reliable parsing even when ANSI codes are present
    process.stdout.write(`SESSION_ROOT=${session.sessionRoot}\n`);
    if (config.promiseToken) {
        console.log(`
${Style.YELLOW}⚠️  STRICT EXIT CONDITION ACTIVE${Style.RESET}`);
        console.log(`   You must output: <promise>${config.promiseToken}</promise>
`);
    }
}
export function scanPausedOrphans(sessionsRoot, config, smInstance) {
    let entries;
    try {
        entries = fs.readdirSync(sessionsRoot);
    }
    catch {
        return;
    }
    const cwd = process.cwd();
    const now = Date.now();
    for (const entry of entries) {
        const statePath = path.join(sessionsRoot, entry, 'state.json');
        let mtime;
        try {
            mtime = fs.statSync(statePath).mtimeMs;
        }
        catch {
            continue;
        }
        if (now - mtime <= 300_000)
            continue;
        const recovered = readRecoverableJsonObject(statePath);
        if (!recovered || typeof recovered !== 'object' || Array.isArray(recovered))
            continue;
        const state = recovered;
        if (state.active !== true)
            continue;
        if (state.pid != null)
            continue;
        if (state.working_dir !== cwd)
            continue;
        const ageSeconds = Math.floor((now - mtime) / 1000);
        process.stderr.write(`[pickle] WARNING: paused-orphan session "${entry}" (${ageSeconds}s old) has active=true for this cwd but no pid. ` +
            `Use --paused to auto-demote.\n`);
        if (config.pausedMode) {
            try {
                smInstance.read(statePath);
            }
            catch { /* demote is best-effort */ }
        }
    }
}
export function precleanPausedOrphansBeforeCreate(sessionsRoot, smInstance) {
    const cwd = process.cwd();
    const now = Date.now();
    let entries;
    try {
        entries = fs.readdirSync(sessionsRoot);
    }
    catch {
        return;
    }
    for (const entry of entries) {
        const sessionDir = path.join(sessionsRoot, entry);
        const statePath = path.join(sessionDir, 'state.json');
        let mtime;
        try {
            mtime = fs.statSync(statePath).mtimeMs;
        }
        catch {
            continue;
        }
        if (now - mtime <= 300_000)
            continue;
        let raw;
        try {
            raw = readRecoverableJsonObject(statePath);
        }
        catch {
            continue;
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            continue;
        const s = raw;
        if (s.active !== true)
            continue;
        if (s.pid != null)
            continue;
        if (s.working_dir !== cwd)
            continue;
        const mtimeAgeSeconds = Math.floor((now - mtime) / 1000);
        s.active = false;
        s.exit_reason = 'orphan-paused-no-claim-precleanup';
        if (!Array.isArray(s.activity))
            s.activity = [];
        s.activity.push({
            event: 'paused_session_orphan_precleaned',
            ts: new Date().toISOString(),
            session_dir: sessionDir,
            mtime_age_seconds: mtimeAgeSeconds,
            step: 'preclean_before_create',
        });
        // eslint-disable-next-line pickle/no-raw-state-write -- orphan: active=true pid=null mtime>300s; no live process holds this session
        try {
            smInstance.forceWrite(statePath, s);
        }
        catch { /* best-effort */ }
    }
}
/**
 * C7: materialize the session-merged worker MCP config (`<sessionRoot>/mcp/worker-mcp.json`)
 * once at setup. Merges the operator's MCP server entries with an absolute-command
 * `codegraph serve --mcp` entry (watcher OFF → C4 runtime sync is the sole DB writer).
 * Claude-family workers only; codex workers never receive `--mcp-config`. The operator
 * config is read-only here — only the session file is written. Best-effort: the whole
 * body is wrapped so a malformed settings/operator config can never block session launch.
 */
function materializeWorkerMcpConfig(sessionRoot) {
    try {
        const settingsBag = loadPickleSettingsBag();
        const cgSettings = resolveCodegraphSettings(settingsBag);
        let operatorEntries = null;
        const operatorPath = resolveMcpConfigPath(settingsBag ?? undefined);
        if (operatorPath) {
            try {
                const parsed = JSON.parse(fs.readFileSync(operatorPath, 'utf8'));
                if (parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)) {
                    operatorEntries = parsed.mcpServers;
                }
            }
            catch { /* operator config unreadable/absent → codegraph-only config */ }
        }
        buildWorkerMcpConfig(sessionRoot, process.cwd(), {
            worker_mcp_config_path: settingsBag?.worker_mcp_config_path ?? null,
            expose_mcp_to_workers: cgSettings.expose_mcp_to_workers,
        }, operatorEntries);
    }
    catch { /* worker MCP config is best-effort — never block launch */ }
}
async function main() {
    try {
        assertSchemaVersionDeployParity();
    }
    catch (err) {
        if (err instanceof SchemaVersionDeployDriftError) {
            process.stderr.write(`${safeErrorMessage(err)}\n`);
            process.exit(1);
        }
        throw err;
    }
    const paths = buildSetupPaths();
    ensureCoreDirectories(paths);
    pruneOldSessions(paths.sessionsRoot);
    const args = parseArguments(process.argv.slice(2));
    if (args.pausedMode && !args.resumeMode) {
        precleanPausedOrphansBeforeCreate(paths.sessionsRoot, sm);
    }
    scanPausedOrphans(paths.sessionsRoot, args, sm);
    const session = args.resumeMode
        ? handleResumeSession(args)
        : initializeNewSession(args);
    // AC-LPB-01: warn (don't block) when --max-time is undersized for the planned
    // ticket count. Runs after session resolution so we can read the manifest from
    // the actual session dir. Best-effort; never throws.
    try {
        evaluateLaunchSizing(session.sessionRoot, args);
    }
    catch { /* sizing is advisory */ }
    // R-MFW-4 (Option D, FR-4): setup-time MCP snapshot. Best-effort; never
    // blocks session launch. Production fetchFn is a no-op (returns null) — the
    // injectable seam exists for integration tests and future live callers.
    try {
        const settingsBag = loadPickleSettingsBag();
        const snapshotServers = Array.isArray(settingsBag?.worker_mcp_snapshot_servers)
            ? settingsBag.worker_mcp_snapshot_servers
            : [];
        await runMcpSnapshot(session.sessionRoot, snapshotServers, resolveMcpConfigPath(settingsBag ?? undefined), session.state.original_prompt || '', async () => null, args.resumeMode);
    }
    catch { /* snapshot is best-effort — never block launch */ }
    // C7: materialize the session-merged worker MCP config ONCE at setup, after the
    // snapshot seam. Best-effort — never blocks launch. The materialized path is
    // consumed at worker-spawn time via opts.mcpConfig.
    materializeWorkerMcpConfig(session.sessionRoot);
    try {
        updateSessionMap(paths.sessionsMap, process.cwd(), session.sessionRoot);
    }
    catch (err) {
        if (err instanceof LockError) {
            console.error(`[pickle] WARNING: session map not updated — ${safeErrorMessage(err)}`);
        }
        else {
            throw err;
        }
    }
    displaySetupSummary(session);
    // C4: codegraph index — post-summary so SESSION_ROOT= is already on stdout. Fail-open.
    try {
        const cgSettings = resolveCodegraphSettings(loadPickleSettingsBag());
        await runCodegraphIndexAtSetup(process.cwd(), cgSettings, args.resumeMode);
    }
    catch { /* index is best-effort — never block launch */ }
}
function resolvePath(p) {
    if (p.startsWith('~'))
        return path.join(os.homedir(), p.slice(1));
    return path.resolve(p);
}
if (process.argv[1] && path.basename(process.argv[1]) === 'setup.js') {
    main().catch((err) => die(safeErrorMessage(err)));
}

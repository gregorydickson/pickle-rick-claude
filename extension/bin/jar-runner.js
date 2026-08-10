#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { printMinimalPanel, Style, getExtensionRoot, getDataRoot, writeStateFile, safeErrorMessage, composeManagerPromptFromSkill, resolveCommandTemplate } from '../services/pickle-utils.js';
import { StateManager, safeDeactivate, finalizeTerminalState, recordExitReason } from '../services/state-manager.js';
import { Defaults } from '../types/index.js';
import { logActivity } from '../services/activity-logger.js';
import { buildManagerInvocation, resolveBackend, backendEnvOverrides } from '../services/backend-spawn.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';
const sm = new StateManager();
// Tracks the currently-running task's session dir and subprocess so signal
// handlers can deactivate it and kill the child on shutdown.
let activeTaskSessionDir = null;
let activeTaskProc = null;
function positiveIntegerOrNull(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
export function loadJarTaskTimeout(extensionRoot, state) {
    // Use worker_timeout_seconds from state if set, else fall back to settings, else default
    const stateTimeout = positiveIntegerOrNull(state.worker_timeout_seconds);
    if (stateTimeout !== null)
        return stateTimeout;
    try {
        const settings = readRecoverableJsonObject(path.join(extensionRoot, 'pickle_settings.json'));
        const settingsTimeout = positiveIntegerOrNull(settings?.default_worker_timeout_seconds);
        if (settingsTimeout !== null)
            return settingsTimeout;
    }
    catch { /* use default */ }
    return Defaults.WORKER_TIMEOUT_SECONDS;
}
/**
 * Best-effort synchronous load of a task's state.json for peek-ahead lookups
 * (e.g. "what backend would the next queued task use?"). Returns null if the
 * file is missing or unreadable; callers fall through to resolveBackend's
 * standard fallback chain.
 */
function readTaskState(sessionDir) {
    try {
        return sm.read(path.join(sessionDir, 'state.json'));
    }
    catch {
        return null;
    }
}
const metaPaths = new WeakMap();
const metaTaskIds = new WeakMap();
const metaSessionDirs = new WeakMap();
function registerTaskMeta(meta, metaPath, taskId) {
    metaPaths.set(meta, metaPath);
    metaTaskIds.set(meta, taskId);
    return meta;
}
function taskIdForMeta(meta) {
    return typeof meta.task_id === 'string' ? meta.task_id : metaTaskIds.get(meta) ?? null;
}
async function runTask(sessionDir, repoCwd, extensionRoot) {
    const statePath = path.join(sessionDir, 'state.json');
    let state;
    try {
        state = sm.read(statePath);
    }
    catch (err) {
        const msg = safeErrorMessage(err);
        throw new Error(`Failed to read state.json for ${path.basename(sessionDir)}: ${msg}`);
    }
    state = sm.update(statePath, s => {
        s.active = true;
        s.pid = process.pid;
        s.completion_promise = null;
    });
    activeTaskSessionDir = sessionDir;
    const taskTimeout = loadJarTaskTimeout(extensionRoot, state);
    const templateName = resolveCommandTemplate(state.command_template);
    const templatesDir = path.join(extensionRoot, 'templates');
    const commandsDir = path.join(os.homedir(), '.claude/commands');
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    const picklePromptPath = fs.existsSync(path.join(templatesDir, templateName))
        ? path.join(templatesDir, templateName)
        : path.join(commandsDir, templateName);
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    if (!fs.existsSync(picklePromptPath)) {
        process.stderr.write(`jar-runner: ${templateName} not found in ${templatesDir} or ${commandsDir}. Run install.sh first.\n`);
        process.exit(1);
    }
    const settingsPath = path.join(extensionRoot, 'pickle_settings.json');
    let managerMaxTurns = Defaults.MANAGER_MAX_TURNS;
    try {
        const settings = readRecoverableJsonObject(settingsPath);
        const settingsMaxTurns = positiveIntegerOrNull(settings?.default_manager_max_turns);
        if (settingsMaxTurns !== null)
            managerMaxTurns = settingsMaxTurns;
    }
    catch { /* ignore */ }
    // Resolve the backend from THIS task's session state — jar batches are
    // heterogeneous: each task carries its own backend (claude or codex) stored
    // at jar-time. Resolving from the already-parsed state object avoids a second
    // disk read + JSON.parse of the same file (the separate read could race a
    // concurrent rewrite and silently default to 'claude' on parse failure, even
    // when the first parse above succeeded).
    const backend = resolveBackend(state);
    const prompt = composeManagerPromptFromSkill(picklePromptPath, backend, {
        argumentSubstitution: `--resume ${sessionDir}`,
    });
    printMinimalPanel(`Running Jarred Task`, {
        Session: path.basename(sessionDir),
        Repo: repoCwd,
        Backend: backend,
        MaxTurns: managerMaxTurns,
        Timeout: `${taskTimeout}s`,
    }, 'MAGENTA', '🥒');
    const invocation = buildManagerInvocation(backend, {
        prompt,
        addDirs: [extensionRoot, getDataRoot(), sessionDir],
        maxTurns: managerMaxTurns,
        noSessionPersistence: true,
    });
    const env = {
        ...process.env,
        ...backendEnvOverrides(backend),
        ...(invocation.env ?? {}),
        PICKLE_STATE_FILE: statePath,
        PYTHONUNBUFFERED: '1',
    };
    delete env['CLAUDECODE'];
    delete env['PICKLE_ROLE'];
    return new Promise((resolve) => {
        let settled = false;
        const proc = spawn(invocation.cmd, invocation.args, { cwd: repoCwd, env, stdio: 'inherit' });
        activeTaskProc = proc;
        // Per-task timeout: SIGTERM first, escalate to SIGKILL after 2s
        let killEscalation = null;
        const timeoutHandle = setTimeout(() => {
            console.error(`\n${Style.YELLOW}⚠️  Jar task timed out after ${taskTimeout}s — killing${Style.RESET}`);
            try {
                proc.kill('SIGTERM');
            }
            catch { /* already dead */ }
            killEscalation = setTimeout(() => {
                try {
                    proc.kill('SIGKILL');
                }
                catch { /* already dead */ }
            }, 2000);
        }, taskTimeout * 1000);
        // Hang guard: force-resolve if process doesn't exit within timeout + 30s
        const hangGuard = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            activeTaskSessionDir = null;
            activeTaskProc = null;
            console.error(`${Style.RED}❌ Jar task hang detected — forcing failure${Style.RESET}`);
            resolve({ ok: false, backend });
        }, (taskTimeout + 30) * 1000);
        hangGuard.unref();
        proc.on('close', (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeoutHandle);
            if (killEscalation)
                clearTimeout(killEscalation);
            clearTimeout(hangGuard);
            activeTaskSessionDir = null;
            activeTaskProc = null;
            resolve({ ok: code === 0, backend });
        });
        proc.on('error', (err) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeoutHandle);
            if (killEscalation)
                clearTimeout(killEscalation);
            clearTimeout(hangGuard);
            activeTaskSessionDir = null;
            activeTaskProc = null;
            const errCode = err?.code;
            if (errCode === 'ENOENT') {
                // Infrastructure error — the backend CLI is not installed. Do NOT
                // permanently fail the task: leave its status untouched so a future
                // jar-open run succeeds once the CLI is installed. Print a clear
                // install hint routed to the backend that was attempted.
                const hint = backend === 'codex'
                    ? `codex CLI not found on PATH — install codex and re-run /pickle-jar-open, or re-jar these tasks with --backend claude`
                    : `claude CLI not found on PATH — install claude and re-run /pickle-jar-open`;
                console.error(`${Style.RED}${hint}${Style.RESET}`);
                resolve({ ok: false, enoent: true, backend });
                return;
            }
            console.error(`${Style.RED}Failed to spawn '${invocation.cmd}' (backend=${backend}): ${safeErrorMessage(err)}${Style.RESET}`);
            resolve({ ok: false, backend });
        });
    });
}
export function discoverMarinatingTasks(jarRoot) {
    const tasks = [];
    for (const day of fs.readdirSync(jarRoot).sort()) {
        const dayPath = path.join(jarRoot, day);
        let dayIsDir;
        try {
            dayIsDir = fs.lstatSync(dayPath).isDirectory();
        }
        catch {
            continue;
        }
        if (!dayIsDir)
            continue;
        for (const taskId of fs.readdirSync(dayPath).sort()) {
            const metaPath = path.join(dayPath, taskId, 'meta.json');
            let meta;
            try {
                // AP-EXT-ITER16-01: no `existsSync` pre-gate. meta.json is written
                // tmp-rename (jar-utils.ts addToJar, writeTaskMeta), so a crash in that
                // window leaves only `meta.json.tmp.<pid>` — the recovering read below is
                // what promotes it. Absence is decided AFTER that read: a task dir that
                // never had a meta.json stays a quiet skip, a present-but-unparseable one
                // still reports.
                const recoveredMeta = readRecoverableJsonObject(metaPath);
                if (!recoveredMeta) {
                    if (!fs.existsSync(metaPath))
                        continue;
                    throw new Error('meta.json is corrupt or unreadable');
                }
                meta = recoveredMeta;
            }
            catch {
                console.error(`${Style.RED}⚠️  Skipping ${taskId}: meta.json is corrupt or unreadable${Style.RESET}`);
                continue;
            }
            if (meta.status === 'marinating')
                tasks.push({ taskId, metaPath, meta: registerTaskMeta(meta, metaPath, taskId) });
        }
    }
    return tasks;
}
function writeTaskMeta(meta) {
    const metaPath = metaPaths.get(meta);
    if (metaPath)
        writeStateFile(metaPath, meta);
}
export function skipTaskWithReason(meta, reason) {
    meta.status = 'failed';
    meta.failed_reason = reason;
    writeTaskMeta(meta);
}
function markTaskConsumed(meta) {
    meta['status'] = 'consumed';
    writeTaskMeta(meta);
}
export function validateTaskIntegrity(taskDir, meta) {
    if (typeof meta.prd_hash !== 'string' || meta.prd_hash.length === 0) {
        return { kind: 'ok' };
    }
    const rawPrdRel = typeof meta.prd_path === 'string' ? meta.prd_path : 'prd.md';
    const prdPath = path.resolve(taskDir, rawPrdRel);
    if (!prdPath.startsWith(taskDir + path.sep) && prdPath !== taskDir) {
        return { kind: 'fail', reason: 'path-traversal' };
    }
    try {
        const prdContent = fs.readFileSync(prdPath, 'utf-8');
        const currentHash = crypto.createHash('sha256').update(prdContent).digest('hex');
        if (currentHash === meta.prd_hash)
            return { kind: 'ok' };
    }
    catch {
        return { kind: 'fail', reason: 'missing-file' };
    }
    return { kind: 'fail', reason: 'hash-mismatch' };
}
function verifyJarredPrd(task) {
    const result = validateTaskIntegrity(path.dirname(task.metaPath), task.meta);
    if (result.kind === 'ok')
        return true;
    const messages = {
        'path-traversal': `${Style.RED}⚠️  Skipping ${task.taskId}: prd_path escapes task directory${Style.RESET}`,
        'missing-file': `${Style.RED}⚠️  Skipping ${task.taskId}: cannot read jarred PRD for integrity check${Style.RESET}`,
        'hash-mismatch': `${Style.RED}⚠️  Skipping ${task.taskId}: PRD integrity check failed (content modified since jarring)${Style.RESET}`,
    };
    console.error(messages[result.reason]);
    skipTaskWithReason(task.meta, result.reason);
    return false;
}
function resolveTaskExecution(task, sessionsRoot) {
    const sessionDir = path.join(sessionsRoot, task.taskId);
    metaSessionDirs.set(task.meta, sessionDir);
    if (!fs.existsSync(sessionDir)) {
        console.error(`${Style.RED}⚠️  Session dir not found for ${task.taskId}${Style.RESET}`);
        skipTaskWithReason(task.meta, 'missing-session');
        return null;
    }
    if (typeof task.meta.repo_path !== 'string') {
        console.error(`${Style.RED}⚠️  Skipping ${task.taskId}: meta.repo_path is missing or not a string${Style.RESET}`);
        skipTaskWithReason(task.meta, 'missing-repo-path');
        return null;
    }
    if (!verifyJarredPrd(task)) {
        return null;
    }
    return { sessionDir, repoPath: task.meta.repo_path };
}
function deactivateTaskSession(sessionDir) {
    try {
        const taskStatePath = path.join(sessionDir, 'state.json');
        sm.update(taskStatePath, s => { s.active = false; });
    }
    catch { /* best-effort */ }
}
/**
 * Terminal-success finalize for jar tasks: marks step='completed', clears
 * current_ticket, stamps exit_reason. Use only when the task ran to a clean
 * end (`result.ok === true`); use `deactivateTaskSession` for failed/aborted
 * tasks so step/ticket forensics survive.
 */
function finalizeTaskSession(sessionDir, exitReason) {
    try {
        const taskStatePath = path.join(sessionDir, 'state.json');
        finalizeTerminalState(taskStatePath, { step: 'completed', exitReason });
    }
    catch { /* best-effort */ }
}
function countRemainingQueuedBackendTasks(tasks, currentIndex, sessionsRoot, backend) {
    let count = 0;
    for (const task of tasks.slice(currentIndex + 1)) {
        if (task.meta.status !== 'marinating')
            continue;
        const taskState = readTaskState(path.join(sessionsRoot, task.taskId));
        if (resolveBackend(taskState) === backend)
            count++;
    }
    return count;
}
export function handleTaskEnoent(result, tasks, currentTaskId, sessionsRoot) {
    if (!result.enoent || result.backend !== 'codex')
        return { skippedTasks: [] };
    const currentIndex = tasks.findIndex(meta => taskIdForMeta(meta) === currentTaskId);
    if (currentIndex < 0)
        return { skippedTasks: [] };
    const skippedTasks = [];
    for (const meta of tasks.slice(currentIndex + 1)) {
        if (meta.status !== 'marinating')
            continue;
        const taskId = taskIdForMeta(meta);
        if (!taskId)
            continue;
        const metaBackend = resolveBackend(meta);
        if (metaBackend === result.backend) {
            skippedTasks.push(taskId);
            continue;
        }
        if (!sessionsRoot)
            continue;
        const taskState = readTaskState(path.join(sessionsRoot, taskId));
        if (resolveBackend(taskState) === result.backend) {
            skippedTasks.push(taskId);
        }
    }
    return { skippedTasks };
}
function installShutdownHandlers() {
    const handleShutdownSignal = (signal) => {
        console.error(`\n${Style.YELLOW}⚠️  Received ${signal} — deactivating current task session${Style.RESET}`);
        if (activeTaskSessionDir) {
            const sp = path.join(activeTaskSessionDir, 'state.json');
            recordExitReason(sp, 'signal');
            safeDeactivate(sp);
        }
        if (activeTaskProc && !activeTaskProc.killed) {
            activeTaskProc.kill('SIGTERM');
        }
        process.exit(0);
    };
    process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
    process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
    process.on('SIGHUP', () => handleShutdownSignal('SIGHUP'));
}
async function processJarTask(task, currentIndex, tasks, sessionsRoot, extensionRoot) {
    const execution = resolveTaskExecution(task, sessionsRoot);
    if (!execution) {
        return { succeededDelta: 0, failedDelta: 1, stop: false };
    }
    let result;
    try {
        result = await runTask(execution.sessionDir, execution.repoPath, extensionRoot);
    }
    catch (err) {
        const msg = safeErrorMessage(err);
        console.error(`${Style.RED}⚠️  runTask error for ${task.taskId}: ${msg}${Style.RESET}`);
        result = { ok: false, backend: 'claude' };
    }
    if (result.enoent) {
        // Backend CLI missing — preserve task state for future retry. Forensic
        // path: record reason without finalizing step/current_ticket.
        recordExitReason(path.join(execution.sessionDir, 'state.json'), 'enoent');
        deactivateTaskSession(execution.sessionDir);
        console.log(`\n${Style.YELLOW}⏸️  Task ${task.taskId} skipped (backend ${result.backend} CLI missing) — status left as '${task.meta.status}' for future retry${Style.RESET}`);
        const { skippedTasks } = handleTaskEnoent(result, tasks.map(item => item.meta), task.taskId, sessionsRoot);
        const skipped = result.backend === 'codex'
            ? skippedTasks.length || countRemainingQueuedBackendTasks(tasks, currentIndex, sessionsRoot, result.backend)
            : 0;
        if (skipped > 0) {
            console.log(`${Style.YELLOW}⏸️  ${skipped} additional codex task(s) remain queued — install codex CLI and re-run /pickle-jar-open${Style.RESET}`);
            return { succeededDelta: 0, failedDelta: 0, stop: true };
        }
        return { succeededDelta: 0, failedDelta: 0, stop: false };
    }
    if (result.ok) {
        finalizeTaskSession(execution.sessionDir, 'success');
        markTaskConsumed(task.meta);
        console.log(`\n${Style.GREEN}✅ Task ${task.taskId} complete${Style.RESET}`);
        return { succeededDelta: 1, failedDelta: 0, stop: false };
    }
    // Failed task: forensic path — preserve step/current_ticket for postmortem.
    recordExitReason(path.join(execution.sessionDir, 'state.json'), 'task_failed');
    deactivateTaskSession(execution.sessionDir);
    skipTaskWithReason(task.meta, 'task-failed');
    console.log(`\n${Style.RED}❌ Task ${task.taskId} failed${Style.RESET}`);
    return { succeededDelta: 0, failedDelta: 1, stop: false };
}
async function main() {
    const ROOT_DIR = getExtensionRoot();
    const DATA_DIR = getDataRoot();
    const JAR_ROOT = path.join(DATA_DIR, 'jar');
    const SESSIONS_ROOT = path.join(DATA_DIR, 'sessions');
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    if (!fs.existsSync(JAR_ROOT)) {
        console.log('🥒 Pickle Jar is empty. No tasks to run.');
        console.log('Signal: Jar Complete');
        return;
    }
    const tasks = discoverMarinatingTasks(JAR_ROOT);
    if (tasks.length === 0) {
        console.log('🥒 No marinating tasks in the Jar.');
        console.log('Signal: Jar Complete');
        return;
    }
    installShutdownHandlers();
    console.log(`\n🥒 Pickle Jar Night Shift — ${tasks.length} task(s) queued\n`);
    logActivity({ event: 'jar_start', source: 'pickle' });
    let succeeded = 0;
    let failed = 0;
    for (const [index, task] of tasks.entries()) {
        const outcome = await processJarTask(task, index, tasks, SESSIONS_ROOT, ROOT_DIR);
        succeeded += outcome.succeededDelta;
        failed += outcome.failedDelta;
        if (outcome.stop)
            break;
    }
    console.log(`\n🥒 Jar complete. ${succeeded} succeeded, ${failed} failed.`);
    logActivity({ event: 'jar_end', source: 'pickle' });
    console.log('Signal: Jar Complete');
}
export function buildJarNotification(succeeded, failed) {
    const allFailed = succeeded === 0 && failed > 0;
    const title = allFailed ? '🥒 Pickle Jar Failed' : '🥒 Pickle Run Complete';
    const subtitle = 'Pickle Jar';
    const body = failed > 0
        ? `${succeeded} succeeded, ${failed} failed`
        : `${succeeded} task${succeeded === 1 ? '' : 's'} completed`;
    return { title, subtitle, body };
}
if (process.argv[1] && path.basename(process.argv[1]) === 'jar-runner.js') {
    main().catch((err) => {
        const msg = safeErrorMessage(err);
        console.error(`${Style.RED}Error: ${msg}${Style.RESET}`);
        process.exit(1);
    });
}

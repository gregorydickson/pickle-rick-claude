#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { printMinimalPanel, Style, getExtensionRoot, getDataRoot, writeStateFile, safeErrorMessage, composeManagerPromptFromSkill, resolveCommandTemplate } from '../services/pickle-utils.js';
import { StateManager, safeDeactivate, finalizeTerminalState, recordExitReason } from '../services/state-manager.js';
import { State, Defaults, type Backend } from '../types/index.js';
import { logActivity } from '../services/activity-logger.js';
import { buildManagerInvocation, resolveBackend, backendEnvOverrides, type SpawnInvocation } from '../services/backend-spawn.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';
import { killProcessGroup } from '../services/orphan-reaper.js';

const sm = new StateManager();

// Tracks the currently-running task's session dir and subprocess so signal
// handlers can deactivate it and kill the child on shutdown.
let activeTaskSessionDir: string | null = null;
let activeTaskProc: import('child_process').ChildProcess | null = null;
// R-OMTD (jar arm): whether the live manager child LEADS its own process group,
// so both teardown paths know a negative-PID group signal is available.
let activeTaskLeadsGroup = false;

/**
 * R-OMTD (jar arm): terminate the manager child AND everything it spawned.
 *
 * The jar manager (`claude`/`codex`) is the ROOT of a subtree — it spawns
 * mux-runner, which spawns per-ticket workers. A bare `proc.kill()` signals the
 * manager pid alone, so that subtree re-parents to PID 1 and outlives the batch:
 * an unattended Night Shift run keeps burning backend budget and keeps mutating
 * the task's repo after the runner has declared the task failed and moved on to
 * the NEXT task. The group signal is what severs the orphan; `detached:true` on
 * the spawn is what makes the group OURS to signal (without it the child shares
 * jar-runner's own group and a negative-PID kill would take down the runner).
 * Falls back to a direct kill for non-detached children or when the group signal
 * fails (group already gone).
 */
function reapTaskSubtree(
  proc: Pick<import('child_process').ChildProcess, 'pid' | 'kill'>,
  leadsGroup: boolean,
  signal: NodeJS.Signals,
): void {
  // AC-CXHANG-3: the negative-PID group kill is the SHARED primitive
  // (services/orphan-reaper.ts killProcessGroup) — never re-inlined here.
  if (leadsGroup && typeof proc.pid === 'number' && killProcessGroup(proc.pid, signal)) return;
  try {
    proc.kill(signal);
  } catch { /* already dead */ }
}

function positiveIntegerOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function loadJarTaskTimeout(extensionRoot: string, state: State): number {
  // Use worker_timeout_seconds from state if set, else fall back to settings, else default
  const stateTimeout = positiveIntegerOrNull(state.worker_timeout_seconds);
  if (stateTimeout !== null) return stateTimeout;

  try {
    const settings = readRecoverableJsonObject(path.join(extensionRoot, 'pickle_settings.json')) as Record<string, unknown> | null;
    const settingsTimeout = positiveIntegerOrNull(settings?.default_worker_timeout_seconds);
    if (settingsTimeout !== null) return settingsTimeout;
  } catch { /* use default */ }

  return Defaults.WORKER_TIMEOUT_SECONDS;
}

/**
 * Best-effort synchronous load of a task's state.json for peek-ahead lookups
 * (e.g. "what backend would the next queued task use?"). Returns null if the
 * file is missing or unreadable; callers fall through to resolveBackend's
 * standard fallback chain.
 */
function readTaskState(sessionDir: string): State | null {
  try {
    return sm.read(path.join(sessionDir, 'state.json'));
  } catch {
    return null;
  }
}

export interface RunTaskResult {
  ok: boolean;
  /**
   * True iff the manager CLI (`claude` or `codex`) was not found on PATH. The
   * task's status should remain untouched so a future jar-open run succeeds
   * once the CLI is installed.
   */
  enoent?: boolean;
  /** Backend that was attempted — used by the caller to short-circuit further codex tasks after an ENOENT. */
  backend: Backend;
}

export type SpawnResult = RunTaskResult;

export type IntegrityResult =
  | { kind: 'ok' }
  | { kind: 'fail'; reason: 'hash-mismatch' | 'path-traversal' | 'missing-file' };

export interface TaskMeta extends Record<string, unknown> {
  status?: unknown;
  repo_path?: unknown;
  prd_path?: unknown;
  prd_hash?: unknown;
  task_id?: unknown;
  backend?: unknown;
  failed_reason?: unknown;
}

interface JarTask {
  taskId: string;
  metaPath: string;
  meta: TaskMeta;
}

const metaPaths = new WeakMap<TaskMeta, string>();
const metaTaskIds = new WeakMap<TaskMeta, string>();
const metaSessionDirs = new WeakMap<TaskMeta, string>();

function registerTaskMeta(meta: TaskMeta, metaPath: string, taskId: string): TaskMeta {
  metaPaths.set(meta, metaPath);
  metaTaskIds.set(meta, taskId);
  return meta;
}

function taskIdForMeta(meta: TaskMeta): string | null {
  return typeof meta.task_id === 'string' ? meta.task_id : metaTaskIds.get(meta) ?? null;
}

/**
 * Everything a jar task needs to launch its manager subprocess, resolved from
 * that task's own session state. Bundled so the launch decision (which backend,
 * which prompt, how long before the kill escalation) is made once, in one place,
 * and the spawn/settle half consumes a value instead of re-deriving it.
 */
interface JarManagerLaunch {
  invocation: SpawnInvocation;
  env: NodeJS.ProcessEnv;
  backend: Backend;
  taskTimeoutSeconds: number;
}

/**
 * Claim the task: mark its session live and record it as the batch's active
 * task so the shutdown handlers can deactivate it and reap its subtree.
 */
function activateJarTaskSession(sessionDir: string, statePath: string): State {
  // Read first, purely to attribute an unreadable state.json to THIS task's
  // session dir — sm.update would throw the same failure without the name.
  try {
    sm.read(statePath);
  } catch (err) {
    const msg = safeErrorMessage(err);
    throw new Error(`Failed to read state.json for ${path.basename(sessionDir)}: ${msg}`);
  }
  const state = sm.update(statePath, s => {
    s.active = true;
    s.pid = process.pid;
    s.completion_promise = null;
  });
  activeTaskSessionDir = sessionDir;
  return state;
}

/**
 * Locate the manager prompt template, preferring the deployed extension's own
 * copy over `~/.claude/commands`. Exits non-zero when neither carries it — a
 * missing template means install.sh never ran, which no retry can fix.
 */
function resolveJarPromptPath(extensionRoot: string, templateName: string): string {
  const templatesDir = path.join(extensionRoot, 'templates');
  const commandsDir = path.join(os.homedir(), '.claude/commands');
  const bundled = path.join(templatesDir, templateName);
  const promptPath = fs.existsSync(bundled) ? bundled : path.join(commandsDir, templateName);
  if (!fs.existsSync(promptPath)) {
    process.stderr.write(`jar-runner: ${templateName} not found in ${templatesDir} or ${commandsDir}. Run install.sh first.\n`);
    process.exit(1);
  }
  return promptPath;
}

function resolveJarManagerMaxTurns(extensionRoot: string): number {
  try {
    const settings = readRecoverableJsonObject(path.join(extensionRoot, 'pickle_settings.json')) as Record<string, unknown> | null;
    return positiveIntegerOrNull(settings?.default_manager_max_turns) ?? Defaults.MANAGER_MAX_TURNS;
  } catch {
    return Defaults.MANAGER_MAX_TURNS;
  }
}

/**
 * Resolve the launch plan for one jar task and announce it on the panel.
 *
 * The backend comes from THIS task's already-parsed state — jar batches are
 * heterogeneous: each task carries its own backend (claude or codex) stored at
 * jar-time. Reading it off the parsed object avoids a second disk read + parse
 * of the same file, whose race against a concurrent rewrite would silently
 * default to 'claude' even though the first parse succeeded.
 */
function buildJarManagerLaunch(sessionDir: string, repoCwd: string, extensionRoot: string, state: State): JarManagerLaunch {
  const taskTimeoutSeconds = loadJarTaskTimeout(extensionRoot, state);
  const promptPath = resolveJarPromptPath(extensionRoot, resolveCommandTemplate(state.command_template));
  const managerMaxTurns = resolveJarManagerMaxTurns(extensionRoot);
  const backend = resolveBackend(state);
  const prompt = composeManagerPromptFromSkill(promptPath, backend, {
    argumentSubstitution: `--resume ${sessionDir}`,
  });

  printMinimalPanel(`Running Jarred Task`, {
    Session: path.basename(sessionDir),
    Repo: repoCwd,
    Backend: backend,
    MaxTurns: managerMaxTurns,
    Timeout: `${taskTimeoutSeconds}s`,
  }, 'MAGENTA', '🥒');

  const invocation = buildManagerInvocation(backend, {
    prompt,
    addDirs: [extensionRoot, getDataRoot(), sessionDir],
    maxTurns: managerMaxTurns,
    noSessionPersistence: true,
  });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...backendEnvOverrides(backend),
    ...(invocation.env ?? {}),
    PICKLE_STATE_FILE: path.join(sessionDir, 'state.json'),
    PYTHONUNBUFFERED: '1',
  };
  delete env['CLAUDECODE'];
  delete env['PICKLE_ROLE'];

  return { invocation, env, backend, taskTimeoutSeconds };
}

/**
 * Spawn the task's manager and resolve once its fate is known: clean exit,
 * per-task timeout, spawn error, or the hang guard.
 *
 * Every outcome shares one settle path (`settle`) — first caller wins, timers
 * die, the batch-active handles clear. Three hand-copied cleanup blocks is how
 * the fourth outcome leaks a timer.
 */
function awaitJarManagerExit(launch: JarManagerLaunch, repoCwd: string): Promise<RunTaskResult> {
  const { invocation, env, backend, taskTimeoutSeconds } = launch;
  return new Promise((resolve) => {
    // R-OMTD (jar arm): spawn the manager in its OWN process group so both the
    // per-task timeout and the shutdown handler can reap the whole subtree.
    const leadsGroup = process.platform !== 'win32';
    const proc = spawn(invocation.cmd, invocation.args, { cwd: repoCwd, env, stdio: 'inherit', detached: leadsGroup });
    activeTaskProc = proc;
    activeTaskLeadsGroup = leadsGroup;

    // Per-task timeout: SIGTERM first, escalate to SIGKILL after 2s — both to the
    // whole group, or the manager's workers survive the batch.
    let killEscalation: ReturnType<typeof setTimeout> | null = null;
    const timeoutHandle = setTimeout(() => {
      console.error(`\n${Style.YELLOW}⚠️  Jar task timed out after ${taskTimeoutSeconds}s — killing${Style.RESET}`);
      reapTaskSubtree(proc, leadsGroup, 'SIGTERM');
      killEscalation = setTimeout(() => {
        reapTaskSubtree(proc, leadsGroup, 'SIGKILL');
      }, 2000);
    }, taskTimeoutSeconds * 1000);

    // Hang guard: force-resolve if process doesn't exit within timeout + 30s
    const hangGuard = setTimeout(() => settle({ ok: false, backend }, `${Style.RED}❌ Jar task hang detected — forcing failure${Style.RESET}`), (taskTimeoutSeconds + 30) * 1000);
    hangGuard.unref();

    let settled = false;
    function settle(result: RunTaskResult, message?: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      if (killEscalation) clearTimeout(killEscalation);
      clearTimeout(hangGuard);
      activeTaskSessionDir = null;
      activeTaskProc = null;
      activeTaskLeadsGroup = false;
      if (message) console.error(message);
      resolve(result);
    }

    proc.on('close', (code) => settle({ ok: code === 0, backend }));
    proc.on('error', (err) => {
      const errCode = (err as NodeJS.ErrnoException | undefined)?.code;
      if (errCode === 'ENOENT') {
        // Infrastructure error — the backend CLI is not installed. Do NOT
        // permanently fail the task: leave its status untouched so a future
        // jar-open run succeeds once the CLI is installed. Print a clear
        // install hint routed to the backend that was attempted.
        const hint = backend === 'codex'
          ? `codex CLI not found on PATH — install codex and re-run /pickle-jar-open, or re-jar these tasks with --backend claude`
          : `claude CLI not found on PATH — install claude and re-run /pickle-jar-open`;
        settle({ ok: false, enoent: true, backend }, `${Style.RED}${hint}${Style.RESET}`);
        return;
      }
      settle({ ok: false, backend }, `${Style.RED}Failed to spawn '${invocation.cmd}' (backend=${backend}): ${safeErrorMessage(err)}${Style.RESET}`);
    });
  });
}

async function runTask(sessionDir: string, repoCwd: string, extensionRoot: string): Promise<RunTaskResult> {
  const state = activateJarTaskSession(sessionDir, path.join(sessionDir, 'state.json'));
  return awaitJarManagerExit(buildJarManagerLaunch(sessionDir, repoCwd, extensionRoot, state), repoCwd);
}

export function discoverMarinatingTasks(jarRoot: string): JarTask[] {
  const tasks: JarTask[] = [];

  for (const day of fs.readdirSync(jarRoot).sort()) {
    const dayPath = path.join(jarRoot, day);
    let dayIsDir: boolean;
    try {
      dayIsDir = fs.lstatSync(dayPath).isDirectory();
    } catch {
      continue;
    }
    if (!dayIsDir) continue;

    for (const taskId of fs.readdirSync(dayPath).sort()) {
      const metaPath = path.join(dayPath, taskId, 'meta.json');

      let meta: TaskMeta;
      try {
        // AP-EXT-ITER16-01: no `existsSync` pre-gate. meta.json is written
        // tmp-rename (jar-utils.ts addToJar, writeTaskMeta), so a crash in that
        // window leaves only `meta.json.tmp.<pid>` — the recovering read below is
        // what promotes it. Absence is decided AFTER that read: a task dir that
        // never had a meta.json stays a quiet skip, a present-but-unparseable one
        // still reports.
        const recoveredMeta = readRecoverableJsonObject(metaPath);
        if (!recoveredMeta) {
          if (!fs.existsSync(metaPath)) continue;
          throw new Error('meta.json is corrupt or unreadable');
        }
        meta = recoveredMeta as TaskMeta;
      } catch {
        console.error(`${Style.RED}⚠️  Skipping ${taskId}: meta.json is corrupt or unreadable${Style.RESET}`);
        continue;
      }
      if (meta.status === 'marinating') tasks.push({ taskId, metaPath, meta: registerTaskMeta(meta, metaPath, taskId) });
    }
  }

  return tasks;
}

function writeTaskMeta(meta: TaskMeta): void {
  const metaPath = metaPaths.get(meta);
  if (metaPath) writeStateFile(metaPath, meta);
}

export function skipTaskWithReason(meta: TaskMeta, reason: string): void {
  meta.status = 'failed';
  meta.failed_reason = reason;
  writeTaskMeta(meta);
}

function markTaskConsumed(meta: TaskMeta): void {
  meta['status'] = 'consumed';
  writeTaskMeta(meta);
}

export function validateTaskIntegrity(taskDir: string, meta: TaskMeta): IntegrityResult {
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
    if (currentHash === meta.prd_hash) return { kind: 'ok' };
  } catch {
    return { kind: 'fail', reason: 'missing-file' };
  }

  return { kind: 'fail', reason: 'hash-mismatch' };
}

function verifyJarredPrd(task: JarTask): boolean {
  const result = validateTaskIntegrity(path.dirname(task.metaPath), task.meta);
  if (result.kind === 'ok') return true;

  const messages: Record<'hash-mismatch' | 'path-traversal' | 'missing-file', string> = {
    'path-traversal': `${Style.RED}⚠️  Skipping ${task.taskId}: prd_path escapes task directory${Style.RESET}`,
    'missing-file': `${Style.RED}⚠️  Skipping ${task.taskId}: cannot read jarred PRD for integrity check${Style.RESET}`,
    'hash-mismatch': `${Style.RED}⚠️  Skipping ${task.taskId}: PRD integrity check failed (content modified since jarring)${Style.RESET}`,
  };
  console.error(messages[result.reason]);
  skipTaskWithReason(task.meta, result.reason);
  return false;
}

function resolveTaskExecution(task: JarTask, sessionsRoot: string): { sessionDir: string; repoPath: string } | null {
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

function deactivateTaskSession(sessionDir: string): void {
  try {
    const taskStatePath = path.join(sessionDir, 'state.json');
    sm.update(taskStatePath, s => { s.active = false; });
  } catch { /* best-effort */ }
}

/**
 * Terminal-success finalize for jar tasks: marks step='completed', clears
 * current_ticket, stamps exit_reason. Use only when the task ran to a clean
 * end (`result.ok === true`); use `deactivateTaskSession` for failed/aborted
 * tasks so step/ticket forensics survive.
 */
function finalizeTaskSession(sessionDir: string, exitReason: string): void {
  try {
    const taskStatePath = path.join(sessionDir, 'state.json');
    finalizeTerminalState(taskStatePath, { step: 'completed', exitReason });
  } catch { /* best-effort */ }
}

function countRemainingQueuedBackendTasks(
  tasks: JarTask[],
  currentIndex: number,
  sessionsRoot: string,
  backend: Backend,
): number {
  let count = 0;
  for (const task of tasks.slice(currentIndex + 1)) {
    if (task.meta.status !== 'marinating') continue;
    const taskState = readTaskState(path.join(sessionsRoot, task.taskId));
    if (resolveBackend(taskState) === backend) count++;
  }
  return count;
}

export function handleTaskEnoent(
  result: SpawnResult,
  tasks: TaskMeta[],
  currentTaskId: string,
  sessionsRoot?: string,
): { skippedTasks: string[] } {
  if (!result.enoent || result.backend !== 'codex') return { skippedTasks: [] };

  const currentIndex = tasks.findIndex(meta => taskIdForMeta(meta) === currentTaskId);
  if (currentIndex < 0) return { skippedTasks: [] };

  const skippedTasks: string[] = [];
  for (const meta of tasks.slice(currentIndex + 1)) {
    if (meta.status !== 'marinating') continue;
    const taskId = taskIdForMeta(meta);
    if (!taskId) continue;
    const metaBackend = resolveBackend(meta as unknown as State);
    if (metaBackend === result.backend) {
      skippedTasks.push(taskId);
      continue;
    }
    if (!sessionsRoot) continue;
    const taskState = readTaskState(path.join(sessionsRoot, taskId));
    if (resolveBackend(taskState) === result.backend) {
      skippedTasks.push(taskId);
    }
  }

  return { skippedTasks };
}

function installShutdownHandlers(): void {
  const handleShutdownSignal = (signal: string) => {
    console.error(`\n${Style.YELLOW}⚠️  Received ${signal} — deactivating current task session${Style.RESET}`);
    if (activeTaskSessionDir) {
      const sp = path.join(activeTaskSessionDir, 'state.json');
      recordExitReason(sp, 'signal');
      safeDeactivate(sp);
    }
    if (activeTaskProc && !activeTaskProc.killed) {
      // R-OMTD (jar arm): reap the manager's WHOLE subtree, not just its pid —
      // an operator Ctrl-C must not leave the batch's workers running.
      reapTaskSubtree(activeTaskProc, activeTaskLeadsGroup, 'SIGTERM');
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
  process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
  process.on('SIGHUP', () => handleShutdownSignal('SIGHUP'));
}

async function processJarTask(
  task: JarTask,
  currentIndex: number,
  tasks: JarTask[],
  sessionsRoot: string,
  extensionRoot: string,
): Promise<{ succeededDelta: number; failedDelta: number; stop: boolean }> {
  const execution = resolveTaskExecution(task, sessionsRoot);
  if (!execution) {
    return { succeededDelta: 0, failedDelta: 1, stop: false };
  }

  let result: RunTaskResult;
  try {
    result = await runTask(execution.sessionDir, execution.repoPath, extensionRoot);
  } catch (err) {
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
    if (outcome.stop) break;
  }

  console.log(`\n🥒 Jar complete. ${succeeded} succeeded, ${failed} failed.`);
  logActivity({ event: 'jar_end', source: 'pickle' });
  console.log('Signal: Jar Complete');
}

export function buildJarNotification(succeeded: number, failed: number) {
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

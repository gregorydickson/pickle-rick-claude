/**
 * R-CXHANG — codex orphaned-worker-proc reaper (session-GC, reuse-first).
 *
 * Third instance of the established orphan-reaper pattern (see
 * `reapOrphanedFastTestRunnersOnStartup` / `reapOrphanedManagersAtIterationStart`
 * in `bin/mux-runner.ts`): injectable scan/kill, activity events, fixture tests.
 *
 * Why it exists: detached codex/claude workers lead their own process group and
 * are group-reaped on CLEAN teardown or worker timeout — but a session that
 * crashes, is SIGKILL'd, or is operator-frozen runs no teardown, so its group
 * re-parents to PID 1 and lingers (codex hangs on network I/O and never
 * self-exits — B-SIGFH soak: 8 orphans, 16h–2d old, starved run 1 dead).
 * `reapOrphanedWorkerProcs` runs once at setup-time bootstrap and collects
 * worker procs no live pickle session owns.
 *
 * TRAP DOOR (positive ownership): a proc is reaped ONLY when it is positively
 * attributed to an owning session (argv `--add-dir <path>` under the sessions
 * root — present on BOTH claude and codex worker invocations) AND that session
 * is provably not live (state.json missing, `active !== true`, or a finite pid
 * that is dead). An unattributable proc is NEVER killed; a live session's proc
 * is NEVER killed regardless of ppid. There is deliberately NO ppid==1-only
 * reap branch — false-reaping an active worker is worse than a leaked orphan.
 *
 * `killProcessGroup` is the SHARED negative-PID group-kill primitive
 * (AC-CXHANG-3): `bin/spawn-morty.ts:killProcessTree` and
 * `bin/pipeline-runner.ts:reapChildSubtree` delegate their group branch here.
 * Seam pin: extension/tests/single-group-kill-implementation.test.js.
 *
 * Kill-switch: `PICKLE_ORPHAN_REAP=off` (literal lowercase) → inert no-op.
 * win32: no process groups → safe no-op. No state-schema change.
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { isProcessAlive, writeActivityEntry } from './state-manager.js';
import { readRecoverableJsonObject } from './recoverable-json.js';
export const ORPHAN_REAP_ENV_VAR = 'PICKLE_ORPHAN_REAP';
const DEFAULT_MIN_AGE_SECONDS = 600;
const DEFAULT_GRACE_MS = 2000;
const DEFAULT_WALL_BUDGET_MS = 15_000;
const GRACE_POLL_MS = 100;
const PS_TIMEOUT_MS = 5000;
const PS_MAX_BUFFER = 1024 * 1024 * 8;
/**
 * The ONE negative-PID group-kill implementation (AC-CXHANG-3).
 * Returns `true` when the group signal was delivered; `false` on win32 (no
 * process groups), invalid pid, or a group that is already gone — callers fall
 * back to a direct leader kill.
 */
export function killProcessGroup(pid, signal, platform = process.platform) {
    if (platform === 'win32')
        return false;
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(-pid, signal);
        return true;
    }
    catch {
        return false;
    }
}
/** Parse `ps` etime (`[[dd-]hh:]mm:ss`) into seconds; null on malformed input. */
function parsePsElapsedSeconds(raw) {
    const value = raw.trim();
    if (!value)
        return null;
    const [dayPart, clockPart] = value.includes('-') ? value.split('-', 2) : [null, value];
    const segments = clockPart.split(':').map(segment => Number(segment));
    if (segments.some(segment => !Number.isFinite(segment) || segment < 0))
        return null;
    const days = dayPart === null ? 0 : Number(dayPart);
    if (!Number.isFinite(days) || days < 0)
        return null;
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
/**
 * Worker-shaped commands mirror the spawn builders in `backend-spawn.ts`:
 *  - codex:  `codex exec --dangerously-bypass-approvals-and-sandbox …` (buildCodexInvocation)
 *  - claude: `claude --dangerously-skip-permissions … -p <prompt>` (buildClaudeWorkerInvocation)
 * Drift pin: the unit test builds REAL `buildWorkerInvocation` argv and asserts a match.
 */
function isWorkerShapedCommand(command) {
    const tokens = command.split(/\s+/);
    const base = path.basename(tokens[0] ?? '');
    if (base === 'codex') {
        return tokens.includes('exec') && tokens.includes('--dangerously-bypass-approvals-and-sandbox');
    }
    if (base === 'claude') {
        return tokens.includes('--dangerously-skip-permissions') && tokens.includes('-p');
    }
    return false;
}
/**
 * Positive-ownership attribution: the first `--add-dir` value under the
 * sessions root maps the proc to `<sessionsRoot>/<session>` (worker argv
 * carries `--add-dir <sessionsRoot>/<session>/<ticket>` on both backends).
 */
function resolveOwningSessionDir(command, sessionsRoot) {
    const root = path.resolve(sessionsRoot);
    const rootPrefix = root + path.sep;
    const tokens = command.split(/\s+/);
    for (let i = 0; i < tokens.length - 1; i++) {
        if (tokens[i] !== '--add-dir')
            continue;
        const value = tokens[i + 1];
        if (!value || !value.startsWith(rootPrefix))
            continue;
        const firstSegment = value.slice(rootPrefix.length).split(path.sep)[0];
        if (firstSegment)
            return path.join(root, firstSegment);
    }
    return null;
}
/** Parse a base-10 ps column into a finite integer; -1 on malformed input. */
function parsePsInt(raw) {
    const value = Number(raw);
    return Number.isFinite(value) && Number.isInteger(value) ? value : -1;
}
/** Pure parser over `ps -axo pid=,pgid=,ppid=,etime=,command=` output. */
export function parseWorkerProcsFromPs(psOutput, sessionsRoot) {
    const results = [];
    for (const rawLine of psOutput.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line)
            continue;
        const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
        if (!match)
            continue;
        const pid = parsePsInt(match[1]);
        const pgid = parsePsInt(match[2]);
        const ppid = parsePsInt(match[3]);
        const etimeSeconds = parsePsElapsedSeconds(match[4]);
        const command = match[5].trim();
        if (pid <= 0 || pgid <= 0 || ppid < 0 || etimeSeconds === null)
            continue;
        if (!isWorkerShapedCommand(command))
            continue;
        results.push({
            pid,
            pgid,
            ppid,
            etime_seconds: etimeSeconds,
            command,
            owningSessionDir: resolveOwningSessionDir(command, sessionsRoot),
        });
    }
    return results;
}
/**
 * A session is LIVE unless proven otherwise: missing/unreadable state.json or
 * `active !== true` → not live; `active: true` with a finite dead pid → not
 * live (dead-pid demotion, mirrors `isDeadPidState`); `active: true` with no
 * pid or a live pid → LIVE (conservative bias — spare).
 */
function readOwningSessionState(sessionDir) {
    try {
        return readRecoverableJsonObject(path.join(sessionDir, 'state.json'));
    }
    catch {
        return null;
    }
}
function isOwningSessionLive(sessionDir, isAlive) {
    const state = readOwningSessionState(sessionDir);
    if (!state)
        return false;
    if (state.active !== true)
        return false;
    const pid = state.pid;
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && !isAlive(pid))
        return false;
    return true;
}
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/**
 * TRAP DOOR: positive ownership required before any kill. Skips self/parent
 * groups, unattributable procs (NEVER killed), under-age procs, and any proc
 * whose owning session is live. No ppid==1-only branch by design.
 */
function isReapableOrphan(cand, rt, reapedPgids) {
    // Never signal our own process/group or our parent's (the reaper runs
    // inside a claude-shaped process tree at setup time).
    if (cand.pid === process.pid || cand.pid === process.ppid)
        return false;
    if (cand.pgid === process.pid || cand.pgid === process.ppid)
        return false;
    if (reapedPgids.has(cand.pgid))
        return false;
    if (cand.owningSessionDir === null)
        return false;
    if (cand.etime_seconds < rt.minAgeSeconds)
        return false;
    return !isOwningSessionLive(cand.owningSessionDir, rt.isAlive);
}
/** Reuse the spawn-morty escalation shape: group SIGTERM → grace → group SIGKILL. */
function reapCandidateGroup(cand, rt) {
    rt.kill(cand.pgid, 'SIGTERM');
    const graceDeadline = Date.now() + rt.graceMs;
    let polls = Math.max(1, Math.ceil(rt.graceMs / GRACE_POLL_MS));
    while (rt.isAlive(cand.pid) && Date.now() < graceDeadline && polls > 0) {
        rt.sleep(GRACE_POLL_MS);
        polls -= 1;
    }
    if (rt.isAlive(cand.pid))
        rt.kill(cand.pgid, 'SIGKILL');
    emitReapedTelemetry(cand, rt);
}
function emitReapedTelemetry(cand, rt) {
    const owningSession = path.basename(cand.owningSessionDir ?? '');
    if (rt.statePath) {
        try {
            writeActivityEntry(rt.statePath, {
                event: 'worker_orphan_reaped',
                ts: new Date().toISOString(),
                pid: cand.pid,
                pgid: cand.pgid,
                etime_seconds: cand.etime_seconds,
                owning_session: owningSession,
                argv_summary: cand.command,
            });
        }
        catch { /* event emission is best-effort */ }
    }
    rt.log?.(`reaped orphan worker pid=${cand.pid} pgid=${cand.pgid} etime_seconds=${cand.etime_seconds} session=${owningSession}`);
}
function runReapPass(opts, platform) {
    const scan = opts.scan ?? (() => execFileSync('ps', ['-axo', 'pid=,pgid=,ppid=,etime=,command='], {
        encoding: 'utf-8',
        timeout: PS_TIMEOUT_MS,
        maxBuffer: PS_MAX_BUFFER,
    }));
    const psOutput = opts.psOutput ?? scan();
    const candidates = parseWorkerProcsFromPs(psOutput, opts.sessionsRoot);
    const rt = {
        kill: opts.kill ?? ((pgid, signal) => killProcessGroup(pgid, signal, platform)),
        isAlive: opts.isAlive ?? isProcessAlive,
        sleep: opts.sleep ?? sleepSync,
        minAgeSeconds: opts.minAgeSeconds ?? DEFAULT_MIN_AGE_SECONDS,
        graceMs: opts.graceMs ?? DEFAULT_GRACE_MS,
        ...(opts.statePath !== undefined ? { statePath: opts.statePath } : {}),
        ...(opts.log !== undefined ? { log: opts.log } : {}),
    };
    const deadline = Date.now() + (opts.wallBudgetMs ?? DEFAULT_WALL_BUDGET_MS);
    const reapedPgids = new Set();
    let reaped = 0;
    for (const cand of candidates) {
        if (Date.now() > deadline)
            break;
        if (!isReapableOrphan(cand, rt, reapedPgids))
            continue;
        reapCandidateGroup(cand, rt);
        reapedPgids.add(cand.pgid);
        reaped += 1;
    }
    return { scanned: candidates.length, reaped };
}
/**
 * Reap detached worker procs (codex/claude) that no live pickle session owns.
 * Never throws (best-effort); never kills an unattributable or live-owned proc.
 */
export function reapOrphanedWorkerProcs(opts) {
    const env = opts.env ?? process.env;
    if (env[ORPHAN_REAP_ENV_VAR] === 'off')
        return { scanned: 0, reaped: 0 };
    const platform = opts.platform ?? process.platform;
    if (platform === 'win32')
        return { scanned: 0, reaped: 0 };
    try {
        return runReapPass(opts, platform);
    }
    catch {
        // Best-effort collector — a reaper failure must never block a launch.
        return { scanned: 0, reaped: 0 };
    }
}

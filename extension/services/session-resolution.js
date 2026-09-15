import * as fs from 'fs';
import * as path from 'path';
import { isProcessAlive } from './state-manager.js';
import { readRecoverableJsonObject } from './recoverable-json.js';
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
export const MAX_FUTURE_RECENCY_DRIFT_MS = 5 * 60 * 1000;
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
export function selectScannedSessionPath(sessionPaths, cwd, requireActive) {
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
export function readSessionsMapFallback(sessionsMapPath, cwd, requireActive) {
    try {
        const map = readRecoverableJsonObject(sessionsMapPath);
        return map ? resolveMappedSessionForCwd(map, cwd, requireActive) ?? '' : '';
    }
    catch {
        return '';
    }
}

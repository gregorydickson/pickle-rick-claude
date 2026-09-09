import * as fs from 'fs';
import * as path from 'path';
import { resolveSessionPath, pruneOrphanedMapEntries } from '../services/pickle-utils.js';
import { readRecoverableJsonObject } from '../services/recoverable-json.js';
import { isProcessAlive } from '../lib/process-liveness.js';
import { StateManager } from '../services/state-manager.js';
const ALLOW = JSON.stringify({ decision: 'approve' });
const sm = new StateManager();
function normalizeWorkingDir(input) {
    const resolved = path.resolve(input);
    try {
        return fs.realpathSync(resolved);
    }
    catch {
        return resolved;
    }
}
export function sameWorkingDir(a, b) {
    return typeof a === 'string' && normalizeWorkingDir(a) === normalizeWorkingDir(b);
}
const MAX_FUTURE_RECENCY_DRIFT_MS = 5 * 60 * 1000;
function readLookupState(stateFile) {
    try {
        let stateMtimeMs = 0;
        try {
            stateMtimeMs = fs.statSync(stateFile).mtimeMs;
        }
        catch { /* sm.read below handles missing file */ }
        const state = sm.read(stateFile);
        return {
            active: state.active,
            working_dir: state.working_dir,
            started_at: state.started_at,
            state_mtime_ms: stateMtimeMs,
            pid: state.pid,
        };
    }
    catch {
        return null;
    }
}
function readMappedPid(entry) {
    if (entry !== null && typeof entry === 'object' && typeof entry.pid === 'number') {
        const pid = Number(entry.pid);
        if (Number.isFinite(pid) && pid > 0)
            return pid;
    }
    return null;
}
function isMappedOrphanState(entry, state) {
    if (!state || state.active !== true || state.pid !== null)
        return false;
    const mappedPid = readMappedPid(entry);
    return mappedPid !== null && !isProcessAlive(mappedPid);
}
function getStateFileRecencyMs(state) {
    if (typeof state.started_at === 'string') {
        const startedAtMs = new Date(state.started_at).getTime();
        const maxTrustedFutureMs = Date.now() + MAX_FUTURE_RECENCY_DRIFT_MS;
        if (Number.isFinite(startedAtMs) && startedAtMs <= maxTrustedFutureMs) {
            return startedAtMs;
        }
    }
    return state.state_mtime_ms ?? 0;
}
function preferNewerStateFile(best, candidate) {
    if (!best)
        return candidate;
    if (candidate.recencyMs !== best.recencyMs) {
        return candidate.recencyMs > best.recencyMs ? candidate : best;
    }
    return candidate.stateFile.localeCompare(best.stateFile) > 0 ? candidate : best;
}
function resolveMatchingStateFile(stateFile, cwd) {
    if (!fs.existsSync(stateFile))
        return null;
    const state = readLookupState(stateFile);
    if (!state || !sameWorkingDir(state.working_dir, cwd))
        return null;
    return { stateFile, active: state.active };
}
export function selectScannedStateFile(stateFiles, cwd) {
    let activeMatch = null;
    let inactiveMatch = null;
    for (const stateFile of stateFiles) {
        const state = readLookupState(stateFile);
        if (!state || !sameWorkingDir(state.working_dir, cwd))
            continue;
        const candidate = {
            stateFile,
            recencyMs: getStateFileRecencyMs(state),
        };
        if (state.active === true) {
            activeMatch = preferNewerStateFile(activeMatch, candidate);
            continue;
        }
        inactiveMatch = preferNewerStateFile(inactiveMatch, candidate);
    }
    return activeMatch?.stateFile ?? inactiveMatch?.stateFile ?? null;
}
/**
 * `rejected` is a state file the caller has already REFUSED, and it is refused
 * here too. The mapped-session filter (`isMappedOrphanState`) exists to let a
 * live same-cwd session win over a dead mapped one, so its refusal is expressed
 * as a fall-through into this scan — and the scan enumerates
 * `<dataDir>/sessions/*`, the very directory the mapped `sessionPath` lives in.
 * Without the exclusion the orphan re-entered through the door the refusal
 * opened: with no live alternative for the cwd it came back as the scan's
 * `activeMatch` and was returned, `active: true` and `pid: null` intact
 * (AP-EXT-ITER35-01). One rejection, one answer — not a mapped verdict and a
 * scan verdict that disagree about the same file.
 *
 * The refusal is bounded protection, not belt-and-braces: `state-manager.ts`
 * demotes a paused orphan only once its state file is 300s stale, so inside
 * that window this is the ONLY thing standing between a crashed session and a
 * hook that treats it as live.
 */
function resolveStateFileFromSessionsDir(dataDir, rejected) {
    const sessionsDir = path.join(dataDir, 'sessions');
    let entries;
    try {
        entries = fs.readdirSync(sessionsDir);
    }
    catch {
        return null;
    }
    // Path identity through the same normalizer `sameWorkingDir` uses, so a
    // symlinked data root cannot spell the same file two ways and slip past.
    const rejectedKey = rejected === null ? null : normalizeWorkingDir(rejected);
    return selectScannedStateFile(entries
        .map((entry) => path.join(sessionsDir, entry, 'state.json'))
        .filter((stateFile) => rejectedKey === null || normalizeWorkingDir(stateFile) !== rejectedKey), process.cwd());
}
/**
 * Resolves the state file path from env or the sessions map.
 * `dataDir` is where current_sessions.json lives (pickle data root, not the
 * extension install dir). Returns null if no matching state file is found.
 */
export function resolveStateFile(dataDir) {
    const cwd = process.cwd();
    let fallbackStateFile = null;
    let rejectedOrphanStateFile = null;
    const envStateFile = process.env.PICKLE_STATE_FILE;
    if (envStateFile) {
        const envMatch = resolveMatchingStateFile(envStateFile, cwd);
        if (envMatch) {
            if (envMatch.active === true)
                return envMatch.stateFile;
            fallbackStateFile = envMatch.stateFile;
        }
    }
    // R-SHB-6: prune phantom map entries before reading. Pre-fix, removed
    // session dirs left stale entries that shadowed live same-cwd lookups in
    // hook resolution paths and blocked the stop-hook indefinitely.
    pruneOrphanedMapEntries(dataDir);
    const sessionsMapPath = path.join(dataDir, 'current_sessions.json');
    try {
        const map = readRecoverableJsonObject(sessionsMapPath);
        if (map) {
            const mappedEntry = map[cwd];
            const sessionPath = resolveSessionPath(mappedEntry);
            if (sessionPath) {
                const mappedStateFile = path.join(sessionPath, 'state.json');
                const mappedMatch = resolveMatchingStateFile(mappedStateFile, cwd);
                const mappedState = mappedMatch ? readLookupState(mappedStateFile) : null;
                if (mappedMatch && isMappedOrphanState(mappedEntry, mappedState)) {
                    rejectedOrphanStateFile = mappedMatch.stateFile;
                }
                else if (mappedMatch) {
                    if (mappedMatch.active === true)
                        return mappedMatch.stateFile;
                    if (!fallbackStateFile)
                        fallbackStateFile = mappedMatch.stateFile;
                }
            }
        }
    }
    catch {
        /* corrupt sessions map — fall through to state scan below */
    }
    const scannedStateFile = resolveStateFileFromSessionsDir(dataDir, rejectedOrphanStateFile);
    if (scannedStateFile)
        return scannedStateFile;
    return fallbackStateFile;
}
/**
 * Loads state from a state file, returning null if the session is
 * inactive or the working directory doesn't match the current cwd.
 */
export function loadActiveState(stateFile) {
    try {
        const state = sm.read(stateFile);
        if (state.working_dir != null && state.working_dir !== '' && !sameWorkingDir(state.working_dir, process.cwd())) {
            return null;
        }
        if (state.active !== true)
            return null;
        return state;
    }
    catch {
        return null;
    }
}
/** Prints the "approve" decision to stdout. */
export function approve() {
    console.log(ALLOW);
}

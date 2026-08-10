import * as fs from 'fs';
import * as path from 'path';
import { State } from '../types/index.js';
import { resolveSessionPath, pruneOrphanedMapEntries } from '../services/pickle-utils.js';
import { readRecoverableJsonObject } from '../services/recoverable-json.js';
import { isProcessAlive } from '../lib/process-liveness.js';
import { StateManager } from '../services/state-manager.js';

const ALLOW = JSON.stringify({ decision: 'approve' });
const sm = new StateManager();

function normalizeWorkingDir(input: string): string {
  const resolved = path.resolve(input);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function sameWorkingDir(a: unknown, b: string): boolean {
  return typeof a === 'string' && normalizeWorkingDir(a) === normalizeWorkingDir(b);
}

interface LookupState {
  active?: unknown;
  working_dir?: unknown;
  started_at?: unknown;
  state_mtime_ms?: number;
  pid?: unknown;
}

interface StateFileCandidate {
  stateFile: string;
  recencyMs: number;
}

const MAX_FUTURE_RECENCY_DRIFT_MS = 5 * 60 * 1000;

function readLookupState(stateFile: string): LookupState | null {
  try {
    let stateMtimeMs = 0;
    try { stateMtimeMs = fs.statSync(stateFile).mtimeMs; } catch { /* sm.read below handles missing file */ }
    const state = sm.read(stateFile);
    return {
      active: state.active,
      working_dir: state.working_dir,
      started_at: state.started_at,
      state_mtime_ms: stateMtimeMs,
      pid: state.pid,
    };
  } catch {
    return null;
  }
}

function readMappedPid(entry: unknown): number | null {
  if (entry !== null && typeof entry === 'object' && typeof (entry as Record<string, unknown>).pid === 'number') {
    const pid = Number((entry as Record<string, unknown>).pid);
    if (Number.isFinite(pid) && pid > 0) return pid;
  }
  return null;
}

function isMappedOrphanState(entry: unknown, state: LookupState | null): boolean {
  if (!state || state.active !== true || state.pid !== null) return false;
  const mappedPid = readMappedPid(entry);
  return mappedPid !== null && !isProcessAlive(mappedPid);
}

function getStateFileRecencyMs(state: LookupState): number {
  if (typeof state.started_at === 'string') {
    const startedAtMs = new Date(state.started_at).getTime();
    const maxTrustedFutureMs = Date.now() + MAX_FUTURE_RECENCY_DRIFT_MS;
    if (Number.isFinite(startedAtMs) && startedAtMs <= maxTrustedFutureMs) {
      return startedAtMs;
    }
  }
  return state.state_mtime_ms ?? 0;
}

function preferNewerStateFile(
  best: StateFileCandidate | null,
  candidate: StateFileCandidate,
): StateFileCandidate {
  if (!best) return candidate;
  if (candidate.recencyMs !== best.recencyMs) {
    return candidate.recencyMs > best.recencyMs ? candidate : best;
  }
  return candidate.stateFile.localeCompare(best.stateFile) > 0 ? candidate : best;
}

function resolveMatchingStateFile(
  stateFile: string,
  cwd: string,
): { stateFile: string; active?: unknown } | null {
  if (!fs.existsSync(stateFile)) return null;
  const state = readLookupState(stateFile);
  if (!state || !sameWorkingDir(state.working_dir, cwd)) return null;
  return { stateFile, active: state.active };
}

export function selectScannedStateFile(stateFiles: string[], cwd: string): string | null {
  let activeMatch: StateFileCandidate | null = null;
  let inactiveMatch: StateFileCandidate | null = null;
  for (const stateFile of stateFiles) {
    const state = readLookupState(stateFile);
    if (!state || !sameWorkingDir(state.working_dir, cwd)) continue;
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

function resolveStateFileFromSessionsDir(dataDir: string): string | null {
  const sessionsDir = path.join(dataDir, 'sessions');
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsDir);
  } catch {
    return null;
  }

  return selectScannedStateFile(
    entries.map((entry) => path.join(sessionsDir, entry, 'state.json')),
    process.cwd(),
  );
}

/**
 * Resolves the state file path from env or the sessions map.
 * `dataDir` is where current_sessions.json lives (pickle data root, not the
 * extension install dir). Returns null if no matching state file is found.
 */
export function resolveStateFile(dataDir: string): string | null {
  const cwd = process.cwd();
  let fallbackStateFile: string | null = null;

  const envStateFile = process.env.PICKLE_STATE_FILE;
  if (envStateFile) {
    const envMatch = resolveMatchingStateFile(envStateFile, cwd);
    if (envMatch) {
      if (envMatch.active === true) return envMatch.stateFile;
      fallbackStateFile = envMatch.stateFile;
    }
  }

  // R-SHB-6: prune phantom map entries before reading. Pre-fix, removed
  // session dirs left stale entries that shadowed live same-cwd lookups in
  // hook resolution paths and blocked the stop-hook indefinitely.
  pruneOrphanedMapEntries(dataDir);
  const sessionsMapPath = path.join(dataDir, 'current_sessions.json');
  try {
    const map = readRecoverableJsonObject(sessionsMapPath) as Record<string, unknown> | null;
    if (map) {
      const mappedEntry = map[cwd];
      const sessionPath = resolveSessionPath(mappedEntry);
      if (sessionPath) {
        const mappedStateFile = path.join(sessionPath, 'state.json');
        const mappedMatch = resolveMatchingStateFile(mappedStateFile, cwd);
        const mappedState = mappedMatch ? readLookupState(mappedStateFile) : null;
        if (mappedMatch && !isMappedOrphanState(mappedEntry, mappedState)) {
          if (mappedMatch.active === true) return mappedMatch.stateFile;
          if (!fallbackStateFile) fallbackStateFile = mappedMatch.stateFile;
        }
      }
    }
  } catch {
    /* corrupt sessions map — fall through to state scan below */
  }

  const scannedStateFile = resolveStateFileFromSessionsDir(dataDir);
  if (scannedStateFile) return scannedStateFile;
  return fallbackStateFile;
}

/**
 * Loads state from a state file, returning null if the session is
 * inactive or the working directory doesn't match the current cwd.
 */
export function loadActiveState(stateFile: string): State | null {
  try {
    const state = sm.read(stateFile);
    if (state.working_dir != null && state.working_dir !== '' && !sameWorkingDir(state.working_dir, process.cwd())) {
      return null;
    }
    if (state.active !== true) return null;
    return state;
  } catch {
    return null;
  }
}

/** Prints the "approve" decision to stdout. */
export function approve(): void {
  console.log(ALLOW);
}

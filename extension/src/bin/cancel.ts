#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { printMinimalPanel, getDataRoot, withRetryLock, findSessionPathForCwd, safeErrorMessage } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
import { LockError } from '../types/index.js';
import { readRecoverableJsonObject } from '../services/recoverable-json.js';
import { logActivity } from '../services/activity-logger.js';

const sm = new StateManager();

interface LockCleanupContext {
  sessionDir: string;
  workingDir: string;
}

/**
 * R-PIWG-4: report a leftover `.git/index.lock` in the session's working_dir so the
 * operator can clear it before their next git command.
 *
 * Deliberately non-destructive. git owns `index.lock` under a protocol it does not
 * share: it records no holder pid, honors no steal, and releases the lock by
 * close()-then-rename(). A liveness probe can therefore only ever answer about the
 * past — inside git's close→rename window the fd is already closed, so the lock reads
 * as unheld while a live git still owns it. Unlinking it there lets a second git
 * acquire the same lock, putting two writers in the index critical section: the exact
 * corruption the lock exists to prevent. No conditional-unlink syscall exists to close
 * that gap, so the only action that cannot be wrong is to leave the file alone and say
 * so. The one caller is the operator-run `/eat-pickle`, and git prints the same remedy
 * on the next command.
 */
function reportStaleIndexLock(ctx: LockCleanupContext): void {
  const lockPath = path.join(ctx.workingDir, '.git', 'index.lock');
  let lockStat: fs.Stats;
  try {
    lockStat = fs.statSync(lockPath);
  } catch {
    return;
  }
  if (!lockStat.isFile()) return;

  const lockMtimeMs = lockStat.mtimeMs;
  const ageSeconds = Math.max(0, Math.round((Date.now() - lockMtimeMs) / 1000));

  process.stderr.write(
    `[pickle] WARNING: ${lockPath} still exists — git will refuse to run in ${ctx.workingDir} until it is gone. ` +
      `Confirm no git process is running, then remove it: rm -f ${lockPath}\n`,
  );

  try {
    logActivity({
      event: 'stale_index_lock_detected',
      source: 'pickle',
      session: path.basename(ctx.sessionDir),
      gate_payload: {
        path: lockPath,
        mtime: new Date(lockMtimeMs).toISOString(),
        age_seconds: ageSeconds,
      },
    });
  } catch { /* best-effort */ }
}

export function cancelSession(cwd: string) {
  const SESSIONS_MAP = path.join(getDataRoot(), 'current_sessions.json');
  const sessionPath = findSessionPathForCwd(cwd);

  if (!sessionPath || !fs.existsSync(sessionPath)) {
    console.log('No active session found for this directory.');
    return;
  }

  const statePath = path.join(sessionPath, 'state.json');
  const recoveredState = readRecoverableJsonObject(statePath);
  if (!fs.existsSync(statePath) && !recoveredState) {
    console.log('State file not found.');
    return;
  }

  let workingDir: string;
  try {
    const stateSnapshot = sm.read(statePath);
    if (stateSnapshot.active !== true) {
      console.log('No active session found for this directory.');
      return;
    }
    workingDir = typeof stateSnapshot.working_dir === 'string' && stateSnapshot.working_dir
      ? stateSnapshot.working_dir
      : cwd;
  } catch {
    console.log('State file is unreadable.');
    return;
  }

  // Deactivate state AND remove map entry inside one lock to prevent inconsistent state
  // if the process crashes between the two operations.
  let cancelled = false;
  try {
    withRetryLock(SESSIONS_MAP + '.lock', () => {
      // Deactivate state.json
      try {
        sm.update(statePath, s => { s.active = false; });
      } catch {
        console.log('State file is unreadable.');
        return;
      }
      cancelled = true;

      // Remove stale entry from the sessions map
      let freshMap: Record<string, unknown> = {};
      try {
        freshMap = (readRecoverableJsonObject(SESSIONS_MAP) || {}) as Record<string, unknown>;
      } catch { /* ignore */ }
      delete freshMap[cwd];
      const tmpMap = SESSIONS_MAP + `.tmp.${process.pid}`;
      try {
        fs.writeFileSync(tmpMap, JSON.stringify(freshMap, null, 2));
        fs.renameSync(tmpMap, SESSIONS_MAP);
      } catch (writeErr) {
        try { fs.unlinkSync(tmpMap); } catch { /* ignore cleanup failure */ }
        throw writeErr;
      }
    });
  } catch (err) {
    if (err instanceof LockError) {
      // Lock exhausted — deactivate state without map consistency guarantee
      console.error(`[pickle] WARNING: session map not updated — ${safeErrorMessage(err)}`);
      try {
        sm.update(statePath, s => { s.active = false; });
        cancelled = true;
      } catch { /* session already deactivated or unreadable */ }
    } else {
      throw err;
    }
  }

  if (cancelled) {
    // R-PIWG-4: surface an orphaned .git/index.lock left in the session's working_dir.
    try {
      reportStaleIndexLock({ sessionDir: sessionPath, workingDir });
    } catch { /* best-effort */ }

    printMinimalPanel(
      'Loop Cancelled',
      {
        Session: path.basename(sessionPath),
        Status: 'Inactive',
      },
      'RED',
      '🛑'
    );
  } else {
    console.log('Failed to cancel session — state file unreadable.');
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'cancel.js') {
  cancelSession(process.cwd());
}

import { LockError } from '../types/index.js';
import { inspectLockFile, stealLockFile, acquireLockFile, releaseLockFile, isDeadPidPayload, withStealRight } from './state-manager.js';

// Shared buffer for Atomics.wait()-based synchronous sleep (no CPU spin).
const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));

/**
 * Synchronous sleep that yields to the OS scheduler instead of busy-waiting.
 * Contrast the async `sleep()` in pickle-utils — the `Sync` suffix is what matters at a
 * call site, not the unit.
 */
export function sleepSync(ms: number): void {
  Atomics.wait(_sleepBuf, 0, 0, ms);
}

export interface RetryLockOptions {
  /** Maximum number of retry attempts before throwing LockError. Default: 10. */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default: 100. */
  baseLockDelayMs?: number;
  /** Age threshold in ms after which a lock file is considered stale and stolen. Default: 30000. */
  staleLockTimeoutMs?: number;
  /** Whether to add random jitter to backoff delays. Default: true. */
  lockJitter?: boolean;
}

const RETRY_LOCK_DEFAULTS = {
  maxRetries: 10,
  baseLockDelayMs: 100,
  staleLockTimeoutMs: 30_000,
  lockJitter: true,
} as const;

/**
 * The lock payload is the holder's pid (see `tryRunWithExclusiveLock`). Recovery runs under
 * `withStealRight`, so the lock inspected here is the lock removed here — no other stealer can be
 * mid-removal, and the dead holder this judges cannot release its own file.
 */
function stealStaleLock(lockPath: string, staleLockTimeoutMs: number): void {
  withStealRight(lockPath, () => {
    const snapshot = inspectLockFile(lockPath);
    if (!snapshot) return false; // lock file doesn't exist — expected

    // A dead holder is stolen at once. Waiting out staleLockTimeoutMs is not merely slow, it is
    // unreachable: the retry budget (~26.3s over 10 attempts) expires before the 30s window opens.
    const stale = isDeadPidPayload(snapshot.payload)
      || Date.now() - snapshot.mtimeMs > staleLockTimeoutMs;

    return stale ? stealLockFile(lockPath, snapshot) : false;
  });
}

function tryRunWithExclusiveLock<T>(lockPath: string, fn: () => T): { acquired: true; value: T } | { acquired: false } {
  const held = acquireLockFile(lockPath, String(process.pid));
  if (held === null) return { acquired: false };

  try {
    return { acquired: true, value: fn() };
  } finally {
    // Release only our own acquisition: a blind unlink would drop a successor's lock if ours was stolen.
    releaseLockFile(lockPath, held);
  }
}

function sleepBeforeRetry(attempt: number, baseLockDelayMs: number, lockJitter: boolean): void {
  const backoff = baseLockDelayMs * Math.pow(2, attempt);
  const jitter = lockJitter ? Math.random() * baseLockDelayMs : 0;
  sleepSync(Math.min(backoff + jitter, 5000));
}

/**
 * Acquires an exclusive file lock before executing fn, then releases it.
 * Uses O_EXCL atomic create for lock acquisition. Retries with exponential
 * backoff and optional jitter, stealing locks older than staleLockTimeoutMs.
 * Writes PID to lock file for stale detection. NEVER silently falls through —
 * throws LockError if maxRetries is exhausted.
 */
export function withRetryLock<T>(lockPath: string, fn: () => T, opts: RetryLockOptions = {}): T {
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
    if (locked.acquired) return locked.value;

    if (attempt >= maxRetries) {
      throw new LockError(
        `[pickle] Lock acquisition failed after ${maxRetries} retries (${lockPath})`
      );
    }
    sleepBeforeRetry(attempt, baseLockDelayMs, lockJitter);
    attempt++;
  }
}

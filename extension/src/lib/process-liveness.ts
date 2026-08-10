/**
 * The ONE pid-liveness probe. Every reaper, lock-stealer and session-demoter in the tree
 * asks the same question through it: "can I PROVE this pid is gone?"
 *
 * `process.kill(pid, 0)` delivers no signal; it reports whether the pid is signalable.
 * It fails two ways, and they are not the same fact:
 *   - `ESRCH` — no such process. Positive proof of death.
 *   - `EPERM` — the process EXISTS, we may not signal it (different euid).
 *
 * Collapsing both into `false` reads a LIVE process as dead, which is a destroy licence
 * at every consumer: `isDeadPidPayload` evicts a live holder's lock and puts two writers
 * in the same critical section, `orphan-reaper` group-SIGKILLs a live sibling worker, and
 * `pickle-utils` demotes a live session out of the map. Only ESRCH-class failure proves
 * death; an unsignalable pid is unaccountable, and unaccountable defers to LIVE.
 *
 * Same invariant `orphan-reaper.ts` states for state reads (unreadable is not absent) and
 * `recoverable-json.ts` states for content reads (a throw proves nothing about the file).
 */

/** The `process.kill`-shaped seam the probe is built on; injectable so tests can drive errnos. */
export type SignalProbe = (pid: number, signal: 0) => void;

const defaultSignal: SignalProbe = (pid, signal) => { process.kill(pid, signal); };

/**
 * True unless `pid` is PROVABLY gone.
 *
 * A non-integer or non-positive pid is never proof of death either — and `kill(0)`/`kill(-n)`
 * address the caller's own process GROUP, so they must never reach the probe.
 */
export function isProcessAlive(pid: number | null | undefined, signal: SignalProbe = defaultSignal): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return true;
  try {
    signal(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

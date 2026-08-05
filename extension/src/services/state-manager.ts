/**
 * StateManager — atomic, lock-protected state file operations.
 *
 * Provides read (with schema migration + recovery), update (with file-based
 * lock), multi-file transaction (with rollback), and forceWrite (best-effort,
 * no lock — for signal/crash handlers).
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { threadId } from 'node:worker_threads';
import * as path from 'node:path';
import { isRecord } from '../lib/is-record.js';
import {
  type State,
  type StateManagerOptions,
  type ActivityLogEntry,
  STATE_MANAGER_DEFAULTS,
  LATEST_SCHEMA_VERSION,
  StateError,
  LockError,
  TransactionError,
  SchemaVersionMismatchError,
  VALID_ACTIVITY_EVENTS,
} from '../types/index.js';
import { writeStateFile, safeErrorMessage, getDataRoot, formatLocalDateKey, sleepSync } from './pickle-utils.js';
import { readRecoverableJsonObject } from './recoverable-json.js';

// ---------------------------------------------------------------------------
// Deploy-parity self-check
// ---------------------------------------------------------------------------

/**
 * Fail fast at CLI entry when the deployed `STATE_MANAGER_DEFAULTS.schemaVersion`
 * has drifted from the source-of-truth `LATEST_SCHEMA_VERSION`. A mismatch means
 * a stale `~/.claude/pickle-rick/extension/types/index.js` is loaded (e.g.
 * after editing source without running `bash install.sh`).
 *
 * MUST NOT be invoked from hooks — they fail-open to avoid bricking sessions.
 * Call from CLI entry points only (setup, mux-runner, pipeline-runner,
 * microverse-runner). On mismatch, writes actionable stderr and `process.exit(1)`.
 */
export class SchemaVersionDeployDriftError extends StateError {
  deployedVersion: number;
  sourceVersion: number;
  constructor(deployedVersion: number, sourceVersion: number) {
    super(
      'SCHEMA_DEPLOY_DRIFT',
      `[state-manager] FATAL: deployed STATE_MANAGER_DEFAULTS.schemaVersion=${deployedVersion} ` +
        `does not match LATEST_SCHEMA_VERSION=${sourceVersion}. ` +
        `This usually means a stale deploy. ` +
        `Fix: from your pickle-rick-claude source repo, run: bash install.sh`,
    );
    this.name = 'SchemaVersionDeployDriftError';
    this.deployedVersion = deployedVersion;
    this.sourceVersion = sourceVersion;
  }
}

export function assertSchemaVersionDeployParity(): void {
  if (STATE_MANAGER_DEFAULTS.schemaVersion !== LATEST_SCHEMA_VERSION) {
    throw new SchemaVersionDeployDriftError(
      STATE_MANAGER_DEFAULTS.schemaVersion,
      LATEST_SCHEMA_VERSION,
    );
  }
}

// ---------------------------------------------------------------------------
// R-WSRC-1: Schema-version ceiling at write sites
// ---------------------------------------------------------------------------

/**
 * Thrown by `StateManager.update()` and `StateManager.forceWrite()` when a
 * mutator produces `state.schema_version > LATEST_SCHEMA_VERSION`. Defends the
 * runtime against a worker subprocess writing a forward-schema state that the
 * running binary cannot parse (R-QGSK-3 incident class). Bypass available via
 * `{ _internalSchemaBump: true }` in opts — reserved for legitimate
 * `migrateSchema` path only.
 */
export class SchemaVersionAheadError extends StateError {
  readonly writtenValue: number;
  readonly maxSupported: number;
  readonly statePath: string;
  readonly callerPid: number;
  constructor(statePath: string, writtenValue: number, maxSupported: number) {
    super(
      'SCHEMA_MISMATCH',
      `[state-manager] FATAL: refusing to write state ${statePath} with ` +
        `schema_version=${writtenValue} — exceeds max supported ${maxSupported}. ` +
        `This usually indicates a worker subprocess wrote a forward-schema state. ` +
        `R-WSRC-1 guard refuses the write to prevent runtime wedge.`,
    );
    this.name = 'SchemaVersionAheadError';
    this.writtenValue = writtenValue;
    this.maxSupported = maxSupported;
    this.statePath = statePath;
    this.callerPid = process.pid;
  }
}

/**
 * Append a `state_write_schema_version_violation` event to the activity JSONL
 * file. Inline (no import of activity-logger.ts) to avoid a circular import
 * with `backend-spawn.ts`. Best-effort — never throws.
 */
function emitSchemaVersionViolationActivity(
  statePath: string,
  writtenValue: number,
  maxSupported: number,
): void {
  try {
    const ts = new Date();
    const activityDir = path.join(getDataRoot(), 'activity');
    fs.mkdirSync(activityDir, { recursive: true });
    const event = {
      ts: ts.toISOString(),
      event: 'state_write_schema_version_violation',
      source: 'pickle' as const,
      gate_payload: {
        written_value: writtenValue,
        max_supported: maxSupported,
        statePath,
        caller_pid: process.pid,
      },
    };
    fs.appendFileSync(
      path.join(activityDir, `${formatLocalDateKey(ts)}.jsonl`),
      `${JSON.stringify(event)}\n`,
      { mode: 0o600 },
    );
  } catch (err) {
    try {
      process.stderr.write(
        `[state-manager] failed to log state_write_schema_version_violation: ${safeErrorMessage(err)}\n`,
      );
    } catch { /* stderr closed */ }
  }
}

/**
 * Options for `StateManager.update()` and `StateManager.forceWrite()`. The
 * `_internalSchemaBump` flag is reserved for the legitimate `migrateSchema`
 * path — it bypasses the R-WSRC-1 ceiling guard. No worker code should ever
 * set this flag.
 */
export interface SchemaWriteOpts {
  _internalSchemaBump?: boolean;
}

/**
 * R-WSRC-1: refuse forward-schema writes. Called AFTER the mutator returns
 * and BEFORE any `writeStateFile` invocation in both `update()` and
 * `forceWrite()`. Bypassed only when `opts._internalSchemaBump === true`.
 */
function assertSchemaVersionWithinCeiling(
  statePath: string,
  state: { schema_version?: unknown },
  opts: SchemaWriteOpts | undefined,
): void {
  if (opts && opts._internalSchemaBump === true) return;
  const v = state.schema_version;
  if (v === undefined || v === null) return;
  const num = Number(v);
  if (!Number.isFinite(num)) return;
  if (num > LATEST_SCHEMA_VERSION) {
    emitSchemaVersionViolationActivity(statePath, num, LATEST_SCHEMA_VERSION);
    throw new SchemaVersionAheadError(statePath, num, LATEST_SCHEMA_VERSION);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lockPath(statePath: string): string {
  return `${statePath}.lock`;
}

/** Returns true if process with given pid is currently alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Lock payloads are a bare pid or a small `{pid,ts}` JSON object; 256B covers both with room. */
const LOCK_PAYLOAD_MAX_BYTES = 256;

/** One lock file's identity, age, and holder — all read from a single file descriptor. */
/**
 * An inode NUMBER is not a durable identity for a path that can be deleted and recreated: ext4
 * recycles inode numbers immediately, so a rival's brand-new lock can land on the very number the
 * previous holder's lock had. An ino-only check then reads "still the file I judged" and evicts a
 * LIVE holder — the exact catastrophe this module exists to prevent. (APFS does not recycle that
 * eagerly, which is why this only ever went red on Linux.)
 *
 * So every lock carries a nonce, minted per acquisition by `acquireLockFile` and written as a
 * header line ahead of the caller's payload. Identity is the FULL raw bytes plus the inode; the
 * nonce makes those bytes unique per acquisition even when the same pid re-takes the same path.
 * `payload` stays exactly what the caller wrote, so each caller's own decoder (bare pid,
 * `{pid,ts}` JSON, …) is untouched.
 */
const LOCK_NONCE_PREFIX = '#pk:';

export interface LockSnapshot {
  /** Inode. Necessary for identity, but NOT sufficient — see LOCK_NONCE_PREFIX above. */
  ino: number;
  mtimeMs: number;
  /** The caller's bytes, with our nonce header stripped; each caller decodes its own encoding. */
  payload: string;
  /** Per-acquisition nonce, or null for a lock written without one (legacy / hand-written). */
  nonce: string | null;
  /** Full on-disk bytes. Identity compares THIS, never the inode alone. */
  raw: string;
}

/** What a holder must present to prove the lock it is releasing is still the one it took. */
export interface LockHandle {
  ino: number;
  raw: string;
}

/** True when two views of a path are the same file AND the same acquisition. */
function sameLock(a: { ino: number; raw: string }, b: { ino: number; raw: string }): boolean {
  return a.ino === b.ino && a.raw === b.raw;
}

/**
 * Reads a lock's identity, age, and payload through ONE fd, so a staleness verdict can never be
 * assembled from two different inodes (a path can be re-pointed between two separate reads).
 */
export function inspectLockFile(lockPath: string): LockSnapshot | null {
  let fd: number;
  try {
    fd = fs.openSync(lockPath, 'r');
  } catch {
    return null;
  }

  try {
    const st = fs.fstatSync(fd);
    const buf = Buffer.alloc(LOCK_PAYLOAD_MAX_BYTES);
    const read = fs.readSync(fd, buf, 0, LOCK_PAYLOAD_MAX_BYTES, 0);
    const raw = buf.subarray(0, read).toString('utf-8');

    // Split our nonce header off the caller's payload. A lock without the header (written by an
    // older runtime, or by hand) still inspects fine — it just has no nonce, and identity falls
    // back to raw-bytes equality, which is still strictly stronger than the inode alone.
    let nonce: string | null = null;
    let payload = raw;
    if (raw.startsWith(LOCK_NONCE_PREFIX)) {
      const nl = raw.indexOf('\n');
      if (nl !== -1) {
        nonce = raw.slice(LOCK_NONCE_PREFIX.length, nl);
        payload = raw.slice(nl + 1);
      }
    }

    return { ino: st.ino, mtimeMs: st.mtimeMs, payload, nonce, raw };
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * A private scratch name for one acquire/steal attempt. It must be unique per ATTEMPT, not per
 * process: `acquireLockFile` is synchronous, so two attempts cannot interleave inside one thread —
 * but worker threads share a pid, so keying the name on `process.pid` alone lets two of them open
 * the SAME staging path. The loser truncates the winner's payload and unlinks it underneath them:
 * the `linkSync` then fails ENOENT, or worse, publishes a lock naming the WRONG pid — a live holder
 * whose lock advertises a pid that is already dead, which `isDeadPidPayload` will happily reclaim
 * out from under it. Production spawns one process per writer, so this never fired there; the
 * concurrent-state suite drives it with threads and does.
 */
let attemptSeq = 0;
function stagingSuffix(): string {
  return `${process.pid}.${threadId}.${++attemptSeq}`;
}

/**
 * Takes the lock and returns the handle the caller now owns, or null if someone already holds it.
 * The inode comes from the same fd that wrote the file, so ownership is a fact, not an inference —
 * but the inode NUMBER alone is not identity (see LOCK_NONCE_PREFIX), so the handle carries the
 * raw bytes too, and those bytes are made unique per acquisition by the nonce header.
 *
 * The payload is written to a private staging file and the lock is published by linking it into
 * place — one atomic step, so the lock can never be seen without the pid that holds it. Creating
 * the lock first and writing the pid second leaves a window where it exists EMPTY, and an empty
 * payload is unreclaimable BY DESIGN: `isDeadPidPayload` cannot prove death from it, so a holder
 * killed in that window wedges the lock forever. The gate and restructure locks have no age-based
 * arm to fall back on (they legitimately hold for minutes), so nothing recovers them. Widening the
 * reclaim rule to steal an empty payload is not the fix — a LIVE holder is empty in that same
 * window, so such a steal would evict it.
 */
export function acquireLockFile(lockPath: string, payload: string): LockHandle | null {
  const staging = `${lockPath}.acq.${stagingSuffix()}`;
  const raw = `${LOCK_NONCE_PREFIX}${stagingSuffix()}\n${payload}`;

  try {
    const fd = fs.openSync(staging, 'w');
    let ino: number;
    try {
      fs.writeSync(fd, raw);
      ino = fs.fstatSync(fd).ino;
    } finally {
      fs.closeSync(fd);
    }

    fs.linkSync(staging, lockPath); // publishes the payload with the lock, or EEXIST if held
    return { ino, raw };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw err; // EACCES/ENOENT-on-dir etc. are real faults, not contention
  } finally {
    try { fs.unlinkSync(staging); } catch { /* never created, or already unlinked */ }
  }
}

/** Removes a lock only while it is still the exact acquisition the caller took. */
export function releaseLockFile(lockPath: string, handle: LockHandle): void {
  try {
    const now = inspectLockFile(lockPath);
    // Not ours any more — ours was stolen and someone else acquired. Leave the new holder's lock.
    // Comparing the inode alone would delete it: ext4 hands the recycled number straight back.
    if (!now || !sameLock(now, handle)) return;
    fs.unlinkSync(lockPath);
  } catch { /* already gone */ }
}

/**
 * True only for a payload naming a pid we can PROVE is dead. An empty payload (the holder created
 * the file but died before writing) or an unparseable one is NOT proof, and a recycled pid reads as
 * alive — both defer, so we never steal from a holder we cannot account for.
 */
export function isDeadPidPayload(payload: string): boolean {
  const pid = Number(payload.trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return !isProcessAlive(pid);
}

/**
 * Evicts a lock, refusing anything that is no longer the inode `snapshot` was judged against.
 *
 * The identity check runs against a SECOND LINK to the lock, never against the lock itself. Renaming
 * first means vacating the path before you can see what you captured — and a mismatch cannot then be
 * undone: a contender that acquires in that window makes the restoring `link` fail EEXIST, the
 * cleanup unlinks the file anyway, and the steal has destroyed a lock it neither created nor judged
 * while its rightful holder still believes it owns it. Both then enter the critical section. Linking
 * is non-destructive, so a mismatch costs nothing but our own link: the lock never leaves the
 * namespace, and there is no window for a contender to race into.
 */
export function stealLockFile(lockPath: string, snapshot: LockSnapshot): boolean {
  const tombstone = `${lockPath}.tomb.${stagingSuffix()}`;
  try {
    fs.linkSync(lockPath, tombstone); // a second link — the lock stays published while we judge it
  } catch {
    return false; // already gone
  }

  // Judge the SECOND LINK, never the path — and judge it by full identity, not by inode number.
  // A rival that unlinked the dead lock and acquired its own can land on the very same inode
  // number (ext4 recycles immediately), so an ino-only verdict reads "still the file I judged"
  // and evicts a LIVE holder. The bytes cannot be recycled: they carry a per-acquisition nonce.
  const stolen = inspectLockFile(tombstone);

  try {
    if (!stolen || !sameLock(stolen, snapshot)) return false; // not what we judged — never touched
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false; // holder released it under us — nothing of ours to evict
  } finally {
    try { fs.unlinkSync(tombstone); } catch { /* best-effort */ }
  }
}

/**
 * Runs `steal` holding exclusive stale-recovery rights on `lockPath`.
 *
 * A steal is inspect-then-remove — two operations on a path, not one atomic act — and Node's fs
 * offers no "remove only if still this file". Two stealers running it concurrently is exactly how a
 * LIVE holder gets evicted: both judge the dead holder stale, the first replaces it with its own
 * live lock, and the second's removal lands on THAT. Checking identity before removing does not
 * save you, because both stealers form their verdict before either one acts.
 *
 * So serialize the recovery instead. Inside `steal`, no other process can be removing this lock,
 * and a dead holder cannot release its own — therefore the lock `steal` inspects is necessarily the
 * lock it removes. Returns false without stealing when another process holds the rights; the caller
 * just retries its normal acquire.
 */
export function withStealRight(lockPath: string, steal: () => boolean): boolean {
  const rightsPath = `${lockPath}.steal`;
  let acquired = acquireLockFile(rightsPath, String(process.pid));

  if (acquired === null) {
    // A stealer that died mid-recovery would wedge this path forever. Reclaiming is safe only from a
    // provably dead holder: a live stealer sits in a microsecond-scale critical section, never a dead pid.
    const held = inspectLockFile(rightsPath);
    if (!held || !isDeadPidPayload(held.payload)) return false; // someone is mid-steal — back off
    stealLockFile(rightsPath, held);
    acquired = acquireLockFile(rightsPath, String(process.pid));
    if (acquired === null) return false;
  }

  try {
    return steal();
  } finally {
    releaseLockFile(rightsPath, acquired);
  }
}

function readProcessStartTimeMs(pid: number): number | null {
  try {
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 1000,
    }).trim();
    if (!output) return null;
    const startedAt = Date.parse(output);
    return Number.isFinite(startedAt) ? startedAt : null;
  } catch {
    return null;
  }
}

function shouldSkipLiveTmp(tmpPid: number, tmpPath: string): boolean {
  if (!Number.isFinite(tmpPid) || !isProcessAlive(tmpPid)) return false;
  const processStartTimeMs = readProcessStartTimeMs(tmpPid);
  if (processStartTimeMs === null) return true;
  return readMtimeMs(tmpPath) >= processStartTimeMs;
}

function readMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function readFiniteIteration(state: { iteration?: unknown }): number | null {
  const iteration = Number(state.iteration);
  return Number.isFinite(iteration) ? iteration : null;
}

function writeMigrationStateFile(statePath: string, state: State): void {
  const tmp = `${statePath}.migration.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, statePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

const V3_STATE_SHAPE_MARKERS = [
  'prd_path',
  'start_commit',
  'archaeology',
  'tickets_version',
  'last_course_correction',
  'phase_personas_active',
  'flags',
  'readiness',
  'codex_version_seen',
  'backend',
  'teams_mode',
  'max_parallel',
  'effort',
  'manager_relaunch_count',
  'codex_manager_relaunch_count',
] as const;

function presentV3StateShapeMarkers(state: object): string[] {
  return V3_STATE_SHAPE_MARKERS.filter(field => Object.prototype.hasOwnProperty.call(state, field));
}

/** Parses a session-map entry and returns its pid, or null on invalid input. */
export function readMappedPid(entry: unknown): number | null {
  if (!isRecord(entry) || typeof entry.pid !== 'number') return null;
  const pid = Number(entry.pid);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function readSessionsMapForState(
  statePath: string,
  workingDir: unknown,
): unknown | null {
  if (typeof workingDir !== 'string' || workingDir.trim() === '') return null;
  const sessionDir = path.dirname(statePath);
  const sessionsDir = path.dirname(sessionDir);
  const dataRoot = path.dirname(sessionsDir);
  const sessionsMapPath = path.join(dataRoot, 'current_sessions.json');
  try {
    const map = readRecoverableJsonObject(sessionsMapPath) as Record<string, unknown> | null;
    if (!map || typeof map !== 'object') return null;
    const entry = map[workingDir];
    if (typeof entry === 'string') {
      return path.resolve(entry) === path.resolve(sessionDir) ? entry : null;
    }
    if (!isRecord(entry) || typeof entry.sessionPath !== 'string') return null;
    return path.resolve(entry.sessionPath) === path.resolve(sessionDir) ? entry : null;
  } catch {
    return null;
  }
}

/**
 * True when the activity log already records `event` — the idempotence probe both
 * demotion paths use to avoid re-pushing an entry they already wrote.
 *
 * Reads `ActivityLogEntry.event`, the DECLARED discriminator, not the redundant
 * `kind` mirror the two demotion emitters also write. `kind` is undeclared (it
 * rides the interface's index signature) and those two emitters are its only
 * producers in the activity domain — every other activity probe in the codebase,
 * including this module's own `warnUnknownActivityEvents` and `trimActivityRing`,
 * keys on `event` via the same `isRecord` guard used here. A
 * future emitter that follows the type would set `event` alone and be invisible
 * to a `kind`-keyed probe. Both fields have been written together at every
 * emission site since the paths were introduced, so this is behaviour-identical
 * for every entry that can exist on disk; the `kind` mirror stays because
 * AC-PSO-03 pins it.
 */
function hasActivityEvent(activity: State['activity'], event: string): boolean {
  return Array.isArray(activity) && activity.some(a => isRecord(a) && a.event === event);
}

/**
 * Evaluates whether a paused session qualifies for orphan demotion.
 * Demotion requires BOTH conditions: the state is age-stale (≥5 min untouched)
 * AND the mapped session-map PID is dead. Either condition alone is insufficient
 * signal — a healthy session whose launch-shell PID has merely rolled over is
 * not an orphan.
 */
function getPausedOrphanDemotion(statePath: string, state: State, preMigrationMtimeMs: number): {
  ageMs: number;
  mappedPid: number | null;
  shouldDemote: boolean;
} {
  const ageMs = preMigrationMtimeMs > 0 ? Date.now() - preMigrationMtimeMs : Infinity;
  const mappedPid = readMappedPid(readSessionsMapForState(statePath, state.working_dir));
  const deadMappedPid = mappedPid !== null && !isProcessAlive(mappedPid);
  return {
    ageMs,
    mappedPid,
    shouldDemote: ageMs >= 300_000 && deadMappedPid,
  };
}

export class InvalidActivityEventError extends Error {
  readonly event: string;

  constructor(event: string) {
    super(`Invalid activity event: ${event}`);
    this.name = 'InvalidActivityEventError';
    this.event = event;
  }
}

function isValidActivityEvent(event: string): boolean {
  return (VALID_ACTIVITY_EVENTS as readonly string[]).includes(event);
}

function warnUnknownActivityEvents(state: State): void {
  if (!Array.isArray(state.activity)) return;

  for (const entry of state.activity) {
    if (!isRecord(entry) || typeof entry.event !== 'string') continue;
    if (isValidActivityEvent(entry.event)) continue;
    process.stderr.write(`WARN: ignoring unknown activity event ${entry.event}\n`);
  }
}

function assertValidActivityEvent(entry: ActivityLogEntry): void {
  if (!isValidActivityEvent(entry.event)) {
    throw new InvalidActivityEventError(entry.event);
  }
}

// ---------------------------------------------------------------------------
// D2 (84c209ae): bounded activity ring
// ---------------------------------------------------------------------------

/**
 * Write-side ceiling for `state.activity`. The phantom-Done backfill loop
 * (B-PDBL D1) grew the array to 7021 entries / 1.9MB heading for a 20MB freeze
 * because there was no write-side cap (only read-side guards). This bounds every
 * write regardless of caller.
 */
const ACTIVITY_RING_MAX = 2000;

/**
 * Eviction-exempt recovery events: never dropped even when oldest. The predicate
 * matches on the event NAME:
 *   - `rate_limit_*`     (prefix) — rate-limit park/resume/wait/exhaustion
 *   - `*_quarantined`    (suffix) — crashed-ticket-files quarantine forensics
 *   - `ticket_ladder_exhausted` (exact) — terminal ladder-exhaustion marker
 */
function isExemptActivityEvent(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  return name.startsWith('rate_limit_') ||
    name.endsWith('_quarantined') ||
    name === 'ticket_ladder_exhausted';
}

/**
 * Enforce `state.activity.length <= ACTIVITY_RING_MAX` via drop-oldest, skipping
 * exempt entries. Evicts the oldest NON-exempt entries first, preserving order.
 * Edge case: if every over-cap entry is exempt, they are kept (best-effort cap
 * over evictable entries — exempt recovery events are never lost).
 */
function trimActivityRing(state: { activity?: unknown }): void {
  const activity = state.activity;
  if (!Array.isArray(activity) || activity.length <= ACTIVITY_RING_MAX) return;

  let toDrop = activity.length - ACTIVITY_RING_MAX;
  const kept: unknown[] = [];
  for (const entry of activity) {
    const eventName = isRecord(entry) ? entry.event : undefined;
    if (toDrop > 0 && !isExemptActivityEvent(eventName)) {
      toDrop--;
      continue;
    }
    kept.push(entry);
  }
  state.activity = kept;
}

function normalizeV3StateDefaults(state: State): void {
  state.archaeology ??= null;
  if (typeof state.tickets_version !== 'number' || !Number.isFinite(state.tickets_version)) {
    state.tickets_version = 0;
  }
  state.last_course_correction ??= null;
  if (typeof state.phase_personas_active !== 'boolean') state.phase_personas_active = false;
  if (typeof state.pipeline_continue_on_phase_fail !== 'boolean') state.pipeline_continue_on_phase_fail = true;
  if (!isRecord(state.flags)) state.flags = {};

  if (!isRecord(state.readiness)) {
    state.readiness = { cycle_history: [] };
  } else if (!Array.isArray(state.readiness.cycle_history)) {
    state.readiness.cycle_history = [];
  }

  if (typeof state.codex_version_seen !== 'string') state.codex_version_seen = null;
  if (!Array.isArray(state.monitor_panes) || state.monitor_panes.length !== 4) {
    state.monitor_panes = [
      { producer_done: false },
      { producer_done: false },
      { producer_done: false },
      { producer_done: false },
    ];
  }
  const smExt = state as unknown as Record<string, unknown>;
  if (smExt.monitor_pid === undefined) smExt.monitor_pid = null;
  if (smExt.monitor_mode === undefined) smExt.monitor_mode = null;
}

function normalizeV4StateDefaults(state: State): void {
  if (!Array.isArray(state.orphans_detected)) state.orphans_detected = [];
  if (state.parent_session_hash === undefined) state.parent_session_hash = null;
  if (state.invocation_source === undefined) state.invocation_source = 'operator';
}

function normalizeV5StateDefaults(state: State): void {
  if (!isRecord(state.worker_artifact_progress)) state.worker_artifact_progress = {};
  if (typeof state.codex_manager_consecutive_no_progress !== 'number') state.codex_manager_consecutive_no_progress = 0;
  if (!Array.isArray(state.recovery_attempts)) state.recovery_attempts = [];
}

function normalizeUpToVersion(state: State, schemaVersion: number): void {
  if (schemaVersion >= 3) normalizeV3StateDefaults(state);
  if (schemaVersion >= 4) normalizeV4StateDefaults(state);
  if (schemaVersion >= 5) normalizeV5StateDefaults(state);
}

function readFiniteCount(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function migrateLegacyManagerRelaunchCount(state: State): boolean {
  const canonical = readFiniteCount(state.manager_relaunch_count);
  const legacy = readFiniteCount(state.codex_manager_relaunch_count);

  if (canonical !== null) {
    if (state.codex_manager_relaunch_count !== undefined) {
      delete state.codex_manager_relaunch_count;
      return true;
    }
    return false;
  }

  if (legacy === null) return false;
  state.manager_relaunch_count = legacy;
  delete state.codex_manager_relaunch_count;
  return true;
}

function migrateLegacySignalExitReason(state: State): boolean {
  if (state.exit_reason === 'signal') {
    state.exit_reason = 'signal:SIGINT';
    return true;
  }
  return false;
}

function migrateLegacyBaselineExitReason(state: State): boolean {
  if (state.exit_reason === 'baseline_unmeasurable') {
    state.exit_reason = 'baseline_unmeasurable_unrecoverable';
    return true;
  }
  return false;
}

function isStateSnapshotNewer(
  currentState: { iteration?: unknown },
  currentMtimeMs: number,
  candidateState: { iteration?: unknown },
  candidateMtimeMs: number,
): boolean {
  const currentIteration = readFiniteIteration(currentState);
  const candidateIteration = readFiniteIteration(candidateState);

  // Iteration-first precedence: a higher-iteration snapshot wins regardless of mtime.
  if (candidateIteration !== null && currentIteration !== null) {
    if (candidateIteration !== currentIteration) {
      return candidateIteration > currentIteration;
    }
    // R-CIFB-B: equal iteration → mtime tie-break with candidate (tmp) winning ties
    // (`>=`). An orphan .tmp.<pid> is written after its base, so on a coarse-mtime
    // FS tie it is the more-recent intent. Consistent with recoverable-json parseDeadTmp.
    return candidateMtimeMs >= currentMtimeMs;
  }

  if (candidateIteration !== null) return true;
  if (currentIteration !== null) return false;
  // R-CIFB-B: both iterations absent → mtime tie-break, candidate (tmp) wins ties (`>=`).
  return candidateMtimeMs >= currentMtimeMs;
}

function unlinkQuietly(filePath: string): void {
  try { fs.unlinkSync(filePath); } catch { /* best-effort cleanup */ }
}

/**
 * Enumerate the orphan `.tmp.<pid>` siblings of `statePath` whose owning process is gone.
 * Shared by both recovery scanners so neither can drift its own notion of what an orphan is.
 */
function listDeadOrphanTmpPaths(statePath: string): string[] {
  const dir = path.dirname(statePath);
  const base = path.basename(statePath);

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const tmpPattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.tmp\\.(\\d+)(?:\\..*)?$`);
  const tmpPaths: string[] = [];

  for (const entry of entries) {
    const match = entry.match(tmpPattern);
    if (!match) continue;
    const tmpPath = path.join(dir, entry);
    if (shouldSkipLiveTmp(Number(match[1]), tmpPath)) continue;
    tmpPaths.push(tmpPath);
  }
  return tmpPaths;
}

type OrphanTmpClassification =
  | { kind: 'unreadable' }
  | { kind: 'garbage' }
  | { kind: 'snapshot'; state: State; mtimeMs: number };

/**
 * The single delete-authority decision for an orphan `.tmp.<pid>`.
 *
 * A tmp we could not READ is not the same as a tmp we read and found to be garbage:
 * an EACCES/EISDIR snapshot may hold the only copy of a newer state write, and once
 * unlinked the operator has nothing left to repair permissions on. Only a positively
 * proven-garbage tmp (readable AND unparseable, or not a valid snapshot) is reapable.
 */
function classifyOrphanTmp(
  tmpPath: string,
  maxSupportedSchemaVersion: number,
): OrphanTmpClassification {
  let raw: string;
  try {
    raw = fs.readFileSync(tmpPath, 'utf-8');
  } catch {
    return { kind: 'unreadable' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'garbage' };
  }

  if (!isRecoverableStateSnapshotCandidate(parsed, maxSupportedSchemaVersion)) {
    return { kind: 'garbage' };
  }
  return { kind: 'snapshot', state: parsed, mtimeMs: readMtimeMs(tmpPath) };
}

function isRecoverableStateSnapshotCandidate(
  value: unknown,
  maxSupportedSchemaVersion: number,
): value is State {
  if (!isRecord(value)) return false;
  const requiredStringFields = ['working_dir', 'original_prompt', 'started_at', 'session_dir'] as const;
  if (requiredStringFields.some((field) => typeof value[field] !== 'string')) return false;
  if (!(typeof value.step === 'string' || value.step === null)) return false;
  if (!Number.isFinite(Number(value.iteration))) return false;
  if (!Number.isFinite(Number(value.max_iterations))) return false;
  if (!Number.isFinite(Number(value.max_time_minutes))) return false;
  if (!Number.isFinite(Number(value.worker_timeout_seconds))) return false;
  if (!Number.isFinite(Number(value.start_time_epoch))) return false;
  if (!Array.isArray(value.history)) return false;
  if (!('completion_promise' in value)) return false;
  if (
    value.schema_version !== undefined &&
    (!Number.isFinite(Number(value.schema_version)) || Number(value.schema_version) > maxSupportedSchemaVersion)
  ) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// StateManager
// ---------------------------------------------------------------------------

export class StateManager {
  private readonly opts: StateManagerOptions;

  /** Lock path -> the inode this manager acquired, so release can prove the file is still ours. */
  private readonly lockHandles = new Map<string, LockHandle>();

  constructor(opts: Partial<StateManagerOptions> = {}) {
    this.opts = { ...STATE_MANAGER_DEFAULTS, ...opts };
  }

  // -----------------------------------------------------------------------
  // read — parse, migrate schema, run recovery protocol
  // -----------------------------------------------------------------------

  read(statePath: string): State {
    const raw = this.readRawStateFile(statePath);
    const state = this.parseStateOrRecover(statePath, raw);

    // Future schema versions cannot be safely read by older code — throw.
    // Past schema versions (state < current) are tolerated: unknown fields are ignored.
    if (state.schema_version !== undefined && state.schema_version > this.opts.schemaVersion) {
      throw new StateError(
        'SCHEMA_MISMATCH',
        `State file schema_version ${state.schema_version} is newer than supported version ${this.opts.schemaVersion}`,
      );
    }

    this.assertReadableMissingSchemaShape(statePath, state);

    // Capture mtime before recovery/migration can rewrite the file.
    const preMigrationMtimeMs = readMtimeMs(statePath);

    // --- Recovery protocol ---
    this.recoverOrphanTmpFiles(statePath, state);

    this.migrateSchema(statePath, state);

    this.recoverStaleActiveFlag(statePath, state, preMigrationMtimeMs);

    warnUnknownActivityEvents(state);

    return state;
  }

  /** Read `statePath`'s bytes, or throw `MISSING` — absent and unreadable are the same verdict. */
  private readRawStateFile(statePath: string): string {
    if (!fs.existsSync(statePath)) {
      throw new StateError('MISSING', `State file not found: ${statePath}`);
    }

    try {
      return fs.readFileSync(statePath, 'utf-8');
    } catch (err) {
      const msg = safeErrorMessage(err);
      throw new StateError('MISSING', `Cannot read state file: ${msg}`);
    }
  }

  /** Parse the base file; on either corruption shape, fall back to orphan-tmp recovery. */
  private parseStateOrRecover(statePath: string, raw: string): State {
    let state: State;
    try {
      state = JSON.parse(raw) as State;
    } catch (err) {
      const msg = safeErrorMessage(err);
      return this.recoverCorruptBaseOrThrow(statePath, `Invalid JSON in state file: ${msg}`);
    }

    if (state === null || typeof state !== 'object' || Array.isArray(state)) {
      return this.recoverCorruptBaseOrThrow(statePath, 'State file does not contain a JSON object');
    }

    return state;
  }

  /**
   * `recoverFromOrphanTmpWhenBaseCorrupt` is a PROMOTION seam, not a query — it `renameSync`s a
   * newer dead-writer `.tmp.<pid>` over the corrupt base. Call it unconditionally on every
   * corruption path; short-circuiting it silently strands the only readable copy of the state.
   */
  private recoverCorruptBaseOrThrow(statePath: string, message: string): State {
    const recovered = this.recoverFromOrphanTmpWhenBaseCorrupt(statePath);
    if (recovered) return recovered;
    throw new StateError('CORRUPT', message);
  }

  private assertReadableMissingSchemaShape(statePath: string, state: State): void {
    if (state.schema_version !== undefined || this.opts.schemaVersion >= 3) return;

    const markers = presentV3StateShapeMarkers(state);
    if (markers.length === 0) return;

    throw new StateError(
      'SCHEMA_MISMATCH',
      `State file ${statePath} appears to use schema v3 fields (${markers.join(', ')}) but is missing schema_version; ` +
      `this deployment supports schema_version ${this.opts.schemaVersion}. ` +
      'Recover by running a current Pickle Rick runtime or restoring a pre-v3 state backup.',
    );
  }

  private migrateSchema(statePath: string, state: State): void {
    if (state.schema_version === undefined) {
      state.schema_version = 1;
      process.stderr.write(`[state-manager] schema_version missing in ${statePath} — migrating to 1\n`);
      // Best-effort persist migration — don't throw if write fails
      normalizeUpToVersion(state, this.opts.schemaVersion);
      migrateLegacyManagerRelaunchCount(state);
      migrateLegacySignalExitReason(state);
      migrateLegacyBaselineExitReason(state);
      try { writeMigrationStateFile(statePath, state); } catch { /* migration write failed, non-fatal */ }
    }

    if (state.schema_version > this.opts.schemaVersion) {
      throw new StateError(
        'SCHEMA_MISMATCH',
        `State file schema_version ${state.schema_version} is newer than supported version ${this.opts.schemaVersion}`,
      );
    }

    if (state.schema_version < this.opts.schemaVersion) {
      state.schema_version = this.opts.schemaVersion;
      normalizeUpToVersion(state, this.opts.schemaVersion);
      migrateLegacyManagerRelaunchCount(state);
      migrateLegacySignalExitReason(state);
      migrateLegacyBaselineExitReason(state);
      process.stderr.write(`[state-manager] migrating ${statePath} to schema_version ${this.opts.schemaVersion}\n`);
      try { writeMigrationStateFile(statePath, state); } catch { /* migration write failed, non-fatal */ }
    } else if (state.schema_version >= 3) {
      const missingPipelineContinueOnPhaseFail = typeof state.pipeline_continue_on_phase_fail !== 'boolean';
      normalizeUpToVersion(state, state.schema_version);
      const didMigrateRelaunch = migrateLegacyManagerRelaunchCount(state);
      const didMigrateSignal = migrateLegacySignalExitReason(state);
      if (missingPipelineContinueOnPhaseFail || didMigrateRelaunch || didMigrateSignal) {
        try { writeMigrationStateFile(statePath, state); } catch { /* migration write failed, non-fatal */ }
      }
      migrateLegacyBaselineExitReason(state);
    }
  }

  // -----------------------------------------------------------------------
  // update — lock, read, mutate, write, unlock
  // -----------------------------------------------------------------------

  update(statePath: string, mutator: (state: State) => void, opts?: SchemaWriteOpts): State {
    this.acquireLock(statePath);
    try {
      const state = this.read(statePath);
      mutator(state);
      // D2 (84c209ae): bound state.activity on every write (drop-oldest, exempt-safe).
      trimActivityRing(state);
      // R-WSRC-1: refuse forward-schema writes from workers. EXEMPTION via
      // opts._internalSchemaBump for the legitimate migrateSchema path only.
      assertSchemaVersionWithinCeiling(statePath, state, opts);
      writeStateFile(statePath, state);
      return state;
    } finally {
      this.releaseLock(statePath);
    }
  }

  // -----------------------------------------------------------------------
  // transaction — lock all paths, read all, mutate, write all (with rollback)
  // -----------------------------------------------------------------------

  transaction(paths: string[], mutator: (states: State[]) => void): State[] {
    const sorted = [...paths].sort(); // consistent order prevents cross-tx deadlock
    const lockedPaths = this.acquireAllLocks(sorted);

    try {
      const states = sorted.map(p => this.read(p));
      const snapshotSchemaVersions = states.map(state => state.schema_version ?? 1);
      mutator(states);
      this.writeAllWithRollback(sorted, states, snapshotSchemaVersions);
      return paths.map(p => states[sorted.indexOf(p)]);
    } finally {
      for (const p of lockedPaths) this.releaseLock(p);
    }
  }

  private acquireAllLocks(sorted: string[]): string[] {
    const locked: string[] = [];
    try {
      for (const p of sorted) {
        this.acquireLock(p);
        locked.push(p);
      }
      return locked;
    } catch (err) {
      for (const p of locked) this.releaseLock(p);
      throw err;
    }
  }

  private writeAllWithRollback(sorted: string[], states: State[], snapshotSchemaVersions: number[]): void {
    const originals = sorted.map(p => ({ path: p, backup: fs.readFileSync(p, 'utf-8') }));
    const written: string[] = [];
    try {
      for (let i = 0; i < sorted.length; i++) {
        this.assertOnDiskSchemaNotNewer(sorted[i], snapshotSchemaVersions[i]);
        writeStateFile(sorted[i], states[i]);
        written.push(sorted[i]);
      }
    } catch (writeErr) {
      if (writeErr instanceof SchemaVersionMismatchError) throw writeErr;
      const rollbackErrors: Error[] = [];
      for (const wp of written) {
        const orig = originals.find(o => o.path === wp);
        if (!orig) continue;
        try {
          writeStateFile(wp, JSON.parse(orig.backup));
        } catch (rbErr) {
          rollbackErrors.push(rbErr instanceof Error ? rbErr : new Error(String(rbErr)));
        }
      }
      throw new TransactionError(`Transaction write failed: ${safeErrorMessage(writeErr)}`, rollbackErrors);
    }
  }

  private assertOnDiskSchemaNotNewer(statePath: string, cachedVersion: number): void {
    let onDisk: { schema_version?: unknown };
    try {
      onDisk = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as { schema_version?: unknown };
    } catch {
      return;
    }

    const onDiskVersion = Number(onDisk.schema_version ?? 1);
    if (!Number.isFinite(onDiskVersion) || onDiskVersion <= cachedVersion) return;
    throw new SchemaVersionMismatchError(statePath, onDiskVersion, cachedVersion);
  }

  // -----------------------------------------------------------------------
  // forceWrite — best-effort, no lock, never throws
  // -----------------------------------------------------------------------

  forceWrite(statePath: string, state: State | object, opts?: SchemaWriteOpts): void {
    // R-WSRC-1: refuse forward-schema writes BEFORE any tmp-rename in
    // writeStateFile. EXEMPTION via opts._internalSchemaBump for legitimate
    // migrateSchema path only. The assertion throws SchemaVersionAheadError
    // which propagates out of forceWrite — callers (signal handlers, halt
    // paths) MUST be prepared to surface this as a forensic failure. Other
    // write errors continue to be swallowed per the existing contract.
    // D2 (84c209ae): bound state.activity on every write (drop-oldest, exempt-safe).
    trimActivityRing(state as { activity?: unknown });
    try {
      assertSchemaVersionWithinCeiling(statePath, state as { schema_version?: unknown }, opts);
    } catch (err) {
      if (err instanceof SchemaVersionAheadError) throw err;
      // unreachable — assertSchemaVersionWithinCeiling only throws SchemaVersionAheadError
    }
    try {
      writeStateFile(statePath, state);
    } catch (err) {
      // Never throw — halt paths and signal handlers depend on this. But the
      // operator needs a breadcrumb when persistence silently drops (orphaned
      // active flags, lost microverse iterations). Stderr emission is guarded
      // so a closed pipe can't break the contract.
      try {
        process.stderr.write(
          `[state-manager] forceWrite failed for ${statePath}: ${safeErrorMessage(err)}\n`,
        );
      } catch { /* stderr closed/unavailable — truly nothing to do */ }
    }
  }

  // -----------------------------------------------------------------------
  // Lock acquisition with exponential backoff + jitter
  // -----------------------------------------------------------------------

  private acquireLock(statePath: string): void {
    const lp = lockPath(statePath);
    let steals = 0;
    const maxSteals = 3; // Cap stale-steal retries to prevent unbounded loops

    for (let attempt = 0; attempt <= this.opts.maxLockRetries; attempt++) {
      const held = acquireLockFile(lp, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      if (held !== null) {
        this.lockHandles.set(lp, held); // release must prove it still owns this exact acquisition
        return;
      }

      // Check if existing lock is stale (bounded steal attempts)
      if (steals < maxSteals && this.tryStealStaleLock(lp)) {
        steals++;
        // Stolen — retry immediately (don't count as attempt)
        attempt--;
        continue;
      }

      if (attempt < this.opts.maxLockRetries) {
        const base = this.opts.baseLockDelayMs * Math.pow(2, attempt);
        const jitter = this.opts.lockJitter ? Math.random() * this.opts.baseLockDelayMs : 0;
        sleepSync(Math.min(base + jitter, 5000));
      }
    }

    throw new LockError(`Failed to acquire lock after ${this.opts.maxLockRetries} retries: ${lp}`);
  }

  private releaseLock(statePath: string): void {
    const lp = lockPath(statePath);
    const held = this.lockHandles.get(lp);
    if (held === undefined) return; // never acquired it
    this.lockHandles.delete(lp);
    releaseLockFile(lp, held);
  }

  private isStaleLockSnapshot(snapshot: LockSnapshot): boolean {
    try {
      const lock = JSON.parse(snapshot.payload) as { pid: number; ts: number };
      const lockPid = Number(lock.pid);
      const lockTs = Number(lock.ts);

      if (!Number.isFinite(lockPid) || !Number.isFinite(lockTs)) return true;
      return !isProcessAlive(lockPid) || (Date.now() - lockTs > this.opts.staleLockTimeoutMs);
    } catch {
      // Corrupt JSON — safe to steal
      return true;
    }
  }

  private tryStealStaleLock(lp: string): boolean {
    return withStealRight(lp, () => {
      const snapshot = inspectLockFile(lp);
      if (!snapshot) return false; // can't read — holder may have released it already
      if (!this.isStaleLockSnapshot(snapshot)) return false;
      return stealLockFile(lp, snapshot);
    });
  }

  private recoverFromOrphanTmpWhenBaseCorrupt(statePath: string): State | null {
    let winner: { tmpPath: string; state: State; mtimeMs: number } | null = null;

    for (const tmpPath of listDeadOrphanTmpPaths(statePath)) {
      const candidate = classifyOrphanTmp(tmpPath, this.opts.schemaVersion);
      if (candidate.kind !== 'snapshot') continue;

      if (
        !winner ||
        isStateSnapshotNewer(winner.state, winner.mtimeMs, candidate.state, candidate.mtimeMs)
      ) {
        winner = { tmpPath, state: candidate.state, mtimeMs: candidate.mtimeMs };
      }
    }

    if (!winner) return null;

    try {
      fs.renameSync(winner.tmpPath, statePath);
      return winner.state;
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Recovery: orphan tmp files
  // -----------------------------------------------------------------------

  private recoverOrphanTmpFiles(statePath: string, _state: State): void {
    let currentMtimeMs = readMtimeMs(statePath);

    for (const tmpPath of listDeadOrphanTmpPaths(statePath)) {
      const candidate = classifyOrphanTmp(tmpPath, this.opts.schemaVersion);

      // Unreadable is not proven-garbage: it may hold the only copy of a newer write.
      if (candidate.kind === 'unreadable') continue;

      if (candidate.kind === 'garbage') {
        unlinkQuietly(tmpPath);
        continue;
      }

      // Promote a dead-process snapshot if it represents a newer state write.
      // Same-iteration tmpfiles happen when control-flow fields (active/backend/
      // working_dir/session_dir) change without incrementing iteration.
      if (!isStateSnapshotNewer(_state, currentMtimeMs, candidate.state, candidate.mtimeMs)) {
        unlinkQuietly(tmpPath);
        continue;
      }

      // A promotion that fails leaves the snapshot in place — never reap what we
      // just judged to be the newer state.
      try {
        fs.renameSync(tmpPath, statePath);
      } catch {
        continue;
      }
      Object.assign(_state, candidate.state);
      currentMtimeMs = readMtimeMs(statePath);
    }
  }

  // -----------------------------------------------------------------------
  // Recovery: stale active flag
  // -----------------------------------------------------------------------

  /**
   * Phantom demotion: active=true, pid=null, tmux_mode=false, iteration=0, history=[]
   * → session was never claimed by any runner; demote immediately, bypassing the 300s age gate.
   * The FULL conjunction is required; any one of tmux_mode/iteration/history exempts the session.
   * Returns true iff the session matches the phantom signature (already-demoted or just demoted),
   * meaning the caller must NOT fall through to the age-gated paused-orphan path.
   */
  private demotePhantomSession(statePath: string, state: State): boolean {
    if (
      state.tmux_mode === true ||
      state.iteration !== 0 ||
      !Array.isArray(state.history) ||
      state.history.length !== 0
    ) {
      return false;
    }
    if (hasActivityEvent(state.activity, 'orphan_phantom_demoted')) return true;
    state.active = false;
    state.exit_reason = 'orphan_phantom_demoted';
    state.activity = state.activity ?? [];
    state.activity.push({
      event: 'orphan_phantom_demoted',
      kind: 'orphan_phantom_demoted',
      ts: new Date().toISOString(),
    });
    trimActivityRing(state); // D2 (84c209ae): bound the ring at this direct-write site too.
    try { writeStateFile(statePath, state); } catch { /* best-effort */ }
    return true;
  }

  private recoverStaleActiveFlag(statePath: string, state: State, preMigrationMtimeMs = 0): void {
    if (state.active !== true) return;

    if (state.pid === undefined || state.pid === null) {
      // Phantom demotion bypasses the 300s age gate; if it claimed the session, stop here.
      if (this.demotePhantomSession(statePath, state)) return;

      // Paused-orphan demotion: no process ever claimed this session (pid=null).
      // If the state file is stale (>5 min), or its mapped owner PID is dead,
      // it will never be claimed — demote.
      if (hasActivityEvent(state.activity, 'paused_session_orphan_demoted')) return;
      const demotion = getPausedOrphanDemotion(statePath, state, preMigrationMtimeMs);
      if (!demotion.shouldDemote) return;
      state.active = false;
      state.exit_reason = 'orphan-paused-no-claim';
      state.activity = state.activity ?? [];
      state.activity.push({
        event: 'paused_session_orphan_demoted',
        kind: 'paused_session_orphan_demoted',
        pid_orig: null,
        mtime_age_seconds: Math.floor(demotion.ageMs / 1000),
        mapped_pid: demotion.mappedPid,
        ts: new Date().toISOString(),
      });
      trimActivityRing(state); // D2 (84c209ae): bound the ring at this direct-write site too.
      try { writeStateFile(statePath, state); } catch { /* best-effort */ }
      return;
    }

    const pid = Number(state.pid);
    if (!Number.isFinite(pid) || pid <= 0) return;

    if (!isProcessAlive(pid)) {
      state.active = false;
      trimActivityRing(state); // D2 (84c209ae): bound the ring at this direct-write site too.
      try { writeStateFile(statePath, state); } catch { /* best-effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton for standalone helpers
// ---------------------------------------------------------------------------

const _sm = new StateManager();

/**
 * Try `_sm.update` (locked); on failure, fall back to read-then-forceWrite. If the
 * read/parse also fails and `fallbackFactory` is provided, forceWrite that seed;
 * otherwise no write occurs. Never throws.
 */
function forceWriteMutate(
  statePath: string,
  mutator: (state: State) => void,
  fallbackFactory: (() => State | object) | null,
): void {
  try {
    _sm.update(statePath, mutator);
    return;
  } catch { /* fall through to best-effort path */ }

  let seed: State | object | null = null;
  try {
    const parsed = _sm.read(statePath);
    mutator(parsed);
    seed = parsed;
  } catch {
    if (fallbackFactory) seed = fallbackFactory();
  }
  if (seed !== null) _sm.forceWrite(statePath, seed);
}

/** Deactivate with retry-then-forceWrite: try update, fall back to read-then-forceWrite. Never throws. */
export function safeDeactivate(statePath: string): void {
  forceWriteMutate(
    statePath,
    s => { s.active = false; },
    () => ({ active: false }),
  );
}

export interface FinalizeOpts {
  step?: 'completed';
  runnerIteration?: number;
  exitReason?: string;
}

/**
 * R-CNAR-8: single source of truth for the per-ticket cache fields that MUST be
 * cleared atomically whenever `current_ticket` is nulled. Stale values here trip
 * `iteration_cap_exhausted` on `--resume` of the same session.
 */
function clearCurrentTicketCache(s: State): void {
  delete s.current_ticket_tier;
  delete s.current_ticket_budget;
  delete s.current_ticket_max_iterations;
  delete s.current_ticket_worker_timeout_seconds;
  delete s.current_ticket_budget_start_iteration;
}

/**
 * Finalize a terminal-success exit: deactivate, set step='completed',
 * null current_ticket, reconcile iteration to the runner's outer-loop count,
 * stamp exit_reason for forensics. Never throws — terminal paths must not
 * fail on logging. Use for clean-success exits (EPIC_COMPLETED, review_clean,
 * max_iterations limit, max_time limit, microverse converged/stopped, jar
 * task success). Use safeDeactivate for forensic paths (circuit_open, stall,
 * crash) where preserving step/current_ticket matters.
 */
export function finalizeTerminalState(statePath: string, opts: FinalizeOpts = {}): void {
  forceWriteMutate(
    statePath,
    s => {
      s.active = false;
      if (opts.step) s.step = opts.step;
      s.current_ticket = null;
      // R-CNAR-8: nulling current_ticket REQUIRES atomic clear of the cache
      // fields. Forensic origin: bundle session 2026-05-04-f416c6cc run #6
      // attempt 1.
      clearCurrentTicketCache(s);
      if (typeof opts.runnerIteration === 'number' && Number.isFinite(opts.runnerIteration)) {
        s.iteration = opts.runnerIteration;
      }
      if (opts.exitReason) s.exit_reason = opts.exitReason;
    },
    () => ({ active: false, step: opts.step ?? 'completed', current_ticket: null }),
  );
}

// ---------------------------------------------------------------------------
// B-GROUND2 WS1: the single by-invariant completion / phase-graduation authority.
// ---------------------------------------------------------------------------

/** Ground-truth ticket counts a caller scans before any more-complete transition. */
export interface GraduationCounts {
  /** Tickets whose frontmatter status normalizes to `done`. */
  doneCount: number;
  /** Commits landed since the session start commit (degrades to 0 on git failure). */
  commitCount: number;
  /** Tickets still runnable: not Done, not Skipped. */
  pendingCount: number;
  /** Full roster size discovered under the session dir. */
  ticketCount: number;
}

export type GraduationDecision =
  | { decision: 'graduate' }
  | { decision: 'halt'; reason: 'phase_no_progress' | 'pipeline_phase_incomplete' };

/**
 * The ONE proportional graduation gate. Keys on REAL progress
 * (`doneCount + commitCount`), NEVER the bare `pendingCount / ticketCount`
 * ratio — that ratio skip-dampens (Skipped tickets are excluded from
 * `pendingCount` but counted in `ticketCount`, so 22-skip/2-todo/0-done would
 * graduate under any ratio threshold).
 *
 * The breaker term is deliberately ABSENT: this predicate is by-invariant on
 * the counts alone. A breaker-trip / error exit reaches the same gate as a
 * clean exit — callers MUST run it on ALL exit codes and MUST NOT substitute
 * `exitCode !== 0` as a breaker proxy.
 *
 * Decision:
 *   - `ticketCount <= 0`  → graduate (never-decomposed / dispatch-only carve-out).
 *   - `pendingCount === 0`→ graduate (all tickets Done or Skipped — terminal).
 *   - else, 0 Done + 0 commits → halt `phase_no_progress`.
 *   - else (partial progress, pending remain) → halt `pipeline_phase_incomplete`.
 */
export function graduationDecision(counts: GraduationCounts): GraduationDecision {
  if (counts.ticketCount <= 0) { return { decision: 'graduate' }; }
  if (counts.pendingCount === 0) { return { decision: 'graduate' }; }
  if (counts.doneCount === 0 && counts.commitCount === 0) {
    return { decision: 'halt', reason: 'phase_no_progress' };
  }
  return { decision: 'halt', reason: 'pipeline_phase_incomplete' };
}

export interface FinalizeIfTrulyCompleteResult {
  finalized: boolean;
  /** When `finalized === false`, the incomplete exit_reason stamped (fail-closed). */
  reason?: 'phase_no_progress' | 'pipeline_phase_incomplete';
}

/**
 * The SINGLE sanctioned wrapper over `finalizeTerminalState({ step: 'completed' })`
 * for ticket-bundle finalizes. Re-scans frontmatter ground truth via the injected
 * `scan` probe (mux seam: `reconcileTicketTruth`-derived counts; pipeline seam:
 * `collectPicklePhaseProgress`-derived counts) and REFUSES the transition while
 * real work is pending.
 *
 * Fail-CLOSED: if `scan` throws, times out, or returns `null` (an empty/all-zero
 * roster where a roster was expected), treat the phase as INCOMPLETE — refuse the
 * transition, stamp `pipeline_phase_incomplete`, and route the caller to recovery.
 *
 * Never throws — terminal/forensic paths must not fail on logging.
 */
export function finalizeIfTrulyComplete(
  statePath: string,
  scan: () => GraduationCounts | null,
  opts: FinalizeOpts = {},
): FinalizeIfTrulyCompleteResult {
  let counts: GraduationCounts | null;
  try {
    counts = scan();
  } catch {
    // Fail-closed: a throwing/timed-out scan is treated as INCOMPLETE.
    emitCompletionFinalizeRefused({ pending_count: -1, ticket_count: -1, seam: 'scan_threw' });
    recordExitReason(statePath, 'pipeline_phase_incomplete');
    return { finalized: false, reason: 'pipeline_phase_incomplete' };
  }
  if (counts === null) {
    emitCompletionFinalizeRefused({ pending_count: -1, ticket_count: -1, seam: 'scan_null' });
    recordExitReason(statePath, 'pipeline_phase_incomplete');
    return { finalized: false, reason: 'pipeline_phase_incomplete' };
  }
  const verdict = graduationDecision(counts);
  if (verdict.decision === 'halt') {
    emitCompletionFinalizeRefused({
      pending_count: counts.pendingCount,
      ticket_count: counts.ticketCount,
      seam: verdict.reason,
    });
    recordExitReason(statePath, verdict.reason);
    return { finalized: false, reason: verdict.reason };
  }
  finalizeTerminalState(statePath, opts);
  return { finalized: true };
}

/**
 * WS4 (b7cc6081): record a `completion_finalize_refused` activity entry whenever
 * `finalizeIfTrulyComplete` refuses a finalize. INVERTED semantics — a refusal is
 * the completion authority WORKING (refused-and-recovered), not a regression.
 * `seam` discriminates the refusal arm (`scan_threw` / `scan_null` / the
 * graduation halt reason).
 *
 * Writes a JSONL line to the activity dir (`getDataRoot()/activity/<day>.jsonl`),
 * the SAME sink `scanRefusedRecoveredCounts` reads. It MUST NOT use
 * `writeActivityEntry`, which appends to `state.json.activity` — a sink the
 * recurrence dashboard scanner never reads, so the `Finalize refused` count
 * would always read 0. Inlined (no activity-logger import) to avoid the
 * backend-spawn import cycle, mirroring `emitSchemaVersionViolationActivity`.
 * Best-effort: terminal/forensic paths must never fail on logging.
 */
function emitCompletionFinalizeRefused(
  gatePayload: { pending_count: number; ticket_count: number; seam: string },
): void {
  try {
    const ts = new Date();
    const activityDir = path.join(getDataRoot(), 'activity');
    fs.mkdirSync(activityDir, { recursive: true });
    const event = {
      ts: ts.toISOString(),
      event: 'completion_finalize_refused',
      source: 'pickle' as const,
      gate_payload: gatePayload,
    };
    fs.appendFileSync(
      path.join(activityDir, `${formatLocalDateKey(ts)}.jsonl`),
      `${JSON.stringify(event)}\n`,
      { mode: 0o600 },
    );
  } catch {
    // best-effort observability — never block the refusal path
  }
}

/**
 * Stamp `exit_reason` without touching other fields — for forensic paths
 * (circuit_open, stall, fatal, signal) that must preserve last-known step
 * and current_ticket for postmortem inspection. Never throws.
 */
export function recordExitReason(statePath: string, exitReason: string): void {
  forceWriteMutate(
    statePath,
    s => { s.exit_reason = exitReason; },
    null,
  );
}

export interface ClearExitReasonOpts {
  resetStep?: boolean;
  resetCurrentTicket?: boolean;
}

/**
 * Clear forensic exit markers without disturbing unrelated state fields.
 * By default only `exit_reason` is cleared; callers may also reset the
 * phase/ticket markers when reactivating or transitioning a session.
 */
export function clearExitReason(statePath: string, opts: ClearExitReasonOpts = {}): void {
  forceWriteMutate(
    statePath,
    s => {
      s.exit_reason = null;
      if (opts.resetStep) s.step = null as unknown as State['step'];
      if (opts.resetCurrentTicket) {
        s.current_ticket = null;
        // R-CNAR-8: see finalizeTerminalState — same invariant.
        clearCurrentTicketCache(s);
      }
    },
    null,
  );
}

/**
 * Append a single activity entry to `state.json.activity` (creating the array if missing).
 * Best-effort after validation: primary path uses locked sm.update; on lock
 * failure falls back to read-modify-forceWrite.
 */
export function writeActivityEntry(statePath: string, entry: ActivityLogEntry): void {
  assertValidActivityEvent(entry);

  forceWriteMutate(
    statePath,
    s => {
      const existing = Array.isArray(s.activity) ? s.activity : [];
      s.activity = [...existing, entry];
    },
    null,
  );
}

/**
 * Append a `pipeline_auto_resumed` activity entry to state.json.
 * Called by auto-resume.sh via `node --input-type=module` before each mux-runner relaunch.
 */
export function writePipelineAutoResumedEvent(
  statePath: string,
  payload: {
    retry_index: number;
    ticket_id: string;
    session_done_count_at_retry: number;
    parent_ticket_id?: string;
  },
): void {
  writeActivityEntry(statePath, {
    event: 'pipeline_auto_resumed',
    ts: new Date().toISOString(),
    gate_payload: payload,
  });
}

// ---------------------------------------------------------------------------
// Timeout stub writer (FR-B8/B9)
// ---------------------------------------------------------------------------

export interface TimeoutStubMeta {
  ticketId: string | null;
  iteration: number;
  wallSeconds: number;
  workerTimeoutSeconds: number;
  timeoutCount: number;
  logFile: string;
}

/**
 * Write a TASK_NOTES.md stub at sessionDir/TASK_NOTES.md when the file is absent
 * or empty (FR-B8). Non-empty content — whether Morty-written or a prior stub — is
 * never overwritten (FR-B9). Writes atomically via tmp+rename. Never throws.
 */
export function writeTimeoutStub(sessionDir: string, meta: TimeoutStubMeta): void {
  const stubPath = path.join(sessionDir, 'TASK_NOTES.md');

  if (fs.existsSync(stubPath)) {
    try {
      const existing = fs.readFileSync(stubPath, 'utf-8');
      if (existing.trim().length > 0) return;
    } catch { return; }
  }

  let lastLogLine = '(no log output)';
  try {
    const logContent = fs.readFileSync(meta.logFile, 'utf-8');
    const lines = logContent.split('\n').filter(l => l.trim().length > 0);
    if (lines.length > 0) lastLogLine = lines[lines.length - 1];
  } catch { /* log missing — use placeholder */ }

  const stub = [
    '<!-- pickle-rick: timeout-stub v1 -->',
    '# TASK_NOTES.md (synthesized stub)',
    '',
    '## Progress',
    `Iteration ${meta.iteration} SIGTERM'd at ${Math.round(meta.wallSeconds)}s of ${meta.workerTimeoutSeconds}s budget.`,
    `Ticket: ${meta.ticketId ?? '(unknown)'}`,
    `Attempt: ${meta.timeoutCount}`,
    '',
    '## Dead Ends',
    `Previous iteration did not complete within ${meta.workerTimeoutSeconds}s. Do not repeat the same approach without optimization.`,
    '',
    '## Key Discoveries',
    `Last log line: ${lastLogLine}`,
    '',
    '## Next',
    `Next iteration must finish within ${meta.workerTimeoutSeconds}s or the runner will halt after 2 consecutive timeouts.`,
  ].join('\n');

  const tmpPath = `${stubPath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, stub);
    fs.renameSync(tmpPath, stubPath);
  } catch {
    try { fs.writeFileSync(stubPath, stub); } catch { /* best-effort */ }
    try { fs.unlinkSync(tmpPath); } catch { /* cleanup */ }
  }
}

// ---------------------------------------------------------------------------
// workingDir-scoped advisory lock (async, key-based)
// ---------------------------------------------------------------------------

export interface WithLockOptions {
  timeout_ms?: number;
  retry_interval_ms?: number;
  onAcquire?: (waited_ms: number) => void;
  onTimeout?: (waited_ms: number) => void;
}

function gateLockPath(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex');
  return path.join(os.tmpdir(), `pickle-gate-lock-${hash}.lock`);
}

/**
 * Reclaims a gate lock whose holder is provably dead.
 *
 * A gate holder killed mid-run (operator Ctrl-C group-kill, OOM, crash) never reaches its release,
 * and this lock is keyed by workingDir under `os.tmpdir()` — it is not session-scoped, so the strand
 * outlives the pipeline and wedges every later gate for that repo.
 *
 * Positive proof of death is the ONLY licence to evict: unlike the session-map lock, a gate
 * legitimately holds for minutes (it wraps a full typecheck/lint/test run), so the age-based arm that
 * `withRetryLock` carries would evict a live holder here. Empty, unparseable and live payloads defer.
 */
function reclaimDeadGateLock(lp: string): void {
  withStealRight(lp, () => {
    const snapshot = inspectLockFile(lp);
    if (!snapshot || !isDeadPidPayload(snapshot.payload)) return false;
    return stealLockFile(lp, snapshot);
  });
}

export async function withLock<T>(
  key: string,
  opts: WithLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const timeout_ms = opts.timeout_ms ?? 30_000;
  const retry_interval_ms = opts.retry_interval_ms ?? 100;
  const lp = gateLockPath(key);
  const start = Date.now();
  let held: LockHandle | null;

  for (;;) {
    // The payload is the bare holder pid — the one encoding `isDeadPidPayload` reads.
    held = acquireLockFile(lp, String(process.pid));
    if (held !== null) {
      opts.onAcquire?.(Date.now() - start);
      break;
    }

    reclaimDeadGateLock(lp);

    const waited = Date.now() - start;
    if (waited >= timeout_ms) {
      opts.onTimeout?.(waited);
      const err = new LockError(`withLock timeout after ${waited}ms waiting for key: ${key}`);
      err.kind = 'LockError';
      err.key = key;
      err.timeout_ms = timeout_ms;
      err.waited_ms = waited;
      throw err;
    }
    await new Promise<void>(resolve => setTimeout(resolve, retry_interval_ms));
  }

  try {
    return await fn();
  } finally {
    // Identity-bound: if ours was stolen, the file here is a successor's lock — never unlink it.
    releaseLockFile(lp, held);
  }
}

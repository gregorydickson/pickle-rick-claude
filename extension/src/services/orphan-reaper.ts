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
 * is provably not live (state.json ABSENT, `active !== true`, or a finite pid
 * that is dead). A state.json that is present but UNREADABLE or unparseable is
 * NOT proof of death — it accounts for nothing, so the proc is spared. An
 * unattributable proc is NEVER killed; a live session's proc is NEVER killed
 * regardless of ppid. There is deliberately NO ppid==1-only reap branch —
 * false-reaping an active worker is worse than a leaked orphan.
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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProcessAlive, writeActivityEntry } from './state-manager.js';
import { readRecoverableJsonObject } from './recoverable-json.js';

/** This repo's fixture dir, sibling of the compiled `services/` dir at runtime. */
const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tests/fixtures');

export const ORPHAN_REAP_ENV_VAR = 'PICKLE_ORPHAN_REAP';

const DEFAULT_MIN_AGE_SECONDS = 600;
const DEFAULT_GRACE_MS = 2000;
const DEFAULT_WALL_BUDGET_MS = 15_000;
const DEFAULT_KILL_VERIFY_MS = 1000;
const GRACE_POLL_MS = 100;
const PS_TIMEOUT_MS = 5000;
const PS_MAX_BUFFER = 1024 * 1024 * 8;

/**
 * The ONE negative-PID group-kill implementation (AC-CXHANG-3).
 * Returns `true` when the group signal was delivered; `false` on win32 (no
 * process groups), invalid pid, or a group that is already gone — callers fall
 * back to a direct leader kill.
 */
export function killProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') return false;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

export type WorkerProcCandidate = {
  pid: number;
  pgid: number;
  ppid: number;
  etime_seconds: number;
  command: string;
  /** Session dir under the sessions root resolved from argv `--add-dir`, or null when unattributable. */
  owningSessionDir: string | null;
  /**
   * `'worker'` — a codex/claude worker-shaped command (owning session resolved
   * via `--add-dir`, subject to the R-CXHANG positive-ownership reject).
   * `'tmp_fixture'` (WS-1) — a process whose argv resolves to a path anchored
   * under `os.tmpdir()` in a `pickle-*` first segment; has no owning session
   * by construction (`owningSessionDir` stays null) and is gated by age alone.
   */
  kind: 'worker' | 'tmp_fixture';
  /**
   * Reap-report match class (AC5 non-zero-sweep visibility): `'session_owned'`
   * for a worker attributed to a sessions-root `--add-dir`, `'tmp_prefix_fixture'`
   * for a test-owned `os.tmpdir()` path, `'repo_fixture_path'` for a script
   * anchored under this repo's `extension/tests/fixtures/`. `null` for an
   * unattributable worker-shaped command that matched neither (never reaped).
   */
  matchClass: 'session_owned' | 'tmp_prefix_fixture' | 'repo_fixture_path' | null;
};

/** Reap-report counts broken out by `WorkerProcCandidate.matchClass`. */
export type ReapMatchClassCounts = {
  session_owned: number;
  tmp_prefix_fixture: number;
  repo_fixture_path: number;
};

function emptyMatchClassCounts(): ReapMatchClassCounts {
  return { session_owned: 0, tmp_prefix_fixture: 0, repo_fixture_path: 0 };
}

/** Why no census exists. `null` on a sweep that actually ran — only then is `scanned: 0` evidence. */
export type ReapSweepSkipReason = 'kill_switch' | 'unsupported_platform' | 'sweep_failed';

export type ReapSweepResult = {
  scanned: number;
  reaped: number;
  unverified: number;
  by_match_class: ReapMatchClassCounts;
  /** `null` iff the sweep ran to completion; otherwise the reason it never produced a census. */
  skipped: ReapSweepSkipReason | null;
};

/**
 * The ONE not-run result. Every path that returns without scanning renders through it, so
 * "we counted nothing" and "we never counted" cannot collapse into the same zero tuple again.
 *
 * They did: the kill-switch, the win32 no-op and the best-effort catch each returned their own
 * `scanned: 0` literal, so a `ps` that was absent, timed out, or overflowed its buffer reported
 * byte-identically to a genuinely quiet box — and both `bin/reap-orphans.ts` and
 * `setup.ts:runSetupOrphanReap` print that count as the operator's census.
 */
function sweepNotRun(reason: ReapSweepSkipReason): ReapSweepResult {
  return { scanned: 0, reaped: 0, unverified: 0, by_match_class: emptyMatchClassCounts(), skipped: reason };
}

/** Parse `ps` etime (`[[dd-]hh:]mm:ss`) into seconds; null on malformed input. */
function parsePsElapsedSeconds(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  const [dayPart, clockPart] = value.includes('-') ? value.split('-', 2) : [null, value];
  const segments = clockPart.split(':').map(segment => Number(segment));
  if (segments.some(segment => !Number.isFinite(segment) || segment < 0)) return null;
  const days = dayPart === null ? 0 : Number(dayPart);
  if (!Number.isFinite(days) || days < 0) return null;
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
 *  - node: the worker-gate npm shim (a tmpdir, pickle- prefixed dir's bin npm script), spawned
 *    by the fast-tier test harness under a pickle-prefixed os.tmpdir() fixture dir. Scoped to
 *    that exact shape (tmpdir-anchored, pickle- prefixed first segment, bin npm path) so an
 *    unrelated node script invocation never matches.
 * Drift pin: the unit test builds REAL `buildWorkerInvocation` argv and asserts a match.
 */
function isWorkerShapedCommand(command: string): boolean {
  const tokens = command.split(/\s+/);
  const base = path.basename(tokens[0] ?? '');
  if (base === 'codex') {
    return tokens.includes('exec') && tokens.includes('--dangerously-bypass-approvals-and-sandbox');
  }
  if (base === 'claude') {
    return tokens.includes('--dangerously-skip-permissions') && tokens.includes('-p');
  }
  if (base === 'node') {
    return tokens.some(token => isPickleTmpBinNpmPath(token));
  }
  return false;
}

let tmpRootPrefixCache: { key: string; prefixes: string[] } | null = null;

/**
 * Every prefix a tmpdir-anchored argv path may legitimately begin with.
 *
 * `os.tmpdir()` yields the LEXICAL path — on macOS `/var/folders/…/T`, where `/var` is a
 * symlink to `/private/var` — while a spawned process's argv carries the REALPATH form
 * (`/private/var/folders/…/T`). `path.resolve` does NOT follow symlinks, so a lexical-only
 * prefix compare rejects every real orphan. Measured live before this fix: 10 alive
 * `pickle-spawn-morty-worker-gate-*` procs, reaper `scanned=0` — a permanent false-green
 * over an unbounded leak.
 *
 * Memoized on the tmpdir value (not unconditionally) so a caller that reassigns `TMPDIR`
 * is never served a stale root, and so `realpathSync` runs once per root rather than once
 * per argv token of every `ps` line.
 */
function tmpRootPrefixes(): string[] {
  const lexical = path.resolve(os.tmpdir());
  if (tmpRootPrefixCache?.key === lexical) return tmpRootPrefixCache.prefixes;
  const roots = new Set<string>([lexical]);
  try {
    roots.add(path.resolve(fs.realpathSync(lexical)));
  } catch {
    // tmpdir unreadable/absent — the lexical root is all we can honestly claim.
  }
  const prefixes = [...roots].map((root) => root + path.sep);
  tmpRootPrefixCache = { key: lexical, prefixes };
  return prefixes;
}

/**
 * The ONE tmpdir-anchoring check. Returns the resolved absolute path and its first path
 * segment beneath whichever tmpdir root matched, or null when `token` is not an absolute
 * path under tmpdir at all.
 *
 * Both tmpdir matchers (`isPickleTmpBinNpmPath` and `resolveTmpPrefixFixturePath`) read it
 * rather than each re-deriving "resolve, compare against tmpdir, take the first segment".
 * Two copies is how the symlink rule came to hold in neither: the argv/`os.tmpdir()` form
 * mismatch defeated both matchers at once, so the fallback could not cover for the primary.
 */
function resolveUnderTmpRoot(token: string): { resolved: string; firstSegment: string } | null {
  if (!token.startsWith('/')) return null;
  const resolved = path.resolve(token);
  for (const prefix of tmpRootPrefixes()) {
    if (!resolved.startsWith(prefix)) continue;
    const firstSegment = resolved.slice(prefix.length).split(path.sep)[0];
    if (firstSegment) return { resolved, firstSegment };
  }
  return null;
}

/**
 * True when `token` is an absolute path resolving under `os.tmpdir()` (by either the
 * lexical or the realpath root), whose first path segment beneath tmpdir starts with
 * `pickle-`, and whose final two segments are `bin/npm`.
 */
function isPickleTmpBinNpmPath(token: string): boolean {
  const anchored = resolveUnderTmpRoot(token);
  if (!anchored || !anchored.firstSegment.startsWith('pickle-')) return false;
  const { resolved } = anchored;
  return path.basename(resolved) === 'npm' && path.basename(path.dirname(resolved)) === 'bin';
}

/**
 * Positive-ownership attribution: the first `--add-dir` value under the
 * sessions root maps the proc to `<sessionsRoot>/<session>` (worker argv
 * carries `--add-dir <sessionsRoot>/<session>/<ticket>` on both backends).
 */
function resolveOwningSessionDir(command: string, sessionsRoot: string): string | null {
  const root = path.resolve(sessionsRoot);
  const rootPrefix = root + path.sep;
  const tokens = command.split(/\s+/);
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] !== '--add-dir') continue;
    const value = tokens[i + 1];
    if (!value || !value.startsWith(rootPrefix)) continue;
    const firstSegment = value.slice(rootPrefix.length).split(path.sep)[0];
    if (firstSegment) return path.join(root, firstSegment);
  }
  return null;
}

/**
 * Test-owned tmpdir prefixes admitted by the WS-1 positive-path matcher. A
 * new fixture prefix is a one-line addition here — never a new code path.
 */
const TEST_OWNED_TMP_PREFIXES = ['pickle-', 'cxhang-int-bin-', 'cxhang-int-sess-'];

/**
 * WS-1 positive-path match for tmp-prefix fixture orphans: an argv token that
 * resolves to an ABSOLUTE path whose first path segment beneath
 * `os.tmpdir()` begins with one of `TEST_OWNED_TMP_PREFIXES`. Never a
 * substring match against argv text — a token merely containing the string
 * "pickle-" (e.g. prompt prose) does not match unless it is itself a path
 * anchored under tmpdir.
 */
function resolveTmpPrefixFixturePath(command: string): string | null {
  for (const token of command.split(/\s+/)) {
    const anchored = resolveUnderTmpRoot(token);
    if (anchored && TEST_OWNED_TMP_PREFIXES.some(prefix => anchored.firstSegment.startsWith(prefix))) {
      return anchored.resolved;
    }
  }
  return null;
}

/**
 * Positive-path match for a repo fixture script: an argv token that resolves
 * to an ABSOLUTE path anchored under this repo's `extension/tests/fixtures/`
 * directory, regardless of any tmpdir involvement. Same anti-substring-scan
 * discipline as `resolveTmpPrefixFixturePath`.
 */
function resolveRepoFixtureScriptPath(command: string): string | null {
  const fixturesPrefix = FIXTURES_DIR + path.sep;
  for (const token of command.split(/\s+/)) {
    if (!token.startsWith('/')) continue;
    const resolved = path.resolve(token);
    if (resolved === FIXTURES_DIR || resolved.startsWith(fixturesPrefix)) return resolved;
  }
  return null;
}

/**
 * The ONE positive-path check for the `tmp_fixture` class: a test-owned
 * tmpdir prefix OR a script anchored under this repo's fixtures dir.
 */
function resolveTestOwnedFixturePath(command: string): string | null {
  return resolveTmpPrefixFixturePath(command) ?? resolveRepoFixtureScriptPath(command);
}

/**
 * Which fixture submatch fired, for reap-report match-class breakdown
 * (AC5). Mirrors `resolveTestOwnedFixturePath`'s precedence exactly — never
 * re-derive independently.
 */
function classifyFixtureMatch(command: string): 'tmp_prefix_fixture' | 'repo_fixture_path' | null {
  if (resolveTmpPrefixFixturePath(command) !== null) return 'tmp_prefix_fixture';
  if (resolveRepoFixtureScriptPath(command) !== null) return 'repo_fixture_path';
  return null;
}

/** Parse a base-10 ps column into a finite integer; -1 on malformed input. */
function parsePsInt(raw: string): number {
  const value = Number(raw);
  return Number.isFinite(value) && Number.isInteger(value) ? value : -1;
}

/** Pure parser over `ps -axo pid=,pgid=,ppid=,etime=,command=` output. */
export function parseWorkerProcsFromPs(psOutput: string, sessionsRoot: string): WorkerProcCandidate[] {
  const results: WorkerProcCandidate[] = [];
  for (const rawLine of psOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const pid = parsePsInt(match[1]);
    const pgid = parsePsInt(match[2]);
    const ppid = parsePsInt(match[3]);
    const etimeSeconds = parsePsElapsedSeconds(match[4]);
    const command = match[5].trim();
    if (pid <= 0 || pgid <= 0 || ppid < 0 || etimeSeconds === null) continue;
    if (isWorkerShapedCommand(command)) {
      const owningSessionDir = resolveOwningSessionDir(command, sessionsRoot);
      // An unattributable worker-shaped command (e.g. a claude-symlinked test
      // fixture whose --add-dir points at a foreign/stale tmp sessions root)
      // still reaps via the tmp_fixture age-only gate when its argv is itself
      // a test-owned fixture path — never by relaxing worker ownership.
      if (owningSessionDir === null && resolveTestOwnedFixturePath(command) !== null) {
        results.push({
          pid,
          pgid,
          ppid,
          etime_seconds: etimeSeconds,
          command,
          owningSessionDir: null,
          kind: 'tmp_fixture',
          matchClass: classifyFixtureMatch(command),
        });
        continue;
      }
      results.push({
        pid,
        pgid,
        ppid,
        etime_seconds: etimeSeconds,
        command,
        owningSessionDir,
        kind: 'worker',
        matchClass: owningSessionDir !== null ? 'session_owned' : null,
      });
      continue;
    }
    if (resolveTestOwnedFixturePath(command) !== null) {
      results.push({
        pid,
        pgid,
        ppid,
        etime_seconds: etimeSeconds,
        command,
        owningSessionDir: null,
        kind: 'tmp_fixture',
        matchClass: classifyFixtureMatch(command),
      });
    }
  }
  return results;
}

type OwningSessionRead =
  | { kind: 'missing' }
  | { kind: 'unaccountable' }
  | { kind: 'state'; state: Record<string, unknown> };

/**
 * Classify the owning session's `state.json` into three states, NOT two.
 * `readRecoverableJsonObject` collapses "no such file" and "the read threw"
 * (EMFILE/ENFILE/EIO/EACCES/EISDIR) into the same `null`, and only the first
 * of those is evidence the session is gone — the second accounts for nothing.
 * A NUL/parse-failed base is unaccountable too: the bytes are there and we
 * cannot judge them.
 */
function readOwningSessionState(sessionDir: string): OwningSessionRead {
  const statePath = path.join(sessionDir, 'state.json');
  let state: Record<string, unknown> | null;
  try {
    state = readRecoverableJsonObject(statePath) as Record<string, unknown> | null;
  } catch {
    return { kind: 'unaccountable' };
  }
  if (state) return { kind: 'state', state };
  try {
    fs.lstatSync(statePath);
    return { kind: 'unaccountable' };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    // Only a positive "it is not there" proves absence; every other errno
    // (including a probe we could not perform) falls to the sparing side.
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'missing' } : { kind: 'unaccountable' };
  }
}

/**
 * A session is LIVE unless proven otherwise: an ABSENT state.json or
 * `active !== true` → not live; `active: true` with a finite dead pid → not
 * live (dead-pid demotion, mirrors `isDeadPidState`); `active: true` with no
 * pid or a live pid → LIVE. A state.json we could not read or parse is NOT
 * proof of death — it is treated as LIVE (conservative bias — spare), because
 * the alternative is group-SIGKILLing a live sibling pipeline's worker.
 */
function isOwningSessionLive(sessionDir: string, isAlive: (pid: number) => boolean): boolean {
  const read = readOwningSessionState(sessionDir);
  if (read.kind === 'missing') return false;
  if (read.kind === 'unaccountable') return true;
  const state = read.state;
  if (state.active !== true) return false;
  const pid = state.pid;
  if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && !isAlive(pid)) return false;
  return true;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export type ReapOrphanedWorkerProcsOpts = {
  /** Sessions root (e.g. `~/.local/share/pickle-rick/sessions`) — ownership anchor. */
  sessionsRoot: string;
  /** state.json of the INVOKING session, for `worker_orphan_reaped` events (optional, best-effort). */
  statePath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Injectable raw ps output (tests) — wins over `scan`. */
  psOutput?: string;
  /** Injectable scanner returning `ps -axo pid=,pgid=,ppid=,etime=,command=` output. */
  scan?: () => string;
  /** Injectable group-killer; default delegates to `killProcessGroup`. */
  kill?: (pgid: number, signal: NodeJS.Signals) => boolean;
  /** Injectable per-pid liveness probe; default `isProcessAlive`. */
  isAlive?: (pid: number) => boolean;
  /** Injectable sleep (tests); default synchronous Atomics.wait. */
  sleep?: (ms: number) => void;
  minAgeSeconds?: number;
  graceMs?: number;
  wallBudgetMs?: number;
  /** Bounded post-SIGKILL verification poll window (ms); default `DEFAULT_KILL_VERIFY_MS`. */
  killVerifyMs?: number;
  log?: (msg: string) => void;
};

type ReapRuntime = {
  kill: (pgid: number, signal: NodeJS.Signals) => boolean;
  isAlive: (pid: number) => boolean;
  sleep: (ms: number) => void;
  minAgeSeconds: number;
  graceMs: number;
  killVerifyMs: number;
  statePath?: string;
  log?: (msg: string) => void;
};

/**
 * TRAP DOOR: positive ownership required before any kill. Skips self/parent
 * groups, unattributable procs (NEVER killed), under-age procs, and any proc
 * whose owning session is live. No ppid==1-only branch by design.
 */
function isReapableOrphan(cand: WorkerProcCandidate, rt: ReapRuntime, reapedPgids: Set<number>): boolean {
  // Never signal our own process/group or our parent's (the reaper runs
  // inside a claude-shaped process tree at setup time).
  if (cand.pid === process.pid || cand.pid === process.ppid) return false;
  if (cand.pgid === process.pid || cand.pgid === process.ppid) return false;
  if (reapedPgids.has(cand.pgid)) return false;
  // The tmp-prefix fixture class (WS-1) has no owning session by construction
  // (see WorkerProcCandidate.kind) — the null reject below applies only to
  // the codex/claude worker class, which keeps the R-CXHANG positive-
  // ownership invariant fully intact.
  const { owningSessionDir } = cand;
  if (cand.kind !== 'tmp_fixture' && owningSessionDir === null) return false;
  if (cand.etime_seconds < rt.minAgeSeconds) return false;
  if (cand.kind === 'tmp_fixture' || owningSessionDir === null) return true;
  return !isOwningSessionLive(owningSessionDir, rt.isAlive);
}

/**
 * Reuse the spawn-morty escalation shape: group SIGTERM → grace → group SIGKILL
 * → bounded verify. Returns whether the group is CONFIRMED dead — callers must
 * count `reaped` ONLY on `true`; an unverified survivor is reported but never
 * silently counted as gone.
 */
function reapCandidateGroup(cand: WorkerProcCandidate, rt: ReapRuntime): boolean {
  rt.kill(cand.pgid, 'SIGTERM');
  const graceDeadline = Date.now() + rt.graceMs;
  let gracePolls = Math.max(1, Math.ceil(rt.graceMs / GRACE_POLL_MS));
  while (rt.isAlive(cand.pid) && Date.now() < graceDeadline && gracePolls > 0) {
    rt.sleep(GRACE_POLL_MS);
    gracePolls -= 1;
  }
  if (rt.isAlive(cand.pid)) rt.kill(cand.pgid, 'SIGKILL');
  const verifyDeadline = Date.now() + rt.killVerifyMs;
  let verifyPolls = Math.max(1, Math.ceil(rt.killVerifyMs / GRACE_POLL_MS));
  while (rt.isAlive(cand.pid) && Date.now() < verifyDeadline && verifyPolls > 0) {
    rt.sleep(GRACE_POLL_MS);
    verifyPolls -= 1;
  }
  const verified = !rt.isAlive(cand.pid);
  if (verified) {
    emitReapedTelemetry(cand, rt);
  } else {
    emitUnverifiedTelemetry(cand, rt, 'survived_sigkill');
  }
  return verified;
}

function emitReapedTelemetry(cand: WorkerProcCandidate, rt: ReapRuntime): void {
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
    } catch { /* event emission is best-effort */ }
  }
  rt.log?.(`reaped orphan worker pid=${cand.pid} pgid=${cand.pgid} etime_seconds=${cand.etime_seconds} session=${owningSession}`);
}

/** Reports a candidate that could NOT be verified dead — never counted as `reaped`. */
function emitUnverifiedTelemetry(cand: WorkerProcCandidate, rt: ReapRuntime, reason: string): void {
  const owningSession = path.basename(cand.owningSessionDir ?? '');
  if (rt.statePath) {
    try {
      writeActivityEntry(rt.statePath, {
        event: 'worker_orphan_reap_unverified',
        ts: new Date().toISOString(),
        pid: cand.pid,
        pgid: cand.pgid,
        etime_seconds: cand.etime_seconds,
        owning_session: owningSession,
        argv_summary: cand.command,
        reason,
      });
    } catch { /* event emission is best-effort */ }
  }
  rt.log?.(`unverified orphan worker pid=${cand.pid} pgid=${cand.pgid} reason=${reason} session=${owningSession}`);
}

/**
 * Handles one reapable candidate: budget-skip (report, don't attempt) or full
 * escalation-and-verify. Returns `'reaped'` / `'unverified'` for the caller's
 * tally; the caller has already confirmed `isReapableOrphan`.
 */
function processReapableCandidate(cand: WorkerProcCandidate, rt: ReapRuntime, reapedPgids: Set<number>, deadline: number): 'reaped' | 'unverified' {
  if (Date.now() > deadline) {
    emitUnverifiedTelemetry(cand, rt, 'budget_exceeded');
    return 'unverified';
  }
  const verified = reapCandidateGroup(cand, rt);
  reapedPgids.add(cand.pgid);
  return verified ? 'reaped' : 'unverified';
}

function runReapPass(opts: ReapOrphanedWorkerProcsOpts, platform: NodeJS.Platform): ReapSweepResult {
  const scan = opts.scan ?? (() => execFileSync('ps', ['-axo', 'pid=,pgid=,ppid=,etime=,command='], {
    encoding: 'utf-8',
    timeout: PS_TIMEOUT_MS,
    maxBuffer: PS_MAX_BUFFER,
  }));
  const psOutput = opts.psOutput ?? scan();
  const candidates = parseWorkerProcsFromPs(psOutput, opts.sessionsRoot);
  const rt: ReapRuntime = {
    kill: opts.kill ?? ((pgid: number, signal: NodeJS.Signals) => killProcessGroup(pgid, signal, platform)),
    isAlive: opts.isAlive ?? isProcessAlive,
    sleep: opts.sleep ?? sleepSync,
    minAgeSeconds: opts.minAgeSeconds ?? DEFAULT_MIN_AGE_SECONDS,
    graceMs: opts.graceMs ?? DEFAULT_GRACE_MS,
    killVerifyMs: opts.killVerifyMs ?? DEFAULT_KILL_VERIFY_MS,
    ...(opts.statePath !== undefined ? { statePath: opts.statePath } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  };
  const deadline = Date.now() + (opts.wallBudgetMs ?? DEFAULT_WALL_BUDGET_MS);
  const reapedPgids = new Set<number>();
  const tally = { reaped: 0, unverified: 0, by_match_class: emptyMatchClassCounts() };
  for (const cand of candidates) {
    if (!isReapableOrphan(cand, rt, reapedPgids)) continue;
    tallyReapOutcome(tally, cand, processReapableCandidate(cand, rt, reapedPgids, deadline));
  }
  return { scanned: candidates.length, ...tally, skipped: null };
}

/** Accumulates one candidate's disposition into the running sweep tally. */
function tallyReapOutcome(
  tally: { reaped: number; unverified: number; by_match_class: ReapMatchClassCounts },
  cand: WorkerProcCandidate,
  outcome: 'reaped' | 'unverified',
): void {
  if (outcome !== 'reaped') {
    tally.unverified += 1;
    return;
  }
  tally.reaped += 1;
  if (cand.matchClass) tally.by_match_class[cand.matchClass] += 1;
}

/**
 * Reap detached worker procs (codex/claude) that no live pickle session owns.
 * Never throws (best-effort); never kills an unattributable or live-owned proc.
 * The returned per-match-class breakdown (`by_match_class`) is what lets a
 * caller report a non-zero sweep without logging noise on a zero-reap sweep
 * (AC5): session-owned, tmp-prefix fixture, repo fixture path.
 *
 * `skipped` is the did-we-actually-count axis: `null` means the census is real, so `scanned: 0`
 * is evidence of a quiet box. Any other value means no census exists — the caller must NOT
 * render its zero counts as "nothing to reap". Still best-effort: a failure returns, never throws.
 */
export function reapOrphanedWorkerProcs(opts: ReapOrphanedWorkerProcsOpts): ReapSweepResult {
  const env = opts.env ?? process.env;
  if (env[ORPHAN_REAP_ENV_VAR] === 'off') return sweepNotRun('kill_switch');
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') return sweepNotRun('unsupported_platform');
  try {
    return runReapPass(opts, platform);
  } catch {
    // Best-effort collector — a reaper failure must never block a launch, but it must not
    // masquerade as a completed sweep either (`ps` absent / timed out / output over maxBuffer).
    return sweepNotRun('sweep_failed');
  }
}

// ============================================================================
// Suite-level registry teardown: survives abnormal runner death
// ============================================================================

/**
 * Path for the run-scoped PID registry. A test run records fixture PIDs here;
 * `afterAll` / `process.on('exit')` / startup sweep all read from it.
 */
function getPidRegistryPath(registryDir: string): string {
  return path.join(registryDir, 'fixture_pid_registry.json');
}

export type FixturePidRegistry = {
  /** Run start epoch ms, used to age off stale registries. */
  started_at_epoch_ms: number;
  /** Array of PIDs spawned during this run. */
  pids: number[];
};

/**
 * Initialize or append to the fixture PID registry for this test run.
 * Call this once at suite startup (before first fixture spawn).
 * Returns the registry path so afterAll/process.on('exit') can find it.
 */
export function initFixturePidRegistry(registryDir: string): string {
  try {
    fs.mkdirSync(registryDir, { recursive: true });
  } catch { /* race on mkdir, ignore */ }
  const registryPath = getPidRegistryPath(registryDir);
  const registry: FixturePidRegistry = {
    started_at_epoch_ms: Date.now(),
    pids: [],
  };
  try {
    fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf-8');
  } catch { /* best-effort init */ }
  return registryPath;
}

/**
 * Record a fixture PID in the suite-level registry.
 * Call after each fixture spawn so cleanup survives abnormal runner death.
 */
export function recordFixturePid(registryPath: string, pid: number): void {
  try {
    const existing = fs.readFileSync(registryPath, 'utf-8');
    const registry = JSON.parse(existing) as FixturePidRegistry;
    if (!registry.pids.includes(pid)) {
      registry.pids.push(pid);
      fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf-8');
    }
  } catch { /* best-effort recording */ }
}

/** Poll budgets for the fixture escalation, in `GRACE_POLL_MS` steps. */
const FIXTURE_GRACE_POLLS = Math.max(1, Math.ceil(DEFAULT_GRACE_MS / GRACE_POLL_MS));
const FIXTURE_VERIFY_POLLS = Math.max(1, Math.ceil(DEFAULT_KILL_VERIFY_MS / GRACE_POLL_MS));

/** Yield one `GRACE_POLL_MS` wait per remaining poll, stopping as soon as `pid` is provably gone. */
function* pollUntilDead(pid: number, polls: number): Generator<number, void, void> {
  for (let i = 0; i < polls && isProcessAlive(pid); i++) yield GRACE_POLL_MS;
}

/**
 * The ONE fixture escalation: probe → group SIGTERM → grace → group SIGKILL → bounded
 * verify → confirm. Mirrors `reapCandidateGroup` (`:511`) and, like it, resolves `true`
 * ONLY on a confirmed death: `kill(-pid, …)` keeps succeeding while ANY group member is
 * left, so a delivered signal is never evidence the fixture is gone.
 *
 * It yields the ms the caller must WAIT rather than sleeping itself, because the two
 * reapers can only wait one way each — `Atomics.wait` is the only option left at
 * `process.on('exit')` time, and blocking it is the one thing an `afterAll` hook must not
 * do. That is their whole difference; every kill, probe and count decision lives here once.
 */
function* escalateFixtureGroup(pid: number, platform: NodeJS.Platform): Generator<number, boolean, void> {
  if (!isProcessAlive(pid)) return false; // already gone — this reaper killed nothing
  killProcessGroup(pid, 'SIGTERM', platform);
  yield* pollUntilDead(pid, FIXTURE_GRACE_POLLS);
  if (isProcessAlive(pid)) {
    killProcessGroup(pid, 'SIGKILL', platform);
    yield* pollUntilDead(pid, FIXTURE_VERIFY_POLLS);
  }
  return !isProcessAlive(pid);
}

/** Drive `escalateFixtureGroup` with blocking sleeps — the `process.on('exit')` path. */
function reapFixtureGroupSync(pid: number, platform: NodeJS.Platform): boolean {
  const escalation = escalateFixtureGroup(pid, platform);
  let step = escalation.next();
  while (!step.done) {
    sleepSync(step.value);
    step = escalation.next();
  }
  return step.value;
}

/** Drive `escalateFixtureGroup` with timer waits — the `afterAll` path, event loop intact. */
async function reapFixtureGroupAsync(pid: number, platform: NodeJS.Platform): Promise<boolean> {
  const escalation = escalateFixtureGroup(pid, platform);
  let step = escalation.next();
  while (!step.done) {
    const waitMs = step.value;
    await new Promise(resolve => setTimeout(resolve, waitMs));
    step = escalation.next();
  }
  return step.value;
}

/**
 * Registered PIDs worth signalling. A missing, unreadable or malformed registry yields
 * `[]` — cleanup is best-effort and must never throw out of an exit handler — and
 * non-integer / non-positive entries are dropped before any probe, since `kill(0, …)` and
 * `kill(-n, …)` address the caller's OWN process group.
 */
function readRegistryPids(registryPath: string): number[] {
  try {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as FixturePidRegistry;
    return registry.pids.filter(pid => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

/** Drop the registry once a reap pass has walked it; a leftover file re-reaps recycled PIDs. */
function discardRegistry(registryPath: string): void {
  try {
    fs.unlinkSync(registryPath);
  } catch { /* already removed or never existed */ }
}

/**
 * Synchronously reap all fixtures recorded in the registry.
 * Called from process.on('exit') so it runs even on SIGKILL of the test runner.
 */
export function reapFixturesSync(registryPath: string, platform: NodeJS.Platform = process.platform): number {
  if (platform === 'win32') return 0;
  let reaped = 0;
  for (const pid of readRegistryPids(registryPath)) {
    if (reapFixtureGroupSync(pid, platform)) reaped++;
  }
  discardRegistry(registryPath);
  return reaped;
}

/**
 * Asynchronously reap all fixtures from the registry.
 * Called from afterAll hook so normal cleanup happens even if test times out.
 */
export async function reapFixtures(registryPath: string, platform: NodeJS.Platform = process.platform): Promise<number> {
  if (platform === 'win32') return 0;
  let reaped = 0;
  for (const pid of readRegistryPids(registryPath)) {
    if (await reapFixtureGroupAsync(pid, platform)) reaped++;
  }
  discardRegistry(registryPath);
  return reaped;
}

/**
 * Startup sweep: if a registry from a previous run exists, reap those PIDs.
 * This makes fixture cleanup observable after a runner crash/SIGKILL.
 * Call once at suite startup, before initFixturePidRegistry.
 */
export function reapPreviousRunFixtures(registryDir: string, platform: NodeJS.Platform = process.platform): number {
  if (platform === 'win32') return 0;
  const registryPath = getPidRegistryPath(registryDir);
  let reaped = 0;
  try {
    const stat = fs.statSync(registryPath);
    const ageMs = Date.now() - stat.mtimeMs;
    // Only reap registries from the last 24 hours (stale ones are abandoned)
    if (ageMs > 24 * 3600 * 1000) return 0;
    reaped = reapFixturesSync(registryPath, platform);
  } catch { /* no previous registry or cleanup error */ }
  return reaped;
}

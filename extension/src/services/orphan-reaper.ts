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
 * `reapOrphanedWorkerProcs` collects procs no live pickle session owns. It has
 * THREE consumers, and the cadence matters: `setup.ts:runSetupOrphanReap` and
 * `bin/reap-orphans.ts` fire once, but `mux-runner.ts:runPipelineOrphanWorkerReap`
 * fires EVERY iteration of a live pipeline — so a false reap here lands mid-run,
 * not only before one starts.
 *
 * TRAP DOOR (positive attribution — TWO classes, one of which is NOT ownership):
 * every reap needs a positive match, but the two classes do not match on the
 * same thing, and a reader who takes the `worker` rule for the whole rule will
 * mis-scope the next guard.
 *
 *  - `worker` (codex/claude): reaped ONLY under session OWNERSHIP — argv
 *    `--add-dir <path>` resolves under the sessions root (present on BOTH
 *    backends) AND that session is provably not live (state.json ABSENT,
 *    `active !== true`, or a finite pid that is dead). A state.json that is
 *    present but UNREADABLE or unparseable is NOT proof of death — it accounts
 *    for nothing, so the proc is spared. An unattributable WORKER is never
 *    killed: `isReapableOrphan`'s `owningSessionDir === null` reject covers
 *    exactly this class.
 *  - `tmp_fixture` (WS-1): has NO owning session by construction and is gated by
 *    AGE ALONE. That reject is conditional (`kind !== 'tmp_fixture'`), so the
 *    worker rule above does NOT generalise: flattened into one blanket
 *    ownership-required-for-every-kill claim it is false of this class, which
 *    does not even require a worker-shaped command. Its containment is instead the
 *    positive PATH match (`matchTestOwnedFixture`: an ABSOLUTE argv token
 *    resolving under `os.tmpdir()` in a `TEST_OWNED_TMP_PREFIXES` first segment,
 *    or under this repo's fixtures dir), the min-age floor, and `resolveSelfIds`
 *    — which is load-bearing ONLY because of this class (AP-EXT-ITER47-01).
 *
 * A command matching NEITHER class never becomes a candidate at all:
 * `parseWorkerProcsFromPs` drops it on `classified === null`, so it is absent
 * from `scanned` too — do not read the census as a count of everything `ps`
 * returned (AP-EXT-ITER44-01 pins what `scanned` means). A live session's
 * worker is NEVER killed regardless of ppid. There is deliberately NO
 * ppid==1-only reap branch — false-reaping an active worker is worse than a
 * leaked orphan.
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
 *
 * The validity floor is 1, not 0. `kill(-1, sig)` is not "group 1" — POSIX
 * defines it as a BROADCAST to every process the caller may signal, so a single
 * `pgid` of 1 read off `ps` turns this primitive into a machine-wide SIGTERM
 * then SIGKILL, taking the running pipeline down with it. The value reaches here
 * unvalidated on that axis: `parseWorkerProcsFromPs` only rejects `pgid <= 0`,
 * and `isReapableOrphan` gates on ownership/age/self-ids, never on the number.
 * This bound is the one place that can refuse it for every caller — widen the
 * predicate here rather than adding a per-callsite check.
 */
export function killProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') return false;
  if (!Number.isInteger(pid) || pid <= 1) return false;
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

/** A `tmp_fixture` admission: the path that matched, and WHICH submatch matched it. */
type TestOwnedFixtureMatch = {
  path: string;
  matchClass: 'tmp_prefix_fixture' | 'repo_fixture_path';
};

/**
 * The ONE positive-path check for the `tmp_fixture` class: a test-owned
 * tmpdir prefix OR a script anchored under this repo's fixtures dir.
 *
 * Admission and match class come out of the SAME evaluation. They used to be
 * two functions — `resolveTestOwnedFixturePath` returning the path and
 * `classifyFixtureMatch` re-running both submatchers to name the class — under
 * a comment instructing the second to mirror the first's precedence and "never
 * re-derive independently", which is exactly what it did. A submatcher added
 * to one and not the other admits a candidate the report then labels `null`.
 */
function matchTestOwnedFixture(command: string): TestOwnedFixtureMatch | null {
  const tmpPrefixPath = resolveTmpPrefixFixturePath(command);
  if (tmpPrefixPath !== null) return { path: tmpPrefixPath, matchClass: 'tmp_prefix_fixture' };
  const repoFixturePath = resolveRepoFixtureScriptPath(command);
  if (repoFixturePath !== null) return { path: repoFixturePath, matchClass: 'repo_fixture_path' };
  return null;
}

/** Parse a base-10 ps column into a finite integer; -1 on malformed input. */
function parsePsInt(raw: string): number {
  const value = Number(raw);
  return Number.isFinite(value) && Number.isInteger(value) ? value : -1;
}

/** A command's admission verdict: the class it belongs to and how the report labels it. */
type WorkerProcClass = Pick<WorkerProcCandidate, 'owningSessionDir' | 'kind' | 'matchClass'>;

/**
 * The ONE admission decision for a `ps` row: WHETHER a command is a candidate
 * at all, and — inseparably — the `kind`/`matchClass`/ownership triple the reap
 * report labels it with. `null` means the command is neither worker-shaped nor
 * a test-owned fixture path, and is not a candidate.
 *
 * Class and label come out of the SAME evaluation for the reason
 * `matchTestOwnedFixture` fused its own two halves one level down: the pre-fix
 * shape built a candidate at THREE `results.push` sites, two of them
 * byte-identical `tmp_fixture` literals reached from different arms. A field
 * added to `WorkerProcCandidate`, or any change to how a fixture candidate is
 * labelled, had to land in both or the two arms disagreed about the same
 * command — the exact drift the `matchClass` doc-comment warns about
 * ("admits a candidate the report then labels `null`"), re-created at the
 * construction site.
 *
 * Precedence is unchanged: a worker-shaped command with a resolvable owning
 * session is `session_owned` even when its argv also looks like a fixture path;
 * only an UNATTRIBUTABLE worker falls through to the fixture class.
 */
function classifyWorkerProc(command: string, sessionsRoot: string): WorkerProcClass | null {
  const workerShaped = isWorkerShapedCommand(command);
  const owningSessionDir = workerShaped ? resolveOwningSessionDir(command, sessionsRoot) : null;
  if (owningSessionDir !== null) return { owningSessionDir, kind: 'worker', matchClass: 'session_owned' };
  // An unattributable worker-shaped command (e.g. a claude-symlinked test
  // fixture whose --add-dir points at a foreign/stale tmp sessions root)
  // still reaps via the tmp_fixture age-only gate when its argv is itself
  // a test-owned fixture path — never by relaxing worker ownership.
  const fixtureMatch = matchTestOwnedFixture(command);
  if (fixtureMatch !== null) {
    return { owningSessionDir: null, kind: 'tmp_fixture', matchClass: fixtureMatch.matchClass };
  }
  // Worker-shaped but unattributable and not a fixture: still CENSUSED (it is a
  // real worker proc and `scanned` must say so), never reapable — `isReapableOrphan`
  // refuses the null owner for every non-`tmp_fixture` kind.
  return workerShaped ? { owningSessionDir: null, kind: 'worker', matchClass: null } : null;
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
    const classified = classifyWorkerProc(command, sessionsRoot);
    if (classified === null) continue;
    results.push({ pid, pgid, ppid, etime_seconds: etimeSeconds, command, ...classified });
  }
  return results;
}

/**
 * Our OWN process group, read out of the same census the candidates came from —
 * the row whose pid is `selfPid` carries it. `null` when that row is absent, which
 * in production cannot happen (`ps -axo` lists every process, including us) and in
 * tests means an injected census that never claimed to contain us.
 *
 * Read from the census rather than a second `ps -o pgid= -p $$`: no extra subprocess,
 * no second timeout to get wrong, and the pgid is guaranteed consistent with the
 * candidate rows it is compared against. Node exposes no `getpgrp()` binding, so the
 * census is the only pgid source already on hand.
 */
export function parseSelfPgidFromPs(psOutput: string, selfPid: number): number | null {
  for (const rawLine of psOutput.split(/\r?\n/)) {
    const match = rawLine.trim().match(/^(\d+)\s+(\d+)\s+/);
    if (!match) continue;
    if (parsePsInt(match[1]) !== selfPid) continue;
    const pgid = parsePsInt(match[2]);
    return pgid > 0 ? pgid : null;
  }
  return null;
}

/**
 * The ONE set of process identifiers a reap must never address, checked against a
 * candidate's pid AND its pgid.
 *
 * It is ONE set rather than a stack of comparisons because every entry defends the
 * same thing — "this signal would land on us" — and the pre-fix shape had already
 * forked into two same-theme guards (`cand.pid` vs self/parent, `cand.pgid` vs
 * self/parent) that between them still missed the case that matters most: our own
 * process GROUP, whose leader is routinely neither us nor our parent. `npm run
 * test:fast` → `posttest:fast` → `sh -c` → `node bin/reap-orphans.js` leaves the
 * group led by the npm job leader, two levels above the reaper; `kill(-thatPgid)`
 * SIGTERMs then SIGKILLs the entire test run, the reaper included. Adding a third
 * comparison would have re-forked the family — a new identity to spare is a `.add`,
 * never a new branch.
 *
 * Load-bearing only since the WS-1 `tmp_fixture` class: before it, `owningSessionDir
 * === null` rejected every unattributed candidate, so nothing reached the kill on age
 * alone and a same-group proc could not be selected. That reject no longer covers the
 * fixture class, which is gated by age ALONE.
 */
function resolveSelfIds(psOutput: string): Set<number> {
  const ids = new Set<number>([process.pid, process.ppid]);
  const selfPgid = parseSelfPgidFromPs(psOutput, process.pid);
  if (selfPgid !== null) ids.add(selfPgid);
  return ids;
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
  /** Pids and pgids a kill must never address — see `resolveSelfIds`. */
  selfIds: Set<number>;
  statePath?: string;
  log?: (msg: string) => void;
};

/**
 * TRAP DOOR: a positive match required before any kill — but which match depends
 * on `cand.kind`, and the two are not interchangeable (see the module docblock).
 * Skips self/parent GROUPS, under-age procs, an already-reaped group, any
 * `worker` whose owning session is live, and any `worker` with no owning session
 * at all. A `tmp_fixture` reaches the kill on AGE ALONE — the ownership reject
 * below is conditional on `kind !== 'tmp_fixture'`, so `selfIds` is that class's
 * only self-protection. No ppid==1-only branch by design.
 */
function isReapableOrphan(cand: WorkerProcCandidate, rt: ReapRuntime, reapedPgids: Set<number>): boolean {
  // Never signal anything that would land on US — see `selfIds`. One membership
  // test over both axes, because `kill(-pgid)` reaches the caller whenever the
  // caller shares that group, whatever the leader's relationship to us is.
  if (rt.selfIds.has(cand.pid) || rt.selfIds.has(cand.pgid)) return false;
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
    selfIds: resolveSelfIds(psOutput),
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

/**
 * AC5: record a non-zero sweep as an activity event so a run's reap is auditable after
 * the fact; a zero-reap sweep stays quiet (no event). THE one emitter — `setup.ts`'s
 * bootstrap sweep and `mux-runner.ts`'s per-iteration sweep both call it, having
 * previously each carried a byte-identical copy of this payload.
 *
 * The breakdown is SPREAD, not enumerated. Naming `session_owned` /
 * `tmp_prefix_fixture` / `repo_fixture_path` at a call site makes a fourth match class
 * a two-site edit that fails silently at the site that forgets — a missing telemetry
 * field is indistinguishable from a class that scored zero. `ReapMatchClassCounts` is
 * already the list; there is no reason for a second copy of it to exist.
 *
 * Best-effort like its `emitReapedTelemetry` siblings: telemetry never blocks a caller.
 */
export function emitOrphanReapSummary(statePath: string, result: ReapSweepResult): void {
  if (result.reaped <= 0) return;
  try {
    writeActivityEntry(statePath, {
      event: 'worker_orphan_reap_summary',
      ts: new Date().toISOString(),
      scanned: result.scanned,
      reaped: result.reaped,
      unverified: result.unverified,
      ...result.by_match_class,
    });
  } catch { /* best-effort telemetry — never block the caller */ }
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

/**
 * A fixture pinned to its POSIX identity: the (pid, start-time) pair. A bare pid is
 * NOT an identity — it is a slot the kernel re-issues — and every consumer here
 * signals a whole process GROUP, so a stale pid is a licence to kill a stranger.
 */
export type FixtureIdentity = {
  /** The pid as spawned. */
  pid: number;
  /** Opaque `ps -o lstart=` token captured at record time — see `readProcessStartToken`. */
  start: string;
};

export type FixturePidRegistry = {
  /** Run start epoch ms, used to age off stale registries. */
  started_at_epoch_ms: number;
  /** Fixtures spawned during this run, each pinned to its POSIX identity. */
  fixtures: FixtureIdentity[];
};

/**
 * The process's start time as an OPAQUE token — never parsed, only compared for
 * equality, so there is no date parsing and no timezone to get wrong. `null` means
 * "no such process, or it cannot be identified"; both must read as NOT-a-match, since
 * the only thing a caller does with a match is signal a process group.
 */
function readProcessStartToken(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const raw = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: PS_TIMEOUT_MS,
      maxBuffer: PS_MAX_BUFFER,
    });
    return raw.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The ONE question every step of the fixture escalation asks: is the pid I recorded
 * still the SAME process I recorded it for? Liveness and identity are not two checks —
 * a recycled pid is alive and is not the fixture, and only the pair distinguishes them.
 */
function isRecordedFixtureStillItself(fixture: FixtureIdentity): boolean {
  return readProcessStartToken(fixture.pid) === fixture.start;
}

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
    fixtures: [],
  };
  try {
    fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf-8');
  } catch { /* best-effort init */ }
  return registryPath;
}

/**
 * Record a fixture in the suite-level registry, pinned to the identity it has RIGHT
 * NOW — the caller has just spawned it, so this is the only moment the pair is
 * knowable. A pid whose identity cannot be read is not recorded at all: an
 * unidentifiable entry could only ever be signalled blind.
 * Call after each fixture spawn so cleanup survives abnormal runner death.
 */
export function recordFixturePid(registryPath: string, pid: number): void {
  const start = readProcessStartToken(pid);
  if (start === null) return;
  try {
    const existing = fs.readFileSync(registryPath, 'utf-8');
    const registry = JSON.parse(existing) as FixturePidRegistry;
    if (!Array.isArray(registry.fixtures)) return;
    if (registry.fixtures.some(entry => entry?.pid === pid)) return;
    registry.fixtures.push({ pid, start });
    fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf-8');
  } catch { /* best-effort recording */ }
}

/** Poll budgets for the fixture escalation, in `GRACE_POLL_MS` steps. */
const FIXTURE_GRACE_POLLS = Math.max(1, Math.ceil(DEFAULT_GRACE_MS / GRACE_POLL_MS));
const FIXTURE_VERIFY_POLLS = Math.max(1, Math.ceil(DEFAULT_KILL_VERIFY_MS / GRACE_POLL_MS));

/** Yield one `GRACE_POLL_MS` wait per remaining poll, stopping as soon as `stillThere` goes false. */
function* pollWhile(stillThere: () => boolean, polls: number): Generator<number, void, void> {
  for (let i = 0; i < polls && stillThere(); i++) yield GRACE_POLL_MS;
}

/**
 * The ONE fixture escalation: probe → group SIGTERM → grace → group SIGKILL → bounded
 * verify → confirm. Mirrors `reapCandidateGroup` (`:511`) and, like it, resolves `true`
 * ONLY on a confirmed death: `kill(-pid, …)` keeps succeeding while ANY group member is
 * left, so a delivered signal is never evidence the fixture is gone.
 *
 * Every probe here asks `isRecordedFixtureStillItself`, not "is this pid alive" — the
 * registry is read from disk and may name a pid a PREVIOUS run spawned, and the same
 * substitution can happen mid-escalation, between the SIGTERM and the SIGKILL.
 *
 * It yields the ms the caller must WAIT rather than sleeping itself, because the two
 * reapers can only wait one way each — `Atomics.wait` is the only option left at
 * `process.on('exit')` time, and blocking it is the one thing an `afterAll` hook must not
 * do. That is their whole difference; every kill, probe and count decision lives here once.
 */
function* escalateFixtureGroup(fixture: FixtureIdentity, platform: NodeJS.Platform): Generator<number, boolean, void> {
  const stillItself = () => isRecordedFixtureStillItself(fixture);
  if (!stillItself()) return false; // already gone, or never ours — this reaper killed nothing
  killProcessGroup(fixture.pid, 'SIGTERM', platform);
  yield* pollWhile(stillItself, FIXTURE_GRACE_POLLS);
  if (stillItself()) {
    killProcessGroup(fixture.pid, 'SIGKILL', platform);
    yield* pollWhile(stillItself, FIXTURE_VERIFY_POLLS);
  }
  return !stillItself();
}

/** Drive `escalateFixtureGroup` with blocking sleeps — the `process.on('exit')` path. */
function reapFixtureGroupSync(fixture: FixtureIdentity, platform: NodeJS.Platform): boolean {
  const escalation = escalateFixtureGroup(fixture, platform);
  let step = escalation.next();
  while (!step.done) {
    sleepSync(step.value);
    step = escalation.next();
  }
  return step.value;
}

/** Drive `escalateFixtureGroup` with timer waits — the `afterAll` path, event loop intact. */
async function reapFixtureGroupAsync(fixture: FixtureIdentity, platform: NodeJS.Platform): Promise<boolean> {
  const escalation = escalateFixtureGroup(fixture, platform);
  let step = escalation.next();
  while (!step.done) {
    const waitMs = step.value;
    await new Promise(resolve => setTimeout(resolve, waitMs));
    step = escalation.next();
  }
  return step.value;
}

/**
 * Registry entries carrying an identity to re-verify against. A missing, unreadable or
 * malformed registry yields `[]` — cleanup is best-effort and must never throw out of an
 * exit handler — and so does a registry written in the pre-identity shape (`pids: number[]`),
 * whose bare pids could only ever be signalled blind. Dropping an unidentifiable entry
 * leaks a fixture, which the age-gated `ps` sweep still collects; signalling it kills a
 * stranger, which nothing undoes.
 */
function readRecordedFixtures(registryPath: string): FixtureIdentity[] {
  try {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as FixturePidRegistry;
    if (!Array.isArray(registry.fixtures)) return [];
    return registry.fixtures.filter(entry => typeof entry?.start === 'string' && entry.start !== '');
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
  for (const fixture of readRecordedFixtures(registryPath)) {
    if (reapFixtureGroupSync(fixture, platform)) reaped++;
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
  for (const fixture of readRecordedFixtures(registryPath)) {
    if (await reapFixtureGroupAsync(fixture, platform)) reaped++;
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

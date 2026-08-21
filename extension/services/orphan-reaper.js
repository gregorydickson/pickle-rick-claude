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
function emptyMatchClassCounts() {
    return { session_owned: 0, tmp_prefix_fixture: 0, repo_fixture_path: 0 };
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
 *  - node: the worker-gate npm shim (a tmpdir, pickle- prefixed dir's bin npm script), spawned
 *    by the fast-tier test harness under a pickle-prefixed os.tmpdir() fixture dir. Scoped to
 *    that exact shape (tmpdir-anchored, pickle- prefixed first segment, bin npm path) so an
 *    unrelated node script invocation never matches.
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
    if (base === 'node') {
        return tokens.some(token => isPickleTmpBinNpmPath(token));
    }
    return false;
}
let tmpRootPrefixCache = null;
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
function tmpRootPrefixes() {
    const lexical = path.resolve(os.tmpdir());
    if (tmpRootPrefixCache?.key === lexical)
        return tmpRootPrefixCache.prefixes;
    const roots = new Set([lexical]);
    try {
        roots.add(path.resolve(fs.realpathSync(lexical)));
    }
    catch {
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
function resolveUnderTmpRoot(token) {
    if (!token.startsWith('/'))
        return null;
    const resolved = path.resolve(token);
    for (const prefix of tmpRootPrefixes()) {
        if (!resolved.startsWith(prefix))
            continue;
        const firstSegment = resolved.slice(prefix.length).split(path.sep)[0];
        if (firstSegment)
            return { resolved, firstSegment };
    }
    return null;
}
/**
 * True when `token` is an absolute path resolving under `os.tmpdir()` (by either the
 * lexical or the realpath root), whose first path segment beneath tmpdir starts with
 * `pickle-`, and whose final two segments are `bin/npm`.
 */
function isPickleTmpBinNpmPath(token) {
    const anchored = resolveUnderTmpRoot(token);
    if (!anchored || !anchored.firstSegment.startsWith('pickle-'))
        return false;
    const { resolved } = anchored;
    return path.basename(resolved) === 'npm' && path.basename(path.dirname(resolved)) === 'bin';
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
function resolveTmpPrefixFixturePath(command) {
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
function resolveRepoFixtureScriptPath(command) {
    const fixturesPrefix = FIXTURES_DIR + path.sep;
    for (const token of command.split(/\s+/)) {
        if (!token.startsWith('/'))
            continue;
        const resolved = path.resolve(token);
        if (resolved === FIXTURES_DIR || resolved.startsWith(fixturesPrefix))
            return resolved;
    }
    return null;
}
/**
 * The ONE positive-path check for the `tmp_fixture` class: a test-owned
 * tmpdir prefix OR a script anchored under this repo's fixtures dir.
 */
function resolveTestOwnedFixturePath(command) {
    return resolveTmpPrefixFixturePath(command) ?? resolveRepoFixtureScriptPath(command);
}
/**
 * Which fixture submatch fired, for reap-report match-class breakdown
 * (AC5). Mirrors `resolveTestOwnedFixturePath`'s precedence exactly — never
 * re-derive independently.
 */
function classifyFixtureMatch(command) {
    if (resolveTmpPrefixFixturePath(command) !== null)
        return 'tmp_prefix_fixture';
    if (resolveRepoFixtureScriptPath(command) !== null)
        return 'repo_fixture_path';
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
/**
 * Classify the owning session's `state.json` into three states, NOT two.
 * `readRecoverableJsonObject` collapses "no such file" and "the read threw"
 * (EMFILE/ENFILE/EIO/EACCES/EISDIR) into the same `null`, and only the first
 * of those is evidence the session is gone — the second accounts for nothing.
 * A NUL/parse-failed base is unaccountable too: the bytes are there and we
 * cannot judge them.
 */
function readOwningSessionState(sessionDir) {
    const statePath = path.join(sessionDir, 'state.json');
    let state;
    try {
        state = readRecoverableJsonObject(statePath);
    }
    catch {
        return { kind: 'unaccountable' };
    }
    if (state)
        return { kind: 'state', state };
    try {
        fs.lstatSync(statePath);
        return { kind: 'unaccountable' };
    }
    catch (err) {
        const code = err?.code;
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
function isOwningSessionLive(sessionDir, isAlive) {
    const read = readOwningSessionState(sessionDir);
    if (read.kind === 'missing')
        return false;
    if (read.kind === 'unaccountable')
        return true;
    const state = read.state;
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
    // The tmp-prefix fixture class (WS-1) has no owning session by construction
    // (see WorkerProcCandidate.kind) — the null reject below applies only to
    // the codex/claude worker class, which keeps the R-CXHANG positive-
    // ownership invariant fully intact.
    const { owningSessionDir } = cand;
    if (cand.kind !== 'tmp_fixture' && owningSessionDir === null)
        return false;
    if (cand.etime_seconds < rt.minAgeSeconds)
        return false;
    if (cand.kind === 'tmp_fixture' || owningSessionDir === null)
        return true;
    return !isOwningSessionLive(owningSessionDir, rt.isAlive);
}
/**
 * Reuse the spawn-morty escalation shape: group SIGTERM → grace → group SIGKILL
 * → bounded verify. Returns whether the group is CONFIRMED dead — callers must
 * count `reaped` ONLY on `true`; an unverified survivor is reported but never
 * silently counted as gone.
 */
function reapCandidateGroup(cand, rt) {
    rt.kill(cand.pgid, 'SIGTERM');
    const graceDeadline = Date.now() + rt.graceMs;
    let gracePolls = Math.max(1, Math.ceil(rt.graceMs / GRACE_POLL_MS));
    while (rt.isAlive(cand.pid) && Date.now() < graceDeadline && gracePolls > 0) {
        rt.sleep(GRACE_POLL_MS);
        gracePolls -= 1;
    }
    if (rt.isAlive(cand.pid))
        rt.kill(cand.pgid, 'SIGKILL');
    const verifyDeadline = Date.now() + rt.killVerifyMs;
    let verifyPolls = Math.max(1, Math.ceil(rt.killVerifyMs / GRACE_POLL_MS));
    while (rt.isAlive(cand.pid) && Date.now() < verifyDeadline && verifyPolls > 0) {
        rt.sleep(GRACE_POLL_MS);
        verifyPolls -= 1;
    }
    const verified = !rt.isAlive(cand.pid);
    if (verified) {
        emitReapedTelemetry(cand, rt);
    }
    else {
        emitUnverifiedTelemetry(cand, rt, 'survived_sigkill');
    }
    return verified;
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
/** Reports a candidate that could NOT be verified dead — never counted as `reaped`. */
function emitUnverifiedTelemetry(cand, rt, reason) {
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
        }
        catch { /* event emission is best-effort */ }
    }
    rt.log?.(`unverified orphan worker pid=${cand.pid} pgid=${cand.pgid} reason=${reason} session=${owningSession}`);
}
/**
 * Handles one reapable candidate: budget-skip (report, don't attempt) or full
 * escalation-and-verify. Returns `'reaped'` / `'unverified'` for the caller's
 * tally; the caller has already confirmed `isReapableOrphan`.
 */
function processReapableCandidate(cand, rt, reapedPgids, deadline) {
    if (Date.now() > deadline) {
        emitUnverifiedTelemetry(cand, rt, 'budget_exceeded');
        return 'unverified';
    }
    const verified = reapCandidateGroup(cand, rt);
    reapedPgids.add(cand.pgid);
    return verified ? 'reaped' : 'unverified';
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
        killVerifyMs: opts.killVerifyMs ?? DEFAULT_KILL_VERIFY_MS,
        ...(opts.statePath !== undefined ? { statePath: opts.statePath } : {}),
        ...(opts.log !== undefined ? { log: opts.log } : {}),
    };
    const deadline = Date.now() + (opts.wallBudgetMs ?? DEFAULT_WALL_BUDGET_MS);
    const reapedPgids = new Set();
    const tally = { reaped: 0, unverified: 0, by_match_class: emptyMatchClassCounts() };
    for (const cand of candidates) {
        if (!isReapableOrphan(cand, rt, reapedPgids))
            continue;
        tallyReapOutcome(tally, cand, processReapableCandidate(cand, rt, reapedPgids, deadline));
    }
    return { scanned: candidates.length, ...tally };
}
/** Accumulates one candidate's disposition into the running sweep tally. */
function tallyReapOutcome(tally, cand, outcome) {
    if (outcome !== 'reaped') {
        tally.unverified += 1;
        return;
    }
    tally.reaped += 1;
    if (cand.matchClass)
        tally.by_match_class[cand.matchClass] += 1;
}
/**
 * Reap detached worker procs (codex/claude) that no live pickle session owns.
 * Never throws (best-effort); never kills an unattributable or live-owned proc.
 * The returned per-match-class breakdown (`by_match_class`) is what lets a
 * caller report a non-zero sweep without logging noise on a zero-reap sweep
 * (AC5): session-owned, tmp-prefix fixture, repo fixture path.
 */
export function reapOrphanedWorkerProcs(opts) {
    const env = opts.env ?? process.env;
    if (env[ORPHAN_REAP_ENV_VAR] === 'off')
        return { scanned: 0, reaped: 0, unverified: 0, by_match_class: emptyMatchClassCounts() };
    const platform = opts.platform ?? process.platform;
    if (platform === 'win32')
        return { scanned: 0, reaped: 0, unverified: 0, by_match_class: emptyMatchClassCounts() };
    try {
        return runReapPass(opts, platform);
    }
    catch {
        // Best-effort collector — a reaper failure must never block a launch.
        return { scanned: 0, reaped: 0, unverified: 0, by_match_class: emptyMatchClassCounts() };
    }
}
// ============================================================================
// Suite-level registry teardown: survives abnormal runner death
// ============================================================================
/**
 * Path for the run-scoped PID registry. A test run records fixture PIDs here;
 * `afterAll` / `process.on('exit')` / startup sweep all read from it.
 */
function getPidRegistryPath(registryDir) {
    return path.join(registryDir, 'fixture_pid_registry.json');
}
/**
 * Initialize or append to the fixture PID registry for this test run.
 * Call this once at suite startup (before first fixture spawn).
 * Returns the registry path so afterAll/process.on('exit') can find it.
 */
export function initFixturePidRegistry(registryDir) {
    try {
        fs.mkdirSync(registryDir, { recursive: true });
    }
    catch { /* race on mkdir, ignore */ }
    const registryPath = getPidRegistryPath(registryDir);
    const registry = {
        started_at_epoch_ms: Date.now(),
        pids: [],
    };
    try {
        fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf-8');
    }
    catch { /* best-effort init */ }
    return registryPath;
}
/**
 * Record a fixture PID in the suite-level registry.
 * Call after each fixture spawn so cleanup survives abnormal runner death.
 */
export function recordFixturePid(registryPath, pid) {
    try {
        const existing = fs.readFileSync(registryPath, 'utf-8');
        const registry = JSON.parse(existing);
        if (!registry.pids.includes(pid)) {
            registry.pids.push(pid);
            fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf-8');
        }
    }
    catch { /* best-effort recording */ }
}
/**
 * Synchronously reap all fixtures recorded in the registry.
 * Called from process.on('exit') so it runs even on SIGKILL of the test runner.
 */
export function reapFixturesSync(registryPath, platform = process.platform) {
    if (platform === 'win32')
        return 0;
    let reaped = 0;
    try {
        const data = fs.readFileSync(registryPath, 'utf-8');
        const registry = JSON.parse(data);
        for (const pid of registry.pids) {
            if (!Number.isInteger(pid) || pid <= 0)
                continue;
            // Verify the PID is still alive and is our fixture (not recycled)
            try {
                // Use ps -p <pid> to verify the PID is still the fixture (never ps | grep)
                execFileSync('ps', ['-p', String(pid)], { encoding: 'utf-8', stdio: 'pipe' });
            }
            catch {
                // PID is not alive or not running, skip
                continue;
            }
            // PID is alive. Escalate: SIGTERM → grace → SIGKILL
            try {
                process.kill(-pid, 'SIGTERM');
            }
            catch { /* process may already be terminating */ }
            // Brief grace for SIGTERM
            for (let i = 0; i < 20; i++) {
                try {
                    execFileSync('ps', ['-p', String(pid)], { encoding: 'utf-8', stdio: 'pipe' });
                }
                catch {
                    reaped++;
                    break;
                }
                if (i < 19)
                    sleepSync(100);
            }
            // If still alive, escalate to SIGKILL
            try {
                process.kill(-pid, 'SIGKILL');
                reaped++;
            }
            catch { /* process may already be gone */ }
        }
    }
    catch { /* best-effort cleanup */ }
    try {
        fs.unlinkSync(registryPath);
    }
    catch { /* already removed or never existed */ }
    return reaped;
}
/**
 * Asynchronously reap all fixtures from the registry.
 * Called from afterAll hook so normal cleanup happens even if test times out.
 */
export async function reapFixtures(registryPath, platform = process.platform) {
    if (platform === 'win32')
        return 0;
    let reaped = 0;
    try {
        const data = fs.readFileSync(registryPath, 'utf-8');
        const registry = JSON.parse(data);
        for (const pid of registry.pids) {
            if (!Number.isInteger(pid) || pid <= 0)
                continue;
            // Verify PID is alive using ps -p <pid>
            try {
                execFileSync('ps', ['-p', String(pid)], { encoding: 'utf-8', stdio: 'pipe' });
            }
            catch {
                continue;
            }
            // PID is alive. Escalate: SIGTERM → grace → SIGKILL
            try {
                process.kill(-pid, 'SIGTERM');
            }
            catch { /* process may already be terminating */ }
            // Grace period
            await new Promise(resolve => setTimeout(resolve, 2000));
            try {
                execFileSync('ps', ['-p', String(pid)], { encoding: 'utf-8', stdio: 'pipe' });
                // Still alive, escalate to SIGKILL
                process.kill(-pid, 'SIGKILL');
                reaped++;
            }
            catch {
                reaped++;
            }
        }
    }
    catch { /* best-effort cleanup */ }
    try {
        fs.unlinkSync(registryPath);
    }
    catch { /* already removed or never existed */ }
    return reaped;
}
/**
 * Startup sweep: if a registry from a previous run exists, reap those PIDs.
 * This makes fixture cleanup observable after a runner crash/SIGKILL.
 * Call once at suite startup, before initFixturePidRegistry.
 */
export function reapPreviousRunFixtures(registryDir, platform = process.platform) {
    if (platform === 'win32')
        return 0;
    const registryPath = getPidRegistryPath(registryDir);
    let reaped = 0;
    try {
        const stat = fs.statSync(registryPath);
        const ageMs = Date.now() - stat.mtimeMs;
        // Only reap registries from the last 24 hours (stale ones are abandoned)
        if (ageMs > 24 * 3600 * 1000)
            return 0;
        reaped = reapFixturesSync(registryPath, platform);
    }
    catch { /* no previous registry or cleanup error */ }
    return reaped;
}

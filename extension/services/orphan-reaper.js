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
export function killProcessGroup(pid, signal, platform = process.platform) {
    if (platform === 'win32')
        return false;
    if (!Number.isInteger(pid) || pid <= 1)
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
/**
 * The ONE not-run result. Every path that returns without scanning renders through it, so
 * "we counted nothing" and "we never counted" cannot collapse into the same zero tuple again.
 *
 * They did: the kill-switch, the win32 no-op and the best-effort catch each returned their own
 * `scanned: 0` literal, so a `ps` that was absent, timed out, or overflowed its buffer reported
 * byte-identically to a genuinely quiet box — and both `bin/reap-orphans.ts` and
 * `setup.ts:runSetupOrphanReap` print that count as the operator's census.
 */
function sweepNotRun(reason) {
    return { scanned: 0, reaped: 0, unverified: 0, by_match_class: emptyMatchClassCounts(), skipped: reason };
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
 *
 * Admission and match class come out of the SAME evaluation. They used to be
 * two functions — `resolveTestOwnedFixturePath` returning the path and
 * `classifyFixtureMatch` re-running both submatchers to name the class — under
 * a comment instructing the second to mirror the first's precedence and "never
 * re-derive independently", which is exactly what it did. A submatcher added
 * to one and not the other admits a candidate the report then labels `null`.
 */
function matchTestOwnedFixture(command) {
    const tmpPrefixPath = resolveTmpPrefixFixturePath(command);
    if (tmpPrefixPath !== null)
        return { path: tmpPrefixPath, matchClass: 'tmp_prefix_fixture' };
    const repoFixturePath = resolveRepoFixtureScriptPath(command);
    if (repoFixturePath !== null)
        return { path: repoFixturePath, matchClass: 'repo_fixture_path' };
    return null;
}
/** Parse a base-10 ps column into a finite integer; -1 on malformed input. */
function parsePsInt(raw) {
    const value = Number(raw);
    return Number.isFinite(value) && Number.isInteger(value) ? value : -1;
}
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
function classifyWorkerProc(command, sessionsRoot) {
    const workerShaped = isWorkerShapedCommand(command);
    const owningSessionDir = workerShaped ? resolveOwningSessionDir(command, sessionsRoot) : null;
    if (owningSessionDir !== null)
        return { owningSessionDir, kind: 'worker', matchClass: 'session_owned' };
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
        const classified = classifyWorkerProc(command, sessionsRoot);
        if (classified === null)
            continue;
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
export function parseSelfPgidFromPs(psOutput, selfPid) {
    for (const rawLine of psOutput.split(/\r?\n/)) {
        const match = rawLine.trim().match(/^(\d+)\s+(\d+)\s+/);
        if (!match)
            continue;
        if (parsePsInt(match[1]) !== selfPid)
            continue;
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
function resolveSelfIds(psOutput) {
    const ids = new Set([process.pid, process.ppid]);
    const selfPgid = parseSelfPgidFromPs(psOutput, process.pid);
    if (selfPgid !== null)
        ids.add(selfPgid);
    return ids;
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
 * TRAP DOOR: a positive match required before any kill — but which match depends
 * on `cand.kind`, and the two are not interchangeable (see the module docblock).
 * Skips self/parent GROUPS, under-age procs, an already-reaped group, any
 * `worker` whose owning session is live, and any `worker` with no owning session
 * at all. A `tmp_fixture` reaches the kill on AGE ALONE — the ownership reject
 * below is conditional on `kind !== 'tmp_fixture'`, so `selfIds` is that class's
 * only self-protection. No ppid==1-only branch by design.
 */
function isReapableOrphan(cand, rt, reapedPgids) {
    // Never signal anything that would land on US — see `selfIds`. One membership
    // test over both axes, because `kill(-pgid)` reaches the caller whenever the
    // caller shares that group, whatever the leader's relationship to us is.
    if (rt.selfIds.has(cand.pid) || rt.selfIds.has(cand.pgid))
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
        selfIds: resolveSelfIds(psOutput),
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
    return { scanned: candidates.length, ...tally, skipped: null };
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
 *
 * `skipped` is the did-we-actually-count axis: `null` means the census is real, so `scanned: 0`
 * is evidence of a quiet box. Any other value means no census exists — the caller must NOT
 * render its zero counts as "nothing to reap". Still best-effort: a failure returns, never throws.
 */
export function reapOrphanedWorkerProcs(opts) {
    const env = opts.env ?? process.env;
    if (env[ORPHAN_REAP_ENV_VAR] === 'off')
        return sweepNotRun('kill_switch');
    const platform = opts.platform ?? process.platform;
    if (platform === 'win32')
        return sweepNotRun('unsupported_platform');
    try {
        return runReapPass(opts, platform);
    }
    catch {
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
export function emitOrphanReapSummary(statePath, result) {
    if (result.reaped <= 0)
        return;
    try {
        writeActivityEntry(statePath, {
            event: 'worker_orphan_reap_summary',
            ts: new Date().toISOString(),
            scanned: result.scanned,
            reaped: result.reaped,
            unverified: result.unverified,
            ...result.by_match_class,
        });
    }
    catch { /* best-effort telemetry — never block the caller */ }
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
 * The process's start time as an OPAQUE token — never parsed, only compared for
 * equality, so there is no date parsing and no timezone to get wrong. `null` means
 * "no such process, or it cannot be identified"; both must read as NOT-a-match, since
 * the only thing a caller does with a match is signal a process group.
 */
function readProcessStartToken(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return null;
    try {
        const raw = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
            encoding: 'utf-8',
            timeout: PS_TIMEOUT_MS,
            maxBuffer: PS_MAX_BUFFER,
        });
        return raw.trim() || null;
    }
    catch {
        return null;
    }
}
/**
 * The ONE question every step of the fixture escalation asks: is the pid I recorded
 * still the SAME process I recorded it for? Liveness and identity are not two checks —
 * a recycled pid is alive and is not the fixture, and only the pair distinguishes them.
 */
function isRecordedFixtureStillItself(fixture) {
    return readProcessStartToken(fixture.pid) === fixture.start;
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
        fixtures: [],
    };
    try {
        fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf-8');
    }
    catch { /* best-effort init */ }
    return registryPath;
}
/**
 * Record a fixture in the suite-level registry, pinned to the identity it has RIGHT
 * NOW — the caller has just spawned it, so this is the only moment the pair is
 * knowable. A pid whose identity cannot be read is not recorded at all: an
 * unidentifiable entry could only ever be signalled blind.
 * Call after each fixture spawn so cleanup survives abnormal runner death.
 */
export function recordFixturePid(registryPath, pid) {
    const start = readProcessStartToken(pid);
    if (start === null)
        return;
    try {
        const existing = fs.readFileSync(registryPath, 'utf-8');
        const registry = JSON.parse(existing);
        if (!Array.isArray(registry.fixtures))
            return;
        if (registry.fixtures.some(entry => entry?.pid === pid))
            return;
        registry.fixtures.push({ pid, start });
        fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf-8');
    }
    catch { /* best-effort recording */ }
}
/** Poll budgets for the fixture escalation, in `GRACE_POLL_MS` steps. */
const FIXTURE_GRACE_POLLS = Math.max(1, Math.ceil(DEFAULT_GRACE_MS / GRACE_POLL_MS));
const FIXTURE_VERIFY_POLLS = Math.max(1, Math.ceil(DEFAULT_KILL_VERIFY_MS / GRACE_POLL_MS));
/** Yield one `GRACE_POLL_MS` wait per remaining poll, stopping as soon as `stillThere` goes false. */
function* pollWhile(stillThere, polls) {
    for (let i = 0; i < polls && stillThere(); i++)
        yield GRACE_POLL_MS;
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
function* escalateFixtureGroup(fixture, platform) {
    const stillItself = () => isRecordedFixtureStillItself(fixture);
    if (!stillItself())
        return false; // already gone, or never ours — this reaper killed nothing
    killProcessGroup(fixture.pid, 'SIGTERM', platform);
    yield* pollWhile(stillItself, FIXTURE_GRACE_POLLS);
    if (stillItself()) {
        killProcessGroup(fixture.pid, 'SIGKILL', platform);
        yield* pollWhile(stillItself, FIXTURE_VERIFY_POLLS);
    }
    return !stillItself();
}
/** Drive `escalateFixtureGroup` with blocking sleeps — the `process.on('exit')` path. */
function reapFixtureGroupSync(fixture, platform) {
    const escalation = escalateFixtureGroup(fixture, platform);
    let step = escalation.next();
    while (!step.done) {
        sleepSync(step.value);
        step = escalation.next();
    }
    return step.value;
}
/** Drive `escalateFixtureGroup` with timer waits — the `afterAll` path, event loop intact. */
async function reapFixtureGroupAsync(fixture, platform) {
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
function readRecordedFixtures(registryPath) {
    try {
        const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
        if (!Array.isArray(registry.fixtures))
            return [];
        return registry.fixtures.filter(entry => typeof entry?.start === 'string' && entry.start !== '');
    }
    catch {
        return [];
    }
}
/** Drop the registry once a reap pass has walked it; a leftover file re-reaps recycled PIDs. */
function discardRegistry(registryPath) {
    try {
        fs.unlinkSync(registryPath);
    }
    catch { /* already removed or never existed */ }
}
/**
 * Synchronously reap all fixtures recorded in the registry.
 *
 * Registered by the suites that spawn fixtures via `process.on('exit')`
 * (`tests/fixture-lifetime-and-registry.test.js`, `tests/integration/orphan-worker-reaper-*.js`).
 *
 * WHAT THAT COVERS: a normal exit, and an exit forced by an uncaught fatal — both of which run
 * exit handlers.
 *
 * WHAT IT DOES NOT COVER, and cannot: **SIGKILL, `process.abort()`, and an OOM kill of the test
 * runner.** The kernel does not deliver SIGKILL to a handler, so no in-process cleanup — this one
 * or any other — runs on that path. An earlier version of this comment claimed the opposite
 * ("so it runs even on SIGKILL"); it was false (R-GRLS / FR-B2).
 *
 * Unlike file descriptors, the fixtures leaked that way are child PROCESSES, so the kernel does
 * not reclaim them when the runner dies. The recovery is out-of-process and deferred:
 * `reapPreviousRunFixtures` sweeps the surviving registry at the NEXT run's startup. That is the
 * only thing standing between an abruptly-killed runner and an orphaned fixture — so the residue
 * is bounded and self-healing across runs, but it is NOT cleaned up at the moment of death.
 */
export function reapFixturesSync(registryPath, platform = process.platform) {
    if (platform === 'win32')
        return 0;
    let reaped = 0;
    for (const fixture of readRecordedFixtures(registryPath)) {
        if (reapFixtureGroupSync(fixture, platform))
            reaped++;
    }
    discardRegistry(registryPath);
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
    for (const fixture of readRecordedFixtures(registryPath)) {
        if (await reapFixtureGroupAsync(fixture, platform))
            reaped++;
    }
    discardRegistry(registryPath);
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
// ============================================================================
// C2 — source-derived posttest TMPDIR sweep (long-tail mkdtempSync producers)
// ============================================================================
/**
 * This module's own tests/ tree — present in the dev checkout (where `npm test` and this
 * file's own unit tests run) and ABSENT from the deployed extension (`install.sh` rsyncs
 * with `--exclude='tests'`). `deriveTestOwnedTmpPrefixes` degrades to `[]` when it is
 * missing rather than throwing, so a caller resolving this default never needs to know
 * which context it is running in.
 */
const DEFAULT_TEST_SOURCE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tests');
/**
 * Captures every single- or double-quoted string literal that ends in a path-segment separator
 * (`-`, `_`, `.`) — the universal shape of an `mkdtemp` prefix.
 *
 * Deliberately NOT anchored to the `mkdtempSync(path.join(os.tmpdir(), …` call site. The
 * dominant producer in this suite passes its prefix through a one-hop local helper
 * (`makeTmp('ratrail-session-')`, `mkTmpDir('judge-codex-')`, `mkFixtureTmpDir(prefix)`), so a
 * call-site-anchored regex sees a variable, not a literal. Measured against the live TMPDIR, the
 * call-site form attributed 15 of 4971 leaked directories where this harvest attributes 1839 —
 * and keying on helper NAMES instead would just re-create the enumerated set (`makeTmp`,
 * `makeTmpRoot`, `mkTmp`, `makeTempDir`, `makeSession`, `makeRepo`, `makeFixture`, …) that this
 * ticket exists to remove.
 *
 * Harvesting this broadly is safe only because of the attribution rule in
 * `sweepDerivedTmpDirFixtures`; the reasoning lives there, next to the `rmSync` it licenses.
 */
const SEPARATOR_TERMINATED_LITERAL_RE = /['"]([^'"\\\n]{1,120}[-_.])['"]/g;
/**
 * A derived prefix must be a plain filename-safe token. One positive rule, no blacklist: it
 * rejects path separators (never part of a basename prefix), whitespace, and — the case this
 * suite actually produces — template-interpolation source text such as `${prefix}` picked up
 * from a test that writes generated code inside a backtick literal.
 */
const PLAIN_PATH_TOKEN_RE = /^[A-Za-z0-9._-]+$/;
/**
 * The exact suffix `fs.mkdtempSync` appends: six characters drawn from `[A-Za-z0-9]`. Measured
 * on this platform rather than assumed. Requiring it is what makes a broad literal harvest a
 * SAFE attribution rule instead of a dangerous one.
 */
const MKDTEMP_SUFFIX_RE = /^[A-Za-z0-9]{6}$/;
/** Length of the random suffix `fs.mkdtempSync` appends to its prefix. */
const MKDTEMP_SUFFIX_LEN = 6;
/**
 * How long a TMPDIR fixture directory must sit untouched before ANY sweep in this repo may
 * remove it — the single source of truth for that floor, imported by
 * `bin/reap-orphans.ts:sweepStaleFixtureTmpDirs` (which previously kept its own copy) and
 * applied by `sweepDerivedTmpDirFixtures`. One directory, matched by both sweeps under one
 * prefix, must not be governed by two staleness policies: the looser one simply wins and
 * removes what the stricter one spared. No single test tier runs anywhere near this long, so
 * a directory untouched for a day belongs to no live run.
 */
export const FIXTURE_TMPDIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * True only when `dir`'s mtime is provably older than `maxAgeMs`. An unstattable entry is NOT
 * proof of staleness and defers — same positive-proof discipline `isProcessAlive` applies to
 * pids, for the same reason: the verdict licenses an irreversible recursive removal.
 */
function isStaleFixtureTmpDir(dir, now, maxAgeMs) {
    try {
        return now - fs.statSync(dir).mtimeMs >= maxAgeMs;
    }
    catch {
        return false;
    }
}
let derivedTestOwnedTmpPrefixCache = null;
/** Recursively collects `.js` file paths under `dir`; best-effort, `[]` on any read failure. */
function walkJsFiles(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const out = [];
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...walkJsFiles(full));
        }
        else if (entry.isFile() && entry.name.endsWith('.js')) {
            out.push(full);
        }
    }
    return out;
}
/**
 * Derives the set of candidate test-owned TMPDIR fixture prefixes DIRECTLY from test source,
 * by scanning every `.js` file under `testsDir` for separator-terminated string literals.
 *
 * This is the CLAUDE.md-mandated alternative to a hand-maintained prefix catalog: a prefix
 * that exists in the tree is derived, one that does not is not, and the set updates itself
 * the moment a test file changes — no list to edit, no 952nd-prefix silent miss. Crucially it
 * needs no call-site analysis either, so a prefix reaches the set identically whether its test
 * calls `mkdtempSync` directly, hands it to a one-hop local helper, or imports
 * `mkFixtureTmpDir` from another file. There is nothing here to teach about a new indirection.
 *
 * The set is deliberately a SUPERSET of the real prefixes — it holds ordinary string literals
 * that no producer ever passes to `mkdtemp` — which is what lets it stay list-free. Those
 * extra members are inert under the attribution rule; see `sweepDerivedTmpDirFixtures`.
 *
 * Deliberate under-counts, stated rather than hidden: a producer whose prefix does not end in
 * `-`/`_`/`.`, or that builds its root with `mkdirSync` rather than `mkdtempSync`, is not
 * derived and its directories are left alone. Under-counting leaks a directory; over-counting
 * deletes a stranger's data, and on macOS `os.tmpdir()` is a per-user directory shared with
 * every other application. The asymmetry decides the direction.
 *
 * Memoized per `testsDir` value for the lifetime of the process (mirrors `tmpRootPrefixes`'s
 * cache shape); a caller that needs a fresh read across a mutated tree passes a distinct
 * `testsDir`.
 *
 * Returns `[]`, never throws, when `testsDir` is absent or unreadable — the deployed
 * extension's compiled `services/` has no sibling `tests/` (`install.sh --exclude='tests'`),
 * so this is the ordinary production answer, not an error condition.
 */
export function deriveTestOwnedTmpPrefixes(testsDir = DEFAULT_TEST_SOURCE_DIR) {
    if (derivedTestOwnedTmpPrefixCache?.key === testsDir)
        return derivedTestOwnedTmpPrefixCache.prefixes;
    const prefixes = new Set();
    for (const filePath of walkJsFiles(testsDir)) {
        let content;
        try {
            content = fs.readFileSync(filePath, 'utf-8');
        }
        catch {
            continue;
        }
        for (const match of content.matchAll(SEPARATOR_TERMINATED_LITERAL_RE)) {
            const literal = match[1];
            if (literal && PLAIN_PATH_TOKEN_RE.test(literal))
                prefixes.add(literal);
        }
    }
    const result = [...prefixes].sort();
    derivedTestOwnedTmpPrefixCache = { key: testsDir, prefixes: result };
    return result;
}
/**
 * Posttest TMPDIR sweep for the long tail of `mkdtempSync` producers that never adopted
 * `tests/helpers/fixture-tmpdir.js`'s crash-surviving registry (ticket C2; the two dominant
 * producers, `cp-git-`/`cp-state-`, were converted to that registry directly by ticket 40 and
 * are out of this sweep's scope).
 *
 * Guard rails, all load-bearing:
 *  - ATTRIBUTION ONLY, ON TWO INDEPENDENT AXES: an entry is removed only when its basename is
 *    EXACTLY a derived prefix followed by the 6 random `[A-Za-z0-9]` characters that
 *    `fs.mkdtempSync` itself appends. Both halves matter. Exact-match (never `startsWith`) is
 *    what makes a short derived prefix safe: the suite really does produce `ai-`, `cp-`, `sm-`
 *    and `rs-`, and under a `startsWith` rule any of those would attribute — and recursively
 *    remove — a foreign `ai-cache` or `sm-notes` sitting in the same shared TMPDIR. Requiring
 *    the `mkdtemp` shape is what makes a broad source-literal harvest safe, since an ordinary
 *    string literal that names no fixture root matches nothing.
 *  - CONFINED TO TMPDIR: only entries returned by `readdirSync(tmpDir)` are considered, and
 *    each candidate's resolved path is re-verified to fall strictly under the resolved
 *    `tmpDir` before removal — a path can never escape the root it was listed from.
 *  - STALE ONLY, ON THE ONE FLOOR THIS REPO ALREADY HAS: attribution answers "is this a
 *    fixture of our shape", never "is anyone still using it", and a correct attribution is
 *    exactly when removal is most destructive. The earlier rationale here — that the owning
 *    test process has already exited by `posttest` time — holds only for a machine running
 *    ONE test process. It does not: the worker gate runs `npm run test:fast` per ticket
 *    (`spawn-morty.ts:runWorkerGateTestCommand`) and the worker-spawn lock is session-scoped
 *    "so it never serializes two unrelated sessions sharing one repo checkout", so a sweep
 *    fired by one run routinely overlaps another. `test-runner.ts:createDisposableTmpRoot`
 *    then makes the collision total rather than incidental: it mkdtemps `pickle-` under
 *    `os.tmpdir()` and hands it to the spawned child as `TMPDIR`, so a live run's ENTIRE
 *    fixture tree hangs off one directory whose basename is `pickle-` + 6 alnum — the exact
 *    shape attributed above, with `pickle-` derived from test source like any other prefix.
 *    A bare directory has no liveness signal to probe, so staleness is decided by mtime, on
 *    `FIXTURE_TMPDIR_MAX_AGE_MS` — the SAME floor `bin/reap-orphans.ts:sweepStaleFixtureTmpDirs`
 *    already applies to `pickle-*` in this same `posttest` hook. Two sweeps over one directory
 *    matching one prefix under two staleness policies is the divergence, not the coverage: the
 *    unfloored one runs second and removes precisely what the floored one deliberately spared.
 *    Deferring a leak by one floor costs a later sweep; taking it costs a live run its whole
 *    TMPDIR and every gate reading that run a false red.
 *
 * Best-effort: a `readdirSync`/`rmSync` failure on one entry is swallowed and the sweep
 * continues — it must never throw into the `posttest` hook it runs under.
 */
export function sweepDerivedTmpDirFixtures(opts = {}) {
    const tmpDir = path.resolve(opts.tmpDir ?? os.tmpdir());
    const prefixes = opts.prefixes ?? deriveTestOwnedTmpPrefixes(opts.testsDir ?? DEFAULT_TEST_SOURCE_DIR);
    const maxAgeMs = opts.maxAgeMs ?? FIXTURE_TMPDIR_MAX_AGE_MS;
    const prefixSet = new Set(prefixes);
    let entries;
    try {
        entries = fs.readdirSync(tmpDir, { withFileTypes: true });
    }
    catch {
        return { scanned: 0, removed: 0, prefixes_used: prefixes };
    }
    const now = Date.now();
    let scanned = 0;
    let removed = 0;
    const tmpDirPrefix = tmpDir + path.sep;
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        if (entry.name.length <= MKDTEMP_SUFFIX_LEN)
            continue;
        if (!MKDTEMP_SUFFIX_RE.test(entry.name.slice(-MKDTEMP_SUFFIX_LEN)))
            continue;
        if (!prefixSet.has(entry.name.slice(0, -MKDTEMP_SUFFIX_LEN)))
            continue;
        const resolved = path.resolve(path.join(tmpDir, entry.name));
        if (!resolved.startsWith(tmpDirPrefix))
            continue;
        scanned += 1;
        if (!isStaleFixtureTmpDir(resolved, now, maxAgeMs))
            continue;
        try {
            fs.rmSync(resolved, { recursive: true, force: true });
            removed += 1;
        }
        catch { /* best-effort — a lost removal is left for the next sweep */ }
    }
    return { scanned, removed, prefixes_used: prefixes };
}

// scope-resolver: parse CLI `--scope` flags, compute `allowed_paths`, and
// persist `scope.json` v1 at the session root. Pure parser + thin git-backed
// resolver. One-hop strategy is a stub here (A2 implements the expansion).
//
// SCOPE_LIMITATION: aliased-imports-not-detected
//   The one-hop strategy (ticket A2) walks single-level imports via grep over
//   raw import/require strings. TypeScript `paths` aliases, Webpack/Vite
//   resolver aliases, and runtime string concatenation are NOT traversed —
//   an aliased dependency will look import-free to the grep and be excluded
//   from the expanded set. Operators relying on path aliases must widen
//   scope manually with `--scope paths:<glob>`.
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runGit, getHeadSha, getDiffFiles, getMergeBase } from './git-utils.js';
import { StateManager, isProcessAlive } from './state-manager.js';
/** Max number of seed files permitted for one-hop expansion. Above this, throw SCOPE_ONE_HOP_TOO_LARGE. */
const ONE_HOP_FILE_CAP = 100;
/**
 * Per-subprocess timeout for the rg/grep importer-walk in {@link findImporters}.
 * Without this, a wedged ripgrep/grep (FIFO under repoRoot, stuck FUSE mount,
 * catastrophic regex backtracking) blocks scope resolution indefinitely with
 * no log output — the same silent-hang class as the council-publish `gh`
 * timeout gap. See `extension/CLAUDE.md` trap doors.
 *
 * R-SRGT-2: lowered 30s → 5s. `rg -l` over even a large monorepo completes in
 * 1-3s; a slower run is a wedged process, not legitimate work. The smaller
 * per-grep budget also lets more export names be walked before the aggregate
 * {@link ONE_HOP_WALK_WALL_MS} cap fires.
 */
const FIND_IMPORTERS_TIMEOUT_MS = 5_000;
/**
 * R-SRGT-2: aggregate wall-clock cap for the whole {@link computeOneHop}
 * importer walk. A seed file with many exports in a large repo runs one grep
 * per export name; without this cap that is `N × FIND_IMPORTERS_TIMEOUT_MS`
 * with no aggregate bound (Finding #50 — the readiness gate spent 67s here).
 * On exceed, the walk returns its partial importer set instead of grinding on.
 */
const ONE_HOP_WALK_WALL_MS = 60_000;
export class ScopeError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'ScopeError';
        this.code = code;
    }
}
/**
 * Parse the raw `--scope <flag>` value into `{mode, strategy, base}`.
 * `base` carries the inline ref for `diff:<ref>` and the glob list for
 * `paths:<glob,glob>`; `null` for bare/strict branch forms.
 * Throws `ScopeError('SCOPE_BAD_FLAG', …)` on unknown input.
 */
export function parseScope(flag) {
    if (typeof flag !== 'string' || flag.length === 0) {
        throw new ScopeError('SCOPE_BAD_FLAG', `Unrecognized --scope value: ${JSON.stringify(flag)}`);
    }
    if (flag === 'branch' || flag === 'branch:strict') {
        return { mode: 'branch', strategy: 'strict', base: null };
    }
    if (flag === 'branch:one-hop') {
        return { mode: 'branch', strategy: 'one-hop', base: null };
    }
    if (flag.startsWith('diff:')) {
        const parts = flag.split(':');
        if (parts.length === 2 && parts[1].length > 0) {
            return { mode: 'diff', strategy: 'strict', base: parts[1] };
        }
        if (parts.length === 3 && parts[1].length > 0 && parts[2] === 'one-hop') {
            return { mode: 'diff', strategy: 'one-hop', base: parts[1] };
        }
        throw new ScopeError('SCOPE_BAD_FLAG', `Malformed --scope diff form: ${flag}`);
    }
    if (flag.startsWith('paths:')) {
        const rest = flag.slice('paths:'.length);
        if (rest.length === 0) {
            throw new ScopeError('SCOPE_BAD_FLAG', `--scope paths: requires at least one glob`);
        }
        return { mode: 'paths', strategy: 'strict', base: rest };
    }
    throw new ScopeError('SCOPE_BAD_FLAG', `Unrecognized --scope value: ${flag}`);
}
/**
 * Resolve `args` into a `ScopeJson` and persist it atomically to
 * `${sessionRoot}/scope.json`.
 *
 * Semantics:
 * - `branch` / `diff:<ref>`: diff base…HEAD, include A/M/R-new, exclude D/B.
 * - `paths:<glob,…>`: comma-split globs matched against `git ls-files -co
 *   --exclude-standard`. Zero match → `SCOPE_EMPTY_PATHS`.
 * - Base default for branch: `--scope-base` > upstream (unless it is
 *   `origin/<HEAD-branch>`) > `origin/<remote-default>` > `origin/main`.
 * - `allowed_paths` sorted byte-order (FR-27, locale-independent).
 *
 * `strategy:'one-hop'` expands `allowed_paths` to include one-hop importers
 * via `computeOneHop`. See that function for grep-based limitations.
 */
export function resolveScope(args) {
    const { repoRoot, sessionRoot } = args;
    assertIsRepo(repoRoot);
    const parsed = parseScope(args.scopeFlag);
    const headSha = getHeadSha(repoRoot);
    const resolved = parsed.mode === 'paths'
        ? { allowed: resolveAllowedFromPaths(parsed.base, args.target, repoRoot), baseRef: null, baseSha: null }
        : resolveAllowedFromDiffMode(parsed, args, headSha, repoRoot);
    const base = Array.from(new Set(resolved.allowed.map(toPosix)));
    const expanded = parsed.strategy === 'one-hop' ? computeOneHop(base, repoRoot) : base;
    const normalized = expanded.sort(byteOrder);
    const scope = {
        version: 1,
        mode: parsed.mode,
        strategy: parsed.strategy,
        base_ref: resolved.baseRef,
        base_sha: resolved.baseSha,
        head_sha: headSha,
        allowed_paths: normalized,
        resolved_at: new Date().toISOString(),
        refresh_history: [],
    };
    writeScopeJson(path.join(sessionRoot, 'scope.json'), scope);
    return scope;
}
function resolveAllowedFromPaths(globSpec, target, repoRoot) {
    const globs = (globSpec ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    if (globs.length === 0) {
        throw new ScopeError('SCOPE_BAD_FLAG', `--scope paths: requires at least one non-empty glob`);
    }
    const tree = listTrackedAndUntracked(repoRoot);
    const matched = tree.filter((p) => globs.some((g) => globMatch(g, p)));
    const allowed = filterByTarget(matched, target, repoRoot);
    if (allowed.length === 0) {
        throw new ScopeError('SCOPE_EMPTY_PATHS', `--scope paths:${globSpec} matched zero files under ${repoRoot}`);
    }
    return allowed;
}
function resolveAllowedFromDiffMode(parsed, args, headSha, repoRoot) {
    const baseRef = parsed.mode === 'diff'
        ? parsed.base
        : (args.scopeBase ?? resolveDefaultBase(repoRoot));
    if (!baseRef) {
        throw new ScopeError('SCOPE_BAD_FLAG', `Malformed --scope diff form: expected diff:<ref>, got ${args.scopeFlag}`);
    }
    let baseSha;
    try {
        baseSha = getMergeBase(baseRef, 'HEAD', repoRoot);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ScopeError('SCOPE_BASE_MISSING', `Base ref "${baseRef}" not resolvable: ${msg}`);
    }
    // R-SSBR: `baseSha === headSha` is also true for a genuinely-unchanged branch (baseRef IS
    // HEAD), so disambiguate via baseRef's own resolved tip — only a tip that DIFFERS from headSha
    // means HEAD is a strict ancestor of baseRef (baseRef has moved past HEAD). Explicit
    // `diff:<ref>` scopes are never silently swapped.
    if (parsed.mode !== 'diff' && baseSha === headSha) {
        const baseRefTipSha = runGit(['rev-parse', baseRef], repoRoot, false)?.trim();
        if (baseRefTipSha && baseRefTipSha !== headSha) {
            const forkPointBase = resolveForkPointBase(repoRoot, baseRef, headSha);
            if (forkPointBase) {
                baseSha = forkPointBase;
            }
            else {
                throw new ScopeError('SCOPE_BASE_AHEAD_OF_HEAD', `Base ref "${baseRef}" is ahead of HEAD (merge-base ${baseSha} equals HEAD, but ` +
                    `${baseRef} resolves to ${baseRefTipSha}) and no divergent fork-point base was ` +
                    `found; the resulting empty diff would be untrustworthy`);
            }
        }
    }
    let paths;
    try {
        paths = computeAllowedFromDiff(baseSha, headSha, repoRoot);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ScopeError('SCOPE_BASE_MISSING', `Diff ${baseSha}...HEAD failed: ${msg}`);
    }
    const allowed = filterByTarget(paths, args.target, repoRoot);
    if (allowed.length === 0) {
        throw new ScopeError('SCOPE_EMPTY_DIFF', `No files changed between ${baseRef} and HEAD for mode=${parsed.mode}`);
    }
    return { allowed, baseRef, baseSha };
}
/**
 * Shared filter for the `base…head` diff: emit repo-relative POSIX paths for
 * A/M/R-new entries, with binary files removed. Used by both `resolveScope`
 * and `refreshScope` so future changes to the inclusion rules live in one
 * place. Throws the raw `getDiffFiles` error — callers add context.
 */
function computeAllowedFromDiff(baseSha, headSha, repoRoot) {
    const diff = getDiffFiles(baseSha, headSha, repoRoot);
    const binaries = getBinaryPathSet(baseSha, headSha, repoRoot);
    return diff
        .filter((d) => d.status === 'A' || d.status === 'M' || d.status === 'R')
        .map((d) => d.path)
        .filter((p) => !binaries.has(toPosix(p)));
}
/**
 * Per-phase scope refresh. Idempotent: if `phase` is already recorded in
 * `state.phases_entered`, returns the existing scope.json unchanged.
 *
 * Invariants:
 * - `base_sha` and `base_ref` are frozen from the setup-time scope.json.
 * - `head_sha` is recomputed via `getHeadSha(repoRoot)`.
 * - `allowed_paths` is recomputed against the new HEAD for diff modes; for
 *   `paths` mode the list is preserved (no HEAD dependency).
 * - A `RefreshEntry` is appended to `scope.json.refresh_history`.
 * - `archive/scope.<phase>.json` is written atomically; R-SRAA (Finding #53):
 *   if the archive already exists from a prior launch that crashed before
 *   updating `phases_entered`, it is rotated to `<file>.<epochMs>.bak` and
 *   the new archive is written (the prior FATAL `SCOPE_ARCHIVE_EXISTS` made
 *   every pipeline relaunch require manual `rm` cleanup).
 * - `state.phases_entered` is extended with `phase` under state-manager lock.
 *
 * Emits `scope-refresh: phase=<p> head=<sha> allowed=<N>` via `opts.log`
 * (default: stderr).
 *
 * Returns `null` if the session is not scope-configured (no scope.json) or if
 * the phase has already been entered.
 *
 * Throws `SCOPE_EMPTY_POST_BUILD` when the diff collapses to zero files and
 * `phase === 'anatomy-park'` — the build phase produced no review surface.
 */
export function refreshScope(sessionRoot, phase, opts = {}) {
    const statePath = path.join(sessionRoot, 'state.json');
    const sm = new StateManager();
    if (isPhaseAlreadyEntered(sm, statePath, phase))
        return null;
    const scopePath = path.join(sessionRoot, 'scope.json');
    const scope = readScopeJson(scopePath);
    if (!scope)
        return null;
    const repoRoot = opts.repoRoot ?? resolveRepoRootFromState(sm, statePath);
    const log = opts.log ?? ((msg) => { process.stderr.write(`${msg}\n`); });
    const newHead = getHeadSha(repoRoot);
    const newAllowed = computeRefreshedAllowed(scope, newHead, repoRoot, opts.target);
    if (newAllowed.length === 0 && phase === 'anatomy-park') {
        throw new ScopeError('SCOPE_EMPTY_POST_BUILD', `refreshScope: diff ${scope.base_sha}...${newHead} is empty at phase=${phase}; the build phase produced no review surface`);
    }
    const resolvedAt = new Date().toISOString();
    const refreshed = {
        ...scope,
        head_sha: newHead,
        allowed_paths: newAllowed,
        resolved_at: resolvedAt,
        refresh_history: [...scope.refresh_history, { phase, head_sha: newHead, resolved_at: resolvedAt }],
    };
    persistRefreshedScope(sessionRoot, scopePath, refreshed, sm, statePath, phase);
    log(`scope-refresh: phase=${phase} head=${newHead} allowed=${newAllowed.length}`);
    return refreshed;
}
function isPhaseAlreadyEntered(sm, statePath, phase) {
    if (!fs.existsSync(statePath))
        return false;
    try {
        const state = sm.read(statePath);
        return (state.phases_entered ?? []).includes(phase);
    }
    catch {
        return false;
    }
}
function resolveRepoRootFromState(sm, statePath) {
    if (!fs.existsSync(statePath)) {
        throw new ScopeError('SCOPE_NOT_A_REPO', `refreshScope: no repoRoot given and no state.json at ${statePath}`);
    }
    return sm.read(statePath).working_dir;
}
function readScopeJson(scopePath) {
    let base = null;
    let baseMtimeMs = 0;
    try {
        base = JSON.parse(fs.readFileSync(scopePath, 'utf-8'));
        baseMtimeMs = fs.statSync(scopePath).mtimeMs;
    }
    catch {
        // A killed initial writer may leave the only valid scope in a sibling tmp.
    }
    const dir = path.dirname(scopePath);
    const baseName = path.basename(scopePath);
    const tmpPattern = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.tmp\\.(\\d+)$`);
    let winner = null;
    let entries;
    try {
        entries = fs.readdirSync(dir);
    }
    catch {
        return base;
    }
    for (const entry of entries) {
        const match = entry.match(tmpPattern);
        if (!match)
            continue;
        const tmpPid = Number(match[1]);
        if (Number.isFinite(tmpPid) && isProcessAlive(tmpPid))
            continue;
        const tmpPath = path.join(dir, entry);
        try {
            const scope = JSON.parse(fs.readFileSync(tmpPath, 'utf-8'));
            const mtimeMs = fs.statSync(tmpPath).mtimeMs;
            if (mtimeMs <= baseMtimeMs) {
                fs.unlinkSync(tmpPath);
                continue;
            }
            if (!winner || mtimeMs > winner.mtimeMs) {
                winner = { path: tmpPath, scope, mtimeMs };
            }
        }
        catch {
            try {
                fs.unlinkSync(tmpPath);
            }
            catch { /* ignore invalid tmp cleanup failure */ }
        }
    }
    if (!winner)
        return base;
    try {
        fs.renameSync(winner.path, scopePath);
        return winner.scope;
    }
    catch {
        return base;
    }
}
function computeRefreshedAllowed(scope, newHead, repoRoot, target) {
    if (scope.mode === 'paths')
        return scope.allowed_paths.slice();
    if (!scope.base_sha) {
        throw new ScopeError('SCOPE_BASE_MISSING', `refreshScope: scope.json has no base_sha for mode=${scope.mode}`);
    }
    let base;
    try {
        base = computeAllowedFromDiff(scope.base_sha, newHead, repoRoot);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ScopeError('SCOPE_BASE_MISSING', `refreshScope: diff ${scope.base_sha}...${newHead} failed: ${msg}`);
    }
    const narrowed = filterByTarget(base, target, repoRoot);
    const expanded = scope.strategy === 'one-hop' ? computeOneHop(narrowed, repoRoot) : narrowed;
    return Array.from(new Set(expanded.map(toPosix))).sort(byteOrder);
}
function persistRefreshedScope(sessionRoot, scopePath, refreshed, sm, statePath, phase) {
    const archiveDir = path.join(sessionRoot, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    writeScopeArchive(path.join(archiveDir, `scope.${phase}.json`), refreshed);
    writeScopeJson(scopePath, refreshed);
    if (fs.existsSync(statePath)) {
        sm.update(statePath, (s) => {
            s.phases_entered = [...(s.phases_entered ?? []), phase];
        });
    }
}
/**
 * Narrow a subsystem-name list to those whose directory (resolved relative
 * to `target`) contains at least one `allowedPaths` entry.
 *
 * `subsystems` are names relative to `target`; `allowedPaths` are
 * repo-relative POSIX paths; `target` and `repoRoot` are absolute.
 * Returns sorted byte-order unique names.
 */
export function filterBySubsystem(subsystems, allowedPaths, target, repoRoot) {
    if (subsystems.length === 0 || allowedPaths.length === 0)
        return [];
    const kept = new Set();
    const allowedSet = new Set(allowedPaths.map(toPosix));
    for (const name of subsystems) {
        const absDir = path.resolve(target, name);
        const relDir = toPosix(path.relative(repoRoot, absDir));
        const prefix = relDir.length === 0 ? '' : relDir.endsWith('/') ? relDir : `${relDir}/`;
        for (const ap of allowedSet) {
            if (prefix === '' || ap === relDir || ap.startsWith(prefix)) {
                kept.add(name);
                break;
            }
        }
    }
    return Array.from(kept).sort(byteOrder);
}
/**
 * Filter `globbedFiles` (absolute) to those present in `allowedPaths`
 * (repo-relative POSIX). Preserves input order.
 */
export function filterByPaths(globbedFiles, allowedPaths, repoRoot) {
    const allowed = new Set(allowedPaths.map(toPosix));
    return globbedFiles.filter((abs) => allowed.has(toPosix(path.relative(repoRoot, abs))));
}
/**
 * Canonical JSON Schema (Draft 2020-12) for `ScopeJson`. Single source of
 * truth for the committed `extension/schemas/scope-v1.json`; the parity
 * script re-derives and diffs against the committed file.
 */
export function buildScopeV1Schema() {
    return {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $id: 'https://pickle-rick/schemas/scope-v1.json',
        title: 'ScopeJson',
        type: 'object',
        additionalProperties: false,
        required: [
            'version',
            'mode',
            'strategy',
            'base_ref',
            'base_sha',
            'head_sha',
            'allowed_paths',
            'resolved_at',
            'refresh_history',
        ],
        properties: {
            version: { const: 1 },
            mode: { type: 'string', enum: ['branch', 'diff', 'paths'] },
            strategy: { type: 'string', enum: ['strict', 'one-hop'] },
            base_ref: { type: ['string', 'null'] },
            base_sha: { type: ['string', 'null'] },
            head_sha: { type: ['string', 'null'] },
            allowed_paths: {
                type: 'array',
                items: { type: 'string' },
            },
            resolved_at: { type: 'string', format: 'date-time' },
            refresh_history: {
                type: 'array',
                maxItems: 16,
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['phase', 'head_sha', 'resolved_at'],
                    properties: {
                        phase: { type: 'string' },
                        head_sha: { type: ['string', 'null'] },
                        resolved_at: { type: 'string', format: 'date-time' },
                    },
                },
            },
        },
    };
}
/**
 * Expand `diffFiles` to include files that import any export from the diffed
 * set — a single-level blast-radius walk using rg/grep over raw import
 * strings (language-agnostic, no AST).
 *
 * Limitation (SCOPE_LIMITATION: aliased-imports-not-detected): the grep
 * pattern requires the export name to be followed by `,` or `}` within the
 * import brace list. aliased imports (`import { foo as bar }`) are therefore
 * not detected — `foo` is followed by ` as`, which fails the `\s*[,}]` check.
 * Operators relying on aliased re-exports must widen scope manually with
 * `--scope paths:<glob>`.
 *
 * Throws `SCOPE_ONE_HOP_TOO_LARGE` if `diffFiles.length > ONE_HOP_FILE_CAP`.
 *
 * `options.findImportersTimeoutMs` caps the rg/grep subprocess wall-time used
 * by the importer walk. Defaults to {@link FIND_IMPORTERS_TIMEOUT_MS} (5s).
 * `options.walkWallMs` caps the aggregate walk across all export names,
 * defaulting to {@link ONE_HOP_WALK_WALL_MS} (60s). Tests inject small values
 * to assert the hang-guard and the wall-clock cap fire.
 */
export function computeOneHop(diffFiles, repoRoot, options = {}) {
    // R-SRGT-1: an empty seed set has no exports to walk — short-circuit before
    // spawning any grep. `--scope branch` on an empty branch diff lands here.
    if (diffFiles.length === 0)
        return [];
    if (diffFiles.length > ONE_HOP_FILE_CAP) {
        throw new ScopeError('SCOPE_ONE_HOP_TOO_LARGE', `--scope branch:one-hop diff has ${diffFiles.length} files (max ${ONE_HOP_FILE_CAP}). ` +
            `Use --scope paths:<glob> to narrow scope or omit :one-hop for strict mode.`);
    }
    const timeoutMs = options.findImportersTimeoutMs ?? FIND_IMPORTERS_TIMEOUT_MS;
    const walkWallMs = options.walkWallMs ?? ONE_HOP_WALK_WALL_MS;
    const walkDeadline = Date.now() + walkWallMs;
    const exportNames = extractExportNames(diffFiles, repoRoot);
    const importerSet = new Set(diffFiles.map(toPosix));
    for (const name of exportNames) {
        // R-SRGT-2: aggregate wall-clock cap. Without it a many-export seed file
        // in a large repo runs one slow grep per name with no total bound.
        if (Date.now() > walkDeadline) {
            console.warn(`scope-resolver import walk: wall-clock cap ${walkWallMs}ms reached; ` +
                `returning partial one-hop set (${importerSet.size} files)`);
            break;
        }
        for (const f of findImporters(name, repoRoot, timeoutMs)) {
            importerSet.add(f);
        }
    }
    return Array.from(importerSet).sort(byteOrder);
}
// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------
function assertIsRepo(repoRoot) {
    const out = runGit(['rev-parse', '--git-dir'], repoRoot, false);
    if (!out || out.length === 0) {
        throw new ScopeError('SCOPE_NOT_A_REPO', `Not a git repository: ${repoRoot}`);
    }
}
function resolveDefaultBase(repoRoot) {
    const currentBranch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot, false)?.trim();
    const upstream = runGit(['rev-parse', '--abbrev-ref', '@{upstream}'], repoRoot, false)?.trim();
    if (upstream && upstream.length > 0) {
        if (!currentBranch || upstream !== `origin/${currentBranch}`)
            return upstream;
    }
    const remoteHead = runGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoRoot, false)?.trim();
    if (remoteHead && remoteHead.length > 0)
        return remoteHead;
    return 'origin/main';
}
/**
 * R-PSCG (B-1SEAM WS-2): best-effort baseline `start_commit` for sessions that
 * bootstrapped outside a git worktree and never captured one. Soft git form
 * throughout (`runGit(..., false)` — the R-SSBR precedent), so a missing ref
 * never throws. Resolution order:
 *  (a) HEAD unreadable (non-git dir / unborn HEAD) → `null`;
 *  (b) merge-base({@link resolveDefaultBase}, HEAD) — upstream → origin/HEAD →
 *      'origin/main';
 *  (c) fallback merge-base against local `refs/heads/main` then
 *      `refs/heads/master` (local-only repos where 'origin/main' doesn't resolve);
 *  (d) documented degenerate floor: HEAD itself, with a loud warn — an empty
 *      citadel diff beats killing the whole review tail.
 */
export function computeBaselineStartCommit(repoRoot) {
    const headSha = runGit(['rev-parse', 'HEAD'], repoRoot, false)?.trim();
    if (!headSha)
        return null;
    const bases = [resolveDefaultBase(repoRoot), 'refs/heads/main', 'refs/heads/master'];
    for (const base of bases) {
        const mergeBase = runGit(['merge-base', base, 'HEAD'], repoRoot, false)?.trim();
        if (mergeBase)
            return mergeBase;
    }
    console.warn(`computeBaselineStartCommit: no default base resolves in ${repoRoot} — ` +
        'falling back to HEAD (diff-based review phases will see an empty diff)');
    return headSha;
}
/**
 * R-SSBR: when the auto-default base has moved past HEAD (`baseSha === headSha` but `baseRef`'s
 * own tip differs from `headSha`), search for a genuinely divergent base to recompute the diff
 * against instead of failing closed. Soft git form throughout (`runGit(..., false)`) — mirrors
 * {@link resolveDefaultBase}; `getMergeBase`'s default `check=true` would throw and break the
 * fallback chain. Returns the first candidate whose `candidate...headSha` diff is non-empty, or
 * `null` if none recover a usable base.
 */
function resolveForkPointBase(repoRoot, baseRef, headSha) {
    const candidates = [];
    const forkPoint = runGit(['merge-base', '--fork-point', baseRef, 'HEAD'], repoRoot, false)?.trim();
    if (forkPoint)
        candidates.push(forkPoint);
    // Plain merge-base only helps if it differs from headSha — otherwise it reproduces the same
    // false-empty result the ancestry check above already detected.
    const plainMergeBase = runGit(['merge-base', baseRef, 'HEAD'], repoRoot, false)?.trim();
    if (plainMergeBase && plainMergeBase !== headSha)
        candidates.push(plainMergeBase);
    const localMain = runGit(['rev-parse', 'refs/heads/main'], repoRoot, false)?.trim();
    if (localMain)
        candidates.push(localMain);
    const localMaster = runGit(['rev-parse', 'refs/heads/master'], repoRoot, false)?.trim();
    if (localMaster)
        candidates.push(localMaster);
    for (const candidate of candidates) {
        if (!candidate || candidate === headSha)
            continue;
        const diff = runGit(['diff', `${candidate}...${headSha}`, '--name-only'], repoRoot, false);
        if (diff && diff.trim().length > 0)
            return candidate;
    }
    return null;
}
function listTrackedAndUntracked(repoRoot) {
    const out = runGit(['ls-files', '-co', '--exclude-standard', '-z'], repoRoot, false);
    if (!out)
        return [];
    return out.split('\0').filter((p) => p.length > 0);
}
function getBinaryPathSet(baseSha, headSha, repoRoot) {
    const out = runGit(['diff', '--numstat', `${baseSha}...${headSha}`], repoRoot, false);
    const binaries = new Set();
    if (!out)
        return binaries;
    for (const line of out.split('\n')) {
        const m = /^-\t-\t(.+)/.exec(line);
        if (m)
            binaries.add(toPosix(m[1]));
    }
    return binaries;
}
function filterByTarget(paths, target, repoRoot) {
    if (!target)
        return paths;
    const relTarget = toPosix(path.relative(repoRoot, path.resolve(target)));
    if (relTarget.length === 0)
        return paths;
    const prefix = relTarget.endsWith('/') ? relTarget : `${relTarget}/`;
    return paths.filter((p) => {
        const posix = toPosix(p);
        return posix === relTarget || posix.startsWith(prefix);
    });
}
function toPosix(p) {
    return p.split(path.sep).join('/');
}
function byteOrder(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
function globMatch(glob, candidate) {
    const pattern = globToRegex(glob);
    return pattern.test(candidate);
}
function globToRegex(glob) {
    let re = '';
    let i = 0;
    while (i < glob.length) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                re += '.*';
                i += 2;
                if (glob[i] === '/')
                    i += 1;
                continue;
            }
            re += '[^/]*';
        }
        else if (c === '?') {
            re += '[^/]';
        }
        else if (/[.+^${}()|[\]\\]/.test(c)) {
            re += `\\${c}`;
        }
        else {
            re += c;
        }
        i += 1;
    }
    return new RegExp(`^${re}$`);
}
function writeScopeJson(filePath, scope) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.tmp.${process.pid}`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(scope, null, 2));
        fs.renameSync(tmp, filePath);
    }
    catch (err) {
        try {
            fs.unlinkSync(tmp);
        }
        catch { /* ignore cleanup failure */ }
        throw err;
    }
}
/**
 * R-SRAA (Finding #53): atomic archive writer with relaunch-safe rotation.
 *
 * Earlier this refused to overwrite and threw `SCOPE_ARCHIVE_EXISTS` on the
 * assumption that the `phases_entered` idempotency gate would prevent a
 * collision. In practice that gate misses on a crash window: launch #1 wrote
 * `scope.<phase>.json` (line 432) and then crashed BEFORE the
 * `phases_entered` update (line 434-436), so launch #2 saw an empty
 * `phases_entered`, called `refreshScope`, and FATALed every time on the
 * leftover archive (BUG-REPORT-2026-05-18 Bug 6).
 *
 * Now: if the archive already exists, rotate it to a timestamped sibling
 * (`scope.<phase>.json.<epochMs>.bak`) so the relaunch proceeds without
 * FATAL or operator-side `rm` cleanup, and the prior archive is preserved
 * for forensics.
 */
function writeScopeArchive(filePath, scope) {
    if (fs.existsSync(filePath)) {
        const rotatedPath = `${filePath}.${Date.now()}.bak`;
        fs.renameSync(filePath, rotatedPath);
    }
    writeScopeJson(filePath, scope);
}
function extractExportNames(diffFiles, repoRoot) {
    const names = new Set();
    for (const relPath of diffFiles) {
        let content;
        try {
            content = fs.readFileSync(path.resolve(repoRoot, relPath), 'utf-8');
        }
        catch {
            continue;
        }
        for (const m of content.matchAll(/^export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|type|interface|enum)\s+(\w+)/gm)) {
            names.add(m[1]);
        }
        for (const m of content.matchAll(/^export\s+(?:type\s+)?\{([^}]+)\}/gm)) {
            for (const part of m[1].split(',')) {
                const name = part.trim().split(/\s+as\s+/)[0].trim();
                if (/^\w+$/.test(name))
                    names.add(name);
            }
        }
        for (const m of content.matchAll(/^export\s+default\s+(\w+)/gm)) {
            names.add(m[1]);
        }
    }
    return names;
}
function findImporters(name, repoRoot, timeoutMs) {
    // Matches default imports and named imports.
    // aliased imports (`{ foo as bar }`) are NOT matched: `\bfoo\b\s*[,}]`
    // requires , or } after foo — ` as` does not satisfy this (documented miss).
    const pattern = `import\\s+${name}\\b|import[^{;]*\\{[^}]*\\b${name}\\b\\s*[,}]`;
    // `null` from _runRgImportWalk means rg failed/missing — the ONLY case the
    // grep fallback exists for. A successful rg that found zero importers returns
    // `[]`, which is the authoritative answer: rg honors .gitignore + the
    // `*.{ts,…}` glob, so falling through to `grep -rl … .` (which does NOT honor
    // .gitignore) would both double the subprocess count and pull ignored
    // importers (node_modules/, dist/) into the one-hop set.
    const rgMatches = _runRgImportWalk(pattern, repoRoot, timeoutMs);
    if (rgMatches !== null)
        return rgMatches;
    return _runGrepImportWalk(pattern, repoRoot, timeoutMs);
}
function _runRgImportWalk(pattern, root, timeoutMs) {
    // `timeout` guards against a wedged rg/grep (FIFO under repoRoot, stuck
    // FUSE mount, catastrophic backtracking) that would otherwise block the
    // entire scope-resolution phase indefinitely with no log output.
    const rg = spawnSync('rg', ['-l', '--glob', '*.{ts,tsx,js,jsx,mjs,cjs}', '-e', pattern, '.'], {
        cwd: root,
        encoding: 'utf-8',
        timeout: timeoutMs,
    });
    if (!rg.error && (rg.status === 0 || rg.status === 1)) {
        return (rg.stdout || '')
            .split('\n')
            .filter((f) => f.length > 0)
            .map((f) => toPosix(f.replace(/^\.\//, '')));
    }
    const errorCode = rg.error?.code;
    console.warn(`scope-resolver import walk: rg ${errorCode === 'ETIMEDOUT' ? 'timeout' : 'fail'} status=${rg.status ?? 'null'} signal=${rg.signal ?? 'null'} error=${errorCode ?? 'none'}`);
    return null;
}
function _runGrepImportWalk(pattern, root, timeoutMs) {
    // Extension set MUST match the rg `--glob` in _runRgImportWalk
    // (ts,tsx,js,jsx,mjs,cjs). The grep fallback exists only for rg-absent hosts;
    // a narrower include set silently drops .mjs/.cjs importers from the one-hop
    // set, under-including scope on exactly the hosts the fallback serves.
    const grep = spawnSync('grep', ['-rl', '-E', '--include=*.ts', '--include=*.tsx', '--include=*.js', '--include=*.jsx',
        '--include=*.mjs', '--include=*.cjs',
        pattern, '.'], { cwd: root, encoding: 'utf-8', timeout: timeoutMs });
    if (grep.status === 0 || grep.status === 1) {
        return (grep.stdout || '')
            .split('\n')
            .filter((f) => f.length > 0)
            .map((f) => toPosix(f.replace(/^\.\//, '')));
    }
    const errorCode = grep.error?.code;
    console.warn(`scope-resolver import walk: grep ${errorCode === 'ETIMEDOUT' ? 'timeout' : 'fail'} status=${grep.status ?? 'null'} signal=${grep.signal ?? 'null'} error=${errorCode ?? 'none'}`);
    return [];
}

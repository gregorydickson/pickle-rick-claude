import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { LockError, UNBOUNDED_READ_MAX_BUFFER } from '../types/index.js';
import { withLock } from './state-manager.js';
import { killProcessGroup } from './orphan-reaper.js';
import { readRecoverableJsonObject } from './microverse-state.js';
import { writeStateFile } from './pickle-utils.js';
import { detectMissingTools } from './verify-command-safety.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export class GateError extends Error {
    kind;
    constructor(kind, message) {
        super(message);
        this.name = 'GateError';
        this.kind = kind;
    }
}
export class GateTimeoutError extends GateError {
    check;
    timeout_ms;
    constructor(check, timeout_ms) {
        super('GATE_CHECK_TIMEOUT', `${check} timed out after ${timeout_ms}ms`);
        this.name = 'GateTimeoutError';
        this.check = check;
        this.timeout_ms = timeout_ms;
    }
}
export class BaselineMissingError extends GateError {
    constructor(baselinePath) {
        super('BASELINE_MISSING', `No baseline at ${baselinePath}`);
        this.name = 'BaselineMissingError';
    }
}
export class BaselineStaleError extends GateError {
    constructor(message) {
        super('BASELINE_STALE', message);
        this.name = 'BaselineStaleError';
    }
}
export class BaselineWriteFailedError extends GateError {
    baselinePath;
    cause;
    constructor(baselinePath, message, cause) {
        super('BASELINE_WRITE_FAILED', message ?? `Failed to persist baseline at ${baselinePath}`);
        this.name = 'BaselineWriteFailedError';
        this.baselinePath = baselinePath;
        if (cause !== undefined)
            this.cause = cause;
    }
}
function baselineWriteFailed(baselinePath, err) {
    if (err instanceof BaselineWriteFailedError)
        return err;
    const message = err instanceof Error ? err.message : String(err);
    return new BaselineWriteFailedError(baselinePath, `Failed to persist baseline at ${baselinePath}: ${message}`, err);
}
/**
 * The ONE reader of `data/gate-commands.json` — the per-project-type toolchain table.
 *
 * Exported because the off-repo worker gate (`bin/spawn-morty.ts`) needs the same map.
 * A second table there would be the per-stack adapter matrix the repo-agnostic
 * invariant forbids; a second *loader* is subtler and just as wrong — it hand-copies
 * this module-relative path resolution, so the two silently disagree the moment either
 * file changes depth. Only the read is shared: each consumer keeps its own failure
 * POLICY (this gate fails fast; the off-repo gate degrades to `not_run`).
 */
export function loadGateCommands() {
    const dataPath = path.resolve(__dirname, '../data/gate-commands.json');
    try {
        return JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new GateError('GATE_COMMANDS_UNREADABLE', `Cannot load gate commands from ${dataPath}: ${msg}`);
    }
}
/** Event names emitted by the remediator layer after runGate. Exported for remediator callers. */
export const GATE_REMEDIATION_EVENT_NAMES = [
    'gate_remediation_complete',
    'gate_remediation_aborted_unverified_production_change',
    'gate_autofix_reverted',
];
const PER_CHECK_TIMEOUT_MS = {
    typecheck: 120_000,
    lint: 60_000,
    tests: 300_000,
};
const GATE_TOTAL_TIMEOUT_MS = 600_000;
const GATE_LOCK_TIMEOUT_MS = 30_000;
const WORKSPACE_ROOT_CONTROL_FILES = new Set([
    'package.json',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
    'yarn.lock',
    'package-lock.json',
    'bun.lock',
    'bun.lockb',
]);
const UNSAFE_TEST_SCRIPT_REGEX = /integration|e2e|golden|smoke|baseline|playwright|cypress|hardhat/i;
const SAFE_TEST_RUNNER_REGEX = /(vitest|jest|node|mocha)/;
const PACKAGE_MANAGER_RUN_RE = /^(npm|pnpm|yarn)(?:\s+run)?\s+([A-Za-z0-9:_-]+)\b/;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
const ENV_WRAPPER_PREFIXES = ['cross-env-shell', 'cross-env', 'env'];
/**
 * The identity a failure is matched by across runs. `check` is part of it because the
 * unparsed fallback in `buildFailures` keys every check the same way — `file: pkgDir`,
 * `ruleOrCode: String(exitCode)`, `line: 0` — so a coarse `tests` failure and a coarse
 * `typecheck` failure in the same package are otherwise the SAME failure to both the
 * ordinal grouping and the baseline fingerprint. `tests` has no granular parser, so it
 * ALWAYS produces that coarse shape when red: a repo whose suite is red at baseline
 * would subtract a brand-new coarse typecheck/lint failure as if it were the baselined
 * test failure, and the gate would report green over it.
 *
 * The ordinal grouping and the fingerprint MUST derive from this one key: an occurrence
 * index is only meaningful within the identity space it is counted in, so a key here
 * that the grouping does not share re-couples unrelated checks' ordinals.
 */
function failureIdentityKey(f) {
    return `${f.check}::${f.file}::${f.ruleOrCode}`;
}
function buildFingerprint(f) {
    return `${failureIdentityKey(f)}::${f.occurrence_index}`;
}
export function assignOccurrenceIndices(failures) {
    const groups = new Map();
    for (const f of failures) {
        const key = failureIdentityKey(f);
        const group = groups.get(key) ?? [];
        group.push(f);
        groups.set(key, group);
    }
    const result = [];
    for (const group of groups.values()) {
        group.sort((a, b) => a.line - b.line);
        for (let i = 0; i < group.length; i++) {
            result.push({ ...group[i], occurrence_index: i });
        }
    }
    return result;
}
function validateBaselineStructure(data) {
    if (!data || typeof data !== 'object')
        return false;
    const d = data;
    const projectType = d['project_type'];
    const capturedIteration = d['captured_iteration'];
    const projectTypeValid = projectType === null ||
        (typeof projectType === 'string' &&
            ['pnpm', 'npm', 'yarn', 'cargo', 'go', 'bun'].includes(projectType));
    const capturedIterationValid = capturedIteration === undefined ||
        (typeof capturedIteration === 'number' &&
            Number.isInteger(capturedIteration) &&
            capturedIteration >= 0);
    return (d['schema_version'] === 1 &&
        typeof d['captured_at'] === 'string' &&
        capturedIterationValid &&
        typeof d['working_dir'] === 'string' &&
        projectTypeValid &&
        Array.isArray(d['checks']) &&
        Array.isArray(d['failures']));
}
function loadBaselineFile(baselinePath) {
    const raw = readRecoverableJsonObject(baselinePath);
    if (!validateBaselineStructure(raw)) {
        throw new GateError('BASELINE_CORRUPT', `Invalid baseline file at ${baselinePath}`);
    }
    return raw;
}
async function inspectBaselinePath(baselinePath) {
    try {
        const stat = await fs.promises.stat(baselinePath);
        return {
            path: baselinePath,
            exists: true,
            size_bytes: stat.size,
            mtime_ms: stat.mtimeMs,
        };
    }
    catch (err) {
        const code = typeof err === 'object' && err !== null && 'code' in err
            ? String(err.code)
            : undefined;
        return {
            path: baselinePath,
            exists: false,
            ...(code ? { error_code: code } : {}),
        };
    }
}
/** Extract identifier-shaped tokens a `tsc` failure references: every quoted token in the
 * message (tsc quotes symbol/type names) plus the basename stem of the failing file. */
export function extractTscFailureIdentifiers(failure) {
    const ids = new Set();
    const idShape = /^[A-Za-z_$][\w$]*$/;
    const quoted = failure.message.match(/['"]([^'"]+)['"]/g) ?? [];
    for (const q of quoted) {
        const inner = q.slice(1, -1).trim();
        if (idShape.test(inner))
            ids.add(inner);
    }
    const stem = path.basename(failure.file).replace(/\.[^.]+$/, '');
    if (idShape.test(stem))
        ids.add(stem);
    return Array.from(ids);
}
/** The ONE key a failure is looked up by in `changedFiles`. `changedFiles` always holds
 * git's own repo-relative spelling, so an ABSOLUTE `failure.file` is relativized against
 * `ctx.workingDir` (which must therefore be the REPO ROOT, not a resolved package dir) and
 * an already-relative one is taken as-is. Two membership tests over two path spaces is the
 * bug, not the defence: one of them silently never matches. */
function changedFileKey(failure, ctx) {
    return ctx.workingDir && path.isAbsolute(failure.file)
        ? normalizeScopePath(path.relative(ctx.workingDir, failure.file))
        : normalizeScopePath(failure.file);
}
/** True when a failure intersects the phase's own diff (by changed file OR changed exported
 * symbol). Returns false when no context is supplied (the no-guard default). */
export function isSelfIntroducedFailure(failure, ctx) {
    if (!ctx)
        return false;
    if (ctx.changedFiles.size > 0 && ctx.changedFiles.has(changedFileKey(failure, ctx))) {
        return true;
    }
    if (ctx.changedExportedSymbols.size > 0) {
        for (const id of extractTscFailureIdentifiers(failure)) {
            if (ctx.changedExportedSymbols.has(id))
                return true;
        }
    }
    return false;
}
/** Partition failures into self-introduced (intersect the phase's own diff) and other. */
export function classifyNoDisown(failures, ctx) {
    const selfIntroduced = [];
    const other = [];
    for (const f of failures) {
        (isSelfIntroducedFailure(f, ctx) ? selfIntroduced : other).push(f);
    }
    return { selfIntroduced, other };
}
// `selfGuard` (R-ORSR-6): a baseline-matching failure is dropped as pre-existing ONLY when it is
// NOT self-introduced. A failure intersecting the phase's own diff is never subtracted, so a
// self-introduced break can never be disowned as a coincidental baseline match.
export function subtractBaseline(current, baseline, selfGuard) {
    const baselineSet = new Set(baseline.failures.map(buildFingerprint));
    return current.filter(f => {
        if (!baselineSet.has(buildFingerprint(f)))
            return true;
        return isSelfIntroducedFailure(f, selfGuard);
    });
}
/** Repo-relative changed files in `sinceCommit..HEAD`, or `null` when the enumeration did not
 * complete (R-ORSR-6 exported wrapper — it PROPAGATES the failure; see `getChangedSince`). */
export function getChangedFilesSince(workingDir, sinceCommit) {
    return getChangedSince(workingDir, sinceCommit);
}
/** Parse a unified `git diff` for exported declarations added or removed on changed lines.
 * Pure — operates on diff text so it is unit-testable without a git repo. */
export function parseChangedExportedSymbolsFromDiff(diffText) {
    const symbols = new Set();
    const declRe = /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:interface|type|class|enum|function|const|let|var)\s+([A-Za-z_$][\w$]*)/;
    const namedReExportRe = /^\s*export\s+(?:type\s+)?\{([^}]*)\}/;
    for (const raw of diffText.split('\n')) {
        // Only changed lines; skip the +++/--- file headers.
        if (!/^[+-]/.test(raw) || /^[+-]{3}\s/.test(raw))
            continue;
        const line = raw.slice(1);
        const decl = line.match(declRe);
        if (decl?.[1])
            symbols.add(decl[1]);
        const named = line.match(namedReExportRe);
        if (named?.[1]) {
            for (const part of named[1].split(',')) {
                const token = part.trim();
                if (!token)
                    continue;
                // `A` or `A as C` → bind the externally-visible name (C if aliased, else A).
                const asMatch = token.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
                if (asMatch?.[2])
                    symbols.add(asMatch[2]);
                else if (/^[A-Za-z_$][\w$]*$/.test(token))
                    symbols.add(token);
            }
        }
    }
    return symbols;
}
/**
 * Exported identifiers whose declaration changed in `sinceCommit..HEAD` (TS/TSX only), or
 * `null` when the enumeration did NOT COMPLETE.
 *
 * The `null` is the AP-EXT-ITER38-01 shape, and it is the whole point: an empty `Set` is a
 * POSITIVE finding ("this phase changed no exported symbol") that `runInterfaceChangeSweep`
 * reads as "nothing to sweep" and returns `ran: false` on, so a git failure that fabricates
 * one silently disarms the R-ORSR-6 INV-NO-SELF-DISOWN sweep — the guard whose entire job is
 * that a phase cannot disown its own whole-repo interface break — and converges reporting
 * success. A measurement that did not run is not a measurement of zero.
 *
 * ONE completion predicate, never a stack: a whole-branch `git diff` fails in two shapes that
 * must share a verdict. A non-zero `status` covers an unreachable `sinceCommit` (128, measured),
 * ENOENT, and the 30s timeout. `result.error` covers `maxBuffer` overflow, which Node reports as
 * `status: 0` with `error.code === 'ENOBUFS'` and TRUNCATED stdout (measured) — the status-only
 * guard passed it straight through, so a diff cut mid-stream parsed as a COMPLETE symbol set and
 * every declaration past the cut was invisible to the sweep.
 *
 * `UNBOUNDED_READ_MAX_BUFFER` is the ONE 64 MB ceiling (AP-EXT-ITER8-01) every unbounded reader
 * shares; the former local `32 * 1024 * 1024` was half of it and exactly the per-file fork that
 * trap door forbids. This spawn is a whole-branch PATCH — strictly larger than the `--name-only`
 * list its `getChangedSince` sibling already declares the ceiling on.
 */
export function getChangedExportedSymbols(workingDir, sinceCommit) {
    const result = spawnSync('git', ['diff', `${sinceCommit}..HEAD`, '--', '*.ts', '*.tsx'], { cwd: workingDir, encoding: 'utf-8', timeout: 30_000, maxBuffer: UNBOUNDED_READ_MAX_BUFFER });
    if ((result.status ?? 1) !== 0 || result.error)
        return null;
    return parseChangedExportedSymbolsFromDiff(result.stdout || '');
}
export function assertBaselineFresh(baselinePath, opts) {
    if (!fs.existsSync(baselinePath)) {
        const dir = path.dirname(baselinePath);
        fs.mkdirSync(dir, { recursive: true });
        const now = new Date().toISOString();
        const iso = now.replace(/[:.]/g, '-');
        fs.writeFileSync(path.join(dir, `baseline_missing_${iso}.md`), `# Baseline Missing\n\nPath: \`${baselinePath}\`\nCaptured: ${now}\n`);
        throw new BaselineMissingError(baselinePath);
    }
    const stat = fs.statSync(baselinePath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > opts.max_age_seconds * 1000) {
        throw new BaselineStaleError(`Baseline at ${baselinePath} is ${Math.round(ageMs / 1000)}s old (max ${opts.max_age_seconds}s)`);
    }
    const baseline = loadBaselineFile(baselinePath);
    const capturedIteration = baseline.captured_iteration;
    const iterationAge = typeof capturedIteration === 'number'
        ? opts.current_iteration - capturedIteration
        : opts.current_iteration;
    if (iterationAge >= opts.max_age_iterations) {
        throw new BaselineStaleError(`baseline iteration age (${iterationAge}) >= max_age_iterations (${opts.max_age_iterations})`);
    }
}
export function detectProjectType(workingDir) {
    const has = (f) => fs.existsSync(path.join(workingDir, f));
    if (has('pnpm-lock.yaml') || has('pnpm-workspace.yaml'))
        return 'pnpm';
    if (has('yarn.lock'))
        return 'yarn';
    if (has('package-lock.json'))
        return 'npm';
    if (has('bun.lock') || has('bun.lockb'))
        return 'bun';
    if (has('package.json'))
        return 'npm';
    if (has('Cargo.toml'))
        return 'cargo';
    if (has('go.mod'))
        return 'go';
    return null;
}
function parsePnpmWorkspaceYaml(content) {
    const patterns = [];
    let inPackages = false;
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === 'packages:') {
            inPackages = true;
            continue;
        }
        if (!inPackages)
            continue;
        if (trimmed.startsWith('- ')) {
            patterns.push(trimmed.slice(2).replace(/^['"]|['"]$/g, ''));
        }
        else if (trimmed && !trimmed.startsWith('#')) {
            inPackages = false;
        }
    }
    return patterns;
}
function resolveWorkspaceGlobs(workingDir, patterns) {
    const results = new Set();
    const packageDirs = listWorkspacePackageDirs(workingDir).map(abs => ({
        abs,
        rel: normalizeScopePath(path.relative(workingDir, abs)),
    }));
    for (const pattern of patterns) {
        const normalizedPattern = normalizeScopePath(pattern);
        if (!/[*?]/.test(normalizedPattern)) {
            const resolved = path.resolve(workingDir, normalizedPattern);
            if (fs.existsSync(path.join(resolved, 'package.json')))
                results.add(resolved);
            continue;
        }
        const regex = workspaceGlobToRegex(normalizedPattern);
        for (const candidate of packageDirs) {
            if (regex.test(candidate.rel)) {
                results.add(candidate.abs);
            }
        }
    }
    return Array.from(results).sort();
}
export function getWorkspacePackages(workingDir) {
    const pnpmYaml = path.join(workingDir, 'pnpm-workspace.yaml');
    if (fs.existsSync(pnpmYaml)) {
        const patterns = parsePnpmWorkspaceYaml(fs.readFileSync(pnpmYaml, 'utf-8'));
        return resolveWorkspaceGlobs(workingDir, patterns);
    }
    const pkgJsonPath = path.join(workingDir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
            const ws = pkg.workspaces;
            if (ws) {
                const patterns = Array.isArray(ws) ? ws : (ws.packages ?? []);
                return resolveWorkspaceGlobs(workingDir, patterns);
            }
        }
        catch {
            /* not a valid package.json with workspaces */
        }
    }
    return [];
}
function globToRegex(pattern) {
    // Strip trailing /** so the base dir itself matches: packages/b/** → ^packages/b(/.*)?$
    const pat = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
    const re = pat
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\x00')
        .replace(/\*/g, '[^/]*')
        .replace(/\x00/g, '.*')
        .replace(/\?/g, '[^/]');
    return new RegExp(`^${re}(/.*)?$`);
}
function workspaceGlobToRegex(pattern) {
    let re = '';
    let i = 0;
    while (i < pattern.length) {
        const c = pattern[i];
        if (c === '*') {
            if (pattern[i + 1] === '*') {
                re += '.*';
                i += 2;
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
function listWorkspacePackageDirs(rootDir) {
    const found = new Set();
    const pending = [rootDir];
    while (pending.length > 0) {
        const current = pending.pop();
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        }
        catch {
            continue;
        }
        if (current !== rootDir &&
            entries.some(entry => entry.isFile() && entry.name === 'package.json')) {
            found.add(current);
        }
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            if (entry.name === '.git' || entry.name === 'node_modules')
                continue;
            pending.push(path.join(current, entry.name));
        }
    }
    return Array.from(found);
}
function normalizeScopePath(value) {
    return value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}
function staticScopePrefix(pattern) {
    const normalized = normalizeScopePath(pattern);
    const wildcardIdx = normalized.search(/[*?]/);
    const prefix = wildcardIdx === -1 ? normalized : normalized.slice(0, wildcardIdx);
    return prefix.replace(/\/+$/, '');
}
function matchesAllowedPath(candidate, allowedPaths) {
    const normalizedCandidate = normalizeScopePath(candidate);
    return allowedPaths.some((allowedPath) => {
        const normalizedAllowed = normalizeScopePath(allowedPath);
        if (globToRegex(normalizedAllowed).test(normalizedCandidate))
            return true;
        const prefix = staticScopePrefix(normalizedAllowed);
        if (!prefix)
            return true;
        return (prefix === normalizedCandidate ||
            prefix.startsWith(`${normalizedCandidate}/`) ||
            normalizedCandidate.startsWith(`${prefix}/`));
    });
}
function affectsAllWorkspacePackages(repoRelativePaths) {
    return repoRelativePaths.some((filePath) => WORKSPACE_ROOT_CONTROL_FILES.has(normalizeScopePath(filePath)));
}
function applyFlakeFilter(failures, workingDir, flakeGlobs) {
    if (flakeGlobs.length === 0)
        return { real: failures, flake: [] };
    const regexes = flakeGlobs.map(globToRegex);
    const isFlake = (f) => {
        const rel = path.relative(workingDir, f.file);
        return regexes.some(re => re.test(rel));
    };
    return { real: failures.filter(f => !isFlake(f)), flake: failures.filter(isFlake) };
}
export function filterByScope(files, opts) {
    if (!opts.allowedPaths || opts.allowedPaths.length === 0)
        return files;
    return files.filter((file) => matchesAllowedPath(file, opts.allowedPaths ?? []));
}
/**
 * The root `getChangedSince`'s paths are spelled relative to. `git diff --name-only` emits
 * REPO-ROOT-relative paths whatever the cwd, but the gate's own `workingDir` may be a package
 * dir one level down (R-SZGB-A `detectProjectTypeWithRootResolution`) — so the two only share a
 * path space through this call. Derived by walking `workingDir` up by `--show-prefix`'s depth,
 * NOT by reading `--show-toplevel`: toplevel is realpath-resolved, so under a symlinked root
 * (macOS `/var` → `/private/var`) it names the same directory in a different spelling and
 * `path.relative` against a lexical `failure.file` escapes into `../../..`. Falls back to
 * `workingDir` when git cannot answer — the pre-existing behaviour, and exact for a flat repo.
 *
 * `Lexical` is in the name on purpose: the two other private `resolveRepoRoot` helpers in this
 * subsystem (`bin/resolve-scope.ts`, `bin/mux-runner.ts`) hand back a REALPATH, which is the one
 * thing this caller cannot use. Do not "unify" the three — that reintroduces AP-EXT-ITER8-02.
 */
function resolveLexicalRepoRoot(workingDir) {
    const result = spawnSync('git', ['rev-parse', '--show-prefix'], {
        cwd: workingDir, encoding: 'utf-8', timeout: 10_000,
    });
    if ((result.status ?? 1) !== 0)
        return workingDir;
    const depth = (result.stdout ?? '').trim().split('/').filter(Boolean).length;
    return depth === 0 ? workingDir : path.resolve(workingDir, ...Array(depth).fill('..'));
}
/**
 * Repo-relative changed files in `since..HEAD`, or `null` when the enumeration did NOT COMPLETE.
 *
 * `null` is the AP-EXT-ITER38-01 shape and it exists for the SAME reason its
 * `getChangedExportedSymbols` sibling carries it: an empty array is a POSITIVE finding ("this
 * phase changed no file"), and the R-ORSR-6 no-disown classifier reads that finding as data.
 * `isSelfIntroducedFailure` short-circuits on `changedFiles.size > 0`, so a fabricated empty set
 * disarms the file axis of INV-NO-SELF-DISOWN and every whole-repo break the phase caused is
 * disowned as pre-existing. A measurement that did not run is not a measurement of zero.
 *
 * ONE completion predicate, shared with `getChangedExportedSymbols` — the two enumerate the same
 * commit range and must not disagree about what "failed" means. A non-zero/`null` `status` covers
 * an unreachable `since` SHA (128, measured), ENOENT and the 30s timeout; `result.error` covers
 * `maxBuffer` overflow, which Node reports as `status: 0` with `error.code === 'ENOBUFS'` when the
 * child exits before the kill lands (measured on node v24) — the status-only guard passed that
 * straight through, so an unverifiable read parsed as a COMPLETE path list.
 */
function getChangedSince(workingDir, since) {
    // AP-EXT-ITER31-01: `-z` matches the contract `allowed_paths` is built from
    // (`--name-status -M100 -z`). Without it `core.quotePath` C-quotes non-ASCII
    // paths, `filterByScope` matches none of them, and the gate silently narrows
    // its own failure set — fail-OPEN over a real regression.
    const result = spawnSync('git', ['diff', '--name-only', '-z', `${since}..HEAD`], {
        cwd: workingDir,
        encoding: 'utf-8',
        timeout: 30_000,
        // AP-EXT-ITER8-01: whole-tree status / branch-wide name-only are unbounded; a
        // truncated read silently narrows the changed set the gate scopes itself to.
        maxBuffer: UNBOUNDED_READ_MAX_BUFFER,
    });
    if ((result.status ?? 1) !== 0 || result.error)
        return null;
    return (result.stdout || '').split('\0').filter(Boolean);
}
/** The ceiling `execFile`'s `maxBuffer` used to enforce on a check's captured output. */
const CHECK_OUTPUT_MAX_BYTES = 10 * 1024 * 1024;
/**
 * THE terminator for a gate check: the subtree's process GROUP first, the bare child
 * as the fallback — the shape `bin/spawn-morty.ts:killProcessTree` already uses for the
 * SAME commands, delegating to the one shared negative-PID primitive.
 *
 * The parent-side pipes are destroyed first, mirroring what `execFile`'s internal
 * `kill()` did: a survivor holding the write end must not strand this event loop when
 * the group signal cannot land (win32, or a group already gone).
 */
function killCheckSubtree(child, signal) {
    child.stdout?.destroy();
    child.stderr?.destroy();
    const pid = child.pid;
    if (typeof pid === 'number' && killProcessGroup(pid, signal))
        return;
    try {
        child.kill(signal);
    }
    catch {
        // Best-effort cleanup.
    }
}
/**
 * AP-EXT-ITER54-01: every command in `data/gate-commands.json` is a package-manager or
 * toolchain ROOT (`pnpm test`, `npm run typecheck`, `cargo test`) whose real work runs in
 * GRANDchildren, so the timeout teardown must reap the process GROUP, not the child pid.
 *
 * `execFile` cannot do that, and the reason is not a missing option — it hand-picks which
 * spawn options it forwards and SILENTLY DROPS `detached`, so its child shares THIS
 * process's group and a negative-PID kill on the child pid would name a group that does
 * not exist (or, worse, invite the AP-EXT-ITER47-01 self-group hazard). `spawn` with
 * `detached` is the only shape in which the child LEADS a group there is something to
 * reap; the two are driven off one platform predicate so they cannot drift.
 *
 * `error` RESOLVES rather than rejects, byte-for-byte the pre-fix disposition: only a
 * `GateTimeoutError` is caught by `runGateCheck`, so rejecting here would throw out of
 * `runGate` instead of producing a red result.
 */
async function runCheckCommand(check, cmd, cwd, timeout_ms) {
    const parts = cmd.split(' ').filter((p) => p.length > 0);
    if (parts.length === 0) {
        throw new Error(`runCheckCommand: empty command — refusing to spawn`);
    }
    const bin = parts[0];
    const args = parts.slice(1);
    const missingBin = detectMissingTools([bin]);
    if (missingBin.length > 0) {
        return { stdout: '', stderr: `tool not installed: ${bin}`, exitCode: 1 };
    }
    return await new Promise((resolve, reject) => {
        const child = spawn(bin, args, {
            cwd,
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const settle = (fn) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            fn();
        };
        const capture = (append) => (chunk) => {
            append(chunk);
            if (stdout.length + stderr.length <= CHECK_OUTPUT_MAX_BYTES)
                return;
            // Same disposition `execFile`'s maxBuffer overflow produced — exit 1 over the
            // truncated output — except the whole subtree is reaped with it.
            settle(() => {
                killCheckSubtree(child, 'SIGKILL');
                resolve({ stdout, stderr, exitCode: 1 });
            });
        };
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', capture((c) => { stdout += c; }));
        child.stderr?.on('data', capture((c) => { stderr += c; }));
        child.on('error', () => {
            settle(() => { resolve({ stdout, stderr, exitCode: 1 }); });
        });
        child.on('close', (code) => {
            settle(() => {
                resolve({ stdout, stderr, exitCode: typeof code === 'number' ? code : 1 });
            });
        });
        const timer = setTimeout(() => {
            settle(() => {
                killCheckSubtree(child, 'SIGKILL');
                reject(new GateTimeoutError(check, timeout_ms));
            });
        }, timeout_ms);
        timer.unref();
    });
}
function parseTscOutput(output, pkgDir) {
    const failures = [];
    const re = /^(.+?)\((\d+),\d+\):\s+error\s+(TS\d+):\s+(.*)$/;
    for (const line of output.split('\n')) {
        const m = line.match(re);
        if (!m)
            continue;
        failures.push({
            check: 'typecheck',
            file: path.isAbsolute(m[1]) ? m[1] : path.resolve(pkgDir, m[1]),
            line: parseInt(m[2], 10),
            ruleOrCode: m[3],
            message: (m[4] ?? '').slice(0, 500),
            severity: 'error',
            occurrence_index: 0,
        });
    }
    return failures;
}
function parseEslintOutput(output, pkgDir) {
    const failures = [];
    let currentFile = '';
    const violationRe = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.*\S)\s{2,}(\S+)\s*$/;
    for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        if (/^[✖×√]/.test(trimmed) || /^\d+ problem/.test(trimmed))
            continue;
        if (line.charAt(0) !== ' ' && line.charAt(0) !== '\t') {
            currentFile = path.isAbsolute(trimmed) ? trimmed : path.resolve(pkgDir, trimmed);
        }
        else {
            const m = line.match(violationRe);
            if (m && currentFile) {
                failures.push({
                    check: 'lint',
                    file: currentFile,
                    line: parseInt(m[1], 10),
                    ruleOrCode: m[5].trim(),
                    message: m[4].trim().slice(0, 500),
                    severity: m[3] === 'error' ? 'error' : 'warning',
                    occurrence_index: 0,
                });
            }
        }
    }
    return failures;
}
// R-FGNC-1: pnpm prints `WARN  Issue while reading ".../.npmrc". Failed to
// replace env in config: ${...TOKEN}` to stderr on every invocation when a
// token env var referenced by an `.npmrc` is unset. It is benign config-read
// noise — never a check failure — but the classifier's fallback path promoted
// it to the sole reported "failure", masking the real TS/lint errors. Strip
// any pnpm `WARN Issue while reading "<file>"` line (covers the canonical
// `.npmrc`/`${TOKEN}` form and the truncated continuation pnpm emits).
const ENV_NOISE_WARN_RE = /^\s*WARN\s+Issue while reading\s+"/;
export function stripEnvNoise(output) {
    return output
        .split('\n')
        .filter((line) => !ENV_NOISE_WARN_RE.test(line))
        .join('\n');
}
export function buildFailures(result, check, pkgDir) {
    // R-FGNC-2: the subprocess exit code is the source of truth for "did this
    // check fail" — stdout/stderr is scraped only to enumerate WHICH failures
    // exist. Exit 0 → no failures, regardless of stderr WARN content.
    if (result.exitCode === 0)
        return [];
    // R-FGNC-1: tsc/eslint errors land on stdout while pnpm env-noise lands on
    // stderr — combine BOTH streams (the prior `stderr || stdout` dropped the
    // real errors whenever stderr carried the `.npmrc` WARN) then strip the
    // benign noise before the failure-line classifier runs.
    const output = stripEnvNoise(`${result.stdout}\n${result.stderr}`).trim();
    if (check === 'typecheck') {
        const parsed = parseTscOutput(output, pkgDir);
        if (parsed.length > 0)
            return parsed;
    }
    if (check === 'lint') {
        const parsed = parseEslintOutput(output, pkgDir);
        if (parsed.length > 0)
            return parsed;
    }
    return [{
            check,
            file: pkgDir,
            line: 0,
            ruleOrCode: String(result.exitCode),
            message: output.slice(0, 500) || `${check} failed with exit code ${result.exitCode}`,
            severity: 'error',
            occurrence_index: 0,
        }];
}
// R-SZGB-D: a check whose COMMAND never ran (missing npm/pnpm/yarn script, the binary itself
// absent from PATH, ENOENT, exit 127) is a distinct class from "the tool ran and found nothing" —
// buildFailures' generic fallback branch previously conflated the two, so a missing npm script
// became an ordinary subtractable failure that made the check permanently inert. Kept narrow: a
// REAL tool failure (tsc TSxxxx, eslint violations, failing tests) must never match.
const UNRUNNABLE_CHECK_PATTERNS = [
    { re: /npm (?:error|ERR!) .*missing script/i, reason: 'missing npm script' },
    { re: /ERR_PNPM_NO_SCRIPT|pnpm.*missing script/i, reason: 'missing pnpm script' },
    { re: /error Command "[^"]*" not found|couldn't find a script named/i, reason: 'missing yarn script' },
    { re: /^tool not installed:/im, reason: 'tool not installed' },
    { re: /\bENOENT\b/, reason: 'ENOENT' },
    { re: /\bcommand not found\b|is not recognized as an internal or external command/i, reason: 'command not found' },
];
function classifyUnrunnableCheck(result) {
    if (result.exitCode === 0)
        return null;
    if (result.exitCode === 127)
        return 'exit 127: command not found';
    const output = stripEnvNoise(`${result.stdout}\n${result.stderr}`);
    return UNRUNNABLE_CHECK_PATTERNS.find(({ re }) => re.test(output))?.reason ?? null;
}
export function isUnrunnableCheckResult(result) {
    return classifyUnrunnableCheck(result) !== null;
}
const CHECK_KEY_MAP = {
    typecheck: 'typecheck',
    lint: 'lint',
    tests: 'test',
};
function emptyGateResult(allowedPathsUsed = false) {
    return {
        status: 'green',
        failures: [],
        baseline_used: false,
        allowed_paths_used: allowedPathsUsed,
        elapsed_ms: 0,
        total_raw_failure_count: 0,
        new_failures_vs_baseline: 0,
    };
}
function finalizeGateResult(opts, emit, result) {
    emit('gate_run_complete', {
        gate_payload: {
            mode: opts.mode,
            scope: opts.scope,
            checks: opts.checks,
            status: result.status,
            failure_count: result.failures.length,
            total_raw_failure_count: result.total_raw_failure_count,
            new_failures_vs_baseline: result.new_failures_vs_baseline,
            elapsed_ms: result.elapsed_ms,
            allowed_paths_used: result.allowed_paths_used,
            baseline_used: result.baseline_used,
        },
    });
    return result;
}
/**
 * AP-EXT-ITER34-01: both inputs this narrows against — `getChangedSince`'s output and
 * `opts.allowedPaths` (`scope.json:allowed_paths`) — are spelled REPO-ROOT-relative, while
 * `opts.workingDir` may already have been rewritten to a package dir one level down by
 * R-SZGB-A `detectProjectTypeWithRootResolution`. Resolve every repo-root-relative path
 * against ONE base derived from the repo root, never against `opts.workingDir` — the target
 * dirs themselves stay absolute, so package-dir spelling is irrelevant to what gets run.
 */
function selectWorkspaceTargetDirs(opts, workspacePackages, allowedPathsUsed, changedFiles) {
    const repoRoot = resolveLexicalRepoRoot(opts.workingDir);
    let candidates = workspacePackages;
    if (changedFiles && !affectsAllWorkspacePackages(changedFiles)) {
        candidates = workspacePackages.filter(pkgDir => changedFiles.some(f => {
            const absFile = path.resolve(repoRoot, f);
            return absFile.startsWith(pkgDir + path.sep) || absFile === pkgDir;
        }));
    }
    if (!allowedPathsUsed || affectsAllWorkspacePackages(opts.allowedPaths ?? [])) {
        return candidates;
    }
    const relCandidates = candidates.map(p => path.relative(repoRoot, p));
    const filtered = filterByScope(relCandidates, { scope: opts.scope, allowedPaths: opts.allowedPaths });
    return filtered.map(rel => path.resolve(repoRoot, rel));
}
function resolveGateTargetDirs(opts, workspacePackages, allowedPathsUsed, start, emit) {
    // AP-EXT-ITER38-02: resolve the changed set ONCE, ahead of the arm split, and
    // gate BOTH arms on the same empty-set skip. `getChangedSince` maps ANY git
    // failure (unreachable `since` SHA, timeout) to `[]`, so an empty result is
    // never distinguishable from "nothing changed" — it must be declared, never
    // narrowed against. The workspace arm used to narrow: `affectsAllWorkspacePackages([])`
    // is false, so it filtered every package out and returned `[]` with no event,
    // and finalizeGateResult reported an executed `gate_run_complete` green over a
    // gate that ran zero checks.
    // `?? []` keeps this site's disposition byte-identical: an enumeration that FAILED lands in
    // the same `length === 0` skip below that a genuinely empty diff does, which is exactly what
    // AP-EXT-ITER38-02 asked for here (declare the empty set, never narrow against it). `null` on
    // this local keeps its OTHER meaning — "the narrowing arm is unreachable" — un-overloaded.
    const changedFiles = opts.scope === 'changed' && opts.since
        ? (getChangedSince(opts.workingDir, opts.since) ?? [])
        : null;
    if (changedFiles && changedFiles.length === 0) {
        emit('gate_diff_scope_fallback', { since: opts.since, reason: 'no_changed_files' });
        // AC-OFFREPO-1: also emit the canonical gate_skipped event (the same
        // reason the other two emptyGateResult() producers use) so this skip
        // participates in SKIP_FLAG_EVENT_NAMES governance and so runGate can
        // return it directly without routing through finalizeGateResult, which
        // would otherwise report the skip as an executed gate_run_complete pass.
        emit('gate_skipped', { reason: 'no_changed_files' });
        return { targetDirs: [], earlyResult: { ...emptyGateResult(), elapsed_ms: Date.now() - start } };
    }
    if (workspacePackages.length > 0) {
        return { targetDirs: selectWorkspaceTargetDirs(opts, workspacePackages, allowedPathsUsed, changedFiles) };
    }
    return { targetDirs: [opts.workingDir] };
}
function workerModeSkipResult(opts, start, emit) {
    if (!opts.workerMode)
        return null;
    const porcelainR = spawnSync('git', ['status', '--porcelain'], {
        cwd: opts.workingDir, encoding: 'utf-8', timeout: 10_000,
        maxBuffer: UNBOUNDED_READ_MAX_BUFFER,
    });
    const dirtyLines = (porcelainR.stdout ?? '').split('\n').filter(Boolean);
    if (dirtyLines.length === 0)
        return null;
    emit('gate_skipped', { reason: 'dirty_worktree_no_rescue' });
    return { ...emptyGateResult(), elapsed_ms: Date.now() - start };
}
async function gitDriftResult(opts, allowedPathsUsed, start, emit) {
    if (opts.expected_head === undefined && opts.expected_branch === undefined)
        return null;
    const headR = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: opts.workingDir, encoding: 'utf-8', timeout: 10_000,
    });
    const branchR = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: opts.workingDir, encoding: 'utf-8', timeout: 10_000,
    });
    const currentHead = (headR.stdout ?? '').trim();
    const currentBranch = (branchR.stdout ?? '').trim();
    const headMismatch = opts.expected_head !== undefined && currentHead !== opts.expected_head;
    const branchMismatch = opts.expected_branch !== undefined && currentBranch !== opts.expected_branch;
    if (!headMismatch && !branchMismatch)
        return null;
    await writeWorkingDirDriftFile(opts, currentHead, currentBranch);
    emit('gate_workingdir_drift_detected', {
        expected_head: opts.expected_head,
        current_head: currentHead,
        expected_branch: opts.expected_branch,
        current_branch: currentBranch,
    });
    return buildWorkingDirDriftResult(opts, currentHead, currentBranch, allowedPathsUsed, start);
}
async function writeWorkingDirDriftFile(opts, currentHead, currentBranch) {
    const now = new Date().toISOString();
    const iso = now.replace(/[:.]/g, '-');
    const gateDir = path.join(opts.workingDir, 'gate');
    await fs.promises.mkdir(gateDir, { recursive: true });
    await fs.promises.writeFile(path.join(gateDir, `workingdir_drift_${iso}.md`), `# Working Directory Drift\n\nDetected at: ${now}\n\nExpected HEAD: ${opts.expected_head ?? '(any)'}\nCurrent HEAD: ${currentHead}\nExpected branch: ${opts.expected_branch ?? '(any)'}\nCurrent branch: ${currentBranch}\n`);
}
function buildWorkingDirDriftResult(opts, currentHead, currentBranch, allowedPathsUsed, start) {
    return {
        status: 'red',
        failures: [{
                check: 'tests',
                file: '<workingdir-drift>',
                line: 0,
                ruleOrCode: 'GATE_WORKINGDIR_DRIFT',
                message: `Working directory drift: expected branch "${opts.expected_branch ?? '(any)'}", got "${currentBranch}"; expected HEAD "${opts.expected_head ?? '(any)'}", got "${currentHead}"`,
                severity: 'error',
                occurrence_index: 0,
            }],
        baseline_used: false,
        allowed_paths_used: allowedPathsUsed,
        elapsed_ms: Date.now() - start,
        total_raw_failure_count: 1,
        new_failures_vs_baseline: 0,
    };
}
export async function classifyTestScriptSafety(projectType, dir) {
    if (!['pnpm', 'npm', 'yarn'].includes(projectType))
        return { runnable: true };
    const pkgJsonPath = path.join(dir, 'package.json');
    let scriptContent = '';
    let scripts = {};
    try {
        const raw = await fs.promises.readFile(pkgJsonPath, 'utf-8');
        scripts = JSON.parse(raw).scripts ?? {};
        scriptContent = scripts.test ?? '';
    }
    catch {
        // file absent or unreadable — leave scriptContent empty
    }
    const leafCommands = resolveDelegatedScriptLeaves('test', scripts);
    const commandsToInspect = leafCommands.length > 0 ? leafCommands : [scriptContent].filter((value) => value.length > 0);
    const unsafeLeaf = commandsToInspect.find((command) => UNSAFE_TEST_SCRIPT_REGEX.test(command));
    if (unsafeLeaf)
        return { runnable: false, script: scriptContent, unsafeLeaf };
    if (commandsToInspect.some((command) => SAFE_TEST_RUNNER_REGEX.test(command)))
        return { runnable: true };
    return { runnable: false, script: scriptContent, unsafeLeaf: null };
}
async function canRunTestScript(check, projectType, dir, emit) {
    if (check !== 'tests')
        return true;
    const safety = await classifyTestScriptSafety(projectType, dir);
    if (safety.runnable)
        return true;
    if (safety.unsafeLeaf) {
        emit('gate_unsafe_test_command_blocked', { script: safety.script, leaf_script: safety.unsafeLeaf });
    }
    return false;
}
function splitScriptSegments(script) {
    return script
        .split(/\s*(?:&&|\|\||;)\s*/)
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);
}
function delegatedScriptName(segment) {
    let remaining = segment.trim();
    while (remaining.length > 0) {
        const match = remaining.match(PACKAGE_MANAGER_RUN_RE);
        if (match?.[2])
            return match[2];
        const wrapper = ENV_WRAPPER_PREFIXES.find((prefix) => remaining === prefix || remaining.startsWith(`${prefix} `));
        if (wrapper) {
            remaining = remaining.slice(wrapper.length).trimStart();
            continue;
        }
        const token = remaining.match(/^\S+/)?.[0];
        if (token && ENV_ASSIGNMENT_RE.test(token)) {
            remaining = remaining.slice(token.length).trimStart();
            continue;
        }
        break;
    }
    return null;
}
function resolveDelegatedScriptLeaves(scriptName, scripts, seen = new Set()) {
    if (seen.has(scriptName))
        return [];
    const script = scripts[scriptName];
    if (typeof script !== 'string' || script.trim().length === 0)
        return [];
    const nextSeen = new Set(seen);
    nextSeen.add(scriptName);
    const leaves = [];
    for (const segment of splitScriptSegments(script)) {
        const delegatedName = delegatedScriptName(segment);
        if (delegatedName && delegatedName !== scriptName && scripts[delegatedName]) {
            const nestedLeaves = resolveDelegatedScriptLeaves(delegatedName, scripts, nextSeen);
            if (nestedLeaves.length > 0) {
                leaves.push(...nestedLeaves);
                continue;
            }
        }
        leaves.push(segment);
    }
    return leaves;
}
async function runGateCheck(check, cmd, dir, effectiveMs) {
    try {
        const result = await runCheckCommand(check, cmd, dir, effectiveMs);
        const failures = buildFailures(result, check, dir);
        const unrunnableReason = classifyUnrunnableCheck(result);
        const unrunnable = unrunnableReason !== null ? { check, reason: unrunnableReason } : null;
        return { failures, unrunnable };
    }
    catch (err) {
        if (!(err instanceof GateTimeoutError))
            throw err;
        return {
            failures: [{
                    check,
                    file: '<timeout>',
                    line: 0,
                    ruleOrCode: 'GATE_CHECK_TIMEOUT',
                    message: `${check} timed out after ${effectiveMs}ms`,
                    severity: 'error',
                    occurrence_index: 0,
                }],
            unrunnable: null,
        };
    }
}
async function collectGateFailures(opts, targetDirs, cmdMap, projectType, totalDeadline, emit) {
    const allFailures = [];
    let unrunnableCheck = null;
    outerLoop: for (const dir of targetDirs) {
        for (const check of opts.checks) {
            const remaining = totalDeadline - Date.now();
            if (remaining <= 0) {
                allFailures.push(timeoutFailure(check));
                break outerLoop;
            }
            const cmd = cmdMap[CHECK_KEY_MAP[check]];
            if (!cmd)
                continue;
            if (!(await canRunTestScript(check, projectType, dir, emit)))
                continue;
            const perCheckMs = opts._timeouts?.perCheck?.[check] ?? PER_CHECK_TIMEOUT_MS[check];
            const outcome = await runGateCheck(check, cmd, dir, Math.min(perCheckMs, remaining));
            allFailures.push(...outcome.failures);
            if (outcome.unrunnable && !unrunnableCheck)
                unrunnableCheck = outcome.unrunnable;
        }
    }
    return { failures: allFailures, unrunnableCheck };
}
function timeoutFailure(check) {
    return {
        check,
        file: '<timeout>',
        line: 0,
        ruleOrCode: 'GATE_CHECK_TIMEOUT',
        message: `cumulative gate timeout exceeded`,
        severity: 'error',
        occurrence_index: 0,
    };
}
/**
 * Persist a `GateBaselineFile` to disk with mandatory post-write verification.
 * Used by both the empty-baseline early-return paths (no project type detected,
 * or detected type lacks a command map — `checks`/`failures` empty) and the
 * captured-baseline path. The post-write `access` + `inspectBaselinePath` probe
 * keeps the contract with `microverse-runner.capturePerIterationGateBaseline` —
 * which post-checks `pathExists(baselinePath)` — intact, so a green baseline-mode
 * result never reports success while `gate/baseline.json` is absent. Throws
 * `BaselineWriteFailedError` on any disk failure.
 */
async function persistGateBaseline(baselinePath, opts, projectType, checks, failures, emit) {
    try {
        const baseline = {
            schema_version: 1,
            captured_at: new Date().toISOString(),
            captured_iteration: opts.baselineIteration,
            working_dir: opts.workingDir,
            project_type: projectType,
            checks,
            failures,
        };
        await fs.promises.mkdir(path.dirname(baselinePath), { recursive: true });
        writeStateFile(baselinePath, baseline);
        await fs.promises.access(baselinePath);
        const postWriteStatus = await inspectBaselinePath(baselinePath);
        emit('gate_baseline_disk_check', { phase: 'post_write', ...postWriteStatus });
        if (postWriteStatus.exists !== true) {
            throw new BaselineWriteFailedError(baselinePath, `Baseline write reported success but file is missing at ${baselinePath}`);
        }
    }
    catch (err) {
        throw baselineWriteFailed(baselinePath, err);
    }
}
async function handleBaselineMode(opts, projectType, allowedPathsUsed, realFailures, start, emit, uncertifiable) {
    if (opts.mode !== 'baseline' || !opts.baselinePath)
        return null;
    const baselinePath = opts.baselinePath;
    const withIndices = assignOccurrenceIndices(realFailures);
    const lockKey = `gate-${createHash('sha256').update(opts.workingDir).digest('hex')}`;
    const lockMs = opts._timeouts?.lockMs ?? GATE_LOCK_TIMEOUT_MS;
    try {
        return await withLock(lockKey, { timeout_ms: lockMs }, async () => {
            emit('gate_lock_acquired', { lock_key: lockKey });
            return await resolveBaselineResult(baselinePath, opts, projectType, withIndices, allowedPathsUsed, start, emit, uncertifiable);
        });
    }
    catch (err) {
        if (err instanceof LockError) {
            emit('gate_lock_timeout', { lock_key: lockKey, waited_ms: err.waited_ms ?? lockMs });
            throw baselineWriteFailed(baselinePath, err);
        }
        throw err;
    }
}
// AP-EXT-ITER15-01: arm `subtractBaseline`'s R-ORSR-6 `selfGuard` at its ONE production call site.
// The per-iteration gate already carries the phase's own diff base as `opts.since` (the caller
// passes `preIterSha`), which is exactly the axis the no-disown classifier needs. Absent `since`,
// or a diff with neither changed files nor changed exported symbols, yields `undefined` — byte-for-
// byte the pre-guard subtraction, so the guard can only ever KEEP a failure the iteration caused.
function buildNoDisownContext(opts) {
    const since = opts.since?.trim();
    if (!since)
        return undefined;
    // `null` (enumeration did not complete) degrades to the empty set on BOTH axes here, which is
    // byte-identical to the pre-fix behaviour: this context can only ever KEEP a failure the
    // iteration caused, so a narrower set never invents one. The RENDERED arm of the same
    // measurement failure is the interface-change sweep — see `runInterfaceChangeSweep`, which
    // must NOT degrade because it reports `ran: true` and its verdict is read as evidence.
    const changedFiles = new Set((getChangedSince(opts.workingDir, since) ?? []).map(f => normalizeScopePath(f)));
    const changedExportedSymbols = getChangedExportedSymbols(opts.workingDir, since) ?? new Set();
    if (changedFiles.size === 0 && changedExportedSymbols.size === 0)
        return undefined;
    return { changedFiles, changedExportedSymbols, workingDir: resolveLexicalRepoRoot(opts.workingDir) };
}
async function resolveBaselineResult(baselinePath, opts, projectType, withIndices, allowedPathsUsed, start, emit, uncertifiable) {
    const preWriteStatus = await inspectBaselinePath(baselinePath);
    emit('gate_baseline_disk_check', { phase: 'pre_write', ...preWriteStatus });
    if (preWriteStatus.exists !== true) {
        // R-SZGB-D: an unrunnable check means the gate inspected NOTHING for that check — reuse the
        // R-SZGB-B `project_type: null` uncertifiable-baseline signal so the existing
        // `isBaselineUncertifiable` consumer in microverse-runner.ts fails closed with no new field.
        await persistGateBaseline(baselinePath, opts, uncertifiable ? null : projectType, opts.checks, withIndices, emit);
        emit('gate_baseline_captured', { path: baselinePath, failure_count: withIndices.length });
        emit('gate_preexisting_tests_baselined', { failure_count: withIndices.length });
        return {
            status: 'green',
            failures: [],
            baseline_used: false,
            allowed_paths_used: allowedPathsUsed,
            elapsed_ms: Date.now() - start,
            total_raw_failure_count: withIndices.length,
            new_failures_vs_baseline: 0,
        };
    }
    const newFailures = subtractBaseline(withIndices, loadBaselineFile(baselinePath), buildNoDisownContext(opts));
    return {
        status: newFailures.length === 0 ? 'green' : 'red',
        failures: newFailures,
        baseline_used: true,
        allowed_paths_used: allowedPathsUsed,
        elapsed_ms: Date.now() - start,
        total_raw_failure_count: withIndices.length,
        new_failures_vs_baseline: newFailures.length,
    };
}
async function knownFlakeResult(opts, allFailures, realFailures, flakeFailures, allowedPathsUsed, start, emit) {
    if (realFailures.length !== 0 || flakeFailures.length === 0)
        return null;
    const now = new Date().toISOString();
    const iso = now.replace(/[:.]/g, '-');
    const gateDir = path.join(opts.workingDir, 'gate');
    await fs.promises.mkdir(gateDir, { recursive: true });
    await fs.promises.writeFile(path.join(gateDir, `known_flake_failures_${iso}.md`), `# Known Flake Failures\n\nCaptured: ${now}\n\n${flakeFailures.map(f => `- \`${f.file}\` [${f.check}]: ${f.message.slice(0, 200)}`).join('\n')}\n`);
    emit('gate_out_of_scope_failures_present', { flake_count: flakeFailures.length, paths: flakeFailures.map(f => f.file) });
    return {
        status: 'green-with-known-flake-warnings',
        failures: [],
        baseline_used: false,
        allowed_paths_used: allowedPathsUsed,
        elapsed_ms: Date.now() - start,
        total_raw_failure_count: allFailures.length,
        new_failures_vs_baseline: 0,
    };
}
function finalGateResult(realFailures, allFailures, allowedPathsUsed, start, emit) {
    const status = realFailures.length === 0 ? 'green' : 'red';
    if (status === 'red') {
        emit('gate_regression_threshold_warning', { failure_count: realFailures.length });
    }
    return {
        status,
        failures: realFailures,
        baseline_used: false,
        allowed_paths_used: allowedPathsUsed,
        elapsed_ms: Date.now() - start,
        total_raw_failure_count: allFailures.length,
        new_failures_vs_baseline: 0,
    };
}
/**
 * Emit `gate_skipped` and return an empty (green) gate result. When called in
 * baseline mode with a `baselinePath`, write a valid empty `GateBaselineFile`
 * BEFORE returning so downstream `pathExists(baselinePath)` consumers (notably
 * `microverse-runner.capturePerIterationGateBaseline`) don't observe a silent
 * skip as a missing-baseline error.
 */
async function emitSkippedAndReturn(opts, projectType, reason, start, emit, extra = {}) {
    if (opts.mode === 'baseline' && opts.baselinePath) {
        await persistGateBaseline(opts.baselinePath, opts, projectType, [], [], emit);
    }
    emit('gate_skipped', { reason, ...extra });
    return { ...emptyGateResult(), elapsed_ms: Date.now() - start };
}
const NON_CANDIDATE_CHILD_DIRS = new Set(['node_modules']);
/**
 * R-SZGB-A: when `target` itself carries no project marker, scan its immediate
 * children (depth 1, skipping node_modules/dot-dirs) for the real package root
 * via the same `detectProjectType` primitive. Returns the single unambiguous
 * candidate, or null on zero or 2+ matches — callers must never guess.
 */
function resolveProjectRootOneLevelDown(target) {
    let entries;
    try {
        entries = fs.readdirSync(target, { withFileTypes: true });
    }
    catch {
        return null;
    }
    const candidates = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || NON_CANDIDATE_CHILD_DIRS.has(entry.name))
            continue;
        const childDir = path.join(target, entry.name);
        const childType = detectProjectType(childDir);
        if (childType)
            candidates.push({ dir: childDir, type: childType });
    }
    return candidates.length === 1 ? candidates[0] : null;
}
/**
 * R-SZGB-A: detect the project type at `opts.workingDir`, falling back to the
 * bounded depth-1 resolver when the target itself has no marker. Returns opts
 * unchanged (and projectType null) when neither the target nor a lone child
 * resolves.
 */
function detectProjectTypeWithRootResolution(opts) {
    const projectType = detectProjectType(opts.workingDir);
    if (projectType)
        return { opts, projectType };
    const resolvedRoot = resolveProjectRootOneLevelDown(opts.workingDir);
    if (!resolvedRoot)
        return { opts, projectType: null };
    console.error(`gate: resolved project root 1 level(s) below target -> ${resolvedRoot.dir}`);
    return { opts: { ...opts, workingDir: resolvedRoot.dir }, projectType: resolvedRoot.type };
}
/**
 * R-SZGB-D-A: logs the uncertifiable-baseline signal only in baseline mode, keeping this
 * conditional out of runGate's cyclomatic complexity count.
 */
function logUnrunnableCheckIfBaseline(unrunnableCheck, mode) {
    if (!unrunnableCheck || mode !== 'baseline')
        return;
    console.error(`gate: check '${unrunnableCheck.check}' could not run (${unrunnableCheck.reason}) — baseline uncertifiable, cannot certify`);
}
export async function runGate(rawOpts) {
    const start = Date.now();
    const emit = (event, data) => rawOpts.onEvent?.(event, data);
    const { opts, projectType } = detectProjectTypeWithRootResolution(rawOpts);
    if (!projectType) {
        return emitSkippedAndReturn(opts, null, 'no_project_type_detected', start, emit);
    }
    const commands = loadGateCommands();
    const cmdMap = commands[projectType];
    if (!cmdMap) {
        return emitSkippedAndReturn(opts, projectType, 'project_type_low_confidence', start, emit, { detected_signals: [projectType] });
    }
    const workspacePackages = getWorkspacePackages(opts.workingDir);
    const allowedPathsUsed = Boolean(opts.allowedPaths && opts.allowedPaths.length > 0);
    const resolved = resolveGateTargetDirs(opts, workspacePackages, allowedPathsUsed, start, emit);
    // AC-OFFREPO-1: return this skip directly rather than through
    // finalizeGateResult, which would emit gate_run_complete (status green) and
    // make the skip indistinguishable from an executed pass — matching the
    // workerModeSkipResult / emitSkippedAndReturn skip producers below.
    if (resolved.earlyResult)
        return resolved.earlyResult;
    const workerSkip = workerModeSkipResult(opts, start, emit);
    if (workerSkip)
        return workerSkip;
    const drift = await gitDriftResult(opts, allowedPathsUsed, start, emit);
    if (drift)
        return finalizeGateResult(opts, emit, drift);
    const totalDeadline = Date.now() + (opts._timeouts?.total ?? GATE_TOTAL_TIMEOUT_MS);
    const { failures: allFailures, unrunnableCheck } = await collectGateFailures(opts, resolved.targetDirs, cmdMap, projectType, totalDeadline, emit);
    logUnrunnableCheckIfBaseline(unrunnableCheck, opts.mode);
    const flakeGlobs = opts.settings?.convergence_gate?.known_flake_files ?? [];
    const { real: realFailures, flake: flakeFailures } = applyFlakeFilter(allFailures, opts.workingDir, flakeGlobs);
    const baseline = await handleBaselineMode(opts, projectType, allowedPathsUsed, realFailures, start, emit, unrunnableCheck !== null);
    if (baseline)
        return finalizeGateResult(opts, emit, baseline);
    const flake = await knownFlakeResult(opts, allFailures, realFailures, flakeFailures, allowedPathsUsed, start, emit);
    if (flake)
        return finalizeGateResult(opts, emit, flake);
    return finalizeGateResult(opts, emit, finalGateResult(realFailures, allFailures, allowedPathsUsed, start, emit));
}

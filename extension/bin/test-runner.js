#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import path from 'node:path';
import { killProcessGroup } from '../services/orphan-reaper.js';
// Cap any requested --test-concurrency to the available cores. node:test does NOT
// auto-cap an explicit --test-concurrency, so a hardcoded `=8` oversubscribes a
// 2-core CI runner and produces broad timeout-shaped flakes across subprocess /
// timing-sensitive tests. Clamping (never raising) keeps c=8 on capable dev
// machines while making CI run at its core count. (R-TCC-1)
function clampTestConcurrency(args) {
    const cap = Math.max(1, availableParallelism());
    const out = [];
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        const eq = /^--test-concurrency=(\d+)$/.exec(arg);
        if (eq) {
            out.push(`--test-concurrency=${Math.min(Number(eq[1]), cap)}`);
            continue;
        }
        if (arg === '--test-concurrency' && /^\d+$/.test(args[i + 1] ?? '')) {
            out.push(arg, String(Math.min(Number(args[i + 1]), cap)));
            i += 1;
            continue;
        }
        out.push(arg);
    }
    return out;
}
const VALID_TIERS = new Set(['fast', 'integration', 'expensive', 'contract']);
const QUARANTINED_TIER_EXCLUSIONS = new Set(['fast', 'integration']);
// Serial-manifest worst case: SOAK_SECONDS default (1800s, deploy-lifecycle-soak) is the long pole
// among the 3 `tests/expensive/.serial-tests.json` entries. A runner timeout equal to the soak
// alone starves its serial siblings (`fail 0, cancelled 2`), making the release gate unpassable at
// its documented default. Derive the default from soak-worst-case * serial-entry-count, with
// headroom, rather than shortening the soak (see extension/CLAUDE.md `PICKLE_TEST_RUNNER_TIMEOUT_MS`).
const SOAK_SECONDS_DEFAULT = 1800;
const SERIAL_MANIFEST_WORST_CASE_ENTRY_COUNT = 3;
const DEFAULT_TEST_RUNNER_TIMEOUT_MS = SOAK_SECONDS_DEFAULT * 1000 * SERIAL_MANIFEST_WORST_CASE_ENTRY_COUNT * 2;
const MAX_TEST_RUNNER_TIMEOUT_MS = 24 * 60 * 60 * 1000;
function exitWithError(message, code) {
    process.stderr.write(`${message}\n`);
    process.exit(code);
}
function requireArgValue(args, index, flag, code = 2) {
    const value = args[index + 1];
    if (!value)
        exitWithError(`Missing value for ${flag}`, code);
    return value;
}
function parseManifestMode(value) {
    if (value === 'include' || value === 'exclude') {
        return value;
    }
    exitWithError(`Unknown manifest mode: ${value}`, 2);
}
function parseTier(value) {
    if (VALID_TIERS.has(value)) {
        return value;
    }
    exitWithError(`Unknown tier: ${value}`, 2);
}
function parseArgs(args) {
    const runnerArgs = [];
    const testFiles = [];
    let dryRun = false;
    let grepPattern = null;
    let manifestMode = null;
    let manifestPath = null;
    let tier = null;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        switch (arg) {
            case '--grep': {
                const pattern = requireArgValue(args, index, '--grep', 1);
                grepPattern = pattern;
                runnerArgs.push('--test-name-pattern', pattern);
                index += 1;
                break;
            }
            case '--tier':
                tier = parseTier(requireArgValue(args, index, '--tier'));
                index += 1;
                break;
            case '--dry-run':
                dryRun = true;
                break;
            case '--manifest':
                manifestPath = requireArgValue(args, index, '--manifest');
                index += 1;
                break;
            case '--manifest-mode':
                manifestMode = parseManifestMode(requireArgValue(args, index, '--manifest-mode'));
                index += 1;
                break;
            default:
                if (arg.startsWith('--'))
                    runnerArgs.push(arg);
                else
                    testFiles.push(arg);
                break;
        }
    }
    if (tier && testFiles.length > 0) {
        exitWithError('--tier cannot be combined with positional test files', 2);
    }
    if ((manifestPath === null) !== (manifestMode === null)) {
        exitWithError('--manifest and --manifest-mode must be provided together', 2);
    }
    return { dryRun, grepPattern, manifestMode, manifestPath, runnerArgs, testFiles, tier };
}
function normalizeTestPath(filePath) {
    return filePath.split(path.sep).join('/');
}
function discoverTestFiles(dir, rootDir) {
    if (!existsSync(dir))
        return [];
    return readdirSync(dir, { withFileTypes: true })
        .flatMap((entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory())
            return discoverTestFiles(fullPath, rootDir);
        if (!entry.isFile() || !entry.name.endsWith('.test.js'))
            return [];
        return [normalizeTestPath(path.relative(rootDir, fullPath))];
    })
        .sort();
}
function firstMeaningfulLine(filePath) {
    const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        if (line.startsWith('#!'))
            continue;
        if (line.trim() === '')
            continue;
        return line.trim();
    }
    return '';
}
function tierForTestFile(filePath) {
    const match = firstMeaningfulLine(filePath).match(/^\/\/\s*@tier:\s*([A-Za-z0-9_-]+)\s*$/);
    return match?.[1] ?? null;
}
function normalizeQuarantineEntry(rawEntry) {
    const withoutDotSlash = rawEntry.replace(/^\.\//, '');
    if (withoutDotSlash.startsWith('tests/'))
        return withoutDotSlash;
    return `tests/${withoutDotSlash}`;
}
function readManifestEntries(rootDir, manifestPath) {
    const resolvedPath = path.resolve(rootDir, manifestPath);
    if (!existsSync(resolvedPath)) {
        exitWithError(`Manifest not found: ${manifestPath}`, 1);
    }
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(resolvedPath, 'utf8'));
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        exitWithError(`Manifest is not valid JSON: ${manifestPath}\n${reason}`, 1);
    }
    if (typeof parsed !== 'object' || parsed === null || !('entries' in parsed)) {
        exitWithError(`Manifest must contain an entries array: ${manifestPath}`, 1);
    }
    const { entries } = parsed;
    if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === 'string')) {
        exitWithError(`Manifest entries must be string[]: ${manifestPath}`, 1);
    }
    const normalized = new Set();
    for (const entry of entries) {
        const candidate = normalizeQuarantineEntry(entry);
        const candidatePath = path.resolve(rootDir, candidate);
        if (!existsSync(candidatePath)) {
            exitWithError(`Manifest entry not found: ${candidate}`, 1);
        }
        normalized.add(normalizeTestPath(candidate));
    }
    return normalized;
}
/**
 * A quarantine entry is a `## tests/<path>` HEADING outside an HTML comment — the same
 * thing `scripts/audit-quarantine.sh` opens an entry on, so exactly the set the audit
 * validates is the set excluded here.
 *
 * A free-text `.test.js` scan is a SECOND, wider definition, and the audit is structurally
 * blind to the difference: a filename inside the `<!-- -->` schema comment, or named in an
 * entry's prose ("superseded by tests/foo.test.js"), opens no entry the audit can see, yet
 * still deletes that file from the fast and integration tiers. Measured on the shipped
 * runner: a name in the comment block dropped `tests/metrics.test.js` (63 tests) from the
 * tier while `audit-quarantine.sh` exited 0. The audit's `initial_count + 5` ceiling counts
 * headings, so the wider reading can also drop unboundedly many files under a satisfied cap.
 *
 * The unterminated-comment arm matches the audit's state machine, which leaves `in_comment`
 * set to end-of-file when a `<!--` never closes.
 */
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?(?:-->|$)/g;
const QUARANTINE_HEADING_PATTERN = /^##\s+(tests\/[A-Za-z0-9._/@+-]+\.test\.js)\s*$/;
function readQuarantineSet(rootDir) {
    const manifestPath = path.join(rootDir, 'tests', 'QUARANTINE.md');
    if (!existsSync(manifestPath))
        return new Set();
    const entries = new Set();
    const manifest = readFileSync(manifestPath, 'utf8').replace(HTML_COMMENT_PATTERN, '');
    for (const line of manifest.split(/\r?\n/)) {
        const match = QUARANTINE_HEADING_PATTERN.exec(line);
        if (match)
            entries.add(match[1]);
    }
    return entries;
}
function discoverTierFiles(rootDir, tier) {
    const testsDir = path.join(rootDir, 'tests');
    const quarantineSet = QUARANTINED_TIER_EXCLUSIONS.has(tier)
        ? readQuarantineSet(rootDir)
        : new Set();
    return discoverTestFiles(testsDir, rootDir).filter((relativePath) => {
        if (quarantineSet.has(relativePath))
            return false;
        return tierForTestFile(path.join(rootDir, relativePath)) === tier;
    });
}
function applyManifestFilter(selectedFiles, manifestEntries, manifestMode) {
    return selectedFiles.filter((relativePath) => {
        const inManifest = manifestEntries.has(normalizeTestPath(relativePath));
        return manifestMode === 'include' ? inManifest : !inManifest;
    });
}
function shouldSkipTier(tier) {
    return tier === 'expensive' && process.env.RUN_EXPENSIVE_TESTS !== '1';
}
/**
 * A per-run disposable tmpdir root for the spawned test child, prefixed `pickle-` so it is
 * admitted by `TEST_OWNED_TMP_PREFIXES` (orphan-reaper.ts) if cleanup is ever skipped. Creation
 * failure (ENOSPC, EACCES, etc.) degrades to `null` — the caller falls back to the child
 * inheriting the parent's own `TMPDIR`, never failing the run over a tmpdir-scoping nicety.
 */
function createDisposableTmpRoot() {
    try {
        return mkdtempSync(path.join(tmpdir(), 'pickle-'));
    }
    catch {
        return null;
    }
}
function getRunnerTimeoutMs() {
    const raw = process.env.PICKLE_TEST_RUNNER_TIMEOUT_MS;
    if (raw === undefined || raw.trim() === '')
        return DEFAULT_TEST_RUNNER_TIMEOUT_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        exitWithError(`Invalid PICKLE_TEST_RUNNER_TIMEOUT_MS: ${raw}`, 2);
    }
    return Math.min(parsed, MAX_TEST_RUNNER_TIMEOUT_MS);
}
function selectFiles(rootDir, tier, grepPattern, testFiles, manifestEntries, manifestMode) {
    const baseSelection = tier
        ? discoverTierFiles(rootDir, tier)
        : grepPattern
            ? testFiles.filter((file) => readFileSync(file, 'utf8').includes(grepPattern))
            : testFiles;
    if (manifestEntries && manifestMode) {
        return applyManifestFilter(baseSelection, manifestEntries, manifestMode);
    }
    return baseSelection;
}
function handleEmptySelection(tier, grepPattern, selectedFiles) {
    if (grepPattern && !tier && selectedFiles.length === 0) {
        exitWithError(`No tests matched --grep ${grepPattern}`, 1);
    }
    if (tier && selectedFiles.length === 0) {
        process.stderr.write(`[no files for tier ${tier}]\n`);
        process.exit(0);
    }
}
/**
 * `--test` is a package-manager-shaped ROOT too: each selected file runs in its OWN
 * per-file child process, and that per-file process can itself spawn further descendants
 * (the exact `npm -> node --test` grandchild shape `services/convergence-gate.ts`'s
 * `runCheckSubtree` already reaps). `spawnSync`'s own `timeout` option signals ONLY this
 * direct child pid, not the group, so a wedged per-file process (or anything it spawned)
 * survives as a PID-1 orphan the moment `--test`'s own signal handling fails to cascade.
 * `detached` makes this child LEAD its own process group so there is a group to reap, and
 * `reapTimedOutChild` reuses the SAME shared negative-PID primitive `runCheckSubtree`
 * delegates to — one discipline, no platform branch beyond the win32 check `detached`
 * itself already requires.
 *
 * `SpawnSyncOptions` omits `detached` in @types/node (it is declared only on the async
 * `SpawnOptions`), but spawnSync's underlying libuv spawn honors it identically — a detached
 * sync child leads its own process group (verified: child pid === child pgid, distinct from
 * this process's own pgid). The intersection type is a documentation of that runtime/type gap,
 * not a workaround.
 *
 * ACCEPTED COST, verified not argued: `detached` also takes the child OUT of this process's
 * OWN process group, so a signal delivered to THIS process's group (a terminal Ctrl-C, or any
 * `kill -TERM -$pgid`) no longer reaches the child — pre-fix, sharing the group meant that
 * signal killed both together. A `process.on('SIGTERM', ...)` handler cannot close this gap:
 * the spawn call is synchronous, so the handler cannot run — and would not even suppress the
 * default terminate action usefully — until `spawnSync` itself returns (verified: with a
 * handler registered, a SIGTERM to the parent's group left the parent blocked-and-alive,
 * ignoring the interrupt, for the full duration until the child exited on its own — worse
 * than today's clean immediate kill). Closing this gap for real needs the async-`spawn` +
 * signal-forwarding shape `pipeline-runner.ts`/`jar-runner.ts` use, which is a larger
 * architectural change than this fix's scope (ETIMEDOUT-only orphan reap, matching
 * `runCheckSubtree`'s existing discipline). Net effect versus pre-fix: the (previously
 * unhandled) ETIMEDOUT leak is closed unconditionally; a signal-based kill of this process
 * (interactive Ctrl-C, external SIGTERM) now leaves the child group behind where it
 * previously died with the parent — same trade root CLAUDE.md's AP-EXT-ITER54-01 entry
 * already accepted for `runCheckSubtree`.
 */
function buildTestSpawnOptions(disposableTmpRoot) {
    return {
        stdio: 'inherit',
        timeout: getRunnerTimeoutMs(),
        detached: process.platform !== 'win32',
        env: disposableTmpRoot ? { ...process.env, TMPDIR: disposableTmpRoot } : process.env,
    };
}
/**
 * ETIMEDOUT-only orphan reap: reap the process GROUP `detached` created, falling back to the
 * bare pid on the platforms (and races) where the group kill reports nothing killed.
 */
function reapTimedOutChild(result) {
    const timedOut = result.error?.code === 'ETIMEDOUT';
    if (!timedOut || typeof result.pid !== 'number')
        return;
    if (killProcessGroup(result.pid, 'SIGKILL'))
        return;
    try {
        process.kill(result.pid, 'SIGKILL');
    }
    catch {
        // Best-effort: the child may have already exited.
    }
}
/**
 * Cleanup runs BEFORE process.exit(): a synchronous process.exit() does not run pending
 * `finally` blocks, so cleanup must happen on the normal control-flow path, not deferred to one.
 */
function removeDisposableTmpRoot(disposableTmpRoot) {
    if (!disposableTmpRoot)
        return;
    try {
        rmSync(disposableTmpRoot, { recursive: true, force: true });
    }
    catch {
        // Best-effort: a leftover pickle-* root is still reapable by the orphan reaper.
    }
}
function main() {
    const { dryRun, grepPattern, manifestMode, manifestPath, runnerArgs, testFiles, tier, } = parseArgs(process.argv.slice(2));
    const rootDir = process.cwd();
    if (shouldSkipTier(tier)) {
        process.stderr.write('[skipped: RUN_EXPENSIVE_TESTS unset]\n');
        process.exit(0);
    }
    const manifestEntries = manifestPath ? readManifestEntries(rootDir, manifestPath) : null;
    const selectedFiles = selectFiles(rootDir, tier, grepPattern, testFiles, manifestEntries, manifestMode);
    handleEmptySelection(tier, grepPattern, selectedFiles);
    if (dryRun) {
        if (selectedFiles.length > 0)
            process.stdout.write(`${selectedFiles.join('\n')}\n`);
        process.exit(0);
    }
    const nodeArgs = ['--test', ...clampTestConcurrency(runnerArgs), ...selectedFiles];
    const disposableTmpRoot = createDisposableTmpRoot();
    const result = spawnSync(process.execPath, nodeArgs, buildTestSpawnOptions(disposableTmpRoot));
    reapTimedOutChild(result);
    removeDisposableTmpRoot(disposableTmpRoot);
    if (result.error) {
        exitWithError(result.error.message, 1);
    }
    process.exit(result.status ?? 1);
}
main();

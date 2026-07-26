/**
 * B-GITATTR WS-1: materializes a managed git hooks directory whose
 * `prepare-commit-msg` stamps a `Pickle-Ticket: <id>` trailer from
 * `PICKLE_TICKET_ID`, and whose forwarding stubs re-exec every OTHER
 * pre-existing hook in the target repo unchanged.
 *
 * This module never mutates the target repo: no `.git/hooks` write, no `git
 * config` write. It only writes inside the caller-supplied `managedDir`. The
 * caller (ticket 30) is responsible for creating `managedDir` outside the
 * repo and pointing `core.hooksPath` at it via the spawn env
 * (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0`), never by
 * writing `core.hooksPath` into the repo's own config.
 *
 * Fail-safe: if the target repo's pre-existing hooks dir cannot be resolved,
 * this materializes NOTHING and returns `{ok:false, reason}` — degrading to
 * read-side attribution is acceptable; silently disabling a target repo's
 * own hooks (e.g. husky pre-commit) is not.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
const GIT_RESOLVE_TIMEOUT_MS = 10_000;
function runGitBestEffort(args, cwd) {
    try {
        const result = spawnSync('git', args, {
            cwd,
            encoding: 'utf-8',
            timeout: GIT_RESOLVE_TIMEOUT_MS,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (result.error)
            return { status: -1, stdout: '' };
        return { status: result.status ?? -1, stdout: result.stdout ?? '' };
    }
    catch {
        return { status: -1, stdout: '' };
    }
}
function resolveAgainstRepoRoot(repoRoot, value) {
    return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}
/** Runs `git <args>` and, on success with non-empty stdout, resolves it to an existing dir. */
function resolveDirFromGitOutput(args, repoRoot) {
    try {
        const result = runGitBestEffort(args, repoRoot);
        if (result.status !== 0 || result.stdout.trim().length === 0)
            return null;
        const resolved = resolveAgainstRepoRoot(repoRoot, result.stdout.trim());
        return fs.statSync(resolved).isDirectory() ? resolved : null;
    }
    catch {
        return null;
    }
}
/**
 * Resolves the target repo's PRE-EXISTING hooks directory: `core.hooksPath`
 * first (git-config(1) resolves a relative value against the repo root),
 * else `rev-parse --git-path hooks` (the default `.git/hooks`, honoring
 * separate-git-dir/worktree layouts). Returns null when neither resolves to
 * an existing directory, or on any error — never throws.
 */
function resolvePreExistingHooksDir(repoRoot) {
    return (resolveDirFromGitOutput(['config', '--get', 'core.hooksPath'], repoRoot) ??
        resolveDirFromGitOutput(['rev-parse', '--git-path', 'hooks'], repoRoot));
}
function isExecutableFile(entryPath) {
    try {
        const stat = fs.statSync(entryPath);
        return stat.isFile() && (stat.mode & 0o111) !== 0;
    }
    catch {
        return false;
    }
}
/** Every executable hook in `preExistingDir` other than `prepare-commit-msg`. */
function listForwardableHooks(preExistingDir) {
    try {
        return fs
            .readdirSync(preExistingDir, { withFileTypes: true })
            .map((entry) => entry.name)
            .filter((name) => name !== 'prepare-commit-msg')
            .filter((name) => isExecutableFile(path.join(preExistingDir, name)));
    }
    catch {
        return [];
    }
}
function shellQuote(value) {
    return `'${value.replace(/'/g, "'\\''")}'`;
}
function buildTrailerHookScript(originalPrepareCommitMsgAbsPath) {
    const forward = originalPrepareCommitMsgAbsPath
        ? `exec ${shellQuote(originalPrepareCommitMsgAbsPath)} "$@"`
        : 'exit 0';
    return [
        '#!/bin/sh',
        'if [ -z "$PICKLE_TICKET_ID" ]; then',
        `  ${forward}`,
        'fi',
        'if grep -q \'^Pickle-Ticket:\' "$1" 2>/dev/null; then',
        `  ${forward}`,
        'fi',
        'printf \'\\nPickle-Ticket: %s\\n\' "$PICKLE_TICKET_ID" >> "$1"',
        forward,
        '',
    ].join('\n');
}
function buildForwardingStubScript(originalAbsPath) {
    return ['#!/bin/sh', `exec ${shellQuote(originalAbsPath)} "$@"`, ''].join('\n');
}
function writeExecutableScript(filePath, contents) {
    fs.writeFileSync(filePath, contents);
    fs.chmodSync(filePath, 0o755);
}
/**
 * Materializes the managed hooks directory. Never throws — every git/fs
 * failure collapses into `{ok:false, reason}`. Writes only inside
 * `opts.managedDir`; never touches `opts.repoRoot` or `opts.repoRoot/.git/**`.
 */
export function materializeTrailerHooks(opts) {
    const preExistingDir = resolvePreExistingHooksDir(opts.repoRoot);
    if (!preExistingDir) {
        return { ok: false, reason: 'pre-existing hooks dir unresolvable' };
    }
    try {
        fs.mkdirSync(opts.managedDir, { recursive: true });
        const originalPrepareCommitMsg = path.join(preExistingDir, 'prepare-commit-msg');
        const hasOriginalPrepareCommitMsg = isExecutableFile(originalPrepareCommitMsg);
        writeExecutableScript(path.join(opts.managedDir, 'prepare-commit-msg'), buildTrailerHookScript(hasOriginalPrepareCommitMsg ? originalPrepareCommitMsg : null));
        for (const hookName of listForwardableHooks(preExistingDir)) {
            writeExecutableScript(path.join(opts.managedDir, hookName), buildForwardingStubScript(path.join(preExistingDir, hookName)));
        }
        return { ok: true, managedDir: opts.managedDir };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: msg };
    }
}

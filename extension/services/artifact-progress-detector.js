import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
export const NO_PROGRESS_WINDOW_ENV = 'PICKLE_TIMEOUT_NO_PROGRESS_WINDOW_SECONDS';
export const NO_PROGRESS_WINDOW_DEFAULT_S = 1500;
export function resolveNoProgressWindowSeconds(env) {
    const envSource = env ?? process.env;
    const raw = envSource[NO_PROGRESS_WINDOW_ENV];
    if (!raw)
        return NO_PROGRESS_WINDOW_DEFAULT_S;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0)
        return NO_PROGRESS_WINDOW_DEFAULT_S;
    return parsed;
}
export function getLatestArtifactMtime(ticketDir) {
    let latest = 0;
    try {
        const entries = fs.readdirSync(ticketDir);
        for (const entry of entries) {
            if (!entry.endsWith('.md'))
                continue;
            try {
                const mtimeSec = Math.floor(fs.statSync(path.join(ticketDir, entry)).mtimeMs / 1000);
                if (mtimeSec > latest)
                    latest = mtimeSec;
            }
            catch { /* skip unreadable */ }
        }
    }
    catch { /* dir missing or unreadable */ }
    return latest;
}
/**
 * AP-EXT-ITER312-01: each spec is anchored at the repo ROOT with git's `:(top)` pathspec
 * magic, so the probe reads the same PATH SPACE the specs were written in from any cwd.
 * `allowed_paths` is repo-root-relative (R-RSBI-2) while `workingDir` is an unnormalized
 * `process.cwd()` (`setup.ts`) never reconciled to `--show-toplevel`, and a git pathspec
 * resolves against the SPAWN's cwd — so one directory below the toplevel a bare
 * `extension/src` asks for `extension/extension/src`. A pathspec miss is reported as exit 0
 * with EMPTY stdout, so the `status !== 0` guard below cannot see it: the probe fabricates
 * `null`, `detectArtifactProgress`'s commit arm reads false over real committed work, and
 * `probeTimeoutArtifactProgress` votes no-progress on a producing worker. `:(top)` buys the
 * root anchor with no resolver, no extra spawn and no new branch — the same subtraction
 * AP-EXT-ITER311-01 made in `microverse-runner.ts:computeTouchedLineNumbers`, rather than a
 * sixth hand-copied `--show-toplevel` resolver.
 *
 * AP-EXT-ITER313-01: the return is a READING, not a sha, because git declining to answer and
 * git answering "no commit" are different facts and the single `string | null` collapsed them.
 * MEASURED: a non-repo `workingDir` exits 128, an absent git binary gives `status: null` +
 * `error: ENOENT`, and the 10s cap gives `status: null` + `error: ETIMEDOUT` — while a genuine
 * empty window is `status: 0` with EMPTY stdout, so `status === 0 && !error` is the exact
 * discriminator. The old `(result.status ?? 1) !== 0 || !result.stdout` mapped all four onto
 * `null`; the consumer then voted no-progress, `routeTimeoutNoProgress` stamped
 * `ticket_timeout_halted_no_progress`, and the loop `break`s with `exit_reason: timeout_repeat`
 * — the WHOLE run ended on an unanswered probe. The mtime arm cannot cover for it:
 * `getLatestArtifactMtime` counts only `.md`, which the Implement phase does not write, so
 * during Implement this probe is the only progress signal. Halting on UNKNOWN is the false-halt
 * the root CLAUDE.md forbids; the `|| !result.stdout` disjunct is GONE rather than guarded, so
 * the empty-window case has exactly one reading site.
 */
export function getLatestCommitInScope(workingDir, sinceSeconds, scopeJsonPath) {
    const pathSpecs = [];
    if (scopeJsonPath) {
        try {
            const raw = JSON.parse(fs.readFileSync(scopeJsonPath, 'utf-8'));
            if (Array.isArray(raw?.allowed_paths)) {
                for (const p of raw.allowed_paths) {
                    if (typeof p === 'string')
                        pathSpecs.push(`:(top)${p}`);
                }
            }
        }
        catch { /* scope.json absent or malformed — run unscoped */ }
    }
    const args = ['log', `--since=${sinceSeconds} seconds ago`, '--oneline', '--no-merges'];
    if (pathSpecs.length > 0)
        args.push('--', ...pathSpecs);
    const result = spawnSync('git', args, {
        cwd: workingDir,
        encoding: 'utf-8',
        timeout: 10_000,
    });
    if (result.error || result.status !== 0)
        return { measured: false, sha: null };
    const lines = (result.stdout ?? '').trim().split('\n').filter(Boolean);
    return { measured: true, sha: lines.length === 0 ? null : (lines[0].split(' ')[0] ?? null) };
}
export function detectArtifactProgress(ticketDir, lastSnapshot, opts) {
    const windowSeconds = opts?.windowSeconds ?? resolveNoProgressWindowSeconds(opts?.env);
    const latestMtimeEpoch = getLatestArtifactMtime(ticketDir);
    const reading = getLatestCommitInScope(opts?.workingDir ?? process.cwd(), windowSeconds, opts?.scopeJsonPath);
    // AP-EXT-ITER313-01: an unanswered probe carries the prior sha forward rather than
    // publishing a fabricated `null` — the `?? prev` convention `mux-runner.ts`'s scoped
    // source-state signature already uses for the same git-declined states.
    const latestCommitSha = reading.measured ? reading.sha : lastSnapshot.latestCommitSha;
    const progressed = !reading.measured ||
        latestMtimeEpoch > lastSnapshot.latestMtimeEpoch ||
        (latestCommitSha !== null && latestCommitSha !== lastSnapshot.latestCommitSha);
    return { progressed, latestMtimeEpoch, latestCommitSha, commitProbeMeasured: reading.measured };
}

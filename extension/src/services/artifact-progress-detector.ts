import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

export interface ArtifactProgressSnapshot {
  latestMtimeEpoch: number;
  latestCommitSha: string | null;
}

export interface ArtifactProgressResult {
  progressed: boolean;
  latestMtimeEpoch: number;
  latestCommitSha: string | null;
}

export const NO_PROGRESS_WINDOW_ENV = 'PICKLE_TIMEOUT_NO_PROGRESS_WINDOW_SECONDS';
export const NO_PROGRESS_WINDOW_DEFAULT_S = 1500;

export function resolveNoProgressWindowSeconds(env?: NodeJS.ProcessEnv): number {
  const envSource = env ?? process.env;
  const raw = envSource[NO_PROGRESS_WINDOW_ENV];
  if (!raw) return NO_PROGRESS_WINDOW_DEFAULT_S;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return NO_PROGRESS_WINDOW_DEFAULT_S;
  return parsed;
}

export function getLatestArtifactMtime(ticketDir: string): number {
  let latest = 0;
  try {
    const entries = fs.readdirSync(ticketDir);
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      try {
        const mtimeSec = Math.floor(fs.statSync(path.join(ticketDir, entry)).mtimeMs / 1000);
        if (mtimeSec > latest) latest = mtimeSec;
      } catch { /* skip unreadable */ }
    }
  } catch { /* dir missing or unreadable */ }
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
 */
export function getLatestCommitInScope(
  workingDir: string,
  sinceSeconds: number,
  scopeJsonPath?: string,
): string | null {
  const pathSpecs: string[] = [];
  if (scopeJsonPath) {
    try {
      const raw = JSON.parse(fs.readFileSync(scopeJsonPath, 'utf-8'));
      if (Array.isArray(raw?.allowed_paths)) {
        for (const p of raw.allowed_paths) {
          if (typeof p === 'string') pathSpecs.push(`:(top)${p}`);
        }
      }
    } catch { /* scope.json absent or malformed — run unscoped */ }
  }

  const args = ['log', `--since=${sinceSeconds} seconds ago`, '--oneline', '--no-merges'];
  if (pathSpecs.length > 0) args.push('--', ...pathSpecs);

  const result = spawnSync('git', args, {
    cwd: workingDir,
    encoding: 'utf-8',
    timeout: 10_000,
  });

  if ((result.status ?? 1) !== 0 || !result.stdout) return null;
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  if (lines.length === 0) return null;
  return lines[0].split(' ')[0] ?? null;
}

export interface DetectArtifactProgressOpts {
  workingDir?: string;
  scopeJsonPath?: string;
  windowSeconds?: number;
  env?: NodeJS.ProcessEnv;
}

export function detectArtifactProgress(
  ticketDir: string,
  lastSnapshot: ArtifactProgressSnapshot,
  opts?: DetectArtifactProgressOpts,
): ArtifactProgressResult {
  const windowSeconds = opts?.windowSeconds ?? resolveNoProgressWindowSeconds(opts?.env);
  const latestMtimeEpoch = getLatestArtifactMtime(ticketDir);
  const latestCommitSha = getLatestCommitInScope(
    opts?.workingDir ?? process.cwd(),
    windowSeconds,
    opts?.scopeJsonPath,
  );

  const progressed =
    latestMtimeEpoch > lastSnapshot.latestMtimeEpoch ||
    (latestCommitSha !== null && latestCommitSha !== lastSnapshot.latestCommitSha);

  return { progressed, latestMtimeEpoch, latestCommitSha };
}

// B-LANES WS-3: the filesystem and git half of an anatomy-park lane session.
//
// A lane session is a SIBLING of the parent session directory
// (`<data>/sessions/<session>--lane-<n>/`) holding its own worktree at `<lane>/wt`.
// Nothing here writes lane `state.json`: seeding belongs to the phase runner
// (`createLaneSession` in `bin/pipeline-runner.ts`).
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { laneAdmits } from './scope-resolver.js';
import { GIT_CONFIG_COUNT_ENV_VAR } from './pickle-utils.js';
import { UNBOUNDED_READ_MAX_BUFFER } from '../types/index.js';
const LANE_GIT_TIMEOUT_MS = 60_000;
const NO_GENERATED = new Set();
/** Lanes map to sessions by sibling directory, never by joining the lane NAME into a path. */
export function laneSessionDir(parentSessionDir, index) {
    return `${path.resolve(parentSessionDir)}--lane-${index}`;
}
export function laneBranchName(parentSessionDir, index) {
    return `pickle-lane/${path.basename(path.resolve(parentSessionDir))}/${index}`;
}
function realpathOrResolve(p) {
    try {
        return fs.realpathSync(p);
    }
    catch {
        return path.resolve(p);
    }
}
function isInside(child, parent) {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
/**
 * `git worktree add -b <branch> <worktree> <sha>` from `repoRoot`. Refuses a worktree
 * inside the repository: a worktree there is untracked content in the checkout it
 * was meant to leave alone.
 */
export function createLaneWorktree(repoRoot, worktree, branch, sha) {
    const placement = path.join(realpathOrResolve(path.dirname(worktree)), path.basename(worktree));
    if (isInside(placement, realpathOrResolve(repoRoot))) {
        throw new Error(`lane worktree ${worktree} is inside the target repository ${repoRoot}`);
    }
    execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '-q', '-b', branch, worktree, sha], {
        timeout: LANE_GIT_TIMEOUT_MS,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}
function isDirectory(p) {
    try {
        return fs.statSync(p).isDirectory();
    }
    catch {
        return false;
    }
}
/**
 * Lane workers never install: every `node_modules` the main checkout has at its root or
 * one level down is symlinked into the same place in the worktree. Returns the links made.
 */
export function symlinkLaneNodeModules(repoRoot, worktree) {
    const linked = [];
    for (const rel of ['', ...fs.readdirSync(repoRoot)]) {
        const source = path.join(repoRoot, rel, 'node_modules');
        const destParent = path.join(worktree, rel);
        const dest = path.join(destParent, 'node_modules');
        if (!isDirectory(source) || !isDirectory(destParent) || fs.existsSync(dest))
            continue;
        fs.symlinkSync(source, dest, 'dir');
        linked.push(dest);
    }
    return linked;
}
/**
 * Repo-relative files at `sha` that `lane` admits: the lane `dir` minus its `excludes`.
 * Generated mirrors stay editable, so no generated set is applied.
 */
export function laneAllowedPaths(repoRoot, target, lane, sha) {
    const out = execFileSync('git', ['-C', repoRoot, 'ls-tree', '-r', '-z', '--name-only', sha], {
        timeout: LANE_GIT_TIMEOUT_MS,
        encoding: 'utf-8',
        maxBuffer: UNBOUNDED_READ_MAX_BUFFER,
    });
    const targetRel = path.relative(realpathOrResolve(repoRoot), realpathOrResolve(target)).split(path.sep).join('/');
    return out.split('\0')
        .filter((repoRel) => repoRel !== '')
        .filter((repoRel) => {
        const rel = targetRel === '' ? repoRel : path.posix.relative(targetRel, repoRel);
        return !rel.startsWith('..') && laneAdmits(lane, rel, NO_GENERATED);
    })
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
export function buildLaneScope(allowedPaths, sha) {
    return {
        version: 1,
        mode: 'paths',
        strategy: 'strict',
        base_ref: null,
        base_sha: sha,
        head_sha: sha,
        allowed_paths: allowedPaths,
        resolved_at: new Date().toISOString(),
        refresh_history: [],
    };
}
/**
 * Env for a lane runner and every worker under it: hooks resolve the LANE state, and
 * git never starts a foreground gc in a lane. The gc pair is appended at the inherited
 * `GIT_CONFIG_COUNT`, so it composes with the trailer-hooks pair workers add on top.
 */
export function laneRunnerEnv(statePath, inherited = process.env) {
    const count = Number(inherited[GIT_CONFIG_COUNT_ENV_VAR]);
    const n = Number.isFinite(count) && Number.isInteger(count) && count >= 0 ? count : 0;
    return {
        PICKLE_STATE_FILE: statePath,
        [GIT_CONFIG_COUNT_ENV_VAR]: String(n + 1),
        [`GIT_CONFIG_KEY_${n}`]: 'gc.auto',
        [`GIT_CONFIG_VALUE_${n}`]: '0',
    };
}

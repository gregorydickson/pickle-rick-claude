// B-LANES WS-3: the filesystem and git half of an anatomy-park lane session.
//
// A lane session is a SIBLING of the parent session directory
// (`<data>/sessions/<session>--lane-<n>/`) holding its own worktree at `<lane>/wt`.
// Nothing here writes lane `state.json`: seeding belongs to the phase runner
// (`createLaneSession` in `bin/pipeline-runner.ts`).
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { laneAdmits, type LaneRecord, type ScopeJson } from './scope-resolver.js';
import { GIT_CONFIG_COUNT_ENV_VAR } from './pickle-utils.js';
import { detectProjectType, isUnrunnableCheckResult, loadGateCommands } from './convergence-gate.js';
import { resetToSha } from './git-utils.js';
import { UNBOUNDED_READ_MAX_BUFFER } from '../types/index.js';

const LANE_GIT_TIMEOUT_MS = 60_000;
const NO_GENERATED: ReadonlySet<string> = new Set();

function laneGit(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    timeout: LANE_GIT_TIMEOUT_MS,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: UNBOUNDED_READ_MAX_BUFFER,
  }).trim();
}

function laneGitOk(cwd: string, args: string[]): boolean {
  try {
    laneGit(cwd, args);
    return true;
  } catch {
    return false;
  }
}

/** Lanes map to sessions by sibling directory, never by joining the lane NAME into a path. */
export function laneSessionDir(parentSessionDir: string, index: number): string {
  return `${path.resolve(parentSessionDir)}--lane-${index}`;
}

function sessionBranchPrefix(sessionDir: string): string {
  return `pickle-lane/${path.basename(path.resolve(sessionDir))}/`;
}

export function laneBranchName(parentSessionDir: string, index: number): string {
  return `${sessionBranchPrefix(parentSessionDir)}${index}`;
}

function realpathOrResolve(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * `git worktree add -b <branch> <worktree> <sha>` from `repoRoot`. Refuses a worktree
 * inside the repository: a worktree there is untracked content in the checkout it
 * was meant to leave alone.
 */
export function createLaneWorktree(repoRoot: string, worktree: string, branch: string, sha: string): void {
  const placement = path.join(realpathOrResolve(path.dirname(worktree)), path.basename(worktree));
  if (isInside(placement, realpathOrResolve(repoRoot))) {
    throw new Error(`lane worktree ${worktree} is inside the target repository ${repoRoot}`);
  }
  laneGit(repoRoot, ['worktree', 'add', '-q', '-b', branch, worktree, sha]);
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Lane workers never install: every `node_modules` the main checkout has at its root or
 * one level down is symlinked into the same place in the worktree. Returns the links made.
 */
export function symlinkLaneNodeModules(repoRoot: string, worktree: string): string[] {
  const linked: string[] = [];
  for (const rel of ['', ...fs.readdirSync(repoRoot)]) {
    const source = path.join(repoRoot, rel, 'node_modules');
    const destParent = path.join(worktree, rel);
    const dest = path.join(destParent, 'node_modules');
    if (!isDirectory(source) || !isDirectory(destParent) || fs.existsSync(dest)) continue;
    fs.symlinkSync(source, dest, 'dir');
    linked.push(dest);
  }
  return linked;
}

/**
 * Repo-relative files at `sha` a `lane` worker may commit: the lane `dir` minus its
 * `excludes`, plus every `generated` file (target-relative). Generated output belongs to
 * no lane, yet the compiler rewrites it from sources that do — a `src/` lane's mirror
 * lives outside its `dir` and must still ride its commit.
 */
export function laneAllowedPaths(
  repoRoot: string,
  target: string,
  lane: LaneRecord,
  sha: string,
  generated: ReadonlySet<string> = NO_GENERATED,
): string[] {
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
      return !rel.startsWith('..') && (generated.has(rel) || laneAdmits(lane, rel, NO_GENERATED));
    })
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function buildLaneScope(allowedPaths: string[], sha: string): ScopeJson {
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
export function laneRunnerEnv(statePath: string, inherited: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const count = Number(inherited[GIT_CONFIG_COUNT_ENV_VAR]);
  const n = Number.isFinite(count) && Number.isInteger(count) && count >= 0 ? count : 0;
  return {
    PICKLE_STATE_FILE: statePath,
    [GIT_CONFIG_COUNT_ENV_VAR]: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: 'gc.auto',
    [`GIT_CONFIG_VALUE_${n}`]: '0',
  };
}

/** The inverse of `laneSessionDir`: a lane session is named `<parent>--lane-<n>`. */
export function isLaneSessionDir(sessionDir: string): boolean {
  return /--lane-\d+$/.test(path.basename(path.resolve(sessionDir)));
}

/**
 * Remove every lane worktree directory, then `git worktree prune`. Best-effort: the lane
 * BRANCH keeps any committed work, so a directory that will not go away costs a stale
 * checkout, never a lost commit. Returns the worktrees that could not be removed.
 */
export function removeLaneWorktrees(repoRoot: string, worktrees: readonly string[]): string[] {
  const failed = worktrees.filter((worktree) => !laneGitOk(repoRoot, ['worktree', 'remove', '--force', worktree]));
  laneGitOk(repoRoot, ['worktree', 'prune']); // best-effort: a later prune catches it
  return failed;
}

/**
 * The ONE parent verdict over a lane roster: `converged` iff every lane's own reason is a
 * success, otherwise the first non-success reason in roster order.
 */
export function aggregateLaneExitReason(
  laneReasons: readonly string[],
  isSuccess: (reason: string) => boolean,
): string {
  return laneReasons.find((reason) => !isSuccess(reason)) ?? 'converged';
}

// ---------------------------------------------------------------------------
// Integration: finished lanes land on a disposable integration worktree; the main
// checkout only ever fast-forwards to it.
// ---------------------------------------------------------------------------

const LANE_TYPECHECK_TIMEOUT_MS = 300_000;
/** How long a kept `pickle-lane/*` branch survives before phase-start recovery deletes it. */
export const RETAINED_BRANCH_MAX_AGE_DAYS = 14;
const RETAINED_BRANCH_MAX_AGE_MS = RETAINED_BRANCH_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
const UNINTEGRATED_PREFIX = 'unintegrated-';

export type LaneIntegrationOutcome =
  | 'integrated' | 'conflict' | 'integration_red' | 'integration_ff_failed' | 'non_convergent' | 'cancelled';

/** One `archive/lanes.json` row. */
export interface LaneOutcome {
  name: string;
  dir: string;
  excludes: string[];
  branch: string;
  worktree: string;
  started_at: string | null;
  ended_at: string | null;
  passes: number;
  exit_reason: string;
  outcome: LaneIntegrationOutcome;
  commits: string[];
}

export function integrationBranchName(sessionDir: string): string {
  return `${sessionBranchPrefix(sessionDir)}integration`;
}

export function integrationWorktreeDir(sessionDir: string): string {
  return `${path.resolve(sessionDir)}--integration`;
}

/**
 * The target's typecheck, from the gate's ONE toolchain table: the target itself when it
 * is a project, else each immediate child that is one (this repo: `extension/`).
 */
function typecheckCommands(dir: string): { cwd: string; command: string }[] {
  let table: ReturnType<typeof loadGateCommands>;
  try {
    table = loadGateCommands();
  } catch {
    return [];
  }
  const commandFor = (cwd: string): { cwd: string; command: string } | null => {
    const type = detectProjectType(cwd);
    const command = type === null ? undefined : table[type]?.typecheck;
    return command ? { cwd, command } : null;
  };
  const own = commandFor(dir);
  if (own !== null) return [own];
  let children: fs.Dirent[];
  try {
    children = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return children
    .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
    .map((e) => commandFor(path.join(dir, e.name)))
    .filter((c): c is { cwd: string; command: string } => c !== null);
}

/**
 * `red` only on a typecheck that RAN and failed. A command the gate's own classifier calls
 * unrunnable (missing script, not installed, killed) measured nothing, so it cannot red a lane.
 */
export function runIntegrationTypecheck(dir: string): 'green' | 'red' | 'unavailable' {
  let ran = false;
  for (const { cwd, command } of typecheckCommands(dir)) {
    const r = spawnSync('sh', ['-c', command], {
      cwd,
      encoding: 'utf-8',
      timeout: LANE_TYPECHECK_TIMEOUT_MS,
      maxBuffer: UNBOUNDED_READ_MAX_BUFFER,
    });
    const result = { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status };
    if (isUnrunnableCheckResult(result)) continue;
    if (result.exitCode !== 0) return 'red';
    ran = true;
  }
  return ran ? 'green' : 'unavailable';
}

function laneCommits(repoRoot: string, phaseStartSha: string, branch: string): string[] {
  try {
    return laneGit(repoRoot, ['rev-list', '--reverse', `${phaseStartSha}..${branch}`]).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export interface IntegrateLanesInput {
  repoRoot: string;
  target: string;
  sessionDir: string;
  phaseStartSha: string;
  /** Roster order. `integrate: false` lanes are neither picked nor given an outcome here. */
  lanes: readonly { branch: string; integrate: boolean }[];
  log: (msg: string) => void;
}

export interface IntegrateLanesResult {
  outcomes: (LaneIntegrationOutcome | null)[];
  commits: string[][];
}

type PickOutcome = 'integrated' | 'conflict' | 'integration_red';

/** Pick one lane onto the integration worktree; anything short of green leaves it where it was. */
function pickLane(worktree: string, targetDir: string, commits: string[], preserve: string[], log: (msg: string) => void): PickOutcome {
  const before = laneGit(worktree, ['rev-parse', 'HEAD']);
  const picked = commits.every((sha) => laneGitOk(worktree, ['-c', 'gc.auto=0', '-c', 'commit.gpgsign=false', 'cherry-pick', sha]));
  if (!picked) laneGitOk(worktree, ['cherry-pick', '--abort']);
  const check = picked ? runIntegrationTypecheck(targetDir) : 'unavailable';
  if (picked && check === 'unavailable') log('anatomy lanes: integration_check: unavailable — accepting the lane');
  if (picked && check !== 'red') return 'integrated';
  // A partial pick (commit k+1 of n conflicted) or a red check: undo the whole lane — here only.
  resetToSha(before, worktree, preserve);
  return picked ? 'integration_red' : 'conflict';
}

/**
 * B-LANES WS-3: cherry-pick every lane that asked to integrate, in roster order, onto
 * `pickle-lane/<session>/integration` created from `phaseStartSha` in a disposable worktree.
 * A conflict aborts the pick (`conflict`); a red typecheck resets the INTEGRATION worktree
 * (`integration_red`). The main checkout moves once, by `merge --ff-only`; if that fails every
 * lane it would have carried is `integration_ff_failed`. The main checkout is never reset,
 * cleaned or left mid-pick. Never throws.
 */
export function integrateLanes(input: IntegrateLanesInput): IntegrateLanesResult {
  const { repoRoot, sessionDir, phaseStartSha, log } = input;
  const commits = input.lanes.map((lane) => (lane.integrate ? laneCommits(repoRoot, phaseStartSha, lane.branch) : []));
  const outcomes: (LaneIntegrationOutcome | null)[] = input.lanes.map((lane) => (lane.integrate ? 'integrated' : null));
  if (!commits.some((c) => c.length > 0)) return { outcomes, commits };

  const worktree = integrationWorktreeDir(sessionDir);
  const branch = integrationBranchName(sessionDir);
  const carried = (i: number): boolean => outcomes[i] === 'integrated' && commits[i].length > 0;
  try {
    createLaneWorktree(repoRoot, worktree, branch, phaseStartSha);
    const preserve = symlinkLaneNodeModules(repoRoot, worktree).map((link) => path.relative(worktree, link));
    const targetDir = path.join(worktree, path.relative(realpathOrResolve(repoRoot), realpathOrResolve(input.target)));
    commits.forEach((laneCommitList, i) => {
      if (laneCommitList.length > 0) outcomes[i] = pickLane(worktree, targetDir, laneCommitList, preserve, log);
    });
    if (outcomes.some((_, i) => carried(i)) && !laneGitOk(repoRoot, ['merge', '--ff-only', '-q', branch])) {
      log(`anatomy lanes: main checkout could not fast-forward to ${branch} — lane branches kept`);
      outcomes.forEach((_, i) => { if (carried(i)) outcomes[i] = 'integration_ff_failed'; });
    }
  } catch (err) {
    log(`anatomy lanes: integration failed: ${err instanceof Error ? err.message : String(err)} — lane branches kept`);
    outcomes.forEach((_, i) => { if (carried(i)) outcomes[i] = 'integration_ff_failed'; });
  } finally {
    removeLaneWorktrees(repoRoot, [worktree]);
  }
  return { outcomes, commits };
}

function branchExists(repoRoot: string, branch: string): boolean {
  return laneGitOk(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
}

/**
 * Delete lane branches with `git branch -d` only, so a branch goes only once main reaches it.
 * A cherry-picked lane's own commits are never ancestors of main, so an `integrated` lane's ref
 * is first moved to main's HEAD — but only when `git cherry` proves every one of its commits
 * already has a patch-equivalent there. Returns the branches that survive (retained).
 */
export function releaseLaneBranches(
  repoRoot: string,
  sessionDir: string,
  branches: readonly string[],
  integrated: ReadonlySet<string>,
): { deleted: string[]; retained: string[] } {
  const deleted: string[] = [];
  const retained: string[] = [];
  for (const branch of [...branches, integrationBranchName(sessionDir)]) {
    if (!branchExists(repoRoot, branch)) continue;
    if (integrated.has(branch)) {
      let landed = false;
      try {
        landed = !laneGit(repoRoot, ['cherry', 'HEAD', branch]).split('\n').some((l) => l.startsWith('+'));
      } catch { /* unprovable → keep the branch where it is */ }
      if (landed) laneGitOk(repoRoot, ['branch', '-f', branch, 'HEAD']);
    }
    (laneGitOk(repoRoot, ['branch', '-d', branch]) ? deleted : retained).push(branch);
  }
  return { deleted, retained };
}

function registeredWorktrees(repoRoot: string): string[] {
  try {
    return laneGit(repoRoot, ['worktree', 'list', '--porcelain']).split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length));
  } catch {
    return [];
  }
}

export interface LaneRecoveryReport {
  /** This session's lane branches a previous run left unintegrated — reported, never integrated. */
  unintegrated: string[];
  /** Retained `pickle-lane/*` branches past RETAINED_BRANCH_MAX_AGE_DAYS, deleted. */
  expired: string[];
  /** Worktrees of this session's lane/integration dirs a previous run left registered. */
  staleWorktrees: string[];
}

/**
 * Phase-start recovery. A crashed run leaves lane worktrees registered and lane branches
 * behind; the relaunch would collide with both. Stale worktrees are removed and pruned. A
 * surviving lane branch main already reaches goes by `-d`; any other is renamed aside to
 * `pickle-lane/<session>/unintegrated-<ms>-<leaf>` and reported. Retained branches older than
 * RETAINED_BRANCH_MAX_AGE_DAYS (tip commit) are deleted, with a report.
 */
export function recoverLaneBranches(repoRoot: string, sessionDir: string, nowMs: number = Date.now()): LaneRecoveryReport {
  const ownDirPrefix = `${realpathOrResolve(sessionDir)}--`;
  const staleWorktrees = registeredWorktrees(repoRoot).filter((wt) => realpathOrResolve(wt).startsWith(ownDirPrefix));
  removeLaneWorktrees(repoRoot, staleWorktrees);

  const report: LaneRecoveryReport = { unintegrated: [], expired: [], staleWorktrees };
  let refs: string[] = [];
  try {
    refs = laneGit(repoRoot, ['for-each-ref', '--format=%(refname:short)%09%(committerdate:unix)', 'refs/heads/pickle-lane/'])
      .split('\n').filter(Boolean);
  } catch { /* no refs readable → nothing to recover */ }
  const prefix = sessionBranchPrefix(sessionDir);
  for (const ref of refs) {
    const [branch, unix] = ref.split('\t');
    if (nowMs - Number(unix) * 1000 > RETAINED_BRANCH_MAX_AGE_MS && laneGitOk(repoRoot, ['branch', '-D', branch])) {
      report.expired.push(branch);
      continue;
    }
    if (!branch.startsWith(prefix) || laneGitOk(repoRoot, ['branch', '-d', branch])) continue;
    const leaf = branch.slice(prefix.length);
    const aside = leaf.startsWith(UNINTEGRATED_PREFIX) ? branch : `${prefix}${UNINTEGRATED_PREFIX}${nowMs}-${leaf}`;
    if (aside === branch || laneGitOk(repoRoot, ['branch', '-m', branch, aside])) report.unintegrated.push(aside);
    else report.unintegrated.push(branch);
  }
  return report;
}

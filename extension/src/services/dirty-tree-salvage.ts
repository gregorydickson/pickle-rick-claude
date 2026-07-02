/**
 * B-1SEAM WS-3 (R-MACB): the ONE shared dirty-tree salvage seam.
 *
 * Both runtime rescue paths — mux-runner's exit-path committer
 * (`commitGatePassingDeliverableOnExitPath`) and microverse-runner's
 * worker-timeout rescue (`autoRescueDirtyTree`) plus its preflight — route
 * their staging decisions through this module. Ownership POLICY (which dirty
 * paths count as "owned") stays at the call sites because it genuinely differs
 * (ticket-dir prefixes vs docs/prds excludes + scope.json); the safety
 * MECHANISM is single-implementation here: never whole-tree-add over foreign
 * dirt, anchor the un-attributable remainder to a recoverable ref, and stage
 * owned paths one-by-one. No `git add -A`/`-u` exists in this module outside
 * the throwaway-index stash.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync, execFileSync } from 'child_process';
import { safeErrorMessage } from './pickle-utils.js';

/**
 * B-PCOMP (#b736337f): preserve un-attributable gate-green remainder at phase exit
 * WITHOUT committing it as the exiting ticket's Done and WITHOUT mutating the
 * working tree or `state.json`.
 *
 * We snapshot the entire dirty working tree (tracked modifications AND untracked
 * files) into a dangling git commit using a TEMPORARY index file — `GIT_INDEX_FILE`
 * pointed at a throwaway path — so neither the real index nor the worktree is
 * mutated (the caller can still stage and commit only the positively-owned paths
 * afterward). `git stash create` is unsuitable because it cannot include untracked
 * files and would miss a sibling's brand-new artifacts. We then anchor the snapshot
 * under `refs/pickle/salvage/<session>` so an operator can recover the remainder via
 * `git show refs/pickle/salvage/<session>`. The ref lives entirely in git's
 * object/ref store — no `state.json` write — keeping the exit path schema-neutral
 * (avoids R-WSRC).
 *
 * Returns the ref name on success, or null when the tree had nothing to snapshot or
 * any git step failed (best-effort: losing the breadcrumb must never crash exit).
 */
export function stashUnattributableRemainder(
  workingDir: string,
  sessionDir: string,
  log: (msg: string) => void,
): string | null {
  let tmpIndex: string | null = null;
  try {
    const session = path.basename(sessionDir);
    const ref = `refs/pickle/salvage/${session}`;
    // Throwaway index so `git add` does not touch the real index/worktree.
    tmpIndex = path.join(os.tmpdir(), `pickle-salvage-index-${process.pid}-${Date.now()}`);
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    // `git <args>` against workingDir; returns trimmed stdout on success, null on failure.
    const git = (args: string[], useEnv: boolean): string | null => {
      const r = spawnSync('git', ['-C', workingDir, ...args], { encoding: 'utf-8', timeout: 30000, ...(useEnv ? { env } : {}) });
      return r.status === 0 ? (r.stdout ?? '').trim() : null;
    };
    // Seed the temp index from HEAD, then stage the full dirty tree (tracked + untracked).
    if (git(['read-tree', 'HEAD'], true) === null) return null;
    if (git(['add', '-A'], true) === null) return null;
    const tree = git(['write-tree'], true);
    if (!tree) return null;
    if (git(['rev-parse', 'HEAD^{tree}'], false) === tree) return null; // no diff from HEAD — nothing to anchor
    const sha = git(['commit-tree', tree, '-p', 'HEAD', '-m', `pickle exit-path bystander salvage (${session})`], true);
    if (!sha) return null;
    if (git(['update-ref', ref, sha], false) === null) {
      log(`[exit-commit] failed to anchor bystander stash at ${ref}`);
      return null;
    }
    log(`[exit-commit] stashed un-attributable remainder to ${ref} (${sha.slice(0, 12)})`);
    return ref;
  } catch (err) {
    log(`[exit-commit] bystander stash threw (ignored): ${safeErrorMessage(err)}`);
    return null;
  } finally {
    if (tmpIndex) { try { fs.rmSync(tmpIndex, { force: true }); } catch { /* best-effort */ } }
  }
}

export interface SalvageDirtyTreeInput {
  workingDir: string;
  sessionDir: string;
  /** Dirty paths positively attributable to the caller's session/ticket — the ONLY stageable set. */
  owned: readonly string[];
  /** Un-attributable (bystander) dirty paths — anchored to the salvage ref, never staged. */
  foreign: readonly string[];
  log: (msg: string) => void;
}

export interface SalvageDirtyTreePlan {
  /** Always equals `owned` — the caller may stage nothing else. */
  stagePaths: string[];
  /** The anchored salvage ref when foreign dirt was present, else null. */
  salvageRef: string | null;
}

/**
 * The invariant enforcer: when the partitioned dirty tree carries ANY foreign
 * paths, the whole dirty tree is snapshotted to `refs/pickle/salvage/<session>`
 * (recoverable, worktree/index untouched) and ONLY the owned set is returned
 * as stageable. A foreign-free tree passes through untouched (no ref).
 */
export function salvageDirtyTree(input: SalvageDirtyTreeInput): SalvageDirtyTreePlan {
  const { workingDir, sessionDir, owned, foreign, log } = input;
  let salvageRef: string | null = null;
  if (foreign.length > 0) {
    salvageRef = stashUnattributableRemainder(workingDir, sessionDir, log);
    log(`[dirty-tree-salvage] ${foreign.length} un-attributable dirty path(s) anchored to ${salvageRef ?? 'no ref (best-effort stash failed)'} — staging ${owned.length} owned path(s) only`);
  }
  return { stagePaths: [...owned], salvageRef };
}

/**
 * Stage exactly `paths`, one per-path `git add -- <p>` (never a whole-tree
 * `add -A`/`-u`). Handles new, modified, AND deleted tracked files (`git add`
 * records a deletion). Rename caveat: the porcelain parser
 * (`git-utils.ts:listWorkingTreeDirtyPaths`) surfaces only the NEW path of a
 * rename, so a rename staged from that output commits as a copy (deletion-half
 * left unstaged) — parity with the pre-WS-3 scoped preflight; callers wanting
 * a true move must feed both rename halves.
 */
export function stageOwnedPaths(workingDir: string, paths: readonly string[]): void {
  for (const p of paths) {
    execFileSync('git', ['add', '--', p], {
      cwd: workingDir,
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
}

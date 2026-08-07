import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync, spawnSync } from 'child_process';
import { runCmd, extractFrontmatter, formatLocalDateKey } from './pickle-utils.js';
import { syncLinearTicketStatus } from './linear-integration.js';
import { writeActivityEntry } from './state-manager.js';
import { UNBOUNDED_READ_MAX_BUFFER } from '../types/index.js';
import type { PreResetPayload } from '../types/index.js';

export function runGit(cmd: string[], cwd?: string, check: boolean = true): string {
  return runCmd(['git', ...cmd], { cwd, check });
}

export function getGithubUser(): string {
  try {
    return runCmd(['gh', 'api', 'user', '-q', '.login']);
  } catch {
    try {
      return runCmd(['git', 'config', 'user.name']).replace(/\s+/g, '');
    } catch {
      return 'pickle-rick';
    }
  }
}

export function getBranchName(taskId: string): string {
  const user = getGithubUser();
  const lowerId = taskId.toLowerCase();
  const type = ['fix', 'bug', 'patch', 'issue'].some((x) => lowerId.includes(x)) ? 'fix' : 'feat';
  return `${user}/${type}/${taskId}`;
}

const MAX_TICKET_SEARCH_DEPTH = 10;
const GIT_CHECK_IGNORE_TIMEOUT_MS = 5_000;

function findTicketFile(sessionDir: string, ticketId: string): string | null {
  const fileName = `rick_ticket_${ticketId}.md`;
  const walk = (dir: string, depth: number): string | null => {
    if (depth > MAX_TICKET_SEARCH_DEPTH) return null; // symlink-cycle guard
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return null; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(fullPath); } catch { continue; } // lstat: don't follow symlinks
      if (stat.isDirectory()) {
        const hit = walk(fullPath, depth + 1);
        if (hit) return hit;
      } else if (entry === fileName) {
        return fullPath;
      }
    }
    return null;
  };
  return walk(sessionDir, 0);
}

function setFrontmatterField(frontmatterSection: string, key: string, value: string | null): string {
  const lineRe = new RegExp(`^${key}:.*$(\\r?\\n)?`, 'm');
  if (value === null) {
    return frontmatterSection.replace(lineRe, '');
  }
  if (lineRe.test(frontmatterSection)) {
    return frontmatterSection.replace(lineRe, `${key}: "${value}"$1`);
  }
  return frontmatterSection.replace(/\n---(\r?\n?)$/, `\n${key}: "${value}"\n---$1`);
}

export interface TicketFrontmatterPatch {
  status?: string;
  completion_commit?: string | null;
}

function validateTicketFrontmatterPatch(patch: TicketFrontmatterPatch): void {
  if (patch.status !== undefined && /["\n\r]/.test(patch.status)) {
    throw new Error('Invalid status value: must not contain quotes or newlines');
  }
  if (patch.completion_commit !== undefined && patch.completion_commit !== null && /["\n\r]/.test(patch.completion_commit)) {
    throw new Error('Invalid completion_commit value: must not contain quotes or newlines');
  }
}

function applyStatusAndUpdatedFields(
  content: string,
  ticketId: string,
  nextStatus: string | null,
  today: string
): { content: string; statusReplaced: boolean } {
  let statusReplaced = false;
  let nextContent = content;

  const hasFrontmatter = extractFrontmatter(nextContent) !== null;
  if (!hasFrontmatter) {
    console.warn(`Warning: ticket ${ticketId} has no valid YAML frontmatter — status replacement may be imprecise`);
  }

  if (nextStatus !== null && /^status:.*$/m.test(nextContent)) {
    nextContent = nextContent.replace(/^status:.*$/m, `status: "${nextStatus}"`);
    statusReplaced = true;
  }

  if (/^updated:.*$/m.test(nextContent)) {
    nextContent = nextContent.replace(/^updated:.*$/m, `updated: "${today}"`);
  } else if (hasFrontmatter) {
    nextContent = nextContent.replace(/\n---(\r?\n?)$/, `\nupdated: "${today}"\n---$1`);
  }

  return { content: nextContent, statusReplaced };
}

function applyCompletionCommitField(content: string, patch: TicketFrontmatterPatch): string {
  if (patch.completion_commit === undefined) return content;
  const updated = setFrontmatterField(content, 'completion_commit', patch.completion_commit);
  if (patch.completion_commit !== null) return updated;
  return setFrontmatterField(updated, 'completion_commit_inferred', null);
}

export function updateTicketFrontmatter(
  ticketId: string,
  sessionDir: string,
  patch: TicketFrontmatterPatch
): void {
  validateTicketFrontmatterPatch(patch);

  const ticketPath = findTicketFile(sessionDir, ticketId);
  if (!ticketPath) {
    throw new Error(`Ticket rick_ticket_${ticketId}.md not found in ${sessionDir}`);
  }

  const original = fs.readFileSync(ticketPath, 'utf-8');
  const today = formatLocalDateKey(new Date());
  const nextStatus = patch.status ?? null;
  const fm = extractFrontmatter(original);
  const baseContent = fm ? original.slice(0, fm.end) : original;
  const { content: updatedBase, statusReplaced } = applyStatusAndUpdatedFields(baseContent, ticketId, nextStatus, today);
  // Apply completion_commit to the frontmatter section ONLY. setFrontmatterField's
  // add-path fallback anchors on the closing `---` at end-of-string; that only holds
  // for the frontmatter slice. Running it against the full document (frontmatter + body)
  // leaves the closing `---` mid-string, so an absent completion_commit is silently
  // dropped — stamping `status: Done` with no completion evidence.
  const baseWithCompletion = applyCompletionCommitField(updatedBase, patch);
  const content = fm ? baseWithCompletion + original.slice(fm.end) : baseWithCompletion;

  if (nextStatus !== null && !statusReplaced) {
    console.warn(`Warning: no "status:" field found in ticket ${ticketId} — status not updated`);
  }

  const tmp = `${ticketPath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, ticketPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
    throw err;
  }
  if (statusReplaced) {
    console.log(`Successfully updated ticket ${ticketId} to status "${nextStatus}"`);
  }
  if (nextStatus !== null) {
    syncLinearTicketStatus(sessionDir, ticketId, nextStatus);
  }
}

export function updateTicketStatus(
  ticketId: string,
  newStatus: string,
  sessionDir: string
): void {
  updateTicketFrontmatter(ticketId, sessionDir, { status: newStatus });
}

export function getHeadSha(cwd: string): string {
  return runGit(['rev-parse', 'HEAD'], cwd).trim();
}

export function getHeadBranch(cwd: string): string | null {
  const result = runGit(['symbolic-ref', '--short', 'HEAD'], cwd, false).trim();
  return result || null;
}

function buildCleanArgs(preservePrefixes?: string[]): string[] {
  const args = ['clean', '-fd'];
  const cleanedPrefixes = normalizeExcludePrefixes(preservePrefixes);
  if (cleanedPrefixes.length === 0) return args;
  args.push('--', '.');
  for (const cleaned of cleanedPrefixes) {
    args.push(`:!${cleaned}`, `:!${cleaned}/**`);
  }
  return args;
}

function gitRealpathOrSelf(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

/** R-WSRC-4: assert cwd resolves under os.tmpdir() when PICKLE_TEST_MODE=1. No-op in production. */
function assertWorkingDirUnderTmpdirIfTestMode(cwd: string): void {
  if (process.env.PICKLE_TEST_MODE !== '1') return;
  const tmpdirRealpath = gitRealpathOrSelf(os.tmpdir());
  const resolved = gitRealpathOrSelf(cwd);
  const under = resolved === tmpdirRealpath || resolved.startsWith(tmpdirRealpath + path.sep);
  if (!under) throw new Error(
    `R-WSRC-4: PICKLE_TEST_MODE=1 but resetToSha cwd is outside os.tmpdir() (${tmpdirRealpath}): ${cwd}. ` +
    `Test fixtures must root working_dir under os.tmpdir() to prevent git mutations against the real repo.`,
  );
}

export function resetToSha(sha: string, cwd: string, preservePrefixes?: string[], archive?: ArchiveContext): void {
  assertWorkingDirUnderTmpdirIfTestMode(cwd);
  if (archive) archiveBeforeDestructive(archive);
  runGit(['reset', '--hard', sha], cwd);
  runGit(buildCleanArgs(preservePrefixes), cwd);
}

function normalizeExcludePrefixes(excludePrefixes?: string[]): string[] {
  if (!excludePrefixes || excludePrefixes.length === 0) return [];
  return excludePrefixes
    .map((prefix) => prefix.replace(/^\.?\/+/, '').replace(/\/+$/, ''))
    .filter((prefix) => prefix.length > 0);
}

function statusArgs(excludePrefixes?: string[]): string[] {
  const args = ['status', '--porcelain', '-z'];
  const cleanedPrefixes = normalizeExcludePrefixes(excludePrefixes);
  if (cleanedPrefixes.length > 0) {
    args.push('--', '.');
    for (const cleaned of cleanedPrefixes) {
      args.push(`:!${cleaned}`, `:!${cleaned}/**`);
    }
  }
  return args;
}

export function listWorkingTreeDirtyPaths(cwd: string, excludePrefixes?: string[]): string[] {
  const result = spawnSync('git', statusArgs(excludePrefixes), {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    // AP-EXT-ITER8-01: a whole-tree `status --porcelain -z` is unbounded; Node's 1 MB
    // default truncates it and this reader THROWS on the resulting ENOBUFS, taking
    // the salvage paths that call it down with a misleading empty-stderr message.
    maxBuffer: UNBOUNDED_READ_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`Command failed: git ${statusArgs(excludePrefixes).join(' ')}\nError: ${result.stderr || ''}`);
  }
  const output = result.stdout || '';
  if (!output) return [];

  const tokens = output.split('\0').filter((token) => token.length > 0);
  const paths: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length < 4) continue;
    paths.push(token.slice(3));
    const status = token.slice(0, 2);
    if (status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C') {
      index += 1;
    }
  }

  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

export function isGitIgnoredPath(cwd: string, filePath: string): boolean {
  const result = spawnSync('git', ['check-ignore', '--no-index', '--quiet', '--', filePath], {
    cwd,
    stdio: 'ignore',
    timeout: GIT_CHECK_IGNORE_TIMEOUT_MS,
  });
  return result.status === 0;
}

export function isWorkingTreeDirty(cwd: string, excludePrefixes?: string[]): boolean {
  return listWorkingTreeDirtyPaths(cwd, excludePrefixes).length > 0;
}

// ---------------------------------------------------------------------------
// Pre-destructive archival (H3 / CUJ-9)
// ---------------------------------------------------------------------------

const CODEGRAPH_DIR = '.codegraph';
export const ARCHIVE_UNTRACKED_BYTE_CAP = 10 * 1024 * 1024;
const ARCHIVE_GIT_TIMEOUT_MS = 30_000;
/**
 * The ONE pathspec tail that excludes the runtime's own regenerable codegraph index
 * from a whole-tree git operation. Exported so a staging site that legitimately needs
 * a whole-tree `add -A` (the Done-flip committer) honours the SAME exclusion the
 * archive and the dirty-path listers apply via `isCodegraphArtifact`.
 */
export const CODEGRAPH_PATHSPEC_EXCLUDES = ['--', '.', `:!${CODEGRAPH_DIR}`, `:!${CODEGRAPH_DIR}/**`];

/**
 * The one flag set every archive diff starts from — staged, unstaged, and per-file
 * untracked alike. `--binary` is load-bearing, not cosmetic: without it git emits a
 * contentless `Binary files a/x and b/x differ` stub, and `git apply` is ALL-OR-NOTHING,
 * so ONE such stub rejects the WHOLE patch — a single dirty binary file makes every
 * co-archived TEXT diff unrecoverable too, after `resetToSha` has already destroyed it.
 */
const ARCHIVE_DIFF_BASE = ['diff', '--binary'];

export type ArchiveReason = PreResetPayload['reason'];

export interface ArchiveContext {
  cwd: string;
  sessionDir: string;
  ticketDir?: string | null;
  reason: ArchiveReason;
}

export interface ArchiveResult {
  patchPath: string;
  files: string[];
  filesTruncated: boolean;
}

/** Archive write failed; callers MUST abort the destructive op (fail-closed). */
export class ArchiveAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveAbortError';
  }
}

/** True for `.codegraph` and anything under `.codegraph/**` — regenerable index artifacts, never archived. */
export function isCodegraphArtifact(p: string): boolean {
  const normalized = p.replace(/\\/g, '/').replace(/^\.\/+/, '');
  return normalized === CODEGRAPH_DIR || normalized.startsWith(`${CODEGRAPH_DIR}/`);
}

/**
 * Byte-exact git read — the one contract every patch section is built from.
 *
 * Decoding is NOT allowed on this path. Git classifies a file as TEXT when its
 * first 8000 bytes hold no NUL, and for TEXT it emits the file's RAW bytes into
 * the diff. A UTF-8 decode replaces every invalid sequence with U+FFFD, so a
 * latin-1/CP1252/otherwise-non-UTF-8 source file is archived as DIFFERENT bytes
 * than the ones `resetToSha` is about to destroy — and because the mangling is
 * confined to added lines, `git apply` exits 0 and nothing signals the loss.
 * `--binary` (ARCHIVE_DIFF_BASE) does not cover this: it only reaches files git
 * already calls binary, which base85-encode to pure ASCII and survive a decode.
 */
function runArchiveGitBytes(args: string[], cwd: string, okStatuses: number[] = [0]): Buffer {
  const result = spawnSync('git', args, {
    cwd,
    timeout: ARCHIVE_GIT_TIMEOUT_MS,
    maxBuffer: UNBOUNDED_READ_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (!okStatuses.includes(result.status ?? -1)) {
    throw new Error(`Command failed: git ${args.join(' ')}\nError: ${result.stderr?.toString('utf-8') ?? ''}`);
  }
  return result.stdout ?? Buffer.alloc(0);
}

/** Text wrapper — for git output that is a PATH LIST, never patch content. */
function runArchiveGit(args: string[], cwd: string, okStatuses: number[] = [0]): string {
  return runArchiveGitBytes(args, cwd, okStatuses).toString('utf-8');
}

function listUntrackedPaths(cwd: string): string[] {
  const out = runArchiveGit(['ls-files', '--others', '--exclude-standard', '-z'], cwd);
  return out.split('\0').filter((p) => p.length > 0 && !isCodegraphArtifact(p));
}

function collectUntrackedDiffs(cwd: string, byteCap: number): { sections: Buffer[]; truncated: boolean } {
  const sections: Buffer[] = [];
  let bytes = 0;
  for (const file of listUntrackedPaths(cwd)) {
    // exit 1 = content differs (the normal case for --no-index against /dev/null)
    const diff = runArchiveGitBytes([...ARCHIVE_DIFF_BASE, '--no-index', '/dev/null', file], cwd, [0, 1]);
    if (bytes + diff.length > byteCap) return { sections, truncated: true };
    bytes += diff.length;
    sections.push(diff);
  }
  return { sections, truncated: false };
}

function buildArchivePatch(cwd: string, byteCap: number): { content: Buffer; truncated: boolean } {
  const staged = runArchiveGitBytes([...ARCHIVE_DIFF_BASE, '--cached', ...CODEGRAPH_PATHSPEC_EXCLUDES], cwd);
  const unstaged = runArchiveGitBytes([...ARCHIVE_DIFF_BASE, ...CODEGRAPH_PATHSPEC_EXCLUDES], cwd);
  const untracked = collectUntrackedDiffs(cwd, byteCap);
  const content = Buffer.concat([staged, unstaged, ...untracked.sections].filter((s) => s.length > 0));
  return { content, truncated: untracked.truncated };
}

/** Write + fsync the patch so it is durable BEFORE any destructive command runs. */
function writePatchFileSync(patchPath: string, content: Buffer): void {
  const fd = fs.openSync(patchPath, 'w');
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    try { fs.closeSync(fd); } catch { /* preserve original error */ }
  }
}

/** Best-effort telemetry: emission failure must never block (or unblock) the destructive op. */
function emitArchiveEvent(sessionDir: string, entry: { event: string; [key: string]: unknown }): void {
  try {
    writeActivityEntry(path.join(sessionDir, 'state.json'), entry);
  } catch { /* best-effort */ }
}

/**
 * Fail-closed archival of uncommitted work before a destructive tree op.
 *
 * Writes staged diff + unstaged diff + untracked file content (per-file
 * `git diff --no-index /dev/null <file>`, byte-capped) to
 * `<ticketDir>/pre_reset_diff_<epoch-ms>.patch` (sessionDir fallback for
 * non-ticket callers), fsyncs it, then emits `pre_reset_diff_archived`.
 * `.codegraph/**` is excluded from both the dirty-check and the archive.
 * Clean tree → returns null: no patch file, no event.
 *
 * Any archive failure emits `pre_reset_archive_failed` and throws
 * `ArchiveAbortError` — the caller MUST abort the destructive op.
 */
export function archiveBeforeDestructive(
  ctx: ArchiveContext,
  byteCap: number = ARCHIVE_UNTRACKED_BYTE_CAP,
): ArchiveResult | null {
  const files = listWorkingTreeDirtyPaths(ctx.cwd, [CODEGRAPH_DIR]).filter((p) => !isCodegraphArtifact(p));
  if (files.length === 0) return null;

  const ticket = ctx.ticketDir ? path.basename(ctx.ticketDir) : null;
  const patchPath = path.join(ctx.ticketDir ?? ctx.sessionDir, `pre_reset_diff_${Date.now()}.patch`);

  let filesTruncated: boolean;
  try {
    const patch = buildArchivePatch(ctx.cwd, byteCap);
    filesTruncated = patch.truncated;
    writePatchFileSync(patchPath, patch.content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitArchiveEvent(ctx.sessionDir, {
      event: 'pre_reset_archive_failed',
      ts: new Date().toISOString(),
      ticket,
      patch_path: patchPath,
      reason: ctx.reason,
      error: msg,
    });
    throw new ArchiveAbortError(`pre-destructive archive failed (${ctx.reason}): ${msg}`);
  }

  emitArchiveEvent(ctx.sessionDir, {
    event: 'pre_reset_diff_archived',
    ts: new Date().toISOString(),
    ticket,
    patch_path: patchPath,
    files,
    files_truncated: filesTruncated,
    reason: ctx.reason,
  });

  return { patchPath, files, filesTruncated };
}

export type DiffStatus = 'A' | 'M' | 'D' | 'R' | 'B';
export interface DiffEntry {
  path: string;
  status: DiffStatus;
}

/**
 * Returns file-level diff between `base` and `head` for `repoRoot`.
 *
 * Uses `git diff <base>...<head> --name-status -M100 -z` so renames are
 * detected only when similarity is exactly 100% (no heuristic flake), and
 * paths containing whitespace/unicode/newlines survive the NUL-delimited
 * parse intact. Deleted files (`D`) are included — the caller decides
 * whether to exclude them from any "allowed paths" set.
 *
 * Rename entries report the **new** path with status `'R'`; the old path
 * is discarded (scope-resolver does not need it).
 */
export function getDiffFiles(base: string, head: string, repoRoot: string): DiffEntry[] {
  const out = runGit(
    ['diff', `${base}...${head}`, '--name-status', '-M100', '-z'],
    repoRoot,
  );
  if (!out) return [];
  const tokens = out.split('\0').filter((t) => t.length > 0);
  const entries: DiffEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i];
    if (code.startsWith('R') || code.startsWith('C')) {
      const newPath = tokens[i + 2];
      if (newPath) entries.push({ path: newPath, status: 'R' });
      i += 2;
    } else if (code === 'A' || code === 'M' || code === 'D') {
      const p = tokens[i + 1];
      if (p) entries.push({ path: p, status: code });
      i += 1;
    } else {
      const p = tokens[i + 1];
      if (p) entries.push({ path: p, status: 'B' });
      i += 1;
    }
  }
  return entries;
}

/**
 * Returns the merge-base SHA between `ref1` and `ref2` for `repoRoot`.
 * Throws via `runGit` if either ref is unknown to the repository.
 */
export function getMergeBase(ref1: string, ref2: string, repoRoot: string): string {
  return runGit(['merge-base', ref1, ref2], repoRoot).trim();
}

export interface ConcurrentGitHolder { pid: number; command: string; }

/**
 * Shared spawn primitive: look up the command name for a running PID via
 * `ps -p <pid> -o comm=`. Returns the trimmed command string or null on error.
 * Every subprocess carries a finite positive timeout (trap-door convention).
 */
export function lookupCommandForPid(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf-8', timeout: 5_000 });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Advisory probe for live concurrent git access on `repoRoot`.
 *
 * Strategy:
 *   1. `lsof -t <repoRoot>/.git/index.lock` — POSIX standard, returns PID list
 *      on stdout.
 *   2. Fall back to `pgrep -f 'git -C <repoRoot>'` — looser match.
 *   3. If neither tool answers confidently, returns `null` (FAIL-OPEN) — the
 *      launch probe treats probe-tool absence as "no confident holder detected".
 *
 * Advisory ONLY (warn + event), and it is now the sole lock-holder probe: the
 * destructive twin in `cancel.ts` was deleted because no probe can license removing
 * a lock git owns — git closes the fd before it renames, so an unheld reading does
 * not mean unowned. A probe may inform an operator; it may never authorize an unlink.
 */
export function probeConcurrentGitAccess(repoRoot: string): ConcurrentGitHolder | null {
  // TRAP DOOR: probeConcurrentGitAccess advisory-probe — warn+event, never a hard launch block; every subprocess timeout is finite
  const lockPath = path.join(repoRoot, '.git', 'index.lock');

  const lsof = spawnSync('lsof', ['-t', lockPath], { encoding: 'utf-8', timeout: 5_000 });
  if (lsof.status === 0 && typeof lsof.stdout === 'string') {
    const pids = lsof.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (pids.length > 0) {
      const pidNum = Number.parseInt(pids[0], 10);
      if (Number.isFinite(pidNum)) {
        return { pid: pidNum, command: lookupCommandForPid(pidNum) ?? 'unknown' };
      }
    }
    // lsof exited 0 with empty stdout — no holder
    return null;
  }
  if (lsof.status === 1) {
    // lsof exits 1 when no process holds the file — confirmed no holder
    return null;
  }

  // lsof unavailable or errored — fall back to pgrep
  const pgrep = spawnSync('pgrep', ['-f', `git -C ${repoRoot}`], { encoding: 'utf-8', timeout: 5_000 });
  if (pgrep.status === 0 && typeof pgrep.stdout === 'string') {
    const pid = Number.parseInt(pgrep.stdout.split('\n')[0]?.trim() ?? '', 10);
    if (Number.isFinite(pid)) {
      return { pid, command: lookupCommandForPid(pid) ?? 'unknown' };
    }
  }
  if (pgrep.status === 1) {
    // pgrep exits 1 when no matches — confirmed no holder
    return null;
  }

  // Neither tool answered confidently — fail OPEN (advisory: no holder assumed)
  return null;
}

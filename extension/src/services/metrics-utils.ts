import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { formatLocalDateKey, safeErrorMessage } from './pickle-utils.js';
import { readRecoverableJsonObject } from './microverse-state.js';
import { BACKENDS, UNBOUNDED_READ_MAX_BUFFER, enumerationCompleted, type Backend } from '../types/index.js';


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DailyTokens {
  turns: number;
  input: number;
  output: number;
  cache_read: number;
  cache_create: number;
  tokens_per_backend?: Partial<Record<Backend, BackendTokenTotals>>;
}

export interface BackendTokenTotals {
  turns: number;
  input: number;
  output: number;
  cache_read: number;
  cache_create: number;
}

export interface DailyLOC {
  commits: number;
  added: number;
  removed: number;
}

export interface MetricsTotals {
  turns: number;
  input: number;
  output: number;
  cache_read: number;
  cache_create: number;
  commits: number;
  added: number;
  removed: number;
}

export interface ProjectSummary {
  slug: string;
  label: string;
  totals: MetricsTotals;
}

export interface MetricsRow {
  date: string;
  projects: Record<string, DailyTokens>;
  loc: Record<string, DailyLOC>;
}

export interface MetricsReport {
  since: string;
  until: string;
  grouping: string;
  rows: MetricsRow[];
  projects: ProjectSummary[];
  totals: MetricsTotals;
  tokens_per_backend: Record<Backend, BackendTokenTotals>;
}

export interface MetricsCache {
  version: number;
  time_zone: string;
  files: Record<string, { mtime: number; size: number; data: Record<string, DailyTokens> }>;
}

// ---------------------------------------------------------------------------
// Skip-flag budget dashboard (W5c)
//
// Counts skip-flag USES per {source,reason} over the existing activity events
// `gate_skipped` / `readiness_skipped` and flags any gate whose use rate
// exceeds its stated budget as a removal candidate. Keys on skip-flag-USE
// rate ONLY (owner ruling 3 — no `gate_false_positive` event).
// ---------------------------------------------------------------------------

/** The activity events that record a skip-flag use. */
export const SKIP_FLAG_EVENT_NAMES = ['gate_skipped', 'readiness_skipped'] as const;

/** Default recurrence budget applied to any {source,reason} without an explicit entry. */
export const DEFAULT_SKIP_FLAG_BUDGET = 5;

/**
 * Stated per-gate recurrence budgets, keyed `<source>::<reason>`. A gate whose
 * skip-flag-use count over the window exceeds its budget is flagged as a
 * removal candidate. Intentional kill-switch / bundle-bootstrap reasons get a
 * generous budget; everything else falls back to DEFAULT_SKIP_FLAG_BUDGET.
 */
export const SKIP_FLAG_BUDGETS: Record<string, number> = {
  'pickle::kill_switch': 1000,
  'pickle::no_commits': 1000,
  'pickle::no_project_type_detected': 50,
  'pickle::project_type_low_confidence': 50,
  'pickle::dirty_worktree_no_rescue': 20,
  'citadel-mechanical::skip_quality_gates': 3,
};
// 'pickle::signature_caller_gap' (budget 3) removed 2026-07-10: the dashboard showed
// 725 uses/10d (~240x over) → the blocking arm was demoted to advisory per W5b and
// its gate_skipped emitters deleted (check-readiness.ts) — the budget row is retired
// with the gate, not raised.

/** A single normalized skip-flag use extracted from an activity event. */
export interface SkipFlagEvent {
  event: string;
  source: string;
  reason: string;
}

/** Per-{source,reason} budget tally. */
export interface SkipFlagBudgetEntry {
  source: string;
  reason: string;
  uses: number;
  budget: number;
  over_budget: boolean;
  removal_candidate: boolean;
}

export interface SkipFlagBudgetReport {
  since: string;
  until: string;
  total_uses: number;
  entries: SkipFlagBudgetEntry[];
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

export function formatNumber(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return sign + (abs / 1_000_000_000).toFixed(1) + 'B';
  if (abs >= 1_000_000) return sign + (abs / 1_000_000).toFixed(1) + 'M';
  if (abs >= 1_000) return sign + (abs / 1_000).toFixed(1) + 'K';
  return String(n);
}

export function shortenSlug(slug: string): string {
  const username = os.userInfo().username;
  const escapedUser = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let result = slug.replace(new RegExp(`^-Users-${escapedUser}-`), '');
  result = result.replace(/^loanlight-/, 'l/');
  return result;
}

function projectSlugFromPath(projectPath: string): string {
  return path.resolve(projectPath).replace(/[\\/]/g, '-');
}

function discoverGitRepos(repoRoot: string): string[] {
  const repos: string[] = [];
  const root = path.resolve(repoRoot);
  const pending = [root];

  while (pending.length > 0) {
    const current = pending.pop()!;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      // The ROOT is the corpus: its failure drops every repo and publishes a zero LOC
      // total that reads as a quiet day. A DESCENT failure is one speculative subtree of
      // an unknown tree — routine, and announcing each one is the noise that hides a real drop.
      if (current === root) {
        announceScanDrop('loc', current, `enumeration failed: ${safeErrorMessage(err)}`);
      }
      continue;
    }

    if (entries.some((entry) => entry.name === '.git' && (entry.isDirectory() || entry.isFile()))) {
      repos.push(current);
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.git' || entry.isSymbolicLink()) continue;
      pending.push(path.join(current, entry.name));
    }
  }

  return repos;
}

/**
 * Worktrees share commit history with their main repo. Returns the main repo's
 * primary branch name so the worktree's `git log` can subtract it (`HEAD ^<ref>`)
 * and only count commits unique to the worktree's checkout. Returns null when
 * `repoPath` is not a worktree, or when the main HEAD is detached/unreadable.
 */
function getWorktreeBaseRef(repoPath: string): string | null {
  const gitPath = path.join(repoPath, '.git');
  try {
    const stat = fs.statSync(gitPath);
    if (!stat.isFile()) return null;
    const content = fs.readFileSync(gitPath, 'utf-8').trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match) return null;
    // gitdir target is `<main>/.git/worktrees/<name>` — main repo's .git is two levels up
    const mainGitDir = path.dirname(path.dirname(match[1]!));
    const headPath = path.join(mainGitDir, 'HEAD');
    const head = fs.readFileSync(headPath, 'utf-8').trim();
    const refMatch = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return refMatch ? refMatch[1]! : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session Line Parser
// ---------------------------------------------------------------------------

interface ParsedLine {
  timestamp: string;
  backend: Backend;
  usage: { input: number; output: number; cache_read: number; cache_create: number };
}

export function parseSessionLine(line: string): ParsedLine | null {
  try {
    const obj = JSON.parse(line);
    if (obj.type !== 'assistant') return null;
    const ts = obj.timestamp;
    const backend = isBackend(obj.backend) ? obj.backend : 'claude';
    const usage = obj.message?.usage;
    if (typeof ts !== 'string' || !usage) return null;
    if (!Number.isFinite(new Date(ts).getTime())) return null;
    return {
      timestamp: ts,
      backend,
      usage: {
        input: Number(usage.input_tokens) || 0,
        output: Number(usage.output_tokens) || 0,
        cache_read: Number(usage.cache_read_input_tokens) || 0,
        cache_create: Number(usage.cache_creation_input_tokens) || 0,
      },
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session File Scanner with Incremental Cache
// ---------------------------------------------------------------------------

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB guard
const CACHE_VERSION = 3;

function isBackend(value: unknown): value is Backend {
  return typeof value === 'string' && (BACKENDS as readonly string[]).includes(value);
}

function getMetricsTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
}

function emptyCache(): MetricsCache {
  return { version: CACHE_VERSION, time_zone: getMetricsTimeZone(), files: {} };
}

function emptyDailyTokens(): DailyTokens {
  return { turns: 0, input: 0, output: 0, cache_read: 0, cache_create: 0, tokens_per_backend: emptyBackendTokenBuckets() };
}

function addTokens(target: DailyTokens, usage: ParsedLine['usage']): void {
  target.turns += 1;
  target.input += usage.input;
  target.output += usage.output;
  target.cache_read += usage.cache_read;
  target.cache_create += usage.cache_create;
}

function emptyBackendTokenTotals(): BackendTokenTotals {
  return { turns: 0, input: 0, output: 0, cache_read: 0, cache_create: 0 };
}

function emptyBackendTokenBuckets(): Record<Backend, BackendTokenTotals> {
  return Object.fromEntries(BACKENDS.map((backend) => [backend, emptyBackendTokenTotals()])) as Record<Backend, BackendTokenTotals>;
}

function addBackendTokens(target: BackendTokenTotals, source: BackendTokenTotals): void {
  target.turns += source.turns;
  target.input += source.input;
  target.output += source.output;
  target.cache_read += source.cache_read;
  target.cache_create += source.cache_create;
}

function addUsageToBackend(target: DailyTokens, backend: Backend, usage: ParsedLine['usage']): void {
  target.tokens_per_backend ??= emptyBackendTokenBuckets();
  target.tokens_per_backend[backend] ??= emptyBackendTokenTotals();
  const bucket = target.tokens_per_backend[backend];
  bucket.turns += 1;
  bucket.input += usage.input;
  bucket.output += usage.output;
  bucket.cache_read += usage.cache_read;
  bucket.cache_create += usage.cache_create;
}

function mergeDailyTokens(target: DailyTokens, source: DailyTokens): void {
  target.turns += source.turns;
  target.input += source.input;
  target.output += source.output;
  target.cache_read += source.cache_read;
  target.cache_create += source.cache_create;

  if (!source.tokens_per_backend) return;
  target.tokens_per_backend ??= emptyBackendTokenBuckets();
  for (const backend of BACKENDS) {
    const backendTokens = source.tokens_per_backend[backend];
    if (!backendTokens) continue;
    target.tokens_per_backend[backend] ??= emptyBackendTokenTotals();
    addBackendTokens(target.tokens_per_backend[backend], backendTokens);
  }
}

function parseJsonlFile(filePath: string): Record<string, DailyTokens> {
  const result: Record<string, DailyTokens> = {};
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = parseSessionLine(line);
    if (!parsed) continue;
    const date = formatLocalDateKey(new Date(parsed.timestamp));
    if (!result[date]) result[date] = emptyDailyTokens();
    addTokens(result[date], parsed.usage);
    addUsageToBackend(result[date], parsed.backend, parsed.usage);
  }
  return result;
}

function loadCache(cachePath: string): MetricsCache {
  try {
    const parsed = readRecoverableJsonObject(cachePath) as MetricsCache | null;
    if (!parsed) return emptyCache();
    if (parsed.version !== CACHE_VERSION) return emptyCache();
    if (parsed.time_zone !== getMetricsTimeZone()) return emptyCache();
    return parsed;
  } catch {
    return emptyCache();
  }
}

function saveCache(cachePath: string, cache: MetricsCache): void {
  try {
    const dir = path.dirname(cachePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${cachePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, cachePath);
  } catch (err) {
    const msg = safeErrorMessage(err);
    process.stderr.write(`[metrics] Cache write failed (non-fatal): ${msg}\n`);
  }
}

/**
 * AP-EXT-ITER200-01: the ONE announce-and-drop for EVERY jsonl that leaves a metrics
 * total, at every level of the walk. `aceb54d7` (activity half) and `7e56db10` (session
 * half) each fixed the per-FILE arm and each left the DIRECTORY arm returning silently
 * one frame up, so the third recurrence of one theme was a strictly larger under-count
 * than the two already fixed: a whole corpus, reported as a quiet day.
 *
 * `label` names the scanner, `target` the file or directory that left the totals. A
 * directory the filesystem REFUSED to enumerate is announced; a directory it answered
 * about (`!isDirectory()`) is not, because nothing was dropped. That is the whole rule —
 * no list of errno values to keep current.
 */
function announceScanDrop(label: string, target: string, reason: string): null {
  process.stderr.write(`[metrics] ${label} scan skipped ${target}: ${reason}\n`);
  return null;
}

function readSessionSlugs(projectsDir: string): string[] | null {
  try {
    return fs.readdirSync(projectsDir).filter((s) => !s.startsWith('-private-var-'));
  } catch (err) {
    return announceScanDrop('session', projectsDir, `enumeration failed: ${safeErrorMessage(err)}`);
  }
}

function readSlugJsonlFiles(slugDir: string): string[] | null {
  try {
    // A non-directory is an ANSWER, not a refusal — it holds no transcripts, so it is
    // not a drop and stays silent. Anything that throws is a refusal: announce it.
    if (!fs.statSync(slugDir).isDirectory()) return null;
    return fs.readdirSync(slugDir).filter((f) => f.endsWith('.jsonl'));
  } catch (err) {
    return announceScanDrop('session', slugDir, `enumeration failed: ${safeErrorMessage(err)}`);
  }
}

/**
 * AP-EXT-ITER193-01: the session half's drop reasons, all of which route through the ONE
 * exit above so the family cannot re-fork into a silent sibling.
 */
function dropSessionFile(filePath: string, reason: string): null {
  return announceScanDrop('session', filePath, reason);
}

function loadSessionFileData(
  filePath: string,
  cache: MetricsCache,
): { fileData: Record<string, DailyTokens>; changed: boolean } | null {
  let fstat: fs.Stats;
  try {
    fstat = fs.statSync(filePath);
  } catch (err) {
    return dropSessionFile(filePath, `stat failed: ${safeErrorMessage(err)}`);
  }
  if (fstat.size > MAX_FILE_BYTES) {
    return dropSessionFile(filePath, `size ${fstat.size} exceeds the ${MAX_FILE_BYTES}-byte cap`);
  }

  const cached = cache.files[filePath];
  if (cached && cached.mtime === fstat.mtimeMs && cached.size === fstat.size) {
    return { fileData: cached.data, changed: false };
  }

  try {
    const fileData = parseJsonlFile(filePath);
    cache.files[filePath] = { mtime: fstat.mtimeMs, size: fstat.size, data: fileData };
    return { fileData, changed: true };
  } catch (err) {
    return dropSessionFile(filePath, `read failed: ${safeErrorMessage(err)}`);
  }
}

function mergeFileDataIntoResult(
  result: Map<string, Map<string, DailyTokens>>,
  slug: string,
  fileData: Record<string, DailyTokens>,
  since: string,
  until: string,
): void {
  for (const [date, tokens] of Object.entries(fileData)) {
    if (date < since || date > until) continue;
    if (!result.has(slug)) result.set(slug, new Map());
    const dateMap = result.get(slug)!;
    if (!dateMap.has(date)) dateMap.set(date, emptyDailyTokens());
    const target = dateMap.get(date)!;
    mergeDailyTokens(target, tokens);
  }
}

function pruneMissingCacheFiles(cache: MetricsCache, validPaths: Set<string>): boolean {
  let changed = false;
  for (const cachedPath of Object.keys(cache.files)) {
    if (!validPaths.has(cachedPath)) {
      delete cache.files[cachedPath];
      changed = true;
    }
  }
  return changed;
}

export function scanSessionFiles(
  projectsDir: string,
  since: string,
  until: string,
  cachePath: string,
): Map<string, Map<string, DailyTokens>> {
  const result = new Map<string, Map<string, DailyTokens>>();
  const cache = loadCache(cachePath);
  let cacheChanged = false;
  const validPaths = new Set<string>();

  const slugs = readSessionSlugs(projectsDir);
  if (!slugs) return result;

  for (const slug of slugs) {
    const slugDir = path.join(projectsDir, slug);
    const files = readSlugJsonlFiles(slugDir);
    if (!files) continue;

    for (const file of files) {
      const filePath = path.join(slugDir, file);
      validPaths.add(filePath);
      const loaded = loadSessionFileData(filePath, cache);
      if (!loaded) continue;
      cacheChanged = cacheChanged || loaded.changed;
      mergeFileDataIntoResult(result, slug, loaded.fileData, since, until);
    }
  }

  cacheChanged = pruneMissingCacheFiles(cache, validPaths) || cacheChanged;

  if (cacheChanged) saveCache(cachePath, cache);
  return result;
}

// ---------------------------------------------------------------------------
// Git Log Parser
// ---------------------------------------------------------------------------

const STAT_RE = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T/;

export function parseGitLogOutput(output: string): Map<string, DailyLOC> {
  const result = new Map<string, DailyLOC>();
  let currentDate: string | null = null;

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (ISO_DATE_RE.test(line)) {
      const d = new Date(line);
      if (isNaN(d.getTime())) continue;
      currentDate = formatLocalDateKey(d);
      if (!result.has(currentDate)) result.set(currentDate, { commits: 0, added: 0, removed: 0 });
      result.get(currentDate)!.commits += 1;
      continue;
    }

    const m = STAT_RE.exec(line);
    if (m && currentDate) {
      const entry = result.get(currentDate)!;
      entry.added += parseInt(m[2] || '0', 10);
      entry.removed += parseInt(m[3] || '0', 10);
    }
  }

  return result;
}

export function scanGitRepos(repoRoot: string, since: string, until: string): Map<string, Map<string, DailyLOC>> {
  const result = new Map<string, Map<string, DailyLOC>>();

  for (const repoPath of discoverGitRepos(repoRoot)) {
    const repoSlug = projectSlugFromPath(repoPath);

    try {
      const baseRef = getWorktreeBaseRef(repoPath);
      const logArgs = [
        'log',
        `--since=${since} 00:00`,
        `--until=${until} 23:59:59`,
        '--format=%aI',
        '--shortstat',
      ];
      if (baseRef) {
        // Worktree: subtract main repo's branch so we only count commits unique
        // to this checkout. Without this, every commit in the shared history
        // gets attributed to the worktree slug too.
        logArgs.push('HEAD', `^${baseRef}`);
      }
      const proc = spawnSync('git', logArgs, {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 30_000,
        // AP-EXT-ITER8-01: an unbounded log window truncates past Node's 1 MB
        // default, and the guard below then drops the whole repo from the report
        // silently — under-counted LOC that reads as real data.
        maxBuffer: UNBOUNDED_READ_MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // Completion is the family's ONE shared predicate (`types/index.ts`), not a
      // local status test: the ceiling above has TWO overflow shapes and the
      // status-only half is blind to one of them. A child that EXITS before Node's
      // kill lands returns `status: 0` with `error.code === 'ENOBUFS'` and a
      // TRUNCATED log, which a status-only guard reads as a COMPLETE window — the
      // repo then lands in the report with silently under-counted LOC, which is a
      // WRONG number, not a missing one. Dropping the repo (as every other failure
      // here does) at least leaves the absence visible.
      if (!enumerationCompleted(proc)) continue;
      const locMap = parseGitLogOutput(proc.stdout || '');
      const boundedLocMap = new Map<string, DailyLOC>();
      for (const [date, totals] of locMap) {
        if (date < since || date > until) continue;
        boundedLocMap.set(date, totals);
      }
      if (boundedLocMap.size > 0) result.set(repoSlug, boundedLocMap);
    } catch {
      // Individual repo failure is non-fatal
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Report Builder
// ---------------------------------------------------------------------------

function emptyTotals(): MetricsTotals {
  return { turns: 0, input: 0, output: 0, cache_read: 0, cache_create: 0, commits: 0, added: 0, removed: 0 };
}

function buildProjectTotals(
  tokens: Map<string, Map<string, DailyTokens>>,
  loc: Map<string, Map<string, DailyLOC>>,
): Map<string, MetricsTotals> {
  const projectTotals = new Map<string, MetricsTotals>();
  for (const [slug, dateMap] of tokens) {
    const t = emptyTotals();
    for (const dt of dateMap.values()) {
      t.turns += dt.turns;
      t.input += dt.input;
      t.output += dt.output;
      t.cache_read += dt.cache_read;
      t.cache_create += dt.cache_create;
    }
    projectTotals.set(slug, t);
  }
  for (const [slug, dateMap] of loc) {
    if (!projectTotals.has(slug)) projectTotals.set(slug, emptyTotals());
    const target = projectTotals.get(slug)!;
    for (const dl of dateMap.values()) {
      target.commits += dl.commits;
      target.added += dl.added;
      target.removed += dl.removed;
    }
  }
  return projectTotals;
}

function sumProjectTotals(projects: ProjectSummary[]): MetricsTotals {
  const totals = emptyTotals();
  for (const p of projects) {
    totals.turns += p.totals.turns;
    totals.input += p.totals.input;
    totals.output += p.totals.output;
    totals.cache_read += p.totals.cache_read;
    totals.cache_create += p.totals.cache_create;
    totals.commits += p.totals.commits;
    totals.added += p.totals.added;
    totals.removed += p.totals.removed;
  }
  return totals;
}

function aggregateBackendTotals(tokens: Map<string, Map<string, DailyTokens>>): Record<Backend, BackendTokenTotals> {
  const totals = emptyBackendTokenBuckets();
  for (const dateMap of tokens.values()) {
    for (const dt of dateMap.values()) {
      if (!dt.tokens_per_backend) continue;
      for (const backend of BACKENDS) {
        const backendTokens = dt.tokens_per_backend[backend];
        if (!backendTokens) continue;
        addBackendTokens(totals[backend], backendTokens);
      }
    }
  }
  return totals;
}

export function buildReport(
  tokens: Map<string, Map<string, DailyTokens>>,
  loc: Map<string, Map<string, DailyLOC>>,
  since: string,
  until: string,
  grouping: string,
): MetricsReport {
  const dateSet = new Set<string>();
  for (const dateMap of tokens.values()) {
    for (const date of dateMap.keys()) dateSet.add(date);
  }
  for (const dateMap of loc.values()) {
    for (const date of dateMap.keys()) dateSet.add(date);
  }
  const dates = [...dateSet].sort();

  const rows: MetricsRow[] = dates.map((date) => {
    const projects: Record<string, DailyTokens> = {};
    for (const [slug, dateMap] of tokens) {
      const dt = dateMap.get(date);
      if (dt) projects[slug] = dt;
    }
    const locData: Record<string, DailyLOC> = {};
    for (const [repo, dateMap] of loc) {
      const dl = dateMap.get(date);
      if (dl) locData[repo] = dl;
    }
    return { date, projects, loc: locData };
  });

  const projects: ProjectSummary[] = [...buildProjectTotals(tokens, loc).entries()].map(([slug, totals]) => ({
    slug,
    label: shortenSlug(slug),
    totals,
  }));

  const totals = sumProjectTotals(projects);

  return { since, until, grouping, rows, projects, totals, tokens_per_backend: aggregateBackendTotals(tokens) };
}

// ---------------------------------------------------------------------------
// Skip-flag budget report builder
// ---------------------------------------------------------------------------

/**
 * Streaming window for the activity-dir scanners below. This is a READ CHUNK,
 * never a file-size cap: `forEachJsonlLine` carries a partial trailing line
 * across chunks, so a file of any size is scanned in full at bounded memory.
 *
 * AP-EXT-ITER10-01: the predecessor was a 10 MB file-size cap that skipped past
 * any larger file WITHOUT a diagnostic. Measured on a live host, 6 of 8 activity
 * files were over the cap (up to 207 MB), so the skip-flag dashboard tallied 486
 * of 15,441 real uses (96.9% lost) and reported
 * `over_budget: false` for two reasons that were 40x and 2.5x OVER budget. A
 * dropped file must never be silent, and a big file must not be dropped at all.
 */
const ACTIVITY_READ_CHUNK_BYTES = 1024 * 1024;

/**
 * Read `filePath` as newline-delimited text, invoking `onLine` once per line.
 *
 * Synchronous by contract: every caller is a sync scanner on the `/pickle-metrics`
 * path. Reads through a fixed `ACTIVITY_READ_CHUNK_BYTES` buffer and carries the
 * unterminated tail forward, so peak memory is the chunk plus the longest single
 * line (1.3 MB in the live corpus) rather than the whole file. `StringDecoder`
 * holds back partial multi-byte sequences that straddle a chunk boundary.
 */
function forEachJsonlLine(filePath: string, onLine: (line: string) => void): void {
  const fd = fs.openSync(filePath, 'r');
  const decoder = new StringDecoder('utf-8');
  const buf = Buffer.allocUnsafe(ACTIVITY_READ_CHUNK_BYTES);
  let carry = '';
  try {
    for (;;) {
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      const parts = (carry + decoder.write(buf.subarray(0, bytesRead))).split('\n');
      carry = parts.pop() ?? '';
      for (const part of parts) onLine(part);
    }
    carry += decoder.end();
    if (carry) onLine(carry);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The ONE activity-dir walk shared by every scanner below: enumerate
 * `<activityDir>/*.jsonl`, stream each file, parse each line, and hand
 * `onEvent` every event whose local-date key falls inside `[since, until]`
 * (inclusive, matching the metrics report range).
 *
 * `label` names the caller in the per-file stderr diagnostic. A file that
 * cannot be read is reported, never silently skipped — an under-count that
 * announces itself is a measurement; one that does not is a false verdict.
 */
function forEachActivityEventInWindow(
  activityDir: string,
  since: string,
  until: string,
  label: string,
  onEvent: (ev: Record<string, unknown>) => void,
): void {
  let files: string[];
  try {
    files = fs.readdirSync(activityDir).filter((f) => f.endsWith('.jsonl'));
  } catch (err) {
    announceScanDrop(label, activityDir, `enumeration failed: ${safeErrorMessage(err)}`);
    return;
  }

  for (const file of files) {
    try {
      forEachJsonlLine(path.join(activityDir, file), (rawLine) => {
        const line = rawLine.trim();
        if (!line) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        if (typeof parsed !== 'object' || parsed === null) return;
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.ts !== 'string') return;
        const dateKey = formatLocalDateKey(new Date(obj.ts));
        if (dateKey < since || dateKey > until) return;
        onEvent(obj);
      });
    } catch (err) {
      announceScanDrop(label, file, safeErrorMessage(err));
    }
  }
}

function budgetKey(source: string, reason: string): string {
  return `${source}::${reason}`;
}

/**
 * Normalize one activity event into a {source,reason} skip-flag use, or null if
 * the event is not a skip-flag event. `gate_skipped`/`readiness_skipped` carry
 * the reason in `gate_payload.reason`.
 */
export function extractSkipFlagUse(ev: unknown): SkipFlagEvent | null {
  if (typeof ev !== 'object' || ev === null) return null;
  const obj = ev as Record<string, unknown>;
  const event = typeof obj.event === 'string' ? obj.event : '';
  if (!(SKIP_FLAG_EVENT_NAMES as readonly string[]).includes(event)) return null;

  const source = typeof obj.source === 'string' && obj.source ? obj.source : 'pickle';
  const payload = typeof obj.gate_payload === 'object' && obj.gate_payload !== null
    ? (obj.gate_payload as Record<string, unknown>)
    : {};
  const rawReason = payload.reason;
  const reason = typeof rawReason === 'string' && rawReason ? rawReason : 'unspecified';

  return { event, source, reason };
}

/**
 * Scan `<activityDir>/*.jsonl` for skip-flag uses within the `[since, until]`
 * date window (inclusive local-date keys, matching the metrics report range).
 */
export function scanSkipFlagEvents(activityDir: string, since: string, until: string): SkipFlagEvent[] {
  const out: SkipFlagEvent[] = [];
  forEachActivityEventInWindow(activityDir, since, until, 'skip-flag', (ev) => {
    const use = extractSkipFlagUse(ev);
    if (use) out.push(use);
  });
  return out;
}

/**
 * Tally skip-flag uses per {source,reason} and flag any whose use count exceeds
 * its stated budget as a removal candidate (W5c). Keys on skip-flag-use rate
 * ONLY — there is no false-positive signal in the model.
 */
export function buildSkipFlagBudgetReport(
  events: SkipFlagEvent[],
  budgets: Record<string, number>,
  since: string,
  until: string,
): SkipFlagBudgetReport {
  const tally = new Map<string, { source: string; reason: string; uses: number }>();
  for (const ev of events) {
    const key = budgetKey(ev.source, ev.reason);
    const cur = tally.get(key);
    if (cur) cur.uses += 1;
    else tally.set(key, { source: ev.source, reason: ev.reason, uses: 1 });
  }

  const entries: SkipFlagBudgetEntry[] = [...tally.entries()].map(([key, t]) => {
    const budget = budgets[key] ?? DEFAULT_SKIP_FLAG_BUDGET;
    const over_budget = t.uses > budget;
    return { source: t.source, reason: t.reason, uses: t.uses, budget, over_budget, removal_candidate: over_budget };
  });

  entries.sort((a, b) => b.uses - a.uses || budgetKey(a.source, a.reason).localeCompare(budgetKey(b.source, b.reason)));

  return { since, until, total_uses: events.length, entries };
}

// ---------------------------------------------------------------------------
// Readiness false-positive report (AC-B4) — NON-BLOCKING observability counter
// ---------------------------------------------------------------------------

/** The activity event recording a suppressed prior readiness finding (AC-B4). */
export const READINESS_FALSE_POSITIVE_EVENT_NAME = 'readiness_false_positive_suppressed';

/** A single normalized `readiness_false_positive_suppressed` event. */
export interface ReadinessFalsePositiveEvent {
  session: string;
  suppressed_count: number;
}

/** Aggregated readiness false-positive counter for the dashboard window. */
export interface ReadinessFalsePositiveReport {
  since: string;
  until: string;
  total_events: number;
  total_suppressed: number;
}

/** Normalize one activity event into a readiness false-positive event, or null. */
export function extractReadinessFalsePositive(ev: unknown): ReadinessFalsePositiveEvent | null {
  if (typeof ev !== 'object' || ev === null) return null;
  const obj = ev as Record<string, unknown>;
  if (obj.event !== READINESS_FALSE_POSITIVE_EVENT_NAME) return null;
  const session = typeof obj.session === 'string' && obj.session ? obj.session : 'unknown';
  const payload = typeof obj.gate_payload === 'object' && obj.gate_payload !== null
    ? (obj.gate_payload as Record<string, unknown>)
    : {};
  const rawCount = payload.suppressed_count;
  const suppressed_count = typeof rawCount === 'number' && Number.isFinite(rawCount) ? rawCount : 0;
  return { session, suppressed_count };
}

/**
 * Scan `<activityDir>/*.jsonl` for `readiness_false_positive_suppressed` events
 * within the `[since, until]` date window (mirrors `scanSkipFlagEvents`).
 */
export function scanReadinessFalsePositiveEvents(activityDir: string, since: string, until: string): ReadinessFalsePositiveEvent[] {
  const out: ReadinessFalsePositiveEvent[] = [];
  forEachActivityEventInWindow(activityDir, since, until, 'readiness-false-positive', (raw) => {
    const ev = extractReadinessFalsePositive(raw);
    if (ev) out.push(ev);
  });
  return out;
}

/**
 * Aggregate `readiness_false_positive_suppressed` events into a non-blocking
 * counter: total events and total suppressed prior findings over the window.
 */
export function buildReadinessFalsePositiveReport(
  events: ReadinessFalsePositiveEvent[],
  since: string,
  until: string,
): ReadinessFalsePositiveReport {
  const total_suppressed = events.reduce((sum, ev) => sum + ev.suppressed_count, 0);
  return { since, until, total_events: events.length, total_suppressed };
}

// ---------------------------------------------------------------------------
// Refused-and-recovered counters (WS4, b7cc6081) — NON-BLOCKING observability
//
// INVERTED semantics vs the skip-flag budget above: a rising count is the
// consolidation guard WORKING (it refused an unsafe transition and recovered),
// NOT a regression and NOT a budget. There is no over-budget / removal-candidate
// concept here. An empty window is `0` labelled "no refusals recorded" — NEVER
// "no recurrence". The genuine regress signal (a NEW unguarded seam) emits
// NOTHING at runtime; it is caught at BUILD time by WS1's 4th audit proxy.
// `pickle_phase_incomplete` is a recordExitReason string, NOT an event — absent here.
// ---------------------------------------------------------------------------

/** The three refused-and-recovered activity events surfaced on the dashboard. */
export const REFUSED_RECOVERED_EVENT_NAMES = [
  'completion_finalize_refused',
  'phase_graduation_refused',
  'gate_parity_divergence',
] as const;

export type RefusedRecoveredEventName = typeof REFUSED_RECOVERED_EVENT_NAMES[number];

/** Per-event refused-and-recovered tallies over the dashboard window. */
export interface RefusedRecoveredReport {
  since: string;
  until: string;
  completion_finalize_refused: number;
  phase_graduation_refused: number;
  gate_parity_divergence: number;
  total: number;
}

/**
 * Scan `<activityDir>/*.jsonl` for the three refused-and-recovered events within
 * the `[since, until]` window (inclusive local-date keys, mirroring
 * `scanSkipFlagEvents` / `scanReadinessFalsePositiveEvents`). Returns per-event
 * counts; absent/empty dir yields all-zero (a healthy "no refusals" window).
 */
export function scanRefusedRecoveredCounts(activityDir: string, since: string, until: string): RefusedRecoveredReport {
  const counts: Record<RefusedRecoveredEventName, number> = {
    completion_finalize_refused: 0,
    phase_graduation_refused: 0,
    gate_parity_divergence: 0,
  };
  const eventSet = new Set<string>(REFUSED_RECOVERED_EVENT_NAMES);

  forEachActivityEventInWindow(activityDir, since, until, 'refused-recovered', (ev) => {
    const event = typeof ev.event === 'string' ? ev.event : '';
    if (!eventSet.has(event)) return;
    counts[event as RefusedRecoveredEventName] += 1;
  });

  const total = counts.completion_finalize_refused + counts.phase_graduation_refused + counts.gate_parity_divergence;
  return { since, until, ...counts, total };
}

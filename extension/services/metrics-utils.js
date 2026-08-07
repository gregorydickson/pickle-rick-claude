import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { formatLocalDateKey, safeErrorMessage } from './pickle-utils.js';
import { readRecoverableJsonObject } from './microverse-state.js';
import { BACKENDS, UNBOUNDED_READ_MAX_BUFFER } from '../types/index.js';
// ---------------------------------------------------------------------------
// Skip-flag budget dashboard (W5c)
//
// Counts skip-flag USES per {source,reason} over the existing activity events
// `gate_skipped` / `readiness_skipped` and flags any gate whose use rate
// exceeds its stated budget as a removal candidate. Keys on skip-flag-USE
// rate ONLY (owner ruling 3 — no `gate_false_positive` event).
// ---------------------------------------------------------------------------
/** The activity events that record a skip-flag use. */
export const SKIP_FLAG_EVENT_NAMES = ['gate_skipped', 'readiness_skipped'];
/** Default recurrence budget applied to any {source,reason} without an explicit entry. */
export const DEFAULT_SKIP_FLAG_BUDGET = 5;
/**
 * Stated per-gate recurrence budgets, keyed `<source>::<reason>`. A gate whose
 * skip-flag-use count over the window exceeds its budget is flagged as a
 * removal candidate. Intentional kill-switch / bundle-bootstrap reasons get a
 * generous budget; everything else falls back to DEFAULT_SKIP_FLAG_BUDGET.
 */
export const SKIP_FLAG_BUDGETS = {
    'pickle::kill_switch': 1000,
    'pickle::no_commits': 1000,
    'pickle::no_project_type_detected': 50,
    'pickle::project_type_low_confidence': 50,
    'pickle::dirty_worktree_no_rescue': 20,
    'citadel-mechanical::skip_quality_gates': 3,
};
// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------
export function formatNumber(n) {
    if (!Number.isFinite(n) || n === 0)
        return '0';
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (abs >= 1_000_000_000)
        return sign + (abs / 1_000_000_000).toFixed(1) + 'B';
    if (abs >= 1_000_000)
        return sign + (abs / 1_000_000).toFixed(1) + 'M';
    if (abs >= 1_000)
        return sign + (abs / 1_000).toFixed(1) + 'K';
    return String(n);
}
export function shortenSlug(slug) {
    const username = os.userInfo().username;
    const escapedUser = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let result = slug.replace(new RegExp(`^-Users-${escapedUser}-`), '');
    result = result.replace(/^loanlight-/, 'l/');
    return result;
}
function projectSlugFromPath(projectPath) {
    return path.resolve(projectPath).replace(/[\\/]/g, '-');
}
function discoverGitRepos(repoRoot) {
    const repos = [];
    const pending = [path.resolve(repoRoot)];
    while (pending.length > 0) {
        const current = pending.pop();
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        }
        catch {
            continue;
        }
        if (entries.some((entry) => entry.name === '.git' && (entry.isDirectory() || entry.isFile()))) {
            repos.push(current);
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name === '.git' || entry.isSymbolicLink())
                continue;
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
function getWorktreeBaseRef(repoPath) {
    const gitPath = path.join(repoPath, '.git');
    try {
        const stat = fs.statSync(gitPath);
        if (!stat.isFile())
            return null;
        const content = fs.readFileSync(gitPath, 'utf-8').trim();
        const match = content.match(/^gitdir:\s*(.+)$/);
        if (!match)
            return null;
        // gitdir target is `<main>/.git/worktrees/<name>` — main repo's .git is two levels up
        const mainGitDir = path.dirname(path.dirname(match[1]));
        const headPath = path.join(mainGitDir, 'HEAD');
        const head = fs.readFileSync(headPath, 'utf-8').trim();
        const refMatch = head.match(/^ref:\s*refs\/heads\/(.+)$/);
        return refMatch ? refMatch[1] : null;
    }
    catch {
        return null;
    }
}
export function parseSessionLine(line) {
    try {
        const obj = JSON.parse(line);
        if (obj.type !== 'assistant')
            return null;
        const ts = obj.timestamp;
        const backend = isBackend(obj.backend) ? obj.backend : 'claude';
        const usage = obj.message?.usage;
        if (typeof ts !== 'string' || !usage)
            return null;
        if (!Number.isFinite(new Date(ts).getTime()))
            return null;
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
    }
    catch {
        return null;
    }
}
// ---------------------------------------------------------------------------
// Session File Scanner with Incremental Cache
// ---------------------------------------------------------------------------
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB guard
const CACHE_VERSION = 3;
function isBackend(value) {
    return typeof value === 'string' && BACKENDS.includes(value);
}
function getMetricsTimeZone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
}
function emptyCache() {
    return { version: CACHE_VERSION, time_zone: getMetricsTimeZone(), files: {} };
}
function emptyDailyTokens() {
    return { turns: 0, input: 0, output: 0, cache_read: 0, cache_create: 0, tokens_per_backend: emptyBackendTokenBuckets() };
}
function addTokens(target, usage) {
    target.turns += 1;
    target.input += usage.input;
    target.output += usage.output;
    target.cache_read += usage.cache_read;
    target.cache_create += usage.cache_create;
}
function emptyBackendTokenTotals() {
    return { turns: 0, input: 0, output: 0, cache_read: 0, cache_create: 0 };
}
function emptyBackendTokenBuckets() {
    return Object.fromEntries(BACKENDS.map((backend) => [backend, emptyBackendTokenTotals()]));
}
function addBackendTokens(target, source) {
    target.turns += source.turns;
    target.input += source.input;
    target.output += source.output;
    target.cache_read += source.cache_read;
    target.cache_create += source.cache_create;
}
function addUsageToBackend(target, backend, usage) {
    target.tokens_per_backend ??= emptyBackendTokenBuckets();
    target.tokens_per_backend[backend] ??= emptyBackendTokenTotals();
    const bucket = target.tokens_per_backend[backend];
    bucket.turns += 1;
    bucket.input += usage.input;
    bucket.output += usage.output;
    bucket.cache_read += usage.cache_read;
    bucket.cache_create += usage.cache_create;
}
function mergeDailyTokens(target, source) {
    target.turns += source.turns;
    target.input += source.input;
    target.output += source.output;
    target.cache_read += source.cache_read;
    target.cache_create += source.cache_create;
    if (!source.tokens_per_backend)
        return;
    target.tokens_per_backend ??= emptyBackendTokenBuckets();
    for (const backend of BACKENDS) {
        const backendTokens = source.tokens_per_backend[backend];
        if (!backendTokens)
            continue;
        target.tokens_per_backend[backend] ??= emptyBackendTokenTotals();
        addBackendTokens(target.tokens_per_backend[backend], backendTokens);
    }
}
function parseJsonlFile(filePath) {
    const result = {};
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line)
            continue;
        const parsed = parseSessionLine(line);
        if (!parsed)
            continue;
        const date = formatLocalDateKey(new Date(parsed.timestamp));
        if (!result[date])
            result[date] = emptyDailyTokens();
        addTokens(result[date], parsed.usage);
        addUsageToBackend(result[date], parsed.backend, parsed.usage);
    }
    return result;
}
function loadCache(cachePath) {
    try {
        const parsed = readRecoverableJsonObject(cachePath);
        if (!parsed)
            return emptyCache();
        if (parsed.version !== CACHE_VERSION)
            return emptyCache();
        if (parsed.time_zone !== getMetricsTimeZone())
            return emptyCache();
        return parsed;
    }
    catch {
        return emptyCache();
    }
}
function saveCache(cachePath, cache) {
    try {
        const dir = path.dirname(cachePath);
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${cachePath}.tmp.${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(cache));
        fs.renameSync(tmp, cachePath);
    }
    catch (err) {
        const msg = safeErrorMessage(err);
        process.stderr.write(`[metrics] Cache write failed (non-fatal): ${msg}\n`);
    }
}
function readSessionSlugs(projectsDir) {
    try {
        return fs.readdirSync(projectsDir).filter((s) => !s.startsWith('-private-var-'));
    }
    catch {
        return null;
    }
}
function readSlugJsonlFiles(slugDir) {
    try {
        const stat = fs.statSync(slugDir);
        if (!stat.isDirectory())
            return null;
        return fs.readdirSync(slugDir).filter((f) => f.endsWith('.jsonl'));
    }
    catch {
        return null;
    }
}
function loadSessionFileData(filePath, cache) {
    let fstat;
    try {
        fstat = fs.statSync(filePath);
    }
    catch {
        return null;
    }
    if (fstat.size > MAX_FILE_BYTES)
        return null;
    const cached = cache.files[filePath];
    if (cached && cached.mtime === fstat.mtimeMs && cached.size === fstat.size) {
        return { fileData: cached.data, changed: false };
    }
    try {
        const fileData = parseJsonlFile(filePath);
        cache.files[filePath] = { mtime: fstat.mtimeMs, size: fstat.size, data: fileData };
        return { fileData, changed: true };
    }
    catch {
        return null;
    }
}
function mergeFileDataIntoResult(result, slug, fileData, since, until) {
    for (const [date, tokens] of Object.entries(fileData)) {
        if (date < since || date > until)
            continue;
        if (!result.has(slug))
            result.set(slug, new Map());
        const dateMap = result.get(slug);
        if (!dateMap.has(date))
            dateMap.set(date, emptyDailyTokens());
        const target = dateMap.get(date);
        mergeDailyTokens(target, tokens);
    }
}
function pruneMissingCacheFiles(cache, validPaths) {
    let changed = false;
    for (const cachedPath of Object.keys(cache.files)) {
        if (!validPaths.has(cachedPath)) {
            delete cache.files[cachedPath];
            changed = true;
        }
    }
    return changed;
}
export function scanSessionFiles(projectsDir, since, until, cachePath) {
    const result = new Map();
    const cache = loadCache(cachePath);
    let cacheChanged = false;
    const validPaths = new Set();
    const slugs = readSessionSlugs(projectsDir);
    if (!slugs)
        return result;
    for (const slug of slugs) {
        const slugDir = path.join(projectsDir, slug);
        const files = readSlugJsonlFiles(slugDir);
        if (!files)
            continue;
        for (const file of files) {
            const filePath = path.join(slugDir, file);
            validPaths.add(filePath);
            const loaded = loadSessionFileData(filePath, cache);
            if (!loaded)
                continue;
            cacheChanged = cacheChanged || loaded.changed;
            mergeFileDataIntoResult(result, slug, loaded.fileData, since, until);
        }
    }
    cacheChanged = pruneMissingCacheFiles(cache, validPaths) || cacheChanged;
    if (cacheChanged)
        saveCache(cachePath, cache);
    return result;
}
// ---------------------------------------------------------------------------
// Git Log Parser
// ---------------------------------------------------------------------------
const STAT_RE = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T/;
export function parseGitLogOutput(output) {
    const result = new Map();
    let currentDate = null;
    for (const rawLine of output.split('\n')) {
        const line = rawLine.trim();
        if (!line)
            continue;
        if (ISO_DATE_RE.test(line)) {
            const d = new Date(line);
            if (isNaN(d.getTime()))
                continue;
            currentDate = formatLocalDateKey(d);
            if (!result.has(currentDate))
                result.set(currentDate, { commits: 0, added: 0, removed: 0 });
            result.get(currentDate).commits += 1;
            continue;
        }
        const m = STAT_RE.exec(line);
        if (m && currentDate) {
            const entry = result.get(currentDate);
            entry.added += parseInt(m[2] || '0', 10);
            entry.removed += parseInt(m[3] || '0', 10);
        }
    }
    return result;
}
export function scanGitRepos(repoRoot, since, until) {
    const result = new Map();
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
                // default, and the `status !== 0` guard below then drops the whole repo
                // from the report silently — under-counted LOC that reads as real data.
                maxBuffer: UNBOUNDED_READ_MAX_BUFFER,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            if ((proc.status ?? 1) !== 0)
                continue;
            const locMap = parseGitLogOutput(proc.stdout || '');
            const boundedLocMap = new Map();
            for (const [date, totals] of locMap) {
                if (date < since || date > until)
                    continue;
                boundedLocMap.set(date, totals);
            }
            if (boundedLocMap.size > 0)
                result.set(repoSlug, boundedLocMap);
        }
        catch {
            // Individual repo failure is non-fatal
        }
    }
    return result;
}
// ---------------------------------------------------------------------------
// Report Builder
// ---------------------------------------------------------------------------
function emptyTotals() {
    return { turns: 0, input: 0, output: 0, cache_read: 0, cache_create: 0, commits: 0, added: 0, removed: 0 };
}
function buildProjectTotals(tokens, loc) {
    const projectTotals = new Map();
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
        if (!projectTotals.has(slug))
            projectTotals.set(slug, emptyTotals());
        const target = projectTotals.get(slug);
        for (const dl of dateMap.values()) {
            target.commits += dl.commits;
            target.added += dl.added;
            target.removed += dl.removed;
        }
    }
    return projectTotals;
}
function sumProjectTotals(projects) {
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
function aggregateBackendTotals(tokens) {
    const totals = emptyBackendTokenBuckets();
    for (const dateMap of tokens.values()) {
        for (const dt of dateMap.values()) {
            if (!dt.tokens_per_backend)
                continue;
            for (const backend of BACKENDS) {
                const backendTokens = dt.tokens_per_backend[backend];
                if (!backendTokens)
                    continue;
                addBackendTokens(totals[backend], backendTokens);
            }
        }
    }
    return totals;
}
export function buildReport(tokens, loc, since, until, grouping) {
    const dateSet = new Set();
    for (const dateMap of tokens.values()) {
        for (const date of dateMap.keys())
            dateSet.add(date);
    }
    for (const dateMap of loc.values()) {
        for (const date of dateMap.keys())
            dateSet.add(date);
    }
    const dates = [...dateSet].sort();
    const rows = dates.map((date) => {
        const projects = {};
        for (const [slug, dateMap] of tokens) {
            const dt = dateMap.get(date);
            if (dt)
                projects[slug] = dt;
        }
        const locData = {};
        for (const [repo, dateMap] of loc) {
            const dl = dateMap.get(date);
            if (dl)
                locData[repo] = dl;
        }
        return { date, projects, loc: locData };
    });
    const projects = [...buildProjectTotals(tokens, loc).entries()].map(([slug, totals]) => ({
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
const MAX_ACTIVITY_FILE_BYTES = 10 * 1024 * 1024; // 10 MB guard (mirrors standup)
function budgetKey(source, reason) {
    return `${source}::${reason}`;
}
/**
 * Normalize one activity event into a {source,reason} skip-flag use, or null if
 * the event is not a skip-flag event. `gate_skipped`/`readiness_skipped` carry
 * the reason in `gate_payload.reason`.
 */
export function extractSkipFlagUse(ev) {
    if (typeof ev !== 'object' || ev === null)
        return null;
    const obj = ev;
    const event = typeof obj.event === 'string' ? obj.event : '';
    if (!SKIP_FLAG_EVENT_NAMES.includes(event))
        return null;
    const source = typeof obj.source === 'string' && obj.source ? obj.source : 'pickle';
    const payload = typeof obj.gate_payload === 'object' && obj.gate_payload !== null
        ? obj.gate_payload
        : {};
    const rawReason = payload.reason;
    const reason = typeof rawReason === 'string' && rawReason ? rawReason : 'unspecified';
    return { event, source, reason };
}
/**
 * Scan `<activityDir>/*.jsonl` for skip-flag uses within the `[since, until]`
 * date window (inclusive local-date keys, matching the metrics report range).
 */
export function scanSkipFlagEvents(activityDir, since, until) {
    const out = [];
    let files;
    try {
        files = fs.readdirSync(activityDir).filter((f) => f.endsWith('.jsonl'));
    }
    catch {
        return out;
    }
    for (const file of files) {
        const filePath = path.join(activityDir, file);
        let content;
        try {
            const stat = fs.statSync(filePath);
            if (stat.size > MAX_ACTIVITY_FILE_BYTES)
                continue;
            content = fs.readFileSync(filePath, 'utf-8');
        }
        catch (err) {
            const msg = safeErrorMessage(err);
            process.stderr.write(`[metrics] skip-flag scan skipped ${file}: ${msg}\n`);
            continue;
        }
        for (const rawLine of content.split('\n')) {
            const line = rawLine.trim();
            if (!line)
                continue;
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                continue;
            }
            const ts = parsed?.ts;
            if (typeof ts !== 'string')
                continue;
            const dateKey = formatLocalDateKey(new Date(ts));
            if (dateKey < since || dateKey > until)
                continue;
            const use = extractSkipFlagUse(parsed);
            if (use)
                out.push(use);
        }
    }
    return out;
}
/**
 * Tally skip-flag uses per {source,reason} and flag any whose use count exceeds
 * its stated budget as a removal candidate (W5c). Keys on skip-flag-use rate
 * ONLY — there is no false-positive signal in the model.
 */
export function buildSkipFlagBudgetReport(events, budgets, since, until) {
    const tally = new Map();
    for (const ev of events) {
        const key = budgetKey(ev.source, ev.reason);
        const cur = tally.get(key);
        if (cur)
            cur.uses += 1;
        else
            tally.set(key, { source: ev.source, reason: ev.reason, uses: 1 });
    }
    const entries = [...tally.entries()].map(([key, t]) => {
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
/** Normalize one activity event into a readiness false-positive event, or null. */
export function extractReadinessFalsePositive(ev) {
    if (typeof ev !== 'object' || ev === null)
        return null;
    const obj = ev;
    if (obj.event !== READINESS_FALSE_POSITIVE_EVENT_NAME)
        return null;
    const session = typeof obj.session === 'string' && obj.session ? obj.session : 'unknown';
    const payload = typeof obj.gate_payload === 'object' && obj.gate_payload !== null
        ? obj.gate_payload
        : {};
    const rawCount = payload.suppressed_count;
    const suppressed_count = typeof rawCount === 'number' && Number.isFinite(rawCount) ? rawCount : 0;
    return { session, suppressed_count };
}
/**
 * Scan `<activityDir>/*.jsonl` for `readiness_false_positive_suppressed` events
 * within the `[since, until]` date window (mirrors `scanSkipFlagEvents`).
 */
export function scanReadinessFalsePositiveEvents(activityDir, since, until) {
    const out = [];
    let files;
    try {
        files = fs.readdirSync(activityDir).filter((f) => f.endsWith('.jsonl'));
    }
    catch {
        return out;
    }
    for (const file of files) {
        const filePath = path.join(activityDir, file);
        let content;
        try {
            const stat = fs.statSync(filePath);
            if (stat.size > MAX_ACTIVITY_FILE_BYTES)
                continue;
            content = fs.readFileSync(filePath, 'utf-8');
        }
        catch (err) {
            const msg = safeErrorMessage(err);
            process.stderr.write(`[metrics] readiness-false-positive scan skipped ${file}: ${msg}\n`);
            continue;
        }
        for (const rawLine of content.split('\n')) {
            const line = rawLine.trim();
            if (!line)
                continue;
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                continue;
            }
            const ts = parsed?.ts;
            if (typeof ts !== 'string')
                continue;
            const dateKey = formatLocalDateKey(new Date(ts));
            if (dateKey < since || dateKey > until)
                continue;
            const ev = extractReadinessFalsePositive(parsed);
            if (ev)
                out.push(ev);
        }
    }
    return out;
}
/**
 * Aggregate `readiness_false_positive_suppressed` events into a non-blocking
 * counter: total events and total suppressed prior findings over the window.
 */
export function buildReadinessFalsePositiveReport(events, since, until) {
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
];
/**
 * Scan `<activityDir>/*.jsonl` for the three refused-and-recovered events within
 * the `[since, until]` window (inclusive local-date keys, mirroring
 * `scanSkipFlagEvents` / `scanReadinessFalsePositiveEvents`). Returns per-event
 * counts; absent/empty dir yields all-zero (a healthy "no refusals" window).
 */
export function scanRefusedRecoveredCounts(activityDir, since, until) {
    const counts = {
        completion_finalize_refused: 0,
        phase_graduation_refused: 0,
        gate_parity_divergence: 0,
    };
    const eventSet = new Set(REFUSED_RECOVERED_EVENT_NAMES);
    let files;
    try {
        files = fs.readdirSync(activityDir).filter((f) => f.endsWith('.jsonl'));
    }
    catch {
        return { since, until, ...counts, total: 0 };
    }
    for (const file of files) {
        const filePath = path.join(activityDir, file);
        let content;
        try {
            const stat = fs.statSync(filePath);
            if (stat.size > MAX_ACTIVITY_FILE_BYTES) {
                continue;
            }
            content = fs.readFileSync(filePath, 'utf-8');
        }
        catch (err) {
            const msg = safeErrorMessage(err);
            process.stderr.write(`[metrics] refused-recovered scan skipped ${file}: ${msg}\n`);
            continue;
        }
        for (const rawLine of content.split('\n')) {
            const line = rawLine.trim();
            if (!line) {
                continue;
            }
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                continue;
            }
            const obj = parsed;
            const event = typeof obj.event === 'string' ? obj.event : '';
            if (!eventSet.has(event)) {
                continue;
            }
            const ts = obj.ts;
            if (typeof ts !== 'string') {
                continue;
            }
            const dateKey = formatLocalDateKey(new Date(ts));
            if (dateKey < since || dateKey > until) {
                continue;
            }
            counts[event] += 1;
        }
    }
    const total = counts.completion_finalize_refused + counts.phase_graduation_refused + counts.gate_parity_divergence;
    return { since, until, ...counts, total };
}

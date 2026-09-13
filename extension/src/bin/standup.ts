#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { ActivityEvent, UNBOUNDED_READ_MAX_BUFFER } from '../types/index.js';
import { getDataRoot } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';

const sm = new StateManager();

interface DateRange {
  since: Date;
  until: Date;
}

interface ParsedArgs {
  range: DateRange;
}

function parseExactLocalDate(dateStr: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [yearRaw, monthRaw, dayRaw] = dateStr.split('-');
  const year = Number(yearRaw);
  const monthIndex = Number(monthRaw) - 1;
  const day = Number(dayRaw);
  if (!Number.isInteger(year) || !Number.isInteger(monthIndex) || !Number.isInteger(day)) return null;
  const parsed = new Date(year, monthIndex, day);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== monthIndex ||
    parsed.getDate() !== day
  ) {
    return null;
  }
  parsed.setHours(0, 0, 0, 0);
  return parsed;
}

function consumeArg(argv: string[], i: number, flagName: string, hint: string): string {
  const val = argv[i + 1];
  if (val === undefined || val.startsWith('--')) {
    console.error(`Error: ${flagName} requires ${hint}.`);
    process.exit(1);
  }
  return val;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let days: number | null = null;
  let sinceStr: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--days') {
      const val = consumeArg(argv, i++, '--days', 'a numeric value');
      days = Number(val);
      if (!Number.isFinite(days) || days < 0 || Math.floor(days) !== days) {
        console.error(`Error: --days must be a non-negative integer, got "${val}".`);
        process.exit(1);
      }
    } else if (arg === '--since') {
      sinceStr = consumeArg(argv, i++, '--since', 'a YYYY-MM-DD value');
    } else {
      console.error(`Error: unknown flag "${arg}".`);
      process.exit(1);
    }
  }

  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (sinceStr !== null) {
    const parsed = parseExactLocalDate(sinceStr);
    if (parsed === null) {
      console.error(`Error: invalid date "${sinceStr}". Use YYYY-MM-DD format.`);
      process.exit(1);
    }
    const tomorrowMidnight = new Date(todayMidnight);
    tomorrowMidnight.setDate(tomorrowMidnight.getDate() + 1);
    if (parsed >= tomorrowMidnight) {
      console.error(`Error: --since date "${sinceStr}" is in the future.`);
      process.exit(1);
    }
    return { range: { since: parsed, until: tomorrowMidnight } };
  }

  // Default: --days 1
  const effectiveDays = days ?? 1;
  const until = new Date(todayMidnight);
  until.setDate(until.getDate() + 1); // always include today's file
  const since = new Date(todayMidnight);
  since.setDate(since.getDate() - effectiveDays);

  return { range: { since, until } };
}

/** Read working_dir from a session's state.json and extract the project name. */
function getSessionProject(sessionId: string): string | null {
  const sessionsDir = path.join(getDataRoot(), 'sessions');
  const stateFile = path.join(sessionsDir, sessionId, 'state.json');
  try {
    const wd = sm.read(stateFile).working_dir;
    if (typeof wd === 'string' && wd) {
      return path.basename(wd);
    }
  } catch {
    // state.json missing or unreadable
  }
  return null;
}

function dateToFilename(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function displayRangeEnd(untilExclusive: Date): string {
  const displayEnd = new Date(untilExclusive);
  displayEnd.setDate(displayEnd.getDate() - 1);
  return dateToFilename(displayEnd);
}

const MAX_ACTIVITY_FILE_BYTES = 10 * 1024 * 1024; // 10 MB guard

interface ParsedActivityFile {
  events: ActivityEvent[];
  totalLines: number;
  corruptLines: number;
}

/**
 * Parse one activity JSONL file, keeping only events whose timestamp falls in
 * the half-open `[sinceMs, untilMs)` window. The per-event range recheck is
 * intentional: filename prefiltering is coarse, so mispartitioned lines must be
 * re-validated here (standup activity-filtering trap door).
 */
function parseActivityFile(filePath: string, sinceMs: number, untilMs: number): ParsedActivityFile {
  const events: ActivityEvent[] = [];
  let totalLines = 0;
  let corruptLines = 0;

  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_ACTIVITY_FILE_BYTES) {
      console.error(`Warning: skipping ${path.basename(filePath)} (${Math.round(stat.size / 1024 / 1024)}MB exceeds 10MB limit).`);
      return { events, totalLines, corruptLines };
    }
  } catch {
    return { events, totalLines, corruptLines };
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());
  for (const line of lines) {
    totalLines++;
    try {
      const parsed = JSON.parse(line) as ActivityEvent;
      if (typeof parsed.ts === 'string' && typeof parsed.event === 'string') {
        const eventMs = new Date(parsed.ts).getTime();
        if (!Number.isFinite(eventMs) || eventMs < sinceMs || eventMs >= untilMs) {
          continue;
        }
        events.push(parsed);
      } else {
        corruptLines++;
      }
    } catch {
      corruptLines++;
    }
  }

  return { events, totalLines, corruptLines };
}

export function readActivityFiles(activityDir: string, since: Date, until: Date): ActivityEvent[] {
  if (!fs.existsSync(activityDir)) return [];

  let files: string[];
  try {
    files = fs.readdirSync(activityDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  const sinceMs = since.getTime();
  const untilMs = until.getTime();

  const matchingFiles = files.filter((f) => {
    const datepart = f.replace('.jsonl', '');
    const fileMs = new Date(datepart + 'T00:00:00').getTime();
    return Number.isFinite(fileMs) && fileMs >= sinceMs && fileMs < untilMs;
  });

  const events: ActivityEvent[] = [];
  let totalLines = 0;
  let corruptLines = 0;

  for (const file of matchingFiles) {
    const parsed = parseActivityFile(path.join(activityDir, file), sinceMs, untilMs);
    events.push(...parsed.events);
    totalLines += parsed.totalLines;
    corruptLines += parsed.corruptLines;
  }

  if (totalLines > 0 && corruptLines / totalLines > 0.1) {
    console.error(`Warning: ${corruptLines}/${totalLines} lines (${Math.round(100 * corruptLines / totalLines)}%) could not be parsed.`);
  }

  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return events;
}

export interface GitCommitEntry {
  authorEmail: string;
  subject: string;
}

export function getGitCommits(since: Date, untilExclusive?: Date): Map<string, GitCommitEntry> {
  const commits = new Map<string, GitCommitEntry>();
  try {
    const beforeArg = untilExclusive ? ` --before="${untilExclusive.toISOString()}"` : '';
    const output = execSync(`git log --after="${since.toISOString()}"${beforeArg} --pretty=format:"%aI%x09%H%x09%ae%x09%s"`, {
      encoding: 'utf-8',
      timeout: 10000,
      maxBuffer: UNBOUNDED_READ_MAX_BUFFER,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    for (const line of output.split('\n')) {
      if (!line) continue;
      // Tab-separated: author-date \t hash \t author-email \t subject. Subject may contain tabs in theory; join the remainder.
      const firstTab = line.indexOf('\t');
      if (firstTab <= 0) continue;
      const secondTab = line.indexOf('\t', firstTab + 1);
      if (secondTab <= firstTab) continue;
      const thirdTab = line.indexOf('\t', secondTab + 1);
      if (thirdTab <= secondTab) continue;
      const authoredAt = new Date(line.slice(0, firstTab));
      if (!Number.isFinite(authoredAt.getTime())) continue;
      if (authoredAt < since) continue;
      if (untilExclusive && authoredAt >= untilExclusive) continue;
      const hash = line.slice(firstTab + 1, secondTab);
      const authorEmail = line.slice(secondTab + 1, thirdTab).toLowerCase();
      const subject = line.slice(thirdTab + 1);
      if (!hash) continue;
      commits.set(hash, { authorEmail, subject });
    }
  } catch {
    // Not in a git repo or git not available — that's fine
  }
  return commits;
}

export function getCurrentUserEmail(): string | null {
  try {
    const out = execSync('git config user.email', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().toLowerCase();
    return out || null;
  } catch {
    return null;
  }
}

export interface GitOnlyCommit {
  hash: string;
  authorEmail: string;
  subject: string;
}

interface DeduplicatedCommits {
  hookCommits: ActivityEvent[];
  mineGitOnlyCommits: GitOnlyCommit[];
  teammateCommits: GitOnlyCommit[];
}

interface SessionEntry {
  sid: string;
  taskName: string;
  durationStr: string;
  iterationStr: string;
  mode: string;
  commits: ActivityEvent[];
  firstTs: string;
  project: string | null;
}

export function deduplicateCommits(
  events: ActivityEvent[],
  gitCommits: Map<string, GitCommitEntry>,
  currentUserEmail: string | null = null,
): DeduplicatedCommits {
  const hookCommits = events.filter((e) => e.event === 'commit' && e.commit_hash);
  const seenHashes = hookCommits.map((e) => e.commit_hash!);
  const seenSet = new Set(seenHashes);

  const mineGitOnlyCommits: GitOnlyCommit[] = [];
  const teammateCommits: GitOnlyCommit[] = [];
  const me = currentUserEmail ? currentUserEmail.toLowerCase() : null;

  for (const [hash, entry] of gitCommits) {
    if (seenSet.has(hash) || seenHashes.some((h) => h.startsWith(hash) || hash.startsWith(h))) continue;
    const authorEmailLower = (entry.authorEmail || '').toLowerCase();
    const out: GitOnlyCommit = { hash, authorEmail: authorEmailLower, subject: entry.subject };
    // If we don't know who "me" is, preserve old behavior: everyone bucketed as mine (no teammate section emitted).
    if (me === null || authorEmailLower === me) {
      mineGitOnlyCommits.push(out);
    } else {
      teammateCommits.push(out);
    }
  }

  return { hookCommits, mineGitOnlyCommits, teammateCommits };
}

function groupNonCommitEvents(nonCommitEvents: ActivityEvent[]): {
  sessionEvents: Map<string, ActivityEvent[]>;
  adhocEvents: ActivityEvent[];
} {
  const sessionEvents = new Map<string, ActivityEvent[]>();
  const adhocEvents: ActivityEvent[] = [];

  for (const e of nonCommitEvents) {
    if (!e.session) {
      adhocEvents.push(e);
      continue;
    }
    const list = sessionEvents.get(e.session) || [];
    list.push(e);
    sessionEvents.set(e.session, list);
  }

  return { sessionEvents, adhocEvents };
}

function attributeHookCommits(
  hookCommits: ActivityEvent[],
  sessionEvents: Map<string, ActivityEvent[]>,
): { sessionCommits: Map<string, ActivityEvent[]>; adhocHookCommits: ActivityEvent[] } {
  const sessionCommits = new Map<string, ActivityEvent[]>();
  const adhocHookCommits: ActivityEvent[] = [];

  for (const c of hookCommits) {
    if (c.session) {
      if (!sessionEvents.has(c.session)) sessionEvents.set(c.session, []);
      const list = sessionCommits.get(c.session) || [];
      list.push(c);
      sessionCommits.set(c.session, list);
      continue;
    }
    if (!attributeCommitByTimestamp(c, sessionEvents, sessionCommits)) {
      adhocHookCommits.push(c);
    }
  }

  return { sessionCommits, adhocHookCommits };
}

function attributeCommitByTimestamp(
  commit: ActivityEvent,
  sessionEvents: Map<string, ActivityEvent[]>,
  sessionCommits: Map<string, ActivityEvent[]>,
): boolean {
  for (const [sid, sevts] of sessionEvents) {
    if (sevts.length === 0) continue;
    const firstTs = sevts[0].ts;
    const lastTs = sevts[sevts.length - 1].ts;
    if (commit.ts < firstTs || commit.ts > lastTs) continue;
    const list = sessionCommits.get(sid) || [];
    list.push(commit);
    sessionCommits.set(sid, list);
    return true;
  }
  return false;
}

// R-PSU-1 / AC-PSU-01 — drop test/debate/pipeline-noise sessions before they reach
// stdout. Patterns are anchored on the session id (or its prompt-derived prefix);
// a session id matching ANY pattern is filtered. Matches the operator-supplied
// catalogue from the 2026-05-07 standup forensic report.
const STANDUP_NOISE_PATTERNS: readonly RegExp[] = [
  /^effort-.*-test$/,
  /^chain-.*-test$/,
  /^display-sync-test/,
  /^pipeline-dispatch-session-/,
  /^citadel-pipeline-session-/,
  /^pickle-debate-/,
] as const;

export function classifyStandupNoise(sid: string, prompt?: string): { dropped: boolean; reason: string } {
  const candidates = [sid, prompt ?? ''];
  for (const candidate of candidates) {
    if (!candidate) continue;
    for (const re of STANDUP_NOISE_PATTERNS) {
      if (re.test(candidate)) {
        return { dropped: true, reason: `matches noise pattern ${re.source}` };
      }
    }
  }
  return { dropped: false, reason: '' };
}

function buildSessionEntries(
  sessionEvents: Map<string, ActivityEvent[]>,
  sessionCommits: Map<string, ActivityEvent[]>,
): SessionEntry[] {
  const LIFECYCLE_ONLY = new Set(['session_start', 'session_end']);
  const keptSessions: Array<[string, ActivityEvent[]]> = [];
  for (const [sid, sevts] of sessionEvents.entries()) {
    const commits = sessionCommits.get(sid) || [];
    const hasMeaningfulEvents = sevts.some((e) => !LIFECYCLE_ONLY.has(e.event));
    if (!(commits.length > 0 || hasMeaningfulEvents)) continue;
    const startEvent = sevts.find((e) => e.event === 'session_start');
    const noise = classifyStandupNoise(sid, startEvent?.original_prompt);
    if (noise.dropped) {
      process.stderr.write(`[standup] dropped session ${sid}: ${noise.reason}\n`);
      continue;
    }
    keptSessions.push([sid, sevts]);
  }

  const sessionEntries = keptSessions.map(([sid, sevts]) =>
    buildSessionEntry(sid, sevts, sessionCommits.get(sid) || []),
  );

  sessionEntries.sort((a, b) => (a.firstTs > b.firstTs ? -1 : a.firstTs < b.firstTs ? 1 : 0));
  return sessionEntries;
}

function buildSessionEntry(sid: string, sevts: ActivityEvent[], commits: ActivityEvent[]): SessionEntry {
  const startEvent = sevts.find((e) => e.event === 'session_start');
  const prompt = startEvent?.original_prompt;
  const taskName = prompt ? (prompt.length > 60 ? prompt.slice(0, 60) + '...' : prompt) : sid;

  const allTs = sevts.map((e) => e.ts);
  for (const c of commits) allTs.push(c.ts);
  allTs.sort();

  const firstTs = allTs[0] || '';
  const lastTs = allTs[allTs.length - 1] || firstTs;
  const durationMs = new Date(lastTs).getTime() - new Date(firstTs).getTime();
  const durationMin = Math.floor(durationMs / 60000);
  const hours = Math.floor(durationMin / 60);
  const mins = durationMin % 60;
  const durationStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  const iterationStarts = sevts.filter((e) => e.event === 'iteration_start');
  const iterationCount = iterationStarts.length;
  const iterationStr = iterationCount > 0 ? `${iterationCount} iteration${iterationCount === 1 ? '' : 's'}` : '? iterations';
  const mode = startEvent?.mode || (iterationCount > 0 ? 'tmux' : 'inline');

  return { sid, taskName, durationStr, iterationStr, mode, commits, firstTs, project: getSessionProject(sid) };
}

function appendSessionSections(lines: string[], sessionEntries: SessionEntry[]): void {
  for (const s of sessionEntries) {
    const projectTag = s.project ? ` [${s.project}]` : '';
    lines.push(`## ${s.taskName}${projectTag} (${s.sid})`);
    lines.push(`- **Duration**: ${s.durationStr} (${s.iterationStr})`);
    lines.push(`- **Mode**: ${s.mode}`);
    if (s.commits.length > 0) {
      lines.push('- **Commits**:');
      for (const c of s.commits) {
        const msg = c.commit_message || '(no message)';
        lines.push(`  - \`${c.commit_hash?.slice(0, 7)}\` ${msg}`);
      }
    }
    lines.push('');
  }
}

function appendAdhocCommitSection(
  lines: string[],
  adhocHookCommits: ActivityEvent[],
  mineGitOnlyCommits: GitOnlyCommit[],
): void {
  if (adhocHookCommits.length === 0 && mineGitOnlyCommits.length === 0) return;

  lines.push('## Ad-hoc Commits');
  for (const c of adhocHookCommits) {
    const msg = c.commit_message || '(no message)';
    lines.push(`- \`${c.commit_hash?.slice(0, 7)}\` ${msg}`);
  }
  for (const { hash, subject } of mineGitOnlyCommits) {
    lines.push(`- \`${hash.slice(0, 7)}\` ${subject}`);
  }
  lines.push('');
}

function appendTeammateSection(lines: string[], teammateCommits: GitOnlyCommit[]): void {
  if (teammateCommits.length === 0) return;

  lines.push('## Teammate PRs merged');
  for (const { hash, authorEmail, subject } of teammateCommits) {
    const atIdx = authorEmail.indexOf('@');
    const localPart = atIdx > 0 ? authorEmail.slice(0, atIdx) : authorEmail;
    lines.push(`- \`${hash.slice(0, 7)}\` (${localPart}) ${subject}`);
  }
  lines.push('');
}

function appendAdhocActivitySection(lines: string[], adhocEvents: ActivityEvent[]): void {
  if (adhocEvents.length === 0) return;

  lines.push('## Ad-hoc Activity');
  for (const e of adhocEvents) {
    const time = e.ts.slice(11, 16);
    const detail = e.title || e.ticket || e.step || '';
    lines.push(`- \`${time}\` **${e.event}**${detail ? ` — ${detail}` : ''}`);
  }
  lines.push('');
}

export function formatOutput(
  events: ActivityEvent[],
  hookCommits: ActivityEvent[],
  mineGitOnlyCommits: GitOnlyCommit[],
  teammateCommits: GitOnlyCommit[],
  since: Date,
  until: Date,
): string {
  const sinceStr = dateToFilename(since);
  const untilStr = displayRangeEnd(until);
  const nonCommitEvents = events.filter((e) => e.event !== 'commit');
  const hasContent = nonCommitEvents.length > 0 || hookCommits.length > 0
    || mineGitOnlyCommits.length > 0 || teammateCommits.length > 0;

  if (!hasContent) {
    return `No activity found for ${sinceStr} to ${untilStr}.`;
  }

  const { sessionEvents, adhocEvents } = groupNonCommitEvents(nonCommitEvents);
  const { sessionCommits, adhocHookCommits } = attributeHookCommits(hookCommits, sessionEvents);
  const sessionEntries = buildSessionEntries(sessionEvents, sessionCommits);
  const lines: string[] = [];
  lines.push(`# Standup — ${sinceStr} to ${untilStr}`);
  lines.push('');

  appendSessionSections(lines, sessionEntries);
  appendAdhocCommitSection(lines, adhocHookCommits, mineGitOnlyCommits);
  appendTeammateSection(lines, teammateCommits);
  appendAdhocActivitySection(lines, adhocEvents);

  return lines.join('\n');
}

function main(): void {
  const { range } = parseArgs(process.argv.slice(2));
  const activityDir = path.join(getDataRoot(), 'activity');
  const events = readActivityFiles(activityDir, range.since, range.until);
  const gitCommits = getGitCommits(range.since, range.until);
  const currentUserEmail = getCurrentUserEmail();
  const { hookCommits, mineGitOnlyCommits, teammateCommits } = deduplicateCommits(events, gitCommits, currentUserEmail);
  const output = formatOutput(events, hookCommits, mineGitOnlyCommits, teammateCommits, range.since, range.until);
  console.log(output);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'standup.js') {
  main();
}

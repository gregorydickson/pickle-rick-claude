import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

// R-SIGF: shared detector module for signature-change-caller-gap analysis.
// Consumed by check-readiness.ts (WS-1/WS-2) and forward by WS-3 (scope-resolution).
// Moved here from check-readiness.ts to avoid divergent copies.

const GIT_LS_FILES_TIMEOUT_MS = 30_000;

function gitTrackedFiles(repoRoot: string): string[] {
  const result = spawnSync('git', ['ls-files'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    timeout: GIT_LS_FILES_TIMEOUT_MS,
  });
  if (result.status !== 0) return [];
  return result.stdout.split('\n').filter(Boolean);
}

export interface ResolverCache {
  trackedSourceFiles: string[];
  trackedAllFiles?: string[];
  externalDtsFiles?: string[];
  fileContents: Map<string, string>;
  deadline: number;
  truncated: boolean;
  allowlist: Set<string>;
}

export function createResolverCache(repoRoot: string, maxWallMs: number, allowlist: Set<string> = new Set()): ResolverCache {
  // R-RTRC-3: lift the tests/ exclusion ONLY. Symbols defined in test files
  // (helpers, test fixtures) are valid resolution targets — the prior filter
  // produced false positives whenever a ticket cited a test-defined helper.
  // Extension allowlist (ts|tsx|js|jsx|mjs|cjs) is unchanged.
  const tracked = gitTrackedFiles(repoRoot)
    .filter((file) => /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file));
  return {
    trackedSourceFiles: tracked,
    fileContents: new Map<string, string>(),
    deadline: Date.now() + maxWallMs,
    truncated: false,
    allowlist,
  };
}

function readCachedFile(absPath: string, cache: ResolverCache): string | undefined {
  const cached = cache.fileContents.get(absPath);
  if (cached !== undefined) return cached;
  try {
    const content = fs.readFileSync(absPath, 'utf-8');
    cache.fileContents.set(absPath, content);
    return content;
  } catch {
    return undefined;
  }
}

// Phrases that signal a NEW positional parameter / injection is being added.
const ARITY_ADD_CUE_RE = /\b(?:add(?:s|ing|ed)?|introduc(?:e|es|ing|ed)|new|append(?:s|ing|ed)?|inject(?:s|ing|ed)?)\b[^.\n]{0,60}\b(?:constructor\s+(?:param(?:eter)?|arg(?:ument)?|injection|dependency)|(?:param(?:eter)?|arg(?:ument)?|injection|dependency)\s+to\s+the\s+constructor|\d+(?:st|nd|rd|th)\s+(?:constructor\s+)?(?:param(?:eter)?|arg(?:ument)?)|new\s+(?:injected\s+)?(?:param(?:eter)?|arg(?:ument)?|dependency|service))\b/i;

// Captures a PascalCase service/class symbol named near an arity cue. We look for
// the symbol either as a backticked token or as the subject of a `new X(` form in
// the ticket body.
const PASCAL_SYMBOL_RE = /\b([A-Z][A-Za-z0-9]*(?:Service|Manager|Resolver|Provider|Client|Repository|Store|Gateway|Adapter|Controller|Handler|Factory|Runner|Engine|Auditor|Analyzer|Validator|Collector|Builder))\b/g;

// True when a tracked file is declared in-scope by ANY ticket in the bundle (so a
// positional caller there is fixable by a fenced worker and must NOT be flagged).
function isCallerInBundleScope(trackedFile: string, declaredAll: Set<string>): boolean {
  if (declaredAll.has(trackedFile)) return true;
  for (const declared of declaredAll) {
    if (trackedFile === declared || trackedFile.endsWith(`/${declared}`) || declared.endsWith(`/${trackedFile}`)) {
      return true;
    }
  }
  return false;
}

// Candidate caller files: tracked specs + factory/builder TS files. Bound the
// corpus to keep the scan cheap.
function callerCandidateFiles(repoRoot: string, cache?: ResolverCache): string[] {
  const tracked = cache?.trackedAllFiles ?? gitTrackedFiles(repoRoot);
  if (cache && cache.trackedAllFiles === undefined) cache.trackedAllFiles = tracked;
  return tracked.filter((file) => /\.spec\.ts$/.test(file) || /(?:factory|factories|builder)[^/]*\.ts$/i.test(file));
}

// Extract candidate symbols whose arity the ticket claims to change.
function extractAritySymbols(content: string): string[] {
  const symbols = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    if (!ARITY_ADD_CUE_RE.test(rawLine)) continue;
    PASCAL_SYMBOL_RE.lastIndex = 0;
    for (const match of rawLine.matchAll(PASCAL_SYMBOL_RE)) symbols.add(match[1]);
    // Also harvest a `new X(` subject on the cue line even if the suffix list misses it.
    for (const match of rawLine.matchAll(/\bnew\s+([A-Z][A-Za-z0-9]*)\s*\(/g)) symbols.add(match[1]);
  }
  return [...symbols];
}

export interface CallerGap {
  symbol: string;
  kind: 'arity' | 'schema-shape';
  outOfScopeCallers: string[];
}

export interface CallerGapInput {
  ticketContents: string[];
  declaredFiles: Set<string>;
  repoRoot: string;
  cache?: ResolverCache;
}

export function detectSignatureCallerGaps(input: CallerGapInput): CallerGap[] {
  try {
    const { ticketContents, declaredFiles, repoRoot, cache } = input;
    const candidates = callerCandidateFiles(repoRoot, cache);
    const gaps: CallerGap[] = [];
    for (const content of ticketContents) {
      for (const symbol of extractAritySymbols(content)) {
        const callerRe = new RegExp(`\\bnew\\s+${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`);
        const outOfScopeCallers = candidates.filter((file) => {
          if (isCallerInBundleScope(file, declaredFiles)) return false;
          const abs = path.join(repoRoot, file);
          const body = cache ? readCachedFile(abs, cache) : (fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : undefined);
          return body !== undefined && callerRe.test(body);
        });
        if (outOfScopeCallers.length === 0) continue;
        gaps.push({ symbol, kind: 'arity', outOfScopeCallers });
      }
    }
    return gaps;
  } catch {
    return [];
  }
}

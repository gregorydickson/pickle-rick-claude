import * as fs from 'fs';
import * as path from 'path';
import { DiffEntry, getDiffFiles, runGitSafe } from '../git-utils.js';
import { TEST_FILE_PATTERN, toPosixPath, uniqueSortedStrings } from './reporter.js';

export type ChangedFileKind = 'production' | 'test';

export interface ChangedLineRange {
  start: number;
  end: number;
}

export interface BlameCommitSummary {
  commit: string;
  author: string;
  summary: string;
  lines: number[];
}

export interface ChangedFileSummary {
  path: string;
  status: DiffEntry['status'];
  kind: ChangedFileKind;
  changedLines: ChangedLineRange[];
  blame: BlameCommitSummary[];
}

export interface DiffSummary {
  range: string;
  base: string;
  head: string;
  repoRoot: string;
  changedFiles: ChangedFileSummary[];
  claudeFiles: string[];
}

export interface WalkDiffOptions {
  repoRoot?: string;
}

interface ParsedRange {
  base: string;
  head: string;
}

interface BlameBlock {
  commit: string;
  author: string;
  summary: string;
  line?: number;
}

const DEFAULT_HEAD = 'HEAD';
const SKIPPED_CLAUDE_DIRS = new Set(['.git', 'node_modules']);

export function walkDiff(range: string, options: WalkDiffOptions = {}): DiffSummary {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const parsed = parseRange(range);
  const diffEntries = stableDiffEntries(getDiffFiles(parsed.base, parsed.head, repoRoot));
  const changedFiles = diffEntries.map((entry) => summarizeChangedFile(entry, parsed, repoRoot));

  return {
    range,
    base: parsed.base,
    head: parsed.head,
    repoRoot,
    changedFiles,
    claudeFiles: findClaudeFiles(changedFiles.map((file) => file.path), repoRoot),
  };
}

function parseRange(range: string): ParsedRange {
  const trimmed = range.trim();
  if (!trimmed) {
    throw new Error('Diff range must not be empty');
  }
  const tripleDot = trimmed.split('...');
  if (tripleDot.length === 2 && tripleDot[0] && tripleDot[1]) {
    return { base: tripleDot[0], head: tripleDot[1] };
  }
  const doubleDot = trimmed.split('..');
  if (doubleDot.length === 2 && doubleDot[0] && doubleDot[1]) {
    return { base: doubleDot[0], head: doubleDot[1] };
  }
  return { base: trimmed, head: DEFAULT_HEAD };
}

function stableDiffEntries(entries: DiffEntry[]): DiffEntry[] {
  return [...entries].sort((a, b) => a.path.localeCompare(b.path) || a.status.localeCompare(b.status));
}

function summarizeChangedFile(entry: DiffEntry, range: ParsedRange, repoRoot: string): ChangedFileSummary {
  const changedLines = entry.status === 'D' ? [] : getChangedLineRanges(entry.path, range, repoRoot);
  return {
    path: entry.path,
    status: entry.status,
    kind: classifyChangedFile(entry.path),
    changedLines,
    blame: summarizeBlame(entry.path, changedLines, range.head, repoRoot),
  };
}

function classifyChangedFile(filePath: string): ChangedFileKind {
  return TEST_FILE_PATTERN.test(toPosixPath(filePath)) ? 'test' : 'production';
}

function getChangedLineRanges(filePath: string, range: ParsedRange, repoRoot: string): ChangedLineRange[] {
  // Per-file git calls MUST fail soft: walkDiff runs UNwrapped by safeRunAnalyzer
  // (audit-runner.ts:84), and its output feeds every downstream analyzer. One
  // changed path the aggregate diff accepts but a per-file command rejects
  // (submodule/gitlink pointer, type-change, path absent at head) otherwise
  // throws out of buildCitadelAuditReport and crashes the ENTIRE Citadel audit.
  // getDiffFiles already succeeded (check=true); degrade this file's metadata to
  // empty (check=false → '' on non-zero exit) instead of killing the whole run.
  const out = runGitSafe(['diff', `${range.base}...${range.head}`, '--unified=0', '--', filePath], repoRoot);
  const ranges: ChangedLineRange[] = [];
  for (const line of out.split(/\r?\n/)) {
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;
    const start = finiteNumber(match[1], 0);
    const count = match[2] === undefined ? 1 : finiteNumber(match[2], 0);
    if (count <= 0) continue;
    ranges.push({ start, end: start + count - 1 });
  }
  return mergeLineRanges(ranges);
}

function mergeLineRanges(ranges: ChangedLineRange[]): ChangedLineRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: ChangedLineRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function summarizeBlame(
  filePath: string,
  changedLines: ChangedLineRange[],
  head: string,
  repoRoot: string,
): BlameCommitSummary[] {
  const commits = new Map<string, BlameCommitSummary>();
  for (const range of changedLines) {
    // Fail soft (check=false): a gitlink/submodule pointer or type-change in the
    // diff makes `git blame -L start,end head -- file` exit non-zero ("fatal: no
    // such path"). walkDiff is UNwrapped (audit-runner.ts:84), so an unguarded
    // throw here would crash the entire Citadel audit over one un-blameable file.
    const output = runGitSafe(['blame', '--line-porcelain', '-L', `${range.start},${range.end}`, head, '--', filePath], repoRoot);
    for (const block of parseBlamePorcelain(output)) {
      if (block.line === undefined) continue;
      const current = commits.get(block.commit) ?? {
        commit: block.commit,
        author: block.author,
        summary: block.summary,
        lines: [],
      };
      current.author = current.author || block.author;
      current.summary = current.summary || block.summary;
      current.lines.push(block.line);
      commits.set(block.commit, current);
    }
  }
  return [...commits.values()]
    .map((commit) => ({ ...commit, lines: uniqueSortedNumbers(commit.lines) }))
    .sort((a, b) => a.lines[0] - b.lines[0] || a.commit.localeCompare(b.commit));
}

function parseBlamePorcelain(output: string): BlameBlock[] {
  const blocks: BlameBlock[] = [];
  let current: BlameBlock | undefined;
  for (const line of output.split(/\r?\n/)) {
    const header = line.match(/^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/);
    if (header) {
      current = { commit: header[1], line: finiteNumber(header[2], 0), author: '', summary: '' };
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('author ')) {
      current.author = line.slice('author '.length);
    } else if (line.startsWith('summary ')) {
      current.summary = line.slice('summary '.length);
    }
  }
  return blocks;
}

function uniqueSortedNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function findClaudeFiles(changedPaths: string[], repoRoot: string): string[] {
  const found = new Set<string>();
  const directories = uniqueSortedStrings(changedPaths.map((filePath) => path.dirname(filePath)));
  for (const directory of directories) {
    collectClaudeFiles(path.join(repoRoot, directory), repoRoot, found);
  }
  return uniqueSortedStrings([...found]);
}

function collectClaudeFiles(directory: string, repoRoot: string, found: Set<string>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === 'CLAUDE.md') {
      found.add(toPosixPath(path.relative(repoRoot, fullPath)));
    } else if (entry.isDirectory() && !SKIPPED_CLAUDE_DIRS.has(entry.name)) {
      collectClaudeFiles(fullPath, repoRoot, found);
    }
  }
}

function finiteNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

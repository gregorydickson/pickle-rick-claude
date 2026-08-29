import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { CitadelFinding, slugify } from './reporter.js';
import { DiffSummary } from './diff-walker.js';

export interface BannedConstructsResult {
  findings: CitadelFinding[];
}

export interface ChangedSourceLine {
  no: number;
  text: string;
}

export interface ChangedSource {
  file: string;
  lines: ChangedSourceLine[];
}

const CODE_FILE_RE = /\.[cm]?[jt]sx?$/i;

export function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//')
    || trimmed.startsWith('/*')
    || trimmed.startsWith('*')
    || trimmed.startsWith('*/');
}

/**
 * Neutralize string/template/char-literal CONTENTS so construct detectors do not match code-like
 * text inside string data (e.g. `"if (x) y"`). Escapes are preserved by the `\\.` alternative.
 */
export function stripStringLiterals(line: string): string {
  return line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/**
 * Read each non-deleted changed code file and slice its changed-line ranges into addressable
 * {no, text} pairs. Per-file try/catch (skip) keeps one unreadable working-tree file from losing
 * the rest — this analyzer is wrapped by safeRunAnalyzer, but the defensive skip mirrors the
 * schema-registry-drift precedent.
 */
export function collectChangedCodeLines(diff: DiffSummary): ChangedSource[] {
  const sources: ChangedSource[] = [];
  for (const changed of diff.changedFiles) {
    if (changed.status === 'D' || !CODE_FILE_RE.test(changed.path)) continue;
    let content: string;
    try {
      content = readFileSync(path.resolve(diff.repoRoot, changed.path), 'utf-8');
    } catch {
      continue;
    }
    const fileLines = content.split(/\r?\n/);
    const lines: ChangedSourceLine[] = [];
    for (const range of changed.changedLines) {
      for (let lineNo = range.start; lineNo <= range.end; lineNo++) {
        const text = fileLines[lineNo - 1];
        if (text !== undefined) lines.push({ no: lineNo, text });
      }
    }
    if (lines.length > 0) sources.push({ file: changed.path, lines });
  }
  return sources;
}

/**
 * A nested/chained ternary: after removing optional-chaining (`?.`), nullish (`??`), and TS optional
 * markers (`?:`), the line still carries two or more ternary `?` and two or more `:`.
 */
export function isNestedTernary(line: string): boolean {
  const cleaned = stripStringLiterals(line)
    .replace(/\?\./g, '')
    .replace(/\?\?/g, '')
    .replace(/\?:/g, ':');
  const ternaryQ = (cleaned.match(/\?/g) ?? []).length;
  const colons = (cleaned.match(/:/g) ?? []).length;
  return ternaryQ >= 2 && colons >= 2;
}

export function findBannedConstructs(sources: ChangedSource[]): CitadelFinding[] {
  const findings: CitadelFinding[] = [];
  for (const source of sources) {
    for (const { no, text } of source.lines) {
      if (isCommentLine(text)) continue;
      if (isNestedTernary(text)) {
        findings.push({
          id: `banned-construct:nested-ternary:${slugify(source.file)}:${no}`,
          severity: 'Medium',
          file: source.file,
          line: no,
          message:
            `Nested/chained ternary at ${source.file}:${no} is banned by CLAUDE.md; `
            + 'extract it into an if/else block or named intermediate variables.',
        });
      }
    }
  }
  return findings;
}

export function auditBannedConstructs(diff: DiffSummary): BannedConstructsResult {
  return { findings: findBannedConstructs(collectChangedCodeLines(diff)) };
}

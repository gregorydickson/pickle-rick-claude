import { readFileSync } from 'node:fs';
import * as path from 'node:path';
const CODE_FILE_RE = /\.[cm]?[jt]sx?$/i;
export function isCommentLine(line) {
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
export function stripStringLiterals(line) {
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
export function collectChangedCodeLines(diff) {
    const sources = [];
    for (const changed of diff.changedFiles) {
        if (changed.status === 'D' || !CODE_FILE_RE.test(changed.path))
            continue;
        let content;
        try {
            content = readFileSync(path.resolve(diff.repoRoot, changed.path), 'utf-8');
        }
        catch {
            continue;
        }
        const fileLines = content.split(/\r?\n/);
        const lines = [];
        for (const range of changed.changedLines) {
            for (let lineNo = range.start; lineNo <= range.end; lineNo++) {
                const text = fileLines[lineNo - 1];
                if (text !== undefined)
                    lines.push({ no: lineNo, text });
            }
        }
        if (lines.length > 0)
            sources.push({ file: changed.path, lines });
    }
    return sources;
}
/**
 * No construct arm remains — the last one (isNestedTernary) carried a fabricated CLAUDE.md
 * citation, same as the already-deleted isBraceFreeIf. This module stays wired to
 * collectChangedCodeLines/isCommentLine/stripStringLiterals, which banned-casts-audit.ts
 * imports, so a real construct rule can be added here without re-plumbing.
 */
export function findBannedConstructs(_sources) {
    return [];
}
export function auditBannedConstructs(diff) {
    return { findings: findBannedConstructs(collectChangedCodeLines(diff)) };
}

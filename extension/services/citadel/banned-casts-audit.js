import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { slugify } from './reporter.js';
import { collectChangedCodeLines, isCommentLine, stripStringLiterals, } from './banned-constructs-audit.js';
const AS_ERROR_ACCESS_RE = /\(\s*[\w$.[\]]+\s+as\s+Error\s*\)\s*\./;
const AS_ANY_RE = /\bas\s+any\b/;
const AS_NEVER_RE = /\bas\s+never\b/;
const CAST_SEVERITY = 'Medium';
export function hasAsErrorCast(line) {
    return AS_ERROR_ACCESS_RE.test(stripStringLiterals(line));
}
export function hasAsAnyCast(line) {
    return AS_ANY_RE.test(stripStringLiterals(line));
}
export function hasAsNeverCast(line) {
    return AS_NEVER_RE.test(stripStringLiterals(line));
}
export function findBannedCasts(sources) {
    const findings = [];
    for (const source of sources) {
        for (const { no, text } of source.lines) {
            if (isCommentLine(text))
                continue;
            if (hasAsErrorCast(text)) {
                findings.push({
                    id: `banned-cast:as-error:${slugify(source.file)}:${no}`,
                    severity: CAST_SEVERITY,
                    file: source.file,
                    line: no,
                    message: `Unsafe \`(x as Error).\` cast at ${source.file}:${no} is banned by CLAUDE.md; `
                        + 'use `const msg = err instanceof Error ? err.message : String(err);`.',
                });
            }
            if (hasAsAnyCast(text)) {
                findings.push({
                    id: `banned-cast:as-any:${slugify(source.file)}:${no}`,
                    severity: CAST_SEVERITY,
                    file: source.file,
                    line: no,
                    message: `\`as any\` cast at ${source.file}:${no} is banned by CLAUDE.md; `
                        + 'replace it with the project type or `unknown` plus a narrowing guard.',
                });
            }
            if (hasAsNeverCast(text)) {
                findings.push({
                    id: `banned-cast:as-never:${slugify(source.file)}:${no}`,
                    severity: CAST_SEVERITY,
                    file: source.file,
                    line: no,
                    message: `\`as never\` cast at ${source.file}:${no} is banned; `
                        + 'use a proper type guard or narrow the union explicitly instead of casting through `never`.',
                });
            }
        }
    }
    return findings;
}
const NO_EXPLICIT_ANY_RE = /no-explicit-any['"]?\s*[:,]?\s*[[\s'"]*(\w+)/;
const RULE_OFF = new Set(['off', '0']);
function nearestEslintConfigText(repoRoot, file) {
    const root = path.resolve(repoRoot);
    let dir = path.dirname(path.resolve(root, file));
    for (;;) {
        try {
            const name = readdirSync(dir).find((n) => n.startsWith('eslint.config.') || n.startsWith('.eslintrc'));
            if (name !== undefined)
                return readFileSync(path.join(dir, name), 'utf-8');
        }
        catch {
            return null;
        }
        if (dir === root || !dir.startsWith(root) || !existsSync(path.dirname(dir)))
            return null;
        dir = path.dirname(dir);
    }
}
function targetBansCasts(repoRoot, file) {
    const text = nearestEslintConfigText(repoRoot, file);
    const level = text === null ? undefined : NO_EXPLICIT_ANY_RE.exec(text)?.[1];
    return level !== undefined && !RULE_OFF.has(level);
}
export function auditBannedCasts(diff) {
    const sources = collectChangedCodeLines(diff).filter((s) => targetBansCasts(diff.repoRoot, s.file));
    return { findings: findBannedCasts(sources) };
}

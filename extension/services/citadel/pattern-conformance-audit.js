import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { slugify } from './reporter.js';
import { extractTrapDoorsSection } from './trap-doors-section.js';
// Flags diff hunks that violate harvested PATTERN_SHAPE declarations and SQL ON CONFLICT clobbers.
// Report-only; never halts, never auto-fixes.
export function auditPatternConformance(diff) {
    const findings = [];
    // Phase 1: PATTERN_SHAPE conformance
    const claudeMdFiles = collectClaudeMdFiles(diff.repoRoot);
    const rules = harvestPatternRules(claudeMdFiles);
    for (const rule of rules) {
        const matchedFile = diff.changedFiles.find((f) => f.status !== 'D' && pathSuffixMatch(f.path, rule.targetFile));
        if (!matchedFile)
            continue;
        const absPath = path.resolve(diff.repoRoot, matchedFile.path);
        let content;
        try {
            content = readFileSync(absPath, 'utf-8');
        }
        catch {
            continue;
        }
        for (const pat of rule.patterns) {
            if (patternPresentInContent(pat, content))
                continue;
            findings.push({
                id: `pattern-shape-violation:${slugify(matchedFile.path, 'file', 40)}:${slugify(pat.raw, 'pattern', 30)}`,
                severity: 'High',
                message: `PATTERN_SHAPE violation in ${matchedFile.path}: required pattern absent — ${pat.raw}`,
                file: matchedFile.path,
            });
        }
    }
    // Phase 2: SQL ON CONFLICT … DO UPDATE SET col=const clobber (LOA-907 #6)
    // Filter by path, never by ChangedFileKind (must not widen ChangedFileKind).
    // Negative lookahead must absorb optional leading whitespace, else `= EXCLUDED.col`
    // slips past when \s* backtracks to zero and the guard checks at the space, not the value.
    const SQL_CLOBBER_RE = /\bON\s+CONFLICT\b[^;]*?\bDO\s+UPDATE\s+SET\s+\w+\s*=\s*(?!\s*EXCLUDED\.)([^,\n;]+)/is;
    for (const changed of diff.changedFiles) {
        if (changed.status === 'D' || !changed.path.endsWith('.sql'))
            continue;
        const absPath = path.resolve(diff.repoRoot, changed.path);
        let content;
        try {
            content = readFileSync(absPath, 'utf-8');
        }
        catch {
            continue;
        }
        if (!SQL_CLOBBER_RE.test(content))
            continue;
        findings.push({
            id: `sql-conflict-clobber:${slugify(changed.path, 'sql', 40)}`,
            severity: 'High',
            message: `SQL ON CONFLICT … DO UPDATE SET col=const clobber in ${changed.path}; use EXCLUDED.<col> instead`,
            file: changed.path,
        });
    }
    return { findings };
}
function collectClaudeMdFiles(repoRoot) {
    const files = [];
    const primary = path.join(repoRoot, 'extension', 'CLAUDE.md');
    if (existsSync(primary))
        files.push(primary);
    const srcDir = path.join(repoRoot, 'extension', 'src');
    if (existsSync(srcDir))
        files.push(...walkForClaudeMd(srcDir));
    return files;
}
function walkForClaudeMd(dir) {
    const results = [];
    try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...walkForClaudeMd(fullPath));
            }
            else if (entry.name === 'CLAUDE.md') {
                results.push(fullPath);
            }
        }
    }
    catch {
        // non-fatal: subsystem CLAUDE.md may be absent
    }
    return results;
}
function harvestPatternRules(claudeMdFiles) {
    const rules = [];
    for (const claudeFile of claudeMdFiles) {
        let content;
        try {
            content = readFileSync(claudeFile, 'utf-8');
        }
        catch {
            continue;
        }
        const section = extractTrapDoorsSection(content);
        if (!section)
            continue;
        for (const bullet of splitTrapDoorBullets(section)) {
            const targetFile = extractFirstFilePath(bullet);
            if (!targetFile)
                continue;
            const patterns = extractPatternShapes(bullet);
            if (patterns.length === 0)
                continue;
            rules.push({ targetFile, patterns });
        }
    }
    return rules;
}
function splitTrapDoorBullets(section) {
    return section
        .split(/\n(?=- )/)
        .map((p) => p.trim())
        .filter((p) => p.startsWith('- '));
}
function extractFirstFilePath(bullet) {
    // Search only the part before the pattern marker to avoid treating pattern strings as target files.
    const marker = findPatternShapeMarker(bullet);
    const searchIn = marker ? bullet.slice(0, marker.index) : bullet;
    const backtickRe = /`([^`]+)`/g;
    let match;
    while ((match = backtickRe.exec(searchIn)) !== null) {
        if (isFilePathLike(match[1]))
            return match[1];
    }
    return null;
}
function isFilePathLike(s) {
    // Must have a directory separator or a recognizable file extension.
    return s.includes('/') || /\.\w{2,6}$/.test(s);
}
function extractPatternShapes(bullet) {
    const marker = findPatternShapeMarker(bullet);
    if (!marker)
        return [];
    const psValue = bullet.slice(marker.index + marker.label.length);
    const entries = [];
    const backtickRe = /`([^`]+)`/g;
    let match;
    while ((match = backtickRe.exec(psValue)) !== null) {
        const raw = match[1];
        let re;
        try {
            re = new RegExp(raw, 's');
        }
        catch {
            re = null;
        }
        entries.push({ raw, re });
    }
    return entries;
}
function findPatternShapeMarker(bullet) {
    const match = /pattern_shape:/i.exec(bullet);
    if (!match || match.index < 0)
        return null;
    return { index: match.index, label: match[0] };
}
function patternPresentInContent(pat, content) {
    if (pat.re !== null) {
        try {
            return pat.re.test(content);
        }
        catch {
            // fall through to literal check
        }
    }
    return content.includes(pat.raw);
}
function pathSuffixMatch(changedPath, targetPath) {
    const norm = (s) => s.replace(/\\/g, '/');
    const cp = norm(changedPath);
    const tp = norm(targetPath);
    return cp === tp || cp.endsWith('/' + tp);
}

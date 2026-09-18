import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
export const ENFORCE_REF_RE = /(?<=ENFORCE:\s*)((?:[`]?[\w./*-]+\.(?:test\.js|sh)[`]?(?:#[\w_-]+)?(?:,\s*)?)+)/g;
export function auditTrapDoorCoverage(diff) {
    return runT6TrapDoorCoverage({
        projectRoot: diff.repoRoot,
        claudeFiles: diff.claudeFiles,
        testFiles: diff.changedFiles
            .filter((file) => file.kind === 'test')
            .map((file) => file.path),
    });
}
export function runT6TrapDoorCoverage(context) {
    const { projectRoot } = context;
    const findings = [];
    const allClaudeFiles = collectClaudeMdFiles(projectRoot);
    const scope = createScopeContext(context);
    const referencedFiles = new Set();
    for (const claudeFile of allClaudeFiles) {
        findings.push(...auditClaudeTrapDoorRefs(projectRoot, claudeFile, scope, referencedFiles));
    }
    findings.push(...collectOrphanTestFileFindings(projectRoot, scope, referencedFiles));
    return { findings };
}
/**
 * AP-BIN-ITER15-02: every CLAUDE.md under the project, DISCOVERED — never a list of locations.
 * The hand-listed form seeded `extension/CLAUDE.md` and walked `extension/src`, which made
 * repo-root `bin/CLAUDE.md` and its 75 ENFORCE refs invisible to this reader: its anchors were
 * never resolved, and the three test files it is the ONLY catalog to reference
 * (`purge-update-cache`, `release-gate`, `verify-bundle`) were reported `orphan-test-file: has
 * no inbound ENFORCE ref` — a claim the reader had no way to make true, because it never read
 * the catalog that refutes it. `audit-trap-door-enforcement.sh` already sweeps one directory
 * level under the repo root alongside the one under `extension/src` for exactly this reason; a
 * location list here was the sixth mirror of that rule, and the only one that disagreed.
 *
 * No content filter is needed to keep the widening inert over the catalogs it newly visits: a
 * CLAUDE.md carrying no `ENFORCE:` ref yields neither a finding nor a `referencedFiles` entry,
 * so repo-root `CLAUDE.md` and `prds/CLAUDE.md` fall out by construction rather than by an
 * exception member that would rot silently the day either file grows a trap door.
 */
function collectClaudeMdFiles(projectRoot) {
    return walkForClaudeMd(projectRoot).sort();
}
function walkForClaudeMd(dir) {
    const results = [];
    try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                // Vendored and scratch trees hold no catalog of this project's. `isDirectory()` is
                // false for a symlink (that is `isSymbolicLink()`), so the walk cannot cycle.
                if (entry.name === 'node_modules' || entry.name.startsWith('.'))
                    continue;
                results.push(...walkForClaudeMd(fullPath));
            }
            else if (entry.name === 'CLAUDE.md') {
                results.push(fullPath);
            }
        }
    }
    catch {
        // non-fatal: subsystem CLAUDE.md may be missing (Open Finding #5)
    }
    return results;
}
function createScopeContext(context) {
    const scopedClaudeFiles = new Set((context.claudeFiles ?? []).map(normalizeRelativePath));
    const scopedTestFiles = new Set((context.testFiles ?? []).map(normalizeRelativePath));
    return {
        hasScope: scopedClaudeFiles.size > 0 || scopedTestFiles.size > 0,
        scopedClaudeFiles,
        scopedTestFiles,
    };
}
function auditClaudeTrapDoorRefs(projectRoot, claudeFile, scope, referencedFiles) {
    const content = readTextFile(claudeFile);
    if (content === null)
        return [];
    // Scan the WHOLE file, never a heading-delimited slice: audit-trap-door-enforcement.sh's
    // collectEnforceRefs() reads every `ENFORCE:` line in the catalog with no section restriction,
    // and trap-door-shaped bullets in this repo routinely land after an intervening heading (e.g.
    // `## Module Export Catalog`) rather than staying inside `## Trap Doors`. Restricting the scan
    // to extractTrapDoorsSection() made citadel blind to those refs — both a false negative (an
    // injected absent-anchor probe placed after the heading went unreported) and a false positive
    // (test files legitimately referenced by an out-of-section ENFORCE ref were reported as
    // orphaned). Ticket 9748856d.
    const findings = [];
    const relClaude = normalizeRelativePath(path.relative(projectRoot, claudeFile));
    const claudeInScope = !scope.hasScope || scope.scopedClaudeFiles.has(relClaude);
    let barePathWarned = false;
    // ROOT V5: a routed finding must name the line a fixer edits — `relClaude` alone points at a
    // multi-thousand-line catalog. `matchAll` yields matches in strictly increasing `index` order, so
    // counting newlines only across the span since the PREVIOUS match makes this O(content) in total,
    // not O(content) per match: no second scan and no per-pass cost.
    let scannedUpTo = 0;
    let refLine = 1;
    for (const match of content.matchAll(new RegExp(ENFORCE_REF_RE.source, ENFORCE_REF_RE.flags))) {
        const matchIndex = match.index ?? scannedUpTo;
        for (let i = scannedUpTo; i < matchIndex; i++) {
            if (content[i] === '\n')
                refLine++;
        }
        scannedUpTo = matchIndex;
        const refs = parseEnforceRefs(match[1]);
        for (const ref of refs) {
            const refFindings = auditEnforceRef({
                projectRoot,
                ref,
                relClaude,
                claudeInScope,
                scope,
                barePathWarned,
                refLine,
            });
            barePathWarned ||= refFindings.warnedBarePath;
            referencedFiles.add(refFindings.canonicalPath);
            findings.push(...refFindings.findings);
        }
    }
    return findings;
}
function auditEnforceRef(input) {
    const { projectRoot, ref, relClaude, claudeInScope, scope, barePathWarned, refLine } = input;
    const { canonicalPath, absPath } = resolveEnforceRef(projectRoot, ref.filePath);
    const findings = [];
    const refInScope = !scope.hasScope || claudeInScope || scope.scopedTestFiles.has(canonicalPath);
    let warned = barePathWarned;
    if (!ref.anchor && !warned && claudeInScope) {
        findings.push({
            id: `trap-door-bare-path:${relClaude}`,
            severity: 'Low',
            message: `ENFORCE ref without #anchor in ${relClaude}; adding #test-case-name improves precision.`,
            file: relClaude,
            line: refLine,
        });
        warned = true;
    }
    if (!existsSync(absPath)) {
        if (refInScope) {
            findings.push({
                id: `orphan-enforce:${canonicalPath}`,
                severity: 'High',
                message: `ENFORCE ref points to nonexistent file: ${canonicalPath} (in ${relClaude})`,
                file: relClaude,
                line: refLine,
            });
        }
        return { canonicalPath, findings, warnedBarePath: warned };
    }
    if (ref.anchor) {
        const testContent = readTextFile(absPath);
        if (testContent !== null && refInScope && !hasTestCase(testContent, ref.anchor)) {
            // ROOT V5: deliberately NO `line`. This finding's `file` is the TEST file, while `refLine` is
            // a position in the CLAUDE.md catalog — attaching it would make `file:line` name a location
            // that does not contain the defect. Pinned by a negative test.
            findings.push({
                id: `orphan-test-case:${canonicalPath}#${ref.anchor}`,
                severity: 'High',
                message: `ENFORCE anchor #${ref.anchor} not found in ${canonicalPath}`,
                file: canonicalPath,
            });
        }
    }
    return { canonicalPath, findings, warnedBarePath: warned };
}
function collectOrphanTestFileFindings(projectRoot, scope, referencedFiles) {
    const scopedTestCandidates = scope.hasScope
        ? [...scope.scopedTestFiles].map((filePath) => path.resolve(projectRoot, filePath))
        : collectTestFiles(projectRoot);
    return scopedTestCandidates.flatMap((absTestFile) => {
        const relPath = normalizeRelativePath(path.relative(projectRoot, absTestFile));
        if (referencedFiles.has(relPath))
            return [];
        return [{
                id: `orphan-test-file:${relPath}`,
                severity: 'Medium',
                message: `Test file has no inbound ENFORCE ref: ${relPath}`,
                file: relPath,
            }];
    });
}
function readTextFile(filePath) {
    try {
        return readFileSync(filePath, 'utf-8');
    }
    catch {
        return null;
    }
}
function parseEnforceRefs(raw) {
    return raw.split(/,\s*/).flatMap((part) => {
        const cleaned = part.trim().replace(/^`|`$/g, '');
        if (!cleaned)
            return [];
        const hashIdx = cleaned.indexOf('#');
        if (hashIdx === -1)
            return [{ filePath: cleaned }];
        return [{ filePath: cleaned.slice(0, hashIdx), anchor: cleaned.slice(hashIdx + 1) }];
    });
}
function resolveEnforceRef(projectRoot, filePath) {
    const normalized = normalizeRelativePath(filePath);
    const canonicalPath = normalized.startsWith('extension/')
        ? normalized
        : normalized.startsWith('tests/')
            ? `extension/${normalized}`
            : `extension/tests/${normalized}`;
    return {
        canonicalPath,
        absPath: path.resolve(projectRoot, canonicalPath),
    };
}
function hasTestCase(content, anchor) {
    // The SAME rule as audit-trap-door-enforcement.sh `anchorMatchCount` — one definition of the
    // `ENFORCE: <file>#<anchor>` contract, not two: slug both the anchor and every quoted
    // it()/test() title, then require segment-boundary containment. A kebab slug of a whole
    // multi-word title resolves to exactly that test (a literal-prefix rule could only resolve its
    // first word, which pushed catalogs onto anchors like `#a` matching many tests), while
    // 'X-1' still cannot match 'X-11: ...'. Self-contained: tests evaluate this body verbatim.
    const slugify = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const needle = `-${slugify(anchor)}-`;
    for (const m of content.matchAll(/\b(?:it|test)\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
        if (`-${slugify(m[2])}-`.includes(needle))
            return true;
    }
    return false;
}
function collectTestFiles(projectRoot) {
    const testsDir = path.join(projectRoot, 'extension', 'tests');
    return existsSync(testsDir) ? walkForTestFiles(testsDir) : [];
}
function walkForTestFiles(dir) {
    const results = [];
    try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...walkForTestFiles(fullPath));
            }
            else if (entry.name.endsWith('.test.js')) {
                results.push(fullPath);
            }
        }
    }
    catch {
        // non-fatal
    }
    return results;
}
function normalizeRelativePath(filePath) {
    return filePath.split(path.sep).join('/');
}

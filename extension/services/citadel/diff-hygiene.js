import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { slugify, toPosixPath } from './reporter.js';
export const ROOT_MARKDOWN_ALLOWLIST = new Set([
    'AGENTS.md',
    'CHANGELOG.md',
    'CLAUDE.md',
    'LICENSE.md',
    'README.md',
]);
export const LARGE_FILE_BYTES = 1024 * 1024;
export const ENV_FILE_ALLOWLIST = new Set(['.env.example']);
const GIT_CHECK_IGNORE_TIMEOUT_MS = 5_000;
/**
 * Enumerated identity/financial PII keys. Intentionally tight (no email/phone/name) so the rule
 * stays high-signal and silent on ordinary test fixtures. A fixture-file key from this set whose
 * value is non-placeholder is a committed-PII leak.
 */
export const PII_KEY_ALLOWLIST = new Set([
    'ssn',
    'social_security_number',
    'tax_id',
    'taxid',
    'ein',
    'credit_card',
    'card_number',
    'cvv',
    'account_number',
    'routing_number',
    'passport_number',
    'drivers_license',
    'driver_license',
    'date_of_birth',
    'dob',
]);
const PII_KEY_VALUE_RE = /['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*[:=]\s*['"]([^'"]+)['"]/g;
const PLACEHOLDER_WORD_RE = /placeholder|example|redact|sample|dummy|fake|test|xxxx|n\/?a|todo|change[_-]?me/i;
const PLACEHOLDER_FILLER_RE = /^[\sx0\-_.*]+$/i;
const PLACEHOLDER_FAKE_SSN = new Set(['000-00-0000', '123-45-6789', '111-11-1111']);
export function auditDiffHygiene(diff, options = {}) {
    const addedFiles = diff.changedFiles.filter((file) => file.status === 'A');
    const suppression = buildSuppressionIndex(options.szechuanFindings ?? []);
    const findings = [];
    let suppressed = 0;
    for (const file of addedFiles) {
        for (const finding of findingsForAddedFile(diff.repoRoot, file)) {
            if (isSuppressed(finding, suppression)) {
                suppressed += 1;
            }
            else {
                findings.push(finding);
            }
        }
    }
    findings.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
    return {
        findings,
        summary: {
            added_files_scanned: addedFiles.length,
            findings: findings.length,
            suppressed_by_szechuan: suppressed,
        },
    };
}
export function auditSzechuanDiffHygiene(diff) {
    const addedFiles = diff.changedFiles.filter((file) => file.status === 'A');
    const findings = addedFiles.flatMap((file) => szechuanFindingsForAddedFile(diff.repoRoot, file));
    findings.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
    return {
        findings,
        summary: {
            added_files_scanned: addedFiles.length,
            findings: findings.length,
        },
    };
}
function findingsForAddedFile(repoRoot, file) {
    return ruleMatchesForAddedFile(repoRoot, file).map(makeFinding);
}
function szechuanFindingsForAddedFile(repoRoot, file) {
    return ruleMatchesForAddedFile(repoRoot, file).map(makeSzechuanFinding);
}
function ruleMatchesForAddedFile(repoRoot, file) {
    const normalized = toPosixPath(file.path);
    const basename = path.posix.basename(normalized);
    const matches = [];
    if (isEnvFile(basename)) {
        matches.push({ file: file.path, rule: 'env-file' });
    }
    if (isTopLevel(normalized)) {
        if (isDisallowedRootMarkdown(basename)) {
            matches.push({ file: file.path, rule: 'root-markdown-orphan' });
        }
        if (isRootScratchArtifact(basename)) {
            matches.push({ file: file.path, rule: 'root-scratch-artifact' });
        }
    }
    const size = fileSize(repoRoot, file.path);
    if (size > LARGE_FILE_BYTES && !isGitIgnored(repoRoot, file.path)) {
        matches.push({ file: file.path, rule: 'large-unignored-file', sizeBytes: size });
    }
    if (isFixtureFile(normalized) && containsNonPlaceholderPii(repoRoot, file.path)) {
        matches.push({ file: file.path, rule: 'pii-in-fixture' });
    }
    return matches;
}
function isFixtureFile(filePath) {
    return /(?:^|\/)(?:fixtures|__fixtures__)\//.test(filePath)
        || /\.fixture\.[cm]?[jt]sx?$/i.test(filePath);
}
function containsNonPlaceholderPii(repoRoot, filePath) {
    const content = readAddedFileText(repoRoot, filePath);
    for (const match of content.matchAll(new RegExp(PII_KEY_VALUE_RE.source, PII_KEY_VALUE_RE.flags))) {
        const key = match[1].toLowerCase();
        if (!PII_KEY_ALLOWLIST.has(key))
            continue;
        if (!isPlaceholderValue(match[2]))
            return true;
    }
    return false;
}
function readAddedFileText(repoRoot, filePath) {
    // auditDiffHygiene runs UNWRAPPED by safeRunAnalyzer; a TOCTOU-removed or unreadable
    // fixture file must degrade to no-PII-found, never crash the whole citadel audit.
    try {
        return readFileSync(path.join(repoRoot, filePath), 'utf-8');
    }
    catch {
        return '';
    }
}
function isPlaceholderValue(value) {
    const trimmed = value.trim();
    if (trimmed.length === 0)
        return true;
    if (PLACEHOLDER_FILLER_RE.test(trimmed))
        return true;
    if (trimmed.startsWith('<') && trimmed.endsWith('>'))
        return true;
    if (trimmed.startsWith('{{') || trimmed.startsWith('${'))
        return true;
    if (PLACEHOLDER_WORD_RE.test(trimmed))
        return true;
    if (PLACEHOLDER_FAKE_SSN.has(trimmed))
        return true;
    return false;
}
const RULE_SPECS = {
    'root-markdown-orphan': {
        citadelSeverity: 'Medium',
        szechuanPriority: 'P1',
        citadelMessage: (file) => `Top-level markdown file ${file} is not in the documented root allowlist.`,
        szechuanMessage: (file) => `orphan planning doc ${file} was added at repo root; move it to docs/ or prds/ or delete it.`,
    },
    'root-scratch-artifact': {
        citadelSeverity: 'Medium',
        szechuanPriority: 'P1',
        citadelMessage: (file) => `Top-level scratch artifact ${file} is not part of the documented change shape.`,
        szechuanMessage: (file) => `Top-level scratch artifact ${file} was added; move it under an owned docs/prds path or delete it.`,
    },
    'env-file': {
        citadelSeverity: 'Critical',
        szechuanPriority: 'P0',
        citadelMessage: (file) => `Environment file ${file} must not be committed unless it is .env.example.`,
        szechuanMessage: (file) => `Secret leak risk: ${file} must not be committed unless it is .env.example.`,
    },
    'large-unignored-file': {
        citadelSeverity: 'High',
        szechuanPriority: 'P2',
        citadelMessage: (file, sizeBytes) => `Large added file ${file} is ${sizeBytes} bytes and is not gitignored.`,
        szechuanMessage: (file, sizeBytes) => `Binary leak risk: ${file} is ${sizeBytes} bytes and is not gitignored.`,
    },
    'pii-in-fixture': {
        citadelSeverity: 'Critical',
        szechuanPriority: 'P0',
        citadelMessage: (file) => `Fixture ${file} contains a non-placeholder value for an enumerated PII key; replace it with a placeholder.`,
        szechuanMessage: (file) => `PII leak risk: ${file} commits a non-placeholder value for an enumerated PII key.`,
    },
};
function makeFinding({ file, rule, sizeBytes }) {
    const spec = RULE_SPECS[rule];
    return {
        id: `citadel-diff-hygiene-${slug(rule)}-${slug(file)}`,
        severity: spec.citadelSeverity,
        message: spec.citadelMessage(file, sizeBytes ?? 0),
        rule,
        file,
        size_bytes: sizeBytes,
        category: 'hygiene',
    };
}
function makeSzechuanFinding({ file, rule, sizeBytes }) {
    const spec = RULE_SPECS[rule];
    return {
        id: `szechuan-diff-hygiene-${slug(rule)}-${slug(file)}`,
        priority: spec.szechuanPriority,
        severity: spec.szechuanPriority,
        message: spec.szechuanMessage(file, sizeBytes ?? 0),
        rule,
        file,
        size_bytes: sizeBytes,
        category: 'hygiene',
        principle: 'Diff Hygiene',
    };
}
function isTopLevel(filePath) {
    return !filePath.includes('/');
}
function isDisallowedRootMarkdown(basename) {
    return basename.endsWith('.md') && !ROOT_MARKDOWN_ALLOWLIST.has(basename);
}
function isRootScratchArtifact(basename) {
    return /\.(?:txt|log|tmp)$/i.test(basename)
        || basename.startsWith('scratch')
        || basename.startsWith('notes')
        || basename.startsWith('WIP')
        || basename.startsWith('tmp');
}
function isEnvFile(basename) {
    return basename.startsWith('.env') && !ENV_FILE_ALLOWLIST.has(basename);
}
function fileSize(repoRoot, filePath) {
    const fullPath = path.join(repoRoot, filePath);
    try {
        return statSync(fullPath).size;
    }
    catch {
        return 0;
    }
}
function isGitIgnored(repoRoot, filePath) {
    const result = spawnSync('git', ['check-ignore', '--quiet', '--', filePath], {
        cwd: repoRoot,
        stdio: 'ignore',
        timeout: GIT_CHECK_IGNORE_TIMEOUT_MS,
    });
    return result.status === 0;
}
function buildSuppressionIndex(findings) {
    const index = {
        ids: new Set(),
        paths: new Set(),
        pathRules: new Set(),
    };
    for (const finding of findings) {
        const id = typeof finding.id === 'string' ? finding.id : undefined;
        if (id)
            index.ids.add(id);
        if (finding.category !== 'hygiene')
            continue;
        const filePath = extractFindingPath(finding);
        if (!filePath)
            continue;
        index.paths.add(filePath);
        if (typeof finding.rule === 'string') {
            index.pathRules.add(`${filePath}:${finding.rule}`);
        }
    }
    return index;
}
function isSuppressed(finding, suppression) {
    return suppression.ids.has(finding.id)
        || suppression.pathRules.has(`${toPosixPath(finding.file)}:${finding.rule}`)
        || suppression.paths.has(toPosixPath(finding.file));
}
function extractFindingPath(finding) {
    for (const value of [finding.file, finding.path, finding.target]) {
        if (typeof value === 'string' && value.trim())
            return toPosixPath(value.trim());
    }
    if (typeof finding.evidence === 'string') {
        const match = finding.evidence.match(/^([^:\n]+):\d+(?::\d+)?$/);
        if (match)
            return toPosixPath(match[1]);
    }
    return undefined;
}
function slug(value) {
    return slugify(value, 'root');
}

import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DiffSummary, ChangedFileSummary } from './diff-walker.js';
import { slugifyOrRoot, toPosixPath } from './reporter.js';

export type DiffHygieneSeverity = 'Critical' | 'High' | 'Medium';
export type SzechuanDiffHygienePriority = 'P0' | 'P1' | 'P2';
export type DiffHygieneRule =
  | 'root-markdown-orphan'
  | 'root-scratch-artifact'
  | 'env-file'
  | 'large-unignored-file'
  | 'pii-in-fixture';

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

export interface DiffHygieneFinding {
  id: string;
  severity: DiffHygieneSeverity;
  message: string;
  rule: DiffHygieneRule;
  file: string;
  size_bytes?: number;
  category: 'hygiene';
}

export interface DiffHygieneReport {
  findings: DiffHygieneFinding[];
  summary: {
    added_files_scanned: number;
    findings: number;
    suppressed_by_szechuan: number;
  };
}

export interface SzechuanDiffHygieneFinding {
  id: string;
  priority: SzechuanDiffHygienePriority;
  severity: SzechuanDiffHygienePriority;
  message: string;
  rule: DiffHygieneRule;
  file: string;
  size_bytes?: number;
  category: 'hygiene';
  principle: 'Diff Hygiene';
}

export interface SzechuanDiffHygieneReport {
  findings: SzechuanDiffHygieneFinding[];
  summary: {
    added_files_scanned: number;
    findings: number;
  };
}

export interface SzechuanFindingLike {
  id?: unknown;
  category?: unknown;
  file?: unknown;
  path?: unknown;
  target?: unknown;
  evidence?: unknown;
  rule?: unknown;
}

export interface AuditDiffHygieneOptions {
  szechuanFindings?: SzechuanFindingLike[];
}

interface SuppressionIndex {
  ids: Set<string>;
  paths: Set<string>;
  pathRules: Set<string>;
}

export function auditDiffHygiene(
  diff: DiffSummary,
  options: AuditDiffHygieneOptions = {},
): DiffHygieneReport {
  const addedFiles = diff.changedFiles.filter((file) => file.status === 'A');
  const suppression = buildSuppressionIndex(options.szechuanFindings ?? []);
  const findings: DiffHygieneFinding[] = [];
  let suppressed = 0;

  for (const file of addedFiles) {
    for (const finding of findingsForAddedFile(diff.repoRoot, file)) {
      if (isSuppressed(finding, suppression)) {
        suppressed += 1;
      } else {
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

export function auditSzechuanDiffHygiene(diff: DiffSummary): SzechuanDiffHygieneReport {
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

interface RuleMatch {
  file: string;
  rule: DiffHygieneRule;
  sizeBytes?: number;
}

function findingsForAddedFile(repoRoot: string, file: ChangedFileSummary): DiffHygieneFinding[] {
  return ruleMatchesForAddedFile(repoRoot, file).map(makeFinding);
}

function szechuanFindingsForAddedFile(repoRoot: string, file: ChangedFileSummary): SzechuanDiffHygieneFinding[] {
  return ruleMatchesForAddedFile(repoRoot, file).map(makeSzechuanFinding);
}

function ruleMatchesForAddedFile(repoRoot: string, file: ChangedFileSummary): RuleMatch[] {
  const normalized = toPosixPath(file.path);
  const basename = path.posix.basename(normalized);
  const matches: RuleMatch[] = [];

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

function isFixtureFile(filePath: string): boolean {
  return /(?:^|\/)(?:fixtures|__fixtures__)\//.test(filePath)
    || /\.fixture\.[cm]?[jt]sx?$/i.test(filePath);
}

function containsNonPlaceholderPii(repoRoot: string, filePath: string): boolean {
  const content = readAddedFileText(repoRoot, filePath);
  for (const match of content.matchAll(new RegExp(PII_KEY_VALUE_RE.source, PII_KEY_VALUE_RE.flags))) {
    const key = match[1].toLowerCase();
    if (!PII_KEY_ALLOWLIST.has(key)) continue;
    if (!isPlaceholderValue(match[2])) return true;
  }
  return false;
}

function readAddedFileText(repoRoot: string, filePath: string): string {
  // auditDiffHygiene runs UNWRAPPED by safeRunAnalyzer; a TOCTOU-removed or unreadable
  // fixture file must degrade to no-PII-found, never crash the whole citadel audit.
  try {
    return readFileSync(path.join(repoRoot, filePath), 'utf-8');
  } catch {
    return '';
  }
}

function isPlaceholderValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  if (PLACEHOLDER_FILLER_RE.test(trimmed)) return true;
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return true;
  if (trimmed.startsWith('{{') || trimmed.startsWith('${')) return true;
  if (PLACEHOLDER_WORD_RE.test(trimmed)) return true;
  if (PLACEHOLDER_FAKE_SSN.has(trimmed)) return true;
  return false;
}

interface RuleSpec {
  citadelSeverity: DiffHygieneSeverity;
  szechuanPriority: SzechuanDiffHygienePriority;
  citadelMessage: (file: string, sizeBytes: number) => string;
  szechuanMessage: (file: string, sizeBytes: number) => string;
}

const RULE_SPECS: Record<DiffHygieneRule, RuleSpec> = {
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

function makeFinding({ file, rule, sizeBytes }: RuleMatch): DiffHygieneFinding {
  const spec = RULE_SPECS[rule];
  return {
    id: `citadel-diff-hygiene-${slugifyOrRoot(rule)}-${slugifyOrRoot(file)}`,
    severity: spec.citadelSeverity,
    message: spec.citadelMessage(file, sizeBytes ?? 0),
    rule,
    file,
    size_bytes: sizeBytes,
    category: 'hygiene',
  };
}

function makeSzechuanFinding({ file, rule, sizeBytes }: RuleMatch): SzechuanDiffHygieneFinding {
  const spec = RULE_SPECS[rule];
  return {
    id: `szechuan-diff-hygiene-${slugifyOrRoot(rule)}-${slugifyOrRoot(file)}`,
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

function isTopLevel(filePath: string): boolean {
  return !filePath.includes('/');
}

function isDisallowedRootMarkdown(basename: string): boolean {
  return basename.endsWith('.md') && !ROOT_MARKDOWN_ALLOWLIST.has(basename);
}

function isRootScratchArtifact(basename: string): boolean {
  return /\.(?:txt|log|tmp)$/i.test(basename)
    || basename.startsWith('scratch')
    || basename.startsWith('notes')
    || basename.startsWith('WIP')
    || basename.startsWith('tmp');
}

function isEnvFile(basename: string): boolean {
  return basename.startsWith('.env') && !ENV_FILE_ALLOWLIST.has(basename);
}

function fileSize(repoRoot: string, filePath: string): number {
  const fullPath = path.join(repoRoot, filePath);
  try {
    return statSync(fullPath).size;
  } catch {
    return 0;
  }
}

function isGitIgnored(repoRoot: string, filePath: string): boolean {
  const result = spawnSync('git', ['check-ignore', '--quiet', '--', filePath], {
    cwd: repoRoot,
    stdio: 'ignore',
    timeout: GIT_CHECK_IGNORE_TIMEOUT_MS,
  });
  return result.status === 0;
}

function buildSuppressionIndex(findings: SzechuanFindingLike[]): SuppressionIndex {
  const index: SuppressionIndex = {
    ids: new Set(),
    paths: new Set(),
    pathRules: new Set(),
  };

  for (const finding of findings) {
    const id = typeof finding.id === 'string' ? finding.id : undefined;
    if (id) index.ids.add(id);

    if (finding.category !== 'hygiene') continue;
    const filePath = extractFindingPath(finding);
    if (!filePath) continue;
    index.paths.add(filePath);

    if (typeof finding.rule === 'string') {
      index.pathRules.add(`${filePath}:${finding.rule}`);
    }
  }

  return index;
}

function isSuppressed(finding: DiffHygieneFinding, suppression: SuppressionIndex): boolean {
  return suppression.ids.has(finding.id)
    || suppression.pathRules.has(`${toPosixPath(finding.file)}:${finding.rule}`)
    || suppression.paths.has(toPosixPath(finding.file));
}

function extractFindingPath(finding: SzechuanFindingLike): string | undefined {
  for (const value of [finding.file, finding.path, finding.target]) {
    if (typeof value === 'string' && value.trim()) return toPosixPath(value.trim());
  }
  if (typeof finding.evidence === 'string') {
    const match = finding.evidence.match(/^([^:\n]+):\d+(?::\d+)?$/);
    if (match) return toPosixPath(match[1]);
  }
  return undefined;
}

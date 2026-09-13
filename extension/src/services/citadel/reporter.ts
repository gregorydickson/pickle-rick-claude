export type CitadelSeverity = 'Critical' | 'High' | 'Medium' | 'Low';

export interface CitadelEvidence {
  file?: unknown;
  line?: unknown;
  text?: unknown;
}

export interface CitadelFinding {
  id: string;
  severity: CitadelSeverity;
  message?: string;
  acId?: string;
  trapDoorId?: string;
  evidence?: CitadelEvidence[] | string;
  file?: string;
  line?: number;
  [key: string]: unknown;
}

export interface CitadelDecision {
  id: string;
  severity?: CitadelSeverity;
  message?: string;
  evidence?: CitadelEvidence[] | string;
  file?: string;
  line?: number;
}

export interface CitadelReportHeader {
  pickle_phase_failed: boolean;
  pickle_exit_code: number | null;
}

export interface CitadelJsonReport {
  schema: '1.0';
  prd_path: string;
  diff_range: string;
  exit_code: number;
  header: CitadelReportHeader;
  sections: Record<string, unknown>;
  findings: CitadelFinding[];
  decision_required: CitadelDecision[];
  decisions: CitadelDecision[];
  summary: CitadelSummary;
  markdown: string;
}

export interface CitadelSummary {
  findings: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  decision_required: number;
  unguarded_trap_doors: number;
}

export interface ReporterInput {
  prdPath: string;
  diffRange: string;
  header: CitadelReportHeader;
  sections: Record<string, unknown>;
  findings: CitadelFinding[];
  decisions: CitadelDecision[];
  strict?: boolean;
}

const SEVERITY_RANK: Record<CitadelSeverity, number> = {
  Critical: 0,
  High: 1,
  Medium: 2,
  Low: 3,
};

export class Reporter {
  build(input: ReporterInput): CitadelJsonReport {
    const findings = rankFindings(input.findings);
    const decisions = [...input.decisions].sort(compareDecisions);
    const summary = summarize(findings, decisions);
    const exitCode = exitCodeFor(findings, decisions, input.strict);
    return {
      schema: '1.0',
      prd_path: input.prdPath,
      diff_range: input.diffRange,
      exit_code: exitCode,
      header: input.header,
      sections: input.sections,
      findings,
      decision_required: decisions,
      decisions,
      summary,
      markdown: renderMarkdown(findings, decisions, summary, exitCode),
    };
  }

  renderMarkdown(report: Pick<CitadelJsonReport, 'findings' | 'decisions' | 'summary' | 'exit_code'>): string {
    return renderMarkdown(report.findings, report.decisions, report.summary, report.exit_code);
  }
}

export function rankFindings(findings: CitadelFinding[]): CitadelFinding[] {
  return [...findings].sort(compareFindings);
}

function compareFindings(a: CitadelFinding, b: CitadelFinding): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || citationFor(a).localeCompare(citationFor(b))
    || a.id.localeCompare(b.id);
}

function compareDecisions(a: CitadelDecision, b: CitadelDecision): number {
  return decisionSeverityRank(a) - decisionSeverityRank(b)
    || citationFor(a).localeCompare(citationFor(b))
    || a.id.localeCompare(b.id);
}

function decisionSeverityRank(decision: CitadelDecision): number {
  return decision.severity ? SEVERITY_RANK[decision.severity] : SEVERITY_RANK.Medium;
}

function summarize(findings: CitadelFinding[], decisions: CitadelDecision[]): CitadelSummary {
  return {
    findings: findings.length,
    critical: countSeverity(findings, 'Critical'),
    high: countSeverity(findings, 'High'),
    medium: countSeverity(findings, 'Medium'),
    low: countSeverity(findings, 'Low'),
    decision_required: decisions.length,
    unguarded_trap_doors: countUnguardedTrapDoors(findings),
  };
}

function countSeverity(findings: CitadelFinding[], severity: CitadelSeverity): number {
  return findings.filter((finding) => finding.severity === severity).length;
}

function countUnguardedTrapDoors(findings: CitadelFinding[]): number {
  return findings.filter((finding) => {
    const id = finding.id.toLowerCase();
    const message = typeof finding.message === 'string' ? finding.message.toLowerCase() : '';
    return id.includes('trap-door') || message.includes('unguarded trap door');
  }).length;
}

function exitCodeFor(findings: CitadelFinding[], decisions: CitadelDecision[], strict = false): number {
  const critical = countSeverity(findings, 'Critical');
  const high = countSeverity(findings, 'High');
  const strictDecisionFindings = strict ? decisions.length : 0;
  return critical + (strict ? high : 0) + strictDecisionFindings > 0 ? 1 : 0;
}

function renderMarkdown(
  findings: CitadelFinding[],
  decisions: CitadelDecision[],
  summary: CitadelSummary,
  exitCode: number,
): string {
  const lines = ['# Citadel Findings', ''];
  if (findings.length === 0) {
    lines.push('No findings.', '');
  } else {
    for (const finding of findings) {
      lines.push(`- **${finding.severity}** ${labelFor(finding)} ${citationFor(finding)} - ${descriptionFor(finding)}`);
    }
    lines.push('');
  }

  lines.push(`Decisions required: ${decisions.length}`);
  lines.push(summaryLine(summary, exitCode));
  return `${lines.join('\n')}\n`;
}

function summaryLine(summary: CitadelSummary, exitCode: number): string {
  return [
    `Conformance audit: ${summary.findings} findings`,
    `(CRITICAL=${summary.critical}, HIGH=${summary.high}, MEDIUM=${summary.medium}, LOW=${summary.low})`,
    `${summary.decision_required} decisions required`,
    `${summary.unguarded_trap_doors} unguarded trap doors`,
    `exit ${exitCode}`,
  ].join(' ');
}

function labelFor(finding: CitadelFinding): string {
  const id = typeof finding.acId === 'string'
    ? finding.acId
    : typeof finding.trapDoorId === 'string'
      ? finding.trapDoorId
      : finding.id;
  return `[${id}]`;
}

function citationFor(item: CitadelFinding | CitadelDecision): string {
  const evidence = Array.isArray(item.evidence) ? item.evidence[0] : item.evidence;
  if (typeof evidence === 'string') return citationFromString(evidence);
  const file = typeof evidence?.file === 'string'
    ? evidence.file
    : typeof item.file === 'string'
      ? item.file
      : 'unknown';
  const line = typeof evidence?.line === 'number'
    ? evidence.line
    : typeof item.line === 'number'
      ? item.line
      : 0;
  return `${file}:${line}`;
}

function citationFromString(value: string): string {
  const match = /(.+):(\d+)$/.exec(value.trim());
  return match ? `${match[1]}:${match[2]}` : 'unknown:0';
}

function descriptionFor(finding: CitadelFinding): string {
  if (typeof finding.message === 'string' && finding.message.trim().length > 0) {
    return oneSentence(finding.message);
  }
  return oneSentence(finding.id);
}

function oneSentence(value: string): string {
  const first = value.trim().split(/(?<=[.!?])\s+/)[0] ?? value.trim();
  return first.replace(/\s+/g, ' ');
}

/**
 * Slugify an arbitrary string into a finding-ID component: lowercase, collapse
 * runs of non-alphanumerics to single dashes, then trim edge dashes. `fallback`
 * is returned when the input slugs to empty; `maxLength` caps the result.
 * Shared by the citadel analyzers (previously duplicated 9×; DRY Rule of Three).
 * Note: after the non-alphanumeric collapse no consecutive dashes remain, so
 * trimming a single edge dash is equivalent to trimming a run.
 */
export function slugify(value: string, fallback = '', maxLength?: number): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const capped = maxLength === undefined ? slug : slug.slice(0, maxLength);
  return capped || fallback;
}

/**
 * Deduplicate and locale-sort a string list. Shared by the citadel analyzers
 * (previously duplicated 6×; DRY Rule of Three). The single rule-set-invariant
 * variant added a `.filter(Boolean)`, proven a no-op there: every call site
 * feeds regex captures whose first character class (`[A-Za-z_$]`, `[A-Z]`)
 * guarantees a non-empty match, so no falsy member can ever reach the Set.
 */
export function uniqueSortedStrings(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/**
 * Escape a string for embedding in a single-line Markdown table cell: backslash
 * the cell-delimiting `|` and collapse any line break to a space so the row
 * stays on one line. Shared by the citadel analyzers (previously duplicated 4×;
 * DRY Rule of Three). The `\r?\n` form is the strict superset of the variants it
 * replaces: identical output for `\r`-free input, and for a CRLF break it strips
 * the carriage return too, so no stray control char survives in the cell.
 */
export function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Match POSIX-style paths that name a test or spec file: a `__tests__`/`test(s)`/
 * `spec(s)` path segment, or a `.test`/`-test`/`.spec`/`-spec` suffix before a
 * `.js`/`.ts`/`.jsx`/`.tsx`/`.cjs`/`.mjs` extension. Shared by the citadel
 * analyzers (previously duplicated 3×; DRY Rule of Three). The pattern carries
 * no `g` flag, so `.test()` is stateless and safe to share across callsites.
 * Callers normalize backslashes via `toPosixPath` before testing where the input
 * may be a native path.
 */
export const TEST_FILE_PATTERN =
  /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|(?:\.|-)test\.[cm]?[jt]sx?$|(?:\.|-)spec\.[cm]?[jt]sx?$/i;

/**
 * Normalize a path to POSIX form by replacing backslash separators with `/`.
 * Shared by the citadel analyzers (previously duplicated 4×; DRY Rule of Three).
 * Backslash-replacement rather than `split(path.sep).join('/')` so the result is
 * platform-independent: git emits forward-slash paths on every host, so this is a
 * no-op for real inputs, but a literal Windows path still normalizes correctly.
 */
export function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

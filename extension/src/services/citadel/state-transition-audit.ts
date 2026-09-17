import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { DiffSummary, ChangedFileSummary } from './diff-walker.js';
import { TransitionAuditRow } from './prd-parser.js';
import { escapeTableCell, slugifyCapped } from './reporter.js';

export type TransitionAuditSeverity = 'High';

export interface TransitionAuditEvidence {
  file: string;
  line: number;
  text: string;
}

export interface TransitionAuditCoverageRow {
  transition: string;
  auditAction: string;
  prdLine: number;
  prdText: string;
  expectedCallSite?: string;
  emitted: boolean;
  emitEvidence: TransitionAuditEvidence[];
}

export interface TransitionAuditFinding {
  id: string;
  severity: TransitionAuditSeverity;
  message: string;
  transition: string;
  auditAction: string;
  prd: TransitionAuditEvidence;
  expectedCallSite?: string;
}

export interface TransitionAuditReport {
  rows: TransitionAuditCoverageRow[];
  findings: TransitionAuditFinding[];
  markdownTable: string;
  summary: {
    total: number;
    emitted: number;
    missing: number;
  };
}

export interface AuditStateTransitionsOptions {
  repoRoot?: string;
  maxEvidencePerTransition?: number;
}

interface LoadedProductionFile {
  path: string;
  content: string;
  lines: string[];
  lineStarts: number[];
}

const DEFAULT_MAX_EVIDENCE = 3;
const CODE_FILE_PATTERN = /\.[cm]?[jt]sx?$/i;

export function auditStateTransitions(
  transitionRows: TransitionAuditRow[],
  diff: DiffSummary,
  options: AuditStateTransitionsOptions = {},
): TransitionAuditReport {
  const repoRoot = path.resolve(options.repoRoot ?? diff.repoRoot);
  const maxEvidence = options.maxEvidencePerTransition ?? DEFAULT_MAX_EVIDENCE;
  const productionFiles = loadProductionFiles(diff.changedFiles, repoRoot);
  const rows = transitionRows.map((row) => buildCoverageRow(row, productionFiles, maxEvidence));
  const findings = rows.filter((row) => !row.emitted).map(toFinding);

  return {
    rows,
    findings,
    markdownTable: renderTransitionAuditMarkdownTable(rows),
    summary: {
      total: rows.length,
      emitted: rows.filter((row) => row.emitted).length,
      missing: findings.length,
    },
  };
}

export function renderTransitionAuditMarkdownTable(rows: TransitionAuditCoverageRow[]): string {
  return [
    '| Transition | Audit | Emitted | Evidence |',
    '|---|---|:---:|---|',
    ...rows.map(
      (row) =>
        `| ${escapeTableCell(row.transition)} | ${escapeTableCell(row.auditAction)} | ${row.emitted ? 'yes' : 'no'} | ${escapeTableCell(formatEvidence(row))} |`,
    ),
  ].join('\n');
}

function buildCoverageRow(
  row: TransitionAuditRow,
  productionFiles: LoadedProductionFile[],
  maxEvidence: number,
): TransitionAuditCoverageRow {
  const emitEvidence = findEmitEvidence(row.auditAction, productionFiles, maxEvidence);
  return {
    transition: row.transition,
    auditAction: row.auditAction,
    prdLine: row.line,
    prdText: row.text,
    expectedCallSite: row.expectedCallSite,
    emitted: emitEvidence.length > 0,
    emitEvidence,
  };
}

function findEmitEvidence(
  auditAction: string,
  productionFiles: LoadedProductionFile[],
  maxEvidence: number,
): TransitionAuditEvidence[] {
  const evidence: TransitionAuditEvidence[] = [];
  if (!auditAction) return evidence;
  for (const file of productionFiles) {
    let offset = file.content.indexOf(auditAction);
    while (offset !== -1) {
      const line = lineNumberAtOffset(file.lineStarts, offset);
      evidence.push({
        file: file.path,
        line,
        text: file.lines[line - 1]?.trim() ?? '',
      });
      if (evidence.length >= maxEvidence) return evidence;
      offset = file.content.indexOf(auditAction, offset + auditAction.length);
    }
  }
  return evidence;
}

function toFinding(row: TransitionAuditCoverageRow): TransitionAuditFinding {
  return {
    id: `citadel-transition-audit-${slugifyCapped(row.transition)}-${slugifyCapped(row.auditAction)}`,
    severity: 'High',
    message: `Missing audit emit for transition "${row.transition}" and action "${row.auditAction}".`,
    transition: row.transition,
    auditAction: row.auditAction,
    prd: {
      file: 'PRD',
      line: row.prdLine,
      text: row.prdText,
    },
    expectedCallSite: row.expectedCallSite,
  };
}

function loadProductionFiles(changedFiles: ChangedFileSummary[], repoRoot: string): LoadedProductionFile[] {
  return changedFiles.flatMap((summary) => {
    if (summary.status === 'D' || summary.kind !== 'production' || !CODE_FILE_PATTERN.test(summary.path)) return [];
    try {
      const content = readFileSync(path.join(repoRoot, summary.path), 'utf-8');
      const lines = content.split(/\r?\n/);
      return [
        {
          path: summary.path,
          content,
          lines,
          lineStarts: lineStartsForContent(content),
        },
      ];
    } catch {
      return [];
    }
  });
}

function lineStartsForContent(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineNumberAtOffset(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= offset) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return high + 1;
}

function formatEvidence(row: TransitionAuditCoverageRow): string {
  if (row.emitEvidence.length === 0) {
    return row.expectedCallSite ? `missing; expected ${row.expectedCallSite}` : 'missing';
  }
  return row.emitEvidence.map((evidence) => `${evidence.file}:${evidence.line}`).join(', ');
}

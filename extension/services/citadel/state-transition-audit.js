import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { escapeTableCell, slugifyCapped } from './reporter.js';
const DEFAULT_MAX_EVIDENCE = 3;
const CODE_FILE_PATTERN = /\.[cm]?[jt]sx?$/i;
export function auditStateTransitions(transitionRows, diff, options = {}) {
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
export function renderTransitionAuditMarkdownTable(rows) {
    return [
        '| Transition | Audit | Emitted | Evidence |',
        '|---|---|:---:|---|',
        ...rows.map((row) => `| ${escapeTableCell(row.transition)} | ${escapeTableCell(row.auditAction)} | ${row.emitted ? 'yes' : 'no'} | ${escapeTableCell(formatEvidence(row))} |`),
    ].join('\n');
}
function buildCoverageRow(row, productionFiles, maxEvidence) {
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
function findEmitEvidence(auditAction, productionFiles, maxEvidence) {
    const evidence = [];
    if (!auditAction)
        return evidence;
    for (const file of productionFiles) {
        let offset = file.content.indexOf(auditAction);
        while (offset !== -1) {
            const line = lineNumberAtOffset(file.lineStarts, offset);
            evidence.push({
                file: file.path,
                line,
                text: file.lines[line - 1]?.trim() ?? '',
            });
            if (evidence.length >= maxEvidence)
                return evidence;
            offset = file.content.indexOf(auditAction, offset + auditAction.length);
        }
    }
    return evidence;
}
function toFinding(row) {
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
function loadProductionFiles(changedFiles, repoRoot) {
    return changedFiles.flatMap((summary) => {
        if (summary.status === 'D' || summary.kind !== 'production' || !CODE_FILE_PATTERN.test(summary.path))
            return [];
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
        }
        catch {
            return [];
        }
    });
}
function lineStartsForContent(content) {
    const starts = [0];
    for (let index = 0; index < content.length; index += 1) {
        if (content.charCodeAt(index) === 10)
            starts.push(index + 1);
    }
    return starts;
}
function lineNumberAtOffset(lineStarts, offset) {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (lineStarts[mid] <= offset) {
            low = mid + 1;
        }
        else {
            high = mid - 1;
        }
    }
    return high + 1;
}
function formatEvidence(row) {
    if (row.emitEvidence.length === 0) {
        return row.expectedCallSite ? `missing; expected ${row.expectedCallSite}` : 'missing';
    }
    return row.emitEvidence.map((evidence) => `${evidence.file}:${evidence.line}`).join(', ');
}

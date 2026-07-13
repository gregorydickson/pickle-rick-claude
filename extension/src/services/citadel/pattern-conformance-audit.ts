import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { CitadelFinding, slugify } from './reporter.js';
import { DiffSummary } from './diff-walker.js';

export interface PatternConformanceResult {
  findings: CitadelFinding[];
}

// Filter by path, never by ChangedFileKind (must not widen ChangedFileKind).
// Capture the WHOLE SET list. Anchoring `\w+\s*=` directly to `DO UPDATE SET` pins the
// column to the FIRST one in the list, so every clobber in columns 2..N reads clean —
// which is the canonical upsert shape (propagate most columns from EXCLUDED, clobber one).
const ON_CONFLICT_SET_RE = /\bON\s+CONFLICT\b[^;]*?\bDO\s+UPDATE\s+SET\s+([^;]+)/gi;

// A clobber is `col = <bare literal constant>` — the shape that DISCARDS the incoming row's value.
// Match the RHS positively against the literal set rather than negatively against `EXCLUDED.`:
// a not-EXCLUDED RHS is not the same thing as a constant, and the difference is every
// function-valued assignment. `updated_at = NOW()` is the canonical upsert idiom, and the finding's
// own advice ("use EXCLUDED.<col>") is the one thing you must not write there.
// The trailing lookahead keeps `NULL` from matching the head of `NULLIF(...)`.
const CLOBBER_LITERAL_RHS = String.raw`'(?:[^']|'')*'|-?\d+(?:\.\d+)?|NULL|TRUE|FALSE`;
const CLOBBER_ASSIGN_RE = new RegExp(
  String.raw`^\s*(\w+)\s*=\s*(?:${CLOBBER_LITERAL_RHS})(?![\w.(])`,
  'i',
);

/** Split a SET list on its top-level commas, so `COALESCE(a, b)` stays one assignment. */
function splitTopLevelCommas(clause: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < clause.length; i++) {
    const ch = clause[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(clause.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(clause.slice(start));

  return parts;
}

/** Every column in an `ON CONFLICT … DO UPDATE SET` list assigned a bare literal constant. */
function findClobberedColumns(content: string): string[] {
  const columns: string[] = [];

  for (const setClause of content.matchAll(ON_CONFLICT_SET_RE)) {
    for (const assignment of splitTopLevelCommas(setClause[1])) {
      const clobber = CLOBBER_ASSIGN_RE.exec(assignment);
      if (clobber) columns.push(clobber[1]);
    }
  }

  return columns;
}

/**
 * Flags SQL ON CONFLICT clobbers. Report-only; never halts, never auto-fixes.
 *
 * R-PCPS: this analyzer NO LONGER greps trap-door `PATTERN_SHAPE:` declarations. That arm
 * treated every backticked span after the marker as a literal that MUST appear in the target
 * file, which is unsound against the real corpus: PATTERN_SHAPE is LLM-authored prose with
 * embedded code, not a machine grammar. It carries negative assertions ("MUST NOT contain
 * `state.max_iterations = budget.max_iterations`"), shell commands (`grep -c ... == 0`),
 * cross-file symbols, and ``-fenced spans. Requiring all of it PRESENT inverted the negatives
 * — the check went green only when a known-shipped bug was reintroduced — and reported
 * literally-present code as absent, because presence was tested regex-first (`(` and `.` in
 * `if (counterNext.halt)` parse as a group and a wildcard, so the pattern cannot match itself).
 * It emitted 41/41 false High findings on a clean tree.
 *
 * Trap-door enforcement lives in `extension/scripts/audit-trap-door-enforcement.sh` (curated
 * per-trap-door greps, in the release gate) and `citadel/trap-door-coverage-audit.ts`
 * (ENFORCE-reachability). Both are sound; this grep was the redundant, broken one.
 */
export function auditPatternConformance(diff: DiffSummary): PatternConformanceResult {
  return { findings: findSqlConflictClobbers(diff) };
}

function findSqlConflictClobbers(diff: DiffSummary): CitadelFinding[] {
  const findings: CitadelFinding[] = [];

  for (const changed of diff.changedFiles) {
    if (changed.status === 'D' || !changed.path.endsWith('.sql')) continue;

    const content = tryReadFile(path.resolve(diff.repoRoot, changed.path));
    if (content === null) continue;

    const clobbered = findClobberedColumns(content);
    if (clobbered.length === 0) continue;

    findings.push({
      id: `sql-conflict-clobber:${slugify(changed.path, 'sql', 40)}`,
      severity: 'High',
      message: `SQL ON CONFLICT … DO UPDATE SET clobber in ${changed.path} (${clobbered.join(', ')}); use EXCLUDED.<col> instead`,
      file: changed.path,
    });
  }

  return findings;
}

function tryReadFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

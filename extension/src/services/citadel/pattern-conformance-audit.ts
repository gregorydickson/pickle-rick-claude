import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { CitadelFinding, slugify } from './reporter.js';
import { DiffSummary } from './diff-walker.js';

export interface PatternConformanceResult {
  findings: CitadelFinding[];
}

// Filter by path, never by ChangedFileKind (must not widen ChangedFileKind).
// Negative lookahead must absorb optional leading whitespace, else `= EXCLUDED.col`
// slips past when \s* backtracks to zero and the guard checks at the space, not the value.
const SQL_CLOBBER_RE =
  /\bON\s+CONFLICT\b[^;]*?\bDO\s+UPDATE\s+SET\s+\w+\s*=\s*(?!\s*EXCLUDED\.)([^,\n;]+)/is;

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
    if (content === null || !SQL_CLOBBER_RE.test(content)) continue;

    findings.push({
      id: `sql-conflict-clobber:${slugify(changed.path, 'sql', 40)}`,
      severity: 'High',
      message: `SQL ON CONFLICT … DO UPDATE SET col=const clobber in ${changed.path}; use EXCLUDED.<col> instead`,
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

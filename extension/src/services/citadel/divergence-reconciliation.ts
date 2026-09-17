import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { ChangedFileSummary, DiffSummary } from './diff-walker.js';
import { slugifyOrRoot } from './reporter.js';

export type DivergenceDecisionKind = 'test-locks-prd-divergence' | 'trap-door-prd-contradiction';

export interface DivergenceEvidence {
  file: string;
  line: number;
  text: string;
}

export interface DivergenceDecisionRequired {
  id: string;
  severity: 'Medium';
  kind: DivergenceDecisionKind;
  message: string;
  suggestion: string;
  evidence: DivergenceEvidence[];
}

export interface DivergenceReconciliationReport {
  decisionsRequired: DivergenceDecisionRequired[];
  findings: [];
  summary: {
    changed_tests_scanned: number;
    trap_door_files_scanned: number;
    decisions_required: number;
  };
}

const AC_ID_PATTERN = /\bAC-[A-Z0-9]+(?:-[A-Z0-9]+)*(?:-\d+)?\b/;
const CONTRADICTION_PATTERN = /\b(?:contradicts?|conflicts?\s+with|diverges?\s+from|differs?\s+from|against)\s+(?:the\s+)?PRD\b|\bPRD\s+(?:contradicts?|conflicts?\s+with|diverges?\s+from|differs?\s+from)\b/i;
const INTENT_MARKER_PATTERN = /\b(?:product|ux|business)\s+decision\b|\b(?:chosen|intentional|intentionally|deliberately|shipped)\s+(?:behavior|deviation|divergence|different|differs?)\b/i;
const ASSERTION_PATTERN = /\b(?:assert|asserts|expect|expects|should|returns?|responds?|throws?|blocks?|allows?|rejects?)\b/i;
const TRAP_DOOR_PATTERN = /\btrap[- ]door\b/i;

export function reconcileDivergences(diff: DiffSummary): DivergenceReconciliationReport {
  const changedTests = diff.changedFiles.filter((file) => file.kind === 'test' && file.status !== 'D');
  const trapDoorFiles = diff.changedFiles.filter((file) => path.basename(file.path) === 'CLAUDE.md' && file.status !== 'D');
  const decisionsRequired = [
    ...changedTests.flatMap((file) => decisionsForChangedTest(diff.repoRoot, file)),
    ...trapDoorFiles.flatMap((file) => decisionsForTrapDoorFile(diff.repoRoot, file)),
  ].sort(compareDecisions);

  return {
    decisionsRequired,
    findings: [],
    summary: {
      changed_tests_scanned: changedTests.length,
      trap_door_files_scanned: trapDoorFiles.length,
      decisions_required: decisionsRequired.length,
    },
  };
}

function decisionsForChangedTest(repoRoot: string, file: ChangedFileSummary): DivergenceDecisionRequired[] {
  return changedLineEvidence(repoRoot, file)
    .filter((evidence) => AC_ID_PATTERN.test(evidence.text))
    .filter((evidence) => CONTRADICTION_PATTERN.test(evidence.text))
    .filter((evidence) => INTENT_MARKER_PATTERN.test(evidence.text) || ASSERTION_PATTERN.test(evidence.text))
    .map((evidence) => ({
      id: `citadel-divergence-test-${slugifyOrRoot(file.path)}-${evidence.line}`,
      severity: 'Medium',
      kind: 'test-locks-prd-divergence',
      message: `${file.path}:${evidence.line} appears to lock implemented behavior against a referenced PRD acceptance criterion.`,
      suggestion: 'Decision required: amend the PRD acceptance criterion or update the test to match the PRD.',
      evidence: [evidence],
    }));
}

function decisionsForTrapDoorFile(repoRoot: string, file: ChangedFileSummary): DivergenceDecisionRequired[] {
  return changedLineEvidence(repoRoot, file)
    .filter((evidence) => TRAP_DOOR_PATTERN.test(evidence.text))
    .filter((evidence) => CONTRADICTION_PATTERN.test(evidence.text))
    .map((evidence) => ({
      id: `citadel-divergence-trap-door-${slugifyOrRoot(file.path)}-${evidence.line}`,
      severity: 'Medium',
      kind: 'trap-door-prd-contradiction',
      message: `${file.path}:${evidence.line} describes a trap door that contradicts the PRD.`,
      suggestion: 'Decision required: amend the trap-door contract or amend the PRD so rollback behavior is explicit.',
      evidence: [evidence],
    }));
}

function changedLineEvidence(repoRoot: string, file: ChangedFileSummary): DivergenceEvidence[] {
  // A changed file present in the committed diff range can be unreadable from
  // the working tree (deleted/moved post-`head`, broken symlink, perms). Fail
  // soft like every sibling analyzer (ac-coverage, state-transitions, etc.) —
  // reconcileDivergences runs UNwrapped by safeRunAnalyzer, so a throw here
  // crashes the entire Citadel audit instead of skipping one file.
  let lines: string[];
  try {
    lines = readFileSync(path.join(repoRoot, file.path), 'utf-8').split(/\r?\n/);
  } catch {
    return [];
  }
  const evidence: DivergenceEvidence[] = [];
  for (const range of file.changedLines) {
    for (let lineNumber = range.start; lineNumber <= range.end; lineNumber += 1) {
      const text = lines[lineNumber - 1]?.trim();
      if (!text) continue;
      evidence.push({ file: file.path, line: lineNumber, text });
    }
  }
  return evidence;
}

function compareDecisions(a: DivergenceDecisionRequired, b: DivergenceDecisionRequired): number {
  const first = a.evidence[0];
  const second = b.evidence[0];
  return first.file.localeCompare(second.file) || first.line - second.line || a.id.localeCompare(b.id);
}

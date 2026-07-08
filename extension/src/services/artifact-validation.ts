import * as fs from 'fs';
import * as path from 'path';
import { TIER_LIFECYCLE, type LifecyclePhase, type TicketComplexityTier } from './pickle-utils.js';

export function findMissingPrefixes(files: readonly string[], prefixes: readonly string[]): string[] {
  return prefixes.filter((prefix) => !files.some((file) => file === `${prefix}.md` || file.startsWith(`${prefix}_`)));
}

/**
 * R-PIAP-A4: phase → gated-artifact-prefix mapping. `implement` and `simplify`
 * produce diffs, not gated artifacts, so they have no entry here.
 *   research        → research_*.md
 *   research_review → research_review.md
 *   plan            → plan_*.md
 *   plan_review     → plan_review.md
 *   conformance     → conformance_*.md
 *   code_review     → code_review_*.md
 */
const PHASE_ARTIFACT_PREFIX: Partial<Record<LifecyclePhase, string>> = {
  research: 'research',
  research_review: 'research_review',
  plan: 'plan',
  plan_review: 'plan_review',
  conformance: 'conformance',
  code_review: 'code_review',
};

/**
 * R-PIAP-A4: the gated artifact prefixes a ticket of `tier` must produce,
 * derived from `TIER_LIFECYCLE[tier]` (R-PIAP-A1) — never a hardcoded list.
 * A tier whose lifecycle omits a phase is not penalized for that phase's artifact.
 */
export function requiredTierArtifactPrefixes(tier: TicketComplexityTier): string[] {
  return TIER_LIFECYCLE[tier]
    .map((phase) => PHASE_ARTIFACT_PREFIX[phase])
    .filter((prefix): prefix is string => Boolean(prefix));
}

export function listRickTicketFiles(sessionDir: string): string[] {
  if (!fs.existsSync(sessionDir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(sessionDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const ticketPath = path.join(sessionDir, entry.name, `rick_ticket_${entry.name}.md`);
    if (fs.existsSync(ticketPath)) files.push(ticketPath);
  }
  return files.sort();
}

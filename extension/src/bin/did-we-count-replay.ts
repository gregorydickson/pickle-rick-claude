/**
 * Ticket 984a768c: the replay scaffold for the 18-sha did-we-count corpus. Reports
 * `no-check-yet` per entry until a real check is registered — tickets 30/40 supply the
 * detection-rule checks, ticket 80 runs the full checkout-parent/checkout-fix replay. This
 * ticket's job is the reporting contract (per-sha, honest, ceiling stated up front), not the
 * git checkout plumbing.
 *
 * Binding reporting rule, applied to itself: an entry with no registered check is reported
 * `no-check-yet`, NEVER stretched into a pass. `CheckRegistry` is empty today, so every lookup
 * misses and every entry reports `no-check-yet` — that is the correct, honest state until a
 * later ticket registers real checks.
 */
import * as path from 'node:path';
import { CORPUS, DETECTABLE_CEILING, type CorpusBucket, type CorpusEntry } from '../services/did-we-count-corpus.js';

/** Keyed by sha; a registered check reports true/false for parent or fix commit. */
export type CheckRegistry = Record<string, (parentOrFix: 'parent' | 'fix') => boolean>;

export interface ReplayEntryResult {
  sha: string;
  bucket: CorpusBucket;
  status: 'no-check-yet' | 'pass' | 'fail';
}

export function replayEntry(entry: CorpusEntry, registry: CheckRegistry): ReplayEntryResult {
  const check = registry[entry.sha];
  if (!check) {
    return { sha: entry.sha, bucket: entry.bucket, status: 'no-check-yet' };
  }
  const firedOnParent = check('parent');
  const firedOnFix = check('fix');
  const matched = firedOnParent === entry.expect_fire_on_parent && firedOnFix === entry.expect_fire_on_fix;
  return { sha: entry.sha, bucket: entry.bucket, status: matched ? 'pass' : 'fail' };
}

export function replayCorpus(corpus: CorpusEntry[], registry: CheckRegistry): ReplayEntryResult[] {
  return corpus.map((entry) => replayEntry(entry, registry));
}

export function formatReplayReport(results: ReplayEntryResult[]): string {
  const rows = results.map((r) => `| \`${r.sha}\` | ${r.bucket} | ${r.status} |`);
  return [
    '# did-we-count replay',
    '',
    `- **Detectable ceiling**: ${DETECTABLE_CEILING}/${results.length}`,
    '',
    '| sha | bucket | status |',
    '|-----|--------|--------|',
    ...rows,
    '',
  ].join('\n');
}

if (process.argv[1] && path.basename(process.argv[1]) === 'did-we-count-replay.js') {
  const results = replayCorpus(CORPUS, {});
  process.stdout.write(formatReplayReport(results));
}

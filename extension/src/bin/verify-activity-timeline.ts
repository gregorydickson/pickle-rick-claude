import * as path from 'path';
import { readRecoverableJsonObject } from '../services/recoverable-json.js';
import { getExtensionRoot } from '../services/pickle-utils.js';
import { resolveWorkerGateTier } from './spawn-morty.js';
import {
  findOverlapViolations,
  buildGateCompletionReport,
  type ActivityEvent,
} from '../services/activity-timeline-verifier.js';

const USAGE = 'Usage: verify-activity-timeline <session-dir>';

export function runVerifyActivityTimeline(sessionDir: string): { exitCode: number; output: string } {
  const lines: string[] = [];
  const statePath = path.join(sessionDir, 'state.json');
  const state = readRecoverableJsonObject(statePath) as Record<string, unknown> | null;

  if (!state) {
    return { exitCode: 1, output: `verify-activity-timeline: unable to read state.json at ${statePath}` };
  }

  const activity = Array.isArray(state.activity) ? (state.activity as ActivityEvent[]) : [];

  // AP-EXT-ITER115-01: `resolveWorkerGateTier`'s parameter is an EXTENSION ROOT — it reads
  // `<root>/pickle_settings.json`. The session's `working_dir` is the TARGET repo, which carries
  // that file only when the target IS the pickle-rick source tree; everywhere else the read misses
  // and the resolver falls through to its `'fast'` default WITHOUT warning (the warn arm fires only
  // for a present-but-invalid value). That pinned `narrowTierVacuity` false, so a narrow-tier run —
  // which emits no per-ticket gate event at all — reported every spawned ticket as an observed
  // completion. `spawn-morty.ts`'s sibling call may pass `args.workingDir` because it is reached
  // only past an `fs.existsSync(extensionDir)` gate that proves the target is this repo; there is
  // no such precondition here, so the argument that is correct there is wrong here.
  let workerGateTier: string | undefined;
  try {
    workerGateTier = resolveWorkerGateTier(getExtensionRoot());
  } catch {
    workerGateTier = undefined;
  }

  const report = buildGateCompletionReport(activity, { workerGateTier });
  const violations = findOverlapViolations(activity);

  lines.push('ticket | observed_completion | wall_clock_ms | timed_out | reason');
  for (const t of report.tickets) {
    lines.push(`${t.ticket} | ${t.observedCompletion} | ${t.wallClockMs ?? 'n/a'} | ${t.timedOut} | ${t.reason}`);
  }
  lines.push('');
  lines.push(`GATE VERDICT: ${report.summary.verdict}${report.narrowTierVacuity ? ' (narrow-tier short-circuit — no tickets counted as observed)' : ''}`);
  lines.push('');
  // AP-EXT-ITER211-01: `state.activity` is a bounded drop-oldest ring, so "no violations"
  // and "the events that would show them were evicted" are the same empty array. Say which.
  const incomplete = report.windowIncompleteTickets;
  if (violations.length === 0) {
    lines.push(incomplete.length > 0 ? 'OVERLAP: none observable in this window' : 'OVERLAP: none');
  } else {
    lines.push(`OVERLAP: ${violations.length} violation(s)`);
    for (const v of violations) {
      lines.push(`  ${v.priorTicket} (spawned ${v.priorSpawnTs}) still had no terminal event when ${v.nextTicket} spawned at ${v.nextSpawnTs}`);
    }
  }
  if (incomplete.length > 0) {
    lines.push(
      `WINDOW: INCOMPLETE — ${incomplete.length} ticket(s) carry a terminal event with no spawn in state.activity (${incomplete.join(', ')}). ` +
        'That array is a bounded drop-oldest ring (state-manager.ts:trimActivityRing), so absence of a violation above is not evidence there was none.',
    );
  }

  // The exit code stays the VIOLATION count. Incompleteness is a reporting fact, not a
  // disposition: reddening on it would turn an unreadable window into a failing run.
  return { exitCode: violations.length > 0 ? 1 : 0, output: lines.join('\n') };
}

if (process.argv[1] && path.basename(process.argv[1]) === 'verify-activity-timeline.js') {
  const sessionDir = process.argv[2];
  if (!sessionDir) {
    console.error(USAGE);
    process.exit(64);
  }
  const { exitCode, output } = runVerifyActivityTimeline(sessionDir);
  console.log(output);
  process.exit(exitCode);
}

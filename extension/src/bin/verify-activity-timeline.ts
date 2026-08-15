import * as path from 'path';
import { readRecoverableJsonObject } from '../services/recoverable-json.js';
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
  const workingDir = typeof state.working_dir === 'string' ? state.working_dir : sessionDir;

  let workerGateTier: string | undefined;
  try {
    workerGateTier = resolveWorkerGateTier(workingDir);
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
  if (violations.length === 0) {
    lines.push('OVERLAP: none');
  } else {
    lines.push(`OVERLAP: ${violations.length} violation(s)`);
    for (const v of violations) {
      lines.push(`  ${v.priorTicket} (spawned ${v.priorSpawnTs}) still had no terminal event when ${v.nextTicket} spawned at ${v.nextSpawnTs}`);
    }
  }

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

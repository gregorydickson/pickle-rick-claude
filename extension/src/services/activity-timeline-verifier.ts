/**
 * Pure overlap predicate (AC-6) + gate-completion report (AC-5a/AC-5b/AC-15) over a session's
 * activity array. No I/O — callers (the CLI, tests) supply the array.
 *
 * The activity schema carries no positive "test:fast passed" event — only negative signals
 * (`worker_gate_failed`, `tier_phase_skipped`) exist. `buildGateCompletionReport` therefore derives
 * "observed completion" by absence of a negative signal for a spawned ticket, and separately honors
 * an explicit `workerGateTier: 'narrow'` override (AC-5b) so the narrow-tier short-circuit — which
 * emits no per-ticket activity event at all — is never misreported as a clean run.
 */

export type ActivityEvent = { event: string; ts: string; [key: string]: unknown };

export type OverlapViolation = {
  priorTicket: string;
  priorSpawnTs: string;
  priorTerminalTs: string | null;
  nextTicket: string;
  nextSpawnTs: string;
};

export type TicketGateCompletion = {
  ticket: string;
  spawned: boolean;
  skipped: boolean;
  timedOut: boolean;
  failedNonTimeout: boolean;
  observedCompletion: boolean;
  wallClockMs: number | null;
  reason: 'narrow_tier_shortcircuit' | 'skipped' | 'timed_out' | 'failed' | 'observed' | null;
};

export type GateCompletionReport = {
  tickets: TicketGateCompletion[];
  narrowTierVacuity: boolean;
  summary: {
    observedCompletions: number;
    timeouts: number;
    verdict: string;
  };
};

function getEventTicketId(e: ActivityEvent): string | null {
  const ticketId = e.ticket_id;
  if (typeof ticketId === 'string' && ticketId.length > 0) return ticketId;
  const ticket = e.ticket;
  if (typeof ticket === 'string' && ticket.length > 0) return ticket;
  return null;
}

function parseTs(e: ActivityEvent): number {
  return Date.parse(e.ts);
}

/**
 * Manager-side events that PROVE the prior ticket's worker is no longer running.
 * Both arms are written after the worker process exits: `worker_gate_failed` on the
 * gate-red branch and `boundary_commit_resolved` on the clean branch
 * (`mux-runner.ts:commitGatePassingDeliverableAtBoundary`, emitted exactly once per
 * boundary). A ticket that finishes cleanly emits ONLY the latter, so a
 * gate-failure-only set reads every healthy hand-off as an unresolved overlap.
 *
 * Deliberately EXCLUDES `worker_completion_commit_announced`: `spawn-morty.ts`
 * writes it from the LIVE worker's stdout stream, so it lands while that worker is
 * still running and would mask a genuine overlap.
 */
const WORKER_TERMINAL_EVENTS = new Set(['worker_gate_failed', 'boundary_commit_resolved']);

export function findOverlapViolations(activity: ActivityEvent[]): OverlapViolation[] {
  const spawns = activity
    .map((e, index) => ({ e, index, ts: parseTs(e) }))
    .filter((entry) => entry.e.event === 'worker_spawn_backend_resolved' && getEventTicketId(entry.e) !== null && !Number.isNaN(entry.ts))
    .sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : a.index - b.index));

  const terminalEvents = activity
    .map((e) => ({ e, ts: parseTs(e) }))
    .filter((entry) => WORKER_TERMINAL_EVENTS.has(entry.e.event) && getEventTicketId(entry.e) !== null && !Number.isNaN(entry.ts));

  const violations: OverlapViolation[] = [];
  let lastTicket: string | null = null;
  let lastSpawnTs = '';
  let lastSpawnMs = 0;

  for (const spawn of spawns) {
    const ticket = getEventTicketId(spawn.e) as string;
    if (lastTicket !== null && ticket !== lastTicket) {
      // The window is bounded at BOTH ends. A relaunched ticket spawns more than once, and
      // only a terminal at or after ITS LAST spawn proves THAT run exited — a terminal from
      // an earlier run of the same ticket would otherwise vouch for every later run forever.
      const priorTerminal = terminalEvents
        .filter((t) => getEventTicketId(t.e) === lastTicket && t.ts >= lastSpawnMs && t.ts <= spawn.ts)
        .sort((a, b) => a.ts - b.ts)[0];
      if (!priorTerminal) {
        violations.push({
          priorTicket: lastTicket,
          priorSpawnTs: lastSpawnTs,
          priorTerminalTs: null,
          nextTicket: ticket,
          nextSpawnTs: spawn.e.ts,
        });
      }
    }
    lastTicket = ticket;
    lastSpawnTs = spawn.e.ts;
    lastSpawnMs = spawn.ts;
  }

  return violations;
}

/**
 * Every parseable spawn instant per ticket, ascending — NOT just the first.
 * Relaunch is routine (24 of 42 ticket entries across the 7 real sessions on this box
 * were re-spawned), and a ticket's later runs are separated from its first by arbitrary
 * idle time, so a single first-spawn anchor cannot measure any run but run 1.
 *
 * A ticket whose spawns all carry unparseable timestamps keeps its key with an EMPTY
 * list: it was still spawned, and dropping it would delete a ticket from the report.
 */
function collectSpawnMsByTicket(activity: ActivityEvent[]): Map<string, number[]> {
  const spawnMsByTicket = new Map<string, number[]>();
  for (const e of activity) {
    if (e.event !== 'worker_spawn_backend_resolved') continue;
    const ticket = getEventTicketId(e);
    if (ticket === null) continue;
    const spawnMsList = spawnMsByTicket.get(ticket) ?? [];
    const spawnMs = parseTs(e);
    if (!Number.isNaN(spawnMs)) spawnMsList.push(spawnMs);
    spawnMsByTicket.set(ticket, spawnMsList);
  }
  for (const spawnMsList of spawnMsByTicket.values()) spawnMsList.sort((a, b) => a - b);
  return spawnMsByTicket;
}

/**
 * Wall clock of the run the terminal BELONGS to: the earliest terminal, measured from the
 * latest spawn at or before it.
 *
 * The same staleness rule `findOverlapViolations` already enforces (AP-EXT-ITER39-01) —
 * an event from one run must never be paired with another run of the same ticket. Anchoring
 * on the FIRST spawn charges every re-spawned ticket the idle gap between its runs:
 * measured on real sessions, `a38de7dc` (2026-08-24-218474cb) reported 46m for a run that
 * took 8m and `b94d8693` (2026-08-22-b2ecaea6) reported 43m for one that took 7m.
 *
 * A terminal that precedes EVERY spawn (truncated log, clock skew) has no owning run, so the
 * answer is `null` — a negative duration is not a measurement.
 */
function computeWallClockMs(spawnMsList: number[], terminalTimestamps: Array<string | undefined>): number | null {
  const candidates = terminalTimestamps
    .filter((ts): ts is string => typeof ts === 'string')
    .map((ts) => Date.parse(ts))
    .filter((n) => !Number.isNaN(n));
  if (candidates.length === 0) return null;
  const terminalMs = Math.min(...candidates);
  let owningSpawnMs: number | null = null;
  for (const spawnMs of spawnMsList) {
    if (spawnMs <= terminalMs) owningSpawnMs = spawnMs;
  }
  return owningSpawnMs === null ? null : terminalMs - owningSpawnMs;
}

function classifyTicketGate(
  ticket: string,
  spawnMsList: number[],
  activity: ActivityEvent[],
  narrowTierVacuity: boolean,
): TicketGateCompletion {
  const skipped = activity.some(
    (e) => e.event === 'tier_phase_skipped' && getEventTicketId(e) === ticket
      && Array.isArray(e.skipped_phases) && (e.skipped_phases as unknown[]).includes('test:fast'),
  );
  const gateFailedEvents = activity.filter(
    (e) => e.event === 'worker_gate_failed' && getEventTicketId(e) === ticket && e.gate_phase === 'test:fast',
  );
  const timeoutEvent = gateFailedEvents.find(
    (e) => Array.isArray(e.failures) && (e.failures as Array<{ name?: unknown }>).some((f) => f?.name === '__timeout__'),
  );
  const completionEvent = activity.find(
    (e) => e.event === 'worker_completion_commit_announced' && getEventTicketId(e) === ticket,
  );

  const timedOut = Boolean(timeoutEvent);
  const failedNonTimeout = gateFailedEvents.length > 0 && !timedOut;
  const wallClockMs = computeWallClockMs(spawnMsList, [timeoutEvent?.ts, gateFailedEvents[0]?.ts, completionEvent?.ts]);

  const observedCompletion = !narrowTierVacuity && !skipped && !timedOut && !failedNonTimeout;
  const reason: TicketGateCompletion['reason'] = narrowTierVacuity
    ? 'narrow_tier_shortcircuit'
    : observedCompletion
      ? 'observed'
      : skipped ? 'skipped' : (timedOut ? 'timed_out' : 'failed');

  return { ticket, spawned: true, skipped, timedOut, failedNonTimeout, observedCompletion, wallClockMs, reason };
}

export function buildGateCompletionReport(
  activity: ActivityEvent[],
  opts?: { workerGateTier?: string },
): GateCompletionReport {
  const narrowTierVacuity = opts?.workerGateTier === 'narrow';
  const spawnMsByTicket = collectSpawnMsByTicket(activity);

  const tickets: TicketGateCompletion[] = [];
  for (const [ticket, spawnMsList] of spawnMsByTicket) {
    tickets.push(classifyTicketGate(ticket, spawnMsList, activity, narrowTierVacuity));
  }

  const observedCompletions = tickets.filter((t) => t.observedCompletion).length;
  const timeouts = tickets.filter((t) => t.timedOut).length;

  return {
    tickets,
    narrowTierVacuity,
    summary: {
      observedCompletions,
      timeouts,
      verdict: `${observedCompletions} observed completions, ${timeouts} timeouts`,
    },
  };
}

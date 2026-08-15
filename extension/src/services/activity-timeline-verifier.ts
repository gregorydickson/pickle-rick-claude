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

export function findOverlapViolations(activity: ActivityEvent[]): OverlapViolation[] {
  const spawns = activity
    .map((e, index) => ({ e, index, ts: parseTs(e) }))
    .filter((entry) => entry.e.event === 'worker_spawn_backend_resolved' && getEventTicketId(entry.e) !== null && !Number.isNaN(entry.ts))
    .sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : a.index - b.index));

  const terminalEvents = activity
    .map((e) => ({ e, ts: parseTs(e) }))
    .filter((entry) => entry.e.event === 'worker_gate_failed' && getEventTicketId(entry.e) !== null && !Number.isNaN(entry.ts));

  const violations: OverlapViolation[] = [];
  let lastTicket: string | null = null;
  let lastSpawnTs = '';

  for (const spawn of spawns) {
    const ticket = getEventTicketId(spawn.e) as string;
    if (lastTicket !== null && ticket !== lastTicket) {
      const priorTerminal = terminalEvents
        .filter((t) => getEventTicketId(t.e) === lastTicket && t.ts <= spawn.ts)
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
  }

  return violations;
}

function collectSpawnTsByTicket(activity: ActivityEvent[]): Map<string, string> {
  const spawnTsByTicket = new Map<string, string>();
  for (const e of activity) {
    if (e.event !== 'worker_spawn_backend_resolved') continue;
    const ticket = getEventTicketId(e);
    if (ticket === null || spawnTsByTicket.has(ticket)) continue;
    spawnTsByTicket.set(ticket, e.ts);
  }
  return spawnTsByTicket;
}

function computeWallClockMs(spawnTs: string, terminalTimestamps: Array<string | undefined>): number | null {
  const candidates = terminalTimestamps
    .filter((ts): ts is string => typeof ts === 'string')
    .map((ts) => Date.parse(ts))
    .filter((n) => !Number.isNaN(n));
  const spawnMs = Date.parse(spawnTs);
  if (candidates.length === 0 || Number.isNaN(spawnMs)) return null;
  return Math.min(...candidates) - spawnMs;
}

function classifyTicketGate(
  ticket: string,
  spawnTs: string,
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
  const wallClockMs = computeWallClockMs(spawnTs, [timeoutEvent?.ts, gateFailedEvents[0]?.ts, completionEvent?.ts]);

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
  const spawnTsByTicket = collectSpawnTsByTicket(activity);

  const tickets: TicketGateCompletion[] = [];
  for (const [ticket, spawnTs] of spawnTsByTicket) {
    tickets.push(classifyTicketGate(ticket, spawnTs, activity, narrowTierVacuity));
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

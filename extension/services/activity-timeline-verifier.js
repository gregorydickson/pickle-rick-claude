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
function getEventTicketId(e) {
    const ticketId = e.ticket_id;
    if (typeof ticketId === 'string' && ticketId.length > 0)
        return ticketId;
    const ticket = e.ticket;
    if (typeof ticket === 'string' && ticket.length > 0)
        return ticket;
    return null;
}
function parseTs(e) {
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
export function findOverlapViolations(activity) {
    const spawns = activity
        .map((e, index) => ({ e, index, ts: parseTs(e) }))
        .filter((entry) => entry.e.event === 'worker_spawn_backend_resolved' && getEventTicketId(entry.e) !== null && !Number.isNaN(entry.ts))
        .sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : a.index - b.index));
    const terminalEvents = activity
        .map((e) => ({ e, ts: parseTs(e) }))
        .filter((entry) => WORKER_TERMINAL_EVENTS.has(entry.e.event) && getEventTicketId(entry.e) !== null && !Number.isNaN(entry.ts));
    const violations = [];
    let lastTicket = null;
    let lastSpawnTs = '';
    for (const spawn of spawns) {
        const ticket = getEventTicketId(spawn.e);
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
function collectSpawnTsByTicket(activity) {
    const spawnTsByTicket = new Map();
    for (const e of activity) {
        if (e.event !== 'worker_spawn_backend_resolved')
            continue;
        const ticket = getEventTicketId(e);
        if (ticket === null || spawnTsByTicket.has(ticket))
            continue;
        spawnTsByTicket.set(ticket, e.ts);
    }
    return spawnTsByTicket;
}
function computeWallClockMs(spawnTs, terminalTimestamps) {
    const candidates = terminalTimestamps
        .filter((ts) => typeof ts === 'string')
        .map((ts) => Date.parse(ts))
        .filter((n) => !Number.isNaN(n));
    const spawnMs = Date.parse(spawnTs);
    if (candidates.length === 0 || Number.isNaN(spawnMs))
        return null;
    return Math.min(...candidates) - spawnMs;
}
function classifyTicketGate(ticket, spawnTs, activity, narrowTierVacuity) {
    const skipped = activity.some((e) => e.event === 'tier_phase_skipped' && getEventTicketId(e) === ticket
        && Array.isArray(e.skipped_phases) && e.skipped_phases.includes('test:fast'));
    const gateFailedEvents = activity.filter((e) => e.event === 'worker_gate_failed' && getEventTicketId(e) === ticket && e.gate_phase === 'test:fast');
    const timeoutEvent = gateFailedEvents.find((e) => Array.isArray(e.failures) && e.failures.some((f) => f?.name === '__timeout__'));
    const completionEvent = activity.find((e) => e.event === 'worker_completion_commit_announced' && getEventTicketId(e) === ticket);
    const timedOut = Boolean(timeoutEvent);
    const failedNonTimeout = gateFailedEvents.length > 0 && !timedOut;
    const wallClockMs = computeWallClockMs(spawnTs, [timeoutEvent?.ts, gateFailedEvents[0]?.ts, completionEvent?.ts]);
    const observedCompletion = !narrowTierVacuity && !skipped && !timedOut && !failedNonTimeout;
    const reason = narrowTierVacuity
        ? 'narrow_tier_shortcircuit'
        : observedCompletion
            ? 'observed'
            : skipped ? 'skipped' : (timedOut ? 'timed_out' : 'failed');
    return { ticket, spawned: true, skipped, timedOut, failedNonTimeout, observedCompletion, wallClockMs, reason };
}
export function buildGateCompletionReport(activity, opts) {
    const narrowTierVacuity = opts?.workerGateTier === 'narrow';
    const spawnTsByTicket = collectSpawnTsByTicket(activity);
    const tickets = [];
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

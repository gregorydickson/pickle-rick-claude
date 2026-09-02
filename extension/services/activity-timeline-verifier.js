/**
 * Pure overlap predicate (AC-6) + gate-completion report (AC-5a/AC-5b/AC-15) over a session's
 * activity array. No I/O — callers (the CLI, tests) supply the array.
 *
 * The activity schema carries no positive "test:fast passed" event, but it does carry a positive
 * END-OF-RUN event: the manager writes `boundary_commit_resolved` on the clean branch. So
 * `buildGateCompletionReport` requires THAT, never mere absence of a negative signal — a ticket
 * that was spawned and never heard from again (the run was killed, halted, or is still in flight)
 * is `unresolved`, not `observed`. It separately honors an explicit `workerGateTier: 'narrow'`
 * override (AC-5b) so the narrow-tier short-circuit — which emits no per-ticket activity event at
 * all — is never misreported as a clean run.
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
/**
 * The manager-side CLEAN branch: the ONE event that positively proves a ticket's run
 * ended without a gate failure. Named separately from the set because BOTH readers in
 * this file need it individually — `findOverlapViolations` asks "did the prior run end
 * at all", `classifyTicketGate` asks "did it end CLEANLY" — and two readers spelling
 * one vocabulary twice is how they drifted apart in the first place.
 */
const CLEAN_TERMINAL_EVENT = 'boundary_commit_resolved';
/** The manager-side GATE-RED branch, written after the worker process exits. */
const GATE_FAILED_EVENT = 'worker_gate_failed';
const WORKER_TERMINAL_EVENTS = new Set([GATE_FAILED_EVENT, CLEAN_TERMINAL_EVENT]);
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
    let lastSpawnMs = 0;
    for (const spawn of spawns) {
        const ticket = getEventTicketId(spawn.e);
        if (lastTicket !== null) {
            // EVERY consecutive spawn pair is checked, INCLUDING two spawns of the same ticket.
            // Nothing about serialization turns on ticket identity: the spawn lock admits one
            // worker per SESSION, not one per ticket, and a relaunch over a still-live
            // predecessor races two workers inside one ticket directory — worse than the
            // cross-ticket shape, not exempt from it. Measured over the 14 real sessions on the
            // authoring box, gating this branch on a differing ticket id hid 40 spawn pairs whose
            // window holds no terminal at all, and reported `OVERLAP: none` over every one.
            //
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
function collectSpawnMsByTicket(activity) {
    const spawnMsByTicket = new Map();
    for (const e of activity) {
        if (e.event !== 'worker_spawn_backend_resolved')
            continue;
        const ticket = getEventTicketId(e);
        if (ticket === null)
            continue;
        const spawnMsList = spawnMsByTicket.get(ticket) ?? [];
        const spawnMs = parseTs(e);
        if (!Number.isNaN(spawnMs))
            spawnMsList.push(spawnMs);
        spawnMsByTicket.set(ticket, spawnMsList);
    }
    for (const spawnMsList of spawnMsByTicket.values())
        spawnMsList.sort((a, b) => a - b);
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
function computeWallClockMs(spawnMsList, terminalTimestamps) {
    const candidates = terminalTimestamps
        .filter((ts) => typeof ts === 'string')
        .map((ts) => Date.parse(ts))
        .filter((n) => !Number.isNaN(n));
    if (candidates.length === 0)
        return null;
    const terminalMs = Math.min(...candidates);
    let owningSpawnMs = null;
    for (const spawnMs of spawnMsList) {
        if (spawnMs <= terminalMs)
            owningSpawnMs = spawnMs;
    }
    return owningSpawnMs === null ? null : terminalMs - owningSpawnMs;
}
/**
 * The ticket's disposition, in precedence order. Every arm returns a literal, which is why
 * `TicketGateCompletion['reason']` carries no `null`: a ticket reaches here only by having
 * been spawned, so it always HAS a disposition. A nullable verdict on a gate-reporting type
 * is a state no producer can emit and every reader must still carry — the report says
 * "unexplained" where none exists.
 *
 * Guard clauses, not a nested ternary: the arms are a priority list, and a list reads as one.
 * Adding an arm is a line here; under the ternary it was a re-nesting, and the previous shape
 * had already drifted to two arms indented and two crammed onto one line.
 */
function gateReason(flags) {
    if (flags.narrowTierVacuity)
        return 'narrow_tier_shortcircuit';
    if (flags.observedCompletion)
        return 'observed';
    if (flags.skipped)
        return 'skipped';
    if (flags.timedOut)
        return 'timed_out';
    if (flags.failedNonTimeout)
        return 'failed';
    return 'unresolved';
}
function classifyTicketGate(ticket, spawnMsList, activity, narrowTierVacuity) {
    const skipped = activity.some((e) => e.event === 'tier_phase_skipped' && getEventTicketId(e) === ticket
        && Array.isArray(e.skipped_phases) && e.skipped_phases.includes('test:fast'));
    const gateFailedEvents = activity.filter((e) => e.event === GATE_FAILED_EVENT && getEventTicketId(e) === ticket && e.gate_phase === 'test:fast');
    const timeoutEvent = gateFailedEvents.find((e) => Array.isArray(e.failures) && e.failures.some((f) => f?.name === '__timeout__'));
    // The clean-branch terminal, read from the SAME vocabulary `findOverlapViolations` uses.
    // The predecessor here was `worker_completion_commit_announced` — the event AP-EXT-ITER6-01
    // had already established is NOT terminal (spawn-morty writes it from the LIVE worker's
    // stdout) and which no manager emits at all: 0 occurrences across the 7 sessions on this
    // box, against 10 for `boundary_commit_resolved`. So the clean arm never fired and every
    // cleanly-completed ticket measured `wallClockMs: null`.
    const cleanTerminalEvent = activity.find((e) => e.event === CLEAN_TERMINAL_EVENT && getEventTicketId(e) === ticket);
    const timedOut = Boolean(timeoutEvent);
    const failedNonTimeout = gateFailedEvents.length > 0 && !timedOut;
    const wallClockMs = computeWallClockMs(spawnMsList, [timeoutEvent?.ts, gateFailedEvents[0]?.ts, cleanTerminalEvent?.ts]);
    // POSITIVE evidence, not the absence of a negative. The predecessor was four absence
    // conjuncts (`!timedOut && !failedNonTimeout` on top of these two), which made "spawned and
    // never heard from again" indistinguishable from "finished cleanly": measured over the 74
    // real spawned tickets on this box, 59 read `observed` and 56 of those carried NO terminal
    // event of any kind. The two dropped conjuncts are SUBSUMED, not discarded — a ticket whose
    // run ended at the gate-red branch has no `CLEAN_TERMINAL_EVENT` to find, so it fails this
    // check on the same evidence it used to fail theirs. That absence-is-evidence reading is
    // the `did-we-count` shape this file exists to report on; it must not be the way it reports.
    const observedCompletion = !narrowTierVacuity && !skipped && Boolean(cleanTerminalEvent);
    const reason = gateReason({ narrowTierVacuity, observedCompletion, skipped, timedOut, failedNonTimeout });
    return { ticket, spawned: true, skipped, timedOut, failedNonTimeout, observedCompletion, wallClockMs, reason };
}
export function buildGateCompletionReport(activity, opts) {
    const narrowTierVacuity = opts?.workerGateTier === 'narrow';
    const spawnMsByTicket = collectSpawnMsByTicket(activity);
    const tickets = [];
    for (const [ticket, spawnMsList] of spawnMsByTicket) {
        tickets.push(classifyTicketGate(ticket, spawnMsList, activity, narrowTierVacuity));
    }
    const observedCompletions = tickets.filter((t) => t.observedCompletion).length;
    const timeouts = tickets.filter((t) => t.timedOut).length;
    const unresolved = tickets.filter((t) => t.reason === 'unresolved').length;
    // `unresolved` is carried in the headline because omitting it is the same defect one
    // level up: a reader told "6 observed completions" of 74 spawned tickets cannot tell
    // whether the other 68 failed or simply never reported. Say what was MEASURED.
    return {
        tickets,
        narrowTierVacuity,
        summary: {
            observedCompletions,
            timeouts,
            unresolved,
            verdict: `${observedCompletions} observed completions, ${timeouts} timeouts, ${unresolved} unresolved`,
        },
    };
}

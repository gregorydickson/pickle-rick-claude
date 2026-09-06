/**
 * Rung 1 — commit-and-continue: the ARMED gate is consulted directly (skip-flag-blind
 * by construction). Returns `advanced` on a committed Done flip, or `null` to fall
 * through to fix-forward-trivial (gate red, commit blocked, or adapter threw).
 */
function attemptCommitAndContinue(deps, record) {
    try {
        if (deps.runArmedGate().ok) {
            const r = deps.commitAndFlipDone();
            if (r.ok) {
                record('commit-and-continue', 'success', `committed gate-passing tree for ${deps.ticketId}`);
                deps.log(`recovery: commit-and-continue advanced ${deps.ticketId}${r.sha ? ` (${r.sha})` : ''}`);
                return { kind: 'advanced', strategy: 'commit-and-continue', sha: r.sha };
            }
            // INV-LADDER-RUNG-FAILURE: commit blocked (e.g. config-protection hook) →
            // record + fall through to fix-forward-trivial, NOT to a terminal.
            record('commit-and-continue', 'failed', `armed gate passed but commit was blocked for ${deps.ticketId}`);
        }
        // gate red — not a commit-and-continue case; fix-forward-trivial owns it.
    }
    catch (err) {
        record('commit-and-continue', 'failed', `commit-and-continue threw: ${errText(err)}`);
    }
    return null;
}
/**
 * Rung 2 — fix-forward-trivial: spawn the remediator once (bounded by `maxSpawns`),
 * re-gate, retry the commit. Returns `advanced` on success or `null` to fall through.
 * INV-FIX-FORWARD-BOUND: at most one remediator spawn per call; `maxSpawns < 1` disables it.
 */
function attemptFixForwardTrivial(deps, record, maxSpawns) {
    if (maxSpawns < 1) {
        deps.log(`recovery: fix-forward-trivial bound (M=${maxSpawns}) reached for ${deps.ticketId}`);
        return null;
    }
    try {
        const remediated = deps.spawnRemediator();
        if (remediated && deps.runArmedGate().ok) {
            const r = deps.commitAndFlipDone();
            if (r.ok) {
                record('fix-forward-trivial', 'success', `remediated + committed ${deps.ticketId}`);
                deps.log(`recovery: fix-forward-trivial advanced ${deps.ticketId}${r.sha ? ` (${r.sha})` : ''}`);
                return { kind: 'advanced', strategy: 'fix-forward-trivial', sha: r.sha };
            }
            record('fix-forward-trivial', 'failed', `remediated + gate green but commit still blocked for ${deps.ticketId}`);
        }
        else {
            record('fix-forward-trivial', 'failed', `remediator ${remediated ? 're-gate still red' : 'failed'} for ${deps.ticketId}`);
        }
    }
    catch (err) {
        record('fix-forward-trivial', 'failed', `fix-forward-trivial threw: ${errText(err)}`);
    }
    return null;
}
/**
 * Rung 3 — execute-converged-plan (R-ORSR-3 seam): approved plan + artifacts, no diff.
 * Returns `advanced` when the injected executor succeeds, else `null`. Until R-ORSR-3
 * (e8f46d84) wires the executor, records the attempt and falls down the ladder.
 */
function attemptExecuteConvergedPlan(deps, record) {
    if (!deps.executeConvergedPlan) {
        record('execute-converged-plan', 'failed', 'R-ORSR-3 converged-plan executor not wired yet');
        return null;
    }
    try {
        const r = deps.executeConvergedPlan();
        if (r.ok) {
            record('execute-converged-plan', 'success', `executed converged plan for ${deps.ticketId}`);
            deps.log(`recovery: execute-converged-plan advanced ${deps.ticketId}`);
            return { kind: 'advanced', strategy: 'execute-converged-plan' };
        }
        record('execute-converged-plan', 'failed', `converged-plan execution returned not-ok for ${deps.ticketId}`);
    }
    catch (err) {
        record('execute-converged-plan', 'failed', `execute-converged-plan threw: ${errText(err)}`);
    }
    return null;
}
/**
 * Run the ordered recovery ladder. Each rung is attempted at most once per call and
 * appends a `RecoveryAttempt` to the ledger on every outcome. A rung whose adapter
 * throws records a `failed` attempt and the ladder advances — a throw can never
 * yield `advanced`, so no orphaned half-commit can ride to Done (INV-RUNG-ERROR-CONTAINED).
 */
export function runRecoveryLadder(deps) {
    const maxSpawns = Number.isInteger(deps.maxRemediatorSpawns) && deps.maxRemediatorSpawns >= 0
        ? deps.maxRemediatorSpawns
        : 1;
    const record = (strategy, outcome, reason) => {
        try {
            deps.appendAttempt({ strategy, outcome, reason, iteration: deps.iteration });
        }
        catch { /* ledger append is best-effort — never block recovery on a state write */ }
    };
    let evidence;
    try {
        evidence = deps.assessEvidence();
    }
    catch (err) {
        record('escalate', 'failed', `evidence assessment threw: ${errText(err)}`);
        return { kind: 'exhausted', reason: 'evidence_unreadable' };
    }
    if (evidence.treeDirty) {
        const committed = attemptCommitAndContinue(deps, record);
        if (committed)
            return committed;
        const fixedForward = attemptFixForwardTrivial(deps, record, maxSpawns);
        if (fixedForward)
            return fixedForward;
    }
    if (evidence.planConvergedUncommitted) {
        const planned = attemptExecuteConvergedPlan(deps, record);
        if (planned)
            return planned;
    }
    // Rung 4 — auto-split (DOWN-SCOPED): genuine zero-output → fall through to the
    // EXISTING oversized_no_progress / terminal Failed-flip. True runtime decomposition
    // is a follow-up (R-ONPD-FU).
    if (evidence.noWorkProduced) {
        record('auto-split', 'failed', 'no_work_produced — falling through to existing oversized_no_progress Failed-flip');
        return { kind: 'fall_through', reason: 'no_work_produced' };
    }
    // Rung 5 — escalate: the ladder is exhausted. Honest terminal.
    record('escalate', 'failed', 'recovery ladder exhausted without a recoverable signal');
    return { kind: 'exhausted', reason: 'ladder_exhausted' };
}
/**
 * R-ORSR-3 approval predicate: a converged plan is eligible for execute-converged-plan
 * iff a `plan_*.md` artifact exists AND the co-located `plan_review.md` carries APPROVED.
 * Pure, so the runtime evidence assessor (mux-runner) and the unit tests share one
 * definition rather than drifting two copies of the eligibility rule.
 */
export function isConvergedPlanEligible(inputs) {
    return inputs.planArtifactExists && inputs.planReviewApproved;
}
const PLAN_PHASE_SPLIT_RE = /^(?=## Phase \d+)/m;
const PLAN_PHASE_HEADER_RE = /^## Phase (\d+)\s*(?:[—-]\s*(.*))?$/m;
const PLAN_PHASE_VERIFY_RE = /\*\*Verify:\*\*[^`\n]*`([^`]+)`/;
/**
 * Parse the authored `## Phase N — Title` blocks (each with an optional
 * `**Verify:** \`cmd\`` line) out of an approved plan's markdown. The Phase is the plan's
 * authored unit (spawn-morty plan template), NOT a finding. Blocks without a parseable
 * header are skipped; a block with no verify command yields `verify: null`.
 */
export function parsePlanPhases(planMarkdown) {
    const phases = [];
    for (const block of planMarkdown.split(PLAN_PHASE_SPLIT_RE)) {
        const header = block.match(PLAN_PHASE_HEADER_RE);
        if (!header)
            continue;
        const verify = block.match(PLAN_PHASE_VERIFY_RE);
        phases.push({
            index: Number(header[1]),
            title: (header[2] ?? '').trim(),
            verify: verify ? verify[1].trim() : null,
        });
    }
    return phases;
}
/**
 * Execute the approved plan one Phase at a time: each phase that runs ok is committed
 * immediately (one fix per commit, bounding cost by Phase count). The FIRST phase whose
 * `executePhase` or `commitPhase` returns not-ok stops the loop — phases `0..committed-1`
 * are already committed, the failing phase is not, and `{ ok:false }` propagates so the
 * caller never marks the ticket Done (R-ORSR-3 partial-failure contract). An empty plan
 * is `{ ok:false }`: nothing to execute, so the rung honestly fails. An adapter that
 * throws is contained as a not-ok step (INV-RUNG-ERROR-CONTAINED parity).
 */
export function executePhaseLoop(deps) {
    if (deps.phases.length === 0)
        return { ok: false, committed: 0, failedIndex: null };
    let committed = 0;
    for (let i = 0; i < deps.phases.length; i++) {
        const phase = deps.phases[i];
        if (!safeStep(() => deps.executePhase(phase, i)))
            return { ok: false, committed, failedIndex: i };
        if (!safeStep(() => deps.commitPhase(phase, i)))
            return { ok: false, committed, failedIndex: i };
        committed += 1;
    }
    return { ok: true, committed, failedIndex: null };
}
/** Run one DI step, treating a throw as a not-ok result (INV-RUNG-ERROR-CONTAINED parity). */
function safeStep(fn) {
    try {
        return fn().ok;
    }
    catch {
        return false;
    }
}
function errText(err) {
    return err instanceof Error ? err.message : String(err);
}

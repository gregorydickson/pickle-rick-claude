#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { printMinimalPanel, collectTickets, statusSymbol, findSessionPathForCwd, getTicketStatus, getDataRoot, resolveWorkerTestGateTimeoutMs } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
import { readMicroverseState, readRecoverableJsonObject } from '../services/microverse-state.js';
const sm = new StateManager();
export function computeConsecutiveNoProgress(mvState) {
    const recent = (mvState.failure_history ?? []).slice(-3);
    return Math.min(recent.filter(f => f.failure_class === 'no_progress').length, 3);
}
function readSessionState(sessionPath) {
    try {
        return sm.read(path.join(sessionPath, 'state.json'));
    }
    catch {
        return null;
    }
}
function formatIteration(state) {
    const maxIter = Number(state.max_iterations) || 0;
    const curIter = Number(state.iteration) || 0;
    return maxIter > 0 ? `${curIter} of ${maxIter}` : String(curIter);
}
function formatTask(raw) {
    const task = raw || '';
    return task.length > 80 ? task.slice(0, 80) + '…' : task;
}
function readPipelineStatus(sessionPath) {
    const statusPath = path.join(sessionPath, 'pipeline-status.json');
    // Recoverable read: promote a newer `.tmp.<pid>` snapshot left by an
    // interrupted tmp-rename write (writePipelineStatus) before the base file.
    // Matches the sibling readers in monitor.ts and pipeline-runner.ts.
    const raw = readRecoverableJsonObject(statusPath);
    return raw ? raw : null;
}
function getRecoverablePhaseFailures(state) {
    if (!Array.isArray(state.activity))
        return [];
    return state.activity.flatMap((entry) => {
        if (entry?.event !== 'recoverable_phase_failure'
            || typeof entry.phase !== 'string'
            || typeof entry.exit_code !== 'number') {
            return [];
        }
        return [{ phase: entry.phase, exitCode: entry.exit_code }];
    });
}
function hasPipelineArtifacts(sessionPath, state) {
    return fs.existsSync(path.join(sessionPath, 'pipeline.json'))
        || fs.existsSync(path.join(sessionPath, 'pipeline-status.json'))
        || (Array.isArray(state.activity) && state.activity.length > 0);
}
function renderPipelineRecap(sessionPath, state) {
    if (!hasPipelineArtifacts(sessionPath, state))
        return;
    const pipelineStatus = readPipelineStatus(sessionPath);
    const recoverableFailures = getRecoverablePhaseFailures(state);
    // AP-EXT-ITER148-02: both halves of this ratio come from the ONE record the
    // pipeline writes. The former numerator counted a `phase_completed` activity
    // event, which no producer has ever emitted -- it is absent from
    // VALID_ACTIVITY_EVENTS and from activity-events.schema.json, so the typed
    // writer could not emit it even by mistake, and every real run printed `0/N`
    // beside a denominator read from `pipeline-status.json` two lines apart.
    const phasesCompleted = Number(pipelineStatus?.completed_phases) || 0;
    const totalPhases = Number(pipelineStatus?.total_phases) || 0;
    if (recoverableFailures.length > 0) {
        const latestFailure = recoverableFailures[recoverableFailures.length - 1];
        console.log(`Phase ${latestFailure.phase} exited with code ${latestFailure.exitCode} — pipeline continued to remediation`);
    }
    console.log(`Pipeline recap: ${phasesCompleted}/${totalPhases} phases completed`);
    console.log(`Recoverable phase failures: ${recoverableFailures.length}`);
    console.log('');
}
function renderTickets(sessionPath) {
    const tickets = collectTickets(sessionPath);
    if (tickets.length === 0)
        return;
    console.log('Tickets:');
    for (const ticket of tickets) {
        const status = ticket.id ? getTicketStatus(sessionPath, ticket.id) : ticket.status;
        console.log(`  ${statusSymbol(status)} ${ticket.id}: ${ticket.title}`);
    }
    console.log('');
}
function renderScopeDrift(sessionPath) {
    const tickets = collectTickets(sessionPath);
    const ticketIds = new Set(tickets.map((t) => t.id).filter(Boolean));
    if (ticketIds.size === 0)
        return;
    const activityDir = path.join(getDataRoot(), 'activity');
    if (!fs.existsSync(activityDir))
        return;
    let files;
    try {
        files = fs.readdirSync(activityDir).filter((f) => f.endsWith('.jsonl'));
    }
    catch {
        return;
    }
    const driftEvents = [];
    for (const file of files) {
        const filePath = path.join(activityDir, file);
        let content;
        try {
            content = fs.readFileSync(filePath, 'utf-8');
        }
        catch {
            continue;
        }
        for (const line of content.split('\n').filter(Boolean)) {
            try {
                const ev = JSON.parse(line);
                if (ev.event === 'worker_edit_outside_scope' && typeof ev.ticket_id === 'string' && ticketIds.has(ev.ticket_id)) {
                    driftEvents.push(ev);
                }
            }
            catch {
                // skip malformed lines
            }
        }
    }
    if (driftEvents.length === 0)
        return;
    const driftTickets = [...new Set(driftEvents.map((e) => e.ticket_id).filter(Boolean))];
    console.log(`Scope drift: ${driftEvents.length} edit(s) outside scope.json — tickets: ${driftTickets.join(', ')}`);
    console.log('');
}
export function showStatus(cwd) {
    const sessionPath = findSessionPathForCwd(cwd);
    if (!sessionPath || !fs.existsSync(sessionPath)) {
        console.log('🥒 No active Pickle Rick session for this directory.');
        return;
    }
    const state = readSessionState(sessionPath);
    if (!state) {
        console.log('🥒 Session state is unreadable.');
        process.exit(1);
    }
    const isActive = state.active === true;
    const mode = state.tmux_mode === true ? 'tmux' : 'inline';
    const mvState = readMicroverseState(sessionPath);
    const fields = {
        Active: isActive ? 'Yes' : 'No',
        Mode: mode,
        Phase: state.step || 'unknown',
        Iteration: formatIteration(state),
        Ticket: state.current_ticket || 'none',
        // Surface resolved pickle_settings.json.worker_test_gate_timeout_ms to operators.
        'Worker test gate timeout': `${resolveWorkerTestGateTimeoutMs()} ms`,
        Task: formatTask(state.original_prompt),
    };
    if (mvState !== null) {
        const count = computeConsecutiveNoProgress(mvState);
        const isLlm = mvState.key_metric?.type === 'llm';
        fields['Consecutive no_progress'] = `${count}/3${isLlm ? ' [LLM bypass active]' : ''}`;
    }
    printMinimalPanel('Pickle Rick — Session Status', fields, isActive ? 'GREEN' : 'RED', '🥒');
    renderPipelineRecap(sessionPath, state);
    renderTickets(sessionPath);
    renderScopeDrift(sessionPath);
}
if (process.argv[1] && path.basename(process.argv[1]) === 'status.js') {
    showStatus(process.cwd());
}

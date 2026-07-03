import * as path from 'path';
import { isRecord } from '../lib/is-record.js';
import { Defaults } from '../types/index.js';
import { logActivity } from './activity-logger.js';
import { resolveBackend } from './backend-spawn.js';
import { getExtensionRoot, safeErrorMessage } from './pickle-utils.js';
import { readRecoverableJsonObject } from './recoverable-json.js';
import { StateManager } from './state-manager.js';
const sm = new StateManager();
function readFiniteCount(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function readClaudeManagerRelaunchCapOverride() {
    const settingsPath = path.join(getExtensionRoot(), 'pickle_settings.json');
    const raw = readRecoverableJsonObject(settingsPath);
    if (!isRecord(raw))
        return null;
    const parsed = readFiniteCount(raw.claude_manager_relaunch_cap);
    return parsed !== null && parsed >= 0 ? parsed : null;
}
export function currentManagerRelaunchCount(state) {
    return readFiniteCount(state.manager_relaunch_count) ??
        readFiniteCount(state.codex_manager_relaunch_count) ??
        0;
}
export function managerRelaunchCapForBackend(backend) {
    if (backend === 'claude') {
        return readClaudeManagerRelaunchCapOverride() ?? Defaults.CLAUDE_MANAGER_RELAUNCH_CAP;
    }
    return Defaults.CODEX_MANAGER_RELAUNCH_CAP;
}
function managerRelaunchCapForExitKind(exitKind, backend) {
    if (exitKind === 'claude_max_turns') {
        return readClaudeManagerRelaunchCapOverride() ?? Defaults.CLAUDE_MANAGER_RELAUNCH_CAP;
    }
    return managerRelaunchCapForBackend(backend);
}
export function managerRelaunchCap(state) {
    return managerRelaunchCapForBackend(resolveBackend(state));
}
function ticketIsPending(ticket) {
    if (!ticket.id)
        return false;
    const status = (ticket.status || '').toLowerCase().replace(/["']/g, '').trim();
    return status !== 'done' && status !== 'skipped';
}
function evaluateSimpleManagerRelaunch(state, hasPendingWork) {
    const currentCount = currentManagerRelaunchCount(state);
    const cap = managerRelaunchCap(state);
    if (!hasPendingWork) {
        return { should_relaunch: false, reason: 'no_pending_work', current_count: currentCount, cap };
    }
    if (currentCount >= cap) {
        return { should_relaunch: false, reason: 'at_cap', current_count: currentCount, cap };
    }
    return { should_relaunch: true, reason: 'below_cap', current_count: currentCount, cap };
}
function evaluateTicketManagerRelaunch(state, tickets, cbState, exitKind) {
    const backend = resolveBackend(state);
    const cap = managerRelaunchCapForExitKind(exitKind, backend);
    const startEpoch = Number.isFinite(Number(state.start_time_epoch)) ? Number(state.start_time_epoch) : 0;
    const maxTimeMins = Number.isFinite(Number(state.max_time_minutes)) ? Number(state.max_time_minutes) : 0;
    if (maxTimeMins > 0 && startEpoch > 0) {
        const elapsedSec = Math.max(0, Math.floor(Date.now() / 1000) - startEpoch);
        if (elapsedSec >= maxTimeMins * 60) {
            return {
                shouldRelaunch: false,
                pendingCount: 0,
                nextRelaunchCount: 0,
                reason: 'time_limit',
                cap,
                backend,
                exitKind,
            };
        }
    }
    if (cbState && cbState.state === 'OPEN') {
        return {
            shouldRelaunch: false,
            pendingCount: 0,
            nextRelaunchCount: 0,
            reason: 'circuit_open',
            cap,
            backend,
            exitKind,
        };
    }
    const pending = tickets.filter(ticketIsPending);
    if (pending.length === 0) {
        return {
            shouldRelaunch: false,
            pendingCount: 0,
            nextRelaunchCount: 0,
            reason: 'no_pending',
            cap,
            backend,
            exitKind,
        };
    }
    const prior = currentManagerRelaunchCount(state);
    if (prior >= cap) {
        return {
            shouldRelaunch: false,
            pendingCount: pending.length,
            nextRelaunchCount: prior,
            reason: 'cap_exceeded',
            cap,
            backend,
            exitKind,
        };
    }
    return {
        shouldRelaunch: true,
        pendingCount: pending.length,
        nextRelaunchCount: prior + 1,
        reason: 'eligible',
        cap,
        backend,
        exitKind,
    };
}
export function evaluateManagerRelaunch(state, pendingInput, cbStateOrExitKind, exitKind = 'other_error') {
    if (typeof pendingInput === 'boolean') {
        return evaluateSimpleManagerRelaunch(state, pendingInput);
    }
    const cbState = typeof cbStateOrExitKind === 'string' ? null : (cbStateOrExitKind ?? null);
    const resolvedExitKind = typeof cbStateOrExitKind === 'string' ? cbStateOrExitKind : exitKind;
    return evaluateTicketManagerRelaunch(state, pendingInput, cbState, resolvedExitKind);
}
export function recordManagerRelaunch(statePath, sessionDir, decision, iteration, log = () => { }) {
    let lastTicketSeen = null;
    try {
        sm.update(statePath, s => {
            lastTicketSeen = typeof s.current_ticket === 'string' && s.current_ticket.length > 0
                ? s.current_ticket
                : null;
            s.manager_relaunch_count = decision
                ? decision.nextRelaunchCount
                : currentManagerRelaunchCount(s) + 1;
            delete s.codex_manager_relaunch_count;
        });
    }
    catch (err) {
        log(`WARN: failed to persist manager_relaunch_count: ${safeErrorMessage(err)}`);
    }
    if (sessionDir && iteration !== undefined) {
        if (decision?.exitKind === 'claude_max_turns' || decision?.exitKind === 'codex_session_inactive') {
            logActivity({
                event: 'manager_max_turns_relaunch',
                source: 'pickle',
                session: path.basename(sessionDir),
                iteration,
                backend: decision.backend,
                relaunch_count: decision.nextRelaunchCount,
                cap: decision.cap,
                pending_count: decision.pendingCount,
                last_ticket_seen: lastTicketSeen,
            });
            return;
        }
        logActivity({
            event: 'codex_manager_relaunch',
            source: 'pickle',
            session: path.basename(sessionDir),
            iteration,
        });
    }
}

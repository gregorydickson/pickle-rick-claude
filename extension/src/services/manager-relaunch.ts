import * as path from 'path';
import { isRecord } from '../lib/is-record.js';
import { Defaults, type Backend, type State } from '../types/index.js';
import { logActivity } from './activity-logger.js';
import { resolveBackend } from './backend-spawn.js';
import type { CircuitBreakerState } from './circuit-breaker.js';
import { getExtensionRoot, type TicketInfo, safeErrorMessage } from './pickle-utils.js';
import { readRecoverableJsonObject } from './recoverable-json.js';
import { StateManager } from './state-manager.js';

const sm = new StateManager();

export type ManagerRelaunchExitKind =
  | 'codex_4h_hang_guard'
  | 'codex_session_inactive'
  | 'claude_max_turns'
  | 'other_error';

export interface RelaunchEvaluation {
  should_relaunch: boolean;
  reason: 'below_cap' | 'at_cap' | 'wrong_backend' | 'no_pending_work';
  current_count: number;
  cap: number;
}

export interface ManagerRelaunchDecision {
  shouldRelaunch: boolean;
  pendingCount: number;
  nextRelaunchCount: number;
  reason: 'eligible' | 'not_codex' | 'no_pending' | 'cap_exceeded' | 'circuit_open' | 'time_limit';
  cap: number;
  backend: Backend;
  exitKind: ManagerRelaunchExitKind;
}

function readFiniteCount(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readClaudeManagerRelaunchCapOverride(): number | null {
  const settingsPath = path.join(getExtensionRoot(), 'pickle_settings.json');
  const raw = readRecoverableJsonObject(settingsPath);
  if (!isRecord(raw)) return null;
  const parsed = readFiniteCount(raw.claude_manager_relaunch_cap);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

export function currentManagerRelaunchCount(
  state: Pick<State, 'manager_relaunch_count' | 'codex_manager_relaunch_count'>,
): number {
  return readFiniteCount(state.manager_relaunch_count) ??
    readFiniteCount(state.codex_manager_relaunch_count) ??
    0;
}

export function managerRelaunchCapForBackend(backend: Backend): number {
  if (backend === 'claude') {
    return readClaudeManagerRelaunchCapOverride() ?? Defaults.CLAUDE_MANAGER_RELAUNCH_CAP;
  }
  return Defaults.CODEX_MANAGER_RELAUNCH_CAP;
}

function managerRelaunchCapForExitKind(exitKind: ManagerRelaunchExitKind, backend: Backend): number {
  if (exitKind === 'claude_max_turns') {
    return readClaudeManagerRelaunchCapOverride() ?? Defaults.CLAUDE_MANAGER_RELAUNCH_CAP;
  }
  return managerRelaunchCapForBackend(backend);
}

export function managerRelaunchCap(state: State): number {
  return managerRelaunchCapForBackend(resolveBackend(state));
}

function ticketIsPending(ticket: TicketInfo): boolean {
  if (!ticket.id) return false;
  const status = (ticket.status || '').toLowerCase().replace(/["']/g, '').trim();
  return status !== 'done' && status !== 'skipped';
}

function evaluateSimpleManagerRelaunch(
  state: State,
  hasPendingWork: boolean,
): RelaunchEvaluation {
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

function evaluateTicketManagerRelaunch(
  state: State,
  tickets: readonly TicketInfo[],
  cbState: CircuitBreakerState | null,
  exitKind: ManagerRelaunchExitKind,
): ManagerRelaunchDecision {
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

export function evaluateManagerRelaunch(
  state: State,
  hasPendingWork: boolean,
  exitKind?: ManagerRelaunchExitKind,
): RelaunchEvaluation;
export function evaluateManagerRelaunch(
  state: State,
  tickets: readonly TicketInfo[],
  cbState: CircuitBreakerState | null,
  exitKind?: ManagerRelaunchExitKind,
): ManagerRelaunchDecision;
export function evaluateManagerRelaunch(
  state: State,
  pendingInput: boolean | readonly TicketInfo[],
  cbStateOrExitKind?: CircuitBreakerState | null | ManagerRelaunchExitKind,
  exitKind = 'other_error' as ManagerRelaunchExitKind,
): RelaunchEvaluation | ManagerRelaunchDecision {
  if (typeof pendingInput === 'boolean') {
    return evaluateSimpleManagerRelaunch(state, pendingInput);
  }

  const cbState = typeof cbStateOrExitKind === 'string' ? null : (cbStateOrExitKind ?? null);
  const resolvedExitKind = typeof cbStateOrExitKind === 'string' ? cbStateOrExitKind : exitKind;
  return evaluateTicketManagerRelaunch(state, pendingInput, cbState, resolvedExitKind);
}

export function recordManagerRelaunch(statePath: string): void;
export function recordManagerRelaunch(
  statePath: string,
  sessionDir: string,
  decision: ManagerRelaunchDecision,
  iteration: number,
  log: (msg: string) => void,
): void;
export function recordManagerRelaunch(
  statePath: string,
  sessionDir?: string,
  decision?: ManagerRelaunchDecision,
  iteration?: number,
  log: (msg: string) => void = () => {},
): void {
  let lastTicketSeen: string | null = null;
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
  } catch (err) {
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

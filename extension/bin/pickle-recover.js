#!/usr/bin/env node
// W2.R0 / CUJ-1: the single sanctioned, hook-safe operator recovery command.
//
// One command resolves a `recovery_exhausted` session. FOUR subcommands, each
// performing EXACTLY ONE transition by calling a SHARED primitive — never inline
// git, never writing state.json outside StateManager (so the config-protection
// hook passes):
//
//   --resume-from-todo   select the lowest runnable Todo, reuse the C5
//                        ff-reattach primitive (detectAndRecoverHeadRegression)
//                        to reattach any orphaned commit, re-queue it (Todo).
//   --salvage <ticket>   call salvageTicket() (commit+Done / archive+Todo /
//                        ff-reattach / no-op, per the tree+gate).
//   --reattach-orphan    call detectAndRecoverHeadRegression() (ff-only reattach).
//   --reset-ticket <id>  archive the diff + reset the ticket to Todo via the
//                        shared salvageTicket archive+resetTodo disposition.
//
// `--plan` is a dry-run: it prints the would-be transition and performs NO write
// (no StateManager.update, no logActivity, no frontmatter write, no git).
//
// Each REAL (non-plan) invocation emits exactly ONE `operator_recovery_transition`
// activity event. The command refuses to run on a non-`recovery_exhausted` session
// unless `--plan` is given.
import * as path from 'path';
import { StateManager } from '../services/state-manager.js';
import { logActivity } from '../services/activity-logger.js';
import { salvageTicket } from '../lib/salvage-ticket.js';
import { reconcileTicketTruth } from '../lib/reconcile-ticket-truth.js';
import { detectAndRecoverHeadRegression } from './mux-runner.js';
import { collectTickets, getTicketStatus, findSessionPathForCwd, safeErrorMessage, } from '../services/pickle-utils.js';
import { updateTicketFrontmatter } from '../services/git-utils.js';
const RECOVERY_ENTRY_STATE = 'recovery_exhausted';
const RECOVERY_EVENT = 'operator_recovery_transition';
const defaultDeps = {
    readState: (statePath) => new StateManager().read(statePath),
    updateState: (statePath, mutator) => { new StateManager().update(statePath, mutator); },
    resolveSessionPath: (cwd) => findSessionPathForCwd(cwd),
    collectTickets,
    ticketStatus: getTicketStatus,
    salvage: (input, deps) => salvageTicket(input, deps),
    reattach: detectAndRecoverHeadRegression,
    setTicketTodo: (ticketId, sessionDir) => updateTicketFrontmatter(ticketId, sessionDir, { status: 'Todo', completion_commit: null }),
    emit: (transition, sessionDir) => {
        logActivity({
            event: RECOVERY_EVENT,
            source: 'pickle',
            session: path.basename(sessionDir),
            gate_payload: {
                subcommand: transition.subcommand,
                ticket: transition.ticket,
                disposition: transition.disposition,
            },
        });
    },
    log: (msg) => process.stdout.write(`${msg}\n`),
};
const USAGE = 'Usage: pickle-recover <--resume-from-todo | --salvage <ticket> | ' +
    '--reattach-orphan | --reset-ticket <id> | --reactivate> [--plan]';
export class RecoverArgError extends Error {
}
/** Strict arg parse: exactly one subcommand; salvage/reset-ticket require a ticket id. */
export function parseArgs(argv) {
    let subcommand = null;
    let ticketArg = null;
    let plan = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '--plan':
                plan = true;
                break;
            // No-argument subcommands share one body: the flag minus its `--` prefix
            // is exactly the RecoverSubcommand value (see the RecoverSubcommand union).
            case '--resume-from-todo':
            case '--reattach-orphan':
            case '--reactivate':
                if (subcommand)
                    throw new RecoverArgError('only one subcommand may be given');
                subcommand = arg.slice(2);
                break;
            case '--salvage':
            case '--reset-ticket': {
                if (subcommand)
                    throw new RecoverArgError('only one subcommand may be given');
                const next = argv[i + 1];
                if (!next || next.startsWith('--')) {
                    throw new RecoverArgError(`${arg} requires a ticket id`);
                }
                subcommand = arg === '--salvage' ? 'salvage' : 'reset-ticket';
                ticketArg = next;
                i++;
                break;
            }
            default:
                throw new RecoverArgError(`unknown argument: ${arg}`);
        }
    }
    if (!subcommand)
        throw new RecoverArgError('a subcommand is required');
    return { subcommand, ticketArg, plan };
}
/** Lowest runnable (Todo / In Progress) ticket by numeric order, or null. */
export function selectLowestRunnableTodo(sessionDir, deps) {
    const runnable = deps
        .collectTickets(sessionDir)
        .filter((t) => {
        if (!t.id)
            return false;
        const status = (deps.ticketStatus(sessionDir, t.id) ?? '').toLowerCase().replace(/["']/g, '').trim();
        return status === 'todo' || status === 'in progress';
    })
        .sort((a, b) => a.order - b.order);
    return runnable.length > 0 ? runnable[0].id : null;
}
/** Force the salvageTicket archive+resetTodo (`archived-todo`) disposition without inline git. */
function resetTicketViaSalvage(input, deps) {
    // gate -> 'failing' routes salvageTicket into its archive-then-resetTodo branch;
    // reconcile reports a dirty, non-terminal ticket so the branch is reached. The
    // archive + frontmatter-Todo writes are salvage's own shared deps — no inline git.
    const salvageDeps = {
        reconcile: () => reconcileTicketTruth({ sessionDir: input.sessionDir, workingDir: input.workingDir }),
        gate: () => 'failing',
    };
    // No cast: salvageTicket takes Partial<SalvageDeps> and merges over its own
    // defaults. The `as SalvageDeps` that used to sit here laundered a 2-key object
    // into a 6-key type, so every unsupplied dep was `undefined` at runtime.
    return deps.salvage(input, salvageDeps);
}
/**
 * Resolve the session, read its state, and enforce the `recovery_exhausted`
 * gate. Returns the resolved context, or a terminal `RunRecoverResult` (no
 * session / unreadable / refusal) the caller returns verbatim.
 */
function resolveAndGate(args, cwd, deps) {
    const sessionDir = deps.resolveSessionPath(cwd);
    if (!sessionDir) {
        deps.log('No active session found for this directory.');
        return { code: 1, transition: null };
    }
    const statePath = path.join(sessionDir, 'state.json');
    let state;
    try {
        state = deps.readState(statePath);
    }
    catch (err) {
        deps.log(`State file is unreadable: ${safeErrorMessage(err)}`);
        return { code: 1, transition: null };
    }
    const exitReason = state.exit_reason ?? null;
    // `reactivate` un-terminalizes a session driven to {active:false, step:'completed'} — its target
    // is a COMPLETED session, never `recovery_exhausted`, so it is exempt from the entry-state gate.
    // But it MUST refuse a still-live session: flipping {active,step,current_ticket} under a running
    // mux-runner clobbers its in-flight state mid-iteration. --plan stays a safe dry-run.
    if (args.subcommand === 'reactivate' && !args.plan && state.active === true) {
        deps.log('Refusing to run: session is still active (active:true) — a live pipeline owns this state. Stop it first, or re-run with --plan to preview.');
        return { code: 1, transition: null };
    }
    if (exitReason !== RECOVERY_ENTRY_STATE && !args.plan && args.subcommand !== 'reactivate') {
        deps.log(`Refusing to run: session exit_reason is '${exitReason ?? '(none)'}', not '${RECOVERY_ENTRY_STATE}'. ` +
            `Re-run with --plan to preview the transition without writing.`);
        return { code: 1, transition: null };
    }
    return {
        sessionDir,
        statePath,
        workingDir: state.working_dir ?? cwd,
        startCommit: state.start_commit ?? null,
        exitReason,
    };
}
/**
 * The single decision site. Performs EXACTLY ONE transition (or none, for
 * `--plan` / refusal) and emits at most ONE recovery event.
 */
export function runRecover(args, cwd, deps = defaultDeps) {
    const gated = resolveAndGate(args, cwd, deps);
    if ('code' in gated)
        return gated;
    const { sessionDir, statePath, workingDir, startCommit, exitReason } = gated;
    const ticket = args.ticketArg ?? (args.subcommand === 'resume-from-todo' || args.subcommand === 'reattach-orphan' || args.subcommand === 'reactivate'
        ? selectLowestRunnableTodo(sessionDir, deps)
        : null);
    // --plan: describe the would-be transition, perform NO write.
    if (args.plan) {
        deps.log(planDescription(args.subcommand, ticket, exitReason));
        return { code: 0, transition: null };
    }
    // Execute EXACTLY ONE transition.
    let disposition;
    try {
        disposition = executeTransition(args.subcommand, { sessionDir, statePath, workingDir, startCommit, ticket }, deps);
    }
    catch (err) {
        deps.log(`Recovery transition failed: ${safeErrorMessage(err)}`);
        return { code: 1, transition: null };
    }
    const transition = { subcommand: args.subcommand, ticket, disposition };
    deps.emit(transition, sessionDir);
    deps.log(`Recovery transition complete: ${args.subcommand} -> ${disposition}${ticket ? ` (ticket ${ticket})` : ''}.`);
    return { code: 0, transition };
}
function planDescription(subcommand, ticket, exitReason) {
    const targetNote = exitReason === RECOVERY_ENTRY_STATE ? '' : ` [note: live exit_reason is '${exitReason ?? '(none)'}', would refuse without --plan]`;
    switch (subcommand) {
        case 'resume-from-todo':
            return `[plan] would re-queue lowest runnable Todo${ticket ? ` (${ticket})` : ' (none found)'} via ff-reattach, no write performed.${targetNote}`;
        case 'salvage':
            return `[plan] would salvageTicket(${ticket}) (commit+Done / archive+Todo / ff-reattach / no-op), no write performed.${targetNote}`;
        case 'reattach-orphan':
            return `[plan] would ff-reattach an orphaned commit${ticket ? ` for ${ticket}` : ''} via detectAndRecoverHeadRegression, no write performed.${targetNote}`;
        case 'reset-ticket':
            return `[plan] would archive the diff + reset ${ticket} to Todo, no write performed.${targetNote}`;
        case 'reactivate':
            return ticket
                ? `[plan] would un-terminalize the session: set {active:true, step:'research', exit_reason:null, current_ticket:${ticket}} (lowest runnable Todo), no write performed.${targetNote}`
                : `[plan] would REFUSE: no runnable Todo ticket remains (all-Done session), no write performed.${targetNote}`;
    }
}
function executeTransition(subcommand, ctx, deps) {
    const { sessionDir, statePath, workingDir, startCommit, ticket } = ctx;
    switch (subcommand) {
        case 'resume-from-todo': {
            if (!ticket)
                return 'no-runnable-todo';
            // Reuse the C5 ff-reattach primitive to reattach any orphaned commit first.
            const reattach = deps.reattach({
                ticketId: ticket,
                workingDir,
                startCommit: startCommit ?? '',
                completionCommitSha: null,
                sessionDir,
                statePath,
                iteration: 0,
                log: deps.log,
            });
            deps.setTicketTodo(ticket, sessionDir);
            deps.updateState(statePath, (s) => { s.current_ticket = null; s.exit_reason = null; });
            return `requeued (${reattach.action})`;
        }
        case 'salvage': {
            const outcome = deps.salvage({ sessionDir, workingDir, ticketId: ticket, startCommit, completionCommitSha: null });
            return outcome.disposition;
        }
        case 'reattach-orphan': {
            const reattach = deps.reattach({
                ticketId: ticket ?? '',
                workingDir,
                startCommit: startCommit ?? '',
                completionCommitSha: null,
                sessionDir,
                statePath,
                iteration: 0,
                log: deps.log,
            });
            return reattach.action;
        }
        case 'reset-ticket': {
            const outcome = resetTicketViaSalvage({ sessionDir, workingDir, ticketId: ticket }, deps);
            deps.updateState(statePath, (s) => { if (s.current_ticket === ticket)
                s.current_ticket = null; });
            return outcome.disposition;
        }
        case 'reactivate': {
            // Refuse on an all-Done session: no runnable Todo means nothing to un-terminalize for.
            if (!ticket)
                throw new RecoverArgError('reactivate refused: no runnable Todo ticket remains (all-Done session)');
            // Single sanctioned StateManager write: un-terminalize + point at the lowest runnable Todo.
            deps.updateState(statePath, (s) => {
                s.active = true;
                s.step = 'research';
                s.exit_reason = null;
                s.current_ticket = ticket;
            });
            return 'reactivated';
        }
    }
}
if (process.argv[1] && path.basename(process.argv[1]) === 'pickle-recover.js') {
    try {
        const parsed = parseArgs(process.argv.slice(2));
        const result = runRecover(parsed, process.cwd());
        process.exit(result.code);
    }
    catch (err) {
        if (err instanceof RecoverArgError) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`${msg}\n${USAGE}\n`);
            process.exit(64);
        }
        process.stderr.write(`pickle-recover failed: ${safeErrorMessage(err)}\n`);
        process.exit(1);
    }
}

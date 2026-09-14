// W3 / B-GROUND R0: the single ground-truth read every salvage / recovery seam
// shares. Replaces the parallel ad-hoc scanners with ONE reconciliation of
// tree-state + ticket-frontmatter truth. This module holds the only definition
// of reconcileTicketTruth in extension/src (AC-W3-RECONCILE: grep count == 1).
//
// Pure read, best-effort: every probe is try/catch'd to a conservative default
// so a non-repo / unreadable session yields a clean-tree truth rather than
// throwing under a salvage caller.
import { getHeadSha, isWorkingTreeDirty, listWorkingTreeDirtyPaths, } from '../services/git-utils.js';
import { collectTickets, getTicketStatus } from '../services/pickle-utils.js';
const defaultDeps = {
    headSha: (cwd) => {
        try {
            const sha = getHeadSha(cwd);
            return sha && sha.length > 0 ? sha : null;
        }
        catch {
            return null;
        }
    },
    dirtyPaths: (cwd) => {
        try {
            return listWorkingTreeDirtyPaths(cwd);
        }
        catch {
            return [];
        }
    },
    isDirty: (cwd) => {
        try {
            return isWorkingTreeDirty(cwd);
        }
        catch {
            return false;
        }
    },
    collectTickets: (sessionDir) => {
        try {
            return collectTickets(sessionDir);
        }
        catch {
            return [];
        }
    },
    ticketStatus: (sessionDir, ticketId) => {
        try {
            return getTicketStatus(sessionDir, ticketId);
        }
        catch {
            return null;
        }
    },
};
export function reconcileTicketTruth(input, deps = defaultDeps) {
    const { sessionDir, workingDir } = input;
    const dirtyPaths = deps.dirtyPaths(workingDir);
    const dirty = dirtyPaths.length > 0 || deps.isDirty(workingDir);
    const tickets = deps.collectTickets(sessionDir);
    const ticketStatuses = {};
    for (const t of tickets) {
        if (!t.id)
            continue;
        ticketStatuses[t.id] = deps.ticketStatus(sessionDir, t.id);
    }
    return {
        headSha: deps.headSha(workingDir),
        dirty,
        dirtyPaths,
        ticketStatuses,
        tickets,
    };
}

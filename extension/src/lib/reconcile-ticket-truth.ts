// W3 / B-GROUND R0: the single ground-truth read every salvage / recovery seam
// shares. Replaces the parallel ad-hoc scanners with ONE reconciliation of
// tree-state + ticket-frontmatter truth. This module holds the only definition
// of reconcileTicketTruth in extension/src (AC-W3-RECONCILE: grep count == 1).
//
// Pure read, best-effort: every probe is try/catch'd to a conservative default
// so a non-repo / unreadable session yields a clean-tree truth rather than
// throwing under a salvage caller.

import {
  getHeadSha,
  isWorkingTreeDirty,
  listWorkingTreeDirtyPaths,
} from '../services/git-utils.js';
import { collectTickets, getTicketStatus, type TicketInfo } from '../services/pickle-utils.js';

/** Ground-truth snapshot of a session: tree-state + ticket-frontmatter statuses. */
export interface TicketTruth {
  /** HEAD commit sha of `workingDir`, or null on a non-repo / git error. */
  headSha: string | null;
  /** True iff the working tree has uncommitted changes. */
  dirty: boolean;
  /** Uncommitted paths (working-tree relative); `[]` when clean / unreadable. */
  dirtyPaths: string[];
  /** Frontmatter status per ticket id (normalized only by the reader's own parse). */
  ticketStatuses: Record<string, string | null>;
  /** All tickets discovered under the session dir. */
  tickets: TicketInfo[];
}

/** Injectable probes — production wires git-utils + pickle-utils; tests inject fakes. */
export interface ReconcileTicketTruthDeps {
  headSha: (workingDir: string) => string | null;
  dirtyPaths: (workingDir: string) => string[];
  isDirty: (workingDir: string) => boolean;
  collectTickets: (sessionDir: string) => TicketInfo[];
  ticketStatus: (sessionDir: string, ticketId: string) => string | null;
}

export interface ReconcileTicketTruthInput {
  sessionDir: string;
  workingDir: string;
}

const defaultDeps: ReconcileTicketTruthDeps = {
  headSha: (cwd) => {
    try {
      const sha = getHeadSha(cwd);
      return sha && sha.length > 0 ? sha : null;
    } catch {
      return null;
    }
  },
  dirtyPaths: (cwd) => {
    try {
      return listWorkingTreeDirtyPaths(cwd);
    } catch {
      return [];
    }
  },
  isDirty: (cwd) => {
    try {
      return isWorkingTreeDirty(cwd);
    } catch {
      return false;
    }
  },
  collectTickets: (sessionDir) => {
    try {
      return collectTickets(sessionDir);
    } catch {
      return [];
    }
  },
  ticketStatus: (sessionDir, ticketId) => {
    try {
      return getTicketStatus(sessionDir, ticketId);
    } catch {
      return null;
    }
  },
};

export function reconcileTicketTruth(
  input: ReconcileTicketTruthInput,
  deps: ReconcileTicketTruthDeps = defaultDeps,
): TicketTruth {
  const { sessionDir, workingDir } = input;
  const dirtyPaths = deps.dirtyPaths(workingDir);
  const dirty = dirtyPaths.length > 0 || deps.isDirty(workingDir);
  const tickets = deps.collectTickets(sessionDir);
  const ticketStatuses: Record<string, string | null> = {};
  for (const t of tickets) {
    if (!t.id) continue;
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

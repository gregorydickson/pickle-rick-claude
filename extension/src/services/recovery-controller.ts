/**
 * R-ORSR-2 — RecoveryController: the spine of the B-ORSR recovery state machine.
 *
 * Replaces the "stalled iteration → terminal park" edge with an ordered strategy
 * ladder. On a stalled/failed iteration the runner runs the ladder and only emits
 * a terminal (`recovery_exhausted`, from R-ORSR-1) after the ladder is exhausted —
 * the babysitter's playbook, made native (PRD: B-ORSR, approach #1).
 *
 * The controller is dependency-injected: every side-effect (armed gate, commit,
 * remediator spawn, converged-plan execution, ledger append) is a callback. This
 * keeps the invariants testable with a scripted worker — the tests script the
 * evidence and adapter results without real subprocesses — and keeps the runtime
 * wiring (mux-runner.ts) the sole owner of the concrete adapters, including the
 * R-PEDC guard/clear Done-flip pair.
 */
import type { RecoveryAttempt } from '../types/index.js';

/** Ordered ladder rungs (PRD B-ORSR §Solution). */
export type RecoveryStrategy =
  | 'commit-and-continue'
  | 'fix-forward-trivial'
  | 'execute-converged-plan'
  | 'auto-split'
  | 'escalate';

/**
 * The ladder's verdict for the caller:
 * - `advanced`     — a rung recovered; the ticket was committed/flipped Done or its
 *                    converged plan executed. Caller continues the loop (no park).
 * - `fall_through` — genuine zero-output (`no_work_produced`); caller proceeds to the
 *                    EXISTING `oversized_no_progress` / terminal Failed-flip (auto-split
 *                    is down-scoped: no runtime decomposition — follow-up R-ONPD-FU).
 * - `exhausted`    — N distinct strategies were attempted and failed; caller emits the
 *                    honest terminal `recovery_exhausted` (NOT `closer_handoff_terminal`).
 */
export type RecoveryOutcome =
  | { kind: 'advanced'; strategy: RecoveryStrategy; sha?: string }
  | { kind: 'fall_through'; reason: string }
  | { kind: 'exhausted'; reason: string };

/** Evidence the runner already has on a stalled iteration (tree, plan, output). */
export interface RecoveryEvidence {
  /** Uncommitted changes exist in the working tree. */
  treeDirty: boolean;
  /** An approved plan + artifacts exist but no diff landed (R-ORSR-3 domain). */
  planConvergedUncommitted: boolean;
  /** Genuinely zero output at timeout (no tree delta, no plan). */
  noWorkProduced: boolean;
}

export interface RecoveryDeps {
  iteration: number;
  ticketId: string;
  /** Read the current recovery evidence (tree/plan/output). */
  assessEvidence: () => RecoveryEvidence;
  /**
   * Run the ARMED whole-repo gate. MUST ignore `flags.skip_quality_gates_reason`
   * and consume the real whole-repo result (R-ORSR-6) — never a skip-flagged green.
   */
  runArmedGate: () => { ok: boolean };
  /**
   * Commit the dirty tree and flip the ticket Done with an auto `completion_commit`,
   * routed through the R-PEDC guard/clear pair. Adapter owns atomicity: it must NOT
   * leave an orphaned half-commit on failure. Returns `{ok:false}` when blocked
   * (e.g. the R-WSRC config-protection hook refused the commit).
   */
  commitAndFlipDone: () => { ok: boolean; sha?: string };
  /** Spawn the existing gate remediator once. Returns true when it exited ok. */
  spawnRemediator: () => boolean;
  /** R-ORSR-3 seam: execute the converged plan as atomic per-finding commits. */
  executeConvergedPlan?: () => { ok: boolean };
  /** Append one entry to `state.recovery_attempts[]`. */
  appendAttempt: (attempt: RecoveryAttempt) => void;
  log: (msg: string) => void;
  /** fix-forward-trivial bound (M). Default 1. */
  maxRemediatorSpawns?: number;
}

/** Append one `RecoveryAttempt` to the ledger. Best-effort — never blocks recovery. */
type RecordAttemptFn = (strategy: RecoveryStrategy, outcome: 'success' | 'failed', reason: string) => void;

/**
 * Rung 1 — commit-and-continue: the ARMED gate is consulted directly (skip-flag-blind
 * by construction). Returns `advanced` on a committed Done flip, or `null` to fall
 * through to fix-forward-trivial (gate red, commit blocked, or adapter threw).
 */
function attemptCommitAndContinue(deps: RecoveryDeps, record: RecordAttemptFn): RecoveryOutcome | null {
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
  } catch (err) {
    record('commit-and-continue', 'failed', `commit-and-continue threw: ${errText(err)}`);
  }
  return null;
}

/**
 * Rung 2 — fix-forward-trivial: spawn the remediator once (bounded by `maxSpawns`),
 * re-gate, retry the commit. Returns `advanced` on success or `null` to fall through.
 * INV-FIX-FORWARD-BOUND: at most one remediator spawn per call; `maxSpawns < 1` disables it.
 */
function attemptFixForwardTrivial(deps: RecoveryDeps, record: RecordAttemptFn, maxSpawns: number): RecoveryOutcome | null {
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
    } else {
      record('fix-forward-trivial', 'failed', `remediator ${remediated ? 're-gate still red' : 'failed'} for ${deps.ticketId}`);
    }
  } catch (err) {
    record('fix-forward-trivial', 'failed', `fix-forward-trivial threw: ${errText(err)}`);
  }
  return null;
}

/**
 * Rung 3 — execute-converged-plan (R-ORSR-3 seam): approved plan + artifacts, no diff.
 * Returns `advanced` when the injected executor succeeds, else `null`. Until R-ORSR-3
 * (e8f46d84) wires the executor, records the attempt and falls down the ladder.
 */
function attemptExecuteConvergedPlan(deps: RecoveryDeps, record: RecordAttemptFn): RecoveryOutcome | null {
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
  } catch (err) {
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
export function runRecoveryLadder(deps: RecoveryDeps): RecoveryOutcome {
  const maxSpawns = Number.isInteger(deps.maxRemediatorSpawns) && (deps.maxRemediatorSpawns as number) >= 0
    ? (deps.maxRemediatorSpawns as number)
    : 1;

  const record: RecordAttemptFn = (strategy, outcome, reason) => {
    try {
      deps.appendAttempt({ strategy, outcome, reason, iteration: deps.iteration });
    } catch { /* ledger append is best-effort — never block recovery on a state write */ }
  };

  let evidence: RecoveryEvidence;
  try {
    evidence = deps.assessEvidence();
  } catch (err) {
    record('escalate', 'failed', `evidence assessment threw: ${errText(err)}`);
    return { kind: 'exhausted', reason: 'evidence_unreadable' };
  }

  if (evidence.treeDirty) {
    const committed = attemptCommitAndContinue(deps, record);
    if (committed) return committed;
    const fixedForward = attemptFixForwardTrivial(deps, record, maxSpawns);
    if (fixedForward) return fixedForward;
  }

  if (evidence.planConvergedUncommitted) {
    const planned = attemptExecuteConvergedPlan(deps, record);
    if (planned) return planned;
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
export function isConvergedPlanEligible(inputs: { planArtifactExists: boolean; planReviewApproved: boolean }): boolean {
  return inputs.planArtifactExists && inputs.planReviewApproved;
}

/** A single executable plan phase parsed from an approved plan's `## Phase N` block. */
export interface PlanPhase {
  /** 1-based phase number from the `## Phase N` header. */
  index: number;
  /** Phase title (text after the `—`/`-` separator), or '' when absent. */
  title: string;
  /** First backticked command on the `**Verify:**` line, or null when none parses. */
  verify: string | null;
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
export function parsePlanPhases(planMarkdown: string): PlanPhase[] {
  const phases: PlanPhase[] = [];
  for (const block of planMarkdown.split(PLAN_PHASE_SPLIT_RE)) {
    const header = block.match(PLAN_PHASE_HEADER_RE);
    if (!header) continue;
    const verify = block.match(PLAN_PHASE_VERIFY_RE);
    phases.push({
      index: Number(header[1]),
      title: (header[2] ?? '').trim(),
      verify: verify ? verify[1].trim() : null,
    });
  }
  return phases;
}

/** Outcome of `executePhaseLoop`: how many phases committed and the index that broke (if any). */
export interface ExecutePhaseLoopResult {
  ok: boolean;
  committed: number;
  failedIndex: number | null;
}

/**
 * DI seam for the clean-tree implement pass (AC-GA-REC-1). The adapter receives the
 * RAW plan_*.md path (never the parsed PlanPhase[], which is verify-only and carries
 * nothing implementable) and returns whether an implement pass produced a diff.
 * B-WSPU WS-1: all tiers spawn an implement pass synchronously. Timeout is
 * surfaced as `{ ok: false, timedOut: true }` so the ladder escalates to recovery_exhausted.
 */
export interface ReExecutionSeam {
  /** Spawn an implement pass against the raw plan markdown. */
  spawnImplementPass: (opts: {
    planPath: string;
    ticketId: string;
    complexityTier: string;
    sessionDir: string;
    workingDir: string;
    statePath: string;
  }) => { ok: boolean; timedOut?: boolean };
}

/** Adapters for `executePhaseLoop` — every side-effect is injected (DI), like RecoveryDeps. */
export interface ExecutePhaseLoopDeps {
  phases: PlanPhase[];
  /** Run phase k's verify. ok=false stops the loop at k (k is NOT committed). */
  executePhase: (phase: PlanPhase, index: number) => { ok: boolean };
  /** Commit phase k's work as one atomic commit. ok=false stops the loop at k. */
  commitPhase: (phase: PlanPhase, index: number) => { ok: boolean };
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
export function executePhaseLoop(deps: ExecutePhaseLoopDeps): ExecutePhaseLoopResult {
  if (deps.phases.length === 0) return { ok: false, committed: 0, failedIndex: null };
  let committed = 0;
  for (let i = 0; i < deps.phases.length; i++) {
    const phase = deps.phases[i];
    if (!safeStep(() => deps.executePhase(phase, i))) return { ok: false, committed, failedIndex: i };
    if (!safeStep(() => deps.commitPhase(phase, i))) return { ok: false, committed, failedIndex: i };
    committed += 1;
  }
  return { ok: true, committed, failedIndex: null };
}

/** Run one DI step, treating a throw as a not-ok result (INV-RUNG-ERROR-CONTAINED parity). */
function safeStep(fn: () => { ok: boolean }): boolean {
  try { return fn().ok; } catch { return false; }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

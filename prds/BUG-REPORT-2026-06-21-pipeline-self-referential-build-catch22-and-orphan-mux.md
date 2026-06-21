# BUG REPORT — Pipeline self-referential build catch-22 + orphan-mux teardown + worker silent-death observability gap

**Date:** 2026-06-21
**Finding codes:** R-PSRB (self-referential build catch-22), R-OMTD (orphan-mux teardown), R-WSDO (worker silent-death observability), R-SLEAK (session/process leak)
**Priority:** P2 (R-PSRB blocks autonomous build of recovery-path bundles; R-OMTD/R-WSDO/R-SLEAK are P3 hygiene/observability)
**Status:** OPEN — filed while babysitting the B-PCOMP build (session `2026-06-20-24252a03`)
**Family:** recovery/salvage machinery + process-lifecycle. Cross-refs: [[B-PCOMP]] (the bundle this blocked), the catch-22 class in `project_b_orsr_recovery_state_machine_ship`, the salvage-discard class [[R-WCUC]]/[[B-GNXR]], the silent-death class [[R-WPEX]].

## Context
Building **B-PCOMP** (beta 2.0 pipeline completion) via `/pickle-pipeline`. 3/11 tickets completed cleanly
hands-off and committed (`26125e91`, `e9e55fc8`, `c08bb0d3`, `8b4f75c6` — both WS-D1 start-gate fixes +
WS-D2-1 branch attribution). Ticket 4 (`0a1ce691` — WS-D2-2: salvage reconciles-before-archiving) then
**failed deterministically across 3 attempts** (original run + 2 relaunches, incl. one with **zero
competing `claude -p` workers** after the operator's concurrent builds finished overnight). Each attempt:
worker produced **no source implementation and no lifecycle artifacts** (only out-of-scope PRD churn), the
no-progress detector flagged `worker_artifact_progress_zero`, the salvage path reset the ticket, and the
recovery ladder exhausted (`recovery_exhausted: ladder exhausted for 0a1ce691 ... 12 iterations, 69m`).

## Finding 1 — R-PSRB: self-referential build catch-22 (DESIGN FLAW, the load-bearing finding)
**A bundle that modifies the pipeline's own recovery / salvage / completion machinery cannot be built
autonomously by that same pipeline**, because the **deployed (pre-fix) runtime** exercises the buggy
machinery *on the very ticket building the fix.* `0a1ce691` builds the salvage-reconcile fix (D2-2), but
the deployed beta.21 salvage/no-progress machinery is what resets `0a1ce691` mid-build → the fix can never
land through the autonomous loop. This is the same class as `project_b_orsr_recovery_state_machine_ship`
("mux-runner.ts control-flow edits are inert until recompiled — the running runner uses OLD compiled code,
so a fix can't self-activate mid-build"), generalized: **not just inert, actively self-defeating** when the
edited machinery is the recovery/salvage path.
- **Confidence: HIGH** that the salvage-loop reset `0a1ce691` repeatedly (observed in `mux-runner.log` +
  `pre_reset_diff_*.patch` + `worker_artifact_progress` ledger). **MEDIUM** that a clean (fixed) runtime
  would let the worker succeed — the worker also produced no real source, which the 0-byte logs can't
  explain (see Finding 3).
- **Remediation (build protocol, not a runtime change):** when a bundle's scope includes the
  recovery/salvage/completion machinery (`mux-runner.ts` salvage path, `salvage-ticket.ts`,
  `reconcile-ticket-truth.ts`, `ticket-completion-evidence.ts`), the load-bearing tickets MUST be
  **hand-built (in-process) or built then `install.sh`-deployed incrementally** so the rest of the bundle
  runs on the fixed runtime. Document this in the PRD authoring guide (`prds/CLAUDE.md`) as a
  "self-modifying-recovery bundle" caveat. B-PCOMP's own thesis (the pipeline can't complete a pipeline) is
  *validated* by this — it is the strongest evidence for the bundle.

## Finding 2 — R-OMTD: orphaned mux on parent-runner death (BUG)
Killing `pipeline-runner.js` (SIGTERM) does **not** reap its `mux-runner.js` child — the mux re-parents to
PID 1 and keeps looping the session (observed: pid 15714, PPID 1, still iterating after its
pipeline-runner parent was killed). Incomplete process-group teardown; a stray mux keeps mutating session
state after the parent is gone, and a naive operator freeze (kill pipeline-runner) leaves the session live.
- **Confidence: HIGH** (directly observed).
- **Remediation:** `pipeline-runner` should spawn `mux-runner` in its own process group and reap the child
  subtree on its own SIGTERM/exit (mirror the `auto-resume.sh` R-CNAR-2 foreground-only trap, and the
  `PICKLE_LARGE_TIER_DETACHED_WORKER` single `process.kill(-pgid)` reap). Related to R-CSI (session-scoped
  kills) — same root: process reaping isn't subtree-scoped.

## Finding 3 — R-WSDO: worker silent-death has zero forensic signal (OBSERVABILITY GAP)
Every failed `0a1ce691` worker left a **0-byte `worker_session_<pid>.log`** and **no `manager_spawn.log`**,
making it impossible to distinguish (a) silent death under contention, (b) spawn failure, (c) a worker that
ran but produced nothing. Babysitting is blind exactly when it matters. The existing
`worker_partial_lifecycle_exit` (R-WSE-2) covers the "research APPROVED but later artifacts missing" case;
it does NOT cover "worker spawned and produced nothing at all."
- **Confidence: HIGH** (directly observed — 3× 0-byte logs).
- **Remediation:** emit a `worker_produced_nothing` breadcrumb (with spawn pid, exit code if reapable, and
  whether the worker process was ever observed alive) when a spawn yields a 0-byte session log AND zero
  artifact delta. Capture the worker's exit code/signal at the spawn-morty boundary.

## Finding 4 — R-SLEAK: session/process leak + misleading contention gauge (HYGIENE)
13 `tmux` `pipeline-*` sessions and many orphan `node` runners persist for **days** across completed/
inactive sessions (e.g. `47c56b0e` Jun 14, `7734eb2b` Jun 14) — nothing reaps them; several ignore SIGTERM.
Separately, `pgrep -f claude` **over-counts** (it matches every `node` process under `~/.claude/pickle-rick/`
plus the operator's own shell command), so "82 claude procs" read as contention was mostly idle runners —
the real `claude -p` worker count was near zero. This misdiagnosis cost an overnight pause.
- **Confidence: HIGH** (directly observed).
- **Remediation:** (a) a session-GC that reaps `tmux` sessions + runner processes for sessions whose
  `state.json` is `active:false` and stale > N hours; (b) a reliable contention gauge that counts only
  actual `claude -p` worker processes (match `bin/claude .* -p`, exclude node runners), surfaced in
  `/pickle-status` or a babysitter helper.

## Recovery used this session (sanctioned)
Froze the session (scoped kill of its pipeline-runner + orphan mux by explicit pid), discarded the
out-of-scope PRD churn (`git restore`), preserved the 3 committed tickets. Next: hand-build the
recovery-path tickets (`0a1ce691`, `b736337f`, `3f6800f3`) in-process, `install.sh`-deploy to clear the
R-PSRB catch-22, then resume autonomous for the e2e + hardening tickets on the fixed runtime.

## Why this belongs in the plans
Per the standing "log the loop failure as a bug PRD + MASTER_PLAN row" discipline: these are recoveries
that should become drainable work, not silent firefighting. R-PSRB in particular is a **design-level**
constraint on how recovery-machinery bundles must be built — it will recur on every future bundle that
touches the salvage/completion path until the build protocol is documented (and ideally until B-PCOMP ships
and the salvage-discard root cause is gone).

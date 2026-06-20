---
title: "R-PPXR — pickle phase exits incomplete without relaunching the manager; bundle needs a babysitter relaunch per cycle (non-autonomous)"
priority: P1
finding: PPXR
status: open
type: bug-bundle
schema_neutral: true
source_assessment: "2026-06-16 live B-GA build (session 2026-06-16-3c1831d7) — 3 pickle-phase invocations each exited pipeline_phase_incomplete after ~33-38min needing a babysitter relaunch. PRD re-baselined 2026-06-16 by a 3-cycle refinement team against HEAD; analyst findings folded (the original ACs were flawed — see § Refinement corrections)."
---

# R-PPXR — Pickle phase prematurely exits incomplete, mux-runner does not relaunch the manager

## Symptom (reproducing, live)

During the B-GA build (session `2026-06-16-3c1831d7`, 12 tickets, several `large` tier), the pickle
phase exited code 0 with tickets still pending after ~33–38 min, **three times**, each needing a
babysitter relaunch. Net: Run 1 → 0/12, Run 2 → 1/12 (`de345802` Done `ada1f5c0`, `28d95d77`
implemented-uncommitted), Run 3 → resumed. On a 12-ticket bundle this is ~10 relaunches = **not
autonomous**. (B-GA ultimately shipped v2.0.0-beta.7 via those manual recoveries.)

## What is NOT broken (do not touch)

- The **incomplete-guard is correct** (B-DSAN2 WS-A / R-PPA-1): pickle exiting with pending tickets does
  NOT falsely advance to citadel. No false ship. Keep it.
- `detectManagerMaxTurnsExit` (`mux-runner.ts:2761`) is **R-ICDM-1-protected** (`src/bin/CLAUDE.md:22`:
  MUST return `false` on null `num_turns`). **Do NOT edit it** — widening it re-opens the
  2026-05-13-e58dcc1d teardown incident (enforced by `mux-runner-claude-iteration-classifier.test.js`).
  The original AC-PPXR-2 prose named this function; that was wrong (see § Refinement corrections).

## Root cause (pinpointed at HEAD by the refinement team)

The bug is a **two-layer** exit, and the PRD originally conflated them:

- **Layer A (the actual suppressor) — `isGenuineCrashOrSpawnFailure`.** Predicate is
  **duplicated character-for-character at TWO sites**: `mux-runner.ts:6370` (in the `LoopAction`
  iteration-outcome helper) and `mux-runner.ts:10052` (inline in `main()`'s `result==='error'` branch):
  `decision.exitKind === 'other_error' && outcome !== undefined && outcome.timedOut !== true &&
  ((typeof outcome.exitCode === 'number' && outcome.exitCode !== 0) || outcome.exitCode === null)`.
  The guard's own comment (`:6364-6369`) states the design: relaunch on a recognized recoverable signal
  OR when `outcome === undefined`; suppress otherwise. A manager `claude -p` **cut off mid-tool-result**
  (signal kill → `outcome` defined, `exitCode === null`, `timedOut !== true`) trips the suppressor →
  "Subprocess error. Exiting loop." → **mux-runner exits code 0** with tickets pending.
  `state.manager_relaunch_count` is `undefined` because `recordManagerRelaunch` only fires on the
  never-taken relaunch branch — a **symptom**, not an independent bug. `evaluateManagerRelaunch`
  (`services/manager-relaunch.ts:96`, NOT `src/lib/`) already returns `shouldRelaunch:true` for a
  pending-ticket `other_error` under `CLAUDE_MANAGER_RELAUNCH_CAP=20`; the cap is NOT the limiter — the
  suppressor is.
- **Layer B — pipeline-runner re-entry.** After mux exits code 0 with pending tickets,
  `reportPhaseIncomplete` (`pipeline-runner.ts`) stamps `pipeline_phase_incomplete` and the pipeline
  terminates. There is no per-phase retry.

**Causal chain + dependency:** Layer A fires first. **If Layer A is fixed, mux never exits with pending
tickets, Layer B is never reached, and a Layer-B re-entry fix would be dead code for the cut-off case.**
Therefore: **diagnose + fix Layer A FIRST; Layer B work is conditional on Layer A's diagnosis proving
the cause is genuinely non-relaunchable-in-iteration** (e.g. OOM / external SIGTERM / deterministic
crash), in which case re-entry is the only safety net.

## Acceptance Criteria (re-baselined; drain in order)

- [ ] **AC-PPXR-2 — diagnose the cut-off, then relax the suppressor for the retryable signature ONLY
  (Layer A; PRIMARY, build FIRST).** Diagnosis deliverable: `refinement/ppxr-rootcause.md`
  (forward-created) recording, for each of the 3 cut-off runs, the three fields that select the fix —
  `outcome.exitCode`, `outcome.timedOut`, the resolved loop `result` — and explicitly confirming/
  refuting (i) `signal_received` / `exit_reason=signal:*`, (ii) idle-stall watchdog (`executeTimeoutHalt`),
  (iii) max-turns-without-`result`. Fix: relax `isGenuineCrashOrSpawnFailure` so a **diagnosed retryable
  signal-kill-with-pending-tickets** signature returns `false` (→ relaunch). The change MUST land at
  BOTH `:6370` and `:10052` identically, OR (preferred, subtract-before-add) be **extracted into one
  exported predicate** imported by both sites — killing the duplication that created this hazard. MUST
  NOT touch `detectManagerMaxTurnsExit` (R-ICDM-1). A **fatal** signature (OOM / external SIGTERM /
  deterministic crash) MUST stay terminal (suppressor keeps tearing down). — Type: test + root-cause
  (extend `mux-runner-claude-max-turns-relaunch.test.js`, `manager-relaunch.test.js`; do NOT regress
  `mux-runner-claude-iteration-classifier.test.js`)
- [ ] **AC-PPXR-5 — autonomy success metric (the only AC that encodes the goal).** A replay/integration
  test drives a ≥10-ticket large-tier-dominated bundle through ≥3 would-be cut-offs to all-tickets-
  terminal with **0 manual relaunches** and relaunch count ≤ cap. — Type: test (integration)
- [ ] **AC-PPXR-1 — pipeline-runner per-phase re-entry (Layer B; CONDITIONAL on AC-PPXR-2 diagnosis).**
  Build ONLY if AC-PPXR-2 proves the cause is non-relaunchable-in-iteration. If built: when pickle exits
  `pipeline_phase_incomplete` AND per-invocation progress was made, `pipeline-runner` re-enters the
  pickle phase, bounded by a cap, emitting a DISTINCT new `exit_reason` (`phase_reentry_exhausted` —
  NOT the already-used `phase_no_progress`). Requires a NEW persisted per-invocation baseline (none
  exists at HEAD — `git grep` for `pickle_phase_prev_done` etc. is empty; the runner's existing deltas
  are since-`start_commit`, not per-invocation): define the state field + write site (pre-relaunch) +
  read site (re-entry predicate). The progress predicate MUST credit (Done↑ OR commit↑ OR
  `current_ticket` lifecycle-phase advanced OR a `manager_turn_progress` event fired since the prior
  invocation) — a Done/commit-only signal false-halts a `large` ticket spanning >1 re-entry. — Type:
  test (conditional)
- [ ] **AC-PPXR-6 — any automated WIP-preservation commit MUST be oracle-safe (negative AC).** If
  AC-PPXR-1/3 adds an automated pre-relaunch commit of uncommitted WIP, that commit MUST use the
  babysitter's **non-attributing** convention (no ticket-id / r_code in the message) so the
  completion-evidence oracle does NOT false-flip the in-progress ticket Done. — Type: test
- [ ] **AC-PPXR-3 — mux-only-launch fallback via `auto-resume.sh` (FALLBACK, not the whole fix).**
  `auto-resume.sh` wraps `mux-runner.js` ONLY (`:51`), so it CANNOT drive a `/pickle-pipeline` run past
  the pickle phase (citadel/anatomy/szechuan never re-enter). It is a complete mitigation ONLY for a
  single-phase `/pickle-tmux` (mux-only) launch. Even there it is NOT zero-config: it requires
  `PICKLE_AUTO_RESUME_ON_CAP_HIT=1` (`:59`, else single passthrough), its no-progress halt
  (`:174/:183`, `PROGRESS_THRESHOLD=3`) false-stops a `large` ticket spanning >3 relaunches, its
  `MAX_WALL_SECONDS=7200` (`:8`) < B-GA's ~2h/ticket, and `salvageTicket` archives-then-resets-Todo on
  gate-FAILING WIP (`salvage-ticket.ts:11,150-151`) so a mid-implement cut-off is **re-done from
  scratch** each cycle unless a pre-relaunch commit (AC-PPXR-6) preserves it. Scope AC-PPXR-3 to: doc
  the mux-only-launch wrapper usage + the flag + the wall/threshold tuning, and add the pre-relaunch
  commit so it converges. — Type: test + docs
- [ ] **AC-PPXR-4 — typecheck + lint + compiled-mirror parity.** Any `isGenuineCrashOrSpawnFailure` edit
  is in `mux-runner.ts` → the compiled-mirror catch-22 applies (running runner uses OLD `.js`; recompile
  + commit before expecting effect). Re-verify `install.sh` MD5 parity AFTER recompile. — Type: typecheck

## Simplification Review (subtract-before-add)

1. **Necessary?** The core (AC-PPXR-2) is a ~5-line predicate relaxation — minimal. AC-PPXR-1 and
   AC-PPXR-3 are likely **MOOT** once Layer A is fixed (mux relaunches → never exits incomplete → Layer
   B never reached, wrapper never needed). Build AC-PPXR-2 first; only build AC-PPXR-1/3 if the
   diagnosis proves the cause is non-relaunchable-in-iteration.
2. **Reuse not add?** AC-PPXR-2 reuses the existing `evaluateManagerRelaunch` chain (already returns
   relaunch=true for pending `other_error`) — the fix only stops the suppressor from vetoing it. No new
   relaunch machinery.
3. **Subtract the brittle thing?** YES — the duplicated `isGenuineCrashOrSpawnFailure` at two sites is
   the brittleness (a one-site fix silently half-works). DRY it into one exported predicate: the fix
   AND a subtraction in one move.
4. **What this subtracts:** one copy of a duplicated guard; and (if AC-PPXR-1/3 prove moot) it
   *avoids adding* a pipeline-runner re-entry state-field + an auto-resume wrapper path — net-zero new
   machinery for the common case.

## Diagnosis seed (babysitter forensics 2026-06-16, B-GA session 3c1831d7)

Pre-work for AC-PPXR-2's `ppxr-rootcause.md` — confirmed against the live B-GA logs:

- **"Phase pickle hit iteration cap" is a MISLEADING label, NOT a real cap hit.** It is printed
  unconditionally by `reportPhaseIncomplete` (`pipeline-runner.ts:2968`) on every incomplete exit
  (its own comment: "alongside any per-phase `iteration_cap_exhausted` already recorded by
  mux-runner"). `max_iterations=500` was never approached (iters reached 3/8/16). The real exit reason
  is whatever mux-runner stamped — i.e. the Layer-A suppressor. **Side-fix candidate:** make this log
  reflect the actual `state.exit_reason` instead of the hardcoded "hit iteration cap" string (it sent
  the original triage down a false path).
- **The cut-off signature is confirmed by the iteration logs.** Within a run, most manager turns end
  CLEANLY (`tmux_iteration_{4,15,16}.log` carry a `result` event, `num_turns` 14/17/87) and the loop
  continues; the run dies on a turn that is **cut off** — `tmux_iteration_{1,2}.log` have **0 `result`
  events**, last event `system/task_started` / `user` (mid-tool-result). This matches Layer A: a
  cut-off manager turn → `outcome` defined, no clean result → `isGenuineCrashOrSpawnFailure` suppresses
  the relaunch → mux exits 0 with pending tickets. AC-PPXR-2 must still extract `outcome.exitCode` /
  `outcome.timedOut` / resolved `result` per cut-off run (the three-field branch selector), but the
  qualitative pattern (clean turns interleaved with suppressed cut-offs) is established.
- No `activity-*.jsonl` and no `signal_received` / `exit_reason=signal:*` were present in the session —
  so the cut-off is NOT a recorded external SIGTERM; it is an in-iteration manager-turn termination
  with no `result` event. AC-PPXR-2's diagnosis should confirm whether it is max-turns-without-result
  vs an idle-stall watchdog (`executeTimeoutHalt`) firing.

## Refinement corrections (what the 3-cycle team found vs the original PRD)

- Original AC-PPXR-2 said edit `detectManagerMaxTurnsExit` — **forbidden** (R-ICDM-1). Real locus:
  `isGenuineCrashOrSpawnFailure` (`:6370`+`:10052`, duplicated).
- Original AC-PPXR-1 was unbuildable (referenced a per-invocation baseline that doesn't exist) and had
  no working halt — now gated CONDITIONAL + given a concrete state-field/exit_reason spec.
- Original AC-PPXR-3 claimed "the whole fix" — **wrong**: auto-resume wraps mux-runner not
  pipeline-runner, needs a flag, false-halts large tickets, and re-does WIP via salvage. Demoted to a
  scoped mux-only fallback.
- Added AC-PPXR-5 (autonomy metric — the only AC encoding the goal) and AC-PPXR-6 (oracle-safe
  auto-commit — load-bearing detail from the babysitter's own recovery convention).
- Path fix: `manager-relaunch.ts` is under `extension/src/services/`, NOT `src/lib/`. The R-MMTR-3
  trap-door line range (`src/bin/CLAUDE.md:23` → `mux-runner.ts:3696-3730`) is **stale doc-drift**
  (3696 is now inside `CpuLivenessWatchdogInput`); navigate by SYMBOL (`isGenuineCrashOrSpawnFailure`),
  not line number — and fix that trap-door line range as a docs side-task.

## Notes

Filed 2026-06-16 after B-GA needed 3 babysitter relaunches. Recovery pattern (now spec'd as AC-PPXR-6):
reset-proof non-attributing commit of uncommitted WIP → clear dirty-tree → relaunch (commits
`8e9987c2`, `02df7531`). Per `feedback_loop_failure_log_bug_prd_and_master_plan`: drainable work, not
silent firefighting. **Drain order: AC-PPXR-2 (+ its diagnosis) FIRST, then AC-PPXR-5; AC-PPXR-1/3/6
only if the diagnosis proves them necessary.**

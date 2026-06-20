---
title: BUG REPORT — 2026-05-27 — codex manager exits pickle phase at a fixed ~60-min wall; pipeline-runner treats incomplete-but-progressing pickle as fatal, stranding the bundle
status: Draft
filed: 2026-05-27
priority: P1
type: bug-incident
r_code: R-CMWL
bundle: B-PIPE-BABYSIT-HARDEN
related:
  - prds/MASTER_PLAN.md                                                          # finding #86 (this report)
  - prds/MASTER_PLAN.md                                                          # finding #80 R-OMS, #81 R-AISLOW, #82 R-SJLAG — same B-PIPE-BABYSIT-HARDEN class
  - extension/src/bin/CLAUDE.md                                                  # R-MMTR-3 claude-side max-turns relaunch invariant (the analogue that already works)
incident_sessions:
  - /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-27-591247f9  # attractor v11 fork build (40-ticket codex pickle phase)
---

# R-CMWL — codex manager fixed ~60-min wall strands long pickle phases

## Status

**Open.** This report does NOT pre-commit to a fix. It records the observed behavior with log evidence, enumerates competing root-cause hypotheses, and states the desired behavior. The fixer should confirm which hypothesis holds before changing code.

## TL;DR

On the `codex` backend, every pickle-phase invocation runs for **almost exactly 60 minutes**, completes ~3 tickets, then the manager exits and mux-runner logs `Session inactive. Exiting.` `pipeline-runner` then classifies "pickle exited clean but N/40 tickets remain" as `phase_incomplete_tickets` and **stops the entire pipeline** (`Pipeline finished: 0/4 phases`) instead of re-spawning the manager to continue. A 40-ticket bundle therefore needs an operator (or an external wrapper) to relaunch the pipeline ~once per hour. The `claude` backend already has the analogous relaunch path (R-MMTR-3 / `CLAUDE_MANAGER_RELAUNCH_CAP=20` at the 400-turn boundary); the codex path either doesn't relaunch, relaunches too few times, or is overridden by pipeline-runner's incomplete-is-fatal verdict.

The fix should make continuation **turn/progress-based, not a fixed 60-minute cutoff** — the manager should be relaunched (or the pickle phase re-spawned) as long as tickets remain AND progress is being made, bounded by a no-progress guard rather than a wall clock.

## Incident — attractor v11 fork build (session `2026-05-27-591247f9`)

A 40-ticket greenfield bundle (`--backend codex`, `--max-time 0` i.e. unbounded) run via `/pickle-pipeline`. The pickle phase repeatedly stopped at the 60-minute mark with tickets remaining:

| Pickle invocation | Wall time | Iterations | Tickets completed in pass | Exit |
|---|---|---|---|---|
| 1 (15:21–16:11Z) | ~51 min* | 2→14 | 2 (70a4b06f, cb5383b6) | Session inactive (overlapped by a double-launch) |
| 2 (16:51–17:51Z) | **60m 16s** | 17→32 (31 iters) | 3 (0795cefe, 3f5a9b85, 29ae6378) | `Session inactive. Exiting.` → `phase_incomplete_tickets` |
| 3 (18:22Z–) | (capped at ~60m) | 33→… | ~3 (1c2de406, …) | same pattern |

\*Pass 1 was confounded by a separate double-launch; passes 2+ show the clean ~60-min signature.

### Verbatim log evidence (pass 2)

```
mux-runner.log:
  [2026-05-27T16:51:08] --- Iteration 17 ---
  ... (31 iterations) ...
  [2026-05-27T17:51:25] Session inactive. Exiting.
  [2026-05-27T17:51:25] mux-runner finished. 31 iterations, 60m 15s

pipeline-runner.log:
  [2026-05-27T16:51:08] PHASE 1/4: PICKLE (backend=codex)
  [2026-05-27T17:51:25] Phase pickle exited with code 0
  [2026-05-27T17:51:25] Phase pickle exited clean but 36/40 tickets remain unresolved (4 Done) — incomplete bundle
  [2026-05-27T17:51:25] Pipeline finished: 0/4 phases, 60m 16s

state.json:
  { "step": "completed", "active": false, "exit_reason": "phase_incomplete_tickets", "iteration": 32 }
```

### Symptom catalog

1. **Fixed ~60-min wall regardless of `--max-time 0`.** The session was configured unbounded (`Max Time: ∞`), yet the pickle phase still exited at 60m 15s / 60m 16s. The 60-minute boundary is enforced somewhere below the session-level max-time setting.
2. **The exit is clean, not an error.** `Phase pickle exited with code 0`, `mux-runner finished` — no crash, no FATAL. The manager simply stops being active.
3. **`phase_incomplete_tickets` is treated as a hard pipeline stop.** pipeline-runner reports `0/4 phases` and writes `pipeline-status.json: failed`, even though 4 tickets were genuinely completed and committed this run. The remaining 36 tickets are stranded until an operator relaunches.
4. **Per-pass progress is real and committed.** Each 60-min pass completes ~3 tickets with atomic commits — the work is sound; only the continuation is broken.
5. **A clean relaunch resumes correctly** (resumes at the next Todo ticket, skips Done tickets via the phantom-Done watcher), so the bundle DOES converge — it just needs N≈13 manual relaunches for 40 tickets.
6. **The 60-min cutoff leaves the interrupted ticket's partial work uncommitted**, which then trips `assertCleanWorkingTree` in `pipeline-runner` on the next relaunch unless the operator stashes/commits first — a second-order friction that turns a simple relaunch into stash-then-relaunch.

## Competing root-cause hypotheses (fixer to confirm)

- **H1 — codex manager exhausts `MANAGER_MAX_TURNS` (50) at ~60 min, but the codex relaunch path doesn't fire.** The claude backend handles the analogous 400-turn boundary via R-MMTR-3 (`evaluateManagerRelaunch` → respawn up to `CLAUDE_MANAGER_RELAUNCH_CAP=20`). A `CODEX_MANAGER_RELAUNCH_CAP=10` constant exists in `extension/src/types/index.ts`, suggesting the relaunch path is *intended* for codex too — but the observed "Session inactive. Exiting." (no relaunch) implies the codex exit is **not being classified as a relaunchable max-turns exit**, so it falls through to deactivation. (Compare R-ICDM #28: claude iteration-classifier misuse — the codex classifier may have the mirror gap.)
- **H2 — codex CLI imposes its own ~60-min `exec`/session wall.** If the codex runtime ends long-lived `codex exec` sessions at a fixed wall independent of turn count, the manager process dies and mux-runner sees the session inactive. In that case the relaunch logic, not a turn-cap change, is the lever.
- **H3 — pipeline-runner's incomplete-is-fatal verdict overrides any mux-runner relaunch.** Even if mux-runner would relaunch the manager, `pipeline-runner`'s post-phase check (`Phase pickle exited clean but N/40 tickets remain → phase_incomplete_tickets → stop`) may pre-empt continuation. If so, the fix belongs in pipeline-runner: re-spawn the pickle phase when it exits clean-but-incomplete-and-progressing, with a no-progress guard.

The three are not mutually exclusive; the real fix likely pairs "classify the codex manager exit as relaunchable" (H1/H2) with "don't treat progressing-but-incomplete pickle as fatal" (H3).

## Desired behavior

1. **Continuation is turn/progress-based, not a fixed wall.** A long pickle phase on codex must continue across the manager's natural session/turn boundary as long as (a) Todo tickets remain AND (b) the previous pass made progress (≥1 ticket Done or ≥1 artifact written), bounded by a relaunch cap and a no-progress guard — mirroring the claude R-MMTR-3 path.
2. **Clean-but-incomplete pickle is not fatal.** `pipeline-runner` should re-spawn (or signal mux-runner to re-spawn the manager for) the pickle phase rather than declaring `0/4 phases` and stopping, until tickets are exhausted or the no-progress guard trips.
3. **Interrupted-ticket partial work is handled at the boundary.** On a manager-boundary relaunch, partial uncommitted work for the in-flight ticket should be stashed/reset so the next pass starts clean (avoids the `assertCleanWorkingTree` second-order stall), and the ticket is retried.
4. **A no-progress guard prevents infinite relaunch.** Two consecutive passes with zero new Done tickets → halt with a clear `exit_reason` (e.g. `codex_manager_no_progress`) rather than spinning.

## Operator workaround (in place during the incident)

An external `auto-relaunch.sh` wrapper was built for the incident session: loop `pipeline-runner`; before each pass, `git stash -u` any dirty tree and reset `state.step/active/current_ticket`; stop when all tickets Done or after 2 zero-progress passes. This kept the 40-ticket build converging without per-hour operator intervention. It is a session-local band-aid, not a fix — the behavior belongs inside mux-runner/pipeline-runner so every codex pipeline benefits.

## Acceptance criteria (for the eventual fix — not committed here)

- [ ] A codex pickle phase with >3 tickets' worth of work runs to completion (all Todo tickets reach Done/Skipped) across at least 2 manager-session boundaries **without operator relaunch** — Verify: integration test with a stubbed manager that exits "inactive" after N turns, asserting the runner relaunches and drains the queue.
- [ ] The continuation trigger is turn/progress-based, not a fixed wall-clock value — Verify: grep the fix for the absence of a hardcoded 3600s/60-min pickle cutoff; assert relaunch is gated on `tickets_remaining && progressed`.
- [ ] `phase_incomplete_tickets` is no longer emitted when the pickle phase exited clean, tickets remain, and the prior pass made progress — Verify: unit test on the pipeline-runner post-phase classifier.
- [ ] A no-progress guard halts after 2 consecutive zero-progress passes with a distinct `exit_reason` — Verify: integration test with a stubbed manager that makes no progress.
- [ ] Interrupted-ticket partial work does not brick the relaunch via `assertCleanWorkingTree` — Verify: test that leaves a dirty tree at boundary and asserts the next pass starts clean.

## NOT in scope

- Changing the codex CLI's own session limits (out of our control; we adapt to them).
- The double-launch race seen in pass 1 (separate operator-error class, not the wall-limit defect).
- Reworking the claude-side relaunch (R-MMTR-3 already works; this is about parity for codex).

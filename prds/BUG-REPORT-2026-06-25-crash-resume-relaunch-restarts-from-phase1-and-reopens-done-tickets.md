# BUG-REPORT 2026-06-25 — Crash-resume: relaunching launch.sh restarts the pipeline from phase 1 and re-opens already-Done tickets (R-CRSR)

| | |
|---|---|
| **Date** | 2026-06-25 |
| **Run** | LOA standalone-loanless Statement-Analyzer epic — full pipeline `[pickle, citadel, anatomy-park, szechuan-sauce]` |
| **Runtime** | deployed `~/.claude/pickle-rick` (claude backend) |
| **Backend** | claude |
| **Pipeline** | scope `branch` base `origin/main`; 14 tickets (9 impl + 1 wiring + 4 hardening); max_iterations 500; worker-timeout 1200s |
| **Session** | `~/.local/share/pickle-rick/sessions/2026-06-25-2b0c520c` |
| **Trigger** | external: the tmux **server** died mid-PHASE-3 (anatomy-park) — `no server running on /private/tmp/tmux-501/default` (sleep / OOM / terminal close; NOT a pipeline bug). The bug is in what happened on **relaunch**. |

## TL;DR / Verdict

A pipeline whose build was **fully complete and committed** (16 commits, all 14 tickets Done, citadel passed, anatomy-park had already landed a CRITICAL fix) was **corrupted by a naive relaunch** after an external tmux-server death. Relaunching the session's `launch.sh`:

1. **Did NOT resume — it restarted from PHASE 1/4**, ignoring `pipeline-status.json` which recorded `completed_phases: 2, current_phase: "anatomy-park"`, and **reset that file to `completed_phases: 0`**.
2. On the pickle re-entry, the runner **re-selected an already-`Done` large-tier ticket** (`84636f7e`) through the detached/recovery path; its **per-ticket iteration budget was stale-exhausted** (`60/60, tier=large`), so it instantly gave up **without doing any work** (61 "iterations" in **17 seconds**), flipped `84636f7e` `Done → Failed` and `2a0e630a` `Done → Todo`, and declared **`Pipeline finished: 0/4 phases`**.

**No code was lost** — all 14 tickets' work was in git (16 commits). Only the orchestration **state files** (ticket frontmatter `status:` + `pipeline-status.json`) were corrupted. But a clean, complete pipeline was made to look failed/0-of-4, and two Done tickets were falsely marked Failed/Todo.

This is distinct from the shipped [[R-REIN]] (refund recovery budget on a *manual* `status→Todo` reset) and from [[R-DPGT]] (detached-overrun phase mis-report): here nothing was manually reset, the tickets were genuinely `Done` with durable commits, and the corruption is triggered by a **plain relaunch of the same session's launch.sh after a crash**.

## Evidence

**First run (healthy, completed the build):**
```
PHASE 1/4 PICKLE   exited code 0  — 14/14 tickets Done, committed (b8bf1126…3eaf953a, +anatomy)
PHASE 2/4 CITADEL  exited code 0  — citadel_report.json: 20 findings (19 Medium, 1 Low), 0 critical/remediable
PHASE 3/4 ANATOMY-PARK started     — committed 6b183fbcd "anatomy-park: portal-asset — CRITICAL guard
                                     loanless patchAccount direct-write paths, trap door"
<tmux server dies — runner log stops at "Anatomy Park setup complete">
pipeline-status.json @ crash: { status:"running", current_phase:"anatomy-park", completed_phases:2, total_phases:4 }
```

**Relaunch (`bash launch.sh` again — the corruption):**
```
[22:57:53] reconstruction detected (iteration=1) — start_time_epoch reset
[22:57:53] PHASE 1/4: PICKLE (backend=claude)              ← restarted at phase 1, NOT anatomy-park
pipeline-status.json after relaunch: { current_phase:"pickle", completed_phases:0 }   ← reset 2 → 0
[22:58:11] [large-tier] detached spawn-morty pid=… for 84636f7e   ← re-selected an ALREADY-DONE ticket
[22:58:11] recovery: execute-converged-plan large-tier detached worker spawned for 84636f7e
[22:58:11] mux-runner exiting with code 3: per-ticket budget (60/60, tier=large) exhausted on ticket
           84636f7e without EPIC_COMPLETED promise
[22:58:11] Max iterations reached (60/60). Exiting.           ← 61 iterations in 17s = no real work
[22:58:12] Phase pickle exited with code 3
[22:58:12] Phase pickle hit iteration cap; 2/14 tickets remain unfinished:
             110  84636f7e  [status: Failed]   ← was Done
             120  2a0e630a  [status: Todo]      ← was Done
[22:58:12] Pipeline finished: 0/4 phases, 0m 18s
```

**Post-corruption truth (git is intact):**
```
git log main..HEAD → 16 commits, every one of T1–T9 + wiring + hardening present;
                     2a0e630a (data-flow audit) legitimately has NO commit (clean audit, found nothing);
                     84636f7e has its recovery commit.
git status → clean (only exempt docs/ untracked)
```

## Root cause — two facets

**Facet A — no crash-resume; relaunch restarts at phase 1 and discards the phase ledger.**
`pipeline-runner` on (re)start always begins at `phases[0]` and rewrites `pipeline-status.json` to `completed_phases: 0`. The file already encodes the resume point (`current_phase`, `completed_phases`) but is treated as write-only telemetry, not a resume oracle. There is no documented "resume after crash" path for a mid-pipeline tmux-server death — relaunching the same `launch.sh` silently re-runs completed phases.

**Facet B — relaunch re-opens `Done` tickets and inherits a spent per-ticket budget.**
On the pickle re-entry the runner re-attached/re-selected `84636f7e` (a large-tier ticket that was `Done` with a durable commit) via the `execute-converged-plan` detached/recovery path. Its per-ticket iteration budget (`60`, large tier) was **not reset** for the new process, so it entered already at `60/60` and exhausted instantly → flipped `Done → Failed` and the pipeline halted `0/4`. A ticket that is already `Done` with a durable `completion_commit` should be **skipped before any budget accounting** on (re)entry; the per-ticket budget should reset on a fresh process start.

## Proposed fix (reuse-first, subtract-before-add — matching house style)

- **Facet A:** on launch, if `pipeline-status.json` for this session shows `status: "running"` with `completed_phases > 0`, **resume at `current_phase`** (skip the already-completed phases) instead of restarting at `phases[0]`; do not reset the counter. Reuse the existing `pipeline-status.json` as the resume oracle — no new state.
- **Facet B:** before per-ticket budget accounting on (re)entry, **skip tickets already `Done` with a durable `completion_commit`** (reuse the SAME single `readEvidence` oracle that gates the Done-flip — the one B-DURA/R-CECX already established). Independently, **reset the per-ticket iteration budget on a new process start** so a crash-relaunch does not inherit a spent budget. Closes the "relaunch flips Done→Failed" path that [[R-REIN]]'s refund-on-`Todo`-reset does not cover (R-REIN only fires on a manual status reset, not on a crash-relaunch of `Done` tickets).

## Operator recovery (what unblocked it, verified)

1. `tmux kill-session` the corrupted relaunch (do **not** relaunch `launch.sh` again — it re-restarts + re-corrupts).
2. Repair the two falsely-flipped statuses back to `Done` (their work is committed; the data-flow audit's no-commit is a legitimate clean-audit Done).
3. Finish the remaining review phases via the **standalone skills** (`/anatomy-park`, `/szechuan-sauce`) on the committed branch — fresh session `2026-06-25-906e288c` — rather than re-running the full pipeline.

## Cross-references

- [[R-REIN]] (shipped beta.23) — refunds the recovery budget on a manual `status→Todo` reset; does **not** cover crash-relaunch of `Done` tickets (Facet B is the gap).
- [[R-DPGT]] — detached large-tier overrun + phase mis-report; shares the large-tier detached lifecycle machinery but a different trigger (cap during a *first* run, not a relaunch).
- [[R-SLEAK]] — leaked tmux sessions; the external tmux-server death here is the inverse (whole server gone), and argues for a relaunch path that survives it.

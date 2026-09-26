# Field timing results — 2026-09-26

Companion to `field-timing.py`. First field measurement run for the corpus-bias warning in `../2026-09-agent-systems-spike.md`: every timing below comes from full pipeline runs on an operator monorepo, not from Pickle Rick building itself.

**Command:** `python3 prds/research/tools/field-timing.py` (default `~/.local/share/pickle-rick/sessions`), plus `--json`. Script at `78d861a7`.

**Verification:** phase minutes were checked by hand against the `PHASE n/4` and `Phase <x> exited` lines in each session's `pipeline-runner.log` and matched. Wall-clock is the first to last timestamp in the same log.

## Results

All three are `pickle → citadel → anatomy-park → szechuan-sauce` runs, backend claude, scoped. Minutes.

| Session | Repo | Tickets (tiers) | Iterations | Worker spawns | Wall | Pickle | In workers | Outside workers | Citadel | Anatomy | Anatomy finalize-gate | Szechuan | Anatomy passes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `2026-09-24-9e751d84` | `a4a4087c` | 9 (4 L, 4 M, 1 S) | 11 | 12 | 317.4 | 240.5 | 175.2 | 65.3 | 3.7 | 57.1 | 6.9 | 8.7 | 5 (1 lane) |
| `2026-09-24-c13bddae` | `d074c9df` | 10 (6 L, 4 M) | 13 | 15 | 366.4 | 261.0 | 199.0 | 62.0 | 0.9 | 21.3 | 46.0 | 37.0 | 4 (2 lanes) |
| `2026-09-25-331bd02b` | `01af3144` | 5 (4 M, 1 S) | 10 | 8 | 127.5 | 98.0 | 77.8 | 20.2 | 2.0 | 13.4 | 6.5 | 6.1 | 2 (1 lane) |
| **Total** | | 24 | 34 | 35 | 811.3 | 599.5 | 452.0 | 147.5 | 6.6 | 91.8 | 59.4 | 51.8 | |

"Anatomy finalize-gate" is the time between `Phase anatomy-park exited` and `PHASE 4/4`. `field-timing.py` does not report it; it was read from the log.

## Findings

1. **The pickle phase is ~74% of wall-clock** (599.5 / 811.3), at 20–27 minutes per ticket. Self-hosted timings in the spike report understate field build time by roughly an order of magnitude.
2. **About a quarter of the pickle phase is outside worker spawns** (147.5 / 599.5): manager turns, gates, relaunches. That's 20–65 min per run.
3. **Review and cleanup phases are small next to build.** Citadel took 1–4 min, anatomy-park 13–57 and szechuan-sauce 6–37. Build parallelism is still the lever that matters for field wall-clock.
4. **Anatomy-park failed in all three runs.** Each time the microverse exited with an error and then `finalize-gate failed after error (exit 2) — phase not completed, run cannot report success`. The gate itself took 59.4 min in total, 46.0 of it in one run.
5. **`state.json` says `exit_reason: converged` for all three runs** even though the runner log above says the run cannot report success. The recorded session outcome contradicts the pipeline's own log.

## Script gaps found

- **The finalize-gate interval is uncounted.** The time after anatomy-park exits and before szechuan-sauce starts is not in any column. It was 7% of wall-clock here.
- **Older sessions are dropped without a warning.** `~/.claude/pickle-rick/sessions` holds 43 sessions (Feb–Apr 2026, 418 worker logs) and the script reports `0 sessions`. Those runs predate `pipeline-runner.log` and name tickets `linear_ticket_<id>.md`, not `rick_ticket_<id>.md`. With a filename fallback they could give only ticket counts and worker minutes, not phase times, and they come from an older pipeline.
- The session in `~/.local/share` with only a PRD (`2026-09-22-28372bdb`, no build) is correctly excluded.

## Limits

n = 3, all on one monorepo in one 36-hour window, all claude backend. Worker minutes are `mtime − birthtime` per `worker_session_*.log`, so they assume a log's last write marks the end of its spawn.

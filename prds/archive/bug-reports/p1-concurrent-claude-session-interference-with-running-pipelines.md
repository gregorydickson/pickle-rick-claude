---
title: P1 — Concurrent Claude-session interference with running pipelines (tmux signals, pane kills, process targeting)
status: Draft
filed: 2026-05-11
priority: P1
type: bug-architecture
---

# PRD — Concurrent Claude-session interference with running pipelines

**Author**: Pickle Rick
**Project**: `pickle-rick-claude`
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`, local-only

## Symptom

Multi-hour pickle-rick pipelines occasionally die from SIGINT or partial monitor-window collapse with no operator action taken in the attached terminal. Three observed incidents in the last 36 hours:

1. **Bundle 2026-05-10 session `2026-05-10-84ad0873` at `2026-05-11T01:22:58Z`** — pipeline-runner received SIGINT after only ~6 min of runtime, well below any cap. R-MMTR ruled out by timing; R-MDS cross-session hypothesis raised then disregarded; origin unattributable from logs. Operator burned ~45 min triaging. Filed as Open Finding #20 R-SOA (diagnostic gap).

2. **Bundle 2026-05-11 session `2026-05-11-b7aad50b` at `2026-05-11T16:40:34Z`** — mux-runner received SIGINT mid-pickle phase. Coincidentally graceful (mux-runner treats SIGINT as "deactivate session → exit 0"), so pipeline-runner moved to citadel + anatomy-park. But pickle phase shipped only 5/46 tickets before the SIGINT.

3. **Bundle 2026-05-11 monitor-window collapse cascade** — monitor window in `pipeline-b7aad50b` died and partially-respawned multiple times across the run. Watchdog `restartDeadWatcherPanes` fired but could not respawn pane 0 when pane 0 itself (which hosts the watchdog) was the dead one. Three operator-initiated rebuilds were needed.

Operator hypothesis (filed 2026-05-11 evening): *"I often ask a Claude session to check status and sometimes another running pipeline gets a SIGINT or monitor crash. I think that sometimes when I run this it accidentally does this."* That is, **a sibling Claude session running status-check commands inadvertently emits destructive signals at the pipeline's tmux/process tree**.

## Root cause (working model)

Claude sessions and the pickle-rick toolset have **no coordination model** for concurrent access to a running pipeline. Status-check commands are mostly read-only, but recovery commands (the same Claude session may run both within minutes of each other) include:

| Command | Signal vector | Target scope |
|---|---|---|
| `tmux send-keys -t <target> C-c` | SIGINT to foreground process in pane | pane (can collateral-damage if pgrp differs) |
| `tmux kill-window -t <target>` | SIGHUP to all processes in window | window |
| `tmux kill-session -t <target>` | SIGHUP to all processes in session | session (every window) |
| `pkill -f <pattern>` | SIGTERM (or specified signal) to every PID matching pattern | filesystem-wide |
| `kill <pid>` | SIGTERM by default | single process |
| `bash launch.sh` re-run | Spawns competing pipeline-runner against same SESSION_ROOT | inter-process race |

A Claude session has no built-in awareness of *whether another session is currently driving the same pipeline*. Window indices shift across `kill-window` + new-window churn; `pkill -f` can match more PIDs than intended; `tmux send-keys C-c` can race with respawn logic and hit a pane that's mid-restart.

R-SOA (Finding #20) catches signals at the *receiver* and logs context (`is_tty`, `pgid`, `ppid`, `active_child_pid`). R-CSI catches signals at the *emitter* and either logs them for forensics OR refuses them when an unrelated process tree owns the pipeline. The two are complementary.

## Severity

P1 — confirmed across three incidents in 36 hours. Cost per incident: 15-45 min of operator triage + the lost pipeline progress. Cost is super-linear in concurrency: with N Claude sessions open and M minutes between status checks per session, the expected collision rate is `N × M × incident-fraction`, and incident-fraction is currently unknown. Climbs to P0 the moment two Claude sessions race on `bash launch.sh` against the same SESSION_ROOT and corrupt `state.json` mid-write.

## Fix Requirements — two phases

### Phase 1: Research (read-only forensics — ship first)

- **R-CSI-1** (R-MUST): Enumerate every command in the pickle-rick toolset and the Claude harness's typical command surface that can emit destructive signals against a running pipeline. Output: `extension/docs/destructive-commands-catalog.md` with one row per command listing (a) signal vector (SIGINT / SIGTERM / SIGHUP / SIGKILL / SIGCHLD-cascade), (b) target scope (process / window / session / pgrp / fs-wide), (c) typical caller (operator / Claude session / cron / hook), (d) idempotency notes. Walk `extension/src/`, `.claude/commands/`, `extension/scripts/`, and the operator's `~/.zshrc`/`~/.bashrc` aliases.

- **R-CSI-2** (R-MUST): Shell wrapper `extension/bin/pr-audit-cmd.sh` that records every invocation of `tmux send-keys`, `tmux kill-window`, `tmux kill-session`, `pkill -f`, `kill <pid>`, `bash launch.sh` to `~/.claude/audit/destructive-commands.log` with timestamp, caller-ppid (and full ancestry chain via `ps -o pid,ppid,command`), target args verbatim, success/failure exit code. Wrapper installed via `$PATH` shim so it precedes the real binaries for Claude sessions only. Opt-in via env var `PR_AUDIT_DESTRUCTIVE_CMDS=1` (Claude-session-launch sets this; user shells don't).

- **R-CSI-3** (R-MUST): Retro-attribution pass — for each of the three known incidents (timestamps and SESSION_ROOTs from the Symptom section), correlate `~/.claude/audit/destructive-commands.log` (if it exists from a prior collection) with `mux-runner.log` / `pipeline-runner.log` SIGINT lines and any R-SOA `signal_received` events. Output: `prds/research/csi-incident-attribution-2026-05-11.md` with one section per incident, naming the killing command (or marking as "no audit data — pre-instrumentation").

- **R-CSI-4** (R-SHOULD): Trap-door entry pinned at `extension/CLAUDE.md` documenting "every destructive command against a running pipeline must be audit-logged via `pr-audit-cmd.sh`; Claude-session start scripts MUST set `PR_AUDIT_DESTRUCTIVE_CMDS=1`."

### Phase 2: Solution (prevention — ship after Phase 1 validates the model)

- **R-CSI-5** (R-MUST): `${SESSION_ROOT}/session.lock` file written at pipeline launch with frontmatter:
  ```json
  {
    "owner_pid": 12345,
    "owner_pgid": 12345,
    "owner_tmux_session": "pipeline-b7aad50b",
    "owner_terminal": "/dev/ttys012",
    "launch_shell_pid": 11111,
    "started_at": "2026-05-11T14:48:28.043Z",
    "schema_version": 1
  }
  ```
  Cleared on pipeline-runner graceful exit; left stale on crash. Stale-lock detection on next pipeline launch: if `owner_pid` is not alive, take ownership and continue.

- **R-CSI-6** (R-MUST): Destructive-command guard helper `extension/src/services/destructive-guard.ts` exposing `assertSessionWriteAccess(sessionRoot, callerPid)`. Reads `session.lock`, walks the caller's process-tree ancestry, and:
  - Owner alive AND caller is in owner's process tree → allow.
  - Owner alive AND caller is NOT in owner's tree → refuse with `SESSION_LOCK_HELD` error message: `"Pipeline ${owner_tmux_session} is owned by PID ${owner_pid} (started ${started_at}). This Claude session has read-only access. To take control: 1) attach to ${owner_tmux_session}, OR 2) wait for the owner to exit, OR 3) explicitly --force (operator override)."`
  - Owner dead (stale lock) → allow + log `stale_session_lock_recovered` event.

- **R-CSI-7** (R-MUST): Wire `assertSessionWriteAccess` into every destructive-command call site in `extension/src/`. Inventory from R-CSI-1 enumerates them; this requirement enforces the guard at each one. Specific known sites: `pickle-utils.ts` (`tmux kill-window`, `tmux send-keys`), `mux-runner.ts` (relaunch path), `setup.js --resume` (state.json write). Forward-compat: future destructive commands MUST go through `destructive-guard.ts`.

- **R-CSI-8** (R-MUST): Claude-harness convention — when a Claude session is invoked via `/pickle-status`, `/pickle-metrics`, `/pickle-standup`, or any other read-only skill, the skill's bootstrap MUST set `PICKLE_OBSERVER_MODE=1` in the shell env. `destructive-guard.ts` refuses on observer mode regardless of process-tree ancestry. Operator can override with `PICKLE_OBSERVER_OVERRIDE=1` for intentional cross-session intervention.

- **R-CSI-9** (R-SHOULD): mux-runner SIGINT debounce in `extension/src/bin/mux-runner.ts`. First SIGINT logs `signal_first_seen` + prints to stderr `"Press Ctrl-C again within 5s to abort"`; resets a 5s timer. Second SIGINT within the window → actually deactivate. SIGTERM and SIGHUP unaffected (debounce only on the keyboard-interrupt signal). Mitigates the case where a misfired `tmux send-keys C-c` from a sibling Claude session triggers a single SIGINT.

- **R-CSI-10** (R-MUST): Closer — bump version (minor for Phase 1 + minor for Phase 2; alternatively, ship as two separate minors), MASTER_PLAN bookkeeping (close Finding #25 when both phases ship), regression tests at `extension/tests/destructive-guard.test.js` covering (a) lock acquired and refused, (b) stale-lock recovered, (c) observer-mode refused, (d) override flag respected, (e) SIGINT debounce double-press fires correctly.

## Out of scope

- **Replacing tmux with a different process-manager.** tmux is fine; the bug is the absence of a coordination model on top of it.
- **Fully preventing operator-initiated SIGINT in the attached terminal.** That's intentional control. R-CSI prevents SIGINTs from *unrelated process trees*, not from the actual owner's terminal.
- **Multi-pipeline scheduling.** Operator running 2 pipelines concurrently is fine; the lock is per-SESSION_ROOT, not per-machine.

## Sister findings

- **Finding #20 R-SOA** — receiver-side forensics. Together with R-CSI's emitter-side guard, they close the loop: R-SOA tells you a signal arrived from an unrelated source; R-CSI's audit log tells you exactly which sibling session fired it; R-CSI's guard prevents it firing in the first place.
- **Finding #22 R-PHC** — pipeline continues through non-fatal exits. Reduces the cost of an accidental kill (downstream phases still run), but does NOT prevent the kill. R-CSI is the prevention layer.
- **Finding #15 R-MDS** — monitor dashboard stale across phases. Related: the monitor-collapse cascade (incident #3) is partly an R-MDS symptom and partly an R-CSI symptom. After both ship, monitor crashes should drop sharply.

## Triggering session

`2026-05-11-b7aad50b` — bundle 2026-05-11 pipeline-reliability quintet. Operator hypothesis filed 2026-05-11 PM after observing three SIGINT/monitor-crash incidents in 36 hours and noting the temporal correlation with status-check activity across multiple Claude sessions.

## Atomic decomposition

### Phase 1 (research)
- **R-CSI-1**: enumerate destructive commands + write catalog (~150 LOC docs, 1 commit)
- **R-CSI-2**: `pr-audit-cmd.sh` shim + opt-in via env var (~80 LOC bash + plumbing, 1 commit)
- **R-CSI-3**: retro-attribution research doc for the 3 incidents (~research-only, 1 commit)
- **R-CSI-4**: trap-door pin (~15 LOC docs, 1 commit)

### Phase 2 (solution)
- **R-CSI-5**: `session.lock` write at pipeline launch + stale-lock detection (~60 LOC across `pipeline-runner.ts` + `setup.js`, 1 commit)
- **R-CSI-6**: `destructive-guard.ts` helper with `assertSessionWriteAccess` + ancestry walk (~120 LOC + 1 test, 1 commit)
- **R-CSI-7**: wire guard into every destructive call site (~80 LOC across multiple files, 1 commit)
- **R-CSI-8**: observer-mode convention + Claude-skill bootstrap updates (~50 LOC across `.claude/commands/pickle-status.md` + similar, 1 commit)
- **R-CSI-9**: SIGINT debounce in mux-runner (~40 LOC + 1 test, 1 commit)
- **R-CSI-10**: closer (~30 LOC + version bump + tests, 1 commit)

Approx 1 day for Phase 1, 1-1.5 days for Phase 2. Total ~2-2.5 days. Phase 1 ships standalone (low-risk forensics). Phase 2 ships once Phase 1 validates the model — if R-CSI-3 attribution proves all three incidents were *operator-initiated* and not sibling-session, Phase 2 scope reduces (skip R-CSI-6/7/8, ship only R-CSI-9 debounce).

## Acceptance criteria (machine-checkable)

- [ ] **AC-CSI-01** — `extension/docs/destructive-commands-catalog.md` enumerates ≥6 commands with signal-vector + target-scope columns. Regression: parser test asserts ≥6 rows.
- [ ] **AC-CSI-02** — `pr-audit-cmd.sh` shim logs every destructive command invocation with caller ancestry. Regression: synthetic test that invokes `tmux kill-window` via the shim and asserts an entry in `~/.claude/audit/destructive-commands.log` with non-empty ancestry chain.
- [ ] **AC-CSI-03** — `prds/research/csi-incident-attribution-2026-05-11.md` documents each of the 3 known incidents with attribution-or-pre-instrumentation marker. Manual review (not machine-checkable).
- [ ] **AC-CSI-04** — `${SESSION_ROOT}/session.lock` exists after pipeline launch with all 7 fields populated. Regression: launch-fixture test asserts JSON shape.
- [ ] **AC-CSI-05** — `assertSessionWriteAccess` refuses with `SESSION_LOCK_HELD` when caller is not in owner's process tree. Regression: fork-process test fixture.
- [ ] **AC-CSI-06** — `assertSessionWriteAccess` allows after stale-lock detection (owner_pid not alive). Regression: kill-then-attempt fixture.
- [ ] **AC-CSI-07** — `PICKLE_OBSERVER_MODE=1` refuses every destructive call site. Regression: env-set + attempt-destructive-call test.
- [ ] **AC-CSI-08** — mux-runner SIGINT debounce: first SIGINT logs only; second within 5s deactivates. Regression: signal-fixture test fires two SIGINTs with timing.
- [ ] **AC-CSI-09** — Audit log + R-SOA `signal_received` events correlate cleanly when both are present. Regression: integration test fires SIGINT via the shim, then asserts both the audit log entry and the receiver-side event reference the same `received_at_iso` timestamp ± 100ms.

## Working-rule candidate (added if Phase 2 ships)

> "**Concurrent Claude sessions operating on the same pipeline MUST go through the destructive-guard layer.** Status checks (`/pickle-status`, `/pickle-metrics`, etc.) set `PICKLE_OBSERVER_MODE=1` by default and have read-only access. Pipeline mutation (kill, send-keys, relaunch, version bump) requires either ownership of the session lock OR an explicit `--force` from the operator. Audit log at `~/.claude/audit/destructive-commands.log` records every mutation; correlate with R-SOA `signal_received` events for post-hoc forensics."

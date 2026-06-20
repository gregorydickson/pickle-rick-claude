---
title: P3 — pipeline-runner SIGINT/SIGTERM/SIGHUP handler emits no origin attribution; unattributable shutdowns
status: Draft
filed: 2026-05-10
priority: P3
type: bug-observability
---

# PRD — Pipeline-runner shutdown signal origin attribution gap

**Author**: Pickle Rick
**Project**: `pickle-rick-claude`
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`, local-only

## Symptom

Bundle 2026-05-10 session `2026-05-10-84ad0873` experienced **three distinct shutdown events in one day**:

1. **14:16 local** — iter 2 ran 4h, manager `claude -p --max-turns 400` exit misclassified as fatal (R-MMTR, Open Finding #19).
2. **20:10 local** — same R-MMTR fired again; iter 2 ran 4h 23m. Tmux session `pipeline-84ad0873` died entirely this time.
3. **20:22:58 local** (`2026-05-11T01:22:58Z` in `pipeline-runner.log`) — relaunch via `bash launch.sh` had run only ~6 min; SIGINT received during PHASE 1/4 PICKLE while worker pid 24471 was processing ticket `698924c1`. **This is NOT R-MMTR** (max-turns budget can't deplete in 6 min) and **not a worker crash** (worker pid 24471 was alive when SIGINT hit pipeline-runner). Origin unknown.

`pipeline-runner.log` for events 1, 2, and 3 all show the identical line:

```
[<timestamp>] Received SIGINT — shutting down pipeline
```

`state.json.exit_reason` recorded as `"signal"` for event 3 — no further detail. For events 1 and 2, R-MMTR PRD documents the upstream root cause and the fix; **but only because the operator inferred R-MMTR from the 4-hour iter-duration timing**. For event 3 the operator has no breadcrumbs to attribute the SIGINT origin.

## Root cause

`extension/src/bin/pipeline-runner.ts:1597-1612` (`handleShutdown`) and its compiled twin at `extension/bin/pipeline-runner.js:1204-1226`:

```ts
const handleShutdown = (signal: string) => {
  runtime.log(`Received ${signal} — shutting down pipeline`);
  // … fs.writeFileSync(cancelMarker, signal); writePipelineStatus('cancelled'); …
  recordExitReason(runtime.statePath, 'signal');
  // …
};
```

The handler logs only the bare signal name. It captures **none** of the available diagnostic context that would let an operator attribute the signal:

- `process.ppid` (parent process — if pipeline-runner's parent is bash + `launch.sh`, that's expected; if parent died and `launch.sh` was reparented, that's suspicious)
- `process.pid` and child PID(s) of `activeChild` (which sub-phase was mid-run when the signal arrived)
- Whether the calling process has a controlling TTY (`process.stdin.isTTY`, `process.stdout.isTTY`) — a strong tell for "user pressed Ctrl-C in attached tmux pane" versus "external `kill -INT` from a sibling process"
- Foreground process group leader (`process.getpgid?.(0)`) — distinguishes "the whole pgrp got SIGINT (TTY)" from "this PID specifically got SIGINT"
- A short stack trace from where the signal handler was entered (Node.js can produce one via `new Error().stack`)
- The current phase name and last-known phase progress

`recordExitReason(runtime.statePath, 'signal')` further collapses the three signal classes (SIGINT/SIGTERM/SIGHUP) into one indistinguishable `"signal"` token in `state.json`, so the operator cannot even tell which signal was received without re-reading the log.

## Severity

P3 — diagnostic deficiency, not a pipeline-killer in isolation. **However:** when paired with the recurring shutdown classes already on file (R-MMTR Finding #19, R-MJCP Finding #13, R-PRJT Finding #16, R-ICP iteration-cap), every unattributable shutdown costs the operator 10-30 minutes of triage just to decide which known bug fired or to file a new one. Today's session lost approximately 45 min of operator time on event 3 alone — investigating whether monitor.js, tmux-monitor.sh, or the just-shipped R-MDS code could be sending stray signals across sessions, when the simplest hypothesis (user Ctrl-C in the attached pane) couldn't be confirmed or ruled out.

Climbs to P2 if a future shutdown class is masked because its signature (e.g. external orchestrator sending SIGTERM with a distinct PID footprint) cannot be distinguished from operator Ctrl-C in logs.

## Fix Requirements

- **R-SOA-1** (R-MUST): `handleShutdown(signal)` in `extension/src/bin/pipeline-runner.ts` MUST log a structured `signal_received` activity event capturing:
  - `signal` (exact name: SIGINT / SIGTERM / SIGHUP)
  - `pid`, `ppid`
  - `is_tty: process.stdin.isTTY || process.stdout.isTTY`
  - `pgid: process.getpgid?.(0) ?? null`
  - `active_child_pid: activeChild?.pid ?? null`
  - `active_child_cmd: activeChild?.spawnargs?.[0] ?? null`
  - `current_phase` (from runtime, if mid-phase)
  - `received_at_iso: new Date().toISOString()`
  - `handler_stack: new Error('signal received').stack` (truncated to 5 frames)
  The event MUST be schema-registered in `extension/src/types/index.ts` activity allowlist.

- **R-SOA-2** (R-MUST): `recordExitReason` MUST persist the **specific** signal name (`signal:SIGINT`, `signal:SIGTERM`, `signal:SIGHUP`) rather than the bare token `"signal"`. Migration path: existing `"signal"` rows are read as `"signal:SIGINT"` for backward compat in state-manager schema-migrate.

- **R-SOA-3** (R-SHOULD): The structured `signal_received` event MUST be appended to `pipeline-runner.log` AS WELL AS emitted via `logActivity` — `pipeline-runner.log` is the operator's first stop and currently shows only the bare signal name.

- **R-SOA-4** (R-MUST): Regression test `extension/tests/pipeline-runner-signal-attribution.test.js` covers:
  - `signal_received` event includes all R-SOA-1 fields with correct types
  - `state.json.exit_reason` records `"signal:SIGINT"` (not `"signal"`) when SIGINT delivered
  - `pipeline-runner.log` contains the structured fields, not just the bare line
  - Backward-compat: pre-existing `state.json` with `exit_reason: "signal"` is migrated to `"signal:SIGINT"` on next load

- **R-SOA-5** (R-SHOULD): Trap-door entry pinned at `extension/src/bin/pipeline-runner.ts` documenting the `handleShutdown` diagnostic invariant. INVARIANT: every signal entry MUST emit `signal_received` activity + write specific signal name to exit_reason. BREAKS: future "unattributable shutdown" sessions burn operator triage time. ENFORCE: regression test from R-SOA-4.

- **R-SOA-6** (R-MAY): Companion improvement — `launch.sh` (templated per-session at `${SESSION_ROOT}/launch.sh`) MAY also write a `launch_shell_pid: $$` breadcrumb to `state.json` at startup, so the operator can correlate signal-handler `ppid` against the known launch shell PID. Optional; the in-Node fields above are sufficient for attribution.

## Out of scope

- Finding the actual source of event 3's SIGINT this session. By the time this PRD is filed, the breadcrumbs no longer exist. The fix lets **future** events be attributed; it does not retroactively explain today's.
- Investigating whether the just-shipped R-MDS monitor code (`ensureMonitorWindow`, `restartDeadWatcherPanes`) could be sending stray cross-session signals. Hypothesis was raised earlier in the session and disregarded by user. Re-open as a separate finding if the diagnostic logging above lands and a future event shows a non-TTY signal origin coincident with monitor-window churn.

## Sister findings

- **#19 (R-MMTR)** — same shutdown line; R-MMTR catches the manager max-turns class specifically. R-SOA is broader: it attributes ANY signal-driven shutdown, including the residue after R-MMTR ships.
- **#13 (R-MJCP)**, **#16 (R-PRJT)**, **R-ICP** — all "clean exit at cap misclassified as fatal." Those PRDs each fix one classification; R-SOA improves the diagnostic surface so the next one is found faster.

## Triggering session

`2026-05-10-84ad0873` — bundle 2026-05-10. Third shutdown event of the day (20:22:58 local / `2026-05-11T01:22:58Z`) had no attributable cause; relaunched via the standard recovery procedure (R-MMTR PRD §"recovery"); operator confirmed no orphan workers and clean working tree before relaunch.

## Atomic decomposition

- **R-SOA-1**: structured `signal_received` activity event + ESLint schema registration (~40 LOC, 1 commit)
- **R-SOA-2**: specific signal name in `exit_reason` + state-manager backward-compat migration (~30 LOC, 1 commit)
- **R-SOA-3**: dual-write to `pipeline-runner.log` + activity log (~10 LOC, 1 commit; folds into R-SOA-1)
- **R-SOA-4**: regression test (~80 LOC, 1 commit)
- **R-SOA-5**: trap-door pin (~15 LOC docs, 1 commit)
- **R-SOA-6**: optional `launch.sh` breadcrumb (~5 LOC, 1 commit, MAY)

Approx half-day fix. Ship in next P3 maintenance bundle or fold into next P1 bundle as a low-risk add-on (atomic edits, isolated test, no behavioral change other than richer logging).

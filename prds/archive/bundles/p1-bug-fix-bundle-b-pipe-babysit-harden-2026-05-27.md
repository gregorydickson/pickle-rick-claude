---
title: P1 — B-PIPE-BABYSIT-HARDEN bundle: long-running pipeline health (orphan managers, slow auto-skip, state-freshness lag)
status: Draft
filed: 2026-05-27
priority: P1
type: bug-bundle
composes:
  - 80   # R-OMS — orphan manager subprocess survives iteration boundaries
  - 81   # R-AISLOW — auto-skip-already-Done iteration is 1h+ slow
  - 82   # R-SJLAG — state.json mtime lags manager turn, blocks operator triage
---

# PRD — B-PIPE-BABYSIT-HARDEN bundle

**Trigger**: The 2026-05-26 B-RELEASE-DRIFT run (`pickle-ea04b6f8`) — babysat across ~6 h via the cron `/loop` — surfaced three distinct long-running-pipeline pathologies, each with concrete in-session evidence. They share one theme: **a long bundle is expensive to run and hard to babysit**. Fixing them compounds across every future bundle (faster wall time + a reliable single freshness signal + no resource leak).

**Why bundle these three**: all P1, all observed in the same session, all touch `mux-runner.ts`'s iteration loop, and all directly improve the cron-babysitter operating model we now depend on to drain the bug queue. #81 alone cuts B-RELEASE-DRIFT-class elapsed from ~6 h to ~2 h.

## Design constraint (READ FIRST — applies to R-OMS)

Finding **#74 R-WSWA** established that **schema-version-bump bundles cannot self-deploy mid-run**: the running mux-runner loads its compiled binary at process start, so a `LATEST_SCHEMA_VERSION` bump + new `state.json` field trips the R-WSRC-2 `state_schema_version_ahead` guard before the new code takes effect. Therefore **R-OMS MUST NOT add a tracked `state.json` field** (no `active_manager_pid` in the state schema). Instead, track the manager pid via a **session-dir sidecar pidfile** (`<sessionDir>/.active_manager.pid`) and/or a **`ps`-scan** for `claude` processes whose `--add-dir` set includes this `sessionDir` — mirroring the existing orphan-fast-test-runner reaper (`reapOrphanedFastTestRunnersOnStartup` / `parseOrphanedFastTestRunnersFromPs`, `mux-runner.ts:371-379`). This keeps the bundle schema-neutral and self-deployable.

## Acceptance Criteria

- **AC-BPBH-00**: full release gate green from a clean clone — `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive` exits 0.
- **AC-BPBH-01 (R-AISLOW)**: when the next pending ticket at iteration_start is already `Done`/`Skipped`, mux-runner advances `current_ticket` + `iteration` WITHOUT spawning a claude manager turn (assert 0 spawn calls via injected spawn mock).
- **AC-BPBH-02 (R-OMS)**: after two sequential iterations, the manager subprocess from iteration N is dead (not just orphaned) by the start of iteration N+1 — no stray `claude --dangerously-skip-permissions` for this `sessionDir` survives an iteration boundary.
- **AC-BPBH-03 (R-SJLAG)**: during a single manager turn that writes artifact files (research/plan/conformance), `state.json` mtime advances at least once between iteration boundaries (operator can use `state.json` mtime as a single freshness signal).
- **AC-BPBH-04**: no `LATEST_SCHEMA_VERSION` bump; `state.json` schema is byte-compatible with v1.80.3 readers (schema-neutral per the design constraint above).

---

## Class A — R-AISLOW: auto-skip-already-Done pre-check (#81, highest leverage, 2 tickets)

**Symptom**: mux-runner spends a full claude manager turn (observed 1h25m on `1b57ef57`, 27m on `910ae36c`) just to log `Ticket <id> already marked Done by model — skipping validation` and advance. The "already Done" detection lives in claude-side prompt reasoning, not a mux-runner pre-check.

- **R-AISLOW-1** — Add a `findFirstPendingTicket(sessionDir)` pre-check at iteration_start in `mux-runner.ts` (before the manager `spawn(...)` at line ~2259). If the topologically-first non-terminal ticket is already `Done`/`Skipped`, advance `current_ticket`/`iteration` and emit a `ticket_preskipped_already_terminal` activity event (forward-create in `VALID_ACTIVITY_EVENTS`) WITHOUT spawning claude. Reuse `collectTickets` + `getTicketStatus` + `topoSortTickets` (already imported). Acceptance: AC-BPBH-01.
- **R-AISLOW-2** — Regression test `extension/tests/aislow-preskip-no-spawn.test.js` (forward-created): fixture session where the next ticket frontmatter is `status: Done`; inject a spawn-capture mock; assert iteration advances with **0** manager spawns and exactly one `ticket_preskipped_already_terminal` event. Negative case: a `Todo` top ticket DOES spawn.

---

## Class B — R-OMS: orphan manager reaping (#80, 3 tickets, schema-neutral)

**Symptom**: a `claude` manager spawned at an iteration boundary (`pid 99916`, iter 6) survived 4+ h through iters 7/8/9. mux-runner spawns fresh managers per iteration but never reaps the prior stray. Risk: RAM accumulation (~500 MB each) + rare state.json lock contention.

- **R-OMS-1** — On manager spawn (`mux-runner.ts:2259`), write the child pid to a sidecar `<sessionDir>/.active_manager.pid` (NOT state.json — see design constraint). Clear the sidecar on clean child exit in the existing exit handler. No schema change.
- **R-OMS-2** — At iteration_start, before spawning the new manager, reap any stray: read `.active_manager.pid` AND `ps`-scan for `claude --dangerously-skip-permissions` whose `--add-dir` includes this `sessionDir`; SIGTERM any matching pid that is not the about-to-be-current child. Emit `orphan_manager_reaped` (forward-create in `VALID_ACTIVITY_EVENTS`) per reaped pid. Mirror `reapOrphanedFastTestRunnersOnStartup` (lines 371-379). Acceptance: AC-BPBH-02.
- **R-OMS-3** — Regression test `extension/tests/oms-orphan-manager-reaped.test.js` (forward-created): simulate two sequential iterations with a fake long-lived child from iter 1; assert it is SIGTERM'd by iter 2 start and one `orphan_manager_reaped` event is emitted. Assert no schema-version change (AC-BPBH-04).

---

## Class C — R-SJLAG: state-freshness heartbeat (#82, 2 tickets, schema-neutral)

**Symptom**: `state.json` mtime stays frozen at iteration-start for the whole manager turn (25min+ common, 1h25m on iter 2), so the babysitter can't distinguish "wedged" from "working" without `tmux capture-pane` + `ls -la <ticket_dir>`.

- **R-SJLAG-1** — Add a `manager_turn_progress` heartbeat: when artifact files (research/plan/conformance) under the current ticket dir gain a newer mtime during a manager turn, touch `state.json` mtime (a no-content `utimesSync` or an activity-entry write that bumps mtime). Emit `manager_turn_progress` activity event (forward-create in `VALID_ACTIVITY_EVENTS`). MUST NOT mutate state content (R-WSRC-safe: mtime/activity only). Acceptance: AC-BPBH-03.
- **R-SJLAG-2** — Document the operator-facing freshness contract in `extension/src/bin/CLAUDE.md` (or the babysitter runbook): "`state.json` mtime advances at least once per artifact-write during a manager turn; a `state.json` >N min stale with no `manager_turn_progress` event indicates a genuine wedge." Add regression test `extension/tests/sjlag-state-heartbeat.test.js` (forward-created) asserting mtime advances when a fixture artifact file is touched mid-turn.

---

## Total: 7 tickets + closer

| Class | Finding | Tickets | Leverage |
|---|---|---|---|
| A R-AISLOW | #81 | 2 | **Highest** — 6h→2h elapsed |
| B R-OMS | #80 | 3 | Resource-leak + lock-safety |
| C R-SJLAG | #82 | 2 | Babysitter freshness signal |

Dispatch order: A → B → C → close (A is the biggest win and lowest risk; C depends on no schema change which B establishes).

## Closer

`R-PIPE-BABYSIT-CLOSER` — full release gate, version bump 1.80.3 → **1.81.0** (MINOR: new activity events + new pre-check/reaping behavior, NO breaking schema change), `bash install.sh` (set `state.flags.allow_install_sh_reason` then clear), `gh release create v1.81.0`. Closes findings #80, #81, #82.

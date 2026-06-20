---
title: P1 bug-fix bundle — B-CMWL — codex manager fixed-wall pickle stall (relaunch parity + progressing-incomplete-not-fatal + no-progress guard)
status: SHIPPED v1.88.0 (verify-first closed 2026-06-02) — STALE PRD; do not re-launch. Closer 916f53e5 (+ bb47cb62 R-CMWL-4 no-progress guard). codex_manager_consecutive_no_progress relaunch-parity in HEAD (mux-runner.ts/state-manager.ts/types). #86 R-CMWL DONE.
filed: 2026-05-30
priority: P1
type: bug-bundle
code: B-CMWL
composes:
  - "#86 R-CMWL — codex manager exits pickle at a fixed ~60-min wall; pipeline-runner treats clean-but-incomplete-but-progressing pickle as fatal, stranding the bundle"
source:
  - prds/archive/bug-reports/BUG-REPORT-2026-05-27-codex-manager-fixed-wall-pickle-stall.md
---

# B-CMWL — codex manager fixed-wall pickle stall

## Trigger

Finding #86 (R-CMWL): on the `codex` backend, every pickle-phase invocation runs ~60 min, completes ~3 tickets, then the manager exits `Session inactive` and `pipeline-runner` classifies "pickle exited clean but N/M tickets remain" as `phase_incomplete_tickets` and **stops the whole pipeline** instead of relaunching the manager. A 40-ticket codex bundle (incident session `2026-05-27-591247f9`) needed ~13 manual relaunches. The `claude` backend already relaunches at its 400-turn boundary via R-MMTR-3; the codex path lacks parity.

## Root cause (verified 2026-05-30 against the code)

Four compounding gaps, confirmed by code read:

1. **Codex "inactive" exit is not classified as relaunchable.** `classifyManagerRelaunchExit()` (`extension/src/bin/mux-runner.ts:2123-2137`) only maps codex to a relaunchable kind when `outcome.timedOut === true` (`codex_4h_hang_guard`). A `Session inactive` exit has `timedOut === false`, so it falls through to `other_error` and the manager is deactivated rather than relaunched. There is NO codex analogue of the claude `detectManagerMaxTurnsExit` path. `classifyIterationExit()` (`mux-runner.ts:2139-2157`) maps the string to `type: 'inactive'`, which deactivates.
2. **`pipeline-runner` treats progressing-but-incomplete pickle as fatal.** `maybeStampPhaseIncompleteTickets()` (`extension/src/bin/pipeline-runner.ts:2010-2040`) stamps `phase_incomplete_tickets` and returns `{action:'break'}` whenever `rawPhase==='pickle' && exitCode===0 && pendingCount>0` — with NO check for whether the pass made progress. The `break` halts the phase loop → exit code 3 → auto-resume stops.
3. **Interrupted-ticket partial work bricks the relaunch.** `assertCleanWorkingTree()` (`pipeline-runner.ts:1410-1420`, called at startup ~line 2230) throws on a dirty tree from the in-flight ticket, so even a correct relaunch fails until the tree is cleaned.
4. **No no-progress guard exists for the codex relaunch path.** The only `*_no_progress` pattern is the R-WMW worker-level `oversized_no_progress` (`FAILURE_REASONS`, `types/index.ts:297`). A manager-level codex no-progress halt is absent, so any relaunch parity must add a guard to avoid infinite relaunch.

The working claude analogue: `evaluateManagerRelaunch()` (`extension/src/services/manager-relaunch.ts:106-184`) gated by `CLAUDE_MANAGER_RELAUNCH_CAP=20`; `recordManagerRelaunch()` (lines 186-239) increments `state.manager_relaunch_count`. `CODEX_MANAGER_RELAUNCH_CAP=10` already exists (`types/index.ts:81`) but the codex exit never reaches the relaunch decision.

## Scope / version

- **Version: MINOR** (1.87.0 → 1.88.0): adds a new exit reason `codex_manager_no_progress`, a new activity event, and an optional no-progress-counter state field. **Schema-neutral** — the optional field is defaulted via the existing `normalizeV5StateDefaults` (no `LATEST_SCHEMA_VERSION` increment; old v5 state.json stays readable), so this does NOT touch the #74 schema-bump machinery.
- Parity-only: does NOT rework the claude R-MMTR-3 path (already correct) and does NOT change the codex CLI's own session limits (out of our control — we adapt by relaunching).

## Atomic tickets

### R-CMWL-1 (medium) — Classify codex "Session inactive" as a relaunchable exit (parity with claude max-turns)
- Add a `detectManagerInactiveExit(outcome)` helper and extend `classifyManagerRelaunchExit()` (`extension/src/bin/mux-runner.ts:2123-2137`): when `backend==='codex'`, `outcome.timedOut===false`, manager completed without error, and the iteration exit is `inactive` with tickets pending, return a new relaunchable kind `codex_session_inactive`.
- Add `'codex_session_inactive'` to the `ManagerRelaunchExitKind` union (`extension/src/services/manager-relaunch.ts:13-16`) and map it to `CODEX_MANAGER_RELAUNCH_CAP` in `managerRelaunchCapForExitKind()`/`managerRelaunchCapForBackend()` (lines 56-72).
- Ensure the codex `inactive` exit reaches `evaluateManagerRelaunch()` (the call site at `mux-runner.ts:3457-3475` / R-MMTR-3 respawn at `~3680-3730`) instead of deactivating, when relaunch criteria hold.
- Rebuild deployed `extension/bin/mux-runner.js` + `extension/services/manager-relaunch.js` (deploy parity).
- **AC:** an integration test with a stubbed codex manager that exits `Session inactive` after N turns with Todo tickets remaining and progress made asserts the runner RELAUNCHES (not deactivates) and `state.manager_relaunch_count` increments; a `manager_max_turns_relaunch`-class event is emitted; relaunch stops at `CODEX_MANAGER_RELAUNCH_CAP`.

### R-CMWL-2 (medium) — pipeline-runner: progressing-but-incomplete pickle is not fatal (R-CMWL H3)
- In `maybeStampPhaseIncompleteTickets()` (`extension/src/bin/pipeline-runner.ts:2010-2040`), do NOT stamp `phase_incomplete_tickets` / return `break` when the just-finished pickle pass made progress (≥1 newly-Done ticket OR ≥1 new commit/artifact this pass). Instead return null so the normal relaunch path (R-CMWL-1) continues the phase. Only stamp `phase_incomplete_tickets` (terminal) when the pass made ZERO progress (defer to R-CMWL-4's guard).
- Compute "progress this pass" from the ticket-status delta / commit count already available to the runtime (reuse the progress accounting `maybeStampPhaseIncompleteTickets` reads at line ~2033).
- Rebuild deployed `extension/bin/pipeline-runner.js`.
- **AC:** unit test on the post-phase classifier: pickle exit code 0 + pending>0 + progress>0 → returns null (no `phase_incomplete_tickets`, no break); pickle exit code 0 + pending>0 + progress==0 → stamps the terminal reason. No `phase_incomplete_tickets` emitted in the progressing case.

### R-CMWL-3 (medium) — Interrupted-ticket boundary: relaunch is not bricked by a dirty tree
- On a manager-boundary relaunch (`state.manager_relaunch_count > 0` or the codex_session_inactive path), handle the in-flight ticket's uncommitted partial work so `assertCleanWorkingTree()` (`pipeline-runner.ts:1410-1420`, startup call ~2230) does not throw: reset/stash the dirty in-flight ticket scope at the boundary so the next pass starts clean and re-attempts that ticket. Path-scoped to the current ticket — never a broad `git stash` of unrelated work; respect the Git Boundary Rules.
- **AC:** an integration test that leaves a dirty tree (partial in-flight ticket) at a relaunch boundary asserts the next pass starts clean (no `assertCleanWorkingTree` throw) and the interrupted ticket is retried; unrelated tracked changes are NOT discarded.

### R-CMWL-4 (medium) — No-progress guard + `codex_manager_no_progress` exit reason (R-CMWL desired-behavior #4)
- Track consecutive zero-progress codex relaunch passes in an optional state field (e.g. `state.codex_manager_consecutive_no_progress`), defaulted via `normalizeV5StateDefaults` in `extension/src/services/state-manager.ts` (schema-neutral, no version bump). Reset to 0 on any pass with progress.
- After 2 consecutive zero-progress passes, halt the codex relaunch loop with `exit_reason: 'codex_manager_no_progress'` instead of relaunching; emit a `codex_manager_no_progress` activity event.
- Register `'codex_manager_no_progress'` in `FAILURE_REASONS`/exit-reason validation (`extension/src/types/index.ts:297`) and in `VALID_ACTIVITY_EVENTS` + `EVENT_NAMES` + `activity-events.schema.json`.
- Rebuild deployed JS (`types/index.js`, `state-manager.js`, `mux-runner.js`).
- **AC:** integration test with a stubbed codex manager that makes zero progress for 2 consecutive passes asserts the loop halts with `exit_reason==='codex_manager_no_progress'` (not infinite relaunch); `codex_manager_no_progress` passes schema-conformance; a single zero-progress pass followed by a progressing pass does NOT halt (counter resets).

### R-CMWL-5 (medium) — Regression integration test for the full codex continuation path
- New `extension/tests/integration/codex-manager-fixed-wall-continuation.test.js` with a fake codex manager that exits `Session inactive` after N turns, completing 1 ticket per pass. Assert: the runner drains a >3-ticket queue to all-Done across ≥2 manager-session boundaries WITHOUT operator relaunch; the continuation trigger is turn/progress-based (assert NO hardcoded 3600s/60-min pickle cutoff governs it — relaunch gated on `tickets_remaining && progressed`); the dirty-tree boundary case (R-CMWL-3) and no-progress halt (R-CMWL-4) are exercised.
- Register the test in the appropriate tier manifest (`.serial-tests.json` if subprocess-heavy) and pass `audit-subprocess-heavy-tests.sh`.
- **AC:** the new test is green and registered; `audit-test-tiers.sh` + `audit-subprocess-heavy-tests.sh` exit 0.

### R-CMWL-6 (small) — Trap-door pin
- Pin the codex-continuation invariant in `extension/src/bin/CLAUDE.md` (codex `Session inactive` is a relaunchable exit gated by `CODEX_MANAGER_RELAUNCH_CAP`; progressing-incomplete pickle is non-fatal; interrupted-ticket work is reset at the boundary; 2 zero-progress passes → `codex_manager_no_progress`). ENFORCE: `codex-manager-fixed-wall-continuation.test.js`.
- **AC:** `bash scripts/audit-trap-door-enforcement.sh` passes with the new pin; the referenced ENFORCE test exists.

### C-CMWL-CLOSER [manager] — Ship B-CMWL
- Run the FULL release gate from `extension/` (tsc --noEmit, eslint --max-warnings=-1, tsc, all audit-*.sh, test:fast, test:integration, RUN_EXPENSIVE_TESTS=1 test:expensive). Confirm GREEN.
- Bump `extension/package.json` to **1.88.0** (MINOR — new exit reason + event + optional state field), commit `chore(C-CMWL-CLOSER): ship B-CMWL — bump 1.88.0 + repoint MASTER_PLAN`.
- `bash install.sh`, verify clean tree + deployed JS matches source, `git push`, `gh release create v1.88.0`.
- Mark MASTER_PLAN B-CMWL SHIPPED (drain-queue row removed, Status version updated), close finding #86.

## Acceptance (bundle-level)

- A codex pickle phase with >3 tickets' work drains to completion across ≥2 manager-session boundaries with no operator relaunch (R-CMWL-1, R-CMWL-5).
- Continuation is turn/progress-based, not a fixed wall clock (R-CMWL-5).
- `phase_incomplete_tickets` is not emitted when pickle exits clean, tickets remain, and the pass progressed (R-CMWL-2).
- Interrupted-ticket partial work does not brick the relaunch (R-CMWL-3).
- 2 consecutive zero-progress passes halt with `codex_manager_no_progress` (R-CMWL-4).
- Release gate green, clean tree, shipped through `gh release create` (C-CMWL-CLOSER).

## NOT in scope

- Changing the codex CLI's own session/wall limits (out of our control; we adapt by relaunching).
- Reworking the claude-side R-MMTR-3 relaunch (already correct; this is parity for codex).
- The double-launch race seen in incident pass 1 (separate operator-error class).

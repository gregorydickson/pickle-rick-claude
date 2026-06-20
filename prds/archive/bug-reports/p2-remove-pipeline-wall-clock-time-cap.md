---
status: draft
priority: P2
filed: 2026-05-05
slot: 1t
supersedes_residual: large-pipeline-time-budget-undersized.md AC-LPB-07
---

# PRD: Remove wall-clock time caps from pipelines

**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`

## Problem

`state.max_time_minutes` enforces a wall-clock cap on every long-running runner (mux-runner, microverse-runner, spawn-morty per-spawn clamp, stop-hook liveness probe). Default is 720 (12h). The cap was added as a runaway-protection guard back when iteration accounting was unreliable.

It is now the wrong primitive:

1. **Iteration caps already bound resource usage.** `max_iterations` (global, currently 500) and per-ticket tier ceilings (5/10/30/60) bound manager spawns. Worker spawns are bounded by `worker_timeout_seconds` (default 600s/spawn). Together these already cap cost.
2. **Wall-clock survives `--resume`.** `start_time_epoch` is preserved across resume launches (correct for forensics, wrong for budget). A bundle that crashes after 11h and gets resumed has 1h of runway, not 12h, with no operator-visible warning. Live repro 2026-05-05: bundle session `2026-05-04-f416c6cc` was 500min into a 720min budget at run #5 launch — would have killed the run with 48 tickets unshipped if the operator hadn't manually reset `start_time_epoch`. (See [`CONTEXT_2026-05-05.md`](../CONTEXT_2026-05-05.md) "Watchpoints during run #5".)
3. **The undersizing bug is structural, not parametric.** [`large-pipeline-time-budget-undersized.md`](large-pipeline-time-budget-undersized.md) shipped throughput-aware launch sizing (AC-LPB-01..06) but left AC-LPB-07 (manifest-aware default cleanup) as a follow-up. Picking the right default is a per-bundle problem the operator already solves by passing `--max-time`. The default itself is the trap.
4. **The cap is leaky on rate-limit waits.** `waitThroughRateLimit` clamps `actualWaitMs` against remaining budget — a 4h API reset window with 30min remaining budget exits as `limit` instead of waiting. The cap turns rate-limit recovery into pipeline death.
5. **No clean operator signal.** `exit_reason='limit'` is a clean-success terminal state per `extension/CLAUDE.md` mux-runner deactivation invariant. So a runaway-prevention guard reports as success, not failure. The 48 unshipped tickets look intentional in `pipeline-status.json`.

The operator's actual intent — "let it run until ticket queue empties or iteration cap trips" — is already expressible without the wall-clock cap.

## Proposal

Default-off the wall-clock cap; iteration caps + per-worker timeouts remain.

**Scope decision** (open for refinement): keep `state.max_time_minutes` as an opt-in field (`0` already means "no cap" at every enforcement site — see `mux-runner.ts:1911`, `:2625`, `:2876`; `microverse-runner.ts:1417`; `stop-hook.ts:134`, `:260`; `codex-manager-relaunch.ts:75`) and stop writing a default, OR delete the field entirely. The "default-off + opt-in" path is reversible, ships in fewer LOC, and respects operators who explicitly want a debug-run wall.

The infrastructure for "no cap" already exists. This PRD's work is:

- Stop setting a default at setup.
- Remove `--max-time` from the launch surface (or demote to advanced-only).
- Update enforcement-site comments + the `state.max_time_minutes` field invariant.
- Update monitor pane to drop the "X/Y min" wall-clock progress bar (display elapsed only; no remaining).
- Update `large-pipeline-time-budget-undersized.md` AC-LPB-07 status to "superseded by 1t" and remove its sizing-formula prescription from active queue.
- Tests: every assertion that "cap fires at N minutes" → assert "cap fires only when explicitly set" + add no-cap regression tests.
- Trap-door catalog: update the `mux-runner.ts (deactivation)` and state-field invariant entries to drop the `max_time_minutes limit` clean-success exit path.

## Requirements

### R-NTC-1 — Stop writing a default
- `pickle_settings.json` removes `default_max_time_minutes`.
- `setup.ts:270` (`applyPositiveIntegerSetting('default_max_time_minutes', ...)`) deleted.
- `setup.ts:691,697,847` no longer auto-fill `s.max_time_minutes` from config; the field stays absent on fresh sessions.
- `setup.ts:692-697` resume-warning ("WARNING: --resume found no persisted max_time_minutes") deleted.
- `--max-time <minutes>` CLI flag: option A — keep, only sets `state.max_time_minutes` when explicitly passed, no default. Option B — remove entirely (forces `node -e` for opt-in).

### R-NTC-2 — Documentation parity
- `extension/CLAUDE.md` `## state.json Field Invariants` entry for `max_time_minutes` changes from "positive integer wall-clock budget" → "optional non-negative integer wall-clock budget; absent or `0` disables the cap."
- `extension/CLAUDE.md` `mux-runner.ts (deactivation)` trap-door drops `max_time_minutes limit` from the clean-success exit list.
- README + persona/skill prompts no longer reference 12h default.

### R-NTC-3 — Rate-limit wait restored to full duration
- `mux-runner.ts:2876-2898` (waitThroughRateLimit) drops the `Math.min(actualWaitMs, remaining * 1000)` clamp when no cap is set. (When operator-set, clamp still honored — same as today.)
- New regression test: rate-limit wait of 4h with no cap completes the wait; with cap=120min completes at the cap minus elapsed.

### R-NTC-4 — Monitor display
- `monitor.ts:460` no longer renders an "X/Y min EXCEEDED" indicator when no cap is set; instead displays "elapsed: <human duration>" with no denominator.
- AC-LPB-06 (monitor EXCEEDED indicator) gates only when an explicit cap is set.

### R-NTC-5 — Spawn-side clamp removal
- `spawn-morty.ts:410` and `spawn-refinement-team.ts:780-781` (`clampTimeoutToSession`) no longer clamp per-worker timeout against remaining session budget when no session cap is set. Per-spawn `worker_timeout_seconds` is the only worker bound.

### R-NTC-6 — Stop-hook
- `stop-hook.ts:134, 260` time-elapsed check returns "within budget" when no cap is set (no-op).

### R-NTC-7 — Codex-manager-relaunch
- `codex-manager-relaunch.ts:75` time-cap eligibility check returns relaunch-eligible when no cap is set.

### R-NTC-8 — Test floor
- Existing tests asserting "cap fires at N minutes" updated to set the cap explicitly (preserve coverage for the opt-in path).
- New tests:
  - `mux-runner-no-time-cap.test.js` — runner runs past 1h+ with no `state.max_time_minutes`, no `limit` exit.
  - `microverse-runner-no-time-cap.test.js` — same for microverse loop.
  - `stop-hook-no-time-cap.test.js` — stop-hook returns approve regardless of elapsed when no cap.
  - `rate-limit-no-cap-honors-full-wait.test.js` — 4h wait completes uninterrupted.
- `state-field-invariants.test.js` updated to assert non-negative + optional, not positive.

### R-NTC-9 — Migration / forensics
- Existing sessions with `state.max_time_minutes > 0` continue to enforce the cap (no behavior change).
- New `R-NTC-LOG` activity event `time_cap_disabled_default` fired once per session at setup when no cap is configured (informational; helps differentiate "operator chose no cap" from "operator forgot --max-time").

### R-NTC-10 — Closer
- `extension/package.json` minor bump.
- `prds/archive/bundles/large-pipeline-time-budget-undersized.md` Status footer appended: `**AC-LPB-07 SUPERSEDED by p2-remove-pipeline-wall-clock-time-cap.md (slot 1t).**`
- MASTER_PLAN slot 1t row marked SHIPPED with commit refs.

## Acceptance Criteria

- **AC-NTC-01** — `grep -rn 'default_max_time_minutes' extension/src/ pickle_settings.json` returns zero matches.
- **AC-NTC-02** — Fresh `setup.js` invocation without `--max-time` produces a `state.json` with no `max_time_minutes` key.
- **AC-NTC-03** — Mux-runner started with no `state.max_time_minutes` runs for at least 60 minutes simulated wall-clock without emitting `exit_reason='limit'`.
- **AC-NTC-04** — Microverse-runner same.
- **AC-NTC-05** — Stop-hook returns approve at 13 simulated hours elapsed when no cap set.
- **AC-NTC-06** — Rate-limit wait of 4h completes uninterrupted when no cap set.
- **AC-NTC-07** — `state-field-invariants.test.js` asserts `max_time_minutes` is optional non-negative integer.
- **AC-NTC-08** — `extension/CLAUDE.md` `## state.json Field Invariants` entry for `max_time_minutes` and `mux-runner.ts (deactivation)` trap-door reflect the new contract.
- **AC-NTC-09** — `time_cap_disabled_default` activity event registered in `VALID_ACTIVITY_EVENTS` and emitted on fresh-session no-cap setup.
- **AC-NTC-10** — Existing test that asserts cap-fires-at-N-min preserved by explicitly setting `state.max_time_minutes` in test setup; coverage for opt-in path unchanged.
- **AC-NTC-11** — Resumed session with persisted `max_time_minutes > 0` still enforces (regression test resumes a session with cap=120min and asserts `limit` exit at 120min).
- **AC-NTC-12** — `prds/archive/bundles/large-pipeline-time-budget-undersized.md` AC-LPB-07 footer updated to SUPERSEDED.

## Open Questions (refine before implement)

1. **Drop `state.max_time_minutes` field entirely?** Greenfield discipline (per user CLAUDE.md feedback) says yes. But existing operators who use `--max-time` for short debug runs would lose that knob. Recommendation: keep the opt-in field; ship default-off only.
2. **Should `monitor.ts` show "no cap" vs "12h cap, 11h elapsed" differently?** Recommendation: when no cap, display only elapsed; when cap, current "elapsed/cap" rendering is fine.
3. **`codex-manager-relaunch.ts:75` — relaunch CAP via time check is the only no-cap escape valve from runaway codex-manager. Should we keep the cap-aware relaunch logic but feed it from `CODEX_MANAGER_RELAUNCH_CAP` only?** Recommendation: yes — drop the time check; iteration cap (`codex_manager_relaunch_count`) already bounds.
4. **Pipeline-runner phase-boundary check?** None today; phase ordering is sequential. Confirm in refinement.

## Refinement Hooks

- Cycle 1: validate the opt-in-vs-remove trade-off (Open Question #1).
- Cycle 2: enumerate every `state.max_time_minutes` read site and confirm the "no cap" branch already exists at each (currently confirmed: 9 sites all check `maxTimeMins > 0`; this PRD's only delta is the *default*).
- Cycle 3: stress-test with a synthetic 13h pipeline simulation (microverse-runner sim mode, no real spawns) to confirm no other latent time-based exit fires.

## Notes

- Live repro driving this PRD: bundle session `2026-05-04-f416c6cc` run #5, 2026-05-05 ~01:28 local. `start_time_epoch` was preserved from run #1 (2026-05-04 17:30 UTC); 500min elapsed against 720min cap at run #5 start would have killed the run ~3.7h later. Operator manually reset `start_time_epoch` — see CONTEXT_2026-05-05.md.
- Sister bug: `large-pipeline-time-budget-undersized.md` Bug 2 ("max_time_minutes enforcement is leaky — 161+ minutes past the wall, still running"). That bug was a leak in the *enforcement*; this PRD removes the enforcement target entirely as the cleaner fix.

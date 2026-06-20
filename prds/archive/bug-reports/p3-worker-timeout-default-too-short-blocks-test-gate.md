---
title: P3 — default worker_timeout_seconds (1200) too short to fit test:fast wait + artifact writes + commit; workers get killed mid-validation
status: Draft
filed: 2026-05-13
priority: P3
type: bug
finding: 34
r_codes:
  - R-WTB-1
  - R-WTB-2
  - R-WTB-3
  - R-WTB-4
related:
  - prds/archive/bug-reports/p1-per-ticket-worker-no-test-gate-cross-ticket-regressions.md   # R-PTG — the worker test gate that exposed this budget gap
  - prds/archive/bug-reports/p2-worker-manager-wedge-oversized-ticket-no-artifact-progress.md # R-WMW — adjacent: oversized tickets compound the budget pressure
---

# PRD — default worker_timeout_seconds is too short to complete the validated worker lifecycle (R-WTB)

**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Discovered**: 2026-05-13 during mega-bundle session `2026-05-13-c122b0f7` (codex backend), ticket `ecebb5d2` R-MMTR-1. Six worker spawns over ~80 min, all producing real R-MMTR-1 code (90 LOC across `mux-runner.ts/js` + 2 test files) but none completing the lifecycle. Worker log explicitly said *"The only blocker now is the package-wide fast suite finishing. Once that exits I'll write the conformance, review, and handoff artifacts in one pass and then cut the ticket commit."* Worker got killed at 1200s before test:fast finished + artifacts could be written.

## Problem (one paragraph)

The default `worker_timeout_seconds = 1200` (20 minutes) at `extension/src/types/index.ts:Defaults.WORKER_TIMEOUT_SECONDS` is **not large enough to complete the validated R-PTG worker lifecycle** for a typical bundle ticket. Realistic worker budget: ~5-8 min research/read, 2-4 min plan, 3-6 min implement, **3-5 min `npm run test:fast`** (the R-PTG gate), 1-2 min `npx eslint && npx tsc`, 1-2 min write `conformance_*.md` + `code_review_*.md` + `handoff_notes.md`, 30s `git commit`. **Total: 16-28 min** even for atomic ~50-150 LOC tickets. With 20 min budget the worker often runs out *while waiting for test:fast* — the test gate completes after the worker is killed, no artifacts written, manager re-spawns, work repeats. Bundle-level cost: at 4-6 wasted spawns per ticket × 58 tickets = ~16-24h of wasted compute and burned `claude_max_turns` budget.

## Observed incident

**Session**: `~/.local/share/pickle-rick/sessions/2026-05-13-c122b0f7/` (mega bundle 2026-05-13, ticket ecebb5d2 R-MMTR-1).

Six worker_session logs in ticket dir, all for the same ticket:
- `worker_session_40520.log` 970KB — ran full budget, killed
- `worker_session_54395.log` 788KB — ran full budget, killed
- `worker_session_29381.log` 670KB — ran full budget, killed
- `worker_session_98889.log` 144KB — earlier short spawn
- `worker_session_2841.log` 132KB — current, explicitly stuck on test:fast wait
- `worker_session_98408.log` 75KB, `worker_session_92115.log` 16KB

Dirty diff at investigation time: +90/-104 LOC across `extension/src/bin/mux-runner.ts`, `extension/bin/mux-runner.js`, `extension/tests/integration/mux-runner-claude-iteration-classifier.test.js`, `extension/tests/mux-runner-max-turns-detection.test.js`. All on-topic for R-MMTR-1. No `conformance_*.md` or `code_review_*.md` written.

Operator unblocked the run by bumping `state.worker_timeout_seconds: 1200 → 2400` mid-session.

## Solution (R-WTB-1..4)

- **R-WTB-1**: raise `Defaults.WORKER_TIMEOUT_SECONDS` from `1200` to `2400` at `extension/src/types/index.ts` and `extension/types/index.js`. Update `extension/CLAUDE.md` invariant entry under `worker_timeout_seconds` to document the new default + reasoning (test:fast budget + artifact writes + commit).
- **R-WTB-2**: per-tier overrides via `pickle_settings.json:tier_caps.<tier>.worker_timeout_seconds`. Suggested:
  - `small` (≤30 LOC, no test:fast file touch): 1200 (20 min — current default suffices)
  - `medium` (30-150 LOC, test:fast touches): 2400 (40 min — new default)
  - `large` (150-500 LOC, multiple test files): 3600 (60 min)
  - `xlarge` (≥500 LOC, refactors): 5400 (90 min)
  Implementation: extend `getTicketTierBudgetWithOverrides()` in `extension/src/services/pickle-utils.ts` to honor `worker_timeout_seconds` per tier (already does for `max_iterations`). Trap-door at R-CNAR-1 already documents the precedence — just add the field.
- **R-WTB-3**: regression test in `extension/tests/integration/worker-timeout-tier-budget.test.js` asserting (a) default is 2400, (b) `small` tier resolves to 1200, (c) `medium` resolves to 2400, (d) `large` resolves to 3600, (e) `xlarge` resolves to 5400, (f) `pickle_settings.tier_caps.<tier>.worker_timeout_seconds` overrides the compiled default, (g) `state.flags.tier_cap_override.<tier>.worker_timeout_seconds` overrides settings.
- **R-WTB-4**: trap-door pin under `extension/src/services/CLAUDE.md` documenting the timeout invariant and its interaction with the R-PTG worker test gate; ENFORCE references the new regression test.

## Acceptance criteria

- AC-R-WTB-01: deployed `Defaults.WORKER_TIMEOUT_SECONDS === 2400` after `bash install.sh`.
- AC-R-WTB-02: a fresh `setup.js --tmux --task "..."` session writes `worker_timeout_seconds: 2400` to `state.json` (unless `--worker-timeout <N>` is passed).
- AC-R-WTB-03: `getTicketTierBudgetWithOverrides(state, 'medium')` returns `worker_timeout_seconds: 2400` when no override is set.
- AC-R-WTB-04: existing test `extension/tests/state-field-invariants.test.js` invariant for `worker_timeout_seconds` still asserts "positive integer worker budget" (the type didn't change, only the default).
- AC-R-WTB-05: regression test covers all 4 tier defaults + 2 override layers (settings, flags).
- AC-R-WTB-06: trap-door entry in `extension/src/services/CLAUDE.md` for `worker_timeout_seconds` interaction with R-PTG gate.

## Entry conditions

- Independent fix; no upstream blockers.
- Pairs naturally with **R-WMW** (Finding #33 — worker-manager wedge safety net) since both address worker-lifecycle pathologies. Could ship in the same bundle.
- Does NOT block R-RSU (Finding #30) or R-CSI (Finding #25).

## Out of scope

- **Dynamic budget extension during worker run** (e.g., grant another 600s if test:fast is still running at 1500s mark). Worth investigating in a follow-up but adds complexity to the spawn-morty lifecycle and is not necessary for the common case.
- **Parallel test:fast pre-warm** (run test:fast in a background process before worker spawns so it's already-warm when the worker hits the gate). Possible future optimization.

## Risk

- **Manager iteration cap pressure**: longer worker budget means fewer manager iterations per wall-clock cap. Today's `claude_max_turns: 400` over ~90 min ≈ 4.4 turns/min. Worker budget bump to 40 min means each ticket consumes ~10 manager turns. For a 58-ticket bundle: ~580 manager turns. Still well under cap.
- **Stuck-worker tolerance**: a genuinely-wedged worker now ties up 40 min instead of 20. Mitigated by R-WMW Finding #33 (no-artifact-progress detection at K=3 spawns).

## Success definition

Mega bundle runs complete a ticket lifecycle in 1-2 spawns (research+plan+implement+test:fast+artifacts+commit all within one worker turn) at the new default. Worker-spawn-per-ticket median drops from current ~4-6 to ~1-2. Bundle wall-clock cost drops accordingly.

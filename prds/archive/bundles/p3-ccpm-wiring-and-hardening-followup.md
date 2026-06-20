---
title: P3 — R-CCPM wiring + 4 hardening tickets deferred from 2026-05-15 ship
status: Draft
filed: 2026-05-15
priority: P3
type: followup
r_code_prefix: R-CCPM-WH
backend_constraint: any
parent:
  - prds/archive/bundles/p1-codex-manager-prompt-pollution.md  # R-CCPM — substantive 5/5 implementation shipped; this PRD covers the 5 filler tickets
---

# R-CCPM-WH — R-CCPM wiring + hardening follow-up

## Why this exists

R-CCPM shipped its 5-ticket implementation tier on 2026-05-15 (commits `f915b821` / `690e5c5c` / `e955ce4d` / `39a660e4` / `73657d27` — see parent PRD). The R-CCPL bug class is now closed in HEAD. The original 10-ticket refined bundle also contained 1 end-to-end wiring ticket and 4 hardening tickets (code-quality, data-flow, test-quality, cross-reference); those were operator-stopped because they were filler relative to the queued backlog (R-GBK, R-MFW, R-FRA, R-CCDC).

This PRD parks the deferred tickets so they don't get lost. **None are load-bearing for the R-CCPL fix itself.** They ship opportunistically when the codebase regions they touch are open for another reason.

## Deferred tickets

- **R-CCPM-WH-1 (wiring)**: end-to-end smoke test exercising the four implementation tickets together. Spawn a codex manager subprocess against a synthetic skill prompt containing setup.js examples; assert (a) no actual setup.js execution occurs in the codex subprocess (R-CCPM-1 Role Framing + scrub), (b) any attempted setup.js Bash tool-call is observed and emits `codex_manager_self_bootstrap_attempted` (R-CCPM-2), (c) a colliding session-map write is rejected when the PID is alive (R-CCPM-4), (d) the parent's `orphans_detected` array surfaces any spawned-orphan within one iteration (R-CCPM-3), (e) the 3 new activity events from R-CCPM-5 fire correctly. Integration test, gated on `RUN_EXPENSIVE_TESTS=1` because it spawns real codex subprocesses.
- **R-CCPM-WH-2 (code-quality hardening)**: review the 5 shipped commits for code-style consistency with surrounding files; collapse helper duplication; ensure all new exports have JSDoc; verify error messages match the project's `[pickle-rick]` prefix convention. Touches `classifier-utils.ts`, `mux-runner.ts`, `setup.ts`, `state-manager.ts`, `types/index.ts`. Diff expected ≤ 100 LOC.
- **R-CCPM-WH-3 (data-flow hardening)**: audit the new State fields (`orphans_detected`, `parent_session_hash`, `invocation_source`) for read/write coverage. Verify every consumer reads through `StateManager.read()`, every writer goes through `StateManager.update()` (no raw `JSON.parse` paths). Add a `state-field-invariants.test.js` regression block for the 3 new fields. Closes the R-CSI-class consideration for the new schema v4 additions.
- **R-CCPM-WH-4 (test-quality hardening)**: review the 5 shipped commits for test-isolation hygiene per R-TSPF trap-doors (PATH serialization, fake-tmux timing, ENOENT race guards, wall-clock arithmetic). Specifically check the new tests for: (a) no fixed `setTimeout` budgets > 5s without env-overridable knobs, (b) no PATH mutations outside `withSerializedPath`, (c) no shared mutable state across `t.test` blocks. If any of the new tests flake under `--test-concurrency=8`, file under R-TSPF residual.
- **R-CCPM-WH-5 (cross-reference hardening)**: audit master plan + open findings for stale R-CCPL references that should redirect to R-CCPM closure; update Trap Door anchors in `extension/CLAUDE.md` / `extension/src/services/CLAUDE.md` / `extension/src/bin/CLAUDE.md` to reference R-CCPM-* commits where R-CCPL was previously cited; ensure no PRD points to research file `research-r-ccpl-7fe6da60-2026-05-15.md` as authoritative for current behavior (its findings are now reified in HEAD).

## Why P3

- No witnessed regression. The R-CCPL bug class is closed in HEAD. The 5 implementation tickets shipped with their own unit/integration coverage.
- Wiring is observability nice-to-have, not correctness gate.
- Hardening is rote consistency work; can be folded into the next bundle that touches the same files.
- The drift bug (R-CCPM-4) that motivated urgency on hardening is itself fixed in HEAD.

## Ship opportunistically

R-CCPM-WH-1 (wiring) is the highest-value remaining ticket — it's the only one that exercises the 5 implementation pieces as a system. Worth ~2h on the next quiet sprint window.

R-CCPM-WH-2/3/4/5 should fold into whichever bundle next touches `mux-runner.ts` / `state-manager.ts` / `setup.ts` / `classifier-utils.ts`. No standalone bundle needed.

## Non-goals

- No new behavior. R-CCPM-WH is purely additive tests + cosmetic cleanup.
- Not a regression-prevention bundle for R-CCPL. The R-CCPM trap doors already pin the invariants.
- Not a place to re-litigate R-CCPM scope. Anything beyond the 5 deferred tickets above belongs in a new PRD.

## References

- Parent PRD: `prds/archive/bundles/p1-codex-manager-prompt-pollution.md` — R-CCPM 5/5 shipped at the implementation tier; see its `## HEAD reconciliation` section for commit map.
- Master plan: 2026-05-15 status note for R-CCPM ship.
- R-CCPL successor closure: this PRD's parent retires Finding #1.

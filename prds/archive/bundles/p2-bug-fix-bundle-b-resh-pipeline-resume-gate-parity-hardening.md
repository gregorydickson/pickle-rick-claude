---
title: P2 Bug-Fix Bundle — B-RESH — pipeline resume & gate-parity hardening (#120 + #122 additive)
status: draft
priority: P2
filed: 2026-06-18
r_code_prefix: R-RESH
backend_constraint: any
findings: ["#120 R-ATPR", "#122 R-PRESUME (AC-1/2/3)"]
peer_prds:
  related:
    - prds/archive/bug-reports/BUG-REPORT-2026-06-17-audit-ticket-bundle-extension-relative-path-false-fatal.md
    - prds/archive/bug-reports/BUG-REPORT-2026-06-18-pipeline-unresumable-after-partial-completion.md
    - prds/archive/bundles/p1-bug-fix-bundle-b-wpex-auto-large-tier-detached-worker-poll.md
---

# B-RESH — pipeline resume & gate-parity hardening

Consolidates the genuinely-open, verify-first-confirmed findings from the B-WPEX-AUTO build + the 2026-06-18 unresumable-pipeline report. Every workstream REUSES an existing primitive — no new machinery (subtract-before-add). The reported P0 (large-tier punt) is already fixed (beta.14); this bundle is the residual gate-parity + operator-resilience hardening.

## Verify-first scope (what's IN, what's already handled)

**IN (real at HEAD beta.14):** W1 #120 (audit hallucinated-premise lacks the suffix-match the path-drift check has), W2 #122-AC1 (no false-completion guard before `finalizeTerminalState`), W3 #122-AC2 (`pickle-recover` can't fully un-terminalize), W4 #122-AC3 (wedge stats `state.json` mtime).

**OUT (verified already-handled / mooted — do NOT build):** #122-AC4 readiness same-epic forward-refs — `check-readiness` already has `buildBundleCreationIndex`/`isForwardCreated` (`check-readiness.ts:384,1013`); the gap is annotation completeness at refinement time, bypassable via `skip_quality_gates_reason`. #121 R-LTMC in-turn-build stall — mooted for large tickets by beta.14's detached path (`mux-runner.ts:9643` `spawnDetachedLargeTierWorker`); residual covered by W2. P4 template-warning — trivial, fold into W1's commit or skip.

## Workstreams / Acceptance Criteria

- [ ] **W1 — AC-R-RESH-1: hallucinated-premise reuses the R-RTRC-4 suffix resolver.** `audit-ticket-bundle.ts`'s `hallucinated-premise` check (`:555-561`) MUST resolve a cited `## Problem` path with the SAME suffix-symmetric `git ls-files` match the path-drift check already uses (`:402-413`, `(?:^|/)<ref>$`) before declaring it nonexistent — so a real extension-relative path (e.g. `src/lib/salvage-ticket.ts`, real at `extension/src/lib/salvage-ticket.ts`) does NOT fatal. Closes #120 R-ATPR. — Verify: fixture ticket whose `## Problem` cites a real extension-relative path audits clean; a genuinely fake path still fatals. — Type: test
- [ ] **W2 — AC-R-RESH-2: false-completion guard before terminal finalize.** Every `finalizeTerminalState({step:'completed'})` site in `mux-runner.ts` that represents EPIC/all-done completion (NOT `exit_reason:'limit'`/operator-cap paths) MUST first re-scan ticket frontmatter via `reconcileTicketTruth`; if any ticket is non-`Done`/`Skipped`, REFUSE to finalize `completed` and route through the existing recovery/relaunch path instead. Reuse `reconcileTicketTruth` (`lib/reconcile-ticket-truth.ts`); no new completion authority (preserve `completion-authority-single-source.test.js`). Closes #122-AC1; subsumes the #121 residual. — Verify: a session with ≥1 pending ticket cannot be finalized to `step:'completed'`; a genuinely all-Done session still finalizes. — Type: integration
- [ ] **W3 — AC-R-RESH-3: `pickle-recover --reactivate` un-terminalize primitive.** Extend `pickle-recover.ts` with a `reactivate` subcommand (or extend `--resume-from-todo`) that, when pending tickets exist, atomically sets `{active:true, step:'research', exit_reason:null}` and selects the lowest runnable Todo as `current_ticket` — the sanctioned un-terminalize (today it clears `current_ticket`/`exit_reason` only, `:167`, not `active`/`step`; `update-state.js` rejects `active`). Hook-safe via StateManager. Closes #122-AC2. — Verify: a `{active:false,step:'completed'}` session with pending tickets → after `--reactivate` is `{active:true,step:'research',current_ticket:<lowest Todo>}`; an all-Done session refuses (nothing to reactivate). — Type: integration
- [ ] **W4 — AC-R-RESH-4: wedge detector keys on iteration-log mtime (or heartbeat).** `pipeline-runner.ts` `child_mux_runner_wedge_detected` (`:821-862`/`:1092`) MUST base its staleness timer on the most-recent `tmux_iteration_*.log` mtime (written continuously by the worker) rather than `state.json` mtime alone (touched only at ticket boundaries), so a long single substantial ticket is not prematurely SIGTERM'd. Closes #122-AC3. — Verify: a session whose `state.json` is stale > `child_mux_runner_stall_seconds` but whose iteration log is fresh is NOT wedge-killed; a genuinely-frozen session (both stale) still trips. — Type: integration
- [ ] **AC-R-RESH-5: CATCH-22 + gate.** Every `mux-runner.ts`/`pipeline-runner.ts`/`audit-ticket-bundle.ts`/`pickle-recover.ts` edit compiles its `.js` mirror in the same commit; full gate green (tsc/eslint/test:fast:budget/test:integration). — Type: test

## Simplification Review (subtract-before-add)
1. **Necessary?** Yes — 4 verify-first-confirmed real defects; the other 2 reported items were verified already-handled and are explicitly OUT.
2. **Reuse not add?** Every workstream reuses an existing primitive: W1 the path-drift suffix resolver, W2 `reconcileTicketTruth`, W3 `pickle-recover`/StateManager, W4 the existing wedge timer (just re-points the mtime source). No new machinery.
3. **Guards brittle complexity?** W1 removes a false-positive (gate over-strictness → loosen, don't add a hatch); W2 the false-completion guard SUBTRACTS the sticky-terminal failure mode.
4. **Subtract?** W1 removes the `skip_quality_gates_reason` band-aid need for extension-relative-path bundles; W2 removes the sticky-terminal class; W3 removes the "no sanctioned un-terminalize → hand-edit state that reverts" dead-end.

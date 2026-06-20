# BUG REPORT 2026-06-17 — mux manager builds a large/complex ticket directly in-turn but STALLS/churns without committing (work done, not landed)

**Finding:** #121 R-LTMC (large-tier manager-turn completion gap). **Priority:** P2 (autonomy-friction — large tickets need babysitter salvage; no data loss because the work persists in the tree). **Class:** D2 wrong-signal-completion / work-not-landed (`feedback_pickle_rick_autonomy_north_star`). **Related (distinct from):** #108 R-WPEX (600s-ceiling *worker* silent-death) — this is a different layer.

## Observed behavior (B-WPEX-AUTO build, session `2026-06-17-ba399c8e`)

On the deployed runtime, for **large-tier** tickets the mux MANAGER built the ticket **directly in its own `claude -p` turn** (no `spawn-morty` worker spawned — `current_ticket_tier` stayed `null`, no `worker_session_*.log`, `routeLargeTierTicket` never fired). It produced **complete, gate-passing work** (edited `src/bin/mux-runner.ts` + recompiled the `bin/mux-runner.js` mirror + a new integration test), then **failed to commit it**:

- **T3 `7f1f69a1`** — work fully staged; manager **churned ~40 min on one iteration** (log growing the whole time, repeated gate cycling) without ever committing. Babysitter stopped the turn, verified (tsc clean / eslint 0 / new test 3/3 / mirror in sync), committed `1311ec44`, marked Done.
- **T4 `c6f44d6f`** — work complete in the tree (src + mirror + new test, unstaged); manager turn went **silent ~13 min** (iteration log mtime stale) with the work uncommitted. Babysitter salvaged identically → `2adc08c5`.

Medium/small tickets (T1, T2, T5, T6) on the SAME runtime **self-committed cleanly** — the gap is specific to large/complex tickets the manager builds in-turn.

## Why it matters

Every large-tier ticket in a bundle needs a manual babysitter salvage (stop turn → verify → commit → mark Done → relaunch). That is the exact "babysitter is load-bearing" autonomy gap the north-star targets — the pipeline does **genuinely good, gate-passing work** but the **completion/commit step is unreliable** for long in-turn builds. 2× recurrence in a single bundle; will recur on the 3 remaining large hardening tickets (H1/H2/H3).

## Hypotheses (need diagnosis — do NOT speculatively patch)

1. **Manager turn budget vs. in-turn gate.** The manager runs the worker gate (`test:fast`, ~5-6 min) inside its own turn; if it re-runs the gate (fix-retry loops) or hits the per-Bash-call 600s ceiling mid-gate, the turn churns/stalls before reaching the commit step. The completed work is never finalized because the turn never cleanly returns a completion signal.
2. **Completion keyed on the manager emitting a token/clean-return, not on tree truth.** The orchestrator's per-iteration completion accounting doesn't notice that the working tree already holds complete gate-passing work for `current_ticket`; it waits for the manager turn's signal, which never comes. (Ties to the D2 "completion keys on the wrong signal" thesis — `reconcileTicketTruth` exists but isn't consulted to auto-finalize a manager-built-but-uncommitted ticket.)
3. **Large tickets shouldn't be built in-turn at all.** If the manager built them via a (now-fixed, post-B-WPEX-AUTO) detached worker + poll, the commit would route through `salvageTicket` on the poll path. I.e. **B-WPEX-AUTO may itself reduce this** once shipped+installed — but that's unverified and the in-turn-build path still exists as a fallback.

## Acceptance criteria (diagnose first, then the smallest fix)

- [ ] **AC-R-LTMC-1 — repro + root-cause.** Reproduce a large/complex ticket built in-turn that stalls/churns without committing; identify which of the 3 hypotheses holds (manager-turn-budget vs. completion-signal vs. should-route-to-worker). One forensic write-up, no speculative patch.
- [ ] **AC-R-LTMC-2 — tree-truth auto-finalize at the seam (reuse, don't add).** If hypothesis 2: when an iteration ends (turn return OR max-turns relaunch boundary) with `current_ticket`'s in-scope tree **passing the ticket's gate**, the orchestrator auto-finalizes via the EXISTING `salvageTicket` `committed-done` disposition — never leaving complete gate-passing work uncommitted. No new completion path (enforced by `completion-authority-single-source.test.js`).
- [ ] **AC-R-LTMC-3 — regression.** A fixture where a manager turn produces gate-passing work then ends without committing → the next iteration auto-commits + marks Done (does NOT re-build, does NOT strand). — Type: integration

## Simplification Review (subtract-before-add)

1. **Necessary?** Yes — closes a 2×-recurring babysitter-salvage class for large tickets.
2. **Reuse not add?** YES — `salvageTicket` (committed-done disposition) + `reconcileTicketTruth` already exist (shipped, green); the fix is to CALL the tree-truth finalize at the iteration-end seam, not build a new committer.
3. **Guards brittle complexity?** The brittle thing is completion keyed on the manager's turn-return signal; subtract that dependency by reading tree truth instead.
4. **Subtract?** Removes ~N babysitter-salvage interventions per bundle; collapses "manager-built-but-uncommitted" into the same single completion oracle as every other path.

## Note

Discovered while babysitting the B-WPEX-AUTO build (which fixes the sibling large-tier *worker* gap, #108). Filed so the recovery becomes drainable work, not silent firefighting (`feedback_loop_failure_log_bug_prd_and_master_plan`). Consider draining AFTER B-WPEX-AUTO ships — its detached-worker path may make hypothesis 3 moot for the common case.

# BUG-REPORT 2026-06-27 — codex soak: worker quality-gate not enforced + anatomy-park guard-piling non-convergence

**Soak run:** B-PXBO on `--backend codex`, manager-decomposed from the raw PRD (refinement produced no
tickets — see §0), session `2026-06-27-a1dd8e8d`. Build ran pickle→citadel→anatomy-park hands-off.
**Outcome:** the build was **reverted** (no ship); main returned to `e107fab2` (beta.24). The B-PXBO
*design* (phase-exit reads the `readEvidence` oracle) is sound and preserved in
`prds/p2-bug-fix-bundle-b-pxbo-phase-exit-boundary-oracle-2026-06-26.md`; the codex *execution* was
broadly unreliable. These two findings are the soak's deliverable.

## Finding A (P1, HEADLINE) — codex worker quality gate not enforced

On `--backend codex`, the per-ticket worker gate (`runWorkerGate` in `spawn-morty.ts`: eslint + tsc +
`test:fast`) did **not** block commits. The 4 pickle tickets flipped `Done` with valid `completion_commit`s
over code that fails the release gate:

- **WS-1 (`3fda25a2`, R-DPGT):** added `boundaryDetachedWorkerIsLiveForTicket` with an unguarded
  `Number(detachedWorker.worker_pid)` → **eslint error** (`pickle/require-number-validation`). AND its
  `resetPerTicketBudgetCacheForRelaunch` / `withFreshTicketStatuses` relaunch change **broke 3 pre-existing
  tests** in `tests/mux-runner-codex-inactive-relaunch.test.js` (untouched by the bundle), failing
  **deterministically at `--test-concurrency=4`** (AC-A2: relaunch `pendingTickets` got 2, expected 1; and a
  `no relaunch when no pending tickets` case fails → may relaunch when it should not).
- **WS-3 (`094fc82c`, R-CRSR):** added `AC-CRSR-3` to `rrh-workstream-a.test.js` invoking a session-writing
  mux-runner helper **without `PICKLE_DATA_ROOT` sandbox** → **`audit-test-isolation` failure** (R-PTSB).
- **WS-4 (`22aa0cb7`, R-OMA):** over-restricted `readEvidence` — required an explicit `completion_commit`'s
  git message to attribution-match the ticket, **breaking the R-RIC-EXPLICIT "explicit SHA wins" invariant**
  (`has-completion-commit.test.js`) and the **R-CCQF anchor** (`trap-door-completion-evidence-conformance.test.js`),
  and pushing `readEvidence` cyclomatic complexity 13→19 (lint error).

**Net: 2 of 4 workstreams shipped real defects; the worker gate caught none.** This is the **R-DOTR class
(Done-over-red) recurring at the worker-gate level** — the very class B-PXBO exists to fix, manifest on codex
during B-PXBO's own build.

**Likely root cause (to investigate):** the worker `test:fast` gate timing out and passing-through
(`project_afcc_deep_closer_masked_fast_tier_failures` precedent), OR codex workers not routing through
`runWorkerGate`'s eslint/test enforcement the way claude workers do. **`runWorkerGate` enforcement on the
codex backend is the thing to audit/fix.** Until then, **do not trust a codex worker `Done` as gate-green** —
run the full local gate before believing any codex build.

**Fix direction (reuse-first):** make `runWorkerGate` fail-closed on the codex path — a gate timeout or a
non-zero eslint/tsc/test result must block the completion-commit, not pass through. No new gate; close the
enforcement gap on the existing one.

## Finding B (P2) — anatomy-park guard-piling non-convergence on codex

After pickle+citadel, anatomy-park (codex) made **27 commits** to `ticket-completion-evidence.ts`, piling a
guard per "stale completion-evidence replay" variant (pre-session, post-skip, post-rate-limit, reconstruction,
resume-time…) — driving `readEvidence` cyclomatic complexity **13 → 31** (2× the eslint limit) and **never
converging** (`extension` subsystem: 14+ passes, `consecutive_clean` stuck at 0, `stall_counts` 0 because each
pass "progresses" by committing a new guard). This is the **add-don't-subtract / guards-on-guards** anti-pattern
the project's own governance fights, executed by the review phase itself, complexity-blind.

**Fix direction:** anatomy-park needs a **convergence/complexity guard** — a subsystem that has run N passes
without reaching `consecutive_clean ≥ 1`, or whose fixes raise a lint-complexity metric, should halt-and-report
(non-convergent) rather than grind to the iteration cap; and a **subtract-pass discipline** (collapse the Nth
same-theme guard into one uniform check instead of adding the N+1th). Stall detection that counts "committed a
fix" as progress cannot see oscillation/guard-piling — it needs a complexity/theme-repeat signal.

## Process notes (not bugs, for the rebuild)

- §0 **Refinement produced no tickets on this run:** `spawn-refinement-team.js` ran the analysts (3×3, good
  analyses) but exited 2 on FALSE-POSITIVE gates (an AC-id `AC-DPGT-1` mis-parsed as a code symbol; analyst
  paths cited as `tests/…` vs `extension/tests/…`). Synthesis + decomposition are skill-level steps the bare
  script doesn't run, so the build went manager-decomposed. (Separate, lower-priority: the symbol-audit
  should not treat `AC-*` ids as code symbols; the analyst path-verifier should accept the `extension/`-prefix
  equivalence.)
- The "workspace not trusted" warning in worker logs is **benign** (all spawns pass
  `--dangerously-skip-permissions`) — see `project_trust_warning_benign_refine_bg_reaped`.

## Recommendation

Rebuild B-PXBO on **claude** (whose worker gate is enforced), OR land Finding A's `runWorkerGate` codex
fix first and re-soak codex. The B-PXBO PRD is unchanged and ready.

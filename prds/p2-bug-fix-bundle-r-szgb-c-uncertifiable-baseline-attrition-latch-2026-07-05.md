# P2 Bug-Fix Bundle — R-SZGB-C: the uncertifiable-baseline defer does not arm the attrition latch

**Priority:** P2 (quality-gate integrity fast-follow — completes R-SZGB-B. Without it, the exact
fail-OPEN defect R-SZGB-B closes for the single/few-iteration case re-opens at iteration 3+ via the
post-convergence deferral cap.)
**Code:** R-SZGB-C (Szechuan Gate Blind spot, attrition-cap residual)
**Backend:** claude (repairs the review-phase gate-decision seam; codex is irrelevant to the mechanism).
**Build-safety note:** **Pipeline-safe — the salvage / completion-evidence / Done-flip path is NOT
touched, so the R-PSRB hand-build protocol does NOT apply.** The edit lives in the gate-decision seam
of `extension/src/bin/microverse-runner.ts` (`handleWorkerManagedIteration` return contract +
`runPerIterationGateHook` signal-threading). Same self-referential-review caveat as R-SZGB-B: if built
via `/pickle-pipeline`, this build's own review phases run the DEPLOYED gate against the repo root, so
they cannot self-validate the fix until `install.sh` deploys — but the closer's full gate is the
authoritative backstop. Build → deploy → prove.
**Complexity tier:** WS-1 `complexity_tier: medium` (edits the core convergence-decision seam and must
run `test:fast` at the worker gate — a gate-decision fix under `small` would SKIP `test:fast`).

---

## Context

R-SZGB-B (shipped `cceef8b4`, session `2026-07-05-5865291f`) made the per-iteration convergence gate
fail-CLOSED when the baseline is uncertifiable (`project_type: null` / zero captured checks): a single
worker-signaled-convergence iteration against such a target now DEFERS instead of returning
`converged`. Its own code review (`93ea5281/code_review_2026-07-05.md`) surfaced a residual the ticket
explicitly scoped out:

**Mechanism (verified against source at `cceef8b4`):**

1. `handlePostConvergenceGateDeferral` (`microverse-runner.ts:~3657-3714`) caps consecutive deferrals
   at `POST_CONVERGENCE_GATE_DEFERRAL_LIMIT = 3`. At the cap it re-runs a **fresh** gate
   (`mode:'strict', scope:'full', checks:['typecheck','lint']`, no `baselinePath`) and, unless that
   fresh gate is RED, trusts the worker: `return 'converged'`.
2. But the fresh re-run resolves project type deterministically on the same `workingDir`. If the target
   was uncertifiable at baseline-capture time, the cap re-run is **also** uncertifiable and **also**
   returns green via `emitSkippedAndReturn` (the `mode==='baseline'` check only gates whether an empty
   baseline file is *written*, not the green/no-failures return value).
3. So after exactly 3 consecutive worker-signaled-`converged:true` iterations against the same
   uncertifiable target, the cap mechanism **falsely converges the tsc-RED tree** — reproducing the
   exact defect R-SZGB-B exists to close, delayed by 3 iterations instead of 1.
4. This is not hypothetical: the original repro (`d30bab01`, session `2026-07-02-b3c45331`) converged at
   "held: 3 vs 3" — the same order of magnitude as the cap.

**The codebase already has the right primitive.** `selfRedOpen` / `ctx.postConvergenceSelfRedOpen`
(wired for the R-ORSR-6 interface-change-sweep class, `microverse-runner.ts:3664-3676`) implements
exactly *"a phase that turned the whole-repo gate red can NEVER be force-converged by attrition."* The
uncertifiable-baseline defer path added by R-SZGB-B does **not** set `selfRedOpen: true` on its return
value, so that latch never arms for this class.

**Why it is not a one-liner.** The local `iterationLeftRegression` branch in
`handleWorkerManagedIteration` (`:1173-1184`) cannot safely re-derive "was this defer caused by an
uncertifiable baseline" after the fact: by the time it sees the regression it no longer knows which
`gateMode` produced it this iteration, and re-reading `gate/baseline.json` at that point risks a false
positive if a `strict`-mode regression coincides with a stale on-disk `project_type: null` baseline from
a prior iteration. The signal must be threaded from the defer site (inside the gate hook) up through
`runPerIterationGateHook` into `handleWorkerManagedIteration`'s return contract.

**Mitigating factor (why P2, not P1).** WS-1 of R-SZGB (R-SZGB-A, package-root resolution, `e284c7ca`)
makes the pickle-rick repo-root target itself resolve *certifiable* (it walks down to `extension/`), so
in practice this residual only bites genuinely toolchain-less or ambiguous-monorepo targets that STAY
uncertifiable across ≥3 iterations. But a fail-OPEN certification path we have documented as leaking
must be closed before the gate is trusted as a soak-rep oracle.

---

## WS-1 — R-SZGB-C-A: arm the attrition latch on the uncertifiable-baseline defer

### Problem
The uncertifiable-baseline defer (R-SZGB-B) returns `{ converged: false, ... }` WITHOUT `selfRedOpen:
true`, so `handlePostConvergenceGateDeferral`'s existing "never force-converge by attrition" latch
(`ctx.postConvergenceSelfRedOpen`) does not engage. At the deferral cap the worker is trusted and the
tsc-RED tree converges.

### Fix
Thread an **uncertifiable-baseline** signal from the gate-defer site up to
`handleWorkerManagedIteration`'s return contract so its defer return carries `selfRedOpen: true`,
arming the existing `postConvergenceSelfRedOpen` latch:

- At the uncertifiable-baseline defer site (the seam R-SZGB-B added inside the per-iteration gate
  hook / `runChangedPerIterationGate`), surface a boolean/typed signal (e.g. an
  `uncertifiableBaselineDefer` field on the gate-hook result, or a dedicated returned reason enum)
  distinct from a genuine `strict`-mode regression. Do NOT re-read `gate/baseline.json` in the
  consumer to re-derive it — the producer knows the `gateMode`, the consumer does not.
- `runPerIterationGateHook` propagates that signal to `handleWorkerManagedIteration`.
- `handleWorkerManagedIteration`'s defer return sets `selfRedOpen: true` when (and only when) the defer
  was caused by an uncertifiable baseline. A genuine `strict`-mode regression keeps its existing
  return shape.
- **REUSE the existing latch** — `ctx.postConvergenceSelfRedOpen` at `:3664-3676` already blocks
  force-convergence when any prior iteration returned `selfRedOpen: true`. Add NO new state field,
  flag, gate, or activity event. Log `gate: uncertifiable baseline defer — arming no-attrition latch
  (cannot force-converge)` for observability (log line only).

Constraints:
- No new state field / flag / skip surface / activity event — reuse `selfRedOpen` +
  `postConvergenceSelfRedOpen`, the R-ORSR-6 primitive.
- The genuine `strict`-mode regression path is UNCHANGED (it does not set `selfRedOpen` unless it
  already did for the R-ORSR-6 sweep). Only the uncertifiable-baseline defer newly arms the latch.
- A certifiable target (WS-1-R-SZGB resolves a project, or a direct-target package) never reaches this
  branch — no healthy-path regression.

### Acceptance criteria (machine-checkable)
- **AC-SZGBC-01 (headline attrition repro):** New test proves that a szechuan/microverse worker that
  signals `converged: true` for **3 consecutive iterations** against a target whose gate baseline is
  `project_type: null`, with a tsc-RED tree, **cannot force-converge at the deferral cap** — the run
  blocks/defers (the `postConvergenceSelfRedOpen` latch is armed) instead of returning `converged`.
  Exercises `handlePostConvergenceGateDeferral` at `deferralCount >= POST_CONVERGENCE_GATE_DEFERRAL_LIMIT`.
- **AC-SZGBC-02 (latch source):** The test asserts the block originates from `selfRedOpen: true` on the
  uncertifiable-baseline defer return (grep/assert the return shape), NOT from a fresh-gate RED result —
  proving the fix engages even when the cap re-run's fresh gate would itself skip green.
- **AC-SZGBC-03 (regression guard — genuine strict regression unchanged):** A `strict`-mode gate
  regression (real tsc failure on a *certifiable* target) still defers/blocks exactly as before; its
  return shape is unchanged by this diff (no spurious `selfRedOpen` unless R-ORSR-6 already set it).
- **AC-SZGBC-04 (regression guard — healthy path):** A certifiable baseline (non-null `project_type`,
  clean tree) still converges normally at or before the cap — the latch does not over-block the healthy
  path.
- **AC-SZGBC-05 (no new surface):** `git diff` adds no new state field, flag, skip surface, or activity
  event — the decision keys on existing `selfRedOpen` / `postConvergenceSelfRedOpen` (grep-asserted in
  the test or via `audit-*` parity; a log line is the only new observability).

---

## Simplification Review (subtract-before-add) — REQUIRED

### WS-1 (arm the attrition latch on uncertifiable-baseline defer)
1. **Necessary?** Yes — it is the load-bearing completion of R-SZGB-B's fail-closed invariant. Without
   it the fail-OPEN certification path re-opens at iteration 3+. Adds no new field/flag/gate/event —
   only threads an existing-style signal and reuses the R-ORSR-6 latch.
2. **Reuse over add?** Yes — reuses `selfRedOpen` + `ctx.postConvergenceSelfRedOpen` (the R-ORSR-6
   interface-change-sweep primitive that already means exactly "never force-converge by attrition").
   No parallel latch, no second baseline, no new enum surface beyond the internal defer-cause signal.
3. **Guards existing brittle complexity?** It repairs an incompleteness in R-SZGB-B's own fail-closed
   path (the defer didn't arm the latch) rather than wrapping a guard around a guard — it makes one
   existing invariant (`postConvergenceSelfRedOpen`) reach a case it structurally should have.
4. **Subtracts?** Removes the remaining fail-OPEN certification path — a strictly smaller set of trees
   can be declared converged. Net: after this bundle there is NO iteration count at which an
   uncertifiable baseline can certify a tsc-RED tree.

**Bundle-level subtraction:** with R-SZGB-B (single/few-iteration) + R-SZGB-C (attrition cap), the
"uncertifiable baseline eventually certifies green" behavior is deleted at every iteration count. The
gate either resolves and runs (R-SZGB-A) or refuses to certify — permanently.

---

## Bundle thesis

**Finish the fail-closed invariant: an uncertifiable baseline must arm the existing no-attrition latch
so it cannot be force-converged at the deferral cap either.** One defect (R-SZGB-B's defer didn't set
`selfRedOpen`), one edit threading the signal to the return contract, reuse-first via the R-ORSR-6
`postConvergenceSelfRedOpen` primitive, no new gate/flag/state field/event.

## Out of scope
- R-SZGB-A / R-SZGB-B themselves (shipped `e284c7ca` / `cceef8b4`) — unchanged.
- The R-ORSR-6 interface-change-sweep behavior (reused as-is, not modified).
- The closer's full release gate (unchanged — authoritative backstop).
- The LLM principle-metric convergence judge (orthogonal).

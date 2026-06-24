---
title: "B-RPGT — Review-phase typecheck gate + transient-529 park (refined)"
priority: P2
status: refined
source_reports:
  - prds/BUG-REPORT-2026-06-22-codex-backend-completion-evidence-fatal-and-cross-iteration-work-corruption.md
governing_strategy: prds/RELIABILITY-PLAN-2026-06-23.md
head_verified_at: 5bd5d8b5
refined: 2026-06-23 (3-cycle analyst team — requirements · codebase · risk-scope)
---

# B-RPGT — Review-phase typecheck gate + transient-529 park (refined)

**One sentence.** The review/cleanup phases (anatomy-park · szechuan-sauce) can ship a `tsc`/`eslint`-RED
tree, and a transient `529 Overloaded` during the judge metric measurement fatally aborts a multi-hour
pipeline — both are fixed by **retargeting / wiring mechanisms that already exist** onto the paths that
currently skip them.

This bundle closes the **R-CECX run-3 follow-up #2** facets: **R-RPGT** (facets 4 + 6, review/cleanup
phases commit build-RED code) and **R-S529** (facet 5, transient 529 aborts the pipeline).

---

## Refinement corrections (cycles 1–3 — these SUPERSEDE the original draft)

The 3-cycle analyst team re-ground-truthed every symbol at HEAD `5bd5d8b5` and corrected the original
draft on five load-bearing points. **Read these first — the tickets implement the corrected version.**

1. **WS-2 root cause was mis-targeted.** The original named `mapBaselineMeasureExitReason`
   (`microverse-runner.ts:2746`) — that function is **DEAD CODE (zero callers at HEAD)** and is in the
   Module Export Catalog (do **NOT** edit, do **NOT** delete it in this bundle). The live mapper is
   **`mapJudgeMeasurementFailure` (`microverse-runner.ts:2761`)**, shared by `measureLlmBaseline`
   (`:2910`) and `measureLlmIteration` (`:3180`) — so adding the transient producer there covers
   **baseline AND per-iteration** 529s for free (R-MBLE-8).

2. **WS-1's convergence path is shipped-but-DEFECTIVE, not "mostly shipped."** `runPerIterationGateHook`
   already runs `['typecheck','lint','tests']` (`microverse-runner.ts:413`) and defers RED convergence —
   **but bounded at `POST_CONVERGENCE_GATE_DEFERRAL_LIMIT = 3` (`:415`)**, and at the cap the terminal
   branch does **`return 'converged'` over a still-RED tree** (`:3544-3549`, "convergence signal trusted").
   That is the exact silent-RED-commit the bundle exists to kill. WS-1 must **change R-APXG-3's terminal
   action**: RED-at-cap → non-zero exit + `tsc_gate_failed`, distinguished from the original R-APXG-3 case
   (a flaky gate the worker legitimately resolved) by re-running the gate at the cap and branching on its
   result. This is a real correctness fix, not just "wire the gate."

3. **The genuine new WS-1 surface is the ABORT path + the R-APXG-3 reconciliation.** AC-RPGT-3
   (finalize-gate runs typecheck+lint) is **ALREADY SHIPPED** at `finalize-gate.ts:296-300` →
   REGRESSION-TEST-ONLY. The convergence-exit gate is shipped (modulo the R-APXG-3 defect). Presenting
   them as fresh impl work inflates the bundle 2–4×; they become regression rows in the consolidated test.

4. **WS-2 routing is a TWO-function edit whose predicates DISAGREE at HEAD.** The original's "already
   routes … no new router" is **false**. For `baseline_unmeasurable_transient` today:
   `isFatalPhaseFailure` (`pipeline-runner.ts:2536`) falls through to `return false` (phase silently
   continues via `recordRecoverablePhaseFailure`), while `classifyMicroverseHaltDecision` (`:3663`) falls
   through to `{action:'abort'}`. **Both** must recognize the reason, mirroring shipped `judge_timeout`
   (R-PRJT-2); `classifyMicroverseHaltDecision` returns the exact literal **`run-finalize-gate-incomplete`**
   (measurement was unmeasurable). The dispatcher at `pipeline-runner.ts:3459-3470` already handles both
   finalize actions → no new dispatch branch.

5. **Reuse the existing `tsc_gate_failed` event** (`types/index.ts:704`, already in
   `VALID_ACTIVITY_EVENTS`) for the WS-1 gate-failure observable — zero registration, zero count-guard
   churn, and it passes the refinement activity-event validator. (A new `review_phase_gate_failed` would
   require a 7-touchpoint registration fan-out — avoided.)

Also corrected: the original §1.1 facet-4 causal chain is **phase-order-wrong** (order is pickle →
citadel → anatomy-park → szechuan-sauce; a szechuan abort cannot retro-un-gate an earlier anatomy
commit). The real lesson is that anatomy-park's **own** abort gate didn't fire — which is exactly why
**AC-RPGT-4 (abort-path gate) is the load-bearing WS-1 delta.**

---

## Acceptance criteria (amended — machine-checkable)

**R-RPGT (WS-1)**
- **AC-RPGT-1** — On a RED committed tree, the convergence-exit path does not exit converged and emits
  `tsc_gate_failed`. **Crucially, this holds AT the R-APXG-3 deferral cap** (3 consecutive RED
  deferrals): the terminal action becomes non-zero + `tsc_gate_failed`, NOT `return 'converged'`.
- **AC-RPGT-3** — `finalize-gate.js` runs typecheck+lint. **REGRESSION-TEST-ONLY** (shipped at
  `finalize-gate.ts:300`).
- **AC-RPGT-4** — The abort-branch exit on a RED tree emits `tsc_gate_failed` and returns non-zero; it
  does not advance/finalize. **(The genuine new wiring.)**
- **AC-RPGT-5 (negative control — #1 omission of the draft)** — A converged iteration whose tree is
  `tsc --noEmit`-clean AND `eslint --max-warnings=-1`-clean exits converged exactly as today and emits
  **no** gate-failure event, across all three exit paths. Proves the gate does not false-block green
  convergence (a gate that bricks green convergence is *strictly worse* than the bug).
- **AC-RPGT-6** — The abort-path gate is best-effort and **network-free** (tsc/eslint local subprocesses
  only): a gate spawn error/throw/timeout never masks the original abort reason (original wins; gate
  result is additive). Recommend the abort-path gate runs a **typecheck+lint subset** of `runGate`, not
  the full `tests` portion (avoids re-introducing flake-as-blocker and keeps it network-free).
- **AC-RPGT-7** — Consecutive RED-tree deferrals are bounded (the existing cap N=3); on exhaustion the
  phase exits non-zero with `tsc_gate_failed` rather than deferring to `max_iterations`. (This IS the
  R-APXG-3 reconciliation; folds with AC-RPGT-1.)
- **AC-RPGT-2** — The gate **reuses** the existing `runGate` typecheck+lint runner; **no new**
  `tsc`/`eslint` subprocess callsite (`spawnSync`/`execFileSync`/`exec`/`spawn`) is added in the
  review-phase paths. Grep guard scoped to the review-phase call sites (convergence-gate.ts's own
  `execFileSync` for git is exempt).
- **AC-RPGT-CIT** — Regression: citadel still does NOT run tsc/eslint (scope-out guard against creep).

**R-S529 (WS-2)**
- **AC-S529-1** — `classifyJudgeError` returns the exact literal `{ failureKind: 'rate_limited' }` (a NEW
  member of the `ClassifiedJudgeError` union) for **both** `'API Error: 529 Overloaded …'` and
  `'API Error: 429 …'`; returns neither `'unknown'` nor `'spawn_failed'`. Inserted between the ETIMEDOUT
  return (`:1872`) and the `unknown` fallback (`:1873`) per trap door R-SJET-1b.
- **AC-S529-2** — A measurement whose every attempt is 529 maps via the **live** `mapJudgeMeasurementFailure`
  (`:2761`) to `baseline_unmeasurable_transient` [NEW-WORK: the producer branch], never
  `baseline_unmeasurable_unrecoverable`, on **both** `measureLlmBaseline` (`:2910`) and
  `measureLlmIteration` (`:3180`). Assert `isMicroverseFailureExit('baseline_unmeasurable_transient')
  === false` [REGRESSION-PIN: already green — transient absent from `MICROVERSE_FAILURE_REASONS`].
- **AC-S529-4** — `baseline_unmeasurable_transient` is routed by **both** predicates: (a)
  `isFatalPhaseFailure` (`:2536`) returns halt-eligible; (b) `classifyMicroverseHaltDecision` (`:3663`)
  returns the exact literal `{ action: 'run-finalize-gate-incomplete' }`. End-to-end `logPhaseHaltReason`
  runs finalize-gate; the pipeline does **not** fatally abort. No new dispatch branch.
- **AC-S529-3** — A 529-then-recovery sequence parks-and-retries via the existing B-RRH park
  (`computeRateLimitAction` / `max_park_minutes`), wired into the judge backoff loop
  (`measureLlmMetricWithBackoff`); the measurement **succeeds after the park** and the phase continues.
- **AC-S529-6 (boundary — NEW)** — The 529 park is bounded by a **metric-path ceiling**. The B-RRH
  default is `DEFAULT_MAX_PARK_MINUTES = 360` (six hours, `pickle-utils.ts:825`) — too long for a single
  mid-pipeline measurement. Decide and document: a tighter metric-specific bound (recommended) vs an
  explicit inherit-the-6h decision with operator rationale. Reaching the ceiling maps to
  `baseline_unmeasurable_transient` (chains AC-S529-2/4).
- **AC-S529-7 (observability — NEW)** — While parked on a 529, an operator-visible "parking, not hung"
  state/event surfaces (reuse the existing `rate_limit_wait`-class signal where possible) so a babysitter
  does not misread the park as a hung pipeline.

**Bundle**
- **AC-RPGT-GATE** — Full local gate green (tsc + eslint + 11 audits + test:fast:budget +
  test:integration + `RUN_EXPENSIVE_TESTS=1` test:expensive).
- **AC-RPGT-TRAP** — Each new invariant ships with an enforcing test + a `CLAUDE.md` trap-door entry.

---

## Critical User Journeys (operator = user)

- **CUJ-1 (RED review commit):** anatomy-park/szechuan produces a `tsc`-RED commit → the exit gate
  (convergence-exit, abort, or at the R-APXG-3 cap) refuses to complete → operator sees `tsc_gate_failed`
  + non-zero exit + **no silent advance**. A clean tree still converges with zero gate-failure events.
- **CUJ-2 (529 burst, baseline):** a 529 storm hits the baseline metric measurement → the park engages
  with an operator-visible "parking, not hung" state → API recovers → measurement succeeds → pipeline
  runs to completion at **3/3** (vs the prior fatal abort at 2/3). If the metric-path ceiling is
  exhausted, the phase maps to `baseline_unmeasurable_transient` → finalize-gate-incomplete → no fatal
  abort.
- **CUJ-2b (529 mid-iteration):** the same fix via the shared `mapJudgeMeasurementFailure` covers a 529
  during a per-iteration measurement (different trigger, same recovery).

---

## Simplification Review (subtract-before-add — preserved + sharpened by refinement)

**WS-1 (R-RPGT)** — REUSE the existing `runGate` typecheck+lint runner and the existing `tsc_gate_failed`
event. The honest fix is *closing a gap* (abort path skips the gate) and *correcting a defect* (R-APXG-3
force-exits converged over RED) — not adding a new gate. **Subtraction:** the R-APXG-3 terminal
`return 'converged'`-over-RED path is removed; the silent-RED-commit class is deleted on all three exit
paths. No new event, no new skip flag (the only sanctioned bypass is the existing unified
`skip_quality_gates_reason`).

**WS-2 (R-S529)** — REUSE ×3: the already-declared `baseline_unmeasurable_transient` exit reason, the
already-imported B-RRH park, and the already-shipped R-PRJT-2 finalize-gate dispatcher. **Subtraction:**
removes a fatal-abort path — `classifyJudgeError`'s `unknown` default no longer over-maps a transient 529
to fatal `baseline_unmeasurable_unrecoverable`; the case folds into the existing transient/park lane. One
fatal failure mode deleted. The park ceiling (AC-S529-6) *bounds* an existing mechanism rather than
adding a parallel one.

---

## Implementation Task Breakdown

| Order | ID | Title | Tier | Entry | Exit | Files |
|---|---|---|---|---|---|---|
| 10 | 6ae43cee | WS-2: classify 529/429 → transient, map via live mapper, route both predicates | medium | HEAD clean | 529 → `baseline_unmeasurable_transient` → finalize-gate-incomplete, never fatal | `microverse-runner.ts`, `pipeline-runner.ts`, `+test` |
| 20 | f1b12c7b | WS-2: park-and-retry the judge metric path on 529, bounded ceiling + observable state | medium | T10 done | 529-then-recovery parks then succeeds; ceiling bounded; "parking" observable | `microverse-runner.ts`, `pickle-utils.ts?`, `+test` |
| 30 | b5d9dc2a | WS-1: abort-path gate + reconcile R-APXG-3 terminal action (RED-at-cap → fail) | medium | HEAD clean | abort/cap exits over RED emit `tsc_gate_failed` + non-zero; network-free; cap-bounded | `microverse-runner.ts`, `pipeline-runner.ts` |
| 40 | 8af2200c | WS-1: consolidated `describe.each` exit-path test + CLEAN-tree negative control | small | T30 done | one table-driven suite: 3 RED paths fail, 3 CLEAN paths converge; 2 regression rows + 1 new | `+test` |
| 50 | a552698f | Harden: test-quality review of the new gate/transient tests | medium | T10–T40 done | negative-control + both-predicate + 429 + per-iteration coverage proven; no weak assertions | test files |

Build order: **WS-2 cheap classify/map/route first** (T10, highest confidence, keeps the phase alive so
WS-1's gate can run), then WS-2 park (T20), then WS-1 abort+cap (T30), then the consolidated test (T40),
then test-quality hardening (T50). **Hardening is deliberately ONE lean test-quality ticket** (not the
standard four): the bundle is a ~4-edit-site reuse change across 2 source files, the negative-control
test correctness is the one load-bearing quality surface, and the pipeline's own citadel → anatomy-park →
szechuan-sauce phases provide the code-quality / data-flow / deslop review floor. Documented, not silent.

**R-PSRB note:** this bundle edits the **review-phase** machinery (microverse metric path + pipeline
review-phase wiring), NOT the salvage/completion machinery the build phase exercises — so the build
(pickle-tmux → mux-runner) is not self-referentially blocked; implement on **claude**. The milder
self-reference (this pipeline's own anatomy/szechuan cleanup runs the pre-fix gates) is bounded by the
closer's full tsc/eslint gate + `--scope branch`.

---
title: "B-APNC — anatomy-park convergence/complexity guard + subtract-pass discipline (R-APNC)"
priority: P2
finding: R-APNC
status: ready
type: bug-fix-bundle
schema_neutral: true
self_modifying_recovery: false
backend: claude
source_bug_report: prds/BUG-REPORT-2026-06-27-codex-worker-gate-not-enforced-and-anatomy-guard-piling.md
---

# B-APNC — anatomy-park convergence/complexity guard + subtract-pass discipline

## Problem

On the 2026-06-27 codex soak, after pickle+citadel, **anatomy-park made 27 commits** to
`ticket-completion-evidence.ts`, piling one guard per "stale completion-evidence replay" variant
(pre-session, post-skip, post-rate-limit, reconstruction, resume-time…). This drove `readEvidence`
cyclomatic complexity **13 → 31** (2× the eslint limit) and **never converged**: the `extension`
subsystem ran **14+ passes** with `consecutive_clean` stuck at **0** and `stall_counts` at **0** —
because committing a new guard each pass counts as "progress", so stall detection never fires. It
ground to the iteration cap. This is the **add-don't-subtract / guards-on-guards anti-pattern the
project's own governance fights (W5b subtract-before-add), executed by the review phase itself, and it
is complexity-blind.**

(Observed on codex; the mechanism — "committed a fix ⇒ progress" — is backend-independent. claude
anatomy-park has converged in practice, but the guard is missing on both backends.)

### Root cause

`anatomy-park.json` tracks `pass_counts`, `consecutive_clean`, `stall_counts`, `findings_history` per
subsystem (initialized in `pipeline-runner.ts`). The convergence/stall classifier in
`microverse-runner.ts` treats any committed worker fix as forward progress, so a subsystem that
oscillates (each pass adds a guard, raising complexity, never reaching `consecutive_clean ≥ 1`) is
never recognized as **non-convergent** — it only stops at the hard iteration cap, after polluting the
tree with N low-value guards. There is **no signal that a "fix" made the code worse** (raised a
lint-complexity metric), and **no halt** for "N passes, still zero clean".

## Goal

anatomy-park must **halt-and-report a non-convergent subsystem** instead of grinding to the cap, and
must **not count a complexity-worsening commit as progress**. Plus a doc-level **subtract-pass
discipline** so the review phase collapses the Nth same-theme guard rather than adding the N+1th.
Reuse the existing `anatomy-park.json` counters and the microverse stall classifier — no new
convergence subsystem.

## Non-goals

- R-CWGE (shipped beta.26) and R-SIGF (separate track).
- Re-architecting the microverse convergence loop. This adds two guard conditions to the EXISTING
  classifier and one prompt-discipline section.
- Auto-reverting the review phase's commits (out of scope; halt-and-report surfaces it for the closer).

---

## Workstreams

### WS-1 — Non-convergence halt: N passes without a clean pass

A subsystem that has run `pass_counts[subsystem] ≥ APNC_MAX_PASSES_WITHOUT_CLEAN` (default 8) while
`consecutive_clean[subsystem]` is still 0 MUST halt-and-report as **non-convergent** rather than
continue to the iteration cap.

- Reuse the existing per-subsystem counters in `anatomy-park.json` (no new state field) and the
  existing stall/exit classification in `microverse-runner.ts` (`classifyStall` /
  `currentExitForFailureHistory`).
- Emit a distinct, observable disposition (reuse the existing non-fatal halt/exit-reason surface;
  the runner already distinguishes converged vs stalled vs cap — add a `non_convergent` reason or
  route through the existing stall exit with a clear breadcrumb event). It must be **operator-visible**
  (an activity event naming the subsystem + pass count), and it must NOT be a hard crash — the
  pipeline continues to the next phase per the R-PHC-6 continue-by-default contract.
- Env override `PICKLE_APNC_MAX_PASSES_WITHOUT_CLEAN` (strict positive integer; falls back to default).

**AC-APNC-1**: with `anatomy-park.json` showing `pass_counts.extension = 8` and
`consecutive_clean.extension = 0`, the classifier returns the non-convergent halt disposition (not
"continue"); at `pass_counts = 7` it still continues. Covered by
`extension/tests/anatomy-park-convergence-guard.test.js` (forward-created).

**AC-APNC-2**: the non-convergent halt emits exactly one operator-visible activity event naming the
subsystem + pass count, and the pipeline-runner treats it as a non-fatal phase end (continues to
szechuan per R-PHC-6), NOT a crash.

### WS-2 — Complexity-regression is not progress

A worker pass whose committed fix **raises** the subsystem's lint-complexity signal (an eslint
`complexity` / `max-lines-per-function` error count increase over the pass baseline) MUST NOT reset
`consecutive_clean` toward convergence and MUST count toward the WS-1 non-convergence tally (it is the
guard-piling tell).

- Reuse the per-iteration gate's existing lint run (the convergence gate already runs lint —
  `convergence-gate.ts`); compare the lint **error count** (or the complexity-rule subset) against the
  pass-start baseline already captured for the gate. Do NOT add a second lint invocation.
- A pass that strictly increases the complexity-rule count is classified as a **regressing pass** —
  it counts as a non-clean pass for WS-1 and emits a `anatomy_park_complexity_regression` breadcrumb.

**AC-APNC-3**: a pass where the post-iteration lint complexity-rule count > the pass baseline is
classified non-clean (does not increment `consecutive_clean`) and emits the regression breadcrumb;
a pass that lowers or holds the count is unaffected. Covered by the WS-1 test file.

### WS-3 — Subtract-pass discipline (doc/prompt, advisory)

Add a **subtract-before-add** instruction to `.claude/commands/anatomy-park.md`: when a finding is the
Nth variant of a theme already guarded (N ≥ 2 same-theme guards on one symbol), the worker MUST
collapse them into one uniform check rather than add the N+1th guard, and MUST NOT raise the target's
cyclomatic complexity past the eslint limit. This is the authoring-time arm; it is **prose discipline,
not a runtime gate** (consistent with the W5b governance — do not build enforcement machinery to police
simplification beyond WS-1/WS-2's halt signal).

**AC-APNC-4**: `.claude/commands/anatomy-park.md` contains a grep-able subtract-pass discipline section
(anchor token, e.g. `Subtract-pass discipline`), and the README command-doc table is updated if the
command surface changed (no new flag expected → confirm in closeout).

---

## Simplification Review (subtract-before-add)

**WS-1 (non-convergence halt).** (1) Necessary? Yes — runtime behavior. Adds ONE env-tunable threshold,
no new state field (reuses `anatomy-park.json` counters). (2) Reuse? Reuses the existing
`classifyStall`/`currentExitForFailureHistory` classifier + the existing non-fatal phase-halt surface
(R-PHC-6). (3) Guards brittle complexity? It does not guard a brittle guard — it adds a missing
*terminating* condition to an unbounded loop. (4) Subtract? It makes the system halt-and-report earlier,
**preventing** N low-value guard commits — the net effect is *less* code piled into the tree.

**WS-2 (complexity-regression-not-progress).** (1) Necessary? Yes — the "committed ⇒ progress"
blindness is the core defect. (2) Reuse? Reuses the per-iteration gate's EXISTING lint run + the
pass-start baseline already captured by `convergence-gate.ts` — no second lint. (3) Guards brittle
complexity? No new guard; it teaches the existing progress signal to recognize regressions. (4)
Subtract? It removes a false-positive ("guard added" misread as progress) from the convergence signal.

**WS-3 (subtract-pass discipline).** (1) Necessary? Doc-only. (2) Reuse? Extends the existing
anatomy-park prompt; mirrors the W5b governance language already in `extension/CLAUDE.md` and
`prds/CLAUDE.md`. (3/4) It is itself the subtraction discipline — no machinery added.

---

## Build protocol

NOT self-modifying-recovery in the dangerous sense: B-APNC edits the anatomy-park *convergence*
machinery, but the anatomy-park phase of THIS build runs the **deployed (beta.26)** logic, not the new
code (install.sh only at close), so the build's own review phase can't be wedged by the unbuilt guard.
Standard `/pickle-pipeline --scope branch` on **claude** (claude anatomy-park converges; the guard-pile
pathology was codex). Pre-build residual check: `git log`/grep HEAD for `APNC` / convergence-guard ACs.

## Verification (release gate)

Full local gate from `extension/`: `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc` +
all audit scripts + `npm run test:fast:budget` (flake-classify c=8 → c=4) + `npm run test:integration` +
`RUN_EXPENSIVE_TESTS=1 npm run test:expensive`. Green before tag. On ship: bump beta.27, commit,
`install.sh`, `gh release`.

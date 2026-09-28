# B-SELFRED — the R-ORSR-6 refusal loop has no bound (#52, general; lands on main, then merges down per rule P)

Issue #52: anatomy-park runs livelocked for hours with zero commits in two field repos. The log repeats
`convergence blocked: interface-change sweep found N self-introduced whole-repo break(s)`, then
`[R-ORSR-6] self-introduced red gate open (deferral 1) — refusing trust-the-worker force-exit`.
One lane ran 296 iterations over 199 minutes with 0 commits. Others were killed by hand at iterations 179 and 102.
The issue was filed against the lanes beta, but the defect is in `microverse-runner.ts`, which is identical on `main`
(measured 2026-09-27: `origin/main` and `origin/exp/b-lanes` each carry exactly one refusal site and one
`classifyNoDisown(typecheck` call). It affects every anatomy-park and szechuan run.

## Mechanism (read at `main@60a82fe7`)

`handlePostConvergenceGateDeferral` (`extension/src/bin/microverse-runner.ts` ~`:5771`):

1. On any iteration whose `reason` is not `POST_CONVERGENCE_WITHHELD_REASON`, it resets BOTH
   `postConvergenceDeferralCount` and the `postConvergenceSelfRedOpen` latch.
2. While `postConvergenceSelfRedOpen` is set, it logs the refusal and returns `null`. **This branch sits above the
   `POST_CONVERGENCE_GATE_DEFERRAL_LIMIT` (3) cap**, so the cap never runs while the latch is open.

The field logs show `(deferral 1)` on every refusal. The worker alternates between signalling convergence (blocked
by the sweep) and not signalling it, and each non-signal iteration resets the counter and the latch. Neither the
cap nor any other bound ever fires. The loop stops only when an iteration or time budget runs out, or when the
operator kills it.

**Why the sweep keeps blocking (hypothesis, not needed for the fix):** `classifyNoDisown` marks a failure
self-introduced if its file is in the phase diff OR any quoted identifier in its message, or its file stem, matches a
changed exported symbol. Nothing is subtracted against a baseline. In a repo whose whole type graph fails to resolve
(5153 breaks in one repro, TS2307 from a missing workspace build in the other), identifier-token collisions with
common names are near-certain. The operator's manual unblock (building the missing workspace output) did not clear
the block.

## Fix — one bound, reusing the existing baseline-aware cap gate

Count **consecutive sweep refusals with HEAD unchanged** on the run context. A refusal is an iteration where
`workerResult.selfRedOpen === true`. The count:
- resets ONLY when HEAD advances (a new commit), or when the sweep runs and finds no self-introduced breaks;
- is NOT reset by a non-withheld iteration.

When the count reaches `POST_CONVERGENCE_GATE_DEFERRAL_LIMIT`, stop refusing and run the EXISTING `runCapGate`
(B-CAPGATE: `runBaselineAwareGate` against the session's `gate/baseline.json`, scoped by `allowed_paths`). The
baseline-aware gate is the ground truth the token classifier only approximates:
- **green** (nothing NEW against the baseline) → `converged`, logged as `[R-ORSR-6] refusal bound reached after N
  refusals with HEAD unchanged; baseline-aware cap gate green — the swept breaks pre-date the phase`.
- **unmeasured** → `converged` with the existing `cap_unmeasured_checks` disclosure, exactly as the cap path does
  today.
- **red** → a terminal reason whose disposition is **non-success and non-halting**. The pipeline must continue to the
  next phase and withhold success. Research: find the existing `MicroverseExitReason` that fits (e.g. the
  non-convergent family) and reuse it. Add a member only if none fits, and justify it in the research artifact. Do
  NOT use `'error'`: the lanes code records that `'error'` classifies as failure.

The INV-NO-SELF-DISOWN rule keeps its meaning. A phase still cannot converge over a break it introduced: the red arm
refuses convergence. What changes is that a refusal can no longer repeat forever without new work.

## Acceptance criteria (the new tests fail at `main@60a82fe7`)

1. **Termination:** a test drives the REAL `handlePostConvergenceGateDeferral` / runner loop with a worker that
   alternates "signals convergence → sweep returns `selfRedOpen: true`" and "does not signal", HEAD constant. The run
   reaches a terminal exit within `2 × POST_CONVERGENCE_GATE_DEFERRAL_LIMIT + 2` iterations.
   - Stubbed cap gate green → `converged`.
   - Stubbed cap gate red → the reused non-success reason, never `'error'`.
   - Verify: `cd extension && ./node_modules/.bin/tsc && node --test tests/convergence-gate-no-disown-wiring.test.js`.
   - At HEAD this test does not terminate: it hits the test's own iteration cap and reds.
2. **The rule still holds:** the same fixture with HEAD advancing on every refusal (a new commit each time) does NOT
   reach the bound. The latch stays open, and there is no `converged` exit while the sweep keeps finding
   self-introduced breaks. Control: this passes before and after the fix.
3. **Non-halting:** `classifyMicroverseDisposition(<red reason>).reportAs` is neither `'success'` nor `'failure'`.
   The pipeline phase-loop continues to the next phase; drive `pipeline-runner main()` with a two-phase fixture, or
   assert the disposition table if that is the seam the pipeline reads.
4. Mutation control, recorded in the test file: moving the bound check back below the `selfRedOpen` early return
   reds AC-1.
5. `cd extension && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/eslint src/ --max-warnings=0` exits 0.
   The trap-door catalog entry for the refusal branch in `extension/src/bin/CLAUDE.md` is updated to name the bound,
   and `bash scripts/audit-trap-door-enforcement.sh` exits 0.

## Simplification Review

1. **Necessary?** Yes. A loop with no bound is the no-progress-loop class, which the PRIME DIRECTIVE ranks next to a
   halt.
2. **Reuse:** the existing limit constant, `runCapGate` / `runBaselineAwareGate` (B-CAPGATE), and an existing exit
   reason. No new gate, setting or env var.
3. **Brittle guard:** the token classifier is the brittle part. This fix does not add a second classifier beside it.
   It lets the baseline-aware measurement overrule it after a bounded number of attempts.
4. **Subtraction:** the `selfRedOpen` early return stops being a second, unbounded exit path. There is one bound
   and one cap gate.

## Out of scope (recorded, not filed)

- Classifier precision (baseline-subtracting the sweep itself). With the bound in place the next iteration decides,
  so it earns code only if field runs still show the bound firing on pre-existing breaks.
- Lane-specific parts of #52 go to `exp/b-lanes` separately:
  - `integration_check: unavailable` in monorepos (disclose it in the lane outcome and the phase verdict; do not
    refuse, since refusing would discard every monorepo lane's work);
  - a lane that never progressed past gap analysis.

---
title: "B-NONSTOP — generous caps + honest non-convergence + observability (v2.1)"
priority: P1
finding: B-NONSTOP
status: ready
type: bug-fix-bundle
schema_neutral: false
target_version: v2.1.0
branch: release/v2.1-beta
source_assessment: "Operator field report 2026-07-18 ('pipelines run and exit due to time and not convergence') + OPERATING PRINCIPLES set the same day; seams re-verified at HEAD v2.1.0-beta.3"
---

# B-NONSTOP — the pipeline never halts, never lies about why it stopped, and shows you where it fell short

## 0. Thesis

This is the direct implementation of **OPERATING PRINCIPLE 1** (`prds/MASTER_PLAN.md` → ⚖ OPERATING
PRINCIPLES). One sentence: **a run must never halt, must never report a give-up as success, and the
disposition must be visible in the artifact an operator actually reads.**

**Operator field report (the bug):** *"time limits are too restrictive on anatomy-park and
szechuan-sauce… I have pipelines that run and exit due to time and not convergence."* Root-caused
below: those runs exit `limit_reached`, which is classified as success, and the pipeline prints
*"completed successfully."*

## 1. Verified mechanism (re-grounded at HEAD `v2.1.0-beta.3`, 2026-07-18)

- **1a. A cap exit is classified as SUCCESS.** `checkExitConditions` (`microverse-runner.ts:4053-4062`)
  returns **`limit_reached` for BOTH caps** — iteration (`maxIter > 0 && ctx.iteration >= maxIter`) and
  wall-clock (`remainingSessionSeconds(...) <= 0`). Then `:4575`:
  `successfulReasons = ['converged','stopped','limit_reached','approach_exhaustion','no_progress']` →
  **exit 0**. **Four of those five are give-up conditions**; only `converged` is genuine success.
- **1b. The convergence discriminant is COMPUTED AND THROWN AWAY.** `handleMetricMode`
  (`microverse-runner.ts:4169-4173`) already computes
  `targetHit = classification.kind === 'improved' && convergence_target != null && score === convergence_target`
  and uses it **only inside the log string** (`target=… reached` vs `stall_counter=…`), then returns
  `'converged'` **unconditionally**. ⇒ The fix is ~5 lines, not a new subsystem.
- **1c. `isConverged` conflates two states.** `microverse-state.ts:390-402` returns bare `true` for BOTH
  stall-exhaustion (`stall_counter >= stall_limit`) and target-reached — same value, no discriminant.
- **1d. The phase report ignores the exit code for non-pickle phases.** `finalizePhaseSuccess`
  (`pipeline-runner.ts`) **does** forward `exitCode` to `maybeStampPhaseGraduation`, but that gate opens
  `if (rawPhase !== 'pickle') return null;` — so for **citadel / anatomy-park / szechuan-sauce the exit
  code gates nothing**, and the function unconditionally does `counters.completed++` and logs
  `Phase ${rawPhase} completed successfully`. *(This corrects the MASTER_PLAN B.5(a) wording "a parameter
  that is never tested" — it IS forwarded; it just never gates the success claim.)*
- **1e. 🔑 NONSTOP IS ALREADY SAFE — do NOT implement this as `exit 1`-to-halt.** `anatomy_non_convergent`
  is the **shipped working template**: `pipeline-runner.ts:4086-4089` returns
  `{action:'run-finalize-gate-incomplete'}` with the comment *"a non-convergent subsystem halt is a
  NON-FATAL phase end — run the finalize gate over the converged work and continue to szechuan
  (R-PHC-6), never abort."* And `shouldHaltAfterPhase` halts ONLY on `isFatalPhaseFailure` or
  `pipeline_continue_on_phase_fail === false` (default `true`). **Honest costs us nothing in nonstop.**
- **1f. The caps are too small.** Binding today: `/pickle-pipeline` skill defaults
  **`SZ_MAX_ITER = 50`** (`.claude/commands/pickle-pipeline.md:143`) and **`AP_MAX_ITER = 100`** (`:139`),
  written into `pipeline.json`; plus `pickle_settings.json` `default_max_iterations: 500` and
  `iteration_budget_per_backend: {claude: 100, codex: 80}`. **Szechuan at 50 is the tightest and the one
  that bites a large deslop.** Wall-clock (`max_time_minutes`) is already opt-in/disabled — keep it that way.

## 2. Workstreams

### WS-1 — Honest dispositions (the core)
Return a **named non-convergent disposition** instead of `converged` when the run gave up:
- `handleMetricMode`: when `!targetHit`, return **`stalled_below_target`** (the `targetHit` computation
  already exists at `:4169` — use it, don't recompute).
- `checkExitConditions`: distinguish the two cap exits — **`iteration_budget_exhausted`** and
  **`time_budget_exhausted`** — instead of one `limit_reached` for both.
- Route all three like `anatomy_non_convergent`: **non-fatal → finalize-gate over converged work → CONTINUE.**
- Remove `limit_reached`/`no_progress` from the **success classification** so they stop reading as
  success. **⚠ This must NOT make them halt** (principle 1c / §1e) — `shouldHaltAfterPhase` +
  `pipeline_continue_on_phase_fail:true` already continue on non-zero; verify that in an AC.

### WS-2 — Reporting honesty (must ship WITH WS-1)
`finalizePhaseSuccess` must stop claiming success for a non-convergent phase. A phase that ended on a
give-up disposition is reported as **non-convergent**, and `counters.completed++` must not silently
count it as a clean completion. Applies to citadel / anatomy-park / szechuan-sauce (today ungated, §1d).

### WS-3 — Generous caps (principle 1a)
Raise the binding iteration budgets to **runaway-backstop scale, not +20%**:
- `.claude/commands/pickle-pipeline.md`: `SZ_MAX_ITER` 50 → **500**, `AP_MAX_ITER` 100 → **500** (or `0`
  where the loop already treats 0 as unlimited — the mux global cap already does: `globalMaxIter > 0 && …`).
- `pickle_settings.json`: `iteration_budget_per_backend` claude 100 → **500**, codex 80 → **400**.
- **Wall-clock stays opt-in/disabled by default — do NOT arm a default `--max-time`.**
- Update `README.md`/docs where these defaults are stated (Documentation Rule).

### WS-4 — The release gate's own cap (found 2026-07-18 running the beta.3 gate)
`bin/test-runner.js:32` `DEFAULT_TEST_RUNNER_TIMEOUT_MS = 30 * 60 * 1000` **equals** the documented
`SOAK_SECONDS=1800`, so the soak consumes 100% of the runner budget and its serial siblings are
cancelled (`fail 0, cancelled 2`). Make the default **exceed the SUM of the serial manifest's worst
case** (or derive it from the manifest), and document `PICKLE_TEST_RUNNER_TIMEOUT_MS` in
`extension/CLAUDE.md`'s release-gate command. **Do NOT shorten the soak** — that subtracts the evidence,
not the defect.

### WS-5 — Simplification (principle 2)
`successfulReasons` collapsing five distinct dispositions into one boolean **is** the complexity to
subtract. Replace the "is it in the success list?" test with an explicit
**disposition → { exitCode, reportAs, continues }** mapping so a newly added reason **cannot silently
inherit "success."** Name the reuse: `anatomy_non_convergent`'s existing producer/consumer pair is the
template — do not invent a parallel mechanism.

## 3. Acceptance criteria — OUTCOME-based

- **AC-NS-1 (the headline outcome):** a run that exhausts its szechuan iteration budget is **reported as
  non-convergent** AND **the pipeline still reaches the next phase**. Not "a new enum member exists."
  — Verify: integration test driving a budget-exhausted szechuan phase; assert (i) disposition is not
  `converged`/success, (ii) the subsequent phase runs. — Type: test
- **AC-NS-2:** `handleMetricMode` returns `stalled_below_target` when `isConverged` is true via
  stall-exhaustion, and `converged` only when `targetHit`. — Verify: unit test over both states — Type: test
- **AC-NS-3:** the two cap exits are distinguishable — iteration vs time produce different reasons.
  — Verify: unit test on `checkExitConditions` — Type: test
- **AC-NS-4 (nonstop guard — the principle-1 regression pin):** for EVERY non-convergent disposition,
  `shouldHaltAfterPhase` returns **false** under default settings. — Verify: `describe.each` over the
  disposition set — Type: test
- **AC-NS-5 (observability):** after a non-convergent phase, `pipeline-status.json` (the artifact an
  operator reads) carries the named disposition — not just a log line. — Verify: integration test reads
  the file — Type: test
- **AC-NS-6:** `finalizePhaseSuccess` does not log "completed successfully" for a non-convergent
  non-pickle phase. — Verify: test asserts the reported disposition instead — Type: test
- **AC-NS-7 (caps):** `grep` the skill + settings for the raised values; `SZ_MAX_ITER >= 500`,
  `AP_MAX_ITER >= 500`, `iteration_budget_per_backend.claude >= 500`. — Verify: `jq`/`grep` — Type: test
- **AC-NS-8 (gate cap):** `DEFAULT_TEST_RUNNER_TIMEOUT_MS` > `SOAK_SECONDS` default × (serial manifest
  entry count), and `extension/CLAUDE.md`'s gate command documents `PICKLE_TEST_RUNNER_TIMEOUT_MS`.
  — Verify: unit test on the constant + `grep` the doc — Type: test
- **AC-NS-9 (simplification):** adding a hypothetical new exit reason does NOT default to success —
  the disposition map has no implicit fallthrough. — Verify: test asserts an unknown reason is
  classified non-success — Type: test

## 4. Simplification Review

1. **Necessary?** WS-1/WS-2 are necessary (a give-up reads as success today). WS-3/WS-4 are pure
   constant changes. WS-5 is pure subtraction (a boolean list → an explicit table that cannot
   silently default).
2. **REUSE not ADD?** Yes — `anatomy_non_convergent`'s shipped producer/consumer pair is the template
   for every new disposition; `targetHit` already exists at `:4169`; `shouldHaltAfterPhase` +
   `pipeline_continue_on_phase_fail` already provide nonstop. **No new subsystem.**
3. **Guards brittle complexity that should be SUBTRACTED?** Yes — `successfulReasons` conflating five
   dispositions is the brittleness; WS-5 subtracts it rather than adding a second list beside it.
4. **SUBTRACTS:** the five-into-one boolean; the false "completed successfully" claim; four
   too-tight caps. **NOT built:** a halt-on-non-convergence path (violates principle 1); a dynamic
   time budget; a default `--max-time`.

## 5. Risks

- **R1 — a disposition change could accidentally halt a run** (the principle-1 regression). Mitigation:
  **AC-NS-4** pins `shouldHaltAfterPhase === false` for every non-convergent disposition, and §1e
  documents that non-zero already continues by default.
- **R2 — `schema_neutral: false`.** New `ExitReason` members touch the union in `types/index.ts` and may
  touch `activity-events.schema.json`. Follow the existing `anatomy_non_convergent` co-edit sites; do
  NOT bump `LATEST_SCHEMA_VERSION` (this is additive to a union, not a state-schema migration).
- **R3 — raising caps lengthens worst-case runs.** Accepted and intended (they are backstops). The
  honest disposition + observability is what makes a long run diagnosable rather than silent.

## 6. Build notes
- **Pipeline-safe** — `microverse-runner`/`pipeline-runner` phase-disposition logic is NOT the
  salvage/completion-evidence/Done-flip path; the running pipeline executes deployed JS.
- **Launch with generous caps** (`--szechuan-max-iterations 500 --anatomy-max-iterations 500`) — this
  bundle must not be strangled by the very caps it raises.
- Green-tree precondition on the launch commit.

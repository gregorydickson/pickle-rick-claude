---
title: "B-NONSTOP — generous caps + honest non-convergence + observability (v2.1)"
priority: P1
finding: B-NONSTOP
status: ready
type: bug-fix-bundle
schema_neutral: false
target_version: v2.1.0
branch: release/v2.1-beta
source_assessment: "Operator field report 2026-07-18 ('pipelines run and exit due to time and not convergence') + operator eyewitness 2026-07-19 (personally observed a szechuan-sauce run hit a timeout) + OPERATING PRINCIPLES; seams re-verified at HEAD v2.1.0-beta.4 by a 3-role × 3-cycle analyst team (session 2026-07-19-afe23e5b)"
---

# B-NONSTOP — the pipeline never halts, never lies about why it stopped, and shows you where it fell short

*(refined 2026-07-19 from the beta.4 refinement team: requirements + codebase + risk-scope, 3 cycles. Every change below is attributed to the analyst pass that produced it. The original hand-authored PRD is preserved at `prd.md`.)*

## 0. Thesis

The direct implementation of **OPERATING PRINCIPLE 1**. One sentence: **a run must never halt, must never report a give-up as success, and the disposition must be visible in the artifact an operator actually reads.**

**The verified core (the load-bearing fix):** for the convergence-loop phases (anatomy-park, szechuan-sauce), a non-convergent exit — iteration budget exhausted, stall exhaustion, `approach_exhaustion`, `no_progress` — is today classified **success** and printed as *"Phase … completed successfully."* This is a live fake-green, confirmed at HEAD by all three analysts and witnessed in the field: session `2026-07-17-a1597bbe` exited `approach_exhaustion` (a give-up) and was recorded as success. **The fix is WS-2 (the honesty gate), and WS-1's non-zero exit is inert for reporting without it.**

## 0.1 Root cause — RE-GROUNDED (risk-scope P0 + operator eyewitness)

The original PRD led with "pipelines exit due to *time*." The risk-scope analyst proved that the **time** exit branch (`readLoopExit` `:4057-4060`) is **unreachable under default settings**: `remainingSessionSeconds` returns `null` whenever `max_time_minutes` is absent/≤0 (`microverse-runner.ts:2814-2815`), and the time branch is gated behind `remaining !== null`. Wall-clock stays opt-in/disabled by default, so the time exit never fires unless `--max-time` is armed.

**The reconciliation (operator eyewitness 2026-07-19 + code fact):** the operator personally observed a szechuan-sauce run "hit a timeout." The default-reachable mechanism that produces that experience is the **iteration cap** — `SZ_MAX_ITER = 50`, which §1f (original) itself flags as *"the tightest and the one that bites a large deslop."* A large deslop that exhausts 50 iterations without converging stops short and is reported as success — indistinguishable, from the outside, from a timeout. **This bundle therefore treats the iteration cap as the primary observed mechanism** (WS-3 raises it; WS-1 names its exhaustion `iteration_budget_exhausted`; WS-2 reports it honestly) **and `time_budget_exhausted` as the honest name for the armed-`max_time` case** (correct when armed, inert by default — explicitly documented, not presented as the remedy for the observed bug).

This is the [[feedback_verify_the_outcome_not_the_mechanism]] discipline applied to our own PRD: the headline mechanism was unverified; the re-grounding names the reachable one and keeps the unreachable one honest-but-labeled.

## 1. Verified mechanism (re-grounded at HEAD `v2.1.0-beta.4`, 2026-07-19)

All line numbers below re-verified at beta.4. Files live at `extension/src/bin/` (runner) and `extension/src/types/` (union).

- **1a. A cap exit is classified as SUCCESS via TWO independent lists.** `microverseExitCode` (`microverse-runner.ts:4574-4576`): `successfulReasons = ['converged','stopped','limit_reached','approach_exhaustion','no_progress']` → returns 0 for any of the five. AND `markMicroverseFatalError` (`:4602`): `new Set(['converged','stopped','limit_reached','approach_exhaustion','no_progress','completed','success'])` — a **second** success list with different membership and a different consumer (decides whether a finalizer crash preserves "successful"). **Four of the five array members are give-ups**; only `converged` is genuine success. *(codebase + requirements, all cycles — the second list at `:4602` was NOT in the original PRD.)*
- **1b. The exit-code collapse is BINARY — the disposition string never reaches the reporter.** `microverseExitCode` collapses every non-success reason to the integer `1`. `finalizePhaseSuccess` (`pipeline-runner.ts:4154-4161`, signature `(runtime, counters, cancelMarker, rawPhase, exitCode, log)`) reads **no** `state.exit_reason` and **no** microverse state — only the binary `exitCode`. So `iteration_budget_exhausted`, `stalled_below_target`, and `error` all arrive as the same `1`. **WS-2 is unimplementable until it is given a disposition source** (read `state.exit_reason` on disk, written by the microverse subprocess before exit). *(codebase P0 — the single sharpest finding; NOT in the original PRD.)*
- **1c. The convergence discriminant uses the WRONG operator (overshoot mislabel).** `handleMetricMode` (`microverse-runner.ts:4168-4173`) computes `targetHit = classification.kind === 'improved' && convergence_target != null && score === convergence_target` — **strict `===` on the current score** — while `isConverged` (`microverse-state.ts:390-402`) fires on the direction-aware `<=`/`>=` branch (`:397-399`) OR the stall branch (`stall_counter >= stall_limit`, `:391`). A `lower`-direction run that **overshoots** its target has `isConverged()===true` but `targetHit===false`, so a naive `!targetHit → stalled_below_target` would label a **target-beating** run non-convergent. **Fix: `isConverged` returns which branch fired (`'target' | 'stall' | null`); `handleMetricMode` consumes that, never a recomputed `===`.** *(codebase + requirements P1.)*
- **1d. The reporter fake-greens non-pickle phases — and the "reuse template" does not exist.** `finalizePhaseSuccess` calls `maybeStampPhaseGraduation` (`:4168`), which **hard-returns null for every non-pickle phase** (`:3592`, `if (rawPhase !== 'pickle') return null;` — a preserved R-PHC-6/R-DPMC-2 carve-out keyed on frontmatter counts, not any microverse disposition). So for anatomy-park/szechuan-sauce, execution falls straight through to `counters.completed++` (`:4170`) + `log('Phase … completed successfully')` (`:4176`) **on exit code 1 too**. **The `anatomy_non_convergent` "template" the original PRD held up fake-greens through this exact path today.** WS-2's honesty gate is therefore a **genuinely NEW gate** (a non-pickle sibling of `maybeStampPhaseGraduation`, inserted after `:4169` and before `:4170`), NOT a reuse. *(codebase P0 — corrects the original §1e/Simplification-Review "no new subsystem" claim.)*
- **1e. NONSTOP IS ALREADY SAFE — do NOT implement any of this as `exit 1`-to-halt.** Two continue templates exist:
  - **Template A** — `shouldHaltAfterPhase === false` (default, since the reason is not in `isFatalPhaseFailure`/`MICROVERSE_FAILURE_REASONS` and `pipeline_continue_on_phase_fail` defaults `true`) → `runPhaseIteration` falls through to `finalizePhaseSuccess` in-process → next phase runs same-run. **This is the target template for all new dispositions.**
  - **Template B** — halt → `classifyMicroverseHaltDecision` → `run-finalize-gate-incomplete` → `EXIT(3)` → auto-resume (used today by `judge_timeout`, `all_judge_backends_exhausted`, `baseline_unmeasurable_transient`, `anatomy_non_convergent`).
  The new dispositions take **Template A** and MUST NOT be added to `isFatalPhaseFailure` (`:2774`) or `MICROVERSE_FAILURE_REASONS` (`types/index.ts:1294`) — doing so flips them to Template B and breaks AC-NS-1a's same-run continuation. *(requirements + risk + codebase — the two-template model was the biggest cross-cycle shift.)*
- **1f. The caps are too small — and the iteration cap is the reachable one.** `/pickle-pipeline` skill defaults **`SZ_MAX_ITER = 50`** (`.claude/commands/pickle-pipeline.md:143`) and **`AP_MAX_ITER = 100`** (`:139`); `pickle_settings.json` `iteration_budget_per_backend: {claude: 100, codex: 80}`. Szechuan at 50 is the tightest and is the default-reachable mechanism behind the observed timeout. Wall-clock stays opt-in/disabled.
- **1g. There are FOUR `limit_reached` producers, not two.** `readLoopExit:4055` (iteration), `readLoopExit:4060` (time), `:3198` (rate-limit poll time-exhaustion), `handleRateLimitExit:4132` (parked rate-limit time-exhaustion). WS-1 migrates ONLY the two `readLoopExit` returns to the new specific names; `:3198`/`:4132` keep returning `limit_reached`, so **`limit_reached` survives in the union** and WS-5's exhaustive map must classify it (non-convergent). *(risk-scope P1 — NOT in the original PRD; a `limit_reached` deletion would break `:3198`/`:4132` compilation.)*

## 2. Workstreams

### WS-1 — Honest dispositions (the naming layer)
- **Rename** every `checkExitConditions` reference (§1a, AC-NS-3) → **`readLoopExit`** (`microverse-runner.ts:4036`) — the real function; `checkExitConditions` has zero matches repo-wide. **Export `readLoopExit`** (WS-1 already edits it) so AC-NS-3's unit test can import it.
- **`readLoopExit`**: split the two cap returns — `:4055` iteration → **`iteration_budget_exhausted`**, `:4060` time → **`time_budget_exhausted`** (default-unreachable; fires only with `max_time_minutes > 0`). Leave `:4041 'error'` and `:4048 'stopped'` returns untouched.
- **`handleMetricMode`**: when `isConverged` fired via its **stall branch**, return **`stalled_below_target`**; return `converged` ONLY when it fired via its **target branch**. Drive this off the `isConverged` branch discriminant (§1c) — never a recomputed `=== target`.
- **`MicroverseExitReason` union** (`types/index.ts:1284`) + compiled mirror `extension/types/index.js`: ADD `stalled_below_target`, `iteration_budget_exhausted`, `time_budget_exhausted`. **KEEP `limit_reached`** (still produced by `:3198`/`:4132`). No `LATEST_SCHEMA_VERSION` bump; no `activity-events.schema.json` edit (these are union members, not events).
- **Both success lists** (`:4575` array AND `:4602` Set): remove `limit_reached`, `no_progress`, `approach_exhaustion`, `stopped` — see the WS-5 map for the authoritative disposition of each.
- **NON-EDITS (state explicitly in the ticket):** do NOT add any new disposition to `isFatalPhaseFailure` (`:2774`) or `MICROVERSE_FAILURE_REASONS` (`types/index.ts:1294`).

### WS-2 — Reporting honesty (THE fix that stops the lie — must ship WITH WS-1; WS-1 is inert without it)
`finalizePhaseSuccess` (`pipeline-runner.ts:4154`) must stop claiming success for a non-convergent phase. Implementation, pinned by the codebase analyst:
- **Disposition source:** after the `maybeStampPhaseGraduation` call (`:4169`, pickle-only) and BEFORE `counters.completed++` (`:4170`), for `rawPhase !== 'pickle'` read the microverse disposition from `state.exit_reason` via `sm.read(runtime.statePath)` (the subprocess writes it before exit).
- **New non-pickle honesty gate:** when that disposition is non-convergent (per the WS-5 map), report **non-convergent** — skip `counters.completed++`, suppress the `Phase … completed successfully` log (`:4176`), and increment a **`counters.nonConvergent`** so the end-of-pipeline summary shows it (positive observability, not just suppression).
- **Scope to anatomy-park / szechuan-sauce only** (the convergence-loop phases). **Citadel carve-out:** citadel emits no microverse disposition; it reports its own audit exit code and carries no `phase_dispositions` entry. "non-pickle" must NOT sweep citadel into the disposition path.
- **Do-not-regress:** the pickle-only carve-outs (`:3592` graduation guard, the `Phase pickle completed successfully` path) are untouched — the new gate is anatomy/szechuan-only.
- **This is a NEW gate, not a reuse** (§1d). The reuse claim holds only for WS-5's disposition map.

### WS-3 — Generous caps (finite backstops — the observed-mechanism raise)
Raise the binding iteration budgets to runaway-backstop scale (finite; **the "or 0/unlimited" option is DELETED** — it removes the backstop R3 requires and contradicts AC-NS-7):
- `.claude/commands/pickle-pipeline.md`: `SZ_MAX_ITER` 50 → **500**, `AP_MAX_ITER` 100 → **500**.
- `pickle_settings.json`: `iteration_budget_per_backend` claude 100 → **500**, codex 80 → **400** (codex note in R3: a 400-iter codex run that fake-greens is costlier to babysit — the WS-2 honesty gate is what makes the raise safe).
- Wall-clock stays opt-in/disabled — do NOT arm a default `--max-time`.
- Update `README.md` / docs where these defaults are stated (Documentation Rule).

### WS-4 — The release gate's own cap
`bin/test-runner.js:32` `DEFAULT_TEST_RUNNER_TIMEOUT_MS = 30 * 60 * 1000` **equals** `SOAK_SECONDS` default (1800), so the soak consumes 100% of the runner budget and its serial siblings are cancelled (`fail 0, cancelled 2`). Make the default the **sum of the serial manifest's worst case** (manifest: `tests/expensive/.serial-tests.json`), and document `PICKLE_TEST_RUNNER_TIMEOUT_MS` in `extension/CLAUDE.md`'s release-gate command. **Do NOT shorten the soak.** (Drop the `MAX_TEST_RUNNER_TIMEOUT_MS` clamp concern — the 24h ceiling won't bite.)

### WS-5 — Simplification (the subtraction)
Replace the two "is it in the success list?" tests (`:4575` array + `:4602` Set) with **ONE explicit disposition → `{ reportAs, exitCode, template }` map** that is **exhaustive over the whole `MicroverseExitReason` union** with an **explicit non-success default** (no implicit fallthrough). Both call sites consume the single map — no independent success list survives. Reuse `anatomy_non_convergent`'s existing Template-A producer/consumer pair as the shape for the new dispositions (this reuse claim is accurate for the map; NOT for WS-2's gate).

**Authoritative disposition map (exhaustive over the post-WS-1 union, template-tagged):**

| reason | reportAs | template | notes |
|---|---|---|---|
| `converged` | success | A | the ONLY genuine success; exit 0 |
| `stalled_below_target` (NEW) | non-convergent | A | from `isConverged` stall branch; not recomputed `===` |
| `iteration_budget_exhausted` (NEW) | non-convergent | A | `readLoopExit` iteration cap (`:4055`) — the observed mechanism |
| `time_budget_exhausted` (NEW) | non-convergent | A | `readLoopExit` time cap (`:4060`); default-unreachable |
| `limit_reached` | non-convergent | A | KEPT for `:3198`/`:4132` (rate-limit time-exhaustion); was success |
| `no_progress` | non-convergent | A | removed from both success lists |
| `stopped` | non-convergent | A | session inactive / external stop; did not converge → not success |
| `approach_exhaustion` | non-convergent | A | "fired twice — bailing" give-up; field instance `2026-07-17-a1597bbe` |
| `anatomy_non_convergent` | non-convergent | A | the shipped Template-A template |
| `rate_limit_exhausted` | failure | failure | `MICROVERSE_FAILURE_REASONS` — unchanged |
| `error` | failure | failure | unchanged |
| `judge_unreachable` | failure | failure | unchanged |
| `judge_timeout` | non-fatal halt | B | `isFatalPhaseFailure` `:2799` list — unchanged |
| `all_judge_backends_exhausted` | non-fatal halt | B | `:2799` list — unchanged |
| `baseline_unmeasurable_transient` | non-fatal halt | B | `:2799` list — unchanged |
| `baseline_unmeasurable` | failure | failure | classify explicitly, no default |
| `baseline_unmeasurable_unrecoverable` | failure | failure | `MICROVERSE_FATAL_REASONS` — unchanged |
| `judge_cli_missing` | failure | failure | `MICROVERSE_FATAL_REASONS` — unchanged |
| DEFAULT (unknown) | non-success | A | AC-NS-9's explicit no-fallthrough pin |

The Template-A `non-convergent` rows + the DEFAULT row are what AC-NS-4 / AC-NS-9's `describe.each` iterate.

### WS-6 — `classifyMicroverseHaltDecision` strict-mode arm (P1, strict-mode-only)
`classifyMicroverseHaltDecision` (`:4080-4102`) defaults unknown reasons to `{action:'abort', recognizedExitReason: null}` (`:4101`) — an unattributed abort. This branch is unreachable in default mode (only reached when `shouldHaltAfterPhase===true`, i.e. strict mode), so it is **P1, not P0**. Add three `run-finalize-gate-incomplete` arms at `:4089` mirroring `anatomy_non_convergent`, so strict-mode runs surface the named disposition instead of a null abort.

## 3. Acceptance criteria — OUTCOME-based (all re-authored to be authorable + non-vacuous)

- **AC-NS-1a (mid-pipeline continue, Template A):** an *anatomy-park* run that exhausts its **iteration** budget is reported non-convergent AND the **subsequent szechuan phase runs in-process**. Assert (i) disposition ∉ success, (ii) anatomy did NOT `counters.completed++` as a clean completion, (iii) the szechuan phase started in the same run. — Verify: integration test — Type: test
- **AC-NS-1b (terminal honesty, Template A):** a *szechuan* run that exhausts its **iteration** budget finalizes with `pipeline-status.json` carrying the non-convergent disposition, emits **no** `Phase szechuan-sauce completed successfully` log, and the pipeline **reaches completion without aborting** (there is no next phase; assert the halt decision `action !== 'abort'` and the pipeline exits complete). — Verify: integration test — Type: test
- **AC-NS-2:** `handleMetricMode` returns `converged` iff `isConverged` fired via its **target branch** (direction-aware `<=`/`>=`), and `stalled_below_target` iff via the **stall-exhaustion branch** — verified over an **overshoot** fixture (a `lower`-direction score that beats target) that MUST classify `converged`. — Verify: unit test over both branches + overshoot — Type: test
- **AC-NS-3:** `readLoopExit` (exported) returns **distinct** reasons for the two caps — iteration → `iteration_budget_exhausted`, time → `time_budget_exhausted` — and iteration is checked before time. Fixture arms `max_time_minutes > 0` (small) to exercise the time branch; asserts the iteration branch with `max_time_minutes` unset + small `max_iterations`. — Verify: unit test on exported `readLoopExit` — Type: test
- **AC-NS-4 (nonstop guard — the principle-1 regression pin):** for EVERY Template-A non-convergent disposition, `shouldHaltAfterPhase` returns **false** under default settings, and `isFatalPhaseFailure({exit_reason:d}) === false`. — Verify: `describe.each` over the Template-A non-convergent set + DEFAULT — Type: test
- **AC-NS-5 (observability):** after a non-convergent anatomy/szechuan phase, `pipeline-status.json` carries an additive-optional **`phase_dispositions`** field (sibling to `phase_skips`) written by **`writePipelineStatus`** via `finalizePhaseSuccess`, with value ∈ the enumerated non-convergent members. Older status files without the field MUST still parse. Citadel carries no entry. The same disposition string appears on any `state.activity` recoverable event (one source of truth). — Verify: integration test reads the file + backward-parse test — Type: test
- **AC-NS-6:** invoke `finalizePhaseSuccess(…, 'szechuan-sauce', /*exitCode*/ 1, log)` with `state.exit_reason` = a non-convergent disposition; assert (a) no `completed successfully` string, (b) `counters.completed` unchanged, (c) `counters.nonConvergent` incremented, (d) `pipeline-status.json` carries the disposition. A test passing with `exitCode:0` exercises dead behavior and is rejected. — Verify: unit test with non-zero exit — Type: test
- **AC-NS-7 (caps):** `SZ_MAX_ITER >= 500`, `AP_MAX_ITER >= 500`, `iteration_budget_per_backend.claude >= 500`, `iteration_budget_per_backend.codex >= 400`; no `0`/unlimited value present. — Verify: `jq`/`grep` — Type: test
- **AC-NS-8 (gate cap):** `DEFAULT_TEST_RUNNER_TIMEOUT_MS` >= sum of the worst-case durations in `tests/expensive/.serial-tests.json`, and `extension/CLAUDE.md`'s gate command documents `PICKLE_TEST_RUNNER_TIMEOUT_MS`. — Verify: unit test on the constant + `grep` the doc — Type: test
- **AC-NS-9 (simplification / both lists):** a single disposition map governs BOTH former success sites (`:4575` array + `:4602` Set); no independent success-membership list survives; an unknown reason classifies **non-success** (explicit default, no fallthrough). — Verify: unit test drives an unknown reason through both consumers — Type: test
- **AC-NS-10 (stall backstop):** with `max_time_minutes` unset and `SZ_MAX_ITER=500`, a szechuan run whose score stops improving is terminated by `stall_counter >= stall_limit` (`microverse-state.ts:391`) within `≤ settings.stall_limit_llm + margin` iterations; the resolved `stall_limit_llm` value is documented in §1 as the true sub-500 backstop. — Verify: test drives a non-improving run to stall termination — Type: test

## 4. Simplification Review

1. **Necessary?** WS-2 is the load-bearing necessity (a give-up reads as success today, witnessed in the field). WS-1 is the naming it needs. WS-3/WS-4 are constant changes. WS-5 is pure subtraction. WS-6 is a small strict-mode correctness arm.
2. **REUSE not ADD?** Map (WS-5) reuses `anatomy_non_convergent`'s Template-A producer/consumer pair; `isConverged` branch discriminant reuses an existing computation. **WS-2's finalize gate is a genuine (small) NEW gate** — the "no new subsystem" claim was retracted (§1d); there is no shipped non-pickle honesty template to reuse.
3. **Guards brittle complexity that should be SUBTRACTED?** Yes — TWO success lists conflating five dispositions each is the brittleness; WS-5 subtracts both into one exhaustive map with no implicit success default.
4. **SUBTRACTS:** two success lists → one map; the false "completed successfully" claim on non-convergence; four too-tight caps; the `0`-cap footgun. **NOT built:** a halt-on-non-convergence path (violates principle 1); a dynamic time budget; a default `--max-time`; any edit to `isFatalPhaseFailure`/`MICROVERSE_FAILURE_REASONS`/`LATEST_SCHEMA_VERSION`.

## 5. Risks

- **R1 — a disposition change could accidentally halt a run** (the principle-1 regression). Mitigation: AC-NS-4 pins `shouldHaltAfterPhase === false` + `isFatalPhaseFailure === false` for every Template-A disposition; §1e documents non-zero-continues-by-default. The nonstop guarantee holds **in-process on default settings (Template A)**; strict-mode (`pipeline_continue_on_phase_fail:false`) depends on `auto-resume.sh` (Template B) and is out of this bundle's guarantee scope.
- **R2 — union edit surface.** New `MicroverseExitReason` members touch the union at `types/index.ts:1284` + the compiled `extension/types/index.js` mirror ONLY. **No `activity-events.schema.json` edit, no `LATEST_SCHEMA_VERSION` bump** (dispositions are union members / `state.exit_reason` strings, not activity events).
- **R3 — raising caps lengthens worst-case runs.** Accepted and intended (finite backstops). The WS-2 honesty gate + AC-NS-10 stall backstop are what make a long run diagnosable-and-bounded rather than silent. Codex 400 carries added fake-green babysitting cost ([[project_codex_soak_worker_gate_not_enforced_revert]]) — the honesty gate mitigates it.
- **R4 — rate-limit path behavior change.** Removing `limit_reached` from the success lists flips a rate-limit-then-time-exhausted run from success → non-convergent. Semantically correct; covered by keeping `limit_reached` in the union (`:3198`/`:4132` still compile) and classifying it non-convergent in the map.

## 6. Build notes
- **Pipeline-safe** — `microverse-runner`/`pipeline-runner` phase-disposition logic is NOT the salvage/completion-evidence/Done-flip path; the running pipeline executes deployed JS ([[feedback_rpsrb_is_narrow_not_anything_touching_mux_runner]]).
- **Launch with generous caps** (`--szechuan-max-iterations 500 --anatomy-max-iterations 500`) so this bundle isn't strangled by the caps it raises.
- **Green-tree precondition** on the launch commit.
- **Ship WS-1 + WS-2 together** or the log still lies (WS-1 alone is inert for reporting).
- Re-verify all citations at build time — they held at beta.4 but HEAD advances.

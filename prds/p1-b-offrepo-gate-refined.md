---
title: "B-OFFREPO — the worker quality gate does not exist on any repo that is not pickle-rick [REFINED]"
priority: P1
finding: B-OFFREPO
status: ready
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
branch: release/v2.1-beta
build_mode: attended
source_assessment: "Refined 2026-08-04 by the 3-role x 3-cycle analyst team (session 2026-08-04-183319b4), all_success=true, 2 ac_shape_smells. Author's retraction below."
---

# B-OFFREPO *(refined)*

## 0. AUTHOR'S RETRACTION

The five-site enumeration survived (cycle 3 confirmed it exhaustive **for its stated predicate**). Eight
other things did not.

| # | My claim | Corrected finding |
|---|---|---|
| **R1** | The family is the five `<workingDir>/extension` sites | **Not confined to that predicate.** `extension/src/services/convergence-gate.ts:761` `emptyGateResult()` returns `status: 'green'` for **every** `runGate` skip path. The predicate was my search, not the defect's boundary. |
| **R2** | `not_run` is a new disposition to introduce | **It already exists inside the function WS-1 edits** — `lintUnrunnable` / `tscUnrunnable` / `LINT_PHASE_NOT_RUN`, with a live not-red policy at `computeWorkerGateVerdict` (`extension/src/bin/spawn-morty.ts:1691`). Make it that function's **third return value**; do not invent a parallel concept. |
| **R3** | Persisting `not_run` is straightforward | **The round-trip is undefined and fail-closed.** `readWorkerGateVerdict` (`extension/src/bin/mux-runner.ts:4653`) coerces any non-`green`/`red` to `'absent'` — so a persisted `not_run` reads back as `absent` and the Done flip is refused. This must be designed, not assumed. |
| **R4** | R2's timeout mitigation: reuse `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` | **Inapplicable.** Routing through `runGate` puts `GATE_TOTAL_TIMEOUT_MS = 600_000` (`extension/src/services/convergence-gate.ts:88`) in charge, overridable only via an `@internal` field — and a `runGate` timeout produces a **synthetic RED** (`timeoutFailure`, `:1069`), never `not_run`. |
| **R5** | A skip status on `GateResult` is one option | **Off the table.** `statusToExitCode` (`extension/src/bin/check-gate.ts:37`) maps any unrecognized status to **exit 1**, and `finalize-gate.ts:308` drops it into the red path. The `onEvent` capture route is the only safe one. |
| **R6** | AC-OFFREPO-4a proves the fix off-repo | **Unfalsifiable as written.** It verifies `test -f` plus prose. Ticket 40 can write a fabricated markdown file and pass — the exact blindness in [[project_b_fomc_checker_structurally_blind_to_fabrication]]. **I declared the failure condition in prose and never encoded it**, which is the same defect I corrected in R-GADEL's AC-B3 twelve hours earlier. |
| **R7** | The self-build cannot exercise this bug at all | **One instance it CAN.** `runWorkerGateChecks` documents that `testsOk: true` means *"the test phases were not run"* (`extension/src/bin/spawn-morty.ts:1601-1603`) and returns it from three skip exits (`:1618`, `:1619`, `:1620`); `:1856` hands that to `:1731`, which writes `worker_gate_tests_verdict: 'green'`. **A `small`-tier ticket stamps a not-run green during this bundle's own build.** This is a second, self-build-executable proof surface and the only thing that makes R3 survivable if the off-repo run slips. |
| **R8** | ACs 1a/1c/3a cover the sites | **AC-shape smell ×2 — no universal quantifier**, so a sixth site is untested by construction. Collapse to ONE invariant AC over an enumerated site table (`describe.each`), per `prds/CLAUDE.md`. |

**Withdrawn by its own author:** the requirements analyst's cycle-2 "F8" claim that
`worker_gate_tests_verdict` is stamped green *off-repo* — `persistWorkerGateVerdict` is called at
`extension/src/bin/spawn-morty.ts:1856`, **70 lines below** F1's early return at `:1786`, so off-repo
neither verdict field is written. The risk auditor adjudicated against its peer, correctly. The
*on-repo* defect (R7) is what that dispute uncovered.

**Process note, recorded because it matters:** the codebase analyst disclosed that its own cycle-2 P0
quoted a sentence from `src/bin/CLAUDE.md:95` **that does not exist**, and that the risk auditor built
on that fabrication. Both self-corrected in cycle 3. This is [[feedback_analyst_majority_is_not_truth_grep_the_sentence]]
firing in the field — and the reason a refinement finding is not evidence until the sentence is grepped.

---

## 1. ⛔ The release-visibility trap (new P0 — governs the build)

The behaviour-pinning test for the exact seam WS-1 must invert is
**`extension/tests/integration/codex-worker-gate-fail-closed.test.js`** — `// @tier: integration`, and it
**asserts off-repo green at `:94`**.

**No pipeline phase runs the integration tier** ([[project_pipeline_phases_never_run_integration_tier]]),
and §0's precondition is `test:fast`-only. So this bundle can run **four green phases while breaking its
own contract test**, and discover it only at the closer.

**Binding on the build:**
- That test is **in scope** for ticket 10 and must be updated *with its reasoning recorded*, not deleted.
- The bundle MUST run `npm run test:integration` before it is considered green — added to WS-4.
- Do not "fix" it by weakening the assertion; it currently encodes the bug as the contract, which is how
  R-GTDT was born.

## 2. Amended acceptance criteria

### AC-OFFREPO-1 *(replaces 1a/1c/3a — ONE invariant, universally quantified)*

**For every gate site in the table below, an input the gate cannot run yields a disposition
distinguishable from a real pass.** No site returns a pass-shaped value for work it did not do.

| Site | Symbol |
|---|---|
| `extension/src/bin/spawn-morty.ts:1786` | `runWorkerGate` off-repo early return |
| `extension/src/bin/mux-runner.ts:4718` | `resolveWorkerGateVerdict` no-extension arm |
| `extension/src/bin/mux-runner.ts:5834` | `attemptRecoveryBeforeTerminal.runArmedGate` |
| `extension/src/bin/mux-runner.ts:670` | `runBetweenTicketFastGate` |
| `extension/src/bin/mux-runner.ts:5238` | exit-path commit |
| `extension/src/services/convergence-gate.ts:761` | `emptyGateResult()` (**R1 — new**) |
| `extension/src/bin/spawn-morty.ts:1601-1620` | `runWorkerGateChecks` `testsOk: true` = not-run (**R7 — on-repo**) |

— Verify: `npm run test:fast` with a `describe.each` over this table; adding a row without a
corresponding behaviour makes the suite red. — Type: test

### AC-OFFREPO-1b *(unchanged in intent, sharpened by R3)*

`not_run` does **not** refuse the Done flip, and its persistence round-trip is explicit: either it is not
persisted, or `readWorkerGateVerdict` (`extension/src/bin/mux-runner.ts:4653`) is taught to preserve it
rather than coerce to `absent`. — Verify: `npm run test:fast` asserting a `not_run` ticket flips Done and
the value survives a write/read cycle — Type: test

### AC-OFFREPO-4a *(replaces the unfalsifiable version — R6)*

The off-repo run emits **`prds/research/offrepo-field-result.json`**, produced **by the run itself**,
containing per ticket `{working_dir, project_type, gate_executed: boolean, checks_run: string[], verdict}`.

— Verify: `npm run test:fast` asserts **(a)** ≥1 recorded ticket; **(b)** the recorded `working_dir`
contains no `extension/`; **(c)** ≥1 ticket has `gate_executed: true` with non-empty `checks_run`;
**(d)** **no** ticket has `gate_executed: false` with `verdict: 'green'`. A result in which every verdict
is green with no gate execution **fails this test.** — Type: test

### AC-OFFREPO-4b *(new — the release-visibility trap)*

`cd extension && npm run test:integration` is green, and
`codex-worker-gate-fail-closed.test.js`'s off-repo assertion has been updated with its reasoning recorded
in a comment. — Verify: exit 0 + `git diff` shows the comment — Type: test

## 3. Governance constraint (R10 — codebase analyst)

`SKIP_FLAG_BUDGETS` (`extension/src/services/metrics-utils.ts:96-104`) is a machine-computed dashboard
that would classify a new skip emitter as a **removal candidate** — `no_project_type_detected` = 50,
`DEFAULT_SKIP_FLAG_BUDGET` = 5, and the comment beneath records the precedent: a gate that reached **725
uses had its emitters deleted, not its budget raised** (`:107-110`). Every off-repo `not_run` WS-2 emits
feeds it. **Design so the steady state is "the gate ran," not "the gate was skipped a lot."** If the
expected off-repo `not_run` volume exceeds the default budget, say so in the PRD rather than discovering
it on the dashboard.

## 4. Unchanged

§2 field evidence, §3 reuse target (`detectProjectType` / `canRunTestScript`), the repo-agnostic
invariant and its AC-2c pin, directive-2 non-halting, and the ATTENDED build mode all stand.

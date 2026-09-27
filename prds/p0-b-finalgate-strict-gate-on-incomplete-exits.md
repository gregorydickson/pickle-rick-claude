# B-FINALGATE — finalize-gate and its remediator on field repos (#49, #50, #51 + strict gate on incomplete exits)

**Field evidence (operator, `prds/research/tools/field-timing-results-2026-09-26.md`):** in **3 of 3** field pipeline runs
on an operator monorepo (2026-09-24/25, pre-B-CAPGATE runtime), anatomy-park's microverse exited with an error, then
`finalize-gate failed after error (exit 2) — phase not completed, run cannot report success`. finalize-gate took
59.4 of 811 wall-clock minutes. In all three, `state.json` still recorded `exit_reason: converged`.

B-CAPGATE (#48, deployed 2026-09-26) fixed the **cap** route: it now judges only failures that are new against the
session baseline. Its PRD declared the follow-up this bundle covers: **finalize-gate stays strict and baseline-free on
every other incomplete microverse exit** (`anatomy_non_convergent`, iteration cap, budget cap, `error`), so the same
pre-existing debt still fails the phase there.

## Mechanism (measured at `main` HEAD `218fb91c`, 2026-09-26)

1. **Strict finalize-gate on incomplete exits.** Every microverse failure exit except `judge_timeout` routes to
   `run-finalize-gate-incomplete` (`pipeline-runner.ts:~5478-5480`, per the B-CAPGATE refinement). finalize-gate then
   runs strict over typecheck, lint and tests (`finalize-gate.ts:~336-343`) with no baseline. Pre-existing failures fail
   the phase. The cap now uses `mode: baseline` against the session `gate/baseline.json`; finalize-gate does not.
2. **`state.json` reports only the LAST phase.** `resetStateForPhase` clears `exit_reason` before each phase
   (`pipeline-runner.ts:1746-1751`). After anatomy-park fails, szechuan-sauce runs and converges, so the final
   `state.json` says `exit_reason: converged`, while the pipeline verdict (`pipeline-status.json`) says the run cannot
   report success. Research must list every consumer that reads `state.exit_reason` after a pipeline (e.g. `/pickle-status`,
   `pickle-recover`, `setup --resume`, `monitor`, the stop hook) and whether any treats it as the run's outcome.

**Unknown, measure first:** why the microverse exited `error` in the two runs that were not the #48 session. The field
logs are off-machine, so research states which exits the fix covers, and the operator supplies the reason tokens.

## Fix

1. **finalize-gate on an incomplete exit uses the same rule as the cap:** baseline mode against the session
   `gate/baseline.json` when it exists (never creating it), the same `allowedPaths` as capture, and no phase-wide `since`
   (see the B-CAPGATE rationale). Strict, with a log line, only when no baseline exists. Timeout-only reds are disclosed
   through the existing `converged_with_unmeasured`-style disposition, never counted as failed. **Reuse the cap's code
   path, extracted into one shared function, rather than writing a second copy of the rule.**
2. **The run's recorded outcome matches the pipeline verdict.** At pipeline end, the verdict that already exists in
   `pipeline-status.json` is also reflected in `state.json`, via one explicit field or by not overwriting an earlier
   failed phase's reason. Research picks the smaller change. No consumer may read "converged" for a run whose
   pipeline verdict is failed or degraded.


## Operator-filed issues folded in (2026-09-26; re-measured at HEAD `c8a2e123`)

All four items share one surface (finalize-gate + the gate remediator), so they ride one bundle.

- **#49 — a failed pipeline ends with `state.json` `exit_reason: converged`.** CONFIRMED:
  `readExistingExitReason` (`extension/src/bin/pipeline-runner.ts:4728-4735`) returns ANY non-empty reason, so
  `finalizeFailedPipeline` (`:~4740-4745`) keeps a later phase's `converged` rather than stamping a failure. This
  REPLACES Fix §2 above with the precise rule: when `pipelineFailed`, a **success-class** reason (`converged`, and any
  other success reason a phase writes) is never preserved. A specific FAILURE reason already stamped (e.g.
  `done_without_commit_evidence`) still is (AC-MWMO-D2-10). Classify success with the existing microverse
  disposition classifier; do not add a new success list. AC: the phase sequence converged → finalize-gate failed →
  converged ends with a failure-class `exit_reason`. Mutation: "preserve any non-empty reason" reds it; a stamped
  specific failure reason is still preserved.
- **#50 — finalize-gate remediates failures no edit can fix.** CONFIRMED: `isUnmeasuredFailure`
  (`extension/src/bin/finalize-gate.ts:312-314`) tests `isCheckUnmeasured(...) && !path.isAbsolute(failure.file)`. The
  unparsed fallback in `buildFailures` (`extension/src/services/convergence-gate.ts:1114`, `:1190`) emits
  `file: pkgDir`, which is absolute and a DIRECTORY, so the row counts as remediable. The remediator is spawned up to
  the cycle cap (field: 4 cycles, 46 min, 13% of the run). The principle is **"does the row name an editable source
  file"**, not "is the path absolute": a directory (or non-file) row of an unmeasured check is unmeasured and is
  reported via `reportUnmeasuredGate` with NO remediator spawn. A real source-file failure of a check that timed out in
  a sibling dir stays remediable. AC: both directions tested; mutation 1 (revert to `!path.isAbsolute`) reds the
  directory case; mutation 2 (treat every unmeasured-check row as unmeasured) reds the sibling case.
- **#51 — the remediation brief injects pickle-rick's own `extension/CLAUDE.md` into every target repo.**
  CONFIRMED: `loadTrapDoorSection` (`extension/src/bin/spawn-gate-remediator.ts:302-317`) reads the `CLAUDE.md` two
  directories above the compiled script (the deployed pickle-rick extension) and never the session `working_dir`; no
  production caller injects `extensionClaudeMdContent`; `buildBriefContent` (`:152-153`) pastes it whole. Fix:
  Section 3 is drawn from the **target repo**: its `CLAUDE.md` files at the root and along each failing path, trap-door
  / rules sections only, within a stated size bound. pickle-rick's own file appears only when the target IS
  pickle-rick. No `CLAUDE.md` in the target → the section says so, with no fallback. AC: a field-repo fixture brief
  contains no pickle-rick content; a pickle-rick target contains its own; mutation: restoring the script-relative read
  reds the field-repo test.

## Acceptance criteria (measure each at HEAD before shipping)

1. An incomplete anatomy-park exit (e.g. `anatomy_non_convergent`) with baseline F, where finalize-gate sees exactly F
   → the phase is not `finalize_gate_failed:*` (HEAD: failed). Control: strict mode reds it.
2. The same exit with F plus one NEW failure → the phase fails, as today.
3. No baseline → strict, with a log line naming the fallback (HEAD behaviour kept).
4. A run in which anatomy-park fails and szechuan-sauce converges ends with `state.json` NOT reporting a successful
   outcome that `pipeline-status.json` contradicts (HEAD: `exit_reason: converged`). Assert on the field the consumers
   actually read.
5. One implementation of the baseline-aware verdict serves both the cap and finalize-gate (`grep` shows a single
   definition, called from both sites).
6. `./node_modules/.bin/tsc --noEmit` and `./node_modules/.bin/eslint src/ --max-warnings=0` exit 0; touched tests pass.

## Simplification Review

Collapses two gate rules (cap: baseline; finalize: strict) into one. The outcome fix removes a disagreement between
two records of the same run. No new gate leg, env var or exit reason.

## Out of scope

Build-phase parallelism (#43, an operator decision); the microverse's own exit reasons; the timing script's gaps (field-timing.py).

## Refinement — BINDING decisions (override earlier text; Fix §2 is DELETED, replaced by #49 below)

*(refined: requirements, codebase and risk-scope analysts, 3 cycles each on claude-opus-5-5, read at `6ed776c2`)*

**Corrections to the cycle-2 consensus (all measured):**
- The unmeasured reader `reportConvergedWithUnmeasured` (`pipeline-runner.ts:5662`) has ONE call site, `:5811`,
  on the converged path. Neither finalize-gate pass arm reaches it, so "record and let the existing reader
  disclose" would have been a write-only channel.
- `runJudgeTimeoutFinalizeGate` (`:5142-5171`) breaks unconditionally on a fail (`:5170`, no disposition). On a pass
  it does `completed++` with no `nonConvergent` and no disposition.
- `skill` is phase-derived on both routes (`:5157`, `:5199`) and already argv[3] to finalize-gate (`finalize-gate.ts:218`).
- #49 has THREE terminal arms (`stampPipelineTerminalReason` `:4911-4930`): `finalizeNonSuccessTerminal`
  (`:4842-4853`, which never calls `readExistingExitReason`), `finalizeFailedPipeline` (`:4740-4745`) and
  `finalizeDegradedCompleteOpts` (`:4751-4755`). Fix §1 moves the field run onto the DEGRADED arm.

### T1a — extract the shared helper (structural, no behaviour change)
`runBaselineAwareGate` in `extension/src/services/convergence-gate.ts`. It chooses the mode (baseline ONLY after
`gate/baseline.json` reads AND parses; otherwise strict, never passing `baselinePath` in strict mode, so it never
captures) and runs the gate. It returns
`{ verdict: 'green' | 'red' | { unmeasured: string[] }, failures: GateFailure[] /* post-subtraction */, mode }`
or `{ threw: string }`. The verdict is computed from `check_status` (`isCheckUnmeasured`), never from `status` alone:
baseline mode can subtract a timeout row and report green. `runCapGate` (`microverse-runner.ts:~5719-5787`) delegates
to it, and `tests/rpgt-exit-paths.test.js` stays green. The caller owns its check list (cap: `['typecheck','lint']`).

### T1b — finalize-gate adopts it (+ judge_timeout parity)
- Baseline mode iff `skill === 'anatomy-park'` AND the baseline reads/parses; otherwise strict, logging
  `[finalize-gate] strict (<why>)`. In baseline mode, log `[finalize-gate] baseline mode (captured <iso|iteration>)`.
  This is the accepted rolling-baseline residual. szechuan stays strict. Residual: the cap in szechuan already reads
  anatomy's baseline (#48); not fixed here.
- Branch on the helper's verdict. `{unmeasured}` → persist the checks with
  `writeMicroverseState(recordCapUnmeasured(...))` (add a write seam to `FinalizeGateOpts` next to
  `readMicroverseStateFn`) and exit 0. Never exit 2 for unmeasured; cap exhaustion stays exit 2.
- BOTH pass arms (`runAllBackendsExhaustedFinalizeGate`, `runJudgeTimeoutFinalizeGate`) call
  `reportConvergedWithUnmeasured` after setting their disposition, reusing the marker `converged_with_unmeasured:<checks>`
  unchanged: one string, one reader. The other half of the disposition already says the phase did not converge.
  `microverse.json` is archived pre-szechuan (`:2854`), so anatomy's checks cannot leak onto szechuan.
- judge_timeout sibling parity: fail → `finalize_gate_failed:judge_timeout` and
  `isStrictPhasePolicy(runtime) ? break : continue`; pass → `nonConvergent++` plus disposition `judge_timeout`.
  `abortSiteCensus` (`tests/nostop-gates-invariant.test.js:~805-815`) stays at 1. Extend
  `tests/nostop-gates-sibling-parity.test.js` in place (fail row + `nonConvergent` compare), and check
  `tests/oneabort-termination-matrix.test.js`.

### T2 — #50 editable-file predicate (after T1b)
A row names an editable file iff `file` is relative, OR it is an absolute path to an existing REGULAR file (stat seam
on `FinalizeGateOpts`; a stat error means not editable). A non-editable row is never sent to the remediator, and it
makes its check unmeasured (disclosed, exit 0), UNLESS the same check also has a NEW editable-file row, in which case
the phase fails on that row. For identity: a row whose `ruleOrCode` is a fallback exit/signal token
(`buildFailures` fallback `convergence-gate.ts:~1186-1197`, identity `check::<pkgDir>::exit_<n>`) is NEVER subtracted by
baseline identity. Parsed `tests` rows (which also carry `file: pkgDir`) keep their name identity. Fixtures use a
NESTED package dir with allowed paths beneath it (`matchesAllowedPath` ancestor arm).

### T3 — #49 three-arm terminal stamp
`isSuccessClassExitReason(r) = classifyMicroverseDisposition(r).reportAs === 'success' || classifyExitReason(r).verdict === 'success'`
(no new list, `EXIT_DISPOSITIONS` unchanged). `readExistingExitReason` returns null for a success-class reason, so
`finalizeFailedPipeline` stamps `failed` and `finalizeDegradedCompleteOpts` stamps `completed` (the R-NOPOSTTIER
contract). `finalizeNonSuccessTerminal`'s null-reason fallback stamps `failed` over a success-class or `completed`
on-disk reason. A specific failure reason (`done_without_commit_evidence`, `all_judge_backends_exhausted`) is still
preserved. Accepted consequence: `claimPipelineRunnerActive` (`:1744-1756`) now clears the degraded `completed` on
re-attach. The fixture is the REAL sequence: anatomy incomplete → `resetStateForPhase` clears → szechuan `converged` →
terminal stamp. finalize-gate writes no `exit_reason`.

### T4 — #51 target-repo trap doors
`working_dir` comes from `<session-root>/state.json` (no new flag; the mux-runner subprocess caller
`mux-runner.ts:~7767` has a fixed argv). Walk from each failing file's directory up to `working_dir` inclusive, each
`CLAUDE.md` once, nearest-first, whole file. Per file: `MAX_FILE_BYTES` (50,000) with the existing "Read path
directly" rendering. Total: 3 × `MAX_FILE_BYTES`, after which files are listed by path. No `CLAUDE.md` → "no
CLAUDE.md in target", with 0 pickle-rick bytes. No identity branch: a pickle-rick target yields its own files via the
walk. Callers: finalize-gate, microverse-runner, pipeline-runner (citadel), mux-runner (subprocess). Keep the
`extensionClaudeMdContent` test seam name.

### Acceptance criteria (replace the PRD's; HEAD values measured by reading at `6ed776c2`)
| AC | Predicate | HEAD |
|---|---|---|
| AC-1 | anatomy `anatomy_non_convergent`, baseline granular lint F, finalize sees F → disposition does not start `finalize_gate_failed`; controls: delete baseline → red; `skill=szechuan` → strict | `finalize_gate_failed:anatomy_non_convergent` |
| AC-2 | F + 1 new editable lint row → `finalize_gate_failed:*`; brief names only the new row | failed; brief names F+1 |
| AC-3 | no baseline / baseline `{` → strict; stderr has `[finalize-gate] strict` | no such log |
| AC-4 | szechuan incomplete + anatomy baseline with F, finalize sees F → strict (`finalize_gate_failed:*`); mutation "drop the skill conjunct" reds | strict |
| AC-5 | incomplete, only a `tests` timeout → exit 0; `cap_unmeasured_checks` ⊇ `tests`; disposition contains `anatomy_non_convergent` AND `converged_with_unmeasured:tests`; completed 1, nonConvergent 1; mutation "delete the added reader call" reds | exit 2 → failed |
| AC-6 | judge_timeout: fail + continue policy → `continue`, `finalize_gate_failed:judge_timeout`; strict → `break`; pass → `nonConvergent === 1`; census unchanged | `break`, no disposition; pass nonConvergent 0 |
| AC-7 | `grep -rEn "export (async )?function runBaselineAwareGate" extension/src \| wc -l` returns 1; callers in `src/bin` = 2 | 0 / 0 |
| AC-8 | baseline has a tests timeout row and finalize sees it → `cap_unmeasured_checks` has `tests` (not a silent green); mutation "branch on status" reds | n/a |
| AC-F1..F4 | F1: fallback `tests::<pkg>::exit_1` in baseline and finalize → not green (unmeasured). F2: baseline test A red, finalize A+B → fails; brief names B only. F3: lint timed out in X + new editable lint row in Y → remediator spawned with Y. F4: lint timed out, only a pkgDir row → no spawn, unmeasured. Mutations: subtract fallback → F1 red; `!path.isAbsolute` → F4 red; every unmeasured-check row unmeasured → F3 red; non-editable ⇒ unmeasured regardless of ruleOrCode → F2 red | F1 failed; F4 spawns |
| AC-49a..d | a: failed arm, anatomy failed + szechuan converged → `failed`; b: same with last `success` → `failed`; c: degraded arm → `completed`, R-NOPOSTTIER block green; d: `done_without_commit_evidence` / `all_judge_backends_exhausted` preserved; mutation "preserve any non-empty" reds a–c | `converged` |
| AC-51a..d | a: field fixture with `FIELDMARK` → brief has `FIELDMARK`, 0 × `R-WSRC`; b: no CLAUDE.md → absence sentence, 0 × `R-WSRC`; c: 3 nested 60 KB CLAUDE.md → path lines, Section 3 ≤ cap; d: pickle-rick-shaped fixture → root + `extension/` referenced, ≤ cap; mutation "script-relative read" reds a | contains `R-WSRC` |
| AC-G | `./node_modules/.bin/tsc && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/eslint src/ --max-warnings=0` exits 0; named test files pass | — |

Test hosts (existing files only): `tests/bin/finalize-gate.test.js` (rewrite only the unmeasured exit-2 pins; cap
exhaustion stays 2), `tests/rpgt-exit-paths.test.js`, `tests/nostop-gates-sibling-parity.test.js`,
`tests/nostop-gates-invariant.test.js`, `tests/oneabort-termination-matrix.test.js`,
`tests/integration/pipeline-runner-judge-reasons.test.js`, `tests/nostop-gates-phase-loop.test.js`,
`tests/bin/spawn-gate-remediator.test.js`.

### Risks (stated)
R1 cross-phase baseline → skill scoping (the cap residual is noted). R2 fallback rows subtract fail-open → never
subtracted. R3 status-green over an unmeasured check → verdict branching. R4 disclosure without a reader → both pass
arms call it. R5 judge_timeout red halts → parity. R6 judge_timeout pass on baseline-subtracted debt → counted
`nonConvergent` (the judge never confirmed). R7 rolling baseline → accepted, logged. R8 stamps drive resume → `failed`
/ `completed`; auto-resume stops on both. R9 field evidence (`cap reached after`, `tests` timeout rows in the field
`baseline.json`) → requested from the operator, non-blocking. R10 brief size → total cap.
"No new exit reason" widens to "no new exit reason or finalize-gate exit code".

## Implementation Task Breakdown

| Order | ID | Title |
|---|---|---|
| 10 | ea1a6059 | Extract runBaselineAwareGate; the anatomy-park cap delegates to it with no behaviour change |
| 20 | 54bb18d6 | finalize-gate judges incomplete anatomy-park exits against the session baseline and discloses unmeasured checks; judge_timeout matches its sibling |
| 30 | 26d5ecf3 | finalize-gate never remediates or subtracts a failure row that names no editable file (#50) |
| 40 | a572d2c0 | A failed or degraded pipeline never ends with a success-class exit_reason in state.json (#49) |
| 50 | 9b6fd4cf | The gate remediation brief carries the target repo's CLAUDE.md trap doors, never pickle-rick's own (#51) |
| 60 | 810082ee | Harden: code quality review of B-FINALGATE |
| 70 | 653a114f | Audit: data flow integrity for B-FINALGATE |
| 80 | 86b6a142 | Harden: test quality review of B-FINALGATE |
| 90 | 2226e1b9 | Audit: cross-reference consistency for B-FINALGATE |

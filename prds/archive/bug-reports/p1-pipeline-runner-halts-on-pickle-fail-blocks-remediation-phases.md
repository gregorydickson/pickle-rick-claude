---
title: P1 — pipeline-runner halts on non-zero pickle/anatomy/szechuan exit even when downstream remediation phases exist to clean up the failure
status: Draft
filed: 2026-05-11
priority: P1
type: bug-architecture
---

# PRD — Pipeline-runner halts when remediation phases could (and were designed to) clean up

**Author**: Pickle Rick
**Project**: `pickle-rick-claude`
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`, local-only

## Symptom

Bundle 2026-05-10 session `2026-05-10-84ad0873` finished at `2026-05-11T08:51:39Z` after 445 minutes (7h 25m) with:

- `Phase pickle exited with code 1`
- `Phase pickle failed (exit 1) — stopping pipeline`
- `Pipeline finished: 0/4 phases, 445m 26s`

**Zero phases recorded as completed.** Pickle phase shipped 34/37 tickets (3 Skipped: `698924c1` R-CLOSER-2, `010f5c8b` R-CLOSER-3, `4dcf9b43` wiring) and exited code 1 because R-CLOSER-2's release gate failed with 53 test:fast failures. The pipeline immediately halted **before running citadel, anatomy-park, or szechuan-sauce** — three phases that exist specifically to remediate the kind of test/lint/conformance regressions that caused R-CLOSER-2 to fail in the first place.

This contradicts the project's stated design intent: *"the number one goal is to keep working and complete the work even if there are a few test failures or errors as they can be cleaned up in anatomy park or szechuan sauce."* (operator working rule, 2026-05-11).

## Root cause

`extension/src/bin/pipeline-runner.ts:1356-1369` (`shouldHaltAfterPhase`):

```ts
function shouldHaltAfterPhase(
  phase: PhaseName,
  exitCode: number,
  runtime: PipelineRuntime,
): boolean {
  if (exitCode === 0) return false;
  if (phase !== 'citadel') return true;       // ← THE BUG
  const report = readCitadelReport(runtime.sessionDir);
  if (!report) return true;
  const threshold: CitadelSeverity = runtime.config.citadel_strict ? 'High' : 'Critical';
  const shouldHalt = report.findings.some(finding => findingMeetsThreshold(finding, threshold));
  if (!shouldHalt) {
    runtime.log(`citadel: non-zero audit result did not meet ${threshold} halt threshold — continuing`);
  }
  return shouldHalt;
}
```

The logic distinguishes citadel (which has a severity threshold escape hatch — only halts on High/Critical findings) from every other phase (which halts on *any* non-zero exit). Pickle, anatomy-park, and szechuan-sauce have no escape hatch.

The caller at `pipeline-runner.ts:1823`:

```ts
if (shouldHaltAfterPhase(rawPhase, exitCode, runtime)) {
  const haltAction = logPhaseHaltReason(runtime, rawPhase, exitCode, log);
  // … aborts pipeline …
}
```

`logPhaseHaltReason` (`pipeline-runner.ts:1751-1781`) has a `judge_timeout` recovery branch for anatomy-park/szechuan-sauce (per R-PRJT-2, Finding #16) — it can return `'run-finalize-gate'` instead of `'abort'`. **But there is no equivalent recovery branch for pickle exit code 1, even though pickle is followed by exactly the remediation phases that would fix the failure.**

Grep confirms there is no `continue_on_phase_fail`, `keep_going`, `--keep-going`, or `continueOnPhase` flag anywhere in `extension/src/bin/pipeline-runner.ts` or `extension/src/types/`. The behavior is hard-coded.

## Cost of the bug (tonight's evidence)

Session `2026-05-10-84ad0873` shipped 60 commits across the pickle phase, including:
- 8 R-CCNW citadel-wiring tickets (`c3b3f3ae` through `f9831b6e`) — designed to fix citadel coverage gaps
- 8 R-MDS monitor mode-swap fixes
- 10 R-SLLJ LLM-judge non-determinism fixes
- 5 hardening test-quality commits (`47598158`, `8c77afd7`, `3944c19b`, `6d5432a3`, `f754aa4a`)
- 2 audit cross-reference fixes (`d1908171`, `636f8f4f`)

After pickle exited code 1, citadel would have audited these 60 commits against the bundle PRD ACs; anatomy-park would have iterated remediation against the ~70 test:fast residual failures (53 minus what hardening fixed); szechuan-sauce would have polished code quality on the same surface. **None of that ran.** Operator must now file a separate remediation bundle and re-execute the full pipeline cycle (refinement + pickle + closer + …) just to do work that would have run in this session for free.

Compounds with Finding #21 (R-PTG per-ticket test gate gap): even if R-PTG ships and per-ticket workers catch most regressions, any residual that slips through still halts the entire downstream remediation chain instead of using it.

## Why anatomy-park / szechuan-sauce are the right remediation surface

Anatomy-park (`extension/src/bin/anatomy-park-runner.ts`, dispatched via `pipeline-runner.ts:executePhaseRunner`) iterates a microverse loop with `convergence-gate` baselines per iteration — running `tsc + eslint + test:fast` each turn and writing failures as remediation targets. Szechuan-sauce does the same for code-quality findings. They are the project's **automated remediation surface**. Halting the pipeline before they run defeats their purpose. The hardening tickets in bundle 2026-05-10 (`baf22800`, `7d47ae2e`, etc.) are a *manual* version of what anatomy-park does automatically — they exist because the bundle author anticipated closer-gate failures.

## Severity

P1 — defeats the central automation guarantee. Every bundle whose pickle phase ships a non-zero exit (including R-CLOSER-2 fails, which is *by design* when test:fast has regressions) loses 100% of the remediation work it queued. The bundle's cost is doubled: operator must file a remediation bundle and re-run the pipeline.

Climbs to P0 the moment a release-blocking bundle ships during operator off-hours and the operator cannot manually relaunch citadel/anatomy/szechuan in time.

## Fix Requirements

- **R-PHC-1** (R-MUST): `shouldHaltAfterPhase` in `extension/src/bin/pipeline-runner.ts:1356-1369` MUST default to **continue** (return `false`) for non-fatal pickle/anatomy-park/szechuan-sauce exits, even when `exitCode !== 0`. Define "fatal" narrowly: only halt when the runtime cannot proceed (e.g., session-state corruption, missing required artifacts, unrecoverable subprocess crash). Specifically:
  - `exitCode === 0` → continue (unchanged)
  - `phase === 'pickle' && exitCode !== 0` → continue iff `state.json` is readable AND `state.start_commit` is set (downstream phases need it) AND there's at least 1 commit on the bundle branch since `state.start_commit` (i.e., pickle did *some* work)
  - `phase === 'citadel'` → existing severity-threshold logic preserved (unchanged)
  - `phase === 'anatomy-park' || phase === 'szechuan-sauce'` → continue iff `state.json.exit_reason` is not in `MICROVERSE_FATAL_REASONS` (a new narrow allowlist: `judge_cli_missing`, `session_state_corrupted`, `baseline_unmeasurable_unrecoverable`); existing `judge_timeout` recovery preserved (unchanged)

- **R-PHC-2** (R-MUST): `state.pipeline_continue_on_phase_fail` (default `true`) — opt-out for operators who want strict-halt behavior on a specific bundle. Surfaced via `pickle_settings.json` and `--strict-phases` CLI flag (default off). Schema migration: existing state files without the field inherit default `true`.

- **R-PHC-3** (R-MUST): New `recoverable_phase_failure` activity event registered in `extension/src/types/index.ts`. Emitted on every non-fatal phase exit. Fields: `{ phase, exit_code, fatal: false, reason: string, downstream_phases_remaining: PhaseName[], decision: 'continue' | 'abort' }`. Operator can scan `state.json.activity` for `recoverable_phase_failure` events to see all non-fatal exits.

- **R-PHC-4** (R-MUST): `logPhaseHaltReason` (`pipeline-runner.ts:1751-1781`) MUST log a distinct message for the continue path: `Phase ${phase} exited with code ${exitCode} (non-fatal) — continuing to ${nextPhase} for automated remediation`. Operator sees explicit decision in `pipeline-runner.log`.

- **R-PHC-5** (R-MUST): Regression test `extension/tests/pipeline-runner-phase-fail-continue.test.js`. Cases:
  - Pickle exits 1 with at least 1 commit on bundle branch + readable state → pipeline continues to citadel
  - Pickle exits 1 with **zero** commits (worker chain dead before any work landed) → pipeline halts (no remediation surface to work on)
  - Anatomy-park exits with `judge_cli_missing` → pipeline halts (genuinely unrecoverable per Finding #13)
  - Anatomy-park exits with `judge_timeout` → finalize-gate runs (existing R-PRJT-2 behavior preserved)
  - `state.pipeline_continue_on_phase_fail = false` → strict-halt behavior on any non-zero
  - `--strict-phases` CLI flag → same as above
  - Three `recoverable_phase_failure` events emitted across a 4-phase pipeline → all present in `state.activity`

- **R-PHC-6** (R-MUST): Trap-door pin at `extension/src/bin/pipeline-runner.ts` documenting the continue-by-default invariant. INVARIANT: `shouldHaltAfterPhase` returns `false` for non-fatal pickle/anatomy/szechuan exits when downstream remediation phases are queued. BREAKS: bundles whose pickle phase exits non-zero lose 100% of remediation work; cost doubles. ENFORCE: `extension/tests/pipeline-runner-phase-fail-continue.test.js`.

- **R-PHC-7** (R-SHOULD): Phase-cascade gate — when pickle continues to citadel with `pickle_exit_code !== 0`, citadel SHOULD record this in its report header (`pickle_phase_failed: true, pickle_exit_code: <n>`) so anatomy-park and szechuan-sauce can prioritize remediation against the residual failures. Drives whether the bundle is "release-ready" at closer time: if any prior phase exited non-zero, the closer bundle ticket auto-flips to "release: false" and skips the install.sh step.

- **R-PHC-8** (R-SHOULD): `pickle-status` displays "Phase pickle exited with code 1 — pipeline continued to remediation" rather than the misleading "Pipeline finished: 0/4 phases" current behavior. The current message implies catastrophic failure; the reality is "1/4 phases had non-fatal issues, downstream cleanup expected."

- **R-PHC-9** (R-MUST): Bundle PRD template MUST gain a `remediation_phases_required: ["citadel", "anatomy-park", "szechuan-sauce"]` field. When set, this PRD's behavior is the default for the bundle; when omitted, operator MUST explicitly opt in via `--strict-phases`. This documents the design intent at the PRD level, not just runtime.

- **R-PHC-10** (R-MUST): Closer — bump version (minor; new behavioral guarantee), run `bash install.sh`, verify md5-parity, MASTER_PLAN bookkeeping (close Finding #22).

## Out of scope

- Improving anatomy-park or szechuan-sauce's actual remediation capability against the 53-failure-class issues. They run the convergence-gate they have today; if their existing remediator can't fix some classes, that's a separate finding.
- Making the closer ticket (R-CLOSER-2) itself recoverable. R-CLOSER-2 correctly failed the bundle's release gate; the bug is that "release gate failed" was treated as "pipeline failed" instead of "release gate failed, but downstream phases should still try to remediate."
- R-PTG-1..10 (Finding #21 per-ticket gate). R-PHC and R-PTG are complementary: R-PTG prevents failures at ticket commit time; R-PHC ensures failures that *do* slip through get the full remediation chain.

## Sister findings

- **Finding #16 (R-PRJT)** — `judge_timeout` recovery branch already exists in `logPhaseHaltReason` for anatomy-park/szechuan-sauce; R-PHC generalizes that pattern to "exit code 1 from any phase is recoverable by default."
- **Finding #21 (R-PTG)** — per-ticket gate gap. R-PHC is the downstream defense if R-PTG fails to catch a regression.
- **Finding #19 (R-MMTR)** — manager max-turns relaunch. R-PHC handles "phase exited cleanly with non-zero" while R-MMTR handles "manager exited cleanly at cap, misclassified as error." Both contribute to the same automation goal.
- **Working Rule (new)** added 2026-05-11: "**The pipeline's first design goal is to keep working and complete its queued phases.** Test/lint/conformance regressions are expected mid-bundle — anatomy-park and szechuan-sauce phases exist to remediate them automatically. Halting the pipeline before remediation defeats the automation."

## Triggering session

`2026-05-10-84ad0873` — bundle 2026-05-10. Pipeline ran 445m 26s, shipped 60 commits, then halted at `2026-05-11T08:51:39Z` before citadel/anatomy-park/szechuan-sauce ran. R-CLOSER-2 release gate failed with 53 test:fast failures; manager retried, eventually skipped the closer tickets (R-CLOSER-2 status flipped Failed → Skipped via mux-runner's give-up path; R-CLOSER-3 + wiring auto-skipped on dependency); pickle phase exited code 1; `shouldHaltAfterPhase('pickle', 1, runtime)` returned `true`; entire remediation chain abandoned.

## Atomic decomposition

- **R-PHC-1**: rewrite `shouldHaltAfterPhase` with phase-specific continue/halt logic + helper `isFatalPhaseFailure(phase, runtime)` (~80 LOC + helper extraction, 1 commit)
- **R-PHC-2**: `state.pipeline_continue_on_phase_fail` field + `pickle_settings.json` plumbing + `--strict-phases` CLI flag + schema migration (~50 LOC across `pipeline-runner.ts`, `state-manager.ts`, types/index.ts, 1 commit)
- **R-PHC-3**: `recoverable_phase_failure` activity event registration + emission at every non-fatal phase exit (~30 LOC, 1 commit; folds into R-PHC-1)
- **R-PHC-4**: `logPhaseHaltReason` continue-branch message (~15 LOC, 1 commit; folds into R-PHC-1)
- **R-PHC-5**: regression test suite (~120 LOC + fixtures, 1 commit)
- **R-PHC-6**: trap-door pin (~15 LOC docs, 1 commit)
- **R-PHC-7**: citadel report header `pickle_phase_failed` field + closer auto-skip-install when prior phase non-zero (~40 LOC across citadel-runner + closer logic, 1 commit)
- **R-PHC-8**: `pickle-status` reword (~20 LOC, 1 commit)
- **R-PHC-9**: bundle PRD template `remediation_phases_required` field + readiness gate validation (~30 LOC in `check-readiness.ts`, 1 commit)
- **R-PHC-10**: closer (~30 LOC bookkeeping + version bump + install.sh, 1 commit)

Approx 1-day fix. Bundle alongside Finding #19 (R-MMTR), #20 (R-SOA), #21 (R-PTG) in the **pipeline-reliability quartet** — together they close (a) pipeline-killer at manager level (R-MMTR), (b) attribution gap on signal shutdown (R-SOA), (c) per-ticket gate gap (R-PTG), (d) halt-vs-continue policy gap (R-PHC). Shipping all four in one bundle gives the operator complete coverage of "pipeline keeps running automatically through all four phases" guarantees.

## Acceptance criteria (machine-checkable)

- [ ] **AC-PHC-01** — Pickle exits code 1 with ≥1 commit since `state.start_commit` → `shouldHaltAfterPhase` returns `false`; citadel runs next. Regression: 2-phase fixture pipeline.
- [ ] **AC-PHC-02** — Anatomy-park exits with `exit_reason: 'judge_cli_missing'` → `shouldHaltAfterPhase` returns `true` (genuinely unrecoverable; preserves Finding #13 behavior). Regression: state fixture + assert pipeline halts.
- [ ] **AC-PHC-03** — `state.pipeline_continue_on_phase_fail: false` overrides default; pickle exit 1 → pipeline halts. Regression: settings-loader test.
- [ ] **AC-PHC-04** — `--strict-phases` CLI flag → same halt behavior. Regression: CLI parse test.
- [ ] **AC-PHC-05** — `recoverable_phase_failure` event present in `state.activity` for every non-fatal exit; fields validated against schema. Regression: schema test + activity-event-payload test (use `Object.keys(activityEventRegistry).length` per R-PTG-3 lesson, NOT a hardcoded count).
- [ ] **AC-PHC-06** — `pipeline-runner.log` contains `Phase pickle exited with code 1 (non-fatal) — continuing to citadel for automated remediation` for the AC-PHC-01 scenario.
- [ ] **AC-PHC-07** — Citadel report header includes `pickle_phase_failed: true, pickle_exit_code: 1` after AC-PHC-01.
- [ ] **AC-PHC-08** — Bundle PRD missing `remediation_phases_required` field → readiness gate warns (not blocks) on legacy bundles; the warning includes the auto-applied default phase list.

## Working-rule update for MASTER_PLAN

**Add new Working Rule (line ~18, just after the existing line-17 worker rule):**

> "**The pipeline's first design goal is to keep working and complete its queued phases.** Test/lint/conformance regressions are expected mid-bundle — anatomy-park and szechuan-sauce phases exist to remediate them automatically. Halting the pipeline before remediation phases run defeats the automation. Default behavior: `state.pipeline_continue_on_phase_fail: true`; only `--strict-phases` opt-in changes this."

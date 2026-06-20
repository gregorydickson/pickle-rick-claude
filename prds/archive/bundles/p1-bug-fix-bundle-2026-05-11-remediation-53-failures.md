---
title: P1 — bundle 2026-05-11 — remediation of 53 test:fast failures from bundle 2026-05-10 R-CLOSER-2 release gate
status: Draft
filed: 2026-05-11
priority: P1
type: bundle
composes:
  - prds/archive/bug-reports/p1-per-ticket-worker-no-test-gate-cross-ticket-regressions.md
---

# PRD — Bundle 2026-05-11: remediate the 53 test:fast failures from bundle 2026-05-10

**Author**: Pickle Rick
**Project**: `pickle-rick-claude`
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`, local-only

## Bundle gate

**MUST NOT EXECUTE** until the reliability quartet ships: Findings #19 (R-MMTR) + #20 (R-SOA) + #21 (R-PTG) + #22 (R-PHC). Reason: without R-PTG's per-ticket test gate, this remediation bundle will accumulate new regressions exactly the same way bundle 2026-05-10 did. Without R-PHC's continue-on-phase-fail, any residual after this bundle's own closer will halt the pipeline before anatomy-park / szechuan-sauce can clean up.

## Symptom

Bundle 2026-05-10 R-CLOSER-2 (ticket `698924c1`) release gate failed at HEAD `a37c5d70` (now `ade8544a` post-hardening) with **53 unique failing tests in `npm run test:fast`**, clustered into 8 root-cause classes documented in `<session_root>/698924c1/conformance_2026-05-10.md` §3. The bundle's hardening section (`baf22800`, `7d47ae2e`) remediated a portion via commits `47598158`, `8c77afd7`, `3944c19b`, `6d5432a3`, `f754aa4a`, `d1908171`, `636f8f4f` — but the closer chain was abandoned and v1.73.1 not deployed. Residual failure count needs to be re-measured at the start of this bundle (R-REM-A-PREFLIGHT below) and the bundle's per-class sections skip-flip themselves on tickets whose target tests now pass.

## Bundle bootstrap

- **R-REM-A** (R-MUST, 3 tickets — A-01, A-02, A-03 matching the existing bundle-bootstrap pattern):
  - **A-01** `scope.json` — write bundle scope to `${SESSION_ROOT}/scope.json`. Files: `extension/src/**`, `extension/tests/**`, `extension/types/**`, `install.sh`.
  - **A-02** `pipeline.json` — phase config for this bundle. Phases: `pickle` (must pass), `citadel` (audit residual ACs from R-CCNW analyzers shipped in bundle 2026-05-10), `anatomy-park` (subsystem cleanup), `szechuan-sauce` (code-quality polish). With Finding #22 (R-PHC) shipped, all four phases will run regardless of pickle exit code.
  - **A-03** bundle pre-flight assertion — run `cd extension && npm run test:fast 2>&1 | tee preflight.log`. Capture the failing-test set as `${SESSION_ROOT}/preflight_failing_tests.json`. Each per-class section below auto-skips tickets whose target test is **not** in this set (i.e., already fixed). This is the same pre-flight pattern as `dfc77dd9` (R-A-03 from bundle 2026-05-10).

## Section B — Schema/type drift (Class A residual)

- **R-REM-B-1** (R-MUST): Audit every test file that hardcodes an event-count assertion against `VALID_ACTIVITY_EVENTS` or `activityEventRegistry`. Rewrite to use `Object.keys(activityEventRegistry).length` or set-equality against a stable seed. The hardening commit `47598158` did this for `tests/activity-event-payload.test.js`; verify it covers the companion `tests/types.activity-events.test.js` and any sibling counter assertions.
- **R-REM-B-2** (R-MUST): Add a `bun audit-activity-events.sh` (or Node equivalent) gate that compares `activityEventRegistry` keys in source against every test file's `EVENT_CASES` rows; warn on drift. The cross-ref commits `d1908171`, `636f8f4f` from ticket `7d47ae2e` did this manually; bake it into a script.
- **R-REM-B-3** (R-SHOULD): Trap-door at `extension/src/types/index.ts` documenting "event registration MUST update VALID_ACTIVITY_EVENTS, the registry, and all EVENT_CASES test arrays in one commit." ENFORCE: regression test from R-REM-B-1.

## Section C — Orphan-tmp recovery (Class B, ≥10 failures)

- **R-REM-C-1** (R-MUST): Audit every call site that reads `state.json` (or `${SESSION_ROOT}/state.json`) and ensure it routes through `readRecoverableJsonObject` (or `StateManager.read()` equivalent). Sites from conformance §3.B:
  - `jar-runner.ts` bootstrap path (`Invalid JSON` failure)
  - `setup.ts --resume` (multiple cases: stale exit_reason clearance, codex teams conflict, tmux_mode propagation)
  - `spawn-refinement-team.ts` (timeout/backend preference)
  - `mux-runner.ts` (relaunch claim path)
  - `pickle-utils.ts` `inferMonitorMode`, `addToJar`, `restartDeadWatcherPanes` mode-2-command
  - `status.ts` `showStatus` (orphan-tmp snapshot precedence)
- **R-REM-C-2** (R-MUST): Each fix is its own commit per the bundle thesis convention (no cross-cutting refactors). Helper extraction permitted in a single dedicated commit before the per-site sweep.
- **R-REM-C-3** (R-MUST): Trap-door at `extension/src/lib/state-manager.ts` (or wherever `readRecoverableJsonObject` lives) documenting "all state.json reads MUST go through this helper to honor tmp-promotion." ENFORCE: per-site regression tests already present in `tests/` (the failures themselves are the enforcement; this bundle just makes them green).

## Section D — install.sh test drift (Class C residual)

- **R-REM-D-1** (R-MUST): Verify the `8c77afd7` hardening covers all C-class failures listed in conformance §3.C:
  - `AC-ITS-01` install.sh force-rebuild rm pattern (fixed by `8c77afd7`)
  - bun probe — `chmod +x` applied to `plumbus-frame-analyzer.js`
  - install.sh parity gate (R-ITS-1 / R-ITS-2)
  - allow-downgrade-only / force-and-allow `check-update` and install.sh
- **R-REM-D-2** (R-MUST): For any C-class failure NOT covered by `8c77afd7`, write a targeted fix that respects the `efe0e961` refactor shape (find-loop, not literal `rm`).
- **R-REM-D-3** (R-SHOULD): Add `tests/install-script-shape.test.js` that asserts install.sh's structural shape (find-loop for compiled JS rebuild + chmod block + parity gate block) without locking the exact byte-level form. Resilient to future refactors.

## Section E — Citadel pipeline integration (Class D, ≥4 failures)

- **R-REM-E-1** (R-MUST): Audit each Class D failure listed in conformance §3.D:
  - `main inserts citadel between pickle and anatomy and passes report context downstream`
  - `main persists canonical phase transitions before phase execution`
  - `merges anatomy-park and szechuan-sauce findings without double-counting duplicate ids`
  - `citadel cross-phase fixture`
  - `citadel self-test fixtures`
  - `exits cleanly when sibling phase artifacts are absent`
  - `anatomy-park tmux chain invokes finalize-gate.js with anatomy-park skill`
  - `szechuan-sauce tmux chain invokes finalize-gate.js`
- **R-REM-E-2** (R-MUST): The R-CCNW-2 wiring fix (`6049448f` CRITICAL — `wire audit-runner to parseWithComposes for composes: chain walking`) may have already remediated several of these. R-REM-E-1's audit determines which remain. For each remaining failure, write a targeted fix.
- **R-REM-E-3** (R-SHOULD): Cross-phase integration test that pipes pickle → citadel → anatomy-park → szechuan-sauce end-to-end with fixture data; asserts findings flow downstream correctly and dedupe.

## Section F — spawn-morty backend resolution (Class E, 3 failures)

- **R-REM-F-1** (R-MUST): Audit and fix the 3 failures in conformance §3.E:
  - `spawn-morty P2: env backend overrides missing state backend and records env source`
  - `spawn-morty P2: heuristic ON — large tier flips codex → claude`
  - `spawn-morty P2: heuristic ON — UI title flips codex → claude`
- **R-REM-F-2** (R-MUST): Investigate whether `worker_backend_resolved` event emission (per the R-WBS finding referenced in trap-doors) has drifted from the contract. The 3 failures look like precedence-order regressions in the resolver chain.

## Section G — Monitor / pipeline phase dispatch (Class F residual)

- **R-REM-G-1** (R-MUST): The R-MDS-1..8 fixes shipped in bundle 2026-05-10 plus the hardening commits `6d5432a3` `d1908171` `636f8f4f` may have remediated some F-class failures. R-A-03 pre-flight determines residual. For each remaining:
  - `ensureMonitorWindow: explicit mode overrides state-inferred mode` (precedence race between R-MDS-2 `--mode` CLI and R-MDS-3 tick-loop hot-swap)
  - `restartDeadWatcherPanes: mode-specific pane 2 command uses refinement and mux log tail modes`
  - `pipeline phase config dispatch`
  - `plumbus-frame-analyzer — calibration fixtures` (likely unrelated, separate root cause)
  - `frame3-stuck-cell / frame4-mode-a / frame4-mode-b — output matches golden` (golden-output drift; possibly need to regenerate goldens)
- **R-REM-G-2** (R-MUST): For the explicit-mode-overrides-inferred-mode test, codify the precedence: CLI `--mode` > `state.json.step` inference > default. Test with all three sources present + missing.

## Section H — Auto-resume / cap / retry (Class G, 3 failures)

- **R-REM-H-1** (R-MUST): Fix the 3 failures in conformance §3.G:
  - `auto-resume.stop-conditions`
  - `prints [warn] banner past retry 3`
  - `pipeline phase config dispatch` (overlaps Class F; investigate whether one fix closes both)

## Section I — Other (Class H, ≥10 failures)

- **R-REM-I-1** (R-MUST): The Class H grab bag (`checkForUpdate`, `processRateLimitCycle`, `computeOneHop`, `random-sample cohort recall baseline`, etc.) likely contains multiple unrelated root causes. R-REM-I-1 is one ticket per failing test (estimate 10+ atomic tickets). Each ticket: identify root cause, fix or update test, regression.

## Section J — Closer

- **R-REM-J-1** (R-MUST): Run full release gate. Per Finding #22 (R-PHC), the bundle continues to citadel/anatomy-park/szechuan-sauce even if this gate has residual failures — they'll get one more remediation pass automatically.
- **R-REM-J-2** (R-MUST): If release gate green: bump version (likely v1.73.2 or v1.74.0 depending on R-MMTR/R-SOA/R-PTG/R-PHC scope), run `bash install.sh`, verify md5-parity 5/5.
- **R-REM-J-3** (R-MUST): MASTER_PLAN bookkeeping — close Open Findings #14/#15/#17 if their PRDs are now fully shipped (bundle 2026-05-10 + this bundle); update **Last updated** narrative; archive shipped PRDs.

## Estimated scope

- Section A bootstrap: 3 tickets (existing pattern; ~30 min)
- Section B (schema drift): 3 tickets (~1-2h; mostly cleanup since hardening did the bulk)
- Section C (orphan-tmp): ~10 per-site tickets + 1 helper extraction (~half day; this is the largest section)
- Section D (install.sh): 3 tickets (~1h)
- Section E (citadel): ~4-8 tickets depending on residual (~2-4h)
- Section F (backend): 3 tickets (~1-2h)
- Section G (monitor): ~5 tickets (~2-3h)
- Section H (auto-resume): 3 tickets (~1-2h)
- Section I (other): ~10+ tickets (~half day)
- Section J closer: 3 tickets (~30 min)

**~45-55 atomic tickets total, ~1.5-2 day pipeline run.** Comparable to bundle 2026-05-10's 37-ticket atomic decomposition.

## Working-rule reminder

Per the new Working Rule from Finding #22 (R-PHC) — once that PRD ships:

> "The pipeline's first design goal is to keep working and complete its queued phases. Test/lint/conformance regressions are expected mid-bundle — anatomy-park and szechuan-sauce phases exist to remediate them automatically. Halting the pipeline before remediation phases run defeats the automation."

This bundle takes that rule literally: if pickle phase ships some Skipped tickets or the closer gate has residual failures, citadel/anatomy-park/szechuan-sauce automatically run and clean up. Operator does not need to file a tertiary remediation bundle.

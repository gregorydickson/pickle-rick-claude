# P2 Bug-Fix Bundle — R-ITIH: integration-testing isolation + timeout/coverage hardening

**Finding:** #109 R-ITIH (MASTER_PLAN). **Priority:** P2 (the active data-loss vector — a test committing the operator's real repo — is ALREADY FIXED in `7bfa27f6`; this bundle is defense-in-depth + the systemic integration-testing debt the incident exposed).
**Source:** Read-only agent-team re-examination of the integration-testing approach, 2026-06-09, triggered by a live R-WTIV incident (a test ran `git commit`/`git reset --hard` against the REAL repo during an integration run, sweeping the operator's uncommitted fix bundle into a rogue `fix(ok0001): commit-and-continue recovery (R-ORSR-2)` commit; caught + recovered).

## Background — the incident (already fixed, context only)

`extension/tests/integration/gate-skip-activity-events.test.js` wrote `state.json.working_dir = REPO_ROOT` and spawned the real `mux-runner.js` with an `EPIC_COMPLETED` claude stub. The runner's gate-passing exit path (`commitGatePassingDeliverableOnExitPath` → `commitAndContinueDoneFlip`, `mux-runner.ts:3719-3726`) ran `git -C REPO_ROOT add -A && commit` (+ `resetToSha`, `git-utils.ts:189`) against the real repo. It sandboxed `PICKLE_DATA_ROOT` (session data) but NOT the git working tree. Latent: no-ops on a clean tree, destructive on a dirty one. **Fixed in `7bfa27f6`** (the test now uses a throwaway tmp git repo as `working_dir`). The two other `ok0001`-fixture suspects (`mux-runner.test.js`, `check-readiness.test.js`) were cleared: neither sets `working_dir` to the real repo while spawning a git-mutating session bin.

This bundle closes the *class*, not just the one test.

## Measured systemic state (from the audit)

- **42 of 119 integration files (~35%) are forced serial** via `tests/integration/.serial-tests.json` — a hand-maintained, unannotated quarantine that only grows.
- **~279 test files spawn real subprocesses.** Internal subprocess-timeout histogram: ~51 at 10s, ~28 at 5s, plus 45s/30s/60s bands.
- **`audit-subprocess-heavy-tests.sh` only flags `timeout ≤ 5000ms`** (R-TFP-C2 trap-door, `SUBPROCESS_HEAVY_TIMEOUT_MS=5000`) — the entire 10s band (~51 tests) is invisible to forward-protection. `pntr-pickle-deprecated.test.js` (106ms isolated, ~10004ms under c=8) starved deterministically under load and was patched only by a manual serial-manifest entry.
- **Test correctness is coupled to machine load** through tight internal subprocess timeouts that double as performance assertions.

## Acceptance Criteria

- [ ] **AC-R-ITIH-1 — working-tree isolation guard (priority).** Extend `audit_session_bin_sandbox` in `extension/scripts/audit-test-isolation.sh` so that, for any test that spawns a session-writing bin (`mux-runner.js`/`spawn-morty.js`/`setup.js`/`jar-runner.js`), the audit FAILS when the spawn window also contains `working_dir: REPO_ROOT`, `working_dir: process.cwd()`, or an equivalent real-repo `working_dir`. It MUST NOT flag `EXTENSION_DIR: REPO_ROOT` (read-only, legitimate) and MUST NOT flag tests that spawn no session bin (e.g. `check-readiness.test.js`). Add a fixture test proving (a) the bad pattern is caught and (b) the two legitimate cases pass. — Type: test + audit-script
- [ ] **AC-R-ITIH-2 — source fail-safe for missing working_dir.** Replace the `|| process.cwd()` fallbacks on the git-mutating recovery/exit-commit `workingDir` resolution paths in `extension/src/bin/mux-runner.ts` (the commit-and-continue / gate-passing-exit / reset sites) with validate-or-halt: a missing/empty `state.working_dir` MUST `recordExitReason('state_working_dir_missing') + safeDeactivate` rather than defaulting to the process cwd. Add a `PICKLE_TEST_MODE` assertion in `commitAndContinueDoneFlip` (`mux-runner.ts:3719`) and `resetToSha` (`git-utils.ts:189`) that, when `PICKLE_TEST_MODE` is set, asserts `workingDir` resolves under `os.tmpdir()` before any `git add`/`commit`/`reset` (mirrors `backend-spawn.ts:assertAddDirsUnderTmpdirIfTestMode`). Recompile the `.js` mirror in the same change. — Type: test + typecheck
- [ ] **AC-R-ITIH-3 — close the audit 10s blind spot.** Raise `SUBPROCESS_HEAVY_TIMEOUT_MS` (or add a second `load-sensitive` WARN tier) in `extension/scripts/audit-subprocess-heavy-tests.sh` so the 6000–15000ms band is covered; update the R-TFP-C2 trap-door note in `extension/CLAUDE.md` and the enforcing `extension/tests/audit-subprocess-heavy-tests.test.js` (the `5000` PATTERN_SHAPE) to match. Wire `pretest:integration` in `extension/package.json` to run `audit-test-isolation.sh` + `audit-subprocess-heavy-tests.sh` (today only `pretest:fast` does). — Type: test + audit-script
- [ ] **AC-R-ITIH-4 — serial-manifest hygiene.** Annotate every entry in `tests/integration/.serial-tests.json` (or a committed sidecar) with its root-cause class (`real-repo-isolation` | `subprocess-timeout-coupling` | `process-global-state` | `subprocess-spawn-timing` | `load-dependent-timeout`). Document the "a subprocess timeout is a hang-guard (≥30s), not a perf-assertion; serialize via the manifest when concurrency is the real constraint" principle in `extension/CLAUDE.md`. — Type: doc + config
- [ ] **AC-R-ITIH-5 — coverage classification (analysis deliverable).** Produce a committed `docs/integration-test-coverage-audit.md` classifying the subprocess-spawning integration tests into `genuine-e2e` / `should-be-unit` / `flake-risk`, with a recommended migration list for the `should-be-unit` cohort (interface-as-test-surface). Migration itself is OUT OF SCOPE for this bundle (separate follow-up) — this AC delivers the verified classification + plan only. — Type: doc
- [ ] **AC-R-ITIH-6 — lint + typecheck + full gate green.** `npx tsc --noEmit`, `npx eslint src/ --max-warnings=-1`, all 7 audit scripts, `test:fast` (c=4), `test:integration`. — Type: typecheck + test

## Out of Scope

- Migrating the `should-be-unit` cohort to unit tests (AC-5 produces the plan; execution is a separate bundle).
- Replacing the serial-manifest mechanism with full auto-routing (annotate now; auto-routing is a future epic if the manifest keeps growing).

## Notes

The `process.cwd()` fallback (AC-2) is the secondary/parallel exposure, NOT the incident's trigger (the incident had a populated `working_dir`); do not regress the framing — the test bug (`7bfa27f6`) was the trigger, this is defense-in-depth. The audit found `|| process.cwd()` at ~16 sites in `mux-runner.ts`; only the git-mutating recovery/exit/reset paths need the validate-or-halt treatment — read-only cwd defaults elsewhere are lower-risk and can stay or be addressed conservatively.

Relates to memory `feedback_loop_failure_log_bug_prd_and_master_plan` and the R-TFP / R-TSPF flake-stabilization lineage in `extension/CLAUDE.md`.

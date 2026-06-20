---
title: P1 — test flake `auto-resume.stop-conditions > prints [warn] banner past retry 3` fails under parallel load; poisons every ticket's test:fast AC
status: Draft
filed: 2026-05-13
priority: P1
type: bug
r_code_prefix: R-ARSF
backend_constraint: any
related:
  - prds/archive/bug-reports/p2-worker-manager-wedge-oversized-ticket-no-artifact-progress.md  # R-WMW — sibling: prevents wedge once flake stops triggering deferrals
  - prds/archive/bug-reports/p1-mmtr-cleanup-heal-deferred-tickets-to-done.md                  # R-MMTRH — depends on this fix landing first
---

# P1 — auto-resume.stop-conditions banner-past-3 flake poisons test:fast AC gate

## Why this is urgent

Every ticket's worker-completion gate runs `cd extension && npm run test:fast` and requires it green to flip `status: Done`. The test `auto-resume.stop-conditions > prints [warn] banner past retry 3` (in `extension/tests/auto-resume-stop-conditions.test.js`) is flaky under parallel load (Node's default `--test-concurrency=8`). Observed deferral rate in session `2026-05-13-c122b0f7`: **3 of 4 R-MMTR tickets** (R-MMTR-2/3/4) flipped to `# DEFERRED:` because of this single flake, even though their ticket-scoped tests, lint, and tsc all passed. Operator-facing impact: ~75% of long-pipeline tickets show `Skipped` instead of `Done`, completion dashboards underreport, and bundles look like failures when the work shipped fine.

## Reproduction

```bash
cd extension
# Pass solo:
node --test --test-concurrency=1 tests/auto-resume-stop-conditions.test.js  # green
# Pass parallel with concurrency 8 (default `npm run test:fast` runner):
npm run test:fast 2>&1 | grep -c "auto-resume.stop-conditions"  # observed ≥1 failure per ~3 runs
```

Failure mode: the test asserts that a "[warn] auto-resume retry N/M (no progress for K cycles)" banner is emitted on stderr after retry 3, but under parallel load the banner is occasionally missing or arrives out of order. The cause is shared mutable state across test cases that compete for stderr capture, OR a race in the auto-resume.sh subprocess spawn timing, OR a `setInterval` / `setTimeout` not properly mocked when other tests run concurrently.

## Acceptance Criteria

- **AC-1:** `extension/tests/auto-resume-stop-conditions.test.js` passes **10 consecutive runs** under `node --test --test-concurrency=8 tests/auto-resume-stop-conditions.test.js` AND under full `npm run test:fast` invocation.
- **AC-2:** Root cause identified and documented in the commit message (one of: shared stderr buffer collision, setInterval timing race, subprocess spawn order dependency, fixture file mutation across tests, etc.).
- **AC-3:** Fix preserves the test's original intent: still asserts the banner emits past retry 3, still uses the R-CNAR-4 trap-door invariant (`prints [warn] banner past retry 3`).
- **AC-4:** No regression in adjacent auto-resume tests (`auto-resume-on-cap-hit.test.js`, anything else in the auto-resume.sh family).
- **AC-5:** If serialization is the chosen fix (single-test-file concurrency=1), it's documented in `tests/test-registration-hygiene.test.js` allowlist with a `serialize_reason: 'stderr_capture_race'` comment.
- **AC-6:** `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npm run test:fast && npm run test:integration` all pass; `RUN_EXPENSIVE_TESTS=1 npm run test:expensive` passes if applicable.

## Implementation Investigation Order

1. **R-ARSF-1: Diagnose**: Run the test 20× under parallel load and capture stderr + timing diff vs solo. Identify whether the flake is (a) banner missing, (b) banner content wrong, (c) banner out of order vs other assertions, (d) test exits before banner is captured.
2. **R-ARSF-2: Isolate root cause**: Based on R-ARSF-1 findings, narrow to one of {stderr capture race, subprocess spawn race, fixture mutation, fake-timer interaction, env-var collision}. Document hypothesis with evidence.
3. **R-ARSF-3: Fix**: Apply the targeted fix. Options ranked by preference:
   - **Best**: Make the test self-isolating — per-test tmpdir, fresh subprocess per case, no shared mutable state.
   - **Acceptable**: Use a per-test stderr buffer instead of process-level stderr capture.
   - **Last resort**: Serialize this test file (run with concurrency=1) — requires R-ARSF-5 allowlist entry.
4. **R-ARSF-4: Validate**: 10 consecutive parallel runs green. Include the validation command in the commit message.
5. **R-ARSF-5: Document**: If serialization chosen, allowlist + reason in `test-registration-hygiene.test.js`. Either way, add a trap-door entry to `extension/src/bin/CLAUDE.md` so future regression of the fix is detected.
6. **R-ARSF-6: Closer**: Update changelog, version bump if shipping as a release, finalize.

## Out of Scope

- Refactoring `auto-resume.sh` itself (not the bug location; sh script is solid).
- Other test flakes (`extension/tests/microverse.test.js:191`, `mux-runner.output-stall.spec.js:181`) — separate PRDs needed if confirmed flakes.
- Replacing Node test runner with a different framework — way too big a swing for one flake.

## Downstream impact when shipped

Workers running `test:fast` as their gate will reliably see green when the code is correct. Expected effects:
1. Auto-skip-on-`acceptance_criteria_not_checked` path stops firing for tickets whose only failing AC was "tests pass"
2. Deferral rate drops from ~75% to near-0% for test-gate AC-N
3. R-MMTRH heal script becomes the cleanup mechanism (NOT a structural fix)
4. Long-pipeline (20+ ticket) bundles can actually reach completion at expected throughput (~10-15 min per shipped ticket vs ~40 min observed)

# BUG-2026-08-18 — the subprocess audit fabricates a violation from a regex `.exec()`, and FR-B10 is the third fixture-cap instance

## Status

Open. Branch `release/v2.1-beta`, measured at HEAD `e39b9bca`. HEAD is RED and the release gate is
blocked: `pretest:integration` runs the audit that fails below.

## Summary

Two defects, both blocking `test:integration:serial`, filed together because both are test-surface
work on the same tier and neither is large enough to justify its own bundle.

**Defect 1 (self-caused, P0).** `bash scripts/audit-subprocess-heavy-tests.sh` exits 1 with:

```
tests/timeout-e2e-oracle-invariant.test.js: new missing-timeout exec(...) callsite not in baseline
  (tests/timeout-e2e-oracle-invariant.test.js::exec::4237344f4d)
```

The flagged callsite is `extension/tests/timeout-e2e-oracle-invariant.test.js:40`:

```js
while ((m = re.exec(sourceText))) {
```

That is `RegExp.prototype.exec` — a pure string operation. It spawns no subprocess, so a timeout is
meaningless on it. The audit's pattern matcher cannot distinguish `RegExp.prototype.exec` from
`child_process.exec`, so it fabricates a missing-timeout violation. This is the same family as
`R-GBANNER` (the gate parser reporting an npm banner line as a test name): a scanner reporting
something that does not exist.

The oracle file was added by `e39b9bca` (ticket `bb01af94`) as the durable replacement for a vacuous
AC-7. The file is correct; the audit is wrong about it.

**Defect 2 (pre-existing, P1).** `FR-B10: fixture manager sleeps 120% of its worker_timeout budget,
writes artifact, no SIGTERM` (`extension/tests/timeout-happy-path.test.js:45`) fails with the exact
signature just fixed in its two siblings:

```
Artifact not written — subprocess was killed before completing (exit: 1, signal: null)
```

`signal: null` means it was not signalled. Its caps are outer `timeout: 60_000` (`:45`) and inner
`spawnSync` `timeout: 45_000` (`:113`), while measured runs of the test take **53.0s and 57.7s**. The
inner cap sits below the work. Bundle `2026-08-18-e8c96961` re-budgeted the two
`timeout-e2e.test.js` fixtures from measured wall-clock (`5a141716`, `8102d3ae`) but did not scope
this third instance of the same class.

## Measured evidence (operator-run, 2026-08-18)

Serial tier at `e39b9bca`, canonical env scrub, `PICKLE_TEST_RUNNER_TIMEOUT_MS=7200000`, verdict from
the run's own `EXIT=` sentinel. Run **twice** — once after two other tiers, once alone on a quiet box —
with identical results, so neither failure is contention:

| run | tests | suites | fail | cancelled | duration | EXIT |
|---|---|---|---|---|---|---|
| after parallel+fast | 603 | 24 | 2 | 0 | 1557.6s | 1 |
| alone, quiet box | 603 | 24 | 2 | 0 | 1476.7s | 1 |

Both failures are the two defects above. **The two `timeout-e2e.test.js` tests that were red before
this bundle now PASS** — that half of the previous PRD worked.

`test:integration:parallel` at the same sha: 622 tests / 21 suites / fail 0 / cancelled 0 / EXIT=0.

Audit run directly at HEAD: `AUDIT_EXIT=1`, one fabricated violation (Defect 1) plus two genuinely
non-failing `WARN:` lines (`audit-subprocess-heavy-tests-missing-timeout.test.js`,
`regression-test-fast-integration-3x.test.js`) which are stderr noise, not the cause.

## Acceptance criteria

- **AC-1** `cd extension && bash scripts/audit-subprocess-heavy-tests.sh` exits 0 at HEAD, with no line matching `timeout-e2e-oracle-invariant` in its output.
- **AC-2** The fix is in the audit's candidate matcher, not the baseline file. Registering the callsite in the missing-timeout baseline is explicitly REJECTED: it would silence a false positive by asserting the false thing is intentional, and the next regex `.exec()` in any test file would fail the gate again.
- **AC-3** A test pins the discrimination: a fixture containing `re.exec(text)` / `someRegex.exec(s)` produces NO candidate, while a fixture containing an un-timed `child_process.exec(...)` still produces one. Both directions in one test file, so the fix cannot be a blanket `exec` exclusion that blinds the audit to the real class.
- **AC-4** `extension/tests/timeout-e2e-oracle-invariant.test.js` is not edited to dodge the audit. The `re.exec` loop stays (or is replaced only for reasons unrelated to this audit, stated in the ticket).
- **AC-5** `FR-B10`'s two caps are re-budgeted from measured wall-clock, using the same method as `5a141716`/`8102d3ae`: at least 3 uncapped runs recorded in the ticket, inner `spawnSync` cap set with stated margin over the slowest, outer node-test timeout strictly above the inner cap. The measured numbers go in a comment, replacing any unmeasured "for system load" prose.
- **AC-6** `cd extension && env -u PICKLE_TICKET_ID -u PICKLE_WORKER_TEST_FAST_TIMEOUT_MS -u PICKLE_DATA_ROOT -u PICKLE_DATA_DIR -u TMUX -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_SYSTEM -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 PICKLE_TEST_RUNNER_TIMEOUT_MS=7200000 npm run test:integration:serial` reports `fail 0` and `cancelled 0` with `EXIT=0`.
- **AC-7** `npm run test:integration:parallel` still reports `fail 0` / `cancelled 0`, test count >= 622, suites >= 21.
- **AC-8** `npm run test:fast` reports `fail 0` / `cancelled 0`, test count >= 7736, suites >= 508. Note the count already grew to 7736 with the oracle file; a shrink is a regression.
- **AC-9** No test is deleted, skipped, `todo`'d, or dropped from the serial manifest. The oracle shipped in `e39b9bca` already pins this for the `timeout-e2e` pair; do not weaken it.

## Non-goals

- The four `test:fast` failures observed at `e39b9bca` (three `mux-runner.test.js` "iteration events",
  one `node-modules-reuse`). They were measured under operator-induced load — the tier took 2023.8s
  against 946.3s for the same tier earlier the same day — and all four are known load-sensitive
  suites. They must be re-measured quietly before anyone calls them a defect. AC-8 will surface them
  if they are real.
- Any capability work.

## Simplification Review

1. **What can be deleted instead of added?** Defect 1's fix should make the matcher *narrower*, not add
   another allow-list. The baseline file is already an accretion sink; do not feed it.
2. **Is there an existing seam?** Yes — the matcher already classifies FAIL vs WARN bands in one place
   (`extension/scripts/audit-subprocess-heavy-tests.sh`, the `find_heavy_candidate` node snippet).
   The receiver-qualification test belongs there, not in a new pass.
3. **Does this add a new abort condition?** No. Neither defect may add a halt path; both are gate-local.
4. **What accretion does this remove?** One fabricated-violation class from a release-gate audit, and
   the last unmeasured "for system load" cap comment in the timeout fixture family.

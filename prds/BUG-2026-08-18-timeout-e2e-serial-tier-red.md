# BUG-2026-08-18 — timeout-e2e keeps the integration serial tier red

## Status

Open. Branch `release/v2.1-beta`, measured at HEAD `98759471`.

## Summary

`npm run test:integration:serial` fails with 2 failures, both in
`extension/tests/integration/timeout-e2e.test.js`. This is the last red tier on the branch;
`test:fast` and `test:integration:parallel` are both green at the same sha.

The failures are **pre-existing** — they are not caused by the attempt-2 bundle
(`prds/BUG-2026-08-17-serial-tier-attempt-2-measure-the-right-window.md`, commits `c92fa410`
… `98759471`). That bundle re-scoped the fixtures' premise but did not make the tier green,
which was its point.

## Measured evidence (operator-run, 2026-08-18)

Full-tier measurement at HEAD `98759471`, canonical env scrub,
`PICKLE_TEST_RUNNER_TIMEOUT_MS=7200000`, verdict from each log's own `EXIT=` sentinel:

| tier | tests | suites | fail | cancelled | EXIT |
|---|---|---|---|---|---|
| test:fast | 7728 | 508 | 0 | 0 | 0 |
| test:integration:parallel | 622 | 21 | 0 | 0 | 0 |
| test:integration:serial | 603 | 24 | 2 | 0 | 1 |

### F1 — failure 1 is deterministic and is not a kill

`timeout-e2e: manager runs 150% of worker_timeout_seconds unkilled, writes artifact`
(`extension/tests/integration/timeout-e2e.test.js:46`, assertion at `:113`).

```
AssertionError [ERR_ASSERTION]: artifact not written — subprocess was killed before
completing (exit: 1, signal: null)
```

`signal: null` with `exit: 1` means the mux-runner subprocess was **not** signalled — it
exited 1 on its own. The fixture's fake `claude` never ran, so the artifact was never
written. The assertion message's "was killed" wording is therefore misleading about its own
failure mode.

### F2 — the subprocess dies after startup with no FATAL line

The captured stderr tail (last 500 chars, so anything printed after would appear) ends at:

```
[state-manager] migrating .../session/state.json to schema_version 5
ensureMonitorWindow: not inside tmux, skipping
phantom-Done watcher: installed=0 skipped=0
WARN: ticket_state_desync check found no ticket directories
```

That WARN is `extension/src/bin/mux-runner.ts:1354`. Elapsed from first line to the WARN is
~19s, then exit 1 with nothing further — no `[FATAL]`, no exit-reason stamp. The fixture
session directory contains no ticket directories at all.

### F3 — failure 2 is contention-sensitive, not deterministic

`timeout-e2e: session deactivated by subprocess → mux-runner exits cleanly`
(`extension/tests/integration/timeout-e2e.test.js:145`, assertion at `:205`) failed in the
tier with `active: true !== false` after 48.7s, against an inner `spawnSync` cap of 30_000ms
and a node test timeout of 45_000ms.

Run standalone at the same HEAD it **passes** in 24.6s. So the tier failure is the fixture
exceeding its own inner cap under load, not a runtime defect in deactivation. Note
`c92fa410` (mux-runner FATAL path deactivate) is unrelated to this assertion — the test wants
deactivation and gets it when it has time to finish.

### F4 — both failed before the attempt-2 bundle started

Same single-file run in a detached worktree at `b91025d5` (the bundle's `start_commit`):
2 tests, 0 pass, **2 fail**. Attempt 2 neither introduced nor fixed these.

## Root cause (to be established by this bundle)

Unknown at filing time, and the research phase must establish it rather than assume it. The
open question is why the fixture mux-runner exits 1 roughly 19s into startup, after the
no-ticket-directories WARN, without printing a FATAL line. Candidate seams, all to be
verified against source before any edit:

- the no-ticket-directory path in `extension/src/bin/mux-runner.ts` around `:1354`
- a silent `process.exit(1)` on a startup-validation path that predates the fixture's first
  manager spawn
- fixture state shape: the fixtures write a hand-rolled `state.json` with 8 fields and no
  ticket directories, which no production session ever looks like

## Acceptance criteria

- **AC-1** `cd extension && env -u PICKLE_TICKET_ID -u PICKLE_WORKER_TEST_FAST_TIMEOUT_MS -u PICKLE_DATA_ROOT -u PICKLE_DATA_DIR -u TMUX -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_SYSTEM -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 PICKLE_TEST_RUNNER_TIMEOUT_MS=7200000 npm run test:integration:serial` reports `fail 0` and `cancelled 0` in its own summary block, and its `EXIT=` sentinel is 0.
- **AC-2** The same command for `npm run test:integration:parallel` still reports `fail 0` / `cancelled 0`, with suite count >= 21 and test count >= 622.
- **AC-3** `npm run test:fast` still reports `fail 0` / `cancelled 0`, with test count >= 7728 and suite count >= 508. A shrinking count is a regression, not a fix.
- **AC-4** The research artifact names the exit path that produces `exit 1, signal null` in F2, citing a repo-root-relative `file:line` that exists at HEAD, and states whether it is a runtime defect or a fixture-shape defect.
- **AC-5** If the verdict is fixture-shape: the failure message at `extension/tests/integration/timeout-e2e.test.js:113` no longer claims the subprocess "was killed" when `signal` is null. The message must distinguish a signalled kill from a self-exit and include the exit status.
- **AC-6** The test named at `extension/tests/integration/timeout-e2e.test.js:145` no longer fails from contention alone: either its inner `spawnSync` cap and its node test timeout are made consistent (inner cap strictly below the outer timeout, with headroom stated in a comment), or the reason it cannot be is recorded in the ticket.
- **AC-7** Neither test is deleted, skipped, quarantined, or converted to `todo`. `git diff --stat b91025d5..HEAD -- extension/tests/integration/timeout-e2e.test.js` must show the file still contains 2 `test(` declarations.
- **AC-8** No assertion is weakened to pass. Any assertion that changes must be justified in the ticket against F1–F4, and the mutation check is: reverting the production fix (if any) must turn the tier red again.

## Non-goals

- The worker-lock bundle (`prds/BUG-2026-08-14-concurrent-workers-per-session.md`). It is
  gated behind a green tier and stays gated.
- Any capability work. Reliability only.
- Re-litigating the attempt-2 re-scoping of the `worker_timeout_seconds` premise. That
  landed as `1ddf0077` and F4 shows it is not the cause here.

## Simplification Review

1. **What can be deleted instead of added?** If the fixture's hand-rolled `state.json` is the
   defect, the fix is to stop hand-rolling it (reuse the existing session-fixture helper),
   not to add fields until the runner is satisfied.
2. **Is there an existing seam?** Yes — the other integration fixtures that successfully
   drive `mux-runner.js` already construct sessions that survive startup. Prefer whatever
   they do over a new helper.
3. **Does this add a new abort condition?** It must not. Nothing in this bundle may add a new
   halt path to the runtime.
4. **What accretion does this remove?** Two long-lived fixtures that have been red across at
   least one full bundle, and an assertion message that misreports its own failure mode.

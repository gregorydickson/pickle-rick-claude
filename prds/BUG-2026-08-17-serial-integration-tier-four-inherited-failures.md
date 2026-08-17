# BUG (P2): the serial integration tier's four inherited failures — B-CIINT, never actually run

- **Date**: 2026-08-17
- **Priority**: P2 (reliability — the only red tier at `v2.1.0-beta.10`)
- **Branch**: `release/v2.1-beta`
- **Measured at**: `0d7e58dc` — `test:integration:serial` **602 tests / 24 suites / pass 598 / fail 4 /
  cancelled 0 / EXIT=1**, with `test:integration:parallel` green at 622 / fail 0 and `test:fast` green at
  7723 / fail 0.

## The four failures

| # | test | file:line | shortest decisive line |
|:--|:--|:--|:--|
| 1 | PC-4: refinement worker 2-of-3 crash kills siblings | `extension/tests/integration/process-cleanup.test.js:245` | `spawn-refinement-team should complete in < 30s, took 47212ms (siblings not killed?)` |
| 2 | timeout-e2e: manager sleeps 95% of budget … no SIGTERM | `extension/tests/integration/timeout-e2e.test.js:28` | `artifact not written — subprocess was killed before completing (exit: 1, signal: null)` |
| 3 | timeout-e2e: session deactivated by subprocess → mux-runner exits cleanly | `extension/tests/integration/timeout-e2e.test.js:112` | `session deactivated` (`true !== false`) |
| 4 | FR-B10: fixture manager sleeps 95% of worker_timeout budget … no SIGTERM | `extension/tests/timeout-happy-path.test.js:31` | `Artifact not written — subprocess was killed before completing (exit: 1, signal: null)` |

## Established facts — do not re-derive these

- **All four are INHERITED.** A detached worktree at `c87c3a3f` reproduces all four with byte-identical
  assertion messages and matching timings. Each arm ran its own `extension/bin/mux-runner.js` (the test
  resolves `MUX_RUNNER_BIN` relative to itself), so the comparison is source-vs-source.
- **Not env contamination.** They reproduce under a fully scrubbed `PICKLE_*` / `GIT_CONFIG_*` env.
- **They were never "passing locally".** MASTER_PLAN row 119 (B-CIINT) listed #2 and #4 as CI-only and
  claimed local green. False: `test:integration` is `parallel && serial`, a red parallel short-circuits
  the serial tier, so the serial tier had never executed. Row reclassified P3 → P2.
- **The introducing commit is NOT pinned.** Bisecting needs a per-commit rebuild of the compiled mirror.
  The `WARN: ticket_state_desync check found no ticket directories` line preceding mux-runner's `exit 1`
  predates the bundle by a wide margin.
- **A tier measurement taken while a worker is live is not evidence.** One `test:fast` run scored 12
  failures purely from spawn-lock contention (6 were `spawn-morty` subprocess tests at 100–157s); the
  same tree on a quiet box scored 0. Measure on a quiet box or the result is noise.

## Shape of the problem

Three of the four (#2, #3, #4) are one family: a fixture manager that sleeps most of its timeout budget
is being **killed before completing** (`exit: 1, signal: null`) instead of being allowed to finish or
receiving a SIGTERM the test can observe. #1 is the sibling-kill path: a refinement worker crash should
kill its siblings within 30s and took 47s.

Both shapes are about process lifetime and teardown — the same subsystem as the spawn lock and the
orphan reaper shipped in `v2.1.0-beta.10`. Check whether those interact with these paths before assuming
the defects are independent of them.

## Acceptance criteria

- **AC-1 — attribute each failure before fixing it.** For each of the four, state whether the product
  behaviour or the test's expectation is wrong, with the source line as evidence. `exit: 1, signal: null`
  means killed-not-signalled: identify WHAT killed it.
- **AC-2 — no assertion retuning.** Do not widen a timeout, relax an inequality, skip, quarantine, or
  `.only`-narrow any of the four to make the tier green. If a budget is genuinely wrong, justify the new
  number against a measurement.
- **AC-3 — serial tier green.** `npm run test:integration:serial` reports `fail 0` AND `cancelled 0`.
- **AC-4 — both sub-tiers green together.** `npm run test:integration` emits summary blocks for BOTH
  sub-tiers, each `fail 0` / `cancelled 0`. A green serial run alone does not satisfy this.
- **AC-5 — fast tier holds.** `npm run test:fast` reports `fail 0` AND `cancelled 0`, count not below
  7723, measured on a quiet box with no live worker, read from the runner's own summary block.
- **AC-6 — no new terminal condition, no new operator surface.** No new `exit_reason`, no new abort site,
  no new setting key, no new flag. A teardown fix must not become a new way to halt a run.
- **AC-7 — update the ledger row.** MASTER_PLAN row 119 (B-CIINT) records the outcome, and its
  "pass locally" claim stays corrected.

## Attempt 1 outcome — session `2026-08-17-8de06e9e`: RAN TO COMPLETION, DID NOT SUCCEED

3/3 tickets Done, `EPIC_COMPLETED`, 6 iterations / 144m, 5 commits (`73a34239`, `c32408b1`, `18a77e44`,
`99d95392`, `54784d41`). Operator-run `npm run test:integration` on a quiet box at that HEAD:

| sub-tier | result | AC |
|:---|:---|:---|
| parallel | `tests 622 / suites 21 / pass 622 / fail 0 / cancelled 0` | AC-4 half satisfied |
| serial | `tests 602 / suites 24 / pass 598 / fail 4 / cancelled 0` | **AC-3 NOT MET** |

Both summary blocks emitted, so the reporting half of AC-4 holds. The same four tests still fail.

**What the attempt DID establish (keep, do not re-derive):**
- **The failures are partly contamination, and my PRD's "not env contamination" line was WRONG.** It was
  true of the operator's shell and false of the FIXTURES: they spawned children passing ambient env down.
  `c32408b1` scrubs `GIT_CONFIG_*` / `PICKLE_TICKET_ID` from mux-runner fixture spawns; `73a34239` /
  `18a77e44` make fixtures resolve their OWN `EXTENSION_DIR` / extension root, which is why they were
  dying `exit: 1, signal: null` instead of finishing.
- **The fixes moved the numbers without clearing the bar.** PC-4: **47212ms → 38200ms** against a 30s
  assertion. The timeout trio now run 49441ms / 52960ms / 89047ms.
- Assertions were NOT retuned, nothing skipped or quarantined (AC-2 held).

**Open question attempt 2 must answer first:** are these wall-clock BUDGET assertions that this machine
cannot meet, or is there still real teardown latency? PC-4 asserting `< 30s` while taking 38s after two
root-cause fixes has the same shape as the fast tier's `withLock … expected parallel elapsed < 110ms, got
139ms` — a literal wall-clock budget failing on machine speed rather than on broken behaviour. AC-2 still
forbids widening a budget without justifying the new number against a measurement — but MEASURING whether
the budget is achievable on any box is exactly that justification, and it has not been done. Do that
before touching teardown code again.

## Out of scope

Pinning the introducing commit by bisect (its own ticket). The expensive tier and its deploy soak.

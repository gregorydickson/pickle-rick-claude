# BUG (P0): four integration-tier failures block the beta — two are stale sinks, one is ours, one unattributed

- **Date**: 2026-08-17
- **Priority**: P0 — blocks the `2.1.0-beta.10` tag
- **Branch**: `release/v2.1-beta`
- **Measured at**: `8c26f8d5` — `test:integration:parallel` **622 tests / 21 suites / pass 618 / fail 4 /
  cancelled 0 / EXIT=1**. All four reproduce deterministically in isolation (not flakes).

## Why these were invisible until now

`pretest:integration` runs `audit-subprocess-heavy-tests`, which had been failing, so
`npm run test:integration` exited 1 **without executing a single test**. `pretest:fast` runs a different
audit pair, so the fast tier read green (7723, fail 0) throughout. The integration tier had not run once
this session until the audit blocker was cleared by `53d4ca74`.

**The serial sub-tier STILL has not run.** `test:integration` is `parallel && serial`; the red parallel
short-circuits it. Only one summary block was emitted. Expect further failures behind it.

## The four failures, with attribution evidence

1. **`R-CWGE WS-2: absent verdict on a non-pickle-rick target (no extension/) flips Done`** —
   `tests/integration/codex-worker-gate-fail-closed.test.js:133`,
   `the unrun gate leaves exactly one residual — actual: 0`.
   **PRE-EXISTING, same family as queue A.** Its helper at `:45-48` reads
   `state.activity`; commit `40e07bde` moved the advisory `gate_skipped` residual producer to the jsonl
   sink, so that array is now always empty. Queue A (`390049c8`) migrated **four** fast-tier consumers to
   the shared `extension/tests/__helpers__/activity-sink.js` helper and counted four **because only the
   fast tier was measurable at the time**. This is a fifth consumer, in the tier nobody could run.
   **This is the OFF-REPO path** — a target repo with no `extension/`, i.e. every non-pickle-rick repo.
2. **`AC-CXHANG-6: abandoned detached worker is collected by the next reap; live-session control proc is
   spared`** — `tests/integration/orphan-worker-reaper-real-proc.test.js`. Contains one `state.activity`
   reference; check first whether it is the same stale-sink shape before assuming a reaper regression.
   Note its sibling `AC-8` (planted tmp-prefix orphans drained to zero) PASSES, so the reaper's new
   behaviour is working.
3. **`all_judge_backends_exhausted + gate pass → phase continues but the run withholds success (exit 1,
   degraded)`** — `tests/integration/pipeline-runner-judge-reasons.test.js`. No `state.activity`
   reference. **Most likely OURS**: R-NOPOSTTIER changed `finalizePipeline`'s
   `unsuccessful = pipelineFailed || counters.nonConvergent > 0` and added the degraded marker. Determine
   whether the test's expectation or the new behaviour is correct — do NOT simply retune the assertion to
   match current output.
4. **`INV-CODEX-RECOVERY-ADVANCED: disposition=advanced → loop continues (kind=relaunch, no park)`** —
   `tests/integration/codex-authority-recovery.test.js`, `expected relaunch, got
   {"kind":"break","reason":"recovery_exhausted"}`. **UNATTRIBUTED.** Attribute it before changing
   anything; a recovery ladder that breaks where it should relaunch is a reliability defect in its own
   right, and `break` on `recovery_exhausted` is a HALT, which the Prime Directive constrains.

## Acceptance criteria

- **AC-1 — every failure is attributed before it is fixed.** For each of the four, state in the ticket
  whether it is a stale-sink consumer, a regression from this session, or pre-existing other, with the
  commit or source line as evidence. A fix without an attribution line fails this AC.
- **AC-2 — stale-sink consumers migrate to the ONE helper.** Any residual reader still reading
  `state.activity` uses `extension/tests/__helpers__/activity-sink.js` `findResiduals` instead. Do not
  add a second reader shape, and do not revert `40e07bde`.
- **AC-3 — behaviour is not retuned to match a regression.** Where the new behaviour is wrong, fix the
  behaviour; where the test's expectation is stale, fix the test — and say which, per failure. Changing
  an assertion to match current output without justifying it fails this AC.
- **AC-4 — no halt is introduced or preserved wrongly.** For failure 4, if the recovery ladder is
  breaking where it should relaunch, that is a Prime Directive violation and must be fixed as such, not
  accommodated.
- **AC-5 — the parallel tier is green.** `npm run test:integration:parallel` reports `fail 0` and
  `cancelled 0`.
- **AC-6 — the SERIAL tier runs and is reported.** `npm run test:integration` emits summary blocks for
  BOTH sub-tiers. If the serial tier surfaces new failures, enumerate them in the ticket; do not leave
  them silently unrun. This AC is not satisfied by a green parallel run alone.
- **AC-7 — fast tier holds.** `npm run test:fast` reports `fail 0` AND `cancelled 0`, count not below
  7723, read from the runner's own summary block.
- **AC-8 — no new terminal condition, no new operator surface.** No new `exit_reason`, no new abort site,
  no new setting key, no new flag.

## Out of scope

The 11 other integration files that reference `state.activity` for event types which still live there —
only residual readers are stale. Do not mass-migrate them.

## Measured outcome — ticket 47c254f3 (2026-08-17, HEAD `6df18b29`)

All runs manager-owned, on a quiet box, with a scrubbed env
(`env -u PICKLE_WORKER_TEST_FAST_TIMEOUT_MS -u PICKLE_TICKET_ID -u PICKLE_STATE_FILE -u PICKLE_SESSION -u PICKLE_WORKING_DIR -u GIT_CONFIG_*`).

| AC | verdict | evidence (runner's own summary block) |
|:---|:---|:---|
| AC-5 parallel green | **SATISFIED** | `tests 622 / suites 21 / pass 622 / fail 0 / cancelled 0 / EXIT=0` |
| AC-6 both blocks emitted | **SATISFIED** | chained `npm run test:integration` emitted 2 summary blocks: parallel `622 / fail 0`, serial `tests 602 / suites 24 / pass 598 / fail 4 / cancelled 0 / EXIT=1` |
| AC-7 fast tier holds | **SATISFIED** | `tests 7723 / pass 7720 / fail 0 / cancelled 0 / skipped 2 / EXIT=0` |
| AC-3 no retuning | **SATISFIED** | no assertion changed, nothing skipped/quarantined/`.only`-narrowed |
| AC-8 no new surface | **SATISFIED** | no `exit_reason`, abort site, setting key, or flag added |

### The serial tier's four failures — all INHERITED

| # | test | file:line | shortest decisive line |
|:--|:--|:--|:--|
| 1 | PC-4: refinement worker 2-of-3 crash kills siblings | `extension/tests/integration/process-cleanup.test.js:245` | `spawn-refinement-team should complete in < 30s, took 47212ms (siblings not killed?)` |
| 2 | timeout-e2e: manager sleeps 95% of budget … no SIGTERM | `extension/tests/integration/timeout-e2e.test.js:28` | `artifact not written — subprocess was killed before completing (exit: 1, signal: null)` |
| 3 | timeout-e2e: session deactivated by subprocess → mux-runner exits cleanly | `extension/tests/integration/timeout-e2e.test.js:112` | `session deactivated` (`true !== false`) |
| 4 | FR-B10: fixture manager sleeps 95% of worker_timeout budget … no SIGTERM | `extension/tests/timeout-happy-path.test.js:31` | `Artifact not written — subprocess was killed before completing (exit: 1, signal: null)` |

**Attribution: inherited, none caused by this bundle's four subjects** (`2ba5c3e4`, `e39d9dcd`,
`7893ed3e`, `92e33eb3`). A detached worktree at `c87c3a3f` — the bundle's PRD commit, parent of every
code fix in it — reproduces all four with byte-identical assertion messages and matching timings. Each
arm ran its own `extension/bin/mux-runner.js` (the test resolves `MUX_RUNNER_BIN` relative to itself),
so the comparison is source-vs-source. The failures also reproduce under a fully scrubbed `PICKLE_*`
env, ruling out the known contamination families.

**These are B-CIINT (MASTER_PLAN row 119), and that row's "pass locally (macOS)" claim is now
falsified** — #2 and #4 are listed verbatim in the B-CIINT bundle as CI-only. They were never
"passing locally"; the serial tier was simply never reached, because `test:integration` is
`parallel && serial` and a red parallel short-circuits it. Row 119 reclassified P3 → P2.

**Residual left for a human (deliberately not fixed here):** the introducing commit is not pinned. The
`WARN: ticket_state_desync check found no ticket directories` line that precedes mux-runner's `exit 1`
predates the bundle by a wide margin, and bisecting it needs a per-commit rebuild of the compiled
mirror. Bounding that is its own ticket, not an assertion retune.

**Measurement hazard worth keeping:** a first `test:fast` run scored `fail 0 → fail 12` purely because
an incumbent `spawn-morty` worker was alive during it (6 of the 12 were `spawn-morty` subprocess tests
at 100–157s, i.e. spawn-lock contention). Re-run alone on the now-quiet box: `fail 0`. A tier
measurement taken while a worker is live is not evidence.

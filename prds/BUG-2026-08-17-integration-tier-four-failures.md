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

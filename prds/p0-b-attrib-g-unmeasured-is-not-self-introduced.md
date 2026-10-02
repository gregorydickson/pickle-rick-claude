# B-ATTRIB-G — "could not measure" is never "self-introduced" (#53, general half; `main`, then merge down per rule P)

Refinement: session `2026-10-01-e8b44a10`, 3 analysts × 3 cycles, read at `exp/b-lanes@266152d4`. Every WS-G site is
identical on `main@55fe1ba1`: `isBaselineUncertifiable` `:805`, `recordUncertifiableBaselineDefer` `:813`,
`runInterfaceSweepTypecheck` `:1302`, `withCleanTemporaryCheckout` `:654` in `bin/microverse-runner.ts`;
`assignOccurrenceIndices` `services/convergence-gate.ts:158`; the converged path `bin/pipeline-runner.ts:5857`.
The lane half (#53 WS-L) is a separate PRD on `exp/b-lanes`, which lands after this merges down.

## Field incident (numbers only)

An anatomy-park lane ran in a monorepo without usable dependencies.
- **Before its first edit:** its iteration-1 baseline held 12,534 typecheck errors.
- **During the lane:** it committed 3 CRITICAL fixes, then passed clean 4 times.
- **The sweep:** reported ~2,250 "self-introduced" breaks, every one of them present before the lane began.
- **The ending:** the #52 bound ended it `no_progress`, and its fixes were stranded.

This PRD fixes the general mechanisms that turned "the environment cannot be measured" into "the phase broke it".
Those mechanisms are reachable from any anatomy-park or szechuan run, laned or not.

## Decisions (made before tickets; reasons recorded)

- **D1 — base for G2:** a typecheck REPLAYED at `start_commit` in the sweep's own worktree.
  - **Rejected: the rolling `gate/baseline.json`.** It is refreshed at 30 iterations / 14,400 s and recaptured at
    `preIterSha`. After a refresh it contains the phase's own breaks, so subtracting it would disown them.
  - **Rejected: an iteration-1 capture.** In sequential mode that capture is taken after pickle's commits, so it
    would silently stop holding anatomy-park responsible for pickle's breaks.
  - The replay keeps today's sequential semantics. With the lane PRD's fork-sha `start_commit`, it gives lanes the
    narrow base. Fingerprints are absolute paths, so a baseline is only ever compared within the worktree it was
    taken in.
- **D2 — unmeasured withholds success.** On the normal converged path (`pipeline-runner.ts:5857`),
  `reportConvergedWithUnmeasured` becomes `if (reportConvergedWithUnmeasured(...)) counters.nonConvergent++;`. That
  mirrors the judge-timeout path at `:5209`. All three analysts recommended this; the alternative was recording the
  current inconsistency as a residual.
  - Reason: the CLAUDE.md honesty clause (BINDING): a degraded run "withholds the success verdict (no
    auto-release)".
  - It halts nothing. The run completes; only the success verdict is withheld.
  - Without D1/D2, G1 and the lane PRD's disclosure would make "measured nothing, reported success" the field's main
    path.
- **D3 — `selfGuard` and `buildNoDisownContext` are unchanged.** The sweep never called `subtractBaseline`, which
  has a single production call site. G2 ADDS a subtraction to the sweep and removes nothing.
- **D4 — G3 (cap-gate red made of baseline failures) is deleted.** G1's predicate placed inside
  `runBaselineAwareGate` covers its one live case.

## Requirements

### G1 — a check the BASELINE did not measure never arms the latch (tier: medium)

- **Predicate.** A check `c` is *baseline-unmeasured for a comparison* iff the current reading has
  `check_status[c] === 'ran'` AND the baseline has `check_status[c] !== 'ran'`.
  - It is one exported helper in `services/convergence-gate.ts`, built on the existing `isCheckUnmeasured`. It is
    never a hand-rolled `!== 'ran'`, and never `hasUnmeasuredCheck`. Those two existing predicates differ on
    `'skipped'` on purpose (AP-EXT-ITER7-02).
  - A baseline with no `check_status` map (legacy shape) keeps today's `project_type === null` rule.
- **`isBaselineUncertifiable` / `recordUncertifiableBaselineDefer`.**
  - A baseline-unmeasured typecheck contributes no failures. It is recorded through `recordCapUnmeasured`, so it
    surfaces as `cap_unmeasured_checks` and then `converged_with_unmeasured:`.
  - It never bumps `iteration_regressions` and never fires `uncertifiableBaselineDeferSink`.
  - When NOTHING is measured in either reading (every check `'skipped'`), today's R-SZGB-B outcome holds:
    AC-SZGBC-01 forbids certifying convergence over zero measured checks.
- **`runBaselineAwareGate`.** A check that is baseline-unmeasured reports `unmeasured`, never `red`.
- **Accepted residual.** `check_status` is repo-wide: escalation collapses packages. So a check unrunnable in ANY
  package at baseline is unmeasured repo-wide at the cap gate.
- **ACs.** These assert dispositions, never log prose. Rows 1 and 3 are regression guards that already pass at
  HEAD; row 2 must red at HEAD.

  | # | Baseline `check_status` | Current | Expected |
  |---|---|---|---|
  | 1 | typecheck `ran`, lint `ran`, tests `skipped` | typecheck `ran` with 1 NEW failure | `iteration_regressions` +1 (negative control) |
  | 2 | typecheck `failed`, lint `ran` | typecheck `ran`, 500 failures | `iteration_regressions` unchanged; `sink.fired === false`; `cap_unmeasured_checks` ⊇ `['typecheck']` |
  | 3 | tests `skipped` in both, others `ran`, no new failures | — | no defer; `cap_unmeasured_checks` lacks `tests` |
  | 4 | every check `skipped` | every check `skipped` | today's R-SZGB-B: does NOT converge clean |
  | 5 | `check_status` absent, `project_type: null` | — | today's behaviour |
  | 6 | file absent or unparseable | — | unmeasured, never `0 new` |

- **Pin files.** Revise their expectations, never delete a negative control:
  - `extension/tests/uncertifiable-baseline-attrition-latch.test.js`
  - `extension/tests/unrunnable-check-uncertifiable-baseline.test.js`
  - `extension/tests/services/convergence-gate-unrunnable-check.test.js`
  - `extension/tests/integration/anatomy-park-no-project-root.test.js`
  - `extension/tests/integration/anatomy-park-baseline-gate.test.js`

  This set was measured by `git grep -l -e uncertifiable -e no-attrition origin/main -- extension/tests` (fixture
  corpora excluded).

### G2 — the sweep classifies only failures NEW against a replay at `start_commit` (tier: large)

- **Mechanism.**
  - `runInterfaceChangeSweep` replays `runInterfaceSweepTypecheck` at `start_commit` in the same worktree, under
    `withCleanTemporaryCheckout`.
  - The replay is cached once per `start_commit` sha in `<session>/gate/`. On a sha mismatch it recomputes. An
    unreadable cache also recomputes and is never treated as empty.
  - **Both sides** go through `assignOccurrenceIndices` before `subtractBaseline(current, replay, undefined,
    /*keepFallbackRows*/ true)`. Then `classifyNoDisown` runs on the residue.
    - Today the sweep's rows all carry `occurrence_index: 0`: the only caller of `assignOccurrenceIndices` is
      baseline mode, and the sweep runs strict mode.
    - Without the re-index, the subtraction is a SET subtraction. A 4th occurrence of a baselined identity would be
      disowned.
- **Failure states.** None of them is ever an exception reaching `handleWorkerManagedIteration`:
  - a dirty tree (`withCleanTemporaryCheckout` throws);
  - a checkout error;
  - an unmeasured replay typecheck.

  Each one returns the existing `skipped: 'typecheck_unmeasurable'`, which withholds without `selfRedOpen`. No new
  `InterfaceSweepSkipReason` member is added; assert the union's size is unchanged.
- **Preconditions to state in code.**
  - The replay runs between iterations, with no live worker.
  - A replay that writes untracked build info (e.g. `*.tsbuildinfo`) must not make later checkouts refuse forever.
    Measure this; if it does happen, clean only what the replay itself created.
- **ACs.** Every fixture changes at least one EXPORTED declaration in the phase diff. Every row asserts
  `ran === true` alongside the count; otherwise the sweep never ran and a zero count is vacuous.

  | # | Fixture | Expected `selfIntroduced.length` | At HEAD |
  |---|---|---|---|
  | a | 2-package fixture (`packages/a`, `packages/b`); error pre-exists at `start_commit` in `packages/b`; phase changes an export in `packages/a` | 0 | > 0 (must red) |
  | b | same identity k=3 at base, n=4 now, in a touched file | 1 (mutation control: deleting the current-side re-index reds this row) | ≥ 1 |
  | c | k=3 → n=3 | 0 | 3 |
  | d | pre-existing error in an untouched file naming a changed exported symbol | 0; control: a NEW one → 1 | ≥ 1 |
  | e | self-introduced error at iteration 3, then `gate/baseline.json` refreshed | still 1 (rolling-base control) | 1 |
  | f | checkout stub throws | `ran:false`, `skipped:'typecheck_unmeasurable'`, no `selfRedOpen`, no exception | throws |

- **Accepted blind spot.** A self-introduced error that REPLACES a deleted pre-existing one with the same code in
  the same file is invisible to occurrence ranking.

### D2 ticket — unmeasured withholds success (tier: medium)

- **Change.** `pipeline-runner.ts:5857` becomes `if (reportConvergedWithUnmeasured(...)) counters.nonConvergent++;`.
- **AC.** A converged phase whose `microverse.json` has `cap_unmeasured_checks: ['typecheck']` gives
  `computePipelineVerdict(...).unsuccessful === true`, and the disposition still carries `converged_with_unmeasured:`.
  - Negative control: empty `cap_unmeasured_checks` still gives success.
  - Pin files (measured: 2 test files on `main` reference `converged_with_unmeasured`) are revised in this ticket.

## Non-goals

- Resetting `start_commit` for sequential phases: sequential anatomy-park and szechuan remain responsible for
  earlier phases' exported-symbol breaks.
- Per-package `check_status`.
- Any new halt, verdict channel, skip reason or gate leg (0 new legs).

## Done means

The G1 table, the G2 table and the D2 AC are green. Row (a) of G2 and row 2 of G1 were measured red at `55fe1ba1`
before the fix. `tsc --noEmit` and `eslint --max-warnings=0` both exit 0.

## Simplification Review

1. **Necessary?** Yes. Each mechanism converts an absent measurement into a red verdict, which is the fake-red twin
   of this repo's fake-green class.
2. **Reuse:** `isCheckUnmeasured`, `recordCapUnmeasured`, `subtractBaseline` + `assignOccurrenceIndices`,
   `withCleanTemporaryCheckout`, `typecheck_unmeasurable`, and the existing verdict counter.
3. **Brittle guard addressed:** R-SZGB-B arming the self-red latch on an absence. G1 routes that absence to the
   unmeasured channel that already exists.
4. **Subtraction:** G3 deleted; no new enum members; one shared predicate replaces an inline `project_type` test.

# B-VERDICT — the verdict machinery reports a different measurement than the one it decided on

**Priority:** P1 (reliability — these verdicts drive parking, Done-flips and phase outcomes)
**Type:** bundle (bug)
**Branch:** `release/v2.1-beta`
**build_mode:** unattended. A running pipeline executes DEPLOYED JS; the source diff lands only at deploy time.
**Composes:** three field findings measured during `B-CGSHIP` (2026-08-25) plus
`BUG-2026-08-22-ac6-guard-identifies-abort-sites-by-line-number.md`,
`BUG-2026-08-12-iteration-accounting-and-empty-diff-spin.md`,
`BUG-2026-08-12-success-verdict-blind-to-test-dimension.md`

## Thesis

Every item here is one defect shape: **a decision made on measurement A, reported in the vocabulary of
measurement B.** The report looks authoritative, the number cited is real, and the two have nothing to do
with each other. This is the same family as `isBaselineSha` comparing spelling instead of commit
identity, and as the option-operand scanners reading a wrapper instead of a payload — both closed in
beta.16/17.

## 🎯 FINDING 1 — the metric classifier decides on SETS and reports SCORES (measured, root cause located)

`compareMetricSetOps` (`services/microverse-state.ts:147`) decides from the resolved/new/remaining
**ledger sets**:

```ts
if (newSet.size > resolvedSet.size) return 'regressed';
if (resolvedSet.size > 0 && intersectionSize === 0) return 'improved';
return 'held';
```

A sibling `compareMetricNumeric` decides from the **score**. But the log line
(`bin/microverse-runner.ts:3880`) always prints numeric framing regardless of which produced the verdict:

```
Classification: ${classification} (previous=${previousScore}, tolerance=${...})
```

**Both field observations are explained by this, in opposite directions:**

| run | printed | why it is wrong |
|---|---|---|
| `B-CGSHIP` szechuan | `Metric: 33` then `Classification: held (previous=36, tolerance=0)` | score fell 3 at tolerance 0 — that is `improved`; set-ops said `held` because the sets intersected |
| beta.16 szechuan | `Metric: 1` then `Classification: improved (previous=1, tolerance=0)` | score unchanged — that is `held`; set-ops said `improved` because `resolved` was non-empty with no intersection |

**The consequence is not cosmetic.** A `held` increments the stall counter. In `B-CGSHIP` the sequence
`36 · 36 · 36 · 33 · 33` drove `stall_counter` to 5 and parked szechuan as `stalled_below_target` —
**a genuine improvement pushed the phase one step CLOSER to parking instead of resetting the counter.**
The phase parked at least one iteration early on a run that was still improving.

## 🎯 FINDING 2 — no audit checks that an INVARIANT names a LIVE symbol

`audit-trap-door-enforcement.sh` references `INVARIANT` 5 times and contains **zero** symbol-liveness
checks. It verifies that ENFORCE refs resolve — never that the INVARIANT names something that exists.
Anatomy-park found **three dead anchors in one phase, with three distinct causes**:

| commit | anchor | cause |
|---|---|---|
| `ea40a7e2` | AP-EXT-ITER46-01 | a rename deleted the symbol |
| `15866fa6` | AP-EXT-ITER8-01 | **false at birth** — `isDesignSafeBranch` never existed anywhere in history |
| `c0b6c2e5` | AP-EXT-ITER56-02 | a refactor deleted it as a pure pass-through |

In all three the guard was intact; only the naming was wrong. **A catalog that reads authoritative while
naming nothing is worse than a missing entry**: a reviewer greps the name, finds nothing, and concludes
the guard was deleted.

## 🎯 FINDING 3 — the pickle iteration cap drops a ticket and the phase still advances

`B-CGSHIP` composed 8 tickets. Pickle hit its cap:

```
Phase pickle exited but 1/8 tickets remain pending (7 Done) — not all-tickets-terminal,
reporting phase incomplete, advancing
```

Ticket `f2b3cf76` was **never built** — zero commits, no code. The runtime behaved correctly per the
PRIME DIRECTIVE (reported incomplete, advanced, did not halt). But **`incomplete` is the same word the
phase uses for many milder outcomes**, so a reader sees a finished 4/4 pipeline and never learns a ticket
vanished. Ordering luck decided which one was lost: the dropped ticket was `order: 80`, the
lowest-priority in the bundle. Two positions earlier and it would have taken AC-3.

## ✅ BOTH MANDATORY PRE-LAUNCH CHECKS PASSED — measured 2026-08-25 at HEAD `e8eebcf2`

**(a) STALE PREMISE: PASSED.** Every mechanism verified in source, by reading the code — not by R-code:

| finding | verified |
|---|---|
| classifier set-vs-numeric | `compareMetricSetOps` at `services/microverse-state.ts:147` returns from ledger SETS; sibling `compareMetricNumeric` returns from the SCORE; the log line at `bin/microverse-runner.ts:3880` prints `(previous=${previousScore}, tolerance=...)` regardless of which decided |
| no INVARIANT symbol-liveness audit | `audit-trap-door-enforcement.sh`: **5** `INVARIANT` references, **0** symbol/liveness checks |
| iteration-cap ticket drop | cap machinery live at `bin/mux-runner.ts:2205` (`max_iterations`) and `:263` (`PICKLE_APNC_MAX_PASSES_WITHOUT_CLEAN`) |

**(b) GREEN TREE: PASSED — and for the first time there is NOTHING to record as inherited.**
`npm run test:fast`, node 24.19.0: **8109 tests / pass 8103 / fail 0 / cancelled 0**.

beta.17 retired both standing exemptions, so the attribution rule is now absolute: **any failure during
this bundle is caused by this bundle.** There is no waiver list to hide behind, which is exactly the
condition [[B-CGSHIP]] AC-B5 existed to create.

## Acceptance criteria

- **AC-V1** The classification label and the figures printed beside it derive from the **same**
  comparator. Either report the ledger basis when set-ops decided, or decide numerically — but a
  `held`/`improved` label must never sit beside a `previous=` score that contradicts it. Pin BOTH field
  cases as tests: `36→33` must not classify `held`, and `1→1` must not classify `improved`.
- **AC-V2** A set-ops `held` that coincides with a genuine score improvement must **not** increment the
  stall counter. Reproduce the `36 · 36 · 36 · 33 · 33` sequence and assert the counter resets on the
  improvement.
- **AC-V3** An audit fails when an `INVARIANT` clause names a symbol that does not resolve in the tree.
  Pin all three historical shapes: renamed-away, deleted-by-refactor, and **false at birth**. `BREAKS`
  clauses describing historical breakage are explicitly OUT of scope — they legitimately name dead
  symbols.
- **AC-V4** A ticket left unbuilt when a phase hits its iteration cap is surfaced **distinctly** from an
  ordinary incomplete phase — a named disposition and an activity event carrying the ticket ids. No new
  halt path (PRIME DIRECTIVE): the run still advances.
- **AC-V5** Lift the ACs of the three composed PRDs as written; they are already refined
  (`ac6-guard-identifies-abort-sites-by-line-number` carries a 3-cycle refinement).
- **AC-V6 (report-only, non-gating)** Tiers do not regress. Baseline at launch: fast `fail 0`,
  integration parallel + serial `fail 0`, expensive `fail 0`, soak measured. **There are NO inherited
  failures any more** — beta.17 retired both — so ANY failure is attributable to this bundle.

## Sizing

**6 tickets**, under the amended cap. AC-V4 also raises the ceiling for future bundles: while an
over-cap ticket can vanish quietly, composing 8 stays unsafe.

## Non-goals

- Changing what the szechuan judge measures, or its whole-repo scope. This is about REPORTING the
  verdict consistently, not redefining it.
- Removing the stall/park mechanism. Parking is the designed outcome; it must simply be driven by a
  correct classification.
- The macOS notification ticket — operator-deferred, explicitly out.

## Simplification Review

1. **Necessary?** Three findings are measured field defects with reproductions; three are refined PRDs.
2. **Reuse?** AC-V1 collapses two comparators' reporting onto one path rather than adding a third.
3. **Guards brittle complexity?** AC-V3 adds one audit arm; AC-V1/V4 are subtractions of a divergence.
4. **Subtracts?** A contradictory log line, a premature park, and a silently-dropped ticket.

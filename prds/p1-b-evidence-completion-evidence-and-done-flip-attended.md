# B-EVIDENCE — completion evidence, Done-flip, and log emptiness (⚠ ATTENDED)

**Priority:** P1 (reliability)
**Type:** bundle (bug) — split out of [[B-MEGADRAIN]] 2026-08-28 by operator decision (option 1) because
this root CANNOT run unattended.
**Branch:** `release/v2.1-beta`
**build_mode:** **ATTENDED.** Launch normally, watch the salvage seam, recover the stall if it bites.

## Why this is a separate bundle, and why attended

These tickets edit the **salvage / completion-evidence / Done-flip path**. The deployed PRE-FIX runtime
applies that same buggy logic to the worker building the fix — the R-PSRB catch-22. Root `CLAUDE.md` is
explicit that this is *not* a hand-build exception: it is the thing being tested. `B-RASO` (beta.43)
shipped a salvage-path fix this way and it worked; that is the precedent.

**There is no hand-build exception. Not for this path. Launch a pipeline and supervise it.**

## Tickets

**E1 — R-ORSR-2: recovery flips a ticket Done without the impl landing.**
The recovery arm stamps completion on a ticket whose implementation never committed. This is the
phantom-Done class at its most direct: a proxy signal (recovery ran) outranking ground truth (is there a
commit?). Route through the existing `evaluateCompletionEvidence` single seam (B-1SEAM WS-1 already made
it the one predicate with 6 mux call sites + auto-fill); do NOT add a second guard beside it.

**E2 — R-ACNP: the acceptance-criteria checkbox gate is a consumer with no producer.**
Nothing writes the checkboxes the gate reads, so the gate is inert — it neither passes nor fails on
real information. Two honest dispositions: give it a producer, or DELETE it. Prefer deletion unless a
producer is genuinely wanted — an inert gate is complexity that reads as safety.

**E3 — B-LOGEV: 81% of worker session logs are EMPTY and the classifier believes them.**
`prds/p1-b-logev-session-log-emptiness-is-not-evidence.md`. Emptiness is not evidence. An empty log must
classify as `unmeasured`, never as a clean or failed run. This is the same `failed`-vs-`empty` conflation
that dominates this codebase; here it feeds the completion classifier.

## Acceptance criteria

- **AC-E1** A ticket whose implementation never committed cannot be flipped Done by the recovery arm.
  Mutation-verify in BOTH directions: the under-trigger case (real completion still flips) and the
  over-trigger case (missing commit refuses).
- **AC-E2** The AC-checkbox gate either has a producer whose output it reads, or is gone. No inert arm
  survives.
- **AC-E3** An empty worker session log yields `unmeasured`, distinct from both `clean` and `failed`, at
  every classifier boundary.
- **AC-E4 (report-only)** Tiers do not regress against the launch baseline. No inherited failures exist
  (beta.17 retired both), so any failure is attributable to this bundle.
- **AC-E5** The run is supervised. If the salvage seam stalls, the recovery command used is recorded in
  the ticket artifact — that observation is the point of running attended, not an incidental note.

## Non-goals

- Hand-building any of it. See above.
- Adding a new halt path. E1 refuses a LOCAL Done-flip and logs a residual; it must not break the loop.

## Simplification Review

1. **Necessary?** Three filed defects, all on the seam that decides whether work counts as done.
2. **Reuse?** E1 reuses `evaluateCompletionEvidence`; E3 reuses the existing degrade-reason vocabulary.
3. **Guards brittle complexity?** No — E2 is a candidate DELETION, E1 removes a proxy signal.
4. **Subtracts?** One inert gate, one proxy-over-ground-truth path, one false-evidence class.

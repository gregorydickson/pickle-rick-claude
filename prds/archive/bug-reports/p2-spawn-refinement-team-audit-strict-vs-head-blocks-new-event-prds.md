---
title: P2 — spawn-refinement-team symbol audit strict-checks event names against HEAD; bundle PRDs that introduce new events fail audit by design
status: Draft
filed: 2026-05-11
priority: P2
type: bug-tooling
---

# PRD — Refinement symbol audit cannot tolerate forward-create event/helper symbols in bundle PRDs

**Author**: Pickle Rick
**Project**: `pickle-rick-claude`
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`, local-only

## Symptom

While composing the pipeline-reliability quintet bundle PRD (`prds/archive/bundles/p1-bug-fix-bundle-2026-05-11-pipeline-reliability-quintet.md`), refinement failed three consecutive rounds with `[pickle-rick] symbol audit failed: N phantom symbol(s)`. The audit ran cleanly through all 3 cycles, found zero AC-shape smells, then exited code 2 at the symbol audit gate. Phantom symbols flagged were:

- 7 new activity event names the bundle introduces (one per new event the source PRDs declare)
- 3 new helper function names the bundle introduces (`detectManagerMaxTurnsExit`, `evaluateManagerRelaunch`, `handleWorkerSubprocessError`)
- 5+ enum/state field values that the regex pulled as false positives because they happened to be backticked snake_case tokens on the same line as a trigger phrase (e.g. `wall_clock`, `output_stall`, `passed`, `infrastructure_failure`)

Workaround used today: drop ALL backticks from forward-create event/helper names; relocate trigger phrases ("activity events" / "helpers" / "sentinels") to different lines. Required rewriting the bundle PRD from 132 lines down to 106 lines and removing most implementation detail (which then lives only in the source PRDs).

## Root cause

`extension/src/bin/spawn-refinement-team.ts` runs `evaluateSymbolAudit` after the AC-shape gate. The audit has four sub-checks:

1. `collectActivityEventReferences` — for every line matching `/\b(?:activity[-_\s]?events?|event_type|logActivity|VALID_ACTIVITY_EVENTS)\b/i`, pull every quoted snake_case token and assert it exists in `VALID_ACTIVITY_EVENTS` at HEAD. Any miss is a `phantom symbol`.
2. `collectHelperSentinelReferences` — for every line matching `/\b(?:helpers?|sentinels?)\b/i`, pull every quoted symbol and assert it exists somewhere in the source tree at HEAD. Any miss is a `phantom symbol`.
3. `collectExitCodeReferences` — same shape, against `PipelineRunnerExitCode` enum.
4. `collectNewFileReferences` — checks new-file paths against `manifest.tickets[].files` mapping.

The `collectActivityEventReferences` and `collectHelperSentinelReferences` checks have NO mechanism to accept forward-create symbols, in contrast with:
- The path-resolution check in `extension/src/bin/check-readiness.ts` which DOES honor the R-RTRC-7 forward-create annotation schema (`\`path\` (forward-created)`, `\`path\` (created by ticket <hash>)`, `\`path\` (introduced by ticket <hash>)`).
- The new-file path check in `collectNewFileReferences` which uses the `manifest.tickets` cross-reference.

For events/helpers there is no annotation path, no cross-reference, and no escape hatch flag.

## Why this is a tooling defect, not a PRD-author defect

A bundle PRD's job is to declare what its composed source PRDs will create. New events and new helper functions are precisely what reliability bundles add. The audit's strict HEAD check makes it structurally impossible to mention a bundle's new events by name in the wrapper without one of:

1. Removing backticks (degrades readability — code identifiers should be backticked)
2. Removing trigger phrases (degrades clarity — saying "the bundle adds 7 things" is clearer than "the bundle adds 7 instrumentation hooks")
3. Skipping refinement entirely

None of those are good. The audit was designed for ticket-level PRDs where every backticked symbol should already exist; bundle-level PRDs have a different shape.

Today's workaround forces bundle authors to invent euphemisms ("instrumentation hooks" instead of "activity events") and push detail down into the source PRDs. That works for atomic bundles but loses readability when an operator wants a single-pager summary of "what does this bundle add."

## Severity

P2 — workaround exists (relocate triggers + drop backticks + push detail to source PRDs), but every author of every future bundle that adds new events hits it. Today's bundle ate ~3 hours of operator time across four refinement rounds before the workaround clicked. Climbs to P1 the moment a bundle author silently violates the workaround and ships a wrapper PRD that refinement rejects in an autonomous overnight session — operator wakes up to "no progress, refinement failed, no error visible without log archaeology."

## Fix Requirements

- **R-SAOV-1** (R-MUST): `collectActivityEventReferences` MUST accept R-RTRC-7-style forward-create annotations on event names. Same annotation schema as paths: `\`event_name\` (forward-created)`, `\`event_name\` (introduced by ticket <hash>)`, `\`event_name\` (created by R-<CODE>-N)`. When an event name is annotated, the audit MUST skip the membership check and pass with status `forward-create`.

- **R-SAOV-2** (R-MUST): `collectHelperSentinelReferences` MUST accept the same forward-create annotation schema for helper/sentinel function names. Same skip-on-annotation behavior as R-SAOV-1.

- **R-SAOV-3** (R-SHOULD): The audit MUST also recognize the bundle PRD's `composes:` frontmatter chain. For every source PRD in `composes:`, the audit MUST union that source PRD's declared events / helpers into the "valid set" before checking the wrapper PRD. This means the wrapper can mention by name any symbol declared in a composed source PRD without explicit annotation.

- **R-SAOV-4** (R-MUST): When the audit FAILS, the failure output MUST include the canonical workaround prose so operators can fix without consulting source:
  ```
  [pickle-rick] symbol audit failed: N phantom symbol(s).
  [pickle-rick] To allow forward-create symbols, either (a) annotate with (forward-created)
  or (created by R-<CODE>-N) outside the backticks, or (b) ensure the symbol is declared
  in a PRD listed in this bundle's `composes:` frontmatter.
  ```

- **R-SAOV-5** (R-MUST): Regression tests `extension/tests/spawn-refinement-team-symbol-audit-annotations.test.js` covers:
  - Forward-create event annotation passes
  - Forward-create helper annotation passes
  - `composes:` chain symbol resolves
  - Unannotated forward-create symbol still fails (preserves the existing guarantee)
  - False-positive enum values (`passed`, `wall_clock`, `output_stall`) on trigger-phrase lines: must NOT be flagged when the line also contains a clear non-event context marker (e.g., the line begins with "gate outcome G ∈" or "enum value"). MAY be deferred to R-SAOV-6 if scope creep.

- **R-SAOV-6** (R-MAY): Smarter false-positive filter for enum/state values. Today the regex pulls every quoted snake_case token from a line matching the trigger; the audit can't distinguish "this token is an activity event" from "this token is an enum value being discussed near an activity event." A heuristic — e.g., only pull tokens that appear adjacent to identifiers like "event", "logged as", "emit" — would reduce false positives substantially.

- **R-SAOV-7** (R-SHOULD): Trap-door entry pinned at `extension/src/bin/spawn-refinement-team.ts` documenting "symbol audit accepts forward-create annotations matching the path schema for events + helpers; new bundle wrappers MUST be reviewable for false-positive enum-value backticks on trigger-phrase lines."

- **R-SAOV-8** (R-MUST): Closer — bump version, MASTER_PLAN bookkeeping (close Finding #24).

## Sister findings

- **Finding #18 R-RTRC8** (in flight) — `/pickle-refine-prd` Step 7c template lacks R-RTRC-7 forward-create annotation reminder. R-SAOV is the upstream counterpart: even if authors remembered to annotate, the audit doesn't accept the annotation for events/helpers. Both ship together to close the loop.
- **R-RTRC-7 trap-door** in `extension/src/bin/check-readiness.ts` — the canonical annotation schema. R-SAOV extends recognition into the symbol audit at the refinement stage.

## Triggering session

`2026-05-11-b7aad50b` — bundle 2026-05-11 pipeline-reliability quintet. Four consecutive refinement rounds against the wrapper PRD:
- Round 1: 3 AC-shape smells (resolved by universal-quantifier rewrite)
- Round 2: 2 residual AC-shape smells (resolved by pinning canonical event-set cardinality, dropping "MAY be deferred" hedge)
- Round 3: 0 AC-shape smells + 31 phantom symbols in symbol audit
- Round 4: rewrote bundle PRD to dodge all audit triggers (108→106 lines, no backticked forward-create symbols, no trigger phrases co-located with new names)

Each round cost ~30-60 min refinement + ~15 min operator analysis. The bundle PRD's final shape is structurally less informative than the originally-drafted shape — implementation detail was pushed into the source PRDs purely to dodge the audit, not because the wrapper shouldn't carry it.

## Atomic decomposition

- **R-SAOV-1**: extend `collectActivityEventReferences` with annotation parser (~40 LOC, 1 commit)
- **R-SAOV-2**: extend `collectHelperSentinelReferences` with annotation parser (~40 LOC, 1 commit; reuses R-SAOV-1's parser as a shared helper)
- **R-SAOV-3**: `composes:` chain resolution — parse wrapper PRD frontmatter, load each source PRD, extract its declared events/helpers, union into valid set (~80 LOC, 1 commit)
- **R-SAOV-4**: error-message UX (~15 LOC, 1 commit; folds into R-SAOV-1)
- **R-SAOV-5**: regression tests (~120 LOC, 1 commit)
- **R-SAOV-6**: false-positive enum filter (R-MAY, ~40 LOC + tests, 1 commit)
- **R-SAOV-7**: trap-door pin (~10 LOC docs, 1 commit)
- **R-SAOV-8**: closer (~20 LOC bookkeeping, 1 commit)

Approx half-day fix. Ship in next P2 maintenance bundle, AFTER the pipeline-reliability quintet ships (don't bundle them together — quintet is on a different surface).

# PRD: Refinement Clustering for Large Bundles (R-MBSR)

**Status**: DRAFT 2026-05-14 PM (Priority P1, queue-blocking for monster bundles). **Minimum-viable scope: refinement layer only.** Pickle execution loop, anatomy-park, szechuan-sauce, citadel, gates, hooks, worker lifecycle, ticket frontmatter, and watcher panes are all unchanged. The single behavioral change lives inside `spawn-refinement-team.ts`.

## Problem

Refinement quality degrades past ~8 tickets per bundle. Empirical:

- **c122b0f7**: R-MMTR family, 5-7 tickets — manager-loop wedge mid-family, 5h wall-clock.
- **c71ab3ca**: 2-PRD bundle — collapse before draining family 1.
- **b54f2143**: R-TSPF, 7 atomic tickets — clean ship. Threshold for "still safe."

The bottleneck is the refinement team's monolithic reasoning surface: 3 parallel analysts × N cycles all reasoning about the full bundle every cycle. Per-ticket analyst attention drops as N rises, forward-references slip past readiness, and the bundle wedges in execution.

**Pickle's execution loop is not the pain point.** It executes a flat ticket list correctly today regardless of ticket count. Anatomy-park and szechuan-sauce scan diffs, not tickets. They scale on diff size, not ticket count, and have shipped 28+ commit diffs cleanly. The fix belongs in the refinement layer.

## What changes

One file behaviorally: `extension/src/bin/spawn-refinement-team.ts`.

1. **Cycle 1**: analysts identify cluster boundaries from PRD `subsystem:` frontmatter (if present), file-path locality of cited paths, and import-graph density. Each cluster ≤8 tickets.
2. **Cycle 2+**: each analyst refines ONE cluster at a time, with full PRD context but reconciliation scoped per-cluster. Same 3-analyst, N-cycle architecture — only the reasoning scope per cycle narrows.
3. **Output**: same flat `tickets[]` array as today. Each ticket carries an additional optional `cluster_id?: string` field for audit. Downstream consumers (pickle, gates, anatomy-park, szechuan-sauce, citadel) ignore the field — execution order remains the flat array.

## What does NOT change

- `mux-runner.ts` execution loop (zero behavioral change)
- Worker lifecycle (`spawn-morty.ts`, per-phase artifacts, gates)
- Anatomy-park, szechuan-sauce, citadel
- Readiness gate, ticket-audit gate, finalize-gate, worker gate (`runWorkerGate`)
- Ticket frontmatter, state machine, hooks
- `refinement-watcher.ts` (single-pane view continues for all bundle sizes)
- `composes:` graph in `services/citadel/audit-runner.ts`
- All operator-visible commands, flags, and tmux layouts
- `refinement_manifest.json` schema_version (only an additive optional field)

## Scope

In:

- `extension/src/bin/spawn-refinement-team.ts` — clustering loop in cycle 1 + per-cluster reconciliation in cycle 2+
- `extension/src/types/index.ts` — add optional `cluster_id?: string` to the refined ticket type
- `extension/tests/refinement-clustering.test.js` (NEW)
- `extension/CLAUDE.md` — trap-door pin entry

Out (deliberately deferred — file as follow-ups if R7 surfaces a need):

- Wave-partitioned execution / between-wave readiness gates
- Streaming refinement (wave N+1 refines while wave N executes)
- Convergence-driven cycle count
- Per-cluster checkpointing for crash resume
- Per-cluster watcher panes
- `composes:` graph clustering interop
- Schema version bump or migration

## CUJs

1. **Small bundle (≤8 tickets)**: operator runs `/pickle-tmux` on a single-PRD bundle producing ≤8 refined tickets. Cluster boundary detection runs but produces a single cluster; `cluster_id` is set but downstream consumers ignore it. Bundle behaves identically to today.
2. **Large bundle (≥9 tickets)**: operator runs `/pickle-tmux` on a multi-PRD or oversized single-PRD bundle producing 16+ refined tickets. Refinement identifies 2-4 clusters in cycle 1 and refines each independently in cycles 2+. Output is a flat ticket list of well-formed tickets. Pickle executes the flat list as today.

## Requirements

| ID | Priority | Requirement |
|---|---|---|
| R1 | P0 | Refinement cycle 1 produces cluster boundaries derived from: (a) PRD `subsystem:` frontmatter when present, (b) file-path locality of cited paths in the PRD, (c) import-graph density. Boundaries persist across cycles. |
| R2 | P0 | Refinement cycle 2+ runs reconciliation per-cluster: each analyst refines one cluster at a time, with full PRD context but per-cluster reconciliation output. The 3-analyst × N-cycle architecture is preserved. |
| R3 | P0 | Each cluster contains ≤8 refined tickets. Hard invariant — refinement halts with exit reason `cluster_oversize` if any cluster exceeds. |
| R4 | P0 | Refined tickets carry an optional `cluster_id?: string` field. The flat `tickets[]` array remains authoritative for execution order; downstream consumers ignore `cluster_id`. |
| R5 | P0 | Bundles producing ≤8 total refined tickets route through a single cluster. Manifest output for these bundles is byte-identical to today's modulo the optional `cluster_id` field. |
| R6 | P0 | Trap-door pin: cluster invariant (R3) and field contract (R4) enforced by `extension/tests/refinement-clustering.test.js` and registered in `extension/CLAUDE.md` under "Trap Doors". |
| R7 | P1 | Post-ship operational validation: a monster bundle of R-FRA + R-QGSK + R-CCNW (≥16 refined tickets) refines clean — zero forward-ref readiness failures, zero force-skips, anatomy-park clean exit. If validation fails, file follow-up R-MBSR-2 with the failure class and only then revisit out-of-scope items (waves, streaming, etc.). |

## Interface Contracts

### Refined ticket type (additive)

```ts
interface RefinedTicket {
  // ... existing fields preserved
  cluster_id?: string;  // NEW — optional; null/absent in ≤8-ticket bypass path
}
```

No schema_version bump; the field is optional and downstream consumers ignore it.

### Refinement loop (internal to `spawn-refinement-team.ts`)

Cycle 1 — single-cycle clustering pass:
1. Analysts produce a draft ticket list as today.
2. Cluster boundaries computed from R1's hint sources.
3. R3 size invariant validated; failure halts with `cluster_oversize`.

Cycle 2+ — per-cluster refinement:
1. For each cluster, analysts refine that cluster's tickets with full PRD context but per-cluster reconciliation output.
2. Final manifest assembles cluster outputs into the flat `tickets[]` array with `cluster_id` annotations.

### Downstream consumers — unchanged

`mux-runner.ts`, `check-readiness.ts`, `audit-ticket-bundle.ts`, `citadel/audit-runner.ts`, `refinement-watcher.ts`, `monitor.ts`, watchers, gates, hooks — none read `cluster_id`. Code paths are byte-stable.

## Verification

| Req | Check | Command |
|---|---|---|
| R1, R2 | Fixture multi-subsystem PRD produces expected cluster boundaries; per-cluster reconciliation observed in cycle 2 output | `node --test extension/tests/refinement-clustering.test.js` |
| R3 | Fixture PRD that would produce a >8-ticket cluster halts with `cluster_oversize` | same test |
| R4 | Refined tickets carry `cluster_id` when clustered; downstream pickle execution is byte-stable | same test |
| R5 | Fixture 6-ticket bundle: manifest diff before-vs-after R-MBSR is empty modulo optional `cluster_id` | same test |
| R6 | Trap-door audit passes | `bash extension/scripts/audit-trap-door-enforcement.sh` |
| R7 | Operational | Phase 1c monster bundle session ships clean |

## Conformance Check

- [ ] Type checker passes — no new errors
- [ ] Test runner passes (fast + integration tiers)
- [ ] Lint passes — 0 new warnings
- [ ] Trap-door audit passes (R6)
- [ ] Bypass parity: fixture 6-ticket bundle's manifest is byte-stable modulo `cluster_id`
- [ ] Phase 1c monster bundle refines clean (post-ship R7)

## Assumptions

- The refinement team's analyst architecture (3 parallel × N cycles, claude backend per `PICKLE_REFINEMENT_LOCK=1`) is preserved. R-MBSR changes only the *reasoning scope per cycle*.
- Cluster boundary heuristics (frontmatter → path locality → import-graph density) are good enough for the common cases; manual override via PRD `subsystem:` frontmatter is the escape hatch.
- The 8-ticket-per-cluster ceiling is the same empirical cap as today's per-bundle rule, applied at a different granularity.
- Cluster boundaries inferred in cycle 1 are sticky across cycles. If cycle 1 mis-clusters, the operator restarts refinement with corrected `subsystem:` hints rather than re-clustering mid-run.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Clustering heuristic mis-partitions, splitting tightly-coupled tickets across clusters | Manual override via PRD `subsystem:` frontmatter. Cluster boundaries are visible in cycle 1 analyst output so the operator can intervene before cycle 2 starts. |
| Existing ≤8-ticket bundles regress | R5's bypass IS the existing reconciliation path with one optional field added. The byte-stable manifest test is the regression gate. |
| Clustering doesn't actually improve quality past 8 tickets | R7's monster bundle is the proof. If it fails, file R-MBSR-2 with the observed failure class and only then revisit out-of-scope items (waves, streaming, checkpointing). Don't widen scope speculatively. |
| Cluster size invariant (R3) triggers spuriously on a legitimately large cluster | The invariant is intentional — it forces the operator to split the PRD or accept the existing 8-ticket cap on that cluster. Recovery is "re-author the PRD," not "raise the limit." |

## Business Impact

- **Unblocks monster bundles** without touching the execution layer that already works. Refinement quality scales by narrowing per-cycle analyst attention.
- **Lowest-risk path** to the strategic capability: single file behaviorally, single new test, single trap-door pin, single new optional field.
- **Operator rule #2 ("8-ticket cap")** relaxes to "8-per-cluster cap" on R-MBSR ship.
- **Pickle / anatomy-park / szechuan-sauce stay frozen.** If something goes wrong in a monster bundle, the failure surfaces in refinement (manifest never writes), not in execution.

## Coupling with Other Queue Items

- **R-CCPL** (codex classifier prompt-leak diagnose-only): orthogonal — different surface, different backend.
- **R-FRA + R-QGSK + R-CCNW**: composed as R-MBSR's R7 operational validation. They ship *after* R-MBSR is deployed.
- **R-WMW**, **R-MMTRH**: orthogonal — no coupling.

## Stakeholders

- **Author**: Gregory Dickson (Pickle Rick)
- **Implementer**: TBD (single ≤8-ticket bundle via the existing refinement path — R-MBSR ships *on* today's safe path before unlocking monster bundles)
- **Reviewers**: any operator who has hit the 8-ticket cap in practice

## References

- `extension/src/bin/spawn-refinement-team.ts` — current monolithic refinement
- `extension/src/types/index.ts` — refined ticket type
- `prds/MASTER_PLAN.md` — Phase 1b/1c sequencing
- Incidents: c122b0f7 (5h wedge on 5-7 tickets), c71ab3ca (2-PRD collapse), b54f2143 (7 tickets clean — threshold)
- Operator rule #2 (8-ticket cap) — to be revised on R-MBSR ship

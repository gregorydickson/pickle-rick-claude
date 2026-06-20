---
title: Readiness gate doesn't handle manifest/bundle PRDs — 3 related bugs
status: Shipped
date: 2026-05-01
priority: P2
shipped: P0 bundle Section D (AC-RGM-01..07)
backend: codex-required
peer_prds:
  related:
    - prds/archive/bundles/p1-bug-bundle-2026-05-01-pm.md  # the bundle whose readiness halt surfaced this
    - prds/citadel-hardening-bundle.md  # earlier bundle that hit similar issues silently
---

# PRD — Readiness gate manifest/bundle-PRD mismatch (3 related bugs)

When `/pickle-pipeline` was launched on the in-flight bundle PRD `prds/archive/bundles/p1-bug-bundle-2026-05-01-pm.md` (a manifest composing 3 source P1s), the readiness gate fired exit 2 and halted the pipeline. Investigation surfaced three distinct bugs in the gate ↔ ticket-frontmatter ↔ skill-template chain that all manifest at the same place. Each is bounded; together they make manifest/bundle PRDs unable to clear readiness without `--skip-readiness <reason>`.

The bundle pipeline shipped fine on the second attempt with `state.flags.skip_readiness_reason` set, but bypassing the gate is not a long-term fix — every future bundle will hit this.

## Symptoms (observed)

`readiness_2026-05-01.md` excerpt from session `2026-05-01-325ccb80`:

```
## PRD-ticket map

| Ticket | Key | Source PRD | Source section | Mapped requirements |
|---|---|---|---|---|
| 0335160d |  |  |  |               |
| 05235370 |  |  |  |               |
| ...
| 6ff337d5 |  |  |  | AC-BB-15, AC-SCJM-02 |
| ... 17 of 20 rows have empty Source PRD / Source section columns ...
```

```
## AC verifiability matrix
| 05235370/linear_ticket_05235370.md | FAIL | New entry exists — Verify: grep "assertMicroverseStateShape" extension/CLAUDE.md |
| 25c4b70e/linear_ticket_25c4b70e.md | FAIL | Zero P0-P1 violations in MODIFIED_FILES — Verify: manual review |
| 3cd23b3e/linear_ticket_3cd23b3e.md | FAIL | Zero P0-P1 assertion gaps — Verify: review |
| a3c0e707/linear_ticket_a3c0e707.md | FAIL | New entry exists — Verify: grep |
```

```
## Contract resolution table
| 97c8a7a4/linear_ticket_97c8a7a4.md | FAIL | dispatch.ts | codebase |

## Findings
- file_path in 0335160d/linear_ticket_0335160d.md
  - Referenced ticket file path does not resolve: `tests/check-update.test.js`
```

## Three Bugs

### Bug 1 — Ticket frontmatter has no slot for cross-PRD attribution

**Root cause**: the pickle-refine-prd skill template (`Step 7c`) defines the ticket frontmatter as `id, title, status, priority, order, working_dir, created, updated, links`. It does NOT include `source_prd` / `source_section` / `mapped_requirements` fields — those have to be inferred by the readiness gate from prose in the ticket body, which is fragile.

For a manifest PRD that points to N source PRDs, each ticket maps to a SOURCE PRD section (not the manifest itself). There's no mechanical place to declare this, so the readiness gate's PRD-ticket map walks the manifest's body looking for AC IDs, finds nothing useful (the manifest delegates), and reports empty cells.

**Files to look at**:
- `extension/.claude/commands/pickle-refine-prd.md:Step 7c` — ticket template
- `extension/src/bin/check-readiness.ts` (or wherever it builds the PRD-ticket map) — how it resolves Source PRD per ticket
- `extension/src/bin/spawn-refinement-team.ts` — the manifest worker writes; might be where Source-PRD attribution should be captured

### Bug 2 — Check-readiness rejects ACs whose verify command checks post-fix state

**Root cause**: many ACs are written as "after the work, this grep should match" — but check-readiness runs the verify command AT READINESS TIME (before any work). Tickets like `05235370/APRC-T5: New entry exists — Verify: grep "assertMicroverseStateShape" extension/CLAUDE.md` correctly state the post-fix expected state, but readiness runs the grep, sees no match, and marks FAIL.

This is a tense mismatch: ACs are "post-fix" by definition (they verify the ticket succeeded), but the readiness gate uses them as "pre-flight" checks.

**Files to look at**:
- `extension/src/bin/check-readiness.ts` — AC verifiability logic
- The skill template at `Step 7c Acceptance Criteria` — should distinguish `verify_pre` (must currently fail to prove the bug exists) vs `verify_post` (must pass after the work)

### Bug 3 — Manifest PRDs have no `peer_prds` walk in the gate

**Root cause**: the in-flight bundle PRD HAS a `peer_prds` frontmatter field (added per refinement Cycle 3) listing the source PRDs. The readiness gate doesn't read it. If it did, it could:
1. Walk each `peer_prds.deferred[*]` PRD.
2. Cross-check each ticket's body against the source PRDs' AC IDs.
3. Auto-populate the PRD-ticket map without requiring manual frontmatter.

Currently, manifest PRDs are functionally unsupported by the readiness gate.

**Files to look at**:
- `extension/src/bin/check-readiness.ts` — where the PRD-ticket map is built; needs `peer_prds` walk
- Bundle parent: `prds/archive/bundles/p1-bug-bundle-2026-05-01-pm.md` — already has the frontmatter

### Related: file-path qualification

Tickets sometimes reference paths relative to the extension root (`tests/check-update.test.js`) instead of the working_dir (`extension/tests/check-update.test.js`). The gate's path resolver doesn't try multiple roots. Either the skill should standardize on full-from-repo-root paths, or the gate should try `${ticket.working_dir}/${path}` before failing.

## Functional Requirements

- **FR-1** — `pickle-refine-prd` skill template adds `source_prd`, `source_section`, `mapped_requirements` to ticket frontmatter (Step 7c) — required when refining a manifest/bundle PRD, optional otherwise.
- **FR-2** — `check-readiness.ts` reads `peer_prds.deferred[*]` from the parent PRD frontmatter; for each ticket, walks the linked source PRDs to auto-populate the PRD-ticket map without requiring per-ticket frontmatter.
- **FR-3** — `check-readiness.ts` distinguishes `verify_pre` (must currently fail) from `verify_post` (will pass after the work). ACs default to `verify_post`. Pre-flight ACs require explicit opt-in. The skill template documents this.
- **FR-4** — `check-readiness.ts` file-path resolver tries `${ticket.working_dir}/${path}`, then `${path}` from cwd, then `extension/${path}` as fallback. Resolution failure marks FAIL only after all three fail.
- **FR-5** — When `state.flags.skip_readiness_reason` is set with a manifest-attribution rationale, the gate emits `readiness_skipped_for_manifest` activity event so we can audit how often this workaround is used (signal for prioritizing the fix).

## Non-Functional Requirements

- **NFR-1** — Backward-compatible: existing non-manifest PRDs (which dominate) must continue to clear readiness without changes.
- **NFR-2** — No new external dependencies.
- **NFR-3** — Test coverage: a new fixture-based `tests/integration/readiness-manifest-prd.test.js` runs the gate against a 3-ticket manifest fixture and asserts pass.

## Acceptance Criteria

| ID | Phase | Check |
|---|---|---|
| AC-RGM-01 | per-phase | Refining a manifest PRD with `peer_prds.deferred[*]` produces tickets where `source_prd` / `source_section` frontmatter is auto-populated from the source PRDs. Test: `tests/spawn-refinement-team-manifest.test.js` (NEW). |
| AC-RGM-02 | per-phase | Running `check-readiness.ts` against a manifest session populates the PRD-ticket map by walking `peer_prds.deferred`. No empty cells unless a ticket genuinely has no source. Test: `tests/check-readiness-manifest.test.js` (NEW). |
| AC-RGM-03 | per-phase | `check-readiness.ts` distinguishes `verify_pre` from `verify_post`; default is `verify_post` and skipped at readiness time. Test added to existing `tests/check-readiness.test.js`. |
| AC-RGM-04 | per-phase | File-path resolver tries 3 roots before reporting unresolved. Test: extension to `tests/check-readiness.test.js`. |
| AC-RGM-05 | per-phase | When `state.flags.skip_readiness_reason` matches `/manifest-bundle/`, gate emits `readiness_skipped_for_manifest` event. Test: extension to `tests/check-readiness-skip.test.js`. |
| AC-RGM-06 | bundle-end | Live re-run: `/pickle-pipeline prds/archive/bundles/p1-bug-bundle-2026-05-01-pm.md` clears readiness without `--skip-readiness`. Manual verification + integration test. |
| AC-RGM-07 | post-refinement | Skill template at `pickle-refine-prd.md:Step 7c` documents the new frontmatter fields and the verify_pre/verify_post distinction. Verify: grep + lint. |

## Tasks (atomic, execution order)

| Order | ID | Title | Estimated LOC |
|---|---|---|---|
| 10 | RGM-T1 | Skill template update: add `source_prd` / `source_section` / `mapped_requirements` + `verify_pre`/`verify_post` to `Step 7c`. AC-RGM-07. | ~40 |
| 20 | RGM-T2 | `check-readiness.ts`: walk `peer_prds.deferred[*]` to build PRD-ticket map. AC-RGM-02. | ~80 |
| 30 | RGM-T3 | `check-readiness.ts`: honor `verify_pre` vs `verify_post` AC types; skip post at readiness time. AC-RGM-03. | ~50 |
| 40 | RGM-T4 | `check-readiness.ts`: 3-root file-path resolver. AC-RGM-04. | ~30 |
| 50 | RGM-T5 | `check-readiness.ts`: emit `readiness_skipped_for_manifest` activity event when `state.flags.skip_readiness_reason` matches `/manifest-bundle/`. AC-RGM-05. | ~30 |
| 60 | RGM-T6 | Integration test: `tests/integration/readiness-manifest-prd.test.js`. AC-RGM-06. | ~120 |
| 70 | RGM-T7 | `spawn-refinement-team.ts`: when refining a manifest PRD, auto-populate `source_prd` per ticket from the manifest's `peer_prds`. AC-RGM-01. | ~60 |
| 80 | RGM-T8 | Trap-door catalog: 1 new INVARIANT for manifest PRD walk in check-readiness. | ~15 |
| 90 | RGM-T9 | Closer: bump version, run release gate. | ~5 |

**Total**: ~430 LOC. 9 atomic tickets.

## Out of Scope

- Cross-repo manifest PRDs (where `peer_prds.deferred[*]` includes paths outside the working_dir).
- Replacing the readiness gate with a different gate primitive — this is incremental within the existing gate.

## Risks

| ID | Risk | Mitigation |
|---|---|---|
| R1 | Walking peer PRDs at readiness time slows the gate | Cap walk depth at 1 (manifest → source PRDs only); skip if `peer_prds` field absent |
| R2 | The verify_pre/verify_post distinction is hard for refinement workers to author correctly | Default to `verify_post` and document; only ACs that explicitly need pre-flight failure (e.g., bug reproducers) opt into `verify_pre` |
| R3 | Hand-built bundles (like the in-flight one) won't benefit until manually migrated | Acceptable — the next refinement run on the bundle will pick up the new template |

## Cross-references

- Surfaced by: bundle session `2026-05-01-325ccb80` readiness halt at 00:26:55 UTC (escalation file: `~/.local/share/pickle-rick/sessions/2026-05-01-325ccb80/readiness_2026-05-01.md`)
- BMAD `--skip-readiness <reason>` (P0.6) shipped v1.63.0 commit `deac6c5` — the workaround we used to unblock the bundle. This PRD removes the need for it on manifest bundles.
- Citadel + Hardening Bundle (`prds/citadel-hardening-bundle.md`, Apr 29) — same manifest pattern; presumably also hit this but didn't surface (or used --skip-readiness silently).

— Pickle Rick out. *belch*

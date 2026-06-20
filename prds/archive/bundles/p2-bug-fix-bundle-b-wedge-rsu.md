---
title: P2 bug-fix bundle — B-WEDGE — `/pickle-tmux` auto-refinement collapses a `composes:` bundle-of-bundles PRD into N section-umbrella tickets instead of fanning out atomic R-coded tickets
status: Draft
filed: 2026-05-31
priority: P2
type: bug-bundle
code: B-WEDGE
composes:
  - "#30 R-RSU — refinement ticket-emission granularity: a `composes:` bundle-of-bundles PRD whose sources carry `## Atomic decomposition` sections collapses to one umbrella ticket per source instead of fanning out one ticket per atomic R-code, so bundles wedge on oversized umbrella tickets"
source:
  - prds/archive/bug-reports/p2-pickle-refine-section-umbrella-granularity-bug.md   # R-RSU draft (R-RSU-1..5) — authoring source for this bundle
backend_constraint: any
launch_constraint: |
  Launch WITHOUT `/pickle-refine-prd`. R-RSU IS the refinement-granularity bug; refining this bundle's own PRD through the buggy path risks reproducing the over-collapse on B-WEDGE itself. Tickets are pre-decomposed atomic below.
---

# B-WEDGE — refinement section-umbrella granularity bug (#30 R-RSU)

> Schema-neutral: this bundle touches no persisted `state.json` field and does not bump `LATEST_SCHEMA_VERSION`. It edits the analyst prompt text, adds an emission-time validation guard, a regression test, and a trap-door pin. Closer is a PATCH release.

## Trigger

`/pickle-tmux <bundle-prd>.md` is invoked on a bundle PRD whose frontmatter declares `composes: [<list of source PRDs>]`, where each composed source PRD carries its own `## Atomic decomposition` section enumerating R-codes (R-X-1..R-X-N). The refinement team (`spawn-refinement-team.ts`) produces **one umbrella ticket per composed source PRD** (`tickets.length === composes.length`) rather than one atomic ticket per R-code (`tickets.length === Σ atomic-R-code-count per source`). Each umbrella is 7-12x larger than a worker can complete within the manager turn budget, so the first dispatched ticket wedges in `spawn-morty` / `mux-runner`.

Live incident: session `2026-05-13-ba01c135` (`/pickle-tmux` on the 2026-05-13 mega-bundle) emitted 10 umbrella tickets, one per composed source (R-ICDM umbrella covering R-ICDM-1..7, R-MMTR umbrella, R-MWCL umbrella, R-MDS umbrella, +6 more). First dispatched ticket `3ab68cdd` (R-ICDM umbrella) implemented R-ICDM-1..7 in code over ~50 min but never reached the commit phase in 67 min. The operator hand-committed the dirty tree (`c23ab353`) and re-ran the run via a manual 9-agent decomposer fan-out in session `2026-05-13-c122b0f7`. The 2026-05-12 mega-bundle was similarly rescued by an operator-driven 5-agent fan-out (42 atomic tickets vs 5 umbrellas).

## Root cause

The refinement team's ticket emission is driven entirely by the three parallel analyst Mortys (`WORKER_ROLES = [requirements, codebase, risk-scope]`, `extension/src/bin/spawn-refinement-team.ts:304`). Each analyst reads the PRD as a flat document and emits a `## ac_shape_smells` JSON block whose `tickets[]` array becomes the manifest. `buildRefinementManifest` (`spawn-refinement-team.ts:2070`) assembles the manifest from `collectAcShapeData(results)` (`spawn-refinement-team.ts:1392`), which only concatenates the analyst-emitted `tickets[]` arrays. **No code path opens each composed source PRD, reads its `## Atomic decomposition` section, and lifts those R-codes into the ticket list.** The analyst prompt (`buildWorkerPrompt`, `spawn-refinement-team.ts:577`; role instructions at `:592-637`; `AC_SHAPE_PROMPT_SECTION` at `:107`) contains NO instruction to detect a `composes:` bundle-of-bundles shape or to fan out one ticket per atomic R-code — so analysts naturally produce one ticket per top-level section, i.e. one per composed source.

### B-ACSG overlap finding — INDEPENDENT (verified)

R-RSU is **distinct** from the just-shipped B-ACSG (v1.89.4). Evidence:

- **B-ACSG is the AC-shape gate/matcher** that *judges* analyst ticket shape after emission. Commit `4b1d9277` (R-ACSG-1) only changed `isParametrizedTicket` / `hasJustificationBlock` to read the joined `ticketShapeText(title+acceptance_test+justification)` (LOA-727 cross-field false-reject fix). Commit `3bfd47fa` (R-ACSG-2) only added `evaluateAcShapeAdvisory()` vs `evaluateAcShapeEnforcement()`, the `--skip-ac-shape-gate <reason>` flag, the `ac_shape_gate_bypassed` event, and actionable rejection messages. Both touch `evaluateAcShape*` / `isParametrizedTicket` / `runAcShapeEnforcement` — the **enforcement** path (`spawn-refinement-team.ts:1587`, `:1596`, `:2213`). That path runs AFTER `collectAcShapeData` has already gathered whatever tickets the analysts emitted; it can reject endpoint-enumeration over-fanning but does nothing about the **under-fanning / over-collapse** of a bundle-of-bundles into N umbrellas.
- **R-RSU is the emission granularity** — *which* tickets the analysts produce in the first place, governed by the analyst prompt (`buildWorkerPrompt` / role instructions / `AC_SHAPE_PROMPT_SECTION`) and validated at manifest-build time. Neither B-ACSG commit touched the analyst role prompts or `buildRefinementManifest`/`collectAcShapeData`. Different code paths.
- The existing `composes:` machinery in `spawn-refinement-team.ts` (`composedPrdPaths` `:1442`, `extractSourceRequirements` `:1499`, `enrichManifestTicketsFromSourcePrds` `:1549`) is **enrichment-only**: it walks the composes/peer-PRD closure to backfill `source_prd` / `source_section` / `mapped_requirements` on tickets the analysts ALREADY emitted (`buildRefinementManifest:2072`). It never *drives* ticket emission and never counts atomic R-codes. So the composes-aware code exists but solves a different problem (provenance), confirming the residual is genuine.

**B-WEDGE scope = the genuine residual:** make the analyst prompt fan out one atomic ticket per R-code across all composed sources when a bundle-of-bundles shape is present, and add an emission-time validation guard that fails loud when the manifest collapses to `tickets.length === composes.length` for such a PRD.

## In scope

- Analyst-prompt granularity guidance: when the input PRD declares `composes:` and the composed sources carry `## Atomic decomposition` sections, instruct analysts to emit one atomic ticket per R-code (never one umbrella per source).
- An emission-time validation guard in `spawn-refinement-team.ts` that detects the over-collapse and surfaces it (warning + activity event) rather than silently shipping umbrella tickets.
- A regression test that proves a 3-source bundle-of-bundles fixture produces ≥ the sum of atomic R-codes (not 3 umbrellas).
- A trap-door pin documenting the invariant.

## Not in scope

- A separate decomposer-worker subprocess module (`refinement-decomposer-worker.ts`) or a new `.claude/commands/refinement-decomposer.md` command file (R-RSU-2/R-RSU-3 in the draft) — net-new parallel-subprocess architecture that overlaps the existing 3-analyst design; the prompt-guidance + validation-guard fix codifies the operator fan-out spec without it.
- The `REFINEMENT_FANOUT_CAP` env knob (only meaningful for the separate-subprocess design above).
- R-WMW (#33, the worker-artifact-progress safety net) — owned by B-WSWA per the drain-queue overlap rule; explicitly removed from B-WEDGE.
- Changing `enrichManifestTicketsFromSourcePrds` provenance behavior or the B-ACSG enforcement matcher (both correct as-is).
- Any `state.json` schema change.

## Atomic tickets

### R-RSU-1 (small) — Analyst-prompt bundle-of-bundles fan-out guidance

- In `extension/src/bin/spawn-refinement-team.ts`, add a new exported prompt section constant (e.g. `BUNDLE_OF_BUNDLES_FANOUT_SECTION`) and append it to the analyst prompt built by `buildWorkerPrompt` (alongside `AC_SHAPE_PROMPT_SECTION` / `PATH_VERIFICATION_PROMPT_SECTION` in the `outputInstructions` block at `spawn-refinement-team.ts:678`).
- The section MUST instruct: when the PRD frontmatter declares `composes:` and a composed source PRD carries a `## Atomic decomposition` (or `## Atomic tickets`) section, emit **one ticket per R-code** listed there; do NOT collapse all R-codes for one source into a single umbrella ticket; do NOT invent R-codes not present in the source.
- The section MUST be reachable for every analyst role (it is appended in the shared `outputInstructions`, not per-role).
- Rebuild deployed `extension/bin/spawn-refinement-team.js` in the same change (source→deployed parity).
- **AC (machine-checkable):**
  - `grep -nE "BUNDLE_OF_BUNDLES_FANOUT_SECTION" extension/src/bin/spawn-refinement-team.ts` returns ≥ 2 hits (definition + use in `buildWorkerPrompt`).
  - `grep -nE "one ticket per R-code|one ticket per atomic R-code" extension/src/bin/spawn-refinement-team.ts` returns ≥ 1 hit.
  - `grep -cE "BUNDLE_OF_BUNDLES_FANOUT_SECTION" extension/bin/spawn-refinement-team.js` ≥ 1 (deployed parity).
  - `node --test extension/tests/spawn-refinement-team-manifest.test.js` exits 0 (no regression in existing manifest build).

### R-RSU-2 (medium) — Emission-time over-collapse validation guard + activity event

- In `extension/src/bin/spawn-refinement-team.ts`, add an exported pure predicate (e.g. `detectBundleOfBundlesOverCollapse(prdPath, manifest)`) that returns a structured result when: (a) the parent PRD frontmatter declares `composes:` with ≥ 2 entries via the existing `composedPrdPaths(parseFrontmatter(content))` helper, AND (b) at least one composed source resolved through the existing `extractSourceRequirements` / `composedPrdPaths` walk carries a `## Atomic decomposition` (or `## Atomic tickets`) section, AND (c) `manifest.tickets.length <= composedPrdPaths(...).length` (collapsed to ≤ one ticket per source).
- Invoke the predicate in `main()` after `buildRefinementManifest` (`spawn-refinement-team.ts:2208`) and BEFORE `writeManifestAtomic`. On a positive detection, write a `ticket_quality_warnings[]` entry (defect_class `bundle_of_bundles_over_collapse`, reusing the existing `TicketQualityWarning` shape and `combinedWarnings` plumbing at `:2204`) AND emit a `refinement_over_collapse_detected` activity event. The guard is observability-first: it MUST NOT throw or change the process exit code (a false positive must not brick refinement).
- Register `refinement_over_collapse_detected` in `extension/src/types/index.ts:VALID_ACTIVITY_EVENTS`, the `extension/types/index.js` mirror, `extension/src/types/activity-events.schema.json` (definition + `oneOf` reference), and the `ACTIVITY_EVENT_SCHEMA_SECTION` table in `spawn-refinement-team.ts` — all 4 registration touchpoints.
- Rebuild deployed `extension/bin/spawn-refinement-team.js` + `extension/types/index.js` in the same change.
- **AC (machine-checkable):**
  - `grep -nE "detectBundleOfBundlesOverCollapse" extension/src/bin/spawn-refinement-team.ts` returns ≥ 2 hits (definition + call in `main`).
  - `grep -c "refinement_over_collapse_detected" extension/src/types/index.ts` ≥ 1 AND `grep -c "refinement_over_collapse_detected" extension/types/index.js` ≥ 1 AND `grep -c "refinement_over_collapse_detected" extension/src/types/activity-events.schema.json` ≥ 1 AND `grep -c "refinement_over_collapse_detected" extension/src/bin/spawn-refinement-team.ts` ≥ 2 (constant table row + emit site).
  - `node --test extension/tests/spawn-refinement-team-bundle-of-bundles.test.js` (created by R-RSU-3) exits 0.
  - `node --test extension/tests/activity-event-payload.test.js` exits 0 (schema conformance for the new event).

### R-RSU-3 (medium) — Regression test + bundle-of-bundles fixture

- New test `extension/tests/spawn-refinement-team-bundle-of-bundles.test.js` (forward-created). Build an in-test temp bundle PRD whose frontmatter declares `composes:` with 3 source PRDs (`src-a.md`, `src-b.md`, `src-c.md`), each written to the temp dir with its own `## Atomic decomposition` enumerating R-A-1..3, R-B-1..3, R-C-1..3 respectively (follow the in-test temp-PRD construction pattern in `extension/tests/refinement-source-prd-relative.test.js` and `extension/tests/spawn-refinement-team-symbol-audit-annotations.test.js`).
- Positive case: feed a manifest with only 3 umbrella tickets (one per source) to `detectBundleOfBundlesOverCollapse` and assert it returns a positive detection (`tickets.length (3) <= composes.length (3)` AND atomic-decomposition sections present).
- Negative case 1: feed a manifest with 9 atomic tickets (R-A-1..R-C-3) and assert NO detection.
- Negative case 2: a single-PRD (no `composes:`) input MUST NOT trigger detection.
- Prompt-guidance assertion: assert `BUNDLE_OF_BUNDLES_FANOUT_SECTION` is present in the prompt returned by `buildWorkerPrompt(...)` for each `WORKER_ROLES` id.
- Carry `// @tier:` discovery comment consistent with sibling refinement tests; register so `bash extension/scripts/audit-test-tiers.sh` passes.
- **AC (machine-checkable):**
  - `test -f extension/tests/spawn-refinement-team-bundle-of-bundles.test.js` exits 0.
  - `node --test extension/tests/spawn-refinement-team-bundle-of-bundles.test.js` exits 0 with ≥ 4 assertions covering: positive over-collapse detection, two negative cases, prompt-section presence per role.
  - `bash extension/scripts/audit-test-tiers.sh` exits 0.

### R-RSU-4 (small) — Trap-door pin

- Add a trap-door entry for `src/bin/spawn-refinement-team.ts` to `extension/src/bin/CLAUDE.md` under `## Trap Doors`.
- INVARIANT: when the input PRD frontmatter declares `composes: [<≥2 list>]` and ≥1 composed source carries a `## Atomic decomposition` section, the analyst prompt MUST carry `BUNDLE_OF_BUNDLES_FANOUT_SECTION` (one ticket per R-code, no umbrella collapse) AND `main()` MUST run `detectBundleOfBundlesOverCollapse` before `writeManifestAtomic`, emitting `refinement_over_collapse_detected` + a `bundle_of_bundles_over_collapse` ticket-quality warning when `manifest.tickets.length <= composedPrdPaths(...).length`. The guard is observability-only (never throws, never changes exit code).
- BREAKS: removing the prompt section re-opens the section-umbrella over-collapse (incident `2026-05-13-ba01c135` ticket `3ab68cdd`, 67-min wedge); making the guard throw bricks refinement on a false positive.
- ENFORCE: `extension/tests/spawn-refinement-team-bundle-of-bundles.test.js` (created by R-RSU-3).
- PATTERN_SHAPE: `BUNDLE_OF_BUNDLES_FANOUT_SECTION` consumed in `buildWorkerPrompt` AND `detectBundleOfBundlesOverCollapse(` called in `main` before `writeManifestAtomic`.
- **AC (machine-checkable):**
  - `grep -cE "BUNDLE_OF_BUNDLES_FANOUT_SECTION|detectBundleOfBundlesOverCollapse|refinement_over_collapse_detected" extension/src/bin/CLAUDE.md` ≥ 1.
  - `bash extension/scripts/audit-trap-door-enforcement.sh` exits 0.

### C-WEDGE-CLOSER [manager] — Ship B-WEDGE

- Run the FULL release gate from `extension/`: `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-subprocess-heavy-tests.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`. Confirm GREEN before any bump/commit/tag (READ the gate result first — never batch the tag with the gate-read).
- Bump `extension/package.json` to **1.89.5** (PATCH — prompt text + observability guard + test + trap-door pin; no new feature surface, no breaking change, schema-neutral). Commit `chore(C-WEDGE-CLOSER): ship B-WEDGE — bump 1.89.5 + repoint MASTER_PLAN`.
- `bash install.sh`; verify clean working tree (`git status` clean) and deployed JS matches source (install.sh parity gate green).
- `git push`; `gh release create v1.89.5`.
- Repoint MASTER_PLAN: mark B-WEDGE SHIPPED (drain-queue row removed, Status version updated) and close finding #30 (R-RSU).
- **AC (machine-checkable):**
  - Release gate exits 0 (all phases green).
  - `node -p "require('./extension/package.json').version"` prints `1.89.5`.
  - `git status --porcelain` is empty after `bash install.sh` (clean tree, deployed matches source).
  - `gh release view v1.89.5` exits 0 (release exists).
  - `grep -c "B-WEDGE" MASTER_PLAN.md` ≥ 1 AND the B-WEDGE row is marked SHIPPED.

## Acceptance (bundle-level)

- A `composes:` bundle-of-bundles PRD whose sources carry `## Atomic decomposition` sections drives analysts to emit one ticket per R-code (R-RSU-1), and any residual over-collapse is surfaced via `refinement_over_collapse_detected` + a ticket-quality warning instead of silently wedging (R-RSU-2).
- The over-collapse guard is observability-only — it never throws and never changes the refinement exit code (R-RSU-2).
- B-ACSG enforcement (`isParametrizedTicket` / `runAcShapeEnforcement`) and `enrichManifestTicketsFromSourcePrds` provenance behavior are unchanged (Not in scope).
- Regression coverage proves positive detection + two negative cases + per-role prompt presence (R-RSU-3).
- Trap-door pin present and enforced (R-RSU-4); release gate green, clean tree, shipped through `gh release create v1.89.5` (C-WEDGE-CLOSER).

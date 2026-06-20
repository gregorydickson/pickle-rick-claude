---
title: P2 — `/pickle-tmux` auto-refinement composes bundle-of-bundles PRD into N section umbrella tickets instead of fanning out atomic R-coded tickets (R-RSU)
status: Draft
filed: 2026-05-13
priority: P2 (bundles routinely wedge on oversized umbrella tickets; manual operator workaround works but does not scale)
type: bug
r_codes:
  - R-RSU-1
  - R-RSU-2
  - R-RSU-3
  - R-RSU-4
  - R-RSU-5
related:
  - prds/archive/bug-reports/p2-worker-manager-wedge-oversized-ticket-no-artifact-progress.md   # R-WMW — companion bug. R-RSU is the root-cause (oversized tickets get generated); R-WMW is the safety net (worker should fail-loud when a still-oversized ticket exhausts the manager budget with zero artifact progress).
  - prds/archive/bug-reports/p1-mux-runner-no-claude-manager-relaunch-on-max-turns.md   # R-MMTR (Finding #19) — adjacent in surface: both bite the same wedge class when a manager turn budget is exhausted on a single oversized ticket.
---

# P2 — `/pickle-tmux` auto-refinement section-umbrella granularity bug

## Problem (one paragraph)

`/pickle-tmux` invokes the refinement team (`spawn-refinement-team.ts`) on a bundle PRD. When the bundle PRD declares `composes: [<list of source PRDs>]` in its frontmatter and each composed source PRD already contains its own `## Atomic decomposition` section (R-codes R-X-1..R-X-N for some letter prefix X), the current refinement team produces **one umbrella ticket per source PRD** rather than fanning out per-R-code atomic tickets. The umbrella tickets are typically 7-12x larger than a single worker can complete within the manager turn budget; they trigger downstream wedges in `spawn-morty` and `mux-runner` (sister Finding R-WMW). The 2026-05-12 mega-bundle was rescued only because the operator manually spawned 5 parallel decomposer agents — one per source PRD — and walked each source's atomic-decomposition section by hand. The 2026-05-13 session `2026-05-13-ba01c135` repeated the auto-refinement path and produced 10 section-umbrella tickets (R-ICDM, R-MMTR, ..., R-MDS); the operator manually fan-out repaired the run in session `2026-05-13-c122b0f7` with a 9-agent fan-out currently in flight.

## Observed incident

**Wedged session** (auto-refinement, broken path):

- `~/.local/share/pickle-rick/sessions/2026-05-13-ba01c135/` — `/pickle-tmux` against the 2026-05-13 mega-bundle PRD.
- `refinement_manifest.json` produced **10 tickets**, one per composed source PRD:
  - `R-ICDM` umbrella (covers R-ICDM-1..7)
  - `R-MMTR` umbrella (covers R-MMTR-1..5)
  - `R-MWCL` umbrella (covers R-MWCL-1..7)
  - `R-MDS` umbrella (covers R-MDS-1..6)
  - ... 6 more
- First ticket dispatched: `3ab68cdd` (R-ICDM umbrella). Worker actually implemented R-ICDM-1..7 in code over ~50 minutes but **never reached the commit phase** in 67 minutes wall-clock because the manager loop kept re-iterating research/plan without delegating completion.
- Operator manually `git status`'d the dirty tree, found correct R-ICDM-1..7 implementation, and committed as `c23ab353`.

**Working session** (manual fan-out, correct path — both pre-incident and post-incident):

- 2026-05-12 mega-bundle (session `2026-05-11-e1a3a5dd`): operator spawned 5 parallel decomposer agents in a `claude` sub-shell, one per source PRD. Each decomposer read its source PRD's `## Atomic decomposition` and emitted 5-10 atomic R-coded ticket files. Total: **42 tickets from 5 source PRDs** (vs 5 umbrellas if auto-refinement had been used).
- 2026-05-13 session `2026-05-13-c122b0f7`: operator repeated the fan-out pattern with 9 parallel decomposers for the 10 composed sources (one decomposer per source PRD + 1 coordinator). Currently in flight, producing atomic tickets at ~6-10 tickets per source.

**Reproduction**:

1. Take any bundle PRD whose frontmatter declares `composes: [<list of source PRDs>]` where each source PRD has its own `## Atomic decomposition` section with R-coded sub-tickets.
2. Invoke `/pickle-tmux <bundle-prd>.md`.
3. Inspect the resulting `refinement_manifest.json` — count of tickets will equal count of composed sources (N), NOT the sum of atomic R-codes (N * ~7).
4. First dispatched ticket will be an umbrella that fails to commit within manager turn budget.

## Root cause

`extension/src/bin/spawn-refinement-team.ts` (deployed `extension/bin/spawn-refinement-team.js`) does not detect the bundle-of-bundles shape. The refinement-analyst prompts treat the PRD as a flat document — they read top-level sections and produce one ticket per major section (in this case, one section per composed source PRD). The `composes:` frontmatter field is **silently ignored**: there is no code path that opens each composed source PRD, reads its `## Atomic decomposition`, and lifts those R-codes into the ticket list.

The structural shape is identical to Citadel's `composes:` frontmatter walk gap (Finding #14, R-CCNW-6 in `prds/p2-citadel-conformance-core-not-wired-or-silently-skipped.md`) — citadel's prd-parser also misses ~50 lifted-by-reference ACs in bundle-of-bundles PRDs because it only walks inline sections. Same root cause, different consumer.

## Source surface

**Files to touch**:

- `extension/src/bin/spawn-refinement-team.ts` — detect `composes:` frontmatter; when present, switch ticket-generation strategy from "one per top-level section" to "one per atomic-R-code across all composed sources."
- `extension/src/services/prd-parser.ts` (or equivalent — verify actual module) — add `composes:` walker that opens each source PRD and extracts `## Atomic decomposition` R-codes.
- `extension/tests/spawn-refinement-team.test.js` (new or extend) — regression: mock bundle PRD with 3 composed sources, each declaring 5 atomic R-codes; assert manifest has ≥15 atomic tickets (not 3 umbrellas).

## Atomic tickets — R-RSU family ("refinement section-umbrella")

### R-RSU-1 — Detect `composes:` bundle-of-bundles shape in refinement entrypoint

- In `spawn-refinement-team.ts`, before launching the analyst team, parse the input PRD frontmatter and check for `composes: [<list>]`.
- For each composed PRD path, open the file and verify it contains a `## Atomic decomposition` section.
- If ALL composed PRDs satisfy this shape, set `mode='bundle-of-bundles'` and switch to the fan-out generator. Otherwise (mixed shape or single PRD), keep the current behavior.
- Surface the detection via an `activity` event: `refinement_mode_detected` with `{ mode, composed_count, atomic_count_estimate }`.
- File: `extension/src/bin/spawn-refinement-team.ts`. ~40 LOC + tests.

### R-RSU-2 — Fan-out N parallel decomposer Mortys, one per composed source PRD

- When `mode === 'bundle-of-bundles'`, spawn N parallel `claude -p` subprocesses (capped at `REFINEMENT_FANOUT_CAP=10`, configurable via env) — one per composed source PRD.
- Each subprocess receives only its single source PRD + a strict prompt: "Read the `## Atomic decomposition` section. Emit one atomic ticket file per R-code listed there. Do not invent R-codes. Do not collapse multiple R-codes into one ticket."
- Reuse the existing worker-session log infrastructure: `refinement/worker_decomposer_<source-slug>.log`.
- Wait for all fan-out workers to complete before writing `refinement_manifest.json`.
- File: `extension/src/bin/spawn-refinement-team.ts` + new `extension/src/services/refinement-decomposer-worker.ts`. ~120 LOC + tests.

### R-RSU-3 — Decomposer Morty prompt + ticket-writer contract

- Decomposer prompt template lives at `.claude/commands/refinement-decomposer.md` (new).
- Prompt instructs: open the supplied source PRD, parse its `## Atomic decomposition` section, for each R-X-N entry write a ticket file at `<session>/refinement/tickets/R-X-N.md` containing: ticket title, acceptance criteria lifted verbatim, file surface, trap-door pin (if mentioned), test target. Do NOT merge tickets. Do NOT skip R-codes.
- The aggregator in `spawn-refinement-team.ts` reads all `tickets/R-*.md` files and assembles `refinement_manifest.json`.
- File: `.claude/commands/refinement-decomposer.md` (new), `extension/src/services/refinement-decomposer-worker.ts`. ~60 LOC of prompt + glue.

### R-RSU-4 — Regression test: 3-source bundle produces ≥6 atomic tickets

- New: `extension/tests/integration/spawn-refinement-team-bundle-of-bundles.test.js`.
- Scenario: fixture PRD `prds/fixtures/mock-bundle-of-bundles.md` declares `composes: [src-a.md, src-b.md, src-c.md]`. Each fixture source declares `## Atomic decomposition` with R-A-1..3, R-B-1..3, R-C-1..3 respectively.
- Assert: after `spawn-refinement-team.ts` completes against this PRD, `refinement_manifest.json` has exactly 9 tickets (not 3 umbrellas); ticket IDs are `R-A-1`, `R-A-2`, ..., `R-C-3`.
- Negative scenario: a single-PRD (non-bundle) input must NOT trigger fan-out and produces the same output the current code does.
- ~150 LOC.

### R-RSU-5 — Trap-door pin in `extension/src/bin/CLAUDE.md` (or refinement-team's nearest CLAUDE.md)

- INVARIANT: When the input PRD's frontmatter contains `composes: [<list>]` and ALL composed source PRDs declare a `## Atomic decomposition` section, refinement MUST fan out one analyst per source PRD and produce one ticket per R-code listed in each source. Collapsing all R-codes for one source into a single "umbrella" ticket is forbidden.
- ENFORCE: `tests/integration/spawn-refinement-team-bundle-of-bundles.test.js` (R-RSU-4).
- PATTERN_SHAPE: bundle PRD with `composes:` frontmatter; refinement output with `tickets.length === composes.length` instead of `tickets.length === sum(atomic_R_code_count per source)`.
- File: `extension/src/bin/CLAUDE.md` (or whichever subsystem CLAUDE.md governs `spawn-refinement-team.ts`; verify and create if missing).

## Estimated scope

- R-RSU-1..5 total: ~400 LOC across `spawn-refinement-team.ts`, new decomposer worker module, new fixture + integration test, new prompt template, trap-door pin.
- Half-day to full-day single PR.
- Net atomic ticket count for a 5-source bundle goes from 5 umbrellas to ~30-50 atomic tickets. **Operator manual fan-out becomes unnecessary**; auto-refinement closes the gap.

## Reproduction (deterministic)

1. Take any historical bundle-of-bundles PRD (e.g. `prds/archive/bundles/p1-bug-fix-bundle-2026-05-12-mega.md`) — declares `composes:` with 5 source PRDs, each carrying atomic decomposition.
2. `/pickle-tmux <that-prd>.md` against a throwaway target repo.
3. Inspect `refinement_manifest.json` once refinement completes — confirm only N tickets (one per source) and N is much less than sum of R-codes across sources.
4. Manually count R-codes across all sources to confirm the gap.

## Session evidence

- Wedged session: `~/.local/share/pickle-rick/sessions/2026-05-13-ba01c135/`
  - `refinement_manifest.json` — 10 umbrella tickets, one per source PRD
  - `<ticket-3ab68cdd>/worker_session_*.log` — R-ICDM umbrella, 67-min wedge, 157-byte log with "no stdin data received"
  - Dirty-tree recovery: commit `c23ab353` (manually committed by operator)
- Working session (pre-bug, manual fan-out worked): `~/.local/share/pickle-rick/sessions/2026-05-11-e1a3a5dd/`
  - 42 atomic tickets from 5 source PRDs via operator-driven fan-out
- Working session (post-bug, manual fan-out replicated): `~/.local/share/pickle-rick/sessions/2026-05-13-c122b0f7/`
  - 9-agent operator-driven decomposer fan-out currently in flight

## Cross-references

- **R-WMW** (companion finding, this batch) — safety net. R-WMW catches the wedge that R-RSU prevents. Both should ship; if R-RSU lands first, R-WMW becomes the belt-and-suspenders. If they ship together, R-RSU is the structural fix and R-WMW the observability + auto-skip backstop.
- **R-CCNW-6** (Finding #14, `prds/p2-citadel-conformance-core-not-wired-or-silently-skipped.md`) — adjacent `composes:` frontmatter walk gap in citadel's prd-parser. Same root cause, different consumer. Consider sharing the `composes:` walker utility between citadel and refinement.
- **R-MMTR** (Finding #19, `prds/archive/bug-reports/p1-mux-runner-no-claude-manager-relaunch-on-max-turns.md`) — when an umbrella ticket exhausts manager max-turns, R-MMTR's relaunch escape hatch fires. R-RSU removes the precondition by not producing oversized tickets in the first place.

## Notes

- Operator workaround pattern (per MASTER_PLAN line 3 commentary): "spawned 5 parallel decomposer agents, one per source PRD." That manual pattern is the spec — R-RSU codifies it into the refinement entrypoint.
- The `REFINEMENT_FANOUT_CAP` cap (default 10) exists so a pathological 50-source bundle PRD doesn't accidentally launch 50 concurrent claude subprocesses. Operators can override via env if they have a legitimate large-bundle workload.
- This bug interacts with Finding #28 R-ICDM: the wedged R-ICDM umbrella ticket in session `2026-05-13-ba01c135` was the R-ICDM finding's PRD itself. Ironic — the bundle-of-bundles refinement bug delayed the fix for the iteration-classifier bug whose PRD was inside the bundle.

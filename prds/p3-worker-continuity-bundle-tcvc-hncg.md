---
title: "B-TCHN — Worker-continuity bundle: tier classifier sees verification cost (R-TCVC) + mechanical handoff-notes fallback on zero-artifact exit (R-HNCG)"
priority: P3
finding: R-TCVC, R-HNCG
status: queued
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
depends_on: "none (deploy-agnostic BUILD)"
source_assessment: "prds/BUG-REPORT-2026-07-05-tier-classifier-blind-to-verification-cost.md + prds/BUG-REPORT-2026-07-05-handoff-notes-continuity-gap-on-verification-heavy-tickets.md (both from session 2026-07-04-4f50b896 ticket 43e8f1a9 — 6 zero-progress spawns before salvage)"
---

# B-TCHN — worker-continuity bundle (R-TCVC + R-HNCG)

## 0. The defects (one incident, two legs)

Ticket `43e8f1a9` (verification-heavy audit, codex backend) burned 6 consecutive spawns with
zero counted artifact progress before `commit-and-continue` salvaged a real gate-passing diff.
Two composing causes, both filed 2026-07-05 and explicitly "no new state field/gate":

- **R-TCVC:** `classifyTicketTier` (`extension/src/services/pickle-utils.ts:~591`) is a pure
  function of fileCount/acCount/locEstimate + a 9-word keyword list — it has NO signal for
  acceptance-criteria VERIFICATION cost. A ticket whose AC carries `Verify: pnpm test:migration`
  (container-based DB suite) sizes identically to one with only greps, so its worker budget is
  structurally too small.
- **R-HNCG:** `handoff_notes.md` is written only as a "before you finish" prompt step; a spawn
  that dies mid-verification writes nothing, and the next spawn re-derives everything. The
  PROMPT-level mitigation already landed 2026-07-10 (checkpoint-before-risky-ops prose in
  send-to-morty.md + szechuan-sauce.md); the MECHANICAL fallback remains unbuilt.

## 1. Workstreams

### WS-TCHN-1 — R-TCVC: verification-cost signal in the existing tier classifier

- **AC-TCHN-1A** — extend the EXISTING keyword/dimension extraction in `classifyTicketTier`
  (and/or the refinement-time tier assignment that feeds `complexity_tier` frontmatter) to
  recognize known-expensive verify-command shapes in AC text — at minimum: `test:migration`,
  `docker`, `compose`, `e2e`, `playwright`, `RUN_EXPENSIVE_TESTS`, `test:integration` — and bump
  tier (and thereby the tier's existing worker_timeout budget) by one step, capped at `large`.
  NO new state field, NO new gate, NO separate classifier — this is a widened input to the
  existing ±1 keyword adjustment. — Type: test (table-driven cases in the existing
  `ticket-tier.test.js` home: expensive-verify AC bumps medium→large; cheap ACs unchanged;
  already-large stays large)
- **AC-TCHN-1B** — the incident fixture: a ticket shaped like `43e8f1a9` (4 ACs, one
  `test:migration`) classifies one tier above its keyword-less twin. — Type: test
- **AC-TCHN-1C** — R-CNAR-1 invariants preserved: `getTicketTierBudgetWithOverrides` precedence
  and the cap-split trap doors untouched (`applyTicketTierBudget` still never writes
  `state.max_iterations`). — Type: test (existing pins green: `ticket-tier.test.js`,
  `mux-runner-cap-split.test.js`)

### WS-TCHN-2 — R-HNCG: mechanical handoff fallback on zero-artifact exit

- **AC-TCHN-2A** — when a worker exit is classified zero-artifact-progress for its spawn (REUSE
  the existing `state.worker_artifact_progress` / `recordWorkerArtifactProgress` signal — build
  NO new progress detector), spawn-morty (or the mux post-iteration region, worker's research
  picks the seam with fewest new edges) appends a minimal machine-generated block to the
  ticket's `handoff_notes.md`: spawn pid, phase reached (from newest artifact prefix present),
  dirty in-scope paths, last 20 lines of the worker session log. Append-only; never overwrites a
  worker-authored note; best-effort try/catch (continuity aid must never fail an iteration). —
  Type: test
- **AC-TCHN-2B** — the fallback block is idempotent per spawn (re-running the check for the same
  pid does not duplicate) and clearly machine-tagged (`<!-- auto-handoff spawn <pid> -->`). —
  Type: test
- **AC-TCHN-2C** — no schema change: no new activity event, no state field (the R-WMFF
  breadcrumb event from B-WMFF covers telemetry if that bundle landed first; this bundle's leg
  is the on-disk continuity note only). — Type: lint (no `VALID_ACTIVITY_EVENTS` /
  `activity-events.schema.json` diff in this bundle)

## 2. Out of scope

- New tier tiers, new budget fields, per-AC budget math (the ±1 bump is the whole mechanism).
- Prompt-text changes (R-HNCG's prompt leg already shipped 2026-07-10).
- Salvage/Done-flip/completion-evidence paths (R-PSRB adjacency — the fallback note writer must
  not touch ticket frontmatter or status).

## Simplification Review (subtract-before-add)

**WS-1** — (1) Widens an existing keyword list; adds no mechanism. (2) REUSE: the existing ±1
adjustment + existing tier budgets; explicitly rejects a "verification-cost classifier" module.
(3) The brittle thing (under-budgeted spawns thrashing the recovery ladder) is fixed at input,
not guarded downstream. (4) Subtraction: none available beyond avoided machinery; recorded.

**WS-2** — (1) One append-only writer behind an existing signal. (2) REUSE:
`worker_artifact_progress` (R-WMW machinery) as the trigger; artifact-prefix helpers for phase
detection. (3) Not a guard — a continuity aid. (4) Subtraction: none; the rejected alternative
(forced per-AC checkpoint gate) was the heavier addition and is explicitly not built.

## Risks

- Keyword lists drift (the R-FOMH lesson) — keep the expensive-verify list a single exported
  const with its test table generated from it.
- The fallback writer racing a live worker's own handoff write — mitigated: fallback fires only
  on the zero-artifact-exit path (worker already dead), append-only, machine-tagged.

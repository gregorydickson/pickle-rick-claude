# PRD: Proportional & Intent-Aware Pipeline Processing

- **Epic code:** R-PIAP
- **Priority:** P2
- **Date:** 2026-05-21
- **Status:** Draft (pending refinement)
- **Target repo:** `pickle-rick-claude` (`extension/src/`, `.claude/commands/`)

## Problem Statement

The autonomous pipeline applies **maximum process and maximum correction to every
ticket and every branch, regardless of context**. Two distinct failure modes fall
out of the same root cause:

1. **Over-engineering small work.** Every ticket — a one-line padding fix, a
   duplicate-label deletion — runs the full 8-phase Morty lifecycle
   (research → research-review → plan → plan-review → implement → conformance →
   code-review → simplify). `send-to-morty.md:172` explicitly forbids the worker
   from finishing until research_*.md, plan_*.md, conformance_*.md, AND
   code_review_*.md all exist. A `trivial`-tier ticket gets a 5-minute budget
   to do 8 phases — so it does not run *less*, it *rushes more*, and frequently
   over-thinks and over-builds a change that should have been one edit.

2. **Over-correcting deliberate work.** When `anatomy-park` / `szechuan-sauce`
   run on branches that are primarily UI/UX changes, they treat intentional
   visual decisions as slop. A deliberate `padding: 13px` reads as a magic-number
   nit to normalize; two visually-distinct components read as a clean P2
   DRY opportunity; bespoke JSX reads as inconsistent formatting. The cleanup
   phases alter or revert the author's design work and ship it broken.

### Current State (what exists, what does not)

| Capability | Status |
|---|---|
| `complexity_tier` taxonomy (`trivial`/`small`/`medium`/`large`) | ✅ `pickle-utils.ts:490` |
| `TICKET_TIER_BUDGETS` → drives `worker_timeout_seconds`, `max_iterations`, model | ✅ `pickle-utils.ts:506` |
| `tier_phase_skipped` event | ⚠️ exists but scoped to `tier: small` + `skipped_phases: test:fast/test:integration` only — it skips spawn-morty's **post-worker test gate**, NOT lifecycle phases (`spawn-morty.ts:1015`) |
| Tier → **lifecycle phase set** | ❌ `send-to-morty.md` has zero tier conditionals; all tiers run all 8 phases |
| `trivial` tier eligible for any lifecycle reduction | ❌ not even in the `tier_phase_skipped` enum |
| Deterministic ticket-sizing classifier | ❌ tier is assigned by refinement-analyst judgment only (`spawn-refinement-team.ts:138`) |
| Anti-over-engineering directive for small work | ❌ none |
| Design-intent awareness in `szechuan-sauce`/`anatomy-park` | ❌ "regression" means failing tests, never broken layout; the false-positive filter does not recognize intentional visual choices |
| `--scope`/`allowed_paths` path filtering for cleanup phases | ✅ `filterByScope`, `filterBySubsystem` — reusable primitive |
| `szechuan-sauce` domain principles (`--domain <name>`) + `## False Positives` list | ✅ reusable extension point |

The blunt remediation circulating ("cut `worker_timeout` from 1200s to 600s") is
the **wrong lever** — budgets are already tiered; squeezing them makes Morty
rush, not skip. The fix is structural: scale the *phase set*, not the clock.

## Goals

- A `trivial`/`small` ticket runs a **smaller lifecycle**, not a faster one.
- Ticket tier is assigned by a **deterministic, testable, bidirectional**
  classifier — small work is sized down, oversized work is sized up.
- Workers on small tickets receive an explicit **minimalism directive** and a
  diff-envelope guard against scope creep.
- `anatomy-park` / `szechuan-sauce` **auto-detect UI-primary branches** and
  switch to a **design-safe (flag-only)** mode that never modifies or reverts
  branch-authored visual code.
- Completion validation, resume detection, and the `tier_phase_skipped` event
  all agree on a **single canonical tier→phase map**.

## Non-Goals

- Redesigning the refinement team or its analyst roles.
- Building a visual-regression / screenshot-diff test framework (the
  screenshot-gate option was offered and declined; flag-only was chosen).
- Changing the 4-phase pipeline orchestration (`pickle → citadel →
  anatomy-park → szechuan-sauce` is unchanged).
- Backward-compat shims — greenfield project, no legacy aliases.

---

## Pillar A — Tier-Proportional Lifecycle

### Locked design decisions

- **Phase matrix: Aggressive.** Every tier always retains a `code_review`
  phase as the safety net.

  | Tier | Lifecycle phases |
  |---|---|
  | `trivial` | `implement` → `code_review` |
  | `small` | `plan` → `implement` → `code_review` |
  | `medium` | `research` → `research_review` → `plan` → `plan_review` → `implement` → `conformance` → `code_review` → `simplify` |
  | `large` | full 8, with an intensified code-review directive |

- **Plan source for skipped phases:** the **ticket body**. Refinement already
  performed the research; the worker on a `trivial`/`small` ticket reads the
  ticket's `## Problem` / `## Solution` / `## Research Seeds` and implements
  directly. No new artifact format is introduced.
- **Sizing mechanism: deterministic classifier**, authoritative at refinement,
  bidirectional. Analyst judgment becomes a hint the classifier may override.

### Requirements

**R-PIAP-A1 — Canonical tier→phase map.**
Add `TIER_LIFECYCLE: Record<TicketComplexityTier, LifecyclePhase[]>` to
`extension/src/services/pickle-utils.ts`, beside `TICKET_TIER_BUDGETS`, using
the matrix above. `LifecyclePhase` is a typed union of the canonical phase IDs
(`research`, `research_review`, `plan`, `plan_review`, `implement`,
`conformance`, `code_review`, `simplify`). This is the single source of truth
consumed by A2, A4, and A5.

**R-PIAP-A2 — Tier-parameterized worker prompt.**
`send-to-morty.md`'s `## Lifecycle` section and `## Resume Detection` table
become tier-parameterized. `spawn-morty.ts` injects the active phase list for
the ticket's tier into the prompt; the worker runs only those phases, in order.
The hard "ALL six lifecycle phases" mandate at `send-to-morty.md:172` is
replaced by "all phases in the tier's lifecycle set." Resume detection only
expects artifacts for in-set phases.

**R-PIAP-A3 — Minimalism directive + diff-envelope guard.**
For `trivial`/`small` tickets, `spawn-morty.ts` injects a minimalism directive:
*"This is a {tier} ticket. Make the smallest correct change. Do not refactor
adjacent code, do not add abstractions, do not rename or restructure beyond the
ticket's explicit ask. If the fix is one line, it is one line."* If the
worker's diff exceeds the tier's expected envelope (`trivial` ≲ 20 changed
LOC, `small` ≲ 80 changed LOC — tunable constants), emit a
`tier_diff_envelope_exceeded` activity event and surface a warning; this is a
soft signal, not a hard block.

**R-PIAP-A4 — Completion validation honors the tier lifecycle.**
The worker-completion validator (the path that computes
`worker_partial_lifecycle_exit` / `gate_payload.artifacts_missing` and may
revert a ticket to `Failed`) must consult `TIER_LIFECYCLE[tier]`. A `trivial`
ticket with `implement` + `code_review` evidence and no `research_*.md` MUST
validate as complete, not be reverted to `Failed`.

**R-PIAP-A5 — Deterministic sizing classifier.**
Add `classifyTicketTier(ticketInfo): TicketComplexityTier` to `pickle-utils.ts`.
Deterministic inputs: in-scope file count, acceptance-criteria count, LOC/diff
estimate, and keyword signals (e.g. `padding`/`typo`/`rename`/`delete`/`copy`/
`label`/`color` → smaller; `integrate`/`migrate`/`schema`/`cross-cutting`/
`refactor` → larger). The classifier is **conservative**: ties round **up** to
the larger tier. `spawn-refinement-team.ts` runs it after tickets are drafted
and writes the result as the authoritative `complexity_tier`. If a ticket
reaches the manager with no tier (e.g. refinement was skipped), `spawn-morty.ts`
runs the classifier as a fallback before delegation.

**R-PIAP-A6 — Extend the `tier_phase_skipped` event.**
Widen the `activity-events.schema.json` definition: `tier` enum gains
`trivial`, `small`, `medium`; `skipped_phases` items gain the lifecycle phase
IDs. Emit the event whenever a tier's lifecycle prunes phases relative to the
full 8, recording the skipped phase IDs.

### Acceptance Criteria — Pillar A

- **AC-PIAP-A1-1:** `TIER_LIFECYCLE` exists in `pickle-utils.ts` and a unit test
  asserts the four tier arrays match the matrix above exactly.
- **AC-PIAP-A2-1:** A test spawning a `trivial`-tier ticket asserts the rendered
  worker prompt contains only `implement` + `code_review` lifecycle steps and
  the resume table references no other phase.
- **AC-PIAP-A3-1:** A `trivial`/`small` worker prompt contains the minimalism
  directive string; a test asserts its presence.
- **AC-PIAP-A3-2:** A test feeding a 200-LOC diff for a `trivial` ticket asserts
  a `tier_diff_envelope_exceeded` event is written and the run is **not** hard-blocked.
- **AC-PIAP-A4-1:** A test of the completion validator with a `trivial` ticket
  (only `implement` + `code_review` artifacts) asserts it validates as complete
  and is **not** reverted to `Failed`.
- **AC-PIAP-A5-1:** `classifyTicketTier` is deterministic — a test asserts equal
  inputs yield equal output across repeated calls.
- **AC-PIAP-A5-2:** Fixture tickets exercise each tier boundary; a test asserts
  the classifier returns the expected tier, and that ambiguous inputs round **up**.
- **AC-PIAP-A5-3:** A ticket with no `complexity_tier` reaching `spawn-morty.ts`
  is classified before delegation (test asserts a tier is resolved, never the
  bare `medium` default-without-classification).
- **AC-PIAP-A6-1:** `activity-events.schema.json` validates a `tier_phase_skipped`
  event with `tier: trivial` and lifecycle phase IDs in `skipped_phases`; a
  schema test confirms it.

---

## Pillar B — Intent-Aware Cleanup

### Locked design decisions

- **UI detection: auto-detect from the diff, with an explicit override.**
- **Enforcement: flag-only.** In design-safe mode, cleanup may analyze and
  *report* visual findings but never modifies or reverts branch-authored visual
  code. Real (non-visual) bugs in the same branch are still fixed normally.

### Requirements

**R-PIAP-B1 — UI-primary diff classifier.**
Add `classifyDiffVisualDominance(diffStat): boolean` to `pickle-utils.ts`. A
branch/diff is **UI-primary** when the share of changed lines in visual files
exceeds a tunable threshold (initial: > 60%). "Visual files/lines" =
`.css`/`.scss`/`.sass`/`.less`, styled-component template blocks, and
JSX/TSX markup or `className`/`style` edits. The function is pure and testable.

**R-PIAP-B2 — Pipeline wires `design_safe` into cleanup phases.**
`pipeline-runner.ts` computes UI-primary status before launching
`anatomy-park` / `szechuan-sauce` and passes `design_safe: true` into the phase
context (`microverse.json` / handoff). An explicit `--design-safe` /
`--no-design-safe` flag (and/or a PRD/branch marker) overrides the
auto-detection in either direction. Detection errs toward design-safe when near
the threshold.

**R-PIAP-B3 — UI-aware principles supplement.**
Add a new `szechuan-sauce-ui-principles.md` (deployed under
`~/.claude/pickle-rick/`, source in the repo). It codifies: deliberate visual
decisions are author intent; never normalize magic-number spacing/colors; never
DRY visually-distinct components; never reformat JSX/markup for "consistency."
When `design_safe` is set, `szechuan-sauce` auto-loads this file as a domain
principles supplement (reusing the existing `--domain` precedence mechanism).

**R-PIAP-B4 — Branch-authored visual code is flag-only.**
In design-safe mode, a finding whose target line is **(a)** in a visual file
**and (b)** introduced or modified by the branch under review is demoted to
**report-only**: written to `gap_analysis.md` / the findings report, never
auto-fixed, never reverted, and never selected as an iteration's actioned
violation. `szechuan-sauce`'s false-positive filter gains an "intentional design
choice" category; `anatomy-park`'s "fix the highest-severity finding" step
skips report-only findings. Findings on **non-visual** code, and pre-existing
(non-branch-authored) issues, are unaffected.

**R-PIAP-B5 — Documentation.**
Per the repo Documentation Rule, `README.md` documents the `--design-safe` /
`--no-design-safe` flags and the auto-detection behavior for both cleanup
commands.

### Acceptance Criteria — Pillar B

- **AC-PIAP-B1-1:** `classifyDiffVisualDominance` returns `true` for a fixture
  diff that is > 60% visual lines and `false` for a logic-dominated diff; a unit
  test covers both and the threshold boundary.
- **AC-PIAP-B2-1:** A test asserts `pipeline-runner.ts` sets `design_safe: true`
  in the cleanup phase context for a UI-primary branch, and that
  `--no-design-safe` overrides it to `false`.
- **AC-PIAP-B3-1:** `szechuan-sauce-ui-principles.md` exists in the repo and is
  installed by `install.sh`; a deploy test asserts it lands under
  `~/.claude/pickle-rick/`.
- **AC-PIAP-B4-1:** Integration test — a fixture branch with a deliberate
  `padding: 13px` and two near-duplicate components, run through `szechuan-sauce`
  in design-safe mode: `git diff` of the visual files before/after the run is
  **empty** (zero modifications), while a planted non-visual logic bug in the
  same branch is still fixed.
- **AC-PIAP-B4-2:** A test asserts design-safe `anatomy-park` never selects a
  report-only (branch-authored visual) finding as the iteration's actioned fix.
- **AC-PIAP-B4-3:** A test asserts a non-visual finding in a UI-primary branch
  is still flagged and actioned normally (design-safe does not silence logic bugs).

---

## Affected Surfaces

| File | Change |
|---|---|
| `extension/src/services/pickle-utils.ts` | `TIER_LIFECYCLE`, `LifecyclePhase`, `classifyTicketTier`, `classifyDiffVisualDominance`, envelope constants |
| `.claude/commands/send-to-morty.md` | tier-parameterized Lifecycle + Resume Detection; minimalism directive injection point; replace the line-172 all-phases mandate |
| `extension/src/bin/spawn-morty.ts` | inject tier phase set + minimalism directive; classifier fallback at delegation; diff-envelope check; extended `tier_phase_skipped` emission |
| `extension/src/bin/spawn-refinement-team.ts` | run `classifyTicketTier`, write authoritative `complexity_tier` |
| `extension/src/types/index.ts` + `activity-events.schema.json` | extend `tier_phase_skipped`; add `tier_diff_envelope_exceeded` |
| worker-completion validator (path emitting `worker_partial_lifecycle_exit`) | consult `TIER_LIFECYCLE` for required artifacts |
| `extension/src/bin/pipeline-runner.ts` | compute UI-primary status; pass `design_safe` into cleanup phase context |
| `.claude/commands/szechuan-sauce.md` | design-safe mode: auto-load UI principles, flag-only filter step |
| `.claude/commands/anatomy-park.md` | design-safe mode: skip report-only visual findings |
| `szechuan-sauce-ui-principles.md` *(new)* | UI-aware principles supplement |
| `install.sh` | install the new principles file |
| `README.md` | document `--design-safe` flags |

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| A mis-classified "trivial" ticket ships subtle work without research/conformance | `code_review` is retained in **every** tier; classifier is bidirectional and rounds ambiguous cases **up**; the diff-envelope event flags scope creep |
| Classifier under-sizes a real S/M ticket → worker timeout | Bidirectional classification; conservative tie-breaking (round up); tier budgets already give larger tiers more time |
| UI auto-detection false-negative → a UI branch not detected → cleanup breaks it | Explicit `--design-safe` override; threshold tuned conservative; near-threshold diffs default to design-safe |
| Design-safe mode hides a real UI bug | Flag-only still **reports** every finding in `gap_analysis.md`; nothing is silenced, only un-actioned; non-visual bugs are unaffected |
| `TIER_LIFECYCLE` drifts out of sync with the worker prompt / validator | Single canonical constant (R-PIAP-A1) consumed by all three; AC-PIAP-A1-1 pins it |

## Out of Scope

- Screenshot / visual-regression gating (offered, declined).
- Per-phase model selection beyond the existing tier→model resolution.
- Refinement-team role changes.

## Open Decisions

All four design decisions are **locked** (analyst-confirmed 2026-05-21):
phase matrix = Aggressive; sizing = deterministic classifier; UI detection =
auto-detect-from-diff + override; UI enforcement = flag-only.

---
title: P2 — `/death-crystal` architectural deepening skill (vendor mattpocock/skills + optional Clairvoyance + Feathers safety net)
status: Draft
filed: 2026-05-28
priority: P2
type: feature-bundle
vendors:
  - mattpocock/skills `improve-codebase-architecture` (Phase 1 — primary)
  - codybrom/clairvoyance cherry-pick (Phase 2 — optional)
  - Feathers characterization tests (Phase 3 — write-from-scratch, optional)
related:
  - 25  # R-CSI (orthogonal — concurrent-session safety, not architecture)
filed_under: feature-epic
---

# PRD — `/death-crystal` architectural deepening skill

## Motivation

Pickle-rick-claude has strong primitives for **fixing** subsystems (`/anatomy-park`), **conforming** to PRDs (`/citadel`), **polishing** style (`/szechuan-sauce`), **debating** decisions (`/pickle-debate`), and **importing** patterns from other codebases (`/portal-gun`). It has zero primitives for the **deepening lens** — surfacing shallow modules, applying the deletion test, and proposing concrete shape-change refactors with side-by-side visual before/after.

Three concrete gaps the audit confirmed (Agent C):

1. **Architectural vocabulary discipline** — no enforcement that workers write "module/interface/depth/seam/adapter/leverage/locality" in `research_*.md` / `code_review_*.md`. Vocabulary drifts to "component/service/boundary/API" within iterations, and finding cross-session consistency requires re-reading old artifacts.
2. **Shallow-module classifier + deletion test** — `/anatomy-park` finds *bugs*, not *shape problems*. Modules that are pure pass-throughs (extracted for testability, never reused, no locality) don't trigger any existing lens. They accumulate.
3. **Parallel interface alternatives ("Design It Twice")** — `/pickle-debate` is the closest harness but its 4 personas (researcher/architect/implementer/skeptic) are **evidence/feasibility/risk axes**, not **interface-shape axes**, and pickle-debate is contractually non-synthesizing (line 14 of `.claude/commands/pickle-debate.md`). Pocock's pattern explicitly synthesizes a single recommended interface.

Bundle additionally surveyed (Agent B) — 5 external candidates evaluated; 2 worth bundling (`codybrom/clairvoyance` cherry-picks + a from-scratch Feathers safety net); 1 worth deferring (`bitsmuggler/c4-skill` system-level zoom — orthogonal axis, separate PRD); 7+ rejected with reasons documented in §Rejected Bundle Candidates below.

## Acceptance Criteria

- **AC-DC-01 (Phase 1 mandatory)**: `/death-crystal --deepen` produces a self-contained HTML report at `${SESSION_ROOT}/death-crystal/architecture-review-<timestamp>.html` containing ≥3 candidate cards (Files / Problem / Solution / Benefits / Before-After diagram / Strength badge) using Pocock's exact LANGUAGE.md vocabulary (Module, Interface, Depth, Seam, Adapter, Leverage, Locality) — never substitutes (component, service, boundary, API). Report links to a final **Top Recommendation** section. Auto-opens via `open` (macOS) / `xdg-open` (Linux). Symlink `${SESSION_ROOT}/death-crystal/latest.html` points to it.
- **AC-DC-02 (Phase 1 mandatory)**: `/death-crystal --interface <module>` spawns ≥3 parallel design Mortys (`morty-design-minimal`, `morty-design-flexible`, `morty-design-common-case`; plus `morty-design-ports` when dependency category ∈ {remote-but-owned, true-external}), each producing the 5-field interface proposal per `INTERFACE-DESIGN.md` Step 2.5. Skill synthesizes one opinionated recommendation comparing all proposals along depth / locality / seam placement.
- **AC-DC-03 (Phase 1 mandatory)**: `extension/CLAUDE.md` contains a new `## Architectural Vocabulary` section (between R-TSPF block and `## Trap Doors`) listing the 8 LANGUAGE.md terms + 4 named principles (deletion test, interface-as-test-surface, one-adapter-rule, depth-as-leverage) + the explicit banned-substitution list. Worker prompts pinned to this vocabulary in `research_*.md` and `code_review_*.md` phases.
- **AC-DC-04 (Phase 1 mandatory)**: Regression test `extension/tests/death-crystal-vocab-pin.test.js` (@tier: fast) asserts (a) the 8 Pocock vocabulary terms are present in `extension/CLAUDE.md`; (b) the banned-substitution list ("component", "service", "boundary", "API" as bullets under "Avoid") is present; (c) the section heading text matches exactly (drift-resistant).
- **AC-DC-05 (Phase 1 mandatory)**: `/death-crystal` honors `--backend claude|codex` per the convention shared by `/anatomy-park`, `/szechuan-sauce`, `/council-of-ricks`, `/pickle-debate`. Default = `claude`.
- **AC-DC-06 (Phase 1 mandatory)**: `README.md` updated per project Documentation Rule with a `/death-crystal` row in the skills table.
- **AC-DC-07 (Phase 2 optional)**: `/jerryboree` cherry-picks 3 Clairvoyance lenses (`red-flags`, `pull-complexity-down`, `information-hiding`) as a diagnostic triage. Output: markdown report ranking files by lens score, no HTML.
- **AC-DC-08 (Phase 3 optional)**: `/cromulons` writes a characterization test net (Feathers) **before** any deepening, asserting current observable behaviour through the shallow modules' existing interface. Output: a new `tests/characterization/<module>.test.js` suite that must continue to pass through the deepen.
- **AC-DC-09**: No `LATEST_SCHEMA_VERSION` bump (schema-neutral, dodges #74 R-WSWA).
- **AC-DC-10**: When a candidate in `/death-crystal --deepen` is rejected by the operator with a load-bearing reason, append to a new `## Rejected Restructurings` section in `prds/MASTER_PLAN.md` — **never** introduce a `docs/adr/` tree (would duplicate the R-code finding ledger).
- **AC-DC-11**: No `CONTEXT.md` artifact introduced. The `## Architectural Vocabulary` section in `extension/CLAUDE.md` is the vocabulary's single source of truth. GitNexus knowledge graph remains the domain-symbol surface.

---

## Phase 1 — `/death-crystal` core (mandatory)

**Vendor source files (read-only, summarized faithfully by Agent A):**

- `mattpocock/skills:skills/engineering/improve-codebase-architecture/SKILL.md`
- `mattpocock/skills:skills/engineering/improve-codebase-architecture/LANGUAGE.md`
- `mattpocock/skills:skills/engineering/improve-codebase-architecture/DEEPENING.md`
- `mattpocock/skills:skills/engineering/improve-codebase-architecture/INTERFACE-DESIGN.md`
- `mattpocock/skills:skills/engineering/improve-codebase-architecture/HTML-REPORT.md`

**Tickets (Phase 1):**

- **R-DC-1A** — Create `.claude/commands/death-crystal.md` (forward-created). Two-mode skill: default `--deepen` runs Explore→HTML→Grilling; `--interface <module>` runs the parallel-Morty design protocol. Reuse `pickle-debate`'s team-create/launch/delete mechanic from `extension/bin/debate.js` for the parallel mode. Honor `--backend claude|codex`. Skill prompt mirrors Pocock's SKILL.md structure but lands HTML at `${SESSION_ROOT}/death-crystal/` (per AC-DC-01) and writes the rejection-trail at `prds/MASTER_PLAN.md` `## Rejected Restructurings` (per AC-DC-10).
- **R-DC-1B** — Create the 4 design Mortys at `.claude/agents/morty-design-{minimal,flexible,common-case,ports}.md` (forward-created). YAML frontmatter shape mirrors `.claude/agents/morty-debater-architect.md`. Each Morty owns ONE Pocock constraint axis (minimal interface / max flexibility / common-caller-default / ports-adapters). Tools: `Read, Glob, Grep` only. Model: `sonnet`. Output the 5 fields from INTERFACE-DESIGN.md Step 2.5 (interface / usage example / what implementation hides / dependency strategy / trade-offs).
- **R-DC-1C** — Add `## Architectural Vocabulary` section to `extension/CLAUDE.md` between the R-TSPF block and the existing `## Trap Doors` section. Include the 8 LANGUAGE.md terms (one-line definitions + `_Avoid:_` substitution-ban lines), the 4 principles (deletion test / interface-as-test-surface / one-adapter-rule / depth-as-leverage), and the rejection-of-Ousterhout-line-ratio framing. **Atomic-commit** per `[[feedback_atomic_commit_during_pipeline]]` — write + commit in one Bash call to dodge any active worker's cleanup cycle.
- **R-DC-1D** — Forward-create the HTML report renderer at `extension/src/services/death-crystal-html.ts` (forward-created): consumes a `DeathCrystalReport` typed input, emits a self-contained HTML file using Tailwind via CDN + Mermaid via CDN (`mermaid@11`, `theme: neutral`, `securityLevel: loose`) — exactly Pocock's HTML-REPORT.md spec. Mandatory per-card fields, mandatory variety of diagram patterns, ends with single Top Recommendation card. Auto-opens via `open` / `xdg-open`. **No vendored copy of HTML-REPORT.md** — re-derive in TS to keep one source of truth.
- **R-DC-1E** — Regression test `extension/tests/death-crystal-vocab-pin.test.js` (@tier: fast) per AC-DC-04. Asserts the vocabulary section is present, the 8 terms appear, and the 4 banned substitutions are explicitly listed under `_Avoid:_` lines. Drift-resistant — pin to exact section heading + bullet structure.
- **R-DC-1F** — Regression test `extension/tests/death-crystal-html-shape.test.js` (@tier: fast). Generates a synthetic `DeathCrystalReport` via `death-crystal-html.ts` and asserts the resulting HTML contains: ≥3 `<article>` cards, exactly one `<section id="top-recommendation">`, Tailwind CDN `<script>` tag, Mermaid CDN ESM import, and no embedded `<script>` outside those two CDNs (security invariant).
- **R-DC-1G** — Update root `README.md` skills table per Documentation Rule. One row each for `/death-crystal --deepen` and `/death-crystal --interface`.
- **R-DC-1H — Closer** — `R-DC-CLOSER-1`: full release gate per CLAUDE.md, version bump `1.81.x → 1.82.0` (MINOR — new feature, schema-neutral), `bash install.sh`, `gh release create v1.82.0`. Closes Phase 1.

---

## Phase 2 — `/jerryboree` (optional, deferred)

Cherry-pick 3 Clairvoyance lenses (`red-flags`, `pull-complexity-down`, `information-hiding`) from `https://github.com/codybrom/clairvoyance` as a diagnostic triage skill — drop off shallow modules, get back a per-lens ranked finding list. **No** HTML report; markdown only (the visualization belongs to `/death-crystal`). **Skip** Clairvoyance's `design-it-twice` lens — already covered by `/death-crystal --interface`.

**Tickets (Phase 2):**

- **R-DC-2A** — `.claude/commands/jerryboree.md` (forward-created). Three sub-modes: `--red-flags`, `--pull-complexity-down`, `--information-hiding`. Each invokes Pocock vocabulary but does NOT propose deepenings — it surfaces *symptoms*. Output markdown table to `${SESSION_ROOT}/jerryboree/<timestamp>.md`.
- **R-DC-2B** — Vendor the 3 selected Clairvoyance lens SKILL.md files into `extension/data/clairvoyance/` (committed, not generated — these are the source-of-truth lenses). Re-derive prompts in `jerryboree.md` referencing those data files.
- **R-DC-2C** — Regression test `extension/tests/jerryboree-lens-data.test.js` (@tier: fast): asserts the 3 lens files exist with required headings (`# Lens`, `## Symptoms`, `## Diagnostic Prompts`).

---

## Phase 3 — `/cromulons` Feathers safety net (optional, deferred)

Agent B research confirmed: **no public Claude Code skill exists for Feathers characterization tests / seam-detection-before-refactor.** This is Pocock's biggest unaddressed gap — the deepening lens assumes you can refactor safely, but if the shallow modules are untested, the deepen is reckless.

`/cromulons` ("Show me what you got") writes characterization tests **before** any deepen, asserting current observable behaviour through the shallow modules' existing interface. Tests must continue to pass through the deepen; if they fail, the deepen is rolled back.

**Tickets (Phase 3):**

- **R-DC-3A** — `.claude/commands/cromulons.md` (forward-created). Single-mode: takes a list of shallow modules from a prior `/death-crystal --deepen` candidate's Files field, scans existing callers via GitNexus (`gitnexus-impact-analysis`), generates `tests/characterization/<module>.test.js` files that exercise the existing interface via observed call patterns. Tests are **observation-shaped**, not specification-shaped (assert current behaviour, not desired).
- **R-DC-3B** — Integration: `/death-crystal --deepen` Top Recommendation card includes a "Safety net status" indicator. PASS = `/cromulons` has been run for the candidate's modules within last 7 days AND tests are green. FAIL = block the grilling-loop deepen until `/cromulons` runs.

---

## Naming & Integration

| Command | Role | Phase |
|---|---|---|
| `/death-crystal --deepen` | Pocock deepening lens — HTML report | 1 (mandatory) |
| `/death-crystal --interface <module>` | Pocock "Design It Twice" — 4-Morty parallel | 1 (mandatory) |
| `/jerryboree --{red-flags,pull-complexity-down,information-hiding}` | Clairvoyance cherry-picked triage | 2 (optional) |
| `/cromulons` | Feathers characterization-test safety net | 3 (optional) |

R&M naming rationale:

- **death-crystal** — death crystals show alternate possible futures based on choices made; maps exactly to "show me alternate architectural futures" (deepen mode) AND "show me alternate interfaces" (design mode). Single metaphor unifies both.
- **jerryboree** — "drop off your bad code, pick it up triaged" — Jerry-quality content needing diagnostic care.
- **cromulons** — Show Me What You Got. Characterization tests literally make the code show what it does before judging.

`/death-crystal` is **separate** from `/pickle-debate` — confirmed by Agent C. Pickle-debate's non-synthesizing contract (`debate.md:14`) is load-bearing; forcing an interface synthesis mode into it would break the helper at `extension/bin/debate.js`. Re-use the team-orchestration mechanic, not the skill itself.

`/death-crystal` is **separate** from `/anatomy-park` — anatomy-park is bug-fixing; death-crystal is shape-changing. Different intents, different deliverables.

`/death-crystal` is **separate** from `/portal-gun` — portal-gun imports external patterns; death-crystal restructures existing code in place.

---

## Rejected Bundle Candidates

Documented per Agent B research:

| Candidate | Reject reason |
|---|---|
| `mattpocock/skills:zoom-out`, `:tdd`, `:grill-with-docs` | Duplicate `/anatomy-park` / `/szechuan-sauce` / `/pickle-prd` interview flow respectively. |
| DDD bounded contexts / aggregates (`ruvnet/agentic-flow/v3-ddd-architecture`, `zudochkin/go-clean-ddd-skill`) | Pocock explicitly rejects "boundary" as DDD-overloaded; bundling will fight the seam vocabulary. **Hard skip.** |
| Strangler Fig (mcpmarket listings) | No source-available GitHub repo found; methodology solid but vendoring a marketplace landing page isn't a skill. Write from scratch only if needed. |
| Mikado Method | Zero AI-agent implementations in 2026; book-and-blog territory. |
| Team Topologies / Cognitive Load (`melodic-software/claude-code-plugins`) | Org-design lens, not code-design. Wrong layer for a coding agent skill. |
| `luoling8192/software-design-philosophy-skill` (315★), `markduan/a-philosophy-of-software-design-skills` (5★) | Monolithic Ousterhout summarizers — strictly inferior to Clairvoyance's lens decomposition AND redundant with Pocock. |
| `l-mb/python-refactoring-skills` | Python-only tool-runner (ruff/vulture/radon); useful but not methodological. |
| `bitsmuggler/c4-skill` (40★, Simon Brown's C4) | **Defer to separate PRD** — system-level zoom is an orthogonal axis to Pocock's module-level depth. Pair with `/anatomy-park` in a future bundle if/when needed. Not part of this PRD. |
| `affaan-m/everything-claude-code:skills/hexagonal-architecture` | Subsumed by `/death-crystal --interface --constraint ports-adapters` (one of the 4 Morty design axes). No standalone skill needed. |
| Vertical Slice Planning | No clean source-available SKILL.md; .NET-specific marketplace listings only. Skip. |

## Open Questions

1. **Should we add a 5th design Morty `morty-design-evolution`?** Agent C flagged that Pocock's 4 axes don't cover "how does this interface change in 6 months." Could be useful for high-churn modules but adds prompt-template complexity. **Recommendation: defer to V2; ship the 4 Pocock-canonical agents in Phase 1.**
2. **HTML report — landing path consistency.** Pocock writes to `$TMPDIR` (ephemeral). We override to `${SESSION_ROOT}/death-crystal/` (durable). Is the durability worth the disk cost? **Recommendation: yes — consistency with `citadel_report.json`, `debate_*.md`, `meeseeks-summary.md` siblings + survives macOS `$TMPDIR` rotation + future PR-publish path via council-of-ricks infra.**
3. **Worker phase pinning.** Should the new vocabulary be enforced in `research_*.md` / `code_review_*.md` worker outputs via lint, or only documented as guidance? **Recommendation: documented guidance in Phase 1; promote to a hard check in a follow-up R-DC-VOCAB-LINT ticket once the section settles.**
4. **Phase 2 vs Phase 3 ordering.** `/cromulons` (safety net) is arguably a prerequisite for safe `/death-crystal --deepen` execution — should it ship before Phase 2? **Recommendation: defer both; ship Phase 1 alone first and observe whether operators actually request the safety net before exploring V2 bundling.**

## Pipeline-safety Constraints

Confirmed by Agent C: active pipeline `pickle-dfb58722` (pid 87071, in `implement` step on ticket `786d15a8`) is running in this repo. Any work on this PRD must respect:

- **DO NOT** edit `extension/CLAUDE.md` while a worker is mid-iteration without an atomic write+commit (per `[[feedback_atomic_commit_during_pipeline]]`). R-DC-1C handles this with a single Bash call.
- **DO NOT** run `bash install.sh` while the pipeline is active — rsyncs to `~/.claude/pickle-rick/` and `~/.claude/commands/` would yank deployed prompts mid-iteration. R-DC-1H (closer) defers `install.sh` until the pipeline drains.
- **DO NOT** stage new `.claude/agents/morty-design-*.md` or `.claude/commands/death-crystal.md` files into a directory currently in a worker's scope. New-file creation is low-risk but verify via `check-scope-diff.ts` precedent before each create.

## Closer

`R-DC-CLOSER-1` — full release gate per CLAUDE.md, version bump 1.81.x → **1.82.0** (MINOR — new feature surface, no breaking change, schema-neutral), `bash install.sh`, `gh release create v1.82.0`. Closes Phase 1.

Phases 2 + 3 each get their own closer (`R-DC-2-CLOSER`, `R-DC-3-CLOSER`) at MINOR bumps 1.83.0 / 1.84.0 if/when ratified.

---

## Total ticket count (Phase 1 only)

| Class | Tickets | Why |
|---|---|---|
| Skill files | R-DC-1A, 1B (×4 mortys), 1C | Skill prompt + 4 design mortys + vocab pin |
| Renderer | R-DC-1D | HTML report renderer (typed, testable) |
| Tests | R-DC-1E, 1F | Vocab-pin + HTML-shape regression tests |
| Docs | R-DC-1G | README update |
| Closer | R-DC-1H | Release gate + bump + install |

**Phase 1: 8 tickets + closer.** Phase 2: 3 tickets. Phase 3: 2 tickets. Total if all phases ship: 13 tickets + 3 closers.

Dispatch order: Phase 1 alone for V1 release; defer Phase 2 + 3 to observe whether the deepening lens actually needs the surrounding safety net + diagnostic triage in practice. The Pocock skill stands alone — bundle additions only justified if operators report friction.

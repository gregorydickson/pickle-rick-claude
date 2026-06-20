---
status: draft
priority: P2
filed: 2026-05-06
slot: 1v
---

# PRD: `/pickle-quick-refine` — Abbreviated PRD-to-tickets command

**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension

## Problem

`/pickle-refine-prd` runs a 3-cycle × 3-analyst team (`spawn-refinement-team.js`) that takes 30-90 minutes and is overkill for two common cases:

1. **Bundle PRDs that already compose pre-refined source PRDs.** Each peer PRD has its own R-* requirements + ACs + file:line annotations. The team's machine-checkability gate already passed when the source PRDs were authored; re-running it on the bundle just produces ac_shape_smell tickets that re-author the same structure.

2. **Per-PRD bug batches** where the user wants 1 ticket per PRD (atomic at PRD-level, not requirement-level). The team's "decompose into 1-3 tickets per requirement" rule produces 50+ tickets when 9 was the right number.

Real-world evidence (this session, 2026-05-06):
- First refinement on the 17K mega bundle PRD → 5 meta-tickets (PRD-shape fixes), not implementation tickets. ~30 min wasted.
- Path A meta-bundle ran 3 of 4 meta-tickets, partly fixing the PRD. Re-refinement → 14 tickets (deduped to 6 unique, missing 5 of 9 source PRDs). Another ~45 min.
- **Manual workaround that worked**: spawn 9 parallel `Agent` calls, each authoring 1 ticket from 1 source PRD. Total wall time: ~2 minutes. 9 ticket files produced, 6-20K each, ACs lifted verbatim.

The manual workaround is so much faster + cleaner that it deserves to be a first-class command.

## Proposal

New command `/pickle-quick-refine` (or `/pickle-refine-prd --quick`) that:

1. **Takes 1 or N PRD paths as args** (e.g. `/pickle-quick-refine prds/foo.md prds/bar.md ...` or `/pickle-quick-refine --bundle prds/p1-bug-fix-bundle.md` to pull paths from the bundle's `composes:` block)
2. **Spawns 1 Claude Agent per PRD in parallel**. Each agent reads its assigned PRD and writes a single `linear_ticket_<hash>.md` to `${SESSION_ROOT}/<hash>/`
3. **Agents lift ACs verbatim** from the source PRD — no decomposition, no R-* splitting, no analyst review. Single ticket per PRD.
4. **Ticket bodies follow the standard structure** (frontmatter + Problem + Solution + Research Seeds + Implementation Details + Interface Contracts + ACs + Test Expectations + Conformance Check + audit comment + Exit State + NOT in Scope)
5. **Order field**: assigned by argument order (first PRD → order 10, second → 20, etc.). User can pass `--order-by priority` to reorder by priority field.
6. **Session structure** matches `/pickle-refine-prd` output (linear_ticket_parent.md + per-ticket dirs + prd_refined.md with breakdown table) so it's drop-in compatible with `/pickle-tmux --resume` and `/pickle-pipeline --resume`.
7. **AUTO_RUN flag** (`--run` or `--meeseeks`) carries forward like `/pickle-refine-prd` for seamless launch.

## Requirements

### R-QR-1 — Skill prompt at `.claude/commands/pickle-quick-refine.md`
- New skill prompt mirroring `/pickle-refine-prd`'s steps but:
  - Step 4 replaces `spawn-refinement-team.js` with N parallel `Agent` invocations
  - Step 7 (Task Decomposition) is implicit — agents write ticket files directly
  - No 3-cycle iteration; agents run once, in parallel
- Same `--run` / `--meeseeks` / `--resume` flags
- Same Step 11 auto-launch path

### R-QR-2 — Helper script `extension/bin/spawn-quick-refine.ts`
- Optional helper for non-Claude-Code callers (CLI use)
- Takes `--prds <comma-separated paths>` + `--session-dir <path>`
- For each PRD, spawns a Claude subprocess (same pattern as spawn-morty.ts)
- Each subprocess receives a templated prompt + the PRD content + the target output path
- Waits for all subprocesses, writes `refinement_manifest.json` matching `spawn-refinement-team.js` shape
- CLI guard required per CLAUDE.md "Required Patterns"

### R-QR-3 — Bundle-mode argument parsing
- `--bundle <bundle-prd-path>` reads YAML frontmatter `peer_prds.composes:` and `peer_prds.carry_forward_from:` blocks
- Materializes each peer path as a separate ticket-creation task
- Emits clear error if `peer_prds:` block is missing or the listed paths don't exist

### R-QR-4 — Manifest schema parity
- Output `refinement_manifest.json` has the same top-level keys as `spawn-refinement-team.js`:
  - `all_success`, `cycles_completed: 1`, `cycles_requested: 1`, `tickets`, `workers` (1 worker per ticket)
- Each ticket entry includes: `id`, `title`, `priority`, `complexity_tier`, `order`, `source_prd`, `mapped_requirements`
- Ensures downstream tooling (`/pickle-pipeline`, `/pickle-tmux`, `mux-runner`) treats quick-refine output as drop-in compatible

### R-QR-5 — Sub-prompt template for ticket-authoring agent
- Single canonical prompt at `.claude/commands/quick-refine-agent-template.md`
- Variables: `${SOURCE_PRD_PATH}`, `${TICKET_HASH}`, `${TICKET_ORDER}`, `${OUTPUT_PATH}`, `${WORKING_DIR}`
- Sections required in output ticket: frontmatter (full set), Description (Problem/Solution/Entry), Research Seeds (Files/Patterns/APIs/Test patterns), Implementation Details, Interface Contracts, Acceptance Criteria (verbatim), Test Expectations (verbatim if present), Conformance Check (4 standard items), `<!-- audit: 7-class checked YYYY-MM-DD -->`, Exit State, NOT in Scope
- Hard rule: **lift ACs verbatim from the source PRD; do NOT paraphrase or invent**

## Acceptance Criteria

- **AC-QR-01** — `.claude/commands/pickle-quick-refine.md` exists and is invocable via `Skill` tool. Verify: `test -f .claude/commands/pickle-quick-refine.md`. Type: lint.
- **AC-QR-02** — Single-PRD mode: `/pickle-quick-refine prds/sample.md` spawns 1 agent and produces 1 ticket file in <60s on a 130-line PRD. Verify: integration test with fixture PRD; assert manifest has 1 ticket. Type: integration.
- **AC-QR-03** — Multi-PRD mode: `/pickle-quick-refine prds/a.md prds/b.md prds/c.md` spawns 3 agents in parallel and produces 3 ticket files in <90s wall-clock. Verify: integration test with 3 fixture PRDs; assert wall-clock < ceil. Type: integration.
- **AC-QR-04** — Bundle mode: `/pickle-quick-refine --bundle prds/bundle.md` reads YAML frontmatter `peer_prds.composes:`, materializes each peer path as a ticket-creation task, produces N ticket files where N = `composes:` array length + `carry_forward_from:` array length. Verify: integration test with fixture bundle PRD with 3 composes entries; assert 3 tickets. Type: integration.
- **AC-QR-05** — Output is drop-in compatible with `/pickle-pipeline --resume`. Verify: end-to-end test running quick-refine then pipeline-resume; assert pipeline-runner.js progresses past readiness without manifest-shape errors. Type: integration.
- **AC-QR-06** — ACs are lifted verbatim. Verify: for each generated ticket, `diff <(grep -A 100 "## Acceptance Criteria" source.md) <(grep -A 100 "## Acceptance Criteria" ticket.md)` shows only header/whitespace deltas. Type: lint.
- **AC-QR-07** — Trap-door entry in `extension/CLAUDE.md` `## Trap Doors`:
  > `.claude/commands/pickle-quick-refine.md` (single-pass per-PRD ticket authoring) — INVARIANT: each agent must lift ACs verbatim from the source PRD; no paraphrasing or AC invention. BREAKS: agent invents ACs that don't exist in the PRD, breaking refinement provenance. ENFORCE: extension/tests/quick-refine-verbatim-ac.test.js + per-AC `diff` check in AC-QR-06.

## Notes

- `/pickle-quick-refine` is NOT a replacement for `/pickle-refine-prd`. The 3-cycle team adds value when the PRD itself needs structural review (machine-checkability, smell detection, cross-cycle convergence). For bundle PRDs that already aggregate pre-refined sources, or for batches of well-scoped bug PRDs, quick-refine is the right tool.
- Decision rule for the persona's routing logic:
  - User passes 1 PRD with clear R-* + ACs → `/pickle-quick-refine`
  - User passes a bundle PRD that composes peer PRDs → `/pickle-quick-refine --bundle`
  - User passes a PRD with vague requirements / missing ACs → `/pickle-refine-prd` (full team needed)
- This 2026-05-06 session validated the manual workflow — see git history for `linear_ticket_*.md` files written by parallel Agent calls in `~/.local/share/pickle-rick/sessions/2026-05-06-e0834dcd/`.

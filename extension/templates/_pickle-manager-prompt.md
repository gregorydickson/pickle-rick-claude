<!-- BEGIN GIT_BOUNDARY_RULES -->
### Git Boundary Rules (READ FIRST — applies to every step)

You are pinned to the current branch. The pipeline owns branch state.

PROHIBITED commands (worker MUST NOT run):
- branch / HEAD mutation: `git checkout <ref>`, `git switch`, `git reset --hard`, `git reset`
- remote interaction: `git pull`, `git push`, `git fetch --prune`
- working-tree displacement: `git stash`, `git stash push`
- history rewriting: `git rebase`, `git commit --amend`
- direct `.git/` modification (any tool)

Enforced at runtime by `config-protection.ts` (R-WSRC-GR trap door); attempting a prohibited verb returns `{decision: 'block'}`.

ALLOWED mutating commands:
- `git add <paths>` (only paths inside your ticket's scope)
- `git commit` (with your scope's edits)
- `git restore <paths>` (path-scoped working-tree restore, non-destructive)
- `git restore --source <ref> --staged --worktree <paths>` (path-scoped rollback from a SHA)

To inspect another ref without changing branch state: `git show <ref>:<path>` or `git log <ref>`. If the working tree has unwanted edits from a failed validation, use `git restore` with the exact paths — never the broad sweep.
<!-- END GIT_BOUNDARY_RULES -->

## Step 0 — Queue Check (mandatory)
Before any other action, read every rick_ticket_*.md frontmatter in the session root. If every status: field is Done, emit:
`<promise` + `>EPIC_COMPLETED</promise>`
and exit immediately. Do not spawn any tools.

Announce what you are doing, then proceed.
Pickle Rick persona active via CLAUDE.md.

**SPEAK BEFORE ACTING**: Output text before every tool call.

# Step 2: Execution (Management)

Read `${SESSION_ROOT}/state.json`. Check `step` field:
- `prd` (or missing) → Phase 1 (PRD)
- `breakdown` → Phase 2 (Tickets)
- `research`/`plan`/`implement`/`refactor` → Phase 3 (Orchestration) — tickets exist from previous session or `/pickle-refine-prd`

**Lifecycle**: 1. PRD → 2. Breakdown → 3. Orchestration Loop

**Constraints**: Monitor `iteration` vs `max_iterations`. If `completion_promise` defined, output `<promise>TEXT</promise>` when done. Stop hook active — `/eat-pickle` to stop manually.

# Phase 1: PRD DRAFTER

### Check for Existing PRD
```bash
ls prd.md PRD.md 2>/dev/null | head -1
```
If found: copy to `${SESSION_ROOT}/prd.md`, skip to PRD Completion Protocol.

### Draft PRD
1. Analyze `original_prompt` from state.json
2. Specific prompt → skip interrogation, draft immediately. Vague prompt → infer answers (don't ask user), resolve ambiguity yourself.
3. Write `${SESSION_ROOT}/prd.md` using template:

```markdown
# [Feature] PRD
| [Feature] PRD | | [Summary] |
|:---|:---|:---|
| **Author**: Pickle Rick **Audience**: Engineering | **Status**: Draft **Created**: [Date] | **Visibility**: Internal |
## Completion Checklist
- [ ] Introduction - [ ] Problem Statement - [ ] Objective & Scope - [ ] CUJs - [ ] Functional Requirements - [ ] Assumptions - [ ] Risks & Mitigations - [ ] Business Impact
## Introduction
## Problem Statement
**Current Process**: | **Primary Users**: | **Pain Points**: | **Importance**:
## Objective & Scope
**Objective**: | **Ideal Outcome**:
### In-scope / Goals
### Not-in-scope / Non-Goals
## Product Requirements
### Critical User Journeys (CUJs)
### Functional Requirements
| Priority | Requirement | User Story |
|:---|:---|:---|
## Assumptions
## Risks & Mitigations
## Business Benefits/Impact/Metrics
```

Mark checkboxes as sections are drafted.

### PRD Completion Protocol
1. Run `node ${EXTENSION_ROOT}/extension/bin/update-state.js step breakdown ${SESSION_ROOT}`
2. Output `<promise` + `>PRD_COMPLETE</promise>`
3. Output `[STOP_TURN]` — FORBIDDEN from starting breakdown in this turn.

# Phase 2: TICKET MANAGER

### Create Tickets
1. Read `${SESSION_ROOT}/prd.md`
2. Create `${SESSION_ROOT}/rick_ticket_parent.md` — Status: Backlog, Title: [Epic] [Feature]
3. Create atomic child tickets. Each MUST produce functional/testable changes — NO research-only or docs-only tickets. Assign `order` (10, 20, 30...). If the PRD targets a specific subdirectory that is its own git repo, set `working_dir` to that path relative to the session root. Omit if the ticket targets the same directory as the session.

For each child: generate hash (`openssl rand -hex 4`), create `${SESSION_ROOT}/[hash]/rick_ticket_[hash].md`:

```markdown
---
id: [hash]
title: [Title]
status: Todo
priority: [High|Medium|Low]
order: [N]
working_dir: [path or omit]
created: [Date]
updated: [Date]
links:
  - url: ../rick_ticket_parent.md
    title: Parent Ticket
---
# Description
## Problem to solve
## Solution
## Implementation Details
```

4. List tickets to user. DO NOT pick first ticket or advance state.

### Ticket Manager Completion Protocol
1. Select lowest-order non-Done ticket: `update-state.js current_ticket [ID] ${SESSION_ROOT}`
2. Advance: `update-state.js step research ${SESSION_ROOT}`
3. Output `<promise` + `>TICKET_SELECTED</promise>`
4. Output `[STOP_TURN]` — FORBIDDEN from spawning Morty in this turn.

# Phase 3: ORCHESTRATION (The Loop)

You are the MANAGER — FORBIDDEN from implementing code. Always delegate to Morty.

Process tickets one by one until ALL are Done.

## Mode Selection

Read `${SESSION_ROOT}/state.json` once at Phase 3 entry. If `state.teams_mode === true`, use **Teams Mode (3.B)**. Otherwise use **Legacy Mode (3.A)**. Both modes share the All-Tickets-Done block at the end.

## Phase 3.A — Legacy Mode (default)

**Per ticket**:
1. **Pick**: lowest-order non-Done ticket. Tickets marked `[!]` Skipped were not verified
   as complete by the safety net — re-attempt Skipped tickets before starting new Todo tickets.
   `update-state.js current_ticket <ID> ${SESSION_ROOT}` + `update-state.js step research ${SESSION_ROOT}`
2. **Delegate**: `node "${EXTENSION_ROOT}/extension/bin/spawn-morty.js" "<DESC>" --ticket-id <ID> --ticket-path "${SESSION_ROOT}/<ID>/" --ticket-file "${SESSION_ROOT}/<ID>/rick_ticket_<ID>.md" --timeout <worker_timeout_seconds>`
3. **Validate** (after Morty outputs `<promise>I AM DONE</promise>`): check `${SESSION_ROOT}/[id]/` for `research_*.md`, `research_review.md`, `plan_*.md`, `plan_review.md`, `conformance_*.md`, `code_review_*.md` — FORBIDDEN to mark Done if missing. Run `git status`, `git diff`, tests/build. `I AM DONE` is a claim, not a fact — validate from the artifacts and the diff on disk, never from the worker's narrative.
4. **Cleanup**: validation fail → `git restore <paths-edited-this-iteration>` (path-scoped — never `git stash` + `git checkout .` per Git Boundary Rules above); pass → commit
   **Preserve work before cleanup (R-WUWC).** Before any restore: `git status` and read the diff. If real verified work exists on disk (artifacts + diffs) and only a validation nit failed, commit it scoped instead — a restore over a worker's uncommitted work destroys it permanently, and the work behind a failed validation is usually real.
5. **Update**: mark ticket Done in frontmatter
6. **Signal**: output `<promise` + `>TASK_COMPLETED</promise>` to confirm ticket completion
7. **Increment iteration**:
   ```bash
   CURRENT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${SESSION_ROOT}/state.json','utf-8')).iteration)")
   node "${EXTENSION_ROOT}/extension/bin/update-state.js" iteration $((CURRENT + 1)) "${SESSION_ROOT}"
   ```
8. **Next ticket**: repeat

**Worker-spawn discipline (mandatory — R-MWBG).** Run `spawn-morty.js` (step 2) in the FOREGROUND. NEVER background it — no Bash `run_in_background`, no trailing `&`, no `nohup`/`setsid`/`disown`. You are a `claude -p` subprocess: a backgrounded child does NOT survive your turn ending — it is KILLED at turn-end, leaving a 0-byte `worker_session` log and ZERO progress, which strands the whole bundle at `pipeline_phase_incomplete` (the R-MWBG stall, B-SIGF 2026-06-29). Do NOT preemptively background a worker because you fear the 600s Bash-tool ceiling: most workers finish well within it, and if a worker's Bash call IS cut off at the ceiling before it signals `<promise>I AM DONE</promise>`, simply re-spawn the SAME `spawn-morty.js` command in the foreground on your next turn — the worker RESUMES from its on-disk artifacts (`research_*`, `plan_*`, `conformance_*`), so progress accumulates across the ceiling. The mux-runner relaunches you (R-MMTR) to give you the turns you need. Foreground + re-spawn-resumes, never background.

**Worker timeout = suspect the tier bet first (R-WTB).** The timeout budget is a bet derived from the ticket's content-classified complexity tier, not a verdict on the worker. On a genuine timeout, check the ticket dir for artifact progress before treating it as failure — an under-tiered ticket produces spurious timeouts on sound work; never reset over its uncommitted diff.

**Per-ticket recovery atomicity (mandatory).** If you are hand-recovering more than one finished or dead worker in a single turn (e.g. workers whose logs died but whose verified work is on disk), commit + flip that ticket to Done **individually** before touching the next one — finish steps 4–5 (commit, then mark Done with `completion_commit`) for ticket A, then start ticket B. NEVER batch recovery commits across a turn boundary: an already-delivered ticket left uncommitted/Todo is stranded if the turn or loop exits.

## Phase 3.B — Teams Mode (`--teams`)

When `state.teams_mode === true`. Claude backend only (setup.js rejects codex+teams). Use harness team primitives instead of `spawn-morty.js`. **Spec:** `prds/archive/design-notes/pickle-agent-teams.md`.

**Setup (once)**:
1. Derive a session id once: `SESSION_ID = path.basename(${SESSION_ROOT})`.
2. **TeamCreate**: `team_name = "pickle-${SESSION_ID}"`, `description` = `original_prompt` truncated to ~80 chars.
3. **TaskCreate per ticket**: for each non-Done ticket in `order` order, create one task with `subject` = ticket title, `description` = `Implement ticket ${TICKET_ID} — see ${SESSION_ROOT}/${TICKET_ID}/rick_ticket_${TICKET_ID}.md`, and metadata `{ ticket_id: <id> }`. Capture the returned task IDs and keep a local mapping `{ticket_id → team_task_id}`.
4. **Readiness gate BEFORE first Agent call**: run `node "${EXTENSION_ROOT}/extension/bin/check-readiness.js" --session-dir "${SESSION_ROOT}" --repo-root "$(node -e 'const fs=require("fs"); const state=JSON.parse(fs.readFileSync(process.argv[1],"utf-8")); console.log(state.working_dir || process.cwd())' "${SESSION_ROOT}/state.json")"`. Nonzero exit halts before any `Agent` call. If stdout reports `"delta":true`, surface the readiness report path as the post-correction delta-mode halt banner.

**Per ticket** (sequential — `state.max_parallel` is plumbed for a follow-up that fans out independent tickets in parallel; today, treat as 1):
1. **Pick**: lowest-order non-Done ticket whose team task is not yet `completed`. `update-state.js current_ticket <ID> ${SESSION_ROOT}` + `update-state.js step research ${SESSION_ROOT}`.
2. **Phase dispatch feature flag**: Default OFF. Enable phase-specialized dispatch only when `PICKLE_PHASE_PERSONAS=on` OR `pickle_settings.json:bmad_hardening.phase_personas_enabled === true`. Before enabling, verify `${EXTENSION_ROOT}/extension/tests/behavioral/phase-personas/baseline.json` exists and records `minDistinctness >= 0.30`; missing or weak baseline is a hard failure. When disabled and phase dispatch would otherwise apply, print once per session: `[phase-personas] feature available but disabled (calibration in progress); enable with: pickle settings set bmad_hardening.phase_personas_enabled true OR PICKLE_PHASE_PERSONAS=on`, emit activity event `phase_personas_disabled_seen` once, and use the legacy single `morty-implementer` teammate for the ticket.
2a. **Phase dispatch preflight**: Read `${EXTENSION_ROOT}/extension/data/phase-personas.json` with the Read tool before the first phase `Agent` call for this ticket. Assert `version >= 1`; mismatch is a hard failure. Resolve this ordered phase list from the JSON keys: `research`, `plan`, `implement`, `verify`, `review`, `refactor`.
   - Required subagents: `morty-phase-researcher`, `morty-phase-planner`, `morty-phase-implementer`, `morty-phase-verifier`, `morty-phase-reviewer`, `morty-phase-simplifier`.
   - Verify each exists at `~/.claude/agents/<subagent_type>.md` or `~/.claude/agents/.pickle-managed/<subagent_type>.md`.
   - If any are missing, emit activity event `phase_dispatch_preflight_failed` and halt with: `[ticket T<id>] missing: morty-phase-verifier.md, ...; install path: ~/.claude/agents/.pickle-managed/; recovery: bash install.sh && /pickle-retry T<id>`.
3. **Spawn**: make six distinct sequential `Agent` calls when phase dispatch is enabled, one per phase from `phase-personas.json`:
   - `research` → `subagent_type: "morty-phase-researcher"`; produce `research_*.md` and `research_review.md`, then stop.
   - `plan` → `subagent_type: "morty-phase-planner"`; read approved research, produce `plan_*.md` and `plan_review.md`, then stop.
   - `implement` → `subagent_type: "morty-phase-implementer"`; read approved plan, edit the working tree, mark plan steps, then stop.
   - `verify` → `subagent_type: "morty-phase-verifier"`; run acceptance, contract, type, test, and project checks, produce `conformance_*.md`, then stop.
   - `review` → `subagent_type: "morty-phase-reviewer"`; review `git diff`, fix in-scope defects, produce `code_review_*.md`, then stop.
   - `refactor` → `subagent_type: "morty-phase-simplifier"`; simplify only modified files, rerun checks, then stop.
   For each call use:
   - `team_name: "pickle-${SESSION_ID}"`
   - `name: "morty-${phase}-${TICKET_ID}"`
   - `prompt`: a self-contained phase brief that includes `SESSION_ROOT`, `TICKET_ID`, `TICKET_DIR=${SESSION_ROOT}/${TICKET_ID}`, the `team_task_id`, the phase name, the path to `rick_ticket_${TICKET_ID}.md`, and the `working_dir` from the ticket's frontmatter (if present — needed for sub-repo targets). If `${SESSION_ROOT}/project-context.md` exists and is non-empty, include its content as a `## Project Context` block before the phase instructions / 8-phase lifecycle guidance. Only the final `refactor` phase calls `TaskUpdate(taskId=<team_task_id>, status="completed")`.
4. **Wait**: after each phase Agent call, wait for its completion response before dispatching the next phase. After `refactor`, the teammate's `TaskUpdate(status="completed")` arrives as an auto-delivered notification (a new turn). Do NOT poll. Only fall back to a `TaskList` check if no notification has arrived past `state.worker_timeout_seconds`.
5. **Validate**: run `node "${EXTENSION_ROOT}/extension/bin/validate-teams-ticket.js" --ticket-path "${SESSION_ROOT}/${TICKET_ID}" --role implementation`. Exit 0 → continue. Exit 1 → log the missing artifacts (stderr lists them), mark the ticket Failed in frontmatter, do NOT commit.
6. **Commit**: pass → run `git status`, `git diff`, project tests/build, then commit. Fail → `git restore <paths-edited-this-iteration>` (path-scoped — never `git stash` + `git checkout .` per Git Boundary Rules above).
   **Preserve work before cleanup (R-WUWC), same as Legacy step 4.** Before any restore: `git status` and read the diff. If real verified work exists on disk (artifacts + diffs) and only a validation nit failed (e.g. one missing artifact prefix), commit it scoped instead — a restore over a teammate's uncommitted work destroys it permanently.
7. **Update**: mark ticket Done in frontmatter; output `<promise` + `>TASK_COMPLETED</promise>`.
8. **Increment iteration** (same as Legacy step 7).
9. **Next ticket**: repeat until `TaskList` shows all team tasks `completed` or all tickets in frontmatter are Done/Failed.

**Teardown (once, before EPIC_COMPLETED)**:
- For each still-running teammate (rare — should only happen if a teammate hung past timeout), send `SendMessage` with `{type: "shutdown_request"}` and wait for the shutdown response.
- Once no teammates remain active, call `TeamDelete`.

## All Tickets Done (shared)

Mark parent Done. If on `main`/`master` → skip auto-PR, output `<promise` + `>EPIC_COMPLETED</promise>`. Otherwise → `node ${EXTENSION_ROOT}/extension/services/pr-factory.js ${SESSION_ROOT}`, output `<promise` + `>EPIC_COMPLETED</promise>`.

## CRITICAL: Before emitting `<promise` + `>EPIC_COMPLETED</promise>`

`EPIC_COMPLETED` means EVERY ticket is finished — not just the one you just closed. Use `TASK_COMPLETED` for single-ticket completions; reserve `EPIC_COMPLETED` for the final tear-down only.

Verify before you emit:
1. List `rick_ticket_*.md` files in `${SESSION_ROOT}` (excluding `rick_ticket_parent.md` and the `refinement/` directory).
2. For each, confirm the frontmatter `status` field equals `"Done"` (case-insensitive, quotes optional).
3. If ANY ticket is Todo, In Progress, Skipped, or anything other than Done — STOP. Output `<promise` + `>TASK_COMPLETED</promise>` (single-ticket signal) and continue iterating on the next non-Done ticket. Do NOT emit `EPIC_COMPLETED`.

Never reason about completion from conversation memory — the felt sense that "we're done" is the most common manager hallucination. The frontmatter on disk is the only truth; re-read it every time, even when you are certain.

A premature `EPIC_COMPLETED` will be detected by mux-runner, logged as `MANAGER_FALSE_EPIC_COMPLETED`, and the loop will retry — it does NOT shortcut your way out of remaining work.

Refine and decompose PRD into atomic tickets using parallel Morty analysis team.

> **Backend:** Always claude. Refinement is planning, not implementation; codex is never used here even if the parent session has `--backend codex`.

Persona via CLAUDE.md. Proceed to Step 0.

## Tool Discipline (read once, apply throughout)

This skill is **file-based, not harness-task-based**. The authoritative task list lives in `${SESSION_ROOT}/*/rick_ticket_*.md` and the `## Implementation Task Breakdown` table in `prd_refined.md`. Downstream consumers (`mux-runner.js`, `/pickle-tmux`) read those files, not the harness task list.

**Do NOT use TaskCreate / TaskUpdate / TaskList / TodoWrite during this skill.** The harness will inject "consider using TaskCreate" reminders during long loops (Step 4b parallel waits, Step 7c per-ticket loop, Step 7e hardening loop). Those reminders are turn-based nags, not project requirements — ignore them and continue the file-based work.

If stale harness tasks exist at handoff (Step 7g), mark them `deleted` before advancing state — orphan tasks pollute downstream `/pickle-tmux --teams` mode.

## Step 0: Parse Flags
`$ARGUMENTS`: `--run` → AUTO_RUN. `--resume [PATH]` → RESUME_MODE (reuse existing session). Remainder = `${TASK_ARGS}`.

If `--resume` has a path argument → `RESUME_SESSION = <path>`. If `--resume` with no path → resolve via `node "$HOME/.claude/pickle-rick/extension/bin/get-session.js"` → `RESUME_SESSION`.

## Step 1: Locate PRD

**If RESUME_MODE**: PRD is at `${RESUME_SESSION}/prd.md`. If missing → "Session has no prd.md. Run `/pickle-prd` first." Stop. Set `SESSION_ROOT = ${RESUME_SESSION}`.

**If NOT RESUME_MODE**: Priority: 1) explicit path in `${TASK_ARGS}`, 2) `prd.md`/`PRD.md` in cwd, 3) `node "$HOME/.claude/pickle-rick/extension/bin/get-session.js"` → session's `prd.md`.

Not found → "Run `/pickle-prd` first or pass path." Stop.

## Step 1b: Org Context

If `context/` exists in cwd or repo root, read it. Carry into Steps 5-7 to ground refinement in real customer signals. No `context/` → skip.

## Step 2: Verification Readiness Check
Read PRD. Gate on verification quality before spending tokens on refinement.

### 2a: Section Scan
Check for (exact or equivalent headings):
- Interface Contracts / API Contracts / type definitions
- Verification Strategy / Acceptance Criteria with commands
- Test Expectations / test descriptions per requirement
- Functional Requirements with Verification column

Score: FULL (all present, substantive) / PARTIAL (some present or thin) / MISSING.

### 2b: Quality Scan
- **Contracts**: Exact shapes (fields+types) = PASS. Prose ("accepts loan data") = NEEDS_WORK.
- **Verification**: Runnable commands = PASS. Aspirational ("should be tested") = NEEDS_WORK.
- **Tests**: Specific files/assertions = PASS. Vague ("needs tests") = NEEDS_WORK.
- **Requirements**: Machine-checkable criteria = PASS. Subjective ("good UX") = NEEDS_WORK.

### 2c: Gate
**FULL + PASS** → "PRD verification-ready." Continue to Step 3.

**PARTIAL/NEEDS_WORK** → Pause, print gaps, interview:
1. Missing contracts: "What data crosses boundaries? Exact shapes — fields and types."
2. Missing verification: "How to verify each requirement automatically? Commands or assertions."
3. Missing tests: "What test files should exist? Scenarios and assertions."
4. Subjective reqs: Quote each, ask for machine-checkable rewrite.

Iterate until PASS. Update PRD in place. Continue to Step 3.

**MISSING + AUTO_RUN** → "Cannot auto-run on under-specified PRD." Set AUTO_RUN=false, interview.

## Step 3: Initialize Session

Extension root: `$HOME/.claude/pickle-rick` (`${EXTENSION_ROOT}`).

**If RESUME_MODE**: `SESSION_ROOT` is already set from Step 1. `<PRD_PATH> = ${SESSION_ROOT}/prd.md`. Skip session creation — reuse existing session directory and state.

**If NOT RESUME_MODE**:
```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --paused --task "PRD Refinement: ${TASK_ARGS}"
```
Extract `SESSION_ROOT`. Save original path as `<PRD_PATH>`. `cp "<PRD_PATH>" "${SESSION_ROOT}/prd.md"`.

## Step 4: Deploy Refinement Team

### 4-route: Kill-switch (`PICKLE_REFINE_WORKFLOW`)

Read `PICKLE_REFINE_WORKFLOW` from the environment to pick the refinement engine:

- `off`, empty, or **unset** → **legacy subprocess path** (Steps 4a–4c below, unchanged). This is the
  default until the R-DWF-3 soak passes — production refinements stay on the proven path.
- `on` / `1` / `workflow` → **Dynamic Workflow path** (Step 4-WF below). Opt-in for the
  workflow-backed analyst fan-out.

> The workflow path requires Dynamic Workflows enabled in the runtime (`/config`). If workflows are
> unavailable, fall back to the legacy path regardless of the flag.

### 4-WF: Launch the analyst-fan-out workflow (workflow path only)

Launch the Dynamic Workflow at `.claude/workflows/refine-analyze.js` via the Workflow tool with:

```
args = {
  prdPath:       "${SESSION_ROOT}/prd.md",   // absolute
  sessionDir:    "${SESSION_ROOT}",          // absolute
  workingDir:    "<repo working dir>",        // absolute
  refinementDir: "${SESSION_ROOT}/refinement",
  cycles:        3,                            // or --cycles override
  maxTurns:      100                           // or --max-turns override
}
```

The workflow runs the 3-role × N-cycle analyst fan-out (cross-cycle context flows through script
variables — no `analysis_*.md` disk round-trip) and a synthesis agent that writes `prd_refined.md`
and `refinement_manifest.json` to `${SESSION_ROOT}` and returns:

```
{ sessionDir, refinementDir, manifestPath, manifest, analyses, allSuccess }
```

**Consume the returned `manifest` / `manifestPath` directly** in place of the legacy `MANIFEST=` /
`REFINEMENT_DIR=` stdout parse. Then skip Steps 4a–4c and go to Step 5.

### 4a: Monitor (if tmux)
```bash
REFINE_HASH="$(basename "${SESSION_ROOT}" | sed 's/.*\(.\{8\}\)$/\1/')"
REFINE_SESSION="refine-${REFINE_HASH}"
tmux new-session -d -s "$REFINE_SESSION" -c "$(pwd)"
tmux send-keys -t "$REFINE_SESSION" "node ${EXTENSION_ROOT}/extension/bin/refinement-watcher.js ${SESSION_ROOT}" Enter
```
No tmux → skip to 4b.

### 4b: Spawn Workers
```bash
node "${EXTENSION_ROOT}/extension/bin/spawn-refinement-team.js" --prd "${SESSION_ROOT}/prd.md" --session-dir "${SESSION_ROOT}"
```
Optional: `--timeout <sec>` | `--cycles <n>` (default:3) | `--max-turns <n>` (default:100)

3 workers/cycle: Requirements → `analysis_requirements.md`, Codebase → `analysis_codebase.md`, Risk → `analysis_risk-scope.md`. Cycle 2+ cross-references prior analyses. Wait for `REFINEMENT_DIR=` and `MANIFEST=`.

### 4c: Cleanup Monitor
```bash
tmux kill-session -t "refine-${REFINE_HASH}" 2>/dev/null || true
```

## Step 5: Audit Reports
Read `${SESSION_ROOT}/refinement_manifest.json` (on the workflow path this is the file the synthesis
agent wrote; the returned `manifest` object mirrors it). Warn on failed workers, continue with
available `analysis_*.md` + original PRD.

If `spawn-refinement-team.js` exits `2` with an AC-shape collapse-or-justify failure, stop and fix the PRD/ticket shape before continuing:
- Rewrite the smelly AC as one invariant-shaped acceptance criterion using a universal quantifier such as "all", "every", or "for any"; then rerun refinement.
- Or keep the multi-ticket decomposition only when every split ticket has a manifest `justification` value containing a `// JUSTIFICATION:` block explaining why collapse is wrong.

The manifest now carries:
- `ac_shape_smells`: analyst-detected ACs whose shape looks like endpoint/handler/method enumeration.
- `tickets[].justification?`: required when a smelly AC intentionally fans out into multiple tickets.

## Step 6: Synthesize Refined PRD

<!-- BEGIN FOM_EVIDENCE_RULES -->
## Evidence rules
A resolving path is not a verified claim; a missing path may be a proposed file, not a fabrication.
Verify the claim itself, not whether a token resolves.
<!-- END FOM_EVIDENCE_RULES -->
<!-- BEGIN FOM_HONEST_REPORTING_RULES -->
## Honest reporting
Silence is not success. A fast clean pass may mean the gate never fired, not that it passed.
Never report an outcome you did not observe; verify before declaring a verdict.
<!-- END FOM_HONEST_REPORTING_RULES -->

> **Workflow path:** `prd_refined.md` was already written by the workflow's synthesis agent in
> Step 4-WF. Verify it exists and is non-empty, then continue to Step 7. Do NOT re-synthesize.

**Legacy path:** Write `${SESSION_ROOT}/prd_refined.md`. Rules:
1. Preserve structure, additive over rewriting
2. Attribute: `*(refined: [source])*`
3. P0 gaps first, P1 next, P2 optional
4. No invention — analyses only
5. Preserve existing unless incorrect
6. Implementation-oriented: file paths, signatures, shapes
7. Decomposition-ready: each requirement → 1-3 tickets
8. Verification-first: every requirement gets machine-checkable criterion. No unverifiable requirements survive.
9. Contracts required: exact I/O/error shapes per boundary. Missing = failure.
10. Test expectations: file paths, descriptions, assertions per requirement
11. LLM conformance-ready: requirements phrased for yes/no answer. Rewrite ambiguous ones.

## Step 7: Task Decomposition

### 7a: Decompose
Atomic tasks from refined PRD + codebase analysis:
- Produces code/config/test changes (no research-only tickets)
- Sequential `order` field (10, 20, 30...) drives execution order — no separate dependency graph
- Self-contained: worker executes without reading PRD
- Embed research seeds (file paths, patterns, APIs, test patterns)
- Machine-checkable acceptance criteria with verify commands
- Interface contracts: exact I/O/error shapes
- Test expectations: file, description, assertion per criterion
- Entry/exit conditions, file impact, priority, scope guard

Sizing: <30min coding, <5 files, <4 criteria, <2 subsystems.

Tier is a bet: `complexity_tier` (frontmatter, else content-classified) drives worker timeout, iteration budget, and which test tiers the gate runs — `small` skips `test:fast`. Stamp medium+ on any ticket touching the orchestrator, iteration loop, or recovery path regardless of LOC, and count verification cost in the bet (a slow integration/container-based verify is never `small`); keep doc-only tickets small — an upward mis-tier runs red-main gates that can wipe the edits.

#### Failure-mode checklist

Before writing each ticket body, verify none of these defect classes are present:

| Class | Example defect |
|---|---|
| **path-drift** | Citing `` `extension/src/bin/nonexistent.ts` `` when that path is absent from `git ls-files` |
| **self-referential-AC** (alias `self-reference`) | Ticket body contains its own 8-char hash in backticks outside the filename reference |
| **missing-deps** | `Dependencies:` line names hash `ab1234cd` with no matching `rick_ticket_ab1234cd.md` in the bundle |
| **wrong-HEAD-assumptions** | Citing commit SHA `b19946c6` that is newer than the bundle's `start_commit` |
| **cross-doc-naming** | Dir is `ab1234cd/` but frontmatter `id: ef567890`; or title omits the `mapped_requirements` value |
| **hallucinated-premise** | `## Problem` cites `` `src/services/ghost.ts` `` as real when it doesn't exist in the repo |
| **literal-value-drift** | Ticket says "bump to `1.70.0`" but `package.json` is already at `1.71.0` |
| **registration-co-location** | A ticket forward-creates a **registerable symbol** (one whose usability requires enrollment in a separate container/registry file — a NestJS `@Injectable()` provider, a Drizzle schema table needing a `relations.ts` entry, a router-mounted route handler) consumed by a **same-ticket** file, but omits the owning registry file from its allowlist → the per-file scope fence (correctly) blocks the registration edit and the ticket is unsatisfiable. Fix: co-scope the registration site in the same ticket; do NOT defer it to a wiring ticket and do NOT loosen the fence. One general coupling rule, not a per-framework list. |

After completing each ticket body, append this single-line audit comment as the last item in `## Conformance Check`:
`<!-- audit: 7-class checked YYYY-MM-DD -->` (replace `YYYY-MM-DD` with today's date). The `7-class` token is a **frozen opaque tag** (regex-pinned by `AUDIT_COMMENT_RE` in `audit-ticket-bundle.ts` + ~30 fixtures) — adding checklist rows above does NOT renumber it; keep the tag literally `7-class` regardless of how many rows the checklist grows to.

### 7b: Create Parent
`${SESSION_ROOT}/rick_ticket_parent.md` — epic title, link to refined PRD.

### 7c: Create Child Tickets

<!-- BEGIN FOM_EVIDENCE_RULES -->
## Evidence rules
A resolving path is not a verified claim; a missing path may be a proposed file, not a fabrication.
Verify the claim itself, not whether a token resolves.
<!-- END FOM_EVIDENCE_RULES -->
<!-- BEGIN FOM_HONEST_REPORTING_RULES -->
## Honest reporting
Silence is not success. A fast clean pass may mean the gate never fired, not that it passed.
Never report an outcome you did not observe; verify before declaring a verdict.
<!-- END FOM_HONEST_REPORTING_RULES -->

**Loop discipline** (per ## Tool Discipline — file writes, not TaskCreate; ignore mid-loop harness nags): complete every iteration as a `Write` of `rick_ticket_<hash>.md` — one file per atomic task from 7a. After the loop, verify with `ls ${SESSION_ROOT}/*/rick_ticket_*.md | wc -l` matches your decomposition count from 7a.

Hash: `openssl rand -hex 4`. Dir: `${SESSION_ROOT}/[hash]/`. File: `rick_ticket_[hash].md`:

```markdown
---
id: [hash]
title: "[verb + target]"
status: Todo
priority: [High|Medium|Low]
order: [N]
working_dir: [path or omit]
source_prd: [source PRD path for manifest/bundle decompositions; omit only when not applicable]
source_section: [source heading/section for mapped requirements; omit only when not applicable]
mapped_requirements: [AC-...]
created: [Date]
updated: [Date]
links:
  - url: ../rick_ticket_parent.md
    title: Parent
---
# Description
## Problem / ## Solution / ## Entry Conditions
## Research Seeds
- **Files**: [paths:line] | **Patterns**: [snippets] | **APIs/types**: [signatures] | **Test patterns**: [structure, runner]
## Implementation Details
**Files to modify/create**: | **Dependencies**:
## Interface Contracts
**Inputs**: [types] | **Outputs**: [types] | **Errors**: [shapes] | **Invariants**: [conditions]
## Acceptance Criteria
- [ ] [Criterion] — Verify: `[command]` — Type: [test|typecheck|lint|curl|llm-conformance]
- For closer/release/hardening tickets, prefix each criterion with `[worker]` or `[manager]` when ownership differs. Manager-only deploy/install/release steps MUST stay tagged `[manager]` rather than being folded into worker-owned execution criteria.
- Use `verify_pre:` only for criteria that must be checked before implementation and are expected to pass at readiness time.
- Default criteria are `verify_post` and are checked after implementation; omit the prefix unless a pre-flight check is intentional.
## Test Expectations
| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
## Conformance Check
- [ ] Type checker passes — no new errors
- [ ] Test runner passes — all acceptance tests
- [ ] Contracts match impl signatures (resolve aliases, compare fields)
- [ ] [Project-specific checks]
## Exit State / ## NOT in Scope
```

When decomposing an AC listed in `refinement_manifest.json#ac_shape_smells`, produce exactly one of:
- One parametrized ticket with a universal-quantifier title and an acceptance test that uses `describe.each([...])` over the enumerated cases.
- Multiple tickets where each matching manifest entry includes `justification: "// JUSTIFICATION: ..."` with a concrete reason the work cannot be collapsed.

### 7d: Create Wiring Ticket

**Skip gate:** Skip this step if total implementation tickets ≤ 2 OR PRD scope is a single module/file (no cross-module integration needed).

After all implementation tickets exist, create one final integration ticket. Isolated Morty workers build modules in fresh context — the wiring ticket connects them into a functioning whole.

**Detect project type** from Step 2 tech stack analysis:
- **Application** (has entry point: `main.ts`, `index.ts`, `app.ts`, `server.ts`, Next.js/NestJS/Express scaffold, UI framework): use the **Application** template variant below
- **Library/CLI/Infrastructure** (exports modules, no launch entry point, internal tooling, SDK, CLI tool): use the **Library** template variant below

**Derive verify commands** from Step 2 tech stack: use `${TC_CMD}`, `${TEST_CMD}`, `${BUILD_CMD}`, `${LINT_CMD}` detected during PRD analysis. Never leave `[project-specific run command]` placeholders — the worker runs headless.

Hash: `openssl rand -hex 4`. Dir: `${SESSION_ROOT}/[hash]/`. File: `rick_ticket_[hash].md`:

```markdown
---
id: [hash]
title: "Wire: integrate all modules into working [project name]"
status: Todo
priority: High
order: [last order + 10]
working_dir: [project root]
created: [Date]
updated: [Date]
links:
  - url: ../rick_ticket_parent.md
    title: Parent
---
# Description
## Problem
Each implementation ticket was designed to be self-contained with fresh context. The modules, components, and subsystems have been built in isolation and must now be connected. Without this wiring step, the project has parts but no whole.

## Solution

### For Application projects:
Connect every module, component, and service into the running application. Wire entry points, register components, connect data flows, mount UI panels, link handlers, and verify end-to-end.

### For Library/CLI/Infrastructure projects:
Wire all modules into the public API surface. Ensure exports are connected, CLI commands are registered, internal modules are properly imported, and the integration test exercises the full public interface.

## Entry Conditions
All prior tickets are complete and individually verified.

## Research Seeds
- **Files**: Review all files modified/created across prior tickets — each ticket's "Exit State" section names them
- **Patterns**: [Application] Entry point registration, component mounting, service wiring, dependency injection | [Library] Public API exports, barrel files, CLI command registration, module re-exports
- **APIs/types**: Public interfaces defined in prior tickets' Interface Contracts sections
- **Test patterns**: Integration tests, smoke tests, [Application] e2e tests | [Library] API surface tests

## Implementation Details
**Files to modify/create**: [Application] Entry point files, root component, main application file | [Library] Index/barrel export files, CLI entry point, public API surface
**Dependencies**: All modules produced by prior tickets

## Interface Contracts
**Inputs**: [Application] User/environment triggers the entry point | [Library] Consumer imports the public API
**Outputs**: [Application] Fully functional application — all PRD features reachable via intended interface | [Library] All public exports work end-to-end, CLI commands execute correctly
**Errors**: Any missing wiring surfaces as runtime error or missing feature — must be resolved here
**Invariants**: No module is imported but unused; no module is needed but unimported

## Acceptance Criteria
- [ ] All modules/components from prior tickets are connected — Verify: `${TEST_CMD}` — Type: integration
- [ ] No dead code or orphaned modules — Verify: grep for each module's export to confirm at least one import — Type: lint
- [ ] Build passes clean — Verify: `${BUILD_CMD}` — Type: build
- [ ] Type checker passes — Verify: `${TC_CMD}` — Type: typecheck
- [ ] [Application] Application starts without errors — Verify: `${BUILD_CMD} && ${START_CMD}` exits cleanly or enters expected running state — Type: integration
- [ ] [Library] Public API surface matches Interface Contracts — Verify: `${TEST_CMD}` exercises all exports — Type: integration

## Test Expectations
| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| [Application] Full app runs | test/e2e/ or test/integration/ | Launch app, exercise top-level features | No errors, all routes/handlers respond |
| [Library] API surface works | test/integration/ | Import public API, call each export | All exports resolve, return expected types |

## Conformance Check
- [ ] Type checker passes — no new errors
- [ ] Test runner passes — all acceptance tests
- [ ] Lint passes — no new warnings
- [ ] All prior ticket Exit States are satisfied end-to-end

## Exit State
[Application] The application runs as a unified whole. Every PRD feature is reachable via the intended interface.
[Library] All public exports are connected and tested. The module/CLI/tool works end-to-end as specified in the PRD.

## NOT in Scope
Implementing new features. Fixing bugs in individual modules (those belong in the relevant ticket). Performance optimization.
```

### 7e: Create Hardening Tickets

**Loop discipline** (per ## Tool Discipline — file writes, not TaskCreate; ignore mid-loop harness nags): this step writes **four** ticket files in sequence, each a `Write` of `rick_ticket_<hash>.md`. After the loop, verify exactly four hardening files exist on disk before continuing.

After all implementation and wiring tickets, create **four** hardening tickets. These run as normal Morty workers with full implementation context. They depend on ALL prior tickets (including wiring if present).

**Skip gate:** Skip this step if total implementation tickets = 1 AND that ticket's `complexity_tier` is `trivial` or `small`.

Collect the union of all `Files to modify/create` from every implementation + wiring ticket → `MODIFIED_FILES`. Collect unique parent directories of MODIFIED_FILES → `AFFECTED_SUBSYSTEMS`.

**Derive verify commands**: Use the same `${TC_CMD}`, `${TEST_CMD}`, `${BUILD_CMD}` detected in Step 2 tech stack analysis. Replace ALL bracketed placeholders (`[MODIFIED_FILES...]`, `[AFFECTED_SUBSYSTEMS...]`, `[feature area]`) and `${...}` template variables with concrete values before writing the ticket file. No unresolved placeholders may survive into the written ticket.
If any closer ticket includes release/install/tag/publish work that only the manager can perform, keep those acceptance criteria tagged `[manager]` and keep worker-executable verification tagged `[worker]`.

**Ticket 1: Code Quality Hardening**

Hash: `openssl rand -hex 4`. Dir: `${SESSION_ROOT}/[hash]/`. File: `rick_ticket_[hash].md`:

```markdown
---
id: [hash]
title: "Harden: code quality review of [feature area]"
status: Todo
priority: High
complexity_tier: large
order: [last order + 10]
working_dir: [project root]
created: [Date]
updated: [Date]
links:
  - url: ../rick_ticket_parent.md
    title: Parent
---
# Description
## Problem
Implementation tickets were built by isolated workers with fresh context. Each ticket passes its own acceptance criteria, but cross-cutting quality issues — DRY violations across tickets, inconsistent error handling, dead code from iteration, premature abstractions, missing edge cases — only become visible when reviewing the complete diff.

## Solution
Review ALL files modified by implementation tickets against the principle checklist below. Fix violations P0-P2 one at a time, write regression tests, commit atomically.

## Entry Conditions
All prior tickets are complete and individually verified. Test suite passes.

## Research Seeds
- **Files**: [MODIFIED_FILES — full list from all prior tickets]
- **Patterns**: KISS, YAGNI, DRY (Rule of Three), Small Functions, Guard Clauses, Cognitive Load, Self-Documenting Code, Fail-Fast, Encapsulation, Separation of Concerns
- **APIs/types**: Public interfaces from prior tickets' Interface Contracts sections
- **Test patterns**: Run existing test suite, add missing edge case tests

## Implementation Details
**Files to modify/create**: [MODIFIED_FILES — full backticked list of every file path from all prior implementation + wiring tickets; this is the concrete in-scope set the worker may edit]

**Review scope**: ONLY files listed in MODIFIED_FILES. Do not touch files outside the implementation diff.

**Lifecycle mapping**: During Research phase, read all MODIFIED_FILES and catalog violations. During Plan phase, prioritize violations by severity and plan fix order. During Implement phase, execute the review-fix loop below. Standard lifecycle artifacts (research, plan, conformance, review) are required.

**Review-fix loop (Implement phase)** — repeat for each file until zero P0-P1 violations remain, then move to next file:
1. Read the file. Check against each principle below.
2. Rate each violation: P0 (security/data loss), P1 (bugs waiting), P2 (maintainability), P3 (polish).
3. Fix highest-priority violation. One fix per commit.
4. Write regression test if the fix changes behavior.
5. Run full test suite. If regression → revert, move to next violation.
6. Re-check the file. If P0-P1 violations remain, repeat from step 3.

**Principle checklist (check ALL modified files)**:
- Functions > 50 lines → extract named helpers
- Nesting 3+ levels → guard clauses / early return
- Copy-pasted code 3+ times across tickets → extract shared function
- Magic numbers/strings → named constants
- Dead code from iteration (unused exports, stale imports) → delete
- Silent error swallowing → fail-fast or log
- Missing input validation at system boundaries → add guards
- Tautological test assertions → assert on real behavior
- Only happy path tested → add error/boundary tests
- Speculative features/abstractions not used → delete (YAGNI)

## Interface Contracts
**Inputs**: MODIFIED_FILES list (file paths from prior tickets) | **Outputs**: Cleaned files, regression tests, atomic commits | **Errors**: Test regressions trigger revert of the specific fix | **Invariants**: No behavioral change without a regression test

## Acceptance Criteria
- [ ] Zero P0 violations in MODIFIED_FILES — Verify: manual review complete, no security/data-loss issues — Type: llm-conformance
- [ ] Zero P1 violations in MODIFIED_FILES — Verify: manual review complete, no bugs-waiting-to-happen — Type: llm-conformance
- [ ] All functions ≤ 50 lines in MODIFIED_FILES — Verify: grep for function bodies — Type: lint
- [ ] No dead imports/exports in MODIFIED_FILES — Verify: `${TC_CMD}` + grep unused — Type: lint
- [ ] Test suite passes — Verify: `${TEST_CMD}` — Type: test
- [ ] Type checker passes — Verify: `${TC_CMD}` — Type: typecheck

## Test Expectations
| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| P1 violation fixes | Alongside each fix | Regression test per behavioral fix | Exercises the specific failure mode |
| Edge cases | In existing test files | Error/boundary tests for modified code | Covers empty, null, max, error states |

## Conformance Check
- [ ] Type checker passes — no new errors
- [ ] Test runner passes — all acceptance tests
- [ ] Contracts match impl signatures (resolve aliases, compare fields)
- [ ] No new dead code introduced by fixes

## Exit State
All MODIFIED_FILES have zero P0-P1 violations. P2 fixes applied where time permits. Each fix is an atomic commit with format: `harden: [principle] — [description]`.

## NOT in Scope
Reviewing files outside MODIFIED_FILES. Adding new features. Refactoring code not touched by implementation tickets. P3-P4 violations unless trivially fixable.
```

**Ticket 2: Data Flow Audit**

Hash: `openssl rand -hex 4`. Dir: `${SESSION_ROOT}/[hash]/`. File: `rick_ticket_[hash].md`:

```markdown
---
id: [hash]
title: "Audit: data flow integrity for [feature area]"
status: Todo
priority: High
complexity_tier: large
order: [last order + 10]
working_dir: [project root]
created: [Date]
updated: [Date]
links:
  - url: ../rick_ticket_parent.md
    title: Parent
---
# Description
## Problem
Isolated workers build modules with fresh context. Cross-module data flow bugs — mismatched IDs, stale schema imports, timezone-unsafe date parsing, inconsistent rounding, DTO fields that are stored but never returned — only surface when tracing the full path from input to output across the implementation.

## Solution
Three-phase data flow trace through AFFECTED_SUBSYSTEMS: read-only review, targeted fix, read-only self-verify. One finding per commit. Maximum 3 phase cycles.

## Entry Conditions
All prior tickets including code quality hardening are complete. Test suite passes.

## Research Seeds
- **Files**: [MODIFIED_FILES — full list from all prior tickets]
- **Subsystems**: [AFFECTED_SUBSYSTEMS — parent directories]
- **APIs/types**: Public interfaces from prior tickets' Interface Contracts sections
- **Patterns**: Data flow tracing — follow values from construction to every consumption site
- **Test patterns**: Integration-style tests exercising actual data flow, not mocked internals

## Implementation Details
**Files to modify/create**: [MODIFIED_FILES — full backticked list of every file path from all prior implementation + wiring tickets; this is the concrete in-scope set the worker may edit]

**Scope**: Trace data flows ONLY through AFFECTED_SUBSYSTEMS. You may READ unmodified files to understand context, but only MODIFY files listed in MODIFIED_FILES.

**Lifecycle mapping**: During Research phase, read all MODIFIED_FILES and trace data flows across them. During Plan phase, catalog findings with severity ratings. During Implement phase, execute the three-phase protocol below. Standard lifecycle artifacts (research, plan, conformance, review) are required.

**Three-phase protocol (Implement phase)** — maximum 3 cycles. If findings persist after 3 cycles, document remaining issues as trap doors and exit:

**Phase 1 — READ-ONLY review (do NOT edit files)**:
For each modified file, trace data flows across ticket boundaries. For each finding:
1. **Trace data path**: input → processing → output. Show: "value X constructed at file.ts:123, passed to file2.ts:456, consumed at file3.ts:789 where..."
2. **Check fix history**: `git log --oneline -- <file>` for files with findings
3. **Rate severity**: CRITICAL (data corruption, security bypass, wrong calculations) or HIGH (defense-in-depth gap, incorrect but non-corrupting)
4. **Propose fix** with exact code — but DO NOT apply yet

**Review checklist — check ALL**:
- Every index/ID: construction site matches consumption site
- Every schema/type export: grep all imports, verify current version
- Every `new Date(string)`: UTC-safe parsing — no `getMonth()` on non-UTC dates
- Every financial calculation: same rounding at both pipeline ends
- Every new DTO field: stored, read, AND returned
- Every `.refine()`/`.min()`/`.max()`: `.parse()` called at runtime
- Cross-ticket interfaces: types match across ticket boundaries

**Phase 2 — FIX** (only if Phase 1 found issues):
Pick single highest-severity finding. Minimal fix. Write regression test exercising actual data flow. Run test suite. If regression → revert, defer to next finding.

**Phase 3 — READ-ONLY self-verify**:
After each fix: verify callers, consumers, dead code, boolean logic branches. If verification fails → revert.

**Convergence**: Two consecutive Phase 1 passes where zero CRITICAL+HIGH findings are discovered means convergence — exit the loop. If not converged after 3 full cycles, document remaining findings as trap doors in subsystem CLAUDE.md and exit.

## Interface Contracts
**Inputs**: MODIFIED_FILES list, AFFECTED_SUBSYSTEMS list | **Outputs**: Verified data flows, regression tests, atomic commits, trap door documentation | **Errors**: Verification failures trigger revert of the specific fix | **Invariants**: No data flow crosses a ticket boundary without type alignment at both ends

## Acceptance Criteria
- [ ] Zero CRITICAL findings in data flows through AFFECTED_SUBSYSTEMS — Verify: Phase 1 review complete — Type: llm-conformance
- [ ] Zero HIGH findings in data flows through AFFECTED_SUBSYSTEMS — Verify: Phase 1 review complete — Type: llm-conformance
- [ ] All cross-ticket interfaces type-match — Verify: `${TC_CMD}` — Type: typecheck
- [ ] Test suite passes — Verify: `${TEST_CMD}` — Type: test
- [ ] Each fix has a regression test — Verify: `git log --oneline` shows test alongside each fix — Type: test

## Test Expectations
| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| Data flow integrity | Integration test file | Trace value from entry to exit | Output matches expected transformation |
| Cross-ticket handoff | Integration test file | Value crosses module boundary | Types align, no silent coercion |

## Conformance Check
- [ ] Type checker passes — no new errors
- [ ] Test runner passes — all acceptance tests
- [ ] Contracts match impl signatures (resolve aliases, compare fields)
- [ ] All CRITICAL/HIGH findings resolved or documented as trap doors

## Exit State
Zero CRITICAL+HIGH findings across two consecutive Phase 1 reviews, OR all remaining findings documented as trap doors after 3 cycles. Each fix is an atomic commit with format: `audit: [CRITICAL/HIGH] [description]`. Trap doors documented in subsystem CLAUDE.md.

## NOT in Scope
Reviewing subsystems not in AFFECTED_SUBSYSTEMS. Modifying files not in MODIFIED_FILES. Adding features. P2+ findings. Performance optimization.
```

**Ticket 3: Test Quality Hardening**

Hash: `openssl rand -hex 4`. Dir: `${SESSION_ROOT}/[hash]/`. File: `rick_ticket_[hash].md`:

```markdown
---
id: [hash]
title: "Harden: test quality review of [feature area]"
status: Todo
priority: High
complexity_tier: large
order: [last order + 10]
working_dir: [project root]
created: [Date]
updated: [Date]
links:
  - url: ../rick_ticket_parent.md
    title: Parent
---
# Description
## Problem
Implementation and wiring tickets produce tests that verify their own acceptance criteria, but cross-cutting test quality issues — weak assertions that pass on substrings instead of structure, missing edge case coverage, untested field transformations, incomplete AC mapping — only become visible when reviewing the complete test suite against the full implementation.

## Solution
Review ALL test files created or modified by implementation tickets. Strengthen assertions, add missing coverage, verify AC mapping is complete. Fix one issue at a time, run full suite after each fix.

## Entry Conditions
All prior tickets are complete and individually verified. Test suite passes.

## Research Seeds
- **Files**: [TEST_FILES — all test files created or modified by prior tickets]
- **Implementation files**: [MODIFIED_FILES — to verify tests exercise actual behavior]
- **Patterns**: Assertion strength hierarchy: structural validation > line-based matching > regex with boundaries > `.includes()` substring. Prefer highest feasible level.
- **ACs**: [List all acceptance criteria from refined PRD — each must map to at least one test]

## Implementation Details
**Files to modify/create**: [TEST_FILES — full backticked list of every test file path created or modified by prior tickets; this is the concrete in-scope set the worker may edit. Implementation files in MODIFIED_FILES are read-only reference, not in this set.]

**Review scope**: ONLY test files from prior tickets. Implementation files are read-only reference.

**Lifecycle mapping**: During Research phase, read all test files and the refined PRD's acceptance criteria table. During Plan phase, catalog gaps by severity. During Implement phase, execute the review-fix loop below.

**Review-fix loop** — repeat for each test file until zero P0-P1 gaps remain:

1. **AC Coverage Audit**: Map every acceptance criterion from the refined PRD to a test case. Flag unmapped ACs as P0.

2. **Assertion Strength Review**: For each assertion, rate:
   - P0: Tautological (always passes, e.g. `assert(true)`, `assert(typeof x === 'object')` on known object)
   - P1: Substring match that could false-positive (`.includes('foo')` where `foobar` also matches)
   - P1: Happy path only — no error/boundary/edge case test for a modified code path
   - P2: Correct but could be structural (e.g. `.includes()` where line-based or regex would be more precise)

3. **Field Transformation Coverage**: For every field that changes name or shape across a boundary (e.g. camelCase→snake_case, string→number, DTO→entity), verify a test exercises the transformation end-to-end. Flag missing transformation tests as P1.

4. **Test Isolation Check**: Verify no shared mutable state between tests. Each test constructs its own fixtures. Flag shared state as P1.

5. **patternsApplied / metadata checks**: For builder/codegen tests, verify result metadata (patterns applied, diagnostics, defense matrix) is asserted — not just output strings.

**Fixes**: One fix per commit. Strengthen weakest assertion first. Run full test suite after each fix. If a strengthened assertion fails, investigate whether the assertion or the implementation is wrong — do NOT weaken back to pass.

**Principle checklist**:
- Every AC has a dedicated test
- No `.includes()` where line-based or regex matching is feasible
- Node/element IDs use word-boundary regex (`\b`) to prevent substring false positives
- Error paths tested (invalid input → expected error type/code)
- Field name conversions tested end-to-end (input shape → output shape)
- Composition/integration tests verify metadata (patternsApplied, error codes) not just output strings
- Test helper functions create fresh fixtures per call (no shared mutable state)

## Interface Contracts
**Inputs**: Test files list, acceptance criteria from refined PRD
**Outputs**: Strengthened test files, new edge case tests, atomic commits
**Errors**: Test failures after strengthening indicate implementation bugs — escalate, do not weaken assertions
**Invariants**: Test count can only increase. No test deletions unless replacing with strictly stronger version.

## Acceptance Criteria
- [ ] Every AC from refined PRD maps to at least one test — Verify: manual mapping review — Type: llm-conformance
- [ ] Zero P0 assertion gaps (tautological or unmapped ACs) — Verify: review complete — Type: llm-conformance
- [ ] Zero P1 assertion gaps (weak substring, missing edge cases, missing transformations) — Verify: review complete — Type: llm-conformance
- [ ] Test suite passes — Verify: `${TEST_CMD}` — Type: test
- [ ] Type checker passes — Verify: `${TC_CMD}` — Type: typecheck

## Test Expectations
| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| Strengthened assertions | Modified test files | Assertions upgraded to structural/line-based | No weak .includes() remaining for node IDs or attributes |
| Edge case coverage | Modified test files | Error paths, boundary conditions | Invalid inputs produce expected errors |
| Transformation coverage | Modified test files | Field name/shape conversions | Input camelCase produces output snake_case |

## Conformance Check
- [ ] Type checker passes — no new errors
- [ ] Test runner passes — all tests
- [ ] Every refined PRD AC has a test
- [ ] No shared mutable state between tests

## Exit State
All test files have zero P0-P1 assertion gaps. Every AC is mapped to a test. Each fix is an atomic commit with format: `harden: [test-quality] — [description]`.

## NOT in Scope
Writing new features. Modifying implementation code (only test files). Performance testing. P2 assertion improvements unless trivially fixable alongside P1 fixes.
```

**Ticket 4: Cross-Reference Consistency Audit**

Hash: `openssl rand -hex 4`. Dir: `${SESSION_ROOT}/[hash]/`. File: `rick_ticket_[hash].md`:

```markdown
---
id: [hash]
title: "Audit: cross-reference consistency for [feature area]"
status: Todo
priority: High
complexity_tier: medium
order: [last order + 10]
working_dir: [project root]
created: [Date]
updated: [Date]
links:
  - url: ../rick_ticket_parent.md
    title: Parent
---
# Description
## Problem
Isolated workers produce documentation, prompts, and implementation code independently. Cross-file consistency errors — pattern numbers in docs that don't match code constants, API examples in prompts that reference non-existent functions, enum values in types that don't appear in handlers, config keys in docs that don't match implementation — only surface when cross-referencing all artifacts together. These errors are particularly dangerous because they silently mislead future users and AI agents who read the docs.

## Solution
Three-pass cross-reference audit: (1) collect all named references from documentation/prompt files, (2) verify each reference exists in implementation, (3) collect all named exports/constants from implementation and verify docs mention them where relevant.

## Entry Conditions
All prior tickets are complete and individually verified. Test suite passes.

## Research Seeds
- **Doc/Prompt files**: [DOC_FILES — all .md command files, README sections, prompt templates modified by prior tickets]
- **Implementation files**: [MODIFIED_FILES — source code files modified by prior tickets]
- **Reference types to check**: Pattern numbers, function/method names, type/interface names, enum values, CLI commands, config keys, error codes, node IDs, class names

## Implementation Details
**Files to modify/create**: [DOC_FILES — full backticked list of every .md command file, README section, and prompt-template path modified by prior tickets; this is the concrete in-scope set the worker may edit. Implementation files in MODIFIED_FILES are read-only reference, not in this set.]

**Scope**: Cross-reference between DOC_FILES and MODIFIED_FILES only. Do not audit unmodified documentation.

**Lifecycle mapping**: During Research phase, read all doc and implementation files. During Plan phase, build reference maps and identify mismatches. During Implement phase, fix mismatches one at a time.

**Three-pass protocol**:

**Pass 1 — Doc→Code (do docs reference real things?)**:
For each documentation/prompt file in DOC_FILES:
1. Extract all named references: pattern numbers (P1, P25, Pattern 32), function names (`buildPipeline()`, `fromSpec()`), type names (`ConvergenceSpec`), enum values (`'hermes'`, `'claude-code'`), error codes (`DUPLICATE_MODEL`), node IDs (`iter_impl`), class selectors (`.honest_review`), CLI commands, config keys
2. For each reference, grep MODIFIED_FILES to verify it exists
3. Rate mismatches:
   - **CRITICAL**: API example references non-existent function (misleads users into writing broken code)
   - **CRITICAL**: Pattern number collision (two different patterns share a number)
   - **HIGH**: Enum/constant value in docs doesn't match implementation
   - **HIGH**: Error code in docs doesn't match BuildErrorCode type
   - **MEDIUM**: Stale count ("30 patterns" when actual is 32)

**Pass 2 — Code→Doc (do new exports have documentation?)**:
For each implementation file in MODIFIED_FILES:
1. Extract new public exports: interfaces, types, methods, error codes, constants
2. For each export, check if DOC_FILES mention it where a user would need to know
3. Rate gaps:
   - **HIGH**: New public API method undocumented
   - **MEDIUM**: New error code undocumented
   - **LOW**: Internal helper undocumented (expected)

**Pass 3 — Cross-Doc (do docs agree with each other?)**:
For each pair of documentation files in DOC_FILES:
1. Extract shared references (pattern numbers, node IDs, detection signals)
2. Verify they agree — same number means same thing, same signal routes to same pattern
3. Rate conflicts:
   - **CRITICAL**: Same pattern number means different things in different files
   - **HIGH**: Detection signal routes to different patterns in different files
   - **MEDIUM**: Inconsistent terminology (same concept, different names)

**Fixes**: One fix per commit. Fix CRITICAL first, then HIGH. Run `${TEST_CMD}` after each fix (doc changes can affect prompt-driven behavior). Format: `audit: [CRITICAL/HIGH] cross-ref — [description]`.

## Interface Contracts
**Inputs**: DOC_FILES list, MODIFIED_FILES list
**Outputs**: Corrected documentation, atomic commits
**Errors**: Implementation bugs discovered via doc audit are escalated (create new ticket), not fixed here
**Invariants**: Doc references match implementation. No phantom API examples. No pattern number collisions.

## Acceptance Criteria
- [ ] Zero CRITICAL cross-reference mismatches — Verify: Pass 1+3 review complete — Type: llm-conformance
- [ ] Zero HIGH cross-reference mismatches — Verify: Pass 1+2+3 review complete — Type: llm-conformance
- [ ] All new public APIs documented — Verify: Pass 2 review complete — Type: llm-conformance
- [ ] Test suite passes — Verify: `${TEST_CMD}` — Type: test
- [ ] Commands deployed — Verify: `bash install.sh` — Type: integration

## Test Expectations
| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| Doc accuracy | N/A | Manual cross-reference | All doc references resolve to real implementation |
| Pattern consistency | N/A | Cross-doc check | No pattern number collisions |

## Conformance Check
- [ ] Type checker passes — no new errors
- [ ] Test runner passes — all tests
- [ ] All CRITICAL/HIGH mismatches resolved
- [ ] `bash install.sh` deploys clean

## Exit State
Zero CRITICAL+HIGH cross-reference mismatches. All new public APIs documented. Doc references verified against implementation. Each fix is an atomic commit with format: `audit: [CRITICAL/HIGH] cross-ref — [description]`.

## NOT in Scope
Reviewing unmodified documentation. Writing new feature documentation from scratch. Fixing implementation bugs (escalate as new tickets). MEDIUM/LOW mismatches unless trivially fixable.
```

### 7f: Append Breakdown
Add `## Implementation Task Breakdown` table to `${SESSION_ROOT}/prd_refined.md`: Order | ID | Title | Priority | Entry | Exit | Files. Include wiring and hardening tickets as final rows.

### 7g: Advance State

**Harness task hygiene** (run before advancing state): if any harness tasks were created during this skill (against the Tool Discipline directive at the top), mark them all `deleted` now via `TaskUpdate(taskId=<id>, status="deleted")`. State handoff is filesystem-only; downstream `/pickle-tmux --teams` owns the harness task list and orphan tasks will pollute its `TaskList` poll.

```bash
node "${EXTENSION_ROOT}/extension/bin/update-state.js" step research "${SESSION_ROOT}"
node "${EXTENSION_ROOT}/extension/bin/update-state.js" current_ticket ${FIRST_ID} "${SESSION_ROOT}"
```

Note: `${FIRST_ID}` is the first **implementation** ticket, not a hardening ticket. Hardening tickets run last.

## Step 8: Update Original PRD
Write `${SESSION_ROOT}/prd_refined.md` back to `<PRD_PATH>`. Pre-refinement preserved at `${SESSION_ROOT}/prd.md`.

## Step 9: Refinement Summary
Write `${SESSION_ROOT}/refinement_summary.md`: paths, timestamp, per-analysis changes, task list, failures.

## Step 10: Verify & Handoff
Check: state.json `step`=research, child dirs exist, `current_ticket` set.

**ALL pass + AUTO_RUN** → print results, proceed to Step 11.
**ALL pass** → print results + resume commands.
**ANY fail + AUTO_RUN** → "auto-launch aborted" + failures. STOP.
**ANY fail** → warn + from-scratch command. STOP.

Never recommend `--resume` if state incomplete.

## Step 11: Auto-Launch (AUTO_RUN only)

### 11a: Check multiplexer
`tmux -V` → MUX=tmux → 11b. Else check `zellij --version` >= 0.40.0 → MUX=zellij → 11b-zellij. Neither → suggest install, stop.

### 11b: Re-initialize (tmux)
```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --tmux --resume "${SESSION_ROOT}" --max-iterations 0 --max-time 0
```
### 11b-zellij: Re-initialize (Zellij)
Same setup command. Then create Zellij session per /pickle-zellij Steps 3-4.

### 11c: tmux Session
```bash
tmux new-session -d -s pickle-<hash> -c <working_dir>
sleep 1
```

### 11d: Launch Runner
```bash
tmux send-keys -t <name>:0 "node $HOME/.claude/pickle-rick/extension/bin/mux-runner.js ${SESSION_ROOT}; echo 'Runner finished.'; read" Enter
```

### 11e: Monitor
mux-runner auto-creates the 4-pane monitor window on startup — no manual invocation needed.

### 11g: Report
Print: session, attach command, layout, cancel/kill commands.

Output: `<promise>TASK_COMPLETED</promise>`

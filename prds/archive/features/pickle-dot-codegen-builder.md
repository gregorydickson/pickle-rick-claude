# Pickle-Dot Codegen Builder PRD

| Pickle-Dot Codegen Builder PRD | | TypeScript DSL for deterministic DOT pipeline generation with schema-driven validation and LLM fix loops |
|:---|:---|:---|
| **Author**: Greg Dickson **Contributors**: Pickle Rick | **Status**: Refined **Created**: 2026-03-21 | **Visibility**: Internal |

## Completion Checklist

- [x] Introduction
- [x] Problem
- [x] Scope
- [x] CUJs
- [x] Requirements
- [x] Contracts
- [x] Verification
- [x] Tests
- [x] Assumptions
- [x] Risks
- [x] Impact
- [x] Stakeholders

## Introduction

Today, `/pickle-dot` converts PRDs to attractor-compatible DOT pipelines using ~995 lines of prompt engineering across two markdown files (440-line command + 555-line patterns reference). The entire 30-pattern system — including structural rules, anti-patterns, validation checks, and defense-in-depth layers — must be internalized by the LLM on every invocation. There is no programmatic enforcement, no type safety, and no automated validation before submission. *(refined: pattern count corrected to 30 pipeline composition patterns — excludes 3 superseded (5, 7, 12) and 5 defensive coding patterns (26-30))*

This PRD introduces a TypeScript codegen builder (`dot-builder.ts`) that provides a typed API for constructing DOT pipelines. The builder encodes all 30 composition patterns (28 active in v1 — Pattern 24 deferred, Pattern 11 deprecated), imports attractor's schema manifest for attribute validation, and performs internal structural validation (15 rules) with optional external validation via attractor's `validate` CLI. The `/pickle-dot` command evolves from pure prompt-driven generation to: LLM analyzes PRD → constructs `BuilderSpec` JSON → pipes to builder CLI → validates output → auto-fixes diagnostics → saves. *(refined: invocation architecture specified as CLI stdin JSON — three-analyst consensus)*

## Problem Statement

**Current Process**: `/pickle-dot` is a 440-line command prompt + 555-line patterns reference. The LLM must correctly apply 30 patterns, avoid 39 anti-patterns, perform 4 pre-submission checks, and emit syntactically valid DOT — all from prompt context alone. No unit tests exist for DOT generation correctness. *(refined: pattern count corrected to 30 pipeline patterns; anti-pattern count corrected to 39; line counts updated)*

**Users**: Pipeline authors using `/pickle-dot` to convert PRDs to attractor pipelines

**Pain Points**:
1. **Non-deterministic output** — same PRD can produce structurally different DOT files across invocations
2. **Pattern omission** — LLM forgets patterns (especially Tier 2 defaults like progress gates, delta-aware verification)
3. **Schema drift** — pickle-dot patterns reference attributes that may not match attractor's current schema
4. **No pre-flight validation** — structural errors discovered only after hours of pipeline execution
5. **Acceptance criteria gaps** — missing `context_on_success` → `acceptance_criteria` mappings cause 10-retry failures at exit
6. **Thread ID errors** — impl↔fix thread_id mismatches cause fix nodes to operate without context

**Importance**: Each pattern omission or schema error costs 1-4 hours of failed pipeline execution. The system handles 30 patterns × 39 anti-patterns × handler-specific rules — this complexity exceeds what prompt engineering alone can reliably manage.

## Objective & Scope

**Objective**: Replace prompt-only DOT generation with a TypeScript builder that programmatically enforces patterns, validates against attractor's schema, and runs structural validation before saving.

**Ideal Outcome**: `/pickle-dot` produces correct DOT files on the first attempt. The LLM's role shifts from "generate raw DOT syntax" to "analyze PRD and construct a BuilderSpec JSON" — a higher-level, less error-prone task.

### In-scope

1. **`services/dot-builder.ts`** — Typed API for constructing DOT pipelines with all 30 pipeline composition patterns (28 active in v1) *(refined: file location specified per codebase analysis; pattern count corrected)*
2. **`bin/dot-builder.ts`** — CLI entry point: stdin JSON → stdout BuildResult JSON *(refined: new — invocation architecture)*
3. **Schema sync** — Import attractor's `schema.json` manifest for attribute validation at build time; hand-maintained fallback schema when unavailable
4. **Internal validation** — 15 structural rules implemented in the builder itself (single start/exit, no incoming→start, reachability, diamond branching, goal_gate→max_visits, AC mapping, timeout presence, prompt↔allowed_paths, read_only+STATUS, component↔tripleoctagon, fan_out_scope, workspace_config, workspace_push, permission_mode_plan, allowed_paths_required) *(refined: elevated from fallback to primary; expanded from 10 to 15 rules after patterns.md audit)*
5. **External validation** — When available, call `attractor validate --format json` as supplementary validation *(refined: demoted from P0 to P1 — external dependency)*
6. **LLM fix loop** — Inside `/pickle-dot`, if validation fails, present errors to LLM, modify BuilderSpec, re-invoke builder, re-validate (max 3 fix attempts)
7. **Fix-loop terminal behavior** — On exhaustion, save best attempt as `${SLUG}.dot.draft` with remaining diagnostics *(refined: new — was completely unspecified)*
8. **Acceptance criteria enforcement** — Builder refuses to `.build()` if acceptance_criteria keys lack context_on_success sources
9. **Thread ID auto-scoping** — Phases auto-assign thread_ids; fix nodes inherit from their impl phase
10. **Defense matrix generation** — Builder auto-generates the 5-layer defense matrix comment block
11. **All 30 pipeline composition patterns** — Tier 1 (always), Tier 2 (default), Tier 3 (conditional) — encoded per Pattern Application Matrix. Excludes 3 superseded patterns (5, 7, 12) and 5 defensive coding patterns (26-30) *(refined: pattern count corrected to 30; tier/exclusion breakdown added)*
12. **`/pickle-dot` command update** — Rewrite command prompt: remove raw DOT generation, add BuilderSpec construction instructions with ≥3 few-shot examples, add fix-loop diagnostic parsing *(refined: new — was a shadow deliverable with zero requirements)*
13. **`--legacy` flag** — `/pickle-dot --legacy` preserves prompt-only generation as rollback path *(refined: new — rollback mechanism)*
14. **Pattern behaviors from `pickle-dot-patterns.md` absorbed into builder test assertions** — patterns.md becomes reference documentation; builder is the programmatic source of truth *(refined: new — resolves dual source of truth)*

### Not-in-scope

- Changes to attractor's engine or handler implementations
- New patterns beyond the existing 30 pipeline composition patterns
- GUI/web interface for pipeline construction
- Backward compatibility with hand-written DOT files (builder generates DOT; existing DOT files are unaffected)
- The attractor-side validate enhancements (separate PRD)
- `rawNode()` / `rawEdge()` escape hatches — if builder API is too rigid for a specific topology, use `--legacy` flag instead *(refined: resolved ghost requirement — three-analyst consensus recommends exclusion from v1)*
- Pattern 24 (Manager Loop) — deferred to v2 (requires multi-pipeline orchestration) *(refined: explicitly deferred)*
- Pattern 11 (Drift Detection) — deprecated for ratchet pipelines (Pattern 19 supersedes); included in matrix for reference but not in v1 active scope *(refined: explicitly deprecated)*
- Superseded patterns (5 Human Gates, 7 Review-Simplify, 12 Multi-Pass Complexity) — reference only in patterns.md, never emitted by builder *(refined: new — explicitly excluded)*
- Defensive coding patterns (26-30: Stream Lifecycle, Optional Narrowing, Silent Failure Prevention, Concurrency Safety, Allocation Hygiene) — these are TypeScript code-level guardrails for the extension codebase, not DOT pipeline generation patterns. The builder's own code should follow them, but they produce no DOT output *(refined: new — clarifies pattern taxonomy)*
- Maintaining `pickle-dot-patterns.md` as a separate living document (absorbed into builder tests)

## Product Requirements

### Critical User Journeys (CUJs)

**CUJ-1: PRD → validated DOT via /pickle-dot**
User runs `/pickle-dot` with a PRD. The LLM analyzes the PRD, constructs a `BuilderSpec` JSON, pipes it to `node ~/.claude/pickle-rick/extension/bin/dot-builder.js`. The builder enforces invariants, runs internal validation (15 rules), and returns `BuildResult` JSON on stdout. `/pickle-dot` saves the DOT file. User sees the defense matrix summary and pattern checklist. *(refined: specifies invocation architecture)*

**CUJ-2: Validation failure → auto-fix → success**
Builder returns `BuildError` JSON on stderr (exit code 1) with 2 diagnostics. The LLM reads the structured diagnostics, modifies the BuilderSpec to fix the issues, re-pipes to builder CLI, gets success (exit 0), saves.

**CUJ-2b: Fix loop exhaustion → draft saved** *(refined: new CUJ)*
Builder returns errors on 3 consecutive fix attempts. `/pickle-dot` selects the attempt with fewest remaining errors, saves as `${SLUG}.dot.draft`, displays all remaining diagnostics with suggested fixes. Prints: "Auto-fix exhausted after 3 attempts. Draft saved to ${SLUG}.dot.draft with N remaining errors."

**CUJ-3: Acceptance criteria compile-time error**
User's PRD has 3 acceptance criteria including a custom key `"auth_secure"`. Builder's `.build()` detects that `"auth_secure"` has no `context_on_success` source (it is not auto-generated by Tier 2). Build fails with `BuildError` containing `{ code: 'MISSING_AC_MAPPING', diagnostics: [{ rule: 'acceptance_criteria_sources', message: 'AC key "auth_secure" has no context_on_success source' }] }`. The LLM adds `contextOnSuccess: { auth_secure: "true" }` to the auth phase and retries. *(refined: specifies error structure; council review: changed example key from "tests_pass" to "auth_secure" since Tier 2 auto-generates "tests_pass")*

**CUJ-4: Schema update propagation**
Attractor adds a new attribute `reasoning_budget`. Developer runs `npm run sync-schema` in pickle-rick-claude, which reads attractor's `schema.json` from `$ATTRACTOR_ROOT` and generates `extension/src/types/attractor-schema.ts`. The builder's TypeScript types now include the new attribute. *(refined: specifies sync mechanism and output format)*

**CUJ-5: Multi-phase pipeline with mixed Tier 2/3 patterns** *(refined: new CUJ — most common real-world pipeline shape)*
1. User has a PRD requiring: auth module (spec-first, security scan), API endpoints (spec-first, goal gate), and docs (no special patterns)
2. LLM constructs BuilderSpec with 3 phases:
   - Phase "auth": `specFirst=true, securityScan=true, allowedPaths=["src/auth/**"]`
   - Phase "api": `specFirst=true, goalGate=true, allowedPaths=["src/api/**"]`
   - Phase "docs": `allowedPaths=["docs/**"]`
   - `reviewRatchet: 3`, acceptanceCriteria with 3 keys
3. Builder generates DOT with:
   - `thread_id="phase_1"` on all auth nodes, `"phase_2"` on api, `"phase_3"` on docs
   - Security scan node after auth progress check (Pattern 8 placement: after `check_progress_auth`, before `verify_lint_auth`)
   - Goal gate with retry_target on api phase, max_visits on retry loop
   - spec_file nodes before impl in auth and api phases
   - allowed_paths includes test dirs for auth and api
   - 3-pass review ratchet loop
   - Defense matrix: competitive=false, specDriven="spec_file + conformance", adversarial=false, guardrails=["max_visits", "no-op", "read_only"], permissions=["allowed_paths", "escalate_on"]
4. All applied patterns listed in `BuildResult.patternsApplied`
5. Internal validation returns 0 errors

### Functional Requirements

| Priority | Requirement | User Story | Verification |
|:---|:---|:---|:---|
| P0 | Builder emits syntactically valid DOT | As a pipeline author, I need the output to parse | Generated DOT parses without syntax errors |
| P0 | Builder enforces single start node (Mdiamond) and single exit node (Msquare) | As a pipeline author, structural invariants must hold | `.build()` returns error-severity diagnostic with code `INVALID_STRUCTURE` if start/exit count ≠ 1 (causes `BuildError` throw — see validation contract) |
| P0 | Builder enforces acceptance_criteria ↔ context_on_success mapping completeness | As a pipeline author, I need exit convergence guaranteed | `.build()` returns error-severity diagnostic with code `MISSING_AC_MAPPING` listing unmapped keys (causes `BuildError` throw — see validation contract) |
| P0 | Builder auto-assigns thread_id per phase, fix nodes inherit from impl | As a pipeline author, thread_id errors should be impossible | Generated DOT has consistent thread_ids per phase |
| P0 | Builder adds `timeout` to all codergen nodes (default `30m` for `class="codergen"` nodes including impl and fix, `15m` for `class="review"` nodes) | As a pipeline author, unbounded LLM calls must be prevented | All box nodes in output have `timeout` attribute *(gap-analysis: corrected "review/fix" → class-based rule; fix nodes are class="codergen" and get 30m)* |
| P0 | Builder adds `read_only=true` + STATUS markers to all review/conformance/red_team nodes | As a pipeline author, infinite retry on read-only nodes must be prevented | All review-class nodes have both defenses |
| P0 | Builder generates defense matrix comment block | As a pipeline reviewer, I need quality gate documentation | Output contains `/* DEFENSE MATRIX` block with 5 layers |
| P0 | Builder exposes `DotBuilder.fromSpec(spec: BuilderSpec)` static factory for CLI input | As the /pickle-dot CLI, JSON→builder conversion must be lossless | `fromSpec()` output matches equivalent constructor API output *(refined: new)* |
| P0 | Builder performs internal structural validation (15 rules) on `.build()` output | As a pipeline author, structural errors must be caught even without attractor CLI | `.build()` runs 15 validation rules: throws `BuildError` if any error-severity diagnostics, returns `BuildResult` with warning/info diagnostics otherwise (see validation contract) *(refined: elevated from fallback to primary; expanded to 15 rules; microverse: iter4 — clarified throw-vs-return)* |
| P0 | Internal validation covers: (1) single start/exit, (2) no incoming→start, (3) reachability, (4) diamond branching, (5) goal_gate→max_visits, (6) AC mapping, (7) timeout presence, (8) prompt↔allowed_paths, (9) read_only+STATUS, (10) component↔tripleoctagon, (11) fan_out_scope — retry_target stays within component scope, (12) workspace_config — isolated workspace requires HTTPS repo_url, (13) workspace_push — isolated workspace requires commit_and_push node, (14) permission_mode_plan — `permission_mode="plan"` deadlocks headless pipelines, (15) allowed_paths_required — per-phase codergen impl nodes must have allowed_paths (cross-phase nodes like `fix_all`, `fix_review`, `verify_final` inherit union of all phase paths via Pattern 22 and emit a warning — not an error — if the union is empty) *(review: aligned scope to per-phase impl nodes; cross-phase nodes get warning not error)* | As a pipeline author, the 15 most common structural errors must be caught | Unit tests for each rule *(refined: expanded from 10 to 15 after patterns.md validator rule audit)* |
| P0 | **Validation contract**: `.build()` runs all 15 validation rules, collecting `Diagnostic[]`. If any diagnostic has `severity: 'error'`, `.build()` throws `BuildError` (with the error diagnostics attached in `BuildError.diagnostics`). If all diagnostics are `severity: 'warning'` or `'info'`, `.build()` returns `BuildResult` with those diagnostics in `BuildResult.diagnostics`. This means callers get `BuildResult` only when the pipeline is structurally valid (no errors). | As a pipeline author, I need to know whether `.build()` throws or returns for validation failures | Unit test: error-severity diagnostic → `BuildError` thrown; warning-severity → `BuildResult` returned *(microverse: iter4 — disambiguates throw-vs-return)* |
| P0 | CLI entry point at `bin/dot-builder.ts`: stdin JSON → stdout BuildResult JSON, stderr for errors | As the /pickle-dot command, I need a programmatic invocation path | CLI exits 0 on success (stdout JSON), 1 on BuildError (stderr JSON), 2 on unexpected error *(refined: new)* |
| P0 | Updated `/pickle-dot` prompt instructs LLM to construct BuilderSpec JSON from PRD analysis | As a pipeline author, the command must produce builder input, not raw DOT | Prompt contains BuilderSpec construction instructions *(refined: new)* |
| P0 | Updated `/pickle-dot` prompt removes all raw DOT generation instructions | As a maintainer, two generation paths create confusion | No DOT syntax instructions remain in prompt *(refined: new)* |
| P0 | Fix-loop terminal behavior: after 3 failed fix attempts, save best attempt as `.dot.draft` | As a pipeline author, I need partial progress preserved | Integration test: 3 failed attempts → `.dot.draft` exists *(refined: new)* |
| P0 | Fix loop tracks error count per iteration; reverts to best prior attempt if errors increase | As a pipeline author, fix iterations must converge | Unit test: error count [5, 3, 4] → reverts to attempt 1 (count 3) — 0-based per Fix Loop Specification: attempt 0=5, attempt 1=3, attempt 2=4 *(refined: new; microverse: gap-analysis — fixed 1-based/0-based numbering inconsistency)* |
| P1 | Builder supports all 30 pipeline composition patterns per Pattern Application Matrix (28 active in v1 — Pattern 24 deferred, Pattern 11 deprecated) | As a pipeline author, I need the full pattern library | Each pattern has a corresponding method, auto-application, or documented default *(refined: corrected count to 30, references matrix)* |
| P1 | Schema sync: `npm run sync-schema` reads attractor's `schema.json`, generates `extension/src/types/attractor-schema.ts` | As a maintainer, I need schema drift eliminated | Script runs without errors, produces valid TypeScript *(refined: specifies output format)* |
| P1 | Builder enforces `max_parallel=1` on component fan-out nodes | As a pipeline author, Docker memory limits must be respected | All component nodes have `max_parallel=1` |
| P1 | Builder enforces `allowed_paths` on all codergen impl nodes | As a pipeline author, scope enforcement must be complete | `.build()` returns error-severity diagnostic with code `MISSING_ALLOWED_PATHS` if any per-phase codergen impl node lacks `allowed_paths` (causes `BuildError` throw — see validation contract). Cross-phase nodes (`fix_all`, `verify_final`) get warning-severity if union is empty. *(microverse: iter3 #11; iter4 — aligned with validation contract)* |
| P1 | Builder enforces `allowed_paths` includes test directories when source dirs specified | As a pipeline author, agents need to write tests | For `["src/auth/**"]`, output includes `tests/auth/**` or `__tests__/auth/**` *(refined: scoped test dir, not broad)* |
| P1 | Builder enforces `retry_target` on all `goal_gate=true` nodes | As a pipeline author, goal gates without retry are useless | `.build()` throws if goal_gate node lacks retry_target |
| P1 | Builder auto-generates graph-level `retry_target="fix_all"` and validates it does not point to start/setup | As a pipeline author, wasteful full-pipeline retries must be prevented | `.build()` always sets graph-level `retry_target="fix_all"`; throws if overridden to start or setup_deps *(council: C3 — graph-level attribute)* |
| P1 | Builder enforces `max_visits` on all nodes in retry loops | As a pipeline author, infinite loops must be bounded | Nodes with incoming retry edges get `max_visits` (default 5) |
| P1 | Same BuilderSpec input produces byte-identical DOT output across invocations | As a pipeline author, non-determinism is pain point #1 | Unit test: two builds from identical spec, assert string equality *(refined: new — determinism requirement)* |
| P1 | When available, `attractor validate --format json` runs as supplementary validation after internal validation | As a pipeline author, I want the most thorough validation available | Integration test with attractor CLI *(refined: demoted from P0)* |
| P1 | Updated `/pickle-dot` prompt includes ≥3 few-shot examples covering single-phase, multi-phase, and microverse pipelines | As a pipeline author, the LLM needs examples to construct correct specs | Prompt has 3+ labeled example blocks *(refined: new)* |
| P1 | `/pickle-dot --legacy` flag preserves prompt-only generation path | As a pipeline author, I need a rollback path | `--legacy` produces DOT without builder invocation *(refined: new)* |
| P1 | `/pickle-dot --builder` flag enables builder path during Phase 1 opt-in period (default remains prompt-only until Phase 2) | As a pipeline author, I need to opt-in to builder before it becomes default | `--builder` invokes builder CLI; without flag, prompt-only path used *(council: H1)* |
| P1 | Each active pattern has a dedicated snapshot test asserting its specific DOT attributes | As a maintainer, pattern correctness must be machine-verifiable without domain expertise | 28 snapshot tests (30 pipeline patterns minus Pattern 24 deferred minus Pattern 11 deprecated) *(refined: new; count corrected)* |
| P1 | Builder only emits attributes present in the synced schema version (or fallback schema) | As a pipeline author, DOT must be compatible with the running attractor version | `.build()` warns on unknown attributes *(refined: new — forward-compatibility)* |
| P2 | Builder supports model_stylesheet generation from provider/model config | As a pipeline author, LLM routing should be declarative | `.modelStylesheet()` method generates valid CSS-like syntax |
| P2 | Builder supports microverse pattern detection and generation | As a pipeline author, numeric optimization should use microverse | `.microverse()` method generates optimize→measure→compare→check loop |
| P2 | Builder supports workspace isolation with auto `commit_and_push` | As a pipeline author, isolated workspace code must be preserved | `workspace("isolated")` auto-adds commit_and_push node on success path |
| P1 | Builder supports review convergence ratchet | As a pipeline author, review quality must be enforced | `.reviewRatchet(n)` generates N-pass consecutive clean review loop *(council: H4 — elevated from P2 to match snapshot test priority)* |
| P2 | Builder cross-checks prompt file paths against `allowed_paths` | As a pipeline author, token waste from rejected edits must be prevented | `.build()` warns if prompt references paths outside allowed_paths |
| P3 | Builder logs which patterns were applied | As a debugger, I need to know what the builder decided | `.build()` returns metadata with applied pattern list |

**Thread ID assignment for cross-phase nodes** *(microverse: iter3 #2)*: The `thread_id` auto-assignment rule applies only to per-phase nodes. Cross-phase infrastructure nodes (`start`, `exit`, `setup_deps`, `capture_baseline`, `split_phases`, `merge_phases`, `fix_all`, `fix_review`, `verify_final`) do NOT receive a `thread_id` attribute — they execute in attractor's default thread context (no phase context). This is correct because these nodes are not scoped to a single phase's conversation history. In particular, `fix_review` operates across all phases' code without phase-specific context, same as `fix_all` and `verify_final`. Cross-phase nodes (`fix_all`, `fix_review`) do not set `context_on_success` keys — their role is remediation, not AC evidence collection. Only `verify_final` and per-phase conformance nodes set `context_on_success`.

## Pattern Application Matrix *(refined: new section — addresses hidden scope gap)*

### Pipeline Composition Patterns (30 total, 28 active in v1)

| ID | Pattern | Mode | API Surface | Default Value | Override? |
|:---|:---|:---|:---|:---|:---|
| 0 | Isolated Workspace | opt-in | `.workspace("isolated")` | N/A | Yes |
| 0a | Dependency Setup | auto | `.build()` internal | Always emitted | No |
| 0b | Parallel Limit | auto | `.build()` internal | `max_parallel=1` — included in `patternsApplied` only when `split_phases` nodes exist in the output graph (i.e., Pattern 4 is active) | No |
| 0c | Baseline Snapshot | auto | `.build()` internal | Always emitted | No |
| 0d | Delta-Aware Verify | auto | `.build()` internal | On all verify nodes | No |
| 0e | Progress Gate | auto | `.build()` internal | After each impl node | No |
| 1 | Test-Fix Loops | auto | `.build()` internal | Per phase | No |
| 2 | Goal Gates | opt-in | `.phase({ goalGate: true })` | `false` | Yes |
| 3 | Conditional Routing | auto | `.build()` internal | On diamond nodes | No |
| 4 | Parallel Fan-Out/Fan-In | auto | `.build()` internal | When ≥2 phases have no `dependsOn` relationship *(council: C5)* | No |
| 6 | Max Visits | auto | `.build()` internal | `5` on loop nodes | No |
| 6b | Read-Only + STATUS | auto | `.build()` internal | On review nodes | No |
| 8 | Security Scan | opt-in | `.phase({ securityScan: true })` | `false` | Yes |
| 9 | Coverage Gate | opt-in | `.phase({ coverageTarget: N })` | undefined | Yes |
| 10 | Scope Creep | auto | `.build()` internal | After impl nodes | No |
| 11 | Drift Detection | **deprecated** | N/A (superseded by Pattern 19 ratchet) | N/A | N/A |
| 13 | Lint Gate | auto | `.build()` internal | In verify chain | No |
| 14 | Type-Check Gate | auto | `.build()` internal | In verify chain | No |
| 15 | Conformance Check | auto | `.build()` internal | Review node | No |
| 16 | Spec-First TDD | default-on | `.phase({ specFirst: true \| false })` | `true` when phase has `goalGate: true`; `false` otherwise. Explicitly setting `specFirst: false` on a goal-gated phase disables it (opt-out). Explicitly setting `specFirst: true` on a non-goal-gated phase enables it (opt-in). | Yes — opt-out on goal-gated phases, opt-in on others |
| 16b | BDD Scenarios | opt-in | `.phase({ bddScenarios: true })` | `false` | Yes *(review: changed from auto/heuristic to explicit opt-in for determinism)* |
| 17 | Red Team | opt-in | `.phase({ redTeam: true })` | `false` | Yes |
| 18 | Competing Impls | opt-in | `.phase({ competing: true })` | `false` | Yes |
| 19 | Review Ratchet | opt-in | `.reviewRatchet(N)` | N/A | Yes |
| 20 | Microverse | opt-in | `.microverse()` | N/A | Yes |
| 21 | Fix All | auto | `.build()` internal | Always emitted | No |
| 22 | Permission Scoping | auto | `.build()` internal | On impl nodes | No |
| 23 | Defense Matrix | auto | `.build()` internal | Always emitted | No |
| 24 | Manager Loop | **deferred** | N/A (v2 — requires multi-pipeline orchestration) | N/A | N/A |
| 25 | Catastrophic Recovery | auto | `.build()` internal | `loop_restart` edge | No |

### Superseded Patterns (reference only — never emitted by builder)

| ID | Pattern | Superseded By | Note |
|:---|:---|:---|:---|
| 5 | Human Gates | N/A | Deadlocks autonomous pipelines; only for interactive/supervised workflows |
| 7 | Review-Simplify Cycle | Pattern 19 (Review Ratchet) | Standalone fallback only |
| 12 | Multi-Pass Complexity | Pattern 18 (Competing Impls) | Merged into competing approach selection |

### Defensive Coding Patterns (26-30 — not DOT pipeline patterns)

These are TypeScript code-level guardrails for the pickle-rick extension codebase. The builder's own implementation should follow them, but they produce no DOT output and are not encoded in the Pattern Application Matrix.

| ID | Pattern | Applies To |
|:---|:---|:---|
| 26 | Stream Lifecycle | `createWriteStream`/`createReadStream` cleanup, `TextDecoder` flush |
| 27 | Optional Narrowing | Bind optional-chained values to local vars before reuse |
| 28 | Silent Failure Prevention | Every `catch` must re-throw, return typed error, or emit warning |
| 29 | Concurrency Safety | Shared resource access, event ordering, path scoping |
| 30 | Allocation Hygiene | Compile-once objects outside hot loops |

**Modes**: `auto` = always applied by `.build()`, no user control. `default-on` = applied unless explicitly disabled. `opt-in` = only when user invokes the corresponding method/field. `deferred` = not in v1 scope. `deprecated` = superseded, not in scope.

**Acceptance criterion**: `BuildResult.patternsApplied` includes every `auto` and `default-on` pattern that **produced output** (emitted nodes, injected attributes, or generated edges) for the given pipeline. Auto patterns whose preconditions are not met (e.g., Pattern 0b with no `shape=component` nodes, Pattern 4 with <2 independent phases, Pattern 25 with no retry loops) are excluded from `patternsApplied` — their logic runs but they are not "applied" if they produced no output. Opt-in patterns appear only when explicitly invoked. *(microverse: iter1 — clarified vacuous application semantics)*

### Auto-Pattern Implementation Detail

These specifications resolve the "always emitted" ambiguity for auto-applied patterns. Each pattern specifies: node name template, placement, and shell command template (where applicable).

| Pattern | Node Name | Placement | Template / Logic |
|:---|:---|:---|:---|
| (start) | `start` | First node in pipeline | `shape="Mdiamond"`. No other attributes. No incoming edges. *(microverse: iter3 #7)* |
| (exit) | `exit` | Last node in pipeline, after `verify_final` | `shape="Msquare"`, `acceptance_criteria` attribute with the graph-level AC string. Single incoming edge from `verify_final`. *(microverse: iter3 #7)* |
| 0a (Dependency Setup) | `setup_deps` | After `start`, before first phase | `tool_command="cd \${WORKING_DIR} && npm install 2>&1 \|\| pnpm install 2>&1 \|\| yarn install 2>&1"` — detect package manager from lockfile presence |
| 0c (Baseline Snapshot) | `capture_baseline` | After `setup_deps`, before first impl | `tool_command="cd \${WORKING_DIR} && (npx tsc --noEmit 2>&1 \| grep -c 'error TS' > /tmp/baseline_ts_errors.txt \|\| echo 0 > /tmp/baseline_ts_errors.txt) && (npx eslint src/ 2>&1 \| grep -c 'error' > /tmp/baseline_lint_errors.txt \|\| echo 0 > /tmp/baseline_lint_errors.txt)"` |
| 0d (Delta-Aware Verify) | `verify_lint_${phase}`, `verify_types_${phase}` | Wraps verify commands | Prepend: `BASELINE=$(cat /tmp/baseline_*.txt 2>/dev/null \|\| echo 0) &&` Append: `&& CURRENT=$(...) && [ $CURRENT -le $BASELINE ]` |
| 0e (Progress Gate) | `check_progress_${phase}` | After each impl node, before `verify_lint`. Always emitted for every phase — the `git status` command works in any directory (git-initialized or not; in non-git directories, it exits non-zero which triggers STATUS: FAIL, correctly flagging no progress). | `tool_command="cd \${WORKING_DIR} && [ $(git status --porcelain \| wc -l) -gt 0 ] && echo 'STATUS: SUCCESS' \|\| echo 'STATUS: FAIL'"` with `read_only=true`, `max_visits=3` |
| 1 (Test-Fix Loops) | `test_${phase}` → diamond → `fix_${phase}` | After verify chain per phase | Diamond routes: `outcome=success` → next, `outcome=fail` → `fix_${phase}` → back to `impl_${phase}` |
| 3 (Conditional Routing) | `check_${name}` (diamond shape) | At branching points | All diamonds MUST have ≥2 outgoing edges covering success/fail |
| 4 (Fan-Out) | `split_phases` / `merge_phases` | When ≥2 phases have no `dependsOn` relationship (phases without `dependsOn` are independent; phases with `dependsOn` are serialized after their dependencies) *(council: C5)* | `split_phases [shape=component, max_parallel=1]` → parallel phase nodes (flat, no DOT subgraph blocks) → `merge_phases [shape=tripleoctagon]` |
| 6b (Read-Only + STATUS) | N/A (attribute injection) | On all `class="review"` nodes | Inject `read_only=true` + append `"\nOutput STATUS: SUCCESS or STATUS: FAIL on its own line."` to prompt |
| 10 (Scope Creep) | `scope_check_${phase}` | After impl, before review ratchet | `class="review"`, `read_only=true`, prompt: `"Compare git diff against phase prompt. Flag files modified outside allowed_paths. Output STATUS: SUCCESS \| FAIL."` |
| 13 (Lint Gate) | `verify_lint_${phase}` | After `check_progress`, before `verify_types` | Delta-aware lint command (see 0d) |
| 14 (Type-Check Gate) | `verify_types_${phase}` | After `verify_lint`, before `test_${phase}` | Delta-aware typecheck command (see 0d) |
| 21 (Fix All) | `fix_all` | Before `verify_final` | `shape="box"`, `class="codergen"`, `timeout="30m"`, attributes per cross-phase inheritance rule (`allowed_paths` = union, `escalate_on` = union, `permission_mode="auto"`). No explicit `prompt` or `tool_command` — attractor injects the retry context from the failing node's output as the LLM prompt. Graph-level and `verify_final` `retry_target` MUST point here. Edge: `fix_all` → `verify_final` (direct — does NOT re-enter the review ratchet on retry). The ratchet is a pre-verify_final gate that runs once per forward pass. *(microverse: iter3 #3; gap-analysis — added explicit shape/timeout/prompt clarification)* |
| (verify_final) | `verify_final` | After review ratchet (or after last phase's conformance if no ratchet), before `exit` | `shape="box"`, `class="codergen"`, `timeout="30m"`, `tool_command="cd \${WORKING_DIR} && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npm test"`, `retry_target="fix_all"`, `max_visits=3`. Sets `context_on_success` with all 6 Tier 2 auto-generated keys only (`types_compile=true`, `lint_clean=true`, `tests_pass=true`, `cli_contract=true`, `determinism=true`, `validation_rules=true` — see AC Mapping Algorithm §Tier 2). Tier 1 explicit keys are NOT placed on verify_final — they belong on `conformance_${phase}` nodes per the AC Mapping Algorithm §Tier 1. AC keys with no source node trigger `MISSING_AC_MAPPING` error, not silent fallback to verify_final. Attributes (`allowed_paths`, `escalate_on`, `permission_mode`) per cross-phase inheritance rule. *(microverse: iter3 #6; gap-analysis — removed contradictory Tier 1 fallback clause; AC Mapping Algorithm is authoritative)* |
| 25 (Catastrophic Recovery) | N/A (edge attribute) | On `verify_final` → `setup_deps` edge | `loop_restart=true` on edge; emitted when any node in the pipeline has ≥1 incoming edge from a diamond non-success outcome branch (any outcome other than `"success"` or `"clean"` — includes `"fail"`, `"issues"`, `"rejected"`, `"partial_success"`) or is referenced by a `retry_target` attribute (i.e., the pipeline contains retry loops). NOT emitted for zero-phase pipelines — this is an explicit exception (carve-out), not a natural precondition miss: the retry-loop predicate IS satisfied (`verify_final` has `retry_target="fix_all"`), but catastrophic recovery restarts from `setup_deps` which only makes sense when per-phase impl nodes exist to re-execute; zero-phase has nothing to re-implement. Also not emitted for pipelines with only forward edges (natural precondition miss — no retry loops). *(review: replaced qualitative "max_visits exhaustion risk" with binary predicate; microverse: iter5 — broadened "outcome=fail" to non-success outcomes covering review ratchet/competing impls/microverse; gap-analysis — clarified zero-phase carve-out rationale)* |
| 0b (Parallel Limit) | N/A (attribute injection) | On all `shape=component` fan-out nodes | Inject `max_parallel="1"` attribute. No separate node — attribute added to existing `split_phases` or per-phase `component` nodes |
| 6 (Max Visits) | N/A (attribute injection) | On all nodes with incoming retry/loop edges | Inject `max_visits="5"` (default) only when the node does not already have an explicit `max_visits` from another pattern (e.g., 0e sets `max_visits=3`; Pattern 6 does not overwrite it). Trigger: node has ≥1 incoming edge from a diamond non-success outcome branch (any outcome other than `"success"` or `"clean"` — includes `"fail"`, `"issues"`, `"rejected"`, `"partial_success"`) or a `retry_target` reference. Does not apply to nodes reachable only via forward edges. *(microverse: iter3 #5; iter5 — broadened "outcome=fail" to non-success outcomes covering review ratchet `outcome="issues"`, competing impls `outcome="rejected"`, microverse `outcome="partial_success"`/`"fail"`)* |
| 15 (Conformance Check) | `conformance_${phase}` | After scope_check, before review ratchet (or before `fix_all` if no ratchet) | `class="review"`, `read_only=true`, `timeout="15m"`, prompt: `"Review the implementation against the phase spec and PRD requirements. Check: correct files modified, API contracts match, no regressions. Output STATUS: SUCCESS \| FAIL."` |
| 22 (Permission Scoping) | N/A (attribute injection) | On all `class="codergen"` nodes (per-phase and cross-phase) | For per-phase nodes: inject `allowed_paths` from `PhaseSpec.allowedPaths` (with test dir heuristic applied), `escalate_on` from `PhaseSpec.escalateOn` (default: `["package.json","*.lock","*.config.*"]`), and `permission_mode="auto"`. For cross-phase codergen nodes (`fix_all`, `fix_review`, `verify_final`): `allowed_paths` = union of all `PhaseSpec.allowedPaths` (with test dir heuristic applied to each), `escalate_on` = union of all `PhaseSpec.escalateOn` values (deduplicated), `permission_mode="auto"`. *(microverse: iter3 #1)* |
| 23 (Defense Matrix) | N/A (comment block) | After graph-level attributes, before first node | Generate `/* DEFENSE MATRIX\n * competitive: ${bool}\n * guardrails: ${list}\n * specDriven: ${string}\n * permissions: ${list}\n * adversarial: ${bool}\n */` from `DefenseMatrix` values computed during `.build()`. **specDriven computation**: if zero phases → `"NONE"`; otherwise build string from active patterns: `"spec_file"` if any phase has Pattern 16 active (specFirst=true explicitly or default-on via goalGate), `" + BDD"` if any phase has Pattern 16b active (bddScenarios=true), `" + conformance"` when ≥1 phase exists (Pattern 15 is auto on all phases; excluded for zero-phase since there are no phases to apply conformance to). Result is one of: `"NONE"` (zero-phase), `"conformance"`, `"BDD + conformance"`, `"spec_file + conformance"`, `"spec_file + BDD + conformance"`. **competitive**: true if any phase has `competing: true` (Pattern 18). **adversarial**: true if any phase has `redTeam: true` (Pattern 17). **guardrails**: collect from active patterns — `"max_visits"` (Pattern 6), `"no-op"` (read_only nodes), `"read_only"` (Pattern 6b). **permissions**: collect — `"allowed_paths"` (Pattern 22), `"escalate_on"` (Pattern 22). |

### Opt-In Pattern Implementation Detail *(microverse: iter4 #5)*

| Pattern | Node Name | Placement | Template / Logic |
|:---|:---|:---|:---|
| 0 (Isolated Workspace) | N/A (graph-level + `commit_and_push`) | Graph-level `workspace="isolated"` attribute; `commit_and_push` node on success path before `exit` | `commit_and_push [shape="box", class="codergen", tool_command="cd \${WORKING_DIR} && git add -A && git commit -m 'Pipeline results' && git push"]`. `WorkspaceOpts` fields emitted as graph-level attributes: `repoUrl` → `repo_url`, `repoBranch` → `repo_branch`, `cleanup` → `workspace_cleanup` (matches attractor's attribute name per patterns.md). |
| 2 (Goal Gates) | N/A (attribute injection on existing nodes) | On phase impl/verify nodes where `goalGate: true` | Inject `goal_gate="true"`, `retry_target="fix_${phase}"`, `max_visits` (Pattern 6 default) on the phase's test diamond node. The diamond's fail edge loops back to fix, which loops to impl. |
| 8 (Security Scan) | `security_scan_${phase}` | After `check_progress_${phase}` (Pattern 0e), before `verify_lint_${phase}` — i.e., between progress gate and verify chain | `class="review"`, `tool_command="cd \${WORKING_DIR} && npm audit --audit-level=high 2>&1 \|\| true"`, `timeout="15m"`, `read_only=true`. Prompt: `"Run security scan on phase changes. Check for known vulnerabilities, secrets in code, injection vectors. Output STATUS: SUCCESS \| FAIL."` Note: security scan is `class="review"` (not `class="codergen"`) because it is a read-only verification step — it runs `npm audit` and reports findings without modifying code. This aligns with the class-based timeout rule (15m for review). *(iter5 — fixed class from "codergen" to "review" to match read_only=true semantics and timeout rule)* |
| 9 (Coverage Gate) | `coverage_check_${phase}` | After test diamond success edge, before scope_check | `class="review"`, `tool_command="cd \${WORKING_DIR} && node --test --experimental-test-coverage 2>&1 \| tail -20"`, `read_only=true`, `timeout="15m"`. Prompt: `"Verify test coverage meets target of ${coverageTarget}%. Output STATUS: SUCCESS \| FAIL."` Edges: success → `scope_check_${phase}`, fail → `fix_${phase}` (retry loop — low coverage triggers code changes to add tests). *(iter5 — added fail path; fixed class from "codergen" to "review" to match read_only=true semantics)* |
| 16b (BDD Scenarios) | `bdd_scenarios_${phase}` | After `spec_file_${phase}` (if present), before `impl_${phase}` — emitted when `PhaseSpec.bddScenarios === true` (explicit opt-in) | `class="review"`, `read_only=true`, prompt generates Given/When/Then scenarios *(review: changed from prompt heuristic to explicit opt-in — heuristic on free-text violated byte-identical determinism requirement)* |
| 17 (Red Team) | `red_team_${phase}` | After phase conformance node, before merge_phases (or before fix_all if no fan-out) — emitted in step 6c per-phase section | `class="review"`, `read_only=true`, `timeout="15m"`. Prompt: `"Attempt to break the implementation: find edge cases, invalid inputs, race conditions, security holes. Focus on ${phase} scope. Output STATUS: SUCCESS (no issues) \| FAIL (issues found)."` Edges: `conformance_${phase} → red_team_${phase}`, success → `merge_phases` (fan-out) or `fix_all` (no fan-out), fail → `fix_${phase}` (retry loop). |
| 18 (Competing Impls) | `competing_${phase}` (component) + 2 impl nodes + merge + select | Replaces single impl node for the phase | `competing_${phase} [shape="component", max_parallel="1"]` → `impl_${phase}_a`, `impl_${phase}_b` (both `class="codergen"`) → `merge_competing_${phase} [shape="tripleoctagon"]` → `select_${phase} [shape="diamond"]`. Diamond edges: `select_${phase} -> check_progress_${phase} [outcome="selected"]` (winner proceeds to verify chain), `select_${phase} -> fix_${phase} [outcome="rejected"]` (loser triggers fix). Fix loop target: `fix_${phase} -> competing_${phase}` (re-runs both competing impls — fix addresses the spec/requirements gap that caused rejection, then both impls re-generate from the improved context). Selection prompt: `"Compare implementations A and B against the phase spec. Select the better one. Output STATUS: SUCCESS (A selected) \| FAIL (B selected)."` *(review: added missing outcome labels and downstream edges; microverse: iter10 — specified fix loop target for competing impls)* |
| 16 (Spec-First TDD) | `spec_file_${phase}` | Before impl node; after phase infrastructure (split_phases if fan-out), before BDD scenarios (16b) | `class="review"`, `read_only="true"`, `timeout="15m"`. Prompt: `"Generate a test specification from the phase prompt. Define expected inputs, outputs, edge cases, and acceptance criteria as executable test cases. Output STATUS: SUCCESS \| FAIL."` Applied by default when `goalGate: true`; opt-out via `specFirst: false`. *(microverse: iter6 #1)* |
| 19 (Review Ratchet) | See review ratchet topology example below | After all phase conformance nodes, before `fix_all`/`verify_final` | See topology example. N passes = N component→merge→diamond groups. `fix_review` is cross-phase codergen. |
| 20 (Microverse) | `commit_baseline_${name}`, `baseline_${name}`, `optimize_${name}`, `measure_${name}`, `compare_${name}`, `check_${name}`, `rollback_${name}` | Self-contained subgraph after all per-phase nodes and before cross-phase nodes (review ratchet / fix_all). Placement in serialization: emitted in step 6c-post, between the last phase's conformance/red_team and step 6d cross-phase nodes. Entry edge: `merge_phases → commit_baseline_${name}` (fan-out) or `conformance_${lastPhase} → commit_baseline_${name}` (no fan-out). Exit edge: when `reviewRatchet` is set, `check_${name} → review_pass_1 [outcome="success"]` (success enters the ratchet chain); when no ratchet, `check_${name} → fix_all [outcome="success"]` (success exits to cross-phase fix/verify chain). *(gap-analysis: specified placement, entry/exit edges; iter5 — fixed exit edge to respect ratchet when both microverse and ratchet are active)* | `commit_baseline [shape="parallelogram", tool_command="cd \${WORKING_DIR} && git add -u && git -c user.name=attractor -c user.email=attractor@local commit -m 'microverse: baseline' --allow-empty 2>&1"]` → `baseline [shape="parallelogram", tool_command="cd \${WORKING_DIR} && ${measureCommand} 2>&1"]` → `optimize [class="codergen", timeout="30m", max_visits=8]` → `measure [shape="parallelogram", tool_command="cd \${WORKING_DIR} && ${measureCommand} 2>&1"]` → `compare [class="review", read_only=true, timeout="15m", auto_status=true, allow_partial=true, max_visits=10]` (`auto_status=true`: attractor auto-injects STATUS extraction from the LLM's comparison output, so no explicit STATUS marker is needed in the prompt; `allow_partial=true`: permits `outcome="partial_success"` as a valid non-terminal outcome — without this, attractor treats anything other than SUCCESS/FAIL as an error) → `check [shape="diamond"]`. Three-way routing: `check → review_pass_1 [outcome="success"]` when `reviewRatchet` is set (target met, enters ratchet), or `check → fix_all [outcome="success"]` when no ratchet (target met, exits to cross-phase chain), `check → optimize [outcome="partial_success"]` (improved but not at target), `check → rollback [outcome="fail"]` (regressed/stalled). `rollback [shape="parallelogram", tool_command="cd \${WORKING_DIR} && git checkout . 2>&1"]` → `optimize`. `max_visits` from `MicroverseOpts.maxVisits` overrides defaults (8 on optimize, 10 on compare) when explicitly set. |

**Pattern 0e (Progress Gate) behavior**: Progress gate uses `git status --porcelain`. Builder always emits this node for every phase — the `git status` command works in any directory (git-initialized or not; in non-git directories, it exits non-zero which triggers STATUS: FAIL, correctly flagging no progress). No BuilderSpec field controls emission; it is unconditional on phases.

**Pattern 4 (Fan-Out) mixed dependency topology** *(microverse: iter3 #4)*: When some phases have `dependsOn` and others do not, the builder partitions phases into: (a) **independent set** — all phases with no `dependsOn` (fan out via `split_phases`/`merge_phases`), (b) **dependent set** — phases with `dependsOn`, serialized after `merge_phases` in dependency order. Example: phases A (no deps), B (no deps), C (dependsOn: ["A"]) produces: `split_phases` → A, B in parallel → `merge_phases` → C. C waits for `merge_phases` even though it only depends on A, because the builder does not support partial fan-in (partial fan-in requires subgraph nesting, which attractor does not parse). If ALL phases have `dependsOn` chains (no independent phases), Pattern 4 is not emitted — phases are serialized with direct edges following the dependency order. Example: phases A (dependsOn: []), B (dependsOn: ["A"]), C (dependsOn: ["B"]) emits edges `impl_a → ... → conformance_a → impl_b → ... → conformance_b → impl_c → ... → conformance_c`, with no `split_phases`/`merge_phases` nodes.

**Review Ratchet topology example** (`.reviewRatchet(3)`):
```dot
// 3-pass ratchet: 3 consecutive clean review passes required
// NOTE: All nodes are top-level (flat) — no DOT subgraph nesting. All attribute values double-quoted per serialization spec.

// Shared fix node for all ratchet failures (cross-phase codergen — attributes per cross-phase inheritance rule)
fix_review [shape="box", class="codergen", timeout="30m", allowed_paths="<union of all phase allowedPaths>", escalate_on="<superset of all phase escalateOn>", permission_mode="auto"]

// Pass 1
review_pass_1 [shape="component", max_parallel="1"]
review_correctness_1 [class="review", read_only="true", timeout="15m"]
review_patterns_1 [class="review", read_only="true", timeout="15m"]
merge_pass_1 [shape="tripleoctagon"]
check_pass_1 [shape="diamond"]

// Pass 2
review_pass_2 [shape="component", max_parallel="1"]
review_correctness_2 [class="review", read_only="true", timeout="15m"]
review_patterns_2 [class="review", read_only="true", timeout="15m"]
merge_pass_2 [shape="tripleoctagon"]
check_pass_2 [shape="diamond"]

// Pass 3
review_pass_3 [shape="component", max_parallel="1"]
review_correctness_3 [class="review", read_only="true", timeout="15m"]
review_patterns_3 [class="review", read_only="true", timeout="15m"]
merge_pass_3 [shape="tripleoctagon"]
check_pass_3 [shape="diamond"]

// Edges: fan-out/fan-in within each pass
review_pass_1 -> review_correctness_1
review_pass_1 -> review_patterns_1
review_correctness_1 -> merge_pass_1
review_patterns_1 -> merge_pass_1
merge_pass_1 -> check_pass_1
check_pass_1 -> review_pass_2 [outcome="clean"]
check_pass_1 -> fix_review [outcome="issues"]
fix_review -> review_pass_1

review_pass_2 -> review_correctness_2
review_pass_2 -> review_patterns_2
review_correctness_2 -> merge_pass_2
review_patterns_2 -> merge_pass_2
merge_pass_2 -> check_pass_2
check_pass_2 -> review_pass_3 [outcome="clean"]
check_pass_2 -> fix_review [outcome="issues"]
// fix_review -> review_pass_1 (reset — same edge as above)

review_pass_3 -> review_correctness_3
review_pass_3 -> review_patterns_3
review_correctness_3 -> merge_pass_3
review_patterns_3 -> merge_pass_3
merge_pass_3 -> check_pass_3
check_pass_3 -> fix_all [outcome="clean"]
check_pass_3 -> fix_review [outcome="issues"]
// fix_review -> review_pass_1 (reset — same edge as above)

// Key: any failure resets to pass_1. max_visits on review nodes prevents infinite loop.
```

## Interface Contracts

### API Contracts

| Endpoint/Function | Input | Output | Error | Contract Test |
|:---|:---|:---|:---|:---|
| `new DotBuilder(slug, goal)` | `string, string` | `DotBuilder` | Throws on empty slug/goal | Unit test |
| `DotBuilder.fromSpec(spec)` | `BuilderSpec` | `DotBuilder` | Throws on invalid spec (missing required fields) | Unit test *(refined: new)* |
| `.phase(name, opts)` | `string, PhaseOpts` | `DotBuilder` (fluent) | Throws on duplicate phase name | Unit test |
| `.microverse(name, opts)` | `string, MicroverseOpts` | `DotBuilder` (fluent) | Throws if target not numeric | Unit test |
| `.reviewRatchet(passes)` | `number` | `DotBuilder` (fluent) | Throws if passes < 2 | Unit test |
| `.acceptanceCriteria(criteria)` | `Record<string, string>` | `DotBuilder` (fluent) | N/A | Unit test |
| `.workspace(opts?)` | `WorkspaceOpts?` | `DotBuilder` (fluent) | N/A | Unit test — calling `.workspace()` enables isolated mode *(council: H8)* |
| `.modelStylesheet(config)` | `StylesheetConfig` | `DotBuilder` (fluent) | N/A | Unit test |
| `.build()` | None | `BuildResult` | Throws `BuildError` with diagnostics | Unit test |
| `validateDot(dotString)` | `string` | `ValidationResult` | Never throws (returns diagnostics) | Integration test |

*(refined: replaced `DotBuilder.create()` with `new DotBuilder()` constructor for programmatic use; added `fromSpec()` static factory for CLI deserialization — deliberate exception to codebase convention since CLI input is always JSON)*

**DotBuilder instances are single-use.** After `.build()`, the instance is consumed. The fix loop must construct a new `DotBuilder` from the corrected spec for each iteration. *(refined: new)*

**`fromSpec()` field mapping and error behavior**: `fromSpec()` is **fail-fast** — it throws on the first validation error encountered. Phase name duplicate detection uses sanitized node IDs (not raw names), throwing `DUPLICATE_PHASE` on the second collision (e.g., phases `"auth scan"` and `"auth-scan"` both sanitize to `auth_scan` — the second `.phase()` call throws). It first runs the runtime validations from the `fromSpec() Runtime Validation` section (required fields, type checks), throwing `INVALID_SPEC` on structural issues. Then it creates a `new DotBuilder(spec.slug, spec.goal)` and internally calls the corresponding fluent methods for each populated BuilderSpec field: `.phase()` for each entry in `phases`, `.reviewRatchet()` for `reviewRatchet`, `.microverse()` for `microverse`, `.workspace()` for `workspace`/`workspaceOpts`, `.modelStylesheet()` for `modelStylesheet`, and `.acceptanceCriteria()` for `acceptanceCriteria`. Graph-level config fields (`workingDir`, `label`, `defaultMaxRetry`, `specFile`) are set via internal property assignment on the builder instance — these do not have public fluent methods since they are simple scalar values with no validation beyond type checking. Per-phase `threadId` overrides are passed through to the phase's nodes — if `PhaseSpec.threadId` is set, it takes precedence over auto-assignment; if omitted, auto-assigned as `"phase_${N}"`. *(microverse: iter4 #7)* *(council review: makes implicit mapping explicit; post-review: added 4 missing graph-level fields)*

**`.build()` return-vs-throw contract** *(council review: C4)*: `.build()` returns `BuildResult` when all diagnostics have `severity: 'warning'` or `severity: 'info'`. It throws `BuildError` when ANY diagnostic has `severity: 'error'`. The `BuildError.diagnostics` array contains ALL diagnostics (errors + warnings + infos). On success, `BuildResult.diagnostics` contains only warnings and infos. The fix loop triggers on `BuildError` catch, not on `BuildResult` inspection.

**`BuildError.code` selection when multiple rules fail** *(microverse: iter6)*: Rules 1–15 are evaluated sequentially by rule number on the complete graph. Each rule examines all relevant nodes/edges before moving to the next rule. The first rule (by number) that produces an error-severity diagnostic sets `BuildError.code`. The `BuildError.diagnostics` array contains ALL diagnostics regardless of which code is selected. The LLM fix loop should iterate `diagnostics`, not rely on `.code` alone — `.code` is a convenience for programmatic callers that need a single error category.

### CLI Stdin Contract *(refined: new section)*

The CLI at `bin/dot-builder.ts` reads JSON from stdin using synchronous `fs.readFileSync(0, 'utf8')`, matching the `log-commit.ts` pattern. Input size guard: 512KB.

**Exit codes:**
- `0`: success — `BuildResult` JSON on stdout
- `1`: build error — `BuildError` JSON on stderr (recoverable, LLM can fix)
- `2`: unexpected error — plain error JSON on stderr (not recoverable)

**Error output format (stderr):**

Exit 1 (recoverable `BuildError`):
```json
{ "error": "<BuildErrorCode>", "message": "...", "diagnostics": [...] }
```
Where `error` is the specific `BuildErrorCode` (e.g., `"MISSING_AC_MAPPING"`, `"INVALID_SPEC"`). The LLM uses this code to determine the fix strategy.

Exit 2 (non-recoverable — e.g., unparseable stdin, runtime crash, input too large):
```json
{ "error": "<ErrorString>", "message": "..." }
```
Where `error` is a descriptive string: `"UNEXPECTED_ERROR"` for unknown failures (runtime crash, unparseable JSON), `"INPUT_TOO_LARGE"` for stdin exceeding 512KB. No `diagnostics` field on exit 2 — the error is not structured enough to fix programmatically. Note: unparseable JSON (not valid JSON at all) triggers exit 2, NOT `INVALID_SPEC`. `INVALID_SPEC` (exit 1) is for valid JSON that fails schema validation (missing required fields, wrong types).

### Type Contracts

```typescript
// CLI input type — the LLM constructs this JSON
// (refined: new — primary LLM-facing contract)
interface BuilderSpec {
  slug: string;
  goal: string;
  phases: PhaseSpec[];
  acceptanceCriteria: Record<string, string>;
  workingDir?: string;          // default: "${WORKING_DIR}" (attractor resolves at runtime)
  label?: string;               // graph label; default: goal value
  defaultMaxRetry?: number;     // graph-level default_max_retry; default: 3
  workspace?: 'isolated';       // omit for shared (default) workspace *(council: H8 — removed 'shared' value)*
  workspaceOpts?: WorkspaceOpts;
  microverse?: { name: string; opts: MicroverseOpts };
  reviewRatchet?: number;       // min 2
  modelStylesheet?: StylesheetConfig;
  specFile?: string;            // path to PRD/spec — emitted as graph-level `spec_file` attribute for attractor metadata. Distinct from Pattern 16's per-phase `spec_file_${phase}` review nodes, which generate test specifications from each phase's `prompt` content. *(microverse: iter3 #9)*
}

// Phase specification (used in BuilderSpec.phases)
interface PhaseSpec {
  name: string;
  prompt: string;
  allowedPaths: string[];
  dependsOn?: string[];           // Phase names this phase depends on; omit for independent phases *(council: C5 — fan-out inference)*
  contextOnSuccess?: Record<string, string>;  // Explicit AC key→value mappings set on this phase's verify node *(council: C6 — replaces post-hoc scanning)*
  escalateOn?: string[];          // default: ["package.json","*.lock","*.config.*"]
  specFirst?: boolean;            // Pattern 16: default true when goalGate is true, false otherwise. Explicitly setting specFirst works independently of goalGate — `specFirst: true` on a non-goal-gated phase enables spec-first (opt-in), `specFirst: false` on a goal-gated phase disables it (opt-out).
  goalGate?: boolean;             // Pattern 2: default false
  retryTarget?: string;           // Node ID for goal gate retry; default: "fix_${phase_name}". Setting retryTarget without goalGate is silently ignored (no error, no effect).
  timeout?: string;               // Duration string, default "30m"
  threadId?: string;              // Auto: "phase_${N}" where N is the phase's 1-based position in BuilderSpec.phases array (declaration order). Only applies to per-phase nodes; cross-phase nodes (fix_all, fix_review, verify_final, start, exit, setup_deps, capture_baseline, split_phases, merge_phases) have no thread_id — they run in attractor's default thread context. *(microverse: iter3 #2, #8)*
  securityScan?: boolean;         // Pattern 8: default false
  coverageTarget?: number;        // Pattern 9: e.g., 80
  competing?: boolean;            // Pattern 18: default false
  redTeam?: boolean;              // Pattern 17: default false
  bddScenarios?: boolean;         // Pattern 16b: explicit opt-in (default false); set true to generate Given/When/Then scenarios *(review: changed from auto-detect heuristic to explicit opt-in for determinism)*
  docOnly?: boolean;              // When true, suppress verify chain (Patterns 0d, 1, 13, 14): no verify_lint, verify_types, test diamond, or fix nodes emitted for this phase. Route: impl → check_progress → scope_check → conformance. Failure at check_progress or scope_check routes to cross-phase fix_all (no per-phase fix node exists). check_progress still fires (git status detects markdown changes). Default: false. *(audit: new — enables doc-only phases that produce non-compilable output like markdown)*
}
// (refined: added competing, redTeam, bddScenarios, dependsOn, contextOnSuccess, retryTarget; audit: added docOnly)

interface MicroverseOpts {
  prompt: string;
  measureCommand: string;    // Must output single number on last stdout line
  target: number;
  direction: 'reduce' | 'improve';
  allowedPaths: string[];
  timeout?: string;           // default "30m"
  maxVisits?: number;         // default: 8 on optimize nodes, 10 on compare nodes. When explicitly set, the user's value overrides both defaults and applies uniformly to all microverse loop nodes (optimize, measure, compare, check). Builder accepts any positive integer ≥1. No minimum enforced beyond positivity.
}
// (refined: added maxVisits — Pattern 20 specifies defaults)

interface WorkspaceOpts {
  repoUrl?: string;
  repoBranch?: string;
  cleanup?: 'delete' | 'preserve';  // default: 'delete' when omitted
}
// (refined: removed 'archive' — not documented in patterns or attractor)

interface StylesheetConfig {
  defaultModel: string;
  defaultProvider?: string;
  criticalModel?: string;
  criticalProvider?: string;
  reviewModel?: string;
  reviewProvider?: string;
  reasoningEffort?: string;   // e.g., "high" for critical tier
}
// (refined: added reasoningEffort — Pattern 20 critical tier)

// Build output
interface BuildResult {
  dot: string;                  // Valid DOT string
  slug: string;
  patternsApplied: string[];    // e.g., ["0a", "0b", "0c", "0d", "0e", "1", "2", "3", "4", "6", "6b", "10", "13", "14", "15", "16", "21", "22", "23", "25"] (example for a 2-phase spec with no dependsOn, goalGate on both phases — conditional patterns like 0b, 4, 25 only appear when their preconditions are met per line 221; default-on patterns like 16 appear when they produce output; opt-in patterns like "2" appear when explicitly invoked via PhaseSpec fields like goalGate)
  defenseMatrix: DefenseMatrix;
  diagnostics: Diagnostic[];    // Internal validation results (errors, warnings, infos)
}
// (refined: replaced warnings:string[] with diagnostics:Diagnostic[] — unified type)

interface DefenseMatrix {
  competitive: boolean;
  guardrails: string[];       // e.g., ["max_visits", "no-op", "read_only"]
  specDriven: string;         // Computed from active patterns: "NONE" (zero-phase) | "conformance" (phases exist, no specFirst/BDD) | "BDD + conformance" (BDD opt-in, no specFirst) | "spec_file + conformance" (specFirst active, no BDD) | "spec_file + BDD + conformance" (both active)
  permissions: string[];      // e.g., ["allowed_paths", "escalate_on"]
  adversarial: boolean;
}
// (refined: guardrails and permissions as string[] for programmatic use)

// Unified diagnostic type (used in BuildError, BuildResult, ValidationResult)
// (refined: unified DiagnosticOutput → Diagnostic — three-analyst consensus)
interface Diagnostic {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  nodeId?: string;
  edge?: [string, string];
  fix?: string;
}

// Validation result (from external attractor validate or internal validation)
// (council: H6 — unified to flat diagnostics array, matching BuildResult; callers filter by severity)
interface ValidationResult {
  valid: boolean;
  diagnostics: Diagnostic[];   // flat array; filter by severity field
}

// Build error codes — typed union matching StateErrorCode convention
type BuildErrorCode = 'EMPTY_SLUG' | 'EMPTY_GOAL' | 'DUPLICATE_PHASE' | 'INVALID_RATCHET'
  | 'NON_NUMERIC_TARGET' | 'ALREADY_BUILT' | 'INVALID_STRUCTURE' | 'START_HAS_INCOMING'
  | 'UNREACHABLE_NODE' | 'DIAMOND_MISSING_EDGES' | 'GOAL_GATE_NO_MAX_VISITS'
  | 'MISSING_AC_MAPPING' | 'MISSING_TIMEOUT' | 'PROMPT_PATH_MISMATCH'
  | 'REVIEW_MISSING_READONLY' | 'COMPONENT_NO_MERGE' | 'FAN_OUT_SCOPE_LEAK'
  | 'WORKSPACE_NO_HTTPS' | 'WORKSPACE_NO_PUSH' | 'PLAN_MODE_DEADLOCK'
  | 'MISSING_ALLOWED_PATHS' | 'INVALID_SPEC'
  | 'INVALID_TIMEOUT' | 'INVALID_ALLOWED_PATHS';

// Build error (matches StateError constructor pattern from types/index.ts)
class BuildError extends Error {
  code: BuildErrorCode;
  diagnostics: Diagnostic[];

  constructor(code: BuildErrorCode, message: string, diagnostics: Diagnostic[] = []) {
    super(message);
    this.name = 'BuildError';
    this.code = code;
    this.diagnostics = diagnostics;
  }
}
// (refined: added code field as typed union matching StateErrorCode pattern, changed diagnostics from string[] to Diagnostic[])
// (review: added explicit constructor signature — without it, diagnostics has no definite assignment)
```

### BuildError Code Reference

| Code | Trigger | Validation Rule |
|:---|:---|:---|
| `EMPTY_SLUG` | `slug` is empty string | Constructor |
| `EMPTY_GOAL` | `goal` is empty string | Constructor |
| `DUPLICATE_PHASE` | Two phases share the same **sanitized** node ID (not raw name — `"auth scan"` and `"auth-scan"` both sanitize to `auth_scan` and collide) | `.phase()` *(review: clarified detection uses sanitized ID)* |
| `INVALID_RATCHET` | `reviewRatchet < 2` | `.reviewRatchet()` |
| `NON_NUMERIC_TARGET` | `MicroverseOpts.target` is not a number, or `target < 0`, or (`target === 0` AND `direction === 'improve'`) | `.microverse()` — note: `target=0` is valid for `direction='reduce'` *(council: H9)* |
| `ALREADY_BUILT` | `.build()` called twice on same instance | `.build()` |
| `INVALID_STRUCTURE` | Start/exit count ≠ 1 | Rule 1: single start/exit |
| `START_HAS_INCOMING` | Start node has incoming edges | Rule 2: no incoming→start |
| `UNREACHABLE_NODE` | Node not reachable from start | Rule 3: reachability |
| `DIAMOND_MISSING_EDGES` | Diamond node has <2 outgoing edges | Rule 4: diamond branching |
| `GOAL_GATE_NO_MAX_VISITS` | `goal_gate=true` node lacks `max_visits` | Rule 5: goal_gate→max_visits |
| `MISSING_AC_MAPPING` | AC key has no `context_on_success` source | Rule 6: AC mapping |
| `MISSING_TIMEOUT` | Codergen node lacks `timeout` attribute | Rule 7: timeout presence |
| `PROMPT_PATH_MISMATCH` | Prompt references paths outside `allowed_paths` | Rule 8: prompt↔allowed_paths |
| `REVIEW_MISSING_READONLY` | Review node lacks `read_only=true` or STATUS marker | Rule 9: read_only+STATUS |
| `COMPONENT_NO_MERGE` | `component` node has no matching `tripleoctagon` | Rule 10: component↔tripleoctagon |
| `FAN_OUT_SCOPE_LEAK` | `retry_target` escapes component scope | Rule 11: fan_out_scope |
| `WORKSPACE_NO_HTTPS` | `workspace="isolated"` with `repoUrl` present AND not starting with `https://`. If `repoUrl` is absent/undefined, Rule 12 does NOT fire — absent means the workspace uses the current working directory (no clone needed). When `workspace='isolated'` but `repoUrl` is omitted, the `workspace` attribute is emitted in the graph but `repo_url` is omitted entirely. | Rule 12: workspace_config |
| `WORKSPACE_NO_PUSH` | `workspace="isolated"` without `commit_and_push` node | Rule 13: workspace_push |
| `PLAN_MODE_DEADLOCK` | `permission_mode="plan"` in headless pipeline (a headless pipeline is one executed by attractor without an interactive user session — e.g., CI/CD, batch mode, tmux-runner — where no human is available to approve plan-mode permission prompts) | Rule 14: permission_mode_plan |
| `MISSING_ALLOWED_PATHS` | Per-phase codergen **impl** node (e.g., `impl_${phase}`, `fix_${phase}`) lacks `allowed_paths`. Does NOT apply to: (a) `class="review"` nodes (`security_scan_${phase}`, `coverage_check_${phase}`, etc.) — these are read-only verification steps that inherit phase `allowed_paths` for context but do not modify code, so missing paths is non-blocking; (b) cross-phase codergen nodes (`fix_all`, `verify_final`) — those derive `allowed_paths` from the union of all phase paths and get `severity: 'warning'` if the union is empty. | Rule 15: allowed_paths_required *(review: scoped to per-phase impl nodes; microverse: iter3 — clarified non-impl and cross-phase exclusions)* |
| `INVALID_SPEC` | `fromSpec()` receives valid JSON that fails schema validation: not an object, missing `phases` array, wrong field types. For field-level validation, `fromSpec()` reuses constructor-level codes: `EMPTY_SLUG`, `EMPTY_GOAL`, `DUPLICATE_PHASE`, etc. `INVALID_SPEC` is for structurally valid JSON with schema violations — NOT for unparseable input (which triggers exit 2 before `fromSpec()` is called). *(council: H7; post-review: clarified JSON parse vs schema validation boundary)* | `fromSpec()` |
| `INVALID_TIMEOUT` | `timeout` value doesn't match `\d+(ms\|s\|m\|h)` or is zero duration | `fromSpec()` per-phase validation *(microverse: iter4 #6)* |
| `INVALID_ALLOWED_PATHS` | `allowedPaths` entry is an absolute path (starts with `/`) | `fromSpec()` per-phase validation *(microverse: iter4 #6)* |

### Acceptance Criteria Mapping Algorithm *(council review: C6 — replaced post-hoc scanning with explicit mapping)*

The builder resolves `context_on_success` sources using a two-tier approach:

```
Tier 1: Explicit mapping via PhaseSpec.contextOnSuccess
  For each phase P with contextOnSuccess defined:
    For each key K in P.contextOnSuccess:
      - Tag the phase's `conformance_${phase}` node with context_on_success containing K=V
        (conformance is the last review node in the phase pipeline — after scope_check, before cross-phase nodes)

Tier 2: Auto-generated standard keys on verify_final
  The builder always generates these standard AC key mappings on verify_final:
    - "types_compile=true" (from tsc --noEmit in verify_final tool_command)
    - "lint_clean=true" (from eslint in verify_final tool_command)
    - "tests_pass=true" (from npm test in verify_final tool_command)
    - "cli_contract=true" (from npm test — CLI contract tests run as part of the test suite)
    - "determinism=true" (from npm test — determinism snapshot tests run as part of the test suite)
    - "validation_rules=true" (from npm test — validation rule tests run as part of the test suite)
  These 6 keys map to the 3 commands in verify_final's tool_command. The last 3 are logically distinct AC dimensions but are all validated by the test suite. Generated at node-creation time, not detected post-hoc. If a user-specified Tier 1 contextOnSuccess key matches a Tier 2 auto-generated key, the user's value takes precedence (Tier 1 wins). No warning emitted.

Validation (runs during .build()):
  For each key K in BuilderSpec.acceptanceCriteria:
    1. Collect all nodes with context_on_success containing K
    2. If exactly 1 node sets K → mapping valid
    3. If 0 nodes set K → emit Diagnostic { rule: 'acceptance_criteria_sources', severity: 'error', message: 'AC key "${K}" has no context_on_success source. Add contextOnSuccess to a PhaseSpec.' }
    4. If >1 node sets K → emit Diagnostic { severity: 'warning', message: 'AC key "${K}" set by multiple nodes: [${nodeIds}]' } (build succeeds — this is a warning, not an error; distinct from case 3 where 0 nodes set K which is an error)
  For each key K set by any contextOnSuccess but NOT in acceptanceCriteria:
    - Emit Diagnostic { severity: 'warning', message: 'Orphaned context key "${K}" not in acceptanceCriteria' }
```

### Acceptance Criteria String Formatting *(microverse: iter7 — unspecified algorithm violated determinism)*

The graph-level `acceptance_criteria` attribute is formatted from `BuilderSpec.acceptanceCriteria: Record<string, string>` using a deterministic algorithm:

```
1. Collect all keys from BuilderSpec.acceptanceCriteria
2. Sort keys alphabetically (locale-independent, case-sensitive — same as Object.keys() on a sorted insertion)
3. For each key K with value V: format as "context.${K}=${V}"
4. Join all formatted entries with " && " (space-ampersand-ampersand-space)
5. If acceptanceCriteria is empty ({}): emit `acceptance_criteria=""` (empty quoted string — attribute is present with empty value, not omitted, because attractor checks for attribute presence)
```

Example: `{ lint_clean: "true", tests_pass: "true", types_compile: "true" }` → `"context.lint_clean=true && context.tests_pass=true && context.types_compile=true"`

The `context.` prefix is required — attractor resolves AC keys from the `context_on_success` namespace. Alphabetical ordering satisfies the byte-identical determinism requirement (P1).

### `context_on_success` Attribute Formatting *(microverse: gap-analysis — unspecified format violated determinism)*

Per-node `context_on_success` attributes are formatted from `PhaseSpec.contextOnSuccess: Record<string, string>` (Tier 1) or auto-generated keys (Tier 2) using a deterministic algorithm:

```
1. Collect all key=value pairs assigned to this node (Tier 1 explicit + Tier 2 auto-generated)
2. Sort keys alphabetically (locale-independent, case-sensitive — same sort as acceptance_criteria)
3. For each key K with value V: format as "${K}=${V}" (NO "context." prefix — the prefix is only on acceptance_criteria; context_on_success keys are bare names that attractor maps into the context namespace)
4. Join all formatted entries with "," (comma, no spaces)
5. If a node has no context_on_success keys: omit the attribute entirely (do not emit empty string)
```

Example: `{ lint_clean: "true", tests_pass: "true", types_compile: "true" }` → `context_on_success="lint_clean=true,tests_pass=true,types_compile=true"`

Alphabetical ordering satisfies the byte-identical determinism requirement (P1). Comma separator (no spaces) matches attractor's parser expectation.

### `model_stylesheet` Attribute Formatting *(microverse: iter4 — unspecified format violated determinism)*

The graph-level `model_stylesheet` attribute is formatted from `StylesheetConfig` using a deterministic algorithm:

```
1. Build tier blocks in fixed order: .default, .critical, .review
2. For each tier:
   a. .default → uses `defaultModel` (required) + `defaultProvider` (optional)
   b. .critical → uses `criticalModel` + `criticalProvider` (optional) + `reasoningEffort` (optional). Omit entire block if `criticalModel` is undefined.
   c. .review → uses `reviewModel` + `reviewProvider` (optional). Omit entire block if `reviewModel` is undefined.
3. Within each tier block, emit properties in fixed order:
   - llm_model (always present in the block)
   - llm_provider (if defined for this tier)
   - reasoning_effort (only in .critical block, if defined)
4. Format each block as: `.${tier} { ${properties} }`
   - Properties formatted as: `${key}: ${value}`
   - Multiple properties separated by "; " (semicolon-space)
5. Join all non-empty tier blocks with " " (single space)
6. If only defaultModel is set (no other tiers): emit single block `.default { llm_model: ${defaultModel} }`
```

Example: `{ defaultModel: "claude-sonnet-4-6", defaultProvider: "anthropic", criticalModel: "claude-opus-4-6", criticalProvider: "anthropic", reasoningEffort: "high", reviewModel: "claude-sonnet-4-6" }` → `model_stylesheet=".default { llm_model: claude-sonnet-4-6; llm_provider: anthropic } .critical { llm_model: claude-opus-4-6; llm_provider: anthropic; reasoning_effort: high } .review { llm_model: claude-sonnet-4-6 }"`

Fixed tier ordering and fixed property ordering within tiers satisfies the byte-identical determinism requirement (P1).

### DOT String Escaping

All string attributes in generated DOT MUST be escaped:

```
Escaping rules (applied to all attribute values):
  1. Replace \ with \\
  2. Replace " with \"
  3. Replace newlines (\n) with \n (literal backslash-n)
  4. Replace carriage returns (\r) with \r
  5. Wrap all attribute values in double quotes
```

Node IDs use only `[a-zA-Z_][a-zA-Z0-9_]*`. Phase names and slugs are sanitized with: replace all non-alphanumeric characters with `_` (regex: `/[^a-zA-Z0-9]/g` → `'_'`), then collapse consecutive `_` to single `_` (regex: `/_{2,}/g` → `'_'`), then strip leading/trailing `_`.

### DOT Serialization Algorithm *(council review: C1+C2 — unspecified serialization and subgraph ambiguity)*

The builder emits DOT using **flat node declarations with shape markers** — NOT DOT `subgraph cluster_X {}` blocks. Attractor does not parse DOT subgraph nesting; it uses `shape=component` and `shape=tripleoctagon` as structural markers for fan-out/fan-in boundaries. All nodes are top-level within the single `digraph`.

**Emission order** (deterministic, satisfies byte-identical requirement):

```
1. Opening: `digraph "${sanitized_slug}" {`
2. Graph-level attributes (alphabetical by key):
   - acceptance_criteria, default_max_retry, goal, label,
     model_stylesheet, repo_branch (workspace only), repo_url (workspace only),
     retry_target, spec_file, workspace (workspace only), workspace_cleanup (workspace only), working_dir
3. Blank line
4. Defense matrix comment block: `/* DEFENSE MATRIX ... */`
5. Blank line
6. Nodes in declaration order (forward-reference safe — DOT allows referencing nodes before declaration, so edges in section 8 define the actual pipeline flow; declaration order is chosen for readability and determinism, not strict topological sort):
   a. start node (Mdiamond)
   b. setup_deps, capture_baseline (auto infrastructure)
   c. Per-phase nodes in phase declaration order:
      - split_phases (if fan-out)
      - spec_file_${phase} (Pattern 16, when specFirst is active — before impl, after split_phases)
      - bdd_scenarios_${phase} (Pattern 16b, when active — after spec_file, before impl)
      - **Standard phases** (`docOnly` absent or false): impl node → check_progress → security_scan (if opt-in, Pattern 8) → verify_lint → verify_types → test → diamond → fix (fail) / coverage_check (success, if opt-in, Pattern 9) / scope_check (success, if no coverage gate — default path)
      - **Doc-only phases** (`docOnly: true`): impl node → check_progress → scope_check → conformance. No verify_lint, verify_types, test diamond, fix, or coverage_check nodes. Patterns 0d, 1, 13, 14 suppressed. check_progress (Pattern 0e) and scope_check (Pattern 10) still fire. Failure routing: check_progress STATUS: FAIL and scope_check STATUS: FAIL route to cross-phase `fix_all` (no per-phase fix node exists for doc-only phases). *(audit: new — doc-only phase serialization variant)*
      - [coverage_check success →] scope_check → review/conformance nodes → red_team_${phase} (Pattern 17, if opt-in)
      - merge_phases
   c-post. Microverse nodes (when `BuilderSpec.microverse` is set, Pattern 20): commit_baseline_${name}, baseline_${name}, optimize_${name}, measure_${name}, compare_${name}, check_${name}, rollback_${name}. Emitted after the last phase's per-phase nodes (or after merge_phases if fan-out) and before cross-phase nodes. *(gap-analysis: new — microverse was missing from serialization order)*
   d. Cross-phase nodes: review ratchet passes first (when `reviewRatchet ≥ 2` — each pass: component → inner review nodes → merge → check diamond, preceded by fix_review declaration), then fix_all (always). If `reviewRatchet` is not set, step 6d emits only fix_all. Pipeline flow: last phase conformance → [microverse if set] → ratchet passes → fix_all → verify_final. *(review: fix_review emission was unconditional but only exists when reviewRatchet is active; microverse: red_team moved from step 6d2 to step 6c; iter7 — reordered ratchet before fix_all to match pipeline flow; gap-analysis — added microverse to flow)*
   e. verify_final
   e-post. commit_and_push (when `workspace='isolated'`, Pattern 0 — between verify_final and exit)
   f. exit node (Msquare)
7. Blank line
8. Edges in source-node pipeline order (same order as nodes above):
   - Each edge: `  ${source} -> ${target}` + optional ` [attr=val, ...]`
   - **Edge deduplication**: Edges are deduplicated before emission. Two edges are identical if `(source, target, attributes)` tuple is equal. Only the first occurrence is emitted. This is required for review ratchet where `fix_review → review_pass_1` is referenced by multiple passes but must appear once. *(review: new — required for byte-identical determinism)*
9. Closing: `}`
```

**Attribute formatting rules:**
- All attribute values are double-quoted: `timeout="30m"`, `shape="Mdiamond"`
- Shape values are also quoted (unlike some hand-written DOT): `shape="diamond"` not `shape=diamond`
- Multiple attributes comma-separated inside brackets, **alphabetical by key**: `[class="codergen", shape="box", timeout="30m"]` *(microverse: iter4 #4 — required for byte-identical determinism)*
- Node declarations: `  ${nodeId} [${attributes}]` (2-space indent)
- Edge declarations: `  ${source} -> ${target}` or `  ${source} -> ${target} [${attributes}]` (2-space indent). Edge attributes follow the same **alphabetical by key** rule as node attributes for byte-identical determinism.
- Graph attributes: `  ${key}="${escaped_value}"` (2-space indent)
- Section comments: `// ========== PHASE ${N}: ${phase_name} ==========` before each phase's nodes
- Blank lines between: graph attributes, defense matrix, node sections, edge section

**Fan-out structure** (flat nodes, no DOT subgraphs):
```dot
  // Pattern 4: fan-out for independent phases
  split_phases [shape="component", max_parallel="1"]
  // ... phase 1 nodes ...
  // ... phase 2 nodes ...
  merge_phases [shape="tripleoctagon"]
  // Edges (when specFirst is NOT active — when active, split_phases → spec_file_${phase} → impl_${phase}):
  split_phases -> impl_auth
  split_phases -> impl_api
  // ... per-phase edge chains (impl → check_progress → verify_lint → verify_types → test → ... → conformance) ...
  conformance_auth -> merge_phases
  conformance_api -> merge_phases
```

### `fromSpec()` Runtime Validation

`fromSpec()` performs runtime JSON schema validation beyond TypeScript type checking:
- Required fields present: `slug`, `goal`, `phases`, `acceptanceCriteria`
- `slug` and `goal` are non-empty strings
- `phases` is an array (empty for start→exit pipeline, non-empty for all others)
- Each phase has `name`, `prompt`, `allowedPaths` (all must be present/defined; `allowedPaths` must be an array but may be empty — empty arrays pass `fromSpec()` and produce a warning diagnostic at `.build()` time) *(microverse: iter4 #3)*
- `workspaceOpts` present (non-undefined) without `workspace: 'isolated'` emits warning diagnostic and is ignored — workspace options (`repoUrl`, `repoBranch`, `cleanup`) have no effect unless `workspace` field is `'isolated'` *(microverse: iter7 — unspecified edge case)*
- `StylesheetConfig` partial tier override: `criticalProvider` without `criticalModel` (or `reviewProvider` without `reviewModel`) emits warning diagnostic and ignores the orphaned provider — a tier block requires at minimum a model to emit; provider-only is meaningless *(microverse: iter10 — unspecified partial config)*
- `docOnly: true` with `goalGate: true` emits warning diagnostic — goal gates on doc-only phases have no test diamond to gate; the goal gate attribute is still emitted but has no effect since there's no retry loop *(audit: new — edge case)*
- `docOnly: true` with `coverageTarget` set emits warning diagnostic and ignores coverageTarget — no test runner to measure coverage *(audit: new)*
- Unknown top-level fields emit warning diagnostic (not error — forward compatibility)
- Unknown `PhaseSpec` fields emit warning diagnostic

### State Transitions

N/A — the builder is stateless (functional construction → output). No persistent state changes.

## Fix Loop Specification *(refined: new section)*

**Semantics**: The initial builder invocation is attempt 0 (not counted as a fix attempt). Each subsequent invocation after a validation failure is a fix attempt. Max 3 fix attempts = max 4 total builder invocations.

**Scope**: The fix loop acts on `Diagnostic` entries with `severity: 'error'` only. Warnings are displayed to the user after save but do not trigger fix attempts. *(refined: clarifies warning handling)*

**Per-iteration tracking**: Record error count after each validation. If error count increases between iterations, revert to the prior best BuilderSpec and attempt a *different* fix strategy — do NOT re-submit the reverted spec unchanged (determinism guarantee means identical input produces identical output, wasting an attempt). This revert-and-retry counts as 1 used iteration. *(refined: prevents oscillation; council: H5 — clarifies revert-then-what)*

**LLM state tracking**: The fix loop is executed by the LLM within the `/pickle-dot` command prompt — not by programmatic code. The updated `/pickle-dot` prompt MUST include explicit instructions for the LLM to:
1. After each builder invocation, count the number of `severity: 'error'` diagnostics in the response
2. Maintain a mental log: `Attempt 0: N errors, Attempt 1: M errors, ...`
3. If error count increases vs. the best prior attempt, revert to the best prior BuilderSpec and attempt a *different* fix strategy (per the revert-and-retry rule above — this counts as 1 used iteration)
4. Track which BuilderSpec JSON produced the fewest errors (the "best attempt")
5. After 3 fix attempts with errors remaining, save the best attempt as `.dot.draft`

This is realistic because: (a) the LLM maintains conversation context across the 4 invocations within a single `/pickle-dot` session, (b) the builder returns structured JSON diagnostics that are easy to count, (c) the LLM can hold and modify the BuilderSpec JSON between attempts. *(refined: new — addresses LLM state tracking feasibility)*

**On builder crash (exit code 2 — non-recoverable)**:
1. Do NOT count as a fix attempt (builder itself failed, not the spec)
2. If a prior successful BuildResult exists, save it as `${SLUG}.dot.draft`
3. Display the crash error message from stderr
4. Print: "Builder crashed (exit 2). Prior best attempt saved to ${SLUG}.dot.draft. Use --legacy to bypass builder."
5. Do NOT retry — exit code 2 indicates a bug in the builder, not a fixable spec issue

**On exhaustion (all iterations used, errors remain)**:
1. Save the attempt with fewest errors as `${SLUG}.dot.draft`
2. Display all remaining diagnostics with severity and suggested fixes
3. Print: "Auto-fix exhausted after 3 attempts. Best attempt saved to ${SLUG}.dot.draft (M remaining errors)."
4. Exit with non-zero status

**On success at any iteration**:
1. Save as `${SLUG}.dot`
2. Delete any prior `.dot.draft` for this slug
3. Display defense matrix, pattern checklist, and any warnings

## ESLint Compliance *(refined: new section — codebase analyst finding)*

The builder MUST pass `npx eslint src/ --max-warnings=-1`. Key constraints from `eslint-plugin-pickle`:

| Rule | Constraint | Applies To |
|:---|:---|:---|
| `pickle/no-process-exit-in-library` | No `process.exit()` in `services/` files — throw errors instead | `services/dot-builder.ts` |
| `pickle/cli-guard-basename` | CLI guard must use `path.basename(process.argv[1]) === 'dot-builder.js'` | `bin/dot-builder.ts` |
| `pickle/no-unsafe-error-cast` | Catch blocks must guard `err instanceof Error` before accessing `.message/.code` | All files |
| `pickle/no-hardcoded-timeout` | No `setTimeout` with literal values > 5000ms — use config | All files |
| `pickle/no-sync-in-async` | No sync I/O (`readFileSync`) inside async functions | `bin/dot-builder.ts` — `main()` MUST be synchronous (`main(): void`, not `async main()`) to use `fs.readFileSync(0, 'utf8')` without triggering this rule *(council review: matches `log-commit.ts` pattern)* |

## External Dependency Readiness *(refined: new section)*

| Dependency | Owner | Status | Fallback | Requirements Affected |
|:---|:---|:---|:---|:---|
| `attractor validate --format json` | Separate PRD (attractor) | Not started | Builder internal validation (15 rules) | P1 external validation |
| `schema.json` export | Separate PRD (attractor) | Not started | Hand-maintained `attractor-schema.fallback.ts` in `extension/src/types/` | P1 schema sync, CUJ-4 |

**Ship decision by dependency state:**
- Both available → Full scope, all requirements deliverable
- Validate unavailable → Ship with internal validation only. Auto-fix loop limited to builder-detectable errors (~15 rules). CUJ-1/2 use internal validation.
- Both unavailable → Ship as pattern-enforcement + internal-validation tool (still valuable for P0 rows 1-7). Builder uses fallback schema for attribute validation.

## Deployment Integration Checklist *(refined: new section — codebase analyst finding)*

1. Add builder types (BuilderSpec, BuildResult, BuildError, Diagnostic, etc.) to `extension/src/types/index.ts` — codebase convention: all types in single file, no separate type modules
2. Create `extension/src/services/dot-builder.ts` (service — no `process.exit()`, throws errors instead per `pickle/no-process-exit-in-library`)
3. Create `extension/src/bin/dot-builder.ts` (CLI — CLI guard with `path.basename(process.argv[1]) === 'dot-builder.js'`, stdin JSON via `fs.readFileSync(0, 'utf8')`, stdout JSON for BuildResult, stderr JSON for errors). Note: JSON-on-stdout is a deliberate break from codebase convention (existing CLIs use plaintext); justified because this CLI is programmatically consumed by the LLM, not human-read
4. Add test files to `package.json` test script explicit file list — no glob discovery. Use `node:test` + `node:assert/strict` (codebase standard). Split into 4 files *(council: H10)*:
   - `tests/dot-builder.test.js` — core API (constructor, phase, build, fromSpec, edge cases)
   - `tests/dot-builder-patterns.test.js` — 28 pattern snapshot tests
   - `tests/dot-builder-validation.test.js` — 15 validation rule tests
   - `tests/dot-builder-cli.test.js` — CLI contract tests (stdin/stdout/stderr, exit codes)
5. Add `chmod +x "$EXTENSION_ROOT/extension/bin/dot-builder.js"` to `install.sh` permissions section
6. If `sync-schema` CLI: add `bin/sync-schema.ts`, `install.sh` chmod, and add `"sync-schema": "node bin/sync-schema.js"` to the `scripts` section in `package.json` (CUJ-4 depends on `npm run sync-schema` being a valid invocation)
7. Import paths must use `.js` extensions: `import { DotBuilder } from '../services/dot-builder.js'` (per `moduleResolution: NodeNext`)
8. Zero runtime dependencies — builder uses Node.js built-ins only
9. Run full gate: `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test`
10. Note: the fluent builder pattern (`.phase().phase().reviewRatchet().build()`) is new to this codebase — existing services use constructors + discrete methods (StateManager) or exported functions (git-utils). Document in code comments why fluent chaining was chosen (single-use construction semantics)

## Verification Strategy

- **Type**: `npx tsc --noEmit` passes with no new errors
- **Lint**: `npx eslint src/ --max-warnings=-1` passes (including custom `eslint-plugin-pickle` rules)
- **Test**: `npm test` — all existing tests pass, new builder tests pass (test file registered in `package.json`)
- **Contract**: `BuildResult` and `ValidationResult` types match actual builder/CLI output (round-trip test)
- **Internal Validation**: Generated DOT files pass builder's internal 15-rule validation with 0 errors
- **External Validation**: When available, generated DOT files pass `attractor validate --format json` with 0 errors
- **Determinism**: Same `BuilderSpec` input produces byte-identical DOT output
- **LLM**: N/A — all requirements are machine-verifiable

### Verification Commands

| Check | Command | Expected |
|:---|:---|:---|
| Type check | `cd extension && npx tsc --noEmit` | Exit 0, no errors |
| Lint | `cd extension && npx eslint src/ --max-warnings=-1` | Exit 0 |
| Tests | `cd extension && npm test` | All pass |
| Builder CLI | `echo '{"slug":"test","goal":"test","phases":[],"acceptanceCriteria":{}}' \| node extension/bin/dot-builder.js` | Exit 0, valid JSON on stdout |
| Internal validation | Builder test: all 15 rules produce expected diagnostics | Tests pass |
| Determinism | Builder test: build same spec twice, assert output equality | Tests pass |
| Acceptance criteria enforced | Builder test: `.build()` throws on unmapped AC key | Tests pass |
| Schema sync | `npm run sync-schema` updates types without errors | Exit 0, types updated |

## Test Expectations

### Unit Tests

| Requirement | Test File | Description | Assertion |
|:---|:---|:---|:---|
| Valid DOT output | `dot-builder.test.js` | Minimal pipeline: start → impl → exit | Output contains `digraph`, `Mdiamond`, `Msquare`, valid edges |
| Single start/exit | `dot-builder.test.js` | `.build()` called on builder with invalid structure | Throws `BuildError` with code `INVALID_STRUCTURE` |
| AC mapping enforcement | `dot-builder.test.js` | AC key without context_on_success | Throws `BuildError` with code `MISSING_AC_MAPPING`, diagnostics mentions key name |
| AC mapping valid | `dot-builder.test.js` | All AC keys have sources | `.build()` succeeds |
| Thread ID auto-assign | `dot-builder.test.js` | Two phases without explicit thread_id | Output has `thread_id="phase_1"` and `thread_id="phase_2"` |
| Thread ID on fix nodes | `dot-builder.test.js` | Fix node in phase 1 | Fix node has `thread_id="phase_1"` |
| Timeout default impl | `dot-builder.test.js` | Codergen impl node without explicit timeout | Output has `timeout="30m"` |
| Timeout default review | `dot-builder.test.js` | Review node | Output has `timeout="15m"` |
| read_only on review | `dot-builder.test.js` | Review/conformance node | Output has `read_only=true` and STATUS marker in prompt |
| max_parallel=1 | `dot-builder.test.js` | Component fan-out node | Output has `max_parallel=1` |
| allowed_paths scoped test dirs | `dot-builder.test.js` | Phase with `allowedPaths: ["src/auth/**"]` | Output allowed_paths includes `tests/auth/**` or `__tests__/auth/**` *(refined: scoped)* |
| retry_target not start | `dot-builder.test.js` | Graph retry_target set to "start" | Throws `BuildError` |
| max_visits on loops | `dot-builder.test.js` | Node with incoming retry edge | Output has `max_visits=5` attribute |
| Defense matrix | `dot-builder.test.js` | Pipeline with spec_file + conformance | Output contains defense matrix comment block |
| Model stylesheet (basic) | `dot-builder.test.js` | StylesheetConfig with review provider | Output model_stylesheet includes `.review { llm_provider: ... }` |
| Model stylesheet (full) | `dot-builder.test.js` | StylesheetConfig with all fields: `defaultModel`, `defaultProvider`, `criticalModel`, `criticalProvider`, `reviewModel`, `reviewProvider`, `reasoningEffort` | Output model_stylesheet includes `.default`, `.critical`, `.review` blocks with correct provider/model/effort values |
| Microverse pattern | `dot-builder.test.js` | `.microverse()` call | Output has optimize→measure→compare→check subgraph |
| Review ratchet | `dot-builder.test.js` | `.reviewRatchet(3)` call | Output has 3-pass consecutive clean review loop |
| Workspace isolation (basic) | `dot-builder.test.js` | `.workspace()` (no args = isolated mode) | Output has commit_and_push node on success path |
| Workspace isolation (opts) | `dot-builder.test.js` | `.workspace({ repoUrl: "https://github.com/org/repo.git", repoBranch: "feature", cleanup: "delete" })` | Output has `repo_url`, `repo_branch` attributes on workspace config; commit_and_push present |
| Diagnostic fix field | `dot-builder.test.js` | Trigger validation rule (e.g., missing timeout) | `Diagnostic.fix` field is non-empty string with actionable suggestion |
| Pattern logging | `dot-builder.test.js` | Standard pipeline | `BuildResult.patternsApplied` contains expected auto patterns |
| fromSpec equivalence | `dot-builder.test.js` | `fromSpec({...})` vs equivalent constructor calls | Identical DOT output *(refined: new)* |
| fromSpec validation | `dot-builder.test.js` | `fromSpec` with missing slug | Throws `BuildError` with code `EMPTY_SLUG` *(refined: new)* |
| Determinism | `dot-builder.test.js` | Build same spec twice | Byte-identical output *(refined: new)* |
| Graph-level specFile | `dot-builder.test.js` | BuilderSpec with `specFile: "prds/my-prd.md"` | Output graph attributes contain `spec_file="prds/my-prd.md"` *(microverse: iter2 #2)* |
| Graph-level label override | `dot-builder.test.js` | BuilderSpec with `label: "Custom Label"` | Output graph `label` is `"Custom Label"`, not the goal string *(microverse: iter2 #2)* |
| Graph-level defaultMaxRetry | `dot-builder.test.js` | BuilderSpec with `defaultMaxRetry: 5` | Output graph attributes contain `default_max_retry="5"` *(microverse: iter2 #2)* |
| AC Tier 2 auto-generation | `dot-builder.test.js` | BuilderSpec with `acceptanceCriteria: { types_compile: "...", lint_clean: "...", tests_pass: "...", cli_contract: "...", determinism: "...", validation_rules: "..." }` and NO `contextOnSuccess` on any phase | `.build()` succeeds; `verify_final` node has `context_on_success` containing all 6 Tier 2 keys (`types_compile`, `lint_clean`, `tests_pass`, `cli_contract`, `determinism`, `validation_rules`) *(microverse: iter2 #4)* |
| Catastrophic recovery present | `dot-builder-patterns.test.js` | Pipeline with retry loops (goal gate or test-fix) | `verify_final` has edge to `setup_deps` with `loop_restart="true"` *(microverse: iter2 #6)* |
| Catastrophic recovery absent | `dot-builder-patterns.test.js` | Pipeline with no retry loops | No `loop_restart` edge exists *(microverse: iter2 #6)* |
| escalateOn default | `dot-builder.test.js` | Phase without explicit `escalateOn` | Impl node has `escalate_on` with default `["package.json","*.lock","*.config.*"]` *(microverse: iter2 #10)* |
| escalateOn custom | `dot-builder.test.js` | Phase with `escalateOn: ["Dockerfile"]` | Impl node has `escalate_on` with custom value, not default *(microverse: iter2 #10)* |
| Pattern 16 default-on | `dot-builder.test.js` | Phase with `goalGate: true`, `specFirst` omitted | `spec_file_${phase}` node present in output; Pattern 16 in `patternsApplied` *(microverse: iter3 #12)* |
| Pattern 16 opt-out | `dot-builder.test.js` | Phase with `goalGate: true, specFirst: false` | No `spec_file_${phase}` node in output; Pattern 16 absent from `patternsApplied` for that phase *(microverse: iter3 #12)* |
| CLI stdin/stdout | `dot-builder-cli.test.js` | Pipe valid JSON to CLI | Exit 0, stdout parses as `BuildResult` *(refined: new)* |
| CLI stderr on error | `dot-builder-cli.test.js` | Pipe invalid JSON to CLI | Exit 2, stderr has error JSON *(refined: new; post-review: exit 2 for unparseable JSON, not exit 1)* |
| CLI build error | `dot-builder-cli.test.js` | Pipe spec with missing AC mapping | Exit 1, stderr has diagnostics *(refined: new)* |
| Internal validation rules | `dot-builder-validation.test.js` | 15 separate tests, one per rule (single start/exit, no incoming→start, reachability, diamond branching, goal_gate→max_visits, AC mapping, timeout, prompt↔allowed_paths, read_only+STATUS, component↔tripleoctagon, fan_out_scope, workspace_config, workspace_push, permission_mode_plan, allowed_paths_required) | Each rule produces expected diagnostic *(refined: expanded to 15)* |

### Pattern Snapshot Tests *(refined: new section)*

| Pattern | Test File | Description | Assertion |
|:---|:---|:---|:---|
| Per-pattern (28 tests) | `dot-builder-patterns.test.js` | Each active v1 pattern (0, 0a, 0b, 0c, 0d, 0e, 1, 2, 3, 4, 6, 6b, 8, 9, 10, 13, 14, 15, 16, 16b, 17, 18, 19, 20, 21, 22, 23, 25) — excludes deferred Pattern 24 and deprecated Pattern 11 | Output contains pattern-specific DOT attributes at correct values |

### Integration Tests

| CUJ | Test File | Scenario | Expected |
|:---|:---|:---|:---|
| CUJ-1 | `dot-builder.test.js` | Full pipeline: 3 phases, spec-first, review ratchet via `fromSpec()` | Internal validation returns 0 errors; output has correct thread_ids, patterns, defense matrix |
| CUJ-2 | `dot-builder.test.js` | Deliberately broken spec → build → check diagnostics | BuildError with non-empty diagnostics array |
| CUJ-3 | `dot-builder.test.js` | AC key "auth_secure" with no source (custom key, not auto-generated by Tier 2) | `BuildError` with code `MISSING_AC_MAPPING`, "auth_secure" in diagnostics |
| CUJ-4 | `dot-builder.test.js` | Fallback schema loaded, contains expected attributes | `graphAttributes.goal` exists with type "string" |
| CUJ-2b | `dot-builder-cli.test.js` | 3 consecutive fix attempts with errors remaining → `.dot.draft` saved | Best-attempt DOT saved; remaining diagnostics present; draft file contains valid DOT *(council: C7)* |
| CUJ-5 | `dot-builder-patterns.test.js` | 3-phase mixed patterns (auth+security, api+goalgate, docs) | Correct thread_ids, security scan node (Pattern 8), goal gate with retry, test dirs auto-added, all auto + invoked opt-in patterns applied *(refined: new)* |

### Edge Cases

| Condition | Behavior | Test |
|:---|:---|:---|
| Empty pipeline (no phases) | `.build()` produces valid `start → setup_deps → capture_baseline → fix_all → verify_final → exit` (auto infrastructure always emitted; no per-phase nodes). `verify_final` sets Tier 2 AC keys and has `retry_target="fix_all"`. Pattern 25 (catastrophic recovery) is NOT emitted (explicit zero-phase carve-out per line 244). `patternsApplied` includes only: `0a, 0c, 6, 21, 22, 23`. Pattern 6 included because `fix_all` is referenced by `verify_final`'s `retry_target`, triggering `max_visits="5"` injection. Pattern 0b excluded (no `shape=component` nodes to inject `max_parallel` onto). Pattern 22 included (applies to cross-phase codergen nodes `fix_all` and `verify_final` — `allowed_paths` is union of zero phases = empty, producing a warning diagnostic). *(review: specified zero-phase topology explicitly; microverse: iter1 — corrected 0b inclusion, added 22 for cross-phase codergen; iter4 — added fix_all to topology chain, added Pattern 6 to patternsApplied)* | Unit test |
| Doc-only phase (`docOnly: true`) | `.build()` emits `impl → check_progress → scope_check → conformance` for this phase. No `verify_lint`, `verify_types`, `test` diamond, or `fix` nodes. `check_progress` and `scope_check` failure edges route to cross-phase `fix_all`. Patterns 0d, 1, 13, 14 produce no output for this phase and are excluded from `patternsApplied` per vacuous-application rule (line 221). Pattern 0e (check_progress) still fires. | Unit test *(audit: new — doc-only phase topology)* |
| Doc-only phase with `goalGate: true` | Warning diagnostic emitted; `goalGate` attribute is set but has no functional effect (no test diamond to gate) | Unit test *(audit: new)* |
| Phase with empty allowedPaths | `.build()` warns (diagnostic with severity: warning) | Unit test |
| Microverse with non-numeric target | `.microverse()` throws at call time | Unit test |
| Review ratchet with passes=1 | Throws (minimum 2 for meaningful ratchet) | Unit test |
| Fallback schema missing or unparseable | Builder uses hardcoded minimal schema, emits warning diagnostic | Unit test *(refined: specifies fallback behavior)* |
| `attractor validate` CLI not available | `validateDot()` returns `{ valid: true, diagnostics: [{ rule: "cli_unavailable", severity: "info", message: "..." }] }` — does not block | Unit test *(refined: non-blocking; council: H6 — unified diagnostics)* |
| Phase name with special characters | Slugified to valid DOT node ID | Unit test |
| >10 phases in single pipeline | Builder handles without stack overflow or ID collision | Unit test |
| All phases have `dependsOn` (0 independent) | Pattern 4 not emitted; phases serialized with direct edges, no `split_phases`/`merge_phases` nodes | Unit test *(microverse: iter3 #10 — reframed: "0 branches" was unreachable via public API)* |
| Duplicate acceptance criteria keys | Last value wins, no error | Unit test |
| Fix loop: error count oscillates (3→1→3→2) | Count attempts, not error reduction; stop after 3 fix attempts; save attempt with count 1 | Unit test *(refined: new)* |
| Fix loop: initial generation has 0 errors | No fix loop entered; save immediately | Unit test *(refined: new)* |
| `.build()` called twice on same instance | Throws (single-use) | Unit test *(refined: new)* |
| Stdin > 512KB | CLI exits 2 with `{ "error": "INPUT_TOO_LARGE", "message": "Stdin exceeds 512KB limit" }` on stderr (pre-parse rejection — non-recoverable because the LLM cannot meaningfully reduce a BuilderSpec that is already too large; split into multiple pipelines instead) | Unit test *(review: reclassified from exit 1 to exit 2 — empty diagnostics with exit 1 confuses fix loop since it counts error diagnostics to determine convergence)* |
| Slug with slashes/hashes (`my/slug#1`) | Sanitized to `my_slug_1`; valid DOT node ID | Unit test *(council: adversarial)* |
| Phase name with unicode (`"auth 认证"`) | Sanitized to ASCII-safe DOT ID (`auth__` or transliterated) | Unit test *(council: adversarial)* |
| Prompt containing `"` and `\n` | DOT escaping applied: `\"`, `\\n` | Unit test *(council: adversarial)* |
| `allowedPaths` with absolute path (`/usr/bin/**`) | Throws `BuildError` with code `INVALID_ALLOWED_PATHS` | Unit test *(council: adversarial; microverse: iter5 #3)* |
| `timeout` invalid format (`"30"` instead of `"30m"`) | Throws `BuildError` with code `INVALID_TIMEOUT` | Unit test *(council: adversarial; microverse: iter5 #3)* |
| `fromSpec()` with unknown fields (`{unknownField: "x"}`) | Warning diagnostic (not error); unknown fields ignored for forward compatibility | Unit test *(council: contracts)* |
| Builder crash (exit 2) during fix loop | Fix loop stops; saves best prior attempt as `.dot.draft`; does NOT count as fix attempt | Unit test *(council: adversarial)* |
| `context_on_success` sets key not in `acceptance_criteria` | Warning: orphaned context key `${K}` | Unit test *(council: adversarial)* |
| Fan-out with 1 branch (degenerate) | Not reachable via public BuilderSpec API — Pattern 4 only triggers when ≥2 independent phases exist. Internal invariant only: if somehow triggered, builder throws. | Internal validation test *(council: adversarial; microverse: reclassified as unreachable via public API, same as all-dependsOn case in "All phases have `dependsOn`" edge case above)* |
| Microverse `target=0, direction='reduce'` | Valid — reducing to 0 is legitimate (e.g., zero errors) | Unit test *(council: H9)* |
| Microverse `target=0, direction='improve'` | Throws: target must be > 0 for direction='improve' | Unit test *(council: H9)* |
| Microverse `target=-1` | Throws: target must be >= 0 | Unit test *(council: adversarial)* |
| Two phases sanitize to same node ID (`"auth scan"` + `"auth-scan"` → both `auth_scan`) | `.phase()` throws `DUPLICATE_PHASE` after sanitization | Unit test *(council: final adversarial)* |
| `timeout="0m"` (zero duration) | Validation error: timeout must be > 0 | Unit test *(council: final adversarial)* |
| Custom verify command without keyword match (`./run-checks.sh`) | AC mapping heuristic skips auto-generation; if AC key has no source → `MISSING_AC_MAPPING` error prompts LLM to add explicit `context_on_success` | Unit test *(council: final adversarial)* |

## `allowed_paths` Test Directory Heuristic *(refined: new section — specifies algorithm)*

```
For each path P in allowedPaths:
  1. If P starts with "src/" or "lib/" or matches the pattern "packages/<segment>/src/" (where <segment> is any non-slash path segment, matched via regex `^packages/[^/]+/src/`):
     - Split P into: {prefix} (before "src/" or "lib/") + {root} ("src/" or "lib/") + {subpath} (after root)
     - Extract the prefix before "src/" or "lib/" (e.g., "packages/foo/")
     - Extract the subpath after "src/" or "lib/" (e.g., "auth/**" from "src/auth/**")
     - Add "{prefix}tests/{subpath}" AND "{prefix}__tests__/{subpath}"
     - Example: "src/auth/**" → prefix="", subpath="auth/**" → adds "tests/auth/**" and "__tests__/auth/**"
     - Example: "packages/foo/src/bar/**" → prefix="packages/foo/", subpath="bar/**" → adds "packages/foo/tests/bar/**" and "packages/foo/__tests__/bar/**"
  2. If P is a bare glob (e.g., "*.ts") — no directory prefix:
     - Add "tests/**" and "__tests__/**" (project root)
  3. If P already contains "test" or "__tests__":
     - No-op (already covered)
  4. Deduplicate the resulting array
```

## Assumptions

1. Attractor's `validate --format json` CLI enhancement ships concurrently or after this builder (separate PRD). If unavailable, builder ships with internal validation only — still valuable. *(refined: clarified ship decision)*
2. Attractor's `schema.json` export ships concurrently or after. If unavailable, builder uses hand-maintained `attractor-schema.fallback.ts` committed to git. *(refined: specifies fallback mechanism)*
3. The `/pickle-dot` command prompt can invoke compiled JS functions via `node` CLI — same pattern as `setup.js`, `spawn-morty.js`.
4. The LLM calling the builder constructs `BuilderSpec` JSON and pipes to CLI — same LLM running `/pickle-dot`, no separate invocation.
5. All 30 pipeline composition patterns (plus 3 superseded and 5 defensive coding patterns) are fully documented in `pickle-dot-patterns.md`. The 28 active v1 patterns can be encoded programmatically. *(refined: corrected count; taxonomy clarified)*
6. Zero runtime dependencies — builder uses Node.js built-ins only. No external DOT parsing library. *(refined: new — codebase constraint)*
7. Builder targets TypeScript/Node.js pipelines — Tier 2 auto-generated AC keys (`types_compile`, `lint_clean`, `tests_pass`) and `verify_final`'s `tool_command` assume `npx tsc`, `npx eslint`, `npm test` tooling. Non-TypeScript pipelines are not in scope for v1. *(microverse: gap-analysis observation A — made implicit assumption explicit)*

## Risks & Mitigations

| Risk | Impact | Mitigation |
|:---|:---|:---|
| Builder API too rigid for novel pipeline shapes | LLM can't express unusual topologies | `/pickle-dot --legacy` preserves prompt-only generation as escape hatch *(refined: replaced rawNode/rawEdge with --legacy)* |
| LLM struggles to map PRD analysis to BuilderSpec JSON | Worse output than current prompt-only approach | Opt-in period with `--builder` flag; `--legacy` as rollback; ≥3 few-shot examples in prompt |
| Schema sync breaks on attractor major version | Builder types don't compile | Pin schema version in fallback, fail-fast on version mismatch |
| attractor validate CLI unavailable | No external pre-flight validation | Internal 15-rule validation covers the most common structural errors *(refined: internal validation is primary; expanded to 15 rules)* |
| 30 patterns make builder complex | Hard to implement, easy to get wrong | Patterns grouped into tiers: auto (no user control), default-on (opt-out), opt-in (explicit). Per-pattern snapshot tests. 2 deferred/deprecated reduce v1 active to 28. *(refined: references matrix; count corrected)* |
| Single-stakeholder bus factor | Pattern correctness depends on one person's knowledge | 28 per-pattern snapshot tests with attribute-level assertions make correctness machine-verifiable *(refined: new; count corrected)* |

## Launch Plan *(refined: new section)*

**Phase 1 (Opt-in)**: `/pickle-dot --builder` flag enables builder path. Default remains prompt-only.
- Duration: 2 weeks or 20 successful pipeline generations, whichever comes first
- Rollback: remove `--builder` flag usage; no code changes needed
- Success criteria: <10% of builder-generated DOTs require manual correction

**Phase 2 (Default)**: Builder becomes default. `--legacy` flag preserves prompt-only path.
- Duration: 4 weeks
- Rollback trigger: >25% manual correction rate over any 5-pipeline window

**Phase 3 (Legacy removal)**: Remove prompt-only path and `pickle-dot-patterns.md` loading.
- Prerequisite: 4 weeks at <5% correction rate

## Tradeoffs

| Decision | Alternative | Rationale |
|:---|:---|:---|
| `new DotBuilder()` constructor + `fromSpec()` static factory | `DotBuilder.create()` as sole entry point | `new` matches `StateManager` pattern for programmatic use; `fromSpec()` is a deliberate static factory for CLI JSON deserialization — justified exception since CLI always receives JSON, not constructor args *(refined)* |
| Schema sync via file copy + types generation | Direct TypeScript import (monorepo) | File copy keeps repos decoupled; monorepo coupling would force synchronized releases |
| LLM constructs BuilderSpec JSON, pipes to CLI | LLM writes TypeScript builder calls | JSON is simpler to construct and validate; TS code gen has injection risk *(refined)* |
| All 28 active v1 patterns from day one | Incremental pattern addition | Full coverage prevents "which patterns are available" confusion; patterns are the whole point *(refined: 30 total minus 2 deferred/deprecated = 28 active)* |
| Auto-fix loop inside /pickle-dot (max 3) | Manual fix by user | Most validation errors are mechanical (missing timeout, wrong shape) — LLM can fix these trivially |
| `--legacy` flag for rollback | `rawNode()`/`rawEdge()` escape hatches | Legacy preserves the proven path; raw injection undermines every invariant the builder enforces *(refined: new)* |
| Internal validation as primary | External validation as primary | `attractor validate --format json` doesn't exist yet; internal validation is the de facto P0 path *(refined: new)* |

## Business Impact

| Metric | Current | Target | Impact |
|:---|:---|:---|:---|
| DOT generation correctness (first attempt) | ~70% (estimated from failure rate) | >95% | Eliminates 1-4 hours of rework per pipeline |
| Pattern omission rate | ~20% of Tier 2 patterns missed | 0% (programmatically enforced) | Every pipeline gets full defense-in-depth |
| Schema drift incidents per month | 2-3 | 0 | No more "attractor changed, pickle-dot didn't" failures |
| Time from PRD to valid DOT | 5-15 min (with manual fixes) | 1-3 min (happy path), 5-10 min (fix loop worst case) | Faster iteration; fix loop prioritizes correctness over speed *(refined: realistic bounds)* |

## Stakeholders

| Name | Team | Role | Note |
|:---|:---|:---|:---|
| Greg Dickson | Engineering | Owner | Drives pickle-rick-claude + attractor |

## Implementation Task Breakdown

| Order | ID | Title | Priority | Entry | Exit | Files | Allowed Paths | Goal Gate | dependsOn |
|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|
| 10 | fbaeb3b5 | Scaffold types, BuilderSpec, and Diagnostic interfaces | High | Clean main | `npx tsc --noEmit` passes; all builder types exported from `types/index.ts` | `types/index.ts` | `extension/src/types/**`, `extension/tests/types/**` | No | — |
| 20 | 51bc2030 | Core DotBuilder service — constructor, phase(), build() with DOT emission + string escaping | High | Types available | Core builder emits valid DOT; `npm test` passes dot-builder unit tests | `services/dot-builder.ts`, `tests/dot-builder.test.js`, `package.json` (test script) | `extension/src/services/**`, `extension/tests/**`, `extension/package.json` | Yes | 10 |
| 30 | 0693e97d | Internal validation engine — 15 structural rules | High | Core builder works | 15 rules produce expected diagnostics; `npm test` passes | `services/dot-builder.ts`, `tests/dot-builder-validation.test.js` | `extension/src/services/**`, `extension/tests/**` | Yes | 20 |
| 40 | 76be09d5 | Pattern auto-application — 18 auto-mode patterns with shell command templates | High | Validation available | 18 auto patterns enforced (0a-0e, 1, 3, 4, 6, 6b, 10, 13, 14, 15, 21, 22, 23, 25); snapshot tests pass; `BuildResult.patternsApplied` includes all auto patterns for a 2-phase spec *with no `dependsOn` relationships* *(council: I-3 clarification; microverse: Pattern 4 requires independent phases; Pattern 16 moved to Phase 50; review: 16b moved from auto to opt-in, count 19→18)* | `services/dot-builder.ts`, `tests/dot-builder-patterns.test.js` | `extension/src/services/**`, `extension/tests/**` | Yes | 30 |
| 50 | 67181c43 | Opt-in + default-on patterns — spec-first (16), BDD scenarios (16b), microverse, review ratchet, workspace, competing impls, security, red team, model stylesheet | Medium | Auto patterns working | All 28 active v1 patterns; 28 snapshot tests pass; opt-in patterns absent when not requested; `.modelStylesheet()` generates valid CSS-like syntax (P2 but included in this phase) *(review: 16b moved here from Phase 40 — now opt-in not auto)* | `services/dot-builder.ts`, `tests/dot-builder-patterns.test.js` | `extension/src/services/**`, `extension/tests/**` | No | 40 |
| 60 | 7f98dd6a | CLI entry point + fromSpec() with JSON schema validation | High | All patterns done | CLI exits 0/1/2 correctly; `npx eslint src/ --max-warnings=-1` passes; `install.sh` has chmod; all 4 test files registered in `package.json` | `bin/dot-builder.ts`, `tests/dot-builder-cli.test.js`, `install.sh`, `package.json` (test script) | `extension/src/bin/**`, `extension/tests/**`, `extension/package.json`, `install.sh` | Yes | 50 |
| 65 | a1b3c5d7 | Fallback schema creation | Medium | All patterns done | `types/attractor-schema.fallback.ts` committed with all builder-emitted attributes (node: `class`, `shape`, `goal_gate`, `retry_target`, `max_visits`, `thread_id`, `timeout`, `allowed_paths`, `read_only`, `context_on_success`, `prompt`, `tool_command`, `max_parallel`, `escalate_on`, `permission_mode`, `auto_status`, `allow_partial`; graph: `goal`, `working_dir`, `default_max_retry`, `label`, `acceptance_criteria`, `model_stylesheet`, `spec_file`, `workspace`, `repo_url`, `repo_branch`, `workspace_cleanup`, `retry_target`; edge: `outcome`, `loop_restart`); builder loads it when `$ATTRACTOR_ROOT` unavailable *(microverse: iter1 — expanded from "minimum viable" to exhaustive list; iter4 — added `shape`; iter8 — added `retry_target` to graph list per line 144/614)* *(audit: relaxed entry from "CLI working" to "All patterns done" — fallback schema has no CLI dependency, only needs builder-emitted attribute list finalized after Phase 50; enables fan-out with Phase 60)* | `types/attractor-schema.fallback.ts` | `extension/src/types/**`, `extension/tests/**` | No | 50 |
| 70 | 045a571a | Schema sync script | Medium | Fallback exists, CLI done | `npm run sync-schema` reads `$ATTRACTOR_ROOT/schema.json` and generates `types/attractor-schema.ts` (gitignored — auto-generated; fallback file `attractor-schema.fallback.ts` is hand-maintained and committed); falls back gracefully; add `types/attractor-schema.ts` to `.gitignore` | `bin/sync-schema.ts`, `types/attractor-schema.ts`, `package.json` (script entry), `.gitignore` | `extension/src/bin/**`, `extension/src/types/**`, `extension/tests/**`, `extension/package.json` | No | 60, 65 |
| 75 | b4c8e2f1 | Cross-phase synthesis gate — verify end-to-end coherence across all code phases | High | Phases 60+70 complete | 10-point coherence check passes: types exported, imports correct, all 15 rules implemented, all 28 snapshots exist, install.sh chmod, package.json test script, no circular imports, fromSpec round-trip valid, CLI contract works | N/A (verification only — no new files produced; full verify chain runs as the integration gate) | `extension/src/**`, `extension/tests/**`, `extension/package.json`, `install.sh` | Yes | 60, 70 |
| 80 | e3a7d523 | /pickle-dot command prompt rewrite + --legacy/--builder flags | High | Synthesis gate passes | Prompt has BuilderSpec instructions, ≥3 few-shot examples, fix-loop instructions, `--builder` flag for Phase 1 opt-in, `--legacy` flag for rollback, default remains prompt-only; no raw DOT instructions remain | `.claude/commands/pickle-dot.md` | `.claude/commands/pickle-dot.md` | No | 75 |
| 85 | f2e4d6c8 | README documentation update | Medium | Prompt rewrite done | README documents: builder API, BuilderSpec JSON structure, `/pickle-dot` invocation (normal + `--legacy`), fix-loop flow | `README.md` | `README.md` | No | 80 |

## Generated Pipeline Configuration

When `/pickle-dot` generates a pipeline from this PRD, use these values:

| Field | Value | Rationale |
|:---|:---|:---|
| `slug` | `pickle-dot-codegen-builder` | Matches PRD filename |
| `goal` | `Build TypeScript DOT pipeline codegen builder with 28 patterns, 15 validation rules, and deterministic output` | From PRD Objective |
| `working_dir` | `${WORKING_DIR}` | Attractor resolves at runtime to the mounted repo root; all phase commands use relative paths from `extension/` via `cd extension &&` prefix |
| `spec_file` | `prds/archive/features/pickle-dot-codegen-builder.md` | This PRD — canonical spec for conformance checks |
| `workspace` | shared (omit field — default) | Same repo, no isolation needed |
| `label` | `Pickle-Dot Codegen Builder` | Human-readable pipeline label |
| `default_max_retry` | `3` | Standard retry budget |
| `reviewRatchet` | `2` | Single-file service; 3+ passes have diminishing returns |

### Pipeline Dependency Graph *(audit: new section — explicit topology for /pickle-dot)*

```
Phase 10 → 20 → 30 → 40 → 50 ─┬─→ 60 ──────────┐
                                └─→ 65 ──→ 70* ──┤
                                                  ▼
                                                 75 → 80 → 85

* Phase 70 dependsOn: [60, 65] — waits for both branches
```

**Fan-out after Phase 50**: Phases 60 (CLI) and 65 (fallback schema) are independent — different files, no import dependencies. Pattern 4 triggers with 2 branches. Phase 70 depends on both 60 and 65 (`dependsOn: [60, 65]`) because both Phase 60 and Phase 70 modify `extension/package.json` — concurrent writes would conflict. Phase 75 (synthesis gate) is the join point (`dependsOn: [60, 70]`). *(audit: F1 — added Phase 60 to Phase 70's deps to prevent package.json write conflict)*

**Doc-only phases (80, 85)**: These produce markdown files with no compile/test targets. Set `docOnly: true` on their `PhaseSpec` to suppress the verify chain (Patterns 0d, 1, 13, 14). Route: `impl → check_progress → scope_check → conformance` (skip verify_lint, verify_types, test diamond, fix). Failure at check_progress or scope_check routes to cross-phase `fix_all`. The review ratchet still applies (content quality matters).

**Phase-specific `specFirst` overrides**: Pattern 16 defaults to `true` only when `goalGate: true`. For non-goal-gated code phases that need spec-first (10, 50, 70), the BuilderSpec MUST set `specFirst: true` explicitly. For doc-only phases (80, 85), static data (65), and verification-only (75), set `specFirst: false` explicitly to suppress. Phase 75 needs explicit `specFirst: false` to override the goalGate default.

## Pipeline Quality Gate Specification

This section defines the quality gates for the pipeline generated from this PRD, ensuring `/pickle-dot` produces a pipeline with sufficient verification depth.

### Acceptance Criteria Keys (graph-level)

```dot
acceptance_criteria = "context.cli_contract=true && context.determinism=true && context.lint_clean=true && context.tests_pass=true && context.types_compile=true && context.validation_rules=true"
```

The `verify_final` node MUST set all 6 keys via `context_on_success`:
```dot
context_on_success="cli_contract=true,determinism=true,lint_clean=true,tests_pass=true,types_compile=true,validation_rules=true"
```

| Key | What it proves | verify_final command |
|:---|:---|:---|
| `types_compile` | All TypeScript compiles | `npx tsc --noEmit` |
| `lint_clean` | All custom `eslint-plugin-pickle` rules pass | `npx eslint src/ --max-warnings=-1` |
| `tests_pass` | All unit + integration tests pass | `npm test` |
| `cli_contract` | CLI stdin→stdout contract works end-to-end | `echo '{"slug":"test","goal":"test","phases":[{"name":"p1","prompt":"impl","allowedPaths":["src/**"]}],"acceptanceCriteria":{"done":"true"}}' \| node bin/dot-builder.js` exits 0 with valid JSON |
| `determinism` | Same input → byte-identical output | Covered by unit test in `npm test` |
| `validation_rules` | All 15 internal rules produce correct diagnostics | Covered by unit test in `npm test` |

### Per-Phase Verification Commands

Each phase should use scoped verification rather than running the full gate. This prevents early phases from failing on tests that don't exist yet. Test files are registered in `package.json` incrementally — each phase adds its test file(s) in the same commit, so `npm test` only runs tests that exist at that point. Existing tests (1307 at baseline) must continue to pass at every phase.

| Phase | Task | Phase Verify Command | Why Scoped |
|:---|:---|:---|:---|
| 10 | Scaffold types | `cd extension && npx tsc --noEmit` | Only types exist — no tests or service yet |
| 20 | Core builder | `cd extension && npx tsc --noEmit && npm test` | `dot-builder.test.js` registered in this phase; runs core API tests only (validation/pattern test files don't exist yet) |
| 30 | Validation engine | `cd extension && npx tsc --noEmit && npm test` | `dot-builder-validation.test.js` registered in this phase; runs alongside Phase 20 tests |
| 40 | Auto patterns | `cd extension && npx tsc --noEmit && npm test` | `dot-builder-patterns.test.js` registered in this phase; runs auto-pattern snapshot tests alongside Phases 20–30 tests |
| 50 | Opt-in patterns | `cd extension && npx tsc --noEmit && npm test` | Opt-in pattern snapshot tests added to existing `dot-builder-patterns.test.js`; all prior tests continue to pass |
| 60 | CLI + fromSpec | `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npm test` | Full lint gate — `dot-builder-cli.test.js` registered; CLI guard validated by eslint `pickle/cli-guard-basename` rule AND by CLI test suite |
| 65 | Fallback schema | `cd extension && npx tsc --noEmit` | Fallback type file compiles; no new test file (fallback is a static data file) *(council: H2)* |
| 70 | Schema sync | `cd extension && npx tsc --noEmit && npm test` | Sync script tests added; generated `types/attractor-schema.ts` is gitignored (auto-generated from `$ATTRACTOR_ROOT/schema.json`; fallback file is hand-maintained and committed) |
| 75 | Synthesis gate | `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npm test` | Full gate — all code phases complete; this is the integration verification point. Also runs red team (Pattern 17) with adversarial BuilderSpec inputs *(audit: new phase)* |
| 80 | Prompt rewrite | N/A (`docOnly: true` — markdown file, no compile/test) | `docOnly: true` in BuilderSpec. Route: `impl → check_progress → scope_check → conformance`. No verify_lint, verify_types, test, or fix nodes. check_progress/scope_check failures route to cross-phase `fix_all`. Review ratchet still applies. *(audit: doc-only phase with PhaseSpec.docOnly)* |
| 85 | README update | N/A (`docOnly: true` — documentation) | Same `docOnly: true` treatment as Phase 80. *(audit: doc-only phase; council: H3)* |

### Per-Phase LLM Review Criteria

Each phase MUST include a conformance node (Pattern 15) with phase-specific review instructions. Generic "check the spec" conformance is insufficient — each phase's reviewer must know exactly what to look for.

| Phase | Task | LLM Review Focus | Critical Check |
|:---|:---|:---|:---|
| 10 | Scaffold types | All interfaces from Type Contracts section are present in `types/index.ts`. `BuilderSpec`, `PhaseSpec`, `MicroverseOpts`, `WorkspaceOpts`, `StylesheetConfig`, `BuildResult`, `DefenseMatrix`, `Diagnostic`, `ValidationResult`, `BuildError` — each with exact field names and types matching the PRD. No separate type files. | `BuilderSpec.phases` is `PhaseSpec[]` not `Phase[]`; `Diagnostic.severity` is union type not string |
| 20 | Core builder | `DotBuilder` class exists in `services/dot-builder.ts`. Constructor takes `(slug, goal)`, throws on empty. `.phase()` returns `this` (fluent), throws on duplicate name. `.build()` emits DOT with `digraph`, `Mdiamond` start, `Msquare` exit, valid edges. Single-use guard on `.build()`. No `process.exit()`. Test file registered in `package.json`. | Output is valid DOT syntax — test with a minimal 1-phase spec and verify the string parses |
| 30 | Validation engine | All 15 rules implemented, not stubbed. Each rule has a dedicated test that triggers the specific diagnostic. Rules return `Diagnostic[]` with correct `rule`, `severity`, `message`, `nodeId`/`edge` fields. Validation runs inside `.build()`, results in `BuildResult.diagnostics`. | Rules 11-15 (fan_out_scope, workspace_config, workspace_push, permission_mode_plan, allowed_paths_required) are new — verify they're not skipped |
| 40 | Auto patterns | All `auto` mode patterns from the Pattern Application Matrix are applied by `.build()` without user invocation: 0a (setup_deps), 0b (max_parallel), 0c (baseline), 0d (delta-aware), 0e (progress gate), 1 (test-fix), 3 (conditional routing), 4 (fan-out when ≥2 phases), 6 (max_visits), 6b (read_only+STATUS), 10 (scope creep), 13 (lint), 14 (typecheck), 15 (conformance), 21 (fix_all), 22 (permission scoping), 23 (defense matrix), 25 (catastrophic recovery). Pattern 16b (BDD) is opt-in, NOT auto — verify it is NOT applied unless `bddScenarios: true`. | `BuildResult.patternsApplied` includes every auto pattern for a 2-phase spec *with no `dependsOn` relationships* (matching exit criteria); conditional patterns like 0b, 4, 25 present because preconditions met; 16b absent unless explicitly requested |
| 50 | Opt-in + default-on patterns | Each opt-in or default-on pattern has: (a) a PhaseSpec/builder method that activates it, (b) a snapshot test proving the DOT output, (c) a test proving it's NOT applied when not requested (for opt-in) or CAN be disabled (for default-on). Patterns: 0 (workspace, opt-in), 2 (goal gates, opt-in), 8 (security scan, opt-in), 9 (coverage, opt-in), 16 (spec-first, default-on — verify opt-out via `specFirst: false`), 16b (BDD scenarios, opt-in — verify only when `bddScenarios: true`), 17 (red team, opt-in), 18 (competing impls, opt-in), 19 (review ratchet, opt-in), 20 (microverse, opt-in). | Verify `competing: true` activates Pattern 18 (component→tripleoctagon), NOT Pattern 4 (independent phases) |
| 60 | CLI + fromSpec | CLI guard uses `path.basename(process.argv[1]) === 'dot-builder.js'`. Reads stdin with `fs.readFileSync(0, 'utf8')` and 512KB guard. Exit codes: 0/1/2 per contract. `fromSpec()` produces identical output to equivalent constructor calls. JSON on stdout is valid `BuildResult`. JSON on stderr is valid `BuildError`. `install.sh` has chmod line. | Round-trip test: construct BuilderSpec → pipe to CLI → parse stdout → verify `patternsApplied` and DOT content |
| 65 | Fallback schema | `types/attractor-schema.fallback.ts` is committed to git with all builder-emitted attributes (31 total — 17 node, 12 graph, 2 edge — see Phase 65 task breakdown for full list; includes `auto_status`, `allow_partial` for Pattern 20 microverse; `retry_target` is dual-use: node-level per Pattern 2/6 and graph-level per line 144). Builder loads fallback when `$ATTRACTOR_ROOT` is unavailable. | Fallback covers all attributes emitted by builder AND all attributes referenced by the 15 validation rules (superset of prior "minimum viable" — `permission_mode`, `workspace`, `escalate_on`, `prompt`, `tool_command`, `class`, `shape`, `max_parallel`, `spec_file`, `outcome`, `loop_restart` were missing) *(council: H2; microverse: iter1, iter4 — added `shape`; iter8 — `retry_target` added to graph list)* |
| 70 | Schema sync | `npm run sync-schema` script exists in `package.json`. Reads `$ATTRACTOR_ROOT/schema.json` when available. Generates `types/attractor-schema.ts`. Builder warns on attributes not in schema. | Sync script doesn't touch fallback file — fallback is hand-maintained, sync is auto-generated |
| 75 | Synthesis gate | All 10 coherence checks from the synthesis gate prompt pass. Red team (Pattern 17): adversarial BuilderSpec inputs (empty phases, unicode slugs, >10 phases, circular dependsOn, AC key collisions) do not crash the builder — they produce structured `BuildError` diagnostics. | Integration test: `fromSpec()` with adversarial inputs returns errors, never crashes. Cross-phase imports resolve correctly. All 28 snapshot tests + 15 validation tests pass in a single `npm test` run *(audit: new — Phase 75 review criteria)* |
| 80 | Prompt rewrite (doc-only) | `/pickle-dot` prompt has: (a) NO raw DOT generation instructions, (b) BuilderSpec construction instructions, (c) ≥3 few-shot examples (single-phase, multi-phase, microverse), (d) fix-loop instructions with error count tracking, (e) `--legacy` flag handling, (f) `--builder` flag for Phase 1 opt-in. | Few-shot examples must use the EXACT `BuilderSpec` interface from this PRD — field names, types, nesting. Note: doc-only phase — no lint/typecheck/test gates in pipeline, conformance + review ratchet only *(audit: doc-only annotation)* |
| 85 | README update (doc-only) | README documents: (a) builder API overview, (b) BuilderSpec JSON structure with field descriptions, (c) `/pickle-dot` invocation — `--builder` for opt-in, default, and `--legacy` for rollback, (d) fix-loop behavior and `.dot.draft` files, (e) CLI contract (stdin/stdout/stderr). | README matches current implementation — no stale references to prompt-only generation. Note: doc-only phase — conformance + review ratchet only *(council: H3; audit: doc-only annotation)* |

### Cross-Phase Synthesis Gate *(new — addresses multi-phase coherence gap)*

**This is a pipeline-specific node for this PRD's generated pipeline, NOT a general builder pattern.** Phase 75 is now formally in the Implementation Task Breakdown table (ID `b4c8e2f1`) with `dependsOn: [60, 70]`, `goalGate: Yes`, and `redTeam: true`. The builder does not auto-generate synthesis gates — they are PRD-specific quality checks. *(audit: Phase 75 now in task table with full metadata)*

After all code implementation phases (10–70) complete but before prompt rewrite (80) and `verify_final`, the pipeline MUST include a **synthesis conformance** node that validates end-to-end coherence:

```dot
synthesis_check [shape="box", class="review", read_only="true", timeout="15m",
    prompt="Verify cross-phase coherence of the dot-builder implementation:
    1. types/index.ts exports ALL builder types (BuilderSpec, BuildResult, BuildError, Diagnostic, etc.)
    2. services/dot-builder.ts imports types from types/index.js (not a separate file)
    3. bin/dot-builder.ts imports DotBuilder from services/dot-builder.js and uses fromSpec()
    4. All 15 validation rules are implemented and tested (not just stubbed)
    5. All 28 active pattern snapshot tests exist and assert specific DOT attributes
    6. install.sh has chmod for dot-builder.js
    7. package.json test script includes dot-builder.test.js
    8. No circular imports between types → services → bin
    9. .build() called on fromSpec() output produces valid DOT that passes internal validation with 0 errors
    10. CLI contract: stdin JSON → exit 0 stdout JSON / exit 1 stderr JSON / exit 2 stderr JSON
    Output STATUS: SUCCESS if all 10 checks pass, STATUS: FAIL with specifics if any fail.",
    goal_gate="true", retry_target="fix_all", max_visits="3"]
```

**Why this matters**: Phase 40 (auto patterns) modifies `services/dot-builder.ts` which Phase 20 created. Phase 60 (CLI) imports from both Phase 10 types and Phase 20 service. Without synthesis verification, each phase's conformance passes in isolation but the integrated result may have import mismatches, missing exports, or test gaps. *(audit: fixed stale shorthand — Phase 4→40, Phase 2→20, Phase 6→60, Phase 1→10)*

### Pipeline Pattern Recommendations for /pickle-dot

When generating the pipeline from this PRD, `/pickle-dot` should apply:

| Pattern | Rationale |
|:---|:---|
| Spec-First TDD (16) | **All code phases except 65 and 75** — every code task has well-defined contracts in the Type Contracts section. Phase 65 (fallback schema) is a static data file — TDD is artificial. Phase 75 (synthesis gate) is a verification pass that produces no new code — specFirst generates test specs for code that doesn't exist in this phase. Phases 80 (prompt rewrite) and 85 (README) are doc-only — no compile target, specFirst produces no useful output. Requires explicit `specFirst: true` on non-goal-gated code phases (10, 50, 70) since Pattern 16 only defaults to true when `goalGate: true`. Phase 75 needs explicit `specFirst: false` to override the goalGate default. *(audit: excluded Phase 75 — verification-only; excluded Phase 80 — markdown file; added explicit opt-in note for non-goal-gated phases)* |
| Goal Gates (2) | **Phases 20, 30, 40, 60** — core builder, validation engine, auto patterns (highest complexity, 18 patterns), and CLI are the critical-path deliverables |
| Review Ratchet (19) | **2 passes** — the builder is a single-file service; 3+ passes have diminishing returns |
| Conformance (15) | **All phases** — each task has explicit entry/exit criteria |
| BDD Scenarios (16b) | **Applied to this pipeline's Phases 20, 30, 40** via `bddScenarios: true` on each PhaseSpec — these phases have well-defined contracts suitable for Given/When/Then scenarios. Note: the builder's Pattern 16b *implementation* is in Phase 50 (opt-in patterns); this row specifies where 16b is *used* in the generated pipeline. |
| Coverage Gate (9) | **Phase 50** (after all patterns implemented) — target ≥85% on `services/dot-builder.ts` |
| Scope Creep (10) | **All impl phases** — builder must stay in its `services/` + `bin/` + `types/` lanes |
| Red Team (17) | **Phase 75 (synthesis gate)** — `redTeam: true` on the synthesis phase. Attempts to break the builder with adversarial BuilderSpec inputs after all code phases complete but before prompt rewrite. This is the natural red team insertion point: all code exists, the red team can probe cross-phase integration and edge cases from the test expectations table. *(audit: resolved "final gate only" ambiguity — Phase 75 is the last code-facing phase)* |

Patterns **not applied to this pipeline** (the builder still implements them as opt-in for other pipelines):
- Security Scan (8) — no auth, no user input beyond JSON spec
- Competing Impls (18) — single correct implementation path
- Microverse (20) — no numeric optimization target
- Workspace Isolation (0) — same repo, no isolation needed; builder implements Pattern 0 as opt-in in Phase 50 but this pipeline uses shared workspace (default)

### Model Stylesheet Serialization Format

See the canonical `model_stylesheet` Attribute Formatting algorithm in the Contracts section (line 606). That algorithm is authoritative — property format is `${key}: ${value}` (colon-space), blocks joined with `" "` (single space). *(microverse: iter6 — removed duplicate specification that contradicted canonical algorithm on property separator and block separator)*

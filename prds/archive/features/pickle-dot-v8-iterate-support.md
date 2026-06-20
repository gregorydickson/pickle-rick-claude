# PRD: pickle-dot v8 Iterate Convergence Support

| pickle-dot v8 Iterate Support | | Teach pickle-dot and dot-builder to generate v8 convergence loops with iterate handler |
|:---|:---|:---|
| **Author**: Greg Dickson **Contributors**: Pickle Rick | **Status**: Ready | **Created**: 2026-04-11 |

## Introduction

The attractor engine now has a v8 iterate handler that enforces per-iteration monotonic convergence via Lyapunov descent. This is the core architectural change: pipelines can loop through impl -> review -> adversary cycles, rolling back workspace state when quality regresses, until V = 0 (all reviewers find nothing, adversary can't break it, mechanical gates pass).

Neither the `/pickle-dot` skill prompt nor the `dot-builder.ts` codegen module knows about this construct. PRDs that require convergence ("iterate until quality converges", "review and fix until clean") currently produce linear chains or manager_loop patterns that lack the monotonicity guarantee. This PRD adds v8 iterate awareness to both the skill and the builder.

## User Stories *(refined: requirements analyst)*

- **US1**: As a `/pickle-dot` prompt user, I want convergence PRDs to automatically generate iterate DOT so I don't hand-author iterate bodies.
- **US2**: As a `DotBuilder.fromSpec()` API consumer, I want to pass a `convergence` field and get valid iterate DOT with model diversity enforced.
- **US3**: As a pipeline author, I want the iterate body to have diverse model assignments across impl, reviewers, and adversary nodes so review quality is independent.
- **US4**: As an existing pipeline user, I want convergence to compose cleanly with workspace isolation (Pattern 0), setup (Pattern 1), and fan-out (Pattern 6) without breaking current patterns.
- **US5**: As a pipeline author, I want iterate convergence to replace the traditional endgame chain for that pipeline, not stack on top of it.
- **US6**: As a test author, I want stable node ID conventions (e.g., `iter_impl`, `iter_review_be`) so my assertions don't break when patterns compose. *(refined: requirements analyst cycle 3)*

## Problem Statement

**Current state:** pickle-dot has 31+ composition patterns. None produce iterate bodies. When a PRD mentions convergence, the skill falls back to manager_loop (polling supervisor -- wrong pattern) or linear retry chains (no rollback, no diverse review). The dot-builder has `redTeam` and `competing` flags but no `convergence` mode. *(refined: pattern count corrected from "30" to "31+")*

**Impact:** Users must hand-author iterate DOT for any convergence pipeline, defeating the purpose of the codegen system. As v8 becomes the standard convergence mechanism, this gap grows.

## Prerequisites *(refined: risk auditor + codebase analyst)*

1. **Schema update:** The builder's fallback schema (`extension/src/types/attractor-schema.fallback.ts`) has 24 node attributes. None of the 7 iterate-specific attributes are defined: `body`, `until`, `model`, `reviewer_lens`, `sealed_from_source`, `harness`, `max_iterations`. The `validateAttrs()` function at `attractor-schema.fallback.ts:126-174` will reject every iterate body node attribute as `unknown node attribute`.

   **Resolution:** Run `npm run sync-schema` against attractor v8 `schema.json` that includes iterate attributes. If attractor schema.json is not yet updated, manually add 7 attributes to `attractor-schema.fallback.ts` as a stopgap (Ticket T0).

2. **Subgraph emission capability:** The builder currently emits flat `nodes[]`/`edges[]` only. The `_emitDot()` method at `dot-builder.ts:1106-1921` has zero subgraph emission -- grep for `subgraph` returns only the reserved word list at line 130. R3 requires `subgraph cluster_*` blocks. This is the single largest architectural prerequisite (Ticket T1).

## Scope

**In scope:**
- New pattern (Pattern 32) in `pickle-dot-patterns.md` for iterate convergence loops *(refined: Pattern 25 = Catastrophic Recovery, Pattern 31 = Node Scope Decomposition; next available is 32)*
- Detection heuristic in `pickle-dot.md` for when to emit iterate vs other patterns
- `dot-builder.ts` support for emitting iterate nodes with body subgraphs
- Model diversity assignment for reviewer + adversary slots via `model_stylesheet` class-based routing *(refined: per-node `model` attribute is unprecedented in builder; use existing stylesheet infrastructure)*
- Schema fallback update for 7 iterate-specific node attributes
- Subgraph emission primitive in `dot-builder.ts`
- Endgame chain + P25 catastrophic recovery suppression when convergence active
- Validation that generated iterate DOT passes internal 16-rule grRule validation

**Out of scope:**
- Attractor engine changes (v8 iterate handler already complete)
- DOT_SCHEMA.md changes (v8 already documented in attractor)
- Phase 2 node types (octagon/verify, judge_criteria, exit_hooks)
- Fixed-point and reproducibility verify handlers
- Per-phase convergence (multi-phase convergence semantics deferred to Phase 2)
- `attractor validate` CLI integration (demoted to P1 -- `attractor validate --format json` doesn't exist yet; internal grRule validation is the P0 gate) *(refined: risk auditor, consistent with codegen builder PRD)*
- Microverse convergence (`MicroverseSessionState.convergence` at `types/index.ts:273-293`) is a separate concept -- metric-based stall detection. Not modified by this PRD. *(refined: risk auditor)*

## Requirements

### R1 (P0): pickle-dot Pattern -- Convergence Loop *(refined: priority tier added)*

Add Pattern 32 to `.claude/commands/pickle-dot-patterns.md` *(refined: source path, not deployed path)*:

**Detection signals in PRD:** "converge until", "iterate until clean", "review until zero findings", "monotonic improvement", "rollback on regression", "Lyapunov" *(refined: removed ambiguous signals "converge" alone, "iterate" alone, "quality gate" alone, "adversarial" alone per requirements analyst conflict analysis)*

**Pattern emits:**
```dot
converge [shape=house, class="iterate",
          body="iter-body",
          until="V_total == 0 && fixed_point && reproducibility",
          max_visits=20, timeout=60m]

subgraph cluster_iter_body {
  label="iter-body"

  iter_impl [class="impl",
        prompt="${IMPL_PROMPT}", harness="${IMPL_HARNESS}",
        timeout=600s, max_visits=10]

  iter_review_be [class="honest_review", reviewer_lens="backend",
             prompt="Review backend quality: correctness, error handling, edge cases.",
             read_only=true, timeout=300s, max_visits=10]

  iter_review_fe [class="honest_review", reviewer_lens="frontend",
             prompt="Review frontend quality: UX, accessibility, rendering.",
             read_only=true, timeout=300s, max_visits=10]

  iter_review_int [class="honest_review", reviewer_lens="integration",
              prompt="Review integration: API contracts, data flow, cross-module consistency.",
              read_only=true, timeout=300s, max_visits=10]

  iter_adversary [class="adversary",
             sealed_from_source="src/**,test/**,lib/**",
             prompt="Attack the implementation blind. Probe for edge cases, injection, missing validation.",
             read_only=true, timeout=300s, max_visits=10]

  iter_impl -> iter_review_be -> iter_review_fe -> iter_review_int -> iter_adversary
}

converge -> iter_impl
```

*(refined: multiple changes)*
- Node IDs namespaced with `iter_` prefix to prevent collision with phase-scoped `impl_${sanitizeId(phase.name)}` at `dot-builder.ts:1462` *(codebase analyst)*
- Per-node `model` attributes removed -- model diversity handled via `model_stylesheet` graph-level class selectors (existing builder pattern at `dot-builder.ts:1084-1103`). The builder emits zero per-node `model` attributes; `model_stylesheet` with class-based routing (`.impl { llm_model: X; }`, `.honest_review { llm_model: Y; }`, `.adversary { llm_model: Z; }`) is the established mechanism. *(codebase analyst + risk auditor)*
- `timeout` uses `60m` format (builder validates `<number><m|h|d>`, not `3600s`) *(codebase analyst)*
- Edge `weight=1` removed -- not in either schema file, zero builder usage *(codebase analyst)*

**Constraints:**
- Model diversity enforced via stylesheet: impl, honest_review, and adversary class selectors MUST map to distinct model IDs in the `model_stylesheet`
- Reviewers must cover all three lenses: `backend`, `frontend`, `integration`
- Adversary must have `sealed_from_source` with globs covering implementation source
- `until` predicate must be one of the canonical set: `"V_total == 0"`, `"V_total == 0 && fixed_point"`, `"V_total == 0 && fixed_point && reproducibility"`
- `harness` on impl node is typically `"hermes"` (OpenRouter) or `"claude-code"` (high-correctness) *(removed `forgecode` -- zero codebase references, phantom enum value)*

### R2 (P0): pickle-dot Skill Detection *(refined: priority tier added)*

Update `.claude/commands/pickle-dot.md` Step 2 (pattern selection) to detect convergence signals and route to the iterate pattern:

**New detection table row (paste-ready):** *(refined: requirements analyst)*
```
| "converge until", "iterate until clean", "review until zero findings", "monotonic improvement", "rollback on regression", "Lyapunov" | 32 (iterate convergence) -- replaces standard endgame for that phase. NOT triggered by "iterate" alone, "quality gate" alone, or "adversarial" alone. When both microverse (P20) and iterate signals present: numeric metric target -> P20, qualitative review convergence -> P32, both -> split into separate phases |
```

**Conflict resolution rules:** *(refined: requirements analyst)*
- "quality gate" + numeric metric -> P20 (microverse), NOT P32
- "adversarial testing" alone -> P17 (red team), NOT P32. When both convergence + adversarial signals present -> P32 (iterate body contains adversary; P17 suppressed)
- If PRD specifies quality criteria -> map to reviewer lens prompts
- If PRD specifies security/robustness requirements -> configure adversary `sealed_from_source` scope
- Default `until` predicate: `"V_total == 0 && fixed_point && reproducibility"` (full convergence)
- Default `max_visits`: 20 iterations

### R3 (P0): dot-builder.ts ConvergenceSpec *(refined: priority tier added)*

**Placement: `BuilderSpec` (pipeline-level), not `PhaseSpec`.** *(refined: all 3 analysts converge on BuilderSpec for v1)*

Rationale: Placing on `PhaseSpec` requires multi-phase convergence semantics (sequential chaining, node ID namespacing per phase, partial endgame suppression) that dramatically expand scope. `BuilderSpec` placement eliminates all multi-phase questions, aligns with `microverse`/`endgame` precedent on `InternalSpec` (`dot-builder.ts:872-887`), and is the simplest v1 path. Per-phase convergence deferred to Phase 2.

Add to `BuilderSpec` (`types/index.ts:450`) and `InternalSpec` (`dot-builder.ts:872`):

```typescript
interface ConvergenceSpec {
  /** until predicate -- one of the canonical set */
  until: 'V_total == 0' | 'V_total == 0 && fixed_point' | 'V_total == 0 && fixed_point && reproducibility';
  /** max iterations before giving up */
  maxVisits?: number;  // default 20
  /** timeout for entire convergence loop */
  timeout?: string;    // default "60m"
  /** impl node configuration */
  impl: {
    harness: 'hermes' | 'claude-code';
    prompt: string;
  };
  /** glob patterns to seal from adversary */
  sealedFromSource?: string;  // default "src/**,test/**,lib/**"
}
```

*(refined: multiple changes)*
- Removed `impl.model`, `reviewerModels`, `adversaryModel` -- model assignment uses existing `model_stylesheet` class-based routing, not per-node attributes *(codebase analyst)*
- Removed `forgecode` from harness union *(risk auditor -- zero codebase references)*
- Field name `maxVisits` (not `maxIterations`) -- consistent with existing builder usage (18 occurrences in `dot-builder.ts`) and both schema files *(risk auditor)*

**Builder method:** `convergence(spec: ConvergenceSpec): this` -- fluent API consistent with `workspace()`, `microverse()`, `endgame()`.

**`fromSpec()` wiring** (`dot-builder.ts:897-941`): Add convergence block after endgame (line 939) to wire JSON spec input. Without this, CLI consumers via `dot-builder-cli.ts` cannot use convergence. *(refined: codebase analyst -- fromSpec was missing from Files to Modify)*

**Subgraph emission primitive** (prerequisite): *(refined: codebase analyst)*
The builder has zero subgraph emission capability. Add `emitSubgraph(clusterId, label, emitter)` to `_emitDot()` that:
1. Wraps emitted nodes in `subgraph cluster_${clusterId} { label="${label}" ... }`
2. Registers body nodes in `nodeMap` AND body edges in `edgeList` for validation -- grRule3 BFS at `dot-builder.ts:442-463` must be able to reach body nodes through edges, not just the `body` attribute pointer *(risk auditor)*
3. Emits `subgraphBlocks[]` between graph attrs and top-level nodes in the final DOT assembly at lines 1905-1918

When `convergence` is present on `BuilderSpec`, the builder emits:
1. A `shape=house, class="iterate"` node with `body`, `until`, `max_visits`, `timeout`
2. A `subgraph cluster_iter_body` with label `"iter-body"`
3. Inside: `iter_impl` + 3 `iter_review_*` honest_review nodes + 1 `iter_adversary` node, sequentially chained
4. An edge from `converge` to `iter_impl` (for reachability)

**Node ID convention:** All body nodes prefixed `iter_` -- `iter_impl`, `iter_review_be`, `iter_review_fe`, `iter_review_int`, `iter_adversary`. Add `converge` + all 5 body IDs to `RESERVED_IDS` (`dot-builder.ts:150-156`). *(refined: codebase analyst)*

### R4 (P1): Model Diversity Enforcement *(refined: priority tier added)*

Model diversity is enforced at the `model_stylesheet` level:
- The builder validates that `model_stylesheet` contains distinct model IDs for `.impl`, `.honest_review`, and `.adversary` class selectors when convergence is active
- If stylesheet doesn't specify overrides for these classes, builder uses a curated default set of diverse models
- Builder throws `BuildError` with code `'DUPLICATE_MODEL'` if any two convergence-relevant class selectors map to the same model ID

**New `BuildErrorCode` values** (add to `types/index.ts:321-345` AND `dot-builder.ts:20-28`): *(refined: codebase analyst)*
- `'DUPLICATE_MODEL'` -- thrown when convergence class selectors share a model ID
- `'INVALID_CONVERGENCE_SPEC'` -- thrown when `ConvergenceSpec` fails structural validation (e.g., invalid `until` predicate)

### R5 (P1): Integration with Existing Patterns *(refined: priority tier added)*

The iterate convergence pattern composes with existing patterns:
- **Pattern 0 (Isolated Workspace):** `commit_and_push` runs AFTER iterate converges: `converge -> commit_and_push -> quality_review -> exit`
- **Pattern 1 (Setup):** Setup nodes run before the iterate node: `setup_deps -> converge -> ...`
- **Pattern 6 (Fan-out/Fan-in):** Fan-out can precede iterate for parallel pre-processing
- Iterate node replaces the traditional `impl -> verify -> check -> fix` loop -- do NOT emit both

**Endgame chain behavior when convergence is active:** *(refined: requirements + codebase + risk analysts)*
- `emitEndgameChain()` (called at `dot-builder.ts:1802`) is NOT called -- iterate body handles all quality verification
- **P25 (Catastrophic Recovery) is suppressed** -- iterate's Lyapunov rollback subsumes it. Add `!hasConvergence` to the P25 guard condition at `dot-builder.ts:1812`: `if (!isFanOut && !hasCompeting && !hasConvergence && implPhases.length > 0)`
- Post-convergence routing: `converge -> quality_review -> exit` (or with Pattern 0: `converge -> commit_and_push -> quality_review -> exit`)
- `regression_check` node is NOT emitted; grRule3 reachability satisfied via `converge -> quality_review` path
- AC key distribution (lines 1254-1259) moved to iterate body's `iter_impl` node when convergence active

**Red team interaction:** *(refined: risk auditor)*
- When convergence is active on a pipeline, `PhaseSpec.redTeam=true` is suppressed on all phases -- the iterate body's adversary subsumes P17 red team review. Do not emit both.

**R5's "do NOT emit both" enforcement mechanism:** *(refined: risk auditor)*
- The per-phase emission loop at `dot-builder.ts:1586-1768` must detect convergence and skip the traditional `impl -> verify -> fix` block, routing instead to the iterate node. A `hasConvergence` boolean (set when `spec.convergence` is present) gates the emission path.

**grRule updates:** *(refined: codebase + risk analysts)*
- grRule3 (reachability at lines 442-463): body nodes are reachable via `converge -> iter_impl` edge + body-internal edges in `edgeList`. No exemption needed IF body edges are properly registered.
- grRule7 (codergen timeout): add `class="impl"` check for body impl node
- grRule9 (review readonly): add `class="honest_review"` and `class="adversary"` checks

## Interface Contracts

### pickle-dot-patterns.md
**Input:** PRD text with convergence signals
**Output:** DOT fragment with iterate node, body subgraph, 5 class-routed nodes with `iter_` prefix
**Validation:** Generated DOT passes internal 16-rule grRule validation

### dot-builder.ts
**Input:** `BuilderSpec` with `convergence: ConvergenceSpec`
**Output:** Valid DOT string with iterate construct
**Errors:**
- Duplicate stylesheet models for convergence classes -> `BuildError` code `'DUPLICATE_MODEL'`
- Invalid `ConvergenceSpec` (bad `until` predicate, missing fields) -> `BuildError` code `'INVALID_CONVERGENCE_SPEC'`
**Invariants:** All three reviewer lenses present; adversary has `sealed_from_source`; body nodes registered in `nodeMap`/`edgeList`

### ConvergenceSpec type (`types/index.ts`)
**Input shape:** See R3 interface definition
**Output:** Consumed by `DotBuilder.convergence()` and `DotBuilder.fromSpec()`
**Validation:** `until` must be one of 3 canonical predicates; `harness` must be `'hermes' | 'claude-code'`

## Acceptance Criteria

| ID | Criterion | Verification |
|----|-----------|-------------|
| AC1 | `pickle-dot-patterns.md` contains Pattern 32 convergence loop with iterate body example | Grep for `class="iterate"` in `.claude/commands/pickle-dot-patterns.md` |
| AC2a | `pickle-dot.md` Step 2 detection table contains convergence row with Pattern 32 routing | Grep for `iterate convergence` in `.claude/commands/pickle-dot.md` |
| AC2b | `pickle-dot.md` conflict resolution rules documented for P20/P17 overlap | Grep for `DUPLICATE_MODEL` or `P20` conflict in `.claude/commands/pickle-dot.md` |
| AC3 | `dot-builder.ts` accepts `ConvergenceSpec` and emits valid iterate DOT | Unit test: `const result = DotBuilder.fromSpec({ slug: 'iter-test', goal: 'test convergence', phases: [{name: 'core', prompt: 'implement', allowedPaths: ['src/']}], acceptanceCriteria: {done: 'converged'}, convergence: {until: 'V_total == 0 && fixed_point && reproducibility', impl: {harness: 'claude-code', prompt: 'Implement'}} }).build(); assert(result.dot.includes('class="iterate"')); assert(result.dot.includes('subgraph cluster_'))` *(refined: corrected API from `buildPipeline()` to `DotBuilder.fromSpec().build()` per actual codebase)* |
| AC4 | *(P1)* Generated DOT passes `attractor validate` when available | Integration test: pipe builder output to `attractor validate --graph /dev/stdin` *(refined: demoted from P0 -- `attractor validate --format json` doesn't exist yet)* |
| AC5 | Model diversity enforced -- duplicate stylesheet models for convergence classes rejected | Unit test: configure `modelStylesheet` with same model for `.impl` and `.honest_review`, assert `BuildError` with code `'DUPLICATE_MODEL'` thrown |
| AC6 | All three reviewer lenses present in generated body | Unit test: assert `reviewer_lens="backend"`, `reviewer_lens="frontend"`, `reviewer_lens="integration"` all present in output |
| AC7 | Adversary has `sealed_from_source` in generated body | Unit test: assert adversary node contains `sealed_from_source` attribute |
| AC8 | Iterate pattern composes with Pattern 0 (commit_and_push after convergence) | Unit test: convergence + isolated workspace -> `converge -> ... -> commit_and_push -> quality_review -> exit` |
| AC9 | `npm test` passes with 0 failures | CI *(refined: corrected from `bun test` -- zero bun config in repo)* |
| AC10 | `npx eslint src/ --max-warnings=-1` passes with 0 errors | CI *(refined: corrected from `bun run lint`)* |
| AC11 | Duplicate model -> `BuildError` with code `'DUPLICATE_MODEL'` | Unit test *(refined: added failure-state AC)* |
| AC12 | Traditional `impl -> verify -> fix` loop NOT emitted when convergence active | Unit test: assert no `verify_typecheck`, `fix_types` etc. in convergence pipeline *(refined: added)* |
| AC13 | Invalid `until` predicate rejected | Unit test: ConvergenceSpec with `until: 'custom_predicate'` -> `BuildError` code `'INVALID_CONVERGENCE_SPEC'` *(refined: added)* |
| AC14 | P25 catastrophic recovery NOT emitted when convergence active | Unit test: assert no `regression_check -> setup_deps` edge in convergence pipeline *(refined: added)* |
| AC15 | Setup nodes (Pattern 1) precede iterate node | Unit test: spec with setup + convergence -> `setup_deps -> converge -> quality_review -> exit` *(refined: added per requirements analyst -- R5 Pattern 1 had no AC)* |

## Files to Modify *(refined: corrected to source paths, expanded per analyst findings)*

| File | Changes |
|------|---------|
| `.claude/commands/pickle-dot-patterns.md` | Add Pattern 32: Convergence Loop via iterate |
| `.claude/commands/pickle-dot.md` | Add convergence detection row in Step 2, conflict resolution rules |
| `extension/src/services/dot-builder.ts` | Subgraph emission primitive, convergence method + iterate emission, fromSpec() wiring (after line 939), endgame/P25 suppression, model diversity validation, RESERVED_IDS update, hasConvergence gate in phase emission |
| `extension/src/types/index.ts` | `ConvergenceSpec` interface, `convergence?` field on `BuilderSpec`, `'DUPLICATE_MODEL'` + `'INVALID_CONVERGENCE_SPEC'` BuildErrorCodes |
| `extension/src/types/attractor-schema.fallback.ts` | Add 7 iterate-specific node attributes: `body`, `until`, `model`, `reviewer_lens`, `sealed_from_source`, `harness`, `max_iterations` |
| `extension/tests/dot-builder-iterate.test.js` | Unit tests for iterate convergence generation (NOT `dot-builder.test.ts` -- all tests are `extension/tests/*.test.js`) |
| `extension/package.json` | Register `dot-builder-iterate.test.js` in test script array (line 13) |

**Post-implementation:** Run `bash install.sh` to deploy command changes.

## Risks *(refined: corrected severities, added missing risks per risk auditor)*

| Risk | Severity | Mitigation |
|------|----------|------------|
| Subgraph refactor destabilizes 55+ existing tests | **High** | The builder has zero subgraph code. Adding `emitSubgraph()` touches the DOT assembly pipeline every test depends on. Run full test suite after subgraph primitive, before iterate-specific work. |
| Internal validation rejects iterate attributes | **High** | 7 of 8 iterate-specific attributes missing from both schema files. `validateAttrs()` flags all as errors. Update schema as prerequisite ticket T0. |
| grRule3 reachability rejects body nodes | **High** | Body-internal edges may not register in `edgeList`. Design: body edges MUST be added to `edgeList` for validation, even though they render inside subgraph. |
| Model list goes stale (OpenRouter free models rotate) | Medium | User can override via `modelStylesheet` in spec; defaults are advisory. |
| Convergence detection false positives | **Medium** | Detection signals refined to multi-word phrases only ("converge until", "iterate until clean"). Single words excluded. User reviews generated DOT before submission. *(refined: severity raised from Low)* |
| Long convergence loops burn tokens | **Medium** | `max_visits=20` caps cost. Worst case: 20 iterations x 5 nodes x 10 visits = 1000 node executions. Document cost estimation in pipeline README. |
| Per-node `model` vs `model_stylesheet` precedence | **Medium** | Resolved: use `model_stylesheet` class-based routing (existing pattern). No per-node `model` attributes. |
| Convergence suppresses endgame but P25 references endgame nodes | **Medium** | P25 references `regression_check` which lives inside endgame chain. Add `!hasConvergence` to P25 guard condition. |

## Test Expectations

| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| ConvergenceSpec emission | `extension/tests/dot-builder-iterate.test.js` | Build spec with convergence | Output contains `class="iterate"`, `body=`, `until=`, `subgraph cluster_iter_body` |
| Model diversity | `extension/tests/dot-builder-iterate.test.js` | Stylesheet with duplicate convergence models | Throws `BuildError` code `'DUPLICATE_MODEL'` |
| Reviewer lenses | `extension/tests/dot-builder-iterate.test.js` | Build convergence spec | All 3 lenses present: `reviewer_lens="backend"`, `"frontend"`, `"integration"` |
| Adversary sealed | `extension/tests/dot-builder-iterate.test.js` | Build convergence spec | `sealed_from_source` present on adversary node |
| Invalid until | `extension/tests/dot-builder-iterate.test.js` | Bad `until` predicate | Throws `BuildError` code `'INVALID_CONVERGENCE_SPEC'` |
| Endgame suppressed | `extension/tests/dot-builder-iterate.test.js` | Convergence active | No `verify_typecheck`, `fix_types`, `regression_check` in output |
| P25 suppressed | `extension/tests/dot-builder-iterate.test.js` | Convergence active | No `regression_check -> setup_deps` edge |
| Pattern 0 composition | `extension/tests/dot-builder-iterate.test.js` | Convergence + isolated workspace | `converge -> ... -> commit_and_push -> quality_review -> exit` |
| Pattern 1 composition | `extension/tests/dot-builder-iterate.test.js` | Convergence + setup | `setup_deps -> converge -> quality_review -> exit` |
| Node ID stability | `extension/tests/dot-builder-iterate.test.js` | Check body node IDs | `iter_impl`, `iter_review_be`, `iter_review_fe`, `iter_review_int`, `iter_adversary` |

## Implementation Task Breakdown

| Order | ID | Title | Priority | Entry | Exit | Files |
|-------|-----|-------|----------|-------|------|-------|
| 10 | b6cfb3a1 | Add iterate-specific attributes to fallback schema | High | None | 31 node attrs, validateAttrs accepts iterate attrs | attractor-schema.fallback.ts |
| 20 | 76adc680 | Add Pattern 32 convergence loop to pickle-dot-patterns.md | Medium | None | Pattern 32 documented | pickle-dot-patterns.md |
| 30 | b08ac375 | Add convergence detection row to pickle-dot.md | Medium | None | Detection row + conflict rules | pickle-dot.md |
| 40 | 80ed4002 | Add ConvergenceSpec type and BuildErrorCodes | High | None | Types exported, error codes defined | types/index.ts, dot-builder.ts |
| 50 | 8f5304c5 | Add subgraph emission primitive to dot-builder | High | T0 | emitSubgraph() in _emitDot(), 55+ tests pass | dot-builder.ts |
| 60 | 3b3743e6 | Implement iterate emission with endgame/P25 suppression | High | T0, T3, T4 | Full iterate emission, endgame/P25/redTeam suppressed | dot-builder.ts |
| 70 | 61fba263 | Add model diversity enforcement for convergence | Medium | T3, T5 | DUPLICATE_MODEL thrown on duplicate stylesheet models | dot-builder.ts |
| 80 | 32a8ab98 | Add unit tests for iterate convergence | High | T5, T6 | 10+ tests passing, registered in package.json | dot-builder-iterate.test.js, package.json |
| 90 | f0ad3098 | Wire: integrate all modules into working dot-builder | High | ALL impl | Full integration verified, install.sh deployed | All modified files |
| 100 | 573f0090 | Harden: code quality review of iterate convergence | High | ALL + wiring | Zero P0-P1 violations | All modified files |
| 110 | 743e1904 | Audit: data flow integrity for iterate convergence | High | ALL + harden | Zero CRITICAL/HIGH findings | All modified files |

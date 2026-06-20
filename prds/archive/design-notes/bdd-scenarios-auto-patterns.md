# BDD Scenarios for Auto-Pattern Implementation

Generated from PRD: `pickle-dot-codegen-builder.md`
Auto-Pattern Implementation Detail Table (lines 227-249)

---

## Pattern 0a: Dependency Setup (Auto)

**Given** a pipeline author who defines any spec  
**When** the builder generates the pipeline  
**Then** it automatically includes a `setup_deps` node for dependency installation

**Acceptance Criteria:**
- Node name: `setup_deps`
- Placement: After `start`, before first phase
- Attributes: `tool_command` with package manager detection (npm/pnpm/yarn)
- Pattern in `patternsApplied`: `"0a"`
- No BuilderSpec field controls emission; always emitted

---

## Pattern 0b: Parallel Limit (Auto)

**Given** a pipeline author who uses component fan-out (Pattern 4)  
**When** the pipeline is generated  
**Then** each component node has `max_parallel=1` to prevent resource conflicts

**Acceptance Criteria:**
- Applies to: `split_phases` and per-phase `component` nodes
- Attribute: `max_parallel="1"` injected as attribute (not separate node)
- Pattern in `patternsApplied`: `"0b"` only when fan-out nodes exist
- No BuilderSpec field controls emission; only appears when Pattern 4 is active

---

## Pattern 0c: Baseline Snapshot (Auto)

**Given** any spec  
**When** the builder generates the pipeline  
**Then** it includes a `capture_baseline` node that snapshots lint and typecheck error counts

**Acceptance Criteria:**
- Node name: `capture_baseline`
- Placement: After `setup_deps`, before first impl
- Attributes: `tool_command` captures `tsc --noEmit` and `eslint` error counts to `/tmp/baseline_*.txt`
- Pattern in `patternsApplied`: `"0c"`
- No BuilderSpec field controls emission; always emitted

---

## Pattern 0d: Delta-Aware Verify (Auto)

**Given** a pipeline author who defines phases  
**When** verify nodes are generated  
**Then** they compare against the baseline to detect regressions (delta-aware)

**Acceptance Criteria:**
- Nodes affected: `verify_lint_${phase}`, `verify_types_${phase}`
- Command modification: Prepend `BASELINE=$(cat /tmp/baseline_*.txt 2>/dev/null || echo 0) &&`
- Command modification: Append `&& CURRENT=$(...) && [ $CURRENT -le $BASELINE ]`
- Pattern in `patternsApplied`: `"0d"`
- No BuilderSpec field controls emission; always emitted for verify nodes

---

## Pattern 0e: Progress Gate (Auto)

**Given** a pipeline author who defines phases  
**When** the builder generates the pipeline  
**Then** each phase gets a `check_progress` node to detect stalled implementations

**Acceptance Criteria:**
- Node name: `check_progress_${phase}`
- Placement: After each impl node, before `verify_lint`
- Attributes:
  - `tool_command`: `cd ${WORKING_DIR} && [ $(git status --porcelain | wc -l) -gt 0 ] && echo 'STATUS: SUCCESS' || echo 'STATUS: FAIL'`
  - `read_only=true`
  - `max_visits=3`
- Pattern in `patternsApplied`: `"0e"`
- No BuilderSpec field controls emission; always emitted for every phase

---

## Pattern 1: Test-Fix Loops (Auto)

**Given** a pipeline author who defines a phase  
**When** the builder generates the pipeline  
**Then** it creates a test-fix loop with diamond gate for iterative correction

**Acceptance Criteria:**
- Node sequence: `test_${phase}` → diamond → `fix_${phase}`
- Edges:
  - `test_${phase} -> check_progress_${phase} [outcome="success"]`
  - `test_${phase} -> fix_${phase} [outcome="fail"]`
  - `fix_${phase} -> impl_${phase}` (retry loop)
- Pattern in `patternsApplied`: `"1"`
- No BuilderSpec field controls emission; always emitted per phase

---

## Pattern 3: Conditional Routing (Auto)

**Given** any generated diamond node  
**When** the builder validates  
**Then** it ensures at least 2 outgoing edges

**Acceptance Criteria:**
- Validation rule: Rule 4 (DIAMOND_MISSING_EDGES)
- At least 2 outgoing edges required
- Pattern in `patternsApplied`: `"3"`
- No BuilderSpec field controls emission; always validated on diamond nodes

---

## Pattern 4: Fan-Out/Fan-In (Auto)

**Given** a pipeline author who defines 2+ phases with no dependencies between them  
**When** the builder generates the pipeline  
**Then** it creates a fan-out topology with `split_phases`/`merge_phases` nodes for parallel execution

**Acceptance Criteria:**
- Trigger: ≥2 phases have no `dependsOn` relationship
- Nodes: `split_phases [shape=component, max_parallel=1]` and `merge_phases [shape=tripleoctagon]`
- Edges: `split_phases → impl_a`, `split_phases → impl_b`, ... → `merge_phases`
- Pattern in `patternsApplied`: `"4"`
- No BuilderSpec field controls emission; inferred from phase dependencies

---

## Pattern 6: Max Visits (Auto)

**Given** nodes with incoming retry edges  
**When** the builder finalizes the pipeline  
**Then** it injects `max_visits` to prevent infinite loops

**Acceptance Criteria:**
- Trigger: node has ≥1 incoming edge from a diamond non-success outcome (any outcome except `"success"` or `"clean"`) or a `retry_target` reference
- Default: `max_visits="5"`
- Does not overwrite explicit `max_visits` from other patterns (e.g., Pattern 0e sets `max_visits=3`)
- Pattern in `patternsApplied`: `"6"`
- No BuilderSpec field controls emission; injected at build time

---

## Pattern 6b: Read-Only + STATUS (Auto)

**Given** review nodes  
**When** the builder finalizes  
**Then** it ensures `read_only=true` and STATUS markers in prompts

**Acceptance Criteria:**
- Applies to: all `class="review"` nodes (review, conformance, security_scan, coverage_check, etc.)
- Attributes: `read_only=true` injected
- Prompt modification: Append `\nOutput STATUS: SUCCESS or STATUS: FAIL on its own line.`
- Pattern in `patternsApplied`: `"6b"`
- No BuilderSpec field controls emission; always applied to review nodes

---

## Pattern 10: Scope Creep (Auto)

**Given** each implementation phase  
**When** the builder generates the pipeline  
**Then** it adds a `scope_check` node after impl to verify file changes are in-scope

**Acceptance Criteria:**
- Node name: `scope_check_${phase}`
- Placement: After impl, before review ratchet (or before fix_all if no ratchet)
- Attributes:
  - `class="review"`
  - `read_only=true`
  - Prompt: `Compare git diff against phase prompt. Flag files modified outside allowed_paths. Output STATUS: SUCCESS | FAIL.`
- Pattern in `patternsApplied`: `"10"`
- No BuilderSpec field controls emission; always emitted per phase

---

## Pattern 13: Lint Gate (Auto)

**Given** the verify chain  
**When** generated  
**Then** it includes a lint gate to catch style regressions

**Acceptance Criteria:**
- Node name: `verify_lint_${phase}`
- Placement: After `check_progress`, before `verify_types`
- Attributes: Delta-aware lint command (Pattern 0d applies)
- Pattern in `patternsApplied`: `"13"`
- No BuilderSpec field controls emission; always emitted in verify chain

---

## Pattern 14: Type-Check Gate (Auto)

**Given** the verify chain  
**When** generated  
**Then** it includes a typecheck gate to catch type regressions

**Acceptance Criteria:**
- Node name: `verify_types_${phase}`
- Placement: After `verify_lint`, before `test_${phase}`
- Attributes: Delta-aware typecheck command (Pattern 0d applies)
- Pattern in `patternsApplied`: `"14"`
- No BuilderSpec field controls emission; always emitted in verify chain

---

## Pattern 15: Conformance Audit (Auto)

**Given** each phase  
**When** the builder generates the pipeline  
**Then** it adds a `conformance` node to verify spec compliance

**Acceptance Criteria:**
- Node name: `conformance_${phase}`
- Placement: After `scope_check`, before review ratchet (or before fix_all if no ratchet)
- Attributes:
  - `class="review"`
  - `read_only=true`
  - `timeout="15m"`
  - Prompt: `Review the implementation against the phase spec and PRD requirements. Check: correct files modified, API contracts match, no regressions. Output STATUS: SUCCESS | FAIL.`
- Pattern in `patternsApplied`: `"15"`
- No BuilderSpec field controls emission; always emitted per phase

---

## Pattern 21: Fix All (Auto)

**Given** the final pipeline structure  
**When** generated  
**Then** `fix_all` precedes `verify_final` as a last-resort repair step

**Acceptance Criteria:**
- Node name: `fix_all`
- Placement: Before `verify_final`, after all phases (and ratchet if present)
- Attributes:
  - `shape="box"`
  - `class="codergen"`
  - `timeout="30m"`
  - `allowed_paths` = union of all phase paths
  - `escalate_on` = union of all phase escalate_on values
  - `permission_mode="auto"`
- No explicit `prompt` or `tool_command` — attractor injects retry context
- Pattern in `patternsApplied`: `"21"`
- No BuilderSpec field controls emission; always emitted

---

## Pattern 22: Permission Scoping (Auto)

**Given** code-generation nodes  
**When** the builder generates the pipeline  
**Then** it injects `allowed_paths` and permission scoping for safety

**Acceptance Criteria:**
- Applies to: all `class="codergen"` nodes (per-phase and cross-phase)
- Per-phase nodes:
  - `allowed_paths` from `PhaseSpec.allowedPaths` (with test dir heuristic)
  - `escalate_on` from `PhaseSpec.escalateOn` (default: `["package.json","*.lock","*.config.*"]`)
  - `permission_mode="auto"`
- Cross-phase nodes (`fix_all`, `fix_review`, `verify_final`):
  - `allowed_paths` = union of all phase paths
  - `escalate_on` = union of all phase escalate_on values
- Pattern in `patternsApplied`: `"22"`
- No BuilderSpec field controls emission; always injected

---

## Pattern 23: Defense Matrix (Auto)

**Given** any generated pipeline  
**When** `.build()` completes  
**Then** it includes a defense matrix comment block documenting which safety layers are active

**Acceptance Criteria:**
- Placement: After graph-level attributes, before first node
- Format: `/* DEFENSE MATRIX\n * competitive: ${bool}\n * guardrails: ${list}\n * specDriven: ${string}\n * permissions: ${list}\n * adversarial: ${bool}\n */`
- Computed from `DefenseMatrix` values during `.build()`:
  - `specDriven`: `"NONE"` (zero-phase) | `"conformance"` | `"BDD + conformance"` | `"spec_file + conformance"` | `"spec_file + BDD + conformance"`
  - `competitive`: true if any phase has `competing: true`
  - `adversarial`: true if any phase has `redTeam: true`
  - `guardrails`: `"max_visits"`, `"no-op"`, `"read_only"` (collect from active patterns)
  - `permissions`: `"allowed_paths"`, `"escalate_on"` (collect from Pattern 22)
- Pattern in `patternsApplied`: `"23"`
- No BuilderSpec field controls emission; always emitted

---

## Pattern 25: Catastrophic Recovery (Auto)

**Given** a pipeline with retry loops  
**When** the builder generates the pipeline  
**Then** it adds a catastrophic recovery edge to prevent infinite retry cascades

**Acceptance Criteria:**
- Applies to: `verify_final` → `setup_deps` edge
- Attribute: `loop_restart="true"`
- Trigger: pipeline contains any retry loop (node with incoming retry edge or referenced by `retry_target`)
- NOT emitted for zero-phase pipelines (explicit carve-out)
- Pattern in `patternsApplied`: `"25"`
- No BuilderSpec field controls emission; injected at build time based on graph structure

---

## Summary

| Pattern ID | Pattern Name | Trigger | BuilderSpec Control | `patternsApplied` Entry |
|-----------:|--------------|---------|---------------------|------------------------|
| 0a | Dependency Setup | Any spec | None | Always `"0a"` |
| 0b | Parallel Limit | Fan-out active | None | Only when Pattern 4 active |
| 0c | Baseline Snapshot | Any spec | None | Always `"0c"` |
| 0d | Delta-Aware Verify | Phases exist | None | Always `"0d"` |
| 0e | Progress Gate | Phases exist | None | Always `"0e"` |
| 1 | Test-Fix Loops | Phases exist | None | Always `"1"` |
| 3 | Conditional Routing | Diamond nodes | None | Always `"3"` |
| 4 | Fan-Out/Fan-In | ≥2 independent phases | None | Only when applicable |
| 6 | Max Visits | Retry loops | None | Only when loops exist |
| 6b | Read-Only + STATUS | Review nodes | None | Always `"6b"` |
| 10 | Scope Creep | Phases exist | None | Always `"10"` |
| 13 | Lint Gate | Phases exist | None | Always `"13"` |
| 14 | Type-Check Gate | Phases exist | None | Always `"14"` |
| 15 | Conformance Audit | Phases exist | None | Always `"15"` |
| 21 | Fix All | Any pipeline | None | Always `"21"` |
| 22 | Permission Scoping | Codergen nodes | None | Always `"22"` |
| 23 | Defense Matrix | Any pipeline | None | Always `"23"` |
| 25 | Catastrophic Recovery | Retry loops exist | None | Only when loops exist |

STATUS: SUCCESS

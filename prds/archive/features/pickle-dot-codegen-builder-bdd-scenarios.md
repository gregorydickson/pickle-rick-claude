# Pickle-Dot Codegen Builder BDD Scenarios

From a pipeline author's perspective — what happens when the builder auto-applies patterns.

---

## Auto Pattern Scenarios

### Pattern 0a: Dependency Setup (Always Emitted)

```
Feature: Dependency Installation
  As a pipeline author
  I want dependencies to be installed before implementation
  So that my build has all required packages

  Scenario: Pipeline automatically includes setup_deps node
    Given a pipeline author defines any spec with at least one phase
    When the builder generates the pipeline
    Then it automatically includes a `setup_deps` node after `start` with:
      - `tool_command` that tries npm, then pnpm, then yarn
      - Proper exit handling with `2>&1` redirection
```

### Pattern 0b: Parallel Limit (Component Fan-Out)

```
Feature: Resource Safety
  As a pipeline author
  I want component fan-out nodes to run sequentially
  So that I don't exceed Docker memory limits

  Scenario: Component nodes have max_parallel=1
    Given a pipeline author uses component fan-out (Pattern 4)
    When the pipeline is generated
    Then each component node has `max_parallel="1"` attribute
    And `patternsApplied` includes `"0b"` only when split_phases exists
```

### Pattern 0c: Baseline Snapshot (Always Emitted)

```
Feature: Regression Detection Baseline
  As a pipeline author
  I want baseline error counts captured before implementation
  So that I can detect regressions in verify nodes

  Scenario: Baseline snapshot node captures error counts
    Given any spec with at least one phase
    When the builder generates the pipeline
    Then it includes a `capture_baseline` node after `setup_deps` with:
      - TypeScript error count snapshot to `/tmp/baseline_ts_errors.txt`
      - ESLint error count snapshot to `/tmp/baseline_lint_errors.txt`
      - Fallback to `echo 0` when grep finds no matches
```

### Pattern 0d: Delta-Aware Verify (Auto-Applied)

```
Feature: Regression Verification
  As a pipeline author
  I want verify nodes to compare against baseline
  So that I can detect when error counts increase

  Scenario: Verify nodes use delta-aware comparison
    Given a pipeline author defines phases
    When verify nodes are generated (`verify_lint_${phase}`, `verify_types_${phase}`)
    Then they compare against the baseline with:
      - Prepend `BASELINE=$(cat /tmp/baseline_*.txt 2>/dev/null || echo 0) &&`
      - Append `&& CURRENT=$(...) && [ $CURRENT -le $BASELINE ]`
      - Pass if current errors <= baseline errors
```

### Pattern 0e: Progress Gate (Per Phase)

```
Feature: Implementation Progress Detection
  As a pipeline author
  I want to detect stalled implementations
  So that I can fix them before they waste compute

  Scenario: Progress gate checks for git changes
    Given a pipeline author defines phases
    When the builder generates the pipeline
    Then each phase gets a `check_progress_${phase}` node after `impl_${phase}` with:
      - `tool_command` that runs `git status --porcelain`
      - `read_only="true"` attribute
      - `max_visits="3"` to prevent infinite loops
      - STATUS: SUCCESS if files changed, STATUS: FAIL otherwise
```

### Pattern 1: Test-Fix Loops (Auto-Applied)

```
Feature: Iterative Correction
  As a pipeline author
  I want a test-fix loop with diamond gate
  So that code can be iteratively corrected

  Scenario: Test-fix loop diamond gate
    Given a pipeline author defines a phase
    When the builder generates the pipeline
    Then it creates a test-fix loop with:
      - `test_${phase}` node → diamond node
      - `outcome="success"` → next phase / verify chain
      - `outcome="fail"` → `fix_${phase}` → `impl_${phase}` (retry loop)
      - Diamond node has ≥2 outgoing edges (success/fail)
```

### Pattern 3: Conditional Routing (Diamond Nodes)

```
Feature: Conditional Execution
  As a pipeline author
  I want diamond nodes to route conditionally
  So that the pipeline can branch based on outcomes

  Scenario: Diamond nodes have required edges
    Given any generated diamond node
    When the builder validates the pipeline
    Then it ensures at least 2 outgoing edges exist
    And all outcomes are covered (success, fail, issues, etc.)
```

### Pattern 4: Parallel Fan-Out/Fan-In

```
Feature: Parallel Phase Execution
  As a pipeline author
  I want independent phases to run in parallel
  So that my pipeline completes faster

  Scenario: Fan-out topology for independent phases
    Given a pipeline author defines 2+ phases with no `dependsOn` between them
    When the builder generates the pipeline
    Then it creates a fan-out topology with:
      - `split_phases` node with `shape="component"` and `max_parallel="1"`
      - Parallel phase node execution (no subgraph nesting)
      - `merge_phases` node with `shape="tripleoctagon"`
```

### Pattern 6: Max Visits (Loop Protection)

```
Feature: Infinite Loop Prevention
  As a pipeline author
  I want retry loops to have visit limits
  So that I don't waste compute on stuck retries

  Scenario: Nodes with retry edges get max_visits
    Given nodes with incoming retry edges
    When the builder finalizes the pipeline
    Then it injects `max_visits="5"` (default) to prevent infinite loops
    And existing `max_visits` values are not overwritten
```

### Pattern 6b: Read-Only + STATUS (Auto-Applied)

```
Feature: Read-Only Safety
  As a pipeline author
  I want review nodes to be read-only with STATUS markers
  So that they cannot accidentally modify code

  Scenario: Review nodes have read_only and STATUS
    Given review nodes (conformance, security_scan, etc.)
    When the builder finalizes the pipeline
    Then it ensures `read_only="true"` attribute
    And appends STATUS marker to prompt: `\nOutput STATUS: SUCCESS or STATUS: FAIL on its own line.`
```

### Pattern 10: Scope Creep Detection

```
Feature: Scope Enforcement
  As a pipeline author
  I want to detect if implementation modifies files outside allowed_paths
  So that I catch scope creep early

  Scenario: Scope check after implementation
    Given each implementation phase
    When the builder generates the pipeline
    Then it adds a `scope_check_${phase}` node after `impl_${phase}` with:
      - `class="review"` attribute
      - `read_only="true"`
      - Prompt comparing git diff against `allowed_paths`
      - STATUS: SUCCESS if only allowed files changed, STATUS: FAIL otherwise
```

### Pattern 13: Lint Gate

```
Feature: Style Consistency
  As a pipeline author
  I want lint checks in the verify chain
  So that I catch style regressions

  Scenario: Lint gate in verify chain
    Given the verify chain for a phase
    When generated
    Then it includes a `verify_lint_${phase}` node after `check_progress_${phase}` with:
      - Delta-aware command using baseline comparison
      - `timeout="15m"` (review class)
      - Runs `npx eslint` on the changed files
```

### Pattern 14: Type-Check Gate

```
Feature: Type Safety
  As a pipeline author
  I want type checks in the verify chain
  So that I catch type regressions

  Scenario: Type-check gate in verify chain
    Given the verify chain for a phase
    When generated
    Then it includes a `verify_types_${phase}` node after `verify_lint_${phase}` with:
      - Delta-aware command using baseline comparison
      - `timeout="15m"` (review class)
      - Runs `npx tsc --noEmit`
```

### Pattern 15: Conformance Audit

```
Feature: Spec Compliance
  As a pipeline author
  I want to verify spec compliance after implementation
  So that the implementation matches the requirements

  Scenario: Conformance check after scope creep
    Given each phase
    When the builder generates the pipeline
    Then it adds a `conformance_${phase}` node after `scope_check_${phase}` with:
      - `class="review"` attribute
      - `read_only="true"`
      - `timeout="15m"`
      - Prompt reviewing against phase spec and PRD requirements
      - STATUS: SUCCESS or STATUS: FAIL output
```

### Pattern 21: Fix All (Last-Resort Repair)

```
Feature: Pipeline-Wide Recovery
  As a pipeline author
  I want a last-resort repair step before verify_final
  So that I don't have to restart the entire pipeline

  Scenario: Fix all as last-resort repair
    Given the final pipeline structure
    When generated
    Then `fix_all` precedes `verify_final` as a last-resort repair step with:
      - `shape="box"` and `class="codergen"` attributes
      - `timeout="30m"`
      - `allowed_paths` = union of all phase paths
      - Graph-level `retry_target="fix_all"`
```

### Pattern 22: Permission Scoping (Auto-Applied)

```
Feature: Safe Code Generation
  As a pipeline author
  I want code-generation nodes to have permission scoping
  So that I prevent unauthorized file modifications

  Scenario: Permission scoping on codergen nodes
    Given code-generation nodes
    When the builder generates the pipeline
    Then it injects `allowed_paths`, `escalate_on`, and `permission_mode="auto"` with:
      - Per-phase nodes get `PhaseSpec.allowedPaths` and `escalateOn`
      - Cross-phase nodes (`fix_all`, `verify_final`) get union of all phase values
      - Test directories auto-added to allowed_paths per heuristic
```

### Pattern 23: Defense Matrix

```
Feature: Safety Layer Documentation
  As a pipeline author
  I want to see which safety layers are active
  So that I can audit my pipeline's defense-in-depth

  Scenario: Defense matrix comment block
    Given any generated pipeline
    When .build() completes
    Then it includes a `/* DEFENSE MATRIX ... */` comment block with:
      - `competitive: boolean` (from `competing: true` phases)
      - `adversarial: boolean` (from `redTeam: true` phases)
      - `guardrails: string[]` (max_visits, no-op, read_only)
      - `specDriven: string` (conformance, spec_file, BDD combinations)
      - `permissions: string[]` (allowed_paths, escalate_on)
```

### Pattern 25: Catastrophic Recovery

```
Feature: Infinite Retry Cascade Prevention
  As a pipeline author
  I want catastrophic recovery for retry loops
  So that I don't get stuck in infinite retry cascades

  Scenario: Catastrophic recovery edge
    Given a pipeline with retry loops (test-fix or goal_gate)
    When the builder generates the pipeline
    Then it adds a `loop_restart="true"` edge from `verify_final` to `setup_deps`
    This edge is NOT emitted for zero-phase pipelines (explicit carve-out)
```

---

## Generated Pipeline Examples

### Minimal Phase (1 Phase, No Goal Gate)

```
start → setup_deps → capture_baseline →
impl_auth → check_progress_auth → security_scan_auth (opt-in) →
verify_lint_auth → verify_types_auth → test_auth →
diamond → fix_auth (fail) / scope_check_auth (success) →
conformance_auth → merge_phases → fix_all → verify_final → exit
```

### Multi-Phase with Fan-Out (2 Independent Phases)

```
start → setup_deps → capture_baseline →
split_phases → impl_auth, impl_api (parallel) → merge_phases →
fix_all → verify_final → exit
```

### Phase with Goal Gate

```
impl_${phase} → check_progress_${phase} → verify_lint_${phase} →
verify_types_${phase} → test_${phase} → diamond [goal_gate="true"] →
fix_${phase} (retry_target="fix_${phase}") → impl_${phase}
```

---

## Notes

- **Auto patterns** are always applied by `.build()` with no user control
- **Pattern application is conditional**: `patternsApplied` only includes patterns whose preconditions were met
  - Pattern 0b: Only when `split_phases` nodes exist
  - Pattern 4: Only when ≥2 phases have no `dependsOn` relationship
  - Pattern 25: Only when retry loops exist (test-fix or goal_gate)
- **Zero-phase pipelines** are a special case: Only auto infrastructure emitted (start→setup_deps→capture_baseline→fix_all→verify_final→exit)
- **Doc-only phases** (`docOnly: true`) suppress verify chain (Patterns 0d, 1, 13, 14) but still emit progress gate (0e)
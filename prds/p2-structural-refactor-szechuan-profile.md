---
title: "Structural Refactor profile — iterative decomposition and code-smell remediation for Claude Code"
priority: P2
status: draft
type: feature
schema_neutral: true
build_mode: unattended
source_assessment: "Requested 2026-08-11 as a Claude Code port of the global Codex structural-refactor skill. Source and deployed-tree checks confirm that szechuan-sauce already supplies the convergence runner, default remediation, dry-run reporting, confidence scoring, and generic principles for large functions/classes and explanatory comments. The remaining gap is a focused structural-review contract and discoverable report-only vocabulary, not a second engine."
---

# Structural Refactor profile for Claude Code

## Summary

Add a focused `structural-refactor` domain profile to the existing `/szechuan-sauce` workflow. The profile must find high-value opportunities to decompose methods, classes, and modules; treat large implementation-narrating comment blocks as strong presumptive smells; remediate findings incrementally by default; and support an explicit report-only mode.

The user-facing invocation is:

```text
/szechuan-sauce --domain structural-refactor [options] <target>
```

This feature must reuse the existing Szechuan microverse loop, state, verification, install, and reporting paths. It must not create a parallel runner or duplicate the 450-line Szechuan command as `/structural-refactor`.

## Motivation

### Current behavior

The base Szechuan principles already contain useful generic signals:

- functions over 50 lines;
- classes doing many things;
- comments explaining what code does;
- comment-heavy code;
- SRP, cohesion, KISS, DRY, and cognitive-load guidance.

The deployed runtime contains the same rules. `/szechuan-sauce` also already provides:

- iterative inspect/fix/measure convergence;
- one logical fix per iteration;
- default remediation;
- `--dry-run` review-only behavior;
- domain overlays through `--domain <name>`;
- baseline and final verification;
- scoped runs and bounded iteration/stall controls;
- honest residual reporting when convergence is not reached.

### Gap

The generic principles do not define a cohesive structural-refactoring review contract. In particular, they do not clearly require:

- size to be treated as a search signal rather than proof of bad design;
- findings to be supported by responsibility, cohesion, abstraction-level, control-flow, dependency, or change-axis evidence;
- large explanatory comments to be treated as candidate extraction boundaries while preserving rationale and external constraints;
- behavior-preserving extraction with characterization coverage when existing tests are insufficient;
- explicit ranking by impact, confidence, safety, and abstraction cost;
- resistance to one-use wrappers, speculative patterns, and fragmentation;
- `--report-only` as clear user vocabulary alongside the existing `--dry-run` flag.

Without that focused contract, a request for structural decomposition is diluted among every Szechuan concern, and simplistic line-count refactors can score as progress even when they merely redistribute complexity.

## Objective

Provide a Claude Code structural-refactoring workflow that converges on materially clearer, more cohesive code while preserving observable behavior and avoiding abstraction for abstraction's sake.

Done means:

1. `/szechuan-sauce --domain structural-refactor <target>` runs the existing iterative remediation path with the structural profile loaded.
2. `/szechuan-sauce --domain structural-refactor --report-only <target>` produces findings without creating a session or modifying source files.
3. The profile distinguishes structural evidence from size heuristics and distinguishes implementation narration from valuable rationale comments.
4. Focused tests pin mode selection, profile deployment, required principles, and anti-overengineering rules.
5. README documentation makes both modes discoverable.

## Users and critical user journeys

### CUJ-1 — Default immediate remediation

An engineer runs:

```text
/szechuan-sauce --domain structural-refactor src/services
```

Claude reads the base and structural principles, establishes the existing validation baseline, identifies the highest-value structural smell, applies one behavior-preserving remediation, verifies it, rescans the current code, and continues through the existing convergence loop. The final report names changes, checks, residual findings, and the honest convergence disposition.

### CUJ-2 — Report only

An engineer runs:

```text
/szechuan-sauce --domain structural-refactor --report-only src/services
```

Claude inspects the target and returns prioritized structural findings with location, evidence, consequence, smallest worthwhile remediation, confidence, and verification considerations. It creates no Pickle session, writes no source files, and makes no commits. `--dry-run` remains an equivalent backwards-compatible spelling.

### CUJ-3 — Comment block exposes a missing boundary

Claude encounters a long method divided by comments such as `Step 1: validate`, `Step 2: price`, and `Step 3: persist and notify`. It treats the comments as evidence of distinct conceptual phases, verifies those phases against data flow and side effects, and proposes or applies cohesive extractions. It does not blindly delete the comments first.

### CUJ-4 — Valuable rationale survives

Claude encounters a comment explaining a regulatory rule, compatibility constraint, invariant, security property, performance tradeoff, or unavoidable hazard. It preserves the comment or moves it with the relevant code. It does not classify the comment as slop merely because it is large.

### CUJ-5 — Large but cohesive code is left alone

Claude encounters a long linear parser or algorithm with one responsibility, one abstraction level, and no safer meaningful boundary. It records no finding solely from line count. Zero findings is an acceptable result.

## Functional requirements

| Priority | Requirement | Verification |
|:--|:--|:--|
| P0 | Add `extension/szechuan-sauce-structural-refactor-principles.md` as a domain overlay consumed by the existing `--domain structural-refactor` path. | Focused Node test asserts the source file exists and `.claude/commands/szechuan-sauce.md` resolves domain files using the existing `szechuan-sauce-${DOMAIN}-principles.md` contract. |
| P0 | Default to remediation when no report flag is supplied, using the existing Szechuan setup, microverse, gate, and convergence flow. | Prompt-contract test asserts the default path does not enter report-only handling and still reaches existing setup/initialization/launch steps. |
| P0 | Accept `--report-only` as an exact alias for `--dry-run`; either spelling must skip session creation, code edits, and commits. | Prompt-contract test extracts the report-only branch and asserts both flags select it before `setup.js`; fixture/evaluator test asserts no mutating instructions occur in that branch. |
| P0 | Preserve the existing `--scope` plus report-mode conflict behavior for both `--dry-run` and `--report-only`. | Prompt-contract test asserts both spellings produce `SCOPE_DRYRUN_CONFLICT` or a renamed single canonical conflict before target analysis. |
| P0 | Treat method/class size and numeric thresholds only as triage signals in this domain. Require evidence from cohesion, responsibilities, abstraction levels, control flow, dependencies, side effects, or reasons to change before emitting a finding. | Principles-contract test asserts the profile contains the size-is-signal rule and explicitly overrides conflicting base threshold language for this domain. |
| P0 | Treat large comments that explain implementation as presumptive structural smells and candidate extraction boundaries. Preserve comments that explain rationale, invariants, external requirements, compatibility constraints, security properties, performance tradeoffs, or unavoidable hazards. | Principles-contract test asserts both the removal/extraction rule and the preservation exceptions; behavioral fixture covers one narration block and one rationale block. |
| P0 | Preserve observable behavior during remediation, including public APIs, persistence semantics, ordering, concurrency, errors, logging, and side effects unless behavioral change is explicitly authorized. | Principles-contract test asserts the preservation list; behavioral fixture requires characterization tests before changing an uncovered observable behavior. |
| P0 | Reuse the existing one-fix-per-iteration convergence and verification machinery. Do not add a new runner, session schema, state field, monitor mode, convergence file, or duplicated command workflow. | Diff/path test asserts no changes under `extension/src/bin/microverse-runner.ts`, `extension/src/types/`, monitor-mode files, or state schema for this feature; source audit asserts no new process-spawn call site. |
| P1 | Rank candidates by impact, confidence, safety, and abstraction cost. Prefer high-impact, high-confidence, locally verifiable changes. | Principles-contract test asserts all four ranking dimensions and the selection rule. |
| P1 | Cover mixed responsibilities, low cohesion, mixed abstraction levels, deep nesting, flag-driven workflows, long parameter lists/data clumps, feature envy, primitive obsession, duplicated rules, shotgun surgery/divergent change, temporal coupling, hidden side effects, and excessive collaborator knowledge. | Principles-contract test asserts the named smell categories are represented without requiring exact prose duplication. |
| P1 | Reject cosmetic or speculative decomposition: line-count-only extraction, one-line wrappers, generic utility dumping grounds, speculative interfaces/factories/strategies, excessive fragmentation, and relocation without addressing the root smell. | Principles-contract test asserts the anti-pattern set; behavioral fixture rejects a proposed strategy extraction for a small readable boolean branch. |
| P1 | In report-only mode, emit each finding with location, evidence, consequence, smallest worthwhile remediation, confidence, and verification considerations; explicitly allow a zero-findings verdict. | Snapshot or behavioral fixture pins the report shape and clean-code result. |
| P1 | In remediation mode, report responsibilities/smells addressed, structural changes, verification results, residual findings, and convergence disposition. | Prompt-contract test asserts the final reporting contract is present in the profile or composed worker prompt. |
| P1 | Install the new profile through the existing `extension/szechuan-sauce-*-principles.md` wildcard and verify deployed content parity in an isolated install root. | Installer test runs `install.sh` with an isolated `PICKLE_INSTALL_ROOT` and asserts byte equality between source and installed profile. |
| P1 | Document the profile and both operating modes in README. | `rg -n '/szechuan-sauce --domain structural-refactor' README.md` returns remediation and report-only examples. |

## Interface contract

| Surface | Input | Result | Errors/constraints |
|:--|:--|:--|:--|
| Remediation | `/szechuan-sauce --domain structural-refactor [existing Szechuan options] <target>` | Existing detached Szechuan convergence session using base plus structural principles | Existing target, tmux, scope, backend, baseline, and gate contracts remain authoritative |
| Report only | `/szechuan-sauce --domain structural-refactor --report-only <target>` | Prioritized read-only report; no session or source writes | Same behavior as `--dry-run`; conflicts with `--scope` exactly as current dry-run does |
| Backwards compatibility | `/szechuan-sauce --domain structural-refactor --dry-run <target>` | Same report-only behavior | `--dry-run` is not deprecated or removed |
| Profile source | `extension/szechuan-sauce-structural-refactor-principles.md` | Supplemental principles; structural profile wins where it explicitly conflicts with generic base heuristics | Must contain only domain deltas, not a copy of the base principles |
| Installed profile | `${PICKLE_INSTALL_ROOT:-$HOME/.claude/pickle-rick}/szechuan-sauce-structural-refactor-principles.md` | Byte-equivalent deployed copy | Installed file is generated by `bash install.sh`; never edit it directly |

## Structural review contract

The domain profile must direct the worker and judge to apply this sequence within the existing Szechuan iteration:

1. Trace behavior, callers, collaborators, tests, state mutations, and side effects.
2. Identify candidate smells using size, comments, branching, dependency shape, and test friction as search signals.
3. Confirm the underlying structural evidence; do not emit a smell label without evidence.
4. Rank confirmed candidates by impact, confidence, safety, and abstraction cost.
5. In remediation mode, select the smallest cohesive high-value batch allowed by the existing one-fix-per-iteration rule.
6. Add or strengthen characterization coverage when current tests cannot protect behavior being moved.
7. Apply the refactor, run the existing verification path, inspect the diff, and rescan current code.
8. Record residual or blocked findings honestly when the loop stops before zero.

The profile must not reinterpret a verification failure as permission to change behavior. It must revise/revert the structural change or report the blocker through existing Szechuan mechanisms.

## Codebase context and reuse map

| Needed capability | Existing source of truth to reuse |
|:--|:--|
| Iterative remediation and convergence | `.claude/commands/szechuan-sauce.md` plus `extension/src/bin/microverse-runner.ts` |
| Base smell taxonomy and confidence scoring | `extension/szechuan-sauce-principles.md` |
| Domain overlay loading | `.claude/commands/szechuan-sauce.md` `--domain <name>` path |
| Report-only behavior | Existing `--dry-run` branch in `.claude/commands/szechuan-sauce.md` |
| Baseline/final mechanical verification | Existing check/finalize gate path used by Szechuan |
| Source-to-runtime deployment | `install.sh` wildcard over `extension/szechuan-sauce-*-principles.md` |
| Command documentation | README Szechuan Sauce section |
| Prompt contract tests | `extension/tests/skill-prompts/szechuan-sauce-gate-integration.test.js` and sibling tests |

During research, print the global Codex skill's mode, convergence, comment, verification, and reporting contracts beside the existing Szechuan equivalents. Assert which clauses are exact reuse, which require only a domain overlay, and which require the `--report-only` alias. This contract-match artifact is mandatory before implementation tickets are finalized.

## Machine-checkable acceptance criteria

- **AC-SR-01 — profile exists and is focused.** `test -f extension/szechuan-sauce-structural-refactor-principles.md` passes. A test asserts the file contains the structural contract and does not duplicate the full base principles document.
- **AC-SR-02 — existing domain primitive is used.** A prompt-contract test proves `--domain structural-refactor` resolves `szechuan-sauce-structural-refactor-principles.md`. The feature adds no second principles loader.
- **AC-SR-03 — authorized default remediation.** With `--domain structural-refactor` and neither reporting flag, prompt evaluation reaches the existing setup/iteration path. Invocation alone does not broaden normal repository or destructive-action permissions.
- **AC-SR-04 — report-only alias.** `--report-only` and `--dry-run` select the same branch before any `setup.js`, `init-microverse.js`, commit, or source-edit instruction. Tests cover both spellings.
- **AC-SR-05 — scope conflict parity.** `--scope` combined with either report spelling stops through one shared conflict path. Tests fail if the two aliases diverge.
- **AC-SR-06 — evidence beats size.** A fixture containing a long cohesive linear algorithm produces no line-count-only finding; a fixture containing a shorter method with validation, pricing, persistence, and notification responsibilities produces a structural finding.
- **AC-SR-07 — comment distinction.** A fixture with `Step 1/2/3` narration identifies candidate extraction boundaries. A fixture with a regulatory rationale or compatibility warning preserves the comment and does not recommend deletion merely because of its length.
- **AC-SR-08 — no speculative abstraction.** A fixture with a small readable boolean notification branch does not recommend a strategy/factory hierarchy without additional evidence.
- **AC-SR-09 — behavior preservation.** The principles and fixtures require preservation of public APIs, errors, ordering, side effects, persistence, and concurrency; uncovered observable behavior triggers characterization coverage or deferral rather than an unverified edit.
- **AC-SR-10 — report contract.** Report-only fixture output includes location, evidence, consequence, smallest worthwhile remediation, confidence, and verification considerations, and supports an explicit zero-findings result.
- **AC-SR-11 — remediation report contract.** The remediation prompt requires addressed smells, important structural changes, checks and results, residuals, and honest convergence disposition.
- **AC-SR-12 — installer parity.** An isolated-root installer test proves the installed structural profile exists and is byte-identical to its source. The existing wildcard remains the only deployment mechanism.
- **AC-SR-13 — no parallel engine.** The implementation adds no new runner, state schema, state field, monitor mode, convergence artifact, process-spawn path, or copied Szechuan command body. A path/diff audit enforces the restricted surface.
- **AC-SR-14 — documentation.** README contains remediation and `--report-only` examples and explains that `--dry-run` is an equivalent spelling.
- **AC-SR-15 — focused tests.** From `extension/`, `node --test tests/skill-prompts/structural-refactor-profile.test.js` passes, including the behavioral fixtures above.
- **AC-SR-16 — standard quality gates.** From `extension/`, `npx tsc --noEmit`, `npx eslint src/ --max-warnings=-1`, and `npm run test:fast` pass on a quiet machine.
- **AC-SR-17 — full release gate.** Before release, the repository's full release gate from `CLAUDE.md` passes and the compiled JS matches TypeScript source.

## Test expectations

| Requirement | Test artifact | Assertion |
|:--|:--|:--|
| Mode selection | `extension/tests/skill-prompts/structural-refactor-profile.test.js` | Default remediates; `--report-only` and `--dry-run` share the read-only path |
| Structural heuristics | Fixtures embedded in or adjacent to the focused test | Size alone is insufficient; multiple responsibilities and comment-delimited phases are credited |
| Comment preservation | Focused fixtures | Narration is challenged; rationale/invariant comments survive |
| Restraint | Focused fixtures | Small readable branches and cohesive long algorithms do not trigger speculative patterns |
| Reporting | Snapshot/shape assertions | Required fields and zero-findings outcome are present |
| Installation | Existing install test suite or one focused installer test | Source and isolated installed profile are byte-identical |
| Regression | Existing fast and release gates | No Szechuan, pipeline, monitor, state, or gate behavior regresses |

Behavioral fixtures may use deterministic prompt-shape assertions when possible. If an LLM evaluator is necessary, keep it isolated from the default fast tier unless repository conventions already provide a deterministic equivalent; do not make a nondeterministic model verdict the sole acceptance oracle.

## Technical constraints

- Edit only source files in `pickle-rick-claude`; never edit `~/.claude/pickle-rick/` or `~/.claude/commands/` directly.
- Build through `/pickle-pipeline` or `/pickle-tmux`; do not hand-build the feature.
- Keep the change schema-neutral.
- Reuse the existing domain loader, convergence runner, report-only branch, gate, and install wildcard.
- Keep the profile delta-focused. Do not copy the base principles into the overlay.
- Preserve all existing Szechuan flags and semantics.
- Update README because the user-facing command contract changes.
- Do not introduce a fixed method/class line count as an automatic violation in the structural domain.
- Do not add time estimates to this PRD or decomposed tickets.

## Simplification Review

### 1. Is the addition necessary at all?

Partially. A new refactoring engine is not necessary: source and deployed trees already contain the generic smell vocabulary and the entire iteration/remediation/reporting mechanism. The only justified additions are a focused domain overlay, a `--report-only` alias for discoverability, focused contract tests, and documentation.

If research shows the base profile can express every structural rule without diluting general Szechuan behavior, prefer tightening the base document and eliminate the domain overlay. The dedicated profile remains preferred only if it materially changes prioritization and conflict resolution for structural work.

### 2. Can it reuse instead of add?

Yes. This PRD mandates reuse of:

- `/szechuan-sauce` rather than a new `/structural-refactor` command;
- `--domain` rather than a new profile-loading mechanism;
- `--dry-run`'s branch rather than a second report implementation;
- microverse convergence rather than a new iteration primitive;
- existing state and gate artifacts rather than a new ledger format;
- the installer wildcard rather than a new copy stanza.

The required research artifact must compare both contracts side by side and prove the match before implementation.

### 3. Does it guard brittle complexity that should instead be subtracted?

No guard is added. The main brittleness risk is duplicating Szechuan's command body or creating another runner/monitor/state path. This PRD forbids both. `--report-only` must normalize to the existing dry-run boolean rather than create another downstream mode.

### 4. What can this issue subtract?

It subtracts the proposed parallel Claude refactoring workflow from the design: there will be no second engine, runner, state machine, or copied command. No safe source deletion is currently identified because the generic Szechuan principles remain useful outside this profile. Research may remove redundant structural prose from the overlay before shipping; duplication is a failure, not completeness.

## Out of scope

- A standalone `/structural-refactor` command with a duplicated Szechuan workflow
- A new detached runner, microverse implementation, state schema, convergence file, monitor mode, or gate
- Automatic repository-wide execution without an explicit target/scope
- Behavioral redesign, API changes, domain model redesign, or feature work disguised as refactoring
- Hard line-count verdicts for methods or classes
- Automatic deletion of comments based only on size
- Removal of rationale, regulatory, invariant, compatibility, security, or hazard documentation
- New AST/codegraph/static-analysis infrastructure solely for this profile
- New settings or environment variables
- Changes to pipeline phase ordering
- Auto-triggering this profile as a mandatory release gate

## Risks and mitigations

| Risk | Mitigation |
|:--|:--|
| The profile duplicates generic Szechuan principles | Keep only structural deltas and test against wholesale duplication |
| The model extracts methods mechanically to satisfy thresholds | Override size thresholds as triage-only and require structural evidence |
| Comment cleanup destroys rationale | Require why/constraint preservation and fixture coverage |
| Refactoring changes observable behavior | Trace contracts first, add characterization tests, verify each atomic change |
| Report-only accidentally initializes a session or edits code | Normalize both flags before setup and pin the branch with prompt-contract tests |
| A second command/runner drifts from Szechuan | Explicitly forbid it and enforce a restricted diff surface |
| LLM fixtures become flaky | Prefer deterministic contract tests; isolate any unavoidable behavioral evaluator |

## Launch prerequisites

Before implementation begins:

1. Re-run the source and deployed-tree stale-premise search for the structural profile name and distinctive rules.
2. Produce the mandatory Codex-skill-to-Szechuan contract-match research artifact.
3. Run `cd extension && npm run test:fast` once on a quiet machine and record the green baseline, or explicitly attribute inherited failures to their introducing commit.
4. Launch the implementation through `/pickle-pipeline` or `/pickle-tmux` in unattended mode.

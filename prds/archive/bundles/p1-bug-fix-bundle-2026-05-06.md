---
title: P1 — Bug-fix bundle 2026-05-06 (post-v1.71.0 cleanup)
status: Partially Shipped
date: 2026-05-06
priority: P1
shipped: 5/12 sections + slot E; deferred slots G/H/I/J/K/L absorbed by 2026-05-07-deferred-slots + 2026-05-08-mega
type: bug-bundle
scope: local-only
authoring_path: /pickle-quick-refine fan-out (validated 2026-05-06 AM)
pipeline_target: /pickle-pipeline --no-refine --backend codex
sections: 12
peer_prds:
  source_prds:
    - prds/archive/bug-reports/anatomy-park-finalizer-history-crash.md           # Section D
    - prds/archive/bug-reports/anatomy-park-runner-undefined-description-crash.md # Section E
    - prds/archive/bug-reports/anatomy-park-szechuan-monorepo-missed-detection-gap.md # Section F (subset)
    - prds/archive/bug-reports/codex-classifier-prompt-leak.md                   # Section G
    - prds/archive/bug-reports/szechuan-sauce-codex-judge-model-mismatch.md      # Section H
    - prds/archive/bug-reports/p1-iteration-cap-and-phantom-done-handshake.md    # Sections I + J
    - prds/archive/bug-reports/p1-deployed-pkgjson-version-only-revert.md        # Section K
    - prds/p1-strip-excessive-defense-deploy-reversion.md    # Section L
    - prds/archive/bug-reports/p1-deploy-typescript-symlink-and-cap-no-auto-resume.md # Section B (R-CNAR-7 doc)
  inline_no_source:
    - Section A (R-WLG-*)  # worker eslint+tsc gate at completion-commit
    - Section C (R-IPF-*)  # integration parallel-tier flake quarantine
refinement:
  cycles: 1                       # quick-refine fan-out (12 parallel agents, one per section)
  workers: [requirements]         # quick-refine doesn't run codebase/risk-scope analysts
  notes: |
    Each section is one atomic ticket. Total tickets after refinement = 12.
    No `composes:` block — that pattern broke today on 2026-05-05 bundle (Path A
    had to lift ACs inline before refinement produced implementation tickets).
    All ACs lifted verbatim from source PRDs (Sections B/D/E/F/G/H/I/J/K/L) or
    authored inline per the operator brief (Sections A/C).
---

# Bug-Fix Bundle 2026-05-06 — Post-v1.71.0 Cleanup

> Composed under the **"Bugs first, scope second"** Working Rule (`prds/MASTER_PLAN.md` line 16).
> 12 atomic implementation tickets. No feature scope. Local-only — no `gh release create`, no version bump, no push.

## Overview

- **Date**: 2026-05-06 (post-v1.71.0 local tag, 44 commits ahead of `origin/main`).
- **Source PRDs**: 9 individual + 3 inline (A worker-lint-gate, C integration parallel-flake quarantine, plus B which is doc-completion only).
- **Pipeline target**: `/pickle-pipeline --no-refine --backend codex` (after `/pickle-quick-refine`).
- **Authoring path**: `/pickle-quick-refine` parallel agent fan-out — validated 2026-05-06 AM on session `pipeline-e0834dcd` (9/9 tickets shipped).
- **Lesson applied**: 2026-05-05 bundle's `composes:` block produced 5 meta-tickets instead of 9 implementation tickets. Path A had to lift ACs inline. **This bundle lifts every AC verbatim into the section body — no `composes:`, no peer-PRD delegation.**

## Bugs-first policy compliance

- All 12 sections are defects, not feature work.
- Working Rule citation: `prds/MASTER_PLAN.md` line 16 — *"Open bugs in PRDs and master-plan queue slots must be drained before any feature/expansion work is queued."*
- Open P1/P2 bug count at compose time: 14. This bundle drains 12 of them.
- Section A (worker lint gate) is itself listed as Working Rule #2 in `MASTER_PLAN.md` line 17 — *"Worker tickets must run the lint + typecheck gate before completion-commit"* — so this bundle directly closes the rule's outstanding implementation gap.

## Composition

| § | Title | Source | Priority | Lead requirement |
|---|-------|--------|----------|-------------------|
| A | Worker ESLint + TSC Gate at Completion-Commit | inline (no source PRD) | P1 | R-WLG-1: pre-commit `npx eslint --max-warnings=-1` + `npx tsc --noEmit` in worker turn-end |
| B | R-CNAR-7 Trap-Door Doc Completion | `p1-deploy-typescript-symlink-and-cap-no-auto-resume.md` | P1 | R-CNAR-7-DOC-1: extend existing trap-door entry with full INVARIANT/PATTERN_SHAPE/BREAKS/ENFORCE coverage; audit verifies all 4 fields populated |
| C | Integration Parallel-Tier Flake Quarantine | inline (no source PRD) | P1 | R-IPF-1: classify subprocess-heavy tests; serial vs parallel split |
| D | anatomy-park finalizer history crash | `anatomy-park-finalizer-history-crash.md` | P1 | R-AFHC-1 / AC-APH-01: `writeFinalReport()` does not throw on `mvState.convergence === undefined` |
| E | anatomy-park runner undefined-description crash | `anatomy-park-runner-undefined-description-crash.md` | P1 | R-APRC-2: guard `mvState.key_metric` access; helper returns `"(no key metric)"` |
| F | anatomy-park / szechuan monorepo missed-detection (Override 6 globbing only) | `anatomy-park-szechuan-monorepo-missed-detection-gap.md` | P1 | R-ASMM-F1 / AC1: Override 6 monorepo-aware glob |
| G | codex classifier prompt-leak | `codex-classifier-prompt-leak.md` | P1 | R-CCL-R1: `extractAssistantContent` codex-aware detection mode |
| H | szechuan-sauce codex judge model mismatch | `szechuan-sauce-codex-judge-model-mismatch.md` | P1 | R-SCJM-2: judge unconditionally routed through claude |
| I | Iteration cap persistence vs display divergence | `p1-iteration-cap-and-phantom-done-handshake.md` (R-1) | P1 | R-ICP-3 / R-ICP-4: `setup.js --resume` honors persisted `state.max_iterations`; CLI args persisted at setup time |
| J | mux-runner exits 0 on cap-hit | `p1-iteration-cap-and-phantom-done-handshake.md` (R-2) | P1 | R-ICP-1 / R-ICP-2: distinct exit code 3 for cap-hit; pipeline-runner halts |
| K | deployed package.json version-only revert | `p1-deployed-pkgjson-version-only-revert.md` | P1 | R-PJV-1..5: H-A/B/C/D/E hypothesis triage + diagnostic invariant |
| L | strip excessive defense deploy-reversion | `p1-strip-excessive-defense-deploy-reversion.md` | P1 | AC-STRIP-01..12: delete cron sampler + pre-flight + scheduled finalizer (~480 LOC) |

**Total**: 12 atomic tickets. **Estimated** post-refinement: 12 (1 per section, no fan-out — quick-refine does not split sections).

## Skipped / deferred

- `prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md` — too big for this batch (6+ tickets); next dedicated batch.
- `prds/archive/bug-reports/p2-worker-silent-exit-and-ticket-path-drift.md` — pair with ticket-authoring epic.
- `prds/p1-worker-spawns-codex.md` R-XBL-1/-6 — partial precedent; revisit with telemetry.
- `prds/archive/bug-reports/pipeline-runner-state-active-not-claimed-on-relaunch.md` — P3, not blocking.
- Sections F's deferred ACs (AC2/3/4/5/6/7/8 from `anatomy-park-szechuan-monorepo-missed-detection-gap.md`) — multi-AC bundle; only Override-6 glob fix lifted into this bundle. Subsystem discovery + sibling-of-fix grep + `constraint_code_drift` trap-door deferred to a dedicated PRD.
- `p1-iteration-cap-and-phantom-done-handshake.md` R-3 (codex phantom-Done speculative flips, R-ICP-5/6) — sister bug deferred to next batch; this bundle covers only R-1 (cap persistence) and R-2 (cap-hit exit code).

---

## Section A — Worker ESLint + TSC Gate at Completion-Commit

**Priority: P1**

*Inline ACs — no source PRD. Authored per operator brief 2026-05-06.*

**Problem statement**: 2026-05-06 pipeline (`pipeline-e0834dcd`) workers shipped 10 ESLint errors and committed without running `npx eslint` / `npx tsc --noEmit`. The release gate caught the failures post-hoc, well after the commits had landed. The worker's `completion_commit:` contract should have failed the commit before it landed, not deferred the failure to the operator's release-gate run. **This is the implementation closure for `MASTER_PLAN.md` Working Rule #2 (line 17).**

**Source files at HEAD**: `extension/src/bin/spawn-morty.ts` (worker turn-end + completion-commit logic), `extension/src/types/index.ts` (`VALID_ACTIVITY_EVENTS`), `extension/activity-events.schema.json`, `extension/CLAUDE.md` (Trap Doors section), `extension/scripts/audit-trap-door-enforcement.sh`.

**Test files (forward-created)**: `extension/tests/integration/worker-lint-gate.test.js`, `extension/tests/spawn-morty-lint-gate.test.js`.

### Acceptance criteria *(authored inline per operator brief)*

- **AC-WLG-01** *(R-WLG-1)* — Worker turn-end script in `extension/src/bin/spawn-morty.ts` runs `npx eslint <changed files in extension/src/> --max-warnings=-1` BEFORE allowing the completion commit. Verify: unit test mocks a worker with two changed `.ts` files, asserts `spawn` was invoked with `npx eslint <file1> <file2> --max-warnings=-1` exactly once and the call precedes any `git commit` invocation. Type: test.
- **AC-WLG-02** *(R-WLG-2)* — Worker turn-end runs `npx tsc --noEmit` BEFORE the completion commit. Verify: same fixture as AC-WLG-01 asserts `npx tsc --noEmit` was invoked, exit code propagated, call precedes `git commit`. Type: test.
- **AC-WLG-03** *(R-WLG-3)* — On lint or tsc failure: worker is allowed exactly **one** auto-fix attempt (e.g. `npx eslint --fix`); persistent failure after that → ticket marked `Failed` with an `lint_gate_failed` activity event written, NO completion commit. Verify: integration test creates a deliberate ESLint complexity violation, asserts (a) `worker_lint_autofix_applied` event fires once, (b) on second failure, ticket frontmatter writes `status: Failed` and `lint_gate_failed` activity event with payload `{lint_errors, tsc_errors, file_list}`, (c) zero git commits land. Type: integration.
- **AC-WLG-04** *(R-WLG-4)* — New activity events `worker_lint_gate_passed`, `worker_lint_gate_failed`, `worker_lint_autofix_applied` registered in `VALID_ACTIVITY_EVENTS` (`extension/src/types/index.ts` AND `extension/types/index.js` mirror) and in `extension/activity-events.schema.json` with payload schemas. Verify: `grep -c "worker_lint_gate_passed\|worker_lint_gate_failed\|worker_lint_autofix_applied" extension/src/types/index.ts` ≥ 3; same for `extension/types/index.js`; JSON schema validates payload via `tests/activity-event-payload.test.js`. Type: lint+test.
- **AC-WLG-05** *(R-WLG-5)* — Trap-door entry in `extension/CLAUDE.md` documenting the gate as a hard pre-commit invariant. Required fields: INVARIANT (worker MUST run lint + tsc before completion-commit; one auto-fix retry only), PATTERN_SHAPE (`spawn-morty.ts` worker turn-end MUST contain `runLintGate(changedFiles)` call before any `git commit` invocation; pattern: regex `runLintGate.*git\s+commit` with no other `git commit` calls between), BREAKS (workers ship lint-broken code; release-gate catches it post-hoc; operator burns time on remediation), ENFORCE (`extension/tests/integration/worker-lint-gate.test.js`, `extension/tests/spawn-morty-lint-gate.test.js`, `bash extension/scripts/audit-trap-door-enforcement.sh`). Verify: trap-door entry has all four fields and audit script returns 0. Type: lint.
- **AC-WLG-06** *(R-WLG forensic)* — Forensic regression test: simulate a worker producing a file with a deliberate ESLint complexity violation (e.g. cyclomatic complexity > 10); assert ticket transitions to `Failed`, `lint_gate_failed` activity event fires, and **no commit lands** (`git rev-parse HEAD` matches pre-test SHA). Verify: `extension/tests/integration/worker-lint-gate-forensic.test.js`. Type: integration.

---

## Section B — R-CNAR-7 Trap-Door Doc Completion

**Priority: P1**

*Doc-completion lift from `prds/archive/bug-reports/p1-deploy-typescript-symlink-and-cap-no-auto-resume.md:184-211` (R-CNAR-7 section + AC-CNAR-7-05). Partial precedent: commit `a8c4ecb5` 2026-05-06 added a one-line trap-door entry; this section completes the PATTERN_SHAPE + ENFORCE fields per the source PRD's AC-CNAR-7-05.*

**Problem statement**: `extension/CLAUDE.md` line 99 carries the R-CNAR-7 trap-door entry for the stale-cache cap-check guard. At HEAD it has INVARIANT, BREAKS, ENFORCE, and PATTERN_SHAPE — but the audit script `audit-trap-door-enforcement.sh` does not yet verify all 4 fields are populated specifically for the R-CNAR-7 sub-invariant (the per-ticket cap stale-cache short-circuit + iteration_start self-heal). The trap-door entry is currently single-paragraph and the audit cannot positively assert the stale-cache clauses are intact across edits.

**Source files at HEAD**: `extension/CLAUDE.md` (line 99 — existing R-CNAR-1 part 2 entry that R-CNAR-7 extends), `extension/scripts/audit-trap-door-enforcement.sh`, `extension/tests/mux-runner-cap-split.test.js:138-190` (R-CNAR-7 reproducer at HEAD).

### Acceptance criteria *(lifted verbatim from `prds/archive/bug-reports/p1-deploy-typescript-symlink-and-cap-no-auto-resume.md:205` + extended per operator brief)*

- **AC-CNAR-7-DOC-1** *(R-CNAR-7-DOC-1, lifted from source PRD line 205 — "AC-CNAR-7-05")* — Trap-door entry for `mux-runner.ts (R-CNAR-1 part 2 cap split)` in `extension/CLAUDE.md` updated to add the stale-cache guard invariant. Required fields populated: **INVARIANT** (stale per-ticket cache MUST short-circuit per-ticket cap-check whenever any of: `state.current_ticket` nullish, `state.current_ticket_max_iterations` not a positive integer, `state.current_ticket_budget_start_iteration` not a non-negative integer, `state.current_ticket_tier` not in allowed tier set; on `iteration_start`, `current_ticket=null` plus any populated per-ticket cache field MUST self-heal via atomic cache clearing before the loop proceeds), **PATTERN_SHAPE** (stale-cache guard must read `state.current_ticket` truthy plus positive-integer `state.current_ticket_max_iterations`, non-negative-integer `state.current_ticket_budget_start_iteration`, and an allowed `state.current_ticket_tier`), **BREAKS** (stale cache on resume could falsely trip the per-ticket guard with no live ticket, and iteration_start without self-heal leaves the same fields stale every loop), **ENFORCE** (`extension/tests/mux-runner-cap-split.test.js` resume-with-stale-cache fixture at lines 138-190). Verify: `grep -c "current_ticket_max_iterations" extension/CLAUDE.md` ≥ 2; entry has the literal substrings `INVARIANT:`, `PATTERN_SHAPE:`, `BREAKS:`, `ENFORCE:`. Type: lint.
- **AC-CNAR-7-DOC-2** *(R-CNAR-7-DOC-2)* — `audit-trap-door-enforcement.sh` extended to verify the R-CNAR-7 entry has all 4 fields populated (not just present as substrings — must follow each label and contain at least one non-whitespace clause). Verify: synthetic test removes the PATTERN_SHAPE clause from a fixture copy of `extension/CLAUDE.md`, asserts audit script exits non-zero. Type: test.
- **AC-CNAR-7-DOC-3** *(R-CNAR-7-DOC-3)* — ENFORCE field cites `mux-runner-cap-split.test.js` reproducer at the line range 138-190 (the resume-with-stale-cache fixture). Verify: `grep -E "mux-runner-cap-split.test.js.*138|mux-runner-cap-split.test.js" extension/CLAUDE.md` returns ≥ 1 hit on the R-CNAR-7 line; spot-check the test file lines 138-190 still contain the resume-with-stale-cache fixture (regression guard). Type: lint+test.

---

## Section C — Integration Parallel-Tier Flake Quarantine

**Priority: P1**

*Inline ACs — no source PRD. Authored per operator brief 2026-05-06.*

**Problem statement**: 2026-05-06 release `npm run test:integration` failed 20/236 tests under parallel execution; isolated runs passed all 20. Subprocess-heavy tests (R-XBL-2 leak audit, backend-spawn assertion, dispatch-EPIPE, pipeline-state-coherence, mega-bundle-e2e) race for spawn slots and OS resources (PID table, FD limits, transient port use). Splitting them into a serial tier removes the false-failure noise without sacrificing parallelism for the bulk of the suite.

**Source files at HEAD**: `extension/scripts/audit-test-isolation.sh`, `extension/package.json` (scripts.test:integration), `extension/tests/integration/` (236 files).

**Forward-created**: `extension/tests/integration/.serial-tests.json`, `extension/tests/integration/parallel-tier-isolation-audit.test.js`.

### Acceptance criteria *(authored inline per operator brief)*

- **AC-IPF-01** *(R-IPF-1)* — `extension/scripts/audit-test-isolation.sh` adds a "subprocess-heavy" classification — files matching the canonical list are tagged. Canonical list (from operator brief): `spawn-morty-backend-resolution`, `spawn-morty-actual-session-bug`, `dispatch`, `refinement-worker-crash`, `pipeline-state-coherence`, `mega-bundle-e2e`, `install-script-real`, `timeout-e2e`, `worker-backend-split`, `concurrent-state`. Verify: audit run lists all 10 file-name fragments (each may match >1 file) under a `subprocess-heavy:` heading. Type: test.
- **AC-IPF-02** *(R-IPF-2a)* — `package.json` `test:integration` script splits into two phases: `test:integration:parallel` (runs non-subprocess-heavy in parallel, default `--test-concurrency=os.cpus().length`) and `test:integration:serial` (runs subprocess-heavy serially with `--test-concurrency=1`). Top-level `test:integration` runs both phases sequentially (parallel first, then serial). Verify: `npm run` lists the three scripts; `npm run test:integration` exits 0 when both phases pass; failure in the parallel phase still runs the serial phase OR fails fast (operator-decided — refinement Cycle 1 to confirm — default: fail-fast for CI clarity). Type: test+lint.
- **AC-IPF-03** *(R-IPF-2b)* — Subprocess-heavy file list lives in `extension/tests/integration/.serial-tests.json` (single source of truth). Both `audit-test-isolation.sh` and `package.json`'s `test:integration:serial` script read the same file. Verify: file is valid JSON, contains an `entries: string[]` array, and the audit script + package.json both reference the same path; deleting the file fails both tools loud. Type: test.
- **AC-IPF-04** *(R-IPF-3)* — Forensic regression: `extension/tests/integration/parallel-tier-isolation-audit.test.js` (forward-created) asserts every test path listed in `.serial-tests.json` exists; new subprocess-spawning tests not in the list trip the audit. Detection heuristic: any test file under `extension/tests/integration/` whose source contains `child_process.spawn`, `child_process.exec`, `setupSession.*--tmux`, or `spawnMorty(` AND is NOT in `.serial-tests.json` produces an audit failure with message `unclassified subprocess-heavy test: <path>`. Verify: synthetic fixture adds a new subprocess-spawning file outside the list, asserts audit exits non-zero with the file path in stderr. Type: test.

---

## Section D — anatomy-park finalizer history crash

**Priority: P1**

*ACs lifted verbatim from `prds/archive/bug-reports/anatomy-park-finalizer-history-crash.md:157-164` (Acceptance Criteria block).*

**Problem statement**: `microverse-runner.ts:writeFinalReport()` (deployed `extension/bin/microverse-runner.js:634`) unconditionally dereferences `mvState.convergence.history`. Worker-managed convergence (anatomy-park, szechuan-sauce) does not populate `mvState.convergence`. The finalizer crashes with `[FATAL] Cannot read properties of undefined (reading 'history')` AFTER a successful convergence has been recorded; `markMicroverseFatalError()` then overwrites the success marker with `exit_reason: 'error'`, losing the actual convergence record. Pipeline-runner reads the non-zero exit and aborts the next phase.

**Source files at HEAD**: `extension/src/bin/microverse-runner.ts:571` (`buildMicroverseHandoff`), `:598` (`getBestScore`), `:634` (`writeFinalReport`), `:874` (last-accepted lookup), `:1244-1271` (`finalizeMicroverseRun`), `:1282-1291` (`markMicroverseFatalError`); `extension/src/bin/init-microverse.ts`; `extension/src/types/index.ts` (MicroverseSessionState shape).

**Test files**: `extension/tests/microverse-runner-finalizer.test.js` (extend with worker-mode fixtures), `extension/tests/pipeline-runner-anatomy-park.test.js` (forward-created or extended).

### Acceptance criteria *(lifted verbatim from prds/archive/bug-reports/anatomy-park-finalizer-history-crash.md:157-164)*

- **AC-APH-01** — `writeFinalReport()` does not throw when called with `mvState.convergence === undefined`. Unit test in `microverse-runner.test.js` constructs a worker-mode fixture (no `convergence` object) and asserts the call returns without throwing AND writes a non-empty report file.
- **AC-APH-02** — The written report for worker-mode convergence renders `Convergence Mode: worker`, omits the metric-history table, and references the convergence-file path so the operator can find the worker's reasoning.
- **AC-APH-03** — `buildMicroverseHandoff()` does not throw when `mvState.convergence` is missing. Unit test mounts a worker-mode fixture and asserts the handoff is built.
- **AC-APH-04** — `getBestScore()` returns `null` (not `NaN`, not `undefined`) when `mvState.convergence` is missing. Panel renderer at line 1264 shows "n/a" for null.
- **AC-APH-05** — `markMicroverseFatalError()` does not overwrite a `microverse.json` whose `exit_reason` is in `successfulReasons`. Unit test: write `microverse.json` with `exit_reason: 'converged'`, call `markMicroverseFatalError`, assert file unchanged AND a `microverse-finalizer-error.json` is created in the same directory documenting the post-success crash.
- **AC-APH-06** — `pipeline-runner` exits 0 when anatomy-park converges in worker mode (regression test). Integration fixture: stub `microverse-runner` to drive a worker-mode convergence + the finalizer guard logic, assert pipeline-runner advances to the next phase.
- **AC-APH-07** — New `convergence_mode` field on MicroverseSessionState, populated by `init-microverse.js` from `--convergence-mode`. Backwards-compatible default `'metric'` when absent.
- **AC-APH-08** — All `mvState.convergence.*` reader sites in `microverse-runner.ts` (audit grep: `\.convergence\.`) gate their access on `mvState.convergence_mode === 'metric'` OR are confirmed safe for worker mode (no `.history` / no `getBestScore`-style operations).

---

## Section E — anatomy-park runner undefined-description crash

**Priority: P1**

*ACs lifted verbatim from `prds/archive/bug-reports/anatomy-park-runner-undefined-description-crash.md:72-97` (the AC-APRC-01..06 block).*

**Problem statement**: `microverse-runner.ts` lines 1063 and 1188 dereference `mvState.key_metric.description`. Anatomy-park sessions don't populate `key_metric` (it's a microverse-only concept), so when one of these branches runs in anatomy-park mode the access throws `Cannot read properties of undefined (reading 'description')`. The pipeline-runner reads the exit-1 from microverse-runner and halts before szechuan-sauce gets a turn.

**Source files at HEAD**: `extension/src/bin/microverse-runner.ts:902,1063,1084,1188,1202,1523` (the `.description` access sites); `extension/src/bin/pipeline-runner.ts:1560` (global error catcher); `extension/CLAUDE.md` (Trap Doors).

**Test files (forward-created)**: `extension/tests/integration/anatomy-park-microverse-runner-no-key-metric.test.js`.

### Acceptance criteria *(lifted verbatim from prds/archive/bug-reports/anatomy-park-runner-undefined-description-crash.md:72-97)*

- **AC-APRC-01** — Reproduce in isolation. Spawn microverse-runner with `command_template = anatomy-park.md` and a manifest containing `key_metric: undefined` (or simply absent). Drive it through one iteration that ends with `worker convergence: not yet`. Assert: process exits 1 with the FATAL message. Without the fix: passes (reproducer confirmed). With the fix: assertion inverted to assert clean exit / next-iteration spawn.
- **AC-APRC-02** — Guard `mvState.key_metric` access. Branch the runner so `key_metric.*` accesses are conditional on `command_template`. In anatomy-park mode, do not consume microverse-specific fields. Lift the field accesses into a helper that returns a default string (`"(no key metric)"`) when `key_metric` is absent. File: `extension/src/bin/microverse-runner.ts` lines `1063`, `1188`, plus any nearby parts of the prompt-building helper (audit the function those lines live in).
- **AC-APRC-03** — Defensive guards on iteration history accesses. Lines `902`, `1084`, `1523`: filter `history` to drop `undefined`/`null` entries before iterating, OR add a `.filter(Boolean)` upstream where `history` is read from disk in `readRecoverableJsonObject(...)` (consistent with how `1202` already iterates with `.map`). This is defense-in-depth; the primary fix is AC-APRC-02.
- **AC-APRC-04** — Add anatomy-park integration test. New file: `extension/tests/integration/anatomy-park-microverse-runner-no-key-metric.test.js`. Spin up a session with anatomy-park manifest, stub microverse-runner to one iteration, assert no `Cannot read properties` error reaches the parent pipeline-runner. Lock the regression.
- **AC-APRC-05** — Trap-door entry in `extension/CLAUDE.md`. Pattern shape: `mvState\.key_metric\.\w+|entry\.description` accessed without an upstream existence check in `microverse-runner.ts`. Guard: parametrized lint or jest fixture ensuring all such accesses go through a helper that handles the absent-`key_metric` (anatomy-park) case.
- **AC-APRC-06** — Pipeline resumability after anatomy-park crash. Today an anatomy-park exit-1 halts the entire pipeline; szechuan-sauce never runs. Even after AC-APRC-02 ships, the pipeline-runner should be resilient: if `command_template === anatomy-park.md` and the runner crashes with a known error class (TypeError on `.description`), surface a structured `phase_skipped_with_warning` rather than `phase_failed`, allowing szechuan-sauce to proceed against the post-pickle HEAD. Recommend: graceful degrade with an explicit `pipeline.json.fail_fast: true` flag for users who want strict mode.

---

## Section F — anatomy-park / szechuan monorepo Override 6 globbing

**Priority: P1**

*Subset of `prds/archive/bug-reports/anatomy-park-szechuan-monorepo-missed-detection-gap.md:119-130` — only AC1, AC2, AC8 lifted (the Override 6 monorepo-glob fix). Subsystem discovery (AC3-4), sibling-of-fix grep (AC5), constraint_code_drift trap (AC6), and full replay regression (AC7) deferred to a dedicated PRD per the operator brief.*

**Problem statement**: `extension/.claude/commands/szechuan-sauce.md` line 344 + `extension/szechuan-sauce-principles.md` line 199 instruct Override 6 to check for `db/migrations/meta/_journal.json` relative to the target root. In a pnpm-workspace monorepo the journal lives at `packages/<pkg>/db/migrations/meta/_journal.json`. The literal-path check fails to match; Override 6 — the override specifically designed to catch CHECK-constraint-vs-TS-enum drift — silently skips on every monorepo target, which let a P0 BLOCKER `agent_check` constraint mismatch ship undetected on `loanlight-api-income-expansion`.

**Source files at HEAD**: `extension/.claude/commands/szechuan-sauce.md` (line 344 — Override 6 trigger), `extension/szechuan-sauce-principles.md` (line 199 — single-path assumption), `extension/src/bin/microverse-runner.ts` (any glob helper if needed), `extension/tests/szechuan-sauce.test.js`.

### Acceptance criteria *(lifted verbatim from prds/archive/bug-reports/anatomy-park-szechuan-monorepo-missed-detection-gap.md:119-130 — AC1, AC2, AC8 only)*

- **AC-ASMM-01** *(F-AC1)* — Override 6 detects journals at `packages/*/db/migrations/meta/_journal.json`, `apps/*/...`, `services/*/...`. Verify: unit spec `Override 6 monorepo journal globbing` covers the 3 patterns + the legacy root-level path. Type: test.
- **AC-ASMM-02** *(F-AC2)* — A target with no journal anywhere still skips Override 6 cleanly. Verify: unit spec `Override 6 absent journal still skips` passes. Type: test.
- **AC-ASMM-03** *(F-AC8)* — Override 6's `Schema Drift` check runs against the right schema TS path in monorepos. Spec asserts the schema diff compares `packages/api/src/database/schema/*.ts` against `packages/api/db/migrations/*.sql`, not the (nonexistent) `db/schema/*.ts`. Type: test.
- **AC-ASMM-04** *(F-impl, lifted from prds/archive/bug-reports/anatomy-park-szechuan-monorepo-missed-detection-gap.md:64-80 F1 fix block)* — Override 6 trigger updated from a single-literal-path check to a glob over `${target}/db/migrations/meta/_journal.json`, `${target}/packages/*/db/migrations/meta/_journal.json`, `${target}/apps/*/db/migrations/meta/_journal.json`, `${target}/services/*/db/migrations/meta/_journal.json`. When ≥1 path resolves, Override 6 iterates each discovered journal — the CHECK-constraint-vs-TS-enum diff runs per-journal. When 0 paths resolve, skipOverride6() fires per legacy behavior. Verify: deployed `~/.claude/commands/szechuan-sauce.md` post `bash install.sh` contains the glob list literal (4 paths). Type: lint.
- **AC-ASMM-05** *(F-deploy)* — `bash install.sh` runs post-merge so the deployed Override 6 prompt reflects the source change; the worker prompt files diverge from source between source-edit and `install.sh` so the AC must be verified post-deploy. Verify: `grep -F "packages/*/db/migrations/meta/_journal.json" ~/.claude/commands/szechuan-sauce.md` returns 1 hit. Type: lint+integration.

**Out-of-bundle (deferred)**: AC3/AC4 (subsystem discovery descend into monorepo packages), AC5 (sibling-of-fix grep), AC6 (`constraint_code_drift` first-class trap-door), AC7 (replay regression of session `2026-05-05-af779f40`). These belong in the next dedicated PRD `prds/anatomy-park-szechuan-monorepo-discovery-and-sibling-grep.md` once Override 6 globbing lands.

---

## Section G — codex classifier prompt-leak

**Priority: P1**

*ACs lifted verbatim from `prds/archive/bug-reports/codex-classifier-prompt-leak.md:86-93` (Requirements R1–R6) + the detection-mode + template-scrub tests at lines 132-161. Per operator brief, the 3 detection-mode + template-scrub ACs are the focus.*

**Problem statement**: When `mux-runner.js` runs with `--backend codex`, `classifyCompletion()` non-deterministically returns `'task_completed'` even when the model never emitted `<promise>EPIC_COMPLETED</promise>`. The classifier matches the literal token *inside its own prompt* — codex's plain-text output format defeats the stream-json filter that exists to prevent exactly this. User-visible failure: per-iteration "all tickets pending" guard fires after 1–2 iterations and the loop exits with `ERROR: EPIC_COMPLETED received but N ticket(s) still pending: ...`. Tickets that should have been picked up are silently abandoned (~10h work loss observed on attractor session `2026-04-24-49a70650`).

**Source files at HEAD**: `extension/src/bin/mux-runner.ts:140-230` (`extractAssistantContent` + `classifyCompletion` + `classifyTicketCompletion`); `extension/src/hooks/handlers/stop-hook.ts:170-183` (8-token authoritative list); `~/.claude/commands/{pickle,meeseeks,szechuan-sauce,microverse,pickle-tmux}.md` (worker templates).

**Test files (forward-created)**: `extension/tests/mux-runner-classifier.test.ts`, `extension/tests/template-no-bare-tokens.test.ts`, `extension/tests/mux-runner-guard-logging.test.ts`, `extension/tests/fixtures/iteration-logs/` (6 fixtures per the source PRD's matrix).

### Acceptance criteria *(lifted verbatim from prds/archive/bug-reports/codex-classifier-prompt-leak.md:86-93 — R1, R2, R3 + R4/R5 test fixtures)*

- **AC-CCL-01** *(R-CCL-1, lifted from prds/archive/bug-reports/codex-classifier-prompt-leak.md:88)* — `extractAssistantContent` MUST distinguish prompt content from model response in codex plain-text logs. Detection precedence (per source PRD Interface Contracts at line 102-107): (1) Stream-json — ≥1 line parses as JSON AND ≥1 of those is `{type:"assistant"}`; keep `type:"assistant"` and `type:"result"`. (2) Codex plain-text — ≥1 line matches `/^(user|codex|exec|tokens used|reasoning|tool_call)\s*$/`; treat content between a `codex` delimiter and the next delimiter as assistant; drop content after `user`/`exec`/`tokens used`/`reasoning`/`tool_call`. (3) Pure plain-text fallback — keep all lines. **Stream-json detection bug fix**: a single non-`type:"assistant"` JSON line MUST NOT trigger stream-json mode; detection requires evidence of *assistant* JSON, not just *any* JSON. Verify: codex log fixture with prompt-only `EPIC_COMPLETED` returns extracted content with no token. Type: test.
- **AC-CCL-02** *(R-CCL-2, lifted from prds/archive/bug-reports/codex-classifier-prompt-leak.md:89)* — `classifyCompletion` MUST return `'task_completed'` only when the model's response (not the prompt) contains the EPIC_COMPLETED token. Verify: same fixture as AC-CCL-01 → `classifyCompletion` returns `'continue'`. Type: test.
- **AC-CCL-03** *(R-CCL-3, lifted from prds/archive/bug-reports/codex-classifier-prompt-leak.md:90)* — Worker template files (`pickle.md`, `meeseeks.md`, `szechuan-sauce.md`, `microverse.md`, `pickle-tmux.md`) MUST NOT contain any classifier-matched promise token in unbroken substring form. Authoritative token list at `extension/src/hooks/handlers/stop-hook.ts:170-183` (8 tokens: `EPIC_COMPLETED`, `TASK_COMPLETED`, `ANALYSIS_DONE`, `EXISTENCE_IS_PAIN`, `THE_CITADEL_APPROVES`, `WORKER_DONE`, `PRD_COMPLETE`, `TICKET_SELECTED`, plus per-session `state.completion_promise`). Template-scrubber test sources its blocklist from that file (or a constants module both files import) so renames cannot drift the two surfaces apart. Use a sentinel/escaped form that documents the contract without colliding with the scanner. Verify: `grep -n '<promise>[A-Z_]*</promise>' ~/.claude/commands/{pickle,meeseeks,szechuan-sauce,microverse,pickle-tmux}.md` returns 0 unbroken matches outside HTML comments. Type: lint.
- **AC-CCL-04** *(R-CCL-4, lifted from prds/archive/bug-reports/codex-classifier-prompt-leak.md:91)* — Codex output format MUST be detected explicitly via the block-delimiter rule in R1, not via "stream-json failed → assume plain-text." If a future codex release drops or renames the `user`/`codex`/`exec`/`tokens used`/`reasoning`/`tool_call` delimiters, detection MUST fail loud (CI smoke pinned to `codex --version`) rather than silently regress to the prompt-leaking plain-text fallback. R4 is the *fail-loud* contract; the parser fix lives in R1.
- **AC-CCL-05** *(R-CCL-5, lifted from prds/archive/bug-reports/codex-classifier-prompt-leak.md:92)* — `mux-runner` regression tests MUST cover: codex log with promise tokens only in prompt → `'continue'`; codex log with promise tokens in model response → `'task_completed'`; claude log with promise tokens in prompt-shaped JSON → `'continue'`. Three-fixture matrix passes: `bun test extension/tests/mux-runner-classifier.test.ts`. Type: test.
- **AC-CCL-06** *(R-CCL-6, lifted from prds/archive/bug-reports/codex-classifier-prompt-leak.md:93)* — When `classifyCompletion` returns `'task_completed'` and the all-tickets-pending guard fires, the runner SHOULD include the iteration log path in the error message so operators can diagnose without grepping logs by hand. Verify: `extension/tests/mux-runner-guard-logging.test.ts`. Type: test.

**Fixture corpus** *(lifted from prds/archive/bug-reports/codex-classifier-prompt-leak.md:154-161)*: `codex-prompt-leak.log` (3× in prompt, 0× in `codex` block → `'continue'`), `codex-real-completion.log` (3× in prompt, 1× in `codex` block → `'task_completed'`), `codex-ticket-selected.log` (3× `EPIC_COMPLETED` in prompt + `TICKET_SELECTED` in `codex` block → `'continue'`), `claude-stream-json.log` (prompt-shaped `type:"user"` line embeds `EPIC_COMPLETED` → `'continue'`), `claude-real-completion.log` (`type:"assistant"` text contains the token → `'task_completed'`), `mixed-json-noise.log` (codex with one `null` line + prompt-only token → `'continue'`; regression: must NOT flip into stream-json mode).

---

## Section H — szechuan-sauce codex judge model mismatch

**Priority: P1**

*ACs lifted verbatim from `prds/archive/bug-reports/szechuan-sauce-codex-judge-model-mismatch.md:74-101` (AC-SCJM-01..06).*

**Problem statement**: When `--backend codex` is set, the judge prompt is dispatched via `codex exec` with `--model claude-sonnet-4-6`. Codex CLI v0.128.0 routes through OpenAI; on a ChatGPT-account install (no Anthropic API key bound to codex), Anthropic models are explicitly rejected with HTTP 400. The runner then treats two consecutive `metric_measurement_failed` events as a stall and fast-paths to `converged: true` with `BestScore: 0` — designed for legitimate convergence, not for tool-config failures. No principles review actually executes; the fake "all clean" signal can mask real violations.

**Source files at HEAD**: `extension/src/bin/microverse-runner.ts:~640` (convergence-check block), `extension/src/services/microverse/` (judge spawn helper if extracted), `extension/src/services/codex-spawn.ts` (or wherever codex args are assembled), `extension/src/bin/pipeline-runner.ts` (phase-failure routing), `extension/CLAUDE.md` (Trap Doors).

**Test files (forward-created)**: `extension/tests/integration/microverse-runner-judge-failure.test.js`.

### Acceptance criteria *(lifted verbatim from prds/archive/bug-reports/szechuan-sauce-codex-judge-model-mismatch.md:74-101)*

- **AC-SCJM-01** — Detect & isolate the judge model selection. Locate the model arg passed to codex when spawning the judge prompt. File reference for reviewer: grep `extension/src/` for `claude-sonnet-4-6` literal — the hardcoded string almost certainly lives in one place. Output: short writeup of the call site, what determines the model today.
- **AC-SCJM-02** — Route judge through claude unconditionally. Refactor `microverse-runner.ts` (and any helpers) to always spawn the LLM judge via the claude CLI / SDK path, even when `--backend codex` is set. Worker iteration spawn continues to honor `--backend codex`. Document the rationale in `docs/codex-prompt-design-notes.md`.
- **AC-SCJM-03** — Convergence guard against empty history. In `microverse-runner.ts:~640` (the convergence-check block after `worker convergence: not yet`): before declaring convergence, assert `convergence.history.length >= min_iterations` AND at least one history entry has a non-null `score`. If neither holds, exit with `exit_reason: judge_unreachable` and a non-zero process exit code. Update `pipeline-runner.ts` to surface `judge_unreachable` distinctly from `converged` (don't treat as success).
- **AC-SCJM-04** — Integration test. New: `extension/tests/integration/microverse-runner-judge-failure.test.js`. Stub the judge spawn to throw the literal `'claude-sonnet-4-6' model is not supported when using Codex with a ChatGPT account` error twice. Assert the runner exits with `judge_unreachable` and a non-zero code, NOT `converged`.
- **AC-SCJM-05** — Trap-door entry in `extension/CLAUDE.md`. INVARIANT: judge LLM spawn must be claude-routed regardless of `--backend`. PATTERN_SHAPE: `model:\s*claude-` or `--model\s+claude-` appearing in any codex spawn site outside the worker iteration codepath.
- **AC-SCJM-06** *(optional, scoped IN this bundle per operator brief)* — Pipeline-pipeline regression — szechuan-sauce skipped on judge failure. When `/pickle-pipeline --backend codex` reaches the szechuan-sauce phase and the judge is misconfigured, currently `microverse-runner` exits 0 (false converged), then `finalize-gate` runs and possibly modifies code based on out-of-scope toolchain failures. After AC-SCJM-03 lands, `microverse-runner` will exit non-zero. Update `pipeline-runner.ts` to NOT spawn `finalize-gate` if microverse exited with `judge_unreachable`. The pipeline should report szechuan as failed and stop, not continue down a remediation path against a phantom score.

---

## Section I — Iteration cap persistence vs display divergence

**Priority: P1**

*ACs lifted verbatim from `prds/archive/bug-reports/p1-iteration-cap-and-phantom-done-handshake.md` — R-1 (Bug A) only. R-2 covered in Section J. R-3 (codex phantom-Done speculative flips) deferred.*

**Problem statement**: On session `2026-05-03-7d9ee8cc`, `state.json:max_iterations=100` while mux-runner displayed `Limit: 15` and exited with `Max iterations reached (15/15)`. `setup.js --resume` re-derived the cap from defaults, landing on `Limit: 15`, while the originally-CLI'd `--max-iterations 500` was lost. mux-runner reads cap from the displayed limit, not from `state.json:max_iterations`. Result: 152m pickle phase exited prematurely with the operator's intended global cap silently truncated.

**Source files at HEAD**: `extension/src/bin/setup.ts` (resume logic + initial cap persistence), `extension/src/bin/mux-runner.ts` (cap-read source), `extension/src/types/index.ts` (state shape), `extension/tests/setup.test.js`, `extension/tests/state-field-invariants.test.js`.

### Acceptance criteria *(lifted verbatim from prds/archive/bug-reports/p1-iteration-cap-and-phantom-done-handshake.md:71-92 — R-ICP-3, R-ICP-4 only; AC-ICP-03 verification)*

- **AC-ICP-03-1** *(R-ICP-3, lifted verbatim from PRD line 77)* — `setup.js --resume <SESSION_ROOT>` reads `state.json:max_iterations` (and `max_time`, `worker_timeout`, `backend`) from disk and honors them as the active cap. CLI `--max-iterations` on resume overrides; otherwise persisted values win. Verify: `cd extension && npm test -- --grep setup.resume-honors-persisted-cap`. Type: test.
- **AC-ICP-03-2** *(R-ICP-4, lifted verbatim from PRD line 78)* — `setup.js` initial setup persists CLI `--max-iterations`, `--max-time`, `--worker-timeout` into `state.json` AT setup time. Subsequent reads (mux-runner, pipeline-runner, monitor) use the persisted values, not re-derive from defaults. Verify: synthetic test runs `setup.js --tmux --max-iterations 500 ...`, asserts `state.json.max_iterations === 500` immediately after setup exits. Type: test.
- **AC-ICP-03-3** *(state-field invariant)* — `state-field-invariants.test.js` extended to assert `max_iterations` is a positive integer when present and is the canonical cap source for mux-runner display + cap-check. Verify: synthetic state with `max_iterations=100` produces `mux-runner` display `Limit: 100` (not `15`) and the cap-check fires at iteration 100, not earlier. Type: test.
- **AC-ICP-03-4** *(reproducer regression)* — Replay session `2026-05-03-7d9ee8cc` reproducer per PRD line 49-55: a fresh `setup.js --tmux --max-iterations 500 ...` followed by `setup.js --resume <SESSION_ROOT>` (no `--max-iterations` arg) results in `state.json.max_iterations === 500` AND mux-runner display `Limit: 500`. Type: integration.

---

## Section J — mux-runner exits 0 on cap-hit

**Priority: P1**

*ACs lifted verbatim from `prds/archive/bug-reports/p1-iteration-cap-and-phantom-done-handshake.md` — R-2 (Bug B) only. R-1 covered in Section I.*

**Problem statement**: mux-runner returns exit code 0 when it exits cleanly — including when it hit the iteration cap without an `EPIC_COMPLETED` promise. From `pipeline-runner.ts`'s perspective, exit 0 means "phase completed normally." On session `2026-05-03-7d9ee8cc`, pipeline-runner advanced to phase 2 (citadel) and phase 3 (anatomy-park) as if pickle had completed, even though 25/38 tickets were still `Todo`. The cap-hit exit must be distinct so pipeline-runner halts and doesn't speculative-advance.

**Source files at HEAD**: `extension/src/bin/mux-runner.ts` (cap exit logic — emits `state.exit_reason = 'iteration_cap_exhausted'` per existing R-CNAR-7 trap-door at `CLAUDE.md:99` but exits code 0); `extension/src/bin/pipeline-runner.ts` (phase advance logic); `extension/src/types/index.ts` (`ExitReason`).

### Acceptance criteria *(lifted verbatim from prds/archive/bug-reports/p1-iteration-cap-and-phantom-done-handshake.md:75-89 — R-ICP-1, R-ICP-2; AC-ICP-01, AC-ICP-02)*

- **AC-ICP-01** *(R-ICP-1, lifted verbatim from PRD line 75)* — mux-runner exits with code **3** (distinct from 0=clean and 1=error) when iteration cap is hit without an `EPIC_COMPLETED` promise. `state.exit_reason` = `iteration_cap_exhausted`. Verify: `cd extension && npm test -- --grep mux-runner.iteration-cap-distinct-exit`. Type: test.
- **AC-ICP-02** *(R-ICP-2, lifted verbatim from PRD line 76)* — pipeline-runner treats exit code **3** from a phase as "phase incomplete; halt pipeline; report unfinished count." Print the unfinished ticket list with orders + IDs. Verify: `cd extension && npm test -- --grep pipeline-runner.halt-on-incomplete-phase`. Type: test.
- **AC-ICP-02-3** *(regression integration test)* — Synthetic session with 5 Todo tickets, mux-runner cap = 2. Assert: (a) exit code 3, (b) `state.exit_reason = 'iteration_cap_exhausted'`, (c) pipeline-runner halts with unfinished list (3 tickets reported), (d) phase 2 (citadel) NEVER spawns. Verify: `extension/tests/integration/mux-runner-cap-hit-pipeline-halt.test.js` (forward-created). Type: integration.
- **AC-ICP-02-4** *(distinct-exit-codes risk mitigation)* — Per PRD Risk row "Distinct exit codes break callers": pipeline-runner treats 3 as "halt-but-not-error" (no `phase_failed` event). The only other caller is interactive `/pickle` which prints the message anyway. Verify: regression test for `/pickle` interactive path asserts cap-hit exit prints the standard "iteration cap reached" message and returns to shell with exit 3, no stack trace. Type: test.

---

## Section K — deployed package.json version-only revert

**Priority: P1**

*ACs lifted verbatim from `prds/archive/bug-reports/p1-deployed-pkgjson-version-only-revert.md:36-74` (Hypothesis H-A through H-E + R-PJV-1..5 + AC-PJV-01..05).*

**Problem statement**: `~/.claude/pickle-rick/extension/package.json:version` periodically flips back to `1.64.0` while EVERY OTHER file under `~/.claude/pickle-rick/extension/` content-hashes match source. The original deploy-reversion (`schema-version-deploy-reversion-rca.md`) was a whole-tarball rsync; this is a different writer that touches ONLY `package.json`. Five candidate hypotheses (H-A test pollution, H-B worktree drift, H-C npm postinstall, H-D cron entry, H-E gh release download partial extract) need triage before mitigation.

**Source files at HEAD**: `~/.claude/pickle-rick/extension/package.json` (the deployed file under reversion), `extension/install.sh`, `extension/src/bin/mux-runner.ts` (where R-PJV-2 invariant lands), `extension/src/bin/check-update.js` (md5 already matches source per PRD line 24).

**Forward-created**: `extension/bin/verify-pkgjson-source.js` (R-PJV-4), `bundle/pjv-writer.md` (R-PJV-1 evidence), `bundle/pjv-disposition.md` (R-PJV-4 outcome).

### Acceptance criteria *(lifted verbatim from prds/archive/bug-reports/p1-deployed-pkgjson-version-only-revert.md:58-74)*

- **AC-PJV-01** *(R-PJV-1, lifted from PRD line 60 + 70)* — Identify the writer that mutates ONLY `~/.claude/pickle-rick/extension/package.json` (file-level `fs_usage` / `fswatch` / `lsof` during a fresh `bash install.sh` + 60-min observation window). Output: `lsof`/`fs_usage` evidence in `bundle/pjv-writer.md` identifies the writer. Type: lln-conformance (manual). Empirical artifacts to gather (PRD lines 84-91): `sudo fs_usage -w -f filesys 2>&1 | grep "extension/package.json"`, `sudo lsof +D ~/.claude/pickle-rick/extension/`, `tail -f ~/.claude/pickle-rick/debug.log | grep -E "Spawning|written"`.
- **AC-PJV-02** *(H-A test pollution)* — If H-A: grep -rn "EXTENSION_DIR" extension/tests/ produces no leaked writes; CI guard `scripts/audit-test-isolation.sh` fails on regression. Type: lint+test.
- **AC-PJV-03** *(H-B worktree drift)* — If H-B: install.sh refuses to deploy from any path containing `.claude/worktrees/agent-` (already covered by AC-DR-13 — verify still in force). Type: integration.
- **AC-PJV-04** *(H-C/H-D/H-E external)* — If H-C/H-D/H-E: documented in `bundle/pjv-disposition.md` + mitigation wired (R-PJV-4: `bin/verify-pkgjson-source.js` compares source against deployed at every mux-runner iteration boundary). Type: integration.
- **AC-PJV-05** *(R-PJV-5, lifted from PRD line 64 + 74)* — Reverted-pkgjson reproducer fails (no revert in 60-min window post-install). Synthetic regression: simulate the writer in a fixture; assert R-PJV-2 invariant emits `pkgjson_only_revert_detected` activity event. `pkgjson_only_revert_detected` event registered in `VALID_ACTIVITY_EVENTS` and `activity-events.schema.json`. Type: integration+lint.
- **AC-PJV-06** *(R-PJV-2, lifted from PRD line 61)* — Runtime-validated invariant: at startup, mux-runner reads SRC_V + DEP_V; if mismatch + 3-file-hash match (per the PRD reproducer at line 45-52), emits `pkgjson_only_revert_detected` activity event with file:line evidence of the writer (post-R-PJV-1). Verify: synthetic test stubs SRC_V=1.71.0, DEP_V=1.64.0, hashes matching → event fires once with payload `{src_version, deployed_version, src_hash, dep_hash, writer_evidence_path}`. Type: test.

**Sequencing** *(lifted from PRD lines 76-79)*: (1) Diagnose first (R-PJV-1) — without empirical evidence we'd be writing more defense-in-depth for an unidentified hypothesis. (2) After diagnosis, fix at root (R-PJV-3 if internal, R-PJV-4 if external). (3) R-PJV-2 + R-PJV-5 are the regression guards.

---

## Section L — strip excessive defense from deploy-reversion bundle

**Priority: P1**

*ACs lifted verbatim from `prds/p1-strip-excessive-defense-deploy-reversion.md:62-77` (AC-STRIP-01..12) and the "Strip — components to remove" table at PRD lines 31-39.*

**Problem statement**: The P0 deploy-reversion bundle (`p2-bundle-deploy-reversion-and-gate-baseline-diagnostic.md`, 30 tickets, ~1295 LOC) over-engineered the response to a one-line procedural bug (`bin/release-gate.sh --pre-tag` is the actual fix). Cycle 3 stacked defense at every layer because the forensic timeline showed reversions striking 30–60 min after `install.sh`. ~480 LOC of cron sampling, drift detection, artifact invalidation, T+24h scheduled finalizers, and forward-compat schema shims must be stripped before further releases.

**Source files at HEAD (to delete or patch)**: `extension/bin/verify-deploy-parity.js`, `extension/install.sh` (cron-install/uninstall blocks, `deploy-baseline.json` write), `extension/src/bin/mux-runner.ts` (SHA-256 baseline + drift halt), `extension/bin/finalize-bundle.js`, `extension/bin/verify-launch.js`, `extension/src/types/index.ts` (`deploy_drift_detected` event), test files for the deleted scripts.

### Acceptance criteria *(lifted verbatim from prds/p1-strip-excessive-defense-deploy-reversion.md:62-77 — AC-STRIP-01..12)*

- **AC-STRIP-01** *(lifted from PRD line 66)* — `bin/verify-deploy-parity.js` does not exist on disk after strip. Type: lint.
- **AC-STRIP-02** *(PRD line 67)* — install.sh contains no `crontab` invocation; no cron entry installed by `bash install.sh`. Type: lint.
- **AC-STRIP-03** *(PRD line 68)* — install.sh does not write `~/.claude/pickle-rick/deploy-baseline.json`. Type: lint+integration.
- **AC-STRIP-04** *(PRD line 69)* — `bin/finalize-bundle.js` does not exist. Type: lint.
- **AC-STRIP-05** *(PRD line 70)* — `bin/verify-launch.js` does not exist. Type: lint.
- **AC-STRIP-06** *(PRD line 71)* — `extension/src/bin/mux-runner.ts` contains no `deploy_drift_detected` event emission, no SHA-256 baseline computation, no `bundle/ac-dr-*.json` invalidation logic. Type: lint.
- **AC-STRIP-07** *(PRD line 72)* — `extension/src/types/index.ts` `VALID_ACTIVITY_EVENTS` does NOT contain `'deploy_drift_detected'` (the two `baseline_recapture_*` events stay — Section B keeps them). Type: lint.
- **AC-STRIP-08** *(PRD line 73)* — `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test` all green. Type: integration (release-gate-equivalent).
- **AC-STRIP-09** *(PRD line 74)* — `bash bin/release-gate.sh --pre-tag <test-fixture-tag>` still passes. Type: integration.
- **AC-STRIP-10** *(PRD line 75)* — Refined PRD (`prds/p2-bundle-deploy-reversion-and-gate-baseline-diagnostic.md`) marks AC-DR-03 (24h soak), AC-DR-07 (1h soak), AC-DR-15 (PRE-FLIGHT) as `status: removed` with strip-PRD cross-reference. Type: lint.
- **AC-STRIP-11** *(PRD line 76)* — `extension/package.json` bumped to **1.72.0** (post-v1.71.0) AFTER all strips and gates green. *Note: source PRD says 1.68.0 — that was the pre-v1.71.0 era. Update to 1.72.0 since v1.71.0 already shipped 2026-05-06.* Type: lint.
- **AC-STRIP-12** *(PRD line 77)* — Single commit: `chore: strip excessive defense from deploy-reversion bundle (P1 follow-up)` containing ALL of AC-STRIP-01..11. Type: lint.

**Strip surface table** *(lifted verbatim from PRD lines 31-39)*:

| Component | Files | Source ticket | LOC removed |
|---|---|---|---|
| Cron sampler | `bin/verify-deploy-parity.js`, install.sh cron-install/uninstall blocks, `deploy-baseline.json` write | A.11 (`a3038fa4`) | ~150 |
| Mux-runner pre-flight | `extension/src/bin/mux-runner.ts` SHA-256 baseline + drift halt + artifact invalidation hooks; `deploy_drift_detected` event | A.8 (`c56ab4a7`) | ~80 |
| Scheduled-soak finalizer | `bin/finalize-bundle.js`, `extension/tests/finalize-bundle.test.js` | scheduled-soak (`14eb3a15`) | ~180 |
| Launch-gate verifier | `bin/verify-launch.js`, `extension/tests/launch-gate.test.js` | closer artifact piece | ~60 |
| AC-DR-15 PRE-FLIGHT artifact | `bundle/ac-dr-15.json` writes anywhere, `bundle/ac-dr-pre-flight.json` references | mux-runner pre-flight | ~10 |

**Total**: ~480 LOC removed, 4 ticket-units of complexity collapsed into one strip commit.

---

## Conformance Check

For each section, the ticket file produced by `/pickle-quick-refine` (or refinement) MUST:

- [ ] **Cite source PRD path** in the ticket frontmatter `source_prd:` field (or the literal string `"inline (no source PRD)"` for Sections A and C; or `"inline (doc-completion only)"` for Section B's R-CNAR-7-DOC-* extension).
- [ ] **Lift R-XXX requirement codes verbatim** in the AC list — no paraphrase of identifiers (case + dashes preserved).
- [ ] **Include explicit `file:line` anchors** where the source PRD specified them (Sections D, E, F, G, H, I, J, K, L all carry concrete line numbers; A, B, C carry forward-created file paths).
- [ ] **7-class machinability check** annotation in the ticket frontmatter:

```yaml
audit:
  classes_checked: [forward-ref, path-drift, missing-deps, wrong-HEAD-assumptions, cross-doc-naming, hallucinated-premise, literal-value-drift]
  checked_at: 2026-05-06
  # Ticket file MUST contain the literal HTML comment: <!-- audit: 7-class checked 2026-05-06 -->
```

- [ ] **Verbatim-lift annotation**: each section header carries `*(lifted from <PRD-path>:<line-range>)*` when ACs are verbatim, or `*(authored inline per operator brief 2026-05-06)*` for A/C, or `*(doc-completion lift from <PRD>:<line-range>)*` for B.
- [ ] **No `composes:` block** in the ticket frontmatter — ACs MUST be in-section, not delegated. (This bundle's authoring constraint, learned from 2026-05-05 Path A.)
- [ ] **`Priority: P1` or `P2`** literal in the section header (this bundle: all 12 are P1).

### Bundle-level conformance

- [ ] **AC-BUNDLE-2026-05-06-01** — All 12 sections present in this PRD. Verify: `grep -c '^## Section ' prds/archive/bundles/p1-bug-fix-bundle-2026-05-06.md` ≥ 12.
- [ ] **AC-BUNDLE-2026-05-06-02** — Every R-* code in section bodies maps to exactly one AC line (no orphan codes). Verify: `grep -E 'R-(WLG|CNAR-7-DOC|IPF|APH|APRC|ASMM|CCL|SCJM|ICP|PJV|STRIP|AFHC)-[0-9]+' prds/archive/bundles/p1-bug-fix-bundle-2026-05-06.md | sort -u | wc -l` matches the AC count.
- [ ] **AC-BUNDLE-2026-05-06-03** — No `composes:` block in the front-matter. Verify: `grep -c 'composes:' prds/archive/bundles/p1-bug-fix-bundle-2026-05-06.md` returns 0.
- [ ] **AC-BUNDLE-2026-05-06-04** — Verbatim-lift attribution present for every section that has a source PRD (B/D/E/F/G/H/I/J/K/L = 10 sections). Verify: `grep -c 'lifted from prds/' prds/archive/bundles/p1-bug-fix-bundle-2026-05-06.md` ≥ 10.
- [ ] **AC-BUNDLE-2026-05-06-05** — Bundle ends with a clean working tree on local `main` and a green local gate (`cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && npm run test:fast && npm run test:integration`). NO `gh release create`; NO push.
- [ ] **AC-BUNDLE-2026-05-06-06** — Section A (`R-WLG-*`) lands BEFORE any post-bundle session, so the lint gate prevents future `MASTER_PLAN.md` Working Rule #2 violations. Ordering constraint: Section A is first in the implementation queue.

---

## Skipped / deferred (final list)

- `prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md` — too big for this batch (6+ tickets); next dedicated batch.
- `prds/archive/bug-reports/p2-worker-silent-exit-and-ticket-path-drift.md` — pair with the ticket-authoring epic above.
- `prds/p1-worker-spawns-codex.md` R-XBL-1/-6 — partial precedent shipped 2026-05-05; revisit with telemetry.
- `prds/archive/bug-reports/pipeline-runner-state-active-not-claimed-on-relaunch.md` — P3, not blocking.
- Section F deferred ACs (AC3/4/5/6/7 from `anatomy-park-szechuan-monorepo-missed-detection-gap.md`) — subsystem discovery + sibling-of-fix grep + `constraint_code_drift` first-class trap-door + replay regression. File standalone PRD `prds/anatomy-park-szechuan-monorepo-discovery-and-sibling-grep.md` after Override-6 globbing lands.
- Section I/J: R-3 from `p1-iteration-cap-and-phantom-done-handshake.md` (codex phantom-Done speculative flips, R-ICP-5/6 phantom-Done watcher + worker prompt completion-commit-hash requirement) — sister bug deferred to next batch.

— Pickle Rick out. *belch*

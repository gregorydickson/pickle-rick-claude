# PRD: Convergence Toolchain Gates — szechuan-sauce + anatomy-park

**Status**: Shipped (v1.58.0 — 25 atomic tickets, 122 commits)
**Author**: Pickle Rick
**Source**: Post-mortem on LOA-618 epic (loanlight-api `gregory/loa-618-updated-appraisal-comparison-epic`, 164 commits, 12h anatomy-park run, 116 trap doors). Validation by an agent team after both skills declared convergence found 1 typecheck error + 66 ESLint errors + an untested spec-mock cast — none of which the convergence loops can see today.

---

## Problem

`/szechuan-sauce` and `/anatomy-park` both declare convergence based on their own internal definitions (no more applicable principles, no more CRITICAL/HIGH findings). Neither runs the project's actual toolchain gates (`pnpm run typecheck`, `pnpm run lint:quiet`, `pnpm test`) at the convergence boundary. Convergence is therefore **semantic**, not **shippable**.

**Concrete failure case (LOA-618):**

After /pickle-tmux build → /szechuan-sauce (converged in 2 iterations) → /anatomy-park (converged at iteration 76, all 4 subsystems clean, 116 trap doors), an independent 5-agent validation pass found:

- 1× TS2352 in `image-extraction.service.spec.ts:95` (mock missing `transformToByteArray`) — introduced when production type signature changed; never caught because the orchestrator doesn't run a *full-repo* gate at the convergence boundary.
- 60× prettier formatting drift across `portal-appraisal.service.ts`, `appraisal.processor.spec.ts`, `portal-audit-log.controller.ts` — accumulated across ~50 anatomy-park edits where each individual Codex worker commit was behaviorally correct but introduced sub-style drift the file's prior style enforced.
- 6× substantive lint errors: `no-control-regex` in two new security-fix sites, `require-await` in 3 spec files (matches the documented async-generator trap door in `packages/api/CLAUDE.md`), `no-unnecessary-type-assertion` in two sites.

Net: branch is semantically green but mechanically red. Cannot push to PR until human runs the gates by hand and triggers a remediation pass.

**Why each skill missed it (different root causes):**

1. **szechuan-sauce intentionally filters out toolchain noise.** Its principle filter explicitly drops "CI-surfaceable linter/typechecker/compiler noise" (`szechuan-sauce.md:274`) on the grounds that the spec is the review, not the toolchain. This is a deliberate scope choice — but it produces a skill that converges with `tsc --noEmit` red.
2. **anatomy-park's worker runs tests per iteration, but only for "affected packages".** *(refined: codebase, cycle 3)* `anatomy-park.md:270` (Override 2, PHASE 2: FIX, step 4) says "Run the full test suite for all affected packages." So the worker DOES run tests every iteration — but **scoped to packages it touched**. Cross-package mock drift (e.g. a production type change in `packages/api` whose mock lives in `packages/web-app/spec/`) accumulates because no single iteration's affected-packages set spans the production-type/consumer-mock boundary. The orchestrator (microverse-runner.ts) does not run any toolchain checks at all.
3. **Test files are out-of-scope for both skills' principle reviews.** anatomy-park scopes review to product subsystems; szechuan principles target src code. Spec-file mocks going stale during refactors of the production type they mock is a class of regression neither catches.

**What's missing:** a shared primitive that runs the project's real gates (typecheck + lint + tests) and triggers a focused remediation pass when red — invoked at the right moments for each skill's loop topology.

---

## Goal

Add a `convergence-gate` primitive plus a thin `morty-gate-remediator` worker that both skills invoke at policy-appropriate moments via a new `finalize-gate` post-runner orchestrator. Convergence cannot be declared until the gate is green (or a documented baseline is preserved).

```
/szechuan-sauce flow
   ↓
[microverse-runner: principles converge (worker mode)]
   ↓ exits
[finalize-gate.ts: typecheck + lint + tests, STRICT, scope='full' ∩ allowed_paths]
   ↓ red?
[morty-gate-remediator: scoped to failing files] ──┐
   ↓                                              ↓
[finalize-gate re-runs] ────────────────────────┘
   ↓ green
[tmux echo: "The sauce... is obtained. Gate green."]


/anatomy-park flow
   ↓
[Setup Mode Step 6.6: convergence-gate baseline (typecheck+lint, scope='full' ∩ allowed_paths)]
   ↓
[microverse-runner: per-subsystem rotation (worker mode)]
   ↓ per-iteration (in runner): convergence-gate baseline mode, scope='changed', since=preIterSha
   ↓ red? → morty-gate-remediator (single attempt) → soft-flag if unfixed → continue
   ...
[all subsystems consecutive_clean ≥ 2; runner exits]
   ↓
[finalize-gate.ts: typecheck + lint + tests, STRICT, scope='full' ∩ allowed_paths]
   ↓ red?
[morty-gate-remediator] → re-run (cap 5)
   ↓ green
[tmux echo: "Anatomy Park is closed. ... Gate green ... R regression flags during loop."]
```

**Non-goals:** porting CI-quality enforcement into the loop; running e2e/integration/golden/smoke tests inside iteration (unit-test alias only — these suites are too slow and too prone to flakiness for an inner-loop gate); replacing CI as the source of truth.

---

## Scope

### In-scope
- New service `extension/src/services/convergence-gate.ts` exposing `runGate(opts) → GateResult`.
- New script `extension/src/bin/check-gate.ts` for ad-hoc invocation + skill dispatch.
- **NEW** `extension/src/bin/finalize-gate.ts` *(refined: codebase, cycle 3)* — post-runner orchestrator invoked from szechuan-sauce.md:205 and anatomy-park.md:166 tmux send-keys chain. Owns the multi-cycle gate↔remediator loop.
- New agent-md `.claude/agents/morty-gate-remediator.md` (scoped, fast, mechanical-only worker).
- Project-aware command resolution: detects pnpm/npm/yarn/cargo/go workspace and runs the right commands.
- Integration into `szechuan-sauce.md` (Override 3 step 4 region — *not* the existing Step 8 in INVOCATION MODE) and `anatomy-park.md` (Setup Mode Step 6.6 baseline + per-iteration baseline gate inside microverse-runner.ts:843-857 + final strict gate via finalize-gate.ts).
- Baseline capture at `${SESSION_ROOT}/gate/baseline.json` *(refined: codebase, cycle 3 — `gate/` subdir, ISO-8601 timestamped artifacts)*.
- Unit-test invocation only — never integration/e2e/golden-baseline.
- `iteration_regressions: number` field added to `MicroverseSessionState` (`microverse-state.ts:30-58`), NOT `State` *(refined: codebase, cycle 3)*.

### Out-of-scope
- Running tests inside `/szechuan-sauce` per-iteration (its loop is too short and its principles target src, not tests).
- Behavioral or browser tests.
- Replacing per-skill convergence definitions — gates are an *additional* requirement, not a replacement.
- Auto-fix of substantive logic errors. Remediator only handles mechanical drift (prettier, simple lint autofixes, type-narrowing micro-edits, broken test mocks where the production signature is the source of truth).
- Pickle-microverse, council-of-ricks, plumbus, meeseeks (separate PRDs if needed). `/pickle-microverse` is explicitly out via the `enabled_convergence_files` allowlist (default: `["anatomy-park.json"]`); microverse's `convergence_file` is `microverse.json` and is NOT in the default list.

---

## Dependencies & Sequencing

*(refined: risk-scope, cycle 3)*

This PRD has **two** cross-PRD dependencies. PR-merge ordering matters.

| Dep | Other PRD | Direction | Resolution |
|:---|:---|:---|:---|
| D1 | `prds/bmad-inspired-hardening.md` | Bmad introduces `tests/agent-md-schema.test.js` which would validate `morty-gate-remediator.md`; this PRD's P1.1 vendors a **provisional** minimal-test (`tests/agent-md-frontmatter-required-keys.test.js`) so this PRD is mergeable independently. | When bmad lands and its `agent-md-schema.test.js` covers the same assertions, the **bmad PR** deletes this PRD's vendored test (NOT this PRD's PR). |
| D2 | `prds/archive/bundles/large-tier-stall-recovery.md` | Stall-recovery extends the auto-commit rescue (`microverse-runner.ts:862-883`) into the worker-mode branch (lines 843-857); without it, anatomy-park's per-iteration gate must skip dirty worktrees (P3.2 option b). | This PRD's P3.2 implements **both** branches: when stall-recovery has landed, gate uses rescue; when not, gate emits `gate_skipped` with `reason: 'dirty_worktree_no_rescue'`. PR-order independent. |

---

## Requirements

### P0 — `convergence-gate` Service + Bin

| ID | Requirement | Verification |
|:---|:---|:---|
| P0.1 | New service `extension/src/services/convergence-gate.ts` exports `runGate(opts: { workingDir, mode: 'baseline'\|'strict', scope: 'full'\|'changed', checks: ('typecheck'\|'lint'\|'tests')[], baselinePath?, since?: string, allowedPaths?: string[] }) → Promise<GateResult>`. `GateResult` = `{ status: 'green'\|'red'\|'green-with-known-flake-warnings', failures: GateFailure[], baseline_used: boolean, allowed_paths_used: boolean, elapsed_ms: number, total_raw_failure_count: number, new_failures_vs_baseline: number }`. `GateFailure` = `{ check: 'typecheck'\|'lint'\|'tests', file, line, ruleOrCode, message, severity: 'error'\|'warning', occurrence_index: number }`. *(refined: requirements + codebase, cycle 3 — added `allowedPaths`, `total_raw_failure_count`, `occurrence_index`)* | `tests/services/convergence-gate.test.js` |
| P0.2 | Project-resolution: probes `package.json`+`pnpm-lock.yaml` (pnpm), `package.json`+`yarn.lock` (yarn), `package.json` (npm), `Cargo.toml` (cargo), `go.mod` (go) at `workingDir`. Resolves the canonical typecheck/lint/test commands per `extension/data/gate-commands.json` (NEW). The shipped runtime reads command definitions from that data file, not from a `pickle_settings.json` consumer. | `tests/services/convergence-gate-resolution.test.js` |
| P0.2a | *(NEW — refined: requirements, cycle 3)* If project-type detection succeeds but `gate-commands.json` has no entry, gate emits `gate_skipped` with `reason: 'project_type_low_confidence'` and detected signals, exits `status: 'green'` (no false-red), `elapsed_ms: 0`. Recovery is to add the missing project mapping in `extension/data/gate-commands.json`. | `tests/services/convergence-gate-resolution.test.js` adds a `bun.lockb` fixture |
| P0.3 | Workspace awareness: if `package.json:workspaces` present (or `pnpm-workspace.yaml`), gate runs in **each affected workspace package** based on `scope`. `scope: 'changed'` uses `git diff --name-only <since>..HEAD` to filter. `scope: 'full'` runs all workspaces matching `allowedPaths` (when set). | `tests/services/convergence-gate-workspaces.test.js` (3-package fixture) |
| P0.3.1 | *(NEW — refined: codebase, cycle 3)* `allowedPaths: string[]` (glob list) intersects `scope: 'full'`. Files outside `allowedPaths` are NOT gated even when `scope: 'full'`. When `allowedPaths` is omitted, `scope: 'full'` means full repo. `GateResult.allowed_paths_used` records what was applied. | `--scope packages/api` fixture: gate must NOT report failures in `packages/web-app/` even if pre-existing |
| P0.4 | Baseline capture: `runGate({mode: 'baseline', baselinePath})` records every current failure as a `{check, file, ruleOrCode, occurrence_index, severity}` tuple to `baselinePath`. Subsequent baseline-mode runs subtract baseline; only new failures count as red. Fingerprint is `(file, ruleOrCode, occurrence_index)` — line numbers shift legitimately. *(refined: requirements + risk-scope, cycle 3 — three-way confluence on multi-instance fingerprint)* | `tests/services/convergence-gate-baseline.test.js` covers same-rule-twice-in-same-file |
| P0.4a | *(NEW — refined: requirements, cycle 3)* `gate_baseline.json` JSON schema is fixed at `GateBaselineFile` in `extension/src/types/index.ts`: `{ schema_version: 1, captured_at: string (ISO-8601 UTC), working_dir: string, project_type: 'pnpm'\|'npm'\|'yarn'\|'cargo'\|'go', checks: ('typecheck'\|'lint'\|'tests')[], failures: GateFailure[] }`. `occurrence_index` in failures sorted by line ascending at capture (line not stored — line drift is intentional per P0.4 fingerprint policy). | `tests/services/convergence-gate-baseline-schema.test.js` asserts emitted file conforms via JSON.parse + structural predicate. Parity test `tests/services/convergence-gate-baseline-schema-parity.test.js` ensures emitted shape matches type. |
| P0.4b | *(NEW — refined: requirements, cycle 3)* `runGate` acquires a workingDir-scoped advisory lock before reading or writing `gate/baseline.json`. Lock implementation: `state-manager.ts` `withLock` pattern (`microverse-runner.ts:758` precedent), key `gate-${sha256(workingDir)}`, timeout 30s. On lock-timeout, gate exits red with sentinel failure `{ check: 'tests', file: '<lock-timeout>', ruleOrCode: 'GATE_LOCK_TIMEOUT', message: 'baseline lock timeout after <waited>ms', severity: 'error', occurrence_index: 0 }`. Activity events `gate_lock_acquired` and `gate_lock_timeout`. | `tests/services/convergence-gate-lock.test.js` |
| P0.5 | Hang guard: each spawned check (typecheck/lint/test) carries explicit timeout. The shipped gate currently uses internal service defaults: typecheck 120s, lint 60s, tests 300s, plus a workspace cumulative cap of 600000ms. Test seams can override these limits via `runGate(opts._timeouts)`, but the current runtime does **not** read `pickle_settings.json:convergence_gate.timeout_ms.<check>` or `convergence_gate.gate_total_timeout_ms`. *(refined: risk-scope, cycle 3 — added cumulative cap)* | `tests/services/convergence-gate-hang-guard.test.js` |
| P0.6 | Test invocation: ONLY runs `pnpm test` / `npm test` / `yarn test` (the unit-test alias). NEVER `pnpm test:integration`, `pnpm test:e2e`, `golden:*`, or any script matching `/integration\|e2e\|golden\|smoke\|baseline/i`. Hard refusal with stderr message; activity event `gate_unsafe_test_command_blocked`. | `tests/services/convergence-gate-test-safety.test.js` |
| P0.6a | *(NEW — refined: requirements, cycle 3, positive-allow)* Test invocation precedence: (1) Resolve project type → resolve `<pkgmgr> test` (the bare alias). (2) Read `package.json:scripts.test` content. (3) Reject if content matches `/integration\|e2e\|golden\|smoke\|baseline\|playwright\|cypress\|hardhat/i`. (4) Reject if content does NOT match any of `/(vitest\|jest\|node --test\|mocha)/` (positive allow); unsafe or unsupported test aliases stay out of the gate's runnable set rather than creating a phantom `gate_skipped` reason. The shipped runtime inspects `scripts.test` only; `pickle_settings.json:convergence_gate.prefer_test_unit_alias` is present in defaults but is not currently consumed by the gate. | 9-fixture test (bare unit-test allow, `test:integration` block, `test:db` block, `playwright` content-block, missing-`test` skip, etc.) |
| P0.6b | *(NEW — refined: risk-scope, cycle 3)* Mid-loop dirty worktree: at gate entry, capture `git status --porcelain`. If non-empty AND in worker-mode per-iteration call, emit `gate_skipped` with `reason: 'dirty_worktree_no_rescue'` and skip gate this iteration. (When stall-recovery PRD lands and rescue is extended into worker-mode branch, this skip path is replaced by invoking the rescue.) | `tests/integration/anatomy-park-dirty-tree-skip.test.js` |
| P0.6c | *(NEW — refined: risk-scope, cycle 3, R16)* Branch-switch detection: at gate entry, capture `git rev-parse HEAD`, `git rev-parse --abbrev-ref HEAD`, `git status --porcelain` count. Compare against values captured at preIterSha. If branch differs OR uncommitted-change count differs by more than the iteration's expected delta, halt with `${SESSION_ROOT}/gate/workingdir_drift_<iso>.md` describing divergence; do not auto-resolve. Emit `gate_workingdir_drift_detected`. | `tests/integration/anatomy-park-branch-switched.test.js` |
| P0.7 | New bin `extension/src/bin/check-gate.ts` with flags: `--mode baseline\|strict`, `--scope full\|changed`, `--since <ref>`, `--checks typecheck,lint,tests`, `--baseline-path <path>`, `--working-dir <path>`, `--allowed-paths-file <path>` (reads `scope.json:allowed_paths`), `--json`. Exits 0 (green), 2 (red), 1 (internal error), 3 (green-with-known-flake-warnings). `--json` emits `GateResult` to stdout. | `tests/bin/check-gate.test.js` |
| P0.8 | *(REWRITTEN — refined: codebase, cycle 3)* All 15 new gate / iteration activity events added to `VALID_ACTIVITY_EVENTS as const` in `extension/src/types/index.ts:203`: `gate_baseline_captured`, `gate_run_complete`, `gate_skipped` (currently used with `reason: 'no_project_type_detected'\|'project_type_low_confidence'\|'dirty_worktree_no_rescue'\|'no_commits'\|'kill_switch'`), `gate_unsafe_test_command_blocked`, `gate_remediation_complete`, `gate_remediation_aborted_unverified_production_change`, `gate_autofix_reverted`, `gate_workingdir_drift_detected`, `gate_lock_acquired`, `gate_lock_timeout`, `gate_diff_scope_fallback`, `gate_preexisting_tests_baselined`, `iteration_left_regression`, `gate_regression_threshold_warning`, `gate_out_of_scope_failures_present`. `ActivityEvent` interface (`types/index.ts:246-265`) extended with `gate_payload?: Record<string, unknown>` open-ended field. | Greppable: assertion that all 15 names are in `VALID_ACTIVITY_EVENTS` literal; type-level test that `ActivityEventType` union includes each |
| P0.8a | *(NEW — refined: requirements, cycle 3)* `gate_run_complete.gate_payload` must include: `failure_count: number` (count of failures in `GateResult.failures` post-baseline-subtract — the user-visible 'red' count), `total_raw_failure_count: number` (pre-subtract count), `new_failures_vs_baseline: number` (`failures.filter(f => !baseline_set.has(fingerprint(f))).length`). All integers, ≥ 0. | Schema test |
| P0.16 | *(NEW — refined: risk-scope, cycle 3)* Freshness enforcement currently exists as the exported helper `assertBaselineFresh(baselinePath, { max_age_iterations, max_age_seconds, current_iteration })` in `convergence-gate.ts`. That helper writes `${SESSION_ROOT}/gate/baseline_missing_<iso>.md` on a missing baseline and throws on stale age / iteration thresholds, but the shipped `runGate()` path does **not** invoke it or load `convergence_gate.baseline_max_age_iterations` / `convergence_gate.baseline_max_age_seconds` from `pickle_settings.json`. | `tests/services/convergence-gate-baseline-freshness.test.js` |

### P1 — `morty-gate-remediator` Worker

| ID | Requirement | Verification |
|:---|:---|:---|
| P1.1 | New agent-md `.claude/agents/morty-gate-remediator.md` with frontmatter `name: morty-gate-remediator`, `description: <one-line>`, `tools: Read, Edit, Bash, Glob, Grep`. Optional `model: sonnet`, `role: gate-remediator`. Identity: mechanical fixer of toolchain drift; explicitly forbidden from semantic refactors, behavior changes, or scope expansion. | `tests/agent-md-frontmatter-required-keys.test.js` (NEW vendored test — minimal `name`/`description`/`tools` required-key check; YAML frontmatter parsed by hand-rolled flat parser, no `gray-matter` dep). When bmad PRD lands and `tests/agent-md-schema.test.js` covers same assertions, **bmad PR** deletes this vendored test (D1) |
| P1.2 | Worker prompt receives: (1) verbatim `GateResult.failures` list, (2) the failing files' current contents, (3) the project's relevant CLAUDE.md trap-door section, (4) hard rule "fix ONLY the listed failures; do not edit any other lines; do not change behavior; if a fix requires a behavior change, abort and write `${SESSION_ROOT}/gate/remediation_aborted_<iso>.md` with reason." | `tests/morty-gate-remediator-prompt.test.js` snapshot test |
| P1.3 | Auto-fix delegation: for prettier/eslint-autofix-eligible failures, worker runs the project's `--fix` form (`pnpm exec eslint --fix <files>`, `pnpm exec prettier --write <files>`) BEFORE attempting any hand-edit. Then runs the gate again on those files only and reports residual. | Integration test: 60 prettier failures → all auto-cleared in one pass |
| P1.3a | *(NEW — refined: risk-scope, cycle 3, R13)* Snapshot-and-revert protocol for autofix corruption. Strategy: per-file content + sha256 in-memory for files ≤ 1MB; `git stash push --keep-index <oversize_files>` fallback for files > 1MB. This snapshot strategy is an internal remediator mechanism; the shipped activity contract logs the revert outcome via `gate_autofix_reverted`, not a separate `gate_autofix_snapshot_strategy` event. After autofix, re-run any previously-green test files scoped to the autofixed file set. If any previously-green test goes red: revert via in-memory `fs.writeFile` + sha256 verify (memory mode) or `git checkout stash@{0} -- <files> && git stash drop` (stash mode); emit `gate_autofix_reverted` with `reverted_files: string[]`. | `tests/services/convergence-gate-autofix-revert.test.js` (poisoned-autofix fixture exercises BOTH paths) |
| P1.4 | *(REWRITTEN — refined: requirements, cycle 3, production-test-coverage proxy)* Hand-fix scope limited to: (a) regex character class ranges (`\xNN` → `\uNNNN`); (b) `async function*` without `await` → wrap with typed `AsyncIterable` helper per `packages/api/CLAUDE.md`; (c) `as Type` removal where TS already infers; (d) **spec-file type-only mock alignment** to production type signature, IFF: (i) the failure code is one of `TS2741`, `TS2345`, `TS2352`, `TS2739` (the "missing/incompatible property" family); (ii) the change is purely additive (adding a method or property to a mock object) — never removing or changing behavior; (iii) at least one OTHER test/spec file (not the failing one) imports the production module and exercises the changed type's behavior — proxy that the production change has been minimally validated; (iv) the remediator records the production-coverage-test path in `gate_remediation_complete.gate_payload.production_coverage_test_path`. If (iii) fails (no covering test exists), abort with `${SESSION_ROOT}/gate/remediation_aborted_unverified_production_change_<iso>.md` — the production change must be tested in production, not the mock. Anything outside (a)-(d) → abort with documented reason. | Per-class fixture test PLUS LOA-618 fixture (production covered by spec.ts → align allowed) PLUS anti-fixture (no covering test → abort) |
| P1.5 | New bin `extension/src/bin/spawn-gate-remediator.ts` is **brief-prep helper only** (per `bmad-inspired-hardening.md` codebase C3 P0 #2): writes `${SESSION_ROOT}/gate/remediation_<iso>_brief.md` and exits. The skill orchestrator (`finalize-gate.ts` for post-runner; `microverse-runner.ts` for per-iteration anatomy-park) drives the actual `Agent`/`buildWorkerInvocation` spawn. | Test asserts bin never spawns subprocess |
| P1.6 | Worker timeout: `GATE_REMEDIATOR_TIMEOUT_S = 600` (10 min). Mechanical fixes shouldn't take longer; longer means it's drifting into semantic territory. Override via `pickle_settings.json:convergence_gate.remediator_timeout_s`. | Hang-guard test |
| P1.7 | Activity event `gate_remediation_complete` carries `gate_payload`: `failures_in: number`, `failures_out: number`, `auto_fixes_applied: number`, `hand_fixes_applied: number`, `aborted: boolean`, `abort_reason?: string`, `production_coverage_test_path?: string`, `elapsed_ms: number`. | Test |
| P1.7a | *(NEW — refined: codebase, cycle 3)* Remediator-to-runner signaling: `morty-gate-remediator` does NOT write to `microverse.json` directly (single-writer constraint at `microverse-state.ts:195` `forceWrite`). Instead, the remediator writes its outcome to `${SESSION_ROOT}/gate/remediation_<iso>_result.json` and separately emits `gate_remediation_complete` via `log-activity.js`. The microverse-runner determines success by scanning the fresh `remediation_<iso>_result.json` files written during that remediation attempt and increments `currentMv.iteration_regressions` only when the latest result reports `aborted === true` or `failures_out > 0`. Single-writer-of-microverse.json constraint preserved. | Concurrent-write fixture: assert remediator writes only to `gate/` subdir, runner exclusively owns `microverse.json` |
| P1.8 | *(NEW — refined: risk-scope, cycle 3)* Concurrent-remediator lockfile: `${SESSION_ROOT}/gate/remediator.lockfile` written at remediator-spawn time; second concurrent remediation attempt in same SESSION_ROOT refuses with `${SESSION_ROOT}/gate/remediator_concurrent_lockout_<iso>.md` and exits cleanly. | `tests/integration/concurrent-gate-remediation.test.js` |

### P2 — `/szechuan-sauce` Integration

| ID | Requirement | Verification |
|:---|:---|:---|
| P2.1 | *(REWRITTEN — refined: requirements + codebase, cycle 3)* `szechuan-sauce.md` Override 3 (WORKER MODE convergence path, around line 276) is updated: after the worker's `print "The sauce is obtained."` (which signals worker convergence), the actual post-runner gate runs in `finalize-gate.ts` (see Codebase Context below). The skill prompt's tmux send-keys chain at line 205 is rewritten to invoke `microverse-runner.js && finalize-gate.js ${SESSION_ROOT} szechuan` before the echo. The principle filter at `szechuan-sauce.md:274` ("CI-surfaceable linter/typechecker/compiler noise") is **left intact** — that filter is for the *principle scan*, not the *gate*. A new comment block immediately above line 274 makes the layering explicit. | Greppable: `convergence-gate` does NOT appear in `szechuan-sauce.md` between the INVOCATION MODE section heading and Override 3; `finalize-gate` appears at line 205 (tmux send-keys); comment block immediately precedes line 274 |
| P2.2 | Strict-mode failure: `finalize-gate.ts` spawns `morty-gate-remediator` with the failure list scoped to the failing files. After remediator returns, finalize-gate re-runs the gate. Loop cap: 3 remediation cycles (`pickle_settings.json:convergence_gate.szechuan_max_remediation_cycles`). After cap, finalize-gate writes `${SESSION_ROOT}/gate/escalation_<iso>.md` and exits with non-zero (the tmux chain prints the cap-exhausted message). | Integration test: 3-cycle escalation |
| P2.3 | *(REWRITTEN — refined: codebase, cycle 3)* Convergence message updated at `szechuan-sauce.md:205` (the tmux send-keys echo, the only user-visible runtime emit): `Old: "The sauce... is obtained."` → `New (gate green): "The sauce... is obtained. Gate green."` → `New (gate cap-exhausted): "Sauce obtained but gate exhausted remediation cycles — see ${SESSION_ROOT}/gate/escalation_*.md"`. `szechuan-sauce.md:276` (worker-internal print) stays `"The sauce is obtained."`. **Note**: szechuan does NOT include regression counts in the message — its loop never increments `iteration_regressions` (per-iteration gate is anatomy-park-only per P3.2). | Snapshot test against the literal echo string in `szechuan-sauce.md:205`; separate snapshot for worker-internal print at `:276` (asserts unchanged) |
| P2.4 | False-positive filter unchanged: szechuan's principle scan still drops "CI-surfaceable linter/typechecker/compiler noise" (`szechuan-sauce.md:274`) — that filter is for the *principle scan*, not the *gate*. The gate is the orthogonal mechanical check that runs *after* principles converge in `finalize-gate.ts`. Comment block in `szechuan-sauce.md` immediately above line 274 makes the layering explicit. | Greppable assertion in skill prompt |

### P3 — `/anatomy-park` Integration

| ID | Requirement | Verification |
|:---|:---|:---|
| P3.1 | *(REWRITTEN — refined: codebase, cycle 3)* `anatomy-park.md` SETUP MODE: insert new **Step 6.6** between Step 6.5 (resolve scope) and Step 7 (create microverse.json) that runs `node bin/check-gate.js --mode baseline --scope full --checks typecheck,lint --baseline-path "${SESSION_ROOT}/gate/baseline.json" --working-dir "${TARGET_ABSOLUTE_PATH}" --allowed-paths-file "${SESSION_ROOT}/scope.json"` (the last flag conditional on SCOPE_FLAG being set). Tests are NOT baselined — `anatomy-park.md` Step 5 (line 62-64) already enforces green tests at session start, so any test failure at iteration N is by definition NEW. Activity event: `gate_baseline_captured` with `failure_count`, `elapsed_ms`, `allowed_paths_used: bool`. | Integration test: 3 fixtures — clean repo (zero failures captured), pre-existing lint errors (captured), `--scope packages/api` (allowed_paths threaded, only those files baselined) |
| P3.2 | *(REWRITTEN — refined: codebase + risk-scope, cycle 3)* `microverse-runner.ts:843-857` worker-mode branch is extended. Gate fires when ALL of: (a) `currentMv.convergence_mode === 'worker'`; (b) `(currentMv.convergence_file ?? '')` is in `pickle_settings.json:convergence_gate.enabled_convergence_files` (default `["anatomy-park.json"]` — opt-in allowlist); (c) `preIterSha !== getHeadSha(workingDir)` (non-zero commits) **OR** auto-commit rescue has been extended into the worker branch (D2 dependency satisfied); (d) `git status --porcelain` is empty (P0.6b enforced). When all hold, invoke inline: `await runGate({ workingDir, mode: 'baseline', scope: 'changed', since: preIterSha, baselinePath: '${sessionDir}/gate/baseline.json', allowedPaths: currentMv.allowed_paths, checks: ['typecheck', 'lint'] })`. If new failures > 0: spawn `morty-gate-remediator` (single attempt per iteration); on remediator non-success, increment `currentMv.iteration_regressions` via `writeMicroverseState`; emit `iteration_left_regression` activity event. Hook lives BEFORE `await sleep(1000); continue;` so gate latency is part of the iteration cycle, not stacked. | 6 fixtures: (i) clean read-only iteration (preIterSha === HEAD) → gate skipped, `gate_skipped:no_commits` emitted, counter unchanged; (ii) Phase-3-reverted iteration → same; (iii) anatomy-park iteration with new lint error → gate red, remediator spawned, on success counter unchanged; (iv) iteration with new lint error, remediator can't fix → counter incremented, `iteration_left_regression` emitted; (v) /pickle-microverse iteration (allowlist miss) → gate not invoked, zero `gate_*` events; (vi) dirty worktree without rescue (D2 unmet) → `gate_skipped:dirty_worktree_no_rescue` |
| P3.2.5 | *(NEW — refined: codebase, cycle 3)* When `preIterSha === HEAD` after worker exit (Phase-3 revert per `anatomy-park.md:300` OR clean read-only iteration), gate emits `gate_skipped` with `reason: 'no_commits'` — this is correct emergent behavior (revert = no regression introduced = nothing to gate), NOT a missed regression. The `iteration_regressions` counter does not increment. | Test: simulated Phase-3-reverted iteration |
| P3.3 | Per-iteration regression: if new failures exist, spawn `morty-gate-remediator` scoped to the iteration's diff. Single attempt per iteration (no inner loop). If remediator can't clean it, the iteration commit is **soft-flagged** (event `iteration_left_regression`) but the loop continues — anatomy-park's job is to find bugs, not fight prettier. Counter `MicroverseSessionState.iteration_regressions` increments via `writeMicroverseState` (P1.7a signaling path). | Test: simulated dirty iteration → flagged + counter bumps |
| P3.3a | *(NEW — refined: requirements + codebase, cycle 3)* `iteration_regressions` lifecycle: storage `MicroverseSessionState.iteration_regressions: number` in `extension/src/types/index.ts`; init 0 at `microverse-state.ts:30-58` `createMicroverseState()` for every new state (back-compat default `?? 0` at read site); read-back default `parsed.iteration_regressions ??= 0` at `microverse-state.ts:205`; sole writer is the runner (per P1.7a); reset ONLY on fresh `/anatomy-park` invocation (`session_start_epoch` change), preserved across subsystem rotation (cumulative across the whole anatomy-park session). | 4-fixture test: (1) regression in subsystem 1 → counter=1; (2) rotation to subsystem 2 → counter still 1; (3) regression in subsystem 2 → counter=2; (4) /eat-pickle + fresh /anatomy-park → counter=0 |
| P3.3b | *(NEW — refined: requirements, cycle 3)* `iteration_regressions` only counts regressions for checks that were actually run in the per-iteration gate. In the shipped runner hook that means `typecheck` and `lint` only, because tests are reserved for the final strict gate. Docstring intent: "monotonic count of per-iteration gate failures introduced by an iteration and left behind after remediation." | Tested by the per-iteration gate fixtures that exercise success, remediated red, and unremediated red paths |
| P3.4 | *(REWRITTEN — refined: codebase, cycle 3)* Convergence pre-check runs in NEW `extension/src/bin/finalize-gate.ts` (post-runner orchestrator). Skill selection is the positional CLI argument (`szechuan` or `anatomy-park`); `microverse.json` is read for `allowed_paths`, not for determining which skill is running. For `anatomy-park`, the bin runs `convergence-gate` in **strict mode**, `scope: 'full'`, `checks: ['typecheck', 'lint', 'tests']`, `allowedPaths: microverse.json.allowed_paths` if present. If red and failures are within `allowed_paths`, it spawns `morty-gate-remediator` (cycles capped at 5). Failures outside `allowed_paths` are written to `${SESSION_ROOT}/gate/out_of_scope_failures_<iso>.md` and trigger event `gate_out_of_scope_failures_present` but do NOT trigger remediator (R17). Cap configurable: `pickle_settings.json:convergence_gate.anatomy_park_max_remediation_cycles`. | Integration test: simulate 80-iteration drift → final gate green after remediation; AND 3-package fixture with `--scope packages/api` and intentional drift in `packages/web-app/` — remediator never invoked, out-of-scope report present |
| P3.4a | *(NEW — refined: codebase, cycle 3)* Final-gate test handling is simpler than baseline mode: anatomy-park.md Step 5 enforces green tests at session start, so the final strict gate has no special test-baseline capture path. `gate_preexisting_tests_baselined` is emitted when baseline mode creates `gate/baseline.json`, carrying `failure_count`, not as a `count: 0` final-gate trace event. | Test asserts baseline capture emits the event only on baseline creation |
| P3.4b | *(NEW — refined: requirements, cycle 3)* LOA-618 fixture replay: committed at `extension/tests/fixtures/loa-618-replay/` as a self-contained tarball `loa-618-replay.tar.gz` containing a minimal Node project with the 5 files exhibiting the 1 typecheck + 66 lint + spec-mock-cast pattern. Replay test (`tests/integration/loa-618-replay.test.js`) extracts the tarball to a tmp dir, runs `runGate({mode: 'strict', scope: 'full', checks: ['typecheck','lint','tests']})`, asserts `failures.length === 67 + spec_count`, runs the remediator brief-prep, asserts the brief enumerates the same 67 failures. | Integration test |
| P3.5 | *(REWRITTEN — refined: codebase, cycle 3)* Convergence message updated at `anatomy-park.md:166` (the tmux send-keys echo, the runtime exit string). `anatomy-park.md:386` (persona prose) stays unchanged. `Old: "Anatomy Park is closed. All organs accounted for."` → `New (gate green, no regressions): "Anatomy Park is closed. All organs accounted for. Gate green. No regressions during loop."` → `New (gate green, regressions cleared): "Anatomy Park is closed. All organs accounted for. Gate green. {iteration_regressions} regression flags during loop, all cleared by final gate."` → `New (gate cap-exhausted): "Park closed but gate exhausted remediation cycles — see ${SESSION_ROOT}/gate/escalation_*.md"` → `New (PICKLE_GATE_DISABLED=1): "Anatomy Park is closed. All organs accounted for. Gate skipped (PICKLE_GATE_DISABLED=1)."` `R = currentMv.iteration_regressions`, read by `read-microverse.js` in the tmux chain rather than by `finalize-gate.ts`. | 4 snapshot tests (one per branch) against the literal echo string in `anatomy-park.md:184-190` |
| P3.6 | If `MicroverseSessionState.iteration_regressions > 5` at any point during the loop, runner prints a one-time warning: `[anatomy-park] 5+ iterations have left toolchain regressions; final gate may need significant remediation. Consider stopping and running /szechuan-sauce first.` Activity event `gate_regression_threshold_warning`. One-time-per-session via `MicroverseSessionState.gate_regression_threshold_warning_emitted: boolean` (NEW, init false, flips true on first emit). Reset on fresh session start. | Test |

### P4 — Configuration Reference

| Config surface | Key | Type | Default | Used by |
|:---|:---|:---|:---|:---|
| Setting | `convergence_gate.enabled_convergence_files` | `string[]` | `["anatomy-park.json"]` | P3.2 R11 allowlist |
| Setting | `convergence_gate.remediator_timeout_s` | int | 600 | P1.6 |
| Setting | `convergence_gate.szechuan_max_remediation_cycles` | int | 3 | P2.2 |
| Setting | `convergence_gate.anatomy_park_max_remediation_cycles` | int | 5 | P3.4 |
| Setting | `convergence_gate.regression_warning_threshold` | int | 5 | P3.6 (renamed for clarity from cap=5 collision) |
| Env | `PICKLE_GATE_DISABLED` | `0\|1` | `0` | Kill-switch (logged) |
| Bin flag | `--mode baseline\|strict` | enum | `strict` | P0.7 |
| Bin flag | `--scope full\|changed` | enum | `full` | P0.7 |
| Bin flag | `--since <ref>` | string | `HEAD~1` | P0.7 |
| Bin flag | `--checks typecheck,lint,tests` | csv | `typecheck,lint,tests` | P0.7 |
| Bin flag | `--allowed-paths-file <path>` | string | (none) | P0.7 reads `scope.json:allowed_paths` |

The repo also carries matching default keys in `pickle_settings.json` for `commands`, `timeout_ms.*`, `gate_total_timeout_ms`, `baseline_max_age_*`, `prefer_test_unit_alias`, and `known_flake_files`, but the shipped runtime does not currently consume those settings end-to-end. Command resolution instead comes from `extension/data/gate-commands.json`, while timeout / freshness / flake knobs are only reachable through lower-level service seams or helper exports.

---

## Codebase Context

### Files this PRD touches

*(refined: codebase, cycle 3 — added finalize-gate.ts, dropped install.sh row, fixed types/index.ts entry)*

| Path | Why |
|:---|:---|
| `extension/src/services/convergence-gate.ts` | NEW — gate runner |
| `extension/src/bin/check-gate.ts` | NEW — ad-hoc + skill dispatch |
| `extension/src/bin/finalize-gate.ts` | NEW — post-runner orchestrator (the gate↔remediator multi-cycle loop) invoked from szechuan-sauce.md:205 and anatomy-park.md:166 tmux send-keys |
| `extension/src/bin/spawn-gate-remediator.ts` | NEW — brief-prep helper |
| `extension/data/gate-commands.json` | NEW — canonical project-type → command map (pnpm/npm/yarn/cargo/go) |
| `.claude/agents/morty-gate-remediator.md` | NEW — mechanical-only worker |
| `.claude/commands/szechuan-sauce.md` | UPDATE line 205 (tmux send-keys chain to invoke finalize-gate.js); add comment block above line 274 clarifying principle filter vs gate layering |
| `.claude/commands/anatomy-park.md` | UPDATE: insert Step 6.6 (baseline capture) between Step 6.5 and Step 7 (Setup Mode); UPDATE line 166 (tmux send-keys chain to invoke finalize-gate.js) |
| `extension/src/bin/microverse-runner.ts` | UPDATE — add per-iteration gate hook in worker-mode branch (lines 843-857), BEFORE the sleep(1000); determine remediation outcomes from fresh `gate/remediation_<iso>_result.json` files; increment `currentMv.iteration_regressions` |
| `extension/src/services/state-manager.ts` | UPDATE — adds workingDir-scoped `withLock` helper for P0.4b (extends existing `microverse-runner.ts:758` precedent) |
| `extension/src/services/microverse-state.ts` | UPDATE — extend `createMicroverseState()` literal at lines 30-58 with `iteration_regressions: 0` and `gate_regression_threshold_warning_emitted: false`; extend `readMicroverseState` at line 205 with `parsed.iteration_regressions ??= 0` defensive default |
| `extension/src/services/activity-logger.ts` | UPDATE — log-activity now includes `gate_payload?: Record<string, unknown>` field plumbing |
| `extension/src/types/index.ts` | UPDATE — extend `VALID_ACTIVITY_EVENTS as const` (line 199) with all 15 new events; add `GateResult`, `GateFailure`, `GateMode`, `GateBaselineFile`; extend `ActivityEvent` interface (line 246-265) with `gate_payload?: Record<string, unknown>`; extend `MicroverseSessionState` with `iteration_regressions?: number` and `gate_regression_threshold_warning_emitted?: boolean` (both optional for back-compat) |
| `pickle_settings.json` | UPDATE — `convergence_gate` block defaults |
| `install.sh` | NO CHANGE *(refined: codebase, cycle 3)* — `extension/data/gate-commands.json` auto-rsynced at install.sh:56 (no `--exclude='data'`); `.claude/agents/morty-gate-remediator.md` auto-installed at install.sh:125 |
| `tests/services/convergence-gate.test.js` | NEW |
| `tests/services/convergence-gate-resolution.test.js` | NEW |
| `tests/services/convergence-gate-workspaces.test.js` | NEW |
| `tests/services/convergence-gate-baseline.test.js` | NEW |
| `tests/services/convergence-gate-baseline-schema.test.js` | NEW |
| `tests/services/convergence-gate-baseline-schema-parity.test.js` | NEW |
| `tests/services/convergence-gate-baseline-freshness.test.js` | NEW |
| `tests/services/convergence-gate-hang-guard.test.js` | NEW |
| `tests/services/convergence-gate-test-safety.test.js` | NEW |
| `tests/services/convergence-gate-lock.test.js` | NEW |
| `tests/services/convergence-gate-autofix-revert.test.js` | NEW |
| `tests/services/convergence-gate-flake-allowlist.test.js` | NEW |
| `tests/bin/check-gate.test.js` | NEW |
| `tests/bin/finalize-gate.test.js` | NEW |
| `tests/morty-gate-remediator-prompt.test.js` | NEW snapshot |
| `tests/agent-md-frontmatter-required-keys.test.js` | NEW (vendored, deleted by bmad PR per D1) |
| `tests/integration/szechuan-strict-gate.test.js` | NEW — full skill loop with red gate → remediator → green |
| `tests/integration/anatomy-park-baseline-gate.test.js` | NEW — baseline + per-iteration + final gate |
| `tests/integration/anatomy-park-scoped-final-gate.test.js` | NEW — `--scope packages/api`, drift in `packages/web-app/`, remediator never invoked (R17) |
| `tests/integration/anatomy-park-dirty-tree-skip.test.js` | NEW — P0.6b dirty-worktree skip (D2 unmet) |
| `tests/integration/anatomy-park-branch-switched.test.js` | NEW — P0.6c R16 branch-switch detection |
| `tests/integration/concurrent-gate-remediation.test.js` | NEW — P1.8 lockfile |
| `tests/integration/gate-cycle-escalation.test.js` | NEW — cycle cap halts |
| `tests/integration/loa-618-replay.test.js` | NEW — P3.4b fixture replay |

### Patterns to follow

- **Brief-prep bins, orchestrator-driven spawns**: per `bmad-inspired-hardening.md` codebase C3 P0 #2. `check-gate.ts` and `spawn-gate-remediator.ts` write briefs; the orchestrators (`finalize-gate.ts` for post-runner; `microverse-runner.ts` for per-iteration anatomy-park) drive `Agent` / `buildWorkerInvocation`.
- **Hang guards**: every external spawn carries explicit timeout per `extension/CLAUDE.md` trap-door enumeration. Workspace cumulative cap (P0.5).
- **Activity logging**: 15 events listed in P0.8 added to `VALID_ACTIVITY_EVENTS as const` at `extension/src/types/index.ts:203`. Open-ended `gate_payload` field on `ActivityEvent`.
- **Backend-agnostic**: gate is pure I/O + child_process, no LLM — runs identically on codex and claude backends. Codex commit cadence handled by `since: preIterSha` (NOT `HEAD~1`).
- **Worker spawn**: `morty-gate-remediator` uses `buildWorkerInvocation()` (NOT `buildJudgeInvocation()` — remediator writes files).
- **Single-writer of microverse.json**: only the runner writes; remediator signals via `remediation_<iso>_result.json` plus activity events (P1.7a), not by mutating `microverse.json`.
- **Test safety**: P0.6 hard refusal + P0.6a positive-allow-list — unit-test alias only.
- **Gate artifact namespace**: all gate artifacts live under `${SESSION_ROOT}/gate/` subdir with ISO-8601 timestamps to avoid collision with worker artifacts.

---

## Risk Register

| ID | Risk | Severity | Mitigation | Verification |
|:---|:---|:---|:---|:---|
| R1 | Gate baseline drift mid-loop (file deleted/renamed) | High | Fingerprint `(file, ruleOrCode, occurrence_index)`; if file no longer exists, baseline entry satisfied | `tests/services/convergence-gate-baseline.test.js` covers rename/delete |
| R2 | Remediator cycles infinitely on a fix that re-introduces the lint error | High | Hard cap (3 / 5) with escalation file; activity event on cap | Test |
| R3 | Project type misdetection (e.g. nested workspace) | Med | `gate-commands.json` is the shipped command registry; classifier emits confidence; low-confidence → `gate_skipped:project_type_low_confidence`, gate green until the registry gains a matching entry | Test |
| R4 | Gate adds 30-300s per iteration on anatomy-park | Med | Per-iteration `scope: 'changed'` only; skip tests per-iteration; cap typecheck at 120s; A6 explicit timing budget (≤30s/iteration on 25-file diff) | Wall-clock test on LOA-618 fixture |
| R5 | `pnpm test` accidentally invokes integration suite | Critical | P0.6 hard refusal + P0.6a positive-allow + content-scan; integration test exercises safety net | Test |
| R6 | Workspace setup with non-pnpm sub-package (e.g. lambda dir using npm) | Med | Per-workspace project-type re-resolution; `gate-commands.json` keys per workspace | Workspace fixture |
| R7 | Codex worker introduces drift faster than remediator can clear | Low | Warning at 5 regressions (`regression_warning_threshold`); user can stop loop and run /szechuan-sauce | Test |
| R8 | Skill loop becomes too slow to iterate on (cycle cap × remediator timeout = 30+ min) | Med | Defaults sized for typical drift; `PICKLE_GATE_DISABLED=1` kill-switch logs an event but unblocks emergency runs | Test |
| R9 | Pre-existing CLAUDE.md trap-door errors get auto-fixed and re-introduced on next iteration | High | Remediator hand-fix list (P1.4) explicitly references the file's CLAUDE.md trap-door section; if a fix matches a trap door, it persists across iterations because the remediator's output is committed | Trap-door regression test |
| R10 | `--json` output of `check-gate.ts` not stable across versions | Low | `GateResult` schema versioned in types; snapshot test | Snapshot test |
| R11 | `microverse-runner.ts` is shared between `/anatomy-park` and `/pickle-microverse`; per-iteration gate must not silently turn on for microverse runs | High | *(refined: risk-scope, cycle 3)* `enabled_convergence_files` allowlist (default `["anatomy-park.json"]`) is the discriminator. Future skills opt in by adding their `convergence_file` name through settings. | Test: `/pickle-microverse` fixture asserts no `gate_run_complete` event emitted per iteration |
| ~~R12~~ | ~~Codex backend bypasses the unit-test-only safety net~~ | ~~Critical~~ | *(RETRACTED — refined: risk-scope, cycle 3)* The safety net is in pure I/O (regex match on script content); backend distinction does not apply. R5's verification covers this. | n/a |
| R13 | Autofix corrupts files (eslint/prettier introduce wrong code) | High | *(NEW — refined: risk-scope, cycle 3)* Snapshot-and-revert protocol per P1.3a (memory + sha256 ≤ 1MB; `git stash` fallback for >1MB); re-run scoped previously-green tests; revert if any go red | `tests/services/convergence-gate-autofix-revert.test.js` |
| R14 | Concurrent gate runs in same workingDir | Med | *(NEW — refined: risk-scope, cycle 3)* P0.4b workingDir-scoped advisory lock; P1.8 remediator lockfile in SESSION_ROOT; sessions are SESSION_ROOT-scoped so concurrent skills in different sessions are isolated | `tests/services/convergence-gate-lock.test.js`, `tests/integration/concurrent-gate-remediation.test.js` |
| R15 | Flaky tests cause gate flapping | Med | *(REVISED — refined: risk-scope, cycle 3)* No automatic retry. The shipped suppression seam is `runGate(opts.settings.convergence_gate.known_flake_files)`; higher-level runners do not yet source that list from `pickle_settings.json`. Failures in flagged files are written to `${SESSION_ROOT}/gate/known_flake_failures_<iso>.md` for visibility but DO NOT trigger gate-red. If gate is red ONLY due to flake-listed failures, status is `green-with-known-flake-warnings`. | `tests/services/convergence-gate-flake-allowlist.test.js` |
| R16 | Mid-loop user edits / branch checkouts in workingDir | Med | *(REFRAMED — refined: risk-scope, cycle 3)* P0.6c branch-switch detection: capture HEAD/branch/porcelain at gate entry; halt with `gate/workingdir_drift_<iso>.md` on divergence; do not auto-resolve | `tests/integration/anatomy-park-branch-switched.test.js` |
| R17 | Final strict gate violates user's `--scope` contract by triggering remediator on out-of-scope files | High | *(NEW — refined: risk-scope, cycle 3)* When `scope.json` exists with `allowed_paths`, final strict gate inherits them; failures detected outside allowed paths are written to `${SESSION_ROOT}/gate/out_of_scope_failures_<iso>.md` for human review; remediator NOT invoked on out-of-scope failures; convergence message format adjusted | `tests/integration/anatomy-park-scoped-final-gate.test.js` |
| R18 | LOA-618-class trap door: worker-mode auto-commit-rescue gap leaves uncommitted regressions invisible to gate | Critical | *(NEW — refined: risk-scope, cycle 3)* Two-branch P3.2 implementation: when D2 (`large-tier-stall-recovery.md`) has landed, gate uses rescue; when not, gate emits `gate_skipped:dirty_worktree_no_rescue` and skips this iteration cleanly | `tests/integration/anatomy-park-dirty-tree-skip.test.js` |
| R19 | Resume into changed `PICKLE_GATE_DISABLED` state can weaken the baseline guarantee if the baseline ages out between runs | High | *(NEW — refined: risk-scope, cycle 3)* Freshness enforcement exists today only via `assertBaselineFresh(...)`; missing/stale baseline handling is covered there, but wiring that helper into the main gate path remains necessary for full runtime enforcement | `tests/services/convergence-gate-baseline-freshness.test.js` |
| R20 | Bootstrap recursion: gate runs against the gate's own PRD branch, finds lint issues in gate source | Low | Bounded — remediator can mechanically autofix lint in `convergence-gate.ts` (no implicit dependency on gate being healthy) | P2 verification: bootstrap fixture exercises gate-the-gate path |

---

## Hidden Assumptions

- A1: Project's `pnpm test` (or equivalent) is the unit-test alias and is fast enough (~30-90s) to run as the final gate. If a project's `test` alias is slow, the skill should hint user to add a separate `test:unit` script.
- A2: Most failures Codex / Morty workers introduce are mechanically auto-fixable (prettier, eslint-autofix-eligible). The 6 substantive failures in LOA-618 are the rare hand-fix tail. If hand-fix tail grows past ~30% of failures in real runs, this PRD's design is wrong and the remediator scope needs widening. Telemetry: `/pickle-metrics` surfaces `convergence_gate.autofix_revert_ratio` rolling stat with 0.10 alert threshold.
- A3: ~~Pre-existing baseline error in iteration-touched file is rare enough that rebuild-from-blame (P3.5) is acceptable per-iteration latency.~~ *(REPLACED — refined: requirements + risk-scope, cycle 3)* `(file, ruleOrCode, occurrence_index)` fingerprint handles same-rule-multiple-instances correctly without rebuild-from-blame. Drop A3.
- A4: anatomy-park's "soft-flag and continue" policy (P3.3) is correct because the final gate (P3.4) catches everything; iterations leaving regressions are debt, not bugs.
- A5: The principle filter in szechuan (P2.4) is intentional and stays — the gate is layered on top, not a replacement.
- A6: *(NEW — refined: risk-scope, cycle 3)* Per-iteration gate adds ≤ 30s wall-clock per iteration on a typical 25-file diff, validated against the LOA-618 fixture (P3.4b) as part of P3.4's verification step.
- A7: *(NEW — refined: codebase, cycle 3)* `microverse-state.ts:189-196` `writeMicroverseState`'s `forceWrite` (no lock) is safe IFF only one process writes microverse.json. The runner is the single writer; the remediator signals via `gate/remediation_<iso>_result.json` plus activity events (P1.7a) instead.

---

## Source Material

- LOA-618 validation transcript: 5-agent run on `gregory/loa-618-updated-appraisal-comparison-epic` (1 typecheck + 66 lint errors found post-convergence; codex atomicity audit clean; spec conformance clean). Transcript artifacts not yet captured to repo — P3.4b creates the canonical fixture.
- `packages/api/CLAUDE.md` "Trap Doors (repo-wide)" — origin of the 6 substantive lint errors (control-regex, async-generator require-await, no-unnecessary-type-assertion).
- `prds/bmad-inspired-hardening.md` (D1) — patterns for brief-prep bins, hang guards, agent-md schema, activity events.
- `prds/archive/bundles/large-tier-stall-recovery.md` (D2) — auto-commit rescue extension into worker-mode branch.
- `extension/src/bin/microverse-runner.ts` — anatomy-park's iteration loop and convergence detection. Per-iteration gate hook lives at lines 843-857 (worker-mode branch); auto-commit rescue at lines 862-883 (currently non-worker only).
- `.claude/commands/szechuan-sauce.md:139` (init-microverse line) and `:205` (tmux send-keys exit echo) and `:274` (principle filter) and `:276` (worker-internal print).
- `.claude/commands/anatomy-park.md:62-64` (Step 5 green-tests-at-start), `:73-84` (Step 6.5 resolve scope), `:113` (worker mode flag), `:166` (tmux send-keys exit echo), `:270` (worker Phase 2 step 4 test run), `:300` (Phase 3 hard reset), `:386` (persona prose, NOT runtime).
- `extension/src/services/microverse-state.ts:30-58` (createMicroverseState) and `:195` (forceWrite single-writer).

---

## Implementation Task Breakdown

See `${SESSION_ROOT}/<hash>/linear_ticket_<hash>.md` files for atomic task definitions. The breakdown table is appended below by the refinement skill.

| Order | ID | Title | Priority | Entry | Exit |
|:---|:---|:---|:---|:---|:---|
| 10 | bdc8c707 | Add gate types + 14 activity events to types/index.ts | High | none | Types exported; events in `VALID_ACTIVITY_EVENTS` |
| 20 | 76c360cd | Create extension/data/gate-commands.json | High | none | 5 project types committed |
| 30 | 6d6d63a3 | Add `withLock` helper to state-manager.ts | High | bdc8c707 | Helper exported, tests pass |
| 40 | 05385c71 | Plumb gate_payload field through activity-logger | High | bdc8c707 | logActivity accepts payload |
| 50 | fd030a4b | Init iteration_regressions on MicroverseSessionState | High | bdc8c707 | Fields init/default correctly |
| 60 | 2cba32e5 | Vendor agent-md-frontmatter-required-keys.test.js | Medium | none | Provisional test passes |
| 70 | c076cd94 | Build convergence-gate.ts core | High | bdc8c707, 76c360cd | runGate returns GateResult; resolution + workspaces work |
| 80 | ccd4bd10 | convergence-gate baseline mode + schema + freshness | High | c076cd94 | Baseline write/subtract/freshness |
| 90 | 7193d5bb | convergence-gate hang guards + lock | High | c076cd94, ccd4bd10, 6d6d63a3 | Per-check + cumulative timeouts; lock-scoped baseline |
| 100 | 3f6f3075 | convergence-gate test safety + dirty/branch | High | c076cd94 | Test-script safety; dirty-tree skip; branch-switch detection |
| 110 | 6f3a89f6 | convergence-gate activity events + flake allowlist | High | All gate tickets, 05385c71 | 15 events wired; flake suppression |
| 120 | e2dcc2c5 | check-gate.ts CLI bin | High | All gate tickets | CLI callable; exit codes correct |
| 130 | 9e26abc3 | Create morty-gate-remediator.md agent-md | High | none (validated by 2cba32e5) | Agent-md deployed |
| 140 | d765d96c | spawn-gate-remediator.ts brief-prep | High | bdc8c707, 9e26abc3, 6d6d63a3 | Brief-prep helper; lockfile; result protocol |
| 150 | 724ade1e | Add convergence_gate defaults to pickle_settings.json | Medium | none | Block deployed, defaults match P4 |
| 160 | f141e345 | Wire per-iteration gate hook into microverse-runner.ts | High | All foundation tickets | 6 fixtures pass |
| 170 | e3e9409c | Build finalize-gate.ts post-runner orchestrator | High | e2dcc2c5, d765d96c, 9e26abc3, 724ade1e | Cap-cycle remediation; R17 OOS; PICKLE_GATE_DISABLED honored |
| 180 | 33968f75 | Update szechuan-sauce.md tmux chain + comment block | High | e3e9409c | Skill prompt invokes finalize-gate |
| 190 | 3f60e8b3 | Update anatomy-park.md Step 6.6 + tmux chain | High | e2dcc2c5, e3e9409c | Step 6.6 baseline; 4 message variants |
| 200 | 5abf2aea | LOA-618 fixture replay test | Medium | All gate + remediator | Fixture catches 67 failures |
| 210 | e5a0c60d | Wiring: integrate convergence-gate primitives | High | All impl | bash install.sh deploys all paths; LOA-618 e2e pass |
| 220 | 27ace80a | Harden: code quality review | High | e5a0c60d | Zero P0-P1 violations |
| 230 | 1b413356 | Audit: data flow integrity | High | 27ace80a | Zero CRITICAL+HIGH findings |
| 240 | 7a1eb3c9 | Harden: test quality review | High | 27ace80a, 1b413356 | Every AC mapped; zero P0-P1 gaps |
| 250 | dce0988e | Audit: cross-reference consistency | High | 27ace80a, 1b413356, 7a1eb3c9 | Zero CRITICAL+HIGH mismatches |

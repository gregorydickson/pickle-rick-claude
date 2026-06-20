---
title: P1 — per-ticket pickle-phase workers run no test gate; cross-ticket regressions slip past 30+ commits and only surface at closer release gate
status: Draft
filed: 2026-05-10
priority: P1
type: bug-architecture
---

# PRD — Per-ticket worker gate is lint+tsc only; test failures accumulate silently across the bundle

**Author**: Pickle Rick
**Project**: `pickle-rick-claude`
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`, local-only

## Symptom

Bundle 2026-05-10 shipped 30+ tickets across R-SLLJ / R-CCNW / R-MDS / R-CLOSER-1 cleanly — every worker passed its Spec Conformance phase and committed. **Then the closer release gate (R-CLOSER-2, ticket `698924c1`) ran the canonical 12-step gate and discovered 53 unique failing tests in `npm run test:fast`**, clustered into 8 root-cause classes (see `698924c1/conformance_2026-05-10.md` §3):

- **A. Schema/type drift** (2) — hardcoded count assertions (35 events) didn't catch R-SLLJ-6 + R-MDS adding 3 new `judge_*` + 3 new `monitor_*` events (now 38 in schema).
- **B. Orphan-tmp recovery class** (≥10) — `jar-runner`, `setup`, `spawn-refinement-team`, `mux-runner`, `inferMonitorMode`, `showStatus`, `addToJar` all read raw `state.json` and skip the new `readRecoverableJsonObject` tmp-promotion path.
- **C. install.sh test drift** (≥5) — `install.sh:281-285` refactored (commit `efe0e961`) from literal `rm -f …types/index.js` to a `find … -type f` loop; `tests/install-script.test.js:1102-1125` still greps for the literal.
- **D. Citadel pipeline integration** (≥4) — phase-dispatch wiring + analyzer enumeration regressions from R-CCNW-2.
- **E. spawn-morty backend resolution** (3) — env + heuristic precedence.
- **F. Monitor / pipeline phase dispatch** (≥4) — R-MDS-2 (`--mode` flag) and R-MDS-3 (tick-loop hot-swap) precedence races; `restartDeadWatcherPanes` mode-specific pane-2 dispatch.
- **G. Auto-resume / cap / retry** (3).
- **H. Other** (≥10) — `checkForUpdate`, `processRateLimitCycle`, `computeOneHop`, `random-sample cohort recall baseline`, etc.

The closer correctly failed the gate, marked R-CLOSER-3 (`010f5c8b` install + MASTER_PLAN bookkeeping) and the wiring ticket (`4dcf9b43`) as **Skipped**, and did not deploy v1.73.1. **But the 53 failures themselves are accumulated regressions across the bundle.** No single ticket "owns" most of them; they emerged at the closer because 30 individual workers each thought they were fine.

## Root cause (structural)

The per-ticket Morty worker finalization gate in `extension/src/bin/spawn-morty.ts:613-690` (`runLintGate`) runs **only**:

```ts
// spawn-morty.ts:636
const lintResult = spawn('npx', ['eslint', ...changedFiles, '--max-warnings=-1'], …);
// spawn-morty.ts:642
const tscResult = spawn('npx', ['tsc', '--noEmit'], …);
```

**It does NOT run `npm run test:fast`** (nor any subset). The gate is named `runLintGate` and returns only `{ ok, lintErrors, tscErrors, … }`. On `ok: true`, the worker commits with status `Done` (line 726) and exits successfully (line 750). The closer release gate is the **first and only** point in the pipeline where the full test:fast tier runs.

The Working Rule documented at `extension/CLAUDE.md:31` reads:

> **INVARIANT**: worker MUST run lint + tsc before completion-commit; one auto-fix retry only.

The rule is **enforced exactly as written** — but the rule itself is too narrow. Tests are nowhere in the worker contract.

**Furthermore**, there is no between-ticket gate. `mux-runner.ts` spawns one Morty per iteration over the queue; grep finds zero `test:fast` / `npm test` / `node --test` invocations in `mux-runner.ts`. `convergence-gate` is only invoked during microverse phases (anatomy-park / szechuan-sauce), not during pickle. So:

| Gate | Scope | Runs | Catches |
|------|-------|------|---------|
| **Per-ticket lint gate** (`spawn-morty.ts:613-690`) | Worker-changed files only | `eslint` + `tsc --noEmit` | Typing/linting in isolation |
| **Between-ticket convergence** | — | (none) | (nothing) |
| **Closer release gate** (`CLAUDE.md` `## Versioning`) | Full codebase | `tsc` + `eslint` + 6 audits + `test:fast` + `test:integration` + `test:expensive` | Cross-ticket test failures |

Result: any cross-ticket coupling that's not a type error (TS catches those), not a lint pattern (ESLint catches those), and not file-local (per-ticket tests would catch those if they were run) **MUST** wait for the closer to surface. By that point, the operator has 30+ commits in a bundle and no way to attribute which one introduced which failure without doing exactly the per-failure-class triage that bundle 2026-05-10's `conformance_2026-05-10.md` §3 produced manually.

## Dominant failure scenarios across the 53 failures

Per-failure forensic audit on 6 representative failing tests across classes A/B/C/D/F yielded four scenarios; ranked by frequency:

1. **(iv) Tests passed at ticket-time, broke downstream** — Class A is the textbook case. R-MDS-3 (`cc9caade`) registered `monitor_mode_swapped` event when total was 35; later R-MDS tickets added `producer_done`, `monitor_respawn_started`, `monitor_respawn_failed`. Each individual ticket's per-file scope ran clean. The hardcoded `assert.equal(events.length, 35)` at `tests/activity-event-payload.test.js:391` never failed in any individual worker session because workers don't run it.
2. **(ii) Workers ran narrower test scopes** — ticket `96402c0a` (R-SLLJ-6) ran `npm run test:fast -- --grep activity-event-payload`, but only against the scoped pattern, not the full suite. Result was green-for-scope, red-for-suite.
3. **(iii) Feature added without bootstrap-path tests** — Class B `jar-runner: recovers a newer orphan tmp state before bootstrapping a jarred task` failed because the orphan-tmp recovery promotion was feature-added in one ticket but `jar-runner`'s bootstrap call site was never updated to use `readRecoverableJsonObject`; no per-ticket worker ever ran the suite that exercises that bootstrap path.
4. **(v) Test hardenings landed after the feature** — Class C `AC-ITS-01` was hardened by `8c77afd7` after the `efe0e961` refactor; per-ticket gate wouldn't have surfaced this because the hardening lived in a sibling-bundle artifact.

**(i) "Worker ran test:fast, tests failed, worker proceeded anyway" is NOT observed.** Workers do not run test:fast at all — there's nothing for them to override.

## Severity

P1 — every multi-ticket bundle hits this. The 2026-05-10 bundle lost ~6 hours of operator time tonight on:
- 3 pipeline manual recoveries (R-MMTR + the unattributed SIGINT)
- 53-failure remediation (still pending; can't ship v1.73.1)
- 30-commit attribution forensics

The cost is super-linear in bundle size: at N tickets, **closer-gate triage scales like `N × failure-classes`** because each class can touch multiple tickets and each ticket can contribute to multiple classes. Today's 30-commit bundle yielded 53 failures × 8 classes; a 60-commit bundle would plausibly yield 100+. The "one-shot remediation bundle" model from `conformance_2026-05-10.md`'s recommendation is the only known path, but it pushes the v1.73.x release out by another bundle cycle.

Climbs to P0 (pipeline-killer) the moment a bundle ships a test-failing change that isn't merely a hardening drift (e.g., a real production-path regression that the closer's `test:fast` cannot distinguish from the noise of 53 simultaneous failures).

## Fix Requirements

### Primary fix — add `test:fast` to the per-ticket worker gate

- **R-PTG-1** (R-MUST): Extend `runLintGate` in `extension/src/bin/spawn-morty.ts:613-690` to run `cd extension && npm run test:fast` after `tsc --noEmit` passes. Rename `runLintGate` → `runWorkerGate` to reflect expanded scope. Return shape: `{ ok, lintErrors, tscErrors, testFailures, … }` where `testFailures` is an array of `{ name, file, message }`. On any failure, the worker MUST NOT commit. Test runs only if eslint + tsc are green (no point running tests against type-broken code).

- **R-PTG-2** (R-MUST): Update the trap-door invariant at `extension/CLAUDE.md:31` from "worker MUST run lint + tsc before completion-commit" to "worker MUST run lint + tsc + `npm run test:fast` before completion-commit; one auto-fix retry only for lint and tsc; one targeted-fix retry for test failures (worker reads failing test names, runs them in isolation, fixes, re-runs the full `test:fast`)." INVARIANT updated; BREAKS clause: failure to enforce this gate leads to bundle-scale closer-gate floods (see PRD `prds/archive/bug-reports/p1-per-ticket-worker-no-test-gate-cross-ticket-regressions.md`); ENFORCE: `extension/tests/spawn-morty-worker-gate.test.js` from R-PTG-3.

- **R-PTG-3** (R-MUST): Rename `extension/tests/spawn-morty-lint-gate.test.js` → `extension/tests/spawn-morty-worker-gate.test.js`. Add cases:
  - Gate fails when test:fast exits non-zero
  - Gate retries once on test failure (worker invokes auto-fix path)
  - Gate hard-fails after one retry; worker exits with status `Failed`, does NOT commit
  - Gate is skipped (skip-marker logged) when `process.env.SKIP_WORKER_TEST_GATE === '1'` (escape hatch documented; default off; never set in production paths)
  - Gate timing: `test:fast` budget added to per-ticket worker timeout; verify no truncation

- **R-PTG-4** (R-MUST): Worker subprocess timeout budget bump. Current default in `pickle_settings.json` (per `extension/CLAUDE.md`) does not account for `test:fast` runtime (~30-120s in this repo per `npm run test:fast` of ~720 tests). Add `worker_test_gate_timeout_ms` setting (default 240_000 = 4 min) layered on top of the existing per-ticket budget. Surface to operator via `pickle-status`.

- **R-PTG-5** (R-MUST): When `runWorkerGate` fails after the retry, the worker writes to its `linear_ticket_<id>.md` frontmatter `status: "Failed"`, emits a structured `worker_gate_failed` activity event with `{ ticket_id, gate_phase: 'test:fast' | 'lint' | 'tsc', failures: [...], retry_count }`, and exits non-zero. `mux-runner.ts` MUST surface this in the next-iteration manager prompt so the manager can decide to retry, skip, or escalate. **No silent Done on a failed gate.**

### Secondary fix — defense in depth at the between-ticket boundary

- **R-PTG-6** (R-MUST): Between-ticket fast-gate in `mux-runner.ts`. After each worker completes (regardless of Done/Failed), the manager loop MUST run `cd extension && npm run test:fast` and write the result to `state.json.last_between_ticket_gate`. If a worker landed `Done` but the between-ticket gate is red, log a structured `cross_ticket_regression_detected` activity event with `{ ticket_id, prior_ticket_id, failing_tests: [...] }`. Do NOT block the next ticket — but the failure is now attributed at boundary granularity, so closer-gate triage drops from N-ticket attribution to 1-ticket attribution.

- **R-PTG-7** (R-SHOULD): Cross-ticket regression detection emits a Linear comment on the introducing ticket (per the activity-event source attribution from R-PTG-6) so operator sees the breakage attributed to the right ticket without manual `git bisect`.

### Tertiary fix — performance + ergonomics

- **R-PTG-8** (R-SHOULD): Cache `node_modules` across worker invocations. Current cold-start of `npm run test:fast` includes Node module resolution which can be 5-10s per ticket. Use the existing extension working directory rather than re-cloning per worker — already done; just confirm and pin invariant.

- **R-PTG-9** (R-MAY): Tiered gate option — opt-in `worker_gate_tier` setting: `"narrow"` (per-ticket scope only, current behavior, default OFF), `"fast"` (full `test:fast`, R-PTG-1 default), `"full"` (`test:fast` + `test:integration`, opt-in for high-stakes bundles via `pickle_settings.json`). Pass through to `runWorkerGate`. Useful when bundle author knows the change crosses subsystem boundaries.

### Closer

- **R-PTG-10** (R-MUST): Closer ticket — bump version (minor), run `bash install.sh`, verify md5-parity 5/5, update MASTER_PLAN bookkeeping (close Open Finding #21, mark this PRD Shipped), and verify Open Finding #14/#15/#17 stay open until the remediation bundle ships the 8-class fix.

## Out of scope

- **The 53 failures themselves.** Those are 8 root-cause classes (A–H in `698924c1/conformance_2026-05-10.md` §3) and require a dedicated **remediation bundle** with one ticket per class. That remediation bundle is the NEXT bundle after this PRD ships; it is gated by R-PTG-1's per-ticket test gate being in place, otherwise the remediation bundle itself will accumulate new regressions.
- **R-MMTR (Open Finding #19)** and **R-SOA (Open Finding #20)** are filed separately and should ship in their own bundle. They handle "pipeline died" cases; this PRD handles "pipeline succeeded but landed regressions" cases. Different failure surfaces, different fixes.

## Sister findings

- **Finding #19 (R-MMTR)** — pipeline-killer at the manager level. R-PTG is orthogonal: even with R-MMTR fixed, the bundle would still ship 53 regressions because per-ticket workers don't gate against them.
- **Finding #20 (R-SOA)** — diagnostic gap on shutdown attribution. Orthogonal to R-PTG.
- **Working Rule at MASTER_PLAN line 17** — "Worker tickets must run the lint + typecheck gate before completion-commit" — was authored before the gap was identified; this PRD upgrades it to "lint + typecheck + test:fast" and pushes the change down into code at `spawn-morty.ts:613`.
- **Finding #18 (R-FGNC)** — finalize-gate classifier conflates `.npmrc` WARN with real failures — same family ("gate sees the wrong signal"); R-FGNC fixes classifier robustness at the finalize-gate level, R-PTG closes the loop at the per-ticket level so the finalize-gate has less work to do.
- **`prds/archive/features/convergence-toolchain-gates.md`** — strategic PRD that designed finalize-gate + remediator architecture for microverse phases. R-PTG extends the same philosophy to pickle phase: every commit boundary deserves a gate, not just phase boundaries.

## Triggering session

`2026-05-10-84ad0873` — bundle 2026-05-10. R-CLOSER-2 (`698924c1`) ran the canonical 12-step gate at HEAD `a37c5d70`; 53 unique failing tests in `npm run test:fast` short-circuited the chain. R-CLOSER-3 (`010f5c8b`) and wiring (`4dcf9b43`) auto-skipped. Per-failure forensic audit by parallel `Explore` subagents confirmed: zero worker session logs ran the full `test:fast` suite during their Spec Conformance phase; `spawn-morty.ts:613-690` literally has no test invocation; the rule at `extension/CLAUDE.md:31` says "lint + tsc" only.

## Atomic decomposition

- **R-PTG-1**: extend `runWorkerGate` to run `test:fast` after tsc, parse exit code, surface failures (~80 LOC + helper extraction, 1 commit)
- **R-PTG-2**: update `extension/CLAUDE.md:31` trap-door invariant (~10 LOC docs, 1 commit)
- **R-PTG-3**: rename + extend `spawn-morty-worker-gate.test.js` (~150 LOC test, 1 commit)
- **R-PTG-4**: `worker_test_gate_timeout_ms` setting + plumbing (~40 LOC, 1 commit)
- **R-PTG-5**: `worker_gate_failed` activity event registration + emission + manager-prompt surfacing (~60 LOC across `types/index.ts` + `spawn-morty.ts` + `mux-runner.ts` + 1 test, 2 commits)
- **R-PTG-6**: between-ticket gate in `mux-runner.ts` + `cross_ticket_regression_detected` event (~70 LOC + 1 test, 2 commits)
- **R-PTG-7**: Linear-comment attribution on regression detection (~30 LOC + 1 test, 1 commit; depends on Linear MCP integration already in place)
- **R-PTG-8**: confirm node_modules invariant (~10 LOC docs/test, 1 commit)
- **R-PTG-9**: tiered gate setting (`worker_gate_tier`) (~40 LOC + 1 test, 1 commit)
- **R-PTG-10**: closer (~30 LOC bookkeeping + version bump + install.sh run, 1-2 commits)

Approx 1-1.5 day fix. Bundle this PRD alone OR alongside R-MMTR + R-SOA to close the "pipeline reliability" trifecta in one shipping cycle. **Ship before the 8-class remediation bundle**, otherwise that bundle will recreate the same problem.

## Acceptance criteria (machine-checkable)

- [ ] **AC-PTG-01** — `runWorkerGate` invokes `npm run test:fast`; subprocess exit code propagated. Regression: `tests/spawn-morty-worker-gate.test.js` covers exit-code propagation.
- [ ] **AC-PTG-02** — Worker exits `Failed` (not `Done`) on test:fast failure after retry. Regression: 2-ticket fixture where ticket-1 introduces failing assertion, ticket-2 (next manager iteration) sees `cross_ticket_regression_detected` event.
- [ ] **AC-PTG-03** — `worker_test_gate_timeout_ms` setting honored; default 240_000ms. Regression: settings-loader test.
- [ ] **AC-PTG-04** — `worker_gate_failed` and `cross_ticket_regression_detected` events registered in `VALID_ACTIVITY_EVENTS`. Regression: `tests/activity-event-payload.test.js` (with R-PTG-1's count assertion updated to current schema length, NOT a fresh hardcoded number — drive from `Object.keys(activityEventRegistry).length`).
- [ ] **AC-PTG-05** — `extension/CLAUDE.md:31` trap-door invariant text matches R-PTG-2 wording exactly; trap-door grep + ENFORCE test in `tests/trap-door-coverage.test.js` (or whatever T6 trap-door coverage analyzer R-CCNW-3 just shipped).
- [ ] **AC-PTG-06** — Two-ticket E2E regression where ticket-1 commits a unit test asserting `length === 35` against an event count that's been growing; ticket-2's worker SHOULD have status `Failed` and emit `worker_gate_failed` rather than committing Done. Validates the gate actually fires.

## Working-rule update for MASTER_PLAN

Replace MASTER_PLAN line 17 (Working Rules section) "Worker tickets must run the lint + typecheck gate before completion-commit" with "Worker tickets must run the lint + typecheck + `npm run test:fast` gate before completion-commit; failure on any tier exits the worker `Failed` (not `Done`); one targeted-fix retry allowed before exit." Sync to `extension/CLAUDE.md:31` trap-door per R-PTG-2.

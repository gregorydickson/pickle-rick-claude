---
title: P1 — Reliability + Test Coverage Bundle (2026-05-03 PM)
status: Shipped
date: 2026-05-03
priority: P1
shipped: session 2026-05-03-7d9ee8cc (commit 7786bcb)
type: bundle
peer_prds:
  composes:
    - prds/archive/bug-reports/p1-deployed-pkgjson-version-only-revert.md
    - prds/archive/bug-reports/p2-codex-manager-empty-queue-spin.md
    - prds/archive/bug-reports/p3-paused-session-orphan-blocks-stop-hook.md
    - prds/archive/bug-reports/p3-test-flakes-council-publish-and-scope-resolver.md
  related:
    - prds/citadel.md                                # quality framework
    - prds/archive/bug-reports/anatomy-park-gate-baseline-missing.md     # prior reliability incident
    - prds/p2-bundle-deploy-reversion-and-gate-baseline-diagnostic.md  # prior deploy-revert P0
    - prds/archive/incidents/schema-version-deploy-reversion-rca.md
---

# PRD — Reliability + Test Coverage Bundle (2026-05-03 PM)

## Why this bundle

Recent multi-day session uncovered four distinct bugs that v1.69.0 was supposed to close (or that surfaced **during** v1.69.0 ship). All four share a common root cause class: **the test suite did not catch them.** Either coverage was missing, the bug was in a test/CI seam itself, or the bug was in an end-to-end deploy/lifecycle path that has no automated reproducer.

This bundle composes the four open bug PRDs into one refine + pipeline run, and adds a cross-cutting **Section E** that raises the test-approach bar so future regressions of this shape are caught before tag.

The bundle is sequenced so reliability infra (Section E) lands alongside the per-bug fixes — every Section A–D fix becomes the canary for Section E's new tier of expensive e2e tests. The new tests must reproduce each bug **before** the fix, then go green **after**.

## Bundle composition

| Section | Source PRD | Priority | Scope summary |
|---|---|---|---|
| **A** | `prds/archive/bug-reports/p1-deployed-pkgjson-version-only-revert.md` | P1 | Diagnose + fix the `~/.claude/pickle-rick/extension/package.json:version`-only revert (writer mystery) |
| **B** | `prds/archive/bug-reports/p2-codex-manager-empty-queue-spin.md` | P2 | Mux-runner emits synthetic `EPIC_COMPLETED` when all tickets `status: Done` |
| **C** | `prds/archive/bug-reports/p3-paused-session-orphan-blocks-stop-hook.md` | P3 | resolve-state.ts demotes `active=true && pid==null && mtime>300s` orphans |
| **D** | `prds/archive/bug-reports/p3-test-flakes-council-publish-and-scope-resolver.md` | P3 | Diagnose + fix two pre-existing failing tests (no more timing-bump cargo cult) |
| **E** | _(this PRD only)_ | P1 | Cross-cutting test approach + coverage + reliability infra |

Each per-section PRD's `## Functional Requirements` and `## Acceptance Criteria` are authoritative — refinement should pull them in as-is and decompose to atomic tickets. Section E adds new requirements not present in any source PRD.

---

## Section A — pkg.json:version-only revert

**Source**: `prds/archive/bug-reports/p1-deployed-pkgjson-version-only-revert.md`

Pull all 5 `R-PJV-*` requirements and 5 `AC-PJV-*` criteria verbatim. Sequencing constraint: **R-PJV-1 (diagnose via fs_usage/lsof) MUST land before R-PJV-3/4 (fix).** No defense-in-depth without empirical writer ID — same trap the P0 bundle fell into. Add Section E hooks per E.2.

---

## Section B — codex manager empty-queue spin

**Source**: `prds/archive/bug-reports/p2-codex-manager-empty-queue-spin.md`

Pull all 4 `R-EQ-*` and `AC-EQ-*`. Add Section E hooks per E.3.

---

## Section C — paused-session orphan blocks stop-hook

**Source**: `prds/archive/bug-reports/p3-paused-session-orphan-blocks-stop-hook.md`

Pull all 4 `R-PSO-*` and `AC-PSO-*`. Add Section E hooks per E.4.

---

## Section D — pre-existing test flakes

**Source**: `prds/archive/bug-reports/p3-test-flakes-council-publish-and-scope-resolver.md`

Pull all 4 `AC-TF-*`. Hard rule: **diagnose root cause before any timing/budget changes** — prior fix attempts (`0390916`, `ac7c496`, `71e5c1e`) were all timing bumps and none stuck. Section D feeds into E.7 (mock contract drift).

---

## Section E — Test approach, coverage, and reliability infra (NEW)

This section adds requirements not present in Sections A–D. The intent is to ensure the **next** four bugs of the same shape get caught by the test suite before they reach a release gate.

### Current gaps observed

1. **No deploy-lifecycle e2e.** The pkg.json revert (Section A) bites every 30-60 min of normal operation. We have no test that does `install.sh + sleep 3600 + assert version stable`.
2. **No pipeline e2e with terminal state.** The empty-queue spin (Section B) requires a session where every ticket reaches `Done`. No fixture exercises the post-completion transition into anatomy-park.
3. **State-resolution coverage is lopsided.** `resolve-state.test.js` has tests for dead-pid demotion but not for the `pid=null+active=true` orphan case (Section C). The state matrix isn't exhausted.
4. **Mocks drift from real CLI behavior.** Section D's council-publish test mocks `gh pr comment` with a `hangOnCall` directive that has likely diverged from the production code path it shadows. Mock-only testing missed both real and synthetic regressions.
5. **No test-isolation audit.** Hypothesis H-A in Section A is *"a test mutates `~/.claude/pickle-rick/extension/package.json`"*. Today nothing prevents that. We have `EXTENSION_DIR_TEST` opt-in but no enforcement that test files actually use it.
6. **Coverage is uninstrumented.** No `c8` / `nyc` baseline. We don't know whether resolve-state, mux-runner, install.sh's runtime equivalents are 80% or 30% covered.
7. **No flake quarantine policy.** Sections D's tests have been failing for 3+ releases with the suite still allowed to ship via the gate's silent tolerance of test failures.

### Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| R-RTC-1 | **Test tier classification.** Every test file in `extension/tests/` and `extension/tests/integration/` carries a `// @tier: fast \| integration \| expensive \| contract` comment in the first 20 lines. CI guard `scripts/audit-test-tiers.sh` fails if any test file is missing the tag. | P0 |
| R-RTC-2 | **Three-tier test runner scripts in `extension/package.json`:** `test:fast` (current `npm test` equivalent, ≤90s wall), `test:integration` (everything in `tests/integration/`, ≤10min wall), `test:expensive` (e2e + soak + contract drift, gated on `RUN_EXPENSIVE_TESTS=1`, no upper bound). Default `npm test` runs `test:fast && test:integration`. Release gate adds `test:expensive`. | P0 |
| R-RTC-3 | **Deploy-lifecycle e2e (Section A canary).** New `tests/integration/deploy-lifecycle-soak.test.js` (`@expensive`): runs `bash install.sh` against `EXTENSION_DIR_TEST=$(mktemp -d)`, snapshots `package.json:version`, sleeps 60min (or `SOAK_SECONDS` override) checking version every 30s. Asserts `version` field never reverts. Replays Section A's reproducer in a hermetic dir. | P0 |
| R-RTC-4 | **Pipeline-runner empty-queue e2e (Section B canary).** New `tests/integration/pipeline-empty-queue-e2e.test.js` (`@integration`): synthetic session with N=3 ticket dirs all pre-marked `status: Done`; runs `mux-runner.runIteration()`; asserts (a) synthetic `EPIC_COMPLETED` promise emitted, (b) `state.completion_promise` set, (c) `state.step === 'completed'`, (d) pipeline-runner advances to phase 2/4. | P0 |
| R-RTC-5 | **Stop-hook state matrix (Section C canary).** New `tests/stop-hook-state-matrix.test.js` (`@fast`): cartesian product over `pid ∈ {null, alive, dead}` × `active ∈ {true, false}` × `mtime ∈ {fresh, stale}` × `iteration ∈ {0, 1, 9, 10, 11}` = 60 cells (3 × 2 × 2 × 5). Each cell asserts the expected stop-hook decision (APPROVE / BLOCK / BLOCK-with-reason). Fixture matrix lives in `tests/fixtures/stop-hook-states.json`. | P0 |
| R-RTC-6 | **Test-isolation audit (Section A H-A guard).** New `scripts/audit-test-isolation.sh` walks `extension/tests/**/*.test.js`, fails if any test file references `os.homedir()` or `~/.claude/pickle-rick/extension/` without going through an `EXTENSION_DIR_TEST` env override or `os.tmpdir()`. Wired into `npm test:fast` pre-step. | P0 |
| R-RTC-7 | **Coverage instrumentation + baseline.** Add `c8` to devDependencies; `npm run coverage` produces `coverage/index.html` + a JSON summary; baseline thresholds are committed in `coverage-baseline.json`. Initial baseline is a snapshot, not a target — no failing on regression yet, just measurement. CI prints delta in PR comments (deferred to a later PRD if wiring complexity blocks). | P1 |
| R-RTC-8 | **Mock contract drift tests (`@contract`).** New `tests/contract/gh-cli-contract.test.js`, `tests/contract/codex-cli-contract.test.js`, `tests/contract/claude-cli-contract.test.js` (`@contract` — gated on each binary being installed; skip with reason otherwise). Each runs the binary with a known argv (e.g. `gh --version`, `codex --help`) and asserts the surface our mocks model. Failures mean our mocks have drifted from reality and Section D-class flakes will recur. Runs in `test:expensive`. | P1 |
| R-RTC-9 | **Flake quarantine policy.** New `extension/tests/QUARANTINE.md` lists every test that has failed in the last 100 release-gate runs (manual entry initially; later automated by a metrics script). Quarantined tests are skipped from `test:fast` and `test:integration` but tracked. Each entry MUST cite a follow-up PRD or be removed. CI fails if `QUARANTINE.md` has more than 5 entries. | P1 |
| R-RTC-10 | **Release gate hardening.** Update `extension/CLAUDE.md` Section "Build & Test": release gate becomes `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`. Document explicit policy: **test failures block release, no exceptions** (today's "ESLint errors block; warnings advisory" rule is silent on test failures, which is how Section D's flakes shipped). | P0 |
| R-RTC-11 | **Pre-bundle baseline measurement.** Before any Section A–D ticket starts implementation, `npm run coverage` is run and `coverage-baseline.json` is committed. Section A–D fixes must not reduce coverage of touched files; new e2e tests in E.3/E.4/E.5 must each push at least one file above its baseline. | P1 |
| R-RTC-12 | **Bug-to-test traceability.** Every fix ticket in Sections A, B, C, D MUST include: (a) the new e2e/integration test from E.3/E.4/E.5 that fails at the bug commit and passes at the fix commit, (b) a `Resolves:` link to the source PRD line, (c) a `Test-Tier:` annotation in the commit message. | P0 |

### Acceptance criteria

| AC | Verification |
|---|---|
| AC-RTC-01 | All test files carry `@tier:` comment; `scripts/audit-test-tiers.sh` exits 0 | lint |
| AC-RTC-02 | `npm run test:fast`, `npm run test:integration`, `npm run test:expensive` all defined and exit 0 | shell |
| AC-RTC-03 | `tests/integration/deploy-lifecycle-soak.test.js` reproduces Section A's bug at commit `bdc775f` (pre-fix) and passes at the Section A fix commit. Soak duration ≥ 30 min in CI; configurable via `SOAK_SECONDS` env | integration |
| AC-RTC-04 | `tests/integration/pipeline-empty-queue-e2e.test.js` reproduces Section B's bug at HEAD (pre-fix) and passes at the Section B fix commit | integration |
| AC-RTC-05 | `tests/stop-hook-state-matrix.test.js` covers all 60 cells; failure on each cell pinpoints the exact `(pid, active, mtime, iteration)` tuple in the assertion message | test |
| AC-RTC-06 | `scripts/audit-test-isolation.sh` exits 0; deliberate violation in a fixture exits 1 with file:line evidence | shell |
| AC-RTC-07 | `npm run coverage` produces a baseline; `coverage-baseline.json` committed to the repo | shell |
| AC-RTC-08 | Each `tests/contract/*.test.js` either passes against the locally-installed binary or skips with `it.skip(reason)` and a printed line citing the absent binary | test |
| AC-RTC-09 | `extension/tests/QUARANTINE.md` exists with ≤ 5 entries; every entry cites a PRD path that exists | lint |
| AC-RTC-10 | Updated `extension/CLAUDE.md` Build & Test section is committed; release gate command in CI matches | doc |
| AC-RTC-11 | Coverage delta computed for every Section A–D fix; no touched file goes below its baseline | shell |
| AC-RTC-12 | Every Section A–D fix commit includes the canary test reference + Resolves + Test-Tier in the message | git |

### Sequencing within the bundle

1. **E.1, E.2, E.6, E.10, E.11** (test infra: tiers, scripts, isolation, gate, baseline) — land first as scaffolding tickets. No bug fixes proceed until these are green; otherwise per-bug e2e tests have nowhere to live.
2. **A.1 (R-PJV-1 diagnose), B.1 (R-EQ-1), C.1 (R-PSO-1), D.1 (F1+F2 root-cause)** — diagnose-or-ground-truth tickets for each bug.
3. **E.3, E.4, E.5** — the new canary tests are written FIRST against the diagnosis, made to fail, committed as `xfail` markers if needed.
4. **A.fix, B.fix, C.fix, D.fix** — bug fixes; canary tests flip to passing.
5. **E.7, E.8, E.9** (coverage, contract, quarantine) — close out the reliability infra.
6. **E.12** — traceability check at closer.

### Out of scope for this bundle

- Changing the LLM-call mocking layer (separate PRD: `mock-llm-call-fidelity.md` — TBD).
- Cross-repo test orchestration (separate PRD: `multi-repo-task-state-drift.md`).
- Property-based / fuzz testing (separate PRD: `pickle-fuzz-tests.md` — not yet drafted).
- Performance/load benchmarks (separate from reliability — performance is its own track).

### Risks

- **Soak tests blow CI budget.** Mitigation: `RUN_EXPENSIVE_TESTS=1` gates them out of fast/integration. Nightly cron runs them; release-gate manual run runs them.
- **Test tier audit is annoying for contributors.** Mitigation: `scripts/audit-test-tiers.sh` accepts a default fallback (any file without `@tier:` is treated as `@fast` with a deprecation warning for the first 30 days).
- **Diagnose-first on Section A means longer wall time before fix.** Mitigation: that's the *correct* trade — the P0 bundle's experience showed defense-in-depth without diagnosis = waste.

---

## Cross-cutting verification (closer)

The bundle is Done when:

1. All Section A, B, C, D acceptance criteria from the source PRDs pass.
2. All Section E `AC-RTC-*` criteria pass.
3. **The release gate per R-RTC-10 (full version including expensive tests) exits 0** — single command, no manual steps.
4. Master plan `prds/MASTER_PLAN.md` updated: source PRDs marked Done with bundle-commit hash; test-tier infra documented.
5. Source pkg.json bumps to next semver (likely v1.70.0 — minor, since R-RTC-2 changes the npm scripts contract).

## Master-plan placement

This PRD is the active P1 entry replacing slots #1, #1b, #1c, #1d in the master plan queue once it enters refinement. Update `prds/MASTER_PLAN.md` accordingly.

## Cross-references

- Surfaced during v1.69.0 release ceremony 2026-05-03 PM
- All four source PRDs are Draft status — refinement will pull their FRs/ACs verbatim into atomic tickets
- Test tier convention modeled after the codebase's existing `tests/integration/` split (already 6 files there) — formalizes what's been ad hoc

— Pickle Rick out. *belch*

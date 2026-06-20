---
title: P1 — parallel-load test flakes block worker test:fast gate (refined)
status: Refined
filed: 2026-05-14
refined: 2026-05-13
priority: P1
type: bug
r_code_prefix: R-TSPF
backend_constraint: any
related:
  - prds/archive/bug-reports/p1-test-flake-auto-resume-stop-conditions-banner-past-3.md  # R-ARSF — partial precursor: stabilized auto-resume in isolation but not under full suite parallel load
  - prds/archive/bug-reports/p1-mmtr-cleanup-heal-deferred-tickets-to-done.md             # R-MMTRH — downstream consumer (heal predicate inlined below)
---

# P1 — five-plus parallel-load test flakes block the worker `test:fast` AC gate

## Why this is urgent

Worker AC-7 (tests pass) runs `cd extension && npm run test:fast`. Under default Node test concurrency=8, **at least five** tests fail intermittently even though each passes in isolation. Workers correctly self-defer via `# DEFERRED:`, but cumulative deferral (~75% observed in session `2026-05-13-c122b0f7`, ~50% observed in `2026-05-13-c71ab3ca` after R-ARSF partial fix) prevents long pipelines from completing.

**Pre-fix baseline citations**: `~/.local/share/pickle-rick/sessions/2026-05-13-c122b0f7/state.json` + tmux-iteration logs (~75%); `~/.local/share/pickle-rick/sessions/2026-05-13-c71ab3ca/state.json` (~50%).

## Hypothesized race classes (R-TSPF-1 must MEASURE, not assume)

R-TSPF-1's diagnostic measures the race class per flake. Initial hypotheses (closed set, may extend via PRD edit before R-TSPF-2..N start):

1. `subprocess-spawn-timing` — under CPU contention. Prior mitigation at `extension/tests/council-publish.test.js:75-79` documents shell-mock substitution; flake persists, so mitigation is now insufficient.
2. `process-global-state` — mutation of `process.env.PATH` etc. `extension/tests/ensure-monitor-window.test.js` uses `f.withPath()` at lines 474, 520, 551, 620, 642, 657 (6 call sites).
3. `fake-tmux-write-vs-read-timing` — `extension/tests/mux-runner-relaunch.test.js:90` opens `observed-state.log` before fake-tmux writes its first line.
4. `shared-fixture-path` — *(FALSIFIED for council-publish: `withSession` at line 46 already uses `fs.realpathSync(fs.mkdtempSync(...))` so path collision is impossible — R-TSPF-1 must check each flake independently).*
5. `load-dependent-timeout` — in-test timeout constants (e.g., `HUNG_GH_TIMEOUT_MS`) too tight under parallel CPU load.
6. `stderr-capture` — race on shared stderr buffers between parallel child-tests.
7. `file-existence` — fixture file write-then-read sequencing race.

## Enumerated flakes (provisional — R-TSPF-1 admits or reclassifies each)

1. `auto-resume.stop-conditions > prints [warn] banner past retry 3` (`extension/tests/auto-resume-stop-conditions.test.js`) — R-ARSF stabilized harness; residual under full-suite parallel load.
2. `publishCouncilStack: hung gh pr comment is aborted by timeout, classified as failed` (`extension/tests/council-publish.test.js:916`) — assertion `expected: 1, actual: 2`. **Sibling at line 884 (`hung gh pr list`) is structurally identical — almost certainly a 6th flake; R-TSPF-1 must include it.**
3. `ensureMonitorWindow: phase re-entry performs a fresh recovery sweep with mode-specific pane 2` (`extension/tests/ensure-monitor-window.test.js:503`).
4. `ensureMonitorWindow: returns error when tmux-monitor.sh is missing` (`extension/tests/ensure-monitor-window.test.js:816`).
5. `mux-runner relaunch claims ownership before monitor recovery sees session state` (`extension/tests/mux-runner-relaunch.test.js:90`) — `ENOENT observed-state.log`.

## Acceptance Criteria

- **AC-1 (entry baseline):** R-TSPF-1 measures each enumerated flake's failure rate at `--test-concurrency=8` full-suite (20 runs per test). Tests at **0/20** are reclassified out of scope. Tests at **1-2/20** are documented but get no dedicated fix ticket (noise floor). Tests at **≥3/20** receive a dedicated ticket.
- **AC-1' (exit gate):** Each admitted flake passes **30 consecutive runs** on GitHub Actions `ubuntu-latest` AND on operator local-mac, under BOTH (a) `cd extension && npm run test:fast` (full suite), AND (b) `node --test --test-concurrency=8 <target-test-file>` (solo). Counter does not reset on partial failure; recorded as `passes/total` in `extension/tests/fixtures/r-tspf-7/<test-slug>.log`.
- **AC-2 (root-cause documentation):** Each fix lands a trap-door entry in `extension/CLAUDE.md ## Trap Doors` with shape: `` `<test-path>` — INVARIANT: <line>. BREAKS: <line>. ENFORCE: <test paths>. PATTERN_SHAPE: <grep-anchor>. Race-Class: <one-of: subprocess-spawn-timing | process-global-state | fake-tmux-write-vs-read | shared-fixture-path | load-dependent-timeout | stderr-capture | file-existence>``. Commit messages include `Trap-Door: <PATTERN_SHAPE-anchor>` trailer.
- **AC-3 (intent preservation, objectively checked):** ALL must hold:
  - (a) `grep -c '^assert\.' <file>` unchanged from PR base.
  - (b) `grep -c '^test(' <file>` and `grep -c '^describe(' <file>` unchanged from PR base.
  - (c) No `setTimeout` / `setImmediate` / `await delay()` added without a code comment citing the AC-2 Race-Class.
  - (d) No test moved to `extension/tests/QUARANTINE.md` without R-TSPF-1's structural-infeasibility finding.
  - (e) Splitting one top-level `test()` into two is FORBIDDEN.
- **AC-4 (serialization, if used):** If R-TSPF-1 recommends per-test serialization for any flake, R-TSPF-1 lands: (i) `extension/tests/.serial-tests-fast.json` (forward-created, schema `{entries: string[]}`); (ii) `test:fast:parallel` / `test:fast:serial` script split in `extension/package.json`; (iii) `extension/tests/test-registration-hygiene.test.js:88-98` shape assertions updated; (iv) `Serialize-Reason: <line>` added to trap-door entry. `UNREGISTERED_TEST_ALLOWLIST` is NOT modified.
- **AC-5 (full release-gate chain green):** `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive` exits 0 with zero failures AND zero `# DEFERRED:` lines.
- **AC-6 (regression-test requirement):** Each fix in R-TSPF-2..N is accompanied by a deterministic regression test that FAILS without the fix at `--test-concurrency=1` (forces race via injected timing — not `--test-repeat`, not retry loops).

## Bundle Done Criteria

Each flake admitted by R-TSPF-1 (≥3/20) reaches one terminal state:

- **fixed-and-green** — passes R-TSPF-7's 30-run gate per AC-1'.
- **exited-to-sibling-PRD** — R-TSPF-1 pinned root cause to production code; OOS Exception applied; sibling PRD filed; AC-3 does not apply to that flake.
- **quarantined-with-tracking-ticket** — R-TSPF-1 documented structural infeasibility; test added to `extension/tests/QUARANTINE.md`; sibling tracking ticket filed. Cap: ≤1 of N admitted flakes.

Bundle satisfies AC-5 only if all admitted flakes have terminal state AND ≥⌈N/2⌉ are `fixed-and-green`.

## Implementation Order

- **R-TSPF-1** — Diagnose all flakes (20× parallel runs each); admit ≥3/20 to bundle; categorize each by race class from the closed set; if serialization required, land `extension/tests/.serial-tests-fast.json` + package.json split + `test-registration-hygiene.test.js` assertion update.
- **R-TSPF-2** — Fix flake #1 `auto-resume.stop-conditions` (full-suite residual).
- **R-TSPF-3** — Fix flake #2 + sibling `council-publish hung gh pr comment` AND `hung gh pr list` (class-wide).
- **R-TSPF-4** — Fix flake #3 `ensureMonitorWindow phase re-entry pane 2` + audit other `withPath()` call sites.
- **R-TSPF-5** — Fix flake #4 `ensureMonitorWindow tmux-monitor.sh missing` (may merge with R-TSPF-4 if same race class).
- **R-TSPF-6** — Fix flake #5 `mux-runner-relaunch ENOENT observed-state.log`.
- **R-TSPF-7** — Stability gate: 30-consecutive-runs gate on GH Actions `ubuntu-latest` via new `.github/workflows/stability-gate.yml`; trap-door catalog merged into `extension/CLAUDE.md ## Trap Doors`.

**Merge license**: R-TSPF-2..6 MUST be merged by the worker if R-TSPF-1 finds one race class covers multiple flakes (e.g., load-dependent-timeout fixed by serializing the 2-3 worst offenders). Hard cap: 8 tickets total; beyond that, escalate to a new PRD.

## Out of Scope

- Replacing Node `--test` runner with a different framework.
- Refactoring production code (auto-resume.sh, council-publish.ts, ensure-monitor-window.ts, mux-runner.ts) UNLESS R-TSPF-1's diagnosis pins the root cause to production code, in which case the OOS Exception applies.
- Filing per-flake PRDs separately.
- Lowering `--test-concurrency` default in `extension/package.json` is FORBIDDEN — concurrency=8 is the constraint, not a tunable.
- Increasing `HUNG_GH_TIMEOUT_MS` or similar in-test timeout constants to mask a load-dependent race is FORBIDDEN — serialization (AC-4) is the compliant fix.

### OOS Exceptions

- **Production-code exception:** If R-TSPF-1's 20× diagnosis pins root cause to production code, that flake exits with `exited-to-sibling-PRD` terminal state, AC-3 does not apply, sibling root-cause PRD is filed.
- **Quarantine path:** Permitted ONLY if R-TSPF-1 documents structural infeasibility AND sibling tracking ticket is filed.

## Downstream impact when shipped

Worker AC-7 becomes reliable. Effects:
1. R-MMTRH heal predicate (consumer contract): "for each DEFERRED ticket whose failure references a test in the R-TSPF flake set, the trap-door catalog at `extension/CLAUDE.md ## Trap Doors` contains a `PATTERN_SHAPE: <anchor>` line under that test's path; the heal script then flips that ticket from Skipped+completion_commit to Done."
2. Long-pipeline bundles (20+ tickets) reach completion at expected throughput.
3. DEFERRED-cascade pattern observed in c122b0f7 and c71ab3ca stops recurring.
4. R-ASCH (auto-skip rationale) becomes nice-to-have rather than critical.

## Risks

1. **PRD pre-diagnosed hypotheses bias R-TSPF-1 (P0)** — Mitigated by "R-TSPF-1 MUST measure, not assume" framing above.
2. **Subprocess-spawn timing has prior mitigation; fix space is narrower than PRD implies (P0)** — Mitigated by closed race-class set including `load-dependent-timeout`.
3. **CI gate runs once per PR; AC-1' has no infrastructure (P0)** — Mitigated by R-TSPF-7 forward-creating `.github/workflows/stability-gate.yml`.
4. **R-MMTRH/R-ASCH consumers undocumented at HEAD (P0)** — Mitigated by inlined heal predicate above.
5. **`withPath()` mutates global state at 6+ call sites; only 2 enumerated (P0)** — Mitigated by R-TSPF-1's AC requiring full call-site audit.
6. **Sibling flake at `council-publish.test.js:884` not enumerated (P0)** — Mitigated by R-TSPF-3 covering both lines 884 and 916.
7. **10-run gate statistically underpowered for sub-10% flakes (P0)** — Mitigated by 30 consecutive runs on GH Actions.
8. **Fix masks rather than fixes (P1)** — Mitigated by AC-3(c).
9. **Test-splitting attack on AC-3 (P1)** — Mitigated by AC-3(e).
10. **Serialization allowlist becomes the new normal (P1)** — Mitigated by ≤2-entry soft cap, escalation if exceeded.
11. **Quarantine misused (P1)** — Mitigated by OOS Exception clause requiring structural-infeasibility finding.

## Assumptions

1. The flakes admitted by R-TSPF-1 (≥3/20) are the complete set at HEAD. *Falsifier:* R-TSPF-7's post-fix 20× diagnostic surfaces a new flake outside R-TSPF-1's admitted set.
2. `--test-concurrency=8` is canonical for local + CI.
3. R-MMTRH heal logic consumes trap-door catalog entries (inlined predicate above).
4. The 7-class race set covers every flake R-TSPF-1 will diagnose. *Falsifier:* R-TSPF-1 surfaces an 8th class; PRD extends via documented edit before R-TSPF-2..N start.
5. GH Actions `ubuntu-latest` runner CPU profile is stable enough that 30-run gate variance is dominated by the race, not heterogeneity.

## Implementation Task Breakdown

| Order | ID | Title | Priority | Entry | Exit | Files |
|---:|:---|:---|:---|:---|:---|:---|
| 10 | f54318b1 | R-TSPF-1: Diagnose parallel-load flakes — measure, categorize, plumb serial-manifest if needed | High | HEAD @ `0110b08d`+ | Diagnostic report + (optional) serial-manifest plumbing | `R-TSPF-1/r-tspf-1-diagnosis.md`, `extension/tests/fixtures/r-tspf-1/*.log`, optional `extension/tests/.serial-tests-fast.json` + `extension/package.json` + `extension/tests/test-registration-hygiene.test.js` |
| 20 | 02252412 | R-TSPF-2: Fix auto-resume.stop-conditions parallel-load flake | High | R-TSPF-1 Done | Fixed-and-green or DEFERRED | `extension/tests/auto-resume-stop-conditions.test.js`, `extension/CLAUDE.md` |
| 30 | dd63fa85 | R-TSPF-3: Fix council-publish hung gh pr comment AND hung gh pr list (class-wide) | High | R-TSPF-1 Done | Class-wide fixed-and-green | `extension/tests/council-publish.test.js`, `extension/CLAUDE.md` |
| 40 | 4a96afc6 | R-TSPF-4: Fix ensureMonitorWindow phase re-entry pane-2 flake + audit all withPath() sites | High | R-TSPF-1 Done | Fixed-and-green | `extension/tests/ensure-monitor-window.test.js`, `extension/CLAUDE.md` |
| 50 | c7f40dcc | R-TSPF-5: Fix ensureMonitorWindow tmux-monitor.sh missing flake (may merge with R-TSPF-4) | High | R-TSPF-1 + R-TSPF-4 Done | Fixed-and-green or merged-into-4 DEFERRED | `extension/tests/ensure-monitor-window.test.js`, `extension/CLAUDE.md` |
| 60 | f3cde4ca | R-TSPF-6: Fix mux-runner-relaunch ENOENT observed-state.log flake | High | R-TSPF-1 Done | Fixed-and-green | `extension/tests/mux-runner-relaunch.test.js`, `extension/tests/fixtures/fake-tmux*.sh`, `extension/CLAUDE.md` |
| 70 | 5f4b3c56 | R-TSPF-7: Stability gate — 30-run workflow + trap-door catalog merge | High | R-TSPF-2..6 Done/DEFERRED | Workflow + trap-door catalog merged | `.github/workflows/stability-gate.yml`, `extension/CLAUDE.md` |

**Hardening tickets**: Intentionally skipped. This is a bug-fix bundle on test files; AC-3 + AC-5 + AC-6 already enforce assertion preservation, full release-gate chain, and per-fix regression tests. Adding the 4 generic hardening tickets would violate the operator's 8-ticket-per-bundle cap and target files outside the bundle's scope.

**Wiring ticket**: Intentionally skipped. Bundle scope is per-test-file fixes; no cross-module integration needed.


---
title: P2 — `test:fast` stability-gate widening (R-TFP-W) — close the 67-fail / 19-cancelled gap from gate run 26134340778, unblock v1.76.0 tag
status: Blocked by C-TFP-CLOSER verification on 2026-05-20
filed: 2026-05-19
refined: 2026-05-19
priority: P2 (release-gate blocker; v1.76.0 deferred until this lands green)
type: bug-cluster
code: R-TFP-W
bundle: B-FLAKE
heads_at_filing:
  - branch: main
  - sha: 50826a8b
  - deployed_version: 1.75.5
  - source_version: 1.75.5
related:
  - prds/archive/bug-reports/p3-test-fast-parallel-load-flakes.md  # original R-TFP-1..5 (4-flake-class scope); this PRD WIDENS that with the actual 67-fail surface
  - prds/MASTER_PLAN.md  # B-FLAKE queue slot; v1.76.0 deferral note
findings_closed:
  - "#32 R-TFP (widened from 4-class to actual 67-fail surface; closes the bundle slot)"
ship_target: v1.76.0  # version bump rolled into C-TFP-CLOSER (final closer ticket); semver-minor — no breaking changes, just stabilization
worker_backend: codex  # parallel-load measurement needs the slower-but-deeper iteration loop; claude backend acceptable but operator-pick
preflight:
  - bash install.sh  # deployed JS at HEAD 50826a8b is stale (12 .js files diverge from src; tmux-runner.js leftover); MUST run before launch
  - PICKLE_TEST_MODE=1 npm run test:fast --prefix extension  # baseline measurement of current flake set inside session_dir
---

# P2 — `test:fast` stability-gate widening (R-TFP-W)

## Problem (one paragraph)

GitHub Actions stability-gate workflow run **26134340778** (commit `50826a8b`, 30 repetitions of `test:fast` under `--test-concurrency=8`) **failed**: 4858 tests / 4754 pass / **67 fail + 19 cancelled + 17 skipped**. This blocks the v1.76.0 release-gate ship per the documented "If red → file R-TFP stabilization bundle, defer v1.76.0" path. The existing R-TFP PRD (`prds/archive/bug-reports/p3-test-fast-parallel-load-flakes.md`, R-TFP-1..5) was scoped to 4 flake classes. The gate evidence shows a **vastly wider surface**: ~90 distinct failing subtests across 11 module clusters, with strong cross-cutting signal that StateManager's dead-writer-tmp recovery is timing-sensitive under parallel load. This bundle WIDENS the diagnosis (per Working Rule — "Trust measured diagnosis over PRD-author hypothesis") and ships 11 atomic remediation tickets, each scoped to one module cluster, with a worker directive to **MEASURE the flake class per failing test before fixing**.

## Gate evidence

**Source**: `gh run view 26134340778 --log-failed`

| Stat | Value |
|---|---|
| Workflow | Stability Gate (30 × `test:fast` under `--test-concurrency=8`) |
| Commit | `50826a8b` |
| Conclusion | failure |
| Tests | 4858 |
| Pass | 4754 |
| Fail | **67** |
| Cancelled | **19** |
| Skipped | 17 |
| Duration | 94.96s per run |

## Worker Gate Template

*(refined: ac_shape_smell — the per-ticket gate predicate was repeated verbatim across all 11 atomic tickets; factored here once.)*

Every R-TFP-W* atomic ticket (W1-W11) and T-HARDEN-TFP references **"the Worker Gate Template"** in its Acceptance Criteria rather than repeating the predicate. The template is:

```bash
# Run from extension/. All three MUST pass before a ticket may be marked Done.
npx eslint src/ --max-warnings=-1
npx tsc --noEmit
npm run test:fast
# Skip-rule enforcement: the diff MUST NOT introduce t.skip()/t.todo().
if git diff HEAD -- extension/tests/ | grep -E '^\+\s*t\.(skip|todo)\('; then
  echo "FAIL: ticket added t.skip/t.todo — Working Rule violation"; exit 1
fi
```

Notes:
- Per-ticket gate covers `extension/CLAUDE.md § "Build & Test"` lines 1-3 only (lint + tsc --noEmit + test:fast). The 6 audit scripts, `test:integration`, and `test:expensive` tiers are deferred to **C-TFP-CLOSER step 1**.
- The cluster's listed failing subtests must additionally pass **5/5** under `node --test --test-concurrency=8 <testfile>`.
- No `t.skip()` / `t.todo()` is permitted without operator pre-approval — a genuinely bad timing-assertion is *rewritten* against a deterministic synthetic clock, not disabled.

## Working Rule reminders (read before claiming a ticket)

1. **Measure, do not assume.** Each worker MUST run the test it owns in isolation under `--test-concurrency=8` against the **full** `test:fast` suite, capture the failure mode, and write a `## Measurement evidence` H2 into its research artifact citing (a) the exact `node --test` invocation, (b) the iteration count where the failure first surfaced, (c) one of: load-dependent-timeout / subprocess-spawn-timing / process-global-state / file-existence-or-fixture-collision / other-with-rationale — BEFORE attempting a fix.
2. **No skip-passes.** Tests are NOT to be `t.skip()`'d or `t.todo()`'d under worker autonomy. Rewrite bad timing assertions against a deterministic synthetic clock (`node:test` built-in `t.mock.timers.enable()` — Node 20+ stdlib, zero new dependency). Operator pre-approval required for any `t.skip()`.
3. **One worker, one cluster.** Cross-cluster fixes belong to a single ticket — claim ONE and hand off the others via `manager_handoff_pending` with the diff already staged.
4. **Stability gate is the AC, not local test:fast.** Local `npm run test:fast` may pass while the gate's 30× loop fails.
5. **Tier discipline.** *(refined: codebase analyst)* Workers MUST NOT edit `extension/src/bin/__tests__/*.spec.ts` (Vitest tier, 3 files at HEAD) to satisfy `test:fast` stability. The `--test-concurrency=8` 5/5 procedure applies ONLY to `extension/tests/**/*.test.js` (`node --test` tier).

## Cluster signal

| Cluster | Module token | Order |
|---|---|---|
| W9 dead-writer / orphan-tmp recovery (cross-cutting common cause) | `recoverOrphanTmpFiles`, `isProcessAlive` | 1st |
| W1 runGate / convergence-gate | `runGate`, `runGate hang-guard` | then |
| W2 jar-runner | `jar-runner`, `jar-runner (codex)` | then |
| W3 mux-runner | `mux-runner`, `quality-gate skip`, `wasted-iter.emit` | then |
| W4 R-MDS dashboard / writeWithWatchdog | `R-MDS-3/4 AC-*`, `renderDashboard` | then |
| W5 pipeline-runner main | `main dispatches/persists/recovers` | then |
| W6 pipeline scope setup | `setupScope`, `backcompat`, `scope injection` | then |
| W7 anatomy/szechuan judge_unreachable | `judge_unreachable`, `judge_timeout` | then |
| W8 iteration events | `iteration events: ...` | then |
| W10 monitor / ensureMonitorWindow | `ensureMonitorWindow stub tmux` | then |
| W11 misc singletons | fixture / process-management | then |
| T-HARDEN-TFP flake-budget gate | (new) | then |
| C-TFP-CLOSER release v1.76.0 | (bookkeeping) | last |

**Execution order rationale** *(refined: risk-scope + codebase analysts)*: **W9 runs FIRST** — it is the suspected cross-cutting common cause. Landing it lets sibling tickets re-scope. Then W1..W8, W10, W11, then T-HARDEN-TFP, then C-TFP-CLOSER.

## Risks

*(refined: risk-scope analyst — operational risks that determine whether the bundle ships at all.)*

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R-W9-FORMAT | W9's fix changes the on-disk tmp-name FORMAT in production code → regresses 93 currently-passing tests across 27 files that depend on the existing 3 inconsistent formats; also forces a v2.0.0 (breaking) tag instead of v1.76.0 (minor) | Low (constraint enforced) | High | W9 worker directive HARD-forbids tmp-name format changes in `state-manager.ts`; allowed surfaces are recovery-side (mtime tie-breaker / `/proc` start-time) or test-harness-side (per-test `mkdtemp` realpath roots). If only a format change works → escalate via `manager_handoff_pending`, pause siblings, do NOT land |
| R-CLOSER-SKIP | Operator ships v1.76.0 without running C-TFP-CLOSER's manual stability gate — the workflow's PR-trigger only auto-fires on 4 test files (`auto-resume-stop-conditions.test.js`, `council-publish.test.js`, `ensure-monitor-window.test.js`, `mux-runner-relaunch.test.js`) + `.serial-tests-fast.json`, so the closer's `gh workflow run` is the SOLE structural merge-time gate for ~95% of the diff | Medium (operator fatigue) | High (silent regression on main) | Closer MUST emit a `closer_stability_gate_run_id` activity breadcrumb with the gh-run URL; post-ship verifier checks it points to a `conclusion=success` run |
| R-FAIL-FAST | The stability-gate workflow is fail-fast (`\|\| exit 1` aborts iters N+1..30); a 1/30 fail produces strictly less data than implied — closer could mis-read "1 fail at iter 5" as "29 clean runs" | Confirmed | Medium (false ship signal) | Closer step 2 distinguishes iter≤5 (probable flake, retry once) from iter>5 (strong-signal regression, hard block); cancelled/timeout counts come from the `stability-gate-logs/` artifact parse, not the conclusion field |

## Decomposition

11 atomic implementation tickets + 1 hardening + 1 closer = **13 tickets**.

---

### R-TFP-W9 — Dead-writer `.tmp.*` / orphan-tmp recovery cross-cutting stabilization

**Cluster**: dead-writer / orphan-tmp recovery across `recoverOrphanTmpFiles`, `verify-recapture`, `spawn-morty P2`, `check-scope-diff`, `writeWithWatchdog` callers.

**Scope** *(refined: codebase analyst — `recoverDeadWriterTmp` was FABRICATED)*: `extension/src/services/state-manager.ts`. Real symbols: `recoverOrphanTmpFiles` (lines 833-870) and `recoverFromOrphanTmpWhenBaseCorrupt` (line 782). The actual race is the `isProcessAlive(tmpPid)` PID check at `state-manager.ts:801` AND `:855` — under `node --test --test-concurrency=8`, a dead worker's PID gets reused by a live worker, so the recovery scan's `if (Number.isFinite(tmpPid) && isProcessAlive(tmpPid)) continue;` skips a tmp that should be promoted. `verify-recapture-fired` has NO source under `extension/src/` — only deployed `bin/verify-recapture-fired.js`; its failing subtest can only be fixed test-harness-side.

**HARD CONSTRAINT (R-W9-FORMAT)**: The W9 diff MUST NOT change the on-disk tmp-name FORMAT in production code. `state-manager.ts` uses 3 inconsistent formats today (`.migration.${pid}.${Date.now()}` at :211, `.tomb.${pid}.${Date.now()}` at :769, `.tmp.${pid}` at :1140); 93 currently-passing tests across 27 files depend on this. The fix MUST be EITHER recovery-side (mtime tie-breaker / start-time comparison via `/proc`) OR test-harness-side (per-test `mkdtemp` realpath roots). If measurement shows only a format change works, escalate via `manager_handoff_pending` and do NOT land while siblings are mid-flight.

**AC**: 8 listed subtests pass 5/5 under `--test-concurrency=8`; Worker Gate Template green.

---

### R-TFP-W1 — runGate / convergence-gate timing stabilization

**Scope** *(refined: requirements + codebase analysts — original path missing `services/` prefix)*: `extension/src/services/convergence-gate.ts` + `extension/tests/services/convergence-gate.test.js` + 12 verified siblings (`convergence-gate-{baseline,baseline-freshness,baseline-no-project-type,baseline-schema,baseline-schema-parity,baseline-write-verify,flake-allowlist,hang-guard,lock,resolution,test-safety,workspaces}.test.js`).

**AC**: 10 listed subtests pass 5/5; Worker Gate Template green.

---

### R-TFP-W2 — jar-runner codex backend + settings-parsing stabilization

**Scope**: `extension/src/bin/jar-runner.ts` + `extension/tests/jar-runner.test.js`, `jar-codex.test.js`, `jar-batch.test.js`.

**AC**: 11 listed subtests pass 5/5; Worker Gate Template green.

---

### R-TFP-W3 — mux-runner orphan-tmp / quality-gate-skip / wasted-iter stabilization

**Scope**: `extension/src/bin/mux-runner.ts` + `extension/tests/mux-runner.test.js`, `mux-runner-quality-gate-timeout-contract.test.js`, `mux-runner-epic-recovery.test.js`. *(refined: codebase analyst — the once-per-process warning emit site is non-grep-able; trace from the failing test's `warn(...)` callsite.)*

**AC**: 9 listed subtests pass 5/5; Worker Gate Template green.

---

### R-TFP-W4 — R-MDS dashboard render + writeWithWatchdog stabilization

**Scope** *(refined: requirements analyst — `writeWithWatchdog` is exported at `monitor.ts:80`, NOT in state-manager.ts)*: `extension/src/bin/monitor.ts` (`writeWithWatchdog:80`, `renderDashboard`) + `extension/tests/monitor.test.js`.

**AC**: listed subtests pass 5/5; Worker Gate Template green.

---

### R-TFP-W5 — pipeline-runner main dispatcher stabilization

**Scope**: `extension/src/bin/pipeline-runner.ts` + `extension/tests/pipeline-runner.test.js`, `pipeline-runner-dispatch.test.js`, `pipeline-runner-phase-history.test.js`.

**AC**: 9 listed subtests pass 5/5; Worker Gate Template green.

---

### R-TFP-W6 — pipeline scope.json setup + backcompat parity stabilization

**Scope** *(refined: codebase analyst — `scope-setup.ts` does NOT exist; the function is `setupScope` at `pipeline-runner.ts:939`)*: `extension/src/services/scope-resolver.ts` + `extension/tests/scope-pipeline.test.js`, `scope-backcompat.test.js`, `szechuan-scope.test.js`, `anatomy-park-scope.test.js`.

**AC**: 9 listed subtests pass 5/5; Worker Gate Template green.

---

### R-TFP-W7 — anatomy/szechuan judge_unreachable + finalize-gate stabilization

**Scope**: `extension/src/bin/pipeline-runner.ts` + `extension/tests/pipeline-runner-judge-unreachable.test.js`, `citadel-pipeline-regression-smoke.test.js`.

**AC**: 5 listed subtests pass 5/5; Worker Gate Template green.

---

### R-TFP-W8 — iteration-events session/iter persistence stabilization

**Scope** *(refined: codebase analyst — `logActivityEvent` is FABRICATED; real symbol is `logActivity`)*: `extension/src/services/activity-logger.ts:48` (`logActivity`) + `extension/src/types/index.ts:470` (`VALID_ACTIVITY_EVENTS`). Emit sites: `mux-runner.ts:4397` (iteration_start), `:4683` (iteration_end), `:1495` (wasted_iter). Failing subtests in `extension/tests/mux-runner.test.js` (near lines 2611/2621/2631/2641).

**AC**: 3 listed subtests pass 5/5; Worker Gate Template green.

---

### R-TFP-W10 — Monitor / ensureMonitorWindow stabilization

**Scope**: `extension/src/bin/monitor.ts` + `extension/tests/ensure-monitor-window.test.js`, `ensure-monitor-window-stub.test.js`.

**AC**: 1 listed subtest passes 5/5; Worker Gate Template green.

---

### R-TFP-W11 — Fixture / process-management singleton stabilization

**Scope**: multiple files — worker triages. Tests: `extension/tests/timeout-happy-path.test.js`, `mux-runner-epic-recovery.test.js`, `purge-update-cache.test.js`, `setup-teams.test.js`, `install-agent-overlay.test.js`, `get-session.test.js`.

**AC**: 9 listed singletons pass 5/5; Worker Gate Template green. The worker's first job is triage — classify each failing subtest and decide fix-all-in-one vs escalate-sub-split via `manager_handoff_pending`.

---

### T-HARDEN-TFP — Stability-gate regression coverage + flake-budget assertion

**Scope** *(refined: codebase analyst — `extension/templates/` does NOT exist)*: `extension/src/bin/check-flake-budget.ts` (created by R-TFP-W) → compiled to `extension/bin/check-flake-budget.js`; `extension/scripts/check-flake-budget.sh` (created by R-TFP-W); `extension/tests/flake-budget.test.js` (created by R-TFP-W); `extension/CLAUDE.md` (new trap door). No reference to `extension/templates/worker-gate-template.sh`.

**AC**: new script + shell wrapper committed; new trap door in `extension/CLAUDE.md`; 3+ regression tests; Worker Gate Template green.

---

### C-TFP-CLOSER — v1.76.0 release + MASTER_PLAN bookkeeping + stability-gate re-run

**Scope**: `extension/package.json` (1.75.5 → 1.76.0), `prds/MASTER_PLAN.md`, `prds/archive/bug-reports/p3-test-fast-parallel-load-flakes.md` (mark Superseded), `prds/archive/bundles/p2-test-fast-stability-gate-widening-2026-05-19.md` (mark Shipped).

**Closer step 2 — fail-fast-aware re-run** *(refined: risk-scope analyst — workflow is `|| exit 1`)*:
- (a) `conclusion=success` → AC met.
- (b) `conclusion=failure` on iter ≤ 5 → probable flake; run a SECOND gate invocation. If the second also fails at iter ≤ 5 → hard block.
- (c) `conclusion=failure` on iter > 5 → strong-signal regression; hard block immediately, no retry; file `prds/p2-test-fast-stability-gate-widening-2026-05-19-residual.md` with the iter-N failure log and run ID.
- (d) Do NOT infer "29/30 clean" from a single iter-N fail — the workflow's `exit 1` means iters N+1..30 never ran.
- Closer MUST emit a `closer_stability_gate_run_id` activity breadcrumb with the gh-run URL.

**AC**: full lint/tsc/test/audit gate green; stability gate re-run resolved per step 2; `extension/package.json` at 1.76.0; `bash install.sh` md5-parity verified; `gh release create v1.76.0`; `prds/MASTER_PLAN.md` reflects B-FLAKE Shipped + Finding #32 Closed + v1.76.0.

---

## Acceptance for the bundle as a whole

- All 11 atomic R-TFP-W* tickets land their listed subtests passing 5/5 in isolation under `--test-concurrency=8`.
- T-HARDEN-TFP ships the flake-budget gate + trap door.
- C-TFP-CLOSER resolves the stability gate per the fail-fast-aware step 2 and tags v1.76.0; the `closer_stability_gate_run_id` breadcrumb exists.
- `prds/archive/bug-reports/p3-test-fast-parallel-load-flakes.md` marked Superseded.
- `prds/MASTER_PLAN.md` reflects the new state.

## Implementation Task Breakdown

| Order | ID(hash) | Code | Title | Priority |
|---|---|---|---|---|
| 10 | 69492311 | R-TFP-W9 | Stabilize dead-writer/orphan-tmp recovery race | High |
| 20 | eb96e43e | R-TFP-W1 | Stabilize runGate/convergence-gate timing | High |
| 30 | 3d79bf7a | R-TFP-W2 | Stabilize jar-runner codex backend + settings parsing | High |
| 40 | 0fb26a4c | R-TFP-W3 | Stabilize mux-runner orphan-tmp/quality-gate-skip/wasted-iter | High |
| 50 | 282b2f70 | R-TFP-W4 | Stabilize R-MDS dashboard render + writeWithWatchdog | High |
| 60 | 48be1f2b | R-TFP-W5 | Stabilize pipeline-runner main dispatcher | High |
| 70 | c0eb4e1f | R-TFP-W6 | Stabilize pipeline scope.json setup + backcompat parity | High |
| 80 | c7925102 | R-TFP-W7 | Stabilize anatomy/szechuan judge_unreachable + finalize-gate | High |
| 90 | 9a028334 | R-TFP-W8 | Stabilize iteration-events session/iter persistence | High |
| 100 | 1c0da148 | R-TFP-W10 | Stabilize ensureMonitorWindow stub-tmux | High |
| 110 | 1697cd81 | R-TFP-W11 | Stabilize fixture/process-management singletons | High |
| 120 | 944cce35 | T-HARDEN-TFP | Add flake-budget gate + trap door | High |
| 130 | 8160c9ad | C-TFP-CLOSER | Release v1.76.0 + MASTER_PLAN + stability-gate re-run | High |

## Measurement evidence

- Local closer gate on 2026-05-20 did not go green. The required ordered command reached `npm run test:fast`, and that tier reported a failing subtest: `runner times out wedged child test process instead of hanging indefinitely` from `extension/tests/bin/test-runner-tier-discovery.test.js:257`.
- The ticket-specified dispatch shape `gh workflow run stability-gate.yml -f run_count=30 -f commit=<HEAD>` is not currently supported by the workflow contract. The only declared `workflow_dispatch` input is `run_count`, so GitHub rejected the `commit` input with HTTP 422 (`.github/workflows/stability-gate.yml:3-9`).
- Manual closer run `26148905248` (`https://github.com/gregorydickson/pickle-rick-claude/actions/runs/26148905248`) executed on remote `headSha` `50826a8b5ce3f426bd965a0d427d670b04cd095e`, not local `HEAD` `5e8eb530f20c1a609d6ae23a8ee5f18aa44aea21`. It failed on `Pass 1/30` with `# fail 66`, `# cancelled 19`, and `Process completed with exit code 1`.
- Retry run `26149014236` (`https://github.com/gregorydickson/pickle-rick-claude/actions/runs/26149014236`) also executed on remote `headSha` `50826a8b5ce3f426bd965a0d427d670b04cd095e`. It failed on `Pass 1/30` with `# fail 68`, `# cancelled 19`, and `Process completed with exit code 1`.
- Per closer step 2(b), a second failure at iteration `1` is a hard block. Do not declare this PRD shipped, and do not infer any later-pass cleanliness from either run because the workflow exits on the first failed pass (`.github/workflows/stability-gate.yml:34-44`).
- `prds/MASTER_PLAN.md` was already dirty before the worker resumed, so this iteration recorded `manager_handoff_pending` and left that file untouched (`linear_ticket_8160c9ad.md:44-49`).

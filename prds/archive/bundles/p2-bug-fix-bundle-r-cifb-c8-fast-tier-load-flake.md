---
title: "R-CIFB — c=8 fast-tier load-starvation flake (chronic CI red)"
finding: 115
priority: P2
status: open
created: 2026-06-15
source_incident: "CI chronically RED ≥12 runs back to 2026-06-12; surfaced once R-FBMB #114 unmasked the ENOBUFS"
schema_neutral: true
---

# R-CIFB — c=8 fast-tier load-starvation flake

## Problem

CI on `main` has been chronically RED for ≥12 runs (back to 2026-06-12). The ENOBUFS bug (R-FBMB #114) masked it for two days; once fixed, `test:fast:budget` (5× `node bin/test-runner.js --tier fast --test-concurrency=8`, `--fail-budget=2`) reliably reports `FAIL_BUDGET_EXCEEDED failures=3 budget=2` on CI runners.

It is NOT a deterministic break:
- A single isolated `test:fast` pass at c=8 on a fast 8-core Mac is CLEAN (6427/6430, 0 fail).
- Under the full release gate's concurrent load (or on weaker CI runners), individual timing/subprocess-sensitive tests get **starved** past their internal deadlines and fail timeout-shaped.

## Root cause (REVISED 2026-06-15 after CI-log analysis — the c=8-flake theory was WRONG)

The stability-gate run (27584934193) artifact (`test-fast-pass-1.log`) showed **48 fail + 36 cancelled in a single CI run** — far too many for a load flake, and many are pure-logic tests. The actual error breakdown is **deterministic CI-environment-gap failures, NOT c=8 starvation**:

| Bucket | Count | Cause |
|---|---|---|
| `Cannot find module '~/.claude/pickle-rick/extension/bin/init-microverse.js'` (MODULE_NOT_FOUND) | **61** | DOMINANT. `tests/anatomy-park-scope.test.js` + `tests/szechuan-scope.test.js` hardcoded `EXTENSION_ROOT = path.join(os.homedir(), '.claude/pickle-rick')` (the **deployed** root) and passed it to `setupAnatomyPark`/`setupSzechuanSauce`, which spawn `<root>/extension/bin/init-microverse.js`. The deployed root exists on a dev machine (install.sh run) but **CI never runs install.sh** → absent → MODULE_NOT_FOUND. |
| `claude --version exceeded probe timeout` | 4 | Tests probe for the `claude` CLI binary, absent on CI runners. |
| `ENOENT … microverse.json` | 6 | anatomy-park scope fixtures, same family as the init-microverse failures. |
| AssertionErrors | a few | downstream of the above (subprocess failed → assertion on its output fails). |

This is why **local passes** (dev has the deployed extension + `claude` CLI) but **CI fails deterministically** (it has neither). It also explains the chronic redness: a swath of fast-tier tests have a hidden dependency on the deployed runtime. The earlier `guardRereadBackoffMs R-CCR-9` 10s-deadline observation is a REAL but MINOR secondary c=8 flake (1/6430 locally), not the chronic-red driver.

## Fix progress (multi-cause — bigger than first scoped)

The chronic CI red has THREE independent causes, not one:

**Cause 1 — deployed-extension dependency (deterministic, the dominant bucket):**
- Per-test EXTENSION_ROOT params: 4 test files passed the DEPLOYED root to `setupAnatomyPark`/`setupSzechuanSauce` → fixed to repo-root: `anatomy-park-scope.test.js` + `szechuan-scope.test.js` (7cb5c7fd), `scope-backcompat.test.js` + `pipeline-runner-design-safe.test.js` (8b04f48a).
- **SYSTEMIC source (the persistent 46):** `getExtensionRoot()` (`src/services/pickle-utils.ts`) returns `CANONICAL_EXTENSION_ROOT = ~/.claude/pickle-rick` whenever `EXTENSION_DIR` is unset — which it is on CI (no install.sh). Many spawn sites resolve `init-microverse.js` through this, NOT the test param. **✅ FIXED b052f49a: set `EXTENSION_DIR=${{ github.workspace }}` in `ci.yml` + `stability-gate.yml`** (sentinel `extension/bin/log-watcher.js` is committed → resolves to the checked-out repo). Run command unchanged → release-gate parity intact. Verified locally: `EXTENSION_DIR=$repo getExtensionRoot() → repo root`.

**✅ Cause 1 CONFIRMED FIXED (re-measure 27588277475):** init-microverse MODULE_NOT_FOUND **46 → 0**; zero deployed-path resolutions remain. The EXTENSION_DIR=workspace fix + the 4 per-test repo-root fixes fully closed the deployed-extension dependency.

Surviving = 37 fail + 36 cancelled, three heterogeneous clusters (each its own fix, no silver bullet):

**Cause 2 — node:test async-cancellation (36 'Promise resolution still pending' = the 36 cancelled):** e.g. `writeWithWatchdog: surfaces sink error` (ERR_TEST_FAILURE). CI node 22.x vs dev/CLAUDE.md Node 25 (pass locally). Node-version-skew OR load. Fix candidates: node-version alignment (CLAUDE.md authoritative = Node 25; reversible experiment) OR per-test await-hygiene OR serialize per R-TFP. NOT a silver bullet — only ~36 of the survivors.

**Cause 3a — section-c-gate ENOENT cluster (~10 tests):** `ENOENT … /tmp/section-c-home-XXXX/.local/share/pickle-rick/bundle/section-c-still-needed.json` — the test's fake-HOME bundle dir isn't created before the runtime writes the artifact. Shared root cause across the cluster — likely one fix (mkdir -p the bundle dir, or the runtime should create it). Investigate `tests/*section-c*` + the bundle-write path.

**Cause 3b — runGate AssertionError cluster (~10 tests, `tests/services/convergence-gate-workspaces.test.js`):** `AssertionError: expected 'green'` — the convergence-gate runs REAL npm/tsc/lint against fixture packages; behaves differently on CI (tooling/fixture env). Investigate whether the fixtures need setup or the test should mock the command layer.

**Note:** the `claude --version probe timed out` lines are TAP `#` DIAGNOSTICS (benign fallback-to-measurement), NOT failures.

## STATUS 2026-06-16: structural causes SOLVED (84→25), remaining tail = env-specific hygiene

Four confirmed systematic fixes took CI from 84 failures to ~25 (70% reduction):
1. ✅ Deployed-extension dep (init-microverse 46→0): 4 test repo-root fixes + `EXTENSION_DIR=github.workspace` in workflows.
2. ✅ ENOENT data-root (section-c-gate/verify-recapture): hermetic-env strip of `EXTENSION_DIR`/`PICKLE_DATA_ROOT`/`PICKLE_DATA_DIR` (the EXTENSION_DIR side effect on `getDataRoot`).
3. ✅ node:test async-cancel (36→0): CI node 22→24 (node 22's runner over-strict on file-level unsettled promises; relaxed 23+).
4. ✅ stability-gate full-history checkout (`fetch-depth:0`, align ci.yml) — correct alignment, though it did NOT fix the runGate cluster (that was a wrong hypothesis).

### Remaining ~25 (de-prioritized hygiene tail — CI-green is NOT a release gate)

Two sub-classes, established by running each file under CI-sim (`EXTENSION_DIR=$repo TZ=UTC node --test`):

- **✅ FIXED `addToJar` ×2 (`jar-utils.test.js`) 2026-06-16:** RE-DIAGNOSED — NOT TZ-cache (prior guess wrong); same getDataRoot-redirect class as cluster-3a. CI sets `EXTENSION_DIR=workspace`; `getDataRoot()` consults it before HOME, so addToJar wrote under the repo while the test asserted `os.homedir()`. Fix: assert against `getDataRoot()` (locally identical when EXTENSION_DIR unset) + gitignore `jar/` (in-process test writes a stray there under EXTENSION_DIR). Verified 11/11 WITH EXTENSION_DIR set. (Third R-CIFB sub-issue I initially mis-named — reinforces: confirm the repro mechanism, don't guess from the test name.)
- **CI-ONLY (node-24/Linux-specific, do NOT reproduce on macOS/node25 even under CI-sim):** `getSessionPath` (12/12 pass locally), `runGate` ×9 (`convergence-gate-workspaces` — gate runs real npm/tsc on fixtures, returns 'red' on CI), `verify-recapture recovers-orphan-tmp`, `showStatus`, `mux-runner orphan-tmp`, `check-readiness`, `install-agent-overlay`, `guard-logging`, `purge-update-cache`, `check-update`, `FR-B10` (subprocess killed exit 1 = load/timeout). These need a Linux/node-24 repro environment OR methodical per-test CI-log forensics (expected-vs-actual extraction). **Name-based hypothesis guessing FAILED here twice (fetch-depth, pid-EINVAL both wrong) — do NOT guess; extract the real error block or get a repro env.**

### 2026-06-16: CI-only tail (23) is NOT log-diagnosable — FULLY DEFERRED

After fixing addToJar (confirmed on CI run 27595573592: addToJar 0, total ~23 distinct), I attempted to diagnose the biggest remaining cluster (runGate ×9, `convergence-gate-workspaces`) from the CI logs. Two blockers make the CI-only tail undiagnosable from logs alone:
1. At `--test-concurrency=8` the per-test stdout is heavily INTERLEAVED across files, so a failing test's error block is buried in unrelated output.
2. The actual failures only show `'red' !== 'green'` — the convergence gate's INTERNAL failure reasons (which check/command went red, why) are NOT printed by the test, so the log doesn't reveal the root cause.

Combined with "don't reproduce on macOS/node25 even under CI-sim", the remaining 23 require EITHER (a) a Linux/node24 repro environment (Docker `node:24` + run the fast tier), OR (b) a dedicated session that temporarily INSTRUMENTS the failing tests (e.g. print `result.failures` / the orphan-tmp expected-vs-actual) and re-runs stability-gate to capture the real reasons. This is NOT babysitter tick-work and MUST NOT be guessed at (3 name-based guesses already failed: fetch-depth, pid-EINVAL, addToJar-TZ).

**FULLY DEFERRED.** The remaining 23 CI-only failures are accepted as known CI-red (CI-green is hygiene, never a release gate). Resume only with a real repro env or an instrumentation pass, in a dedicated session.

### 2026-06-16 repro investigation — node-version RULED OUT, root class = LINUX-specific

Ran the failing files on **node v24.13.1 (macOS, via nvm)** with `EXTENSION_DIR` set (CI-match): get-session 12/12, convergence-gate-workspaces 14/14, status 25/25, check-update 72/72 — **ALL PASS**. So the remaining ~23 are **NOT node-version-specific** (they pass on node24 AND node25 on macOS); they are **Linux-specific** — almost certainly Linux vs macOS differences in filesystem/path/pid/tmp/`os.tmpdir` semantics (e.g. `/tmp` symlink resolution, pid namespace, dead-pid detection, real-command behavior on Linux fixtures). They also pass at c=8 locally, so it's the OS, not concurrency.

A Linux repro (`node:24` Docker container) was attempted but **Docker Hub image pulls hang/throttle in this environment** (node:24 and node:24-slim both stuck >30–60 min, empty progress, killed). So the Linux repro is NOT obtainable here without working Docker network or a pre-pulled node:24 image.

### 2026-06-16 ROOT CAUSE FOUND (via CI-instrumentation pass — debug workflow + Linux env probe)

The `.github/workflows/rcifb-debug.yml` diagnostic workflow (runs each failing file individually on Linux/node24, + a Linux env probe) reproduced the failures with clean errors and revealed the root cause. **It is NOT pid detection** — the Linux probe confirms `process.kill(99999999,0)` throws ESRCH on Linux exactly like macOS (`isProcessAlive` correctly returns dead). It is **mtime-resolution ties**:

- **Worked example — get-session `getSessionPath: mapped dead-pid…`:** `selectScannedSessionPath` (`pickle-utils.ts:1659`) collects every `active===true` session as a candidate (it does NOT demote a dead-pid active session — the stale session has `pid:99999999` but is still a candidate) and ranks by `preferNewerSession` (`:1648`) → `getSessionRecencyMs` (`:1637`) → falls back to `state_mtime_ms` when there's no `started_at`. The test writes `stale-session/state.json` then `live-session/state.json`. On macOS the two writes get DISTINCT mtimes (live newer → wins). On **Linux's coarse/fast filesystem they get the SAME mtimeMs → recency ties → `preferNewerSession` tie-break is `sessionPath.localeCompare`, and `"stale-session" > "live-session"` → the STALE (dead-pid) session wins.** Deterministically wrong on Linux.
- **The orphan-tmp cluster** (showStatus / mux-runner recovered-inactive-orphan-tmp / check-readiness dead-writer-tmp / verify-recapture orphan-tmp) is the SAME class one level down: `.tmp.<pid>`-vs-base snapshot promotion (`readRecoverableJsonObject` / `isStateSnapshotNewer`) decides by mtime, which ties on Linux → wrong snapshot chosen.

So the WHOLE Linux tail (clusters A + most of B/D) reduces to: **recency/promotion decisions rely on filesystem mtime ordering that is reliable on macOS (fine/slow writes) but TIES on Linux (coarse/fast writes), making the tie-breaks non-deterministic and sometimes wrong.** (The runGate ×3 fixture-command failures and the 5s timeouts may be separate — re-confirm via rcifb-debug.)

### Fix directions (careful, holistic — verify each via re-dispatching rcifb-debug.yml on Linux)
1. **`selectScannedSessionPath` should DEMOTE dead-pid active sessions** — an `active:true` session whose `pid` is a finite integer and `!isProcessAlive(pid)` must be treated as inactive (drop to `inactiveMatch` or skip), so a dead-pid stale never outranks a live (or no-pid) session regardless of mtime. This alone fixes the get-session case correctly on both platforms.
2. **Make recency tie-breaks deterministic-AND-correct, not mtime-fragile** — where the test intent is "the later-written/snapshot wins", don't lean on `mtimeMs` (sub-ms ties on Linux). Options: compare with a tie-break that reflects true recency (a monotonic write counter / `started_at` stamped on write), or in the affected tests stamp distinct `started_at`. Audit `isStateSnapshotNewer` / `.tmp` promotion for the same mtime-tie fragility.
3. Re-confirm runGate ×3 (real `npm/tsc` on fixture packages — `tsc` is at `/usr/local/bin/tsc` on the runner; check whether fixtures need deps installed) and the 5s-timeout tests (`test-runner-tier-discovery` asserts child output matches `/cancelled 1|tests 1/` — a Linux output-timing difference) separately.

### Status: ROOT-CAUSED, fix-ready, DEFERRED to a focused session
The diagnosis is complete and the `rcifb-debug.yml` workflow is the ready-made Linux verification loop. The fix is a careful systemic change across the session-ranking + tmp-promotion sites, verified per-change on Linux — a focused dev task, not babysitter tick-work. Babysitter has root-caused it to fix-ready precision and steps back (CI-green is hygiene, not a release gate). Remove `rcifb-debug.yml` once R-CIFB closes.

### Original (superseded) precise hand-off for a future fixer: get a Linux/node24 env (Docker `node:24` with working network, a Linux CI debug shell, or a Linux dev box), run each failing file individually (`EXTENSION_DIR=<repo> node --test tests/<f>.test.js`), read the real AssertionError expected-vs-actual, and fix the Linux-specific assumption (likely `os.tmpdir()`/`/tmp` realpath, pid-liveness, or fixture-command behavior). The failing set (from CI run 27595573592): get-session, services/convergence-gate-workspaces (runGate ×9), verify-recapture-fired (recovers-orphan-tmp), status (showStatus), check-update, check-readiness, install-agent-overlay, guard-logging, purge-update-cache, mux-runner (quality-gate-skip + orphan-tmp), FR-B10.

### Recommendation

The high-value structural work is done and shipped. The remaining ~25 is a fiddly, environment-specific, hygiene-only residual best tackled in a dedicated session with a Linux/node-24 repro env (or accepted as known CI-red since CI-green is not a release gate). Do not let it consume every babysitter tick — pivot to higher-value drain (verify-first-close stale P2 rows) and return to this methodically.

## Honest scope note

This is a MULTI-SESSION CI-environment-alignment effort, not a quick flake-serialize. CI has likely NEVER been green (all prior betas shipped on the LOCAL gate, which is authoritative; CI-green is hygiene, not a release gate). Drive it incrementally: EXTENSION_DIR fix (b052f49a) should collapse cause 1; then measure causes 2+3 and decide node-version alignment vs per-test fixes.

## Method

`gh workflow run stability-gate.yml -f run_count=N` runs `npm run test:fast` (full output, not the budget loop's swallowed output) and uploads per-run logs as `stability-gate-logs`. The CI runner reproduces the env-gap (no deployed extension, no `claude` CLI) that a dev machine masks — it is the authoritative oracle. Iterate: fix a bucket → re-run → read remaining failures → repeat until 0, then a clean 30-run validation.

## Acceptance criteria

- **AC-1 (enumerate):** Run `stability-gate.yml -f run_count=30` (CI-side, no local oversubscription), download the artifact logs, and produce the COMPLETE list of tests that fail in ≥1 of the 30 runs. This is the authoritative flaky set.
- **AC-2 (classify):** For each, classify per the `extension/CLAUDE.md` taxonomy — `subprocess-spawn-timing`, `load-dependent-timeout`, `subprocess-timeout-coupling`, etc.
- **AC-3 (fix per the documented precedents, NOT by loosening the gate):**
  - Subprocess hang-guards below the ≥30s floor (e.g. the 10s ready-deadline) → widen to ≥30s per AC-R-ITIH-4 (a hang-guard is not a perf-assertion).
  - Tests that flake ONLY under parallel load → promote `@tier:fast`→`@tier:integration` + add to `tests/integration/.serial-tests.json` (runs at `--test-concurrency=1`) per the R-TFP precedent, with a 1:1 reason in `.serial-tests.reasons.json` (one of the five sanctioned classes).
  - Do NOT change `--fail-budget` or `--test-concurrency=8` in `check-flake-budget` / `test:fast:budget` (fixing the tests, not weakening the guard — north-star W5b subtract-before-add).
- **AC-4 (validate):** Re-run `stability-gate.yml -f run_count=30` → 0 failures across all 30 runs. CI `test:fast:budget` goes green.
- **AC-5 (audit parity):** `audit-test-tiers.sh`, `audit-test-isolation.sh`, `audit-subprocess-heavy-tests.sh`, and `serial-tests-reasons-coverage.test.js` all stay green after the moves.

## Execution note (recursive-flake hazard)

A pickle WORKER's own lint gate runs `test:fast` — i.e. the very flaky tests being fixed — so a pipeline build risks the worker's gate flaking on the work-in-progress. **Prefer babysitter-direct execution** with `stability-gate.yml` (CI-side) as the validation loop, rather than a pickle pipeline.

## Validation

`gh workflow run stability-gate.yml -f run_count=30` is the operator runbook tool; it runs `npm run test:fast` (full output, not the budget loop's swallowed output) RUN_COUNT× and uploads per-run logs as the `stability-gate-logs` artifact.

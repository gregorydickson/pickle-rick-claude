---
title: "B-CIINT — integration-tier subprocess-e2e tests fail on the Linux CI runner (unmasked after fast:budget went green)"
priority: P3
finding: 119
status: open
schema_neutral: true
type: bug-bundle
source: B-CITAIL/R-CIFB chronic-CI-red effort (beta.12/beta.13); CI run 27692982494
---

# B-CIINT — integration-tier subprocess-e2e CI failures (focused CI-hardening)

## 0. TL;DR

The R-CIFB + B-CITAIL effort cleared the **fast-tier** chronic CI red (stability-gate
run_count=10 = SUCCESS, beta.13). Doing so **unmasked a deeper, pre-existing layer**: the CI gate
command is a `&&` chain — `… && npm run test:fast:budget && npm run test:integration && … test:expensive`.
For months `test:fast:budget` failed FIRST, so the chain short-circuited and **`test:integration` never
ran on CI**. Now that fast:budget is green, the chain reaches `test:integration` **for the first time**,
surfacing ~6 integration-tier subprocess-e2e tests that fail **only on the Linux CI runner** (all pass on
macOS dev + the local release gate).

**This is NOT a product bug and NOT a regression** — the failing tests are unrelated to the surgical
B-CITAIL test-fixes; they are newly *visible*, not newly *introduced* (proven: the beta.12-era CI run
27667001397 never reached the integration tier because fast:budget short-circuited it). The products
ship correctly on the local gate. Per the standing principle **CI-green is hygiene, NOT a release gate**,
this is a **focused CI-hardening session** item, not per-test babysitter whack-a-mole.

## 1. The unmasked failing set (CI run 27692982494, commit a5e4bfae, Linux/node24)

All PASS locally (macOS); all fail on the GitHub-Actions ubuntu runner:

| # | Test (integration tier) | CI symptom | Likely class |
|---|---|---|---|
| 1 | `mega bundle A-F smoke paths work together` | assertion failure (221ms) | heavy multi-phase mux-runner e2e |
| 2 | `pipeline state stays coherent across a three-iteration mux-runner fixture` | `expected exit 3 (iteration_cap_exhausted)` — got other | timing/behavioral: cap-exit not reached on the runner |
| 3 | `timeout-e2e: manager sleeps 95% of budget, writes artifact, iteration advances, no SIGTERM` | `artifact not written — subprocess exited 1 (signal:null) before completing` | fixture manager subprocess exits 1 on CI before writing |
| 4 | `per-iteration gate remediation recovers orphan tmp result before classifying success` | `Expected values to be strictly deep-equal` | gate-remediation e2e state mismatch on CI |
| 5 | `per-iteration gate remediation logs worker_backend_resolved with backend-resolution source semantics` | assertion failure | gate-remediation e2e |
| 6 | `FR-B10: fixture manager sleeps 95% of worker_timeout budget, writes artifact, no SIGTERM` (`timeout-happy-path.test.js`) | `artifact not written — subprocess exited 1 before completing` | same as #3 (moved to @tier:integration by B-CITAIL T6) |

**Multi-cause** (at least three): (a) **fixture subprocess exits 1 before writing its artifact** (#3, #6 — the manager/worker fixture spawns a child that doesn't complete on the CI runner; `exit:1, signal:null` = the child's own non-zero exit, NOT a SIGKILL); (b) **wrong/late exit code** (#2 — `iteration_cap_exhausted` exit 3 not reached, a timing/behavioral divergence); (c) **gate-remediation e2e state mismatch** (#4, #5). NOTE: #6 (FR-B10) was moved fast→integration by B-CITAIL T6; serializing it cleared the *fast* c=8 union but it still fails in integration on CI — proving its CI failure is **environmental, not concurrency** (a useful data point: these are NOT pure load flakes).

## 2. Diagnostic protocol (Linux is the oracle; products correct until proven otherwise)

The macOS dev box CANNOT reproduce these (they pass locally). Docker Hub pulls hang in the babysitter
env, so the **only Linux repro is a `workflow_dispatch` CI workflow** (the now-removed `rcifb-debug.yml`
pattern — re-add a scoped `b-ciint-debug.yml` that runs each failing integration file individually on the
ubuntu/node24 runner and prints the fixture subprocess's stdout/stderr + exit code).

1. **Prove the product correct first.** For each failing test, run the underlying fixture/subprocess
   directly on the Linux runner with full stdout/stderr capture (a direct `node …` repro, as B-CITAIL T4
   did for purge). Distinguish a REAL product bug (like the install.sh GNU-`stat -f` bug B-CITAIL found)
   from a TEST/CI-environment bug (the common case here). DO NOT "fix" correct product code to satisfy a
   CI-environment-flaky test.
2. **For "subprocess exited 1 before writing artifact"** (#3, #6): capture the fixture child's stderr on
   CI — it is exiting 1 for a reason (missing env/path/binary on the runner, or a timing assumption).
   Likely candidates: the fixture spawns `node`/`claude` and the child can't resolve something on CI, OR
   the CI runner is slow enough that a write/flush races the exit. Fix the fixture's robustness (deterministic
   barrier, not a stopwatch — R-TSPF), or the env it passes to the child (hermetic, as B-CITAIL T4 did for
   `runPurge`).
3. **For the exit-code / state-mismatch tests** (#2, #4, #5): determine whether the CI runner's timing/env
   makes the mux-runner reach a different terminal state, then make the assertion robust to the legitimate
   CI variance OR fix the fixture's determinism.

## 3. Acceptance criteria (machine-checkable)

- **AC-1** Each of the 6 tests above either passes on Linux CI (verified via the per-file CI diagnostic)
  OR is documented as a confirmed product-correct CI-environment skip with a precise precondition guard
  (e.g. `{ skip }` when a CI-only resource/timing constraint is unmet), mirroring B-CITAIL's deploy-smoke
  skip. NO assertion is loosened in a way that masks a real defect.
- **AC-2** Any REAL product bug found (cf. the install.sh stat bug) is fixed at the product, not the test.
- **AC-3** A clean full CI run (`ci.yml`) on `main` reaches and passes `test:integration` (then
  `test:expensive`) — the first end-to-end-green CI. CI-green is hygiene, so this AC is the close
  condition, not a release gate.
- **AC-4** No regression to the fast tier (stability-gate run_count=10 stays SUCCESS) and no weakening of
  `--fail-budget=2` / `--test-concurrency=8` (W5b: fix the tests/env, not the guard).
- **AC-5** If a Linux diagnostic workflow is re-added for this, remove it at close (as B-CITAIL did with
  `rcifb-debug.yml`).

## 4. Scope / non-goals

**In scope:** the ~6 integration-tier subprocess-e2e tests failing on the CI runner; any product bug they
surface. **Out of scope:** the fast tier (green); weakening flake-budget/concurrency; `test:expensive` tier
(may have its OWN further-unmasked layer once integration is green — file separately if so); GA promotion.

## 5. Simplification Review (subtract-before-add)

1. **Necessary?** Low-priority hygiene. CI-green is not a release gate; products ship on the local gate.
   Worth doing for a trustworthy CI signal, but NOT at the cost of per-test babysitter churn — hence a
   single focused session.
2. **Reuse not add?** Yes — reuse the B-CITAIL diagnostic pattern (gh-workflow per-file Linux repro +
   direct subprocess repro), the R-TSPF "deterministic barrier not a stopwatch" fix, the hermetic-env
   fixture pattern (B-CITAIL T4 `runPurge`), and the precondition-skip pattern (B-CITAIL deploy-smoke).
3. **Guards existing brittleness?** It SUBTRACTS — replaces CI-fragile stopwatch/env-leak assertions with
   deterministic ones; no new gate/flag.
4. **Subtract?** Net subtraction: remove any temporary diagnostic workflow at close; remove load-fragile
   timing assertions. No new persisted field/flag.

## 6. Notes

Standing context (memory `project_chronic_ci_red_is_cross_platform_gap`): the whole chronic-CI-red is a
macOS-dev-vs-Linux-CI class — BSD-vs-GNU tooling (`stat`/`tar` incl. AppleDouble `._*`), deployed-tree
assumptions, node:test/timing under load, node-version strictness — cleared layer by layer (fast tier done).
B-CIINT is the integration-tier layer, unmasked once the fast tier went green. The effort already surfaced
one REAL product bug (install.sh GNU-`stat -f` agent mis-migration) — so each B-CIINT test is worth a
genuine product-vs-test triage, not a blind skip.

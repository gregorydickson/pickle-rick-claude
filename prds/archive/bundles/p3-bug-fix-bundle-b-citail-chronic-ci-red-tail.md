---
title: "B-CITAIL — chronic CI-red tail: the residual Linux-only fast-tier test failures (R-CIFB residual-3, characterized)"
priority: P3
finding: 115-residual-3
status: open
schema_neutral: true
source: prds/archive/bundles/p2-bug-fix-bundle-r-cifb-linux-mtime-tie-session-discovery.md (residual-3) + rcifb-debug run 27669351733
---

# B-CITAIL — chronic CI-red tail (R-CIFB residual-3, fully characterized)

## 0. TL;DR

R-CIFB (beta.12) fixed the mtime-tie session-discovery flakes and was Linux-confirmed
(`rcifb-debug` run 27666957193 = success). But `stability-gate run_count=10` + CI stay RED on
`FAIL_BUDGET_EXCEEDED failures=3 budget=2` — the residual chronic tail. **CI-green is hygiene, NOT a
release gate** (every beta shipped on the LOCAL gate). This bundle clears the tail so CI/stability-gate
go green for the first time.

The c=8-flaky set was previously *unidentifiable* (the `check-flake-budget` tool reports only the
aggregate; local macOS c=8 is clean 6427/6430). A c=8 full-fast-tier diagnostic step added to
`rcifb-debug.yml` (run **27669351733**) surfaced the per-test names and exact assertions. **These pass on
macOS — Linux/node24 CI is the only repro; `rcifb-debug.yml` is the verification oracle (re-dispatch
after each fix, NOT local).**

## 1. The identified failing set + root cause (from run 27669351733)

| # | Test (file :: case) | Exact Linux assertion | Root-cause class | Fix |
|---|---|---|---|---|
| T1 | `tests/bin/test-runner-tier-discovery.test.js` :: `runner times out wedged child …` | expected `/cancelled 1\|tests 1/i`, actual `Interrupted while running:\n⚠ tests/hangs.test.js` | node24 test-runner output-format drift | broaden the regex to also accept `/Interrupted while running/i` (the node 24 wedged-child wording) |
| T2 | `tests/install-agent-overlay.test.js` :: `matching legacy canonical agent migrates to .pickle-managed` | expected `/migrated morty-implementer\.md/`, actual `legacy conflict …/morty-implementer.md -> …/.pickle-managed/morty-implementer.md` | test-vs-code wording drift (install.sh emits `legacy conflict X -> Y`, not `migrated X`) | reconcile the assertion to the actual install.sh wording (`legacy conflict … -> …/.pickle-managed/…`) — verify install.sh is the intended message first |
| T3 | `tests/mux-runner.test.js` :: `quality-gate skip: unified flag takes precedence over legacy flags` (+ `suppression flag disables legacy warning and event`) | `AssertionError: EXTENSION_DIR fallback: requested=/tmp/pickle-mux-runner-test-… fallback=/home/runner/.claude/pickle-rick reason=missing sentinel …/extension/bin/log-watcher.js` (expected true, actual false) | deployed-root assumption: the test's tmp `EXTENSION_DIR` lacks the sentinel `extension/bin/log-watcher.js`, so `getExtensionRoot()` falls back to the absent deployed root (passes on dev where `~/.claude/pickle-rick` exists, fails on CI) | the test must create the sentinel inside its tmp `EXTENSION_DIR` (or stop relying on the deployed-root fallback) — same class as the shipped `EXTENSION_DIR`/hermetic-env fixes. ALSO 8302ms slow at c=8 → consider serialization (see T6) |
| T4 | `tests/purge-update-cache.test.js` :: `removes update cache, updater tmp roots, and appends audit log` + `default runtime root matches the canonical extension root used by check-update.js` | runtime-root vs canonical extension root mismatch on CI | deployed-root/getDataRoot path assumption (same class as T3) | make the test set up / assert the runtime root hermetically (do not assume `~/.claude/pickle-rick`); mirror the EXTENSION_DIR-hermetic pattern |
| T5 | `tests/mux-runner-guard-logging.test.js` :: `false EPIC_COMPLETED triggers structural recovery …` | `Expected MANAGER_FALSE_EPIC_COMPLETED log line from recovery. Got: false` | behavioral — recovery log not emitted on Linux (likely the same EXTENSION_DIR fallback breaking the spawned manager, OR a timing race) | DIAGNOSE FIRST via rcifb-debug per-file; if it's the EXTENSION_DIR-sentinel cause (T3 class), the same fix clears it; else investigate the recovery log path |
| T6 | `tests/timeout-happy-path.test.js` :: `FR-B10: fixture manager sleeps 95% of worker_timeout …` | `Artifact not written — subprocess was killed before completing (exit:1, signal:null)` | timing/load — the fixture subprocess is starved/killed under c=8 before writing its artifact | serialize per R-TFP (`@tier:fast`→`@tier:integration` + `tests/integration/.serial-tests.json`); FR-B10 sleeps 95% of the worker-timeout budget so it is inherently load-fragile |

**Cross-cutting hypothesis:** T3/T4/T5 are very likely ONE root cause — the `EXTENSION_DIR`-sentinel
fallback. The `rcifb-debug.yml` job sets `EXTENSION_DIR=${{ github.workspace }}`, but these tests spawn
subprocesses with their OWN tmp `EXTENSION_DIR` that lacks the committed sentinel
`extension/bin/log-watcher.js`, so `getExtensionRoot()` rejects it and falls back to the CI-absent
deployed root. Fix the sentinel-setup once in a shared test helper and T3/T4/T5 may all clear. **Verify
this hypothesis FIRST** (cheapest highest-leverage fix).

## 2. Acceptance criteria (machine-checkable)

> ALL fixes keep the LOCAL gate green (the tests already pass on macOS) AND must be Linux-verified by
> re-dispatching `gh workflow run rcifb-debug.yml` and confirming the c=8 union shrinks to empty. The
> local gate is necessary-but-not-sufficient (these are Linux-only).

- **AC-1 (T1):** `test-runner-tier-discovery.test.js` accepts the node24 `Interrupted while running` wedged-child wording; local `node --test` green; absent from the rcifb-debug c=8 union.
- **AC-2 (T2):** `install-agent-overlay.test.js` assertion matches install.sh's actual agent-overlay message; local green; absent from the c=8 union. (Confirm the install.sh wording is intended — do not change install.sh output unless the wording is itself a bug.)
- **AC-3 (T3/T4/T5 shared):** a shared test helper creates the `extension/bin/log-watcher.js` sentinel (or equivalent) inside any tmp `EXTENSION_DIR` the test exports, so `getExtensionRoot()` honors it on CI; `mux-runner.test.js` quality-gate-skip ×2, `purge-update-cache.test.js` ×2, and `mux-runner-guard-logging.test.js` all pass on Linux (absent from the c=8 union). If T5 is NOT the sentinel cause, file it as a separate sub-finding with its real root cause.
- **AC-4 (T6):** `timeout-happy-path.test.js` FR-B10 promoted to `@tier:integration` + added to `tests/integration/.serial-tests.json` (+ `.serial-tests.reasons.json` class `load-dependent-timeout`) per R-TFP; absent from the c=8 union; `serial-tests-reasons-coverage.test.js` stays green.
- **AC-5 (closing gate):** a clean `gh workflow run stability-gate.yml -f run_count=10` (10/10) AND a clean CI run on main. THEN remove `.github/workflows/rcifb-debug.yml` (diagnostic-only, "remove once R-CIFB closed") + its c=8 diagnostic step. This closes R-CIFB #115 fully.

## 3. Scope / non-goals

**In scope:** the 6 tests above (T1–T6). **Out of scope:** weakening `--fail-budget=2` / `--test-concurrency=8` (W5b: fix the tests, not the guard — pinned by the flake-budget trap door); the R-CIFB mtime fix (shipped beta.12); any non-test source behavior change UNLESS a test reveals a real Linux bug (then file separately).

## 4. Verification protocol (Linux is the oracle)

After each AC: (1) local `node --test <file>` green; (2) `gh workflow run rcifb-debug.yml` → confirm the
test left the c=8 union; (3) at the end, `gh workflow run stability-gate.yml -f run_count=10` clean +
CI green → remove the diagnostic workflow. `rcifb-debug.yml` run **27669351733** is the baseline union.

## 5. Simplification Review (subtract-before-add)

1. **Necessary?** Yes — closes the chronic CI-red so the signal is trustworthy. Pure test-quality fixes; no new runtime code.
2. **Reuse not add?** Yes — reuse the existing `EXTENSION_DIR`-hermetic test pattern (already shipped for the R-CIFB structural fixes) for T3/T4/T5; reuse the R-TFP serialization pattern for T6; reuse `rcifb-debug.yml` as the verifier.
3. **Guards existing brittleness?** It SUBTRACTS brittleness — removes deployed-root assumptions from tests and the now-redundant `rcifb-debug.yml` at close.
4. **Subtract?** Net subtraction: delete `rcifb-debug.yml` + its c=8 step at AC-5; remove deployed-root coupling from 4 test files. No new flag/gate/field.

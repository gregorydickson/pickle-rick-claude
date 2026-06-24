---
title: P1 — B-RELEASE-DRIFT bundle: 12 test-failures block v1.80.2 release gate
status: Draft
filed: 2026-05-26
priority: P1
type: bug-bundle
finding_id: 79
---

# PRD — B-RELEASE-DRIFT bundle

**Trigger**: 2026-05-26 v1.80.2 release-gate attempt exposed 12 pre-existing test failures across 5 root-cause classes. The release was blocked per `CLAUDE.md`'s "Test failures block release, no exceptions" gate; version bump (`47881dbc`) was reverted (`02495054`); deployed binary stays v1.80.1 until this bundle ships.

**Test gate baseline** (after the 6 R-POD test-drift fixes already shipped in `a16619c2`): `npm run test:fast` → 5266/5278 pass, **12 fail**, 622s.

## Acceptance Criteria

- **AC-BRD-00**: `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive` exits 0 — full release gate green from a clean clone.
- **AC-BRD-CLOSER**: version bump `1.80.1 → 1.80.2`, `bash install.sh` deploy parity check passes, `gh release create v1.80.2` succeeds.

---

## Class (a) — R-SMTEST spawn-morty fast-fail wedge (5 tickets)

**Symptom**: 5 spawn-morty tests hit the 45 000 ms test-runner timeout with `result.status === null` (SIGTERM kill) instead of exiting cleanly. Affects every test that validates spawn-morty CLI argument behavior in a context where the claude binary is absent (or even where it's present — see repro).

**Failing tests**:
- `spawn-morty: --output-format as last arg (no value) defaults to text`
- `spawn-morty: --review flag accepted without validation error`
- `spawn-morty: --ticket-file with value starting with -- does not crash`
- `spawn-morty: --timeout with custom value is accepted (no validation error)`
- `spawn-morty: valid args but no claude binary → exit 1 (spawn failure, not validation)`

**Reproducer** (verified 2026-05-26):
```bash
cd extension
node bin/spawn-morty.js --ticket-id X --ticket-path /tmp --timeout 5 'msg'
# Wedges silently — no stdout, no stderr — until killed.
```

Reproducer **does not require PATH=/nonexistent**: the wedge occurs even with full PATH and a working claude binary available. This rules out "ENOENT swallowed" as root cause — spawn-morty is hanging upstream of the claude binary spawn site.

**Hypotheses** (ranked by prior likelihood):
- H-1: file-lock acquisition (`withRetryLock` in `src/services/pickle-utils.ts`) on a path under `/tmp` that has no existing session structure — lock retry loop never times out under bad-input conditions.
- H-2: StateManager.read on `--ticket-path /tmp` runs recovery (orphan tmp scan, schema migration) against the macOS temp root and walks the entire tree.
- H-3: backend resolution via `resolveBackendFromStateFile(--ticket-path)` reads a state.json that doesn't exist; the absent-state fallback path may spin.
- H-4: codex tool-call observation stream (`observeCodexToolCallStream`) opens before backend is known and blocks on stdin EOF.

**Tickets**:
- **R-SMTEST-1** — diagnose the wedge: instrument spawn-morty entry with breadcrumb stderr lines; identify the exact synchronous call that hangs. Output: bug commit + 1-line trap door for the wedge site.
- **R-SMTEST-2** — fix root cause: convert the offending synchronous wait into a bounded operation (finite timeout or input-validation early-exit). If lock retry: pass `--bounded` flag. If recovery scan: skip when `--ticket-path` outside `getDataRoot()`. Acceptance: reproducer above exits non-zero within 1 s.
- **R-SMTEST-3** — restore all 5 failing tests to green: re-verify each assertion holds; update test docstrings to cite the now-stable fail-fast path.
- **R-SMTEST-4** — trap-door entry at `extension/src/bin/spawn-morty.ts (R-SMTEST early-exit invariant)` documenting the fail-fast contract + ENFORCE pointing at `extension/tests/spawn-morty.test.js`.
- **R-SMTEST-5** — regression test: spawn-morty with `--ticket-path` set to a non-existent or non-session directory MUST exit within 5 s with a non-zero exit code and emit `spawn_morty_invalid_ticket_path` activity event (forward-create the event in `VALID_ACTIVITY_EVENTS`).

---

## Class (b) — R-MUXQG quality-gate skip warn-once test pollution (2 tickets)

**Symptom**: 2 mux-runner tests that exercise the `skip_readiness_reason → skip_quality_gates_reason` legacy-flag deprecation warning fail because the once-per-process flag (`mux-runner.ts:2710` `DEPRECATION:` log line) is silenced by a sibling test that ran first in the same `node --test` process.

**Failing tests**:
- `mux-runner quality-gate skip: legacy fallback warns once per process and emits per access` (1.89s)
- `mux-runner quality-gate skip: skip_readiness_reason does NOT bypass ticket_audit_gate (R-WSRC-4 fix)` (1.92s)

**Hypotheses**:
- H-1: module-level boolean (`_deprecationWarned = false`) in `resolveQualityGateSkipReason` persists across tests because mux-runner.js is imported once per process.
- H-2: the order of test execution under `--test-concurrency=8` is non-deterministic, so the first test to hit the deprecation path sets the flag for all peers.

**Tickets**:
- **R-MUXQG-1** — expose a test-only `_resetQualityGateSkipDeprecation()` from `mux-runner.ts`; call it in the two failing tests' `beforeEach`. Acceptance: both tests pass in any order.
- **R-MUXQG-2** — trap-door pin at the deprecation flag site documenting the test-reset contract.

---

## Class (c) — R-MUXAUDIT ticket-audit-halt slow + assertion drift (2 tickets)

**Symptom**: 2 ticket-audit halt tests are both slow (60s, 150s) and asserting incorrect text/state.

**Failing tests**:
- `mux-runner ticket-audit halt error names state.flags.skip_ticket_audit_reason` (60s)
- `mux-runner.audit-bundle-halt: halts before manager spawn on defective tickets` (150s)

**Hypotheses**:
- H-1: error message text was updated to cite `skip_quality_gates_reason` (the unified flag) instead of `skip_ticket_audit_reason` (the legacy per-callsite name) when R-QGSK-3 landed — but the tests still match the legacy text.
- H-2: 150s test duration suggests it's spawning real subprocesses without a finite timeout — needs an enforced spawn cap.

**Tickets**:
- **R-MUXAUDIT-1** — update assertion text in both tests to accept either the legacy or unified flag name (regex match); add a timeout to the longer test's child-process spawn so 150s → ≤30s.

---

## Class (d) — R-EMWMOCK ensureMonitorWindow injected-spawn capture drift (2 tickets)

**Symptom**: 2 ensureMonitorWindow tests that inject a spawn-capture mock fail at the assertion stage (5ms, 4ms — fast failure, real expectation drift).

**Failing tests**:
- `ensureMonitorWindow: existing monitor respawns dead monitor and watcher panes with injected spawn capture`
- `ensureMonitorWindow: stale EXTENSION_DIR falls back before watcher pane respawn`

**Hypotheses**:
- H-1: R-MMRT-1/R-MMRT-2 added `validateSessionDirOrSkip` before any tmux spawn; tests' mock now sees fewer spawn calls than expected because the validation short-circuits.

**Tickets**:
- **R-EMWMOCK-1** — update each test's mock-spawn expectation to account for the validateSessionDirOrSkip pre-check; assert one `monitor_respawn_session_dir_invalid` event per invalid call instead of N spawn calls.

---

## Class (e) — R-RSFISO resolveStateFile test-isolation (1 ticket)

**Symptom**: `resolveStateFile: mapped pid=null orphan with dead mapped PID falls back to the live active state for the cwd` passes when run alone (`node --test tests/resolve-state.test.js`) but fails when run as part of the full suite (`npm run test:fast`).

**Hypotheses**:
- H-1: a sibling test writes `process.env.PICKLE_STATE_FILE` and doesn't clean up; the failing test's `delete process.env.PICKLE_STATE_FILE` happens before the read but a stale value contaminates a cached module-level variable.
- H-2: `current_sessions.json` cache in some shared singleton persists across tests.

**Tickets**:
- **R-RSFISO-1** — bisect the failing test against the full suite to identify the polluting predecessor; add proper teardown in that test OR restructure the affected resolver to not cache cross-test state.

---

## Total: 12 tickets

| Class | Tickets | Severity |
|---|---|---|
| (a) R-SMTEST | 5 | High — gates every release |
| (b) R-MUXQG | 2 | Medium |
| (c) R-MUXAUDIT | 2 | Medium |
| (d) R-EMWMOCK | 2 | Medium |
| (e) R-RSFISO | 1 | Low — isolation only |

Class (a) is the load-bearing one — the 4 other classes are smaller and might collapse into single tickets once (a) is fixed. Dispatch order: (a) → (b) → (c) → (d) → (e) → close.

## Closer

`R-RELEASE-DRIFT-CLOSER` — final release gate, version bump 1.80.1 → 1.80.2, install.sh deploy, `gh release create v1.80.2`. Closes finding #79.

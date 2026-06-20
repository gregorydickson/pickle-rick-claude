---
title: Anatomy-park gate-baseline missing after commit (100% failure at iter 2)
status: Partially Shipped
date: 2026-05-01
priority: P1
shipped: stale-refresh class closed; fresh-init class re-opened as MASTER_PLAN Open Finding #7 PARTIAL
backend: codex-required
---

# PRD — Anatomy-park gate-baseline missing-after-commit (100% failure at iter 2)

Anatomy-park (microverse-runner) phase 3/4 of `/pickle-pipeline` exits with code 1 at iter 2, every time. Two consecutive runs (`21605b33`, `c9595747`) failed identically within ~9 minutes of each other. Pickle and citadel exited clean in both runs, so the bug is exclusively in the per-iteration-gate baseline lifecycle. Until shipped, the pipeline cannot complete through anatomy-park, and szechuan-sauce phase 4/4 never gets a chance to run.

## Symptoms

```
[T+0:00] microverse-runner started
[T+0:00] Starting gap analysis phase
[T+8:00] Baseline measurement skipped — metric type 'none' has no measurement branch
[T+8:00] Gap analysis complete — transitioning to iterating
[T+8:00] [anatomy-park] initialized per-iteration gate baseline (captured 0 pre-existing failure(s))
[T+8:00] --- Iteration 2 ---
[T+15:00] Iteration 2 — worker convergence: not yet
[T+15:00] [anatomy-park] per-iteration gate baseline missing after commit — falling back to strict mode for this iteration
[T+15:01] Phase anatomy-park exited with code 1
```

The "initialized per-iteration gate baseline" log line claims a baseline was captured. Yet 7 minutes later the runner can't find it, falls into "strict mode," and the phase exits 1 within ~1 second of that warning.

## Reproducer

100% reproducible on `main`:

```bash
/pickle-pipeline prds/<any-prd-with-multiple-tickets>.md --backend codex
```

Wait ~50-90 minutes for pickle + citadel to clear; anatomy-park will fail at iter 2.

Empirical evidence collected:

| Session | Pickle | Citadel | Anatomy-park | Reason |
|---|---|---|---|---|
| `2026-05-01-21605b33` | ✓ (3 iter, 41m) | ✓ (1 finding) | ✗ exit 1 at 18:17:58 | strict-mode fallback |
| `2026-05-01-c9595747` | ✓ (3 iter, 41m) | ✓ (1 finding) | ✗ exit 1 at 19:22:07 | strict-mode fallback |

## Forensics

**Disk evidence**: neither failed session has a `gate/` directory:

```
$ ls /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-01-c9595747/gate/
ls: ... gate/: No such file or directory

$ ls /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-01-21605b33/gate/
ls: ... gate/: No such file or directory
```

**Activity log evidence**: `state.json:activity[]` contains exactly one entry, `phase_personas_disabled_seen`. None of the gate-emit events ever land:
- `gate_lock_acquired` — missing
- `gate_baseline_captured` — missing
- `gate_run_complete` — missing
- `gate_skipped` — missing
- `iteration_left_regression` — missing

**Source map**:
- `extension/src/bin/microverse-runner.ts:368` — `const baselinePath = path.join(sessionDir, 'gate', 'baseline.json');`
- `extension/src/bin/microverse-runner.ts:393-406` — calls `runGateFn({ mode: 'baseline', scope: 'full', baselinePath, ... })`, then unconditionally logs `"initialized per-iteration gate baseline (captured N pre-existing failure(s))"`. The log message uses `result.total_raw_failure_count` regardless of whether a baseline file was actually written.
- `extension/src/services/convergence-gate.ts:738-762` — the `!baselineExists` branch is supposed to `mkdir(gate, recursive:true)` then `writeStateFile(baselinePath, baseline)` then `emit('gate_baseline_captured', ...)`.

**Inconsistency**: log says "captured 0 pre-existing failure(s)" → `runGate` returned successfully → branch 740-762 should have run → `gate/baseline.json` should exist on disk → `gate_baseline_captured` should be in state.activity. None of these are true.

## Root Cause Analysis

Three viable hypotheses, scope T0 verifies which:

### H1 — `runGate` returns success without writing the file

The `!baselineExists` branch at convergence-gate.ts:738-762 contains an unconditional `writeStateFile`. But the file isn't on disk and `gate_baseline_captured` isn't in activity. Either:
- A code path returns a stub success result without entering the `withLock(...)` block (inspect lines 730-735, the lock-acquisition wrapper).
- The mkdir or writeStateFile silently throws and gets swallowed by the surrounding `try/catch` at line 775-790, returning a `red` result that the caller misinterprets as success.
- The microverse-runner caller bypasses the actual runGate return value (uses just `total_raw_failure_count`) and never inspects whether the write happened.

### H2 — Baseline written, then deleted between iter 1 and iter 2

Possible if some intermediate code does `git clean -fd` against the session dir, or if `assertBaselineFresh` triggers `fs.rmSync(baselinePath, { force: true })` (line 386) without re-capturing. The "[anatomy-park] refreshing per-iteration gate baseline" log line that would accompany this code path is **not present** in either failed session log, so this hypothesis is currently unsupported by evidence — but the cleanup path needs verification.

### H3 — `emit()` writes to a different sink than `state.activity[]`

Worker session logs reference `gate_baseline_captured` as an enum value but the parent state.json activity stream has none of these events. If `emit()` writes to a worker-only or microverse-only stream rather than `state.activity[]`, the file-on-disk question is the only signal, and the log line is therefore the only evidence — and it's lying.

**Most likely**: H1 (runGate returns success without writing). The mkdir + writeStateFile are inside `withLock(...)` and a swallowed lock-error or filesystem-error in either of those calls would let the outer `try` catch return the `red` lockTimeoutResult while the **outer** caller `runGateFn(...)` only checks `total_raw_failure_count` for its log message. T0 verifies by adding pre/post-write disk-verification + emit a `gate_baseline_write_failed` event when the file is missing post-call.

## Functional Requirements

- **FR-1** — `runGate({mode: 'baseline'})` MUST verify the baseline file exists on disk after the lock-protected write. On post-write `fs.existsSync(baselinePath) === false`, throw a `BaselineWriteFailedError` rather than returning a success result.
- **FR-2** — `microverse-runner.initializePerIterationGate()` MUST verify `fs.existsSync(baselinePath)` after the `runGateFn` call returns. If missing, log an actionable error AND emit `gate_baseline_init_failed` activity event AND throw — do not log "initialized per-iteration gate baseline" if the file isn't there.
- **FR-3** — Strict-mode fallback at `microverse-runner.ts:284` MUST attempt baseline recapture from the current pre-iteration tree before exiting with regressions. Today it just logs a warning and runs the gate in strict mode, which fails immediately on the first new failure (because strict mode has no baseline to subtract against). Recapture-then-retry is bounded to one retry per iteration.
- **FR-4** — When recapture fails OR strict-mode evaluation fails, the runner emits a clear forensic activity event (`baseline_recapture_failed` or `strict_mode_red`) and continues to next iteration rather than exiting code 1. The pipeline-runner only fails the phase when the stall-limit (default 3) is reached, not on a single iteration's gate red.
- **FR-5** — Add `gate_*` activity events to `VALID_ACTIVITY_EVENTS` if they aren't there already. Audit the `emit()` call sites in `convergence-gate.ts` to confirm they route through `logActivity` (state.activity append) and not a parallel sink.

## Non-Functional Requirements

- **NFR-1** — Backward-compatible: existing 3464-test suite must remain green.
- **NFR-2** — No performance regression: baseline capture already takes ~8 minutes for the gap-analysis phase; the post-write verification adds one `fs.existsSync` call.
- **NFR-3** — Reproducer test runs in CI: `tests/integration/anatomy-park-gate-baseline-recovery.test.js` exercises the full failure mode end-to-end against a fixture session.

## Acceptance Criteria

| ID | Phase | Check |
|---|---|---|
| **AC-GBM-A1** | per-phase | Calling `runGate({mode:'baseline', baselinePath})` against an empty session dir results in `gate/baseline.json` existing on disk OR throwing `BaselineWriteFailedError`. Test: `tests/services/convergence-gate-baseline-write-verify.test.js` (NEW). |
| **AC-GBM-A2** | per-phase | `runGate` lock-error / filesystem-error in the `!baselineExists` branch propagates as a thrown error, not a silent `red` result. Test added to existing `tests/services/convergence-gate-baseline.test.js`. |
| **AC-GBM-B1** | per-phase | `microverse-runner.initializePerIterationGate` verifies `fs.existsSync(baselinePath)` post-call; logs an error and throws when missing. The success log message ("initialized per-iteration gate baseline") fires ONLY when the file is actually on disk. Test: `tests/microverse-runner-baseline-init.test.js` (NEW). |
| **AC-GBM-B2** | per-phase | When baseline is missing at iter N (N>1), the runner attempts ONE recapture from the pre-iteration tree before falling to strict mode. If recapture succeeds, gate runs in baseline mode. Test added to existing `tests/integration/anatomy-park-baseline-gate.test.js`. |
| **AC-GBM-C1** | per-phase | Phase exits with code 1 ONLY when stall-limit (default 3) is hit. A single iteration's strict-mode-red does not fail the phase. Test: `tests/integration/anatomy-park-stall-limit.test.js` (NEW). |
| **AC-GBM-D1** | bundle-end | Live re-run of `/pickle-pipeline` on the same PRD as `c9595747` reaches Phase 4/4 szechuan-sauce (anatomy-park converges or hits stall-limit cleanly with explicit forensic events). Manual verification + activity-event audit. |
| **AC-GBM-D2** | post-refinement | New trap-door INVARIANT in `extension/CLAUDE.md`: "`runGate({mode:'baseline'})` post-write disk verification is mandatory in `convergence-gate.ts`; no success result without `fs.existsSync(baselinePath)`". PATTERN_SHAPE for ESLint or grep enforcement. Test: existing `tests/test-registration-hygiene.test.js`. |
| **AC-GBM-E1** | per-phase | `gate_baseline_captured`, `gate_baseline_init_failed`, `baseline_recapture_failed`, `strict_mode_red` are all in `VALID_ACTIVITY_EVENTS` and route through `logActivity`. Test: `tests/types-gate-events.test.js`. |

## Tasks (atomic, execution order)

| Order | ID | Title | Estimated LOC |
|---|---|---|---|
| 10 | **GBM-T0** | Diagnostic: instrument convergence-gate.ts with pre/post-write disk-verify; reproduce + capture exact failure mode (H1/H2/H3). Output: 1-page RCA report at `${SESSION_ROOT}/gate-baseline-rca.md`. | ~30 |
| 20 | **GBM-T1** | `convergence-gate.ts:738-762`: post-write disk verification + `BaselineWriteFailedError`. AC-GBM-A1, A2. | ~50 |
| 30 | **GBM-T2** | `microverse-runner.ts:initializePerIterationGate`: post-call disk verification; gate the success log message; throw on miss. AC-GBM-B1. | ~40 |
| 40 | **GBM-T3** | `microverse-runner.ts:runChangedPerIterationGate`: pre-strict-mode recapture attempt (one retry per iteration). AC-GBM-B2. | ~70 |
| 50 | **GBM-T4** | `microverse-runner.ts`: strict-mode-red emits `strict_mode_red` activity event and continues iterating; only stall-limit triggers phase exit 1. AC-GBM-C1. | ~50 |
| 60 | **GBM-T5** | Activity-event audit: ensure all `emit()` sites in convergence-gate.ts route through logActivity; add missing events to `VALID_ACTIVITY_EVENTS`. AC-GBM-E1. | ~40 |
| 70 | **GBM-T6** | Integration test: `tests/integration/anatomy-park-gate-baseline-recovery.test.js`. AC-GBM-D1. | ~120 |
| 80 | **GBM-T7** | Trap-door catalog update: 1 new INVARIANT for runGate post-write verification + 1 for microverse-runner baseline-init log gating. AC-GBM-D2. | ~20 |
| 90 | **GBM-T8** | Closer: bump version to v1.66.0 (or v1.67.0 if pipeline-state-desync ships v1.66.0 first); run full release gate. | ~5 |

**Total**: ~425 LOC. 9 atomic tickets including diagnostic + closer.

## Out of Scope

- Refactoring the gate/baseline.json schema (`schema_version: 1` stays).
- Cross-session baseline reuse (`baselineMaxAgeIterations` / `baselineMaxAgeSeconds` already handle this).
- Worker-managed convergence signals (separate INVARIANT).

## Implementation Guidance

- GBM-T0 is **mandatory before T1**. The current evidence is consistent with H1, but H2 and H3 are still live. Don't fix the wrong thing.
- For T1, use `await fs.promises.access(opts.baselinePath!)` not `fs.existsSync` (consistent with the existing line 738 pattern).
- For T3, the recapture path is essentially a fresh call to `runGate({mode:'baseline', scope:'full', baselinePath})`. Don't duplicate logic — extract a `recaptureBaseline()` helper that both `initializePerIterationGate` and `runChangedPerIterationGate` use.
- For T4, the stall-limit logic already exists in `microverse-runner.ts:handleWorkerManagedIteration` (`stall_counts[subsystem] >= stall_limit`). Wire strict-mode-red into that counter.
- The new trap-door INVARIANTs in T7 should match the existing voice and PATTERN_SHAPE format.

## Risks

| ID | Risk | Mitigation |
|---|---|---|
| R1 | Recapture-then-retry doubles baseline-capture wall time per iter (+8m) | Cap recapture to 1 attempt per iteration; emit warning if recapture exceeds 60s |
| R2 | Hiding gate failures behind stall-limit could mask real toolchain regressions | The stall-limit is already 3; `iteration_regressions` counter is separate and persistent; review of `microverse-final-report.md` flags any iteration with regressions |
| R3 | Post-write verification adds ~5ms per gate run | Negligible; gate already takes ~8 minutes |
| R4 | RCA may surface a fourth root cause class (not H1/H2/H3) | T0 is bounded — if RCA report concludes "none of H1/H2/H3," scope this PRD up before T1 |
| R5 | gate_lock_acquired emits to a non-state.activity sink (H3) and the bug is lying about a bigger surface than just baseline writes | Audit ALL emit() sites in convergence-gate.ts in T5; routing-fix may be needed for several events |

## Reproducer artifact

`gate/` directory missing; `state.json:activity[]` length=1 (only `phase_personas_disabled_seen`); microverse-runner.log final 2 lines:

```
[<T>] Iteration 2 — worker convergence: not yet
[<T>] [anatomy-park] per-iteration gate baseline missing after commit — falling back to strict mode for this iteration
```

Followed within ~1 second by `pipeline-runner.log:Phase anatomy-park exited with code 1`.

## Operator workaround (until shipped)

Until the fix lands, anatomy-park phase WILL fail at iter 2. Three workarounds:

1. **Skip anatomy-park**: append `--skip-anatomy` to `/pickle-pipeline` invocation. Loses the deep-review phase but completes pickle + citadel + szechuan-sauce.
2. **Manual baseline pre-create**: before launching the pipeline, `mkdir -p ${SESSION_ROOT}/gate && echo '{}' > ${SESSION_ROOT}/gate/baseline.json`. Won't work because the gate logic expects a valid `GateBaselineFile` schema, but does suppress the strict-mode fallback long enough to investigate.
3. **Run anatomy-park standalone** after the pipeline completes the other phases: `/anatomy-park <PRD>` invokes microverse-runner directly with a fresh session.

— Pickle Rick out. *belch*
